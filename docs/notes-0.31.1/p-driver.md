# p-driver — 0.31.1 PD1–PD6

Base: `590bdca9940e8e20fe1419f7d167219a2af5cfa7` (0.31.0). Ownership is limited to this leaf's allowed files. Budget: net +130 source lines; implementation is net +33. No reducer, ledger format, key, verdict or plan schema changes.

## Behavior

- Session, tool and registry attachment replay complete lines from the current log's last 256 KiB. Replay uses live revalidation, busy holding and delivery retries; existing followers retain their dedup state. Park-notice refresh and wake validation share the same state promise. CLI watch explicitly opts out of attach replay.
- CLI start/detach omit follower information when their driver result has already exited; JSON reports `followedBy: null`.
- Follower cursors retain the earliest unreported ride-along in the current inode. Stale-only batches advance, while a timeout followed by a new watch can still report `Done:`. Cursor offsets are calculated from bytes, including UTF-8 logs.
- Batch-refusal isolation updates memory before attempting the runtime file write. A save error appends its code to the original retry report instead of replacing that refusal. Existing candidate reconciliation and single-merge ordering remain intact.
- Status reads candidate-scoped isolation outside the reducer and passes matching open candidates to its pure preview. Missing, malformed or unreadable state leaves the prior preview unchanged.
- SPEC documents replay, timeout cursors, runtime isolation and watch's ledger/lock boundaries, including the possible snapshot-cache write.

## Runtime ownership and failure paths

The single driver owns `batch-isolated.json`; its existing temp-file/rename write remains atomic. Batch candidate identities are captured before asynchronous measurement, then reconciled against current state during reaping and subsequent passes. Status only reads the file and filters stale candidate identities. No ledger lock or new ledger write is introduced. Follower attachment reads only the current log; driver start retains existing log rotation and lock ownership. Delivery failures retain the pending batch and revalidate it on retry.

## Changed existing tests

- `test/drive-bg.test.ts`, D17.7/8 session-start test: PD1 replaces the old no-replay expectation with immediate delivery of the current pre-attach wake. Message counts include that replay; repeated attach, live delivery and shutdown assertions remain.
- `test/follow.test.ts`, FW2 registry fallback/throttle test: PD1 can deliver older current log lines before subsequent fallback-session events, so the assertion searches all delivered messages. Discovery after the ten-second throttle must now replay the wake written before discovery; a later live wake is still required.
- `test/surface.test.ts`, SF6 reused-start test: PD1 replaces the explicit no-replay requirement with delivery of the current idle-wait to the newly attached session. A subsequent start in that same session must not deliver it again.

All new regressions are in `test/driver0311.test.ts`. The CLI exited-path test uses Node module mocks in a subprocess to avoid an idle-driver/poll timing race. Isolation-save failure uses a directory at the destination path so rename fails even under root.

## Validation

All Node, typecheck and test execution is through `/tmp/owed-ipc/run.sh`, never on the host.

Baseline red: detached `/tmp/owed-pd-red-590bdca` at `590bdca` with only the new test copied in. `/tmp/owed-ipc/run.sh /tmp/owed-pd-red-590bdca 240 "node --test --test-reporter=tap test/driver0311.test.ts"` exited 1: 1 passed / 9 failed (10 total). Mirrored tree: `5da2f23287c7ef2ecba26b00ab6f21619feb40ab`. Failures are missing pre-attach delivery/validation, unwanted exited-driver follower text, skipped pending merge cursor, EISDIR replacing batch refusal, ignored status isolation and old SPEC wording. No fixture/import errors.

Final green checks used the same mirrored tree `6a97fd876a2ff1dd337a7a63413e29d18d613b4f` (this handoff's validation paragraph is the only subsequent change):

- `/tmp/owed-ipc/run.sh <worktree> 900 "npm run typecheck && node --test --test-reporter=tap test/driver0311.test.ts test/drive-bg.test.ts test/follow.test.ts test/mergeq.test.ts test/drive-session.test.ts test/surface.test.ts"`: exit 0; typecheck passed and 78/78 tests passed, including all 10 new regressions. Test duration 86.306 seconds.
- `/tmp/owed-ipc/run.sh <worktree> 2400 "node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'"`: exit 0, 2106/2106 passed; zero failures, cancellations or skips. Test duration 1495.309 seconds.
- `git diff --check`: passed. No outstanding failing or unrun required checks.

Logs and SHA-256:

```text
red: /tmp/owed-ipc/logs/owed-pd-red-590bdca-012924.log
4b4df2fb28ab477083fa8b0b2a222b0f5f3307cb10c30c5469c494c5f5a2c755
typecheck + node: /tmp/owed-ipc/logs/p-driver-1-013208.log
650640338315679dcef0c21366dbefb6ce5741eb48de58201b22ca42af3c4361
full suite: /tmp/owed-ipc/logs/p-driver-1-013355.log
dacc181284d4cb750ccb537f0e1e2ddf6080003f33175b36d5b93077d399dfb0
```

## Source diff against base

`git diff --stat 590bdca -- src`:

```text
 src/cli.ts       |  4 ++--
 src/drive-bg.ts  | 65 ++++++++++++++++++++++++++++++++++++--------------------
 src/drive-run.ts |  6 ++++--
 src/extension.ts |  9 ++++----
 src/ops.ts       | 11 +++++++++-
 src/views.ts     |  9 +++++---
 src/watch.ts     |  3 ++-
 7 files changed, 70 insertions(+), 37 deletions(-)
```

No submit, attestation, merge or publication is performed by this writer; the parent owns acceptance and submission.
