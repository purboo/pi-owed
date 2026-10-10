//! Exhaustive, level-synchronous, parallel breadth-first search.
//!
//! Determinism: the set of states of every level does not depend on the schedule. Among several transitions
//! that reach the same new state within one level, the one from the parent with the smallest fingerprint wins
//! (the first of its successors in `next` order), so parent pointers and the stored representatives are
//! schedule-independent. Among the violations of one property at the smallest depth the one with the smallest
//! key (depth, fingerprint of the state, successor index) is reported. Runs stop only at level boundaries
//! (except when a limit is hit), so counts are identical for any worker count.

use crate::live::{self, EdgeRec, NodeRec, NO_CLASS};
use crate::{Fp, Model, Options, Outcome, Sel, Stats, Step, Trace, fingerprint};
use std::collections::HashMap;
use std::panic::resume_unwind;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering::Relaxed};
use std::time::Instant;

pub(crate) const NONE: u64 = u64::MAX;
const CHUNK: usize = 32;
const LOCAL_BITS: u64 = 0xffff_ffff;

/// One stored state: its fingerprint and the reference (shard << 32 | index) of its BFS parent.
pub(crate) struct Entry {
    pub(crate) fp: Fp,
    pub(crate) parent: u64,
}

/// A shard of the fingerprint store: an open-addressing table of u64 slots (high 32 bits: a fingerprint tag,
/// low 32 bits: index + 1 into `log`) and the log of entries in insertion order. Per state: 16 bytes of
/// fingerprint + 8 bytes of parent pointer in the log, plus 8 bytes of table slot at a load factor in
/// (0.4, 0.8], i.e. at most 20 bytes; the log grows by 1/8 so its slack stays small.
pub(crate) struct Shard<S> {
    table: Vec<u64>,
    pub(crate) log: Vec<Entry>,
    /// First log index of the level being generated.
    level_start: u32,
    /// Representatives of the states generated in this level (aligned with `log[level_start..]`) and the
    /// fingerprint of the parent that produced the representative (the tie-break key).
    next: Vec<(S, Fp)>,
}

impl<S> Shard<S> {
    fn new() -> Self {
        Shard { table: vec![0; 64], log: Vec::new(), level_start: 0, next: Vec::new() }
    }

    #[inline]
    fn home(fp: &Fp, mask: usize) -> usize {
        (fp[0] >> 20) as usize & mask
    }

    fn find(&self, fp: &Fp) -> Result<u32, usize> {
        let mask = self.table.len() - 1;
        let tag = fp[1] >> 32;
        let mut i = Self::home(fp, mask);
        loop {
            let slot = self.table[i];
            if slot == 0 {
                return Err(i);
            }
            if slot >> 32 == tag {
                let l = (slot & LOCAL_BITS) as u32 - 1;
                if self.log[l as usize].fp == *fp {
                    return Ok(l);
                }
            }
            i = (i + 1) & mask;
        }
    }

    fn grow(&mut self) {
        let cap = self.table.len() * 2;
        let mask = cap - 1;
        let mut t = vec![0u64; cap];
        for &slot in &self.table {
            if slot != 0 {
                let l = (slot & LOCAL_BITS) as usize - 1;
                let mut i = Self::home(&self.log[l].fp, mask);
                while t[i] != 0 {
                    i = (i + 1) & mask;
                }
                t[i] = slot;
            }
        }
        self.table = t;
    }

    /// Insert or meet a state. Returns its local index and whether it is new.
    fn insert(&mut self, fp: Fp, parent: u64, key: Fp, state: S) -> (u32, bool) {
        match self.find(&fp) {
            Ok(l) => {
                if l >= self.level_start {
                    let j = (l - self.level_start) as usize;
                    if key < self.next[j].1 {
                        self.next[j] = (state, key);
                        self.log[l as usize].parent = parent;
                    }
                }
                (l, false)
            }
            Err(mut slot) => {
                if (self.log.len() + 1) * 5 > self.table.len() * 4 {
                    self.grow();
                    slot = self.find(&fp).expect_err("fingerprint appeared during growth");
                }
                let l = self.log.len();
                assert!((l as u64) < LOCAL_BITS - 1, "fingerprint store shard overflow");
                if self.log.len() == self.log.capacity() {
                    self.log.reserve_exact((l / 8).max(1024));
                }
                self.table[slot] = ((fp[1] >> 32) << 32) | (l as u64 + 1);
                self.log.push(Entry { fp, parent });
                self.next.push((state, key));
                (l as u32, true)
            }
        }
    }
}

