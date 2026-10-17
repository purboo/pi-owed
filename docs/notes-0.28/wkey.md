# Merge-failure waiver keys

An owner waiver with a nonempty `--accept-risk` list now records the prospective merge key when every cited risk is a failing merge-result observation of the same node and obligation. This applies to both active and previously accepted merge risks. Owed checks that every citation belongs to the current merge tree; trunk movement and conflicts still refuse the act.

Mixed candidate and merge citations retain the candidate-key behavior. A merge-key waiver does not accept a different failing or unmeasured candidate key, and does not clear an uncited block. An independently satisfied candidate can merge using the covered merge key without measuring that key again. A changed key requires its own evidence; an unchanged key may reuse the waiver.

The waiver receipt names the candidate key or the merge key. For a merge key it also names the node and trunk used to construct the tree. This scope is response metadata only, not a ledger field. Historical entries without that metadata keep their existing receipt text.

No new flags or plan keys are introduced. `--candidate`, `--reason`, `--accept-risk` and `--tracked-by` retain their existing validation. Exact-act retries retain their receipt, and tracker changes remain separate acts. Old ledgers and snapshots retain their states, keys and mixed-citation semantics. The waiver still records debt rather than a measured pass.

## Changed existing tests

None. All added coverage belongs to the waiver-key contract; existing tests and their expectations are unchanged.

## Interpretation

Following the parent ruling, receipt scope is attached to the returned act only. It is neither persisted nor inferred later from a newer candidate.
