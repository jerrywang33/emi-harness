# @emi-harness/assurance

在 Agent 之外运行 RunManifest 锁定的检查，并把检查观察和 Verification gate 结果保存为不可修改、带 SHA-256 的 Evidence。

v0.1 的 `NodeCheckRunner` 只使用当前 Node 可执行文件运行明确的仓库内 `.mjs` 脚本，不接受 Shell 命令。`AssuranceService` 只有在 Executor/Verifier 隔离、required checks 精确覆盖、Evidence 绑定正确且全部检查通过时才允许 PASS。

本地 Node 进程不是生产沙箱。正式处理不可信仓库前仍需容器或虚拟机级资源、文件系统和网络隔离。

## 输入、输出与入口

- [types.ts](src/types.ts) 定义检查配置、观察、Evidence 和验证输入输出；`CheckRunnerPort` 与 `EvidenceStorePort` 由宿主提供实现。
- [assurance-service.ts](src/assurance-service.ts) 的 `runRequiredChecks()` 要求传入检查集合与 Manifest 引用精确一致，运行后保存 Check Evidence。`sealVerification()` 重读证据，核对任务、运行、角色、检查和结论，输出 Verification 内容及 Evidence 引用。
- [node-check-runner.ts](src/node-check-runner.ts) 使用当前 Node 可执行文件运行工作区内的 `.mjs`，记录退出码、超时、有限长度的 stdout/stderr。检查定义的摘要不包含脚本文件字节；脚本及其依赖由宿主保护。
- [sqlite-evidence-store.ts](src/sqlite-evidence-store.ts) 保存不可变记录并在读取时复算摘要。同 ID/版本、同输入的写入返回原记录，内容变化报冲突；`createdAt` 属于第一次写入结果。

Integration 是实际使用方，负责从 Control Plane 解析输入、执行检查、调用验证门禁，再提交控制面的 VerificationResult。Assurance 本身不改变 Task，也不生成最终验收决定。

## 结论边界

只有全部必需检查通过时才允许 `pass`；独立 Verifier 仍可因检查未覆盖的问题提交 `fail`。Session ID 不同证明运行记录分开，模型、宿主和检查脚本是否足够独立需要另行评估。

`baseCommit` 随检查观察记录，Runner 不自行 checkout 或确认当前文件等于该提交。Evidence 摘要用于完整性检查，生产者身份、原始观察真实性、脱敏和存储访问控制需要可信宿主承担。

## 验证与设计

运行 `pnpm --filter @emi-harness/assurance check`；[test/](test/) 覆盖证据重开与不可变性、Node 检查边界及伪造 PASS 拒绝。设计见 [Executor、Verifier 与 Assurance v0.1](../../docs/design/executor-verifier-assurance-v0.1.md)，跨包流程见 [Review 指南](../../docs/review-guide.md)。
