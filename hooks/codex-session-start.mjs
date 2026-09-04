#!/usr/bin/env node
import { emit } from "./io.mjs";

emit({
  hookSpecificOutput: {
    hookEventName: "SessionStart",
    additionalContext:
      "cursor-codex-bridge：若工具列表没有 spawn_cursor，停止改代码，请用户完全退出 ChatGPT/Codex 再开新会话。有 spawn_cursor 时你是指挥官：编码交给 Cursor CLI，不要 apply_patch。工人完成后用 wait_cursor / get_cursor_status，下一轮用户发言时会注入已完成任务摘要。",
  },
});
