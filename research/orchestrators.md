**截至 2026-10-08，pi-dag 仍有明确的产品空间，但“任务图＋并行 agent＋独立 reviewer＋合并队列”已经不能作为独占卖点。** 最接近的竞争路线是 **Gas Town、Factory Missions、Devin Dynamic Workflows、Claude Code agent teams，以及 Google Antigravity 的 teamwork preview**。GitHub 则已经拥有最成熟的团队审查与合并基础设施，补齐项目级任务图的成本可能最低。

pi-dag 更有机会建立优势的组合是：**工具执行的验收状态机、与代码及验收定义绑定的证据、强制写集检查、可追溯的裁决传播，以及变更后的证据失效传播**。本轮未发现任何一个产品公开证明完整实现了这组能力；这表示公开证据存在空白，不表示它们内部绝对没有。

已阅读 [DESIGN.md](/work/pi-dag/DESIGN.md) 指定章节；未修改项目文件。研究分为四条线：执行与派活、验收与合并、持久化与知识传播、产品生命周期与团队能力。

**阅读口径**

- 下文所有来源均于 **2026-10-08 查阅**；有明确发布日期时另列。没有日期的滚动文档，以查阅日期为准，不推断功能首发日期。
- **“未发现”**：本轮查阅的公开资料中未找到足够证据，不等于确认不支持。
- **隔离不等于防双写者**：两个 worktree 可以隔离文件，但不能证明同一逻辑任务不会重复派发；同一 worktree 内也可能存在多个写者。
- **独立 reviewer 不等于独立验收器**：另一 agent 的判断有价值，但不自动构成不可绕过、绑定代码树的验收回执。
- **PR 门禁**表示借用 GitHub/GitLab 等宿主机制；不能因此记为产品自己的节点验收或合并事务。
- 置信度主要针对**公开文档是否明确描述能力**，并非经过安装、故障注入验证的运行可靠性。

**1．对比矩阵：任务、验收和集成**

产品编号对应后文的原始来源与说明。

