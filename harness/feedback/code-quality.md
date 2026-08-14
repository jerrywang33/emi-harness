# v0.1 质量反馈

本文件是首次试跑构建命令、PASS 判定和失败回流的唯一操作来源。SDD 第 9 节仍是验收契约。

## 1. 环境预检

Coordinator 创建 run 后设置：

```bash
export RUN_ID="{run-id}"
export RUN_MAVEN_REPOSITORY="{target}/.m2-runs/$RUN_ID/repository"
```

该目录必须在预检前不存在或为空。随后记录 `java -version`、`mvn -version`，并执行：

```bash
mvn -f "reports/runs/$RUN_ID/quality/preflight-pom.xml" \
  -Dmaven.repo.local="$RUN_MAVEN_REPOSITORY" \
  --batch-mode --errors --no-transfer-progress \
  validate
```

完整输出与真实退出码写入 `quality/environment-preflight.log`。失败时状态为 `BLOCKED`，不得派发 Executor。

## 2. 有效 POM 检查

Executor 提交工程后，Verifier 先执行：

```bash
mvn -Dmaven.repo.local="$RUN_MAVEN_REPOSITORY" \
  --batch-mode --errors --no-transfer-progress \
  help:effective-pom \
  -Doutput="reports/runs/$RUN_ID/quality/effective-pom.xml"
```

Verifier 必须从有效 POM 确认 Spring Boot Parent、JUnit Jupiter、Surefire、Compiler 和 Checkstyle 的最终版本。该命令不是正式质量门禁。

## 3. 唯一正式验证命令

在目标仓库根目录执行：

```bash
mvn -Dmaven.repo.local="$RUN_MAVEN_REPOSITORY" \
  --batch-mode --errors --no-transfer-progress \
  clean verify
```

原始 stdout 和 stderr 写入当前 attempt 的 `quality/verify.log`，Verifier 报告单独记录命令、开始/结束时间和退出码。重定向或 `tee` 不得覆盖 Maven 退出码。

## 4. PASS 判定

以下条件必须全部成立：

- Maven 真实退出码为 `0`。
- 根工程和 8 个子模块 Reactor 状态全部为 `SUCCESS`。
- `MoneyTest`、`MoneyImmutabilityTest`、`ModuleStructureTest`、`LayerDependencyArchTest` 均被发现并执行，零失败、零错误。
- Checkstyle execution 被实际执行，全部主源码零违规。
- `emi-pilot-start` 生成经过 Spring Boot repackage 的可执行 JAR。
- `effective-pom.xml`、`verify.log` 和 `verifier-report.md` 存在且对应同一个 run、attempt 和待验证 commit。
- 报告和日志不包含凭据或 Maven settings 内容。

退出码为 `0` 但缺少任一指定测试、插件记录或证据时，结论仍为 `FAIL`。

## 5. 禁止绕过

禁止：

- `-DskipTests`、`-Dmaven.test.skip=true`、`-Dcheckstyle.skip=true` 或同类参数。
- 只跑单模块、单测试或部分 Reactor 后宣称整体通过。
- `|| true`、忽略退出码、编辑日志或复用历史日志。
- 删除或禁用测试、放宽 Checkstyle、增加排除项、切换 Parent 或依赖版本。
- 用 Executor 自测结果代替 Verifier 独立执行。

## 6. FAIL 回流

Verifier 的每个失败项必须包含：

1. 对应 SDD/guardrail/验收编号。
2. 原始证据路径和关键错误摘要。
3. 可直接执行的复现命令。
4. 影响范围，不包含实现建议或代写代码。

第 1、2 次 FAIL 由 Coordinator 创建下一 attempt 并交给新 Executor；第 3 次 FAIL 进入 `ESCALATED`。历史 attempt 不得覆盖。
