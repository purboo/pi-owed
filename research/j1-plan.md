**J1 需要的是“可修订的计划契约＋证据依赖图”，不只是叶子、依赖和一条验收命令。** 当前已 pin 的计划含 **91 个 J1 节点**，但执行中还有至少 **5 个已记入 done、尚未纳入计划的 J1 叶子**。冻结契约、变异红证据、共享文件所有权、闭包回执和裁决覆盖关系，都是实际需求。

本次仅做读取、内存计算和 Git 历史查询，未修改文件。以下数字除明确标注外均为直接统计，置信度高；没有把计划估时或配置并发当成实测。

**1．计划画像与数字**

权威基准是 [nodes.v27.json](/home/user/project/work/tmp/plan/nodes.v27.json)，其 SHA256 为 `3e1b505aeda0d7403fdc45e43f3c04ebe11b1498c6bed74a6a02148f3420c8a5`，与 dev 副本和 [pins.env](/home/user/project/work/tmp/exec/pins.env) 一致。

| 项目 | 已验证结果 |
|---|---|
| 全计划 | `nodes` **588**，`later_nodes` **78**，合计 **666** |
| J1 范围 | 按 `milestone == "J1"` 取 **91**；不能只匹配 `J1-` 前缀，Z06、WSP-LOCK 等也属于 J1 |
| 实际 kind | implementation **55**、contract **29**、test **3**、experiment **2**、closure **2** |
| aggregate / external | 没有这两个 kind；**3 个 contract 节点实际上是契约聚合器**，另有 **2 个 closure**；未见外部等待节点 |
| 测试与生产 | 写集完全位于 tests/evidence 的 **33**；含 crates/viewer/cli 路径的 **49**。这是路径分类，不能等同于 kind |
| 风险 | R2 **77**、R3 **7**、R1 **7**、R0 **0** |
| 评审档 | S **77**、parent+S **7**、A **7**；不是统一“R3 两名评审” |
| 快照状态 | done **85**、planned **6**；这是计划安装时状态，不能当作当前执行状态 |

[done.txt](/home/user/project/work/tmp/exec/done.txt) 有 **185 行**，其中 **15 个 ID 不在上述 588 节点内**：10 个 AMEND/FIX，以及 VIEWER-APP、STARTUP-BARRIER、FAULT-RUNNER-PUMP、COLD-PLAY、FAULT-RECOVERY 五个 J1 叶子。因此，“91”是已安装计划规模，不是完整执行任务数；FIRST-CHUNK 等后续工作还需查执行账本才能计全。

**依赖、关键路径和并行。** 对 91 节点直接计算：

- 依赖引用 **854** 条，其中 J1 内部 **614** 条，外部引用涉及 **23 个不同节点**。
- J1 诱导子图最长深度 **32 个节点／31 条边**；纳入计划内祖先后最长深度 **49 个节点／48 条边**。
- 按所有节点 `hours` 重算，J1 内关键路径 **76.17 h**；包含外部祖先为 **108.17 h**。主干经过 SCALARS 拆分链、Ledger、EXEC、DERIVE、EDGE、KA、FAULT、close。这些是估时。
- 当前快照另存“剩余关键路径” **8 h**、剩余工作 **14.5 h**，对应六个 planned 节点；plan13 报告当时为 **27 h／49 h**。二者处在不同冻结状态。
- 纯依赖偏序最大反链宽度 **22**，按最长层级分组的峰值 **19**；它们都没有纳入资源和写集锁。
- [gen-stage.py:7](/home/user/project/work/tmp/exec/gen-stage.py:7) 明确配置 J1 并发 **8**。**实际同时运行峰值未能证实**：指定材料未提供可重建全程重叠区间的事件记录；DESIGN 的“最多 9 写者”应继续标注为待核实。

当前 `statistics.j1_critical_path_h=93.6667` 与上述直接重算不一致，说明派生统计也有陈旧字段，不能直接展示为权威数字。

**写集。** J1 有 **247 个写集条目、179 个不同字符串**，每节点 **1–16 项**，没有 glob、没有尾斜杠前缀；其中 `evidence/J1-EDGE-RETIRE` 是目录式条目，不能仅用尾斜杠判断路径类型。

存在 **252 对共享精确路径的节点**，主要来自模块注册：Ledger `lib.rs` 被 **18** 节点声明，Edge **10**、Exec **7**、Store **6**。全历史图中 **26 对**重叠节点没有依赖可达关系，但包含已完成／退役节点，不能据此认定存在并发冲突。plan13 报告核查的是当时未完成集合，给出 `unordered_writes=0`。

[coupled-write-sets.tsv](/home/user/project/work/tmp/plan/coupled-write-sets.tsv) 有 **48 条候选耦合审计**：Cargo.lock 17、manifest/schema 14、registration 9、native registration 3、runner/profile/config 3、frozen parent review 2。它是历史全计划审计，不能误算成 48 个当前 J1 冲突。

