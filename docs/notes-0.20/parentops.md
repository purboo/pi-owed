# 0.20 parent operations (PO)

Upgrade every driver, CLI and pi plugin together. This node adds no ledger kind and no plan key. Plans and ledgers without the new optional resume field retain their previous reducer states and obligation keys. Older readers refuse resume entries containing `batch`.

## User-facing behavior and outputs

- **PO1 — unnecessary amend:** when all added paths are covered by the current plan's matching `allow.writes`, `owed amend` and `owed_amend` refuse without recording entries or changing the plan file. The exact diagnostic is `not needed: <paths> are covered by allow rule (plan #<seq>); owed grants them at measurement; tell the writer to edit them`. `<seq>` is the current recorded plan seq; paths are comma-separated. Mixed covered/uncovered additions retain the existing authority rules. The writer allowance line is `Pre-authorized by the owner (allowance plan #<seq>): <prefixes> — edit these freely; do not ask the parent; owed grants them when your candidate is measured. Change files there only when the task needs it.` Grant validation, closure restrictions, overlapping-slot restrictions and reviewer judgment remain unchanged.
- **PO2 — batch resume:** CLI `owed resume A,B,C` and tool `owed_resume {node: ["A", "B", "C"], ...}` accept multiple nodes with the same note, after and expect options. IDs are trimmed and deduplicated. A single lock validates every member before one append; unknown nodes, missing slots, unresolved needs-parent blocks or invalid options refuse the entire batch. Each member records a normal resume entry plus `batch: <first resume seq>`. A single unique node retains the old entry shape. Batch text prints each existing resume receipt on its own line, followed by the existing wait message when applicable. Batch CLI JSON and tool details are `{entry: <first>, entries: [<all>], merged?: true}`; single-node CLI JSON and tool details remain the resume entry. Empty lists fail with `resume needs a non-empty node list`.
- **PO3 — attributed metrics:** `owed report --metrics` / `owed_report {metrics: true}` add `parentActs.byNode`, `parentActs.perMergedNodeAttributed`, `parentActs.pending` and `parentActs.unattributed`. An act divides one unit equally across its distinct explicit node targets; a resume batch counts once across its members. A plan act targets added, removed or changed node specs. General `*` rulings, genesis, trunk-only changes and other acts with no explicit node target are unattributed. `pending` sums attribution to nodes not merged inside the selected window; `perMergedNodeAttributed` sums attribution to nodes merged inside the window divided by the merge count (null without merges). Existing metrics retain their meaning, with batches counted as one parent act. New text lines: `Attributed parent acts per merged node: <number>; pending <number>; unattributed <number>` and `Parent acts by node: <id> <number>, ...` (`none` for an empty map; `n/a` for null ratios). Window boundaries remain since-exclusive and until-inclusive; a batch intersecting the window counts once among the resume entries visible at its until boundary.
- **PO4 — overlap advisory:** CLI/tool plan replies and edit dry-run previews include per-pair warnings: `writes of <a> overlap <b> (on the critical path): consider deps <a> after <b>`. All equally longest unfinished dependency chains are critical. `<a>` is newly added or dispatch-ready under the proposed plan, `<b>` is unfinished on a critical chain, their write prefixes overlap and neither depends transitively on the other. Each unordered pair appears once; merged nodes are omitted. This changes no plan or gate. Plan replies use their existing `warnings` array; edit previews add a `warnings: string[]` result field.
- **PO5 — attest status:** node, genesis and trunk attest exit 0 only when no measurement failed and nothing is outstanding, exit 1 for measured failures (including current cached failures), and exit 3 when no measurement failed but obligations remain open, including pending review or measurement errors. Newly recorded attribution failures also produce exit 1. Busy/usage/abort handling is unchanged. The driver accepts 0/1/3 as completed measurements, then decides from ledger state; exit 3 causes no error halt. Exact help line: `attest exit codes: 0 = no measured failure and nothing outstanding; 1 = measured failure; 3 = no measured failure but obligations outstanding.`
- **PO6 — derived ack:** absent an explicit `ack_rulings` / `--ack-rulings`, a driver reviewer's current-attempt, current-candidate review slot reads its recorded launch packet blob and matches the full text of applicable parent rulings in its `Rulings in scope` section. The packet must identify the current candidate commit/submit and the same reviewer identity. Only matching ruling seqs recorded before the launch contribute to the highest derived acknowledgment; the launch's `rulings` metadata alone is insufficient. The resulting review stores the existing `ack_rulings` field. A ruling after launch is never silently acknowledged; explicit acknowledgments still take precedence. Manual reviewers and invalid/missing recorded packets retain 0.17 acknowledgment behavior: omitted ack cannot discharge applicable rulings.
- **PO7 — free-text brief:** CLI `owed edit A --set 'brief=<text>'` and tool `owed_edit {set: ["brief=<text>"]}` preserve unquoted multiline text and additional equals signs literally, including colon-bearing sentences. Explicit quoted or YAML block-string values remain supported. Empty/whitespace-only briefs remain plan validation errors; refusals leave both file and ledger unchanged.

