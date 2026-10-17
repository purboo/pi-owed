# One source for outstanding needs

Status, brief, why and operation receipts now render the same parent and owner needs. Each obligation has its own reason and command, so resolving one does not hide another. A need without one executable remedy explicitly says "no single command". Why lists other ways to resolve that same need as separate "or" lines.

Commands include the required risk citations, candidate pins, reasons, notes, roles and ruling acknowledgments. Owner review alternatives use a principal placeholder independently of the interactive confirmation setting. Existing role permissions, review ranks, candidate constraints and acceptance gates remain in force.

When an old review block still binds a submitted repair, why identifies the repair and explains which original reviewer and rank can clear the block on the current key. It does not promise that the driver will schedule that review. A trunk or invariant card with outstanding obligations no longer reports that it is merged.

A halt first requires any outstanding review ruling, then its existing parent or owner obligations, and otherwise a resume. Resume text explains continuation and any dependency wait. A stopped writer uses a decision command only in that final case, with resume as an alternative. Full views retain the recorded halt reason as evidence.

A running measurement suppresses only the owner need for the same node, current candidate and obligation. Queued records, other trees and old candidates suppress nothing. Batch eligibility refusals use the same runtime input, so a measurement's suppressed owner need does not reappear there. Running drivers can still show answered questions that remain open. Under R-028-40, their original runtime text retains its evidence while the need separates the reason from its retry command; the node prefix and command each appear once.

A node attest that completes without acceptance explains its current need or recorded activity on the first line. Manual rebase first explains that it moved the slot base and that the writer must still rebase and resubmit. Genesis and trunk attests retain their dedicated receipts under R-028-37.

Empty failure extraction identifies the stored log and distinguishes an exact-name mismatch from a matched record without an error field. These diagnostics do not count as error text for automatic remeasurement. Actual errors, failed names, measurement results and repeat-run evidence remain available.

The limited needs change authorized by R-028-33 preserves the original trunk-red and shared-check diagnosis before a block's kind-specific route, including the failed/passed pair for a flaky block. It does not change need membership. Under R-028-41 as corrected by R-028-44, receipts, compact and full why, and structured block clearance retain the existing historical merge diagnostics after the item-specific next line. Those diagnostics do not become needs, primary text, alternatives or brief clearance text.

Status, brief and why preserve their established JSON shape. Summary needs contain only node, reason and command; why reads alternatives from non-serialized presentation context. Under R-028-51, the rejected merge's cause remains byte-identical to the earlier format, including trunk-red diagnostics and the writes suffix. The driver persists that cause as one halt reason, and the halt's needs are rendered separately (R-028-38/42).

The R-028-45 comparison adapter now produces the new needs, progress and brief decision sections only on the frozen BASE side, using exact old sections or anchors and the current renderer on the same state. CUR text retains the original comparison path. R-028-51 counterexamples verify that incorrect CUR need reasons, an invalid trunk recovery command and corrupted brief decisions remain visible to the comparison.

Git-derived merge checks, drift and rebase waits retain their existing supplemental paths. There are no new plan keys or ledger fields. Existing ledger replay and acceptance conditions remain compatible.

## R-028-51 verification and proc-04 follow-up

Proc-04 corrects only the new driver regression's approval-block injection: the review branch uses the public reviewer block operation, and the approve branch uses `ops.approve` with `block: true`. The accepted-candidate setup and exact persisted halt-reason assertions stay unchanged. This corrects the test's API typing without changing production code or recording a process ruling in the ledger.

The first R-028-51 check stopped at the type error, as required:

- `/tmp/owed-bench/logs/views28-1-220024.log`: focused checks passed (325 tests).
- `/tmp/owed-bench/logs/views28-1-220543.log`: TypeScript failed on the test's unsupported approval obligation passed to `ops.review`; red and full tests were not run on that tree.

Proc-04 validation runs in the following order. Each artifact contains the complete original harness log, its original log path and exit receipt; all five runs use the same candidate tree. A missing later artifact means execution stopped before that step.

- `/tmp/views28-r51-proc04-views.log`: views028 regression file.
- `/tmp/views28-r51-proc04-focused.log`: focused checks, including all four differential cases.
- `/tmp/views28-r51-proc04-tsc.log`: TypeScript check.
- `/tmp/views28-r51-proc04-red.log`: regression red against the reviewed candidate `ea76a56720ab4044820e52bef372a186f87ea388`, with all three R-028-51 counterexamples required to fail there.
- `/tmp/views28-r51-proc04-full.log`: one complete test run on the final candidate tree.

## Changed existing tests

