# owedmc — our explicit-state model checker

`formal/` holds the formal models of owed and the Rust checker that runs them (no TLC, no Java, std only, no
crates.io dependencies). It is not part of the npm package.

```
formal/
  Cargo.toml          workspace (members mc, models; edition 2024)
  mc/                 the engine (library): Model trait, BFS, liveness, simulation, CLI, sha256
  mc/tests/           engine tests on toy models
  models/             one module per model + the `owedmc` binary (src/main.rs); registry in src/lib.rs
  reference/          copied sources the ports are checked against (reference/a3: the a3 TLA+ models, reports,
                      TLC cfg/logs and tlc-runs.tsv extracted from them)
  REPORT-<node>.md    results of each node
```

## Build and run

Heavy work runs on host `ipc` (see `/tmp/owed-ipc/README.txt`), e.g.

```
/tmp/owed-ipc/run.sh <worktree> 1200 "source ~/.cargo/env; cargo test --offline --release --manifest-path formal/Cargo.toml -p mc"
/tmp/owed-ipc/run.sh <worktree> 1200 "source ~/.cargo/env; cargo build --offline --release --manifest-path formal/Cargo.toml -p models && formal/target/release/owedmc check toy-counters --const K=3 --const N=180 --prop InRange --workers 16"
```

```
owedmc list
owedmc check <model> [--mode M] [--prop P]... [--all] [--const K=V]... [--workers N] [--deadlock]
                     [--simulate traces=N,depth=D,seed=S] [--max-states N] [--timeout S] [--trace] [--json]
```

- No `--prop` (or `--all`): every property of the model. `--prop Deadlock` is the same as `--deadlock`.
- `--mode`: the model's mode (default: its first mode). `--const K=V`: model constants; constants the model does
  not read are an error, and every constant read (given or default) is printed.
- `--workers N` (default 4): results do not depend on it.
- Output, as the old TLC `check.sh`: a header (`# engine`, `# model ... sha256 <source>`, `# consts`, `# flags`),
  one table line per property `<model> <mode> <prop> <HOLDS|VIOLATED|HOLDS-SIM|TIMEOUT|ERROR> <N distinct states>`
  (simulation: `<N states sampled>`), a `# stats` line (distinct, generated, depth, time, states/s, estimated
  fingerprint-collision probability), then for each violation its length — the full trace with `--trace`.
- `--json`: one summary object instead (traces included with `--trace`).
- Exit status: the number of ERROR/TIMEOUT results, capped at 255 (a violation is a result, not an error); 64 =
  usage error.

Attribution: `# engine owedmc <version> (git <describe>, src sha256 <hex>)` is recorded at build time by
`mc/build.rs`: `git describe --always --dirty --tags` of the checkout the binary was built from (on ipc that is the
mirror's own commit) and the SHA-256 of the engine sources `mc/src/*.rs` (file name, NUL, length, NUL, contents,
in name order; the stable attribution of the engine). `sha256` on the `# model` line is the SHA-256 of the
model's source file as compiled in (`include_str!`).

## Semantics

**Exhaustive search.** Level-synchronous BFS over `--workers` std threads. States are deduplicated by a 128-bit
fingerprint of `canonical(s)` (two independently salted std SipHash hashers) in a sharded open-addressing store:
per state 16 bytes of fingerprint + at most 20 bytes of table slot (load factor 0.4–0.8) + an 8-byte parent
pointer. Reported: distinct states, generated states (initial states + every successor), depth (the largest BFS
level, i.e. the diameter; TLC prints this + 1), time, and the collision estimate `distinct * generated / 2^128`.
Only the current and next BFS levels keep full states.

**Determinism.** Distinct-state counts, verdicts and counterexamples are identical for any worker count: when
several transitions of one level reach the same new state, the parent with the smallest fingerprint wins (its
first such successor in `next` order) for both the parent pointer and the stored representative; among the
violations of a property at the smallest depth, the one with the smallest (depth, state fingerprint, successor
index) is reported; runs stop only at level boundaries (except on a limit). Fingerprints come from std's
`DefaultHasher`, so the tie-break (not the verdicts or counts) could change with a Rust release.

**Counterexamples** are shortest (minimal BFS depth). They are rebuilt without stored states: parent pointers give
the fingerprint path, which is replayed from `init` (first matching initial state, then the first successor in
`next` order whose canonical fingerprint matches). Each step prints the action (`{:?}`) and the state (`{:#?}`). A
nondeterministic model makes replay fail (ERROR), it does not produce a wrong trace.

**Properties.** All selected properties are checked in one pass and each gets its own first violation:
- `Invariant`: on every reachable state, initial states included.
- `Action` (`[][A]_vars`): on every transition `(s, a, t)`; the trace ends with the violating step.
- Deadlock (`--deadlock`, reported as property `Deadlock`): a state without successors that is not `terminal`.
- `LeadsTo` (`P ~> Q`): needs the whole graph, which is kept only when a LeadsTo property is selected. TLA+
  semantics of `Init /\ [][Next]_vars /\ WF_vars(C1) /\ ...`: every behavior may stutter. A class is *enabled* in
  a state if some successor different from the state comes from an action of that class (`fairness(a)`); a step
  `s -> s` is a stutter and neither enables nor takes a class. A cycle is weakly fair if every class enabled in
  every state of the cycle is taken on the cycle; stuttering forever at a state is fair iff no class is enabled
  there (so deadlock/terminal states count). P ~> Q is violated iff a reachable P /\ ~Q state has a ~Q path to a
  fair ~Q cycle. The check computes the strongly connected components of the ~Q subgraph (for weak fairness the
  whole component is the best candidate cycle), marks the fair ones, and searches backwards. The reported lasso
  starts at the shallowest such P /\ ~Q state (ties: smallest fingerprint), takes a shortest ~Q path to a fair
  component and then a cycle in it that covers each class that must be taken or disabled; `-- back to state i
  (loop) --` or `-- stuttering forever at state i --` closes it.
