# v0.1 领域建模约束

本轮只约束 `Money` 值对象。实现必须以 Approved SDD 第 8 节为最终契约。

## DM-01：不可变值对象

- 类型为 `final` 并实现 `Comparable<Money>`。
- 只包含 `private final BigDecimal value` 和 `private final Currency currency` 两个实例字段。
- 构造器不公开，不提供 setter，不实现 `Serializable` 或 Jackson 适配。
- 所有运算返回 `Money`，不得修改当前实例。

## DM-02：严格创建

公开创建 API 仅包括：

```java
Money.of(BigDecimal value, String currency)
Money.ofMinorUnits(long minorUnits, String currency)
Money.zero(String currency)
```

- 参数为 `null` 时抛出 `NullPointerException`。
- 币种必须是未经 trim 的大写 ISO 4217 三字母代码；小写、空白包裹和未知代码抛出 `IllegalArgumentException`。
- `Currency.getDefaultFractionDigits() < 0` 的代码不支持。
- 金额按币种默认精度使用 `RoundingMode.UNNECESSARY` 规范化；只有可无损删除的尾零允许被删除。
- 不提供 `double` 工厂，不自动修正币种代码。

## DM-03：金额与最小单位

- `getValue()` 返回规范化金额，`getCurrency()` 返回 ISO 代码，`getScale()` 返回币种精度。
- `getMinorUnits()` 必须精确转换，超出 `long` 范围抛出 `ArithmeticException`。
- `ofMinorUnits` 与 `getMinorUnits` 在 `long` 范围内可往返。
- EUR 固定两位小数，JPY 固定零位小数；负数和零值合法。

## DM-04：运算

- `add`、`subtract`、`compareTo` 和语义化比较方法只接受同币种。
- 异币种操作抛出 `IllegalArgumentException`，禁止隐式换汇。
- `multiply` 与 `divide` 必须要求调用方显式传入非空 `RoundingMode`，并按当前币种精度计算。
- 除数为零抛出 `ArithmeticException`。
- `abs`、`negate`、加减乘除都不得改变原对象。

## DM-05：比较与对象语义

- 提供 `isZero`、`isPositive`、`isNegative`。
- 提供 `isGreaterThan`、`isLessThan`、`isGreaterThanOrEqualTo`、`isLessThanOrEqualTo`。
- 相同币种且规范化值相同则 `equals`，并具有相同 `hashCode`。
- 不同币种不相等；同币种内 `compareTo` 与 `equals` 一致。
- `toString()` 固定为 `{currency} {value}`，例如 `EUR 10.00`。

## DM-06：测试映射

domain 测试必须覆盖：不可变性、EUR/JPY 精度、非法币种、无损规范化、最小单位往返与溢出、符号、同币种运算、显式舍入、异币种拒绝、除零、相等性和稳定字符串格式。
