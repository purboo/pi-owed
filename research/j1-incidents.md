**证据支持“验收账本与合并门禁有价值”，但不支持 DESIGN §1.1 的“十类都已证实、都能由工具拦住”。** 本轮确认了已合入的缺陷、既有门禁成功拒收、重复派工和 oracle 过弱四种不同问题。尤其 FAULT-POWER **已有正式 red/green 回执，仍在合入后被评审 BLOCK**；仅加强回执执行真实性不足以解决它。

全程只读，未修改文件。以下是 **14 条有出处的事故样本，不是全项目穷尽计数**。分类互斥：已接受/合入的错误优先记 **a**，另标 oracle 根因；尚未逃逸的弱验收记 **d**。耗时只报实测或时间窗口，不把运行总时长直接算作浪费。

**1．事故账本**

| 日期、节点 | 发生了什么、如何发现；成本 | 分类、置信度 | PRODUCT 机制能否拦截 |
|---|---|---|---|
| 10-08，AMEND-J1-FAULT-POWER-JUDGE | 验收期间修改 README，7/7 通过但 `identity mismatch` 拒收；这次运行 **3:04.05**。[原始回执及时间](/home/purboo/project/xwell/tmp/evidence/AMEND-J1-FAULT-POWER-JUDGE/attempt2-9d052b14-dirty-accept.log:1) | **b，高**。不是已接受的假通过。 | **能避免该竞态**：写者结束后在独立 clean checkout 执行。但旧 checker 已成功拒收。 |
| 10-08，同修订叶 | `ARCH_APPROVED_SHA` 仅 8 位，exit 2，测试根本没跑；写者明确报告这次验收作废。[执行日志](/home/purboo/project/xwell/tmp/evidence/AMEND-J1-FAULT-POWER-JUDGE/attempt1-7d4390fd-accept.log:1)、[写者报告](/home/purboo/.pi/durable-subagents/w/01M4CQCE910RBXF9SV4CC41RXV/journal.jsonl:1505)。成本未知。 | **b，高** | **能**：runner 自动解析完整 OID；仍应记配置/基础设施错误，不能记测试失败。 |
| 10-07，J1-FAULT-RUNNER | W2 超时后旧 wave 自动起 W3，父级另开收尾会话；17:4x 发现后停掉新会话，后者只读未写。17:2x—17:4x 是发现窗口，非精确重叠时长。[记录](/home/purboo/project/xwell/tasks/2026-10-06-j1-restart-handoff.md:180) | **c，高** | **有条件能**：所有自动重派与手动启动都必须经过同一个 node/attempt CAS。仅按 attempt 生成不同 key 不足以互斥。 |
| 10-07，J1-FAULT-RUNNER 合并 | merge 日志两次等待同节点父级锁；脚本每次 sleep 15 秒，故可见等待约 **30 秒**。[日志](/home/purboo/project/xwell/tmp/evidence/J1-FAULT-RUNNER/parent/merge.log:1)、[锁代码](/home/purboo/project/xwell/tmp/exec/parent-merge.sh:9) | **c，中**。自锁解释吻合，但未找到父级最初拿锁命令。 | **不能由 CAS 本身保证**；还需单一锁所有者、禁止重入及有界等待。 |
| 10-05，J1-BASELINE／S0-J1-VIEW | 父级误报计划未指定 case，获 owner 同意后派错输入；查签名计划后撤回，数据作废、向量重建。[明确更正](/home/purboo/project/xwell/tasks/2026-10-03-rederive-decisions.md:66)、[下游处理](/home/purboo/project/xwell/tasks/2026-10-01-studio-principles.md:391)。返工时长未知。 | **c，高** | **不能自动保证**。冻结错误任务包同样会忠实执行；必须把计划输入与派活输入做可执行一致性检查。 |
| 10-05，J1-BASELINE | 写者 3h 超时，测量链仍在运行；resume 沿用旧期限立即再次到期，随后新 run 接续剩余步骤。[记录](/home/purboo/project/xwell/tasks/2026-10-01-studio-principles.md:393)。3h 是运行时长，净浪费未知。 | **c，高** | attempt 谱系帮助恢复，**不能修复 deadline 语义**，属于 dsa 生命周期职责；也不是“从头重做”的证据。 |
| 10-08，J1-FAULT-RECOVERY | acc1 在 dirty 状态通过，**480 秒**；acc2 被 6h 超时打断。父级要求最终 clean tip 正式跑两遍。[原始 follow-up](/home/purboo/.pi/durable-subagents/w/01M4CCA3JY59V3ZQQD1VE6W10S/journal.jsonl:9609) | **b，高** | **能拒绝复用 dirty 结果**；不能消除昂贵矩阵超时。最终是否通过必须另取新回执。 |
| 10-08，J1-FAULT-POWER | `a7c29f27` 合入并获正式 red-first accepted；随后评审发现 oracle 接受无关错误、缺回复、未冻结线程等，合成输入 **18 项中 10 项违背预期**。[accepted](/home/purboo/project/xwell/tmp/exec/accepted/J1-FAULT-POWER.json:3)、[修订证据](/home/purboo/project/xwell/dev/wais-worktree/dev/evidence/J1-FAULT-POWER/README.md:293)。Git 提交时间显示原合并至修订合并约 **39 分钟**，非人工工时。 | **a，高；根因 oracle**。逃逸的是错误验收器；文档明确产品当次实际通过有依据，不证明发生数据损坏。 | **同一测试包仍会通过**。需要合入前评审、oracle 负例/变异；可信 overlay 还必须覆盖被测试调用的判定辅助模块。 |
| 10-06—07，Z08-barrier／RESTORE 等，FIX-K4-LEDGER-ACCESS | 已合入源码有 **4 处真实绕过 Ledger 写入**，另有 4 处测试误报；计划安装 sweep 发现，追溯首次变红到 `dc1ec200`。原回归集没含 k4。[诊断](/home/purboo/project/xwell/tmp/evidence/FIX-K4-LEDGER-ACCESS/diagnosis.md:5)、[遗漏原因](/home/purboo/project/xwell/tmp/evidence/FIX-K4-LEDGER-ACCESS/diagnosis.md:79)。首次引入至修复合并约 **4h39m**。 | **a，高**；不是并发第二写者。 | **仅在候选集成测试含 k4 时能拦**。clean、写集、CAS 均不能补上漏选的测试。 |
| 10-04，S1-CANDIDATE-RUNNER（v27） | 只用小 fixture 验证的 runner 已进入下游；D02 才发现读取真实 6.5MB 计划触发默认 1MiB `maxBuffer`，`ENOBUFS` 被误报成身份不匹配。[记录](/home/purboo/project/xwell/tasks/2026-10-01-studio-principles.md:334)。返工未知。 | **a，高；根因 oracle 覆盖不足** | **不能**：小 fixture 在可信 runner 上仍绿。必须增加代表性真实仓库闭包验收。 |
| 10-04，PLAN2（v27） | 已安装计划被序列化为单行，导致按行冻结的历史例外失配；重新签发规范格式修复。[记录](/home/purboo/project/xwell/tasks/2026-10-01-studio-principles.md:342)。两次合并相距 **26m44s**。 | **a，高**，集成回归逃逸 | **有条件能**：候选阶段运行受影响的 retarget 测试；仅重复原四项信任根检查仍漏。 |
| 10-05，J1-BASELINE | 评审确认统计复算吻合，但身份仅信标签，fps/RSS/GPU 等字段无守卫绑定，非等价 M6 存活；留作后续义务。[评审摘要](/home/purboo/project/xwell/tasks/2026-10-01-studio-principles.md:398)。成本未知。 | **d，高**；没有证明数据造假。 | **不能**：TAP 完整只证明断言执行。需从原始样本重算身份与指标。 |
| 10-08，J1-COLD-PLAY | 7/7 runner、17/17 变异通过后，独立评审发现新 `sync_all` K15 边界未列清单、未注入。06:00 BLOCK，10:3x 补证合入；窗口约 **4.5h**，与 PUMP 修复交叠。[记录](/home/purboo/project/xwell/tasks/2026-10-06-j1-restart-handoff.md:220)、[补证](/home/purboo/project/xwell/tasks/2026-10-06-j1-restart-handoff.md:226) | **d，高**；合入前发现 | **不能仅靠现有回执字段**；要把新增持久化边界与注入覆盖绑定。尚不能证明根因是“忘了注入裁决”。 |
| 10-07，J1-EDGE-MOTION | 父级提出 epoch 裁决 R1，写者实测发现会使已 admit duty 失败，父级撤回并修订契约。[记录](/home/purboo/project/xwell/tasks/2026-10-06-j1-restart-handoff.md:146)。成本未知。 | **e，高**，错误裁决被纠正 | **不能**；注入完整也会传递错误要求，需要行为验证与撤销语义。 |

