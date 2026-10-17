# Driver needs in 0.28

Owner notices and halt output now share the same needs as status and why. Each obligation has its own line and command; a command never silently bundles another obligation. If the ledger has no single actionable need, the driver retains the diagnosis and says “no single command”.

Wake logs carry the primary need and its identity, plus any other needs recorded in that wake. Before delivery, the follower reads the current needs again and drops those that disappeared. Surviving needs retain their current order. Answer needs also check the host’s question revision individually, so a closed answer never drops another obligation in the same wake. Failed reads retain the recorded order, and failed host descriptions conservatively retain the answer; legacy and diagnostic rows keep their original whole-row checks. Diagnostic wakes remain diagnostics, even if their prose contains command-like text; old logs without structured needs retain their existing rendering.

A running attest suppresses an owner notice only for the same node, obligation and current candidate. Queued invocations, trunk work and measurements of an older candidate do not suppress it. This affects notification output, not acceptance gates or driver scheduling.

The sealed-writer `rulingFollowUp` without `writer: true` now permits “no change: <why>”. This does not change live steer messages or the zero-review ruling-debt resubmit path (R-028-48). Completing it without a submit does not replace an existing repair, failure or recovery route with a redundant ruling-follow-up halt. It does not accept a candidate or clear a halt. Writer-change rulings still require a submit.

Live reviewer ruling notifications ask for a review with `--ack-rulings`, never a writer submit. This delivery-only correction follows R-028-32; writer delivery selection and receipt accounting remain unchanged.

After dependencies named by `resume --after` merge, the driver uses the same automatic rebase route as for plan dependencies. The existing rebase and resubmit requirements remain.

Ledger halt reasons remain causes and evidence rather than display rows. Writer-stop and needs-parent review trailers retain their historical format because existing readers depend on it (R-028-34 and R-028-42). The driver renders the real post-halt need instead. No ledger fields, plan keys, acceptance gates or public flags are added.

## Changed existing tests

- `drive.test.ts` — DR1, C1 and R-028-38: owner notices render the authority’s need; stale and stalled reasons no longer carry whole-node command unions.
- `views020.test.ts` — DR1, C1 and R-028-46: only the driver notification parity assertion changes; it checks the need’s text and command rather than the old owner prefix.
- `drive-order.test.ts` — DR1, C1 and R-028-42: manual halt reasons contain approval and evidence causes, not command builders.
- `approve-evidence.test.ts` — DR1, C1 and R-028-42: manual halt causes no longer bundle resolving commands; obligation gates and halt clearance assertions are unchanged.
- `drive-live.test.ts` — DR2 and R-028-35: new unanswered-question diagnostics retain their complete text and null need instead of using the legacy prose prescription.
- `supersede.test.ts` — DR1 and C1: the manual halt assertion checks the retained approval cause rather than an embedded approval command.
- `quiet.test.ts` — DR1, C1, N5 and R-028-35: driver output renders current needs; diagnostic-only question wakes do not invent a need.
- `quiet025.test.ts` — DR2: structured wakes use asynchronous fresh-need validation and render the recorded need.
- `notices.test.ts` — DR1, DR2 and R-028-40: answered-but-still-asking output renders the structured answer need and its retry command, without maintaining a second prose expectation.
- `repair-epoch.test.ts` — DR4: no-writer-change ruling messages permit a no-change reply and retain the original repair or submit halt cause.
- `ruling-any.test.ts` — DR1, C1 and DR4: owner notices use per-obligation needs and ruling-only follow-ups no longer mandate a change.
- `stopask.test.ts` — DR2: structured wakes wait for fresh-need validation before fixture cleanup; writer-change ruling behavior remains covered.

## Prune candidates

`src/views.ts` still exports `ownerCommands` and `evidenceCommand` for the old view rendering and its tests. The driver no longer calls either, but removing them must wait for the view migration. `reviewDecision` and `writerDecisionCommand` are not dead: their calls in `src/drive.ts` (`needsRulingHalt` and `stoppedHalt`) preserve historical ledger formats and must remain while readers still parse those formats.

`src/drive-bg.ts` keeps `plainNeed` only for legacy log rows without `need`; it is not a removal candidate while legacy log replay remains supported. `src/ext-worker.ts` passes through the follower’s rendered string and needs no additional selector or renderer.

## Compatibility and limits

The historical prose parser remains only for logs without a `need` field. New diagnostic rows explicitly use a null need. Membership gaps remain visible as diagnostics; the driver does not invent new needs to fill them. Prompt review service during unrelated halts remains outside this release.
