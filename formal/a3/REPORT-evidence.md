# Evidence a3 检查报告

## 结论与交付

K6/K7/K10 的 8 项针对性安全性质在具备追踪的核心场景中 a22 违反、a3 成立；2 项 a21 回归保证在两者及全部消融中成立。16 个核心单条消融全部翻转对应安全/活性结果。a3 允许正常及诚实新模块合入。弱测试逃逸在全部 21 个模式存在，符合指定边界。补充 K12 的 1 个声明闭包模式及 2 个消融，证明授权声明复用允许逃逸，但必须可见且不能显示为实测。

**a3 finding：`ReviewerAccurate` 仍被违反。** 同一模型、提示和缺陷类先 BLOCK 诱饵、后对真实坏节点 OK，是 K10 允许的行为。承诺—揭示、同构和分键校准阻断下面列出的固定特征策略，但不能把抽样校准提升为逐次准确性保证。这是更强安全目标在 a3 模式中的反例，不是声称该行为违反了 K10 的字面要求。未新增 `a3fix`，未修改 CONTRACT。

- 模型：`formal/a3/PiDagEvidence.tla`。
- 本报告：`formal/a3/REPORT-evidence.md`。
- 140 组 `.cfg/.log`：`formal/a3/runs/PiDagEvidence-*`；逐项清单：`formal/a3/runs/PiDagEvidence-audit.tsv`。
- 当前模型 SHA256：`94f46b8ad5d849790b51f14b03098d903fed76105d155a80a21c6eb8af51093d`。已逐个验证全部日志中的模型哈希、配置哈希与当前文件一致。
- 结果共 70 HOLDS、68 VIOLATED、2 DEADLOCK。VIOLATED 含预期见证；没有未完成或超时检查。检查用 Java 11.0.27、TLC 2026.10.06.014338、单 worker、512m heap、每次 120 秒上限，实际每次约 1 秒。

## 抽象与独立真值

模型有 21 个核心有限场景，加 3 个 K12 声明者场景；每条路径依次经过派活、写候选、物化、执行、强度执行、评审判决、揭示、合入或终结拒绝。安全集合排除单独检查的 `honestStub`，共 20×9=180 个可达状态；诚实活性集合有 2×9=18 个状态。字符串是语义不同的事件、故障和路径标签，没有可互换的节点身份，故不使用无效的 SYMMETRY；本规模不需要人为引入对称 model values。

独立真值包括真实实现输出 `RealValue`、固定检查的影子执行 `ActualRun(...,"pinned")`、完整访问事件 `TrueReads`、测试实际杀死的故障集合 `Killed`、真正发生过的评审实验 `ReviewActuallyRan`。守卫消费执行回执、反事实执行结果、校准和引用 ID；性质检查这些独立行为事实，而不是重新求值 `MergeGuard`。反例可以在可信 runner 回执为 pass 时，仍由影子执行发现实际检查应 fail。

`closureEdit` 代表 conftest/plugin/pyproject 等检查路径被候选修改；`overlay` 代表未物化律版本而加载外部/工作树检查内容。`negative` 的完整事件含 ENOENT，追踪输出遗漏该事件，缓存按旧键返回 pass。`bounds`、`tracing` 分别表示外部读取和追踪失效后受污染的运行。

`Killed` 区分真正的目标、软 helper、默认返回桩和两个律预置负例。`target` 是 R1 新模块，隔离靶点规则；`trivial` 和 `swap` 是 R2 新模块，隔离负例覆盖与换包降杀伤率。固定特征评审策略只能看身份、结构或当前模型/提示/缺陷类；`drift` 则允许同一校准键下策略随轮次改变。

## 基线性质 × 模式

括号为 distinct states found，失败计数是 BFS 发现最短反例时的搜索计数，不是完整状态空间规模。除带说明项，Scope=`safety`。

