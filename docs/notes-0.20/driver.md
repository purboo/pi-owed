# Driver 0.20 (DR1–DR4)

## User-facing behavior

- Merge-ready candidates take priority over the driver's background trunk refresh and advisory sweep. While any open candidate is accepted, no new background trunk attest or sweep starts. A driver-owned trunk refresh is aborted with `trunk attest aborted: preempted`; a driver-owned sweep retains `sweep aborted: preempted`. External measurements and node attests are not killed. The merge guard still measures required invariants under the shared machine lease.
- The merge queue orders accepted candidates by the number of unique not-merged nodes that transitively depend on them, descending. Ties use the start of continuous acceptance, oldest first, then node id. `resume --after` remains a dependency wait, not a merge-priority override.
- `owed status` and `owed status --full` show `merge waiting for <reason> since <HH:MM>` using the last recorded driver busy reason. Times are UTC. For accepted nodes the progress age is time since continuous acceptance, not time since dispatch. Busy receipts are candidate/attempt scoped, survive a driver restart, and disappear after a completed measurement, replacement candidate, merge or closed attempt. A missing/corrupt runtime file is a cache miss, never evidence.
- `owed submit <node> --model MODEL` and `owed review <node> ... --model MODEL` record the actual model. `owed_submit` and `owed_review` expose optional `model: string` with the same meaning. Without an explicit model, ops inspect the recorded writer/reviewer dsa launch before recording submit/review; a status failure leaves the model absent. Dsa `calls[].model` (latest listed call) takes precedence over top-level `model`.
- `owed why` shows `writer <model> · reviewer <model>` when launch/model information exists. Unknown roles print `writer model unknown` / `reviewer model unknown`. It warns `reviewer used the writer's model` when both observed models match, and `model used <x> differs from the one selected <y>` when the launch spec's selected model is known and differs. Selected pool arrays use their first entry; opaque pool names are not resolved or guessed. These warnings never change acceptance.
- A non-prospective `owed rule` immediately inspects named nodes' current writer/reviewer launches and sends one dsa `notify` to each running/asking call. The packet is the writer ruling follow-up packet (or the ordinary ruling packet when no follow-up applies). `owed_answer` also notifies the other running roles, while its selected asking call gets the existing dsa `answer` delivery. Future/sealed/queued calls receive the rule through the existing next-dispatch/follow-up mechanism. Prospective policy is unchanged.
- Rule/answer receipts include `delivered to <n> running calls (<node>/<role>...); <m> will get it at their next dispatch or follow-up`. Failures append `; delivery failures: <node>/<role> (<rid>): <reason>`. Immediate notification uses stable request ids `owed-rule-<seq>-<rid>`, one attempt per call and no retry loop. The only durable ledger change is the rule; notifications do not acknowledge rulings or invalidate candidates on their own.

## Added fields, parameters and keys

- Ledger fields: optional `submit.model: string`, optional `review.model: string` (nonempty). No new entry kind. `launch` is unchanged by parent ruling.
- CLI flags: `submit --model MODEL`, `review --model MODEL`.
- Pi tool parameters: `owed_submit.model`, `owed_review.model` (optional nonempty strings).
- Plan keys: none.
- Runtime/private fields (not ledger fields): `RunView.model`; `.git/owed/drive/waiting.json` (or `$OWED_DIR/drive/waiting.json`) maps node ids to `{reason, since, attempt, candidate?}`. Status JSON exposes current records as `mergeWaiting`. Why JSON exposes `models` and optional `modelWarnings`. Rule result exposes optional `delivery: {delivered: string[], pending: number, failures: string[]}`; answer result exposes the same as optional `rulingDelivery`.
- A missing model field has no effect on ledger replay or obligation keys. Upgrade drivers, CLI and pi plugin together.

## Scope, deviations and concurrency

Parent DR3 ruling: do not append a second launch to retrofit actual model information. Existing submit/review receipts are populated at recording time when dsa status is available. Already-written receipts are not retroactively rewritten or supplemented; unknown models remain explicit. The driver currently asks agents to record submit/review instead of recording either itself; the shared ops path handles those calls.

Waiting-file writes have one driver owner, are atomic temp-file renames, and carry the candidate seq and attempt. Status validates those against current ledger state. Trunk refresh has its own AbortController linked to driver hard stop; only that driver-owned refresh is preempted, without aborting a merge/node measurement. Model status reads happen before the ledger lock; a changed review candidate/attempt discards stale observed model metadata before append. Notification runs after committing/releasing the rule lock and records no sends in the ledger.

`pending` counts launched non-running calls and not-yet-dispatched writer/reviewer roles that the plan actually requires, skipping merged nodes. Delivery failures are separately reported. Reviewer notifications carry the writer packet as DR4 specifies; reviewer acknowledgment remains enforced by existing review/rulings gates.

## SPEC sections affected

SPEC §12 (driver ordering, measurements, dsa run metadata and ruling delivery), §12.7 (executor/loop, preemption and busy lifecycle), submit/review CLI and pi-tool parameter documentation, status/why presentation, and the merge-order description introduced in 0.16.

## Validation and changed existing tests

New `test/driver020.test.ts`: eight behavioral tests cover weighted order/ties, merge-first scheduling, lease/internal waiting and acceptance age, trunk/sweep preemption, CLI model flags and warnings, actual dsa model recording, immediate rule notifications/failure receipts, and answer notifications.

Existing tests changed only for DR behavior:
- `test/mergeorder.test.ts`: five test cases replace old FIFO / explicit-after priority assertions with DR1 transitive weight; continuous acceptance/replay/gates remain tested unchanged.
- `test/answer.test.ts`: FakeDsa no longer treats a `notify` as answering an open question. This models DR4's informational notifications while preserving the second question/answer test.

Remote commands (no Node/npm/tsc/tests run locally):
- `/tmp/owed-ipc/run.sh /home/purboo/project/pi-things/pi-owed/.owed/wt/driver-1 900 "node --test --test-reporter=tap test/driver020.test.ts test/mergeorder.test.ts test/answer.test.ts"`: exit 0, 35/35, `/tmp/owed-ipc/logs/driver-1-012431.log`.
- `/tmp/owed-ipc/run.sh /home/purboo/project/pi-things/pi-owed/.owed/wt/driver-1 300 "node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit"`: exit 0, `/tmp/owed-ipc/logs/driver-1-012442.log`.
- `/tmp/owed-ipc/red.sh /home/purboo/project/pi-things/pi-owed/.owed/wt/driver-1 a46d7ca151ff 900 'ERR_ASSERTION|ERR_MODULE_NOT_FOUND|is not a function|SyntaxError|is not defined|Unknown|unknown' test/driver020.test.ts`: red shown, exit 1, 7/8 fail behaviorally (one existing sweep behavior passes), `/tmp/owed-ipc/logs/driver-1-red-012457.log`.
- `/tmp/owed-ipc/run.sh /home/purboo/project/pi-things/pi-owed/.owed/wt/driver-1 1800 "node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'"`: current tree exit 0, 1053/1053, `/tmp/owed-ipc/logs/driver-1-012628.log`. First run was 1047/1053 (`/tmp/owed-ipc/logs/driver-1-010455.log`); the six changed-behavior failures above were repaired, justifying this final rerun.
