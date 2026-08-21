# Control Plane 任务状态与运行清单设计

- 状态：设计中
- 对应 Roadmap：v0.1 第 3 步
- 最后更新：2026-08-21

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
    ├── RunTransition[]
    ├── RunManifest
    └── RoleRun[]
        ├── RoleRunTransition[]
        └── Pi Session ID
```

| 记录 | 职责 |
| --- | --- |
| **Task** | 表示一个用户交付目标，保存当前阶段、当前版本和最终结果。 |
| **TaskTransition** | 追加记录状态变化、操作者、原因以及审批和证据引用。 |
| **Approval** | 保存绑定确定对象标识、版本和哈希的待审批请求，并聚合所需 Human Authority 作出的决定。 |
| **ApprovalDecision** | 追加记录一个 Human Authority 对该请求作出的决定、理由、条件和证据，不允许原地修改。 |
| **Run** | 保存一次受控交付尝试的当前状态、版本、最终结果及其 Manifest 关联。 |
| **RunTransition** | 追加记录 Run 每次被 Control Plane 接受的状态变化、原因和证据。 |
| **RunManifest** | 锁定一次受控运行使用的任务版本、角色、Runtime、资源、工具、策略、目标仓库基线和审批。 |
| **RoleRun** | 记录某个角色的一次实际执行或重试，并关联 Pi Session 和运行结果。 |
| **RoleRunTransition** | 追加记录 RoleRun 每次被接受的状态变化以及当时有效的 fencing token。 |

## 已确认的不变量

- Task、Run 和 RoleRun 当前记录分别是判断其当前状态的依据，对应 Transition 是追加式状态变化历史；当前记录和 Transition 必须在同一持久化事务中更新。
- 状态变更必须检查调用方看到的对应当前记录版本，过期版本不能覆盖已经发生的更新。
- Approval 必须绑定被审批对象的标识、版本和 SHA-256；对象内容变化后必须重新批准。
- RunManifest 使用确定性序列化计算 SHA-256，封存后不提供修改能力；任何已锁定内容变化都生成新的 Run ID 和 Manifest。
- Manifest 摘要只能帮助发现内容变化，不宣称能够代替数字签名、数据库权限或其他存储安全措施。
- 没有满足门禁要求的 Approval，不能创建可执行的 RoleRun。
- 每次角色执行或重试使用独立 Role Run ID；Executor 与 Verifier 不能共享 RoleRun 或 Pi Session。
- Pi Session ID 只用于关联 Agent 工作记录，不能改变 Task 状态、批准事项或交付结论。
- 进程重启后必须仅依赖 Control Plane 持久化记录确定任务状态和恢复动作。

## 已确认的状态变化记录边界

TaskTransition、RunTransition 和 RoleRunTransition 采用同一组最小字段：Transition ID、所属记录 ID、Command ID 或内部 Event ID、原状态与新状态、原版本与新版本、操作者、原因代码、相关记录引用、证据引用和发生时间。记录初次创建时，原状态和原版本为空；当前记录及其初始 Transition 必须在同一事务中生成。

RoleRunTransition 额外记录该次变化使用的 `leaseToken`。初始 `prepared` 记录使用 `0` 表示尚未发放租约，任何 Runtime 写入或工具请求都不能使用它；首次取得租约后 token 才递增为有效值。Control Plane 只有在 token、当前状态和版本均有效时才更新 RoleRun 并追加 Transition；被拒绝的旧 token 写入进入安全日志，不得伪装成成功的状态变化。

这些 Transition 只保存成功提交的权威状态变化，不是 Event Sourcing，也不保存所有 Pi Runtime 事件、模型消息、租约续期或工具调用。当前记录负责快速判断和恢复，Transition 负责解释状态如何形成；Pi 事件属于运行证据，工具副作用由后续 Tool Operation 账本记录。

同一个业务动作同时改变多个当前记录时，所有当前记录及对应 Transition 必须原子提交。例如 Run Authorization 生效时，需要在一个事务中更新 Task 与 Run，并分别追加 TaskTransition 和 RunTransition。

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

## 已确认的 Run 与 RoleRun 状态

Run 和 RoleRun 都将当前流程状态与最终结果分开保存，避免把“正在处理什么”和“最后为什么结束”混在一起。

```ts
type RunStatus =
  | "awaiting_authorization"
  | "authorized"
  | "active"
  | "stopping"
  | "blocked"
  | "settled";

