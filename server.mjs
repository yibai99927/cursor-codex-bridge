#!/usr/bin/env node
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { join } from "node:path";
import {
  BRIDGE_DIR,
  agentBin,
  agentVersion,
  allowedRoots,
  assertWorkspace,
  commanderLockEnabled,
  countRunning,
  createCursorChat,
  ensureDir,
  execAgent,
  homeDir,
  isPidAlive,
  killPid,
  listRunIds,
  maxRunning,
  newId,
  publicRun,
  readMeta,
  refreshRun,
  rememberRun,
  requireSession,
  runDir,
  waitMaxSeconds,
  writeMeta,
} from "./lib.mjs";

const TOOLS = [
  {
    name: "spawn_cursor",
    description:
      "异步派一个独立的 Cursor 子 agent。同时在跑的数量受 CURSOR_WORKER_MAX_RUNNING 限制（默认 4）。create-chat 失败则拒绝开工。长任务用 wait_cursor（上限见 CURSOR_WORKER_WAIT_MAX，默认 300 秒，且须小于 MCP tool_timeout_sec）。",
    inputSchema: {
      type: "object",
      properties: {
        prompt: {
          type: "string",
          description:
            "给 Cursor 的完整任务说明。必须自包含：目标、文件范围、验收标准、禁止事项。",
        },
        workspace: {
          type: "string",
          description: "仓库绝对路径。",
        },
        task_name: {
          type: "string",
          description: "可选短名，便于 list/status 并列区分多个并行任务。",
        },
        mode: {
          type: "string",
          enum: ["agent", "ask", "plan"],
          description: "默认 agent（可改文件）。ask/plan 只读。",
        },
        model: {
          type: "string",
          description: "可选。Cursor 模型 id，例如 composer-2.5。",
        },
        sandbox: {
          type: "string",
          enum: ["enabled", "disabled"],
          description: "可选。默认不显式指定。",
        },
        approve_mcps: {
          type: "boolean",
          description: "是否自动批准 Cursor 侧 MCP。默认 false。",
        },
        worktree: {
          type: "boolean",
          description:
            "在独立 git worktree 里执行，避免并行工人抢同一工作区。默认 false。",
        },
        worktree_name: {
          type: "string",
          description: "可选 worktree 名。worktree=true 且未命名时由 CLI 生成。",
        },
      },
      required: ["prompt", "workspace"],
    },
  },
  {
    name: "followup_cursor",
    description:
      "在已有 Cursor 会话上追加一轮任务（续跑）。传入 run_id 或 session_id。上一轮必须已结束，否则先 wait 或 cancel。",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "这一轮的补充任务。" },
        run_id: { type: "string", description: "上一轮的 run_id，用来继承 session。" },
        session_id: { type: "string", description: "直接指定 Cursor session_id。" },
        workspace: {
          type: "string",
          description: "可选。默认沿用上一轮 workspace。",
        },
        mode: {
          type: "string",
          enum: ["agent", "ask", "plan"],
          description: "可选。默认沿用上一轮。",
        },
        model: { type: "string" },
        task_name: {
          type: "string",
          description: "可选。这一轮的短名，默认沿用上一轮。",
        },
      },
      required: ["prompt"],
    },
  },
  {
    name: "get_cursor_status",
    description: "查看某个 run 的当前状态和简要进度。廉价，可反复调用。",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "string" } },
      required: ["run_id"],
    },
  },
  {
    name: "wait_cursor",
    description:
      "等待一个 run 结束，或直到 max_seconds。适合短任务一次等完；长任务请用较小 max_seconds 后根据 status 再等。",
    inputSchema: {
      type: "object",
      properties: {
        run_id: { type: "string" },
        max_seconds: {
          type: "number",
          description: "最多等待秒数。默认 45，上限为 CURSOR_WORKER_WAIT_MAX（默认 300）。MCP tool_timeout_sec 必须更大。",
        },
      },
      required: ["run_id"],
    },
  },
  {
    name: "get_cursor_result",
    description: "读取终态结果。若仍在 running，返回当前进度而不是假装完成。",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "string" } },
      required: ["run_id"],
    },
  },
  {
    name: "cancel_cursor",
    description: "终止仍在运行的 Cursor 任务。",
    inputSchema: {
      type: "object",
      properties: { run_id: { type: "string" } },
      required: ["run_id"],
    },
  },
  {
    name: "list_cursor_runs",
    description: "并列列出最近的 Cursor 任务（含 task_name、session_id、status），用于同时盯多个并行 run。",
    inputSchema: {
      type: "object",
      properties: {
        limit: { type: "number", description: "默认 10。" },
      },
    },
  },
  {
    name: "cursor_bridge_health",
    description: "检查 Cursor CLI 是否已登录、二进制是否可用。派活前可先调用。",
    inputSchema: { type: "object", properties: {} },
  },
];

