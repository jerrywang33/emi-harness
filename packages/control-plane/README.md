# @emi-harness/control-plane

EMI Harness v0.1 的权威任务状态和恢复边界。该包持久化 Task、Approval、Run、RoleRun、不可变制品、Transition、命令幂等结果和 outbox，不读取 Pi Session 推断任务进度。

```ts
import { SqliteControlPlane } from "@emi-harness/control-plane";

const controlPlane = new SqliteControlPlane({ databasePath: "./state/control-plane.db" });
// 所有写操作都需要唯一 commandId、明确 actor 和 expectedVersion。
controlPlane.close();
```

v0.1 只支持一个 Control Plane 写进程。Agent、Git、网络和有副作用工具不能在数据库事务中执行；后续包通过稳定记录 ID、outbox 和 fencing token 与本包衔接。
