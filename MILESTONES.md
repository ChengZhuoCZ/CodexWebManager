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
