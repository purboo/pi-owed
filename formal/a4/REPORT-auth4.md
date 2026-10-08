# auth4：单一 Counts 判据与 a3 的有界比较

**结论：当前钉住的 a4 不能在保持原真值不变、且不补回特殊归约规则的条件下复现 a3 的全部结果。** 场景轮中，a3 的 11 项安全性质、2 项活性性质全部通过；a4 有 7 项安全性质失败，另外 `NothingRevivedWaived` 从通过变为失败。正常合入、缓判带欠合入、父级签免仍都有非空见证，因此不是全面禁止动作导致的空通过。

当前模块 `PiDagAuth4.tla` SHA256：`37e2b853c6e026bd1130f6ea0ca4d9d9a28b433a7bf07fb2c608d9f1f56ca009`。
源 a3 模块 SHA256：`4e33cdf2dc776ed8501dab5cd3f86805a9ea8b3e63e2ac7a46d4badd259f21c0`，与 a3 报告父级补充的 free MaxLog=3 已验收版本一致。

正式证据共 **142 次 TLC：68 次 rc=0，74 次 rc=12；无超时、死锁、解析或求值错误**。所有正式 cfg/log 的模块及配置哈希均已核对。这批运行全部在用户追加机器负载限制之前结束；历史 free MaxLog=2、3 均用穷举 BFS 模式找到两事件反例，**不是完整遍历通过**。历史 MaxLog=3 按原要求在其他检查结束后单独以 WORKERS=8、TLC_HEAP=12g、TLC_TIMEOUT=2400 执行。

**当前执行状态：MaxLog=3 exhaustive — deferred to parent。** 用户随后要求至多一个 TLC、`nice -n 19 taskset -c 0`、WORKERS=1、TLC_HEAP≤1g，并禁止 MaxLog=3 和多 worker 运行。收到后没有启动任何 TLC；当前复跑驱动器已按新限制修改，不再包含 MaxLog=3 调用。下文保留此前完成的真实历史证据，不将其伪装为限制生效后的执行或未执行。

## 模型与编码边界

- 只新增本模块、本报告、`runs/PiDagAuth4-*` 证据及缺失的 `check.sh`。后者是 a3 runner 的逐字节副本；不修改 a3、契约或其他 worker 的文件，未运行 git。
- 原 `a22`、`a3`、a3 消融分支保留。a4 模式的 grant/revoke/law/waive/downgrade/defer 准入均调用同一个 `Counts(e)`，环境编辑和槽/merge 事件也经该准入。`Counts = Authorized /\ Informed /\ Recused`；没有为冲突、retro、future 在 Counts 内开例外。
- `t` 由当前日志前缀隐含给出。名字的已提交更新在追加位置判断；项状态的 `Covers/FreeCovers` 在当前前缀重新计算 Counts，不把“签发时通过”偷换成“永久通过”。这是本实验对 `Counts(a,t)` 的逐时解释；future/retro 的时间语义分歧见下文。
- 权限实现仍为增量 `edges`、`Close/Rights` 和撤销时永久级联 `Prune`。这是 a4 Authorized 明文继承的 K8，不是另外恢复一条 a3 准入规则。K1 的真实项键及状态/变更项分类也是共同数据底座。
- `Witnesses(e)` 是有限创世策略表：授权范围不能超过签发人有效范围；仅 Owner 可撤销；普通名字律按节点有效范围；免、降级、缓判共用节点权限。未证状态项不接受免/降级；缓判映射为变更义务上的处置，状态项仍欠。模型没有执行器 pass，因此状态项 Witnesses 的肯定分支为空。槽取得/释放保留原物理槽约束。
- `Authors(e)` 对免、降级、缓判包含内容作者及 `everSlots`，释放槽不删除历史。对其他名字，本 auth 抽象没有内容/检查闭包作者元数据，作者集合为空；不声称已经检验完整名字内容的溯源回避。原模型也没有检查闭包作者、执行否定或判断否定。
- a4 事件增加 `premises`（日志位置集合）。0 表示相应名字的创世值；名字生成器提供正确前值与旧创世值 `{0}` 两种选择，若相同则合并。因此新值产生后，环境**确实能提交过期前提**。项处置无否定需要清除，premises 为空。只覆盖这一类过期值，不枚举所有历史位置子集。
- 权限名字按受权主体聚合；grant 与 revoke 共用其名字。普通律按节点名字聚合；不同签发人必须引用同一名字的当前前值。槽按节点命名，简化 merge 指针按节点命名。`Prior` 取最近已 Count 的名字断言；被拒绝的言不改变名字。`counted` 只是实现账索引，不进入任何原真值。
- a3/a22 保留原事件表示和搜索图；a4 扩展前提后搜索图变大。忽略 premises 投影回原输入字母表，不改变旧模式语义。a3 场景完整图仍为 **1,019** 状态，a4 为 **1,955** 状态。
- Rel1 在此字母表中没有“否定/归因”约束可清除；已有免/缓判是肯定，不是名字新值。`Rel1(e)={}` 表示其对 Informed 的约束为空，不是声称 a4 的完整相关集合没有其他肯定。
- Rel2 实现名字前值 CAS。Rel3 的完整 `O(PRE→s)` 状态向量没有 auth 对应物：本模型仅有简化的 merge/deferred 见证，沿用已有指针成/欠条件，不伪造 merge 模型的否定递归。Rel1、Rel3 开关仍提供，但明确属于 **N/A／本模型冗余**，不算这两条契约已被验证。
- `Eff`、原独立历史观察器、所有原有安全/活性/见证性质均保持定义原文。包括 `Eff` 不读 premises/counting 状态这个关键限制。逐定义比对见 `runs/PiDagAuth4-source-audit.json`；实际相对 a3 的 unified diff 见 `runs/PiDagAuth4-source.diff`。

