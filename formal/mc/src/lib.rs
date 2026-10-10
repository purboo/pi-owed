//! owedmc engine: a std-only explicit-state model checker.
//!
//! A model implements [`Model`]; [`check`] explores it exhaustively (parallel, level-synchronous BFS) or by
//! random simulation and returns one [`PropResult`] per selected property. The type-erased layer
//! ([`DynModel`], [`ModelInfo`], [`Registry`]) lets the `owedmc` command line pick models by name.
//! See `formal/README.md` for the semantics.
#![forbid(unsafe_code)]

use std::fmt::{self, Debug, Write as _};
use std::hash::{DefaultHasher, Hash, Hasher};
use std::panic::{AssertUnwindSafe, catch_unwind};
use std::time::{Duration, Instant};

mod bfs;
pub mod cli;
mod dynmodel;
mod json;
mod live;
mod rng;
pub mod sha256;
mod sim;

pub use dynmodel::{Consts, DynModel, DynReport, DynResult, DynTrace, ModelInfo, Registry};
pub use rng::Rng;

// ---------------------------------------------------------------------------------------------------------------
// Pinned API (contract-mc.md, section mc-engine).

pub trait Model: Sync {
    type State: Clone + Eq + std::hash::Hash + std::fmt::Debug + Send + Sync;
    type Action: Clone + std::fmt::Debug + Send + Sync;
    fn init(&self) -> Vec<Self::State>;
    /// All successors of `s` with the action that produced each (TLA+ Next without stuttering).
    fn next(&self, s: &Self::State, out: &mut Vec<(Self::Action, Self::State)>);
    fn properties(&self) -> Vec<Property<Self>>
    where
        Self: Sized;
    /// A state without successors is a deadlock (when deadlock checking is on) unless `terminal(s)`
    /// (an explicit end of a bounded experiment, like an explicit stutter in TLA+).
    fn terminal(&self, _s: &Self::State) -> bool {
        false
    }
    /// Weak-fairness class of an action, for liveness (None = no fairness).
    fn fairness(&self, _a: &Self::Action) -> Option<&'static str> {
        None
    }
    /// Symmetry/view: states with equal canonical forms are one state (default: identity).
    fn canonical(&self, s: &Self::State) -> Self::State {
        s.clone()
    }
}

