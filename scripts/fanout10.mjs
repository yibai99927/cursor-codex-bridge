#!/usr/bin/env node
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomBytes } from "node:crypto";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const serverPath = join(root, "server.mjs");
const workspace = join(root, ".tmp-mega-app");
const WAVE1_MS = Number(process.env.FANOUT_WAVE1_MS || 8 * 60_000);
const WAVE2_MS = Number(process.env.FANOUT_WAVE2_MS || 8 * 60_000);

const MODULES = [
  "auth",
  "billing",
  "cart",
  "catalog",
  "notify",
  "search",
  "inventory",
  "analytics",
  "settings",
  "health",
];

function prepareWorkspace() {
  rmSync(workspace, { recursive: true, force: true });
  mkdirSync(join(workspace, "modules"), { recursive: true });
  writeFileSync(
    join(workspace, "README.md"),
    "# mega-app fixture\n\n每个工人只改自己的 modules/<name>.mjs。\n"
  );
  writeFileSync(
    join(workspace, "package.json"),
    `${JSON.stringify({ name: "mega-app-fixture", private: true, type: "module" }, null, 2)}\n`
  );
}

const child = spawn(process.execPath, [serverPath], {
  stdio: ["pipe", "pipe", "inherit"],
  env: process.env,
  windowsHide: true,
});

const pending = new Map();
let nextId = 1;
const rl = createInterface({ input: child.stdout });
rl.on("line", (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let message;
  try {
    message = JSON.parse(trimmed);
  } catch {
    return;
  }
  if (message.id != null && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) reject(new Error(JSON.stringify(message.error)));
    else resolve(message.result);
  }
});

function call(method, params) {
  const id = nextId++;
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, 180_000);
    pending.set(id, {
      resolve: (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      reject: (error) => {
        clearTimeout(timer);
        reject(error);
      },
    });
  });
}

function parseTool(result) {
  const text = result.content?.[0]?.text || "";
  const data = JSON.parse(text);
  if (result.isError || data.error) {
    throw new Error(data.error || text);
  }
  return data;
}

async function waitUntilDone(runId, label, budgetMs) {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline) {
    const data = parseTool(
      await call("tools/call", {
        name: "get_cursor_status",
        arguments: { run_id: runId },
      })
    );
    process.stderr.write(
      `[${label}] ${data.status} tools=${data.tool_count || 0} ${(data.summary || data.progress || "").slice(0, 60)}\n`
    );
    if (["completed", "failed", "cancelled"].includes(data.status)) return data;
    await new Promise((resolve) => setTimeout(resolve, 3000));
  }
  throw new Error(`${label} 超时仍未结束`);
}

function readIf(path) {
  return existsSync(path) ? readFileSync(path, "utf8") : null;
}

prepareWorkspace();

const secrets = Object.fromEntries(
  MODULES.map((name) => [name, `鲸-${name}-${randomBytes(3).toString("hex")}`])
);

const report = {
  wave1: [],
  wave2: [],
  sessions: {},
  failures: [],
};

