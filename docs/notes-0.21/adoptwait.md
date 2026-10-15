# Adopt waits (0.21, adoptwait)

`owed adopt --wait <seconds>` and `owed_adopt {wait: seconds}` override the default 60-second merge-lock wait. Seconds may be fractional and must be finite and non-negative; zero tries once. Busy retains exit 75 and tells the caller to retry. The option does not change the machine lease's own wait policy, permissions, invariant gates or trunk CAS.

Lock owner files optionally contain `activity` and `activitySince` (ISO UTC). Merge, attest, adopt and sweep holders name their operation; each measurement updates the activity, for example `merge X: measuring inv:next-tests`. Busy diagnostics append `(activity since HH:MM)` in UTC. Parallel measurements show the most recently started measurement, not an exhaustive list of running checks. The original lock acquisition `ts` stays intact.

An adopt publishes `<owed dir>/adopt-pending.json` containing `{pid, host, commit, since}` before waiting for the machine lease or merge lock. The driver starts no new merge while this request is live, leaves an already running merge to finish, and reports `merge waiting for adopt (pending since HH:MM)` in its output and status. Success, refusal, timeout and cancellation remove the marker. A dead local PID is ignored, including in status; a malformed marker is also ignored. A foreign-host request is treated conservatively as live because its PID cannot be checked locally.

A short named helper module owns marker publication and liveness checks. Concurrent adopters serialize through the `adopt-queue` lock, so one request's cleanup cannot delete another request's marker. Lock order is adopt-queue -> machine lease -> merge -> short ledger locks; no merge or driver acquires adopt-queue. Activity updates serialize per Ledger and publish owner files by atomic rename. Stale measurement results still face the existing plan/trunk/ref CAS and invariant guard.

## Plan keys and ledger fields

None. CLI flag: `adopt --wait SECONDS`. Tool parameter: `owed_adopt.wait` (number).

## Compatibility

No ledger entries, acceptance keys or replay semantics change. Older readers ignore the optional runtime lock fields and pending marker; older drivers do not yield to pending adopts. Upgrade the active driver to obtain adopt priority. Owner-file additions are runtime metadata, not ledger fields.

## Tests

New `test/adoptwait.test.ts` covers AW1 explicit/default timeout behavior, CLI/tool forwarding, invalid waits, AW2 Busy text and actual measurement updates (including a merge's nested trunk refresh across Ledger instances), and AW3 live/dead PID scheduling, status, cleanup, malformed metadata, and completion of an in-flight merge. Existing tests changed: none.

All checks ran remotely via `/tmp/owed-bench/run.sh` (red via `/tmp/owed-bench/red.sh`), never local node/npm/tsc:

- Focused: `node --test --test-reporter=tap test/adoptwait.test.ts` — 8/8 pass, exit 0; `/tmp/owed-bench/logs/adoptwait-1-092650.log`.
- Typecheck: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit` — exit 0; `/tmp/owed-bench/logs/adoptwait-1-092755.log`.
- Full: `node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'` — 1114/1114 pass, exit 0; `/tmp/owed-bench/logs/adoptwait-1-092822.log`.
- Red on `31a764d5a4d0`, candidate test overlaid — 8/8 fail, exit 1, `red=shown`; `/tmp/owed-bench/logs/adoptwait-1-red-092650.log`. Failures include missing pending publication, unknown `--wait`, absent tool parameter and absent measurement activity; no timeout/cancellation.

Focused/red preceded a TypeScript-only schema cast correction, with identical runtime behavior; typecheck and full used that final source. An earlier full run (`adoptwait-1-092509.log`) was intentionally stopped after the nested-refresh activity fix made its tree obsolete; it is not acceptance evidence.

## Deviations and limits

Small interpretation choices: fractional seconds are allowed; foreign hosts are considered live conservatively; concurrent adopts serialize marker ownership with an additional runtime lock. `--wait` applies separately to acquiring that queue lock and the merge lock, and does not impose a total end-to-end deadline on invariant measurements. A SIGKILL cannot execute cleanup; the dead-PID rule makes its marker inert. PID reuse is subject to the same PID/hostname liveness limitation as existing owed locks.
