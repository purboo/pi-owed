# RO: invariant remeasure_on (0.21)

## User-facing behavior

An invariant may set `remeasure_on: ["browser fixture timed out", "connection refused"]`.
Entries must be non-empty strings; this key is refused on node checks. An empty array disables automatic remeasurement.
Substrings are literal and case-sensitive, not regular expressions.

A failing merge-tree or trunk invariant measurement is remeasured once on the same key when every parsed failure's first error line or expected/actual diagnostic contains a configured substring. Test titles and passing-output tails cannot authorize a parsed-test retry. When no test was parsed, only the last 20 output lines are matched. Unavailable error text or an incomplete capped failure list does not authorize a retry. Error verdicts (including timeouts and execution failures) do not trigger this policy.

Both observations remain in the ledger. With `repeat`, all runs use the existing pooled threshold; the latest passing observation does not override earlier failures. Without `repeat`, pass plus fail remains an owner conflict. Merge refusal and driver halt quote both votes and direct the owner to fix the invariant or defer debt for the specific node, not to repeat the exhausted automatic retry. Trunk obligation details and the status Needs you summary also quote both votes. Per owner ruling #2097, automatic conflicts count as negative evidence on unchanged as well as changed keys: merge and adopt must refuse until owner resolution (a specific-node defer allows that merge without clearing ledger debt). Known-red and trunk-comparison logic never treat the conflict as a measured pass.

Automatic retries retain the caller's machine lease and existing outer measurement lock. Measurement commands never run under the ledger append lock. Merge/adopt final CAS and per-job currentness checks still discard stale results; aborted commands never advance trunk. The retry is not an attribution rerun and clears no observation.

## Plan keys and CLI

- New invariant-only plan key: `remeasure_on: string[]`.
- No new CLI flags or ledger entry kinds.
- Existing `attest --remeasure`, trunk refresh/genesis measurement, merge and adopt use the same automatic policy on eligible failures. Explicit manual remeasurement remains possible after the automatic budget is consumed.
- `remeasure_on` is scheduling policy, not part of the invariant measurement key: changing it neither removes old failures nor resets the automatic budget on an unchanged key. A changed invariant key has a fresh budget.

## Ledger fields and Compatibility

- Optional `obs.auto_remeasure: true` marks the second observation that consumed the automatic retry for that invariant key. Only true, non-attribution invariant observations are valid. Replay requires the immediately preceding same-key observation to be a non-automatic fail whose recorded full error texts all match the current plan's remeasure_on, and rejects a second automatic marker on that key. The marker is durable across CLI/driver restarts and replay.
- Optional `obs.remeasure_errors: string[]` carries full untruncated matching text for every parsed invariant failure, or a single last-20-line anonymous output tail. It is recorded on failures measured with remeasure_on enabled, enabling deterministic blob-free provenance validation. Display error grouping remains truncated separately. A receipt lacking this evidence cannot authorize an automatic marker.
- Old ledgers remain unchanged and replay with existing verdict aggregation.
- Owed 0.20 refuses an observation carrying this unknown field instead of misjudging it. Upgrade every CLI, driver and plugin before enabling `remeasure_on`. Older plan parsers silently ignore the new plan key and do not retry.

## Existing tests changed

None. Added `test/remeason.test.ts` with ten behavioral tests (three regression tests added for review block #2094 / ruling #2097) using `test/helpers`, CLI/ops, replay/verify and the driver.

## Checks (all on bench; no local node/npm/tsc/tests)

Current source/test tree:
- Focused: `/tmp/owed-bench/run.sh /work/pi-owed/.owed/wt/remeason-1 900 "node --test --test-reporter=tap test/remeason.test.ts"` — exit 0; 10 tests passed. Log `/tmp/owed-bench/logs/remeason-1-100635.log`.
- Typecheck: `/tmp/owed-bench/run.sh /work/pi-owed/.owed/wt/remeason-1 300 "node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit"` — exit 0. Log `/tmp/owed-bench/logs/remeason-1-100650.log`.
- Full (once): `/tmp/owed-bench/run.sh /work/pi-owed/.owed/wt/remeason-1 1800 "node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'"` — exit 0; 1116 tests passed. Log `/tmp/owed-bench/logs/remeason-1-100720.log`.
- Red: `/tmp/owed-bench/red.sh /work/pi-owed/.owed/wt/remeason-1 31a764d5a4d0 900 'ERR_ASSERTION|ERR_MODULE_NOT_FOUND|is not a function|SyntaxError|is not defined|Unknown|unknown' test/remeason.test.ts` — red shown; remote exit 1; all 10 tests fail on behavioral assertions. Log `/tmp/owed-bench/logs/remeason-1-red-100708.log`.
- `git diff --check` — exit 0.

## Deviations and known limits

- No semantic gate deviation. Small interpretations: empty list means disabled; matching is literal/case-sensitive; policy is not added to the measurement key; incomplete or unavailable failure diagnostics fail closed.
- The policy does not retrospectively remeasure a cached failure; it reacts to a measurement made by the current operation. Explicit `attest --remeasure` can measure cached failures.
- No new special crash-recovery reservation: the durable one-key budget is consumed when the automatic observation is recorded. Existing abort/CAS semantics discard interrupted or stale results; a process dying before append leaves no completed retry receipt.
- SG's sibling changes may alter displayed failure quotes/signatures; the matching helper consumes original error text and expected/actual diagnostics, not signatures or display-note tails. Parent integration must validate shared-file composition, including batch merge's new measurement path.
