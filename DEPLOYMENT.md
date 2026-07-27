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

M5.3 的可执行升级、私有快照、健康检查和单命令回滚流程见
[`docs/linux-upgrade-rollback.md`](docs/linux-upgrade-rollback.md)。
