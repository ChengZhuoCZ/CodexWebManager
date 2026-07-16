# M1 提示词：无头 Router 核心

仅在 M0 已选定架构后执行。

实现 Node.js 22+ headless service，不依赖 Electron、桌面窗口或虚拟显示器。先完成 health/readiness、配置解析、公共账号元数据和秘密 provider 接口。默认绑定 loopback。所有日志使用结构化脱敏 logger。

先写测试，再实现；不要接真实账号。
