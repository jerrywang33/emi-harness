# @emi-harness/resource-registry

加载经过版本和 SHA-256 锁定的 EMI Context、Skill 与 Prompt。Registry 只读取 `resources/registry.json` 显式列出的文件，不扫描目录，也不读取目标项目或用户目录中的环境资源。

```ts
import { FileResourceRegistry } from "@emi-harness/resource-registry";

const registry = await FileResourceRegistry.openBundled();
const contextRef = registry.resolveRef("emi.safeguarding.payment-funds", "2026.08.21");
const projection = await registry.project([contextRef], "coordinator");
```

`projection` 使用逻辑 `emi-resource:` source，可直接由 Integration 转换为 Pi Runtime 的受控资源快照。`active` 只表示该版本获准进入 Harness 上下文，不代表它已经替具体 Task 完成法律适用性判断。
