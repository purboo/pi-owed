# pi-dag 市场调研综合（2026-10-08）

来源：四份并行调研报告（同目录 orchestrators.md / planning.md / verification.md / runtime.md），均以当日核查的官方文档、官方仓库和带版本论文为主；厂商效果数字只作方向参考。

## 1. 结论

“任务 DAG + 并行 agent + 独立 reviewer + merge queue”已经不是差异点。下列能力都已有成熟产品覆盖：

| 能力 | 已有产品 |
|---|---|
| 任务依赖图、ready 集、原子认领 | Beads（`bd ready`、`--claim`，Dolt 真相源）、Taskmaster、Kiro（依赖图 + waves 并行） |
| 并行 agent + 工作区隔离 + 看板 | Codex、Cursor、Conductor、Sculptor、Superset、Emdash、Vibe Kanban、Claude Squad |
| 里程碑验证 / 独立 reviewer | Factory Missions、Antigravity 2.0（Reviewer/Critic/Auditor）、Superpowers 两阶段评审、Traycer |
| merge queue + 验证门禁 | Gas Town Refinery（Bors 式二分）、GitHub merge queue、Graphite、Mergify、Aviator、Trunk、Zuul |
| built ≠ done | BMAD 当前版 |
| 证据失效检测 | GSD Core（内容指纹变化：passed → stale） |
| 路径作用域规则注入 / 事件门禁 | Kiro steering `fileMatch` + PreToolUse hooks；Claude Code TaskCompleted hook（exit 2 拒绝） |
| 确定性编排 / 重放 | Devin Dynamic Workflows、Temporal、Restate、DBOS |
| 治理与分发 | GitHub Agent HQ（身份、权限、required checks、审计） |

可以争取第一的位置是**完整保证链**：把任务契约、执行尝试、裁决版本、验收证据、集成树连成一个可强制执行、可恢复、可审计的状态机。已核查的产品中，没有一家公开契约同时覆盖这些环节。

定位句：**让多个 agent 的项目进度可被证明，而不是被汇报。**

## 2. 品类共同缺口（pi-dag 的机会）

1. **完成 ≠ 验收**：多数产品的 done 来自 agent 自报、评分或评论完成。反例是 Shrimp：调用方给出 score≥80 即 completed。
2. **证据没有适用范围**：只看日志或树哈希，不绑定命令、环境、工具链、verifier、规则版本。
3. **用隔离代替所有权**：worktree 隔离不等于 diff ⊆ write_set，也不能防止修改验收脚本。
4. **认领 ≠ 持续唯一写者**：幂等键 `a1`/`a2` 都能启动；缺少 attempt fencing。
5. **知识传播没有裁决语义**：规则只是 prompt 注入，没有作用域、替代关系、注入记录，也不会让受影响结果失效。
6. **计划变更影响分析弱**：修订后哪些 running/accepted/integrated 节点需要重验，没有产品给出。
7. **看板展示活动，不展示可信度**：缺少“为何 ready / 为何 accepted / 哪些证据过期 / 哪些 override 未清”。
8. **集成不是可恢复事务**：merge 成功但记账前崩溃、ref 被外部推进等情形没有公开语义。

## 3. 必须借鉴的成熟机制

| 来源 | 机制 | pi-dag 用法 |
|---|---|---|
| GitHub merge queue / Zuul / Graphite | 验证“未来状态”：在目标最新 + 前序候选上组合测试，推测性并行前缀 | 候选在隔离区构造并验收，锁内仅 CAS 推进 ref；默认 every-prefix-green |
| Bazel / Gradle / Nx / Turborepo | action key 包含全部输入；漏报输入会造成错误命中；缓存命中会重放旧日志 | `execution_key` 取代 `reuse: tree`；区分“新执行”与“复用” |
| SLSA / in-toto / gitsign | attestation：subject digest + predicate + 可验证身份 | Receipt 拆成 ExecutionAttestation / VerificationDecision / IntegrationAttestation |
| CODEOWNERS / 受保护分支 | 规则从 base 读取，保护规则文件本身，新提交使审批失效 | 策略、插件、测试、fixture 从可信基线加载；审批绑定 diff 摘要与策略版本 |
| Temporal / Restate / DBOS | 纯 reducer + 带身份的副作用 operation；先登记补偿再执行；调用方幂等键 | journal 实现 outbox；dispatch/answer/stop/merge 都有 operation_id |
| Inngest | 幂等窗口只有 24h | dsa D1 必须定义保留期与 prune 后行为 |
| LangGraph / Agent Framework | 恢复会重跑含 interrupt 的节点；pending request 恢复后会重发 | 审批登记与批准后执行分开；恢复通知去重 |
| Dagster | code_version + data_version 驱动的失效传播 | 依据证据谱系传播 Amendment 失效 |
| Prefect | 默认同缓存键可并发执行 | 复用、去重、写者互斥是三个不同契约 |
| Linear AgentSession | 人类 assignee 与 agent delegate 分离 | Node 与 Attempt 分离 |
| OpenSpec | 现状 spec 与 change delta 分离 | Amendment 建模为 delta |
| ADR / Log4brains | status、consequences、supersedes | Ruling 的不可变历史 |
| Stryker mutation | 用 mutant 检验测试敏感性 | 对“去掉锁 / 跳过 SHA 校验 / 忽略 TAP failure”等关键分支做定向 mutation |

