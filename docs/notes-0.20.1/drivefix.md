# drivefix — 0.20.1

## Behavior

Dispatch retries compare-and-swap refusals with fresh state in the same pass, including a changed plan. It retains the existing bound of three total attempts (the initial attempt plus two retries). Each failed attempt completes the existing worktree, branch, directory and setup-exclude rollback before retrying. A failed rollback remains an error; non-CAS refusals remain errors. An exhausted CAS refusal produces a quiet `retry next pass` report, never a Needs-you notification or halt. No acceptance gate changes.

When driver measurements block a merge, ordinary and full status identify the blocking job and its start time, for example `merge waiting for driver-internal job (catalog merge, since 09:12); 2 merges ahead`. A running merge is selected as the blocker before other measurements. The count uses the existing 0.20 merge queue: unfinished transitive dependents descending, acceptance age, then id. It includes accepted predecessors even when one is currently merging and is recomputed on status reads rather than cached. Lease waits retain their existing reason and waiting-since text, with queue position added for accepted nodes.

## Public fields, plan keys and CLI flags

No new ledger fields, entry kinds, plan keys or CLI flags. Status JSON `mergeWaiting[id]` has optional `ahead: number` (accepted nodes' current zero-based queue position) and `job: string` (such as `catalog merge` or `trunk attest`, when a driver-internal measurement blocks progress). The private driver waiting cache stores `job`; `ahead` is derived from current state. Existing `since` remains the continuous candidate/attempt wait start; the time inside an internal-job reason is that job's start time in UTC.

## Compatibility

Old ledgers replay unchanged. Old waiting caches remain readable without `job` and retain their original text until the driver updates them. Older owed versions ignore the new runtime-only fields; they cannot misjudge acceptance because no ledger data or verdict rules changed.

## Checks

New `test/drivefix.test.ts` covers a real plan change from a checkout hook, bounded exhausted CAS retries and rollback, non-CAS setup failure, and a gated running merge with critical-path ordering, current queue positions and CLI status output.

Changed existing tests:

- `test/driver020.test.ts`, `DR1/DR2: accepted merge preempts driver trunk attest and shows internal wait until it releases`, now requires the DQ2 job/start-time/zero-ahead text instead of the former generic internal-jobs list. Its preemption and merge assertions are unchanged.
- `test/cas-retry.test.ts`, `N2/DQ1 rollback deletes an untouched branch before retry even when main HEAD does not contain dispatch base`, now expects the DQ1 retry after a plan change instead of the superseded immediate-refusal policy. Successful recreation of the same worktree/branch proves rollback completed; it also verifies the new packet, unchanged base and single dispatch receipt.
- `test/slotsetup.test.ts`, `SS/DQ1 a plan changed during setup discards stale setup and retries with fresh setup policy`, now expects success under the new disabled-setup policy, verifies stale outputs are removed, only one dispatch is appended, and stale setup grants no excludes.

Remote validation commands:

- `node --test --test-reporter=tap test/drivefix.test.ts`: 4 passed (log `/tmp/owed-bench/logs/drivefix-1-091843.log`).
- `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`: exit 0 on the final test tree (log `/tmp/owed-bench/logs/drivefix-1-093104.log`).
- `node --test --test-reporter=tap test/drivefix.test.ts test/cas-retry.test.ts test/slotsetup.test.ts test/driver020.test.ts`: 45 passed (log `/tmp/owed-bench/logs/drivefix-1-093019.log`).
- Base red check on `31a764d5a4d0`: 3 failed, 1 passed, assertion failures (log `/tmp/owed-bench/logs/drivefix-1-red-091915.log`).
- Initial full suite: 1108 passed, 2 failed due to the superseded plan-change refusal expectations in `cas-retry.test.ts` and `slotsetup.test.ts` (log `/tmp/owed-bench/logs/drivefix-1-091931.log`). Those expectations were updated as described above and passed in the 45-test regression run.
- Final full suite, `node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'`: exit 0, 1110 passed, 0 failed/cancelled/skipped (log `/tmp/owed-bench/logs/drivefix-1-093126.log`, 598496 ms).

## Deviations and known limits

Small interpretation: retain the pre-existing three-total-attempt bound rather than add three retries after the initial attempt; this stays within DQ1's at-most-three retry limit and avoids increasing dispatch setup costs. No product-semantic or gate deviation. `brief` keeps its existing scope; DQ2 waiting detail is available in ordinary/full status and JSON. External machine-lease blockers retain their available reason string; the structured `job` field identifies measurements owned by this driver only.
