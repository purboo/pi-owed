# o-lease — 0.29

Scope: LZ1–LZ6, R-029-4 (#3421), superseding R-029-8 (#3450, review block #3449), R-029-9 (#3452). Current slot base is trunk `163fce9` (#3451), including accepted o-writer/o-probe. The specified `git rebase 163fce9` is complete. This note replaces the erroneous R-029-7 runtime diagnosis and stale acceptance report.

## Implementation and limitations

- LZ1 compares the scheduled sweep definition and normalized `every` each pass. Changed/deleted policy aborts before commit, without verdict/interruption; committing sweeps finish. Runtime retains `sweep aborted: plan changed` until the next sweep starts.
- LZ2/LZ6 request scheduled yield and acceptance priority 10. Apparent unknown-option refusals are only hints: confirm identical cwd/env/flags using `hold <resource> <flags> --no-wait -- true`. Only the same confirmed flag refusal permits caching unsupported and one retry without it. Probe exit 0/75 returns the original command result; forged dsa stderr never replays measured commands. Fake legacy dsa refuses before executing the measured command and falls back once.
- LZ3 assigns random non-keyed OWED_RUN. Group TERM precedes scanning; each scan races the remaining five-second cleanup deadline. At an unfinished-scan deadline cleanup ends before command completion/lease release. Individual signals go only to readable environ containing the exact token. EACCES/EPERM (non-dumpable, another uid) is unproven: neither individually signalled nor waited for. Leaving the group and clearing the token or making environ unreadable escapes Linux containment. Non-Linux retains groups; normal exits unchanged. Captured real cleanup timers work under virtualized command timers. No public test seam.
- LZ4 prepares and materializes the first tree before acquisition; the first setup/check captures the lease async context, retained through sweep/tree cleanup.
- LZ5 selects the last line whose trim is non-empty, matching its original content (only CRLF's CR removed). `(exit 75)   ` remains failure. Strict hold diagnostics become environment errors for checks/invariants/red with existing backoff, not red passes or two-errors halts.
- R-029-8 root cause is the D24.4 test wait: direct `ops.status` in the host never sees the tool worker's module-local genesisRuns. The old wait passed immediately even on base; its green result depended on the worker finishing abort cleanup before the final tool status. LZ3/LZ4 legitimately extend cleanup. Now the same 60 s `until` polls tool `h.call('status')` details. All original assertions remain. Production status is exactly trunk's measuringHere-only path; no runtime-based fallback or readMeasuring import. Runtime records from unrelated attestTrunk or terminated workers cannot imply genesis activity.
- The earlier same-module genesisRuns lifetime still spans withMeasuring cleanup; this is distinct from the withdrawn cross-worker runtime fallback. No ledger/reducer changes.

## Conflict hunk receipt (rebase 163fce9)

1. Replaying `a8626b2`: `src/exec.ts` ExecContext line 31. Trunk had PB1 `onTree?(path)`; leaf added `commandScope`. Resolved to their union. The two post-materialize onTree calls remain after both mutant and ordinary/red materializations (`src/exec.ts:638,664`). LZ3 command cleanup and LZ5 strict line classifier retained.
2. Replaying `d224881`: `src/ops.ts` status block near 2199. Trunk added `trunkElsewhere(...).catch(() => undefined)`; historical leaf patch added the incorrect runtime fallback. Preserved trunk catch while replaying that historical patch; the final R-029-8 commit removes the fallback.
3. Replaying `a69c39c` (R-029-8): same status block. Preserved trunk catch and reverted to `if (view.genesis && await measuringHere(ledger.dir)) ...`; removed readMeasuring import. Final status has no diff against 163fce9.

Auto-merged shared blocks were inspected, not replaced wholesale: `src/ops.ts:2033` passes PB1 onTree to runJob; `mergeFailureOutput` and its call remain, with the PB2 marker guarded by check:/fail/anonymous/merging and no marker for invariants (R-029-6). Existing onTree callback locations are unchanged. src/dsa.ts retains merged WR2 parsing alongside LZ2/LZ6 flags/confirmation; drive-run.ts retains merged WR2 recovery alongside scheduled-sweep cancellation. No sibling files were taken over.

## Tests and authorized existing-file changes

`test/olease.test.ts`: 41 behavioral tests. R-029-8 replaces the withdrawn cross-worker-positive test with worker-record negatives (active cleanup and stale same-pid record after worker termination), and adds unrelated attestTrunk/genesis-pending negative. R-029-4 process/tag, slow first/repeated scan, group TERM ordering, forged options with probe 0/75, legacy/cache, strict CRLF/tail tests remain. Local delayed cleanup and virtualized timers retain their regressions.

Existing changes:
- `test/init-tool.test.ts:293–294`, R-029-8: exactly one wait replacement plus one comment. Same until/default 60000 ms and all original assertions. Byte-check against 163fce9 proves every other byte unchanged.
- `test/attest-signal.test.ts:92–96`, LZ3, earlier parent authorized: shared heldRun deliberately uses `env -u OWED_RUN setsid sleep` for both D16a.3 pipe-holder fixtures (60 s and 3 s). Assertions and bounds unchanged.
- `test/activity.test.ts:233–234`, R-029-9: only the AC1 CLI signal fixture replaces `setsid sleep 2 &` with `env -u OWED_RUN setsid sleep 2 &`, plus one comment. This untagged escaped pipe holder is never individually signalled (R-029-4), so the invocation's runtime record remains until inherited pipes actually close. Byte comparison against d8db2f1 verifies all assertions and every other byte unchanged. No src changes.

## Current evidence and submit handoff

All Node/typecheck/test commands run in foreground with `/tmp/owed-bench/run.sh`; no owned background driver. Temporary regression worktree was removed.

- Reviewer reproduction on eb577bb: `/tmp/owed-bench/logs/o-lease-1-190622.log` confirms unrelated trunk activity and stale exited-worker record false positives. R-029-8 accepts this evidence and supersedes the earlier R-029-7 fix.
- New R-029-8 negatives copied to isolated previous candidate eb577bb: `/tmp/owed-bench/logs/olease-r8-before-195740.log`, exit 1, 2 tests / 0 pass / 2 ERR_ASSERTION failures. These are valid regression reds, not fixture failures.
- Byte check command compares `git show 163fce9:test/init-tool.test.ts` with current bytes after exactly the authorized replacement: passed.

Clean rebased source S: commit `d8db2f1dba2f55cbe36702ee1e9bf191467178fd`, tree `151cdaebcc5e93a9c69ed52e5951dd0298eacadc`. Every following run.sh header has that exact head/tree and dirty=0.

- Typecheck: `/tmp/owed-bench/logs/o-lease-1-195901.log`, `npx tsc --noEmit -p .`, exit 0.
- Shutdown 10×: `/tmp/owed-bench/logs/o-lease-1-195930.log`, exit 0, `shutdown failures=0/10`. Exact filter: `node --test --test-concurrency=2 --test-reporter=tap --test-name-pattern='session_shutdown aborts' test/init-tool.test.ts`, run ten independent invocations with recorded per-invocation exits.
- Affected set: `/tmp/owed-bench/logs/o-lease-1-195958.log`, exit 0, 220 tests / 220 pass / 0 fail. Command: `node --test --test-concurrency=2 --test-reporter=tap test/olease.test.ts test/init-tool.test.ts test/attest-signal.test.ts test/oprobe.test.ts test/trackfix.test.ts test/trunkred.test.ts test/attrib.test.ts test/views028.test.ts test/gc.test.ts test/summary.test.ts test/compactreply.test.ts test/remeasure.test.ts test/dsa.test.ts test/lease.test.ts test/exec-red.test.ts test/env.test.ts`.
- Sole permitted full suite: `/tmp/owed-bench/logs/o-lease-1-200304.log`, exit 1; 1883 tests / 1882 pass / 1 fail / 0 skipped / 0 cancelled, 1288649.56182 ms. Exact command: `node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'`, foreground timeout 1800.

R-029-9 (#3452) resolves the single full-suite failure as an intended behaviour change. The original AC1 CLI signal fixture's `setsid sleep 2` inherited OWED_RUN and was correctly TERM'd after abort, closing the pipe inside the 200 ms assertion window depending on scan timing. Only the explicitly authorized untagged pipe-holder fixture and comment changed; assertions remain intact. With the untagged holder all ten runs retain the record at 200 ms and remove it after actual cleanup; the product-bug stop condition did not occur.

### R-029-9 exact-tree comparison and repair checks

All commands below use foreground `/tmp/owed-bench/run.sh`; all per-iteration exit codes and full TAP output are preserved. Every repeated command uses `node --test --test-concurrency=2 --test-reporter=tap`.

- Before editing, isolated clean d8db2f1 tree: `/tmp/owed-bench/logs/olease-r9-before-202810.log`, exit 1, **5/5 failed runs**; each activity.test.ts invocation has 17 tests / 16 pass / 1 fail, solely AC1 CLI signal, total 80/85 passed. Identity: `wt=/tmp/olease-r9-before head=d8db2f1dba2f55cbe36702ee1e9bf191467178fd dirty=0 tree=151cdaebcc5e93a9c69ed52e5951dd0298eacadc`. Temporary worktree removed before editing.
- After edit typecheck: `/tmp/owed-bench/logs/o-lease-1-202953.log`, `npx tsc --noEmit -p .`, exit 0.
- After edit activity.test.ts 10×: `/tmp/owed-bench/logs/o-lease-1-203021.log`, exit 0, **0/10 failed runs**, 17/17 each, total **170/170**. Loop stops at the first failure; no failure occurred.
- R-029-8 shutdown filter 3×: `/tmp/owed-bench/logs/o-lease-1-203300.log`, exit 0, **0/3 failed runs**, total 3/3. Command uses `--test-name-pattern='session_shutdown aborts' test/init-tool.test.ts`.
- All three post-edit logs measure `wt=/home/user/project/pi-things/pi-owed/.owed/wt/o-lease-1 head=395a0db038219ad1fec4a52005f7d695df1e3945 dirty=1 tree=6a1831dc093010dcd8bb4bb61e9106ff6ecd3d1b`; only authorized activity.test.ts fixture was dirty. This notes-only evidence update follows those checks. Final committed candidate's src/tests are identical to that tested tree; head/tree belongs in the submit handoff.
- Byte-check passed: current activity.test.ts equals d8db2f1 bytes after exactly one fixture replacement and one comment; `git diff d8db2f1 -- src` is empty. Full-suite source is therefore identical. Per R-029-9, no second full suite run: retain the 1882/1883 same-src result above without claiming it as a green exact-candidate full run. Merge attest will measure the complete suite on the exact candidate.

No runtime background scripts remain. Next step is committed clean-slot foreground submit; busy/75 retries wait 60 seconds. Independent review, formal measurements and merge acceptance are still parent-owned.

Previous full receipts (eb577bb/d224881) predate R-029-8 and the new integration base and do not validate this candidate. The earlier 10/10 leaf-vs-0/10 baseline comparison was real, but its runtime-fallback interpretation was incorrect. It must not be presented as proof of a production status bug.

## Source budget

Budget baseline c07a398 includes o-held. Already merged siblings from c07a398 to 163fce9 contribute 174 insertions / 38 deletions = net +136. Current whole tree against c07a398 is 295 insertions / 94 deletions = net +201. Therefore the leaf contribution relative to that baseline is +201 − +136 = **+65**, within +120; equivalently `git diff --stat 163fce9 -- src` is 6 files, 122 insertions(+), 57 deletions(-). Both raw and leaf-only counts are explicit; inherited accepted sibling lines are not attributed to this writer.

Per-file leaf diff: drive-run.ts 22 (+12/-10), dsa.ts 31 (+27/-4), exec.ts 58 (+42/-16), lease.ts 4 (+2/-2), ops.ts 29 (+15/-14), sweep.ts 35 (+24/-11). Fake dsa only; no live dsa 1.1.0 dependency. No independent review, integration acceptance, merge or publication authority exercised.
