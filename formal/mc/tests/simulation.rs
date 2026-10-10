//! Random simulation.

mod common;
use common::*;
use mc::{Options, SimOptions, Verdict, check};

fn sim(traces: u64, depth: u32, seed: u64, workers: usize) -> Options {
    Options { workers, simulate: Some(SimOptions { traces, depth, seed }), ..Options::default() }
}

/// With a fixed seed the broken mutex is found (a valid trace ending with both in the critical section, never
/// shorter than the exhaustive minimum of 5 states); Peterson gives HOLDS-SIM, never HOLDS.
#[test]
fn simulation_finds_broken_mutex_and_reports_holds_sim() {
    let broken = Mutex2 { broken: true };
    let r = check(&broken, &sim(200, 20, 1, 4));
    assert_eq!(r.verdict("MutualExclusion"), Verdict::Violated);
    let t = r.trace("MutualExclusion");
    assert!(both_critical(t.last_state()));
    assert!(t.len() >= 5);
    assert_valid_trace(&broken, t);
    assert!(r.stats.simulated);

    let peterson = Mutex2 { broken: false };
    let r = check(&peterson, &sim(500, 40, 1, 4));
    assert_eq!(r.verdict("MutualExclusion"), Verdict::HoldsSim);
    assert_eq!(r.stats.traces, 500);
    assert!(r.stats.complete);
    // Peterson never deadlocks, so every walk runs the full 40 steps.
    assert_eq!(r.stats.generated, 500 * 41);
}

/// Same seed: same trace; the trace is reproducible by seed (and independent of the worker count).
#[test]
fn simulation_reproducible_by_seed() {
    let m = Mutex2 { broken: true };
    let a = check(&m, &sim(100, 20, 99, 1));
    let b = check(&m, &sim(100, 20, 99, 6));
    assert_eq!(a.trace("MutualExclusion").render(), b.trace("MutualExclusion").render());
    assert_eq!(a.stats.generated, b.stats.generated);
}

/// Deadlocks and action properties are detected in simulation too; walks stop at deadlocks.
#[test]
fn simulation_deadlock_and_action_properties() {
    let d = Dining { terminal_deadlock: false };
    let r = check(&d, &Options { deadlock: true, ..sim(200, 50, 3, 2) });
    assert_eq!(r.verdict(mc::DEADLOCK), Verdict::Violated);
    assert_eq!(r.trace(mc::DEADLOCK).last_state().pc, [1, 1, 1]);
    let c = Counters::new(4);
    let r = check(&c, &Options { props: vec!["NeverWrapX".into()], ..sim(50, 30, 5, 2) });
    assert_eq!(r.verdict("NeverWrapX"), Verdict::Violated);
    let t = r.trace("NeverWrapX");
    assert_valid_trace(&c, t);
    assert_eq!(t.last_state().x, 0);
    assert_eq!(t.steps[t.len() - 2].state.x, 3);
}
