# Executor、Verifier 与 Assurance v0.1 设计

- 状态：已实现
- 对应 Roadmap：v0.1 第 6 步
- 最后更新：2026-08-21

## 目标

把已经实现的 Control Plane、Pi Runtime Port、Controlled Resources 和 Tool Gateway 组装成一个最小执行与独立验证闭环，并使交付结论依赖可复核证据，而不是依赖 Executor 或 Verifier 的自然语言完成声明。

本步只验证角色运行、检查、证据和失败回流的机制。真实 EMI 目标项目、完整 PRD/TRD 内容和用户业务验收属于第 7、8 步。

## 职责边界

| 部件 | 本步职责 | 不承担的职责 |
| --- | --- | --- |
| Control Plane | 保存 Task、Run、RoleRun、审批、Manifest 和状态转换，接受绑定后的 ExecutionResult 与 VerificationResult。 | 不执行模型、文件工具或项目检查。 |
| Integration | 按权威状态准备和租用 RoleRun，解析 RolePlan，组装 Runtime resources/tools，协调角色交接。 | 不自行修改 Manifest、改变 verdict 路由或批准结果。 |
| Pi Runtime | 为 Executor 和 Verifier 分别创建 Session，运行受控 prompt 和精确工具列表。 | 不保存权威任务状态或证据结论。 |
| Tool Gateway | 执行 Executor 获准的文件副作用并提供 Operation 账本。 | 不接受 Verifier 写代码，也不判断检查是否通过。 |
| Assurance | 在 Agent 之外运行固定检查，保存不可变 Evidence，并确定 PASS 是否具备客观前提。 | 不解释法规、不接受风险，也不代替用户验收。 |

## 结构化角色提交

`PiRuntimePort.run()` 只返回 Runtime outcome，不把自由文本当作权威制品。因此每个角色得到一个无副作用、精确白名单的结构化提交工具：

- `harness.submit_execution@1`：Executor 提交实现摘要和声明的变更路径。Integration 只把它当作交接材料；实际 Tool Operations、输出摘要和证据由外部组件读取并封存。
- `harness.submit_verification@1`：Verifier 提交 `pass`、`fail` 或 `blocked`、finding class、理由和 findings。Assurance 仍会校验独立性、required checks 和证据绑定；Agent 不能通过调用该工具绕过失败检查。

每个 RoleRun 必须且只能形成一次有效提交。工具定义和策略引用使用固定版本与摘要，并作为 RolePlan 白名单的一部分；未在 RolePlan、定义摘要不一致、重复提交或输入不符合 Schema 时，角色不能成功交接。

这些提交工具不执行文件、Shell、网络或外部系统副作用，因此不进入 Tool Gateway Operation 账本。所有有副作用工具仍必须由 Gateway adapter 转发并收集 Operation ID。

## Executor 流程

1. Integration 读取当前 Task、Run、RunManifest 和 Executor RolePlan，调用 Control Plane 准备 RoleRun 并获取带 fencing token 的 Worker lease。
2. Resource Registry 只投影 RolePlan 精确引用的 Context、Skill 和 Prompt；Integration 按 RolePlan 顺序组装 side-effect Gateway tools 与结构化提交工具。
3. Integration 将带摘要的 TRD、ExecutionPlan 和 AcceptanceCriteria 作为受控 Artifact 上下文投影给 Executor。创建独立 Runtime Session 后立即把 Session ID 写入 Control Plane，再开始 prompt；RoleRun 进入 `running` 前，Agent 不能调用 Gateway。
4. Runtime events 只保存类型、绑定 ID、Session ID 和结果摘要，不保存模型推理。Gateway Operation ID 从每次工具结果中由可信 adapter 收集。
5. Runtime 结束后先把 RoleRun 改为 `settling`。无论 Runtime 成功还是失败，Integration 都先要求所有 Operation 成为 `denied`、`failed` 或 `succeeded` 等已知终态；`authorized`、`executing` 或 `unknown` 必须先对账，未知结果优先阻塞，不能以 Runtime 失败掩盖后重试。
6. Runtime 必须为 `completed` 且存在唯一 Execution submission。Integration 将 Task、Run、Manifest、Session、实际 Operation、声明路径和 Evidence 精确绑定成 ExecutionResult，再调用 `submit_execution_for_verification`。
7. Runtime 错误、缺少或重复提交、越权工具、未知 Operation 或证据保存失败都结算本次 RoleRun 为不成功，不把 Task 推进到 verifying。

