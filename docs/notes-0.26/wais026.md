# Ready work, writes amendments and batch merges

## Behavior

Ready nodes skipped by the driver now explain the same dispatch predicate in `why` and the default status view. The explanation names overlapping nodes and writes scopes, the open-attempt limit, or the existing owner decision. Overlap explanations offer `dispatch --allow-overlap`. Same-pass reservations and removed nodes with open attempts still consume capacity. A live driver's `--max` override is used when available. Owner-needed ready nodes appear once in Needs-you, not again as a ready line.

`amend --writes` and `decide --writes` accept bare paths as additions, just like `+path`. `-path` remains refused: removing ownership requires a plan update. Already-owned paths report `already covered by <entry>`. An all-covered amendment leaves both the plan and ledger untouched; an all-covered decision still records its ruling and requested defer/resume, but records no plan entry and reports `writes unchanged`. Multiple named nodes must receive equal additions after covered paths are dropped; refusals explain each node's covered and added paths. Real widening retains the existing owner/allowance authority check. Paths covered only by an allow rule retain the existing grant-at-measurement route.

Default status omits clean candidate conflict pairs. Conflict paths and unavailable results remain visible; `--full` and JSON retain clean pairs.

Batch merges no longer abort solely because an unrelated node's plan specification changed during measurement. Every intervening plan is compared with non-member nodes removed. All global settings and every member field remain binding. Relevant changes refuse with the plan entry and changed part, including transient changes later reverted. The latest guard still runs, and trunk, slot and candidate checks are unchanged. Facts are recomputed after an unrelated plan change; an indirect change to measured facts, including quarantine activation, still refuses.

The same-model warning is unchanged: it compares the writer and reviewer models actually recorded. A deliberate same-model policy can be acknowledged with `drive.same_model: accepted`.

## Compatibility

No ledger entry kind, ledger field, plan key, replay state or obligation key changes. Status and why diagnostics are text-only; their JSON structure remains unchanged. The driver lock may record the existing `--max` override as runtime metadata. Older driver locks without it fall back to the plan limit.

The amendment result's `plan` and `rule` are absent for an all-covered no-op. Amendment previews/results expose covered paths and their enclosing writes entries; decision results expose them per named node.

## Known limits and interpretation choices

Every added path is a writes scope, including the prefix range of a bare path. Already-covered detection requires equality or proven scope containment for both concrete and wildcard additions; a filename glob match alone is insufficient, and uncertain containment is treated as a real widening. An allow rule is not an existing writes entry. All-covered amendments are pure no-ops, while decisions retain their explicit parent actions.

Dispatch diagnostics describe the current state's next dispatch pass, not a promise of a later launch. Drivers predating runtime max metadata cannot expose a command-line override. Other callers of `statusView`, outside the current status summary and why paths, use the plan's `drive.max` rather than a live command-line override. Uncertain batch input equivalence refuses instead of reusing measurements.

## Changed existing tests

- Amendment file-layout/carry/ruling test: update the already-owned path's output from `already in writes` to `already covered by`.
- Amendment refusal test: bare additions and already-owned paths are no longer errors; retain removal refusal and all unrelated refusal cases. New behavior is covered by the dedicated feedback regressions.
- Amendment list-style test: append an uncovered path in the quoted flow list to retain quote/layout coverage, alongside the literal-prefix no-op assertion.
- Amendment CAS-retry test: assert that real widening produced a plan before inspecting it, because no-op amendments now omit that result field.
- Compact plan/amend/edit reply test: likewise assert the plan exists for real widening before inspecting owner attribution; compact reply expectations are unchanged.
