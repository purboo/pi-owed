# o-remeasure — RM1–RM2，base 1e8540a

当前状态：实现及 review #3534 修复均完成，指定 bench 检查全部通过。writer 仅提交，不执行 `owed submit`、attest 或 merge。

## 当前范围与行为

- `src/drive.ts`：最新 current-attempt `resume.remeasure` 允许在 repair 前归因重测早于该 resume 的 active current-key execution block；一次非 error attribution 消费该 block 的重测。保留 setup retry、环境退避、两次非环境 error halt、fail/repair 和 pass/flaky 路径。本次 review 修复未改此文件。
- `src/ops.ts`：回复依据当前 candidate key 的最新非 error observation，以及每个 block 自己的 key/state，决定是否输出 already-failed 行，不再依赖聚合 `item.mark`。当前 key 没有 active block 且最新非 error 为 fail 时，引用该 fail 的 seq。active 行仅描述当前 attempt 最新 remeasure resume 之前的 block。
- `resume` 回复使用实际 append 返回的 `entries`，通过 `reduceFrom(latest.state, entries, latest.lookup)` 得到 append 后的状态，保证 helper 看到真正写入 ledger 的 resume seq。append 内容不变。
- `docs/SPEC.md`：区分 decide/resume 的 check attribution 和直接 attest 的 invariant remeasurement。
- `test/remeasure0292.test.ts`：共 10 个测试；本次仅新增两个 review 回归，既有 8 个测试未改。

## Review #3534 与父任务裁定

复现：K1 #4 fail → #6 attribution pass 留下 flaky block；当前 K2 #8 fail → #10 attribution fail 已 cleared。聚合 item 显示 `⛔`，旧实现误报 nothing to remeasure。修复后按 K2 的最新非 error fail #10 输出 already-failed 行；随后普通 error 不遮蔽该 fail。

父任务核实并批准最小调用点修正：decide 原先用包含新 resume 的 final state，而 resume 原先传 append 前的 latest.state。只修正 resume 回复的这一处调用，并在 helper 内以当前 attempt 最新 resume seq 过滤 block；使用实际返回 entries，避免重新生成 seq。不得改变 append 内容、RM1、reducer、措辞、既有测试或 PR2 登记。本次完全遵循该裁定。

新增回归：

1. 混合 key：旧 key flaky 不得遮蔽当前 key 已归因失败的回复，并验证最新普通 error 不影响最新非 error fail 的 seq。
2. 第二次 resume：第一次 resume 之后的新 block 不属于旧 resume 的授权；第二次 `resume --remeasure` 的回复和 driver 必须使用新 resume，列出该 block。回复生成不追加任何 observation。

## 既有测试的累计修改及原因

以下均来自前一提交 `500c744`，本次 review 修复没有修改任何既有测试或其断言：

- `test/app027.test.ts`，active merge-check 的 WF5：RM2 要求回复明确 failure seq、before-repair measurement 和 accept-risk 命令。
- `test/app027.test.ts`，already-flaky 的 WF5/RM2：无失败 invariant、无 active/failing check 时按 RM2 输出 nothing to remeasure。
- `test/needs-structure.test.ts`，PR2 registry：仅登记 RM2 规定的两个精确 command literal SHA-256，分类 diagnostic example 并说明理由；扫描器及全部负向测试未改。本次措辞未变，所以登记未改。

## 源码预算

`git diff --stat 1e8540a -- src`

```text
 src/drive.ts | 15 +++++++++++----
 src/ops.ts   | 26 +++++++++++++++-----------
 2 files changed, 26 insertions(+), 15 deletions(-)
```

净增 11 行，低于每叶 +60。无新增 entry kind、API、helper、export、CLI flag 或 need selector。review 修复相对 `500c744` 的源码变化仅在 `src/ops.ts`（8 行新增、7 行删除）。

## 当前 bench 验证证据

所有 Node/typecheck/test 均通过 `/tmp/owed-bench/run.sh`，未在 host 执行。最终 durable：`01M5A0J4WDSJ4YTC8V2QXNGBCY`。

- review 红测基线：detached `/tmp/owed-rm0292-reviewfix-red-1`，HEAD `500c744694c602d6a033c9fb308b0fc7b7c3b4fe`，仅复制新增测试文件；tree `d7cd12331d6d8f984010615b22f9998828c713d6`。
- 红测命令：`node --test --test-reporter=tap --test-name-pattern="RM2 review:" test/remeasure0292.test.ts`。exit 1，两个新增回归均失败（0 pass / 2 fail），分别是混合 key 错误回复和旧 resume 错误授权新 block。日志 `/tmp/owed-bench/logs/owed-rm0292-reviewfix-red-1-200043.log`。
- 当前测试树：`905dff7d57e076618dcade082ec3d4d0e18ece49`；src 子树 `1f6f499adbc8d3280b3b5bd575d32bed135bbc58`。
- `npm run typecheck`：exit 0。日志 `/tmp/owed-bench/logs/o-remeasure-1-200047.log`。
- 节点检查命令：`node --test --test-reporter=tap test/remeasure0292.test.ts test/remeasure.test.ts test/app027.test.ts test/infra.test.ts test/drive.test.ts test/reducer.test.ts test/decide.test.ts test/resume.test.ts`。exit 0，129 pass / 0 fail。日志 `/tmp/owed-bench/logs/o-remeasure-1-200113.log`。
- `node --test --test-reporter=tap test/needs-structure.test.ts`：exit 0，5 pass / 0 fail，包含全部负向检查。日志 `/tmp/owed-bench/logs/o-remeasure-1-200140.log`。
- 首次 review 验证有一个新增夹具错误：对已 cleared block 追加 attribution error，违反 ledger 校验。将其改为普通 error 后重跑上述指定链。生产修复未因此变更。旧日志 `/tmp/owed-bench/logs/o-remeasure-1-195944.log`（128 pass / 1 fail）已被当前证据替代。
- 最终检查后仅更新此 notes；源码及测试与所测 tree 相同。

## 前一里程碑证据及当前限制

- 原始 `1e8540a` 加前 8 个回归测试：7 fail / 1 pass，日志 `/tmp/owed-bench/logs/owed-rm0292-red-1-192359.log`。
- 前一提交的全套：1913 pass / 1 fail，唯一失败为新增 RM2 字面量未登记的 PR2。日志 `/tmp/owed-bench/logs/o-remeasure-1-192456.log`。当时 src 子树 `0984ddce830294c1ea214789556aebbdf11bfb6d`。
- 之前父任务批准复用同一 src 子树的全套其余结果；登记后 typecheck 与 focused 28/28 通过，日志 `/tmp/owed-bench/logs/o-remeasure-1-194924.log`。
- 本次 review 修复改变 src 子树，未将旧全套声称为当前树全绿。父任务明确裁定本轮无需重跑全套，验收范围为新红测、typecheck、节点检查集及 needs-structure，均已完成。
- 无运行中的 check 或外部 job；未执行 submit、attest、merge 或发布。
