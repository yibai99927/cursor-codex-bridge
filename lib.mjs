import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import path, { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const BRIDGE_DIR = dirname(fileURLToPath(import.meta.url));

export function rootDelimiter(platform = process.platform) {
  return platform === "win32" ? ";" : ":";
}

export function splitRootList(raw, platform = process.platform) {
  if (!raw) return [];
  return raw
    .split(rootDelimiter(platform))
    .map((item) => item.trim())
    .filter(Boolean);
}

export function isPathInsideRoot(target, root, pathApi = path) {
  const absTarget = pathApi.resolve(target);
  const absRoot = pathApi.resolve(root);
  const rel = pathApi.relative(absRoot, absTarget);
  if (rel === "") return true;
  return !rel.startsWith("..") && !pathApi.isAbsolute(rel);
}

export function defaultRootList() {
  const home = homedir();
  const roots = [];
  const documents = join(home, "Documents");
  if (existsSync(documents)) roots.push(documents);
  if (process.platform === "win32") {
    const desktop = join(home, "Desktop");
    if (existsSync(desktop)) roots.push(desktop);
  } else {
    const dev = join(home, "开发");
    if (existsSync(dev)) roots.push(dev);
  }
  return roots;
}

export function homeDir() {
  return process.env.CURSOR_WORKER_HOME || join(homedir(), ".codex", "cursor-worker");
}

export function runsDir() {
  return join(homeDir(), "runs");
}

export function runDir(runId) {
  return join(runsDir(), runId);
}

function looksLikeBinary(file) {
  return existsSync(file) && !/\.(md|txt|json)$/i.test(file);
}

function firstWhereHit(name) {
  try {
    const out = execFileSync("where.exe", [name], {
      encoding: "utf8",
      timeout: 8_000,
      windowsHide: true,
    });
    const lines = out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => looksLikeBinary(line));
    const exe = lines.find((line) => /\.exe$/i.test(line));
    return exe || lines[0] || null;
  } catch {
    return null;
  }
}

function firstWhichHit(name) {
  try {
    const out = execFileSync("which", [name], {
      encoding: "utf8",
      timeout: 8_000,
    }).trim();
    return looksLikeBinary(out) ? out : null;
  } catch {
    return null;
  }
}

function discoverAgentBin() {
  const home = homedir();
  const localAppData =
    process.env.LOCALAPPDATA || join(home, "AppData", "Local");
  const candidates =
    process.platform === "win32"
      ? [
          join(localAppData, "cursor-agent", "cursor-agent.exe"),
          join(localAppData, "cursor-agent", "agent.exe"),
          join(home, ".local", "bin", "agent.exe"),
          join(home, ".local", "bin", "cursor-agent.exe"),
        ]
      : [
          join(home, ".local", "bin", "agent"),
          join(home, ".local", "bin", "cursor-agent"),
        ];
  for (const file of candidates) {
    if (looksLikeBinary(file)) return file;
  }
  if (process.platform === "win32") {
    return (
      firstWhereHit("cursor-agent.exe") ||
      firstWhereHit("agent.exe") ||
      firstWhereHit("cursor-agent") ||
      firstWhereHit("agent") ||
      candidates[0]
    );
  }
  return firstWhichHit("agent") || firstWhichHit("cursor-agent") || candidates[0];
}

let cachedAgentBin;

export function agentBin() {
  if (process.env.AGENT_BIN) return process.env.AGENT_BIN;
  if (!cachedAgentBin) cachedAgentBin = discoverAgentBin();
  return cachedAgentBin;
}

export function agentNeedsShell(bin = agentBin()) {
  return process.platform === "win32" && /\.(cmd|bat)$/i.test(bin);
}

export function agentEnv() {
  const dir = dirname(agentBin());
  return {
    ...process.env,
    PATH: `${dir}${delimiter}${process.env.PATH || ""}`,
  };
}

export function execAgent(args, extra = {}) {
  return execFileSync(agentBin(), args, {
    encoding: "utf8",
    env: agentEnv(),
    windowsHide: true,
    shell: agentNeedsShell(),
    ...extra,
  });
}

export function allowedRoots() {
  const raw =
    process.env.CURSOR_WORKER_ROOTS ||
    defaultRootList().join(rootDelimiter());
  return splitRootList(raw)
    .map((item) => resolve(item))
    .filter(Boolean);
}

export function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function ensureDir(path) {
  mkdirSync(path, { recursive: true });
}

export function sleepSync(ms) {
  const buf = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(buf, 0, 0, ms);
}

export function withIndexLock(fn) {
  ensureDir(homeDir());
  const lockDir = join(homeDir(), ".index.lock");
  const deadline = Date.now() + 8_000;
  while (Date.now() < deadline) {
    try {
      mkdirSync(lockDir);
      break;
    } catch {
      try {
        const age = Date.now() - statSync(lockDir).mtimeMs;
        if (age > 30_000) rmdirSync(lockDir);
      } catch {
        // ignore
      }
      sleepSync(25);
    }
  }
  if (!existsSync(lockDir)) {
    throw new Error("无法获取 run 索引锁");
  }
  try {
    return fn();
  } finally {
    try {
      rmdirSync(lockDir);
    } catch {
      // ignore
    }
  }
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
  const roots = allowedRoots();
  if (!roots.length) {
    throw new Error(
      "未配置可用的 CURSOR_WORKER_ROOTS（默认不再包含整个用户主目录）。请在 Codex MCP env 里设置。"
    );
  }
  const ok = roots.some((root) => isPathInsideRoot(abs, root));
  if (!ok) {
    throw new Error(
      `workspace 不在允许目录内: ${abs}。允许：${roots.join(", ") || "(空)"}。请设置 CURSOR_WORKER_ROOTS。`
    );
  }
  return abs;
}

