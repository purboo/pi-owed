//! a3_auth: port of `PiDagAuth3.tla` (formal/reference/a3/PiDagAuth3.tla, module sha256 4e33cdf2…).
//!
//! One `State` field per TLA+ variable (family, log, pending, edges, accepted, invalid, key, content, slots,
//! merged, lawView, conflict, resolver, lawWinner, lawValue, everSlots, authors), so distinct-state counts are
//! comparable with TLC. The two scopes use different TLA+ types for some variables; the Rust field holds both
//! (injectively within one scope, the unused part stays constant):
//!   key, content, resolver, lawWinner, lawValue: scenarios use index 0 only; free: [n1, n2];
//!   slots: scenarios: `slots[0]` = the set ⊆ {W1, W2} as a principal bitmask; free: holder per item or NONE;
//!   lawView: scenarios: `law_view[0][P1|P2]`; free: `law_view[n][p]`;
//!   conflict: scenarios: 0/1 (BOOLEAN); free: a scope bitmask (set of items).
//! Sets of log positions are bitmasks (bit i-1 = position i); principals and scopes are small bitmasks.
//!
//! `next` lists successors in TLC's order (TLC splits `\E e \in FreeEvents` into one action per event in the
//! set's normalized order, then the scenario disjunct with `pending` in normalized order, then `Terminal`):
//! records compare field by field in field-name order (from, node, scope, to, type, value), model values by
//! name (Owner < P1 < P2 < W1 < W2), strings lexicographically, sets by size then elements. The order only
//! matters for the TLC-order reference count (`tlc_order` in `a3::tlc`); the engine's results do not depend on it.

use mc::{Consts, DynModel, Model, ModelInfo, Property};
use std::fmt;

pub const OWNER: u8 = 0;
pub const P1: u8 = 1;
pub const P2: u8 = 2;
pub const W1: u8 = 3;
pub const W2: u8 = 4;
/// "none" (no principal).
pub const NONE: u8 = 5;
const NAMES: [&str; 6] = ["Owner", "P1", "P2", "W1", "W2", "none"];
const WRITERS: u8 = (1 << W1) | (1 << W2);
const PARENTS: u8 = (1 << P1) | (1 << P2);
/// Scope bitmasks: bit 0 = "n1", bit 1 = "n2".
const N1: u8 = 1;
const N2: u8 = 2;
const SCOPES: u8 = 3;
/// `value` field: integers 0/1 as themselves, the strings "future"/"retro" as codes above them.
pub const FUTURE: i8 = 10;
pub const RETRO: i8 = 11;

/// Event types, declared in lexicographic order of their TLA+ strings (TLC's normalized order).
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug)]
pub enum Ty {
    Acquire,
    Closure,
    Defer,
    Downgrade,
    Grant,
    Law,
    Merge,
    Related,
    Release,
    Revoke,
    Unrelated,
    Waive,
}

/// `E(ty, a, b, s, n, v) == [type |-> ty, from |-> a, to |-> b, scope |-> s, node |-> n, value |-> v]`;
/// `node` is 0 for "n1", 1 for "n2".
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct Ev {
    pub ty: Ty,
    pub from: u8,
    pub to: u8,
    pub scope: u8,
    pub node: u8,
    pub value: i8,
}

impl Ev {
    /// TLC's normalized order of these records: fields in name order from, node, scope, to, type, value; a set of
    /// strings by cardinality, then elements ({} < {n1} < {n2} < {n1,n2}, which is the bitmask order).
    fn tlc_key(&self) -> (u8, u8, u8, u8, Ty, i8) {
        (self.from, self.node, self.scope, self.to, self.ty, self.value)
    }
}

fn scope_str(s: u8) -> &'static str {
    ["{}", "{n1}", "{n2}", "{n1,n2}"][s as usize]
}

impl fmt::Debug for Ev {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        let v = match self.value {
            FUTURE => "future".to_string(),
            RETRO => "retro".to_string(),
            v => v.to_string(),
        };
        write!(
            f,
            "{:?}({}->{} scope={} node=n{} value={})",
            self.ty,
            NAMES[self.from as usize],
            NAMES[self.to as usize],
            scope_str(self.scope),
            self.node + 1,
            v
        )
    }
}

/// A log entry: the event plus the item's `key` and `content` at append time.
#[derive(Clone, Copy, PartialEq, Eq, Hash)]
pub struct Entry {
    pub ev: Ev,
    pub key: u8,
    pub content: u8,
}

impl fmt::Debug for Entry {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{:?} key={} content={}", self.ev, self.key, self.content)
    }
}

/// The 18 scenario families in TLC's normalized (lexicographic) order, then "free".
#[derive(Clone, Copy, PartialEq, Eq, Hash, PartialOrd, Ord, Debug)]
pub enum Family {
    Author,
    Chain,
    Cross,
    DeferWriter,
    Deferred,
    Future,
    Good,
    Keys,
    Laws,
    Past,
    Permission,
    Retro,
    Revival,
    SameLaw,
    Scope,
    SelfF,
    Speech,
    State,
    Free,
}

const FAMILIES: [Family; 18] = [
    Family::Author,
    Family::Chain,
    Family::Cross,
    Family::DeferWriter,
    Family::Deferred,
    Family::Future,
    Family::Good,
    Family::Keys,
    Family::Laws,
    Family::Past,
    Family::Permission,
    Family::Retro,
    Family::Revival,
    Family::SameLaw,
    Family::Scope,
    Family::SelfF,
    Family::Speech,
    Family::State,
];

#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct State {
    pub family: Family,
    pub log: Vec<Entry>,
    /// Scenario `pending` as a bitmask over the family's events (sorted as in `Auth::events`).
    pub pending: u8,
    pub edges: u32,
    pub accepted: u32,
    pub invalid: u32,
    pub key: [u8; 2],
    pub content: [u8; 2],
    pub slots: [u8; 2],
    pub merged: bool,
    pub law_view: [[i8; 5]; 2],
    pub conflict: u8,
    pub resolver: [u8; 2],
    pub law_winner: [u8; 2],
    pub law_value: [i8; 2],
    pub ever_slots: u8,
    pub authors: [u8; 2],
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Action {
    /// `Advance` with the chosen event (`\E e \in FreeEvents` / `\E e \in pending`).
    Advance(Ev),
    /// `Terminal == Done /\ UNCHANGED vars` (an explicit stutter).
    Terminal,
}

