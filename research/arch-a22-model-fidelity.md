## Opinion

**结论：a1/a2 字面模式下报告的 ✘ 基本属实。a3、a21 和 fix 模式下的 ✔，几乎都只是把模型自己的定义复述了一遍。** 这些性质要么只是改写刚加进去的子句，要么直接来自理想化的观察者，因此没有独立检验任何东西。所以 a3 大跑的 31,149,916 个状态，并不比 43,132 个状态的小跑多提供信息。`ARCHITECTURE.md:246` 写"三部分在有限规模内都已检查"，说法过强。总体置信度约 80%。我没有运行 TLC，以下"预期"都是手工推导。

有两个实质缺陷：

1. **"不增欠"根本没有建模。**
   - `Guard(n) == NodeOK(n) /\ (A2 \/ ~gDebt)`（`formal/PiDag.tla:96`）在 a2 下直接去掉了欠条件，模型里也没有任何动作能让候选新增欠。
   - 所以"一笔全局新欠不冻结主干"（`ARCHITECTURE.md:140`）是靠删掉检查得到的。
   - 主干规则 `D(s) ⊆ D(PRE)`（`ARCHITECTURE.md:87`）从未被检验。
2. **PiDagAuth fix 模式有一个错误的 ✔。**
   - `Reach`（`formal/PiDagAuth.tla:65`）对所有未撤销的 grant 边求闭包，但不检查这条边在签发时是否生效。同时 `Grant`（`:37`）允许任何人追加授权。
   - 日志 `[grant(w1→w2), grant(owner→w1), waive(w2,n1)]` 只有 3 条，在 MaxLog=4 之内：fix 接受，lit 正确拒绝。
   - 这违反"权只能来自此前已生效的律"（`ARCHITECTURE.md:56`）和"没有生效的断言都叫言"（`:42`）。
   - fix 模式的 AuthAtIssue（`:97`）用的就是同一个 `Reach`，所以发现不了。

### 建议的模型修改（按价值排序）

排序依据：① 检验 a2 的核心规则，并把"冻结"变得可见；② 修正一个已发布的错误 ✔；③④ 让原子性和观察者准确性这两个关键假设可以被证伪；⑤ 覆盖面最窄。

**① 欠改为集合，修复叶走同一个守卫，不增欠写成动作性质（PiDag）**
```tla
CONSTANT Invs                                  \* {"d1","d2","d3"}；删 gDebt、FixGlobal
D(n, b)  == (tBroken \ fixes[n]) \cup b
Guard(n) == NodeOK(n) /\ pre[n] = trunkSeq     \* 证据针对当前 PRE（可消融）
            /\ IF A2 THEN D(n, obsBrk[n]) \subseteq tBroken ELSE D(n, obsBrk[n]) = {}
Test(n)  == ... /\ obsBrk' = [obsBrk EXCEPT ![n] = trueBrk[n]] /\ pre' = [pre EXCEPT ![n] = trunkSeq]
Merge(n) == Guard(n) /\ tBroken' = D(n, trueBrk[n])
            /\ \E c \in [Nodes -> SUBSET Invs] : trueBrk' = [m \in Nodes |-> trueBrk[m] \cup c[m]]
NoNewDebt == [][trunkSeq' # trunkSeq => tBroken' \subseteq tBroken]_vars
```
同时去掉 `formal/run.sh:20` 的 `-deadlock`。预期结果：
- Init 设 `tBroken={d1,d2}`、两片叶子各修一项时，a1 会冻结，C7 第一次被真正复现。
- a2 下 NoNewDebt ✔，且不冻结。
- 消融 `pre[n]=trunkSeq` 后 ✘（语义冲突）。
- 把守卫粗化为布尔判断后，在细粒度的真实状态下 ✘。这正好给 `:248` 的粒度开放问题一个可执行的答案。

**② Auth 改用独立的参考语义，加入降级，MaxLog 提到 5**
```tla
RECURSIVE Eff(_, _, _)                          \* k 限深防环
Eff(p, t, k) == p = "owner" \/ (k > 0 /\ \E i \in Idx(1, t-1) :
   /\ log[i].type = "grant" /\ log[i].to = p
   /\ Eff(log[i].from, i, k-1)                   \* 签发时已生效：言不转律
   /\ \A u \in Idx(i+1, t) : Eff(log[i].from, u, k-1)   \* "随之失效"的永久读法
   /\ ~\E j \in Idx(i+1, t-1) : RevokesGrant(j, i))
AuthSound == \A n \in Nodes, i \in Idx(1, Len(log)) :
               Covering(i, n) => Eff(log[i].from, i, Cardinality(Principals))
Downgrade(a, n) == Add(Mk("downgrade", a, "-", "-", n, ver[n]))   \* 共用 权/追溯
```
预期结果：
- fix 在 3 条日志处 ✘ AuthSound。
- MaxLog=5 时会出现"撤销 parent → 重授 parent → 旧的 parent→w1 复活"：fix ✘，本定义 ✔。这会逼正文在 `:58` 的"当下可达"和"随之失效"两种读法之间做裁决。
- `[grant(owner→w1), downgrade(w1,n1)]` 在现行 `:66` 下 ✘，因为"避"只覆盖豁免。

