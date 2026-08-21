# v0.1 本地 TypeScript 工程校准记录

- 校准日期：2026-08-21
- 校准类型：工程机制校准，不是 EMI 业务或法律验收
- 逻辑目标仓库：`emi-pilot-ts`
- 目标仓库远端：无
- Harness commit：`8570d99da3a5a0f7761b0046550cea308b8f2f52`
- 目标基线 commit：`8c9e919b3dbb3ad4c35dfa2f86302521e21c6616`
- 候选交付 commit：`27873357e2a9e917f7889ca6d9774e31a844a430`
- Task / Run：`task-1` / `run-1`
- RunManifest digest：`sha256:81579aa46242d32f09f0af57133e800842422cc645677135280caeabb7789b4b`
- Candidate Evidence Package digest：`sha256:33521091fc535e88cb7448e3c9c8c5391a9640ef6302881b62830e1c66c7760a`

## 场景

固定的 PRD、已确认工程 fixture Context、TRD、ExecutionPlan 和 AcceptanceCriteria 要求目标项目新增 `src/status.ts`，导出值为 `safeguarded`。目标项目中的 `AGENTS.md` 写入了 ambient marker，用来确认 Pi 默认项目资源没有进入受控 Session。

本场景只验证 Harness 的状态、权限、Pi 嵌入、失败恢复、独立检查和证据链，不证明 safeguarding 业务规则、EMD2 解释或任何具体成员国要求正确。

## 运行结果

| RoleRun | Pi Session | 结果 |
| --- | --- | --- |
| `role-executor-1` | `01a02329-2e16-7615-9a76-192094066724` | 第一次写入使用错误旧摘要，Operation `operation-0001` 明确为 `failed`；没有副作用，RoleRun 因无有效交接结算失败，Task 保持 `executing`。 |
| `role-executor-2` | `01a02329-2e5b-700b-ad3e-aa6263b28f5d` | 使用新 Session 在重试额度内写入唯一获准路径；Operation `operation-0008` 为 `succeeded`，ExecutionResult 完成封存。 |
| `role-verifier-1` | `01a02329-2ea6-7955-9cc9-0095abdddcbf` | 无 workspace 写工具，Agent 外 TypeScript 检查通过，VerificationResult 为 PASS。 |

最终 Task 为 `awaiting_acceptance`，Run 保持 `active`。Candidate Evidence Package 明确记录 `userDecisionRecorded: false`，没有调用 `accept_delivery`。

## 证据范围

目标仓库保存规范 JSON 候选包，包含：

- Task、Run、不可变 RunManifest 和完整 transitions；
- TRD 与 Run Authorization Approval 及不可变 ApprovalDecision；
- 输入、ExecutionResult、VerificationResult 和 CheckDefinition 制品；
- 三个 RoleRun、两个 Tool Operation 的 Decision、Intent、Result 和 transitions；
- Controlled EMI Resource 快照；
- 3 条 Runtime Evidence、2 条 Tool Operation Evidence、Execution Evidence、Check Evidence 和 Verification Assurance Evidence。

Harness SQLite、Tool Gateway SQLite、Evidence SQLite、Pi Session、本地绝对路径和测试凭据没有提交到目标项目或 Harness 仓库。

## 执行与复核

从干净 Harness commit 和一个不存在的目标路径执行：

```bash
NODE_NO_WARNINGS=1 npx --yes pnpm@11.7.0 calibrate:v0.1 -- /absolute/path/to/new-target
```

本次执行先完成全工作区检查，再运行真实 Pi AgentSession E2E。执行时共 6 个包、55 个自动化测试通过；随后目标项目 `node checks/verify.mjs` 通过，Evidence Package 内容重新规范化计算得到的 SHA-256 与包摘要一致。

## 结论

Roadmap 第 7 步的工程机制已经跑通，可以进入 v0.1 工程验收与发布记录。真实 EMI 场景、真实模型表现、生产隔离和用户业务验收仍未完成，不得由本记录推断为通过。
