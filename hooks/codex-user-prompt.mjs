#!/usr/bin/env node
import { join } from "node:path";
import {
  commanderLockPath,
  homeDir,
  listRunIds,
  publicRun,
  readJson,
  refreshRun,
  writeJson,
} from "../lib.mjs";
import { emit } from "./io.mjs";

const statePath = join(homeDir(), "hook-notified.json");
const lock = readJson(commanderLockPath(), {});
const since = lock.installed_at ? Date.parse(lock.installed_at) : 0;
const seen = new Set(readJson(statePath, { ids: [] }).ids || []);
const fresh = [];

for (const id of listRunIds().slice(0, 40)) {
  try {
    const { meta } = refreshRun(id);
    if (!["completed", "failed", "cancelled"].includes(meta.status)) continue;
    if (seen.has(id)) continue;
    if (meta.ended_at && Date.parse(meta.ended_at) < since) continue;
    fresh.push(publicRun(meta));
    seen.add(id);
  } catch {
    // ignore
  }
}

writeJson(statePath, { ids: [...seen].slice(0, 400) });

if (!fresh.length) process.exit(0);

const lines = fresh.map(
  (item) =>
    `- ${item.task_name || item.run_id}: ${item.status} session=${item.session_id || "?"} ${(item.summary || "").slice(0, 120)}`
);

emit({
  hookSpecificOutput: {
    hookEventName: "UserPromptSubmit",
    additionalContext: `cursor-codex-bridge 工人已结束（自上轮用户发言以来）：\n${lines.join("\n")}\n请验收 git diff / 测试，不要假装不知道这些任务。`,
  },
});