**验收、环境和资源。**

- **91/91** 顶层验收都调用 `node tools/arch/check.mjs`，没有直接以 Cargo 为顶层命令。Node 测试、Cargo 构建及 Rust conformance driver 位于下一层；另有独立 `regression_command`，并非一条命令覆盖所有阶段。
- green timeout：900 秒 **84** 个、3600 秒 **4** 个、86400 秒 **2** 个、1800 秒 **1** 个。red timeout：900 秒 **87** 个、3600 秒 **4** 个。外层 timeout 分别为 1920／7320／87360／2820 秒。
- **91 个都要求 red**；**64 个** `test_first_inside_leaf=true`，也有自有 red owner；其余 **27 个**利用外部契约关系。
- 全部 machine=local；内存声明为 4 GiB **86** 个、2 GiB **3** 个、8／16 GiB 各 **1** 个；browser **19**、heavy **88**、exclusive measurement **3**。
- 环境不在统一 `env` 对象中：pins 提供 `ARCH_PLAN_SHA256`、`ARCH_CHECKER_SHA256`；集成器提供 `ARCH_APPROVED_SHA`；回归命令依赖 `ARCH_REGRESSION_BASE`；输入另依赖 `APP_J1_INPUT`／XDG 配置，Python 依赖 `WAS_PYTHON` 或托管环境。
- [plan13b.py:2](/home/user/project/work/tmp/plan/plan13b.py:2) 记录矩阵实测 **946–995 秒、14.25–14.7 GB**，因此将 FAULT-RUNNER 的 green timeout 从 900 提至 1800 秒、内存从 4 提至 16 GiB。browser/LazyFS 又有移除 `prlimit` 的运行裁决，不能只执行计划原字符串。

**冻结、预算和评审。** [plan5.py:95](/home/user/project/work/tmp/plan/plan5.py:95) 定义“测试提交先红，再提交 vectors”，三个聚合器 pin 测试和 vectors 的 SHA256；验收要求候选中的精确用例集合，包括 TAP 子用例，并拒绝零用例、skip、重复及未授权改写。J1 有 **23 个** `frozen_contract_acceptance`、**18 个**显式 contract freeze receipt 要求。

红证据不总是“基线＋同一测试包失败”：vectors 存在而真实实现不存在时，参考实现可能全绿。[plan14-pending.md](/home/user/project/work/tmp/plan/plan14-pending.md) 已接受“契约叶 red＋真实目标守卫变异”替代，故 `red_first: true` 不足以表达现实。

代码上限字段为 **84×300、7×500**；真实规则区分生产语义叶 ≤300 与纯测试叶 ≤500，并附 countSource、diff 口径、conformance 块 ≤40 原始行等约束。总主动工时止损从 **136→160→256 h**，测量 **16 h**、wall **168 h**不变；计划总估时 **194.5 h**，不能称为实际耗时。旧规则文本仍残留 136 h 和统一 300 行，需要结构化替代关系。

**2．修订历史与成因**

可以给出三个不同、不可混用的计数：

- v27 安装后，Git 中修改 canonical nodes.json 的提交 **21 个**。
- 有 successor plan **1–13**，再加 **13b**；其中一些含多轮修补、重签。
- 留存 **26 份不同内容的哈希命名 v27 快照**；它们包含草稿、评审修订与序列化变化，不等于 26 次正式发布。plan14 仍是 pending。

主要演化为 **46→66→70→71→76→91** 个 J1 节点，期间也出现退役／移出 J1，不能仅按净增数解释：

| 修订 | 已验证触发原因 |
|---|---|
| 1–4 | 同步 accepted 状态、补输出／回归覆盖、browser 限制、锁文件所有权；plan2 还有纯序列化重签 |
| 5–6 | 原计划把 18 个目标测试估成 3 小时；新增两种共享 binding＋18 个 CT 叶，组契约变聚合器，补依赖和预算 |
| 7–8 | owner 将主动预算提至 256 h；纯测试上限放宽至 500 |
| 9 | SCALARS 按真实模块拆 REPLAY／RECORDS／CBOR／JCS；生成器引用写者 WIP patch |
| 10–12 | 风险驱动派活、WIRE 契约；Safari 延后；plain HTTP/YAGNI 变更导致退役、oracle 同步及注册修补 |
| 13 | KA 暴露真实输入、派生、serve 缺口；四轮评审与裁决补全，新增 15 个节点，并再次因代码量拆分 |
| 13b | 实测超时／内存超出原声明，更新资源预算并冻结新完成节点 |

`split-proposed` 没有统一结构化事件计数，不能报告其发生次数；SCALARS WIP 和 plan13 的超预算拆分有直接证据。

