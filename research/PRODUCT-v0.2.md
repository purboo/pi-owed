# pi-dag 产品形态（草案 v0.2，2026-10-08）

> 依据：`research/selling-points.md`（终版卖点）、`research/SYNTHESIS.md`（P0 修订）、DESIGN.md v0.1，以及 dsa 1.0.16 源码（`../pi-conductor`，HEAD f63bb43）。本文定义产品形态和与 dsa 的分工；DESIGN.md 之后按本文修订。

## 1. 一句话与边界

**没有回执，不算完成。** pi-dag 是多个 agent 改同一仓库时使用的**验收账本和合并门禁**。

- **用户**：用 pi + dsa 同时跑多个写者、项目持续数天的负责人。第一个用户是 work/app J1。
- **pi-dag 负责**：计划图、独立验收、回执、合并门禁、裁决记录、逃逸台账。
- **pi-dag 不负责**：
  - 调度、重试、模型选择、会话恢复，这些归 dsa；
  - 定义什么是“正确”，这由项目提供验收命令；
  - 推主干和发布，这由人决定。
- **本地模式的信任边界**：验收进程和写者是同一个 OS 用户。本地模式能挡住失误和偷懒式作弊（改测试、零用例、提前退出、越出写集、脏树），挡不住同一用户下的恶意进程。账本采用哈希链，可以发现事后改动，但对外不说“防篡改”。

## 2. 用户看到的三样东西

1. **回执卡**（`dag show <node>`），每个节点只有三种状态：
   - **✔ 实测**：列出 commit/tree、可信测试包摘要、用例数（7/7，零用例按失败处理）、red→green（基线上 7 个失败，候选上全部通过）、写集检查、派活时注入的裁决版本、runner 和日志哈希。
   - **✘ 拒收**：列出具体原因，例如“tests/x.test.mjs 被修改，且不在测试包授权范围内”。
   - **⚠ 无回执**：override 或合并后再评审。永远单列，不和 ✔ 混在一起。
2. **待决队列**：汇集 asking、需要决定的拒收、override 申请、新裁决命中正在运行的节点、逃逸回链。按受影响的下游节点数排序。
3. **晨报/交接**（`dag handoff`），汇总上次查看以来的变化：
   - 合入了 N 个节点，其中无回执的必须单独列出数量；
   - 拒收了 M 个及原因，还有 K 个在等答复；
   - 逃逸台账的变化，以及诱饵拦截了 x/y。

## 3. 一个节点的一生（与 dsa 配合）

```
dag dispatch N
 ├─ pi-dag：CAS 认领 attempt a3，冻结派活快照
 │    （base commit、计划修订号、注入的裁决版本、可信测试包摘要、策略摘要）
 └─ dsa.submit(key = dag:<proj>:N:a3, spec = {
        agent, task = 派活包, isolation: "worktree", base: <commit>,
        schema = report, gate = "pi-dag attest --attempt a3" })

dsa：创建 worktree（分支 dsa/<wid>/<key>）→ 写者工作 → report → 写者进程结束
dsa gate（beforeSeal，写者已退出，最多执行一次，fenced）：pi-dag attest
 ├─ 在叶子 commit 的全新 clean checkout 中，用可信基线覆盖测试包和受保护路径
 ├─ red：基线代码 + 同一测试包 → 必须是预期的断言失败
 ├─ green：候选代码 + 同一测试包 → 检查 TAP 完整性和用例数
 ├─ 检查写集、完整 OID、clean
 └─ 把 ExecutionAttestation 写进账本；stdout 输出摘要，进入 dsa 的 data.gate
dsa sealed → 事件
pi-dag sync（任何 dag_* 调用或会话 turn 开始时触发）：
 └─ reducer 消费事件 → verified / rejected(原因) → 按风险档派评审（只读 call，key …:review:r1）
dag merge：构造候选 → 验证 → 加锁 → CAS 推进集成分支 → IntegrationAttestation
```

**为什么用 dsa 的 `gate` 当受信 runner 的入口**：
- gate 在写者进程结束之后、封存之前运行，并且有 journal、fence，最多执行一次（`src/orchestrator/executor/effects/gate.ts`、`effects/index.ts` 中的 `beforeSeal`）。
- 写者无法在验收过程中插手，pi-dag 也不需要常驻进程。
- 回执随 sealed 事件一起回来。

**约定**：
- `attest` 只要产生了回执就以 0 退出，拒收也是 0；拒收或接受的决定只存在于 pi-dag 账本。
- 非零退出只表示 attest 自身的基础设施出错，dsa 会记为 gate-failed 或 unknown，pi-dag 视为“结果未知”，不当作拒收。

## 4. 分工

| 关注点 | dsa | pi-dag |
|---|---|---|
| 进程、重试、模型、会话恢复、预算 | ✔ | — |
| worktree 创建与清理 | ✔（`isolation: "worktree"`） | 指定 base 和保留期，读取分支 tip |
| 单写者 | 每个 call 有独立 worktree，外加幂等 key | attempt CAS 认领和 fencing；旧 attempt 迟到的交付只记入历史 |
| 验收执行壳 | gate：fence、最多一次、可恢复 | gate 命令的内容（attest）和可信测试包 |
| 证据与验收决定 | — | ✔ |
| 计划、依赖、裁决、合并、逃逸台账 | — | ✔ |
| ask/answer | 提供通道 | 把答复登记为 Ruling，进入待决队列 |
| 事件 | 产生 | 按游标消费，幂等重放 |

