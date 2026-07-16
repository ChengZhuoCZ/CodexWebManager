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
