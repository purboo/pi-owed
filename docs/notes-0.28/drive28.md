# Driver needs in 0.28

Owner notices and halt output now share the same needs as status and why. Each obligation has its own line and command; a command never silently bundles another obligation. If the ledger has no single actionable need, the driver retains the diagnosis and says “no single command”.

Wake logs carry the primary need and its identity, plus any other needs recorded in that wake. Before delivery, a follower with the pi revalidation hook reads the current needs again and drops those that disappeared. Hookless CLI-era followers keep synchronous delivery of the recorded needs (R-028-49). Surviving needs retain their current order. Answer needs also check the host’s question revision individually, so a closed answer never drops another obligation in the same wake. Failed reads retain the recorded order, and failed host descriptions conservatively retain the answer; legacy and diagnostic rows keep their original whole-row checks. Diagnostic wakes remain diagnostics, even if their prose contains command-like text; old logs without structured needs retain their existing rendering.

A running attest suppresses an owner notice only for the same node, obligation and current candidate. Queued invocations, trunk work and measurements of an older candidate do not suppress it. This affects notification output, not acceptance gates or driver scheduling.

The sealed-writer `rulingFollowUp` without `writer: true` now permits “no change: <why>”. This does not change live steer messages or the zero-review ruling-debt resubmit path (R-028-48). Completing it without a submit does not replace an existing repair, failure or recovery route with a redundant ruling-follow-up halt. It does not accept a candidate or clear a halt. Writer-change rulings still require a submit.

Live reviewer ruling notifications ask for a review with `--ack-rulings`, never a writer submit. This delivery-only correction follows R-028-32; writer delivery selection and receipt accounting remain unchanged.

After dependencies named by `resume --after` merge, the driver uses the same automatic rebase route as for plan dependencies. The existing rebase and resubmit requirements remain.

Ledger halt reasons remain causes and evidence rather than display rows. Writer-stop and needs-parent review trailers retain their historical format because existing readers depend on it (R-028-34 and R-028-42). The driver renders the real post-halt need instead. No ledger fields, plan keys, acceptance gates or public flags are added.

## Changed existing tests

- `drive.test.ts` — DR1, C1 and R-028-38: owner notices render the authority’s need; stale and stalled reasons no longer carry whole-node command unions.
- `views020.test.ts` — DR1, C1 and R-028-46: only the driver notification parity assertion changes; it checks the need’s text and command rather than the old owner prefix.
- `drive-order.test.ts` — DR1, C1 and R-028-42/56: manual halt reasons retain the cbe7b9a approval/evidence causes minus command suffixes; the no-command assertion is preserved.
- `approve-evidence.test.ts` — DR1, C1 and R-028-42/56: manual halt causes retain cbe7b9a wording minus command suffixes; obligation gates and halt clearance assertions are unchanged.
- `drive-live.test.ts` — DR2 and R-028-35: new unanswered-question diagnostics retain their complete text and null need instead of using the legacy prose prescription.
- `supersede.test.ts` — DR1 and C1: the manual halt assertion checks the retained approval cause rather than an embedded approval command.
- `quiet.test.ts` — DR1, C1, N5 and R-028-35/42/56/57: driver output renders current needs; diagnostic-only question wakes do not invent a need. Evidence-only halt expectations retain the historical cause without command suffixes. Non-`a:` surfaces retain PARENT and assert that cause; status --full also includes the primary need command. The `a:` branch is unchanged.
- `quiet025.test.ts` — DR2: structured wakes use asynchronous fresh-need validation and render the recorded need.
- `notices.test.ts` — DR1, DR2 and R-028-40/55: answered-but-still-asking output renders the structured answer need and its retry command. The grace-boundary assertion now checks the exact reason-only Need.text, and the held retry matches `15m → owed answer` with no `: retry with ` tail. The exact answerRetry command and once-only delivery assertions remain unchanged; the QT5 legacy parser is retained.
- `repair-epoch.test.ts` — DR4: no-writer-change ruling messages permit a no-change reply and retain the original repair or submit halt cause.
- `ruling-any.test.ts` — DR1, C1 and DR4: owner notices use per-obligation needs and ruling-only follow-ups no longer mandate a change.
- `stopask.test.ts` — DR2: structured wakes use the asynchronous delivery entry point; writer-change ruling behavior remains covered.
- `infra.test.ts`, IF1 driver/follower assertion — C6, N5 and R-028-49: a setup-only halt renders resume after the retained cause; retry budgeting is unchanged. IF4 remains unmodified.
- `invred.test.ts`, IR repair P2 revalidation assertions — DR2 and R-028-50/56: structured identity, not legacy invariant metadata, determines validity; a surviving conflict need gets fresh text and an absent need identity is rejected. A same-key pass leaves an owner conflict, so the non-red case remains `[true]` under R-028-56(2).
- `resume.test.ts`, L1.2 post-merge assertions — DR7 and R-028-50: record the automatic rebase, then verify the exact merge-naming rebase follow-up without synthetic worktree state.
- `shared.test.ts`, FS3(b) emitted notice assertions — DR2 and R-028-49: one repository notice renders each repository need exactly once and binds the primary need; action selection text is untouched.
- `trackfix.test.ts`, TF2/WF1 #3065 driver/follower block — DR1, DR2 and R-028-49: notice and wake follow the current needs, retaining trunk-red diagnosis before the flaky pair. The separate waiver scenario is untouched. Its runtime argument includes only the pinned display fields; the extra clock argument was removed as a type-only correction (proc-03).

