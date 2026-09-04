# cursor-codex-bridge

**Agent：克隆或 `git pull` 后只读根目录 `AGENTS.md`，按其中步骤安装和使用。** 人类读本文。`llms.txt` 只指向 `AGENTS.md`。

让 **Codex 当指挥官**（拆任务、规划、验收），**Cursor CLI 当工人**（改代码）。

本仓库是一个本地 MCP 服务器：Codex 调用带 schema 的工具，服务器在后台拉起 `agent -p`。任务可以很长，也可以同一会话多轮续跑；互不依赖的模块可以同时派出多个独立 Cursor 子 agent。

已在本机验证：10 个模块并行实现 + 每路 `followup` 续跑，10 个 `session_id` 互不相同，对话暗号全部对上。macOS / Linux / **原生 Windows** 用同一套代码；Windows 必须用分号白名单和 `cursor-agent.exe`，见下方「原生 Windows」。

## 给 AI 的摘要（先读这里）

安装与逐步操作以根目录 **`AGENTS.md` 为准**（拉取仓库后从那一份执行）。下面是装好之后的指挥官约定。

你是指挥官，不是工人。

- 需要改代码、修 bug、写测试时：调用 MCP 工具 `spawn_cursor`，**不要自己大范围改业务文件**。
- 互不依赖的子任务：**并行多次** `spawn_cursor`，各写不同 `task_name`。每次默认新建 Cursor session，不要因为已有 run 在跑就串行等待。
- 同一工人补刀：等上一轮结束后 `followup_cursor`（传 `run_id` 或 `session_id`）。同一 session 同时只能跑一轮。
- `spawn_cursor` 立刻返回 `{ run_id, session_id, status }`。长任务用 `wait_cursor` / `get_cursor_status` 轮询到 `completed`，再自己看 diff、跑测试做验收。
- `prompt` 必须自包含：目标、文件范围、验收标准、禁止事项。子 agent 看不到 Codex 对话。
- `workspace` 必须是绝对路径，且落在 `CURSOR_WORKER_ROOTS` 内。Windows 上多个根目录用分号 `;` 分隔，不要用冒号。
- 并行任务必须划开文件范围，避免抢同一批文件。

完整指挥官约定见 `templates/cursor-worker.SKILL.md`。

## 角色怎么分工

| 角色 | 谁 | 做什么 |
|------|----|--------|
| 指挥官 | Codex（ChatGPT 桌面端 / Codex CLI） | 拆模块、写派活说明、轮询、看 diff / 跑测试、决定续跑或收工 |
| 工人 | Cursor CLI（`agent` / `cursor-agent`） | 在指定 workspace 里改代码 |
| 桥 | 本仓库 `server.mjs` | 校验路径、建 session、异步拉起 CLI、记录 run |

```
你 ↔ Codex
      │  MCP（spawn / wait / followup / list）
      ▼
 server.mjs（长期活着）
      │  后台进程
      ▼
 Cursor CLI  agent -p --force --trust --resume <session>
```

## 前置条件

1. **Node.js** ≥ 20。记下绝对路径：macOS/Linux 用 `which node`，Windows 用 `where.exe node`。
2. **Cursor CLI** 已安装并登录：

   macOS / Linux：

   ```bash
   curl https://cursor.com/install -fsS | bash
   agent status
   ```

   常见路径：`~/.local/bin/agent`（与 `cursor-agent` 同一二进制）。

   原生 Windows（PowerShell）：

   ```powershell
   irm 'https://cursor.com/install?win32=true' | iex
   agent status
   ```

   常见路径：`%LocalAppData%\cursor-agent\cursor-agent.exe`。
3. **Codex** 已安装（ChatGPT 桌面端或 Codex CLI）。配置：macOS/Linux 为 `~/.codex/config.toml`，Windows 为 `%USERPROFILE%\.codex\config.toml`。
4. 工人要能联网访问 Cursor API（本机已登录即可；脚本环境也可设 `CURSOR_API_KEY`，不要把密钥写进仓库）。

## 搭建（给人或 AI 逐步做）

把示例里的绝对路径换成你机器上的真实路径。TOML 里 Windows 路径请用正斜杠，例如 `C:/Users/YOU/...`。

### 1. 克隆本仓库

```bash
git clone git@github.com:<owner>/cursor-codex-bridge.git
cd cursor-codex-bridge
```

无需 `npm install`。MCP 是零依赖的 `server.mjs`。

### 2. 写入 Codex MCP

把对应片段 **追加**到 Codex 的 `config.toml`，不要整文件覆盖。

| 系统 | 片段 | 根目录分隔符 |
|------|------|----------------|
| macOS / Linux | `templates/config.toml.snippet` | `:` |
| 原生 Windows | `templates/config.toml.windows.snippet` | `;`（不能用 `:`，会和盘符 `C:` 冲突） |

至少改：`command`（node 绝对路径）、`args`（本仓库 `server.mjs`）、`CURSOR_WORKER_ROOTS`。`AGENT_BIN` 用 `which agent` 或 `where.exe cursor-agent`。未设置 `AGENT_BIN` 时，桥会在 Unix 的 `~/.local/bin/agent` 和 Windows 的 `%LocalAppData%\cursor-agent\cursor-agent.exe` 里自动找。

`tool_timeout_sec = 90` 只约束「一次 MCP 调用」。`spawn_cursor` 会马上返回，长任务靠轮询，不必把这项调成十几分钟。

