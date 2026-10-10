# auth：a3 授权历史、免律与冲突的有界检查

当前模型：`PiDagAuth3.tla`，SHA256 `4e33cdf2dc776ed8501dab5cd3f86805a9ea8b3e63e2ac7a46d4badd259f21c0`。新增 `Scope="free"` 任意混合探索；`Scope="scenarios"` 保留已验收的场景轮。工作目录 `/home/purboo/project/pi-things/pi-dag`；只写本模块、本报告及 `runs/PiDagAuth3-*`，未运行 git 或修改共享文件。

下方原有场景表对应已验收 SHA256 `32122309e3974da393da1888fe9d461d4a16704bb89535bf2d007fca9b0ce526`，不是当前 free 探索的证明。新增 free 结果、限制和精确命令见文末。

场景轮结论：在下述有限场景中，a3 的 11 项安全检查、2 项活性检查均 HOLDS；正常合入、带欠缓判后合入、父级签免的三个非空见证均如预期 VIOLATED。a22 复现指定的言授权、交叉豁免、自降级、同档兄弟覆盖、错误键绑定和撤销后复活。13 个消融模式全部至少翻转一项性质。该轮未发现 a3 反例，未增加 a3fix；这不是任意日志上的证明。

## 已验收场景轮：模型边界与独立真值

- `MaxLog=5`；五个 model values：Owner、P1、P2、W1、W2；两个义务范围 n1/n2。P1/P2 在同档律场景中为兄弟父级，共同上级 Owner；在授权链场景中允许 P1 转授 P2，授权图与 DAG 组织关系不混同。
- 初始非确定选择 18 个事件族，枚举族内每个事件至多一次的全部排列；包括长度五的复活和三级授权链族。不同族不混合。完整图 1,019 个不同状态，BFS 失败轨迹在该模型内最短。增加 MaxLog 不会自动增加族内事件。
- 守卫采用 `edges` 增量集合、`Close` 图闭包和撤销时 `Prune` 级联永久删边。无效断言仍入 `log`，不会因守卫拒绝而从历史消失。
- 独立参照 `Eff(p,t,k)` **只读原始 log**，递归重建签发时权限、每个中间前缀的连续性和直接撤销；返回 p 的有效范围集合，k=5 限深。它不调用 Close、Rights、Prune、CanDecide，也不读取 edges、accepted、invalid。
- `AuthoritySound` 比较当前实现权限与 Eff；`DecisionAuthority` 比较所有已接受处置与其签发前的 Eff。范围由 n1/n2 表示，同一权限表服务 waive/downgrade/defer。
- 作者真值来自独立初始创作事实 `ActualAuthorship`；历史写者真值来自不可抹除的 `GenesisExecution` 执行回执。守卫读作者目录和写者集合/槽缓存，性质检查实际创作与执行历史。该有界模型假定创世目录准确，不检验目录伪造。
- 项的真实键与候选内容分别计数：unrelated 只改内容；related 同时改二者；closure 只改键，表示检查闭包或环境类别改变。状态项在模型中始终未证，以输出 D/W 分区检查其不能被抹去。
- 冲突参照从原始日志加 Eff 重建各主体最后有效律；实现输出 `lawWinner/lawValue/conflict/resolver`。a22 异主后立律实际覆盖先立律；a3 无赢家并将 § 交 Owner。同一主体照常替换。
- `WF_vars(Advance)` 保证尚有动作可执行时不会无限停顿。`GoodProgress` 覆盖 good 和 deferred 两族：合入意图保留到可执行，缓判签发后合入仍保留欠。`Finished` 要求最终处理完有限待办。仅 `pending={}` 才有显式 Terminal；所有运行均开启死锁检测，无死锁。
- 角色不对称，任意互换 model values 不保语义，故没有声明非平凡 SYMMETRY；活性也未使用对称约简。

## 性质 × 模式

单元格为结果 / TLC distinct states。多 worker 提前发现反例时，访问状态数可有调度差异；通过检查的完整图固定为 1,019。

