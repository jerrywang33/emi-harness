# 首次试跑系统设计（SDD）

## 文档信息

| 属性 | 值 |
| --- | --- |
| 所属阶段 | v0.1 最小可运行闭环 |
| 任务类型 | `new-module` |
| 文档状态 | Draft |
| 创建日期 | 2026-08-13 |
| 决策者 | 用户 |
| 维护者 | Coordinator |

本文档是首次试跑的执行与验收契约。在状态变为 `Approved` 前不得进入代码实现；批准后的范围或验收标准变化必须经用户确认并记录修订原因。

## 1. 试跑目的

首次试跑用于验证：一个不依赖历史对话的新 Agent，能否只根据 EMI Harness 提供的规格、规则、工作流和反馈机制，完成一次可编译、可验证、可追溯且可恢复的设计到交付任务。

8 模块 Java 工程和 `Money` 值对象是校准 Harness 的试验载体，不是完整 EMI 业务系统，也不以业务功能数量衡量本次试跑是否成功。

## 2. 已确认范围

- 仅支持一个 `new-module` 工作流。
- 由 Coordinator、Executor 和 Verifier 三个角色完成规划、实现、独立验证和失败回流。
- 生成一个包含 8 个模块的 Java 17 Maven 工程，模块职责和依赖方向遵循根目录 [README](../../README.md#8-模块架构)。
- 实现不可变 `Money` 值对象，并覆盖不可变性、同币种运算和异币种拒绝测试。
- 使用 `mvn verify`、Checkstyle、ArchUnit 和单元测试形成客观验证结论。
- Verifier 判定失败时必须提供失败项、原始证据和复现方式，最多回流三轮。
- 运行状态、角色交接、执行报告、验证报告和原始日志必须落盘，并通过同一个 `run-id` 追溯。
- Verifier 通过后仍需用户最终验收。

## 3. 不在本次范围

- 不实现完整 EMI 业务能力。
- 不建设 EMD2、DORA、GDPR、AML/CFT 或制裁规则知识库。
- 不接入数据库、消息队列、缓存、支付渠道、银行、KYC、AML 或制裁筛查系统。
- 不增加 `new-feature`、`refactor` 或其他工作流。
- 不建设 PRD 生成、复杂 Agent 调度或 Harness 自我进化机制。

## 4. 待冻结决策

以下决策必须逐项确认，确认后的结论将写入对应设计章节：

| 编号 | 决策 | 需要冻结的内容 | 状态 |
| --- | --- | --- | --- |
| D-01 | 试跑项目身份 | 系统名、目录名、Maven 坐标、Java 根包、产物保存位置 | 已确认 |
| D-02 | 技术基线 | 已选技术的精确版本、依赖来源和干净环境可构建条件 | 已确认 |
| D-03 | 8 模块完成度 | 每个模块必须包含的最小内容及精确依赖关系 | 已确认 |
| D-04 | `Money` 契约 | 所属模块、创建、规范化、运算、比较、异常和相等性语义 | 待确认 |
| D-05 | 自动化门禁 | 插件版本、规则范围、唯一验证命令及禁止绕过方式 | 待确认 |
| D-06 | 验收与证据 | 可执行验收场景、报告字段、日志和 `run-id` 追溯关系 | 待确认 |

## 5. 项目标识与交付位置

| 属性 | 确认值 |
| --- | --- |
| 系统名 | `emi-pilot` |
| 目标目录名 | `emi-pilot` |
| Maven 聚合 artifactId | `emi-pilot` |
| Maven groupId | `com.jd.emiharness` |
| Java 根包 | `com.jd.emiharness.pilot` |
| 默认本地位置 | EMI Harness 同级目录 `../emi-pilot` |
| Git 边界 | 独立 Git 仓库 |
| Git 远端 | 首次运行前由用户另行决定 |

8 个子模块统一使用 `emi-pilot` 前缀：

- `emi-pilot-client`
- `emi-pilot-adapter`
- `emi-pilot-app`
- `emi-pilot-domain`
- `emi-pilot-infra`
- `emi-pilot-start`
- `emi-pilot-common`
- `emi-pilot-test`

### 5.1 仓库边界

- `emi-harness` 保存规格、规则、工作流、模板和工具，不保存首次试跑生成的业务代码。
- `emi-pilot` 保存生成代码、运行状态、执行报告、验证报告和原始质量日志。
- Coordinator 启动运行时必须把目标项目的绝对路径写入 `manifest.md`，后续角色不得通过当前工作目录猜测目标位置。
- `emi-pilot` 的 Git 历史与 EMI Harness 分离，避免将 Harness 规则变更和试跑产物混入同一提交。

## 6. 技术栈与构建环境

### 6.1 固定基线

| 项目 | 确认值 |
| --- | --- |
| JDK | Java 17 |
| Maven | 3.9 或更高版本 |
| Parent POM | `com.jd.framework:dong-boot-dependencies:2.0.9` |
| 应用框架 | DongBoot 2.0.9 |
| 源码与构建编码 | UTF-8 |
| 单元测试 | JUnit 5，具体版本由固定的 Parent POM 管理 |
| 架构测试 | `com.tngtech.archunit:archunit-junit5:1.2.1` |

DongBoot 必须进入首次试跑的真实构建链路。否则本次运行只能证明通用 Maven 工程可用，不能证明 EMI Harness 能够适配团队的实际技术栈。

### 6.2 依赖范围

- 首次试跑只引入 8 模块骨架、DongBoot 启动、`Money` 实现、单元测试和架构测试实际需要的依赖。
- MyBatis、MySQL、JMQ、Redis、JSF、MapStruct 及其他未被本次功能使用的组件不进入 POM。
- “沿用现有技术栈”表示后续真实需求继续使用已确认的团队技术体系，不表示最小工程必须预装全部组件。
- 所有显式版本必须在根 POM 集中管理；由 Parent POM 管理的最终版本通过 `help:effective-pom` 留证。

### 6.3 Maven 依赖来源

- DongBoot Parent 和内部依赖通过执行环境提供的 Maven `settings.xml` 解析。
- Maven 凭据、访问令牌和包含凭据的仓库地址不得写入 `emi-harness` 或 `emi-pilot`。
- `settings.xml` 的实际位置由 Coordinator 写入运行状态，但报告不得复制其中的敏感内容。

### 6.4 执行前环境门禁

Coordinator 在创建实现任务前必须完成环境预检，并将命令、退出码和原始输出写入 `reports/runs/{run-id}/quality/environment-preflight.log`：

1. `java -version` 显示 Java 17。
2. `mvn -version` 显示 Maven 3.9 或更高版本，并使用 Java 17。
3. 使用外部 Maven settings 从一个新的空本地仓库解析 `com.jd.framework:dong-boot-dependencies:2.0.9`。
4. 生成并保存有效 POM，确认 Parent POM、JUnit 和其他受管依赖的最终版本。

首次运行必须使用 run 专属的空 Maven 本地仓库完成依赖解析和构建，不能因命中开发机已有缓存而判定环境可用。任一预检失败时，运行状态记为 `BLOCKED`，不得派发 Executor，也不得通过跳过插件、切换 Parent 或删除依赖来绕过。

设计阶段检查时，当前机器尚未发现 Java、Maven、Maven settings 或 DongBoot 2.0.9 本地缓存。该事实不改变技术基线，但必须在首次运行前解决。

## 7. 模块结构与依赖矩阵

### 7.1 Maven 模块拓扑

根工程使用 `pom` packaging，并且必须声明以下 8 个且仅此 8 个子模块。所有子模块统一继承根 POM，内部依赖版本在根 POM 集中管理。

| 模块 | Packaging | 必须声明的内部依赖 | 首次试跑的最小内容 |
| --- | --- | --- | --- |
| `emi-pilot-common` | `jar` | 无 | 模块 POM；是否承载 `Money` 由 D-04 决定 |
| `emi-pilot-client` | `jar` | `common` | 模块 POM；本次没有外部契约，不生成 Facade 或 DTO |
| `emi-pilot-domain` | `jar` | `common` | 模块 POM；是否承载 `Money` 由 D-04 决定 |
| `emi-pilot-app` | `jar` | `client`、`domain`、`common` | 模块 POM；本次没有应用用例，不生成 AppService 或 Gateway |
| `emi-pilot-infra` | `jar` | `app`、`domain`、`client`、`common` | 模块 POM；本次没有持久化或外部接入，不生成实现类 |
| `emi-pilot-adapter` | `jar` | `app`、`common` | 模块 POM；本次没有 REST、MQ 或 Scheduler，不生成入口代码 |
| `emi-pilot-start` | `jar` | `adapter`、`app`、`infra`、`client`、`domain`、`common` | 模块 POM 和最小 DongBoot 启动类 |
| `emi-pilot-test` | `jar` | 其余 7 个模块，均为 test scope | 模块 POM、模块结构测试和 ArchUnit 分层测试 |

表格中的依赖集合是首次试跑的精确值，每个模块必须完整声明且不得增加其他内部依赖。构建顺序由 Maven Reactor 根据依赖图确定，不能通过手工脚本掩盖错误依赖。

### 7.2 最小内容原则

- 8 个模块必须全部存在并参与根工程构建，即使某个模块本次没有 Java 源码。
- 不为填充目录而生成占位 Facade、DTO、AppService、Gateway、Repository、PO、Controller、Consumer 或 Scheduler。
- 没有实际源码的模块只保留 POM，不创建无用途的标记类或 `.gitkeep`。
- `emi-pilot-start` 必须包含可编译的 DongBoot 启动类，确保 DongBoot 进入真实编译链路。
- `Money` 及其模块内单元测试放置位置和行为由 D-04 冻结。
- 模块内单元测试与被测代码同模块；跨模块结构和架构测试统一放入 `emi-pilot-test`。

本次保留空的 `adapter` 模块，是为了验证已经约定的 8 模块拓扑。后续真实项目仍按能力清单决定是否需要该模块，不能据此推导所有 EMI 系统都必须包含 adapter。

### 7.3 结构验证

`emi-pilot-test` 至少包含以下两类客观测试：

- `ModuleStructureTest`：验证根 POM 声明的模块集合、子模块 POM、Parent 坐标和内部依赖集合与本节一致。
- `LayerDependencyArchTest`：验证当前已有 Java 代码遵守 `common`、`client`、`domain`、`app`、`infra`、`adapter` 和 `start` 的允许依赖方向。

ArchUnit 只能验证实际存在的字节码，不能证明空模块的 POM 依赖正确，因此不得用 `LayerDependencyArchTest` 代替 `ModuleStructureTest`。

## 8. 待补充设计章节

以下章节在对应决策确认后补充，未确认内容不得由 Agent 自行推断：

1. `Money` 领域契约。
2. 测试与质量门禁。
3. 运行状态与交付证据。
4. 验收场景与完成判定。

## 9. 批准记录

| 版本 | 日期 | 状态 | 说明 |
| --- | --- | --- | --- |
| v0.1-draft.1 | 2026-08-13 | Draft | 建立首次试跑契约骨架，等待逐项确认 D-01 至 D-06 |
| v0.1-draft.2 | 2026-08-13 | Draft | 确认 D-01：冻结 `emi-pilot` 项目标识、交付位置和仓库边界 |
| v0.1-draft.3 | 2026-08-13 | Draft | 确认 D-02：冻结技术版本、最小依赖策略和干净环境预检门禁 |
| v0.1-draft.4 | 2026-08-14 | Draft | 确认 D-03：冻结 8 模块拓扑、精确依赖矩阵和最小内容原则 |
