# o-held — HD1–HD2

## Scope and implementation

- Slot `/work/pi-owed/.owed/wt/o-held-1`, branch `owed/o-held/1`, base `74e5930` (0.28.0).
- `src/needs.ts`: derive a held halt only from its active current-attempt halt plus a later named, non-prospective decision ruling. Suppress the halt fallback and writer-stop decision special case only. Keep independent owner/parent obligations and questions unchanged. Activity names the latest ruling and the optional resume release.
- `src/views.ts`: compact/full status and brief show held progress. Why and receipt headlines name the ruling, and Next shows release without turning it into a need. Original halt evidence stays in the card/ledger; held halt diagnostics no longer say the parent/owner is needed. Owner-halt fallback rows are omitted, not independent owner obligations.
- `src/drive-bg.ts`: existing structured-need revalidation drops obsolete queued resume/decide wakes. Null/legacy node halt reports are also revalidated for held rulings, including reports without fact marks; failed reads retain wakes. Driver scheduling, reducer, snapshots and ledger vocabulary are unchanged.
- `docs/SPEC.md`: user-facing decision, needs/progress and halt sections updated. No version/README/SKILL changes.

## Contract clarifications

- Parent ruling R-029-1: `clearsHalt` remains unchanged. A plain named rule without decision after a halt already clears it, so there is no active halt/resume need. Negative cases that remain halted are prospective/`*` rules, earlier decisions and another node's decision. Tests preserve that existing behavior.
- Parent approved recording final verification commands and stable complete-log paths here, with exact final counts/exit codes in the submission handoff/logs. Notes are not edited after final verification, preserving the tested commit's tree and dirty=0. Full suite runs once.

## Tests

New `test/oheld.test.ts` has 12 TAP tests:

- HD1 resume and stopped-writer fallback suppression, exact held activity, repeated decisions/latest ruling, committed decision and unchanged halt evidence (`:47`).
- HD1 independent owner approval/manual evidence commands and recorded waiver debt unchanged (`:64`).
- HD1/R-029-1 ordinary clearing and prospective/`*`/earlier/other-node negatives (`:86`, existing behavior).
- HD1 resume/submit/standalone rule/new attempt releases; a later new halt needs resume (`:102`).
- HD1 dependencies/later plan/executor note do not disguise or release held activity (`:117`).
- HD2 compact/full status, why and receipt, no synthetic owner-halt pending row (`:130`).
- HD2 brief, real CLI decide --no-resume and all read surfaces, pi status/brief/why and `/owed` (`:151`).
- HD2 real Driver reports and busy Follower drop a queued stopped-writer wake; subsequent driver pass does not wake for the halt (`:180`).
- HD2 null race reports with/without fact marks and stale structured halt need revalidation (`:200`).
- HD1/HD2 unanswered writer questions still wake while held (`:217`).

All dsa describes/argv are fake; no live dsa 1.1.0 dependency. Existing-test changes: **none**.

## Validation evidence

All node/npm/tsc/test commands run remotely in the foreground via `/tmp/owed-bench/run.sh`; none run on the local host.

- Final-test red on detached base 74e5930: `/tmp/owed-bench/logs/o-held-base-162239.log`; exit 1; 12 tests, 1 pass (unchanged R-029-1 negatives), 11 fail, all 11 ERR_ASSERTION; no skips/cancellations. Only new test copied into base; temporary worktree removed (exit 0).
- Development focused check (specified ten files): `/tmp/owed-bench/logs/o-held-1-161741.log`; exit 0; 147 pass, 0 fail, 0 skipped/cancelled.
- Final source-risk development check/typecheck: `/tmp/owed-bench/logs/o-held-1-162055.log`; `npx tsc --noEmit -p . && node --test --test-concurrency=2 --test-reporter=tap test/oheld.test.ts test/needs-structure.test.ts test/drive028.test.ts`; exit 0; 47 pass, 0 fail, no skips/cancellations.
- Early typecheck failures (test syntax/missing type import) and two new-test fixture-scope assertions were fixed; no existing test failed.

Final clean-commit checks (complete logs, first line must have tree equal to submitted HEAD^{tree} and dirty=0):

- `/tmp/owed-bench/logs/o-held-final-typecheck.log`: `/tmp/owed-bench/run.sh /work/pi-owed/.owed/wt/o-held-1 900 "npx tsc --noEmit -p ."`.
- `/tmp/owed-bench/logs/o-held-final-check.log`: `/tmp/owed-bench/run.sh /work/pi-owed/.owed/wt/o-held-1 1500 "node --test --test-concurrency=2 --test-reporter=tap test/oheld.test.ts test/decide.test.ts test/needs.test.ts test/needs-structure.test.ts test/views028.test.ts test/drive028.test.ts test/summary.test.ts test/compactreply.test.ts test/resume.test.ts test/drive-ledger.test.ts"`.
- `/tmp/owed-bench/logs/o-held-final-full.log`: `/tmp/owed-bench/run.sh /work/pi-owed/.owed/wt/o-held-1 1800 "node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'"` (one full-suite run).

`git diff --stat 74e5930 -- src`:

```text
 src/drive-bg.ts | 12 +++++++++---
 src/needs.ts    | 14 ++++++++++++--
 src/views.ts    | 27 ++++++++++++++++-----------
 3 files changed, 37 insertions(+), 16 deletions(-)
```

Net src +21, under +120 leaf limit. No scheduling/persistence redesign. Leaf is submitted for parent integration/review, not self-accepted or published.