## a3 与 a4：场景 MaxLog=5

单元格为结果 / distinct states。失败的状态数是发现反例时已访问数量，不是完整状态图大小。所有场景检查使用 1 worker、BFS，下面失败日志给出各自场景空间内的最短轨迹。

| 性质 | a3 | a4 |
|---|---|---|
| AuthoritySound | HOLDS / 1019 | VIOLATED / 89 |
| DecisionAuthority | HOLDS / 1019 | VIOLATED / 706 |
| NoWriterJudge | HOLDS / 1019 | HOLDS / 1955 |
| NoAuthorJudge | HOLDS / 1019 | HOLDS / 1955 |
| RelevantInvalidates | HOLDS / 1019 | HOLDS / 1955 |
| UnrelatedPreserves | HOLDS / 1019 | VIOLATED / 753 |
| StateRemainsDebt | HOLDS / 1019 | HOLDS / 1955 |
| ConflictDebt | HOLDS / 1019 | VIOLATED / 1084 |
| SamePrincipalSupersedes | HOLDS / 1019 | VIOLATED / 446 |
| RetroHonored | HOLDS / 1019 | VIOLATED / 953 |
| FuturePreserves | HOLDS / 1019 | VIOLATED / 1207 |
| AllSafety | HOLDS / 1019 | VIOLATED / 89 |
| GoodProgress（PROPERTY） | HOLDS / 1019 | HOLDS / 1955 |
| Finished（PROPERTY） | HOLDS / 1019 | HOLDS / 1955 |
| NothingMerged | VIOLATED / 69 | VIOLATED / 69 |
| NothingDeferredMerged | VIOLATED / 197 | VIOLATED / 209 |
| NothingParentWaived | VIOLATED / 242 | VIOLATED / 294 |
| NothingCrossWaived | HOLDS / 1019 | HOLDS / 1955 |
| NothingSpeechWaived | HOLDS / 1019 | HOLDS / 1955 |
| NothingRevivedWaived | HOLDS / 1019 | VIOLATED / 1476 |

`NothingMerged`、`NothingDeferredMerged`、`NothingParentWaived` 是反向写出的正向见证，VIOLATED 符合预期。其余三个 Nothing 性质排除坏路径，不能把它们的失败归为正向见证。

## 每项分歧的最短轨迹与分类

记 `G(A,B,S)` 为授权，`R(B,kind;p)` 为 Owner 撤销，`L(A,v;p)` 为 n1 名字律，`W(A,n)` 为豁免；p 为 premises。省略的范围为 `{n1,n2}`，省略的名字前提为 `{0}`，项处置前提为空。轨迹事件数不含初态。完整事件记录、最终状态及具体反例均在 `runs/PiDagAuth4-a4-<性质>-scenarios.log`，机器可读最短日志摘录在 `runs/PiDagAuth4-results.json`。

