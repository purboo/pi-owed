//! a3_merge: port of `PiDagMerge.tla` (formal/reference/a3/PiDagMerge.tla, module sha256 7972e7a8…).
//!
//! TLA+ has two variables: `x` (scripted scenarios) and `f` (free scenarios); the unused one is the constant
//! `[unused |-> TRUE]`. Here `State` is `Script(X)` or `Free(F)` (one kind per run, so this is injective), and
//! the fields of `X` and `F` mirror the TLA+ record fields one to one. Model values: O, K0 (= index 0), K1 (= 1);
//! keys <<n, v>> of the free model are (n, v). Sets of strings are bitmasks (FAIL = 1, PASS = 2, HIGH = 4), sets
//! of history positions are bitmasks (bit i-1 = position i), sets of keys are bitmasks (bit 3n+v).
//!
//! `next` lists successors in the order TLC evaluates the disjuncts of `Next` (the whole `Next` is one TLC
//! action): Genesis, SkipGenesis, Terminal, then the scenario's disjuncts in text order; `\E r \in S` follows
//! TLC's normalized set order ("fail" < "pass" < "unknown", FALSE < TRUE, K0 < K1, integers ascending).

use mc::{Consts, DynModel, Model, ModelInfo, Property};

pub const K0: u8 = 0;
pub const K1: u8 = 1;
pub const FAIL: u8 = 1;
pub const PASS: u8 = 2;
pub const HIGH: u8 = 4;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Scenario {
    LaunderTest,
    LaunderReview,
    Rerun,
    FlakyDebt,
    Matrix,
    Genesis,
    FalsePass,
    Defer,
    OldDebt,
    Waiver,
    Good,
    Live,
    Race,
    Free,
    ReplayNegative,
    ReplayDeferred,
}

pub const SCENARIOS: &[(&str, Scenario)] = &[
    ("launderTest", Scenario::LaunderTest),
    ("launderReview", Scenario::LaunderReview),
    ("rerun", Scenario::Rerun),
    ("flakyDebt", Scenario::FlakyDebt),
    ("matrix", Scenario::Matrix),
    ("genesis", Scenario::Genesis),
    ("falsePass", Scenario::FalsePass),
    ("defer", Scenario::Defer),
    ("oldDebt", Scenario::OldDebt),
    ("waiver", Scenario::Waiver),
    ("good", Scenario::Good),
    ("live", Scenario::Live),
    ("race", Scenario::Race),
    ("free", Scenario::Free),
    ("replayNegative", Scenario::ReplayNegative),
    ("replayDeferred", Scenario::ReplayDeferred),
];

/// The ablations `Clause(c) == A3 /\ Mode # ("a3-" \o c)`.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Cl {
    K1,
    K2,
    K3,
    K3state,
    K4,
    K5atomic,
    K5queue,
}

pub const MODES: &[&str] = &["a3", "a22", "a3-K1", "a3-K2", "a3-K3", "a3-K3state", "a3-K4", "a3-K5atomic", "a3-K5queue"];

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Phase {
    Genesis,
    Start,
    Negative,
    Edit,
    Observe,
    Decide,
    Commit,
    Done,
    Rejected,
    Prepare,
    Validate,
    Ready,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Op {
    Genesis,
    Edit,
    Observe,
    Rerun,
    Waiver,
    Defer,
    StateWaiver,
    Commit,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Res {
    None,
    Fail,
    Pass,
    Unknown,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Kind {
    Judgment,
    Execution,
    State,
}

/// Scripted `SEvent(op, key, result, rank, accurate)`; n = K0, kind and truth are constants of the scenario.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct SEv {
    pub op: Op,
    pub key: u8,
    pub result: Res,
    pub rank: u8,
    pub accurate: bool,
}

/// The scripted record `x`.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct X {
    pub phase: Phase,
    pub obs: [u8; 2],
    pub genesis: bool,
    pub head: u8,
    pub snap: u8,
    pub sealed: bool,
    pub rank: u8,
    pub conflict: bool,
    pub accurate_seen: bool,
    pub original: u8,
    pub rerun_done: bool,
    pub key: u8,
    pub merged: bool,
    pub bad_merged: bool,
    pub fresh_block_merged: bool,
    pub unobserved_merged: bool,
    pub waived_state_merged: bool,
    pub truth: bool,
    pub deferred: bool,
    pub waiver: bool,
    pub state_waiver: bool,
    pub debt_after: bool,
    pub late_block: bool,
    pub invalidated: bool,
    pub lease: bool,
    pub lease_used: bool,
    pub conflict_merge: bool,
    pub unrelated: bool,
    pub hist: Vec<SEv>,
}

/// Free `FEvent(op,n,key,result,rank,accurate,truth)` (key = <<key_n, key_v>>).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct FEv {
    pub op: Op,
    pub n: u8,
    pub key: (u8, u8),
    pub kind: Kind,
    pub result: Res,
    pub rank: u8,
    pub accurate: bool,
    pub truth: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct Eval {
    pub valid: bool,
    pub epoch: u8,
    pub ver: u8,
    pub at: u8,
}

/// `lease` of a receipt / of `f`: a node or "none".
pub const NO_LEASE: u8 = 2;

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct Receipt {
    pub n: u8,
    pub key: (u8, u8),
    pub truth: bool,
    pub prekey: (u8, u8),
    pub pretruth: bool,
    pub at: u8,
    pub eval_at: u8,
    pub waived: bool,
    pub deferred: bool,
    pub state_w: bool,
    pub debt: bool,
    pub node_debt: bool,
    pub lease: u8,
}

/// The free record `f`.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub struct F {
    pub kind: [Kind; 2],
    pub ver: [u8; 2],
    pub truth: [[bool; 3]; 2],
    pub obs: [[u8; 3]; 2],
    pub node_obs: [[u8; 3]; 2],
    pub trunk: [u8; 2],
    pub epoch: u8,
    pub genesis: bool,
    pub hist: Vec<FEv>,
    pub inputs: u8,
    pub blocks: u32,
    pub reproduced: u32,
    pub conflict: u8,
    pub waivers: u8,
    pub deferrals: u8,
    pub state_w: u8,
    pub queue: Vec<u8>,
    pub lease: u8,
    pub done: u8,
    pub eval: [Eval; 2],
    pub receipts: Vec<Receipt>,
}

#[derive(Clone, PartialEq, Eq, Hash, Debug)]
pub enum State {
    Script(X),
    Free(F),
}

#[derive(Clone, PartialEq, Eq, Debug)]
pub enum Action {
    Genesis,
    SkipGenesis,
    Terminal,
    Start,
    Negative,
    Edit,
    Observe(Res),
    HighObserve,
    Rerun(Res),
    OwnerWaive,
    Defer,
    StateWaive,
    Eval,
    LateBlock,
    UnrelatedObservation,
    Commit,
    Retry,
    FinishObservation,
    Reject,
    LiveStart,
    Acquire,
    Prepare,
    Validate,
    LiveCommit,
    Rebase,
    Rival,
    Expire,
    FGenesis,
    FExpire,
    FFinished,
    FEnqueue(u8),
    FLease(u8),
    FEval(u8),
    FCommit(u8),
    FCancel(u8),
    FWaive(u8),
    FDefer(u8),
    FStateWaive(u8),
    FEdit(u8, bool),
    FStateObserve(u8, Res, bool),
    FObserve(u8, Res, u8, bool),
    FRerun(u8, Res),
}

