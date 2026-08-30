import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BRIDGE_DIR = dirname(fileURLToPath(import.meta.url));

export function homeDir() {
  return process.env.CURSOR_WORKER_HOME || join(homedir(), ".codex", "cursor-worker");
}

export function runsDir() {
  return join(homeDir(), "runs");
}

export function runDir(runId) {
  return join(runsDir(), runId);
}

export function agentBin() {
  return process.env.AGENT_BIN || join(homedir(), ".local", "bin", "agent");
}

export function allowedRoots() {
  const raw =
    process.env.CURSOR_WORKER_ROOTS ||
    [join(homedir(), "开发"), join(homedir(), "Documents")].join(":");
  return raw
    .split(":")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => resolve(item));
}

export function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

export function readJson(path, fallback = null) {
  if (!existsSync(path)) return fallback;
  return JSON.parse(readFileSync(path, "utf8"));
}

export function writeJson(path, data) {
  ensureDir(dirname(path));
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

export function readMeta(runId) {
  return readJson(join(runDir(runId), "meta.json"));
}

export function writeMeta(runId, meta) {
  writeJson(join(runDir(runId), "meta.json"), meta);
}

export function assertWorkspace(workspace) {
  if (!workspace || typeof workspace !== "string") {
    throw new Error("workspace 必须是绝对路径");
  }
  const abs = resolve(workspace);
  if (!existsSync(abs)) {
    throw new Error(`workspace 不存在: ${abs}`);
  }
  const ok = allowedRoots().some(
    (root) => abs === root || abs.startsWith(`${root}/`)
  );
  if (!ok) {
    throw new Error(
      `workspace 不在允许目录内: ${abs}。允许：${allowedRoots().join(", ")}`
    );
  }
  return abs;
}

export function listRunIds() {
  ensureDir(runsDir());
  return readJson(join(homeDir(), "index.json"), []);
}

export function rememberRun(runId) {
  const ids = listRunIds().filter((id) => id !== runId);
  ids.unshift(runId);
  writeJson(join(homeDir(), "index.json"), ids.slice(0, 200));
}

export function isPidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

export function createCursorChat() {
  const out = execFileSync(agentBin(), ["create-chat"], {
    encoding: "utf8",
    timeout: 15_000,
  }).trim();
  const sessionId = out.split(/\s+/).pop();
  if (!sessionId || sessionId.length < 8) {
    throw new Error(`create-chat 未返回有效 session_id: ${out}`);
  }
  return sessionId;
}

export function parseEvents(runId) {
  const path = join(runDir(runId), "events.ndjson");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

export function summarizeEvents(events) {
  let sessionId = null;
  let resultText = "";
  let lastAssistant = "";
  let lastThinking = "";
  let isError = false;
  let durationMs = null;
  const tools = [];

  for (const event of events) {
    if (event.session_id) sessionId = event.session_id;
    if (event.type === "thinking" && event.subtype === "delta" && event.text) {
      lastThinking = event.text;
    }
    if (event.type === "assistant" && event.message?.content) {
      const text = event.message.content
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("");
      if (text) lastAssistant = text;
    }
    if (event.type === "tool_call") {
      const name =
        event.subtype ||
        Object.keys(event.tool_call || event)[0] ||
        "tool";
      const path =
        event.tool_call?.writeToolCall?.args?.path ||
        event.tool_call?.readToolCall?.args?.path ||
        event.path ||
        "";
      tools.push(path ? `${name} ${path}` : String(name));
    }
    if (event.type === "result") {
      resultText = event.result || "";
      isError = Boolean(event.is_error) || event.subtype === "error";
      durationMs = event.duration_ms ?? null;
    }
  }

  return {
    sessionId,
    resultText,
    lastAssistant,
    lastThinking,
    isError,
    durationMs,
    tools: tools.slice(-12),
    toolCount: tools.length,
  };
}

export function refreshRun(runId) {
  const meta = readMeta(runId);
  if (!meta) throw new Error(`找不到 run: ${runId}`);

  const events = parseEvents(runId);
  const summary = summarizeEvents(events);
  const exit = readJson(join(runDir(runId), "exit.json"));
  const agentAlive = isPidAlive(meta.pid);
  const jobAlive = isPidAlive(meta.job_pid);
  const startedMs = meta.started_at ? Date.parse(meta.started_at) : Date.now();
  const startingGrace = Date.now() - startedMs < 20_000;
  const stillWorking =
    agentAlive || jobAlive || (startingGrace && !meta.pid && !exit);

  if (summary.sessionId && summary.sessionId !== meta.session_id) {
    meta.session_id = summary.sessionId;
  }

  if (exit) {
    meta.status = exit.code === 0 && !summary.isError ? "completed" : "failed";
    meta.ended_at = exit.ended_at;
    meta.exit_code = exit.code;
    meta.summary = summary.resultText || summary.lastAssistant || meta.summary || "";
    meta.progress = summary.lastThinking || meta.progress;
    meta.tools = summary.tools;
    meta.tool_count = summary.toolCount;
    meta.duration_ms = summary.durationMs;
    if (summary.isError) meta.status = "failed";
  } else if (
    (meta.status === "running" || meta.status === "starting") &&
    !stillWorking &&
    events.length > 0 &&
    summary.resultText
  ) {
    meta.status = summary.isError ? "failed" : "completed";
    meta.ended_at = new Date().toISOString();
    meta.summary = summary.resultText || summary.lastAssistant;
    meta.tools = summary.tools;
    meta.tool_count = summary.toolCount;
  } else if (
    (meta.status === "running" || meta.status === "starting") &&
    !stillWorking &&
    !exit
  ) {
    meta.status = "failed";
    meta.ended_at = new Date().toISOString();
    meta.summary = summary.lastAssistant || "进程已退出，但没有写出 exit.json";
  } else if (meta.status === "running" || meta.status === "starting") {
    meta.status = "running";
    meta.progress = summary.lastThinking || summary.lastAssistant || meta.progress;
    meta.tools = summary.tools;
    meta.tool_count = summary.toolCount;
    meta.summary = summary.lastAssistant || meta.summary;
  }

  writeMeta(runId, meta);
  return { meta, summary };
}

export function publicRun(meta) {
  return {
    run_id: meta.run_id,
    task_name: meta.task_name ?? null,
    session_id: meta.session_id,
    status: meta.status,
    workspace: meta.workspace,
    prompt: meta.prompt,
    mode: meta.mode ?? null,
    started_at: meta.started_at,
    ended_at: meta.ended_at ?? null,
    duration_ms: meta.duration_ms ?? null,
    tool_count: meta.tool_count ?? 0,
    recent_tools: meta.tools ?? [],
    progress: meta.progress ?? "",
    summary: meta.summary ?? "",
    exit_code: meta.exit_code ?? null,
    error: meta.error ?? null,
  };
}
