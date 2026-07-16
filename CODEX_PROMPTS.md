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