- `Eventually` (`<>Q` from the initial states, e.g. TLA+ `Finished == <>Done`): violated iff an initial ~Q state
  has a ~Q path to a fair ~Q cycle (stuttering at a ~Q deadlock/terminal state included). Internally it is
  `P ~> Q` with P = "is an initial state" (BFS level 0), which is exactly `<>Q` for behaviors that start in an
  initial state; `Init ~> Q` with Init as a state predicate is different when an initial *value* recurs later
  (tests/followups.rs). Lasso and trace as for LeadsTo.
- When every selected safety property (invariant, action, deadlock) is violated and no LeadsTo/Eventually is
  selected, the search stops after the current level.
- `Stats::levels` lists the new states per BFS level (`levels[0]` = initial states); the number of levels is TLC's
  "depth of the complete state graph search".

**Simulation** (`--simulate traces=N,depth=D,seed=S`): N random walks of at most D steps from a random initial
state, choosing a random successor each step (xoshiro256** seeded by splitmix64 from the seed and the walk number,
so a walk does not depend on the worker that runs it). Invariants, action properties and deadlocks are checked
along the walk; LeadsTo is reported only for sound counterexamples (P /\ ~Q held, Q not since, and the walk reaches
a state where no fairness class is enabled, so stuttering there is fair). No violation gives `HOLDS-SIM` (sampled,
not a proof). The reported violation is the one with the smallest (walk number, step), so results are reproducible
by seed for any worker count.

**Limits.** `--max-states N` (more than N distinct states found; in simulation, states sampled) and `--timeout S`
stop the run: every property without a violation becomes `TIMEOUT`, never `HOLDS`. A violation found before the
limit stays `VIOLATED` (it is still shortest, since all shallower levels were complete).

**Errors.** Unknown property names, a panic in the model, or a failed replay are `ERROR` results.

## Writing a model (from a TLA+ spec)

```rust
use mc::{Model, Property};
pub struct Spec { pub n: u32 /* CONSTANTS */, pub mode: Mode }
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct State { /* one field per VARIABLE */ }
#[derive(Clone, Debug)]
pub enum Action { /* one variant per disjunct of Next, with the \E-bound values */ }
impl Model for Spec {
    type State = State; type Action = Action;
    fn init(&self) -> Vec<State> { /* every state satisfying Init */ }
    fn next(&self, s: &State, out: &mut Vec<(Action, State)>) { /* every successor */ }
    fn properties(&self) -> Vec<Property<Self>> { /* invariants, [][A]_vars, ~> */ }
    fn fairness(&self, a: &Action) -> Option<&'static str> { /* WF classes */ }
}
```

| TLA+ | `Model` |
|---|---|
| `VARIABLES x, y` | fields of `State` (keep them 1:1 so distinct-state counts are comparable with TLC) |
| `CONSTANTS`, cfg values, `Mode` | fields of the model struct, set by `build` from `--mode` and `--const` |
| `Init` | `init()` returns all initial states |
| `Next == A1 \/ \E i \in S : A2(i)` | `next()` pushes one `(Action, State)` per enabled disjunct and per `\E` witness; `UNCHANGED` = copy |
| `INVARIANT Inv` | `Property::Invariant` |
| `PROPERTY [][A]_vars` | `Property::Action` (check `s = t` yourself if A must allow stuttering) |
| `PROPERTY P ~> Q` | `Property::LeadsTo` |
| `PROPERTY <>Q` | `Property::Eventually` (not `LeadsTo` with an Init predicate, see above) |
| `WF_vars(A)` | `fairness(a) = Some("A")` for the actions of A (one class per WF conjunct; `WF_vars(Next)` = one class for all) |
| `SYMMETRY` / `VIEW` | `canonical()` (a representative of the symmetry class / the view); see the liveness caveat below |
| deadlock checking | always pass `--deadlock` when reproducing TLC: TLC (and the old `check.sh`, unless `NODEADLOCK=1`) checks deadlock by default; `terminal()` marks intended end states (TLC: an explicit stutter disjunct) |

**Symmetry and liveness.** `canonical()` with LeadsTo/Eventually is unsupported unless the fairness classes are
symmetric too (a permutation maps every class to itself, e.g. one class for all actions): the graph is built on
representatives, and per-process WF classes (`WF(Inc(1))`, `WF(Inc(2))`) are not preserved by a permutation, so the
fair-cycle test can be wrong (TLC warns about the same). The engine does not detect it; do not combine them.

**Comparing counts with TLC.** Exhaustive HOLDS runs: the distinct-state count and the number of BFS levels match
TLC's directly. TLC's "states generated" counts a transition once per true disjunct of each conjunct on its path
(TLC explores `A /\ (B \/ C) /\ ...` as separate branches), so it can exceed the engine's `generated`; the a3 ports
reproduce TLC's number by weighting transitions (`tlc_branches` in models/src/a3). A violated run of TLC stops at
the first violating *state* with the states found so far (one worker: deterministic; several: schedule-dependent),
while the engine stops at a level boundary; `models::a3::tlc::tlc_order` re-explores in TLC's order (initial states
in order, FIFO, successors in `next` order) for an exact comparison with one-worker TLC.

Register the model in `models/src/lib.rs` with a `ModelInfo` (`name`, `about`, `modes`, documented `consts`,
`source_file: file!()`, `source: include_str!("<file>.rs")`, `build`). `build(mode, consts)` reads constants with
`consts.uint("N", default)?` etc. The test helpers in `mc/tests/common/mod.rs` show complete small models.