**③ a2 实现模式：两相提交（PiDag）**
```tla
Eval2(n)   == A2 /\ n \notin trunk /\ Guard(n) /\ snap' = [snap EXCEPT ![n] = <<trunkSeq, version>>]
Commit2(n) == snap[n] = <<trunkSeq, version>>   \* 据 = (PRE, 律集版本) 的 CAS
              /\ violation' = IF Guard(n) THEN violation ELSE violation \cup {n} /\ DoMerge(n)
```
Test/Review 不推进 `version`（`formal/PiDag.tla:124-136`），因此预期 ✘ JudgedAdvance。路径为 Launch→Write(bad)→Test(pass)→Waive(owner)→Eval2→Review(block)→Commit2，约 7 步。

如果 CAS 改用账本头，或者 Commit 时重新求值 Guard，就会 ✔。这样 `ARCHITECTURE.md:135` 的"同一步"就从假设变成明确的实现约束。

**④ 观察者现实化、豁免绑定内容、活性（PiDag）**
```tla
Review(n) == \E r \in (IF quality[n]="good" THEN {"ok"} ELSE IF calibrated THEN {"block"} ELSE {"ok","block"}) : ...
Test(n)   == \E r \in (IF quality[n]="good" /\ ~flaky[n] THEN {"pass"} ELSE {"pass","fail"}) :
               ... /\ everFail' = [everFail EXCEPT ![n] = @ \/ r = "fail"]
Write(...) == ... /\ waived' = [waived EXCEPT ![n] = "none"]        \* 按 :66
NoLaundering == \A n \in trunk : everFail[n] /\ quality[n] = "bad" => ~CardAllCheck(n)
GoodMerges   == \A n \in Nodes : quality[n] = "good" ~> n \in trunk  \* 配 WF
```
预期结果：
- `calibrated=FALSE` 时，BadVisible 和 NoLaundering 都 ✘：fail → 重写换键 → pass → 合入，也就是 C4。这说明 C3/C4 的 ✔ 完全依赖 `:199` 的诱饵校准，应把它写成显式前提。
- 默认 E 下，flaky 的好内容会让 GoodMerges ✘，说明 k-of-n 对活性是必需的。
- 旧豁免不再能覆盖新内容。

**⑤ Strength：逐节点 isNew，加入 happyPath 测试**
```tla
LawResult(t, c) == CASE t = "happyPath" -> IF c = "stub" THEN {"expected"} ELSE {"pass"} [] ...
ExecResult(t, i) == CASE t = "happyPath" -> {"pass"} [] ...       \* 抓不到真 bug
LawCf(new) == IF new THEN {"stub"} ELSE {"base","mutant"}           \* 消融：ELSE CfLaws
NoHappyPathEscape == ~(merged /\ ~isNew /\ test = "happyPath" /\ impl = "bad")
```
预期结果：
- 律允许对已有模块用 stub 时 ✘；限定 stub 只用于新模块时 ✔。
- 新模块上的 ✘ 无法消除，`:122` 应注明桩只证明"测试触达了目标行为"。
- 顺带消融 `TestAdmissible`（`formal/PiDagStrength.tla:98`），预期 a21 的结果全部不变，即准入子句没有承担任何作用。

## Evidence

### (1) 模型比正文强或弱的地方

