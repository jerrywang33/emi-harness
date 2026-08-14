# v0.1 `new-module` Workflow

本工作流是 EMI Harness v0.1 唯一执行流程。它把 Approved SDD 转换为可验证、可追溯的本地 `emi-pilot` 工程。

## Phase 0：启动或恢复

1. 按 `agent-tools.md` T-01 解析 Harness，并加载 `AGENTS.md`。
2. 读取 `specs/pilot/system-design.md`，确认状态为 `Approved`，记录版本与 commit。
3. 若用户给出 run-id，按 T-08 恢复；否则确认同级 `../emi-pilot` 不含未说明的现有工作。
4. 新运行使用 T-02 分配 run-id，创建目标本地 Git 仓库、证据树和 run 专属空白 Maven 仓库，不配置远端。
5. 从 `execution-tracing.md` 生成 manifest，状态为 `PLANNING`；创建空的 acceptance、retrospective 和 attempt `01` 目录。
6. 生成最小 `preflight-pom.xml`，运行 `code-quality.md` 第一阶段环境预检并留存原始退出码。
7. 环境失败则提交证据、进入 `BLOCKED` 并停止；成功才进入 Phase 1。

## Phase 1：形成执行计划

Coordinator 必须读取：

- Approved SDD 全文。
- `templates/sdd-template.md`，检查批准文档具备执行所需章节。
- `templates/task-breakdown-template.md`。
- 两个 convention、四个 guardrail、scaffold 和 feedback 配置。

随后：

1. 将 SDD 拆成范围单一、可独立核对的任务，写入 run 的 `task-breakdown.md`。
2. 将每个任务映射到 SDD 章节、变更范围、执行角色、自测和 AC 编号。
3. 更新 manifest 为 `AWAITING_PLAN_APPROVAL`，下一动作写为“等待用户批准执行计划”。
4. 提交目标仓库，向用户提供计划摘要、路径和 commit。
5. **停止。未取得用户对该执行计划的明确批准，不得派发 Executor。**

用户要求修改时，Coordinator 只调整计划并重新提交；涉及 SDD 范围或验收变化时，返回 Harness 仓库走 SDD 变更批准。

## Phase 2：Executor 实现

用户批准计划后，Coordinator：

1. 在 manifest 记录批准原文、时间和计划 commit。
2. 更新状态为 `EXECUTING`、责任角色为 Executor、当前 attempt 为 `01` 或下一可用值。
3. 按 T-04 向全新 Executor 上下文提供最小输入并交接。

Executor 必须：

1. 核对目标分支、run-id、attempt、SDD commit 和 task breakdown。
2. 按 `scaffolds/module-structure.md` 创建精确 8 模块工程并复制 canonical Checkstyle 配置。
3. 按任务顺序实现 Spring Boot 启动、`Money` 和四个指定测试类，不添加范围外代码。
4. 使用同一个 `RUN_MAVEN_REPOSITORY` 执行编译和相关单元测试自测；自测不是正式 PASS。
5. 每完成一个逻辑任务提交一次，更新 task breakdown 的事实字段。
6. 写当前 attempt 的 `executor-report.md`，记录最终交接 commit、命令退出码和已知问题。
7. 保持工作区干净后交回 Coordinator，不得写 Verifier 结论。

Coordinator 核对报告和 commit 后，将状态更新为 `VERIFYING` 并提交，再派发 Verifier。

## Phase 3：Verifier 独立验收

Verifier 必须使用全新上下文，并遵守以下顺序：

1. 只读取 T-04 定义的 Verifier 输入，确认待验证 commit 和干净工作区。
2. 检查代码、POM、SDD 和规则，执行有效 POM 命令。
3. 执行 `code-quality.md` 定义的唯一正式验证命令，保存完整 `verify.log` 和真实退出码。
4. 在不读取 `executor-report.md` 的前提下写出带时间戳的初始 PASS/FAIL 结论。
5. 初始结论落盘后才可读取 Executor report，只用于检查交接追溯，不得改变客观结果。
6. 完成 `verifier-report.md` 并提交报告与 run 级证据，不修改业务代码。

### PASS

Coordinator 核对证据后：

- 若交付过程中没有自然 FAIL，先执行 Phase 4 受控失败演练。
- 否则更新 manifest 为 `AWAITING_FINAL_ACCEPTANCE`，生成待用户填写的 acceptance 清单并停止。

### FAIL

Coordinator 将 manifest 更新为 `REWORK_REQUIRED`。如果当前 attempt 小于 3：

1. 保持失败 attempt 只读。
2. 创建下一 attempt。
3. 向全新 Executor 提供完整 Verifier 失败项、原始证据和复现命令。
4. 返回 Phase 2，不允许修改规则或验收标准。

第 3 次 FAIL 后进入 `ESCALATED`，停止并等待用户。

## Phase 4：受控失败演练

只有没有自然 FAIL 时执行。演练必须在不污染最终分支的临时分支或独立 worktree 中：

1. 引入一个可确定触发正式门禁的最小缺陷。
2. 使用独立 Verifier 按 Phase 3 识别 FAIL。
3. Coordinator 记录失败证据、回流目标和恢复动作。
4. 删除临时工作区前确认 main 上待验收 commit 未变化。
5. 原始日志写入 `quality/feedback-loop-drill.log`，结论写入 retrospective。

演练不计入交付 attempt，不得伪造成自然失败。

## Phase 5：用户验收与归档

Coordinator 提供待验收 commit、Verifier 结论、AC-01 至 AC-07 证据索引和已知缺口。然后停止，等待用户明确接受、拒绝或要求修改。

- 接受：将原始决定写入 `acceptance.md`，完成 `retrospective.md`，更新 manifest 为 `COMPLETED`，提交目标仓库，并在 Harness `reports/index.md` 增加索引。
- 要求修改：如果不改变 SDD，按 FAIL 回流创建下一 attempt；如果改变 SDD，暂停运行并走 SDD 变更批准。
- 拒绝：记录原因并进入 `CANCELLED` 或用户指定状态。

运行完成前不得预先写“用户已验收”或 AC-08 PASS。
