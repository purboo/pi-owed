# Evidence and debt

Read this topic when the corresponding action or failure is relevant. Return to the [core](../SKILL.md) for the loop and hard rules.

## Measure and attribute failures

When one shared failure blocks several nodes, inspect the repository notice and fix the common cause once; name the exact failed test in the fix node's brief. Eligible failures get one same-key retry, accepted non-halted fix candidates go first, and parked nodes reconsider when trunk/evidence/plan/candidate/defer changes. Mixed failures and three distinct failing merge keys still halt. To retain debt knowingly, the parent acting as owner uses `owed decide A,B --defer INV --text "<reason>"`, or records a narrow `allow[].defer` permission: executor deferral requires matching signatures plus a pass and failure on that merge key. Name-only matching supports waiting, never automatic deferral; debt stays visible.

Set invariant-only `remeasure_on` to literal case-sensitive raw diagnostic substrings (empty list disables). Every failure must match; missing/incomplete diagnostics, titles, and error/timeouts do not qualify. Unparsed failures use captured raw output. The policy changes no measurement key or exhausted budget and reacts to current measurements, not cached failures.

Preserve both automatic votes: repeat pools them; otherwise pass plus fail is an owner conflict even on unchanged keys. Exact-key evidence governs; a specific-node defer neither resolves trunk conflict nor authorizes other merges/adoption. Explicit manual remeasurement remains available after the durable automatic budget is used.

Compare `v2|` failure signatures by masked first error, innermost repository test `path:line` and independently masked expected/actual values (120 characters each); historical untagged signatures never match v2, including for defer carry.

Trust `known intermittent` only with same-key pass/fail (mixed repeat runs count) and matching failure signatures when known; same-signature trunk failure alone is not intermittent.

Read `trunk red since #S (after merge #M NODE)` / `(after adopt #A)` as the uninterrupted matching trunk-failure run and fix trunk; current-key matching subject/check/run evidence takes precedence, while passes, missing names or changed signatures break the run.

Read up to three per-test refusal/halt quotes as `name (path:line): expected X, actual Y`, otherwise first error or `(no error text)`; named failures omit unrelated summary tails, while anonymous failures keep the bounded fallback.

Use `owed_attest {node, remeasure:true}` / `owed attest <node> --remeasure` for same-key merge invariant remeasurement, not candidate checks; `all:true` / `--all` measures all invariants.

Use `trunk:true, remeasure:true` / `attest --trunk --remeasure` to remeasure failed current trunk keys after refresh.

Use `owed_resume {node, remeasure:true}` for one driver remeasure before retrying merge; do not combine hold release with remeasure.

Read reused seq/age hints before retrying; without repeat a new pass plus old fail still requires the owner.

Repeat pools every non-error run on a key: `passes*N >= K*total`; old multi-observation repeat ledgers can replay former conflicts as pass/fail.

Use the measured remedy, not a guessed rebase: a non-shared moved-trunk merge-tree break may require rebase; shared failures and trunk-red-only refusals park and name the repository fix instead. New candidate tests use the slot base, not trunk probes.

Submit a new candidate to avoid old-candidate merge-block driver halts; existing blocks still bind until properly cleared.

Defer carry requires complete named test-only failures, matching versioned signatures and current min_tests; trunk failure alone is not proof of intermittency.

Attest codes are 0 done, 1 newly recorded fail (including known_red), 4 obligations open without a new fail, 2 usage, 3 internal, 75 busy; driver halts on internal errors.

`owed attest --trunk` / `owed_attest {trunk: true}` (no node) refreshes current-plan trunk keys and measures changed invariants, abortable and leased; a no-op records nothing. Merge refreshes automatically, retaining trunk observations even on refusal; a quiet driver refreshes too. Named test-only failures already on trunk need no defer, but new names, anonymous failures, timeout/error/count/min_tests failures still refuse. The item stays D with discharger parent and `trunk-red:` detail; `owed status` / `owed why trunk` show when it went red and options (fix node, `known_red` with a fix node, or `owed sweep --commit <trunk>`), and the driver wakes once per invariant/key without halting writers. Before measurement status suggests `owed attest --trunk`; reader upgrade requirements are in [compatibility](compatibility.md).

Use `owed_attest` (CLI `owed attest <node>`) for executor measurements. Rerun attribution for original failures first, then process the current candidate. Read logs and rejection reasons; after repairs, commit, submit, and attest (skip this when owed drive is running: the driver attests). Attest exits 75 (`busy`) when that node's attest is already running (the driver's, or another one): its observations will appear in `owed why <node>`; do not retry in a loop. Attests of different nodes run in parallel.

Entirely trunk-red candidates wait without a driver halt; status/brief share one repository notice, trunk movement resumes automatically, and notice deduplication is per driver process (restart may notify once again).

