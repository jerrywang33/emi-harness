# @emi-harness/resource-registry

加载经过版本和 SHA-256 锁定的 EMI Context、Skill 与 Prompt。Registry 只读取 `resources/registry.json` 显式列出的文件，不扫描目录，也不读取目标项目或用户目录中的环境资源。

```ts
import { FileResourceRegistry } from "@emi-harness/resource-registry";

const registry = await FileResourceRegistry.openBundled();
const contextRef = registry.resolveRef("emi.safeguarding.payment-funds", "2026.08.21");
const projection = await registry.project([contextRef], "coordinator");
```

`projection` 使用逻辑 `emi-resource:` source，可直接由 Integration 转换为 Pi Runtime 的受控资源快照。`active` 只表示该版本获准进入 Harness 上下文，不代表它已经替具体 Task 完成法律适用性判断。

## 输入、输出与入口

- [file-resource-registry.ts](src/file-resource-registry.ts) 的 `open()` 接收绝对根目录及可选索引路径；`openBundled()` 使用包内资源。`load()` 接收 ID、版本、摘要及角色，返回经校验的 Manifest 和文本内容。
- 摘要链依次为运行引用、[registry.json](resources/registry.json)、Manifest 原始文本的 SHA-256、内容原始文本的 SHA-256。修改 Manifest 的空白也会影响引用，资源升级必须同步维护索引和引用。
- [validation.ts](src/validation.ts) 执行运行时字段和语义校验；[resource-manifest.schema.json](schemas/resource-manifest.schema.json) 提供可审查的结构契约。Schema 文件存在不代表加载器自动执行了该文件，二者一致性需持续检查。
- `project()` 将 Context 放入 `contextFiles`，将 Skill/Prompt 放入 `appendSystemPrompts`，只输出受控文本，不创建 Session 或授予工具权限。Integration 是实际运行的使用方。

## 当前资源与限制

包内只有 `emi.safeguarding.payment-funds@2026.08.21` Context 和仅允许 Coordinator 使用的 `emi.skill.control-to-trd@2026.08.21` Skill。Registry 支持 Prompt 类型，目前没有捆绑 Prompt 资源，也未接入独立 `emi-knowledge` 仓库的发布内容。

加载器检查资源身份、状态、角色、路径及摘要，不联网更新法规，不确认具体 Task 的机构适用性，也不提供检索服务。索引与根目录的写权限由宿主保护。

## 验证与设计

运行 `pnpm --filter @emi-harness/resource-registry check`；[test/](test/) 覆盖投影、资源摘要、角色限制、索引、路径及 Manifest 校验。详细设计见 [受控 EMI 资源 v0.1](../../docs/design/controlled-emi-resources-v0.1.md)，跨包使用见 [Review 指南](../../docs/review-guide.md)。