分类使用任务的 (a)/(b)/(c)。**(b) 以下特指相对 a3 输入语义，Rel2 新增限制拒绝原本合法的路径；不是说拒绝 stale CAS 违反 a4 自己的契约。** 这是“必须保留原真值”与“必须允许 stale premises”同时存在时暴露的兼容性问题。

| 分歧 | 最短日志 | 后果与归因 |
|---|---|---|
| AuthoritySound | `G(Owner,P1,{n1}); R(P1,future;{0})`（2） | 撤销应引用位置 1，a4 拒绝它，原 Eff 仍把所有 Owner revoke 当有效，故实现有权而参照无权。**(b) Rel2 相对 a3 过严／真值输入协议不兼容**；不是已证明 a4 有非法活链。 |
| DecisionAuthority | `G(Owner,P1); R(P1,future;{0}); G(P1,P2); W(P2,n1)`（4） | a4 拒绝第二步后链仍有效，P2 的处置被接受；Eff 从第二步起已断链。**(b)**，与上一行同源。 |
| UnrelatedPreserves | `G(Owner,P1); G(P1,P2); W(P2,n1); R(P1,future;{1})`（4） | 本次撤销前提正确且键未变；动态 Authorized 失效让旧免不再覆盖，但 a3 保留 future 之前的免。**(c) a3 既有免律的 future 保留规则未由逐时 Counts 推出**。 |
| ConflictDebt | `G(Owner,P1); G(Owner,P2); L(P1,0;{0}); L(P2,1;{0})`（4） | 第二条律 stale 被拒绝，原真值仍要求 §；同时，即便使第二条律知情，Counts 也没有生成 §/共同上级的归约规则。该日志含 **(b)**，独立剩余问题为 **(c) K8 异主同档冲突债与共同上级兑现者**，下文用消融分离。 |
| SamePrincipalSupersedes | `G(Owner,P1); L(P1,0;{0}); L(P1,1;{0})`（3） | 最后一条应引用位置 2；a4 拒绝，原 a3 要求最新的有权同主体律替换。**(b) Rel2 拒绝 a3 允许的同主体更新**。 |
| RetroHonored | `G(Owner,P1); G(P1,P2); W(P2,n2); R(P1,retro;{0})`（4，chain 族） | stale retro 未生效，旧免仍 Count；原真值按 Owner revoke 要求追溯失效。**(b)**。不能把这条日志单独当成正确前提的 retro 失效算法漏洞。 |
| FuturePreserves | `G(Owner,P1); G(P1,P2); W(P2,n1); R(P1,future;{1})`（4） | 正确前提仍使旧免因当前授权消失而失效。**(c)**，与 UnrelatedPreserves 同一时间语义问题。 |
| NothingRevivedWaived | `G(Owner,P1); G(P1,P2); R(P1,future;{0}); G(Owner,P1,{n1}); W(P2,n1)`（5） | 第三、四步都引用 stale 创世值而被 a4 拒绝；a4 旧链实际从未断开，原 Eff 却认为断后重授不能复活下游。**(b)**；不是 Prune 把已断旧边复活。 |
| AllSafety | 同 AuthoritySound（2） | 合取首次失败，无额外独立根因。 |

这里没有把任何已发现分歧硬归为 **(a) Rel 太窄**。auth 不含否定观，无法借这些运行评价 Rel1 在跨键否定清除上的覆盖。

**冲突规则的分离证据。** `a4-noInformed/ConflictDebt` 仍在四事件轨迹失败，第二条律此时实际接受并成为赢家，故问题不止是 stale CAS。纯代码推导（不是另一次 TLC 轨迹）：在 a4 原模式把上述第四步 premises 改为 `{3}`，Authorized、Informed、Recused 均为真，两条不同主体律都接受；通用名字更新取后值，仍不会产生 § 或 Owner resolver。最新值引用只证明“看过前值”，不证明“同意前值”，也不编码同档冲突的裁决结果。由此不能通过把 Rel2 放宽来补回 K8 冲突债。

