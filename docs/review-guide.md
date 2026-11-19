# EMI Harness Review 指南

本文件帮助 reviewer 从当前实现出发检查架构、代码和测试。阅读对象是 v0.1 工程基线及其后续文档补充；开始 review 时请记录 `git rev-parse HEAD` 和工作树状态。本文整理于 2026-09-08，未代表独立 review 已完成。

## 1. 先确定审查范围

EMI Harness 用 Pi 执行 Agent 工作，自有代码管理任务状态、授权、工具操作、检查和证据。当前交付形态是 8 个 TypeScript 库（6 个职责包和 2 个技术基础包）和一个本地校准命令，尚无完整业务 CLI、HTTP 服务、审批界面或常驻任务调度服务。

- [根 README](../README.md) 说明目标架构；[Roadmap](../roadmap/README.md) 记录各步实现；[v0.1 发布记录](releases/v0.1.0.md) 固定历史验收范围和限制。
- 本次重点检查控制面与 Runtime 的分工、权限与数据边界、失败恢复、验证与交付证据，以及测试能否支撑相应结论。
- 法规解释、真实模型效果、用户业务验收和生产就绪需要各自的验证。本仓库的工程测试不覆盖这些结论。
- `emi-knowledge` 是独立专家知识库。当前 Registry 使用本仓库内的一条 Context 和一个 Skill，代码尚未自动消费 `emi-knowledge` 的发布物。
- `demo/`、`.gstack/`、`xx.txt` 和本地环境文件不属于本次交付；无需读取凭据或其他本机私有资料来完成 review。

## 2. 推荐阅读顺序

1. 阅读 [AGENTS](../AGENTS.md)、根 README 的“EMI Harness 是什么”和“当前阶段”，确认目标与实现范围。
2. 阅读已接受的 [ADR 0002：Pi Runtime 边界](decisions/0002-adopt-pi-runtime-with-emi-control-plane.md) 、[ADR 0003：SQLite 持久化](decisions/0003-use-sqlite-for-v0.1-control-plane.md) 和 [ADR 0004：基础技术包](decisions/0004-extract-canonical-json-and-sqlite-ledger.md)。ADR 0001 已被替代，只作历史记录。
3. 阅读 [真实 Pi 目标项目 E2E](../packages/integration/test/pi-target.e2e.test.ts) 及其 [组装 fixture](../packages/integration/test/fixtures.ts)，看实际由谁创建输入、批准运行、调用各包和检查输出。Fixture 中的身份、审批和模型回答是测试数据。
4. 从 [RoleExecutionCoordinator](../packages/integration/src/role-execution-coordinator.ts) 的 `execute()`、`verify()` 顺着调用进入各包，再检查对应测试与异常分支。
5. 按本文件的验证命令复现，逐项记录设计要求、实现行为、测试覆盖和待确认条件。不要仅依据 README 或注释认定某项保障已成立。

### 包与入口

每个包通过 `src/index.ts` 导出公共 API，`src/types.ts` 或 `src/contracts.ts` 定义输入输出。除 Runtime 使用普通异常外，其余包的自有错误码见 `src/errors.ts`。从 workspace 导入包时使用构建后的 `dist`，首次检查应从根目录运行。

| 包 | 主要入口与输入 | 输出与使用方 |
| --- | --- | --- |
| [control-plane](../packages/control-plane/README.md) | `SqliteControlPlane`；带 Command ID、Actor 和版本条件的命令 | Task、Approval、Run、RoleRun、Artifact、Transition 与 outbox；供 Integration、Gateway Authority 和候选包导出读取 |
| [runtime-pi](../packages/runtime-pi/README.md) | `PiRuntimePort.startSession()`；角色、模型、资源快照和精确工具列表 | 中立的 Runtime Session、事件和运行结束结果；供 Integration 调用 |
| [resource-registry](../packages/resource-registry/README.md) | `FileResourceRegistry.load()/project()`；明确资源引用和角色 | 校验后的 Manifest、内容及 Runtime 文本投影；供 Integration 加载 |
| [tool-gateway](../packages/tool-gateway/README.md) | `SqliteToolGateway.invoke()/reconcile()`；工具请求或 Operation ID | 权限决定、操作意图、执行/对账结果；供 Runtime 工具适配与 Evidence 收集使用 |
| [assurance](../packages/assurance/README.md) | `AssuranceService`；必需检查定义、执行对象、Verifier 提交 | Check Evidence 与经过门禁检查的 Verification 内容；供 Integration 使用 |
| [integration](../packages/integration/README.md) | `RoleExecutionCoordinator` 与 `CandidateEvidencePackageBuilder`；已授权 Run、角色请求或导出请求 | 角色交接结果、状态变化、候选 Evidence Package；当前使用方为测试和本地校准 |

