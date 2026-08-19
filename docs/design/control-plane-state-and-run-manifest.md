# Control Plane 任务状态与运行清单设计

- 状态：设计中
- 对应 Roadmap：v0.1 第 3 步
- 最后更新：2026-08-19

## 目标

建立不依赖 Pi Session 的最小权威状态和运行记录，使 Control Plane 能够可靠判断任务当前阶段、允许的下一步、人工批准的具体对象、一次运行使用的固定配置，以及每个角色的实际执行结果。进程重启后必须从这些记录恢复，而不是读取 Agent 对话推断流程位置。

本步不实现完整工作流平台、受控 EMI 资源、Tool Gateway、独立验证或端到端交付；这些能力继续按 Roadmap 后续步骤接入。

本设计是用于真实项目校准的 v0.1 基线。实际运行发现遗漏或摩擦后，可以根据对应 Task、Run 和 Evidence 提出修改，但每项修改都必须经过讨论、版本化文档和自动化检查后进入新版本。任何修改不得改变已经封存的 RunManifest、历史状态或证据，也不得在 v0.1 中由 Harness 自动改写自身规则。

## 已确认的记录

```text
Task
├── TaskTransition[]
├── Approval[]
│   └── ApprovalDecision[]
└── Run[]
    ├── RunManifest
    └── RoleRun[]
        └── Pi Session ID
```

| 记录 | 职责 |
| --- | --- |
| **Task** | 表示一个用户交付目标，保存当前阶段、当前版本和最终结果。 |
| **TaskTransition** | 追加记录状态变化、操作者、原因以及审批和证据引用。 |
| **Approval** | 保存绑定确定对象标识、版本和哈希的待审批请求，并聚合所需 Human Authority 作出的决定。 |
| **ApprovalDecision** | 追加记录一个 Human Authority 对该请求作出的决定、理由、条件和证据，不允许原地修改。 |
| **RunManifest** | 锁定一次受控运行使用的任务版本、角色、Runtime、资源、工具、策略、目标仓库基线和审批。 |
| **RoleRun** | 记录某个角色的一次实际执行或重试，并关联 Pi Session 和运行结果。 |

## 已确认的不变量

- Task 是判断当前任务阶段的依据，TaskTransition 是状态变化历史；两者必须在同一持久化事务中更新。
- 状态变更必须检查调用方看到的 Task 版本，过期版本不能覆盖已经发生的更新。
- Approval 必须绑定被审批对象的标识、版本和 SHA-256；对象内容变化后必须重新批准。
- RunManifest 使用确定性序列化计算 SHA-256，封存后不提供修改能力；任何已锁定内容变化都生成新的 Run ID 和 Manifest。
- Manifest 摘要只能帮助发现内容变化，不宣称能够代替数字签名、数据库权限或其他存储安全措施。
- 没有满足门禁要求的 Approval，不能创建可执行的 RoleRun。
- 每次角色执行或重试使用独立 Role Run ID；Executor 与 Verifier 不能共享 RoleRun 或 Pi Session。
- Pi Session ID 只用于关联 Agent 工作记录，不能改变 Task 状态、批准事项或交付结论。
- 进程重启后必须仅依赖 Control Plane 持久化记录确定任务状态和恢复动作。

## 已确认的 Run 边界

Run 表示一个已批准 TRD 版本在固定输入、权限和目标代码基线下获得授权的一次交付尝试。Run 不等同于整个 Task、一次模型调用或一个 Pi Session。一个 Task 可以有多个 Run；一个 Run 只对应一个不可变 RunManifest，并可以在获准范围和重试限制内包含多个 RoleRun。

同一个 Run 可以依次包含 Executor 实现、Verifier 验证、Executor 范围内返工和 Verifier 复验。每个 RoleRun 表示一个角色的一次实际执行或重试，对应一个独立 Pi Session，并记录实际消费和产生的制品。Pi Session 内部的 Provider 或模型重试仍属于同一个 RoleRun；RoleRun 结束后重新启动 Agent 必须创建新的 RoleRun。

