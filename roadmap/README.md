# EMI Harness Roadmap

本文件记录已经进入建设范围的工作、当前进度和完成条件。README 说明 EMI Harness 最终要成为什么；Roadmap 说明现在先做什么。

## 当前阶段

| 阶段 | 状态 | 目标 |
| --- | --- | --- |
| v0.1 Pi Runtime 与 EMI Control Plane 最小闭环 | 进行中 | 让一个小型 EMI 研发任务通过受控 Pi Runtime、持久化任务状态和外部工具边界，完成规格、执行、独立检查、人工验收和证据保存 |

当前阶段不建设完整 EMI 业务系统，也不一次性建设完整监管知识库。先证明运行方式和各部件边界正确，再扩充内容。

v0.1 的设计是供真实项目验证的受控基线，不以一次性覆盖所有场景为目标。后续校准运行中发现的问题必须带着任务、运行和证据引用形成独立改进，经讨论、文档更新和自动化检查后进入新版本；改进不得追改已封存的 RunManifest、历史状态或 Evidence，也不得由 Harness 自动修改自身规则。

## 实施步骤

| 步骤 | 工作内容 | 主要结果 | 状态 |
| --- | --- | --- | --- |
| 1 | 完成运行时选型，建立 Pi Runtime 与 EMI Control Plane 边界 | ADR 0002、一致的 README、Roadmap、仓库规则和 pnpm 工作区 | 已完成 |
| 2 | 验证并锁定 Pi SDK 的受控嵌入契约 | 精确 Pi 版本、最小 `PiRuntimePort`、受控 ResourceLoader、精确工具白名单和事件转换验证 | 已完成 |
| 3 | 实现最小持久化任务状态与运行清单 | 可恢复的任务状态、角色运行记录、人工门禁和版本化运行清单 | 设计中 |
| 4 | 实现最小 Controlled EMI Resources | 一条带权威来源、版本、适用范围、状态和哈希的 EMI Context，一个受控 Skill，以及读取和校验方式 | 待开始 |
| 5 | 实现最小 Tool Gateway 与隔离执行边界 | 一个带权限决策、操作意图、幂等键、执行结果和中断后对账的可测试工具调用 | 待开始 |
| 6 | 实现 Executor、Verifier 与最小验证证据 | 独立 Pi Sessions、失败回流、人工批准点，以及不能由 Executor 自行宣布通过的检查 | 待开始 |
| 7 | 接入本地 TypeScript 目标项目并执行完整任务 | 可重复运行的设计到交付过程、失败恢复和完整 Evidence Package | 待开始 |
| 8 | 用户验收并决定 v0.2 | 验收结论、实际问题和下一阶段范围 | 待开始 |

下一步只执行第 3 步，先定义最小任务状态、运行清单和持久化边界，再实现对应包；不同时创建其他目标包或占位实现。

### 第 3 步设计进度

已确认 Control Plane 使用 Task、Approval、Run、RunManifest 和 RoleRun 等相互关联的记录保存权威事实。Task、Run 和 RoleRun 的当前记录负责判断状态和恢复，对应 Transition 追加保存每次被接受的状态变化，并且必须与当前记录在同一事务中写入；Approval 必须绑定被审批对象的确定版本和哈希，Pi Session 不承担权威状态职责。

已确认 Task 使用 `intake`、`contextualizing`、`drafting_trd`、`awaiting_trd_approval`、`planning`、`executing`、`verifying`、`awaiting_acceptance`、`blocked` 和 `closed` 十个状态。Human Authority 是操作者而不是状态；Task 不使用 `failed` 作为终态，一次执行失败由 RoleRun 记录并触发返工、阻塞或取消。

已确认 `start_contextualization` 负责将 Task 从 `intake` 推进到 `contextualizing`。离开 `intake` 前必须绑定满足最小内容要求的版本化 PRD，并通过 Task 版本、命令幂等键和原子状态记录阻止并发覆盖与重复转换；本转换不需要额外人工审批。

已确认 `complete_contextualization` 负责将 Task 从 `contextualizing` 推进到 `drafting_trd`。进入技术设计前必须封存与当前 PRD 对应的 ContextManifest，所有适用性和监管解释都有有效确认依据，并且不存在阻塞事项；Agent 只能整理上下文，不能自行确认监管结论或降低问题等级。

已确认 `submit_trd_for_approval` 负责将 Task 从 `drafting_trd` 推进到 `awaiting_trd_approval`。TRD 必须覆盖输入绑定、范围、设计、控制追溯、验证和风险，完成确定性完整性检查并封存；Control Plane 在同一事务中创建绑定 TRD 版本与摘要的待审批请求和状态转换，Agent 不能批准自己的设计。

已确认 TRD Approval 可以要求多个 Human Authority 分别追加 ApprovalDecision。全部门禁满足后进入 `planning`；技术设计、EMI Context 或 PRD 问题分别返回 `drafting_trd`、`contextualizing` 或 `intake`；拒绝进入 `blocked`。附条件批准只能携带结构化、可验证的后续条件，不能绕过会改变 TRD 或监管解释的重新审批。

已确认 Run 表示一个已批准 TRD 版本在固定输入、权限和代码基线下获得授权的一次交付尝试。一个 Run 对应一个不可变 RunManifest，并可包含多个独立 RoleRun；锁定内容变化或超出重试范围时必须新建 Run。v0.1 中一个 Task 同时最多只有一个活动 Run，Executor 与 Verifier 不并发且不共享 Pi Session。

已确认 RunManifest V1 只锁定执行输入、目标代码基线、Runtime、角色能力、策略限制和验证要求。所有引用必须版本化并带摘要，凭据只记录绑定引用，运行状态和输出不进入 Manifest；Manifest 自身的 Run Authorization Approval 保存在外部并绑定 Manifest 摘要，避免循环依赖。

