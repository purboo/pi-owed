# o-answerstate — AR1 and R-030-AR-1

## Scope and decisions

- Node `o-answerstate`, branch `owed/o-answerstate/1`, slot base `cdb851bcb4ed2f735bd28e0b6da098ddc7b1ed53`.
- Initial candidate `8a5ea9751df668e81ccab02f1e1ae9f0cc0523dc` was blocked by review #3648. Parent ruling R-030-AR-1 (#3651) accepts both findings and defines the repair below.
- Post-delivery describe runs once per run, outside the ledger lock, bounded to 10 seconds. Results stay in runtime-only `answers: [{node,rid,qid,rev,request,state}]`; probing never resends or appends a ledger entry.
- Only the selected question's `to = <wid>/<key>` identifies the answered call. No fallback to a run address, its sole call or another key is allowed. Unknown identity reports `unknown (call not identified)`.
- Persistence inspection: `src/types.ts` AnswerRef contains only rid/qid/rev; DecisionAnswer adds node. `src/reducer.ts` rejects extra keys on both forms. Entry has no original ask kind, and `answerRule()` writes only the existing answer reference. Therefore a closed-question retry has no recorded address to recover. No ledger fields, entry kinds, reducer rules or delivery identities change.
- For an identified call, any matching question without a nonempty string qid, or a call without a string phase, reports `unknown (malformed describe reply)`. `toRunView` no longer converts non-string qids to plausible strings.
- The answered qid still open reports `asking (answer not yet taken, qid <q8>)`; a different qid reports `asking again (qid <q8>)`.
- SPEC documents these states, identity constraints and historical retry behavior. CLI/Pi tool details retain their existing shape.

## Existing test changes required by the contract

- `test/answer.test.ts`, CLI retry output: replaces the fixed resumes-now claim with `unknown (call not identified)` because closed-question history has no address. Identity and duplicate-delivery assertions remain.
- `test/answerrev.test.ts`, CLI revision output: the legacy fake omits the question address, so it also reports call not identified. Revision/request/authority assertions remain.
- `test/decide.test.ts`, multi-node delivery failure output: the successful answer contributes one state line, changing two lines to three. Exact failure retry assertions remain.
- `test/sb0221.test.ts`, SB4 output: the legacy fake has no question address, so the state is call not identified. One/two-line, other-call delivery and answer-text omission assertions remain.
- `test/dsa.test.ts`, exact RunView object: includes retained `calls: [{key:'main',phase:'running'}]`; other fields remain unchanged.

New regressions are confined to `test/answerstate.test.ts`: normal states, closed-question retry against another sole call, missing/blank/non-string qid, missing/non-string phase, same/different qid, missing question address despite a run address, call isolation, multi-node delivery, one probe per run, CLI/JSON/Pi, lock availability, unchanged ledger, single send and timeout.

## Source budget

`git diff --stat cdb851b -- src`:

```text
 src/answer.ts | 36 ++++++++++++++++++++++++++++++++----
 src/dsa.ts    |  9 +++++----
 src/ops.ts    | 17 ++++++++++-------
 src/types.ts  |  2 ++
 4 files changed, 49 insertions(+), 15 deletions(-)
```

Net +34 lines against the +60 budget. The repair adds three net source lines over the first candidate.

## Validation receipts

All Node/typecheck/tests run through `/tmp/owed-ipc/run.sh`, never directly on the host.

- Initial AR1 red on detached `cdb851b`, only the new test file copied: `/tmp/owed-ipc/logs/o-answerstate-red-cdb851b-224225.log`, exit 1, 13/13 failed.
- Parent's reproduction on `8a5ea97`: `/tmp/owed-ipc/logs/owed-review-sol-ar030-1-8a5ea97-233913.log` shows the malformed qid rendered as asking again and the retry borrowing other/queued.
- Ruling regressions on detached `8a5ea97`, only the updated test file copied:
  - Command: `node --test --test-reporter=tap --test-name-pattern='R-030-AR-1' test/answerstate.test.ts`, timeout 180 seconds.
  - Log: `/tmp/owed-ipc/logs/o-answerstate-red-8a5ea97-000059.log`.
  - Exit 1; all 8 selected tests fail, including the required missing-qid and closed-question retry cases. Mirrored tree `72e2d35ebe168cea631d8de13803fd1965c3b476`.
- Repair checks, `/tmp/owed-ipc/logs/o-answerstate-1-000247.log`, mirrored tree `8f062e47675955d61bfb9ac8ffa8d26b8a525fa5`:
  - `npm run typecheck`: pass.
  - `node --test --test-reporter=tap test/answerstate.test.ts test/answer.test.ts test/answerrev.test.ts test/decide.test.ts test/sb0221.test.ts test/dsa.test.ts`: 87/87 pass.
  - Full suite with concurrency 2: 1955/1956 pass, exit 1. The only failure was `attest-signal.test.ts:260`: the first SIGTERM exited 143 instead of retaining the escaped output pipe until the second signal. Signal code and this test are unchanged by the repair.
  - Bounded diagnosis: `node --test --test-reporter=tap --test-name-pattern='a second signal 1 s' test/attest-signal.test.ts`, five separate runs each on detached `8a5ea97` and the repair tree. All ten runs exited 0. Logs: `/tmp/owed-ipc/logs/o-answerstate-red-8a5ea97-002618.log` and `/tmp/owed-ipc/logs/o-answerstate-1-002635.log`; each records every attempt's exit code. This did not reproduce or establish the cause of the full-suite failure.
- Full-suite rerun: `node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'`, timeout 1800 seconds. Log `/tmp/owed-ipc/logs/o-answerstate-1-002723.log`, mirrored tree `9d8743523c33d13333e42a8717f70e58e0278a74`: 1956/1956 pass, exit 0, 1337.540 seconds. Source/tests are unchanged from the passing typecheck and 87-test focused run.
- Final note update contains this receipt only. Run `node --test --test-reporter=tap test/english.test.ts` after this update; record its actual log/result in the handoff without editing this note again.
- Superseded candidate evidence: `/tmp/owed-ipc/logs/o-answerstate-1-224231.log` contains passing typecheck and focused checks; `/tmp/owed-ipc/logs/o-answerstate-1-231205.log` contains 1948/1948 passing full-suite tests. These do not validate the repair.

## Handoff

Commit the repair only after its checks pass; keep the slot worktree clean. The parent owns submission, attestation and integration. Do not run `owed submit` or merge sibling branches.
