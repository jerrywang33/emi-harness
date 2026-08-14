# `emi-pilot` 最小工程脚手架

本文件描述 Executor 必须生成的结果，不是待复制的业务代码。Approved SDD 和 convention 的精确依赖矩阵优先。

## 1. 目录树

```text
emi-pilot/
├── .gitignore
├── pom.xml
├── checkstyle/
│   └── checkstyle.xml
├── reports/runs/{run-id}/...
├── emi-pilot-common/pom.xml
├── emi-pilot-client/pom.xml
├── emi-pilot-domain/
│   ├── pom.xml
│   └── src/
│       ├── main/java/com/jd/emiharness/pilot/domain/money/Money.java
│       └── test/java/com/jd/emiharness/pilot/domain/money/
│           ├── MoneyTest.java
│           └── MoneyImmutabilityTest.java
├── emi-pilot-app/pom.xml
├── emi-pilot-infra/pom.xml
├── emi-pilot-adapter/pom.xml
├── emi-pilot-start/
│   ├── pom.xml
│   └── src/main/java/com/jd/emiharness/pilot/start/EmiPilotApplication.java
└── emi-pilot-test/
    ├── pom.xml
    └── src/test/java/com/jd/emiharness/pilot/architecture/
        ├── ModuleStructureTest.java
        └── LayerDependencyArchTest.java
```

空模块只包含 POM。`.m2-runs/` 和 Maven `target/` 目录必须写入 `.gitignore`。

## 2. 根 POM

根 POM 必须：

- 继承 `org.springframework.boot:spring-boot-starter-parent:4.1.0`，Parent `relativePath` 为空。
- 声明 `com.jd.emiharness:emi-pilot:1.0.0-SNAPSHOT` 和 `pom` packaging。
- 按架构规则声明 8 个模块。
- 设置 `java.version=17`、UTF-8 和内部模块统一版本。
- 在 `dependencyManagement` 集中声明 8 个内部 artifact，版本使用 `${project.version}`。
- 在 `build/plugins` 按 [`quality-plugins.xml`](../harness/feedback/maven/quality-plugins.xml) 配置 Compiler 和 Checkstyle。

canonical Checkstyle 文件必须原样复制到目标 `checkstyle/checkstyle.xml`，不得放宽或增加排除项。

## 3. 子 POM

每个子 POM 的 Parent 固定为：

```xml
<parent>
    <groupId>com.jd.emiharness</groupId>
    <artifactId>emi-pilot</artifactId>
    <version>1.0.0-SNAPSHOT</version>
    <relativePath>../pom.xml</relativePath>
</parent>
```

内部依赖不重复声明版本。各模块依赖必须与 [`module-structure.md`](../conventions/module-structure.md) 完全一致。

### Domain

- 声明 `emi-pilot-common`。
- 测试依赖使用 `org.junit.jupiter:junit-jupiter`，版本由 Parent 管理。
- Surefire 配置 `failIfNoTests=true`。

### Start

- 声明批准的 6 个内部模块和 `org.springframework.boot:spring-boot-starter`。
- 在 build plugins 中声明 `org.springframework.boot:spring-boot-maven-plugin`，不覆盖 Parent 的 repackage execution。

### Test

- 声明其余 7 个模块，全部为 `test` scope。
- 声明 test scope 的 `junit-jupiter` 和 `archunit-junit5:1.4.2`。
- Surefire 配置 `failIfNoTests=true`，并通过 `emi.pilot.root=${maven.multiModuleProjectDirectory}` system property 传入根路径。

## 4. 完成检查

- `find` 结果与本文件目录树一致，没有占位源码。
- 根与子 POM 可由 `ModuleStructureTest` 验证。
- `Money` 与启动类符合各自 guardrail。
- 根构建生成 8 模块 Reactor 和可执行 start JAR。
