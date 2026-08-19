# 0002：以 Pi Runtime 为执行内核，自建 EMI 控制面

- 状态：已接受
- 日期：2026-08-19
- 取代：[0001：基于 DeepSeek Harness 重新建设](0001-rebuild-on-deepseek-harness.md)

## 背景

仓库在 0001 中决定使用 DeepSeek Harness 的 Profile、Bundle 和 Plugin 机制重新建设 EMI Harness。后续对 Pi Agent Harness 与 DeepSeek Harness 的官方文档和源代码进行了对比，重点检查了 Agent Loop、SDK 嵌入、资源加载、工具管线、Session 持久化、沙箱、Subagent 和 Workflow 的实际实现。

对比后发现，DeepSeek Harness 已经实现了比 Pi 更完整的事件化 Session、工具执行管线、本地文件沙箱和 Subagent 能力，但其定位是基于 Cordis 的完整插件化 Harness 平台，当前仍处于 Developer Preview，并明确会发生兼容性破坏。其动态 Workflow 没有 journaling 和进程重启恢复能力，本地沙箱也只约束文件副作用，无法直接承担 EMI 的权威工作流、安全边界或证据账本。

Pi 的定位更小：`pi-ai` 提供多模型与 Provider 适配，`pi-agent-core` 提供单 Agent 循环，`pi-coding-agent` 提供可嵌入的 `createAgentSession()` SDK。它允许调用方注入 `ResourceLoader`、自定义工具和精确工具白名单，因此可以放在 EMI 自有控制面之下，而不要求 EMI 领域架构服从一套上游组合模型。

## 走读基线与代码依据

本决定基于 2026-08-19 对以下官方代码的走读：

