#!/usr/bin/env node
import { commanderLockEnabled } from "../lib.mjs";
import { emit, readStdinJson } from "./io.mjs";

function looksLikeWrite(command) {
  const c = String(command || "");
  if (/\b(npm|pnpm|yarn|vitest|pytest|cargo|go)\s+test\b/i.test(c)) return false;
  return /apply_patch|\bgit\s+(add|commit|push|rm)\b|\brm\s+-|\btee\b|\s>>?\s|Set-Content|Out-File|\bni\s|\bmkdir\s|\btouch\s|\bnpm\s+install\b/i.test(
    c
  );
}

const input = await readStdinJson();
if (!commanderLockEnabled()) process.exit(0);

const tool = String(input.tool_name || "");
const command = input.tool_input?.command || "";
const isPatch =
  /apply_patch|^Write$|^Edit$/i.test(tool) || /functions\.apply_patch/i.test(tool);
const isBash = /^(Bash|exec_command|functions\.exec_command)$/i.test(tool);

if (isPatch || (isBash && looksLikeWrite(command))) {
  emit({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: "deny",
      permissionDecisionReason:
        "指挥官模式：禁止 Codex 自己改业务代码。请用 spawn_cursor / followup_cursor。验收可用 git diff / 测试命令。关闭约束：删掉本仓库 .codex/commander.lock 或设 CURSOR_WORKER_COMMANDER_LOCK=0。",
    },
  });
  process.exit(0);
}

process.exit(0);