`integration` 依赖其余 5 个职责包和 `canonical-json`；三个账本包通过 `sqlite-ledger` 打开数据库、应用迁移和执行事务，规范 JSON 与摘要只在 `canonical-json` 实现一次。只有 `runtime-pi` 直接依赖 Pi；`tool-gateway` 通过 `ControlPlaneAuthorityReader` 的结构化接口读取控制面。当前多个构造参数仍使用具体实现类型，替换存储或执行方式需要逐个检查这些依赖。

## 3. 实际调用链

```text
可信宿主 / 校准 fixture
  -> Control Plane：登记 PRD、Context、TRD、检查等制品
  -> Control Plane：记录审批、封存 RunManifest、授权 Run
  -> RoleExecutionCoordinator.execute()
       -> Control Plane：准备 RoleRun、取得租约
       -> Registry：校验并加载资源
       -> PiRuntimePort：创建受控 Executor Session
            -> workspace.write_text -> Gateway -> Node 文件操作子进程
            -> harness.submit_execution -> 内存中的结构化提交收集器
       -> 对账工具操作、保存 Evidence、提交 ExecutionResult
       -> Control Plane：Task 进入 verifying
  -> RoleExecutionCoordinator.verify()
       -> 新建 Verifier RoleRun 和 Session
       -> Assurance -> Node 检查子进程 -> Check Evidence
       -> Verifier 获得检查观察，提交结构化结论
       -> Assurance 核对证据、检查覆盖和结论
       -> Control Plane：PASS 时进入 awaiting_acceptance
  -> CandidateEvidencePackageBuilder：读取三个账本并导出候选包
  -> 授权人员验收：单独调用 acceptDelivery()，记录最终决定
```

### 需要区分的几件事

- `RoleExecutionCoordinator` 是确定性编排代码。当前仅提供 Executor 和 Verifier 路径；Coordinator Agent 自动编写 PRD/TRD 的完整链路尚未接入。校准通过 fixture 创建前置制品和审批。
- `execute()` 每次调用处理一个 Executor RoleRun。已知失败后的再次调用由宿主决定；E2E 显式创建第二个 RoleRun，没有后台无限重试循环。
- Runtime 的 `completed` 表示 Agent 本次运行结束；RoleRun 的 `succeeded` 表示角色工作已结算；Verification 的 `pass` 表示验证结论；Task 的 `closed/completed` 才表示最终接受。Verifier RoleRun 成功结束时仍可提交 `fail`。
- Executor 自动获得 TRD、ExecutionPlan、AcceptanceCriteria 和获准资源；Verifier 自动获得绑定的 ExecutionResult、AcceptanceCriteria、获准资源及检查观察。当前 Verifier 没有源码读取工具，也没有自动装配完整 diff 与 TRD 的通用审查能力。
- `acceptDelivery()` 更新控制面状态并写入 `evidence.export_requested` outbox，不执行 Git 合并或部署。当前候选包 builder 服务于验收前阶段，验收后正式包导出服务尚未实现。

## 4. 状态与信任边界

### 三个账本与工作区

