# CT1 — Check templates (0.20)

Checks and invariants accept `template` instead of `run`. Plan loading validates and expands the template into the existing `run` and (for test templates) `min_tests` fields. The parsed plan stores no template metadata. Item keys hash the expanded command through the existing key rules; a handwritten check using the identical expanded `run` and `min_tests` has exactly the same keys. Plans without templates retain their 0.17 parsed shape, keys and receipt shape. Upgrade every driver, CLI and pi plugin together.

## New plan keys

On either `nodes[].checks[]` or `invariants[]`:

- `template`: `cargo-tests`, `node-tap`, or `evidence-json`.
- `cargo-tests`: required non-empty `package`, optional non-empty `test` (Cargo integration-test target), optional `filters` (array of non-empty strings; defaults to `[]`), required safe integer `min_ok >= 0`.
- `node-tap`: required non-empty `files` array, optional non-empty `name_prefix` (literal prefix, not a regular expression), required safe integer `min_ok >= 0`.
- `evidence-json`: required non-empty `path` and non-empty `required` array of dot-separated field paths without empty segments. Numeric segments address array indexes. Fields must be own properties; `false`, `0`, empty strings and `null` count as present. Inherited properties do not.

All template strings reject NUL. Template-specific keys belonging to another template are refused. `run` with `template` is refused. Test templates set `min_tests = min_ok`; an explicit `min_tests` is allowed only when equal to `min_ok`. Evidence JSON does not synthesize `min_tests`; the existing optional explicit field remains available. Existing `reads`, timeout, red, repeat and closure rules are unchanged; templates do not infer reads, red-test files or closure paths. In particular, use `tests` explicitly for a red check.

No new CLI flags, pi tool parameters, ledger fields or ledger entry kinds. The existing plan/edit tools load templates through the same parser. Receipt JSON adds optional `items[].run` and `mergeChecks[].run` for expanded template commands only (runtime view fields, not ledger fields). This includes `owed why a`, `owed why trunk`, `owed why inv:gate` and attest receipts. Text renders the exact expansion following `  run: `; dispatch packets already list the expanded command.

## Frozen expansion version 1

`src/plan.ts` pins `CHECK_TEMPLATE_VERSION = 1`; the frozen implementations are `expandCheckTemplate`, `templateQuote`, and `templateCounter`. Any future change to expansion semantics must use a new command version marker, not silently change v1.

The following notation specifies exact expansion: `Q(x)` surrounds x with single quotes and replaces each embedded single quote by `'"'"'`. Arrays preserve input order; no sorting or ambient configuration is involved. Every generated command starts with the following exact comment plus a newline:

- `# owed-template/v1/cargo-tests`
- `# owed-template/v1/node-tap`
- `# owed-template/v1/evidence-json`

The command after that newline is:

- Cargo: `set -o pipefail; cargo test -p Q(package)[ --test Q(test)] --[ Q(filter1) Q(filter2) ...] | node -e Q(cargoCounter)`.
- Node: `set -o pipefail; node --test --test-reporter=tap[ --test-name-pattern=Q(^escapedPrefix)] -- Q(file1) Q(file2) ... | node -e Q(tapCounter)`.
- Evidence: `node -e Q(evidenceScript) -- Q(path) Q(field1) Q(field2) ...`.

Brackets above denote optional fragments, not literal brackets. Prefix escaping replaces each character matched by `/[.*+?^${}()|[\]\\]/g` with a backslash plus that character. Files are quoted argv, not shell-expanded globs (Node may apply its own supported file patterns).

Counter programs stream the original runner stdout unchanged and collect it to count at EOF. Cargo sums all column-zero summaries matching `/^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/gm`. TAP takes the final column-zero `# pass` and `# fail` summaries, then subtracts successful empty-file wrappers matched by `/^1\.\.0\r?\n# Subtest: [^\n]*\r?\nok \d+ - /gm` (Node 24 reports such a wrapper after a zero-match name filter). Ignored/skipped tests and empty-file wrappers do not satisfy `min_ok`.

