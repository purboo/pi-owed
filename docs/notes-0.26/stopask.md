# A stopped writer needs a decision, not necessarily a submit

When a writer finishes successfully without a candidate, the driver inspects its actual worktree. The dispatch base, the head handed to the writer after a rebase, and the latest submitted candidate identify whether new work remains. A clean worktree at that head halts without a submit nudge. A new commit or uncommitted files can still receive one submit reminder. A plan change that requires resubmission still permits the same clean commit.

When a writer finishes without the requested submission, or its run fails, wakes, default why and status quote its final non-empty reply paragraph and offer a parent decision with `--writer`. The reply becomes one bounded line; long replies end in an ellipsis and missing final text is explicit. Full details retain the run, repair and failure evidence. Pruned runs retain a final reply when describe still supplies it.

Dispatch packets and writer follow-ups explicitly require a question to the parent when a decision exceeds allowed writes, and prohibit submitting a candidate the writer believes fails its checks. Submit reminders additionally say to ask rather than submit when stopped for a parent decision. Real questions keep the existing question and answer flow; the driver never guesses an answer.

A pending rebase no longer hides a writer that has already received the rebase follow-up and then stops. A sealed writer at the unchanged clean pre-rebase head halts immediately, naming the follow-up and its final reply. Work left behind gets one additional reminder with the rebase instructions, then halts if no candidate is submitted. Missing worktree facts halt without a reminder. Running writers still wait and asking writers keep their question flow. The handed head is a set: the last submitted commit (or the dispatch base), plus the pre-rebase base of every later rebase of the attempt; a clean worktree at any of them counts as no new work.

These pending-rebase halts deliver a due ruling first. After `owed decide <node> --text "<ruling>" --writer` records the ruling and resumes, the next pass sends exactly one ruling follow-up to the sealed writer. If the writer stops again without a candidate, the halt names that ruling follow-up and nothing more is sent.

When `owed rule` finds that a node's known writer call has finished (neither running nor asking), its receipt adds one line naming the node and call. The line says the ruling was recorded but not sent now, that the driver delivers it on its next pass, and that a halted node needs `owed resume <node>` (`owed decide` records and resumes in one step). `owed rule` itself still never sends follow-ups.

No new plan keys or ledger entry kinds are introduced, and check, review and merge gates are unchanged. Old ledgers replay to identical states and recorded message retries retain their original bytes. An unreadable worktree halts conservatively instead of prompting a submit. Final text cannot be recovered when a pruned run no longer supplies it. Existing repair and ruling follow-up rules remain in force.

## Changed existing tests

- Row 6 interrupted text and row 18 fenced text: retain recovery instructions and assert the new question boundary.
- Row 7 sealed writer failures and D15.1/SR4 rejected-run recovery: retain failure and abandon evidence, adding missing-final-text and writer-decision guidance.
- Row 8 one submit reminder: supply explicit new work in the policy fixture, retaining the single-reminder-then-halt requirement.
- Row 17 rebase follow-up and D11 exhausted repair budget: retain rebase and budget evidence and assert the new trailer.
- D22.2 writer ruling steer, D22.4a later rulings after repair, and D22 executor ruling delivery: add question guidance to exact text without changing ruling scope, ordering or deduplication.
- D22.2a sealed writer routing and D22.3 rejected ruling recovery: supply explicit new work in policy fixtures and actual uncommitted work in the executor fixture, retaining the rejected-request replay assertions.
- E4.3 repair/ruling race and E4.1 carried rulings: add question guidance while still asserting delivery only of uncarried rulings.
- L1.3 reminders after resume, L1.2/L1.3 dependency waits, and L1.5 halt hints: supply explicit new work and retain resume, dependency-merge and existing hint assertions.
- L1.4 run addresses: retain address and failure evidence and assert the added final-reply and decision trailer.
- K5 FLAKY-COLDPLAY budget recovery, K5.1 repair epochs, K5 QA-REGISTRY ruling follow-ups, and K5.2 no-candidate rulings: retain failure evidence and budget semantics while updating message and halt trailers.
- K5.4 observation length: extract the original observation evidence separately from the new writer-reply trailer.
- L3.1 owner-needed ruling follow-ups, rulings before sealed-run failure, and flaky-block writer routing: assert question and final-reply guidance without changing writer/reviewer ownership.
- G3.2 plan-change and rebase repairs and G3.7 conflict-file guidance: retain original repair and conflict assertions and check the added trailer.
- D15.1 fixed rejected runs and SR2 sealed routing after a refused steer: retain rejection recovery and supply explicit new work in the policy fixture.
- Carry after rebase and plan change: retain same-commit resubmission and plan-change routing, adding the new guidance.
- F1.1 stale send decisions: leave actual unsubmitted work so the stale-send fence and next-pass ruling delivery remain exercised.
- MO2 merge-only reordering: supply explicit new work for the non-merge writer action, retaining ordering and in-flight/halted gates.
- G3.2 restart generation lag: leave actual unsubmitted work so a submit follow-up still starts and the stale sealed generation cannot halt the attempt.
- G3.6 failed-send text and F4.3 failed-send notice: leave actual unsubmitted work so send failures still exercise node, kind, reason and target assertions.
- ER2 aligned unsubmitted rebase and crash-leftover recovery: preserve the keep/reset/abort instructions and absence of executor submits; assert the WS5 single extra nudge for a changed HEAD followed by a halt, and an immediate halt for an unchanged crash-leftover HEAD.
- LO3 pi `owed_rule` receipt (`left022.test.ts`): the fixture's writer call has finished, so the receipt now has the WS-R3 line naming it; the compactness check still excludes block quotes and follow-up text, ignoring only that call id.
- UX2 no running calls (`ux.test.ts`): writer `a`'s known call is sealed, so the exact receipt now ends with the WS-R3 finished-call line after the unknown-writer notice for `b`.