**future/retro 的分离证据。** 去掉 Informed 后，RetroHonored 恢复通过，但 FuturePreserves、UnrelatedPreserves 仍失败。后两者反例的 premises 本来就是正确的。K8 的有效授权链只能说明此时谁有权，不能自行编码“future 保留旧免、retro 永久作废旧免”这两个不同时间效果。这里严格没有在 a4 填回 `invalid := invalid ∪ cut` 的特例。

## 消融翻转

六个消融各检查原 11 项安全性质、2 项活性性质、3 个正向见证，共 16 项；不是运行所有旧 a3 消融，也未声称每个消融的 free 模式都已验证。

| 消融 | 相对 a4 翻转的性质 |
|---|---|
| a4-noAuth | UnrelatedPreserves：VIOLATED→HOLDS；StateRemainsDebt：HOLDS→VIOLATED；FuturePreserves：VIOLATED→HOLDS |
| a4-noInformed | AuthoritySound、DecisionAuthority、SamePrincipalSupersedes、RetroHonored：VIOLATED→HOLDS |
| a4-noRecused | NoWriterJudge、NoAuthorJudge：HOLDS→VIOLATED |
| a4-noRel1 | 无翻转：该字母表无否定/归因；N/A，本模型内冗余 |
| a4-noRel2 | AuthoritySound、DecisionAuthority、SamePrincipalSupersedes、RetroHonored：VIOLATED→HOLDS；与 noInformed 相同 |
| a4-noRel3 | 无翻转：没有完整变更义务状态向量；N/A，本模型内冗余 |

未列的受测性质没有翻转。noInformed 与 noRel2 在此模型等价，因为唯一非空 Informed 约束是名字前值；不能宣称 Informed 与 Rel2 是两个独立必要条件。改善原性质也算“结果翻转”，但不能把这种翻转宣传为去掉知情更安全，它主要反映原真值不识别 CAS 拒绝。

消融破坏正向约束的最短证据：

- noAuth：state 族中 Owner 一步豁免状态项，StateRemainsDebt 失败。权限表也承载作证者种类，不仅承载主体授权。
- noRecused / NoAuthorJudge：author 族中 Owner 一步豁免自己创作的 n1。
- noRecused / NoWriterJudge：Owner 授 W1；W1 豁免 W2 创作的 n2（2）。验证同 DAG 写者限制不是单项作者限制的同义反复。
- noAuth 的 AuthoritySound/DecisionAuthority 已经在 a4 失败，布尔结果不再翻转，不能因此说授权检查冗余。完整消融轨迹保留在各 `-ablation.log`。

## 正向及坏路径见证

- a4 `NothingMerged`：good 族 Owner 直接合入（1）；free 模式 Owner 豁免 n1 → 合入 n1（2）。
- a4 `NothingDeferredMerged`：Owner 缓判 → 带欠合入（2），Debt 仍非空。
- a4 `NothingParentWaived`：Owner→P1→P2，P2 豁免 n1（3）。合法父级并未被一概禁签。
- `NothingCrossWaived`、`NothingSpeechWaived` 在 a4 场景完整图通过；`NothingRevivedWaived` 的变化是上表的 stale 撤销语义差异。
- `GoodProgress`、`Finished` 在原有限待办和弱公平假设下均通过，没有观察到活锁。这不否认 Rel2 拒绝了单个 a3 合法更新，也不证明生产环境在持续 stale 请求下可前进。

## free 穷举模式与 a22 sanity

| 检查 | 结果 | distinct states | 实际 TLC rc |
|---|---|---:|---:|
| a4 AllSafety，MaxLog=2 | VIOLATED | 8812 | 12 |
| a4 AllSafety，MaxLog=3（限制前历史） | VIOLATED | 34642 | 12 |
| a4 AllSafety，MaxLog=3（当前执行计划） | **deferred to parent** | — | 未运行 |
| a22 AuthoritySound，MaxLog=2 | VIOLATED | 11802 | 12 |
| a22 DecisionAuthority，MaxLog=2 | VIOLATED | 8765 | 12 |
| a22 NoWriterJudge，MaxLog=2 | VIOLATED | 10028 | 12 |
| a4 NothingMerged，MaxLog=2，正向见证 | VIOLATED | 30372 | 12 |