| 存储 | 权威内容 | 当前实现边界 |
| --- | --- | --- |
| Control Plane SQLite | 任务与运行状态、审批、不可变制品、状态变更、命令结果、outbox | 单个命令在本库事务内提交；v0.1 部署约定为单写进程 |
| Tool Gateway SQLite | Operation 状态、Decision、Intent、Result、Transition | 工具意图与 `executing` 派发准备先落账，最终同步检查通过后才调用 Executor；与目标文件操作不共用事务 |
| Evidence SQLite | Runtime 摘要、工具操作快照、执行结果、检查观察、验证门禁记录 | 写入不可变记录，读取核对摘要；调用方负责生产者身份及访问权限 |
| Pi Session 与临时收集器 | Agent 上下文、事件、结构化提交 | 当前 Session 在内存中；事件在运行结束后转换为 Evidence，未逐事件持久化 |
| 目标项目工作区与候选 JSON | 实际代码、检查脚本、导出的候选交付材料 | 工作区是可变文件系统；候选包使用内容摘要，未提供签名、可信时间戳或防篡改存储 |

三个 SQLite 数据库没有跨库事务。Integration 分步写入各库，再完成角色交接；review 需要沿着每个写入点检查中断后的可恢复性。Control Plane 的 `planRecovery()` 返回恢复建议，不会自行执行 outbox、重启 Agent 或启动恢复守护进程。

Gateway 的初始异步 `authorize()` 只产生策略快照。新请求与历史 `authorized` 请求都必须先持久化 `executing` / `dispatch_prepared`，再调用必需的同步 `authorizeForDispatch()`，重检权威状态、策略与不可变 Intent 一致性及取消信号，随后不经 `await` 立即调用 `Executor.execute()`。最终检查缺失、抛错或返回 Promise/thenable 均关闭执行；未派发的拒绝保留原 Decision 和 Intent，并结算为已知 `failed`。单独的 `executing` 记录不能证明 Worker 已启动，准备后崩溃仍需对账。

当前子进程 Executor 在 `execute()` 调用内同步启动 Worker，以该调用作为本地派发边界。撤销先于最终派发会阻止新操作；已经派发的操作继续保存真实结果，结果不明时保持 `unknown` 并对账，不能因批准已撤销就宣称文件未写入。

### 宿主承担的责任

- 校准中 Pi SDK、Integration、Control Plane、Registry、Gateway 和 Evidence Store 同处主进程；文件操作与检查分别在 Node 子进程中运行。职责分离和进程分离应分别审查。
- 撤销与派发的顺序依赖 Control Plane 的全部状态写入、Gateway 和最终权限 Reader 位于同一个 Node.js 事件循环，Reader 同步读取权威事实；可信 Reader 和策略不得在最终检查中回入修改控制面状态。多进程、Worker Thread 或远程控制面需要另行设计排序协议，不能以缓存授权快照提供同等保障。
- `Actor.actorType`、`roles` 和 Worker 身份由调用方传入。控制面检查其字段和权限条件，仓库尚无登录认证、外部 IAM 或防伪造的身份凭证验证层。
- `RuntimeTool.execute` 是宿主提供的进程内回调。白名单限制 Agent 可选择的工具，回调实现、注册策略、Executor 和 CheckRunner 本身需要可信。增加任意自定义工具可能绕过既有 Gateway 路径。
- `repositoryId` 到本地根目录、Runtime 的 `cwd`、数据库路径、检查脚本和凭据解析器由宿主组装。需要确认这些配置一致，且 Agent 无法改写控制数据、策略和检查程序。
- 子进程采用最小环境变量、输入协议与路径限制，仍继承当前操作系统账户的权限。检查脚本可以执行任意 Node 代码；当前没有文件系统、网络、进程树和资源配额的完整沙箱。
- Runtime 通过显式 `resolveApiKey` 获取凭据，真实模型调用可能发送上下文并产生费用。离线测试不需要模型密钥；模型凭据、客户数据和生产配置不得用于这轮 review。
- 资源哈希用于核对固定版本，`active` 表示资源可加载。具体机构和任务的适用性、法规解释及责任人确认仍需单独完成。
- Evidence Store 接收内容并保存摘要，不提供通用敏感信息脱敏。检查的 stdout/stderr、工具 Intent 和资源快照可能进入证据包；公开前必须检查实际内容。

### 优先核对的设计要求

以下是审查线索，不预设结论，也不覆盖所有风险。

