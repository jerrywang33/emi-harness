# v0.1 执行追踪

每次运行的事实来源是目标仓库中的 `reports/runs/{run-id}/manifest.md`。状态、角色、attempt、commit 或证据没有写入 manifest，就视为未发生。

## 1. 状态机

```text
PLANNING
-> AWAITING_PLAN_APPROVAL
-> EXECUTING
-> VERIFYING
-> REWORK_REQUIRED -> EXECUTING
-> AWAITING_FINAL_ACCEPTANCE
-> COMPLETED
```

补充终止或暂停状态：

- `BLOCKED`：环境或外部前置条件不满足，记录恢复状态。
- `ESCALATED`：第 3 次验证失败或需要用户裁决，停止自动处理。
- `CANCELLED`：用户明确取消，不复用 run-id。

状态不得跳跃。Verifier PASS 后只能进入 `AWAITING_FINAL_ACCEPTANCE`，用户明确验收后才能进入 `COMPLETED`。

## 2. Manifest 结构

```markdown
# Run Manifest

## Identity
- run-id:
- task-type:
- created-at:
- updated-at:
- timezone: Asia/Shanghai

## Sources
- harness-path:
- harness-repository:
- harness-commit:
- sdd-path:
- sdd-version:
- sdd-commit:

## Target
- target-path:
- repository: local only
- branch: main
- remote: none
- starting-commit:
- current-commit:
- run-maven-repository:

## State
- status:
- resume-status:
- current-attempt:
- max-attempts: 3
- responsible-role:
- last-deliverable:
- next-action:
- blocked-reason:

## Attempts
| Attempt | Executor commit | Verifier commit | Verdict | Evidence |
| --- | --- | --- | --- | --- |

## User Confirmations
| Time | Gate | Decision | Scope |
| --- | --- | --- | --- |

## Evidence Index
| Evidence | Path | Commit | Status |
| --- | --- | --- | --- |
```

所有时间使用带 `+08:00` 的 ISO 8601。未知值写 `pending`，不能凭空填写。

## 3. Attempt 不可变性

- attempt 从 `01` 开始，只在 Executor 接收新的实现或修复任务时递增。
- 完成交接后，`attempts/{attempt}/` 中的报告和日志只读。
- Verifier FAIL 先完成当前报告和 commit，再由 Coordinator 更新状态并创建下一 attempt。
- 受控失败演练使用临时分支或 worktree，不计入 attempt。

## 4. 报告最小字段

### Executor report

- run-id、attempt、角色、开始/结束时间。
- 输入 SDD/规则及固定 commit。
- 完成任务、变更文件和 commit。
- 自测命令、退出码和证据。
- 已知问题与给 Verifier 的交接事实；不得写最终 PASS。

### Verifier report

- run-id、attempt、角色、上下文开始时间和待验证 commit。
- 初始上下文清单，并声明初始结论前未读取 Executor report。
- AC-01 至 AC-07 的逐项 PASS/FAIL/NOT-RUN。
- 有效 POM 结论、正式命令、退出码和原始日志路径。
- 总结论；FAIL 时包含复现方式，PASS 时不得代替用户验收。

### Acceptance

- 待验收 commit 与 Verifier verdict。
- AC-01 至 AC-08 清单。
- 用户原始决策、时间和范围。
- 只有用户可以给出 AC-08 结论。

### Retrospective

- 实际时间线和 attempt 数。
- 自然失败或受控失败演练结果。
- 规格、规则、工具和上下文恢复暴露的真实缺口。
- 后续候选项，不自动修改 Harness。

## 5. 完整性检查

交接前必须验证 manifest 中每个证据路径存在、每个 commit 可由目标 Git 解析、当前工作区状态已说明。报告不得引用当前对话作为唯一依据。