| 性质 | a22 | a3 | 独立判据 |
|---|---|---|---|
| JudgeSound | VIOLATED (83) | HOLDS (180) | pass 回执不能掩盖固定检查的真实 fail |
| ReadsComplete | VIOLATED (85) | HOLDS (180) | 完整真实读取事件必须被允许且记录 |
| NoSelfJudge | VIOLATED (83) | HOLDS (180) | 修改检查闭包的候选不得获得该检查的有效观 |
| TargetDetected | VIOLATED (161) | HOLDS (180) | 合入测试实际杀死原目标故障 |
| NegativeCoverage | VIOLATED (169) | HOLDS (180) | R2 trivial 测试实际杀死两个律负例 |
| NoCoverageDrop | VIOLATED (170) | HOLDS (180) | 换包实际覆盖不低于旧包 2/2 |
| FeatureCalibrationSound | VIOLATED (171) | HOLDS (180) | 固定特征策略不能放行真实坏节点 |
| ExecutionHonest | VIOLATED (176) | HOLDS (180) | 声称的评审实验实际发生过 |
| ReviewerAccurate | VIOLATED (171) | **VIOLATED (177)** | 包括策略漂移的逐次真实准确性 |
| SelfReportIsSpeech | HOLDS (180) | HOLDS (180) | 只有写者自报不能合入，a21 回归 |
| NoVacuousMerged | HOLDS (180) | HOLDS (180) | 实际杀不死任何故障的空测试不能合入 |
| NothingMerged | VIOLATED (161) | VIOLATED (162) | 非空合入见证 |
| NoGoodMerge | VIOLATED (162) | VIOLATED (162) | 真正良好内容可合入的见证 |
| NoWeakEscape | VIOLATED (180) | VIOLATED (180) | 测试杀指定负例但漏真实缺陷的接受边界 |
| GoodEventuallyMerges，honest | DEADLOCK (17)；时序诊断 VIOLATED (17) | HOLDS (18) | 显式 WF 下好内容最终合入 |
| NoHonestMerge，honest | 未运行 | VIOLATED (18) | 未实现桩作为规定失败的新模块可合入 |

补充定向检查：N3 的 closureEdit/overlay/bounds/negative/tracing 各自检查 JudgeSound，a22 均 VIOLATED (5)，a3 均 HOLDS (9)；N6 的 identity/shape/modelKey/promptKey/classKey 各自检查 FeatureCalibrationSound，a22 均 VIOLATED (9)，a3 均 HOLDS (9)。后缀为场景名的日志保存各自最短轨迹。Scope=`cfset` 的 TargetDetected 在 a22、a3 都 HOLDS (9)：a2.2 已要求事先固定反事实集合，不伪造一个违反该旧保证的 a22 模式。

## 单条消融

每行只删除命名子句，其余均沿用 a3。前 15 行 Scope=`safety`；最后一行 Scope=`honest`。对应完整 a3 性质都 HOLDS。

| 模式 | 删除的契约子句 | 翻转性质 | 结果（distinct） |
|---|---|---|---|
| a3-closure | K6 律钉住并物化覆盖检查闭包 | JudgeSound | VIOLATED (84)，overlay |
| a3-bounds | K6 越界读取使观为 ⊥ | JudgeSound | VIOLATED (85)，bounds |
| a3-negative | K6 无法追踪 ENOENT 查找使观为 ⊥ | JudgeSound | VIOLATED (86)，negative |
| a3-tracing | K6 追踪失效使观为 ⊥ | JudgeSound | VIOLATED (87)，tracing |
| a3-touch | K6 修改闭包不能用该检查作证 | NoSelfJudge | VIOLATED (83)，closureEdit |
| a3-target | K7 派活前固定靶点 | TargetDetected | VIOLATED (161)，target |
| a3-cfset | K7 派活前固定反事实集合 | TargetDetected | VIOLATED (168)，cfset |
| a3-negatives | K7 R2+ 新模块律预置负例及阈值 | NegativeCoverage | VIOLATED (169)，trivial |
| a3-floor | K7 更换测试包杀伤率不得下降 | NoCoverageDrop | VIOLATED (170)，swap |
| a3-commit | K10 判决前隐藏诱饵身份 | FeatureCalibrationSound | VIOLATED (171)，identity |
| a3-isomorphic | K10 真节点与诱饵同构 | FeatureCalibrationSound | VIOLATED (172)，shape |
| a3-model | K10 校准键中的模型 | FeatureCalibrationSound | VIOLATED (173)，modelKey |
| a3-prompt | K10 校准键中的提示哈希 | FeatureCalibrationSound | VIOLATED (174)，promptKey |
| a3-class | K10 校准键中的缺陷类 | FeatureCalibrationSound | VIOLATED (175)，classKey |
| a3-receipt | K10 声称实跑必须引用执行器观 | ExecutionHonest | VIOLATED (176)，claimedRun |
| a3-stub | K7 NotImplemented 属规定失败 | GoodEventuallyMerges | DEADLOCK (17)；诊断 VIOLATED (17) |

