# pi-dag 设计文档

> **状态（2026-10-08）**：本文为 v0.1 原始设计。§3、§5、§10、§12 已部分被 `PRODUCT.md` v0.3 与 `ARCHITECTURE.md` a3 取代；§10 第 2 条（采信写者自测回执）作废；§3.2 的"合并后再评审"不再是正常路径；§12 的数字为父级自估，以实验 E1 为准。阅读顺序见 `README.md`。

状态：草案 v0.1（2026-10-08）
来源：Walle AI Studio 架构重构 J1 里程碑期间父级的实际工作记录（2026-10-01 至 10-08）
定位：pi 包，依赖 pi-durable-subagents（下称 dsa）

---

## 0. 一句话

**dsa 负责把活可靠地干完；pi-dag 负责独立判断活干得对不对，并维护整个项目的任务图。**
判断的一方和被判断的一方必须是两个组件。

---

## 0.5 一个具体例子：J1-FIRST-CHUNK 的一生

用 wais 里真实跑过的叶子走一遍。每步左边是 2026-10-08 父级的手工做法，右边是 pi-dag 的做法。

| 步骤 | 现在（手工） | 有 pi-dag |
|---|---|---|
| 1 登记 | 手写 `first-chunk-task.md`，写集、预算、门槛都在正文里 | `dag add J1-FIRST-CHUNK --deps J1-COLD-PLAY --risk R2 --write-set crates/wais-exec/src/journey_derive*.rs --accept "node --test …j1-cold-play.test.mjs" --budget prod=150,test=300`；COLD-PLAY 在账上已 integrated，节点自动 **ready** |
| 2 派活 | 手建 worktree、拼说明、手抄相关裁决（K15、O′ 排序、按 diff 计行数），漏抄过 | `dag dispatch`：从集成分支拉 worktree，自动注入作用域命中的裁决，以键 `wais:J1-FIRST-CHUNK:a1` 调 dsa；重复派活返回同一 wid → **running** |
| 3 提问 | 回复后再手抄进交接日志和 plan14-pending.md | `dag answer --rule --paths journey_derive_drive.rs --carry "BOUND 只计存活进程…"`：回复、登记裁决、进下一版计划待办，一步完成 → 以后改这个文件的叶子自动带上 |
| 4 交付 | 读写者报告，自己核对 dirty、SHA、写集（出过 dirty=1、短 SHA） | 交付只到 **delivered**；`dag verify` 查 clean、完整 SHA、diff ⊆ 写集（改了 `tools/arch/faults/power-loss.mjs` → 找到授权裁决才放行）、先红后绿、TAP fail=0、代码量插件 → **verified**，回执绑定树哈希 |
| 5 评审 | 手写评审任务文件，手动派 | `dag review` 按风险档派 Opus；BLOCK → rejected + 问题挂节点，`dag dispatch` 续跑同一 attempt；OK → **accepted** |
| 6 合并 | 手拿锁（撞过死锁）、发现 `dev/target` 不干净、合并、跑检查、改 done.txt / ledger / 交接日志、删 worktree | `dag merge`：锁、quarantine、合并、树相同则复用证据、合并后检查、记账、清理 → **integrated**；J1-FAULT 的依赖齐了就自动 ready |

随时 `dag status J1` 看板，`dag handoff` 生成交接摘要。父级仍然做决定（怎么裁决、评审意见收不收、要不要 override）；pi-dag 接手记账和拦截。

---

## 1. 动机：为什么要做

wais 重构是一个多 agent 并行改同一个仓库的项目，规模如下：
- 计划约 300 个节点，J1 里程碑有 91 个叶子；
- 同时最多 9 个写者；
- 持续 1 周以上，跨几十个 workflow 和多次会话压缩。

父级大部分时间不在做设计决策，而在手工记账。账本散在 `tmp/exec/` 下一堆手写文件里：

