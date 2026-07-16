# M0 提示词：协议连续性实验

执行 TASK_DAG 的 M0.1–M0.4，但每次只完成一个 task 并提交证据。

重点：

1. 固定两个仓库和 Codex CLI/App Server 的准确版本。
2. 构建一个只记录字段名、路径和 SSE 类型的脱敏代理。
3. 观察 Codex 实际调用的所有路径。
4. 用 fixture 或经授权的两个测试账号验证 A→B 连续请求。
5. 专门检查 `previous_response_id`、conversation/thread 标识、缓存键和历史恢复。
6. 在首个语义 SSE 前后分别注入故障。
7. 最终写 `state/architecture-decision.md`，不得边实验边写正式实现。

停止条件：

- 发现跨账号需要不可获得的服务器状态；
- 发现只能通过语义流中途重放才能继续；
- 无法在不记录秘密的情况下完成观测。