type RunOutcome =
  | "completed"
  | "cancelled"
  | "superseded"
  | "rejected"
  | "failed";

type Run = {
  runId: string;
  taskId: string;
  version: number;

  manifestDigest: string;
  authorizationApprovalId: string;

  status: RunStatus;
  outcome?: RunOutcome;

  pendingOutcome?: "cancelled" | "superseded" | "failed";
  resumeToStatus?: "authorized" | "active" | "stopping";
  reasonCode?: string;

  createdAt: string;
  updatedAt: string;
  settledAt?: string;
};
```

Run 只保存判断当前状态和中断后继续处理所需的最小事实。RunManifest 以 Run ID 一对一保存 Schema 版本和规范内容；实际生效的 Approval 版本、替代的旧 Run、操作者、证据和各阶段时间保存在对应 RunTransition 中，不在 Run 当前行重复。

字段不变量如下：

- `stopping` 必须同时具有 `pendingOutcome` 和 `reasonCode`，不能具有 `resumeToStatus`。
- `blocked` 必须同时具有 `resumeToStatus` 和 `reasonCode`，不能具有 `pendingOutcome`。
- 其他状态不能残留 `pendingOutcome`、`resumeToStatus` 或 `reasonCode`。
- `settled` 必须同时具有 `outcome` 和 `settledAt`，其他状态不能提前保存最终结果。
- Run 的 `manifestDigest` 和 `authorizationApprovalId` 在创建后不可改变；Run Authorization 生效时采用的 Approval 版本写入 RunTransition。
- 一个 Task 最多存在一个未结算 Run，一个 Run 最多存在一个未结算 RoleRun；由数据库唯一约束或等价事务约束保证，不能由 Agent 查询后自行判断。
- RoleRun 记录不得为重置次数而删除，并且在 Run 未结算期间必须完整保留。创建 RoleRun 时必须锁定或版本校验 Run，在同一事务中统计已有 RoleRun 并检查 RunManifest 的 `maxRoleRuns`；Run 结算后的保留或删除由后续数据保留策略决定。

Run 不保存 Pi Session、模型消息、代码输出、工具结果、审批决定正文、凭据或 Manifest 中已经锁定的角色与能力配置。当前未结算 RoleRun、实际执行次数和生命周期时间从 RoleRun 与 Transition 权威记录查询，不在 Run 中维护容易失配的缓存字段。

| Run 状态 | 含义 |
| --- | --- |
| **`awaiting_authorization`** | Manifest 已封存，正在等待 Run Authorization。 |
| **`authorized`** | 已获授权并进入 `executing`，尚未启动第一个 RoleRun。 |
| **`active`** | 至少一个 RoleRun 已经开始，Run 仍允许继续。 |
| **`stopping`** | 已要求中止，正在终止 Agent 并对账外部操作。 |
| **`blocked`** | 存在未知结果或外部条件，禁止继续自动执行。 |
| **`settled`** | Run 已不可继续，并且必须具有 RunOutcome。 |

Run 只有在用户最终验收后才能以 `completed` 结算。Verifier PASS 时 Task 进入 `awaiting_acceptance`，Run 仍保持 `active`，以便用户提出获准范围内的返工。

### Run 与 Task 的静态对应

这里的“未结算 Run”是指状态不为 `settled` 的 Run；同一 Task 下已经结算的历史 Run 不参与当前状态约束。

| Task 状态 | 允许的未结算 Run 状态 |
| --- | --- |
| **`intake`** | 不允许存在。 |
| **`contextualizing`** | 不允许存在。 |
| **`drafting_trd`** | 不允许存在。 |
| **`awaiting_trd_approval`** | 不允许存在。 |
| **`planning`** | 不存在，或者为 `awaiting_authorization`。 |
| **`executing`** | `authorized` 或 `active`。 |
| **`verifying`** | `active`。 |
| **`awaiting_acceptance`** | `active`。 |
| **`blocked`** | 不存在，或者为 `stopping`、`blocked`。 |
| **`closed`** | 不允许存在。 |

Run Authorization 生效时，Task 的 `planning -> executing` 与 Run 的 `awaiting_authorization -> authorized` 必须原子提交。仅创建 `prepared` RoleRun 不激活 Run；Worker 成功取得租约并将第一个 RoleRun 改为 `starting` 时，必须在同一事务中将 Run 从 `authorized` 改为 `active`。

Executor、Verifier 和获准范围内返工可以改变 Task 在 `executing`、`verifying` 和 `awaiting_acceptance` 之间的状态，但同一个 Run 保持 `active`。需要终止或无法确认副作用时，Task 必须先进入 `blocked`，Run 对应进入 `stopping` 或 `blocked`；在恢复、完成对账或结算前不得创建新的 Run 或 RoleRun。Run 一旦 `settled` 就只作为历史记录存在，不再约束当前 Task 与未结算 Run 的对应关系。

```ts
type RoleRunStatus =
  | "prepared"
  | "starting"
  | "running"
  | "settling"
  | "blocked"
  | "settled";

