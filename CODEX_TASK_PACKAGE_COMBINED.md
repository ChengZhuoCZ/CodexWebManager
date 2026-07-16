# Codex Web Auto Account Switch — Combined Task Package


---

# FILE: START_HERE.md

# Codex Web 多账号额度自动切换：Codex 开发任务包

生成日期：2026-07-15

## 目标

在 Linux 服务器上长期运行 `codex-web`，浏览器始终停留在同一个页面；当当前 Codex/ChatGPT 账号触发明确的额度不足、限流或认证失效时，后台在安全边界自动选择另一个由用户合法控制的账号，并让任务尽可能继续。

## 基线仓库

- `https://github.com/0xcaff/codex-web`
  - 审计基线：`888692f7d885118c6a92bbaf60cf2121f5947adf`
- `https://github.com/meitianwang/CodexManager`
  - 审计基线：`9f9a67df44354da37a8b4ba2bb423a75473b56b6`
  - 相关历史提交：`213e848097ee93cd8f24c7b0892400eb995300b6`

开始开发前必须重新记录实际 checkout 的 commit SHA；上面仅用于复现本任务包形成时的代码状态。

## 首选最小架构

不要先合并两个 Web UI。优先实现：

```text
Browser
  -> codex-web
  -> codex app-server
  -> headless account router (127.0.0.1:18317)
  -> Account A / Account B / Account C
```

第一阶段应当力争做到 **不修改 codex-web 也能完成自动路由**。只有后端路径通过后，才添加账号状态、切换事件和手动控制 UI。

## 首个硬性闸门

在写正式功能前，必须证明以下命题之一：

1. 单个 Codex App Server 通过 `/v1/responses` 代理时，连续请求可以安全地跨账号执行；或
2. 请求包含足够的本地上下文，可由路由器在换号时进行无状态重放；或
3. 必须采用“每账号独立 App Server + 会话迁移”的备选架构。

尤其要检测 `previous_response_id`、会话 ID、缓存键和上游 response ID 是否绑定原账号。

**未经 M0 实验，不得宣称可以无缝换号。**

## 执行顺序

1. 阅读 `AGENTS.md`。
2. 阅读 `PROJECT_CHARTER.md`、`ARCHITECTURE.md`、`LICENSE_BOUNDARY.md`。
3. 执行 `prompts/M0_spike.md`。
4. 只有 `state/architecture-decision.md` 给出 `GO_PATH_A` 或 `GO_PATH_B` 后，才能进入实现阶段。
5. 每完成一个任务，更新 `state/task-status.json` 和证据目录。

## 完成定义

项目只有在以下条件全部满足时才算完成：

- Linux 无图形界面环境可安装并由 systemd 运行；
- 同一浏览器页面无需重新登录即可看到自动切换事件；
- 切换只发生在定义清楚的安全边界；
- 真实 `429`/quota/auth 失败有可复核分类；
- 不记录访问令牌、刷新令牌、Cookie、完整 Authorization；
- 所有账号耗尽时停止重试并明确报告；
- 24 小时 soak test 无未处理崩溃、无限重试和不可控内存增长；
- 有安装、升级、回滚、备份和故障恢复文档。


---

# FILE: AGENTS.md

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


---

# FILE: PROJECT_CHARTER.md

# 项目章程

## 1. 原始需求

用户希望在 Linux 服务器上 7×24 小时运行 `codex-web`，在同一个浏览器页面持续使用 Codex；当前账号额度不足时自动切换至另一合法账号。

## 2. 第一性原理拆解

该需求包含四个彼此独立的问题：

1. **前端连续性**：浏览器页面、工作区和可见 thread 不因换号而消失。
2. **模型请求连续性**：模型请求在账号切换后仍能获得足够上下文。
3. **工具副作用安全**：换号和重试不能导致 shell、文件修改、提交等副作用被重复执行。
4. **运行可靠性**：Linux 守护、崩溃恢复、凭据保护和状态观测。

把两个 UI 合并并不能自动解决第 2、3 项，因此不是首要任务。

## 3. MVP

MVP 必须实现：

- 一个无头 account router；
- 多账号健康状态与配额快照；
- 安全的账号选择、冷却和熔断；
- `/v1/responses` 与 Codex 实际需要的辅助路由；
- 同一个 `codex-web` 页面继续工作；
- 切换事件可被日志或管理 API 观察；
- systemd 部署；
- 全部账号不可用时明确停止。

MVP 不要求：

