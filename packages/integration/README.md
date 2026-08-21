# @emi-harness/integration

根据 Control Plane 当前状态和 RunManifest 组装受控资源、精确 Runtime tools、Tool Gateway、Assurance checks 和角色交接。Executor 与 Verifier 使用不同 RoleRun 和 Runtime Session；Integration 不解释法规、不改变 Manifest，也不接受 Agent 自行宣布检查通过。

`harness.submit_execution@1` 与 `harness.submit_verification@1` 是无副作用的结构化结果收集工具。有副作用的 `workspace.write_text@1` 仍只能通过 Tool Gateway adapter 调用。

`CandidateEvidencePackageBuilder` 只在 Task 已进入 `awaiting_acceptance`、全部 RoleRun 和 Tool Operation 已知结算且 Manifest 要求的 Evidence 齐全时导出候选交付包。候选包固定标记用户验收为 pending；导出不能代替 `accept_delivery`。
