# 本地 TypeScript 目标项目校准 v0.1 设计

- 状态：已接受，进入实现
- 对应 Roadmap：v0.1 第 7 步
- 最后更新：2026-08-21

## 目标

用一个独立的本地 TypeScript 仓库证明第 2 至第 6 步可以组成完整工程闭环：固定目标基线和输入，经过人工门禁记录启动 Run，由真实 Pi AgentSession 执行一次可恢复的实现，独立运行确定性检查，再由新的 Verifier Session 形成候选交付结论和 Evidence Package。

本次是机制校准，不是欧洲 EMI 业务验收。任务内容只验证一条简单的 safeguarding 状态映射，不据此确认任何成员国适用性、法律解释、牌照范围或生产控制充分性。

## 目标仓库边界

- 使用逻辑仓库 ID `emi-pilot-ts`，目标代码、检查脚本、校准输入和候选 Evidence Package 保存在独立目标仓库，不复制到 EMI Harness 源代码仓库。
- 现有 `emi-pilot` 是旧 Java 试验项目，本步不删除、不改写，也不把 Java 构建链重新引入 v0.1。
- 目标仓库不创建 GitHub 远端，不包含凭据、客户数据或生产配置；Harness 只记录逻辑仓库 ID、Git object ID、相对路径和内容摘要。
- 自动化测试在临时目录创建等价的最小 TypeScript fixture，用于从干净环境重复验证；它不是正式目标项目或业务模板。

## Runtime 方式

端到端测试必须经过 `PiRuntimePort` 并实际调用 Pi `createAgentSession()`。为避免网络、凭据和模型输出漂移，`runtime-pi/testing` 提供仅供测试与校准使用的 Deterministic Pi Adapter：

- 内部使用 Pi 0.84.2 的 Faux Provider、ModelRuntime、AgentSession、ResourceLoader 和工具协议，不自行模拟 Agent Loop。
- 对外只暴露 EMI 自有的脚本、模型引用和 `PiRuntimePort` 类型，不把 Pi 类型泄漏到其他包。
- 每个 RoleRun 绑定一组一次性响应；响应耗尽、剩余响应、并发 Session 或未知 RoleRun 都失败关闭。
- 该 Adapter 只证明 Pi 嵌入和 Harness 编排契约，不代表生产模型、模型质量、真实 token 成本或网络故障行为。

## 校准流程

1. 读取干净目标仓库的当前 Git commit，生成并封存 PRD、ContextManifest、TRD、ExecutionPlan、AcceptanceCriteria 和 CheckDefinition。
2. 记录测试用 Human Authority 对 TRD 和 RunManifest 的明确批准。它们只属于工程 fixture，不替代后续真实业务人员审批。
3. 第一个 Executor RoleRun 通过 Pi 调用获准写工具，但以错误旧摘要触发确定的前置条件失败，随后因没有有效结构化交接而结算失败；Task 保持 `executing`。
4. 第二个 Executor RoleRun 使用新 Session 和同一固定 Manifest，在重试额度内完成唯一文件写入并提交 ExecutionResult；所有 Operation 对账后进入 `verifying`。
5. Assurance 在 Agent 外直接运行目标项目固定的 TypeScript 检查；Verifier 使用第三个 Pi Session、只读工具集和精确 ExecutionResult 提交 PASS。
6. Control Plane 停在 `awaiting_acceptance`，不由测试或 Agent 调用 `accept_delivery`。
7. 生成候选 Evidence Package，包含 Manifest、输入和输出制品引用、审批快照、Task/Run/RoleRun 终态与 transitions、Tool Operation/Decision/Intent/Result、不可变 Evidence 和包摘要；目标仓库只写入该导出文件，不提交 Harness SQLite 或 Pi Session。

## 可重复运行

- 自动化 E2E 从临时 Git 仓库和固定输入开始，不能依赖用户目录、环境凭据、默认 Pi 资源或网络。
- 本地校准从目标仓库干净基线启动；输出路径、Run ID 和基线 commit 必须显式记录。已经产生输出的工作区不能静默覆盖，应使用新的干净 clone 或新的 Run。
- Candidate Evidence Package 使用规范 JSON 和 SHA-256；重新读取时必须验证包摘要及其内 Evidence 摘要。

## 验收条件

1. 实际事件证明三个 RoleRun 均由 Pi AgentSession 运行，Session ID 两两不同，目标项目中的 ambient `AGENTS.md` 未进入受控资源。
2. 首次已知失败不会阻塞 Task，也不会产生副作用；第二次执行成功，且只修改 RunManifest 允许的 TypeScript 文件。
3. Verifier 无写工具，required check 在 Agent 外通过；PASS 只推进到 `awaiting_acceptance`。
4. 重开 Control Plane、Tool Gateway 和 Evidence Store 后仍能核对最终状态、操作结果和 Evidence。
5. Candidate Evidence Package 能从目标仓库读取并校验摘要，包含从目标和批准输入到代码、检查、验证结论的完整引用。
6. 全工作区检查和本地目标项目自身检查通过；校准记录明确保留用户真实业务验收为第 8 步之后的工作。

## 已知限制

- Faux Provider 的脚本输出不是模型能力评估。
- 本地 helper process 和 Node check process 不是生产沙箱。
- v0.1 不签名 Evidence Package，不接入远程 Git、CI、工单、生产 IAM 或长期对象存储。
- 本次小任务不验证完整 EMI 领域模型、法规覆盖或生产部署架构。
