# 0.23 node `measure023` — MX: measure what changed

## `owed report --metrics` (MX1, MX3)
New fields (JSON) and one text line each:
- `decisions`: parent acts counted once per decision. Entries that share a `decision` id (one `owed decide`), a
  `resume` batch, and a legacy amend pair (a plan entry and the ruling `writes of <node> widened by plan #<p>: …`
  that names it) are one decision. `actsPerDecision` = parent acts / decisions.
  Text: `Decisions: <d>; parent acts per decision <x>`.
- `parentActs.mergedOnly` `{total, perMergedNode}`: parent acts whose every target node merged in the window (acts
  with no node target, or touching any unmerged node, are excluded).
  Text: `Parent acts on merged nodes only: <n>; per merged node <x>`.
- `interruptions.byClass`: driver halts in the window by class `shared`, `trunk-red`, `fix-wait`, `review`, `writes`,
  `no-submit`, `repairs-exhausted`, `attest-error`, `other`, classified from the recorded halt text only (ruling
  #2572: `--metrics` never replays state). Each halt also carries `interruption`. Answers are not classified;
  `byClass` sums to `interruptions.halts`. Text: `Halts by class (recorded text): …; state-based classes: owed
  report --counterfactual`.
- `latency.phases` `{measure, review, mergeWait}` (samples, median, p90, max) for nodes merged in the window, from
  the ledger alone: measure = the merged candidate's submit → its last node measurement on that commit; review =
  that measurement → acceptance (the last measurement, review, waiver, defer or evidence on the candidate); merge
  wait = acceptance → the merge entry. A carry submit of the same commit does not restart the phases.
  Text: `Phases of merged nodes: measure median …, p90 …; review …; merge wait …`.
- `latency.leaseWaitMs`: the `lease_wait_ms` values (MX3) of obs and merge entries in the window; one text line
  `Machine lease wait: median …, p90 … (<n> samples)` only when any entry carries it. Each entry counts, so a
  command that recorded several observations counts several times.
The existing 0.16–0.22 fields keep their values.

## `owed report --counterfactual [--since seq|ISO] [--json]` (MX2)
Replays the recorded driver halts through the 0.23 classifiers and prints totals per class and per merged node
(`--json`: every row with seq, node, attempt, reason, class, the parent-act seqs, `saved`, the rebase it saw, merged).
- Classes, on the state just before each halt: `trunk-red` (trunk-red park, TP, or FS3(b)), `shared` (FS3 shared
  park), `fix-wait` (FS5: the park has an accepted fix candidate), otherwise `clean-rebase` / `unknown` when the
  parent rebased the node before its next driver action (ER): the previous candidate merged onto the new base with
  `git merge-tree --merge-base <old base> <new base> <candidate>` without conflicts is `clean-rebase`, a conflict is
  `unchanged`, a missing commit or a failed check is `unknown`; everything else `unchanged`. A park needs every
  failing merge-tree check of the candidate to be absent (a failing merge-tree node check is a mixed refusal).
- Acts: parent and owner acts that target the halted node, from the halt until the node's next driver action (any
  driver or executor entry on that node, including a merge-tree measurement or merge). For shared, trunk-red and
  fix-wait every such act counts as unnecessary; for a clean rebase every act except the rebase itself.
- Read-only: no ledger lock, no measurement, no write (no replay snapshot or plan cache is written; the trees
  `merge-tree` produces go to a temporary object directory). At most 200 merge-tree checks per report; beyond that
  rows are `unknown`.
- Before the replay it prints one line on stderr:
  `replaying <n> entries to classify <h> halts (cold; about one full replay)`.
- `--counterfactual` and `--metrics` are exclusive; `--until` stays a `--metrics` option.

## Measurement entries: `lease_wait_ms` (MX3)
`obs` and `merge` entries recorded inside a leased measurement carry `lease_wait_ms`: milliseconds from the start of
the command's machine-lease request until the lease was granted (the wait before the command started). Every
observation and merge entry of one leased command carries the same value. Absent when no lease was taken
(`--no-lease`, plan `lease: false`, no pi-durable-subagents, an inherited lease).

## Compatibility
- New optional field `lease_wait_ms` on `obs` and `merge` entries: a non-negative integer, validated on replay
  (anything else refuses the entry). Owed before 0.23 refuses an `obs` carrying it (needs a newer owed); it ignores
  the field on `merge`. Keys, verdicts and gates do not read it. Old ledgers replay unchanged.
- No new entry kind, plan key or ledger field besides the one above.
- Metrics JSON gains `decisions`, `actsPerDecision`, `latency`, `parentActs.mergedOnly`, `interruptions.byClass` and
  `halts[].interruption`; existing fields are unchanged.

## Known limits (ruling #2572)
- `--counterfactual` is one cold, validating replay of the whole ledger: its time is about one full replay without
  a snapshot. On the app ledger (14.4k entries, 578 plans, 397 driver halts): a plain replay took 47 s on the
  test host (profile: state refresh of node items 25 s, plan downgrade analysis across the 578 plans 14 s, entry
  validation 12 s); the command took 60–98 s on that shared host, while `owed status` (tail snapshot) took 2.2 s.
  A per-halt cache or a faster reducer is deferred.
- On that ledger it reproduces the diagnosis: 25 halts `shared` (among them #13276, #13287, #13345, #13388, #13411,
  #13515, #13528), 3 `fix-wait` (#13632, #13641 and one earlier), 3 `trunk-red` (TP halts), 28 `unknown` (their
  commits were not in the replay repository) and 338 `unchanged`; 37 of 537 parent acts after those halts would be
  unnecessary.
- `--metrics` does not replay: its interruption classes come from the halt text, so a pre-0.23 AT1 halt that was a
  shared failure counts as `other` there; `--counterfactual` gives its state-based class. `--metrics` itself
  costs what it cost before (about 40 s on app, dominated by the existing per-plan act classification).
- Phases are derived from ledger entries, not from a replayed acceptance state.
- Changed existing tests: `test/metrics.test.ts` (three `interruptions` deep-equals now ignore the new `byClass`)
  and `test/parentacts.test.ts` (the 0.16 legacy-field deep-equal excludes the new fields); both still assert every
  previous value.

## Baseline regression evidence
- Against `aeccfdc`, the MX1 metrics test fails its assertion because `decisions` is absent (expected the grouped decision total).
- The MX2 counterfactual replay test fails when its internal dynamic import loads the counterfactual module, which the baseline lacks.
- The MX2 missing-commit test independently fails at its internal dynamic import for the same missing module.
- The MX3 lease test reaches the leased observations and fails its assertion because those entries lack `lease_wait_ms`.
