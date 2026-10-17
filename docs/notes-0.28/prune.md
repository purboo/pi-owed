# Prune: remove duplicate remedy builders

This change removes old selectors superseded by the unified need interface and reroutes command builders that still have callers. Status, why, brief, reports, driver notices, wakes and errors keep their existing text. There are no new commands, flags or plan keys, and acceptance gates, candidate keys, historical ledger replay and driver action selection are unchanged.

Existing entry points re-export the moved functions. The old whole-node command collection is removed; callers use each need's primary command, same-item alternatives or itemLine instead. Old logs retain compatibility parsing; new logs continue to use structured need identities.

## Known limits

Some remedies remain in reducer.ts to avoid new runtime import cycles. Result hints that depend on shared helpers in other modules also stay in their original locations. Each exception is registered by exact literal, not by a whole-file or whole-function exemption. Incomplete-batch recovery under the lock and test observation hooks are unchanged.

## Changed existing tests

- `test/halt-quiet.test.ts`, E3.2: R-028-59(5) permits removing assertions specific to ownerCommands' old identity selection. The test uses the need's primary command and owner-review alternative; brief text and confirmation-environment invariance assertions remain.
- `test/bind.test.ts`, G1.3: under R-028-59(5), needs supplies the complete candidate-pinned approve/evidence commands. The routine-review waiver assertion specific to the removed collection is deleted; brief/reviewer-packet candidate binding and block-clear assertions remain.
- `test/trackfix.test.ts`, TF2: under R-028-59(5), need commands replace the old collection and still assert the same tracked-by fix text. Status, why, repair, wake and uncleared-risk assertions are unchanged.
- `test/perf/differential.ts`, snapshot: under R-028-59(5), only the removed ownerCommands query field is deleted. Other state, key, gate, receipt, status, brief, review-packet and fault-injection comparisons remain.

## Maintenance appendix (R-028-60)

`wc -l src/*.ts` totals: **16282** at the 0.27.2 baseline `2a5f1a8`; **16787** at slot base `bd5529d1a725`; **16680** in this candidate. This is **107 fewer** lines than the slot base and **398 more** than 0.27.2. Code was not compressed to reach a number; the parent decides the release's net-line gate under R-028-59(6).

Actually deleted symbols:

| File | Symbols |
| --- | --- |
| `src/views.ts` | `reviewNeed`, `repairingBlock`, `repairNeedsOwner`, `itemNext`, `clearHint`, `ownerCommands`, `decisionCommand`, `ownerAs`, `waiveCommand`, `dispatchHint`, `candidate12`, `candidateFlag`, `obligationFlag`, `resumeHint` |
| `src/ops.ts` | `applyStillAsking` |
| `src/remeasure-on.ts` | `matchesRemeasureOn` |

`resolveText`, the old summary selection and the new-log plainNeed path were already absent at the slot base and are not counted again. `completeBatchTail` and `batchTailProbe` are preserved unchanged under R-028-60.

Moved, not deleted: `writerDecisionCommand`, public `writerStopNeed`, `reviewDecision`, public `trunkDecision`, `evidenceCommand`, `resumeCommands`, `flakyRuleHint`, `lapsedKnownRedText`, `genesisLine`, `readyHintText`, `idleWaitText`, `driftNotice`, `trunkAfterBaseText`, `rejectedFixed`, `rejectedHalt`, `answerRetry` and its private `shell`, `rebaseRecovery`, `setupHint`, and `thresholdHint`. Dispatch-overlap and sweep escape commands are extracted into pure builders; sweep's private `quote` moves with its command as `sweepQuote`.

The two trunk texts differ: public `trunkDecision` keeps the original views text; needs' existing private function is only renamed to `trunkRepairText`. Likewise, needs' writer-stop parser is only renamed to `needsWriterStopNeed`, preserving its existing quoting semantics.

Runtime imports in needs.ts: at slot base, `plan.ts`, `clock.ts`, `reducer.ts`, `answer.ts`, `exec-wrap.ts`; in the candidate, `plan.ts`, `clock.ts`, `reducer.ts`, `exec-wrap.ts`. New views/git/drive-run/rebase-view references are all `import type`; no runtime import cycle is added.

Interpretations: under R-028-64, `setupSignature` used by `setupNotices` has other callers, so both `setupNotices` and `recentSetupFailures` stay unchanged in drive.ts, classified as cycle-blocked remedy. `environmentText` also stays because `clip` has other callers. PR2 registers each full raw literal by SHA-256, file, outer function and occurrence count rather than duplicating large help text. Negative fixtures cover copied sites, new literals in registered functions, double quotes, nested templates and escaped literals.