pub struct Merge {
    pub a3: bool,
    pub drop: Option<Cl>,
    pub sc: Scenario,
}

const FLIMIT: u8 = 8;

fn rbit(r: Res) -> u8 {
    match r {
        Res::Fail => FAIL,
        Res::Pass => PASS,
        _ => 0,
    }
}
fn kbit(n: u8, v: u8) -> u8 {
    1 << (3 * n + v)
}
fn has(set: u32, i: usize) -> bool {
    set & (1 << i) != 0
}

impl Merge {
    pub fn new(mode: &str, scenario: &str) -> Result<Merge, String> {
        let (a3, drop) = match mode {
            "a3" => (true, None),
            "a22" => (false, None),
            m => {
                let c = match m.strip_prefix("a3-") {
                    Some("K1") => Cl::K1,
                    Some("K2") => Cl::K2,
                    Some("K3") => Cl::K3,
                    Some("K3state") => Cl::K3state,
                    Some("K4") => Cl::K4,
                    Some("K5atomic") => Cl::K5atomic,
                    Some("K5queue") => Cl::K5queue,
                    _ => return Err(format!("unknown mode {m}")),
                };
                (true, Some(c))
            }
        };
        let sc = SCENARIOS.iter().find(|(n, _)| *n == scenario).map(|x| x.1).ok_or_else(|| format!("unknown Scenario {scenario}"))?;
        Ok(Merge { a3, drop, sc })
    }

