# v0.1 模块结构

首次试跑固定生成 8 个且仅 8 个 Maven 子模块。空模块只保留 POM，不生成占位类或 `.gitkeep`。

| 模块 | 内部依赖 | 首次试跑内容 |
| --- | --- | --- |
| `emi-pilot-common` | 无 | POM |
| `emi-pilot-client` | `common` | POM |
| `emi-pilot-domain` | `common` | POM、`Money`、domain 单元测试 |
| `emi-pilot-app` | `client`、`domain`、`common` | POM |
| `emi-pilot-infra` | `app`、`domain`、`client`、`common` | POM |
| `emi-pilot-adapter` | `app`、`common` | POM |
| `emi-pilot-start` | `adapter`、`app`、`infra`、`client`、`domain`、`common` | POM、Spring Boot 启动类、可执行 JAR |
| `emi-pilot-test` | 其余 7 个模块，全部为 `test` scope | 模块结构测试、ArchUnit 分层测试 |

## Maven 约定

- 根坐标：`com.jd.emiharness:emi-pilot:1.0.0-SNAPSHOT`，packaging 为 `pom`。
- 根 POM 继承 Spring Boot Parent，并使用 `<relativePath/>`。
- 子模块继承根 POM，并使用 `<relativePath>../pom.xml</relativePath>`。
- 子模块 artifactId 均以 `emi-pilot-` 开头。
- 表中内部依赖集合是精确值，不得遗漏或增加。

## 包与职责

- Java 根包为 `com.jd.emiharness.pilot`，下一段固定为层名。
- `domain` 不依赖 Spring；业务值对象不能进入 `common`。
- `app` 只编排用例；`infra` 实现技术和外部接入；`adapter` 接收外部输入；`start` 只组装和启动。
- 本次没有用例、数据库或外部入口，因此不得为 `app`、`infra`、`adapter` 填充虚构代码。
- 单模块测试跟随源码；跨模块结构测试放入 `emi-pilot-test`。

完整且优先级更高的精确契约见 [`system-design.md`](../specs/pilot/system-design.md#7-模块结构与依赖矩阵)。
