# Controlled EMI Resources v0.1 设计

- 状态：已实现 v0.1
- 对应 Roadmap：v0.1 第 4 步
- 最后更新：2026-08-21

## 目标

实现一条可以被 RunManifest 精确引用的 EMI Context 和一个受控 Skill，证明 Agent 只能得到本次运行声明的领域资源，并且每项关键内容都能追溯到版本、来源、适用范围、确认状态和文件摘要。

本步不建设法规全文仓库、搜索引擎、自动法规更新或完整 EMD2/DORA/GDPR/AML 知识体系。法规来源变化只产生待审查更新，不自动覆盖已经进入 Run 的资源。

## 最小资源

v0.1 使用 `emi.safeguarding.payment-funds` 作为第一个 EMI Context，范围只覆盖 EEA EMI 对发行电子货币所收资金的 safeguarding 设计输入。来源基线为：

- [EMD2 合并文本 02009L0110-20180113](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A02009L0110-20180113) Article 7：EMI 必须 safeguarding 发行电子货币所收资金，并规定支付工具收款情况下的最迟时间边界。
- [PSD2 当前合并文本 02015L2366-20250117](https://eur-lex.europa.eu/legal-content/EN/TXT/?uri=CELEX%3A02015L2366-20250117) Article 10：相关资金不得与非用户资金混同，并在适用路径下进入独立账户或安全、流动、低风险资产，同时按成员国法律实现对其他债权人请求的隔离。
- PSD2 Article 114 与 Annex II：对被废止 Directive 2007/64/EC 的引用按 PSD2 和对应表读取。该关系用于记录来源链，不替代成员国转置与主管机关要求确认。

Context 只把上述来源支持的命题标记为 `source_supported`。成员国、牌照主体、具体 safeguarding 方法、业务资金分类、截止时间计算、账户安排和监管解释必须标记为 `task_confirmation_required`；没有 Human Authority 确认时，Agent 只能把它们列为 TRD 待决项。

受控 Skill `emi.skill.control-to-trd` 只负责将已经确认的 Context 控制映射到 TRD 的系统行为、技术控制、验证和证据。它不得决定法规适用性、把待确认项降级、扩展目标范围或批准自身输出。

## 文件与摘要

```text
packages/resource-registry/
├── resources/
│   ├── registry.json
│   ├── contexts/emi.safeguarding.payment-funds/
│   │   ├── manifest.json
│   │   └── context.md
│   └── skills/emi.skill.control-to-trd/
│       ├── manifest.json
│       └── SKILL.md
├── schemas/resource-manifest.schema.json
└── src/
```

- `registry.json` 是唯一入口，显式列出 Resource ID、版本、Manifest 相对路径和 Manifest 文件 SHA-256；Registry 不扫描目录发现资源。
- Manifest 记录 kind、状态、内容路径、内容 SHA-256 和适用元数据。RunManifest 的 VersionedRef digest 等于 Manifest 文件原始 UTF-8 字节摘要。
- 内容摘要验证通过后才可加载；Manifest 或内容的空白变化也会改变摘要，必须创建新版本或更新未进入 Run 的索引。
- 所有路径必须是资源根目录内的规范相对路径；真实路径解析后仍须位于根目录，拒绝 `..`、绝对路径和符号链接逃逸。
- 只有 `active` 资源可进入受控运行。`draft` 可供审查，`retired` 只能解析历史引用；任何摘要不匹配都立即失败。

## 运行投影

调用方按 RolePlan 中的精确 VersionedRef 请求资源。Registry 保持请求顺序，验证引用并返回不可变内容：

- `emi_context` 投影为 context file，供 Agent 阅读任务相关来源、约束和待确认项。
- `skill` 投影为追加 system prompt，并先检查当前角色是否在 Skill 的 `allowedRoles` 中。
- 未声明资源、重复引用、错误 kind、非活动状态、未知角色或摘要不一致全部拒绝。
- 投影使用 `emi-resource:{resourceId}@{version}` 作为逻辑 source，不暴露宿主机绝对路径。

Pi Runtime 仍只接收调用方显式传入的投影；Registry 不读取目标项目的 `AGENTS.md`、用户目录、Pi Session 或网络内容。

## 验收条件

1. 仓库内 Context 与 Skill 的 Manifest、内容和 Registry 摘要全部一致。
2. Context 每条来源包含权威机构、CELEX/文档标识、版本日期、条款定位、URL、获取日期和支持状态。
3. Context 明确区分来源支持事实、工程推导和任务级人工确认项。
4. Skill 明确输入、输出、允许角色和禁止事项，不能承担审批或法规适用性判断。
5. 精确引用可以生成稳定投影；未声明、重复、篡改、draft、路径逃逸和角色越权均有负向测试。
6. Registry 不依赖 Pi，也不自动发现资源；后续 Integration 只把其投影转换为 `RuntimeResourceSnapshot`。
