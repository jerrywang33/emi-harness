# AGENTS - EMI Harness 仓库入口

本仓库使用 Pi 的成熟 Agent Runtime 重新建设 EMI Harness，并由自有 EMI Control Plane 掌握任务、权限、执行、验证和证据边界。项目定位和目标架构以 [`README.md`](README.md) 为准，当前建设范围和进度以 [`roadmap/README.md`](roadmap/README.md) 为准。

## 当前状态

仓库处于 v0.1 工程验收阶段。Roadmap 第 2 至第 7 步已经实现并通过自动化检查；受控 Pi Runtime、Control Plane、Resource Registry、Tool Gateway、Assurance 和 Integration 已在独立本地 TypeScript 目标项目中通过真实 Pi AgentSession 跑通失败恢复、验证和候选 Evidence Package。用户真实 EMI 业务验收尚未进行，不能把工程校准记录解释为业务、法律或生产就绪结论。旧版文件式 Harness 已删除，不得继续引用原来的 `harness/`、`conventions/`、`specs/pilot/`、Codex Skill 或 `install.sh`。

## 阅读顺序

1. 阅读 README，确认 EMI Harness 的部件、控制面与运行时边界。
2. 阅读 Roadmap，确认当前步骤、交付物和完成条件。
3. 阅读 [`docs/decisions/`](docs/decisions/) 中已接受的设计决定。
4. 只读取当前任务涉及的包、脚本和测试。

## 仓库边界

- 本仓库保存 EMI Control Plane、Pi 适配、受治理领域资源、工具策略、验证与证据规则、集成、脚本、测试和设计文档。
- Pi 与 Adapter 版本、资源版本和工具白名单必须能被运行清单精确记录；机器配置、凭据、Pi 本地 Session 和未脱敏的有效运行配置不得提交到仓库。
- 目标项目的代码和正式交付记录保存在目标项目中，不复制到本仓库。
- `demo/`、`.gstack/` 和本地环境文件只用于本机工作，不属于项目交付物。

## 开发规则

- EMI 代码只能通过 `PiRuntimePort` 调用 Pi，不得跨过 `runtime-pi` 导入 Pi 内部类型或把工作流写入 Agent Loop。
- v0.1 的 Harness 实现、测试和校准目标项目统一使用 Node.js、TypeScript 与 pnpm，不引入 Java 构建链或 Java 项目模板。
- 受控运行必须注入自建 ResourceLoader 和精确工具白名单，不得依赖 Pi 默认项目资源发现或默认有副作用的内置工具。
- Pi Session 是 Agent 工作记录，不是 EMI 任务状态、审批、工具操作或正式证据的权威来源。
- 不为凑目录创建空包或占位实现。每个包必须有明确用途、输入、输出、配置、测试和使用方。
- 先讨论并确认一个最小能力，再实现对应包；不要同时铺开多个目标包。
- 能用 Schema、测试、脚本或 CI 判断的规则，不交给 Agent 自行判断。
- Agent 进程之外必须保留独立的权限决策、隔离执行、配置检查和验收条件，不能让 Harness 只靠自身声明安全或完成。
- EMI 规则必须记录来源、版本、适用国家或地区、适用业务和确认状态；未确认的解释不得写成既定事实。
- 禁止提交令牌、密码、私钥、客户数据、生产配置或其他敏感信息。

## 变更方式

1. 架构或范围变化先更新 README、Roadmap 或设计决定。
2. 每次只实现一个能够独立检查的最小改动。
3. 运行与改动匹配的格式、Schema、单元、组合或端到端检查。
4. 提交信息说明做了什么以及为什么；每个完整步骤单独提交并推送。