| 现有手工物件 | 作用 |
|---|---|
| `plan/nodes.json`（17 万行） | 节点、依赖、写集、验收命令、风险档 |
| `gen-exec.py` + `exec-template.js` | 算就绪集，生成派活 workflow |
| `p13-rulings-inject.json` | 裁决，按叶子手工注入任务说明 |
| `done.txt` | 已验收叶子及其合并 SHA |
| `ledger-amendments.json` | 跨 owner 改动和父级修订的台账 |
| `parent-merge.sh` + `dev.lock.d` | 单写者锁、合并、合并后验收 |
| `pins.env` | 计划和检查器的签名 pin |
| `tasks/*-handoff.md` | 跨会话交接日志 |
| `plan14-pending.md` | 待并入下一版计划的事项 |

### 1.1 实际出过的错

这些错都发生在 agent 身上，而且都本可以在工具层拦住：

| 事件 | 根因 | pi-dag 怎么拦 |
|---|---|---|
| 子代理报告“通过”，但验收时工作区 dirty=1 | 直接信了报告 | 回执必须带树哈希和 clean 标志，由父级独立核对 |
| `ARCH_APPROVED_SHA` 写成 8 位短 SHA，验收没跑就 exit 2 | 手工拼环境 | 验收由 pi-dag 执行，SHA 一律存完整 40 位 |
| 同一叶子出现两个写者：旧 wave 自动重启 W3，父级又手动启动了一个 | 启动不幂等，也没有节点级的“在跑”状态 | 节点状态机加 dsa 幂等启动键 |
| 父级先拿了 dev 锁，再调用自己也会拿锁的 parent-merge.sh，死锁 | 锁语义藏在脚本里 | 锁由 pi-dag 统一持有，对外只暴露 `merge` 操作 |
| 裁决（例如 K15、I4 口径、BOUND 语义）忘了注入后续叶子 | 手工复制 | 裁决按作用域登记，生成任务说明时自动注入 |
| “这个计划里没有 X”，实际上计划里有 | 父级凭记忆回答 | `dag query` 直接查计划 |
| 合并的树和验收的树不同，却复用了旧证据 | 没核对树是否相同 | 证据只能按树哈希复用 |
| done.txt 某行缺 SHA，计划校验失败 | 手写文本 | 状态以结构化方式记录，只追加 |
| 写者超时，又从头开了一个写者 | 没有 attempt 的谱系 | attempt 链：同一节点的续跑和重派都可追溯 |
| 叶子交付后没有经过独立评审就被合入 | 流程靠记忆 | 合并门禁要求按风险档配齐评审回执 |

量级参考：J1 合入约 90 个叶子，父级手写或改过的记账类脚本和文件超过 20 个，发生过以上类别的错误 10 次以上。这是父级自己的估计，没有精确计数。

---

## 2. 目标与非目标

### 目标
1. **项目任务图是唯一的真相**：有哪些节点、依赖、写集、验收标准，以及每个节点处在什么状态、依据是什么。
2. **独立验收**：只有 pi-dag 自己核对过的回执，才能让节点变成“已验收”。子代理的报告只算线索，不算证据。
3. **合并门禁**：单写者、树一致性、受保护路径必须有签字、按风险档要求评审，都由工具执行。
4. **裁决和修订可追溯**：父级的每个决定都有作用域、理由、来源消息和替代关系，派活时自动带上。
5. **跨会话和跨机器**：状态放在项目目录里，可以进 git；会话压缩、换机器、清掉 dsa 记录，状态都不丢。
6. **通用**：适用于任何“多 agent 改同一个仓库、需要验收”的项目，项目差异通过配置和插件表达。

### 非目标
- **不调度**：不管槽位、模型、重试、会话恢复、进程监管，这些全归 dsa。
- **没有常驻进程**：所有操作都由事件触发，改了规则下次调用就生效。
- **不替项目定义“正确”**：验收命令、受保护路径、代码量规则都由项目提供，pi-dag 只负责执行和记录。
- **不自动合并到主干或发布**：合并目标是项目配置的集成分支，push 和 publish 仍由人授权。
- **不做 wais 那一整套签名和 pin 体系**：那是为极高严谨度定制的，在通用版里作为可选插件。

---

## 3. 核心概念

