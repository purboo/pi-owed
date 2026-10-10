//! A sequential breadth-first search in TLC's exploration order, used only to compare distinct-state counts of
//! *violated* invariants with TLC's logs.
//!
//! TLC (one worker) checks an invariant on each new state when it is generated, stops at the first violation and
//! reports the size of its fingerprint set at that moment. The owedmc engine instead stops at a level boundary,
//! so its count of a violated run is the number of states up to the level after the violating one. Both counts
//! are deterministic, but different by construction. This function reproduces the TLC count: initial states in
//! `init` order, then FIFO, successors in `next` order (the models list them in TLC's evaluation order), an
//! invariant checked on every new state, an action property on every transition, deadlock when a state has no
//! successor. With several TLC workers the order is not deterministic; there only the bounds of `levels` apply.

use mc::{Model, Property};
use std::collections::HashMap;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TlcRun {
    /// The violated property (or "Deadlock"); None when the search exhausted the graph.
    pub violated: Option<String>,
    /// Distinct states found when the search stopped (TLC's "distinct states found").
    pub distinct: u64,
    /// States generated until then: initial states plus successors (TLC's "states generated").
    pub generated: u64,
    /// Length of the counterexample (states), 0 when none.
    pub trace_states: usize,
    /// New states per BFS level (complete only when no violation stopped the search).
    pub levels: Vec<u64>,
}

/// Explore `m` in TLC order checking the named invariants/action properties (and deadlock).
pub fn tlc_order<M: Model>(
    m: &M,
    props: &[&str],
    deadlock: bool,
    branches: &dyn Fn(&M::State, &M::Action) -> u64,
) -> TlcRun {
    let all = m.properties();
    let mut invs: Vec<(&'static str, fn(&M, &M::State) -> bool)> = Vec::new();
    let mut acts: Vec<(&'static str, fn(&M, &M::State, &M::Action, &M::State) -> bool)> = Vec::new();
    for p in &all {
        if !props.contains(&p.name()) {
            continue;
        }
        match p {
            Property::Invariant { name, holds } => invs.push((name, *holds)),
            Property::Action { name, holds } => acts.push((name, *holds)),
            _ => {}
        }
    }
    let mut index: HashMap<M::State, usize> = HashMap::new();
    let mut states: Vec<M::State> = Vec::new();
    let mut parent: Vec<usize> = Vec::new();
    let mut depth: Vec<usize> = Vec::new();
    let mut levels: Vec<u64> = Vec::new();
    let mut generated = 0u64;
    let trace_len = |parent: &Vec<usize>, mut i: usize| {
        let mut n = 1;
        while parent[i] != usize::MAX {
            i = parent[i];
            n += 1;
        }
        n
    };
    let stop = |name: &str, distinct: usize, generated: u64, trace: usize, levels: Vec<u64>| TlcRun {
        violated: Some(name.to_string()),
        distinct: distinct as u64,
        generated,
        trace_states: trace,
        levels,
    };
    for s in m.init() {
        generated += 1;
        let c = m.canonical(&s);
        if index.contains_key(&c) {
            continue;
        }
        index.insert(c, states.len());
        states.push(s.clone());
        parent.push(usize::MAX);
        depth.push(0);
        if levels.is_empty() {
            levels.push(0);
        }
        levels[0] += 1;
        for (name, f) in &invs {
            if !f(m, &s) {
                return stop(name, states.len(), generated, 1, levels);
            }
        }
    }
    let mut head = 0;
    let mut out = Vec::new();
    while head < states.len() {
        let s = states[head].clone();
        out.clear();
        m.next(&s, &mut out);
        if out.is_empty() && deadlock && !m.terminal(&s) {
            let t = trace_len(&parent, head);
            return stop(mc::DEADLOCK, states.len(), generated, t, levels);
        }
        for (a, t) in out.drain(..) {
            // The copies of one transition are adjacent in TLC's successor list; a violation stops at the first.
            let copies = branches(&s, &a);
            generated += 1;
            let c = m.canonical(&t);
            if !index.contains_key(&c) {
                let i = states.len();
                index.insert(c, i);
                states.push(t.clone());
                parent.push(head);
                let d = depth[head] + 1;
                depth.push(d);
                if levels.len() <= d {
                    levels.push(0);
                }
                levels[d] += 1;
                for (name, f) in &invs {
                    if !f(m, &t) {
                        let tl = trace_len(&parent, i);
                        return stop(name, states.len(), generated, tl, levels);
                    }
                }
            }
            for (name, f) in &acts {
                if !f(m, &s, &a, &t) {
                    let tl = trace_len(&parent, head) + 1;
                    return stop(name, states.len(), generated, tl, levels);
                }
            }
            generated += copies.saturating_sub(1);
        }
        head += 1;
    }
    TlcRun { violated: None, distinct: states.len() as u64, generated, trace_states: 0, levels }
}
