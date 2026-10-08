# pi-dag 产品形态（草案 v0.3，2026-10-08）

> v0.3 依据 J1 的实证（`research/j1-findings.md`，原始报告见 `research/j1-*.md`）修订了 v0.2（已存为 `research/PRODUCT-v0.2.md`）。主要变化有三点：
> - 回执除了证明“确实跑过”，还要说明“测得够不够”；
> - M0 从 J1 已有的 checker 和账本提炼，不再从零写；
> - worktree、资源和写者认领改为以叶子为单位。
>
> dsa 依据 1.0.16 源码（`../pi-conductor`，HEAD f63bb43）。

## 1. 一句话与边界

**没有回执，不算完成；回执写明测了什么、没测什么。**

pi-dag 是多个 agent 改同一仓库时用的**验收账本和合并门禁**。

- **为什么后半句不能省**：J1 合入后发现的 4 次真实逃逸（FAULT-POWER、K4、maxBuffer、PLAN2）都出在 oracle 过宽，或者候选集成时测试没选全。“确实跑过”这一层，J1 自建的 checker 已经守住了（脏树、短 SHA 都被拒收），没有发现执行造假。
- **用户**：用 pi + dsa 同时跑多个写者、项目持续数天的负责人。第一个用户是 work/app（J1 的剩余部分或下一阶段）。
- **pi-dag 负责**：
  - 计划图及其修订；
  - 独立验收和回执，包括覆盖范围和 oracle 强度；
  - 合并门禁，包括候选回归选择和合并前评审门槛；
  - 节点级写者认领；
  - 裁决；
  - 逃逸台账。
- **pi-dag 不负责**：进程、重试、模型和会话恢复，这些归 dsa；什么是“正确”由项目的 oracle 定义；推主干和发布由人决定。
- **本地信任边界**：验收进程和写者是同一个 OS 用户。本地模式能防失误和偷懒，防不了恶意进程。账本采用哈希链，能发现事后改动，但对外不说“防篡改”。

## 2. 一个具体例子

owner 在 10-08 问过：“这个 dag 实际要怎么动作的”。下面是用 J1 的 FAULT-POWER 回放的一遍：

1. 父级执行 `dag dispatch J1-FAULT-POWER`。pi-dag 认领节点（attempt a1），记下当时的状态：
   - base 是 dev 的 `4749f916…`；
   - 计划修订 v27@21；
   - 有效裁决集合 hash，包含 P13-24 和 K15；
   - 测试包 hash；
   - 该节点的风险档 R2 和评审档 S。

   然后通过 dsa 派出写者，worktree 归这个叶子持有。
2. 写者完成，报告 `accept=pass`。dsa 在封存前运行 gate：`pi-dag attest`。attest 用叶子 commit 的干净源码快照，加上可信测试包，复用可信构建缓存，跑出以下结果：
   - red：契约在 base 上失败，并且是预期的断言失败；
   - green：7/7，TAP 完整；
   - 写集合规；
   - **变异检查：18 个合成错误输入里有 10 个被 oracle 放行**，所以 oracle 强度判为弱。
3. 回执卡显示：
   - 执行：✔ 实测 7/7；
   - 验收强度：⚠ 弱（10/18 存活）；
   - 评审：未评审。

   R2 节点在验收强度为弱时自动升档评审。
4. 评审返回 BLOCK，列出 4 个 oracle 问题，节点**不进入合并**。待决队列里出现一项“交给父级处理”：修 oracle，还是接受弱 oracle 并补登无回执？推荐“修 oracle”，并附上影响的下游数量。
5. 修订后，回执显示：执行 ✔、强度 ✔、评审 ✔。`dag merge` 的过程：
   - 先构造候选（dev tip + 叶子）；
   - 按影响面选出回归测试：k4 ledger sweep 和 retarget；
   - 在候选上验证；
   - 短锁，用 CAS 推进 dev，写入 IntegrationAttestation。
6. 晨报（中文，不用节点代号）：“断电判定这一块现在能正确拒绝历史落后的恢复。昨天差一点带着太宽的判定器合进去，被评审拦下了，已经修好。还要你决定 1 件事：……”

**J1 当时实际发生的情况**：第 3、4 步不存在，7/7 直接合入，合入后的评审才发现问题。K4 那次是回归集漏了 k4，第 5 步的“回归选择”本来可以拦住。