- 把完整 CodexManager UI 嵌入 codex-web；
- 在已经输出 token 的单个 SSE 流中无缝换号；
- 多租户 SaaS；
- 公网直接访问；
- 自动创建或购买账号；
- 绕过服务政策或技术限制。

## 4. 可选增强

后续可以增加：

- codex-web 顶栏账号状态；
- 手动“下一账号”按钮；
- 每 thread 粘性路由策略；
- 管理页面；
- WebSocket/SSE 状态推送；
- 使用统计与告警；
- 多服务器高可用。

## 5. 成功指标

- 自动切换成功率：对“请求开始前或首个语义事件前”的可切换错误 ≥ 99%。
- 错误分类：quota、rate-limit、auth、network、upstream-5xx、protocol 各自可区分。
- 重试风暴：0 次无限循环。
- 秘密泄露：测试日志和默认日志中 0 个凭据字段。
- 服务恢复：router/codex-web 单进程重启后健康检查恢复。
- 24 小时测试：无崩溃；RSS 无持续无界增长；请求队列可清空。

## 6. 关键假设

- 所有账号由用户合法控制并允许用于该用途。
- 账号路由仅用于正常的容错和容量管理，不用于规避封禁或政策限制。
- `codex-web` 继续作为唯一用户界面。
- 首选在模型 provider/HTTP proxy 层切换账号；只有 M0 证明不可行时才切换 App Server。


---

# FILE: LICENSE_BOUNDARY.md

# 许可与代码边界

## 已观察到的仓库状态

- `0xcaff/codex-web` 的 package metadata 声明 MIT。
- `meitianwang/CodexManager` 的 desktop package 声明 `UNLICENSED`、`private: true`，README 标注 `Private - All Rights Reserved`。

## 默认规则

除非用户能够确认获得作者授权，否则：

- 可以把 CodexManager 当作行为和协议兼容性参考；
- 可以运行用户有权运行的二进制进行黑盒测试；
- 可以独立实现相同的公开 HTTP 协议；
- 不得复制、改写后搬运或重新发布其源代码；
- 不得把其品牌、图标和资源放入新项目。

## 两种实现路径

### authorized-fork

条件：用户书面确认有权修改、部署和派生 CodexManager。

做法：

- 在私有 fork 内抽取 headless runtime；
- 保留版权和许可提示；
- 不跨仓库复制超出授权范围的代码。

### clean-room

默认路径。

做法：

- 根据本任务包的接口契约独立实现；
- 用 mock 和黑盒测试验证行为；
- 不阅读或复制受限实现的具体函数体；
- 记录设计来源为公开 README、协议规范和实验结果。

## 发布前闸门

发布、分发或开源之前，必须由项目所有者确认许可结论。Codex 不得自行推断“公开 GitHub 仓库等于开源许可”。


---

# FILE: ARCHITECTURE.md

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


---

# FILE: TASK_DAG.yaml

version: 1
project: codex-web-auto-account-switch
implementation_mode_default: clean-room
states: [pending, ready, in_progress, blocked, done, rejected]

hard_gates:
  - id: G-LICENSE
    condition: state/implementation-mode.txt exists and is authorized-fork or clean-room
  - id: G-PROTOCOL
    condition: state/architecture-decision.md contains GO_PATH_A, GO_PATH_A_REHYDRATE, GO_PATH_B, or LIMITED_MODE
  - id: G-SECRETS
    condition: secret scanning and log-redaction tests pass