type RoleRunOutcome =
  | "succeeded"
  | "failed"
  | "aborted"
  | "interrupted";
```

| RoleRun 状态 | 含义 |
| --- | --- |
| **`prepared`** | RoleRun 已持久化，输入制品和 RolePlan 已锁定。 |
| **`starting`** | Worker 已取得租约，正在创建 Pi Session。 |
| **`running`** | Session ID 已持久化，可以向 Pi 提交 Prompt。 |
| **`settling`** | Pi 已结束，正在封存输出并对账工具操作。 |
| **`blocked`** | 存在未知工具结果或无法自动确认的执行事实。 |
| **`settled`** | RoleRun 已结束，所有外部操作结果均已确定。 |

`unknown` 不作为 Run 或 RoleRun 终态。只要存在未知副作用，RoleRun 和 Run 必须保持 `blocked`，不能把未知结果标记为失败后自动重试。

RoleRun 至少保存以下字段：

```ts
type RoleRun = {
  roleRunId: string;
  runId: string;
  rolePlanId: string;
  role: "coordinator" | "executor" | "verifier";
  attempt: number;
  version: number;

  status: RoleRunStatus;
  outcome?: RoleRunOutcome;
  runtimeOutcome?:
    | "completed"
    | "error"
    | "aborted"
    | "incomplete"
    | "unknown";

  sessionId?: string;
  inputArtifacts: VersionedRef[];
  outputArtifacts: VersionedRef[];
  toolOperationRefs: string[];
  evidenceRefs: string[];

  leaseOwner?: string;
  leaseExpiresAt?: string;
  leaseToken: number;

  preparedAt: string;
  startedAt?: string;
  runtimeEndedAt?: string;
  settledAt?: string;

  errorCode?: string;
  sanitizedError?: string;
};
```

每次取得或重新取得租约时，`leaseToken` 必须单调增加，续租只延长到期时间而不改变 token。Runtime 事件、RoleRun 状态写入和 Tool Gateway 请求都必须携带当前 token；Control Plane 与 Tool Gateway 在受理时拒绝旧 token。旧 Pi 进程即使继续返回内容，其事件和输出也不能进入权威状态，其新工具请求也不能被受理。恢复程序取得新 token 后，才可以处理原 RoleRun 或创建后续 RoleRun。

Fencing 只隔离接管后的旧 Worker，不能撤销旧 token 有效期间已经由 Tool Gateway 受理的外部操作。Tool Gateway 必须在执行前持久化 Operation ID、幂等键和操作意图，并独立落账最终结果；恢复程序必须先查询这些操作，结果未知时保持 `blocked`，不得凭新 token 重复提交。

Pi 的 `runtimeOutcome = completed` 不等于 RoleRun `succeeded`。只有输出制品完整、工具操作全部对账且要求的自检通过后，RoleRun 才能成功结算。

RoleRun 按以下顺序启动和结算：

```text
事务：创建 prepared RoleRun 及初始 RoleRunTransition
-> 事务：取得租约并改为 starting
-> 创建 Pi Session
-> 事务：保存 Session ID 并改为 running
-> 提交事务后调用 session.run(prompt)
-> Pi 结束
-> 事务：改为 settling 并保存 runtimeOutcome
-> 对账工具操作并封存输出
-> 事务：改为 settled 或 blocked
```

任何模型请求和工具执行都必须发生在 `running` 已持久化之后。同一个 RoleRun 不得更换 Pi Session 后重新执行 Prompt；需要重试时必须先结算当前 RoleRun，再创建新的 RoleRun 并检查 Manifest 次数上限。

中断恢复规则如下：

| 中断位置 | 恢复方式 |
| --- | --- |
| **`prepared`** | 尚未启动 Pi，可以安全继续。 |
| **`starting` 且无 Session ID** | 租约过期并取得新 fencing token 后，可以重新创建 Session；旧 Worker 保存 Session ID 失败后不得调用 Pi。 |
| **`running`** | 原进程内 Session 不再可信，转入 `settling`，按 `incomplete` 对账。 |
| **`settling`** | 幂等继续对账和封存，不能重新运行 Agent。 |
| **存在未知工具结果** | RoleRun 与 Run 进入 `blocked`，必须完成对账或人工判断。 |
| **无未知副作用且允许重试** | 当前 RoleRun 以 `interrupted` 结算，再创建新的 RoleRun。 |

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

Control Plane 必须在同一事务中重新读取并校验所有权威引用，生成 Run ID 和最终 Manifest，保存规范 Manifest 与摘要，创建绑定该摘要的 `run_authorization` Approval，并保存处于等待授权状态的 Run 及其初始 RunTransition。Task 状态保持 `planning`。同一 Command ID 重复提交时必须返回第一次封存结果，不能创建第二个 Run。

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

全部通过后，Control Plane 在同一事务中将 Run 更新为已授权、将 Task 更新为 `executing`，增加两者版本，并分别追加 RunTransition 和引用 Run ID、Manifest 摘要及 Run Authorization Approval 的 TaskTransition。事务提交前不得创建 Pi Session、RoleRun 或执行工具；提交后才能创建第一个 Executor RoleRun。

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

### `submit_execution_for_verification`

```text
Task:    executing -> verifying
Run:     active -> active
RoleRun: settling -> settled / succeeded
```

本命令是 Executor 向 Verifier 的确定性交接，不是人工审批。Executor 可以请求交接，但不能直接结算自身或修改 Task；Control Plane 只有在输出已固定、执行已结束并且外部操作结果全部确定后才能接受命令。

Executor 必须先形成带 ID、版本和 SHA-256 的 ExecutionResult 制品，至少绑定 Task、Run、Manifest 和 Executor RoleRun，记录实际输入制品、目标代码基线、输出 Commit 或 Patch 摘要、变更路径、要求的自检结果、Tool Operation 引用、证据引用和已知限制。ExecutionResult 是 RoleRun 输出制品，不新增一种任务状态权威记录。

转换前必须满足：

- Task 为 `executing`，Run 为 `active`，Executor RoleRun 为 `settling`；命令携带正确的 Task、Run 和 RoleRun 版本、唯一 Command ID 以及当前 `leaseToken`。
- RunManifest、Run Authorization、PRD、ContextManifest、TRD 和所有 `execution` 前条件仍然有效。
- Pi 已结束且 `runtimeOutcome` 为 `completed`，Executor RoleRun 尚未结算。
- ExecutionResult 已持久化并封存，绑定的输入、基线和输出摘要与实际制品一致。
- 变更没有超出 RunManifest 允许的目标仓库和路径，原始基线没有发生未获准变化。
- 所有 Tool Operation 已经落账且结果确定，不存在仍在执行或结果未知的副作用。
- RunManifest 要求的 Executor 自检已经执行并通过，所需证据完整且可以解析。
- 当前 Task 和 Run 没有其他未结算 RoleRun，也没有阻塞事项。

Control Plane 必须在同一事务中重新校验上述权威记录，将 Executor RoleRun 结算为 `succeeded` 并保存输出与证据引用，追加 RoleRunTransition，将 Task 更新为 `verifying` 并增加版本，然后追加绑定 Run ID、Manifest 摘要、Executor RoleRun ID 和 ExecutionResult 摘要的 TaskTransition。Run 保持 `active`，不追加没有状态变化的 RunTransition。

事务提交后才能创建 Verifier RoleRun。Verifier 的输入必须显式引用本次 TaskTransition 绑定的 ExecutionResult，不能通过工作目录、分支名称或 Pi Session 自行选择“最新代码”。本转换不发送人工审批请求。

如果在输出封存或工具对账期间中断，RoleRun 保持 `settling`，恢复程序幂等继续处理，不能重新执行 Executor。如果事务提交后、创建 Verifier RoleRun 前中断，恢复程序根据 `verifying` Task、`active` Run、已结算 Executor RoleRun 和不存在 Verifier RoleRun 的事实安全继续。

### VerificationResult 结果边界

Verifier 必须分别记录 Pi Runtime 是否正常结束、Verifier RoleRun 是否完整结算以及被检查交付是否符合要求，三者不能互相代替：

| 层次 | 回答的问题 | 结果示例 |
| --- | --- | --- |
| **RuntimeOutcome** | Pi 进程是否正常结束？ | `completed`、`error`、`incomplete`。 |
| **RoleRunOutcome** | Verifier 本次工作是否完整结算？ | `succeeded`、`failed`、`interrupted`。 |
| **VerificationVerdict** | 被检查的 ExecutionResult 是否符合要求？ | `pass`、`fail`、`blocked`。 |

Pi 正常结束不代表验证通过；Verifier RoleRun 的 `succeeded` 也只表示它完整产出了可用结果。例如 Verifier 成功发现实现缺陷时，RoleRun 是 `succeeded`，VerificationVerdict 是 `fail`。

```ts
type VerificationVerdict = "pass" | "fail" | "blocked";

