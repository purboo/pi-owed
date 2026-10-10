//! Engine follow-ups of the mc-engine review (#528), owned by mc-port: regression tests for the three liveness
//! mutations that survived (M4, M9, M22), the `Eventually` (<>Q) property, per-level counts, the build-time
//! engine version and the capped exit status. Expected verdicts are argued from the TLA+ semantics in comments.

mod common;
use common::*;
use mc::{Consts, DynModel, Kind, Model, ModelInfo, Property, Registry, SimOptions, Verdict, check, cli};

/// An explicit graph: node i has labels p[i], q[i]; edges (src, dst, fairness class or None). `src == dst` is a
/// stutter step (TLA+: it changes no variable).
struct G {
    init: Vec<u8>,
    p: Vec<bool>,
    q: Vec<bool>,
    edges: Vec<(u8, u8, Option<&'static str>)>,
}

impl Model for G {
    type State = u8;
    type Action = (u8, u8);
    fn init(&self) -> Vec<u8> {
        self.init.clone()
    }
    fn next(&self, s: &u8, out: &mut Vec<((u8, u8), u8)>) {
        for &(a, b, _) in &self.edges {
            if a == *s {
                out.push(((a, b), b));
            }
        }
    }
    fn properties(&self) -> Vec<Property<Self>> {
        vec![
            Property::LeadsTo { name: "PtoQ", p: |m: &G, s: &u8| m.p[*s as usize], q: |m: &G, s: &u8| m.q[*s as usize] },
            Property::Eventually { name: "EvQ", q: |m: &G, s: &u8| m.q[*s as usize] },
        ]
    }
    fn fairness(&self, a: &(u8, u8)) -> Option<&'static str> {
        self.edges.iter().find(|e| (e.0, e.1) == *a).and_then(|e| e.2)
    }
}

fn verdicts(m: &G) -> (Verdict, Verdict) {
    let r = check(m, &opts(2));
    (r.verdict("PtoQ"), r.verdict("EvQ"))
}

/// M4 (a stutter step counted as enabling its class). Node 0 (P, ~Q) has only a fair action that stutters and an
/// unfair way to Q. Stuttering does not enable the class (it is not an ENABLED <<A>>_vars step), so stuttering
/// forever at 0 is weakly fair: P ~> Q and <>Q are VIOLATED. The mutant sees the class enabled and never taken.
#[test]
fn followup_fair_action_that_only_stutters_is_violated() {
    let m = G { init: vec![0], p: vec![true, false], q: vec![false, true], edges: vec![(0, 0, Some("A")), (0, 1, None)] };
    let r = check(&m, &opts(2));
    assert_eq!(r.verdict("PtoQ"), Verdict::Violated);
    assert_eq!(r.verdict("EvQ"), Verdict::Violated);
    let t = r.trace("PtoQ");
    assert!(t.stutter);
    assert_eq!(t.len(), 1);
    // Control: the same action fair and leaving 0 for Q makes both hold.
    let m = G { init: vec![0], p: vec![true, false], q: vec![false, true], edges: vec![(0, 0, Some("A")), (0, 1, Some("A"))] };
    assert_eq!(verdicts(&m), (Verdict::Holds, Verdict::Holds));
}

/// M9 (backward reachability not restricted to ~Q). Node 0 satisfies P /\ Q, then a ~Q dead end 1. Every P state
/// already satisfies Q, so P ~> Q HOLDS; <>Q holds as the initial state satisfies Q. The mutant walks back from
/// the fair ~Q node 1 into the Q node 0 and reports it as a start.
#[test]
fn followup_p_and_q_then_not_q_dead_end_holds() {
    let m = G { init: vec![0], p: vec![true, false], q: vec![true, false], edges: vec![(0, 1, Some("A"))] };
    assert_eq!(verdicts(&m), (Verdict::Holds, Verdict::Holds));
    // Control: if the dead end is P too, P ~> Q fails there (stuttering at a P /\ ~Q node with nothing enabled).
    let m = G { init: vec![0], p: vec![true, true], q: vec![true, false], edges: vec![(0, 1, Some("A"))] };
    assert_eq!(verdicts(&m), (Verdict::Violated, Verdict::Holds));
}