```
Project ── 有一份 Plan（节点图）和一份 Journal（事件，只追加）
  Node      一个可以独立验收的工作单元（叶子），或者一个汇总节点
  Attempt   节点的一次执行尝试 ↔ 对应一个 dsa call（含 follow-up 的后续代）
  Receipt   一次验收运行的结构化证据（由 pi-dag 自己产生或核对）
  Review    一次评审的结论（OK / BLOCK + 问题列表），绑定到某棵树
  Ruling    父级的裁决（作用域、正文、理由、来源、替代关系）
  Amendment 对已验收产物的修订（跨 owner 改动、冻结测试修订）
  Integration 一次合并到集成分支的记录（PRE、合并提交、合并后验收）
```

### 3.1 Node

```yaml
id: J1-FIRST-CHUNK
kind: leaf            # leaf | aggregate | external（等外部系统，比如仿真任务）
deps: [J1-COLD-PLAY]
risk: R2              # R0..R3，由项目定义各档要求
write_set:            # 允许修改的路径，支持精确路径和目录前缀
  - crates/wais-exec/src/journey_derive.rs
  - crates/wais-exec/src/journey_derive_drive.rs
protected: []         # 本节点额外的受保护路径（项目级的受保护路径另行配置）
acceptance:
  command: "node --test tests/architecture/v27/j1-cold-play.test.mjs"
  env: { WAIS_J1_COLD: "1" }
  timeout_s: 1800
  resources: [machine-exclusive]   # 透传给 dsa 的资源租约
  red_first: true                  # 要求先证明红：在基线上失败
  reuse: tree                      # 证据复用规则：tree（同一棵树）| never
budget: { prod_lines: 150, test_lines: 300 }   # 可选，交给项目插件检查
reviews: { required: 1, model_pool: opus }
estimate_h: 4
owner_note: "非 plan 叶，由父级创建"
```

节点定义可以随时增加或修改。每次修改都会记成 Journal 里的一个 `plan.revised` 事件，带上 diff 和理由。已验收节点的定义被修改时，会自动生成一个 Amendment 待办。

### 3.2 节点状态机

```
blocked ──deps 全部 accepted──▶ ready ──dispatch──▶ running
running ──dsa: sealed ok──▶ delivered ──verify──▶ verified ──review OK──▶ accepted ──merge──▶ integrated
                                         └─fail──▶ rejected ──redispatch / follow-up──▶ running
running ──dsa: asking──▶ asking（父级答复后回到 running）
running ──dsa: timeout / failed──▶ stalled（父级决定：follow-up 续跑、重派或 park）
任意状态 ──park(原因)──▶ parked（外部缺陷、等待用户、等待宿主前置变更）
integrated ──amend──▶ integrated（附 Amendment，旧证据作废的部分需要重验）
```

规则：
- `ready` 只由 deps 的状态推出，不能手工标记。
- `accepted` 只能由 `verify` 加上满足风险档要求的 `review` 推出。父级可以 `override`，但必须写理由，并在看板上一直标红。
- “合并后再评审”（wais 实际用过）也允许，但节点会停在 `integrated(review-pending)`，评审结论为 BLOCK 时自动生成修订节点。
- 同一节点同一时刻只能有一个 `running` 的 Attempt，这条由幂等启动键保证。

### 3.3 Receipt

```json
{
  "node": "J1-FAULT-POWER",
  "attempt": "a3",
  "kind": "acceptance",
  "repo": "/abs/worktree",
  "head": "9323bc41e6e83ebd296fe8a65e829fc07d7ddeee",
  "tree": "<git tree sha>",
  "clean": true,
  "base": "b58f9ae048963f3a5509919c826d671937b260d1",
  "command": "...", "env_digest": "sha256:...", "cwd": "...",
  "started": "2026-10-08T10:49:31+08:00", "wall_s": 198,
  "exit": 0,
  "log": { "path": "...", "sha256": "...", "bytes": 81234 },
  "parsed": { "pass": 7, "fail": 0, "tap": true },
  "red": { "head": "...", "exit": 1, "fail": 7 },
  "resources": { "peak_rss_kb": 898884, "load1_at_start": 1.34 },
  "producer": "pi-dag@0.1.0"
}
```

