# o-remeasure — RM1–RM2, base 1e8540a

Current state: implementation and validation complete. bench typecheck, all 127 node checks and the final 28 focused checks passed. The full suite's only failure was the missing PR2 registration of the two RM2 command literals; those exact sites are now registered and PR2, including all negative checks, passes. The parent explicitly accepted reuse of the remaining full-suite evidence because the production subtree is identical. No submission or merge is performed by this writer.

## Scope and behavior

- `src/drive.ts`: the latest current-attempt `resume.remeasure` authorizes attribution of an active current-key execution block whose failure predates the resume, before repair. A non-error attribution consumes the request for that block. Existing setup retry, environment back-off, non-environment error limit, fail/repair and pass/flaky paths remain in use.
- `src/ops.ts`: remeasure replies identify blocked node checks, failure sequences and conditional accept-risk commands; already-attributed current-key failures name `attest --rerun`; no applicable work says nothing to remeasure. Existing invariant remeasurement and trunk-move explanations remain.
- `docs/SPEC.md`: distinguish decide/resume check attribution from direct attest invariant remeasurement.
- `test/remeasure0292.test.ts`: eight regression cases cover multiple checks, CLI decide/resume receipts, ordinary/latest resume routing, fail/repair, pass/flaky, errors/back-off, post-resume failures, explicit rerun guidance and no work.

## Existing tests changed and reasons

- `test/app027.test.ts`, `WF5: active merge-check failure...`: RM2 replaces the old next-merge attribution sentence with the exact failure sequence, before-repair measurement and accept-risk command.
- `test/app027.test.ts`, `WF5/RM2: an already-flaky merge-check block...`: RM2 now says nothing to remeasure when neither a failed invariant nor an active/failing check applies; the already-flaky block has already received its attribution pass.
- `test/needs-structure.test.ts`, PR2 exact command-site registry: RM2 mandates two new command-bearing receipt literals in `remeasureQueuedText`. Register only those exact SHA-256 sites as diagnostic examples with an explicit reason. The scanner and negative tests are unchanged.

## Production diff budget

`git diff --stat 1e8540a -- src`

```text
 src/drive.ts | 15 +++++++++++----
 src/ops.ts   | 21 ++++++++++++---------
 2 files changed, 23 insertions(+), 13 deletions(-)
```

Net +10 production lines, below the leaf's +60 limit. No additional entry kind, API, helper, export, CLI flag or need selector.

## bench checks and exact measured trees

All Node/typecheck/test execution used `/tmp/owed-bench/run.sh`; none ran on the host. Durable validation: `01M59YEW991VP6ZEY2NEKRFFXW`.

- Baseline red: detached `/tmp/owed-rm0292-red-1` at `1e8540ae5cdcf4d7a4e2b8b92d95b4f0e1754d94`, with only `test/remeasure0292.test.ts` copied in; measured tree `5469cf5490802bb1294a6f218c9edd68a87262cc`. Command: `node --test --test-reporter=tap test/remeasure0292.test.ts`; exit 1, 7 fail / 1 pass. Failures demonstrate repair-before-measure and the previous incorrect reply text. Log: `/tmp/owed-bench/logs/owed-rm0292-red-1-192359.log`.
- Candidate before the PR2 registry addition: measured tree `9e12ff2dbe710197923c31da5347d30669094082`.
- `npm run typecheck`; exit 0. Log: `/tmp/owed-bench/logs/o-remeasure-1-192407.log`.
- `node --test --test-reporter=tap test/remeasure0292.test.ts test/remeasure.test.ts test/app027.test.ts test/infra.test.ts test/drive.test.ts test/reducer.test.ts test/decide.test.ts test/resume.test.ts`; exit 0, 127 pass. Log: `/tmp/owed-bench/logs/o-remeasure-1-192426.log`.
- `node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'`; exit 1, 1913 pass / 1 fail, 1321 s, timeout 1800 s. Only failure: PR2 exact command-site registry missing the two RM2 literals. Log: `/tmp/owed-bench/logs/o-remeasure-1-192456.log`.
- Final focused check, durable `01M59ZXE0WAJEYKRBD2JYSFH37`: `npm run typecheck && node --test --test-reporter=tap test/needs-structure.test.ts test/remeasure0292.test.ts test/app027.test.ts`; exit 0, 28 pass / 0 fail, including PR2's complete negative checks. Measured tree `3a462e011b4b6e3d399349e0597ec9692355ed54`. Log: `/tmp/owed-bench/logs/o-remeasure-1-194924.log`.
- Evidence reuse, explicitly approved by the parent: the full-suite tree `9e12ff2dbe710197923c31da5347d30669094082` and final focused tree `3a462e011b4b6e3d399349e0597ec9692355ed54` have the identical `src` subtree `0984ddce830294c1ea214789556aebbdf11bfb6d` (verified with `git rev-parse <tree>:src`). The only executable change between them is the exact two-site PR2 registry addition; the other added file is this note. Full-suite `not ok 888` was solely that registration, and the final focused check covers it and all its negative checks. The remaining 1913 full-suite passes and the 127 node passes are reused without another full run. After the final focused run, only this documentation note changes.
- First validation attempt exposed three new-test fixture errors (missing fake dsa for CLI; handcrafted behavior failures lacked counts and became setup failures). Fixed the new tests, retained production code, then ran the checks above. Superseded logs: `/tmp/owed-bench/logs/owed-rm0292-red-1-192042.log`, `/tmp/owed-bench/logs/o-remeasure-1-192050.log`, `/tmp/owed-bench/logs/o-remeasure-1-192111.log`.

## Remaining / runtime state

No check or external job is running. Validation is complete; commit the authorized files and report commit/tree to the parent. Do not run `owed submit`: the parent submits, attests and merges.
