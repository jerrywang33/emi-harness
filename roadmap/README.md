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
| 3 | 实现最小持久化任务状态与运行清单 | 可恢复的任务状态、角色运行记录、人工门禁和版本化运行清单 | 已完成 |
| 4 | 实现最小 Controlled EMI Resources | 一条带权威来源、版本、适用范围、状态和哈希的 EMI Context，一个受控 Skill，以及读取和校验方式 | 已完成 |
| 5 | 实现最小 Tool Gateway 与隔离执行边界 | 一个带权限决策、操作意图、幂等键、执行结果和中断后对账的可测试工具调用 | 已完成 |
| 6 | 实现 Executor、Verifier 与最小验证证据 | 独立 Pi Sessions、失败回流、人工批准点，以及不能由 Executor 自行宣布通过的检查 | 已完成 |
| 7 | 接入本地 TypeScript 目标项目并执行完整任务 | 可重复运行的设计到交付过程、失败恢复和完整 Evidence Package | 已完成 |
| 8 | 完成 v0.1 工程验收与发布 | 验收矩阵、已知限制、发布记录和下一轮真实场景校准入口 | 实现中 |

下一步只执行第 8 步，对 v0.1 的实现、自动化检查、外部校准记录、已知限制和文档一致性进行工程验收并形成发布记录；真实 EMI 业务验收仍保留给后续用户校准。

### 第 7 步实际结果

- `runtime-pi` 把生产与校准共用的 Pi Session 创建逻辑提取为内部受控工厂；`@emi-harness/runtime-pi/testing` 使用 Pi 0.84.2 Faux Provider，但仍实际创建 AgentSession、注入自建 ResourceLoader、转换 Pi events 并执行自定义工具。
- Deterministic Adapter 对每个 RoleRun 使用一次性响应脚本，拒绝未知或重复 RoleRun、未消费响应、并发 Session 和非固定模型；其 testing 公开声明同样经过 Pi 类型泄漏检查。
- 新增真实 Pi 目标项目 E2E。临时目标先建立真实 Git baseline，RunManifest 锁定 Harness commit、目标 commit、三个 Pi 包及 npm integrity、Adapter、Node/pnpm 环境、资源和工具摘要。
- 第一个 Executor 以错误旧摘要得到已知失败 Operation，安全结算后由第二个新 Session 重试成功；第三个只读 Verifier Session 在 Agent 外检查 TypeScript 输出并提交 PASS，Task 停在 `awaiting_acceptance`。
- Candidate Evidence Package Builder 从三个可重开账本导出完整 Task/Run/RoleRun transitions、审批决定、制品、资源快照、Tool Operation 全记录和 Evidence；遗漏 Operation、未知状态、资源错配、证据缺失、摘要篡改或重复写文件均失败关闭。
- 可重复命令要求 Harness 工作树干净和一个不存在的绝对目标路径，先执行全工作区检查，再创建无远端本地目标仓库并保留候选证据；已有目标不会被覆盖。
- 外部 `emi-pilot-ts` 校准锁定 Harness commit `8570d99` 和目标基线 `8c9e919`，产生本地候选提交 `2787335`。第一次 Operation 明确失败、第二次成功，3 个 Pi Session 相互独立，目标检查和候选包摘要复算通过。
- 6 个 Runtime 测试文件中的 15 个场景和 3 个 Integration 测试文件中的 6 个场景通过；全工作区共 55 个测试通过。

详细设计见 [本地 TypeScript 目标项目校准 v0.1](../docs/design/local-typescript-calibration-v0.1.md)，实际 hash、结果和复核边界见 [v0.1 本地 TypeScript 工程校准记录](../calibrations/v0.1-local-typescript/README.md)。该记录不是用户真实业务验收。

### 第 6 步实际结果

