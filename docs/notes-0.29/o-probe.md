# o-probe — owed 0.29

Scope: PB1–PB3 and GC1 on base 74e5930; writer worktree owed/o-probe/1.

## Changes

- PB1: automatic merge probes and explicit `--probe-trunk` use one shared classifier. The four contracted missing-file patterns are checked against candidate additions (`git diff --no-renames --diff-filter=A base..commit`) and the probed trunk tree. Paths are canonicalized with realpath fallback through existing ancestors; outside absolute paths are ignored. A qualifying failed probe records existing verdict `error` and an escaped ≤160-character note, never a pass or a trunk-red failure.
- PB2: new anonymous merge-result failures append `\nmerge failure output: <escaped tail ≤160>` to their existing note. Refusals retain it; new anonymous merge-check block needs/notices add the marked line. Existing notes without the marker retain their previous rendering.
- PB3: SPEC explains synthetic merge parents (`HEAD^1` trunk, `HEAD^2` candidate) and forbids pinning the candidate base.
- GC1: compact/full status and merge replies show the housekeeping hint at ≥5 registered, recorded closed attempts. One read-only listing computes the count; open/unrecorded/measurement worktrees do not count, dirty/locked finished attempts do. Listing failures omit the hint and never fail a committed merge. No gc or ledger write is performed by the hint.
- R-029-2 (plan #3392 / ruling #3393): authorized minimal additional hunks in `src/exec.ts:30,612,638` (optional runtime `onTree`, called after every materialization; supplied only to probes), and `src/needs.ts:83–89,101` (one helper/one call, ≤25 lines). These overlap o-lease/o-writer/o-held ownership only as explicitly authorized; later integration must rebase locally.
- Reducer unchanged. Its reads of fail notes are setup/infra timeout-prefix guards (`src/reducer.ts:305–340`) and invariant remeasure quotes (`:447`, prefix before `; last output:`). Appending after existing notes preserves those prefix decisions; no old entry is rewritten and no runtime root enters observations. Existing writes-note path does not receive a check marker.

## Tests

Added only `test/oprobe.test.ts`: 15 TAP tests covering all missing-file patterns, explicit/automatic routes, absolute inside/outside and symlinked root, modified/not-added/present/deleted paths, probe error without trunk-red, escaped/bounded tails and notes, exact legacy need text without marker, SPEC wording, GC threshold/count/list failure/read-only safety and real CLI merge reply.
Existing-test changes: none.

Commands (all via `/tmp/owed-bench/run.sh /work/pi-owed/.owed/wt/o-probe-1`, remote foreground):
- `npx tsc --noEmit -p .` (900 s): exit 0; preliminary log `o-probe-1-162713.log`.
- `node --test --test-concurrency=2 --test-reporter=tap test/oprobe.test.ts test/trackfix.test.ts test/trunkred.test.ts test/attrib.test.ts test/views028.test.ts test/gc.test.ts test/summary.test.ts test/compactreply.test.ts` (1500 s): 102 pass / 0 fail; preliminary log `o-probe-1-163230.log`.
- Red on isolated base: copied only the new test, linked shared node_modules, ran `node --test --test-concurrency=2 --test-reporter=tap test/oprobe.test.ts` (300 s). `o-probe-base-163504.log`: exit 1, 15 tests / 5 pass / 10 fail, every changed-behaviour test fails with ERR_ASSERTION; five unchanged-behaviour tests pass. Removed `/tmp/o-probe-base` afterwards. Earlier fixture-only red trial superseded.
- Full suite `node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'` (1800 s): pending final committed-tree validation.
Final clean-tree typecheck/check/full receipts will replace preliminary receipts before submission.

## Source budget

`git diff --stat 74e5930 -- src`:

    src/exec.ts  |  6 +++---
    src/git.ts   | 17 +++++++++++++++++
    src/needs.ts |  9 ++++++++-
    src/ops.ts   | 48 ++++++++++++++++++++++++++++++++++++++++++------
    src/views.ts |  8 ++++++--
    5 files changed, 76 insertions(+), 12 deletions(-)

Net +64 src lines, below +120. No new entry kind/field/enum, dependency, scheduling or reducer changes. No live dsa 1.1.0 dependency; dsa-related changes are outside this leaf.