## 3. 用户看到的三样东西

1. **回执卡**（`dag show <node>`）
   - **卡首用人话**：验证了哪些用户可见行为；版本和环境；证据入口（日志、截图页、Studio 对比链接）；**未测范围和已知例外**。
   - **三个维度分开显示，不合成一个总状态**：
     - **执行**：✔ 实测 / ✘ 拒收（附原因）/ ⚠ 无回执。override 和合并后评审都算无回执，永远单列。
     - **验收强度**：变异或负例的存活比例、覆盖了哪些义务、候选回归选了哪些测试。
     - **评审与人工验收**：独立评审结论、是否有人实际执行过（只读评审不算），以及产品/部署层面的人工验收状态。“可验收”不等于“已验收”。
   - 完整 OID、哈希、runner 版本、日志哈希、裁决集合 hash 都放在展开区。
2. **待决队列**
   - 按等待对象分三列：**等 owner / 等父级 / 等依赖或资源**。休眠中等测量窗口的不算等人。
   - 同一事项合并成一项，附上推荐、理由和影响。支持批量答复（“按推荐”），也可以选“授权父级决定”。
   - 排序综合考虑：下游数量、关键路径、已等待时长、外部截止时间。这个排序是否有效还没有验证。
   - 统计口径：去重之后**首次**交给 owner 的独立事项数；提醒次数单独统计。
3. **两份报告，事实相同、读者不同**
   - **给 owner 的中文晨报**：现在能做什么，离目标还差什么，为什么变慢或扩项，现在要你决定什么。无回执的合入和逃逸台账的变化必须写出来。
   - **给 agent 的交接**：HEAD、锁、pins、run id、恢复步骤和下一条关键链。注明截至时间，已作废的内容要明确标出来。

## 4. 一个节点的一生（与 dsa 配合）

```
dag dispatch N
 ├─ pi-dag：节点级 CAS 认领 attempt aK（覆盖 dsa 内部重试、手动 follow-up、父级临时会话）
 │    派活快照：base OID、计划修订、有效裁决集合 + hash、测试包 hash、策略 hash
 └─ dsa.submit(key = dag:<proj>:N:aK, spec = {
        agent, task = 派活包, isolation: "worktree", base: <OID>, worktreeOwner: "dag:<proj>:N",
        schema = report, gate = { command: "pi-dag attest --attempt aK", output: "json", timeoutMs } })

dsa：叶子级 worktree（跨轮次保留）→ 写者 → report → 写者退出
dsa gate（beforeSeal，最多一次，fenced）：pi-dag attest
 ├─ 源码：叶子 commit 的干净快照；运行目录：全新；构建缓存：按策略允许的可信缓存
 ├─ red：按节点的 red 模式（见 §6）
 ├─ green：TAP 完整、精确用例集合（零用例、skip、重复都判失败）
 ├─ 写集：允许的改动 / 必须产出 / 共享注册文件的所有者
 ├─ 强度：R2 及以上按策略跑变异或负例（太耗时的转为单独的验收 attempt）
 └─ ExecutionAttestation 写进账本；stdout 输出 JSON 摘要，进入 data.gate
pi-dag sync：按事件游标消费 → verified / rejected / unknown
 └─ 按评审档和强度派评审（R2+ 强度弱时自动升档）；评审回执需要写明“是否实跑”
dag merge：候选 = 集成 tip + 叶子 → 回归选择 → 在候选上验证 → 短锁 → 重新检查 PRE 和策略 → CAS → IntegrationAttestation
```

**约定与限制**
- attest 只要产生了回执就以 0 退出，拒收也是 0。非零退出表示 attest 自身的基础设施错误，结果记为“未知”。
- **gate 的恢复语义是“可恢复裁决”，不是“可续跑”。**
  - dsa 恢复时，未决的 gate 会被 fence，并记为 unknown，不会重跑；
  - timeout、stopped、budget 三种状态会跳过 gate。

  所以 pi-dag 要按 execution key 对账已经落盘的回执，没有回执就新开一个验收 attempt（需要 S5）。
- **长验收不放在写者 call 的 gate 里。**
  - 适合放进 gate 的：快测，加热缓存后的构建，J1 中位约 5s，P90 约 85s；
  - 不适合的：17 分钟级、小时级、需要 LazyFS 或独占测量的验收。这些走 S5 的 exec call，并申请资源租约。
