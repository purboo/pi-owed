# REPORT mc-port — the a3 TLA+ models on owedmc

Ports of `PiDagAuth3.tla` and `PiDagMerge.tla` (pi-dag `formal/a3`, commit 09c532f) as owedmc models `a3_auth` and
`a3_merge`, compared with every recorded TLC run; plus the engine follow-ups of review #528. PiDagEvidence is not
ported in this node.

**Result: all 187 comparable recorded TLC runs agree** (174 finished exhaustive runs — 94 HOLDS incl. the
9,305,311-state free run and 7 liveness checks, 80 VIOLATED —, 1 exhaustive run TLC did not finish, 12 sampled
runs): same verdict, same distinct-state count and depth for every
HOLDS run, TLC's "states generated" reproduced exactly, and for violated runs the verdict, a trace no longer than
TLC's and — for every one-worker TLC run — TLC's exact distinct/generated count and trace length via a TLC-order
search. No porting error remained after the first full comparison; the one count mismatch found on the way
("states generated", 1396 vs 1402) is a TLC counting rule, demonstrated below.

## Files

| Path | What |
|---|---|
| `models/src/a3/auth.rs` | `a3_auth` (sha256 `3852e495…`): 17 state fields = the 17 TLA+ variables; modes `a3`, `a22`, `a3-{issue,scope,continuous,writers,past,author,permission,key,state,conflict,same,retro,future}`; consts `Scope=scenarios\|free`, `MaxLog` (default 5) |
| `models/src/a3/merge.rs` | `a3_merge` (sha256 `2e56852c…`): `State = Script(x) \| Free(f)` (TLA+ `x`, `f`; the unused one is the constant `[unused \|-> TRUE]`), record fields 1:1; modes `a3`, `a22`, `a3-{K1,K2,K3,K3state,K4,K5atomic,K5queue}`; const `Scenario` (all 16) |
| `models/src/a3/tlc.rs` | TLC-order search (sequential BFS in TLC's order, stops at the first violating state) |
| `models/src/a3/compare.rs`, `models/examples/a3_compare.rs` | reads `reference/a3/tlc-runs.tsv`, runs every row, judges it (criteria below) |
| `models/tests/a3.rs` | 6 tests (`cargo test -p models -- a3`) |
| `reference/a3/` | copies: both modules (current), `PiDagAuth3-32122309.tla` (the module of the accepted scenario round, from pi-dag cb02d51), CONTRACT.md, REPORT-auth.md, REPORT-merge.md, check.sh, `runs/` (all 253 PiDagAuth3/PiDagMerge cfg+log pairs, results TSVs) |
| `reference/a3/extract.py`, `tlc-runs.tsv` | one row per TLC run from the logs: module sha, mode, consts, property, workers, result, distinct, generated, depth, trace length, simulation size, class |
| `results/a3-compare.tsv` | the full comparison (187 rows) from the ipc run below |
| `run-a3-big.sh` | the big runs (ipc) |
| `mc/` | engine follow-ups (below) |

## How the reference rows are classified (`class` in tlc-runs.tsv)

| class | rows | compared? |
|---|---:|---|
| `current`: module text = reference (Auth3 `4e33cdf2`, Merge `7972e7a8`) | 86 | yes |
| `auth-v1`: Auth3 `32122309`, the parent-accepted scenario round (53 runs of REPORT-auth.md) | 53 | yes: its scenario semantics equal the current module's with `Scope=scenarios` — diff: renamed `Scenario*` definitions behind `IF family#"free"`, two constant variables `everSlots`/`authors` added, and `log[r].from=Owner` added to the revoke test of `Eff`, which every scenario revoke (`R(a,s)`) satisfies |
| `merge-preruling`: Merge `65dadcf3`, scripted run of a property the ruling did not redefine | 49 | yes (identical counts confirm it) |
| `ruling-changed`: `65dadcf3` NoBypassedNegative / EscapeAttributable / DeferredDebtVisible / NewEscapeAttributable (redefined by the ruling) or a free/replay run of the superseded free model | 49 | no (source not retained; superseded by the `current` ruling runs) |
| `intermediate`: other module versions without retained source (d38bdf07, a94efbec, e35f5310, 5d1a8fb4, 4d021af3) | 9 | no |

## Acceptance criteria per row (compare.rs)

- **TLC HOLDS** (exhaustive): owedmc HOLDS with `--deadlock` (as check.sh), **same distinct states and depth**
  (TLC prints diameter+1 = number of BFS levels). **States generated**: TLC counts a transition once per true
  disjunct of each conjunct on its path (it splits `A /\ (B \/ C)` into branches even when B, C do not prime
  anything). The models give that multiplicity (`tlc_branches`); the engine's transitions weighted by it must equal
  TLC's number — they do in every HOLDS row. Example: the 1,019-state scenario graph has 1,396 transitions incl.
  the 18 initial states; TLC reports 1,402. In `Step`, the conjunct `(e.type # "merge" \/ family="good" \/
  Deferred # {})` has two true disjuncts on exactly 6 transitions: in family `state`, the non-merge steps taken
  after the accepted `defer` (from `<<defer>>` 2, from `<<x,defer>>` and `<<defer,x>>` 1 each), so TLC generates
  each of them twice.
- **TLC VIOLATED** (safety): owedmc VIOLATED, its shortest trace no longer than TLC's. owedmc stops at a level
  boundary, TLC at the first violating state, so the counts differ by construction; the TLC-order search must find
  the same violation with the engine's trace length, and for **one-worker TLC runs it must equal TLC's distinct,
  generated and trace length exactly** (all 33 one-worker violated safety rows do). Multi-worker TLC counts are schedule
  dependent: TLC itself gives different numbers for the same configuration (`a22 AuthoritySound MaxLog=4`: 45,443 vs
  46,032 distinct; `NoWriterJudge`: 37,991 vs 38,893 and traces of 4 vs 5 states; runs/*-free-sanity4{-first,}.log),
  so these 45 rows are judged on verdict and trace length and their counts are listed with the engine's per-level
  bounds.
- **Liveness** (GoodProgress, Finished, GoodEventuallyMerges): verdict and the distinct count of the whole graph
  (TLC builds it completely before checking liveness): all equal.
- **Simulation** rows (HOLDS-SIM, or a sampled violation): rerun as simulation at TLC's depth with TLC's walk count
  (num per worker × workers), deadlock checked; owedmc must find every violation TLC found and none TLC did not.
- **INCOMPLETE** (TLC stopped by its time limit): free MaxLog=3 (TLC 4.4M of 9.3M states) is run exhaustively;
  sim6 (TLC stopped after 1,043,507 walks) is simulated with 2,000,000 walks; the unfinished MaxLog=4 exhaustive
  run (~1.9e9 states) is not run (nothing to compare).

## Results (ours vs TLC)

Big runs on ipc, 16 workers, `run-a3-big.sh`, log `/tmp/owed-ipc/logs/mc-port-1-101520.log` (engine src sha256
`08433a0b…`, a3_auth `3852e495…`, a3_merge `2e56852c…`).

Since 0.6.1 `run-a3-big.sh` caps every run like `models/scripts/owed05-big.sh`: `ulimit -v 8000000`, explicit state
caps (exhaustive `--max-states 22000000`; simulations 2e9 sampled states, so the walk count stays the bound), the
model checker's `--timeout` and a wall-clock `timeout` 120 s above it (a3_compare: 3600 s). Rerun on ipc with the
caps (log `/tmp/owed-ipc/logs/fixes-061-1-120655.log`): no cap stops any configuration; every verdict and state
count in the table below is unchanged (MaxLog=3 exhaustive 10.2 s, 1.7 GB RSS; a3_compare 172 s, 3.1 GB RSS,
187 OK, 0 FAIL, 59 skipped, `results/a3-compare.tsv` identical except the seconds column).

| Run | TLC | owedmc |
|---|---|---|
| a3_auth a3 free MaxLog=3 AllSafety (+deadlock) | HOLDS, 9,305,311 distinct, 18,566,311 generated, depth 4; 10 min 41 s, 16 workers | HOLDS, 9,305,311, 18,566,311, 4 levels; 13.3 s, 1.7 GB RSS |
| a3_auth a3 free MaxLog=2 AllSafety | HOLDS 44,311 / 88,411 / 3 | same (unit test) |
| a3_auth a22 free MaxLog=4 AuthoritySound / DecisionAuthority / NoWriterJudge | VIOLATED, 4 workers, traces 4/3/4–5 states | VIOLATED, shortest traces 3 states (stops after level 2, 9,305,311 states, 5.9 s) |
| a3_auth a3 scenario graph, all 20 properties × {a3, a22} | 1,019 distinct, 1,402 generated, depth 6; the H/V table of REPORT-auth.md | identical (unit test; 1,396 engine transitions, 1,402 TLC-weighted) |
| a3_auth 13 ablations (`a3-issue` … `a3-future`) | VIOLATED (2 workers) | VIOLATED, traces ≤ TLC's (table below) |
| a3_auth a3 free MaxLog=6 sim, depth 8 | no violation in ≥1,043,507 walks (stopped at 900 s); smoke 4,000 walks | HOLDS-SIM, 2,000,000 walks, 52 s |
| a3_auth a3 free MaxLog=8 sim, depth 8 | smoke 4,000 walks HOLDS-SIM | HOLDS-SIM, 200,000 walks, 10 s |
| a3_merge a3 free FreeCoreSafety sim depth 20 | HOLDS-SIM, 40,000 walks | HOLDS-SIM, 400,000 walks, 2.4 s |
| a3_merge a22 free EscapeAttributable sim | HOLDS-SIM, 8,000 walks | HOLDS-SIM, 400,000 walks |
| a3_merge a22 free NoBypassedNegative / NodeAcceptanceCovered | VIOLATED (sampled) | VIOLATED (8,000 walks; 17 / 14 states) |
| a3_merge a3 free NothingMerged / NoDeferredMerge / FreeNoTwoMerges | VIOLATED (witnesses) | VIOLATED (16 / 14 / 17 states) |
| a3_merge scripted: 54 current + 49 pre-ruling runs | REPORT-merge.md: 51 HOLDS, 2 HOLDS-SIM, 8 VIOLATED (current round) | all equal; every one-worker violation with TLC's exact count |
| a3_merge live GoodEventuallyMerges (WF) | a3 HOLDS 9; a22 VIOLATED 17; a3-K5queue VIOLATED 24 | same verdicts and graph sizes |

Summary of `results/a3-compare.tsv` (`a3_compare --heavy --workers 16`, 169 s): 187 OK, 0 FAIL, 59 skipped
(ruling-changed/intermediate rows and the unfinished MaxLog=4 exhaustive run).

| class / model / TLC result | rows OK |
|---|---:|
| auth-v1 a3_auth HOLDS / VIOLATED | 21 / 32 |
| current a3_auth HOLDS / VIOLATED / HOLDS-SIM / INCOMPLETE | 5 / 13 / 2 / 3 |
| current a3_merge HOLDS / VIOLATED / HOLDS-SIM | 51 / 8 / 3 |
| merge-preruling a3_merge HOLDS / VIOLATED | 17 / 32 |

### Ablations (each mode removes one clause; TLC and owedmc both report the expected violation)

| Model | Mode | Property (scenario) | TLC (workers, distinct, trace) | owedmc trace; TLC-order distinct |
|---|---|---|---|---|
| auth | a3-issue | AuthoritySound | 2w, 76, 3 | 3; 80 |
| auth | a3-scope | AuthoritySound | 2w, 83, 3 | 3; 158 |
| auth | a3-continuous | AuthoritySound / NothingRevivedWaived | 2w, 552, 5 / 1019, 6 | 5 / 6 |
| auth | a3-writers | NoWriterJudge | 2w, 125, 3 | 3 |
| auth | a3-past | NoWriterJudge | 2w, 334, 4 | 4 |
| auth | a3-author | NoAuthorJudge | 2w, 110, 2 | 2 |
| auth | a3-permission | DecisionAuthority | 2w, 251, 3 | 3 |
| auth | a3-key | RelevantInvalidates / UnrelatedPreserves | 2w, 292 / 340, 3 | 3 / 3 |
| auth | a3-state | StateRemainsDebt | 2w, 126, 2 | 2 |
| auth | a3-conflict | ConflictDebt | 2w, 686, 5 | 5 |
| auth | a3-same | SamePrincipalSupersedes | 2w, 347, 4 | 4 |
| auth | a3-retro | RetroHonored | 2w, 729, 5 | 5 |
| auth | a3-future | FuturePreserves | 2w, 1019, 5 | 5 |
| merge | a3-K1 | NoNewBreakage (genesis; flakyDebt/matrix HOLDS) | 1w, 7, 6 | exact 7, 6 |
| merge | a3-K2 | NoLaundering (launderReview) | 1w, 21, 8 | exact |
| merge | a3-K3 | NoNewBreakage (flakyDebt, matrix; genesis HOLDS) | 1w, 7 / 8, 6 | exact |
| merge | a3-K3state | StateNeverWaived (waiver) | 1w, 11, 7 | exact |
| merge | a3-K4 | GenesisBeforeAdvance (good) | 1w, 25, 6 | exact |
| merge | a3-K5atomic | JudgedAtCommit (race) | 1w, 10, 7 | exact |
| merge | a3-K5queue | LeaseExcludes / NothingMerged / GoodEventuallyMerges (live) | 1w, 5 / 13 / 24 | exact / exact / 24 (liveness) |

## Tests and checks (exact commands, results)

- `cargo test --offline --release -p models -- a3`, 3× in a row: 6/6 passed each time (2.5 s);
  then `cargo test --offline --release` (whole workspace): mc 4+3+9+4+9+1+3+3 = 36 passed, models a3 6 passed,
  0 failed. Log `/tmp/owed-ipc/logs/mc-port-1-101444.log` (`cargo build --all-targets`: no warnings).
- Red on the slot base c4f1988 with `formal/models/tests/a3.rs` grafted, plan command
  `cargo test --offline --release --manifest-path formal/Cargo.toml -p models -- a3`: `red=shown`, exit 101,
  `error[E0433]: cannot find a3 in models`, `no field levels on mc::Stats` — `/tmp/owed-ipc/logs/mc-port-1-red-102020.log`
  (script `/tmp/mc-port-red.sh`, the cargo variant of red.sh).
- Engine follow-up mutants (review #528's survivors) against `mc/tests/followups.rs`: M4 (stutter enables its
  class), M9 (backward reach leaves ~Q), M22 (classes taken on edges leaving the SCC) — each killed (1, 2 and 4
  failing tests). `/tmp/owed-ipc/logs/mc-port-1-mutants-102043.log`.

Unit tests (`models/tests/a3.rs`): `a3_auth_scenario_graph_1019` (both property tables of REPORT-auth.md, 1,019 /
6 levels, 1,402 TLC-weighted), `a3_auth_free_maxlog2_44311` (44,311 = 1 + 210 + 210², 88,411; the 2-step witness),
`a3_reference_exhaustive_runs` (all 167 fast exhaustive rows), `a3_reference_simulations` (12 sampled rows, walks
capped at 20,000 / 4,000), `a3_merge_live_queue_liveness`, `a3_ports_deterministic_and_tlc_order_consistent`.

## Engine follow-ups (formal/mc, additive)

1. `Property::Eventually { name, q }` (`<>Q` from the initial states): `P ~> Q` with P = "BFS level 0", in BFS and
   simulation; `Kind::Eventually`. a3 uses it for `Finished == <>Done` and `GoodEventuallyMerges == <>x.merged`.
   Tests: differs from `Init ~> Q` when an initial value recurs; lasso from a second initial state through a fair
   cycle, identical for 1/4/8 workers; simulation sound/HOLDS-SIM.
2. Regression tests for M4/M9/M22 (+ controls), killing the mutants (above).
3. README: `--deadlock` when reproducing TLC; `<>Q` → `Eventually`; symmetry with liveness unsupported unless the
   fairness classes are symmetric (documented, not detected); comparing counts with TLC.
4. `mc/build.rs` records `git describe --always --dirty --tags` and the SHA-256 of `mc/src/*.rs` at build time
   (`engine_version()`, `engine_source_sha256()`; test recomputes the digest); CLI exit status capped at 255
   (`cli::MAX_EXIT`; test with 256 and 300 ERROR results, text and JSON).
5. Also added: `Stats::levels` (new states per BFS level), needed for TLC's depth and the multi-worker bounds.

## Deviations and notes

- Deadlock: all comparisons check deadlock as check.sh did, except the heavy free authority rows, where the explicit
  `Terminal` at `Len(log)=MaxLog` and the 210 always-enabled events exclude deadlock by construction, and checking
  it would force the whole MaxLog=4 graph (~1.9e9 states) after the violation. The MaxLog=3 HOLDS run checks it.
- Properties TLC cannot evaluate in a scope are not offered there (selecting them is an "unknown property" ERROR):
  merge `NoUnrelatedMerge`, `NoOldDebtMerge`, `GoodEventuallyMerges` in free scenarios and `FreeNoTwoMerges` in
  scripted ones (TLC: no field of `[unused |-> TRUE]`); auth `NothingParentWaived`, `NothingCrossWaived` in free
  (`log[i].key = key` compares an integer with a function). None of these was run by TLC in that scope.
- Simulation sizes are not comparable: TLC counts generated successors and its walks often end before the depth
  (mean length 12 of 20 in the merge runs); owedmc's walks take every step (explicit stutters such as `Terminal`,
  `FFinished` included), reporting states visited. Seeds differ from TLC's; verdicts are what is compared.
- `tlc_branches`/`tlc_order` exist only to reproduce TLC's bookkeeping; no verdict depends on them.
- The engine's `# engine` git describe on ipc is the mirror's sync commit; the engine source sha256 is the stable
  attribution.

## Not done

- PiDagEvidence (by contract).
- The unfinished TLC exhaustive run of free MaxLog=4 (a3 AllSafety, ~1.9e9 states) was not attempted.
- The 58 rows of superseded/intermediate module versions without retained source are not compared.