父级通过 Python 生成器改节点、同步 done、保存冻结对象/hash、生成 canonical JSON 和哈希快照，再安装 dev、提交并更新 pins。执行阶段则由 [gen-exec.py](/home/user/project/work/tmp/exec/gen-exec.py) 选里程碑／过滤 done／核查外部依赖，`gen-stage.py` 裁剪阶段并注入裁决。**实际工作流不是手改 YAML 即完成修订。**

**3．裁决画像**

[p13-rulings-inject.json](/home/user/project/work/tmp/exec/p13-rulings-inject.json) 是 **10 个 node ID→长正文**的映射，代表十个注入目标，**不是十条原子裁决**。正文混合语义决定、资源要求、已修复缺陷、写集限制、worktree 恢复和后续待办。

- 注入只有精确 node ID 匹配；没有路径匹配、global scope、版本 ID 或机器可读 supersedes。
- `gen-stage.py:17` 读取映射并追加到 `packet.parent_ruling`；模板另全局引用 P13-1…P13-24 和 K1…K15。
- [plan13-rulings.md](/home/user/project/work/tmp/plan/plan13-rulings.md) 有 **24 个编号裁决、4 轮**。可见替代例子包括 P13-14 覆盖 P13-2 的“20/21 输入恢复”结论。
- 注入文件保留 **3 个状态、至少2次变更**：8→8 项时修改 KA；8→10 项时新增两个 FAULT 目标。正文更早的追加次数无法从备份完整恢复。
- 当前计划还含 **82 条 plan_corrections、10 条 parent_followups**；ledger 有 **103 个 commits 项、9 个 attested 项**。这些数量不能相加作为裁决总数。

明确冲突包括 epoch 从“启动推进”改为“不推进”、KA 修复先划入又移出写集，以及代码量／资源规则与原字段不一致。应保留有效版本和覆盖关系，不能让执行者从追加正文自行猜最终决定。

**4．对 PRODUCT／DESIGN 的具体修正**

| 位置 | 建议修改 | 理由与证据 |
|---|---|---|
| DESIGN §3.1 | 分离 `kind`（执行／聚合／外部）与 `work_type`（contract、implementation、test、experiment、closure）；增加 milestone、retired/superseded | 29 个 contract 中含3个聚合器；已退役节点仍需保存 accepted 历史 |
| DESIGN §3.1–3.3 | 增加 typed evidence dependencies：契约、测试包、接口、运行产物、闭包回执；明确依赖需要 accepted 还是 integrated | 23 个 frozen-contract 引用、2个同候选闭包；仅 deps 状态无法说明证据可用性 |
| DESIGN §3.1；PRODUCT §2–3 | 验收改为阶段列表；红证明支持 baseline、contract receipt＋mutation 等模式，保存 oracle、case manifest、vectors 和 bindings 摘要 | 91 个节点同时有 acceptance/regression；已有合法 `red=null` 替代裁决 |
| DESIGN §3.1 | 写集路径显式类型化；区分 allowed changes、required outputs、共享注册所有者 | FRAME、APPLY、KA 均因 output_paths 多列未修改文件被误拒；252 对共享路径 |
| DESIGN §3.1；PRODUCT §5 | 资源支持数量、阶段、机器范围和独占窗口；分别记录声明、实测、批准覆盖 | 4→16 GiB、三层 timeout、测量暂停 fleet；资源执行仍交 dsa |
| DESIGN §3.1、§7 | 预算插件需 metric、scope、cap、exclusions、authority；评审明确独立评审／父级批准，勿由模型名称推出人数 | 300/500、countSource/diff、136→256 h；parent+S 不等于两名模型评审 |
| PRODUCT §6；DESIGN §3.1 | PlanRevision 增加 parent digest、来源生成器、批准记录、输入 pins、结构 diff；区分草稿、已安装、待并入 | 21次已安装提交、26快照及非计划叶，证明修订生命周期不可省略 |
| DESIGN §3.4 | 裁决拆成原子对象，增加 target fields、effective revision、supersedes、落实状态；派活保存解析后的有效裁决集合/hash | 十个长正文包含多轮互相覆盖的决定；82 corrections 与10 followups 需回链 |

“未需要”的结论应收窄为：本次 J1 **没有观察到 external kind、R0、节点级 protected 数组、`reuse: never` 或显式 reviews.required 数字的使用**；这不足以证明未来不需要。反过来，J1 的 node 数不能作为这些字段必要性的证据。

本报告保留当前 pins、canonical plan、生成器、Git 历史、裁决和 pending 记录作为主证据；排除旧 `tmp/plan/nodes.json`（952节点）及其 schedule/critpath 作为当前统计来源，也未执行会写文件的生成器或嵌入式校验代码。下一步最有价值的是：用上述真实形状构造只读导入样例，并补取 dsa 启停事件以计算实际并发峰值；现有材料不足以给出该实测数字。