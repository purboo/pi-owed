# o-trackhelp — TB1 / HP1

- Base: `1e8540ae5cdcf4d7a4e2b8b92d95b4f0e1754d94`.
- Scope: external waiver trackers and per-command help. No ledger field, entry kind, plan or obligation-key changes.
- TB1: append and replay accept `ext:<id>` with exact alphabet and length validation. A matching plan node takes precedence. Presentation uses the plan in force at the waiver entry, preserving historical local/external meaning through plan changes.
- Parent clarification: an external tracker has no tracker node. Show its debt as `tracked by ext:<id> (external)` only in the waived node's compact/full why, plus summary debt, full status and report. Local trackers retain the 0.29.1 tracker-node why behavior. Unrelated why output does not show external debt.
- Ruling R-0292-TH-1: dispatch's safe-id check at `src/ops.ts:1229` rejects `:`, so real ledgers cannot contain slots, candidates or merges for `ext:x` nodes. Preserve that safety rule and do not fabricate historical dispatches. Both "local ext:x tracker settles after merge" and "later same-name external tracker node merges without settlement" are unreachable and are not tested. Tests cover reachable plan membership, local validation/why, historical local interpretation after removal, and external interpretation/replay after adding/removing a same-name plan node. The reachable self-tracking refusal occurs before candidate lookup.
- HP1: extract every command form from the original `HELP`, splitting only at newlines or ` | ` followed by a known command. The existing `allowed` table supplies accepted flags, with global flags appended. Both help entry points return before repository I/O; unknown help commands name the known commands.
- New tests: `test/trackhelp.test.ts` covers CLI/tool behavior, ID bounds/alphabet, replay, idempotency, historical local precedence, external debt presentation, isolated command forms and complete `allowed` coverage.
- Existing test change: `test/needs-structure.test.ts` updates only the exact HELP literal SHA-256 registration and its explanation. TB1 changes `--tracked-by FIX` to `--tracked-by FIX|ext:<id>`. All structural assertions and exception boundaries remain intact.

`git diff --stat 1e8540a -- src`:

```text
 src/cli.ts       | 19 +++++++++++++++----
 src/extension.ts |  2 +-
 src/ops.ts       |  4 ++--
 src/reducer.ts   |  4 +++-
 src/views.ts     | 14 +++++++++-----
 5 files changed, 30 insertions(+), 13 deletions(-)
```

Net growth: 17 lines, within the 60-line budget.

All runtime checks use `/tmp/owed-bench/run.sh`; no host node/tsc/test execution.
The tested source/test tree before this notes-only translation was `41842675107825aef1052bb1eef511132c25b3cc`:

- Red baseline: detached `1e8540a` plus the new test file, `node --test --test-reporter=tap test/trackhelp.test.ts`; exit 1, 2 pass / 6 fail, all six failures cover the changed TB1/HP1 behavior. Log: `/tmp/owed-bench/logs/owed-0292-trackhelp-red-1-193044.log`.
- Typecheck: `npm run typecheck`; exit 0. Log: `/tmp/owed-bench/logs/o-trackhelp-1-193056.log`.
- Node check: `node --test --test-reporter=tap test/trackhelp.test.ts test/trackfix.test.ts test/readers.test.ts test/surface.test.ts test/cli.test.ts test/needs.test.ts test/needs-structure.test.ts`; exit 0, 96/96. Log: `/tmp/owed-bench/logs/o-trackhelp-1-193116.log`.
- Current red-test command: `node --test --test-reporter=tap test/trackhelp.test.ts`; exit 0, 8/8. Log: `/tmp/owed-bench/logs/o-trackhelp-1-193206.log`.
- Initial full suite: `node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'`, timeout 1800; exit 1, 1913/1914. Its only failure was the English documentation requirement for this notes file, now translated. Log: `/tmp/owed-bench/logs/o-trackhelp-1-193247.log`.
- Final English-check receipt: `/tmp/owed-0292-trackhelp-english-4.receipt.log`.
- Final full-suite receipt (same full command, timeout 1800): `/tmp/owed-0292-trackhelp-full-4.receipt.log`. Each receipt records the actual bench log path and exit code for the final documentation tree.