验收规则（verifier）：
1. `producer` 是 pi-dag 自己。如果是子代理带回来的回执，pi-dag 必须在同一棵树上复跑，或者至少核对日志哈希和树哈希，复跑方式按项目策略决定。
2. `clean == true`，并且 `tree` 是当前要验收的那棵树。
3. `head` 和 `base` 都是完整 SHA，并且都能在仓库里解析。
4. 命令和环境的摘要与节点定义一致。改了验收命令，旧回执就作废。
5. `red_first` 为 true 时，必须有一个在基线树上失败的红回执。
6. 退出码和解析出的结果一致（例如 TAP 里 fail 为 0），不能只看退出码。
7. 写集检查：`git diff base..head` 的路径全部落在 `write_set` 内。越界部分必须有对应的 Ruling（授权跨 owner）或 Amendment，否则拒收。
8. 项目插件检查：代码量、受保护路径签字、机制登记等，见 §7。

证据复用：只有树哈希相同才能复用。“合并后的树和叶子 tip 的树相同”是最常见的情况，这时合并后无需重跑。

### 3.4 Ruling

```yaml
id: R-2026-10-08-07
scope: { nodes: [J1-FIRST-CHUNK], paths: [crates/wais-exec/src/journey_derive_drive.rs], global: false }
text: "BOUND=2 只计存活的 producer 进程；输出阶段另设上限 2"
rationale: "spec 约束的是命令的效果；进程退出后命令就不再 standing"
source: { kind: user|parent, ref: "m06233" }
supersedes: [R-2026-10-07-12]
carry_to_next_plan: true      # 下一版计划要并入的事项（相当于 plan14-pending）
```

- 生成派活包时，自动注入作用域命中的裁决：节点 id 命中，或者写集和 paths 有交集。`global: true` 的裁决注入所有包。
- 已被替代的裁决不再注入，但保留在历史里。
- 子代理通过 dsa 的 ask 提问后，父级的答复可以一键登记为 Ruling，回复原文就是正文。
- `carry_to_next_plan` 的条目汇总成“下一版计划待办”视图，代替手写的 plan14-pending.md。

### 3.5 Amendment

修订已验收的产物，包括冻结测试的 fixture 修订、跨 owner 改动和计划修订：
- 记录提交、涉及的节点、理由和授权的 Ruling；
- 对受影响节点标记“证据部分失效”，按树重新验收；
- 代替 `ledger-amendments.json`。

### 3.6 Integration

```
merge(node):
  1. 拿集成分支的写者锁（pi-dag 自己持有，对外只暴露这个操作）
  2. 检查集成 worktree 是否干净；不干净时，把未跟踪文件移到 quarantine 目录，不删除，然后报告
  3. git merge --no-ff，记录 PRE 和 M
  4. 如果 tree(M) == 已验收回执的 tree，直接复用证据；否则在 M 上重新验收
  5. 项目插件的合并后检查（例如机制登记、相关回归）
  6. 写 Integration 事件；失败时，按策略回退（reset 到 PRE）或保留现场并报告
  7. 清理：删除叶子 worktree 和已合入的分支（可配置）
```

---

## 4. 存储

```
<project>/.pi-dag/
  config.yaml          项目配置：集成分支、受保护路径、风险档、插件
  plan/                节点定义（每个节点一个文件，或一个大文件，可配置）
  journal.jsonl        只追加的事件：plan.revised、attempt.*、receipt、review、ruling、amendment、integration
  receipts/<sha>.json  回执正文（journal 里只放引用）
  views/               派生视图（看板、交接摘要），随时可以从 journal 重建
```

- journal 是唯一的真相，看板、done 列表、就绪集都是从它派生出来的。
- 默认进 git，跟着集成分支走。大日志不进 git，只存哈希和路径，放在项目配置的证据目录里。
- 写 journal 时加文件锁（flock），每条事件带一个单调递增的 seq。多个 pi 会话同时写也安全。
- 交接摘要（相当于 `tasks/*-handoff.md`）由 `dag handoff` 从 journal 生成，不再手写追加。

