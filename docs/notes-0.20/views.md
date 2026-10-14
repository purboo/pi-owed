# Views 0.20 (NY1–NY7)

Scope: presentation and rebase instructions. Acceptance, block clearance, ledger replay and obligation keys are unchanged. No new ledger entry kinds, ledger fields or plan keys are introduced.

## User-facing behavior and exact strings

- A review block followed by a recorded repair follow-up, or a newer candidate pending review, appears in status/brief progress as `repairing (block #<seq>)`. Its review item is omitted from Needs you during that repair. A later review block is actionable again; a driver halt is still actionable. The block continues to bind acceptance.
- Review guidance is the first suggestion: `owed rule --nodes <node> "<guidance>"`. The second suggestion is `owed review <node> [--obligation closure-review] --ok --rank 3 --as owner:cli --candidate <commit12> (overrides a valid block: state the accepted risk)`. Under `OWED_CONFIRM=owner`, the principal is `owner:human`. Needs-you uses `review blocked: guidance needed` (or `closure-review blocked: guidance needed`); An owner review with no block reads `awaiting review` / `awaiting closure-review` and keeps the ordinary review command. Only a `⊤` review item says `review needs an owner decision` (or its closure-review counterpart).
- An `approve: owner` node waiting for plan dependencies or a resume-after target appears as `waiting for <deps> (owner approval after)` and its approval is omitted from Needs you until that wait closes. The underlying approval item and gate remain intact.
- Wake messages retain the original question/reason and its commands once, prefixed by `Needs you: `. They retain `Done: <ids>`, `Driver continues (<n> in progress)` / `Driver stopped: <reason>`, `owed drive (<repo>):`, halt guidance and `Next: owed status / owed why <node>`. The repeating `Details:` block is removed. Distinct questions on one node are all retained.
- Both `owed plan` and `owed_plan` begin with `Recorded plan #<seq> (v<version> : +<n> nodes [<ids>], -<m>, ~<k> changed; downgrades: <node>: <what>; ...)`. Empty downgrades read `none`; added ids are joined by `, `. Counts compare the exact recorded prior and next plan blobs, before carries, warnings or boards. `version` is the plan schema version, currently 1.
- `owed why <node>` omits the standalone `owner flag weak confirmation: ...` history line. New CLI flag `--full` restores it. The pi tool `owed_why` adds optional boolean `full` with the same meaning. JSON continues to retain `ownerFlags`, and evidence provenance remains visible.
- Status (including `--full`), brief and why inspect open worktree HEAD ancestry. An unapplied rebase prints `rebase pending (HEAD <h12> not on slot base <b12>)`. On each driver pass, the executor supplies the actual Git result to policy; the driver sends one rebase follow-up per attempt/slot base, using the existing `send` entry with `reason: rebase`. Durable retry still resends the same send id/bytes before the deduplication check; explicit halt, waiting, unresolved parent ruling, question and report ownership keep their existing priority.
- Rebase packets instruct: `First commit your work, then run: git rebase --onto <new base> <upstream>`. The normal drift follow-up retains `trunk moved; rebase your worktree onto <trunk> (<base>): first commit your work, then in <worktree> run \`git rebase --onto <base> <upstream>\`, resolve conflicts within the allowed writes, rerun checks, commit, then \`owed submit <node>\`` (with the existing conflict list, when known). An initial dispatch drift uses `First commit your work, then run \`git rebase --onto <new base> <upstream>\`; resolve conflicts within the allowed writes, rerun checks, commit, then submit. In <worktree>, run \`owed submit <node>\`.` There is no instruction to stash. Upstream is the newest recorded slot base for this attempt that is an ancestor of actual HEAD; if none qualifies, owed computes `git merge-base HEAD <trunk-at-dispatch>` (the dispatch base). Missing/unreadable worktrees supply no HEAD evidence.

## Parameters and data

- CLI: `why <node> --full`.
- Pi tool: `owed_why.full?: boolean`.
- Optional view JSON fields (not ledger): `StatusView.rebasePending?: Record<node, {head, base, upstream, command}>`, `ReceiptCard.rebasePending?: {head, base, upstream, command}`. All hashes are full hashes in JSON.
- Internal driver facts: `DriveOpts.rebasePending?: ReadonlyMap<node, RebasePending>`. The send's ledger base is derived from preceding dispatch/rebase entries; no new field is stored.
- No ledger fields or plan keys added. Plans/ledgers without new view options retain 0.17 replay states and keys.

## SPEC sections affected

§8 Operations (`plan`, `rebase`, `status`, `why`); §9 Views (Needs you, progress, receipt cards); §10 CLI (`why --full`, plan receipt); §11 pi extension (`owed_plan`, `owed_why.full`); §12.4 Views, §12.5 Actions (Git drift fact and rebase follow-up), §12.7 Execution and surfaces, §12.8/§12.8.1 wake messages.

## Validation and interpretation choices

`test/views020.test.ts` contains 10 behavioral tests covering every NY item through real repositories, CLI, ops, view policy and pi tools; the red run against release 0.17 fails on the changed behavior. Full-suite formatting expectations that NY changes are updated individually and listed in the writer handoff. Plan receipt `v` uses the existing schema version; no product-level plan revision counter is added. Repair-in-flight is derived from ledger repair sends until a newer block or driver halt, since presentation does not poll dsa. Weak-confirmation provenance within actual evidence is retained; only the redundant standalone history line is quiet by default.
Existing test changes are limited to the intentional output contracts:

- `allowances`, `confirm-timeout`, `flow`, `init-tool`, `plan-guidance`: plan receipt prefix; ledger path/rev/channel assertions remain.
- `brief`, `fixes`, `halt-quiet`: guidance precedes the labelled override. The CLI brief regression records a ruling, checks the block still binds, then explicitly acknowledges it in the owner review.
- `cli`: weak-confirmation history uses `why --full`.
- `drive-bg`, `drive-live`, `notices`, `resume`, `trunkpark`, plus `test/helpers/wake.ts`: assert retained question/reason/command lines once, final status, deliveries, retries and shutdown without the repeating Details block.
- `drive`, `drive-order`: rebase instruction explicitly says commit first.
- `test/perf/differential.ts`: compare the retained full receipt against the frozen 0.10 renderer and remove exactly the new guidance/override annotation when comparing old presentation. Frozen fixtures, ledger state, keys, validation decisions and guards are untouched.

Remote receipts (all commands via `/tmp/owed-ipc/run.sh`, red via `/tmp/owed-ipc/red.sh`): focused `node --test --test-reporter=tap test/views020.test.ts` 10/10, exit 0, `/tmp/owed-ipc/logs/views-1-002724.log`; TypeScript `--noEmit` exit 0, `/tmp/owed-ipc/logs/views-1-002702.log`; full `node --test --test-concurrency=2 --test-reporter=tap 'test/**/*.test.ts'` 1055/1055, exit 0, `/tmp/owed-ipc/logs/views-1-002754.log`; red on `a46d7ca151ff` 10/10 fail, exit 1 and expected pattern matched, `/tmp/owed-ipc/logs/views-1-red-002816.log`. The earlier full run failed 35 legacy output assertions; those failures were repaired and the final full run passed. No tests/tsc/node/npm ran on the local machine.