以下任意已锁定内容变化时，当前 Run 必须终止，并在 Task 重新满足前置门禁后创建新 Run：

- PRD、ContextManifest 或 TRD 的版本或摘要。
- 目标仓库的固定基线提交；Executor 在隔离工作区内产生的获准输出不视为外部基线变化。
- Pi、Adapter、Harness 或模型版本。
- 角色、资源、Skill、Prompt、工具白名单或策略。
- 执行范围、权限、隔离方式或审批条件。
- 已批准的重试或返工限制。

RoleRun 状态、Pi Session ID、代码和测试制品、Verifier 结果、工具操作证据、条件满足证据以及获准范围内的返工属于运行事实或输出，不修改 RunManifest。每个 RoleRun 必须绑定其实际输入和输出制品，防止 Verifier 检查过期的 Executor 结果。

v0.1 的并发边界如下：

- 一个 Task 同时最多只有一个活动 Run。
- Executor 与 Verifier 不得同时执行，也不得共享 RoleRun 或 Pi Session。
- 后续需要并行 Executor 时，必须由新版本 RunManifest 明确声明，不能由 Agent 临时扩展。

## 已确认的 RunManifest V1

RunManifest 只保存本次执行获准使用的输入、能力和限制。运行状态、输出、证据和秘密值不进入 Manifest。

```ts
type VersionedRef = {
  id: string;
  version: string;
  digest: string;
};

type ApprovalCondition = {
  conditionId: string;
  description: string;
  owner: string;
  requiredBefore: "planning" | "execution" | "acceptance";
  verificationMethod: string;
  evidenceRefs: string[];
};

type RunManifestV1 = {
  schemaVersion: "1";
  runId: string;
  composedAt: string;
  composedBy: string;

  task: {
    taskId: string;
    taskRevision: number;
  };

  inputs: {
    prd: VersionedRef;
    contextManifest: VersionedRef;
    trd: VersionedRef;
    executionPlan: VersionedRef;
    prerequisiteApprovals: VersionedRef[];
  };

  target: {
    repositoryId: string;
    baseCommit: string;
    approvedPatch?: VersionedRef;
    allowedPaths: string[];
  };

  runtime: {
    harnessCommit: string;
    adapter: VersionedRef;
    piPackages: VersionedRef[];
    environment: VersionedRef;
  };

  roles: RolePlan[];

  policies: {
    policyRefs: VersionedRef[];
    approvalConditions: ApprovalCondition[];
    maxRoleRuns: number;
    maxDurationMs: number;
  };

  verification: {
    acceptanceCriteria: VersionedRef;
    requiredChecks: VersionedRef[];
    requiredEvidence: string[];
  };
};
```

每个 RolePlan 锁定一个角色能够使用的能力：

```ts
type RolePlan = {
  rolePlanId: string;
  role: "coordinator" | "executor" | "verifier";

  model: {
    provider: string;
    modelId: string;
    thinkingLevel?: string;
  };

  resources: VersionedRef[];
  skills: VersionedRef[];
  prompts: VersionedRef[];

  tools: {
    name: string;
    version: string;
    definitionDigest: string;
    policyRef: VersionedRef;
  }[];

  isolationProfile: VersionedRef;

  credentialBindings: {
    bindingId: string;
    provider: string;
    scopes: string[];
  }[];

  limits: {
    maxAttempts: number;
    timeoutMs: number;
  };
};
```

字段规则如下：

- 所有资源、Skill、Prompt、Policy、工具定义和环境配置都必须具有确定版本和摘要。
- 目标仓库基线必须使用固定 commit，不能只记录可移动的 branch。未提交代码必须拒绝，或者先封存为带摘要的 `approvedPatch`。
- `credentialBindings` 只保存凭据引用和授权范围，不保存 API Key、令牌、密码或环境变量明文。
- 本地绝对路径不进入 Manifest；Integration 将 `repositoryId` 解析到受控工作区。
- Executor 与 Verifier 使用不同 RolePlan、工具权限和 Pi Session。
- Manifest 记录模型 Provider、模型 ID 和参数，但不宣称能够复现远程模型的具体输出。
- Manifest 使用确定性 JSON 序列化计算 SHA-256；摘要保存在 Run 记录中。Manifest 封存后不提供更新接口，任何字段变化都创建新 Run。

