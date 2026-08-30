# cursor-codex-bridge

让 Codex 当指挥官（规划 / 验收），Cursor CLI 当工人（改代码）。

可以**同时派出多个互相独立的 Cursor 子 agent**：每个 `spawn_cursor` 默认新建 session，互不排队。

## 并行 vs 续跑

| 场景 | 怎么做 |
|------|--------|
| 独立任务（可并行） | 多次 `spawn_cursor`，各带 `task_name`。各自 create-chat，`session_id` 不同。 |
| 同一会话多轮 | `followup_cursor` 传入上一轮 `run_id` 或 `session_id`。同一 session 同时只能跑一轮。 |

长任务：`spawn_cursor` 立刻返回 `run_id`，再用 `wait_cursor` / `get_cursor_status` 轮询。`list_cursor_runs` 并列显示多个 run。

## 本机已接好的位置

- MCP 服务器：本目录 `server.mjs`
- 运行记录：`~/.codex/cursor-worker/runs/`
- Codex 配置：`~/.codex/config.toml` 里的 `mcp_servers.cursor_worker`
- Codex skill：`~/.codex/skills/cursor-worker/SKILL.md`

改完配置后**完全退出并重启 Codex / ChatGPT 桌面端**，开一个新会话才会加载 MCP。

## 指挥官用法

1. `cursor_bridge_health` 确认 Cursor CLI 已登录
2. 拆成互相独立的子任务，**并行**多次 `spawn_cursor`（各写 `task_name`）
3. `list_cursor_runs` / `wait_cursor` 盯到 `completed`
4. 自己看 diff、跑测试，做验收
5. 要在**同一工人**上补刀：`followup_cursor`；新开一条线：再 `spawn_cursor`
6. 不要自己改业务代码
