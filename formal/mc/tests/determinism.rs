//! Identical counts, verdicts and counterexamples for 1, 4 and 8 workers (and across repeated runs).

mod common;
use common::*;
use mc::{Model, Options, Report, check};

fn summary<M: Model>(r: &Report<M>) -> String {
    let mut s = format!("distinct={} generated={} depth={}\n", r.stats.distinct, r.stats.generated, r.stats.depth);
    for p in &r.results {
        s += &format!("{} {:?} {}\n", p.name, p.verdict, p.trace.as_ref().map(|t| t.render()).unwrap_or_default());
    }
    s
}

fn same_for_all_workers<M: Model>(m: &M, base: Options) -> String {
    let mut first: Option<String> = None;
    for w in [1, 4, 8, 4, 8] {
        let s = summary(&check(m, &Options { workers: w, ..base.clone() }));
        match &first {
            None => first = Some(s),
            Some(f) => assert_eq!(f, &s, "result differs with {w} workers"),
        }
    }
    first.unwrap()
}

/// Many violations at the same (minimal) depth and many parents per state: SumBelow fails on the whole
/// anti-diagonal x + y = 40, and every inner state has two BFS parents. The reported trace must not depend on
/// the schedule.
#[test]
fn counts_and_traces_identical_for_1_4_8_workers() {
    let m = Counters { n: 60, target: None, sum_limit: 40 };
    let s = same_for_all_workers(&m, Options { props: vec!["SumBelow".into(), "InRange".into()], ..Options::default() });
    assert!(s.starts_with(&format!("distinct={} ", 60 * 60)));
    assert!(s.contains("SumBelow Violated"));
    let r = check(&m, &props(8, &["SumBelow"]));
    assert_eq!(r.trace("SumBelow").len(), 41);
    assert_valid_trace(&m, r.trace("SumBelow"));

    // 301 violating states at depth 300, spread over many work chunks and workers.
    let wide = Counters { n: 400, target: None, sum_limit: 300 };
    let s = same_for_all_workers(&wide, Options { props: vec!["SumBelow".into()], ..Options::default() });
    // Early stop after level 300; level 301 is generated: all states with x + y <= 301.
    let expected: u64 = (0..=301u64).map(|d| d + 1).sum();
    assert!(s.starts_with(&format!("distinct={expected} ")), "{s}");

    same_for_all_workers(&Counters::new(60), Options::default());
    same_for_all_workers(&Mutex2 { broken: true }, Options::default());
    same_for_all_workers(&Mutex2 { broken: false }, Options::default());
    same_for_all_workers(&Dining { terminal_deadlock: false }, Options { deadlock: true, ..Options::default() });
    same_for_all_workers(&Tokens { k: 4, n: 6, symmetric: true }, Options { deadlock: true, ..Options::default() });
    same_for_all_workers(&Live { fair_toggle: true, fair_finish: true, finish_needs_on: true }, Options::default());
}

/// Early stop happens at level boundaries: when every selected safety property is violated the run ends after
/// the level of the last first violation, with the same count for any worker count.
#[test]
fn early_stop_count_is_deterministic() {
    let m = Counters { n: 50, target: Some((3, 4)), sum_limit: u32::MAX };
    let s = same_for_all_workers(&m, Options { props: vec!["NotTarget".into()], ..Options::default() });
    // Levels 0..=7 explored, level 8 generated: states with x + y <= 8.
    let expected: u64 = (0..=8u64).map(|d| d + 1).sum();
    assert!(s.starts_with(&format!("distinct={expected} ")), "{s}");
}

/// Simulation: same seed, same result for any worker count; a different seed is a different (valid) run.
#[test]
fn simulation_reproducible_by_seed_for_any_workers() {
    let sim = mc::SimOptions { traces: 300, depth: 30, seed: 42 };
    let base = Options { simulate: Some(sim), ..Options::default() };
    let s = same_for_all_workers(&Mutex2 { broken: true }, base.clone());
    assert!(s.contains("MutualExclusion Violated"));
    same_for_all_workers(&Counters { n: 20, target: Some((2, 2)), sum_limit: u32::MAX }, base);
}
