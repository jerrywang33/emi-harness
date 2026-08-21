# Control Plane 任务状态与运行清单设计

- 状态：设计中
- 对应 Roadmap：v0.1 第 3 步
- 最后更新：2026-08-19

## 目标

建立不依赖 Pi Session 的最小权威状态和运行记录，使 Control Plane 能够可靠判断任务当前阶段、允许的下一步、人工批准的具体对象、一次运行使用的固定配置，以及每个角色的实际执行结果。进程重启后必须从这些记录恢复，而不是读取 Agent 对话推断流程位置。

本步不实现完整工作流平台、受控 EMI 资源、Tool Gateway、独立验证或端到端交付；这些能力继续按 Roadmap 后续步骤接入。

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
| **Approval** | 记录 Human Authority 对一个确定标识、版本和哈希的对象作出的决定。 |
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

## 待确认问题

1. 其余合法状态转换、每次转换所需的输出与门禁，以及阻塞后的恢复规则。
2. 哪些转换必须具备何种 Approval，以及批准、附条件批准、退回和撤销如何生效。
3. Run、RunManifest 和 RoleRun 的字段、版本及封存时机。
4. 持久化数据库、事务边界、迁移方式和并发控制。
5. Agent 启动、运行和完成各阶段发生进程中断时的恢复与对账语义。
6. 第 3 步的自动化验收条件。