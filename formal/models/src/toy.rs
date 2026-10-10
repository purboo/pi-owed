//! toy-counters: K counters modulo N, each incremented by its own action. N^K states; used for the engine's
//! throughput number and as a CLI example.
//!
//! TLA+ equivalent:
//!   VARIABLE c                      \* c \in [1..K -> 0..N-1]
//!   Init == c = [i \in 1..K |-> 0]
//!   Inc(i) == c' = [c EXCEPT ![i] = (@ + 1) % N]
//!   Next == \E i \in 1..K : Inc(i)
//!   Spec == Init /\ [][Next]_c /\ \A i : WF_c(Inc(i))      \* mode "wf"; mode "nofair" has no fairness

use mc::{Consts, DynModel, Model, ModelInfo, Property};

pub const MAX_K: usize = 4;
const CLASSES: [&str; MAX_K] = ["inc0", "inc1", "inc2", "inc3"];

pub struct Counters {
    pub k: usize,
    pub n: u32,
    pub fair: bool,
}

#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct State {
    pub c: [u32; MAX_K],
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Action {
    Inc(usize),
}

impl Model for Counters {
    type State = State;
    type Action = Action;

    fn init(&self) -> Vec<State> {
        vec![State { c: [0; MAX_K] }]
    }

    fn next(&self, s: &State, out: &mut Vec<(Action, State)>) {
        for i in 0..self.k {
            let mut t = s.clone();
            t.c[i] = (t.c[i] + 1) % self.n;
            out.push((Action::Inc(i), t));
        }
    }

    fn properties(&self) -> Vec<Property<Self>> {
        vec![
            Property::Invariant { name: "InRange", holds: |m: &Counters, s: &State| s.c[..m.k].iter().all(|&x| x < m.n) },
            Property::Invariant {
                name: "NotAllMax",
                holds: |m: &Counters, s: &State| !s.c[..m.k].iter().all(|&x| x == m.n - 1),
            },
            Property::Action {
                name: "OneStep",
                holds: |m: &Counters, s: &State, _a: &Action, t: &State| {
                    (0..m.k).filter(|&i| s.c[i] != t.c[i]).count() == 1
                        && (0..m.k).all(|i| s.c[i] == t.c[i] || t.c[i] == (s.c[i] + 1) % m.n)
                },
            },
            Property::LeadsTo {
                name: "Wraps",
                p: |m: &Counters, s: &State| s.c[0] == m.n - 1,
                q: |_m: &Counters, s: &State| s.c[0] == 0,
            },
        ]
    }

    fn fairness(&self, a: &Action) -> Option<&'static str> {
        let Action::Inc(i) = a;
        if self.fair { Some(CLASSES[*i]) } else { None }
    }
}

fn build(mode: &str, c: &mut Consts) -> Result<Box<dyn DynModel>, String> {
    let k = c.uint("K", 2)? as usize;
    let n = c.uint("N", 10)?;
    if !(1..=MAX_K).contains(&k) {
        return Err(format!("K must be in 1..{MAX_K}"));
    }
    if !(2..=u32::MAX as u64).contains(&n) {
        return Err("N must be at least 2".to_string());
    }
    Ok(Box::new(Counters { k, n: n as u32, fair: mode == "wf" }))
}

pub fn info() -> ModelInfo {
    ModelInfo {
        name: "toy-counters",
        about: "K counters mod N (N^K states); engine smoke test and throughput toy",
        modes: &["wf", "nofair"],
        consts: &[("K", "2"), ("N", "10")],
        source_file: file!(),
        source: include_str!("toy.rs"),
        build,
    }
}
