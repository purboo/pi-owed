**J1 支持“独立验收账本＋合并门禁”的方向，但没有验证 PRODUCT.md §3 的整条默认流程。**实际运行依赖长期复用的自建 worktree、写者自测、只读评审、父级裁决和合并后的验收。最需要修订的是：fresh checkout 与冷构建的关系、gate 的恢复语义、资源租约，以及跨轮次的 worktree 所有权。

本次只读检查了源码、日志、回执和 journal；未修改文件、运行构建或测试。下文“实证”来自这些材料；成本外推明确标为推断。

**1．实际流水线**

- **派活与基线——实证，高置信。**`gen-exec.py` 将计划节点和验收命令嵌入 workflow，检查外部依赖是否在 `done.txt`；`gen-stage.py` 按阶段删去节点及其下游、注入父级裁决，J1 并发设为 8。模板指导写者执行 `git worktree add -b leaf/<ID> … dev`，目录存在则复用，并链接主仓库的 `node_modules`。因此默认 base 是**实际创建时的 dev**，并非派活时冻结的完整 OID；后续轮次继续使用原目录，也可能按裁决 merge 新 dev。[生成器](/home/purboo/project/xwell/tmp/exec/gen-exec.py:23)、[阶段生成器](/home/purboo/project/xwell/tmp/exec/gen-stage.py:7)、[模板](/home/purboo/project/xwell/tmp/exec/exec-template.js:46)。

- **没有使用 dsa worktree isolation 或 gate——实证，高置信，限所查样本。**检查 rev7、BENCH/FAULT-RUNNER、FAULT-POWER/RESTORE 三个 journal，共 **94 条含 spec 的记录**：`isolation`、`gate` 均未配置，也没有 `wt-*` 或 gate 事件。验收回执里的 `principal:"gate"` 是 `check.mjs` 的默认字符串，**不代表经过 dsa gate**。[rev7 journal](/home/purboo/.pi/durable-subagents/w/01M48N4CQ4CY6WYWVSRBE4PMJ8/journal.jsonl:3)、[默认 principal](/home/purboo/project/xwell/dev/wais-worktree/dev/tools/arch/check.mjs:167)。

- **W/R 序列——实证，高置信。**每叶 W1→R1；失败则 W2→R2，同档修复；第三轮起升级，最多 W5。只有写者输出匹配 `accept=pass` 才派评审；评审匹配 `verdict=OK` 后才进入集成。W/R/I 默认时限分别为 **3 h／1.5 h／1 h**。受保护路径或 parent-review 叶在评审后 parked，但模板把它当 `ok:false`，下游随之 skipped，父级合入后重新生成下一阶段。[轮次与集成队列](/home/purboo/project/xwell/tmp/exec/exec-template.js:103)。

- **谁实际验收——存在重要落差。**模板要求评审在叶子 worktree 亲跑验收，但实际多个 `moa-opinion` 回报明确说只有 read/grep/find/ls，不能执行命令。例如 ACQUIRE、BACKUP、FAULT-RUNNER R3 都只核对写者证据。故不能把“独立评审 OK”算成“独立实跑”。独立执行主要由集成器或父级承担。[ACQUIRE 回报](/home/purboo/.pi/durable-subagents/w/01M48N4CQ4CY6WYWVSRBE4PMJ8/journal.jsonl:16266)、[FAULT-RUNNER R3](/home/purboo/.pi/durable-subagents/w/01M4A9V2PWTD5QC3PN9E763BND/journal.jsonl:46101)。

- **red/green——实证，高置信。**green 在现有叶子或 dev 工作区运行；`check.mjs` 的历史 red 则创建临时 shared clone、checkout 历史提交、链接 `node_modules`，跑完删除。red-first 通常寻找“首次包含最终测试字节”的提交，**不是统一在派活 base 上覆盖测试包**。实现叶继承其他 owner 的未变测试时可降为 `mode:test`，不重复 red；greenfield 允许 null implementation／guard mutation。[历史 runner](/home/purboo/project/xwell/dev/wais-worktree/dev/tools/arch/check.mjs:42)、[red 选择与继承](/home/purboo/project/xwell/dev/wais-worktree/dev/tools/arch/check.mjs:163)。

- **合并——实证，高置信。**workflow 内用 `integChain` 串行；跨 workflow 和父级用 `mkdir dev.lock.d` 互斥。`parent-merge.sh` 持锁检查 clean、保存 PRE、**先 merge 到 dev 再验收**；plain 模式签 PRE，signed 模式批准 merge commit，并可重签 checker/plan pin。验收失败 reset PRE；成功先归档 receipt，再清理 worktree/branch、追加 done。归档失败则保留已合并提交并报错。它没有 PRODUCT 所述的“候选先验证＋CAS 更新”，且锁覆盖整个长验收。[合并脚本](/home/purboo/project/xwell/tmp/exec/parent-merge.sh:9)。