A `trunk-red:` merge refusal includes a diagnostic `obs.probe: "trunk"` and both observation seqs: fix trunk (a fixing node or the sweep's confirmed automatic escape), or knowingly `owed waive <node> check:X --accept-risk <merge-tree obs seq> --reason "<why>"`; the driver parks entirely trunk-red candidates, never sends this as a writer repair; mixed blocks retain the existing halt behavior. Probes never discharge or block obligations; `status`/`why` recompute classification when trunk moves; an unchanged merge check key can still reuse old-base failure evidence with a new trunk probe. A cleared merge failure can be accepted only when its key still equals the current merge key; the waiver binds only that key, and other cleared/stale risks are refused. `why.mergeChecks` and the status parent queue show refused merge checks separately from candidate acceptance.

Merge refusals, driver merge-refused halts and `why` blocks name other-tree failures (`known intermittent`, last 5000 entries, newest three seqs) and matching unmerged fix candidates (`owed decide <refused> --after <fix> --text "<wait for fix and why>"`, or separate resume; exact names of at least six characters in title/brief/check run/tests). These hints change no gate or ledger field.

Writes-grant recovery: after adding a covering allowance to a failed writes key, submit a new commit (an amended commit message suffices); attribution then `attest --rerun` on that key creates a conflict. Mixed trunk-red refusals still include the uncovered-path allow hint.

Negative observations may only be cleared by the rules. Execution failures require attribution on the original key/commit/base: another failure clears the old block; a pass creates a conflict that only an owner waiver accepting the risk of the corresponding seq clears (the main agent decides it, with a reason).

Do not directly edit the ledger, blobs, or closure to bypass rejection. Defer only permits a specific merge to retain invariant debt; it is not a pass. Invariants cannot be waived.

## Debt, templates and repeated checks

The owner sets ordered `risk` and exact-file JSON `closure_neutral` in the plan; lowering either needs owner authority, never an allowance. Read the diff-derived review count/rank in why; non-neutral closure changes still owe closure-review and full-file check hashes always remain. Pure neutral closure changes may batch (SPEC §6.2a); report/metrics `reviews.sameModel` remains visible even with an acknowledged warning.

Read grant refusal hints from optional writes `grant_refused`, which marks closure/open-overlap refusals regardless of note wording; uncovered-only paths do not set it. Historical field-free observations remain valid and do not infer those refusals from text.

Use literal prefixes or whole-path `*`, `?`, whole-segment `**` in node writes/allow writes/adopt; `dir/**` equals `dir/`. New inputs refuse absolute/traversal/bracket/brace/negation/backslash/embedded-`**` syntax. Conservative containment still requires owner approval for unproven scope widening; exact file grants do not widen a prefix. Historical entries keep their recorded literal dialect; new plan entries carry `writes_syntax: 2`.

Expect eligible partial grants even when other files refuse. Overlap-only writes failures carry `waits_on`; the driver waits for all named slots to merge/abandon and remeasures once on the same key, superseding the earlier overlap-only vote. Other failures keep normal handling; mixed refusal reasons do not auto-retry. Resolve ownership cycles with plan/abandon then resume; without a driver, attest after owners close.

Only the owner adds/reassigns `quarantine: [{test,fix,note?}]`; exact names leave counts until fix merge, whose own merge must repair them.

Quarantine excuses only plain allowlisted `node --test`, exit 1, complete TAP, all failures named/quarantined and remaining `min_tests`; never cargo, templates, red/mutants or crashes/timeouts.

Read quarantine Debt in status/brief/report and `why <fix> --full` for the entries that fix will lift.

Use `cargo-tests` / `node-tap` / `evidence-json` templates instead of run; inspect the versioned expanded receipt command and set reads/red tests explicitly.

Template `min_ok` counts successful tests only, excluding skips/ignored tests and empty input-file wrappers; path-shaped real test titles still count.

Evidence JSON templates require own-field presence, not truthiness; invalid JSON/missing fields fail.

`owed edit --invariant ID --set 'known_red=[{test: "exact obs.failed name", fix: repair}]' --as owner:pi --note WHY` records at most 20 unique names as owner-only debt (no `allow` coverage); names change no key. Only failures entirely composed of active listed tests become W/⚠. `status`, `report`, `brief` and JSON `knownRed` list names/fix nodes/plan seq; full status/`lapsedKnownRed` shows removable entries after the fix merges. The fix node cannot merge while its names still fail, even if already trunk-red. Remove repaired entries with `--unset known_red` or a replacement list.

Check results: one check may chain `cargo test` and `node --test --test-reporter=tap` (the counts sum, format `mixed`). A non-red check that exits non-zero without running a recognizable test (e.g. a wrong cargo package name, exit 101) is `fail` and its note (shown in `owed why` and the repair message) carries the last 5 output lines: fix the command; exit 126/127 with no count is an `error` (the command never ran). Check processes do not inherit `DSA_*` (except `DSA_HOME`), so owed commands inside a check run as a top-level process.

A failure before the command runs (tree preparation, spawn, `setup`) or a disk-full/quota failure with no failing test counted is recorded as `error` with an `environment: ` note: the driver backs off (1, 2, 5, 10, then 30 min) instead of halting, and skips measurements while free disk is below `drive.min_free_mb`; free space rather than waive. When an execution failure was environmental (a missing build artifact, cache or `node_modules` in owed's fresh measurement worktree), fix the check definition instead of waiving: make the check prepare its own artifacts (`setup` or its `run`) in a plan update. That update supersedes the old block (`#<seq> superseded by plan #<p>` in `owed_why`): no rerun and no waiver; the new definition must pass. A plan change of only a node's `checks`, `writes`, `type` or `drive` (or plan-wide `setup`/`exec`/`closure`) carries the open candidate (`Carried <node>: …`; `owed_why {full:true}` shows `carried by plan #P from submit #S`): no resubmit, reviews on unchanged keys still count, and only the changed checks are measured again. A `brief`, `deps`, `review` or other spec change still needs the writer to resubmit. Weakening a check is still an owner downgrade. A flaky block of an unchanged definition still needs the owner's waiver, unless the test itself must change: then `owed_decide` with `nodes: [<node>]`, `writer: true` and text saying what the writer must change. The driver sends a ruling to a sealed writer before any halt, including the owner-needed notify. The block stays flaky after the fix: a plan change of the check's definition supersedes it, or the owner waives it once the fixed candidate passes. A waiver's `accept_risk` clears the cited blocks whatever their key, merge keys included: a waived merge-result fail no longer counts on its key, so a pass on that key (the attribution rerun) lets `owed merge` proceed.

`repeat: {runs: N, need: K}` (`1 <= K <= N <= 9`, need defaults to N) measures sequentially in one tree, stopping when K passes are reached or unreachable; errors stop as errors. It is part of the key, refused on red/mutants checks, and honored at merge. Per-run `min_tests` applies; do not sum runs to meet it. `noisy (2/3 passed)` describes disagreement, not a separate block. A column-0 `owed-counts {"pass":2,"fail":1,"failed":["latency gate"]}` supplies counts (last valid line wins; indented/comments ignored); only this format's fail > 0 fails even on exit 0. Names from owed/TAP/cargo lead per-test failure quotes, including reused observations; only anonymous failures retain the bounded last-output fallback.

`min_tests` counts one TAP, jest/vitest or pytest summary (the last in the log); cargo `test result:` lines add up. Do not loop a TAP command to reach `min_tests` (`owed_plan` warns about such a check); raise the number of tests. Only the parent/owner may correct a mistaken threshold under the contract's or a ruling's authority, with a reason; never loosen it merely to turn a failure green.

## Sweeps, escapes and reports

For measured workflow outcomes, use `owed report --metrics [--since seq|ISO] [--until seq|ISO] [--json]`: merged nodes, interruptions/merge, decision vs no-decision halts, merge timing, first-pass acceptance and repairs/merge, computed only from the ledger and plan blobs; since is exclusive, until inclusive.

Use `parentActs.perMergedNode` as the gate metric: all non-driver owner/parent acts by class; `grants` counts owed grants, while the old interruptions line is explicitly partial (driver halts + answers).

Metrics `--since`/`--until` also accept date-only `YYYY-MM-DD` at UTC midnight. Metrics halt groups preserve plain-word node ids in prose; normalize ids only in node positions (before `:`, before `/`, after `node ` or `--after `, or the argument of `owed <verb> `).

Set `sweep.every: {merges: N, minutes: M}` for background sweeps alongside node work; either positive threshold suffices. Confirmed boundaries record deduplicated `missing` escapes automatically, so the parent does not bisect by hand; fix the named test once and improve invariant coverage. Flaky/inconclusive results report only, never gate a merge. `owed sweep --due` supports cron; a once pass reports due but starts no sweep.

`report --metrics` adds decisions, merged-only parent acts, text-based halt classes, phase estimates and lease wait. `report --counterfactual` gives state-based historical estimates in one read-only cold replay, potentially tens of seconds on a large ledger. Both options are CLI-only. Driver lease wait excludes time between busy passes. Rule receipts are concise; use why's `Ruling to forward` or JSON for full messages. Text clocks are local, JSON timestamps stay ISO UTC; active work replaces stale waits.

Use parentActs.byNode/perMergedNodeAttributed/pending/unattributed to audit per-node effort; resume batches count as one act.

A defect found after a merge is recorded with `owed_escape` (`node`, `merge` = seq of that merge entry, `class`, `note`, optional `evidence`). Decoys belong to the owner: `owed_decoy` with `action: digest` only computes a digest; `commit` and `reveal` are owner acts the main agent makes itself (delegated, no dialog; a UI confirmation only under `OWED_CONFIRM=owner`) — a subagent never does.

Sweeps: optional top-level `sweep: {run, timeout_s, reads?, every?}` runs an advisory suite on detached trunk with `owed sweep [--commit C] [--due]` (pi `owed_sweep`), under the shared machine lease. With `every`, running drivers sweep alongside node work; without it, staying idle drivers retain node-work preemption and retry interrupted heads when idle. Two failed head samples, two failed culprit samples and a passing predecessor confirm a boundary and automatically record a deduplicated `missing` escape; the parent need not bisect manually. Flaky/inconclusive results name no culprit and never gate a merge. Read `Unguarded paths` and coverage hints as report-only, not proof that invariants execute those tests.