## 5. dsa 需要的改动

**dsa 现有、可以直接用的**：`isolation: "worktree"`、`schema`/`report` → `CallResult.data`、`gate`（结果写进 `data.gate`）、`once`、`budget`、follow-up/answer/stop、模型池。

| # | 改动 | 必要性 | 现状与建议 |
|---|---|---|---|
| S1 | **程序化提交 + 调用方幂等 key** | 硬依赖 | 现在只有 LLM 能通过 `subagents` 工具启动 run，CLI 只有 resume/drain/stop。内部的 `Outbox.send(..., {rid})` 已经是幂等的（`src/kernel/mailbox.ts`）。建议暴露为 `submit --rid <key> --spec <file>` 和库函数。同 key 同 spec 返回原 wid；同 key 不同 spec 报冲突 |
| S2 | **跨 workflow 事件游标** | 硬依赖 | 游标为 `(epoch, wid, local_seq)` 的集合。sealed 事件带 status 和 `data`（含 gate）。出现缺口时报错，不静默跳过 |
| S3 | **worktree 的 base 和生命周期由调用方控制** | 硬依赖 | 现在 `prepareWorktree` 用 cwd 的 `rev-parse HEAD` 作 base，ok 后的干净 worktree 立即删除。需要支持 `base: <commit>` 和“保留到调用方释放”，否则依赖可能缺失，拒收后的 follow-up 也没有现场。status 要带上 worktree 的 path/branch/base |
| S4 | 资源租约 | 软依赖 | MVP 先用 pi-dag 本地租约文件代替（machine-exclusive、lazyfs、browser） |
| S5 | 无 agent 的 exec call | 软依赖 | 合并候选验证、长时间的 red 运行，也需要同样的 durable、fenced、最多一次语义，这样 pi-dag 不必自己管进程 |

**待验证**：成功清理 worktree 之后再 follow-up，`prepareWorktree` 在已有 `wt-removed` 记录时直接返回旧路径，可能指向一个不存在的目录。

## 6. 存储

- 账本放在 `$(git rev-parse --git-common-dir)/pi-dag/`，内容有 `journal.jsonl`（flock + seq + 哈希链）、`attestations/` 和缓存。
  - 不进工作树：写回执不会把树弄脏，也没有自引用。
  - 所有 worktree 共享这一份；`reset` 也不会让账本倒退。
- **计划**：人编辑仓库里的 `pi-dag/plan/*.yaml`，通过 `dag plan import` 记为一次修订。
- **策略**（config、受保护路径、验收命令、插件）从集成分支的已 pin 的 commit 读取，不从候选读取。
- **备份与跨机读取**：`dag export` 导出到 `refs/pi-dag/ledger`。v1 只支持单机单写。

## 7. 交付顺序（重排 DESIGN.md §8：证据先于调度）

| 里程碑 | 内容 | 依赖 | 验收与去留判据 |
|---|---|---|---|
| **M0 证据内核** | `pi-dag attest` CLI，加诱饵集 v0（来自 J1 十类事故里可以机械化的那些：脏树、错树、短 SHA、零用例、`sys.exit(0)`、改测试/改规则、越出写集） | 不需要 dsa 改动 | 诱饵全部拒收；J1 的真实叶子不误拒。同一套诱饵也跑 GitHub required checks 和 CC hooks；差距小于 2 倍就先重审卖点，再做 M2 |
| **M1 影子账本** | 只读 dsa status/journal 和 git，为正在进行的项目生成“有回执/无回执”晨报，不控制任何东西 | M0 | 拿到 E1 数据、每天的待决量和误拒率；待决每天超过 15 条就不提“放手” |
| **M2 派活闭环** | dispatch → gate attest → sync → 拒收后 follow-up 或开新 attempt | S1–S3 | 节点没有双写者；崩溃重放后不会重复派活 |
| **M3 合并门禁** | 候选验证、CAS、IntegrationAttestation | M2，S5 可选 | PRE 被外部改动时拒绝提交；崩溃后不会重复合入 |
| **M4** | 裁决注入与失效、逃逸台账、评审编排、TUI 看板 | M3 | — |

## 8. 相对 DESIGN.md v0.1 的变化

1. 删除“默认采信写者自测”：verify 改为由 dsa gate 自动触发，父级也可以手动触发。
2. 证据键从 tree 改为 execution key；red-first 改为“同一测试包跑两次”；零用例判失败。
3. 存储从工作树挪到 git common dir；策略从可信基线读取。
4. 合并改为“先验证候选，再 CAS 推进”。
5. MVP 顺序改为证据内核 → 影子 → 派活 → 合并。
6. 对 dsa 的需求从 D1–D3 改写为 S1–S3（新增 S3 base/生命周期）。D4 写者锁大部分已由 `isolation: "worktree"` 加 attempt CAS 覆盖。
7. 新增诱饵集和逃逸台账，北极星指标为假完成逃逸率。

## 9. 待定问题

1. 本地模式只防失误和偷懒，这个信任边界能否接受？还是 M0 就要上容器或独立用户的 runner？
2. S1–S3 在 dsa 里由谁实现？是否接受公开 `submit` CLI 和库 API？
3. 首个落地对象选 J1 的剩余叶子（真实，但已接近尾声），还是一个新项目（能从 M1 影子模式开始完整测量）？
