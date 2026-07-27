# 安全设计

可执行的安全运维步骤见 [`docs/operator-guide.md`](docs/operator-guide.md)，当前未通过的发布
门禁与禁止声明见 [`docs/release-status.md`](docs/release-status.md)。

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
