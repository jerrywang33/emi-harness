# @emi-harness/control-plane

EMI Harness v0.1 的权威任务状态和恢复边界。该包持久化 Task、Approval、Run、RoleRun、不可变制品、Transition、命令幂等结果和 outbox，不读取 Pi Session 推断任务进度。

```ts
import { SqliteControlPlane } from "@emi-harness/control-plane";

const controlPlane = new SqliteControlPlane({ databasePath: "./state/control-plane.db" });
// 写命令携带 commandId 和 actor；更新已有状态时还需相应 expectedVersion。
controlPlane.close();
```

v0.1 只支持一个 Control Plane 写进程。Agent、Git、网络和有副作用工具不能在数据库事务中执行；后续包通过稳定记录 ID、outbox 和 fencing token 与本包衔接。

## 输入、输出与入口

- [contracts.ts](src/contracts.ts) 定义写命令，[types.ts](src/types.ts) 定义 Task、Run、RoleRun、Approval、Manifest 和版本引用。Actor 身份与角色由可信调用方提供，本包不接入登录认证或 IAM。
- [sqlite-control-plane.ts](src/sqlite-control-plane.ts) 提供命令与查询。`command()` 将状态修改、Transition、outbox 和幂等结果放在同一 SQLite 事务中；同 ID 同请求重放原结果，不同请求报冲突。
- [migrations.ts](src/migrations.ts) 定义表、索引、状态约束及不可变记录触发器；[canonical-json.ts](src/canonical-json.ts) 定义制品规范化和摘要。改动这些行为需评估历史数据与引用兼容性。
- Integration 用本包推进角色与任务，Gateway Authority 读取本包做权限检查，候选包 builder 读取审批、制品和状态历史。工具与 Evidence 使用独立账本，不参与本库事务。

## 恢复与验收边界

v0.1 只接受无附加条件的正式批准：TRD Approval 与 Run Authorization 拒绝 `approved_with_conditions` 和非空 `conditions`，新 Manifest 的 `approvalConditions` 必须为空。准备未完成时不批准，需要修改审批对象时使用 `changes_requested`。历史条件记录保留可读，但不再作为继续封存、执行或交付的有效批准，也不会自动转换成正式批准。

`assertRunAuthorization(runId)` 只读检查当前 Run 的前置批准和执行批准，供 Gateway 与候选证据包复用；它不授予工具权限，调用方仍需检查 Run 状态、角色、租约和工具范围。

`planRecovery()` 只查询并返回恢复动作，执行动作和投递 outbox 由宿主负责。重放已完成命令会返回当时保存的结果，需要最新版本时应重新查询；租约 token 用于拒绝旧 Worker 写入，已派发的工具操作仍需独立对账。

`acceptDelivery()` 要求调用方提供具备 `delivery_authority` 的 Human Actor，并检查绑定结果与状态；它记录最终接受及导出请求，不执行合并、部署或最终包导出。审批身份的真实性与跨账本证据校验需要沿完整调用链审查。

## 验证与设计

从根目录完成 workspace 安装和构建后运行 `pnpm --filter @emi-harness/control-plane check`。[test/](test/) 覆盖生命周期、约束、恢复和规范 JSON；完整状态定义见 [状态与运行清单设计](../../docs/design/control-plane-state-and-run-manifest.md)，持久化约定见 [恢复设计](../../docs/design/control-plane-persistence-and-recovery.md)。跨包验证从 [Review 指南](../../docs/review-guide.md) 进入。