/// M22 (classes counted as taken on edges that leave the component). Nodes 0 (P) and 1 are ~Q singletons; class
/// A is enabled at 0 and taken only on the edge 0 -> 1 between the two components; at 1 class B is enabled and
/// leads to Q (node 2). Neither ~Q component is fair (A enabled at 0 but not taken inside {0}; B likewise at 1),
/// so every fair behavior reaches 2: P ~> Q and <>Q HOLD. The mutant counts A as taken in {0} and reports it.
#[test]
fn followup_class_taken_only_between_components_holds() {
    let m = G {
        init: vec![0],
        p: vec![true, false, false],
        q: vec![false, false, true],
        edges: vec![(0, 1, Some("A")), (1, 2, Some("B"))],
    };
    assert_eq!(verdicts(&m), (Verdict::Holds, Verdict::Holds));
    // Control: without fairness on B, stuttering at 1 is fair.
    let m = G { init: vec![0], p: vec![true, false, false], q: vec![false, false, true], edges: vec![(0, 1, Some("A")), (1, 2, None)] };
    assert_eq!(verdicts(&m), (Verdict::Violated, Verdict::Violated));
}

/// <>Q is not the state predicate "is the initial value" ~> Q: here the initial value recurs after Q.
/// 0 (init, ~Q) -A-> 1 (Q) -A-> 3 (~Q, same "x" as 0, dead end). <>Q holds (Q at the second state under WF A);
/// (x = 0) ~> Q fails at node 3. Without fairness <>Q fails by stuttering at 0 (a one-state lasso).
#[test]
fn followup_eventually_differs_from_init_leadsto() {
    let fair = G {
        init: vec![0],
        p: vec![true, false, false, true],
        q: vec![false, true, false, false],
        edges: vec![(0, 1, Some("A")), (1, 3, Some("A"))],
    };
    let r = check(&fair, &opts(3));
    assert_eq!(r.verdict("EvQ"), Verdict::Holds);
    assert_eq!(r.verdict("PtoQ"), Verdict::Violated);
    assert_eq!(*r.trace("PtoQ").last_state(), 3);
    let unfair = G { edges: vec![(0, 1, None), (1, 3, None)], ..fair };
    let r = check(&unfair, &opts(3));
    assert_eq!(r.verdict("EvQ"), Verdict::Violated);
    let t = r.trace("EvQ");
    assert_eq!((t.len(), t.stutter, t.loop_start), (1, true, Some(0)));
}

/// <>Q over several initial states and a genuine (non-stutter) fair ~Q cycle: init 0 reaches Q; init 4 has a fair
/// ~Q cycle 4 <-> 5 (class C taken on it). The lasso starts at 4 and loops; the result is the same for 1/4/8
/// workers and in the rendered trace.
#[test]
fn followup_eventually_cycle_lasso_from_second_initial_state() {
    let m = G {
        init: vec![0, 4],
        p: vec![false; 6],
        q: vec![false, true, false, false, false, false],
        edges: vec![(0, 1, Some("C")), (4, 5, Some("C")), (5, 4, Some("C"))],
    };
    let mut rendered = Vec::new();
    for w in [1, 4, 8] {
        let r = check(&m, &opts(w));
        assert_eq!(r.verdict("EvQ"), Verdict::Violated);
        assert_eq!(r.verdict("PtoQ"), Verdict::Holds);
        let t = r.trace("EvQ");
        assert_eq!(t.steps[0].state, 4);
        assert!(!t.stutter);
        assert_eq!(t.last_state(), &t.steps[t.loop_start.unwrap()].state);
        assert!(t.states().all(|s| !m.q[*s as usize]));
        rendered.push(t.render());
    }
    assert!(rendered.windows(2).all(|w| w[0] == w[1]));
}

