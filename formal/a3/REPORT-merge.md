# Merge 模型回执：K1–K5（含 2026-10-08 晚 K5 修订）

结论：a3 挡住高档 BLOCK 被低档 OK 洗掉、旧欠按义务名掩盖新键失败、漏做创世观察、状态不变式被豁免，以及两阶段合入竞态；串行合并队列在下述公平性/队列读法下保证长候选最终合入。但题设要求的绝对 ground-truth 安全性仍有 **3 类 a3 反例**：同档误判撤封、原键失败归因后新键误判通过、没有先前失败时直接误判通过。没有修改 CONTRACT，也没有用准确观察者替换不准确观察者来制造全绿。

## 范围、树与重现

- 唯一模型：[PiDagMerge.tla](PiDagMerge.tla)。工程不是 Git 仓库；未修改架构正文、契约、检查脚本或其他 worker 的文件。
- 当前模型 SHA256：`c1eefc8ce55db551a6f9b436b8f8daf55ef4025fa1bdbe92ec43530003a05118`。
- 采用 K5 晚间修订：归约器在追加的同一原子步重算便宜守卫；不使用整个账头 CAS。读到的 CONTRACT SHA256：`179b6b2a6cae9cf309304bf4acc153b58d4639f79b493f77bc5857101266496d`。
- 重现全部当前检查：`python3 formal/a3/runs/PiDagMerge-reproduce.py`（从项目根目录）。它只调用 `bash formal/a3/check.sh`；check.sh 没有可执行位，因此通过 bash 启动。
- 每次 TLC：Java 11.0.27；TLC 2026.10.06.014338；`WORKERS=1 TLC_HEAP=512m TLC_TIMEOUT=90`；`NODEADLOCK` 未设置；单次最多 90 秒。所有检查开启死锁检测，无死锁、超时、解析错误；49 个当前检查均结束，17 HOLDS、32 VIOLATED（包含预期反例及非空见证），最大 63 个 distinct states。
- 原始命令、环境及真正 TLC 退出码在 [PiDagMerge-checks.log](runs/PiDagMerge-checks.log)；其中 `bash -x` 的 `+ rc=` 保存每次 TLC 返回码：17 次 0、22 次 12、10 次 13。check.sh 自身返回 0 不能当作所有性质通过。
- **检查脚本分类缺口**：两个活性反例的原文为 `Error: Temporal property GoodEventuallyMerges was violated.`，TLC rc=13。check.sh 的正则没有匹配这个措辞，控制台显示 `ERROR(rc=13)`；下表根据完整反例日志明确归类 VIOLATED，未改写日志或脚本。
- 日志命名：`runs/PiDagMerge-<mode>-<property>-<tag>.log`，同名 `.cfg` 保留常量及 PROPERTY/INVARIANT 设置，每份日志含当前模块与 cfg 的 SHA256。早期 K5cas/K5lease 实验产物已删除，当前报告取代旧结论。

## 建模边界与独立性质

一个节点、一个义务 O、两个模型值键 k0/k1；同一模型用 Scenario 选择最小执行环境，不在性质里按 Mode 改答案。k0/k1 有 PRE/原键与当前候选的不同角色，不能做对称置换，因此不设置不健全的 SYMMETRY。合入后的实际真值、曾准确见到失败的历史、晚到 BLOCK 的历史均与观测格分开。

| 性质 | 独立判据（不调用 Guard/NodeOK） |
|---|---|
| NoLaundering | 曾由准确诊断者发现该节点失败，合入时内容仍真实错误，且没有有效 owner 免；用不可抹掉的历史记录判错 |
| NoNewBreakage | 动作性质：首次 trunk 前进时，真实 PRE 为好、真实新状态变坏且无缓判即违反；不是比较观察到的 D 集合 |
| NoFlakyRerunEscape | 原键重跑历史已同时含 pass/fail，却无 owner 明知失败豁免地接受；独立读取原键历史 |
| JudgedAtCommit | 求值之后、提交之前确实来了 BLOCK，仍发生提交；与缓存的求值结果无关 |
| GenesisBeforeAdvance | 真实的全量初始观察动作尚未发生就前进 |
| StateNeverWaived / DeferredDebtVisible | 实際接受的处置类型，以及真实错误的缓判项是否仍显示欠；不是仅检查签发动作能否运行 |
| LeaseExcludes | 执行历史中是否真的有持租期间的竞争合入 |
| GoodEventuallyMerges | 在好候选的 live 环境中最终发生合入；显式 WF 约束准备、验证、提交、重基、入队、续租与到期动作 |

