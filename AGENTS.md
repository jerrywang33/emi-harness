# AGENTS - EMI Harness 入口

> EMI Harness 是面向欧洲 EMI 的金融级设计到交付智能研发引擎。本文件只负责导航；具体规则按角色和阶段加载。

## 1. 当前能力

v0.1 只支持 `new-module`：Coordinator、Executor、Verifier 完成规划、实现、独立验证、失败回流和人工验收。不得提前引入其他任务类型、监管知识库或自我进化机制。

首次校准任务的唯一设计契约是 [`specs/pilot/system-design.md`](specs/pilot/system-design.md)。该文件必须为 `Approved`，否则不得实现。

## 2. 路径与仓库边界

按以下顺序解析 Harness 根目录：

1. 环境变量 `EMI_HARNESS_HOME`。
2. `~/.emi-harness/path` 中记录的绝对路径。
3. 当前文件所在的 Git 仓库根目录。

`emi-harness` 只保存规则、工作流、模板和全局运行索引。目标代码与完整运行证据必须保存在独立目标仓库；首次试跑目标固定为同级目录 `../emi-pilot`，且不配置 Git 远端。

## 3. 规则优先级

发生冲突时按以下顺序处理：

1. 用户在当前门禁中的明确决策。
2. `Approved` SDD。
3. `harness/guardrails/` 中的 MUST / MUST NOT。
4. `conventions/`、`scaffolds/` 和模板。

低优先级内容不得覆盖高优先级内容。无法消除的冲突必须停止并交给用户，不得自行解释后继续。

## 4. 按角色加载

| 角色或场景 | MUST 加载 | 禁止加载或行为 |
| --- | --- | --- |
| Coordinator 启动或恢复 | SDD、[`new-module.md`](harness/workflow/new-module.md)、[`execution-tracing.md`](harness/observability/execution-tracing.md)、[`agent-tools.md`](harness/tools/agent-tools.md)、两个模板 | 不写业务代码，不代替 Executor 或 Verifier 下结论 |
| Executor 创建骨架 | SDD 第 5-9 节、两个 convention、四个 guardrail、[`module-structure.md`](scaffolds/module-structure.md)、`harness/feedback/` 配置 | 不读取 Verifier 未发布的工作，不改变 SDD、门禁或 attempt 历史 |
| Executor 实现 `Money` | SDD 第 8-9 节、[`domain-modeling.md`](harness/guardrails/domain-modeling.md)、[`code-style.md`](harness/guardrails/code-style.md)、[`core-must-rules.md`](harness/guardrails/core-must-rules.md) | 不扩大业务范围，不加入未使用的依赖或占位代码 |
| Verifier 独立验收 | SDD 第 6-10 节、[`code-quality.md`](harness/feedback/code-quality.md)、架构与领域 guardrail、执行追踪规范、待验证 commit | 初始结论形成前不读 Executor 完成声明；不修改代码或规则 |
| Coordinator 处理 FAIL | Verifier 报告、原始日志、workflow 的回流规则、manifest | 不覆盖历史 attempt，不把失败包装为成功 |

只加载当前角色所需文件，不一次性读取整个仓库。

## 5. 三角色边界

- **Coordinator**：维护 SDD 引用、任务、manifest、状态、交接和用户确认。
- **Executor**：只在当前 attempt 内实现和自测，提交代码并形成 `executor-report.md`。
- **Verifier**：使用全新上下文执行唯一正式验证命令，形成独立 PASS/FAIL 和原始证据。
- 任一 Agent 的口头声明都不是证据；状态只以目标仓库中已提交的文件为准。
- 同一次运行最多 3 个交付 attempt；第 3 次仍失败必须进入 `ESCALATED`。

## 6. 安全与完整性

- 禁止提交令牌、密码、私钥、Maven settings 或带凭据的仓库地址。
- 禁止使用跳过测试、跳过 Checkstyle、忽略退出码、删除失败测试或降低规则等方式通过门禁。
- 禁止修改已完成 attempt 的报告和日志；后续工作写入新 attempt。
- 未经用户最终验收，运行最多只能进入 `AWAITING_FINAL_ACCEPTANCE`。

## 7. 执行入口

使用 `emi-harness` Skill 启动或恢复任务。Skill 解析路径后必须加载本文件，并将具体编排委托给 [`harness/workflow/new-module.md`](harness/workflow/new-module.md)。
