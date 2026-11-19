# @emi-harness/canonical-json

EMI Harness 各账本共用的内容身份技术包，决定见 [ADR 0004](../../docs/decisions/0004-extract-canonical-json-and-sqlite-ledger.md)。本包不包含 Task、Approval、Operation、Evidence 等业务概念，也不定义错误码。

## 输入、输出与入口

- [canonical-json.ts](src/canonical-json.ts)：`canonicalizeJson()` 按 RFC 8785 规则输出规范 JSON，属性名按 UTF-16 code unit 排序，数字使用 ECMAScript 编码；非有限数字、`undefined` 属性、非普通对象和未配对代理项直接抛出 `TypeError`，不做静默转换。`sha256Text()` 对 UTF-8 文本输出 `sha256:` 加 64 位小写十六进制；`digestJson()` 是两者组合。
- [versioned-ref.ts](src/versioned-ref.ts)：`VersionedRef` 的比较、稳定排序和只保留身份字段的复制。
- [types.ts](src/types.ts)：JSON 值类型与 `VersionedRef`。

使用方为 Control Plane、Tool Gateway、Assurance、Resource Registry、Integration 和 `sqlite-ledger`。`runtime-pi` 作为 Pi 适配边界不依赖本包。

## 兼容性

输出字节和摘要格式是已封存 Manifest、Artifact、工具定义、Operation 和 Evidence 的一部分。任何会改变既有输入摘要的修改都是破坏性变化，必须先通过新的 ADR，并且不能改写历史记录。
