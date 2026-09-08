# @emi-harness/tool-gateway

在派发文件操作前，持久化 Policy Decision、Operation Intent、幂等键和 `executing` 准备状态，再同步重检当前 Control Plane 权限并立即调用 Executor。执行结果未知时，Gateway 只按 Operation ID 对账，不盲目重试。

v0.1 只注册 `workspace.write_text@1`。调用方必须显式组装固定工具定义、策略和隔离 Executor：

```ts
const executor = await SubprocessWorkspaceExecutor.create({ repositoryId: "local-target", workspaceRoot });
const gateway = new SqliteToolGateway({
  databasePath,
  authority: new ControlPlaneRoleRunAuthority(controlPlane),
  executor,
  registrations: [{ definition: WORKSPACE_WRITE_TOOL, policy: new WorkspaceWritePolicy() }],
});
```

该 helper process 只暴露受约束的文本写入协议，不暴露 Shell 或网络工具。它是 v0.1 本地进程隔离基线，不宣称具备容器、虚拟机或操作系统级网络隔离能力。

## 输入、输出与入口

- [types.ts](src/types.ts) 定义工具请求、权限快照、策略端口、执行端口和结果。`RoleRunAuthorityPort` 必须提供异步初始检查 `authorize()` 和同步派发检查 `authorizeForDispatch()`；初始快照不能代替最终检查。[definitions.ts](src/definitions.ts) 固定当前工具、策略与本地隔离配置的引用。
- [control-plane-authority.ts](src/control-plane-authority.ts) 在两次检查中读取当前 Run、RoleRun、租约和精确工具授权，并通过 Reader 的 `assertRunAuthorization(runId)` 检查批准仍然有效；历史附条件批准或非空 Manifest 条件不能授权新操作。[workspace-write-policy.ts](src/workspace-write-policy.ts) 检查写入字段、允许路径、内容与旧摘要条件，最终派发前重新计算的结果必须与不可变 Intent 一致。
- [sqlite-tool-gateway.ts](src/sqlite-tool-gateway.ts) 的 `invoke()` 接收 Run/RoleRun、token、call ID、工具引用与输入，返回 Operation、Decision 和可用的 Result；拒绝和已知失败也应由调用方处理，不能只检查 Promise 是否抛错。
- [subprocess-workspace-executor.ts](src/subprocess-workspace-executor.ts) 将仓库 ID 绑定到真实根目录，通过标准输入输出调用 [workspace-worker.mjs](worker/workspace-worker.mjs)。Worker 负责文件前置条件、写入和事后检查。
- Integration 的 Gateway Runtime tool 是当前调用方；本包独立持久化操作账本，Integration 再把相关快照保存到 Evidence Store。

## 重放与未知结果

幂等键来自 Run、RoleRun、call ID 和工具名称/版本。同键同输入返回原终态结果；同键不同输入报冲突。新请求和历史 `authorized` 请求都先提交 `executing` 与 `dispatch_prepared`，再同步重检授权、策略与 Intent 一致性及取消信号，随后立即调用 `Executor.execute()`，中间不经过 `await`。最终检查缺失、抛错、返回 Promise/thenable 或不再允许执行时，保留原 Decision 和 Intent，记录已知未派发的 `failed`。

`executing` 只表示派发准备已持久化，不能单独证明 Worker 已启动；准备后崩溃仍需按未知结果恢复。数据库事务不跨越子进程执行。

当前子进程 Executor 在 `execute()` 调用内同步启动 Worker，该调用是本地派发边界。撤销先于最终派发会阻止操作；派发后的撤销只停止后续派发，已有操作继续保存真实结果，未收到可信结果时保留 `unknown`。`reconcile(operationId)` 只观察原 Intent 对应的文件状态，得到 `applied`、`not_applied` 或 `unknown`，不再次写入。旧租约失效后仍可对账已经受理的操作；能否开启新尝试由控制面和宿主决定。

最终重检依赖 v0.1 的本地部署约定：Control Plane 的全部状态写入、Gateway 和最终权限 Reader 在同一个 Node.js 事件循环内，Reader 同步读取权威事实，可信 Reader 和策略不得在最终检查中回入修改控制面状态。多进程、Worker Thread 或远程控制面需要另外设计撤销与派发的排序协议，不能用缓存快照代替重检。

本地 worker 的内容摘要检查与 rename 不构成对不可信并发写入者的完整文件系统隔离。宿主仍需保护工作区和控制数据，并处理实际落盘时的路径竞争。

## 验证与设计

运行 `pnpm --filter @emi-harness/tool-gateway check`；[test/](test/) 检查真实写入、权限拒绝、幂等冲突、旧摘要条件、符号链接和中断后对账，以及初始授权后撤销、历史 `authorized` 请求恢复和最终同步检查失败时是否阻止派发。详细设计见 [Tool Gateway v0.1](../../docs/design/tool-gateway-v0.1.md)，实际进程与账本关系见 [Review 指南](../../docs/review-guide.md)。