| 性质 | a22 | a3 |
|---|---|---|
| AuthoritySound | VIOLATED / 76 | HOLDS / 1019 |
| DecisionAuthority | VIOLATED / 203 | HOLDS / 1019 |
| NoWriterJudge | VIOLATED / 125 | HOLDS / 1019 |
| NoAuthorJudge | VIOLATED / 236 | HOLDS / 1019 |
| RelevantInvalidates | VIOLATED / 336 | HOLDS / 1019 |
| UnrelatedPreserves | VIOLATED / 297 | HOLDS / 1019 |
| StateRemainsDebt | VIOLATED / 137 | HOLDS / 1019 |
| ConflictDebt | VIOLATED / 685 | HOLDS / 1019 |
| SamePrincipalSupersedes | HOLDS / 1019 | HOLDS / 1019 |
| RetroHonored | HOLDS / 1019 | HOLDS / 1019 |
| FuturePreserves | HOLDS / 1019 | HOLDS / 1019 |
| GoodProgress（PROPERTY） | HOLDS / 1019 | HOLDS / 1019 |
| Finished（PROPERTY） | HOLDS / 1019 | HOLDS / 1019 |
| NothingMerged（正向见证） | VIOLATED / 142 | VIOLATED / 141 |
| NothingDeferredMerged（正向见证） | VIOLATED / 293 | VIOLATED / 338 |
| NothingParentWaived（正向见证） | VIOLATED / 212 | VIOLATED / 248 |
| NothingCrossWaived（坏路径排除） | VIOLATED / 124 | HOLDS / 1019 |
| NothingSpeechWaived（指定次序） | VIOLATED / 342 | HOLDS / 1019 |
| NothingRevivedWaived（五事件次序） | VIOLATED / 1019 | HOLDS / 1019 |

`SamePrincipalSupersedes`、`RetroHonored`、`FuturePreserves` 是保留语义的回归性质，a22 本就应成立。因此没有为满足“每项 a22 都 VIOLATED”的字面要求而人为破坏 a22；这三项与该统一预期不一致，结果如表所示。

## 最短失败轨迹（与最终日志一致）

下列箭头是日志事件，不包括初始状态；括号为事件数。省略的授权范围为 {n1,n2}。每项完整轨迹：`runs/PiDagAuth3-<mode>-<property>.log`。

| a22 性质 | 最短轨迹及实际后果 |
|---|---|
| AuthoritySound | P1→P2 言授权；Owner→P1 授 n1（2）。旧边激活，P2 获 n1，独立 Eff 仍为空。 |
| DecisionAuthority | Owner→P1 仅授 n1；P1 降级 n2（2）。宽松的旧降级权限表接受越范围处置。 |
| NoWriterJudge / NothingCrossWaived | Owner→W1；W1 豁免 W2 作者的 n2（2）。不是本项作者仍是同 DAG 写者。 |
| NoAuthorJudge | Owner→W1；W1 降级自己创作的 n1（2）。旧降级没有统一避。 |
| RelevantInvalidates | Owner 豁免 n1；改变闭包/环境类别（2）。内容相同而键改变，旧内容豁免仍覆盖新项。 |
| UnrelatedPreserves | Owner 豁免 n1；无关内容修改（2）。键仍相同，但旧内容豁免失效。 |
| StateRemainsDebt | Owner 豁免未证状态项（1）。状态项进入 W，D 被清空。 |
| ConflictDebt | Owner→P1；Owner→P2；P1 立值 0；P2 立值 1（4）。P2 成为赢家，无 § 和共同上级兑现者。 |
| NothingSpeechWaived | W1→W2；Owner→W1；W2 豁免 n1（3）。精确复现要求的先转授、后获权、再豁免。 |
| NothingRevivedWaived | Owner→P1；P1→P2；future 撤 P1；Owner 重授 P1 的 n1；P2 豁免 n1（5）。旧下游授权复活；Eff 拒绝。 |
| NothingMerged | 好候选合入（1）。预期正向见证。 |
| NothingDeferredMerged | Owner 缓判；合入且状态项仍在 D（2）。预期正向见证。 |
| NothingParentWaived | Owner→P1 仅授 n1；P1 降级 n2（2）。这里 W 包括降级，所以 a22 最短见证同时暴露权限漏洞。 |

