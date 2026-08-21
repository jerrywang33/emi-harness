# @emi-harness/assurance

在 Agent 之外运行 RunManifest 锁定的检查，并把检查观察和 Verification gate 结果保存为不可修改、带 SHA-256 的 Evidence。

v0.1 的 `NodeCheckRunner` 只使用当前 Node 可执行文件运行明确的仓库内 `.mjs` 脚本，不接受 Shell 命令。`AssuranceService` 只有在 Executor/Verifier 隔离、required checks 精确覆盖、Evidence 绑定正确且全部检查通过时才允许 PASS。

本地 Node 进程不是生产沙箱。正式处理不可信仓库前仍需容器或虚拟机级资源、文件系统和网络隔离。
