# AGENTS - EMI Harness 仓库入口

本仓库从 DeepSeek Harness 运行机制出发重新建设 EMI Harness。项目定位和目标架构以 [`README.md`](README.md) 为准，当前建设范围和进度以 [`roadmap/README.md`](roadmap/README.md) 为准。

## 当前状态

仓库处于重新建设阶段。README 中的 Bundle、Plugin、Profile、Workflow 和 Verification 是目标设计，不代表已经实现或可以运行。旧版文件式 Harness 已删除，不得继续引用原来的 `harness/`、`conventions/`、`specs/pilot/`、Codex Skill 或 `install.sh`。

## 阅读顺序

1. 阅读 README，确认 EMI Harness 的八个部件及其边界。
2. 阅读 Roadmap，确认当前步骤、交付物和完成条件。
3. 阅读 [`docs/decisions/`](docs/decisions/) 中已接受的设计决定。
4. 只读取当前任务涉及的 Bundle、Plugin、脚本和测试。

## 仓库边界

- 本仓库保存 Bundles、Plugins、EMI 规则与业务资料、开发流程、检查规则、脚本、测试和设计文档。
- 可启动的 EMI Profile 安装到 `$DSH_HOME/profiles/<name>`，不得把机器配置、凭据或未经脱敏的有效配置提交到仓库。
- 目标项目的代码和正式交付记录保存在目标项目中，不复制到本仓库。
- `demo/`、`.gstack/` 和本地环境文件只用于本机工作，不属于项目交付物。

## 开发规则

- Profile、Bundle、Plugin 和 patch 的含义必须与 DeepSeek Harness 官方机制一致，不自行创造同名概念。
- 不为凑目录创建空 Bundle、空 Plugin 或占位实现。每个包必须有明确用途、输入、输出、配置、测试和使用方。
- 先讨论并确认一个最小能力，再实现对应包；不要同时铺开四个 Bundle。
- 能用 Schema、测试、脚本或 CI 判断的规则，不交给 Agent 自行判断。
- Agent 进程之外必须保留独立的配置检查和验收条件，不能让 Harness 只靠自身声明安全或完成。
- EMI 规则必须记录来源、版本、适用国家或地区、适用业务和确认状态；未确认的解释不得写成既定事实。
- 禁止提交令牌、密码、私钥、客户数据、生产配置或其他敏感信息。

## 变更方式

1. 架构或范围变化先更新 README、Roadmap 或设计决定。
2. 每次只实现一个能够独立检查的最小改动。
3. 运行与改动匹配的格式、Schema、单元、组合或端到端检查。
4. 提交信息说明做了什么以及为什么；每个完整步骤单独提交并推送。