- `activity.test.ts`: VW1, R-028-40. Keep the byte-for-byte runtime asking comparison, and compare displayed reasons and retry commands separately. Live, foreign, stopped and grace-period checks remain.
- `approve-evidence.test.ts`: VW2, C4. Approval blocks display the shared need and pinned owner command; clearance and permission checks remain.
- `asks026.test.ts`: VW1, VW2, C7. Status and why use the shared ask and primary-need format. Trunk repair text explicitly states when there is no single command; ruling, defer and replay checks remain.
- `attest-busy.test.ts`: VW2, N4. Execution-block advice describes the attribution clearance route instead of predicting that the driver will measure it. Busy and lock checks remain.
- `attrib.test.ts`: VW1, VW5, C5, C6, R-028-51. Active merge-key check failures have their own risk-resolution need in status. The merge refusal retains its original cause without a need command; rebase diagnostics, failure attribution and execution checks remain.
- `bind.test.ts`: VW1, C1, C4. Supported owner acts retain candidate-pin checks. Routine reviewer work adds no owner need, and why gives the obligation's original-reviewer clearance condition.
- `brief.test.ts`: VW1, C1, C4, R-028-51. Separate the primary ruling from the owner review alternative, read the latter from why text, and execute the complete owner command. Ordering, totals and clearance checks remain.
- `decide.test.ts`: VW, N5.3 (C6). Only the DC3/DC4 pre-decision status expectation changes: an ordinary halt needs resume instead of a generic decision. Tool execution, durable answers and decision validation checks remain.
- `differential.ts` (performance comparison helper): R-028-45/51. VW1 inserts the exact needs section at the frozen trunk anchor; N4 inserts the current progress section at the frozen pending anchor. The exact legacy brief decision section is replaced with the current same-state rendering. CUR output receives no new projection. VW2/N4 adapts only the exact receipt lead to the current primary need or activity. VW2/C3/C4 adapts each exact block fragment and adds only that item's next line. VW5/N5 replaces the exact old pending-halt advice, standalone recovery suggestion and ruling label. Current replay indexes are attached only as non-enumerable display metadata on the frozen facts. State, keys, validation variants, jobs, guards, queries, packets, prefixes and ledgers retain strict comparison. Counterexamples cover changed reducer state and corrupted CUR needs and decisions.
- `drive-ledger.test.ts`: VW5, C6. Full views retain halt evidence, while recovery advice comes from the shared need instead of generic decision text.
- `fixes.test.ts`: VW2, C1, C4, R-028-51. Block advice follows its obligation; absent current obligations get no stale-candidate command. Alternatives are checked in why/receipt text rather than added to summary JSON. Original-reviewer and equal-rank peer clearance checks remain.
- `flow.test.ts`: VW2, N4. A dispatched writer's why headline uses recorded writing activity. The structured dispatched phase, overlap refusal and explicit overlap permission remain checked.
- `halt-quiet.test.ts`: VW1, C1, C4, R-028-36/51. Only the E3.2 brief and legacy owner-command assertions change. Brief primary and alternative are separate; alternatives are verified through needs, while summary keys retain their established shape. Brief is independent of confirmation mode, and legacy principal behavior is checked separately in both modes.
- `hold.test.ts`: VW2, N5. Do not append a handwritten hold decision without a corresponding need. Held state, dispatch refusal and actual recovery checks remain.
- `left022.test.ts`: N4, C2, VW2. Why displays the current measurement record's obligation and attest process. Existing driver-log progress decoration is still checked.
- `mtrain.test.ts`: VW, C4. Batch refusal displays missing owner approval or the recorded activity of an accepted member unsuitable for batching. Batch eligibility and acceptance checks remain.
- `needs.test.ts`: VW1, C4, C6, C7. Keep the frozen baseline, corrected expectations and correction table. Both rendering and needs are checked against the corrected frozen expectations instead of treating the replaced renderer as the old selector.
- `quiet.test.ts`: VW2, VW5, C6. Compact why leads with the shared evidence or resume need. Role and permission checks on driver output, full views and historical entries remain.
- `quiet025.test.ts`: VW1, VW2, C6, C7, R-028-40. Why uses activity and item-specific text without an unsupported decision suggestion. Asking output separates its reason and command, and trunk explains the absence of one command.
- `refusalnotice.test.ts`: VW6. Empty-error expectations identify the log and exact missing-extraction reason. Real-error and repeat-run checks remain.
- `removed.test.ts`: VW5, C6. A refused resume points to the shared ruling need; refusal, no-append and successful post-ruling resume checks remain.
- `repeat.test.ts`: VW6. Update empty-error diagnostics while retaining failed names, repeat receipts, quote bounds and exit semantics.
- `resume.test.ts`: VW5, C6. A stopped writer's primary decision and resume alternative are separate instead of using generic halt-clear text.
- `review-needs.test.ts`: VW1, VW2, C3, C6. Unify ruling-need formatting and explain old-key repair clearance. Persisted halt reasons and driver action reasons are unchanged, as required by R-028-42.
- `ruling-any.test.ts`: VW2, C4. Flaky blocks display a waiver with risk citations and required flags, without an old ruling suggestion that cannot clear the block.
- `shared.test.ts`: VW1, C7. Repository shared and trunk-red needs explicitly state that there is no single command. Unique repository-need and parking checks remain.
- `summary.test.ts`: VW1, C6, C7. Synthetic review evidence shares the replay history, and expectations follow the shared halt-recovery and trunk text.
- `trackfix.test.ts`: VW2, C4. Missing fix nodes produce a no-single-command explanation instead of an executable command containing an invented fix node.
- `ux.test.ts`: VW1, C1, C4, R-028-51. Check the writer ruling in status and the complete owner review alternative in why/receipt text.
- `views020.test.ts`: VW1, C1, C4, R-028-51. Separate review repair's primary and owner alternative, reading the alternative from needs rather than summary JSON, while retaining driver repair, owner debt and acceptance checks. The driver notify assertion stays owned by drive28.
- `views028.test.ts` (new for views28): R-028-51 adds JSON-key compatibility, unmasked CUR-output counterexamples and driver merge-selection races with late review/approval blocks. Proc-04 uses the public approval-block operation; all halt-reason assertions remain exact. The existing multi-obligation case checks the original merge refusal text.
- `app026.test.ts`: VW1, C4. A ready node with old owner blocks explains the missing current candidate and has no single command. The active block and one-line need checks remain.