    /// `Clause(c) == A3 /\ Mode # ("a3-" \o c)`.
    fn clause(&self, c: Cl) -> bool {
        self.a3 && self.drop != Some(c)
    }
    fn free_scenario(&self) -> bool {
        matches!(self.sc, Scenario::Free | Scenario::ReplayNegative | Scenario::ReplayDeferred)
    }
    fn obs_key(&self, k: u8) -> u8 {
        if self.clause(Cl::K1) {
            k
        } else if self.a3 {
            K0
        } else {
            k
        }
    }
    /// `Item(k)` is <<O,k>> under K3 and O otherwise: two items are equal iff `!K3 || k1 == k2`.
    fn same_item(&self, a: u8, b: u8) -> bool {
        !self.clause(Cl::K3) || a == b
    }
    fn launder(&self) -> bool {
        matches!(self.sc, Scenario::LaunderTest | Scenario::LaunderReview | Scenario::Rerun)
    }
    fn debt_case(&self) -> bool {
        use Scenario::*;
        matches!(self.sc, FlakyDebt | Matrix | Genesis | FalsePass | Defer | OldDebt | Waiver)
    }
    fn bad(&self) -> bool {
        !matches!(self.sc, Scenario::Good | Scenario::Live)
    }
    fn changed(&self) -> bool {
        self.sc != Scenario::OldDebt
    }
    fn ck(&self) -> u8 {
        if self.changed() { K1 } else { K0 }
    }
    fn pre_obs(&self) -> u8 {
        if self.launder() {
            FAIL
        } else if self.sc == Scenario::FlakyDebt {
            PASS | FAIL
        } else if matches!(self.sc, Scenario::Matrix | Scenario::OldDebt) {
            0
        } else {
            PASS
        }
    }
    fn pre_truth(&self) -> bool {
        !(self.sc == Scenario::OldDebt || self.launder())
    }
    /// The constant `kind` of scripted events.
    fn skind(&self) -> Kind {
        if self.debt_case() {
            Kind::State
        } else if self.sc == Scenario::LaunderReview {
            Kind::Judgment
        } else {
            Kind::Execution
        }
    }
    fn results(&self) -> &'static [Res] {
        use Scenario::*;
        match self.sc {
            LaunderTest | LaunderReview | Rerun | FalsePass | Good => &[Res::Fail, Res::Pass],
            Matrix | Genesis | OldDebt | Waiver => &[Res::Unknown],
            FlakyDebt | Defer => &[Res::Fail],
            _ => &[Res::Pass],
        }
    }

    // --- scripted ----------------------------------------------------------------------------------------------

    fn evidence(&self, x: &X, k: u8) -> bool {
        x.obs[self.obs_key(k) as usize] == PASS
    }
    fn node_ok(&self, x: &X) -> bool {
        if self.launder() {
            x.waiver || (self.evidence(x, x.key) && (!self.clause(Cl::K2) || (!x.sealed && !x.conflict)))
        } else {
            self.evidence(x, x.key) || self.debt_case()
        }
    }
    fn guard(&self, x: &X) -> bool {
        let pre_debt = x.obs[K0 as usize] != PASS; // PreDebt = {Item(K0)} unless obs[K0] = {"pass"}
        let next_debt = !(self.evidence(x, self.ck()) || x.state_waiver); // NextDebt = {Item(CK)} unless ...
        let subset = !next_debt || (pre_debt && self.same_item(self.ck(), K0));
        (!self.clause(Cl::K4) || x.genesis) && self.node_ok(x) && (!self.debt_case() || x.deferred || subset)
    }
    fn sev(&self, op: Op, key: u8, result: Res, rank: u8, accurate: bool) -> SEv {
        SEv { op, key, result, rank, accurate }
    }

    fn script_init(&self) -> X {
        X {
            phase: Phase::Genesis,
            obs: [0, 0],
            genesis: false,
            head: 0,
            snap: 0,
            sealed: false,
            rank: 0,
            conflict: false,
            accurate_seen: false,
            original: 0,
            rerun_done: false,
            key: K0,
            merged: false,
            bad_merged: false,
            fresh_block_merged: false,
            unobserved_merged: false,
            waived_state_merged: false,
            truth: self.pre_truth(),
            deferred: false,
            waiver: false,
            state_waiver: false,
            debt_after: false,
            late_block: false,
            invalidated: false,
            lease: false,
            lease_used: false,
            conflict_merge: false,
            unrelated: false,
            hist: Vec::new(),
        }
    }

    fn script_next(&self, x: &X, out: &mut Vec<(Action, State)>) {
        let mut push = |a: Action, t: X| out.push((a, State::Script(t)));
        use Phase as Ph;
        // Genesis
        if x.phase == Ph::Genesis {
            let mut t = x.clone();
            t.phase = Ph::Start;
            t.genesis = true;
            t.obs[K0 as usize] = self.pre_obs();
            t.head += 1;
            push(Action::Genesis, t);
        }
        // SkipGenesis
        if x.phase == Ph::Genesis && !self.clause(Cl::K4) {
            let mut t = x.clone();
            t.phase = Ph::Start;
            push(Action::SkipGenesis, t);
        }
        // Terminal
        if matches!(x.phase, Ph::Done | Ph::Rejected) {
            push(Action::Terminal, x.clone());
        }
        if self.sc == Scenario::Live {
            self.live_next(x, &mut push);
            return;
        }
        let bad = self.bad();
        // Start
        if x.phase == Ph::Start {
            let mut t = x.clone();
            t.phase = if self.launder() { Ph::Negative } else { Ph::Observe };
            t.key = if self.launder() { K0 } else { self.ck() };
            push(Action::Start, t);
        }
        // Negative
        if x.phase == Ph::Negative {
            let rk = if self.sc == Scenario::LaunderReview { 2 } else { 1 };
            let mut t = x.clone();
            t.phase = Ph::Edit;
            t.obs[K0 as usize] = FAIL;
            t.original = FAIL;
            t.accurate_seen = true;
            t.hist.push(self.sev(Op::Observe, K0, Res::Fail, rk, true));
            t.sealed = true;
            t.rank = rk;
            t.head += 1;
            push(Action::Negative, t);
        }
        // Edit
        if x.phase == Ph::Edit {
            let mut t = x.clone();
            t.phase = Ph::Observe;
            t.key = K1;
            push(Action::Edit, t);
        }
        // \E r \in Results : Observe(r)
        if x.phase == Ph::Observe {
            for &r in self.results() {
                let mut t = x.clone();
                t.phase = Ph::Decide;
                t.obs[self.obs_key(x.key) as usize] |= rbit(r);
                t.hist.push(self.sev(Op::Observe, x.key, r, 1, false));
                if self.clause(Cl::K2) && r == Res::Pass && x.rank <= 1 && self.sc == Scenario::LaunderReview {
                    t.sealed = false;
                }
                t.head += 1;
                push(Action::Observe(r), t);
            }
        }
        // HighObserve
        if x.phase == Ph::Decide
            && matches!(self.sc, Scenario::LaunderReview | Scenario::Good | Scenario::FalsePass)
            && x.original & HIGH == 0
        {
            let r = if bad { Res::Fail } else { Res::Pass };
            let mut t = x.clone();
            t.original |= HIGH;
            t.hist.push(self.sev(Op::Observe, x.key, r, 2, true));
            t.obs[self.obs_key(x.key) as usize] |= rbit(r);
            t.sealed = bad;
            t.rank = 2;
            t.accurate_seen = x.accurate_seen || bad;
            t.head += 1;
            push(Action::HighObserve, t);
        }
        // \E r \in {"pass","fail"} : Rerun(r)
        if matches!(x.phase, Ph::Observe | Ph::Decide) && matches!(self.sc, Scenario::LaunderTest | Scenario::Rerun) && !x.rerun_done {
            for r in [Res::Fail, Res::Pass] {
                if r == Res::Pass && self.sc != Scenario::LaunderTest {
                    continue;
                }
                let mut t = x.clone();
                t.rerun_done = true;
                t.sealed = false;
                if self.clause(Cl::K2) && r == Res::Fail {
                    t.phase = Ph::Observe;
                }
                t.hist.push(self.sev(Op::Rerun, K0, r, 1, false));
                t.conflict = r == Res::Pass;
                t.original |= rbit(r);
                t.head += 1;
                push(Action::Rerun(r), t);
            }
        }
        // OwnerWaive
        if x.phase == Ph::Decide && self.launder() && !x.waiver {
            let mut t = x.clone();
            t.waiver = true;
            t.head += 1;
            push(Action::OwnerWaive, t);
        }
        // Defer
        if x.phase == Ph::Decide && self.sc == Scenario::Defer && !x.deferred {
            let mut t = x.clone();
            t.deferred = true;
            t.head += 1;
            push(Action::Defer, t);
        }
        // StateWaive
        if x.phase == Ph::Decide && self.sc == Scenario::Waiver && !self.clause(Cl::K3state) && !x.state_waiver {
            let mut t = x.clone();
            t.state_waiver = true;
            t.head += 1;
            push(Action::StateWaive, t);
        }
        let guard = self.guard(x);
        // Eval
        if x.phase == Ph::Decide && guard {
            let mut t = x.clone();
            t.phase = Ph::Commit;
            t.snap = x.head;
            push(Action::Eval, t);
        }
        // LateBlock
        if x.phase == Ph::Commit && self.sc == Scenario::Race && !x.late_block {
            let mut t = x.clone();
            t.late_block = true;
            t.sealed = true;
            t.rank = 2;
            t.accurate_seen = true;
            t.hist.push(self.sev(Op::Observe, x.key, Res::Fail, 2, true));
            t.obs[self.obs_key(x.key) as usize] |= FAIL;
            t.head += 1;
            push(Action::LateBlock, t);
        }
        // UnrelatedObservation
        if x.phase == Ph::Commit && !x.unrelated {
            let mut t = x.clone();
            t.unrelated = true;
            t.head += 1;
            push(Action::UnrelatedObservation, t);
        }
        // Commit
        if x.phase == Ph::Commit && (!self.clause(Cl::K5atomic) || guard) {
            let mut t = x.clone();
            t.phase = Ph::Done;
            t.merged = true;
            t.bad_merged = bad && x.accurate_seen && !x.waiver;
            t.fresh_block_merged = x.late_block;
            t.unobserved_merged = !x.genesis;
            t.waived_state_merged = x.state_waiver;
            t.truth = !bad;
            t.debt_after = !self.evidence(x, self.ck());
            t.head += 1;
            push(Action::Commit, t);
        }
        // Retry
        if x.phase == Ph::Commit && self.clause(Cl::K5atomic) && !guard {
            let mut t = x.clone();
            t.phase = Ph::Decide;
            push(Action::Retry, t);
        }
        // FinishObservation
        if x.phase == Ph::Decide && self.debt_case() && x.obs[self.obs_key(self.ck()) as usize] == 0 {
            let r = if bad { Res::Fail } else { Res::Pass };
            let mut t = x.clone();
            t.obs[self.obs_key(self.ck()) as usize] = rbit(r);
            t.hist.push(self.sev(Op::Observe, self.ck(), r, 2, true));
            t.accurate_seen = x.accurate_seen || bad;
            t.head += 1;
            push(Action::FinishObservation, t);
        }
        // Reject
        if x.phase == Ph::Decide && !guard && (x.obs[self.obs_key(x.key) as usize] & FAIL != 0 || x.sealed || x.conflict) {
            let mut t = x.clone();
            t.phase = Ph::Rejected;
            push(Action::Reject, t);
        }
    }

    fn live_next(&self, x: &X, push: &mut dyn FnMut(Action, X)) {
        use Phase as Ph;
        let busy = matches!(x.phase, Ph::Prepare | Ph::Validate | Ph::Ready);
        if x.phase == Ph::Start {
            let mut t = x.clone();
            t.phase = Ph::Prepare;
            t.lease_used = self.a3;
            t.lease = self.a3;
            push(Action::LiveStart, t);
        }
        if x.phase == Ph::Prepare && self.a3 && !x.lease {
            let mut t = x.clone();
            t.lease = true;
            t.lease_used = true;
            push(Action::Acquire, t);
        }
        if x.phase == Ph::Prepare {
            let mut t = x.clone();
            t.phase = Ph::Validate;
            t.invalidated = false;
            push(Action::Prepare, t);
        }
        if x.phase == Ph::Validate {
            let mut t = x.clone();
            t.phase = Ph::Ready;
            push(Action::Validate, t);
        }
        if x.phase == Ph::Ready && !x.invalidated {
            let mut t = x.clone();
            t.phase = Ph::Done;
            t.merged = true;
            t.lease = false;
            t.lease_used = false;
            push(Action::LiveCommit, t);
        }
        if x.phase == Ph::Ready && x.invalidated {
            let mut t = x.clone();
            t.phase = Ph::Prepare;
            push(Action::Rebase, t);
        }
        if busy && (!self.clause(Cl::K5queue) || !x.lease_used) {
            let mut t = x.clone();
            t.invalidated = true;
            t.conflict_merge = x.conflict_merge || x.lease;
            push(Action::Rival, t);
        }
        if x.lease && busy {
            let mut t = x.clone();
            t.lease = false;
            push(Action::Expire, t);
        }
    }

    /// TLC branches of `Guard`: TLC explores every true disjunct of a conjunct as its own branch (see
    /// `tlc_branches`).
    fn guard_branches(&self, x: &X) -> u64 {
        let b = |c: bool| c as u64;
        let g1 = b(!self.clause(Cl::K4)) + b(x.genesis);
        let node = if self.launder() {
            b(x.waiver) + b(self.evidence(x, x.key)) * (b(!self.clause(Cl::K2)) + b(!x.sealed && !x.conflict))
        } else {
            b(self.evidence(x, x.key)) + b(self.debt_case())
        };
        let debt = if self.debt_case() {
            let pre_debt = x.obs[K0 as usize] != PASS;
            let next_debt = !(self.evidence(x, self.ck()) || x.state_waiver);
            b(x.deferred) + b(!next_debt || (pre_debt && self.same_item(self.ck(), K0)))
        } else {
            1
        };
        g1 * node * debt
    }

    fn fguard_branches(&self, f: &F, n: u8) -> u64 {
        let b = |c: bool| c as u64;
        let (kn, kv) = Self::fkey(f, n);
        let waived = f.waivers & kbit(kn, kv) != 0;
        let ov = self.fobs_ver(f, n);
        let c1 = b(!self.clause(Cl::K4)) + b(f.genesis);
        let c2 = b(!self.a3) + b(waived) + b(f.node_obs[n as usize][ov as usize] == PASS);
        let no_blocks = (0..f.hist.len()).all(|i| !has(f.blocks, i) || f.hist[i].n != n);
        let c3 = b(waived) + b(!self.clause(Cl::K2)) + b(no_blocks && f.conflict & (1 << n) == 0);
        let tr = f.trunk[n as usize];
        let sub = !Self::fdebt(f, n, ov) || (Self::fdebt(f, n, tr) && (!self.clause(Cl::K3) || ov == tr));
        let c4 = b(f.deferrals & kbit(kn, kv) != 0) + b(sub);
        c1 * c2 * c3 * c4
    }

    /// How many times TLC generates the successor of `a` from `s`: TLC explores every true disjunct of a
    /// conjunct of an action as its own branch (also prime-free ones such as `~Clause("K5atomic") \/ Guard`), so
    /// one transition can be generated several times. Used to compare TLC's "states generated"; the engine's
    /// results do not depend on it.
    pub fn tlc_branches(&self, s: &State, a: &Action) -> u64 {
        let b = |c: bool| c as u64;
        match s {
            State::Script(x) => match a {
                Action::Eval => self.guard_branches(x),
                Action::Commit => b(!self.clause(Cl::K5atomic)) + if self.guard(x) { self.guard_branches(x) } else { 0 },
                Action::Reject => b(x.obs[self.obs_key(x.key) as usize] & FAIL != 0) + b(x.sealed) + b(x.conflict),
                Action::Rival => b(!self.clause(Cl::K5queue)) + b(!x.lease_used),
                _ => 1,
            },
            State::Free(f) => match a {
                Action::FEval(n) => self.fguard_branches(f, *n),
                Action::FCommit(n) => {
                    (b(!self.clause(Cl::K5queue)) + b(f.queue[0] == *n))
                        * (b(!self.clause(Cl::K5atomic)) + if self.fguard(f, *n) { self.fguard_branches(f, *n) } else { 0 })
                }
                Action::FObserve(n, r, _, acc) | Action::FStateObserve(n, r, acc) => {
                    b(!*acc) + b((*r == Res::Pass) == Self::cur_truth(f, *n))
                }
                Action::FDefer(n) => b(!self.a3) + b(f.ver[*n as usize] != f.trunk[*n as usize]),
                _ => 1,
            },
        }
    }

    // --- free --------------------------------------------------------------------------------------------------

    fn fobs_ver(&self, f: &F, n: u8) -> u8 {
        if self.clause(Cl::K1) || !self.a3 { f.ver[n as usize] } else { 0 }
    }
    fn fkey(f: &F, n: u8) -> (u8, u8) {
        (n, f.ver[n as usize])
    }
    fn fevent(f: &F, op: Op, n: u8, key: (u8, u8), result: Res, rank: u8, accurate: bool, truth: bool) -> FEv {
        FEv { op, n, key, kind: f.kind[n as usize], result, rank, accurate, truth }
    }
    fn cur_truth(f: &F, n: u8) -> bool {
        f.truth[n as usize][f.ver[n as usize] as usize]
    }
    fn in_queue(f: &F, n: u8) -> bool {
        f.queue.contains(&n)
    }
    fn drop_q(q: &[u8], n: u8) -> Vec<u8> {
        // FDrop for queues of length <= 2 (the only ones reachable: two nodes, no duplicates).
        match q.len() {
            0 => Vec::new(),
            1 => {
                if q[0] == n {
                    Vec::new()
                } else {
                    q.to_vec()
                }
            }
            _ => {
                if q[0] == n {
                    vec![q[1]]
                } else if q[1] == n {
                    vec![q[0]]
                } else {
                    q.to_vec()
                }
            }
        }
    }
    /// `FDebt(n,v) # {}`; the element is <<n,v>> under K3 and n otherwise.
    fn fdebt(f: &F, n: u8, v: u8) -> bool {
        !(f.obs[n as usize][v as usize] == PASS || f.state_w & kbit(n, v) != 0)
    }
    fn fguard(&self, f: &F, n: u8) -> bool {
        let (kn, kv) = Self::fkey(f, n);
        let waived = f.waivers & kbit(kn, kv) != 0;
        let ov = self.fobs_ver(f, n);
        let c1 = !self.clause(Cl::K4) || f.genesis;
        let c2 = !self.a3 || waived || f.node_obs[n as usize][ov as usize] == PASS;
        let no_blocks = (0..f.hist.len()).all(|i| !has(f.blocks, i) || f.hist[i].n != n);
        let c3 = waived || !self.clause(Cl::K2) || (no_blocks && f.conflict & (1 << n) == 0);
        let tr = f.trunk[n as usize];
        let sub = !Self::fdebt(f, n, ov) || (Self::fdebt(f, n, tr) && (!self.clause(Cl::K3) || ov == tr));
        let c4 = f.deferrals & kbit(kn, kv) != 0 || sub;
        c1 && c2 && c3 && c4
    }

    fn free_init(&self) -> Vec<F> {
        let mut v = Vec::new();
        // \E base \in [FNodes -> BOOLEAN], kinds \in [FNodes -> {"judgment","execution"}] (TLC order: functions
        // in normalized order; the order only matters for the TLC-order count).
        for b0 in [false, true] {
            for b1 in [false, true] {
                for k0 in [Kind::Execution, Kind::Judgment] {
                    for k1 in [Kind::Execution, Kind::Judgment] {
                        let base = [b0, b1];
                        let f = F {
                            kind: [k0, k1],
                            ver: [0, 0],
                            truth: [[base[0], true, true], [base[1], true, true]],
                            obs: [[0; 3]; 2],
                            node_obs: [[0; 3]; 2],
                            trunk: [0, 0],
                            epoch: 0,
                            genesis: false,
                            hist: Vec::new(),
                            inputs: 0,
                            blocks: 0,
                            reproduced: 0,
                            conflict: 0,
                            waivers: 0,
                            deferrals: 0,
                            state_w: 0,
                            queue: Vec::new(),
                            lease: NO_LEASE,
                            done: 0,
                            eval: [Eval { valid: false, epoch: 0, ver: 0, at: 0 }; 2],
                            receipts: Vec::new(),
                        };
                        let replay_ok = match self.sc {
                            Scenario::ReplayNegative => f.kind[0] == Kind::Judgment && !f.truth[0][0],
                            Scenario::ReplayDeferred => f.truth[0][0],
                            _ => true,
                        };
                        if replay_ok {
                            v.push(f);
                        }
                    }
                }
            }
        }
        v
    }

    fn f_genesis(&self, f: &F) -> Option<F> {
        if f.genesis {
            return None;
        }
        let mut t = f.clone();
        t.genesis = true;
        for n in 0..2 {
            t.obs[n][0] |= if f.truth[n][0] { PASS } else { FAIL };
        }
        t.hist.push(Self::fevent(f, Op::Genesis, K0, (K0, 0), Res::None, 2, true, true));
        Some(t)
    }
    fn f_edit(&self, f: &F, n: u8, b: bool) -> Option<F> {
        let ni = n as usize;
        if f.done & (1 << n) != 0 || f.ver[ni] >= 2 || f.inputs >= FLIMIT {
            return None;
        }
        let mut t = f.clone();
        t.ver[ni] += 1;
        t.truth[ni][f.ver[ni] as usize + 1] = b;
        t.inputs += 1;
        t.eval[ni].valid = false;
        t.hist.push(Self::fevent(f, Op::Edit, n, (n, f.ver[ni] + 1), Res::None, 0, false, b));
        Some(t)
    }
    fn f_observe(&self, f: &F, n: u8, r: Res, rank: u8, accurate: bool) -> Option<F> {
        let ni = n as usize;
        if f.done & (1 << n) != 0 || f.inputs >= FLIMIT || (accurate && (r == Res::Pass) != Self::cur_truth(f, n)) {
            return None;
        }
        let mut t = f.clone();
        t.inputs += 1;
        t.node_obs[ni][self.fobs_ver(f, n) as usize] |= rbit(r);
        t.hist.push(Self::fevent(f, Op::Observe, n, Self::fkey(f, n), r, rank, accurate, Self::cur_truth(f, n)));
        t.blocks = if r == Res::Fail {
            f.blocks | (1 << f.hist.len())
        } else {
            let mut m = 0;
            for i in 0..f.hist.len() {
                if has(f.blocks, i) {
                    let keep = f.hist[i].n != n
                        || if f.kind[ni] == Kind::Judgment { f.hist[i].rank > rank } else { !has(f.reproduced, i) };
                    if keep {
                        m |= 1 << i;
                    }
                }
            }
            m
        };
        Some(t)
    }
    fn f_state_observe(&self, f: &F, n: u8, r: Res, accurate: bool) -> Option<F> {
        let ni = n as usize;
        if f.done & (1 << n) != 0 || f.inputs >= FLIMIT || (accurate && (r == Res::Pass) != Self::cur_truth(f, n)) {
            return None;
        }
        let mut t = f.clone();
        t.inputs += 1;
        t.obs[ni][self.fobs_ver(f, n) as usize] |= rbit(r);
        let mut ev = Self::fevent(f, Op::Observe, n, Self::fkey(f, n), r, 1, accurate, Self::cur_truth(f, n));
        ev.kind = Kind::State;
        t.hist.push(ev);
        Some(t)
    }
    fn f_rerun(&self, f: &F, i: usize, r: Res) -> Option<F> {
        let h = f.hist[i];
        if !has(f.blocks, i) || h.kind != Kind::Execution || f.done & (1 << h.n) != 0 || f.inputs >= FLIMIT {
            return None;
        }
        let mut t = f.clone();
        t.inputs += 1;
        t.hist.push(Self::fevent(f, Op::Rerun, h.n, h.key, r, 1, false, f.truth[h.n as usize][h.key.1 as usize]));
        if r == Res::Fail {
            for j in 0..f.hist.len() {
                if has(f.blocks, j) && f.hist[j].n == h.n && f.hist[j].key == h.key {
                    t.reproduced |= 1 << j;
                }
            }
        } else {
            t.conflict |= 1 << h.n;
        }
        Some(t)
    }
    fn f_record(&self, f: &F, n: u8, op: Op) -> Option<F> {
        // FWaive / FDefer / FStateWaive
        let (kn, kv) = Self::fkey(f, n);
        let kb = kbit(kn, kv);
        if f.done & (1 << n) != 0 || f.inputs >= FLIMIT {
            return None;
        }
        let mut t = f.clone();
        match op {
            Op::Waiver => {
                if f.waivers & kb != 0 {
                    return None;
                }
                t.waivers |= kb;
            }
            Op::Defer => {
                if f.deferrals & kb != 0 || (self.a3 && f.ver[n as usize] == f.trunk[n as usize]) {
                    return None;
                }
                t.deferrals |= kb;
            }
            Op::StateWaiver => {
                if self.clause(Cl::K3state) || f.state_w & kb != 0 {
                    return None;
                }
                t.state_w |= kb;
            }
            _ => unreachable!(),
        }
        t.inputs += 1;
        t.hist.push(Self::fevent(f, op, n, (kn, kv), Res::None, 3, true, Self::cur_truth(f, n)));
        Some(t)
    }
    fn f_eval_target(f: &F, n: u8) -> Eval {
        Eval { valid: true, epoch: f.epoch, ver: f.ver[n as usize], at: f.hist.len() as u8 }
    }
    fn f_commit(&self, f: &F, n: u8) -> Option<F> {
        let ni = n as usize;
        let ev = f.eval[ni];
        if f.done & (1 << n) != 0 || !Self::in_queue(f, n) || !ev.valid || ev.epoch != f.epoch || ev.ver != f.ver[ni] {
            return None;
        }
        if self.clause(Cl::K5queue) && f.queue[0] != n {
            return None;
        }
        if self.clause(Cl::K5atomic) && !self.fguard(f, n) {
            return None;
        }
        let (kn, kv) = Self::fkey(f, n);
        let kb = kbit(kn, kv);
        let ov = self.fobs_ver(f, n) as usize;
        let mut t = f.clone();
        t.done |= 1 << n;
        t.trunk[ni] = f.ver[ni];
        t.epoch += 1;
        t.queue = Self::drop_q(&f.queue, n);
        if f.lease == n {
            t.lease = NO_LEASE;
        }
        t.receipts.push(Receipt {
            n,
            key: (kn, kv),
            truth: Self::cur_truth(f, n),
            prekey: (n, f.trunk[ni]),
            pretruth: f.truth[ni][f.trunk[ni] as usize],
            at: f.hist.len() as u8,
            eval_at: ev.at,
            waived: f.waivers & kb != 0,
            deferred: f.deferrals & kb != 0,
            state_w: f.state_w & kb != 0,
            debt: f.obs[ni][ov] != PASS && f.state_w & kb == 0,
            node_debt: f.node_obs[ni][ov] != PASS && f.waivers & kb == 0,
            lease: f.lease,
        });
        t.hist.push(Self::fevent(f, Op::Commit, n, (kn, kv), Res::None, 0, false, Self::cur_truth(f, n)));
        Some(t)
    }

    fn free_next(&self, f: &F, out: &mut Vec<(Action, State)>) {
        let mut push = |a: Action, t: Option<F>| {
            if let Some(t) = t {
                out.push((a, State::Free(t)));
            }
        };
        push(Action::FGenesis, self.f_genesis(f));
        if f.lease != NO_LEASE {
            let mut t = f.clone();
            t.lease = NO_LEASE;
            push(Action::FExpire, Some(t));
        }
        if f.done == 3 {
            push(Action::FFinished, Some(f.clone()));
        }
        for n in [K0, K1] {
            let ni = n as usize;
            let not_done = f.done & (1 << n) == 0;
            // FEnqueue
            if not_done && !Self::in_queue(f, n) {
                let mut t = f.clone();
                t.queue.push(n);
                push(Action::FEnqueue(n), Some(t));
            }
            // FLease
            if !f.queue.is_empty() && f.queue[0] == n && f.lease == NO_LEASE {
                let mut t = f.clone();
                t.lease = n;
                push(Action::FLease(n), Some(t));
            }
            // FEval
            if not_done && Self::in_queue(f, n) && self.fguard(f, n) && f.eval[ni] != Self::f_eval_target(f, n) {
                let mut t = f.clone();
                t.eval[ni] = Self::f_eval_target(f, n);
                push(Action::FEval(n), Some(t));
            }
            push(Action::FCommit(n), self.f_commit(f, n));
            // FCancel
            if not_done && f.inputs == FLIMIT {
                let mut t = f.clone();
                t.done |= 1 << n;
                t.queue = Self::drop_q(&f.queue, n);
                if f.lease == n {
                    t.lease = NO_LEASE;
                }
                push(Action::FCancel(n), Some(t));
            }
            push(Action::FWaive(n), self.f_record(f, n, Op::Waiver));
            push(Action::FDefer(n), self.f_record(f, n, Op::Defer));
            push(Action::FStateWaive(n), self.f_record(f, n, Op::StateWaiver));
            for b in [false, true] {
                push(Action::FEdit(n, b), self.f_edit(f, n, b));
            }
            for r in [Res::Fail, Res::Pass] {
                for acc in [false, true] {
                    push(Action::FStateObserve(n, r, acc), self.f_state_observe(f, n, r, acc));
                }
            }
            for r in [Res::Fail, Res::Pass] {
                for rank in [1, 2] {
                    for acc in [false, true] {
                        push(Action::FObserve(n, r, rank, acc), self.f_observe(f, n, r, rank, acc));
                    }
                }
            }
        }
        for i in 0..f.hist.len() {
            if has(f.blocks, i) {
                for r in [Res::Fail, Res::Pass] {
                    push(Action::FRerun(i as u8 + 1, r), self.f_rerun(f, i, r));
                }
            }
        }
    }

    fn replay_next(&self, f: &F, out: &mut Vec<(Action, State)>) {
        let one = |a: Action, t: Option<F>, out: &mut Vec<(Action, State)>| {
            if let Some(t) = t {
                out.push((a, State::Free(t)));
            }
        };
        let neg = self.sc == Scenario::ReplayNegative;
        match f.hist.len() {
            0 => one(Action::FGenesis, self.f_genesis(f), out),
            1 if neg => one(Action::FObserve(K0, Res::Fail, 1, true), self.f_observe(f, K0, Res::Fail, 1, true), out),
            2 if neg => one(Action::FObserve(K0, Res::Pass, 1, false), self.f_observe(f, K0, Res::Pass, 1, false), out),
            3 if neg => one(Action::FEdit(K0, false), self.f_edit(f, K0, false), out),
            4 if neg => one(Action::FDefer(K0), self.f_record(f, K0, Op::Defer), out),
            1 if !neg => one(Action::FEdit(K0, false), self.f_edit(f, K0, false), out),
            2 if !neg => one(Action::FDefer(K0), self.f_record(f, K0, Op::Defer), out),
            3 if !neg => one(Action::FObserve(K0, Res::Pass, 1, false), self.f_observe(f, K0, Res::Pass, 1, false), out),
            _ => self.free_next(f, out),
        }
    }

    // --- properties -------------------------------------------------------------------------------------------

    fn x<'a>(s: &'a State) -> &'a X {
        match s {
            State::Script(x) => x,
            State::Free(_) => panic!("scripted property evaluated on a free state (TLC: x = [unused |-> TRUE])"),
        }
    }
    fn f<'a>(s: &'a State) -> &'a F {
        match s {
            State::Free(f) => f,
            State::Script(_) => panic!("free property evaluated on a scripted state"),
        }
    }

    /// Scripted history with the scenario's constant fields made explicit, as free events.
    fn script_hist(&self, x: &X) -> Vec<FEv> {
        let kind = self.skind();
        let truth = !self.bad();
        x.hist
            .iter()
            .map(|e| FEv { op: e.op, n: K0, key: (e.key, 0), kind, result: e.result, rank: e.rank, accurate: e.accurate, truth })
            .collect()
    }

    fn no_bypassed_negative(&self, s: &State) -> bool {
        if self.free_scenario() {
            let f = Self::f(s);
            f.receipts.iter().all(|c| h_no_bypass(&f.hist[..c.at as usize], c.n, !c.truth, c.waived))
        } else {
            let x = Self::x(s);
            !x.merged || h_no_bypass(&self.script_hist(x), K0, self.bad(), x.waiver)
        }
    }

    fn escape_attributable_script(&self, x: &X) -> bool {
        let h = self.script_hist(x);
        !x.merged
            || !self.bad()
            || (x.debt_after && !x.state_waiver && !x.waiver)
            || x.waiver
            || x.state_waiver
            || x.deferred
            || h_blame(&h, K0, (x.key, 0))
    }

    fn escape_attributable(&self, s: &State) -> bool {
        if self.free_scenario() {
            let f = Self::f(s);
            f.receipts.iter().all(|c| {
                let p = &f.hist[..c.at as usize];
                c.truth
                    || ((c.debt || c.state_w || c.deferred || h_false_affirm(p, c.n, c.key, true))
                        && (c.node_debt || c.waived || h_false_affirm(p, c.n, c.key, false)))
            })
        } else {
            self.escape_attributable_script(Self::x(s))
        }
    }

    fn node_acceptance_covered(&self, s: &State) -> bool {
        if self.free_scenario() {
            let f = Self::f(s);
            f.receipts.iter().all(|c| c.waived || h_affirm(&f.hist[..c.at as usize], c.n, c.key, false))
        } else {
            true
        }
    }

    fn new_escape_attributable(&self, s: &State) -> bool {
        if self.free_scenario() {
            let f = Self::f(s);
            f.receipts.iter().all(|c| {
                c.key == c.prekey || c.truth || c.waived || c.deferred || h_blame(&f.hist[..c.at as usize], c.n, c.key)
            })
        } else {
            !self.changed() || self.escape_attributable_script(Self::x(s))
        }
    }

    fn no_laundering(&self, s: &State) -> bool {
        if self.free_scenario() {
            let f = Self::f(s);
            f.receipts.iter().all(|c| {
                c.truth
                    || c.waived
                    || !f.hist[..c.at as usize].iter().any(|h| h.op == Op::Observe && h.n == c.n && h.result == Res::Fail && h.accurate)
            })
        } else {
            !Self::x(s).bad_merged
        }
    }

    fn no_flaky_rerun_escape(&self, s: &State) -> bool {
        if self.free_scenario() {
            let f = Self::f(s);
            f.receipts.iter().all(|c| {
                c.waived || !f.hist[..c.at as usize].iter().any(|h| h.op == Op::Rerun && h.n == c.n && h.result == Res::Pass)
            })
        } else {
            let x = Self::x(s);
            !(x.merged && x.rerun_done && x.original & PASS != 0 && !x.waiver)
        }
    }

    fn free_no_new_breakage(f: &F) -> bool {
        f.receipts.iter().all(|c| !(c.pretruth && !c.truth) || c.deferred)
    }

    fn judged_at_commit(&self, s: &State) -> bool {
        if self.free_scenario() {
            let f = Self::f(s);
            f.receipts.iter().all(|c| {
                let p = &f.hist[..c.at as usize];
                c.waived
                    || ((c.eval_at as usize + 1)..=(c.at as usize)).all(|i| {
                        let h = &f.hist[i - 1];
                        !(h.op == Op::Observe && h.n == c.n && h.kind != Kind::State && h.result == Res::Fail)
                            || (1..=c.at as usize).any(|j| h_positive(p, i, j, c.key))
                    })
            })
        } else {
            !Self::x(s).fresh_block_merged
        }
    }

    fn genesis_before_advance(&self, s: &State) -> bool {
        if self.free_scenario() {
            let f = Self::f(s);
            f.receipts.iter().all(|c| f.hist[..c.at as usize].iter().any(|h| h.op == Op::Genesis))
        } else {
            !Self::x(s).unobserved_merged
        }
    }

    fn state_never_waived(&self, s: &State) -> bool {
        if self.free_scenario() { Self::f(s).receipts.iter().all(|c| !c.state_w) } else { !Self::x(s).waived_state_merged }
    }

    fn deferred_debt_visible(&self, s: &State) -> bool {
        if self.free_scenario() {
            let f = Self::f(s);
            f.receipts.iter().all(|c| !(c.deferred && !c.debt) || h_affirm(&f.hist[..c.at as usize], c.n, c.key, true))
        } else {
            let x = Self::x(s);
            !(x.merged && x.deferred && !x.debt_after) || h_affirm(&self.script_hist(x), K0, (x.key, 0), true)
        }
    }

    fn lease_excludes(&self, s: &State) -> bool {
        if self.free_scenario() {
            Self::f(s).receipts.iter().all(|c| c.lease == NO_LEASE || c.lease == c.n)
        } else {
            !Self::x(s).conflict_merge
        }
    }

    fn nothing_merged(&self, s: &State) -> bool {
        if self.free_scenario() { Self::f(s).receipts.is_empty() } else { !Self::x(s).merged }
    }
    fn no_deferred_merge(&self, s: &State) -> bool {
        if self.free_scenario() {
            Self::f(s).receipts.iter().all(|c| !c.deferred)
        } else {
            let x = Self::x(s);
            !(x.merged && x.deferred)
        }
    }
    fn no_owner_waived_merge(&self, s: &State) -> bool {
        if self.free_scenario() {
            Self::f(s).receipts.iter().all(|c| !c.waived)
        } else {
            let x = Self::x(s);
            !(x.merged && x.waiver)
        }
    }

    fn free_core_safety(&self, s: &State) -> bool {
        self.no_flaky_rerun_escape(s)
            && self.judged_at_commit(s)
            && self.genesis_before_advance(s)
            && self.state_never_waived(s)
            && self.lease_excludes(s)
            && self.escape_attributable(s)
            && self.no_bypassed_negative(s)
            && self.deferred_debt_visible(s)
            && self.node_acceptance_covered(s)
    }
}