struct Item<S> {
    s: S,
    r: u64,
    fp: Fp,
}

#[derive(Clone, Copy, Debug)]
enum Viol {
    /// The state itself violates (invariant, deadlock).
    State(u64),
    /// The transition to successor number `.1` of the state violates (action property).
    Step(u64, u32),
}

#[derive(Clone, Copy, Debug)]
struct Cand {
    key: (u32, Fp, u32),
    v: Viol,
}

struct Local {
    generated: u64,
    cands: Vec<Option<Cand>>,
    nodes: Vec<NodeRec>,
    edges: Vec<EdgeRec>,
    classes: HashMap<&'static str, u8>,
    err: Option<String>,
}

impl Local {
    fn cand(&mut self, k: usize, c: Cand) {
        if self.cands[k].is_none_or(|o| c.key < o.key) {
            self.cands[k] = Some(c);
        }
    }
}

struct Ctx<'a, M: Model> {
    m: &'a M,
    sel: &'a Sel<M>,
    opts: &'a Options,
    start: Instant,
    shards: Vec<Mutex<Shard<M::State>>>,
    mask: usize,
    distinct: AtomicU64,
    stop: AtomicBool,
    limit: Mutex<Option<String>>,
    classes: Mutex<Vec<&'static str>>,
    live: bool,
    nslots: usize,
}

