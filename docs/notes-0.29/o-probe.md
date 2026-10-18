# o-probe — owed 0.29

Scope: PB1–PB3 and GC1 on base 74e5930; writer worktree owed/o-probe/1.

## Changes

- PB1: automatic merge probes and explicit `--probe-trunk` use one shared classifier. The four contracted missing-file patterns are checked against candidate additions (`git diff --no-renames --diff-filter=A base..commit`) and the probed trunk tree. Paths are canonicalized with realpath fallback through existing ancestors; outside absolute paths are ignored. A qualifying failed probe records existing verdict `error` and an escaped ≤160-character note, never a pass or a trunk-red failure.
- PB2 / R-029-6 (review block #3417): only new anonymous merge-result `check:` failures append `\nmerge failure output: <escaped tail ≤160>` to their existing note; merging/fail/no-failed-name conditions remain. Refusals retain it; new anonymous merge-check block needs/notices add the marked line. Invariant failures retain their original notes and refusal text, with no PB2 marker. Existing notes without the marker retain their previous rendering.
- PB3: SPEC explains synthetic merge parents (`HEAD^1` trunk, `HEAD^2` candidate) and forbids pinning the candidate base.
- GC1: compact/full status and merge replies show the housekeeping hint at ≥5 registered, recorded closed attempts. One read-only listing computes the count; open/unrecorded/measurement worktrees do not count, dirty/locked finished attempts do. Listing failures omit the hint and never fail a committed merge. No gc or ledger write is performed by the hint.
- R-029-2 (plan #3392 / ruling #3393): authorized minimal additional hunks in `src/exec.ts:30,612,638` (optional runtime `onTree`, called after every materialization; supplied only to probes), and `src/needs.ts:83–89,101` (one helper/one call, ≤25 lines). These overlap o-lease/o-writer/o-held ownership only as explicitly authorized; later integration must rebase locally.
- Reducer unchanged. Its reads of fail notes are setup/infra timeout-prefix guards (`src/reducer.ts:305–340`) and invariant remeasure quotes (`:447`, prefix before `; last output:`). Appending after existing notes preserves those prefix decisions; no old entry is rewritten and no runtime root enters observations. Existing writes-note path does not receive a check marker.

## Tests

Added `test/oprobe.test.ts`: 16 TAP tests covering all missing-file patterns, explicit/automatic routes, absolute inside/outside and symlinked root, modified/not-added/present/deleted paths, probe error without trunk-red, escaped/bounded tails and notes, exact legacy need text without marker, SPEC wording, GC threshold/count/list failure/read-only safety and real CLI merge reply.
Existing-test changes: `test/needs-structure.test.ts:190` (GC1) adds exactly one registered `Git-derived status addition` literal digest for `src/views.ts/housekeepingText`; no scanner/assertion changes. Parent explicitly authorized this after the first full suite's PR2 failure. Digest `8a2ccacc707ae5b3a6c7349c51bbfa0b83550b250368e35c0b3355e022ce9eb0` was computed remotely with the test's own `digest` expression (log `o-probe-1-165910.log`, exit 0).

Commands (all via `/tmp/owed-ipc/run.sh /home/purboo/project/pi-things/pi-owed/.owed/wt/o-probe-1`, remote foreground):
- `npx tsc --noEmit -p .` (900 s): exit 0; preliminary log `o-probe-1-162713.log`.
- `node --test --test-concurrency=2 --test-reporter=tap test/oprobe.test.ts test/trackfix.test.ts test/trunkred.test.ts test/attrib.test.ts test/views028.test.ts test/gc.test.ts test/summary.test.ts test/compactreply.test.ts` (1500 s): 102 pass / 0 fail; preliminary log `o-probe-1-163230.log`.
- Red on isolated base: copied only the new test, linked shared node_modules, ran `node --test --test-concurrency=2 --test-reporter=tap test/oprobe.test.ts` (300 s). `o-probe-base-163504.log`: exit 1, 15 tests / 5 pass / 10 fail, every changed-behaviour test fails with ERR_ASSERTION; five unchanged-behaviour tests pass. Removed `/tmp/o-probe-base` afterwards. Earlier fixture-only red trial superseded.
- First full suite `node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'` (1800 s): commit `b7ed75fb92ad719fcd6441cf993b94039f7c3260`, tree `0b5b1be3e953d8f0b0f42ff0ed77a6189113f00b`, dirty=0. `/tmp/owed-ipc/logs/o-probe-1-163720.log`: exit 1, 1805 tests / 1804 pass / 1 fail, 0 skipped/cancelled. Sole failure: PR2 unregistered housekeeping command literal, fixed by the explicitly approved exact registration above.
- Second and final full suite, same command (1800 s): validation commit S `5689acc5c579178e75ba22ce8fb166cd800e92e5`, tree `543b550bb6bcd86b54cc4f17526eca58ec0b1c18`, dirty=0. `/tmp/owed-ipc/logs/o-probe-1-165935.log`: exit 0, 1805 tests / 1805 pass / 0 fail / 0 skipped/cancelled; 1234974.901109 ms.
- Typecheck on the first clean implementation commit: `/tmp/owed-ipc/logs/o-probe-1-163642.log`, exit 0, dirty=0, tree `0b5b1be3e953d8f0b0f42ff0ed77a6189113f00b`.

Prior delivery: validation S `5689acc5c579178e75ba22ce8fb166cd800e92e5` and documentation-only D `e304c37e32b6e56bbe55a4e19fa53e32f25c3ca3` remain reachable. D passed typecheck (`o-probe-1-172117.log`, exit 0) and the 102-test leaf check (`o-probe-1-172137.log`, exit 0), then submitted as #3396. The full-suite receipts above predate R-029-6 and do not validate the current repair.

Current repair round (R-029-6):
- Supplied reproduction `/tmp/owed-ipc/logs/o-probe-1-175658.log` confirms that anonymous merge-tree `inv:anon` incorrectly received the PB2 marker. Fixed only the write guard in `src/ops.ts:2045`; no exec/views edits in this round.
- New negative `test/oprobe.test.ts:157` asserts an actual merge-tree invariant fail, no parsed failed names, byte-exact original note for every failure (including automatic retry), and no marker in the refusal while retaining its original output tail. Existing positive tests still require the marker for anonymous checks. No additional existing-test changes.
- Regression red before the fix: `/tmp/owed-ipc/run.sh /home/purboo/project/pi-things/pi-owed/.owed/wt/o-probe-1 120 "node --test --test-concurrency=2 --test-reporter=tap --test-name-pattern='PB2/R-029-6' test/oprobe.test.ts"`; `/tmp/owed-ipc/logs/o-probe-1-180911.log`, exit 1, 1 test / 0 pass / 1 fail.
- Typecheck: `/tmp/owed-ipc/run.sh /home/purboo/project/pi-things/pi-owed/.owed/wt/o-probe-1 900 "npx tsc --noEmit -p ."`; `/tmp/owed-ipc/logs/o-probe-1-180927.log`, exit 0.
- Affected checks: `/tmp/owed-ipc/run.sh /home/purboo/project/pi-things/pi-owed/.owed/wt/o-probe-1 1500 "node --test --test-concurrency=2 --test-reporter=tap test/oprobe.test.ts test/trackfix.test.ts test/trunkred.test.ts test/attrib.test.ts test/views028.test.ts test/gc.test.ts test/summary.test.ts test/compactreply.test.ts test/remeasure.test.ts"`; `/tmp/owed-ipc/logs/o-probe-1-180948.log`, exit 0, 107 tests / 107 pass / 0 fail / 0 skipped/cancelled.
- Both green logs measure precommit tree `f4c0f8933e84d2fd19ad65c675811913882288f9` (dirty=2, only ops.ts/new test changed); this notes update follows those checks. The repair commit has identical source/tests. Per parent instruction: foreground remote checks only, no full-suite rerun, no amend, no submit or background script; await a rebase message after o-held merges. Later o-lease/o-probe integration owns the exec.ts conflict.

## Source budget

`git diff --stat 74e5930 -- src`:

    src/exec.ts  |  6 +++---
    src/git.ts   | 17 +++++++++++++++++
    src/needs.ts |  9 ++++++++-
    src/ops.ts   | 48 ++++++++++++++++++++++++++++++++++++++++++------
    src/views.ts |  8 ++++++--
    5 files changed, 76 insertions(+), 12 deletions(-)

Net +64 src lines, below +120. R-029-2 alone: exec.ts 3 insertions / 3 deletions (net 0); needs.ts 8 insertions / 1 deletion (net +7), total net +7. No new entry kind/field/enum, dependency, scheduling or reducer changes. No live dsa 1.1.0 dependency; dsa-related changes are outside this leaf.
