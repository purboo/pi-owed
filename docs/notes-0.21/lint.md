# Plan shell lint (PL)

## User-facing behavior

- `owed init`, `owed plan`, `owed edit`, and edit dry runs run `bash --noprofile --norc -n` on new or changed shell commands before recording the plan. Syntax refusal identifies `node/check`, `inv:id/run`, or `plan/setup`, quotes the first Bash error line, and asks to fix the command and retry.
- Check and invariant runs are checked after template expansion. Setup, explicit string `slot_setup`, and check/invariant `on_timeout` diagnostics are checked too.
- Statically quoted nested `bash -c` / `bash -lc` arguments are checked recursively. Single quotes, double quotes, concatenated words and shell escapes are decoded without executing commands. Shell data (echo arguments, comments and here-document bodies) is not treated as a Bash invocation.
- Missing Bash produces one warning per successful admission, in CLI/tool text and the existing JSON `warnings` array. It does not refuse the plan. Install Bash and record the plan again to check its syntax.
- Identical runs at the same node/check identity are skipped, even if other fields change. Replay, verify, cached plan loading and old invalid runs remain loadable. A changed invalid legacy run is refused.

## Plan keys / CLI flags / ledger fields

No new plan keys, CLI flags or ledger fields. `on_timeout` execution is owned by SG. Lint preserves diagnostic source in the canonical plan blob and compares against the current plan's raw stored blob, so unchanged diagnostics are skipped even before SG's parsed field is integrated.

Optional operation result `warnings` on init/edit and the planSet `shellWarnings` output collector expose advisory text; these are not ledger fields and do not change acceptance keys.

## Compatibility

No ledger format or replay change. Older versions do not enforce this admission lint; use 0.21 for all plan-writing CLI/plugin processes to enforce it consistently. Bash syntax checking is not a test pass and changes no measurement gate.

## Known limits / deviations

- Explicit string `slot_setup` is linted as setup, since it runs at dispatch; `slot_setup: false` is not a command.
- Nested arguments containing runtime expansion (`$VAR`, command substitution or backticks outside single quotes) are not evaluated or linted as resolved scripts. No expansion is executed during lint.
- This is a bounded static shell-word scan, not a full shell interpreter: computed Bash executable names, runtime-generated scripts and indirect shell wrappers cannot be resolved. Ordinary `bash -c` / `bash -lc` invocation words, absolute Bash paths and common `env`/`command`/`exec` prefixes are supported.
- Each syntax process has a 5-second timeout and 256-KiB output limit; non-missing-Bash execution errors refuse admission. Lint is performed outside the ledger lock; existing plan/trunk CAS checks still protect the append, and retries lint against their fresh prior plan.
- No pre-existing suite files were changed. The six tests introduced by this node were extended and two regressions added: ordinary shell arguments remain data; legacy invalid diagnostics survive title-only changes. Syntax-refusal tests additionally assert that the blobs directory stays unchanged.
- Review #2089 and ruling #2099 are implemented: only trusted command positions qualify (ordinary braces are arguments); comparisons use the fresh prior raw plan blob; planSet lints before publishing its plan blob or appending ledger entries.

## Validation (current implementation tree, remote host only)

- Focused: `/tmp/owed-bench/run.sh /work/pi-owed/.owed/wt/lint-1 900 "node --test --test-reporter=tap test/planlint.test.ts"`: exit 0, 8/8 pass; `/tmp/owed-bench/logs/lint-1-095737.log`.
- Types: `/tmp/owed-bench/run.sh /work/pi-owed/.owed/wt/lint-1 300 "node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit"`: exit 0; `/tmp/owed-bench/logs/lint-1-095755.log`.
- Red: `/tmp/owed-bench/red.sh /work/pi-owed/.owed/wt/lint-1 31a764d5a4d0 900 'ERR_ASSERTION|ERR_MODULE_NOT_FOUND|is not a function|SyntaxError|is not defined|Unknown|unknown' test/planlint.test.ts`: red shown, base command exit 1, all 8 tests fail; `/tmp/owed-bench/logs/lint-1-red-095813.log`.
- Full (once): `/tmp/owed-bench/run.sh /work/pi-owed/.owed/wt/lint-1 1800 "node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'"`: exit 0, 1114/1114 pass, no skipped/cancelled tests; `/tmp/owed-bench/logs/lint-1-095835.log`.
- `git diff --check`: exit 0. Only the requested node note was added after the above checks; implementation/tests are unchanged.