## 确定性检查与 Evidence

`@emi-harness/assurance` 使用独立 SQLite 保存不可修改的 EvidenceRecord。每条记录包含：Evidence ID 与版本、kind、Task/Run/RoleRun、producer、subject refs、规范 JSON 内容、SHA-256 和时间；Evidence ref 同时携带 ID、版本和摘要。数据库重开时重新计算摘要，损坏或引用不一致立即失败。

v0.1 `NodeCheckRunner` 只执行经过 RunManifest VersionedRef 锁定的 `node_script` CheckDefinition：

- Executor 配置显式绑定 `repositoryId` 和真实 workspace root。
- 脚本必须是规范仓库相对路径，不能经过符号链接逃逸。
- 使用当前 Node 可执行文件直接 spawn，不使用 Shell；参数、超时、最大输出和最小环境由定义与 Runner 上限共同约束。
- CheckObservation 保存检查 ref、目标 base commit、开始与结束时间、exit code/signal、stdout/stderr、截断标志和 `passed`、`failed` 或 `blocked` outcome。

运行目标项目代码本身仍不是强隔离。v0.1 的固定 Node 进程与无 Shell 接口用于本地闭环；生产中的不可信仓库、网络封锁、CPU/内存和文件系统隔离必须由后续容器或虚拟机执行器承担。

## Verifier 流程

1. Executor 交接后，Integration 创建新的 Verifier RoleRun 和新的 Pi Session，并把精确 ExecutionResult 与 AcceptanceCriteria 作为带摘要的受控 Artifact 上下文投影给它；Verifier 的 RolePlan 不包含 workspace 写工具。
2. Verifier Session 建立并进入 running 后，Assurance 在 Agent 之外执行 RunManifest 的全部 required checks，并先保存每项 Check Evidence。
3. Verifier prompt 绑定精确 ExecutionResult、验收标准和 Check observations。Verifier 可以检查语义问题，但不能修改目标文件或覆盖客观检查结果。
4. Runtime 结束后，Assurance 要求 Executor 与 Verifier 的 RoleRun、Session 和 producer 不同，required checks 无缺失、重复或错误引用，每项 Evidence 与当前 Run、Verifier RoleRun、目标基线和 Check ref 一致。
5. `pass` 只在所有 required checks 都为 `passed` 时允许；任一 `failed` 时 PASS 被拒绝，Verifier 必须提交合适的 FAIL；`blocked` 只用于已知外部缺口，不能隐藏检查失败或未知工具结果。
6. Assurance 封存 Verification Evidence 和 VerificationResult 后，Integration 调用 Control Plane。Control Plane 继续按 finding class 执行 `awaiting_acceptance`、实现返工、上游回流或阻塞；Verifier 不能自行选择状态。

## 失败与恢复

- Session 创建前中断：RoleRun 保持 `starting`，由 Control Plane lease 恢复规则接管。
- Session 已创建但 Runtime 未完成：记录 runtime outcome，结算该 RoleRun 为失败、终止或中断，不复用 Session。
- Gateway Operation 未知：RoleRun 进入结算但不交接，先按 Operation ID 对账。
- Check process 超时、异常退出或输出协议不可判断：Check outcome 为 `blocked`；不得形成 PASS。
- Verifier 提交 PASS 但检查失败：Assurance 拒绝该提交，RoleRun 不能被结算为成功。
- Control Plane 状态或版本在异步运行期间变化：所有最终命令使用重新读取的期望版本和原 lease token；过期写入失败，不覆盖新状态。

## 验收条件

1. Executor 和 Verifier 使用不同 RoleRun、Pi Session、角色工具集和 producer，Session ID 均写入 Control Plane。
2. Executor 的唯一文件写入经过 Tool Gateway；Verifier 看不到该写工具。
3. Runtime completed 但未提交结构化结果、重复提交或存在 unknown Operation 时不能交接。
4. required check 在 Agent 之外执行并形成可重开、可校验、不可修改的 Evidence。
5. PASS 缺少检查、引用错误、检查失败、Evidence 摘要错误或 Executor/Verifier 未隔离时均失败关闭。
6. PASS 进入 `awaiting_acceptance` 而不是自动关闭；实现检查失败可以形成 `fail/implementation` 并回到 `executing`。
7. 测试证明 Runtime 只收到 RolePlan 声明的资源和工具，且 Ambient 项目资源不会通过 Integration 重新进入。