已确认 `seal_run_manifest` 使用 RFC 8785 与 SHA-256 原子保存 Run、不可变 Manifest 和待授权请求，Task 保持 `planning`。v0.1 始终要求 Human Authority 明确作出 Run Authorization；最终授权和执行前校验通过后，Control Plane 先持久化 `planning → executing`，事务提交后才允许创建 Executor RoleRun 或产生副作用。

已确认 Run 与 RoleRun 分别保存流程状态和最终结果。RoleRun 必须经历持久化准备、租约启动、运行和外部操作结算，Pi 的完成结果不能代替 RoleRun 成功；未知副作用进入 `blocked` 而不是自动失败重试。Worker 租约使用单调递增 fencing token，状态写入与新工具请求拒绝旧 token；接管前已经受理的工具操作仍须按 Operation ID 和幂等键完成对账。

已确认 RunTransition 和 RoleRunTransition 只追加保存 Control Plane 成功接受的权威状态变化，不保存全部 Pi 事件或工具调用。每项 Transition 记录前后状态与版本、命令、操作者、原因和证据；RoleRunTransition 还绑定当时的 fencing token。被拒绝的过期写入进入安全日志，不得进入状态历史。

已确认 Run 当前记录采用最小字段，只保存身份、版本、Manifest 摘要、授权请求、状态与结果、停止或恢复意图以及基本时间。授权版本、替代关系、证据和阶段时间进入 RunTransition；当前 RoleRun 和实际次数从 Run 未结算期间完整保留的 RoleRun 记录查询，并通过数据库约束和事务检查并发及 `maxRoleRuns`。

仍需依次确认其余合法状态转换及门禁、Approval 的撤回与失效等异常生命周期、Run 与 Task 状态对应关系、持久化方案、工具结果对账细节，以及第 3 步的完整验收条件。详细讨论记录见 [`docs/design/control-plane-state-and-run-manifest.md`](../docs/design/control-plane-state-and-run-manifest.md)。

### 第 2 步实际结果

- 新增 `@emi-harness/runtime-pi`，只通过自有 `PiRuntimePort`、请求、Session、Tool 和 Event 类型向外提供能力，构建检查会阻止公共声明暴露 Pi 类型。
- 精确锁定 `@earendil-works/pi-ai`、`pi-agent-core` 和 `pi-coding-agent` `0.84.2`，对应走读 commit 为 `59a71b235dadb4ad0d67557a8abb0aaa093e68b4`；工作区脚本会检查锁版和“只有 `runtime-pi` 可以直接依赖 Pi”的边界。
- 自建 ResourceLoader 只返回运行请求传入的系统提示、追加提示和上下文文件，拒绝运行中扩展资源；契约测试证明目标目录中的 `AGENTS.md` 不会被默认发现。
- 模型目录只使用锁定 Pi 包内置版本并关闭目录网络刷新，不读取环境中的 `models.json`、`auth.json` 或环境变量凭据；调用方必须通过自有解析器显式提供所选 Provider 的 API Key。
- 每个 Session 始终传入精确工具列表，包括空列表；Pi 内置文件和 Shell 工具被适配器拒绝，Session 创建后再次核对实际启用工具。
- Pi 事件被转换为带 Run ID、Role Run ID、角色和 Session ID 的 EMI 事件；结束结果区分完成、中断、错误、不完整和未知。异步事件监听按顺序完成，监听失败不会打断 Pi，但会使本次 `run()` 在 Pi settled 后失败。
- 无网络 Faux Provider 契约测试已实际执行正常工具调用和活动请求中断，确认中断结果先产生 `agent.ended(outcome=aborted)`，随后产生 `agent.settled`。

本步只证明 Pi 的受控嵌入边界。当前 Session、Settings 和测试凭据均不承担 EMI 权威状态；持久化任务状态、运行清单、审批和恢复属于第 3 步。

## v0.1 完成条件

- 从干净环境可以安装精确锁定的 Pi 版本并通过 `PiRuntimePort` 启动角色 Session。
- 受控 ResourceLoader 只加载运行清单声明的资源，项目或用户的默认 Pi 资源无法进入受控运行。
- Agent 只能看到精确工具白名单，任何有副作用的操作都经过 Tool Gateway 和隔离执行边界。
- 同一个验证任务可以从 PRD 和 EMI Context 形成 TRD，经人工批准后执行。
- Executor 与 Verifier 使用独立 Session 和权限，失败能够回到正确步骤，超过限制后停止自动执行。
- 目标、PRD、规则来源、TRD、代码变更、检查结果和人工验收能够互相对应。
- 运行中断后可以从 EMI 自有任务状态恢复，并能识别需要对账的未知工具结果，不依赖原有聊天记录。
- 用户完成最终验收。

## 本阶段不做

- 不迁移或兼容旧版文件路径、Workflow、Skill 和 8 模块验证项目。
- 不建设 Harness 自动修改自身规则的进化机制。
- 不接入生产数据、生产凭据或客户信息。
- 不 fork Pi，不依赖 Pi 尚未完成的新 `AgentHarness`，不把 Pi Session 当成 EMI 任务或证据账本。
- 不提前引入 Kafka、Redis、搜索引擎、工单系统等非必要组件。
- 不同时支持多套运行时或 TypeScript 之外的目标应用技术栈。

## 维护规则

- 每个步骤开始、完成或停止时更新状态和实际结果。
- 计划变化必须记录原因，不用未来假设掩盖当前未完成的工作。
- README 与实现不一致时，先明确是设计变化还是实现尚未完成，再更新对应文件。