export function listRunIds() {
  ensureDir(runsDir());
  return readJson(join(homeDir(), "index.json"), []);
}

export function rememberRun(runId) {
  withIndexLock(() => {
    const ids = listRunIds().filter((id) => id !== runId);
    ids.unshift(runId);
    writeJson(join(homeDir(), "index.json"), ids.slice(0, 200));
  });
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

export function processCommandLine(pid) {
  if (!pid) return null;
  try {
    if (process.platform === "win32") {
      const out = execFileSync(
        "tasklist",
        ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
        { encoding: "utf8", timeout: 5_000, windowsHide: true }
      ).toLowerCase();
      return out.trim() || null;
    }
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], {
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
  } catch {
    return null;
  }
}

export function isBridgePid(pid, kind) {
  if (!isPidAlive(pid)) return false;
  const cmd = processCommandLine(pid);
  if (!cmd) return true;
  const lower = cmd.toLowerCase();
  if (kind === "job") {
    if (process.platform === "win32") return lower.includes("node.exe") || lower.includes("node");
    return lower.includes("run-job.mjs");
  }
  return (
    lower.includes("cursor-agent") ||
    lower.includes("cursor\\agent") ||
    /(^|[\\/ ])agent(\.exe)?(\s|$)/.test(lower) ||
    lower.includes("agent.exe")
  );
}

export function killPid(pid) {
  if (!pid) return;
  try {
    if (process.platform === "win32") {
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
        timeout: 10_000,
      });
      return;
    }
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      // ignore
    }
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // ignore
    }
    sleepSync(200);
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // ignore
    }
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // ignore
    }
  } catch {
    // already gone
  }
}

export function createCursorChat() {
  let lastError = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const out = execAgent(["create-chat"], { timeout: 15_000 }).trim();
      const sessionId = out.split(/\s+/).pop();
      if (sessionId && sessionId.length >= 8) return sessionId;
      lastError = `create-chat 未返回有效 session_id: ${out}`;
    } catch (error) {
      lastError = error.message;
    }
    sleepSync(400 * (attempt + 1));
  }
  return null;
}

export function parseEvents(runId) {
  const path = join(runDir(runId), "events.ndjson");
  if (!existsSync(path)) return [];
  const raw = readFileSync(path, "utf8");
  const lines = raw.split(/\r?\n/);
  if (raw.length > 0 && !/\r?\n$/.test(raw)) {
    lines.pop();
  }
  return lines
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

function collectToolPaths(value, acc = []) {
  if (!value || typeof value !== "object") return acc;
  for (const [key, entry] of Object.entries(value)) {
    if (
      (key === "path" || key === "file" || key === "target") &&
      typeof entry === "string"
    ) {
      acc.push(entry);
    } else if (entry && typeof entry === "object") {
      collectToolPaths(entry, acc);
    }
  }
  return acc;
}

export function summarizeEvents(events) {
  let sessionId = null;
  let resultText = "";
  let lastAssistant = "";
  let lastThinking = "";
  let isError = false;
  let durationMs = null;
  const tools = [];
  const edited = [];

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
      const blob = event.tool_call || event;
      const paths = collectToolPaths(blob);
      const keys = Object.keys(event.tool_call || {}).filter(
        (key) => key.toLowerCase().includes("tool") || key.endsWith("Call")
      );
      const name =
        event.subtype ||
        keys[0] ||
        Object.keys(event.tool_call || {})[0] ||
        "tool";
      const path = paths[0] || "";
      tools.push(path ? `${name} ${path}` : String(name));
      for (const item of paths) {
        if (
          /write|edit|apply|delete/i.test(name) ||
          /write|edit|apply|delete/i.test(JSON.stringify(blob).slice(0, 400))
        ) {
          edited.push(item);
        }
      }
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
    edited_paths: [...new Set(edited)].slice(-20),
  };
}

export function refreshRun(runId) {
  const meta = readMeta(runId);
  if (!meta) throw new Error(`找不到 run: ${runId}`);

  const events = parseEvents(runId);
  const summary = summarizeEvents(events);
  const exit = readJson(join(runDir(runId), "exit.json"));
  const agentAlive = isBridgePid(meta.pid, "agent");
  const jobAlive = isBridgePid(meta.job_pid, "job");
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
    meta.edited_paths = summary.edited_paths;
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
    meta.edited_paths = summary.edited_paths;
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
    meta.edited_paths = summary.edited_paths;
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
    edited_paths: meta.edited_paths ?? [],
    progress: meta.progress ?? "",
    summary: meta.summary ?? "",
    exit_code: meta.exit_code ?? null,
    error: meta.error ?? null,
  };
}
