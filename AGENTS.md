# Agent playbook — cursor-codex-bridge

给 **AI agent** 读。人看 README；你（agent）只按本文执行。

用户如果说「装 cursor-codex-bridge / 让 Codex 指挥 Cursor」：克隆或 `git pull` 本仓库，把本文当唯一操作手册。

**禁止改用户原本的 Codex 配置。** 不要创建、编辑、删除、追加 `~/.codex/config.toml`、`~/.codex/hooks.json`、`~/.codex/skills/`、`~/.codex/AGENTS.md`，也不要指导用户把片段贴进这些文件。

本仓库本身就是一套**项目级 Codex 配置**：

| 层 | 路径 | 作用 |
|----|------|------|
| 项目指令 | 根目录 `AGENTS.md` | 打开本仓库时始终生效 |
| 项目 skill | `.agents/skills/cursor-worker/` | Codex 扫描仓库 `.agents/skills`；setup 还会写入 `[[skills.config]]` |
| 项目 MCP / hooks | `.codex/config.toml`、`.codex/hooks.json` | 工具和闸门；仅在本仓库被信任时加载 |
| run 数据 | `.codex/cursor-worker/` | 本机生成，gitignore |

MCP 不能写进 SKILL.md，必须走项目 `.codex/config.toml`。Codex 工作区开在本仓库；工人要改的业务代码用 `spawn_cursor` 的 `workspace` 传入。

仓库：https://github.com/yibai99927/cursor-codex-bridge （public）

---

## 0. 你是谁

安装完成后，**Codex 是指挥官，Cursor CLI 是工人**。

- 你若正在 **安装**：做完第 1–4 步，告诉用户必须把 Codex 工作区开在**本仓库**、信任本项目，然后完全退出 ChatGPT/Codex 再开**新会话**。
- 你若已经是装好桥的 **Codex**：不要自己大范围改业务代码；用 MCP 工具 `spawn_cursor` / `followup_cursor` / `wait_cursor`。规则见第 5 节。

---

## 1. 探测本机

记录并使用**绝对路径**（Windows 写入 TOML 时改成正斜杠，如 `C:/Users/YOU/...`）。

| 项 | macOS / Linux | 原生 Windows |
|----|----------------|--------------|
| 系统 | `uname` 非 NT | `process.platform === win32` 或 `$env:OS` |
| Node | `which node`（≥ 20） | `where.exe node` |
| Cursor CLI | `which agent` 或 `~/.local/bin/agent` | `%LocalAppData%\cursor-agent\cursor-agent.exe`；`agent status` |
| 本仓库 | 本文件所在目录，记为 `REPO` | 同左 |
| 项目 skill | `$REPO/.agents/skills/cursor-worker/` | 同左 |
| 项目 Codex 层 | `$REPO/.codex/` | 同左 |
| MCP 入口 | `$REPO/server.mjs` | 同左 |
| 根目录分隔 | `:` | `;`（禁止用 `:`，会拆坏 `C:`） |

先跑：

- `node -v`
- `agent status` 或 `cursor-agent status`（必须已登录）
- `test -f "$REPO/server.mjs"` / Windows: `Test-Path`

缺 Node、缺 CLI、未登录：停下来告诉用户，不要继续写任何配置。

---

## 2. 克隆（若还没有仓库）

```bash
git clone https://github.com/yibai99927/cursor-codex-bridge.git
cd cursor-codex-bridge
```

无需 `npm install`。已有克隆则 `git pull`。

---

## 3. 只生成本仓库 `.codex/`

在仓库根目录执行：

```bash
node scripts/setup-project.mjs
```

该脚本**只写入**：

- `.codex/config.toml`（本机 node / agent / 白名单的绝对路径，以及 `[[skills.config]]`，已 gitignore）
- `.codex/commander.lock`（若尚不存在）
- `.codex/cursor-worker/`（run 数据目录，已 gitignore）

不要改、也不要生成用户全局配置。已提交进仓库、setup 不会覆盖的有：