| 要求 | 实现入口 | 测试入口与核对方向 |
| --- | --- | --- |
| 命令重放不能产生第二次状态变化 | [Control Plane](../packages/control-plane/src/sqlite-control-plane.ts) 的 `command()` | [生命周期测试](../packages/control-plane/test/lifecycle.integration.test.ts)、[约束测试](../packages/control-plane/test/constraints.integration.test.ts)：相同 Command ID 的请求摘要、结果重放和版本冲突 |
| v0.1 不接受附条件批准 | Control Plane 的审批、Manifest 和有效授权检查；Gateway Authority | [控制面测试目录](../packages/control-plane/test)、[工具测试目录](../packages/tool-gateway/test)：拒绝 `approved_with_conditions`、非空决定条件和 Manifest 条件；历史条件记录不能继续放行，普通批准仍可完成闭环 |
| 旧 Worker 不能继续写状态或发起新操作 | Control Plane 的租约检查、[Gateway Authority](../packages/tool-gateway/src/control-plane-authority.ts) | [控制面恢复测试](../packages/control-plane/test/recovery.integration.test.ts)、[Gateway 测试](../packages/tool-gateway/test/gateway.integration.test.ts)：过期 token、取消和旧 Worker 请求 |
| 撤销先于派发时阻止操作 | Gateway 的 `dispatch()`、Authority 的同步 `authorizeForDispatch()` | [真实控制面撤销测试](../packages/integration/test/approval-dispatch.integration.test.ts) 与 [工具测试目录](../packages/tool-gateway/test/)：初始异步授权后撤销、历史 `authorized` 请求恢复、准备后取消、最终检查缺失/抛错/thenable、策略与 Intent 不一致；已派发操作仍按真实结果或 `unknown` 结算 |
| Pi 不自动加载环境资源或默认工具 | [受控 Session 工厂](../packages/runtime-pi/src/controlled-pi-session-factory.ts)、[ResourceLoader](../packages/runtime-pi/src/controlled-resource-loader.ts) | [Runtime 测试目录](../packages/runtime-pi/test)：空白名单、实际工具集、环境资源、上游契约和公共类型边界 |
| 资源引用与内容一致 | [Registry](../packages/resource-registry/src/file-resource-registry.ts) 的 `load()` | [资源安全测试](../packages/resource-registry/test/security.integration.test.ts)：索引、Manifest 原文摘要、内容摘要、角色和路径 |
| 未知副作用不能当普通失败重试 | [Gateway](../packages/tool-gateway/src/sqlite-tool-gateway.ts) 的 `dispatch()/reconcileOperation()`、Coordinator 的 `settleToolEvidence()` | [工具恢复测试](../packages/tool-gateway/test/recovery.integration.test.ts)、[角色集成测试](../packages/integration/test/role-execution.integration.test.ts)：已应用、未应用、分歧和 Runtime 失败叠加未知结果 |
| 验证针对绑定输出，PASS 受检查结果约束 | [AssuranceService](../packages/assurance/src/assurance-service.ts)、[NodeCheckRunner](../packages/assurance/src/node-check-runner.ts) | [Assurance 测试](../packages/assurance/test/assurance-service.test.ts)：检查集合、证据来源、独立 Session、错误 PASS；另核对工作区在执行与检查之间发生变化的情况 |
| 候选包不能冒充最终验收 | [候选包 builder 与验证函数](../packages/integration/src/candidate-evidence-package.ts)、Control Plane 的 `acceptDelivery()` | [Pi E2E](../packages/integration/test/pi-target.e2e.test.ts)、[控制面生命周期测试](../packages/control-plane/test/lifecycle.integration.test.ts)：待验收状态、账本覆盖、摘要、重复写入、验收权限 |

有三处容易从字段名称误判保障强度，请特别核对：

- `workspaceOutputDigest` 当前计算的是 Tool Operation 快照集合的摘要，没有对整个目标 Git tree 或 diff 取摘要；`changedPaths` 对照的是成功操作返回的路径。
- Check 引用摘要锁定 `CheckDefinitionV1` 对象。`NodeCheckRunner` 执行当前工作区里的 `.mjs` 文件，只校验 `baseCommit` 格式并把它记入观察，不自行 checkout、校验 HEAD 或核对脚本字节摘要。
- `verifyCandidateEvidencePackage()` 检查外层内容摘要与待验收标记，不重新执行所有业务、审批和跨账本约束。Builder 的生成时校验、导出后的摘要核对和独立可信验收需要分别评价。

