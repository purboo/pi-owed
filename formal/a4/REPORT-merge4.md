# a4 merge 单判据检验回执

已由固定诊断重放否定“与 a3 完全等价”：旧键 owner 免可经肯定引用链跨键清除判断否定，NoBypassedNegative 在 a3 通过、a4 违反。计划检查已完成；契约未修改，待父级裁决。

当前模块 SHA256：`241c794985fbbc7942f1c89dec7726e4b833bf276698cf2ed85a78bf42b3959b`。当前完整固定比较 234/234 对，性质结果分歧 0 对。全部计划检查覆盖见 [coverage.json](runs/PiDagMerge4-coverage.json)。

## 语义与范围

从 a3 复制模型；a22/a3 由 `A4 = FALSE` 保留原动作。新增变量 `ledger4` 在这些模式恒为 `<<>>`，只增加常量投影，不增加转移。a4 的断言历史是环境历史的确定性投影，签发时引用当时的完整前缀；较晚否定不会被补入旧断言 premises。创世观察在实际创世事件位置展开。`Projection4` 独立检查物化投影等于完整重建。

`Counts(a,t)` 唯一组合 Authorized、Informed、Recused。项按节点、义务种类、键区分；Rel1 收集同节点同义务任意键否定和同项历史，判断否定按引用及档位清除，执行否定按原键归因清除，原键重跑 pass 产生冲突。合入只从 Counts 的当前视图计算项状态；既有 x.sealed / f.blocks 仍作为 a3 比较状态保留，但 a4 准入不读它们。缓判的 subject 是 no-new-debt 变更义务，不是状态项，Informed 没有缓判特判。

名字前值使用 a3 既有 epoch / exact-PRE 位的有限商；Rel2 检验前值。Rel3 递归检查变更各项的当前 Counts。契约“指针”段另要求变更成和不增欠，因此 Merge4 保留这两个外部条件；不为制造消融翻转删掉它们。

原有独立参考谓词至模块结束的字节全部一致；性质不调用新准入守卫。[保真审计](runs/PiDagMerge4-audit.json) 还确认 check.sh 精确复制，且原 a3 记录可比的 27 项结果与 distinct 状态数全部保持。状态回执按 Counts 的有效视图记录；已提交回执不会随晚到否定重写。执行器、评审者、owner 与内容/检查闭包作者和历任写者槽主体分离，沿用 a3 环境前提；不增加未经授权或自审主体来制造翻转。

## 固定场景逐性质比较

每格为 **a3 / a4**。H=穷举通过；V=存在反例；RUN/—=尚未完成。13 个固定脚本 × 18 个适用性质 × 2 模式，共 468 次独立 TLC。自由专用谓词及 FreeNoTwoMerges 只在自由场景检查，避免在 `f = [unused |-> TRUE]` 上制造类型错误。GoodEventuallyMerges 的公平调度仅为 live 场景给出，其他场景的 V 不能解释为契约活锁。

| 性质 | launderTest | launderReview | rerun | flakyDebt | matrix | genesis | falsePass |
|---|---|---|---|---|---|---|---|
| NoBypassedNegative | H / H | H / H | H / H | H / H | H / H | H / H | H / H |
| EscapeAttributable | H / H | H / H | H / H | H / H | H / H | H / H | H / H |
| NodeAcceptanceCovered | H / H | H / H | H / H | H / H | H / H | H / H | H / H |
| NewEscapeAttributable | H / H | H / H | H / H | H / H | H / H | H / H | H / H |
| NoLaundering | V / V | H / H | V / V | H / H | H / H | H / H | H / H |
| NoFlakyRerunEscape | H / H | H / H | H / H | H / H | H / H | H / H | H / H |
| NoNewBreakage | H / H | H / H | H / H | H / H | H / H | H / H | V / V |
| JudgedAtCommit | H / H | H / H | H / H | H / H | H / H | H / H | H / H |
| GenesisBeforeAdvance | H / H | H / H | H / H | H / H | H / H | H / H | H / H |
| StateNeverWaived | H / H | H / H | H / H | H / H | H / H | H / H | H / H |
| DeferredDebtVisible | H / H | H / H | H / H | H / H | H / H | H / H | H / H |
| LeaseExcludes | H / H | H / H | H / H | H / H | H / H | H / H | H / H |
| NothingMerged | V / V | V / V | V / V | H / H | H / H | H / H | V / V |
| NoDeferredMerge | H / H | H / H | H / H | H / H | H / H | H / H | H / H |
| NoOwnerWaivedMerge | V / V | V / V | V / V | H / H | H / H | H / H | H / H |
| NoUnrelatedMerge | V / V | V / V | V / V | H / H | H / H | H / H | V / V |
| NoOldDebtMerge | V / V | V / V | V / V | H / H | H / H | H / H | H / H |
| GoodEventuallyMerges | V / V | V / V | V / V | V / V | V / V | V / V | V / V |

