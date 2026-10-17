# Need replay comparison

Replay comparison reads a historical ledger and its blob root without changing the ledger, Git state or driver. It compares status Needs-you commands, compact-why headlines and item lines, and owner notifications actually emitted by the exported driver planner. Agent and executor activity remains context, not an owner prescription.

## Inputs and flags

- The positional input is a ledger; `--blobs` supplies its historical blobs. Plans are resolved by their recorded hash, never by today's plan source.
- `--seqs` selects explicit sequences; `--every` selects periodic sequences; `--halts` includes halt entries. Selection is their union. Without a selector, every entry is sampled.
- `--baseline-src` supplies the older source directory. `--engine` selects the current engine, the older engine or both; supplying baseline source without an engine compares both.
- `--plan-cache` selects an engine-and-hash-isolated JSON cache. Without it, a temporary cache is removed on exit. Missing, partial or corrupt JSON falls back to historical YAML; publication is atomic. Parsed plans are deeply frozen and held in a bounded lazy LRU, not preloaded.
- `--shard i/N` renders only selected sequences belonging to that shard; every shard still folds the entire ledger. `--merge` combines report files only when every distinct shard of the same input and configuration is present.
- `--json` emits a structured report. The text report includes findings, coverage and timings. Timing records distinguish fold, YAML parsing, status, driver planning, compact why and the need audit; parsing can be nested within surface timing.

No plan key, ledger field or entry kind changes. Cache entries are tool-side data only; they do not affect acceptance or waiver scope.

## Comparison and coverage

The report separates primary-command disagreement, invalid or incomplete commands, and commands naming an obligation different from the need they are displayed for. Candidate pins, active risk citations, actor flags, evidence files and required acknowledgment are checked independently of CLI syntax.

Coverage is explicit: an owner or parent obligation without a need, or a need without a single command, is uncovered. Missing blobs and replay failures are reported instead of manufacturing state. Empty input, missing requested sequences and empty output cannot produce a successful coverage result.

A notification with an explicitly present `need: null` is separately reported as diagnostic. It cannot hide a live owner need, and any resolving command in its text still causes a disagreement. For example, the historical `checktpl` snapshot at sequence 1950 follows the rank-two block recorded at 1939 and an attributed merge advancing trunk; its owner-diagnostic notification is not a fabricated resolving command.

An owner notification absent from actual planning output is reported as not emitted, with its reason. It is not compared as though a command were emitted. Private older surfaces are reported as unavailable; they are never exposed through source rewriting. The exported older compact renderer remains observable even though its private item builder is unavailable.

The report declares its assumptions: driver running, empty historical run map, time taken from the sampled entry, and no inferred external measurement or question runtime. Only the exact historical driver-attest display suffix authorized by the compatibility ruling is removed; normalization is reported per engine. Other prose and command flags are retained.

## Compatibility and known limits

The adapter uses public older exports and a separate parser cache namespace. The current incremental replay supplies the need oracle, including when only older rendering is selected. An unsupported or invalid historical entry stops that engine's usable replay and leaves an explicit coverage finding.

The tool is a command-surface comparison, not a Git merge guard, ledger hash-chain verifier, historical DSA delivery reconstruction or release-acceptance verdict. Smoke results do not substitute for the release ledger run. Native acceptance checks continue to run under their existing locks.

Finding details are capped while totals remain complete; timing records retain every rendered sample. The memory cache is bounded by entry count and source-text bytes, not a claimed JavaScript heap limit. Ledger state and indexes still grow with entry history. Source renderers scan historical plans; the JSON layer avoids repeated YAML parsing but does not remove those scans. Each shard therefore still bears a full replay cost.

## Changed existing tests

None. All replay regression tests and their synthetic ledger data are new; no existing test, shared helper or fixture is changed.
