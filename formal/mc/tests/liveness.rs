//! LeadsTo under weak fairness (TLA+ semantics: behaviors may stutter).

mod common;
use common::*;
use mc::{Model, Trace, Verdict, check};
use std::collections::BTreeSet;

fn enabled_classes(m: &Live, s: &LS) -> BTreeSet<&'static str> {
    let mut out = Vec::new();
    m.next(s, &mut out);
    out.iter().filter(|(_, t)| t != s).filter_map(|(a, _)| m.fairness(a)).collect()
}

/// Independent check of a lasso: valid steps; a P /\ ~Q state on the stem; ~Q from there on; the loop closes;
/// the loop is weakly fair (every class enabled in all loop states is taken in the loop; stutter: none enabled).
fn assert_fair_lasso(m: &Live, t: &Trace<Live>) {
    assert_valid_trace(m, t);
    let ls = t.loop_start.expect("lasso");
    let states: Vec<&LS> = t.states().collect();
    let p_at = (0..=ls).find(|&i| !states[i].done).expect("a P state before the loop");
    assert!(states[p_at..].iter().all(|s| !s.done), "Q held after P on the counterexample");
    if t.stutter {
        assert_eq!(ls, t.len() - 1);
        assert!(enabled_classes(m, t.last_state()).is_empty(), "stuttering where a fair class is enabled");
    } else {
        assert!(t.len() - 1 > ls, "empty loop without stutter");
        assert_eq!(t.last_state(), states[ls], "loop does not close");
        let loop_states = &states[ls..t.len() - 1];
        let taken: BTreeSet<&'static str> =
            t.steps[ls + 1..].iter().filter_map(|s| m.fairness(s.action.as_ref().unwrap())).collect();
        let mut always: Option<BTreeSet<&'static str>> = None;
        for s in loop_states {
            let e = enabled_classes(m, s);
            always = Some(match always {
                None => e,
                Some(a) => a.intersection(&e).copied().collect(),
            });
        }
        for c in always.unwrap() {
            assert!(taken.contains(c), "class {c} enabled throughout the loop but never taken");
        }
    }
}

/// Without fairness the system may stutter (or toggle) forever: EventuallyDone fails. With WF(Finish) it holds.
#[test]
fn leadsto_fails_without_fairness_and_holds_with_wf() {
    let unfair = Live { fair_toggle: false, fair_finish: false, finish_needs_on: false };
    let r = check(&unfair, &opts(2));
    assert_eq!(r.verdict("EventuallyDone"), Verdict::Violated);
    assert_eq!(r.verdict("Vacuous"), Verdict::Holds);
    assert_fair_lasso(&unfair, r.trace("EventuallyDone"));

    let fair = Live { fair_toggle: false, fair_finish: true, finish_needs_on: false };
    let r = check(&fair, &opts(2));
    assert_eq!(r.verdict("EventuallyDone"), Verdict::Holds);
    assert_eq!(r.stats.distinct, 4);
}

/// Weak (not strong) fairness: Finish is enabled only while the switch is on, so a behavior that keeps
/// toggling never has Finish continuously enabled; with Toggle fair it is a genuine 2-step loop.
#[test]
fn weak_fairness_is_not_strong_fairness() {
    let m = Live { fair_toggle: true, fair_finish: true, finish_needs_on: true };
    let r = check(&m, &opts(2));
    assert_eq!(r.verdict("EventuallyDone"), Verdict::Violated);
    let t = r.trace("EventuallyDone");
    assert!(!t.stutter);
    assert_eq!(t.loop_start, Some(0));
    assert_eq!(t.len(), 3);
    assert_fair_lasso(&m, t);

    // Toggle unfair: stuttering while off is fair (Finish disabled there), so the lasso is a stutter.
    let m2 = Live { fair_toggle: false, fair_finish: true, finish_needs_on: true };
    let r2 = check(&m2, &opts(2));
    assert_eq!(r2.verdict("EventuallyDone"), Verdict::Violated);
    assert!(r2.trace("EventuallyDone").stutter);
    assert_fair_lasso(&m2, r2.trace("EventuallyDone"));

    // Both fair and Finish always enabled: holds.
    let m3 = Live { fair_toggle: true, fair_finish: true, finish_needs_on: false };
    assert_eq!(check(&m3, &opts(2)).verdict("EventuallyDone"), Verdict::Holds);
}

/// Simulation reports a LeadsTo violation only when it is sound (stuttering where no fair class is enabled).
#[test]
fn simulation_liveness_is_sound() {
    let sim = mc::SimOptions { traces: 50, depth: 10, seed: 7 };
    let unfair = Live { fair_toggle: false, fair_finish: false, finish_needs_on: false };
    let r = check(&unfair, &mc::Options { simulate: Some(sim.clone()), ..opts(2) });
    assert_eq!(r.verdict("EventuallyDone"), Verdict::Violated);
    assert_fair_lasso(&unfair, r.trace("EventuallyDone"));
    let fair = Live { fair_toggle: true, fair_finish: true, finish_needs_on: false };
    let r = check(&fair, &mc::Options { simulate: Some(sim), ..opts(2) });
    assert_eq!(r.verdict("EventuallyDone"), Verdict::HoldsSim);
}

/// The toy-counters liveness property on a bigger graph: c0 = N-1 ~> c0 = 0 holds with WF on every counter and
/// fails without fairness; also exercises the graph with self-free cycles in other counters.
#[test]
fn leadsto_on_counter_graph() {
    struct Wrap {
        n: u32,
        fair: bool,
    }
    impl Model for Wrap {
        type State = (u32, u32);
        type Action = u8;
        fn init(&self) -> Vec<(u32, u32)> {
            vec![(0, 0)]
        }
        fn next(&self, s: &(u32, u32), out: &mut Vec<(u8, (u32, u32))>) {
            out.push((0, ((s.0 + 1) % self.n, s.1)));
            out.push((1, (s.0, (s.1 + 1) % self.n)));
        }
        fn properties(&self) -> Vec<mc::Property<Self>> {
            vec![mc::Property::LeadsTo {
                name: "Wraps",
                p: |m: &Wrap, s: &(u32, u32)| s.0 == m.n - 1,
                q: |_m: &Wrap, s: &(u32, u32)| s.0 == 0,
            }]
        }
        fn fairness(&self, a: &u8) -> Option<&'static str> {
            if !self.fair {
                None
            } else if *a == 0 {
                Some("x")
            } else {
                Some("y")
            }
        }
    }
    let r = check(&Wrap { n: 12, fair: true }, &opts(4));
    assert_eq!(r.verdict("Wraps"), Verdict::Holds);
    assert_eq!(r.stats.distinct, 144);
    let r = check(&Wrap { n: 12, fair: false }, &opts(4));
    assert_eq!(r.verdict("Wraps"), Verdict::Violated);
    let t = r.trace("Wraps");
    // Shortest stem: 11 increments of x reach the first P state, where stuttering is fair.
    assert_eq!(t.len(), 12);
    assert!(t.stutter);
    assert_eq!(t.last_state().0, 11);
}