When summaries are present, counters print `owed-counts ` followed by `JSON.stringify({pass,fail,...(failed.length?{failed}:{})})`. Failed names come from `/^test (.+) \.\.\. FAILED\s*$/gm` for Cargo and `/^\s*not ok \d+\s*-\s*(.+)$/gm` for TAP. The existing parser bounds stored names to 50. A counter exits 1 for missing summaries, any failing count or fewer successful tests than `min_ok`. Bash `pipefail` also retains a runner nonzero exit, including a crash after otherwise successful summaries. Standard runner diagnostics remain in the measurement log; timeout remains an executor error, never a counted pass. Templates require Bash and Node; Cargo templates additionally require Cargo. They do not install dependencies.

The evidence program uses `JSON.parse(fs.readFileSync(path,'utf8'))`, traverses each field with `Object.hasOwn`, and prints `owed-counts {"pass":1,"fail":0}` on success. On failure it writes `evidence-json: <error message>` to stderr and prints `owed-counts {"pass":0,"fail":1,"failed":["evidence-json: <path>"]}` before exiting 1. Missing own fields use the exact error `missing field <field path>`. A nonexistent file, invalid JSON or missing field all fail.

## Validation messages

Errors name the full check/invariant field path (`nodes[0].checks[0]` or `invariants[0]`, for example) and record no plan:

- `<field>.template: unknown template <value>`
- `<field>.run: cannot be combined with template`
- `<field>.<string key>: expected non-empty string without NUL`
- `<field>.<list key>: expected a non-empty array of non-empty strings without NUL`
- `<field>.filters: expected an array of non-empty strings without NUL`
- `<field>.<key>: not supported by template <template>`
- `<field>.min_ok: expected integer >= 0`
- `<field>.min_tests: must equal template min_ok`
- `<field>.required[<index>]: expected dot-separated field path without empty segments`

## Behavioral verification

`test/checktpl.test.ts` adds seven behavioral tests through CLI/ops/views and repository helpers: all three templates, shell-sensitive argv, literal prefix filtering, multiple files, skips/zero matches, insufficient successes, crashes/nonzero runner exits, timeout, evidence validation, invariant merge measurements, command receipt visibility, exact normalized/key equivalence, and field-specific no-write validation. Cargo uses a hermetic argv-validating stand-in that emits libtest output; this verifies the command and count behavior without a Rust build dependency. No existing tests changed.

Remote checks against the current source/test tree:

- Focused: `node --test --test-reporter=tap test/checktpl.test.ts`: 7/7 pass, exit 0; `/tmp/owed-ipc/logs/checktpl-1-002802.log`.
- Typecheck: `node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit`: exit 0; `/tmp/owed-ipc/logs/checktpl-1-002855.log`.
- Red on `a46d7ca151ff`: 0/7 pass, 7 fail, exit 1 (`red=shown`); `/tmp/owed-ipc/logs/checktpl-1-red-002855.log`.
- Full (once): `node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'`: 1052/1052 pass, exit 0; `/tmp/owed-ipc/logs/checktpl-1-003046.log`.

All commands ran using `/tmp/owed-ipc/run.sh` (or `/tmp/owed-ipc/red.sh`) with the assigned worktree and prescribed bounded timeouts. No Node, npm, tsc or tests ran locally.

## Interpretation choices / deviations

No scope deviations. Small interpretation choices: `min_ok` is required and allows zero; it counts successful tests only. Cargo `test` means `--test <target>` and `filters` are ordered libtest arguments after `--`. Prefix matching is literal/anchored. Evidence fields mean presence, not truthiness; array indexes use numeric dot segments. Mismatched explicit `min_tests` is refused rather than silently weakening either threshold. Templates are normalized, so no new shared plan/ledger types are necessary.

SPEC sections affected: §3 Plan, §4 Items and keys, §7 Executor (including RC2 Counts protocol), §9 Views, §10 CLI, §11 pi extension (same plan input, no new parameters).