观察者：rank=2 的评审准确，rank=1 的评审/执行器可以在好或坏内容上非确定地给 pass/fail；准确的原始诊断者也可以处于 rank=1（档位不等于准确率）。high 评审可在评审/正常候选环境中实际出场，但契约并未要求每次合入必须等它。Negative 的真实失败史不会因 Edit 换键而清空。测试的两种原键归因分支均执行；评审 BLOCK 不假装能由测试 runner 重跑解除。

## 主表

单元为 `结果 / distinct states`；VIOLATED 时计数是发现最短安全反例时已探索的状态数，不是完整状态空间。所有安全检查单 worker、BFS；步数见后文。活性使用完整有限状态图，不能宣称 TLC 输出的 lasso 是全局最短 lasso。

| tag / Scenario | 性质 | a22 | a3 |
|---|---|---|---|
| review / launderReview | NoLaundering | VIOLATED / 33 | HOLDS / 33 |
| launderTest | NoLaundering | VIOLATED / 41 | **VIOLATED / 27** |
| rerun | NoLaundering | VIOLATED / 33 | **VIOLATED / 25** |
| flakyRerun / launderTest | NoFlakyRerunEscape | VIOLATED / 63 | HOLDS / 53 |
| flakyDebt | NoNewBreakage | VIOLATED / 11 | HOLDS / 5 |
| matrix | NoNewBreakage | VIOLATED / 13 | HOLDS / 6 |
| genesis | NoNewBreakage | VIOLATED / 13 | HOLDS / 6 |
| falsePass | NoNewBreakage | VIOLATED / 21 | **VIOLATED / 13** |
| genesis / good | GenesisBeforeAdvance | VIOLATED / 25 | HOLDS / 17 |
| race | JudgedAtCommit | VIOLATED / 17 | HOLDS / 14 |
| waiver | StateNeverWaived | VIOLATED / 22 | HOLDS / 6 |
| live | GoodEventuallyMerges | VIOLATED / 17 | HOLDS / 9 |
| live | LeaseExcludes | HOLDS / 17 | HOLDS / 9 |

a22 的 LeaseExcludes 为 HOLDS 是因为没有合入租约，是明确的空前提；它不作为修复证据。a3 的租约及竞争路径由队列消融激活。其余新增观察误判反例保留为发现，而非改性质使 a3 通过。

## 消融表

每种消融只关闭表中的一个操作性子句；K3 拆成按项比较与禁止状态豁免，K5 拆成原子重算与串行队列。所有 7 种消融至少使一个原本 HOLDS 的独立性质变为 VIOLATED。

| mode | 去掉什么 | 性质 / tag | a3 → 消融（结果 / states） |
|---|---|---|---|
| a3-K1 | 证据存储/读取不再区分键，错误复用 PRE 的 pass | NoNewBreakage / genesis | HOLDS / 6 → VIOLATED / 7 |
| a3-K1 | 同上，观察到失败/未知的控制组 | NoNewBreakage / flakyDebt；matrix | HOLDS / 5 → HOLDS / 5；HOLDS / 6 → HOLDS / 6 |
| a3-K2 | 当前新键的 pass 不再受沿节点继承的封约束 | NoLaundering / review | HOLDS / 33 → VIOLATED / 21 |
| a3-K3 | D 元素退化成义务名，仍按键存储观 | NoNewBreakage / flakyDebt；matrix | HOLDS / 5 → VIOLATED / 7；HOLDS / 6 → VIOLATED / 8 |
| a3-K3 | 同上，有创世 pass 的控制组 | NoNewBreakage / genesis | HOLDS / 6 → HOLDS / 6 |
| a3-K3state | 允许 owner 直接豁免状态不变式 | StateNeverWaived / waiver | HOLDS / 6 → VIOLATED / 11 |
| a3-K4 | 可以跳过全量创世观察 | GenesisBeforeAdvance / genesis | HOLDS / 17 → VIOLATED / 25 |
| a3-K5atomic | 提交使用之前的判定，不再原子重算 | JudgedAtCommit / race | HOLDS / 14 → VIOLATED / 10 |
| a3-K5queue | 后来候选可越过队首、打断其 PRE | GoodEventuallyMerges / live | HOLDS / 9 → VIOLATED / 24 |
| a3-K5queue | 同上，竞争提交的实际历史 | LeaseExcludes / live | HOLDS / 9 → VIOLATED / 5 |

