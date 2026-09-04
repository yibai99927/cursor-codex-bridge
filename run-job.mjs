#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createWriteStream, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  agentBin,
  agentEnv,
  agentNeedsShell,
  readMeta,
  runDir,
  sleepSync,
  writeJson,
  writeMeta,
} from "./lib.mjs";

const runId = process.argv[2];
if (!runId) {
  console.error("usage: run-job.mjs <run_id>");
  process.exit(2);
}

const meta = readMeta(runId);
if (!meta) {
  console.error(`missing meta for ${runId}`);
  process.exit(2);
}

const dir = runDir(runId);

function buildArgs() {
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

function isRetryable(code, startedAt) {
  if (code === 0) return false;
  if (Date.now() - startedAt > 20_000) return false;
  let log = "";
  try {
    log = readFileSync(join(dir, "stderr.log"), "utf8");
  } catch {
    // ignore
  }
  return /429|rate limit|overloaded|ECONNRESET|ETIMEDOUT|EPROTO/i.test(log);
}

function startAgent() {
  const stdout = createWriteStream(join(dir, "events.ndjson"), { flags: "a" });
  const stderr = createWriteStream(join(dir, "stderr.log"), { flags: "a" });
  const startedAt = Date.now();
  const child = spawn(agentBin(), buildArgs(), {
    cwd: meta.workspace,
    env: agentEnv(),
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
    shell: agentNeedsShell(),
  });
  meta.pid = child.pid;
  meta.job_pid = process.pid;
  meta.status = "running";
  writeMeta(runId, meta);
  child.stdout.pipe(stdout);
  child.stderr.pipe(stderr);
  return { child, stdout, stderr, startedAt };
}

let attempts = 0;

function runAttempt() {
  attempts += 1;
  const { child, stdout, stderr, startedAt } = startAgent();

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
    if (attempts < 2 && isRetryable(code, startedAt)) {
      sleepSync(1500);
      runAttempt();
      return;
    }
    const endedAt = new Date().toISOString();
    writeJson(join(dir, "exit.json"), { code: code ?? 1, ended_at: endedAt });
    process.exit(code ?? 1);
  });
}

runAttempt();
