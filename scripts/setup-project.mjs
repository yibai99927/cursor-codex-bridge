#!/usr/bin/env node
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  BRIDGE_DIR,
  agentBin,
  agyBin,
  commanderLockPath,
  defaultRootList,
  projectCodexDir,
  rootDelimiter,
  writeJson,
} from "../lib.mjs";

const repo = BRIDGE_DIR;
const nodeBin = process.execPath;
const server = join(repo, "server.mjs");
const workerHome = join(projectCodexDir(), "cursor-worker");
const configPath = join(projectCodexDir(), "config.toml");
const skillDir = join(repo, ".agents", "skills", "cursor-worker");
const skillFile = join(skillDir, "SKILL.md");

function tomlQuote(value) {
  return JSON.stringify(String(value));
}

if (!existsSync(skillFile)) {
  throw new Error(`缺少项目级 skill：${skillFile}`);
}

const roots = [...new Set([repo, dirname(repo), ...defaultRootList()])];
const toml = `# 由 scripts/setup-project.mjs 生成，只写在本仓库 .codex/。
# 禁止把本文件复制或追加到 ~/.codex/config.toml。

[mcp_servers.cursor_worker]
command = ${tomlQuote(nodeBin)}
args = [${tomlQuote(server)}]
startup_timeout_sec = 20
tool_timeout_sec = 360
enabled = true

[mcp_servers.cursor_worker.env]
AGENT_BIN = ${tomlQuote(agentBin())}
AGY_BIN = ${tomlQuote(agyBin())}
CURSOR_WORKER_HOME = ${tomlQuote(workerHome)}
CURSOR_WORKER_ROOTS = ${tomlQuote(roots.join(rootDelimiter()))}
CURSOR_WORKER_MAX_RUNNING = "4"
CURSOR_WORKER_WAIT_MAX = "300"
CURSOR_WORKER_REQUIRE_SESSION = "1"
CURSOR_WORKER_DEFAULT_BACKEND = "cursor"
CURSOR_WORKER_DEFAULT_MODEL = "cursor-grok-4.6-xhigh-fast"
CURSOR_WORKER_CURSOR_TRANSPORT = "acp"

[features]
hooks = true

[[skills.config]]
enabled = true
path = ${tomlQuote(skillDir)}
`;

mkdirSync(workerHome, { recursive: true });
writeFileSync(configPath, toml);
if (!existsSync(commanderLockPath())) {
  writeJson(commanderLockPath(), {
    enabled: true,
    installed_at: new Date().toISOString(),
  });
}

console.log(`config -> ${configPath}`);
console.log(`skill  -> ${skillFile}`);
console.log(`lock   -> ${commanderLockPath()}`);
console.log("只写了本仓库 .codex/config.toml（本机路径），没有改 ~/.codex。");
console.log("请把 Codex 工作区开在本仓库，信任本项目后完全退出再开新会话。");
