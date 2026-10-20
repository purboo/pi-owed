# owed specification (0.27)

owed is the acceptance ledger for a multi-agent task graph in one Git repository.
"No receipt, not done": a node is complete only when owed shows it merged.
Candidate acceptance requires every node obligation to be evidenced by a trusted
executor or authorized reviewer, or visibly waived by the owner; merging also
requires the prospective merge guard (§6.4). The design follows
`pi-dag/ARCHITECTURE.md` (a3) and `formal/a4/CONTRACT.md` (a4.1 rulings).
Threat model: same OS user; owed prevents mistakes, laziness and
reward-hacking shortcuts by agents using the normal tools. It does not resist a
process that edits the ledger file directly; it detects such edits (hash chain).
Identities are claims (`--as`); the subagent rails (§2.1.3 and the writer-worktree
rail §2.1.7) are rails against accidents and instructions, not security
boundaries: a process can unset the variables or change directory.

### Compatibility (0.20–0.27)

0.27 adds no ledger entry kind. New plan keys are top-level `quarantine_sets`
and check/invariant `quarantine_set` (§3.6). New optional entry fields are
`obs.quarantine_passed`, `waive.tracked_by` and `ignorable` (§5). Historical
ledgers without these additions retain their states and keys; checks without
a set retain their previous definitions and keys.

**0.26 reader behavior, checked against `v0.26.0`:**

- `src/plan.ts`'s `parsePlan` ignores `quarantine_sets` and `quarantine_set`:
  it neither copies them nor rejects unknown top-level/check keys. It does
  **not** refuse a plan just for these keys. This is not safe interoperability:
  old executors omit shared names from keys and quarantine policy, and old
  plan recordings can discard the keys. Existing 0.27 observations can later
  make old replay refuse because their recorded keys differ.
- `src/reducer.ts`'s `OBS_FIELDS`/`newerEntry` refuse an observation carrying
  `quarantine_passed` with code `version`, including a marked observation.
- `waive.tracked_by` is ignored by 0.26's reducer and identical-act comparison
  (`src/reducer.ts`, `src/identical-acts.ts`): old waiver validation has no
  unknown-field check. It also ignores `ignorable` on a waive. The waiver's
  gate effect remains, but old views cannot track or settle that debt.
- `ignorable` is unknown to 0.26. `newerEntry` refuses it on rule, obs, defer,
  abandon, hold and resume with code `version`. Strict-kind validation refuses
  it on escape, decoy-commit/reveal, adopt, launch, send, halt, evidence and
  sweep as an ordinary invalid entry; grant/refresh have their own unknown-field
  refusals. Other permissive kinds ignore it. Readers before 0.27 still refuse
  `ignorable` wherever they refuse unknown fields; the marker is not a
  retroactive compatibility mechanism.
- `OWED_QUARANTINE_FILE` (§7.16) is execution environment, not a ledger field.
  0.26's `src/exec.ts` neither creates nor consumes it and does not remove an
  inherited value. Upgrade executors/wrappers to use per-run plan delivery;
  a container must make the host file visible itself.
- `attest --probe-trunk [--check ID] [--runs N]` (§7.27) requires the 0.27 CLI:
  0.26's `src/cli.ts` refuses those options. The resulting `obs` kind and
  `probe: "trunk"` value already exist in 0.26 and replay there unless a new
  optional field such as `quarantine_passed`/`ignorable` is recorded. The pi
  attest tool does not expose probe mode; use the CLI.

**0.27 upgrade order:** upgrade every reader — CLI, every driver and every pi
session loading owed, with drivers/sessions restarted — to 0.27 **before the
first 0.27 writer records shared quarantine policy, `obs.quarantine_passed`,
`waive.tracked_by` or an entry carrying `ignorable`**. Upgrade result consumers
and executors too. Recovery feedback can be written automatically on existing
own-quarantine plans: complete the reader upgrade before allowing any 0.27
executor measurement (attest, genesis/trunk, merge, adopt or trunk probes),
not merely before enabling sets or merging. Never strip fields or rewrite
receipts for old readers. Once all readers support `ignorable`, later listed
unknown display fields may be ignored; plan keys and nested receipt shapes
have no such extensibility guarantee. `--tracked-by` and waive `--full` /
tool `full:true` also require the current CLI/extension input surface.

Native Cargo excusal, flaky-owner hold timing, waiver replies, admission lint
and remeasure explanations add no separate serialized gate metadata. They need
an upgraded executor/CLI/driver for the current behavior (§7.16, §9.9).

0.26 adds no ledger entry kind or plan key. The new optional ledger field is
`obs.infra: <setup failure seq>` (§7.26). A qualifying counted pass resolves
only the consecutive setup failures on its exact subject/obligation/key;
field-free historical ledgers retain their states, keys and conflict rules.

**0.25 reader behavior:** `v0.25.0:src/reducer.ts`'s `OBS_FIELDS` excludes
`infra`; `newerEntry` refuses the entire ledger with code `version` as soon
as an observation carries it. Its automatic-remeasure validation also refuses
an existing `auto_remeasure: true` receipt authorized only by the new setup
predicate, even if no `infra` pass follows: 0.25 accepts only configured
`remeasure_on` or shared-failure eligibility. That refusal is an ordinary
invalid-entry refusal, not an unknown-field error.

**0.26 upgrade order:** upgrade every reader — CLI, every driver and every pi
session loading owed, with drivers/sessions restarted — before the first 0.26
writer records `obs.infra` or a setup-only automatic-remeasure receipt. These
receipts are automatic, not opt-in plan policy: complete the reader upgrade
before allowing any 0.26 executor measurement (`attest`, genesis/trunk
measurement, merge or adopt). Upgrade before the first incompatible write,
not just before merging. Do not remove fields or rewrite receipts for old readers.

Other additions are runtime/results, not ledger fields:

- `status.runtimeWarnings?: string[]` (§9.7): 0.25's `src/views.ts` does not
  consume it and its status renderer ignores it. Existing warning arrays may
  contain reads/timeout diagnostics; 0.25 array consumers retain those strings.
- Metrics `infra: {total, byObligation}` (§9.4): 0.25's `src/metrics.ts`
  ignores this result property and renders its old metrics. This does not make
  it able to replay a ledger containing `obs.infra`.
- Amendment previews/results add `covered: [{path, entry}]`; decisions add
  optional per-node `covered`. An all-covered amendment omits `plan` and
  `rule`, and an all-covered decision omits `plan` (§3, §8.3.1). In 0.25,
  `src/ops.ts`/`src/views.ts` do not consume `covered`; the amendment renderer
  and CLI assume `plan`/`rule` exist and cannot consume a 0.26 no-op result.
  Upgrade result consumers too, rather than treating missing entries as writes.
- The driver lock may carry optional `max`, the command-line override.
  0.25's `src/drive-bg.ts`/`src/drive-run.ts` ignore that unknown lock property;
  locks without it use the plan limit for current dispatch diagnostics (§9.8).
- Ruling delivery adds optional `finished: [{node, writer}]` on `delivery`
  (and answer `rulingDelivery`), describing known writer calls that are neither
  running nor asking (§9.3). 0.25's `src/answer.ts` ignores this unknown result
  property; its rule renderer shows only counts/failure/unknown-writer lines.
  No ledger field is added. `RunView.result` already exists in 0.25's
  `src/types.ts`; 0.26 also retains available final text for pruned runs, which
  0.25's `src/dsa.ts` discards. Worktree inspections are runtime facts, not
  replay inputs. Existing launch/send retries keep their recorded bytes;
  upgrade/restart the driver for the stopped-writer policy (§12.5.4).
- Graceful stops record `drive.lock.stop-request` (§12.8), not a ledger entry.
  0.25's `src/drive-bg.ts` ignores this file and signals on every stop; use only
  0.26 stop/restart clients for the at-most-once graceful-stop guarantee.

`--restart`, `report --cost`, `--version`/`version` and `--full` on rebase or
candidate attest need a 0.26 CLI; 0.25's `src/cli.ts` refuses those new options
or command forms. Review `--ack-rulings latest` / `ack_rulings: "latest"`
requires 0.26 CLI/extension input support: 0.25 expects a number, not the alias.
0.26 records the computed number, which 0.25 can replay. The start tool's
optional `restart` is an input flag, not a plan key: 0.25's `src/extension.ts`
does not declare it and its start implementation cannot perform a restart.
New ask/ready text, refusal recovery and unrelated-node batch-plan changes
introduce no serialized gate/key metadata (§7.21, §9.8, §12.5.3).
Concurrent adopts retain their individual total acquisition budgets (§8.4).

0.25 adds no ledger entry kind, plan key, acceptance gate or measurement key.
The only new optional ledger field is `genesis.path`: the plan source recorded
by `owed start` (§10.2), repository-relative when inside the repository and
absolute otherwise. Historical genesis entries without it replay unchanged;
an omitted-plan start whose latest genesis/plan has no source requires
`owed start --plan <file>`.

**0.24 reader behavior:** `v0.24.0:src/reducer.ts` does not reject unknown
fields on genesis and does not consume `path`; it ignores this field while
retaining the same state and keys. Its `src/types.ts` has no genesis `path`
member; ordinary `plan.path` already exists. No upgrade-before-write order is
required for `genesis.path`. Older executors cannot initiate `owed start`:
upgrade the CLI/pi extension to use that command, and restart pi to load it.

Runtime/result additions are `StartResult` fields `initialized`, `updated`,
`plan` (source path), `warnings` and `driver`; the driver's result may carry
optional `alreadyRunning`. These are not ledger fields. A 0.24 driver-start
consumer (`src/drive-bg.ts`, `DriveStart`) has no `alreadyRunning` branch and
ignores that unknown result property; it cannot request start's reuse behavior,
and its own `drive --detach` still refuses a live driver. Start is a new result,
not a changed 0.24 response schema. Batch results may carry optional
`deferred` counts/items per member, for the current merge key only (§8.3.4).
The 0.24 batch result consumer (`src/cli.ts`, `batchMergeText`, and
`src/ops.ts`, `BatchMergeResult`) does not consume that property: it ignores
it and retains its old text; it is never replayed. QT adds presentation/runtime
state only: JSON receipt fields are unchanged, while the existing omitted
`drive.answer_grace_s` default changes from 900 to 600 seconds (§12.8.4).
An explicitly recorded value retains its meaning; a 0.24 driver with no value
uses 900 seconds. Upgrade/restart the driver to obtain the new wake timing.
No measurement or acceptance evidence is affected. Tool exposure is host
registration metadata, not ledger data (§11.2).

0.24 adds no ledger entry kind. New optional plan keys are `sweep.every`
(§3.9, §7.15b), `risk` and `closure_neutral` (§3.8). New optional ledger
fields are `sweep.boundary: {head, merge}` and `escape.sweep` (§7.15b);
older owed refuses ledgers containing them. Identical-act retries (§8.3.3)
and off-ref fast-forward adoption (§8.3.2) add no ledger field; older
executors cannot initiate off-ref adoption but can replay its existing entries.
Field-free historical ledgers without the new plan policies retain their
states and keys. Runtime additions are `sweep-due`, `alreadyRecorded`,
`reviewRequirement`, `reviewRequirements` and report/metrics `reviews.sameModel`.

**0.24 upgrade order:** upgrade every reader to 0.24 — CLI, every driver
and every pi session that loads owed, with each driver/session restarted —
before (1) a 0.24 sweep records a confirmed boundary or automatic escape,
(2) the plan sets `sweep.every`, or (3) the plan sets `risk` or
`closure_neutral`.

In (1), older readers refuse entries containing `sweep.boundary` or
`escape.sweep`. In (2), 0.23 rejects `sweep.every` as an unknown nested
plan key: once a plan containing it is recorded, old CLI, driver and pi
readers cannot read the ledger state.

In (3), 0.23 ignores the unknown top-level keys `risk` and
`closure_neutral`. **Risk is not conservative:** a matched rule replaces the
node's review for that path, and diff-wide maxima can raise or lower the
requirement (§6.2a). An old executor ignoring a raising rule can merge with
too few or too-low-rank reviews for the 0.24 policy; 0.24 replay then refuses
the entire ledger at that merge. Conversely, a 0.24 merge relying on a
lowering rule can have too few or too-low-rank reviews for the old node
requirement; old replay refuses the entire ledger at that merge. Neither
direction is safely interchangeable.

Only `closure_neutral` used alone is conservative: an old executor ignores
it and computes `closureTouched=true` for a new submit that changes closure,
requiring closure-review even if 0.24 would call the change neutral. Replay
retains recorded candidate facts; it does not recompute `closureTouched`
for existing submits. Scheduling itself changes no sweep definition or
acceptance key; risk changes requirements, not evidence keys; closure
neutrality changes the closure-review fact, not full-file check hashes.

0.23 adds no ledger entry kind. New optional fields on existing entries are
`submit.facts.carry`, `submit.facts.rebased` (§7.25), `defer.allowance`
(§7.24), `decision` and rule `answers` (§8.3.1), and `lease_wait_ms` on
`obs`/`merge` (§7.14a). The new plan permission is `allow[].defer`.
Historical entries without these additions retain their states and keys.
Older readers reject `allow[].defer`, executor defers and shared-only
`auto_remeasure` receipts, or cannot interpret decision groups and halt
semantics; upgrade all readers before using these features.

**Upgrade order (ER6 + MX-P2):** owed <= 0.22.x replays a writer submit with
`facts.carry` but ignores carry; when its review key changed, the node needs a
new review. This is conservative, never a false pass. Those readers refuse
an `executor:owed` submit with `facts.rebased` as ordinary `Entry #N invalid`,
not code `version`. Readers in 0.13–0.22 refuse the whole ledger with code
`version` once an `obs` carries `lease_wait_ms`; on `merge` they ignore that
field. Upgrade the CLI, driver and every pi session that loads owed (restart
those sessions) **before the first 0.23 measurement or executor rebase**.
Leasing is on by default: any 0.23 measurement that acquires a lease, whether
started by the driver, manual `attest` or `merge`, records `lease_wait_ms` on
its observations/merge entries (§7.14a). This upgrade requirement is not limited
to driver operations. The driver's lease uses `noWait` and retries on the next
pass: its `lease_wait_ms` excludes cross-pass waiting and is a lower bound.

0.22 ships the previously unreleased 0.20.1 and 0.21 changes together.
Upgrade every driver, CLI and pi plugin to **0.22 or newer before enabling
`drive.merge_batch`**, issuing an explicit batch merge, or using writes globs,
`waits_on` or `remeasure_on`. Older readers can misjudge batch merge guards,
interpret globs as literal prefixes, or refuse new observation fields.
Existing entries keep their recorded writes dialect; no migration rewrites them.
String-template `exec.wrap` changes measurement keys only when configured;
legacy argv wrappers and absent wrappers keep their existing keys (§7.22).
No new ledger entry kind is introduced.

0.20 adds only optional fields to existing entry kinds and optional plan keys;
it adds **no new entry kind**. Upgrade every driver, CLI and pi plugin together:
older releases can ignore or misread new plan/observation fields, or refuse them
with `needs a newer owed`. New optional ledger fields are `obs.signatures`,
`obs.quarantined`, `resume.remeasure`, `resume.batch`, `submit.model` and
`review.model` (§5). New plan keys are check/invariant `quarantine` and
`template`, with template arguments `package`, `test`, `filters`, `min_ok`,
`files`, `name_prefix`, `path` and `required` (§3.6). Runtime/view fields are not
ledger entries. Without these additions keys and replay remain as in 0.17,
except pooled repeat across several observations on one key (§7 RC1).

0.20.1 adds no ledger entry kind or field. Existing `obs.signatures` use a
`v2|` encoding (§5, SG1); untagged signatures replay unchanged but never equal
new signatures, including for signature-based defer carry. New optional plan
keys are check/invariant `on_timeout` (§7.18) and global/node
`drive.same_model: accepted` (§12.2). Older readers ignore `on_timeout`, reject
`same_model`, or retain misleading failure/model diagnostics: upgrade executors,
drivers, CLI and pi plugins together before using these keys. Receipt JSON
`modelWarnings` now admits acknowledged objects as well as strings (§12.5.2).
Merge-wait `ahead`/`job` are runtime-only fields (§9); old caches remain readable.
No acceptance gate is weakened by diagnostic hooks, acknowledgements or retries.

## 1. Storage

- Ledger directory: `$(git rev-parse --git-common-dir)/owed/` (shared by all
  worktrees, never committed). Override with env `OWED_DIR` (tests).
- `ledger.jsonl`: one JSON object per line, append-only. Every entry has
  `{seq, ts, prev, kind, by, ...payload}`. `seq` starts at 0 (genesis) and
  increments by 1. `prev` = `hash` of the previous entry (genesis: 64 zeros).
  `hash(entry)` = sha256 hex of the canonical JSON (keys sorted recursively) of
  the entry **without** a `hash` field; the stored line also contains `hash`.
- `blobs/<sha256>`: content-addressed blobs (plans, logs, dispatch packets).
- `cache/plans/<blob sha>.json` (0.10, N4): the persistent parsed-plan cache,
  `{v, sha, plan}`; `v` = cache format + owed version (`PLAN_CACHE_VERSION`).
  An op reads a plan from the in-process cache, then from this entry, then from
  the YAML blob; after a YAML parse it writes the entry atomically (temp file,
  then rename). Any read error, invalid JSON, other `v` or other `sha` means the
  entry is ignored and the YAML is parsed again; a write that fails is ignored:
  the cache never fails an op. It is a derived local file, as writable by local
  processes as the ledger and the blobs. `owed verify` never uses it for replay:
  it parses every plan blob from YAML and reads each cache entry raw. An entry
  of another `v` is rewritten silently (stale, not a fault). An entry of this
  `v` whose `sha` or plan differs from the blob, or a file that cannot be read
  or is not JSON, is reported in `cacheMismatch` (JSON; not a verify failure)
  and rewritten. `owed gc` (also `--dry-run`) removes entries whose sha no
  longer appears in a genesis or plan entry, and temp files older than 60 s
  (`GcResult.planCache`, a `Plan cache files ... removed` line); nothing is
  recorded in the ledger for them.
- `snapshot/state.v8` (0.12, G1.4): the disk snapshot, a private derived cache
  of the replayed State and its replay metadata (§6, Resumable replay) at one
  ledger entry. One v8-serialized record `{format: "owed-snapshot/1", version:
  <owed package version>, seq, hash, digest, payload}`: `seq`/`hash` = the last
  folded entry, `payload` = the v8-serialized packed state (plans named by blob
  sha, re-resolved through the plan lookup), `digest` = sha256 of the payload.
  An op uses it only when format, version and digest match and the verified
  chain's entry `seq` has `hash`; a missing, unreadable, foreign or mismatching
  snapshot is ignored (and replaced), never an error. It is written atomically
  (temp file `snapshot/.state.<uuid>.tmp`, then rename; concurrent writers are
  harmless) after a load that folded at least 256 entries past the snapshot, or
  found none; a write that fails is ignored. `owed verify` never uses it for
  its result (§8). It lives in the private owed dir, is never committed and
  needs no gc: deleting it only costs one full replay.
- `lock/`: mutual exclusion by atomic `mkdir`; contains `owner.json`
  `{pid, host, ts}`. A lock whose pid is dead on the same host is stale and may be
  broken. All read-check-append sequences run under the lock (§6.4). Other named
  locks (`merge`, `dispatch`, `genesis`, `attest-<hash>` per node, §7.11) work the
  same way; a wait that times out (60 s) fails with code `busy` (§7.11).
- Every append: re-read ledger, verify chain tail, check guard, append the line
  with `fsync`, release.
- **TR, torn read (0.20):** `Ledger.read()` without the ledger `lock` ignores
  only a final fragment without a trailing `\n`, returning the preceding
  complete entries with their chain verified. This is an append-in-flight
  tolerance, not permission to drop a malformed complete line: a complete bad
  line still fails with `ledger seq N: invalid JSON`. Inside `withLock` on the
  same Ledger instance, reads remain strict: a torn tail fails with `invalid
  JSON` or `incomplete line`. A crash-torn tail therefore cannot be appended
  after silently. Other reader paths are not covered by this change (§7.17).

## 2. Principals

`Principal = {role, id}`; `role ∈ owner | parent | writer | reviewer | executor`.
String form `role:id` (e.g. `owner:human`, `parent:main`, `writer:auth-api#2`,
`reviewer:astra-1`, `executor:owed`).

- Writers are created by dispatch: `writer:<node>#<attempt>`.
- The executor is owed itself; only `owed attest`/`owed merge` produce executor
  observations.
- The driver (`owed drive`, §12) acts as `parent:drive`. That name is the
  driver's only (0.6.0, G2.3): the ledger refuses, on append and on replay, an
  entry by `parent:drive` of any kind the driver never writes (it writes only
  `dispatch`, `launch`, `send`, `halt`, `rebase`, and `abandon` only for its own
  never-launched stale slot, §12.3 AH2), and the CLI `--as
  parent:drive` and the pi tools' `as: "parent:drive"` are refused for every
  command and tool, reads included (`parent:drive is the driver's identity:
  only owed drive records as it; it cannot be claimed with --as or as`); the
  driver passes it internally.
- Owner acts are recorded with a `channel`: `delegated` (D25, the default: the
  main agent acts as owner with no human step), `tty` (interactive confirmation),
  `pi-confirm` (pi UI confirmation) or `flag` (`--i-am-owner`, shown as weaker in
  every view). `tty` and `pi-confirm` occur only under the opt-in gate
  `OWED_CONFIRM=owner` (§11). Agents must never use the flag; the skill says so.
  Ledgers written by 0.4.x stay valid; a 0.4.1 reader verifies and replays a
  ledger containing `delegated` (it never checked channel values).

### 2.1 Delegated owner (D25)

A human states the task and leaves; the main agent (the top-level session) holds
every authority, including the owner's. Accountability moves from pre-approval to
audit: every act is in the hash-chained ledger and the brief lists the main
agent's owner acts first (§9).

1. In pi, an owner tool (every tool that acts as an owner principal: plan with
   downgrades, adopt, waive, defer, decoy, review as owner, approve, evidence,
   init, …) runs with no dialog; the entry is `by: owner:<id>`, `channel:
   "delegated"`. The default owner id in pi is `owner:pi`.
2. CLI: an owner command (`--as owner:<id>`, or a command whose default principal
   is the owner) records `delegated` with or without a TTY, without a prompt;
   `--i-am-owner` stays accepted and records `flag`. The CLI's default owner
   principal is `owner:cli` (0.5.1, E3.3; matching pi's `owner:pi`), also with
   `--i-am-owner`; only under `OWED_CONFIRM=owner` it is `owner:human`.
   Compatibility: entries written by earlier versions keep `owner:human`; a
   script that matched `by: owner:human` for CLI owner acts now sees
   `owner:cli` (pass `--as owner:human` to keep the old id).
3. A process with `DSA_CALL` or `DSA_EXEC` in its environment (a
   pi-durable-subagents call) is refused for roles owner and parent, in pi tools
   and the CLI alike, before anything is recorded: `owner and parent acts are
   reserved for the main agent; this process is a subagent call (DSA_CALL)` (or
   `DSA_EXEC`). Reads (`status`, `why`, `report`, `brief`, `verify`, `decoy
   digest`) and `attest` (recorded as the executor) are not refused; the default
   role of such a process is unchanged. This is an accident rail, not a security
   boundary: a process can unset the variables. `owed drive` (and `owed_drive`)
   is not refused (D17 keeps starting a detached driver from a dsa call).
4. `OWED_CONFIRM=owner` (environment) restores the confirmation (§10, §11).
   Without it nothing ever waits on a human.
5. Every delegated owner act that eases acceptance needs a non-empty note or
   reason: a plan update with downgrades (`owed plan --note`, `owed_plan` `note`;
   the plan entry has an optional `note`), `waive` (`reason`), `defer` (`reason`),
   `adopt` (`note`); refused without one, nothing recorded.
6. The driver's "needs the owner" notifications read `<node>: needs the owner
   (the main agent decides; owed lists the command): <reason>; the driver leaves
   it alone; the main agent resolves it with: <commands>`; its owner halts for a
   stale review block or a stalled candidate end with `; the main agent resolves
   it with: <commands>` (`views.ownerCommands`, in order: with an open candidate
   the brief's command for each owner item still owed, a waiver for every other
   item still owed and every uncleared block, and `owed abandon <node> --note
   "<why>"`; without one, as the brief's dispatch/clear hints, `owed dispatch
   <node>` first when no slot is open, then each waiver prefixed `after the
   writer submits a candidate:` since a waiver needs one; nothing for a merged
   node). The reason's own trailing `needs the owner` is not repeated.
   The driver's output line of a halt needing the owner reads `halt <node>
   attempt <n>, needs the owner (the main agent decides; owed lists the
   command): halted — <reason>`; other halts use `needs the parent (the main
   agent acts; owed lists the command)` (QT1). The halt rows of `status`, `why`,
   `brief`, `report` and entry lines use the same owner/parent wording.
   The ledger value `needs: 'human'` is unchanged: rendering only, no new entry
   shape or compatibility/version change. Evidence-only halts name the plan's
   role (`--as <by>:<id>`) and add `or --as owner:pi` (D23); no person is asked.
   Trunk drift is never a node halt (§12.7 Trunk drift). The
   commands of the brief, report and these texts omit `--as` where the command
   already defaults to the owner (waive, defer, adopt, approve, init) and use
   `--as owner:cli` where a role must be stated (owner review, owner evidence);
   under `OWED_CONFIRM=owner` that role is `--as owner:human`. Each such
   command for a candidate-bound act (waive, approve, evidence, owner review) on
   a node with an open candidate ends with (approve: is followed by) `--candidate
   <commit12>` of that candidate (G1.3, §8 act binding).
7. Writer-worktree rail (0.6.0, G2.1, F3): in a pi-durable-subagents call
   (`DSA_CALL` or `DSA_EXEC` set), an owed process (CLI or pi tool) whose working
   directory (the CLI's cwd, the tool's `cwd` argument, the pi session's
   directory or the process's own) is inside the open slot worktree of node X is
   refused `review` and `evidence` on X, nothing recorded: `a writer worktree
   cannot record a review or evidence for its own node; run the review from the
   repository root or another directory`. Waives are already refused for
   subagents (item 3). Like item 3 this is an accident rail, not a security
   boundary (§1).

## 3. Plan (content, YAML)

```yaml
version: 1
trunk: main                    # branch name of the trunk
closure: [".owed/**", "package.json", "**/conftest.py"]  # check-closure path globs (pinned from base)
setup: "npm ci --prefer-offline"   # optional, run in every materialized tree before checks; default slot setup too
slot_setup: "ln -s /shared/node_modules node_modules"  # optional (0.16): string overrides setup in slots; false skips
invariants:                    # state invariants on trunk (machine checks)
  - id: unit
    run: "npm test"
    timeout_s: 600
    reads: ["**"]              # declared read set (globs); default ["**"]
    min_tests: 1               # optional; parsed test count must be >= this
nodes:
  - id: auth-api
    title: "Add token refresh"
    deps: [schema]
    writes: ["src/auth/", "test/auth/"]   # prefixes or supported path globs (§3.7)
    # allow_only: ["lib/samples.mjs"]    # optional cap on allow grants only (§3.4.1)
    checks:                    # node acceptance checks (become invariants after merge only if listed in invariants)
      - id: auth-tests
        run: "node --test test/auth"
        timeout_s: 300
        reads: ["src/auth/**", "test/auth/**"]
        red: true              # counterfactual: these tests must FAIL on the base with candidate test files overlaid
        tests: ["test/auth/**"]   # files overlaid onto base for the red run (required if red)
        red_expect: "not ok|AssertionError"   # optional regex the red-run log must match
        min_tests: 1
        mutants: [".owed/mutants/auth/*.patch"]   # optional: mutant patch globs inside the closure (read from the base)
        min_kill: 0.8          # optional, in (0, 1], default 1: fraction of mutants the check must kill
    review: {count: 1, min_rank: 1}   # default {count: 0}
    brief: |                   # free text included in the dispatch packet
      ...
    drive:                     # optional (0.7.0): driver agents/models for this node only (§12.2); never an obligation
      writer: { agent: worker-cheap }      # {agent?, model?}; default: the plan's drive.writer
      reviewer: { model: "example/model-small:high" }   # default: the plan's drive.reviewer
```

A plan change that alters a node's spec, `setup`, `exec` or `closure` invalidates
that node's submitted candidate: its keys were computed under the old plan.
The node fields `type` (§3.1) and `drive` (§12.2) are not obligations: changing
them invalidates no candidate and is never a downgrade.

**Carry (0.10, N1).** When the invalidated candidate's node spec differs
from the new one only in `checks`, `writes`, `type` and `drive` (plan-wide
`setup`, `exec` and `closure` changes do not matter), the same `owed plan` call
appends, inside the same ledger lock and right after the plan entry, a *carry
submit*: a `submit` by `executor:owed` with `carry: <seq>` = the carried submit,
for the same commit at the same slot base, its facts recomputed with
`candidateFacts` under the new plan (manual keys as for a normal submit). So
evidence on unchanged keys (reviews, approve, evidence, measured checks whose key
did not change) still counts, and the next attest measures only the changed keys.
The candidate stays the writer's own commit: writer-only rules (no self-review,
decoys) treat it exactly like the original. A change to any other node field
(`brief`, `deps`, `review`, `title`, `approve`, `evidence`, …) never carries: the
writer must see it and submit again, as in 0.9. A carry whose facts cannot be
computed, or that validation would refuse, is left out (the plan is still
recorded and the candidate stays invalidated), never silently: `owed plan` (and
`owed_plan`) print `Not carried <node>: <reason>; the writer submits again`, and
JSON has `notCarried: [{node, reason}]`. `owed why` and `owed status` show `candidate #C carried by plan #P
from submit #S`, and `owed plan` prints one `Carried <node>: …` line per carried
node. The formal model does not cover carry (Deferred).

**Amend: widen one node's writes (0.10, N3).** `owed amend <node>
--writes +<path>[,+<path>...] --note "<limit>" [--plan <file>]` (pi `owed_amend`
`{node, writes, note, plan?, as?, cwd?}`) is a targeted plan update. The plan file
is `--plan` (relative to cwd), else the `path` of the latest plan entry (refused
when that entry has none). It is refused when the file's plan differs from the
ledger's current plan (`plan file has unrecorded edits`; a comment-only difference
is no difference), for an unknown or merged node, an empty path list or note,
or a removal (`-path`, which requires `owed plan`). Bare paths and `+path`
both mean additions. Each is a writes scope, not merely a filename: a path
is already covered only when equal to an existing write or provably contained
by it under §3.7 (`w === p || writeCovers(w, p)`). For example, `src/lib`
under `src/*` widens ownership: the filename match does not cover the prefix
range below `src/lib`. Uncertain containment is a real widening. Covered
paths are skipped with `already covered by <entry>`; paths covered by an allow
rule of the current plan are skipped too, naming `allow rule (plan #<seq>)`.
An all-covered amendment exits successfully with `writes unchanged` without
changing the file or recording any entry. When an allow rule covers paths, the
output points to `owed decide <node> --writer` to deliver a limit.
For a real widening, the edit locates the node's `writes` list with the
`yaml` Document API and changes only that list's source text (a flow list gets
`, path` before its `]`, a block list one `- path` line per path at the same
indentation; a node without writes gets a block list through the Document API,
which re-emits the file), so comments, order and style are kept; new paths are
appended, paths already there skipped, and the result must parse to the current
plan with only that node's writes widened. In one ledger lock amend then appends
the plan entry exactly as `owed plan` would (the same drafting and guard: a
widening is a downgrade, so it needs the owner or an `allow` rule of the current
plan; the plan `note` is `amend <node>: writes +<paths>. Limit: <note>`, which also
satisfies D25.5), any N1 carry submits, and a `rule` by the same principal with
nodes `[<node>]` and text `writes of <node> widened by plan #P: +<paths>. Limit:
<note>`. The writer receives that ruling through the usual ruling path and
reviewers acknowledge it (`rulings`). The edited text is written to a temporary
file next to the plan file before the append (a write failure refuses: nothing
recorded) and renamed over it after the append; if that rename fails, amend
reports that the entries were recorded and where the recorded text is. Any
refusal records nothing and leaves the file unchanged. Like `owed plan` (N2), amend
retries a CAS refusal up to 3 attempts while the ledger's plan sha is unchanged;
each attempt re-reads the ledger and the file, and a failed attempt removes its
temporary file.
**Atomic field edits (0.13, ED1–ED3, app §65).**
`owed edit <node[,node...]> --set <path>=<yaml> ... [--unset <path> ...]
[--node-new] [--rule "<text>" [--writer]]
[--resume [--after a,b] [--expect report]] --note "<why>"
[--dry-run] [--plan <file>]` edits the latest recorded plan file (or `--plan`,
relative to cwd). Node paths are `title`, `brief`, `deps`, `writes`, `later`,
`review.count`, `review.min_rank`, node overrides under `drive.*`,
`checks.<id>` (a whole mapping; its id is inferred from the path), and
`checks.<id>.<field>`. `--set` and `--unset` may repeat; assignments split at
only the first `=`, and values are YAML. Sets run in argument order, then unsets;
unknown paths, an unset of a missing field, malformed YAML and a mismatched
check id refuse. `--node-new` adds a node from `deps`, `title`, `brief`, `writes`
and check assignments; it refuses an existing id. An invariant edit is
`owed edit --invariant <id> --set <field>=<yaml> --note "<why>"`; its id cannot
change, and rule/resume options apply only to node edits.

**Multi-node edits (0.30, ME1).** A comma-separated node list, or the tool's
`nodes: string[]` (exclusive with `node` and `invariant`), applies the same sets
and unsets to every listed node. CLI targets matching an exact current node ID,
or used with `--node-new`, remain literal even with commas; otherwise split on
commas, trim each part and reject empty parts, using tool `nodes` or separate
edits for batches whose joined name collides with an existing ID (R-030-ME-1).
Duplicate ids are removed in first-seen order; tool/ops `nodes` with `node_new`
requires a single distinct node. Only the final plan is validated,
so intermediate edits need not form a valid plan. One note explains the batch,
which records one plan entry, computes carries once from that final plan,
records one optional rule naming all nodes, and validates and records one
resume per node when requested. Any unknown node, missing unset, authority or
resume refusal, or pre-write append refusal records nothing and leaves the
plan file unchanged, as for single-node ED2. Dry-run prints one diff and all
downgrades. Single-node behavior and output are unchanged; multi-node results
return `resumes: Entry[]` instead of the single `resume` when requested.

ED1 uses the `yaml` Document API and re-emits only the target map when safe,
retaining its comments and keeping every byte outside it. Targets inside flow
containers or containing anchors/aliases use whole-Document serialization so
flow punctuation and references stay in context; comments are kept, but spacing
may be normalized. Assignment values remain YAML nodes, so an alias can refer
to an anchor elsewhere in the plan. A new block node appends to the nodes
sequence. Every result is re-parsed and compared with the intended edited plan
before it can be written; malformed YAML or a lost reference refuses. The final plan passes
the same parser and hygiene checks as `owed plan`. Unrecorded semantic file
changes refuse; comment-only edits are kept. ED2 uses the same plan drafting,
guard, authority and N1 carries as `owed plan`/`amend`. One ledger lock guards
and appends the plan, any carry submits, the optional rule naming the node
(`writer` when requested), and the optional resume, in that order. All parent
acts use the same principal/channel; carries remain `executor:owed`.
The resume uses the prospective plan and ruling, requires an open slot and
follows the normal resume validation, including `after` and `expect` (§12).
A non-empty note is required, also satisfying delegated owner downgrade rules.
The temporary file is prepared before the append and renamed over the source
afterward, preserving its mode. A refusal records nothing, leaves the source
unchanged and removes the temporary file. A rename failure after the append
reports the recorded seq range and the recovery file, as amend does.
`--dry-run` prints the textual diff and structured downgrades without writes
or owner confirmation, including `--as owner:pi` with `OWED_CONFIRM=owner` in
a non-TTY process. ED3 leaves `owed amend` unchanged.

Compatibility: ED adds no ledger entry kinds or fields; its plan, carry, rule
and resume entries use their existing schemas. Plan fields or resume options
introduced elsewhere in 0.13 follow their own compatibility rules.

**Known-red invariant debt (0.15, KR1–KR4).** An invariant may set
`known_red: [{test: <exact obs.failed name>, fix: <node id>}]`. The list has at
most 20 entries, unique non-empty names; each fix is a node of the same plan.
Names are exact and case-sensitive (not globs); whitespace is preserved. This
field is invariant-only and enters no check, invariant, review or other key.
Adding an entry or changing its fix is a plan downgrade, recorded in the plan
entry's `downgrades` as `inv:<id> known_red "<name>" added with fix <node>
(owner only)` or `fix changed from <old> to <new> (owner only)`. Only the owner
may record it; no `allow` rule covers known-red in 0.15. Removal is not a
downgrade. Use `owed edit --invariant <id> --set
'known_red=[{test: "exact failing name", fix: repair}]' --as owner:pi --note
"assign bounded trunk debt"`, or `--unset known_red` to remove the whole list.
The existing atomic edit/plan authority, note and rollback rules apply.

An entry is active while its fix node remains in the plan and has not merged.
An invariant failure decided solely by named failing tests (the shared IR2
predicate: fail verdict, non-empty `failed`, no timeout, error, zero/unknown
count or unmet `min_tests`, including repeat runs) becomes **W**, mark **⚠**,
when every failing name is active. It is satisfied for merges and acceptance,
not a measured pass or an invariant waiver. Invariant `why` receipts set
`accepted: true` for E or W, and false for D (including lapsed or missing-fix
failures). Its detail is
`inv:<id> known red: <names> (fix: <nodes>; plan #<seq>)`; evidence includes the
executor observations and current genesis/plan seq. An extra unlisted name,
unknown names or any other failure keeps the ordinary evaluation; conflicts
remain conflicts. Known-red never suppresses unlisted failures.

For a fix node X's merge result, its own entries are inactive. If any of its
names still fails, merge refuses with `X is the fix node of known-red <names>
on inv:<id>, which still fail on the merge result`, even for an unchanged key
or owner defer. Those names are also excluded from IR2's trunk failed-name
comparison: existing trunk-red debt cannot excuse an unfixed fix node. After
X merges the entries lapse, and a recurrence is ordinary red.

`status`, `report` and `brief` list active debt, one line per invariant:
`inv:<id> known red: <test> (fix: <node>), ...; plan #<seq>`, even when the
latest observation passes. Full status also lists lapsed entries as removable
with `owed edit --invariant <id> ...`. JSON adds optional `knownRed` arrays of
`{invariant, entries: [{test, fix}], plan: <seq>}` to these views; status also
adds optional `lapsedKnownRed` with the same shape. Fields are absent when empty.
No new ledger entry kinds or top-level entry fields are needed.

Compatibility exception: owed 0.14 and older ignore `known_red`
and treat the listed tests as ordinary failures (stricter); mixed versions may
halt merges that 0.15 accepts; upgrade together. No compatibility flag is
recorded, and the intro's version-refusal rule does not apply to this plan field.
Ledgers without `known_red` keep their earlier states, keys and JSON views.

Invariants removed by the owner no longer need their genesis observation.

**Checks prepare their own artifacts** (0.8, L2.5). owed measures every
check and invariant in a fresh temporary worktree of the candidate or merge tree
(§7). Nothing that exists only in slot worktrees (build outputs, caches,
`node_modules`) is present there. A check or invariant must prepare its own build
artifacts, for example through `setup` or its `run` command. When a failure was
environmental and the parent or owner fixes the check, the plan update supersedes
the old execution block (§6.3), so it needs neither a rerun nor a waiver.

Validation: unique ids; deps exist; acyclic; `red: true` requires `tests`;
`writes` non-empty for nodes with checks; `mutants` (node checks only, non-empty)
must lie inside the closure — each glob, read as a path, matches a closure glob,
and a glob containing `**` needs a closure prefix (`dir/` or `dir/**`) covering
it; `min_kill` requires `mutants` and lies in (0, 1]. Removing `mutants` or
lowering `min_kill` is a downgrade. Plan changes are laws (§5) by owner or
parent. Removing or weakening an obligation of a node relative to the previous
plan (check removed, `red` turned off, `min_tests` lowered, review count/rank
lowered, writes widened) is a **downgrade**: allowed only to the owner (or to a
parent when an allowance of the prior plan covers it, §3.4), and
listed in reports as ΔO⁻.

### 3.0a Environment-signature routing (`env_signatures`, 0.30)

Optional top-level `env_signatures: {match: [<regex>, ...], unless: [<regex>, ...]}`
provides routing hints, not acceptance evidence. `match` must be non-empty;
`unless` may be absent or empty. Each regex is a non-empty string of at most
300 characters compiling as a JavaScript `RegExp` without flags. Unknown keys
are refused. Adding, changing or removing this field changes no obligation key,
check definition, candidate or block, and is never a downgrade. Plans without
it retain their previous behavior and replay.

For a failing ordinary node-check measurement, the executor removes ANSI CSI
sequences and CR from the retained log text and splits it into lines. A failure
is suspect when any line matches any `match` regex and no line matches any
`unless` regex. Its note is prefixed with `environment-suspect: <line>; `,
using the first matching line, replacing each semicolon with a comma, trimming
and clipping to 160 characters. The original log, verdict, counts, failed names,
signatures and keys are unchanged. Ordinary candidate checks participate even
when their spec also configures `red` or `mutants`; red and strength executions,
repeat runs, invariants and trunk probes do not.

For a block on the current candidate's key with a suspect failure F that is
still in force (its current item is unsatisfied), the driver measures its
attribution before asking the writer to repair any failure of that node.
A satisfied or effectively owner-waived item does not trigger suspect routing,
even when historical active/cleared blocks remain; another unwaived failure or
a failure on a new key still follows its own routing. Attribution uses the plan
at F, not newly added signatures.
It prints once per F, without a parent wake:
`<node>: check <id> failed #<F> with an environment signature (<line>); measuring again on the same key before asking the writer`.

If attribution A fails with another suspect note, the driver halts the node,
sends no repair and spends no repair budget:
`<node>: check <id> failed twice with an environment signature (#<F>, #<A>: <line>); the writer is not asked to repair. Fix the environment, then owed attest <node> --rerun and owed resume <node>; if it is a real failure: owed decide <node> --writer --text "<repair instruction>"`.
A resume after that halt returns those failures to ordinary repair routing.
An attribution pass retains the failure and the existing flaky-block owner
need; a non-suspect fail follows ordinary repair, and an error follows the
existing backoff/two-errors halt rules. No signature turns a failure into done.

### 3.1 Worktree location and branch names (D19)

```yaml
worktrees:                          # optional; unknown keys and bad types are errors
  root: ../dev/app-worktree        # absolute, or relative to the main worktree root; default .owed/wt
  branch: "{type}/{node}-{attempt}" # default "owed/{node}/{attempt}"
nodes:
  - id: auth-api
    type: fix                       # optional, ^[a-z][a-z0-9-]*$, default feat; used only by {type}
```

The branch template must contain `{node}` and `{attempt}`; any placeholder other
than `{node}`, `{attempt}` and `{type}` is a plan error. A plan being recorded
(`init`, `plan`) is also refused (usage, nothing recorded) when `root` or the
template contains a control character (a code point below 0x20, 0x7f, U+2028 or
U+2029) or when the template is ambiguous, i.e. two distinct (node, attempt) pairs
could expand to the same name. The rule is sufficient, not exact: `{node}` occurs
exactly once, every `{attempt}` or `{type}` before it is directly followed by a
literal character that cannot occur in its value (a digit for `{attempt}`; a
lowercase letter, digit or `-` for `{type}`), and every one after it is directly
preceded by one. So `owed/{node}/{attempt}` and `{type}/{node}-{attempt}` are
accepted, `{node}{attempt}` (`a1`+`1` and `a`+`11` give `a11`) and
`{node}-{type}-{attempt}` are refused. A plan being recorded is also refused when
two node ids are equal ignoring case (`KB4` and `kb4`): on a case-insensitive
filesystem they would share a branch ref and a worktree directory. These checks apply to plans being recorded,
not to replay: a ledger whose recorded plan has such a block stays readable. A plan without the block
parses to a plan without a `worktrees` key (the same canonical plan and sha as
0.4.1); a block present is filled with the defaults. Neither `worktrees` nor a
node's `type` is an obligation: changing them is never a downgrade (a parent may
record it), never invalidates a submitted candidate (the candidate-invalidation
comparison ignores `type`), and affects only later dispatches; an open slot keeps
the branch and worktree recorded in its dispatch entry (§8.1).

### 3.2 Execution environment: `exec` (D20)

```yaml
exec:                            # optional; unknown keys and bad types are errors
  env: { CARGO_TARGET_DIR: /abs/shared/target }   # string values, no expansion
  wrap: ["/abs/tmp/qa/heavy.sh"]                  # legacy argv prefix; alternatively a shell template (§7.22)
  wrap_grace_s: 30                # template-wrapper shutdown grace; nonnegative integer, default 30
  parallel: 4                    # 0.9: jobs one merge/adopt/genesis attest measures at once (integer >= 1, default 1)
  trees: reuse                   # 0.9: fresh (default) | reuse: stable measurement worktrees (§7.12)
  touch: reset                   # 0.11: reset (default) | always | never; tracked mtimes in reused trees
```

`env` names match `^[A-Za-z_][A-Za-z0-9_]*$` and may not be `CI` or `OWED`;
a newly recorded plan (`init`, `plan`, `amend`) may also not set `OWED_TREE`
(0.11). Replay does not check it, so a ledger whose older plan sets it still
verifies; at run time owed's `OWED_TREE` overrides the plan's value;
values are strings used verbatim (no `$VAR` or `~` expansion). The parsed plan
keeps only non-empty fields: `exec: {}` and `exec: {env: {}}` are the same as
no block (same plan blob, keys and views). `wrap: []` is an error.

A change of `exec` is treated like a change of `setup`: it invalidates the
submitted candidates (§3), attribution reruns of older blocks use the exec of
the plan in force when the block was recorded (§7, step 1), and because a wrapper
can weaken every check (`wrap: ["true"]` passes everything) the reducer records
it as `{node: "*", what: "exec changed; cannot prove obligations were not
reduced"}` in ΔO⁻: only the owner may change `exec`, so set it once. The
recorded `downgrades` field of the plan entry (and the confirmation list of
`owed_plan`) does not list it, as for `setup`. Plans without `exec` behave
exactly as in 0.4.1; a plan with `exec` needs owed ≥ 0.5.0 to replay.

`parallel` and `trees` (0.9) only schedule measurement: they are not part of
`execKey` (§4.1), of any check key or of the L2 check definition, and the
comparison above (candidate invalidation, the `exec changed` ΔO⁻ item) looks at
`env`, `wrap` and explicitly set `touch` only. Changing `parallel` or `trees`
therefore supersedes nothing, re-measures
nothing and needs no owner authority (a parent may set them). An `exec:` block
holding only `parallel` and/or `trees` is valid; the parsed plan keeps each of
them only when it is set (`parallel: 1` and `trees: fresh` written explicitly
are kept, and change the plan blob, not any key). A plan setting them needs owed
≥ 0.9.0 to replay. `parallel` must be an integer ≥ 1; `trees` is `fresh` or
`reuse`. `touch` is `reset` (default), `always` or `never`, kept in the plan
only when explicitly set, and requires owed ≥ 0.11.0. It affects reused trees
only (§7.12), but an explicit value always enters `execKey`: changing it needs
owner authority and new evidence, including when setting the default explicitly.

### 3.3 Owner approval and manual evidence (D23)

Two optional node fields add obligations no executor can measure (§6.2 items 8–9):

```yaml
    approve: owner             # the only value: obligation `approve`, discharged by the owner only
    evidence:                  # obligations `evidence:<id>`, discharged by `owed evidence` (§8)
      - id: ui                 # ^[A-Za-z0-9][A-Za-z0-9._-]*$, unique in the node
        what: "looked at the real page"   # non-empty
        by: reviewer           # reviewer | parent | owner (default reviewer); the owner always qualifies
```

Unknown keys and bad values are errors. A node without them gets neither key in
the stored plan (its canonical form, so a 0.4 plan's sha, is unchanged).
Downgrades: `approve removed`; `evidence <id> removed`; `evidence <id>
weakened` when its `by` changes to a role other than `owner`. Adding either, or
changing an evidence `what` (a new key), is not a downgrade; it changes the node
spec and so invalidates the open candidate (§3).

### 3.4 Owner allowances (D21)

An optional `allow:` block lets the owner pre-authorize parent downgrades and
parent adoptions. It is a list of rules; unknown keys and bad types are errors,
and a rule needs at least one permission:

```yaml
allow:
  - nodes: ["phaseA-*"]          # node id globs (path.matchesGlob on the id); default ["*"]
    review_count: 0              # parent may lower review.count down to this (integer >= 0)
    review_rank: 1               # parent may lower review.min_rank down to this (1..3)
    writes: ["tests/", "docs/"]  # parent may widen writes with prefixes inside these prefixes
    checks: ["ui-*"]             # parent may remove/weaken node checks and evidence obligations (§3.3) whose id matches these globs
    defer: ["integration-*"]     # owed may retain shared intermittent invariant debt (§7.24, 0.23)
  - adopt: ["testdata/", "tasks/"]   # parent may adopt trunk commits whose changed paths all lie under these
```

`allow` is not an obligation: it is not part of any key and changing it never
invalidates a candidate.

- **Coverage.** A downgrade of a plan update is *covered* when a rule of the
  **prior** plan (never the new one) whose `nodes` match the node permits it:
  review count (rank) lowered to a value ≥ the rule's `review_count`
  (`review_rank`); every widened writes scope is provably covered by a rule's
  `writes` scope under §3.7; a check weakening (removed, red disabled, `min_tests`
  lowered, mutants removed/changed, `min_kill` lowered, definition changed)
  whose check id matches one of the rule's `checks` globs; an evidence obligation
  removed or weakened (`evidence <id> removed`, `evidence <id> weakened`, §3.3)
  whose evidence id matches one of the rule's `checks` globs. An item that reads
  both ways (e.g. check id `evidence`, evidence id `check`: `evidence check
  removed`) is covered only if every reading is. Never covered:
  `approve removed` (the owner's gate), `node removed`, `dependency removed`,
  any downgrade of trunk invariants, the
  plan-level `*` items (setup/closure changed, exec changed), and `allow`
  changes. Any change of `allow` other than deleting whole rules (some new rule
  deep-equals no prior rule, after defaults) is the downgrade
  `{node: "trunk", what: "allow changed"}`: owner only.
- **Parent plan updates.** A `plan` entry by a parent whose downgrades (the
  detected ones and those the entry lists) are all covered is valid without an
  owner — a reducer rule, so it also holds on replay. The downgrades still enter
  ΔO⁻; every view labels them `by parent:<id> under allowance (plan #S)`, where
  S is the seq of the latest genesis/plan entry that changed the `allow` block
  before that update. An uncovered downgrade still needs the owner; the refusal
  for a parent lists the uncovered items, each downgrade once: a listed item is
  left out when the same downgrade is already listed in its detected wording
  (`review count lowered` under `review count/rank reduced`, `check <id> removed`
  under `<id> check removed`, `writes widened` under `writes scope expanded`, …).
  When every uncovered item widens writes, the refusal (CLI and `owed_plan`)
  adds one line (0.6.1 H2.1, `writesHint`): `hint: an allow rule {nodes:
  ["<ids>"], writes: ["<new prefixes>"]} in the prior plan would cover this`,
  the new prefixes being those under neither the node's prior writes nor a
  matching prior rule. Recommended practice: keep writes strict and
  pre-authorize at plan time the prefixes integration/packaging nodes need
  (entry files, `package.json`, wiring directories).
  For a changed check definition (0.10, N2), the detected item names the changed
  fields among `run`, `timeout_s`, `reads`, `tests`, `red_expect`, in that order:
  `<id> check definition changed (run, reads); owed cannot compare commands, so
  this needs owner authority or an allow rule; to avoid it, add the new command
  as a new check id`. Detection and allowance coverage are unchanged.
- **Check-less nodes** (0.6.1 H2.2). `owed init` / `owed plan` (CLI and pi
  tools) warn, refusing and recording nothing, for each node of the new plan
  with no checks and no evidence obligations: `warning: node <id> has no
  checks: its acceptance rests on review alone`. The CLI prints them after the
  result; `--json` and the pi tools return `warnings: string[]`.
- **Looped checks** (0.8, L3.3). After the check-less warnings and
  printed the same way, one warning per check or invariant that sets
  `min_tests` and repeats its command in a shell loop (`for|while|until … do`,
  or `seq N` in command position, as in `seq 5 | xargs …` or `$(seq 5)`):
  `warning: check <id> of node <node>` (or `invariant <id>`) `runs its command
  in a shell loop with min_tests <m>: min_tests counts only the last TAP (#
  tests), jest/vitest (Tests:) or pytest (N passed) summary in the log, i.e. one
  run, not the sum of the runs (only cargo "test result:" lines are added up)`.
  That is the actual rule of `parseCounts` (§7): each later TAP `# tests`/`#
  pass`/`# fail` line (else the last `1..N` plan), `Tests:` summary or pytest
  terminal summary replaces the earlier one. Pytest summaries are bounded by
  `=` runs or end in `in <seconds>s` (optionally ` (<h:mm:ss>)`); the body is
  only comma-separated `<n> <word>` items (`passed`, `failed`, `skipped`,
  `error`, `errors`, `xfailed`, `xpassed`, `deselected`, `warning`, `warnings`,
  `rerun`), with warnings, reruns and deselected excluded from test counts.
  Zero-test forms are line-anchored (optional leading whitespace and `=` runs):
  pytest `no tests ran` (optionally `in <seconds>s`) or `collected 0 items`,
  and jest `No tests found` at the start of a line; free-text mentions do not count;
  cargo `test result:` lines are summed. Nothing is refused or recorded.
  In 0.10 (N2), both warning kinds skip nodes merged in the current ledger on
  `owed plan`; invariant warnings remain. `owed init` warnings are unchanged.
  In 0.11 (F4) a looped check whose command runs `cargo test` (also
  `cargo +<toolchain> test`) gets no warning: its `test result:` lines are summed.
- **Parent adoptions** (§6.6): `adopt` by role parent is valid iff every path of
  `changed` matches an `adopt` scope of a rule of the **current** plan and
  `adoptGuard` passes. No owner channel is needed.
- **Writes grants (0.22, GR / WG).** At measurement, owed grants independently eligible
  newly out-of-writes paths covered by an owner-written `allow.writes` rule.
  It appends one sorted `grant` before the writes observation, which passes
  only if no refused paths remain (§7.19), without a plan edit,
  ruling or parent round trip. A ruling still never accepts out-of-writes paths.
  Every replay validates the grant: only `executor:owed`; matching open node/attempt
  and current candidate commit; nonempty sorted unique exact repository paths, all
  in the candidate's `changed` and outside plan writes; current `writesAllowed`
  coverage and `allowanceSeq`; no closure match or path owned by another open slot's
  effective writes; no path previously granted to the attempt. Refused paths
  retain their reasons (`not covered by an allow rule`, `under closure`,
  `overlaps open node <id>`), while unrelated eligible paths still receive grants.
  Effective writes are plan scopes plus exact granted paths (not new prefixes),
  used for measurement, merge recheck and dispatch/grant overlap. Grants survive
  candidate, rebase, plan and allowance changes within the attempt; a new attempt
  starts without grants. A current `allow_only` cap filters old grants out of
  effective writes while keeping their audit receipts (§3.4.1).
  Attribution reruns retain the original writes measurement.
  The writes key remains `H({o: "writes", base, cand, writes: node.writes})`
  for legacy/wildcard-free scopes; syntax-2 wildcard scopes also include
  `writes_syntax: 2` (§3.7).
  The pass note is `all changed paths within writes (granted #<seq>: <paths>)`
  (multiple relevant grants are separated by `; `).
  Each grant enters ΔO⁻ as `{node, what: "writes granted: <paths>"}`, with
  `by: "executor:owed"` and `allowance`, labelled everywhere
  `granted by owed under allowance (plan #S)`. Owed 0.16 refuses any ledger
  containing a grant (unknown kind); grant-free ledgers retain their keys and states.
  Dispatch packets add `Pre-authorized by the owner (allowance plan #S): <prefixes>
  — change files there only when the task needs it; owed records the grant; do not ask.`
  Review packets (including driver reviewers) add `Writes granted under allowance
  (plan #S): <paths> — judge whether each belongs to this node's task; block if not.`

### 3.4.1 Node allow-grant caps (0.30, AO)

Optional node `allow_only: string[]` caps only what matching `allow.writes` rules
may grant. It does not narrow the node's own `writes`, grant permission without
an allow rule, or change check, review, defer or adopt permissions. Each literal
entry is an exact repository path (not a prefix); entries with `*`, `?` or
whole-segment `**` use §3.7 syntax-2 whole-path matching. Omission is unbounded;
`[]` allows no grants. Types and path hygiene are validated on plan admission.

New grants and the effective paths of previous grants must satisfy both the
allow rule and cap. Closure and other open-slot ownership still refuse grants;
partial eligible grants are retained. A capped path reports
`<path>: outside allow_only of <node> [<entries>]`, with the hint
`owed edit <node> --set allow_only=[...]`, not an allowance-widening hint.
It never becomes an overlap-only wait. Writer packets print the cap next to
pre-authorized scopes, and no longer say all paths there may be edited freely.

Only the writes key gains `allow_only` when present, including `[]`; other
check/review keys and all uncapped keys are unchanged. A plan update carries an
open candidate normally, but a changed writes key requires fresh evidence.
Adding a cap to an unbounded node, or provably narrowing it, needs parent
permission. Removing or widening it is `allow_only widened: <node>` and requires
the owner; allow rules cannot authorize that downgrade. Containment is proved
by equality, an exact path matched by a prior glob, or an enclosing trailing
`**` glob; an unproved wildcard relation conservatively needs the owner.
`owed edit <node> --set 'allow_only=[...]'` and `--unset allow_only` use the same
policy.

### 3.5 Candidate size limits (0.14, BD)

Optional top-level `limits: {file_mib?: number, diff_mib?: number}` contains
positive finite numbers in MiB (1 MiB = 1,048,576 bytes; fractions allowed).
Unknown fields, non-numbers, zero, negative and non-finite values are usage
errors. `owed submit` / `owed_submit` inspects the candidate's added/changed blob
ids with `git diff --raw --no-renames` and sizes with `cat-file --batch-check`,
without reading their content. `file_mib` bounds the largest changed candidate
blob; `diff_mib` bounds their summed full sizes, once per changed path even when
paths share a blob. Mode changes count; deleted files and gitlinks contribute
zero. An exact limit is allowed. Exceeding either limit refuses with code
`refused`, the limit and up to five largest changed files with byte/MiB sizes;
nothing is appended to the ledger. The writer receives this as an ordinary
submit refusal through the existing writer command path.

With neither limit set, submit performs no size check. Limits are submit policy,
not an obligation: they enter no key, do not invalidate existing candidates, and
are not rechecked at merge or when carrying a candidate. Compatibility: BD adds
no ledger entry kind or field. Without limits the ledger replays with the same
states, keys and views as 0.13. Earlier owed ignores the plan field; use 0.14+
when enforcing limits.

All buffered `git()` calls have a combined stdout/stderr bound of 256 MiB by
default (clamped to the runtime's string limit). Output above the bound stops
the process and returns `OwedError` code `refused` naming the subcommand,
including with `allowFail`, before concatenating or decoding buffers. This
covers other diffs, plan `show` and mutant `cat-file blob` content reads. The
review diff streams stdout into a UTF-8 decoder and hash (§4); its stdout has
no buffering bound, while stderr remains bounded.

### 3.6 Quarantine, shared sets and check templates

An invariant or node check may set `quarantine: [{test, fix, note?}]`: at most
20 entries, unique exact non-empty test names, non-empty fix ids and optional
non-empty notes; unknown entry keys are refused. Each `fix` must name a node of
the current plan, otherwise validation reports `invariants: <inv>: quarantine
fix <id> is not a node of this plan` (or `<node>: check <id>: ...`). Adding a
name or changing its fix is an owner-only downgrade, never covered by an
`allow` rule: `inv:<id> quarantine "<test>" added with fix <fix> (owner only)`
or `check <id> ...`; reassignment says `fix changed from <old> to <new>`.
Deletion is free; changing only a note does not widen the excuse.

Entries are active while the fix exists and has not merged. The fix's own
prospective merge is measured with its entries already inactive, so that fix
must repair the test. The key includes sorted active test names; with none the
hashed field is absent and the key equals 0.17's. A fix merging changes current
trunk/merge keys and forces fresh measurement. An open candidate's stored
check keys are not recomputed solely because a fix merged (§7.17). Editable
paths include invariant `quarantine` and `checks.<id>.quarantine`. Quarantine
is not `known_red`: it excludes tests from counts only under §7.16's proof.

Top-level `quarantine_sets` defines reusable lists; a check or invariant selects
one defined name with `quarantine_set`, optionally alongside its own entries:

```yaml
# Plan excerpt; repair must also be a node in nodes.
quarantine_sets:
  intermittent:
    - {test: "exact failing name", fix: repair, note: "bounded known risk"}
invariants:
  - id: unit
    run: cargo test --no-fail-fast
    quarantine_set: intermittent
```

Set names match `[A-Za-z0-9_.-]+`; each set permits at most 200 entries.
Entry validation is as above, with no control characters in set test names.
A test in both the own list and selected set is refused, even if inactive;
every fix must name a plan node. Active names are the union of own and set
entries, sorted in the existing key field, not a separate set-name key.
Fix merges disable both kinds of entry, including that fix's prospective
merge tree (all batch members are treated as merged for batch measurement).
Adding a set entry, changing its fix, or adding/changing a `quarantine_set`
reference is an owner-only downgrade, never covered by `allow`; removals and
note-only changes do not widen the excuse. Editable check/invariant paths
include `quarantine_set`; change set mappings through the recorded plan file.
A referenced set's entries also enter the check definition (§6.3), so changing
them can supersede an old block just like changing own quarantine. Unreferenced
sets affect neither that check's definition nor its key.

When any sets exist, new/changed Cargo or Node test commands with neither
`quarantine` nor `quarantine_set` receive `warning: inv:<id>` (or
`check <node>/<id>`) `runs tests without a quarantine set (sets: <names>)`.
This is admission guidance, not an acceptance gate; even an explicit empty
own list suppresses it. Changes compare run, reads and timeout (§9.7).

A check/invariant may use `run_file: {path, sha256}` **instead of** `run` or
`template`, with optional `args` (at most 64 strings, no NUL). `sha256` is exactly
64 lowercase hex characters. The path is normal and repository-relative: no
leading `/` or `./`, empty segment, trailing `/`, or `.`/`..` segment. Each
segment must match `^[A-Za-z0-9._@+,=-]+$`; whitespace, shell metacharacters,
globs and backslashes are refused. This restricted alphabet keeps the derived
command safe without quoting its path. The parsed plan retains `run_file` and
`args` and derives `run` as `exec ./<path>` followed by each argument
single-quoted, replacing each embedded `'` with `'\''`, separated by spaces.
A supplied `run` is accepted only if identical to that derived command (so
canonical stored plans reparse); otherwise `run and run_file are exclusive`.
`args` without `run_file`, and `template` with `run_file`, are errors.

Before recording a plan (init/start/plan/edit/amend/decide with plan changes),
for each pin not already present in the ledger blob store, owed reads the script
from the current worktree's repository root, or from the commit selected by
`plan --rev`, verifies its SHA-256, and stores its bytes. Missing files or hash
mismatches refuse before recording any ledger entry or replacing an edited plan
file. Refusals name `run_file <path> of check <node>/<id>` (invariants use
`inv:<id>`), then `not found in <source>` or
`sha256 <actual>, the plan says <declared>`. Replay never reads source files.

After setup and overlays, immediately before every actual run (including red,
mutants, invariants, attribution, trunk probes and each repeat), owed verifies
and installs the stored blob at that path with mode 0755, creating parent
directories. Candidate script bytes are overwritten; symlinked parents and
paths leaving the measured tree are refused. A target symlink or hard link is
replaced, never followed. A missing/corrupt blob or installation failure is an
error with `environment: run_file <path>: <reason>`, never a successful red
counterfactual. Shell, wrap, env and timeout semantics remain unchanged; the
script must have a usable shebang. Only this script's bytes are pinned: files it
loads still follow ordinary `reads` and closure rules.

Check/invariant, red and strength keys include `run_file: {path, sha256}` and
`args` only for pinned checks. The full check definition includes these fields.
Checks without `run_file` retain their existing plan shape, keys and replay.
Shell lint skips only the derived command (not setup or timeout diagnostics).
Plan/edit replies show `check <node>/<id>: run_file <path> (sha256 <first 12>)`.
Editable paths include `checks.<id>.run_file.path`,
`checks.<id>.run_file.sha256`, `checks.<id>.args`, and invariant `run_file.path`,
`run_file.sha256`, `args`. Editing a canonical pin or args regenerates its
stored derived command unless `run` is explicitly assigned too; explicit
conflicting `run` remains an error.

A check/invariant may use `template` **instead of** `run`. Loading expands it
deterministically into `run` and, for test templates, `min_tests = min_ok`;
no template metadata remains in the parsed plan. A handwritten identical
expanded run/min_tests has identical keys. Supported keys:

| template | Required | Optional |
|---|---|---|
| `cargo-tests` | non-empty `package`, safe integer `min_ok >= 0` | non-empty `test` (integration target), `filters` array (default `[]`) |
| `node-tap` | non-empty `files` array, safe integer `min_ok >= 0` | non-empty `name_prefix` (literal anchored prefix) |
| `evidence-json` | non-empty `path`, non-empty `required` field-path array | existing explicit `min_tests` |

Strings reject NUL; list items must be non-empty strings. `required` paths use
dot-separated own-property segments with no empty segment; numeric segments
address array indexes. Presence, not truthiness, is checked: `false`, `0`,
`""` and `null` count as present. Template-specific keys from another template
are refused. For test templates explicit `min_tests` must equal `min_ok`.
Templates do not infer `reads`, red `tests` or closure. Existing timeout, red,
repeat and closure rules apply; dependencies are not installed.

Errors name the full check/invariant field path and record no plan:
`<field>.template: unknown template <value>`, `<field>.run: cannot be combined
with template`, `<field>.<key>: not supported by template <template>`,
`<field>.min_ok: expected integer >= 0`, `<field>.min_tests: must equal template
min_ok`, `<field>.required[<i>]: expected dot-separated field path without empty
segments`, and string/list errors `expected non-empty string without NUL` /
`expected a non-empty array of non-empty strings without NUL` (`filters` allows
an empty array).

**Frozen expansion v1.** `CHECK_TEMPLATE_VERSION = 1` in `src/plan.ts` controls
both expansion and recognition. A future semantic change must use a new marker
version. Define `Q(x)` as single-quoting x, replacing each embedded single quote
with `'"'"'`. Arrays preserve input order. Each command starts with exactly
`# owed-template/v1/<template>` plus a newline, followed by:

- Cargo: `set -o pipefail; cargo test -p Q(package)[ --test Q(test)] --[ Q(filter1) Q(filter2) ...] | node -e Q(cargoCounter)`.
- Node: `set -o pipefail; node --test --test-reporter=tap[ --test-name-pattern=Q(^escapedPrefix)] -- Q(file1) Q(file2) ... | node -e Q(tapCounter)`.
- Evidence: `node -e Q(evidenceScript) -- Q(path) Q(field1) Q(field2) ...`.

Brackets denote optional fragments, not literal bytes. Prefix escaping replaces
each regex metacharacter matched by `/[.*+?^${}()|[\]\\]/g` with a backslash
plus that character. Files are quoted argv (not shell-expanded globs); the
Node runner may apply supported file patterns. Counter/script bytes are the
frozen `templateCounter` / `expandCheckTemplate` implementations in
`src/plan.ts`; their exact counting contract is §7 RC2. Templates require Bash
and Node, and `cargo-tests` additionally Cargo. The expanded run is shown in
packets, keys and receipts, not the template declaration (§9).

### 3.7 Writes patterns and shell admission (0.22, WG / PL)

Node `writes`, `allow.writes` and `allow.adopt` accept literal prefixes or
whole-path globs: `*` matches characters except `/`, `?` matches one such
character, and whole-segment `**` matches zero or more segments. `dir/**`
is equivalent to prefix `dir/`. Literal prefixes keep `startsWith` semantics,
including when no trailing slash is present. Other regular-expression
punctuation is literal. New plan inputs refuse absolute paths, parent-traversal
segments, bracket/brace/negation syntax, backslashes and embedded `**` segments,
identifying the offending entry. Plan set/edit/amend may retain an invalid
legacy entry in the same node or allowance position; newly introduced invalid
entries still refuse. Permission and downgrade checks still apply, and recording
a new plan opts into syntax 2, including wildcard semantics. `amend --writes`
accepts comma-separated bare paths or `+PATH`; covered additions are no-ops
(§3). Historical plan parsing remains lenient.

Containment proves coverage only by equality or an enclosing literal prefix
(including trailing `/**` equivalents). A glob can authorize a grant for an
exact file without proving that a requested scope widening is covered.
Unproven widening requires the owner. Overlap is conservative: scopes may
intersect unless their literal prefixes before the first wildcard are disjoint.
The same matching rules govern writes, grants, adoption and merge rechecks.

Newly recorded genesis/plan entries carry optional `writes_syntax: 2` metadata,
or `writes_syntax: 3` if any node has `allow_only` (including `[]`). Syntax 3
retains syntax 2 path matching and activates caps; 0.29 readers refuse version
3 rather than ignoring its permissions. This is not a YAML key. Plans without
caps continue recording version 2. In historical syntax 1/2 entries a valid
`allow_only` is ignored as before. A pre-0.30 plan containing a malformed node
`allow_only` field is refused by 0.30 replay. Without it, entries retain 0.20 literal-prefix semantics,
including literal `*`, `?` and brackets. Replay, snapshots and attribution use
the recording entry's dialect, not the plan blob hash. Runtime plan copies
retain that dialect without adding it to plan JSON or changing its content hash.
Historical and wildcard-free writes keys stay unchanged; syntax-2 wildcard-bearing node
scopes include the dialect in the writes key. Switching wildcard scopes or
allowances is checked as a permission change and may require the owner.

Plan admission (`init`, `plan`, `edit`, `amend`, including edit dry runs)
checks new or changed shell commands with `bash --noprofile --norc -n` before
publishing the plan. This covers expanded check/invariant templates, `setup`,
string `slot_setup`, `on_timeout`, and expanded string `exec.wrap` templates.
Statically resolvable nested `bash -c`/`bash -lc` scripts are checked recursively
without executing expansions; ordinary arguments, comments and here-document
data are not invocations. Supported command positions include absolute Bash
paths and common `env`/`command`/`exec` prefixes. Sweep commands are linted too.

Syntax refusal identifies the command and first Bash error and asks to fix it.
Identical commands at the same identity are skipped; old invalid commands
remain loadable until changed. Missing Bash warns once per successful admission
in text and JSON `warnings`; install Bash and record the plan again. Other
lint execution errors refuse. Each syntax process has a five-second limit and
bounded output. Lint runs outside the ledger lock with normal plan/trunk CAS,
changes no measurement key and is not acceptance evidence.

### 3.8 Diff risk classes and neutral closure changes (0.24, RK)

The owner declares optional top-level ordered `risk` rules and exact-file
`closure_neutral` policy in the plan:

```yaml
risk:
  - paths: ["docs/**", "README.md"]
    review: {count: 0, min_rank: 1}
  - paths: ["src/**"]
    review: {count: 2, min_rank: 2}
closure_neutral:
  - path: package.json
    json_ignore: [version]
  - path: package-lock.json
    json_ignore: [version, "packages..version"]
```

Each rule has a nonempty list of `paths`, using the writes grammar (§3.7):
literal prefixes, `*`, `?` and whole-segment `**`. `review.count` is a
nonnegative integer and `review.min_rank` an integer 1..3. The FIRST matching
rule wins for each changed path; unmatched paths use the node's own review.
Count and rank are independently maximized over the candidate's slot-base
diff (§6.2a), not selected by a writer or parent act. Unknown nested fields,
invalid shapes, ranges or scopes refuse.

A policy change that can lower either review dimension records the downgrade
`{node: "trunk", what: "risk changed"}`. Only the owner can authorize it;
no `allow` rule covers it. Comparison respects first-match order, unions and
the writes languages: removing a lowering class, pure raises and shadowed
changes that lower nothing need no downgrade. `risk` itself enters no evidence
key and invalidates no candidate; the current policy immediately determines
which recorded reviews suffice.

`closure_neutral` is a list of `{path, json_ignore}` with unique exact
relative file paths and string dot paths. For a changed file matching the
closure, owed parses base and candidate JSON and removes only the named own
properties before comparing the remaining values. Segments are literal:
`packages..version` addresses `version` under the empty-string key in
`packages`. Dot paths have no wildcards or inherited-property lookup.
Ignoring an array element does not ignore array length or other elements.
Missing files or invalid JSON are never neutral; an empty ignore list can
still exempt formatting-only JSON changes. Files outside the closure do not
acquire a closure-review obligation by being listed here.

Adding a neutral file or broadening ignores records
`{node: "trunk", what: "closure_neutral changed"}`, owner-only and never
allowance-covered. Narrowing/removing ignores is a raise. Policy changes
recompute open candidate facts through plan carry (§3); unchanged keys retain
evidence. Check and invariant keys still hash the complete closure file,
including ignored properties: neutrality skips no required measurement and
never bypasses the merge guard.

### 3.9 Sweep scheduling policy (0.24, SW)

Optional `sweep.every: {merges?: N, minutes?: M}` extends the advisory suite
in §7.15. Thresholds are positive integers; at least one is required and
unknown fields refuse. Either threshold makes a sweep due. For example:

```yaml
sweep:
  run: node --test --test-reporter=tap 'test/**/*.test.ts'
  timeout_s: 900
  every: {merges: 10, minutes: 30}
```

Scheduling is not part of the sweep definition key or any acceptance key.
Absent `every`, staying drivers keep idle-only scheduling and node-work
preemption. Running-loop and `--due` behavior, baselines and limits are in
§7.15b.

### 3.10 Check author diagnostics and selftests (0.30, CT)

`owed check try <node> <check> [--red <rev>] [--green <rev>] [--plan <file>]
[--no-lease] [--json]`, or `owed check try --invariant <id> ...`, tries the
plan file currently on disk, not its recorded blob. `--plan` selects the file;
otherwise use the latest plan entry's path (an entry without a path requires
`--plan`). At least one revision is required. Run-file admission is §3.6,
including checks not yet recorded.

Each revision resolves to a commit and runs in a fresh temporary worktree of
exactly that commit: no closure replacement, test overlay or tree reuse. Setup,
command shell/env/wrap, timeout/on_timeout, counts, min_tests and repeat follow
attest. Even `red: true` is measured as an ordinary non-red check. Red expects
`fail`, green expects `pass`; `error` satisfies neither. The shared machine
lease applies unless `--no-lease` or plan `lease: false` disables it. Trees and
processes are cleaned on completion and abort; output remains in verified log
blobs. No observation or other ledger entry is appended.

For each revision print `red <rev> (<commit12>): fail ✔ (<passed>/<total> tests,
<seconds> s) log <path>`, or `✘ expected fail, got pass` followed by the last
20 output lines. JSON is `{node|invariant, check, plan, results:[{side, rev,
commit, expect, verdict, ok, counts?, durationMs, log}]}`. Exit codes: 0 all
expectations met, 1 any unmet, 2 usage (including unknown revisions), 75 machine
lease busy. Tool parity is §11.

Optional check/invariant `selftest: [{commit: <40 or 64 hex>, expect: pass|fail}]`
has 1–8 entries; each entry permits only `commit` and `expect`. Editable paths
are `checks.<id>.selftest` and invariant `selftest`. Fixtures are author
metadata: no key, downgrade, candidate invalidation or block supersede depends
on them. Adding, changing or removing just fixtures preserves acceptance
observations and failures; a selftest pass itself is never acceptance evidence.

Before recording init/start/plan/edit/amend/decide plan changes, run selftests
for every new check/invariant, changed execution definition (without fixtures),
or changed fixture list. Run them exactly as the diagnostic path above, under
one shared lease and outside the ledger lock. Unmet expectations, execution
errors and unknown commits refuse recording with diagnostic lines and log tails;
no ledger entries or edited plan file are written. Successful recording adds
one existing-kind `note` immediately after genesis/plan in the same append:
`selftest/v1 ` followed by JSON `{plan:<plan sha>, results:[{node|invariant,
check, commit, expect, verdict, log}]}`. Carry/rule/resume entries follow it.
Unchanged checks are not rerun. Replies list the results and warn for each new
or changed check without fixtures: `check <node>/<id>: not self-tested` (use
`inv:<id>` for invariants). Dry runs and tool previews never execute fixtures;
they say `selftest: <n> check(s) run when recorded`.

## 4. Items and keys

An item is `(subject, obligation, key)`; status is evaluated per item.
All keys are sha256 hex over canonical JSON.

- `readsDigest(commit, globs)` = sha256 of the sorted list of `[path, mode, blobOid]`
  for files of `commit` matching any glob (the mode is content: an executable bit
  or symlink changes behavior).
- `closureDigest(base)` = `readsDigest(base, plan.closure)`.
- Check item key on tree-bearing commit C with base B:
  `H({o:"check", id, run, timeout_s, setup, min_tests, closure: closureDigest(B), reads: readsDigest(C, reads)})`.
  Because keys use content, a merge commit whose tree equals the candidate's
  tree reuses the candidate's observations automatically.
- Red item key: `H({o:"red", id, run, red_expect, timeout_s, setup, min_tests, closure: closureDigest(B), base: treeOid(B), tests: readsDigest(C, tests)})`.
- Strength item key (checks with `mutants`):
  `H({o:"strength", id, run, timeout_s, setup, min_tests, min_kill, closure: closureDigest(B), mutants: mutantsDigest(B), reads: readsDigest(C, reads)})`,
  where `mutantsDigest(B)` = `readsDigest` over the files of B matching both
  `mutants` and the closure. It changes when the candidate's read set, the check
  or any mutant changes.
- Writes item key: `H({o:"writes", base: B, cand: C, writes})`.
- Closure-review item (exists iff diff(B,C) touches a closure glob):
  `H({o:"closure-review", patch})`.
- Review item key: `H({o:"review", patch})` where `patch` = sha256 of
  `git diff --binary --full-index --no-renames B C` after UTF-8 decoding with
  U+FFFD replacement and UTF-8 re-encoding (empty diff → sha256 of ""). Since
  0.14 (BD1), stdout is decoded and hashed incrementally, preserving 0.13's
  `Buffer.concat(out).toString()` semantics even for invalid UTF-8 and characters
  split across chunks. The diff string is never built in memory. Not `git
  patch-id`: it ignores whitespace, which can change meaning.
- Check ids may contain `:`; an obligation name splits only at its first colon.
- Rulings item: `H({o:"rulings", attempt})` (§5.6).
- Invariant item on trunk state S: `H({o:"inv", id, run, timeout_s, setup, min_tests, closure: closureDigest(S), reads: readsDigest(S, reads)})`.

### 4.1 `exec` in keys (D20)

When the plan's `exec` has a non-empty `env` or `wrap`, or an explicit `touch`,
every check, red, strength and invariant key above also contains
`exec: {env?, wrap?, touch?}` (only the non-empty/explicit fields). Otherwise
the field is absent and keys are byte-identical
to 0.4.1 (`exec: {}` = no block). Writes, closure-review, review and rulings
keys never contain it. The key names the wrapper argv, not where the wrapper
ran: a remote-host wrapper is trusted by its argv. `exec.parallel` and `exec.trees` (0.9, §7.12) are
never part of a key.

## 5. Ledger entry kinds

| kind | by | payload | effect |
|---|---|---|---|
| `genesis` | owner | `{trunk, commit, plan}` (plan = blob sha) | names s₀ and the plan |
| `plan` | owner/parent | `{prior, plan, rev?, path?, note?}` | new plan; must cite current plan sha (CAS); downgrade needs owner, unless the parent's downgrades are all covered by an allowance of the prior plan (§3.4); `rev` = commit the plan file was read from (`owed plan --rev`), `path` = repository-relative plan file |
| `rule` | owner/parent | `{text, nodes: string[] \| "*", writer?: boolean, prospective?: boolean, answer?: {rid, qid, rev}, supersedes?: number}` | ruling; in scope for those nodes; `prospective: true` binds only later dispatches (§6.2 PR); `writer: true` invalidates named open candidates (§6.2); AN2 answer: one node, `writer: false`, recorded before dsa delivery (§12.5) |
| `dispatch` | parent | `{node, attempt, base, branch, worktree, packet, rulings_seen: number, overlaps?: string[]}` | opens writer slot; `rulings_seen` = seq of latest ruling in packet; `overlaps` = nodes with an open slot whose writes overlap, present only when dispatched with `--allow-overlap` |
| `rebase` | parent/owner or the slot writer | `{node, attempt, base, from}` | moves the open slot from base `from` (the current slot base) to `base` (the current trunk, which must differ); the open candidate is invalidated; blocks keep binding the node |
| `submit` | writer; executor (carry) | `{node, attempt, commit}`; carry: `+ carry` | candidate claim (speech). 0.10 (N1): a submit by `executor:owed` must have `carry` = the latest submit of the open attempt, with that submit's commit and base, while the slot is open, the node has no current candidate and the slot base is still that base; a writer submit never has `carry`. Needs owed ≥ 0.10.0 to replay |
| `grant` | executor:owed only | `{node, attempt, commit, paths, allowance}` | 0.17 GR: sorted exact out-of-writes paths, candidate commit and current allowance plan seq; validated on every replay (§3.4), effective only for this attempt; owed 0.16 refuses this kind |
| `obs` | executor | `{subject, obligation, key, verdict, exit, counts?, log, durationMs, commit, base, attribution?, merging?, probe?: "trunk", infra?: number}` | trusted observation; `merging` = node being merged when `owed merge <node>` produced it (invariants and checks on the merge result, pass or fail); a node obs must name its own subject, and the node must have an open candidate. `probe: "trunk"` (0.14, TR) measures that node's check on current trunk alone; subject = node, commit/base = trunk, no merging/attribution; diagnostic only, never satisfies or blocks an obligation |
| `review` | reviewer/owner | `{node, attempt, key, verdict: "ok"\|"block", rank, note, ack_rulings?: number, clears?: number[], needs?: "parent"}` | judgment observation on review/closure-review item; `needs: "parent"` only on a block (refused on ok): the fix needs a parent ruling (§12.5); on obligation `approve` (D23, §6.2 item 8) only by the owner (rank 3) |
| `waive` | owner | `{node, obligation, key, reason, accept_risk?: number[]}` | waiver of one item; accept_risk cites block seqs it knowingly overrides |
| `defer` | owner | `{node, items: {id, key}[], reason}` | deferral of invariant items for one merge (stays debt) |
| `abandon` | parent/owner; `parent:drive` only for its own never-launched stale slot | `{node, attempt, reason}` | closes a writer slot; `reason` is the `--note` text; `--hold` appends the following entry atomically |
| `hold` | parent/owner | `{node, abandon, reason?}` | immediately follows the same actor's abandon; `abandon` is its seq; holds the node until resume or removal from the plan |
| `merge` | executor | `{node, attempt, prior, commit, tree}` | trunk advanced (CAS on prior) |
| `note` | any | `{text}` | speech, no effect |
| `adopt` | owner, or parent under an `adopt` allowance (§3.4) | `{trunk, prior, commit, state, changed, commits, note}` | external commits adopted (§6.6, §8.3.2): `prior` = current ledger trunk (CAS), `commit` = `state.commit` = refs/heads/<trunk> after driver-safe landing when off-ref, a fast-forward of `prior`; `changed` = `git diff --name-only prior commit`, `commits` = number of commits in `prior..commit`; the trunk state becomes `state` |
| `sweep` | executor:owed | `{commit, key?, verdict: "pass"\|"fail"\|"error", counts?, log, failed, bisect?: true, boundary?: {head, merge}}` | advisory detached measurement (§7.15); `failed` at most 50 names; 0.24 confirmed boundary can authorize an automatic escape (§7.15b), never an acceptance observation or block |
| `escape` | parent/owner; executor:owed only with confirmed sweep | `{node, merge, class, note, evidence?, sweep?}` | defect found after a merge (§6.5); `merge` must be the seq of a merge of `node`; 0.24 executor class `missing` cites the boundary in `sweep` (§7.15b) |
| `decoy-commit` | owner | `{digest}` | commitment to a hidden decoy list (§6.5); 64 lowercase hex, not previously committed |
| `decoy-reveal` | owner | `{nonce, decoys: {node, defect}[]}` | opens an earlier unrevealed commitment (§6.5) |
| `launch` | parent (the driver: `parent:drive`) | `{node, attempt, role: "writer"\|"reviewer", rid, spec, labels, rulings?: number}` | driver intent to start a dsa run, recorded before the dsa call (§12); `attempt` = the node's current open slot; `spec` = blob sha of the exact spec JSON bytes; `rid` = `runId(...)` (§12.3; a reviewer rid always carries `:<n>`), unique in the ledger; `labels` = `runLabels(...)`; `rulings` (0.5.1, always written; absent on 0.5.0 entries) = the highest in-scope ruling seq the task carried, 0 when none: an integer ≤ the entry's seq, 0 or the seq of a recorded ruling covering the node (§12.5.1); strict fields |
| `send` | parent (the driver) | `{node, attempt, rid, send, sendKind: "follow-up"\|"steer", message, reason}` | driver intent to send a message to run `rid` (a recorded launch of the same node attempt); `send` = `<rid>:<sendKind>:<seq of this entry>`; `message` = blob sha; `reason` ∈ `submit\|repair\|interrupted\|fenced\|rebase\|review-missing\|ruling\|verdict` (`verdict`: 0.11); `rulings`: reason `ruling` (required) = the highest ruling seq the message includes, the seq of a recorded ruling covering the node; reason `repair` (0.5.1, always written; absent on 0.5.0 entries) = the highest in-scope ruling seq the message carried, 0 when none, under the `launch` rule; reasons `submit` and `rebase` (0.7) the same, written only when the message carried a ruling; forbidden for other reasons (§12.5.1); strict fields |
| `halt` | parent (the driver) | `{node, attempt, reason, needs: "human"\|"owner"}` | the driver stops on the node's current open attempt until cleared; decision/prospective-ruling exceptions are in §12.3; strict fields |
| `resume` | parent/owner (never `parent:drive`) | `{node, attempt, after?, note?, release?: "hold"}` | 0.8: clears the node's driver halt without an obligation and starts a new repair epoch (§12.3); `attempt` = the node's open slot; `after` = another plan node: the node waits until it merges; strict fields. owed 0.7.x cannot replay a ledger with a `resume` entry |
| `evidence` | owner/parent/reviewer | `{node, attempt?, key?, merge?, id, files: {path, sha256, bytes}[], note}` | manual evidence (D23): on a node with an open candidate (`attempt` = current, `key` = its `evidence:<id>` key, no `merge`) it discharges `evidence:<id>` (§6.2 item 9); on a merged node (`merge` = seq of its latest merge, no `attempt`/`key`, files may be empty) an informational receipt; note non-empty, files hashed when recorded (`sha256` 64 hex, `bytes`); strict fields |

`verdict` for `obs` ∈ `pass | fail | error`. `error` (timeout, crash of the
harness, materialization failure) is ⊥: no information, no block.

### Optional display fields and reader extensibility

Any entry may carry `ignorable: string[]`: a non-empty sorted unique list of
its own present fields with defined values. It cannot list `kind`, `by`,
`channel`, `seq`, `ts`, `prev`, `hash`, `decision` or `ignorable` itself.
Malformed metadata produces one `Entry #<seq> invalid: ignorable <why>` error.
A reader honours **every listed field**, not just fields in its writer registry:
unknown listed fields are excluded before validation, state reduction and
diagnostic node scans; known listed fields are still interpreted and validated.
Unknown unlisted fields keep their existing refusal behavior. Unknown kinds,
channels and enumerated values remain refused even when listed. Only top-level
entry fields qualify, never new plan keys or nested receipt members.

The exported `IGNORABLE` registry controls only what this owed writes:
`waive.tracked_by` and `obs.quarantine_passed` are marked when present, after
validation and before hashing. The marker changes entry hashes, not state,
keys, verdicts, blocks or debt for unknown display data. Raw full/JSON data may
retain it. It is not identical-act content; `tracked_by` is (§8.3.3).

- `obs.quarantine_passed?: string[]`: sorted unique active names that actually
  passed in a qualifying native trunk/merge-tree measurement (§7.16).
- `waive.tracked_by?: string`: a plan node or external `ext:<id>` tracker for waived debt (§9.9).

### Optional 0.20 fields on existing entries

- `obs.signatures?: Record<string,string>`: per failed test name, the first
  signature from a run that failed it; absent without error text. **SG1
  (0.20.1):** `v2|` followed by a JSON array of masked first error line,
  innermost repository test stack frame (`path:line`, tree-relative, or null),
  expected value and actual value (each independently masked, at most 120
  characters, or null when absent). Masks replace long hex ids, durations and
  `/tmp/` paths. TAP YAML assertion values and Node assertion diffs supply the
  values, including `undefined` omitted from YAML. Test frames are under
  `test/` or `tests/`, have `.test.` / `.spec.` basenames, or `_tests.<ext>`
  basenames; external absolute paths and node_modules frames are excluded.
  TAP creation-site `location` is display-only when no test frame is found,
  never part of the signature. Historical untagged signatures never equal v2.
  Normalization masks hex ids of 8+ digits as `<hex>`, durations as `<t>` and
  `/tmp/...` paths as `<tmp>`. Used for diagnostic/carry proof, not a new key.
- `obs.quarantined?: string[]`: non-empty list of excused names (§7.16).
- `resume.remeasure?: true`: driver remeasures before the next merge (§7.15a).
- `resume.batch?: number`: seq of the first resume in an atomic batch (§8.3).
- `submit.model?: string`, `review.model?: string`: non-empty actual model
  used, recorded at receipt creation (§12.5.2); not key/acceptance evidence.

These fields add no entry kind. Upgrade all readers together (§Compatibility).

### Trunk invariant refresh and inherited red (0.15, IR)

`refresh` is an executor-only entry `{kind: "refresh", by: "executor:owed",
commit, state: StateFacts}`. `commit` must equal the ledger trunk at that seq,
`state.commit/tree` must match it, and `state.invKeys` supplies exactly the
current plan's invariant ids. It replaces only `trunk.invKeys`; trunk commit,
tree and seq stay unchanged. A stale commit is refused. Compatibility: owed
0.14 and older refuse this new entry kind with code `version`; upgrade CLI,
pi extension and drivers together. Executor check/invariant observations in
0.15 may also carry `execution: {completed: boolean, countOK: boolean}`;
repeat runs carry their own execution object. `completed` means the command
completed without timeout, termination, spawn/preparation/cleanup error;
`countOK` means a positive recognizable test count met `min_tests` (if set).
For repeated observations both booleans are the conjunction of the executed
runs' values. These are executor facts, never inferred from display notes or
test names, and change no command output/log digest or check/merge key. An
observation lacking these fields is never test-only. Owed 0.14 refuses unknown
obs fields with code `version`, including `execution` (verified against
049ca9c); upgrade readers before writing them. Historical entries without new
fields retain their states/keys/views, apart from the not-measured text below.

`owed attest --trunk [--no-lease]` takes no node, `--genesis` or `--rerun`.
The pi tool is `owed_attest {trunk: true}` with no node (optional `lease`).
Under the shared machine lease and `trunk-refresh` lock, it computes current-plan
Git facts on the ledger trunk, appends a refresh if any key differs from its
recorded trunk key, and measures those changed invariants. Observations use
`subject: "trunk"`, refreshed key, commit/base = trunk, no `merging`. Ledger
locks cover computation/append and each result append, never command execution;
a moved trunk or changed plan key drops stale asynchronous observations. An
abort retains completed entries, drops the interrupted observation and kills
its process group. A retry resumes unobserved refreshed keys. Nothing to
refresh prints `Nothing to refresh on trunk; 0 observations recorded` and
records nothing. JSON adds `{refresh?, changed, observations, superseded,
failed, missing, lease?}`; `refresh` is the entry, the string lists contain
invariant ids (superseded contains job refs). Exit 0 means observations complete,
even when tests failed; missing measurements exit 1.

`owed merge` performs this refresh under its existing lease and merge lock,
before merge-result measurements; refresh and trunk observations persist even
when the merge is refused. An otherwise quiet driver pass performs the same
refresh through its background measurement lifecycle and shared no-wait lease.

IR2 permits a differing, unsatisfied merge key without defer only if the recorded
trunk item is decided by an executor fail observation on the trunk commit, both
observations have nonempty, complete `failed` names, the merge failure is
test-only, and all merge failed names already occur in trunk's names. Completeness
requires `counts.fail === failed.length`; repeated failures require complete
per-failing-run lists plus their exact retained union. Incomplete names on either
side refuse as `invariant <id> new debt: failed names truncated; cannot prove
the failure is old`. `testOnlyFailure(obs)` requires verdict fail, names, a
positive known test/fail count, and structured `execution.completed === true`
and `execution.countOK === true`. Repeated failures require those facts for each
failing run (passing runs are allowed); missing structured fields refuse.
Display notes, failed names and bounded output tails never decide this predicate.
Fix-node-owned known-red names are excluded by KR3. Otherwise the guard still
requires a measured pass or owner defer; named new failures read `invariant
<id> new debt: new failures <a, b> (trunk already failed: <c>)`, with the 0.14
reason when names are unavailable. Adopt and owner defer retain their rules.

An inherited red item stays D, discharger parent, detail `trunk-red: inv:<id>
already failed on trunk before <node> (<names>); merge #<seq>`. Status and
`owed why trunk` explain `inv:<id> red on trunk since <merge/refresh #seq>
(<names>); not caused by any open node. Options: assign a fix node (plan), list
the names as known_red with that fix node (owed edit --invariant <id> ...), or
owed sweep --commit <trunk> to find the culprit`. Status JSON may add
`trunkRed: [{obligation, key, text}]`. The driver wakes the parent once per
(invariant, key), never halts a writer for this debt, and continues ordinary node
work. The repo-scoped notice has node `inv:<id>`, not the drift identity `trunk`,
and `invariantRed: {obligation, key}`. `classifyLine` retains that check;
before pi delivery the follower keeps it only while the current trunk's invariant
item on that key remains red (D, ✘). Removal, a changed key or resolved failure
drops it; a failed ledger read keeps the notice. A never-refreshed invariant reads `inv:<id> not measured on trunk yet —
owed attest --trunk`, not `missing fact key`.

### Trunk-red merge refusals (0.14, TR)

When a node `check:X` fails on the prospective merge tree (including reused
merge-result evidence), `owed merge` measures the same check on current trunk
alone before refusing. It runs under the merge's existing machine lease,
setup, execution wrapper/environment and closure pinned from trunk, with its
own check key computed for trunk. The executor records an `obs` with
`probe: "trunk"`, subject = node and commit/base = trunk. A non-error probe
with the same key and trunk commit is reused; errors may be retried. Only
node checks get probes, never invariants, red or strength checks. Probes
are excluded from obligation verdicts, blocks and decoy outcomes, even if
their key equals a candidate or merge key. The final merge CAS and current
plan/key checks discard stale measurements, as for other merge observations.

In 0.29, an automatic or explicit trunk probe whose failed output names a
missing file added by the candidate, but absent from the probed trunk tree,
is recorded as `error`: `probe not applicable: trunk lacks <path>, which the
candidate adds` (escaped, bounded to 160 characters). Absolute paths outside
the measurement checkout are ignored. This diagnostic cannot make a merge
trunk-red; the merge check's ordinary failure still refuses the merge.

A failing probe classifies the merge failure as `trunk-red` when every
merge-tree failed test name is among the probe's failed names, or neither
observation has names. A passing probe, different names, or names on only
one side retains the ordinary refusal. The refusal begins
`trunk-red: check:X fails on trunk <short> without <node> (<names>)`, names
both observation sequences and says this candidate is not shown to be the
cause. The parent can fix trunk with a fixing node (or run the configured
`owed sweep --commit <trunk>` for localization and a confirmed automatic escape), or accept the
merge failure with `owed waive <node> check:X --accept-risk <merge-tree obs seq>`.
Active/flaky block risks retain the existing 0.11 behavior. If attribution has
cleared the original block, `accept_risk` may still cite that node's merge-result
fail for this check, but only if its key equals the key the current merge would
use. `waive` builds the current merge tree and verifies the key under the ledger
lock, checks trunk-ref drift before and after the calculation, and stores that
merge key in the existing `waive.key`. Replay verifies the cited merge-failure
provenance and check/closure definition against the owner-declared key. This
waiver applies only to that key, so the cached failure can be accepted without
remeasurement; a changed key is not waived. A list using this exception must cite
only risks on that merge key; an active risk on another key needs the ordinary
active-block waiver separately. Other cleared/stale observations, including
ordinary failures and attribution results, and all probes are refused with
`accept_risk must reference active blocks for this obligation`. The probe itself
is never a risk to waive, and this exception creates no execution block.

`status` and `why` mark the merge failure's item as trunk-red, with
`discharger: "parent"` and both observation sequences in `detail`; the block's
clear hint gives parent options instead of a writer repair. When the original
block is cleared, the queries calculate the current merge key and show the
still-failing merge item independently of the accepted candidate: `why` has an
optional `mergeChecks` array of item views (with their observations), rendered
under `Merge checks:`; `status` includes the item in the parent pending queue.
Both name the merge-result and current-trunk probe seqs. These read-only
projections do not change the candidate's acceptance or create debt from a
probe alone; a stale failure on another merge key is not projected. Once the
merge key is waived, the diagnostic disappears and that key can merge.
In 0.17 (TP), an open candidate is parked while its nonempty set of binding
blocks (active or flaky, using the existing binding semantics) is entirely
trunk-red on the current trunk. No halt, writer
follow-up, reviewer launch or attest is recorded; asking notices still reach
the parent. A mixed node retains the existing halt/repair behavior, and
`owed merge` refusals and every acceptance gate are unchanged.

The driver emits one repository-level notify per red state, with once-key
`trunk-red\0<trunk commit>\0<obligation>\0<sorted failed names>` (names separated
by NUL). Its text is `trunk-red: <obligation> fails on trunk <trunk12> without
any candidate (<first 3 failed names, +N>); waiting: <node ids>. Fix trunk with
a fixing node or a commit adopted with owed adopt[, or run owed sweep to find
the culprit]; or the owner waives <obligation> on the waiting nodes.` Sweep
advice appears only with a configured sweep; known_red is not offered for
checks. The runtime notify JSON carries `once`, the full once-key including
all failed names, so queued notices are revalidated by identity rather than
truncated display text. Waiting membership is recomputed when pi delivers a
queued notice. `once` is not a ledger field.
Status and brief `summary.needs` have one `trunk` item per red state with empty
`command`, and `summary.progress[].phase` is `waiting: trunk-red (<obligation>
on trunk <trunk12>)`. `why` retains its existing trunk-red hint.

TP5: the existing in-process once set suppresses repeated
notices per driver process and once-key; a restarted driver may print one
repository notice again, but never records a halt for a parked candidate.
There is no new persistence, entry kind or ledger field. Moving trunk
invalidates the old probe and resumes the existing attribution/merge
measurement or rebase route automatically, without a resume entry.
These are diagnostics, not acceptance or a waiver. Classification is recomputed against current trunk
and the current check/closure definition; moving trunk invalidates the old
probe for this purpose. A merge-result fail whose key still matches the guarded
merge key remains valid evidence even when its base predates an unrelated
trunk move; the new current-trunk probe decides its classification.

Compatibility: owed 0.13 refuses the new `obs.probe` field with code
`version`; owed 0.12 and older ignore the field and cannot safely interpret
probes. Upgrade before replaying it. Existing histories without probes retain their 0.13 replayed states and keys;
new merge-key waivers require 0.14's validation and scope interpretation.

### Attribution (0.20, AT1–AT5)

**AT1 merge-tree break first:** an invariant failure on the same merge tree
whose current trunk key passes (without a fail) prevents a node-check failure
on that tree being classified as trunk-red. When trunk moved N >= 1 commits
since the slot base, the FIRST sentence of the CLI refusal, driver halt and
Needs-you reason is `merge tree does not pass <inv>[, ...] (trunk passes);
trunk moved <N> commits since the slot base: rebase → owed rebase <node>`.
It precedes even `Node <node> current candidate is not yet accepted`; no
waive/sweep/adopt trunk-red suggestion replaces the rebase remedy. An unmoved
trunk gets the normal refusal: rebase is not the remedy for the candidate's
own break.

**AT2 new tests:** when a failing merge-tree check's declared `tests` globs
include files absent at the slot base, it is not probed on trunk. The refusal
says `check:<id> runs tests new in the candidate (<files, max 3>[, +N]): its
red reference is the slot base <base12>, not trunk`. Checks without `tests`
retain the existing probe behavior.

**AT3 new submit:** an earlier candidate's merge-tree block no longer parks
the new candidate as trunk-red or triggers the driver's TR3 halt, including
a resume after that submit. The driver attests the new candidate first.
Blocks still bind until attribution/clearance rules discharge them; submission
is not a waiver.

**AT5 defer carry:** an owner defer of a trunk-own invariant failure may carry
to the attempt's next merge key as derived debt, not a new entry. Deferred,
current trunk and current merge observations must each be `testOnlyFailure`
and `failedNamesComplete` (counts.fail equals the number of named failures).
Current names must be a non-empty subset of deferred names, have failed on
trunk before defer and still fail there, and have identical recorded signatures
on all three deciding observations. The current observation must meet
`min_tests`. Timeout/crash, missing counts/signatures, unnamed or new failures
never carry. Success says `defer #<seq> carried (same trunk failure)`; otherwise
`defer #<seq> was bound to merge key <k12> (trunk moved)`. Old observations
without signatures cannot prove carry. This never turns debt into a pass.

### Merge refusal hints (0.16, FH; 0.16.2, TD)

For a failing merge-tree invariant observation measured for the refused node,
the hints show the latest passing observation of the same obligation on the
current trunk, even if the failure has no test names:
`inv:<id>: pass on trunk <trunk12> (#<seq>) → fail on merge tree <commit12> (#<seq>)`.
If the node's current candidate has changed paths, append
`; node diff touches <p1>, <p2>, <p3> (+<N> more)` (at most three paths).
Without a pass on the current trunk, omit this delta; the existing trunk-red
hint still applies. Delta lines appear once per obligation after failure text
and before intermittent-history and fix-candidate hints. The same lines appear
in merge refusals, driver halts, `why` merge-block hints and merge-check details.

**AT4 / SG2–SG3 (0.20.1):** a named merge failure gets
`known intermittent: <name> failed and passed on the same key (#a, #b, #c);
inspect the matching failures before retrying` only when one subject/obligation
key has both pass and failure evidence (also mixed repeated runs). If the
current failure has a signature, a failing observation must match it. A
same-signature failure on trunk alone is **not** intermittent; the refused
node's different trees are not independent evidence.

Current-key trunk failures take precedence. A matching latest failure on the
current trunk invariant key or a trunk probe key at `s.trunk.commit` says
`<name>: trunk red since #S (after merge #M NODE); fix trunk before retrying`
or `(after adopt #A)`. Subject/obligation and recorded run definition must
match. S is the first observation in the uninterrupted sequence of matching
trunk failures; a pass, missing name or different signature breaks the run.
The latest merge/adopt at or before S supplies provenance; without one that
suffix is omitted. This scan uses complete trunk observation history.

Other-tree failures with known different signatures instead say
`same test failed on older trees (different error): <name> (#...)`; missing
signatures claim neither. Generic intermittent/older-tree lookup scans the
last 5000 ledger entries, citing at most three seqs, newest first. These hints
never clear a block or weaken acceptance.

For each failed name of at least six characters, an unmerged node other than
the refused node is a fix candidate when it has an open slot, is accepted, or
is ready, and its title, brief, a check's `run`, or a check's `tests` entry
contains the name verbatim (case-sensitive). The refusal adds
`fix candidate: <node> (<phase>) — owed resume <refused> --after <node>`.
This suggests an existing command; it does not automatically resume or reorder
work. Short names may still have the intermittent-history hint.

CLI `owed merge`, the driver's merge-refused halt reason, and the block line
in `owed why <node>` carry the same hints. `why` also projects hinted failures
on current merge keys under `Merge checks:`, including invariants that have no
node execution block. These are diagnostic text only: no gate, item key,
verdict, ledger entry kind or entry field changes. Owed 0.15 and 0.16 can share
the ledger; replayed states and keys remain identical.

## 6. Reducer (pure: entries → State)

Replay speed (0.10, N4). The fold keeps per-node indexes of reviews, evidence and
waivers, executor observations by item, launches by rid and entries by seq, so
item and validation lookups never scan the whole ledger. After each entry it
recomputes the derived fields (items, accepted, acceptedSince, phase, dependents, stale halt)
only of the nodes the entry can change: every node for genesis, plan and merge
entries, the named nodes (or every node for `*`) for a ruling, the subject of an
observation, the node of any other entry with one; trunk invariants and
`genesisDone` every time.

Acceptance tenure (0.16, MO1). `nodes.<id>.acceptedSince` is the ledger sequence
of the entry since which the node has been continuously accepted with its current
candidate. Losing acceptance clears it; a new submit replaces the candidate and
starts a new tenure when accepted, including when evidence is immediately reused.
Unrelated entries, resumes and trunk movement preserve continuous acceptance.
This is derived State only: incremental replay, packed-state continuation and full
replay produce identical values. It changes no obligation key, acceptance gate or
ledger entry kind/field; 0.15 and 0.16 can share the same ledger. The `slot_setup`
plan field needs 0.16 to take effect; owed 0.15 ignores it as an unknown top-level
field rather than rejecting the plan.

Removed nodes (0.11, F4). A node in the state but absent from the
current plan and not merged has phase `removed` (a merged one stays `merged`).
It is never in the ready list, `dispatch` is refused (`dispatch requires a ready
node with no open slot`), status shows it
under `removed from the plan` and leaves its items out of the pending queue, and
the driver never selects it (no dispatch, and no action on an open slot it may
still have; abandon that slot). `abandon` may close an open slot of a removed
node (0.12); `hold` may immediately follow that abandon (0.14)
without restoring readiness. `owed abandon <node>` closes
its open slot without re-adding the node (the attempt must be the open slot's);
every other entry naming it is still refused (`Node <id> does not exist`).
Until then the open slot counts toward `drive.max` (§12.7). Adding the node to the plan again recomputes its
phase as before. `dependents` (transitive dependents) is computed once
per plan. A deep-frozen plan from the lookup (ops' plan cache) is shared by the
state instead of cloned.

Resumable replay (0.12, G1). `reduce(entries, plans)` stays the reference.
`reduceFrom(base, more, plans)` returns the state of `entries(base) ++ more`
without mutating `base`: one structured clone of the state and its replay
metadata (internal sharing between state and entries kept; deep-frozen plans
shared, other plans cloned) continues the fold; `extendState(s, more)`
continues the fold of a state its caller owns alone. Every such state equals
the full replay of the same entries (`sameReplay`: `util.isDeepStrictEqual` on
the state and on its replay metadata without the plan lookup function), with
the same `validateDraft` decisions and views. The replay metadata names plans by sha (`planObjs`: the plan object
per genesis/plan sha, resolved once per replay; observation plans by sha), so
`packState`/`unpackState` move a state through v8 serialization with plans
re-resolved through a lookup. No query relies on object identity between state
fields and entries beyond the sharing a single clone keeps: entries are compared by `seq`. Ops (§8) load through two caches: an
in-process cache per ledger dir (a serialized packed state at (seq, hash),
refreshed after a load that folded 32 or more entries past it) and the disk
snapshot (§1). When the verified entries contain an entry with the cached seq
and hash, the fold continues from it (in-process first, then disk); any other
change is a full replay. Every load deserializes its own copy, so results of
successive loads never alias. Verification deleting a mismatching snapshot
also drops that dir's memo and increments its invalidation epoch: loads that
started before invalidation cannot refill the memo or leave a stale snapshot
behind deletion. Disk/memo publication and verify deletion share a per-dir
publication queue (no ledger lock acquisition inside it). Old plans from a
resumed state are loaded on first use; missing/unreadable blobs fail then,
including superseded-block view rendering (only "no plan in force" is an
informational fallback). Draft simulations (carry submits, merge-result
and adoption observations, amend's ruling, the merge CAS's plan check) fold the
drafts onto a private copy of the loaded state instead of replaying the
ledger.

Entries of a newer owed (0.12, G1.5). Replay refuses an entry this owed cannot
interpret — an unknown `kind`; an unknown value of an enumerated field (every
entry's `channel`: `tty`, `pi-confirm`, `flag`, `delegated`; `send`
`reason` or `sendKind`, `obs` `verdict`, `review` `obligation`, `verdict` or
`needs`, `launch` `role`, `halt` `needs`, `escape` `class`); an unknown field on
a `rule` (a ruling flag) — with OwedError code `version` and the text `ledger
entry #<seq> (<kind>[ <field> <value>]) needs a newer owed than <x.y.z>:
upgrade owed and restart pi sessions that load it` (CLI exit 1, §10). Every
other invalid entry keeps its error (`Entry #<seq> invalid: ...`). Before 0.12
an unknown kind was ignored and an unknown enumerated value failed as an
invalid entry.

### 6.1 Node lifecycle
- `ready` ⟺ every dep has a `merge` entry, node not merged, no open slot.
- `dispatch` requires ready (or a closed previous attempt) and parent/owner.
- `submit` normally requires an open slot whose writer is `by`, and the commit
  to descend from the slot base. A plan carry submit (§3, 0.10 N1) is by
  `executor:owed` and restores the carried commit; 0.23 also permits an adjacent
  executor rebase submit with `facts.rebased` (§7.25).
  **SB1 (0.22.1):** `submit` (also `--commit`) refuses, recording nothing, a
  commit that already contains trunk commits the slot base does not (the writer
  merged trunk or rebased onto it without `owed rebase`): `merge-base(C, ledger
  trunk)` is not the slot base. The message names the slot base, the latest
  contained trunk commit and the fix: the parent records `owed rebase <node>`
  first (no `--apply` is needed to move the recorded slot base), then in the slot
  worktree the exact `git rebase --onto <trunk> <latest>`, then submit again.
  Otherwise its writes would be diffed against the old base and claim paths
  that other nodes merged.
- `rebase` requires an open slot and a trunk that moved since the slot base;
  the slot base becomes the current trunk and the open candidate is dropped, so
  the node is `dispatched` again in the same worktree and attempt. On the manual
  route the writer uses the computed upstream (§12.5.2) and submits a descendant
  of the new base; eligible executor rebase appends that submit immediately
  (§7.25). The slot keeps the previously submitted candidate (base,
  commit, submit seq) so the receipt can show what was reviewed before and the
  hint `git range-diff <old base>..<old commit> <new base>..<new commit>`.
  Blocks are unchanged: they bind the node, not the attempt.
- Node `accepted` ⟺ current candidate has every node obligation in E ∪ W and no
  active block (§6.3). Node `merged` after a `merge` entry.

### 6.2 Node obligations on candidate C (base B = slot base)
1. `check:<id>` for each check; executor observation.
2. `red:<id>` for each check with `red: true`; executor observation: the red run
   (base tree + candidate `tests` files + pinned closure) must exit non-zero,
   match `red_expect` if given, and not be a zero-test run. `min_tests` does not
   apply to the red run (a new test file often cannot load on the base, so the
   runner reports one failing test); an unknown count format is accepted there.
   `min_tests` applies to every non-red run — the candidate run (`check:<id>`)
   and invariant runs (`inv:<id>`) — and never to the red run. A red run whose
   command exits 126 or 127 (not executable / not found), or that cannot be
   spawned, is an `error` observation, not a pass, even when `red_expect`
   matches. Verdict `pass` means "the counterfactual was rejected as specified".
3. `writes`: every path in `diff --name-only B C` matches the node's recorded
   writes dialect or an exact attempt grant (§3.7, §7.19). **SB3 (0.22.1):** a
   candidate (recorded before SB1) that contains trunk commits after B fails
   `writes` with a one-line note naming that cause, the number of changed paths
   and the SB1 fix, and nothing is granted.
4. `closure-review` iff the diff changes a non-neutral closure path
   (`closureTouched: true`, §3.8, §6.2a): needs a review `ok` with rank ≥ 2
   by a non-writer, or an owner waiver.
5. `review` iff the diff-derived requirement's count is positive (§3.8):
   needs that many distinct reviewers with rank ≥ its derived `min_rank`,
   none of them a writer of this node (any attempt). One recusal
   rule (0.6.0, G2.2) for counting reviews, rulings acknowledgments, evidence and
   for refusing new reviews: a principal is excluded when it is a writer of the
   node or shares a writer's id after the role (any attempt), so a review by
   `reviewer:A#2` stops counting once `writer:A#2` exists.
6. `rulings`: satisfied iff the attempt's `rulings_seen` ≥ the latest in-scope
   `rule` seq, or a later `review ok` by rank ≥ 1 with `ack_rulings` ≥ that seq
   by a principal the recusal rule of item 5 does not exclude.
7. `strength:<id>` for each check with `mutants`; executor observation (§7):
   `pass` means the check killed at least `min_kill` of the base's mutants. A
   `fail` is an execution block like any other. On merge it keeps the candidate's key.
8. `approve` iff the node has `approve: owner` (D23). Key
   `H({o:"approve", patch})` (patch as for review). E ⟺ a `review` entry on
   obligation `approve`, verdict ok, by the owner (rank 3) on the current key;
   reviews of `approve` by any other role are refused. An owner block on
   `approve` is a judgment block (discharger owner), cleared by a later owner
   ok on the current key (any owner id). Discharger owner. Never measured.
9. `evidence:<id>` for each `evidence` item (D23). Key
   `H({o:"evidence", id, what, patch})`. E ⟺ an `evidence` entry on the
   current key with at least one file, by the item's `by` role or the owner, by
   a principal that is not a writer of the node (any attempt; same rule as
   reviews). The ledger refuses other evidence on an open candidate (undeclared
   id, wrong role, a writer, no files). Discharger: the `by` role. Always
   shown as manual, never as measured; the executor never runs it.
   The approve and evidence keys are added to the submit facts by `owed
   submit`; the ledger refuses a submit whose keys are not derived from its patch.

**Writer rulings (0.11, F5).** `owed rule --nodes <node> --writer "<decision>"`
(pi `owed_rule` with `writer: true`) records the optional boolean `writer` on
the ruling. Under the ledger lock, replay invalidates each named node's open
candidate when the ruling follows its submit. The slot and blocks stay; a new
submit is required and may name the same commit. Earlier rulings do not
invalidate later submits. A wildcard `*` remains general guidance and does not
invalidate candidates; an omitted or false `writer` preserves ordinary rulings.
The next action for a sealed writer is a `ruling` follow-up carrying the ruling;
a running writer receives a `ruling` steer. Reviewers of the invalidated
candidate are obsolete. Delivering the ruling does not acknowledge it: the
new candidate still owes the normal reviewer acknowledgment. When the writer
finishes that ruling follow-up without submitting, the driver halts; after a
`resume` it sends the writer rulings again (`Parent rulings for <node> (apply
them; they override your packet):`, the rulings, then — 0.12, G3.5 — the same
active and flaky block lines as the ruling follow-up of §12.5, then the submit
instruction). Compatibility: owed < 0.11 cannot replay a ledger with a ruling
carrying `writer`, nor one with a `send` of reason `verdict` (§12.5).

**Prospective policy (0.14, PR1–PR2).** `owed rule --nodes a,b|* --prospective
"<policy>"` (pi `owed_rule` field `prospective: boolean`) records the optional
boolean `prospective` on the rule entry. When true, the rule binds only attempts
whose dispatch seq is greater than its seq. Older attempts exclude it from
`latestRule`, review packets and acknowledgment requests, so their `rulings`
item stays satisfied if it was satisfied before. Later dispatch packets carry
the policy normally and `rulings_seen` covers it. Omitted or false preserves
0.13 behavior. Combining `--prospective` with `--writer` is a usage error and
records nothing. Compatibility: owed 0.13 and earlier refuse a rule entry with
the `prospective` field (including false) with code `version`; upgrade all
readers before recording it. No obligation key changes.

For each older open attempt, the driver sends the policy once to every
unsealed writer or reviewer run, including an obsolete reviewer, as a `send`
with `sendKind: notify`, `reason: ruling`, and `rulings` = the highest policy
seq carried. These existing send fields identify retry bytes and do not
advance the binding-rulings delivery cursor or acknowledge anything. The
message says this attempt predates the policy and requires no change or ack.
A rejected or conflicting notice never halts; a pending notice retries with
the same request id only while the run remains unsealed. Sealed runs receive
no such policy on later follow-ups and are never relaunched for it. Prospective
policy also does not reset an older attempt's repair budget, clear its halt or
resolve its needs-parent block. Removed nodes receive no prospective notices,
even if their slot remains open; the parent owns closing those slots.

**Wildcard re-ack (0.14, PR3).** When a candidate's only debt is `rulings`, an
undelivered ordinary `*` ruling follows the named-ruling route: send one
`ruling` follow-up to its latest driver reviewer run, or launch a reviewer
when none exists. The message lists the rulings, candidate commit and
`--ack-rulings <seq>`; the reviewer may block if the writer must change
something. If the candidate has no `review` or `closure-review` obligation
(derived review count 0, no non-neutral closure change), the driver instead
sends the undelivered rulings to its writer as a `ruling` follow-up, including the candidate and
`owed submit <node>` (the same commit is allowed). It sends once per ruling set
and waits for that resubmit without a stalled-owner halt; an unaddressable writer
run may still halt under the normal run/send refusal rules. A writer resubmit
records the `rulings` seq of its existing writer ruling follow-ups in the slot's
`rulings_seen`; it does not acknowledge later unsent rulings, prospective notices
or executor carry submits. This uses existing ledger fields and changes no keys.
Prospective notices on older attempts do not enter this route.

Owner reviews use `--rank 3`; another rank is refused with
`owner reviews use --rank 3`.

The report's `changes` (rendered as "Status changes") omit every node merged
at the end of the window, including nodes merged during it. In particular,
later rulings never list a rulings status change for an already merged node;
merge receipts and the rulings audit list are still reported (0.14, PR4).

### 6.2a Review requirements from the candidate diff (0.24, RK)

For each path changed from slot base B to candidate C, use the first matching
`risk` rule or the node's review (§3.8). Required count is the maximum count;
required rank is the maximum `min_rank`, independently. One path outside a
lowering class can restore the node's requirement; a raising class can raise
it. An empty diff retains the node's own review rather than claiming a class.
Closure-review and existing review blocks remain independent gates. The
reducer and driver use the same derived requirement for counting reviews,
reviewer slots, suggested commands and owner escalation.

When ALL changed closure paths are neutral under
`closure_neutral`, candidate facts have `closureTouched=false` and no
closure-review key or obligation. Such a candidate may join a batch (§7.21):
the batch remeasures final Mn using Mn's closure, and owner-declared neutral
paths cannot change test behaviour. Neutrality is a plan policy, not proof
that an arbitrary ignored JSON property is harmless. Every ruling delivery
through `deliverRuling` — from `owed rule`, `owed decide` or `owed answer` —
runs the other-role delivery check (`needsRole`). It counts a missing
reviewer-role delivery as pending only if the node's derived review count is
greater than 0 or its candidate has `closureTouched`. For an all-neutral
closure change, ruling/answer delivery therefore does not wait
for a closure reviewer. A positive derived review count still makes a missing
reviewer-role delivery pending; existing reviewer runs still receive applicable
rulings.

### 6.3 Status of an item
- Effective executor verdicts on the same item join in the lattice ⊥ < pass,
  fail < ⊤ (pass and fail both present = ⊤). E ⟺ lattice value is `pass`.
  Validated `infra` pairing excludes only its consecutive setup failures from
  that pool (§7.26); behavioural failures still join normally.
- Review items: E ⟺ required reviews `ok` on the current key (rank, count,
  recusal) and no active judgment block.
- **Blocks (⛔ blocked)**: a `fail` obs or a `review block` on node n, obligation o
  (any key, any attempt) creates an active block on (n, o).
  - Execution block (from `obs fail` on key k): cleared by a later executor obs
    on the **same key k** with `attribution: true`. If that rerun fails, the
    failure is deterministic for the old content and the block clears. If it
    passes, key k is ⊤ and the block becomes **flaky**: only an owner `waive`
    with `accept_risk` citing it clears it. Exception: a qualifying `infra`
    receipt clears its consecutive zero-result setup blocks, even without
    attribution, rather than making them flaky (§7.26).
  - **Superseded** execution block (0.8, L2): when a `plan` entry is
    replayed, every active or flaky execution block on `check:<id>`, `red:<id>`
    or `strength:<id>` whose **check definition** differs between the plan of
    its failing observation and the new plan becomes `superseded`, with
    `supersededBy` = the plan entry's seq. The check definition is the node's
    canonical CheckSpec `<id>` with all its fields, plus `plan.setup` and the
    `exec` key part (§4.1), plus the selected set's entries only when the check
    sets `quarantine_set`; checks without a set retain byte-identical definitions.
    `title`, `brief`, `closure`, unreferenced sets and other nodes do not count.
    A removed check (or node) differs too. A superseded block is not active: it does not block, gets no attribution rerun (`attestJobs`), a
    queued rerun of it is not current (`jobCurrent`, §7.10) and it needs no
    waiver. The current candidate must still pass the new
    definition. A block whose definition did not change goes flaky as before.
    Rationale: a flaky block is a risk about the definition its observation ran
    under, and a waiver would record a risk acceptance where the check itself was
    wrong. Only a parent or owner can change a check's definition, and that plan
    entry is recorded and shown with the block (`#<seq> superseded by plan #<p>
    (check <id> definition changed|removed)` in `why`, `status` and `report`),
    so it accounts for the change. A downgrade, such as lowering `min_tests` or
    removing a check, still needs the owner (§3).
    Supersede never invalidates a later entry, so ledgers written before 0.8
    still replay. Validation accepts an attribution observation of a superseded
    block, and a waiver whose `accept_risk` names a superseded block, exactly as it
    would accept them had the block not been superseded: the reducer keeps the
    block's underlying state (active, flaky or cleared, moved on by such entries as
    before) for validation only. Neither entry changes the block's state: it stays
    superseded. owed itself never creates such a rerun. The
    Rust model in `formal/` does not model superseded blocks.
  - Judgment block (review block of rank r by reviewer A): cleared by a later
    `review ok` on the **current key** of that item either by A with rank ≥ r or
    by anyone with rank > r (owner = 3), or by an owner `waive` with
    `accept_risk` citing it. A same-rank ok by a different reviewer is a dissent:
    the block stays and the item goes to the owner (a4.1 ruling 5).
    A block recorded with `needs: "parent"` carries `needs: 'parent'` on its
    Block; it clears by the same rules. It is *resolved* (`parentRuling`) by the
    first `rule` whose node list names its node (not `*`) with a seq above the
    block's; until then it awaits a parent ruling (§12.5).
  - A waiver or ok on another key never clears a block (a4.1 ruling 1): a waiver
    candidate waiver clears blocks only while its own key is the current
    candidate's key for its obligation. A TR merge-key waiver (§5) clears only
    cited blocks on its own key. The blocks a candidate waiver cites in
    `accept_risk` are cleared **whatever their key** (0.11 F3): every cited seq must be an active or flaky exec or
    judgment block of the waiver's node and obligation, so a block of another node,
    another obligation or an already cleared block is refused, except a
    merge-result fail verified on the current merge key as specified in TR (§5).
    This includes a
    block from a failing **merge-result** observation (`merging`) on a merge key.
  - Waived merge-key fail (0.11 F3): an executor `obs fail` with `merging` set whose
    seq an owner waiver of its node and obligation cites in `accept_risk` no longer
    counts on its key: it is neither a conflicting fail (⊤) nor a verdict. So a pass
    on that key (for example the attribution rerun) satisfies the merge, and a key
    left without another verdict is measured again by `owed merge` (a new fail adds
    a new block). An observation on the waiver's own key (the candidate key, or a
    merge key equal to it, e.g. `writes` on an unchanged base) is never discounted:
    the waiver works there through W as before. The waiver's result text (`meaning`) and the owner
    confirmation say that the cited blocks are cleared whatever their key, that the
    obligation is no longer measured on the waived key, and, per cited merge-key
    fail, that a pass on that merge key satisfies `owed merge`.
- W ⟺ item not in E, owner `waive` on the same key, and every active block on
  (n, o) is cited in its `accept_risk`. Invariant items are never in W.
- D = O ∖ (E ∪ W); each D item gets a discharger:
  `executor` (⊥, needs attest), `writer` (fail on current key), `reviewer`
  (review missing), `owner` (flaky ⊤, judgment blocks without a higher
  reviewer, closure review, downgrade, deferral).

### 6.4 Merge guard (evaluated under the lock)
For node n with accepted candidate C, trunk PRE, merge commit M (tree from
`git merge-tree --write-tree PRE C`, parents [PRE, C], committed with
`git commit-tree`):
1. `merge` cites `prior` = current trunk commit (CAS) and the trunk ref still
   equals PRE (`git update-ref refs/heads/<trunk> M PRE`).
2. Node obligations hold on M: `check:*` items keyed on M (reuse when the key
   equals the candidate's), `writes` re-evaluated on diff(PRE, M), all other node
   items from the candidate.
3. **No new debt**: for each invariant i, key on M; if equal to its key on PRE
   the status is inherited; otherwise it must be E on M, or covered by an owner
   `defer` for this node (then it stays in D, shown as deferred), or satisfies
   the bounded trunk-red comparison below (0.15, IR2).
4. Genesis observation finished: every invariant has a non-⊥ obs on s₀'s key.
The merge entry is appended in the same locked step as the guard evaluation.

**Measurement and node-scoped CAS (0.7).** Under the `merge` lock, merge
measures the genesis jobs and the merge-result jobs (`check:*` on M, invariants
on M) whose (subject, obligation, key) lacks a verdict in the state it loaded:
a pass or a fail on the same key is reused (same key, same fact), an `error` is
measured again. Then, under the ledger lock, it compares only what it measured
from with the latest state: the ledger trunk commit, refs/heads/<trunk>, n's
slot (dispatch seq, attempt, base, open) and n's candidate (submit seq, commit).
If one moved, it refuses and records nothing:
- a changed slot (abandon, rebase, a new dispatch): `slot of <n> changed
  (#<seq> <kind>); nothing recorded`;
- a candidate a plan entry invalidated (n's spec, `setup`, `exec` or
  `closure` changed, §3): `candidate
  #<S> <commit12> of <n> was invalidated by plan #<N> (its spec changed); the
  writer submits again, then merge`;
- the trunk ref moved: `trunk changed (CAS): …` (below);
- otherwise (a new submit, the ledger trunk moved): `Plan, candidate or trunk
  changed; retry`.

Other entries (a plan update that keeps C, entries of other nodes) do not
refuse by themselves. When the plan changed, merge recomputes M's facts and
keys under the latest plan; it keeps each measured observation whose job is
still a genesis or merge-result job of the latest state (same subject,
obligation and key, still lacking a verdict; D24.1) and drops the others. The
guard is evaluated on the latest state plus the kept observations. A job of the
latest state this run did not measure (a key the plan update introduced)
refuses with `not measured: <subject>/<obligation> (key <key12>), … (the plan
changed while merge measured); run owed merge again: it measures only what
lacks a verdict`. On any guard refusal the kept observations are appended and
nothing else; a retry measures only the jobs still lacking a verdict.
Conflicts in merge-tree → the merge is refused with a `writer` debt
"rebase needed".

### 6.5 Escapes and decoys (north-star metric)
- An **escape** is a defect found after node n was merged. `class` names the
  escape class: `missing` ② (an obligation that should have existed was
  missing), `false-pass` ①a (a false affirmative observation), `reuse` ①b
  (unsound evidence reuse), `weak` ①c (a weak oracle), `waiver` ③ (an owner
  waiver let it through). Refused unless `merge` is the seq of a `merge` entry
  whose node is n; `note` must be non-empty; `evidence` is optional text.
  `state.escapes` lists them in ledger order. Parent/owner may record manual
  escapes without `escape.sweep`; that field is refused for their entries.
  A confirmed sweep can record one as `executor:owed`, class `missing`,
  which MUST carry `escape.sweep` citing its confirmed boundary (§7.15b).
- `escape`, `decoy-commit`, `decoy-reveal` and `adopt` entries carry exactly the fields
  of the entry table (plus `kind`, `by`, `channel` and the ledger-assigned
  `seq`, `ts`, `prev`, `hash`); any other field is refused.
- **Decoys** measure what escapes when nobody knows which nodes are planted.
  The owner first records `decoy-commit {digest}` with
  `digest = sha256(canonical({nonce, decoys: [{node, defect}]}))` (§1 canonical
  JSON; only those fields). `nonce` is ≥ 16 characters, `decoys` non-empty with
  distinct existing nodes and non-empty `defect`. The payload stays outside the
  ledger and the repository until the reveal.
- `decoy-reveal` is refused unless its payload hashes to an earlier
  **unrevealed** `decoy-commit` whose seq is lower than the first `dispatch` of
  every listed node (nodes not yet dispatched qualify). A commitment is revealed
  once.
- `state.decoys` gives each revealed decoy an outcome, judged on the whole
  ledger (entries before and after the reveal):
  `caught` — an executor `obs` with verdict `fail` (execution block or
  rejecting obs) or a `review` with verdict `block` (judgment block) on the node
  before any merge of it; or a failure seen while merging it: an executor `obs`
  with `merging: <node>` and verdict `fail` on a node check, or on an invariant
  previously satisfied on PRE (E or active known-red W) whose merge-result item
  is D. PRE=W → D is a catch, including a fix node whose own exemption is
  inactive on its merge result; PRE=W → W is not a catch. Result classification
  includes the observation being recorded and the merging-node context, so a
  fail verdict alone does not count a still-satisfied known-red item as caught.
  PRE=E retains its ordinary rejection behavior. Pre-existing trunk D debt,
  deferred or not, never counts as a catch. This holds for a refused merge and
  for a later merge after an owner `defer`. `escaped` — a merge of the node with no such entry before
  it; `pending` — neither yet. `decidedBy` is the deciding seq.
- A node listed in more than one reveal counts once: the decoy of the earliest
  commitment (lowest `decoy-commit` seq) wins, whatever the order of the reveals.
  `state.decoyCommits` lists commitments and the seq that revealed them.
- Metrics (report): escape counts by class; decoys caught / escaped / pending;
  unrevealed commitments; **escape rate** = escaped / (caught + escaped), n/a
  while no decoy is decided. These are cumulative over the whole ledger.

### 6.6 Adoption of trunk commits made outside owed
Trunk can move outside owed (a release commit, a human hotfix). Then
refs/heads/<trunk> is ahead of the ledger trunk and every merge fails the CAS.
The owner records such commits explicitly with `adopt`; owed never trusts a
moved ref silently.
- Reducer: `adopt` requires role owner (or a parent under an allowance, below), `trunk` = the ledger trunk name,
  `prior` = the current trunk commit, `commit` = `state.commit` ≠ `prior`, a
  non-empty `note`, `changed` a list of paths, `commits` a positive integer, and
  exactly the fields of the entry table. The trunk state becomes `state` (as for
  a merge; `trunk.seq` = the adopt seq) and `state.adoptions` lists
  `{seq, by, channel, prior, commit, commits, changed, note}` in ledger order.
- **No new debt** (`adoptGuard`, also checked on replay): for each invariant,
  key on the adopted state; if equal to its key on the current trunk the status
  is inherited; otherwise, when the item on the current trunk is satisfied
  (E or active known-red W), the item on the adopted key must also be satisfied
  (E or W). An invariant that is already debt on the current
  trunk (D: failing, ⊥, ⊤ or deferred) ordinarily does not block. An automatic
  same-key pass/fail conflict is the exception: adoption refuses until owner
  resolution (§7.20). Genesis observations must
  be finished (§6.4 rule 4). There is no owner `defer` for an adoption: the owner
  fixes trunk and adopts again. The refusal names each failing invariant with the
  observation that decides it (`h1 (obs #3)`): the obs appended by this adopt,
  else (a repeated refused adopt measures nothing new and appends no new
  observations) the latest existing trunk obs of that invariant at the adopted
  state's key.
- **Parent adoption** (§3.4, D21.4): role parent may adopt instead of the owner
  when the current plan has `adopt` allowances and every path of `changed` lies
  matches one of their scopes (§3.7); otherwise the entry is refused (no scopes:
  `adopt insufficient permissions; requires owner`; else `parent adoption
  refused: changed path <first uncovered path> is not under an allow adopt prefix
  (…)`). `adoptGuard` applies as for the owner. `state.adoptions` carries
  `allowance: S` for a parent adoption (S as in §3.4) and views show `adopted by
  parent:<id> under allowance (plan #S)`. Owner adoptions are unchanged.
- Open slots are not touched. Their base stays; a merge builds on the adopted
  trunk as after any other trunk move (`owed rebase` when it conflicts).
- Limits: only fast-forwards are adopted (a rewritten or reset trunk is refused;
  restore the ref to a descendant of the ledger trunk). `escape` cannot name an
  adoption (it names merges only). The adopted commits are not reviewed by owed;
  the entry records that the owner took them on trunk.
- A moved ref or ledger makes adopt record nothing, except after an abort
  (§7.8): observations measured before it are recorded when the ledger is
  stable and they pass the guard, without a ref check.

## 7. Executor (attest)

`attest(node)` for the current candidate:

Every setup, check, invariant and sweep command also receives a fresh random
`OWED_RUN` token, independent of its key. On cancellation or timeout, owed ends
the command group and, on Linux, processes carrying that exact token in
`/proc/<pid>/environ`: group TERM precedes the first scan, followed by a grace
interval, KILL and rescans. The five-second cleanup deadline includes scanning;
an unfinished scan at the deadline ends cleanup and the command counts as ended.
Only readable environ containing the exact token proves a process tagged.
EACCES/EPERM (non-dumpable processes or another uid) is unproven: owed neither
signals those processes nor waits for them. A command leaving its group and
clearing the token or making environ unreadable is outside Linux containment.
Cleanup completes before the lease is released. Other platforms retain group
cleanup. Normal command exits retain their existing behavior.

1. For each active execution block of the node, rerun its original item first
   (attribution) using the commit/base recorded in the failing obs.
2. Materialize C clean: `git worktree add --detach <tmp> <C>`; restore closure
   globs from B (files in B overwrite; closure files only in C are deleted);
   run `setup`; run each check with `bash -lc` (prefixed by `exec.wrap`, §7.9),
   a timeout (kill process group), env `CI=1 OWED=1 OWED_TREE=<absolute tree path>` (plus `exec.env`, §7.9); capture combined output to a blob; parse test counts
   (TAP `# pass N`/`# tests N`, node:test, pytest `N passed`, cargo
   `test result: ok. N passed`); zero tests with a known format = fail;
   `min_tests` unmet = fail; unknown format with `min_tests` set = error.
   cargo summaries count only at column 0 (`^test result: (ok|FAILED)\. …`,
   as cargo prints them): a `# test result: …` TAP comment or an indented
   TAP YAML diagnostic containing one is never a cargo count.
   A log holding both cargo `test result:` lines and TAP (plan or summary
   lines), e.g. `cargo test && node --test --test-reporter=tap`, sums both to
   one count `{format: "mixed", tests, pass, fail, skip}` (TAP part as for a
   TAP log, cargo lines summed; `pass`/`fail`/`skip` present when the TAP part
   reports them); a single-format log keeps its format name and numbers.
   A non-red run that exits non-zero with no recognizable count, or with a
   zero count, is `fail` (with or without `min_tests`, never the unknown-format
   error): the command itself failed (e.g. cargo's `package ID specification …
   did not match any packages`, exit 101). Its note is `command exited <code>
   with no recognizable test count; last output:` (or `after zero tests;
   last output:`) followed by the last 5 non-empty output lines, one per
   line, indented two spaces, ANSI colour removed, each cut to 200
   characters. Exception: a non-red run that exits 126 or 127 with no
   recognizable count is `error` with the note `command could not run (exit
   126: not executable)` (or `127: not found`) plus the same `; last output:`
   tail — the command never ran, so it says nothing about the code and must
   not become a `fail` that later conflicts with a pass. Otherwise only an
   exit-0 run with an unknown count and `min_tests` set stays `error`. Red
   runs are unchanged.
3. Red runs: materialize B, overlay candidate `tests` files, restore closure
   from B, run; pass iff exit ≠ 0 and not zero-test and `red_expect` matches;
   exit 126/127 (the command could not run) or a spawn failure is `error`.
   `min_tests` is not applied to red runs, and an unknown count format there is
   not an error (the base usually fails to load the new test file).
4. Strength runs (`strength:<id>`, checks with `mutants`): the mutants are the
   files of B matching `mutants` and the closure, read from B (never from C);
   none → `error`. For each mutant: materialize C, restore closure from B as for
   the check, `git apply` the patch (one that does not apply counts as not
   killed and is reported), run `setup`, run the check command. Killed iff
   (exit ≠ 0, a timeout included, or failing tests > 0) and the run is not
   zero-test. Verdict pass iff killed/total ≥ `min_kill`; counts
   `{tests: total, pass: killed, fail: survived}`; the log lists each mutant's
   result. The receipt card shows `strength k/n`.
5. Writes / closure-touch computed from `git diff --name-only B C`.
6. Skip an item whose key already has an executor verdict (reuse), unless
   `--rerun`.
7. Remove the temporary worktree. Append one `obs` per item under the lock.
8. Abort (D16): `attest`, `merge`, `init` and `adopt` take an optional
   `signal` (AbortSignal). On abort the running command group and tagged
   descendants receive the cleanup described above; that run records nothing, no further job starts, and the operation
   rejects with `OwedError('aborted', 'aborted')`. Observations of jobs that
   completed before stay: attest/init appended them already; merge/adopt
   append the ones they measured when the ledger did not move meanwhile and
   each passes the guard (the same stability check as their refusal path; no
   trunk-ref check — they are facts about the measured tree, so an aborted
   adopt records them even if the ref moved). An abort never moves trunk:
   merge/adopt check it last under the lock, before `git update-ref`. An
   already-aborted signal starts nothing. Waiting for a ledger lock is
   abortable (D16a.2): an abort before the lock is acquired rejects at once
   with `OwedError('aborted')` and takes nothing; an abort after acquisition
   is handled by the paths above, never by interrupting the locked step. The
   only lock wait after an abort is merge/adopt recording the observations
   they measured before it (and a parallel genesis attest, §7.12).
   Under `exec.parallel` > 1 (§7.12) every running job is killed; the
   observations kept are those of the jobs that completed before the abort,
   in job order (not necessarily a prefix of the job list).
9. Execution environment (D20, §3.2). Every process owed starts in a
   materialized tree — `setup`, check, red, strength and invariant runs, and
   attribution reruns — gets the environment `{...process.env, ...exec.env,
   CI: "1", OWED: "1"}` (`NODE_TEST_CONTEXT` and every `DSA_*` variable of
   owed's own process except `DSA_HOME` — `DSA_CALL`, `DSA_EXEC`,
   `DSA_SESSION`, … — are not inherited, so owed commands inside a check are
   not refused as subagent acts, D25.3; `DSA_HOME` is configuration, not call
   identity, and stays; a `DSA_*` name set in `exec.env` is passed as written). An argv-array wrapper runs as `[...exec.wrap, "bash", "-lc", <command>]` instead
   of `["bash", "-lc", <command>]`: same cwd (the materialized tree), same new
   process group, same timeout and abort handling (SIGKILL to the group, so
   the wrapper is killed with its group). Wrapper contract: run the trailing
   argv to completion in the given cwd and environment, pass stdout and stderr
   through, and exit with its exit code; when the wrapper cannot run the
   command (transport, mirror or lease failure) it must exit 126 or 127. A
   wrapper that runs the command elsewhere (ssh) must bound it there itself,
   because owed can only kill the local process group. The red-run 126/127
   rule (step 3) applies to the wrapper's exit code: 126/127 is `error`, any
   other non-zero code is read as a test failure — so a wrapper failure with
   another code, or a remote `timeout`'s 124, is a red pass unless `red_expect`
   is set (use `red_expect` with wrappers). A wrapper that cannot be started is
   an `error`. A relative `wrap[0]` containing a slash resolves against the
   materialized tree (the cwd); a bare name is looked up in `PATH`.
   String-template wrappers use the same environment with the execution and
   timeout rules in §7.22, including evidence freeze and shutdown grace.

### 7.10 Observations are facts about keys (D24)

`attest` and the genesis attest (`init`, `attestGenesis`) do not refuse when the
ledger moves while they measure (a plan edit, a ruling, another node's entry).
Under the ledger lock each observation is appended iff its item is still current
(`jobCurrent`, src/reducer.ts): a node job while the node's open candidate still
has that key for that obligation, or — an attribution rerun — while an active
execution block still has that obligation and key and its failing observation the
job's commit and base (a block replaced by one on another commit supersedes the
rerun instead of refusing it); a trunk job while its key is
still the genesis key or the current trunk key of an invariant of the plan.
Otherwise the observation is dropped as **superseded** and the run goes on with
the next job. `AttestResult.superseded` (and the genesis results) list the
dropped items `{subject, obligation, key}`; the CLI and `owed_attest` print them after the card as
`Superseded (not recorded; the item changed while it was measured): …`. A plan
edit that changes a node's spec (a brief included) invalidates its candidate, so
that node's observations are superseded; an edit elsewhere interrupts nothing.
`merge` and `adopt` keep their strict stability rule (`Plan, candidate or trunk
changed; retry`): they decide a trunk move on what they measured.

### 7.11 Attest locks and busy (0.7, K1)

- `attest(node)` holds a lock of that node only, named `attest-<first 16 hex of
  sha256(node id)>`, so attests of different nodes run in parallel: each
  observation is appended under the ledger lock only if its item is still
  current (§7.10). Each job materializes its own temporary worktree
  (`mkdtemp` directory, git's worktree admin directory created by an atomic
  `mkdir` that picks a free name) and writes its log blob through a unique
  temporary file (§1), so concurrent attests do not collide. `attest --genesis`
  keeps its own `genesis` lock (§8.2).
- When the node's attest lock (or, for `--genesis`, the `genesis` lock) is held
  by a live process on this host, attest fails at once, without waiting, with
  `OwedError` code `busy`: `attest of <node> is already running (pid <pid> on
  <host> since <ISO time>); its observations will appear in owed why <node>`
  (`--genesis`: `attest --genesis is already running (pid <pid> on <host> since
  <ISO time>); its observations will appear in owed status`). A dead owner on
  this host is reaped as for every lock. A lock of another host has no live
  check: attest waits as for every lock (60 s), then fails with code `busy` and
  the same text naming that host.
- Every other lock wait that times out (the ledger lock, `merge`, `dispatch`,
  `drive-detach`, …) is code `busy` too: `timed out waiting for the <name> lock
  held by pid <pid> on <host> since <time>; retry`, where the ledger lock reads
  `the ledger lock` (without a readable owner: `timed out waiting for the <name>
  lock; retry`). These waits keep their behavior otherwise: a live owner is
  waited for.
- The CLI exits 75 for `busy` (§10); pi tools return the message as a tool error
  (`Busy: <message>`, details `{code: "busy", reason}`).

### 7.12 Merge speed: `exec.parallel` and `exec.trees` (0.9)

- `exec.parallel` = N (default 1): one `owed merge` measures up to N of its jobs
  at once — the genesis/invariant jobs and the merge-result jobs in one queue,
  started in job order. The same applies to `owed adopt` and to the genesis
  attest (`init`, `attest --genesis`). Node attests stay serial: the driver
  already runs attests of different nodes in parallel (§7.11). Observations go
  into the ledger in job order whatever order the jobs finish in (merge/adopt
  append them together; the genesis attest records each in job order as soon as
  its predecessors are recorded; a failure to record one starts no further job).
  With N = 1 the behavior is exactly that of
  0.8. An abort (§7, step 8) kills every running job and starts no further one.
  Parallel jobs share the machine: cargo builds that share one
  `CARGO_TARGET_DIR` serialize on cargo's build-directory lock, so give heavy
  invariants separate target dirs (e.g. through their own `run` or wrapper) or
  accept that they wait for each other.
- `exec.trees: fresh` (default): every run materializes a new detached worktree
  under a fresh `/tmp/owed-run-*/tree` and removes it afterwards. Nothing
  survives; build tools that fingerprint the path or file mtimes rebuild from
  scratch.
- `exec.trees: reuse`: check, red, strength and invariant runs use a stable
  detached worktree `<git common dir>/owed/trees/<kind>-<check id>-<k>`
  (`<kind>` = `inv`/`check`/`red`/`strength`; a check id that is not path-safe,
  `^[A-Za-z0-9][A-Za-z0-9._-]*$`, is replaced by `h` + 16 hex of its sha256),
  with `<k>` the lowest index whose lease is free. The lease is the file
  `<tree>.lock` holding the pid. It is taken atomically by writing the pid to a
  unique temporary file and link()ing it to the lock path, so a lock file is
  never empty. A lock whose content X is dead (a dead pid, or empty/unparsable
  and older than 60 s) is stale and reclaimed under the token
  `<tree>.lock.dead-<X>` (X the pid, else `h` + 16 hex of the content's sha256),
  created with O_EXCL: holding it, the reclaimer re-reads the lock, unlinks it
  only when it still holds X, tries the normal take once (moving on to the next
  k when it loses) and unlinks the token; a reclaimer that cannot create the
  token does nothing for that k. Concurrent measurements of one check therefore
  get different trees, and a stale lock ends with exactly one holder. A token
  older than 1 h (a crashed reclaimer) is removed by the taker that meets it and
  by `owed gc`; temporary `<tree>.lock.tmp-*` files older than 60 s (a crashed
  taker) are removed by every take of that lock and by `owed gc`.
  Preparing a reused tree for a commit: `git checkout --detach --force
  <commit>`, then `git clean -ffdx` (no untracked or ignored file survives),
  then every gitlink directory (mode 160000 in `git ls-files -s`) inside the
  tree is emptied — its contents, a `.git` file included, are removed and the
  empty directory kept — as a fresh `git worktree add` tree has empty
  submodule directories: the content equals a fresh tree. owed never runs a
  `git submodule` command and never changes the shared config or a modules
  directory, so the user's initialized submodules are untouched. Then the
  overlays as for a fresh tree. The path stays stable. Under the lease, before
  overlays and setup, `exec.touch: reset` (0.11, default) sets every tracked
  file's mtime to now whenever the commit differs from that of the tree's last
  complete preparation (a recreated tree counts as changed).
  `always` does so before every reused measurement (each strength mutant too),
  even on the same commit; `never` keeps Git's behavior. Symlinks are touched
  without following their targets, and gitlink directories are skipped.
  A build cache outside the tree survives; an ignored `target/` inside does not.
  A cache shared by several trees (a common `CARGO_TARGET_DIR`) can link
  artifacts from another checkout: use a per-tree directory or `touch: always`.
  Every setup, wrapper and measurement process gets `OWED_TREE` = the absolute
  materialized tree path (fresh, reused or fresh fallback), overriding inherited
  values and a value from `exec.env`. Preparation is all-or-nothing: a marker in
  the tree's private git dir records the commit of the last complete
  preparation (written after touch); it is removed before checkout, so when
  checkout, clean, touch or any later step fails, the next lease redoes the
  whole preparation, touch included. For example, in the command that builds, use
  `export CARGO_TARGET_DIR="$OWED_TREE/../target-$(basename "$OWED_TREE")"`;
  `exec.env` values do not expand shell variables. `touch` has no effect on fresh
  trees. `git.reuseHooks.beforeTouch` is a test-only seam (tests inject a
  failure right before the touch); it is not a supported interface. A missing or broken tree is recreated (`git worktree add -f
  --detach`); a failure to prepare one falls back to a fresh tree with a
  one-line note in the observation log and never fails the measurement. The end
  of a run releases the lease and keeps the tree. Each strength mutant prepares
  the tree again. Reuse trees are not slots: `owed gc`, `dispatch`, the D19
  trunk-worktree report and the slot reports ignore them; `owed gc` deletes
  those whose lease is free when the plan no longer sets `trees: reuse` or when
  their check id is gone (an `inv` tree: no invariant of that id; other kinds:
  no node check of that id), and reports them (`trees`, and `treesKept` for a
  held lease) — `--dry-run` only reports. 0.11 (F2.5): `owed gc` also deletes
  a free node-check tree (kinds check, red, strength) whose check id belongs
  only to plan nodes that are finished — merged, or abandoned (slot closed)
  without an open slot — with reason `check <id> belongs only to merged or
  abandoned nodes`; invariant trees and leased trees are kept as before.

### RC1 Repeated measurements (0.13)

A check or invariant may set `repeat: {runs: N, need: K}` with integers
`1 <= K <= N <= 9`; omitted `need` defaults to N and is normalized to N.
`repeat` is refused on `red: true` or `mutants` checks. The check/invariant
key includes `repeat: {runs, need}` only when present; keys without repeat
stay unchanged. A changed repeat definition requires owner authority or a
matching check allowance, like a changed command.

The executor prepares one tree (including overlays and setup) and runs the
command sequentially there, each under its own `timeout_s`. Each run uses
its own counts and `min_tests`; counts are never summed across runs. It stops
at K passing runs or when K is unreachable within N runs. A command error,
abort or environment failure stops immediately with observation `error`, not
a failed vote. Merge-time, genesis and adopt invariant jobs use the same rule.

One `obs` records the aggregate verdict, last run's exit/counts, total duration
and combined log; `runs` records every executed run in order with `{verdict,
exit, counts?, durationMs, log, note?, failed?}` (log is that run's blob digest).
The tree is disposed only after voting ends. `noisy: true` means executed runs
include both pass and fail; otherwise it is false. It is descriptive, never a
separate failing observation or block. `why` and driver attest/merge reports
show `noisy (2/3 passed)` using the number of executed runs, not the maximum N.

**MS1 pooled repeat (0.20):** across observations on the same key, every run
of every effective non-error observation is pooled (an observation without
`runs` counts as one run). Validated setup failures resolved by `infra` are
excluded; every executed run of the resolving pass must qualify (§7.26). No window or cherry-picking: with repeat `{runs:N, need:K}`, the
item passes iff `passes*N >= K*total_runs`, otherwise fails, never ⊤. With
several observations `why` shows `pooled <p>/<t> runs on this key (need <K>/<N>)`.
Without repeat, pass+fail on one key remains the ⊤ owner conflict. This is a
replay exception: a 0.17 ledger with repeat and several observations on one
key can replay its former ⊤ as pass/fail in 0.20 (§7.17).

### RC2 Counts protocol (0.13)

**CT1 template counters (0.20):** counters stream runner stdout unchanged,
collect it and emit counts at EOF. Cargo sums every column-zero summary
matching `/^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/gm`.
TAP uses the final column-zero `# pass` and `# fail` summaries, subtracting
successful file wrappers from pass. A wrapper is **only** a top-level result
with no indented subtests whose trimmed name equals an actual input file.
Names/files normalize backslashes and `./` via absolute-path resolution;
`fs.globSync` expands input globs for comparison with runner-reported paths.
Both `ok` and `not ok` delimit top-level results. SKIP/TODO results are not
subtracted (already excluded by the summary). An actual test named
`test/looks-like-file.mjs` inside `test/real.mjs` counts; a file-named result
with subtests also counts. Empty, diagnostic-only and filtered-empty file
wrappers do not satisfy `min_ok`, with or without a preceding `1..0`.

With summaries present, counters emit `owed-counts ` plus
`JSON.stringify({pass,fail,...(failed.length?{failed}:{})})`. Failed names are
matched by `/^test (.+) \.\.\. FAILED\s*$/gm` (Cargo) or
`/^\s*not ok \d+\s*-\s*(.+)$/gm` (TAP); stored names remain bounded to 50.
Counters exit 1 for missing summaries, failing counts or successful tests below
`min_ok`; `pipefail` retains runner nonzero exits/crashes. Skips/ignored tests
never satisfy `min_ok`; executor timeouts remain errors.

`evidence-json` parses `fs.readFileSync(path,'utf8')` as JSON and traverses
required paths with `Object.hasOwn`. Success emits
`owed-counts {"pass":1,"fail":0}`. Failure emits stderr
`evidence-json: <error message>` and
`owed-counts {"pass":0,"fail":1,"failed":["evidence-json: <path>"]}`, exiting 1.
Missing fields say `missing field <field path>`; missing files and invalid JSON
also fail. Evidence templates do not synthesize `min_tests`.

A log line `owed-counts {"pass":2,"fail":1,"failed":["latency gate"],"skip":0}`
provides counts with format `owed`. The `owed-counts` token must start at column 0
and be followed by whitespace and a JSON object. Leading whitespace
or a `# ` prefix makes the line non-protocol text, silently ignored, not malformed.
For example, this real TAP diagnostic never overrides the test count:

```text
not ok 1 - real diagnostic failure
  ---
  error: |-
    owed-counts {"pass":0,"fail":0}
  ...
# tests 1
# pass 0
# fail 1
```

Its JSON must be an object with non-negative
integer `pass` and `fail`, optional non-negative integer `skip`, and optional
string-array `failed`. `tests` is pass + fail + skip. The last valid such line
wins over TAP/cargo/pytest/jest/vitest and any mixed counts. A malformed line is
ignored and the observation (and repeat run) note says so; no valid line means
the existing parsers and no-count semantics still apply. Only for format
`owed`, fail > 0 also makes a non-red run fail despite exit 0; other formats
keep their existing exit semantics. Zero tests and min_tests apply as before.

### RC3 Failing names (0.13)

Counts and observations retain up to 50 failing names from `owed`'s `failed`,
TAP `not ok N - name` and cargo `test name ... FAILED` lines; diagnostic cargo
lines inside TAP are not names. Repeated observations retain a capped ordered
union across executed runs in `failed`. A failed red verdict (including a
`red_expect` mismatch) gets the same failure quote; a successful red
counterfactual stays unchanged. A merge refusal and subsequent driver halt
carry the stored note even when the failing merge-key observation is reused
rather than freshly measured.

**SG4 (0.20.1):** single-run and repeat-union notes quote at most three failed
tests in recorded name order as
`failed tests: <name> (<path:line>): expected <X>, actual <Y> | ... (+<N> more)`.
Both assertion values must be present; otherwise use the first error line,
or a missing-error diagnostic when extraction yields no text. **VW6 (0.28):**
TAP extraction matches the failed name exactly to a `not ok` test point. Its
`---`/`...` YAML diagnostic must immediately follow at the next indentation;
only the `error:` field supplies error text. Cargo extraction matches the
exact thread name in either supported panic format. An unmatched name reads
`no error text: log <hash12> has no \`not ok\`/panic line named exactly as this failed test`.
A matched test point with no extracted error reads
`no error text: the \`not ok\` block of this name in log <hash12> has no error field`.
The hash identifies the stored observation log (individual repeat notes identify
their run log). These diagnostics never match `remeasure_on` as error text.
Omit absent locations. TAP YAML errors,
quoted/plain/block scalars and both cargo panic formats remain recognized.
ANSI is stripped, whitespace collapsed, semicolons replaced by commas and
error messages limited to 160 characters with `…`. Prefer the repository test
stack frame (§5 SG1); otherwise display the TAP/cargo location without a column,
relative to the run cwd (other absolute paths keep their last three segments).
Assertion values are independently masked and limited to 120 characters.
The `errorGroups` helper still groups errors for extraction, but notes no
longer display frequency groups. The capped `obs.failed` union and full log
retain names/evidence for `why` and intermittent hints.

Refusals, `why`, halts and repair messages quote the stored per-test note.
Named failures do not append unrelated summary/last-output tails; separate
count-failure reasons remain. Anonymous failures retain a tail of at most 15
non-empty lines (ANSI stripped, each at most 200 characters), or the existing
5-line no-count command-failure tail. Timeouts use §7.18 instead. These display
changes add no ledger fields or obligation keys.

Compatibility (RC1–RC3): use owed >= 0.13 for repeat and the
`obs` fields `runs`, `noisy`, `failed`, and `counts.failed`/format `owed`.
Published 0.12 does not reject unknown check fields: parsePlan silently drops
`repeat`, then replays these observations by their aggregate verdict only,
ignoring run/noise/name metadata. It cannot be retrofitted to refuse them, so
do not operate a repeat ledger with 0.12. From 0.13, unknown top-level obs
fields are refused with code `version` (upgrade/restart), as unknown rule
fields already are; this prevents silent interpretation of later obs additions.

### 7.13 Environment failures (0.11, F2.1)

An observation whose failure says nothing about the code is `error` (no
verdict, no block) with a note beginning `environment: `:
- a check, red, strength-mutant or invariant run whose command exited
  non-zero, whose parsed counts report no failing test (no counts, or
  `fail` 0), and where `ENOSPC`, `No space left on device` or `Disk quota
  exceeded` matches in the last 50 non-empty lines of the captured output after
  dropping TAP test points and subtest titles (lines starting, after
  indentation, with `ok `, `not ok ` or `# Subtest:`), node spec-reporter test
  titles (`✔ `, `✖ `, `▶ `; 0.12, G3.4) and cargo `test … ok|FAILED`
  lines (a test name is never evidence): note `environment:
  <matched text>: command exited <code>; matched output:` plus the last 5 of
  those filtered lines in which the pattern matched (0.12: not the unfiltered
  tail), one per line, indented two spaces, each at most 200 characters. A run whose counts report `fail` > 0 is a `fail`, never
  environment; a passing run, a timeout or a signal is unaffected;
- a check or invariant command, including a red counterfactual, that exits 75
  whose last output line that is non-empty after trimming matches
  `^hold: .*(not running the command|the command was stopped) \(exit 75\)$`
  without trimming the matched line (only the CR in CRLF is removed); trailing
  spaces after `(exit 75)` therefore retain the ordinary failure verdict.
  Its note is `environment: machine lease not granted; the check did not run: <line>`
  or `environment: the check yielded the machine lease: <line>`, with the
  diagnostic limited to 160 characters. These errors use environment backoff;
  they never count as failed checks, red passes or toward the two-errors halt.
  Other exit-75 commands keep their ordinary verdict;
- a failure before the command runs: tree preparation (worktree add,
  reused-tree reset/checkout, the closure and test overlays), a spawn failure
  (`environment: spawn failed: …`) and the plan's `setup` command
  (`environment: setup failed: <code>`).
A command that cannot run (exit 126/127) or an unknown count format stays a
plain `error`. The driver does not count environment errors toward its
"attest recorded no verdict twice" halt (§12.5).

### 7.14 Shared machine lease (0.13, LE)

- **LE1.** `src/lease.ts` wraps a measurement in `pi-durable-subagents hold
  machine --shared` when dsa is available and inherited `OWED_LEASED` is not
  `1`. Otherwise it runs directly. Every setup, check (including red,
  strength and attribution) and invariant process started inside that lease
  gets `OWED_LEASED=1`, overriding any plan environment value. Neither this
  marker nor the lease configuration is part of an item key. In-process
  parallel measurements use independent async contexts, not process-wide env
  mutation. A nested measurement reuses its surrounding context.
- **LE2.** The driver attests and merges under a shared machine lease with
  `--no-wait`. A busy merge is the same `busy` outcome as attest: nothing is
  queued, no halt is recorded, and a later timed/event pass retries (never
  the same pass cycle). Merge still calls `ops.merge` in process; a holder
  child prints `leased` after acquisition and stays alive until stdin closes.
  Only then may merge measure. Return, throw or abort closes and reaps the
  holder, with bounded TERM/KILL escalation; parent death closes its pipe
  too. Holder failure aborts the measurement. The leased attest child gets
  `OWED_LEASED=1`, so it never queues a nested shared request behind an
  exclusive waiter. `owed drive --status` lists a refused merge lease as
  busy in its log tail, no longer as an in-flight measurement.
- **LE3.** Standalone CLI and tool attest, merge, adopt and genesis attest
  (including init's extension background attest) wait for a shared machine
  lease without `--no-wait`. CLI `--no-lease` on init, attest (including
  `--genesis`), merge or adopt, or tool parameter `lease: false`, skips it.
  Top-level plan `lease: false` disables acquisition repository-wide;
  default is on, `lease: true` is allowed, other types are refused. This
  field is neither an obligation nor part of any existing key. Acquire the
  machine lease before operation/tree/ledger locks (except sweep preparation,
  §7.15b), retaining all existing
  commit, CAS, observation and rollback boundaries. Init records genesis
  before leasing its measurement: interrupted measurement remains incomplete,
  never an unrecorded init. Already inherited `OWED_LEASED=1` still propagates
  when acquisition is disabled. No new ledger entry or field is introduced.
  Driver and standalone attest/merge leases request `--priority 10`. If dsa
  appears to reject that option as unknown, owed confirms using the same cwd,
  env and hold flags with `--no-wait -- true`. Only the same unknown-option
  refusal in that confirmation permits one retry without the flag and caches
  the fallback for this executable in the current process. Confirmation exit
  0 or 75 returns the original result as a command result: a command forging
  dsa's refusal text is never executed twice. Other refusals keep their existing
  meaning; priority requires pi-durable-subagents 1.1.0.
- **LE4.** Leased results include `lease: "machine (shared)"` in JSON/tool
  details and `lease: machine (shared)` in text (driver completion detail,
  and the extension genesis-completion wake). This metadata is not persisted.
  Compatibility: older owed keeps replaying existing entries; it ignores the
  new plan field, so use owed 0.13+ to enforce its execution semantics.

### 7.14a Machine lease wait measurements (0.23, MX3)

An `obs` or `merge` recorded inside a newly acquired measurement lease carries
optional `lease_wait_ms`: a nonnegative integer of milliseconds from the
machine-lease request to acquisition, before the measurement starts. All such
entries within that lease share its value; nested work in the same process
retains the surrounding value. It is absent when acquisition is skipped
(`--no-lease`, plan `lease: false`, unavailable dsa, or an inherited lease
without a measured wait). Keys, verdicts and acceptance gates do not read it.
`report --metrics` summarizes each entry as one sample (§9.4), so several
observations from one command count several times. Driver `noWait` retries
exclude waiting between passes; this measures a lower bound on driver delay.
See Compatibility before taking the first leased measurement with 0.23.

### 7.15 Advisory escape sweep and unguarded paths (0.13, SW)

- **Plan.** Top-level `sweep: {run, timeout_s, reads?, every?}` (§3.9, §7.15b): non-empty command, positive integer timeout (default 600), optional list of read globs (default all paths). Unknown sweep fields and invalid types are refused. This field is not part of any existing check or invariant key and does not invalidate candidates. It adds no obligation. `reads` describes the suite, without restricting the detached tree.
- **Execution.** `owed sweep [--commit C]` / `owed_sweep {commit?, lease?, cwd?}` / `ops.sweep({cwd, commit?, signal?, lease?})` resolves trunk's ref by default and runs setup plus the command on a fresh detached tree of that commit, with plan `exec.env`/`wrap`. Check-closure overlays and reused check trees do not apply. It uses §7.14's shared lease (waiting for standalone calls, no-wait for the staying driver); skip with CLI `--no-lease`, tool `lease: false` or plan `lease: false`. Leased result metadata says `lease: machine (shared)`, and the process receives `OWED_LEASED=1`.
- **Persistence.** Each completed run appends a strict `sweep` entry: full 40-hex `commit`, sweep definition `key`, verdict, counts when recognized, log blob digest and `failed` names (TAP/cargo/counts protocol, at most 50). The definition hash covers the sweep command/timeout/reads, setup and all plan exec configuration (including env/wrap), never the lease setting; older entries without a key require green remeasurement. Preparation, spawn and timeout errors record `error`; cancellation sends SIGTERM to the detached process group and escalates to SIGKILL after 2 seconds, disposing the tree before releasing the acquired machine lease. The head and all probes are buffered and appended together only after the run finishes; preempting a head or bisect writes `note: sweep aborted: preempted` and no verdicts for that run. The atomic append is the completion point; after it begins a ready action treats the measurement as complete and cannot retroactively preempt its evidence. Sweep runs serialize with their own operation lock, preparing trees before the machine lease and acquiring it immediately before the first command; they hold the ledger lock only while appending. Trunk or plan updates during a run do not change the commit its evidence names. The CLI exits 0 for pass, 1 for fail/error, 75 for acquisition busy.
- **Idle driver (without `sweep.every`).** Only staying drivers run automatic sweeps, with no ready action and no node measurement in flight. They schedule the sweep/bisect in the background and `Driver.pass()` never awaits it; ready dispatch, launch, attest, merge, rebase, follow-up or other driver work signals preemption and proceeds in that same pass. Cleanup and the aborted receipt finish in the background and are included in settle/drain, with no orphan process or lease holder. They skip a trunk commit with completed sweep entries, so restarts preserve the at-most-once rule; aborted runs have no verdict and retry on the next idle period. The driver rechecks that rule under the sweep operation lock. Busy leases/operation locks retry on a later timed pass without a halt; failures and errors wake the parent. Explicit sweeps may remeasure a commit.
- **Bisect.** A head failure is rerun once before any search: pass on the rerun reports `flaky at head`, without bisect or proposal; error reports `inconsistent (flaky)`. An earlier passing ancestor is a green bound only when its stored definition key matches the current one; otherwise the current definition is run there first. If that run does not pass, report `no green boundary under current sweep definition; definition/environment change`, naming no culprit. The search candidates are recorded owed merges on the first-parent range, in order. Each probe/confirmation appends `bisect: true`. A measurement error stops localization. Before naming X, require two failing samples of X and a passing sample of its actual first parent X^; already repeated head measurements are reused rather than run a third time. Any disagreement reports `inconsistent (flaky)` with the observed verdicts and no culprit/proposal. Each commit is measured at most twice per invocation; total measurements are at most `ceil(log2(n)) + 4` for n owed merges in the search range. If the remaining budget cannot confirm the boundary, report `inconsistent (flaky): confirmation budget exhausted` with observations, without a proposal. Only a confirmed result names the first failing merge's full commit, node and merge seq. In 0.24 it records an automatic escape and coverage notice when the current definition still matches (§7.15b), rather than printing a manual proposal. No sweep result gates a merge. Without a green ancestor or an owed merge in the range it reports the failure alone. For an adopted failing tip, the last owed merge is probed first; if it passes/errors, no merge is blamed.
- **Coverage.** Each merge computes paths in its actual prior-to-merge diff matched by none of the current invariant `reads`. Group uncovered files by their parent directory (`app/bundles/**`), remove directory globs covered by a shorter reported directory, and keep root files literal; sort and deduplicate. For touched uncovered files `app/bundles/foo/a.ts` and `app/bundles/bar/b.ts`, report `app/bundles/foo/**` and `app/bundles/bar/**`, never widen to `app/bundles/**` or another common ancestor: a suggestion must not cover paths that were not touched. CLI/tool merge results return `unguarded: string[]` and text `Unguarded paths: ...` (`none` when empty). Driver merge completion includes the same text. `owed brief` returns `unguarded: {node, seq, paths}[]` for the last 10 ledger merges, independently of `--since`, with coverage from each merge's recorded plan; text has an `Unguarded paths (last 10 merges)` section. It is report-only, never a gate and not stored as a new merge-entry field.
- **Compatibility.** The `sweep` entry kind (including `counts`, `log`, `failed` and `bisect` on that kind) was introduced in 0.13: earlier owed refuses replay with code `version`, under §5's unknown-kind rule. The 0.24 additions are optional fields on existing kinds, not a new kind (§7.15b, Compatibility). Result-only coverage metadata remains outside the ledger.

### 7.15a Same-key remeasure (0.20, MS1–MS3)

`owed attest <node> --remeasure [--all]` builds the current prospective merge
tree and, under the shared machine lease and node attest lock, remeasures
merge-tree **invariants only**, not node checks or ordinary candidate jobs.
It selects a key whose latest non-error verdict failed or whose repeat pool
still fails; `--all` selects every invariant. Observations keep the SAME key
and `merging: <node>`; append requires unchanged trunk, plan and slot. Nothing
else is invalidated. Output leads with `Remeasured on the same merge key:
inv:<id> #<seq> <verdict>, ...`, or `Nothing to remeasure: no merge-tree invariant
of <node> failed on its current key (--all measures every one)`, then receipt. Result fields add `AttestResult.remeasured?: string[]`.

`owed attest --trunk --remeasure [--all]` performs the usual refresh first,
then remeasures failed current trunk keys (or all), skipping keys measured by
this call. Text starts `Remeasured on the same key: inv:<id> #<seq> <verdict>`
or `Nothing to remeasure: no trunk invariant failed on its current key (--all
measures every one)`. Usage errors: `attest --all requires --remeasure` and
`attest --remeasure does not take --rerun or --genesis`. Trunk results add
`remeasured?: string[]` and `remeasuredObs?: Entry[]` alongside ordinary refresh
observations; these are result fields, not ledger fields.

`owed resume <node> --remeasure [--note TEXT]` stores `remeasure: true`. On the
next merge the driver first runs the node form above inside the same machine
lease; this is due while neither a merge-tree observation nor a halt of that
node follows the resume. Busy retains the normal later-pass retry. Hold release
cannot take `--after`, `--expect` or `--remeasure`.

Decide/resume replies with `--remeasure` name each latest failed merge-tree
invariant key. If neither trunk nor candidate moved since that failure, they
say `remeasure queued: inv:<id> on merge key <key12>`. Otherwise they explain
that the next merge builds a new tree: if its key is unchanged it is remeasured,
otherwise measured as usual. Replies also name each active node-check block
that will be attributed on its original key before any repair, including the
current candidate's key, with its failure sequence and the command
`owed waive <node> --accept-risk <seq>` for accepting a possible flaky result.
A current-key check that already failed its attribution instead directs the
caller to `owed attest <node> --rerun`: another remeasure request does not
repeat that check. With no failed invariant, active check block or such
current-key failure, the reply says `nothing to remeasure: no failed merge-tree
invariant and no blocked check of <node>`. No Git tree is built at decide/resume
time.

For `owed decide <node> --remeasure` and `owed resume <node> --remeasure`, the
latest resume of the current attempt authorizes attribution of active execution
blocks whose failures precede it, before repair of that candidate. Each block
gets at most one pass or fail attribution after that resume; errors retain the
normal environment back-off and two non-environment errors halt. A plain resume
keeps ordinary repair routing for current-key failures. Attribution fail clears
the block but leaves the check failed for the writer to repair; attribution pass
leaves a flaky block requiring accepted risk. A pass never erases a failure.
Merge-tree invariant remeasurement before merge is unchanged; the direct
`attest <node> --remeasure` command still measures invariants only.

A refusal reusing a failing invariant observation measured before the current
call appends `reused #<seq> (same merge key, measured <age> ago); measure again:
owed attest <node> --remeasure` (CLI), or `owed resume <node> --remeasure`
(driver halt). Several reused seqs are comma-separated; age uses `45s`, `3m`,
`2h5m`, `1d2h` style. A fresh pass without repeat still conflicts with an old
behavioural fail; only a validated counted setup pairing can exclude a
zero-result failure (§7.26). Remeasure never silently clears behavioural risk.

### 7.15b Scheduled sweeps and automatic escapes (0.24, SW)

With `sweep.every` (§3.9), a continuously running driver, foreground or
detached and staying or not, starts due sweeps in the background. They use the
shared machine lease with no waiting and their own sweep operation lock,
consume no node measurement slot, never overlap another sweep and continue
alongside node work without waiting for it or preempting it. Driver stop or a
change to the recorded sweep definition or `every` policy cancels an in-flight
scheduled sweep; removing `every` also cancels it. Once its atomic append has
begun it completes. Plan cancellation records no verdict or interruption and
runtime activity says `sweep aborted: plan changed` until another sweep starts.
Preparation and tree checkout run before acquisition; the sweep requests its
lease immediately before the first setup or measurement command and retains it
through command cleanup. Scheduled leases use `--yield`: if dsa yields the
lease, owed cancels measurement, records nothing and retries on a later pass
like busy. Apparent unknown `--yield` refusals use the same confirmation as
priority (§7.14): identical cwd/env/flags, `--no-wait -- true`; only a confirmed
unknown-option refusal permits one retry without the flag and caches the
fallback in this process. Confirmation exit 0 or 75 returns the original
command result, never replays the measured command. Yield requires
pi-durable-subagents 1.1.0. Busy acquisition retries later; existing drift,
version and low-disk checks still apply. Without `every`, §7.15's idle-only
scheduling and preemption remain.

`owed drive --once` and the pi `owed_drive` pass never start a sweep and
wait only for node measurements they started. When a scheduled sweep is due,
they print `sweep due; --once does not start it (run owed sweep --due or a
background driver)`; JSON emits one runtime `sweep-due` event. An idle
running driver wakes on ledger changes for merge thresholds and one timer at
the minute deadline; schedule polling does not itself trigger a full replay.

`owed sweep --due` / `owed_sweep {due: true}` requires `sweep.every`.
If not due it appends nothing, exits 0 and prints
`sweep not due: next after N merges or at HH:MM`, omitting absent threshold
clauses and using local time. Regular `owed sweep` forces measurement; fail
or error still exits nonzero and never gates a merge.

Only completed head entries reset the schedule, not bisect samples. Merge
counting uses recorded owed merges on the first-parent range since the latest
head measured on an ancestor of current trunk; merges during its background
measurement remain eligible. Minutes use that head entry's timestamp, even
without trunk movement. Before the first sweep, merges start at initialization,
minutes at driver start for a running driver or initialization for standalone
cron calls. A historical sweep outside current trunk ancestry resets neither.
The first non-bisect sample in an atomically appended run is its completed head,
even if later bisect samples disagree.

A confirmed boundary requires **two failed head samples, two failed culprit
samples and a passing predecessor**, all in one contiguous same-definition
run. The final passing predecessor `sweep` entry carries optional
`boundary: {head, merge}`, referencing earlier head and culprit-merge entries.
Under the short ledger lock, after measurement, owed validates the complete
run and atomically appends it with at most one `escape`: `by: "executor:owed"`,
class `missing`, node and merge from the culprit, REQUIRED `escape.sweep`
citing the boundary, evidence `sweep #<boundary seq>: <names, max 5>`.
Parent/owner manual escapes must omit `escape.sweep`. Replay validates
principal, boundary, current definition, matching node/merge, canonical
evidence and dedupe; forged or duplicate executor escapes refuse.

Dedupe compares the same merge and sorted, deduplicated recorded head names,
not just the five displayed names. It also recognizes manual escape evidence
citing a sweep in the canonical `sweep #<seq>: ...` format. Manual parent/owner
escapes remain available; an unrelated free-text manual escape need not dedupe.
A flaky head, missing green boundary, measurement error, inconsistent bisect
or exhausted confirmation budget records evidence only, no automatic escape.
A definition change during measurement prevents the stale run from authorizing
a boundary or escape; its evidence remains tied to the measured commit/key.

Each newly recorded automatic escape produces one notice:
`escape: NODE (merge #S) broke NAMES on trunk COMMIT12; no check covered it.
Fix: a node whose brief names the test; coverage: HINT`. Repeated detection
produces no new escape notice. When protocols supply usable test locations,
the hint lists up to five failing test files outside every invariant's `reads`;
otherwise it says `add the test to an invariant`. Status, ordinary and full,
retains `trunk: sweep red since #S (NAMES)` across merges and errors until a
later passing head sweep of that trunk or a descendant clears it. Passing
bisect samples or older-ancestor sweeps cannot clear it.

Limits: dedupe uses all recorded names but protocols still retain at most
fifty; escape confirmation does not separately prove that the name list is
complete. Coverage hints are diagnostics, not proof that an invariant executes
those tests. Sweeps diagnose first-parent owed merges, not adoptions, and add
no acceptance obligation or red-trunk merge gate.

### 7.16 Fail-closed native quarantine and script delivery

The executor excuses failures only for check/invariant jobs whose keys commit
to exactly the active quarantine names (§3.6), never red or mutants jobs.
Native TAP requires all of the following before treating the runner exit as 0:

1. `run` passes the plain `node --test` allowlist: split on spaces; every
   non-empty token contains only `[A-Za-z0-9_./=:@,+*?-]`; optional leading
   `NAME=value` tokens, then exactly `node`, with a separate `--test` token.
   Quotes, tabs/newlines, `$`, backslashes, redirection, operators, shell/npm/pnpm
   scripts and wrappers are not accepted as known runners.
2. The run completed with **exit 1**, no timeout, signal or spawn error.
3. Counts are TAP; exactly one column-zero `1..N` plan and N column-zero
   `ok`/`not ok` results prove completeness.
4. Every failure has a distinct exact name (`counts.fail` equals name count),
   every name is active quarantine, and tests left after removing those names
   still meet `min_tests`.

Excused tests count neither passed nor failed; `counts.tests` and `fail` exclude
them. The observation records `quarantined: [names]` and note
`quarantined: <name> (fix: <node>)[, ...]`. Otherwise normal failure/error
semantics remain; `why` shows `quarantine not applied: <reason>`, such as
`not a known test runner`, `exit <n> is not a test failure`, `run did not complete`,
`no failing test names`, `counts are not TAP`, `no TAP plan`,
`several top-level TAP plans`, `TAP plan 1..<n> but <m> top-level results`,
`<f> failing tests but <n> failing names`, `<n> failing test(s) is/are not
quarantined`, or `<n> tests left, below min_tests <m>`.

**Native Cargo.** A plain `cargo [+toolchain] test` with `--no-fail-fast`
also qualifies, using the same space-separated token charset and optional
leading environment assignments as Node. It must complete with exit 101,
without timeout, signal, spawn error or truncated output. Counts must be
`cargo`, never `mixed`. The libtest output must prove all of the following:

- Each column-zero `running <N> test(s)` opens a block with exactly N result
  lines and exactly one column-zero `test result:` before another block;
  result/summary lines outside a block refuse. Actual pass/fail/ignored totals
  must agree with the summary and overall parsed counts.
- Results are `test <name> ... ok|FAILED|ignored|ignored, <reason>`; names are
  the exact text between `test ` and ` ... `, including doc-test names such as
  `src/lib.rs - f (line 12)`. Long-running notices are not result lines.
- Column-zero `error[` or `error:` lines refuse, except
  `error: test failed, to rerun pass …` and one optional
  `error: <n> targets failed:`. The rerun-line count and optional target count
  must each equal the number of failed blocks. Every
  `process didn't exit successfully` line must end with `(exit status: 101)`
  and contain no `signal:`.
- Failing names are distinct, occur as results in exactly one block, and
  agree with parsed failures. Every failure is active quarantine and remaining
  tests still meet `min_tests`. Matching is exact, not a libtest substring filter.

Excusal records exit 0 for Cargo (TAP retains its original observed exit 1),
excludes those names from test/failure counts, and records `obs.quarantined`
and the quarantine note. It is sound for the same reason as TAP: native output proves a completed test-failure run, every failure
is owner-authorized and committed in the key, and sufficient tests remain.
Uncertain output fails closed: terse output, incomplete blocks, compile errors,
crashes, duplicate/unlisted failures and more than 50 failures are not excused.
`owed-counts` cannot be natively excused. Template expansions and shell scripts
are not plain native runs.

**Script delivery.** Every eligible check/invariant execution with active names
receives `OWED_QUARANTINE_FILE`, an absolute private temporary-file path outside
the measured tree. It contains sorted exact names, one per line with a final
newline; each execution (including each repeat run) has a distinct file, removed
afterward. Own names containing CR/LF cannot be delivered: the note says
`quarantine file not written: a name contains a line break`. Every other run
owed starts, including setup, slot setup, red/mutants, sweep and timeout
hooks, has the variable removed from its environment.

Scripts may read this file instead of a repository skip list. Delivery alone
never excuses a failure or rewrites exit status. Runs with no native protocol
say `quarantine file: <n> names (owed excused nothing)` instead of the generic
unknown-runner explanation. Natively refused Node/Cargo runs retain
`quarantine not applied: <reason>`; Cargo-shaped scripts without the required
native syntax retain their Cargo refusal too. An `exec.wrap` container may not
see the host file; the wrapper must provide access. Skipping names cannot
prove they pass again.

**Recovery feedback.** Complete native TAP/Cargo trunk or merge-tree runs can
record sorted active names that actually passed as `obs.quarantine_passed`
(absent when none). While an entry remains active, the debt view uses the latest
observation for that check/invariant carrying recovery feedback, or a completed
plain TAP measurement with active names. An empty later Cargo feedback field
is absent, so it does not by itself retire an earlier Cargo recovery suggestion.
Explicit `attest --probe-trunk` uses the same recovery scope as the automatic merge probe; candidate-only passes do not record it.
Ignored, skipped and TODO results are not passing evidence. Status/brief/report
quarantine debt identifies the recorded pass and says
`remove it from quarantine if it stays green (fix <fix>)`. Single merge results
say `passed on the merge tree of <node>`; batches say
`passed on the merge tree of <a, b>` in member order, never `passed on trunk`.
Only a trunk measurement without merge/batch attribution says
`passed on trunk <sha12>`. Feedback changes no verdict, key, count or gate;
it is evidence to consider removal, not an automatic lift or proof of a fix.

### 7.17 Known limitations and backlog (0.22–0.27)

- `report --counterfactual` performs one read-only cold fold, costing about
  one full replay: expect tens of seconds on a roughly 14,000-entry ledger,
  potentially longer on a busy host. It holds no ledger lock and writes no
  ledger, replay snapshot or plan cache. Before folding it prints a stderr
  line announcing the entry/halt counts and cold replay cost (§9.4). Git
  objects are isolated in a temporary object directory, cleaned on completion
  or thrown errors; that directory can survive SIGINT. At most 200 rebase
  probes run; subsequent rebase classifications are `unknown`.
- Metrics halt classes use recorded text, so an older shared failure may appear
  as `other`; counterfactual uses replayed state. Metrics phases approximate
  acceptance from ledger events, not from replayed acceptance transitions.
- Shared trunk-red display and fix waiting infer unchanged invariant reads
  and closure, but do not account for a changed active quarantine set after
  another merge. They can show a park or exclude a node from a batch while
  the merge guard computes a different key and halts as a mixed refusal.
  The merge gate still checks the actual key (§7.24).
- Executor rebase rolls back ordinary failures, but cannot clean up after
  SIGKILL or a crash. In-progress Git operations or a moved HEAD need the
  writer recovery route. Direct Git writes and direct dsa sends are outside
  owed's slot-operation lock (§7.25).
- Decision atomicity covers validation and ledger append, not external answer
  delivery or replacement of a plan file after a successful append. Follow
  the recorded recovery instruction; no automatic answer retry or implicit
  reviewer acknowledgment is introduced (§8.3.1).
- `why` has no runtime `refused` delivery input, so its forwarding set cannot
  exclude sends refused at runtime. It uses the attempt's first writer launch,
  while the rule receipt identifies its last writer launch. Even a successful
  running-call notify leaves the ruling shown as undelivered until the driver
  sends the writer follow-up (§9.3).
- Driver activity display depends on local process liveness and bounded recent
  driver history. A foreign driver lock cannot prove in-flight work locally;
  missing/corrupt wait caches are diagnostic misses. Busy wait age resets
  when the driver restarts; legacy job waits without a start timestamp can
  only be matched by job label (§9.3).


- LKR: `advanceTrunk`'s fast-forward of the already measured commit with
  `git merge --ff-only` is the single named Git exemption inside the ledger
  lock. Owed never detaches the trunk worktree. Merge hooks, including
  post-merge and reference-transaction hooks, run under that lock; a slow hook
  can delay ledger writers. No general Git command timeout is added.
- The ledger-lock command guard tracks the current async context, including
  nested Ledger instances; it cannot detect a lock held by an external process.
  External harnesses must manage their own lock scope. Operation locks and the
  machine lease may remain held while measurements run (§7.23).
- Conservative glob overlap can delay disjoint patterns sharing a literal prefix.
  Overlap-only writes retries require a driver; without one, attest after the
  named slots close. Mixed refusal reasons do not receive automatic retries.
- Batch isolation is driver runtime state; status's ledger-only batch preview
  may still propose isolated members. The driver persists refused candidates
  across restarts and leaves them out of its batch plan (§7.21). A plan CAS
  change to a member or global setting during batch measurement discards its
  results and falls back to individual merges; unrelated node-only changes
  are allowed after fact rechecking (§7.21). Batch members are not bisected (§7.21).
- `remeasure_on` reacts to a measurement in the current operation, not cached
  failures. Manual remeasurement remains available. A crash or stale/aborted
  result before append leaves no completed automatic retry receipt (§7.20).
- Shell lint is bounded static analysis: runtime expansions, generated scripts,
  computed Bash names and indirect wrappers cannot be resolved (§3.7).
- Wrapper provisioning and remote process termination belong to the wrapper;
  killing a local client does not prove that remote work has stopped (§7.22).
- Idle detection is an advisory snapshot. Unlabelled calls cannot be attributed
  to a repository, and a crash between claiming and delivering a wake can
  suppress that idle period's notification (§12.8.2).

- Native Cargo quarantine requires complete non-terse output and at most 50
  failures. Scripts that skip quarantine names cannot report recovery; wrapper
  containers may not see the host's quarantine file (§7.16).
- `ignorable` supports top-level entry fields only; readers before 0.27 still
  refuse it where they refuse unknown fields (§5, Compatibility).
- The MS4 allowlist still permits leading `PATH`/`NODE_OPTIONS` assignments
  and `--require`, `--import`, `--test-isolation`; rejecting these is backlog,
  not a claimed safety check. Quarantine is not a sandbox/security boundary.
- Unlocked ledger reads ignore a final torn line; 0.23 also hides an incomplete
  final decision group in normal state loads (§8.3.1). Ledger lock tracking
  spans handles on the same real ledger directory, including symlink aliases.
  Counterfactual reporting also uses decision-group-aware visibility; locked
  counterfactual loads and verification still refuse incomplete groups.
  Other reader paths still need separate auditing; this is not a global
  torn-read guarantee.
- Pooled repeat is an intentional replay compatibility exception (§7 RC1),
  not an unchanged-replay promise for old multi-observation repeat ledgers.
- Fix merges refresh current trunk/merge quarantine keys, not an open
  candidate's stored submit check keys. Remeasure measures invariants only.
- Existing submit/review entries are not retrofitted with model metadata;
  unavailable dsa status leaves `model unknown` (§12.5.2).
- Prospective merge-tree invariant measurement before review, stopping surplus
  reviewers, and a lighter release API remain future work. Combined parent
  decisions are available in 0.23 (§8.3.1).

### 7.18 Timeout evidence and diagnostics (0.20.1, SG5)

A timeout in a check/red/invariant observation remains an **error**, never a
passing observation. Strength (mutant) runs retain the existing semantics
(§7 step 4): a timed-out mutant counts as killed when the run is not zero-test,
and the strength observation can pass if killed/total meets `min_kill`.
The timeout log blob retains the last 256 KiB of captured stdout/stderr, followed by
`timeout after Ns`, optional diagnostic output and a best-effort pre-kill
process tree. The note is `timeout after Ns` plus the last three measurement
output lines. The measurement output freezes at the timeout boundary;
legacy argv/local measurement groups are stopped then, while string-template
wrappers retain their shutdown grace (§7.22).
Counts, failed names and signatures use frozen pre-diagnostic output, so hook
output cannot inject measurement evidence.

Optional check/invariant `on_timeout: "<shell command>"` runs once before the
measurement group is killed, with a separate 30-second limit and the same
materialized tree, environment and `exec.wrap`. Its output is appended under
`on_timeout (diagnostic only)` with its exit code; neither output nor exit code
changes the measurement verdict. Diagnostic output is bounded to its last
256 KiB. Missing, failing or hanging hooks cannot prevent group cleanup.
`owed edit A --set 'checks.C.on_timeout=...'` and
`owed edit --invariant I --set 'on_timeout=...'` use the existing edit API;
there is no new CLI flag. Diagnostic-only edits change no check/invariant key.

The snapshot uses best-effort `ps -axo` fields pid, ppid, state, wchan, elapsed
and args (args cut to 200 characters), bounded to 4 MiB of ps input, 1000 selected
rows and a 2-second deadline. Unavailable ps is explicitly recorded. Linux is
behaviorally covered; macOS ps is best effort, not verified on the Linux host.

### 7.19 Partial grants and ownership waits (0.22, WG4–WG5)

Measurement grants every independently eligible out-of-scope changed path in
one sorted grant entry, then fails writes only for the remaining refused paths.
Reasons identify all open owners, closure paths and uncovered paths. Exact
path grants never widen a prefix. Fresh replay state recomputes eligibility
under the ledger lock before append; replay validates grants and wait metadata.

Optional writes observation `grant_refused: true` identifies closure or open-node
overlap grant refusals independently of the explanatory note. An uncovered path
alone does not receive it. Status hints use this structured field, not wording
matches. Historical field-free observations replay without inferring a refusal
from their text. Older readers that reject unknown observation fields must
upgrade before reading newly recorded grant refusals; plan hashes are unchanged.

An overlap-only current-candidate writes failure carries optional
`obs.waits_on: [ids]`, sorted and unique. The driver waits without a writes
repair or halt until every named slot closes by merge or abandon, then schedules
one fresh measurement of that candidate's same writes key. A subsequent writes
observation supersedes the earlier overlap-only vote; a non-error writes
measurement clears its execution block, including on a fresh candidate/rebase
key. This exception is confined to earlier failures carrying `waits_on`;
ordinary writes failures keep pass/fail conflicts. Other checks and review
blocks still receive their normal handling while writes waits. Mixed overlap
and closure/uncovered failures receive no automatic retry metadata.

An ownership waiting cycle halts with Needs you naming the cycle. Resolve it
with a plan change or by abandoning one slot, then resume the affected node.
An owner without a waiting candidate is not a cycle. Historical prefix-dialect
plans can also receive new overlap-only wait observations.

### 7.20 Automatic invariant remeasurement (0.22, RO1–RO3)

Invariant-only `remeasure_on: ["connection refused"]` is a list of non-empty,
literal, case-sensitive substrings; an empty list disables configured matching,
not eligible shared (§7.24) or setup retries (§7.26). It is scheduling policy, absent from measurement keys. Changing the list clears no
failure and does not reset the durable same-key budget.

RO2: an eligible failing single-node merge-tree or trunk invariant measurement
is remeasured once on the same key before refusal. Every parsed failure must
match a configured substring in its full raw error or expected/actual diagnostic,
without display truncation or normalization. Titles and passing output cannot
authorize retry. With no parsed tests, matching uses the captured raw log,
subject to the capture cap. Missing diagnostics or an incomplete capped failure
list fails closed. Errors, timeouts and execution failures do not trigger it.

Both behavioural observations remain evidence: `repeat` pools their runs;
without repeat, pass plus fail remains an owner conflict. The separate `infra`
rule excludes only qualifying zero-result setup failures (§7.26). Refusal, halt and trunk details quote
both votes and direct the owner to fix the invariant or defer debt for the
specific node. A defer for one node neither resolves the trunk conflict nor
authorizes adoption or another merge. Exact-key structured observations govern
this conflict even on unchanged keys; known-red/trunk comparison cannot turn it
into a pass. Manual remeasurement remains possible after the automatic budget.

Optional `obs.remeasure_match` contains only unique configured literals after
all failures match, bounded by that list; no raw matching diagnostics are added
as ledger fields. `obs.auto_remeasure: true` marks the consumed retry. Replay
requires the immediately preceding same-key eligible failure (configured
matching, shared or setup eligibility) and refuses a second automatic marker.
A setup-only retry needs 0.26 readers even when `infra` is absent (Compatibility). Normal stale-result, CAS,
abort and attribution rules remain intact; retry keeps the caller's lease and
outer measurement lock, never the ledger append lock. Eligible measurements
from merge, adopt, trunk/genesis refresh and explicit remeasurement use this
policy.

**RO2 and `merge_batch`:** a batch measurement failure is not
a refusal of any member. The batch falls back to per-member merges; each member
then gets its own one same-key automatic remeasure on its own tree when eligible.
Batch observations never carry `remeasure_match` or `auto_remeasure` and never
count as a remeasure receipt for a non-batch merge (§7.21).
Replay refuses batch observations containing either field. Single-merge
automatic-remeasure diagnostics also exclude batch observations when selecting
the first failure to quote.

### 7.21 Batch merge / merge train (0.22, MT)

`drive.merge_batch: N` accepts integers 1..8, default 1 (off), and changes no
obligation key. Upgrade every driver, CLI and plugin to >= 0.22 before enabling
it. The driver batches only at N >= 2; an explicit parent/owner
`owed merge A,B[,C...]` may request a batch independently of that setting.
Members are ordered by the merge queue, must be accepted, have pairwise
non-overlapping writes, have `closureTouched=false` and owe no `--remeasure`;
pending owner approval prevents acceptance. In 0.24 this includes candidates
whose closure changes are all `closure_neutral` (§6.2a): the
batch remeasures Mn with Mn's closure, and neutral paths cannot change test
behaviour. Non-neutral closure changes still exclude a member. A refusal names
the member and next action.

Build M1 = merge(T,c1), then Mi = merge(M(i-1),ci). Conflicting members drop
out and need individual rebase/merge; fewer than two survivors refuses without
recording. Measure invariants and each member's node checks on final Mn, using
Mn's closure/keys and quarantine with every member treated as merged. Reusable
verdicts and genesis jobs follow their existing rules.

On success, CAS checks ledger trunk, member slots/candidates and trunk ref.
Every plan entry recorded during measurement is also checked: remove all
non-member nodes and require canonical equality of the remaining plan before
and after that entry. All global fields (invariants, closure/neutrality,
setup/exec, allow, drive/merge policy and other settings) and every member
field remain binding. Unrelated node-only changes may proceed; a relevant
change, even one later reverted, refuses with the plan entry and changed part.
After an unrelated plan change owed recomputes facts and runs the latest guard;
an indirect fact change, including quarantine activation, still refuses.
Under the short ledger lock, one merge entry per member is recorded in order,
with prior M(i-1), commit Mi and facts against its prior. The trunk ref advances
once T -> Mn; intermediate Mi never become trunk heads. Every member carries
identical optional `merge.batch: {final, state, keys, members}`: `keys` maps
member ids to their obligation keys on Mn. The guard uses `batch.state` for
invariants and `batch.keys[node]` for node checks; base, acceptance, blocks,
writes and rulings retain their normal gates. The last member's commit/state
equal final/state. Inherited invariant debt is compared against trunk before
the train for every member, never an unmeasured intermediate Mi.

On measurement failure, optional `obs.batch: [ids]` attributes results to the
batch, never one member: no `merging`, `probe` or `attribution`. These votes add
no execution block, decoy catch or trunk failure-signature provenance. They are
evidence only for that batch; a later single merge measures its own tree with
`merging` even on an equal key and never uses batch votes in pass/fail pooling
or automatic-remeasure receipts (RO2, §7.20). Status counts batch evidence only
after its batch merges and the final tree becomes trunk. A later single-node
merge may use that completed batch's trunk failure to identify existing debt,
while independently measuring its own merge tree. New failure names, incomplete
or truncated failure lists and automatic remeasure conflicts still refuse under
the existing gates. This debt comparison does not reuse batch votes as the
single-node measurement verdict. The driver reports a retry, then merges
members singly in queue order. A recorded batch failure prevents the same set
being batched again on the same trunk while every member's current candidate
commit equals its candidate commit at that failure. Re-submitting the same
commit does not lift this suppression; a new candidate commit does.

In 0.31 (MQ2), every refused driver batch also isolates each member's candidate
commit in `.git/owed/drive/batch-isolated.json` (under the configured ledger
location when overridden). The driver writes this runtime file atomically and
loads it after a restart. Matching candidates merge alone in the existing queue
order, even after trunk moves or new partners appear. A record is removed when
the candidate changes, the node merges or the slot closes; a missing or unreadable
file means no records. A late refusal cannot isolate a newer candidate. The retry
report reads `batch merge refused (<reason>); <members> merge alone until merged
or resubmitted`. This scheduling state never changes ledger facts or merge gates.

`status --full` shows the planned batch beside Merge queue; JSON exposes optional
`mergeBatch: [ids]`. The displayed plan excludes dependency/continuation waits,
`later`, halted, trunk-parked and reported nodes. A member of a running batch is
shown as `merge in batch with <leader>`. CLI success names member commits,
dropped conflicts and the final trunk. Batch entries must be consecutive,
ordered and identical in metadata;
replay rejects other shapes. `verify.incompleteBatch` reports a torn batch tail.
The next owed write completes missing entries as `executor:owed` under the ledger
lock when the trunk ref is at `batch.final` and its first-parent history agrees.
Otherwise writes refuse: restore the trunk ref to the full final hash, using
reflog recovery if needed, then write again. Lost batch history requires manual
repair; `owed adopt` cannot close an incomplete batch. Tail detection reads
backwards in bounded chunks and loads full recovery state only for an incomplete
batch tail, including oversized non-final member lines; ordinary operations
may still load it for their own validation.

### 7.22 Wrapped measurement templates (0.22, RX)

`exec.wrap` accepts a shell template as well as the legacy nonempty argv array:

```yaml
exec:
  wrap: ssh runner /opt/project/run-check {cwd} {timeout} {cmd}
  wrap_grace_s: 30
```

`{cmd}` is required; only `{cwd}` (absolute original measurement directory),
`{timeout}` (integer seconds) and `{cmd}` (original command) are allowed.
Substitutions are POSIX single-quoted shell words, including embedded quotes;
do not quote placeholders again. The expanded template runs through `bash -lc`
in the existing environment, including `OWED_TREE` and, while leased,
`OWED_LEASED`. Admission validates placeholders and applies `bash -n` lint.

Checks, red runs, mutants, invariants, trunk probes, sweeps, setup and timeout
diagnostics share this path. Git, worktrees, ledger and lease acquisition remain
local. Provisioning/mirroring the prepared directory is the wrapper's job.
Propagate command exit status and stdout/stderr without adding test-protocol
output. Exit 126/127 when transport/provisioning prevents execution; use
`red_expect` to distinguish intended red failures from wrapper failures.

`exec.wrap_grace_s` is a nonnegative integer, default 30. At `timeout_s`,
evidence freezes: later output and diagnostics cannot supply counts, signatures
or retry matches. A string wrapper can finish during grace, but the measurement
remains timed out. Owed kills the local process group by timeout plus grace
(and cleans up remaining group members on wrapper exit); abort retains existing
termination behavior. The wrapper must bound remote work and propagate termination.
Legacy argv wrappers retain their existing timeout semantics.

Absent string templates preserve previous keys; a configured template enters
check/red/strength/invariant and trunk-probe keys verbatim. Substituted paths
and grace do not enter those keys. Sweep identity includes execution configuration;
local writes/review identities are unchanged. Wrapper configuration requires owner
authority. Old plans/argv wrappers replay unchanged; templates and grace require
0.22-capable readers.

### 7.23 Ledger lock scope (0.22, LK / LKR)

Ledger directories use their realpath: a symbolic-link alias of the same
ledger preserves lock ownership and strict locked-reader validation.
Shared command and job runners refuse with an internal error before spawning
inside an async context holding ledger `lock`, including wrapped commands and
timeout diagnostics. Nested Ledger instances do not bypass the guard. Worktree
add/remove/prune, clean/reset/switch/checkout and arbitrary Git merge commands
are guarded too. Driver cleanup of never-launched slots removes worktrees after
releasing the ledger lock. Merge, attest, trunk-refresh and sweep operation locks
still allow commands; short recording locks retain existing CAS and stale-result
checks. The only Git exemption is `advanceTrunk`'s already measured ff-only
advance; hook and external-harness limits are stated in §7.17. Owed never
detaches the user's trunk to perform the advance.

### 7.24 Shared failures and trunk-red waiting (0.23, FS)

A **shared failure** is diagnostic evidence that a test failed without this
candidate; it is never a pass. The failing check/invariant observation must
be test-only with a complete list of failed names. Every name must also have
failed in an earlier executor observation of the same obligation within the
preceding 5000 entries, with the same signature. For invariants, that evidence
may be a pure trunk observation or another node's non-batch merge tree measured
while this node was unmerged. For node checks it must be that node's trunk
probe. Attribution and batch observations cannot supply the comparison.
When neither side has a signature, matching names suffice for diagnostics,
retry and waiting, with `(same name; no error signature recorded)`; a signature
on only one side never matches. Cargo panic messages and locations now supply
the existing versioned failure signatures. Errors, timeouts and incomplete
failed-name lists do not become shared failures.

When the relevant failing merge-tree invariant observations are all shared,
the refusal leads with `shared failure: <obligation> <names> also failed on
trunk without <node> (#T); not attributed to <node>` instead of blaming the
candidate and suggesting a rebase. Names show at most three plus `+N`.
Eligible shared single-node merge-tree or trunk **invariant** failures receive
one automatic same-key remeasure even with empty `remeasure_on`. It shares the
durable retry budget in §7.20 and records `auto_remeasure: true`; a shared-only
retry has no `remeasure_match`. Shared-only retry skips `repeat` invariants and
skips an inherited/persistently red failure when the latest earlier pure trunk
observation on a different key failed with those names. Configured
`remeasure_on` retains its own rules. Both votes remain: a pass plus fail
without repeat is still an owner conflict.

The driver parks an accepted candidate when every merge refusal is covered by
shared invariant debt/conflict on its actual merge key, or a trunk-key automatic
owner conflict whose key is provably also this candidate's merge key. The latter
requires no candidate path under that invariant's reads or the plan closure,
and the guard must confirm the keys match. Other refusals remain mixed and
halt normally. A park sends no writer repair and launches no reviewer. Status
shows `waiting: shared failure (...)` or `waiting: trunk red (...)`; trunk,
trunk-item evidence, plan, candidate or this node's defers changing makes the
driver reconsider without a resume. Shared failures with the same names on
three distinct merge keys of one attempt stop parking and halt with
`shared failure persisted on 3 merge keys`.

Status and brief show one repository Needs-you item per condition; driver
notices group waiting nodes by class, obligation, sorted names and trunk commit,
and are revalidated before delivery. The parent can fix the common cause once
instead of instructing every writer to rebase. An unmerged fix candidate is
recognized when its title, brief, check command or test list contains an exact
failed name of at least six characters. If it has an open, accepted, non-halted
slot, affected nodes wait with `waiting: fix <node>`, letting it merge first;
otherwise it is only a hint. The fix still owes every merge gate.

The owner may explicitly retain debt with
`owed decide A,B --defer inv:integration --text "<reason to retain this debt>"`,
or pre-authorize narrow rules such as
`allow: [{nodes: ["feature-*"], defer: ["integration-*"]}]`. Adding or widening
that permission is an owner downgrade under §3.4. During a single-node merge,
owed can append a defer as `executor:owed` only when the current rule covers
the node/invariant, the merge key has both a pass and a shared failure, and
every shared match has a recorded matching signature. Name-only matches, node
checks, errors, timeouts and new names cannot authorize it. The guard must then
pass; the defer and merge append together. Replay validates the allowance,
evidence and derived reason. `defer.allowance` names the authorizing plan;
views and ΔO⁻ say `deferred by owed under allowance (plan #S)`, and debt remains
visible in why/report. No park or notice introduces a ledger field.

### 7.25 Review carry and executor rebase (0.23, ER)

A new submit can carry independent OK review and closure-review receipts from
this attempt's previous candidate C when all required counts/ranks were
satisfied without waivers or active review blocks. Owed computes the clean
merge of C onto the new base with C's recorded base as the explicit merge
base; the new candidate's tree must equal that result exactly. Substantive
edits and conflict-resolution edits do not qualify. Optional
`facts.carry: {from: <previous commit>, reviews: [<review seqs>]}` preserves
those receipts even when review keys change. Repeated clean rebases and plan
carry retain original review provenance. Checks, red/strength, approvals and
invariant evidence are not copied: their normal exact keys still govern.
Later rulings still need acknowledgment. Why and submit receipts show
`review carried from <commit12> (#S, ...) across a clean rebase onto <base12>`.

When a rebase is needed, the driver applies it itself only with a recorded
writer launch, no writer launch/follow-up intent after the latest submit, a
freshly inspected sealed current generation, no Git operation in progress, a
clean worktree and HEAD equal to the candidate. It uses
`git rebase --onto <new base> <merge-base(HEAD, new base)>`, avoiding replay of
trunk commits already merged into the writer branch. Success appends adjacent
rebase and `executor:owed` submit receipts with `facts.rebased: true` and carry
when eligible. Normal driver measurement then handles the resulting keys;
no writer turn is needed for that rebase. Only the first later writer follow-up
says `owed rebased your worktree onto <base12> (clean); continue from HEAD`.

Parent/owner CLI `owed rebase <node> --apply` requests the same operation.
Without a recorded writer run, explicit apply asserts that no writer is active
and says so in its receipt; automatic no-launch slots use the writer route.
Explicit apply refuses dirty/live/unknown/in-progress/noncandidate slots.
Ordinary `owed rebase` and the pi `owed_rebase` tool already record the
slot-base move and invalidate the candidate, then print the manual Git
instructions; they do not perform the Git rebase.
A conflict or ordinary execution error aborts and proves original HEAD and a
clean tree restored before fallback; the result lists conflict files or the
error. A stale result is rolled back and refused. Rebase execution is bounded
at 60 seconds, abort/reset at 15 seconds. Crash leftovers offer the writer
abort or inspect/keep/submit versus reset/rebase recovery (§7.17).

Explicit apply may resend an owed-recorded writer follow-up with its original
request id and bytes to verify the durable delivery generation. This retry is
idempotent; if it newly delivers the follow-up and advances the generation,
the earlier sealed inspection no longer proves the writer idle, so apply
refuses to take over the slot.

Owed serializes rebase with writer launch/send intents using a per-node lock
before the ledger lock. Driver launch, send and rebase operations that return
Busy retry on the next pass without recording a halt. Git mutation runs outside
the ledger lock; candidate, base, plan, slot and trunk are rechecked before
adjacent receipts append.
Replay checks carry provenance and independent review eligibility; executor
rebase submit must immediately follow the same open attempt's rebase, use its
base and carry the executor's ancestor fact. Writer rebased markers and merge
facts with either submit marker refuse. Recovery identifies the actual Git
operation in progress: `git rebase --abort`, `git merge --abort`,
`git cherry-pick --abort` or `git revert --abort`, then the rebase instruction.
These facts use the existing trusted Git-facts boundary; no migration or new
plan key is introduced.

### 7.26 Setup failures and counted-pass resolution (0.26, IF)

A **setup failure** is an executor `fail` on a counted `check:*` or `inv:*`
that asserted no test result: tests absent or zero, no failed names (including
count-level names), no nonzero pass/fail/skip counts, and no timeout or
incomplete execution. Verdict `error` is excluded. For repeated observations
every recorded run must meet that definition. Counted means the observation's
recorded spec has `min_tests`, its parsed counts have a `format`, or an earlier
executor observation of that subject/obligation was counted. The predicate
comes from ledger facts, not the text of an error signature.

Eligible single-node merge-tree and trunk invariant setup failures receive
one automatic same-key remeasurement even with empty `remeasure_on`, sharing
§7.20's durable budget, lease and operation locks. Node checks use attribution
on their original key, including when that key is still the candidate's key.
Batch observations and trunk probes do not use setup pairing or setup-only
automatic retries. Unlike shared-only retries, setup retries can apply to
`repeat`: no behavioural votes are being excused.

The next executor measurement of the same subject/obligation/key can record
optional `infra: <immediately preceding setup failure seq>` only when it is a
counted pass: exit 0, positive test count meeting the failed run's original
specification, fail 0, no failed names or timeout, and complete/count-valid
execution when recorded. Every executed repeat run must qualify, and the
number of runs must satisfy the original repeat specification. A later lower
threshold cannot authorize resolution of the older failure.

The reference is attached under the final ledger lock against latest state
(or private ordered replay of drafts), never inferred from a stale measurement
snapshot. Replay validates that reference and excludes from the effective evidence pool
the maximal consecutive run of setup failures ending at it. A probe, batch,
error, timeout or other measurement breaks that run. Earlier behavioural
failures remain binding. Qualifying setup blocks clear rather than becoming
flaky; the counted pass satisfies the obligation with no conflict, waiver,
owner decision or debt from that setup sequence. Without `infra`, the old
pass/fail and attribution rules remain unchanged. Soundness: the exact key
fixes the measured content and command; a zero-result run asserted nothing
about test behaviour, while the counted pass actually meets that specification.
A deterministic candidate-caused setup break cannot resolve itself without
such a pass. A failure that ran tests still conflicts with a same-key pass.

Merge refusals and node-check halts inspect the latest measurement of each
failing key. A current setup failure leads with `setup failure (no tests ran):
<signature> — likely the environment; fix it, then owed decide <node>
--remeasure`, not rebase advice. A later real failure takes the normal repair
path. That decision also lets the driver retry a current candidate-check setup
failure after attribution has cleared its block. Merge-refusal halts reach the
follower as Needs-you wakes, retaining this remedy.

Setup signatures use the first captured error-looking line (`Error`, `Cannot
find`, `ENOENT`, `ERR_`, `not found`), or the last nonempty line, with volatile
absolute paths, hex ids, numbers and timestamps normalized. Within the last
30 minutes, the same signature on at least two subjects produces one repository
notice per signature/trunk commit: `setup failure on <k> trees: <signature> —
probably the environment, not the nodes (<nodes>); fix it, then owed decide
<nodes> --remeasure`. Candidate and merge tree of one node count as one subject;
trunk is a separate subject. Missing captured output cannot establish a shared
signature. Notices/signatures are diagnostics, never proof or acceptance.

`why --full` retains referenced setup failures labelled `infra`; the ledger
retains the whole history. Metrics count infra pairing receipts per obligation,
not every predecessor removed by a single receipt (§9.4). There is no new plan
key or entry kind. Reader upgrade order is in Compatibility.

### 7.27 Explicit trunk check probes

`owed attest <node> --probe-trunk [--check <id>] [--runs <n>]` measures node
checks on current trunk as diagnostic `obs` entries with `probe: "trunk"`.
It requires an open slot and candidate. Without `--check`, selection is every
node check with an active/flaky exec block; otherwise it selects that node
check. `--runs` is 1–10, default 1, sequential per check and stops that check
at its first non-pass. Existing same-key probes do not skip an explicit run.
Red/mutants checks and tests new in the candidate are refused, as is an empty
selection (name a check explicitly). Probe mode cannot combine with rerun,
remeasure, trunk, genesis or all; check/runs require probe mode.

The command uses the machine lease and node attest lock. Each run appends
only after validation and a fresh plan/candidate/slot/trunk CAS; a moved CAS
records nothing for that run, while earlier recorded runs remain. Per-check
output names trunk, outcome and observation receipts, then the compact why
card. CLI exit is 0 when all pass even if the candidate owes work, 1 for a
non-pass or moved CAS, 2 for usage and 75 for Busy.

Probes never satisfy or block obligations or alter candidate keys/counts.
The latest non-error probe on current trunk can set or clear a merge-tree
check's trunk-red diagnosis; the next merge reuses matching probe evidence,
but the failed merge check still refuses. Complete same-definition check
failures may also use probes recorded before or after the failure as shared
failure evidence (§9.9); invariant matching keeps its earlier-observation rule.
Native quarantine and recovery feedback apply as in §7.16. The CLI/API exposes
this mode; `owed_attest` has no probe parameters.

## 8. Operations (src/ops.ts) — the single API used by CLI and pi extension

```ts
init(o: {cwd, plan: string, as: Principal, channel, signal?}): Promise<InitResult>      // genesis + genesis attest of invariants; signal: §7.8
readPlan(o: {cwd, path, rev?}): Promise<{plan, rev?, path}>   // plan text from the working tree, or from commit `rev` (`git show rev:path`); path repository-relative
planSet(o: {cwd, plan, rev?, path?, note?, as, channel?}): Promise<Entry>   // records rev/path (and note: why, D25.5) in the plan entry
edit(o: {cwd, node? | nodes?: string[] | invariant?, set?, unset?, node_new?, note, plan?, rule?, writer?, resume?, after?, expect?, dry_run?, as, channel?}): Promise<EditResult | EditPreview> // ED2: one lock; dry_run previews only
editPreview(o: EditArgs): Promise<EditPreview> // ED1: diff, downgrades, prior/next plan and text; no effect
amend(o: {cwd, node, writes, note, plan?, as, channel?}): Promise<AmendResult>   // N3: plan file edit + plan entry (as planSet) + carries + rule, one lock
rule(o: {cwd, text, nodes, writer?, prospective?, as}): Promise<RuleEntry & {delivery?: RulingDelivery}>
answer(o: {cwd, node, text, qid?, rid?, rev?, as, channel?}): Promise<{entry: RuleEntry, request: string, delivery: SendResult, answers: AnswerState[], rulingDelivery?: RulingDelivery}>   // AN1–AN2: discover, record once, send kind answer; a failed delivery reports the recorded seq and exact retry command
dispatch(o: {cwd, node, as, allowOverlap?}): Promise<DispatchPacket>   // creates the branch and worktree of §8.1 (default owed/<node>/<attempt>, <main worktree root>/.owed/wt/<node>-<attempt>)
rebase(o: {cwd, node, as, apply?: boolean}): Promise<RebaseResult>      // parent/owner or the slot writer; appends `rebase`, returns the packet with the git commands
submit(o: {cwd, node, commit?, model?: string, as}): Promise<Entry>      // default commit = HEAD of the slot worktree; must be clean
attest(o: {cwd, node, rerun?: boolean, remeasure?: boolean, all?: boolean, signal?: AbortSignal}): Promise<AttestResult>   // abort: §7.8
attestProbeTrunk(o: {cwd, node, check?: string, runs?: number, lease?: boolean, signal?: AbortSignal}): Promise<TrunkProbeResult> // diagnostic; §7.27
review(o: {cwd, node, verdict, rank, note, as, ack_rulings?, model?: string, obligation?: "review"|"closure-review", needs?: "parent", named?: string, pin?: {seq, commit}, from?: string[]}): Promise<Entry>   // named: --candidate; pin: an owner dialog's candidate; from: more working directories for the writer-worktree rail
waive(o: {cwd, node, obligation, reason, accept_risk?, tracked_by?: string, as, channel, named?: string, pin?: {seq, commit}}): Promise<Entry>
defer(o: {cwd, node, items, reason, as, channel}): Promise<Entry>
abandon(o: {cwd, node, reason, hold?: boolean, as}): Promise<Entry> // returns the abandon; hold appends both entries atomically
merge(o: {cwd, node, as, signal?}): Promise<MergeResult>          // builds M, attests M, guarded CAS; abort: §7.8
adopt(o: {cwd, commit?, note, as, channel?, signal?}): Promise<AdoptResult>   // owner, or parent under an adopt allowance (§3.4); records trunk commits made outside owed (§6.6); abort: §7.8
adoptPreview(o: {cwd, commit?}): Promise<AdoptPreview>   // the same preconditions, no effect: {trunk, prior, commit, commits, changed}
status(o: {cwd}): Promise<StatusView>
why(o: {cwd, node}): Promise<ReceiptCard>
reportMetrics(o: {cwd, since?: number | string, until?: number | string}): Promise<Metrics>  // MT, ledger-only computation
report(o: {cwd, since?: number | string}): Promise<Report>
brief(o: {cwd, since?: number | string, now?: number}): Promise<Brief>
verify(o: {cwd}): Promise<VerifyResult>                  // hash chain + replay; G1.4: {snapshotMismatch?: seq} when a disk snapshot matching the chain differed from the full replay at its seq (deleted); {code: 'version'} on a G1.5 refusal
escape(o: {cwd, node, merge, class, note, evidence?, as, channel?}): Promise<Entry>
decoyDigest(text: string): {digest}                      // pure helper; parses the reveal JSON, writes nothing
decoyCommit(o: {cwd, digest, as, channel}): Promise<Entry>
decoyReveal(o: {cwd, payload: string, as, channel}): Promise<Entry>   // payload = reveal JSON text
approve(o: {cwd, node, note?, block?, as, channel, candidate?: {seq, commit}, named?: string}): Promise<Entry>   // D23: owner only; review entry on obligation approve, rank 3; candidate = the confirmed one
approvePreview(o: {cwd, node}): Promise<{node, seq, commit, base, changed}>   // D23: what the owner approves (no effect)
candidatePreview(o: {cwd, node}): Promise<{node, seq, commit, base, changed}>   // G1.2: the open candidate, for the waive and owner-review dialogs (no effect)
candidateArg(v?: string): string | undefined              // G1.1: validates --candidate (7..40 hex; usage error otherwise)
evidence(o: {cwd, node, id, files: string[], note, as, channel?, expect?, candidate?: {seq, commit}, named?: string, from?: string[]}): Promise<EvidenceEntry>   // D23: candidate evidence or receipt; expect = files a dialog showed, candidate = the candidate it showed
evidencePreview(o: {cwd, node}): Promise<{node, candidate?: {seq, commit, base}, merge?}>   // D23: where evidence would be recorded (no effect)
evidenceFiles(o: {cwd, files: string[]}): Promise<EvidenceFile[]>   // D23: read + sha256 + bytes; repository-relative path when inside the repository
```

The confirmed candidate is the one approved: `approve` and
`evidence` given `candidate` (the submit seq and commit an owner confirmed)
refuse under the lock with `candidate changed since confirmation; nothing
recorded` when the node's current open candidate differs (a resubmit, rebase or
abandon during the confirmation); the CLI approve prompt and the pi
`owed_approve` / owner `owed_evidence` (candidate mode) dialogs always pass it.
Under `OWED_CONFIRM=owner` the waive and owner-review confirmations (pi dialog;
CLI: a stderr line `Waive <node>/<obligation>: candidate …` or `Owner review of
node <node>: candidate <commit> (submit #<seq>), base <base>, N changed files`
before the TTY prompt) show the open candidate as approve's does and pin it the
same way (0.6.0, G1.2, F1).

Act binding (0.6.0, G1, F1/F2). `review`, `waive`, `approve` and `evidence` (on
an open candidate) accept the candidate the caller judged: CLI `--candidate
<commit>`, pi parameter `candidate`, ops `named` — 40 hex or a prefix of at
least 7 hex (case-insensitive; otherwise a usage error before anything is read).
Under the ledger lock at append time the act is refused unless the node has an
open candidate whose commit starts with it: `candidate changed: you named
<given>, the open candidate is #<seq> <commit12>; nothing recorded`, or
`candidate changed: you named <given>, node <node> has no open candidate;
nothing recorded`. Without it behavior is unchanged; nothing new is recorded.
Delegated owners and reviewers pass the commit they read, so a resubmit between
reading and acting makes the act fail instead of landing on content nobody
judged. Identical retries on the same open candidate append nothing (§8.3.3);
that rule does not bypass candidate pins or validation. Every command owed
suggests for such an act on a node with an open candidate carries `--candidate <commit12>` (§2.1.6, the review packet §12).

Repository root. Every path owed derives for the repository (dispatch worktree
paths, gc, `info/exclude`) uses the **main worktree root**:
- in the main worktree (absolute git dir = absolute common dir, which also holds
  for a submodule, common dir `super/.git/modules/sub`, and for
  `--separate-git-dir`) it is `git rev-parse --show-toplevel`;
- in a linked worktree it is `d` = parent directory of the common dir, used only
  when `git -C d rev-parse --path-format=absolute --git-common-dir` is the same
  common dir and `git -C d rev-parse --show-toplevel` is `d`; otherwise dispatch
  and gc refuse with a usage error "run owed from the main worktree" before any
  ledger, `info/exclude` or `git worktree` effect (a submodule's or a
  separate-git-dir repository's linked worktrees cannot locate the main worktree).

So running dispatch or gc from inside a slot worktree (or a subdirectory) of an
ordinary repository gives the same paths as from the main checkout, and a new
worktree is never nested inside another one. Only the
questions "is the cwd this slot's worktree" (writer inference, submit's
dirty check) use the per-worktree top level.

Dispatch refuses when the node's `writes` overlap the writes of another node
with an open slot (conservative literal-prefix-before-wildcard overlap, §3.7),
naming that node; `allowOverlap`
(`--allow-overlap`) dispatches anyway and records `overlaps: [node ids]` in the
dispatch entry. Overlap is checked by the operation, not the reducer.

`rebase` is the way to follow a moved trunk without abandoning: it requires an
open slot and a trunk different from the slot base, and appends
`{kind: "rebase", node, attempt, base: trunk, from: slot base}`. Without
`--apply`, `owed rebase <node>` already records the slot-base move and
invalidates the candidate; it is not a dry run. In 0.28 its first receipt line is
`moved the slot base; the writer must rebase and resubmit (use --apply to rebase as executor)`.
It prints the writer's
`git rebase --onto <new> <old>` command, using the computed upstream (§12.5.2)
when HEAD already contains trunk commits. The writer then rebases in the same
worktree and submits again. Parent/owner `--apply` additionally performs the
Git rebase and executor submit, subject to the safety checks and rollback in
§7.25. The new submit must descend from the new base. A submit containing
trunk commits after the recorded slot base is refused: the parent records
`owed rebase <node>` first, then the writer runs the printed rebase and submits.
A merge whose candidate conflicts with trunk refuses with
`rebase needed: run owed rebase <node>, …`.

`merge` marks every `obs` it appends for the merge result — invariants and
checks on M, pass or fail, refused or not — with `merging: <node>` (§6.5).
Merge-key checks run on a synthetic merge commit: HEAD^1 is the trunk tip and HEAD^2 is the candidate.
A check must not pin the candidate's base commit. An anonymous merge-key
failure shows its last non-empty output line in the refusal and, for newly
recorded merge-check blocks, in the need/notice detail; the line is escaped
and bounded to 160 characters.

Batch merge-tree observations instead carry `batch: [ids]` (§7.21).
Genesis invariants that merge measures first on the current trunk are not
merge results and carry no `merging`.

`adopt` (owner, or a parent when the current plan has `adopt` allowances, §3.4;
role checked first, then a confirmation channel for the owner) checks,
before any ledger effect (for a parent also that every changed path
matches an `adopt` scope, naming the first one that does not): `note` is non-empty; `commit` (default
refs/heads/<trunk>) resolves to the current ref, or in 0.24 to an off-ref
fast-forward while that ref equals ledger trunk (§8.3.2); it differs from the
ledger trunk ("nothing to adopt" otherwise); the ledger trunk commit exists in the repository
("ledger trunk <sha> is missing from the repository" otherwise) and is an
ancestor of it ("trunk was rewritten", otherwise). Under the `merge` lock (serialized with merges) it
computes the state facts of the commit, runs genesis jobs and every invariant
whose key changed on the adopted commit and lacks a verdict (subject `trunk`,
no `merging`), then under the ledger lock re-checks that plan and ledger trunk
are unchanged and that refs/heads/<trunk> still equals the ref captured under
the merge lock — otherwise it appends nothing. If `adoptGuard` (§6.6) fails it
appends the observations and refuses, naming each invariant that was satisfied on the ledger trunk and not on
the commit with its observation seqs; trunk stays unadopted. Otherwise it appends
the observations and the `adopt` entry, first advancing the ref for an off-ref
hotfix as in §8.3.2. Adoption of the existing ref does not move it.
`AdoptResult` = `AdoptPreview & {entry, observations, allowance?}` (`allowance` =
S of §3.4 for a parent adoption).

The merge CAS refusal (refs/heads/<trunk> ≠ ledger trunk) says how the ref
differs: ahead by N commits made outside owed (then the owner runs `owed adopt`),
or diverged/rewritten (not a fast-forward; adopt cannot record it), or a ledger
trunk commit missing from the repository.

`gc(o: {cwd, dryRun?, as?, channel?}): Promise<GcResult>` reclaims finished
attempts. It is a parent/owner operation (same rule as `abandon`; default
actor `parent:cli`), refused for any other role. For every `dispatch` entry whose attempt is merged or abandoned (never
the current open slot) it removes the slot worktree with `git worktree remove`
(no `--force`) and deletes the branch recorded in the dispatch entry (§8.1) with `git branch -D`
only when that name maps back to the attempt it collects: when another dispatch entry (another node or attempt,
possible under an ambiguous template of an older plan) recorded the same name, the branch is kept with reason
`branch name <name> is also recorded for <node>#<attempt>, …; not deleted`;
then runs `git worktree prune` (also run first, so a hand-deleted slot directory
does not pin its branch). Before removing anything of a finished attempt it pins
each commit of that attempt's `submit` entries that the ledger's trunk commit does
not reach, with `git update-ref refs/owed/keep/<node>/<attempt>/<submit-seq>
<commit>` (one ref per submit entry; create-only, an existing ref is left alone),
because attribution reruns (§7) re-execute old blocks on those commits; this also
applies when the branch is already gone but the commit still exists. gc never
deletes `refs/owed/keep/*`. If a pin fails the worktree and branch are kept; a
submitted commit that is already missing is reported in `kept`. It runs under the `dispatch` lock. A finished worktree
that is locked or dirty (`git status --porcelain` shows tracked or untracked
non-ignored changes) is kept together with its branch; a branch checked out in
another worktree is kept; an unregistered directory at the slot path is left
untouched. A finished worktree that contains another registered worktree (a
layout left by older dispatches from inside a slot) is kept with reason
`contains worktree <path>`, so gc never deletes an open slot nested in it.
Attempts whose worktree and branch are both gone are skipped, so gc
is idempotent. Reused measurement trees (§7.12) are never treated as slots
(never in `removed` or `kept`); gc removes those whose lease is free when the
plan does not set `exec.trees: reuse`, their check id is gone, or (0.11, F2.5)
their check belongs only to merged or abandoned nodes (§7.12), listing them in
`trees: {path, reason}[]` and trees whose lease a live process holds in
`treesKept` (both present only when non-empty; dry-run removes nothing; no
ledger entry is appended for them). Result: `{dryRun, removed: {node, attempt, worktree, branch, pinned}[],
kept: {node, attempt, worktree, branch, reason}[], trees?, treesKept?, entry?}`; in `removed`,
`worktree`/`branch` is `null` for a part that was already absent, and `pinned`
lists the keep refs created (in dry-run: that would be created). When it
removes or pins something (not in dry-run) it appends one `note` entry (by the caller,
default `parent:cli`) naming what was removed and pinned; there is no new entry kind and
the reducer is unaffected. `dryRun` reports the same classification without
changing git or the ledger.

In 0.29, compact/full status and the merge reply show
`Housekeeping: <n> finished attempt worktrees; owed gc reclaims them` when at
least five recorded attempts are no longer open (merged, abandoned or
superseded) and their worktrees remain registered. This is a read-only hint,
not automatic gc or a promise that dirty/locked worktrees will be removed.
A failed worktree listing shows no hint; unrecorded and measurement worktrees
are not counted.

### 8.1 Worktree layout and a trunk checked out elsewhere (D19)

Dispatch of attempt `a` of node `n` creates the worktree at
`<P>/<n>-<a>`, where `P` is `resolve(<main worktree root>, worktrees.root)` with
its deepest existing ancestor resolved through symlinks (the physical path, equal
to git's toplevel inside the slot, so writer inference matches it), and the branch from
the template (§3.1; `{type}` = the node's `type`, default `feat`). The expanded
name must pass `git check-ref-format --branch`, and the root must not be the main
worktree root itself; otherwise dispatch refuses (usage) before any ledger,
exclude or worktree effect. Missing parent directories of the worktree are
created; a dispatch that then fails (in `git worktree add`, or when the ledger
moved and it rolls back the worktree and branch) removes the directories it
created again (empty ones only). Every rollback step (`git worktree remove`,
branch deletion, directory cleanup) runs even when an earlier one fails. Branch
deletion uses `git update-ref -d refs/heads/<branch> <base>`: Git compares the
old value and deletes in one transaction (0.10, N2). A moved ref is
kept and the CAS failure is reported under the existing `git branch -d` rollback
label. A branch still checked out in a worktree is also kept. An untouched branch
can be removed even when the main worktree's HEAD does not contain its base. The
error then names the original failure and each failed step, and nothing is
recorded. `<git common dir>/info/exclude` gets `.owed/` for the default root (as
in 0.4.1), `/<repository-relative root>/` for another root inside the main
worktree (with `\`, `*`, `?`, `[` and a leading `!`/`#` escaped, so it matches
that directory literally; the line stays after the slots are gone), and nothing for
a root outside it (both compared as physical paths). The dispatch entry records `branch` and
`worktree`; every later use (submit/rebase writer inference, rebase packets,
gc, the driver, views) reads the recorded values and never reconstructs them.

**Slot setup (0.16, SS).** After `git worktree add` and before appending the
`dispatch` entry, dispatch runs `slot_setup` when it is a string, otherwise
`setup` when present. `slot_setup: false` skips slot setup; absent commands do
nothing. CLI dispatch, the pi tool and driver all use this path. The command
runs in the new slot worktree with the measurement command's `bash -lc`,
`exec.env`/`exec.wrap`, inherited-environment filtering and `CI=1 OWED=1
OWED_TREE=<slot worktree>` handling (§7.9), with a fixed 600-second timeout.
Success adds exactly one packet line `Setup: ran \`<command>\` in this worktree
(exit 0)`; the command is rendered with the existing one-line escaping
(newlines as literal `\n`, backslashes doubled). Failure refuses with the command's exit code (or timeout) and the
last 20 combined output lines, removes the unrecorded worktree including setup
artifacts, deletes its unchanged branch and newly created parent directories
through the existing rollback path, and appends no entry. Rollback failures
still name every failed step.

Setup outputs must never enter a candidate (SS5). Compare
`git status --porcelain -z --untracked-files=normal` before and after setup.
A successful command that leaves a modified, deleted, renamed or other changed
tracked path refuses dispatch with those paths and rolls back as above. Every
new untracked, not-ignored status path is appended once to the common
`info/exclude` as an anchored `/<path>` literal rule (directories retain Git's
trailing `/`). Glob characters, backslashes, leading `!`/`#` and trailing spaces
are escaped; newline/carriage-return paths cannot be represented and refuse
with one-line escaped paths and the same rollback. Existing excludes are
preserved, already ignored outputs need no new rule, and repeat dispatches do
not duplicate rules. After appending, SS6 verifies in the
slot with `git status --porcelain -z --untracked-files=all` that every newly
created status path, including directory descendants, is now ignored. A tracked
`.gitignore` rule such as `!/artifact` can override `info/exclude`. If any output
remains visible, dispatch refuses with its one-line escaped paths and explains
the higher-precedence tracked rule: ignore setup outputs in the repository or
change `slot_setup`. The SS2 rollback removes worktree/branch, records nothing,
and removes only this dispatch's appended exclude bytes, leaving pre-existing
rules unchanged (also on a later dispatch-recording failure). Owed never edits
tracked ignore files. Added rules on success remain in the common excludes for
all worktrees. When rules are added, the packet line ends
`(exit 0; excluded: /a, /b)` instead of `(exit 0)`; paths use the same one-line
escaping. Dispatch serializes exclude writes with its existing operation lock
and publishes them only after the ledger CAS/guard succeeds, before appending
its unchanged dispatch entry. Rebase reuses the worktree and does not rerun
setup; rerunning on rebase is deferred.

`slot_setup` is a plan field only (non-empty string or `false`); it enters no
check/invariant key, changes no existing `setup` key formula and invalidates no
candidate or evidence when changed alone. No ledger kind or field is added;
0.15 and 0.16 share the ledger. Compatibility: this field
needs a 0.16 parser. Owed 0.15 ignores unknown top-level plan fields, including
`slot_setup`, and runs no setup at dispatch. Mixing versions changes no
acceptance, only whether setup runs at dispatch.

**N2 / DQ1 (0.20.1):** dispatch retries CAS refusals for at most three attempts
in total (initial attempt plus two retries), each with a fresh ledger read,
including when plan, candidate, trunk or open slots change. Every attempt
checks current node membership, hold, readiness and unmerged dependencies,
then writes overlap before computing paths or creating a worktree. A removed,
held, no-longer-ready or overlapping node is a normal non-CAS refusal.
Dispatch keeps its dispatch lock across attempts and finishes worktree, branch,
directory and setup-exclude rollback before retrying; a failed rollback is
returned immediately. The third CAS failure returns the last refusal with its
original error class/code; the driver reports only the exhausted refusal as
`retry next pass`, never Needs you or a halt. Other failures (authority,
validation, git, setup, lock timeout) are not retried. Plan/amend/edit retain
N2's three-attempt bound **only while the plan sha stays unchanged**; a changed
plan prevents their retry. No acceptance gate changes.

When the trunk branch is checked out in a linked worktree, a merge fast-forwards
it there (`git merge --ff-only` in that worktree) and refuses when it has
uncommitted tracked changes, before trunk moves and without recording the merge:
`trunk worktree <path> has uncommitted changes: commit them there, or detach it
(git -C <path> switch --detach), then retry` (refused, exit 1). Dispatch, merge
and gc never switch the main worktree's branch or HEAD and never change its
tracked files or index, with two exceptions: slot worktrees are created and
removed under a root inside it (the default `.owed/wt`; excluded as above), and a
merge fast-forwards it when the trunk is checked out there. With a root outside
it and the trunk checked out elsewhere they write nothing in the main worktree.
A new plan cannot have an ambiguous template (§3.1); one recorded by an older plan
may still expand to the same name for two attempts (dispatch then fails in
`git worktree add`), and gc keeps a branch recorded for more than one attempt.

### 8.2 Init and genesis attest (D24)

```ts
init(o: {cwd, plan, as, channel, signal?, measure?: boolean /* default true */, commit?: string}): Promise<InitResult>
initPreview(o: {cwd, plan}): Promise<InitPreview>   // {trunk, commit, planSha, nodes, invariants}; refuses an initialized ledger; no effect
attestGenesis(o: {cwd, signal?}): Promise<AttestGenesisResult>   // measures the genesis items still lacking an observation
genesisPending(o: {cwd}): Promise<string[]>; genesisReport(o: {cwd}): Promise<{recorded, failed, missing}>
genesisIncompleteText(seq, {recorded, missing}): string
```
Genesis items are the invariants of the current plan that have a genesis key; an
item is observed when it has a non-error executor observation at that key.
`GenesisAttest = {complete, recorded, failed, missing, superseded, error?}`
(`recorded`: observed ids, `failed` those of them that failed, `missing`: the
rest). `InitResult` gains `genesis: GenesisAttest`. Once genesis is appended,
`init` succeeds even when its genesis attest does not observe every item (an
error verdict, or an exception — `error` holds its message). A genesis job is
superseded only when its invariant left the plan, which is then no longer a
genesis item, so superseded jobs never make it incomplete. With
`measure: false` it measures nothing. An abort after genesis rejects with
`OwedError('aborted')` whose message is the incomplete text (§10.1); an abort
before genesis keeps the message `aborted`. `commit` pins the trunk commit the
owner confirmed: a different refs/heads/<trunk> refuses before any effect.
`attestGenesis` runs under its own `genesis` lock: two genesis attests do not
overlap (a second one while a live process holds it is `busy` at once, §7.11), and node attests (which measure missing genesis items first) are never
blocked by it — both record as in §7.10, so concurrent observations of one item
are each a fact about its key. It is abortable like attest (§7.8). It registers
itself synchronously when called (before its first await) until it ends; while
registered, `status` in that process marks the genesis progress `measuring` (§10.1).
`StatusView.genesis = {observed, total, pending, measuring?}` is present only
while genesis items lack observations.

### 8.3 Parent operations (0.20, PO1–PO7)

- **PO1 covered amend:** paths covered by current `allow.writes` are reported
  with their allow rule and plan number, and are not added to the node's writes.
  If every path is covered, amend exits successfully with no file/ledger change;
  use `owed decide <node> --writer` to deliver a limit. Uncovered additions retain
  normal authority rules.
  Writer packets say `edit these freely; do not ask the parent; owed grants
  them when your candidate is measured`, still only for task-needed edits.
- **PO2 batch resume:** `owed resume A,B,C`, or `owed_resume` with `node` a
  string/comma list/non-empty string array, trims and deduplicates ids. The same
  note, after, expect and remeasure options apply to all. One lock validates
  all nodes/options before appending one normal resume per node, each with
  `batch` equal to the first seq. Any refusal records nothing. One unique node
  retains the old shape. Replay validates contiguous resumes, first-seq
  reference, same actor/channel/after/expect/note and distinct nodes (the
  batch operation supplies identical remeasure options; replay's batch check
  does not separately compare remeasure/release). Empty lists fail
  with `resume needs a non-empty node list`. Text prints each resume receipt;
  batch JSON/tool details are `{entry: <first>, entries: [<all>], merged?: true}`;
  single-node details remain the entry.
- **PO3 metrics:** CLI `report --metrics` adds
  `parentActs.byNode`, `perMergedNodeAttributed`, `pending` and `unattributed`.
  Each act contributes 1/k to each distinct explicit node target; batches count
  once. Plan acts target added/removed/changed node specs. General `*`, genesis,
  trunk-only and other targetless acts are unattributed. `pending` sums targets
  not merged in the window; the attributed ratio sums acts on nodes merged in
  the window / merges (`null` without merges). Existing fields retain their
  meaning, with batches counted once. Since-exclusive/until-inclusive bounds
  remain; intersecting batches count once among members visible at `until`.
  Text adds `Attributed parent acts per merged node: <n>; pending <n>;
  unattributed <n>` and `Parent acts by node: <id> <n>, ...` (`n/a` ratio,
  `none` empty map).
- **PO4 overlap:** plan replies and edit dry-runs warn `writes of <a> overlap
  <b> (on the critical path): consider deps <a> after <b>`. A is new or
  dispatch-ready, B unfinished on any equally longest unfinished dependency
  chain, writes overlap and neither depends transitively on the other. Each
  unordered pair appears once; merged nodes are skipped. Advisory only, in
  existing plan `warnings` or new `EditPreview.warnings: string[]`.
- **PO5 exit codes:** in 0.28 a node attest exiting 4 starts its text with
  `measured; not accepted yet: <primary need text or recorded activity>`, including
  `--rerun` and `--remeasure`. Genesis and trunk attests retain their dedicated
  recorded/failed/missing receipts. Codes and JSON remain unchanged.
  Attest (node/genesis/trunk) exits 1 if **any observation
  recorded by this action** has verdict fail, including known_red, attribution
  and probe failures. Never infer this from diagnostics or cached observations.
  Otherwise 0 = nothing outstanding, 4 = obligations remain (including review
  or measurement errors). Usage 2, internal error 3, refused 1 and busy 75 keep
  their meanings. Quarantine verdicts are already adjusted; repeat uses the
  newly recorded observation's verdict, not the pooled item verdict. Thus a
  newly passing observation can exit 0/4 while its pool fails, or fail/exit 1
  while its pool passes. Trunk remeasure includes its newly remeasured obs.
  Driver treats 0/4 as done, 1 as measured failure/done, 75 as busy; 3/other
  errors halt, never silently re-attest.
- **PO6 derived ack:** without explicit `ack_rulings`, the current driver
  reviewer's recorded launch packet may supply the existing ack field. It must
  identify the current candidate commit/submit and same reviewer identity.
  In its `Rulings in scope` section, every applicable pre-launch ruling up to
  the derived seq must match byte-exact in seq order: the largest complete
  prefix, never the max of isolated matches. Missing the earliest yields ack
  0; launch metadata alone is insufficient. Later rulings are never implicitly
  acknowledged. Explicit ack takes precedence. Before recording a review,
  0.26 requires the watermark to reach the latest applicable ruling, whether
  supplied or derived; inadequate/missing packet acknowledgment refuses
  atomically (§9.2). Historical under-acknowledged reviews still replay.
- **PO7 brief:** edit `set: ["brief=<text>"]` preserves unquoted multiline,
  colon-bearing and equals-containing text literally. Quoted/YAML block strings
  also work. Empty/whitespace-only values still refuse without file/ledger change.

### 8.3.1 One parent decision (0.23, DC / DF)

`owed decide A[,B...] --text TEXT [--writes +PATH ...] [--allow-only p1,p2] [--defer INV]
[--resume | --no-resume] [--after NODE] [--remeasure] [--writer]` combines
writes amendment, invariant deferral, one ruling, answer delivery and recovery.
It requires parent/owner authority, never the driver or a subagent, and a
nonempty list of unfinished named nodes (`*` is not supported).

Every part is validated before one ledger append under one lock. Git
preparation and question discovery occur before the lock; ledger state is
rechecked before append. Order is plan, amendment carry submits, defers, one
ruling, resumes, omitting unused parts. Any validation refusal records nothing
and leaves the plan file unchanged. External delivery happens after the lock.
If replacing an amended plan file fails after append, the decision remains
recorded and the error identifies the saved plan and recovery action.

- `--writes` accepts bare paths or `+path`, using amend's recorded plan source,
  comment/layout preservation, scope-containment test, allowance coverage and
  owner downgrade rules (§3). Record pending plan-file edits first. Drop
  covered paths per node, then require equal additions for all named nodes;
  a mismatch refuses naming each node's covered and added paths. If all paths
  are covered, record the decision's ruling and requested defer/resume but no
  plan entry or file replacement, reporting `writes unchanged`. Allow-covered
  paths do not refuse the decision: its ruling ends with
  ` (writes already granted by allow rule, plan #<seq>: <paths>)`, listing those
  paths; uncovered paths alone are added. This amendment's
  ruling is the decision ruling, not an extra. `-path` still requires a plan update.
- `--allow-only p1,p2` (tool `allow_only: string[]`) replaces each named node's
  cap; `--allow-only ''` or tool `[]` sets an empty cap. It can combine with
  writes/defer/resume in the same atomic append and plan-file replacement.
  Cap widening requires the owner (§3.4.1). The ruling appends
  ` (allow rule grants capped to: <paths>)` (`[]` for empty). A cap-only decision
  is valid and reports the cap; unrelated plan edits remain forbidden.
  Multi-node decisions require every named node to actually change, or all to
  remain unchanged; mixed cap no-ops refuse before any file/ledger
  write, naming the already-equal and changed nodes and suggesting separate
  decisions. A node with writes additions is changed even if its cap is equal.
- `--defer` requires owner authority and binds the named invariant to each
  candidate's current merge key, using TEXT as its reason. It precedes any
  `--writer` invalidation. It waives no check and changes no acceptance gate.
- Resume defaults on only for halted or held nodes. Explicit `--resume`,
  `--after` or `--remeasure` requests resume; `--no-resume` preserves the halt
  despite the ruling and cannot combine with after/remeasure. A halt kept by
  that decision is `held by ruling #<seq>`: it remains stopped but does not ask
  the parent to resume it. `owed resume <node>` releases it when desired. Hold release
  keeps resume's restrictions. `--writer` requires a new submit (the same
  commit is allowed), never acknowledges a ruling or clears a review block.
- Each node may have at most one open question across its current writer and
  reviewer runs. That question is answered at its current revision. More than
  one refuses; use `owed answer <node> --rid R --qid Q "<text>"` to select it.
  Needs-you uses decide only when that total is exactly one, otherwise it lists
  addressed answer commands. Answer targets receive the answer only; other
  running roles receive the ruling. Delivery failure preserves the decision;
  retry the exact supplied `owed answer ... --rev N` command to reuse its rule
  and request. Multiline retry arguments use Bash ANSI-C quoting (`$'…'`) to
  keep the printed command on one line while preserving the delivered bytes.
  There is no automatic retry or implicit acknowledgment.

Default output is one line, `decision #S for A,B: ruling #R`, with clauses only
for requested/performed writes (including covered-path explanations and
`writes unchanged`), deferral, answers and resume, followed by one actual
post-delivery state line per successfully delivered answer (§12.5.1), plus at
most one delivery failure line. Results expose `covered` per node and omit `plan` for a covered
no-op; standalone amendment results also omit `rule` in that case.
Legacy `rule`, `answer`, `amend`, `defer` and `resume` remain
supported. Use resume alone for a retry with no new ruling; rule still supplies
`*`/prospective policy, and edit supplies other plan changes or report requests.

Optional `decision` on existing plan/submit/defer/rule/resume entries points to
the first entry. Replay validates contiguous ordering, one ruling, node scope,
and one principal/channel, except executor amendment carries. One answer uses
the existing `answer` field and prefixed ruling text; multiple answers use
`answers: [{node, rid, qid, rev}]`, sorted by node/question, with unchanged TEXT.
The list requires a decision ruling, at least two answers and no `answer` or
`supersedes`; duplicate/backwards revisions refuse. Historical `answer.rev`
retains its positive-integer replay validation; the new list uses safe integers.

Normal unlocked state loads (status, why, report, brief, driver and pi status)
hide a final decision prefix lacking its ruling and return the preceding state.
Neither replay memo nor snapshot publishes that prefix. Once the ruling is
present the group is complete for reading; trailing resumes are not required
for completeness. Locked loads across any handle on that ledger, verify and
post-append validation still refuse an incomplete tail. Only a contiguous
same-decision prefix without a ruling is hidden; malformed entries retain
normal validation. No automatic repair of interrupted writes is introduced.

### 8.3.2 Driver-safe hotfix adoption (0.24, AD)

The parent acting as owner can land a hotfix without stopping the driver:
`owed adopt --commit <c> --note "<why>"` / `owed_adopt {commit, note}`.
The commit may be off the trunk ref only when the ref equals ledger trunk
and c is its descendant. Existing no-commit/current-ref forms, owner authority
or parent adopt allowance, path checks before measurement/effect, acquisition
budget, shared lease, adopt-pending and `adoptGuard` (§6.6, §8.4) still apply.
A running merge finishes first, rather than being invalidated by a manual ref
move. Under the merge lock, a hotfix no longer fast-forwarding the new trunk
refuses before measurement, naming that trunk and telling the caller to rebase
c onto it and retry `owed adopt --commit <new> --note "<why>"`.

An off-ref c already contained in ledger trunk is not a
hotfix needing rebase. It refuses before measurement with
`nothing to adopt: <c12> is already contained in the ledger trunk <prior12>`.
A commit equal to ledger trunk retains the existing `nothing to adopt` refusal.
An off-ref commit cannot bypass a trunk ref moved outside owed.

Every invariant whose key changed and lacks a verdict is measured. A guard
refusal records observations but leaves the hotfix unlanded: fix it and retry,
not trunk's ref. An external ref move during measurement discards stale
observations and is never overwritten. Aborts retain only completed
observations under the existing stability rules (§7.8).

After the guard passes, under the inner ledger lock, owed uses merge's
`advanceTrunk` helper for the compare-and-swap advance from ledger trunk to c,
**before** appending observations and the adopt entry together. A checked-out
trunk stays attached and fast-forwards in its worktree; tracked dirt or
obstructing untracked files refuses without discarding user files. Failed ref
advancement appends nothing. The captured CAS ref is private runtime state,
not a preview/result or ledger field.

Limit: ref advancement and ledger append are not one filesystem transaction,
as for merge. A crash or append failure between them leaves the ref ahead of
the ledger. Recover with `owed adopt --note "<why>"` **without `--commit`**
to adopt the now-current ref under the existing guard. No ledger schema, state
key or replay change is added; all existing adopt/lease/lock limits remain.

### 8.3.3 Identical acts and safe retries (0.24, ID)

`review`, candidate `evidence`, `approve` (including a block) and `waive`
append nothing when the same principal repeats its latest identical act of
that kind on the same node, open candidate and obligation. CLI and pi tools
succeed with `already recorded as #<seq>` (CLI exit 0); responses carry runtime
`alreadyRecorded: <seq>` beside the existing entry, never persisted.

Equality includes the key and, as applicable, verdict, rank, acknowledged
applicable rulings as a set, needs-parent, note, evidence file paths/digests,
accepted risks as a set, waiver reason and `tracked_by` when present.
`ignorable` is not act content; adding/changing a tracker is a new act.
An otherwise identical tracked waiver can re-record risks already accepted
by that owner on the current candidate without accepting new risks.
File order and acknowledgment
watermark do not distinguish equal sets; channel and model attribution do not
change a judgment. A changed latest act appends normally: A, B, A records all
three. Other principals/obligations have separate streams. A new submit starts
a new retry scope even for the same commit; post-merge evidence receipts retain
their existing behavior.

Candidate pins (§8 act binding), writer restrictions, role checks, file reads
and confirmation still apply. An identical successful waiver may repeat the
risks it already consumed as a no-op, accepting no additional risk; a changed
waiver must cite valid current risks.

`owed why` review and ruling-ack lines and `owed report` text collapse identical
historical runs within each principal/node/candidate/obligation stream to one
item with `×<k>`; another principal does not interrupt a run, a changed act does.
Report windows count only included acts. The satisfied why view still selects
the latest qualifying review per principal, whose multiplier describes that
historical run. Text folding removes no entries: JSON evidence/report rows,
review counts, acceptance and replay of old duplicate ledgers are unchanged.

Scripts must identify a busy ledger by exit **75** with stderr starting
`Busy:`, never by parsing stdout or notes for that word (§10). Retrying an
uncertain successful act is safe only while the candidate and that principal's
latest act remain unchanged. Driver actions and recovery retries are distinct
from these idempotent judgments (§12.5).

### 8.3.4 Merge success text (0.25, QT)

CLI single and batch merges, and the pi single-merge tool, print
`<node> merged (<commit12>); measured <n>, waived <n>, debt <n>`.
Measured counts evidenced `check`, `red`, `strength`, `writes` and invariant
obligations; reviews and manual evidence are not measured tests. Waived counts
W items. Debt counts only deferred obligations on this merge's keys, never
historical defers on older keys. A single merge retains its deferred-debt and
unguarded-paths lines and lease annotation. A batch prints one merged line per
member with that member's commit, any conflict dropouts, then
`Batch of <n>: <nodes>` and its lease annotation.

No entry sequence or full trunk hash is echoed in this success summary.
The post-commit receipt read is best-effort: failure shortens the line to
`<node> merged (<commit12>)` without turning a completed merge into a refusal.
A caller that supplies no current-key debt count omits the debt field rather
than estimating from the ledger's historical defers. This changes text/results,
not the merge guard or ledger entries.

### 8.4 Adopt waiting and operation activity (0.22, AW)

`owed adopt --wait SECONDS` / `owed_adopt {wait: seconds}` sets one total
acquisition budget, default 60 seconds. Finite nonnegative fractional seconds
are allowed within the supported timestamp range; zero attempts without waiting.
Busy retains exit 75. The deadline spans nested Ledger instances, machine lease,
merge and final ledger acquisition. Measurements keep their own execution
timeouts, while their elapsed time consumes remaining acquisition budget. A
free lock may still be acquired with zero remaining wait. Lock order remains
machine lease -> merge -> short ledger locks; no adopt-queue lock is added.

Before waiting, each adopter publishes `adopt-pending/<host>-<pid>.json` in the
owed directory with `{pid, host, commit, since, until}`. Expiry is start plus
budget plus 60 seconds. Missing/malformed/expired deadlines are stale on every
host; before expiry, local PIDs must be live, while foreign PIDs are not probed.
Legacy singleton markers are ignored. The driver finishes its running merge
but starts no new one while a marker is live, naming the oldest pending adopt.
Completion/refusal/timeout/cancellation removes that request's marker. Same-PID
calls share a file with request ownership and publish the oldest live request;
cleanup cannot delete another request or recreate a completed group. Crashes
rely on liveness/expiry, with PID-reuse limits bounded by expiry.

Lock owners may expose `activity` and ISO UTC `activitySince`; Busy appends the
operation and its start time (local, SB5). Nested trunk refresh updates the operation holder;
parallel measurements show the most recently started job while acquisition
`ts` remains unchanged. Activity/marker updates use atomic rename and introduce
no ledger fields, keys or gate changes. Upgrade the active driver to obtain
adopt priority; old readers ignore these runtime fields.

## 9. Views

### Current presentation (0.20, NY1–NY7 / MS5 / DR2–DR3)

The detailed receipt descriptions below apply to `owed why --full`, JSON and
operation receipt cards. The default why command uses §9.6's outstanding-only
card; it does not embed those detailed receipts in writer repairs (§12.5.3).

- **NY1:** a recorded repair follow-up or newer submit after a review block
  shows `repairing (block #<seq>)`. Its review item leaves Needs you **only**
  when `ownerNeeded(s,node)` is undefined. Non-driver-authored rank-2 blocks,
  rank-3 blocks, flaky/⊤ conflicts and other owner-needed cases remain there,
  even when progress says repairing. Driver halt remains actionable; blocks
  continue binding acceptance. Status and driver owner notices must agree.
  Guidance first: `owed rule --nodes <node> "<guidance>"`; owner review override
  second, labelled `(overrides a valid block: state the accepted risk)`.
- **NY2–NY3:** dependency/resume waits on `approve: owner` show `waiting for
  <deps> (owner approval after)` and omit approval from Needs you until
  actionable. Only a ⊤ review item says `review needs an owner decision`;
  a blocked candidate otherwise says `review blocked: guidance needed`.
- **NY5:** CLI/tool plan replies lead with `Recorded plan #<seq> (v<version>
  : +<n> nodes [<ids>], -<m>, ~<k> changed; downgrades: <node>: <what>; ...)`,
  before carries/warnings/board; absent downgrades say `none`. Counts compare
  exact prior/next recorded plan blobs; v is schema version (currently 1).
- **NY6:** `why` hides standalone `owner flag weak confirmation: ...` history
  by default; `why --full` / `owed_why {full:true}` restores it. `ownerFlags`
  JSON and evidence provenance stay visible.
- **NY7:** open worktrees are checked with `git merge-base --is-ancestor`.
  Status/brief/why show `rebase pending (HEAD <h12> not on slot base <b12>)`.
  JSON `rebasePending` is a node map in status and single record in receipts,
  each `{head, base, upstream, command}` with full hashes. Missing/unreadable
  worktrees give no HEAD evidence; driver behavior is §12.5.2.
- **DR2:** current driver busy receipts show `merge waiting for <reason> since
  <HH:MM>` for accepted nodes, `measure waiting for <reason> since <HH:MM>` for
  open not-yet-accepted candidates, also in plain status. **SB5 (0.22.1):** every
  `HH:MM` shown in text (merge/measure waiting, adopt pending, busy activity,
  driver idle) is local time from one formatter, prefixed with the local date
  `YYYY-MM-DD` when not today; ledger, cache and JSON fields stay ISO UTC. Accepted
  progress age is since continuous acceptance, not dispatch.
  **DQ2 (0.20.1):** ordinary/full status identify a driver-internal blocker as
  `merge waiting for driver-internal job (catalog merge, since 09:12);
  2 merges ahead`, preferring a running merge over other measurements.
  `drive/waiting.json` maps nodes to `{reason,since,attempt,candidate?,job?}`;
  status JSON exposes `mergeWaiting[id]` with optional `job: string` (e.g.
  `catalog merge` or `trunk attest`) and `ahead: number`, the current zero-based
  position in the 0.20 merge queue. Accepted predecessors count even while
  merging; status recomputes ahead, ignoring cached values. Nodes outside the
  queue omit ahead and queue-count text. Lease waits keep their existing
  reason/since text, adding ahead only for queued nodes. `since` is the continuous
  candidate/attempt wait start; the internal-job time is that job's start.
  Old caches without job remain readable until refreshed; brief keeps its scope.
  In 0.23 `jobSince` preserves the job's ISO start separately, and active work
  hides stale waits (§9.3). Atomic driver-owned writes survive restart,
  but are ignored when candidate/attempt stale or missing/corrupt. Completion,
  replacement, merge or closure clears them; they are cache, not evidence.
- **DR3:** why adds `models` (`writer <model> · reviewer <model>`) and optional
  `modelWarnings`; absent roles say `writer model unknown` / `reviewer model
  unknown`. Warnings `reviewer used the writer's model` and `model used <x>
  differs from the one selected <y>` are advisory (§12.5.2).
- **CT1:** template receipts add optional `items[].run` / `mergeChecks[].run`
  for recognized expansions; text prints exact command after `  run: `.
  This includes node/trunk/invariant why and attest; no ledger field is added.
- **MS5:** status/brief Debt lists `quarantine <inv>/<test> until <fix> merges`
  or `quarantine <node>/<check>/<test> until <fix> merges`. Report has
  `Debt (quarantine)` and JSON `quarantine: string[]`; status/brief use
  `summary.debt`. `why <fix>` says `merging <fix> lifts quarantine: <inv>/<test>,
  ...` (receipt `lifts`).

- **Receipt card** (`why`): per obligation: ✔ measured (executor pass, with log
  sha, counts, duration), ✔ reviewed (reviewers), ⚠ waived (owner, reason, channel),
  ✘ rejected, ⊥ awaiting observation, ⊤ conflict, ⏸ deferred, ⛔ blocked (active blocks and how to clear them).
  In 0.16.1 (RR3), a satisfied `review`/`closure-review` receipt item shows each
  principal once, using its latest qualifying review. Its JSON `evidence` and
  `observations` use the same deduplicated list. This is view-only: stored/replayed
  evidence, obligation keys and distinct-principal satisfaction are unchanged.
  Under its item line, every `fail` observation with a note shows it: a line
  `  note #<seq>:` then each line of the note as recorded, indented four
  spaces (so the last output lines of a failed command, §7.2, reach `owed
  why --full`/`owed_why {full:true}`; new failures also reach the writer's
  repair follow-up (§12.5.3)).
  A `rulings` item satisfied while no ruling is in scope for the node reads
  "no rulings apply" (not "acknowledged"/"satisfied"); its status is unchanged.
  When the plan has `exec` (§3.2), the line after the node header is
  `Exec: wrap <argv> · env <NAMES>` (present parts only; argv words with blanks
  or quotes JSON-quoted; env names sorted, values never shown); `--json` has
  `exec` with that line.
- **Clearing hints** (receipt card, report blocks, brief *Rejected or blocked*)
  never print an executable command carrying `--as` of another principal than
  the owner. A judgment block of rank r by reviewer A is described in words:
  an ok review on the current candidate by the original reviewer A with rank ≥ r,
  or by any reviewer with rank > r, clears it; the owner alternative is the
  printed `owed waive … --accept-risk` command (owner commands are gated by the
  owner channel). A node without an open writer slot (abandoned, or never
  dispatched) cannot clear anything on an old candidate, so its hints (blocks
  and owner decisions) say `owed dispatch <node>` and never suggest submit or
  attest; with an open slot but no candidate, judgment and flaky hints first
  require the writer's submit. A flaky block's hint (and the owner-needed notify,
  the owner commands of halts, status's pending item and the brief's decision)
  also offers, after the waiver (0.8, L3.2): `or owed rule "<what the writer
  must change>" --nodes <node> when the check or test itself must change (the
  writer fixes it; the block stays flaky until a plan change of the check's
  definition supersedes it, or the owner waives it once the fixed candidate
  passes)`: flaky stays terminal except for supersede (§6.3) and the owner's
  waiver. An execution block reads `writer fixes and runs
  owed submit <node>, then owed attest <node> (skip this when owed drive is
  running: the driver attests) (the attribution rerun on the original content
  clears the block)` (0.7, K1.3: a writer's attest beside a running driver only
  finds the node's attest lock busy). Writer repairs instead tell the writer
  to submit and let the driver rerun checks (§12.5.3).
- **Superseded blocks** (0.8, L2.3; §6.3) stay visible but never as active
  blocks. `why` lists each superseded block of the node as `⊘ #<seq> superseded
  by plan #<p> (check <id> definition changed)`, or `(check <id> removed)` when
  the new plan has no such check; `--json` has `superseded` (the block with
  `state: "superseded"`, `supersededBy` and `text`). `status` lists those of
  nodes not merged under `Superseded blocks (not active; the plan changed their
  check):` as `⊘ <node>: <text>`. `report` lists the blocks superseded by plan
  entries after `since` in their own section `Superseded blocks (not active; the
  plan changed their check)`, after `Active blocks` (which keeps flaky ones), as
  `<node>/<obligation> <text>`; the section is omitted when empty. Waiver hints,
  owner commands and the brief ignore superseded blocks.
- **Dispatch packet** (0.7, K1.3): the packet `owed dispatch` stores and returns
  ends with `After committing, run: owed submit <node>`. When the driver
  dispatches (`parent:drive`) it ends with one more line, `the driver measures
  your candidate; do not run owed attest`. The driver's writer task (its launch
  `task`) is that packet rebuilt from dispatch-time facts and always carries the
  line, so a driver launch of a manually dispatched node adds the line to the
  launch task (the stored packet stays without it).
  Also "Untested": obligations absent relative to the plan baseline (downgrades) and
  the node's changed files not matched by any passing check's `reads`.
- **Allowances in views** (§3.4, D21): a downgrade a parent recorded under an
  allowance is labelled `by parent:<id> under allowance (plan #S)` — in the
  report's ΔO⁻ list (instead of the bare principal), in the brief's
  *Downgrades under allowance* section (same line format), in the receipt card (one
  `ΔO⁻ #seq by parent:<id> under allowance (plan #S): <node>: <what>` line after
  the JSON line; `--json` downgrades carry `allowance: S`) and in the CLI/pi
  output of `plan`. A parent adoption reads `#seq adopted by parent:<id> under
  allowance (plan #S) prior..commit …` in report and brief, in their own section
  apart from the owner decisions (`--json` `adoptions[].allowance`), and in the
  `adopt` output.
- **Out-of-writes paths** (receipt card, D21.5, for every plan): when the
  candidate's `writes` item is ✘ or ⛔ and changed paths lie outside the node's
  writes, the line `Out-of-writes paths: <p1>, <p2>, …` lists them (the first 20,
  then `… +N more`; `--json` `outOfWrites: {paths, allowance?, hint?, grantRefused?}` lists all).
  Covered paths say `; pre-authorized by allowance plan #S`; `, but grant refused`
  appears only when a failure observation for this key records a GR2 closure/overlap
  refusal (`grantRefused: true` in JSON), never for a legacy failure or one recorded
  before the allowance existed. For newly covered paths whose key already failed,
  the display says `hint: paths are now pre-authorized; submit a new commit (any
  change, e.g. an amended commit message) so the writes item is measured again
  under the new allow rule`. Attribution followed by `attest --rerun` on the same
  failed key creates conflicting pass/fail observations (⊤), not acceptance.
  Uncovered paths add `hint: an allow rule {nodes:
  ["<id>"], writes: ["<dirs>"]} would let owed grant these` to the receipt/why,
  merge refusal (also when trunk-red takes precedence) and driver repair/halt text;
  dirs are deduplicated parent directories
  with trailing `/` (top-level files stay literal). Hints are generated only for
  display, never stored in writes observations or their log blobs; failure notes
  contain only the original outside-writes note plus the first GR2 reason.
  A ruling never accepts out-of-writes paths.
- **Granted writes (0.17)**: the receipt shows `Granted writes: <p1>, … (#seq,
  allowance plan #S)` per grant, first 20 then `… +N more`; JSON `grantedWrites`
  contains the attempt's complete grant entries. Report, brief's `Downgrades under
  allowance`, receipt ΔO⁻ and JSON retain grant provenance (`by`, `allowance`).
- **Receipt card after a rebase**: `Rebased #seq: slot base <from> → <base>`,
  the previously reviewed patch (old base..old commit, submit seq) and
  `Re-review only the resolution: git range-diff <old base>..<old commit>
  <new base>..<new commit>` (`<new commit>` until the writer submits again);
  `--json` has `rebase: {seq, from, base, previous?, rangeDiff?}`.
- **Status**: trunk, nodes by state, ready list (sorted by number of transitive
  dependents; a ready node whose writes overlap an open slot is marked
  `(writes overlap open slot of X)`, `--json` `overlaps: {node: [ids]}`); a node
  removed from the plan still owns its dispatch-plan writes while its slot remains
  open, so dispatch and grants continue to respect that overlap. Pending queue grouped by discharger (owner / parent+writer /
  reviewer / executor), invariant debt on trunk. When refs/heads/<trunk> differs
  from the ledger trunk, a line after the trunk says so: `trunk moved outside
  owed: … ahead of the ledger trunk … by N commits; … owed adopt` (a fast-forward),
  or `trunk diverged from the ledger (rewritten or reset outside owed)` with the
  ahead/behind counts, or that the ref does not exist, or that the ledger trunk
  commit is missing from the repository (`ledger trunk <sha> is missing from the
  repository`); `--json` has
  `drift: {ref, commit, ledger, relation: ahead|diverged|missing|ledger-missing, ahead, behind}`.
- **Report** (`report --since`): merges, new E/W/D, blocks, downgrades, rulings,
  owner decisions needed — written in plain language —, owner actions (owner
  entries after `since` except `adopt`, which is listed once, under the trunk
  adoptions), trunk adoptions after
  `since` (seq, who, prior..commit, commit count, changed paths, note; `--json`
  `adoptions`): owner adoptions under `Trunk adoptions (owner decisions: commits
  made outside owed)`, parent adoptions under `Trunk adoptions under allowance
  (parent adoptions: commits made outside owed)`, each section shown only when non-empty, and an **Escapes**
  section: escape counts by class with each escape, decoys caught / escaped /
  pending with each revealed decoy, unrevealed commitments and the escape rate
  (cumulative, §6.5; `--json` returns it as `escapes`).
- **Metrics (0.15, MT)**: `owed report --metrics [--since <seq|ISO>] [--until <seq|ISO>] [--json]`
  computes only from ledger entries and their recorded plan blobs, without
  querying Git facts or dsa. It changes no acceptance state or key and writes no
  ledger entry. Ordinary `report` and its JSON retain their existing fields;
  `--until` is valid only with `--metrics`. Bounds are sequence numbers or ISO
  timestamps, including date-only `YYYY-MM-DD` at UTC midnight (0.16, NT1):
  `since` is exclusive (default start), `until` inclusive (default latest);
  a reversed pair in the same units is a usage error. Each merge, driver
  halt and parent/owner answer ruling is counted if its own entry is in the
  window. Earlier history supplies timing, attempts and plan comparisons;
  entries after `until` cannot affect results.
  JSON returns `since`, `until` (`null` means latest), `mergedNodes`, `merged`,
  `interruptions`, `halts`, `haltReasons`, `submitToMergeMs`,
  `dispatchToMergeMs`, `firstPassAcceptance` and `repairs`:
  - `merged` lists `{node, attempt, seq, submitToMergeMs, dispatchToMergeMs,
    firstPass, repairs, repairsByAttempt}`. Submit time starts at the first
    submit of the merged attempt, including its earlier candidates; dispatch
    time starts at the node's first dispatch, including abandoned attempts.
    Both times are milliseconds. Each duration summary has `samples`, `median`
    (middle value, averaging the two middle values for an even sample), `p90`
    (nearest rank, `ceil(0.9 * samples)`) and `max`. Missing/invalid durations
    are `null` and excluded from samples.
  - `interruptions` has `total` = driver halts + answered questions, `halts`,
    `answers` and `perMergedNode`. Each `answers[]` reference counts separately
    in 0.23, as does a single `answer`. Answers count even when they also decide a
    halt. `firstPassAcceptance` has `nodes` and `rate`: a merged attempt 1 with
    no execution or judgment block on any candidate in that attempt. Diagnostic
    trunk probes and attribution observations do not create blocks. `repairs`
    has `total` and `perMergedNode`: sum `max(writer submits - 1, 0)` separately
    for every attempt of each node merged in the window, including abandoned
    attempts, excluding executor carry submits. `repairsByAttempt` lists
    `{attempt, submits, repairs}`. Rates with no merged nodes are `null`.
  - Each halt has `seq`, `node`, `attempt`, original `reason`, `normalizedReason`,
    `class` (`decision` or `no-decision`), `endedBy` and `decisionSeqs`. A halt
    ends at its node's next resume, submit, merge, abandon or halt, whoever
    recorded that ending halt; only `parent:drive` halts count as interruptions.
    From the halt through that ending entry, a parent/owner action makes it a
    decision: a rule naming the node or `*` (including an answer), waive, defer,
    abandon, hold, evidence, approval or other owner review, or a plan entry
    changing that node's spec/deps compared with the preceding plan. Unrelated
    node changes, reviewer acts and driver acts do not count. At a historical
    cutoff an open halt has `endedBy: null`; its class reflects only decisions
    recorded through that cutoff, so a later decision can change a later report.
    `haltReasons` gives the top five `{reason, count}` groups per class, ordered
    by descending count then reason. Normalization collapses whitespace and
    replaces node/run/question/key/commit ids with `<id>` and digits with `<n>`.
    In 0.16 (NT2), node ids matching `/^[a-z]+$/` are replaced only at the
    reason start before `:`, before `/`, after `node `, after `--after `, or
    as the argument of `owed <verb> `; command verbs and ordinary prose such
    as `merge refused` stay distinct. Other ids keep their prior normalization.
    Text is one block: window and merged count, parent acts
    and top classes (0.17), grants, partial interruptions and rate, halt counts,
    submit-to-merge median/p90/max, dispatch-to-merge median/p90, first-pass rate,
    repairs and rate, and the top-five halt reasons for each class. Unavailable
    values read `n/a`; JSON includes all per-merge and per-halt detail.
  - **Parent acts (0.17, PA)**: `parentActs.perMergedNode` is the gate metric
    for coordination cost in 0.17+, not the partial interruptions ratio. JSON
    adds `parentActs: {total, perMergedNode, byClass}` and
    `grants: {total, perMergedNode}`; every pre-existing metrics field is unchanged.
    Count each entry in the window whose principal role is owner or parent,
    except `parent:drive` and non-decision transport kinds `dispatch`, `launch`,
    `send`. Executor, writer and reviewer entries never count. Each act enters
    exactly one class, first match:
    1. `writes`: a plan whose detected downgrades are non-empty and all writes
       widenings, or an amend rule. Detection compares recorded plans (including
       check-definition changes), ignoring allowance coverage and claimed text.
       Amend uses the existing `ops.amend` ruling marker
       `writes of <node> widened by plan #<seq>: <paths>. Limit: <note>`;
       a hand-written rule matching that marker also qualifies. Its plan and rule
       are two acts, not one. This is text recognition, not a new ledger field.
    2. `answer`: a rule with `answer` or `answers`; a multi-answer rule remains
       one parent act even though every answer counts as an interruption.
    3. `trunk`: adopt; a plan changed only in invariants' `known_red`; or resume
       whose node's last recorded halt reason starts `merge refused: trunk-red`.
       The last halt is historical, not necessarily still active; a newer halt
       replaces it. A no-op plan does not qualify as a known_red-only change.
    4. `resume`, `rule`, `plan`, `review` (owner reviews), then
       `waive`/`defer`/`evidence`/`abandon`/`approve` by kind, else `other`.
       Genesis, notes and otherwise unclassified acts count as `other`.
       Owner approvals currently are review entries, so first-match `review`
       counts them and `approve` remains zero.
    `byClass` contains every class, including zeros. `grants.total` counts all
    entries of kind `grant` in the window, zero in ledgers without grants.
    Both `perMergedNode` values divide by merged nodes in the same window,
    or are `null` with none. Bounds apply to each act/grant independently;
    earlier history supplies previous-plan and last-halt context, and entries
    after `until` cannot affect classification. Text leads with
    `parent acts per merged node` and the top five nonzero classes (descending
    count, name for ties), shows grants, and relabels the old interruptions line
    `driver halts + answers per merged node (partial)`.
    PA is derived only: it adds no ledger kind/field and changes no gate or key.
  Compatibility: MT adds no ledger kinds or fields. Historical ledgers, including
  0.9-era entries without halts or answers, replay with unchanged states and keys.
- **Manual obligations (D23)**: `approve` reads `✔ approved (<owner>, <channel>)`
  (pending: `⊥ awaiting owner approval`); `evidence:<id>` reads `✔ evidenced
  (manual) by <who>` with each file as `path sha12` and the note (pending:
  `⊥ awaiting manual evidence`); their detail ends `satisfied (manual)`. They
  are never counted or labelled as measured: the brief's Merged line counts
  them as `N manual (<obligations>)` (`--json` `manualItems`, present only when
  non-empty). An approve block's hint is `owed approve <node>`; the brief's
  owner command for a pending approve is `owed approve <node>`, for owner
  evidence `owed evidence <node> <id> --file <path> --note … --as owner:cli`
  (`--as` only where the command's default principal is not the owner).
  Receipts (evidence on a merged node) are listed by `why`
  (`Receipt #seq <node>/<id> by <who> (merge #m): files …; note: …`, `--json`
  `receipts`) and `report` (`Receipts (manual, informational)` for receipts
  after `since`, `--json` `receipts`); both present only when non-empty.
- **Default status and brief (0.15, SQ).** `owed status` and pi `owed_status`
  start with `owed: <M> merged · <R> in progress · <A> need you · trunk <name>
  <short> <✔|✘> invariants (<ok>/<n>)`; short commits have 12 characters and
  E/W invariants count as satisfied. `Needs you (<A>):` has one line per current
  parent/owner item, `<node>: <plain reason> → <command>`: driver halts,
  unresolved needs-ruling blocks, trunk-red failures and owner decisions. Ready
  nodes without writes overlaps appear here only when no live/foreign driver
  owns the repository. An empty queue reads `Needs you: none`. In 0.28,
  `needs()` / `repoNeeds()` select these lines for status, brief, why, receipts,
  refusals and the extension. Each need keeps its own obligation and command;
  a missing command is explicit as `(no single command)`. Why shows each
  alternative as `or: …`. Repository needs never decide, rule or resume `trunk`.
  Git-derived merge checks and drift remain appended status diagnostics.
  Activity reports recorded progress and never predicts a driver action.
  Runtime comes from `assembleRuntime`. Answered-but-asking needs keep the
  reason separately from their retry command, so each node prefix and answer
  command appears once. Only a running candidate-tree attest
  for the same node, current candidate and obligation suppresses that owner
  need. Queued, other-tree and stale-candidate records remain visible as
  activity and suppress nothing. Asking-cache needs require a live or foreign
  driver. The Debt lines retain their existing meaning.
  An active review or closure-review judgment on an older key after a repair
  submit says `repair #<S> submitted; #<B> clears when <principal> records ok at
  rank >= <r> on the current key` only when no active judgment block for that
  obligation remains on the current candidate's key. A submit and a ruling do
  not clear the block. The owner route, when owed, is a pinned rank-3 OK with a
  note, the latest ruling acknowledgment and the closure-review obligation when
  applicable. An active review judgment block on the current key keeps the
  guidance need and offers no owner OK command or alternative.
  A stopped-writer halt leads the node's needs with its writer reply and decision
  command, with resume as an alternative, followed by its unruled review and
  parent/owner obligation needs. Status, why and parent wakes use that first
  need as the headline. Other halts first need any unruled block's ruling, then
  their parent/owner obligation needs; otherwise they need `owed resume <node>`
  and explain that the driver continues from the current state, then waits for
  any dependencies. In 0.29, a later named decision ruling with no halt-clearing
  entry makes the active halt held: its resume need (including the stopped-writer
  decide special case) disappears. Activity reads `held by ruling #<rule seq>;
  owed resume <node> releases it`. Compact/full status, brief and `/owed` show
  this under In progress; why and receipts name the ruling and show the release
  command in Next. Independent owner obligations, unruled review blocks, open
  writer questions and owner debt remain visible and actionable. The held halt
  itself no longer wakes the parent; queued wakes whose needs disappeared are
  dropped at delivery revalidation. A rule before the halt, a prospective rule
  or `*` policy does not hold it. A plain named rule after the halt still clears
  it as before, as do resume, new attempts and the other existing halt-clearing
  acts. Halt prose never supplies a resolving command.
  `In progress (<R>):` lists unmerged open slots, dependency waits and held
  nodes as `<node>: <phase> (<age>)`; phases are writing, measuring, reviewing,
  waiting for <deps>, held, accepted (merge pending), and the 0.20 repair/rebase/
  measure-wait/merge-wait phases above. Accepted age is since continuous
  acceptance; other ages are since dispatch, hold or current plan, clamped at
  zero. Ready/later nodes are not progress.
  `Debt:` appears when there are trunk-red invariants, active known-red
  entries (test, fix node and plan sequence), quarantine entries, current owner defers or waivers
  of open nodes. Status and brief share current merge diagnostics, including
  reused trunk-red failures. A defer is current only when the current merge
  guard still honours its invariant key and evidence; an open slot alone does
  not keep a stale defer in Debt. In 0.16 (NT3), when trunk drift or merge-build
  conflicts prevent rechecking an open candidate, its current-attempt recorded
  defers remain visible as `<node>/inv:<id>: owner defer (not rechecked: trunk
  moved)` or `(not rechecked: merge conflicts)`, respectively. Status and brief
  JSON add `deferred: [{seq, node, id, key, unverified?}]` when non-empty, with
  `unverified: 'drift' | 'conflict'` only for these unverified records. Retired
  nodes/invariants and defers from earlier attempts are not revived. A later
  successful merge-key query filters stale defers as before; this is display
  only, not acceptance evidence. Brief renders the same current defer `Debt:` lines.
  NT adds no ledger kinds or fields; 0.15/0.16 share the ledger with unchanged
  replay states and keys. Historical owner audit remains in full status.
  Empty sections are omitted. The last line is
  `Details: owed status --full · owed why <node>`.
  `status --full` (pi `full: true`) retains the evidence renderer and includes
  the same Needs-you lines as compact status, plus
  IR/KR lines and the 0.16 line `Merge queue: a, b, c` (`none` when empty).
  Status JSON adds `mergeQueue: string[]`, always present, listing accepted
  open attempts in the driver's merge order (§12.5); all other gates still apply.
  Historical flag/delegated confirmation, superseded and carried
  audit details belong there. Earlier detailed status descriptions refer to
  this full rendering. `--full --json` and `--json` have the same shape:
  all 0.14 fields remain; additive `summary` contains `{merged, needs:
  [{node, reason, command, alternatives?}], progress: [{node, phase, ageMs}], debt: string[]}`.
  Brief starts with that outcome line and Needs you section; its other sections
  retain their content. Brief JSON keeps `decisions` and all existing fields,
  adding `summary`, `trunk` and `invariants` for the prefix. Compatibility:
  these are presentation/result fields only, with no new ledger kind/field,
  no key changes and no new replay/version gate.
- **Compact act replies (0.16.2, CR).** `renderStatusBrief(v)` uses the same
  status outcome line and, when the queue is non-empty, the same
  `Needs you (<A>):` items and commands. It ends with
  `Details: owed status · owed why <node>` and omits the progress and debt
  lists (and the empty `Needs you: none` line). Pi `dispatch` retains its
  packet and subagents arguments, then appends this brief; `plan`, `edit`
  and `amend` retain their act/carry/not-carried/downgrade lines and append
  it. Plan warnings and ready hints retain their text before the brief. `defer`
  shows the recorded entry as `renderEntry`, then the brief, replacing the
  report. In 0.23, `rule` instead returns the concise delivery receipt and
  warning lines in §9.3, without an entry rendering or brief. `abandon` and
  `resume` show the recorded entry, resume's waits-for tail when present, and
  the first line of the node receipt (its phase), then
  the brief, replacing the full receipt. Edit dry-run output is unchanged.
  Structured tool results, explicit status/why/report, `/owed` and CLI
  `status` remain unchanged. CLI `dispatch`, `plan`, `edit`, `amend`, `rule`,
  `defer`, `abandon` and `resume` currently append no full status, so no CLI
  status suffix needs replacing for these acts; CLI `init` and pi `adopt`
  retain their existing status suffixes. This changes presentation only:
  no ledger kinds/fields, states, keys or acceptance gates change.
- **Brief** (`brief [--since seq|ISO]`, `briefView`/`renderBrief`): a morning
  summary, one line per item, sections in this order:
  0. *Owner acts (delegated) since <since>* (D25.5) — every owner entry with
     channel `delegated` after `since`, in ledger order:
     `#seq <by> <kind>[ <node>]: <what> — <note or reason>` (what: the downgrade
     items, the waived obligation, the deferred invariants, the adopted
     prior..commit, the ruling's nodes, …); `--json` `delegated`
     `[{seq, ts, by, kind, node?, what, note}]`; omitted when there is none.
     `report` and every entry line mark these entries `(delegated)`.
  1. *Needs you* (SQ3 replaces the old *Needs your decision* text heading) —
     current parent/owner actions as specified above. The JSON `decisions`
     field retains the owner queue (node and trunk items with status D
     and discharger `owner`), sorted by the number of transitive downstream
     nodes of the item's node (trunk items count 0), then node id and
     obligation; each line carries the exact command that discharges the item:
     `owed review <node> [--obligation closure-review] --ok --rank 3 --as owner:cli`
     for `review`/`closure-review` items whose only blocks (if any) are active
     judgment blocks, otherwise `owed waive <node> <obligation> --reason … [--accept-risk
     <every active block seq on that obligation>]`; trunk invariants cannot be
     waived, so their line points to `owed plan` (add a repairing node).
  2. *Merged* — per merge entry after `since`: counts of measured (status E,
     execution obligations: `check:*`, `red:*`, `writes`) and waived (status W)
     obligations, reviewed obligations, deferred invariants, untested changes
     (as in the receipt card) and the reviewers. A waived item is counted only
     as waived, never as measured.
  2a. *Adopted outside owed (owner decisions)* — per owner `adopt` entry after
     `since`: seq, owner, prior..commit, commit count, changed paths and note
     (`--json` `adoptions`); omitted when there is none. Parent adoptions follow
     under *Adopted outside owed (parent adoptions under allowance)*, labelled
     `adopted by parent:<id> under allowance (plan #S)`; omitted when there is none.
  2b. *Downgrades under allowance* — the downgrades a parent recorded under an
     allowance (§3.4) in plan entries after `since`, one line per item labelled as
     in the report: `#seq by parent:<id> under allowance (plan #S) <node>: <what>`
     (`--json` `allowanceDowngrades`, the ΔO⁻ records); omitted when there is none.
  3. *Rejected or blocked* — every non-cleared block of an unmerged node: node,
     obligation, the failing observation seq (execution blocks; the block seq
     is the failing obs) or the blocking review (judgment blocks), and how to
     clear it (clearing hints above).
  4. *In progress* — dispatched and submitted nodes with the age since dispatch
     (and since the last submit).
  5. *Total* — merged / accepted-unmerged / blocked (unmerged nodes with a
     non-cleared block) / ready counts, plus nodes waiting on dependencies.
  `since` (seq or ISO time, invalid → usage error) filters only the Merged
  and Adopted sections; the other sections always show the current state. `--json` returns
  the structured `Brief`.

### 9.1 Trunk checked out in another worktree (D19.5)

`owed status` (and `/owed`, `owed_status`) shows one line after the trunk line
when the trunk branch is checked out in a worktree other than the main worktree:
`Trunk <name> is checked out at <path>; merges fast-forward it there (keep it
clean).`; `--json` has `trunkWorktree: <path>`. Nothing is shown when the trunk
is checked out in the main worktree or nowhere.

### 9.2 Review guidance and conflict diagnostics (0.22, UX; 0.26, AK/WA)

Default why and status omit clean empty conflict lists; full why/status and
JSON retain `none` or empty arrays respectively. Paths and `unknown; retry
owed status` remain visible. Probes are context, never acceptance evidence.

Active review blocks suggest a writer-action decision
(`owed decide <node> --writer --text "<guidance>"`), repair and resubmission.
Rank-3 owner review appears only as an explicitly labelled override; reviewer
clearance and accepted-risk rules remain unchanged.

Ruling delivery details retain affected open slots, known writer call ids and
full follow-up strings. Default 0.23 rule receipts are concise and point to
`why` for manual forwarding (§9.3). Delivery does not acknowledge a ruling.

`status` (including full) and `why <node>` show `conflicts with trunk: <files>`
and `conflicts with <node>: <files>` for other open candidates. `none` means a
clean probe; `unknown; retry owed status` means a failed probe. Rebase-required
merge refusals name conflict files. Probes use
`git merge-tree --write-tree --name-only` with NUL-separated paths and cache
immutable commit-pair results under the common Git directory's `owed/cache`.
Invalid caches are recomputed. Probes neither measure checks nor grant acceptance.

Review acknowledgment validates under the append lock before recording. A
watermark below the latest applicable ruling, or omission without a sufficient
complete driver packet (§8.3 PO6), refuses with exit 2 and nothing appended:
`ack-rulings must be at least <N> (the latest ruling for <node>); rerun with
--ack-rulings <N> or --ack-rulings latest`. The CLI alias `--ack-rulings latest`
and tool `ack_rulings: "latest"` record the computed number, never a string.
Read those rulings before acknowledging them; the alias is not a waiver or
implicit review. The watermark is one number, not a comma list. Historical
reviews retain their old replay rules, including old missing-ack debt.
Delivery `slots` and view `conflicts` are runtime data, not ledger evidence.
No plan key or entry kind is added; input compatibility is in Compatibility.

An unresolved needs-parent review appears in wakes, status and default why as
`Needs you: <node> — review asks: <ask> → owed decide <node> --text "<ruling>"
--writer`. The ask is the text after the first case-insensitive `needs parent`,
`Parent decision needed:` or `BLOCK (needs parent):` marker; without one it
uses the last sentence. Whitespace is flattened, escaped onto one line and
bounded to 300 characters. Full receipts retain the review note and block
facts. A parent decision guides repair but never clears the review block by itself.

Trunk invariant conflict/red owner guidance names at most three failing tests
plus `+N`, and uses the recorded plan source to add a repair node (`owed plan
<recorded path>, or owed edit --node-new`); with no source it offers only the
editor, never a made-up path. Recorded node defers stay visible. Existing
trunk-park and invariant-red notices keep their full red text, waiting-node
membership and remedy choices; queued membership is revalidated at delivery.
The pre-initialization usage hint `owed init <plan.yaml>` remains valid.

### 9.3 Current work, local clocks and ruling receipts (0.23, LO)

Status and operational text format framework timestamps when displayed in the
reader's local time zone: `HH:MM` today, with the local date on other days.
Ledger and JSON timestamps stay ISO UTC. This includes driver status, lock
owners, adopt waits, environment retry times, idle progress and ordinary
report/metrics/brief window headings. Counterfactual's heading retains the
supplied bound's representation.
Driver job waits retain separate `job` and ISO `jobSince`, rendered as
`driver-internal job (<job>, since HH:MM)`; old records without `jobSince`
retain their recorded reason.

A node's own attest/merge clears its cached wait when it starts. Status, its
progress summary and why show `measuring (since HH:MM)` or
`merging (since HH:MM)` while the local driver reports it in flight, hiding the
wait. A job wait appears only while that exact job/start remains in flight in
a locally running driver. Consecutive busy completions for the same
node/attempt/candidate retain the first busy end as the wait start; a non-busy
completion, new candidate or driver restart resets this cumulative age.

CLI `owed rule` and pi `owed_rule` return
`Recorded #S ruling (<nodes>); delivered <k>/<n>`. The denominator includes
successful, pending and failed role deliveries. Each delivery failure or
unknown writer adds one line directing the reader to `owed why <node>`.
Known calls that are neither running nor asking remain pending. For each
node with such a known writer, the receipt adds:
`<node>: writer call <rid> has finished, so the ruling was recorded but not sent now; the driver delivers it on its next pass; if <node> is halted, run owed resume <node> (owed decide records and resumes in one step)`.
`owed rule` never sends follow-ups itself. Use the printed resume action for a
halted node, or `owed decide <node> --text "<ruling>" --writer` to record the
decision and resume in one step. Delivery remains the driver's next eligible
pass; a recorded ruling is not proof of immediate delivery. Runtime delivery
results add optional `finished: [{node, writer}]`; unknown writers retain the
separate forwarding hint.

The default receipt omits ruling bodies, follow-up messages, active-block
quotes and status brief; JSON/tool details retain complete plain-string
follow-ups, preserving literal newlines and backslashes.
The separate decide receipt is specified in §8.3.1.

Why's `Ruling to forward` contains only in-scope rulings the open slot writer
may still need, including global `*` rulings. With a writer launch it uses the
driver's undelivered set; without one it includes only rulings newer than both
dispatch's `rulings_seen` and that attempt's latest writer submit. An empty set,
closed slot or merged node omits the section. Runtime delivery limits are in
§7.17. Optional `measuring`, `mergeWaiting`, `rulingFollowUp` and job timestamps
are view/cache data, not evidence, ledger fields or new plan keys.

A live driver's last describe also publishes durable-writer waits. Status
lists `<node>: writer waiting on durable <request> (<state>, <seal age>)`
under In progress; why uses the same headline. The state is `pending`,
`running` or `finished` (finished with its wake not yet delivered). This wait
creates no Needs-you item and does not wake the parent. It also applies to a
candidate whose current writer received a repair or ruling follow-up after that
candidate's submit; otherwise a candidate keeps its reviewing, measuring or
accepted phase even if its writer awaits a durable run. With a finite numeric
`sealedAt` from the latest described sealed call,
the age is measured from that generation's actual seal time. Strings and
non-finite values are treated as missing; a future time is clamped to age zero.
Without the field, the approximate age starts when the driver first observes
that sealed generation. New generations reset it, and approximate ages reset
on driver restart. Age affects display only, never scheduling. The cache is bound to the current writer attempt and is unknown without a
live driver. It is runtime context only, never ledger or acceptance evidence.

### 9.4 Decision metrics and counterfactual reports (0.23, MX / DF3)

`owed report --metrics [--since seq|ISO] [--until seq|ISO] [--json]` retains
its existing window and parent-act semantics and adds:

- `decisions`: one per shared `decision` id, resume batch, or recognized legacy
  amend plan/ruling pair in the window; other parent acts each count once.
  `actsPerDecision` is parent acts divided by decisions (`null` without any).
  Grouping decisions does not collapse the existing parent-act count.
- `parentActs.mergedOnly: {total, perMergedNode}`: only acts with nonempty
  explicit targets whose every target merged in the window. Targetless acts
  and acts touching any unmerged node are excluded.
- `interruptions.byClass`: `shared`, `trunk-red`, `fix-wait`, `review`, `writes`,
  `no-submit`, `repairs-exhausted`, `attest-error`, `other`, from recorded halt
  text. Each halt adds `interruption`; answers are not classified, so class
  totals sum to `interruptions.halts`. A multi-answer decision counts every
  answer, but its ruling is one parent act of class `answer`.
- `latency.phases`: duration summaries (`samples`, `median`, `p90`, `max`) for
  merged nodes: `measure` from the merged candidate's submit to its last node
  measurement on that commit, `review` from that measurement to the last
  measurement/review/waiver/defer/evidence event before merge, and `mergeWait`
  from that event to merge. These are ledger-event approximations. Repeated
  submits of the same commit do not restart them; dispatch/rebase resets
  phase tracking. Missing measurement gives no measure sample; review and
  merge-wait calculations fall back to submit when necessary.
- `reviews.sameModel` (0.24, RK): recorded review and closure-review entries
  whose model matches the writer's model for that attempt and review key,
  ignoring the thinking suffix. Both OK and block entries count, including
  multiple obligations by one reviewer. Review windows still use earlier
  submits to identify the writer model; unknown models are not inferred from
  driver selections. `drive.same_model: accepted` quiets the warning, never
  the count. Ordinary `owed report` and metrics both expose this field and
  print `Reviews by the writer's model: <n>`; approval entries are excluded.
- `infra` (0.26, IF): `{total, byObligation}` counts observations carrying a
  validated `infra` pairing receipt in the window. One receipt may resolve
  several consecutive setup failures; it still counts once. This is not a
  waiver or debt metric (§7.26). Text reports `Infra` beside grants.
- `latency.leaseWaitMs`: summaries of recorded `lease_wait_ms` on obs/merge
  entries in the window (§7.14a), one sample per entry. Older ledgers have no
  samples. Text prints a machine-lease line only when samples exist.

Text adds decision, merged-only act, halt-class and phase lines. Metrics uses
the normal ledger load and recorded plan blobs; classification adds no cold
counterfactual fold and makes no Git/dsa query. For state-based classification,
use `owed report --counterfactual [--since seq|ISO] [--json]`; it is exclusive
with `--metrics`, and `--until` remains metrics-only. Neither report changes
acceptance or records ledger acts. These options are CLI-only; `owed_report`
continues to expose ordinary report with `since`.

Counterfactual uses the decision-group-aware read path: an incomplete final
decision group is hidden for unlocked readers, as in §8.3.1; locked loads and
verification remain strict. It performs one validating cold fold, classifying
each recorded driver halt using state immediately before it: `trunk-red`,
`shared`, `fix-wait` when an accepted fix exists, otherwise `clean-rebase`,
`unknown` or `unchanged`. Shared parking requires no failing merge-tree node
check. If a parent rebase occurs before the node's next driver action, the old
candidate is probed against the new base with its recorded old base: a clean
Git merge yields `clean-rebase`, a conflict `unchanged`, missing objects or
failed probes `unknown`. This estimates policy savings, not acceptance or
proof that historical writer runtime conditions permitted automatic rebase.

Rows count targeted parent/owner acts after the halt until the node's next
driver/executor action, including a merge-tree observation or merge. All such
acts are estimated unnecessary for shared/trunk-red/fix-wait; clean rebase
excludes the rebase act itself. Text gives totals by class and up to 20 merged
nodes with halts; JSON gives all rows with `seq`, `node`, `attempt`, `reason`,
`class`, `acts`, `saved`, optional `rebase`, and `merged`.

The command holds no lock, runs no measurements and writes nothing to the
repository, ledger or replay/plan caches. Merge-tree objects use a temporary
directory. Before the fold stderr says
`replaying <n> entries to classify <h> halts (cold; about one full replay)`.
Cost, probe budget and interruption cleanup limits are in §7.17.

### 9.5 Diff-derived review views (0.24, RK)

When `risk` is configured and a candidate exists, why's receipt adds optional
`reviewRequirement: {count, min_rank, cause}`. Status JSON adds optional
`reviewRequirements`, mapping open candidate node ids to the same object.
Ordinary status progress, full status, why and reviewer packets show the
derived count, rank and contributing class or unmatched path, for example
`review 0 required, rank >= 1: every changed path is under risk class docs/**`
or `review 2 required, rank >= 2: src/ledger.ts (risk rule 2)`.
Dispatch packets list the owner's ordered classes. Without policy these new
requirement fields are absent and existing review behavior is unchanged.
Report/metrics `reviews.sameModel` is described in §9.4; it measures recorded
model correlation, not independent reasoning or review quality.

### 9.6 Outstanding-only why card (0.25, QT; 0.26, AK)

`owed why <node>` / `owed_why` starts with `<node>: <phase>; <n> outstanding`
(or `nothing outstanding`; `<node>: merged` after merge). It lists unsatisfied
obligations, active blocks and conditions with their reasons and next actions:
halt (including needs-parent/owner), hold, dependency/continuation wait, parked
writer report awaiting the parent, pending rebase, merge conflicts and
out-of-writes paths. Unacknowledged model warnings remain visible.
The in-flight measurement appears in the outcome; a merge/measure waiting
line is shown only when it is not measuring. The complete `Ruling to forward:`
block stays in the default card because forwarding it is a need. The derived
`review <n> required, rank >= <r>: <cause>` remains for an unmerged node as
context, not an outstanding item. The count includes unsatisfied obligations,
active blocks and current merge-check debt, plus a ready dispatch skip (§9.8);
merge/measurement wait, hold, report, rebase and warning context do not add to
it merely because a line is displayed. An accepted merge-waiting node may have
nothing outstanding and still be waiting to merge.

Default why and candidate receipt cards (including rebase and attest, and
detailed dispatch receipts when rendered) show ΔO⁻ only for entries after the
current attempt's dispatch or its latest resume, whichever is later. Older downgrades remain in `--full` and
JSON; `owed rebase <node> --full` and `owed attest <node> --full` expose them.
This is presentation filtering, not removal of obligations or audit history.

`Details: owed why <node> --full` ends the card. `--full` (pi `full:true`)
restores satisfied items, observations, logs/counts, driver runs, historical and
superseded blocks, other ruling text, ΔO⁻, selected/used model lines,
acknowledged warnings, backlog (`later`) marks and quarantine lifts. JSON retains its detailed history; submit/review/attest/waive and refusal
receipt cards generally retain detailed evidence, with the same current-attempt
ΔO⁻ filter unless `--full` is requested. Waive replies instead use compact why
after their debt receipt and effect; `--full` restores the full card (§9.9).
Trunk/invariant subjects never receive a node command: unmeasured trunk items suggest `owed attest --trunk`; red items use
the status/decision view's plan-repair command. Quiet text never removes a need
or the content needed to act on it (§12.8.3).

### 9.7 Measurement cost and reads diagnostics (0.26, CO)

`owed report --cost [--since <seq|ISO>] [--json]` reports checks and invariants
by total measured machine time, with ties ordered by obligation id. Per row:
execution observations, total/median/nearest-rank p90 `durationMs`, failures
(including errors), setup failures separately, and total `lease_wait_ms`.
JSON durations are milliseconds; text duration summaries are seconds and
lease wait remains milliseconds. Checks sharing an id aggregate across nodes.
One repeat observation is one row execution; its duration includes its runs.
No measurement is inferred for missing observations.

Invariant rows include measured merges versus all recorded merges in the
window; a successful batch measurement counts for each member. Reused evidence
from another tree and refused merges do not increase merge coverage. Prefix
attribution compares consecutive distinct measured trunk keys, using captured
`reads` and changed files grouped by their first two path segments. A prefix
counts once per key transition; same-key retries add cost, not invalidations.
The first in-window sample uses its preceding historical key. Refused merge
trees consume time but are not trunk samples; landed merge/adopt trees are.
JSON `invalidatingPrefixes` gives the top five prefixes and `measuredTrunkKeys`
counts samples. If one prefix occurs in more than half of the highest-cost
invariant's samples, advice says `narrow reads of <id>: <prefix> changed its
key in <n> of <m> runs`. This is diagnostic advice, not proof of coverage.

Plan admission warns when `reads` contains `**` or covers at least 90% of
tracked trunk paths: `warning: reads of <id> cover <p>% of the repository:
almost every change remeasures it (owed report --cost)`. A check intersecting
closure warns `warning: check <id> reads closure path <p>: checks see the base
version of closure files`. Intersections use tracked paths and explicit
literal closure entries, not invented files for two unobserved globs. Lint
warnings are deduplicated in a plan receipt and not ledger entries; unchanged
start does not repeat cost lint. Plan/edit admission checks only new checks or
invariants and changes to `run`, `reads` or `timeout_s`, matched by invariant id
or node/check id. Closure warnings recur only when that check's reads or the
closure changes. Initialization checks everything; edit previews may expose
those same warnings. General check-less/loop warnings retain their own rules.

Default status warns when the latest executor trunk pass of an invariant took
at least 80% of its configured timeout: `inv:<id> took <d> of timeout <t>; an
automatic remeasure doubles a merge's wall time`. A successful merge-tree pass
counts only once its tree lands; unlanded passes do not. A newly recorded plan
prints that diagnostic with the lint `warning: ` prefix only when its text
differs from the prior recorded plan's admission. Status and cost reporting
retain their full diagnostics. Status JSON adds
`runtimeWarnings` only when such warnings exist; they are not outstanding work.

Cost, metrics and counterfactual modes are mutually exclusive; `--until`
remains metrics-only and `--since` is exclusive. Cost is CLI-only. Prefix
attribution needs the measured Git commits to remain available; command/closure
changes and files outside reads are not attributed to a reads prefix. Its
setup-failure counts are report-only heuristics from stored counts, timeout
and error evidence, not the reducer's validated resolution predicate (§7.26).
In particular, cost uses obligation-wide counted history and timeout/exit-code
heuristics, rather than the reducer's earlier same-subject history and strict
per-run zero-result checks. Never use a cost classification to discharge a gate.
No report, lint or runtime warning changes an acceptance gate or key.

### 9.8 Ready dispatch explanations (0.26, WA)

Default status and `owed why <node>` explain the same dispatch predicate as
the driver, in dispatch order with same-pass capacity/writes reservations:
`ready, not dispatched: writes overlap <other> (<path>[, ...]) → owed dispatch
<node> --allow-overlap`, `ready, not dispatched: <a> active of max <m> (<p>
waiting to merge)`, `ready, not dispatched: <o> open attempts reach the cap
2 × max = <2m> (<p> waiting to merge)`, or the existing owner-needed reason.
Accepted open slots are waiting to merge; all other open slots, including removed
nodes, consume active capacity. Status shows `active <a> of max <m>, waiting to
merge <p>` only when `p > 0`; with no accepted open slots, compact and full status
retain the prior output without an extra capacity sentence. Dispatch skip texts
still report active and pending counts. Owner-needed ready nodes appear once under Needs you, not
again as a ready line. These explanations change no replay state or JSON
shape and are not a promise of a later dispatch.

Current status capacity/ready lines and why use a live driver's recorded `--max`
override when available, otherwise the plan's `drive.max`. Known limit:
`statusView` callers outside the current summary/why read paths use plan
`drive.max`, not the live override.
Older driver locks cannot expose an override they did not record. The unchanged
same-model warning compares the models actually used; acknowledge deliberate
same-model policy with `drive.same_model: accepted`, or route reviewers to a
different model (§12.5.2).

### 9.9 Flaky diagnostics, trunk attribution and tracked waiver debt

A flaky exec block names the original failing commit/observation and its
attribution pass **on the same key**, plus the merge key for merge failures.
It lists up to three failed names and a remainder. A later candidate's pass
never erases the original failure; when keys differ the text separately names
the current candidate's pass, fail/block or not-yet-measured state.

An older candidate-key flaky block is held from owner/repair requests while
the current candidate has no counted executor pass of that obligation on its
own key. Error-only measurement remains held; current failure takes the normal
repair route, and a current pass exposes the original risk. Same-key and
merge-key flakes are immediately actionable. Status says
`waiting for <obl> on candidate <commit12> before deciding flaky #<F>`.
Needs, wake, why, waiver hints and driver repairs use the same hold policy;
held blocks still bind acceptance/merge and may be waived at any time.

At combined presentation sites, including the driver wake, the order is:
current trunk-red diagnosis **with parent guidance and the
`or owed waive <node> <obl> --accept-risk <N>` alternative**, then a check
failure also present on trunk, then the full flaky failed/pass same-key pair.
The stronger diagnosis never discards that pair. Shared node-check hints
require complete test-only failures, same check definition (including a
referenced set), closure and matching signatures; name-only matches apply
only when neither side has a signature. A same-node trunk probe may precede
or follow the failure within the history scan (from failure seq minus 5000,
with no upper bound). This relaxation is check-only; invariant shared-failure
rules, automatic retry and allowance deferral are unchanged. A passing probe
adds no shared-failure evidence; older shared history can remain relevant
while current trunk-red follows the latest non-error current-trunk probe.

Shared-check hints name block/trunk/probe, say `not this node's change` and
suggest `owed waive <node> <obl> --accept-risk <N> --tracked-by <fix>
--reason "<why>"`; they suggest a matching fix candidate or say to add a fix
node first. Repair guidance asks the writer to ask the parent, not change code
outside allowed writes. These are diagnoses, never a pass or a cleared block.

Waive replies (CLI and tool) begin `waived <node>/<obl> #<seq>: debt recorded`
(with accepted risk when present), then the effect, then compact why.
`--full` / tool `full:true` restores full evidence after the first two lines.
Accepting a counting block says `in effect now: --accept-risk accepts #<B>`
and includes its flaky pair when available, even for a merge-key block.
Any satisfied candidate clause cites the item's actual evidence, including
reviews, or is omitted when none exists. Only a waiver accepting no counting
block can say it is not needed while the candidate stays satisfied.

`owed waive … --tracked-by <tracker>` / tool `tracked_by` accepts another
unmerged node of the current plan or an external tracker `ext:<id>`, where the
id is 1–128 characters matching `[A-Za-z0-9][A-Za-z0-9._:/#-]{0,127}` exactly.
Missing, merged and self local trackers, and malformed external ids, refuse
without an act. A tracker naming a node in the plan at the waiver entry keeps
its local meaning, including literal `ext:` node names. Replay validates the
optional string against that historical plan; later plan changes never change
whether a tracker is external. Owed before 0.29.2 refuses external tracker
values on replay unless they name a node in the recorded plan.
Tracked debt is identified by `(node, obligation, key, accept_risk block)`:
re-waiving the same failure replaces its tracker; different failures keep
separate lines even on one key, including multiple risks in one waiver.
No-risk waivers retain `(node, obligation, key)` identity.

Default status/brief/summary debt shows `waived — tracked by <fix>: <reason>`
with the failure block when present. Only debt whose own tracker merges is
omitted from those lists/counts; full status/report keep
`settled by <fix> (merge #<seq>)`. A tracker leaving the plan unmerged restores
visible debt as `(tracker <fix> left the plan)`. `owed why <fix>` lists each
waived debt it tracks. Settlement is presentation only: it neither removes
the waiver/ΔO⁻ nor proves the flake gone, and changes no acceptance gate.
External debt instead reads `tracked by ext:<id> (external)` in summary debt,
full status and report, and in compact/full `owed why` of the waived node.
It never settles or leaves the plan, even if a later node has the same name;
it does not appear in unrelated nodes' `why` output.

## 10. CLI

`owed --version` and `owed version` print `owed <package version>` without
requiring a repository. They accept no other arguments or options and report
the installed package, not a ledger's reader requirements.

`owed help` is an alias of `owed --help`, listing commands and flags.
`owed help <command>` and `owed <command> [args…] --help` print only that
command's help, including all its forms, any command exit codes, the generic
Usage line and its accepted flags plus `--json`, `--as`, `--i-am-owner`.
Help uses the same command text and flag table as the CLI and exits 0 before
repository I/O, including outside a repository. Unknown help commands exit 2
and name the known commands.
`owed <command> [args] [--json]`; commands mirror §8:
`start [--plan <file>] [--max N] [--stay] [--restart]` (§10.2), `init <plan.yaml>`,
`plan <plan.yaml> [--rev <commit-ish>]` (path relative to the cwd; with
`--rev` the file is read from that commit, so a plan kept in trunk is the
ledger plan), `amend <node> --writes +<path>[,+<path>...] --note <limit>
[--plan <file>]` (§3 Amend; bare paths mean `+path`, and already-covered paths
are no-ops, as in §8.3.1), `edit <node[,node...]> --set path=yaml ... [--unset path ...]
[--node-new] [--rule TEXT [--writer]] [--resume [--after a,b] [--expect report]]
--note WHY [--dry-run] [--plan FILE]` or `edit --invariant ID --set field=yaml
--note WHY` (§3 ED1/ED2),
`decide <node[,node...]> --text TEXT [--writes +PATH ...] [--defer INV]
[--resume | --no-resume] [--after NODE] [--remeasure] [--writer]`
(parent/owner; one decision, §8.3.1),
`rule <text> --nodes a,b|* [--writer|--prospective]`,
`answer <node> [--qid Q] [--rid R] [--rev N] "<text>"` (AN1–AN2, AR; parent/owner;
`--rev` is a positive integer, otherwise a usage error; prints the answered
node/run/qid and actual post-delivery call state, with other-role delivery results when present;
`--json` retains the request id and delivery details in
`{entry, request, delivery, answers}`; a failed delivery refuses with the recorded rule
seq and exact retry command), `dispatch <node> [--allow-overlap]`,
`submit <node> [--commit X] [--model MODEL]`, `rebase <node> [--apply] [--full]` (also
accepts global `--json`, `--as role:id`, `--i-am-owner` and `--help`; manual:
parent/owner or the slot writer inside its worktree; `--apply`: parent/owner
executor rebase, §7.25), `attest <node> [--rerun | --remeasure [--all]] [--full]`,
`attest --trunk [--remeasure [--all]]`,
`attest <node> --probe-trunk [--check ID] [--runs N]` (§7.27; CLI only),
`review <node> --ok|--block [--needs-parent] --rank N --as reviewer:ID [--note] [--ack-rulings N|latest] [--model MODEL]`
(`--needs-parent` records `needs: "parent"`; refused with `--ok`),
`waive <node> <obligation> --reason ... [--accept-risk 12,15] [--tracked-by FIX|ext:<id>] [--full]`
(`review`, `waive`, `approve` and `evidence` also take `--candidate COMMIT`,
§8 act binding),
`defer <node> <inv-id...> --reason`, `abandon <node> [--hold] [--note TEXT]` (older
spelling `--reason`; not both), `resume <node[,node...]> [--after <node>] [--expect report] [--remeasure] [--note TEXT]`
(parent/owner, §12.3; prints `Recorded #<seq> <by> resumed <node>[ after
<dep>]`, then `<node> waits for <dep> (resume #<seq>); the driver acts again
when <dep> merges`, or `<dep> is already merged: <node> resumes now`; `--json`
the entry), `merge <node>`, `status [--full]`,
`why <node> [--full]`, `report [--metrics [--until seq|ISO] | --counterfactual | --cost] [--since seq|ISO]` (§9.4, §9.7), `brief [--since seq|ISO]`, `verify`,
`sweep [--commit C] [--due] [--no-lease]` (§7.15b; `--due` requires
`sweep.every`, a not-due call records nothing and exits 0),
`adopt [--commit X] [--wait SECONDS] --note TEXT` (owner; off-ref fast-forward
hotfix landing under the merge lock without stopping the driver, §8.3.2;
`--as parent:ID` under an `adopt`
allowance, §3.4, with no prompt and no preview; before the TTY prompt, and also with
`--i-am-owner`, it prints to stderr the preview — full ledger trunk
prior..commit, commit count, every changed path one per line and the note,
escaped as in §11 — and adopts exactly the previewed commit; the captured ref
is rechecked after measurement, so a move during measurement refuses),
`escape <node> --merge N --class missing|false-pass|reuse|weak|waiver --note T [--evidence T]`
(parent by default, or owner), `decoy commit <digest>`, `decoy reveal <file.json>`
(owner commands), `decoy digest <file.json>` (prints the digest to commit;
no ledger write, no owner confirmation), `gc [--dry-run]` (parent/owner), and
`drive [--once] [--max N]` (the driver, §12.7; always `parent:drive`, no `--as`),
`drive --detach [--max N]`, `drive --status [--json]`, `drive --stop [--now]`
(the background driver, §12.8),
`approve <node> [--note TEXT] [--block]` (D23: owner, default `owner:cli`, `owner:human` under `OWED_CONFIRM=owner`;
delegated by default — no prompt, TTY or not, D25 §2.1; under `OWED_CONFIRM=owner`
a TTY confirmation or `--i-am-owner`; `--block` records an owner block; before
recording (and before any prompt) it prints to stderr `Approve node <node>: candidate <commit>
(submit #<seq>), base <base>, N changed files` and approves only that candidate) and
`evidence <node> <id> [--file PATH]... --note TEXT [--as role:id]` (D23: default
`parent:cli`; `--file` may repeat, paths relative to the cwd, hashed when
recorded; stored repository-relative when inside the repository, else absolute;
an owner `--as` is delegated by default and prompts only under
`OWED_CONFIRM=owner`).
`--as role:id` sets the principal (default `parent:cli`; `submit` and `rebase`
default to the slot's writer when run inside its worktree). Owner commands are
delegated (D25, §2.1: `channel: delegated`, no prompt, TTY or not); `--i-am-owner`
records `channel: flag`. Under `OWED_CONFIRM=owner` they prompt on a TTY as in
0.4.1 and refuse without one unless `--i-am-owner`. `plan` takes `--note TEXT`
(required for a delegated downgrade). In a pi-durable-subagents call owner and
parent commands are refused (§2.1). Exit codes: 0 ok, 1 refused
by a guard or a newly measured attest failure (message/receipt says which
obligation; also code `stale`, stderr `Stale: <message>`, 0.12),
2 usage error, 3 internal error, 4 attest completed without a measured failure
but obligations outstanding (§8.3 PO5),
75 busy (a lock is held: the node's attest is already running, or a lock wait
timed out, §7.11; stderr `Busy: <message>`; retry later), 130/143 aborted by a
signal; a ledger entry of a newer owed (§6, G1.5, code `version`) exits 1
with the message alone on stderr (also `verify`, which otherwise exits 3 on a
failure). `verify` prints `snapshotMismatch: <seq> (...)` after its pass line
when it deleted a disk snapshot that differed from its replay (§1). With
`--json` a failing command also prints one line `{"error":
<message>, "code": "refused"|"usage"|"internal"|"busy"|"aborted"|"version"}` on stdout;
stderr text and exit codes are the same as without `--json` (the `owed drive`
`--json` loop instead ends with its exit record, §12.8).

Signals (D16). While `attest`, `merge`, `init` or `adopt` runs (after any owner
confirmation), SIGINT, SIGTERM and SIGHUP are handled: the first aborts the
operation (§7.8: the running check's process group is killed, nothing more
starts), the CLI prints `Aborted: <signal>` to stderr and exits 130 (SIGINT) or
143 (SIGTERM/SIGHUP); signals within 1 s of the first are the same request
(ignored), and a signal 1 s or more later while aborting exits at once with the
same code as the first. So `hold machine -- owed attest` releases the lease only after
the checks ended. Exit codes describe the ledger outcome (`owed drive` reads them,
D14.3): a signal that arrives after the last abort point, when the operation
completed, does not change the exit code — the normal result is printed, stderr
says `Signal <SIG> arrived after the operation completed; nothing was aborted`,
and the exit is the operation's normal code (including attest 0/1/4); only an operation that was
actually aborted exits 130/143. The handlers are removed when the command ends.
SIGKILL cannot be handled: checks already started then keep running in their own
process groups until their own end (their timeout timer died with owed) — out of
scope. A second signal exits without removing the running job's temporary
worktree (`owed-run-*/tree` under the temp directory): `git worktree remove --force
<path>` removes it; once the directory is gone (deleted, or by the temp cleaner),
`git worktree prune` (also run by `owed gc`) drops its registration.

### 10.1 Init, attest --genesis and the genesis warnings (D24)

- `owed init` exits 0 once genesis is recorded. When its genesis attest did not
  observe every genesis item (an error verdict, an exception) it prints, after the
  initial observations count (and `Genesis attest stopped: <error>` for an
  exception), `Initialized (genesis #<seq>). Genesis attest incomplete: recorded
  <ids>; missing <ids>: run owed attest --genesis, or the next attest/merge
  measures them first.` (`none` for an empty list) — never "retry". Aborted by a
  signal it prints the same line, then `Aborted: <signal>`, and exits 130/143.
- `owed attest --genesis` (no node; not with `--rerun`; abortable like attest)
  measures the genesis items still lacking an observation and prints `Genesis
  attest: N observation(s) recorded; observed <ids> [(failed <ids>)]; missing
  <ids>`; exit 1 for any newly recorded fail, otherwise 0 when complete or
  4 for outstanding results (§8.3 PO5).
- `owed plan` while genesis items lack observations succeeds and adds the line
  `Warning: genesis attest pending for <ids>` (stdout; stderr with `--json`).
- `owed status` (and `owed_status`, `/owed`) shows, after the trunk line while
  genesis items lack observations, `Genesis: <k>/<n> invariants observed` then
  `(measuring in this session)` in the process running the genesis attest, else
  `— run owed attest --genesis (or the next attest/merge measures them)`,
  then `; pending: <ids>`.
- Signals: an `init` aborted after genesis was appended prints the incomplete line
  above before `Aborted: <signal>` (exit 130/143).

### 10.2 Preflight and start (0.25, SF; 0.26, AK)

`owed start [--plan <file>] [--max N] [--stay] [--restart]` performs read-only preflight,
initializes a missing ledger, records a semantically changed plan and starts
or reuses the detached driver. `--max` must be a positive safe integer; it and
`--stay` apply only to a newly started driver, not to one already running.
Start takes neither `--as` nor `--i-am-owner`; subagent starts refuse.

Preflight verifies a Git worktree, author and committer identity, the plan's
parser and shell admission/lint, the declared trunk branch's initial commit,
plan-update authority and the driver lock. No source is guessed: without a
ledger, supply `--plan`; with one, omission rereads the latest recorded
plan/genesis source. An explicit changed source becomes the future default.
Canonical equality ignores formatting-only edits. Lint warnings are folded
into the action line without suppressing them and remain in structured results.

Fresh init is delegated `owner:pi`, with `measure:false`: start does not run
`owed_init`'s session-owned background genesis attest; the driver's existing
attest/merge lifecycle measures genesis. Changed plans use existing parent
permissions and candidate carries. Uncovered downgrades refuse with
`owed plan <file> --note "<why>"` as the explicit owner decision (use
`--as owner:pi` for that delegated CLI act), then start again; allowance-covered downgrades retain their accounting. Under
`OWED_CONFIRM=owner`, fresh start refuses with `owed init <file>` as the fix,
never opens a blocking dialog. Missing sources, invalid plans/commands,
identity/ref failures and foreign driver locks refuse naming the failed
preflight and remedy, without an init or plan entry.

An unchanged plan with a live driver says `already running`, records nothing
and preserves its log. Normal output has three lines: `start: initialized
ledger|updated plan|plan unchanged`, `driver: started|already running|ended
(...)`, and `Next: ...`; warnings share the action line. Init/plan entries stay
durable if a subsequent driver launch fails: inspect `owed status` or
`owed drive --status`, fix the launch and start again, not init again.
JSON/tool results are `{initialized, updated, plan, warnings, driver}`;
`driver` retains its normal start fields and optional `alreadyRunning`.
A standalone CLI has no pi session to wake; use pi for automatic session
follow-ups or inspect driver status when needed.

`--restart` / `owed_start {restart:true}` gracefully stops a live local driver,
drains its current action and in-flight measurements, and waits for that
process (pid and start time), not merely lock release, to exit before starting
a replacement. The existing stop deadline is ten seconds. On timeout it
refuses with exit 2 and the pid: `driver pid <P> is stopping after its current
action and its in-flight measurements; repeating owed start --restart is safe;
owed drive --stop --now stops it at once`. It never escalates automatically.
A repeated graceful request only waits; §12.8's stop request prevents a second
signal. Without a live driver restart is ordinary start; foreign-host locks
still refuse. Preflight and actor restrictions are unchanged.

## 11. pi extension

0.30 adds `owed_check_try` (§3.10): `{node?, check?, invariant?, red?, green?,
plan?, no_lease?, json?, cwd?}`. Select either node/check or invariant and give
at least one revision. This diagnostic tool records no ledger entries and needs
no owner/parent identity. Unmet expectations return `isError: true` with results
and the retained log tail. Plan-recording tools run changed selftests before
recording; previews never execute them.

0.23 adds `owed_decide` (§8.3.1): `{nodes: ["A", "B"], text, writes?, defer?,
resume?, after?, remeasure?, writer?, as?, cwd?}`. False `resume` preserves the
halt; writes uses amendment authority and defer needs the owner. Delivery
follows the atomic decision append. `owed_rule` uses §9.3's concise receipt.
CLI `report --metrics`/`--counterfactual`/`--cost` and `rebase --apply` have no matching
parameters on `owed_report` or `owed_rebase`; use the CLI for those options.

0.20 surface parity: `owed_attest` adds optional booleans `remeasure` and `all`
(`trunk:true`, no node, for trunk remeasure; all requires remeasure).
`owed_resume.node` accepts a string/comma list or non-empty string array and
adds optional `remeasure:boolean`; batch options/atomicity are §8.3.
`owed_submit.model` and `owed_review.model` are optional non-empty strings
recording the actual model; omitted review `ack_rulings` derives only from the
qualifying driver launch packet (§8.3 PO6). `owed_why.full?:boolean` restores
weak-confirmation history. Existing plan/edit tools accept template/quarantine
plan input through the same parser; no template-specific tool is introduced.
Plan/edit warnings and rule/answer delivery result fields are
additive (§8.3, §12.5.2). Upgrade the pi plugin with CLI/driver (§Compatibility).

Since 0.12, extension loading eagerly starts one shared native `worker_threads`
worker per pi process. Every tool execution, `/owed` command, background genesis
attest and drive follower ledger/git/revalidation operation runs there. The pi
thread registers schemas, displays owner dialogs and results, and runs the
follower's two-second timer. The worker loads the installed modules eagerly;
`index.js` selects `dist/*.js` for npm installs and `src/*.ts` for git installs.
The native worker needs no optional pi peer packages (schemas are only used by
the host). An idle worker is unref'd so it does not keep pi alive.

Calls use structured-clone RPC `{id, method, args}` and replies
`{id, result}` or `{id, error: {code, message}}`. OwedError codes and messages
are preserved. Abort messages forward the tool signal to the existing abortable
operations; other operations retain their existing abort behavior. Owner actions
still preview in the worker, confirm on pi's thread, and commit in the worker;
the candidate/file pins still refuse a change during the dialog. Watch delivery
is acknowledged by pi: a busy session or failed delivery retains the batch for
revalidation on the next tick. Shutdown stops the session's timer and followers
and aborts its background genesis attest; it does not stop a detached driver.
A worker crash/exit fails outstanding calls with `owed worker …; retry the call`;
the next call creates a replacement, without automatically replaying lost calls.

The extension remembers the package version beside its loaded module. Each tool
result checks the installed package version (cached by manifest stat). A changed
version appends exactly this last line once per pi session per installed
version, at the first tool output (0.15 SQ4); `owed_status {full:true}` always
appends it while versions differ:
`owed <installed> is installed but this pi session loaded <loaded>: restart pi to use it.`
The same line is retained on a mismatch refusal and appended to errors with
code `version`, even when the version strings match. Dedupe lives on pi's
thread for the session and survives worker replacement. A replacement worker is refused when the installed version differs
from the loaded version; startup also checks the version before and after loading
its modules. This prevents a crashed old session from silently switching to new
code. A same-process extension reload shares the original worker; after an upgrade,
restart pi to load the new version.

Tools (profiles and discovery are §11.2). Every tool takes an optional `cwd`: an absolute path
inside the target repository (the session directory when omitted; a relative
or missing path is an error), so a session started elsewhere can drive any
repository. Most tools also take `as` (`role:id`).

| tool | parameters (besides `cwd`) | operation |
|---|---|---|
| `owed_start` | `plan?`, `max?` (positive integer), `stay?`, `restart?` | preflight, delegated init or permitted plan update, start/reuse detached driver (§10.2); no `as` |
| `owed_status` | `as`, `full?: boolean` | outcome and next actions; full keeps evidence and audit |
| `owed_why` | `node`, `full?`, `as` | outstanding-only card; full restores all evidence/history (§9.6) |
| `owed_report` | `since?`, `as` | report |
| `owed_brief` | `since?` | brief |
| `owed_verify` | — | hash chain + replay |
| `owed_dispatch` | `node`, `allow_overlap?`, `as` | dispatch; prints packet once and references it in text arguments; structured `subagents` retains full task (agent `worker`, cwd = slot worktree, isolation `none`, task = packet) |
| `owed_submit` | `node`, `commit?`, `model?`, `as` | submit (writer inferred from a `cwd` inside the slot worktree) |
| `owed_rebase` | `node`, `as` | rebase (parent/owner or the slot writer, inferred as for submit) |
| `owed_check_try` | `node?`, `check?`, `invariant?`, `red?`, `green?`, `plan?`, `no_lease?`, `json?` | exact-commit disk-plan diagnostics (§3.10); ordinary verdicts even for red checks; no ledger entries |
| `owed_attest` | `node?`, `trunk?`, `rerun?`, `remeasure?`, `all?`, `lease?`, `as` | attest; trunk needs no node; all requires remeasure |
| `owed_review` | `node`, `verdict`, `rank`, `note`, `obligation?`, `ack_rulings?: number \| "latest"`, `model?`, `needs_parent?`, `candidate?`, `as` | review (`needs_parent: true` = `needs: "parent"`, block only); as owner under the gate the dialog shows and pins the candidate (§8) |
| `owed_merge` | `node`, `lease?`, `as` | merge |
| `owed_abandon` | `node`, `hold?: boolean`, `note?` (older `reason?`; not both), `as` | abandon (parent/owner); hold prevents re-dispatch until resume |
| `owed_resume` | `node` (string or non-empty string array), `after?`, `expect?`, `remeasure?`, `note?`, `as` (default `parent:pi`; parent/owner) | resume (§12.3): clear a driver halt without an obligation, `after` waits for that node to merge; the text is the CLI's plus the node phase line and brief status |
| `owed_gc` | `dry_run?`, `as` | gc (parent/owner) |
| `owed_decide` | `nodes: string[]`, `text`, `writes?: string[]`, `defer?: string`, `resume?: boolean`, `after?: string \| string[]`, `remeasure?: boolean`, `writer?: boolean`, `as` | one atomic parent decision and post-append delivery (§8.3.1); no-resume is `resume: false` |
| `owed_answer` | `node`, `text`, `qid?`, `rid?`, `rev?: number` (positive integer; usage error otherwise), `as?` (default `parent:pi`; parent/owner) | AN1–AN2, AR: record and deliver an answer ruling; an open question uses its current rev, otherwise rev selects a prior retry; returns `{entry, request, delivery, answers}` (§12.5) |
| `owed_rule` | `text`, `nodes`, `writer?`, `prospective?`, `as` | ruling; `prospective: true` binds only later dispatches; `writer: true` requires named nodes to submit again |
| `owed_edit` | `node?`, `nodes?: string[]` or `invariant?` (exclusive), `set?: string[]` (`path=yaml`), `unset?: string[]`, `node_new?`, `note`, `plan?`, `rule?`, `writer?`, `resume?`, `after?: string \| string[]`, `expect?: "report"`, `dry_run?`, `as` | ED1/ED2: targeted YAML edit; plan/carries/rule/resume in one lock; dry run returns diff and downgrades; same default authority as `owed_plan` |
| `owed_amend` | `node`, `writes` (bare paths or `+path`; covered paths are unchanged), `note` (the limit), `plan?`, `as` | widen one node's writes (§3 Amend): plan file edit, plan entry with the authority of `owed_plan` (same default principal), carries and a ruling, in one lock |
| `owed_plan` | `plan` (path relative to `cwd`), `rev?`, `note?` (why; required for a delegated owner downgrade), `as` | plan update; a downgrade needs the owner unless an allowance of the current plan covers every downgrade (§3.4): then the default principal is `parent:pi`, no dialog, and the result names the allowance; otherwise the refusal for a parent lists the uncovered items |
| `owed_init` | `plan` (path relative to `cwd`), `lease?`, `as` (default `owner:pi`, delegated; `owner:human` under `OWED_CONFIRM=owner`; owner only) | initialize the ledger (§11.1) |
| `owed_waive` | `node`, `obligation`, `reason`, `accept_risk?`, `tracked_by?`, `full?`, `candidate?`, `as` | owner waiver; under the gate the dialog shows `Candidate: <commit> (submit #<seq>)`, `Base:`, `Changed files:` and only that candidate is waived (§8) |
| `owed_approve` | `node`, `note?`, `block?`, `candidate?`, `as` (default `owner:pi`, delegated; `owner:human` under `OWED_CONFIRM=owner`; owner only) | owner approval (D23); under the gate the dialog shows `Approve node <node>` (or `Block approval of node <node>`), `Candidate: <commit> (submit #<seq>)`, `Base: <base>`, `Changed files: <n>`, then the note; only that candidate is approved (§8) |
| `owed_evidence` | `node`, `id`, `files?`, `note`, `candidate?`, `as` (reviewer/parent/owner) | manual evidence or receipt (D23); an owner is delegated (no dialog; under `OWED_CONFIRM=owner` a dialog showing `Candidate: <commit> (submit #<seq>)` and `Base: <base>` (or `Receipt on merge #<m>`), `Files (N):` as `path sha12 (bytes)` and the note; the recording is refused if the files or the candidate changed after the dialog) |
| `owed_defer` | `node`, `items`, `reason`, `as` | owner deferral |
| `owed_sweep` | `commit?`, `due?`, `lease?`, `cwd?` | advisory detached-tree sweep under the shared machine lease; 0.24 confirmed boundary records a deduplicated automatic escape (§7.15b); `due` skips unless scheduled due |
| `owed_escape` | `node`, `merge`, `class`, `note`, `evidence?`, `as` | escape record (parent/owner) |
| `owed_adopt` | `commit?`, `wait?`, `lease?`, `note`, `as` (default `owner:pi`, delegated; `owner:human` under `OWED_CONFIRM=owner`) | adopt external commits or land an off-ref fast-forward hotfix without stopping the driver (§8.3.2; owner, or `as: parent:…` under an `adopt` allowance, §3.4); under the gate the dialog shows prior..commit, the commit count, the changed paths and the note, and the confirmed commit is the one adopted. Changed paths: a `Changed paths (N):` line, then up to 50 paths one per line (indented, escaped as below); beyond 50, the first 50 and then the line `… +M more paths; full list: git diff --no-renames --name-only <prior12>..<commit12>` (M = N − 50, the 12-character prior and adopted commits) |
| `owed_decoy` | `action` (`commit`/`reveal`/`digest`), `digest?`, `file?`, `as` | decoy commitment and reveal (owner); `digest` writes nothing |
| `owed_drive` | `action?` (`once` default, `start`, `status`, `stop`), `max?` (once/start), `now?` (stop), `stay?` (start; §12.9) | the driver (§12.7, §12.8): one pass, or start/report/stop the background driver; start makes this session follow its log for wake-ups |

`owed_attest`, `owed_merge` and `owed_adopt` pass the tool call's abort signal
to the operation (§7.8, D16.4): aborting the call ends the running check; the
result is a tool error `Aborted: aborted` (details `code: aborted`). `owed_drive`
(action once) passes it to its pass as well: the pass stops after the current
action (§12.7).

Owner operations (`waive`, `defer`, `adopt`, `approve`, owner `evidence`, `init`,
downgrade plans, decoys, and any tool called with `as: owner:…`) are delegated
(D25, §2.1): no dialog, recorded with `channel: "delegated"`, default principal
`owner:pi`; `owed_plan` takes `note` (required for a delegated downgrade). Under
the opt-in gate `OWED_CONFIRM=owner` the default principal is `owner:human` and
they call `ctx.ui.confirm` and are recorded with `channel: "pi-confirm"`; without
UI they refuse. That dialog waits at most `OWED_CONFIRM_TIMEOUT` seconds (a
non-negative integer, default 120; `0` waits indefinitely; any other value means
the default): owed passes `{timeout: N·1000 + 1000, signal}` to
`ctx.ui.confirm` (pi shows a countdown that outlasts owed's own limit) and races
the dialog against its own N-second timer and the tool call's abort, so a UI
that ignores `timeout`/`signal` or never answers cannot hold the call. When
owed's timer fires it aborts the dialog, ignores any later answer, records
nothing and refuses with code `refused` and `Owner confirmation not given within
<N> s; nothing was recorded.`; the tool call's abort (Escape) dismisses it the
same way and refuses `aborted`. Neither is ever read as a confirmation. `owed_approve` and owner `owed_evidence`
pass the confirmed candidate (D23 pin) in both modes; delegated acts record on
the current candidate. In a pi-durable-subagents call every tool that acts as
owner or parent is refused (§2.1). The confirmation text is the
fixed summary, then `Repository: <dir>` and `Identity: owner:<id>`, then each
free-text field (note, reason, ruling, evidence, changed paths) as `Label: value` on one line
with `\`, newlines and tabs escaped and C0/C1 controls (U+0000–U+001F,
U+007F–U+009F), U+2028/U+2029 and bidi controls (U+202A–U+202E, U+2066–U+2069)
written as `\uXXXX`, then the closing
`Confirmation will be recorded as pi-confirm.` line — so free text cannot fake
the Repository/Identity lines of the dialog. The ledger keeps the exact text. Command `/owed` shows
status. The skill (`skills/owed/SKILL.md`) explains start → driver wakes →
decide/answer → merged, the roles and hard rules; its topic references explain
manual dispatch, submission, measurements and independent review.

### 11.1 `owed_init` (D24)

`owed_init {plan, cwd?, as?}` is owner only (default `owner:pi`, delegated: no
dialog, channel `delegated`; D25). It reads and parses the plan, resolves
refs/heads/<trunk>, refuses an initialized ledger (`Already initialized …`,
before any dialog), then, under `OWED_CONFIRM=owner` only, shows the owner dialog: the fixed summary
`Initialize the owed ledger`, `Trunk: <name> at <commit12>`, `Plan: <path>
(sha256 <sha12>)` (the sha of the stored plan blob that genesis records),
`Nodes: <n>`, then Repository/Identity and the list field `Invariants:` (one id
per line); recorded with channel `pi-confirm` (`delegated` without the gate). It appends genesis for exactly the
confirmed commit (`init` with `measure: false`, `commit` pinned), starts
`attestGenesis` in the shared extension worker (an AbortController aborted on
`session_shutdown`) and returns at once: details `{entry, genesis: <seq>,
measuring: <n>}`, text `Initialized (genesis #<seq>). Measuring <n> genesis
invariants in the background …` (`No invariants to measure.` when none, and then
nothing runs). When the background attest ends the session gets one message
(customType `owed-init`, display, `triggerTurn`, `deliverAs: followUp`, as D17.7):
`owed init: genesis attest of <dir> finished: recorded <ids>; failed <ids>;
missing <ids>` (or `stopped (<error>)`, with the `owed attest --genesis` hint
when items are missing). After `session_shutdown` aborted it no message is sent.
`owed_plan` adds `Warning: genesis attest pending for <ids>` as the first line
(details `warning`) while genesis items lack observations.

### 11.2 Tool profiles, discovery and dispatch (0.25, SF)

Every owed tool stays registered. The default `core` profile declares exactly
seven direct tools: `owed_status`, `owed_why`, `owed_decide`, `owed_drive`,
`owed_start`, `owed_submit` and `owed_review`. Every other tool is registered
at load with `exposure: 'deferred'`, without a load-time host probe or later
re-publishing as deferred. `OWED_TOOLS=all` declares every tool directly and
opts out of owed's discovery activation. Descriptions of core tools explain
that other operations are `owed_*` tools (load with `tool_search` when not
declared) or the `owed <command>` CLI (`owed help`). Each deferred tool's
description ends with `If this tool is not declared, use the owed CLI: owed
<command> (owed help).`, using its command (for example, `owed check try`).
Parent-facing tool-name hints also include the corresponding CLI command.

At `session_start` and every `agent_start`, owed adds every missing registered
direct owed tool to the current active set. Existing active tools are kept,
including unrelated tools and manually activated deferred tools. Hosts without
`getActiveTools`/`setActiveTools`, or whose registry throws, are left alone.
This also restores all tools in the `all` profile and tools previously promoted
to direct because search was unavailable.

On `session_start`, as the host's MCP extension does, owed checks whether the
host reports exposure and a registered `tool_search` declares `reachesTools`.
It activates that search if inactive by adding it to the active set, never
removing any tool. If search is absent or does not become active, owed
re-registers deferred tools as direct, so they cannot become unreachable.
Hosts unaware of exposure ignore the field and treat tools as direct. No pi
version is assumed. This check runs at session start, not continuously: later
manual deactivation of search can make deferred tools unreachable until the
next session start; hosts without session hooks cannot run this repair.

`owed_dispatch` prints its complete packet once. Rendered subagents arguments
refer to `<the complete packet above>`; structured `subagents.task` retains
the full executable task, slot `cwd` and `isolation: none`. Pass the structured
arguments to the runner, not the text placeholder.

## 12. Driver

`owed drive` is a deterministic program that runs the mechanical loop
`status → dispatch → writer → submit → attest → reviewers → merge` with dsa
(pi-durable-subagents) as the process runner and stops only for decisions.
Boundary: dsa never judges completion and never learns the graph; owed never
schedules processes, slots, models or leases. The driver never answers a
question, never waives, never changes the plan, never runs `restart --force`.
The parent-pinned contract is `.owed/drive-contract.md` (D1–D8); this section
records its ledger-facing parts and the executor. `owed drive` requires
pi-durable-subagents ≥ 1.0.27 (`hold --no-wait`).

### 12.1 Level-triggered reconcile (D1)

One **pass** reads the ledger state, `describe --key`s every open launch,
computes actions with a **pure** function `decide(state, plan, runs, opts)`
(`src/drive.ts`), and executes them in order. Events are only a wake-up
signal; losing the event cursor or the drive state dir is harmless because
every pass re-derives from the ledger plus `describe`. `RunView`
(`src/types.ts`) is the subset of `describe --key <rid> --json` the driver
uses: `{rid, state: absent|queued|running|asking|sealed|pruned, status?,
error?, questions?: {qid, rev, question}[], lastFence?: {reason, at}}`
(unknown dsa states map to `running`; `pruned` is treated like `sealed`).

### 12.2 Plan config (D2)

```yaml
drive:
  max: 4                 # active attempts; accepted merge-pending slots excluded, total open cap 2 × max
  repairs: 2             # follow-ups after a failed check / block before halting (default 2, integer >= 0)
  measure: 2             # attests and merges in flight at once (0.7.0; default 2, integer >= 1)
  min_free_mb: 2048      # free MB the driver needs before it starts a measurement (0.11; default 2048, 0 disables)
  writer:   { agent: worker,   model: "example/model-large:high" }   # default {agent: worker}
  reviewer: { agent: reviewer, model: "example/model-large:high" }   # default {agent: reviewer}
```
Optional; `model` is optional (agent default). `parsePlan` fills the defaults
when the block is present (`Plan.drive`; absent block → `Plan.drive`
undefined, `driveConfig(plan)` returns the defaults) and rejects unknown keys
(in `drive`, `writer`, `reviewer`) and bad types. It is not an obligation:
changing or removing `drive:` is never a downgrade (a plan change by parent).
`measure` (0.7.0) is kept in the parsed plan only when the YAML sets it
(`measureCap(plan)` applies the default 2), so a plan that does not use it
keeps its canonical bytes and sha; a 0.6.x parser refuses a plan that sets it.
`min_free_mb` (0.11, F2.3) is kept the same way (`minFreeMb(plan)` applies the
default 2048).

**Node `drive` (0.7.0).** A node may set its own roles:

```yaml
nodes:
  - id: docs-pass
    drive:
      writer:   { agent: worker-cheap }           # agent set: replaces the plan's writer; no model here → the agent's default
      reviewer: { model: "example/model-small" }  # model only: the plan's reviewer agent with this model
```

Shape `{writer?: {agent?, model?}, reviewer?: {agent?, model?},
same_model?: accepted}`, validated like the plan's roles (unknown keys and bad types are errors, e.g.
`nodes[0].drive.writer.effort: unknown key`); `max` and `repairs` stay
plan-wide. `drive: {}` and an empty role object count as absent: they are
dropped from the parsed plan, so a plan without node `drive` keeps its
canonical bytes and sha. The driver's launch spec for a node
(`driveConfig(plan, node)`) takes each role from the plan's `drive` (or the
defaults) and applies the node's object for that role, because a model belongs
to its agent:
- the node's object sets `agent`: it replaces the plan's role; the model is the
  node's `model` if set, otherwise none (the agent's own default model applies).
  Plan `{agent: worker, model: opus}` + node `{agent: worker-cheap}` →
  `{agent: worker-cheap}`;
- it sets only `model`: the plan's (or default) agent with the node's model.
  Plan `{agent: worker, model: opus}` + node `{model: glm}` →
  `{agent: worker, model: glm}`.

Node `drive` is not an obligation: changing it is never a downgrade,
invalidates no candidate (the reducer compares node specs without `type` and
`drive`) and affects only later launches. A re-launch of a recorded run sends
its stored spec bytes, as before (§12.5 row 3). owed 0.6.x ignores a node's
`drive` (it does not validate node keys) and launches with the plan's drive.

**MD2 (0.20.1):** optional `drive.same_model: accepted`, globally or in a
node's `drive`, acknowledges only the informational same-writer/reviewer-model
warning (§12.5.2). Other values refuse. A node can acknowledge without role
overrides; absent node acknowledgement inherits the global value. Adding or
removing it changes no obligation key, downgrade, review block or acceptance
rule; the candidate commit is preserved, and removing it restores the warning
without invalidating evidence.

### 12.3 Ledger entries (D3)

Persist before submit: an intent is appended **before** the dsa call, and every
retry re-sends the exact stored bytes with the same id. Entry kinds `launch`,
`send`, `halt` (§5) may be appended only by role `parent`; launch and send
must name the node's current open slot (node and attempt), and so must a halt.

- Project id `projectId(state)`: the first 12 hex of the genesis entry hash
  (stable per ledger).
- Run id `runId(project, node, attempt, role, n?)` =
  `owed:<project>:<node>:<attempt>:<role>[:<n>]`. Writer rids have no `<n>`.
  Reviewer rids always carry `:<n>` (the ledger refuses a reviewer launch
  without it): `n` = 1 + the reviewer launch entries already in this attempt
  (`nextReviewerN(state, node)`), monotone across the candidates of the
  attempt. In 0.16.1 (RR1), the current candidate C has a **review epoch**
  starting at the earliest submit C0 of the open attempt such that every
  candidate from C0 through C has the same required `review` and
  `closure-review` keys as C (including which obligations exist). A reviewer
  launch after C0 belongs to C: it stays live for questions, rulings, retries
  and rows 12–15, and counts toward the required reviewer runs. A changed
  review key starts a new epoch unless the next submit explicitly carries the
  preceding candidate's reviews across a clean rebase (0.23, §7.25). A key
  changed and then restored without that carry does not resurrect earlier
  runs. Writer launches are unchanged.
  `reviewerBase(state, node)` counts the attempt's reviewer launches before
  C0; epoch runs are `n = base+1 … base+reviewRuns` (local index `k = n - base`).
- Labels `runLabels(project, node, attempt, role)` =
  `{owed: <project>, node, attempt: String(attempt), role}`.
- Driver reviewer principal: `reviewer:drive-<node>-<attempt>-<n>`
  (`driveReviewer`).
- `ops.launch` stores the spec bytes as a blob and is idempotent: a launch with
  the same rid and identical content returns the recorded entry
  (`created: false`); a different one is refused. `ops.send` stores the message
  bytes and assigns the send id under the lock. `ops.halt` records a halt.
- State: `NodeState.runs` lists per attempt the launches and sends
  (`{attempt, launches, sends}`); `NodeState.halt` and the reducer's
  `halted(state, node) → HaltEntry | undefined` give the active halt.
- A halt blocks the driver on that attempt until a later entry on the same node
  by a principal other than `parent:drive` — submit, review, rebase, abandon,
  waive, defer, escape, resume, a non-prospective ruling whose node list names
  it (not `*`) — or a new attempt (any dispatch of the node). Prospective
  rulings never clear a halt. For entries carrying `decision`, only a `resume`
  can clear it: the group's rule, plan, carry submits and defers do not, so
  `owed decide --no-resume` preserves the halt (§8.3.1), displayed as held by
  that ruling rather than a parent resume request (§9). This is derived from
  existing entries; halt-clearing and replay semantics are unchanged. Driver entries
  (`launch`, `send`, `halt`) and executor entries (`obs`, `merge`, which the
  driver causes) never clear a halt. A halt of an attempt that is no longer
  open is not active.
  **Halt row (0.16.1, HA1–HA2):** while halted, the driver still describes and
  reports asking runs that matter: the writer and reviewers of the current
  candidate, with the same question text, answer/ruling hint, rid/qid/rev and
  once/quiet semantics as row 5. `slotAction` neither clears the halt nor sends
  anything or takes another action on the node. PR2 prospective notices still
  reach halted attempts. When the slot action would be a non-quiet
  report of a concrete question (with qid, or an overdue answer retry)
  from the halt row, row 5 or waiting branch, `decide` emits that report
  before a pending/new prospective notice once per rid/qid/rev in this driver;
  the next pass may send the notice. Reporting alone does not make an unanswered
  question quiet: only a recorded answer does. This priority uses runtime
  `once`/`noticed` keys, not ledger entries. A generic asking notification with
  no question content/qid does not delay PR2; other notices keep their precedence.
  `owed status` and brief stay ledger-only
  (they need not query dsa); the driver's asking notify is the question channel.
- **Abandon hold** (0.14, AH). `owed abandon <node> --hold [--note TEXT]`
  (pi `owed_abandon {node, hold: true, note?}`) closes the open slot and appends
  `{kind: "hold", node, abandon: <abandon seq>, reason?}` immediately after the
  abandon in the same ledger lock and append. The held node is not ready and
  does not satisfy dependencies. Status and why show `held by abandon #N`;
  dispatch refuses with `owed resume <node>`. Resume on a held node with no
  open slot records `{kind: "resume", node, attempt: <last attempt>,
  release: "hold", note?}` with the existing parent/owner authority, releasing
  it for a new attempt under normal readiness rules. `--after` and `--expect`
  require an open attempt and are refused on a hold release. A plan removing
  the node discards the hold; re-adding it does not restore the old hold.
  To retire a node, remove it from the plan first, then abandon its slot
  (allowed since 0.12); use `abandon --hold` while the decision is pending.
  No acceptance keys change. Ledgers without these entries replay as in 0.13.
  Compatibility (parent ruling): hold entries need 0.14; 0.13 refuses them
  with code `version`. The `resume.release` field also needs 0.14; 0.13 refuses
  this unknown resume field with code `version`. From 0.14, unknown abandon
  and hold fields are refused with code `version`; abandon has no `hold` field.
- **Stale empty writer slot** (0.14, AH2). If the driver's launch is stale
  because its dispatched node left the plan, is held, or was abandoned, and
  that attempt has no writer launch intent, the driver closes its own empty
  slot with an abandon by `parent:drive` naming the stale cause. An existing
  abandon already closes it and is not duplicated. This produces only a
  quiet stale report, never a halt or notify. Cleanup takes the dispatch lock
  before the ledger lock and checks the attempt and ownership again. A clean,
  unlocked worktree still at its base is removed, then its branch is deleted
  by ref CAS against the base; trees with commits, dirty trees, nested trees,
  locked trees and ambiguous/checked-out branches are kept. A slot dispatched
  by another parent, a newer attempt, or any writer launch intent is untouched.
  A plan change that keeps the node live only retries the launch next pass.
- **Resume** (0.8, L1). `owed resume <node> [--after <dep>] [--note TEXT]`
  (pi `owed_resume`) records `{kind: "resume", node, attempt, after?, note?}`
  by a parent or the owner (writer, reviewer, executor and `parent:drive` are
  refused), on the node's open slot (refused without one; `attempt` must be
  the open attempt); `after` must name another node of the plan. It is refused
  while a review block that needs a parent ruling
  awaits one on the current candidate (else the latest submit) of the attempt —
  the driver would halt again at once — naming `owed rule --nodes <node>
  "<decision>"`. It adds no
  obligation (the `rulings` item and every other item are unchanged) and:
  - clears the node's halt (as any non-driver entry on the node does);
  - starts a new repair epoch: `repairEpoch` takes the latest resume of the
    open attempt (`resume #<seq>`) alongside dispatch, rulings naming the node
    and plan changes of its spec, so the repair budget starts again; what the
    driver waits for after a resume counts from it too (a repair or submit
    follow-up sent before the resume to a sealed writer, `error` observations
    for "attest recorded no verdict twice"), so the driver acts on its next
    pass — e.g. retries a merge refused for an environmental reason, sends a
    sealed writer a fresh repair or submit follow-up, measures again. A repair
    follow-up sent before the resume to a writer that seals after it (without
    a new candidate) is followed by a fresh repair under the new budget, not by
    the "finished repair follow-up without submitting" halt. Halts the driver
    has no remedy for recur with the same reason after a resume while their
    cause persists: a writer run sealed non-ok (row 7) and a reviewer run
    sealed without recording its reviews (row 14, `review-missing`) halt again
    on the next pass with the same reason — fix the cause (or record the
    review, or abandon) instead;
  - with `after`: the node is **waiting** while the latest resume of the open
    attempt has `after` and that node is not merged (`waitingFor(state,
    node) → {after, resume} | undefined`). A later resume replaces an earlier
    one (one without `after` ends the wait); an abandon or a new dispatch ends
    it. A waiting node is skipped like a halted one (no launch, send, halt,
    attest or merge); only asking runs are still reported (row 5). If a merge
    already measuring ends refused after such a resume, the driver reloads the
    waiting state when handling the refusal, reports outcome `waiting`, and
    records no halt or rebase. Observations already recorded remain in the ledger.
  The first writer follow-up the driver sends after a resume (any reason;
  `resumeLine`) starts with the line `The parent resumed this node
  (#<seq>)[ after <dep> merged at <commit12>][: <note>]` (the note on one line).
  When to use which: `owed resume` says "go on" (measure again, retry, wait for
  another node) and creates nothing to acknowledge; `owed rule --nodes <node>`
  gives the writer and reviewers guidance they must follow and acknowledge (the
  `rulings` item becomes owed again).

### 12.3.1 Waiting, reports and backlog (0.13, FL1–FL5)

- **FL1 implicit waiting:** an open slot with unmerged dependencies in the current
  plan is waiting. `why`, `status` and the driver print `waiting (deps: a, b)`;
  no submit, repair or ruling follow-up, measurement or missing-candidate halt is
  sent. Asking runs still use row 5. A dependency-adding plan entry gets one
  durable `send` of kind `notify`, reason `waiting`, to its running writer:
  which dependencies are unmerged and `do not submit until told`. The recorded
  request id and message bytes are reused on retry. When all implicit and
  explicit waits end, a dependency merged since dispatch/rebase moves the slot
  onto trunk through the existing rebase route, then its normal rebase follow-up.
- **FL2 multi-node resume:** `owed resume <node> --after a,b` and tool
  `owed_resume {after: "a,b" | ["a", "b"]}` record a list; all members must be
  other current plan nodes. Empty lists, unknown nodes and self are refused.
  Comma lists are trimmed and deduplicated. A single string remains a string
  and replays as before. Waiting is the union of this latest resume and current
  unmerged dependencies; another resume replaces only the explicit wait.
- **FL3 report:** `owed resume <node> --expect report` / tool `expect: "report"`
  stores `expect` on the resume. The next writer follow-up has reason `report`
  (and may carry `rulings`) and asks `report your findings and stop; do not
  submit unless the parent asks`, rather than asking for a candidate. On a sealed
  successful result (`ok`/`done`) without a subsequent submit, the driver appends
  no ledger entry, wakes the session with its last 40 lines (at most 4000 characters), and
  parks the node as `reported (resume #n)`. It still reports questions. Failed,
  stopped, cut-off or rejected runs did not deliver a report and retain the
  existing row 6/7 routes (including halts and their parent wake-up detail).
  A later submit is handled normally. A rule naming the node, another resume, a plan
  entry changing the node, or abandon releases it; unrelated acts do not.
  `drive/reports.json` is an atomic, ledger-lock-protected runtime receipt of
  node/resume pairs, not an observation or acceptance verdict. Views validate
  pairs against the report send and subsequent parent acts; a missing receipt
  can be recovered by describing the sealed run. Stale follow-up generations
  are never read as the report's outcome (the existing generation recovery).
- **FL4 backlog and idle:** node `later: true` is never ready or dispatched;
  removing it makes the node eligible. It changes no check/invariant key and
  invalidates no candidate. `status`/`brief` list and count `Backlog (later)`;
  they also list reported nodes. Staying `idle-wait` lines carry `counts` with
  `ready`, `open` (all open slots), `waiting` (open waiting slots), `reported`
  and `later`. With only parked slots remaining the driver may idle, but still
  checks run events/questions. `drive.idle_rewake_min` is a non-negative integer
  in minutes, default 60; 0 turns reminders off. While the ledger is unchanged
  and the driver is still idle, another wake is printed at each interval until
  activity or stop. It is a runtime setting, not an obligation key. Old log
  lines without counts retain their original text when read.
- **FL5 invariant spelling:** existing invariant-id entry points (CLI/tool
  defer) accept both `<id>` and `inv:<id>`; recorded ids are canonical bare ids.
  Unknown ids list valid bare/prefixed ids. `why <id>` (when not a node id) and
  `why inv:<id>` reuse the receipt view for a trunk invariant. Invariants still
  cannot be waived, and no `measure` command is introduced.

Compatibility: owed 0.12 refuses a resume with an `after` array or `expect`
as an ordinary refusal, not code `version` (accepted compatibility exception).
From 0.13, unknown resume fields, `expect` values or incompatible `after`
shapes are code `version`. Older owed refuses new sends of kind `notify` or
reason `waiting`/`report` with code `version`; these sends require 0.13.
The single-string resume entry and historical replay/acceptance keys are unchanged.

### 12.4 Views

- **Status**: a `Halted (driver):` section lists halted nodes with
  `needs: human` (`⏸ <node>: halted by driver #seq (attempt N), needs the parent
  (the main agent acts; owed lists the command): <reason>`); a halt with
  `needs: owner` appears instead under *Pending owner*
  (`⏸ halted <node> — driver halted attempt N (#seq): <reason>; cleared by …`).
  `Driver runs (open attempts):` lists the launches of each open slot's current
  attempt (`<node> attempt N: #seq <role> <rid>`). Both sections are shown only
  when non-empty; `--json` has `halted: HaltEntry[]` and
  `launches: {node: LaunchEntry[]}`. Under the halted nodes one line
  `  to clear it without an obligation: owed resume <node> --note "<why>" (add
  --after <node> to wait until that node merges); owed rule gives the writer
  and reviewers guidance they must acknowledge` (0.8). `Waiting (resume):`
  lists waiting nodes (`⏳ <node>: waiting for <dep> (resume #<seq>)`; `--json`
  `waiting: {node, after, resume}[]`, present only when non-empty).
- **Why**: when the node sets `drive` (§12.2), the line
  `Drive: writer <agent> (<model>) · reviewer <agent> (<model>)` with the
  effective values of its later launches (`(<model>)` only when a model is
  set; `--json` `drive`); the active halt with how it is cleared (including
  `owed resume <node> --note "<why>"`, 0.8), a waiting node's `⏳ waiting for
  <dep> (resume #<seq>); the driver acts again when <dep> merges or after
  another resume` (`--json` `waiting`), then each launch
  (`Driver launch #seq <role> <rid> (spec <sha12>)`) and send
  (`Driver send #seq <kind> (<reason>) to <rid>: <send id>`) of the open
  attempt; `--json` has `halt?` and `runs?`.
- **Needs a parent ruling** (§12.5): `why` marks a needs-parent block on the
  current candidate `⛔ blocked #seq <obligation> (needs a parent ruling): …`
  until a ruling naming the node follows it, then `(ruled #<rule seq>)`; a stale
  needs-parent block (recorded on an earlier candidate) keeps the ordinary
  block wording. `status` lists current-candidate blocks of open attempts still
  awaiting a ruling under `Blocked (needs a parent ruling):`
  (`⛔ <node>: blocked #seq <obligation> (needs a parent ruling): <note>; record
  owed rule --nodes <node> "<decision>"`; `--json` `needsRuling`, present only
  when non-empty).
- **Report**: `Driver halts` lists halts after `since` plus every still active
  halt, each marked `(active)` or `(cleared)` (shown only when non-empty;
  `--json` `halts`).

### 12.5 Actions (D4)

For identical `review`, candidate `evidence`, `approve` and `waive` retries,
see §8.3.3 (0.24, ID): no new append, successful `alreadyRecorded` response.
This does not make driver launch/send or external effects idempotent acts.

`decide` outputs `dispatch | launch | send | attest | rebase | merge | halt |
notify` actions per the policy table of the contract (first matching row per
open attempt, at most one action per node per pass; a halted attempt gets
only its asking notify from the slot rows, HA1; PR2 notices remain eligible).
Not per slot: while active attempts < `max` and total open attempts < `2 × max`,
ready nodes are dispatched in status order. An active attempt is an open slot
whose phase is not `accepted`; accepted merge-pending slots only count toward
the total cap. Same-pass dispatches reserve both capacities. The driver skips
nodes whose writes overlap an open slot (including accepted slots) and nodes that
need owner action. One reviewer run covers all of a candidate's review
obligations (review and closure-review); a node with derived review count > 1 gets
one run per required principal, each with the next attempt-global `n`
(`nextReviewerN`), so distinct reviewer ids.

In 0.16.1 (RR2), a carried reviewer run's verdict follow-up names the **current**
candidate, not C0. A review already recorded by that principal on the same
obligation key counts even if it predates the latest submit. The existing
one-verdict-follow-up-per-run-of-the-current-candidate rule is unchanged.
No ledger kind or field is added; replayed states and obligation keys are unchanged.
**Deferred (RR4, not implemented in 0.16.1):** stopping surplus reviewer runs
once review is satisfied requires a driver `stop` effect, which this release
does not add.

Merge order (0.20, DR1, supersedes MO2). Accepted open attempts merge in
transitive dependent weight order: number of unique not-merged nodes depending
on them, descending; ties use continuous `acceptedSince` oldest first, then id.
`resume --after` is a dependency wait, not a priority override. The single merge
slot takes the first eligible action; waits, halts, run state, measurements and
merge guards still apply. Other actions retain status order. While any candidate
is accepted, the driver starts no background trunk attest or unscheduled idle sweep,
and preempts only its own running trunk attest or unscheduled idle sweep
(`trunk attest aborted: preempted` / `sweep aborted: preempted`). Scheduled
0.24 sweeps continue alongside node work (§7.15b). External measurements and
node attests are not killed; required merge-guard measurements still run.

Acting on a current state (0.11, F1). A pass loads the ledger state
(seq S), then describes the runs; a run that records its entry and seals in
between is seen sealed by a state that lacks the entry. So every ledger entry
the executor records as the result of `decide` — `launch`, `send`, `rebase`,
`halt`; not `dispatch`, not measurements, not a re-send of a recorded send, not
the halts that record a dsa answer (rejected, conflict) or a merge refusal —
passes `since: S` to ops (`ops.launch/send/rebase/halt`). Under the ledger lock,
before appending, when an entry with seq > S names the node (its `node` or
`subject`, a ruling whose nodes include it or are `*`, or any `plan` entry) and
its `by` is not `parent:drive`, the op records nothing and throws
`OwedError` code `stale`; for a send the dsa call is not made either. The
driver reports outcome `stale` (`--json`: `{"do":…,"outcome":"stale"}`; never
a halt, never a wake) and the next pass decides again on the new state.
A re-send of a recorded send (row 4: no new entry) decided on S is checked too
(0.12, G3.3, `ops.planChangedSince`): when a `plan` entry with seq > S removed
the node from the plan or changed its spec, nothing is sent and the outcome is
`stale` as above (plan entries name no node, so this compares the node's spec
before and after each later plan entry). Should `stale` (or 0.12's `version`)
ever reach the CLI or the `owed drive` exit code, it is a refusal: exit 1,
stderr `Stale: <message>`, never `Internal error`/exit 3 (0.12, G3.1).
Compatibility: owed < 0.11 cannot replay a ledger with a `send` of reason
`verdict` (its reducer refuses the unknown reason). owed < 0.12 cannot replay
a ledger with an `abandon` of a node the current plan removed (older reducers
reject `Node <id> does not exist`). 0.12 adds no entry field or
reason; other 0.12 ledgers remain replayable on 0.11.

Verdict follow-up (0.11, F1.2). Rows 13-14: a sealed driver reviewer run of the
current candidate whose obligations are still awaiting (no review by its slot
principal on the candidate's keys) first gets, after the `interrupted`
follow-up of row 13 when that applies, ONE follow-up with reason `verdict`:
`You finished without recording your verdict on candidate <commit> (submit
#<seq>) of <node>.`, `Still awaiting from you: <obligations>.`, then per
obligation `owed review <node> --obligation <o> --candidate <commit12> --as
reviewer:drive-<node>-<attempt>-<k> --ok|--block --rank <N> --note "<why>"`.
The `review-missing` halt follows only when such a follow-up was sent to the run
for this candidate and it sealed again without recording (the reason then ends
`… on candidate #<seq> after verdict follow-up <send id>`), or at once for a
run sealed `rejected` or `pruned` (a follow-up cannot reach it).

Environment back-off (0.11, F2.2). In the attest rows (9-10) an `error`
observation whose note starts with `environment: ` (§7.13) does not count
toward the two errors of "attest recorded no verdict twice". Per measured item
(subject, obligation, key) its streak is the run of consecutive environment
errors at the end of its observations since the latest resume of the attempt;
when an item's streak has n >= 1 entries, the node's next attest waits
1, 2, 5, 10, then 30 minutes (n = 1, 2, 3, 4, ≥ 5) after the latest such error
of all its items. While it waits the action is a notify `<node>: environment
failure #<seq> <obligation>: <note>; attest waits (<n> in a row), retry at
<ISO>; …` with `once: "environment\u0000<node>\u0000<first seq of the
streak>"`: the executor prints it once per streak. A non-environment error ends
a streak (and counts as before); a resume starts it again. `decide` stays pure:
the clock is `DriveOpts.now` (the executor passes `Date.now()`; absent: no
back-off).

Review blocks that need a parent ruling (D18, D18b). Once the candidate is
measured (after the attest rows) and before any repair — the measured repair
included, so no repair carries an undecided contract — if any review block on
the current candidate has `needs: 'parent'` and no ruling naming
the node (`--nodes` includes it; a `*` ruling is general guidance and does not
count) has a seq above the block's, the action is a halt needing `human`:
`review asks: <ask> → owed decide <node> --text "<ruling>" --writer`
(one clause per such block; extraction and presentation are in §9.2).
With a repair already outstanding the ruling reaches the writer with the
following repair or the re-review. No repair follow-up is sent and none is
counted. That node-named ruling also clears the halt (§12.3); the block is then
repaired as usual, and every repair message lists, first (0.7; before 0.7 after
the review notes), the rulings covering the node recorded after the dispatch (`Rulings since
dispatch:` with `- #seq text`); the note of a needs-parent block quotes its
ruling (`ruling #seq: text`), also when that ruling predates the dispatch (a
block from an earlier attempt). The re-review acknowledges them through
`ack_rulings` as before.

Repair before re-review; one message to the writer (0.6.0, G3). While a
review block is active on the current candidate's key (and the node does not
need the owner), the driver sends its repair before launching any reviewer run
of that candidate: the reviewer-launch row does not fire, so no reviewer judges
content the repair replaces (the attest rows, the needs-parent halt and the
measured repair keep their order before it). When the writer is sealed without
a current candidate (a plan change invalidated it, or a rebase) and an active
review block recorded in this attempt on the key of its latest submit does not
await a parent ruling, the driver sends one follow-up instead of the `submit` /
`rebase` one: reason `repair` (counted against `repairs`; exhausted → halt),
the rulings in scope since dispatch (and those quoted by needs-parent blocks)
first, then the blocks with their notes, then why a new candidate is needed
(`The plan changed since that candidate…`, or `Trunk moved…` with the `git
rebase --onto` instructions), then `commit, and run owed submit <node>`. Its
`rulings` records what it carries, so no separate ruling steer follows. A writer
that finishes it without submitting halts. Identical content resubmitted keeps
the block current: a second repair (or the exhausted halt), never a reviewer
run. The `submit` and `rebase` follow-ups list the undelivered in-scope rulings
first (`Parent rulings for <node> (apply them; they override your packet):`,
`- #seq text`) and then record `rulings` (0.7); a repair message starts with
its `Rulings since dispatch:` block. Before all of this, when an active block on the key of
that latest submit still awaits a parent ruling, row 8 halts with the
needs-parent halt text (also when no block is repairable): a repair, rebase or
submit follow-up would make the unruled block stale and let a re-review bypass
the parent question. The remaining row-8 behavior follows §12.5.4.

Rebase or resubmit in row 8 (0.10, N1.4). Without a current
candidate, the `rebase` follow-up is sent only when the slot has a rebase and no
submit of this attempt came after it. Otherwise, when a later plan entry
invalidated the latest submit of the attempt (its spec, `setup`, `exec` or
`closure` changed and it was not carried), the `submit` follow-up names that plan
entry: `plan #P changed this node's spec (<fields>); resubmit (re-run checks if
needed, then \`owed submit <node>\`)`, with `<fields>` the changed node fields
(not `type`/`drive`) and then `setup`, `exec`, `closure`. A writer that finishes
it without submitting halts as for any submit follow-up (counted from the plan
entry). Before 0.10 a writer that had rebased and submitted got a second
`rebase` follow-up after such a plan change.

Repair budget, rulings to a sealed writer, threshold hint (0.7, K5).
- **Budget epoch.** `repairs` counts the attempt's `repair` sends after the
  node's epoch (`repairEpoch`): the latest of the attempt's dispatch, the latest
  ruling naming the node (`--nodes` includes it; `*` does not count) and the
  latest plan entry that changed the node's spec (canonical, ignoring `title`
  and the node's `drive`; `brief` counts, because the parent fixed the task).
  Both repair rows (the candidate repair and row 8's resubmit repair) use it.
  The halt says `repairs exhausted (<k> of <n> since ruling #s | plan #s |
  dispatch): <cause>`. So after fixing a plan mistake, or to let the writer
  continue, the parent records a ruling naming the node: it gives a fresh budget
  and is delivered (the next repair or follow-up carries it). A ruling meaning
  "accept the content as is" is the owner's waive, not a repair.
- **Ruling follow-up.** When the writer run is sealed and an in-scope ruling
  naming the node (not only `*`) is above its *delivered* (§12.5.1), the driver
  sends one `follow-up` with reason `ruling` in place of the `finished …
  without submitting` halts and the `repairs exhausted` halt. Never
  while a reviewer run of the current candidate is unsealed, and (at these two
  halts and at row 18) never when the current candidate has no active block and
  no failed item: the ruling then reaches the reviewers (steer, the `rulings`
  obligation and `ack_rulings`), and a block's repair carries it.
- **A ruling before any halt (0.8, L3.1).** A due ruling also comes
  before every other halt of the node: the owner-needed notify (`ownerNeeded`,
  e.g. a flaky block or a rank ≥ 2 review block), row 7 (writer sealed non-ok:
  a ruling recorded after a failure is often the answer to it) and the
  `stalled:` halt. Conditions: the writer run is sealed, no reviewer run of the
  current candidate is unsealed, an undelivered in-scope ruling names the node,
  and no active needs-parent review block sits on the keys of the current
  candidate (else the latest submit); such a block keeps its D18 route. For
  owner-needed and row 7 the follow-up goes to the writer. At the `stalled:`
  point it goes to the writer when the candidate has a failed item, an active
  block on its keys or a flaky block; when its only debt is `rulings` (every
  reviewer run sealed, so no steer can reach one) it goes to a reviewer, since
  only a reviewer's `ack_rulings` discharges `rulings`: a `follow-up` with
  reason `ruling` to the latest driver reviewer run of the candidate (`New
  parent rulings for <node>:`, the undelivered rulings, then `Re-review the
  current candidate <commit> (submit #<seq>) in their light and record your
  verdict with --ack-rulings <latest>; block if the writer must change
  something.`), or, when the candidate has no driver reviewer run, a reviewer
  launch (row 12; its packet lists every ruling in scope and records
  `rulings`). Its ok with the ack makes the candidate acceptable; its block
  takes the repair path, which carries the ruling to the writer. A node without
  a `review` or `closure-review` obligation has no reviewer to ack and halts
  `stalled:` as before. Each is sent once (*delivered*); if the node still
  needs the owner, or the run finishes without a verdict or candidate, the
  notify or halt follows as usual. The slotless ready-node notify of `decide`
  is unchanged (the next dispatch packet carries the ruling). Message: `New parent rulings for <node>:`, one
  line `#<seq> (<nodes>): <text>` per undelivered in-scope ruling, then `Active
  blocks on your candidate <commit> (submit #<seq>):` with `- #<seq>
  <obligation>[ by <who> rank <r>]: <note>` for the active blocks on the current
  candidate's keys (else the latest submit's), then (0.8, L3.1) `Flaky blocks of
  <node> (an attribution rerun of the failing content passed):` with the full
  same-key failure/pass pair for every non-held flaky block (§9.9), then
  `Apply these rulings; they
  override your packet. Then commit and run \`owed submit <node>\`.`. `rulings`
  = the highest seq it lists. It is not a repair (not counted). A writer that
  finishes it without submitting halts as before, naming it: `writer run <rid>
  finished ruling follow-up <send> without submitting a new candidate
  (<cause>)`. dsa rejecting this follow-up halts the attempt in the same pass;
  row 4 later applies the supersession rules (SR1). Ruling steers retain their
  never-halt exemption (D22.3).
- **Threshold hint.** On the measured repair path, for a check X among the
  measured items: when the node's latest two failing, non-attribution
  observations of `check:X` both exited 0 with `counts.fail` 0 and the same
  `counts.tests`, below X's current `min_tests`, and no ruling naming the node
  was recorded after the later one, the driver halts (needs `human`; the parent
  decides) instead of repairing: `check <X>: <tests> tests ran and passed twice,
  below min_tests <m>; the plan's threshold may be wrong: fix the plan (owed
  plan) or rule (owed rule --nodes <node> "…")`. The first under-count still
  gets a repair (the writer may have to add tests). After a ruling naming the
  node the repair path runs again, with the fresh budget and the ruling carried;
  a plan fix changes the check's key and the writer resubmits.
- **Evidence in halts.** The `repairs exhausted` and `finished … without
  submitting` halts of a measured cause list, after `measured block <obligation>
  [#…]`, each failing observation that decides it as `#<obs> <obligation>:
  <note>` (one line, at most 200 characters; the note falls back to `exit
  <code>`), joined by `; `.

Owner approval and manual evidence (D23). After the rows above (attest, needs
a parent ruling, measured repair, reviewer launches, review-missing, review
blocks), when every unsatisfied item of the candidate is `approve` or
`evidence:<id>` and the node has no active or flaky block, the action is a halt
needing `owner` while `approve` is pending, else `human`, with one clause per
item: `awaiting owner approval of candidate <commit12>: owed approve <node>
--candidate <commit12> [--note TEXT] (owner)`, `awaiting manual evidence
evidence:<id> (<what>) by <role>: owed evidence <node> <id> --file <path> --note
"<what was checked>" --as <role>:<id> --candidate <commit12>` (0.6.0: the open
candidate's commit, G1.3). It also halts while the writer still runs; it never halts for them
earlier. The owner's approval or an evidence entry clears the halt (§12.3); the
driver then halts again for what remains or merges. An owner block on `approve`
is an owner decision (`ownerNeeded`: notify only). The review packet describes
`approve` as the owner's and an evidence item by its role; for `by: reviewer`
it gives the reviewer's `owed evidence` command.

#### 12.5.1 Rulings reach running calls; run names; answer address (D22)

- **Rulings carried (E4, 0.5.1).** The driver computes `rulings` while it
  builds a message, from the same state, and records it on the entry: a writer
  launch the in-scope rulings of its dispatch packet (recorded before the
  dispatch), a reviewer launch every in-scope ruling (its review packet), a
  `repair` send the rulings since dispatch and the rulings quoted by
  needs-parent block notes; the highest seq, 0 when none. A re-launch copies the
  recorded value. So a ruling recorded between `decide` and the append is not
  counted as carried and is steered afterwards. Replay refuses a value that is
  not an integer ≤ the entry's seq naming 0 or a ruling covering the node. A
  0.5.0 reducer refuses these entries (unknown `rulings` on a launch, `rulings`
  on a repair): a ledger written by 0.5.1's driver needs owed ≥ 0.5.1.
- **Delivered rulings.** For each drive-launched run of the open attempt (the
  writer and the reviewer runs of the current candidate), *delivered* = the
  highest in-scope ruling seq (`--nodes` names the node, or `*`) the run already
  has: the max of `rulings` on its launch entry and on every send to it that
  records `rulings` (`repair`, `ruling`, and since 0.7 `submit` and `rebase`
  follow-ups; also an unconfirmed ruling send), and for the writer
  its dispatch `rulings_seen`. A ruling counts as delivered to the writer once a
  writer send that carried it is recorded. 0.7: a send dsa
  rejected delivered nothing to the writer: the driver reads dsa's request state
  of the attempt's recorded sends each pass (`describe --key <send id>`; cached
  once terminal) and leaves the rejected ones out of the writer's *delivered*
  when it composes a writer follow-up (submit, rebase, repair, ruling), so that
  follow-up carries their rulings. The ruling steer row still counts a rejected
  steer (it is never sent again as a steer). Entries without the field (written by
  0.5.0) fall back to the 0.5.0 position rule: a reviewer launch carried the
  in-scope rulings recorded before its entry, a `repair` send those recorded
  before it (D22.4a), a writer launch `rulings_seen`.
- **Ruling steer (D22.2, D22.2a).** This existing later-pass route remains in
  addition to 0.20's immediate rule/answer notification (§12.5.2), which stores
  no delivered-send/ack metadata. The lowest row of the table: used only where
  the node would otherwise get no action — row 18 (`fenced` first), the wait for
  a live reviewer run of the candidate behind a stale block, and a running
  writer with an outstanding repair. The first run in state `running` (never
  `asking`, `queued` or sealed; the writer, then reviewers by `n`) with an
  in-scope ruling above *delivered* gets a `steer` with reason `ruling` and
  `rulings` = the highest seq it lists: `New parent rulings for <node>:`, one
  line `#<seq> (<nodes>): <text>` per undelivered ruling (text on one line),
  then for a writer `Apply these rulings; they override your packet. If you
  already submitted, fix and submit again.`, for a reviewer `Judge the candidate
  against these rulings and record your review with --ack-rulings <seq>.`. Still
  at most one action per node per pass; every other row wins, so a steer waits
  a few passes at most. Only `fenced` steers count as the last steer of the
  fenced row, so a ruling steer never hides a fence.
- **Rejection (D22.3).** dsa rejecting a ruling steer (e.g. the call sealed
  meanwhile) is printed (`rejected — <reason>; not retried as a steer (the
  writer's next follow-up carries these rulings; reviewers get them through the
  rulings obligation)`) and never halts; a recorded ruling steer dsa reports
  rejected is skipped by the re-send row and never sent again as a steer. Its
  rulings are not delivered (above): the writer's next follow-up lists them;
  reviewers acknowledge with `--ack-rulings`. A rejected ruling *follow-up*
  halts at once, like other follow-ups (SR1 can supersede it later). An
  unconfirmed ruling send is re-sent like any send (same id, stored bytes).
- **Obligation unchanged (D22.4).** A steer is not an acknowledgment: the
  `rulings` obligation still needs the reviewer's `ack_rulings`.
- **Run names (D22.5).** New launches carry dsa's run option `name` in the spec
  (`run --spec -` accepts it for the single-call form, pi-durable-subagents
  1.0.27): `owed <node>#<attempt> writer` / `owed <node>#<attempt> reviewer <n>`
  (`runName`), next to the labels. A re-launch of a recorded launch sends its
  stored spec bytes unchanged (a launch recorded before 0.5.0 has no name).
- **Answer in one act (0.13, AN1–AN3, app §65; 0.16 AR, dsa 1.0.38 re-asks).**
  `owed answer <node> [--qid Q] [--rid R] [--rev N] "<text>"` (pi
  `owed_answer {node, text, qid?, rid?, rev?}`) is a parent or owner act; the driver
  never answers. It describes the writer and reviewer launches of the node's
  current open attempt and selects one open question. With one matching
  question, qid may be omitted; qid may repeat across runs, so rid
  disambiguates. When a matching question is open, its current rev from dsa
  describe wins, even if `--rev` names an old rule; history never supplies that
  rev. With no matching open question, `--rev N` retries a prior rule at
  rid+qid+N; without `--rev`, the latest prior rule for rid+qid is retried.
  The rid may be found from current-attempt launches when history identifies
  exactly one run. Without such a prior rule, "No matching open question"
  refuses; ambiguity lists all open questions (role, rid, qid, rev and text)
  and records nothing. A describe failure refuses rather than selecting from
  incomplete results. `--rev` / tool `rev` must be a positive integer,
  otherwise a usage error.
  Under one ledger lock it records one `rule` naming the node,
  `writer: false`, text `Answer to <role> question <qid>: <text>`, and
  `answer: {rid, qid, rev}` (nonempty ids, positive integer rev). The rid must
  name a launch of that node's current open attempt. It then sends dsa
  `kind: answer` to the rid with qid, the described rev, the original answer
  text and request id `owed-answer-<rule seq>`. No candidate is invalidated.
  Identity is rid+qid+rev. Same identity and text reuse the entry, including
  concurrent retries; different text refuses and names the rev. A higher-rev
  re-ask records a new rule and request id even when its answer text is identical.
  That rule carries `supersedes: <seq>` of the latest
  prior answer rule for the same rid+qid. This field is required exactly when
  such a prior rule exists, absent otherwise, and must name that latest rule
  with a lower rev; ordinary rules cannot carry it. An explicit rid/qid retry
  works after the question disappears or the slot closes. Use `--` before
  answer text beginning with `--` (the retry command always includes it). Any delivery
  failure reports the recorded seq and an exactly shell-quoted retry command
  including `--rev <recorded rev>`;
  the rule remains. Dsa deduplicates the stable send id and returns its first
  outcome. **AR1 (0.30):** after successful delivery, `owed answer`,
  `owed decide` and their tools describe the asking run once per run, bounded
  to 10 seconds and outside the ledger lock. Each delivered answer prints
  `answered <node> <rid> qid <q8>: <state>`; the state is `running`, `queued`,
  `asking (answer not yet taken, qid <q8>)`, `asking again (qid <q8>)`,
  `sealed (<status>)` or `unknown (<reason>)`, taken from the answered call's
  phase/status and its open questions, never another call in the run.
  **R-030-AR-1:** only the selected question's `to = <wid>/<key>` identifies
  the call; a run address or the only remaining call cannot substitute for it.
  A retry uses a recorded question/answer address if available. Current ledger
  answer references retain only `rid/qid/rev` and no original ask, so a retry
  without a selected open question reports `unknown (call not identified)`.
  With an identified call, any matching question lacking a nonempty string
  qid, or a call lacking a string phase, reports
  `unknown (malformed describe reply)`. The same qid still open reports
  `asking (answer not yet taken, qid <q8>)`; only a different qid reports
  `asking again (qid <q8>)`. Describe failures also report `unknown` and never
  resend the answer. JSON/tool results add runtime-only
  `answers: [{node, rid, qid, rev, request, state}]`; these facts are not recorded
  in the ledger. **SB4:** answer adds one more line only when the ruling also reached other running calls
  (`the ruling also reached <n> other running call(s) (<node>/<role>, …)`) or
  failed to reach one (`the ruling did not reach <who>; retry exactly: <answer
  retry command>`). The answer and follow-up texts are never echoed. Nothing is rolled back and no separate `send` entry is appended.
  The answer is delivered to its target rid: no ruling steer or ruling
  follow-up includes it for that run. Earlier undelivered ordinary rulings
  are still delivered; an answer never advances the delivery watermark past
  a gap. Other runs (reviewers and later attempts) receive it as a normal
  ruling. Delivery does not discharge `rulings`: reviewers still acknowledge.
  Driver QN coverage remains revisions <= the recorded answer rev: q@2 after
  a q@1 answer is an open question, not an "answered #" quiet line.
  Compatibility: owed < 0.13 refuses a rule with `answer` with code `version`
  (the unknown ruling field rule of 0.12, §5). Owed 0.15 and 0.16 share a ledger
  until the first re-ask answer (a rule with `supersedes`); after that every reader
  needs 0.16. The new field makes 0.15 refuse with code `version` and an upgrade
  message, not a misleading invalid-entry error. Historical states and keys
  are unchanged; there is no new entry kind.
- **Answer address (D22.6, updated by AN1).** The asking line (notify, drive
  output, wake-ups) prints one line per open question with role, rid, qid,
  rev and question text, followed by `owed answer <node> --rid <rid> --qid
  <qid> "<text>"` and `owed_answer {node, rid, qid, text:"…"}`. The dsa call
  address remains visible as ` (to:"<wid>/<key>")`, falling back to the rid.
  The row-5 notice ends with `This records one answer ruling and delivers it
  to the asking run; reviewers still acknowledge it.` (`askingRule`).
- **Call address in halts (0.8, L1.4).** `RunView.to` is dsa's call
  address `<wid>/<key>` of the run's call (the latest one when describe lists
  several), present only when describe reports both a wid and a call key
  (never a bare wid). Every halt reason that names a writer or reviewer run
  (`writer run <rid> sealed …`, `… finished … without submitting …`,
  `review-missing: reviewer run <rid> …`, `dsa rejected run|send <id> …`,
  `cannot re-launch|re-send …`, a run or send request-conflict) adds ` (to:"<wid>/<key>")`
  after the run or send id when it is known, the same `to:"…"` form as the
  asking notice (`toArg`); an asking question without its own `to` falls back
  to it, then to the run id, and an asking run without a reported question
  reads `<role> run <rid> (to:"<wid>/<key>") is asking (no question reported; …)`.
- **Waiting (0.8, L1.5).** Each pass logs, per waiting node (§12.3 Resume), the
  quiet line `waiting: <node> waits for <dep> (resume #<seq>)` (`--json`:
  `{"event":"waiting","node","after","resume"}`; `PassResult.waiting`); the
  loop prints it once per node and resume, `--once` and `owed_drive` every
  pass. It never wakes a session.

### 12.5.2 Model receipts, live rulings and rebase drift (0.20)

**DR3 actual models:** submit/review accept `--model MODEL` (pi `model`),
storing optional actual model fields on those existing receipts, never a
second launch. Without an explicit model ops inspect the recorded dsa launch
before taking the ledger lock; latest listed `calls[].model` takes precedence
over top-level `model`. Failed status leaves the field absent. Stale review
candidate/attempt discards stale metadata. Already-written entries are not
rewritten/supplemented; unknown models stay explicit. Selected model comes
from launch spec model or array's first entry.

**MD1 (0.20.1):** selected direct models and recorded used models compare by
`provider/id`, ignoring only the trailing `:thinking`; ids with multiple slashes
(e.g. `proxy/ide/gpt-6.1-sol`) are preserved. A selected name resolves through
dsa `pools` in `$DSA_HOME/config.json`, default
`~/.pi/durable-subagents/config.json`, including nested pools and
`{model, afterMs}` entries. Any discovered member, including fallback models,
is a match. Unknown, empty, cyclic, malformed or partially unresolved pools
cannot prove a mismatch; a discovered member in a valid branch still matches.
Unmatched used models warn only for fully known pools; otherwise why shows
`selected <name> (pool membership unknown)`. Unreadable/malformed config and
missing launch selection blobs are unknown, not guessed mismatches. Pools are
read from current local config when rendering, not snapshotted in the ledger;
this changes no dsa routing or fallback behavior.

**MD2:** actual same-model identity also ignores thinking. Unacknowledged
warnings suggest an independent model or `drive.same_model: accepted`.
Acknowledged warnings are hidden in compact why, restored by `why --full`
with `(acknowledged)`, and retained in JSON `modelWarnings` as
`{message: string, acknowledged: true}`; unacknowledged warnings remain strings.
Selection mismatch warnings remain visible. JSON consumers must handle both
shapes. Why's model warnings (§9) never affect gates or introduce evidence.

**DR4 live ruling delivery:** after rule append and lock release, a
non-prospective rule inspects named nodes' current writer/reviewer calls,
notifying each running/asking call once with the writer ruling follow-up packet
(or ordinary ruling packet). Answer also notifies other running roles; its
selected asking call gets the existing dsa answer, not a duplicate ruling
notify. Future/sealed/queued roles receive the next dispatch/follow-up packet.
Notifications acknowledge nothing, create no send entry and do not themselves
invalidate candidates. Prospective policy behavior is unchanged.

Rule text receipts use §9.3's delivery counts and forwarding guidance. Rule
results add optional `delivery: {delivered:string[], pending:number,
failures:string[], slots?: {node, writer?, followUp}[], finished?: {node, writer}[]}`;
answers add the same as `rulingDelivery`. A known non-running/non-asking writer
adds the recorded-but-not-sent-now receipt line; rule never starts its
follow-up. Pending counts applicable non-running launches
and required not-yet-dispatched roles, skipping merged nodes. Request id is
`owed-rule-<seq>-<rid>-<sha256(exact message body)[0:12]>`: identical bytes
are idempotent, changed bytes produce a new request, avoiding request-conflict
on answer retry after intervening rules. Delivery failures are reported with
no retry loop and no ledger change beyond the rule. A failed target answer
preserves all other-role delivered/failed results and its exact retry command.

**NY7 Git drift:** on each pass the executor supplies actual worktree ancestry.
0.23 first attempts eligible executor rebase (§7.25); the following writer
route handles slots it cannot take over or whose rebase conflicts.
The driver sends one existing `send` (`reason: rebase`) follow-up per attempt /
slot base, preserving durable retry ids/bytes and existing owner/wait/question/
report priorities. Rebase packets say `First commit your work, then run:
git rebase --onto <new base> <upstream>`; never instruct stash. Upstream is the
newest recorded slot base of this attempt ancestral to HEAD, falling back to
`git merge-base HEAD <trunk-at-dispatch>`. **SB2 (0.22.1):** trunk commits
already in HEAD (a merge of trunk or a rebase onto it) are never replayed: when
`git merge-base HEAD <new base>` descends from that upstream, it is the upstream,
so the command replays only the node's own commits. The same command appears in
the `owed rebase` packet, every driver follow-up naming a rebase (drift, rebase
and repair follow-ups, also when HEAD already descends from the new base) and
the SB1 refusal; it changes only the command text, never when a follow-up is due. Follow-ups retain allowed-writes,
conflict, rerun/commit and `owed submit <node>` instructions. No new ledger
field records this Git fact.

### 12.5.3 Repair follow-ups (0.25, QT; 0.26, NT)

A writer repair details only failures recorded since the latest non-refused
repair follow-up to that writer's run: failing measured items include new test
names/notes, and new active review blocks include the reviewer's note.
Ruling steers, report/rebase/interrupted follow-ups and refused sends do not
move this boundary; before the first repair, every failure is new. Earlier
obligations still failing are named together as `Still failing from before`;
when none are new it says `No new failures since my last message.`
Rulings since dispatch still come first. The next step is to fix in the slot,
commit and `owed submit <node>`; owed reruns checks itself. The message links
`owed why <node> --full` rather than embedding the full card. Interrupted
reviewers also use `--full` to inspect recorded review evidence.

The driver rebuilds refused sends after restart from retained halt reasons,
current and once-rotated driver reports, and durable runner request receipts.
A refused repair does not move the findings boundary; a delivered repair does.
Recovery is bounded by retained evidence: if every refusal receipt is removed,
old refusal cannot be inferred. All binding failures remain in the full receipt.

### 12.5.4 Stopped writers and decision questions (0.26, WS)

A successful sealed or pruned writer is waiting while its latest described call
lists nonempty `awaiting` durable runs, including repair and ruling turns of a
node with a current candidate. It receives no submit reminder, stopped-writer
halt or no-submit halt, including repairs-exhausted and pending-rebase no-submit
halts. Review, attest, merge and needs-parent routes are unchanged. Due repair,
ruling and rebase follow-ups are still delivered unchanged. Without `awaiting` (including
older runners), the usual stopped-writer rules below apply. A non-ok seal
retains its existing halt/recovery route; a halt quoting that writer adds
`; awaiting durable <request> (<state>)` for its outstanding durable runs.
When a durable wake opens a writer generation, owed recognizes that generation
as current even though owed did not send it. Older seals cannot finish it or
cause an owed follow-up to be delivered again.

Otherwise, a successful sealed writer without a current candidate receives a submit
reminder only when actual work remains. Outside ledger locks, after checking
the current runner generation, the driver inspects worktree HEAD and dirtiness.
In the ordinary row-8 path, the handed head is the latest submitted commit
when it follows the latest rebase (including an executor-rebased submit),
otherwise the current slot base. Clean HEAD equal to that head halts with
`writer stopped without a candidate`; no submit reminder is sent. A different
HEAD or dirty worktree can receive one submit reminder, then a halt if no
candidate follows. Missing inspection facts halt conservatively with
`cannot inspect writer worktree; no submit nudge sent`.

A plan-invalidated candidate still receives its plan-changed resubmit message,
even for the same clean commit; inspection does not suppress that route.
Existing repair/ruling follow-up halts and the one-reminder bound remain.
A writer interrupted with unknown tool outcomes retains the recovery route;
a non-ok writer halt retains its status/error and any abandon guidance.
The row-7 halt for a writer run sealed non-ok uses the same reply trailer
as a clean-stop halt: `writer says: "<final text>"` (or
`writer gave no final text`) followed by
`owed decide <node> --text "<ruling>" --writer`.

Stopped-writer halts record the cause, then `writer says: "<final text>"`
and `→ owed decide <node> --text "<ruling>" --writer`. All whitespace in the
run's final reply (`RunView.result`) is collapsed to single spaces. Replies
of at most 600 Unicode code points are quoted whole; longer replies quote
the first 200 and last 380 code points, joined by ` … `. Each cut retreats
to a nearby space within 20 code points when available, before JSON quoting
and control/bidi escaping. Omitted facts are appended outside the quote as
` (commits: <sha12>[, …]; durable: <id>[, …])`, with only nonempty parts,
at most three of each, ordered by first appearance and skipping fully shown
facts. Commits are 40-hex tokens or 7–40 hex tokens directly after
`commit`, `HEAD`, `head` or `\u63d0\u4ea4` (U+63D0 U+4EA4;
case-insensitive, optional colon/space);
durable IDs match the `01`-prefixed 26-character ULID form. Missing text says
`writer gave no final text`. Pruned runs retain a reply only while describe
still supplies it. Wakes, default why and status Needs-you show that reply and
the one decision command. Already-recorded halts are never re-rendered.
The parser uses owed's own final trailer, so commands inside the writer's
reply cannot replace the next action. The quote is context for the parent,
never a candidate, measurement or acceptance receipt.

Pending Git drift cannot leave a sealed writer silent after a rebase follow-up.
The existing question, owner, report and unresolved-review priorities still
apply. When that drift branch is reached and the writer is still running,
wait; for a sealed writer, send a due named ruling follow-up before any
stopped-writer halt. Otherwise inspect a **set of handed HEADs**: the last
submitted commit, or the original dispatch base when there is no submit, plus
`from` (pre-rebase slot base) of every later rebase of this attempt. This is
not the last observed writer HEAD. A clean HEAD in that set halts immediately,
naming the rebase follow-up and quoting the final reply. Missing inspection
facts also halt. A HEAD outside the set or dirty worktree can get one additional
submit reminder carrying the rebase instructions; sealing again without a
candidate halts, naming the rebase and reminder. The bound is counted after
the rebase follow-up and latest resume.

After a pending-rebase halt, `owed decide <node> --text "<ruling>" --writer`
records guidance and resumes. The next eligible pass delivers exactly one due
ruling follow-up before halting again. If a ruling follow-up is later than
both the rebase follow-up and latest resume, and the writer seals again
without a new submit, the halt names that ruling follow-up instead. This
check precedes HEAD/dirty inspection: even an unsubmitted commit outside the
handed set, or dirty work left behind, cannot trigger another submit reminder.
A refused ruling follow-up retains its rejection guidance. This is the same
finished-ruling boundary as the ordinary writer-halt path; no send/halt loop
or new ledger kind is introduced.

When the last described call reports `endedAtSeal`, halts quoting that writer
also append `; dsa ended <n> processes at seal: <pid> <command>[, …]` before
the decision command. The total includes unlisted `endedAtSealMore` processes;
at most three are listed with commands bounded to 80 code points and escaped
onto one line. This reports processes dsa sent SIGKILL at the seal, not proof
of what caused their death. Older runners omit the diagnostic.

Writer dispatch packets include this section immediately after the checks:

    Long runs: processes you start end when your turn ends. Run a check or measurement that may outlive your turn as a durable command call, then end your turn without submitting:
      pi-durable-subagents run --request owed-<project>-<node>-<attempt>-<name> --wake caller -- <command…>
    owed does not halt you while it runs; dsa resumes you with its exit status and output tail (pi-durable-subagents >= 1.1.0).

Dispatch packets and writer follow-ups (rebase, repair, submit, plan-changed,
ruling, interruption and report) carry this sentence:
`If you need a decision outside your writes, ask the parent (your run waits): give decision_needed (one sentence) and numbered options (label, scope, cost, risk; mark one preferred), plus facts (commit, run id, log sha), what you tried, and candidate explanations with their evidence and what is unproven — as ask fields when your ask tool has them, else as text starting "Decision needed:". Never submit a candidate you believe fails its checks.`
Submit reminders also say:
`If you stopped for a parent decision, do not submit: ask the question instead.`
Runner questions without `decision_needed` keep the existing verbatim-question/answer flow.
For dsa structured asks, the asking notify and wake show
`<role> <rid> asks (qid <first 8 characters>, rev <n>): DECISION: <decision_needed>`
first, then `options: 1) <label> (preferred) — scope <...>; cost <...>; risk <...> | 2) ...`
(each supplied field at most 160 characters), an optional facts/tried/candidate-evidence
line (at most 600 characters), and `details: <question>` (one escaped line, at most
300 characters). The existing answer commands follow, with
`answer "option <n>; <limits>"`. Every question retains its own qid and answer command;
the driver never chooses an answer. Describe metadata is validated field by field;
malformed optional fields are omitted, not coerced into text. An invalid option
member drops the entire options field, so numbered answers cannot be silently
renumbered; invalid optional option properties are dropped independently. Multiple
preferred options lose all preferred markers. Invalid candidate members and
non-string facts/tried members are removed; empty candidate/facts/tried fields
are omitted (R-030-SA-2). Values are escaped
before clipping, retaining whole code points and control-character escapes.
Needs/status preserve the multiline structure when existing runtime answer-retry
text already contains a structured question. This does not add unanswered questions
to needs/status or change runtime cache membership (R-030-SA-1).
Writer/reviewer messages stay English.
Checks, reviews and merge gates are unchanged; old ledgers retain their replay
states and keys, and recorded message retries keep their original bytes.
Worktree facts can be unavailable, and pruned final replies may be lost;
no new idle-watchdog guarantee for writing without a live call is added.

### 12.6 Review packet (D5)

`reviewPacket(state, node, n)` (`src/views.ts`, pure) is the task of the
driver's reviewer run `n` (attempt-global, §12.3) on the current candidate; it
works before the launch entry for `n` exists (the driver builds the packet,
then persists the launch): node, attempt, candidate
commit (and submit seq), base, the plan title/brief, writes, every obligation
of the candidate with its required count/rank and current mark, rulings in
scope, the reviewer identity `reviewer:drive-<node>-<attempt>-<n>`, the exact
commands

    owed review <node> --as reviewer:drive-<node>-<attempt>-<n> --ok|--block --rank R [--obligation closure-review] [--ack-rulings S] --candidate <commit12> --note "..."

(`--candidate` names the reviewed candidate, §8 act binding: a resubmit during
the review makes recording fail; the line after the commands tells the reviewer
to re-read `owed why <node>` and review the new candidate then;
R = the diff-derived `min_rank` (§6.2a), at least 1, for `review`; 2 for `closure-review`;
`--ack-rulings S` with the latest in-scope ruling S when the rulings item is
owed; a rank above 2 is owner-only and the packet says the run cannot discharge
it), and the rules: inspect the actual diff (`git diff <base> <candidate>`), do
not edit files, record verdicts in the ledger, reply with seqs. Before the
commands it says: "If the brief or plan is ambiguous or contradictory, or the
fix needs a product or contract decision, record --block --needs-parent and
state the decision needed; do not push a guess onto the writer." (the command
lines themselves are unchanged). Before that line (0.6.1 H2.3) it says that
`--ok` means the candidate meets the node's goal as its title and brief state
it, not only that the writer's report or evidence is accurate, and that a
candidate or report saying the goal is not met is a `--block` (`--needs-parent`
when the goal itself is in question). The driver extracts an ask from review
notes for presentation (§9.2); the recorded verdict and needs-parent flag,
not inferred prose, control acceptance and repair routing.
`reviewRuns(state, node)` = `max(derived review count, 1 if closure-review is
required else 0)` runs per candidate (§6.2a); with `k = n - reviewerBase(state, node)`,
`reviewObligations(state, node, n)` = `review` while `1 ≤ k ≤ derived review count`,
plus `closure-review` for `k = 1`. A run of an earlier candidate (`k < 1`) or
beyond the candidate's runs has no obligations, and `reviewPacket` refuses it.

### 12.7 Execution and surfaces (D6, D7)

`src/drive-run.ts` executes the actions of `decide` as principal `parent:drive`.

- **State loads** (0.16, DL1–DL4). Every driver load, including `stateOf`,
  measurement reaping/refusal handling and run-status reads, uses
  `ops.loadDriverState(ledger)`: the ops load path (§6) reads and verifies the
  entire ledger hash chain, resumes its in-process memo or disk snapshot and
  uses the persistent parsed-plan cache, refuses an uninitialized ledger, then
  applies `drive/reports.json` to the loaded private state. The result equals
  `reduce(entries, lookup)` followed by `applyReports`. At a cached replay
  point no full replay or historical YAML parse occurs; appended entries fold
  from that point. The in-process memo cadence stays `MEMO_EVERY=32`: after a
  short incremental load, a same-head reload may refold at most
  `MEMO_EVERY-1` (31) entries since the last memo replay point. Consecutive
  small increments fold at most the newly appended entries plus 31; crossing
  32 folded entries advances the memo point, so the following same-head load
  folds zero. The disk snapshot cadence is unchanged.
  A fresh process with a valid snapshot and plan cache
  parses no historical YAML. Corrupt or chain-mismatching snapshots fall back
  to full replay; ledger verification errors still throw and newly appended
  plans are applied. Reports and driver mutations never enter the serialized
  ledger-only memo/snapshot or another load; cached plans are deep-frozen and
  must not be mutated. No ledger kind/field, gate, key, lock, stale check,
  ruling, scheduling or idempotence rule changes. Incremental ledger hash
  verification and pass frequency are deferred. Derived caches are performance
  aids, not acceptance evidence.
- **Pass.** Load the ledger state; for every open attempt (including halted
  ones for questions, HA1)
  `describe --key` its live runs (the writer and the reviewer runs of the
  current candidate); for every recorded send this process has not confirmed,
  `describe --key <send id>` (`applied`/`rejected` are taken as dsa's decision;
  only an `absent`/`pending` send is re-sent); read the stored blobs a retry
  needs; `decide`; execute the actions in order. A failed describe leaves that
  node without an action this pass. (0.11, F4) A describe that timed out is
  retried once in the same pass before the `describe-failed` notify; a node
  waiting after `resume --after` gets no `describe-failed` notify. A failed
  send's report (outcome `error`, e.g. a ledger lock timeout) names the node,
  send kind, reason and target run like any other send line; its text line
  names the node as a word (0.12, G3.6: `send <kind> (<reason>) for node
  <node> to <rid>: error — …`). Nodes in phase
  `removed` (§6) are not described and do not keep the driver from `idle`,
  but an open slot of a removed node still counts toward `drive.max` until it
  is abandoned (0.12, G3.6: its writer may still run).
- **Persist before submit.** `launch`: `ops.launch` (idempotent on identical
  content) then `dsa run --request <rid> --spec -` with the exact spec bytes;
  `send`: `ops.send` (assigns the send id) then `dsa send --request <id>`; a
  re-send uses the recorded id and the stored message bytes. Outcomes: 0
  applied (the send id is remembered as applied); 1 rejected → `halt` needing
  the parent in the same pass, except rejected steers (SR3) and the existing
  ruling/waiting notice exemptions. A rejected steer records the refusal in
  `facts.refused` and returns outcome `rejected`, without a halt; next pass's
  row 4 applies SR1/SR2. Rejected follow-ups and notices keep their action-time
  behavior. 3 request-conflict → `halt` in the same pass (never retried with
  other bytes); 75, a timeout or a dsa child killed by a signal → pending,
  the next pass retries the same id and bytes.
- **A rejected run is fixed for its attempt (D15.1, unchanged).** The id and
  bytes of a recorded run cannot change, and dsa answers the same id the same
  way. The halt reason of a run rejection (exit 1, or `describe` reporting the
  run `rejected`) ends with "this attempt's request is fixed; fix the cause
  (plan, agent, model), then `owed abandon <node>` to start a new attempt".
  A ruling, submit or review clears the halt as any other, but the retry
  re-halts; abandon with a new attempt and new ids is the recovery.
- **Superseded rejected sends (0.16.1, SR1–SR4).** Row 4 skips a rejected send
  of the open attempt when a later ledger entry (seq greater than the send's)
  is a resume or submit of that same node/attempt, or another send of the
  attempt to the same rid that is not itself rejected. Confirmation as applied
  is not required for that later send. The superseded send is never re-sent,
  does not halt and does not block later rows. The existing rejected ruling
  steer, rejected waiting notice and ruling notice exemptions stay unchanged.
  Row 4 also skips a rejected steer (any reason, including `fenced`) whose run
  is sealed or pruned in this pass's view: sealed-run rows decide, so row 6
  sends `interrupted` to a writer sealed `unknown`, and rows 7–8 act as before.
  That later follow-up supersedes the refused steer for good. A rejected steer
  to a running/asking/queued run with nothing later still halts on the next
  pass; rejected follow-ups/notices without a successor still halt. Send ids
  and bytes remain immutable; no entry kind/field, replay state or key changes.
  The rejected-send halt ends with "the attempt is not lost: continue the run
  (e.g. a dsa follow-up), then `owed resume <node>`; a later resume, submit or
  send to this run supersedes this send; or `owed abandon <node>`". After that
  resume, row 4 does not re-raise the same rejected-send halt; abandon is last.
- **Verdicts are durable when they happen (D14).** The ledger (plus
  `describe`) is the only state that carries a decision across passes: every
  verdict (dsa rejection or conflict, merge refusal, attest error) is written
  in the pass that meets it, except rejected steers (SR3: decided next pass);
  nothing in memory decides a later pass. What the process keeps are caches of dsa's answers (send ids dsa reported applied,
  follow-up generations) and what the loop last printed.
- **Follow-up generations after a restart** (0.12, G3.2). What a follow-up
  lets the driver expect is derived from the ledger, so a restarted driver
  (or the next `--once` pass, e.g. the pi tool's) does not halt on a lagging
  sealed view: for a sealed or pruned view with a reported generation and no
  expectation in this process, the run's latest recorded follow-up `send` that
  dsa reports applied and whose generation this process does not know is sent
  again with the same id and stored bytes; dsa returns the first outcome.
  The applied reply is cached per send id (`sentGen`) once per process. Later
  entries naming the node (e.g. another reviewer's verdict) do not suppress
  recovery of this run's generation. The original reply
  names the generation it went into. When that generation is newer than
  the described one, the view is presented as `running` as below. A reply
  without a generation (forwarded into running work), another outcome or a
  failure leaves the view as described.
- **Follow-up generations.** A follow-up applied in this process returns the
  generation it started; until `describe` reports that generation (highest
  `calls[].gen`), a sealed view of the run is the previous generation's and is
  presented to `decide` as `running`, so a lagging describe never causes a
  second follow-up or a halt. dsa opens a generation only for a follow-up to a
  sealed call (the reply carries `generation`); one to a running call is
  forwarded into the running generation (no `generation` in the reply). When
  the reply has none (0.6.0, G3.6): if the run's last view observed in this
  process was running, asking or queued, no new generation is expected (the
  sealed view that follows is the follow-up's outcome); otherwise the driver
  expects the last observed generation + 1.
- **Conflicting files** (0.6.0, G3.7). For a rebased slot without a candidate
  whose rebase recorded a previous candidate, the driver computes `git
  merge-tree --write-tree --name-only -z <new base> <previous commit>` while
  observing, only when row 8 can use it (writer sealed ok, rebase after the
  latest submit, no rebase or repair follow-up since; `wantsRebaseConflicts`),
  and passes the conflicted paths to `decide` (`DriveOpts.conflicts`).
  The rebase follow-up and the rebasing repair of §12.5 then add `(files that
  conflict with your previous candidate: <paths>|none)` after the `git rebase
  --onto` command; the clause is omitted when git fails.
- **Attest** runs `pi-durable-subagents hold machine --shared --no-wait --
  owed attest <node>` in the main worktree when dsa is available (else `owed
  attest <node>` directly), subject to LE opt-outs (§7.14). The child gets
  `OWED_LEASED=1` while leased. The driver's merge also holds a shared lease
  with `--no-wait` through a holder child (§7.14 LE2).
  Exit 75 is hold refusing the lease without queueing anything (`owed attest`
  itself exits 75 only when the node's attest is already running or a lock wait
  timed out, §7.11): the machine is busy; the driver prints hold's message (the
  blockers) and retries next pass. A non-zero exit with a
  `pi-durable-subagents:` error on stderr and no stdout is dsa rejecting the
  invocation — on dsa < 1.0.27 `Unknown option --no-wait` — and halts the
  attempt needing a human (an attest error, not a busy machine). `owed attest`
  exits 0/4 are done (accepted / not accepted yet), 1 is measured failure/done,
  75 is busy; 2/3 or other errors, a signal or timeout halt needing the parent
  in the same pass, never silently re-attest (§8.3 PO5).
- **Background measurements** (0.7.0, K6). An `attest` or `merge`
  action starts a *measurement* and the pass goes on with its next action: an
  attest runs as a child process as above; a merge runs in the driver process
  (`ops.merge` with the driver's abort signal, never a child `owed merge`,
  which refuses `--as parent:drive`), not awaited by the pass.
  - A node is *in flight* from the start of its measurement until the loop has
    handled its result. `decide` receives the in-flight nodes as a set
    (`DriveOpts.measuring`) and gives them no action; the pass does not
    describe their runs. Every other node is dispatched, launched, sent to and
    halted as usual; an in-flight node's open slot counts toward `max` unless
    its phase is `accepted`, and always counts toward `2 × max`.
  - Caps: at most `drive.measure` measurements (default 2) are in flight, and
    at most one of them is a merge (merges of one trunk CAS each other). An
    attest or merge action over a cap is skipped this pass without output; a
    later pass decides it again. Actions start in `decide`'s order.
  - Start line: `{"do":"attest"|"merge","node":N,"outcome":"started",
    "at":ISO}` (text `attest N: started`), quiet for wake-ups.
  - Disk preflight (0.11, F2.3): before it starts the pass's first
    measurement, the driver reads the free space (statfs: available blocks ×
    block size) of the repository's git common dir and of `os.tmpdir()`. When
    one is below `drive.min_free_mb` (default 2048; 0 disables the check) it
    starts no measurement this pass and emits a repo-level notify (`scope:
    'repo'`, node `disk`) `disk low: <N> MB free in <path> < <M> MB[; …]; the
    driver starts no measurement until space is freed`, once per change of the
    low paths (and again after the disk was fine in between). It wakes.
  - Disk full (0.11, F2.4): an error escaping a pass of the loop whose code is
    `ENOSPC` or `EDQUOT` (or whose message says `No space left on device`,
    `Disk quota exceeded`, `ENOSPC` or `EDQUOT`) does not end the driver: it
    logs the event `{"event":"disk-full","error":…,"at":ISO}` (text `disk
    full: <error>; the driver sleeps 60 s and continues`), which wakes, sleeps
    60 s and continues with the next pass. Any other error still ends the loop.
  - A measurement that ends wakes the loop: its wait ends at once. The next
    pass first handles every ended measurement in the order they ended, before
    it loads the state, with the rules of this section (the report; an attest
    error halts; the merge refusals below), naming the attempt the
    measurement started on. Handling a result is progress.
  - Busy: an attest that ends `busy` (hold refused the lease, or
    exit 75 of `owed attest`: 0.7.0 K1, another attest of that node runs) is
    never a halt, not progress and does not wake the loop. Its line is printed
    when it ends (not deduplicated: every `started` line gets its completion
    line), and that node starts no measurement again before the loop's next
    timed pass (`passMs`) or event pass; passes triggered by progress or by
    another measurement ending skip it. Its text is `another attest of <node>
    is running, retry next pass: <owed's message>` for owed's exit 75 and
    `machine lease refused, retry next pass: <hold's message>` otherwise;
    owed's message (`attest of <node> is already running`) tells them apart
    through `hold`. A busy line no longer replaces an equal previous one.
  - Idle: a pass is idle only when no attempt is open, nothing is dispatched
    and nothing is in flight; a driver with a measurement in flight never
    exits `idle` and never logs `idle-wait`.
  - Restart: a driver that dies (SIGKILL, crash) leaves its attest children
    (own process groups) to finish; their observations land under D24 (§7.10).
    The new driver's attest of that node exits 75 and is retried later. An
    in-process merge dies with its driver (see the accepted window below).
- **Merge** refusals are acted on when the merge is handled: `rebase needed` →
  `ops.rebase` (the writer's `rebase` follow-up comes from a later `decide`);
  the transient `Plan, candidate or trunk changed; retry` (a new submit of the
  node or a ledger trunk move while merge measured, §6.4; a plan update alone no
  longer causes it since 0.7; merge recorded nothing) → retried next pass, no halt,
  not progress; trunk CAS drift (the ref moved during the merge) → the line
  `merge N: retry — merge refused (…); retry next pass` (0.7.0: it ends the
  measurement in the log) and the trunk drift notify below, retried next pass,
  no halt; K4 (§6.4) `not measured: …` (a key the plan update introduced; the
  measured observations were kept) → `merge N: retry — merge refused (…); retry
  next pass`, no halt, and the next pass merges again; K4 `slot of <n> changed
  (…)` and `candidate #S … was invalidated by plan #N …` → `merge N:
  superseded — merge refused (…); the next pass decides on the new state`, no
  halt (quiet: no wake); any other → halt needing a human.
- **Trunk drift** (0.5.1). 0.7.0: while a
  merge of this driver is in flight, or ended and not yet handled, the pass
  makes no drift check and no drift notify (its own merge may have moved the
  ref past the state the pass loaded); a real drift during that merge is
  reported by the merge's CAS refusal. The trunk ref no longer
  equal to the ledger trunk is a repository fact, not a node fact: 0.5.1
  drivers never record it as a ledger halt. Each pass, before merging, the
  driver compares `refs/heads/<trunk>` with the ledger trunk; on drift it
  merges nothing that pass (every other action continues) and emits one
  repo-level owner notify (node `trunk`, `facts` = the ledger trunk's seq):
  `trunk <name> moved outside owed (<ledger12> → <ref12>); the main agent
  resolves it with: owed adopt --note "<why>"` when the ref fast-forwards the
  ledger trunk, otherwise `trunk <name> was rewound or rewritten (<ledger12> →
  <ref12|missing>); restore it: git update-ref refs/heads/<name> <ledger>
  <ref>` (full commits; `""` for a missing ref). When the ledger's trunk commit
  itself is absent (0.6.0): `trunk <name>: the ledger's trunk commit
  <ledger12> is absent from the repository, so git update-ref cannot restore it
  and owed adopt cannot check a fast-forward from it; bring the commit back (git
  fetch <remote> <ledger> from any remote or clone that has it), then restore
  trunk (git update-ref …) or adopt the current ref (owed adopt --commit
  <ref12> --note "<why>")`. The report carries `scope: "repo"`; its print and
  wake records are keyed apart from any plan node (a node named `trunk` keeps
  its own). The loop prints it once per change and the follower wakes once per
  change; when a pass finds trunk equal to the ledger trunk again, the driver
  forgets the drift's print and wake records and logs the quiet event
  `{"event":"drift-cleared"}`, on which the follower forgets its record, so an
  identical later drift prints and wakes again. After `owed adopt` the next
  pass merges with no other act. A halt recorded for drift by a 0.5.0 driver
  (`merge refused: trunk changed (CAS)…`, needs owner) stays a ledger halt:
  adopt (or restore) trunk, then clear it with `owed rebase <node>` (the
  writer rebases and resubmits, then the driver re-attests and merges).
- **Stalled** (D12): the `stalled:` halt lists every non-E item and each
  active block as `#seq <obligation> by <principal> rank <r> on candidate #C`
  (`stale` instead of `on candidate #C` when recorded on another key; no rank
  for an execution block), so the owner can act without `owed why`.
- **Lock.** `<ledger dir>/drive.lock` (`.git/owed/drive.lock`): pid, process
  start time, host, written aside and hard-linked into place; stale when the
  pid is gone or reused; a live holder makes `owed drive` (also `--once`)
  refuse (exit 1). A lock of another host is never taken over: the refusal
  names host and pid; after checking that no driver runs there, remove the
  lock by hand.
- **Pi session** (0.5.1 E1, pi-durable-subagents 1.0.31). A driver's runs
  belong to the pi session that started it. On start (`owed drive`, `--once`,
  `--detach`, tool `owed_drive`) owed reads `DSA_SESSION` from its
  environment — ignored when `DSA_CALL` or `DSA_EXEC` is set (a subagent) or
  when it is not a session id as dsa 1.0.31 accepts it (starts with a letter
  or digit, then up to 127 of `[A-Za-z0-9._:-]`), as dsa does — and records it as `session` in `drive.lock` (absent when
  none). `--detach` passes the starter's value to the detached driver as
  `DSA_SESSION` (and removes an inherited one when the starter has none).
  Every `pi-durable-subagents run` the driver issues passes `--session <id>`
  when a session is recorded; the flag is not part of the request bytes, so a
  retry passes it again without a conflict. The dsa client removes
  `DSA_SESSION` from every dsa child's environment, so dsa never takes a
  session from it and the lock and what dsa records never disagree. A dsa that refuses the flag (older
  than 1.0.31: `Unknown or repeated option --session`, which records nothing)
  is detected once per driver: the run is repeated without the flag, later
  runs omit it, and the driver logs one line, `dsa does not accept --session
  (older than pi-durable-subagents 1.0.31): runs start without it and are not
  listed in pi session <id> (<refusal>)` (`--json`: event
  `session-unsupported`, quiet for wake-ups); never a halt. While a driver
  holds the lock (this or another host), `owed drive --status` (and tool
  `action: "status"`) adds after its first line `runs are listed in pi session
  <id>` or `no pi session: runs show only in pi-durable-subagents status / the
  CLI`, `--json` adds `session` when recorded, and the `/owed` driver line
  ends with `; ` and the same text. No driver running: no session line.
- **Loop.** Passes run back to back while they make progress (at most 20;
  progress = the ledger head advanced, dsa applied a request or an ended
  measurement was handled in the pass; starting a measurement is not
  progress), then the driver
  polls `events --all --since <cursor> --limit 100` every 3 s and runs a pass
  on an event labeled `owed: <project>`, when a measurement ends, or after 30 s. The cursor is
  `<ledger dir>/drive/cursor` (deletable); an expired (exit 4) or rejected
  (exit 1) cursor is reset to the head and triggers a pass; the limit halves
  only after a page the client could not parse and returns to 100 after a good
  page; other failures (e.g. a missing binary) are printed. In the loop a
  notify (asking run, owner-needed node) is printed only when its text
  changed for that node. (Before 0.7.0 a busy machine was too, compared
  without hold's ages; since K6 every busy attest follows its own `started`
  line and is printed, at most once per timed or event pass.)
  Exit 0 with `idle` when no attempt is open, nothing is dispatched and
  nothing is in flight. Stopping (0.7.0, K6):
  - *Stop* (the first SIGINT/SIGTERM of the loop, `owed drive --stop`,
    `owed_drive` action stop, `DriveOptions.signal`, and for `--once` the pi
    tool's abort signal): start nothing new (the current action finishes, the
    pass executes no further action), wait for every in-flight measurement to
    end, with no time limit, and handle their results as usual (reports,
    halts, rebases), then `stopped` (loop: and the exit record `stopped`).
  - *Stop at once* (a second signal in the loop, so `--stop --now`; the first
    signal with `--once`, D16.3), once per process: abort the driver's
    AbortController (an in-process merge stops before trunk moves and its
    checks get SIGKILL, D16a.1), SIGTERM to the running dsa invocations (hold
    forwards it to its `owed attest`) and to the process groups of direct
    `owed attest` children; then wait for the in-flight measurements to end, up
    to 5 s, and SIGKILL the groups still running, waiting up to 1 s more.
    Limit: the SIGKILL reaches the dsa invocations' and the attest children's
    process groups only. The checks an `owed attest` runs are in process
    groups of their own (§7), which that attest ends on its SIGTERM (§10
    Signals); a check whose attest was SIGKILLed before ending it keeps
    running, unrecorded, until it exits.
    Their results are not handled (the driver records nothing; `owed attest`
    records its own observations and ends the checks it started, §10
    Signals). Then the `killed` line, the exit record (`--json` loop), the lock
    released, exit 130. Further signals are ignored meanwhile. The ledger stays
    consistent.
  - `--once` (and the pi tool's pass) is one pass, then it waits for the
    measurements that pass started and handles them before it returns: its
    output ends with their completion lines.
  - A driver that ends with an error (the exit record `error`) aborts an
    in-flight merge as above and waits up to 6 s for it to end before it
    writes the exit record and releases the lock; attest children finish on
    their own (as after a crash).
  The pi tool's pass installs no signal handlers. Accepted window: a stop after merge's `git update-ref`
  and before its ledger append leaves trunk ahead of the ledger; the next pass
  sees the drift and emits the trunk drift notify (never silent; the owner
  adopts the merge commit). Each process group gets one SIGTERM per stop; the
  `owed attest` CLI treats signals within 1 s of its first as the same request
  (hold may forward the driver's SIGTERM while the group also gets it).
- **Surfaces.** CLI `owed drive [--once] [--max N] [--json]` (one line per
  action: `<action>: <outcome> — <detail>`; notify lines verbatim; `--json`
  JSON lines). `--once` is one pass. Pi tool `owed_drive` runs `--once` by
  default (`action` start/status/stop: §12.8; the tool's abort signal stops
  the pass after the current action) and returns the output of the actions already executed also when a later
  step throws (as a tool error);
  a long loop belongs in a terminal or a `systemd-run --user` unit (a forced
  dsa restart kills every process of the dsa call that runs it, including its
  attest). `/owed` status adds `Driver runs in dsa:` with each live run's dsa
  state when dsa is available.

### 12.8 Background driver and wake-ups (D17)

`src/drive-bg.ts`. A tool call never runs the loop; `--detach` makes it a
separate, durable process, and the session is woken by its log instead of
polling.

- **Start** (`owed drive --detach [--max N]`, tool `action: "start"`).
  Serialized per repository by the ledger lock `drive-detach`. A live lock
  (this host, pid and process start time match) or a lock of another host →
  refused, naming pid, host, start time and the log. Else
  `<ledger dir>/drive/log.jsonl` is rotated to `log.jsonl.1` (one kept) and
  `owed drive --json [--max N]` (`process.execPath` + `bin/owed.js`, as for
  the attest child) is spawned detached (own session and process group, stdin
  ignored, stdout and stderr appended to the log, cwd = main worktree root,
  environment inherited without `NODE_TEST_CONTEXT`, `DSA_EXEC` and `DSA_CALL`
  (the driver carries no dsa call identity; `DSA_HOME` stays), unref'd). When
  the starter has `DSA_EXEC`, the output adds `note: started from inside a dsa
  call; if that call's processes are contained, the driver may end with it —
  prefer starting it from a top-level session or systemd-run --user`. It keeps the
  `drive-detach` lock until the drive lock names the child pid (then prints
  `driver started: pid P, log <path>`) or the child exited, waiting up to 30 s
  (D17a.3). A child that exits first with an `idle`/`stopped` exit record is
  reported as started and already ended (the tool starts no follower then);
  without an exit record or with an `error` record → refused with the last log
  lines (exit 1). No lock after 30 s → SIGTERM to the child (pid and start time
  checked), refused with the log tail (exit 1).
- **Exit record** (`--json` loop mode only, not `--once`): the last line is
  `{"event":"exit","code":C,"reason":R,"at":ISO,"error"?:text}`, R ∈ `idle`
  (after the `idle` line), `stopped` (after `stopped`), `killed` (the second
  signal path writes it before `process.exit(130)`), `error` (drive threw or
  the lock refused; `error` is the message, code = the CLI code 1/2/3, and
  `drive()` returns that code instead of throwing). The record is written
  before the drive lock is released (D17a.2), so a released lock implies the
  record. Signal handlers are installed before the lock is taken (D17a.6); a
  signal while starting stops the loop at its first check (`stopped`). Only
  SIGKILL or a crash leave no exit record. Text mode and `--once` are unchanged.
- **Text of a JSON line.** `reportText(json)` (drive-run.ts) is the text-mode
  line of an action report or a loop event; `Driver.emit` prints it in text
  mode, and status and wake-ups render log lines with it (a line that is not
  JSON is shown escaped).
- **Status** (`owed drive --status [--json]`, tool `action: "status"`): reads
  the lock and the log only (creates nothing): `driver running: pid P on H
  since T`, a lock of another host (not checked), or `driver not running`
  (`; it ended without an exit record (killed or crashed)` when the log has
  driver lines but no exit record; an empty log adds `no driver output yet`); `last exit: R (exit C) at T[: error]` from the log; the log
  path and its last 10 lines as text. Exit 0. While the driver runs (0.7.0,
  K6) it lists the in-flight measurements read from the log: each `started`
  line after the last exit record with no later line of the same action and
  node, as `measuring: <node> <attest|merge> since <at>` after the first
  lines (`--json`: `measuring: [{node, do, since}]`, present only when
  non-empty).
- **Stop** (`owed drive --stop [--now]`, tool `action: "stop"`, `now`): no
  live lock → `no driver running` (exit 0, nothing created). Otherwise under
  the `drive-detach` lock, graceful stops (`owed start --restart`, `owed drive
  --stop` without `--now`) signal each driver process (pid + start time) at
  most once. Before signaling, owed atomically writes `drive.lock.stop-request`
  under that lock, recording pid, start, host and token. A request for another
  process is stale and replaced; repeated graceful stops only wait. A lock of
  another host, or one without a process start time, refuses. SIGTERM targets
  only the still-matching pid/start (never a reused pid). `--now` retains the
  immediate-stop behavior: with no prior request it sends a second SIGTERM
  1 s later if the lock is still held; with a prior request it sends the extra
  SIGTERM immediately. Graceful requests never escalate to that path. Waits up
  to 10 s for the lock to be released: `stopped`, else `stopping: pid P exits
  after its current action and its in-flight measurements` (§12.7 Stopping).
  Exit 0.
- **Flags.** `--stay` (§12.9) only with the loop or `--detach`. `--detach`, `--status`, `--stop` and `--once` exclude each other;
  `--now` only with `--stop`; `--max` not with `--status`/`--stop` (it stays
  valid with `--once`); `--json` with any. The tool refuses `now` without
  `stop` and `max` with `status`/`stop` (usage).
- **Wake-ups** (src/extension.ts, `DriveWatch`/`Follower`). After a tool
  start (in any session), the follower reads the fresh (rotated) log from its
  start; on `session_start` of a session not inside a dsa call (`DSA_EXEC` and
  `DSA_CALL` unset, D17a.1), when the repository of `ctx.cwd` has a live lock,
  from the log's size at that moment (no replay). Every top-level pi session
  opened in the repository is therefore woken. A log replaced by rotation
  (other dev/ino, or shorter than the offset) is read from 0 (D17a.4). Every 2 s (unref'd timer) it reads the
  complete lines appended since. Wake lines: `do: halt` (not with outcome `stale`, 0.11), `do: notify` (asking
  runs, owner-needed, describe failures), outcomes `rejected`, `conflict`,
  `refused` and `error` (refused merges and attest errors also halt), event
  `events-error`, `disk-full` (0.11), terminal events `exit`, `killed`, `stopped`, `idle`, and any
  line that is not a JSON report. `cursor-reset`, dispatch, launch/send
  applied, attest, busy and pending are quiet; `merge` `merged` does not wake
  alone and is listed in the next message. All wake lines of one read form one
  `pi.sendMessage({customType: "owed-drive", display: true, content},
  {triggerTurn: true, deliverAs: "followUp"})`. Its plain summary replaces
  raw node report text (§12.8.1, §12.8.3): Needs-you lines first, then carried
  merges folded into `Done: <nodes>`, then `Driver continues (<n> in progress)`
  or `Driver stopped: <reason>`, followed by `owed drive (<repo>):` and any
  remaining payload/repeat lines. With at least one halt it adds exactly
  `To clear a halt without an obligation: owed decide <node> --text "<decision>"
  (add --after <node> to wait until that node merges; --no-resume keeps it halted)`.
  A resolved-wake count, when present, precedes the last line,
  `Next: owed status / owed why <node>`. The plain needs replace the original
  raw node lines rather than echoing them. Identical wake lines within one read collapse.
  One wake per new fact (E3.1, replacing D17a.5's "every halt line wakes"):
  the driver adds to every node-scoped wake line (halt, notify, describe
  failure, outcomes rejected/conflict/refused/error) `facts`, the node's fact
  mark = the highest seq of ledger entries naming the node (`node`, an
  observation's `subject`, a ruling listing it) not written by `parent:drive`
  (0 when none; the driver's own launches, sends, halts, dispatches, rebases
  and merges are not new facts, writer/parent/reviewer/owner entries and
  executor observations are). The follower keeps per node the text (without a
  repeat suffix) and fact mark of the last wake it took for delivery; a line
  with the same text and a fact mark not higher is a repeat: it does not wake,
  and it rides along with the next message as `<text> (repeat n, no new ledger
  entries)` (only the latest repeat per node). A changed text or a higher mark
  wakes. Lines without `facts` (an older driver, non-JSON lines) wake as
  before. In the loop the driver itself marks such a line `repeat: n` (text
  suffix ` (repeat n, no new ledger entries)`) when it equals the node's last
  printed wake in text and fact mark, and a notify is printed again when its
  fact mark rose even if its text did not change. A re-halt after a writer
  resubmits, or after a ruling, wakes (the clearing entry is a new fact). If
  `sendMessage` throws, the batch is kept and retried next tick (D17a.8). It stops after a read with a terminal line, or when the pid is
  gone without one (`driver pid P ended without an exit record`; liveness is
  checked before the read, so nothing the driver wrote is missed). One
  follower per driver log (repository) per extension instance; a new start
  replaces it; `session_shutdown` clears every timer (the driver keeps
  running).
- **`/owed`** appends `Driver: running pid P since T` (0.7.0: then `;
  measuring <node> <attest|merge> since <at>[, …]` while measurements are in
  flight), `Driver: not running
  (last exit R at T)`, `Driver: not running (ended without an exit record)`,
  `Driver: not running (no driver output yet)`, `Driver: not running`, or for another host `Driver: lock held by pid P on
  host H since T`.

### 12.8.1 Notices (0.15, QN)

- **Answered questions (QN1).** The driver checks ledger answer rules before
  reporting an asking run. A rule with the same `answer.rid` and `answer.qid`
  covers open revisions no newer than `answer.rev`. Covered questions are
  omitted from the question text and its structured selectors. If all are
  covered, the driver logs `<node>: answered #<seq>, waiting for the run to
  resume`, with runtime outcome `answered` (quiet, no ledger write or wake).
  Delivery revalidation also drops question wakes covered by an answer rule,
  even if dsa still reports `asking` or describe fails.
  `drive.answer_grace_s` is an optional integer in seconds (0..900),
  default 600 (0 means immediately); it is not part of any obligation key.
  The answer-grace wake and answered-but-asking presentation share this grace
  (§12.8.4). If the covered question stays open for that long after the rule's
  ledger timestamp, the driver wakes once per `(rid, qid)` in that driver run:
  `<node>: answered at #<seq> (HH:MM), still asking after <m>m: retry with
  <answerRetry command>`. The command retries the
  original answer bytes and request, without recording another rule. This
  runtime notify carries `answerRetry: true`; delivery checks that its question
  is still open but does not drop it merely because it was answered.
  Compatibility: `answer_grace_s` requires a 0.15 plan parser; older owed
  rejects it as an unknown drive key. QN adds no ledger entry kind or field.
  Plans without the field retain their 0.14 canonical shape and keys.
- **Earlier drivers (QN2).** JSON loop log lines carry `driver: {pid, start?,
  at}` (process identity and lock start time), including terminal events
  `stopped`, `exit`, `killed` and `idle`. At delivery the follower reads the
  repository driver lock again. When a different, newer live driver owns it,
  the old terminal line does not wake alone or stop the follower. It rides
  along with the next wake as `earlier driver (pid P, started T) <event>;
  driver pid Q (started U) is running`. Held terminal lines and explicit
  follows of a replacement driver preserve that ride-along. A terminal line
  of the current owner, or with no live owner, wakes as before. Legacy lines
  use the identity of the follower that read them.
- **Plain wake text (QN3).** A message starts with one line per affected node,
  `Needs you: <node> — <decision in words> → <one command>`, followed by
  `Done: <merged nodes>` when present, then `Driver continues (<n> in progress)`
  or `Driver stopped: <reason>`. `inProgress` on action log lines counts open
  slots and supplies the status count. The current plain renderer (§12.8.3)
  keeps each question/reason and its command once, without a repeating
  `Details:` block or raw node lines. Identifiers remain when required by an
  action; the report payload, repository notices and resolved-wake count stay.
  `Next: owed status / owed why <node>` is always last. These fields
  are runtime log metadata only, not ledger data; JSON tool outputs retain
  their existing fields.

### 12.8.2 Idle watchdog (0.22, WD)

`owed idle [--json]` assesses a repository without starting a driver or changing
the ledger. Exit codes are 0 idle, 3 successful not-idle, 2 usage (including a
missing ledger), and 70 internal error; other error categories keep their normal
codes. Idle text gives one plain sentence, at most five node states with exact
status next commands, and the last-progress time. JSON adds reason, progress
and whether subagent activity is known. CLI polling suits cron/systemd and does
not claim a pi wake marker.

All conditions must hold: ready work, an open submitted/accepted/blocked or
rebase-pending attempt, or active next action exists; no live background driver;
no held ledger/merge/trunk-refresh/adopt lock or machine measurement holder;
no running/asking durable-subagent call labelled `node` for an unmerged plan
node; and last ledger progress is older than `drive.watch_idle_min` minutes.
This nonnegative integer defaults to 15; 0 disables it. It is independent of
`drive.idle_rewake_min`. Foreign/unreadable lock owners count as busy; dead local
owners are ignored without removing files. Missing subagent tooling leaves call
activity unknown and age plus other conditions decides. Installed tooling with
failed machine-holder inspection conservatively prevents a wake.

Top-level pi sessions watch repositories used through owed tools and initialized
repositories containing their initial cwd. Every 120 seconds the watchdog
assesses them, never waking a running agent. Writer/reviewer subagent sessions
do not automatically attach. Delivery rechecks latest progress and sends the
CLI's plain text as an `owed-idle` follow-up with `triggerTurn: true`.
An atomic create of `owed/watch/idle-<last progress sequence>` under the Git
common directory (or configured `OWED_DIR`) permits one wake per host/repository/
idle period across sessions; new progress permits a new wake. Restarting pi does
not repeat an old delivered period; rejected delivery releases its claim.

No ledger kind or measurement key changes. Absent watchdog keys preserve old
plan shape; older versions reject the new drive key. Upgrade CLI, driver and
plugin together. Snapshot/crash/label limits are in §7.17.

### 12.8.3 Plain wake lines (0.25, QT)

Each ordinary need is `Needs you: <node> — <what is needed> → <one command>`,
not the raw driver line. Every open question gets its own line, question text
and answer command: one sole question may use `owed decide`; several require
`owed answer` with selectors. Each command is parsed from that question's own
trailing answer clause; command-like `answer: owed ...;` inside the question
remains question text and cannot replace its action.
Reported nodes give `review the reported findings → owed decide <node> --text "<decision>"`, followed by the report's
last 40 lines (at most 4000 characters). Repository notices, including shared
failure, trunk red/drift and sweep notices, retain their full text and every
line under Needs you; reducing them to one line would lose nodes or remedies.
Quiet text never drops a need or the content needed to act on it.

Carried merges collapse to `Done: <nodes>`. Needs come before driver
continues/stopped state and `Next:` stays last. Raw driver lines and detailed
receipts remain inspectable with driver status/logs and `owed why --full`;
seq/key/lease/candidate identifiers are not echoed in ordinary need summaries
unless needed in a command or an actionable condition. Done lines do not
replace the per-node merge receipt (§8.3.4).

### 12.8.4 Answered but still asking (0.25, QT)

After the same `drive.answer_grace_s` as QN1 (default 600 seconds, ten minutes;
a plan may choose another integer from 0 through 900), a ledger-answered
question still open at the runner reads `<node>: answered at #<seq> (HH:MM),
still asking after <m>m: retry with owed answer <node> --rid <rid> --qid <qid>
--rev <rev> -- <text>`. The exact retry retains the original
bytes/revision/request; it is not a new unanswered question or decision.
Clock text is local.

The wake and Needs-you line use this wording. `owed status` obtains its line
from the driver's runtime cache and shows it only while a driver runs; it
vanishes when the run resumes or the slot closes. It adds no ledger entry or
receipt JSON field. Without a running driver, inspect the runner/answer
receipt directly; absence of this status line is not proof of delivery.

### 12.9 Live wakes, staying driver and ready hint (0.6.1, H1)

- **Live wakes (H1.1).** Cause (app, 2026-10-10): the parent read a question
  from the drive log and answered it; the follower had already handed its wake
  to pi as a `followUp` while the agent was busy, and pi delivered it after the
  answer. Rules:
  - (a) The pi extension tracks the session's agent (`agent_start` …
    `agent_settled`, and `ctx.isIdle()` of the latest event context). While it
    runs, the follower keeps reading and holds the batch; it never hands a wake
    to pi then. At `agent_settled` (every follower steps at once) or at the next
    tick while idle, it revalidates the batch and delivers what is left with
    `triggerTurn` as before. If the agent became busy again during the
    revalidation, the batch stays held (revalidated again at the next delivery).
  - (b) Revalidation runs on every pi delivery (also for a batch read while
    idle), on wake lines only; merges and repeat ride-alongs stay pending. The
    asking notify of the driver carries the structured fields `rid` (the launch
    rid), `qid` and `rev` of the run's FIRST listed open question (fields of the
    log line, not ledger fields; the text is unchanged, it may list several
    questions). Such a line is dropped when `describe --key <rid>` no longer
    lists that qid/rev as an open question, or (0.15, QN1) when a ledger answer rule
    covers its rid/qid/revision. A failed describe keeps it unless an answer
    rule already resolves it. Answered questions are omitted by the driver,
    so its selectors name the first unanswered open question. When the first
    of two questions is answered, the held line is
    dropped and the next pass prints the line of the remaining question, which
    is delivered. An asking line without a reported question carries `rid` only
    and is never dropped by describe. A node-scoped line with a fact mark is
    dropped when the node's current fact mark (`factMark`) is higher: someone
    acted on the node, and a condition that still holds is reported again by
    the driver's next pass with the new mark. A failed ledger read keeps it.
    Only a scoped trunk-drift notify (`scope: 'repo'`, node `trunk`) is dropped
    when the trunk ref equals the ledger trunk commit now, or when the ledger
    trunk seq is higher than the line's `facts` (QT2: adopt/merge happened).
    Failed ledger/ref reads keep the line. Unscoped lines are never dropped as
    drift: legacy drift lines are delivered as before, while a plan node
    named `trunk` follows normal node fact/question revalidation.
    A still-current drift is delivered, and dropped drift lines count in (c).
    Status and brief show no drift when trunk equals the ledger trunk commit.
    Terminal lines follow QN2's current-owner check; `idle-wait` and other
    lines without a fact mark are never dropped. The ledger, trunk ref and each run are read at most once per delivery.
    A dropped wake that is still its key's latest record (E3.1) also drops that record's repeat ride-along, and later repeats
    of it do not ride along (they are as stale); a new fact of the node wakes.
  - (c) If lines were dropped, Details includes the line
    `(<n> wake(s) resolved before delivery)` (before the final `Next: …`), counting only
    that delivery's drops; the count is not carried over. If no wake line is
    left, nothing is delivered and the session is not woken; merges and repeats
    ride along with the next message as before. A failed `sendMessage` keeps
    the whole batch (revalidated again next tick).
  - (d) CLI mode and a follower without the pi hooks still use `tick` without
    question revalidation; QN2 ownership checks and QN3 rendering apply to both paths.
- **Stay (H1.2).** `owed drive --stay` (loop, or with `--detach`; not with
  `--once`, `--status`, `--stop`: usage error) and `owed_drive` action start
  `stay: true` (refused with other actions) are opt-in. When a pass is idle a
  staying driver logs `{"event":"idle-wait","at":ISO}` once per idle period
  (text `idle: nothing open and nothing ready; staying until the ledger
  changes (owed drive --stop ends it)`); an idle period ends with a pass that
  is not idle. `idle-wait` wakes the session; it is not terminal. The driver
  keeps the lock and waits until the ledger head (the hash of the last entry
  of `ledger.jsonl`, read from the file's end every `pollMs`) differs from the
  head the idle pass decided on (`PassResult.head`, that pass's state), then
  resumes passes; an entry appended during the idle pass (e.g. a plan update)
  is such a difference, so the next pass runs at once; a ledger change that leaves it idle
  starts no new period (no second line). A stop or signal ends it as before
  (exit record `stopped`). `--detach --stay` passes `--stay` to the detached
  driver; the lock does not record it. `owed drive --status` adds after its
  first line `idle, waiting for ledger changes since <at>` (`<at>` local time, SB5;
  `--json`: ISO `idleSince`), `/owed` adds `idle, waiting for ledger changes since <at>; `
  before the session text, and `owed_drive` status shows the status text:
  while the driver runs and its log (after the last exit record) has an
  `idle-wait` followed by no action line other than a notify. Without
  `--stay` an idle pass exits `idle` as before.
- **Ready hint (H1.3).** After a successful `owed plan` / `owed_plan`, when the
  new state has nodes the driver would dispatch now (the `dispatch` actions of
  `decide` on that state: readiness, `drive.max`, writes overlap, owner-needed)
  and no driver holds the repository's lock (a live lock or a lock of another
  host counts as a driver; a stale one does not), the output adds one line
  (before the H2.2 check-less warnings; pi appends the CR brief after them):
  CLI `ready: <ids> (<n>); no driver is running: owed drive --detach --stay`,
  pi `ready: <ids> (<n>); no driver is running: owed_drive {action:"start",
  stay:true}`. `--json` output and the tool details gain `ready: string[]` and
  `driver: false` only together with the line. Nothing starts automatically; a
  failure computing the hint adds nothing.