/// The ablations `Drop(c) == Mode = "a3-" \o c`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Drop {
    Issue,
    Scope,
    Continuous,
    Writers,
    Past,
    Author,
    Permission,
    Key,
    State,
    Conflict,
    Same,
    Retro,
    Future,
}

pub const MODES: &[&str] = &[
    "a3",
    "a22",
    "a3-issue",
    "a3-scope",
    "a3-continuous",
    "a3-writers",
    "a3-past",
    "a3-author",
    "a3-permission",
    "a3-key",
    "a3-state",
    "a3-conflict",
    "a3-same",
    "a3-retro",
    "a3-future",
];

fn parse_mode(mode: &str) -> Result<(bool, Option<Drop>), String> {
    Ok(match mode {
        "a3" => (false, None),
        "a22" => (true, None),
        _ => {
            let d = match mode.strip_prefix("a3-") {
                Some("issue") => Drop::Issue,
                Some("scope") => Drop::Scope,
                Some("continuous") => Drop::Continuous,
                Some("writers") => Drop::Writers,
                Some("past") => Drop::Past,
                Some("author") => Drop::Author,
                Some("permission") => Drop::Permission,
                Some("key") => Drop::Key,
                Some("state") => Drop::State,
                Some("conflict") => Drop::Conflict,
                Some("same") => Drop::Same,
                Some("retro") => Drop::Retro,
                Some("future") => Drop::Future,
                _ => return Err(format!("unknown mode {mode}")),
            };
            (false, Some(d))
        }
    })
}

pub struct Auth {
    /// `Old == Mode = "a22"`.
    pub old: bool,
    pub drop: Option<Drop>,
    /// `Scope = "free"`.
    pub free: bool,
    pub max_log: usize,
    /// Events(f) per scenario family (sorted, TLC order), and FreeEvents (sorted).
    events: Vec<Vec<Ev>>,
    free_events: Vec<Ev>,
}

fn e(ty: Ty, a: u8, b: u8, s: u8, n: u8, v: i8) -> Ev {
    Ev { ty, from: a, to: b, scope: s, node: n, value: v }
}
fn g(a: u8, b: u8, s: u8) -> Ev {
    e(Ty::Grant, a, b, s, 0, 0)
}
/// `D(ty,a,n) == E(ty,a,Owner,{n},n,0)`.
fn d(ty: Ty, a: u8, n: u8) -> Ev {
    e(ty, a, OWNER, 1 << n, n, 0)
}
fn r(a: u8, s: i8) -> Ev {
    e(Ty::Revoke, OWNER, a, 0, 0, s)
}
fn law(a: u8, v: i8) -> Ev {
    e(Ty::Law, a, OWNER, N1, 0, v)
}
fn edit(ty: Ty) -> Ev {
    e(ty, OWNER, OWNER, 0, 0, 0)
}

fn family_events(f: Family) -> Vec<Ev> {
    use Family as F;
    use Ty::*;
    let mut v = match f {
        F::Speech => vec![g(W1, W2, SCOPES), g(OWNER, W1, SCOPES), d(Waive, W2, 0)],
        F::Revival => vec![g(OWNER, P1, SCOPES), g(P1, P2, SCOPES), r(P1, FUTURE), g(OWNER, P1, N1), d(Waive, P2, 0)],
        F::Chain => vec![g(OWNER, P1, SCOPES), g(P1, P2, SCOPES), g(P2, W1, SCOPES), r(P1, RETRO), d(Waive, P2, 1)],
        F::Scope => vec![g(OWNER, P1, N1), g(P1, P2, SCOPES), d(Waive, P2, 1)],
        F::Cross => vec![g(OWNER, W1, SCOPES), d(Waive, W1, 1)],
        F::Past => vec![g(OWNER, W1, SCOPES), edit(Release), d(Waive, W1, 1)],
        F::SelfF => vec![g(OWNER, W1, SCOPES), d(Downgrade, W1, 0)],
        F::Permission => vec![g(OWNER, P1, N1), d(Downgrade, P1, 1)],
        F::DeferWriter => vec![g(OWNER, W1, SCOPES), d(Defer, W1, 1)],
        F::Author => vec![d(Waive, OWNER, 0)],
        F::Laws => vec![g(OWNER, P1, SCOPES), g(OWNER, P2, SCOPES), law(P1, 0), law(P2, 1)],
        F::SameLaw => vec![g(OWNER, P1, SCOPES), law(P1, 0), law(P1, 1)],
        F::Keys => vec![d(Waive, OWNER, 0), edit(Unrelated), edit(Closure), edit(Related)],
        F::State => vec![d(Waive, OWNER, 0), d(Downgrade, OWNER, 0), d(Defer, OWNER, 0)],
        F::Retro => vec![g(OWNER, P1, SCOPES), g(P1, P2, SCOPES), d(Waive, P2, 0), r(P1, RETRO)],
        F::Future => vec![g(OWNER, P1, SCOPES), g(P1, P2, SCOPES), d(Waive, P2, 0), r(P1, FUTURE)],
        F::Good => vec![edit(Merge)],
        F::Deferred => vec![d(Defer, OWNER, 0), edit(Merge)],
        F::Free => vec![],
    };
    v.sort_by_key(|x| x.tlc_key());
    v.dedup();
    v
}

fn free_events() -> Vec<Ev> {
    use Ty::*;
    let mut v = Vec::new();
    for a in 0..5 {
        for b in 1..5 {
            for s in 1..=3 {
                v.push(g(a, b, s));
            }
            for val in [FUTURE, RETRO] {
                v.push(e(Revoke, a, b, 0, 0, val));
            }
        }
        for ty in [Waive, Downgrade, Defer] {
            for n in 0..2 {
                v.push(d(ty, a, n));
            }
        }
        for n in 0..2 {
            for val in [0, 1] {
                v.push(e(Law, a, OWNER, 1 << n, n, val));
            }
            for ty in [Unrelated, Related, Closure, Acquire, Release, Merge] {
                v.push(e(ty, a, OWNER, 0, n, 0));
            }
        }
    }
    v.sort_by_key(|x| x.tlc_key());
    v.dedup();
    assert_eq!(v.len(), 210);
    v
}

