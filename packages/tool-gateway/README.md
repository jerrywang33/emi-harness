# @emi-harness/tool-gateway

在任何文件副作用发生前，重新校验当前 Control Plane 权限并持久化 Policy Decision、Operation Intent、幂等键和 `executing` 状态。执行结果未知时，Gateway 只按 Operation ID 对账，不盲目重试。

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

- [types.ts](src/types.ts) 定义工具请求、权限快照、策略端口、执行端口和结果；[definitions.ts](src/definitions.ts) 固定当前工具、策略与本地隔离配置的引用。
- [control-plane-authority.ts](src/control-plane-authority.ts) 读取当前 Run、RoleRun、租约和精确工具授权；[workspace-write-policy.ts](src/workspace-write-policy.ts) 检查写入字段、允许路径、内容与旧摘要条件。
- [sqlite-tool-gateway.ts](src/sqlite-tool-gateway.ts) 的 `invoke()` 接收 Run/RoleRun、token、call ID、工具引用与输入，返回 Operation、Decision 和可用的 Result；拒绝和已知失败也应由调用方处理，不能只检查 Promise 是否抛错。
- [subprocess-workspace-executor.ts](src/subprocess-workspace-executor.ts) 将仓库 ID 绑定到真实根目录，通过标准输入输出调用 [workspace-worker.mjs](worker/workspace-worker.mjs)。Worker 负责文件前置条件、写入和事后检查。
- Integration 的 Gateway Runtime tool 是当前调用方；本包独立持久化操作账本，Integration 再把相关快照保存到 Evidence Store。

## 重放与未知结果

幂等键来自 Run、RoleRun、call ID 和工具名称/版本。同键同输入返回原终态结果；同键不同输入报冲突。授权 Intent 和 `executing` 状态在调用 Executor 前分别提交，数据库事务不跨越子进程执行。

派发后未收到可信结果会保留 `unknown`。`reconcile(operationId)` 只观察原 Intent 对应的文件状态，得到 `applied`、`not_applied` 或 `unknown`，不再次写入。旧租约失效后仍可对账已经受理的操作；能否开启新尝试由控制面和宿主决定。

本地 worker 的内容摘要检查与 rename 不构成对不可信并发写入者的完整文件系统隔离。宿主需保护工作区和控制数据，并评估从授权、派发到实际落盘之间的权限变化及路径竞争。

## 验证与设计

运行 `pnpm --filter @emi-harness/tool-gateway check`；[test/](test/) 覆盖真实写入、权限拒绝、幂等冲突、旧摘要条件、符号链接和中断后对账。详细设计见 [Tool Gateway v0.1](../../docs/design/tool-gateway-v0.1.md)，实际进程与账本关系见 [Review 指南](../../docs/review-guide.md)。
