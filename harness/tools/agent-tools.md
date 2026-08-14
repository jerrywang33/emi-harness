# v0.1 Agent 工具约定

本文件定义角色执行 Harness 时必须采用的可追溯操作。工具名称是行为契约，不绑定某一家 Agent 产品。

## T-01：解析 Harness

1. 优先读取环境变量 `EMI_HARNESS_HOME`。
2. 否则读取 `~/.emi-harness/path`。
3. 验证该目录包含 `AGENTS.md`、Approved SDD 和 `harness/workflow/new-module.md`。
4. 将绝对路径和当前 Harness commit 写入 manifest。

路径无效时停止，不得从相似目录猜测。

## T-02：分配 run-id

- 在目标仓库 `reports/runs/` 中扫描当天已有目录。
- 按 `{YYYYMMDD}-{NNN}-new-module-emi-pilot` 选择下一个三位序号。
- 使用 Asia/Shanghai 日期；目录创建后不得改名或复用。
- 同时创建 run 专属空白 Maven 仓库，路径写入 manifest，不提交依赖缓存。

## T-03：原子更新状态

每次状态切换按顺序执行：

1. 完成当前角色报告或证据。
2. 更新 manifest 的状态、责任角色、最近产物、下一动作和时间。
3. 检查引用路径真实存在。
4. 提交目标仓库。
5. 才能向下一角色交接。

口头说明不能先于落盘状态成为新的事实来源。

manifest 的 `current-commit` 写入步骤 1 开始前最近一个已完成的目标交接 commit，不尝试预写包含 manifest 自身的 SHA。步骤 4 产生的 manifest commit 在恢复时通过 Git 动态解析。

## T-04：角色派发

### Executor 输入

- 目标仓库绝对路径、run-id、attempt。
- 固定的 SDD 路径和 commit。
- 当前 task breakdown。
- AGENTS 为 Executor 指定的 convention、guardrail、feedback 和 scaffold。

不得向 Executor 提供 Verifier 的未发布分析或要求其自我验收。

### Verifier 输入

- 目标仓库绝对路径、run-id、attempt 和待验证 commit。
- 固定的 SDD 路径和 commit。
- `code-quality.md`、架构/领域规则和执行追踪规范。

使用全新上下文。Verifier 在完成首次代码检查、有效 POM 检查和正式命令并写出初始结论前，不得读取 `executor-report.md`。

## T-05：捕获命令证据

每个客观命令都记录：

- 完整命令和工作目录。
- 开始、结束时间及时区。
- stdout、stderr 原文。
- 真实退出码。
- 执行角色、run-id、attempt 和被验证 commit。

可以重定向或使用 `tee`，但必须保留 Maven 的真实退出码。不得用 `|| true`、日志摘要或 Agent 转述替代原始输出。

## T-06：Git 边界

- Harness 变更只提交到 `emi-harness`，并推送其 `origin/main`。
- 生成代码和 run 证据只提交到 `emi-pilot`。
- 初始化 `emi-pilot` 时使用 `main` 分支，不添加远端。
- 交接前必须记录 `git status --short --branch` 和 commit SHA；存在未说明变更时不得交接。
- 一个逻辑步骤一个有说明的非 amend 提交，不重写已交接历史。

## T-07：敏感信息检查

提交报告前检查 staged diff 和新日志是否包含常见令牌、密码、私钥头、Authorization header、带用户信息 URL 或 Maven settings 内容。只记录“检查通过/失败”，不得把疑似秘密复制到报告。

发现秘密时停止提交，先移除证据中的秘密并处理来源；已经进入 Git 历史时升级给用户。

## T-08：恢复运行

新 Coordinator 恢复时只读取：

1. `AGENTS.md` 与 workflow。
2. 目标 run 的 manifest。
3. manifest 指向的 SDD、当前任务和最近已完成角色报告。
4. 当前 Git 状态与记录 commit 的一致性。

根据 manifest 的 `next-action` 恢复，不依赖历史对话。路径、commit 或状态不一致时进入 `BLOCKED` 并记录差异。