fn bit(i: usize) -> u32 {
    1 << i
}
fn has(set: u32, i: usize) -> bool {
    set & bit(i) != 0
}
fn pbit(p: u8) -> u8 {
    1 << p
}

// --- Guard implementation: Close / Rights / Prune over the current edge set -----------------------------------

/// `Close(es,l,s,k)` as a principal bitmask (exactly k rounds, as the recursive definition).
fn close(es: u32, l: &[Entry], s: u8, k: usize) -> u8 {
    let mut prior = pbit(OWNER);
    for _ in 0..k {
        let mut nx = prior;
        for (j, en) in l.iter().enumerate() {
            if has(es, j) && prior & pbit(en.ev.from) != 0 && en.ev.scope & s != 0 {
                nx |= pbit(en.ev.to);
            }
        }
        prior = nx;
    }
    prior
}

/// `Rights(p,es,l) == {s \in Scopes : p \in Close(es,l,s,5)}`.
fn rights(p: u8, es: u32, l: &[Entry]) -> u8 {
    let mut out = 0;
    for s in [N1, N2] {
        if close(es, l, s, 5) & pbit(p) != 0 {
            out |= s;
        }
    }
    out
}

/// `Prune(es,l,k)`: k rounds of keeping the edges whose scope is within the issuer's rights.
fn prune(mut es: u32, l: &[Entry], k: usize) -> u32 {
    for _ in 0..k {
        let mut nx = 0;
        for (i, en) in l.iter().enumerate() {
            if has(es, i) && en.ev.scope & !rights(en.ev.from, es, l) == 0 {
                nx |= bit(i);
            }
        }
        es = nx;
    }
    es
}

// --- Independent oracle: Eff(p,t,k) from the raw log ----------------------------------------------------------

/// `Eff(p,t,k)` for every p, t in 1..=len+1 and k in 0..=kmax, computed bottom-up from the definition.
struct Eff {
    tmax: usize,
    data: Vec<u8>,
}

impl Eff {
    fn new(log: &[Entry], kmax: usize) -> Eff {
        let tmax = log.len() + 1;
        let idx = |k: usize, p: usize, t: usize| (k * 5 + p) * (tmax + 1) + t;
        let mut data = vec![0u8; (kmax + 1) * 5 * (tmax + 1)];
        for k in 0..=kmax {
            for t in 1..=tmax {
                data[idx(k, OWNER as usize, t)] = SCOPES;
            }
        }
        for k in 1..=kmax {
            for p in 1..5u8 {
                for t in 1..=tmax {
                    let mut acc = 0u8;
                    for j in 1..t {
                        let en = &log[j - 1].ev;
                        if en.ty != Ty::Grant || en.to != p {
                            continue;
                        }
                        let fr = en.from as usize;
                        if en.scope & !data[idx(k - 1, fr, j)] != 0 {
                            continue;
                        }
                        if !((j + 1)..=t).all(|u| en.scope & !data[idx(k - 1, fr, u)] == 0) {
                            continue;
                        }
                        let revoked = ((j + 1)..t).any(|rr| {
                            let x = &log[rr - 1].ev;
                            x.ty == Ty::Revoke && x.from == OWNER && x.to == p
                        });
                        if revoked {
                            continue;
                        }
                        acc |= en.scope;
                    }
                    data[idx(k, p as usize, t)] = acc;
                }
            }
        }
        Eff { tmax, data }
    }
    /// Eff(p, t, kmax)
    fn get(&self, p: u8, t: usize, k: usize) -> u8 {
        debug_assert!(t >= 1 && t <= self.tmax);
        self.data[(k * 5 + p as usize) * (self.tmax + 1) + t]
    }
}

impl Auth {
    pub fn new(mode: &str, free: bool, max_log: usize) -> Result<Auth, String> {
        let (old, drop) = parse_mode(mode)?;
        if max_log < 1 {
            return Err("ASSUME MaxLog >= 1".to_string());
        }
        if max_log > 24 {
            return Err("MaxLog above 24 is not supported (log positions are a u32 bitmask)".to_string());
        }
        let mut events = vec![Vec::new(); 19];
        for f in FAMILIES {
            events[f as usize] = family_events(f);
        }
        Ok(Auth { old, drop, free, max_log, events, free_events: free_events() })
    }

    fn dr(&self, c: Drop) -> bool {
        self.drop == Some(c)
    }

    pub fn events(&self, f: Family) -> &[Ev] {
        &self.events[f as usize]
    }

    /// The k bound of the oracle: 5 in the scenarios, MaxLog+1 in free.
    fn kf(&self) -> usize {
        self.max_log + 1
    }

    // --- scenario definitions ---

    fn state_item(s: &State) -> bool {
        matches!(s.family, Family::State | Family::Deferred)
    }
    fn catalog_author(s: &State, n: u8) -> u8 {
        if s.family == Family::Author { OWNER } else { author(n) }
    }
    fn bound(&self, s: &State, i: usize) -> bool {
        let en = &s.log[i];
        if self.old || self.dr(Drop::Key) { en.content == s.content[0] } else { en.key == s.key[0] }
    }
    fn covers(&self, s: &State, i: usize) -> bool {
        has(s.accepted, i) && !has(s.invalid, i) && self.bound(s, i)
    }
    fn waived(&self, s: &State) -> u32 {
        let mut m = 0;
        for i in 0..s.log.len() {
            if self.covers(s, i) && s.log[i].ev.ty != Ty::Defer {
                m |= bit(i);
            }
        }
        m
    }
    fn deferred(&self, s: &State) -> u32 {
        let mut m = 0;
        for i in 0..s.log.len() {
            if self.covers(s, i) && s.log[i].ev.ty == Ty::Defer {
                m |= bit(i);
            }
        }
        m
    }
    /// `Debt # {}` (Debt == IF StateItem /\ Waived={} THEN {<<"I",key>>} ELSE {}).
    fn debt(&self, s: &State) -> bool {
        Self::state_item(s) && self.waived(s) == 0
    }