全部 16 个消融还检查了 SelfReportIsSpeech 与 NoVacuousMerged，均 HOLDS (180)；NoWeakEscape 全部 VIOLATED (180)。3 个 K12 模式也在相同核心场景上得到相同结果，因此弱测试见证覆盖全部 21 个模式。

## K12 声明闭包补充

已阅读 K12–K14。本次只补充 K12；K13 条款兑现不属于本叶范围，K14 的纯判定函数/合成 receipt 强度未展开，避免改变核心 N3/N5/N6 检查范围。

Scope=`declared` 含 4 个场景：有权非写者 parent 声明、有权 writer 自签、无权 stranger 声明，以及无追踪时修改检查闭包。真实访问含 outside，但声明键只有 src；无追踪使该访问不可见。缓存旧 pass 因声明键相同被复用，当前固定检查影子执行应 fail。声明复用回执为 `declared-pass`，卡片映射为 `reuse (declared closure)`，对应“复用（声明闭包）”；合入按受限免接受它，不把它归入实测 E。闭包仍物化 pinned；closureEdit 仍为 bottom。

| 性质 | a3-declared | a3-declared-label（去显示规则） | a3-declared-auth（去签发资格检查） |
|---|---|---|---|
| DeclaredVisible | HOLDS (36) | VIOLATED (34) | HOLDS (36) |
| DeclaredAuthorized | HOLDS (36) | HOLDS (36) | VIOLATED (35) |
| NoDeclaredEscape（预期见证） | VIOLATED (34) | VIOLATED (34) | VIOLATED (34) |
| NoSelfJudge | HOLDS (36) | HOLDS (36) | HOLDS (36) |

三个最短反例均为 9 状态：parent 签窄声明 → 漏掉 outside 的缓存键命中旧 pass → 强度与评审满足 → 坏内容合入，但正常模式卡片显示声明复用；label 消融把同一路径显示成 measured，形成伪实测；auth 消融让 writer 自签也能合入。日志 `PiDagEvidence-a3-declared-NoDeclaredEscape.log`、`PiDagEvidence-a3-declared-label-DeclaredVisible.log`、`PiDagEvidence-a3-declared-auth-DeclaredAuthorized.log` 保留各自轨迹。

这类逃逸按 K12 记为 **①b 键不全，由可见声明闭包豁免允许**，不是核心追踪模式下的证据真实性保证。该扩展只对声明场景启用无追踪路径；其它 Scope 仍检查核心追踪语义。授权链本身及声明生命周期仍不在本模型中。

## 最短反例（自然语言）

TLC 单 worker BFS 给出最短安全轨迹。状态 1 是初始化，2 派活，3 写候选，4 物化，5 执行，6 强度执行，7 评审，8 揭示，9 合入。以下列出每个 a22 违反及全部 a3 违反；共享后缀省略重复叙述。