- **证据复用——实证，高置信。**本次 `rev-parse` 确认 COLD-PLAY 的 merge `b58f9ae0` 与已测 tip `2d5984e2` tree 相同；FAULT-POWER-JUDGE 的 merge `4f2b8df3` 与 `45269b6e` 也相同。RECOVERY 更进一步，README 改动后按“受测 import 闭包未变”沿用 fin1/fin2。这是人工批准的复用，不是统一缓存协议。[交接记录](/home/purboo/project/xwell/tasks/2026-10-06-j1-restart-handoff.md:226)。

**2．成本与资源**

| 口径／样本 | 已观察结果 |
|---|---|
| `accepted/J1*.json`：23 叶、40 条 receipt | `finished_ns-started_ns`：最小 **0.137 s**，中位 **4.926 s**，P90 **85.387 s**，最大 **995.942 s** |
| 9 份 `J1-*/parent-integration.time` | 外层验收最小 **0.86 s**，中位 **24.42 s**，最大 **1046.99 s＝17分27秒** |
| 外层代表值 | KERNEL-CHECK **24.42 s**；RESTORE **101.06 s**；ASSEMBLY **112.51 s**；POWER **197.37 s**；RUNNER **1046.99 s** |
| 完整 parent-merge | POWER **197.95 s**，其中验收 **197.37 s**；RESTORE **101.89 s**，其中验收 **101.06 s** |
| 热 Cargo 调用 | 已缓存 dev build **0.05–0.07 s**；局部 test build **1.90 s** |
| 大量依赖重新编译的样本 | 独立 L1 worktree release build **83 s**；随后候选 release build **38.87 s** |
| 当前磁盘占用，`du -sh` | dev `app/target` **1.9G**；FIRST-CHUNK **2.1G**；BENCH **918M**；误产出的隔离 `target` **496M** |

来源：[accepted](/home/purboo/project/xwell/tmp/exec/accepted)、[RUNNER 外层计时](/home/purboo/project/xwell/tmp/evidence/J1-FAULT-RUNNER/parent-integration.time:5)、[POWER 合并计时](/home/purboo/project/xwell/tmp/evidence/J1-FAULT-POWER/parent/merge.log:16)、[RESTORE 合并计时](/home/purboo/project/xwell/tmp/evidence/J1-FAULT-RESTORE/parent-merge.log:16)、[依赖重编译](/home/purboo/project/xwell/tmp/evidence/J1-COLD-PLAY/logs/o/build-l1.log)、[热构建](/home/purboo/project/xwell/tmp/evidence/J1-COLD-PLAY/k15/runner.log:3)。

**计时限制：**receipt 的时钟在历史 red 完成后才启动，所以上述 40 条是候选侧执行区间，不能当完整 red＋green 成本；它们也仅覆盖已归档成功回执，不包含失败重试、评审、排队和全部 J1 叶。[计时位置](/home/purboo/project/xwell/dev/wais-worktree/dev/tools/arch/receipt.mjs:157)。两个合并样本中，验收之外开销仅约 **0.58／0.83 s**，但不能据此估计所有 merge 或锁等待时间。

**fresh checkout 可行，但“每次丢弃构建缓存”尚无成本依据。**Cargo 默认 target 位于工作区 `app/target`，所以新 checkout 通常没有原缓存。[配置](/home/purboo/project/xwell/dev/wais-worktree/dev/.cargo/config.toml:1)。按 83 秒样本外推，如果 base/candidate 都需同等完整构建，光编译约 **166 秒/attest**；这是情景估算，不能推广为所有叶的实测。许多 red 使用 null implementation，根本不需同等构建；FAULT 的 13–17 分钟矩阵则远大于编译成本。应将**新鲜源码、干净运行目录、可信构建缓存**分开定义。

资源比 checkout 本身更危险：journal 中写者报告 RUNNER 单次全机 used-memory 峰值 **14.25–14.7 GB**，LazyFS 约 **7.5 GB**；这不是 `/usr/bin/time` 的单进程 MaxRSS。[当次报告](/home/purboo/.pi/durable-subagents/w/01M4A9V2PWTD5QC3PN9E763BND/journal.jsonl:30333)。BENCH 申请过 **4–6 h 独占窗口**，只是估算，未发现已完成窗口的对应证据。实际曾有 load≈16 时 wire 4/8 失败，安静后两次 8/8；也曾清理 **8 个孤儿 LazyFS 挂载、约7.3 GB**。进程内 lease 无法覆盖 supervisor 被杀后的回收。[事故记录](/home/purboo/project/xwell/tasks/2026-10-06-j1-restart-handoff.md:215)。

**3．账本、失败与恢复揭示的假设**

`accepted/<leaf>.json` 是数组，每项含 **raw receipt、raw 的 SHA-256、source 路径**；`.lock` 配合 flock，写入用临时文件、fsync、replace，并按 hash 去重。raw 包含完整 base/candidate OID、plan/checker hash、principal/attempt、测试路径、selected/executed/red、退出码、时间和裁决。它**不是 ExecutionAttestation 全集**：没有统一 runner 环境、构建缓存、资源租约或完整日志摘要；也不是哈希链。[记录实现](/home/purboo/project/xwell/tmp/exec/ledger.py:80)。