- 新增 `@emi-harness/assurance`，使用独立 SQLite 保存不可修改、带规范 JSON 和 SHA-256 的 Evidence；读取时重新核对摘要、索引列和输入摘要，重复 ID 绑定不同内容时失败关闭。
- `NodeCheckRunner` 只运行 RunManifest 精确引用且摘要一致的仓库内 `.mjs` 检查脚本，不接受 Shell 字符串；它限制规范路径、符号链接、参数、超时、环境和输出，并把通过、失败或阻塞观察封存为 Check Evidence。
- 新增 `@emi-harness/integration`，在 Control Plane 中先准备和租用 RoleRun，再将 RolePlan 声明的资源、带摘要的权威 Artifact 和精确工具列表交给 `PiRuntimePort`；Runtime 返回的身份和实际工具集会被再次核对。
- Executor 只有 `workspace.write_text@1` 和无副作用的 `harness.submit_execution@1`。实际变更路径必须与成功 Tool Operation 精确一致；Runtime 成功、唯一结构化提交、工具对账和 Evidence 完成后才能交给 Verifier。
- Verifier 使用新的 RoleRun 和 Session，只获得 `harness.submit_verification@1`，并读取绑定的 ExecutionResult、AcceptanceCriteria 和外部确定性检查结果；它不能写目标项目，也不能以自然语言覆盖失败检查。
- Assurance 要求 Executor 与 Verifier 的 RoleRun 和 Session 不同、required checks 精确覆盖且 Evidence 绑定有效。全部检查通过才允许 PASS，并停在 `awaiting_acceptance`；实现失败返回 `executing`，伪造 PASS 结算本次 Verifier RoleRun 为失败。
- 所有已经受理的 Executor Tool Operations 都先于 Runtime outcome 和 Agent submission 完成对账。任何未知副作用都原子阻塞 RoleRun、Run 和 Task，保留恢复状态，不能以普通 Runtime 失败重新执行。
- 3 个 Assurance 测试文件中的 7 个场景和 2 个 Integration 测试文件中的 5 个场景覆盖 Evidence 不可变与重开、检查执行边界、独立 PASS、失败回流、伪造 PASS、受控上下文与工具，以及 Runtime 失败叠加未知副作用。全工作区 54 个测试通过。

详细边界和本地进程限制见 [Executor、Verifier 与 Assurance v0.1 设计](../docs/design/executor-verifier-assurance-v0.1.md)。本步的 Scripted Runtime 只用于验证自有编排契约；实际 Pi AgentSession 的目标项目闭环属于第 7 步。

### 第 5 步实际结果

- 新增 `@emi-harness/tool-gateway`，只注册带固定定义摘要的 `workspace.write_text@1`，不向 Agent 提供 Shell、Git、网络、删除、移动或任意文件读取能力。
- `ControlPlaneRoleRunAuthority` 在每个新 Operation 前重新读取 Run、RoleRun 和 RunManifest，要求 Run 为 active、RoleRun 为 running、角色为 Executor、lease 未过期、fencing token 精确匹配，并重新核对工具版本、定义摘要、策略引用和隔离配置。
- Gateway 使用独立 SQLite 账本保存 Operation 当前状态，以及不可修改的 PolicyDecision、OperationIntent、OperationResult 和 OperationTransition；数据库重开后仍可按 Operation ID 恢复和查询。
- Tool call 幂等键由 Run、RoleRun、Pi call ID、工具名和版本确定性派生。同一请求重放返回原 Operation，同一键绑定不同请求摘要时失败，不会产生第二次副作用。
- 允许决定和完整 Intent 在同一事务中提交；Gateway 再把状态提交为 `executing` 后才调用 Executor。Worker 明确返回前置条件失败时记录已知失败，进程超时、退出、取消或协议异常则记录 `unknown`。
- `SubprocessWorkspaceExecutor` 把 `repositoryId` 与本地真实根目录显式绑定，只向独立 Node helper process 发送一个版本化请求。Worker 再次检查路径、父目录、符号链接、文件类型、内容大小和旧摘要，并通过排他临时文件、flush 与原子 rename 写入。
- `reconcile(operationId)` 不要求旧 lease 继续有效，也不再次写入：目标等于 Intent 摘要时结算成功，仍是明确旧状态时结算为未应用，其他状态保持未知并等待人工处理。
- 工具、策略和隔离 profile 的 v1 摘要由测试固定；2 个测试文件中的 9 个场景覆盖执行前持久化、真实写入和重开、不可变记录、权限拒绝、CAS、幂等冲突、符号链接逃逸，以及已应用、未应用和分歧状态对账。

详细边界和限制见 [Tool Gateway v0.1 设计](../docs/design/tool-gateway-v0.1.md)。本地 helper process 是可测试的最小进程隔离，不宣称具备生产所需的容器、虚拟机或操作系统级网络隔离；该升级必须根据真实部署环境另作 ADR。

### 第 4 步实际结果

- 新增 `@emi-harness/resource-registry`，以显式 `registry.json` 作为唯一资源入口；Registry 不扫描目录，也不读取目标项目、用户目录、Pi Session 或网络内容。
- 新增 `emi.safeguarding.payment-funds@2026.08.21` EMI Context。它记录 EMD2 Article 7、PSD2 Article 10、Article 114 和 Annex II 的 EUR-Lex 来源、文档版本、条款定位、获取日期、适用边界与确认状态。
- Context 将 4 条来源支持命题、5 条任务确认事项和 5 条工程推导分别编号。来源基线获准加载不代表具体 Task 已完成成员国、牌照主体、资金范围、safeguarding 方法或业务规则确认。
- 新增仅允许 Coordinator 使用的 `emi.skill.control-to-trd@2026.08.21`，把已确认的 PRD 和 Context 控制映射为 TRD、可验证控制、追溯表和待决项；Skill 明确禁止决定法规适用性、自行审批、扩大范围或静默假设。
- Run 通过 Resource ID、版本和原始 Manifest SHA-256 精确引用资源；加载时再次验证 Manifest 身份、状态、内容摘要和角色，投影只暴露稳定的 `emi-resource:` 逻辑来源。
- 路径检查在读取前拒绝绝对路径、非规范路径和父目录穿越，并在解析真实路径后拒绝符号链接逃逸；非活动资源、未索引资源、重复引用、摘要篡改、未知字段和重复 Statement ID 均为失败关闭。
- 2 个测试文件中的 9 个场景覆盖稳定投影、角色限制、显式索引、Manifest 与内容摘要、inactive 状态、两级路径穿越、非权威 URL 和严格 Schema 语义。