type VerificationResult = {
  resultId: string;
  version: string;
  digest: string;

  taskId: string;
  runId: string;
  verifierRoleRunId: string;

  executionResultRef: VersionedRef;
  acceptanceCriteriaRef: VersionedRef;

  verdict: VerificationVerdict;
  findingClass?: "implementation" | "trd" | "context" | "prd";
  block?: {
    reasonCode: string;
    owner: string;
    recoveryCondition: string;
  };

  checkResultRefs: VersionedRef[];
  evidenceRefs: string[];
  findings: string[];
  createdAt: string;
};
```

VerificationResult 是 Verifier RoleRun 的版本化输出制品，不新增一种任务状态权威记录。它必须绑定 `submit_execution_for_verification` 交接的精确 ExecutionResult 和验收标准，封存后不允许原地修改。

结论规则如下：

- `pass` 表示所有必需检查已经执行并通过、证据完整，可以请求进入最终验收；不能携带 `findingClass` 或 `block`。
- `fail` 表示能够依据具体验收标准和证据证明交付不合格，必须携带 `findingClass`，不能携带 `block`。存在多个类别时，按 `prd`、`context`、`trd`、`implementation` 的顺序选择需要回退最远的控制类别。
- `blocked` 表示由于明确识别的外部缺口而无法可靠形成 PASS 或 FAIL，必须携带结构化 `block`，不能携带 `findingClass`，也不能用来掩盖已经能够证明的失败。

Verifier 可以提出 verdict 和 findingClass，Control Plane 必须校验结构、引用、证据完整性、职责分离和确定性分类规则，再决定 Task 如何流转；Verifier 不能直接指定目标状态。

只有 Verifier 已安全结束、所有 Tool Operation 结果确定并且 VerificationResult 可以封存时，RoleRun 才能以 `succeeded` 结算。Pi `error`、进程中断或无法形成完整结果时没有 VerificationVerdict，当前 RoleRun 应按已知事实结算为 `failed` 或 `interrupted`。如果存在未知工具结果，RoleRun、Run 和 Task 保持 `blocked`，不得生成一个看似完整的 `blocked` VerificationResult 代替对账。

### `submit_verification_result`: `pass`

```text
Task:             verifying -> awaiting_acceptance
Run:              active -> active
Verifier RoleRun: settling -> settled / succeeded
```

`pass` 表示独立验证已经完成并通过，只能形成一个等待用户接受的固定交付对象，不能自动关闭 Task，也不能代替 Human Authority 的最终接受。

转换前必须满足：

- Task 为 `verifying`，Run 为 `active`，Verifier RoleRun 为 `settling`；命令携带正确的 Task、Run 和 RoleRun 版本、唯一 Command ID 以及当前 `leaseToken`。
- VerificationResult 已持久化并封存，verdict 为 `pass`，且精确绑定当前 TaskTransition 交接的 ExecutionResult 和 RunManifest 验收标准。
- Verifier 使用 Manifest 中独立的 Verifier RolePlan、Pi Session 和工具权限，满足职责分离策略，没有复用 Executor RoleRun 或 Session。
- RunManifest 要求的检查全部执行并通过；必需检查不能静默跳过，只有 Manifest 已明确批准的 `N/A` 才能不执行。
- 检查结果、原始证据和引用完整且摘要一致，VerificationResult 不包含失败或阻塞 finding。
- 被验证的 Commit 或 Patch 仍与 ExecutionResult 摘要一致，没有在验证后发生变化。
- 所有 Tool Operation 已完成对账，不存在仍在执行或结果未知的副作用。
- RunManifest、Run Authorization 及所有验证前条件仍然有效，不存在其他未结算 RoleRun。

Control Plane 必须在同一事务中重新执行确定性完整性和一致性检查，将 Verifier RoleRun 结算为 `succeeded` 并保存 VerificationResult 与证据引用，追加 RoleRunTransition，将 Task 更新为 `awaiting_acceptance` 并增加版本，然后追加绑定 ExecutionResult 和 VerificationResult 精确摘要的 TaskTransition。Run 保持 `active`，不追加没有状态变化的 RunTransition。

如果 VerificationResult 缺少必需检查、声称 PASS 但确定性检查失败，或者被验证输出已经变化，Control Plane 必须拒绝命令，Verifier RoleRun 保持 `settling`，不能自动改写成“带风险通过”。事务提交后发生中断时，恢复程序根据 `awaiting_acceptance` Task、`active` Run 和已结算 Verifier RoleRun 继续等待用户决定，不重复验证或自动接受。

### `submit_verification_result`: `fail`

`fail` 表示 Verifier 已经依据验收标准和证据证明当前交付不合格。Verifier RoleRun 可以正常 `succeeded`，但 Control Plane 必须根据经确认的 `findingClass` 判断问题是否仍在当前 Run 的授权边界内。

| findingClass | 含义 | Task 处理 |
| --- | --- | --- |
| **`implementation`** | PRD、EMI Context、TRD 和验收标准仍然正确，实现结果不符合要求。 | 在当前 Run 内返回 `executing`。 |
| **`trd`** | 技术设计、技术控制或验收方式需要修改。 | 终止当前 Run 后返回 `drafting_trd`。 |
| **`context`** | EMI 适用性、司法辖区、规则或监管解释需要修改。 | 终止当前 Run 后返回 `contextualizing`。 |
| **`prd`** | 目标、范围或业务验收标准需要修改。 | 终止当前 Run 后返回 `intake`。 |

所有 FAIL 分支首先要求 Task 为 `verifying`、Run 为 `active`、Verifier RoleRun 为 `settling`，命令携带正确版本、唯一 Command ID 和当前 `leaseToken`。VerificationResult 必须已封存并绑定当前 ExecutionResult 与验收标准，verdict 为 `fail`，每项 finding 都有具体失败标准和证据，Pi 已安全结束，所有 Tool Operation 结果确定，并且不存在其他未结算 RoleRun。Control Plane 必须通过确定性策略或有效 Human Authority 记录确认 findingClass，不能直接采用 Verifier 自行选择的回退状态。

#### `implementation`: 当前 Run 内返工

```text
Task:             verifying -> executing
Run:              active -> active
Verifier RoleRun: settling -> settled / succeeded
```

除通用条件外，还必须确认修复不会改变 PRD、ContextManifest、TRD、验收标准或 RunManifest，仍处于获准路径、工具、权限和隔离边界内；RunManifest 明确允许返工，并且 `maxRoleRuns`、Executor 尝试次数与 Run 时限仍足以创建下一次 Executor RoleRun。

Control Plane 在同一事务中结算 Verifier RoleRun 并保存 FAIL 结果与证据，追加 RoleRunTransition，将 Task 改为 `executing` 并追加绑定 VerificationResult 的 TaskTransition。Run 保持 `active`。事务提交后才能创建新的 Executor RoleRun；新 RoleRun 必须以失败的 ExecutionResult 和 VerificationResult 为精确输入，不能复用旧 Executor RoleRun 或 Pi Session。

#### `trd`、`context` 或 `prd`: 终止当前 Run

第一阶段先停止旧授权边界：

```text
Task:             verifying -> blocked
Run:              active -> stopping / pending superseded
Verifier RoleRun: settling -> settled / succeeded
```

Control Plane 必须在同一事务中结算 Verifier RoleRun、保存 FAIL 证据，将 Task 改为 `blocked` 并记录恢复目标，同时将 Run 改为 `stopping`、设置 `pendingOutcome = superseded`，追加 TaskTransition、RunTransition 和 RoleRunTransition。即使此时没有其他活动 RoleRun，也统一经过停止与对账阶段，避免旧 Manifest 的执行权与新上游状态同时有效。

外部操作全部对账且旧执行权已经失效后，Control Plane 在第二个事务中完成：

```text
Run:  stopping -> settled / superseded
Task: blocked -> drafting_trd | contextualizing | intake
```

该事务必须同时追加 RunTransition 和 TaskTransition，并保留原 ExecutionResult、VerificationResult 和全部证据。Task 返回目标阶段后必须创建并重新批准相应上游制品，不能在原 Run 内修改锁定内容；新 Run 只能在重新进入 `planning` 后生成。

#### 不能直接分流的情况

- 问题属于 `implementation`，但角色次数、尝试次数或 Run 时限已经耗尽时，Task 进入 `blocked`，Run 以 `pendingOutcome = failed` 停止并在对账后结算为 `failed`；Human Authority 决定重新规划或取消。
- findingClass 无法由确定性策略或有效人工判断确认时，Verifier RoleRun 可以结算并保存 FAIL 证据，但 Task 和 Run 进入 `blocked`，不得由 Verifier 自行选择回退位置。
- 存在未知 Tool Operation 时不接受最终 FAIL；RoleRun、Run 和 Task 按未知结果进入 `blocked`，先完成对账。

### `submit_verification_result`: `blocked`

```text
Task:             verifying -> blocked
Run:              active -> blocked / resumeTo active
Verifier RoleRun: settling -> settled / succeeded
```

VerificationVerdict `blocked` 只表示 Verifier 已安全完成当前工作，并明确识别出一个外部缺口，现有证据不足以可靠形成 PASS 或 FAIL。它不是失败结论，也不能用于掩盖已经能够证明的测试失败、实现缺陷或控制缺口。

转换前必须满足：

- Task 为 `verifying`，Run 为 `active`，Verifier RoleRun 为 `settling`；命令携带正确版本、唯一 Command ID 和当前 `leaseToken`。
- VerificationResult 已持久化并封存，verdict 为 `blocked`，精确绑定当前 ExecutionResult 和验收标准。
- 结构化 `block` 具有明确 `reasonCode`、责任人和可以检查的恢复条件，findings 与证据能够证明当前确实无法下结论。
- Pi 已安全结束，Verifier RoleRun 的输出完整，所有 Tool Operation 结果确定，不存在未知副作用。
- 不能通过现有证据形成 PASS 或 FAIL，且不存在其他未结算 RoleRun。

Control Plane 必须在同一事务中结算 Verifier RoleRun 为 `succeeded` 并保存 VerificationResult 与证据，追加 RoleRunTransition，将 Task 改为 `blocked` 并记录恢复目标 `verifying`，将 Run 改为 `blocked`、设置 `resumeToStatus = active` 和对应 `reasonCode`，然后追加 TaskTransition 和 RunTransition。阻塞期间不能创建新 RoleRun、调用 Agent 或执行新的有副作用工具。

#### `resolve_verification_block`

新增证据已经满足恢复条件，并且不会改变任何锁定输入时，可以恢复原 Run：

```text
Task: blocked -> verifying
Run:  blocked -> active
```

命令必须携带正确 Task 与 Run 版本、唯一 Command ID、原 blocked VerificationResult 以及新增的版本化解除阻塞证据。Control Plane 必须确认责任人或有权策略已经接受该证据，PRD、ContextManifest、TRD、RunManifest、目标代码输出、Run Authorization、权限和隔离边界均未变化，并且角色次数和 Run 时限足以进行新一轮验证。

全部满足后，Control Plane 在同一事务中清除 Run 当前阻塞字段、更新 Task 与 Run、增加两者版本并分别追加 TaskTransition 和 RunTransition。事务提交后创建新的 Verifier RoleRun，显式绑定原 ExecutionResult、blocked VerificationResult 和新增证据；旧 Verifier RoleRun 和 Pi Session 不得复用。

如果解除阻塞需要修改 PRD、ContextManifest、TRD、RunManifest 或其他锁定输入，原 Run 不能恢复，必须从 `blocked` 转为 `stopping`、设置 `pendingOutcome = superseded`，完成对账并结算后再返回对应上游阶段。若角色次数或时限不足，则按 Run 失败停止，不得通过解除阻塞绕过 Manifest 限制。

#### 未知 Tool Operation

工具调用超时且无法确认外部操作是否发生等情况，不是 VerificationVerdict `blocked`。此时不能封存一个最终 VerificationResult，也不能把 Verifier RoleRun 结算为 `succeeded`；RoleRun、Run 和 Task 必须进入 `blocked`，按 Operation ID 和幂等键完成对账。结果确定后才能根据实际制品和剩余限制结算原 RoleRun、创建新 RoleRun 或终止 Run。

### `accept_delivery`

```text
Task: awaiting_acceptance -> closed / completed
Run:  active -> settled / completed
```

`accept_delivery` 由具有最终验收权限的 Human Authority 直接提交。v0.1 不为单人最终验收再创建一层 Acceptance Approval；不可修改的 TaskTransition 保存验收人、决定和精确对象引用。后续实际项目需要多人验收时，可以再复用 Approval 与 ApprovalDecision 聚合机制。

转换前必须满足：

- Task 为 `awaiting_acceptance`，Run 为 `active`；命令携带正确的 Task 与 Run 版本和唯一 Command ID。
- 调用者身份已认证，并具有当前 Task 所需的最终验收角色；Agent、Executor 和 Verifier 不能代替 Human Authority 接受交付。
- 命令精确绑定当前 ExecutionResult、verdict 为 `pass` 的 VerificationResult、验收标准和 RunManifest 摘要。
- 被接受的 Commit 或 Patch 与验证时摘要一致，没有在 PASS 后发生变化。
- VerificationResult、必需检查、原始证据和引用仍然有效且可以解析。
- 所有 `acceptance` 前 ApprovalCondition 已满足并具有有效证据。
- 不存在未结算 RoleRun、未知 Tool Operation、阻塞事项或未处理 finding。
- Run Authorization、职责分离、权限和其他适用门禁仍然有效。
- RunManifest 规定在完成前执行的交付操作已经由 Tool Gateway 完成并对账，正式权威证据记录已经齐全。

Control Plane 必须在同一事务中重新校验上述事实，将 Task 更新为 `closed`、结果设为 `completed`，将 Run 更新为 `settled`、结果设为 `completed`，增加两者版本，并分别追加 TaskTransition 和 RunTransition。两条 Transition 必须绑定相同的 ExecutionResult、VerificationResult、验收标准和证据引用；TaskTransition 还记录验收人的身份、角色和决定理由。

同一 Command ID 重复提交时必须返回第一次验收结果，不能生成第二组 Transition。事务提交后不得再创建 RoleRun 或使用该 Run 执行工具。

“附条件接受”不能进入 `closed`。用户新增条件、要求修复或改变范围时，必须进入验收返工或上游变更路径。`accept_delivery` 本身不执行代码合并、部署、付款或其他副作用；如果验收决定用于授权后续操作，应先记录相应授权，完成受控操作及验证后再调用本命令。

最终 Evidence Package 是对已经完整保存的权威记录和证据的派生导出，在验收事务提交后生成并可幂等重试。导出失败不能回滚已提交的验收事实，但必须形成可观测的导出失败记录并持续重试；不能在缺少验收前权威证据时先关闭 Task，再依赖导出补造证据。

## 待确认问题

1. 其余合法状态转换、每次转换所需的输出与门禁，以及阻塞后的恢复规则。
2. Approval 请求撤回、超时失效和批准后撤销如何生效。
3. 验收返工、Run 取消和其他终止场景的完整转换门禁。
4. 持久化数据库、事务边界、迁移方式和并发控制。
5. Agent 启动、运行和完成各阶段发生进程中断时的恢复与对账语义。
6. 第 3 步的自动化验收条件。
