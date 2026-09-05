import { createInterface } from "node:readline";

export class AcpClient {
  constructor(child, options = {}) {
    this.child = child;
    this.nextId = 1;
    this.pending = new Map();
    this.closed = false;
    this.onNotification = options.onNotification || (() => {});
    this.onRequest = options.onRequest || null;
    this.onLine = options.onLine || (() => {});

    this.rl = createInterface({ input: child.stdout });
    this.rl.on("line", (line) => this.#handleLine(line));
    child.on("exit", () => this.#rejectAll(new Error("ACP 进程已退出")));
  }

  request(method, params, timeoutMs = 30_000) {
    if (this.closed) return Promise.reject(new Error("ACP 客户端已关闭"));
    const id = this.nextId++;
    this.#write({ jsonrpc: "2.0", id, method, params });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`ACP 超时: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
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

  notify(method, params) {
    this.#write({ jsonrpc: "2.0", method, params });
  }

  respond(id, result) {
    this.#write({ jsonrpc: "2.0", id, result });
  }

  respondError(id, message) {
    this.#write({
      jsonrpc: "2.0",
      id,
      error: { code: -32000, message: String(message) },
    });
  }

  close() {
    this.closed = true;
    this.#rejectAll(new Error("ACP 客户端已关闭"));
    try {
      this.rl.close();
    } catch {
      // ignore
    }
    try {
      this.child.stdin.end();
    } catch {
      // ignore
    }
  }

  #write(message) {
    if (!this.child.stdin.writable) return;
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  #handleLine(line) {
    const trimmed = String(line || "").trim();
    if (!trimmed) return;
    this.onLine(trimmed);
    let msg;
    try {
      msg = JSON.parse(trimmed);
    } catch {
      return;
    }

    if (msg.method) {
      if (msg.id != null) {
        this.#handleIncomingRequest(msg);
        return;
      }
      this.onNotification(msg.method, msg.params || {});
      return;
    }

    if (msg.id != null && this.pending.has(msg.id)) {
      const waiter = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) waiter.reject(formatAcpError(msg.error));
      else waiter.resolve(msg.result);
    }
  }

  async #handleIncomingRequest(msg) {
    try {
      const result = this.onRequest
        ? await this.onRequest(msg.method, msg.params || {}, msg.id)
        : defaultAcpRequestResult(msg.method);
      if (result !== undefined) this.respond(msg.id, result);
    } catch (error) {
      this.respondError(msg.id, error.message || error);
    }
  }

  #rejectAll(error) {
    for (const waiter of this.pending.values()) waiter.reject(error);
    this.pending.clear();
  }
}

export function formatAcpError(error) {
  if (!error) return new Error("ACP 错误");
  if (error instanceof Error) return error;
  const details =
    error.data?.message ||
    error.data?.details ||
    (typeof error.data === "string" ? error.data : "");
  const message = [error.message, details].filter(Boolean).join(": ");
  return new Error(message || JSON.stringify(error));
}

export function defaultAcpRequestResult(method) {
  if (method === "session/request_permission") {
    return { outcome: { outcome: "selected", optionId: "allow-always" } };
  }
  if (method === "cursor/ask_question") {
    return { outcome: { outcome: "skipped", reason: "headless worker" } };
  }
  if (method === "cursor/create_plan") {
    return { outcome: { outcome: "accepted" } };
  }
  return {};
}

export function acpPromptText(text) {
  return [{ type: "text", text: String(text || "") }];
}

export function updateText(update) {
  const content = update?.content;
  if (typeof content === "string") return content;
  if (content?.text) return content.text;
  return "";
}
