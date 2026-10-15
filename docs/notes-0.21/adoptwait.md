# Adopt waits (0.21, adoptwait; ruling #2090)

`owed adopt --wait <seconds>` and `owed_adopt {wait: seconds}` set one total acquisition budget (default 60 seconds). Seconds may be fractional and must be finite, non-negative and within the supported timestamp range. Zero makes a non-waiting acquisition attempt. Busy retains exit 75 and tells the caller to retry. Permissions, invariant gates and trunk CAS are preserved.

The budget starts at entry to adopt. An async deadline context covers nested Ledger instances: merge and final ledger acquisition each use only the remaining budget, including the default path. Machine lease acquisition uses the same deadline; timeout cancels the queued holder and returns Busy. Once a lease is granted, measurements retain their own configured execution timeouts; elapsed measurement time still consumes the budget available for subsequent lock acquisition. A free lock can be acquired with zero remaining wait. There is no `adopt-queue` lock.

Lock owner files optionally contain `activity` and `activitySince` (ISO UTC). Merge, attest, adopt and sweep holders name their operation; measurements update the activity, including nested trunk refresh across Ledger instances, for example `merge X: measuring inv:next-tests`. Busy diagnostics append `(activity since HH:MM)` in UTC. Parallel measurements show the most recently started measurement. The original acquisition `ts` stays intact.

Before waiting for the machine lease or merge lock, each adopter publishes `<owed dir>/adopt-pending/<host>-<pid>.json` with `{pid, host, commit, since, until}`. `since` is the adopt's start and `until` is start + total wait budget + 60 seconds. A missing, malformed or elapsed `until` makes a marker stale on every host. Before expiry, local PIDs must also be alive; foreign PIDs are not probed. Old singleton markers without `until` are ignored. Directory entries are read independently, so a removed or malformed marker does not hide another live one.

The driver yields new merges while any marker is live and names the oldest live marker in `merge waiting for adopt (pending since HH:MM)`. It lets an in-flight merge finish. Success, refusal, timeout and cancellation remove the adopter's marker. Distinct processes publish independent files and compete for the merge lock normally. Tool calls sharing a PID retain the oldest request in that PID's file; brief in-process publication serialization and request ownership prevent one call from deleting another's marker. On expiry/completion the next live same-PID request is revealed; a bounded timer cannot recreate a completed publication group.

Lock order remains machine lease -> merge -> short ledger locks. Marker publication acquires no operation lock. Activity and marker updates use atomic rename. Existing stale-state/CAS checks continue to guard ledger writes.

## Plan keys and ledger fields

None. CLI flag: `adopt --wait SECONDS`. Tool parameter: `owed_adopt.wait` (number). Runtime metadata adds `activity`/`activitySince` to lock owners and `until` to per-process pending markers.

## Compatibility

No ledger entries, acceptance keys or replay semantics change. Older readers ignore the optional runtime fields; older drivers do not yield to these per-process markers. Upgrade the active driver for adopt priority. Crashed adopters cannot execute cleanup, but local dead-PID detection or the cross-host expiry makes their files inert.

## Tests and ruling acknowledgment

Writer applied ruling #2090 in full; review must acknowledge #2090 through the normal rulings gate. `test/adoptwait.test.ts` has 13 behavioral cases through CLI, tool, ops, driver and status. The original eight cases were updated for the ruled marker layout and expiry; no other existing tests changed. Five added cases cover expired foreign/missing-deadline markers and oldest selection, two concurrent CLI adopters with 600 ms budgets, a shared default deadline across merge/ledger locks, bounded machine lease acquisition with holder cleanup, and abort ownership for overlapping same-PID tool requests. Success/refusal/abort cleanup remains covered.

All execution checks ran remotely through `/tmp/owed-bench/run.sh` and `/tmp/owed-bench/red.sh`; no node/npm/tsc/tests ran locally. Receipts against the final repair source:

- Focused `node --test --test-reporter=tap test/adoptwait.test.ts`: 13/13 pass, exit 0; `/tmp/owed-bench/logs/adoptwait-1-095824.log`.
- Typecheck `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`: exit 0; `/tmp/owed-bench/logs/adoptwait-1-095723.log`.
- Full `node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'`: 1119/1119 pass, exit 0; `/tmp/owed-bench/logs/adoptwait-1-095916.log`.
- Red on slot base `31a764d5a4d0`, candidate test overlaid: 13/13 fail, exit 1, `red=shown`, no cancelled/timed-out tests; `/tmp/owed-bench/logs/adoptwait-1-red-095816.log`.

## Deviations and limits

No product deviation from #2090. Small implementation choices: fractional seconds are accepted; same-PID callers share their specified PID pathname with request-aware publication; a measurement's own timeout is unchanged. PID reuse remains subject to the existing local PID/hostname liveness limitation, now bounded by marker expiry on every host.
