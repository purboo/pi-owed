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
- `lease_wait_ms` is an optional non-negative integer on `obs` and `merge`, validated on replay. Retaining it is
  an explicit compatibility exception under MX-P2, in the same category as ER6; keys, verdicts and gates do not read it.
- Owed ≤0.22 (including 0.13–0.22) checks `obs` against the `OBS_FIELDS` whitelist: an `obs` carrying
  `lease_wait_ms` causes code `version` and refuses the entire ledger. This refusal applies only to `obs`;
  those versions ignore the field when reading `merge`.
- Upgrade the CLI, driver and pi sessions before the first leased `attest` under 0.23, which writes this field.
  Old ledgers without the field still replay, retain their existing metrics, and have zero lease-wait samples.
- The driver acquires its lease with `noWait`: busy means retry on a later tick. Waiting across ticks is not
  included in `lease_wait_ms`, so the driver's recorded wait is a lower bound.
- No new entry kind, plan key or ledger field besides the one above.
- Metrics JSON gains `decisions`, `actsPerDecision`, `latency`, `parentActs.mergedOnly`, `interruptions.byClass` and
  `halts[].interruption`; existing fields are unchanged.

## Known limits (ruling #2572)
- `--counterfactual` is one cold, validating replay of the whole ledger: its time is about one full replay without
  a snapshot. On the app ledger a plain replay took 47 s on the test host (profile: state refresh of node
  items 25 s, plan downgrade analysis 14 s, entry
  validation 12 s); the command took 60–98 s on that shared host, while `owed status` (tail snapshot) took 2.2 s.
  A per-halt cache or a faster reducer is deferred.
- The temporary Git object directory is cleaned on normal completion and thrown errors, but not on SIGINT;
  an interrupted report can leave that directory behind.
- `--metrics` does not replay: its interruption classes come from the halt text, so a pre-0.23 AT1 halt that was a
  shared failure counts as `other` there; `--counterfactual` gives its state-based class. `--metrics` itself
  costs what it cost before (about 40 s on app, dominated by the existing per-plan act classification).
- Phases are derived from ledger entries, not from a replayed acceptance state.
