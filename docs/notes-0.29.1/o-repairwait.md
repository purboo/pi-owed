# o-repairwait — 0.29.1 RW1–RW3

## Scope and implementation

- Worktree: `.owed/wt/o-repairwait-1`; baseline: `bbf43fe20d70358062672fdcfdc624725391bf5b`.
- `src/drive.ts` only removes `!c` from `durableWait`: a sealed/pruned writer with status ok and nonempty awaiting is exempt from no-submit, repairs-exhausted and pending-rebase halts even with a current candidate. Existing repair/ruling/rebase follow-up priority, non-ok seal diagnostics, review/attest/merge and needs-parent paths remain unchanged.
- The pure display helper `writerWaitingEligible()` in `src/needs.ts` allows either no candidate or a repair/ruling follow-up sent to the current attempt's writer after the current candidate submit. `activity()`, driver waiting-cache publication and runtime cache reading share that predicate. This does not change `needs()` ordering, `repaired()`, ledger entries or measurement records.
- `docs/SPEC.md` updates the waiting display and seal rules in place. No version, README, SKILL or release changes.
- The original drive.ts:920 `if (wSealed && !c)` encloses the :941 durableWait early return and changed/nudge logic; a current candidate cannot reach that path. A brief planSet clears the candidate. A new regression preserves the 0.29.0 candidate-free behavior: nonempty awaiting suppresses the reminder; clearing awaiting allows the planChanged submit follow-up. The parent confirmed option (b), retaining the existing submit-reminder behavior.

## Parent rulings

