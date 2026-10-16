# Flaky evidence, quieter admission and remeasure receipts

Flaky execution diagnostics now identify the failed commit, the failing observation and the attribution pass on the same key. Merge-tree failures also name their merge key. An older candidate's failure is never erased by a newer candidate's green result; the diagnostic distinguishes the current candidate from the original failing content.

When an older candidate-key flaky block belongs to a different key and the current candidate has no counted pass for that obligation, owed waits for the current candidate before asking the owner about that block. Error-only measurements keep this hold. A failing current candidate follows the writer repair path; a counted pass exposes the original risk for an owner decision. Same-key and merge-key flakes are not held. Held blocks still prevent acceptance and merge, and the owner can accept their risk at any time.

The CLI and tool waiver replies begin with an explicit debt receipt, then the waiver's effect, then the compact why card. CLI `--full` and tool `full: true` restore the full receipt. Accepting a counting block says `in effect now`, identifies the accepted risk and any same-key attribution pass, and separately identifies a satisfied candidate key. A waiver that accepts no counting block can still be described as unnecessary while the candidate is satisfied.

Plan and edit admission lint checks only new checks or invariants and changes to `run`, `reads` or `timeout_s`, matched by invariant identity or node/check identity. Closure warnings recur when the relevant reads or closure changes. Measured near-timeout warnings recur on admission only when their text changes; status and cost reporting retain their full views. Initialization still checks everything.

Decide and resume with `--remeasure` now describe each failed merge-tree invariant's recorded key. If trunk or the candidate changed since its failure, the reply explains that the next merge builds a new tree and chooses measurement from that tree's key. Node checks are not invariant remeasure jobs: an active merge-check block follows the existing attribution rerun route, while an already-flaky block still needs accepted risk or a fix.

## Compatibility and limits

No ledger kinds, fields, plan keys, measurement keys or gate semantics are added. The new `remeasure` result text is diagnostic only and does not build a Git tree at decide time. Old ledger facts keep their verdicts and block states; diagnostic details and dischargers reflect the new hold timing. Script syntax remains statically checked, not executed by admission lint. Historical short driver notices without an attribution pair keep their existing wake rendering.

## Changed existing tests

- Cost admission regression for broad reads: unchanged plan recordings now expect no repeated coverage warning; initialization remains fully checked.
- Driver owner-needed regression: the expected flaky notice now includes its original failure and same-key attribution pass, without changing dispatch or recovery behavior.
- Halt-detail waiver scope regression: accepted flaky risk now names both observations in the effect; tool output checks the explicit debt receipt before the unchanged effect line.
- Ruling follow-up regression for an owner-needed flaky node: the writer message now includes both observations and the current candidate, while preserving the failing note and one-time delivery.
- Flaky remedy regression across why, status, brief and driver: expects the exact same-key evidence and risk command in the new compact text; explicit writer-decision guidance remains available.
- Merged-node admission warnings regression: the tool follows the CLI's admission of the same plan, so it retains general plan warnings without repeating coverage lint.
- Delegated tool actions regression: compact waive checks the debt receipt and delegated channel in structured details; full item provenance remains checked separately.
- Frozen-reducer differential regression: independently derives the specified flaky text and hold discharger for the baseline's presentation, including the last live item of a removed node. It retains exact comparisons of acceptance, keys, evidence, blocks, measurement jobs and refusal decisions; only their specified diagnostic wording and owner timing differ.
