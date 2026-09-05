#!/usr/bin/env node
import { runCursorAcpJob } from "./backends/cursor-acp.mjs";
import { runPrintJob } from "./backends/print-cli.mjs";
import { readMeta, resolveWorker, writeMeta } from "./lib.mjs";

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

if (!meta.worker_bin || !meta.transport) {
  const worker = resolveWorker(meta.backend);
  meta.backend = worker.backend;
  meta.transport = worker.transport;
  meta.worker_bin = worker.bin;
  writeMeta(runId, meta);
}

meta.job_pid = process.pid;
meta.status = "running";
writeMeta(runId, meta);

if (meta.backend === "cursor" && meta.transport === "acp") {
  await runCursorAcpJob(runId, meta);
} else {
  runPrintJob(runId, meta);
}
