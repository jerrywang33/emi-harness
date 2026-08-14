# v0.1 技术基线

本文只记录首次试跑已经批准的、可公开复现的技术事实。版本变更属于 SDD 变更，Executor 无权自行升级或降级。

| 项目 | 固定值 |
| --- | --- |
| Java | 17 |
| Maven | 3.9 或更高版本 |
| Parent POM | `org.springframework.boot:spring-boot-starter-parent:4.1.0` |
| Spring Boot | 4.1.0 |
| 编码 | UTF-8 |
| 编译插件 | `maven-compiler-plugin:3.11.0` |
| 单元测试 | JUnit Jupiter，由 Spring Boot Parent 管理版本 |
| 架构测试 | `com.tngtech.archunit:archunit-junit5:1.4.2` |
| 代码规范 | `maven-checkstyle-plugin:3.3.1` + `checkstyle:10.14.2` |

## 依赖原则

- 外部依赖只从 Maven Central 解析，不依赖京东内部制品。
- 只引入本次源码、测试或门禁实际使用的依赖。
- 不引入 MyBatis、数据库驱动、消息队列、缓存、RPC、MapStruct、Lombok、PMD、P3C、SpotBugs、JaCoCo 或 SonarQube。
- Spring Boot Parent 管理的版本不重复声明，通过运行级 `effective-pom.xml` 留证。
- Maven 凭据和 `settings.xml` 必须留在仓库外，不得进入代码或报告。

## 构建原则

- 根工程和全部子模块使用 Java 17。
- 根 POM 集中管理内部模块版本和显式插件版本。
- 正式验证始终使用当前 run 的空白专属 Maven 本地仓库。
- 唯一正式门禁命令由 [`code-quality.md`](../harness/feedback/code-quality.md) 定义。