    fn can_decide(&self, s: &State, ev: &Ev) -> bool {
        let rt = rights(ev.from, s.edges, &s.log);
        let c1 = if (self.old || self.dr(Drop::Permission)) && ev.ty == Ty::Downgrade { rt != 0 } else { rt & (1 << ev.node) != 0 };
        let c2 = (self.old && ev.ty == Ty::Downgrade) || self.dr(Drop::Author) || ev.from != Self::catalog_author(s, ev.node);
        let c3 = if self.old || self.dr(Drop::Writers) {
            true
        } else if self.dr(Drop::Past) {
            s.slots[0] & pbit(ev.from) == 0
        } else {
            WRITERS & pbit(ev.from) == 0
        };
        let c4 = !Self::state_item(s) || ev.ty == Ty::Defer || self.old || self.dr(Drop::State);
        c1 && c2 && c3 && c4
    }

    /// `Step(e)` (scenario); None when not enabled. The caller guarantees `e \in pending`.
    fn step(&self, s: &State, ev: &Ev, pend_bit: u8) -> Option<State> {
        if s.log.len() >= self.max_log {
            return None;
        }
        let deferred_nonempty = self.deferred(s) != 0;
        if !(ev.ty != Ty::Merge || s.family == Family::Good || deferred_nonempty) {
            return None;
        }
        let i = s.log.len();
        let mut l = s.log.clone();
        l.push(Entry { ev: *ev, key: s.key[0], content: s.content[0] });
        let rt = rights(ev.from, s.edges, &s.log);
        let can_grant = (self.old || self.dr(Drop::Issue) || ev.from == OWNER || rt != 0)
            && (self.dr(Drop::Scope) || ev.scope & !rt == 0 || ((self.old || self.dr(Drop::Issue)) && rt == 0));
        let raw = match ev.ty {
            Ty::Grant if can_grant => s.edges | bit(i),
            Ty::Revoke => {
                let mut m = 0;
                for j in 0..s.log.len() {
                    if has(s.edges, j) && s.log[j].ev.to != ev.to {
                        m |= bit(j);
                    }
                }
                m
            }
            _ => s.edges,
        };
        let live = if ev.ty == Ty::Revoke && !self.old && !self.dr(Drop::Continuous) { prune(raw, &l, 5) } else { raw };
        let mut cut = 0u32;
        for j in 0..s.log.len() {
            if has(s.accepted, j) {
                let en = &s.log[j].ev;
                let nb = 1 << en.node;
                if rights(en.from, s.edges, &s.log) & nb != 0 && rights(en.from, live, &l) & nb == 0 {
                    cut |= bit(j);
                }
            }
        }
        let mut lv = s.law_view;
        if ev.ty == Ty::Law && rt & (1 << ev.node) != 0 && PARENTS & pbit(ev.from) != 0 {
            let cur = &mut lv[0][ev.from as usize];
            *cur = if self.dr(Drop::Same) && *cur != -1 { *cur } else { ev.value };
        }
        let clash = lv[0][P1 as usize] != -1 && lv[0][P2 as usize] != -1 && lv[0][P1 as usize] != lv[0][P2 as usize];
        let conflict = clash && !self.old && !self.dr(Drop::Conflict);

        let mut t = s.clone();
        t.log = l;
        t.pending &= !pend_bit;
        t.edges = live;
        if decision(ev) && self.can_decide(s, ev) {
            t.accepted |= bit(i);
        }
        if ev.ty == Ty::Revoke && (ev.value == RETRO || self.dr(Drop::Future)) && !self.dr(Drop::Retro) {
            t.invalid |= cut;
        }
        if matches!(ev.ty, Ty::Related | Ty::Closure) {
            t.key[0] += 1;
        }
        if matches!(ev.ty, Ty::Related | Ty::Unrelated) {
            t.content[0] += 1;
        }
        if ev.ty == Ty::Release {
            t.slots[0] &= !pbit(W1);
        }
        t.merged = s.merged || (ev.ty == Ty::Merge && (s.family == Family::Good || deferred_nonempty));
        t.law_view = lv;
        t.conflict = conflict as u8;
        t.resolver[0] = if conflict { OWNER } else { NONE };
        let changed = lv != s.law_view;
        t.law_winner[0] = if conflict {
            NONE
        } else if changed {
            ev.from
        } else {
            s.law_winner[0]
        };
        t.law_value[0] = if conflict {
            -1
        } else if changed {
            ev.value
        } else {
            s.law_value[0]
        };
        Some(t)
    }

    // --- free definitions ---

    fn free_can_decide(&self, s: &State, ev: &Ev) -> bool {
        let rt = rights(ev.from, s.edges, &s.log);
        let c1 = if (self.old || self.dr(Drop::Permission)) && ev.ty == Ty::Downgrade { rt != 0 } else { rt & (1 << ev.node) != 0 };
        let c2 = (self.old && ev.ty == Ty::Downgrade) || self.dr(Drop::Author) || ev.from != s.authors[ev.node as usize];
        let c3 = self.old || self.dr(Drop::Writers) || s.ever_slots & pbit(ev.from) == 0;
        let c4 = ev.node != 1 || ev.ty == Ty::Defer || self.old || self.dr(Drop::State);
        c1 && c2 && c3 && c4
    }
    fn free_bound(&self, s: &State, i: usize) -> bool {
        let en = &s.log[i];
        let n = en.ev.node as usize;
        if self.old || self.dr(Drop::Key) { en.content == s.content[n] } else { en.key == s.key[n] }
    }
    fn free_covers(&self, s: &State, i: usize) -> bool {
        has(s.accepted, i) && !has(s.invalid, i) && self.free_bound(s, i)
    }
    fn free_waived(&self, s: &State) -> u32 {
        let mut m = 0;
        for i in 0..s.log.len() {
            if self.free_covers(s, i) && s.log[i].ev.ty != Ty::Defer {
                m |= bit(i);
            }
        }
        m
    }
    fn free_deferred(&self, s: &State) -> u32 {
        let mut m = 0;
        for i in 0..s.log.len() {
            if self.free_covers(s, i) && s.log[i].ev.ty == Ty::Defer {
                m |= bit(i);
            }
        }
        m
    }