milestones:
  - id: M0
    name: Baseline and protocol continuity spike
    tasks:
      - id: M0.1
        title: Pin repositories and reproduce baseline
        status: ready
        depends_on: []
        outputs:
          - evidence/M0.1-baseline.md
          - state/repositories.json
        acceptance:
          - Record exact SHAs and build commands
          - Run existing typecheck/tests where available
          - Do not change production behavior
      - id: M0.2
        title: Capture Codex proxy protocol
        status: pending
        depends_on: [M0.1]
        outputs:
          - evidence/M0.2-protocol-redacted.jsonl
          - evidence/M0.2-endpoints.md
        acceptance:
          - Capture request paths, method, safe headers, body field names and SSE event types
          - Redact all credentials and user content unless fixture-generated
          - Identify responses, compact, models, memory and search calls
      - id: M0.3
        title: Test cross-account continuity
        status: pending
        depends_on: [M0.2]
        outputs:
          - evidence/M0.3-continuity-matrix.md
        acceptance:
          - Test A->A control and A->B switch between model calls
          - Test with previous_response_id present and absent
          - Test router restart and thread resume
          - Test failure before and after first semantic SSE event
      - id: M0.4
        title: Select architecture
        status: pending
        depends_on: [M0.3]
        outputs:
          - state/architecture-decision.md
        acceptance:
          - Select exactly one supported architecture mode
          - List observed facts, rejected alternatives and residual risks
          - Stop project if no safe continuation semantics exist

  - id: M1
    name: Headless router foundation
    tasks:
      - id: M1.1
        title: Create headless service package
        status: pending
        depends_on: [M0.4, G-LICENSE, G-PROTOCOL]
        outputs:
          - packages/account-router/
        acceptance:
          - Runs on Node.js 22+ without Electron, X11, Wayland or desktop keychain dependency
          - Starts with no accounts and exposes health/readiness
          - Binds to loopback by default
      - id: M1.2
        title: Define account and secret providers
        status: pending
        depends_on: [M1.1]
        acceptance:
          - Public account metadata separated from credentials
          - Pluggable secret backend
          - File permissions and redaction tests pass
      - id: M1.3
        title: Implement admin and event API
        status: pending
        depends_on: [M1.1]
        acceptance:
          - Status, account aliases, current route and switch events available
          - Admin auth separate from model proxy auth
          - No secret-bearing response fields

  - id: M2
    name: Quota scheduler and account state machine
    tasks:
      - id: M2.1
        title: Implement quota snapshot adapter
        status: pending
        depends_on: [M1.2]
        acceptance:
          - Supports 5-hour and weekly windows
          - Stores observed_at and confidence/staleness
          - Handles unavailable quota data without guessing zero or full
      - id: M2.2
        title: Implement deterministic scheduler
        status: pending
        depends_on: [M2.1]
        acceptance:
          - Deterministic selection for equal inputs
          - Priority, remaining quota, cooldown and concurrency represented
          - Unit tests include all-exhausted and stale-data cases
      - id: M2.3
        title: Implement cooldown and circuit breaker
        status: pending
        depends_on: [M2.2]
        acceptance:
          - Distinct cooldowns for quota, auth, 429, network and 5xx
          - Half-open probing is bounded
          - State persists across router restart
      - id: M2.4
        title: Implement session stickiness
        status: pending
        depends_on: [M0.4, M2.2]
        acceptance:
          - No account switch within an active semantic stream
          - Routing session mapping has TTL and bounded storage
          - Architecture-specific continuity behavior documented

  - id: M3
    name: Responses proxy and safe failover
    tasks:
      - id: M3.1
        title: Implement strict proxy path normalization
        status: pending
        depends_on: [M1.1]
        acceptance:
          - Only allowlisted Codex routes forwarded
          - Path variants covered by tests
          - No open-proxy behavior
      - id: M3.2
        title: Implement Responses and SSE pass-through
        status: pending
        depends_on: [M3.1, M2.4]
        acceptance:
          - Streaming and non-streaming responses work
          - Backpressure and client cancellation propagate
          - Request/body size limits enforced
      - id: M3.3
        title: Implement safe failover state machine
        status: pending
        depends_on: [M3.2, M2.3]
        acceptance:
          - Failover allowed only before first semantic event
          - Retry count, total deadline and account exclusion enforced
          - unsafe_to_replay returned after semantic output
      - id: M3.4
        title: Implement Codex auxiliary endpoints
        status: pending
        depends_on: [M0.2, M3.2]
        acceptance:
          - Every endpoint observed in M0 has a compatibility test
          - Unsupported endpoints fail closed with explicit error
      - id: M3.5
        title: Add compatibility E2E with codex app-server
        status: pending
        depends_on: [M3.3, M3.4]
        acceptance:
          - Multi-turn thread works through router
          - Approved account-switch scenario passes
          - Historical thread resume scenario passes or limitation is documented

  - id: M4
    name: codex-web integration and UX
    tasks:
      - id: M4.1
        title: Run codex-web unchanged against router
        status: pending
        depends_on: [M3.5]
        acceptance:
          - Same browser page survives a safe account switch
          - Existing codex-web functionality remains usable
          - Document exact app-server/router configuration
      - id: M4.2
        title: Add optional account status bridge
        status: pending
        depends_on: [M4.1, M1.3]
        acceptance:
          - codex-web receives only sanitized status/events
          - Feature disabled when router not configured
          - No regression for standard single-account operation
      - id: M4.3
        title: Add minimal UI
        status: pending
        depends_on: [M4.2]
        acceptance:
          - Show alias, quota windows, cooldown, last switch reason
          - Manual switch disabled during active stream
          - All-exhausted state is explicit

  - id: M5
    name: Linux service and deployment
    tasks:
      - id: M5.1
        title: Build Linux headless release
        status: pending
        depends_on: [M3.5]
        acceptance:
          - No Electron runtime required for router
          - x86_64 Linux tested; arm64 documented or tested
          - Reproducible install command
      - id: M5.2
        title: Add systemd units and least privilege
        status: pending
        depends_on: [M5.1]
        acceptance:
          - Router, app-server and codex-web restart independently
          - Loopback/Unix socket only
          - Secrets loaded without command-line exposure
      - id: M5.3
        title: Add upgrade, backup and rollback
        status: pending
        depends_on: [M5.2]
        acceptance:
          - Configuration schema migration is reversible or backed up
          - One-command rollback documented
          - Restart does not erase account health history

  - id: M6
    name: Hardening and release gate
    tasks:
      - id: M6.1
        title: Complete automated test matrix
        status: pending
        depends_on: [M4.3, M5.3]
        acceptance:
          - Unit, integration and E2E suites pass
          - Failure injection covers quota, 429, auth, network, 5xx and malformed SSE
      - id: M6.2
        title: Run 24-hour soak test
        status: pending
        depends_on: [M6.1]
        acceptance:
          - No unhandled crash or infinite retry
          - Memory/FD/concurrency metrics remain bounded
          - Restart and resume drills completed
      - id: M6.3
        title: Security and secret audit
        status: pending
        depends_on: [M6.1, G-SECRETS]
        acceptance:
          - Logs, crash dumps, API responses and UI contain no secrets
          - Admin API authorization tested
          - Path and SSRF/open-proxy tests pass
      - id: M6.4
        title: Produce release and operator docs
        status: pending
        depends_on: [M6.2, M6.3]
        acceptance:
          - Install, configure, monitor, rotate, backup and rollback documented
          - Known limitations and compliance boundaries explicit