| 产品 | 任务图／依赖与就绪 | 节点状态机 | 幂等派活／防双写者 | 独立验收 | 写集／所有权越界检查 | 合并门禁 |
|---|---|---|---|---|---|---|
| ① Claude Code | shared tasks 有依赖，未完成依赖阻止认领 | pending／in progress／completed；非完整验收链 | **任务认领文件锁**；未发现跨 attempt 幂等启动契约 | `TaskCompleted` hook 可拒绝完成；检查逻辑由用户提供 | 未发现任务级 diff 写集强检 | hooks 可扩展；未发现原生集成队列 |
| ② OpenAI Codex | subagents／并行任务；未发现持久项目 DAG | 线程与执行状态；未发现验收状态链 | worktree／云环境隔离；任务幂等未发现 | 有 review 工作流；未发现强制独立验收回执 | 未发现 | diff review／Git 工作流；原生项目合并队列未发现 |
| ③ Cursor | 并行 cloud agents、事件自动化；依赖 DAG 未发现 | agent／automation 运行状态 | 独立 VM；同任务去重契约未发现 | 文档明确 agent 自验；Bugbot／独立 review automation 可补充 | 未发现；环境权限不是写集 | PR、Bugbot、风险分流；项目级 merge queue 未发现 |
| ④ Devin | **代码化 pipeline／parallel，结果驱动后续阶段** | workflow phase、agent 状态、失败处理 | 已完成调用按哈希重放；运行中全局排他未发现 | 可设计 audit→fix→verify；未发现不可绕过的验收器 | shared VM 要求分离文件，但属使用约束 | 分支交接／PR；强制集成门禁未发现 |
| ⑤ Factory Droids／Missions | features、顺序、milestones；通用 DAG 就绪契约未发现 | feature／milestone／worker 进度 | 未发现；官方仍讨论并行化价值 | **里程碑末运行 validation workers** | 未发现 | 验证阶段明确；锁、队列、树绑定评审未发现 |
| ⑥ Google Jules | SDK fleet／`jules.all()`；任务依赖需外部代码 | **公开 session 状态枚举** | 独立云 session；创建幂等未发现 | agent 测试＋人审计划／PR；独立验收器未发现 | 未发现 | 自动创建 PR；依赖宿主门禁 |
| ⑦ GitHub Copilot／Agent HQ | issue 到 agent／PR；跨任务就绪推导未发现 | session＋issue＋PR，非单一验收状态机 | 云执行／分支；节点级排他未发现 | code review＋CI／required checks；不限于 agent 自报 | 规则与 CODEOWNERS 可约束评审；任务 diff allowlist 未发现 | **宿主 required reviews／checks／merge queue** |
| ⑧ Amp | subagents、Puck 跨线程协调；项目 DAG 未发现 | 线程／agent 状态；验收状态链未发现 | 未发现 | 未发现强制独立验收；有工具辅助验证 | 未发现 | 未发现原生门禁 |
| ⑨ OpenHands | SDK 支持 delegation／组合；项目 DAG 未发现 | **ConversationExecution／事件状态** | conversation ID／恢复；派活排他未发现 | 可编写验证工具；通用独立验收层未发现 | 未发现 | Git 集成可扩展；原生项目门禁未发现 |
| ⑩ Conductor（Melty） | 多 workspace／session；依赖推导未发现 | workspace／checks 状态 | worktree 隔离；逻辑去重未发现 | 人审 diff／CI checks；独立验收器未发现 | 提示中的 scope；强制检查未发现 | PR、checks、逐 workspace merge；锁／队列未发现 |
| ⑪ Sculptor（Imbue） | 多 workspace／agent；DAG 未发现 | workspace／agent 状态 | 隔离 workspace；同 workspace 可加多个 agent | 人审＋工作流 skills；独立验收契约未发现 | 未发现 | review／merge／PR；强制队列未发现 |
| ⑫ Vibe Kanban | issue 看板／workspace；依赖就绪未发现 | 看板、工作区、执行状态 | 分支／workspace；逻辑去重未发现 | inline diff review；独立验收器未发现 | 未发现 | PR／merge UI；强制队列未发现 |
| ⑬ Claude Squad | 并行 session；DAG 未发现 | session pause／resume 等 | tmux＋Git workspace；逻辑去重未发现 | 人工查看 diff | 未发现 | checkout／commit／push；门禁未发现 |
| ⑭ Crystal → Nimbalyst | task trackers＋session kanban；依赖推导未发现 | 可视化任务／session 状态 | worktree；逻辑去重未发现 | 渲染文档与代码逐项接受／拒绝 | 未发现 | Git 管理／diff review；强制门禁未发现 |
| ⑮ Terragon | 云任务；项目 DAG 未发现 | 持久 thread／任务数据 | 每任务 sandbox／唯一分支；幂等启动未发现 | 未发现独立验收器 | 未发现 | checkpoint／PR；强制门禁未发现 |
| ⑯ Ona | trigger＋prompt／shell 步骤；通用 DAG 未发现 | automation run 状态 | 可复现云环境；节点排他未发现 | **可混合确定性 shell 验证**；不是统一回执契约 | 未发现 | merge-ready PR；依赖宿主规则 |
| ⑰ Gas Town | **Beads 依赖、molecules、convoys、epic 集成分支** | issue／worker／MR 多层生命周期 | 持久身份、hook、生命周期协调；跨故障排他保证未完整核实 | **Refinery 验证门禁**，不是只收 worker 完成报告 | 未发现通用任务级 diff allowlist | **Bors 式批量／二分队列、失败隔离、集成分支** |
| ⑱ Superset | 多 workspace／自动化；项目 DAG 未发现 | agent 状态／通知 | worktree；逻辑去重未发现 | diff review；独立验收器未发现 | 未发现 | review／Git 工作流；强制队列未发现 |
| ⑲ Emdash | issue 导入／并行任务；依赖推导未发现 | agent lifecycle hooks／session 状态 | worktree；逻辑去重未发现 | diff／CI review；独立验收器未发现 | 未发现 | PR／CI／merge UI；强制队列未发现 |
| ⑳ Google Antigravity 2.0 | subagents、异步任务；teamwork 有 milestone 分解 | 执行状态＋编排文件；统一验收状态机未发现 | workspace／权限与监控；幂等派活未发现 | **Reviewer＋Critic＋Auditor，最终审计**，research preview | 角色约束明确；工具级写集检查未发现 | 未发现通用 merge queue／树绑定门禁 |

**2．对比矩阵：裁决、持久化、证据与团队**

这里严格把“会话可恢复”与“崩溃后操作可安全重放”分开，也把“保存日志”与“证据可合法复用”分开。