K1 消融刻意保留 K3 的项集合，只移除观按项归属；K3 消融刻意保留 K1 的观按键隔离。这样两项各有自己的翻转证据。a3-K4 不必再次产生真实破坏：K3 仍能阻止新键欠项；独立的创世事件历史能检查 K4 自己的责任。

## 非空性与正常/失败路径

以下 VIOLATED **都是期望出现的存在性见证**；它们表明通过不是靠冻结所有候选。失败时仅观察到 unknown 的候选仍有 FinishObservation（真实检查）可运行；只有已有 fail/封/冲突导致不能判的候选才可明确拒收。Terminal 只对已合入或已拒收状态提供 stuttering。

| mode / tag | 性质 | 结果 / states | 最短执行（从 Init 算动作数） |
|---|---|---|---|
| a3 / good | NothingMerged | VIOLATED / 13 | 完成创世→启动→真实好内容得到 pass→求值→提交，5 步 |
| a3 / good | NoUnrelatedMerge | VIOLATED / 16 | 上一路径求值后插入无关观，仍提交，6 步；当前 head != 求值时 snap |
| a3 / live | NothingMerged | VIOLATED / 8 | 创世→入队→准备 PRE→验证→提交，5 步 |
| a22 / live；a3-K5queue / live | NothingMerged | VIOLATED / 14；VIOLATED / 13 | 同样 5 步可成功；反例活性不等于所有执行都失败 |
| a3 / defer | NoDeferredMerge | VIOLATED / 9 | 创世→启动→新键 fail→签缓判→求值→提交，6 步 |
| a3 / defer | NoNewBreakage；DeferredDebtVisible | HOLDS / 10；HOLDS / 10 | 真错误的合入必须有缓判，且它仍是欠 |
| a3 / owner | NoOwnerWaivedMerge | VIOLATED / 22 | 创世→启动→高档 BLOCK→改键→低档观→owner 明知封仍免→求值→提交，8 步 |
| a3 / oldDebt | NoOldDebtMerge；NoNewBreakage | VIOLATED / 8；HOLDS / 13 | 创世记录旧欠→不改变该项键的候选→unknown→求值→提交，5 步；真实旧坏未新增 |

## 最短反例与 a3 发现

以下安全步数均包含一次 Genesis/SkipGenesis 和 Start；完整变量轨迹保存在主表对应的日志中。表中合并描述的多种模式具有相同最短动作结构。

| 模式 / 性质 / tag | 步数 | 普通语言反例 |
|---|---:|---|
| a22 / NoLaundering / review | 7 | 创世；启动；准确高档评审在 k0 BLOCK；同节点改注释到 k1，内容仍坏；低档评审错误 OK；求值；合入。没有 owner 免。 |
| a22 / NoLaundering / launderTest、rerun | 各 7 | 创世；启动；准确诊断在原键 fail；改键但未修错；新键 flaky pass；求值；合入。a22 根本不需要原键重跑。 |
| a3 / NoLaundering / launderTest | 7 | 同上，但新键的 rank=1 肯定观依据 K2 的“≥原观察者档位”撤封。原诊断正确、新观察者仍可误判，档位相等不能保证同等准确性。 |
| a3 / NoLaundering / rerun | 8 | 原键准确 fail→改键→新键错误 pass；封仍在；执行器回原键重跑仍 fail；K2 归因分支允许按新键通过计；求值并原子提交坏内容。默认 1-of-1 是本模型选择的 n-of-k；任意有限采样在允许假阳性时仍不能证明绝对真值。 |
| a22 / NoFlakyRerunEscape / flakyRerun | 8 | 原键 fail→改键→新键 pass→回原键重跑 pass（原键已冲突）→求值→合入；a3 将原键不确定性保留为节点冲突欠，阻止这条路径。 |
| a22 / NoNewBreakage / flakyDebt | 5 | 创世时真实 PRE 好，但 flaky 观为 ⊤；候选变成真实稳定坏并观到 fail；双方 D 都只有义务名 O，子集成立，求值并合入。 |
| a22 / NoNewBreakage / matrix | 5 | 真实 PRE 好、矩阵观为 ⊥；候选触及读取集并真实破坏，但矩阵仍未给结果；同名 ⊥ 欠包含关系恒真，合入。 |
| a22 / NoNewBreakage / genesis | 5 | 跳过创世观察；真实好的 PRE 被视为未知欠；坏候选仍未知，同名欠子集通过，合入。 |
| a22、a3 / NoNewBreakage / falsePass | 各 5 | 真实 PRE 好且已观 pass；真实坏的新键由低档/不准确观察者误报 pass；尚未等准确高档评审，立即求值并提交。a3 的新键 E 是观测证据，不是真值保证。 |
| a22 / GenesisBeforeAdvance / genesis | 5 | 跳过创世观察；好候选得到 pass；求值并提交，证明即使内容好，也违反“先完整创世观察”。 |
| a22 / JudgedAtCommit / race | 6 | 创世；启动；坏候选误获 pass；Eval 缓存成功；准确评审在提交前 BLOCK；旧两阶段 Commit 仍提交。a3 同一步重算看到 fail 后停止提交，可回到判定并拒收。 |
| a22 / StateNeverWaived / waiver | 6 | 创世；启动；坏候选状态项未知；owner 直接豁免状态项使其不在 D；求值并合入。a3 只准缓判变更，不准删除状态欠。 |

