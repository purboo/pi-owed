# Trunk probes and tracked waivers

## Behavior

`owed attest <node> --probe-trunk` measures checks on the current trunk without changing candidate observations, blocks, keys, counts or acceptance. By default it selects checks with active or flaky execution blocks. `--check <id>` selects a node check explicitly; `--runs <n>` requests sequential runs, stopping that check after its first non-pass. An existing probe never suppresses an explicit run. The command uses the same machine lease and node attest lock as ordinary attest, and refuses stale results if the plan, candidate, slot or trunk moves.

Probe output names the trunk, check, result and observation receipts, followed by the compact why card. All probes passing returns success even when the candidate still owes work. A failed probe or moved CAS returns failure; invalid selection, unsupported combinations and invalid run limits return usage failure. Red and mutants checks, checks with tests new in the candidate, and nodes without an open candidate are refused. Probe mode does not combine with rerun or remeasure.

Complete test-only check failures can use same-definition trunk probes recorded before or after the failure as shared-failure evidence. The hints name the failing block, trunk and probe, and suggest accepting its risk with a tracked waiver. A matching fix candidate is suggested; otherwise the hint asks for a fix node first. Repairs tell the writer to ask the parent instead of changing code outside their writes. Existing trunk-red diagnosis takes precedence, and the latest non-error probe on the current trunk can set or clear that diagnosis for a merge-tree check. The next merge reuses matching probe evidence but still refuses the failed merge check. Invariant shared-failure rules are unchanged.

## Tracked waivers

`owed waive <node> <obligation> --tracked-by <fix>` and the tool's `tracked_by` associate waiver debt with another unmerged node of the current plan. Missing, merged and self trackers are refused without recording an act. No plan keys are added.

Debt reads `waived — tracked by <fix>`. When that fix merges, default status and brief debt lists omit it; full status and report retain `settled by <fix>` and its merge receipt. This is settlement of tracked debt, not proof that a flake is gone. `owed why <fix>` lists the waived debts it tracks. Removing an unmerged tracker makes the debt visible again with `tracker <fix> left the plan`.

Adding or changing a tracker is a new waiver act, not an identical retry. An otherwise identical waiver may attach a tracker to risks already accepted by that owner on the current candidate; it neither accepts new risks nor changes the existing waiver decision.

## Compatibility and known limits

`waive.tracked_by` is optional presentation metadata. Replay validates it against the plan in force at the waiver's sequence; entries without it retain their prior state and keys. Older readers that ignore extra waiver fields retain their conservative debt display. Trunk probes use the existing `obs` kind and `probe: "trunk"` value.

Shared check hints require complete test-only failure evidence and matching signatures, or the existing name-only match when neither side recorded a signature. A passing probe supplies no shared-failure evidence and never clears a block. Shared-failure history may remain relevant after a later probe passes; current merge-tree trunk-red classification instead follows the latest non-error current-trunk probe.

## Changed existing tests

None. Existing tests and their gates are unchanged.