| 性质 | defer | oldDebt | waiver | race | good | live |
|---|---|---|---|---|---|---|
| NoBypassedNegative | H / H | H / H | H / H | H / H | H / H | H / H |
| EscapeAttributable | H / H | H / H | H / H | H / H | H / H | H / H |
| NodeAcceptanceCovered | H / H | H / H | H / H | H / H | H / H | H / H |
| NewEscapeAttributable | H / H | H / H | H / H | H / H | H / H | H / H |
| NoLaundering | H / H | V / V | H / H | H / H | H / H | H / H |
| NoFlakyRerunEscape | H / H | H / H | H / H | H / H | H / H | H / H |
| NoNewBreakage | H / H | H / H | H / H | V / V | H / H | H / H |
| JudgedAtCommit | H / H | H / H | H / H | H / H | H / H | H / H |
| GenesisBeforeAdvance | H / H | H / H | H / H | H / H | H / H | H / H |
| StateNeverWaived | H / H | H / H | H / H | H / H | H / H | H / H |
| DeferredDebtVisible | H / H | H / H | H / H | H / H | H / H | H / H |
| LeaseExcludes | H / H | H / H | H / H | H / H | H / H | H / H |
| NothingMerged | V / V | V / V | H / H | V / V | V / V | V / V |
| NoDeferredMerge | V / V | H / H | H / H | H / H | H / H | H / H |
| NoOwnerWaivedMerge | H / H | H / H | H / H | H / H | H / H | H / H |
| NoUnrelatedMerge | V / V | V / V | H / H | V / V | V / V | H / H |
| NoOldDebtMerge | H / H | V / V | H / H | H / H | H / H | H / H |
| GoodEventuallyMerges | V / V | V / V | V / V | V / V | V / V | H / H |

全部状态数、轨迹步数、种子、模块 SHA 与日志名见 [逐项结果](runs/PiDagMerge4-results.tsv)。每次固定安全检查使用单 worker BFS，因此违例日志给出该性质的最短有限反例；时间性质的循环反例不宣称全局最短。

## 分歧、最短轨迹与契约问题

已完成的固定性质结果没有 H/V 翻转。这个结论只涉及这些性质，不能据此宣称两个转移系统行为等价。

### 固定诊断重放 replayWaiverCitation

| 性质 | a3 | a4 |
|---|---|---|
| DeferredDebtVisible | H | H |
| EscapeAttributable | H | H |
| FreeCoreSafety | H | V |
| FreeNoTwoMerges | H | H |
| GenesisBeforeAdvance | H | H |
| JudgedAtCommit | H | H |
| LeaseExcludes | H | H |
| NewEscapeAttributable | H | H |
| NoBypassedNegative | H | V |
| NoDeferredMerge | H | V |
| NoFlakyRerunEscape | H | H |
| NoLaundering | H | V |
| NoNewBreakage | H | H |
| NoOwnerWaivedMerge | H | H |
| NodeAcceptanceCovered | H | H |
| NothingMerged | H | V |
| StateNeverWaived | H | H |

**已确认的安全分歧，分类 (c)：a3 K1 的免按项生效，不能由当前“引用另一条肯定”的 Informed 清除规则保持。** 在 a4，判断否定的清除替代分支包括所有肯定，契约明确把免定义为“无执行的肯定”。沿用 a3 事件中的 owner 档位 3，它能被新键的低档肯定引用；旧键的免因此变成跨键判断解封。a3 的免仍只覆盖原项，原高档否定没有撤回，所以阻止合入。新键没有 owner 免，NoBypassedNegative 从 H 变 V。