/// Simulation reports <>Q only soundly (stuttering where no fair class is enabled), and HOLDS-SIM otherwise.
#[test]
fn followup_eventually_in_simulation() {
    let sim = SimOptions { traces: 20, depth: 10, seed: 3 };
    let unfair = G { init: vec![0], p: vec![false, false], q: vec![false, true], edges: vec![(0, 1, None)] };
    let r = check(&unfair, &mc::Options { simulate: Some(sim.clone()), ..opts(2) });
    // The walk takes 0 -> 1 whenever it moves; a sound violation needs a state with no fair class enabled and Q
    // never seen: node 0 qualifies (nothing fair is enabled there), so the very first state is reported.
    assert_eq!(r.verdict("EvQ"), Verdict::Violated);
    assert_eq!(r.trace("EvQ").len(), 1);
    let fair = G { init: vec![0], p: vec![false, false], q: vec![false, true], edges: vec![(0, 1, Some("A"))] };
    let r = check(&fair, &mc::Options { simulate: Some(sim), ..opts(2) });
    assert_eq!(r.verdict("EvQ"), Verdict::HoldsSim);
}

/// `Stats::levels` counts the new states of each BFS level: two counters mod N have min(d+1, 2N-1-d) states at
/// distance d (d = x + y with x, y < N).
#[test]
fn followup_levels_per_bfs_depth() {
    let n = 6u32;
    let m = Counters::new(n);
    let r = check(&m, &props(4, &["InRange"]));
    let want: Vec<u64> = (0..(2 * n - 1)).map(|d| (d + 1).min(2 * n - 1 - d) as u64).collect();
    assert_eq!(r.stats.levels, want);
    assert_eq!(r.stats.levels.iter().sum::<u64>(), r.stats.distinct);
}

/// The engine version is recorded at build time: crate version, git describe, and the sha256 of the engine
/// sources recomputed here independently from formal/mc/src/*.rs.
#[test]
fn followup_engine_version_built_in() {
    let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
    let mut files: Vec<_> = std::fs::read_dir(&dir).unwrap().map(|e| e.unwrap().path()).filter(|p| p.extension().is_some_and(|x| x == "rs")).collect();
    files.sort();
    let mut buf = Vec::new();
    for f in &files {
        let body = std::fs::read(f).unwrap();
        buf.extend_from_slice(f.file_name().unwrap().to_string_lossy().as_bytes());
        buf.push(0);
        buf.extend_from_slice(body.len().to_string().as_bytes());
        buf.push(0);
        buf.extend_from_slice(&body);
    }
    let want = mc::sha256::hex(&buf);
    assert_eq!(mc::engine_source_sha256(), want);
    let v = mc::engine_version();
    assert!(v.starts_with(&format!("owedmc {} (git ", env!("CARGO_PKG_VERSION"))), "{v}");
    assert!(v.ends_with(&format!(", src sha256 {want})")), "{v}");
}

fn build_g(_mode: &str, _c: &mut Consts) -> Result<Box<dyn DynModel>, String> {
    Ok(Box::new(G { init: vec![0], p: vec![true, false], q: vec![false, true], edges: vec![(0, 1, Some("A"))] }))
}

/// More than 255 ERROR results exit with 255, not with the count modulo 256 (300 would wrap to 44, 256 to 0).
#[test]
fn followup_exit_status_capped_at_255() {
    let mut reg = Registry::new();
    reg.add(ModelInfo {
        name: "g",
        about: "graph",
        modes: &["default"],
        consts: &[],
        source_file: "tests/followups.rs",
        source: "",
        build: build_g,
    });
    for n in [256usize, 300] {
        let mut args = vec!["check".to_string(), "g".to_string()];
        for i in 0..n {
            args.push("--prop".to_string());
            args.push(format!("Nope{i}"));
        }
        let mut out = Vec::new();
        assert_eq!(cli::main(&reg, &args, &mut out), 255);
        args.push("--json".to_string());
        let mut out = Vec::new();
        assert_eq!(cli::main(&reg, &args, &mut out), 255);
    }
    // The Eventually kind is listed and checked through the CLI.
    let mut out = Vec::new();
    let code = cli::main(&reg, &["check".into(), "g".into(), "--prop".into(), "EvQ".into()], &mut out);
    let out = String::from_utf8(out).unwrap();
    assert_eq!(code, 0, "{out}");
    assert!(out.lines().any(|l| l.split_whitespace().nth(3) == Some("HOLDS") && l.contains("EvQ")), "{out}");
    let mut out = Vec::new();
    cli::main(&reg, &["list".into()], &mut out);
    assert!(String::from_utf8(out).unwrap().contains("EvQ(eventually)"));
    assert_eq!(Kind::Eventually.as_str(), "eventually");
}