impl<M: Model> Ctx<'_, M> {
    fn hit(&self, what: &str) {
        let mut l = self.limit.lock().unwrap();
        if l.is_none() {
            *l = Some(what.to_string());
        }
        self.stop.store(true, Relaxed);
    }

    fn insert(&self, fp: Fp, parent: u64, key: Fp, s: M::State) -> u64 {
        let si = fp[0] as usize & self.mask;
        let (l, new) = self.shards[si].lock().unwrap().insert(fp, parent, key, s);
        if new {
            let d = self.distinct.fetch_add(1, Relaxed) + 1;
            if self.opts.max_states.is_some_and(|mx| d > mx) {
                self.hit("max-states");
            }
        }
        ((si as u64) << 32) | l as u64
    }

    fn class_of(&self, name: Option<&'static str>, loc: &mut Local) -> u8 {
        let Some(name) = name else { return NO_CLASS };
        if let Some(&c) = loc.classes.get(name) {
            return c;
        }
        let mut names = self.classes.lock().unwrap();
        let c = match names.iter().position(|n| *n == name) {
            Some(i) => i as u8,
            None => {
                if names.len() >= live::MAX_CLASSES {
                    loc.err = Some(format!("more than {} fairness classes", live::MAX_CLASSES));
                    return NO_CLASS;
                }
                names.push(name);
                (names.len() - 1) as u8
            }
        };
        loc.classes.insert(name, c);
        c
    }

    fn take_frontier(&self) -> Vec<Item<M::State>> {
        let mut f = Vec::new();
        for (si, sh) in self.shards.iter().enumerate() {
            let mut sh = sh.lock().unwrap();
            let start = sh.level_start as usize;
            let next = std::mem::take(&mut sh.next);
            f.reserve(next.len());
            for (j, (s, _)) in next.into_iter().enumerate() {
                let l = start + j;
                f.push(Item { s, r: ((si as u64) << 32) | l as u64, fp: sh.log[l].fp });
            }
            sh.level_start = sh.log.len() as u32;
        }
        f
    }

    fn work(&self, frontier: &[Item<M::State>], depth: u32, active: &[bool], cursor: &AtomicUsize) -> Local {
        let mut loc = Local {
            generated: 0,
            cands: vec![None; self.nslots],
            nodes: Vec::new(),
            edges: Vec::new(),
            classes: HashMap::new(),
            err: None,
        };
        let mut out = Vec::new();
        loop {
            if self.stop.load(Relaxed) {
                break;
            }
            if self.opts.timeout.is_some_and(|t| self.start.elapsed() >= t) {
                self.hit("timeout");
                break;
            }
            let i = cursor.fetch_add(CHUNK, Relaxed);
            if i >= frontier.len() {
                break;
            }
            for it in &frontier[i..(i + CHUNK).min(frontier.len())] {
                self.expand(it, depth, active, &mut loc, &mut out);
            }
        }
        loc
    }

    fn expand(
        &self,
        it: &Item<M::State>,
        depth: u32,
        active: &[bool],
        loc: &mut Local,
        out: &mut Vec<(M::Action, M::State)>,
    ) {
        let m = self.m;
        let s = &it.s;
        for &(k, f) in &self.sel.invs {
            if active[k] && !f(m, s) {
                loc.cand(k, Cand { key: (depth, it.fp, 0), v: Viol::State(it.r) });
            }
        }
        out.clear();
        m.next(s, out);
        loc.generated += out.len() as u64;
        if out.is_empty()
            && let Some(k) = self.sel.deadlock
            && active[k]
            && !m.terminal(s)
        {
            loc.cand(k, Cand { key: (depth, it.fp, 0), v: Viol::State(it.r) });
        }
        let mut enabled = 0u64;
        for (i, (a, t)) in out.drain(..).enumerate() {
            for &(k, f) in &self.sel.acts {
                if active[k] && !f(m, s, &a, &t) {
                    loc.cand(k, Cand { key: (depth + 1, it.fp, i as u32), v: Viol::Step(it.r, i as u32) });
                }
            }
            let fp = fingerprint(&m.canonical(&t));
            if self.live {
                // A successor equal to the state is a TLA+ stuttering step: it neither enables nor takes a class.
                let real = t != *s;
                let class = if real { self.class_of(m.fairness(&a), loc) } else { NO_CLASS };
                let dst = self.insert(fp, it.r, it.fp, t);
                if real {
                    if class != NO_CLASS {
                        enabled |= 1u64 << class;
                    }
                    loc.edges.push(EdgeRec { src: it.r, dst, class });
                }
            } else {
                self.insert(fp, it.r, it.fp, t);
            }
        }
        if self.live {
            let mut pq = 0u64;
            for (j, &(_, p, q)) in self.sel.leads.iter().enumerate() {
                if p(m, s) {
                    pq |= 1 << (2 * j);
                }
                if q(m, s) {
                    pq |= 1 << (2 * j + 1);
                }
            }
            loc.nodes.push(NodeRec { r: it.r, pq, enabled, depth });
        }
    }
}

