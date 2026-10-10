//! Compare the ports with the recorded TLC runs (formal/reference/a3/tlc-runs.tsv, made by extract.py from the
//! copied logs). Used by tests/a3.rs (fast rows) and examples/a3_compare.rs (every row, on ipc).
//!
//! Acceptance per exhaustive row (REPORT-mc-port.md):
//! - TLC HOLDS: owedmc HOLDS (deadlock checked) with the same distinct states and depth (TLC prints the
//!   diameter + 1); TLC's "states generated" equals the engine's transitions weighted by the model's
//!   `tlc_branches` (TLC generates a transition once per true disjunct on its path).
//! - TLC VIOLATED: owedmc VIOLATED with no deadlock; its (shortest) trace is not longer than TLC's. The engine stops
//!   at level boundaries, so its count differs from TLC's by construction; the TLC-order search (`tlc::tlc_order`)
//!   must reproduce the violation with the engine's trace length, and for one-worker TLC runs exactly TLC's
//!   distinct-state count and trace length. Multi-worker TLC counts and traces depend on the schedule; they are
//!   reported with the per-level bounds.
//! - Liveness (PROPERTY GoodProgress/Finished/GoodEventuallyMerges): the verdict, and the distinct count of the
//!   whole graph, which TLC builds completely before checking liveness.

use super::auth::Auth;
use super::merge::Merge;
use super::tlc::{TlcRun, tlc_order};
use mc::{Model, Options, SimOptions, Verdict, check};

pub const TSV: &str = include_str!("../../../reference/a3/tlc-runs.tsv");

#[derive(Clone, Debug)]
pub struct Row {
    pub log: String,
    pub module: String,
    pub sha8: String,
    pub mode: String,
    pub consts: Vec<(String, String)>,
    pub prop: String,
    pub kind: String,
    pub search: String,
    pub workers: usize,
    pub result: String,
    pub distinct: Option<u64>,
    pub generated: Option<u64>,
    pub depth: Option<u32>,
    pub trace_states: usize,
    pub sim_traces: Option<u64>,
    pub sim_num: Option<u64>,
    pub sim_depth: Option<u32>,
    pub class: String,
}

impl Row {
    pub fn konst(&self, k: &str) -> Option<&str> {
        self.consts.iter().find(|(a, _)| a == k).map(|(_, v)| v.as_str())
    }
    pub fn is_auth(&self) -> bool {
        self.module == "PiDagAuth3"
    }
    pub fn scope(&self) -> &str {
        self.konst("Scope").unwrap_or("scenarios")
    }
    pub fn max_log(&self) -> usize {
        self.konst("MaxLog").map_or(5, |v| v.parse().unwrap())
    }
    /// Rows that are compared (the module text is the reference or provably equivalent on that scope).
    pub fn comparable(&self) -> bool {
        matches!(self.class.as_str(), "current" | "auth-v1" | "merge-preruling")
    }
    /// Exhaustive rows whose graph is too big for the unit tests (free authority logs of length >= 3).
    pub fn heavy(&self) -> bool {
        self.is_auth() && self.scope() == "free" && self.max_log() >= 3
    }
    /// A short label: module mode prop consts.
    pub fn label(&self) -> String {
        let cs: Vec<String> = self.consts.iter().map(|(k, v)| format!("{k}={v}")).collect();
        format!("{} {} {} {}", if self.is_auth() { "a3_auth" } else { "a3_merge" }, self.mode, self.prop, cs.join(","))
    }
    pub fn liveness(&self) -> bool {
        matches!(self.prop.as_str(), "GoodProgress" | "Finished" | "GoodEventuallyMerges")
    }
}

fn opt<T: std::str::FromStr>(s: &str) -> Option<T> {
    if s.is_empty() { None } else { s.parse().ok() }
}

/// All rows of the reference table.
pub fn reference() -> Vec<Row> {
    let mut lines = TSV.lines();
    let hdr: Vec<&str> = lines.next().expect("header").split('\t').collect();
    let col = |name: &str| hdr.iter().position(|h| *h == name).unwrap_or_else(|| panic!("column {name}"));
    let c = [
        "log", "module", "sha8", "mode", "consts", "prop", "kind", "search", "workers", "result", "distinct", "generated",
        "depth", "trace_states", "sim_traces", "sim_num", "sim_depth", "class",
    ]
    .map(col);
    lines
        .filter(|l| !l.is_empty())
        .map(|l| {
            let f: Vec<&str> = l.split('\t').collect();
            let consts = f[c[4]]
                .split(';')
                .filter(|x| !x.is_empty())
                .map(|kv| {
                    let (k, v) = kv.split_once('=').unwrap();
                    (k.to_string(), v.to_string())
                })
                .collect();
            Row {
                log: f[c[0]].into(),
                module: f[c[1]].into(),
                sha8: f[c[2]].into(),
                mode: f[c[3]].into(),
                consts,
                prop: f[c[5]].into(),
                kind: f[c[6]].into(),
                search: f[c[7]].into(),
                workers: opt(f[c[8]]).unwrap_or(1),
                result: f[c[9]].into(),
                distinct: opt(f[c[10]]),
                generated: opt(f[c[11]]),
                depth: opt(f[c[12]]),
                trace_states: opt(f[c[13]]).unwrap_or(0),
                sim_traces: opt(f[c[14]]),
                sim_num: opt(f[c[15]]),
                sim_depth: opt(f[c[16]]),
                class: f[c[17]].into(),
            }
        })
        .collect()
}

