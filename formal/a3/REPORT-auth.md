# auth：a3 授权历史、免律与冲突的有界检查

最终模型：`PiDagAuth3.tla`。模块 SHA256：`32122309e3974da393da1888fe9d461d4a16704bb89535bf2d007fca9b0ce526`。
工作目录 `/work/pi-dag`，非 Git 仓库；只交付本模块、本报告及 `runs/PiDagAuth3-*`。未修改 CONTRACT 或其他模型。

结论：在下述有限场景中，a3 的 11 项安全检查、2 项活性检查均 HOLDS；正常合入、带欠缓判后合入、父级签免的三个非空见证均如预期 VIOLATED。a22 复现指定的言授权、交叉豁免、自降级、同档兄弟覆盖、错误键绑定和撤销后复活。13 个消融模式全部至少翻转一项性质。未发现 a3 反例，未增加 a3fix；这不是任意日志上的证明。

## 模型边界与独立真值

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
- 只有一个当前项键/内容计数；编辑族只涉及 n1。没有同时多项键变化、同名多义务、动态作者/新增写者槽、多个独立入链交替维持权限、循环授权、非 Owner 撤销、任意重授次数、撤销后冲突律重新求值、复杂共同上级树、K2 已封 owner 特例或完整风险权限矩阵。
- 三级链可达，但深度与族内事件有界；生产中的范围集合、任意混合日志和更深委托未获证明。冲突处理只建模 § 及兑现者，不建模上级最终裁决。
- 活性只针对有限待办和静态好候选/Owner 缓判，不涵盖持续新任务、永续撤销、外部执行器失败或完整合并队列。它能检查此模型中的冻结，不证明生产环境无饥饿。

## 复跑与证据

最终共 53 次 TLC：21 次退出码 0，32 次预期 invariant violation 退出码 12；无超时、死锁或运行错误。Java 11，TLC 每次报告用时至多 1 秒；每次 2 workers、1 GiB heap、120 秒超时。53 对 cfg/log 均含并匹配最终模块 hash，cfg hash 也匹配文件。完整原始退出码及精确命令见 `runs/PiDagAuth3-final-exits.log`（bash -x 记录的 `rc=`，check.sh 外层正常退出 0）。

主表精确命令（项目根目录执行）：
```bash
WORKERS=2 TLC_HEAP=1g TLC_TIMEOUT=120 bash formal/a3/check.sh PiDagAuth3 'a3 a22' 'AuthoritySound DecisionAuthority NoWriterJudge NoAuthorJudge RelevantInvalidates UnrelatedPreserves StateRemainsDebt ConflictDebt SamePrincipalSupersedes RetroHonored FuturePreserves P:GoodProgress P:Finished NothingMerged NothingDeferredMerged NothingParentWaived NothingCrossWaived NothingSpeechWaived NothingRevivedWaived' 'MaxLog = 5; Owner = Owner; P1 = P1; P2 = P2; W1 = W1; W2 = W2'
```
消融同命令，模式替换为消融表第一列，性质替换为第三列（多项用空格）。全部检查只经 `formal/a3/check.sh`，未用 NODEADLOCK，未改 check.sh，未使用 pkill。
