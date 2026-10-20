# o-mergeq — 0.31 MQ1–MQ2

Base: `ebf090b83644c4bb170802b97053bc17cd09a910` (0.30.0).
Ownership: `src/reducer.ts`, `src/drive.ts`, `src/drive-run.ts`, `src/views.ts`,
`test/mergeq.test.ts`, the capacity assertions in `test/wais026.test.ts`,
the frozen-view adapter in `test/perf/differential.ts`, and
`docs/SPEC.md`. Source budget: net +140 lines; current net +50.

## Behavior

- `max` counts non-accepted open attempts, including removed-node slots and
  same-pass dispatch reservations. All open slots count toward `2 × max`.
  Accepted slots still reserve writes. Status and why explain both capacity
  limits; status prints the active/pending split and honors its supplied max
  only with pending merges (`p > 0`), per parent ruling R-031-MQ-2. With `p = 0`,
  compact/full status retain their 0.30 text. Skip explanations remain unchanged
  by this ruling. Both render modes cover idle, active-only and pending states.
- Refused driver batch candidates are atomically persisted in
  `drive/batch-isolated.json` under the ledger directory. Matching commits are
  excluded before batch planning, independent of trunk, partners and process.
  Candidate changes, completed merges and closed slots prune records.
- R-031-MQ-1 (parent ruling #3715) also scopes `batchFailed` to the candidate
  commits current when the failure was recorded. Historical candidates come
  from folding the ledger prefix, including plan invalidation and carry submits;
  the query cache is not serialized. Same-commit submits retain suppression;
  changed candidates lift MT4 while unchanged members remain runtime-isolated.
  The manual batch operation uses this existing shared predicate unchanged.
- Ledger schema, folded states, obligation keys and merge verdict gates are
  unchanged. The status batch preview remains ledger-only, as documented in
  SPEC's existing limitation; the driver applies runtime isolation to its plan.

## Persistence and concurrency

The repository's existing single-driver lock is the sole writer boundary for
isolation. The driver reads the optional file during initialization; missing,
unreadable or invalid JSON yields no records. Writes use a same-directory temp
file and rename before returning the refusal report. Write failures propagate;
they are not reported as successful persistence. No ledger or operation lock
is added and no Git commit/rollback path changes.

Batch candidate commits are captured at scheduling, before asynchronous lease
acquisition/measurement. A refusal cannot attach itself to a newer submit.
Reconciliation runs after measurement reaping and at each pass, removing stale
records even when no merge is scheduled. Tests include a resubmit while a batch
measurement is gated, plus a separate Node process for restart recovery.

## Changed existing tests

Existing assertion changes are confined to MQ1's capacity presentation:

In `test/wais026.test.ts`:

1. `WA1: max reason agrees with driver and counts removed open slots` — MQ1
   replaces the old open-attempt sentence with the active/pending sentence;
   all refusal and removed-slot assertions remain.
2. `WA1: status and why use the live driver max override instead of the plan max`
   — MQ1 updates the expected sentence and the negative assertion after lock
   release; the override and fallback behavior remains covered.

3. `test/perf/differential.ts`: the shared frozen-view adapter adds the MQ1
   capacity sentence to BASE only when pending > 0, using only its frozen state's
   open slots, phases and plan max. CUR is not stripped or normalized, and state/
   keys are not adapted. Needs-you insertion follows Trunk and the conditional
   capacity sentence. This updates
   the four `test/perf.test.ts` differential cases (fuzz, synthetic, real wais,
   real self) and the two `test/views028.test.ts` cases named R-028-51 corrupted
   CUR and R-028-41/44 historical merge diagnostics. Their exact comparisons and
   corruption detection remain intact; neither test file itself is edited.

`test/summary.test.ts` remains byte-identical to base under R-031-MQ-2.
All new cases are in `test/mergeq.test.ts`. No test is skipped or weakened.

## Validation

All Node execution is through `/tmp/owed-ipc/run.sh`, never on the source host.
Initial IPC run: `/tmp/owed-ipc/logs/o-mergeq-1-081343.log`, typecheck passed,
new tests 6/7 passed. The failed test incorrectly expected the resubmitted node
in the first batch after its accepted-order position moved behind two partners;
the fixture now leaves one partner. This failed run is retained, not acceptance.
SHA256: `8208a0f8da63be1c40c571319648d3f53e7d15e7e089891a821fa9acc3fdd996`.

Focused receipt: `/tmp/owed-ipc/logs/o-mergeq-1-081927.log`, exit 0;
`npm run typecheck` and the packet's six-file check passed (92/92).
Tested tree: `70806f0e63a2164e89301ec408a6a35c389ee36c`.
SHA256: `1359741f1d128b07ab18b43225aed0280c224e31e06de3bd49015f520e558639`.
A final inspection then changed the in-flight candidate capture from an object
to a Map to preserve queue order for integer-like node IDs; final checks below
will cover this source change.

Baseline red receipt: `/tmp/owed-ipc/logs/owed-mq-red-ebf090b-082018.log`, exit 1,
9 failed / 0 passed / 0 skipped; command:
`node --test --test-reporter=tap test/mergeq.test.ts`.
Tree: `fc38574a392007fbea79e71f958e51ce86870d6c`.
SHA256: `6a57312859210d56068476cea0c6cda7a7ae9ca2de8cdde271026c15d89c64b3`.
Failures are contract assertions: active capacity dispatches none, old capacity
text, old retry text, restarted driver re-batches b with c, missing or unchanged
isolation file, and old MT4 suppression survives both new candidate commits.
All fixture acceptance and gated-measurement preconditions passed.

Pre-ruling focused receipt: `/tmp/owed-ipc/logs/o-mergeq-1-082142.log`, exit 0,
typecheck and packet checks 92/92 on tree
`bff47abe85b476fe195639a932bdd405f0ef2ecb`.
SHA256: `36b4e37f2c58f3ffb13c5d5659d06516140aea4e30c0f2d8b4c033a4dd5065d8`.

First full suite on that same tree: `/tmp/owed-ipc/logs/o-mergeq-1-082232.log`,
exit 1, 2031 passed / 7 failed / 0 skipped, 1286.883 seconds (not timed out).
Command: `node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'`.
SHA256: `dce195e6d475bfac8850f9b1e468bdee03379789d9454617d7bdd359584c6b79`.
All seven failures were legacy presentation comparisons missing MQ1's capacity
sentence; in the differential adapter its insertion also moved the exact
Needs-you anchor. The first compatibility rerun passed typecheck and 34/34
checks on tree `1cf2570dabfb8dd7e3c552d4c7eb9c96d3204923`, log
`/tmp/owed-ipc/logs/o-mergeq-1-084544.log`. Parent then stopped its full-suite
stage (`/tmp/owed-ipc/logs/o-mergeq-1-084820.log`, incomplete, no exit receipt)
to issue R-031-MQ-2; this is not a successful full-suite result.

R-031-MQ-2 is applied to source, docs, differential BASE and new regression
coverage; the legacy summary assertions are restored. Final validation passed on
tree `2a2e70aca111d6ed066e6310e367f23850b8852f`; the local complete tree was
recomputed and matched that receipt before this notes-only evidence update.

- Focused command: `npm run typecheck && node --test --test-concurrency=2 --test-reporter=tap test/mergeq.test.ts test/wais026.test.ts test/perf.test.ts test/summary.test.ts test/views028.test.ts`.
  IPC timeout 900s, exit 0; typecheck passed, 57/57 tests passed, zero skipped,
  135.968 seconds. Log: `/tmp/owed-ipc/logs/o-mergeq-1-085145.log`.
  SHA256: `e5eea6d768f855a52e725e19f32caa1434aaa05557ced87d00d3b212c9903117`.
- Full command: `node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'`.
  IPC timeout 1800s, exit 0; 2039/2039 tests passed, zero failed/cancelled/skipped,
  1371.265 seconds. Log: `/tmp/owed-ipc/logs/o-mergeq-1-085424.log`.
  SHA256: `01b4d7f8243cac0b74306abfd0dfb332aafb27b808490db1bdee10edaa4ad70f`.
- Durable receipt: `01M5BCNYS75HZZ5PWCJRXK6D4N`, completed exit 0.
- `git diff --check`: passed. Source diff remains net +50, below +140 budget.

No unmet leaf criteria remain. Independent review and integration are parent-owned;
no `owed submit`, merge, push or publication was performed.
Baseline red checkout: `/tmp/owed-mq-red-ebf090b`, detached at `ebf090b`, with only
`test/mergeq.test.ts` copied in.

## Source diff

`git diff --stat ebf090b -- src`:

```text
 src/drive-run.ts | 49 ++++++++++++++++++++++++++++++++++++-------------
 src/drive.ts     |  6 +++---
 src/reducer.ts   | 31 ++++++++++++++++++++++++++-----
 src/views.ts     | 14 ++++++++++----
 4 files changed, 75 insertions(+), 25 deletions(-)
```

Publication: slot branch only; parent submits, attests and merges.