两次 a4 AllSafety 都返回 `G(Owner,P1,{n1}); R(P1,retro;{0})`：第二步引用旧创世前值，a4 保留权限，原 Eff 撤权。单步从创世出发没有 stale 名字值可引用，也不能形成该权限差异；两事件反例最短，且 1 worker 场景轮有同根因最短性证据。多 worker 的 visited 数可能随调度改变。

**没有声称 free 长度 2 或 3 的全部序列已检查完。** TLC 在首个反例处正常以 12 退出。MaxLog=3 驱动墙钟约 6.738 秒，未接近 2400 秒上限；无需为了已经反驳的 AllSafety 继续跑完整图。a3 父级已验收的 9,305,311 状态／10m41s 是旧模式结果，不能移作本 a4 的通过证据。

a22 sanity 的最短轨迹分别为：无权 P1→P2 后 Owner 才授 P1（言授权激活）；Owner 只授 P1 的 n1 后 P1 降级 n2（越范围）；Owner 授 W1 的 n1 后 W1 降级自己的 n1（写者自审）。这三项都复现原漏洞。

## 契约问题与建议（未修改契约）

1. **名字 CAS 与旧真值的边界。** 旧 Eff 把所有 Owner revoke 当有效，旧 Laws/FLaws 把有权 raw law 当有效；a4 明文要求正确前值。两者无法在可提交 stale 的同一输入环境中等价。建议父级明确：比较的是共同的合法输入子集，还是允许 a4 拒绝旧协议本会生效的尝试。若要比较新协议下的安全性，需要另立不调用实现 Counts 的、独立重建名字前值与签发准入的参照；这会改变真值契约，故本 leaf 未做。只过滤 stale 环境会隐藏本任务要求的实验，不能作为当前修复。
2. **项肯定的权限有效时刻。** 当前逐时 Counts 读当前 Witnesses/有效授权。若预期 future 不撤已有免，需明确项肯定的授权资格是签发时冻结，还是当前检查；若冻结，还需说明 retro 的永久失效如何由通用历史语义表达。a3 模型和报告已有这项区别，当前 a4 三个谓词未给出相应表示。建议先钉住时间参数，而不是在代码里私加 future 例外。
3. **同档冲突是值归约，不只是断言准入。** 建议明确一个通用名字冲突值域/归约语义（含同主体替换、异主体同档 §、共同上级责任），或承认 K8 这一部分仍是一条外部归约规则。单独的“有权、知情、回避”布尔值不产生 resolver。此结论限定于钉住的表示，不是声称任何未来统一代数都不可能表达冲突。
4. **Rel1/Rel3 的实验覆盖缺失。** 需要含否定、原键归因和真实变更义务向量的模型验证；这些属于 merge/扩展 auth 的另一里程碑。本模型的无翻转不能推翻它们在完整契约中的必要性。

此外，原 `ScenarioUnrelatedPreserves` 读取实现的 invalid 标记，而 free 版本用独立 RetroCut；其“真值独立性”不是所有行都同样强。本次按要求保持原文，不借重写该性质掩盖逐时重算造成的差异。

## 精确复跑、审计与运行状态

工作目录：`/home/purboo/project/pi-things/pi-dag`。所有 TLC 均通过 `formal/a4/check.sh`，保持死锁检测开启，不使用模拟、对称约简或 NODEADLOCK。

完整逐次 argv、环境、原始 TLC rc、外层 rc、耗时和日志路径：`runs/PiDagAuth4-commands.json`。每次另有 `PiDagAuth4-driver-*.log` 保存 `bash -x` 的 `rc=`，不把 runner 外层成功当成性质通过。

当前受限复跑入口及已有结果审计（不启动 TLC）：

```bash
# 会串行启动 141 次受限 TLC；本次收到限制后没有执行此命令。
python3 formal/a4/runs/PiDagAuth4-driver.py
# 仅审计已有文本/哈希，不启动 TLC。
python3 formal/a4/runs/PiDagAuth4-audit.py
```

当前驱动器顺序固定：a3/a4 全场景 → 六项消融 → free2 → a22 sanity → free 正向见证。每次 check.sh 都使用 `nice -n 19 taskset -c 0`、WORKERS=1、TLC_HEAP=1g；**MaxLog=3 输出 `deferred to parent`，不启动**。历史 142 次的精确 argv 保存在 `PiDagAuth4-commands.json`，不改写它们的真实资源参数；当前脚本不是历史资源配置的逐字复现。

