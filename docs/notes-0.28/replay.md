# Need replay comparison

Replay comparison reads a historical ledger and its blob root without changing the ledger, Git state or driver. It compares status Needs-you commands, compact-why headlines and item lines, and owner notifications actually emitted by the exported driver planner. Agent and executor activity remains context, not an owner prescription.

## Inputs and flags

- The positional input is a ledger; `--blobs` supplies its historical blobs. Plans are resolved by their recorded hash, never by today's plan source.
- `--seqs` selects explicit sequences; `--every` selects periodic sequences; `--halts` includes halt entries. Selection is their union. Without a selector, every entry is sampled.
- `--baseline-src` supplies the older source directory. `--engine` selects the current engine, the older engine or both; supplying baseline source without an engine compares both.
- `--plan-cache` selects an engine-and-hash-isolated JSON cache. Without it, a temporary cache is removed on exit. Missing, partial or corrupt JSON falls back to historical YAML; publication is atomic. Parsed plans are deeply frozen and held in a bounded lazy LRU, not preloaded.
- `--shard i/N` assigns selected samples by their ordinal modulo the shard count, not by ledger sequence; every shard still folds the entire ledger. `--merge` requires every distinct shard of the same ledger, referenced-blob input and configuration. All shards record the complete missing-blob and fold-failure lists; differing global facts reject the merge and matching facts are counted once.
- `--json` emits a structured report. The text report includes findings, coverage and timings. Timing records distinguish fold, YAML parsing, status, driver planning, compact why and the need audit; parsing can be nested within surface timing.

No plan key, ledger field or entry kind changes. Cache entries are tool-side data only; they do not affect acceptance or waiver scope.

## Comparison and coverage

The report separates primary-command disagreement, invalid or incomplete commands, and commands naming an obligation different from the need they are displayed for. Candidate pins, active risk citations, actor flags, evidence files and required acknowledgment are checked independently of CLI syntax.

Coverage is checked per expected line, using the same current-source mapping for both engines:

- Status uses `summaryView` and `summaryHead` in `src/views.ts`: every node need produces a Needs-you line, preserving the within-node need order. The `ns.map(...)` in `summaryView` and `summary.needs.map(...)` in `summaryHead` do not deduplicate identical needs.
- Compact-why headlines use `cardNeeds` and `renderWhy` in `src/views.ts`: the first need supplies the outcome command. `renderWhy` also emits a `Next:` line for every subsequent need via `ns.slice(1).map(...)`; identical needs are not deduplicated, and the headline cannot stand in for a missing `Next:` row.
- Compact-why items follow the outstanding-item map in `renderWhy` and `cardItemLine` in `src/views.ts`. Every outstanding item must remain present. Expectations use the public `Need` and prescribed text forms, not the renderer's own item-line function as an oracle. A need-text arrow must carry the need command. A same-text item without a command, or another contextual no-command item, is counted as information; status still independently enforces the need command. A contextual item with a different primary command is a disagreement. An item without a corresponding need receives existence and argv/obligation checks, not a fabricated owner prescription.
- Emitted, available, non-diagnostic owner notices use `ownerNotify` and `needLines` in `src/drive.ts`: once the owner-need predicate selects the route, every need produces a notice line via `needs(...).map(...).join(...)`; identical needs are not deduplicated. Notifications not actually emitted remain a separate coverage category.

Need-to-row matching is a multiset comparison per surface: exact text-and-command identities are reserved first, then text identities and index fallback use only unconsumed rows. Every matched row is consumed, so identical needs require distinct rows. No compared current-source surface deliberately deduplicates needs.

Missing or empty expected lines are uncovered with the surface and obligation; a present line whose primary command differs from its corresponding need is a disagreement. Secondary lines receive the same checks as headlines. An owner or parent obligation without a need, or a need without a single command, is also uncovered. Missing blobs and replay failures are reported instead of manufacturing state. Empty input, missing requested sequences and empty output cannot produce a successful coverage result. Each report includes `renderedSamples`, the count of renderer calls that returned a snapshot, independently of need-audit success. Individual shards never emit the whole-run `no sampled output` finding; an unsharded run or a complete merge emits it once when the total rendered count is empty.

A notification with an explicitly present `need: null` is separately reported as diagnostic. It cannot hide a live owner need. An owed command anywhere in its text, including an unarrowed instruction in the body, still causes a disagreement; the recognized acts come from the same CLI validator used for argv checks. For example, the historical `checktpl` snapshot at sequence 1950 follows the rank-two block recorded at 1939 and an attributed merge advancing trunk; its owner-diagnostic notification is not a fabricated resolving command.

An owner notification absent from actual planning output is reported as not emitted, with its reason. It is not compared as though a command were emitted. Private older surfaces are reported as unavailable; they are never exposed through source rewriting. The exported older compact renderer remains observable even though its private item builder is unavailable.

The report declares its assumptions: driver running, empty historical run map, time taken from the sampled entry, and no inferred external measurement or question runtime. Only the exact historical driver-attest display suffix authorized by the compatibility ruling is removed; normalization is reported per engine. Other prose and command flags are retained.

## Compatibility and known limits

The adapter uses public older exports and a separate parser cache namespace. The current incremental replay supplies the need oracle, including when only older rendering is selected. An unsupported or invalid historical entry stops that engine's usable replay and leaves an explicit coverage finding.

The tool is a command-surface comparison, not a Git merge guard, ledger hash-chain verifier, historical DSA delivery reconstruction or release-acceptance verdict. Smoke results do not substitute for the release ledger run. Native acceptance checks continue to run under their existing locks.

Finding details are capped while totals remain complete; timing records retain every rendered sample. The memory cache is bounded by entry count and source-text bytes, not a claimed JavaScript heap limit. Ledger state and indexes still grow with entry history. Source renderers scan historical plans; the JSON layer avoids repeated YAML parsing but does not remove those scans. Each shard therefore still bears a full replay cost.

## Changed existing tests

The existing replay regressions for normal output, command disagreements, missing blobs, empty output, compatibility, diagnostic limits and shard merging are retained and run against the stricter audit. The shard equality checks now exercise global facts counted once; diagnostic detection also covers body commands under R-028-69. The item-form regressions added under R-028-71 distinguish same-text repair information from wrong-command branches without weakening status coverage. New tests reproduce the missing compact items, dropped secondary lines, ordinal-partition and mismatched-blob findings from that ruling. The multiset and whole-run output regressions under R-028-72 additionally retain identical same-note block needs and compare rejected-fold coverage across shard counts. The existing synthetic fixture gains a same-note mode; its normal branches and previous assertions remain. No shared helper, external fixture or pre-replay test changes.
