# q-attest — 0.32.0 MV handoff

## Scope and identity

- Worktree: `/home/purboo/project/pi-things/pi-owed/.owed/wt/q-attest-1`.
- Branch: `owed/q-attest/1`; baseline: `e93b679b6d3808b9202e8b2b6162f76ef4c8156d`.
- Tested implementation commit: `d07e67209b826320d3b9701e728830e87b62b522`.
- Tested tree: `82b154f9572de0f699ad405a6121fe5effdb926d`.
- This notes-only successor does not change shipped source, SPEC or tests. Its exact commit/tree is available from `git rev-parse HEAD HEAD^{tree}`; the final writer handoff pins it separately (no self-referential hash in this file).
- Read the packet and complete contract before editing. Only this worktree and allowed files were written. No submit, candidate attest, merge, rebase, amend, publication, wais access or real dsa run was performed.

## Delivered files and behavior

- `src/dsa.ts`: cached read-only command/session capability probe, command spec with explicit driver environment (excluding reserved `DSA_*` and test context), bounded programmatic describe polling, typed command exit/seal parsing, deterministic stop request with bounded pending retry. Existing model run/send/hold semantics retained.
- `src/drive-run.ts`: node attests use durable command calls in the same session used by `drive.lock`, named `owed attest <node>`, labelled project/node/attempt/candidate. The shared no-wait machine hold and leased marker stay inside the call. SHA-256 request identity includes start ledger length. Done 0/1/4, busy 75 and other-exit/error halts retain existing behavior. Explicit unsupported/no-owner fallback logs one explanation. `OWED_DIR` is pinned to the driver's resolved ledger directory.
- `src/drive-bg.ts`: existing in-flight text plus optional `[request-id]`; quiet updated started records preserve measurement age and completion clearing.
- `docs/SPEC.md`: MV behavior, compatibility fallback, exit-data interpretation, hard-stop bounds, diagnostics and in-process merge/trunk refresh/sweep scope.
- `test/attest0320.test.ts`: 23 isolated fake-dsa tests, including exit mappings, no-owner/old/unsupported/refused paths, invalid/signal seals, transport failure, same-id reuse, changed candidate identity, opt-out, lease refusal, real owed K1 across restart, CLI hard stop/status/owner lock and pending stop retry.
- `docs/notes-0.32.0/q-attest.md`: this handoff.

## Existing-test changes

None. No existing test, fixture, helper, threshold or check was edited. The new test file's runner was repaired to read live stop state, honor spec cwd, use the actual driver log location, restrict transport failure to command descriptions and read the plan from driver state. Those were new-fixture fixes, not weakened assertions.

## Validation commands and logs

All Node/tests/tsc ran through `/tmp/owed-ipc/run.sh <worktree> <timeout_s> '<command>'`. Local commands were Git, read-only installed dsa help/source inspection, log hashing and text scans only. Logs are complete; run.sh records exact commit/tree and remote exit code.

Define the following literal command strings for the rows below:

- A: `node --test --test-reporter=tap test/attest0320.test.ts`
- B: `node --test --test-reporter=tap test/attest0320.test.ts; a=$?; npm run typecheck; b=$?; [ "$a" = 0 ] && [ "$b" = 0 ]`
- C: `node --test --test-reporter=tap --test-name-pattern="describe failure|real owed|CLI hard" test/attest0320.test.ts; a=$?; npm run typecheck; b=$?; [ "$a" = 0 ] && [ "$b" = 0 ]`
- D: `node --test --test-reporter=tap --test-name-pattern="real owed|CLI hard" test/attest0320.test.ts`
- E: `node --test --test-concurrency=2 --test-reporter=tap test/attest0320.test.ts test/drive-bg.test.ts test/lease.test.ts test/attest-signal.test.ts test/driver020.test.ts test/measure023.test.ts test/dsa.test.ts; a=$?; npm run typecheck; b=$?; printf "focused_exit=%s typecheck_exit=%s\n" "$a" "$b"; [ "$a" = 0 ] && [ "$b" = 0 ]`
- F: `node --test --test-concurrency=2 --test-reporter=tap test/attest0320.test.ts test/dsa.test.ts; a=$?; npm run typecheck; b=$?; printf "focused_exit=%s typecheck_exit=%s\n" "$a" "$b"; [ "$a" = 0 ] && [ "$b" = 0 ]`

Every row used worktree `/home/purboo/project/pi-things/pi-owed/.owed/wt/q-attest-1`; all log names below are under `/tmp/owed-ipc/logs/`.

| Commit | Timeout | Command | Log | Exit/result |
| --- | --- | --- | --- | --- |
| `23b21dd998d2426443a866c5c79c9d28d8366def` | 120 | A | `q-attest-1-192650.log` | 1; 0/17 pass on baseline source. First assertion: `attest must be a dsa command call`. Red proven before implementation. |
| `bc9faf1572aa89f5bffb8447935df1a3c9ee3b81` | 120 | B | `q-attest-1-192957.log` | 0; 17/17 and typecheck pass. |
| `bfc4b2ed5e6436437a4389f5b76417d60beeff92` | 180 | B | `q-attest-1-193411.log` | 1; 18/21, three new fixture failures; typecheck failed on `StatusView.plan`. |
| `76c22cdd107ca0969164cbb4ed0696a901a82914` | 120 | C | `q-attest-1-193533.log` | 1; 2/3, K1 fixture still lacked spec cwd; typecheck pass. |
| `1033d82d3cd904f0b04844b7213eec34f7223671` | 120 | D | `q-attest-1-193819.log` | 0; 2/2 repaired boundary tests pass. |
| `1033d82d3cd904f0b04844b7213eec34f7223671` | 300 | E | `q-attest-1-193839.log` | 0; 100/100 and typecheck pass. |
| `470fd0382cda7f3af9d5ee3fbe6b43697805c2e7` | 160 | F | `q-attest-1-194153.log` | 0; 37/37 and typecheck pass. |
| `d07e67209b826320d3b9701e728830e87b62b522` | 300 | E | `q-attest-1-194355.log` | 0; 102/102, focused_exit=0, typecheck_exit=0; 113521.853992 ms test duration. |

Final log SHA-256: `be1336fdf8fbe38e5ec9e6118590c8d50e7b7f87cb37fd970f73f059a2f563f2`.
Baseline red log SHA-256: `24224df4e12a7e2d3c7c7eb88cf9780084e98a653b79e550ac46c46ae285a2c7`.
`git diff --check e93b679` passed. Changed shipped added lines scanned with Python regex `[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]`: zero CJK matches (source and SPEC); notes are English too.

## Concurrency and limits

- No new ledger writer/kind/field: attest CLI retains K1 and its observation commit/rollback/stale-candidate rules. Driver halts are still appended at reap; hard stop handles no result. Existing lock order is unchanged.
- The fake runner's real CLI K1 test changes ledger length between driver instances; the second command returns busy and records exactly one check observation overall. The same-id test reuses one runner/spec when launch returned pending.
- Graceful drain waits without sending stop; CLI `--now` sends deterministic dsa stop, exits 130 and releases the drive lock. Pending stop is retried with identical argv/request. No unrelated PID or installed service was stopped.
- Full suite/merge invariant was not run (parent integration responsibility). No live `/subagents` or real restart-refusal UI was exercised: installed CLI was inspected read-only, all behavioral execution used fake dsa. Internal trunk refresh/sweep and merge measurement remain in-process.
- A dsa transport outage/refused stop cannot prove the durable command terminated; bounded driver exit retains that existing operational limitation. No total attest wall timeout was added; check timeouts continue to govern work.