pub(crate) fn run<M: Model>(
    m: &M,
    sel: &Sel<M>,
    nslots: usize,
    opts: &Options,
    start: Instant,
) -> (Vec<Outcome<M>>, Stats) {
    let workers = opts.workers.max(1);
    let nshards = (workers * 64).next_power_of_two().clamp(64, 4096);
    let ctx = Ctx {
        m,
        sel,
        opts,
        start,
        shards: (0..nshards).map(|_| Mutex::new(Shard::new())).collect(),
        mask: nshards - 1,
        distinct: AtomicU64::new(0),
        stop: AtomicBool::new(false),
        limit: Mutex::new(None),
        classes: Mutex::new(Vec::new()),
        live: !sel.leads.is_empty(),
        nslots,
    };
    let inits = m.init();
    let mut generated = inits.len() as u64;
    for (i, s) in inits.into_iter().enumerate() {
        let fp = fingerprint(&m.canonical(&s));
        ctx.insert(fp, NONE, [i as u64, 0], s);
    }
    let mut found: Vec<Option<Cand>> = vec![None; nslots];
    let mut nodes: Vec<NodeRec> = Vec::new();
    let mut edges: Vec<Vec<EdgeRec>> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    let mut depth = 0u32;
    let mut max_depth = 0u32;
    let mut exhausted = false;
    let safety = sel.safety_slots();
    loop {
        if opts.timeout.is_some_and(|t| start.elapsed() >= t) {
            ctx.hit("timeout");
        }
        if ctx.stop.load(Relaxed) {
            break;
        }
        let frontier = ctx.take_frontier();
        if frontier.is_empty() {
            exhausted = true;
            break;
        }
        max_depth = depth;
        let active: Vec<bool> = found.iter().map(|f| f.is_none()).collect();
        let cursor = AtomicUsize::new(0);
        let locals: Vec<Local> = std::thread::scope(|sc| {
            let hs: Vec<_> = (0..workers).map(|_| sc.spawn(|| ctx.work(&frontier, depth, &active, &cursor))).collect();
            hs.into_iter().map(|h| h.join().unwrap_or_else(|e| resume_unwind(e))).collect()
        });
        drop(frontier);
        for loc in locals {
            generated += loc.generated;
            for (k, c) in loc.cands.iter().enumerate() {
                if let Some(c) = c
                    && active[k]
                    && found[k].is_none_or(|f| c.key < f.key)
                {
                    found[k] = Some(*c);
                }
            }
            if ctx.live {
                nodes.extend(loc.nodes);
                edges.push(loc.edges);
            }
            errors.extend(loc.err);
        }
        if !errors.is_empty() {
            break;
        }
        if ctx.stop.load(Relaxed) {
            break;
        }
        if sel.leads.is_empty() && !safety.is_empty() && safety.iter().all(|&k| found[k].is_some()) {
            break;
        }
        depth += 1;
    }

    let limit = ctx.limit.lock().unwrap().clone();
    let classes = ctx.classes.lock().unwrap().clone();
    let shards: Vec<Shard<M::State>> = ctx.shards.into_iter().map(|s| s.into_inner().unwrap()).collect();
    let distinct: u64 = shards.iter().map(|s| s.log.len() as u64).sum();
    let stats = Stats {
        distinct,
        generated,
        depth: max_depth,
        workers,
        simulated: false,
        complete: exhausted,
        limit: limit.clone(),
        ..Stats::default()
    };

    let mut outs: Vec<Outcome<M>> = (0..nslots).map(|_| Outcome::Holds).collect();
    if let Some(e) = errors.first() {
        for o in outs.iter_mut() {
            *o = Outcome::Error(e.clone());
        }
        return (outs, stats);
    }
    for &k in &safety {
        outs[k] = match found[k] {
            Some(c) => match counterexample(m, sel, &shards, k, c) {
                Ok(t) => Outcome::Violated(t),
                Err(e) => Outcome::Error(e),
            },
            None if exhausted => Outcome::Holds,
            None => Outcome::Unknown,
        };
    }
    if !sel.leads.is_empty() {
        if !exhausted {
            for &(k, _, _) in &sel.leads {
                outs[k] = Outcome::Unknown;
            }
        } else {
            let logs: Vec<&[Entry]> = shards.iter().map(|s| s.log.as_slice()).collect();
            match live::Graph::build(&logs, nodes, edges) {
                Err(e) => {
                    for &(k, _, _) in &sel.leads {
                        outs[k] = Outcome::Error(e.clone());
                    }
                }
                Ok(g) => {
                    let mut order: Vec<usize> = (0..classes.len()).collect();
                    order.sort_by_key(|&c| classes[c]);
                    for (j, &(k, _, _)) in sel.leads.iter().enumerate() {
                        outs[k] = match g.analyze(j, &order) {
                            None => Outcome::Holds,
                            Some(lasso) => match lasso_trace(m, &g, &classes, &lasso) {
                                Ok(t) => Outcome::Violated(t),
                                Err(e) => Outcome::Error(e),
                            },
                        };
                    }
                }
            }
        }
    }
    (outs, stats)
}

fn path_fps<S>(shards: &[Shard<S>], mut r: u64) -> Vec<Fp> {
    let mut v = Vec::new();
    while r != NONE {
        let e = &shards[(r >> 32) as usize].log[(r & LOCAL_BITS) as usize];
        v.push(e.fp);
        r = e.parent;
    }
    v.reverse();
    v
}

