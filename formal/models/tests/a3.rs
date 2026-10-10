//! a3 ports against the recorded TLC results (formal/reference/a3). Fast configurations only; the big runs
//! (free MaxLog=3 with 9,305,311 states, long simulations) go through examples/a3_compare.rs and owedmc on ipc.
//! Expected numbers are TLC's, read from the copied logs (reference/a3/tlc-runs.tsv) or quoted from the a3
//! reports; none is taken from owedmc output.

use mc::{Options, Verdict, check};
use models::a3::auth::Auth;
use models::a3::compare::{compare_bfs, compare_sim, reference};
use models::a3::merge::Merge;
use models::a3::tlc::tlc_order;

fn opts(workers: usize, props: &[&str]) -> Options {
    Options { workers, deadlock: true, props: props.iter().map(|s| s.to_string()).collect(), ..Options::default() }
}

const AUTH_PROPS: [&str; 20] = [
    "AuthoritySound",
    "DecisionAuthority",
    "NoWriterJudge",
    "NoAuthorJudge",
    "RelevantInvalidates",
    "UnrelatedPreserves",
    "StateRemainsDebt",
    "ConflictDebt",
    "SamePrincipalSupersedes",
    "RetroHonored",
    "FuturePreserves",
    "AllSafety",
    "GoodProgress",
    "Finished",
    "NothingMerged",
    "NothingDeferredMerged",
    "NothingParentWaived",
    "NothingCrossWaived",
    "NothingSpeechWaived",
    "NothingRevivedWaived",
];

/// The scenario graph of REPORT-auth.md ("完整图 1,019 个不同状态"): every property of the a3 and a22 columns in
/// one deadlock-checked run per mode. TLC: 1019 distinct, 1402 generated, depth 6 (runs/PiDagAuth3-a3-*.log).
#[test]
fn a3_auth_scenario_graph_1019() {
    use Verdict::{Holds as H, Violated as V};
    // Columns a3 and a22 of the property x mode table in REPORT-auth.md, in AUTH_PROPS order.
    let a3 = [H, H, H, H, H, H, H, H, H, H, H, H, H, H, V, V, V, H, H, H];
    let a22 = [V, V, V, V, V, V, V, V, H, H, H, V, H, H, V, V, V, V, V, V];
    for (mode, want) in [("a3", a3), ("a22", a22)] {
        let m = Auth::new(mode, false, 5).unwrap();
        let r = check(&m, &opts(4, &AUTH_PROPS));
        for (p, w) in AUTH_PROPS.iter().zip(want) {
            assert_eq!(r.verdict(p), w, "{mode} {p}");
        }
        assert_eq!(r.verdict(mc::DEADLOCK), H, "{mode}");
        // The engine generates 1396 transitions (incl. 18 initial states); TLC counts 1402 because it generates
        // the 6 steps taken in family "state" after the deferral twice (two true disjuncts of the merge guard).
        assert_eq!((r.stats.distinct, r.stats.generated, r.stats.levels.len()), (1019, 1396, 6), "{mode}");
        let t = tlc_order(&m, &[], true, &|s, a| m.tlc_branches(s, a));
        assert_eq!(t.generated, 1402, "{mode}");
    }
}

/// Free exploration, MaxLog=2: AllSafety HOLDS with 44,311 distinct and 88,411 generated states, depth 3
/// (runs/PiDagAuth3-a3-AllSafety-free-smoke2.log) = 1 + 210 + 210^2 distinct log prefixes. The free witness
/// NothingMerged is violated by "Owner waives n1, Owner merges n1" (REPORT-auth.md, 3 states).
#[test]
fn a3_auth_free_maxlog2_44311() {
    let m = Auth::new("a3", true, 2).unwrap();
    let r = check(&m, &opts(4, &["AllSafety", "NothingMerged"]));
    assert_eq!(r.verdict("AllSafety"), Verdict::Holds);
    assert_eq!(r.verdict(mc::DEADLOCK), Verdict::Holds);
    assert_eq!((r.stats.distinct, r.stats.generated, r.stats.levels.len()), (44_311, 88_411, 3));
    assert_eq!(1 + 210 + 210 * 210, 44_311);
    let t = r.trace("NothingMerged");
    assert_eq!(t.len(), 3);
    let acts: Vec<String> = t.steps[1..].iter().map(|s| format!("{:?}", s.action.as_ref().unwrap())).collect();
    assert!(acts[0].starts_with("Advance(Waive(Owner->Owner scope={n1} node=n1"), "{acts:?}");
    assert!(acts[1].starts_with("Advance(Merge(Owner->Owner scope={} node=n1"), "{acts:?}");
    // The three a22 free sanity violations are 2 steps long (runs/PiDagAuth3-a22-*-free-min2.log).
    let m = Auth::new("a22", true, 2).unwrap();
    let r = check(&m, &opts(4, &["AuthoritySound", "DecisionAuthority", "NoWriterJudge"]));
    for p in ["AuthoritySound", "DecisionAuthority", "NoWriterJudge"] {
        assert_eq!(r.trace(p).len(), 3, "{p}");
    }
}

