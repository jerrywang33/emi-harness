# 0004：提取规范 JSON 与 SQLite 账本基础包

- 状态：已接受
- 日期：2026-11-19

## 背景

v0.1 有三个独立 SQLite 账本：Control Plane、Tool Gateway 和 Evidence Store。三者以及 Resource Registry 和 Integration 都依赖同一组信任关键的技术能力：

- RFC 8785 兼容的规范 JSON、SHA-256 摘要格式和带摘要的版本引用 `VersionedRef`。
- 以受限文件权限创建、开启 foreign keys、WAL、`synchronous = FULL`、defensive mode 和 busy timeout 的 SQLite 连接。
- 带 ID 与 SQL 摘要、原子应用且拒绝已应用迁移被改写的前向迁移。
- 短事务包装以及从 SQLite 行读取强类型列。

这些实现分别复制在 `control-plane`、`tool-gateway`、`assurance` 和 `resource-registry` 中，已经出现命名和细节漂移（如 `sha256Digest` 与 `sha256Text`、事务回滚失败时是否掩盖原始错误）。任何一份副本的序列化或摘要细节变化都会使不同账本对同一对象给出不同摘要，破坏跨账本引用和候选 Evidence Package 校验；分散副本也无法用一组测试证明它们一致。

README 禁止建立承载多个业务概念的 `common` 或 `shared` 模块，但允许按实际需要提取真正通用且稳定的技术能力。

## 决定

- 新增 `@emi-harness/canonical-json`，只负责与内容身份有关的纯函数和类型：`canonicalizeJson`、`sha256Text`、`digestJson`、`isSha256`、`JsonValue` 系列类型、`VersionedRef` 以及引用比较与排序。它不依赖 Node 内置模块以外的任何包。
- 新增 `@emi-harness/sqlite-ledger`，只负责账本型 SQLite 的技术约束：`openLedgerDatabase()` 统一连接参数、迁移和新文件 `0600` 权限；`inTransaction()` 统一 `BEGIN IMMEDIATE`、提交和回滚；行读取辅助函数统一列类型检查。它依赖 `canonical-json` 计算迁移摘要。
- 两个包都不包含 Task、Approval、Operation、Evidence 等业务概念，不定义错误码；业务包继续用自己的错误类型校验输入和翻译约束错误。
- 现有包删除各自副本并改为依赖上述两个包。各包公开的 `canonicalizeJson`、`digestJson`、`sha256Text`、`sha256Digest`、`isSha256` 和 JSON/引用类型改为从基础包再导出，保持现有调用方兼容。
- `runtime-pi` 是 Pi 适配边界，保持只依赖 Pi，不依赖 EMI 基础包；其 JSON 类型与基础包结构相同。

## 兼容性约束

- 规范 JSON 的输出字节、摘要前缀和十六进制格式不变；工具定义、策略、隔离 profile 的固定 v1 摘要和已发布的 Manifest、Evidence 摘要保持有效。
- 迁移 ID、SQL 文本和迁移摘要不变，已有 SQLite 文件可以继续打开，不新增或改写迁移。
- 回滚语义统一为：回滚自身失败时保留并抛出原始错误。这与 Control Plane 既有行为一致，Gateway 与 Evidence Store 在回滚失败时也不再用回滚错误掩盖原因。

## 影响

- 工作区由 6 个包变为 8 个；依赖方向为 `canonical-json` ← `sqlite-ledger` ← 三个账本包，Integration 与 Resource Registry 直接依赖 `canonical-json`。
- 规范 JSON 与 SQLite 账本的正确性由各自包内测试集中证明，业务包测试继续证明组合行为。
- 升级 Node 或修改两个基础包时，必须运行全部依赖包检查；改变规范化或迁移摘要规则属于破坏性变化，需要新的 ADR。

## 未采用的方案

- **保留副本并增加一致性测试**：能发现漂移，但仍需同步修改多处信任关键代码。
- **合并为一个基础包**：规范 JSON 是纯函数，Resource Registry 与 Integration 不需要 SQLite；分开后依赖面更小。
- **放入 `control-plane` 供其他包导入**：会让 Tool Gateway 和 Evidence Store 依赖控制面实现，违背三个账本相互独立的边界。
