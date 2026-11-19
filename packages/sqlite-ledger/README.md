# @emi-harness/sqlite-ledger

Control Plane、Tool Gateway 和 Evidence Store 三个独立账本共用的 SQLite 技术约束，决定见 [ADR 0004](../../docs/decisions/0004-extract-canonical-json-and-sqlite-ledger.md)，存储选型见 [ADR 0003](../../docs/decisions/0003-use-sqlite-for-v0.1-control-plane.md)。本包不定义表结构、业务记录或错误码；每个账本仍保存在自己的数据库文件中，没有跨库事务。

## 输入、输出与入口

- `openLedgerDatabase({ databasePath, migrations, now })` 关闭扩展加载，开启 defensive mode、foreign keys、WAL、`synchronous = FULL` 和 5 秒 busy timeout，然后应用迁移；新建的文件数据库权限设为 `0600`。初始化失败时关闭连接后再抛出错误。
- `applyMigrations()` 按顺序在独立事务中应用未执行的迁移，并在 `schema_migrations` 记录 ID、SQL 的 SHA-256 和时间。已应用迁移的 SQL 被改写时拒绝打开，迁移不能原地修改。
- `inTransaction()` 使用 `BEGIN IMMEDIATE` 包裹同步操作并返回结果；失败时回滚，回滚本身失败时仍抛出原始错误。事务内不得调用 Agent、网络、Git 或其他外部工具。
- [rows.ts](src/rows.ts) 提供列类型检查和 `exactOptionalPropertyTypes` 下的可选字段展开。

## 部署假设

v0.1 只允许每个数据库文件有一个写进程，不能放在网络文件系统上。`node:sqlite` 仍为 release candidate，升级 Node 时必须重新运行所有账本包的检查。
