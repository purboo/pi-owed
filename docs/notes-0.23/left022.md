# LO — local times, current driver work and quiet rulings

## User-facing behavior

- Driver merge waits store the blocking `job` and its ISO UTC `jobSince` separately from the reason. Status and why format that time in the reader's local zone with `clockTime`: `driver-internal job (<job>, since HH:MM)`, including the local date for a different day. Older cache records without `jobSince` retain their recorded reason.
- A node's own attest or merge clears its cached wait as it starts. Across consecutive busy measurements of the same node/attempt/candidate, the driver retains the first busy end in memory and restores that `since` on each busy completion, preserving cumulative wait time. A non-busy end or a new candidate resets it. Status, its progress summary and why show active driver work as `measuring (since HH:MM)` or `merging (since HH:MM)`. A job wait is visible only while that exact job remains in flight in a locally running driver; a different start time cannot revive an earlier wait.
- Adopt waits also retain their ISO pending start in the existing `since` field and format it when displayed. Driver status, lock-owner diagnostics, environment retry times, idle progress and report window headings use the same local-time formatter. JSON timestamp fields remain ISO UTC.
- CLI `owed rule` and pi `owed_rule` return `Recorded #<seq> ruling (<nodes>); delivered <k>/<n>`. The delivery count covers delivered, pending and failed role calls. Each delivery failure or unknown slot writer gets one additional line naming the node and directing the reader to `owed why <node>` for the ruling to forward. Known sealed calls remain pending without dumping their follow-up.
- Rule receipts omit ruling bodies, follow-ups, active-block quotes and the status brief. JSON and tool details retain full follow-ups as plain strings, preserving literal newlines and backslashes. Driver ruling messages use that same literal text. Why exposes a ruling follow-up for manual forwarding only when `rulingFollowUp` returns an undelivered message for the slot writer; it omits this section once delivery is recorded.

## Plan keys and CLI flags

No new plan keys or CLI flags.

## Compatibility

No ledger kinds, ledger fields, principals, acceptance gates or measurement keys change. Historical ledgers replay unchanged. `jobSince` is an optional private runtime-cache and status field, not a ledger field. Status adds optional runtime `measuring`; why adds optional runtime `measuring`, `mergeWaiting` and `rulingFollowUp`. New adopt cache records use reason `adopt` and the existing ISO `since`; old formatted adopt reasons remain readable. Upgrade readers for the new cache rendering and the concise rule receipt; scripts needing complete messages should use JSON/tool details.

## Existing test updates

- `test/drivefix.test.ts`: the queue fixture publishes a live driver lock and structured log, and expects finished-job waits to disappear immediately, as LO2 requires. A separate non-job busy wait verifies queue positions change at read time after a merge, before any driver pass updates the private cache.
- `test/drive-rulings.test.ts`: a multiline ruling in a writer message now contains the literal newline required by LO3.
- `test/ux.test.ts`: full follow-ups remain in delivery details; default delivery text contains counts and unknown-writer guidance, replacing the previous echo.
- `test/compactreply.test.ts`: a rule reply no longer echoes the ruling entry body or appends a status brief.
- `test/watchdog.test.ts`, `test/attest-busy.test.ts`, `test/notices.test.ts`, `test/measure-bg.test.ts`: framework timestamps in idle progress, lock diagnostics, driver notices and in-flight status use local time instead of raw ISO; JSON timestamp assertions remain ISO.
- `test/env.test.ts`: retry text uses local time; back-off tests verify the numeric retry boundary directly instead of parsing an ISO timestamp from prose.
- `test/driver020.test.ts`: restores the assertion that consecutive busy retries preserve `since`, per parent ruling #2551; its in-flight fixture publishes a live lock and structured log, and answer's existing delivery text is preserved.
- `test/left022.test.ts`: verifies why shows undelivered writer follow-ups and suppresses delivered/no-writer ones; attest and merge retries clear the visible cache while in flight, preserve the first busy end, and reset after a non-busy end or new candidate.
- `test/nits022.test.ts`: the running batch fixture publishes a live lock and structured log so status can verify its blocker is in flight.

## Deviations and known limits

The supplied contract is implemented without product-semantic deviations. The local-time cleanup includes report/metrics/brief headings and idle/environment diagnostics because LO1 applies to every remaining framework timestamp in default text. Structured adopt waits use existing cache fields to meet the same display-time rule. Exact job identity uses the label and `jobSince`; legacy records without that timestamp can only be checked by label. Driver activity uses the same bounded log tail and local-process liveness as `owed drive --status`; a foreign driver lock does not prove in-flight work locally. Missing or corrupt private wait caches remain diagnostic cache misses and never affect acceptance.
