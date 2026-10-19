# o-remeasure — RM1–RM2, base 1e8540a

Current state: implementation and the review #3534 fix are complete; all specified IPC checks passed. The writer only commits and does not run `owed submit`, attest or merge.

## Current scope and behavior

- `src/drive.ts`: the latest current-attempt `resume.remeasure` permits attribution of an active current-key execution block whose failure precedes that resume, before repair. One non-error attribution consumes the remeasurement for that block. Setup retry, environment back-off, the two non-environment error halt, fail/repair and pass/flaky paths remain in use. The review fix did not change this file.
- `src/ops.ts`: replies use the latest non-error observation on the current candidate key and each block's own key/state to select the already-failed line, without relying on the aggregate `item.mark`. When the current key has no active block and its latest non-error observation is fail, the reply cites that failure's seq. Active lines describe only blocks preceding the current attempt's latest remeasure resume.
- The `resume` reply uses the actual `entries` returned by append, obtaining the state after append through `reduceFrom(latest.state, entries, latest.lookup)`. This ensures the helper sees the resume seq actually written to the ledger. Append contents are unchanged.
- `docs/SPEC.md`: distinguishes decide/resume check attribution from direct attest invariant remeasurement.
- `test/remeasure0292.test.ts`: 10 tests in total; the review fix added only two regression tests, leaving the existing 8 tests unchanged.

## Review #3534 and the parent's ruling

Reproduction: K1 #4 fail → #6 attribution pass leaves a flaky block; current K2 #8 fail → #10 attribution fail has been cleared. The aggregate item displays `⛔`, and the previous implementation incorrectly reported nothing to remeasure. The fix emits the already-failed line using K2's latest non-error fail #10; a subsequent ordinary error does not hide that failure.

The parent verified and approved the minimal call-site correction: decide already used a final state containing the new resume, whereas resume passed latest.state from before append. Correct only that resume reply call, and filter blocks in the helper by the current attempt's latest resume seq; use the actual returned entries rather than regenerating seq values. Append contents, RM1, the reducer, wording, existing tests and PR2 registration must remain unchanged. The review fix follows that ruling in full.

New regression tests:

1. Mixed keys: a flaky older key must not hide the reply for an attributed failure on the current key; a subsequent ordinary error must not change the latest non-error failure seq used in the reply.
2. Second resume: a new block after the first resume is outside that older resume's authorization; the second `resume --remeasure` reply and the driver must use the new resume and include that block. Reply generation appends no observations.

## Cumulative existing-test changes and reasons

All changes below came from the preceding commit `500c744`; the review fix changed no existing tests or assertions:

- `test/wais027.test.ts`, WF5 for an active merge-check: RM2 requires the reply to state the failure seq, measurement before repair and accept-risk command.
- `test/wais027.test.ts`, WF5/RM2 for an already-flaky block: RM2 requires nothing to remeasure when there is no failed invariant or active/failing check.
- `test/needs-structure.test.ts`, PR2 registry: registers only the two exact command literal SHA-256 sites mandated by RM2, classified as diagnostic examples with a reason. The scanner and all negative tests are unchanged. Wording did not change in the review fix, so registration did not change.

## Source budget

`git diff --stat 1e8540a -- src`

```text
 src/drive.ts | 15 +++++++++++----
 src/ops.ts   | 26 +++++++++++++++-----------
 2 files changed, 26 insertions(+), 15 deletions(-)
```

Net +11 lines, below the +60 per-leaf limit. No new entry kind, API, helper, export, CLI flag or need selector. The review fix's source changes relative to `500c744` are confined to `src/ops.ts` (8 insertions, 7 deletions).

## Current IPC validation evidence

All Node/typecheck/test execution used `/tmp/owed-ipc/run.sh`; none ran on the host. Final durable run: `01M5A0J4WDSJ4YTC8V2QXNGBCY`.

- Review red-test baseline: detached `/tmp/owed-rm0292-reviewfix-red-1`, HEAD `500c744694c602d6a033c9fb308b0fc7b7c3b4fe`, with only the updated regression test file copied in; tree `d7cd12331d6d8f984010615b22f9998828c713d6`.
- Red-test command: `node --test --test-reporter=tap --test-name-pattern="RM2 review:" test/remeasure0292.test.ts`. Exit 1, both new regressions failed (0 pass / 2 fail): the mixed-key incorrect reply and the older resume incorrectly authorizing a newer block. Log: `/tmp/owed-ipc/logs/owed-rm0292-reviewfix-red-1-200043.log`.
- Current tested tree: `905dff7d57e076618dcade082ec3d4d0e18ece49`; src subtree `1f6f499adbc8d3280b3b5bd575d32bed135bbc58`.
- `npm run typecheck`: exit 0. Log: `/tmp/owed-ipc/logs/o-remeasure-1-200047.log`.
- Node check command: `node --test --test-reporter=tap test/remeasure0292.test.ts test/remeasure.test.ts test/wais027.test.ts test/infra.test.ts test/drive.test.ts test/reducer.test.ts test/decide.test.ts test/resume.test.ts`. Exit 0, 129 pass / 0 fail. Log: `/tmp/owed-ipc/logs/o-remeasure-1-200113.log`.
- `node --test --test-reporter=tap test/needs-structure.test.ts`: exit 0, 5 pass / 0 fail, including all negative checks. Log: `/tmp/owed-ipc/logs/o-remeasure-1-200140.log`.
- The first review validation exposed a new fixture error: appending an attribution error for an already-cleared block violated ledger validation. After changing it to an ordinary error, the specified chain above was rerun. The production fix did not change as a result. The old log `/tmp/owed-ipc/logs/o-remeasure-1-195944.log` (128 pass / 1 fail) is superseded by the current evidence.
- Only this note was updated after the final checks; source and tests match the tested tree.

## Previous milestone evidence and current limitations

- Original `1e8540a` with the first 8 regression tests: 7 fail / 1 pass. Log: `/tmp/owed-ipc/logs/owed-rm0292-red-1-192359.log`.
- The previous commit's full suite: 1913 pass / 1 fail; the only failure was PR2 registration missing the new RM2 literals. Log: `/tmp/owed-ipc/logs/o-remeasure-1-192456.log`. Its src subtree was `0984ddce830294c1ea214789556aebbdf11bfb6d`.
- The parent previously approved reuse of the remaining full-suite results for the same src subtree; after registration, typecheck and all 28 focused checks passed. Log: `/tmp/owed-ipc/logs/o-remeasure-1-194924.log`.
- The review fix changes the src subtree; the previous full suite is not claimed to be fully passing evidence for the current tree. The parent explicitly ruled that this review fix requires no full-suite rerun, limiting acceptance to the new red tests, typecheck, node check set and needs-structure, all of which are complete.
- No check or external job is running; no submit, attest, merge or publication was performed.
