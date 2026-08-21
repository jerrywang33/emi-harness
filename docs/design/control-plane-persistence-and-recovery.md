# Control Plane 持久化与恢复设计

- 状态：已接受，进入实现
- 对应 Roadmap：v0.1 第 3 步
- 最后更新：2026-08-21

## 目标与边界

本设计把 [任务状态与运行清单设计](control-plane-state-and-run-manifest.md) 落到可实现的 SQLite 事务边界。v0.1 支持单 Control Plane 写进程、多个进程外 Worker 的租约接管，以及中断后的确定性恢复；不支持多个 Control Plane 实例共同写一个数据库。

持久化层只负责权威状态、不可变制品、引用和待执行工作。Pi Session、模型推理和外部工具本身不在 SQLite 事务中运行。

## 存储端口

领域服务依赖 `ControlPlaneStore`，不直接依赖 SQLite 类型。端口至少提供：

- 在事务中执行带 Command ID 的领域命令。
- 按 ID 读取 Task、Approval、Run、RoleRun、Manifest 和 Artifact。
- 保存不可变 Artifact 并校验规范内容摘要。
- 查询未结算 Run、RoleRun、待对账 Operation 引用和未完成 outbox。
- 获取、续租和接管 RoleRun lease，并校验 fencing token。

调用方注入 Clock 和 ID Generator，使截止时间、租约和测试不依赖系统隐式状态。

## 最小关系模型

| 表 | 可变性 | 关键约束 |
| --- | --- | --- |
| `tasks` | 当前记录可按版本更新 | 状态、结果和阻塞字段组合检查。 |
| `task_transitions` | 只追加 | `(task_id, command_id)` 唯一。 |
| `approvals` | 当前聚合可按版本更新 | 对象类型、ID、版本、摘要与策略固定。 |
| `approval_transitions` | 只追加 | 每次聚合状态变化有来源命令或事件。 |
| `approval_decisions` | 只追加 | Authority、角色、决定、理由和证据固定。 |
| `artifacts` | 不可修改 | `(artifact_id, version)` 唯一，规范内容与摘要一致。 |
| `run_manifests` | 不可修改 | `run_id`、规范 JSON 和摘要一对一。 |
| `runs` | 当前记录可按版本更新 | 每 Task 仅一个 `status <> settled`。 |
| `run_transitions` | 只追加 | 绑定当时 Manifest 与审批引用。 |
| `role_runs` | 当前记录可按版本更新 | 每 Run 仅一个 `status <> settled`；attempt 唯一。 |
| `role_run_transitions` | 只追加 | 保存变化时的 fencing token。 |
| `commands` | 完成后不可修改 | Command ID、请求摘要、结果或失败分类。 |
| `outbox` | 只更新投递状态 | 业务事件 ID 唯一，处理方按该 ID 幂等。 |

Tool Operation 和 Evidence 的专用表在后续步骤加入，但通过稳定 ID 和引用与本模型连接。

部分唯一索引分别约束 `runs(task_id) WHERE status <> 'settled'` 和 `role_runs(run_id) WHERE status <> 'settled'`。CHECK 约束保证只有终态具有 outcome，只有停止和阻塞状态具有对应临时字段。外键不使用级联删除；v0.1 不提供删除权威记录的业务命令。

## 数据库初始化与迁移

数据库连接必须设置：

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA synchronous = FULL;
PRAGMA busy_timeout = 5000;
```

文件数据库以受限文件权限创建，不接受来自 Agent 或 RunManifest 的任意数据库路径。应用启动时读取 `schema_migrations`，按编号顺序在事务中应用未执行迁移，并记录迁移 ID、SHA-256 和时间；同一 ID 摘要不同则拒绝启动。

部署不得自动回滚迁移或修改历史迁移。涉及破坏性 Schema 变化时使用新表、数据校验和显式切换，保留审计记录。

## 命令事务与并发

每个写命令遵循同一顺序：

1. 对完整请求做确定性序列化并计算摘要。
2. 使用 `BEGIN IMMEDIATE` 开始短写事务，读取 Command ID。
3. 已存在相同请求摘要时返回持久化结果；摘要不同时拒绝 ID 冲突。
4. 读取聚合并校验状态、`expectedVersion`、权限、引用和门禁。
5. 写入当前记录、Transition、Decision、Artifact 和 outbox；所有受影响记录一起提交。
6. 保存命令结果并提交事务。
7. 提交后才唤醒 Worker、发送通知或执行外部副作用。

可预期的业务拒绝在事务内回滚，不写成功 Command 记录；安全日志可以独立记录拒绝。SQLite busy 或进程中断由调用方使用同一 Command ID 重试。

## 不可变内容与摘要

Artifact 和 RunManifest 使用 RFC 8785 规范 JSON，以 UTF-8 计算 `sha256:{lowercase hex}`。写入前拒绝非有限数字、未定义值和无效 Unicode；读取时可以重新计算摘要发现存储损坏。

数据库触发器拒绝对 Manifest、Artifact、Decision 和所有 Transition 的 `UPDATE` 或 `DELETE`。这不是防篡改签名；数据库文件权限、备份、访问日志和未来的外部签名仍由部署控制承担。

## 租约与 fencing

创建 RoleRun 时 `lease_token = 0`。取得或接管租约必须在一个事务中检查状态和过期时间，将 token 增加 1，并保存 owner 与 expiry；正常续租只延长 expiry。所有 Runtime 状态写入和 Tool Gateway 请求携带 token，数据库更新条件同时包含 RoleRun ID、版本和 token。

旧 Worker 的更新影响零行时必须停止，不能把返回内容改写为新 RoleRun 的结果。已经由 Tool Gateway 受理的操作不受数据库回滚影响，仍按 Operation ID 对账。

## 启动恢复

恢复器可以重复运行，并按以下优先级生成确定性 RecoveryAction：

1. 继续投递未完成 outbox；处理方以 Event ID 幂等。
2. 对存在未结算 Tool Operation 的 RoleRun 请求对账；结果未知时阻塞 RoleRun、Run 和 Task。
3. `prepared` 或租约过期且无 Session ID 的 `starting` RoleRun 可以取得新 token 后启动。
4. 进程重启后仍为 `running` 的 RoleRun 不尝试复用内存 Session，转为 `settling / incomplete` 并对账。
5. `settling` RoleRun 继续封存和结算，不再次运行 Agent。
6. 已授权 Run 缺少首个 RoleRun、`verifying` Task 缺少 Verifier RoleRun 等情况，按已提交状态创建下一项确定性工作。
7. `stopping` Run 继续中止、对账和结算；`blocked` 只在显式恢复命令满足条件后继续。

RecoveryAction 使用稳定的派生幂等键，不直接执行 Agent 或工具。实际 Worker 领取动作前必须重新读取状态、版本和租约，确保扫描结果过期时不会产生副作用。

## 备份与升级边界

v0.1 试跑前创建一致性备份，恢复演练必须证明数据库可以重开、迁移摘要一致、所有外键通过且未结算工作可重新规划。数据库和 Evidence 文件应使用同一保留策略，但备份不能包含 API Key、生产凭据、客户数据或未脱敏的模型上下文。

迁移到 PostgreSQL 或多实例 Control Plane 属于新 ADR。迁移必须通过同一端口契约和状态测试，特别是 Command 幂等、单活动记录、事务原子性和 fencing 语义。
