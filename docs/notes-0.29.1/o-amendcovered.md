# o-amendcovered — AC1

Scope: allow-covered paths are reported and skipped like existing writes. A decision still records its ruling with the required grant note; only uncovered paths enter a new plan. An all-covered amendment succeeds without recording and points to decide --writer for delivery of a limit. Existing path-containment, authority, lock, CAS, append and rollback rules are retained. No ledger-format change.

Files: src/ops.ts, src/cli.ts, src/extension.ts, test/amendcovered.test.ts, test/amend.test.ts, test/decide.test.ts, test/parentops.test.ts, test/needs-structure.test.ts, docs/SPEC.md, and this note.

Existing-test changes authorized by AC1:

- test/amend.test.ts, N3/PO1 authority: CLI and pi tool all-allow-covered amend change from refusal to successful no-op; file/ledger immutability and uncovered-path refusal assertions remain.
- test/decide.test.ts, DC1 authority: all-allow-covered writes change from not-needed refusal to one ruling with the grant note and no plan; subagent and authority boundaries remain.
- test/parentops.test.ts, PO1 covered amend: CLI all-covered amend changes from exit 1/not-needed refusal to exit 0/covered report plus decide --writer guidance. File/ledger immutability, packet, measured grant and mixed uncovered-path authority assertions remain.
- test/needs-structure.test.ts, PR2 registered inventory (R-0291-4, ruling #3481): add exactly one help/usage site for src/ops.ts/amendLimitText, literal `; owed decide ${r.node} --writer delivers a limit`, SHA256 5e8ef112db1bc85a74cb2d4539a3849149a888d11dd33dcf500aac5d459f5be3. Reason: AC1 successful amend receipt guidance, not needs selection. Scanner, assertions, negative fixtures and other registered entries are unchanged. R-0291-4 also approves converting this note to English.

New test/amendcovered.test.ts covers all-covered decide with resume, mixed additions, successful all-covered amend, existing writes, no-resume, another node's allowance, invalid paths, empty limits, dirty plan files, unequal multi-node additions, and identical recorded/sent/retried answer text.

`git diff --stat bbf43fe -- src`:

```
 src/cli.ts       |  2 +-
 src/extension.ts |  2 +-
 src/ops.ts       | 17 +++++++++++------
 3 files changed, 13 insertions(+), 8 deletions(-)
```
Net source growth: 5 lines, below the +40-line budget.

Validation (all node/tsc/tests run only through /tmp/owed-ipc/run.sh):

- Final `npm run typecheck`: exit 0; /tmp/owed-ipc/logs/o-amendcovered-1-135217.log.
- Focused `node --test --test-reporter=tap test/amendcovered.test.ts test/decide.test.ts test/allowances.test.ts test/amend.test.ts test/parentops.test.ts`: 51/51, exit 0; /tmp/owed-ipc/logs/o-amendcovered-1-130626.log. Subsequent changes only add the R-0291-4 inventory site and update these notes; the same focused tests also pass in the final full suite.
- Failed-check regression `node --test --test-reporter=tap test/english.test.ts test/needs-structure.test.ts`: 8/8, exit 0; /tmp/owed-ipc/logs/o-amendcovered-1-135202.log.
- Final full suite `node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'`: 1889/1889, exit 0, no skipped/cancelled tests; /tmp/owed-ipc/logs/o-amendcovered-1-135238.log. Duration: 1286065.572512 ms. Final regression, typecheck and full suite tested tree 77ee6cdb338537f043d63c957e088922eb6147ff. Only this English receipt was updated afterwards; src/, test/ and docs/SPEC.md remain identical to that tested tree.
- Earlier full suite: 1887/1889, exit 1 (not timeout); /tmp/owed-ipc/logs/o-amendcovered-1-130651.log. Both failures are resolved: these notes are now English, and R-0291-4 authorizes the exact AC1 success-receipt guidance site. No check was weakened and no failure was waived.
- Red check: /tmp/o-amendcovered-red-1 is an isolated bbf43fe checkout with the same new test copied in. `node --test --test-reporter=tap test/amendcovered.test.ts`: exit 1, all 6 tests fail; /tmp/owed-ipc/logs/o-amendcovered-red-1-125629.log. Tests 1, 3, 4 and 6 fail on the old not-needed refusal; test 2 fails because allow-covered paths are still added; test 5 fails on premature not-needed instead of unequal multi-node additions. Required red tests 1 and 3 are demonstrated.

No known remaining check failures. The writer commits this result and submits o-amendcovered for parent review; branch acceptance and release remain with the parent.
