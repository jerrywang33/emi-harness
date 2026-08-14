# v0.1 Java 代码规范

本文件描述首次试跑会被 Checkstyle 或 Verifier 实际检查的规则，不扩展为完整团队编码手册。

## 自动门禁

- UTF-8，文件末尾保留换行，禁止 Tab。
- 单行不超过 120 字符；Java 文件不超过 500 行。
- 类型使用 UpperCamelCase，方法和变量使用 lowerCamelCase，常量使用 UPPER_SNAKE_CASE，包名全小写。
- 方法不超过 80 行，参数不超过 3 个，`if` 嵌套不超过 3 层，`for` 不超过 2 层，`try` 不超过 1 层。
- 禁止星号、冗余和未使用 import；import 按 `java`、`javax`、`org`、`com` 分组。
- 公共类型必须有简洁 Javadoc。
- 使用 K&R 花括号、操作符和分隔符周围的标准空格。
- 禁止空语句；覆盖 `equals` 时必须覆盖 `hashCode`；`switch` 必须有 `default`。
- 除 `-1`、`0`、`1`、`2` 外，不在方法中散落魔法数字；使用命名常量表达含义。

canonical 配置为 [`checkstyle.xml`](../feedback/checkstyle/checkstyle.xml)。文档与配置冲突时必须停止并修正规则源，不能选择更宽松的一方。

## 人工检查

- 名称表达领域含义，禁止 `Utils`、`Manager` 等无法说明职责的命名。
- 不捕获并吞掉异常，不用 `null` 表示本可由明确值或异常表达的结果。
- 不引入未使用依赖、无业务用途抽象或为未来假设准备的扩展点。
- 测试名称清楚表达输入与预期行为，且每个断言对应 SDD 契约。
- 注释解释不明显的约束原因，不复述代码。

## 禁止通过样式修复改变语义

Checkstyle 失败只能修正符合 SDD 的源码或配置引用。不得借样式修复删除测试、降低规则、增加排除项或改变公开 API。
