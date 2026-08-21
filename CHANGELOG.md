# Changelog

本文件记录 EMI Harness 可识别工程版本的主要变化。版本只表示对应工程基线经过记录的检查，不自动表示生产就绪、法规解释已确认或真实 EMI 业务验收通过。

## 0.1.0 - 2026-08-21

### Added

- 受控 `PiRuntimePort` 与 Pi 0.84.2 Adapter，使用自建 ResourceLoader、精确工具白名单和 EMI 自有事件类型。
- SQLite EMI Control Plane，保存 Task、Approval、RunManifest、Run、RoleRun、状态历史、幂等命令、租约和 fencing token。
- 最小 Controlled EMI Resource Registry，包含一条 safeguarding Context 和一个 Context-to-TRD Skill。
- 持久化 Tool Gateway、权限重检、操作意图、幂等写入、独立 helper process 和中断后对账。
- 独立 Executor/Verifier 编排、Agent 外确定性检查、不可变 Evidence Store 和候选 Evidence Package。
- 基于真实 Pi AgentSession 与 Faux Provider 的无网络 TypeScript 目标项目校准，覆盖已知失败恢复、独立 PASS 和数据库重开。

### Boundaries

- V0.1 是本地工程验证基线，不是生产沙箱、真实模型评估、完整 EMI 知识库或生产系统。
- 候选校准 Task 停在 `awaiting_acceptance`；真实 EMI 业务、法律判断和最终用户验收保留给后续逐任务校准。