try {
  await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "fanout10", version: "0.1.0" },
  });

  const health = parseTool(
    await call("tools/call", { name: "cursor_bridge_health", arguments: {} })
  );
  process.stderr.write(`health: ${health.status}\n`);

  process.stderr.write("=== wave1: 并行 spawn 10 个独立模块工人 ===\n");
  const startedAt = Date.now();
  const spawned = await Promise.all(
    MODULES.map((name) =>
      call("tools/call", {
        name: "spawn_cursor",
        arguments: {
          task_name: `mod-${name}`,
          workspace,
          prompt: [
            `你是 mega-app 的模块工人，只负责 ${name}。`,
            `在 ${workspace} 创建 modules/${name}.mjs，必须是合法 ESM，且至少包含：`,
            `export const moduleId = "${name}";`,
            `export function ping() { return "${name}-ok"; }`,
            "禁止修改 package.json、README 和其它模块文件。",
            "不要把下面的暗号写进任何文件。",
            `对话暗号（只记在对话里）：${secrets[name]}`,
            "完成后用一句话说明写了哪个文件。",
          ].join("\n"),
        },
      }).then(parseTool)
    )
  );

  const sessionIds = spawned.map((item) => item.session_id);
  const uniqueSessions = new Set(sessionIds);
  if (uniqueSessions.size !== 10) {
    report.failures.push(
      `wave1 session 去重后只有 ${uniqueSessions.size} 个: ${sessionIds.join(",")}`
    );
  }

  for (const item of spawned) {
    report.wave1.push({
      task_name: item.task_name,
      run_id: item.run_id,
      session_id: item.session_id,
      spawn_status: item.status,
    });
    report.sessions[item.task_name] = item.session_id;
    process.stderr.write(
      `spawned ${item.task_name} ${item.run_id} ${item.session_id} ${item.status}\n`
    );
  }

  const done1 = await Promise.all(
    spawned.map((item) =>
      waitUntilDone(item.run_id, item.task_name, WAVE1_MS).then((done) => {
        item.final = done;
        return done;
      })
    )
  );
  report.wave1_ms = Date.now() - startedAt;

  for (const item of spawned) {
    const file = join(workspace, "modules", `${item.task_name.replace("mod-", "")}.mjs`);
    const body = readIf(file);
    const name = item.task_name.replace("mod-", "");
    if (item.final.status !== "completed") {
      report.failures.push(`${item.task_name} wave1 终态 ${item.final.status}`);
    }
    if (!body || !body.includes(`moduleId = "${name}"`)) {
      report.failures.push(`${item.task_name} 未写出合格 modules/${name}.mjs`);
    }
    if (body && body.includes(secrets[name])) {
      report.failures.push(`${item.task_name} 把暗号写进了源码（不应泄露）`);
    }
    item.file_ok = Boolean(body && body.includes(`moduleId = "${name}"`));
  }

  process.stderr.write("=== wave2: 10 路各自 followup 续跑 ===\n");
  const followStarted = Date.now();
  const followups = await Promise.all(
    spawned.map((item) => {
      const name = item.task_name.replace("mod-", "");
      return call("tools/call", {
        name: "followup_cursor",
        arguments: {
          run_id: item.run_id,
          task_name: `${item.task_name}-resume`,
          prompt: [
            `不要读文件。根据上一轮对话记住的暗号，创建 modules/${name}.resume.txt。`,
            "文件内容只能是暗号本身，不要引号、不要解释、不要其它文字。",
            "不要改其它文件。",
          ].join("\n"),
        },
      }).then(parseTool);
    })
  );

  for (const [index, item] of spawned.entries()) {
    const follow = followups[index];
    if (follow.session_id !== item.session_id) {
      report.failures.push(
        `${item.task_name} 续跑 session 变了 ${item.session_id} -> ${follow.session_id}`
      );
    }
    item.follow = follow;
    process.stderr.write(
      `followup ${follow.task_name} ${follow.run_id} session=${follow.session_id}\n`
    );
  }

  const done2 = await Promise.all(
    followups.map((item) => waitUntilDone(item.run_id, item.task_name, WAVE2_MS))
  );
  report.wave2_ms = Date.now() - followStarted;

  for (const [index, item] of spawned.entries()) {
    const name = item.task_name.replace("mod-", "");
    const resumePath = join(workspace, "modules", `${name}.resume.txt`);
    const resume = (readIf(resumePath) || "").trim();
    const final = done2[index];
    const row = {
      task_name: item.task_name,
      wave1_status: item.final.status,
      wave2_status: final.status,
      session_id: item.session_id,
      follow_session_id: followups[index].session_id,
      file_ok: item.file_ok,
      resume_ok: resume === secrets[name],
      resume_body: resume.slice(0, 80),
    };
    report.wave2.push(row);
    if (final.status !== "completed") {
      report.failures.push(`${item.task_name} wave2 终态 ${final.status}`);
    }
    if (resume !== secrets[name]) {
      report.failures.push(
        `${item.task_name} 续跑暗号不匹配: got=${JSON.stringify(resume)} expected=${secrets[name]}`
      );
    }
  }

  report.ok = report.failures.length === 0;
  report.unique_sessions = uniqueSessions.size;
  report.parallel_wave1_ok = uniqueSessions.size === 10 && done1.every((d) => d.status === "completed");
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  child.kill("SIGTERM");
  process.exit(report.ok ? 0 : 1);
} catch (error) {
  process.stderr.write(`${error.stack || error}\n`);
  try {
    process.stdout.write(`${JSON.stringify({ ok: false, failures: report.failures, error: String(error) }, null, 2)}\n`);
  } catch {
    // ignore
  }
  child.kill("SIGTERM");
  process.exit(1);
}