---

# FILE: MILESTONES.md

# 里程碑说明

## M0：协议与连续性实验

这是决定项目成败的阶段。不得跳过。

核心输出：

- 实际请求路径清单；
- SSE 语义事件分类；
- response ID 是否跨账号可用；
- router 重启与历史 thread 恢复行为；
- Path A/Path B 决策。

## M1：无头运行时

目标是把账号路由能力变成 Linux daemon，而不是让 Electron 在虚拟显示器下常驻。

完成后应能：

```bash
codex-account-router --config /etc/codex-router/router.toml
curl http://127.0.0.1:18318/healthz
```

## M2：账号状态机

账号不是简单数组。每个账号必须有状态：

```text
enabled -> healthy -> cooling_down -> half_open -> healthy
                  \-> auth_expired
                  \-> quota_exhausted
                  \-> disabled
```

状态变化必须可解释、可持久化、可测试。

## M3：代理与 failover

完成后单个 Codex App Server 应能通过 router 工作。透明 failover 只在安全边界发生。

## M4：同一页面 UX

先验证不改 codex-web 的路径。若后端已满足需求，再做最小 UI：状态、事件、手动切换和故障提示。

## M5：Linux 7×24

拆分三个独立服务：

- account-router；
- codex app-server；
- codex-web。

任何一个前端组件重启不应无条件杀死另外两个。

## M6：硬化

重点不是“正常情况下能用”，而是：

- 限额波动；
- 账号过期；
- 上游半开连接；
- SSE 格式损坏；
- 客户端取消；
- router/app-server/codex-web 分别重启；
- 所有账号同时不可用。


---

# FILE: ACCEPTANCE_TESTS.md

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


---

# FILE: SECURITY.md

# 安全设计

## 威胁模型

能够访问 codex-web 的用户，通常能够让 Codex 以服务用户权限执行命令。因此本项目不是普通只读网站。

主要资产：

- ChatGPT/Codex 登录凭据；
- 工作区文件；
- SSH key、环境变量和其他本地秘密；
- 账号额度与身份元数据；
- thread 历史。

## 默认网络策略

- codex-web：`127.0.0.1:8214`
- account-router model API：`127.0.0.1:18317`
- account-router admin API：`127.0.0.1:18318` 或 Unix socket
- app-server：Unix socket
- 外部访问：SSH tunnel、WireGuard 或 Tailscale

不得默认监听 `0.0.0.0`。

## 凭据存储

优先级：

1. systemd credentials / 外部 secret manager；
2. root-owned 或服务用户独占的 0600 文件；
3. 加密存储，密钥不与密文同目录；
4. 禁止明文写入仓库和普通配置文件。

不要把 token 作为命令行参数，因为可能出现在进程列表。

## 日志脱敏