| 产品 | 决策／裁决传播 | 跨会话／崩溃持久化 | 证据复用：树／验收契约绑定 | 可观测看板 | 多机／团队 |
|---|---|---|---|---|---|
| ① Claude Code | 消息、计划审批、项目指令；作用域 ruling 未发现 | 本地 task 持久；**恢复不重建 in-process teammates** | 未发现 | team／任务状态 | 本地为主；团队账本跨机一致性未发现 |
| ② Codex | AGENTS.md、线程交接；裁决谱系未发现 | 持久线程／worktree／云任务；业务事务恢复未发现 | 未发现 | app／CLI／云任务视图 | 云、远程工作环境、移动端控制 |
| ③ Cursor | rules、automation memory；裁决失效传播未发现 | 云 run、环境版本、artifact；事务重放未发现 | 未发现 | agents／automations dashboard | 团队共享、云 VM、多仓库 |
| ④ Devin | **结构化结果进入后续 prompt；改 prompt 重跑下游** | **run ID＋确定性重放** | 调用结果按 prompt/schema/settings 哈希复用；**不是树证据** | workflow phase／子 session／成本 | 多 VM；可选择 shared VM |
| ⑤ Factory | orchestrator 改计划／重排 milestone；作用域 ruling 未发现 | 有 mission 执行记录；精确崩溃恢复契约未发现 | 未发现 | **Mission Control** | App／CLI／企业与 Droid Computers |
| ⑥ Jules | session 消息与计划；跨任务裁决未发现 | 云 session 可重新取得／SDK rehydrate | 未发现 | session／activities／PR | 云端 fleet；团队一致账本未发现 |
| ⑦ GitHub | issue／PR／指令／memory；作用域裁决失效未发现 | **服务端 issue、PR、session、审计** | 检查绑定提交／merge group；通用树等价复用未发现 | **Agent HQ／mission control／审计指标** | 强：组织权限、跨设备、多人评审 |
| ⑧ Amp | **引用其他 thread 并提取上下文**；无 ruling 契约 | thread 持久；执行恢复保证未发现 | 未发现 | threads＋Puck 状态协调 | workspace 上下文；多机排他未发现 |
| ⑨ OpenHands | message／agent context／skills；裁决谱系未发现 | **状态与事件持久化、local／remote conversation 恢复** | 未发现 | UI／SDK events；委派可视化可扩展 | remote agent server／分布式执行基础 |
| ⑩ Conductor | AGENTS.md／CLAUDE.md／`.context` | workspace 上下文；崩溃事务未发现 | 未发现 | sidebar／diff／checks | 本地桌面为主；团队一致控制面未发现 |
| ⑪ Sculptor | workspace 上下文／skills；ruling 未发现 | session／workspace；恢复保证未核实 | 未发现 | desktop workspace／agent／changes | 本地；容器／远程 backend 为实验功能 |
| ⑫ Vibe Kanban | issue／review comments；ruling 未发现 | 本地 DB／workspace，非已证明事件重放 | 未发现 | **kanban＋diff＋preview** | 团队功能曾发布；现需考虑社区维护 |
| ⑬ Claude Squad | session prompt；裁决传播未发现 | session 保存／暂停恢复；宿主崩溃保证未发现 | 未发现 | TUI／preview／diff | 本地／SSH 使用；团队控制面未发现 |
| ⑭ Crystal → Nimbalyst | 文件↔session↔task 关联 | session 搜索／恢复、本地文件 | 未发现 | **session kanban＋可视化产物** | 桌面跨平台＋iOS companion |
| ⑮ Terragon | thread／自定义提示；ruling 未发现 | DB＋Git checkpoint | 未发现 | web／CLI task 管理 | 历史云产品；**已停运、OSS 快照** |
| ⑯ Ona | automation 配置／prompt；ruling 未发现 | 云环境／automation run；精确重放未发现 | 未发现 | run／组织可见性 | **云／客户 AWS、GCP 网络部署** |
| ⑰ Gas Town | **mail、handoff、escalation、Beads**；路径命中 ruling 未发现 | **持久工作状态＋身份／sandbox／session 分离** | 未发现通用树哈希验收复用 | convoy 状态／生命周期监控 | 多 repo／多 runtime；跨机一致写入未核实 |
| ⑱ Superset | workspace prompt／context；ruling 未发现 | workspace／terminal；精确恢复保证未核实 | 未发现 | 集中 agent 状态／diff | **remote hosts＋CLI／SDK／MCP** |
| ⑲ Emdash | issue 内容／agent feedback；ruling 未发现 | **SQLite＋可恢复 session hooks** | 未发现 | task／diff／CI／通知 | **SSH／SFTP 远程机器** |
| ⑳ Antigravity | orchestrator 策略／handoff 文件 | teamwork 用自交接、cron 检查与重启；非事务式恢复 | 未发现 | Agent Manager／artifacts | 跨平台／企业；teamwork 本地运行需保持机器在线 |

