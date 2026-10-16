# Native Cargo quarantine

Plain `cargo test --no-fail-fast` now supports native quarantine. Optional leading environment assignments and a `+toolchain` are accepted; shell operators, quoting and wrappers are not native runs. Names match exactly, including doc-test names, rather than acting as libtest substring filters.

Owed excuses only completed test-failure exits whose libtest output proves that every announced test has a result and every block has one consistent summary. Failed-target diagnostics must agree with the failed blocks. Compilation errors, crashes, incomplete output, duplicate failing names and unlisted failures remain failures. Excused names count neither passed nor failed, and the remaining tests must still meet `min_tests`.

Complete native Cargo measurements on trunk or merge trees can record `quarantine_passed`, the sorted active quarantine names that actually passed. This is informational and does not alter keys, verdicts or counts. Candidate-only measurements do not record this feedback. Existing ledgers without the field replay unchanged; older readers refuse observations containing the new optional field unless upgraded for the release's reader compatibility support.

Known limits: terse output, truncated output that cannot prove completeness, and more than fifty failures are not excused. Ignored tests are not reported as passing. Scripts that skip names cannot prove that skipped tests have recovered.

## Changed existing tests

- `MS4 fail-closed (#1907/#1925 rulings): excused only for a plain complete node --test run that exits 1`: replaces the obsolete blanket Cargo refusal with incomplete-block and missing-no-fail-fast refusals. Its existing TAP expectations are unchanged.