- R-0291-1 (decision #3477 / ruling #3478): extend writes to `src/activity.ts` only for assembleRuntime's writer-waiting row filter. Other activity, measurement and asking behavior stays unchanged. Use a shared helper and keep net source growth within 40 lines.
- R-0291-2 (ruling #3479): place the helper in `src/needs.ts`; drive-run.ts and activity.ts import it from needs.ts; drive.ts does not import it. The original placement caused an ESM initialization cycle and a top-level `WRITER_DECISION` access failure; see `/tmp/owed-ipc/logs/o-repairwait-1-125640.log:8-14`. No public top-level constants or new modules change; the needs-to-drive-run import remains type-only.
- R-0291-3 (ruling #3480): contract test4's writer ruling means an ordinary named ruling (writer:false) delivered as a ruling follow-up to the writer, retaining the candidate and review block. A writer:true ledger rule clears the candidate at reducer.ts:769-772, and drive.ts's writerRule no-submit halt is reachable only without a candidate, an unchanged baseline path. The original fixture incorrectly passed on the baseline; evidence: `/tmp/owed-ipc/logs/owed-repairwait-red-bbf43fe-131258.log`. The replacement exercises the K5.2 path with a retained candidate, with a separate writer:true compatibility regression.

## Existing test change (one test)

- In `test/owriter.test.ts`, `WR2 current candidate does not gain a durable wait exemption` becomes `RW1/RW2 current candidate repair turn gains a durable wait exemption`. The old assertions that candidate repair awaiting still halts and publishes no waiting row are exactly the behavior RW1/RW2 reverse. The fake dsa generation is set to 2 to describe the current seal after the applied repair follow-up, rather than the stale gen1 seal. Stale-generation protection is unchanged.
- RW2's other requirement remains covered: the new under-review test in `test/repairwait.test.ts` asserts that a candidate without a writer repair/ruling follow-up after its submit retains runtime waiting=[], phase=reviewing and its existing driver decision. It also covers pre-submit sends, reviewer sends, notify/rebase sends and a newer submit invalidating an old follow-up.

## Added behavioral coverage

`test/repairwait.test.ts` contains 10 tests covering the six contract cases and relevant failure paths:

1. Separate sealed and pruned reproductions of #18776: candidate, review block, repair follow-up and awaiting cause no halt, Needs-you or parent wake. Real Driver cache, status and why show waiting and seal age. A foreign wake running clears the cache; wake ok without awaiting or a submit restores the same repair no-submit halt without replaying the old send.
2. Absent and empty awaiting retain the exact repair no-submit halt text.
3. Non-ok sealed/pruned writers with awaiting retain their failure halt and durable diagnostics and show no waiting display.
4. An ordinary ruling turn with a retained candidate still receives the due follow-up. Both the plan and pure policy use budget=0; candidate/block remain, awaiting suppresses the halt, waiting displays and Needs-you is empty. Clearing awaiting restores the baseline exhausted halt.
5. A writer:true ruling clears the candidate and preserves candidate-free ruling wait/no-submit halt behavior.
6. Under-review display and scheduling remain unchanged without a newer qualifying follow-up; stale or ineligible sends do not qualify.
7. Candidate repair-budget exhaustion waits without a halt while awaiting; absent/empty awaiting restores the exact exhausted halt.
8. Row8 plan invalidation and submit-reminder behavior remains unchanged.
9. Current-candidate rebase drift retains its due rebase follow-up and restores the halt when awaiting ends.

## Source budget

`git diff --stat bbf43fe -- src`:

```text
 src/activity.ts  | 3 ++-
 src/drive-run.ts | 4 ++--
 src/drive.ts     | 2 +-
 src/needs.ts     | 9 ++++++++-
 4 files changed, 13 insertions(+), 5 deletions(-)
```

Net growth is 8 lines (budget: +40), with no changes outside the authorized scope. The cache is a replaceable runtime fact. Publication/read paths, generation recovery, candidate seq/attempt/writer filtering and invalidation by a newer submit were traced. Ledger persistence, lock order, commit/rollback boundaries and the stale-generation fence remain unchanged.

## Validation and delivery

All Node/tsc/tests run on IPC through `/tmp/owed-ipc/run.sh`, using durable `--wake caller`; no tests run on the host.

- Baseline red command: `/tmp/owed-ipc/run.sh /tmp/owed-repairwait-red-bbf43fe 300 "node --test --test-reporter=tap test/repairwait.test.ts"`. Exit 1, 10 tests / 4 pass / 6 fail. Log: `/tmp/owed-ipc/logs/owed-repairwait-red-bbf43fe-132827.log`. The isolated checkout's source matches bbf43fe and its test file matches the candidate. Failures cover sealed repair, pruned repair, candidate ruling, runtime display after a new repair, repairs exhausted and candidate rebase drift. This proves the required red for contract test1/test4/the first half of test6; all four compatibility cases pass.
- Local focused IPC command: `npm run typecheck && node --test --test-reporter=tap test/repairwait.test.ts test/owriter.test.ts`. Exit 0, 34 tests / 34 pass. Log: `/tmp/owed-ipc/logs/o-repairwait-1-132828.log`, mirrored tree `e67ab629b0b63342571fd9f774710d6f2eef278b` before notes were added; source/tests are unchanged since that run. The ruling fixture now consistently uses budget=0 in both plan and pure policy; the existing writer fixture uses its current gen2 seal.
- Final checks log: `/tmp/owed-ipc/logs/o-repairwait-1-133241.log`, mirrored tree `e7aee39db875d6cc294dd2df44fa9f69b113ba5a`. Typecheck passed. The contract focused set passed 269/269. Full suite command: `node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'` (1800-second timeout; outer command 2100 seconds). Full suite result: exit 1, 1893 tests / 1892 pass / 1 fail, no cancellations or skips. The sole failure was `test/english.test.ts`, `English shipped source, skill, README and documentation`, rejecting the Chinese text in this notes file. No product/test code has changed since that run.
- The entire notes file has been translated to English, retaining scope, rulings and evidence. Follow-up IPC command: `npm run typecheck && node --test --test-reporter=tap test/english.test.ts`. Exit 0; typecheck passed and all 3 English tests passed, with no failures, cancellations or skips. Log: `/tmp/owed-ipc/logs/o-repairwait-1-141132.log`, mirrored tree `71a5fe27b11f3fb7b57849c9b6a0c24422325f57` before this result-only update. This verifies the correction for the full suite's sole failure. Per the parent's instruction, the full suite was not repeated for this documentation-only correction. Product code and tests remain exactly as validated by the final checks above. The candidate is ready for commit and `owed submit o-repairwait`; review and integration remain with the parent.
