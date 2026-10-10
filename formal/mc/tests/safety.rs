//! Exhaustive safety checking: state counts, invariants, action properties, deadlock, shortest traces.

mod common;
use common::*;
use mc::{Kind, Verdict, check};

/// Two counters mod N: N*N distinct states, 2 successors each (+1 initial generated), diameter 2(N-1).
#[test]
fn counters_mod_n_have_n_squared_states() {
    // N = 1: one state whose two successors are itself (self-loops are generated but not new).
    let one = check(&Counters::new(1), &props(1, &["InRange"]));
    assert_eq!((one.stats.distinct, one.stats.generated, one.stats.depth), (1, 3, 0));
    for n in [2u32, 7, 31] {
        let m = Counters::new(n);
        let r = check(&m, &opts(2));
        let n64 = n as u64;
        assert_eq!(r.stats.distinct, n64 * n64, "N={n}");
        assert_eq!(r.stats.generated, 1 + 2 * n64 * n64, "N={n}");
        assert_eq!(r.stats.depth, 2 * (n - 1), "N={n}");
        assert!(r.stats.complete);
        for name in ["InRange", "StepByOne"] {
            assert_eq!(r.verdict(name), Verdict::Holds, "N={n} {name}");
        }
        // x wraps from N-1 to 0 in every model with N >= 2.
        assert_eq!(r.verdict("NeverWrapX"), Verdict::Violated);
        assert_eq!(r.stats.distinct as usize, naive_reachable(&m).len());
    }
}

/// A target (a, b) is reached after exactly a + b increments; the trace is a shortest path to it.
#[test]
fn invariant_violation_has_shortest_trace() {
    let m = Counters { n: 9, target: Some((5, 3)), sum_limit: u32::MAX };
    let r = check(&m, &props(3, &["NotTarget", "InRange"]));
    assert_eq!(r.verdict("NotTarget"), Verdict::Violated);
    assert_eq!(r.verdict("InRange"), Verdict::Holds);
    let t = r.trace("NotTarget");
    assert_eq!(t.len(), 5 + 3 + 1);
    assert_eq!(*t.last_state(), C2 { x: 5, y: 3 });
    assert_valid_trace(&m, t);
    // Only the last state violates: a shortest counterexample.
    assert!(t.steps[..t.len() - 1].iter().all(|s| s.state != C2 { x: 5, y: 3 }));
    assert!(r.get("NotTarget").unwrap().kind == Kind::Invariant);
}

/// An invariant violated by the initial state yields a one-state trace.
#[test]
fn invariant_violated_in_initial_state() {
    let m = Counters { n: 4, target: Some((0, 0)), sum_limit: u32::MAX };
    let r = check(&m, &props(1, &["NotTarget"]));
    assert_eq!(r.verdict("NotTarget"), Verdict::Violated);
    assert_eq!(r.trace("NotTarget").len(), 1);
}

/// Action property: x wraps from N-1 to 0 after N increments of x, so the trace has N+1 states and ends with
/// the wrapping IncX step.
#[test]
fn action_property_violation_ends_with_the_bad_step() {
    let n = 6;
    let m = Counters::new(n);
    let r = check(&m, &props(4, &["NeverWrapX", "StepByOne"]));
    assert_eq!(r.verdict("NeverWrapX"), Verdict::Violated);
    assert_eq!(r.verdict("StepByOne"), Verdict::Holds);
    let t = r.trace("NeverWrapX");
    assert_eq!(t.len(), n as usize + 1);
    assert_valid_trace(&m, t);
    let last = &t.steps[t.len() - 1];
    assert_eq!(last.action, Some(CA::IncX));
    assert_eq!(last.state.x, 0);
    assert_eq!(t.steps[t.len() - 2].state.x, n - 1);
    assert_eq!(r.get("NeverWrapX").unwrap().kind, Kind::Action);
}

/// Peterson's algorithm keeps mutual exclusion; the count equals an independent naive BFS.
#[test]
fn peterson_holds() {
    let m = Mutex2 { broken: false };
    let r = check(&m, &opts(4));
    assert_eq!(r.verdict("MutualExclusion"), Verdict::Holds);
    let naive = naive_reachable(&m);
    assert_eq!(r.stats.distinct as usize, naive.len());
    assert!(naive.iter().all(|s| !both_critical(s)));
    assert_eq!(naive_distance(&m, both_critical), None);
}