// History predicates (on a prefix `h`; positions are 1-based as in TLA+).

/// `HPositive(h,i,j,key)`.
fn h_positive(h: &[FEv], i: usize, j: usize, key: (u8, u8)) -> bool {
    let (hi, hj) = (&h[i - 1], &h[j - 1]);
    j > i
        && hj.op == Op::Observe
        && hj.result == Res::Pass
        && hj.n == hi.n
        && hj.key == key
        && if hi.kind == Kind::Judgment {
            hj.rank >= hi.rank
        } else {
            ((i + 1)..j).any(|r| {
                let hr = &h[r - 1];
                hr.op == Op::Rerun && hr.n == hi.n && hr.key == hi.key && hr.result == Res::Fail
            })
        }
}

/// `HWithdrawn(h,i)`.
fn h_withdrawn(h: &[FEv], i: usize) -> bool {
    let hi = &h[i - 1];
    if hi.kind == Kind::Judgment {
        ((i + 1)..=h.len()).any(|j| {
            let hj = &h[j - 1];
            hj.op == Op::Observe && hj.kind == Kind::Judgment && hj.n == hi.n && hj.result == Res::Pass && hj.rank >= hi.rank
        })
    } else {
        ((i + 1)..=h.len()).any(|j| {
            let hj = &h[j - 1];
            hj.op == Op::Rerun && hj.n == hi.n && hj.key == hi.key && hj.result == Res::Fail
        })
    }
}

