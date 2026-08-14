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
| D-04 | `Money` 契约 | 所属模块、创建、规范化、运算、比较、异常和相等性语义 | 已确认 |
| D-05 | 自动化门禁 | 插件版本、规则范围、唯一验证命令及禁止绕过方式 | 已确认 |
| D-06 | 验收与证据 | 可执行验收场景、报告字段、日志和 `run-id` 追溯关系 | 已确认 |

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
| `emi-pilot-common` | `jar` | 无 | 模块 POM；本次不生成 Java 源码 |
| `emi-pilot-client` | `jar` | `common` | 模块 POM；本次没有外部契约，不生成 Facade 或 DTO |
| `emi-pilot-domain` | `jar` | `common` | 模块 POM、`Money` 值对象及其单元测试 |
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
- `Money` 及其单元测试放在 `emi-pilot-domain`，具体行为遵循 D-04 契约。
- 模块内单元测试与被测代码同模块；跨模块结构和架构测试统一放入 `emi-pilot-test`。

本次保留空的 `adapter` 模块，是为了验证已经约定的 8 模块拓扑。后续真实项目仍按能力清单决定是否需要该模块，不能据此推导所有 EMI 系统都必须包含 adapter。

### 7.3 结构验证

`emi-pilot-test` 至少包含以下两类客观测试：

- `ModuleStructureTest`：验证根 POM 声明的模块集合、子模块 POM、Parent 坐标和内部依赖集合与本节一致。
- `LayerDependencyArchTest`：验证当前已有 Java 代码遵守 `common`、`client`、`domain`、`app`、`infra`、`adapter` 和 `start` 的允许依赖方向。

ArchUnit 只能验证实际存在的字节码，不能证明空模块的 POM 依赖正确，因此不得用 `LayerDependencyArchTest` 代替 `ModuleStructureTest`。

## 8. `Money` 领域契约

### 8.1 归属与类型

`Money` 位于：

```text
emi-pilot-domain/
└── src/main/java/com/jd/emiharness/pilot/domain/money/Money.java
```

- `Money` 是 `final` 类，实现 `Comparable<Money>`。
- 内部只保存 `private final BigDecimal value` 和 `private final Currency currency`。
- 构造器不公开，只能通过工厂方法创建。
- 不提供 setter；`BigDecimal` 和 `Currency` 均按不可变对象使用。
- 本次不实现 Jackson 序列化，也不实现 Java `Serializable`。
- 本次不提取 Shared Kernel；出现跨系统复用证据后再单独决策。

### 8.2 公开 API

| 分类 | 方法 | 语义 |
| --- | --- | --- |
| 创建 | `of(BigDecimal value, String currency)` | 按 ISO 4217 币种精度创建金额 |
| 创建 | `ofMinorUnits(long minorUnits, String currency)` | 从币种最小单位创建金额 |
| 创建 | `zero(String currency)` | 创建指定币种的零值 |
| 访问 | `getValue()` | 返回规范化后的 `BigDecimal` 金额 |
| 访问 | `getCurrency()` | 返回大写 ISO 4217 币种代码 |
| 访问 | `getScale()` | 返回币种的小数位数 |
| 访问 | `getMinorUnits()` | 返回最小单位整数，超出 `long` 范围时抛出 `ArithmeticException` |
| 判断 | `isZero()`、`isPositive()`、`isNegative()` | 判断金额符号 |
| 运算 | `add(Money other)`、`subtract(Money other)` | 同币种加减 |
| 运算 | `multiply(BigDecimal factor, RoundingMode mode)` | 使用显式舍入模式乘以因子 |
| 运算 | `divide(BigDecimal divisor, RoundingMode mode)` | 使用显式舍入模式除以因子 |
| 运算 | `abs()`、`negate()` | 绝对值和取反 |
| 比较 | `compareTo(Money other)` | 同币种数值比较 |
| 比较 | `isGreaterThan`、`isLessThan`、`isGreaterThanOrEqualTo`、`isLessThanOrEqualTo` | 同币种比较的语义化方法 |
| 对象 | `equals()`、`hashCode()` | 以规范化金额和币种判定值相等 |
| 对象 | `toString()` | 固定输出 `{currency} {value}`，例如 `EUR 10.00` |

不提供接收 `double` 的工厂方法，也不提供省略 `RoundingMode` 的乘除重载。

### 8.3 创建与规范化