Pi Session ID、开始与结束时间、运行状态、Agent 消息或推理、代码差异、输出提交、测试结果、工具调用与结果、Verifier 结论、用户验收和 RoleRun 实际重试次数属于运行事实、输出或证据，不进入 RunManifest。

RunManifest 可以包含 TRD 等前置 Approval 引用，但授权执行该 Manifest 的 Run Authorization Approval 不能进入 Manifest，否则会形成审批引用依赖 Manifest 摘要、Manifest 摘要又包含审批引用的循环。Run Authorization Approval 保存在 RunManifest 外部并绑定其摘要；只有它满足门禁后，Control Plane 才能创建可执行 RoleRun。

## 已确认的 Manifest 封存与执行授权

### `seal_run_manifest`

`planning` 阶段先形成版本化执行计划，再通过 `seal_run_manifest` 组合并封存 RunManifest。Control Plane 不保存可原地修改的 Manifest 草稿；Coordinator 可以生成新的执行计划版本，但每次成功封存都创建新的 Run 和 Manifest。

封存前必须满足：

- Task 处于 `planning`，请求携带正确的 `expectedTaskVersion` 和唯一 Command ID。
- TRD Approval 仍然有效，执行计划已经版本化并生成摘要。
- Manifest 中所有资源、策略、工具和环境引用都能从权威来源解析且摘要一致。
- 目标仓库仍处于声明的基线 commit，或者准确匹配已批准 Patch。
- 当前 Task 不存在另一个待授权或活动 Run。
- 所有 `planning` 前 ApprovalCondition 已满足并具有有效证据。

Manifest 使用 RFC 8785 JSON Canonicalization Scheme 生成规范 JSON，以 UTF-8 编码计算 SHA-256，并按 `sha256:{lowercase hex}` 保存摘要。没有顺序语义的数组必须按 Schema 规定的稳定键排序。

Control Plane 必须在同一事务中重新读取并校验所有权威引用，生成 Run ID 和最终 Manifest，保存规范 Manifest 与摘要，创建绑定该摘要的 `run_authorization` Approval，并记录 Run 正在等待授权。Task 状态保持 `planning`。同一 Command ID 重复提交时必须返回第一次封存结果，不能创建第二个 Run。

### Run Authorization

决策命令为 `record_run_authorization_decision`。授权人批准的是目标仓库与路径范围、模型与上下文资源、工具与网络权限、隔离环境与凭据范围、执行限制、职责分离、验证和证据要求。

v0.1 的每个 Run 都要求 Human Authority 明确授权，不允许自动授权。Run Authorization 只接受以下最终结果：

| 结果 | 处理 |
| --- | --- |
| **`approved`** | 所需授权全部满足后执行激活前校验。 |
| **`changes_requested`** | 当前 Manifest 永久保留但不可执行；Task 保持 `planning`，修改执行计划后创建新 Run。 |
| **`rejected`** | 当前 Run 不可执行，Task 进入 `blocked`。 |

Run Authorization 不允许新增 `approved_with_conditions`。授权人提出的新条件必须先进入新的 RunManifest，再重新计算摘要和审批，不能把未锁定条件附在 Manifest 外。

### `planning -> executing`

最后一个所需授权决定形成后，Control Plane 必须重新校验 Task、Run、Manifest 和 Approval 版本，PRD、ContextManifest、TRD 和前置审批有效性，目标仓库基线，所有 `execution` 前条件，资源、工具、策略、隔离和凭据绑定，以及同一 Task 没有其他活动 Run。