**a3 的三个预期 VIOLATED**：NothingMerged 为好候选直接合入（1）；NothingDeferredMerged 为 Owner 缓判→带欠合入（2）；NothingParentWaived 为 Owner→P1→P2→P2 豁免 n2（3），合法非写者父级确实能签免。a3 没有非预期失败轨迹。

## 消融

所有行均为从 a3 切换一个命名规则开关；未列的模式/性质组合未运行，不暗示全笛卡尔积已查。

| 模式 | 消融/替代规则 | 翻转的性质 | 结果 / distinct states |
|---|---|---|---|
| a3-issue | 允许尚无权者的言授权进入待激活图 | AuthoritySound | VIOLATED / 76 |
| a3-scope | 已有权者可扩大转授范围 | AuthoritySound | VIOLATED / 83 |
| a3-continuous | 撤销不永久剪断下游旧边 | AuthoritySound；NothingRevivedWaived | VIOLATED / 552；1019 |
| a3-writers | 删除同 DAG 写者禁签，仍保留作者禁签 | NoWriterJudge | VIOLATED / 125 |
| a3-past | 只排除当前槽持有人 | NoWriterJudge | VIOLATED / 334 |
| a3-author | 删除本项作者禁签，仍保留写者禁签 | NoAuthorJudge | VIOLATED / 110 |
| a3-permission | 降级只需任意权限，不用共同的项范围表 | DecisionAuthority | VIOLATED / 251 |
| a3-key | 绑定整份内容而非项键 | RelevantInvalidates；UnrelatedPreserves | VIOLATED / 292；340 |
| a3-state | 允许状态项进入 W | StateRemainsDebt | VIOLATED / 126 |
| a3-conflict | 异主同档冲突恢复后立者赢 | ConflictDebt | VIOLATED / 686 |
| a3-same | 同主体保留第一条而非最后一条 | SamePrincipalSupersedes | VIOLATED / 347 |
| a3-retro | 追溯撤销不失效既有免律 | RetroHonored | VIOLATED / 729 |
| a3-future | future 也失效既有免律 | FuturePreserves | VIOLATED / 1019 |

消融范围的一个重要限制：K8 的“签发时有效”与“范围不超出当前有效权限”逻辑耦合；无权者的当前权限为空，若保留后者的空集子集检查，单删前者不会激活任何非空授权。`a3-issue` 因而消融完整的“无权签发不成为有效边”准入，并跳过无权时的范围比较；不是对两个逻辑独立谓词的正交消融。`a3-scope` 单独验证已有权者不能扩大范围。不能把这组结果宣称为 K8 两个文字分句完全独立的消融证明。

## 读法选择及未覆盖部分

- a22 采用任务明确指定的 **live-chain** 读法；无权签发先作为边保存，以后可激活。这与旧正文“此前已生效”的另一读法有张力，正是审查指出的歧义，并非声称所有 a2.2 解释都接受此路径。
- a22 的降级采用缺少统一权限表/避时的宽松读法：已有任意权限即可降级，豁免仍按项范围且排除作者。相应越范围反例依赖此读法；自降级反例只依赖旧降级没有避。
- 撤销只由 Owner 发起，删除目标主体此前所有入边；future 不撤既有免，retro 对该步失权的签免主体作追溯失效。被撤销主体的后续新签名均仍需当时有效，重授不清除已记 invalid。
- 连续性按被授范围判断：一条多范围边要求签发者在每个中间前缀都保有完整授出范围。是否应允许逐子范围部分存活，契约没有另述；本模型选择整条边语义。
- 场景轮只有一个当前项键/内容计数，编辑族只涉及 n1。新增 free 探索已覆盖双项独立键、动态作者/新增写者槽、多个独立入链、循环授权、重复重授及任意事件交错。两轮都未建模同名多义务、非 Owner 的有效撤销、撤销后冲突律重新求值、复杂共同上级树、K2 已封 owner 特例或完整风险权限矩阵。
- 三级链可达，但深度与族内事件有界；生产中的范围集合、任意混合日志和更深委托未获证明。冲突处理只建模 § 及兑现者，不建模上级最终裁决。
- 活性只针对有限待办和静态好候选/Owner 缓判，不涵盖持续新任务、永续撤销、外部执行器失败或完整合并队列。它能检查此模型中的冻结，不证明生产环境无饥饿。