完整最短轨迹（该固定重放的 BFS 最短，9 次转移）：创世 → 原键准确 rank-2 fail → 原键 owner 免 → 换到仍坏的新键 → 新键错误 rank-1 pass 引用旧免 → 新键状态缓判 → 入队 → 求值 → 提交。末回执 truth=FALSE、waived=FALSE、deferred=TRUE、debt=TRUE、nodeDebt=FALSE；旧免集合只有 <<k0,0>>，提交键为 <<k0,1>>。

证据：[a3 NoBypassedNegative](runs/PiDagMerge4-a3-NoBypassedNegative-diagnostic-replayWaiverCitation.log)、[a4 NoBypassedNegative](runs/PiDagMerge4-a4-NoBypassedNegative-diagnostic-replayWaiverCitation.log)、[完整最短轨迹](runs/PiDagMerge4-waiverCitation-shortest.md)、[TLC 状态图](runs/PiDagMerge4-waiverCitation-evidence.dot)。TLC 的文本反例只打印到入队，不能把那 7 步当作完整反例；图含求值和违例提交，离线 BFS 从全部 4 个初态恢复 9 步路径。

拟议修订（未实施）：需要明确“另一条肯定”是否排除按项授权的免，或要求此类免的主语键与当前肯定相同；这会增加 a3 K1 的局部性约束，不能在编码中悄悄只接收 observe/pass。父级也应确认 owner 的档位是否可作判断证据传递；这里使用原 a3 免事件已有的 rank=3。

**执行类 owner 免：分类 (c)，a3 K2 的 owner 风险接受例外不能从当前 a4 Informed 推出。** Authorized/Witnesses 只说明 owner 有权签免，不能令执行否定自动满足原键重跑条件。固定 launderTest、rerun 的 NoOwnerWaivedMerge 在两模式都可 V，但 a3 的最短见证为 8 次转移：创世→启动→原键 fail→换键→当前观察→owner 免→求值→提交；a4 最短为 9 次转移，必须在换键后增加原键 fail 归因。原来的“未归因仍知情接受风险”的见证已丢失。

证据：[a3 launderTest 最短见证](runs/PiDagMerge4-a3-NoOwnerWaivedMerge-matrix-launderTest.log)、[a4 launderTest 最短见证](runs/PiDagMerge4-a4-NoOwnerWaivedMerge-matrix-launderTest.log)、[a3 rerun](runs/PiDagMerge4-a3-NoOwnerWaivedMerge-matrix-rerun.log)、[a4 rerun](runs/PiDagMerge4-a4-NoOwnerWaivedMerge-matrix-rerun.log)。这里比较的是带 owner 免合入的最短可达见证，不把 V→V 描述成性质翻转。

拟议修订（未实施）：契约需决定 owner 的显式风险接受引用是否可清除执行否定，及能否覆盖归因 pass 所造成的 ⊤。如果可以，必须在 Informed 的“清除”定义写明这个语义；仅在 Witnesses 增加 owner 不够。如果不可以，则接受 a4 比 a3 K2 更严格，而不能宣称仅重组。

另一个需要父级裁决的范围问题：Rel1 字面也继承状态项旧键否定，但 a3 的状态项按键计算，新的已证键可以修复旧欠。本模型没有为状态观察新增重跑动作；因此不能擅自用节点执行归因替状态义务归因。这是 Rel 可能过宽的 (b) 风险，未把静态分析当作已跑出的性质反例。

**纯 a4 编码的未决边界：缓判触及键的授权域。** 当前 Authorized 中还明确要求自由场景的 defer 键不同于该节点当前 trunk 键。这来自 a3 K3“缓判只覆盖变更触及的键”，a4 指针段引用 K3，但 a4 Authorized 段只显式规定 Witnesses，并未单独写出这个键域条件。因此该条件是否可作为“不增欠”义务的作证授权域，还是应当删除并暴露新的 a3/a4 差异，需要父级裁决；本回执不宣称已完全满足“没有任何额外 a3 规则”的编码验收。拟议处理：明确 no-new-debt 义务的实例化域；若允许未触及键上的缓判，则删除这条 Authorized 子句，重跑受影响的自由检查，并审查 DeferredDebtVisible 对创世观察的表示。当前跨键免反例的 defer 键确实已改变，故它不依赖此额外限制；放宽此限制也不会消除已发现的反例。契约没有修改。

