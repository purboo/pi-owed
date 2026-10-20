# p-packet (0.31.1)

Scope: PK1-PK3; base 590bdca (0.31.0); source budget +100 net lines.

- Writer packets list overlapping invariants from runtime inventories of each attempt's slot base. Pure rendering and policy functions receive inventory arguments; the driver caches inventories by immutable base while slots remain open. No ledger or reducer changes.
- Literal new files count as overlap; unmatched future glob paths and directory prefixes do not. Existing files use the plan's writes syntax. Coverage uses planlint's existing calculation; broad invariants are grouped once.
- Plan records and edit previews print separate advisory notes, bounded to ten overlaps. Notes never enter warnings or ledger entries.
- Every writer packet states the committed-HEAD measurement order.
- Per parent ruling R-0311-PK-1, no new plan dry-run option: the dry-run surface is the existing edit preview. Missing inventories omit only PK1 guidance; PK3 remains present.
- Parent ruling R-0311-PK-2 (plan #3816, ruling #3817) authorizes the local named driver runtime adapter in src/drive-run.ts. It does not touch batch-refusal handling.

## Changed existing tests

None. New behavioral coverage is in test/packet0311.test.ts.

## Validation

- Baseline red: `node --test --test-reporter=tap test/packet0311.test.ts` on detached 590bdca with only the new test copied in: exit 1, 0/8 pass. All eight failures are contract assertions (missing PK1 guidance, PK3 order line or PK2 notes); no fixture/import errors. Log: `/tmp/owed-bench/logs/owed-p-packet-0311-red-012909.log`.
- `npm run typecheck`: exit 0. Log: `/tmp/owed-bench/logs/p-packet-1-012915.log`.
- `node --test --test-reporter=tap test/packet0311.test.ts test/drive.test.ts test/views020.test.ts test/sb0221.test.ts test/english.test.ts`: exit 0, 72/72 pass. Log: `/tmp/owed-bench/logs/p-packet-1-012938.log`.
- Green code/test tree for those checks: `93c975935f7dca12c69a9ecfec41c0dcc38b9647` (subsequent changes to this note are documentation only).
- Full suite: `node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'` (bench timeout 2400): exit 0, 2104/2104 pass, 0 failed/cancelled/skipped/todo, TAP duration 1513978 ms. Log: `/tmp/owed-bench/logs/p-packet-1-013028.log`; mirrored tree `dc388b2b04547e53288f5b2fd47f9bfdf430f182`. Final changes after this run only update this note.
- No node, tsc or tests run on the host. All requested checks passed; no remaining unmet contract criteria. Commit stays on the slot branch for parent review/submission/integration; no `owed submit` or merge performed.
- Earlier diagnostic run exposed new-test fixture issues (owner channel, edit plan source, tool context type); those were fixed before the evidence above. The earlier red run is not acceptance evidence.

## Source diff

`git diff --stat 590bdca -- src`:

```text
 src/cli.ts       |  8 ++++----
 src/drive-run.ts | 21 ++++++++++++++++++++-
 src/drive.ts     | 13 +++++++------
 src/extension.ts | 10 +++++-----
 src/ops.ts       | 13 +++++++------
 src/planlint.ts  | 27 ++++++++++++++++++++++++---
 src/views.ts     | 19 +++++++++++++++----
 7 files changed, 82 insertions(+), 29 deletions(-)
```

Net source increase: 53 lines (budget +100).
