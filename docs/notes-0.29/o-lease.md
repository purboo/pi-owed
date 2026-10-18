# o-lease — 0.29

Scope: LZ1–LZ6, R-029-4 (#3421), R-029-7 (#3427). Slot base moved by #3426 to `c07a3984afdf3c8b329de5e53da91ef64bbd6cf3`; rebase and final clean-tree evidence are pending this repair checkpoint.

## Implementation and limits

- LZ1 compares scheduled sweep definition and normalized `every` each pass. Plan changes/drop abort before commit, without a verdict or interruption; committing sweeps finish. Runtime retains `sweep aborted: plan changed` until another sweep starts.
- LZ2/LZ6 request scheduled yield and acceptance priority 10. Apparent unknown-option refusals are only hints: confirm using identical cwd/env/flags with `hold <resource> <flags> --no-wait -- true`. Only the same confirmed flag refusal permits caching unsupported and one retry without the flag. Probe exit 0/75 returns the original command result; measured commands never replay because they forged dsa's stderr. The fake legacy dsa executes no measured command before its confirmed rejection.
- LZ3 gives commands random non-keyed OWED_RUN tags. Abort/timeout sends group TERM before scanning; every Linux scan races the remaining five-second cleanup deadline. At an unfinished-scan deadline cleanup ends and the command counts as ended, before lease release. TERM/grace/KILL/rescan only signals individually proven exact-tag processes. Unreadable environ (EACCES/EPERM, non-dumpable or another uid) is unproven: neither individually signalled nor waited for. Leaving the group and clearing the token or making environ unreadable is outside containment. Non-Linux retains group containment; normal exits remain unchanged. Captured real cleanup timers cannot freeze under virtualized command timers. No public test option was added.
- R-029-7 root cause: `src/ops.ts:2178–2179`, status used only its module-local genesisRuns, but extension attest executes in a native worker with a separate module instance and the same pid. Main-thread ops.status reported no measurement while worker cleanup was still active; the subsequent worker tool status reported measuring. Status now also reads the existing same-pid trunk runtime records. The earlier genesis registration spans runtime cleanup; no ledger fields change.
- LZ4 changes ordering: sweep preparation and first tree materialization run before acquisition; the first setup/check captures the lease async context, retained until sweep/tree cleanup ends.
- LZ5 selects the last output line whose trim is non-empty, but matches its original content (only CRLF's CR removed). `(exit 75)   ` is still failure. Strict diagnostics become environment errors for checks, invariants and red; existing backoff and two-errors semantics remain.

## Tests and existing-test changes

`test/olease.test.ts`: 40 behavioral tests. Added repair regressions cover EACCES/EPERM without mis-kill/wait; slow initial/repeated scans bounded at five seconds; group TERM before the blocked scan; stderr-forged yield/priority refusals with probe exit 0/75, same cwd/env, one measured execution; retained support cache after a false hint; genuine legacy confirmations with only one retry; strict whitespace/CRLF handling; same-pid native-worker runtime cleanup visibility. Linux detached-child abort/timeout, distinct tags, lease release order, normal exits, virtual timers and delayed cleanup remain covered.

Only existing-test change: `test/attest-signal.test.ts:92–96`, LZ3, parent authorized. Both D16a.3 fixtures (60 s and 3 s) share heldRun, now `env -u OWED_RUN setsid sleep`: deliberately uncontained pipe holders. Assertions and time bounds are unchanged. `test/init-tool.test.ts` is unchanged.

## Current repair evidence

All commands run in the foreground through `/tmp/owed-bench/run.sh`; full paths below. No owned background script or temporary worktree remains.

- R-029-7 comparison, original shutdown assertion unchanged, single-test filter `--test-name-pattern='session_shutdown aborts'`, 10 independent node invocations with `--test-concurrency=2`:
  - Dirty pre-fix source: `/tmp/owed-bench/logs/o-lease-1-182257.log`, exit 1, failures 10/10. Mirrored tree `f2936e53bcb90fb6550fd344ba76067efd4a8560`.
  - Clean base 74e5930: `/tmp/owed-bench/logs/olease-base-182327.log`, exit 0, failures 0/10; commit `74e59304071d66254fb90cc08894f85e13ea09e1`, tree `d94e629739d8a225a334a95e8ed2f82757533b91`, dirty=0.
  - Fixed source: `/tmp/owed-bench/logs/o-lease-1-182529.log`, exit 0, failures 0/10; mirrored tree `d621d8cd61038ac3d4096c4d87ad052fee21bc8b`.
- Fixed typecheck `npx tsc --noEmit -p .`: `/tmp/owed-bench/logs/o-lease-1-182558.log`, exit 0, same fixed mirrored tree.
- Fixed focused combination: `/tmp/owed-bench/logs/o-lease-1-182627.log`, exit 0; 235 tests / 235 pass / 0 fail, same fixed mirrored tree. Exact command: `node --test --test-concurrency=2 --test-reporter=tap test/olease.test.ts test/dsa.test.ts test/lease.test.ts test/sweep.test.ts test/sweep024.test.ts test/env.test.ts test/exec-red.test.ts test/drive-run.test.ts test/infra.test.ts test/nits.test.ts test/attest-signal.test.ts test/slotsetup.test.ts test/snapshot.test.ts test/init-tool.test.ts test/sig.test.ts test/wrapx.test.ts`.
- Repair regressions red on previous candidate a11ac47 (only new tests copied): `/tmp/owed-bench/logs/olease-before-183013.log`, exit 1; 10 tests / 2 pass / 8 fail, all failures ERR_ASSERTION. Forged-refusal, slow-scan, strict-tail and native-worker-cleanup tests each fail before repair. Unreadable-process negatives already pass, as expected from R-029-4's comment-only requirement.
- Before R-029-7 repair, expanded checks: `/tmp/owed-bench/logs/o-lease-1-181412.log`, exit 1; 234 tests / 233 pass / 1 fail (unchanged init-tool shutdown assertion). Olease alone was 39/39: `/tmp/owed-bench/logs/o-lease-1-181224.log`, exit 0.

This repair has not yet run a full suite. Parent allows at most two after R-029-7 repair; a second failing full suite must stop implementation. Commit first, rebase exactly onto c07a398, then run full suite on the resulting clean source commit S. After green S, a separate notes-only commit D records S's commit/tree/log/exit. D gets clean typecheck and leaf checks before foreground submit. Final D identity and log headers go in the handoff rather than amending this note recursively.

## Earlier evidence (superseded, not current-tree acceptance)

- Initial leaf red on 74e5930: `/tmp/owed-bench/logs/o-lease-base-162831.log`, exit 1; 27 tests / 2 pass / 25 fail, all ERR_ASSERTION and every LZ1–LZ6 has red evidence.
- Earlier source S `85d7129c139df2cd95a27cfc77c556d477996f81`, tree `a9c0c5090b4e2d8eb06789842d894dc0a5b5c8c0`: full `/tmp/owed-bench/logs/o-lease-1-172505.log`, exit 0, dirty=0, 1820/1820, 1238.9 s. Earlier D `a11ac4700395d186cac22ee8e55de88e8241f8c2`, tree `7902911e63aea27966cf697149506ef74f0a4763`: typecheck `/tmp/owed-bench/logs/o-lease-1-174618.log`, exit 0; leaf `/tmp/owed-bench/logs/o-lease-1-174644.log`, exit 0, 141/141. Submitted #3397; review #3411 blocked, now superseded by this repair.
- Earlier failed full `/tmp/owed-bench/logs/o-lease-1-163224.log`: exit 124 at 1800 s, no final totals. Escaped signal fixture, abort-time lifecycle, and virtualized cleanup timer issues were diagnosed, not called baseline/flaky.

Size before c07a398 rebase: `git diff --stat 74e5930 -- src`: 6 files, 125 insertions(+), 59 deletions(-), net +66. Post-rebase budget is relative to c07a398 and must stay <= +120. Fake dsa only, no dependency on live 1.1.0. No writer integration or publication authority exercised.
