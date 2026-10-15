# Writes globs, partial grants and overlap retry (WG)

## User-facing behavior

Node `writes`, `allow.writes`, and `allow.adopt` accept literal prefixes or globs with `*` (characters except `/`), `?` (one character except `/`), and whole-segment `**` (zero or more segments). For example, `app/src/**/*_tests.rs` matches both direct and nested test files; `dir/**` means the existing `dir/` prefix. Literal prefixes retain the existing `startsWith` behavior, including prefixes without a trailing slash. Globs match the whole path and treat regular-expression punctuation literally.

Plan load and `amend` refuse absolute entries, parent traversal segments, bracket/brace/negation syntax, backslash escapes and `**` embedded in a segment. The refusal identifies the entry and describes the supported grammar. CLI flags are unchanged; `amend --writes` keeps its comma-separated `+PATH` syntax.

Containment proves coverage only by identical entries or a literal enclosing prefix (including a trailing `/**` equivalent). A matching glob authorizes an exact changed file through a grant; it does not prove that widening a node's prefix to that filename is covered. Such unproven scope widenings still require the owner. Overlap warnings/dispatch conservatively assume overlap unless the entries' literal parts before the first wildcard are disjoint. Grants remain exact paths, never prefixes.

Measurement grants every independently eligible changed path outside node writes in one sorted grant entry, then records a failing writes observation only for refused paths. The note identifies each refused path and all of its open owners, while closure and uncovered paths retain their refusal reasons. The grant and observation append under the existing ledger lock; the executor recomputes paths and eligibility on fresh replay state before appending. Replay validates every grant and rejects invented `waits_on` metadata.

When every refusal is ownership overlap, the observation records `waits_on`. The driver waits without sending a writes repair or halting. Once all named slots close (merge or abandon), it schedules one fresh measurement of the same candidate writes key. An earlier overlap-only failure is superseded by the subsequent writes observation; its execution block is cleared by a subsequent non-error writes measurement, including a fresh candidate/rebase key. Other writes failures retain pass/fail conflicts. Other check failures and review decisions still receive their usual driver actions while writes waits. Mixed overlap plus closure/uncovered failures do not get automatic retry metadata; resolve the other refusals and remeasure after ownership closes.

## Plan keys and ledger fields

- No new plan keys, CLI flags, or entry kinds. Existing writes/adopt lists gain the grammar above.
- New optional `obs.waits_on: string[]`: sorted unique node ids, only on a current candidate writes failure whose refusals are entirely overlaps with those open slots. It is checked on append and replay.
- Existing grant fields and candidate writes key formula remain unchanged.

## Compatibility

Upgrade every CLI, driver and plugin to 0.21 together before using writes globs or overlap retries. Older readers interpret writes patterns as literal prefixes; 0.20 rejects observations carrying the unknown `waits_on` field. Older versions cannot apply the new state-dependent writes retry semantics. Existing valid literal-prefix plans and grant-free keys retain their behavior.

## Existing tests changed

Only `test/grant.test.ts` changes existing tests, for WG4's intentionally changed behavior:

- `uncovered paths fail atomically with first reason and deduplicated learning hint`: now expects grants for `docs/ok` and `rootfile`, one reason per refused path, and the existing deduplicated learning hint.
- `closure paths are never granted, including mixed covered paths`: the closure path still refuses; unrelated `docs/ok` now receives a partial grant.
- `another open slot owns its plan writes: overlap refuses the entire grant`: now expects a partial grant for `docs/ok` and an ownership-specific refusal for the shared path.
- `removed nodes retain ownership while their writer slot remains open`: only the new `owned by open node b` wording changes; ownership still refuses.
- `dispatch overlap includes exact granted paths; another grant cannot steal them`: only the new ownership wording changes; the other attempt still cannot steal a granted path.

## Validation

All Node, TypeScript and test commands run on the remote host through `/tmp/owed-ipc/run.sh` or `/tmp/owed-ipc/red.sh`. `test/writesglob.test.ts` contains 12 tests covering WG1-WG5, CLI amend refusal, matching/adoption/merge, conservative containment/overlap, partial grants, same-key retries after merge/abandon, multiple owners, fresh candidates/rebases, replay/snapshot validation and unchanged ordinary conflicts.

Final source/test tree checks (only this validation note was updated afterwards):

- Focused: `/tmp/owed-ipc/run.sh <worktree> 900 "node --test --test-reporter=tap test/writesglob.test.ts"`: exit 0, 12 passed, 0 failed; `/tmp/owed-ipc/logs/writes-1-092853.log`.
- TypeScript: `/tmp/owed-ipc/run.sh <worktree> 300 "node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit"`: exit 0; `/tmp/owed-ipc/logs/writes-1-092909.log`.
- Full: `/tmp/owed-ipc/run.sh <worktree> 1800 "node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'"`: exit 0, 1118 passed, 0 failed/cancelled/skipped; `/tmp/owed-ipc/logs/writes-1-092938.log` (599615 ms).
- Red: `/tmp/owed-ipc/red.sh <worktree> 31a764d5a4d0 900 'ERR_ASSERTION|ERR_MODULE_NOT_FOUND|is not a function|SyntaxError|is not defined|Unknown|unknown' test/writesglob.test.ts`: red shown, test exit 1, 10 failed/2 passed; `/tmp/owed-ipc/logs/writes-1-red-092944.log`. Nine failures are behavioral assertions; one is the absent new matcher module on the baseline.
- Additional focused grant integration: 28/28 passed before the final newline-anchor regression was added; `/tmp/owed-ipc/logs/writes-1-092505.log`. The final full run covers those grant tests again.
- Superseded full attempt `/tmp/owed-ipc/logs/writes-1-092647.log` was deliberately terminated (wrapper exit 1, no complete summary) after discovering and fixing the trailing-newline anchor edge case. It is not counted as verification of the final tree.
- `git diff --cached --check`: passed before commit.

`<worktree>` is `/home/purboo/project/pi-things/pi-owed/.owed/wt/writes-1`.

## Deviations and limits

No contract/product deviations. `..` means a parent traversal path segment; ordinary filename punctuation is literal. Unsupported bracket/brace/escape closing characters are refused as well as opening syntax. Conservative overlap can delay disjoint globs sharing a literal prefix. Automatic retries require the driver; without it, run `owed attest <node>` after the named slots close. No publication or integration is performed by this writer.