详细边界和验收条件见 [Controlled EMI Resources v0.1 设计](../docs/design/controlled-emi-resources-v0.1.md)。本步只提供经过验证的资源投影，不自行确认某个 Task 的法律适用性，也不直接创建 Pi Session；运行集成仍由后续 Integration 负责。

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

已确认 Task 与未结算 Run 的静态对应关系：设计与审批阶段不允许未结算 Run，`planning` 只能没有 Run 或等待授权，执行、验证和验收阶段共享同一个已授权或活动 Run，`blocked` 只允许没有 Run，或对应停止中、阻塞 Run，`closed` 不允许未结算 Run。Task 与 Run 的关联状态必须原子推进。

已确认 `submit_execution_for_verification` 是 Executor 向 Verifier 的确定性交接，而不是人工审批。只有 ExecutionResult、目标代码输出、自检、Tool Operation 和证据完成封存与对账后，Control Plane 才能原子结算 Executor RoleRun 并将 Task 从 `executing` 改为 `verifying`；Verifier 必须绑定该次交接的精确输出。

已确认 Verifier 分别记录 RuntimeOutcome、RoleRunOutcome 和 VerificationVerdict。VerificationResult 是绑定精确 ExecutionResult 和验收标准的版本化 RoleRun 输出，以 `pass`、`fail` 或 `blocked` 描述交付结论；Verifier RoleRun `succeeded` 不代表交付通过。未知工具结果不允许伪装成最终 verdict，必须保持阻塞并先完成对账。

已确认 `submit_verification_result` 的 `pass` 分支只生成等待用户接受的固定交付对象。独立性、必需检查、证据、输出摘要和工具对账全部满足后，Control Plane 原子结算 Verifier RoleRun 并将 Task 从 `verifying` 改为 `awaiting_acceptance`；Run 保持活动，PASS 不自动完成任务。

已确认 `submit_verification_result` 的 `fail` 分支按经确认的 findingClass 路由。纯实现问题且预算充足时在同一 Run 内返回 `executing`；TRD、EMI Context 或 PRD 问题先进入阻塞并停止、结算旧 Run，再返回对应上游阶段。次数耗尽、分类不确定或未知工具结果不能自动返工。

已确认 `submit_verification_result` 的 `blocked` 分支只处理已知外部缺口：Verifier 安全结算，Task 与 Run 阻塞；新增证据满足恢复条件且锁定输入未变时，以新 Verifier RoleRun 恢复验证。需要修改锁定输入时终止原 Run。未知 Tool Operation 不形成最终 verdict，必须先对账。

已确认 `accept_delivery` 由有权限的 Human Authority 对精确交付对象直接提交，不额外创建单人 Acceptance Approval。所有验收条件、交付操作和权威证据满足后，Control Plane 原子结算 Task 与 Run；命令不执行副作用，附条件接受不能关闭任务，最终 Evidence Package 只作为验收后的可重试派生导出。

已确认验收返工必须绑定版本化 AcceptanceFeedback：纯实现问题可以在同一个 Run 内重新执行和验证，锁定输入变化必须停止并替代 Run，无法分类时必须阻塞。取消不能跳过 Agent 停止和 Tool Operation 对账；存在未知副作用时 Task 不能关闭。

已确认 Approval 使用追加式 Decision 与 Transition 保存完整生命周期。待审批可以撤回或按确定性时钟过期，批准后只能追加撤销事实；撤销不能删除历史授权，已经开始的 Run 必须进入停止或阻塞路径。

已接受 [ADR 0003](../docs/decisions/0003-use-sqlite-for-v0.1-control-plane.md)：v0.1 由单 Control Plane 写进程使用 SQLite，依靠事务、版本、部分唯一索引、Command 幂等记录、outbox 和 RoleRun fencing token 保证状态与恢复边界。详细设计和第 3 步自动化验收条件见 [任务状态与运行清单设计](../docs/design/control-plane-state-and-run-manifest.md) 与 [持久化和恢复设计](../docs/design/control-plane-persistence-and-recovery.md)。

### 第 3 步实际结果

