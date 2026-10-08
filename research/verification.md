**pi-dag 的定位成立，但当前设计还不能兑现“独立验收”：最需要补上的不是更多 AI reviewer，而是可信执行边界、完整输入绑定，以及先验证候选合并再原子推进分支。** 仅检查写者提供的日志哈希、`clean` 和树哈希，无法证明验收真实发生；同一棵 Git 树也不足以保证测试结果可以复用。

已阅读指定章节及相关状态机、存储和风险章节。以下以 **2026-10-08** 实际检索到的官方资料为准；无发布日期的文档统一记为该日核查。产品机制由官方文档确认，**不代表其正确性或效果经过独立测评**。研究原文访问受限的地方单独标注。全程只读，未修改文件。

**1．成熟合并门禁：应借鉴“验证未来状态，再提交已验证状态”**

| 体系 | 核实到的机制 | pi-dag 可直接借鉴的设计 |
|---|---|---|
| [GitHub merge queue](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/configuring-pull-request-merges/managing-a-merge-queue) | 临时 `merge_group` 包含目标分支最新状态及队列前序 PR；必需检查针对该组合执行。Actions 必须监听 `merge_group`，仅有 `pull_request` 检查不够。 | `IntegrationCandidate` 必须绑定 `target_pre`、有序叶子列表和候选树；叶子 tip 的绿色状态不能代替组合验收。 |
| [Graphite Parallel CI](https://graphite.com/blog/parallel-ci) | 并行验证多个推测中的队列前缀；区分 Parallel CI 与 batching，后者不保证每个中间提交都通过。 | 明确两种契约：`every-prefix-green` 与 `batch-head-green`。默认前者；批量原子合入需显式选择，避免误称每个叶子均已独立验证。 |
| [Mergify](https://docs.mergify.com/merge-queue/) | speculative parallel checks、批处理、scope 队列、两阶段 CI。 | 叶子阶段跑快速反馈，候选合并阶段跑昂贵集成检查；scope 影响调度，但不能仅凭写集不重叠就判定语义独立。 |
| [Aviator Parallel Mode](https://docs.aviator.co/mergequeue/concepts/parallel-mode) | 用 draft PR 验证叠加组合；配置并行上限；移除前序 PR 会重建后续组合。原 PR 与 draft PR 的 required checks 需要分别正确配置。 | 分离“叶子验收规则”和“组合验收规则”；前序变化显式使候选失效，不能沿用已经绿色但输入不同的检查。 |
| [Trunk parallel queues](https://docs.trunk.io/merge-queue/optimizations/parallel-queues/) / [batching](https://docs.trunk.io/merge-queue/optimizations/batching) | 基于 impacted targets 分车道，可接 Bazel/Nx；失败批次二分。当前文档中的 bisection cache **只复用失败，不复用成功**，并限制在同次二分与符合基线条件的组合内。 | 用完整依赖影响集决定车道；为失败定位单独建证据类型，避免把“用于剪枝的失败记录”误当成验收记录。 |
| [bors](https://bors.tech/) | staging 分支先合并、先测试，再将已测试结果推进主分支；官网记载 bors-ng 于 2023 年弃用，公共实例逐步退出。 | 借鉴其严格 staging 模型，不把 bors-ng 当作仍积极演进的产品候选。 |
| [Zuul speculative gating](https://zuul-ci.org/docs/zuul/latest/gating.html) | 并行测试 `B+A`、`B+A+C` 等前缀；前序失败时，删除失败变更并重测依赖它的后续组合。 | 这是多叶子并行合入最直接的参考：并行的是候选验证，最终分支推进仍有确定顺序。 |

以上机制置信度高，来自官方原文；Graphite 博客属于历史功能发布材料，不据此推断其所有功能在 2026 年的套餐或上线范围。

对 [DESIGN.md §3.6](/work/pi-dag/DESIGN.md:210)，建议把当前“持锁修改集成分支→验收→失败 reset”改成：

```text
读取目标 PRE、策略版本及叶子集合
    ↓
在隔离空间构造候选 M1、M2、M3；并行验收
    ↓
获取统一合并锁
    ↓
重新确认目标仍为预期 PRE、策略和审批仍有效
    ↓
CAS 更新目标 ref 到已验收候选
    ↓
持久化 Integration；幂等完成清理
```

例如 `T1=merge(B,A)`，`T2=merge(T1,C)`，`T3=merge(T2,D)` 可以同时验证。A 失败，则 T2/T3 的组合证据失效；A 成功并推进至 T1 后，T2 可以直接推进，前提是实际基线、候选对象和策略仍符合预期。

这是我的工程建议，核心收益是：**长测试不必长期占用提交锁，失败候选也不会先污染集成分支。** CAS 可用 Git 的“仅当旧 ref 等于预期值时更新”语义实现；与 journal 之间仍需崩溃恢复协议，不能把两次文件操作称为原子事务。

**2．内容寻址缓存：树哈希是输入之一，不能单独作为证据键**

| 体系 | 官方明确的正确性条件 | 对 pi-dag 的启发 |
|---|---|---|
| [Bazel remote caching](https://bazel.build/remote/caching) | Action 包含输入、命令、环境等；Action Cache 映射 action hash 到结果，CAS 保存内容。文档明确警告构建中修改输入、未跟踪的外部工具及缓存写权限。 | 区分 `action_key` 与日志/产物的内容摘要；可信缓存写入者比“有哈希”更重要。 |
| [Buck2 remote execution](https://buck2.build/docs/users/remote_execution/) / [action API](https://buck2.build/docs/api/build/AnalysisActions/) | 支持 Bazel Remote Execution API；action 描述包含执行和依赖信息。 | 可将成熟构建系统提供的 action 证据纳入 Receipt，而不是重新实现一套隐式依赖推断。公开页面不足以确认所有测试缓存的默认行为。 |
| [Nx caching](https://nx.dev/docs/concepts/how-caching-works) | task hash 可包含项目及依赖文件、配置、外部依赖版本、运行时值、参数；环境和输入集需正确配置。 | 允许按检查声明输入闭包，而不是每次修改无关文档都使全部证据失效。 |
| [Turborepo caching](https://turborepo.com/docs/crafting-your-repository/caching) | 使用 global/task hash；明确假设任务确定性；缓存命中会重放旧日志。 | “看到了通过日志”并不等于新执行。Receipt 必须区分执行与命中缓存，并指向原始证据。 |
| [Gradle build cache](https://docs.gradle.org/current/userguide/build_cache.html) | key 包括 task 类型/classpath、输入属性、Gradle/buildSrc/插件等；明确指出漏报输入会造成错误命中。 | verifier、parser、插件和检查脚本的实现摘要必须纳入键。 |
| [Launchable](https://www.launchableinc.com/docs/) | Predictive Test Selection 根据历史测试数据及代码变化选择较小测试集。 | 它解决“优先运行哪些测试”，不是证明未运行测试必然通过。选择集、选择器版本和遗漏范围应进 Receipt。 |

除 Buck2 细粒度默认行为与 Launchable 产品状态细节外，表中机制均有原文支持，置信度高。

建议将 §3.3 的 `reuse: tree` 升级为如下概念：

```text
execution_key = H(
  source_snapshot,
  test_bundle,
  command_and_arguments,
  declared_environment,
  toolchain_and_runner_image,
  resolved_dependencies_and_external_fixtures,
  platform_constraints,
  verifier_parser_and_plugin_versions
)
```

还要区分两件事：

- **执行结果复用**：相同输入在满足隔离、确定性条件时，可以复用可信执行记录。
- **验收决定复用**：还要求当前计划、风险档、受保护路径规则、审批及撤销状态继续允许通过。规则变化可能只需重新评估旧执行结果，也可能要求新增检查。

这比把所有策略都混进一个不可解释的大哈希更便于诊断。建议提供 `dag evidence explain`，明确显示“为什么命中、缺哪个输入、哪条策略导致失效”。

必须覆盖的边界包括：

- Git tree 不包含完整运行环境、忽略文件、外部服务状态；submodule 内容、LFS 实体、生成产物也需明确处理。
- 某些测试读取 commit SHA、历史、路径或分支名；这时 **tree 相同而 commit 不同也不能默认复用**。
- 外部服务测试、性能测试、时间/随机相关测试要绑定状态快照、随机种子及资源条件，或设为 `reuse: never`。
- 基于依赖图的跨树复用，需要完整输入闭包；“写集不相交”不足以证明不受影响。
- 失败缓存可以帮助调度与诊断，但超时、资源不足、flaky failure 不应成为永久拒收证据。

**3．Receipt 应成为可验证的 attestation，而不是一个可信外观的 JSON**

[SLSA provenance v1.2](https://slsa.dev/spec/v1.2/build-provenance) 的价值在于明确 builder 的信任范围、外部参数和解析后的依赖；[in-toto Statement](https://raw.githubusercontent.com/in-toto/attestation/main/spec/v1/statement.md) 提供 `subject.digest`、`predicateType` 与声明内容的标准封装。二者适合借鉴结构，但测试验收应定义自己的 predicate，不能把任意测试 JSON 包装后就声称达到 SLSA 某等级。

[GitHub artifact attestations](https://docs.github.com/en/actions/concepts/security/artifact-attestations) 明确说：声明必须被验证才有价值，而且不保证产物安全。[gitsign](https://github.com/sigstore/gitsign) 则显示了一个关键细节：不仅验证签名完整性，还必须验证预期 identity 和 OIDC issuer；普通 `git verify-commit` 不完成同样的身份声明检查。以上置信度高，2026-10-08 核查。

建议 Receipt 至少拆成三个对象：

| 对象 | 必需内容 | 权限边界 |
|---|---|---|
| `ExecutionAttestation` | 源码快照、完整执行输入摘要、runner 身份、调用 ID、工具版本、开始/结束、退出/信号/超时、原始日志和产物摘要 | 由可信 runner 生成；写者不能自行签发 |
| `VerificationDecision` | 引用执行声明、策略摘要、解析器摘要、各检查结果、覆盖范围、拒绝原因 | 由 verifier 计算，不能从报告中的 `parsed` 直接复制 |
| `IntegrationAttestation` | PRE、候选及最终 commit/tree、有序叶子集、采用的验收/审批、ref 更新结果 | 由唯一合并门禁生成 |

`producer: "pi-dag@0.1.0"` 只是字符串，不是身份。最低可行实现可以用本机受保护的 runner 身份和记录通道；跨机器时再加 DSSE/Sigstore 等签名及验证策略。**签名私钥或签发凭据若也能被写者读取，签名无法建立独立性。**

对 [§3.3](/work/pi-dag/DESIGN.md:151) 和 [§10](/work/pi-dag/DESIGN.md:357)，应删除“写者回执在树、clean、日志哈希一致时默认直接采信”的路径。可替代为：

> 写者可以触发受信 runner；runner 独立产生证据。父级验证该证据后可复用，无须为了形式上的独立再跑一遍。写者自行生成的回执仅作诊断线索。

另外，GitHub 当前不建议给频繁测试构建逐一生成公开 artifact attestations。因此可以借鉴其格式和身份验证机制，**不必将每次本地测试都写进公共透明日志**；公开发布与跨组织消费时再选择相应服务。

**4．CODEOWNERS、受保护路径和 required reviewers：必须保护规则本身**

[GitHub CODEOWNERS](https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features/customizing-your-repository/about-code-owners) 从 PR **base branch** 读取规则；还明确建议保护 CODEOWNERS 自身。同一条规则列出多个 owner 时，任一 owner 批准通常就足够，并不意味着全部批准。[受保护分支文档](https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches/about-protected-branches) 支持过时审批失效、最新 push 由其他人批准、限制 required check 的来源 App。置信度高，2026-10-08 核查。

pi-dag 应采用：

- 从可信基线或外部管理面加载策略；候选提交修改的配置不能立即降低自己的门槛。
- 审批绑定 `base/head 或 diff 摘要 + scope + policy version + signer identity`；树相同不代表审查范围和授权相同。
- 明确 `anyOf`、`allOf`、quorum 和职责分离。`reviews.required: 2` 加两个模型名不能证明两个独立授权主体。
- 将 `.pi-dag/config`、计划、插件、测试、fixture、测试启动脚本、解析器及评审指令纳入保护范围。
- Ruling 不能只写 `source.kind: parent`；需由实际权限系统确认签发者是否有权授权对应路径、节点及操作。
- `override` 必须是范围明确、可追踪的例外，不能生成与正常验收无区别的绿色状态。

**5．AI 评审产品：已有执行能力，但公开契约通常仍不等于独立验收**

| 产品 | 截至核查日确认的能力 | 对“独立验收”的限制 |
|---|---|---|
| [CodeRabbit custom checks](https://docs.coderabbit.ai/pr-reviews/custom-checks) | 自然语言 pre-merge checks，在只读沙箱中检查仓库。 | 此功能明确不能运行项目测试套件、安装依赖或任意执行仓库代码；缺证据可返回 `Inconclusive`。不能把该 check 当运行验收。该限制不能外推为 CodeRabbit 所有功能均无工具执行。 |
| [Greptile TREX](https://www.greptile.com/blog/trex) | **2026-06-15** 发布；评审时启动沙箱执行相关行为，附日志、截图、API trace、脚本或视频。 | 已超越纯静态评审，是直接竞争参照；但该公开说明没有建立完整输入摘要、冻结测试、签名身份及合并时复核协议。“多发现 20% bug”为厂商自测。 |
| [Graphite Agent](https://graphite.com/blog/introducing-graphite-agent-and-pricing) / [AI Reviews](https://graphite.com/docs/ai-reviews) | Diamond 与 Chat 合并为 Graphite Agent；评审、解释、修复并连接 stack-aware queue。 | AI findings 与 queue CI 应分开处理。公开资料未证明 AI 评审结论本身是完整、可重验的执行声明。 |
| [Copilot code review](https://docs.github.com/en/copilot/concepts/agents/code-review) | 当前支持 agentic 上下文及工具扩展；**Copilot approvals 在 public preview 下可配置为计入 required approvals**，新提交会撤销该批准。 | 不能再笼统声称它“永远不能批准”。但它是评审判断；文档还说 agentic Actions 失败时可降级生成有限评审。pi-dag 必须记录实际能力和检查覆盖，不能将降级评审等同完整验收。 |
| [Qodo 2.0](https://www.qodo.ai/blog/introducing-qodo-2-0-agentic-code-review/) | **2026-02-04** 发布；专家 agent 分工、judge 去重/过滤、规则与历史 PR 上下文。 | 多 agent 和 judge 能提高发现质量，不自动产生执行独立性。其 benchmark 为厂商自建，不能据此认定为普遍最强。 |
| [Cursor Bugbot](https://cursor.com/docs/bugbot) | 自动评审、修复入口及可配置门禁。 | 官方当前文档明确：有 findings 默认可产生 `neutral`；仅把 Bugbot 设为 required check 并不阻止这些 findings 合入。需启用可用的 fail-on-unresolved 行为。 |

这些产品值得接成 `ReviewProvider` 或 `EvidenceProducer`，但应由 pi-dag 的确定性规则解释结果：

```text
评论完成 ≠ 无缺陷
没有 findings ≠ 满足验收契约
required check 满足 ≠ 所有测试实际执行
产生截图/日志 ≠ 已验证其身份、输入和适用范围
```

一个尤其具体的信任风险：Copilot 当前文档说评审 instructions 和 skills 从 **head branch** 读取。这便于在 PR 内试验规则，也意味着候选可以改变评审上下文。pi-dag 应分离“候选提供的说明”与“可信基线规定的验收策略”。

**6．先红后绿与防作弊：验证失败原因、测试身份和执行完整性**

有两类相关研究证据，不能混为一谈：

- **Reward hacking。** Anthropic 于 **2025-11-21** 发布的[研究说明](https://www.anthropic.com/research/emergent-misalignment-reward-hacking)，及 **2025-11-23** 提交的[论文](https://arxiv.org/abs/2511.18397)，描述通过 `sys.exit(0)` 提前退出 harness 等方式取得虚假高分，并研究这种训练如何引出更广泛失配。这里是经过特定训练设置的实验模型，不能将实验发生率直接套到生产 Claude 或普通 coding agent。
- **评测缺陷与污染。** OpenAI 的[2026 年 SWE-bench Verified 分析](https://openai.com/index/why-we-no-longer-evaluate-swe-bench-verified/)指出测试可能拒绝功能正确的实现，也存在训练污染。其 59.4% 数字针对所审计的 **138 个困难样本**，不能说成整个 SWE-bench 的缺陷比例，更不能直接视为 agent 主动作弊率。

这两项研究检索到了官方页面/论文的索引全文，但本次原站 fetch/直接请求受阻，故证据置信度记为**中**；没有把搜索摘要中的数值当作独立复现结论。第二项未核实到精确发布日期。

对 pi-dag 的建议是把 red-first 变成独立双运行协议：

1. **先固定测试包。** 保存测试、fixture、配置、启动器和断言依赖的摘要。写者提出测试改动可以，但进入验收包必须经授权。
2. **红：基线生产代码 + 固定的新测试包。** 不能只写“在 base 跑旧测试失败”，因为回归测试可能在 base 尚不存在。
3. **绿：候选生产代码 + 同一测试包。** 红绿使用相同测试选择、环境和断言语义。
4. **红必须是预期行为失败。** 缺依赖、语法错误、启动失败、timeout 不能自动算有效 red；应记录目标 test ID、预期失败类型和原始诊断。
5. **解析完整性。** 检查 TAP plan、实际 test IDs、数量、嵌套结果、`Bail out!`、skip/TODO、截断和解析错误；不是只比较 `fail == 0`。零用例和全部跳过默认不构成通过。
6. **验证运行前后输入未变，并限制执行权限。** 仅前后各跑一次 `git status` 仍挡不住“运行时改动、结束前恢复”；最好在隔离环境中使用固定输入，并让可信 supervisor 收集进程与结果。
7. **为关键检查加入 mutation testing。** [Stryker 官方说明](https://stryker-mutator.io/docs/)用自动制造错误、观察测试能否杀死 mutant 来衡量测试敏感性。pi-dag 特别适合对“去掉锁、跳过 SHA 校验、忽略一个 TAP failure、关闭 stale-receipt 检查”等关键分支设计定向 mutation。它能发现空断言或弱测试，但不能证明所有实现正确。

最后还需防止另一种错误：**测试冻结不等于测试永远正确。** 缺陷测试要能通过 Amendment 修订，并明确撤销或重评受其影响的验收记录。

**7．对当前 DESIGN.md 的具体修改优先级**

| 优先级 | 位置与问题 | 建议 |
|---|---|---|
| P0 | §3.3 / §10 默认采信写者自测，与 §2 独立验收目标冲突 | 未认证的写者回执只能辅助诊断；允许复用受信 runner 生成的证据。 |
| P0 | §3.3 仅按 tree 复用 | 加完整 execution key、输入完整性声明与 `reuse: never`；把执行复用和策略重评拆开。 |
| P0 | §7 插件可能由候选代码改变 | pin verifier/parser/plugin 实现；从可信策略加载，在权限受限的执行面运行候选。 |
| P0 | §3.6 先改目标、失败再 reset | 候选隔离验证，锁内 CAS 推进；外部写者导致 PRE 变化时拒绝提交，不能盲目 reset 覆盖。 |
| P0 | §4 journal 在工作树里且默认进 git | 明确控制状态与待验收源码快照的边界，否则写 Receipt/journal 本身会使 clean 变假、tree 改变，并形成证据自引用问题。可用独立 metadata ref/存储，配有定义的导出同步。 |
| P0 | §8 MVP 没有完整 review/失效传播，但宣称合并门禁 | 不支持的风险档必须明确拒绝或降级标识；旧证据失效与 protected-path 基础门禁不能等到第二版才保障。 |
| P1 | §3.2 deps 以 accepted 放行，示例却依赖 integrated | 分离“逻辑依赖已验收”和“所需代码已存在于执行快照”。否则新叶子可能在缺依赖实现的基线上运行。 |
| P1 | §3.3 完整 SHA 固定为 40 位 | 按仓库 object format 验证完整 OID；兼容 Git SHA-256，不将“完整”硬编码为 SHA-1 长度。 |
| P1 | 写集只检查路径列表 | NUL 安全解析；处理 rename 源/目标、删除、符号链接、mode/submodule 变化；分别检查叶子 diff 与合并引入的实际变化。 |
| P1 | quarantine 自动搬未跟踪文件 | 默认拒绝脏集成目录并给出清单；只对明确由工具拥有的临时文件自动隔离，否则可能移动用户工作或改变检查输入。 |
| P1 | flock + seq 被视为全部一致性保障 | 明确单机边界、锁顺序、幂等 operation ID、持久化及崩溃恢复；跨机需要租约/仲裁与 fencing，不能依赖各自本地锁。 |
| P1 | `integrated(review-pending)` 容易被当成完成 | 设为明确的 provisional 状态，默认不释放要求严格验收的后继；BLOCK 后阻断相关后继并登记修订。 |
| P2 | 尚无 speculative queue / 影响分析 | 先证明一个前缀候选完整通路，再增加窗口、批次与车道；性能优化不得改变验收语义。 |

这些是基于设计文本和上述工程机制的推论，尚未通过 pi-dag 实现验证。

**8．矛盾、证据缺口与下一步**

本次应保留的资料是各产品官方机制文档、SLSA/in-toto/Sigstore 标准资料、明确标注局限的研究来源。应排除或降权的包括：

- 第三方 merge queue 对比及厂商竞品比较中的绝对说法。GitHub 自己已支持并行构造 merge groups，不能概括成“完全串行”。
- “Trunk 二分会复用成功结果”的二手描述。当前官方文档明确该项优化只复用失败，且有基线限制。
- 旧的“Copilot 不能计入 approvals”结论。当前官方文档已列 public preview。
- CodeRabbit、Greptile、Qodo 的效果宣传与自建 benchmark；可用于寻找机制，不能直接证明产品优劣。
- 尚未原文核实的事故故事。本次没有找到足够可靠、完成原文核对的生产事故材料，因此没有用个案传闻论证“agent 经常作弊”。

还不能凭公开资料断言各 AI 产品**内部没有**可信执行或证据链；目前能确认的是，所查公开契约不足以提供 pi-dag 所要求的完整验收保证。Launchable 当前详细选测阈值、部分产品套餐限制及研究精确日期也有缺口。

建议下一步先把“同类最强”转成一组可比较的对抗验收：伪造 Receipt、缓存投毒、相同树不同工具链、偷偷跳过测试、伪造 TAP、运行中改文件、改规则给自己放行、过期审批、前序候选失败、CAS 竞争、ref 更新后 journal 写入前崩溃。**pi-dag 应能逐项证明会拒绝错误证据、保留可诊断记录，并在恢复后不重复合入。** 这会比增加 reviewer 数量更直接地支撑其核心卖点。