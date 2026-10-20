# o-follow — 0.31 FW1–FW4

Base: ebf090b83644c4bb170802b97053bc17cd09a910. Budget: +230 net src lines.

## R-031-FW-2 repair

Repair base: ea2241401f5bf82c44c3bfc7ac5fddc4f968af6b (parent-rebased o-follow).
A bare byte offset could skip the beginning of a restarted driver's log when
that new log was already longer than the old offset. The CLI now emits an
`offset:ino` cursor in its next line and JSON next field. Follower supplies the
inode associated with its actual read offset, not a new stat of the log path.
An inode mismatch resumes at zero; matching inodes and legacy bare offsets keep
their existing behavior, including the shorter-log reset. Only CLI callers pass
an expected inode, so session followers retain their current behavior. A missing
log identity uses inode 0; no-driver output still has no next line. No runtime or
ledger file is written by watch.

The follow.test.ts regression saves a cursor, renames log.jsonl to log.jsonl.1,
and writes a new log at least as long as the old offset with a wake in its first
bytes. The same test on the repair base uses its emitted bare cursor and exposes
the skipped wake; the repaired version emits the inode cursor and delivers it.
The FW4 cursor assertions now expect strings; malformed cursor tests require the
`<offset>[:<ino>]` usage message. Legacy numeric resume and same-inode truncation
are covered. No deferred registry-attach/repeat-line finding or review nit is
changed.

Only the HELP placeholder changes, from `--after OFFSET` to `--after <cursor>`.
Its registered literal digest changes from
`3d66e4793d66d3b17e4e6fc457e77f3f3b32864993a01b8e3f7002517afc3d7d` to
`d3e2fb9861bf045cd5c93ab215a9a7690d821976ecd016031b6f3a4c591b25fb`.
The next-line template text is unchanged and its digest is unchanged.

Repair validation (all through `/tmp/owed-ipc/run.sh`):

- Red: `node --test --test-reporter=tap --test-name-pattern=R-031-FW-2 test/follow.test.ts`
  on ea22414 with only the test file copied into a scratch worktree. Exit 1,
  0/1 passed. It reached the resumed watch and observed exit 5 (`no wake within
  0 s`) instead of exit 0: the wake was skipped. No import or fixture failure.
  Log: `/tmp/owed-ipc/logs/owed-fw2-red-ea22414-104121.log`.
  Test tree: `f4b0d7672224845afe38030be1e1c55842225bb0`.
- Green: `npm run typecheck && node --test --test-reporter=tap test/follow.test.ts test/cli.test.ts test/needs-structure.test.ts test/drive-bg.test.ts`.
  Exit 0, typecheck and all 39 tests passed.
  Log: `/tmp/owed-ipc/logs/o-follow-1-104126.log`.
  Test tree: `255088edab4f54299ffba414d711748bd07e0817`; only this note changed
  afterward. The final commit's o-follow plan check runs once after committing;
  its result is returned in the parent handoff. No submit or attestation.

Repair source diff, `git diff --stat ea22414 -- src`:

```text
 src/cli.ts      |  9 +++++----
 src/drive-bg.ts | 14 ++++++++------
 src/watch.ts    | 16 ++++++++++++----
 3 files changed, 25 insertions(+), 14 deletions(-)
```

Net +11 source lines for this repair.

## Original leaf scope

Scope: attach the driver follower after every top-level tool operation (including
refusals); discover drivers by session through a best-effort runtime registry;
explain CLI start followership; expose the existing revalidating follower as
`owed watch` with a byte cursor. No ledger schema, key, verdict or reducer change.

