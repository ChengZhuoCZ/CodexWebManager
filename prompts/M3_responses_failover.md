# M3 提示词：Responses/SSE 安全切换

实现严格白名单代理、backpressure、取消传播和 failover 状态机。

硬规则：任何 `response.output_text.delta`、reasoning delta 或 function-call arguments 一旦发送给客户端，就不得把同一请求透明重放到另一账号。

使用 test-fixtures/mock_scenarios.yaml 覆盖全部故障点。随后运行受控 Codex App Server E2E。
