# q-park: quiet parking of writers (0.32.0)

## Scope and revision

- Worktree: `/home/purboo/project/pi-things/pi-owed/.owed/wt/q-park-1`.
- Branch: `owed/q-park/1`.
- Integration baseline (q-bound already present): `70298c4e5c96bee662e6de1a1a8f4cb3a57e5ece`.
- Tested code commit: `da0fd61a53fa4dc85bc27d97e6ad9b2133d682bd`.
- Tested code tree: `22f59130f18a94cf1ddd87e2473b82d182519bba`.
- This subsequent notes-only commit adds this file; it changes no implementation or test.
- Contract: `.owed/contract-0.32.0.md`, PK1-PK4 and Common rules.

## Implementation

- `src/cli.ts`, `src/extension.ts`, `src/answer.ts`, `src/ops.ts` expose `--expect report` / `expect: "report"` on decide and answer. Decide treats the expectation as an explicit resume request. Invalid expectations and no-resume/report refuse before effects.
- Decide uses its existing atomic decision append. A new answer validates its ruling and report resume under the same ledger lock and appends both before external delivery. Failed delivery leaves the recorded ruling/resume available for retry.
- Answer retries reuse the original ruling, request id and report resume. They do not add a resume to an earlier plain answer or repark after a later parent act. A report retry requires the original recorded report resume for the current writer attempt; decide-generated answer retries locate it by the existing decision identity.
- Existing resume fields, report follow-up, reported state, single wake and named-parent-act unpark semantics remain unchanged. No new ledger kind, field or enum; no wake renderer changes.
- `src/rebase-view.ts` adds the PK2 stop/pause/wait instruction to `WRITER_DECISION`. `src/drive.ts` adds the explicit parking alternative only to the finished-ruling-follow-up/no-submit halt, retaining the cause, writer reply and existing recovery command.
- `docs/SPEC.md` documents the parameters, refusal/atomicity/retry behavior, parking halt alternative and updated packet text.

## Tests and corrections

New `test/park0320.test.ts` has 11 tests covering both operations parking, report follow-up and exactly one reported wake, three quiet passes with no new ledger writes, unrelated rule staying parked, named rule unparking, atomic invalid-input/batch refusal, failed answer delivery and concurrent retries, refusal to retrofit a plain answer, CLI/tool real worker seams, packet/SPEC text and the PK3 halt hint.

Every changed pre-existing test:

- `test/structask.test.ts`: extends the exact guidance fixture by the PK2 sentence; existing structured-ask and packet assertions remain intact.
- `test/needs-structure.test.ts`: refreshes the exact CLI HELP and decide-tool description hashes for PK1 grammar, and registers only the exact PK3 halt command literal at `src/drive.ts` / `slotAction` under the existing cycle-blocked remedy classification. No whole-file/function exemptions or scanner/assertion changes.

Corrections to the new fixture, not production behavior:

- Replaced the mistaken `DSA_BIN` environment key with the actual `OWED_DSA`; the earlier ENOENT red run is excluded from acceptance evidence.
- Corrected report action/status assertion types, `PassResult` annotation, intentional invalid-input cast and extension tool context type after typecheck failures.
- Parent approved replacing the invented wake phrase `review the reported findings` with exact existing FL3 reported identity, report text and Next command assertions. The single-wake, quiet-pass and named-unpark assertions were retained; no wake rendering changes.
- Empty reported status is omitted by existing `statusView()`, not an empty array; the post-unpark assertion now requires `undefined`, while retaining the next actionable policy check.

## Validation receipts

All Node/tsc/test execution used `/tmp/owed-ipc/run.sh`; no local tests or e2e runs.

### Baseline red

Command (timeout 180 seconds):

```bash
/tmp/owed-ipc/run.sh /tmp/owed-ipc/q-park-red-70298c4 180 'node --test --test-reporter=tap test/park0320.test.ts'
```

- Baseline HEAD: `70298c4e5c96bee662e6de1a1a8f4cb3a57e5ece`, isolated checkout with the corrected OWED_DSA test overlay (before later fixture type/wording corrections).
- Wrapper-reported tracked tree: `37573aeca22d3d0fb505c536ac08dc0e7e4dab92`; dirty=1 because of the added test overlay. This is not claimed as a committed red candidate.
- Exit 1; 11 tests, 0 pass, 11 fail, no skips/cancellations. Failures are behavioral assertions: absent report resume, missing atomic refusal/resume, CLI rejection of the new flag, tool not recording report, missing PK2 sentence and missing PK3 hint. No setup/transport ENOENT in this valid run. The two lifecycle tests fail at their initial resume expectation before the subsequently corrected wake/status assertions.
- Log: `/tmp/owed-ipc/logs/q-park-red-70298c4-220353.log`.
- SHA-256: `d8eba7fca008ee305cb54bcb7dc5a6917537ba52a83c20a532c62fbe200c1e3a`.

### Green focused checks

Command (timeout 420 seconds):

```bash
/tmp/owed-ipc/run.sh /home/purboo/project/pi-things/pi-owed/.owed/wt/q-park-1 420 'npm run typecheck && node --test --test-concurrency=2 --test-reporter=tap test/park0320.test.ts test/resume.test.ts test/needs-structure.test.ts test/english.test.ts test/surface.test.ts'
```

- Tested code commit/tree above, clean worktree; exit 0; typecheck passed; 46 tests, 46 pass, 0 fail/skipped/cancelled.
- Log: `/tmp/owed-ipc/logs/q-park-1-220936.log`.
- SHA-256: `0f315f28c95cd78816bf53b083fe5900ad1de122805255b35fe0497c6fbbdb44`.

### Green complete suite

Command (timeout 2700 seconds):

```bash
/tmp/owed-ipc/run.sh /home/purboo/project/pi-things/pi-owed/.owed/wt/q-park-1 2700 "npm run typecheck && node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'"
```

- Same clean code commit/tree; exit 0; typecheck passed; 2181 tests, 2181 pass, 0 fail/skipped/cancelled; test duration 1513137.8882 ms.
- Log: `/tmp/owed-ipc/logs/q-park-1-221034.log`.
- SHA-256: `2fd66cf9790f659f9f7fd5b754e131feb281dcdb148a029dabfd5004baef16ab`.
- Durable run for sequential focused/full commands: `owed-b1da092bfb45-q-park-1-preflight4`, run `01M5FCQHNFNCMXSY8H9K3HGNDH`, exit 0.

Earlier green-attempt failures are not passing receipts: `q-park-1-220401.log` failed typecheck; `q-park-1-220512.log` and `q-park-1-220729.log` each had 44/46 pass with two new-fixture assertion failures corrected above. The rejected initial red setup run is `q-park-red-70298c4-215855.log`.

## Handoff and limitations

- Diff whitespace check passed; newly added shipped lines contain no CJK prose.
- Driver lifecycle uses fake dsa plus the actual follower; CLI/tool seams use a fake binary with the actual extension/worker and CLI. A live external dsa operational run was not performed.
- No README, skill, CHANGELOG or version changes. No new schema or wake-rendering changes.
- Writer stops after code and notes commits. No owed submit, rebase, attest, merge, tag, push or release action performed. Parent retains submission, independent review, integration and merge-invariant acceptance.