## 复跑与证据

已验收场景轮共 53 次 TLC：21 次退出码 0，32 次预期 invariant violation 退出码 12；无超时、死锁或运行错误。Java 11，TLC 每次报告用时至多 1 秒；每次 2 workers、1 GiB heap、120 秒超时。53 对 cfg/log 均匹配上述**历史场景轮模块 hash**，cfg hash 也匹配文件。完整原始退出码及精确命令见 `runs/PiDagAuth3-final-exits.log`（bash -x 记录的 `rc=`，check.sh 外层正常退出 0）。

历史主表命令如下；用当前模块复跑需在常量中额外加入 `Scope = "scenarios"`（项目根目录执行）：
```bash
WORKERS=2 TLC_HEAP=1g TLC_TIMEOUT=120 bash formal/a3/check.sh PiDagAuth3 'a3 a22' 'AuthoritySound DecisionAuthority NoWriterJudge NoAuthorJudge RelevantInvalidates UnrelatedPreserves StateRemainsDebt ConflictDebt SamePrincipalSupersedes RetroHonored FuturePreserves P:GoodProgress P:Finished NothingMerged NothingDeferredMerged NothingParentWaived NothingCrossWaived NothingSpeechWaived NothingRevivedWaived' 'MaxLog = 5; Owner = Owner; P1 = P1; P2 = P2; W1 = W1; W2 = W2'
```
消融同命令，模式替换为消融表第一列，性质替换为第三列（多项用空格）。全部检查只经 `formal/a3/check.sh`，未用 NODEADLOCK，未改 check.sh，未使用 pkill。

## 新增 free：任意事件交错及最终结果

`Scope="free"` 在每一步非确定选择同一个完整字母表，可重复事件，不受事件族约束。210 种选择包括：60 种非空范围授权（允许自授、重复授权）；40 种 future/retro 撤销尝试；30 种任一主体对任一项的 waive/downgrade/defer；20 种同档律断言；60 种任一主体对任一项的 unrelated/related/closure、acquire/release、merge。每个尝试都入账，权限守卫只控制其是否产生效果。父级 P1/P2 不可取得写者槽；Owner 可在槽释放后取得槽，此后永久受避限制。重复 grant 就是新的授权边，不是修改旧边。

- n1 是变更义务，n2 是未证状态不变式。各有独立 key/content，编辑只影响指定项；给 n2 的缓判仍留下状态欠。related 编辑同时更新作者目录，独立 `AuthorAt` 从原始历史重建签发当时的实际作者；只以初始作者判断的漏洞不再隐藏。
- `Eff(p,t,MaxLog+1)` 沿完整原始历史判断授权，而实现仍使用增量 edges/Prune。授权环、多入链、撤销、重复重授可以混合；非 Owner 撤销在本创世策略中是无权尝试，真值与实现都不把它当撤销。Owner 删除目标的全部旧入边，此撤销政策沿用已验收场景轮，不声称验证了更细粒度的委托者撤销。
- `SlotAt`、`EverAt` 重建实际槽取得/释放历史，不读 slots/everSlots 缓存；`TrueKey` 独立数相关/闭包编辑，不读 key/content 缓存；律真值按原始断言和签发前 Eff 重建，不读 lawView。`FreeCanDecide` 不参与任何真值计算。
- NoAuthorJudge/NoWriterJudge 按**签名时**的作者/历史写者判断；后来的写槽取得不会追溯撤销既有签免。retro 的范围取本次撤销真正失权的签发主体；future 不撤既有签免，但后续相关编辑或另一次 retro 仍可使它失效。
- 组织档位固定为 Owner > {P1,P2} > {W1,W2}；同档不同主体冲突交 Owner。只建模冲突债形成，不模拟上级裁决后如何清债。撤销也不重新裁定既有普通律；这不是完整立法系统模型。
- 每次有限日志实验在 `Len(log)=MaxLog` 完成，仅该状态显式 stutter。所有其他前缀都仍有所有事件可选；未用 NODEADLOCK。这里的完成是**有界实验结束**，不是生产 DAG 已完成；不拿该终止证明生产系统活性。场景轮仍检查 WF_vars(Advance) 下的 GoodProgress/Finished 和正向见证。
- `AllSafety` 是上述 11 项安全性质的合取；一次遍历检查全部合取项，无须重复 11 次相同状态图。free 中各性质都检查实际项/历史，没有 `family="keys"`、`family="future"` 等场景筛选导致的空覆盖。SamePrincipalSupersedes 检查每项、每主体的最后有效律，ConflictDebt 独立检查异主冲突输出。

