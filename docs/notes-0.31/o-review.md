# o-review — 0.31 RA1–RA2 / RM1–RM2

Base: `ebf090b83644c4bb170802b97053bc17cd09a910`.
Worktree: `.owed/wt/o-review-1`.
Scope: the packaged default reviewer, review-missing recovery commands, and one
renewed verdict follow-up after resume.

## Implementation and rulings

- `agents/owed-reviewer.md` is the exact content of contract Appendix A. Its
  SHA-256 is `0a048ba015bd3d0d80cda42d3b560bb1fdc67f48da6c3de295fa2ce484c794d8`.
  `package.json` declares its discovery and publication directories. The default
  reviewer agent is `owed-reviewer`; explicit global and node agents are preserved.
- R-031-RA-1 (parent ruling #3711) permits old raw plans with an omitted reviewer
  to parse with the new default. Agent choice does not affect obligation keys,
  observations, candidate invalidation, reviewer identities or votes. Historical
  runs use their recorded launch spec, falling back to the plan at launch time,
  never the current plan.
- R-031-RA-2 (parent ruling #3713; writes authorized by #3712) permits the existing
  `src/drive-run.ts` blob loader to load sealed/pruned reviewer launch specs into
  its existing cache. No new inspect call, lock, registry or merge-batch change.
- R-031-RA-3 (parent ruling #3716) preserves the diagnostic review-missing prefix
  byte for byte and replaces its old rejectedFixed recovery suffix with RM1
  commands. Rejected/pruned runs cannot take follow-ups, so resume is omitted;
  the remaining commands retain their order: edit (builtin reviewer only), owner
  review, abandon. `rejectedFixed`, writer halts and `rejectedHalt` are unchanged.
  Previously recorded halt reasons are not rewritten.
- `reviewResumed` requires a matching node/attempt/rid review-missing halt after
  the current candidate and before resume. It renews one verdict follow-up on
  the same run and principal, using the existing send/generation protections.
- Halt, needs, wake and why expose the recovery commands. Old halt records gain
  display-time remedies without ledger mutation. `docs/SPEC.md` documents the
  new default and recovery behavior.

## Changed existing tests

- `test/drive-ledger.test.ts`: three omitted-reviewer default expectations change
  from `reviewer` to `owed-reviewer` under RA2. Explicit reviewer expectations
  remain unchanged.
- `test/node-models.test.ts`: omitted-reviewer plan defaults and the why Drive
  line now expect `owed-reviewer` under RA2. Explicit overrides are unchanged.
- `test/drive.test.ts`: the rejected reviewer halt expects RM1 / R-031-RA-3
  remedies instead of the old recovery suffix. Ordinary review-missing now
  includes abandon. Writer rejectedFixed assertions remain unchanged.
- New regressions are in `test/review031.test.ts`. No fixtures, skipped tests or
  acceptance gates were changed.

## Validation

All node, tsc and test commands ran through
`/tmp/owed-ipc/run.sh <worktree> <timeout_s> "<command>"` on IPC. The red checkout,
`/tmp/owed-o-review-031-red-ebf090b`, is detached at the base with only the new
regression test copied into it.

Measured implementation tree: `e76858b33be079c2cb15c851981d0efdb7b7365c`.
Driver script: `/tmp/owed-o-review-031-final.sh`.
Exit codes and IPC log paths: `/tmp/owed-o-review-031-final.results.log`.

| Check | Result | IPC log under `/tmp/owed-ipc/logs/` |
| --- | --- | --- |
| Base: `node --test --test-reporter=tap test/review031.test.ts` (240 s) | Expected exit 1; 11 assertion failures, 3 passes | `owed-o-review-031-red-ebf090b-082455.log` |
| `npm run typecheck` (120 s) | Exit 0 | `o-review-1-082500.log` |
| `node --test --test-reporter=tap test/review031.test.ts` (240 s) | Exit 0; 14/14 pass | `o-review-1-082523.log` |
| `node --test --test-reporter=tap test/review031.test.ts test/drive.test.ts test/reviewdedup.test.ts test/nits.test.ts test/drive-ledger.test.ts test/snapshot.test.ts` (900 s) | Exit 0; 107/107 pass | `o-review-1-082527.log` |
| `node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'` (1800 s) | Exit 1; 2042/2043 pass, 1337 s; only the English documentation scan failed on this note | `o-review-1-082618.log` |

The full-suite failure was caused solely by this note being written in Chinese.
The remediation translates this note into English; source and tests are unchanged
from the measured tree. The follow-up command is
`node --test --test-reporter=tap test/english.test.ts` (240 s), recorded in
`/tmp/owed-o-review-031-english.results.log`. The original full-suite failure is
retained as evidence; it is not reported as a full-suite pass.

New tests cover exact agent bytes, default/explicit agents, historical spec and
plan selection, recovery ordering, unchanged legacy halt records, one renewed
verdict allowance, rejected/pruned runs, unchanged keys/observations/blocks and
candidates, and actual Driver behavior across stale generations and restart.
The unchanged `real-020-ledger.json` passes chain verification and full/incremental
replay comparison, with baseline-measured full-state digest
`4ddeb551d448c6308c2455a9142c11a18bb0ac863aaac0fdf0d3989705d75653`.

## Source budget and delivery

`git diff --stat ebf090b -- src`:

```text
 src/drive-run.ts |  2 +-
 src/drive.ts     | 26 +++++++++++++++++++++-----
 src/needs.ts     | 25 +++++++++++++++++++++++--
 src/plan.ts      |  2 +-
 4 files changed, 46 insertions(+), 9 deletions(-)
```

Net increase: 37 source lines, below the 110-line budget. Integration and
publication belong to the parent. This leaf does not run `owed submit`.
