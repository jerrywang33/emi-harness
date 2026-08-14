# v0.1 架构测试规则

本文件指导 Executor 生成 `emi-pilot-test` 中的两类客观结构测试。测试必须验证 SDD，而不是复制实现声明。

## 1. `ModuleStructureTest`

使用 JDK XML API 读取根 POM 和 8 个子 POM，至少断言：

- 根坐标、packaging、Spring Boot Parent 及空 `relativePath` 正确。
- 根 `<modules>` 与批准的 8 模块有序列表完全相等。
- 每个子 POM 存在，Parent 坐标和 `../pom.xml` 正确。
- 每个子模块的内部 artifactId 集合与批准矩阵完全相等。
- test 模块的 7 个内部依赖全部为 `test` scope，其他模块的内部依赖不得为 test scope。
- 不存在第 9 个 `emi-pilot-*` 子模块目录。

项目根路径必须由 test 模块的 Surefire 配置通过 system property `emi.pilot.root` 传入，测试不得依赖启动 Maven 时的工作目录。

## 2. `LayerDependencyArchTest`

使用 ArchUnit 1.4.2 导入 `com.jd.emiharness.pilot..`，只检查项目内部包依赖。逐层断言：

| 来源包 | 允许依赖的项目内部包 |
| --- | --- |
| `..common..` | `..common..` |
| `..client..` | `..client..`、`..common..` |
| `..domain..` | `..domain..`、`..common..` |
| `..app..` | `..app..`、`..client..`、`..domain..`、`..common..` |
| `..infra..` | `..infra..`、`..app..`、`..domain..`、`..client..`、`..common..` |
| `..adapter..` | `..adapter..`、`..app..`、`..common..` |
| `..start..` | 所有生产层 |

JDK、Spring 和第三方包不属于项目内部层，不应被上述规则误判。当前空模块可以没有类；测试不得使用 `allowEmptyShould(true)` 掩盖本应存在的 domain 或 start 代码。

## 3. 测试存在性

- 测试类名固定为 `ModuleStructureTest` 和 `LayerDependencyArchTest`。
- 测试模块配置 `failIfNoTests=true`。
- Verifier 必须从 Surefire 输出或报告确认两个类均被执行，不接受“模块构建成功”替代。