**2．十类声明的核验与计数**

按 [DESIGN §1.1](/home/purboo/project/pi-things/pi-dag/DESIGN.md:54) 的原顺序：

| 声明 | 核验结论 |
|---|---|
| ① dirty 通过 | **部分成立**：测试绿、最终拒收确有证据；未证实该结果被接受，也未证实写者隐瞒 dirty。 |
| ② 短 SHA | **成立**，旧门禁已在执行前拒绝。 |
| ③ 两个写者 | **成立**，两个写者会话重叠；未发生双重写入。 |
| ④ 父级重入锁死锁 | **部分成立**：同节点锁等待证据充分，完整重入因果链欠缺；不是永久死锁。 |
| ⑤ K15／I4／BOUND 漏注入 | **未证实该根因**。K15 漏覆盖成立；不能从漏覆盖反推出任务包没注入。 |
| ⑥ 误称计划没有 X | **成立**，有明确认错及作废记录。 |
| ⑦ 不同树复用旧证据 | **未证实为错误逃逸**。RECOVERY 最终账本明确采用“import closure unchanged”复用，属于较宽证据政策，尚无复用导致错误的证明。[账本](/home/purboo/project/xwell/tmp/exec/ledger-amendments.json:105) |
| ⑧ done.txt 缺 SHA | **未找到历史事故证据**。当前文件无此问题；解析器要求两列，不能据此证明过去发生过。 |
| ⑨ 超时后从头开新写者 | **部分成立**：新 run 存在，但 BASELINE／FAULT 的记载是接续收尾；与③不能重复计数。 |
| ⑩ 未独立评审即合入 | **成立**：FAULT-POWER 明确补发合入后评审。 |

