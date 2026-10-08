# J1 实证对 pi-dag 的修正（2026-10-08）

> 来源：四份只读研究 `j1-{incidents,plan,exec,human}.md`（workflow 01M4DAC3J8M93Q3RNQX64MCFQW，Astra low）。父级抽核了以下关键证据并确认属实：
> - FAULT-POWER 合并后评审返回 BLOCK，原因是 4 处 oracle 问题（`work/dev/app-worktree/dev/evidence/J1-FAULT-POWER/README.md` 的 "Post-merge review amendments" 一节）；
> - 抽查的两个 J1 dsa journal 中，`isolation`、`gate`、`wt-` 的出现次数都是 0；
> - 字符串形式的 gate 不会解析 stdout（`pi-conductor/src/orchestrator/executor/effects/gate.ts:138`，只有 `output === "json"` 时才解析）；
> - owner 的三句原话 C:5055、C:5289、C:11708 都能在原始会话中找到。

## 1. 最重要的发现：J1 合入后的真实逃逸全部来自 oracle 或覆盖不足

已核实的 14 条事故里，有 4 条是“已接受或已合入的错误”：

| 事故 | 性质 | 只靠“执行真实”的回执能否拦住 |
|---|---|---|
| FAULT-POWER：正式 red-first 7/7 通过并合入，合入后评审 BLOCK，18 个合成输入里有 10 个违背预期 | oracle 过宽 | 不能：同一测试包仍然会通过 |
| K4：已合入代码有 4 处绕过 Ledger 写入，原回归集不含 k4，从引入到修复约 4h39m | 候选集成时的测试选择不足 | 只有候选验证包含 k4 时才能拦住 |
| S1-CANDIDATE-RUNNER：只用小 fixture 验证，遇到 6.5MB 真实计划时触发 1MiB maxBuffer | 覆盖不足 | 不能 |
| PLAN2：序列化变化让冻结的例外失配 | 集成回归 | 候选阶段跑了 retarget 测试才能拦住 |

另外三类情况的结论：
- **回执本身要防的问题，J1 已经防住了。** 脏树和短 SHA 都被 J1 自建的 `check.mjs`、`ledger.py` 拒收。没有发现“受信 runner 声称执行过、实际没执行”的事故。`sys.exit(0)`、零用例、改测试这几类没有找到实际事故，只能当作合成威胁。
- **DESIGN §1.1 的十类事故**：4 类成立，3 类部分成立，3 类未证实（⑤ 漏注入的根因、⑦ 复用证据导致错误、⑧ done 缺 SHA）。
- **按我们事先定的改口判据，条件已经触发。** selling-points §5 写的是“逃逸台账里 oracle 缺口 ≥50% → 头条改为验收强度”。J1 回溯的结果是 4/4 都属于 oracle 或覆盖缺口。但这只有 4 个样本，而且是回溯，不是影子期的逃逸台账，只能算方向信号。

**结论**：只证明“确实跑过”的回执，在 J1 上几乎拦不住任何真实逃逸。要有用，回执必须同时说明**测得够不够**：覆盖范围、未测的义务、oracle 强度，以及候选集成时选了哪些回归测试。合并前评审也要成为硬门槛。

## 2. J1 已经手工做出了 pi-dag 的一半

父级自己写了 `gen-exec.py`、`gen-stage.py`、`exec-template.js`、`parent-merge.sh`、`ledger.py`，以及 dev 仓库里的 `tools/arch/check.mjs`、`receipt.mjs`。其中已经做到的有：
- 精确用例集合，包括 TAP 子用例；零用例、skip、重复都拒收；
- 定位 red 的来源提交（首次包含最终测试字节的那个提交）；
- 继承他人契约时的 red；
- 完整 OID，plan/checker 都用 hash pin 住；
- accepted 账本用 flock、fsync 和 hash 去重；
- 在 `ledger.py build` 里核对合并身份、测试归属、用例集合和授权漂移；
- 人工判定 tree 相同时复用证据。

**所以 M0 应该从这些实现中提炼，不要从零重写。** pi-dag 相对 J1 的增量在于：把这些做成通用产品，同时补上 J1 缺的部分：候选先验证再 CAS、节点级写者互斥、结构化裁决、合并前评审门槛、oracle 强度和覆盖说明。

## 3. 执行层与 dsa 配合的修正

