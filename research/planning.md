

补充发现两个直接竞争点：当前 BMAD 已区分 `built` 与由用户／编排器确认的 `done`；GSD Core 已用内容指纹发现验收后文件变化，并在交付门禁中把报告判为 `stale`。因此不能把“交付不等于完成”或“证据失效检测”单独宣称为 pi-dag 独有。最终建议会强调这些机制与项目图、裁决版本、Attempt 和集成树之间的完整关联。**pi-dag 有机会成为强产品，但“任务 DAG + 独立 review + 持久化上下文”已经不足以构成差异。** 截至本次核查，Beads 在图账本与原子认领上很强，Kiro 已支持依赖图和并行执行，Traycer 已有规划—执行—验证闭环，BMAD 明确区分 `built` 与 `done`，GSD Core 已实现验收报告的内容指纹与失效检测。pi-dag 最值得集中投入的是：**把任务契约、执行尝试、裁决版本、验收证据和最终集成树连接成可强制执行、可恢复、可审计的状态机。**

本次已读 [DESIGN.md](/home/purboo/project/pi-things/pi-dag/DESIGN.md) 指定章节；全程只读。检索与原文核查日期为 **2026-10-08**。以下未单列发布日期的网页、README 和源码，均指该日访问的当前版本，不把主线内容等同于所有已发布版本。置信度“高”指官方文档或源码直接支持；“中”指官方描述但实现／保障边界尚未验证；“未证实”不等于不存在。没有运行竞品或做性能基准。

**1．对比矩阵：先区分图账本、执行框架和规范工具。**

| 产品 | 数据模型与就绪集 | 存储与多 agent 并发 | 执行器耦合 |
|---|---|---|---|
| **Taskmaster AI** | task/subtask、依赖、优先级、状态、tags；`next`、`list --ready`、`clusters`。依赖 `done` **或 `cancelled`** 即满足 | `tasks.json` 为核心；当前 changelog 已有跨进程锁和原子 read-modify-write，不能再笼统称“JSON 无并发保护” | CLI/MCP 可配多种 agent；也有 automation/loop |
| **Beads / bd** | issue 图、层级、类型化关系；`bd ready`；`--claim` 原子设置 assignee 与 in_progress | **当前真相源是 Dolt**；embedded 单写者，server 支持多写者；JSONL 是导出，不是真相源 | 独立 CLI/MCP，亦与 Gas Town 等编排器结合 |
| **Backlog.md** | 每任务 Markdown、状态、里程碑、依赖、AC/DoD；可展示上下游。未确认完整、强制的 ready/claim 状态机 | Git 内一任务一文件；支持跨分支状态检查；未核实跨进程事务和同任务并发更新保障 | CLI/MCP/Web UI，执行器无关 |
| **AWS Kiro** | spec → requirements/design/tasks；当前官方文档明确**推导依赖图并按 waves 并行执行** | 本地 `.kiro/specs`、steering、hooks；云端另有工作环境；未见开放的项目账本并发协议 | 高度集成 Kiro IDE/CLI/Web |
| **GitHub Spec Kit** | constitution、spec、plan、tasks、convergence；任务清单与并行标记；显式任务依赖有社区 preset | Git 内 Markdown 与模板；未见通用多写者事务／原子认领协议 | 面向多种 coding agent 的 skills、模板与脚本 |
| **Traycer** | Epic、mini-specs、tickets、phases、plans；Smart YOLO 可拆分、合并、重排工作项 | 本次文档不足以确定完整持久化模型、冲突解决与事务边界 | 外层规划／验证器，对接多种 coding agent；自动执行有兼容性要求 |
| **Plandex** | plan、步骤、分支、上下文与累计代码 diff；未确认项目级 ready DAG | 服务端／本地自托管，plan 自带版本控制；代码变化先在 sandbox；具体存储与并发保障未深审 | 自带规划及执行运行时 |
| **Superpowers / obra** | 设计文档、细粒度实施计划、任务进度；提供并行 agent 与 worktree 技能，非独立项目数据库 | Git 中计划／代码，加宿主会话状态；没有由所读文档证明的事务型图账本 | skills 驱动宿主 agent／subagent |
| **BMAD Method，当前版** | initiative → epic → story/bug/spike；`tickets.toml` 稳定 ID、`after` 前置关系，可跨 epic；“what’s next”列出 ready/blocked | Markdown + TOML；**build plan 拥有构建状态**，tracker_status 分离；未核实多写者锁 | 多宿主 skills；可接 Jira/Linear/GitHub 等；auto build 一次显式执行一票 |
| **Linear agent 集成** | issue/project、关系与状态；**AgentSession 独立于 issue**，人类 assignee 与 agent delegate 分离 | 云端服务；有持久化 session/activity/webhook；不据此推断具备节点唯一执行租约 | 开放 agent API，可接外部运行时；所读开发文档仍标 Developer Preview |
| **Jira + Rovo/MCP** | issue、链接、可配置 workflow；MCP 能查询、编辑、transition；未见统一 agent-ready DAG 契约 | 云端工作项与历史；源码仓库另存；具体认领与并发不变量由集成负责 | MCP 接多种客户端；Rovo Dev 另提供代码评审 |
| **Shrimp Task Manager** | UUID task、dependencies、relatedFiles、implementationGuide、verificationCriteria；代码检查所有依赖 completed | `DATA_DIR` 下 `tasks.json`，Git 记录与 memory 备份；所读模型代码是整表读改写，未见围住操作的锁 | MCP 提供工作流程，宿主 agent 实施并提交评分 |
| **OpenSpec，补充** | 当前 specs 与 change delta 分离；schema 表达**产物依赖**；实现任务仍主要是 checklist | Git 内每 change 一个目录；降低不同 change 的文本冲突，不等于同一 requirement 的并发安全 | 多 agent 工具适配，框架提供 artifacts/commands |
| **Agent OS v3，补充** | standards、索引、spec、产品上下文；**已退出实现／任务编排** | 项目文件与 profile，`index.yml` 帮助相关标准注入 | 依赖宿主 Plan Mode 与执行能力 |
| **GSD Core，补充** | milestone/phase/plan/task、waves、requirements、STATE/CONTEXT/SUMMARY/VERIFICATION | `.planning` 结构化文件；有状态修复机制；未完成当前版本的跨进程写入审计 | 跨宿主 subagent 框架，执行、验证、ship 均有流程 |
| **ADR 工具：adr-tools / Log4brains** | decision、context、status、consequences、superseded 关系；不计算任务 ready | Git 内 Markdown；Log4brains 避免强制顺序编号，可分全局／package；Git 解决文本合并 | 不执行任务；CLI、站点与评审工作流 |

