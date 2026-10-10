//! Toy models and independent helpers for the engine tests. Expected numbers are derived here (closed forms or
//! a naive single-threaded BFS written independently of the engine), never copied from engine output.
#![allow(dead_code)]

use mc::{Model, Options, Property, Trace};
use std::collections::{HashMap, HashSet, VecDeque};
use std::hash::Hash;

pub fn opts(workers: usize) -> Options {
    Options { workers, ..Options::default() }
}

pub fn props(workers: usize, names: &[&str]) -> Options {
    Options { workers, props: names.iter().map(|s| s.to_string()).collect(), ..Options::default() }
}

/// Naive reachability (no fingerprints, no canonical forms): the set of reachable states.
pub fn naive_reachable<M: Model>(m: &M) -> HashSet<M::State> {
    let mut seen: HashSet<M::State> = HashSet::new();
    let mut q: VecDeque<M::State> = VecDeque::new();
    for s in m.init() {
        if seen.insert(s.clone()) {
            q.push_back(s);
        }
    }
    let mut out = Vec::new();
    while let Some(s) = q.pop_front() {
        out.clear();
        m.next(&s, &mut out);
        for (_, t) in out.drain(..) {
            if seen.insert(t.clone()) {
                q.push_back(t);
            }
        }
    }
    seen
}

/// Naive BFS distance from the initial states to the nearest state satisfying `bad`.
pub fn naive_distance<M: Model>(m: &M, bad: impl Fn(&M::State) -> bool) -> Option<usize> {
    let mut dist: HashMap<M::State, usize> = HashMap::new();
    let mut q: VecDeque<M::State> = VecDeque::new();
    for s in m.init() {
        if !dist.contains_key(&s) {
            dist.insert(s.clone(), 0);
            q.push_back(s);
        }
    }
    let mut out = Vec::new();
    while let Some(s) = q.pop_front() {
        let d = dist[&s];
        if bad(&s) {
            return Some(d);
        }
        out.clear();
        m.next(&s, &mut out);
        for (_, t) in out.drain(..) {
            if !dist.contains_key(&t) {
                dist.insert(t.clone(), d + 1);
                q.push_back(t);
            }
        }
    }
    None
}

/// Every step of `t` is a real transition of `m` (initial state first, each action produced its state).
pub fn assert_valid_trace<M: Model>(m: &M, t: &Trace<M>)
where
    M::Action: PartialEq,
{
    assert!(!t.steps.is_empty(), "empty trace");
    assert!(t.steps[0].action.is_none());
    assert!(m.init().contains(&t.steps[0].state), "trace does not start in an initial state");
    let mut out = Vec::new();
    for w in t.steps.windows(2) {
        out.clear();
        m.next(&w[0].state, &mut out);
        let a = w[1].action.as_ref().expect("step without action");
        assert!(
            out.iter().any(|(oa, os)| oa == a && *os == w[1].state),
            "invalid step {:?} -> {:?} via {:?}",
            w[0].state,
            w[1].state,
            a
        );
    }
}

pub fn binomial(n: u64, k: u64) -> u64 {
    let mut r = 1u64;
    for i in 0..k {
        r = r * (n - i) / (i + 1);
    }
    r
}

// ---------------------------------------------------------------------------------------------------------------
// Two counters mod N.

pub struct Counters {
    pub n: u32,
    /// Invariant NotTarget fails at this state.
    pub target: Option<(u32, u32)>,
    /// Invariant SumBelow fails when x + y >= this.
    pub sum_limit: u32,
}

impl Counters {
    pub fn new(n: u32) -> Counters {
        Counters { n, target: None, sum_limit: u32::MAX }
    }
}

#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct C2 {
    pub x: u32,
    pub y: u32,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum CA {
    IncX,
    IncY,
}