- `value`、`currency`、运算参数和 `RoundingMode` 均不得为 `null`；传入 `null` 时抛出 `NullPointerException`。
- 币种代码必须是未经空白包裹的大写 ISO 4217 三字母代码，不做 `trim` 或大小写自动修正。
- 使用 `Currency.getInstance(currency)` 校验币种；未知代码抛出 `IllegalArgumentException`。
- `Currency.getDefaultFractionDigits()` 小于 0 的特殊代码不属于本次支持的法币，抛出 `IllegalArgumentException`。
- 使用币种默认小数位规范化金额。允许删除不改变数值的尾随零，但需要舍入才能达到币种精度时抛出 `ArithmeticException`。
- `EUR 1`、`EUR 1.0` 和 `EUR 1.00` 均规范化为 `EUR 1.00`；JPY 金额规范化为 0 位小数。
- 零值和负数是合法的 `Money`；正数限制由具体业务规则负责。

### 8.4 运算与比较

- `add`、`subtract`、`compareTo` 及四个语义化比较方法只接受相同币种。
- 不同币种参与上述操作时抛出 `IllegalArgumentException`，不得隐式换汇。
- 加减法必须保持当前币种精度，不执行额外舍入。
- 乘除结果按当前币种精度和调用方传入的 `RoundingMode` 计算。
- 除数为零时抛出 `ArithmeticException`。
- 因子和除数可以为正数或负数；业务是否允许负数由调用方约束。
- 所有操作均不得改变当前对象；对象引用是否复用不属于公开契约。

### 8.5 相等性

- 相同币种且规范化后数值相同的对象必须 `equals`，并产生相同 `hashCode`。
- 不同币种即使数值相同也不相等。
- `compareTo` 与 `equals` 在同币种范围内保持一致。

### 8.6 必须覆盖的单元测试

- 类为 `final`、字段为 `private final`、不存在 setter，运算不修改原对象。
- EUR 两位小数和 JPY 零位小数规范化正确，需要舍入的输入被拒绝。
- 小写、带空白、未知以及无有效小数位的币种代码被拒绝。
- `ofMinorUnits` 与 `getMinorUnits` 可以正确往返，超出 `long` 范围被拒绝。
- 零值、正值和负值判断正确。
- 同币种加法、减法、绝对值和取反正确。
- 乘法和除法按调用方指定的 `RoundingMode` 得到不同且正确的结果。
- 异币种加法、减法和比较均被拒绝。
- 除数为零被拒绝。
- 不同输入 scale 的同值金额具有一致的 `equals` 和 `hashCode`。
- `toString()` 输出稳定格式。

## 9. 测试与质量门禁

### 9.1 门禁矩阵

| 门禁 | 工具与版本 | 必须执行的内容 | 通过标准 |
| --- | --- | --- | --- |
| 编译 | `maven-compiler-plugin:3.11.0` | 根工程和全部 8 个模块使用 Java 17 编译 | Maven Reactor 全部 `SUCCESS` |
| 单元测试 | JUnit 5 + Maven Surefire | `MoneyTest`、`MoneyImmutabilityTest` | 测试被实际发现且全部通过 |
| 模块结构 | JUnit 5 + Maven Surefire | `ModuleStructureTest` | 模块、Parent 和内部依赖矩阵符合第 7 节 |
| 架构边界 | `archunit-junit5:1.2.1` | `LayerDependencyArchTest` | 所有已存在 Java 代码遵守分层依赖方向 |
| 代码规范 | `maven-checkstyle-plugin:3.3.1` + Checkstyle `10.14.2` | 检查全部主源码 | 零违规 |

JUnit 5 和 Maven Surefire 的最终版本由固定的 DongBoot Parent POM 管理，并通过有效 POM 记录。`MoneyTest` 与 `MoneyImmutabilityTest` 所在的 domain 模块，以及两个跨模块测试所在的 test 模块，必须配置为没有发现测试时构建失败。

Checkstyle 首次沿用 demo 已实际使用的规则，配置的 canonical source 为 `harness/feedback/checkstyle/checkstyle.xml`。首轮只检查主源码；测试源码规范在最小闭环跑通后再评估，不得在本轮临时扩大范围。

### 9.2 唯一验证命令

正式验证只接受以下 Maven 命令：

```bash
mvn --batch-mode --errors --no-transfer-progress clean verify
```

Maven settings 和 run 专属本地仓库由运行环境按第 6.3、6.4 节注入，不得通过修改目标项目的技术基线形成另一套验证命令。记录日志时必须保留 Maven 的真实退出码，不能因管道或日志工具覆盖失败状态。

### 9.3 PASS 判定

Verifier 只有在以下条件全部满足时才能判定 `PASS`：

- 唯一验证命令退出码为 `0`。
- Maven Reactor 中根工程和 8 个子模块全部为 `SUCCESS`。
- `MoneyTest`、`MoneyImmutabilityTest`、`ModuleStructureTest` 和 `LayerDependencyArchTest` 均被实际发现并执行，且没有失败或错误。
- Checkstyle 被实际执行并报告零违规。
- 完整原始命令输出已写入 `reports/runs/{run-id}/attempts/{attempt}/quality/verify.log`。