## 5. 如何复现检查

### 环境与全量检查

需要 Git、Node.js `>=24.15.0` 和 pnpm `11.7.0`；版本要求见 [package.json](../package.json)。Pi 的三个依赖固定为 `0.84.2`，以 lockfile 和 [Runtime README](../packages/runtime-pi/README.md) 为准。

在仓库根目录运行：

```bash
git rev-parse HEAD
git status --short --branch
node --version
pnpm --version
pnpm install --frozen-lockfile
env -u EMI_HARNESS_E2E_TARGET_ROOT pnpm check
```

安装可能访问包仓库；检查不需要远程模型或真实密钥。清除 `EMI_HARNESS_E2E_TARGET_ROOT` 可让 E2E 使用临时目标，避免继承本机保留校准目录的配置。`pnpm check` 会检查仓库结构与声明的依赖边界，再执行各包类型检查、测试和构建；Runtime 还检查公共声明是否泄漏 Pi 类型。当前未配置独立的 formatter/linter 命令或 GitHub Actions 工作流，不要把该命令称为全套生产安全检查。

测试会产生 `dist/`，创建临时 SQLite 数据库和临时 Git 目标，执行 Node 子进程，并在结束时清理临时状态。v0.1 发布记录为 20 个测试文件、55 个测试；本次实际数量和结果应以 reviewer 的运行输出为准。

### 聚焦检查

先完成一次根目录检查，确保 workspace 依赖已构建，再按关注范围运行。例如：

```bash
pnpm --filter @emi-harness/control-plane check
pnpm --filter @emi-harness/tool-gateway check
env -u EMI_HARNESS_E2E_TARGET_ROOT pnpm --filter @emi-harness/integration exec vitest run test/pi-target.e2e.test.ts
```

[角色集成测试](../packages/integration/test/role-execution.integration.test.ts) 使用 Scripted Runtime 检查自有编排；[Pi E2E](../packages/integration/test/pi-target.e2e.test.ts) 使用真实 Pi AgentSession 和一次性 Faux Provider 回答，检查 SDK、工具和交接是否连通。两者都不能证明真实模型会正确理解需求或生成合格 EMI 实现。

### 保留一个独立校准目标

一般 review 运行全量检查即可。需要在磁盘上保留候选包时，先确保 Harness 工作树干净，再把下面路径替换成一个父目录已存在、目标目录尚不存在的绝对路径：

```bash
env -u EMI_HARNESS_E2E_TARGET_ROOT pnpm calibrate:v0.1 -- /absolute/path/to/new-review-target
```

[校准脚本](../scripts/run-v0.1-local-calibration.mjs) 会重新执行全量检查，再创建无远端的本地 Git 目标及测试基线提交。目标目录和 `.emi-harness/evidence/run-1.candidate.json` 会保留；三个运行账本位于临时状态目录，在 fixture 清理时删除，不构成长期运行服务。该命令不会替用户完成业务验收，也不会覆盖已有目标。历史校准的附加人工复核见 [校准记录](../calibrations/v0.1-local-typescript/README.md)。

## 6. 给另一个 AI 的任务说明

可以直接以本文件作为入口，并说明本轮希望侧重架构或代码。建议使用以下要求：

> 请先阅读 AGENTS.md 和 docs/review-guide.md，对 EMI Harness 当前版本进行独立 review。先检查架构和信任边界，再沿真实调用链检查实现、失败恢复与测试。默认只读，不修改代码、不读取本机凭据、不调用真实模型、不创建或推送提交。允许运行本文件列出的临时测试，记录其副作用和结果。区分目标架构、实际实现、测试证明和部署假设。每个发现提供严重性、文件与行号、触发条件、具体影响及可复现依据；无法确认的事项单列为问题。先报告发现，再列未覆盖的测试与结论限制。不要把所有未来能力直接列为当前缺陷，也不要用现有测试全绿替代独立判断。

review 结果建议记录：提交 SHA、工作树状态、范围、运行环境和命令、按严重程度排序的发现、待确认事项及未验证范围。修复应另行讨论，每项改动带回归检查，不改写已发布运行清单和历史证据。
