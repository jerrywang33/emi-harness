# @emi-harness/integration

根据 Control Plane 当前状态和 RunManifest 组装受控资源、精确 Runtime tools、Tool Gateway、Assurance checks 和角色交接。Executor 与 Verifier 使用不同 RoleRun 和 Runtime Session；Integration 不解释法规、不改变 Manifest，也不接受 Agent 自行宣布检查通过。

`harness.submit_execution@1` 与 `harness.submit_verification@1` 是无副作用的结构化结果收集工具。有副作用的 `workspace.write_text@1` 仍只能通过 Tool Gateway adapter 调用。

`CandidateEvidencePackageBuilder` 只在 Task 已进入 `awaiting_acceptance`、全部 RoleRun 和 Tool Operation 已知结算且 Manifest 要求的 Evidence 齐全时导出候选交付包。候选包固定标记用户验收为 pending；导出不能代替 `accept_delivery`。

## 输入、输出与入口

- [types.ts](src/types.ts) 定义角色请求与结果；[role-execution-coordinator.ts](src/role-execution-coordinator.ts) 的构造配置接收其他 5 个包的实例及可信 Coordinator 身份。
- `execute()` 要求已授权 Run，接收新 RoleRun ID、角色计划、Worker、工作目录、提示与输出制品 ID；完成一次执行、工具对账和 ExecutionResult 交接。返回 `failed` 或 `blocked` 时由宿主根据权威状态处理，配置和基础设施异常还可能抛出。
- `verify()` 接收绑定的 ExecutionResult 和已完成 Executor RoleRun，创建独立 Session，运行外部检查后收集 Verifier 提交；结果中的 `completed` 表示角色交接完成，具体交付结论仍需读取 `verificationResult.content` 中的 `verdict` 和 Task 状态。
- [submission-tools.ts](src/submission-tools.ts) 检查两类结构化提交并要求恰好一次；[gateway-runtime-tool.ts](src/gateway-runtime-tool.ts) 为写工具补上 Run、RoleRun 和 token，并收集返回的 Operation ID。
- [candidate-evidence-package.ts](src/candidate-evidence-package.ts) 从三个账本和调用方提供的资源快照构建候选包，检查后序列化并写入目标项目。外层 SHA-256 验证函数不重做完整生成时校验，也不提供签名认证。

## 当前组装方式

完整可运行组装见 [fixtures.ts](test/fixtures.ts) 和 [Pi E2E](test/pi-target.e2e.test.ts)。这些文件使用合成 PRD/TRD、测试 Actor 和预先安排的审批，不应直接作为生产身份或审批实现。当前无常驻调度器、Coordinator Agent 需求设计入口、自动恢复服务或审批 UI。

Runtime 事件与结构化提交先在内存收集；控制面、工具和证据分库提交。进程在不同写入点中断后如何补齐账本，需要按调用链审查，不能从单库事务推导跨库原子性。RolePlan 超时触发协作式 `abort()`，没有主进程级强制终止边界。

Executor 的变更路径对照成功工具操作，`workspaceOutputDigest` 对工具快照取摘要。Verifier 当前读取 ExecutionResult、AcceptanceCriteria、获准资源和外部检查结果，没有完整源码或 diff 的自动输入路径。详细审查线索见 [Review 指南](../../docs/review-guide.md)。

## 验证

先从根目录运行 `env -u EMI_HARNESS_E2E_TARGET_ROOT pnpm check`，构建全部 workspace 依赖并运行测试。之后可用 `env -u EMI_HARNESS_E2E_TARGET_ROOT pnpm --filter @emi-harness/integration check` 聚焦本包。保留独立目标的命令、文件副作用和真实 Pi/Faux Provider 测试边界见 [Review 指南的复现说明](../../docs/review-guide.md#5-如何复现检查)。