- `drive028.test.ts`, new multiline evidence regression — R-028-56/57: the persisted cause uses `oneLine(what)`; it has no actual newline or evidence command. R-028-57 corrects the new test’s expectation to the escaped, not space-folded, representation.

## Prune candidates

`src/views.ts` still exports `ownerCommands` and `evidenceCommand` for the old view rendering and its tests. The driver no longer calls either, but removing them must wait for the view migration. `reviewDecision` and `writerDecisionCommand` are not dead: their calls in `src/drive.ts` (`needsRulingHalt` and `stoppedHalt`) preserve historical ledger formats and must remain while readers still parse those formats.

`src/drive-bg.ts` keeps `plainNeed` only for legacy log rows without `need`; it is not a removal candidate while legacy log replay remains supported. `src/ext-worker.ts` passes through the follower’s rendered string and needs no additional selector or renderer.

## Measurement lifecycle correction

The added runtime rendering originally ran in the background attest-success path. It lengthened that measurement’s lifetime past the caller’s final pass, allowing runtime cache writes to race fixture cleanup. The correction moves runtime assembly into the awaited finish/reap path, without changing action selection or order. The existing PO5 test is unchanged (R-028-50).

Comparative evidence required by R-028-50:
- Candidate: `/tmp/owed-ipc/logs/drive28-parentops-candidate-212230.log`, `/tmp/owed-ipc/logs/drive28-parentops-candidate-212256.log`, `/tmp/owed-ipc/logs/drive28-parentops-candidate-212321.log`.
- Base: `/tmp/owed-ipc/logs/drive28-parentops-base-212346.log`, `/tmp/owed-ipc/logs/drive28-parentops-base-212412.log`, `/tmp/owed-ipc/logs/drive28-parentops-base-212437.log`.

## Parked notice delivery (R-028-52 and R-028-53)

Repository park groups share an obligation but are identified by their full `once`, not their need identity. Rendering every repository need in every notice had made distinct groups’ text identical, so collection discarded the second group before delivery. Filtering by need identity could not distinguish them either.

`parkNeeds` selects the named group plus non-park repository needs, following the existing repository need order. Driver wakes, delivery-time refresh and optional hook validation share that scope. A resolved group is dropped; a surviving group never renders another group’s waiting nodes. Refresh remains independent of the hook and reuses the existing state read; synchronous `tick()` and other follower paths are unchanged.

The new regression covers two live groups with the same obligation through both hookless and hooked followers. Each group’s red line is delivered exactly once and each notice excludes the other group’s waiting node. Existing tests are unmodified for these corrections.

Final net source growth against the slot base is +84 lines: `answer.ts` +1, `drive.ts` +14, `drive-run.ts` +29 and `drive-bg.ts` +40. This stays within the parent’s expanded leaf budget; release-wide subtraction remains the prune gate.

## Compatibility and limits

The historical prose parser remains only for logs without a `need` field. New diagnostic rows explicitly use a null need. Membership gaps remain visible as diagnostics; the driver does not invent new needs to fill them. Prompt review service during unrelated halts remains outside this release.