命令退出码为 `0` 但缺少任一指定测试、Checkstyle 执行记录或完整日志时，仍判定为 `FAIL`。

### 9.4 禁止绕过

正式验证不得采用以下方式：

- 使用 `-DskipTests`、`-Dmaven.test.skip=true`、`-Dcheckstyle.skip=true` 或同类跳过参数。
- 只验证单个模块、单个测试类或部分 Reactor 后宣称整体通过。
- 删除失败测试、降低规则、增加排除项或修改验收条件后直接重跑。
- 使用历史日志、Executor 自测结论或手工描述代替 Verifier 独立执行。
- 使用 `|| true`、忽略退出码或其他方式把失败命令包装为成功。

如果测试或规则本身需要修改，Coordinator 必须先停止当前验证回流并取得用户确认；此类变更属于规格调整，不属于 Executor 的普通修复权限。

### 9.5 首轮延期门禁

PMD、P3C、SpotBugs、JaCoCo 和 SonarQube 不进入首次闭环。首轮运行完成后，根据实际缺口逐项评估，不得因为 demo 已存在配置就一次性引入。

## 10. 运行状态、验收与证据

### 10.1 Run ID

每次运行由 Coordinator 分配唯一且不可变的 `run-id`：

```text
{YYYYMMDD}-{NNN}-new-module-emi-pilot
```

- 日期使用运行开始时的 Asia/Shanghai 自然日。
- `NNN` 是当日三位递增序号，从 `001` 开始。
- Coordinator 通过目标项目现有运行目录确定下一个可用序号，创建目录后不得改名或复用。
- Harness commit、SDD commit、目标仓库和全部运行证据都通过该 `run-id` 关联。

### 10.2 证据目录

运行证据保存在 `emi-pilot` 目标仓库：

```text
reports/runs/{run-id}/
├── manifest.md
├── task-breakdown.md
├── acceptance.md
├── retrospective.md
├── quality/
│   ├── environment-preflight.log
│   ├── effective-pom.xml
│   └── feedback-loop-drill.log       # 仅在没有自然 FAIL 时生成
└── attempts/
    ├── 01/
    │   ├── executor-report.md
    │   ├── verifier-report.md
    │   └── quality/
    │       └── verify.log
    ├── 02/                            # 发生第一次回流时创建
    └── 03/                            # 发生第二次回流时创建
```

- attempt 从 `01` 开始，每次 Executor 接收新的修复交接后递增。
- 已完成交接的 attempt 目录只读，不得覆盖或删除；后续结果写入新的 attempt。
- 环境预检和有效 POM 属于 run 级证据，不随 attempt 重复生成。
- `acceptance.md` 和 `retrospective.md` 在最终验收阶段完成。
- 完成运行后，在 EMI Harness 的 `reports/index.md` 增加索引，但不复制目标项目的完整证据。

### 10.3 运行状态

主流程状态如下：

```text
PLANNING
→ AWAITING_PLAN_APPROVAL
→ EXECUTING
→ VERIFYING
→ REWORK_REQUIRED → EXECUTING
→ AWAITING_FINAL_ACCEPTANCE
→ COMPLETED
```

补充状态：

| 状态 | 含义 | 后续处理 |
| --- | --- | --- |
| `BLOCKED` | 环境或外部前置条件不满足 | 记录原因和恢复状态，条件满足后由 Coordinator 恢复 |
| `ESCALATED` | 第 3 次验证仍为 FAIL，或发生 Agent 无权决定的问题 | 停止自动执行，等待用户决策 |
| `CANCELLED` | 用户明确取消运行 | 记录原因并停止，不复用该 `run-id` |

一次运行最多包含 3 个 Executor-Verifier attempt。第 1 或第 2 次验证失败时进入 `REWORK_REQUIRED`；Coordinator 将完整失败报告交给下一轮 Executor。第 3 次仍失败时进入 `ESCALATED`，不得继续自动修改。

Verifier 通过后只能进入 `AWAITING_FINAL_ACCEPTANCE`。只有用户验收、证据归档和最终 Git 状态全部完成后，Coordinator 才能将运行标记为 `COMPLETED`。

### 10.4 Manifest 必填字段

`manifest.md` 至少记录：