- **a22 JudgeSound / NoSelfJudge，5 状态**：派活固定检查 → 候选改 conftest/plugin/配置 → runner 加载恶意检查 → 真实坏实现获得 pass；影子固定检查会 fail。对应基线日志场景 closureEdit。
- **a22 ReadsComplete，5 状态**：候选存在真实缺陷 → 执行器读取 `outside` 并被其影响 → 回执 pass；真实访问超出允许集合。日志场景 bounds。
- **a22 ENOENT 变体，5 状态**：写候选时改变缺失配置的状态 → 访问历史应包含 `absent-conftest` → 追踪只留下 src，旧键缓存 pass 被复用 → 真实检查应 fail。见 `PiDagEvidence-a22-JudgeSound-negative.log`。overlay、tracing 的定向日志同为 5 状态，分别是未覆盖检查版本和追踪坏掉。
- **a22 TargetDetected / NothingMerged，9 状态**：派活记录 target → 写候选后改选 helper → 测试只杀 helper/default，漏掉真实 target → 强度通过、评审 OK、合入。选择者抽象为可事后选择靶点的父级或写者，没有假设二者能事后改已固定的反事实集合。
- **a22 NegativeCoverage，9 状态**：默认返回桩被 trivial assertion 杀死 → 两个真实负例都存活 → a22 无 R2 必配负例要求 → 强度通过并合入。
- **a22 NoCoverageDrop，9 状态**：旧包杀伤 2/2 → 换包仅杀 n1，仍满足普通阈值 1/2 → 无不下降限制 → 合入。a3 的历史杀伤率下限会阻止此路径。
- **a22 FeatureCalibrationSound / ReviewerAccurate，9 状态**：账上身份暴露诱饵 → 评审按该特征 BLOCK 诱饵、OK 真坏节点 → 校准通过 → 合入。shape 变体以缺少 dsa/写者槽识别诱饵；三个 key 变体借用另一模型、提示或缺陷类的成功校准，定向日志分别保留。
- **a22 ExecutionHonest，9 状态**：测试执行正常、评审声称另一个实验已实跑 → 给出不存在的执行观 ID → 未检查引用，判 OK 后合入；真值中该评审实验从未执行。
- **a22/a3 NoGoodMerge，9 状态**：良好实现 → 固定检查 pass → 目标及全部律负例被杀 → 有效评审 → 合入。a3 NothingMerged 使用同一好内容路径。它们是成功见证，不是缺陷。
- **a22/a3 NoWeakEscape，9 状态**：弱测试漏真实缺陷，但杀掉目标桩和两个律负例 → 合法 pass、合法强度、评审 OK → 真实坏内容合入。提高指定集合内的杀伤率不证明集合外需求。
- **a3 ReviewerAccurate，9 状态**：同一模型、提示、缺陷类先正确 BLOCK 诱饵 → 对随后真坏节点策略漂移为 OK → 校准键仍匹配 → 合入。该轨迹不使用身份泄露、非同构、键借用或伪执行引用。见 `PiDagEvidence-a3-ReviewerAccurate.log`。
- **a22 GoodEventuallyMerges，8 状态后冻结**：真实好新模块执行 pass → 桩抛规定 NotImplemented → a22 不认可该失败 → 强度一直未满足 → 揭示后无合入动作。WF 不能使一个不启用的动作发生；诊断轨迹在此无限停顿。a3-stub 相同。
- **a3 NoHonestMerge，9 状态**：同一诚实新模块路径中 NotImplemented 被承认为规定失败 → 强度满足 → 合入。是消除冻结的正向见证。

## 活性、运行器与复现

`Spec = Init /\ [][Next]_vars /\ WF_vars(Next)`；每阶段只有一个进度动作启用，故 Next 的弱公平足够推动有限流程。只有 pc=8 的完成合入或终结拒绝允许显式 Terminal stutter。honestStub 强度不足不算完成，保留真实冻结；模型未用无限重试伪装活性。

所有普通运行都开死锁检测。先捕获 a22/a3-stub 的死锁，再仅对两者使用 `NODEADLOCK=1`、后缀 `-temporal-diagnostic` 确认时序性质本身的违反。TLC 原始日志明确写 `Error: Temporal property GoodEventuallyMerges was violated.`，退出码 13；check.sh 的 grep 仅覆盖复数 `Temporal properties were violated`，因此显示 `ERROR(rc=13)`。审计按原始日志记 VIOLATED，不把它伪报成通过，也不修改共享 runner。所有调用 check.sh 的 shell 返回 0；runner 不透传 Java 非零退出码，不能用其 shell 状态判定性质通过。

运行目录为 `/work/pi-dag/formal/a3`，统一环境：