    fn free_step(&self, s: &State, ev: &Ev) -> Option<State> {
        if s.log.len() >= self.max_log {
            return None;
        }
        let i = s.log.len();
        let n = ev.node as usize;
        let mut l = s.log.clone();
        l.push(Entry { ev: *ev, key: s.key[n], content: s.content[n] });
        let revoke = ev.ty == Ty::Revoke && ev.from == OWNER;
        let rt = rights(ev.from, s.edges, &s.log);
        let grant = ev.ty == Ty::Grant
            && (self.old || self.dr(Drop::Issue) || rt != 0)
            && (self.dr(Drop::Scope) || ev.scope & !rt == 0 || ((self.old || self.dr(Drop::Issue)) && rt == 0));
        let raw = if grant {
            s.edges | bit(i)
        } else if revoke {
            let mut m = 0;
            for j in 0..s.log.len() {
                if has(s.edges, j) && s.log[j].ev.to != ev.to {
                    m |= bit(j);
                }
            }
            m
        } else {
            s.edges
        };
        let live = if revoke && !self.old && !self.dr(Drop::Continuous) { prune(raw, &l, 5) } else { raw };
        let mut cut = 0u32;
        if revoke && ev.value == RETRO {
            for j in 0..s.log.len() {
                if has(s.accepted, j) {
                    let en = &s.log[j].ev;
                    let nb = 1 << en.node;
                    if rights(en.from, s.edges, &s.log) & nb != 0 && rights(en.from, live, &l) & nb == 0 {
                        cut |= bit(j);
                    }
                }
            }
        }
        let acquire = ev.ty == Ty::Acquire && PARENTS & pbit(ev.from) == 0 && s.slots[n] == NONE;
        let release = ev.ty == Ty::Release && s.slots[n] == ev.from;
        let lawb = ev.ty == Ty::Law && rt & (1 << ev.node) != 0;
        let mut lv = s.law_view;
        if lawb {
            lv[n][ev.from as usize] = ev.value;
        }
        let mut clashes = 0u8;
        if !(self.old || self.dr(Drop::Conflict)) {
            for nn in 0..2 {
                if free_clash(&lv, nn) {
                    clashes |= 1 << nn;
                }
            }
        }
        let mut winners = s.law_winner;
        let mut values = s.law_value;
        if lawb {
            winners[n] = ev.from;
            values[n] = ev.value;
        }
        let mut t = s.clone();
        t.log = l;
        t.edges = live;
        if decision(ev) && self.free_can_decide(s, ev) {
            t.accepted |= bit(i);
        }
        t.invalid |= cut;
        if matches!(ev.ty, Ty::Related | Ty::Closure) {
            t.key[n] += 1;
        }
        if matches!(ev.ty, Ty::Related | Ty::Unrelated) {
            t.content[n] += 1;
        }
        if acquire {
            t.slots[n] = ev.from;
            t.ever_slots |= pbit(ev.from);
        } else if release {
            t.slots[n] = NONE;
        }
        if ev.ty == Ty::Related {
            t.authors[n] = ev.from;
        }
        t.law_view = lv;
        t.conflict = clashes;
        for nn in 0..2 {
            let c = clashes & (1 << nn) != 0;
            t.resolver[nn] = if c { OWNER } else { NONE };
            t.law_winner[nn] = if c { NONE } else { winners[nn] };
            t.law_value[nn] = if c { -1 } else { values[nn] };
        }
        if ev.ty == Ty::Merge {
            let wd = self.free_waived(s) | self.free_deferred(s);
            if (0..s.log.len()).any(|j| has(wd, j) && s.log[j].ev.node == ev.node) {
                t.merged = true;
            }
        }
        Some(t)
    }

    /// How many times TLC generates the successor of `a` from `s` (TLC explores every true disjunct of a
    /// conjunct in an action as its own branch, so one transition can be generated several times). Only the
    /// scenario `Step` has such a conjunct: `(e.type # "merge" \/ family="good" \/ Deferred # {})`. Used to
    /// compare TLC's "states generated"; the engine's results do not depend on it.
    pub fn tlc_branches(&self, s: &State, a: &Action) -> u64 {
        match a {
            Action::Advance(ev) if s.family != Family::Free => {
                (ev.ty != Ty::Merge) as u64 + (s.family == Family::Good) as u64 + (self.deferred(s) != 0) as u64
            }
            _ => 1,
        }
    }

    pub fn done(&self, s: &State) -> bool {
        if s.family == Family::Free { s.log.len() == self.max_log } else { s.pending == 0 }
    }

    // --- properties -----------------------------------------------------------------------------------------

    fn authority_sound(&self, s: &State) -> bool {
        let k = if s.family == Family::Free { self.kf() } else { 5 };
        let eff = Eff::new(&s.log, k);
        (0..5).all(|p| rights(p, s.edges, &s.log) & !eff.get(p, s.log.len() + 1, k) == 0)
    }

    fn decision_authority(&self, s: &State) -> bool {
        let k = if s.family == Family::Free { self.kf() } else { 5 };
        let eff = Eff::new(&s.log, k);
        (0..s.log.len()).filter(|&i| has(s.accepted, i)).all(|i| {
            let en = &s.log[i].ev;
            eff.get(en.from, i + 1, k) & (1 << en.node) != 0
        })
    }

    fn no_writer_judge(&self, s: &State) -> bool {
        if s.family != Family::Free {
            return (0..s.log.len()).filter(|&i| has(s.accepted, i)).all(|i| WRITERS & pbit(s.log[i].ev.from) == 0);
        }
        (0..s.log.len()).filter(|&i| has(s.accepted, i)).all(|i| !ever_at(&s.log, s.log[i].ev.from, i + 1))
    }

