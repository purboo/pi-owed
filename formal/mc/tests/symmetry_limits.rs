//! `canonical` symmetry reduction and run limits.

mod common;
use common::*;
use mc::{Options, Verdict, check};
use std::collections::HashSet;
use std::time::{Duration, Instant};

/// K tokens on 0..=N: (N+1)^K states; with symmetry the order is irrelevant, leaving the multisets of size K
/// over N+1 values: C(N+K, K). Both numbers come from closed forms and from a naive BFS here.
#[test]
fn canonical_symmetry_reduces_to_multisets() {
    for (k, n) in [(3usize, 4u8), (4, 5), (2, 9)] {
        let plain = Tokens { k, n, symmetric: false };
        let sym = Tokens { k, n, symmetric: true };
        let rp = check(&plain, &opts(4));
        let rs = check(&sym, &opts(4));
        let full = (n as u64 + 1).pow(k as u32);
        let multisets = binomial(n as u64 + k as u64, k as u64);
        assert_eq!(rp.stats.distinct, full, "k={k} n={n}");
        assert_eq!(rs.stats.distinct, multisets, "k={k} n={n}");
        let naive = naive_reachable(&plain);
        assert_eq!(naive.len() as u64, full);
        let classes: HashSet<Vec<u8>> = naive.iter().map(|s| sorted(s)).collect();
        assert_eq!(classes.len() as u64, multisets);
        for r in [&rp, &rs] {
            assert_eq!(r.verdict("Bounded"), Verdict::Holds);
            assert_eq!(r.verdict("NotAllTop"), Verdict::Violated);
        }
        // Shortest path to all-top: K*N steps either way; the trace is a real (unsorted) behavior.
        let t = rs.trace("NotAllTop");
        assert_eq!(t.len(), k * n as usize + 1);
        assert_valid_trace(&sym, t);
    }
}

/// --max-states: TIMEOUT for every unfinished property (never HOLDS); a model with exactly max-states states
/// completes; a violation found before the limit stays VIOLATED.
#[test]
fn max_states_gives_timeout() {
    let m = Counters::new(200);
    let r = check(&m, &Options { max_states: Some(1000), ..props(4, &["InRange", "StepByOne"]) });
    assert_eq!(r.verdict("InRange"), Verdict::Timeout);
    assert_eq!(r.verdict("StepByOne"), Verdict::Timeout);
    assert!(r.stats.distinct > 1000 && r.stats.distinct < 40_000);
    assert!(!r.stats.complete);
    assert_eq!(r.stats.limit.as_deref(), Some("max-states"));

    let exact = check(&Counters::new(10), &Options { max_states: Some(100), ..props(2, &["InRange"]) });
    assert_eq!(exact.verdict("InRange"), Verdict::Holds);
    assert_eq!(exact.stats.distinct, 100);

    let early = Counters { n: 200, target: Some((1, 1)), sum_limit: u32::MAX };
    let r = check(&early, &Options { max_states: Some(1000), ..props(2, &["NotTarget", "InRange"]) });
    assert_eq!(r.verdict("NotTarget"), Verdict::Violated);
    assert_eq!(r.trace("NotTarget").len(), 3);
    assert_eq!(r.verdict("InRange"), Verdict::Timeout);

    // LeadsTo needs the whole graph: TIMEOUT too.
    let live = Live { fair_toggle: false, fair_finish: false, finish_needs_on: false };
    let r = check(&live, &Options { max_states: Some(1), ..opts(1) });
    assert_eq!(r.verdict("EventuallyDone"), Verdict::Timeout);
}

/// --timeout: a model with 10^10 states stops promptly with TIMEOUT (exhaustive and simulation).
#[test]
fn timeout_gives_timeout() {
    let m = Counters::new(100_000);
    let t0 = Instant::now();
    let r = check(&m, &Options { timeout: Some(Duration::from_millis(300)), ..props(4, &["InRange"]) });
    assert_eq!(r.verdict("InRange"), Verdict::Timeout);
    assert_eq!(r.stats.limit.as_deref(), Some("timeout"));
    assert!(t0.elapsed() < Duration::from_secs(20), "took {:?}", t0.elapsed());

    let t0 = Instant::now();
    let sim = mc::SimOptions { traces: u64::MAX, depth: 1000, seed: 1 };
    let r = check(&m, &Options { timeout: Some(Duration::from_millis(300)), simulate: Some(sim), ..props(4, &["InRange"]) });
    assert_eq!(r.verdict("InRange"), Verdict::Timeout);
    assert!(t0.elapsed() < Duration::from_secs(20));
}
