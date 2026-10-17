# Merge-failure waiver keys

An owner waiver with a nonempty `--accept-risk` list now records the prospective merge key when every cited risk is a failing merge-result observation of the same node and obligation, and every citation matches the current merge key. This applies to both active and previously accepted merge risks. Trunk CAS remains checked on the merge-key path.

If an all-active merge-risk list contains a stale key, or the merge tree conflicts, the existing candidate-key path remains available. It clears the cited block without claiming the current merge key is covered. Lists containing inactive risks retain their existing provenance checks and refusals.

Mixed candidate and merge citations retain the candidate-key behavior. A merge-key waiver does not accept a different failing or unmeasured candidate key, and does not clear an uncited block. An independently satisfied candidate can merge using the covered merge key without measuring that key again. A changed key requires its own evidence; an unchanged key may reuse the waiver.

The waiver receipt names the candidate key or the merge key. For a merge key it also names the node and trunk used to construct the tree. This scope is response metadata only, not a ledger field. Historical entries without that metadata keep their existing receipt text.

No new flags or plan keys are introduced. `--candidate`, `--reason`, `--accept-risk` and `--tracked-by` retain their existing validation. Exact-act retries retain their receipt, and tracker changes remain separate acts. Old ledgers and snapshots retain their states, keys and mixed-citation semantics. The waiver still records debt rather than a measured pass.

## Changed existing tests

The following locations identify the existing tests before this change. Only WK1/WK3 expectations and the fixture steps necessary to preserve their original properties changed, as authorized by R-028-26.

- `test/confirm-timeout.test.ts:277`: the delegated tool receipt previously ended its first line at “debt recorded”; WK3 now requires the candidate key. Delegated authority and no-dialog assertions stay unchanged.
- `test/halt-detail.test.ts:117`: the unmeasured-key tool receipt previously omitted the key; WK3 adds the candidate key. The meaning and later-measurement assertions stay unchanged.
- `test/app027.test.ts:222`: the held-risk CLI receipt previously placed accepted risk immediately after “debt recorded”; WK3 inserts the candidate key. Held-risk acceptance and compact output remain checked.
- `test/app027.test.ts:236`: the full call previously recorded another act because the initial waiver used the candidate key. Under WK1 it is now an exact merge-key retry: the test checks its original receipt and no append, and checks full receipt output on a fresh fixture.
- `test/waive-key.test.ts:64`: the flaky merge-risk waiver previously recorded the candidate key; WK1 records the current merge key. Block clearance, acceptance and merge reuse assertions stay unchanged.
- `test/waive-key.test.ts:89`: the merge previously measured the waived merge key again and passed; WK1 now merges without another measurement.
- `test/waive-key.test.ts:102`: the old fixture expected a new failure on the already covered merge key. WK1 now covers that key, so the fixture changes candidate reads and proves a different merge key is measured, fails and creates a new active block; no false acceptance is allowed.
- `test/waive-key.test.ts:161`: the meaning previously described discounting a merge fail from a candidate-key waiver; WK1 now describes a merge-key waiver and its candidate-key exclusion. The confirmation-dialog assertion stays unchanged.
- `test/trunkred.test.ts:335`: the old fixture remeasured an already waived merge key. WK1 now changes candidate reads before the retry; the new merge key fails while the unchanged trunk probe is still reused exactly once.

The stale active-key regression in `test/trunkred.test.ts:284` remains unchanged.

## Interpretation

Following R-028-23, receipt scope is attached to the returned act only. It is neither persisted nor inferred later from a newer candidate. R-028-26 narrows merge-key selection so stale active blocks remain clearable through the existing candidate-key path.