    fn no_author_judge(&self, s: &State) -> bool {
        if s.family != Family::Free {
            return (0..s.log.len()).filter(|&i| has(s.accepted, i)).all(|i| {
                let en = &s.log[i].ev;
                let actual = if s.family == Family::Author { [OWNER, W2] } else { [W1, W2] };
                actual[en.node as usize] != en.from
            });
        }
        (0..s.log.len()).filter(|&i| has(s.accepted, i)).all(|i| {
            let en = &s.log[i].ev;
            en.from != author_at(&s.log, en.node, i + 1)
        })
    }

    fn relevant_invalidates(&self, s: &State) -> bool {
        if s.family != Family::Free {
            let w = self.waived(s);
            return (0..s.log.len()).filter(|&i| has(w, i)).all(|i| s.log[i].key == s.key[0]);
        }
        let wd = self.free_waived(s) | self.free_deferred(s);
        let len1 = s.log.len() + 1;
        (0..s.log.len()).filter(|&i| has(wd, i)).all(|i| s.log[i].key == true_key(&s.log, s.log[i].ev.node, len1))
    }

    fn unrelated_preserves(&self, s: &State) -> bool {
        if s.family != Family::Free {
            let w = self.waived(s);
            return (0..s.log.len()).filter(|&i| has(s.accepted, i)).all(|i| {
                let en = &s.log[i];
                !(en.ev.ty == Ty::Waive && en.key == s.key[0] && !has(s.invalid, i)) || has(w, i)
            });
        }
        let eff = Eff::new(&s.log, self.kf());
        let len1 = s.log.len() + 1;
        (0..s.log.len()).filter(|&i| has(s.accepted, i)).all(|i| {
            let en = &s.log[i];
            !(en.key == true_key(&s.log, en.ev.node, len1) && !self.retro_cut(s, &eff, i)) || self.free_covers(s, i)
        })
    }

    fn state_remains_debt(&self, s: &State) -> bool {
        if s.family != Family::Free {
            // StateItem => Debt={<<"I",key>>} /\ Waived={}; given StateItem, Debt is that singleton iff Waived={}.
            return !Self::state_item(s) || self.waived(s) == 0;
        }
        let w = self.free_waived(s);
        let waived_n2 = (0..s.log.len()).any(|i| has(w, i) && s.log[i].ev.node == 1);
        // FreeDebt = {<<"I",key["n2"]>>} unless some FreeWaived entry is on n2 (then {}).
        let debt_ok = !waived_n2 && s.key[1] == true_key(&s.log, 1, s.log.len() + 1);
        debt_ok && !waived_n2
    }

    /// Scenario `Laws(p)`: the law entries of p issued while "n1" was in Eff(p,i,5); returns the last one.
    fn last_law(s: &State, eff: &Eff, p: u8) -> Option<usize> {
        (0..s.log.len())
            .filter(|&i| {
                let en = &s.log[i].ev;
                en.ty == Ty::Law && en.from == p && eff.get(p, i + 1, 5) & N1 != 0
            })
            .max()
    }

    /// Free `FLaws(n,p)`, last element.
    fn last_flaw(&self, s: &State, eff: &Eff, n: u8, p: u8) -> Option<usize> {
        (0..s.log.len())
            .filter(|&i| {
                let en = &s.log[i].ev;
                en.ty == Ty::Law && en.node == n && en.from == p && eff.get(p, i + 1, self.kf()) & (1 << n) != 0
            })
            .max()
    }

    fn conflict_debt(&self, s: &State) -> bool {
        if s.family != Family::Free {
            let eff = Eff::new(&s.log, 5);
            let true_conflict = match (Self::last_law(s, &eff, P1), Self::last_law(s, &eff, P2)) {
                (Some(a), Some(b)) => s.log[a].ev.value != s.log[b].ev.value,
                _ => false,
            };
            return !true_conflict
                || (s.conflict == 1 && s.resolver[0] == OWNER && s.law_winner[0] == NONE && s.law_value[0] == -1);
        }
        let eff = Eff::new(&s.log, self.kf());
        (0..2u8).all(|n| {
            let lasts: Vec<Option<usize>> = (0..5).map(|p| self.last_flaw(s, &eff, n, p)).collect();
            let mut tc = false;
            for p in 0..5u8 {
                for q in 0..5u8 {
                    if p != q && rank(p) == rank(q) {
                        if let (Some(a), Some(b)) = (lasts[p as usize], lasts[q as usize]) {
                            if s.log[a].ev.value != s.log[b].ev.value {
                                tc = true;
                            }
                        }
                    }
                }
            }
            let ni = n as usize;
            !tc || (s.conflict & (1 << n) != 0 && s.resolver[ni] == OWNER && s.law_winner[ni] == NONE && s.law_value[ni] == -1)
        })
    }

    fn same_principal_supersedes(&self, s: &State) -> bool {
        if s.family != Family::Free {
            if s.family != Family::SameLaw {
                return true;
            }
            let eff = Eff::new(&s.log, 5);
            let Some(last) = Self::last_law(s, &eff, P1) else { return true };
            let v = s.log[last].ev.value;
            return s.law_view[0][P1 as usize] == v && s.conflict == 0 && s.law_winner[0] == P1 && s.law_value[0] == v;
        }
        let eff = Eff::new(&s.log, self.kf());
        (0..2u8).all(|n| {
            (0..5u8).all(|p| match self.last_flaw(s, &eff, n, p) {
                None => true,
                Some(i) => s.law_view[n as usize][p as usize] == s.log[i].ev.value,
            })
        })
    }

    /// Free `FCut(r,p,n)` (r is a 0-based position).
    fn fcut(&self, s: &State, eff: &Eff, r: usize, p: u8, n: u8) -> bool {
        let x = &s.log[r].ev;
        let k = self.kf();
        x.ty == Ty::Revoke && x.from == OWNER && eff.get(p, r + 1, k) & (1 << n) != 0 && eff.get(p, r + 2, k) & (1 << n) == 0
    }