**3．逐产品要点与可借鉴设计**

以下每项包含当前定位、关键边界与可借鉴点；除注明外，来源均为官方文档或官方仓库，日期均为查阅日 **2026-10-08**。

**① Claude Code——原生任务原语已经逼近，但验收语义仍由扩展提供。置信度：高。**

- 官方明确：依赖未完成的任务不能认领，任务认领使用文件锁；`TaskCreated`、`TaskCompleted`、`TeammateIdle` 可通过退出码 2 拒绝创建、完成或空闲。
- subagents 支持独立上下文及后台执行；teams 增加共享任务与相互通信。但 team task 的 `completed` 并非 pi-dag 的 verified／accepted／integrated 三阶段。
- 借鉴：把关键状态迁移做成确定性拦截点；避免依赖 lead 记得执行检查。注意当前文档仍列出 teammate 恢复与状态滞后限制。来源：[agent teams](https://code.claude.com/docs/en/agent-teams)、[subagents](https://code.claude.com/docs/en/sub-agents)、[hooks](https://code.claude.com/docs/en/hooks)。

**② OpenAI Codex——并行执行、工作区和跨设备入口强，项目正确性账本尚未公开。置信度：高。**

- 当前官方文档已支持 subagent 并行工作；worktree 可运行独立线程，也支持后台计划任务和连接远程计算机后的移动端管理。
- 这些机制解决线程与工作区管理；未发现自动维护项目依赖、验收证据失效或合并后节点解锁的公开契约。
- 借鉴：Local／Worktree 间 handoff，以及把 diff review 放在任务旁边。来源：[Subagents](https://developers.openai.com/codex/multi-agent/)、[Worktrees](https://developers.openai.com/codex/app/worktrees/)；原页抓取受限后已用直接 HTTP 读取正文核实。

**③ Cursor——已从 background agents 扩展到持续自动化与团队云执行。置信度：高。**

- cloud agents 在独立 VM 中工作，可使用多仓库环境，产出截图、视频、日志；团队成员可以通过 run URL 查看工作。
- Automations 官方明确写出“verifies its own output”；另可配置独立审查与按风险指派 reviewers，因此不能笼统说它只有自报，也不能记为默认独立验收器。
- 借鉴：环境版本、测试演示 artifacts、风险分流。来源：[Cloud Agents](https://cursor.com/docs/cloud-agent)、[Automations](https://cursor.com/blog/automations)、[2026-05-20 更新](https://cursor.com/changelog/05-20-26)。

**④ Devin——Dynamic Workflows 是重要新增威胁，已不是单个自主工程师。置信度：高。**

- workflow 是确定性 Python 程序，提供 `agent`、`pipeline`、`parallel`，子调用返回结构化结果，按 run ID 恢复。
- 调用键由 prompt、schema、执行设置的哈希形成；已完成结果重放，改 prompt 会重跑对应调用及下游。**这属于执行结果缓存，不能直接作为代码验收证据。**
- 借鉴：明确的重放契约、阶段流式推进、可追踪子调用；shared VM 明确要求不重叠写集，但文档没有声称工具强制。来源：[Dynamic Workflows](https://docs.devin.ai/work-with-devin/dynamic-workflows)。

**⑤ Factory Droids／Missions——产品定位与 pi-dag 最相近之一。置信度：高。**

- Missions 先协作定义 features、milestones、skills 与成功条件，再由 orchestrator 管理执行；官方给出约 1–500 features 的适用启发式。
- 每个 milestone 末有 validation workers；成本估算包含每 milestone 两次 validator 运行，但不应据此推断为两份强制独立评审。官方仍把“是否需要并行化”列为开放问题。
- 借鉴：计划阶段产品化、里程碑验证、失败后生成 fix features。来源：[Missions](https://docs.factory.com/missions/overview.md)、[Planning & Validation](https://docs.factory.com/missions/planning.md)、[Mission Control](https://docs.factory.com/missions/running-cli.md)。

**⑥ Google Jules——云 fleet SDK 完整，项目控制面仍需调用方构建。置信度：高。**

- SDK 提供 `jules.all()`、并发限制、session rehydrate、wait／result 等能力，适合把大量独立任务送入云端。
- API 明确区分 QUEUED、PLANNING、AWAITING_PLAN_APPROVAL、AWAITING_USER_FEEDBACK、IN_PROGRESS、PAUSED、COMPLETED、FAILED；“计划批准”与“代码验收通过”是不同事件。
- 借鉴：稳定 session API、活动流与明确等待状态。来源：[官方 SDK](https://github.com/google-labs-code/jules-sdk)、[Sessions API](https://jules.google/docs/api/reference/sessions/)。

**⑦ GitHub Copilot／Agent HQ／mission control——最强的现成团队治理与合并基础。置信度：高。**

- Agent HQ 于 **2025-10-28** 公布；**2026-02-04** 官方宣布 Claude、Codex 接入预览，可在同一任务上比较多个 agent，并把历史、审查保留在仓库工作流内。
- GitHub 的 required reviews、required checks 与 merge queue 可提供独立于执行 agent 的门禁；但 Agent HQ 并不因此自动成为跨 issue 的项目 DAG。
- 借鉴：agent 身份、审计、组织策略，以及把执行产物直接落到既有 PR 协作模型。来源：[Agent HQ 公告](https://github.blog/news-insights/company-news/welcome-home-agents/)、[2026-02-04 更新](https://github.blog/news-insights/company-news/pick-your-agent-use-claude-and-codex-on-agent-hq/)、[merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue)。

**⑧ Amp——线程上下文复用突出，Puck 已承担跨任务协调入口。置信度：中。**

- `read_thread` 能从其他有权限访问的线程提取相关上下文；**2026-08-18** 的 Puck 官方公告展示了检查活跃线程、启动修复 agent、追踪进度等用途。
- 这些是跨会话协作原语；未发现作用域裁决、验收状态机或合并门禁的明确契约。部分手册抓取受限，因此对底层编排能力保守计分。
- 借鉴：按需求提取旧线程证据，减少父级复制上下文。来源：[Read Threads](https://ampcode.com/news/read-threads)、[Talk to Puck](https://ampcode.com/news/talk-to-puck)。旧“公开分享线程”介绍已于 **2026-06-02** 标注撤销，不应继续作为当前卖点：[官方更新](https://ampcode.com/news/social-coding)。

**⑨ OpenHands——更像可构建 pi-dag 的执行底座，而非成品对手。置信度：高。**

- SDK 将 conversation state 作为主要可变状态，持久保存事件；支持 LocalConversation／RemoteConversation 和从 persistence 恢复。
- agent delegation、可扩展工具、状态与事件 API 有利于构建上层编排，但未发现项目任务图、写集门禁、裁决对象这一整层。
- 借鉴：执行状态与配置分离、恢复时验证兼容性、事件可观察。来源：[Design Principles](https://docs.openhands.dev/sdk/arch/design)、[Conversation API](https://docs.openhands.dev/sdk/api-reference/openhands.sdk.conversation)。

**⑩ Conductor（Melty）——强在并行 workspace 的日常操作闭环。置信度：高。**

- 当前官方指南已包含 Cursor 并行会话，并提供 diff viewer、Checks tab、PR 与逐 workspace merge 流程。
- 文档要求为任务说明 scope／验证方式，避免两个 workspace 做相同的大范围文件修改；这是操作建议，不是自动所有权验证。
- 借鉴：任务、运行、检查、review、归档放在同一工作区。来源：[官方并行指南](https://www.conductor.build/docs/guides/parallel-agents/run-multiple-cursor-sessions)、[monorepo 工作范围](https://www.conductor.build/docs/guides/repositories/monorepos)。

**⑪ Sculptor（Imbue）——需要按当前官方版本理解，不能沿用早期“Docker 包装器”画像。置信度：高。**

- 当前官方 README 定位为并行 agent desktop app，支持在既有 workspace 中添加另一个 agent；容器／remote backend 在独立实验文档中说明。
- 官方提供 spec、fix-bug 等 skills，包括复现、先写失败测试、再修复，但未发现这些被统一验收状态机强制执行。
- 借鉴：把规范、复现和测试作为可调用工作流，且让用户能快速进入 agent 的产物。来源：[README](https://github.com/imbue-ai/sculptor)、[Agents](https://github.com/imbue-ai/sculptor/blob/main/docs/help/agents.md)、[实验 backend](https://github.com/imbue-ai/sculptor/blob/main/docs/help/experimental/container_backend.md)。

**⑫ Vibe Kanban——界面设计值得研究，但商业产品状态必须更正。置信度：高。**

- 当前官方 README 已标记 sunsetting；官方公告说 **bloop 公司关闭，Vibe Kanban 继续作为社区维护的开源项目存在**。公告正文没有可确认日期，不能把第三方所说的月份当官方日期。
- 产品把 planning issues 与 execution workspaces 分开，提供 inline diff feedback、应用 preview、PR／merge。
- 借鉴：把“任务定义”与“执行实例”分开，正好对应 Node 与 Attempt。来源：[官方仓库](https://github.com/BloopAI/vibe-kanban)、[Goodbye bloop](https://www.vibekanban.com/blog/shutdown)。

**⑬ Claude Squad——轻量、终端优先，主要解决同时管理多个执行器。置信度：高。**

- 官方提供后台任务、独立 Git workspace、preview／diff、pause／resume、checkout／commit／push。
- 没有找到从任务依赖推导 ready、独立验证回执或强制合并队列的证据。
- 借鉴：低操作成本的 TUI、清楚的会话注意力状态；不必为了看板引入重型平台。来源：[官方仓库](https://github.com/smtg-ai/claude-squad)。

**⑭ Crystal／Nimbalyst——旧品牌已退出，应把后继产品纳入监测。置信度：高。**

- Crystal 官方明确写明 **2026 年 2 月 deprecated，替代品为 Nimbalyst**；不能再把 Crystal 当持续演进中的独立产品。
- Nimbalyst 提供 parallel sessions、worktrees、session kanban、任务 tracker、文件与 session 关联，以及桌面和 iOS 入口。
- 借鉴：证据可从任务跳到文件、再跳到产生它的 session；可视化产物的接受／拒绝比纯聊天汇报更易检查。来源：[Crystal 迁移声明](https://github.com/stravu/crystal)、[Nimbalyst 官方仓库](https://github.com/Nimbalyst/nimbalyst)。

**⑮ Terragon——已停运，留下可研究的云 agent 控制面代码。置信度：高。**

- 官方 OSS 仓库明确标注 **2026-01-16 shutdown snapshot**，按原样提供，不保证维护或完整性。
- 历史能力包括多 agent provider、每任务独立 sandbox、唯一分支、Git checkpoint 与自动 PR。
- 借鉴：任务 checkpoint 和云端线程管理；它目前更适合作为实现参考，而非活跃商业威胁。来源：[官方快照](https://github.com/terragon-labs/terragon-oss)。

**⑯ Ona——企业云环境与确定性步骤组合是优势。置信度：高。**

- **2026-02-19** 宣布 Automations GA：按计划、PR、webhook 触发，把 AI prompt 与确定性 shell 命令组合为闭环任务。
- 环境由 devcontainer 与 automations 配置定义；企业可在自身 AWS／GCP 网络中运行，便于访问真实集成测试依赖。
- 借鉴：把测试环境视作验收契约的一部分，避免“有命令但环境不成立”。来源：[官方发布](https://ona.com/stories/ona-automations-proactive-background-agents)。

**⑰ Gas Town——当前最直接的开源架构竞争者。置信度：高；强一致保证为中。**

- 已覆盖 Beads 依赖、convoys、molecules、持久身份、watchdogs、escalation；不是普通 tmux manager。
- 当前 README 明确描述 Refinery 的 **Bors 式二分合并队列与 verification gates**；集成分支文档还覆盖子任务从集成分支启动、合入、解锁下一波、最终整体落地。
- 借鉴：identity／sandbox／session 生命周期分离，完成工作移交 merge queue，worker 退出后仍可推进。来源：[官方仓库](https://github.com/steveyegge/gastown)、[Integration Branches](https://github.com/steveyegge/gastown/blob/main/docs/concepts/integration-branches.md)、[Polecat Lifecycle](https://github.com/steveyegge/gastown/blob/main/docs/concepts/polecat-lifecycle.md)。尚未据此认定其拥有树绑定回执或跨崩溃 exactly-once 派活。

**⑱ Superset——新增玩家，正在从桌面 worktree manager 向可编程控制面扩展。置信度：高。**

- 当前官方仓库提供并行 workspaces、diff review、agent 状态，并公开 remote hosts、CLI、TypeScript SDK、MCP 等入口。
- 对 pi-dag 的直接威胁是“已有用户界面和执行入口，再加上任务治理”，而非已发现同等验收模型。
- 借鉴：同一控制能力同时服务人、CLI 脚本和 agent 工具。来源：[官方仓库](https://github.com/superset-sh/superset)。

**⑲ Emdash——新增玩家，多 provider 与自有远程机器体验值得关注。置信度：高。**

- 官方提供每任务 worktree、issue tracker 导入、diff／PR／CI／merge，支持 SSH／SFTP 远程机器。
- 本地 SQLite 保存 app 状态，部分 agent 通过 lifecycle hooks 支持状态与可恢复 session；未发现任务级依赖或验收账本。
- 借鉴：让用户使用已有远程资源，执行器 hook 与管理层解耦。来源：[官方仓库](https://github.com/generalaction/emdash)。

**⑳ Google Antigravity 2.0——新增且需要高度重视，独立验证角色已产品化为研究预览。置信度：高；可靠性未实测。**

- 官方 2.0 包含动态 subagents、异步任务、JSON hooks、Agent Manager；teamwork preview 进一步明确 Sentinel、Orchestrator、Worker、Reviewer、Critic、Auditor。
- Auditor 负责检查假实现／硬编码等问题，结束前强制最终审计；但公开示例恢复依赖 handoff 文件、自交接和 cron 监控，尚不是 pi-dag 设想的事务式状态与回执系统。
- 借鉴：把“正确性审查”“对抗测试”“证据真实性检查”拆为不同角色。来源：[2.0 官方公告](https://antigravity.google/blog/introducing-google-antigravity-2/)、[teamwork preview 官方说明](https://antigravity.google/blog/google-antigravity-built-an-os/)、[hooks／异步任务说明](https://antigravity.google/blog/google-io-2026-feature-deep-dive)。

**4．整个品类的共同空白，以及 pi-dag 可以显著超越的地方**

这些是基于上述公开能力比较的**研究判断**，不是“全行业不存在”的事实声明。

| 共同空白 | 现有产品已经做到什么 | pi-dag 应做到什么，才能构成显著优势 |
|---|---|---|
| **完成与验收混淆** | task completed、PR ready、agent 自测、另一 agent review | delivered 只能由执行器推进；verified／accepted 必须来自独立验证动作和明确证据 |
| **验收证据缺少可机器判定的适用范围** | 日志、截图、CI 状态、调用结果缓存 | 绑定 tree、base、命令、环境、验证器版本、review 契约；明确何时可复用、何时失效 |
| **隔离替代了所有权管理** | 每 agent 一个 worktree／VM | 检查实际 diff ⊆ write_set；越界必须匹配授权 ruling；保护验收脚本及冻结测试 |
| **任务认领不等于持续写者排他** | task claim lock、unique branch、session ID | Node／Attempt 级唯一写者，恢复与重派时有明确代际边界；旧 attempt 无权继续推进状态 |
| **知识传播没有裁决语义** | AGENTS.md、memory、消息、thread reuse | 有 scope、来源、理由、supersedes；按任务和路径注入，并记录每次派活实际采用的裁决版本 |
| **计划改变后的影响追踪薄弱** | 重写计划、改 prompt、重新运行下游 | 计划／契约／裁决变更引发可解释的 evidence invalidation 与 amendment 待办 |
| **看板展示活动，多于展示可信程度** | running／waiting／done、token、PR | 展示“为何 ready”“凭什么 accepted”“哪些证据过期”“哪些 override 尚未补验” |
| **工作区清理与集成事务脱节** | merge 按钮、session cleanup、队列 | PRE／目标树／结果树／验证／失败现场形成一个可恢复的 Integration 记录 |

**特别要避免把“树哈希复用”做得比竞品看起来严谨、实际仍不充分。** 相同 tree 不代表环境、依赖、测试命令、外部服务和验证器相同；同样，日志哈希只能证明日志没有改变，不能单独证明日志确实由指定命令在指定树上产生。这里的产品优势应是**完整证据契约与可信产生路径**，而不是单个 Git 哈希。

另外，pi-dag 草案自身有一个需要尽早统一的公开契约：示例按前置节点 **integrated** 解锁，而 §3.2 状态图写 deps 全部 **accepted** 即 ready。Gas Town 已公开采用依赖前序工作落到集成分支后启动下一波的流程；pi-dag 必须明确依赖的是“逻辑验收通过”还是“可供下游使用的代码已集成”。

**5．谁最可能做出 pi-dag 的能力**

以下为威胁评估，属于推断。

| 优先级 | 产品／路线 | 为什么构成威胁 | 仍有可竞争的边界 |
|---|---|---|---|
| **最高：直接架构重叠** | **Gas Town** | 任务账本、依赖、持久工作、恢复、集成分支、验证合并队列已连接起来 | 更窄、更确定性的验收内核；写集授权；裁决与证据失效传播 |
| **最高：产品语义接近** | **Factory Missions** | 已把计划、features、milestones、独立 validation workers、Mission Control 产品化 | 公开资料尚缺严格 DAG／所有权／树回执／集成事务契约 |
| **高：可靠执行快速逼近** | **Devin** | Dynamic Workflows 已具备结构化数据流、结果重放、下游重算、多 VM | 当前重放键不是代码验收身份；可在其上另建正确性控制层 |
| **高：原生平台吸收** | **Claude Code** | Task 依赖＋claim lock＋completion hooks 已是足够强的构建原语 | 跨 session／跨 harness 项目账本、强制门禁与裁决谱系 |
| **高：独立验收路线** | **Antigravity** | Reviewer／Critic／Auditor 的职责分离与 pi-dag 目标高度相关 | 研究预览仍以 agent 编排和文件交接为主，可强调确定性保证 |
| **高：平台分发优势** | **GitHub Agent HQ** | 已拥有身份、权限、组织审计、CI、review、merge queue | 项目 DAG 与代码树证据尚未统一；pi-dag 可作为其上游治理层 |
| **中高** | **Codex、Cursor** | 原生模型、庞大执行入口、云与本地工作区、review 产品 | 从线程管理走到不可绕过的项目验收，需要新的公共数据模型 |
| **中** | **Ona、OpenHands** | 前者强环境／企业，后者强可组合执行与持久状态 | 更可能成为合作底座或客户自建平台 |
| **中低但需观察** | **Conductor、Sculptor、Superset、Emdash、Nimbalyst** | 已控制用户每天管理并行 agent 的界面 | 可能通过插件／集成吸收 DAG 能力；不宜与它们只竞争看板 |

**6．矛盾、证据缺口与建议的下一步**

本轮保留的是官方文档、官方公告、官方仓库；公司博客中的性能和成功案例只作为产品方向证据，未当作经独立验证的效果证明。第三方排行榜、竞品营销比较、Reddit 主要用于发现线索，未作为关键能力结论来源。

已解决的矛盾包括：

- **Crystal**：官方确认 2026 年 2 月被 Nimbalyst 替代。
- **Terragon**：官方确认 2026-01-16 为停运快照。
- **Vibe Kanban**：公司关闭与项目继续开源维护同时成立，不能简单写“产品消失”。
- **Sculptor**：第三方的“闭源／纯 Claude wrapper／每 agent 必须 Docker”描述与当前官方仓库不一致，已采用当前官方资料。
- **Devin**：不能再仅按早期“单 session＋子 Devin”评分，Dynamic Workflows 已增加确定性编排与恢复。

剩余缺口主要是**故障语义**：公开文档通常不说明任务认领后进程死亡、网络超时但远端已启动、旧 agent 复活、合并成功但记账失败等情况下是否仍保持唯一写者。也没有对闭源产品完成源码或实际故障测试，因此矩阵不授予“exactly once”“跨机强一致”等保证。

最有价值的下一步是做一套统一的对抗性验收，而非再增加几十个竞品名字：

1. 同一任务并发 dispatch、返回丢失后重试、旧 attempt 恢复，检查是否出现双写者。
2. agent 自报通过但树 dirty、提交改变、测试命令改变，检查状态能否错误进入 accepted。
3. agent 修改未授权文件或验收脚本，检查是否自动拒收。
4. 合并导致树变化、合并后检查失败、记账前崩溃，检查是否安全恢复。
5. 撤销或替代一条路径裁决，检查待派任务和已验收证据如何变化。

优先拿 **Gas Town、Claude Code hooks、Factory Missions、Devin Dynamic Workflows** 做这组实测基线。pi-dag 若能在这些场景中给出可复现、可解释的保证，其优势会比“支持更多并行 agent”更具体，也更难被一个新的桌面看板轻易复制。