全部通过后，Control Plane 在同一事务中记录 Run 已授权，将 Task 更新为 `executing` 并增加版本，然后追加引用 Run ID、Manifest 摘要和 Run Authorization Approval 的 TaskTransition。事务提交前不得创建 Pi Session、RoleRun 或执行工具；提交后才能创建第一个 Executor RoleRun。

如果提交事务后、创建 RoleRun 前发生中断，恢复程序根据处于 `executing` 的 Task、已授权 Run 和不存在 RoleRun 的事实安全继续，不读取 Pi 对话推断。Run Authorization 已批准但 `planning -> executing` 事务尚未提交时，如果发现代码基线或其他锁定内容变化，当前 Run 不得激活；Task 保持 `planning`，并创建新的 Run 和 Manifest。事务提交后的外部变化如何停止和恢复，纳入后续中断与对账设计。

## 已确认的 Task 状态

| 状态 | 含义 |
| --- | --- |
| **`intake`** | Task 已创建，正在确认 PRD、目标、范围和初始风险。 |
| **`contextualizing`** | 正在确定司法辖区、业务场景和适用的 EMI Context。 |
| **`drafting_trd`** | 正在编写或修订 TRD。 |
| **`awaiting_trd_approval`** | TRD 已形成，正在等待 Human Authority 审批。 |
| **`planning`** | TRD 已批准，正在分解任务并生成、封存 RunManifest。 |
| **`executing`** | Executor 正在按获准的 RunManifest 实现或返工。 |
| **`verifying`** | Executor 已提交结果，Verifier 正在独立验证。 |
| **`awaiting_acceptance`** | 验证已经通过，正在等待最终用户验收。 |
| **`blocked`** | 自动流程已经停止，正在等待外部条件、人工判断或结果对账。 |
| **`closed`** | Task 已结束，结果为 `completed` 或 `cancelled`。 |

- `blocked` 只用于异常等待；正常的 TRD 审批和最终验收使用各自的等待状态。
- 每次进入 `blocked` 都必须记录原因、现有证据、恢复条件和允许恢复到的状态。
- Human Authority 是状态转换的操作者或批准者，不是 Task 状态。
- Task 不使用 `failed` 终态。单次 Agent 或工具执行失败属于 RoleRun 或后续 Tool Operation 的结果，Task 必须明确进入返工、阻塞或取消路径。
- `closed` 时必须存在 `completed` 或 `cancelled` 结果；其他状态不得提前保存最终结果。

## 已确认的状态转换

Agent、用户或确定性流程只能向 Control Plane 请求状态转换，不能直接修改 Task。Control Plane 必须检查当前状态、调用方看到的 Task 版本、输入、权限和门禁，并在同一持久化事务中更新 Task 和追加 TaskTransition。

### `start_contextualization`

```text
intake -> contextualizing
```

这条转换表示任务目标和 PRD 已经达到可分析程度，可以开始确定适用的 EMI Context。

转换前必须满足：

- Task 当前状态是 `intake`。
- 请求携带与当前 Task 一致的 `expectedTaskVersion`。
- 用户目标明确且非空。
- Task 已绑定确定的 PRD ID、版本和 SHA-256。
- PRD 至少包含目标、范围、不做什么、业务验收标准和责任人；小任务可以使用满足这些字段的精简 PRD。
- 初始风险等级、请求者身份和转换原因已经记录。

本转换只开始受控分析，不执行代码、不调用有副作用的工具，也不形成监管结论，因此不需要额外 Approval。

Control Plane 必须在同一事务中：

1. 校验当前状态和 `expectedTaskVersion`。
2. 校验 PRD 引用、版本、摘要和最小内容。
3. 将 Task 状态更新为 `contextualizing` 并增加 Task 版本。
4. 追加包含 Transition ID、Task ID、Command ID、原状态、目标状态、原版本、目标版本、请求者、原因、PRD 引用和发生时间的 TaskTransition。

请求必须携带唯一 Command ID。同一 Task 重复提交同一个 Command ID 时返回第一次转换的结果，不重复更新 Task 或追加记录。PRD 信息不足时 Task 保持 `intake` 并返回缺失字段；Task 版本过期或当前状态不符时拒绝转换，调用方必须重新读取权威状态。