R-031-FW-1 (ruling #3710, plan #3709) adds narrow ownership of src/drive-run.ts,
src/ext-worker.ts and src/registry.ts. The existing lock.session and dsa run
session remain DSA_SESSION. Registry.session uses that value, falling back to
PI_SESSION_ID outside dsa calls. The extension uses context session identity,
then DSA_SESSION, then PI_SESSION_ID. Worker transport only adds the context
identity; its timer and ensureReachable are unchanged. Driver changes are confined
to acquiring/releasing the lock, with no merge or batch changes.

Registry writes happen after exclusive driver lock acquisition; registration is
atomic rename. Both async and synchronous lock releases unregister the same
serialized owner. Stale registrations are ignored rather than deleted by readers,
so a stale reader cannot unlink a successor's registration. Missing, malformed,
unreadable, dead-pid and reused-pid registrations do not attach. Registry failures
never change the driver/tool result. Detached calls remove inherited PI_SESSION_ID
alongside the existing DSA_SESSION suppression. No additional lock order is added.

Watch delegates to DriveWatch/Follower.step with the existing ledger/dsa
revalidator and no busy hook. Default attach, pending batches, repeat handling,
rotation and terminal revalidation remain shared with the session follower.
The CLI-only followedBy field leaves tool text and details unchanged.

## Changed existing tests

`test/drive-bg.test.ts`, D17 (A): FW3 appends the followership line after the
existing inside-dsa-call note. The test now requires the original note followed
by the no-session note, rather than requiring the original note to be the last
line. Its top-level-start assertion excludes the inside-dsa-call note specifically;
it no longer excludes FW3's required no-session note. All environment isolation
assertions remain unchanged.

`test/asks026.test.ts`, both successful AK6 restart tests: FW3 adds one CLI
followership line to the original three-line output. Both tests allow four lines
and require the final followership line; restart, graceful exit, reuse and ledger
assertions are unchanged.

`test/surface.test.ts`, SF2 CLI fresh start, genesis/max dispatch, and latest-plan
reread tests: a CLI-specific helper requires and removes the final FW3 line before
applying the existing three-line compactness assertion. The owed_start tool test
still uses the unmodified three-line helper, as required by FW3.

`test/needs-structure.test.ts`, PR2 exact-site inventory: FW4 changes the CLI HELP
literal; update its exact digest, add `watch` to the command scanner, and register
the three exact watch.ts guidance literals (no-driver initialization, no-session
followership and next byte cursor). No file/function-wide exceptions or skipped
checks. All new behavior tests remain in test/follow.test.ts.

## Original leaf validation

- Baseline ebf090b with only test/follow.test.ts copied: IPC command
  `node --test --test-reporter=tap test/follow.test.ts`, exit 1, 11 tests,
  9 failed / 2 passed. Log: `/tmp/owed-ipc/logs/owed-o-follow-red-031-081824.log`.
  The failures are the absent cross-repository ask/refusal follow, absent registry
  creation/session discovery, absent CLI follow text and unknown watch option;
  no import or fixture failure. Baseline copy tree:
  `88c59db5f61c5a421ccc954dc96a5cd9174d76a9`.
- IPC typecheck passed on tree `a065bf631a31883533631f4d26f659337a4827ed`;
  the seven-file check had 75/76 passes, with all 11 new tests passing. The only
  failure was D17 (A)'s old last-line assertion described above, now corrected.
  Log: `/tmp/owed-ipc/logs/o-follow-1-081926.log`.
- IPC typecheck and specified seven-file check passed (76/76) on tree
  `e164f2ab85418de3288a127328ce45687e2769fc`.
  Log: `/tmp/owed-ipc/logs/o-follow-1-082226.log`.
- Full suite on the same tree ran to completion, exit 1, 2034/2040 passed.
  Log: `/tmp/owed-ipc/logs/o-follow-1-082411.log`. The six failures were the
  five legacy CLI three-line bounds and PR2 literal inventory described above;
  those test expectations are now updated for FW3/FW4. No source changes since
  the passing typecheck and seven-file check.
- Final IPC typecheck and affected-file check passed, exit 0, 40/40:
  `npm run typecheck && node --test --test-concurrency=2 --test-reporter=tap test/asks026.test.ts test/surface.test.ts test/needs-structure.test.ts`.
  Log: `/tmp/owed-ipc/logs/o-follow-1-084839.log`.
- Final full suite passed, exit 0, 2040/2040, no skipped/cancelled tests:
  `node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'`
  (IPC timeout 1800 s, elapsed 1406.24 s).
  Log: `/tmp/owed-ipc/logs/o-follow-1-085013.log`.
- Both final runs tested tree `134d0887591d411387a64a2b38e9578c2d9ed2ce`.
  Only this validation note was updated afterward; source and test blobs are
  identical to that tested tree. The seven-file check command was
  `node --test --test-reporter=tap test/follow.test.ts test/drive-bg.test.ts test/drive-session.test.ts test/notices.test.ts test/tool-worker.test.ts test/extension.test.ts test/cli.test.ts`;
  those files and all source blobs are unchanged since its 76/76 passing run.
- No checks ran on the host. No submit, merge, publication or deployment was
  performed; the parent owns submission and acceptance. No unmet FW criterion.

## Source diff

`git diff --stat ebf090b -- src`:

```text
 src/cli.ts        | 23 ++++++++++++++++-------
 src/drive-bg.ts   |  7 +++++--
 src/drive-run.ts  | 10 ++++++----
 src/ext-worker.ts |  9 +++++++--
 src/extension.ts  | 25 +++++++++++++++++--------
 src/registry.ts   | 44 ++++++++++++++++++++++++++++++++++++++++++++
 src/watch.ts      | 31 +++++++++++++++++++++++++++++++
 7 files changed, 126 insertions(+), 23 deletions(-)
```

Net +103 source lines; below +230. No package version, README, skill, ledger,
reducer or schema edits.