/// `HNoBypass(h,n,key,bad,waived)` (key is not used by the definition).
fn h_no_bypass(h: &[FEv], n: u8, bad: bool, waived: bool) -> bool {
    !bad || waived
        || (1..=h.len()).all(|i| {
            let hi = &h[i - 1];
            !(hi.op == Op::Observe && hi.n == n && hi.kind != Kind::State && hi.result == Res::Fail && hi.accurate) || h_withdrawn(h, i)
        })
}

/// `HAffirm(h,n,key,state)`.
fn h_affirm(h: &[FEv], n: u8, key: (u8, u8), state: bool) -> bool {
    h.iter().any(|e| e.op == Op::Observe && e.n == n && e.key == key && e.result == Res::Pass && (e.kind == Kind::State) == state)
}

/// `HFalseAffirm(h,n,key,state)`.
fn h_false_affirm(h: &[FEv], n: u8, key: (u8, u8), state: bool) -> bool {
    h.iter().any(|e| {
        e.op == Op::Observe && e.n == n && e.key == key && e.result == Res::Pass && !e.truth && (e.kind == Kind::State) == state
    })
}

/// `HBlame(h,n,key)`.
fn h_blame(h: &[FEv], n: u8, key: (u8, u8)) -> bool {
    h.iter().any(|e| e.op == Op::Observe && e.n == n && e.key == key && e.result == Res::Pass && !e.truth)
}

