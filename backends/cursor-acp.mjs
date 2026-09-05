import { spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { join } from "node:path";
import { AcpClient, acpPromptText, updateText } from "../acp-client.mjs";
import {
  agentEnv,
  agentNeedsShell,
  killPid,
  runDir,
  writeJson,
  writeMeta,
} from "../lib.mjs";

const INIT_CAPS = {
  fs: { readTextFile: false, writeTextFile: false },
  terminal: false,
};

export function cursorAcpArgs(meta) {
  const args = ["--trust", "--force"];
  if (meta.workspace) args.push("--workspace", meta.workspace);
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
  args.push("acp");
  return args;
}

function appendEvent(stream, event) {
  stream.write(`${JSON.stringify(event)}\n`);
}

function collectMessage(update, state) {
  const kind = update?.sessionUpdate;
  const text = updateText(update);
  if (kind === "agent_message_chunk" && text) state.text += text;
  if (kind === "agent_thought_chunk" && text) state.thinking = text;
  if (kind === "tool_call" || kind === "tool_call_update") {
    const name = update.title || update.kind || "tool";
    const path =
      update.locations?.[0]?.path ||
      update.path ||
      update.file ||
      "";
    state.tools.push(path ? `${name} ${path}` : String(name));
  }
}

export async function runCursorAcpTurn(meta, { bin, onEvent } = {}) {
  const child = spawn(bin, cursorAcpArgs(meta), {
    cwd: meta.workspace,
    env: agentEnv(bin),
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    shell: agentNeedsShell(bin),
  });

  const state = { text: "", thinking: "", tools: [] };
  let sessionId = meta.session_id || null;
  const started = Date.now();

  const client = new AcpClient(child, {
    onLine: (line) => onEvent?.({ raw: line }),
    onNotification(method, params) {
      if (method !== "session/update") return;
      const update = params.update || params;
      collectMessage(update, state);
      onEvent?.({ type: "acp", method, update, session_id: sessionId });
    },
  });

  const cancel = () => {
    if (sessionId) {
      try {
        client.notify("session/cancel", { sessionId });
      } catch {
        // ignore
      }
    }
    killPid(child.pid);
  };

  try {
    await client.request(
      "initialize",
      {
        protocolVersion: 1,
        clientCapabilities: INIT_CAPS,
        clientInfo: { name: "cursor-codex-bridge", version: "0.2.0" },
      },
      20_000
    );

    try {
      await client.request("authenticate", { methodId: "cursor_login" }, 8_000);
    } catch {
      // 已 login 的机器上 authenticate 常失败，session/new 仍可用。
    }

    if (sessionId) {
      try {
        await client.request(
          "session/load",
          { sessionId, cwd: meta.workspace, mcpServers: [] },
          20_000
        );
      } catch (error) {
        if (meta.require_load) throw error;
        const created = await client.request(
          "session/new",
          { cwd: meta.workspace, mcpServers: [] },
          30_000
        );
        sessionId = created.sessionId;
        onEvent?.({
          type: "acp",
          method: "session/load-fallback-new",
          error: String(error.message || error),
          session_id: sessionId,
        });
      }
    } else {
      const created = await client.request(
        "session/new",
        { cwd: meta.workspace, mcpServers: [] },
        30_000
      );
      sessionId = created.sessionId;
    }

    if (!sessionId) throw new Error("ACP session/new 没有返回 sessionId");
    onEvent?.({ type: "acp", method: "session/ready", session_id: sessionId });

    const result = await client.request(
      "session/prompt",
      { sessionId, prompt: acpPromptText(meta.prompt) },
      3_600_000
    );

    return {
      sessionId,
      pid: child.pid,
      stopReason: result?.stopReason || "end_turn",
      text: state.text,
      thinking: state.thinking,
      tools: state.tools,
      durationMs: Date.now() - started,
    };
  } finally {
    client.close();
    cancel();
  }
}

export async function runCursorAcpJob(runId, meta) {
  const dir = runDir(runId);
  const events = createWriteStream(join(dir, "events.ndjson"), { flags: "a" });
  const stderr = createWriteStream(join(dir, "stderr.log"), { flags: "a" });

  let lastError = null;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const result = await runCursorAcpTurn(meta, {
        bin: meta.worker_bin,
        onEvent(event) {
          if (event.raw) return;
          if (event.session_id && event.session_id !== meta.session_id) {
            meta.session_id = event.session_id;
            writeMeta(runId, meta);
          }
          appendEvent(events, event);
        },
      });
      meta.session_id = result.sessionId;
      meta.pid = result.pid;
      writeMeta(runId, meta);
      appendEvent(events, {
        type: "result",
        result: result.text,
        session_id: result.sessionId,
        stopReason: result.stopReason,
        duration_ms: result.durationMs,
        tools: result.tools,
      });
      await new Promise((resolve) => events.end(resolve));
      await new Promise((resolve) => stderr.end(resolve));
      writeJson(join(dir, "exit.json"), {
        code: result.stopReason === "end_turn" ? 0 : 1,
        ended_at: new Date().toISOString(),
        stop_reason: result.stopReason,
      });
      return;
    } catch (error) {
      lastError = error;
      appendEvent(events, {
        type: "acp",
        method: "error",
        attempt,
        error: String(error.message || error),
      });
      if (attempt < 3 && /初始化|timeout|超时|session services/i.test(String(error))) {
        continue;
      }
      break;
    }
  }

  await new Promise((resolve) => events.end(resolve));
  await new Promise((resolve) => stderr.end(resolve));
  writeJson(join(dir, "exit.json"), {
    code: 1,
    ended_at: new Date().toISOString(),
    error: String(lastError?.message || lastError || "ACP 失败"),
  });
  meta.error = String(lastError?.message || lastError);
  writeMeta(runId, meta);
  process.exitCode = 1;
}