- 写者认领只能经由 pi-dag。旧 attempt 迟到的交付只记入历史；新写者启动前，要确认旧进程和后台作业已经退休。

## 5. 分工与 dsa 改动

| 关注点 | dsa | pi-dag |
|---|---|---|
| 进程、重试、模型、会话恢复、预算 | ✔ | — |
| worktree | 创建；按 owner key 保留，直到显式释放 | 指定 base 和 owner；合入后释放 |
| 单写者 | 每个 call 一个 worktree，外加幂等 key | 节点级 CAS 认领和 fencing |
| 验收执行壳 | gate 或 exec call：fence、最多一次 | attest 的内容、可信测试包、对账 |
| 资源 | 执行时持有租约，进程外回收 | 声明、实测、批准覆盖 |
| 证据、计划、裁决、合并、逃逸台账 | — | ✔ |

| # | dsa 改动 | 优先级 | 依据 |
|---|---|---|---|
| S1 | 程序化 submit + 调用方幂等 key | 硬，M2 | 现在只能由 LLM 通过 `subagents` 工具启动；内部 `Outbox.send(..., {rid})` 已经是幂等的 |
| S3 | worktree 的 base 和 owner 由调用方指定，保留到显式释放；status 带 path/branch/base | **硬，必须在 gate 方案之前** | J1 的 worktree 要跨 W1–W5、评审、裁决和补证；dsa 现在 ok 后会删除干净的 worktree |
| S4 | 资源租约（数量、独占、进程外回收） | **硬，J1 级项目的 MVP** | load≈16 时测试失败；8 个孤儿 LazyFS 挂载，约 7.3GB；全机内存约 14.7GB |
| S5 | 无 agent 的 exec call（durable、fenced、最多一次） | **硬，用于长验收和合并候选验证** | 17 分钟和 6h 的矩阵；gate 恢复时不会重跑 |
| S2 | 跨 workflow 事件游标 | M1 先用只读 journal 适配器，M2 闭环前再提供稳定 API | 影子模式不需要稳定 API |

**待验证**：`prepareWorktree` 在已有 `wt-removed` 记录时直接返回旧路径，follow-up 时可能指向一个不存在的目录。

## 6. 计划、证据与裁决模型（取代 DESIGN §3.1–3.4 的相应部分）

- **节点**
  - `kind`（执行／聚合／外部）和 `work_type`（contract／implementation／test／experiment／closure）分开；
  - 还要有 `milestone`、`risk`、`review_tier`（S／parent+S／A）和 `retired_by`；
  - 计划外的修补叶（AMEND/FIX）也要是一等节点。J1 有 15 个 done ID 不在计划里。
- **依赖**：除了 deps，还要有带类型的证据依赖：契约、测试包、接口、产物、闭包回执。每条依赖写明它要求的是 accepted 还是 integrated。
- **验收**：一个阶段列表（acceptance、regression…），每个阶段有命令、env、超时和资源。red 有以下几种模式：
  - `same-bundle-on-base`；
  - `red-origin`：首次包含最终测试字节的那个提交；
  - `inherited-contract`；
  - `null-impl/mutation`；
  - `none`：只允许少数指定的 work_type。

  测试包、vectors 和 case manifest 都按 hash 冻结。
- **写集**：分成 `allowed`（允许改动）、`required_outputs`（必须产出）、`shared_registration`（共享注册文件，指定 owner）。J1 中有 252 对节点共享精确路径；多个节点曾因 output_paths 列了没改的文件而被误拒。
- **资源**：表达数量、阶段、机器范围和独占窗口，并分别记录声明值、实测值和批准的覆盖。例如 FAULT-RUNNER 从 4GiB/900s 调到 16GiB/1800s。
- **预算**：插件形式，写明 metric、scope、cap、exclusions 和 authority。J1 的例子有 300/500 行上限、countSource，以及总预算从 136 到 160 再到 256 小时。
- **PlanRevision**：记录父 digest、生成器、输入 pins、结构 diff 和批准人；状态分为草稿、已安装、待并入。计划可以由生成器产出 JSON 后导入（J1 就是用 Python 生成器维护的），不要求手写 YAML。
- **裁决**：
  - 原子化；
  - 带 `authority`（owner 或 parent）、`targets`（节点、路径或全局，加上目标字段）、`supersedes`、生效修订和落实状态；
  - 派活时记录解析后的有效集合和它的 hash；
  - 前提被证明错误时，可以撤销，并列出受影响的批准和回执，例如 case 误判那次。

  J1 的 `p13-rulings-inject.json` 是“10 个节点 → 长正文”的映射，正文里混着多轮相互覆盖的决定，正是这里要拆开的东西。