- Pi `0.84.2`，commit [`59a71b235dadb4ad0d67557a8abb0aaa093e68b4`](https://github.com/earendil-works/pi-mono/tree/59a71b235dadb4ad0d67557a8abb0aaa093e68b4)。
- DeepSeek Harness `0.1.0-rc.7`，commit [`99f6f02fecdb7dff40c3fbc9470f5907c29f74ca`](https://github.com/deepseek-ai/DeepSeek-Harness/tree/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca)。

关键代码依据：

- Pi [`createAgentSession()`](https://github.com/earendil-works/pi-mono/blob/59a71b235dadb4ad0d67557a8abb0aaa093e68b4/packages/coding-agent/src/core/sdk.ts) 支持注入 `ResourceLoader`、`SessionManager`、自定义工具和精确工具白名单。
- Pi 官方[Security](https://github.com/earendil-works/pi-mono/blob/59a71b235dadb4ad0d67557a8abb0aaa093e68b4/packages/coding-agent/docs/security.md) 明确说明项目信任不是沙箱，Extension 与 Pi 进程具有相同权限，真实隔离需要操作系统、容器或虚拟化边界。
- Pi 新的 [`AgentHarness`](https://github.com/earendil-works/pi-mono/blob/59a71b235dadb4ad0d67557a8abb0aaa093e68b4/packages/agent/src/harness/agent-harness.ts) 仍有大量 `HarnessNotImplemented` 返回，当前不能作为执行依赖。
- DeepSeek Harness 将能力组合为 [Cordis 插件树](https://github.com/deepseek-ai/DeepSeek-Harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/docs/architecture.md)，Profile、Home 和命令行 Patch 可继续替换已有配置行。
- DeepSeek Harness 的 [`tool/call`](https://github.com/deepseek-ai/DeepSeek-Harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/core/agent-loop/src/tool-calls.ts#L164-L174) 在工具调度前追加到内存 Session，但 Session Persistence 使用[延迟批量写入](https://github.com/deepseek-ai/DeepSeek-Harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/session/session-persistence/README.md#the-write-coordinator)，调度工具前没有等待 durable flush。因此它不能代替外部操作意图与结果对账。
- DeepSeek Harness 的动态 [Workflow](https://github.com/deepseek-ai/DeepSeek-Harness/blob/99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/packages/workflow/workflow/README.md#known-limitations-and-deferred-work) 明确没有 journaling 和进程重启恢复。

## 架构对比

| 维度 | Pi | DeepSeek Harness | EMI Harness 判断 |
| --- | --- | --- | --- |
| 产品定位 | 小型、可嵌入的 Agent Runtime | 基于 Cordis 的完整插件平台 | Pi 更适合成为底层依赖 |
| 调用方式 | 进程内 SDK、JSON、RPC 和 CLI | Profile、Bundle、Plugin 及进程外 JSON-RPC | Pi 更容易由 EMI 控制面驱动 |
| 模型适配 | `pi-ai` 原生支持多个 Provider | 通用 Provider 插件本身也可以使用 `pi-ai` | 直接使用 Pi 层次更少 |
| 资源组合 | 可注入自定义 `ResourceLoader` | 多层 Patch 可替换任意插件配置 | 自建受控 Loader 更容易形成确定基线 |
| Session | 完整消息为主的 JSONL 树 | 事件溯源日志、SQLite、请求和工具事件 | DeepSeek Harness 当前更完整，但两者都不是 EMI 任务账本 |
| 工具控制 | 执行前后扩展钩子 | pre-execute、guard、approval、execute、post-execute | 借鉴 DeepSeek Harness 的管线，在外部 Tool Gateway 实现 |
| 安全隔离 | 无内置沙箱 | 有本地文件沙箱，但不覆盖完整进程、网络和凭据权限 | 两者都必须使用 Harness 进程之外的隔离执行环境 |
| 多 Agent | 无内置编排，官方示例启动子进程 | 有 Subagent seam、子 Session 和可继续执行实现 | EMI 仍需自建职责分离和权威状态机 |
| Workflow | 无内置工作流引擎 | 支持模型编写的 JavaScript 编排，但不能恢复 | 两者都不承担 EMI 持久化工作流 |
| 变更风险 | 0.x 快速迭代 | 0.1.0 RC 且官方明确处于 Developer Preview | Pi 风险相对更低，仍必须精确锁版并通过适配层隔离 |

## 决定

- EMI Harness 不 fork Pi，也不把 Pi CLI 当成自己的控制面。
- v0.1 锁定经过验证的 `pi-ai`、`pi-agent-core` 和 `pi-coding-agent` 精确版本，通过自有 `PiRuntimeAdapter` 调用 `createAgentSession()`。
- Pi 负责模型适配、单 Agent 循环、工具调用协议、工作上下文与运行事件。
- EMI Harness 负责任务状态机、角色与职责分离、人工审批、受控资源、工具权限、隔离执行、失败恢复、验证和证据。
- 每个 Coordinator、Executor 或 Verifier 运行使用独立 Pi Session、上下文投影和工具白名单，不共享隐含对话状态。
- 只通过自建 ResourceLoader 加载已批准且已锁定版本和哈希的 EMI Context、Skills 与 Prompts，禁止默认项目资源发现进入受控运行。
- 不向 Pi Agent 直接提供有副作用的本地工具。自定义工具只是 Tool Gateway 客户端，权限决策、操作意图、隔离执行和结果落账在 Agent 进程之外完成。
- Pi Session 只是 Agent 工作记录；EMI 任务状态和 Evidence Store 是任务状态、审批和交付结论的权威来源。
- 不依赖 Pi 当前未完成的新 `AgentHarness`，只借鉴其 durable session、effect settlement 和恢复设计。
- DeepSeek Harness 不再是运行依赖，只作为 capability seam、工具管线、事件词汇、子 Agent 权限继承和崩溃结果分类的设计参考。

## 运行边界

```text
EMI Control Plane
    -> PiRuntimePort
        -> PiRuntimeAdapter
            -> Pi AgentSession / Agent / agentLoop / pi-ai

EMI Control Plane
    -> Tool Gateway
        -> Policy Decision
        -> Operation Intent
        -> Isolated Executor
        -> Result Settlement

Runtime Events + Workflow Events + Tool Evidence
    -> Evidence Store
```

`PiRuntimePort` 是 EMI 代码唯一允许依赖的 Agent Runtime 接口。业务工作流、资源注册、工具权限和证据逻辑不得导入 Pi 内部类型，上游升级只能影响适配层和其契约测试。

## 影响

- 0001 中的 Profile、Bundle、Plugin、Cordis Patch 和 `$DSH_HOME` 不再是 EMI Harness 实现概念。
- README、Roadmap、AGENTS 和工作区检查必须改为 Pi Runtime 与 EMI Control Plane 边界。
- v0.1 需要自行实现最小任务状态、受控资源加载、Tool Gateway 和 Evidence Store，不能使用 Pi Session 代替。
- Pi 0.x 升级可能破坏 SDK 契约；必须精确锁版，为适配层建立契约测试，并通过独立变更升级。
- DeepSeek Harness 的成熟机制可以转化为 EMI 需求和验收测试，但不复制它的目录、配置和插件命名。

## 未采用的方案

- **继续基于 DeepSeek Harness**：内置能力更多，但大量能力与 EMI 自有控制面重叠，而真正的 EMI 安全、恢复和证据边界仍需自建，不足以抵消高耦合和预发布变更风险。
- **fork Pi 并修改内核**：可以直接添加能力，但会将上游合并和 EMI 领域代码绑定，扩大长期维护面。
- **只使用 Pi CLI 和 Pi Packages**：启动快，但默认资源发现、工具权限和 Session 权威边界不满足受控运行要求。
- **从零开发 Agent Runtime**：控制力最强，但会重复模型适配、流式响应、工具协议和上下文管理等已成熟工作，不符合 v0.1 的小闭环目标。
