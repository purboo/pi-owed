# Measurement cost diagnostics

`owed report --cost [--since <seq|ISO>] [--json]` reports checks and invariants ordered by total measured machine time. Each obligation includes runs, total duration, median, nearest-rank p90, failures, setup failures separately, and total machine-lease wait. JSON durations are milliseconds; text durations are seconds. Checks sharing an obligation id are aggregated across nodes. Repeat observations count as one execution observation, whose recorded duration includes its repeat runs.

Invariant rows also show how many recorded merges measured that invariant rather than reused its key. Successful batch measurements count for each member merge. The invalidating-prefix list groups changed files by their first two path segments, restricted to the invariant's recorded `reads`, between consecutive distinct measured trunk keys. A prefix counts at most once per key transition; same-key retries do not add invalidations. A window retains the preceding historical key for its first comparison. Refused merge trees consume machine time but do not become trunk samples. The highest-cost invariant receives advice to narrow reads when one prefix occurs in more than half of its distinct measured trunk-key samples.

Plan admission warns when a check or invariant reads `**` or at least 90% of tracked trunk files. Check reads overlapping `closure` also warn that checks see the base version of those files. Lint lines use the existing `warning: ` prefix. Identical warning lines are emitted once in a plan record's receipt, not written into the ledger. An unchanged `owed start` does not repeat these cost warnings.

Default `owed status` warns when an invariant's latest executor trunk pass took at least 80% of its configured timeout. Successful merge-tree passes become trunk samples when their tree lands; unlanded passes do not. Plan lint repeats the warning when a plan is recorded. These warnings are diagnostic, not new obligations or debt.

## Compatibility

No plan keys, ledger entry kinds or ledger fields are added. Existing ledger states and acceptance keys are unchanged. The new report mode is mutually exclusive with metrics and counterfactual reporting; its since boundary is exclusive. Status JSON adds optional `runtimeWarnings` only when a slow-pass warning exists. Plan warning arrays can contain additional reads/runtime diagnostics.

## Known limits

Prefix attribution requires the measured Git commits to remain available. Changes outside reads, including command and closure changes, are not attributed to a reads prefix. Missing observations have no inferred runtime. Merge coverage counts recorded successful merges, not refused attempts, and excludes measurements reused from an earlier tree. Setup failures are classified from recorded test counts, failed names and timeout/error evidence; this report never resolves a failure or changes a gate. Closure intersections use tracked paths and explicit literal closure entries; no synthetic file is invented for two globs whose intersection has no tracked path.

## Changed existing tests

- H2.2 CLI init/plan warning test: exclude the independent reads diagnostics when asserting check-less warning ordering and emptiness. All check-less warnings and ledger assertions remain required.
- H2.2 Pi init/plan warning test: the same separation for tool warning arrays and text ordering, preserving the original check-less behavior assertions. The check-less-only text list selects `warning: node` so it remains distinct from cost lint.
- L3.3 plan loop warning test: exclude the independent reads diagnostics from the empty-warning assertion after the loop is removed; the loop-warning placement and disappearance remain required.