pub fn auth_of(row: &Row) -> Auth {
    Auth::new(&row.mode, row.scope() == "free", row.max_log()).expect("auth model")
}
pub fn merge_of(row: &Row) -> Merge {
    Merge::new(&row.mode, row.konst("Scenario").expect("Scenario")).expect("merge model")
}

#[derive(Clone, Debug, Default)]
pub struct Outcome {
    pub verdict: Option<Verdict>,
    pub deadlock: Option<Verdict>,
    pub distinct: u64,
    pub generated: u64,
    /// TLC-style depth: number of BFS levels (diameter + 1).
    pub depth: u32,
    pub trace_states: usize,
    pub levels: Vec<u64>,
    pub tlc: Option<TlcRun>,
    pub seconds: f64,
    /// Simulation: walks and states sampled.
    pub sim_traces: u64,
    /// Failed acceptance criteria (empty = OK).
    pub failures: Vec<String>,
    /// Remarks that are not failures (multi-worker counts, bounds).
    pub notes: Vec<String>,
}

impl Outcome {
    pub fn ok(&self) -> bool {
        self.failures.is_empty()
    }
}

/// Number of states in levels 0..=d.
fn upto(levels: &[u64], d: usize) -> u64 {
    levels.iter().take(d + 1).sum()
}

fn run_bfs<M: Model>(m: &M, row: &Row, workers: usize, branches: &dyn Fn(&M::State, &M::Action) -> u64) -> Outcome {
    let mut o = Outcome::default();
    // Deadlock is checked as in check.sh, except for the big free runs, where the explicit Terminal stutter at
    // Len(log) = MaxLog and the 210 always-enabled events make deadlock impossible by construction (and checking it
    // would force exploring the whole 1.9e9-state graph of MaxLog=4 instead of stopping after the violation).
    let deadlock = !row.heavy();
    let opts = Options { workers, deadlock, props: vec![row.prop.clone()], ..Options::default() };
    let r = check(m, &opts);
    o.seconds = r.stats.elapsed.as_secs_f64();
    o.verdict = Some(r.verdict(&row.prop));
    o.deadlock = r.get(mc::DEADLOCK).map(|p| p.verdict);
    o.distinct = r.stats.distinct;
    o.generated = r.stats.generated;
    o.depth = r.stats.levels.len() as u32;
    o.levels = r.stats.levels.clone();
    if let Some(p) = r.get(&row.prop)
        && let Some(t) = &p.trace
    {
        o.trace_states = t.len();
    }
    let ours = o.verdict.unwrap();
    if deadlock && o.deadlock != Some(Verdict::Holds) {
        o.failures.push(format!("deadlock check {:?}", o.deadlock));
    }
    match row.result.as_str() {
        "HOLDS" => {
            // TLC's "states generated" counts a transition once per TLC branch; the TLC-order search weighs the
            // engine's transitions with the model's `tlc_branches`, which must reproduce TLC's number.
            let t = tlc_order(m, &[], deadlock, branches);
            if Some(t.generated) != row.generated {
                o.failures.push(format!("TLC-weighted generated {} (TLC {:?})", t.generated, row.generated));
            }
            if t.distinct != o.distinct {
                o.failures.push(format!("TLC-order distinct {} vs engine {}", t.distinct, o.distinct));
            }
            o.tlc = Some(t);
            if ours != Verdict::Holds {
                o.failures.push(format!("verdict {ours} (TLC HOLDS)"));
            }
            if Some(o.distinct) != row.distinct {
                o.failures.push(format!("distinct {} (TLC {:?})", o.distinct, row.distinct));
            }
            if Some(o.depth) != row.depth {
                o.failures.push(format!("depth {} (TLC {:?})", o.depth, row.depth));
            }
        }
        "VIOLATED" => {
            if ours != Verdict::Violated {
                o.failures.push(format!("verdict {ours} (TLC VIOLATED)"));
            }
            if row.liveness() {
                if Some(o.distinct) != row.distinct {
                    o.failures.push(format!("distinct {} (TLC {:?}, full graph before liveness)", o.distinct, row.distinct));
                }
            } else {
                if o.trace_states > row.trace_states {
                    o.failures.push(format!("trace {} states, longer than TLC's {}", o.trace_states, row.trace_states));
                }
                {
                    let t = tlc_order(m, &[row.prop.as_str()], true, branches);
                    if t.violated.as_deref() != Some(row.prop.as_str()) {
                        o.failures.push(format!("TLC-order search: {:?}", t.violated));
                    }
                    if t.trace_states != o.trace_states {
                        o.failures.push(format!("TLC-order trace {} vs engine {}", t.trace_states, o.trace_states));
                    }
                    let tlc_d = row.distinct.unwrap_or(0);
                    if row.workers == 1 {
                        if t.distinct != tlc_d {
                            o.failures.push(format!("TLC-order distinct {} (TLC 1 worker {})", t.distinct, tlc_d));
                        }
                        if t.trace_states != row.trace_states {
                            o.failures.push(format!("TLC-order trace {} (TLC {})", t.trace_states, row.trace_states));
                        }
                        if Some(t.generated) != row.generated {
                            o.failures.push(format!("TLC-order generated {} (TLC 1 worker {:?})", t.generated, row.generated));
                        }
                    } else {
                        let d = o.trace_states.saturating_sub(1);
                        let dt = row.trace_states.saturating_sub(1);
                        o.notes.push(format!(
                            "TLC {} workers: {} distinct, trace {}; TLC-order {} distinct; levels <{}: {}, <={}: {}, <={} (TLC trace depth): {}",
                            row.workers,
                            tlc_d,
                            row.trace_states,
                            t.distinct,
                            d,
                            upto(&o.levels, d.saturating_sub(1)),
                            d,
                            upto(&o.levels, d),
                            dt,
                            upto(&o.levels, dt)
                        ));
                    }
                    o.tlc = Some(t);
                }
            }
        }
        _ => o.notes.push(format!("TLC {} (no final count); owedmc {ours}", row.result)),
    }
    o
}

