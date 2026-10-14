# 0.20 node `measure`: remeasure on the same key and native quarantine (MS1–MS5)

SPEC sections affected: §3 (plan: check/invariant fields, downgrades), §5 (keys), §6 (merge guard, aggregation of
observations), §7 (executor: counting, notes), §8 (CLI attest/resume), §12 (driver: resume, merge), pi tools
`owed_attest` and `owed_resume`, status/brief/report/why views.

## New fields and plan keys (complete list)

| Where | Field | Meaning |
|---|---|---|
| plan: invariant and node check | `quarantine: [{test, fix, note?}]` | exact failing test names excused while `fix` is a plan node that has not merged |
| ledger `obs` (optional) | `quarantined: string[]` | names excused in this observation |
| ledger `resume` (optional) | `remeasure: true` | the driver remeasures failed merge-tree invariants before its next merge |

No new entry kind. A ledger and plan without these fields replay exactly as in 0.17 (same states and keys). An older
owed refuses a ledger with `obs.quarantined` or `resume.remeasure` ("needs a newer owed"): upgrade every driver, CLI and
pi plugin together.

## MS1 remeasure on the same key

- `owed attest <node> --remeasure [--all]`: builds the node's current merge tree (trunk + candidate), and, under the
  shared machine lease and the node's attest lock, measures again every invariant whose latest observation (with a
  verdict) on the merge key failed (`--all`: every invariant). The new observations are recorded on the SAME key with
  `merging: <node>`. Nothing is invalidated. They are recorded only if trunk, plan and the node's slot did not move.
  Output first line: `Remeasured on the same merge key: inv:<id> #<seq> <verdict>, ...`, or
  `Nothing to remeasure: no merge-tree invariant of <node> failed on its current key (--all measures every one)`,
  followed by the receipt.
- `owed attest --trunk --remeasure [--all]`: after the usual refresh, measures again the current trunk invariant keys
  whose latest trunk observation failed (skipping keys this call just measured). First line:
  `Remeasured on the same key: inv:<id> #<seq> <verdict>` or
  `Nothing to remeasure: no trunk invariant failed on its current key (--all measures every one)`.
- Usage errors: `attest --all requires --remeasure`, `attest --remeasure does not take --rerun or --genesis`.
- Aggregation is unchanged without `repeat`: pass and fail on one key is the ⊤ owner conflict.
- With `repeat {runs: N, need: K}` (parent ruling 10-15): every run of every non-error observation on the key is pooled
  (an observation without `runs` counts as one run). The item passes iff `passes*N >= K*total_runs`, else it fails
  (never ⊤). Item detail (why/status) when more than one observation is pooled:
  `pooled <p>/<t> runs on this key (need <K>/<N>)`, e.g. `inv:x satisfied; pooled 6/9 runs on this key (need 2/3)` or
  `inv:x current content failed; pooled 3/6 runs on this key (need 2/3)`. A single observation decides as before.

## MS2 resume --remeasure

- `owed resume <node> --remeasure [--note TEXT]` records `remeasure: true` on the resume entry. Not allowed on a hold
  release (`hold release does not take --after, --expect or --remeasure; ...`).
- The driver, on its next merge of that node, first runs MS1 (`attest <node> --remeasure`) inside the same machine
  lease, then merges. It does this once per such resume: the remeasure is due while no merge-tree observation of the
  node and no halt of the node was recorded after the resume (`remeasureDue`). A busy attest lock is the usual busy
  retry; other refusals are left to the merge.
- pi tool `owed_resume`: new parameter `remeasure: boolean`. pi tool `owed_attest`: new parameters
  `remeasure: boolean` and `all: boolean` (with `trunk: true` for the trunk form).

## MS3 "reused" in merge refusals

When the merge guard refuses on failing merge-key invariant observations recorded before the current call, the refusal
ends with
`reused #<seq> (same merge key, measured <age> ago); measure again: owed attest <node> --remeasure` (CLI/ops merge),
or `...; measure again: owed resume <node> --remeasure` when the driver merges (so its halt reason says it). Several
reused observations: `reused #a (...), reused #b (...); measure again: ...`. `<age>` uses the brief's format
(`45s`, `3m`, `2h5m`, `1d2h`).

## MS4 native quarantine

- Plan: `quarantine: [{test: "<exact failing test name>", fix: <node id>, note?: "<why>"}]` on an invariant or a node
  check; at most 20 entries, unique `test`, non-empty strings, no other keys. Error when `fix` is not a node:
  `invariants: <inv>: quarantine fix <id> is not a node of this plan` / `<node>: check <id>: quarantine fix ...`.
  `quarantine` is an editable check field (`owed edit --invariant ID --set quarantine=<yaml>`, and in node check edit paths).
- Downgrade (owner only; no allow rule covers it): adding an entry or changing its fix:
  `inv:<id> quarantine "<test>" added with fix <fix> (owner only)` (node `trunk`), or
  `check <id> quarantine "<test>" added with fix <fix> (owner only)` (the check's node);
  `... fix changed from <old> to <new> (owner only)`. Removing an entry is free.
- Active while `fix` is a node of the current plan and not merged; when `fix` merges (or leaves the plan) the entry is
  inactive with no plan edit. On `fix`'s own merge its entries are already inactive (the merge result is measured as
  if it had merged), so the fix must make the test pass.
- Keys: the check/invariant key includes the sorted active names (`quarantine` field of the hashed key object, absent
  when there are none, so the key equals 0.17's). The fix merging, or a plan change of the entries, changes the key and
  forces a fresh measurement (a trunk refresh on the next `attest --trunk`/merge).
- Executor: a run whose failing tests all equal active entries exactly does not fail: the excused tests count neither
  as passed nor failed (`counts.tests`/`fail` exclude them, so `min_tests` sees the rest), the observation records
  `quarantined: [names]` and its note ends `quarantined: <name> (fix: <node>)[, <name> (fix: <node>)]`. Required: the
  run completed (no timeout, signal, spawn error, exit 124/126/127/137/143) and its counts name every failing test
  (`fail` = number of distinct names, from TAP / cargo / owed-counts). A crash, timeout, non-TAP failure or any other
  failing name still fails. Excuses apply only when the job's key commits to exactly the excused names (recomputed by
  the executor), so a stale key without them can never pass by an excuse. Not applied to red or mutants runs.

## MS5 views

- `owed status` (Debt section), `owed brief` (Debt) and `owed report` (`Debt (quarantine)`) list each active entry:
  `quarantine <inv>/<test> until <fix> merges` (node checks: `quarantine <node>/<check>/<test> until <fix> merges`).
  JSON: report `quarantine: string[]`; status/brief through `summary.debt`.
- `owed why <fix>`: `merging <fix> lifts quarantine: <inv>/<test>, ...` (receipt field `lifts`).

## Deviations / interpretation choices

- MS1 remeasures merge-tree invariants only (not merge-tree node checks), as the contract says.
- Quarantine also on node checks: active names join the candidate's check key at submit; a merge-tree check key is
  computed fresh at merge time. An open candidate's stored check key is not recomputed when a fix merges.
- `attest <node> --remeasure` runs only the remeasure jobs (no ordinary attest jobs in the same call).