完整日志前缀数为 `1 + 210 + ... + 210^MaxLog`：深度 2 为 44,311，深度 3 为 9,305,311，深度 4 为 1,954,115,311，深度 5 为 410,364,215,311。本轮未使用对称约简：Owner/父级/写者或 n1/n2 的交换不保语义；free 中 P1/P2 的单独交换可能进一步约简，尚未单独验证和启用，不把当前可完成深度宣称为所有优化后的极限。未裁剪无权尝试或事件排列来降低这个数。

正式检查已结束。当前模型未发现新的 a3 反例，未增加 a3fix。**完整穷举通过的最大已测深度是 2；深度 3、4 均超时。正式模拟已报告超过 100 万条轨迹且未报告反例，但整批未完成，不能记为 HOLDS-SIM。**

### free 性质 × 模式

a3 的两列均由一次 `AllSafety` 合取检查覆盖全部 11 项，状态数不应乘以 11。a22 只检查任务指定的三个 sanity 性质，另以 MaxLog=2 验证最短轨迹。free 本轮只运行 a3/a22；13 项消融证据仍属于上面的场景轮。

| 性质 | a22 free，MaxLog=2 | a3 free，MaxLog=2 | a3 free 模拟，MaxLog=6 |
|---|---|---|---|
| AuthoritySound | VIOLATED / 11,802 | HOLDS / 44,311 | TIMEOUT¹ |
| DecisionAuthority | VIOLATED / 9,439 | HOLDS / 44,311 | TIMEOUT¹ |
| NoWriterJudge | VIOLATED / 10,473 | HOLDS / 44,311 | TIMEOUT¹ |
| NoAuthorJudge | 未运行 | HOLDS / 44,311 | TIMEOUT¹ |
| RelevantInvalidates | 未运行 | HOLDS / 44,311 | TIMEOUT¹ |
| UnrelatedPreserves | 未运行 | HOLDS / 44,311 | TIMEOUT¹ |
| StateRemainsDebt | 未运行 | HOLDS / 44,311 | TIMEOUT¹ |
| ConflictDebt | 未运行 | HOLDS / 44,311 | TIMEOUT¹ |
| SamePrincipalSupersedes | 未运行 | HOLDS / 44,311 | TIMEOUT¹ |
| RetroHonored | 未运行 | HOLDS / 44,311 | TIMEOUT¹ |
| FuturePreserves | 未运行 | HOLDS / 44,311 | TIMEOUT¹ |

¹ 模拟命令为 `SIMULATE="num=500000" DEPTH=8 WORKERS=4 TLC_HEAP=3g TLC_TIMEOUT=900`。TLC 将 num 按 worker 计，目标为 2,000,000 条；最后进度行报告 **1,043,507 traces generated / 8,348,032 states checked**，无反例，900 秒退出码 **124**。这些是最后一次进度快照，不是正常结束的最终计数；模拟状态数不是 distinct states。样本量已超过 500,000，但不能把未完成的整批当作正常结束的 HOLDS-SIM。深度 6/8 各另有正常结束的小规模模拟，均为 HOLDS-SIM / 4,000 traces / 32,001 states，仅作运行验证。

