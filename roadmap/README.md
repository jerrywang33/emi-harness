# EMI Harness Roadmap

本文件维护 EMI Harness 的阶段目标、实施计划、退出条件和当前进度。Roadmap 只记录已经进入建设范围的能力；后续阶段根据真实运行证据决定，不提前扩张。

## 阶段总览

| 阶段 | 状态 | 核心目标 |
| --- | --- | --- |
| v0.1 最小可运行闭环 | 进行中 | 验证 Agent 能否在 Harness 约束下完成一次可验证、可追溯、可恢复的设计到交付任务 |

当前阶段完成前，不启动下一阶段。

## v0.1 最小可运行闭环

### 阶段定位

当前阶段建设 EMI Harness 的第一个最小运行闭环。它要验证的不是 `Money` 能否被实现，而是：

> 一个 Agent 能否只依赖 Harness 提供的规格、规则、工作流和反馈机制，将一个设计任务稳定地交付为可编译、可验证、可追溯的代码。

8 模块 Java 工程和 `Money` 值对象是首次试跑的校准任务，不代表完整 EMI 业务系统。

### 阶段目标

1. **可以启动**：新 Agent 不依赖历史对话，通过 `AGENTS.md` 和 `SKILL.md` 进入工作流。
2. **可以执行**：Coordinator、Executor 和 Verifier 的职责、输入、输出及上下文边界清晰。
3. **可以验证**：使用单元测试、Maven、Checkstyle 和 ArchUnit 形成客观验收结果。
4. **可以回流**：Verifier 输出失败证据和复现方式，由 Coordinator 交回 Executor，最多执行三轮。
5. **可以恢复**：会话中断或更换 Agent 后，可以根据落盘状态继续执行。
6. **可以审计**：目标、任务、代码变更、验证结果和最终结论可以互相追溯。
7. **可以复现**：从干净目录重新运行，能够得到一致的工程结构和质量结果。

### 实施原则

第一版采用文件驱动状态、Agent 执行和 Maven/Shell 客观验证，不先建设复杂的 Agent 调度平台。每个新增文件都必须在首次试跑中被实际读取或生成。

### 实施计划

| 步骤 | 工作内容 | 交付物 | 状态 |
| --- | --- | --- | --- |
| 1 | 冻结首次试跑契约，明确 8 个模块、依赖方向、`Money` 行为和验收条件 | `specs/pilot/system-design.md` | 进行中 |
| 2 | 建设首次试跑需要的最小上下文和执行入口 | `AGENTS.md`、Conventions、Guardrails、Templates、Workflow、Skill、Feedback、Observability | 待开始 |
| 3 | 由 Coordinator 创建运行并拆解任务，经用户确认后进入执行 | `manifest.md`、`task-breakdown.md` | 待开始 |
| 4 | 由 Executor 在干净目标目录中生成工程、实现代码并自测 | 8 模块工程、`Money`、单元测试、`attempts/{attempt}/executor-report.md` | 待开始 |
| 5 | 由全新上下文中的 Verifier 独立检查，失败时带证据回流 | `attempts/{attempt}/verifier-report.md`、`attempts/{attempt}/quality/verify.log` | 待开始 |
| 6 | 用户验收并复盘首次运行，根据真实缺口决定后续能力 | 最终运行状态、验收结论、缺口清单 | 待开始 |

### 完成标准

v0.1 只有在以下条件全部满足后才能结束：

- 首次试跑达到根目录 [README](../README.md#首次试跑) 定义的全部验收条件。
- 新 Agent 可以在没有历史对话的情况下，从 Harness 入口完成同一闭环。
- Coordinator、Executor 和 Verifier 的状态与交接均已落盘，不依赖口头完成声明。
- 验证失败能够按既定路径回流，重试达到上限后能够停止并升级给用户。
- 最终代码、验证命令、原始日志和验收结论能够通过同一个 `run-id` 追溯。
- 用户完成最终验收。

### 本阶段不做

- 不建设完整 EMI 业务系统或监管知识库。
- 不增加 `new-feature`、`refactor` 等其他工作流。
- 不建设 PRD 生成、外部系统接入或复杂 Agent 调度平台。
- 不建设 Harness 自我进化机制。
- 不根据假设预先设计 v0.2；首次运行暴露的真实缺口才是后续 Roadmap 的输入。

## 维护规则

- 每个计划步骤开始、完成或受阻时，更新状态和实际结果。
- 计划变化必须说明触发变化的运行证据或明确决策。
- 阶段完成后保留原始目标和结果，再新增下一阶段，避免覆盖历史。
- Roadmap 描述项目推进状态；具体运行状态以目标项目中的 `reports/runs/{run-id}/manifest.md` 为准。