必须脱敏：

- `Authorization`
- `Cookie` / `Set-Cookie`
- access/refresh/id token
- session secret
- API key
- 账号邮箱（默认只显示 alias）
- 请求正文中的用户源代码和私密文本（默认不记录）

## SSRF 与开放代理

上游 host 必须来自静态 account/provider 配置；请求不能通过 URL、header 或 body 修改上游地址。路径必须使用白名单。

## 管理 API

- 独立管理密钥；
- 常量时间比较；
- 明确速率限制；
- 状态变更写审计日志；
- 手动切换在活动流期间默认拒绝；
- 禁用/删除账号需要二次确认语义或 CLI 显式 flag。

## 服务权限

- 专用 `codex` 用户；
- 不加入 `docker` 组；
- 不授予 sudo；
- `UMask=0077`；
- 独立状态目录；
- 可用时设置 `NoNewPrivileges=true`、`PrivateTmp=true`、`ProtectSystem=strict`，再按实际工作区需求开放路径。


---

# FILE: DEPLOYMENT.md

# Linux 部署方案

## 目录建议

```text
/opt/codex-router/                 程序
/etc/codex-router/router.toml      非秘密配置
/etc/codex-router/credentials/     0600 凭据或 systemd credentials
/var/lib/codex-router/             路由状态、冷却、审计元数据
/var/log/codex-router/             可选结构化日志
/home/codex/                       工作用户 HOME
/run/codex/app-server.sock         App Server Unix socket
```

## 进程分离

1. `codex-account-router.service`
2. `codex-app-server.service`
3. `codex-web.service`

服务必须能独立重启。

## App Server 接入

M0 决定后选择一种：

### Provider/环境变量路径

让 App Server 的模型请求发往：

```text
http://127.0.0.1:18317/v1
```

实际配置键必须从当前 Codex CLI/App Server 版本验证，不得仅凭旧文档猜测。

### App Server Pool 路径

每账号独立：

```text
/var/lib/codex-router/accounts/<alias>/codex-home
/run/codex/accounts/<alias>.sock
```

## 健康检查

- Router liveness：进程事件循环可响应；
- Router readiness：配置有效，至少一个可用账号或明确允许“空池启动”；
- App Server health：协议握手成功；
- codex-web health：HTTP 页面和 WebSocket bridge 可连接。

## 升级顺序

1. 备份配置和状态；
2. 更新 router；
3. 运行 schema migration dry-run；
4. 重启 router；
5. 验证 readiness；
6. 必要时重启 app-server；
7. 最后重启 codex-web。

## 回滚

- 保留前一版本二进制；
- 配置 migration 前生成带版本号快照；
- 回滚时先停服务，再恢复兼容状态；
- 不删除 account auth 数据作为普通回滚步骤。


---

# FILE: CODEX_PROMPTS.md

# 交给 Codex 的执行提示词

## 总控提示词

```text
你正在开发 Linux 7×24 小时运行的 codex-web 多账号自动切换系统。

先阅读：START_HERE.md、AGENTS.md、PROJECT_CHARTER.md、ARCHITECTURE.md、LICENSE_BOUNDARY.md、TASK_DAG.yaml。

严格遵守：
1. 一次只执行一个 DAG 任务。
2. 未通过 M0 协议连续性实验，不得开始 UI 合并或声称可无缝换号。
3. 默认 clean-room，除非 state/implementation-mode.txt 明确为 authorized-fork。
4. 不输出、记录或提交任何凭据。
5. 每个任务结束必须更新 state/task-status.json，并列出测试命令和证据文件。
6. 遇到阻塞时输出 blocker，不要猜测。

现在选择第一个 ready 任务并执行。
```

## 代码审查提示词

```text
审查当前任务的改动。重点检查：
- 是否违反安全切换边界；
- 是否可能在语义 SSE 已输出后重放请求；
- 是否存在无限重试或重试风暴；
- 是否泄露 token/Cookie/Authorization；
- 是否形成开放代理或 SSRF；
- 是否破坏 codex-web 的单账号默认行为；
- 是否把 mock 结果误当作真实兼容性证明；
- 是否有许可证越界复制。

给出阻塞问题、非阻塞问题、测试缺口和是否可合并的明确结论。
```

## 发布审计提示词

```text
对照 ACCEPTANCE_TESTS.md 和 TASK_DAG.yaml 审计发布候选。
禁止仅根据 README 或人工描述认证。
逐项引用测试输出、日志或构建产物。
若任一硬闸门未满足，结论必须是 NOT READY，并指出最小修复路径。
```
