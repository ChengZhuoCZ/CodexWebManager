# 预置架构决策记录

## ADR-001：不先合并 UI

状态：Accepted

原因：账号切换的核心风险在模型协议状态、重试和副作用安全，而不是页面布局。后端路径可以在不修改 codex-web 的情况下先被验证。

## ADR-002：首选 headless router

状态：Proposed，等待 M0

原因：Linux 服务器不应依赖 Electron、虚拟显示器和桌面 keychain。应把账号、额度、调度和代理抽成独立 daemon。

## ADR-003：语义 SSE 后禁止透明重放

状态：Accepted

原因：文本、reasoning 或 function-call 增量一旦向客户端可见，重放可能产生重复或不一致的模型动作。

## ADR-004：许可默认 clean-room

状态：Accepted

原因：目标 CodexManager 仓库标注 All Rights Reserved / UNLICENSED。公开可读不等于允许派生。

## ADR-005：codex-web 单账号模式必须保持

状态：Accepted

原因：上游可合并性和回退能力要求账号路由功能为可选适配层，未配置时行为不变。
