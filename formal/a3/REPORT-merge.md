# Merge 模型回执：父级裁决后的 K1–K5

三项性质已按父级裁决收窄到正确的承诺范围；**此前三条轨迹不是 a3 契约漏洞，此结论已撤回**。同时修复了自由模型自身的一处失真：旧模型共用状态项与节点验收的观察格，缓判可能使缺少自身验收证据的节点被合入。现在二者分开，缓判只覆盖被修改的状态不变式项，不覆盖节点验收、强度或评审义务。

本轮受影响检查全部完成：**51 HOLDS、2 HOLDS-SIM、8 VIOLATED，共 61 项**。8 个 VIOLATED 均是 a22 缺陷或期望的合入见证；本轮没有 a3 承诺性质反例、超时、死锁或运行错误。随机通过不等于穷举证明。

## 文件、版本与重现

- 模型：[PiDagMerge.tla](PiDagMerge.tla)，当前 SHA256：`7972e7a830fe5a503653abc3c5e3edbf8f983f6d232254f41e05432927905957`。
- 当前逐项模式、性质、状态数、随机种子及日志索引：[PiDagMerge-results.tsv](runs/PiDagMerge-results.tsv)。61 条记录全部对应上述 SHA。
- 54 个固定场景检查及 6 个自由对照/见证：`python3 formal/a3/runs/PiDagMerge-ruling.py`。完整命令、环境、TLC 真实退出码在 [PiDagMerge-ruling-checks.log](runs/PiDagMerge-ruling-checks.log)；批次退出码为 0。
- 自由 a3 的核心合取检查命令如下；日志：[PiDagMerge-a3-FreeCoreSafety-ruling-free.log](runs/PiDagMerge-a3-FreeCoreSafety-ruling-free.log)。
- 所有 TLC 均经 `check.sh`，Java 11.0.27、TLC 2026.10.06.014338；死锁检测开启。固定场景单 worker、512m、90 秒上限；自由模拟 4 workers、1g，核心上限 570 秒，对照/见证上限 120 秒。没有并发启动多个自有 TLC。
- 只写本模块、本报告及 `runs/PiDagMerge-*`，未运行 Git 命令，未修改共享文件。没有运行中的自有检查、部署或发布动作。

```bash
WORKERS=4 TLC_HEAP=1g TLC_TIMEOUT=570 SIMULATE=num=10000 DEPTH=20 bash formal/a3/check.sh PiDagMerge 'a3' 'FreeCoreSafety' 'Scenario = "free"; O = o; K0 = k0; K1 = k1' '-ruling-free'
python3 formal/a3/runs/PiDagMerge-ruling.py
python3 formal/a3/runs/PiDagMerge-summary.py
```

## 裁决的落实与独立性质

| 性质 | 当前定义与历史/真值判据 |
|---|---|
| NoBypassedNegative | 对合入坏内容且没有 owner 节点免的情况，准确节点否定观必须已在历史中合法撤回；否则仍为活动封。判断类的撤回是其后的同节点、足够档位肯定观；执行类是其后的原键失败复现。历史合法撤回不会因以后再次编辑而失效。 |
| EscapeAttributable | 只检查真实坏、却显示为 E 或 W 的项；仍显示为 D 的旧欠不是逃逸。分别检查状态项与已接受节点的自身义务，必须有该项的错误肯定观或适用的免/缓判。节点自身义务不能用状态缓判归因。 |
| DeferredDebtVisible | 缓判状态项若在提交时已不显示 D，历史中必须有其当前键上的状态肯定观；不要求肯定观必然准确。错误肯定观由 EscapeAttributable 归入 ①a。 |
| NodeAcceptanceCovered（新增回归） | 每条实际接受回执必须有当前键的节点自身肯定观或 owner 节点免；状态观和缓判都不能充当该事实。 |

这些性质不调用 Guard/NodeOK/FGuard，也不读取操作性的活动封集合来“证明”它本身。`HWithdrawn` 从不可删除历史重建撤回事实；`HAffirm`/`HFalseAffirm` 按节点、键和 state/节点种类查找真实事件；提交回执保留实际真值及 E/W/D 显示。守卫维护的封集合和观察格与这些审计谓词独立。

自由模型的具体修正：