function ok(data) {
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
  };
}

function fail(message) {
  return {
    content: [{ type: "text", text: JSON.stringify({ error: message }, null, 2) }],
    isError: true,
  };
}

let sessionChains = new Map();

function enqueueSession(sessionId, fn) {
  const key = sessionId || "*";
  const prev = sessionChains.get(key) || Promise.resolve();
  const next = prev.then(fn, fn);
  sessionChains.set(
    key,
    next.then(
      () => {},
      () => {}
    )
  );
  return next;
}

function startJob(runId) {
  const child = spawn(process.execPath, [join(BRIDGE_DIR, "run-job.mjs"), runId], {
    detached: true,
    stdio: "ignore",
    env: process.env,
    windowsHide: true,
  });
  child.unref();
  return child.pid;
}

function sessionHasActiveRun(sessionId) {
  if (!sessionId) return null;
  for (const id of listRunIds()) {
    const meta = readMeta(id);
    if (!meta || meta.session_id !== sessionId) continue;
    const { meta: fresh } = refreshRun(id);
    if (fresh.status === "running" || fresh.status === "starting") return fresh.run_id;
  }
  return null;
}

function launchRun({
  prompt,
  workspace,
  model,
  sandbox,
  approve_mcps,
  sessionId,
  taskName,
  mode,
  worktree,
  worktreeName,
  sessionCanary,
}) {
  const abs = assertWorkspace(workspace);
  if (!existsSync(agentBin())) {
    throw new Error(`找不到 Cursor CLI: ${agentBin()}`);
  }
  const reuseSession = Boolean(sessionId);
  if (!reuseSession) {
    const running = countRunning();
    const cap = maxRunning();
    if (running >= cap) {
      throw new Error(
        `已有 ${running} 个 Cursor 工人在跑，上限 ${cap}（CURSOR_WORKER_MAX_RUNNING）。先 wait_cursor / cancel_cursor，或提高上限。`
      );
    }
  }
  const chatId = reuseSession ? sessionId : createCursorChat();
  if (!reuseSession && requireSession() && !chatId) {
    throw new Error(
      "create-chat 失败，拒绝无 session 开工（CURSOR_WORKER_REQUIRE_SESSION=1）。续跑将无法保证。"
    );
  }
  if (reuseSession) {
    const busy = sessionHasActiveRun(chatId);
    if (busy) {
      throw new Error(
        `同一 session 仍有未完成任务 ${busy}，followup 需串行：先 wait_cursor 或 cancel_cursor`
      );
    }
  }

  const runId = newId("run");
  const canary = reuseSession ? null : `c-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const version = agentVersion();
  let finalPrompt = prompt;
  if (canary) {
    finalPrompt = `${prompt}\n\n[cursor-bridge-canary:${canary}] 这是本会话校验码，禁止写入仓库任何文件。`;
  } else if (reuseSession && sessionCanary) {
    finalPrompt = `${prompt}\n\n[cursor-bridge-canary:${sessionCanary}] 续跑校验码应与首轮相同。若你不记得，停止改文件并说明会话可能已丢失。`;
  }
  ensureDir(runDir(runId));
  const meta = {
    run_id: runId,
    task_name: taskName || null,
    session_id: chatId,
    status: "starting",
    workspace: abs,
    prompt: finalPrompt,
    mode: mode === "ask" || mode === "plan" ? mode : null,
    model: model || null,
    sandbox: sandbox || null,
    approve_mcps: Boolean(approve_mcps),
    worktree: Boolean(worktree),
    worktree_name: worktreeName || null,
    canary: canary || sessionCanary || null,
    agent_version: version,
    started_at: new Date().toISOString(),
    pid: null,
    job_pid: null,
    summary: "",
    progress: "",
  };
  writeMeta(runId, meta);
  rememberRun(runId);
  const jobPid = startJob(runId);
  meta.job_pid = jobPid;
  meta.status = "running";
  writeMeta(runId, meta);
  return publicRun(meta);
}

async function sleep(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitRun(runId, maxSeconds) {
  const cap = Math.min(
    Math.max(Number(maxSeconds) || 45, 1),
    waitMaxSeconds()
  );
  const deadline = Date.now() + cap * 1000;
  let latest = refreshRun(runId);
  while (Date.now() < deadline) {
    if (latest.meta.status !== "running" && latest.meta.status !== "starting") {
      return publicRun(latest.meta);
    }
    await sleep(1500);
    latest = refreshRun(runId);
  }
  return {
    ...publicRun(latest.meta),
    timed_out: true,
    hint: "仍在运行。请再调用 wait_cursor 或 get_cursor_status。",
  };
}

function cancelRun(runId) {
  const { meta } = refreshRun(runId);
  if (meta.status !== "running" && meta.status !== "starting") {
    return publicRun(meta);
  }
  for (const pid of [meta.pid, meta.job_pid]) {
    if (isPidAlive(pid)) killPid(pid);
  }
  meta.status = "cancelled";
  meta.ended_at = new Date().toISOString();
  writeMeta(runId, meta);
  return publicRun(meta);
}

async function dispatch(name, args) {
  switch (name) {
    case "cursor_bridge_health": {
      let status = "";
      try {
        status = execAgent(["status"], { timeout: 20_000 }).trim();
      } catch (error) {
        return fail(`agent status 失败: ${error.message}`);
      }
      return ok({
        platform: process.platform,
        agent_bin: agentBin(),
        home: homeDir(),
        allowed_roots: allowedRoots(),
        root_delimiter: process.platform === "win32" ? ";" : ":",
        status,
        agent_version: agentVersion(),
        running: countRunning(),
        max_running: maxRunning(),
        wait_max_seconds: waitMaxSeconds(),
        commander_lock: commanderLockEnabled(),
        require_session: requireSession(),
      });
    }
    case "spawn_cursor":
      return ok(
        launchRun({
          prompt: args.prompt,
          workspace: args.workspace,
          model: args.model,
          sandbox: args.sandbox,
          approve_mcps: args.approve_mcps,
          taskName: args.task_name,
          mode: args.mode,
          worktree: args.worktree,
          worktreeName: args.worktree_name,
        })
      );
    case "followup_cursor": {
      if (!args.run_id && !args.session_id) {
        throw new Error("followup_cursor 需要 run_id 或 session_id");
      }
      let workspace = args.workspace;
      let sessionId = args.session_id;
      let taskName = args.task_name;
      let mode = args.mode;
      let sessionCanary = null;
      if (args.run_id) {
        const prev = refreshRun(args.run_id).meta;
        workspace = workspace || prev.workspace;
        sessionId = sessionId || prev.session_id;
        taskName = taskName || prev.task_name;
        mode = mode || prev.mode;
        sessionCanary = prev.canary || null;
      }
      if (!sessionId) throw new Error("没有可用的 session_id");
      return ok(
        await enqueueSession(sessionId, () =>
          launchRun({
            prompt: args.prompt,
            workspace,
            model: args.model,
            sessionId,
            taskName,
            mode,
            sessionCanary,
          })
        )
      );
    }
    case "get_cursor_status":
      return ok(publicRun(refreshRun(args.run_id).meta));
    case "wait_cursor":
      return ok(await waitRun(args.run_id, args.max_seconds));
    case "get_cursor_result":
      return ok(publicRun(refreshRun(args.run_id).meta));
    case "cancel_cursor":
      return ok(cancelRun(args.run_id));
    case "list_cursor_runs": {
      const limit = Math.min(Number(args.limit) || 10, 50);
      const items = listRunIds()
        .slice(0, limit)
        .map((id) => {
          try {
            return publicRun(refreshRun(id).meta);
          } catch {
            return { run_id: id, status: "unknown" };
          }
        });
      return ok({ items });
    }
    default:
      throw new Error(`未知工具: ${name}`);
  }
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(message) {
  const { id, method, params } = message;
  if (method === "initialize") {
    send({
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: params?.protocolVersion || "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "cursor-worker", version: "0.1.0" },
      },
    });
    return;
  }
  if (method === "notifications/initialized" || method === "initialized") return;
  if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
    return;
  }
  if (method === "tools/list") {
    send({ jsonrpc: "2.0", id, result: { tools: TOOLS } });
    return;
  }
  if (method === "tools/call") {
    try {
      const result = await dispatch(params.name, params.arguments || {});
      send({ jsonrpc: "2.0", id, result });
    } catch (error) {
      send({ jsonrpc: "2.0", id, result: fail(error.message) });
    }
    return;
  }
  if (typeof id !== "undefined") {
    send({
      jsonrpc: "2.0",
      id,
      error: { code: -32601, message: `Method not found: ${method}` },
    });
  }
}

ensureDir(homeDir());
const rl = createInterface({ input: process.stdin });
rl.on("line", async (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  try {
    await handle(JSON.parse(trimmed));
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
  }
});
