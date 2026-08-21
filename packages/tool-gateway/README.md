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