## Public surface inventory

- New CLI flags: none. The existing resume positional argument accepts a comma list; existing attest exit codes change as above.
- Changed tool parameter: `owed_resume.node` is now a string or a nonempty string array; comma lists in strings also work.
- New optional ledger field: `resume.batch?: number` (first resume seq). Replay validates a nonnegative integer reference, contiguous resumes, identical actor/channel/options and distinct nodes.
- New result fields: `ResumeResult.entries?: Entry[]`; `EditPreview.warnings: string[]`; four `parentActs` metric fields listed above.
- New plan keys: none. No obligation-key changes.

## Validation and existing tests

`test/parentops.test.ts` contains ten behavioral tests through CLI, ops, views, the pi tools and the driver's public pass/drain lifecycle. It covers every numbered PO item, atomic refusals, pending/error/failure exits, measured grants, post-launch ruling safety and brief validation.

Existing test adjustments are limited to changed contracts: `amend.test.ts` now expects covered amend refusal rather than an unnecessary plan/rule pair and uses an uncovered prefix in its YAML layout test; `grant.test.ts` expects the stronger allowance packet instruction; `parentacts.test.ts` checks the unchanged legacy fields explicitly alongside the new metrics; `invred.test.ts` expects measured trunk failure exit 1; `init-tool.test.ts` expects unmeasured genesis debt exit 3; `extension.test.ts` expects successful measurements awaiting review to exit 3; `brief.test.ts` and `flow.test.ts` expect pending closure/review debt to exit 3; `gc.test.ts` expects a newly reproduced failing attribution measurement to exit 1 even when the repaired candidate itself is accepted. Additional exact command/results are supplied in the writer handoff after the full run.

## SPEC sections affected

§3.4 Owner allowances; §6 Reducer (resume validation and ledger compatibility); §8 Operations (amend, edit, attest, review and metrics); §8.2 Init and genesis attest; §12.3 Ledger entries / Resume; §12.6 Review packet; §12.7 Execution and surfaces (attest exits and driver handling). Also update the report/metrics and CLI/pi surface descriptions with the field inventory and output strings above.

## Measured checks

All Node commands ran through `/tmp/owed-ipc` on the remote host; no local Node/npm/tsc/test command ran. The final source/test snapshot was the staged tree `874809b8274ce9095cc4892c9160605fed5590bb` based on `a46d7ca151ff052b41fce6771f50b1aa354d520d`; only this documentation's measured-check section changed afterward.

```sh
/tmp/owed-ipc/run.sh /home/purboo/project/pi-things/pi-owed/.owed/wt/parentops-1 900 "node --test --test-reporter=tap test/parentops.test.ts"
# exit 0; 10/10 pass; /tmp/owed-ipc/logs/parentops-1-002747.log
/tmp/owed-ipc/run.sh /home/purboo/project/pi-things/pi-owed/.owed/wt/parentops-1 300 "node node_modules/typescript/bin/tsc -p tsconfig.json --noEmit"
# exit 0; /tmp/owed-ipc/logs/parentops-1-002725.log
/tmp/owed-ipc/run.sh /home/purboo/project/pi-things/pi-owed/.owed/wt/parentops-1 1800 "node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'"
# exit 0; 1055/1055 pass; /tmp/owed-ipc/logs/parentops-1-003010.log
/tmp/owed-ipc/red.sh /home/purboo/project/pi-things/pi-owed/.owed/wt/parentops-1 a46d7ca151ff 900 'ERR_ASSERTION|ERR_MODULE_NOT_FOUND|is not a function|SyntaxError|is not defined|Unknown|unknown' test/parentops.test.ts
# red=shown; test exit 1; base 0 pass / 10 fail; /tmp/owed-ipc/logs/parentops-1-red-002847.log
/tmp/owed-ipc/run.sh /home/purboo/project/pi-things/pi-owed/.owed/wt/parentops-1 900 "node --test --test-concurrency=2 --test-reporter=tap test/amend.test.ts test/brief.test.ts test/compactreply.test.ts test/flow.test.ts test/gc.test.ts test/rulings-carried.test.ts test/reviewdedup.test.ts"
# exit 0; 58/58 pass; /tmp/owed-ipc/logs/parentops-1-002814.log
```

The initial full snapshot had six failures (1048/1054 passed, exit 1, `/tmp/owed-ipc/logs/parentops-1-001817.log`): covered amend in the YAML layout fixture, two brief scenarios expecting review-debt exit 1, the single-node resume phase line, a flow scenario expecting judgment-debt exit 1, and gc expecting exit 0 despite a newly measured failing attribution. The changed assertions and restored single-node phase line passed the 58-test regression and the final full suite above. No failures remain; no service or release was published by this writer.

## Interpretation choices / deviations

No scope or acceptance-gate deviation. Equal-length longest chains all count as critical; each overlap pair is printed once. Repeated node IDs are deduplicated. General `*` rules are unattributed because they name no explicit node. Omitted acknowledgments without a qualifying launch preserve the existing recording/debt behavior rather than adding a new refusal policy.