```bash
export WORKERS=1 TLC_TIMEOUT=120 TLC_HEAP=512m
bash check.sh PiDagEvidence 'a22 a3' 'JudgeSound ReadsComplete NoSelfJudge TargetDetected NegativeCoverage NoCoverageDrop FeatureCalibrationSound ReviewerAccurate ExecutionHonest SelfReportIsSpeech NoVacuousMerged NothingMerged NoGoodMerge NoWeakEscape' 'Scope = "safety"'
bash check.sh PiDagEvidence 'a3-closure a3-bounds a3-negative a3-tracing' 'JudgeSound' 'Scope = "safety"'
bash check.sh PiDagEvidence 'a3-touch' 'NoSelfJudge' 'Scope = "safety"'
bash check.sh PiDagEvidence 'a3-target a3-cfset' 'TargetDetected' 'Scope = "safety"'
bash check.sh PiDagEvidence 'a3-negatives' 'NegativeCoverage' 'Scope = "safety"'
bash check.sh PiDagEvidence 'a3-floor' 'NoCoverageDrop' 'Scope = "safety"'
bash check.sh PiDagEvidence 'a3-commit a3-isomorphic a3-model a3-prompt a3-class' 'FeatureCalibrationSound' 'Scope = "safety"'
bash check.sh PiDagEvidence 'a3-receipt' 'ExecutionHonest' 'Scope = "safety"'
bash check.sh PiDagEvidence 'a22 a3 a3-stub' 'P:GoodEventuallyMerges' 'Scope = "honest"'
bash check.sh PiDagEvidence 'a3' 'NoHonestMerge' 'Scope = "honest"'
bash check.sh PiDagEvidence 'a3-closure a3-bounds a3-negative a3-tracing a3-touch a3-target a3-cfset a3-negatives a3-floor a3-commit a3-isomorphic a3-model a3-prompt a3-class a3-receipt a3-stub a3-declared a3-declared-label a3-declared-auth' 'SelfReportIsSpeech NoVacuousMerged NoWeakEscape' 'Scope = "safety"'
NODEADLOCK=1 bash check.sh PiDagEvidence 'a22 a3-stub' 'P:GoodEventuallyMerges' 'Scope = "honest"' '-temporal-diagnostic'
for fixture in closureEdit overlay bounds negative tracing; do
  bash check.sh PiDagEvidence 'a22 a3' 'JudgeSound' "Scope = \"$fixture\"" "-$fixture"
done
for fixture in identity shape modelKey promptKey classKey; do
  bash check.sh PiDagEvidence 'a22 a3' 'FeatureCalibrationSound' "Scope = \"$fixture\"" "-$fixture"
done
bash check.sh PiDagEvidence 'a22 a3' 'TargetDetected' 'Scope = "cfset"' '-cfset'
bash check.sh PiDagEvidence 'a3-declared a3-declared-label a3-declared-auth' 'DeclaredVisible DeclaredAuthorized NoDeclaredEscape NoSelfJudge' 'Scope = "declared"'
```

## 读法、边界与未建模

- a22 保留 a21 的避与空测试保护，以及正文已明确的“事先由律指定反事实集合”。a22 不固定靶点；a3 把集合与靶点同时记录在派活包。`a3-cfset` 删除的是既有规则在 K7 中的重申，因此它翻转结果不意味着 a22 本来缺少集合规则。
- K6 的闭包钉住和物化覆盖按同一句复合要求消融；它们没有拆成两个互相兜底的布尔开关。修改闭包路径即使覆盖后得到 fail，也应为 ⊥，不能作为有效否定观，所以 `NoSelfJudge` 同时禁止 pass 与 assert。
- K7 “杀伤率不得下降”读为保留旧包**实测**杀伤率，而不只是保留声明阈值。两个负例足以区分旧 2/2、新 1/2、固定普通阈值 1/2。NotImplemented 读为律明确规定的错误类型，不把任意 ImportError/崩溃算成合格失败。
- K10 的（模型+提示哈希，缺陷类）被分解成三个独立键分量；承诺是理想不可区分、无哈希碰撞的 token。同构覆盖身份以外的所建模可见结构；未声称能隐藏轮次或消除随机误判。实跑引用校验假定执行器 ID 注册表可信，并区分测试运行和声称的评审实验。
- 单候选、单派活、一个旧测试包和一次换包；没有真实文件系统/strace、Python 收集器、缓存实现、哈希密码学、OS 同用户攻击，也没有 K1/K2/K5 的多候选键迁移、封继承、并发 CAS。负依赖缓存复用由一个固定旧 pass 抽象，没有另建 PRE 执行完整轨迹。
- 评审特征策略是有限具体反例族，不是任意程序的非干扰证明；drift 是确定性轮次策略，无需引入概率就能否定“校准蕴含永久准确”。本模型没有校准过期窗口、统计置信区间、重复抽样、环境漂移检测。
- honestStub 的冻结是当前义务集与当前检查不变的局部冻结，不证明 owner 永远不能另立律修复它；未建模重派、升级或改律。
- 非目标分支的辅助义务预先满足，以隔离被检机制；真实测试覆盖由有限真值表给出。多个漏洞同时发生、各检查之间干扰、更大故障集合与全系统集成不是本次 HOLDS 的范围。

交付状态：全部产物已落盘，未提交或发布（项目不是 git 仓库），没有遗留 TLC 进程或等待中的检查；分支是否接受由父级决定。