### 3. 写入指挥官 skill

macOS / Linux：

```bash
mkdir -p ~/.codex/skills/cursor-worker
cp templates/cursor-worker.SKILL.md ~/.codex/skills/cursor-worker/SKILL.md
```

原生 Windows（PowerShell）：

```powershell
New-Item -ItemType Directory -Force "$env:USERPROFILE\.codex\skills\cursor-worker" | Out-Null
Copy-Item templates\cursor-worker.SKILL.md "$env:USERPROFILE\.codex\skills\cursor-worker\SKILL.md"
```

可选：把 `templates/AGENTS.md.snippet` 追加进 `~/.codex/AGENTS.md`（Windows 为 `%USERPROFILE%\.codex\AGENTS.md`）。

### 4. 重启 Codex

**完全退出** ChatGPT / Codex 桌面端再打开（不是只关窗口），然后开一个**新会话**。旧会话不会加载新 MCP。

新对话里应能看到工具：`spawn_cursor`、`followup_cursor`、`wait_cursor`、`get_cursor_status`、`get_cursor_result`、`cancel_cursor`、`list_cursor_runs`、`cursor_bridge_health`。

可以说：「用 cursor-worker，并行派两个独立任务给 Cursor」。

## 工具一览

| 工具 | 作用 |
|------|------|
| `cursor_bridge_health` | 查 CLI 是否登录、允许的 workspace 根目录 |
| `spawn_cursor` | 新建独立 session，后台开工，立刻返回 `run_id` |
| `followup_cursor` | 同一 session 再跑一轮（上一轮必须已结束） |
| `get_cursor_status` | 廉价看进度 |
| `wait_cursor` | 等到结束或 `max_seconds`（默认 45，上限 80） |
| `get_cursor_result` | 读终态；若仍在跑则返回当前进度，不假装完成 |
| `cancel_cursor` | 杀掉还在跑的任务 |
| `list_cursor_runs` | 并列最近若干 run（含 `task_name`） |

`spawn_cursor` 常用参数：`prompt`、`workspace`（必填），`task_name`、`mode`（`agent` / `ask` / `plan`）、`model`、`sandbox`、`approve_mcps`。

## 并行与续跑

| 场景 | 做法 |
|------|------|
| 大任务拆成独立模块 | 一次发出多个 `spawn_cursor`，各带 `task_name` |
| 某个模块还要改 | 对该 `run_id` 做 `followup_cursor` |
| 新开一条线 | 再 `spawn_cursor`，不要复用别人的 session |

同一 session 上若上一轮还在 `running`，`followup_cursor` 会报错，先 `wait_cursor` 或 `cancel_cursor`。

## 本机自检

```bash
node scripts/test-paths.mjs   # 不联网，检查 Windows/Unix 路径逻辑
node scripts/smoke.mjs        # 双工人并行（ask，不改文件）
node scripts/fanout10.mjs     # 10 模块并行 + 续跑（耗时约数分钟）
```

`fanout10` 在仓库内写 `.tmp-mega-app/`（已 gitignore）。

## 运行时数据

| 路径 | 内容 |
|------|------|
| `$CURSOR_WORKER_HOME/runs/<run_id>/meta.json` | 状态、session、prompt |
| `events.ndjson` | Cursor CLI 的 stream-json |
| `exit.json` | 进程退出码 |

不要把这些目录提交到 git，也不要提交 `CURSOR_API_KEY`。

## 环境变量

| 变量 | 默认 | 含义 |
|------|------|------|
| `AGENT_BIN` | Unix：`~/.local/bin/agent`；Windows：`%LocalAppData%\cursor-agent\cursor-agent.exe` | Cursor CLI |
| `CURSOR_WORKER_HOME` | `~/.codex/cursor-worker` | run 数据根目录 |
| `CURSOR_WORKER_ROOTS` | 用户主目录 + Documents（Windows 另加 Desktop） | 白名单。Unix 用 `:`，Windows 用 `;` |
| `CURSOR_API_KEY` | （可选） | 无交互登录时用；已 `agent login` 则可省略 |

## 已知边界

- Codex 侧没有「子任务完成自动插回对话」的 hook，长任务要指挥官轮询。
- 10 路同时跑时，Cursor 侧可能自己排队，总时间短于「单路 × 10」，但不是完美线性。
- `--resume` + `-p` 在当前 Cursor CLI（2026.08.25）上能保住对话；CLI 大版本升级后应再跑 `fanout10`。
- 桥只包装本地 CLI，不是 Cursor 官方产品。
- 原生 Windows 已适配路径白名单、CLI 定位和 `taskkill`；桌面端仍须完全退出后再开新会话。WSL 可按 Linux 小节配置。

## 仓库里有什么

```
AGENTS.md                  给 agent 的安装+使用说明书（拉取后先读这个）
llms.txt                   指向 AGENTS.md
server.mjs                 MCP（stdio JSON-RPC，零依赖）
run-job.mjs                后台拉起 agent
lib.mjs                    路径校验、事件摘要、run 状态
templates/                 给 Codex 复制的配置 / skill（含 Windows 片段）
scripts/test-paths.mjs     路径白名单单测（含 win32）
scripts/smoke.mjs          双路冒烟
scripts/fanout10.mjs       10 路并发 + 续跑
```