## 消融

每个消融包含 39 项固定穷举和一次自由 FreeCoreSafety 检查。固定结果可直接与同场景基线比较；自由检查使用独立随机种子，其 H/S 或 V 不能单独证明差异由消融造成。

| 模式 | 固定性质翻转 | 自由 FreeCoreSafety | 解释 |
|---|---|---|---|
| a4-noAuth | waiver/NothingMerged: H→V; waiver/StateNeverWaived: H→V | VIOLATED | 取消 Witnesses 后可把状态项作为免；应翻转 StateNeverWaived。 |
| a4-noInformed | race/JudgedAtCommit: H→V; launderReview/NoBypassedNegative: H→V; launderTest/NoBypassedNegative: H→V; race/NoBypassedNegative: H→V; launderTest/NoFlakyRerunEscape: H→V | VIOLATED | 否定与引用限制被取消；检查 NoBypassedNegative、JudgedAtCommit 等。 |
| a4-noRecused | 无翻转：本模型及已检验性质中冗余 | VIOLATED | 原环境所有作者都满足避；本模型中该因子恒真、冗余，不说明完整契约不需要避。 |
| a4-noRel1 | race/JudgedAtCommit: H→V; launderReview/NoBypassedNegative: H→V; launderTest/NoBypassedNegative: H→V; race/NoBypassedNegative: H→V; launderTest/NoFlakyRerunEscape: H→V | VIOLATED | 任意键否定不再进入知识约束，应暴露换键/换评审绕过。 |
| a4-noRel2 | 无翻转：本模型及已检验性质中冗余 | HOLDS-SIM | FCommit 只更新该节点的 trunk 分量，两个节点的债务独立，既有性质不审计提交前 epoch。无翻转表示本检验冗余，不能外推为完整树指针 CAS 不需要前值。 |
| a4-noRel3 | 无翻转：本模型及已检验性质中冗余 | HOLDS-SIM | 指针段独立要求 Change4，代数上重复检查；预期本模型中冗余。 |

**随机消融的归因对照：** a4-noRecused 在种子 `3340778300967657810`、第 1272 条随机轨迹找到了 FreeCoreSafety 反例。其末回执为坏的 <<k1,2>>，当前 waived=FALSE；旧免只在 <<k1,0>>。它与上面的跨键免引用反例相同。Recused 对本环境全部可出现的签发者恒真，所以不能把独立种子的 H/S→V 当作回避条件的有效消融。

同种子的普通 a4 对照结果：**HOLDS-SIM**，10000 条轨迹 / 3289774 states checked；[对照日志](runs/PiDagMerge4-a4-FreeCoreSafety-reproduce-free.log)。该对照未复现相同随机路径，不能把相同 seed 当作逐路径配对证据。补充固定重放中，a4-noRecused/NoBypassedNegative 同样 V、40 distinct，与普通 a4 相同；[固定对照](runs/PiDagMerge4-a4-noRecused-NoBypassedNegative-diagnostic-replayWaiverCitation.log)。源码的 Author4 只产生 owner/executor/reviewer1/reviewer2，Trunk4 产生 merger，均不属于 Authors={writer,closureWriter,formerWriter}，所以 Recused 对本模型确实恒真。

## 自由场景与非空性

当前限制下每次自由检查使用 `SIMULATE=num=10000 DEPTH=20 WORKERS=1`，即最多 10,000 条随机轨迹；反例可提前结束。它与原报告保持每 worker 预算，不把一 worker 的 10,000 条说成四 worker 的 40,000 条。随机通过不等于穷举证明。