- **证据复用**：只在 execution key 相同（同 tree，同测试包/策略/环境/工具链）时自动复用。按“闭包未变”复用必须由项目显式声明，并单独记为一种复用。

## 7. 存储

- 账本放在 `$(git rev-parse --git-common-dir)/pi-dag/`，包括 `journal.jsonl`（flock + seq + 哈希链）、`attestations/` 和缓存。所有 worktree 共享这一份，reset 不会让它倒退。
- 策略（受保护路径、验收命令、插件、checker）从集成分支已 pin 的 commit 读取，不从候选读取。
- `dag export` 导出到 `refs/pi-dag/ledger`。v1 只支持单机单写。

## 8. 交付顺序

| 里程碑 | 内容 | 依赖 | 验收与去留判据 |
|---|---|---|---|
| **M0 证据内核** | 从 J1 的 `check.mjs`、`receipt.mjs`、`ledger.py` 提炼出 `pi-dag attest`，加上验收强度（变异/负例）和候选回归选择。诱饵 v0 分三组：(a) J1 已核实事故的回放（FAULT-POWER 的 18 个输入、K4、maxBuffer、PLAN2、W3 双写、短 OID、运行中 README 漂移、缺评审就请求 merge）；(b) 合成威胁（`sys.exit(0)`、零用例、改测试）；(c) 封存的第三方题目 | 不需要 dsa 改动 | 每组分别公布：J1 原有门禁是否已经拦住、pi-dag 在哪一层拦住。J1 的真实叶子不误拒。成本分三档测：快测、Rust 冷/热构建、LazyFS 长测 |
| **M1 影子** | 只读 dsa journal 和 git，生成回执卡、三列待决队列、中文晨报和 agent 交接 | M0 | 用 J1 的材料核对这三样东西能否回答 owner 反复问过的问题（“还差什么”“哪些要我决定”“为什么变多了”）；采集待决量和误拒率 |
| **M2 派活闭环** | 节点认领 → dsa（叶子 worktree）→ gate attest（json）→ sync → 对账 unknown | S1、S3 | 自动重派和手动续跑同时发生时，只有一个写者；崩溃重放不会重复派活；unknown 不会被当作拒收 |
| **M3 合并门禁** | 候选 + 回归选择 + 评审门槛 + CAS；长验收走 exec call 和资源租约 | M2、S4、S5 | PRE 被外部改动时拒绝提交；不会重复合入；缺评审就拒绝合并 |
| **M4** | 原子裁决与失效、逃逸台账、TUI | M3 | — |

## 9. 相对 v0.2 的变化

1. 一句话加了后半句；回执改为执行、强度、评审三个维度。
2. 加入具体例子（§2）。
3. 待决队列按等待对象分三列，加上推荐和批量答复；晨报分成人和 agent 两个版本。
4. gate 改用 json 模式，语义改为“可恢复裁决”；长验收移到 exec call。
5. worktree 和写者认领都以叶子为单位。S3、S4、S5 升为硬依赖，S2 降为 M2 前提供。
6. “全新 clean checkout”拆成源码快照、运行目录和构建缓存三件事。
7. 计划和裁决模型按 J1 的真实结构重写（§6）。
8. M0 改为从 J1 现有实现提炼；诱饵分为已核实回放、合成威胁和第三方题目三组。

## 10. 待定问题

1. 本地信任边界能否接受？
2. S1、S3、S4、S5 在 dsa 里由谁实现？S4 先放在 pi-dag 里做本地实现，还是直接进 dsa？
3. 首个落地对象：J1 的剩余叶子和下一阶段，还是一个新项目？
4. 裁决权：哪些类别 owner 保留，哪些授权父级？
5. 验收强度在 R2 及以上默认开启后，成本（变异次数 × 验收时长）能否接受？默认值要等 M0 实测后再定。