- `.agents/skills/cursor-worker/SKILL.md`
- `.codex/hooks.json`
- `.codex/commander.lock`（若已存在）

`CURSOR_WORKER_HOME` 默认是 `$REPO/.codex/cursor-worker`，不是用户家目录。

手工对照可用 `.codex/config.toml.example`。Unix 白名单用 `:`，Windows 用 `;`。不要把生成结果复制到 `~/.codex`。

Codex 只在**信任的项目**里加载项目级 `.codex/`。MCP 出现的前提是：Codex 当前工作区就是本仓库。工人要改的业务代码通过 `spawn_cursor` 的 `workspace` 传入，不必把 Codex 开到那个业务仓库。

---

## 4. 验收安装

1. `node scripts/test-paths.mjs` 必须通过。
2. 向用户复述：已写入本仓库 `.codex/config.toml` 的 `command`、`args`、`AGENT_BIN`、`CURSOR_WORKER_HOME`、`CURSOR_WORKER_ROOTS`。明确说**没有改 ~/.codex**。
3. 明确说：**把 Codex 工作区开在本仓库并信任它；完全退出 ChatGPT / Codex 桌面端（不是只关窗口），再开一个新会话。** 旧会话不会加载新 MCP。
4. 新会话应出现工具：`cursor_bridge_health`、`spawn_cursor`、`followup_cursor`、`wait_cursor`、`get_cursor_status`、`get_cursor_result`、`cancel_cursor`、`list_cursor_runs`。
5. 可选：`node scripts/smoke.mjs`（会打 Cursor，需已登录）。

不要在未征得用户同意时跑 `scripts/fanout10.mjs`（10 路、耗时长、耗额度）。

---

## 5. 装好之后：Codex 怎么当指挥官

调用 MCP `cursor_worker`，不要自己改业务文件。

1. 需要时先 `cursor_bridge_health`。
2. 把用户目标拆成互不依赖的子任务；每个 `prompt` 自包含：目标、文件范围、验收标准、禁止事项。
3. **并行**：每个子任务一次 `spawn_cursor`，不同 `task_name`，`workspace` 为绝对路径且落在 `CURSOR_WORKER_ROOTS` 内。同仓库并行优先 `worktree: true`，否则必须划开文件。不要因为已有 run 在跑就串行。
4. `spawn_cursor` 立刻返回。同时在跑的工人有上限（默认 4）。短任务 `wait_cursor`；长任务把 `max_seconds` 加大（默认上限 300，须小于 MCP `tool_timeout_sec`）。下一轮用户发言时，hook 会注入已完成工人摘要；Codex 仍不会在后台自己醒来。
5. `completed` 后你验收：`git diff`、跑测试。不要只信 `summary`。
6. 同一工人补刀：`followup_cursor`。无 session 的任务会被拒绝开工，以免无法续跑。
7. 向用户按 `task_name` 汇报。

Windows：`CURSOR_WORKER_ROOTS` 只用分号。

---

## 6. 不要做的事

- 不要改 `~/.codex` 下任何文件，不要把本仓库 `.codex/config.toml` 追加进用户全局配置。
- 不要 `git push --force`、不要改远程 git config。
- 不要把 `CURSOR_API_KEY` 或 `auth.json` 写进仓库。
- 不要用 Unix 冒号白名单配原生 Windows。
- 不要提交 `.codex/config.toml`、`.codex/cursor-worker/`（含本机路径和 run 数据）。

## 7. 仍然无法 100% 强制的部分

- ChatGPT 桌面端部分 `apply_patch` 路径可能绕过 PreToolUse（Codex 已知问题）。hook 是闸门，不是内核强制。
- Codex 不会在工人结束的瞬间自己开一轮；只能拉长 `wait_cursor`，或等用户下一句时注入摘要。
- `--resume` 仍依赖 CLI；我们强制要有 session 并写入 canary，但不能证明模型一定记得。
- 额度用尽只能等；并发上限只是减速门。
- 若用户家目录里还有旧的全局 `cursor_worker` MCP，那是历史残留；本项目不再维护它，也不去删它。