| 模式 | 场景 | 性质 | 结果 | 轨迹数 / checked | 日志 |
|---|---|---|---|---|---|
| a3 | replayDeferred | FreeCoreSafety | HOLDS-SIM | 10000 / 2086979 | [log](runs/PiDagMerge4-a3-FreeCoreSafety-simulation-replayDeferred.log) |
| a3 | replayNegative | FreeCoreSafety | HOLDS-SIM | 10000 / 1706590 | [log](runs/PiDagMerge4-a3-FreeCoreSafety-simulation-replayNegative.log) |
| a4 | free | DeferredDebtVisible | HOLDS-SIM | 10000 / 3267032 | [log](runs/PiDagMerge4-a4-DeferredDebtVisible-simulation-free.log) |
| a4 | free | EscapeAttributable | HOLDS-SIM | 10000 / 3325668 | [log](runs/PiDagMerge4-a4-EscapeAttributable-simulation-free.log) |
| a4 | free | FreeCoreSafety | HOLDS-SIM | 10000 / 3342046 | [log](runs/PiDagMerge4-a4-FreeCoreSafety-simulation-free.log) |
| a4 | replayDeferred | FreeCoreSafety | HOLDS-SIM | 10000 / 2020074 | [log](runs/PiDagMerge4-a4-FreeCoreSafety-simulation-replayDeferred.log) |
| a4 | replayNegative | FreeCoreSafety | HOLDS-SIM | 10000 / 1772190 | [log](runs/PiDagMerge4-a4-FreeCoreSafety-simulation-replayNegative.log) |
| a4 | free | FreeNoTwoMerges | VIOLATED | 22 / 7585 | [log](runs/PiDagMerge4-a4-FreeNoTwoMerges-simulation-free.log) |
| a4 | free | NewEscapeAttributable | HOLDS-SIM | 10000 / 3334287 | [log](runs/PiDagMerge4-a4-NewEscapeAttributable-simulation-free.log) |
| a4 | free | NoBypassedNegative | HOLDS-SIM | 10000 / 3265403 | [log](runs/PiDagMerge4-a4-NoBypassedNegative-simulation-free.log) |
| a4 | free | NoDeferredMerge | VIOLATED | 208 / 67012 | [log](runs/PiDagMerge4-a4-NoDeferredMerge-simulation-free.log) |
| a4 | free | NoOwnerWaivedMerge | VIOLATED | 15 / 4811 | [log](runs/PiDagMerge4-a4-NoOwnerWaivedMerge-simulation-free.log) |
| a4 | free | NodeAcceptanceCovered | HOLDS-SIM | 10000 / 3271321 | [log](runs/PiDagMerge4-a4-NodeAcceptanceCovered-simulation-free.log) |
| a4 | free | NothingMerged | VIOLATED | 16 / 5106 | [log](runs/PiDagMerge4-a4-NothingMerged-simulation-free.log) |
| a4-noAuth | free | FreeCoreSafety | VIOLATED | 3 / 1281 | [log](runs/PiDagMerge4-a4-noAuth-FreeCoreSafety-simulation-free.log) |
| a4-noInformed | free | FreeCoreSafety | VIOLATED | 20 / 7368 | [log](runs/PiDagMerge4-a4-noInformed-FreeCoreSafety-simulation-free.log) |
| a4-noRecused | free | FreeCoreSafety | VIOLATED | 1272 / 859208 | [log](runs/PiDagMerge4-a4-noRecused-FreeCoreSafety-simulation-free.log) |
| a4-noRel1 | free | FreeCoreSafety | VIOLATED | 33 / 45828 | [log](runs/PiDagMerge4-a4-noRel1-FreeCoreSafety-simulation-free.log) |
| a4-noRel2 | free | FreeCoreSafety | HOLDS-SIM | 10000 / 3299184 | [log](runs/PiDagMerge4-a4-noRel2-FreeCoreSafety-simulation-free.log) |
| a4-noRel3 | free | FreeCoreSafety | HOLDS-SIM | 10000 / 3202498 | [log](runs/PiDagMerge4-a4-noRel3-FreeCoreSafety-simulation-free.log) |

| 非空性性质 | a4 场景 | 结果 / 最短有限步数或随机轨迹步数 | 见证 |
|---|---|---|---|
| NothingMerged | good | V / 5 | [log](runs/PiDagMerge4-a4-NothingMerged-matrix-good.log) |
| NoDeferredMerge | defer | V / 6 | [log](runs/PiDagMerge4-a4-NoDeferredMerge-matrix-defer.log) |
| NoOwnerWaivedMerge | launderReview | V / 8 | [log](runs/PiDagMerge4-a4-NoOwnerWaivedMerge-matrix-launderReview.log) |
| NoUnrelatedMerge | launderTest | V / 9 | [log](runs/PiDagMerge4-a4-NoUnrelatedMerge-matrix-launderTest.log) |
| NoOldDebtMerge | oldDebt | V / 5 | [log](runs/PiDagMerge4-a4-NoOldDebtMerge-matrix-oldDebt.log) |
| FreeNoTwoMerges | free | V / 15 | [log](runs/PiDagMerge4-a4-FreeNoTwoMerges-simulation-free.log) |

