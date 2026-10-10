//! Random simulation: walks from random initial states, choosing a random successor at each step.
//!
//! Walk `t` uses `Rng::for_trace(seed, t)`, so a walk does not depend on the worker that runs it. The reported
//! violation of a property is the one with the smallest (walk number, step); walks with a larger number than
//! every property's best violation are skipped. Hence results are reproducible by seed for any worker count
//! (unless a limit stops the run).
//!
//! LeadsTo in simulation only reports sound violations: a state where P /\ ~Q held earlier on the walk (and Q
//! not since) and where no fairness class is enabled, so stuttering there forever is a fair behavior.

use crate::{Model, Options, Outcome, Rng, Sel, SimOptions, Stats, Step, Trace};
use std::panic::resume_unwind;
use std::sync::Mutex;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::Relaxed};
use std::time::Instant;

struct Best<M: Model> {
    key: (u64, u32),
    trace: Trace<M>,
}

struct Local<M: Model> {
    best: Vec<Option<Best<M>>>,
    /// (walk number, states visited, steps) of every walk this worker ran.
    walks: Vec<(u64, u64, u32)>,
}

pub(crate) fn run<M: Model>(
    m: &M,
    sel: &Sel<M>,
    nslots: usize,
    opts: &Options,
    sim: &SimOptions,
    start: Instant,
) -> (Vec<Outcome<M>>, Stats) {
    let workers = opts.workers.max(1);
    let inits = m.init();
    let slots = sel.all_slots();
    let best_t: Vec<AtomicU64> = (0..nslots).map(|_| AtomicU64::new(u64::MAX)).collect();
    let cursor = AtomicU64::new(0);
    let stop = AtomicBool::new(false);
    let limit: Mutex<Option<String>> = Mutex::new(None);
    let sampled = AtomicU64::new(0);
    let hit = |what: &str| {
        let mut l = limit.lock().unwrap();
        if l.is_none() {
            *l = Some(what.to_string());
        }
        stop.store(true, Relaxed);
    };

    let walk = |t: u64, loc: &mut Local<M>| {
        let mut rng = Rng::for_trace(sim.seed, t);
        let s0 = inits[rng.below(inits.len() as u64) as usize].clone();
        let mut tr: Vec<Step<M>> = vec![Step { action: None, state: s0 }];
        let mut pending = vec![false; sel.leads.len()];
        let mut done = vec![false; nslots];
        let mut out = Vec::new();
        let mut record = |k: usize, step: u32, trace: &dyn Fn() -> Trace<M>, done: &mut Vec<bool>| {
            if done[k] {
                return;
            }
            done[k] = true;
            if t > best_t[k].load(Relaxed) {
                return;
            }
            best_t[k].fetch_min(t, Relaxed);
            if loc.best[k].as_ref().is_none_or(|b| (t, step) < b.key) {
                loc.best[k] = Some(Best { key: (t, step), trace: trace() });
            }
        };
        let mut d = 0usize;
        loop {
            let s = &tr[d].state;
            for &(k, f) in &sel.invs {
                if !done[k] && !f(m, s) {
                    record(k, d as u32, &|| Trace { steps: tr.clone(), loop_start: None, stutter: false }, &mut done);
                }
            }
            for (j, &(_, p, q)) in sel.leads.iter().enumerate() {
                if q(m, s) {
                    pending[j] = false;
                } else if p(m, s) {
                    pending[j] = true;
                }
            }
            if d as u32 >= sim.depth {
                break;
            }
            out.clear();
            m.next(s, &mut out);
            if !sel.leads.is_empty() {
                let fair_enabled = out.iter().any(|(a, t)| m.fairness(a).is_some() && t != s);
                if !fair_enabled {
                    for (j, &(k, _, _)) in sel.leads.iter().enumerate() {
                        if pending[j] && !done[k] {
                            record(k, d as u32, &|| Trace { steps: tr.clone(), loop_start: Some(d), stutter: true }, &mut done);
                        }
                    }
                }
            }
            if out.is_empty() {
                if let Some(k) = sel.deadlock
                    && !done[k]
                    && !m.terminal(s)
                {
                    record(k, d as u32, &|| Trace { steps: tr.clone(), loop_start: None, stutter: false }, &mut done);
                }
                break;
            }
            let i = rng.below(out.len() as u64) as usize;
            let (a, nt) = out.swap_remove(i);
            for &(k, f) in &sel.acts {
                if !done[k] && !f(m, s, &a, &nt) {
                    let mk = || {
                        let mut steps = tr.clone();
                        steps.push(Step { action: Some(a.clone()), state: nt.clone() });
                        Trace { steps, loop_start: None, stutter: false }
                    };
                    record(k, d as u32 + 1, &mk, &mut done);
                }
            }
            tr.push(Step { action: Some(a), state: nt });
            d += 1;
        }
        loc.walks.push((t, d as u64 + 1, d as u32));
        if let Some(mx) = opts.max_states
            && sampled.fetch_add(d as u64 + 1, Relaxed) + d as u64 + 1 > mx
        {
            hit("max-states");
        }
    };

    let locals: Vec<Local<M>> = if inits.is_empty() {
        Vec::new()
    } else {
        std::thread::scope(|sc| {
            let hs: Vec<_> = (0..workers)
                .map(|_| {
                    sc.spawn(|| {
                        let mut loc = Local { best: (0..nslots).map(|_| None).collect(), walks: Vec::new() };
                        loop {
                            if stop.load(Relaxed) {
                                break;
                            }
                            if opts.timeout.is_some_and(|to| start.elapsed() >= to) {
                                hit("timeout");
                                break;
                            }
                            let t = cursor.fetch_add(1, Relaxed);
                            if t >= sim.traces {
                                break;
                            }
                            if !slots.is_empty() && slots.iter().all(|&k| best_t[k].load(Relaxed) < t) {
                                break;
                            }
                            walk(t, &mut loc);
                        }
                        loc
                    })
                })
                .collect();
            hs.into_iter().map(|h| h.join().unwrap_or_else(|e| resume_unwind(e))).collect()
        })
    };

    let mut best: Vec<Option<Best<M>>> = (0..nslots).map(|_| None).collect();
    let mut stats = Stats { workers, simulated: true, ..Stats::default() };
    let mut walks = Vec::new();
    for loc in locals {
        walks.extend(loc.walks);
        for (k, b) in loc.best.into_iter().enumerate() {
            if let Some(b) = b
                && best[k].as_ref().is_none_or(|o| b.key < o.key)
            {
                best[k] = Some(b);
            }
        }
    }
    // When every property was violated, walks after the last needed one may or may not have run depending on
    // the schedule; count only walks up to that one so the statistics are reproducible too.
    let cutoff = if !slots.is_empty() && slots.iter().all(|&k| best[k].is_some()) {
        slots.iter().map(|&k| best[k].as_ref().unwrap().key.0).max().unwrap()
    } else {
        u64::MAX
    };
    for &(_, states, steps) in walks.iter().filter(|w| w.0 <= cutoff) {
        stats.generated += states;
        stats.traces += 1;
        stats.depth = stats.depth.max(steps);
    }
    stats.limit = limit.into_inner().unwrap();
    stats.complete = stats.limit.is_none();
    let outs = (0..nslots)
        .map(|k| match best[k].take() {
            Some(b) => Outcome::Violated(b.trace),
            None if stats.limit.is_some() => Outcome::Unknown,
            None => Outcome::Holds,
        })
        .collect();
    (outs, stats)
}
