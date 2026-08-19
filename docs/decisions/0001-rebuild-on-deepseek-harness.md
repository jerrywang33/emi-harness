# 0001：基于 DeepSeek Harness 重新建设

- 状态：已被 [0002：以 Pi Runtime 为执行内核，自建 EMI 控制面](0002-adopt-pi-runtime-with-emi-control-plane.md) 取代
- 日期：2026-08-18

## 背景

仓库最初使用 Markdown、Codex Skill 和固定 Java 验证项目模拟 Coordinator、Executor、Verifier、失败回流和证据记录。这套内容帮助团队认识 Harness，但其目录、入口和运行方式不是 DeepSeek Harness 的 Profile、Bundle 与 Plugin 实现。

继续在旧结构上迁移会同时维护两套概念和路径，也容易把旧文件改名后误认为已经完成 DeepSeek Harness 集成。

## 决定

- 删除旧版文件式 Harness，不保留兼容目录、软链接或双入口。
- 以 README 定义的八个部件为目标，从 DeepSeek Harness 的 Profile、Bundle 和 Plugin 机制重新实现。
- 先建立 pnpm 工作区，再按 Roadmap 一次实现一个有实际用途且可以独立检查的最小能力。
- 旧实现只保留在 Git 历史中，不复制到新的目录作为默认规则。
- 目标项目代码和正式交付记录继续与 EMI Harness 源代码仓库分开保存。

## 影响

- 原有 `harness/`、`conventions/`、`specs/pilot/`、`skills/`、`templates/`、`scaffolds/`、`reports/` 和 `install.sh` 路径不再有效。
- 仓库在新的 Profile 和最小 Bundles 完成前不能执行 EMI Harness 任务；README 中的实现结构属于正在建设的目标。
- 新能力必须按照当前 DeepSeek Harness 版本重新验证，不能假设旧 Workflow 或检查配置可以直接复用。
- 如需查阅旧实现，可从本决定之前的 Git 提交恢复，不在主分支保留第二套结构。
