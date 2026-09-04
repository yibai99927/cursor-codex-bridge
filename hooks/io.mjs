import { stdin, stdout } from "node:process";

export async function readStdinJson() {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

export function emit(payload) {
  stdout.write(JSON.stringify(payload));
}
