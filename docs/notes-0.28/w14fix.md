# W14 gate fixes (0.28 WF)

## Changes

- WF1: `src/needs.ts` changes only `plain()` to return `oneLine()` of its existing result. Recorded halt/detail text escapes control characters instead of breaking Needs-you lines and compact why headlines. Need membership, commands, gates, ledger and keys are unchanged.
- WF2: `src/views.ts` changes only `quarantineDebt()`: return early when no active quarantine entry matches; lazily collect trunk/merge observations once; reject observations lacking both explicit `quarantine_passed` and complete TAP execution before historical-plan lookup. The existing debt mapping and remaining predicate are preserved. Net `src/` change: +4 lines, authorized by R-028-74/73.
- R-028-76 (ledger #3366): compact why keeps its existing `; nothing outstanding` / `; <N> outstanding` suffix. Its test asserts an independently written full first line; the status Needs-you row still ends with ` → owed resume a`. No headline renderer change.

## New tests (`test/w14fix.test.ts`)

1. `WF1: a driver halt with multiline evidence yields escaped one-line resume need text` — raw LF/CR absent, escaped LF/CR present, exact independent expected text and resume command.
2. `WF1: the status Needs-you row is one physical line ending in owed resume` — exact rendered Needs-you row, not the separate progress row.
3. `WF1: the compact why headline is one physical line with resume and the unchanged outstanding suffix` — exact independent expected headline per R-028-76.
4. `WF2: quarantineDebt without quarantine makes zero historical plan lookups after reduce` — twelve deep-frozen plan versions, observations under early laws, at most five retained plans, actual lookup counter reset only after reduce. Base performs two further lookups; head performs zero.
5. `WF2: active invariant and check quarantine preserve full passing debt receipts` — full invariant and batch-check debt objects, including passed seq/commit/batch/note; explicit native passing evidence remains visible despite later error observations; fix filtering preserved. This compatibility fixture passes on both base and head.

Existing test changes: **none**.

## Evidence

All Node/TypeScript execution used `/tmp/owed-ipc/run.sh` in the foreground, with explicit timeouts. Logs are under `/tmp/owed-ipc/logs/`.

| Log | Command / result |
| --- | --- |
| `w14fix-1-114706.log` | Initial new-test fixture check: 2 pass / 3 fail. One task headline conflict resolved by R-028-76; two new-fixture construction errors corrected. No existing test ran or changed. |
| `w14fix-1-114853.log` | Corrected new tests: 5 pass / 0 fail, exit 0. |
| `w14fix-base-114912.log` | Detached base c68f1316be65 with only the new test copied: 1 pass / 4 fail, exit 1; all three WF1 assertions and WF2 lookup assertion fail with ERR_ASSERTION. Compatibility fixture passes. Base worktree removed afterwards. |
| `w14fix-1-114940.log` | Pre-note typecheck: exit 0, no TypeScript diagnostics. |
| `w14fix-1-115006.log` | Pre-note packet check: 164 pass / 0 fail, exit 0. |
| `w14fix-1-115201.log` | First full suite, before commit: 1790 pass / 0 fail, exit 0; 1224602.568838 ms. |
| `w14fix-final-typecheck.log` | Final committed clean-tree typecheck log alias: exit 0, no TypeScript diagnostics. |
| `w14fix-final-check.log` | Final committed clean-tree packet-check log alias: 164 pass / 0 fail, exit 0. |
| `w14fix-final-suite.log` | Second and last full-suite log alias, final committed clean tree: 1790 pass / 0 fail, exit 0. |

Final aliases resolve to the original timestamped run.sh logs; their identity headers must show `dirty=0` and `tree` equal to the submitted commit's tree. Exact timestamped filenames and submitted commit/tree are returned in the writer handoff. No final candidate is submitted unless these checks match.

Commands:

- Typecheck (900 s): `npx tsc --noEmit -p .`
- Packet check (1500 s): `node --test --test-concurrency=2 --test-reporter=tap test/w14fix.test.ts test/needs.test.ts test/needs-structure.test.ts test/views028.test.ts test/drive028.test.ts test/halt-quiet.test.ts test/quarantine.test.ts test/qsets.test.ts test/trackfix.test.ts test/summary.test.ts test/notices.test.ts`
- Red on base (900 s): `node --test --test-concurrency=2 --test-reporter=tap test/w14fix.test.ts`
- Full suite (1800 s): `node --test --test-concurrency=2 --test-reporter=tap test/*.test.ts test/*/*.test.ts`

The parent's W14 replay/equivalence numbers are background evidence, not measurements performed by this leaf. This leaf does not merge, publish, or declare release acceptance.
