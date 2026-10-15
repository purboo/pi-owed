# SG: failure signatures, failure quotes and timeout evidence

## User-facing behavior

- Measured failure signatures now start with `v2|` and encode the masked first error line, the first (innermost) repository test stack frame as relative `path:line` when present, and independently masked expected/actual values (at most 120 characters each). Node assertion diffs supply values that Node omits from TAP YAML, such as `undefined`.
- `known intermittent` requires a key with both pass and failure evidence for that test; when the current failure has a signature, the failing evidence must match it. A deterministic same-signature trunk failure alone is no longer called intermittent.
- Current-key trunk failures take precedence: `trunk red since #S (after merge #M NODE)` or `trunk red since #S (after adopt #A)`, followed by the action to fix trunk. The starting observation is the first in the uninterrupted sequence of matching trunk failures; a pass, missing name or different signature breaks that sequence.
- Refusals and driver halt notes quote at most three failed tests as `name (path:line): expected X, actual Y`, falling back to the first error line or `(no error text)`. All parsed names remain in the observation. Passing summary tails are not appended to named failures. Anonymous crashes/build errors retain the existing bounded last-output fallback.
- A timed-out measurement retains its last 256 KiB of captured stdout/stderr, then `timeout after Ns`, diagnostic output (if configured), and a best-effort pre-kill process tree. The note remains `timeout after Ns` plus the last three measurement output lines. Timeout remains an error, not a passing measurement.

## Plan keys and CLI

Optional `on_timeout: "<shell command>"` on a check or invariant runs once after the measurement timeout and before killing the measurement process group, with a separate 30-second limit. It uses the same tree, execution environment and wrapper. Diagnostic output is appended to the blob, but is excluded from measurement counts, failed names and signatures; its exit code never changes the verdict.

The key is accepted by plan loading and `owed edit A --set 'checks.C.on_timeout=...'` / `owed edit --invariant I --set 'on_timeout=...'`. No new CLI flag or ledger entry kind is added. Diagnostic-only edits do not change check/invariant keys.

## Compatibility

No new ledger fields. Existing `obs.signatures` values have a new version-tagged encoding; untagged historical signatures remain readable but never equal newly measured signatures. Thus historical signature-based defer carry cannot borrow a newly measured v2 failure unless all required evidence matches. Old readers can still replay the ledger, but retain the old misleading intermittent diagnostics and ignore the new optional `on_timeout` plan key. Upgrade executors, drivers and CLI/plugin together for consistent diagnostics.

## Existing tests changed

- `test/attrib.test.ts`: the AT4 diagnostic test now requires same-key pass/fail instead of trunk failure alone (SG2); the shared defer fixture expects a versioned signature (SG1). Its two defer behavioral tests and gates remain unchanged.
- `test/counts-exit.test.ts`: the `#557` TAP-diagnostic test expects the failed test quote rather than an error-group prefix and summary tail (SG4); counts/min_tests assertions remain unchanged.
- `test/refusalnotice.test.ts`: seven FG2/FG3 note-surface tests (old cargo panic, identical failures, missing error text, literal fallback text, capped names/count failure, repeat union, merge/why/halt) now assert per-test quotes and no last-output tail (SG4). Error extraction/grouping tests are unchanged.
- `test/repeat.test.ts`: four RC3 note-surface tests (red_expect mismatch, reused invariant, note/why/repair/halt, failed merge invariant) now assert bounded failure quotes and omit summary tails (SG4). Repeat votes, receipts, counts, conflicts, red and invariant refusal assertions remain unchanged.

## Interpretation choices / deviations

- Test files are recognized by repository-relative `test/` or `tests/` directories, `.test.` / `.spec.` basenames, or `_tests.<ext>` basenames. Absolute frames outside the materialized tree and node_modules frames are excluded; creation-site TAP `location` is used only for display when no matching test stack frame exists, never as a signature frame.
- SG3 scans complete trunk observation history to report the actual first failure; generic intermittent/older-tree hints retain the existing last-5000-entry bound.
- Missing error details on a parsed failed name are rendered `(no error text)` rather than reusing unrelated output tails.
- Diagnostics are bounded to their last 256 KiB, process snapshots to 4 MiB of `ps` input / 1000 selected rows, with arguments cut to 200 characters and a 2-second snapshot deadline. Missing/unavailable `ps` is explicitly recorded and cannot prevent kill. Linux is behaviorally tested; macOS `ps -axo` is best effort and not exercised on this Linux remote.
- Full suite was repeated only after failed-tree repairs and after a final isolation fix ensuring `on_timeout` protocol-looking output cannot contaminate measurement evidence. No accepted same-tree suite was rerun without a code change.

## Validation

All Node execution, type checks, and tests ran through `/tmp/owed-bench/run.sh` or `/tmp/owed-bench/red.sh` on the remote host, never locally. New `test/sig.test.ts` has 11 tests covering SG1–SG5, real Node assert output, both adopt/merge provenance, anonymous failures, process cleanup, absent/hanging hooks and diagnostic-protocol isolation. Final commands/counts/logs are in the writer handoff.