---

## 5. 和 dsa 的接口

pi-dag 只把 dsa 当作执行器来用，通过窄接口交互：

| 方向 | 动作 | 说明 |
|---|---|---|
| dag → dsa | `run`（带幂等键 `dag:<project>:<node>:<attempt>`） | 重复提交时返回同一个 wid，不会开出第二个写者 |
| dag → dsa | `send follow-up / answer / steer / model` | 续跑、答复、纠偏，都带上节点的上下文 |
| dag → dsa | `stop` | 节点被 park 或作废时停掉对应的 call |
| dsa → dag | 按 seq 读事件游标 | sealed（ok/timeout/failed）、asking、usage，pi-dag 记下读到的位置，崩溃后从那里重放，处理是幂等的 |
| dsa → dag | 结构化交付 | 用 call 的 `schema` 要求子代理调用 `report`，至少包含 commit、自测回执路径和未完成项 |

映射关系：
- 一个 Attempt 对应一个 dsa call（wid/key），follow-up 产生的后续代仍属于同一个 Attempt，并记下代号。
- dsa 的 sealed ok 只会把节点推进到 `delivered`，不会推进到 `accepted`。
- dsa 的 asking 把节点推进到 `asking`，问题原文进看板，父级答复后可以一键登记为 Ruling。
- dsa 的 timeout 把节点推进到 `stalled`，并附上最后一次提交、worktree 是否干净、遗留进程和挂载的检查结果。

---

## 6. pi 层（为什么是 pi 包）

价值主要来自“在 agent 行动的那一刻拦住它”：

1. **工具**（模型通过它们操作项目）：
   - `dag_status`、`dag_ready`、`dag_query(node|path|text)`
   - `dag_dispatch(node, {model?, extra?})`：生成派活包（含裁决、前置证据和验收要求），然后调用 dsa
   - `dag_verify(node)`：在叶子 tip 上执行验收，产生回执
   - `dag_review(node)`：派评审，评审包含 diff、契约和发现
   - `dag_merge(node)`
   - `dag_rule(text, scope, rationale, source)`、`dag_amend(...)`、`dag_park(node, reason)`
   - `dag_revise_plan(diff, rationale)`
2. **注入**：派活包模板由项目配置，自动带上裁决、写集、预算、风险档要求和资源要求。
3. **提示约束**：在系统提示里加一条：节点状态只能来自 `dag_*` 工具的结果；对用户说“已验收”时必须引用回执 id。可选再加一个轻量的回复检查，父级说“通过”却没有引用回执时给出提醒。
4. **TUI 看板**：节点按状态分栏，标出卡住的、等裁决的、证据失效的；显示关键路径和剩余估时。
5. **交接**：会话压缩或换会话时，`dag handoff` 生成当前状态摘要，替代手写的交接日志。

没有 pi 也能用：同样的能力以 `pi-dag` CLI 的形式提供，人和脚本都能调用。

---

## 7. 通用性：项目插件

pi-dag 核心只认识节点、回执、裁决和合并。项目特有的规则写成插件，插件是一个导出函数的 JS 模块：

```ts
interface Check {
  id: string;
  when: 'verify' | 'merge' | 'post-merge';
  applies(node: Node): boolean;
  run(ctx: { repo, base, head, tree, node, receipts }): Promise<{ ok: boolean, details: object }>;
}
```

wais 会用到的插件，可以作为示例放进仓库：
- `code-size`：按 countSource 统计生产代码和测试的 diff 行数；
- `protected-paths`：受保护路径必须有签字的 Ruling，并且由父级合并；
- `mechanism-registry`：对应 AC3 门禁；
- `pins`：对应计划和检查器的签名 pin，可选；
- `red-first-tap`：解析 TAP，并比较红回执和绿回执的用例集合。

风险档也在配置里定义：

