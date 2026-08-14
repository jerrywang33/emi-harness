# Task Breakdown

## Run

- run-id: `{run-id}`
- SDD: `{absolute-or-repository-path}@{commit}`
- target: `{absolute-path}`
- plan-status: `Draft | Approved`
- approved-by: `pending`
- approved-at: `pending`

## 计划约束

- 任务只能实现 Approved SDD 范围。
- 每个任务必须映射 SDD 章节、验收条件、自测和证据。
- Executor 可以完成多个任务，但每个逻辑任务独立提交。
- 计划调整不得暗中改变 SDD；范围或验收变化必须重新批准 SDD。

## 任务清单

| ID | 任务 | SDD | 角色 | 变更范围 | 自测 | AC | 状态 | Commit | 证据 |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| T-01 |  |  | Executor |  |  |  | Pending | pending | pending |

状态只使用 `Pending`、`In Progress`、`Implemented`、`Verified`、`Failed`、`Blocked`。Executor 最多写到 `Implemented`；`Verified` 只能由 Verifier 证据支持。

## Attempt 计划

| Attempt | 输入 commit | 责任角色 | 目标 | 结果 | 报告 |
| --- | --- | --- | --- | --- | --- |
| 01 | pending | Executor | 执行批准任务 | pending | `attempts/01/executor-report.md` |

## 验收映射

| AC | 覆盖任务 | 验证方式 | 证据路径 | 结果 |
| --- | --- | --- | --- | --- |
| AC-01 |  |  |  | NOT-RUN |

## 计划批准记录

| 时间 | 决策者 | 决策 | 计划 commit | 备注 |
| --- | --- | --- | --- | --- |
| pending | 用户 | pending | pending | pending |