### `complete_contextualization`

```text
contextualizing -> drafting_trd
```

这条转换表示当前 Task 适用的 EMI Context 已经形成并封存，可以据此开始技术设计。

转换前必须满足：

- Task 当前状态是 `contextualizing`，请求携带与当前 Task 一致的 `expectedTaskVersion`。
- ContextManifest 已持久化并封存，具有 Context ID、版本和 SHA-256。
- ContextManifest 绑定的 PRD ID、版本和 SHA-256 与 Task 当前绑定一致。
- 已明确牌照主体与角色、司法辖区、产品和业务场景、客户类型及数据类型。
- 每条适用规则都具有来源、版本、适用范围、确认状态和责任人。
- 每项适用性判断和监管解释都能关联到已批准政策或 Human Authority 的有效确认记录。
- 不存在尚未解决的阻塞事项。

待确认事项必须记录问题描述、是否阻塞、分类依据、责任人和证据引用。非阻塞事项可以保留，但必须进入 TRD 的已知限制并持续追踪；阻塞事项存在时 Task 保持 `contextualizing`。Agent 不能自行把问题标记为非阻塞：能够由确定性政策判断的按政策执行，其余必须由 Human Authority 确认。

来源冲突、来源版本失效、适用司法辖区不明确，以及会影响资金、账务、AML 与制裁控制、客户权利、个人数据或核心验收标准的问题默认阻塞，除非有效政策或 Human Authority 明确作出其他决定并记录依据。

本转换不额外要求一次笼统审批，但所有需要人工判断的内容必须已经具有有效确认依据。Agent 可以整理 EMI Context，不能确认监管结论；Control Plane 只接受满足上述门禁的 ContextManifest。

Control Plane 必须在同一事务中校验 Task、PRD 和 ContextManifest 的版本与摘要，确认阻塞事项为零，将 ContextManifest 绑定到 Task，将状态更新为 `drafting_trd` 并增加 Task 版本，然后追加包含 ContextManifest 和确认依据引用的 TaskTransition。ContextManifest 校验失败、PRD 已变化或存在阻塞事项时不写入任何状态变化。

### `submit_trd_for_approval`

```text
drafting_trd -> awaiting_trd_approval
```

这条转换表示 TRD 已达到可审批状态并封存，正在等待 Human Authority 对这个确定版本作出决定。

TRD 不采用固定章节数量，但至少必须覆盖：

- **身份与输入**：TRD ID、版本，以及 Task、PRD 和 ContextManifest 的 ID、版本与 SHA-256。
- **范围与结果**：目标、范围、不做什么、涉及的系统或模块、假设和限制。
- **技术设计**：系统行为、领域模型、状态、数据、接口、组件关系和关键技术决定。
- **控制与追溯**：每项 PRD 需求和 EMI Context 控制如何落实；不适用项必须说明理由。
- **验证与交付**：可执行的验收条件、测试方式、失败处理、迁移、发布和回滚要求。
- **风险与待决项**：风险、已知限制、非阻塞待确认项、责任人和所需审批角色。

小任务可以简化篇幅，但不能省略必要信息；不适用部分必须标记 `N/A` 并说明原因。

转换前必须满足：

- Task 当前状态是 `drafting_trd`，请求携带与当前 Task 一致的 `expectedTaskVersion`。
- TRD 绑定的 PRD 和 ContextManifest 仍是 Task 当前版本。
- TRD 已通过结构、必填字段和引用完整性检查。
- 每项范围内 PRD 需求都能追溯到技术设计和验收条件。
- 每项适用 EMI 控制都能追溯到技术控制和验证方式。
- 不存在阻塞的技术决定或待确认事项。
- 当前风险等级已经根据有效策略解析出所需审批角色。
- TRD 已持久化、封存并生成 SHA-256；提交后不允许原地修改。

