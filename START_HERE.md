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