| a3 AllSafety 穷举 | 结果 | 最后记录的 distinct states | TLC rc |
|---|---|---:|---:|
| MaxLog=2 | HOLDS，约 11 秒 | 44,311（完整） | 0 |
| MaxLog=3 | TIMEOUT，600 秒 | 4,415,439（部分） | 124 |
| MaxLog=4 | TIMEOUT，600 秒 | 5,077,555（部分） | 124 |
| MaxLog=5 | 未运行：4 已超时，完整图还要扩大约 210 倍 | — | — |

未断言在深度 2 下每一条件性质都有非空前提，例如异主父级冲突至少需要两次授权和两次立律；该路径的非空性由已验收场景轮保证，深度 6 模拟只补充自由交错探索，不是更深穷举证明。

### free 最短反例与非空见证

MaxLog=4 的最终 sanity 均 VIOLATED：AuthoritySound / 46,032 states，DecisionAuthority / 34,216，NoWriterJudge / 38,893。首轮多 worker 搜索返回的两条轨迹带一个无作用撤销前缀（首轮 TLC 日志保留为 `*-free-sanity4-first.log`），因此另跑 MaxLog=2，而不直接声称首次返回的轨迹最短。以下轨迹与 `runs/PiDagAuth3-a22-<property>-free-min2.log` 完全一致；单步不可能给无权非 Owner 建立有效路径再越权，所以两步为最短。

- AuthoritySound：无权 P1 向 P2 授 `{n1}`；Owner 后来才向 P1 授 `{n1}`。旧 live-chain 激活先前的言授权，P2 获 n1，独立 Eff 拒绝。
- DecisionAuthority：Owner 向 P1 仅授 `{n1}`；P1 降级 n2。旧降级表接受越范围处置。
- NoWriterJudge：Owner 向 W1 授 `{n1}`；W1 降级自己创作的 n1。写者/作者自审被接受。
- free 正向见证 `NothingMerged`：a3 VIOLATED / **31,492 states**，轨迹为 Owner 豁免 n1 → Owner 合入 n1。自由模式确实允许合法工作完成，不是把所有处置或合入禁掉来通过性质。

最终树也复跑了 `Scope="scenarios"`：AllSafety、GoodProgress、Finished 各 HOLDS / 1,019；NothingMerged、NothingDeferredMerged、NothingParentWaived 如预期 VIOLATED，分别为 196、328、360 states。证据后缀均为 `-scenario-regression`，包括弱公平下的活性与带欠缓判合入见证。

### runner 分类问题及复跑证据

**共享 runner 的额外发现，未修改其文件**：正式模拟的 `runs/PiDagAuth3-driver-free-sim6.log:38` 明确记录 `rc=124`，但第 43–50 行用 `^Finished` 匹配了日志中的 `Finished computing initial states`，遂输出 HOLDS-SIM 并退出 0。报告以真实 TLC/timeout 退出码覆写这个错误分类。父级可将模拟成功判据限定为正常退出和真正的结束摘要；不能只信本次 check.sh 的表格或外层退出码。

正式驱动器为 `runs/PiDagAuth3-free-driver.py`，执行 `python3 formal/a3/runs/PiDagAuth3-free-driver.py` 可复跑 2→4→（4 成功才 5，否则 3）、a22 三项 MaxLog=4 sanity、正式 MaxLog=6 模拟。它串行调用 check.sh，穷举上限 600 秒、模拟上限 900 秒，每次 WORKERS=4、heap=3g。`runs/PiDagAuth3-free-status.json` 保存精确参数和外层退出码；实际 TLC rc 保存在对应 `runs/PiDagAuth3-driver-*.log` 的 bash -x 记录中。当前没有遗留的本任务 TLC 进程。

