# Mock 上游说明

实现一个可脚本化的 fixture server：

- 支持 HTTP 和 SSE；
- 可按账号 alias、请求序号和 routing session 返回不同故障；
- 可在任意 SSE 事件后断开；
- 记录脱敏的请求字段名和事件时间；
- 支持虚拟时钟测试 cooldown；
- 不需要真实 OpenAI 凭据。

所有 failover 单元和集成测试先使用 mock。真实账号测试只作为受控 E2E 闸门。
