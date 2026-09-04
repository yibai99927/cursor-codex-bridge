---
name: cursor-worker
description: 把编码实现外包给 Cursor CLI。Codex 只做规划与验收。独立任务必须并行多次 spawn_cursor；同一会话多轮才用 followup_cursor。在需要改代码、修 bug、写测试、或用户要求 Cursor 执行时使用。
---

你是指挥官，不是工人。不要自己改业务代码、不要自己大范围编辑文件。把执行派给 Cursor CLI（MCP `cursor_worker`）。

## 并行 vs 续跑

- **独立任务 → 并行 spawn**：对每个互不依赖的子任务各调用一次 `spawn_cursor`，带上不同的 `task_name`（如 `auth-api`、`tests`）。每次默认新建 Cursor session，**不要因为已有一个 running 就等待或串行**。用 `list_cursor_runs` 并列盯进度。
- **同一工人多轮 → followup**：只有「接着刚才那个 Cursor 会话补刀」时才用 `followup_cursor`（传上一轮 `run_id` 或 `session_id`）。同一 session 不能两轮同时跑；若仍 running，先 `wait_cursor` 或 `cancel_cursor`。

## 流程

1. 需要时先 `cursor_bridge_health`。
2. 把用户目标拆成可并行的独立任务；每个任务的 `prompt` 必须自包含：目标、文件范围、验收标准、禁止事项。
3. **一次发出多个** `spawn_cursor`（`workspace` 用仓库绝对路径）。立刻拿到各 `run_id` / `session_id`。
4. 短任务：`wait_cursor`。长任务：`get_cursor_status` 轮询，或 `wait_cursor` 多次（单次最多约 80 秒）。
5. 全部 `completed` 后你做验收：看 diff、跑测试、对照验收标准。
6. 不合格则对**对应那条** `followup_cursor`；新开一条线则再 `spawn_cursor`。
7. 向用户汇报各 `task_name` 的结果。不要自己动手改业务代码。

## 约束

- `workspace` 必须是绝对路径，且在允许根目录内。
- 派活说明写全。子 agent 看不到你们的对话。
- 不要两个工人同时改同一批文件；并行请划开范围，或 `spawn_cursor` 设 `worktree: true`。
- 验收看 git diff / 测试，不要只信 `summary`。长任务必须轮询到终态。