非空性必须读 NothingMerged、NoDeferredMerge、NoOwnerWaivedMerge、NoUnrelatedMerge、NoOldDebtMerge、FreeNoTwoMerges 的 V；这些是预期可达见证，不是安全漏洞。最终逐项状态见上表及 TSV。

## 命令、边界与运行状态

`formal/a4/check.sh` 与 `formal/a3/check.sh` 字节完全一致；未编辑 a3 或契约，未使用 git 或 pkill。全部自有写入限制在用户分配路径中。[模型差异](runs/PiDagMerge4-diff.patch)、[运行驱动](runs/PiDagMerge4-run.py)、[汇总脚本](runs/PiDagMerge4-summary.py) 可复核。

当前运行驱动为串行，不创建子 worker。每次 check.sh 调用都以 `nice -n 19 taskset -c 0` 开头，WORKERS=1；固定场景 512m / 60 秒，自由场景 1g / 890 秒。命令日志 `PiDagMerge4-command-*.log` 保留准确 argv、环境、bash xtrace 的 TLC `rc` 以及 wrapper 退出码。机器负载新约束前的旧并行批次已停止；最终模块的矩阵全部在新限制下运行。

```bash
python3 formal/a4/runs/PiDagMerge4-run.py
WORKERS=1 TLC_HEAP=512m TLC_TIMEOUT=60 nice -n 19 taskset -c 0 bash formal/a4/check.sh PiDagMerge4 "a3 a4" "NoBypassedNegative" 'Scenario = "launderTest"; O = o; K0 = k0; K1 = k1' "-matrix-launderTest"
WORKERS=1 TLC_HEAP=1g TLC_TIMEOUT=890 SIMULATE=num=10000 DEPTH=20 nice -n 19 taskset -c 0 bash formal/a4/check.sh PiDagMerge4 "a4" "FreeCoreSafety" 'Scenario = "free"; O = o; K0 = k0; K1 = k1' "-simulation-free"
python3 formal/a4/runs/PiDagMerge4-summary.py
python3 formal/a4/runs/PiDagMerge4-coverage.py
python3 formal/a4/runs/PiDagMerge4-audit.py
python3 formal/a4/runs/PiDagMerge4-shortest.py
python3 formal/a4/runs/PiDagMerge4-report.py
# 同种子对照及最终投影自检由下列有界驱动串行执行；完整 Java argv 写入各自日志
python3 formal/a4/runs/PiDagMerge4-finalize.py
WORKERS=1 TLC_HEAP=512m TLC_TIMEOUT=60 nice -n 19 taskset -c 0 bash formal/a4/check.sh PiDagMerge4 "a4-noRecused" "NoBypassedNegative" 'Scenario = "replayWaiverCitation"; O = o; K0 = k0; K1 = k1' "-diagnostic-replayWaiverCitation"
```

**deferred to parent**：任何多 worker 检查（含原四 worker 总计 40,000 轨迹覆盖）以及 MaxLog=3 穷举。Merge 模块没有 MaxLog 参数，本叶未启动该穷举，也不通过改名或降低优先级绕过禁令。

编码自检修复记录：修正过 TLA 依赖量词作用域、递归求值的短路表达、创世事件位置、过期 disposition 的回执投影；缓判 subject 由状态项纠正为 no-new-debt；“另一条肯定”从错误的仅 observe/pass 改为包含免，由此暴露上述真实契约分歧；历史投影由反复重建改为按环境事件同步物化，并用 Projection4 校验。最终性质文本未更改；旧 SHA 的试跑不计入本报告的当前结果。

全部 756 项计划检查已完成，另有投影自检。该检验已发现契约反例，提交父级审查，不宣称父分支通过。无部署、合并或发布操作。