```yaml
risk:
  R0: { reviews: 0, writer_pool: cheap }
  R1: { reviews: 1, writer_pool: b-tier, reviewer_pool: opus }
  R2: { reviews: 1, writer_pool: a-writer, reviewer_pool: opus, review_before_merge: true }
  R3: { reviews: 2, parent_only: true }
escalate_after_failures: 2     # 同一节点验收失败两次后升一档（wais 规则）
```

---

## 8. 最小可行版本（MVP）

第一版只做最痛的部分：
1. 节点定义、状态机、journal（含 flock 和 seq）；
2. `dispatch`：派活包模板加裁决注入，通过幂等键调用 dsa；
3. `verify`：pi-dag 自己执行验收，核对 clean、tree、完整 SHA、写集；
4. `merge`：锁、按树复用证据、quarantine、清理；
5. `rule` / `park` / `handoff`；
6. 消费 dsa 事件游标，自动推进 `delivered`、`asking`、`stalled`；
7. CLI 和 pi 工具各一套；TUI 先做文本版的状态输出。

第二版：review 编排、Amendment 失效传播、插件 API、TUI 看板、关键路径和估时、导入计划。

验收第一版的方式：把 wais J1 剩下的叶子（FIRST-CHUNK、FAULT 汇总、BENCH、close）迁过去，用 pi-dag 跑完。对比父级的手工操作次数和出错次数。

---

## 9. 需要 dsa 提供的能力

按优先级排列。“现状”一栏依据 dsa 1.0.16 的 README 和 CHANGELOG。

| # | 能力 | 为什么需要 | 现状 | 建议的接口 |
|---|---|---|---|---|
| D1 | **幂等启动键** | 防止同一节点出现两个写者。wais 出过这个事故：旧 wave 自动重启 W3，父级又手动启动了一个 | 有 rid，但它是 dsa 自己生成的，调用方不能指定用于去重的键 | `run({..., key: "dag:proj:node:a3"})`：同一个键在任意状态下重复提交，都返回原来的 wid 和状态，不新建 |
| D2 | **按 seq 的事件游标** | pi-dag 不常驻，要能事后补读事件；崩溃后也能幂等重放 | `events <wid>` 是按 workflow 读的 | `events --since <seq> --json`：跨 workflow 的全局游标，事件类型稳定（call.sealed{status}、call.asking{qid,text}、call.model、workflow.done），带 schema 版本号 |
| D3 | **结构化交付成为一等公民** | 不再从 `LEAF:` 这样的文本行里解析结果 | 已有 `schema` 和 `report` | 保持即可。希望 `status --json` 和事件里能直接拿到 `data` 字段，follow-up 的后续代也同样有 |
| D4 | **worktree 写者锁（强制）** | 一个 worktree 只能有一个写者。现在只是提醒，而且看不到通过 bash 的写入 | 1.0.14 起有 sharedWorktree 提醒，不阻止 | `run({..., writes: "<worktree path>"})` 声明独占。第二个声明同一路径的 call 进入排队或被拒绝（可配置）。锁在 call 结束或被 stop 时释放。按声明加锁，不依赖观察写入 |
| D5 | **资源租约** | 机器独占的测量（BENCH、冷测）、断电矩阵（11–14 GB 内存，lazyfs）、浏览器。现在靠 quiet-wait2.sh 轮询硬等，还会和其他 agent 撞车 | 有内存预留，没有具名资源 | 具名资源加容量：`resources: {"machine-exclusive": 1, "lazyfs": 1, "browser": 1}`。一个 call 可以在运行中途申请和释放，例如通过 `lease(name)` 工具，或者从 bash 调用 `dsa lease acquire/release`，因为写者通常只在跑矩阵时需要独占。要能看到谁在持有租约 |
| D6 | **进程外清理孤儿资源** | 进程被杀后，lazyfs 挂载和 lease 的 setTimeout 都随之消失，留下了孤儿挂载（实测 8 个，7.3 GB） | 1.0.13 起会告诉子代理“你的进程已停”，但不清理外部资源 | 让 call 能登记清理动作，例如 `cleanup: ["fusermount -u <mnt>"]`，或者由租约绑定一个清理命令。call 结束、被 stop 或崩溃后，由 orchestrator 执行 |
| D7 | **Attempt 谱系可查** | 一个节点可能有多次 follow-up 和多次重派，pi-dag 要知道它们是不是同一条链 | 有 `key@gen`，但跨 workflow 的关联要靠调用方自己记 | 有 D1 的键之后，`status --key <key>` 返回所有代和每一代的终态 |
| D8 | **call 的 cwd/worktree 元数据** | 生成 `stalled` 报告时，要知道去检查哪个 worktree | status 里没有直接给出 | `status --json` 的每个 call 带上 `cwd` 和声明的 `writes` |
| D9 | **在 sealed 事件里附上终态快照** | 超时时，节点需要“最后一次提交、worktree 是否干净”这类信息 | 无 | 可选：call 可以登记一个终态探针命令，例如 `git -C <wt> log -1; git status --porcelain`，orchestrator 在封存时执行，把结果放进事件 |
| D10 | **不中断地升级 orchestrator** | 规则改动放在 pi-dag，但 dsa 自己的升级仍然需要切换。wais 这次拖了一整天没法切换 | `drain` 要等所有 call 结束 | 正在提问或休眠的 call 不阻止切换；对正在跑的 call，接管进程或等它到下一个安全点再交接 |
| D11 | **池名在所有地方都可用** | 父级手动切模型后，call 能留在池里继续自动切换 | 1.0.16 已经支持 | 已满足 |
| D12 | **工具命令进入卡住告警** | 区分“命令本身跑得久”和“真卡住了” | 1.0.13 已经支持 | 已满足 |