- 新增 `@emi-harness/control-plane`，使用 Node.js 内置 SQLite 保存 Task、Approval、ApprovalDecision、Run、RunManifest、RoleRun、追加式 Transition、幂等 Command 和 outbox；关闭并重开文件数据库后可以恢复权威状态。
- 数据库迁移带固定摘要并原子应用，开启 foreign keys、WAL、同步写、defensive mode 和 busy timeout；不可变 Artifact、Manifest、Decision、Transition 和 Command 由触发器拒绝更新与删除。
- Task、Run 与 RoleRun 使用单调版本阻止过期覆盖；部分唯一索引阻止同一个 Task 出现两个未结算 Run，以及同一个 Run 出现两个未结算 RoleRun。
- RunManifest 先按 Schema 对无顺序集合稳定排序，再使用 RFC 8785 兼容的规范 JSON 和 SHA-256 封存；授权激活、角色启动、交接、验证、返工、取消与验收的多记录变化在单个事务中提交。
- Approval 支持多角色聚合、职责分离、附条件批准边界、撤回、到期和撤销；每次授权和创建 RoleRun 前重新检查当前批准仍有效。
- RoleRun 在创建 Pi Session 前持久化，租约取得与接管递增 fencing token；旧 Worker、过期租约和旧版本写入会被拒绝，启动恢复计划只读取数据库当前记录和 outbox。
- 4 个测试文件中的 10 个场景已经覆盖完整设计到验收状态链、Command 重放与冲突、事务回滚、数据库重开、唯一和不可变约束、审批到期、运行中取消、租约接管与旧 token 拒绝。

本步只保存 Tool Operation 引用，不实现工具意图、执行和结果对账；该账本属于第 5 步。Control Plane 也不自行判断 EMI 资源适用性或验证代码正确性，分别由第 4 步资源边界和第 6 步 Assurance 接入。

### 第 2 步实际结果

- 新增 `@emi-harness/runtime-pi`，只通过自有 `PiRuntimePort`、请求、Session、Tool 和 Event 类型向外提供能力，构建检查会阻止公共声明暴露 Pi 类型。
- 精确锁定 `@earendil-works/pi-ai`、`pi-agent-core` 和 `pi-coding-agent` `0.84.2`，对应走读 commit 为 `59a71b235dadb4ad0d67557a8abb0aaa093e68b4`；工作区脚本会检查锁版和“只有 `runtime-pi` 可以直接依赖 Pi”的边界。
- 自建 ResourceLoader 只返回运行请求传入的系统提示、追加提示和上下文文件，拒绝运行中扩展资源；契约测试证明目标目录中的 `AGENTS.md` 不会被默认发现。
- 模型目录只使用锁定 Pi 包内置版本并关闭目录网络刷新，不读取环境中的 `models.json`、`auth.json` 或环境变量凭据；调用方必须通过自有解析器显式提供所选 Provider 的 API Key。
- 每个 Session 始终传入精确工具列表，包括空列表；Pi 内置文件和 Shell 工具被适配器拒绝，Session 创建后再次核对实际启用工具。
- Pi 事件被转换为带 Run ID、Role Run ID、角色和 Session ID 的 EMI 事件；结束结果区分完成、中断、错误、不完整和未知。异步事件监听按顺序完成，监听失败不会打断 Pi，但会使本次 `run()` 在 Pi settled 后失败。
- 无网络 Faux Provider 契约测试已实际执行正常工具调用和活动请求中断，确认中断结果先产生 `agent.ended(outcome=aborted)`，随后产生 `agent.settled`。

本步只证明 Pi 的受控嵌入边界。当前 Session、Settings 和测试凭据均不承担 EMI 权威状态；持久化任务状态、运行清单、审批和恢复属于第 3 步。

## v0.1 工程完成条件

- 从干净环境可以安装精确锁定的 Pi 版本并通过 `PiRuntimePort` 启动角色 Session。
- 受控 ResourceLoader 只加载运行清单声明的资源，项目或用户的默认 Pi 资源无法进入受控运行。
- Agent 只能看到精确工具白名单，任何有副作用的操作都经过 Tool Gateway 和隔离执行边界。
- 同一个验证任务可以从 PRD 和 EMI Context 形成 TRD，经人工批准后执行。
- Executor 与 Verifier 使用独立 Session 和权限，失败能够回到正确步骤，超过限制后停止自动执行。
- 工程校准任务的目标、PRD、规则来源、TRD、人工门禁、代码变更、检查结果和待用户验收对象能够互相对应。
- 运行中断后可以从 EMI 自有任务状态恢复，并能识别需要对账的未知工具结果，不依赖原有聊天记录。
- 仓库所有者确认本次工程基线按 V0.1 发布；真实项目最终验收在后续校准中逐任务完成，不由 Agent 代替。

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