    fn retro_cut(&self, s: &State, eff: &Eff, i: usize) -> bool {
        let en = &s.log[i].ev;
        ((i + 1)..s.log.len()).any(|r| {
            let x = &s.log[r].ev;
            x.ty == Ty::Revoke && x.value == RETRO && self.fcut(s, eff, r, en.from, en.node)
        })
    }

    fn retro_honored(&self, s: &State) -> bool {
        if s.family != Family::Free {
            let eff = Eff::new(&s.log, 5);
            return (0..s.log.len()).filter(|&i| has(s.accepted, i)).all(|i| {
                let en = &s.log[i].ev;
                ((i + 1)..s.log.len()).all(|r| {
                    let x = &s.log[r].ev;
                    let nb = 1 << en.node;
                    let true_cut = eff.get(en.from, r + 1, 5) & nb != 0 && eff.get(en.from, r + 2, 5) & nb == 0;
                    !(x.ty == Ty::Revoke && x.value == RETRO && true_cut) || !self.covers(s, i)
                })
            });
        }
        let eff = Eff::new(&s.log, self.kf());
        (0..s.log.len()).filter(|&i| has(s.accepted, i)).all(|i| !self.retro_cut(s, &eff, i) || !self.free_covers(s, i))
    }

    fn future_preserves(&self, s: &State) -> bool {
        if s.family != Family::Free {
            return s.family != Family::Future || (0..s.log.len()).filter(|&i| has(s.accepted, i)).all(|i| self.covers(s, i));
        }
        let eff = Eff::new(&s.log, self.kf());
        let len1 = s.log.len() + 1;
        (0..s.log.len()).filter(|&i| has(s.accepted, i)).all(|i| {
            let en = &s.log[i];
            let fut = ((i + 1)..s.log.len()).any(|r| {
                let x = &s.log[r].ev;
                x.ty == Ty::Revoke && x.value == FUTURE && self.fcut(s, &eff, r, en.ev.from, en.ev.node)
            });
            !(fut && en.key == true_key(&s.log, en.ev.node, len1) && !self.retro_cut(s, &eff, i)) || self.free_covers(s, i)
        })
    }

    fn all_safety(&self, s: &State) -> bool {
        self.authority_sound(s)
            && self.decision_authority(s)
            && self.no_writer_judge(s)
            && self.no_author_judge(s)
            && self.relevant_invalidates(s)
            && self.unrelated_preserves(s)
            && self.state_remains_debt(s)
            && self.conflict_debt(s)
            && self.same_principal_supersedes(s)
            && self.retro_honored(s)
            && self.future_preserves(s)
    }

    // Witnesses (scenario definitions; in free they read key/content of n1 as the scenario Bound does).
    fn nothing_deferred_merged(&self, s: &State) -> bool {
        !(s.family == Family::Deferred && s.merged && self.debt(s) && self.deferred(s) != 0)
    }
    fn nothing_parent_waived(&self, s: &State) -> bool {
        let w = self.waived(s);
        !(0..s.log.len()).any(|i| has(w, i) && PARENTS & pbit(s.log[i].ev.from) != 0)
    }
    fn nothing_cross_waived(&self, s: &State) -> bool {
        let w = self.waived(s);
        !(0..s.log.len()).any(|i| has(w, i) && s.log[i].ev.from == W1 && s.log[i].ev.node == 1)
    }
    fn nothing_speech_waived(&self, s: &State) -> bool {
        let l = &s.log;
        !(s.family == Family::Speech
            && l.len() == 3
            && l[0].ev.ty == Ty::Grant
            && l[0].ev.from == W1
            && l[1].ev.ty == Ty::Grant
            && l[1].ev.from == OWNER
            && has(self.waived(s), 2))
    }
    fn nothing_revived_waived(&self, s: &State) -> bool {
        let l = &s.log;
        if !(s.family == Family::Revival && l.len() == 5) {
            return true;
        }
        let types = [Ty::Grant, Ty::Grant, Ty::Revoke, Ty::Grant, Ty::Waive];
        if !(0..5).all(|i| l[i].ev.ty == types[i]) {
            return true;
        }
        let eff = Eff::new(l, 5);
        !(eff.get(P2, 3, 5) & N1 != 0 && has(self.waived(s), 4) && eff.get(P2, 5, 5) & N1 == 0)
    }
}

fn decision(ev: &Ev) -> bool {
    matches!(ev.ty, Ty::Waive | Ty::Downgrade | Ty::Defer)
}

fn author(n: u8) -> u8 {
    if n == 0 { W1 } else { W2 }
}

fn rank(p: u8) -> u8 {
    match p {
        OWNER => 2,
        P1 | P2 => 1,
        _ => 0,
    }
}

fn free_clash(lv: &[[i8; 5]; 2], n: usize) -> bool {
    for p in 0..5u8 {
        for q in 0..5u8 {
            if p != q && rank(p) == rank(q) {
                let (a, b) = (lv[n][p as usize], lv[n][q as usize]);
                if a != -1 && b != -1 && a != b {
                    return true;
                }
            }
        }
    }
    false
}

/// `SlotAt(n,t)` (t 1-based).
fn slot_at(log: &[Entry], n: u8, t: usize) -> u8 {
    let mut before = author(n);
    for x in &log[..t - 1] {
        let ev = &x.ev;
        if ev.node != n {
            continue;
        }
        if ev.ty == Ty::Acquire && PARENTS & pbit(ev.from) == 0 && before == NONE {
            before = ev.from;
        } else if ev.ty == Ty::Release && ev.from == before {
            before = NONE;
        }
    }
    before
}

/// `EverAt(p,t)`.
fn ever_at(log: &[Entry], p: u8, t: usize) -> bool {
    if WRITERS & pbit(p) != 0 {
        return true;
    }
    (1..t).any(|i| {
        let ev = &log[i - 1].ev;
        ev.ty == Ty::Acquire && ev.from == p && PARENTS & pbit(p) == 0 && slot_at(log, ev.node, i) == NONE
    })
}

/// `AuthorAt(n,t)`.
fn author_at(log: &[Entry], n: u8, t: usize) -> u8 {
    (1..t).rev().find(|&i| log[i - 1].ev.node == n && log[i - 1].ev.ty == Ty::Related).map_or(author(n), |i| log[i - 1].ev.from)
}

