# v0.1 架构约束

## ARCH-01：精确模块集合

根 POM 必须声明以下顺序的 8 个模块：

```text
emi-pilot-common
emi-pilot-client
emi-pilot-domain
emi-pilot-app
emi-pilot-infra
emi-pilot-adapter
emi-pilot-start
emi-pilot-test
```

不得增加第 9 个模块，也不得因为模块没有源码而删除它。`ModuleStructureTest` 必须从 POM 客观验证模块集合。

## ARCH-02：精确内部依赖

```text
common  -> []
client  -> [common]
domain  -> [common]
app     -> [client, domain, common]
infra   -> [app, domain, client, common]
adapter -> [app, common]
start   -> [adapter, app, infra, client, domain, common]
test    -> [adapter, app, client, common, domain, infra, start] (test scope)
```

- 集合是精确值，不是“最多允许”的近似描述。
- 内部依赖必须统一使用 `${project.version}`，不得重复硬编码版本。
- 任何生产模块不得依赖 `emi-pilot-test`。
- Maven Reactor 必须自行解析正确构建顺序，禁止用脚本掩盖错误依赖。

## ARCH-03：包依赖方向

生产代码根包固定为 `com.jd.emiharness.pilot`。现有 Java 字节码只允许以下层间访问：

| 来源层 | 可访问内部层 |
| --- | --- |
| `common` | 无 |
| `client` | `common` |
| `domain` | `common` |
| `app` | `client`、`domain`、`common` |
| `infra` | `app`、`domain`、`client`、`common` |
| `adapter` | `app`、`common` |
| `start` | `adapter`、`app`、`infra`、`client`、`domain`、`common` |

`LayerDependencyArchTest` 必须验证实际存在的类不越层。空模块没有字节码，因此该测试不能替代 POM 结构测试。

## ARCH-04：最小内容

- `common`、`client`、`app`、`infra`、`adapter` 本次只包含 POM。
- `domain` 只包含 `Money` 及同模块单元测试。
- `start` 只包含启动类和打包配置。
- `test` 只包含跨模块的结构与架构测试。
- 禁止为了“看起来完整”创建无用接口、实现、配置、目录占位或示例业务。

## ARCH-05：Spring Boot 启动

启动类固定为 `com.jd.emiharness.pilot.start.EmiPilotApplication`：

```java
@SpringBootApplication(scanBasePackages = "com.jd.emiharness.pilot")
public class EmiPilotApplication {
    public static void main(String[] args) {
        SpringApplication.run(EmiPilotApplication.class, args);
    }
}
```

- `start` 声明 `spring-boot-starter` 和 `spring-boot-maven-plugin`。
- Parent 已提供 `repackage` execution，`verify` 后必须得到可执行 JAR。
- 不添加 Web、数据库、Mapper 扫描、消息队列、阻塞线程或其他启动逻辑。

## ARCH-06：测试位置

- `MoneyTest` 与 `MoneyImmutabilityTest` 位于 domain 模块。
- `ModuleStructureTest` 与 `LayerDependencyArchTest` 位于 test 模块。
- domain 和 test 模块都必须在未发现测试时构建失败。
- 测试不得依赖开发机当前工作目录；需要项目根路径时通过 Maven system property 显式传入。