因此：**4 类成立、3 类部分成立、3 类未证实**。不是“十类已证实”。

14 条样本的主分类为：**a=4、b=3、c=4、d=2、e=1**。除锁事件中置信外均为高置信；这是样本计数，**不能除以约90个叶子计算逃逸率**。a 中存在真实集成回归和错误 oracle，但尚无证据证明“受信 runner 声称执行过、实际未执行”的事故。设计的窄指标与用户关心的错误完成并不等价。

**3．诱饵模板**

- **可直接机械化**：短 OID；运行中 README 漂移；dirty 结果复用；自动重派与手动派发竞争；嵌套锁；合并候选引入既有 k4/retarget 回归；真实尺寸计划触发 maxBuffer；缺评审回执即请求 merge。分别测拒收、互斥、有界退出和候选回归选择。
- **须补强项目 oracle 后机械化**：FAULT-POWER 的 18 个判定输入、BASELINE 标签与原始数据不一致、K15 新边界未注入、错误 case。应单列为“oracle 强度”测试，不能把其收益归给通用回执壳。
- **不能直接成为通用诱饵**：父级误解计划、错误 epoch 裁决、期限恢复策略。可模拟结构化错误，但自然语言是否理解正确仍需项目判断。
- **暂不得标“来自 J1 实际事故”**：`sys.exit(0)`、零用例、恶意改测试/规则、done 缺 SHA。本轮未找到相应实际事故；可作为合成威胁样本。

**4．具体文档修正**

1. **PRODUCT §7/M0**：把“来自 J1 十类事故”改为“已核实事故回放＋合成诱饵”，分别公布来源、旧门禁是否已拦住、预期拦截层。dirty/短 SHA 原系统已经拒收，不能当新增收益。[当前位置](/home/purboo/project/pi-things/pi-dag/PRODUCT.md:101)

2. **PRODUCT §3、§7/M3–M4**：将按风险要求的评审门槛提前到合并门禁；明确候选验证的**测试选择与闭包覆盖**。FAULT-POWER 证明 red/green 不替代评审；K4、PLAN2 证明候选身份正确不替代测试覆盖。

3. **PRODUCT §2–3**：回执卡增加“验收覆盖范围／未测义务／已知例外”，可信测试包覆盖判定器及辅助依赖；区分“实测通过”和“语义接受”。不能只展示 7/7：FAULT-POWER 的旧 7/7 完全真实，却不足以作为回归门。

4. **PRODUCT §3–4**：明确 node CAS 包含 dsa 内部重试、手动 follow-up、旧 attempt 停止及残留进程 fencing；删除无条件的“写者无法在验收过程中插手”，改为“已围栏的该次写者不能继续参与”。重复会话事故说明入口之外仍可能有写者。

5. **selling-points §2**：将指标拆为“执行事实逃逸”“oracle/覆盖逃逸”“无回执合入”，同时记录实际影响。修正统计分母：约2%诱饵意味着270节点只有约5–6次诱饵试验，**不能用270作为诱饵逃逸率分母**；三倍法则还需明确95%置信及抽样假设。[当前位置](/home/purboo/project/pi-things/pi-dag/research/selling-points.md:15)

6. **selling-points §5、§8；DESIGN §1.1**：删除“回放十类挡住八类”作为既定门槛，先冻结有证据的事故集及机制归因；删除“都发生在 agent 身上、都能工具拦住”。父级错误决策、oracle 缺口和 dsa 超时应各自归责。

保留的核心来源是原始拒收/接受回执、Git 合并身份、同时期交接、独立诊断及修订证据；未把其他卖点研究对 DESIGN 的复述作为独立证明。切片项目“ready/非空像素”事件早于本次 J1/v27 范围，未混入计数。下一步最有价值的是封存上述回放样本，并对⑤⑦⑧补齐“派活包—执行—回执—合并”链；在补齐之前保留“未证实”，不补估算次数或工时。