/// Every comparable exhaustive TLC run of both modules that is fast (all but the free MaxLog>=3 ones):
/// verdicts, counts, depths and trace lengths as described in `compare` (one-worker TLC counts of violations
/// exactly, through the TLC-order search).
#[test]
fn a3_reference_exhaustive_runs() {
    let mut n = 0;
    let mut failures = Vec::new();
    for row in reference().iter().filter(|r| r.comparable()) {
        let Some(o) = compare_bfs(row, 4, false) else { continue };
        if row.result == "INCOMPLETE" {
            continue;
        }
        n += 1;
        if !o.ok() {
            failures.push(format!("{} [{}]: {}", row.log, row.label(), o.failures.join("; ")));
        }
    }
    assert!(failures.is_empty(), "{} of {n} rows differ:\n{}", failures.len(), failures.join("\n"));
    // 53 auth-v1 + 11 current auth (fast, finished; 4 more are heavy) + 54 current merge + 49 pre-ruling merge
    // exhaustive rows of tlc-runs.tsv.
    assert_eq!(n, 167, "rows compared");
}

/// The sampled TLC runs of the current modules, rerun as simulations (TLC's depth; at most 20,000 walks here,
/// 4,000 for the authority model; the full numbers run on ipc): every violation TLC found is found, and no
/// violation where TLC found none.
#[test]
fn a3_reference_simulations() {
    let mut failures = Vec::new();
    let mut n = 0;
    for row in reference().iter().filter(|r| r.comparable() && r.search == "sim") {
        let cap = if row.is_auth() { 4_000 } else { 20_000 };
        let traces = (row.sim_num.unwrap_or(1000) * row.workers as u64).min(cap);
        let o = compare_sim(row, 4, Some(traces), 1, Some(300.0)).unwrap();
        n += 1;
        if !o.ok() {
            failures.push(format!("{} [{}]: {}", row.log, row.label(), o.failures.join("; ")));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n"));
    assert_eq!(n, 12);
}

/// Liveness of the merge queue (REPORT-merge.md, K5queue/GoodEventuallyMerges): a3 HOLDS on 9 states; the
/// a22 rebase race violates <>merged under WF (17 states), as does the a3-K5queue ablation (24 states).
#[test]
fn a3_merge_live_queue_liveness() {
    for (mode, want, distinct) in [("a3", Verdict::Holds, 9), ("a22", Verdict::Violated, 17), ("a3-K5queue", Verdict::Violated, 24)] {
        let m = Merge::new(mode, "live").unwrap();
        let r = check(&m, &opts(2, &["GoodEventuallyMerges", "LeaseExcludes"]));
        assert_eq!(r.verdict("GoodEventuallyMerges"), want, "{mode}");
        assert_eq!(r.stats.distinct, distinct, "{mode}");
        if want == Verdict::Violated {
            let t = r.trace("GoodEventuallyMerges");
            assert!(t.loop_start.is_some());
            assert!(t.states().all(|s| matches!(s, models::a3::merge::State::Script(x) if !x.merged)));
        }
    }
}

/// Counts and counterexamples do not depend on the worker count; the TLC-order search agrees with the engine on
/// complete graphs.
#[test]
fn a3_ports_deterministic_and_tlc_order_consistent() {
    let m = Auth::new("a22", false, 5).unwrap();
    let mut seen = Vec::new();
    for w in [1, 3, 8] {
        let r = check(&m, &opts(w, &["ConflictDebt", "NothingRevivedWaived"]));
        seen.push((r.stats.distinct, r.trace("ConflictDebt").render(), r.trace("NothingRevivedWaived").render()));
    }
    assert!(seen.windows(2).all(|w| w[0] == w[1]));
    let t = tlc_order(&m, &["SamePrincipalSupersedes"], true, &|s, a| m.tlc_branches(s, a));
    assert_eq!((t.violated, t.distinct, t.generated), (None, 1019, 1402));
    let mm = Merge::new("a22", "launderTest").unwrap();
    let t = tlc_order(&mm, &["DeferredDebtVisible"], true, &|s, a| mm.tlc_branches(s, a));
    assert_eq!((t.violated, t.distinct, t.generated), (None, 183, 453));
}
