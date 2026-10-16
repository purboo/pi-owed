# Asks that name the decision

A needs-parent review now quotes the decision requested by the reviewer, rather than the introduction of the review. The first case-insensitive `needs parent`, `Parent decision needed:` or `BLOCK (needs parent):` marker supplies the ask; without a marker, the last sentence is used. Whitespace is flattened and the ask is bounded. Wake-ups, status and receipt cards give the writer-ruling action. Full receipts retain the review note and block evidence.

Former placeholder-plan commands in trunk invariant owner needs and receipt guidance now name failing tests and offer a repair node using the recorded plan source, or the node-creation editor when no source is recorded. Recorded invariant defers remain visible. Repository notices keep their original obligation, trunk commit, waiting-node membership and repair/adopt/sweep/waive choices; queued notices still refresh membership at delivery. This advice does not waive invariants or change how evidence clears debt.

Review acknowledgment is checked before recording. A low or underivable acknowledgment refuses without adding an entry. `--ack-rulings latest` and the tool's `ack_rulings: "latest"` resolve to the current applicable numeric watermark under the ledger lock. Omission still derives acknowledgment from a complete reviewer launch packet. Historical reviews retain their original replay behavior.

Default receipt text shows obligation downgrades only after the current dispatch or latest resume. Full receipts and JSON retain history. Merge waiting remains visible context, but does not inflate the outstanding-obligation total.

`--restart` and the start tool's `restart: true` gracefully stop a running driver, wait for its process to exit, and then start its replacement. A stop timeout refuses: the driver is stopping after its current action and in-flight measurements, repeating the restart is safe, and the explicit force-stop option stops it at once. Graceful stops (restart, or a stop without the immediate option) send one signal per driver process: repeating them only waits, so a retry never turns into a hard stop. The immediate stop may still send the second signal. Ordinary start continues to reuse a running driver. Start output folds lint warnings into the action line without suppressing them. Plan validation, actor restrictions, foreign-host lock protection and measurement draining remain unchanged. `--full` on rebase and candidate attest exposes retained downgrade history. No new plan key or ledger entry kind is introduced.

## Interpretation choices

- Whitespace in an extracted ask is flattened before control-character escaping; an unmarked trailing sentence includes its punctuation.
- No recorded plan source means editor guidance only, not an invented source.
- Presentation context is kept out of serialized receipt fields, preserving JSON evidence and replay.
- Restart uses the existing graceful stop deadline. It never escalates automatically to force-stop.

## Changed existing tests

AK1 applies to the needs-parent halt and ask-text changes below. AK2 applies to trunk repair-guidance changes. AK3 applies to review acknowledgment fixture and refusal changes. All other behavioral assertions remain.

- AK3 — `AN3: other reviewer receives the answer and must acknowledge; later attempt receives it in its packet`: underivable acknowledgment now refuses without recording; answer delivery and later-attempt packet checks remain.
- AK3 — `halt clearing: driver entries, notes and executor observations do not clear; non-driver node actions and new attempts do`: the fixture reviewer explicitly acknowledges applicable rulings so the test still isolates halt clearing.
- AK3 — `reviewPacket: exact commands, reviewer ids, ranks, closure-review, rulings`: the fixture block acknowledges its ruling; packet and candidate-binding assertions remain.
- AK1 — `G3.1: the needs-parent halt and the measured rows 9-11 keep their order before the repair`: assert the extracted ask instead of the old halt wording.
- AK1 — `G3.2: rebase with a repairable block: one repair carrying the rebase instructions; repairs are counted`: update only the needs-parent halt text.
- AK1 — The `#680 (a)` plan-update and post-rebase halt probes: update their shared halt-text expectation; ordering and no-repair assertions remain.
- AK3 — `ID1: note, rank, acknowledgment set, needs-parent and latest A,B,A remain distinct`: fixture blocks acknowledge the current ruling, preserving distinct-act and deduplication checks.
- AK3 — The three `PO6` launch-ack tests for post-launch rulings, a missing earliest ruling and a missing middle ruling: inadequate packets now refuse atomically rather than adding under-acknowledged reviews. Complete-packet derivation remains checked.
- AK2 — `QT-R1 (5): the default why card of trunk and inv:* gives only commands the CLI accepts`: replace placeholder-plan guidance with the source-free editor exit.
- AK1 — `K5 FLAKY-COLDPLAY`: update the needs-parent halt wording only; repair budget and ruling-delivery checks remain.
- AK1 — `decide: a current needs-parent block halts needing a human; no repair is sent or counted`: update the shared halt expectation; stopping and repair-budget checks remain.
- AK1 — `a ruling recorded before the block does not resolve it; rulings before dispatch are not listed in repairs`: update both halt expectations without changing ruling scope checks.
- AK1 — `a * ruling after the block leaves the halt and the block unresolved`: assert the ask in the default receipt instead of the old block line.
- AK1 — `views: why and status show "needs a parent ruling" until a node ruling, then "ruled #seq"`: default surfaces use the ask; full evidence and resolved-block assertions remain.
- AK1 — `D18b.2` measured-failure and `D18b.5` mixed-block tests: use the new shared halt text without changing halt-before-repair behavior.
- AK1 — The needs-parent CLI test: update default receipt and full-status ask lines; entry, invalid-verdict and ruling-scope checks remain.
- AK1 — The needs-parent review tool test: update its default receipt expectation; parameter forwarding and invalid-verdict refusal remain.
- AK1 — `SQ1 default status shows outcome, each phase and only current parent/owner actions and debt`: update the needs-parent action line only.
- AK1 — `UX1: needs-parent block also gives a writer ruling as the next action`: assert the new single-command ordering in status and receipt.
- AK3 — `UX4: explicit zero and omitted ack refuse before recording; latest preserves the verdict and note`: replaces append-then-warn expectations with atomic refusal and numeric alias recording.
- AK3 — `CLI real processes: DAG, laundering, closure, writes, invariant defer, CAS and tamper`: the closure reviewer explicitly acknowledges the current ruling; acceptance, laundering, CAS and tamper assertions remain.
- AK3 — `English CLI output through refusal, failure, repair, review and merge`: reviewers acknowledge the applicable ruling so writer-review refusal and independent-review acceptance still test their original gates.
- AK2 boundary regression — `TP2/P2` collision test: original delivery-text assertions remain; additional checks verify the surviving complete group identity and membership after the other group resolves.
- AK2 boundary regression — `TP2: queued notice recomputes waiting nodes at pi delivery`: original delivery and waiting-node text assertions remain; an additional check verifies the recomputed membership after abandonment.
- AK2 — Differential fuzz and both real-ledger comparison tests: adapt only the frozen version's trunk decision-command fields to new guidance using its own state and entries. Full canonical comparisons of reducer states, validation, keys, queries, evidence and other rendered fields remain. Full downgrade receipt formatting retains the frozen version's representation.