再看与 pi-dag 最相关的“谁判完成、规则如何传下去”。

| 产品 | 验收／done 的依据 | 约束传播、修订与交接 |
|---|---|---|
| Taskmaster | `testStrategy` 是验证说明；支持直接设置状态；未见强制树绑定验收回执 | 更新后续任务、subtask notes、tags；文件持久化。未见带 supersedes 的作用域裁决对象 |
| Beads | 通常由调用方 `bd close`；atomic claim 保障认领，不等于独立验收 | audit trail、关系、`remember` → `prime` 注入持久事实、closed-task compaction；Dolt 版本历史 |
| Backlog.md | AC + 项目默认 DoD；官方建议人审 spec、plan、code，验证后标 Done | plan/notes/final summary 与 decisions 留在 Git；一任务一会话／PR 的工作法 |
| Kiro | acceptance criteria、测试策略、IDE property-based testing；hooks 可执行命令、阻止工具调用 | steering 支持 `always/fileMatch/manual/auto`；spec 可修订；路径相关注入已是直接竞争能力 |
| Spec Kit | analyze/checklists + implement/converge；由 agent 流程输出结论，未证实树绑定门禁 | constitution、research、spec 贯穿流程；Markdown/Git 保存结果与修订 |
| Traycer | 外层 verification/review，对照计划检查；YOLO **可配置跳过验证** | Smart YOLO 会依据实施发现更新 specs、tickets、AC，并影响后续执行；完整决策谱系未公开证实 |
| Plandex | 自动运行／调试命令，用户可审累计 diff；不等价于独立项目验收组件 | 每次 plan 更新可版本化与分支；上下文可跨执行延续 |
| Superpowers | fresh subagent；先 spec compliance、后 code quality；verification-before-completion | 计划和技能指导后续任务；主要依赖 agent 遵循流程，未见不可绕过的账本门禁 |
| BMAD 当前版 | **Build 停在 built；用户／orchestrator 才标 done**；review 追加带日期记录、不修改状态 | baseline、AC、review 留在 plan；epic retrospective；correct-course 修订；删除 plan 会丢证据 |
| Linear | session 完成与 issue 完成是不同对象；agent activities 驱动 session 状态 | issue、评论、guidance、promptContext、session 组成交接上下文；不自动提供验收证明 |
| Jira/Rovo | workflow 控制 transition；**Rovo Dev 可将 PR 与 Jira AC 对照评审** | Jira/Confluence/Teamwork Graph 提供上下文；工作项历史可审计；未见节点／路径裁决生效集 |
| Shrimp | 源码：调用方给 `score`，**`score >= 80` 自动 completed**；不是工具独立执行测试 | project rules、task summary、memory；Git 可记变更，但评分来源依赖宿主 agent |
| OpenSpec | scenarios + verify 流程；结构校验与实现符合性检查应分开理解 | ADDED/MODIFIED/REMOVED delta，archive 时并入主 spec；审计上下文保存较完整 |
| Agent OS v3 | 验收交回宿主工具 | 标准发现、索引、定向注入是核心；没有证明具备裁决失效传播 |
| GSD Core | UAT、verification、ship preflight；**内容指纹变化使 passed → stale，完成门禁会重查** | STATE/CONTEXT 跨会话；验证涵盖 plan/summary、requirements、实现文件，支持 gap-fix 循环 |
| ADR 工具 | 决策 accepted 不代表实现通过 | 理由、后果、替代关系与 Git 历史强；自动注入与落实检查通常需另接工具 |

