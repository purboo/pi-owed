# q-attest — 0.32.0 MV repaired handoff

## Current identity and scope

- Worktree: `/work/pi-owed/.owed/wt/q-attest-1`; branch: `owed/q-attest/1`.
- Original baseline: `e93b679b6d3808b9202e8b2b6162f76ef4c8156d`.
- Parent accepted candidate: `3cc16ca12c8d614d681562024088d01492a70914` (review #3931); its full suite exposed the PR2 registration omission below.
- Tested current repair commit: `9efcbcee7b2b0b29b30b5e9cb7bd1d08534a7e61`.
- Tested current repair tree: `f4580d918f605cca4df29d4e8843477a48e1ccfc`.
- Earlier MV focused commit/tree: `e9835355370512382b279905394bf1a33787cf5d` / `cf80281df97b1639cd0c883db782151c05129487`.
- The notes-only successor leaves tested source/SPEC/tests unchanged. The final writer message pins its exact commit/tree; obtain it with `git rev-parse HEAD HEAD^{tree}` (no self-referential hash here).
- All repairs are NEW commits. No amend/rebase/submit/candidate attest/merge/publish, app access, other-worktree edits or installed dsa runs were performed.

## Reproduction and accepted contract

- Parent full-suite evidence: `/tmp/owed-bench/logs/q-attest-1-205420.log` on accepted candidate 3cc16ca failed only PR2 (1/2199): three unregistered raw-source sites in `Driver.attest`. Source inspection confirmed comment, durable execution name and observed-exit diagnostic, none a user-facing remedy. The parent authorized exact-site registration, not assertion or selector changes.
- Parent D1 evidence: `/tmp/owed-bench/logs/q-attest-1-195049.log` shows sealed exit 75 reused indefinitely with unchanged ledger length; later pass did not execute attest.
- Parent D2 evidence: `/tmp/owed-bench/logs/q-attest-1-195123.log` shows restart after hard stop reused the stopped seal and halted.
- Parent ruling keeps the deterministic SHA-256 base id. A confirmed existing seal is reusable only for normal exit 0/1/4. Existing non-results (75/stopped/unknown/signal/invalid/other exit) advance in order to `base:r1` ... `base:r20`; exhausting r20 halts. Running/queued reuse attaches, not duplicates. Fresh/watched seals retain normal mappings; own hard stop is cancellation, never halt. Refusal/conflict/transport failures do not advance ids.
- The original 17-test red proof did not cover the final test file; ledger #3907 timed out at 900 s. That incomplete proof is superseded by the final-file isolated baseline run below.

## Changes

- `src/dsa.ts`: ordered capped retry-id search; distinguishes first inspection of a confirmed existing seal from a newly created or live-attached call watched to completion; retains selected rid in callback/result/error; explicit cancelled result for own abort. Existing argv/env/session/lease and bounded stop/describe behavior retained.
- `src/drive-run.ts`: reports selected retry id, not base; own stopped/cancelled measurement finishes with no halt/result reports. Ledger, busy back-off, K1 and observation writers unchanged.
- `docs/SPEC.md`: documents parent retry clarification, r20 limit, old-vs-watched seal distinction and hard-stop cancellation/restart.
- `test/attest0320.test.ts`: now 34 tests. Added 75 then real observation, stop/restart then real observation, running single-execution attach, r20 cap, existing unknown/stopped/signal/other seals, and reusable 0/1/4. All feature waits are bounded to 2 s, settlement to 5 s (cap test 10 s), per-test timeout 30 s (real K1 40 s). Added early assertions before reading absent call data. CLI cleanup releases the fixture gate before SIGTERM, bounds close, then SIGKILLs/destroys owned pipes if needed. No indefinite settle/close wait remains in the test body.
- `test/needs-structure.test.ts`: exactly three added registry entries under the existing `src/drive-run.ts` / `Driver.attest` group; comment digest `e6d30118a1dc15c68a1c1f7c299daba381d628f85d0ee342764be3008d78e1e6`, executable argv/name digest `fd50aae8caf19056094caf03b3a2754cd8bc33897be7b20ffe372e87d4cc800e`, diagnostic example digest `24358303d8d5def129537da6e1f7ea6e29aa6bbc8069ddce69f79817350407ba`. Each has a specific reason. No runtime source, PR2 logic, other assertion or `src/ext-worker.ts` entry was changed in this repair.
- `docs/notes-0.32.0/q-attest.md`: current full-suite evidence supersedes the earlier unrun-full-suite limitation.

## Existing-test changes

Current PR2 repair changes only the three exact `registered` entries described above; PR2 logic and every assertion are unchanged. Earlier MV repair changed `test/attest0320.test.ts`: bounded assertion waits/settlement/CLI close cleanup, assertion before changed-candidate id access, first-command assertions for K1/CLI/stop gates, fake execution count and real CLI observation support, plus the eleven listed retry/reuse cases. Those assertions were added/strengthened, not skipped or weakened. No helper or fixture file was changed.

## Commands and exact-tree results

All test/typecheck execution used `/tmp/owed-bench/run.sh /work/pi-owed/.owed/wt/q-attest-1 <seconds> '<command>'`; complete logs record command, commit/tree and exit. No local Node/tsc was used.

1. Repair red, timeout 120, commit `44a705ec6d1f7aeb5b813528c543c821b64774ed`, tree `161731749ba82850c4d7c0e1b8986450c4453fe7` (source still e95f021): `node --test --test-reporter=tap --test-name-pattern="later pass retries|restart after hard|running reuse attaches|retry-id cap" test/attest0320.test.ts`.
   - `/tmp/owed-bench/logs/q-attest-1-201152.log`, exit 1: 3 ERR_ASSERTION failures (75 retry, stop/restart, cap); running attach passed. Duration 6537.928085 ms.
2. Focused file plus typecheck, timeout 180, commit `fc0955d4bfa02d86b02a51f0c5092693830b6a7f`, tree `851b7760b60fc16e650d31436180863b7277c793`: `node --test --test-reporter=tap test/attest0320.test.ts; a=$?; npm run typecheck; b=$?; printf "tests_exit=%s typecheck_exit=%s\n" "$a" "$b"; [ "$a" = 0 ] && [ "$b" = 0 ]`.
   - `/tmp/owed-bench/logs/q-attest-1-201301.log`, exit 0: 34/34 and typecheck pass, duration 57279.114201 ms.
3. FINAL-file baseline red, timeout 240 (inner Node timeout 180), same final test bytes as the current tree:
   - Local read-only preparation: `git archive --format=tar e93b679b6d3808b9202e8b2b6162f76ef4c8156d > /tmp/q-attest-e93b679-baseline.tar`; copied archive to the bench host with scp.
   - In run.sh: `base=$(mktemp -d /tmp/q-attest-baseline-red.XXXXXX)`; extracted archive, copied ONLY final `test/attest0320.test.ts`, linked bench shared node_modules, initialized an isolated Git repo, then `timeout -k 10 180 node --test --test-reporter=tap test/attest0320.test.ts > red.tap 2>&1`. Baseline helpers came from the archive unchanged. No checkout/current-tree mutation. EXIT trap removed only that temporary copy.
   - `/tmp/owed-bench/logs/q-attest-1-201456.log` contains the exact full driver/proof command and complete TAP. Node exit 1 (expected), proof wrapper exit 0. `red_proof tests=34 fail=34 not_ok=34 ERR_ASSERTION=34`; pass/cancelled/skipped all 0; duration 50642.088005 ms, well under 900 s.
   - Final test SHA-256: `29219ccb86175d62aaa6cc5655606495f5a74c9da078284d2c4cb5fe72fd38ad` (matches final focused tree).
   - Archive SHA-256: `3a5e414c7c2655f80eaa77d41b539adcf985bf33aad54caca61cd18244755ef6`.
4. Earlier final MV focused set plus typecheck, timeout 300, earlier MV commit/tree above: `node --test --test-concurrency=2 --test-reporter=tap test/attest0320.test.ts test/drive-bg.test.ts test/lease.test.ts test/attest-signal.test.ts test/driver020.test.ts test/measure023.test.ts test/dsa.test.ts; a=$?; npm run typecheck; b=$?; printf "focused_exit=%s typecheck_exit=%s\n" "$a" "$b"; [ "$a" = 0 ] && [ "$b" = 0 ]`.
   - `/tmp/owed-bench/logs/q-attest-1-201712.log`, exit 0: 113/113, no failures/cancellations/skips, focused_exit=0 and typecheck_exit=0. Duration 111362.260436 ms.

5. CURRENT full suite/typecheck, clean tested commit `9efcbcee7b2b0b29b30b5e9cb7bd1d08534a7e61`, tree `f4580d918f605cca4df29d4e8843477a48e1ccfc`:
   - Exact command: `/tmp/owed-bench/run.sh /work/pi-owed/.owed/wt/q-attest-1 2700 "npm run typecheck && node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'"`.
   - `/tmp/owed-bench/logs/q-attest-1-212102.log`, exit 0: typecheck passed, tests 2199, pass 2199, fail/cancelled/skipped/todo all 0. Duration 1511040.299281 ms (about 25.2 minutes). PR2 is `ok 1066`; negative fixture assertions also pass. The writer remained in the turn until completion; no timeout/retry/duplicate full run.

Log SHA-256:
- current full suite/typecheck: `603324c04177d5a814d696cc8cd7277b230d6bbb0d81d95c72a6565c6cbb76c8`.
- repair red: `55605d41642ef1a967ae952514983ca7822411df3dfa6ba22d0e285929a19e81`.
- final-file baseline red: `fd530716e9e365abf486073fb6d1dc2ac5cf2de996dfbb9040c64e0ada0a4252`.
- final focused/typecheck: `3402b71647eeea394745903204a8bd4d678bcca717e5abb32043caf18320bd66`.

`git diff --check 3cc16ca` passes. The current test diff is exactly three added registry lines; no assertion change. Earlier Python scan of added shipped source/SPEC lines against `[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]` reported zero CJK; handoff remains English.

## Remaining limits and runtime state

- No ledger schema/writer, observation commit/rollback boundary, lock order or K1 ownership changed. Fresh calls still use busy later-pass back-off; skipping a sealed non-result never starts another concurrent check. Tests record real writes observations after busy and stopped retry.
- Current full suite plus typecheck completed and passed; parent branch integration remains unrun. The parallel q-bound owner retains its separate ext-worker registry changes. Real dsa UI/restart refusal was not exercised (all behavioral execution used isolated fake dsa).
- Merge and internal trunk refresh/sweep remain in-process. A dsa outage/refused stop still cannot prove remote termination; no new total attest timeout was introduced.
- No owned test processes left intentionally running; no submit/attest/merge performed. Stop after this notes-only commit.