pub enum Property<M: Model> {
    Invariant { name: &'static str, holds: fn(&M, &M::State) -> bool },
    /// [][A]_vars: must hold for every transition (s, a, t).
    Action { name: &'static str, holds: fn(&M, &M::State, &M::Action, &M::State) -> bool },
    /// P ~> Q under weak fairness of every fairness class (TLA+ WF over each class).
    LeadsTo { name: &'static str, p: fn(&M, &M::State) -> bool, q: fn(&M, &M::State) -> bool },
    /// <>Q from the initial states under weak fairness of every fairness class (engine follow-up of the mc-engine
    /// review, additive to the pinned API): violated iff some behavior from an initial state never satisfies Q,
    /// i.e. a ~Q path from a ~Q initial state reaches a weakly fair ~Q cycle (stuttering included).
    Eventually { name: &'static str, q: fn(&M, &M::State) -> bool },
}

// ---------------------------------------------------------------------------------------------------------------

impl<M: Model> Clone for Property<M> {
    fn clone(&self) -> Self {
        match self {
            Property::Invariant { name, holds } => Property::Invariant { name, holds: *holds },
            Property::Action { name, holds } => Property::Action { name, holds: *holds },
            Property::LeadsTo { name, p, q } => Property::LeadsTo { name, p: *p, q: *q },
            Property::Eventually { name, q } => Property::Eventually { name, q: *q },
        }
    }
}

impl<M: Model> Property<M> {
    pub fn name(&self) -> &'static str {
        match self {
            Property::Invariant { name, .. }
            | Property::Action { name, .. }
            | Property::LeadsTo { name, .. }
            | Property::Eventually { name, .. } => name,
        }
    }
    pub fn kind(&self) -> Kind {
        match self {
            Property::Invariant { .. } => Kind::Invariant,
            Property::Action { .. } => Kind::Action,
            Property::LeadsTo { .. } => Kind::LeadsTo,
            Property::Eventually { .. } => Kind::Eventually,
        }
    }
}

/// Name of the pseudo-property reported when deadlock checking is on.
pub const DEADLOCK: &str = "Deadlock";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    Invariant,
    Action,
    LeadsTo,
    Deadlock,
    Eventually,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Invariant => "invariant",
            Kind::Action => "action",
            Kind::LeadsTo => "leadsto",
            Kind::Deadlock => "deadlock",
            Kind::Eventually => "eventually",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Verdict {
    /// Exhaustive search finished without a violation.
    Holds,
    /// A counterexample was found (it is in [`PropResult::trace`]).
    Violated,
    /// Simulation sampled the requested traces without a violation (not a proof).
    HoldsSim,
    /// A limit (`max_states`, `timeout`) stopped the run before a verdict.
    Timeout,
    /// The property could not be checked (unknown name, model panic, replay failure, ...).
    Error,
}

impl Verdict {
    pub fn as_str(self) -> &'static str {
        match self {
            Verdict::Holds => "HOLDS",
            Verdict::Violated => "VIOLATED",
            Verdict::HoldsSim => "HOLDS-SIM",
            Verdict::Timeout => "TIMEOUT",
            Verdict::Error => "ERROR",
        }
    }
}

impl fmt::Display for Verdict {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SimOptions {
    /// Number of random walks.
    pub traces: u64,
    /// Maximum number of steps per walk.
    pub depth: u32,
    /// PRNG seed; the run is reproducible from it (for any worker count).
    pub seed: u64,
}

impl Default for SimOptions {
    fn default() -> Self {
        SimOptions { traces: 1000, depth: 100, seed: 0 }
    }
}

#[derive(Clone, Debug)]
pub struct Options {
    /// Worker threads (at least 1). Results do not depend on it.
    pub workers: usize,
    /// Report states without successors (that are not `terminal`) as a violation of [`DEADLOCK`].
    pub deadlock: bool,
    /// Selected property names; empty = all properties of the model. `Deadlock` selects deadlock checking.
    pub props: Vec<String>,
    /// Stop with TIMEOUT once more distinct states than this were found (simulation: states sampled).
    pub max_states: Option<u64>,
    /// Stop with TIMEOUT after this wall time.
    pub timeout: Option<Duration>,
    /// Random simulation instead of exhaustive search.
    pub simulate: Option<SimOptions>,
}

impl Default for Options {
    fn default() -> Self {
        Options { workers: 1, deadlock: false, props: Vec::new(), max_states: None, timeout: None, simulate: None }
    }
}

/// One state of a trace with the action that led to it (`None` for the initial state).
pub struct Step<M: Model> {
    pub action: Option<M::Action>,
    pub state: M::State,
}

impl<M: Model> Clone for Step<M> {
    fn clone(&self) -> Self {
        Step { action: self.action.clone(), state: self.state.clone() }
    }
}

impl<M: Model> Debug for Step<M> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Step").field("action", &self.action).field("state", &self.state).finish()
    }
}

/// A counterexample. `steps[0]` is an initial state; every later step is a successor of the previous one.
///
/// For a LeadsTo violation the trace is a lasso: `loop_start = Some(i)`. If `stutter` is false the last state is
/// (up to `canonical`) the state `steps[i]`, so `steps[i..]` repeats forever; if `stutter` is true the behavior
/// stutters forever at the last state (`i` is then the last index).
pub struct Trace<M: Model> {
    pub steps: Vec<Step<M>>,
    pub loop_start: Option<usize>,
    pub stutter: bool,
}

impl<M: Model> Clone for Trace<M> {
    fn clone(&self) -> Self {
        Trace { steps: self.steps.clone(), loop_start: self.loop_start, stutter: self.stutter }
    }
}

impl<M: Model> Debug for Trace<M> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("Trace")
            .field("steps", &self.steps)
            .field("loop_start", &self.loop_start)
            .field("stutter", &self.stutter)
            .finish()
    }
}

impl<M: Model> Trace<M> {
    /// Number of states in the trace.
    pub fn len(&self) -> usize {
        self.steps.len()
    }
    pub fn is_empty(&self) -> bool {
        self.steps.is_empty()
    }
    pub fn last_state(&self) -> &M::State {
        &self.steps.last().expect("empty trace").state
    }
    pub fn states(&self) -> impl Iterator<Item = &M::State> {
        self.steps.iter().map(|s| &s.state)
    }
    pub fn to_dyn(&self) -> DynTrace {
        DynTrace {
            steps: self.steps.iter().map(|s| (s.action.as_ref().map(|a| format!("{a:?}")), format!("{:#?}", s.state))).collect(),
            loop_start: self.loop_start,
            stutter: self.stutter,
        }
    }
    /// Human-readable rendering (TLC style: `State n: <action>` followed by the state's `{:#?}`).
    pub fn render(&self) -> String {
        self.to_dyn().render()
    }
}

pub struct PropResult<M: Model> {
    pub name: String,
    pub kind: Kind,
    pub verdict: Verdict,
    pub trace: Option<Trace<M>>,
    /// Explanation for ERROR/TIMEOUT.
    pub message: Option<String>,
}