确定性 Schema 和引用检查只能证明结构与追溯关系完整，不能证明设计正确。设计正确性必须由后续 Human Authority 审批和 Verifier 检查。

Control Plane 必须在同一事务中校验 Task、PRD、ContextManifest 和 TRD，创建绑定 TRD ID、版本和摘要的 `pending` Approval，将 Task 状态更新为 `awaiting_trd_approval` 并增加版本，然后追加 TaskTransition。待审批记录至少包含 Approval ID、Task ID、`trd_approval` 门禁类型、被审批对象类型、ID、版本、摘要、要求的审批角色、审批策略版本、请求者、请求时间和 `pending` 状态。

同一个 TRD 摘要只能存在一个有效的待审批请求。TRD 内容发生任何变化时，当前请求失效，必须生成新版本和摘要后重新提交。Agent 可以起草并请求提交，但不能批准自己的 TRD。外部审批系统通知在事务提交后执行；通知失败不回滚权威审批请求，而是保留待发送状态并安全重试。

### TRD Approval 决策与回流

一个 TRD Approval 可以根据审批策略要求多个 Human Authority 分别决策。每个人的决定以不可修改的 ApprovalDecision 追加保存；在所需决定全部满足前，Task 保持 `awaiting_trd_approval`。单个人的批准不能代替 Approval 的聚合结果。

决策命令为 `record_trd_approval_decision`。该命令始终追加一项审批决定，但只有聚合结果达到终态时才产生 Task 状态转换；仍需等待其他审批人时，Task 状态保持不变。

最终结果与 Task 状态对应如下：

| 结果 | Task 处理 |
| --- | --- |
| **`approved`** | 所有要求的审批角色均已满足，进入 `planning`。 |
| **`approved_with_conditions`** | `planning` 前条件满足后进入 `planning`；只包含后续门禁条件时可以进入 `planning`。 |
| **`changes_requested`** | 技术设计问题返回 `drafting_trd`，EMI Context 或适用性问题返回 `contextualizing`，PRD、目标或范围问题返回 `intake`。 |
| **`rejected`** | 进入 `blocked`，由授权人员决定重新开始或取消，不直接关闭 Task。 |

原 TRD、ContextManifest 和 PRD 版本保持不可修改。修改时必须创建新版本，旧审批请求和意见继续作为历史证据保留。

附条件批准的每个条件必须记录 Condition ID、描述、责任人、`planning`、`execution` 或 `acceptance` 生效门禁、验证方式和证据引用：

- `planning` 前条件未满足时，Task 继续停留在 `awaiting_trd_approval`。
- `execution` 或 `acceptance` 前条件可以允许 Task 进入 `planning`，但必须进入 RunManifest 并由对应状态门禁检查。
- 会改变 TRD、监管解释或核心验收标准的事项不能作为附加条件，必须使用 `changes_requested` 并重新审批。
- Agent 不能自行宣布条件已经满足。

每条 ApprovalDecision 至少记录 Decision ID、Approval ID 与版本、决定、Authority ID 与角色、理由、结构化条件、证据引用和决定时间。审批策略确定所需角色、聚合规则、审批人与作者或提交人的独立性，以及审批有效期。

Control Plane 记录决定时必须校验审批人身份与角色、Approval 版本，以及绑定的 TRD、PRD 和 ContextManifest 是否仍然有效，然后追加 ApprovalDecision 并重新计算 Approval 结果。只有形成最终结果时，才在同一事务中更新 Task、增加 Task 版本并追加 TaskTransition；仍需等待其他决定时不改变 Task 状态。

## 待确认问题

1. 其余合法状态转换、每次转换所需的输出与门禁，以及阻塞后的恢复规则。
2. Approval 请求撤回、超时失效和批准后撤销如何生效。
3. Run 和 RoleRun 的字段、状态与版本。
4. 持久化数据库、事务边界、迁移方式和并发控制。
5. Agent 启动、运行和完成各阶段发生进程中断时的恢复与对账语义。
6. 第 3 步的自动化验收条件。
