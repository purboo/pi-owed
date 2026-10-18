# o-writer — WR1–WR2 (0.29)

## Scope and behavior

Base `74e59304071d66254fb90cc08894f85e13ea09e1`; writer owns only WR1–WR2 in `.owed/wt/o-writer-1`.
No ledger/reducer, dependency, lease, sweep, probe or held-ruling semantics changed.

- WR1: flatten the complete final text; quote whole through 600 Unicode code points, else head 200/tail 380 with nearby-space cuts. Append omitted commit/durable facts (first appearance, deduplicated, at most three each). Preserve JSON/control/bidi escaping and old recorded halt bytes; both trailer parsers share the new safe parser.
- WR2: parse only optional facts from the last described call. A successful sealed/pruned writer with awaiting and no current candidate skips stopped/no-submit halts and submit nudges, including pending rebase, ruling and repair-budget routes; existing repair/ruling/rebase follow-ups remain.
- WR2: foreign wake generations advance the runtime generation fence. Recovery does not replay a prior owed follow-up after observing the foreign generation running, including after a stale seal and later resume.
- WR2: driver publishes current-attempt waits through its private runtime cache; live status/why show waiting, with no new parent need/wake. No live driver or stale attempt means unknown. Halt trailers include awaiting (non-ok) and up to three bounded ended-process descriptions, with the total including unlisted processes.
- WR2 packet: exact durable long-run section immediately after checks, filled with the genesis-derived project ID, node and attempt.
- Parent R-029-3: finite numeric sealedAt gives precise per-generation age; missing/string/non-finite uses first driver observation, reset on generation change/restart. Future timestamps clamp age to zero. Display only.
- SPEC sections 9.3 and 12.5.4 describe these user-facing behaviors and fallback limits.

## Regression tests

`test/owriter.test.ts`: 22 node:test/TAP cases, covering quote thresholds/Unicode/word cuts/facts/escaping/parser round trips, old halt preservation, all six sealed/pruned and worktree combinations, submit/plan invalidation, pending rebase and ruling, repair/budget, non-ok/ended diagnostics, current candidate exclusion, runtime display/cache/parent wake, exact/fallback age and generation fencing, and packet text.

Base red: `/tmp/owed-ipc/logs/o-writer-base-162641.log`: exit 1, 22 tests / 0 pass / 22 fail, all 22 ERR_ASSERTION. Only the new test was copied to the detached base worktree; it was then removed (cleanup exit 0).

Before R-029-3 additions: `/tmp/owed-ipc/logs/o-writer-1-162005.log` typecheck exit 0; `/tmp/owed-ipc/logs/o-writer-1-162024.log` exact assigned focused command exit 0, 273 tests / 273 pass / 0 fail. After age additions: `/tmp/owed-ipc/logs/o-writer-1-162552.log` new-file check exit 0, 22 tests / 22 pass / 0 fail. Final clean-commit validation replaces this preliminary state below.

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
 src/drive-run.ts   | 32 ++++++++++++++++++++++++++++----
 src/drive.ts       | 15 ++++++++++++---
 src/dsa.ts         |  5 ++++-
 src/needs-types.ts |  6 ++++--
 src/needs.ts       | 16 ++++++++--------
 src/types.ts       |  5 +++++
 src/views.ts       | 36 ++++++++++++++++++++++++++++--------
 8 files changed, 99 insertions(+), 26 deletions(-)
```

Net +73 source lines, under the +120 leaf limit. Duplicate legacy trailer parsing in the touched lines was removed.

## Final validation and publication

Final validation is not yet run; this section will be replaced with actual clean-commit commands/logs/counts. All node/npm/tsc/test execution is remote through `/tmp/owed-ipc/run.sh`, in the foreground. No live dsa integration (explicit fake-interface scope); parent owns integration/review/acceptance.
