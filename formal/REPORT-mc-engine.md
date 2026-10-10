# REPORT mc-engine — owedmc engine

Scope: `formal/` workspace (`mc` engine library, `models` with the `owedmc` binary and the `toy-counters` model),
README, `.gitignore` (`formal/target`). std only, no dependencies, edition 2024 (resolver 3). The pinned API of
contract-mc.md is implemented verbatim (`Model`, `Property`); additions are the result types (`check`,
`Options`, `SimOptions`, `Report`, `PropResult`, `Verdict`, `Kind`, `Trace`, `Step`, `Stats`), the type-erased
layer (`DynModel`, `ModelInfo`, `Consts`, `Registry`, `DynReport`) and `mc::cli::main`.

All runs on host ipc (32 cores) via `/tmp/owed-ipc/run.sh`; logs are under `/tmp/owed-ipc/logs/` on the parent
host. Semantics are in `formal/README.md`.

## Tests (`cargo test --offline --release --manifest-path formal/Cargo.toml -p mc`): 27 tests, 8 files

| file | test | proves |
|---|---|---|
| safety.rs | counters_mod_n_have_n_squared_states | N² distinct, 1+2N² generated, diameter 2(N−1) for N=1,2,7,31; matches a naive BFS |
| | invariant_violation_has_shortest_trace | target (5,3) found with a trace of exactly 5+3+1 states, valid steps |
| | invariant_violated_in_initial_state | one-state trace |
| | action_property_violation_ends_with_the_bad_step | `[][A]` violated after N steps; last step is the wrapping IncX |
| | peterson_holds | Peterson HOLDS; count = naive BFS |
| | broken_mutex_violates_with_shortest_trace | 5-state trace = naive shortest distance 4 |
| | dining_philosophers_deadlock_only_when_checked | 3 philosophers: deadlock after 3 steps with `deadlock`, no Deadlock result without it, `terminal` suppresses it, `--prop Deadlock` = `--deadlock` |
| | unknown_property_is_an_error_result / model_panic_is_an_error_result | ERROR results, other properties still checked; panics do not crash |
| liveness.rs | leadsto_fails_without_fairness_and_holds_with_wf | P~>Q fails without fairness (stutter lasso), holds with WF(Finish); lasso checked independently for fairness |
| | weak_fairness_is_not_strong_fairness | intermittently enabled Finish: 2-step fair loop (not stutter); stutter lasso when Toggle is unfair |
| | simulation_liveness_is_sound | simulation reports only sound LeadsTo violations, HOLDS-SIM otherwise |
| | leadsto_on_counter_graph | 144-state graph: holds with per-counter WF, fails without (12-state stem) |
| determinism.rs | counts_and_traces_identical_for_1_4_8_workers | counts, verdicts and rendered traces identical for workers 1,4,8,4,8 on 7 models, incl. 301 equal-depth violations spread over many chunks |
| | early_stop_count_is_deterministic | level-boundary stop: exactly the states with x+y ≤ 8 |
| | simulation_reproducible_by_seed_for_any_workers | same seed ⇒ same result for any worker count |
| simulation.rs | simulation_finds_broken_mutex_and_reports_holds_sim | seed 1 finds the broken mutex; Peterson HOLDS-SIM with 500×41 states sampled |
| | simulation_reproducible_by_seed | 1 vs 6 workers: same trace and counts |
| | simulation_deadlock_and_action_properties | deadlock and `[][A]` in simulation |
| symmetry_limits.rs | canonical_symmetry_reduces_to_multisets | (N+1)^K plain vs C(N+K,K) with `canonical`, both also from naive BFS; trace under symmetry is a real behavior |
| | max_states_gives_timeout | TIMEOUT (never HOLDS); exact limit completes; earlier violation stays VIOLATED; LeadsTo TIMEOUT |
| | timeout_gives_timeout | 10^10-state model stops at 300 ms with TIMEOUT (exhaustive and simulation) |
| sha256.rs | sha256_test_vectors | "", "abc", the 448/896-bit vectors, 1M×'a' in 997-byte pieces, 55/56/64-byte padding edges |
| cli.rs | check_prints_table_and_attribution | table line format, header with engine version, consts and source sha256 |
| | exit_status_counts_errors_and_timeouts | VIOLATED exits 0, 2 TIMEOUT exit 2, 1 ERROR exit 1, `--trace` output |
| | usage_and_build_errors | unknown model/flag/command (64), unknown mode, unread constant, `list` |
| | json_and_simulate_output | one JSON object; `HOLDS-SIM` with "N states sampled" |