fn canon_fp<M: Model>(m: &M, s: &M::State) -> Fp {
    fingerprint(&m.canonical(s))
}

/// Replay a path of fingerprints from the initial states: the first matching initial state, then the first
/// matching successor in `next` order. This reproduces the stored representatives exactly.
pub(crate) fn replay<M: Model>(m: &M, fps: &[Fp]) -> Result<Vec<Step<M>>, String> {
    let mut steps: Vec<Step<M>> = Vec::with_capacity(fps.len());
    let Some(first) = fps.first() else { return Ok(steps) };
    let cur = m
        .init()
        .into_iter()
        .find(|s| canon_fp(m, s) == *first)
        .ok_or("trace replay failed: initial state not found (is the model deterministic?)")?;
    steps.push(Step { action: None, state: cur });
    let mut out = Vec::new();
    for (i, fp) in fps.iter().enumerate().skip(1) {
        out.clear();
        m.next(&steps.last().unwrap().state, &mut out);
        let (a, t) = out
            .drain(..)
            .find(|(_, t)| canon_fp(m, t) == *fp)
            .ok_or_else(|| format!("trace replay failed at step {i} (is the model deterministic?)"))?;
        steps.push(Step { action: Some(a), state: t });
    }
    Ok(steps)
}

fn counterexample<M: Model>(m: &M, sel: &Sel<M>, shards: &[Shard<M::State>], k: usize, c: Cand) -> Result<Trace<M>, String> {
    let r = match c.v {
        Viol::State(r) | Viol::Step(r, _) => r,
    };
    let mut steps = replay(m, &path_fps(shards, r))?;
    if let Viol::Step(_, i) = c.v {
        let f = sel.acts.iter().find(|x| x.0 == k).map(|x| x.1).ok_or("internal: action slot")?;
        let s = &steps.last().unwrap().state;
        let mut out = Vec::new();
        m.next(s, &mut out);
        let mut pick = None;
        if let Some((a, t)) = out.get(i as usize)
            && !f(m, s, a, t)
        {
            pick = Some(i as usize);
        }
        let pick = pick
            .or_else(|| out.iter().position(|(a, t)| !f(m, s, a, t)))
            .ok_or("trace replay failed: violating transition not found (is the model deterministic?)")?;
        let (a, t) = out.swap_remove(pick);
        steps.push(Step { action: Some(a), state: t });
    }
    Ok(Trace { steps, loop_start: None, stutter: false })
}

fn lasso_trace<M: Model>(m: &M, g: &live::Graph, classes: &[&'static str], l: &live::Lasso) -> Result<Trace<M>, String> {
    let mut fps = Vec::new();
    let mut v = l.start;
    while v != u32::MAX {
        fps.push(g.fps[v as usize]);
        v = g.parent[v as usize];
    }
    fps.reverse();
    let mut steps = replay(m, &fps)?;
    let class_idx = |a: &M::Action| match m.fairness(a) {
        None => NO_CLASS,
        Some(n) => classes.iter().position(|c| *c == n).map_or(NO_CLASS, |i| i as u8),
    };
    let mut loop_start = steps.len() - 1;
    let mut out = Vec::new();
    for (idx, &(node, cls)) in l.path.iter().chain(l.cycle.iter()).enumerate() {
        if idx == l.path.len() {
            loop_start = steps.len() - 1;
        }
        let target = g.fps[node as usize];
        let cur = &steps.last().unwrap().state;
        out.clear();
        m.next(cur, &mut out);
        let (a, t) = out
            .drain(..)
            .find(|(a, t)| t != cur && class_idx(a) == cls && canon_fp(m, t) == target)
            .ok_or("lasso replay failed (is the model deterministic?)")?;
        steps.push(Step { action: Some(a), state: t });
    }
    if l.cycle.is_empty() {
        loop_start = steps.len() - 1;
    }
    Ok(Trace { steps, loop_start: Some(loop_start), stutter: l.cycle.is_empty() })
}
