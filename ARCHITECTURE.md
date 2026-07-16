# 架构设计与决策树

## 1. 首选架构：Path A — Provider Router

```text
┌──────────┐      ┌───────────┐      ┌────────────────┐
│ Browser  │ ───▶ │ codex-web │ ───▶ │ codex app-server│
└──────────┘      └───────────┘      └───────┬────────┘
                                              │ Responses API
                                      ┌───────▼────────┐
                                      │ account-router │
                                      │ 127.0.0.1:18317│
                                      └───┬────┬────┬──┘
                                          A    B    C
```

优点：

- 第一阶段无需修改 codex-web；
- 页面和 App Server thread 保持不变；
- 切换逻辑集中；
- 易于 mock、测试和 systemd 管理。

风险：

- 上游 response ID 或缓存可能绑定账号；
- Codex 可能依赖 `/responses/compact`、memory/search 等辅助路径；
- SSE 流中途故障不能任意重放。

## 2. 备选架构：Path B — App Server Pool

```text
Browser -> codex-web -> app-server multiplexer
                         ├─ app-server A (CODEX_HOME A)
                         ├─ app-server B (CODEX_HOME B)
                         └─ app-server C (CODEX_HOME C)
```

只在 M0 证明 Path A 无法保持会话连续性时采用。

Path B 必须解决：

- 每账号独立凭据和 `CODEX_HOME`；
- thread 映射；
- 工作区锁；
- thread transcript 导出/重放；
- 切换时 UI thread 与后台 thread 的映射；
- 多 App Server 资源占用。

## 3. 安全切换边界

定义请求状态：

```text
RECEIVED
  -> ROUTED
  -> UPSTREAM_HEADERS
  -> PREFLIGHT_EVENTS
  -> SEMANTIC_STREAM_STARTED
  -> COMPLETED
```

允许透明 failover：

- `RECEIVED`、`ROUTED`；
- 尚未向客户端发送任何语义 SSE 事件的 `UPSTREAM_HEADERS/PREFLIGHT_EVENTS`；
- 明确的连接失败、认证失败、额度不足、429、可重试 5xx。

禁止透明 failover：

- 已发送 `response.output_text.delta`；
- 已发送 reasoning delta；
- 已发送 function-call arguments；
- 已发送任何会改变下游状态解释的语义事件。

此时必须：

1. 结束流并返回可识别错误；
2. 记录“不可透明重放”；
3. 由上层开启新模型调用继续，而不是伪装成同一个流。

## 4. 路由键与粘性

路由器依次尝试从以下字段生成 `routing_session_id`：

1. 显式 `X-Codex-Router-Session`；
2. thread/conversation 标识；
3. `previous_response_id` 的本地映射；
4. request body 的稳定摘要；
5. 新 UUID。

默认按 turn 粘性，不按整个项目永久粘性。每次新 turn 可重新评分，但在同一流内不得换号。

## 5. 账号评分

建议评分：

```text
eligible(account) = enabled
                 && auth_valid
                 && now >= cooldown_until
                 && not circuit_open

score = min(five_hour_remaining_ratio, weekly_remaining_ratio)
      - recent_error_penalty
      - concurrency_penalty
      + operator_priority_bias
```

不要依赖单一“剩余额度百分比”。如果快照过期，先刷新或降低可信度。

## 6. 错误分类

统一错误枚举：

- `quota_exhausted`
- `rate_limited`
- `auth_expired`
- `account_disabled`
- `upstream_5xx`
- `network_error`
- `protocol_error`
- `client_cancelled`
- `unsafe_to_replay`
- `all_accounts_unavailable`

只有明确分类为可切换错误时才换账号。

## 7. 辅助接口

至少实现并验证：

- `POST /v1/responses`
- `POST /v1/responses/compact`
- `GET /v1/models`
- Codex 实测出现的 memory/search 路由
- 可选兼容无 `/v1`、双 `/v1/v1`、`/codex/v1` 的规范化输入

路由规范化必须有严格白名单，不能成为任意反向代理。

## 8. 管理面

管理接口与模型代理接口必须分离：

- 模型代理：loopback TCP 或 Unix socket；
- 管理 API：独立 token，默认 loopback；
- UI 只接收脱敏别名、状态、百分比和切换原因；
- 不返回凭据、Cookie 或完整上游响应。

## 9. 决策树

```text
M0: 两次连续 Responses 调用跨账号是否成功？
  ├─ 是，且 response state 可跨账号 -> GO_PATH_A
  ├─ 否，但请求含完整上下文，可在本地重放 -> GO_PATH_A_REHYDRATE
  ├─ 否，状态严格绑定账号 -> GO_PATH_B
  └─ 无法可靠恢复 -> LIMITED_MODE
```

`LIMITED_MODE` 的产品语义必须明确：换号后在同一页面创建新的后台 thread，并把先前 transcript 作为上下文摘要注入，不能声称“无缝恢复原会话”。
