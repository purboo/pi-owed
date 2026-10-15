# Writes globs, partial grants and overlap retry (WG)

## User-facing behavior

Node `writes`, `allow.writes`, and `allow.adopt` accept literal prefixes or globs with `*` (characters except `/`), `?` (one character except `/`), and whole-segment `**` (zero or more segments). For example, `app/src/**/*_tests.rs` matches both direct and nested test files; `dir/**` means the existing `dir/` prefix. Literal prefixes retain the existing `startsWith` behavior, including prefixes without a trailing slash. Globs match the whole path and treat regular-expression punctuation literally.

New `init`, plan set, `edit`, and `amend` inputs refuse absolute entries, parent traversal segments, bracket/brace/negation syntax, backslash escapes and `**` embedded in a segment. The refusal identifies the entry and describes the supported grammar. `parsePlan` remains lenient so historical plans accepted by 0.20 can always be reparsed. CLI flags are unchanged; `amend --writes` keeps its comma-separated `+PATH` syntax.

Containment proves coverage only by identical entries or a literal enclosing prefix (including a trailing `/**` equivalent). A matching glob authorizes an exact changed file through a grant; it does not prove that widening a node's prefix to that filename is covered. Such unproven scope widenings still require the owner. Overlap warnings/dispatch conservatively assume overlap unless the entries' literal parts before the first wildcard are disjoint. Grants remain exact paths, never prefixes.

Measurement grants every independently eligible changed path outside node writes in one sorted grant entry, then records a failing writes observation only for refused paths. The note identifies each refused path and all of its open owners, while closure and uncovered paths retain their refusal reasons. The grant and observation append under the existing ledger lock; the executor recomputes paths and eligibility on fresh replay state before appending. Replay validates every grant and rejects invented `waits_on` metadata.

When every refusal is ownership overlap, the observation records `waits_on`. The driver waits without sending a writes repair or halting. Once all named slots close (merge or abandon), it schedules one fresh measurement of the same candidate writes key. An earlier overlap-only failure is superseded by the subsequent writes observation; its execution block is cleared by a subsequent non-error writes measurement, including a fresh candidate/rebase key. Other writes failures retain pass/fail conflicts. Other check failures and review decisions still receive their usual driver actions while writes waits. Mixed overlap plus closure/uncovered failures do not get automatic retry metadata; resolve the other refusals and remeasure after ownership closes.

When waiting candidates form an ownership cycle, the driver halts with Needs-you naming the cycle, for example `a -> b -> a`, and asks for the overlap to be resolved with `owed plan` or by abandoning one slot, followed by `owed resume <node>`. An open owner without a waiting candidate is not a cycle. The same retry behavior is available for new observations under historical plans, using their literal-prefix matching rules.

## Plan keys and ledger fields

- No new plan keys, CLI flags, or entry kinds. Existing writes/adopt lists gain the grammar above.
- New optional `obs.waits_on: string[]`: sorted unique node ids, only on a current candidate writes failure whose refusals are entirely overlaps with those open slots. It is checked on append and replay.
- New optional `genesis.writes_syntax: 2` and `plan.writes_syntax: 2`: every newly recorded plan opts into glob semantics. Absence means exactly the 0.20 literal-prefix dialect, including literal `*`, `?`, brackets and other punctuation. This is ledger metadata, not a new plan JSON/YAML key.
- Existing grant fields are unchanged. Historical writes keys and wildcard-free node keys remain unchanged. A syntax-2 node containing `*`/`?` includes `writes_syntax: 2` in its writes key, so a semantic switch cannot reuse an old-dialect pass. Carried candidates recompute that key.

## Compatibility

Upgrade every CLI, driver and plugin to 0.21 together before using writes globs or overlap retries. Older readers interpret writes patterns as literal prefixes and cannot honor `writes_syntax`; 0.20 rejects observations carrying the unknown `waits_on` field. Historical entries without `writes_syntax` retain their literal semantics even after caches are discarded and their blobs are reparsed, including `app/[id]/`, `a*b/` and `q?/`. The runtime dialect is reconstructed per recording entry during replay, snapshot restore, historical queries and attribution; it is never inferred from the blob hash. Identical blobs recorded before and after opt-in can therefore have different semantics. Opting wildcard-bearing scopes or allowances into glob semantics is checked as a permission change and may require the owner. No automatic migration rewrites old ledgers.