**规模维度的共同结论：本次没有取得足够证据，给任何一个产品认证“千节点、多 agent 并发、长期运行已稳定”。** Beads 的数据库与图查询、Taskmaster 的 ready/cluster 查询、文件工具的分片加载都有结构优势，但结构优势不是 benchmark。Plandex 宣称的 2M context／20M 项目索引是**代码上下文容量**，不能换算成任务图规模。Linear/Jira 的一般工作项规模同样不能证明其 agent 验收链性能。

**2．逐项要点与值得借鉴之处。**

下列来源均为官方仓库、官方文档或厂商页面；用户 issue 单独标明。

1. **Taskmaster AI：成熟的任务分解与查询入口；置信度高。**  
   `testStrategy`、dependencies、subtasks、metadata 比自由 Markdown 更易供 agent 查询；但 `cancelled` 满足依赖、父任务 done 自动使子任务 done，是 pi-dag 应明确拒绝或单独建模的语义。  
   当前 changelog 的 #1566/#1569 已补跨进程锁与原子读改写。值得借鉴 `ready + blocking` 找高影响工作、metadata 保留、按需暴露 MCP 工具减少上下文。  
   来源：[任务结构](https://tryhamster.com/docs/taskmaster/capabilities/task-structure)、[依赖规则](https://tryhamster.com/docs/taskmaster/task-workflow/dependencies)、[当前 changelog](https://github.com/eyaltoledano/claude-task-master/blob/main/CHANGELOG.md)；访问 2026-10-08。

2. **Beads：最应认真研究的项目图账本；置信度高。**  
   当前原子 claim、ready、审计、持久记忆、类型化关系都直接相关；但 hash ID 解决的是身份碰撞，不能解释成“所有并发修改零冲突”。  
   旧版 SQLite + Git JSONL 与当前 Dolt 是不同架构。值得借鉴稳定 ID、typed edges、查询式交接、短上下文输出；不宜照搬持续同步的双状态源。  
   来源：[当前 README](https://github.com/steveyegge/beads/blob/main/README.md)、[v0.49.0 架构](https://github.com/steveyegge/beads/blob/v0.49.0/docs/ARCHITECTURE.md)、[Dolt 维护者迁移说明，2026-05-29](https://www.dolthub.com/blog/2026-05-29-evolving-with-beads/)。

3. **Backlog.md：可读性和人工审查体验很强；置信度高，锁保障未证实。**  
   一任务一文件、AC 与 DoD 分离、实施前才补具体 plan，适合避免巨型计划迅速过时。官方明确区分完成保留依赖与取消／归档清理引用。  
   值得借鉴“审任务契约 → 审计划 → 审代码”的三个入口，以及 Markdown 可直接阅读；pi-dag 可以输出这种视图而不让它成为第二真相源。  
   来源：[官方 README](https://github.com/MrLesk/Backlog.md)；访问 2026-10-08。

4. **Kiro：已覆盖 DAG、规则注入和事件门禁的多项单点能力；置信度高。**  
   Specs 文档更新于 **2026-10-02**，已列 IDE/CLI/Web 并行任务执行；steering 的 fileMatch 与 pi-dag 的 paths scope 很接近。  
   hooks 不只是生成测试的提示词，还能跑 shell、在 PreToolUse 拦截操作。值得借鉴路径作用域和阶段文档体验；pi-dag 应突出规则版本、证据失效、跨执行器的一致保证。  
   来源：[Specs](https://kiro.dev/docs/specs/)、[Steering](https://kiro.dev/docs/steering/)、[Hooks，更新 2026-09-30](https://kiro.dev/docs/hooks/)。

5. **GitHub Spec Kit：规范一致性工作流，而非现成的项目级验收账本；置信度高。**  
   当前 README 已把 `implement → converge` 循环作为主流程，不能只按初版的 specify/plan/tasks 评价。  
   值得借鉴 constitution、需求到任务覆盖检查、独立分析步骤与可定制模板；应提供导入适配，保留 requirement ID 与来源版本。显式任务依赖 preset 不宜误报为核心事务 DAG。  
   来源：[当前 README](https://github.com/github/spec-kit)、[显式依赖社区 preset PR](https://github.com/github/spec-kit/pull/2091)；访问 2026-10-08。

6. **Traycer：产品定位上最接近“执行器之外的规划与验证层”；能力描述高置信，保障边界中置信。**  
   Smart YOLO 明确会修订 specs/tickets、AC、工作顺序，并将实施学习带给后续步骤；这已超出静态 PRD 拆任务。  
   值得借鉴 mini-spec、细粒度 handoff、独立 verification 的体验；但文档允许跳过验证，本次未找到 tree-bound receipt、强制合并锁、裁决替代链的公开证明。  
   来源：[YOLO 官方文档](https://docs.traycer.ai/extension/tasks/yolo-mode)、[Epic/spec 方法](https://traycer.ai/blog/the-ultimate-spec-driven-development-approach)；访问 2026-10-08。

7. **Plandex：适合借鉴计划历史和变更沙箱，但需注意运营状态；置信度高。**  
   plan 的版本控制、分支与累计 diff sandbox，是“执行中可反悔、可比较”的好设计；它更接近自带运行时的 coding agent。  
   官方 README 写明云服务自 **2025-10-03** 起 winding down、不再接受新用户，仍列自托管方案；不能将其描述为正常扩张中的云竞品，也不能因此宣称开源项目已全部停止。  
   来源：[官方 README](https://github.com/plandex-ai/plandex)；详细 winding-down 页面本次 DNS 获取失败。

8. **Superpowers：开发纪律和独立评审的强基线；置信度高。**  
   新鲜 subagent、spec compliance → code quality 两阶段评审、RED/GREEN、worktree、完成前验证，都与 pi-dag 的目标高度重合。  
   值得直接兼容其计划／评审流程；差异应是“工具拒绝非法状态转移，并给出证据”，而不是声称其他工具没有独立 review。  
   来源：[官方 README](https://github.com/obra/superpowers)、[subagent-driven-development 技能源码](https://github.com/obra/superpowers/blob/main/skills/subagent-driven-development/SKILL.md)；访问 2026-10-08。

9. **BMAD Method：当前版已出现非常相关的构建账本设计；置信度高。**  
   当前不是只能描述为 `sprint-status.yaml`：tickets.toml 维护分解／顺序，plan 保存 baseline、AC、构建状态与评审；tracker 状态不会直接使 build 跳过流程。  
   值得借鉴 `built ≠ done`、review 不直接改状态、需求覆盖与 epic 级集体验证；缺口是本次没有证实机器强制的证据绑定和原子多写者控制。  
   来源：[票据树](https://docs.bmad-method.org/plan/set-up-the-ticket-tree/)、[拆分与跟踪](https://docs.bmad-method.org/plan/break-work-into-stories-and-track-it/)；访问 2026-10-08。旧 v6 文档不能代表当前行为。

10. **Linear：最值得借鉴“人类责任”和“agent 执行”的分离；置信度高。**  
    agent 是 delegate，人类仍是 assignee；AgentSession 承载一轮代理工作，与 issue 生命周期分开，适合映射 pi-dag Node/Attempt。  
    值得借鉴 activities、promptContext、可见的等待／执行状态；pi-dag 宜把 Linear 当外部产品协作入口，不能用 session 完成替代验收完成。  
    来源：[官方 Agents API](https://linear.app/developers/agents)、[Linear Agent MCP，2026-04-23](https://linear.app/changelog/2026-04-23-linear-agent-mcp-support)。

11. **Jira + Rovo：已有验收条件驱动的 PR review，不能只当 CRUD MCP；置信度高。**  
    MCP 开放查询、字段更新和 workflow transition；Rovo Dev 官方产品页明确对照关联 Jira 工作项的验收条件评审 PR。  
    值得借鉴业务需求与代码证据的双向链接；pi-dag 仍可提供本地确定性验收、集成树门禁和裁决作用域，但应与 Jira workflow 集成而非重建整个项目管理平台。  
    来源：[官方 MCP tools](https://support.atlassian.com/atlassian-rovo-mcp-server/docs/supported-tools/)、[Rovo Dev Code Review](https://www.atlassian.com/software/rovo-dev/code-review)；访问 2026-10-08。

12. **Shrimp：很好的反例——“verify 工具”不一定验证了任何代码；源码结论高置信。**  
    `verifyTask` 接收调用方的 summary、score，`score >= 80` 就标 completed；工具本身没有在这一步执行独立测试。  
    `taskModel.ts` 的整表读改写未见跨操作锁，因此推断多个 MCP 进程共用 DATA_DIR 存在 lost-update 风险，**此风险未实测**。值得借鉴 relatedFiles、verificationCriteria、项目规则入口，不照搬评分完成语义。  
    来源：[verifyTask.ts](https://github.com/cjo4m06/mcp-shrimp-task-manager/blob/main/src/tools/task/verifyTask.ts)、[taskModel.ts](https://github.com/cjo4m06/mcp-shrimp-task-manager/blob/main/src/models/taskModel.ts)；访问 2026-10-08。

13. **OpenSpec：2025–2026 同类中最值得借鉴的“变更相对于现状”模型；置信度高。**  
    当前 spec 与 proposed delta 分离，archive 合并 ADDED/MODIFIED/REMOVED requirements；适合 brownfield 持续演进。  
    值得借鉴把 Amendment 做成明确 delta，保留变更理由、受影响要求和历史；但 artifact dependency graph 与项目执行 DAG 是不同层次，不能直接画等号。  
    来源：[官方仓库](https://github.com/Fission-AI/OpenSpec)、[Concepts](https://github.com/Fission-AI/OpenSpec/blob/main/docs/concepts.md)；访问 2026-10-08。

14. **Agent OS v3：给 pi-dag 的重要产品警示——规划／编排容易被宿主吸收；置信度高。**  
    **2026-01-20** 的 v3 明确退休 implementation/orchestration 阶段，集中于标准发现、索引和注入。  
    值得借鉴 `index.yml`、相关标准的渐进加载和项目 profile；pi-dag 应避免把主要壁垒押在自动拆任务和提示词编排上。  
    来源：[官方 changelog](https://github.com/buildermethods/agent-os/blob/main/CHANGELOG.md)。

15. **GSD Core：应列为重点跟踪对象，证据失效已不是空白；置信度高。**  
    旧 `gsd-build/get-shit-done` README 已指向 `open-gsd/gsd-core`；当前有 waves、跨会话 artifacts、UAT、gap fixes 和 ship preflight。  
    官方文档明确：完成门禁重新计算 plan/summary、requirements、实现文件指纹，变化则 passed → stale。值得借鉴覆盖集指纹与 `human_needed` 弃权；pi-dag 要进一步关联精确集成树、裁决版本、独立生产者和并发 ownership。  
    来源：[当前仓库](https://github.com/open-gsd/gsd-core)、[Verify and ship](https://github.com/open-gsd/gsd-core/blob/main/docs/how-to/verify-and-ship.md)、[1.7.0 变化](https://github.com/open-gsd/gsd-core/blob/main/docs/whats-new-1.7.0.md)；访问 2026-10-08。

16. **ADR：Ruling 的语义祖先，尤其值得借鉴不可变历史；置信度高。**  
    adr-tools 管理仓库内决策文件；Log4brains 提供检索、时间线、静态站点，以及 global/package ADR。决定被 superseded 后仍保留其理由和当时上下文。  
    值得借鉴 status、consequences、supersedes 与作用域；pi-dag 的增量是“自动选取当前有效裁决、记录注入版本、检测受影响执行与证据”，不能只是自动把 ADR 拼进提示词。  
    来源：[adr-tools](https://github.com/npryce/adr-tools)、[Log4brains](https://github.com/thomvaill/log4brains)；访问 2026-10-08。

**3．共同空白与可超越点：优势应落在完整保证链上。**

在已核查材料中，**没有证实任何单个产品完整提供下列组合**；这是限定于本次证据的结论，不是“全市场绝无”。

| pi-dag 应保证的行为 | 为什么仍有价值 |
|---|---|
| 一个节点只能有一个有效执行 owner，续跑／重派有谱系 | task 状态、agent session、进程锁和幂等 API 经常分散；仅提供 claim 或幂等键不覆盖整个生命周期 |
| 契约版本、规则版本、代码树、命令／环境共同绑定验收 | GSD 已有内容指纹，但 pi-dag 可把来源、独立生产者、运行环境与集成状态统一建模 |
| Ruling 变更会找出受影响的 running／accepted／integrated 节点 | 现有 steering、constitution、标准注入很强；“规则变化后哪些旧成果需要重验”仍是可做深的部分 |
| 合并前后检查、证据复用、失败恢复与记账一致 | review OK、issue done、CI green、代码入集成分支常是不同系统的事实 |
| `ready` 带解释和满足依据 | 不止返回待办列表，而是说明依赖哪版产物、哪条集成记录、哪些规则；阻塞原因可被人和 agent 使用 |
| 可重放的审计与短交接包 | 既保留完整历史，又避免每次把千节点计划塞进上下文 |

产品上建议把主张收敛为：**“让多个 agent 的项目进度可被证明，而不是被汇报。”** 规划生成、看板、MCP CRUD、Markdown 编辑器可以适配现成工具；重点投入确定性状态机、证据模型、作用域裁决和集成事务。

**4．存储与数据模型建议：优先修正当前设计中的一致性边界。**

**第一，明确唯一真相源；不要同时让 plan 文件与 journal 都可独立决定事实。**  
当前 §3 允许修改节点文件，§4 又说 journal 唯一真相，必须补齐契约。建议所有 mutation 经命令提交事件，`plan/`、看板和 handoff 均为可重建投影；人直接编辑 YAML 后通过 `dag plan import` 生成 revision。事件至少包含：

```text
event_id
schema_version
project_id
entity_id
expected_entity_revision
actor
causation_id
correlation_id
payload
```

`seq` 可以保留为**单机日志位置**，不要把它当全局身份或跨机器因果顺序。

**第二，针对 MVP 采用“单机权威写入口 + 不可变事件 + 可重建索引”。**  
这与“不常驻进程”兼容：每个 CLI 进程获取统一锁，在锁内做读取、前置条件检查、状态转移和持久化。不能只锁 append；两个进程可能先读到相同旧状态，然后依次写入互相矛盾的事件。

可以继续用 JSONL，但应定义尾部半条写入的恢复、fsync、重复 event 去重、snapshot 校验与日志重放。SQLite 适合作为可丢弃查询索引；**不要默认把 SQLite 和 JSONL 都做成可独立修改并异步互相同步的权威库**。

**第三，多机不要靠“各自负责不同节点”来假定安全。**  
不同节点也会共同修改依赖、Ruling、plan revision 和 Integration；离线的两台机器还可能同时认领同一节点。`flock` 只能解决共享锁域内的互斥。

未来可采用每 writer 的不可变 event segment、全局唯一 event ID、显式因果关系及 entity revision 冲突检测；但同节点离线认领必须拒绝自动合并，或交给有一致性保证的协调服务。**合并事件集合不等于合并合法状态。**

Beads 的历史正好说明这个边界：旧版是 SQLite 缓存与 Git JSONL；当前改为 Dolt、server 多写者，代价是数据库状态与源码 Git 提交的关系需要单独处理。[issue #2489](https://github.com/steveyegge/beads/issues/2489) 有用户报告失去 code+issue 同提交原子体验及同步问题，属于**用户报告，不是本次复现的当前缺陷**。应借鉴稳定 ID、tombstone、语义冲突检测，而不是把 JSONL + Git 当作自动解决分布式写入的答案。

**第四，尽早解决“验收证据本身改变被验收树”的自引用。**  
当前 receipts、journal 默认进同一源码分支；写入一条验收回执就可能让工作区 dirty，提交后又改变 tree。若回执要求绑定包含自己在内的最终树，会形成无法稳定满足的绑定。

我倾向于独立的元数据 branch/worktree：源码 tree 是验收对象，账本明确引用其 OID。代价是源码与账本不再同一 Git commit 原子提交，所以 Integration 需要可恢复事务。另一方案是定义排除 `.pi-dag` 的 source manifest digest；但这时要明确它不是完整 Git tree hash，不能混用两种身份。

**第五，依赖应携带满足条件，先解决 accepted／integrated 的矛盾。**  
§0.5 以 integrated 解锁后续；§3.2 却写 deps accepted 即 ready。若 dispatch 从集成分支建 worktree，前置仅 accepted 尚未合并，后续就读不到它。

建议：

```yaml
deps:
  - node: J1-COLD-PLAY
    requires: integrated
    artifact: code
```

代码依赖默认 integrated；设计契约可 accepted；外部任务可以指定 receipt predicate。聚合、blocking、related、supersedes 应是不同关系，不能统一当作 DAG blocking edge。取消前置不得自动当成功，必须有显式 waiver 或替代产物。

**第六，把认领与执行尝试分开；幂等键不能单独保障唯一 writer。**  
`dag:node:a1` 与 `dag:node:a2` 是两个不同键，都能成功启动。应先原子 CAS 认领 Node，分配 `attempt_id + fencing_token`，再通过可恢复 outbox 调 dsa。旧 Attempt 即使迟到交付，也不能越过新 owner 的 fencing token 推进状态。

这比仅在状态机里写“同一时刻一个 running”更具体，也直接覆盖设计文档里的重复启动事故。

**第七，把 Receipt 升级为可复用的验证结果，把 Ruling 升级为版本化输入。**  
除现有 tree/env/command 外，建议绑定：

```text
node_revision
acceptance_digest
effective_rulings_digest
verifier_version
plugin_digests
source_tree_or_manifest
environment_identity
input_artifact_digests
```

同树是复用证据的必要条件之一，**不是充分条件**：插件、规则、依赖服务、工具链或时间敏感输入也可能变化。还应区分 `executor-reported`、`independently-verified`、`parent-overridden`；`producer` 字符串和日志 hash 能说明身份声明／内容完整性，不能独立证明测试确实由可信组件运行。

每次 dispatch 记录实际注入的 Ruling ID/版本、匹配原因和 dispatch manifest digest。裁决变更后，对尚未执行、正在执行、已验收的节点分别重算、要求确认／重派、标记待重验；不要只影响下一次 prompt。

**第八，Integration 需要 crash recovery，不只是失败时 reset。**  
建议至少记录 `prepared → git-applied → checks-passed → committed`，并保存 PRE、候选提交／树、target ref 预期值、回执引用。进程在 merge 后、写账前崩溃时，下一次调用应识别已发生的合并并继续核验，不重复合并。

同理，未知文件 quarantine、验收运行、分支清理应分别有结果记录。单写者锁解决并发，恢复协议解决中途死亡；二者不可替代。

**证据冲突、缺口与下一步。**

- **版本冲突已核实：** Beads 的 JSONL／Dolt、BMAD 的 sprint-status／tickets.toml、GSD 的旧仓库／新仓库、Agent OS v2/v3 都有实质变化。报告采用当前原文，并把旧架构限定为历史经验。
- **不能作出的结论：** 未审完 Backlog.md、当前 BMAD/GSD 的所有写入路径；Traycer 的内部事务、持久化与完整审计协议未公开证实；没有千节点横向性能数据。搜索摘要、旧版本教程、PR 意图及用户问题报告均未作为当前能力的独立证明。
- **保留的核心证据：** 官方 README／文档、Shrimp 完成与存储源码、Taskmaster 并发修复记录、Beads 固定旧版架构与当前架构、GSD 失效检测文档。排除了泛泛排名文章，以及把 token context、星数和“适合大型项目”当规模指标的材料。
- **最有价值的下一步：** 用统一的 300／1,000 节点、9 writer 验收场景比较 Beads、Taskmaster、GSD Core 与 pi-dag 原型：重复认领、并发更新、写入后崩溃、规则变更、验收后改树、merge 后账本写入前崩溃、跨会话恢复。记录丢失更新、错误 ready、陈旧证据被接受次数、恢复时间与交接 token 数。

在这些场景上给出可重复结果，比再增加一层自动规划能力，更能证明 pi-dag 的领先性。