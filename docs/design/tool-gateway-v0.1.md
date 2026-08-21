# Tool Gateway v0.1 设计

- 状态：已实现 v0.1
- 对应 Roadmap：v0.1 第 5 步
- 最后更新：2026-08-21

## 目标

实现一条可测试的有副作用工具调用，证明 Agent 只能请求 RunManifest 明确授权的工具，并且权限决定、操作意图、幂等键、隔离执行结果和中断后对账都保存在 Pi Session 之外。

v0.1 只提供 `workspace.write_text@1`，用于在目标仓库获准的单个相对路径创建或原子替换 UTF-8 文本文件。它不提供 Shell、Git、网络、包安装、任意文件读取、删除、移动、权限修改或目标仓库之外的访问能力。

## 信任边界

```text
Pi Runtime custom tool
        |
        v
Gateway client adapter      只转换 callId、输入和 RoleRun 上下文
        |
        v
Tool Gateway                校验当前权限并持久化决定、意图和状态
        |
        v
workspace worker process    只执行一种文件操作，受仓库根目录和路径约束
```

- Pi 自定义工具不直接调用 `fs`、Shell 或外部系统。后续 Integration 只能把 Gateway 调用包装成 `RuntimeTool`。
- Tool Gateway 通过 `RoleRunAuthorityPort` 重新读取 Control Plane 当前事实。授权时必须同时满足：Run 为 `active`、RoleRun 为 `running`、Run/RoleRun 关系一致、lease 未过期、fencing token 精确匹配、角色为 Executor，以及工具、版本、定义摘要、策略引用和隔离配置都与 RolePlan 一致。
- Gateway 的策略和状态保存在自身 SQLite 账本。Pi Session、模型输出或 Tool Result 文本不能替代 Operation 当前状态。
- 真正文件副作用由独立 Node helper process 执行。v0.1 的进程边界和严格文件 API 能减少 Agent 能力，但不等同于容器、虚拟机或操作系统级网络隔离；正式部署前必须通过新 ADR 选择更强隔离实现。

## 固定工具契约

`workspace.write_text@1` 输入只有三个字段：

| 字段 | 说明 |
| --- | --- |
| `path` | 规范化的仓库相对路径，必须与 RunManifest `target.allowedPaths` 中一项精确相等。 |
| `content` | 要写入的 UTF-8 文本，v0.1 最大 128 KiB，不允许 NUL。 |
| `expectedDigest` | 预期旧文件摘要，格式为 `sha256:{hex}`；新文件必须使用 `absent`。 |

Tool definition、workspace write policy 和 local subprocess isolation profile 都使用固定版本与 SHA-256 引用。RunManifest 必须锁定同一组引用；只匹配工具名称但版本、摘要、策略或隔离方式不同，仍然拒绝。

写入使用 compare-and-set：当前文件既不等于 `expectedDigest`、也不等于待写内容摘要时，操作以已知的 `precondition_failed` 结束，不覆盖并发变化。如果文件已经等于待写内容，Worker 返回幂等成功。

## Operation 账本

每次请求派生稳定幂等键，绑定 Run ID、RoleRun ID、Pi tool call ID、工具名和版本；同一个键只能对应同一个规范请求摘要。主要记录如下：

| 记录 | 写入规则 |
| --- | --- |
| `operations` | 保存当前状态、请求摘要、Run/RoleRun、token、工具和 call ID；使用版本更新。 |
| `policy_decisions` | 保存允许或拒绝、原因和所依据的授权快照摘要；只追加、不可修改。 |
| `operation_intents` | 允许后、执行前保存精确输入、目标仓库和隔离引用；只追加、不可修改。 |
| `operation_results` | 保存已知成功或失败结果、输出、错误和是否来自对账；只追加、不可修改。 |
| `operation_transitions` | 保存每次被 Gateway 接受的状态变化；只追加、不可修改。 |

Operation 状态为：

```text
authorized -> executing -> succeeded | failed
                        -> unknown -> succeeded | failed | unknown
denied
```

- `denied` 没有执行意图，不调用 Worker。
- `authorized` 表示策略允许且 Intent 已经提交；Gateway 将状态改为 `executing` 并提交事务后才可启动 Worker。
- Worker 明确报告应用成功或前置条件失败时分别进入 `succeeded` 或 `failed`。
- 超时、进程退出、协议损坏、取消或 Gateway 无法确定 Worker 是否已经写入时进入 `unknown`，不得按原请求自动执行第二次。

## 中断与对账

`reconcile(operationId)` 不依赖原 RoleRun lease 仍然有效，因为已受理副作用在 Worker 或 Gateway 中断后仍需结算。它只读取目标状态，不发起新的写入：

- 目标文件摘要等于 Intent 内容摘要：记录对账成功并进入 `succeeded`。
- 目标仍处于明确的预期旧状态或仍不存在：记录 `not_applied` 并进入已知 `failed`；新 RoleRun 如需重试必须产生新的 tool call 和 Operation。
- 目标为其他内容、路径无法安全读取或 Worker 结果仍不明确：保持 `unknown`，等待人工处理。

重放相同幂等请求时，Gateway 返回已经保存的终态；请求摘要不同则报冲突。租约过期前已进入 `executing` 的 Operation 仍然对账，但旧 Worker不能用旧 token 创建新 Operation。

## 文件执行约束

- Gateway 配置的目标仓库根目录必须是绝对真实路径，并由 Executor 配置的 `repositoryId` 与 Intent 精确绑定；绝对路径不进入 RunManifest 或 Operation Intent。
- Worker 再次拒绝绝对路径、`.`、`..`、空路径段、反斜杠和 NUL，并检查父目录与现有目标的真实路径没有逃出仓库根目录。
- 符号链接目标和符号链接父目录拒绝；临时文件在目标目录中以排他方式创建，刷新后原子 rename，避免部分文件成为成功结果。
- 子进程只接收一个版本化 JSON 请求，使用最小环境、输出大小和执行时间限制。任何非预期 stdout、多个响应或未知协议字段都视为结果未知。
- Intent 和 Result 可以包含目标项目源代码，但不得包含凭据、客户数据或生产配置；此限制由 Run 授权、目标项目数据分类和部署权限共同保证，不能靠内容猜测实现。

## 验收条件

1. 正确授权的 Executor 可以写入一条明确允许的路径，Operation 的 Decision、Intent、Transitions 和 Result 可重开数据库后读取。
2. 未在 RolePlan 的工具、错误定义摘要或策略、非 Executor、过期或旧 fencing token、未允许路径和旧内容摘要全部失败关闭，且不会修改目标文件。
3. 相同 tool call 重放只返回原 Operation；相同幂等键的不同请求被拒绝。
4. Worker 启动前 Intent 和 `executing` 状态已经持久化。
5. 模拟“副作用成功但 Gateway 未收到结果”后，Operation 进入 `unknown`，对账可以识别已应用结果而不二次写入。
6. 模拟未应用和无法判断两种情况时，对账分别产生已知失败和保持未知。
7. Runtime 包不依赖 Tool Gateway；后续 Integration 通过双方公开端口组装 `RuntimeTool`。