/// `TrueKey(n,t)`.
fn true_key(log: &[Entry], n: u8, t: usize) -> u8 {
    log[..t - 1].iter().filter(|x| x.ev.node == n && matches!(x.ev.ty, Ty::Related | Ty::Closure)).count() as u8
}

impl Model for Auth {
    type State = State;
    type Action = Action;

    fn init(&self) -> Vec<State> {
        let base = |family: Family| State {
            family,
            log: Vec::new(),
            pending: 0,
            edges: 0,
            accepted: 0,
            invalid: 0,
            key: [0; 2],
            content: [0; 2],
            slots: [0; 2],
            merged: false,
            law_view: [[-1; 5]; 2],
            conflict: 0,
            resolver: [NONE; 2],
            law_winner: [NONE; 2],
            law_value: [-1; 2],
            ever_slots: WRITERS,
            authors: [W1, W2],
        };
        if self.free {
            let mut s = base(Family::Free);
            s.slots = [W1, W2];
            vec![s]
        } else {
            FAMILIES
                .iter()
                .map(|&f| {
                    let mut s = base(f);
                    s.pending = ((1u16 << self.events(f).len()) - 1) as u8;
                    s.slots = [WRITERS, 0];
                    s
                })
                .collect()
        }
    }

    fn next(&self, s: &State, out: &mut Vec<(Action, State)>) {
        if s.family == Family::Free {
            for ev in &self.free_events {
                if let Some(t) = self.free_step(s, ev) {
                    out.push((Action::Advance(*ev), t));
                }
            }
        } else {
            for (j, ev) in self.events(s.family).iter().enumerate() {
                let b = 1u8 << j;
                if s.pending & b != 0
                    && let Some(t) = self.step(s, ev, b)
                {
                    out.push((Action::Advance(*ev), t));
                }
            }
        }
        if self.done(s) {
            out.push((Action::Terminal, s.clone()));
        }
    }

    /// In free mode NothingParentWaived and NothingCrossWaived are not offered: their scenario `Waived` compares
    /// `log[i].key` with the function `key`, which TLC cannot evaluate (selecting one is an "unknown property"
    /// ERROR). The other witnesses short-circuit on `family` or read only `merged`, as in TLC.
    fn properties(&self) -> Vec<Property<Self>> {
        let free = self.free;
        let mut v = vec![
            Property::Invariant { name: "AuthoritySound", holds: |m: &Auth, s| m.authority_sound(s) },
            Property::Invariant { name: "DecisionAuthority", holds: |m: &Auth, s| m.decision_authority(s) },
            Property::Invariant { name: "NoWriterJudge", holds: |m: &Auth, s| m.no_writer_judge(s) },
            Property::Invariant { name: "NoAuthorJudge", holds: |m: &Auth, s| m.no_author_judge(s) },
            Property::Invariant { name: "RelevantInvalidates", holds: |m: &Auth, s| m.relevant_invalidates(s) },
            Property::Invariant { name: "UnrelatedPreserves", holds: |m: &Auth, s| m.unrelated_preserves(s) },
            Property::Invariant { name: "StateRemainsDebt", holds: |m: &Auth, s| m.state_remains_debt(s) },
            Property::Invariant { name: "ConflictDebt", holds: |m: &Auth, s| m.conflict_debt(s) },
            Property::Invariant { name: "SamePrincipalSupersedes", holds: |m: &Auth, s| m.same_principal_supersedes(s) },
            Property::Invariant { name: "RetroHonored", holds: |m: &Auth, s| m.retro_honored(s) },
            Property::Invariant { name: "FuturePreserves", holds: |m: &Auth, s| m.future_preserves(s) },
            Property::Invariant { name: "AllSafety", holds: |m: &Auth, s| m.all_safety(s) },
            Property::Invariant { name: "NothingMerged", holds: |_m: &Auth, s| !s.merged },
            Property::Invariant { name: "NothingDeferredMerged", holds: |m: &Auth, s| m.nothing_deferred_merged(s) },
            Property::Invariant { name: "NothingParentWaived", holds: |m: &Auth, s| m.nothing_parent_waived(s) },
            Property::Invariant { name: "NothingCrossWaived", holds: |m: &Auth, s| m.nothing_cross_waived(s) },
            Property::Invariant { name: "NothingSpeechWaived", holds: |m: &Auth, s| m.nothing_speech_waived(s) },
            Property::Invariant { name: "NothingRevivedWaived", holds: |m: &Auth, s| m.nothing_revived_waived(s) },
            Property::LeadsTo {
                name: "GoodProgress",
                p: |_m: &Auth, s| matches!(s.family, Family::Good | Family::Deferred),
                q: |_m: &Auth, s| s.merged,
            },
            Property::Eventually { name: "Finished", q: |m: &Auth, s| m.done(s) },
        ];
        if free {
            v.retain(|p| !matches!(p.name(), "NothingParentWaived" | "NothingCrossWaived"));
        }
        v
    }

    /// `WF_vars(Advance)`: one class for every Advance step; Terminal is a stutter.
    fn fairness(&self, a: &Action) -> Option<&'static str> {
        match a {
            Action::Advance(_) => Some("Advance"),
            Action::Terminal => None,
        }
    }
}

fn build(mode: &str, c: &mut Consts) -> Result<Box<dyn DynModel>, String> {
    let scope = c.string("Scope", "scenarios");
    let max_log = c.uint("MaxLog", 5)? as usize;
    let free = match scope.as_str() {
        "free" => true,
        "scenarios" => false,
        _ => return Err(format!("Scope must be \"scenarios\" or \"free\", not {scope}")),
    };
    Ok(Box::new(Auth::new(mode, free, max_log)?))
}

pub fn info() -> ModelInfo {
    ModelInfo {
        name: "a3_auth",
        about: "port of PiDagAuth3.tla (a3 authority history, waivers and law conflicts); Scope=scenarios|free",
        modes: MODES,
        consts: &[("Scope", "scenarios"), ("MaxLog", "5")],
        source_file: file!(),
        source: include_str!("auth.rs"),
        build,
    }
}
