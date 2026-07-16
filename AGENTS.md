# AGENTS.md

本文件是交给 Codex 的执行约束。

## 工作方式

- 一次只领取 `TASK_DAG.yaml` 中一个状态为 `ready` 的任务。
- 开始任务前记录：仓库、分支、commit SHA、依赖任务和预期输出。
- 先做最小实验，再写生产实现。
- 每个任务必须输出测试证据；没有证据不得标记 `done`。
- 遇到协议、许可、账号状态或平台行为不明确时，写 blocker 报告，不得用猜测填补。
- 保持 `codex-web` 上游可合并性：优先小型适配层，避免大范围重写。

## 禁止事项

- 不得提交任何真实 token、Cookie、refresh token、Authorization header、账号邮箱或完整配额响应。
- 不得自动注册账号、规避 CAPTCHA、规避封禁或隐藏平台限制。
- 不得把端口直接绑定到公网；默认只能监听 `127.0.0.1` 或 Unix socket。
- 不得在已向客户端发送语义 SSE 事件后，静默把同一请求重放到另一账号。
- 不得把“进程可重启”描述为“正在运行的计算可原地恢复”。
- 未确认授权前，不得从 `meitianwang/CodexManager` 复制受版权保护的实现到新仓库。

## 许可模式

在 `state/implementation-mode.txt` 中只允许写一个值：

- `authorized-fork`：用户确认有权修改和部署 CodexManager 代码；
- `clean-room`：仅使用公开行为、协议观察和独立测试重新实现，不复制其代码。

默认使用 `clean-room`。

## 分支与提交

推荐：

- `spike/m0-protocol-continuity`
- `feat/headless-router-core`
- `feat/quota-scheduler`
- `feat/responses-failover`
- `feat/codex-web-account-status`
- `ops/linux-systemd`
- `test/soak-hardening`

每个提交必须：

- 单一目的；
- 可独立测试；
- 不含秘密；
- 在提交说明中列出测试命令。

## 状态文件

更新 `state/task-status.json`。状态只允许：

- `pending`
- `ready`
- `in_progress`
- `blocked`
- `done`
- `rejected`

完成时记录：

- 输入 commit；
- 输出 commit；
- 测试命令；
- 测试结果；
- 证据文件；
- 遗留风险。

## 验证规则

- 单元测试不能替代协议集成测试。
- Mock 上游测试不能替代至少一次经用户授权的真实账号 E2E。
- 真实账号 E2E 只验证必要路径，所有日志必须脱敏。
- 任何自动 failover 都必须测试“尚未输出 SSE”和“已输出 SSE”两种故障点。
- 所有重试必须有上限、退避和总截止时间。
