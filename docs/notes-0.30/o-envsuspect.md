# o-envsuspect: EV1-EV3 and review #3549 repair

## Scope and current behavior

- Baseline: `1e8540ae5cdcf4d7a4e2b8b92d95b4f0e1754d94` (0.29.1); slot branch: `owed/o-envsuspect/1`; repair parent: `62464e4864e378eba0d69fa92460eb8bf126460d`.
- Owned files: `src/plan.ts`, `src/types.ts`, `src/exec.ts`, `src/drive.ts`, `test/envsuspect.test.ts`, `test/needs-structure.test.ts`, `docs/SPEC.md`, and this note. The review repair changes only drive.ts, the new leaf test, SPEC, and this note.
- EV1: optional top-level `env_signatures`, strict match/unless lists, valid JavaScript regexes without flags, 300-character limit. Not part of obligation keys, check definitions, or downgrade detection.
- EV2: match individual lines in the retained log of a failing ordinary node check after CSI/CR removal. Any retained unless match vetoes the hint. Only note changes; verdict, counts, failed names, signatures, log, and keys are unchanged.
- EV3: the local `suspectAttribution` exception admits current-key attribution independently of setupFailure. One quiet notify per failure. Two suspect failures halt without repair sends or repair budget. Resume restores ordinary routing. Attribution pass retains flaky owner need; non-suspect fail/error retain existing repair/backoff/halt behavior.
- Review #3549, accepted by parent: after a suspect halt, an effective owner waiver cleared the halt and satisfied the current check, but its historical cleared block incorrectly caused another EV3 halt. The scan now requires the matching current-key item's status to be `D` (unsatisfied). Historical active/cleared blocks cannot override `E`/`W` satisfaction. No ledger kind, field, enum, key, verdict, reducer vote, lock, or commit boundary changes.
- Regression covers suspect F/A -> halt -> effective owner waiver -> automatic driver merge without resume, preserving both failing observations and sending no repair. Additional checks cover an active waived check with another ordinary unwaived failure and a changed key whose failures are not covered by an old waiver. Unwaived consecutive failures still halt.
- Writers/state path traced: executor observation -> reducer active/cleared/flaky blocks and current ItemView -> waiver's effective same-key/risk evaluation -> non-driver act clears halt -> driver consults item status -> guarded merge. The existing reducer decides whether a waiver is effective, so the driver does not implement a second waiver vote or rely on accepted=true for unrelated obligations.

## Rulings and existing test changes

- R-030-EV-1: ordinary candidate checks participate even when their specs configure red/mutants. Exclude red/strength execution, repeat, invariants, and probes. Displayed excerpts replace semicolons with commas before trim/160-character clipping; original logs stay intact.
- R-030-EV-2: **the only existing test change** remains one exact historical-text site registration in needs-structure.test.ts for the persisted environmentSuspectHalt literal, SHA256 `53b0ec4be9f1bd018e0605f1d93843b0e7b07f661858ac435f819221fd5507ad`. The literal is unchanged by review repair. Class, scanner, negative fixtures, and assertions are unchanged.
- R-030-EV-3: tests show driver need and CLI follower summarize the suspect halt plus `owed resume a`; `owed why a --full` retains `owed attest a --rerun`, `owed resume a`, and `owed decide a --writer --text "<repair instruction>"`.
- Known presentation gap, parent backlog: plain() in needs.ts truncates at the first semicolon; need/follower omit the complete remedy tail. Full commands remain in the ledger and `owed why a --full`. This leaf does not change needs/drive-run.
- All behavioral additions are in the new `test/envsuspect.test.ts`. The supersede fixture includes both delegated owner identity and a command-replacement reason. Previous red evidence containing a missing-note failure is superseded below: this fixture now passes on baseline, and every baseline failure is an EV reason.

## Source budget

`git diff --stat 1e8540a -- src`:

```text
 src/drive.ts | 35 ++++++++++++++++++++++++++++++++---
 src/exec.ts  | 10 +++++++++-
 src/plan.ts  | 12 ++++++++++++
 src/types.ts |  2 ++
 4 files changed, 55 insertions(+), 4 deletions(-)
```

Net +51 source lines, budget +120. Review repair adds two source lines. Combine the local attribution exception with the sibling o-remeasure exception using `||` at parent integration.

## Current verification (bench only)

All Node/typecheck/test commands run through `/tmp/owed-bench/run.sh <worktree> <timeout_s> "<command>"`. Logs retain exact tree identity and exit status.

- Review regression red: detached `62464e4`, final leaf test copy; `node --test --test-reporter=tap --test-name-pattern='review #3549' test/envsuspect.test.ts`, timeout 240, exit 1, 3 tests / 2 pass / 1 fail, 3557.291038 ms. Log `/tmp/owed-bench/logs/envsuspect-review-red-62464e4-203618.log`, tree `0afcb88ee31fb593c420beeac17d89531104a389`. Expected merge, actual repeated original F/A halt after effective waiver. This is the accepted correctness defect, not an authority/setup failure.
- Corrected baseline red: detached `1e8540a`, final leaf test copy; `node --test --test-reporter=tap test/envsuspect.test.ts`, timeout 300, exit 1, 14 tests / 5 pass / 9 fail, 13736.032812 ms. Log `/tmp/owed-bench/logs/envsuspect-red-1e8540a-203623.log`, tree `9141cce458ce1071dadf7fab751ceef83f6e0706`. Supersede fixture passes. All nine failures are EV reasons: missing env_signatures, missing suspect note, missing attribution, missing suspect halt (including the new changed-key case), and absent EV retry routing. No refused owner-note failure remains.
- Final typecheck, node set, English and PR2 audits: `npm run typecheck && node --test --test-reporter=tap test/envsuspect.test.ts test/env.test.ts test/drive.test.ts test/infra.test.ts test/reducer.test.ts test/plan.test.ts test/olease.test.ts test/supersede.test.ts test/needs-structure.test.ts test/english.test.ts`, timeout 600, exit 0, 157/157, 40148.279155 ms. Log `/tmp/owed-bench/logs/o-envsuspect-1-203359.log`, tree `7a686b64ec3ee793943916c276109cc458574776`. Includes all 14 leaf tests, three waiver regressions, and unchanged PR2 negative fixtures. All 41 source and 178 test blobs were compared to the tested tree and still match; subsequent changes only update SPEC wrapping and this English note.
- Current-source full suite: `node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'`, timeout 1800, exit 0, 1920/1920, 1297662.466919 ms. Log `/tmp/owed-bench/logs/o-envsuspect-1-203639.log`, tested tree `ba635a84c20dc273a585aa03acb8f56cc47cb18b`; source subtree `2f822f31aacf4bd250d639f44268a68152d21bfe`, test subtree `ad7d22b6c47f106ccc549c53147d05c3bb49c87d`. Includes the 14 leaf tests, English audit, and PR2/needs-structure audits. Previous 1915/1917 evidence is superseded, not reused.
- Before final evidence update, all 820 tracked file blobs matched the full tested tree. Only this English delivery note is then updated; source, tests, and SPEC still match that tree. `git diff --check` passes. No remaining requested check is failing, timed out, or unrun.

## Delivery state

All requested checks passed on current source. The repair is committed on the slot branch, and the writer stops for parent re-review/integration. No `owed submit`, merge, push, or release publication. Only the existing remedy-tail presentation gap remains outside this leaf's scope.