- `nodeObs` 与状态 `obs` 分开。`FObserve` 只产生节点验收证据及封；`FStateObserve` 只产生状态项证据。创世只观察初始状态项，不替节点完成验收。
- a3 合入除不增欠条件外，独立要求节点自身 pass 或 owner 免。缓判只出现在状态不增欠条件中。
- a3 `FDefer` 只允许当前键不同于 trunk 该项键的状态项；换键不会迁移已有缓判。owner 节点免与状态豁免/缓判使用不同存储。
- 回执分别记录状态 debt 与 nodeDebt，避免“节点还欠验收”被状态项已证掩盖。状态豁免仍仅在 a22/对应消融可用。
- 状态否定观不是节点验收 BLOCK；晚到节点 BLOCK 的性质按节点观察历史判定，状态观则由不增欠条件处理。

## 本轮固定场景结果

每个单元为 `结果 / distinct states`。H=HOLDS，V=VIOLATED。每行三个性质分别独立运行；相同计数并非合并计算。安全检查为单 worker BFS，V 的计数是找到最短反例时的探索量。

| Scenario | NoBypassedNegative：a22 / a3 | EscapeAttributable：a22 / a3 | DeferredDebtVisible：a22 / a3 |
|---|---|---|---|
| launderReview | V / 33；H / 33 | H / 71；H / 33 | H / 71；H / 33 |
| launderTest | V / 53；H / 101 | H / 183；H / 101 | H / 183；H / 101 |
| rerun | V / 39；H / 72 | H / 113；H / 72 | H / 113；H / 72 |
| flakyDebt | H / 15；H / 5 | H / 15；H / 5 | H / 15；H / 5 |
| matrix | H / 25；H / 6 | H / 25；H / 6 | H / 25；H / 6 |
| genesis | H / 18；H / 6 | H / 18；H / 6 | H / 18；H / 6 |
| falsePass | H / 36；H / 14 | H / 36；H / 14 | H / 36；H / 14 |
| oldDebt | H / 25；H / 13 | H / 25；H / 13 | H / 25；H / 13 |
| defer | H / 22；H / 10 | H / 22；H / 10 | H / 22；H / 10 |

无节点否定观时 NoBypassedNegative 有空前提，无缓判时 DeferredDebtVisible 有空前提；覆盖由前三行、defer 及自由交错补足。EscapeAttributable 在 a22 也成立不代表 a22 安全：真实坏而仍显示为 D 的合入现在按裁决不算逃逸，错误 pass 则确实有 ①a 记录。

a22 的三个 NoBypassedNegative 最短反例均为 7 步：创世→启动→准确 fail/BLOCK→编辑换键但内容仍坏→低档/flaky 错误 pass→求值→提交。评审例中不足档位的 pass 没有合法撤回高档 BLOCK；执行例中没有原键复现。对应日志 tag 为 `ruling-launderReview`、`ruling-launderTest`、`ruling-rerun`。

## 自由交错与非空性

自由环境保持同一预算：两个节点，每节点最多两次编辑，共 8 次外部输入；模拟深度 20。节点/状态观察、原键重跑、编辑、免、缓判、创世、队列、求值与提交自由交错。两个档位都存在准确与不准确观察者，准确者受隐藏真值约束，不准确者可在好/坏内容上给出任意结果。

核心合取本次包含九项：NoFlakyRerunEscape、JudgedAtCommit、GenesisBeforeAdvance、StateNeverWaived、LeaseExcludes、**NoBypassedNegative、EscapeAttributable、DeferredDebtVisible、NodeAcceptanceCovered**。共同经过 **40,000 条轨迹、12,760,539 states checked，HOLDS-SIM**；种子 `9132539921166338765`，耗时 32 秒。`num=10000` 为每 worker 数量；没有把 checked 数误称为 distinct 状态。

| 模式 / 性质 | 结果 | 轨迹数 / states checked |
|---|---|---:|
| a3 / 上述九项核心性质 | HOLDS-SIM | 40,000 / 12,760,539 |
| a22 / NoBypassedNegative | VIOLATED | 16 / 5,257 |
| a22 / EscapeAttributable | HOLDS-SIM | 8,000 / 3,024,461 |
| a22 / NodeAcceptanceCovered | VIOLATED | 10 / 3,036 |
| a3 / NothingMerged | VIOLATED，期望见证 | 16 / 4,644 |
| a3 / NoDeferredMerge | VIOLATED，期望见证 | 399 / 127,554 |
| a3 / FreeNoTwoMerges | VIOLATED，期望见证 | 1,809 / 576,158 |