/// The check-then-set mutex is broken; each process needs two steps to enter, so the shortest violation has
/// 4 steps (5 states), confirmed by naive BFS.
#[test]
fn broken_mutex_violates_with_shortest_trace() {
    let m = Mutex2 { broken: true };
    let r = check(&m, &opts(4));
    assert_eq!(r.verdict("MutualExclusion"), Verdict::Violated);
    let t = r.trace("MutualExclusion");
    assert_eq!(naive_distance(&m, both_critical), Some(4));
    assert_eq!(t.len(), 5);
    assert!(both_critical(t.last_state()));
    assert_valid_trace(&m, t);
    // Exploration stops after the violating level, so not every state need be counted, but the trace is minimal.
    assert!(t.steps[..4].iter().all(|s| !both_critical(&s.state)));
}

/// Dining philosophers (3): with --deadlock the all-hold-left state is found after 3 steps; without it no
/// deadlock is reported and the invariant holds; a `terminal` state is not a deadlock.
#[test]
fn dining_philosophers_deadlock_only_when_checked() {
    let m = Dining { terminal_deadlock: false };
    let on = check(&m, &mc::Options { deadlock: true, workers: 3, ..mc::Options::default() });
    assert_eq!(on.verdict(mc::DEADLOCK), Verdict::Violated);
    assert_eq!(on.get(mc::DEADLOCK).unwrap().kind, Kind::Deadlock);
    let t = on.trace(mc::DEADLOCK);
    assert_eq!(t.len(), 4);
    assert_eq!(t.last_state().pc, [1, 1, 1]);
    assert_valid_trace(&m, t);
    let mut out = Vec::new();
    mc::Model::next(&m, t.last_state(), &mut out);
    assert!(out.is_empty());
    assert_eq!(on.verdict("ForksHeldByNeighbours"), Verdict::Holds);

    let off = check(&m, &opts(3));
    assert!(off.get(mc::DEADLOCK).is_none());
    assert_eq!(off.results.len(), 1);
    assert_eq!(off.verdict("ForksHeldByNeighbours"), Verdict::Holds);
    assert_eq!(off.stats.distinct as usize, naive_reachable(&m).len());

    let term = check(&Dining { terminal_deadlock: true }, &mc::Options { deadlock: true, workers: 3, ..mc::Options::default() });
    assert_eq!(term.verdict(mc::DEADLOCK), Verdict::Holds);
    // Selecting the pseudo-property by name is the same as --deadlock.
    let by_name = check(&m, &props(2, &[mc::DEADLOCK]));
    assert_eq!(by_name.verdict(mc::DEADLOCK), Verdict::Violated);
    assert_eq!(by_name.results.len(), 1);
}

/// Unknown property names are ERROR results; the others are still checked.
#[test]
fn unknown_property_is_an_error_result() {
    let m = Counters::new(3);
    let r = check(&m, &props(1, &["Nope", "InRange"]));
    assert_eq!(r.verdict("Nope"), Verdict::Error);
    assert!(r.get("Nope").unwrap().message.as_deref().unwrap().contains("unknown property"));
    assert_eq!(r.verdict("InRange"), Verdict::Holds);
}

/// A model that panics yields ERROR results, not a crash.
#[test]
fn model_panic_is_an_error_result() {
    struct Bad;
    impl mc::Model for Bad {
        type State = u8;
        type Action = ();
        fn init(&self) -> Vec<u8> {
            vec![0]
        }
        fn next(&self, s: &u8, out: &mut Vec<((), u8)>) {
            if *s == 3 {
                panic!("boom at 3");
            }
            out.push(((), s + 1));
        }
        fn properties(&self) -> Vec<mc::Property<Self>> {
            vec![mc::Property::Invariant { name: "True", holds: |_m: &Bad, _s: &u8| true }]
        }
    }
    let r = check(&Bad, &opts(2));
    assert_eq!(r.verdict("True"), Verdict::Error);
    assert!(r.get("True").unwrap().message.as_deref().unwrap().contains("boom at 3"));
}