补充检查的精确命令（项目根目录；bash -x 记录实际 rc）：
```bash
WORKERS=4 TLC_HEAP=1g TLC_TIMEOUT=60 bash -x formal/a3/check.sh PiDagAuth3 'a3' 'AllSafety P:GoodProgress P:Finished NothingMerged NothingDeferredMerged NothingParentWaived' 'Scope = "scenarios"; MaxLog = 5; Owner = Owner; P1 = P1; P2 = P2; W1 = W1; W2 = W2' '-scenario-regression' 2> formal/a3/runs/PiDagAuth3-driver-scenario-regression.log
WORKERS=4 TLC_HEAP=1g TLC_TIMEOUT=60 bash -x formal/a3/check.sh PiDagAuth3 'a22' 'AuthoritySound DecisionAuthority NoWriterJudge' 'Scope = "free"; MaxLog = 2; Owner = Owner; P1 = P1; P2 = P2; W1 = W1; W2 = W2' '-free-min2' 2> formal/a3/runs/PiDagAuth3-driver-free-min2.log
WORKERS=4 TLC_HEAP=1g TLC_TIMEOUT=60 bash -x formal/a3/check.sh PiDagAuth3 'a3' 'NothingMerged' 'Scope = "free"; MaxLog = 2; Owner = Owner; P1 = P1; P2 = P2; W1 = W1; W2 = W2' '-free-witness2' 2> formal/a3/runs/PiDagAuth3-driver-free-witness2.log
WORKERS=4 TLC_HEAP=3g TLC_TIMEOUT=60 bash -x formal/a3/check.sh PiDagAuth3 'a22' 'AuthoritySound DecisionAuthority NoWriterJudge' 'Scope = "free"; MaxLog = 4; Owner = Owner; P1 = P1; P2 = P2; W1 = W1; W2 = W2' '-free-sanity4' 2> formal/a3/runs/PiDagAuth3-driver-free-sanity4.log
```
最后一组补跑是为修复本任务驱动器只按 tag 命名 stderr 导致三项 sanity 相互覆盖的问题；驱动器现按 mode+property+tag 命名，最终三项实际 rc 均已完整保留。未改动模型或共享 runner。

`runs/PiDagAuth3-final-free-audit.json` 审计当前模块的 19 对正式 cfg/log：模块哈希和各 cfg 哈希均匹配，真实退出码为 6 次 0、10 次 12、3 次 124；对应 4 HOLDS、2 小规模 HOLDS-SIM、10 预期 VIOLATED、3 TIMEOUT。没有残留本任务 TLC 进程或 states 目录。首轮留存日志、中止记录及旧场景轮证据不混计进这 19 对。

调试记录：`*-free-ex4-pre-author.log` 在补齐动态作者后主动中止；`*-free-ex4-pre-flat.log` 在确认 TLC 无法展开外层 IF 后主动中止。随后将 Advance 等价改写为析取/存在量化，让 TLC 在模拟时直接选择事件。两份旧哈希的中止记录均不计为正式穷举或通过证据；只停止本次驱动器及其确定的子进程，没有触碰其他 worker。


## 父级补充（2026-10-08）

- runner 误判已在 `check.sh` 修正：rc=124 记为 TIMEOUT；HOLDS-SIM 要求 rc=0 且日志有 "Finished in"。复测：`runs/PiDagAuth3-a3-AllSafety-runnerfix-timeout.log` 判为 TIMEOUT，`runs/PiDagMerge-a3-FreeCoreSafety-runnerfix-ok.log` 判为 HOLDS-SIM。
- 父级补跑 free 穷举 MaxLog=3：`WORKERS=16 TLC_HEAP=20g TLC_TIMEOUT=3600`，当前模块 SHA256 `4e33cdf2…`。AllSafety（11 项）**HOLDS**，9,305,311 个不同状态，深度 4，用时 10 分 41 秒。日志：`runs/PiDagAuth3-a3-AllSafety-free-exh3-long.log`。
- 因此 free 模式下，穷举覆盖到长度 3 的任意事件序列；长度 4–6 只有未跑完的随机模拟。
