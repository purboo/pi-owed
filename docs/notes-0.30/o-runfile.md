# o-runfile RF1–RF5 — attempt 1

- Baseline: `1e8540ae5cdcf4d7a4e2b8b92d95b4f0e1754d94` (0.29.1).
- Worktree: `.owed/wt/o-runfile-1`; owned files only, no submit/merge/publication.
- Scope: optional plan-pinned `run_file {path, sha256}`, literal argv; admission before recording locks; trusted script installation after setup/overlays and before each run; conditional executable keys; editable pin fields and descriptive reply lines.
- Parent ruling R-030-RF-1: every path segment matches `^[A-Za-z0-9._@+,=-]+$`, excluding `.`/`..`; no leading slash/`./`, empty segment or trailing slash. This keeps canonical `exec ./<path>` unquoted and avoids shell injection. Working-tree source is `git.repoRoot(cwd)` (the current worktree), not `mainRoot`; `--rev` reads the selected commit.

## Implementation / boundaries

- `src/admission.ts`: exported `admitPlan(cwd, ledger, plan, rev?)`; called by `storePlan` and `planSet`. Existing `start` uses `init`/`planSet`, so it shares admission. `edit`, `amend` and `decide` use `storePlan` before `withLock`. Existing blobs need no source reread; replay remains unchanged.
- Admission may publish content-addressed blobs before refusal, but never appends ledger entries or replaces plan files before all pins pass. Existing `putBlob` publishes complete bytes atomically; CAS retries reuse them. No new ledger fields/kinds/enums or reducer/runtime coupling.
- `src/git.ts`: binary-safe Git blob reads for `--rev`; check/invariant/trunk, red and strength keys include pin/args only when present. Legacy executable keys omit the new fields; writes/review keys remain unchanged. Whole `CheckSpec` already participates in supersede definitions.
- `src/exec.ts`: shared `checkCommand` installs verified blob bytes after setup/overlays, before normal/red/invariant/probe/attribution/repeat or mutant execution. Parent directories are inspected with `lstat`; script target links are unlinked rather than followed; fresh file creation is exclusive/no-follow and mode 0755. Missing/corrupt blob or failed install is an environment error, including red. Only the primary script is pinned; helper dependencies retain ordinary reads/closure rules.
- `src/edit.ts`: nested pin fields and args accepted. Changes to an already-canonical pin/argv discard only stale derived `run`; explicitly assigned conflicting `run` is still refused. Existing YAML formatting and atomic file-replacement machinery remain in use.
- `src/planlint.ts`: omit derived run only; setup/wrap/on_timeout remain linted. RF descriptive lines use the existing warnings reply channel; no CLI/extension ownership expansion.
- `docs/SPEC.md`: public schema, admission, runtime, key, editing and path-ruling semantics.

## Tests

All new tests are in `test/runfile.test.ts`. **Changed existing tests: none.** Legacy key compatibility formulas are recomputed and extended in the new file instead of modifying existing assertions. All existing node/suite tests remain unchanged.

Coverage: candidate-poisoned script and red base without a script; canonical schema/reparse and unsafe paths/hashes/argv refusal; literal `$`, whitespace, quote, empty and shell-looking argv; mismatch/missing-source refusal with unchanged ledger/file; commit and current-worktree sources with exact binary bytes; existing blob without source; plan/edit display and nested edits; amend/decide re-admission; setup poison and per-repeat reinstall; mode/wrap/env; missing/corrupt blob, red error, parent/target symlinks and failed installation; invariants/strength/attribution/trunk path; full definitions and executable key changes with SHA/args, legacy payload identity, unchanged writes/review keys; replay after source removal.

## Current validation

All Node/tsc/tests run only through `/tmp/owed-bench/run.sh`; durable commands use bounded timeouts and preserve complete logs and exit codes.

Final durable request `owed-b1da092bfb45-o-runfile-1-final-checks-2` (`01M59ZCNE7Y1NYHNMCTN5T24MB`), aggregate exit 0:

- Red proof, isolated baseline `1e8540a` plus final new tests: `/tmp/owed-bench/run.sh /tmp/owed-runfile-red-1 180 "node --test --test-reporter=tap test/runfile.test.ts"`; exit 1, 11/11 fail (missing schema; not a crash or import failure). Log `/tmp/owed-bench/logs/owed-runfile-red-1-194015.log`; tree `f5cdeb9e07282085fd25f9360478717b3644e9cb`.
- Focused: `/tmp/owed-bench/run.sh <worktree> 600 "npm run typecheck && node --test --test-reporter=tap test/runfile.test.ts test/exec.test.ts test/exec-red.test.ts test/git.test.ts test/exec-env.test.ts test/checktpl.test.ts test/plan.test.ts test/planlint.test.ts test/flow.test.ts test/edit.test.ts test/rexec.test.ts"`; typecheck and 85/85 tests pass, exit 0. Log `/tmp/owed-bench/logs/o-runfile-1-194019.log`.
- Full suite: `/tmp/owed-bench/run.sh <worktree> 1800 "node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'"`; 1917/1917 pass, no skipped/cancelled tests, exit 0, 1352795 ms. Log `/tmp/owed-bench/logs/o-runfile-1-194134.log`.
- Both green commands measured tree `9c2415e08a31e7924ba7c2cc686190afe2a9be27`, HEAD `1e8540ae5cdcf4d7a4e2b8b92d95b4f0e1754d94` plus owned diff. Before this receipt update, `git write-tree` exactly matched that tree. Final commit differs only in this notes file; source tree `1b4861b3ea11d9c3e9701c5b0709d6770a2af626` and test tree `54aa6b3b955ad697b5311d9cd9d58b96cf9e23f3` are unchanged.
- `git diff --check` passes. Earlier test-only mistakes (incomplete invariant fixture and `decide.node` instead of `decide.nodes`) were corrected before the final measurements; no source changes followed the successful suite.

## Handoff / limits

Implementation is committed for parent review; no `owed submit`, merge, push or publication. Independent review and parent integration remain parent-owned. RF path syntax and current-worktree source follow ruling R-030-RF-1. Blob-cache writes before a refusal are permitted admission side effects; refusal still leaves ledger and plan files unchanged. Only script bytes are pinned, not dependencies loaded by that script. No scope or acceptance waiver taken.

## Source budget

`git diff --stat 1e8540a -- src`:

```text
 src/admission.ts | 35 +++++++++++++++++++++++++++++++++++
 src/edit.ts      | 15 +++++++++++----
 src/exec.ts      | 35 +++++++++++++++++++++++++++++++----
 src/git.ts       | 17 ++++++++++++++---
 src/ops.ts       | 17 ++++++++++-------
 src/plan.ts      | 18 +++++++++++++++++-
 src/planlint.ts  |  4 ++--
 src/types.ts     |  2 ++
 8 files changed, 122 insertions(+), 21 deletions(-)
```

Net source change +101 lines; RF budget +150 met. No changes to parallel o-remeasure/o-trackhelp hunks.
