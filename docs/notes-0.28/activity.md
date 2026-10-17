# Measurement activity

Attest calls now publish invocation-scoped runtime activity before waiting for the machine lease. The activity remains queued until the operation lock is held, becomes running under that lock, and disappears after the invocation actually finishes. Concurrent calls in one process retain separate records; lease re-entry uses the same invocation record. Interrupted calls retain their activity until abort cleanup finishes, and readers remove records whose processes have died.

Activity distinguishes candidate-tree checks and writes from other measurements. Candidate-tree attribution is included while it runs. Genesis, trunk attests, trunk probes, invariants, counterfactuals, old-content attribution and gaps between jobs do not claim a candidate measurement. A queued invocation selects its scope after acquiring the lease and operation lock, so a submission made during that wait is not confused with the earlier candidate.

The shared runtime assembler reads these records and the existing still-asking cache. Answer retry activity is included only for a known running driver, including a foreign driver lock, with the existing attempt, question revision and grace rules. Unknown driver state remains unknown; stopped-driver caches do not produce answer activity.

No new CLI flags or plan keys are required. Existing lease opt-outs, busy refusals, lock order, job selection, observations and acceptance gates are unchanged. Runtime activity adds no ledger fields and does not change replay or evidence keys. Rendering and notification suppression are supplied by the later needs, views and driver integration.

## Known limits

Runtime activity is not acceptance evidence or a prediction of the driver's next action. Unreadable or malformed records are ignored. Process liveness is local; forced termination can leave a record until a reader notices the dead process. Still-asking cache interpretation intentionally preserves the existing running-driver semantics.

## Changed existing tests

None. Existing tests and their expectations remain unchanged.