## Existing tests changed

The initial WG implementation changes five `test/grant.test.ts` cases for WG4's intentionally changed behavior:

- `uncovered paths fail atomically with first reason and deduplicated learning hint`: now expects grants for `docs/ok` and `rootfile`, one reason per refused path, and the existing deduplicated learning hint.
- `closure paths are never granted, including mixed covered paths`: the closure path still refuses; unrelated `docs/ok` now receives a partial grant.
- `another open slot owns its plan writes: overlap refuses the entire grant`: now expects a partial grant for `docs/ok` and an ownership-specific refusal for the shared path.
- `removed nodes retain ownership while their writer slot remains open`: only the new `owned by open node b` wording changes; ownership still refuses.
- `dispatch overlap includes exact granted paths; another grant cannot steal them`: only the new ownership wording changes; the other attempt still cannot steal a granted path.

Review revision #2098 changes the existing `test/writesglob.test.ts` WG1 case from parser rejection to lenient historical parsing plus rejection at all four new-plan entry points. Its fixture can now create a genuine 0.20-shaped genesis without a syntax marker. Six added regressions cover cold-cache replay with legacy punctuation, old/new dialects sharing one blob, permission/key isolation, markers on all recording paths, legacy-prefix overlap retry, and a driver cycle halt visible in Needs-you. No other existing tests changed in this revision.

## Validation

All Node, TypeScript and test commands run remotely through `/tmp/owed-ipc/run.sh` or `/tmp/owed-ipc/red.sh`. The current `test/writesglob.test.ts` contains 18 tests covering WG1-WG5 and ruling #2098. Current source/test checks:

- Focused: `/tmp/owed-ipc/run.sh <worktree> 900 "node --test --test-reporter=tap test/writesglob.test.ts"`: exit 0, 18 passed; `/tmp/owed-ipc/logs/writes-1-101634.log`.
- TypeScript: `/tmp/owed-ipc/run.sh <worktree> 300 "node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit"`: exit 0; `/tmp/owed-ipc/logs/writes-1-101656.log`.
- Full: `/tmp/owed-ipc/run.sh <worktree> 1800 "node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'"`: exit 0, 1124 passed, 0 failed/cancelled/skipped; `/tmp/owed-ipc/logs/writes-1-101834.log` (610861 ms). Only validation notes changed after this run.
- `git diff --cached --check`: passed before commit. The source/test delta from prior commit `be219c0` has SHA-256 `c526a2c3d18ad8904a4cb29358578142195557c52f2b1791bf74159f5f3f720a`.
- Red: `/tmp/owed-ipc/red.sh <worktree> 31a764d5a4d0 900 'ERR_ASSERTION|ERR_MODULE_NOT_FOUND|is not a function|SyntaxError|is not defined|Unknown|unknown' test/writesglob.test.ts`: shown, test exit 1, 16 failed/2 passed; `/tmp/owed-ipc/logs/writes-1-red-101841.log`. Additional red on prior submitted commit `be219c04d19051c132cf40e8f069cfd5e25a5097` with the same command: shown, test exit 1, 7 failed/11 passed; `/tmp/owed-ipc/logs/writes-1-red-101856.log`. The earlier writer fails the lenient parser, cold replay, dialect/key isolation, allowance authority, entry markers, legacy overlap and cycle tests.
- Additional focused grant/plan/allow/snapshot/edit integration: 63/63 passed at `/tmp/owed-ipc/logs/writes-1-101046.log`; the final full run also covers these tests.
- The earlier revision full attempt `/tmp/owed-ipc/logs/writes-1-101416.log` was stopped after removing an unintended restriction on new `waits_on` observations under legacy-prefix plans and adding its regression. It is not final-tree evidence.

`<worktree>` is `/home/purboo/project/pi-things/pi-owed/.owed/wt/writes-1`.

## Deviations and limits

No contract/product deviations. `..` means a parent traversal path segment; ordinary filename punctuation is literal. Unsupported bracket/brace/escape closing characters are refused as well as opening syntax. Conservative overlap can delay disjoint globs sharing a literal prefix. Automatic retries require the driver; without it, run `owed attest <node>` after the named slots close. No publication or integration is performed by this writer.
