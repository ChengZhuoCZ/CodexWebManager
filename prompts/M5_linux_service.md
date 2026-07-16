# M5 提示词：Linux 服务化

提供无图形环境安装、systemd、日志轮转、健康检查、升级和回滚。

三个服务独立：router、app-server、codex-web。默认 loopback/Unix socket。验证普通 SSH 会话关闭后服务继续运行。
