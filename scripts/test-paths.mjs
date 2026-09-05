#!/usr/bin/env node
import { existsSync } from "node:fs";
import path from "node:path";
import {
  BRIDGE_DIR,
  commanderLockPath,
  cursorTransport,
  DEFAULT_CURSOR_MODEL,
  defaultBackend,
  defaultCursorModel,
  resolveCursorModel,
  homeDir,
  isPathInsideRoot,
  normalizeBackend,
  projectCodexDir,
  rootDelimiter,
  splitRootList,
} from "../lib.mjs";

function assert(cond, message) {
  if (!cond) throw new Error(message);
}

assert(rootDelimiter("win32") === ";", "win32 delimiter");
assert(rootDelimiter("darwin") === ":", "posix delimiter");

const winRoots = splitRootList("C:\\Users\\a;D:\\work", "win32");
assert(winRoots.length === 2, "win32 split count");
assert(winRoots[0] === "C:\\Users\\a", "win32 first root");
assert(winRoots[1] === "D:\\work", "win32 second root");

const posixRoots = splitRootList("/Users/a/开发:/Users/a/Documents", "darwin");
assert(posixRoots.length === 2, "posix split count");

const { win32, posix } = path;
assert(
  isPathInsideRoot("C:\\Users\\a\\proj", "C:\\Users\\a", win32),
  "win32 child"
);
assert(
  isPathInsideRoot("c:\\users\\a\\proj\\src", "C:\\Users\\a", win32),
  "win32 case"
);
assert(
  isPathInsideRoot("C:\\Users\\a", "C:\\Users\\a", win32),
  "win32 same path"
);
assert(
  !isPathInsideRoot("D:\\other", "C:\\Users\\a", win32),
  "win32 other drive"
);
assert(
  !isPathInsideRoot("C:\\Users\\ab", "C:\\Users\\a", win32),
  "win32 prefix not a child"
);
assert(isPathInsideRoot("/Users/a/开发/app", "/Users/a/开发", posix), "posix child");
assert(!isPathInsideRoot("/tmp/x", "/Users/a/开发", posix), "posix outside");

assert(
  isPathInsideRoot(homeDir(), projectCodexDir()),
  "run data stays in project .codex"
);
assert(
  isPathInsideRoot(commanderLockPath(), projectCodexDir()),
  "commander lock stays in project .codex"
);
assert(
  isPathInsideRoot(projectCodexDir(), BRIDGE_DIR),
  "project Codex dir is inside the repo"
);
assert(
  existsSync(path.join(BRIDGE_DIR, ".agents", "skills", "cursor-worker", "SKILL.md")),
  "project skill lives in .agents/skills"
);
assert(normalizeBackend("agy") === "agy", "backend agy");
assert(normalizeBackend("ANTIGRAVITY") === "agy", "backend antigravity");
assert(defaultBackend() === "cursor" || defaultBackend() === "agy", "default backend");
assert(["acp", "print"].includes(cursorTransport()), "cursor transport");
assert(DEFAULT_CURSOR_MODEL === "cursor-grok-4.6-xhigh-fast", "default grok slug");
assert(defaultCursorModel() === "cursor-grok-4.6-xhigh-fast", "default cursor model");
assert(resolveCursorModel("") === "cursor-grok-4.6-xhigh-fast", "empty model falls back");
assert(resolveCursorModel("composer-2.5-fast") === "composer-2.5-fast", "explicit model wins");

console.log("path tests ok");