`ledger.py build` 还会核验 merge 身份、测试 owner、用例集合和授权漂移，甚至检查 merge 自身引入的修改；这些已有实现值得保留，而不是只迁移 JSON 外形。[漂移检查](/home/purboo/project/xwell/tmp/exec/ledger.py:47)。

| PRODUCT 假设 | J1 检验 |
|---|---|
| sealed/写者完成不等于验收 | **成立且必要。**dsa `ok` 可携带 `accept=fail`；FAULT-POWER 因外部产品缺陷空转 W2–W5。 |
| 单 call 独立 worktree＋幂等 key 足以覆盖单写者 | **不足。**W2 超时后模板在约 **0.66 s** 内创建 W3；父级另开收尾会话造成重叠所有权，随后人工停掉。须跨 workflow、轮次和手工续跑认领同一叶。 |
| dsa 恢复可透明继续 | **J1 历史上不成立。**重启曾让四个 R1 丢任务；SELECT 产生无关评审。长变异命令被杀后留下变异源码、挂载和目录。 |
| 模型池自动恢复足够 | **历史版本不成立。**503 后只报十分钟 stall，多次人工切模型；安装新包不等于运行中的 orchestrator 已升级。 |
| 资源租约只是晚期优化 | **对 J1 不成立。**并行矩阵直接污染测试结果、占用十余 GB，并留下孤儿资源。 |
| clean 成功后立即删除 worktree | **不符合 J1 生命周期。**目录需跨 W/R、父级裁决、验收失败和后续补证保留，合入后才释放。 |

来源：[W2 timeout／W3 创建](/home/purboo/.pi/durable-subagents/w/01M4A9V2PWTD5QC3PN9E763BND/journal.jsonl:40682)、[任务丢失事故](/tmp/bug/dsa-restart-task-loss/README.md:1)、[503 stall](/home/purboo/.pi/durable-subagents/w/01M4A9V2PWTD5QC3PN9E763BND/journal.jsonl:48675)。这些不能直接证明当前 dsa 1.0.16 仍有同样缺陷。

**4．PRODUCT.md 的具体修订建议**

| 位置 | 建议修改及理由 |
|---|---|
| §3 fresh checkout | 改成“受信 runner 构造隔离源码快照，允许经策略约束的外置构建缓存”；记录工具链、依赖、缓存策略和实际产物 hash。J1 热/重编译差距显著。 |
| §2–3 red→green | 支持同 bundle red、继承已验证契约 red、greenfield null/mutation、无需 red 的叶类型；明确 base 与 red-origin 可以不同。否则会误拒真实实现叶。 |
| §3 gate 调用 | 使用 `{command, output:"json", timeoutMs:…}`。当前字符串 gate **不会自动解析 stdout 写入 `data.gate`**；必须显式 JSON 模式。[源码](/home/purboo/project/pi-things/pi-conductor/src/orchestrator/executor/effects/gate.ts:138) |
| §3–4 “可恢复” | 改为“可恢复裁决，执行不保证续跑”：未决 gate 恢复时 fence 后记 unknown，不重新执行；timeout/stopped/budget 会跳过 gate。需要按 execution key 对账已落盘回执，再决定是否新建验证 attempt。[恢复逻辑](/home/purboo/project/pi-things/pi-conductor/src/orchestrator/executor/effects/gate.ts:53) |
| §3–5 worktree | 引入 attempt/leaf 级持有与显式 release。拒收仍 exit 0 时，dsa call 可能保持 `ok`，当前 afterSeal 会清理干净 worktree；与拒收后 follow-up 冲突。[清理入口](/home/purboo/project/pi-things/pi-conductor/src/orchestrator/executor/effects/index.ts:29) |
| §4 单写者 | 所有权覆盖规范化 worktree/branch、generation 和手工续跑；新 writer 前确认旧进程及后台作业已退休。独立 call key 不能解决 J1 的跨波次双写。 |
| §5 优先级 | **S1 保持核心；S3 必须先于 J1 gate 落地；S4 的能力升为 J1 MVP 必备**，可由 pi-dag 本地实现但必须有进程外回收；**S5 提前做长验收试点**。S2 可先用只读 journal 适配做影子模式，稳定 API 再作为闭环要求。 |
| §3／§7 M3 | 保留“候选先验证＋短锁 CAS”，并增加明确的证据复用判据：同 tree、同测试/策略/环境；闭包复用需项目显式声明。J1 已靠人工做这件事。 |
| §7 M0–M2 | M0 加入真实快测、Rust 构建、LazyFS 长测三档；M1 分别显示 agent 状态、review 状态、execution 状态。增加 parked/external-defect、unknown、task-replay 和后台资源清理的验收条件，避免把它们归为普通拒收重试。 |

保留证据以实际 journal、执行日志、脚本和 Git tree 为主；交接文档用于解释事故和裁决。没有把模板要求当成执行事实，也没有把旧版本事故直接归因于当前版本。尚缺**受控的空缓存双 checkout 基准、完整 J1 验收全集和最终 BENCH 窗口实测**。下一步应先把这些差异写入 PRODUCT，再单独安排三类叶的成本与恢复实验；本次只读研究没有执行这些实验。