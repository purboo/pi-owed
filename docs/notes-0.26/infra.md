# Setup failures

A failed counted check or invariant that produced no test result is treated as a setup failure, not evidence of a behavioural regression. Timeouts, executor errors, failed test names and runs with test results are excluded.

Single-node merge-tree and trunk invariant setup failures receive one automatic same-key remeasurement, even without `remeasure_on`. Node-check setup failures use the driver's attribution rerun. The retry budget remains durable and measurement leases and locks are unchanged.

If the next executor measurement of the same subject, obligation and exact key is a counted pass meeting the original specification with no failures, it resolves that one setup failure. No conflict, flaky block, owner waiver or debt is created by the pair. Other failures on that key still bind. An insufficient count, uncounted pass or repeated setup failure cannot resolve it. Repeated checks must provide qualifying results for every executed run.

Merge refusals and node-check halts identify the normalized setup error, suggest fixing the environment and then `owed decide <node> --remeasure`, and do not suggest rebasing as a remedy for setup failure. Merge-guard refusal halts reach the follower as Needs-you wakes. Matching setup errors on different subjects within the diagnostic window produce one repository notice per signature and trunk commit; the notice changes no gate.

Full why cards retain the setup failure labelled `infra`. Metrics report resolved setup failures by obligation. No new plan keys or CLI flags are introduced.

## Compatibility

`obs.infra` is a new optional field referencing the resolved setup failure. Older readers refuse ledgers containing this field: upgrade all CLI, plugin and driver readers before an executor records it. No new ledger entry kind is added. Ledgers without the field retain their existing replay states and conflict rules.

## Known limits

Setup signatures normalize volatile paths and identifiers for diagnostics only. They do not prove the environment caused the failure: resolution requires the counted pass on the exact key. Batched merge observations do not use setup pairing or automatic setup retries. Missing captured output cannot establish a shared signature.

## Changed existing tests

- The legacy parent-act metrics test now separates the new infra field before checking historical values, and asserts the empty infra metric explicitly.
- The batch invariant refusal test still requires unattributed batch evidence and a fresh single-member measurement; it now also requires the single member's bounded setup retry and verifies that neither failed run is resolved.
- The anonymous remeasure-needle test now accepts the zero-result setup followed by a counted pass and verifies its infra link. The named-failure case still requires conflict, and both retain literal matching checks.
