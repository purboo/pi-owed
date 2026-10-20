# p-attrib — 0.31.1 PA1–PA3

Scope: `src/git.ts`, `src/ops.ts`, `test/attrib0311.test.ts`, changed contract assertions/registrations in `test/attrib.test.ts` and `test/needs-structure.test.ts`, and `docs/SPEC.md`. Base: `590bdca9940e8e20fe1419f7d167219a2af5cfa7`. Source budget: net +100 lines.

## Behavior

- PA1 recognizes CJS/ESM `Cannot find module '<path>'` diagnostics; bare names without `/` are excluded. The existing checkout containment, candidate addition and trunk absence proofs remain required.
- PA2 compares unnamed merge/probe failures using the last line matching the specified error expression, otherwise the last nonempty line. Roots and whitespace normalize before comparison of the complete lines. Different lines produce the existing `error` verdict with a bounded, escaped note. Named failures, identical lines, either missing line and unreadable blobs keep the existing classification. Reducer, ledger fields, keys and gates are unchanged.
- Parent ruling R-0311-PA-1 allows callers to pass the actual merge observation and runtime root to `runTrunkProbe`, where classification remains. Historical logs normalize `<ledger.dir>/trees/<one segment>/` in original and canonical forms. No root metadata is persisted.
- PA3 compares base→trunk and base→candidate paths. Overlap recommends rebase, with up to two bounded, escaped paths and a remaining count. No overlap recommends `owed decide <node> --writer --text "<repair instruction>"`: plain resume can retry the same merge after an invariant-only failure. Git errors retain the old hint.

## Changed existing tests

- `test/attrib.test.ts`: the shared `LEAD` and title of `AT1/AT2/PA3: a merge-tree break leads refusal, halt and Needs-you with path-aware advice; new tests are never probed on trunk`. Its candidate changes `t/own.test` while trunk changes `lib`; PA3 replaces unconditional rebase advice with writer repair because these paths do not overlap. Assertions still cover refusal, halt, Needs-you, retry and no trunk probe for new tests.
- `test/needs-structure.test.ts`: replace the single old `mergeTreeBreakLead` digest with the three exact PA3 literals (overlap, writer repair, Git-error fallback) under the same existing cycle-blocked-remedy classification. The inventory scanner and rejection assertions are unchanged; this records the contract's new advice without allowing whole functions or files.

## New regression coverage

The new file covers both app verifier/module-error shapes, CJS and ESM, absolute/relative/bare module paths, non-additions and files already on trunk; different/same/empty/named failures; last matching error selection and fallback; whitespace, long lines and control characters; fresh roots, historical trees roots and canonical symlinks; unreadable historical logs; overlap/no-overlap/Git-error hints; and a writer ruling after an invariant-only halt where the candidate remains accepted.

Concurrency/persistence: the new root map belongs to one merge measurement and is keyed by log digest. Classification occurs after `runJob` returns. Existing ledger locking, merge key/CAS checks and stale-observation handling are unchanged. There are no new asynchronous writers or persisted facts.

## Source size

`git diff --stat 590bdca -- src`:

```text
 src/git.ts |  3 ++-
 src/ops.ts | 43 +++++++++++++++++++++++++++++++++++++------
 2 files changed, 39 insertions(+), 7 deletions(-)
```

Net +32 lines, within the +100 budget.

## Validation

All Node, typecheck and tests run through `/tmp/owed-bench/run.sh`; none run on the host.

- Focused: `npm run typecheck && node --test --test-reporter=tap test/attrib0311.test.ts test/oprobe.test.ts test/attrib.test.ts test/measure023.test.ts`, exit 0, 54/54. Log: `/tmp/owed-bench/logs/p-attrib-1-012947.log`; tested tree: `4ab130a09d8837c3a050d38bdde013edc4946c18`.
- Earlier checks exposed a new-test import error, then four PA3 fixture failures (missing test counts triggered setup-failure priority; a launch used an invalid run id). Correcting those fixtures produced the passing result above without loosening product behavior.
- Baseline red: `/tmp/owed-bench/run.sh /tmp/owed-p-attrib-red-590bdca 600 "node --test --test-reporter=tap test/attrib0311.test.ts"`. Detached `590bdca` with only the new test file copied: exit 1, 13 pass / 12 fail. Log: `/tmp/owed-bench/logs/owed-p-attrib-red-590bdca-013135.log`; SHA256 `4bbf2a85184d1edae57fbe1cc26eac090c0485e845014a4a8fcb1454721743bf`. All 12 failures are expected behavior differences (PA1: 4, PA2: 6, PA3: 2), with no import, fixture or execution failures.
- Single-file green: `node --test --test-reporter=tap test/attrib0311.test.ts`, exit 0, 25/25. Log: `/tmp/owed-bench/logs/p-attrib-1-013142.log`; tested tree: `1fcfcb97fc9cedc5c35e687939530f406036bd77` (only this note was added since the focused check).
- Full suite: `node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'`, bench timeout 2400 seconds, durable run `01M5D5WXNMHYM660M5TAPV6ZMZ`; exit 1, 2119 pass / 2 fail, 1511.49 seconds. Log: `/tmp/owed-bench/logs/p-attrib-1-013213.log`, tested tree `1fcfcb97fc9cedc5c35e687939530f406036bd77`. Failures: the snapshot still contained the earlier Chinese draft of this note, and the three changed PA3 command literals needed exact inventory registration. The note is now English and the registration is updated; source behavior has not changed since the full suite.
- Follow-up: `npm run typecheck && node --test --test-reporter=tap test/english.test.ts test/needs-structure.test.ts`, exit 0, 8/8. Log: `/tmp/owed-bench/logs/p-attrib-1-015829.log`; tested tree `70586735d8f7e099c9aef1e36fe0e40a2a063c99`. This closes both full-suite failures. Only this result paragraph was updated afterward; no production code changed after the full-suite run. The entire suite was not repeated after the documentation/registration fixes.

Since the full-suite snapshot only this note and the exact command registrations have changed. Parent owns submit/attest/merge; this leaf does not run `owed submit`. Nothing published.