- `run-id`、任务类型、创建时间和最后更新时间。
- Harness 仓库地址、Harness commit、SDD 路径和 SDD commit。
- 目标项目绝对路径、Git 仓库、分支、起始 commit 和当前 commit。
- 当前状态、当前 attempt、最大 attempt 和当前责任角色。
- 最近完成的交付物、下一步动作、阻塞原因和恢复状态。
- 用户对计划和最终结果的确认记录。
- 每个 attempt 的 Executor commit、Verifier 结论和证据路径。
- 最终结论以及 `acceptance.md`、`retrospective.md` 的路径。

任何 Agent 的口头完成声明都不能替代 manifest 状态。每次角色交接前必须先更新对应报告，再由 Coordinator 更新 manifest。

### 10.5 角色证据边界

- Coordinator 维护 `manifest.md` 和 `task-breakdown.md`，不得代替 Executor 或 Verifier 写完成结论。
- Executor 只写当前 attempt 的 `executor-report.md`，记录加载的规格与规则、变更文件、自测命令、退出码、已知问题和交接 commit。
- Verifier 使用全新上下文，只接收 SDD、验证规则、目标路径和待验证 commit；形成初始结论前不读取 Executor 的完成声明。
- Verifier 写入当前 attempt 的 `verifier-report.md` 和原始 `verify.log`，逐项给出 PASS/FAIL、证据路径和复现方式。
- 用户最终结论记录在 `acceptance.md`，Coordinator 不得代签。

报告和日志提交前必须检查是否包含凭据、令牌或 Maven settings 内容。发现敏感信息时不得提交；应先停止、处置凭据暴露原因并重新产生不含敏感信息的原始运行日志。

### 10.6 可执行验收场景

| 编号 | 验收内容 | 最小证据 |
| --- | --- | --- |
| AC-01 | 根 POM 和 8 个模块符合精确依赖矩阵 | `ModuleStructureTest` 结果、Verifier 报告、`verify.log` |
| AC-02 | `Money` 完整满足第 8 节契约 | domain 单元测试结果、Verifier 报告、`verify.log` |
| AC-03 | 唯一 `clean verify` 门禁完整通过 | 命令退出码、Reactor Summary、Checkstyle 和测试输出 |
| AC-04 | Verifier 使用全新上下文独立验收 | Verifier 报告中的上下文清单和独立结论 |
| AC-05 | FAIL 能携带证据回流，且最多执行 3 个 attempt | 历史 attempt；无自然 FAIL 时使用受控演练日志和复盘记录 |
| AC-06 | 新 Agent 能根据落盘状态恢复运行 | manifest 恢复检查和新上下文记录 |
| AC-07 | 全部报告、日志和 Git commit 可由同一 `run-id` 追溯 | manifest 证据索引和目标 Git 历史 |
| AC-08 | 用户完成最终验收 | `acceptance.md` |

如果正常交付没有自然发生 FAIL，必须在不污染最终交付分支的临时分支或独立工作树中执行一次受控失败演练。Verifier 必须识别失败，Coordinator 必须形成回流记录；原始输出写入 `quality/feedback-loop-drill.log`，结论写入 `retrospective.md`。该演练不计入交付 attempt。

### 10.7 完成判定

首次运行只有在 AC-01 至 AC-08 全部通过、所有证据已提交到目标 Git 仓库且用户完成最终验收后，才能标记为 `COMPLETED`。任一证据缺失、无法追溯或依赖历史对话才能解释时，均不得完成。

## 11. 最终批准门禁

D-01 至 D-06 均已逐项确认。本文档仍保持 `Draft`，在用户完成一次整体审阅并明确批准前，不得进入 Harness 文件建设或目标代码实现。

## 12. 批准记录

| 版本 | 日期 | 状态 | 说明 |
| --- | --- | --- | --- |
| v0.1-draft.1 | 2026-08-13 | Draft | 建立首次试跑契约骨架，等待逐项确认 D-01 至 D-06 |
| v0.1-draft.2 | 2026-08-13 | Draft | 确认 D-01：冻结 `emi-pilot` 项目标识、交付位置和仓库边界 |
| v0.1-draft.3 | 2026-08-13 | Draft | 确认 D-02：冻结技术版本、最小依赖策略和干净环境预检门禁 |
| v0.1-draft.4 | 2026-08-14 | Draft | 确认 D-03：冻结 8 模块拓扑、精确依赖矩阵和最小内容原则 |
| v0.1-draft.5 | 2026-08-14 | Draft | 确认 D-04：冻结 `Money` 的归属、公开 API、精度、运算、异常和相等性契约 |
| v0.1-draft.6 | 2026-08-14 | Draft | 确认 D-05：冻结自动化门禁、唯一验证命令、PASS 标准和禁止绕过规则 |
| v0.1-draft.7 | 2026-08-14 | Draft | 确认 D-06：冻结运行状态、逐轮证据、验收场景和最终完成判定 |