#[derive(Clone, Debug, Default)]
pub struct Stats {
    /// Distinct states (canonical forms) found; 0 in simulation.
    pub distinct: u64,
    /// States generated: initial states plus every successor (simulation: states visited).
    pub generated: u64,
    /// Exhaustive: largest BFS level reached (the diameter when complete; TLC prints this + 1 as "depth").
    /// Simulation: longest walk in steps.
    pub depth: u32,
    pub elapsed: Duration,
    /// Estimated probability that two distinct states shared a 128-bit fingerprint: distinct * generated / 2^128.
    pub collision: f64,
    pub workers: usize,
    pub simulated: bool,
    /// Exhaustive: every reachable state was explored. Simulation: every requested walk ran.
    pub complete: bool,
    /// The limit that stopped the run, if any ("max-states" or "timeout").
    pub limit: Option<String>,
    /// Simulation: walks run.
    pub traces: u64,
    /// Exhaustive: number of new distinct states per BFS level (`levels[0]` = initial states). The last entry
    /// may be a level that was generated but not expanded (the run stopped at a level boundary).
    pub levels: Vec<u64>,
}

pub struct Report<M: Model> {
    pub results: Vec<PropResult<M>>,
    pub stats: Stats,
}

impl<M: Model> Report<M> {
    pub fn get(&self, name: &str) -> Option<&PropResult<M>> {
        self.results.iter().find(|r| r.name == name)
    }
    /// Verdict of `name`; panics when the property is not in the report.
    pub fn verdict(&self, name: &str) -> Verdict {
        self.get(name).unwrap_or_else(|| panic!("no result for {name}")).verdict
    }
    /// Counterexample of `name`; panics when there is none.
    pub fn trace(&self, name: &str) -> &Trace<M> {
        self.get(name).and_then(|r| r.trace.as_ref()).unwrap_or_else(|| panic!("no trace for {name}"))
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Internals shared by the exhaustive and simulation engines.

/// 128-bit fingerprint: two independently salted std SipHash hashers.
pub(crate) type Fp = [u64; 2];

pub(crate) fn fingerprint<S: Hash + ?Sized>(s: &S) -> Fp {
    let mut a = DefaultHasher::new();
    a.write_u64(0x9E37_79B9_7F4A_7C15);
    s.hash(&mut a);
    let mut b = DefaultHasher::new();
    b.write_u64(0xC2B2_AE3D_27D4_EB4F);
    b.write_u64(0x1656_67B1_9E37_79F9);
    s.hash(&mut b);
    [a.finish(), b.finish()]
}

pub(crate) type InvFn<M> = fn(&M, &<M as Model>::State) -> bool;
pub(crate) type ActFn<M> = fn(&M, &<M as Model>::State, &<M as Model>::Action, &<M as Model>::State) -> bool;

/// The selected properties, each with its result slot.
pub(crate) struct Sel<M: Model> {
    pub(crate) invs: Vec<(usize, InvFn<M>)>,
    pub(crate) acts: Vec<(usize, ActFn<M>)>,
    /// LeadsTo and Eventually: (slot, P, Q); P = None means "is an initial state" (Eventually = Init ~> Q where
    /// only the initial occurrences count).
    pub(crate) leads: Vec<(usize, Option<InvFn<M>>, InvFn<M>)>,
    pub(crate) deadlock: Option<usize>,
}

impl<M: Model> Sel<M> {
    /// Slots of the safety checks (invariants, actions, deadlock).
    pub(crate) fn safety_slots(&self) -> Vec<usize> {
        let mut v: Vec<usize> = self.invs.iter().map(|x| x.0).chain(self.acts.iter().map(|x| x.0)).collect();
        v.extend(self.deadlock);
        v
    }
    pub(crate) fn all_slots(&self) -> Vec<usize> {
        let mut v = self.safety_slots();
        v.extend(self.leads.iter().map(|x| x.0));
        v
    }
}

pub(crate) enum Outcome<M: Model> {
    Holds,
    Violated(Trace<M>),
    Unknown,
    Error(String),
}

/// Check `model` with `opts`. Never panics because of the model: a panic becomes ERROR results.
pub fn check<M: Model>(model: &M, opts: &Options) -> Report<M> {
    let start = Instant::now();
    let all = model.properties();
    let mut results: Vec<PropResult<M>> = Vec::new();
    let mut sel = Sel { invs: Vec::new(), acts: Vec::new(), leads: Vec::new(), deadlock: None };
    let mut wanted: Vec<String> =
        if opts.props.is_empty() { all.iter().map(|p| p.name().to_string()).collect() } else { opts.props.clone() };
    if opts.deadlock && !wanted.iter().any(|w| w == DEADLOCK) {
        wanted.push(DEADLOCK.to_string());
    }
    for w in wanted {
        if results.iter().any(|r| r.name == w) {
            continue;
        }
        let slot = results.len();
        let matches: Vec<&Property<M>> = all.iter().filter(|p| p.name() == w).collect();
        let mut res = PropResult { name: w.clone(), kind: Kind::Invariant, verdict: Verdict::Holds, trace: None, message: None };
        match matches.len() {
            0 if w == DEADLOCK => {
                res.kind = Kind::Deadlock;
                sel.deadlock = Some(slot);
            }
            0 => {
                res.verdict = Verdict::Error;
                res.message = Some(format!("unknown property {w}"));
            }
            1 if w == DEADLOCK && (opts.deadlock) => {
                res.kind = matches[0].kind();
                res.verdict = Verdict::Error;
                res.message = Some(format!("the model defines a property named {DEADLOCK}; it clashes with --deadlock"));
            }
            1 => {
                res.kind = matches[0].kind();
                match matches[0] {
                    Property::Invariant { holds, .. } => sel.invs.push((slot, *holds)),
                    Property::Action { holds, .. } => sel.acts.push((slot, *holds)),
                    Property::LeadsTo { p, q, .. } => sel.leads.push((slot, Some(*p), *q)),
                    Property::Eventually { q, .. } => sel.leads.push((slot, None, *q)),
                }
            }
            _ => {
                res.kind = matches[0].kind();
                res.verdict = Verdict::Error;
                res.message = Some(format!("the model defines {} properties named {w}", matches.len()));
            }
        }
        results.push(res);
    }
    if sel.leads.len() > live::MAX_LEADS {
        for (slot, _, _) in sel.leads.drain(..) {
            results[slot].verdict = Verdict::Error;
            results[slot].message = Some(format!("at most {} LeadsTo/Eventually properties per run", live::MAX_LEADS));
        }
    }
    let nslots = results.len();
    let run = catch_unwind(AssertUnwindSafe(|| match &opts.simulate {
        Some(sim) => sim::run(model, &sel, nslots, opts, sim, start),
        None => bfs::run(model, &sel, nslots, opts, start),
    }));
    let (outs, mut stats) = match run {
        Ok(r) => r,
        Err(p) => {
            let msg = panic_message(&p);
            let outs = (0..nslots).map(|_| Outcome::Error(format!("model or engine panicked: {msg}"))).collect();
            (outs, Stats { workers: opts.workers.max(1), simulated: opts.simulate.is_some(), ..Stats::default() })
        }
    };
    for slot in sel.all_slots() {
        let r = &mut results[slot];
        match &outs[slot] {
            Outcome::Holds => r.verdict = if opts.simulate.is_some() { Verdict::HoldsSim } else { Verdict::Holds },
            Outcome::Violated(t) => {
                r.verdict = Verdict::Violated;
                r.trace = Some(t.clone());
            }
            Outcome::Unknown => {
                r.verdict = Verdict::Timeout;
                r.message = Some(format!("stopped by {}", stats.limit.as_deref().unwrap_or("a limit")));
            }
            Outcome::Error(e) => {
                r.verdict = Verdict::Error;
                r.message = Some(e.clone());
            }
        }
    }
    stats.elapsed = start.elapsed();
    stats.collision = stats.distinct as f64 * stats.generated as f64 / 2f64.powi(128);
    Report { results, stats }
}

pub(crate) fn panic_message(p: &Box<dyn std::any::Any + Send>) -> String {
    if let Some(s) = p.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = p.downcast_ref::<String>() {
        s.clone()
    } else {
        "unknown panic".to_string()
    }
}

/// `owedmc <crate version> (git <describe>, src sha256 <hex>)`, recorded at build time by `build.rs`: `git describe
/// --always --dirty --tags` of the checkout the engine was built from ("unknown" without git) and the SHA-256 of
/// the engine sources `formal/mc/src/*.rs` (file names and contents in name order; see `build.rs`).
pub fn engine_version() -> String {
    format!(
        "owedmc {} (git {}, src sha256 {})",
        env!("CARGO_PKG_VERSION"),
        env!("OWEDMC_BUILD_GIT"),
        env!("OWEDMC_BUILD_SRC_SHA256")
    )
}

/// SHA-256 of the engine sources as computed by `build.rs` (also part of [`engine_version`]).
pub fn engine_source_sha256() -> &'static str {
    env!("OWEDMC_BUILD_SRC_SHA256")
}

impl DynTrace {
    pub fn render(&self) -> String {
        let mut s = String::new();
        for (i, (a, st)) in self.steps.iter().enumerate() {
            let label = match a {
                None => "<Initial>".to_string(),
                Some(a) => format!("<{a}>"),
            };
            let _ = writeln!(s, "State {}: {}", i + 1, label);
            let _ = writeln!(s, "{st}");
        }
        if let Some(l) = self.loop_start {
            if self.stutter {
                let _ = writeln!(s, "-- stuttering forever at state {} --", l + 1);
            } else {
                let _ = writeln!(s, "-- back to state {} (loop) --", l + 1);
            }
        }
        s
    }
}
