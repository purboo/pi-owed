**建议保留“dsa 执行、pi-dag 独立验收”的架构，不在第一版引入另一套完整编排框架；但应把 MVP 的中心从“节点状态推进”调整为“有版本的证据、可恢复的副作用操作、受约束的并行写入”。** 现有设计方向与成熟系统一致，关键缺口集中在跨系统提交窗口、不同 attempt 的互斥、证据失效，以及 journal 与 Git 集成的关系。

已阅读 [DESIGN.md](/work/pi-dag/DESIGN.md) 和 [dsa README](/work/pi-conductor/README.md)，未修改项目文件。检索日期为 **2026-10-08**。下文动态文档未标发布日期者，日期均指此次核验日期；不把当前文档 API 等同于所有历史版本都支持。官方机制说明置信度高；厂商实践属于第一方经验，不能直接推出普适性能优势；具体设计建议是基于这些证据的推论。

**1．各框架值得借鉴的机制与映射**

| 框架 | 已核实的具体机制及边界 | 对 pi-dag 的映射 |
|---|---|---|
| **Temporal** | Event History 驱动确定性 replay；副作用放在 Activity；Signal 用于持久化外部输入，Query 只读；`patched()` 在历史中记录版本分支，Worker Versioning 将旧执行绑定到对应代码。当前文档明确警告：2025 年以前的实验性 Worker Versioning 不应继续作为新设计依据。[执行模型](https://docs.temporal.io/workflow-execution)、[版本化](https://docs.temporal.io/develop/typescript/versioning)、[人工交互](https://learn.temporal.io/tutorials/ai/building-durable-ai-applications/human-in-the-loop/) | 将状态计算做成纯 reducer，把启动、答复、合并、清理做成有身份的 operation；记录 `event_schema_version`、`policy_version`、`node_revision`。规则更新不能静默改写旧历史的含义。 |
| **Restate** | invocation journal 保存步骤结果；请求幂等键去重；Virtual Object 按对象提供单写者状态更新。Saga 示例**先登记补偿，再执行动作**，失败时逆序补偿，补偿本身也通过 durable steps 执行。[核心概念](https://docs.restate.dev/foundations/key-concepts)、[Saga](https://docs.restate.dev/guides/sagas) | 以 Node/Integration 为并发控制对象；把 `merge` 拆成可恢复阶段，先保存恢复依据。不要将“catch 后 reset”当作完整补偿协议。外部 Git/进程副作用仍须自行处理不确定结果。 |
| **DBOS** | 调用方指定 workflow ID 作为幂等键；步骤至少尝试一次，已完成步骤不重执行；数据库事务恰好提交一次。`send(destinationID, message, topic?, idempotencyKey?)` 支持持久消息去重；`recv` 消费消息。特别区分：workflow 内写 stream 恰好一次，step 内写 stream 可能重复。[Workflows](https://docs.dbos.dev/typescript/tutorials/workflow-tutorial)、[通信](https://docs.dbos.dev/typescript/tutorials/workflow-communication) | 区分“启动键”“命令键”“外部 effect 键”；answer/follow-up 也需要调用方幂等键。事件能重放不代表来源不会重复。不能把数据库事务的保证延伸到 Git、挂载或外部 API。 |
| **Inngest** | event `id` 与函数 `idempotency` 分别控制生产端、消费端去重，当前文档均为 **24 小时窗口**；`step.waitForEvent` 通过事件条件及 timeout 等待外部输入。官方明确要求外部服务另传稳定操作键。[幂等](https://www.inngest.com/docs/guides/handling-idempotency)、[等待事件](https://www.inngest.com/docs/reference/functions/step-wait-for-event) | dsa D1 必须写清保留期和 prune 后行为，不能只写“重复返回同一个 wid”。历时数周的节点不能依赖一天去重窗口。审批关联用准确 qid/operation ID，不能只按 node 名称匹配。 |
| **LangGraph** | checkpointer 持久化图状态；`thread_id` 标识恢复线程；`interrupt()` 暂停，`Command(resume=...)` 恢复。**恢复会从包含 interrupt 的 node 开头重跑**，之前的副作用需要幂等。[持久执行](https://docs.langchain.com/oss/python/langgraph/durable-execution)、[interrupt](https://docs.langchain.com/oss/python/langgraph/interrupts) | 把“提问/审批已登记”和“批准后执行”分开。不能在审批前段放一个无幂等保护的 dsa `run` 或 Git 操作；checkpoint 是恢复位置，不是外部效果的事务边界。 |
| **OpenAI Agents SDK** | 工具声明需要 approval；结果返回 interruption；`RunState` 支持暂停状态序列化、approve/reject 后恢复，覆盖 handoff 和嵌套 `Agent.as_tool()`。[HITL](https://openai.github.io/openai-agents-python/human_in_the_loop/) | 借鉴独立、可保存的 PendingDecision：关联工具/操作、参数摘要、批准或拒绝及恢复状态。由宿主负责持久化、认证和重复请求处理；该机制本身不是项目 journal 或 Git 集成协议。 |
| **Claude Agent SDK** | session 自动记录对话、工具调用及结果；明确区分 continue、指定 ID resume、fork。官方强调：**session/fork 保存和分叉的是对话，不是文件系统**。当前文档还注明实验性 TS V2 session API 已在 `0.3.142` 删除。[Session](https://platform.claude.com/docs/en/agent-sdk/sessions) | Attempt、Generation、Session、Worktree 必须分开建模；fork 不能被当成工作区隔离。并发环境只用精确 session ID 恢复，不依赖“当前目录最近一次会话”。 |
| **Microsoft Agent Framework / AutoGen** | 官方定位 Agent Framework 为 AutoGen 与 Semantic Kernel 的直接后继。workflow 按 superstep checkpoint，保存 executor 状态、待发消息、待答请求；恢复须保持拓扑和 executor identity。Python `1.13.0` 增加入站 checkpoint。HITL 按 request ID 恢复，pending request 恢复后会再次发出。[概览](https://learn.microsoft.com/en-us/agent-framework/overview/)、[checkpoint](https://learn.microsoft.com/en-us/agent-framework/workflows/checkpoints)、[HITL](https://learn.microsoft.com/en-us/agent-framework/workflows/human-in-the-loop/)；概览/HITL 更新 **2026-08-25** | 不再仅以旧 AutoGen group chat 作为比较基线。借鉴稳定执行身份、pending request 入快照，以及**恢复后的通知去重**。拓扑修订必须有兼容规则，不能把新 plan 无条件套到旧 checkpoint。 |
| **CrewAI** | Flow 有结构化 state、`@start/@listen/@router`；`@persist` 默认 SQLite，支持按 UUID 恢复及 fork；`@human_feedback` 要求 `≥1.8.0`。文档示例可用 LLM 将自由文本反馈分类为批准、拒绝等。[Flows](https://docs.crewai.com/en/concepts/flows) | 借鉴类型化状态、显式分支和恢复/fork 区别。**不建议复制用 LLM 判断硬审批结果的做法**：pi-dag 的 override、跨写集授权应使用结构化枚举与准确作用域。状态快照不能替代 effect journal。 |
| **Dagster** | `code_version` 与上游 `DataVersion` 构成资产版本；可显式提供输出的数据版本。代码变了但输出版本不变时，下游可以保持有效。默认不指定 code version 会以 run ID 表达新版本；“Unsynced”并非无条件传递。[版本与缓存](https://docs.dagster.io/guides/build/assets/asset-versioning-and-caching) | 将任务完成与**产物/证据版本**分离；记录下游实际消费的依赖版本。Amendment 应沿证据谱系传播失效，而不是只按节点状态或全仓树变化决定。初版宜保守重验，后续再做细粒度复用。 |
| **Prefect** | 缓存键可组合输入与 task source；默认 `READ_COMMITTED` **允许相同键的任务并发执行**；`SERIALIZABLE` 配合 lock manager 才提供同键互斥。支持暂停/挂起流程等待类型化输入。[缓存隔离](https://docs.prefect.io/v3/advanced/caching)、[交互流程](https://docs.prefect.io/v3/advanced/interactive) | “结果能复用”“请求能去重”“写者互斥”是三个不同契约。对同一个 node 还要有原子占用和所有权检查；跨进程锁不能用仅进程内的锁替代。 |

这组机制不能简单合并成“exactly once”。**持久引擎可以确保已记录的决定不重复应用，但外部动作成功、记录失败的窗口依然存在。** dsa README 已明确承认该边界，并提供 `once: true → unknown` 的处理方式；pi-dag 应保留这个诚实的语义，而不是把 unknown 压成普通 failed。

**2．并行改同一仓库：成功与失败证据**

| 来源、日期 | 直接证据 | 支持或挑战 pi-dag 的地方 |
|---|---|---|
| [Cognition：Don’t Build Multi-Agents](https://cognition.com/blog/dont-build-multi-agents)，**2025-06-12** | 不同写者即使接受相同任务，也会形成未显式沟通的设计决定；输出各自合理，组合后却不一致。主张共享上下文，重视动作隐含的决定。 | 支持 Ruling、共同契约、父级裁决；挑战“写集不重叠就足够独立”。 |
| [Cognition：What’s Actually Working](https://cognition.com/blog/multi-agents-working)，**2026-04-22** | 更新后的实践认可 generator/reviewer、强模型顾问和 manager/children，但仍主张写入单线程、其他 agent 提供分析。其 clean-context reviewer 有效，评审发现还须结合原任务上下文过滤。 | 强烈支持独立评审和父级最终决定；不支持把“多写者 swarm”作为默认优越架构。此文不能概括成 Cognition 已撤回原先警告。 |
| [Cursor：Scaling long-running autonomous coding](https://cursor.com/blog/scaling-agents)，**2026-01-14** | 平权 agent 通过共享文件加锁失败：锁占用过长、忘记释放、重复拿锁、绕过锁；20 个 agent 的有效吞吐降到约 2–3 个。改成 planner/worker/judge 后扩大到数百并行 worker。独立 integrator 角色后来因瓶颈移除；Solid→React 迁移当时仍需仔细审查。 | 支持角色分工、自动记账和明确任务边界；挑战全局长锁和所有工作串行经过一个 LLM 集成人。其案例证明可推进大工程，不证明所有产物已达到生产质量。 |
| [Anthropic：Building a C compiler](https://www.anthropic.com/engineering/building-c-compiler)，**2026-02-05** | 16 个 agent，各自容器和本地 clone，经共享上游协调；约两周、近 2,000 会话、约 $20,000，产出约 10 万行编译器。进入 Linux 构建时所有 agent 撞同一个缺陷、互相覆盖，16 路不再有帮助；用 GCC oracle 拆出独立失败子集后恢复并行。仍存在成对交互错误、回归和性能限制。 | 最直接支持“隔离工作区＋强 oracle＋可独立验收子问题”。同时说明 DAG 的价值首先在正确拆分，而不在槽位数量。 |
| [Anthropic：Multi-agent research system](https://www.anthropic.com/engineering/multi-agent-research-system)，**2025-06-13** | 内部研究评测提升 90.2%，但多 agent token 用量约为普通 chat 的 15 倍；明确指出多数编码任务比研究任务更难并行。工程采用 checkpoint、恢复和新旧版本共存部署。 | 支持并行只读研究；不能拿 90.2% 当作并行编码收益预测。支持 dsa 执行版本与 pi-dag 策略版本分离。 |
| [Anthropic：Effective harnesses](https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents)，**2025-11-26** | compaction 本身不足；initializer 建立 feature list、初始化脚本和进度记录，后续一次推进一个特性，保持可接手状态，用端到端测试防止过早宣布完成。 | 直接支持结构化计划、handoff、行为验收和 `delivered ≠ accepted`。 |
| [OpenAI：Using PLANS.md for multi-hour problem solving](https://github.com/openai/openai-cookbook/blob/main/articles/codex_exec_plans.md)，动态原文，**2026-10-08 核验** | 报告类似计划支持一次提示超过七小时执行；要求自包含的活文档、Decision Log、独立可验证里程碑、明确恢复步骤和可观察的用户行为。 | 支持将计划、裁决、证据变成持久产物；它是长时工程方法，未证明并行写者数量带来收益。 |

学术证据补充了失败分类，但外推需要克制：

- **[MAST：Why Do Multi-Agent LLM Systems Fail?](https://arxiv.org/abs/2503.13657v3)**，2025-03-17 首版、**2025-10-26 v3**：1,600+ 标注轨迹、7 个框架，14 类失败归入系统设计、agent 间失配和任务验证三类。它支持 pi-dag 的职责边界、信息传递和验证门禁；**不是针对现代 worktree 并行编码的随机对照研究**，不应从它推导一个通用仓库冲突率。置信度：论文数据描述高，对 pi-dag 收益预测中低。
- **[Towards a Science of Scaling Agent Systems](https://arxiv.org/abs/2512.08296v3)**，2025-12-09 首版、**2026-04-08 v3**：最新版是 260 种配置、6 个 benchmark；相比单 agent，结果从可分解金融推理的 +80.8% 到顺序规划的 −70%。集中验证较能限制错误传播。**旧版的 180 配置、4 benchmark 和不同回归指标不能混用**；论文也不是同一共享工作区多写者的直接实验。置信度：方向中高，具体工程阈值低。
- **[MetaGPT](https://arxiv.org/abs/2308.00352v7)**，最新论文版本 **2024-11-01**：把 SOP、角色分工和中间结果验证编码进协作流程。**[ChatDev](https://arxiv.org/abs/2307.07924v5)**，最新论文版本 **2024-06-05**：通过 chat chain 和沟通式纠错连接设计、编码、测试。这些是有价值的历史基础，不应包装成 2026 年大仓库可靠性验证。可借鉴的是**产物契约和阶段门禁**，不是照搬“产品经理、架构师、工程师”角色名称。

综合这些来源，较稳健的共同观点是：**并行搜索、独立评审和真正可分解的实现任务值得做；共享决策密集、验收弱或强顺序依赖的任务应减少写者。** 业界对并行编码仍有分歧，没有形成“统一采用多写者”的共识。

**3．对 §3.2 状态机的具体改进**

**P0：先修复状态含义和并发不变量。**

1. **依赖门槛不能统一写成 `accepted`。**  
   §0.5 的例子等待上游 integrated，§3.2 却写 deps 全部 accepted。若下游 worktree 从集成分支创建，上游 accepted 但未合入时，代码可能根本不可见。建议依赖边声明 `requires: integrated | accepted-artifact | external-receipt`，代码依赖默认 integrated；派活记录实际消费的 commit、产物摘要和证据版本。

2. **将执行、证据、集成状态分开。**  
   不必把所有组合塞进一个 enum。至少分别表达：
   - execution：pending / active / waiting / stopping / ended / unknown；
   - evidence：missing / valid / rejected / stale；
   - integration：absent / preparing / committed / validated / repair-required。  
   
   `asking` 不应抹掉已有交付信息；`parked` 是调度意图，不证明进程已停止；`integrated(review-pending)` 不能被普通 integrated 查询误认为依赖已满足。

3. **“同一 attempt 去重”与“同一 node 只有一个有效写者”分别保证。**  
   `...:a1` 和 `...:a2` 是不同幂等键，完全可能同时启动。必须在 journal 锁内，基于 node revision 原子登记 active attempt；尚未证明旧写者停止时禁止新写者接管同一 worktree。asking、暂停和停止中都不能自动释放写者身份。

4. **新增 `dispatching`、`stopping`、`outcome-unknown` 等可恢复中间事实。**  
   dsa 已接受启动但调用方超时，应查询原 key，不能生成新 attempt。`stop requested` 与 `stopped confirmed` 分开；旧 generation 的迟到 sealed 事件只更新历史，不能覆盖当前代。

5. **审批绑定批准对象的版本。**  
   保存 `decision_id/qid`、node revision、attempt/generation、操作及参数摘要、tree、批准者、作用域、失效条件。同意 a1 的 merge，不能顺便授权修改后 a2 的 merge。Ruling 可以长期有效，但应明确它是持续规则还是一次性批准。

6. **裁决更新要影响正在运行的节点。**  
   当前只在派活时注入，无法处理“兄弟节点刚发现一个全局契约变化”。记录 `rulings_seen_at_dispatch`；新裁决命中 active 节点时，形成 pending notification/ack，必要时阻止验收。不是每次新裁决都必须重启 agent，但不能静默遗漏。

**4．对 §4 存储与证据的具体改进**

**P0：补出一个完整的提交与恢复协议。**

- **唯一真相须包括 plan 的完整来源。** 每个 `plan.revised` 必须能从初始定义重建当前节点，或引用不可变、内容寻址的 plan revision；否则可编辑的 `plan/` 与 journal 是两份真相。`config`、风险档、verifier/plugin 版本也要进入证据身份。
- **事件包建议至少包含：**

  ```text
  project_id, journal_epoch, seq, event_id, schema_version,
  node_id, node_revision, attempt_id, generation,
  operation_id, causation_id, source_event_id,
  policy_digest, payload_or_ref
  ```

  `seq` 表达单日志顺序；`event_id` 表达身份。跨机器合并不能通过重新排序 seq 自动获得业务一致性。

- **文件锁必须保护“读最新状态→检查前置条件→分配 seq→追加并持久化”。** 只锁最后一次 append，仍会让两个进程依据过期状态各自合法启动。
- **定义断电语义。** 回执先写临时文件、持久化、原子 rename，再追加引用；journal 的成功返回要对应明确的持久化边界。区分尾部不完整记录与中段损坏；快照带 `last_seq` 和摘要，只作加速，重放不能重新执行副作用。
- **用 journal 实现 outbox/inbox。** 先写 `operation.requested`，再调用 dsa，最后写结果；恢复时枚举未完成 operation，以相同 key 查询/重试。消费 dsa 事件时，将来源身份与派生事实一起落盘，游标不得领先于已持久事件。
- **D2 不一定非要跨全部 workflow 的全球 seq。** `(dsa_instance_epoch, wid, local_seq)` 的游标集合也能可靠恢复。全球游标方便，但保留期、缺口检测、分页上界和 snapshot 对账比“全球递增数字”更重要。

**最容易遗漏的问题是 journal 与被验收代码放在同一 Git 树。**

如果 verify 写入受 Git 跟踪的 `.pi-dag/journal.jsonl`，工作区会变 dirty；提交回执又会改变整棵 Git tree；把 tree 写进新回执再次改变 tree，形成自引用问题。`reset 到 PRE` 还可能倒退作为唯一真相的 journal。

建议**保持 journal 只追加，但使用独立元数据分支/工作区保存和同步**，不让它成为受验收源码树的一部分。每个项目只有一个权威元数据写入位置，所有代码 worktree 都连接它；否则每个 worktree 各自 flock 各自日志并不能互斥。第一版多机应明确为“单权威写者＋交接”，两台机器各自写不同节点仍会冲突于全局日志和共享裁决。

**证据缓存应借鉴 Dagster，但先保守实施。**

建议复用键至少覆盖：

```text
source_tree + acceptance_spec + verifier/plugin_digest
+ environment/toolchain_digest + dependency_versions + policy_version
```

相同源码树只是必要条件之一。日志哈希只能证明内容一致，不能证明测试确实针对那棵树运行。因此 §10 默认采信写者自测，若只核对 hash/tree，达不到 §0 所承诺的独立判断。可接受的低成本折中是：**测试由可信 runner 记录不可变输入和结果，写者可以触发，pi-dag 独立验证 provenance**；否则标记为自述证据，高风险复跑。不同进程运行同一个可被写者修改的检查器，也不构成充分独立性。

**5．对 §5 dsa 接口及 merge 的具体改进**

建议把窄接口收敛为五类能力，字段只是契约建议：

| 能力 | 必须补充的语义 |
|---|---|
| `run(key, spec_digest, …)` | 相同 key、相同 spec 返回原执行；相同 key、不同 spec 明确报冲突。定义终态保留、prune tombstone 和项目 UUID 命名空间。 |
| `command(command_id, target_generation, …)` | answer、follow-up、stop 都去重；answer 指定 qid；follow-up 返回确定的 generation。不能因响应丢失重复开新一代。 |
| `events(cursor)` | 返回来源 epoch、稳定 event ID、schema、下一游标及 high-water mark；明确 retained-from，缺口不能静默跳过。 |
| `describe(key)` | 给出全代谱系、精确执行版本、结构化 report、canonical cwd、写者所有权及清理状态，供断连后对账。 |
| `reconcile/stop` | 显式返回 stopping、confirmed-stopped、unknown；模型会话结束不等于所有工具子进程结束。 |

D4 的写者互斥应提高到**正确性前提**。由 dsa 实现最合适；若第一版没有，应限制到已证明旧进程停止后才能重新派发的隔离工作区。短命 CLI 持有的 flock 不能自动代表整个后台写者生命周期；仅租约超时也不能阻止失联旧进程继续写。fencing token 只有在真正的写入边界被检查才有效，不能靠在状态文件中加一个数字获得该保证。

`merge` 建议按可恢复事务处理：

1. 登记 `integration.requested`，固定 source tip、目标 PRE、策略和 operation ID。
2. 在隔离临时工作区生成候选 merge，先记录 candidate SHA，再运行检查。
3. 测试可并行；发布时拿短锁，确认目标仍为 PRE，以 compare-and-swap 更新目标引用。目标已变化则重建候选并按证据规则重验。
4. 写 `integration.committed/validated`，随后清理；清理失败进入 `cleanup-pending`，不抹掉已完成集成。

如果 crash 发生在目标引用已更新、journal 未记录之间，恢复器检查 candidate 和目标状态，补记事实；不能重新执行一次盲目 merge。补偿也必须有前置条件：只有目标仍指向本次候选且无后续改动时才考虑回退；否则保留现场或产生修订，不能无条件 reset。

此外，自动搬走所有未跟踪文件会干预其他工作。宜默认拒绝脏集成区；quarantine 仅对明确授权且记录清单、可恢复的文件执行。采用临时集成工作区后，这个问题通常更小。

不常驻仍然可行，但必须写清**谁触发下一次 reconcile**：CLI 调用、dsa 完成回调、pi 会话恢复 hook，或外部定时调用。截止日期已记录并不代表无人调用时会自动触发；看板应显示 `observed_at` 和已消费 high-water mark。

**6．是否采用现成框架作为底座**

| 选择 | 建议 |
|---|---|
| **dsa＋自有事件 reducer/operation 协议** | **第一版首选。** 保持现有执行投资和不常驻约束；重点补接口与恢复契约，避免复制调度器。 |
| **Restate** | 若未来接受常驻服务和多机，最值得做第二底座原型：对象单写者、journal、幂等 RPC 与 Saga 接近需求。但不能替代 Git 所有权及独立验收。 |
| **Temporal** | 适合团队已部署 Temporal，或需大量跨服务、跨天执行与版本运维的场景。对本地 pi 包而言引入服务、worker 和第二套执行历史，成本较高；若采用，应重新划定它与 dsa 的执行职责。 |
| **DBOS** | 已有数据库、愿将事务存储作为运行时真相时是较轻的候选。若坚持 JSONL 唯一真相，再引入 DBOS 权威状态会增加一致性边界。 |
| **Inngest** | 适合 webhook/serverless 产品化；不能直接满足本地长期幂等、Git 状态与工作区约束。 |
| **LangGraph、Agent Framework** | 适合实现某个 planner/reviewer 的内部流程，不宜同时接管整个项目 DAG 的权威状态。 |
| **OpenAI/Claude SDK、CrewAI** | 可作 agent 执行或交互适配层；对已有 dsa 的 pi-dag，不能消除当前最重要的存储与验收工作。 |
| **Dagster、Prefect** | 值得借鉴 lineage、缓存隔离、失效与人工输入；若项目本身以数据资产/批处理为主可直接采用，代码集成场景则会引入较多异类抽象。 |

**7．矛盾、缺证与下一步**

保留的核心来源是上述官方文档、原始工程文章和带版本的论文。舍弃了将所有 durable 框架概括为“外部副作用 exactly-once”的二手比较文章、Cognition 镜像，以及未核查的社区转述。后续搜索服务一度不可用，部分原站通过直接 HTTP 补读成功；OpenAI [Harness engineering](https://openai.com/index/harness-engineering/) 原页持续返回 403，因此没有把搜索摘录作为核心论据，改用已读取的官方 Cookbook 原文。

目前仍缺三类关键证据：

- 没有研究证明 **pi-dag 式约束＋独立验收** 相对单写者，在你们目标仓库上净收益为正。
- 厂商案例大多没有同任务、同预算的可靠对照，行数、token 数和成功 demo 都不能替代净吞吐。
- 本次核实了当前机制和重要 2026 更新，没有对每个框架每个 SDK 做 release-by-release 实测；正式选型仍须固定版本验证恢复语义。

下一步应先做两个小而严格的验证集：

1. **故障恢复验收**：dsa 接受 run 后断连、answer 响应丢失、事件重复/迟到、journal 尾部断写、merge 更新引用后崩溃、停止未确认、旧裁决审批、dsa prune 后对账。每项同时验证“不重复产生效果”和“不会虚报完成”。
2. **并行收益对照**：对契约稳定和耦合较强的两类任务，比较 1/2/4/8 写者；衡量 accepted/integrated 吞吐、集成失败率、返工、父级干预时间、成本及 escaped defects。

这两组结果可以决定哪些任务允许更多写者，以及是否值得增加第二套基础设施；它们比继续扩大框架功能清单更能检验“同类最强”的目标。