| 位置 | 偏差 | 后果 |
|---|---|---|
| `formal/PiDag.tla:96`；没有"新增欠"动作 | 弱于 `:87` | 不增欠从未被检验 |
| `formal/PiDag.tla:161-166` FixGlobal 不经过守卫 | 弱于 a1 | a1 永不冻结；a1 的 C7 见证 ✘ 实际来自 C8a 竞态（`formal/README.md:28,32`），所以作为 C7 的证据是错的 |
| `formal/PiDag.tla:191` `violation' = violation` | 假设 `:135` 是原子的 | a2/a3 的 JudgedAdvance 不可证伪 |
| `formal/PiDag.tla:115` `A2 => e = epoch[n]` | 强于正文（迟到的交付应作为"言"入账，`:42`） | OnlyHolderContent（`:221`）恒真，AuthorOK 不起作用 |
| `formal/PiDag.tla:134` 评审永远准确；`:82` 在 a2 下恒真 | 强于 `:199` | BadVisible（`:218`）直接由 `:99-101` 推出 |
| `:69,77-78` 对比 `:212,215` | 性质与定义等价 | a3 NegativeWins 和 a2/a3 FailIsDebt 恒真；a2 NegativeWins ✘ 属实，与 `ARCHITECTURE.md:84` 一致 |
| `formal/PiDag.tla:118-122` 清空观察，但保留 waived/downgraded | 保留豁免弱于 `:66` | 旧豁免下坏内容可以合入，且没有性质能察觉；失败历史被抹掉 |
| `:139,146,154` | 所有律事件共用一个 MaxVersion | 小跑里全局最多 2 次律事件 |
| `formal/PiDagStrength.tla:81-84` 除 strongNew 外 base 与 stub 完全相同 | 弱于 `:121-122` | 看不出"已有模块用桩"的漏洞 |
| `formal/PiDagStrength.tla:68-71` Admit 可任意接纳 | 相当于保守的对手 | StrongCatches 只来自 `:75`，NoVacuousMerged 只来自 `:82` |
| `formal/PiDagStrength.tla:41,45` | cfLaw 在 Init 时选定（符合 `:114`）；每次写都清空观察 | a1 的"曾失败"无法表达 |
| `formal/PiDagAuth.tla:97,99,101` 对比 `:84-88`；`:104-105` 对比 `:83`；`:106-108` 对比 `:89-91` | 性质与子句等价 | fix 模式的 5 个 ✔ 全部恒真；README 只承认了 AuthAtIssue 这一个（`formal/README.md:94`） |
| `formal/PiDagAuth.tla` 没有降级 | 弱于 `:21,:159` | 自我降级从未被检验 |

### (2) 缺失的安全性质
- 不增欠（见 ①）。
- 合入那一刻，守卫对整本账成立（见 ③）。
- 权的来源可靠，用与守卫无关的独立定义来写（见 ②）。
- PiDag 里豁免绑定内容；坏内容的逃逸能被追溯，失败不能被洗掉（见 ④）。
- 降级也要受"避"约束。
- 活性和无冻结：`:246` 承认没查；`-deadlock` 让冻结连死锁都不会报出来。

### (3) 小规模是否足够
- **对模型能表达的 bug 类，小规模够用。** a2 的 ✘ 在深度 8 出现，Auth lit 的 ✘ 在 3–4 条日志处出现。
- **但主要缺口来自抽象方式，不是规模不够。**
  - C7 需要两种不同的欠，布尔 `gDebt` 在任何规模下都表达不了。
  - 节点之间只通过 `trunkSeq`/`gDebt` 交互，加到 3 个节点只是多了交错顺序。
  - speech-grant 本身就在规模之内，没被发现是因为缺一个独立的性质。
- **真正受规模限制的地方：**
  - MaxLog=4（`formal/README.md:74`）：复活、三级委托链加撤销、pin 加 owner 加撤销这些组合都需要至少 5 条。
  - MaxVer=1 只允许改版一次。
  - 常量用字符串而不是 model value，无法使用 SYMMETRY。

## Alternatives Considered

- **只扩大规模，或换 Apalache/TLAPS：** 对恒真的性质，证明了也不增加信息，应该先修抽象。
- **合并成一个大模型：** 状态组合会爆炸。更好的做法是保持三个模型，抽出共享的"生效"定义，让 PiDag 的 W 引用它。
- **只修改 `:246` 的措辞：** 应该做，成本也最低，但发现不了 speech-grant 这类新问题。
- **消融工具（去掉某个子句后，对应的 ✔ 应变成 ✘）：** 能找出不起作用的子句，比如 TestAdmissible 和 AuthorOK。但找不出恒真的性质，因为性质本身就等于子句时，消融照样会变 ✘。所以根本办法是让性质和守卫用不同的定义来写。这条作为流程建议，不占 5 个名额。

## Assumptions & Caveats

- **没有运行 TLC**，所有预期结果都是手推的。各项置信度：
  - 恒真性分析约 90%。
  - speech-grant 反例约 85%（逐步算过 `Reach` 和 `HAuth`）。
  - ③ 约 80%。
  - ①⑤ 中给出的步数是估计值。
- **以当前文件为准，产物有漂移：**
  - 日志来自两个更早的版本：a1/a2 的日志引用 `Launch line 103`、`MergeA2 line 188`，a3 的引用 105/190，而当前代码在 `:104`/`:189`。日志里也没有记录 spec 的 hash。
  - `formal/run.sh:8` 写 cfg 时不带 TAG，`:19` 写日志时带 TAG，所以大跑覆盖了 `formal/runs/a3-JudgedAdvance.cfg` 和 `a3-NegativeWins.cfg`。
  - 未加 tag 的 Strength cfg 里没有 CfLaws，无法用当前文件复现。
- **README 的标注有误：** `formal/README.md:24` 把 a1 NegativeWins 的 ✘ 记为 C2，但轨迹走的是 Downgrade，属于 C3 机制。
- **以 a2.2 正文为准：** `:58` 有两种读法尚未裁决，② 的部分结论取决于最终选哪一种。