## 4. 对 DESIGN.md 的修订建议（按优先级）

### P0：不改就无法兑现“独立验收”

1. **删除“默认采信写者自测回执”**（§3.3、§10.2）。写者可以触发受信 runner，由 runner 独立产生证据；写者自行生成的回执只作诊断线索。签发凭据若写者可读，就不构成独立性。
2. **`reuse: tree` 升级为 execution key**：源码快照、测试包、命令参数、环境、工具链/镜像、解析后的依赖与 fixture、平台、verifier/parser/plugin 版本。执行结果复用与验收决定复用分开判定，并提供 `dag evidence explain`。读取 commit SHA、时间、随机数或外部服务的测试默认 `reuse: never`。
3. **验收策略不能由候选改写**（§7）：config、plan、插件、测试启动脚本、parser、评审指令从可信基线加载并 pin 版本。
4. **merge 改为“候选验证 + CAS 推进”**（§3.6）：`integration.requested → candidate built → checks passed → ref CAS → committed → cleanup`。崩溃后按 candidate 和目标 ref 对账补记，不重复合并；PRE 被外部改变时拒绝提交，不盲目 reset。
5. **journal / receipts 移出被验收源码树**（§4）。写入受跟踪的回执会让树变 dirty、改变 tree hash，形成自引用；`reset PRE` 还会倒退唯一真相。改用独立元数据 ref/worktree，每个项目只有一个权威写入点。
6. **唯一写者靠 CAS 认领 + attempt_id + fencing token**，不靠幂等键。旧 attempt 的迟到交付只能更新历史；未确认旧写者已停止前，禁止新写者接管同一 worktree。
7. **MVP 不得静默降级**（§8）：尚不支持的风险档要明确拒绝或标记；证据失效与 protected-path 门禁不能推迟到第二版。

### P1

- 依赖边带满足条件：`{node, requires: integrated | accepted | external-receipt}`；代码依赖默认 integrated。取消的前置不等于成功，需要显式 waiver。
- 状态拆成三个维度：execution（pending/active/waiting/stopping/ended/unknown）、evidence（missing/valid/rejected/stale）、integration（absent/preparing/committed/validated/repair-required）。`integrated(review-pending)` 是 provisional 状态，默认不放行严格后继。
- 增加 `dispatching`、`stop-requested`、`stopped-confirmed`、`outcome-unknown`，保留 dsa `once → unknown` 的诚实语义。
- 锁保护“读最新状态 → 检查前置条件 → 分配 seq → 追加并 fsync”整个过程；定义尾部半条记录恢复、快照 `last_seq`、event_id 去重。
- 事件字段：event_id、schema_version、entity_id、expected_entity_revision、node_revision、attempt_id、generation、operation_id、causation_id、policy_digest、actor。
- plan 只是投影：人工编辑通过 `dag plan import` 生成 revision。
- Ruling 记录 dispatch 时实际注入的版本（`rulings_seen_at_dispatch`）；新裁决命中 active 节点时产生待确认通知，必要时阻止验收；签发者需要有权限。
- 审批绑定 decision_id、node revision、attempt/generation、操作与参数摘要、tree、作用域。批准 a1 不等于批准 a2。
- red-first 定义为同一冻结测试包上的双运行：基线代码 + 新测试为红，候选代码 + 同一测试为绿。红必须是预期断言失败，启动失败或超时不算；TAP 检查 plan、test ID、skip/TODO、bail、截断，零用例不算通过。
- 写集检查需要 NUL 安全，覆盖 rename 的源和目标、删除、symlink、mode、submodule。完整 OID 按仓库 object format 校验（兼容 SHA-256）。
- quarantine 默认拒绝脏集成区，只自动处理工具自有的临时文件。
- 不常驻时要写清谁触发 reconcile；看板显示 `observed_at` 和已消费的 high-water mark。

