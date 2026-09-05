#!/usr/bin/env node
import { spawn } from "node:child_process";
import { AcpClient, defaultAcpRequestResult } from "../acp-client.mjs";
import { agyPrintArgs, cursorPrintArgs } from "../backends/print-cli.mjs";
import { cursorAcpArgs } from "../backends/cursor-acp.mjs";
import { normalizeBackend, cursorTransport } from "../lib.mjs";

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

assert(normalizeBackend("antigravity") === "agy", "agy alias");
assert(normalizeBackend("cursor") === "cursor", "cursor default");
assert(cursorTransport() === "acp" || cursorTransport() === "print", "transport");

const acpArgs = cursorAcpArgs({
  workspace: "/tmp/ws",
  mode: "ask",
  model: "composer-2.5",
  approve_mcps: true,
});
assert(acpArgs.includes("acp"), "cursor acp flag");
assert(acpArgs.includes("--mode") && acpArgs.includes("ask"), "cursor acp mode");
assert(acpArgs.at(-1) === "acp", "acp is the command");
const defaultAcp = cursorAcpArgs({
  workspace: "/tmp/ws",
  model: "cursor-grok-4.6-xhigh-fast",
});
assert(defaultAcp.includes("cursor-grok-4.6-xhigh-fast"), "default grok slug on acp");

const printArgs = cursorPrintArgs({
  workspace: "/tmp/ws",
  prompt: "hi",
  session_id: "abc",
});
assert(printArgs.includes("-p"), "cursor print");
assert(printArgs.includes("--resume"), "cursor resume");

const agyArgs = agyPrintArgs({
  workspace: "/tmp/ws",
  prompt: "hi",
  mode: "agent",
});
assert(agyArgs[0] === "-p", "agy print");
assert(agyArgs.includes("accept-edits"), "agy degraded accept-edits");

const mock = spawn(process.execPath, [
  "--input-type=module",
  "-e",
  `
  import { createInterface } from "node:readline";
  const rl = createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const msg = JSON.parse(line);
    if (msg.method === "initialize") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { protocolVersion: 1 } }) + "\\n");
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        id: 99,
        method: "session/request_permission",
        params: { options: [{ optionId: "allow-always" }] },
      }) + "\\n");
      return;
    }
    if (msg.method === "session/new") {
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result: { sessionId: "sess-1" } }) + "\\n");
      process.stdout.write(JSON.stringify({
        jsonrpc: "2.0",
        method: "session/update",
        params: { update: { sessionUpdate: "agent_message_chunk", content: { text: "pong" } } },
      }) + "\\n");
    }
  });
  `,
]);

const seen = [];
const client = new AcpClient(mock, {
  onNotification(method, params) {
    seen.push({ method, params });
  },
  onRequest(method) {
    return defaultAcpRequestResult(method);
  },
});

const init = await client.request("initialize", { protocolVersion: 1 }, 5000);
assert(init.protocolVersion === 1, "init");
const sess = await client.request("session/new", { cwd: "/tmp" }, 5000);
assert(sess.sessionId === "sess-1", "session");
await new Promise((resolve) => setTimeout(resolve, 50));
assert(
  seen.some((item) => item.params?.update?.content?.text === "pong"),
  "chunk"
);
assert(
  defaultAcpRequestResult("session/request_permission").outcome.optionId ===
    "allow-always",
  "auto allow"
);
client.close();
mock.kill();

console.log("acp tests ok");