impl Model for Merge {
    type State = State;
    type Action = Action;

    fn init(&self) -> Vec<State> {
        if self.free_scenario() {
            self.free_init().into_iter().map(State::Free).collect()
        } else {
            vec![State::Script(self.script_init())]
        }
    }

    fn next(&self, s: &State, out: &mut Vec<(Action, State)>) {
        match s {
            State::Script(x) => self.script_next(x, out),
            State::Free(f) => {
                if self.sc == Scenario::Free {
                    self.free_next(f, out)
                } else {
                    self.replay_next(f, out)
                }
            }
        }
    }

    /// Properties that read only `x` (NoUnrelatedMerge, NoOldDebtMerge, GoodEventuallyMerges) are not offered in
    /// the free scenarios, and FreeNoTwoMerges (reads only `f`) not in the scripted ones: TLC would fail evaluating
    /// them there (`x = [unused |-> TRUE]` has no field `merged`); selecting one is an "unknown property" ERROR.
    fn properties(&self) -> Vec<Property<Self>> {
        let free = self.free_scenario();
        let only_x = ["NoUnrelatedMerge", "NoOldDebtMerge", "GoodEventuallyMerges"];
        let only_f = ["FreeNoTwoMerges"];
        let mut v = vec![
            Property::Invariant { name: "NoBypassedNegative", holds: |m: &Merge, s| m.no_bypassed_negative(s) },
            Property::Invariant { name: "EscapeAttributable", holds: |m: &Merge, s| m.escape_attributable(s) },
            Property::Invariant { name: "NodeAcceptanceCovered", holds: |m: &Merge, s| m.node_acceptance_covered(s) },
            Property::Invariant { name: "NewEscapeAttributable", holds: |m: &Merge, s| m.new_escape_attributable(s) },
            Property::Invariant { name: "NoLaundering", holds: |m: &Merge, s| m.no_laundering(s) },
            Property::Invariant { name: "NoFlakyRerunEscape", holds: |m: &Merge, s| m.no_flaky_rerun_escape(s) },
            // [][IF FreeScenario THEN FreeNoNewBreakage' ELSE ...]_vars: stuttering steps satisfy it.
            Property::Action {
                name: "NoNewBreakage",
                holds: |m: &Merge, s, _a, t| {
                    if s == t {
                        return true;
                    }
                    if m.free_scenario() {
                        Merge::free_no_new_breakage(Merge::f(t))
                    } else {
                        let (x, y) = (Merge::x(s), Merge::x(t));
                        !(y.merged && !x.merged && x.truth && !y.truth) || x.deferred
                    }
                },
            },
            Property::Invariant { name: "JudgedAtCommit", holds: |m: &Merge, s| m.judged_at_commit(s) },
            Property::Invariant { name: "GenesisBeforeAdvance", holds: |m: &Merge, s| m.genesis_before_advance(s) },
            Property::Invariant { name: "StateNeverWaived", holds: |m: &Merge, s| m.state_never_waived(s) },
            Property::Invariant { name: "DeferredDebtVisible", holds: |m: &Merge, s| m.deferred_debt_visible(s) },
            Property::Invariant { name: "LeaseExcludes", holds: |m: &Merge, s| m.lease_excludes(s) },
            Property::Invariant { name: "NothingMerged", holds: |m: &Merge, s| m.nothing_merged(s) },
            Property::Invariant { name: "NoDeferredMerge", holds: |m: &Merge, s| m.no_deferred_merge(s) },
            Property::Invariant { name: "NoOwnerWaivedMerge", holds: |m: &Merge, s| m.no_owner_waived_merge(s) },
            Property::Invariant {
                name: "NoUnrelatedMerge",
                holds: |_m: &Merge, s| {
                    let x = Merge::x(s);
                    !(x.merged && x.unrelated)
                },
            },
            Property::Invariant { name: "NoOldDebtMerge", holds: |m: &Merge, s| !(Merge::x(s).merged && !m.pre_truth()) },
            Property::Eventually { name: "GoodEventuallyMerges", q: |_m: &Merge, s| Merge::x(s).merged },
            Property::Invariant { name: "FreeCoreSafety", holds: |m: &Merge, s| m.free_core_safety(s) },
            Property::Invariant { name: "FreeNoTwoMerges", holds: |_m: &Merge, s| Merge::f(s).receipts.len() < 2 },
        ];
        v.retain(|p| if free { !only_x.contains(&p.name()) } else { !only_f.contains(&p.name()) });
        v
    }

    /// ScriptFair: one WF class per action (WF_x(Genesis), WF_x(LiveStart), ...); the free scenarios are unfair.
    fn fairness(&self, a: &Action) -> Option<&'static str> {
        if self.free_scenario() {
            return None;
        }
        match a {
            Action::Genesis => Some("Genesis"),
            Action::LiveStart => Some("LiveStart"),
            Action::Acquire => Some("Acquire"),
            Action::Prepare => Some("Prepare"),
            Action::Validate => Some("Validate"),
            Action::LiveCommit => Some("LiveCommit"),
            Action::Rebase => Some("Rebase"),
            Action::Expire => Some("Expire"),
            _ => None,
        }
    }
}

fn build(mode: &str, c: &mut Consts) -> Result<Box<dyn DynModel>, String> {
    let sc = c.string("Scenario", "good");
    Ok(Box::new(Merge::new(mode, &sc)?))
}

pub fn info() -> ModelInfo {
    ModelInfo {
        name: "a3_merge",
        about: "port of PiDagMerge.tla (a3 merge guard K1-K5: scripted scenarios, live queue, free interleavings)",
        modes: MODES,
        consts: &[("Scenario", "good")],
        source_file: file!(),
        source: include_str!("merge.rs"),
        build,
    }
}
