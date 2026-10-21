# Compatibility and upgrade order

Read before upgrading, running mixed readers or enabling new fields. Return to the [core](../SKILL.md) for the loop and hard rules. [SPEC compatibility](../../../docs/SPEC.md#compatibility-020027) gives the complete public contract.

## Current release: 0.31.2

Plans and ledger formats are unchanged from 0.31.1; no new ledger kind, field, enum or plan key is added. CLI `DSA_SESSION`-first identity and the existing driver lock representation are unchanged. Dsa requirements remain >= 1.0.27 for the driver, >= 1.1.0 for durable-writer waits and lease options, and >= 1.2.0 for structured asks. Per-version snapshots rebuild on first use of 0.31.2; old snapshot bytes are not reused.

Restart upgraded drivers and pi sessions for owner-only automatic notifications. Only the owning pi session attaches automatically, including on resume and discovery across repositories; opening the same repository, querying owed or reusing a foreign driver does not subscribe or transfer ownership. Pi tool starts use validated current context identity; when unavailable they fall back to validated `DSA_SESSION`, then validated `PI_SESSION_ID`. An invalid supplied context identity does not fall back. Missing identity or unknown ownership never broadcasts. The lock's session wins; legacy PI-only registration is accepted only for the exact matching live driver. Sessions inside dsa calls never attach automatically. `owed watch` remains explicit observation without ownership transfer or cursor changes; an absent owner is not taken over automatically. Same-session attachment can still replay current wakes from complete lines in the last 256 KiB. This release does not change historical `Done:` labeling, replay boundary handling or memory behavior.

## 0.31.1

Plans and ledgers from 0.31.0 replay unchanged; snapshot caches rebuild on first use; no new ledger kinds or fields. `check try --record` stores ordinary informational `note` entries. New options `--run`, `--min-tests`, `--timeout`, `--record` and `--for` need the 0.31.1 CLI/tool surface. `--min-tests` and `--timeout` apply only to `--run` (defaults: one required test and 900 seconds). Snapshot format and validation stay unchanged, but each version uses `snapshot/state-<version>.v8`; legacy `state.v8` is no longer read, costing one cold replay on first use. Cleanup keeps the current snapshot plus the two newest other files, best effort. Restart upgraded drivers/pi sessions for attachment replay and runtime behavior. Dsa minimums remain unchanged from 0.31.0.

## 0.31.0

Plans and ledgers from 0.30.0 replay unchanged; no new ledger kinds or fields. New reviewer launches default to the packaged `owed-reviewer`; explicitly set global or node `drive.reviewer.agent` to keep a custom profile. Recorded launches keep their agent. Accepted attempts waiting to merge no longer consume `max`, but count toward the `2 × max` open-attempt cap. Driver batch isolation survives restarts. Restart upgraded drivers/pi sessions for the runtime behavior; `owed watch`, `owed edit --drive` and acknowledgment lists need the 0.31 input surface. Dsa requirements remain unchanged: >= 1.0.27 for the driver, >= 1.1.0 for durable-writer waits and lease options, >= 1.2.0 for structured asks. Earlier incompatible features below keep their upgrade requirements.

## 0.29.0

No ledger format, entry kind, entry field, enum value or plan key changes from 0.28.0. Old ledgers and snapshots replay identically; version-bound disk snapshots are rebuilt on upgrade. The new durable-writer wait/seal and yield/priority lease paths need pi-durable-subagents >= 1.1.0. Older dsa omits wait/seal facts and keeps 0.28 writer-wait behavior; confirmed unknown `--yield`/`--priority` options fall back once per option/process, never rerunning a measured command. Held-ruling display, quotes, plan-change sweep aborts, tagged cleanup, lease-output classification, probe applicability and housekeeping do not require that dsa upgrade. Restart drivers/sessions to use the new runtime routing and displays; earlier incompatible entries below still require their upgrade order.

## 0.27 quarantine and display fields

No ledger entry kind is added. New plan keys are `quarantine_sets` and check/invariant `quarantine_set`; optional entry fields are `obs.quarantine_passed`, `waive.tracked_by` and `ignorable`. Field-free historical ledgers and checks without sets retain their states, definitions and keys.

Checked against `v0.26.0`:
- `src/plan.ts`, `parsePlan`: **ignores**, rather than refuses, both quarantine-set keys. It copies neither and has no unknown top-level/check-key rejection. This is not compatible policy enforcement: old executors omit shared names from keys/behavior, old plan writes can discard them, and recorded 0.27 measurement keys can later cause old replay to refuse.
- `src/reducer.ts`, `OBS_FIELDS`/`newerEntry`: refuses `obs.quarantine_passed` with code `version`, including marked observations.
- `src/reducer.ts` and `src/identical-acts.ts`: ignore extra `waive.tracked_by` and `ignorable` on waive; old views cannot track/settle debt and old retry comparison cannot distinguish tracker changes. Waiver gate effects remain unchanged.
- `ignorable`: `newerEntry` refuses it with `version` on rule/obs/defer/abandon/hold/resume. Strict validation refuses it as an ordinary invalid entry on escape, decoy-commit/reveal, adopt, launch, send, halt, evidence and sweep; grant/refresh have separate unknown-field refusals. Permissive kinds ignore it. Readers before 0.27 still refuse it where they refuse unknown fields; no marker can retrofit those readers.
- `OWED_QUARANTINE_FILE` is runtime environment, not a ledger field. 0.26's `src/exec.ts` neither delivers nor consumes it and does not remove inherited values. Upgrade executors/wrappers for per-run plan delivery; containers need access to the host file.
- `attest --probe-trunk [--check ID] [--runs N]` needs 0.27 CLI support; 0.26's `src/cli.ts` refuses these options. Existing `obs`/`probe:"trunk"` replay in 0.26 unless the observation carries new optional fields. The pi attest tool has no probe parameters: use CLI. `--tracked-by` and waive `--full`/tool `full:true` likewise need the current input surface.

**Upgrade every reader to 0.27 before the first 0.27 writer records shared quarantine policy, `obs.quarantine_passed`, `waive.tracked_by` or an entry carrying `ignorable`:** upgrade CLI, every driver and every pi session loading owed, restarting drivers/sessions; upgrade result consumers and executors too. Feedback is automatic even on existing own-quarantine plans: finish before any 0.27 executor measurement (attest, genesis/trunk, merge, adopt or probes), not merely before enabling sets or merging. Never strip fields or rewrite receipts for old readers. Once all readers understand `ignorable`, they honour every listed unknown display field; the writer registry is not a reader whitelist. Plan keys and nested shapes have no such extensibility guarantee.

## 0.26 setup and runtime recovery

No new ledger entry kind or plan key is added. Optional `obs.infra` names the immediately preceding setup failure resolved by a qualifying counted same-key pass. Field-free historical ledgers retain their states and keys. A 0.25 reader (`src/reducer.ts`, `OBS_FIELDS`/`newerEntry`) refuses the entire ledger with `version` when this field first appears. Its existing `auto_remeasure` validation also refuses a receipt authorized only by the new setup predicate, even if the retry never records an infra pass; that is an ordinary invalid-entry refusal.

**Upgrade every reader to 0.26 before the first 0.26 writer records `obs.infra` or a setup-only automatic retry:** upgrade the CLI, all drivers and every pi session loading owed, restarting drivers/sessions, before allowing any 0.26 executor measurement (attest, genesis/trunk, merge or adopt). This is automatic behavior, not an opt-in plan policy; upgrade before the first incompatible write, not merely the next merge. Never strip receipt fields to accommodate old readers.

Runtime/result additions do not enter the ledger:
- `status.runtimeWarnings` and metrics `infra: {total, byObligation}` are ignored by 0.25's view/metrics renderers; warning arrays can hold additional diagnostic strings. Metrics count one pairing receipt, not every setup predecessor it resolves.
- Amend preview/result `covered: [{path, entry}]` and decision per-node `covered` are unknown to 0.25. No-op amendment results omit `plan`/`rule`; 0.25's amend renderer/CLI assume those entries exist and cannot consume that shape. No-op decisions omit `plan` too. Upgrade API/result consumers rather than treating absent entries as recorded writes.
- Driver lock optional `max` is runtime metadata ignored by 0.25's lock readers; old locks fall back to plan `drive.max` in dispatch diagnostics.
- Optional ruling-delivery `finished: [{node, writer}]` is runtime result data. 0.25's `src/answer.ts` ignores it and renders counts/failure/unknown-writer lines without the new finished-call notice. `RunView.result` already exists in 0.25's `src/types.ts`; its `src/dsa.ts` drops final text for pruned runs, whereas 0.26 retains it when supplied. Stopped-writer HEAD/dirty inspections are runtime inputs; old ledger replay and stored message retry bytes are unchanged. Restart an upgraded driver to obtain the new routing.
- `drive.lock.stop-request` is not a ledger entry. 0.25 stop clients ignore it and signal on each call, so use only 0.26 clients for safely repeatable graceful stops/restarts.

`--restart`, `report --cost`, `--version`/`version` and `--full` on rebase/candidate attest need the 0.26 CLI; 0.25 refuses those new command inputs. `ack_rulings:"latest"` needs the 0.26 CLI/extension but records a number readable by 0.25. The start tool's optional `restart` is input, not plan data; the old extension does not declare it or perform a restart. Ready/ask text, refusal recovery and unrelated-node batch-plan changes add no gate/key metadata. Full checked 0.25 source details are in SPEC Compatibility.

## 0.25 start and tool surface

No new ledger entry kind, plan key, acceptance gate or measurement key is added. Genesis entries made by start may carry optional `path`, recording their plan source. A 0.24 reader ignores it: its reducer neither validates unknown genesis fields nor consumes this one. Historical genesis without `path` remains valid; omitted-plan start requires an explicit source when the latest genesis/plan has none. No reader upgrade-before-write order is needed for this field.

`owed start` / `owed_start` needs a 0.25 CLI/extension; restart pi after installing it. New result fields `initialized`, `updated`, `plan`, `warnings`, `driver` and optional driver `alreadyRunning` are runtime data, not ledger fields. Older drive consumers ignore unknown result fields and cannot request the new reuse behavior; low-level drive start still refuses a live driver. Batch merge results may also carry optional current-key `deferred` per member: the 0.24 CLI ignores that property and retains its old output, without any ledger replay change.

The existing omitted `drive.answer_grace_s` now defaults to 600 seconds instead of 900. Explicit values retain their meaning; a 0.24 driver without a value uses 900, so upgrade/restart it for ten-minute notices. Receipt JSON, state and evidence keys stay unchanged. Tool exposure/discovery is host metadata; unsupported discovery falls back to direct tools.

## Coverage, risk and sweeps

Upgrade every reader to at least 0.24 (CLI, every driver and every pi session loading owed, with drivers/sessions restarted) before a sweep records a confirmed boundary/automatic escape, before the plan sets `sweep.every`, or before it sets `risk`/`closure_neutral`.

Older readers refuse `sweep.boundary` and `escape.sweep`; 0.23 rejects nested `sweep.every` and cannot read a ledger using that plan. It ignores top-level `risk`/`closure_neutral`: an old merge below a raising risk policy makes new replay refuse the entire ledger; a new merge relying on a lowering policy can make old replay refuse the entire ledger. Neither direction is safe. Only `closure_neutral` alone is conservative: old executors require closure-review on new closure-changing submits, while replay retains recorded facts.

## Decisions, clean rebases and leased measurements

Upgrade CLI, driver and every pi session loading owed to at least 0.23, restarting sessions/drivers, before decisions, executor rebases or the first leased measurement. Leasing is on by default, not just for driver actions. Readers through 0.22 ignore writer `facts.carry` conservatively (new review if its key changed), refuse executor `facts.rebased` submits as an ordinary invalid entry, and readers from 0.13 refuse observations with `lease_wait_ms` as version errors (older merge readers ignore that field). Decision groups, rule `answers`, shared-only automatic retries and executor defers under `allow[].defer` require upgraded readers too.

## Batches, writes patterns and wrappers

Upgrade every driver, CLI and pi plugin to at least 0.22 before enabling `drive.merge_batch`, manually batching, using writes globs/`waits_on` or enabling `remeasure_on`. Older readers can misjudge guards, interpret globs literally or refuse fields. Existing ledgers retain their recorded writes dialect; new plan recordings opt into syntax 2 without rewriting history.

String-template `exec.wrap` and `wrap_grace_s` require 0.22 readers. Legacy argv/absent wrappers retain old keys and behavior. Historical field-free writes observations remain valid without inferring grant refusals from note text; readers rejecting unknown observation fields must upgrade before recording `grant_refused`.

## Earlier optional fields

- `on_timeout` and `drive.same_model`: upgrade executors, drivers, CLI and pi plugins together; older readers ignore diagnostics, reject the model key or retain obsolete text. Untagged failure signatures replay but never equal new `v2|` signatures, including defer carry.
- Quarantine, templates, submit/review models and remeasure metadata need coordinated readers. No new entry kind was added for those features; older releases can ignore, misread or refuse them.
- `grant` entries need 0.17 readers. Historical grant-free ledgers retain their keys/states.
- Re-ask answer rules carry `supersedes` naming the latest prior lower-revision answer. Upgrade every reader to at least 0.16 before recording one; 0.15 refuses with `version`. `slot_setup` also needs 0.16 to take effect; 0.15 ignores it and runs no slot setup, changing no acceptance key.
- Hold entries and `resume.release` require 0.14; 0.13 refuses them. Prospective rulings also need 0.14; older readers refuse that field. `--prospective` never combines with `--writer`.
- Trunk refresh and structured observation `execution` need 0.15. Known-red lists are ignored by 0.14 and older (stricter); upgrade together before relying on them.
- Trunk probes need 0.14: 0.13 refuses `obs.probe`, still older readers ignore it unsafely. Merge-key waiver scope also needs 0.14.
- Candidate `limits` require 0.14 to enforce; older readers ignore them. Limits add no keys or candidate invalidation.
- Repeated checks need 0.13 executors/readers: 0.12 silently drops repeat and ignores per-run metadata. Resume lists/`expect`, answer rules, sweep entries and their driver follow-ups need compatible readers too. Unknown observation fields have refused since 0.13.
- A drift halt left by a 0.5.0 driver clears with `owed rebase <node>` after the main agent resolves the drift. Current CLI delegated owner acts use `owner:cli`, tools `owner:pi`; earlier CLI versions used `owner:human`.

Upgrade before recording an entry an old reader refuses, not merely before the next merge. Version refusal never authorizes editing the ledger or dropping fields.
