# Agent playbook — cursor-codex-bridge

给 **AI agent** 读。人看 README；你（agent）只按本文执行。

用户如果说「装 cursor-codex-bridge / 让 Codex 指挥 Cursor」：克隆或 `git pull` 本仓库，把本文当唯一操作手册。不要覆盖用户已有的 `~/.codex/config.toml` 整文件，不要提交 API key。

仓库：https://github.com/yibai99927/cursor-codex-bridge （public）

---

## 0. 你是谁

安装完成后，**Codex 是指挥官，Cursor CLI 是工人**。

- 你若正在 **安装**：做完第 1–5 步，告诉用户必须完全退出 ChatGPT/Codex 再开**新会话**。
- 你若已经是装好桥的 **Codex**：不要自己大范围改业务代码；用 MCP 工具 `spawn_cursor` / `followup_cursor` / `wait_cursor`。规则见第 6 节。

---

## 1. 探测本机

记录并使用**绝对路径**（Windows 写入 TOML 时改成正斜杠，如 `C:/Users/YOU/...`）。

| 项 | macOS / Linux | 原生 Windows |
|----|----------------|--------------|
| 系统 | `uname` 非 NT | `process.platform === win32` 或 `$env:OS` |
| Node | `which node`（≥ 20） | `where.exe node` |
| Cursor CLI | `which agent` 或 `~/.local/bin/agent` | `%LocalAppData%\cursor-agent\cursor-agent.exe`；`agent status` |
| Codex 配置 | `~/.codex/config.toml` | `%USERPROFILE%\.codex\config.toml` |
| 本仓库 | 本文件所在目录，记为 `REPO` | 同左 |
| MCP 入口 | `$REPO/server.mjs` | 同左 |
| 根目录分隔 | `:` | `;`（禁止用 `:`，会拆坏 `C:`） |

先跑：

- `node -v`
- `agent status` 或 `cursor-agent status`（必须已登录）
- `test -f "$REPO/server.mjs"` / Windows: `Test-Path`

缺 Node、缺 CLI、未登录：停下来告诉用户，不要继续改 config。

---

## 2. 克隆（若还没有仓库）

```bash
git clone https://github.com/yibai99927/cursor-codex-bridge.git
cd cursor-codex-bridge
```

无需 `npm install`。已有克隆则 `git pull`。

---

## 3. 写入 MCP（追加，禁止整文件覆盖）

1. 若 `config.toml` 不存在：创建空文件再追加。
2. 若已有 `[mcp_servers.cursor_worker]`：只更新 `command` / `args` / `env` 里的绝对路径，不要删用户其它 MCP。
3. 若没有该段：把对应 snippet **追加到文件末尾**。

- Unix：以 `templates/config.toml.snippet` 为模板，填入真实 `node`、`server.mjs`、`AGENT_BIN`、`CURSOR_WORKER_ROOTS`（`:` 分隔，至少包含用户会改代码的目录）。
- Windows：以 `templates/config.toml.windows.snippet` 为模板，`CURSOR_WORKER_ROOTS` 用 `;`。

建议：

```
CURSOR_WORKER_HOME = <Codex 家目录>/cursor-worker
```

Unix 家目录 `~/.codex`，Windows `%USERPROFILE%/.codex`。

`tool_timeout_sec = 90` 即可。`spawn_cursor` 立即返回，长任务靠轮询。

---

## 4. 写入指挥官 skill 与可选 AGENTS 句

把本仓库的指挥官 skill 装到 **Codex 用户目录**（不是只放在本 git 仓库里）：

Unix:

```bash
mkdir -p ~/.codex/skills/cursor-worker
cp templates/cursor-worker.SKILL.md ~/.codex/skills/cursor-worker/SKILL.md
```

Windows PowerShell:

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.codex\skills\cursor-worker" | Out-Null
Copy-Item templates\cursor-worker.SKILL.md "$env:USERPROFILE\.codex\skills\cursor-worker\SKILL.md"
```

可选：若 `~/.codex/AGENTS.md`（Windows：`%USERPROFILE%\.codex\AGENTS.md`）里还没有 cursor-worker 句，**追加** `templates/AGENTS.md.snippet` 的内容，不要清空用户原有约定。

---

## 5. 验收安装

1. `node scripts/test-paths.mjs` 必须通过。
2. 向用户复述：已写入的 `command`、`args`、`AGENT_BIN`、`CURSOR_WORKER_ROOTS`。
3. 明确说：**完全退出 ChatGPT / Codex 桌面端（不是只关窗口），再开一个新会话。** 旧会话不会加载新 MCP。
4. 新会话应出现工具：`cursor_bridge_health`、`spawn_cursor`、`followup_cursor`、`wait_cursor`、`get_cursor_status`、`get_cursor_result`、`cancel_cursor`、`list_cursor_runs`。
5. 可选：`node scripts/smoke.mjs`（会打 Cursor，需已登录）。

不要在未征得用户同意时跑 `scripts/fanout10.mjs`（10 路、耗时长、耗额度）。

---

## 6. 装好之后：Codex 怎么当指挥官

调用 MCP `cursor_worker`，不要自己改业务文件。

1. 需要时先 `cursor_bridge_health`。
2. 把用户目标拆成互不依赖的子任务；每个 `prompt` 自包含：目标、文件范围、验收标准、禁止事项。
3. **并行**：每个子任务一次 `spawn_cursor`，不同 `task_name`，`workspace` 为绝对路径且落在 `CURSOR_WORKER_ROOTS` 内。同仓库并行优先 `worktree: true`，否则必须划开文件。不要因为已有 run 在跑就串行。
4. `spawn_cursor` 立刻返回 `run_id` / `session_id`。短任务 `wait_cursor`；长任务反复 `get_cursor_status` 或多次 `wait_cursor`（单次最多约 80 秒）。没有「做完自动喊你」。
5. `completed` 后你验收：`git diff`、跑测试。不要只信工具返回的 `summary`。
6. 同一工人补刀：`followup_cursor`（上一轮必须结束）。新开一条线：再 `spawn_cursor`。
7. 向用户按 `task_name` 汇报。

Windows：`CURSOR_WORKER_ROOTS` 只用分号。

---

## 7. 不要做的事

- 不要 `git push --force`、不要改远程 git config。
- 不要把 `CURSOR_API_KEY` 或 `auth.json` 写进仓库。
- 不要用 Unix 冒号白名单配原生 Windows。
- 不要在安装时删除用户已有的 `[mcp_servers.*]` 其它块。

## 8. 修不掉、只能规避的限制

- Cursor 账号限流：工人会变慢或失败；桥会对短时 429/断线重试一次，仍失败就换时间或减并发。
- `--resume` + `-p` 非官方保证：CLI 大版本后重跑 `node scripts/fanout10.mjs`。
- Codex 旧会话不加载新 MCP：必须完全退出再开新会话。
- Skill 不能硬拦截 Codex 自己改代码：靠本文件 + 用户口头约定。