impl Model for Counters {
    type State = C2;
    type Action = CA;
    fn init(&self) -> Vec<C2> {
        vec![C2 { x: 0, y: 0 }]
    }
    fn next(&self, s: &C2, out: &mut Vec<(CA, C2)>) {
        out.push((CA::IncX, C2 { x: (s.x + 1) % self.n, y: s.y }));
        out.push((CA::IncY, C2 { x: s.x, y: (s.y + 1) % self.n }));
    }
    fn properties(&self) -> Vec<Property<Self>> {
        vec![
            Property::Invariant { name: "InRange", holds: |m: &Counters, s: &C2| s.x < m.n && s.y < m.n },
            Property::Invariant {
                name: "NotTarget",
                holds: |m: &Counters, s: &C2| m.target != Some((s.x, s.y)),
            },
            Property::Invariant { name: "SumBelow", holds: |m: &Counters, s: &C2| s.x + s.y < m.sum_limit },
            Property::Action {
                name: "StepByOne",
                holds: |m: &Counters, s: &C2, _a: &CA, t: &C2| {
                    let dx = (t.x + m.n - s.x) % m.n;
                    let dy = (t.y + m.n - s.y) % m.n;
                    dx + dy == 1
                },
            },
            Property::Action {
                name: "NeverWrapX",
                holds: |m: &Counters, s: &C2, _a: &CA, t: &C2| !(s.x == m.n - 1 && t.x == 0),
            },
        ]
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Two-process mutual exclusion: Peterson, and a broken check-then-set variant.

pub struct Mutex2 {
    pub broken: bool,
}

#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct Mx {
    /// 0 = idle, 1 = trying/ready, 2 = critical section.
    pub pc: [u8; 2],
    pub flag: [bool; 2],
    pub turn: u8,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum MA {
    Step(usize),
}

impl Model for Mutex2 {
    type State = Mx;
    type Action = MA;
    fn init(&self) -> Vec<Mx> {
        vec![Mx { pc: [0, 0], flag: [false, false], turn: 0 }]
    }
    fn next(&self, s: &Mx, out: &mut Vec<(MA, Mx)>) {
        for i in 0..2 {
            let j = 1 - i;
            let mut t = s.clone();
            let moved = if self.broken {
                match s.pc[i] {
                    0 if !s.flag[j] => {
                        t.pc[i] = 1;
                        true
                    }
                    1 => {
                        t.flag[i] = true;
                        t.pc[i] = 2;
                        true
                    }
                    2 => {
                        t.flag[i] = false;
                        t.pc[i] = 0;
                        true
                    }
                    _ => false,
                }
            } else {
                match s.pc[i] {
                    0 => {
                        t.flag[i] = true;
                        t.turn = j as u8;
                        t.pc[i] = 1;
                        true
                    }
                    1 if !s.flag[j] || s.turn == i as u8 => {
                        t.pc[i] = 2;
                        true
                    }
                    2 => {
                        t.flag[i] = false;
                        t.pc[i] = 0;
                        true
                    }
                    _ => false,
                }
            };
            if moved {
                out.push((MA::Step(i), t));
            }
        }
    }
    fn properties(&self) -> Vec<Property<Self>> {
        vec![Property::Invariant { name: "MutualExclusion", holds: |_m: &Mutex2, s: &Mx| !(s.pc[0] == 2 && s.pc[1] == 2) }]
    }
}

pub fn both_critical(s: &Mx) -> bool {
    s.pc[0] == 2 && s.pc[1] == 2
}

// ---------------------------------------------------------------------------------------------------------------
// Dining philosophers (3): take left fork, then right fork, eat, put both down.

pub struct Dining {
    /// Treat the all-hold-left state as an explicit end of the experiment.
    pub terminal_deadlock: bool,
}

#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct Ph {
    /// 0 thinking, 1 holds left, 2 eating.
    pub pc: [u8; 3],
    /// Owner of each fork.
    pub fork: [Option<u8>; 3],
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum PA {
    TakeLeft(usize),
    TakeRight(usize),
    PutDown(usize),
}

impl Model for Dining {
    type State = Ph;
    type Action = PA;
    fn init(&self) -> Vec<Ph> {
        vec![Ph { pc: [0; 3], fork: [None; 3] }]
    }
    fn next(&self, s: &Ph, out: &mut Vec<(PA, Ph)>) {
        for i in 0..3 {
            let (l, r) = (i, (i + 1) % 3);
            let mut t = s.clone();
            match s.pc[i] {
                0 if s.fork[l].is_none() => {
                    t.fork[l] = Some(i as u8);
                    t.pc[i] = 1;
                    out.push((PA::TakeLeft(i), t));
                }
                1 if s.fork[r].is_none() => {
                    t.fork[r] = Some(i as u8);
                    t.pc[i] = 2;
                    out.push((PA::TakeRight(i), t));
                }
                2 => {
                    t.fork[l] = None;
                    t.fork[r] = None;
                    t.pc[i] = 0;
                    out.push((PA::PutDown(i), t));
                }
                _ => {}
            }
        }
    }
    fn properties(&self) -> Vec<Property<Self>> {
        vec![Property::Invariant {
            name: "ForksHeldByNeighbours",
            holds: |_m: &Dining, s: &Ph| {
                (0..3).all(|f| match s.fork[f] {
                    None => true,
                    Some(p) => p as usize == f || (p as usize + 1) % 3 == f,
                })
            },
        }]
    }
    fn terminal(&self, s: &Ph) -> bool {
        self.terminal_deadlock && s.pc == [1, 1, 1]
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Liveness toy: a switch toggles while not done; Finish ends the run.

pub struct Live {
    /// Toggle is weakly fair (class "toggle").
    pub fair_toggle: bool,
    /// Finish is weakly fair (class "finish").
    pub fair_finish: bool,
    /// Finish is only enabled while the switch is on.
    pub finish_needs_on: bool,
}

#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct LS {
    pub on: bool,
    pub done: bool,
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum LA {
    Toggle,
    Finish,
}

impl Model for Live {
    type State = LS;
    type Action = LA;
    fn init(&self) -> Vec<LS> {
        vec![LS { on: false, done: false }]
    }
    fn next(&self, s: &LS, out: &mut Vec<(LA, LS)>) {
        if !s.done {
            out.push((LA::Toggle, LS { on: !s.on, done: false }));
            if !self.finish_needs_on || s.on {
                out.push((LA::Finish, LS { on: s.on, done: true }));
            }
        }
    }
    fn properties(&self) -> Vec<Property<Self>> {
        vec![
            Property::LeadsTo { name: "EventuallyDone", p: |_m: &Live, s: &LS| !s.done, q: |_m: &Live, s: &LS| s.done },
            Property::LeadsTo { name: "Vacuous", p: |_m: &Live, _s: &LS| false, q: |_m: &Live, s: &LS| s.done },
        ]
    }
    fn terminal(&self, s: &LS) -> bool {
        s.done
    }
    fn fairness(&self, a: &LA) -> Option<&'static str> {
        match a {
            LA::Toggle if self.fair_toggle => Some("toggle"),
            LA::Finish if self.fair_finish => Some("finish"),
            _ => None,
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Symmetric tokens: K tokens, each climbs from 0 to N; with symmetry the order of tokens does not matter.

pub struct Tokens {
    pub k: usize,
    pub n: u8,
    pub symmetric: bool,
}

#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub enum TA {
    Up(usize),
}

impl Model for Tokens {
    type State = Vec<u8>;
    type Action = TA;
    fn init(&self) -> Vec<Vec<u8>> {
        vec![vec![0; self.k]]
    }
    fn next(&self, s: &Vec<u8>, out: &mut Vec<(TA, Vec<u8>)>) {
        for i in 0..self.k {
            if s[i] < self.n {
                let mut t = s.clone();
                t[i] += 1;
                out.push((TA::Up(i), t));
            }
        }
    }
    fn properties(&self) -> Vec<Property<Self>> {
        vec![
            Property::Invariant { name: "Bounded", holds: |m: &Tokens, s: &Vec<u8>| s.iter().all(|&x| x <= m.n) },
            Property::Invariant {
                name: "NotAllTop",
                holds: |m: &Tokens, s: &Vec<u8>| !s.iter().all(|&x| x == m.n),
            },
        ]
    }
    fn terminal(&self, s: &Vec<u8>) -> bool {
        s.iter().all(|&x| x == self.n)
    }
    fn canonical(&self, s: &Vec<u8>) -> Vec<u8> {
        let mut c = s.clone();
        if self.symmetric {
            c.sort_unstable();
        }
        c
    }
}

/// Hash helper used by tests that compare canonical classes independently.
pub fn sorted<T: Ord + Clone + Hash>(v: &[T]) -> Vec<T> {
    let mut c = v.to_vec();
    c.sort();
    c
}
