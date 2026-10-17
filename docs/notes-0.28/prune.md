# Prune：移除重复的补救命令构造

本次仅清理已被统一 need 接口替代的旧选择器，并转接仍在使用的命令构造。状态、why、brief、报告、driver 通知、唤醒和错误文本保持不变；不新增命令、标志或计划键，也不改变接受门槛、候选键、历史账本重放和 driver 动作选择。

现有调用入口继续导出迁移后的函数。旧的整节点命令合集不再保留；调用者应读取逐项 need 的主命令、同项替代命令或 itemLine。旧日志仍使用兼容解析，新日志继续使用结构化 need 身份。

## Known limits

为避免引入新的运行时循环依赖，部分补救文本仍在 reducer.ts 中；依赖其他模块共享 helper 的结果提示也保留原位置。这些例外逐字登记，不构成整个文件或函数的豁免。未完成批次的锁内恢复与测试观察钩子保持不变。

## Changed existing tests

- `test/halt-quiet.test.ts` 的 E3.2：依据 R-028-59(5)，删除只针对旧 ownerCommands 身份选择的断言，改用 need 主命令和 owner review 替代命令；brief 文本与确认环境不变的断言保留。
- `test/bind.test.ts` 的 G1.3：依据 R-028-59(5)，通过 needs 验证 approve/evidence 的完整候选固定命令；删除旧合集独有的 routine-review waiver 断言，保留 brief 与 reviewer packet 的候选绑定和块清除断言。
- `test/trackfix.test.ts` 的 TF2：依据 R-028-59(5)，将旧合集调用替换为 need 命令，仍验证相同的 tracked-by fix 文本；状态、why、repair、wake 和风险未清除的断言不变。
- `test/perf/differential.ts` 的 snapshot：依据 R-028-59(5)，删除已经移除的 ownerCommands 专用比较字段；其余状态、键、门槛、receipt、status、brief、review packet 和故障注入比较保留。

## 维护附录（R-028-60）

`wc -l src/*.ts` 合计：0.27.2 基线 `2a5f1a8` 为 **16282**；slot base `bd5529d1a725` 为 **16787**；本候选为 **16680**。相对 slot base 减少 **107** 行，相对 0.27.2 增加 **398** 行；未压缩代码凑数，发布净行数门槛由 parent 按 R-028-59(6) 裁决。

实际删除的符号：

| 文件 | 符号 |
| --- | --- |
| `src/views.ts` | `reviewNeed`、`repairingBlock`、`repairNeedsOwner`、`itemNext`、`clearHint`、`ownerCommands`、`decisionCommand`、`ownerAs`、`waiveCommand`、`dispatchHint`、`candidate12`、`candidateFlag`、`obligationFlag`、`resumeHint` |
| `src/ops.ts` | `applyStillAsking` |
| `src/remeasure-on.ts` | `matchesRemeasureOn` |

`resolveText`、旧 summary 选择和新日志的 plainNeed 路径在 slot base 已不存在，不重复计算删除。`completeBatchTail` 与 `batchTailProbe` 按 R-028-60 原样保留。

迁移而非删除：`writerDecisionCommand`、公开 `writerStopNeed`、`reviewDecision`、公开 `trunkDecision`、`evidenceCommand`、`resumeCommands`、`flakyRuleHint`、`lapsedKnownRedText`、`genesisLine`、`readyHintText`、`idleWaitText`、`driftNotice`、`trunkAfterBaseText`、`rejectedFixed`、`rejectedHalt`、`answerRetry` 及其私有 `shell`、`rebaseRecovery`、`setupHint`、`thresholdHint`。dispatch-overlap 命令与 sweep escape 命令抽到纯 builder，sweep 的私有 `quote` 随命令迁移为 `sweepQuote`。

两个 trunk 文本不同：公开 `trunkDecision` 保留原 views 文本；原 needs 私有函数仅改名为 `trunkRepairText`。同样，needs 的 writer-stop parser 仅改名为 `needsWriterStopNeed`，保留既有 quoting 语义。

运行时 imports：slot base 的 needs.ts 为 `plan.ts`、`clock.ts`、`reducer.ts`、`answer.ts`、`exec-wrap.ts`；候选为 `plan.ts`、`clock.ts`、`reducer.ts`、`exec-wrap.ts`。新增 views/git/drive-run/rebase-view 引用均为 `import type`，没有新增运行时循环依赖。

解释选择：按 R-028-64，`setupNotices` 使用的 `setupSignature` 仍有其他调用方，因此它与 `recentSetupFailures` 原样留在 drive.ts，登记 cycle-blocked remedy；`environmentText` 的 `clip` 也有其他调用方，原样保留。PR2 用完整原始字面量的 SHA-256 加文件、外层函数与出现次数精确登记，避免复制庞大的 help 文本；负例覆盖重复站点、已登记函数中的新字面量、双引号、嵌套模板与转义字面量。