最小依赖：MVP 只硬依赖 D1、D2、D3。D4 和 D5 没有时，pi-dag 可以先自己在本地实现（文件锁加租约文件），等 dsa 提供后再迁过去。其余都是增强。

---

## 10. 风险与开放问题

1. **两份状态的一致性**：dsa 说已封存，pi-dag 还没读到。靠游标重放和幂等处理来解决；看板上标出“dsa 有新事件未消费”。
2. **验收的成本**：pi-dag 自己复跑验收，会和写者的自测重复，比如断电矩阵一次要 8 分钟、11 GB 内存。可以选的策略：
   - 写者自测的回执在同一棵树、clean、日志哈希一致时直接采信；
   - 抽样复跑；
   - 高风险档强制复跑。
   默认用第一种。wais 实际上就是这么做的，靠 tree==tip 来复用证据。
3. **计划规模**：wais 的计划 JSON 有 17 万行，导致上下文和工具都很慢。pi-dag 默认一个节点一个文件，只在需要时加载，视图按需派生。
4. **自动化的边界**：哪些动作允许 agent 不经确认就做，比如合并到集成分支、改计划、override。默认只有 `merge` 不需要确认，其余要么经父级（人或主 agent）确认，要么至少写理由。
5. **多机**：journal 进 git 以后，两台机器同时推进会产生冲突。第一版只支持单机加 git 同步，两台机器各自负责不同的节点。
6. **和 dsa workflow 脚本的关系**：pi-dag 每次派一个节点，或者一批独立节点，不生成长的 workflow 脚本。代价是父级的唤醒次数会多一些，好处是改计划和改规则时不用 revise 脚本。

---

## 11. 迁移 wais 的映射（参考）

| wais 现有物件 | pi-dag 对应 |
|---|---|
| `nodes.json` 的 nodes / later_nodes | `plan/`（导入脚本做一次性转换） |
| `done.txt` | journal 里的 integration 事件，由视图派生 |
| `ledger-amendments.json` | Amendment |
| `p13-rulings-inject.json`、交接日志中的裁决 | Ruling |
| `plan14-pending.md` | 带 `carry_to_next_plan` 的 Ruling 视图 |
| `gen-exec.py`、`exec-template.js` | `dispatch` 加派活包模板 |
| `parent-merge.sh`、`dev.lock.d` | `merge` |
| `check.mjs`、`receipt.mjs`、`pins.env` | 项目插件（`red-first-tap`、`pins`），pi-dag 负责调用 |
| `quiet-wait2.sh` | dsa 资源租约（D5） |
| `tasks/*-handoff.md` | `dag handoff` |

