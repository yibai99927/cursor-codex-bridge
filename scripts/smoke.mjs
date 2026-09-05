#!/usr/bin/env node
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const serverPath = join(root, "server.mjs");
const workspace = process.env.SMOKE_WORKSPACE || root;

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
  const payload = { jsonrpc: "2.0", id, method, params };
  child.stdin.write(`${JSON.stringify(payload)}\n`);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`timeout waiting for ${method}`));
    }, 120_000);
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

async function waitUntilDone(runId, label) {
  const deadline = Date.now() + 90_000;
  while (Date.now() < deadline) {
    const data = parseTool(
      await call("tools/call", {
        name: "get_cursor_status",
        arguments: { run_id: runId },
      })
    );
    process.stderr.write(
      `[${label}] ${data.status} session=${data.session_id} summary=${(data.summary || "").slice(0, 40)}\n`
    );
    if (data.status === "completed" || data.status === "failed" || data.status === "cancelled") {
      return data;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  throw new Error(`${label} 超时仍未结束`);
}

const failures = [];

try {
  await call("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "smoke", version: "0.1.0" },
  });

  const health = parseTool(
    await call("tools/call", { name: "cursor_bridge_health", arguments: {} })
  );
  process.stderr.write(`health: ${health.status}\n`);

  const [a, b] = await Promise.all([
    call("tools/call", {
      name: "spawn_cursor",
      arguments: {
        task_name: "smoke-alpha",
        mode: "ask",
        workspace,
        prompt: "只用一个词回答：alpha。不要读文件，不要改任何东西。",
      },
    }).then(parseTool),
    call("tools/call", {
      name: "spawn_cursor",
      arguments: {
        task_name: "smoke-beta",
        mode: "ask",
        workspace,
        prompt: "只用一个词回答：beta。不要读文件，不要改任何东西。",
      },
    }).then(parseTool),
  ]);

  process.stderr.write(
    `spawned ${a.task_name}=${a.run_id} ${a.status} ${a.session_id}\n`
  );
  process.stderr.write(
    `spawned ${b.task_name}=${b.run_id} ${b.status} ${b.session_id}\n`
  );

  if (a.session_id && b.session_id && a.session_id === b.session_id) {
    failures.push("两个并行 spawn 不应共享 session_id");
  }
  if (!["running", "starting", "completed"].includes(a.status)) {
    failures.push(`alpha 初始状态异常: ${a.status}`);
  }
  if (!["running", "starting", "completed"].includes(b.status)) {
    failures.push(`beta 初始状态异常: ${b.status}`);
  }

  const listed = parseTool(
    await call("tools/call", {
      name: "list_cursor_runs",
      arguments: { limit: 10 },
    })
  );
  const names = (listed.items || []).map((item) => item.task_name);
  if (!names.includes("smoke-alpha") || !names.includes("smoke-beta")) {
    failures.push(`list 未并列看到两个任务: ${names.join(",")}`);
  }

  const [doneA, doneB] = await Promise.all([
    waitUntilDone(a.run_id, "alpha"),
    waitUntilDone(b.run_id, "beta"),
  ]);

  if (doneA.status !== "completed") failures.push(`alpha 终态 ${doneA.status}`);
  if (doneB.status !== "completed") failures.push(`beta 终态 ${doneB.status}`);
  if (doneA.session_id === doneB.session_id) {
    failures.push("完成后 session_id 仍然相同");
  }

  const report = {
    ok: failures.length === 0,
    failures,
    alpha: doneA,
    beta: doneB,
  };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  child.kill("SIGTERM");
  process.exit(failures.length === 0 ? 0 : 1);
} catch (error) {
  process.stderr.write(`${error.stack || error}\n`);
  child.kill("SIGTERM");
  process.exit(1);
}