这些 a3 反例说明的是“证实”的观测含义不蕴含题设绝对真值性质，与架构已有的逃逸类 ①a 一致；不能仅凭新增沿节点封就宣称 NoLaundering 对所有观察者都成立。若父级要绝对性质，最小语义方向是：撤封/新键 E 必须有具有声称可靠性的独立准确依据；或明确只承诺观察一致性、将误判纳入风险。这里未擅自加入这些前提，也未创建 a3fix。

N8 活性反例：a22 日志先完成创世与入队，然后循环“准备当前 PRE→验证完成→竞争候选提交使 PRE 过期→重新准备”，没有一个固定提交动作持续使能，所以满足 WF 仍永远不合入。日志为 7 个状态，回到状态 4。队列消融为 9 个状态、回到状态 4，并在循环内实际经历租约到期/重新获取。a3 的队首准备、验证、提交各阶段在 WF 下会完成，后到候选不能改变 PRE，因此最终合入；这一结论不依赖账头静止。

## 歧义裁决与没有覆盖的部分

- **K5 最新读法**：串行队列覆盖从选择 PRE 到验证完成再提交的整个轮次，不只是串行执行瞬时 Commit；租约到期释放资源，但不让后到候选抢走当前 FIFO 次序。LiveStart 抽象掉有限个前序队列项，其公平动作代表被调度到队首。若实现允许到期后无限次被后来候选插队，只有 WF 仍不能保证 N8；父级需在正文/实现中保留这个前提。
- **a22 race 的边界**：a2.2 §3.3 已字面写“守卫求值和追加发生在同一步”，若直接当作原子规范，竞态本来就被排除。本模型按本任务和 fidelity 审查要求，将 race 场景解释成仅检查 PRE/律版本的两阶段实现压力测试，不能把这条反例误称为击穿原子 a2.2 规范。其他 a22 场景采用同键格、按义务名不增欠等原文字面规则。
- **K2**：按通用“观察者 b 且档位≥”读法允许执行类同档肯定观撤封；如果父级只打算让评审使用此分支，launderTest 的发现需要按那一更窄语义重查，但原键 fail 归因后误判以及 falsePass 反例仍独立存在。仅建模一条待解封的原始失败链，不验证多观察者多重封的归约。
- **K4**：完整观察表示对全部已知不变式完成一轮观测尝试，允许矩阵超时/不可用返回 ⊥、flaky 返回 ⊤；不是假定一轮观察必然知道真值。这里只需一个不变式即可见证漏洞；未研究大规模创世成本。
- **项与权**：一项仅有两个键，owner 免和缓判都在最终候选键上签发，随后不再改键；未检验多个免的覆盖集、无关编辑后旧免保留、改名拆分、动态义务收集或多项并集。签发者有效且满足避作为前提，K8/K9 由其他模型负责。
- **真值与公平**：候选真实质量在环境初始化时固定，不能在守卫中偷看；没有真实代码、哈希碰撞、概率/准确率估计或无限重试。live 使用确定正确的长验证；不声称任意 flaky 好候选在仅 WF 下也能成功。期限只抽象为可公平到期的动作，不证明墙钟时限；未做整个账头 CAS 的可选消融。
- 无运行中的 TLC 进程由本交付维持，没有部署或发布动作。此回执是叶子自检证据，等待父级对上述语义读法及发现作审阅，不宣称分支已被接受。
