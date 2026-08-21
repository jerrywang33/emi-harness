# @emi-harness/integration

根据 Control Plane 当前状态和 RunManifest 组装受控资源、精确 Runtime tools、Tool Gateway、Assurance checks 和角色交接。Executor 与 Verifier 使用不同 RoleRun 和 Runtime Session；Integration 不解释法规、不改变 Manifest，也不接受 Agent 自行宣布检查通过。

`harness.submit_execution@1` 与 `harness.submit_verification@1` 是无副作用的结构化结果收集工具。有副作用的 `workspace.write_text@1` 仍只能通过 Tool Gateway adapter 调用。