### P2

- 推测性并行队列、影响分析车道、批量合入（显式区分 every-prefix-green 与 batch-head-green）。
- 外部 ReviewProvider 适配（CodeRabbit、Greptile TREX、Copilot、Qodo、Bugbot），由确定性规则解释：没有 findings ≠ 满足验收契约。
- 跨机：per-writer event segment + revision 冲突检测，或协调服务（Restate 是首选第二底座原型）。

## 5. dsa 接口修订（替换 §9 D1–D3 的表述）

| 能力 | 语义 |
|---|---|
| `run(key, spec_digest, …)` | 同 key 同 spec 返回原执行；同 key 不同 spec 报冲突；定义终态保留期、prune tombstone、项目 UUID 命名空间 |
| `command(command_id, target_generation, …)` | answer/follow-up/stop 去重；answer 指定 qid；follow-up 返回确定的 generation |
| `events(cursor)` | 来源 epoch、稳定 event ID、schema、下一游标、high-water mark、retained-from；出现缺口时报错。`(epoch, wid, local_seq)` 游标集合即可，不必是全局 seq |
| `describe(key)` | 全部 generation 谱系、执行版本、结构化报告、canonical cwd、写者所有权、清理状态 |
| `reconcile/stop` | 返回 stopping / confirmed-stopped / unknown |

D4 写者互斥是正确性前提，不是可选项。dsa 现状：D1 机制已在内部存在（`Outbox.send` 的 rid 幂等），但没有对外暴露；D2 缺失；D3 已有（`CallResult.data`）。

## 6. 底座选择

第一版沿用 dsa，加上 pi-dag 自有的事件 reducer 和 operation 协议，不引入 Temporal、DBOS 等第二套执行历史。若将来接受常驻服务和多机，优先用 Restate 做原型。LangGraph、Agent SDK、CrewAI 只适合 planner/reviewer 内部流程。

## 7. 证据边界与风险

- 没有研究证明“pi-dag 式约束 + 独立验收”在目标仓库上的净收益为正。Cognition 2026-04 仍主张单线程写入；Cursor 的平权文件锁方案失败，20 个 agent 的有效吞吐只有 2–3 个；Anthropic C 编译器项目在所有 agent 撞同一缺陷时并行失效。可靠的共识是：可分解且有强 oracle 的任务才值得多写者。
- Scaling Agent Systems v3 的结果：可分解任务 +80.8%，顺序规划 −70%。DAG 的价值首先在于正确拆分，其次才是槽位数量。
- 闭源产品的故障语义（崩溃、重复认领、旧 agent 复活）没有公开，也没有实测，因此不能宣称它们“没有”这些能力。
- 产品风险：Agent OS v3 已退出编排，说明规划生成会被宿主吸收；GitHub Agent HQ 有分发优势。pi-dag 应作为其上游的治理/证据层，并能集成 Linear、Jira、GitHub。

## 8. 证明“同类最强”的方式：对抗验收套件

用可复现的套件代替功能清单，并与 Gas Town、Claude Code hooks、Beads、GSD Core 等做基线对比。

**A. 唯一写者 / 恢复**：并发 dispatch 同一节点；run 返回丢失后重试；旧 attempt 复活后迟到交付；answer 响应丢失；事件重复或乱序；journal 尾部断写；stop 未确认；dsa prune 后对账。
**B. 证据**：伪造 Receipt；dirty 树自报通过；同树但工具链不同；运行中改文件后恢复；偷跳测试 / `sys.exit(0)`；伪造 TAP、零用例、全部 skip；缓存投毒；修改验收脚本或未授权路径。
**C. 规则 / 审批**：候选修改 config 给自己放行；过期审批；撤销或替代 Ruling 后对 pending/running/accepted 节点的影响。
**D. 集成**：前序候选失败；PRE 被外部推进时的 CAS 竞争；ref 更新后、journal 写入前崩溃；post-merge 检查失败。
**E. 规模 / 收益**：300/1000 节点、9 writer 下的错误 ready、丢失更新、陈旧证据被接受次数、恢复时间、交接 token 数；1/2/4/8 写者对照 accepted/integrated 吞吐、返工、父级干预时间、escaped defects。

每项的验收标准：拒绝错误证据，保留可诊断记录，恢复后不重复产生副作用，也不虚报完成。
