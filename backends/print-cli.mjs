import { spawn } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  agentEnv,
  agentNeedsShell,
  runDir,
  sleepSync,
  writeJson,
  writeMeta,
} from "../lib.mjs";

export function cursorPrintArgs(meta) {
  const args = [
    "-p",
    "--force",
    "--trust",
    "--workspace",
    meta.workspace,
    "--output-format",
    "stream-json",
    "--stream-partial-output",
  ];
  if (meta.session_id) args.push("--resume", meta.session_id);
  if (meta.mode === "ask" || meta.mode === "plan") args.push("--mode", meta.mode);
  if (meta.model) args.push("--model", meta.model);
  if (meta.sandbox === "enabled" || meta.sandbox === "disabled") {
    args.push("--sandbox", meta.sandbox);
  }
  if (meta.approve_mcps) args.push("--approve-mcps");
  if (meta.worktree) {
    args.push("-w");
    if (meta.worktree_name) args.push(meta.worktree_name);
  }
  args.push(meta.prompt);
  return args;
}

export function agyPrintArgs(meta) {
  const args = ["-p"];
  if (meta.workspace) args.push("--add-dir", meta.workspace);
  if (meta.mode === "plan") args.push("--mode", "plan");
  else args.push("--mode", "accept-edits");
  if (meta.model) args.push("--model", meta.model);
  if (meta.session_id) args.push("--conversation", meta.session_id);
  args.push(meta.prompt);
  return args;
}

function isRetryable(code, startedAt, stderrPath) {
  if (code === 0) return false;
  if (Date.now() - startedAt > 20_000) return false;
  let log = "";
  try {
    log = readFileSync(stderrPath, "utf8");
  } catch {
    // ignore
  }
  return /429|rate limit|overloaded|ECONNRESET|ETIMEDOUT|EPROTO/i.test(log);
}

export function runPrintJob(runId, meta) {
  const dir = runDir(runId);
  const stderrPath = join(dir, "stderr.log");
  const buildArgs = meta.backend === "agy" ? agyPrintArgs : cursorPrintArgs;
  let attempts = 0;

  function start() {
    attempts += 1;
    const stdout = createWriteStream(join(dir, "events.ndjson"), { flags: "a" });
    const stderr = createWriteStream(stderrPath, { flags: "a" });
    const startedAt = Date.now();
    const child = spawn(meta.worker_bin, buildArgs(meta), {
      cwd: meta.workspace,
      env: agentEnv(meta.worker_bin),
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      shell: agentNeedsShell(meta.worker_bin),
    });
    meta.pid = child.pid;
    meta.job_pid = process.pid;
    meta.status = "running";
    writeMeta(runId, meta);
    child.stdout.pipe(stdout);
    child.stderr.pipe(stderr);
    child.on("error", (error) => {
      meta.status = "failed";
      meta.error = String(error);
      meta.ended_at = new Date().toISOString();
      writeMeta(runId, meta);
      writeJson(join(dir, "exit.json"), {
        code: 1,
        ended_at: meta.ended_at,
        error: String(error),
      });
      process.exit(1);
    });
    child.on("close", (code) => {
      stdout.end();
      stderr.end();
      if (attempts < 2 && isRetryable(code, startedAt, stderrPath)) {
        sleepSync(1500);
        start();
        return;
      }
      const endedAt = new Date().toISOString();
      writeJson(join(dir, "exit.json"), { code: code ?? 1, ended_at: endedAt });
      process.exit(code ?? 1);
    });
  }

  start();
}
