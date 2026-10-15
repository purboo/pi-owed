# 0.23 node `shared` — FS: shared failures are a repository condition

## Reproduction (app ledger, read-only)
`merge refused: trunk/inv:kernel-tests …` (#13287/#13388/#13411) is the scoped merge guard's
`invariantDebtReason` ("invariant kernel-tests new debt: requires a measured pass on the merge key or owner defer") on
the node's MERGE key; the `trunk/inv:` prefix only names the failing evidence (merge-tree observations are recorded
with `subject: trunk, merging: <node>`). #13287/#13388 were ⊤ (fail + pass on one merge key), #13411 ✘. Every pure
trunk observation of kernel-tests passed; `phys_finish_lock_renew_half_second_lease_survives_six_second_finish` failed
only on OTHER nodes' merge trees (#12554, #13266, #13336, #13368, #13403, #13507, #13521, #13625, #13635), and none
of those cargo observations carried `signatures`.

## Parent ruling (question 59f36934, recorded as an owed ruling on node `shared`)
1. A "trunk observation without <node>" also includes a non-batch merge-tree observation of another node M ≠ N
   (`merging: M`) measured while N was unmerged (that tree lacks N's change).
2. Cargo failures get signatures: panic message + panic location, through the existing v2 signature format.
3. Name-only matching: when NEITHER side recorded a signature for a name, an identical name (test-only, complete
   names) counts as shared for FS1–FS5 only, and texts add `(same name; no error signature recorded)`. FS6 always
   requires matching signatures; a signature on one side only never matches.

## Parent ruling 2 (#2458, on review block #2449)
- F2: a trunk-red park (FS3(b)) requires `trunkKeyUnchanged(s, node, X)` (no changed path of the candidate matches
  X's reads or the plan closure), never the absence of a merge-tree observation. `ops.parkedRefusal` additionally
  requires, per refused invariant: trunk-red → reason `owner conflict` and the guard's merge key = trunk key = park
  key; shared → the measured key = the guard's merge key. Everything else is a mixed refusal and halts as before.
- F1: trunk-red parks get an FS4 notice (once-key `trunk\0<obligation>\0<sorted names>\0<trunk commit>`, text
  `trunk red: <obligation> <names> fails on trunk <trunk12> (#F[, pass #P: owner conflict]); waiting: …`), which is
  a driver notify (wakes the next session once per key) and one `summary.needs` trunk item.
- FS2: no shared-only automatic remeasure for invariants with `repeat` (ops and replay); `remeasure_on` unchanged.
- Tests added: (i) notice/wake/needs in the FS3(b) test, (ii) reused merge-key own failure + trunk-key ⊤ halts,
  (iii) a node changing X's reads is neither trunk-red parked, excluded from batches nor kept waiting for a fix,
  (iv) repeat gets no shared-only retry (and replay refuses a forged one), (v) FS6 forged `node` outside the rule.

## What changed
- `src/reducer.ts` (FS block after `trunkRedText`): `sharedFailure` (definition + ruling), `sharedParked`,
  `sharedPersisted`/`sharedBoundText` (3-key bound), `sharedPhase`, `sharedParkKey` (level trigger),
  `sharedParkNotices` (FS4), `fixCandidates` (FH definition), `allowanceDeferDraft` + `executorDeferErrors` (FS6),
  `deferLabel`. RO2 replay (`auto_remeasure`) accepts a retry whose preceding failure is RO2-eligible OR shared.
  `mergeBatchPlan` skips shared-parked nodes. Defer replay: an executor defer must equal the derived draft exactly.
- `src/ops.ts`: FS2 in `automaticInvariantRemeasure` (`sharedDraft`); FS1 lead `sharedLead` replaces AT1 in
  `mergeTreeBreakLead`; FS3 `SharedRefusal` (an `OwedError` subclass carrying the parks) + `parkedRefusal`; FS6
  `allowanceDefers` in `merge` (defers kept only when the guard then passes; appended with the merge under the lock).
- `src/drive.ts`: `sharedWaiting` (park seen on this state, or waiting for an accepted fix) stops the merge row and
  prospective notices; repo notice from `sharedParkNotices`.
- `src/drive-run.ts`: a `SharedRefusal` reports `parked` (no halt) and remembers `sharedParkKey`; shared halts (bound)
  keep the FS1 lead instead of the `merge refused:` prefix.
- `src/drive-bg.ts`: `shared\0…` notices are revalidated at delivery like TP notices.
- `src/views.ts`: status phase, `summary.needs` trunk items, defer/ΔO⁻ labels `deferred by owed under allowance (plan #S)`.
- `src/exec.ts`: cargo panic headers with a thread id (`thread 'name' (1234) panicked at …`, Rust ≥ 1.86, the app
  format) are parsed; cargo signature location = panic location.
- `src/plan.ts`, `src/types.ts`: `allow[].defer` (invariant id globs).

## Compatibility
- New optional ledger field `defer.allowance` (number, executor defers only). Validated in `src/reducer.ts`
  (`executorDeferErrors`: principal, current allowance seq, covering rule, shared-with-signatures failure, same-key
  pass, exact reason); `newerEntry` now refuses unknown `defer` fields. An older owed refuses a ledger containing an
  executor defer (its `allow('owner')` check fails) — upgrade first.
- New plan key `allow[].defer` (array of non-empty strings); older owed rejects plans using it (unknown key).
- `obs.auto_remeasure` may now follow a shared failure without `remeasure_match`; older owed replays such a ledger as
  invalid ("requires the preceding same-key failure to match remeasure_on").
- Cargo observations now record `signatures` (existing optional field); keys are unchanged.
- No new field for parks/notices (derived).

## Deviations / interpretation choices
- FS2 is skipped when the trunk is already red with the same names (the latest earlier pure trunk observation on a
  different key failed with them): an IR2-inherited merge failure or a persistently red trunk gains nothing from a
  retry, and a pass would turn the inherited ✘ into a ⊤ that refuses the merge. Without this, IR1/IR2 tests broke.
- FS3(b) covers the trunk-key automatic conflict (⊤) found by the merge guard's refresh, only when the node's merge
  key provably equals the trunk key (ruling #2458); a trunk ✘ whose key equals the merge key never refuses a merge
  today, so it needs no park.
- Level trigger also includes this node's defers (an owner defer of the trunk key releases the node).
- FS5 "accepted" fix = open slot, accepted, not halted; a parked node waits while that holds.
- FS6 is applied by `owed merge` itself (driver and CLI), not only the driver.

## Known limitations
- `trunkKeyUnchanged` (ruling #2458) does not account for a change of the active quarantine set after other nodes
  merge, although the invariant key includes the quarantine names. The reducer may then show a trunk-red park (status,
  FS5 waiting, batch exclusion) while the ops merge guard computes a different merge key, refuses, and halts as a mixed
  refusal. Display and FS5 waiting can be inaccurate in that case; the gate itself stays correct (ruling #2485 (3)).
- Ruling #2485 (1): queued `trunk\0…` notices are revalidated at delivery in `drive-bg.ts` like `trunk-red\0`/`shared\0`.

## Checks
See the submit report (focused `test/shared.test.ts`, tsc, full suite, red check on 80d5e06286c3).
