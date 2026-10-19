# o-ask — SA1–SA3

## Scope and implementation

- Base: `1e8540ae5cdcf4d7a4e2b8b92d95b4f0e1754d94` (0.29.1); branch `owed/o-ask/1`.
- `RunQuestion` and fake describe parsing retain structured metadata without coercing objects into question text.
- `askingText` and asking wakes render DECISION, options, facts/tried/candidates, details, then the existing answer commands. Plain questions retain their original rendering path.
- Escape before clipping; retain whole Unicode code points and control-character escapes. Each option field is bounded to 160 characters, context to 600, and details to 300.
- Each question retains an independent CLI/tool answer command with its full qid; only display headings use the first eight qid characters.
- The shared `WRITER_DECISION` guidance changes exactly as specified by SA3; existing dispatch packets and writer follow-ups inherit it.
- No changes to ledger facts, scheduling, answer decisions, runtime membership, replay, or persisted message retry bytes.

## Parent rulings

- **R-030-SA-1**: Do not add open-question Needs or caches, or expand writes. Update askingText/asking wakes and preserve multiline structure in existing needs/status runtime answer-retry text. Adding unanswered questions to needs/status is outside 0.30.
- **R-030-SA-2**: An invalid options member drops the entire options field to prevent silently renumbering `option <n>` answers. Invalid optional properties of valid options are dropped independently; multiple preferred options lose all preferred markers. Invalid candidate members are dropped individually, and invalid optional properties of valid members independently; empty candidate results are omitted. Facts/tried retain string members only and omit empty results. Never use String(object).

## Existing tests changed and authority

1. `test/stopask.test.ts`: Update only the exact shared-guidance expectation authorized by SA3. Existing packet/rebase/repair/submit/ruling behavior assertions remain.
2. `test/needs-structure.test.ts`: Register the exact SHA256 of the new structured answer-guidance literal in askingText, retaining prior registrations. SA2 authorizes presentation changes; R-030-SA-1 preserves needs membership. No scan rule or function-wide exemption is relaxed.

New tests in `test/structask.test.ts` cover fake describe, valid/malformed fields, numbering safety, ambiguous preferred marks, byte-identical plain output, escaping/bounds, mixed multi-question wakes, production Driver notifications, existing runtime needs/status text, stale revisions, packet guidance, and a real rebase fixture.

## Review #3548 repair

Parent accepted reviewer:sol-ask030-1's rank-2 block on `f53483ce5a02590811fb82ee269de3b7223a8b15` as a correctness defect. Evidence: `/tmp/owed-ipc/logs/owed-review-sol-ask030-1-f53483-201142.log`. The old split matched any continuation containing `asks (qid ...): `, so legal option/detail quotations destroyed block structure and substituted generic answer commands.

Only genuine line-start askingText headers for the current node now start another block. Both emitted shapes are recognized: plain `<node>: <role> run <rid> asks (qid <qid>, rev <n>): ` and SA2 `<node>: <role> <rid> asks (qid <q8>, rev <n>): `. Node text is regex-escaped. Existing standalone legacy headers still render as before, but never create continuation boundaries. No askingText output, ledger, membership, revalidation, or answer-command semantics change.

Six additional tests cover option/detail quotations (including full plain-header quotations), writer/reviewer and single/multiple structured questions, the complete control block, and plain DECISION text with an escaped options line. Both production `need:null` and legacy plain notification paths are covered. No existing test assertions are weakened or changed in this repair.

Repair receipts (all node/tsc/tests through IPC):

- Final isolated red: `/tmp/owed-ipc/run.sh /tmp/owed-030/o-ask-3548-red 180 "node --test --test-reporter=tap --test-name-pattern='SA2/#3548:' test/structask.test.ts"`; log `/tmp/owed-ipc/logs/o-ask-3548-red-203502.log`, exit **1**, **2/6 pass, 4 fail**, tree `91bf98d69ecb0972bb583ef8e39a9b4be9a8922d`. Only the four quotation regressions fail; control/plain DECISION pass on f53483c.
- Initial repair focused check: typecheck passes, **156/157 tests pass**, exit **1**; log `/tmp/owed-ipc/logs/o-ask-1-203413.log`, tree `1f26ba0b8820b6df043fed657f2a653b0d9f257e`. The four quotation cases and all compatibility/audit tests pass. Its only failure was the new plain DECISION assertion's expected single escaping; the existing renderer double-escapes the literal backslash through oneLine. The assertion was corrected without changing production behavior, and is included in the final baseline red above. This failed snapshot is not a final pass receipt.
- Final focused checks: `/tmp/owed-ipc/run.sh <worktree> 600 "npm run typecheck && node --test --test-reporter=tap test/structask.test.ts test/dsa.test.ts test/stopask.test.ts test/answer.test.ts test/quiet025.test.ts test/needs.test.ts test/needs-structure.test.ts && node --test --test-reporter=tap test/english.test.ts test/drive-bg.test.ts test/views020.test.ts test/nits026.test.ts"`. Log `/tmp/owed-ipc/logs/o-ask-1-203637.log`, exit **0**, typecheck passes; exact o-ask node check **115/115 pass** (minimum 85), English/additional Follower/compatibility checks **42/42 pass**; no cancellations/skips. Snapshot tree `ff2cdab0c065140a912305b1b04a3f52775bdfdf`.
- Full suite, request `owed-b1da092bfb45-o-ask-1-3548-full`: `/tmp/owed-ipc/run.sh <worktree> 1800 "node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'"`. Log `/tmp/owed-ipc/logs/o-ask-1-203920.log`, exit **0**, **1921/1921 pass**, no cancellations/skips; duration 1284003.35419 ms. Snapshot tree `57bad5da43baccbfa61c7fbeb5d93a58bb342b12`.
- Final receipt-only notes scan before commit: `/tmp/owed-ipc/run.sh <worktree> 120 "node --test --test-reporter=tap --test-name-pattern='English shipped source, skill, README and documentation' test/english.test.ts"`, request `owed-b1da092bfb45-o-ask-1-3548-final-docscan`. Return the scan log and exact final tree with the commit handoff.

