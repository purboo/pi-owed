# o-checktry — CT1–CT2

## Scope
- Slot: `owed/o-checktry/1`; base `cdb851bcb4ed2f735bd28e0b6da098ddc7b1ed53` (o-runfile integrated).
- CT1: CLI/tool disk-plan diagnostics on fresh exact-commit trees, ordinary red/green verdicts, shared lease, retained logs, no ledger entries.
- CT2: strict optional fixtures; pre-lock selftests for new/changed definitions or fixtures; refusal before plan/file writes; existing-kind note immediately after genesis/plan in the same append.
- Fixtures excluded from candidate invalidation, supersede definitions and reported definition changes; all execution keys already enumerate their inputs and exclude fixtures.
- `docs/SPEC.md` documents the new CLI/tool and authoring behavior. No version/README/SKILL/CHANGELOG changes.

## Files
`src/checktry.ts` (new); local hooks in `src/ops.ts`, `src/cli.ts`, `src/extension.ts`, `src/exec.ts`, `src/plan.ts`, `src/types.ts`, `src/edit.ts`, `src/reducer.ts`; new `test/checktry.test.ts`; `docs/SPEC.md`; this note.

Existing tests updated only for explicit CT contract changes:
- `test/cas-retry.test.ts`: CT2 warns for newly changed checks without selftest; an identical subsequent tool admission emits no such warnings. Assert the exact three added warnings and preserve merged-node warning checks.
- `test/plan-guidance.test.ts`: retain check-less warning order and ledger-entry assertions, adding exact CT2 warnings for new checks to CLI/tool expectations.
- `test/needs-structure.test.ts`: update the exact classified HELP literal digest for CT1 grammar; no broad exception added.

New regression coverage includes exact trees/no closure overlay/reuse, red ordinary verdicts, counts/tails/errors/usage, working-tree run_file, invariant/setup/env/wrap/repeat, schema, atomic refusal/note, unchanged checks, dry-run/tool previews, fixture-only candidate/block/key preservation, changed setup/exec rerun, red/strength/invariant keys, append failure, stale source during measurement, lease marker/busy/opt-out, abort cleanup.

## Current review repair (#3637)
Parent accepted the finding that the selftest note between plan and carry submits hid carries from `carriedBy`. The repair changes only that reader in `src/ops.ts`: it skips exactly the immediately adjacent `executor:owed` note with prefix `selftest/v1 ` and parsed JSON `plan` matching the target plan SHA. Every other non-carry entry still stops scanning; draft order, ledger format and keys are unchanged.

CLI `plan` and `owed_plan` share this reader. `edit` and `amend` filter their own append results for submits, and `decide` returns the full appended entries, so those paths need no source changes. Added CLI/tool/edit coverage asserts ledger order `plan → note → carry submit`, candidate preservation and reported carry; malformed/wrong-author/wrong-plan/repeated/later notes and ordinary submits retain their boundaries. No existing tests were changed for this repair.

## Evidence
All Node/tsc/test execution uses `/tmp/owed-bench/run.sh`, never this host.
- Original CT baseline: new tests 0/11 passed on `cdb851b`; `/tmp/owed-bench/logs/o-checktry-red-cdb851b-224610.log`. Original typecheck/node checks 83/83 passed; `/tmp/owed-bench/logs/o-checktry-1-224617.log`.
- Original full run at `21668ff` source: 1942/1946 passed; four exact-output expectations updated under CT1/CT2, then typecheck and all 32 focused tests passed. Logs `/tmp/owed-bench/logs/o-checktry-1-224827.log`, `/tmp/owed-bench/logs/o-checktry-1-231345.log`.
- Repair red proof: detached `21668ff153b542f1bd922f749ababe0cbe95fb73`, only new tests copied, tree `218963d85543324359a17a8c344c271748adccee`. Command `node --test --test-reporter=tap --test-name-pattern="CT2 carry receipt" test/checktry.test.ts`, bench timeout 240: exit 1, 0/3 passed. CLI/tool fail on missing reported carry; edit's own return is correct but the subsequent `carriedBy` assertion fails. Log `/tmp/owed-bench/logs/o-checktry-red-21668ff-232900.log`.
- Repair green: tree `05fdf8f797abd454f2bc72fbd9d3b5c873f51043` (before this note update). Command `npm run typecheck && node --test --test-concurrency=2 --test-reporter=tap test/checktry.test.ts test/cas-retry.test.ts test/plan-guidance.test.ts test/needs-structure.test.ts test/carry.test.ts test/amend.test.ts test/edit.test.ts test/decide.test.ts`, bench timeout 600: exit 0, typecheck and 76/76 tests passed. Log `/tmp/owed-bench/logs/o-checktry-1-232906.log`.
- Repair full suite: tree `13c773ec650b3dd0887b8cdacc7769e1d8d7b14f`; command `node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'`, bench timeout 1800: exit 0, 1949/1949 passed, no skipped/cancelled tests, duration 1327.89 seconds. Log `/tmp/owed-bench/logs/o-checktry-1-233133.log`. Final commit differs from this tested tree only in this evidence note.

## Size
`git diff --stat cdb851b -- src` including the new module:

```
 src/checktry.ts  | 50 ++++++++++++++++++++++++++++++
 src/cli.ts       | 25 ++++++++-------
 src/edit.ts      |  2 +-
 src/exec.ts      |  6 ++--
 src/extension.ts | 20 ++++++------
 src/ops.ts       | 94 ++++++++++++++++++++++++++++++++++++--------------------
 src/plan.ts      | 13 ++++++++
 src/reducer.ts   |  8 ++---
 src/types.ts     |  1 +
 9 files changed, 158 insertions(+), 61 deletions(-)
```

Total net source growth +97, below CT budget +200.

## Runtime / handoff
No owed candidate submitted, no merge/publish/release performed. Git commit is the deliverable after validation, per parent follow-up. Exact-commit diagnosis still uses the established runtime shell/wrapper/process-cleanup boundaries; it is not acceptance evidence. Parent owns sibling rebase/integration and independent review.