- **J1 根本没用 dsa 的 worktree 隔离或 gate。** worktree 由写者用 `git worktree add -b leaf/<ID>` 自己创建，后续轮次继续复用，base 取的是创建时的 dev。回执里的 `principal:"gate"` 只是 check.mjs 的默认字符串。
- **worktree 的生命周期以叶子为单位，不以 call 为单位。** 同一个叶子要跨 W1→R1→W2…W5、父级裁决、验收失败和后续补证，合入后才能释放。dsa 现在 ok 之后就清理干净的 worktree，这和 J1 的做法冲突。所以 S3 必须在 gate 方案之前落地。
- **“评审 OK”不等于“独立实跑”。** 多个 moa-opinion 评审者只有读权限，只核对了写者的证据。真正独立执行的是集成器和父级。
- **验收成本分布很宽。** 候选侧中位数 4.9s，P90 85s，最长 996s；外层最长 17.5 分钟；还有 6h 的矩阵，LazyFS 全机内存约 14.7GB。热构建的 Cargo 只要 0.05–2s，完整重编译 83s。所以“全新 clean checkout”要拆成三件事：干净的源码快照、干净的运行目录、受策略约束的可信构建缓存。
- **资源租约是 J1 的必需品，不是后期优化。** 曾出现过：load≈16 时测试失败，安静下来后通过；留下 8 个孤儿 LazyFS 挂载，约 7.3GB。回收必须在进程外完成。
- **单写者问题，单靠 call key 解决不了。** W2 超时后，模板在 0.66s 内自动起了 W3，父级又另开一个收尾会话。认领必须在节点级别，覆盖 dsa 内部重试、手动 follow-up 和父级临时会话，并且要先确认旧进程和后台任务已经退休。
- **gate 的语义需要修正。** 必须用 `{command, output:"json"}` 形式。恢复时 gate 会记为 unknown 且不重跑；timeout、stopped、budget 三种状态会跳过 gate。所以“可恢复”只能写成“可恢复裁决”，验收要按 execution key 对账，必要时新开一个验收 attempt（S5）。长时间验收如果放在写者 call 的 gate 里，会一直占着这个 call。

## 4. 计划与裁决模型的修正

计划规模：91 个 J1 节点。kind 分布为 implementation 55、contract 29（其中 3 个实际上是聚合器）、test 3、experiment 2、closure 2。风险分布为 R2 77、R1 7、R3 7、R0 0。另有 15 个 done 的 ID 不在计划里（AMEND/FIX，以及 5 个 J1 叶子）。

依赖与写集：
- 依赖深度：只看 J1 内部是 32 个节点，算上计划内祖先是 49 个；依赖图允许的最大并行宽度是 22，配置的并发是 8。
- 写集有 252 对节点共享精确路径，主要是模块注册文件，比如 Ledger 的 `lib.rs` 被 18 个节点声明。

验收：
- 91 个节点全部经 `check.mjs` 验收，并且都要求 red；验收和回归是两条不同的命令。
- red 不总是“基线加同一测试包”：已经接受过“契约 red 加真实目标守卫变异”和 `red=null` 两种替代做法。

修订与裁决：
- 计划由 Python 生成器维护，不是手改 YAML：安装后改过 21 次，有 13 个后继 plan 和 26 份快照。
- 裁决文件 `p13-rulings-inject.json` 是“10 个节点 → 长正文”的映射，不是原子裁决。正文混合了多轮相互覆盖的决定，例如 P13-14 覆盖了 P13-2；匹配方式只有精确 node ID。

需要补进模型的：
- `kind`（执行／聚合／外部）和 `work_type`（contract、implementation、test、experiment、closure）分开；
- 节点要有 milestone、retired/superseded，计划外的修补叶要是一等公民；
- 带类型的证据依赖：契约、测试包、接口、产物、闭包回执；
- 验收拆成阶段列表（acceptance 和 regression 分开），red 支持多种模式；
- 写集分成三种：允许改动的、必须产出的、共享注册文件的所有者；
- 资源要表达数量、阶段和独占窗口，并分别记录声明值、实测值和批准的覆盖；
- 预算的口径与权限，评审档位要显式（S / parent+S / A）；
- PlanRevision：父 digest、生成器、批准、pins、结构 diff，状态分为草稿／已安装／待并入；
- 裁决：原子化，带 authority（owner 或 parent）、目标字段、supersedes、生效修订和落实状态；派活时记录解析后的有效裁决集合及其 hash。如果裁决的前提被证明错误，要能撤销，例如 case 误判那次。

## 5. 人这一侧的修正

- owner 实际用来验收的是：中文进度解释、可以打开的产品和截图页、逐项过的验收清单（32 项，并明确写着“可验收 ≠ 已验收”）、带推荐的成组决策。owner 没有看过哈希回执。
- owner 原话：
  - “我不理解代号是什么意思”（B:8756）；
  - “你能搞个页面让我看截图吗？”（B:6497）；
  - “哪些需要我决定的？讲清楚”（C:5277）；
  - “Q-T11/T13: 你决定。”（B:5202）；
  - 2026-10-08 对 pi-dag 本身的问题：“其实我不太理解这个 dag 实际要怎么动作的。能否举个具体例子”（C:11708）。
- 待决量：
  - 10-03 至 10-06 每天下界分别为 7、4、8、≥9；
  - 一句“按建议”可以一次关闭 8 项；
  - 被当成“等人回答”的休眠 asking，实际是在等资源窗口。
- owner 的输入大量是 `custom_message`（pi-topping-prompt），只统计 `role=user` 会漏计。
- 创作者偏差：owner 同时在调模型、买额度、推动修 dsa，不能代表典型买家。

## 6. 由此确定的文档改动

- PRODUCT.md 升到 v0.3：定位、回执定义、三类状态、待决分责、执行层、dsa 优先级、计划和裁决模型、M0 基于 J1 提炼，并加入具体例子。
- selling-points.md 升到 v4：触发改口判据，头条加上“验收强度”；逃逸指标拆为三类；修正统计分母和 owner 原话的引用。
- DESIGN.md：不再逐条修改。§1.1 的十类事故改按本文 §1 的口径引用，PRODUCT v0.3 取代 DESIGN 的相应章节。
