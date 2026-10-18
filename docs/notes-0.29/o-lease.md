# o-lease — 0.29

Scope: LZ1–LZ6 of the parent contract, based on `74e5930`.

- LZ1: each driver pass compares the scheduled sweep's definition and normalized `every` policy; changes/removal abort before commit without a verdict or interruption. The runtime report retains `sweep aborted: plan changed` until another sweep starts; the committing guard remains.
- LZ2/LZ6: scheduled leases request yield, acceptance attest/merge leases request priority 10. Unknown-option refusals retry without the flag and are remembered per executable for this process. Command output cannot trigger a replay. Yield aborts measurement and follows busy retry semantics without recording.
- LZ3: commands get fresh non-keyed OWED_RUN tags; abort/timeout ends the group and scans Linux /proc for exact tags through TERM/grace/KILL/rescan, before command completion or lease release. Other platforms retain group containment; cleared tags escape. Cleanup uses a captured real timer so virtualized measurement timers cannot freeze it.
- LZ3 follow-up authorized by the parent: genesis measuring registration now spans runtime-file cleanup, closing the abort-time status gap. A deterministic delayed-unlink test proves the old gap.
- LZ4: changed existing ordering (it was not already satisfied). Sweep operation/preparation and first materialization precede acquisition; the first setup/check command captures the lease async context, which stays held until sweep/tree cleanup ends.
- LZ5: strict exit-75 last-line diagnostics become environment errors, including invariants/red; ordinary 75 remains failure. Repeated errors use existing environment backoff and do not reach the two-errors halt.

Tests: `test/olease.test.ts` adds 30 behavioral tests, covering each item and containment/fallback failure paths. The Linux abort/timeout tests check detached tagged grandchildren and lease release ordering, while a distinct exact tag survives. Normal detached exits remain unchanged. Timer virtualization and delayed activity cleanup have explicit regressions.

Existing-test change (parent authorized): `test/attest-signal.test.ts:94–98`, LZ3. `heldRun`, shared by both D16a.3 tests (60 s and 3 s), now deliberately starts its escaped pipe holder using `env -u OWED_RUN setsid sleep`. It must model an uncontained process after LZ3 starts killing tagged descendants. Assertions and time bounds are unchanged. No other existing tests changed.

Evidence so far (all commands ran remotely through `/tmp/owed-ipc/run.sh`; logs under `/tmp/owed-ipc/logs/`):

- Initial focused typecheck: `o-lease-1-162139.log`, exit 0.
- Initial required focused check: `o-lease-1-162628.log`, 138 pass / 0 fail, exit 0.
- Red on base, only new test copied: `o-lease-base-162831.log`, 27 tests / 2 pass / 25 fail, exit 1; every failure ERR_ASSERTION, including each LZ1–LZ6 item. Later unchanged-behavior and deterministic cleanup tests are additional coverage.
- First full suite: `o-lease-1-163224.log`, exit 124 at 1800 s; no completed TAP totals. 1462 top-level results, 2 failures (D16a.3 escaped holder, D24.4 activity cleanup), then slotsetup's virtualized cleanup timer hung the run. This is full-suite attempt 1/2 and is not acceptance evidence.
- Parent-required init-tool comparison: clean base `o-lease-compare-170625.log`, three runs each 11 pass / 0 fail, exit 0. Pre-fix current `o-lease-1-170625.log`, runs 11/0, 11/0, 10/1, exit 1. Fixed current `o-lease-1-172033.log`, three runs each 11 pass / 0 fail, exit 0.
- Parent-required slotsetup/snapshot comparison: clean base `o-lease-compare-170721.log`, 32 pass / 0 fail, exit 0. Pre-fix current `o-lease-1-170721.log`, exit 124 at 600 s, hung after the first 15 slotsetup results. Fixed current is covered below, without changing those tests.
- Added cleanup regressions red on base: `o-lease-compare-172033.log`, 2 tests / 1 pass / 1 fail, exit 1; delayed genesis cleanup fails with ERR_ASSERTION, ordinary virtual timeout remains supported.
- Current typecheck + focused integration: `o-lease-1-172122.log`, exit 0; 187 pass / 0 fail. Command: `npx tsc --noEmit -p . && node --test --test-concurrency=2 --test-reporter=tap test/olease.test.ts test/sweep.test.ts test/sweep024.test.ts test/lease.test.ts test/env.test.ts test/exec-red.test.ts test/drive-run.test.ts test/infra.test.ts test/nits.test.ts test/attest-signal.test.ts test/slotsetup.test.ts test/snapshot.test.ts`.

Final source acceptance commit S: `85d7129c139df2cd95a27cfc77c556d477996f81`, tree `a9c0c5090b4e2d8eb06789842d894dc0a5b5c8c0`.

Full-suite attempt 2/2 passed on clean S: `/tmp/owed-ipc/logs/o-lease-1-172505.log`, exit 0; 1820 tests / 1820 pass / 0 fail / 0 cancelled / 0 skipped; duration 1238912.431695 ms (1238.9 s, within inv:suite's 1500 s). Exact command: `node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'`. The identity header records S's exact commit/tree and dirty=0. No further full-suite runs are allowed.

The parent-required follow-up D changes only this note. After committing D, run `npx tsc --noEmit -p .` and the required leaf check (`node --test --test-concurrency=2 --test-reporter=tap test/olease.test.ts test/sweep.test.ts test/sweep024.test.ts test/lease.test.ts test/env.test.ts test/exec-red.test.ts test/drive-run.test.ts test/infra.test.ts test/nits.test.ts`) on D, require dirty=0 and matching D tree, then submit D. D identity and those clean-tree log paths/exit codes belong to the final handoff; S's full-suite evidence stays pinned above.

`git diff --stat 74e5930 -- src`:

```
 src/drive-run.ts | 22 ++++++++++++----------
 src/dsa.ts       | 25 +++++++++++++++++++++----
 src/exec.ts      | 46 ++++++++++++++++++++++++++++++----------------
 src/lease.ts     |  4 ++--
 src/ops.ts       | 29 +++++++++++++++--------------
 src/sweep.ts     | 35 ++++++++++++++++++++++++-----------
 6 files changed, 104 insertions(+), 57 deletions(-)
```

Net src: +47 lines; no size exception. No dependency on live dsa 1.1.0; fake replies/argv only. No publication or integration is performed by this writer.