后面三行分别证明可实际合入、可带状态缓判合入、两个节点都可合入；修正没有冻结所有工作。NodeAcceptanceCovered 的 a22 自由反例是保留旧自由模型放行规则的修正对照，不把该模型失真另算作 a2.2 架构漏洞。a22 自由反例的原始模拟路径分别为 12 步，不宣称它们是最短路径；活动封的最短固定回归已在上表给出。

## 旧轨迹的正确解释与保留证据

- 旧 8 步“撤封→再编辑→缓判→合入”不违反活动封承诺。历史上的封已经合法撤回，状态风险由缓判归入 ③。旧自由模型同时缺少独立节点验收门槛的问题现已修正，不能把该模型缺失当作 a3 漏洞。
- 旧 4 步旧欠合入仍显示 D，因此不在 EscapeAttributable 的前提中；K3 明确允许继承旧欠。
- 旧 7 步缓判后错误 pass 路径通过肯定观进入 E，错误肯定观就是 ①a。DeferredDebtVisible 不再声称能从观测中获得真实正确性保证。

上轮原始日志与 [PiDagMerge-pre-ruling-results.tsv](runs/PiDagMerge-pre-ruling-results.tsv) 保留，SHA 为 `65dadcf33e0dbf772dc4b7df47e6898dbcd7db705d32f80f52cde863e5224310`。其中三项旧性质的 V 已被上述裁决解释，不计作当前失败；旧穷举超时也不计作当前通过。该文件不是当前树结果表。

未受影响的固定场景转换、原始真值性质、七种消融及 live 公平性本轮没有改动，按要求未重跑整套。保留的上轮单 worker 证据如下（H/V 后为 distinct states）：

| 检查 | a3 基线 → 消融/旧版 |
|---|---|
| K1 / NoNewBreakage / genesis | H 6 → a3-K1 V 7 |
| K2 / NoLaundering / review | H 33 → a3-K2 V 21 |
| K3 / NoNewBreakage / flakyDebt、matrix | H 5、H 6 → a3-K3 V 7、V 8 |
| K3state / StateNeverWaived | H 6 → a3-K3state V 11 |
| K4 / GenesisBeforeAdvance | H 17 → a3-K4 V 25 |
| K5atomic / JudgedAtCommit | H 14 → a3-K5atomic V 10 |
| K5queue / GoodEventuallyMerges | H 9 → a3-K5queue V 24；a22 V 17 |
| K5queue / LeaseExcludes | H 9 → a3-K5queue V 5 |

原始绝对真值性质仍不是契约承诺：a3 NoLaundering/launderTest 与 rerun 的 8 步反例先复现原键 fail，再由新键错误 pass 合入；a3 NoNewBreakage/falsePass 的 5 步反例由错误 pass 造成。这些是父级已接受的 ①a 边界，不因本轮性质裁决消失。固定 good 场景的 5 步正常合入见证也保留（NothingMerged V / 13）。

N8 的既有 WF 结论保留：a22 可反复“准备 PRE→验证→竞争提交→重基”，固定提交动作不持续使能，仍满足弱公平却永不完成；a3 队首轮次在租约到期后保留 FIFO 次序，有限验证与提交在 WF 下完成。此有限状态活性证据不依赖账头静止，也不证明任意 flaky 工作最终成功。

## 限制与运行状态

- 自由结果是有界随机覆盖，不是无限状态证明。两个节点、每节点一个状态项及一个自身义务；两类义务当前共用内容的隐藏好/坏真值，但观察证据独立。没有动态义务收集、任意项数量、真实代码、概率估计、键碰撞或读取集计算。
- 输入预算耗尽后可明确取消候选；取消不删除回执或历史，也未被公平性强制。只有已合入/明确取消的终态才 stutter。自由环境不用于证明活性。
- 受信签发者的权限及避作为前提；K8/K9、改律解决冲突、更大 n-of-k 不在本叶范围。原键失败复现不把同档新键 pass 冒充原键结果。
- K5 仍采用同一步重算守卫及 trunk PRE 校验，不是整个账头 CAS；队列到期释放租约而不允许无限插队。a22 race 是两阶段实现压力测试，不能称为击穿其字面原子规范。
- 节点/键为 model values；固定 PRE/候选角色和自由创世审计 K0 锚点不同，不作不健全的 SYMMETRY 交换。
- 本轮已完成受影响自检，当前报告取代旧结论。无待运行任务；叶子交付供父级审阅，不自行宣布分支接受。
