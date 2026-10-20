# p-receipt — 0.31.1 PR1–PR4

基线：`590bdca9940e8e20fe1419f7d167219a2af5cfa7`。分支：`owed/p-receipt/1`。
范围：`src/checktry.ts`，`ops.ts` 的 checkTry/why，CLI check 参数，extension check-try schema，receipt 展示，SPEC 和测试。没有修改 reducer、key、gate、投票或 driver。

## 交付行为

- 三种目标互斥，共享校验和 `measureTry` / 普通 `runJob`。ad-hoc spec 不含 `reads` 或 `red`，默认 `min_tests: 1`、超时 900 秒，继承磁盘 plan 的 setup/env/wrapper/lease。
- 结果包含精确提交及其 tree；零测试、未知计数、超时和脏工作树请求不产生假绿。
- `--record` / tool `record` 在测量与机器租约结束后、ledger append 锁内，按侧追加 canonical `try/v1` executor note。保留实际磁盘 plan、commit/tree、target、counts 和 log blob SHA；fail/error 同样记录。
- 节点检查隐式关联节点；invariant/ad-hoc 可用 `--for` 关联磁盘 plan 中的节点。`--for` 必须配合 `--record`。无关联的收据不出现在节点 why 中。
- `why` 从普通 note 读取收据，倒序，默认五条，`--full` 全部；多行命令保持一行展示。收据不改变验收状态，损坏的收据信息不影响重放或展示。

## 既有测试改动及理由

- `test/checktry.test.ts`：CT red 的 plain-output 断言增加 `tree <tree12>`，对应 PR2 新增的输出；保留 verdict、counts、log 断言。
- `test/needs-structure.test.ts`：只更新 CLI HELP 的精确 literal SHA 和说明，登记 PR1–PR2 新增的 `--run` / `--record` / `--for` 语法；审计匹配规则和所有负例未变。新 helper 位于既有 renderWhy 注释之前，保留注释原有分类归属。
- 所有新增行为测试均在 `test/receipt0311.test.ts`，覆盖 CLI/tool、计数/超时、逐侧 canonical note、磁盘 plan SHA、commit/tree/log、why 截断与重载、reducer 保持、追加失败及测量期间不持 ledger 锁。

## 源码预算

`git diff --stat 590bdca -- src`：

```text
 src/checktry.ts  | 43 ++++++++++++++++++++++++++++++++++++-------
 src/cli.ts       | 18 ++++++++++--------
 src/extension.ts |  2 +-
 src/ops.ts       | 29 +++++++++++++++++++++++------
 src/views.ts     | 14 ++++++++++++--
 5 files changed, 82 insertions(+), 24 deletions(-)
```

净增 58 行，低于 PR 的 +180 限额；改动局部，helper 独立命名。

## 验证证据

所有 Node/TypeScript 命令仅通过 `/tmp/owed-bench/run.sh` 在 bench 执行。最终源码、测试和 SPEC 的受测树为 `fc5fc11b2ee1bff08e21fa6cd3d1afe847fa24c9`；验证后仅更新本说明文档。

| 检查 | 精确命令 | 结果 | 日志 |
| --- | --- | --- | --- |
| 基线 red | `node --test --test-reporter=tap test/receipt0311.test.ts` | exit 1，0/7；全部为合同功能缺失 | `/tmp/owed-bench/logs/owed-pr-receipt-red-590bdca-012904.log` |
| 源码审计 | `node --test --test-reporter=tap test/needs-structure.test.ts` | exit 0，5/5 | `/tmp/owed-bench/logs/p-receipt-1-015656.log` |
| 类型检查 | `npm run typecheck` | exit 0 | `/tmp/owed-bench/logs/p-receipt-1-015700.log` |
| 节点检查 | `node --test --test-reporter=tap test/receipt0311.test.ts test/checktry.test.ts test/coretools.test.ts test/cli.test.ts` | exit 0，35/35 | `/tmp/owed-bench/logs/p-receipt-1-015722.log` |
| 新测试单独运行 | `node --test --test-reporter=tap test/receipt0311.test.ts` | exit 0，7/7；此后仅源码注释位置及审计登记变化，最终节点/全套再次覆盖 | `/tmp/owed-bench/logs/p-receipt-1-013001.log` |
| 完整套件 | `node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'` | exit 0，2103/2103，1443.87 秒；timeout 2400，未超时 | `/tmp/owed-bench/logs/p-receipt-1-015753.log` |

基线 red：detached worktree `/tmp/owed-pr-receipt-red-590bdca`，只复制最终新增测试，tree `7848793af8f6633452081c68e5f28853c7ce9bf0`。日志显示缺少 `--run`、`--record`、目标语法提示、tool schema 和 note 记录；fixture 初始化成功。

最终完整套件日志 SHA256：`af4fa492ae9ef2f16d0470e777fa14e5c691832855acf16ad493b33e7b19a966`。

修复过程中的失败未隐藏：首次 typecheck 的类型适配问题见 `p-receipt-1-012531.log`；新增 replay 测试改用 ledger 中原始 law blob（而非附带 writes-syntax tag 的当前 plan），见 `p-receipt-1-012705.log`。首轮全套为 2102/2103，唯一失败是上述 HELP digest/注释归属，见 `/tmp/owed-bench/logs/p-receipt-1-013013.log`；修正后最终全套全绿。

未满足项：无。运行/发布状态：无服务或外部任务遗留；未 submit、合并或发布；本叶完成 git commit，`owed submit` 及验收由父任务负责。