Source and test files match both final focused and full-suite snapshots and remain frozen. Only this receipt document changes after the full-suite pass; its final English scan must pass before commit.

## Source budget

`git diff --stat 1e8540a -- src`:

    src/drive-bg.ts    | 11 ++++++++---
    src/drive.ts       |  3 ++-
    src/dsa.ts         | 24 ++++++++++++++++++++++--
    src/needs.ts       |  2 +-
    src/rebase-view.ts |  2 +-
    src/types.ts       |  8 +++++++-
    src/views.ts       | 17 +++++++++++++++++
    7 files changed, 58 insertions(+), 9 deletions(-)

Net **+49 lines**, below this leaf's +100 budget. The drive.ts changes touch only its import and askingText, not the o-remeasure attribution filter.

## Original candidate validation history (superseded by repair receipts above)

All node/tsc/tests run through `/tmp/owed-ipc/run.sh`, never on the host. Long checks use durable command calls with `--wake caller`. Commands below use this worktree:
`/home/purboo/project/pi-things/pi-owed/.owed/wt/o-ask-1`.

### Baseline regression

- Isolated base checkout: `/tmp/owed-030/o-ask-red-1`, containing only the new test file on 1e8540a.
- Command: `/tmp/owed-ipc/run.sh /tmp/owed-030/o-ask-red-1 180 "node --test --test-reporter=tap test/structask.test.ts"`.
- Final log: `/tmp/owed-ipc/logs/o-ask-red-1-193935.log`, exit **1**, **1/9 pass, 8 fail**, snapshot tree `8027c8d5996a6e45c9701509c011c821e6243b0a`.
- Plain compatibility passes. All eight failures assert missing new behavior, not fixture/API errors. Stale revisions are already dropped correctly on base; the replacement wake lacks DECISION.

### Typecheck and focused regressions

- Command: `/tmp/owed-ipc/run.sh <worktree> 600 "npm run typecheck && node --test --test-reporter=tap test/structask.test.ts test/dsa.test.ts test/stopask.test.ts test/answer.test.ts test/quiet025.test.ts test/needs.test.ts test/needs-structure.test.ts"`.
- Log: `/tmp/owed-ipc/logs/o-ask-1-193936.log`, exit **0**, typecheck passes, **109/109 tests pass**; snapshot tree `eb162a5dc9b3d78ff43265b792f59be6579d86be`.
- Earlier fixture failures were corrected before this pass: rebase precondition (`o-ask-1-193021.log`, 107/108), then revalidator call signature/mock cast (`o-ask-1-193748.log`, exit 2 before tests). These are not passing receipts.

### Full suite and documentation repair

- Command: `/tmp/owed-ipc/run.sh <worktree> 1800 "node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'"`.
- Request: `owed-b1da092bfb45-o-ask-1-full`.
- Log: `/tmp/owed-ipc/logs/o-ask-1-194047.log`, exit **1**, **1914/1915 tests pass**, zero cancellations/skips; duration 1328457.851249 ms; snapshot tree `6d5ee0a9defa04c7511eb31412ad0c8ee7c9b331`.
- The only failure is `English shipped source, skill, README and documentation` in `test/english.test.ts`, identifying Chinese text in this notes file. Source and behavior tests all pass; this was a documentation error, not a baseline/flaky failure.
- Repair: rewrite only this notes file in English. Do not weaken the English test. Reuse the full suite's unaffected source/test receipts and rerun the affected English tests through IPC; no second full-suite run is needed for a documentation-only change.
- English recheck: `/tmp/owed-ipc/run.sh <worktree> 180 "node --test --test-reporter=tap test/english.test.ts"`, log `/tmp/owed-ipc/logs/o-ask-1-200348.log`, exit **0**, **3/3 pass**, snapshot tree `3b71a64f0c77254893f845afda2af12534592951`.
- Original candidate's final documentation scan: `/tmp/owed-ipc/run.sh <worktree> 120 "node --test --test-reporter=tap --test-name-pattern='English shipped source, skill, README and documentation' test/english.test.ts"`, log `/tmp/owed-ipc/logs/o-ask-1-200436.log`, exit **0**, **1/1 pass**, tree `22bfc8e1ff8df228355a29b4607ff22c6d17fd88`. This is historical evidence for f53483c, not the #3548 repair.
- `git diff --check` passes. No known failing candidate will be committed.

## Limitations and delivery

No live dsa 1.2 provider integration was run; the contract uses fake describe replies plus real owed Driver/ledger/git fixtures. No submit, attest, merge, or publication is performed by this leaf. The parent explicitly owns those steps. The first candidate was committed as f53483c and blocked by review #3548. The bounded repair now passes the requested red/green regressions, typecheck, exact node checks, English/needs-structure audits, and full suite. Commit after the final receipt-only scan passes; return the actual commit/tree, src/test subtree SHAs, counts, logs, and clean status in the handoff. Independent review and branch acceptance remain the parent's responsibility.
