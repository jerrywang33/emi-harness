# v0.1 核心 MUST 规则

以下规则适用于 Coordinator、Executor 和 Verifier。任何一条违反都不能判定运行完成。

1. **SDD-01**：实现前必须确认 `specs/pilot/system-design.md` 状态为 `Approved`，并在 manifest 固定其 commit。
2. **SCOPE-01**：只交付已批准的 8 模块骨架、Spring Boot 启动、`Money`、指定测试和证据；不得自行扩大范围。
3. **ARCH-01**：必须生成 8 个且仅 8 个模块，内部依赖集合必须与 SDD 第 7 节完全一致。
4. **ARCH-02**：无实际职责的模块只保留 POM；禁止占位 Facade、DTO、Service、Gateway、Repository、Controller、Consumer、Scheduler 或标记类。
5. **DOMAIN-01**：`Money` 必须完整实现 SDD 第 8 节语义；禁止隐式舍入、隐式换汇、`double` 工厂和可变状态。
6. **TECH-01**：必须使用已冻结的 Java、Maven、Spring Boot、插件和依赖版本；禁止用替换版本绕过失败。
7. **QUALITY-01**：正式 PASS 只接受 run 专属 Maven 仓库上的完整 `clean verify`；禁止 skip 参数、部分 Reactor、`|| true` 或忽略退出码。
8. **TEST-01**：四个指定测试类必须被实际发现且全部通过；删除、禁用或弱化失败测试等同门禁失败。
9. **ROLE-01**：Coordinator 不写业务代码；Executor 不批准自己的交付；Verifier 不改代码，且初始结论前不读取 Executor 完成声明。
10. **TRACE-01**：每次状态变化、角色交接、commit、命令、退出码和证据路径必须先落盘再推进。
11. **ATTEMPT-01**：失败回流必须创建新 attempt，历史 attempt 只读；第 3 次 FAIL 后进入 `ESCALATED`。
12. **SEC-01**：令牌、密码、私钥、Maven settings 和带凭据 URL 不得进入源码、Git 历史、报告或日志。
13. **GIT-01**：`emi-harness` 与 `emi-pilot` 使用独立 Git 历史；`emi-pilot` 本次不得配置远端。
14. **ACCEPT-01**：Verifier PASS 后只能等待用户验收；用户未明确接受时不得标记 `COMPLETED`。

## 冲突处理

- 发现 SDD 与规则冲突时立即停止，由 Coordinator 记录并交给用户。
- Executor 和 Verifier 不得自行修改 SDD、规则、测试门禁或验收标准。
- 环境失败进入 `BLOCKED`，实现失败进入 `REWORK_REQUIRED`；不得将失败改写为成功。