Expected numbers come from closed forms or a naive single-threaded BFS in `tests/common/mod.rs`, not from
engine output.

## Results

| check | result | log |
|---|---|---|
| build all targets | ok, no warnings | mc-engine-1-090309.log |
| `cargo clippy --all-targets` | clean | mc-engine-1-090341.log |
| `cargo test -p mc`, 3 consecutive runs on the final code | 27/27 pass each run (exit 0) | mc-engine-1-090704.log |
| mutation probes (8 mutants, script `/tmp/mc-engine-mutants.sh`) | all killed | mc-engine-1-090416.log, mc-engine-1-090524.log |
| red: base 1c76eb3 + `formal/mc/tests/` (`/tmp/mc-engine-red.sh`, cargo variant of red.sh) | red shown: `manifest path formal/Cargo.toml does not exist`, exit 101 | mc-engine-1-red-090726.log |
| throughput + CLI demo | below | mc-engine-1-090553.log |

Mutants (each must fail the named test file): parent tie-break off (first insert wins) → determinism; violation
merge "last worker wins" → determinism (survived at first: the 41 equal-depth violators fit in two work chunks;
the 301-violator case was added and kills it); WF ignored → liveness; no stutter cycles → liveness; deadlock
ignores `terminal` → safety; simulation RNG keyed by execution order → determinism; no `canonical` →
symmetry_limits; limit reported as HOLDS → symmetry_limits.

## Throughput

`owedmc check toy-counters --const K=3 --const N=180 --prop InRange --workers W` (5,832,000 distinct states,
17,496,001 generated, diameter 537, HOLDS):

| workers | time | distinct states/s | max RSS |
|---:|---:|---:|---:|
| 1 | 7.196 s | 810,503 | 266 MB |
| 16 | 1.674 s | 3,482,851 | 264 MB |

Max RSS / distinct states ≈ 45 bytes per state for the whole process (fingerprint store ≤ 36 bytes + 8-byte parent
pointer + log slack ≤ 1/8; the frontier here is small). Liveness on the same model (K=3, N=60, 216,000 states, all
four properties incl. `Wraps` LeadsTo) took 0.30 s at 16 workers.

## Notes and deviations

- Liveness follows TLA+ `[][Next]_vars` semantics: implicit stuttering, so a ~Q state in which no fairness class is
  enabled is a fair (stuttering) cycle. The contract's "a ¬Q deadlock/terminal state" is the special case without
  successors; this also makes "fails without fairness" hold for specs where only stuttering avoids Q, as in TLC.
  A successor equal to its state is a stutter (it neither enables nor takes a class).
- Deadlock is reported as its own property line `Deadlock` (TLC aborted on it instead).
- Simulation counts are "states sampled" (no distinct count); simulation checks LeadsTo only for sound
  (stuttering) counterexamples. `--max-states` in simulation bounds sampled states.
- Depth is the diameter (largest BFS level); TLC prints diameter + 1.
- Model-provided state printers are not part of the pinned trait; traces use `{:#?}`.
- `git describe` is taken from the checkout the binary was built from (on ipc: the mirror commit); the source
  sha256 is the stable attribution.
- Limits: at most 64 fairness classes and 32 LeadsTo properties per run; liveness up to 2^32−1 states.

## Not done

- Scaling is 4.3× at 16 workers; not optimized further (per-insert shard mutex, sequential frontier hand-over and
  one thread spawn per level are the likely costs).
- Strong fairness (SF) is not supported (not used by the a3 specs).
- Liveness memory is not bounded by `--max-states` beyond the state count (edges are kept in memory).
