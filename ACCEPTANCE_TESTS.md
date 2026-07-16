# 验收测试矩阵

## A. 协议基线

| ID | 场景 | 期望 |
|---|---|---|
| A01 | `GET /v1/models` | 返回兼容模型列表或明确受支持的固定列表 |
| A02 | 非流式 `/v1/responses` | 状态、body、headers 正确透传 |
| A03 | 流式 `/v1/responses` | SSE 顺序、结束事件和取消传播正确 |
| A04 | `/v1/responses/compact` | 与实测 Codex 调用兼容 |
| A05 | 未授权路径 | 404/405，绝不任意代理 |
| A06 | 50MB 以上 body | 按配置拒绝，不耗尽内存 |

## B. 自动切换

| ID | 故障点 | 期望 |
|---|---|---|
| B01 | 请求发送前账号已耗尽 | 选择下一健康账号 |
| B02 | 上游连接失败且无 SSE | 安全换号，最多 N 次 |
| B03 | 上游 429 且无语义 SSE | 冷却原账号并换号 |
| B04 | auth 失败且无语义 SSE | 标记 auth_expired 并换号 |
| B05 | 已输出文本 delta 后 429 | 不透明重放；返回 `unsafe_to_replay` |
| B06 | 已输出 function call arguments 后失败 | 不重放 |
| B07 | 全部账号不可用 | 立即返回 `all_accounts_unavailable`，无死循环 |
| B08 | Retry-After 很长 | 尊重上限策略并选择其他账号 |

## C. 会话连续性

| ID | 场景 | 期望 |
|---|---|---|
| C01 | A 上第一轮、A 上第二轮 | 控制组通过 |
| C02 | A 上第一轮、B 上第二轮 | 按 M0 选定架构通过 |
| C03 | 带 `previous_response_id` 换号 | 成功、重放或明确失败，不得假成功 |
| C04 | router 重启后继续 thread | 映射恢复或按文档降级 |
| C05 | app-server 重启后 resume | 历史 thread 可恢复或限制明确 |
| C06 | codex-web 重启 | 后端任务不因前端重启被无条件终止 |

## D. 并发

| ID | 场景 | 期望 |
|---|---|---|
| D01 | 两个 thread 同时请求 | 不互相覆盖路由状态 |
| D02 | 同一 thread 并发两请求 | 按策略串行或明确支持 |
| D03 | 账号并发上限 | 调度器避开已满账号 |
| D04 | 切换同时手动禁用账号 | 原子状态更新，无悬挂映射 |

## E. 安全

| ID | 场景 | 期望 |
|---|---|---|
| E01 | 日志扫描 token 模式 | 0 命中 |
| E02 | 管理 API 无 token | 401/403 |
| E03 | 模型 API token 访问管理 API | 被拒绝 |
| E04 | Host/URL 注入 | 不能改变上游目标 |
| E05 | 路径穿越 | 被拒绝 |
| E06 | 请求头回显 | 不回显 Authorization/Cookie |
| E07 | crash dump | 不包含 credential object |

## F. 运行可靠性

| ID | 场景 | 期望 |
|---|---|---|
| F01 | router SIGTERM | 优雅停止，不接受新请求，等待活动请求截止 |
| F02 | router 崩溃 | systemd 重启，状态恢复 |
| F03 | app-server 崩溃 | router 独立存活，codex-web 报告明确 |
| F04 | codex-web 崩溃 | router/app-server 独立存活 |
| F05 | 24 小时混合负载 | 无无限重试、FD 泄露、无界 RSS 增长 |
| F06 | 磁盘写满 | 状态持久化失败显式报告，不损坏旧状态 |

## 真实账号 E2E 注意

真实账号测试必须：

- 经用户授权；
- 使用专用测试 workspace；
- 不提交任何 auth 文件；
- 日志仅保留账号别名；
- 测试完成后轮换临时管理密钥。