---

## 12. 复盘：如果 J1 一开始就有 pi-dag，收益有多少

数据来源：dev 分支、`tmp/exec/`、交接日志（截至 2026-10-08）。凡标“估”的是父级的自我估计，没有精确计时。

### 12.1 规模
- J1 期间（10-01 至 10-08，约 8 天）：done.txt 185 行（含 S−1/S0），dev 上 10-06 以来的合并提交 99 个；
- ledger-amendments 101 条，交接日志 235 行（其中“裁决”51 处），plan14-pending 68 行，裁决注入文件 10 条；
- 手写任务说明 15 份、workflow 脚本 103 个、记账文件备份 41 个。

### 12.2 可量化的收益

| 类别 | 现状 | 有 pi-dag | 节省（估） |
|---|---|---|---|
| 每次父级合并的操作 | 约 10–15 次工具调用、10–20 分钟（以 J1-FAULT-RECOVERY 合并为样本：12 次调用） | 1 次 `dag merge` + 处理例外 | 每次省约 70%；J1 约 60–90 次集成 → **约 10–20 小时父级时间** |
| 记账类出错 | 这周约 10 次（双写者、dirty 验收、短 SHA、自锁死锁、target 未清、done 缺 SHA、漏注入裁决、“计划里没有 X” 误报…） | 结构上拦掉 8–9 次 | 每次平均 0.5–1.5 小时返工 → **约 5–12 小时墙钟**，外加双写者那类事故的 Opus 额度（数百万 token） |
| 父级上下文 | 估计 30–40% 的父级 token 花在读写账本、拼命令、核对状态；压缩块里大半是“合并了什么、记在哪” | 状态在 journal 里，查询代替记忆 | **父级 token 约 −25~35%**，压缩次数相应减少 |
| 裁决传播 | 手抄，漏过至少 2 次（例：KA 的 epoch 引用、COLD-PLAY 的 K15 未覆盖） | 按作用域自动注入 | 每次漏抄通常换来 1 轮 BLOCK（1–3 小时）→ **约 2–6 小时** |
| 证据复用 | 每次凭记忆判断“树没变可以沿用” | 按树哈希自动判断 | 少量时间；主要收益是不会**错误地**复用 |

合计（估）：J1 约 8 天里，**墙钟省 1–1.5 天（约 12–18%），父级 token 省三成左右，记账类事故从约 10 次降到 1–2 次。**

### 12.3 拿不到的收益（占 J1 耗时的大头）
- **设计与契约返工**：rev7 重写、plan13 拆分、K15 崩溃点规则、22 次 BLOCK 里的真实缺陷——这些是该花的时间，工具不应省掉。
- **额度与模型故障**：s2a 503、ToS 拦截、超时续跑。属于 dsa 的范畴（1.0.16 已改善）。
- **机器独占的串行**：断电矩阵 8 分钟 / 11–14 GB、冷测、BENCH 窗口只能轮流跑。D5 资源租约能省掉轮询硬等和撞车，但串行本身省不掉。

按父级估计，这三类占 J1 墙钟的 75–85%。所以 pi-dag 的收益上限是“把剩下 15–25% 的记账开销大部分消掉”，不会让 J1 快一倍。

### 12.4 后续阶段
- 计划里 J1 之后还有约 1000 计划小时、200 个以上叶子。记账开销随节点数线性增长，设计返工则主要集中在每个阶段开头，所以后续阶段记账占比更高，pi-dag 的相对收益应该**高于** J1（估 15–25% 墙钟）。
- 构建成本：MVP 估 2–4 天 agent 工作 + 把 wais 当前状态导入的 0.5–1 天。按上面的节省，下一个里程碑内回本。

### 12.5 怎么验证这些数字
上线后在下一个里程碑记录：每次集成的父级工具调用数、记账类事故数、父级 token 中记账占比、从 delivered 到 integrated 的时间。与 J1 的估计值对比；如果节省不到一半，说明瓶颈判断错了，应停止扩展功能。
