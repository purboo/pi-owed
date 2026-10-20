# p-receipt — 0.31.1 PR1–PR4

Base: `590bdca9940e8e20fe1419f7d167219a2af5cfa7`. Branch: `owed/p-receipt/1`.
Scope: `src/checktry.ts`, the checkTry/why hunks in `ops.ts`, CLI check arguments, the extension check-try schema, receipt rendering, SPEC and tests. No changes to the reducer, keys, gates, votes or driver.

## Delivered behavior

- The three target forms are mutually exclusive and share validation and `measureTry` / ordinary `runJob`. Ad-hoc specs omit `reads` and `red`, default to `min_tests: 1` and a 900-second timeout, and inherit the disk plan's setup/env/wrapper/lease settings.
- Results identify the exact commit and its tree. Zero tests, unknown counts, timeouts and dirty-worktree requests cannot produce a false green.
- `--record` / tool `record` appends a canonical `try/v1` executor note per side after measurement and machine lease release, under the ledger append lock. Notes retain the actual disk plan, commit/tree, target, counts and log blob SHA; fail/error verdicts are recorded too.
- Node checks associate receipts implicitly. Invariant/ad-hoc runs can use `--for` to associate a receipt with a node in the disk plan. `--for` requires `--record`. Unassociated receipts do not appear in a node's why output.
- `why` reads receipts from ordinary notes, newest first, five by default and all with `--full`. Multiline commands remain one display line. Receipts do not change acceptance state, and malformed receipt data does not affect replay or rendering.

## Changed existing tests

- `test/checktry.test.ts`: the CT red plain-output assertion gains `tree <tree12>`, matching the tree id added by PR2. Verdict, counts and log assertions are preserved.
- `test/needs-structure.test.ts`: update only the exact CLI HELP literal SHA and its explanation to re-register the `--run` / `--record` / `--for` grammar added by PR1–PR2. Audit matching rules and all negative fixtures are unchanged. The new helper sits before the existing renderWhy comment, preserving that comment's classified function.
- All new behavioral tests are in `test/receipt0311.test.ts`, covering CLI/tool parity, counts/timeouts, per-side canonical notes, disk plan SHA, commit/tree/log identity, why truncation and reload, unchanged reducer acceptance state, append failure, and measurement without holding the ledger lock.

## Source budget

`git diff --stat 590bdca -- src`:

```text
 src/checktry.ts  | 43 ++++++++++++++++++++++++++++++++++++-------
 src/cli.ts       | 18 ++++++++++--------
 src/extension.ts |  2 +-
 src/ops.ts       | 29 +++++++++++++++++++++++------
 src/views.ts     | 14 ++++++++++++--
 5 files changed, 82 insertions(+), 24 deletions(-)
```

Net +58 lines, below PR's +180 limit. Hunks are local and helpers are separately named.

## Validation evidence

All Node/TypeScript commands ran on the bench host through `/tmp/owed-bench/run.sh`. The tested tree for the final source, tests and SPEC is `fc5fc11b2ee1bff08e21fa6cd3d1afe847fa24c9`; only this notes file changed after validation.

| Check | Exact command | Result | Log |
| --- | --- | --- | --- |
| Baseline red | `node --test --test-reporter=tap test/receipt0311.test.ts` | exit 1, 0/7; all failures reflect missing contract behavior | `/tmp/owed-bench/logs/owed-pr-receipt-red-590bdca-012904.log` |
| Source audit | `node --test --test-reporter=tap test/needs-structure.test.ts` | exit 0, 5/5 | `/tmp/owed-bench/logs/p-receipt-1-015656.log` |
| Typecheck | `npm run typecheck` | exit 0 | `/tmp/owed-bench/logs/p-receipt-1-015700.log` |
| Node check | `node --test --test-reporter=tap test/receipt0311.test.ts test/checktry.test.ts test/coretools.test.ts test/cli.test.ts` | exit 0, 35/35 | `/tmp/owed-bench/logs/p-receipt-1-015722.log` |
| New tests alone | `node --test --test-reporter=tap test/receipt0311.test.ts` | exit 0, 7/7; only source comment placement and audit registration changed afterward, and final node/full checks covered the tests again | `/tmp/owed-bench/logs/p-receipt-1-013001.log` |
| Full suite | `node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'` | exit 0, 2103/2103, 1443.87 seconds; timeout 2400, no timeout occurred | `/tmp/owed-bench/logs/p-receipt-1-015753.log` |

Baseline red used detached worktree `/tmp/owed-pr-receipt-red-590bdca` with only the final new test copied in, tree `7848793af8f6633452081c68e5f28853c7ce9bf0`. The log shows missing `--run`, `--record`, target-form guidance, tool schema and note recording. Fixtures initialized successfully.

Final full-suite log SHA256: `af4fa492ae9ef2f16d0470e777fa14e5c691832855acf16ad493b33e7b19a966`.

Earlier failures are retained: initial typecheck adaptation errors are in `p-receipt-1-012531.log`; the new replay test was corrected to resolve the original law blob from the ledger instead of the current plan carrying a writes-syntax tag, as recorded in `p-receipt-1-012705.log`. The first full suite passed 2102/2103; its only failure was the HELP digest/comment classification described above, in `/tmp/owed-bench/logs/p-receipt-1-013013.log`. The final full suite passed after that correction.

The notes translation after validation in commit `04d91a3` introduced CJK text under `docs/`, which violates the documentation English check. This follow-up restores English notes only; source, tests, SPEC and their validation evidence are unchanged. Tests were not rerun, as directed by the parent; the merge gate will run the suite.

Remaining implementation work: none. Runtime/publication state: no services or external jobs remain; no submit, merge or publication. This leaf creates the git commits; the parent owns `owed submit` and acceptance.
