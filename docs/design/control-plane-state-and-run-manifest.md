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
└── Run[]
    ├── RunManifest
    └── RoleRun[]
        └── Pi Session ID
```

| 记录 | 职责 |
| --- | --- |
| **Task** | 表示一个用户交付目标，保存当前阶段、当前版本和最终结果。 |
| **TaskTransition** | 追加记录状态变化、操作者、原因以及审批和证据引用。 |
| **Approval** | 保存绑定确定对象标识、版本和哈希的待审批请求，以及 Human Authority 作出的决定。 |
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

## 待确认问题

1. 其余合法状态转换、每次转换所需的输出与门禁，以及阻塞后的恢复规则。
2. 哪些转换必须具备何种 Approval，以及批准、附条件批准、退回和撤销如何生效。
3. Run、RunManifest 和 RoleRun 的字段、版本及封存时机。
4. 持久化数据库、事务边界、迁移方式和并发控制。
5. Agent 启动、运行和完成各阶段发生进程中断时的恢复与对账语义。
6. 第 3 步的自动化验收条件。
