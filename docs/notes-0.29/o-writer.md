# o-writer — WR1–WR2 (0.29)

## Scope and behavior

Base `74e59304071d66254fb90cc08894f85e13ea09e1`; writer owns only WR1–WR2 in `.owed/wt/o-writer-1`.
No ledger/reducer, dependency, lease, sweep, probe or held-ruling semantics changed.

- WR1: flatten the complete final text; quote whole through 600 Unicode code points, else head 200/tail 380 with nearby-space cuts. Append omitted commit/durable facts (first appearance, deduplicated, at most three each). The named commit marker `\u63d0\u4ea4` (U+63D0 U+4EA4) is ASCII-escaped in shipped source/docs to preserve English-only shipping. Preserve JSON/control/bidi escaping and old recorded halt bytes; both trailer parsers share the new safe parser.
- WR2: parse only optional facts from the last described call. A successful sealed/pruned writer with awaiting and no current candidate skips stopped/no-submit halts and submit nudges, including pending rebase, ruling and repair-budget routes; existing repair/ruling/rebase follow-ups remain.
- WR2 / R-029-5: foreign wake generations advance the runtime generation fence in `current()`. `restartGen` retains 0.28's idempotent recovery: observed running state cannot prove a foreign wake and never suppresses the re-ask. The original request id/message is reused, its authoritative reply is cached, and it cannot regress the `lastGen` fence.
- WR2: driver publishes current-attempt waits through its private runtime cache; live status/why show waiting, with no new parent need/wake. No live driver or stale attempt means unknown. Halt trailers include awaiting (non-ok) and up to three bounded ended-process descriptions, with the total including unlisted processes.
- WR2 packet: exact durable long-run section immediately after checks, filled with the genesis-derived project ID, node and attempt.
- Parent R-029-3: finite numeric sealedAt gives precise per-generation age; missing/string/non-finite uses first driver observation, reset on generation change/restart. Future timestamps clamp age to zero. Display only.
- SPEC sections 9.3 and 12.5.4 describe these user-facing behaviors and fallback limits.

## Regression tests

`test/owriter.test.ts`: 24 node:test/TAP cases, covering quote thresholds/Unicode/word cuts/facts/escaping/parser round trips, old halt preservation, all six sealed/pruned and worktree combinations, submit/plan invalidation, pending rebase and ruling, repair/budget, non-ok/ended diagnostics, current candidate exclusion, runtime display/cache/parent wake, exact/fallback age and generation fencing, old-dsa stale sealed/pruned recovery after a between-pass follow-up, and packet text.

Base red: `/tmp/owed-ipc/logs/o-writer-base-162641.log`: exit 1, 22 tests / 0 pass / 22 fail, all 22 ERR_ASSERTION. Only the new test was copied to the detached base worktree; it was then removed (cleanup exit 0).

## Changed existing tests (only contract changes)

- `test/stopask.test.ts:72` (test starts :65), WR1: ordinary stopped-writer reply now includes the evidence paragraph.
- `test/stopask.test.ts:89` (test :78), WR1: rebased clean stop quotes complete final text.
- `test/stopask.test.ts:133,143,146`, WR1: wake/why/status test name, whole-text quote, and prohibition on unrelated repair evidence; earlier final-text paragraph is now kept.
- `test/stopask.test.ts:157,165`, WR1: replace old 300-character truncation expectation with whole flattened reply through 600 code points; missing reply still explicit.
- `test/stopask.test.ts:192` (test :172), WR1: executor-rebase/ruling halt quotes the complete default final text.
- `test/stopask.test.ts:226,228,231` (test :215), WR1: pending-rebase halt/wake/status keeps both final-text paragraphs.
- `test/stopask.test.ts:254` (test :235), WR1: repeated-rebase clean-head halt quotes the complete default final text.
- `test/stopask.test.ts:387` (test :377), WR1: unreadable pending-rebase worktree halt quotes the complete default final text.
- `test/drive.test.ts:120`, WR2 packet: expected dispatch packet receives its state so the new project ID matches the actual task.
- `test/activity.test.ts:64` and `test/needs.test.ts:253`, WR2: update the byte-pinned runtime-vocabulary SHA to `c6a3451120a2ffe30465bd7c0afd1a7cd6a600e07b6a8f6acad394b51064fbf5`; no ledger need kind/field changed.

## Source budget

`git diff --stat 74e5930 -- src`:

```text
 src/activity.ts    | 10 ++++++++++
 src/drive-run.ts   | 31 +++++++++++++++++++++++++++----
 src/drive.ts       | 15 ++++++++++++---
 src/dsa.ts         |  5 ++++-
 src/needs-types.ts |  6 ++++--
 src/needs.ts       | 16 ++++++++--------
 src/types.ts       |  5 +++++
 src/views.ts       | 36 ++++++++++++++++++++++++++++--------
 8 files changed, 98 insertions(+), 26 deletions(-)
```

Net +72 source lines, under the +120 leaf limit. Duplicate legacy trailer parsing in the touched lines was removed.

## Review #3416 repair / R-029-5

The review reproduction `/tmp/owed-ipc/logs/o-writer-1-175443.log` showed gen1 observed running, a follow-up applied as gen2 between passes, and describe still reporting sealed gen1. The running-state shortcut incorrectly cached `sentGen=null`, skipped authoritative recovery, and recorded a no-submit halt. Old dsa can produce this sequence.

The repair removes only that shortcut from `restartGen`; no optional newer-dsa skip is needed. Recovery again uses the original id/message and dsa's idempotent answer, exactly as 0.28. `current()` retains its monotonic `lastGen` fence for foreign wakes. The retained foreign-wake regression now checks one authoritative re-ask returning original gen2, retention of the observed gen3 fence through a stale seal, and no repeated re-ask after a later resume; a recovery request is not a new follow-up delivery.

- Added two reviewer-scenario regressions for old-dsa sealed and pruned replies. Before the source fix, `/tmp/owed-ipc/logs/o-writer-1-180914.log`: exit 1, 2 tests / 0 pass / 2 fail; both fail because stale gen1 records a halt.
- After the fix, `/tmp/owed-ipc/logs/o-writer-1-180936.log`: exit 0, 110 tests / 110 pass / 0 fail. Command: `node --test --test-concurrency=2 --test-reporter=tap test/owriter.test.ts test/drive-run.test.ts test/stalesend.test.ts test/drive028.test.ts test/stopask.test.ts`.
- This round runs only those affected tests and `npx tsc --noEmit -p .` through the remote foreground runner. Final clean repair-commit logs/exit codes are provided in the handoff. No full suite, submit, rebase or background script this round; await the parent's rebase message after o-held integration. Prior full-suite results below belong to their recorded commits and do not validate this repair.

## Prior validation and publication

Full-suite accepted source commit S: `3c445abc7f23b2b274fdcd100f22b7d28eaada1d`; tree `1e0fa91b444e51cc5f96ec1761a19831a153cf15`.
- `/tmp/owed-ipc/logs/o-writer-1-165545.log`: `node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'`, timeout 1800, exit 0; 1812 tests / 1812 pass / 0 fail, no cancelled/skipped/todo. Header: dirty=0, tree matches S. Duration 1235497 ms.
- `/tmp/owed-ipc/logs/o-writer-1-165258.log`: `npx tsc --noEmit -p .`, exit 0, dirty=0, tree matches S.
- `/tmp/owed-ipc/logs/o-writer-1-165318.log`: exact assigned focused command, exit 0; 274 tests / 274 pass / 0 fail, dirty=0, tree matches S.
- `/tmp/owed-ipc/logs/o-writer-1-165522.log`: `node --test --test-concurrency=2 --test-reporter=tap test/english.test.ts`, exit 0; 3 tests / 3 pass / 0 fail, dirty=0, tree matches S.

Two full-suite runs total. The first, `/tmp/owed-ipc/logs/o-writer-1-163050.log`, was on clean `0ec2c518dd16f76fac156a64b3055ebebc79fbc2` / tree `09cd14f2fc18dc34e78239d10fcf967ee6c0d311`: exit 1, 1812 tests / 1811 pass / 1 fail. Its sole failure was the shipped-English scan rejecting the contract-required literal marker. Parent authorized a behavior-equivalent ASCII escape fix without changing `test/english.test.ts`. That narrow fix changed 3 files, +10/-4 lines (including recording evidence); `src/views.ts` changed one line. The literal regression input remains in test/, outside the shipped-English scan.

Per the final parent workflow, this evidence update is a separate notes-only commit D after S; no amend, and no source/test/SPEC changes between S and D. D runs only typecheck and the assigned leaf check before `owed submit o-writer`; its actual commit/tree, log paths, exit codes and S..D diff stat are returned in the handoff. Full-suite evidence remains bound to S, not relabeled as D.

All node/npm/tsc/test execution is remote through `/tmp/owed-ipc/run.sh`, in the foreground. No live dsa integration (explicit fake-interface scope); parent owns integration/review/acceptance.