/// Run an exhaustive row. `heavy_ok`: also run rows marked heavy.
pub fn compare_bfs(row: &Row, workers: usize, heavy_ok: bool) -> Option<Outcome> {
    if row.search != "bfs" || (row.heavy() && !heavy_ok) {
        return None;
    }
    // An unfinished TLC run of the free MaxLog=4 graph (about 1.9e9 states) has nothing to compare with; the
    // violated MaxLog=4 rows stop after a few thousand states and are run.
    if row.result == "INCOMPLETE" && row.max_log() >= 4 {
        return None;
    }
    Some(if row.is_auth() {
        let m = auth_of(row);
        run_bfs(&m, row, workers, &|s, a| m.tlc_branches(s, a))
    } else {
        let m = merge_of(row);
        run_bfs(&m, row, workers, &|s, a| m.tlc_branches(s, a))
    })
}

fn run_sim<M: Model>(m: &M, row: &Row, workers: usize, sim: SimOptions, timeout: Option<f64>) -> Outcome {
    let mut o = Outcome::default();
    let opts = Options {
        workers,
        deadlock: true,
        props: vec![row.prop.clone()],
        simulate: Some(sim),
        timeout: timeout.map(std::time::Duration::from_secs_f64),
        ..Options::default()
    };
    let r = check(m, &opts);
    o.seconds = r.stats.elapsed.as_secs_f64();
    o.verdict = Some(r.verdict(&row.prop));
    o.deadlock = r.get(mc::DEADLOCK).map(|p| p.verdict);
    o.generated = r.stats.generated;
    o.sim_traces = r.stats.traces;
    if let Some(p) = r.get(&row.prop)
        && let Some(t) = &p.trace
    {
        o.trace_states = t.len();
    }
    let ours = o.verdict.unwrap();
    // TLC stopped these runs (time limit) without a verdict; a timed-out walk set here is the same outcome.
    if row.result == "INCOMPLETE" && ours == Verdict::Timeout {
        o.notes.push(format!("TLC stopped without a verdict; owedmc TIMEOUT after {} walks without a violation", o.sim_traces));
        return o;
    }
    if o.deadlock != Some(Verdict::HoldsSim) {
        o.failures.push(format!("deadlock {:?}", o.deadlock));
    }
    match row.result.as_str() {
        "VIOLATED" if ours != Verdict::Violated => o.failures.push(format!("{ours}: TLC found a violation")),
        "HOLDS-SIM" | "INCOMPLETE" | "HOLDS" if ours != Verdict::HoldsSim => {
            o.failures.push(format!("{ours}: TLC found no violation"))
        }
        _ => {}
    }
    o
}

/// Simulate a row: `traces` walks (default: TLC's num per worker times its workers) of TLC's depth, bounded by
/// `timeout` seconds.
pub fn compare_sim(row: &Row, workers: usize, traces: Option<u64>, seed: u64, timeout: Option<f64>) -> Option<Outcome> {
    if row.search != "sim" {
        return None;
    }
    let n = traces.unwrap_or(row.sim_num.unwrap_or(1000) * row.workers as u64);
    let sim = SimOptions { traces: n, depth: row.sim_depth.unwrap_or(20), seed };
    Some(if row.is_auth() { run_sim(&auth_of(row), row, workers, sim, timeout) } else { run_sim(&merge_of(row), row, workers, sim, timeout) })
}