当前限制允许的等价批量命令如下（本次没有再执行）：

```bash
WORKERS=1 TLC_HEAP=1g TLC_TIMEOUT=900 nice -n 19 taskset -c 0 bash -x formal/a4/check.sh PiDagAuth4 'a3 a4' 'AuthoritySound DecisionAuthority NoWriterJudge NoAuthorJudge RelevantInvalidates UnrelatedPreserves StateRemainsDebt ConflictDebt SamePrincipalSupersedes RetroHonored FuturePreserves AllSafety P:GoodProgress P:Finished NothingMerged NothingDeferredMerged NothingParentWaived NothingCrossWaived NothingSpeechWaived NothingRevivedWaived' 'Scope = "scenarios"; MaxLog = 5; Owner = Owner; P1 = P1; P2 = P2; W1 = W1; W2 = W2' '-scenarios'
WORKERS=1 TLC_HEAP=1g TLC_TIMEOUT=900 nice -n 19 taskset -c 0 bash -x formal/a4/check.sh PiDagAuth4 'a4-noAuth a4-noInformed a4-noRecused a4-noRel1 a4-noRel2 a4-noRel3' 'AuthoritySound DecisionAuthority NoWriterJudge NoAuthorJudge RelevantInvalidates UnrelatedPreserves StateRemainsDebt ConflictDebt SamePrincipalSupersedes RetroHonored FuturePreserves P:GoodProgress P:Finished NothingMerged NothingDeferredMerged NothingParentWaived' 'Scope = "scenarios"; MaxLog = 5; Owner = Owner; P1 = P1; P2 = P2; W1 = W1; W2 = W2' '-ablation'
WORKERS=1 TLC_HEAP=1g TLC_TIMEOUT=900 nice -n 19 taskset -c 0 bash -x formal/a4/check.sh PiDagAuth4 'a4' 'AllSafety' 'Scope = "free"; MaxLog = 2; Owner = Owner; P1 = P1; P2 = P2; W1 = W1; W2 = W2' '-free2'
WORKERS=1 TLC_HEAP=1g TLC_TIMEOUT=900 nice -n 19 taskset -c 0 bash -x formal/a4/check.sh PiDagAuth4 'a22' 'AuthoritySound DecisionAuthority NoWriterJudge' 'Scope = "free"; MaxLog = 2; Owner = Owner; P1 = P1; P2 = P2; W1 = W1; W2 = W2' '-sanity2'
WORKERS=1 TLC_HEAP=1g TLC_TIMEOUT=900 nice -n 19 taskset -c 0 bash -x formal/a4/check.sh PiDagAuth4 'a4' 'NothingMerged' 'Scope = "free"; MaxLog = 2; Owner = Owner; P1 = P1; P2 = P2; W1 = W1; W2 = W2' '-witness2'
# MaxLog=3 exhaustive: deferred to parent
```

正式运行模块从头到尾同一哈希。最长单次驱动墙钟 13.816 秒。初步 `-smoke` 证据属于开发中哈希，不计入 142 次正式结果。实现时补齐了两处必须区分的编码：附加 premises 后 pending 仍删除原事件模板；项视图每次重算 Counts，避免只检查签发而错误保留 future 豁免。未发现需要修补原 a3 或契约的编码错误。审计脚本首次运行暴露本机 Python 不支持 `str.removeprefix`，已用正则前缀移除修复；该脚本兼容性修复不改变模块或 TLC 结果。

`PiDagAuth4-results.json` 保存每个检查的结果、状态数和完整最短事件串；`PiDagAuth4-tables.md` 是从该证据生成的表格。限制生效后的脚本语法、单核/低优先级资源设置及无遗留进程检查见 `PiDagAuth4-final-state.json`；这些检查没有启动 TLC。正式检查及审计已完成；无本任务遗留 TLC、驱动器或 states 目录，无发布、提交或分支验收动作。当前 MaxLog=3 计划为 **deferred to parent**；交由父级审阅上述协议/时间语义问题后决定下一里程碑。
