//! owed05: owed 0.5 acceptance and authority, as implemented (src/reducer.ts, src/ops.ts, src/plan.ts,
//! src/extension.ts, src/cli.ts at the trunk that merged release-0.5.0). See formal/REPORT-mc-owed.md for the
//! model-to-code map (file:line), the bounds, the results and the ablations.
//!
//! Universe: one node `A` (no deps) with one check `t`, the review/approve/evidence obligations, and the trunk with
//! one invariant `inv`. Principals are claims (`role:id`); processes are the truth behind them: the main agent
//! (owner and parent), the driver (`parent:drive`), subagent writers and reviewers (pi-durable-subagents calls, with
//! DSA_CALL in their environment), and in mode `forge` a process that appends entries to the ledger directly (SPEC §1
//! threat model: owed does not resist it; only replay validation, reducer `validateDraft`, refuses its entries).
//!
//! Content truth is hidden from the rules and visible to the properties: a candidate is `Good`, `Bad` (fails the
//! strict check `t`), `Flaky` (the strict check passes or fails) or `Breaks` (passes `t`, breaks the invariant).
//! The executor is honest: every observation carries a verdict the truth allows (the forger too: forging executor
//! verdicts is outside every guarantee). Keys are content-addressed as in SPEC §4: a check key is (content, base tree,
//! check definition, exec), a patch key (content, base), an invariant key (trunk tree, exec).
//!
//! Each transition appends at most one ledger entry (ops.merge/adopt append their measurements and the merge/adopt
//! entry under one lock; here they are separate steps, an over-approximation of the interleavings).

use mc::{Consts, DynModel, Model, ModelInfo, Property};

// ------------------------------------------------------------------------------------------------------------------
// Domains

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub enum Content {
    Good,
    Bad,
    Flaky,
    Breaks,
}
pub const CONTENTS: [Content; 4] = [Content::Good, Content::Bad, Content::Flaky, Content::Breaks];

/// The adopted part of a trunk tree: none, or one adopted commit (`true` = it breaks the invariant).
pub type Base = Option<bool>;
fn base_idx(b: Base) -> u32 {
    match b {
        None => 0,
        Some(false) => 1,
        Some(true) => 2,
    }
}

/// A trunk tree: T0, at most one adopted commit, at most one merge of A (the merge ends the experiment).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub struct Tree {
    pub adopt: Base,
    pub merged: Option<Content>,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub struct CheckKey {
    pub c: Content,
    pub base: Base,
    pub weak: bool,
    pub exec: bool,
}
impl CheckKey {
    fn bit(self) -> u64 {
        let i = ((self.c as u32 * 3 + base_idx(self.base)) * 2 + self.weak as u32) * 2 + self.exec as u32;
        1u64 << i
    }
}
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub struct InvKey {
    pub tree: Tree,
    pub exec: bool,
}
impl InvKey {
    fn bit(self) -> u32 {
        let m = match self.tree.merged {
            None => 0,
            Some(c) => 1 + c as u32,
        };
        1u32 << ((base_idx(self.tree.adopt) * 5 + m) * 2 + self.exec as u32)
    }
}
/// `patch` (SPEC §4): the diff of the candidate against its base; keys of review, approve and evidence.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub struct Patch {
    pub c: Content,
    pub base: Base,
}
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub enum Key {
    Check(CheckKey),
    Patch(Patch),
}

/// Principals (claims). Ids: owner:pi, parent:main, parent:drive, writer:A#k, reviewer:r<i>, reviewer:A#k, executor:owed.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub enum P {
    Owner,
    ParentMain,
    ParentDrive,
    Writer(u8),
    Rev(u8),
    /// `reviewer:A#k`: a reviewer claim sharing its id with writer `writer:A#k`.
    RevW(u8),
    Exec,
}
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Role {
    Owner,
    Parent,
    Writer,
    Reviewer,
    Executor,
}
impl P {
    pub fn role(self) -> Role {
        match self {
            P::Owner => Role::Owner,
            P::ParentMain | P::ParentDrive => Role::Parent,
            P::Writer(_) => Role::Writer,
            P::Rev(_) | P::RevW(_) => Role::Reviewer,
            P::Exec => Role::Executor,
        }
    }
    /// `k` when the id after the colon is `A#k` (the writer id of attempt k).
    fn writer_id(self) -> Option<u8> {
        match self {
            P::Writer(k) | P::RevW(k) => Some(k),
            _ => None,
        }
    }
}

/// Processes (truth). Subagents run with DSA_CALL set.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Proc {
    Main,
    Driver,
    WriterSub,
    ReviewerSub,
    Forger,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub enum Chk {
    Absent,
    Strict,
    /// The definition of `t` changed so that it passes every content (e.g. `run: true`).
    Weak,
}
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub enum Ev {
    None,
    Reviewer,
    Owner,
}

/// Allow rules (each one rule with `nodes` default `["*"]`): `review_count: 0`, `checks: ["*"]`, `adopt: ["data/"]`.
pub const RC0: u8 = 1;
pub const CK: u8 = 2;
pub const AD: u8 = 4;

/// The plan, restricted to what the model varies. `exec` = a non-empty `exec` block that passes everything
/// (`wrap: ["true"]`, D20.4).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct Plan {
    pub check: Chk,
    pub exec: bool,
    pub rcount: u8,
    pub rrank: u8,
    pub approve: bool,
    pub evid: Ev,
    pub allow: u8,
}
impl Plan {
    /// Plans that differ from `self` in one field; with `combos` also those that toggle one allow rule and change
    /// one other field (the plan updates the model explores).
    fn updates(self, combos: bool) -> Vec<Plan> {
        let one = self.neighbors();
        if !combos {
            return one;
        }
        let mut v = one.clone();
        for bit in [RC0, CK, AD] {
            for p in &one {
                if p.allow == self.allow {
                    let q = Plan { allow: p.allow ^ bit, ..*p };
                    if !v.contains(&q) {
                        v.push(q);
                    }
                }
            }
        }
        v
    }
    fn neighbors(self) -> Vec<Plan> {
        let mut v = Vec::new();
        for c in [Chk::Absent, Chk::Strict, Chk::Weak] {
            if c != self.check {
                v.push(Plan { check: c, ..self });
            }
        }
        v.push(Plan { exec: !self.exec, ..self });
        for n in 0..=2 {
            if n != self.rcount {
                v.push(Plan { rcount: n, ..self });
            }
        }
        v.push(Plan { rrank: if self.rrank == 1 { 2 } else { 1 }, ..self });
        v.push(Plan { approve: !self.approve, ..self });
        for e in [Ev::None, Ev::Reviewer, Ev::Owner] {
            if e != self.evid {
                v.push(Plan { evid: e, ..self });
            }
        }
        for bit in [RC0, CK, AD] {
            v.push(Plan { allow: self.allow ^ bit, ..self });
        }
        v
    }
    /// Node spec of A (reducer.ts:166 compares it without `type`): check, review, approve, evidence.
    fn same_spec(self, o: Plan) -> bool {
        (self.check, self.rcount, self.rrank, self.approve, self.evid) == (o.check, o.rcount, o.rrank, o.approve, o.evid)
    }
}

/// Downgrade items: as detected by the reducer (downgradeDetails) and as claimed by ops (plan.ts planDowngrades).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub enum Dg {
    /// `t check removed` (reducer) / `check t removed` (planDowngrades)
    CheckRemoved,
    /// `t check definition changed; cannot prove obligations were not reduced` (reducer only)
    CheckDefChanged,
    /// `review count/rank reduced` (reducer)
    ReviewReduced,
    /// `review count lowered` (planDowngrades)
    ReviewCountLowered,
    /// `review rank lowered` (planDowngrades)
    ReviewRankLowered,
    ApproveRemoved,
    EvidenceRemoved,
    EvidenceWeakened,
    /// `{node: "*", what: "exec changed; ..."}` (reducer only)
    ExecChanged,
    /// `{node: "trunk", what: "allow changed"}`
    AllowChanged,
}

#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub enum Obl {
    Check,
    Review,
    Approve,
    Evidence,
}

/// How a block was cleared (ghost: which entry cleared it).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Clr {
    /// attribution rerun on the block's key failed (reducer.ts:196)
    AttrFail,
    /// attribution rerun passed and the ablation `flaky` cleared it
    AttrPass,
    /// a review ok (reducer.ts:205)
    Ok { by: P, rank: u8 },
    /// an owner waiver (reducer.ts:208); `cited` = its accept_risk named the block
    Waiver { by: P, cited: bool },
}
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum Bst {
    Active,
    Flaky,
    Cleared(Clr),
}
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct Block {
    pub judgment: bool,
    pub obl: Obl,
    pub key: Key,
    pub rank: u8,
    pub by: P,
    pub st: Bst,
}
impl Block {
    fn active(&self) -> bool {
        !matches!(self.st, Bst::Cleared(_))
    }
}
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub struct Rev {
    pub obl: Obl,
    pub key: Patch,
    pub by: P,
    pub rank: u8,
}
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub struct Evid {
    pub key: Patch,
    pub by: P,
}
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub struct Waiver {
    pub obl: Obl,
    pub key: Key,
    /// accept_risk as a bit set of block indices
    pub cites: u16,
    pub by: P,
}
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug, PartialOrd, Ord)]
pub struct Defer {
    pub key: InvKey,
    pub attempt: u8,
    pub by: P,
}
/// The current candidate: content, submit number (the pin's seq/commit) and the facts frozen at submit.
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct Cand {
    pub c: Content,
    pub id: u8,
    pub check: Chk,
    pub exec: bool,
    pub approve: bool,
    pub evid: bool,
}
/// An owner decision taken on a candidate, executed by a later tool step (pi dialog / CLI prompt / agent turn).
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub enum IntentKind {
    /// owed_approve: approvePreview pins the candidate (extension.ts), ops.approve checks it (ops.ts pinned); the
    /// decision is the dialog under the gate, the main agent's turn before the call when delegated
    Approve,
    /// owed_waive: the owner decided on the candidate it saw; ops.waive takes the key at append time, no pin
    Waive { obl: Obl, cites: u16 },
    /// owed_review as owner (rank 3): ops.review takes the key at append time, no pin
    Review,
}
#[derive(Clone, Copy, PartialEq, Eq, Hash, Debug)]
pub struct Intent {
    pub kind: IntentKind,
    pub cand: u8,
}

#[derive(Clone, PartialEq, Eq, Hash)]
pub struct S {
    pub plan: Plan,
    /// ghost: allow bits whose presence traces to the owner (genesis or an owner plan update)
    pub owner_rules: u8,
    pub trunk: Tree,
    pub attempt: u8,
    pub open: bool,
    pub base: Base,
    pub cand: Option<Cand>,
    /// executor verdicts per key: check pass/fail, invariant pass/fail (bit sets)
    pub cp: u64,
    pub cf: u64,
    pub ip: u32,
    pub ifl: u32,
    pub blocks: Vec<Block>,
    pub reviews: Vec<Rev>,
    pub evid: Vec<Evid>,
    pub waivers: Vec<Waiver>,
    pub defers: Vec<Defer>,
    pub intent: Option<Intent>,
    /// budgets used: submits, plan updates, subagent reviews/evidence, main-agent acts, forged entries
    pub nsub: u8,
    pub nplan: u8,
    pub nrev: u8,
    pub nmain: u8,
    pub nforge: u8,
}

/// A ledger entry (draft). Attempt, prior/CAS fields, facts and hashes are honest and implicit.
#[derive(Clone, PartialEq, Eq, Debug)]
pub enum E {
    Plan { by: P, to: Plan, claimed: Vec<Dg>, note: bool, delegated: bool },
    Dispatch { by: P },
    Abandon { by: P },
    Rebase { by: P },
    Submit { by: P, c: Content },
    ObsCheck { key: CheckKey, pass: bool, attribution: bool, merging: bool },
    ObsInv { key: InvKey, pass: bool, merging: bool },
    Review { by: P, obl: Obl, key: Patch, rank: u8, ok: bool },
    Evidence { by: P, key: Patch, files: bool },
    Waive { by: P, obl: Obl, key: Key, cites: u16, reason: bool, delegated: bool },
    Defer { by: P, key: InvKey, reason: bool, delegated: bool },
    Merge,
    Adopt { by: P, bad: bool, inside: bool, note: bool, delegated: bool },
}

#[derive(Clone, Debug)]
pub enum Action {
    /// `proc` appended `e` (accepted by the operation path, or by replay validation alone for the forger).
    Do { proc: Proc, e: E, pin: Option<Intent> },
    /// The owner decided (the dialog/turn starts) on the current candidate.
    Decide(Intent),
    /// The decided act was refused when executed; nothing recorded.
    Drop(Intent),
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Abl {
    /// validateDraft plan: downgrades need no owner
    OwnerDowngrade,
    /// covered() reads the allow rules of the new plan instead of the prior one
    NextAllow,
    /// allow widening is not a downgrade
    AllowFree,
    /// the `*` item (exec changed) is coverable by a checks rule
    StarCovered,
    /// D25.5: a delegated owner downgrade needs no note
    DelegatedNote,
    /// waive by a parent accepted
    WaiveRole,
    /// a waiver clears every active block of its obligation, cited or not
    WaiveCites,
    /// review recusal (writer ids) off
    Recusal,
    /// a same-rank ok by another reviewer clears a judgment block
    Dissent,
    /// an attribution pass clears the block instead of marking it flaky
    Flaky,
    /// mergeGuard checks only blocks and invariants (not acceptance/items)
    MergeGuard,
    /// mergeGuard: no "no new debt" invariant rule
    InvGuard,
    /// D25.3 refusal of owner/parent acts in a dsa call off
    Dsa,
    /// approve pin (review ruling #389) off
    Pin,
    /// approve recorded by any role, and counted by item() from any role (both checks of the rule)
    ApproveRole,
    /// parent adopt without an adopt allowance
    AdoptRole,
    /// evidence by a writer of the node accepted
    EvidenceWriter,
    /// a plan update does not invalidate the open candidate
    Invalidate,
}
pub const ABLATIONS: &[(&str, Abl)] = &[
    ("owner-downgrade", Abl::OwnerDowngrade),
    ("next-allow", Abl::NextAllow),
    ("allow-free", Abl::AllowFree),
    ("star-covered", Abl::StarCovered),
    ("delegated-note", Abl::DelegatedNote),
    ("waive-role", Abl::WaiveRole),
    ("waive-cites", Abl::WaiveCites),
    ("recusal", Abl::Recusal),
    ("dissent", Abl::Dissent),
    ("flaky", Abl::Flaky),
    ("merge-guard", Abl::MergeGuard),
    ("inv-guard", Abl::InvGuard),
    ("dsa", Abl::Dsa),
    ("pin", Abl::Pin),
    ("approve-role", Abl::ApproveRole),
    ("adopt-role", Abl::AdoptRole),
    ("evidence-writer", Abl::EvidenceWriter),
    ("invalidate", Abl::Invalidate),
];

/// Classes of entries replay validation accepts but the operation path would not append at that position.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Diff {
    /// a plan entry whose `downgrades` differ from what ops computes (planDowngrades)
    PlanClaims,
    /// an executor observation of an item that is not current (D24.1: runJobs drops it as superseded)
    ObsNotCurrent,
    /// a merge/adopt appended without the measurements ops.merge/ops.adopt append first
    Unmeasured,
    /// anything else (an authority or acceptance difference)
    Other,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Mode {
    /// every process uses the normal tools (any `--as` claim the tools let it make)
    Tools,
    /// Tools plus a process appending entries directly (only replay validation refuses them)
    Forge,
    /// Tools under OWED_CONFIRM=owner (owner acts confirmed by a dialog: channel pi-confirm, not delegated)
    Gate,
}

pub struct Owed05 {
    pub mode: Mode,
    /// ablations (bit set over `Abl`)
    pub abl: u32,
    /// plan updates also explore "toggle one allow rule + change one other field"
    pub combos: bool,
    pub genesis: Plan,
    pub contents: Vec<Content>,
    pub submits: u8,
    pub plans: u8,
    pub reviews: u8,
    pub main: u8,
    pub forge: u8,
    pub attempts: u8,
    pub adopt: bool,
    pub fair: bool,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum St {
    E,
    W,
    D,
}

fn check_truth(k: CheckKey) -> &'static [bool] {
    if k.weak || k.exec {
        return &[true];
    }
    match k.c {
        Content::Good | Content::Breaks => &[true],
        Content::Bad => &[false],
        Content::Flaky => &[true, false],
    }
}
fn inv_truth(k: InvKey) -> bool {
    k.exec || !(k.tree.adopt == Some(true) || k.tree.merged == Some(Content::Breaks))
}

impl Owed05 {
    fn ab(&self, a: Abl) -> bool {
        self.abl & (1 << a as u32) != 0
    }
    fn delegated(&self) -> bool {
        self.mode != Mode::Gate
    }

    // ---------------------------------------------------------------------------------------------------------
    // Plan downgrades: reducer.ts downgradeDetails/covered/uncoveredDowngrades, plan.ts planDowngrades.

    fn detected(&self, prev: &Plan, next: &Plan) -> Vec<Dg> {
        let mut v = Vec::new();
        if prev.exec != next.exec {
            v.push(Dg::ExecChanged);
        }
        if !self.ab(Abl::AllowFree) && next.allow & !prev.allow != 0 {
            v.push(Dg::AllowChanged);
        }
        if prev.check != Chk::Absent {
            if next.check == Chk::Absent {
                v.push(Dg::CheckRemoved);
            } else if next.check != prev.check {
                v.push(Dg::CheckDefChanged);
            }
        }
        if next.rcount < prev.rcount || next.rrank < prev.rrank {
            v.push(Dg::ReviewReduced);
        }
        v.extend(manual(prev, next));
        v
    }
    fn claimed(&self, prev: &Plan, next: &Plan) -> Vec<Dg> {
        let mut v = Vec::new();
        if prev.check != Chk::Absent && next.check == Chk::Absent {
            v.push(Dg::CheckRemoved);
        }
        if next.rcount < prev.rcount {
            v.push(Dg::ReviewCountLowered);
        }
        if next.rrank < prev.rrank {
            v.push(Dg::ReviewRankLowered);
        }
        v.extend(manual(prev, next));
        if !self.ab(Abl::AllowFree) && next.allow & !prev.allow != 0 {
            v.push(Dg::AllowChanged);
        }
        v
    }
    fn covered(&self, prev: &Plan, next: &Plan, d: Dg) -> bool {
        let rules = if self.ab(Abl::NextAllow) { next.allow } else { prev.allow };
        match d {
            Dg::ExecChanged => self.ab(Abl::StarCovered) && rules & CK != 0,
            Dg::AllowChanged => false,
            _ if rules == 0 => false,
            Dg::ReviewReduced | Dg::ReviewCountLowered | Dg::ReviewRankLowered => {
                let count = next.rcount >= prev.rcount || rules & RC0 != 0;
                let rank = next.rrank >= prev.rrank;
                count && rank
            }
            Dg::CheckRemoved | Dg::CheckDefChanged => prev.check != Chk::Absent && rules & CK != 0,
            Dg::EvidenceRemoved | Dg::EvidenceWeakened => prev.evid != Ev::None && rules & CK != 0,
            Dg::ApproveRemoved => false,
        }
    }
    fn uncovered(&self, prev: &Plan, next: &Plan, claimed: &[Dg]) -> Vec<Dg> {
        let mut v: Vec<Dg> = self.detected(prev, next).into_iter().filter(|d| !self.covered(prev, next, *d)).collect();
        v.extend(claimed.iter().copied().filter(|d| !self.covered(prev, next, *d)));
        v
    }

    // ---------------------------------------------------------------------------------------------------------
    // Keys and items: reducer.ts item/required/refresh/mergeGuard/adoptGuard.

    fn required(&self, p: &Plan) -> Vec<Obl> {
        let mut v = Vec::new();
        if p.check != Chk::Absent {
            v.push(Obl::Check);
        }
        if p.rcount > 0 {
            v.push(Obl::Review);
        }
        if p.approve {
            v.push(Obl::Approve);
        }
        if p.evid != Ev::None {
            v.push(Obl::Evidence);
        }
        v
    }
    fn patch(&self, s: &S, c: &Cand) -> Patch {
        Patch { c: c.c, base: s.base }
    }
    /// Key of the current candidate for `o` (submit facts), None = missing fact key.
    fn cand_key(&self, s: &S, o: Obl) -> Option<Key> {
        let c = s.cand.as_ref()?;
        match o {
            Obl::Check => (c.check != Chk::Absent)
                .then(|| Key::Check(CheckKey { c: c.c, base: s.base, weak: c.check == Chk::Weak, exec: c.exec })),
            Obl::Review => Some(Key::Patch(self.patch(s, c))),
            Obl::Approve => c.approve.then(|| Key::Patch(self.patch(s, c))),
            Obl::Evidence => c.evid.then(|| Key::Patch(self.patch(s, c))),
        }
    }
    /// The merge tree M = merge(trunk, candidate) and its check key under the current plan (ops.merge candidateFacts).
    fn merge_tree(&self, s: &S, c: Content) -> Tree {
        Tree { adopt: s.trunk.adopt, merged: Some(c) }
    }
    fn merge_check_key(&self, s: &S, c: Content) -> CheckKey {
        CheckKey { c, base: s.trunk.adopt, weak: s.plan.check == Chk::Weak, exec: s.plan.exec }
    }
    fn shares_writer(&self, s: &S, by: P) -> bool {
        by.writer_id().is_some_and(|k| k >= 1 && k <= s.attempt)
    }
    fn item(&self, s: &S, o: Obl, key: Option<Key>) -> St {
        let Some(key) = key else { return St::D };
        let active: Vec<usize> = (0..s.blocks.len()).filter(|&i| s.blocks[i].obl == o && s.blocks[i].active()).collect();
        let e = match (o, key) {
            (Obl::Check, Key::Check(k)) => s.cp & k.bit() != 0 && s.cf & k.bit() == 0,
            (Obl::Review, Key::Patch(p)) => {
                let mut by: Vec<P> = s
                    .reviews
                    .iter()
                    .filter(|r| r.obl == Obl::Review && r.key == p && r.rank >= s.plan.rrank && !matches!(r.by, P::Writer(_)))
                    .map(|r| r.by)
                    .collect();
                by.dedup();
                by.len() >= s.plan.rcount as usize
            }
            (Obl::Approve, Key::Patch(p)) => {
                s.reviews.iter().any(|r| r.obl == Obl::Approve && r.key == p && (r.by.role() == Role::Owner || self.ab(Abl::ApproveRole)))
            }
            (Obl::Evidence, Key::Patch(p)) => {
                let need = if s.plan.evid == Ev::Owner { Role::Owner } else { Role::Reviewer };
                s.evid.iter().any(|v| v.key == p && (v.by.role() == need || v.by.role() == Role::Owner) && !self.shares_writer(s, v.by))
            }
            _ => false,
        };
        if active.is_empty() && e {
            return St::E;
        }
        let waived = s.waivers.iter().any(|w| {
            w.by.role() == Role::Owner && w.obl == o && w.key == key && active.iter().all(|&i| w.cites & (1 << i) != 0)
        });
        if waived { St::W } else { St::D }
    }
    fn inv_e(&self, s: &S, k: InvKey) -> bool {
        s.ip & k.bit() != 0 && s.ifl & k.bit() == 0
    }
    fn binding(&self, s: &S, b: &Block) -> bool {
        b.active() && (b.judgment || (b.obl == Obl::Check && s.plan.check != Chk::Absent))
    }
    fn accepted(&self, s: &S) -> bool {
        s.cand.is_some()
            && s.open
            && self.required(&s.plan).iter().all(|&o| self.item(s, o, self.cand_key(s, o)) != St::D)
            && !s.blocks.iter().any(|b| self.binding(s, b))
    }
    fn merge_guard(&self, s: &S) -> bool {
        let Some(c) = s.cand else { return false };
        if !self.ab(Abl::MergeGuard) {
            if !self.accepted(s) {
                return false;
            }
            for o in self.required(&s.plan) {
                let key = if o == Obl::Check { Some(Key::Check(self.merge_check_key(s, c.c))) } else { self.cand_key(s, o) };
                if self.item(s, o, key) == St::D {
                    return false;
                }
            }
        }
        if s.blocks.iter().any(|b| self.binding(s, b)) {
            return false;
        }
        let mk = InvKey { tree: self.merge_tree(s, c.c), exec: s.plan.exec };
        let tk = InvKey { tree: s.trunk, exec: s.plan.exec };
        if !self.ab(Abl::InvGuard) && mk != tk && !self.inv_e(s, mk) && !s.defers.iter().any(|d| d.key == mk && d.attempt == s.attempt) {
            return false;
        }
        true
    }
    /// mergeJobs: the merge key of `t` and the invariant key of M, when they lack a verdict.
    fn merge_jobs(&self, s: &S) -> Vec<E> {
        let mut v = Vec::new();
        let Some(c) = s.cand else { return v };
        if s.plan.check != Chk::Absent {
            let k = self.merge_check_key(s, c.c);
            if (s.cp | s.cf) & k.bit() == 0 {
                for &pass in check_truth(k) {
                    v.push(E::ObsCheck { key: k, pass, attribution: false, merging: true });
                }
            }
        }
        let mk = InvKey { tree: self.merge_tree(s, c.c), exec: s.plan.exec };
        if (s.ip | s.ifl) & mk.bit() == 0 {
            v.push(E::ObsInv { key: mk, pass: inv_truth(mk), merging: true });
        }
        v
    }
    fn adopt_tree(&self, bad: bool) -> Tree {
        Tree { adopt: Some(bad), merged: None }
    }
    fn adopt_guard(&self, s: &S, bad: bool) -> bool {
        let nk = InvKey { tree: self.adopt_tree(bad), exec: s.plan.exec };
        let tk = InvKey { tree: s.trunk, exec: s.plan.exec };
        !(nk != tk && !self.inv_e(s, nk) && self.inv_e(s, tk))
    }

    // ---------------------------------------------------------------------------------------------------------
    // Replay validation: reducer.ts validateDraft (and evidenceErrors), from its own code path.

    pub fn validate(&self, s: &S, e: &E) -> Result<(), &'static str> {
        let open_cand = s.open && s.cand.is_some();
        match e {
            E::Plan { by, to, claimed, note, delegated } => {
                let r = by.role();
                if !matches!(r, Role::Owner | Role::Parent) {
                    return Err("plan insufficient permissions");
                }
                let downgrade = !self.detected(&s.plan, to).is_empty() || !claimed.is_empty();
                let gaps = self.uncovered(&s.plan, to, claimed);
                if !self.ab(Abl::OwnerDowngrade) && downgrade && r != Role::Owner && (r != Role::Parent || !gaps.is_empty()) {
                    return Err("Only owner may approve a plan that reduces obligations");
                }
                if !self.ab(Abl::DelegatedNote) && downgrade && r == Role::Owner && *delegated && !note {
                    return Err("a delegated owner plan update that reduces obligations requires a note");
                }
                Ok(())
            }
            E::Dispatch { by } => {
                if !matches!(by.role(), Role::Owner | Role::Parent) {
                    return Err("dispatch insufficient permissions");
                }
                if s.open || s.trunk.merged.is_some() {
                    return Err("dispatch requires a ready node with no open slot");
                }
                Ok(())
            }
            E::Abandon { by } => {
                if !matches!(by.role(), Role::Owner | Role::Parent) {
                    return Err("abandon insufficient permissions");
                }
                if !s.open { Err("attempt must match the current open writer slot") } else { Ok(()) }
            }
            E::Rebase { by } => {
                if !matches!(by.role(), Role::Owner | Role::Parent) && *by != P::Writer(s.attempt) {
                    return Err("rebase requires parent/owner or the slot writer");
                }
                if !s.open {
                    return Err("attempt must match the current open writer slot");
                }
                if s.base == s.trunk.adopt { Err("trunk has not moved since the slot base") } else { Ok(()) }
            }
            E::Submit { by, .. } => {
                if !s.open {
                    return Err("attempt must match the current open writer slot");
                }
                if *by != P::Writer(s.attempt) { Err("submit must be performed by the slot writer") } else { Ok(()) }
            }
            E::ObsCheck { key, attribution, merging, .. } => {
                if *merging && !open_cand {
                    return Err("obs merging must name a node with an open candidate");
                }
                if *attribution
                    && !s.blocks.iter().any(|b| !b.judgment && b.st == Bst::Active && b.obl == Obl::Check && b.key == Key::Check(*key))
                {
                    return Err("Attribution must match the original key/commit/base of an active execution block");
                }
                Ok(())
            }
            E::ObsInv { merging, .. } => {
                if *merging && !open_cand { Err("obs merging must name a node with an open candidate") } else { Ok(()) }
            }
            E::Review { by, obl, key, rank, .. } => {
                let r = by.role();
                if !matches!(r, Role::Reviewer | Role::Owner) {
                    return Err("review insufficient permissions");
                }
                // current(obligation, key, reviewOnly = true)
                let in_scope = self.required(&s.plan).contains(obl) || *obl == Obl::Review || s.blocks.iter().any(|b| b.obl == *obl && b.active());
                if !open_cand || !in_scope || self.cand_key(s, *obl) != Some(Key::Patch(*key)) {
                    return Err("must reference the current candidate obligation key");
                }
                if !self.ab(Abl::Recusal) && self.shares_writer(s, *by) {
                    return Err("review reviewer must not be the writer of any attempt of this node");
                }
                if if r == Role::Owner { *rank != 3 } else { !(1..=2).contains(rank) } {
                    return Err("review rank: reviewer must use 1..2, owner must use 3");
                }
                if !self.ab(Abl::ApproveRole) && *obl == Obl::Approve && r != Role::Owner {
                    return Err("approve can only be recorded by the owner");
                }
                Ok(())
            }
            E::Evidence { by, key, files } => {
                let r = by.role();
                let writer_ok = self.ab(Abl::EvidenceWriter) && r == Role::Writer;
                if !matches!(r, Role::Owner | Role::Parent | Role::Reviewer) && !writer_ok {
                    return Err("evidence insufficient permissions");
                }
                if !open_cand {
                    return Err("evidence requires an open candidate");
                }
                if s.plan.evid == Ev::None {
                    return Err("node has no evidence obligation");
                }
                if self.cand_key(s, Obl::Evidence) != Some(Key::Patch(*key)) {
                    return Err("evidence must reference the current candidate obligation key");
                }
                let need = if s.plan.evid == Ev::Owner { Role::Owner } else { Role::Reviewer };
                if r != need && r != Role::Owner && !writer_ok {
                    return Err("evidence requires the plan's role (or owner)");
                }
                if !self.ab(Abl::EvidenceWriter) && self.shares_writer(s, *by) {
                    return Err("evidence must not be recorded by a writer of any attempt of this node");
                }
                if !files { Err("evidence on a candidate requires at least one file") } else { Ok(()) }
            }
            E::Waive { by, obl, key, cites, reason, .. } => {
                let r = by.role();
                if r != Role::Owner && !(self.ab(Abl::WaiveRole) && r == Role::Parent) {
                    return Err("waive insufficient permissions");
                }
                // current(obligation, key)
                let in_scope = self.required(&s.plan).contains(obl) || s.blocks.iter().any(|b| b.obl == *obl && b.active());
                if !open_cand || !in_scope || self.cand_key(s, *obl) != Some(*key) {
                    return Err("must reference the current candidate obligation key");
                }
                if !reason {
                    return Err("waive requires a reason");
                }
                if (0..16).any(|i| cites & (1 << i) != 0 && !s.blocks.get(i).is_some_and(|b| b.obl == *obl && b.active())) {
                    return Err("accept_risk must reference active blocks for this obligation");
                }
                Ok(())
            }
            E::Defer { by, reason, .. } => {
                if by.role() != Role::Owner {
                    return Err("defer insufficient permissions");
                }
                if !open_cand {
                    return Err("defer requires a current candidate");
                }
                if !reason { Err("defer must list obligations and give a reason") } else { Ok(()) }
            }
            E::Merge => {
                if !s.open {
                    return Err("attempt must match the current open writer slot");
                }
                if self.merge_guard(s) { Ok(()) } else { Err("merge guard") }
            }
            E::Adopt { by, bad, inside, note, .. } => {
                let r = by.role();
                if r == Role::Parent && s.plan.allow & AD != 0 {
                    if !inside {
                        return Err("parent adoption refused: changed path is not under an allow adopt prefix");
                    }
                } else if r != Role::Owner && !(self.ab(Abl::AdoptRole) && r == Role::Parent) {
                    return Err("adopt insufficient permissions");
                }
                if s.trunk.adopt.is_some() || s.trunk.merged.is_some() {
                    return Err("adopt: not a fast-forward of a new external commit (model bound: one adoption)");
                }
                if !note {
                    return Err("adopt requires a note");
                }
                if self.adopt_guard(s, *bad) { Ok(()) } else { Err("adopt new debt") }
            }
        }
    }

    // ---------------------------------------------------------------------------------------------------------
    // Reducer step: reducer.ts reduce (one entry).

    pub fn apply(&self, s: &S, e: &E) -> S {
        let mut t = s.clone();
        match e {
            E::Plan { by, to, .. } => {
                if !self.ab(Abl::Invalidate) && t.cand.is_some() && t.open && (!s.plan.same_spec(*to) || s.plan.exec != to.exec) {
                    t.cand = None;
                }
                t.owner_rules = if by.role() == Role::Owner { to.allow } else { s.owner_rules & to.allow };
                t.plan = *to;
            }
            E::Dispatch { .. } => {
                t.attempt += 1;
                t.open = true;
                t.base = s.trunk.adopt;
                t.cand = None;
            }
            E::Abandon { .. } => {
                t.open = false;
                t.cand = None;
            }
            E::Rebase { .. } => {
                t.base = s.trunk.adopt;
                t.cand = None;
            }
            E::Submit { c, .. } => {
                t.nsub += 1;
                t.cand = Some(Cand {
                    c: *c,
                    id: t.nsub,
                    check: s.plan.check,
                    exec: s.plan.exec,
                    approve: s.plan.approve,
                    evid: s.plan.evid != Ev::None,
                });
            }
            E::ObsCheck { key, pass, attribution, .. } => {
                if *attribution {
                    for b in t.blocks.iter_mut() {
                        if !b.judgment && b.st == Bst::Active && b.obl == Obl::Check && b.key == Key::Check(*key) {
                            b.st = if !pass {
                                Bst::Cleared(Clr::AttrFail)
                            } else if self.ab(Abl::Flaky) {
                                Bst::Cleared(Clr::AttrPass)
                            } else {
                                Bst::Flaky
                            };
                        }
                    }
                }
                if !pass && !attribution {
                    t.blocks.push(Block { judgment: false, obl: Obl::Check, key: Key::Check(*key), rank: 0, by: P::Exec, st: Bst::Active });
                }
                if *pass {
                    t.cp |= key.bit();
                } else {
                    t.cf |= key.bit();
                }
            }
            E::ObsInv { key, pass, .. } => {
                if *pass {
                    t.ip |= key.bit();
                } else {
                    t.ifl |= key.bit();
                }
            }
            E::Review { by, obl, key, rank, ok } => {
                if !ok {
                    t.blocks.push(Block { judgment: true, obl: *obl, key: Key::Patch(*key), rank: *rank, by: *by, st: Bst::Active });
                } else {
                    let ck = self.cand_key(s, *obl);
                    for b in t.blocks.iter_mut() {
                        if b.active()
                            && b.judgment
                            && b.obl == *obl
                            && ck == Some(Key::Patch(*key))
                            && (*rank > b.rank
                                || (*rank >= b.rank && (*by == b.by || self.ab(Abl::Dissent)))
                                || (*obl == Obl::Approve && by.role() == Role::Owner))
                        {
                            b.st = Bst::Cleared(Clr::Ok { by: *by, rank: *rank });
                        }
                    }
                    insert(&mut t.reviews, Rev { obl: *obl, key: *key, by: *by, rank: *rank });
                }
            }
            E::Evidence { by, key, .. } => insert(&mut t.evid, Evid { key: *key, by: *by }),
            E::Waive { by, obl, key, cites, .. } => {
                let ck = self.cand_key(s, *obl);
                for (i, b) in t.blocks.iter_mut().enumerate() {
                    let cited = cites & (1 << i) != 0;
                    if b.active() && b.obl == *obl && ck == Some(*key) && (cited || self.ab(Abl::WaiveCites)) {
                        b.st = Bst::Cleared(Clr::Waiver { by: *by, cited });
                    }
                }
                insert(&mut t.waivers, Waiver { obl: *obl, key: *key, cites: *cites, by: *by });
            }
            E::Defer { by, key, .. } => insert(&mut t.defers, Defer { key: *key, attempt: s.attempt, by: *by }),
            E::Merge => {
                let c = s.cand.expect("merge needs a candidate").c;
                t.trunk = self.merge_tree(s, c);
                t.open = false;
            }
            E::Adopt { bad, .. } => t.trunk = self.adopt_tree(*bad),
        }
        t
    }

    // ---------------------------------------------------------------------------------------------------------
    // The operation path: ops.ts (guard = validateDraft, coincident by construction) plus what ops checks or
    // generates itself. Used by ReplayAgreesWithOps on the forger's entries.

    /// Why the operation path would not append `e` at `s` although replay validation accepts it (None = it would).
    pub fn ops_diff(&self, s: &S, e: &E) -> Option<Diff> {
        if self.validate(s, e).is_err() {
            return Some(Diff::Other);
        }
        let ok = match e {
            // ops.planSet: downgrades = planDowngrades(state.plan, next) (generated, never taken from the caller)
            E::Plan { to, claimed, .. } => return (*claimed != self.claimed(&s.plan, to)).then_some(Diff::PlanClaims),
            // runJobs records an attest observation only when jobCurrent (ops.ts runJobs, reducer.ts jobCurrent);
            // ops.merge records merge-result observations (merging) only for mergeJobs of an accepted candidate
            E::ObsCheck { key, attribution, merging, .. } => {
                if *merging {
                    self.accepted(s) && self.merge_jobs(s).iter().any(|j| matches!(j, E::ObsCheck { key: k, .. } if k == key))
                } else if *attribution {
                    s.blocks.iter().any(|b| !b.judgment && b.st == Bst::Active && b.key == Key::Check(*key))
                } else {
                    self.cand_key(s, Obl::Check) == Some(Key::Check(*key))
                }
            }
            // genesis jobs (done at init here), merge jobs (merging) and adopt jobs (the invariant of an adoptable tree)
            E::ObsInv { key, merging, .. } => {
                if *merging {
                    self.accepted(s) && self.merge_jobs(s).iter().any(|j| matches!(j, E::ObsInv { key: k, .. } if k == key))
                } else {
                    s.trunk.adopt.is_none() && s.trunk.merged.is_none() && key.tree.merged.is_none() && key.tree.adopt.is_some() && key.exec == s.plan.exec
                }
            }
            // ops.merge measures mergeJobs before appending the merge (the merge entry follows them)
            E::Merge => return (!self.merge_jobs(s).is_empty()).then_some(Diff::Unmeasured),
            // ops.adopt: a parent needs an adopt allowance (checked before ops measures adoptJobs)
            E::Adopt { by, bad, .. } => {
                if by.role() != Role::Owner && s.plan.allow & AD == 0 {
                    return Some(Diff::Other);
                }
                let nk = InvKey { tree: self.adopt_tree(*bad), exec: s.plan.exec };
                return ((s.ip | s.ifl) & nk.bit() == 0 && nk != InvKey { tree: s.trunk, exec: s.plan.exec }).then_some(Diff::Unmeasured);
            }
            // ops.review / ops.waive / ops.evidence take the key of the current candidate (validateDraft requires it);
            // the remaining ops checks are validateDraft itself (guard)
            _ => true,
        };
        if ok { None } else { Some(Diff::ObsNotCurrent) }
    }

    /// The reducer's view of an easing (an entry that enters ΔO⁻, waives, defers or adopts).
    pub fn eases(&self, s: &S, e: &E) -> bool {
        match e {
            E::Plan { to, claimed, .. } => !claimed.is_empty() || !self.detected(&s.plan, to).is_empty(),
            E::Waive { .. } | E::Defer { .. } | E::Adopt { .. } => true,
            _ => false,
        }
    }

    // ---------------------------------------------------------------------------------------------------------
    // Successors

    fn push(&self, s: &S, out: &mut Vec<(Action, S)>, proc: Proc, e: E, pin: Option<Intent>) {
        if self.validate(s, &e).is_err() {
            return;
        }
        let mut t = self.apply(s, &e);
        match proc {
            Proc::Forger => t.nforge += 1,
            Proc::Main => {
                if pin.is_none() && !matches!(e, E::ObsInv { .. }) {
                    t.nmain += 1;
                }
                t.intent = None;
            }
            Proc::WriterSub | Proc::ReviewerSub if matches!(e, E::Review { .. } | E::Evidence { .. }) => t.nrev += 1,
            // ablation `dsa`: a subagent's owner/parent acts spend the main agent's budget
            Proc::WriterSub | Proc::ReviewerSub if matches!(by_of(&e).map(P::role), Some(Role::Owner | Role::Parent)) => t.nmain += 1,
            _ => {}
        }
        if matches!(e, E::Plan { .. }) {
            t.nplan += 1;
        }
        out.push((Action::Do { proc, e, pin }, t));
    }

    /// Owner/parent acts of the main agent; `proc` is the process (a subagent only under ablation `dsa`).
    fn owner_acts(&self, s: &S, out: &mut Vec<(Action, S)>, proc: Proc) {
        let delegated = self.delegated();
        if s.nplan < self.plans {
            for to in s.plan.updates(self.combos) {
                let claimed = self.claimed(&s.plan, &to);
                for (by, note) in [(P::Owner, true), (P::Owner, false), (P::ParentMain, false)] {
                    // extension.ts owed_plan refuses a parent with uncovered downgrades before ops (same rule as the guard)
                    self.push(s, out, proc, E::Plan { by, to, claimed: claimed.clone(), note, delegated }, None);
                }
            }
        }
        if let Some(c) = s.cand.filter(|_| s.open) {
            for o in [Obl::Check, Obl::Review, Obl::Approve, Obl::Evidence] {
                let Some(key) = self.cand_key(s, o) else { continue };
                let cites = (0..s.blocks.len()).filter(|&i| s.blocks[i].obl == o && s.blocks[i].active()).fold(0u16, |m, i| m | 1 << i);
                if proc == Proc::Main {
                    if self.required(&s.plan).contains(&o) || cites != 0 {
                        out.push((Action::Decide(Intent { kind: IntentKind::Waive { obl: o, cites }, cand: c.id }), S { intent: Some(Intent { kind: IntentKind::Waive { obl: o, cites }, cand: c.id }), nmain: s.nmain + 1, ..s.clone() }));
                    }
                } else {
                    self.push(s, out, proc, E::Waive { by: P::Owner, obl: o, key, cites, reason: true, delegated }, None);
                }
            }
        }
    }

    fn main_agent(&self, s: &S, out: &mut Vec<(Action, S)>) {
        let delegated = self.delegated();
        if let Some(i) = s.intent {
            // the decided act runs now (ops.approve with the pin; ops.waive with the key of the current candidate)
            let e = match (i.kind, s.cand.filter(|_| s.open)) {
                (_, None) => None,
                // the pin is approvePreview's candidate: under the gate it is what the dialog showed (the decision);
                // delegated, preview and append run in the same call after the decision, so the pin is the current one
                (IntentKind::Approve, Some(c)) if self.mode == Mode::Gate && c.id != i.cand && !self.ab(Abl::Pin) => None,
                (IntentKind::Approve, Some(c)) => {
                    Some(E::Review { by: P::Owner, obl: Obl::Approve, key: self.patch(s, &c), rank: 3, ok: true })
                }
                (IntentKind::Waive { obl, cites }, Some(_)) => self
                    .cand_key(s, obl)
                    .map(|key| E::Waive { by: P::Owner, obl, key, cites, reason: true, delegated }),
                (IntentKind::Review, Some(c)) => Some(E::Review { by: P::Owner, obl: Obl::Review, key: self.patch(s, &c), rank: 3, ok: true }),
            };
            match e {
                Some(e) if self.validate(s, &e).is_ok() => self.push(s, out, Proc::Main, e, Some(i)),
                _ => out.push((Action::Drop(i), S { intent: None, ..s.clone() })),
            }
            return;
        }
        if s.nmain >= self.main {
            return;
        }
        self.owner_acts(s, out, Proc::Main);
        if let Some(c) = s.cand.filter(|_| s.open) {
            let patch = self.patch(s, &c);
            // owed_approve: approvePreview (pin) then the dialog/turn; only for a node with approve
            let mut kinds = vec![IntentKind::Review];
            if s.plan.approve {
                kinds.push(IntentKind::Approve);
            }
            for kind in kinds {
                let i = Intent { kind, cand: c.id };
                out.push((Action::Decide(i), S { intent: Some(i), nmain: s.nmain + 1, ..s.clone() }));
            }
            if s.plan.evid != Ev::None {
                self.push(s, out, Proc::Main, E::Evidence { by: P::Owner, key: patch, files: true }, None);
            }
            // owed_defer: keys of the merge tree built now (extension.ts defer)
            let mk = InvKey { tree: self.merge_tree(s, c.c), exec: s.plan.exec };
            self.push(s, out, Proc::Main, E::Defer { by: P::Owner, key: mk, reason: true, delegated }, None);
        }
        if s.open {
            self.push(s, out, Proc::Main, E::Abandon { by: P::ParentMain }, None);
        }
        if self.adopt && s.trunk.adopt.is_none() {
            for bad in [false, true] {
                let nk = InvKey { tree: self.adopt_tree(bad), exec: s.plan.exec };
                if (s.ip | s.ifl) & nk.bit() == 0 {
                    // ops.adopt measures adoptJobs (the executor) before the guard
                    self.push(s, out, Proc::Main, E::ObsInv { key: nk, pass: inv_truth(nk), merging: false }, None);
                    continue;
                }
                self.push(s, out, Proc::Main, E::Adopt { by: P::Owner, bad, inside: true, note: true, delegated }, None);
                // ops.adopt refuses a parent without an adopt allowance before any effect
                if s.plan.allow & AD != 0 || self.ab(Abl::AdoptRole) {
                    for inside in [true, false] {
                        self.push(s, out, Proc::Main, E::Adopt { by: P::ParentMain, bad, inside, note: true, delegated: false }, None);
                    }
                }
            }
        }
    }

    fn driver(&self, s: &S, out: &mut Vec<(Action, S)>) {
        let d = P::ParentDrive;
        if !s.open && s.attempt < self.attempts {
            self.push(s, out, Proc::Driver, E::Dispatch { by: d }, None);
        }
        if s.open && s.base != s.trunk.adopt {
            self.push(s, out, Proc::Driver, E::Rebase { by: d }, None);
        }
        if !(s.open && s.cand.is_some()) {
            return;
        }
        // attest: attestJobs (attribution reruns of active execution blocks, then the candidate's check lacking a
        // verdict); one job per step (runJobs appends each under the lock)
        let mut keys: Vec<CheckKey> = Vec::new();
        for b in &s.blocks {
            if let (false, Bst::Active, Key::Check(k)) = (b.judgment, b.st, b.key) {
                if !keys.contains(&k) {
                    keys.push(k);
                    for &pass in check_truth(k) {
                        self.push(s, out, Proc::Driver, E::ObsCheck { key: k, pass, attribution: true, merging: false }, None);
                    }
                }
            }
        }
        if let Some(Key::Check(k)) = self.cand_key(s, Obl::Check)
            && s.plan.check != Chk::Absent
            && (s.cp | s.cf) & k.bit() == 0
        {
            for &pass in check_truth(k) {
                self.push(s, out, Proc::Driver, E::ObsCheck { key: k, pass, attribution: false, merging: false }, None);
            }
        }
        // merge: ops.merge refuses a candidate that is not accepted, measures mergeJobs, then guards and appends
        if self.accepted(s) || self.ab(Abl::MergeGuard) {
            let jobs = self.merge_jobs(s);
            if jobs.is_empty() {
                self.push(s, out, Proc::Driver, E::Merge, None);
            }
            for j in jobs {
                self.push(s, out, Proc::Driver, j, None);
            }
        }
    }

    fn subagents(&self, s: &S, out: &mut Vec<(Action, S)>) {
        if !s.open {
            return;
        }
        let k = s.attempt;
        if s.nsub < self.submits {
            for &c in &self.contents {
                self.push(s, out, Proc::WriterSub, E::Submit { by: P::Writer(k), c }, None);
            }
        }
        if self.ab(Abl::Dsa) && s.nmain < self.main {
            self.owner_acts(s, out, Proc::WriterSub);
        }
        let Some(c) = s.cand else { return };
        if s.nrev >= self.reviews {
            return;
        }
        let patch = self.patch(s, &c);
        // a writer reviewing its own candidate under another reviewer id, or under its own id (refused)
        for by in [P::Rev(1), P::RevW(k)] {
            self.push(s, out, Proc::WriterSub, E::Review { by, obl: Obl::Review, key: patch, rank: 2, ok: true }, None);
        }
        let mut claims = vec![P::Rev(1), P::Rev(2)];
        if k < self.attempts {
            claims.push(P::RevW(k + 1));
        }
        for by in claims {
            for rank in [1, 2] {
                for ok in [true, false] {
                    self.push(s, out, Proc::ReviewerSub, E::Review { by, obl: Obl::Review, key: patch, rank, ok }, None);
                }
            }
        }
        if s.plan.evid != Ev::None {
            self.push(s, out, Proc::ReviewerSub, E::Evidence { by: P::Rev(1), key: patch, files: true }, None);
            self.push(s, out, Proc::WriterSub, E::Evidence { by: P::Writer(k), key: patch, files: true }, None);
        }
        if s.plan.approve {
            self.push(s, out, Proc::ReviewerSub, E::Review { by: P::Rev(1), obl: Obl::Approve, key: patch, rank: 2, ok: true }, None);
        }
    }

    fn forger(&self, s: &S, out: &mut Vec<(Action, S)>) {
        if s.nforge >= self.forge {
            return;
        }
        let f = Proc::Forger;
        if s.nplan < self.plans {
            for to in s.plan.updates(self.combos) {
                let honest = self.claimed(&s.plan, &to);
                for by in [P::ParentMain, P::ParentDrive] {
                    self.push(s, out, f, E::Plan { by, to, claimed: honest.clone(), note: false, delegated: false }, None);
                    if !honest.is_empty() {
                        self.push(s, out, f, E::Plan { by, to, claimed: vec![], note: false, delegated: false }, None);
                    }
                }
            }
        }
        // executor observations with truthful verdicts on any check key at the slot base under the current plan
        for &c in &CONTENTS {
            let k = CheckKey { c, base: s.base, weak: s.plan.check == Chk::Weak, exec: s.plan.exec };
            for &pass in check_truth(k) {
                for (attribution, merging) in [(false, false), (true, false), (false, true)] {
                    self.push(s, out, f, E::ObsCheck { key: k, pass, attribution, merging }, None);
                }
            }
        }
        self.push(s, out, f, E::Merge, None);
        if s.trunk.adopt.is_none() {
            for bad in [false, true] {
                for inside in [false, true] {
                    self.push(s, out, f, E::Adopt { by: P::ParentMain, bad, inside, note: true, delegated: false }, None);
                }
            }
        }
        let Some(c) = s.cand.filter(|_| s.open) else { return };
        let patch = self.patch(s, &c);
        let mk = InvKey { tree: self.merge_tree(s, c.c), exec: s.plan.exec };
        for merging in [false, true] {
            self.push(s, out, f, E::ObsInv { key: mk, pass: inv_truth(mk), merging }, None);
        }
        for o in [Obl::Check, Obl::Review, Obl::Approve, Obl::Evidence] {
            if let Some(key) = self.cand_key(s, o) {
                let cites = (0..s.blocks.len()).filter(|&i| s.blocks[i].obl == o && s.blocks[i].active()).fold(0u16, |m, i| m | 1 << i);
                self.push(s, out, f, E::Waive { by: P::ParentMain, obl: o, key, cites, reason: true, delegated: false }, None);
            }
        }
        for by in [P::ParentMain, P::Writer(s.attempt), P::RevW(s.attempt)] {
            self.push(s, out, f, E::Review { by, obl: Obl::Review, key: patch, rank: 2, ok: true }, None);
        }
        self.push(s, out, f, E::Review { by: P::Rev(1), obl: Obl::Approve, key: patch, rank: 2, ok: true }, None);
        for (by, files) in [(P::Writer(s.attempt), true), (P::RevW(s.attempt), true), (P::Rev(1), false)] {
            self.push(s, out, f, E::Evidence { by, key: patch, files }, None);
        }
        self.push(s, out, f, E::Defer { by: P::ParentMain, key: mk, reason: true, delegated: false }, None);
    }

    // ---------------------------------------------------------------------------------------------------------
    // Property helpers (written from SPEC/contract text, not from the reducer's functions above)

    /// Easings of a plan update in truth (what actually lowers acceptance), independent of downgradeDetails.
    fn semantic_easings(prev: &Plan, next: &Plan) -> Vec<&'static str> {
        let mut v = Vec::new();
        if prev.check != Chk::Absent && next.check == Chk::Absent {
            v.push("check dropped");
        }
        if prev.check == Chk::Strict && next.check == Chk::Weak {
            v.push("check weakened");
        }
        if !prev.exec && next.exec {
            v.push("exec passes everything");
        }
        if next.rcount < prev.rcount {
            v.push("review count lowered");
        }
        if next.rrank < prev.rrank {
            v.push("review rank lowered");
        }
        if prev.approve && !next.approve {
            v.push("approve dropped");
        }
        if prev.evid != Ev::None && next.evid == Ev::None {
            v.push("evidence dropped");
        }
        if prev.evid == Ev::Owner && next.evid == Ev::Reviewer {
            v.push("evidence weakened");
        }
        if next.allow & !prev.allow != 0 {
            v.push("allowance added");
        }
        v
    }
    /// D21.2 as text: a parent easing is pre-authorized by an owner-authored rule of the prior plan.
    fn parent_permitted(s: &S, what: &str) -> bool {
        let rules = s.plan.allow & s.owner_rules;
        match what {
            "review count lowered" => rules & RC0 != 0,
            "check dropped" | "check weakened" | "evidence dropped" | "evidence weakened" => rules & CK != 0,
            _ => false,
        }
    }
    fn owner_waived(&self, s: &S, o: Obl, key: Key) -> bool {
        s.waivers.iter().any(|w| w.by.role() == Role::Owner && w.obl == o && w.key == key)
    }
    fn owner_deferred(&self, s: &S, k: InvKey) -> bool {
        s.defers.iter().any(|d| d.by.role() == Role::Owner && d.key == k && d.attempt == s.attempt)
    }
    /// SPEC §6.2–6.4 at a merge, recomputed: every obligation measured/judged on the merged content or waived by
    /// the owner (with every active block cited), every changed invariant passed or deferred by the owner.
    fn merge_covered(&self, s: &S) -> bool {
        let Some(c) = s.cand else { return false };
        let patch = Patch { c: c.c, base: s.base };
        let blocks_of = |o: Obl| -> u16 { (0..s.blocks.len()).filter(|&i| s.blocks[i].obl == o && s.blocks[i].active()).fold(0, |m, i| m | 1 << i) };
        let waived = |o: Obl, key: Key| {
            let bl = blocks_of(o);
            s.waivers.iter().any(|w| w.by.role() == Role::Owner && w.obl == o && w.key == key && w.cites & bl == bl)
        };
        let ok = |o: Obl, key: Key, met: bool| (met && blocks_of(o) == 0) || waived(o, key);
        let p = &s.plan;
        if p.check != Chk::Absent {
            let k = self.merge_check_key(s, c.c);
            if !ok(Obl::Check, Key::Check(k), s.cp & k.bit() != 0 && s.cf & k.bit() == 0) {
                return false;
            }
        }
        if p.rcount > 0 {
            let mut who: Vec<P> = s
                .reviews
                .iter()
                .filter(|r| r.obl == Obl::Review && r.key == patch && r.rank >= p.rrank && r.by.role() != Role::Writer)
                .map(|r| r.by)
                .collect();
            who.dedup();
            if !ok(Obl::Review, Key::Patch(patch), who.len() >= p.rcount as usize) {
                return false;
            }
        }
        if p.approve {
            let met = s.reviews.iter().any(|r| r.obl == Obl::Approve && r.key == patch && r.by.role() == Role::Owner);
            if !ok(Obl::Approve, Key::Patch(patch), met) {
                return false;
            }
        }
        if p.evid != Ev::None {
            let need = if p.evid == Ev::Owner { Role::Owner } else { Role::Reviewer };
            let met = s.evid.iter().any(|v| v.key == patch && (v.by.role() == need || v.by.role() == Role::Owner) && v.by.writer_id().is_none_or(|k| k > s.attempt));
            if !ok(Obl::Evidence, Key::Patch(patch), met) {
                return false;
            }
        }
        let mk = InvKey { tree: self.merge_tree(s, c.c), exec: p.exec };
        (s.ip & mk.bit() != 0 && s.ifl & mk.bit() == 0) || self.owner_deferred(s, mk)
    }
}

impl std::fmt::Debug for S {
    /// One line per state in traces: plan, trunk, slot, candidate, verdicts, blocks, reviews, evidence, waivers,
    /// defers, a pending owner decision and the budgets used.
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        let p = &self.plan;
        write!(f, "plan{{check:{:?} exec:{} review:{}@{} approve:{} evidence:{:?} allow:{}}}", p.check, p.exec, p.rcount, p.rrank, p.approve, p.evid, p.allow)?;
        if self.owner_rules != p.allow {
            write!(f, " owner_rules:{}", self.owner_rules)?;
        }
        write!(f, " trunk:{:?}/{:?} attempt:{}{} base:{:?}", self.trunk.adopt, self.trunk.merged, self.attempt, if self.open { "(open)" } else { "" }, self.base)?;
        if let Some(c) = self.cand {
            write!(f, " cand#{}:{:?}", c.id, c.c)?;
        }
        let keys = |bits: u64| -> Vec<String> {
            let mut v = Vec::new();
            for c in CONTENTS {
                for base in [None, Some(false), Some(true)] {
                    for weak in [false, true] {
                        for exec in [false, true] {
                            let k = CheckKey { c, base, weak, exec };
                            if bits & k.bit() != 0 {
                                v.push(format!("{:?}/{:?}{}{}", c, base, if weak { "/weak" } else { "" }, if exec { "/exec" } else { "" }));
                            }
                        }
                    }
                }
            }
            v
        };
        if self.cp | self.cf != 0 {
            write!(f, " pass:{:?} fail:{:?}", keys(self.cp), keys(self.cf))?;
        }
        write!(f, " inv(pass:{:#x} fail:{:#x})", self.ip, self.ifl)?;
        for (i, b) in self.blocks.iter().enumerate() {
            write!(f, " block{i}:{}{:?}/{:?}/r{}/{:?}", if b.judgment { "judg:" } else { "exec:" }, b.obl, b.by, b.rank, b.st)?;
        }
        for r in &self.reviews {
            write!(f, " ok:{:?}/{:?}/r{}/{:?}", r.obl, r.by, r.rank, r.key.c)?;
        }
        for e in &self.evid {
            write!(f, " evidence:{:?}/{:?}", e.by, e.key.c)?;
        }
        for w in &self.waivers {
            write!(f, " waiver:{:?}/{:?}/cites{:b}/{:?}", w.obl, w.by, w.cites, w.key)?;
        }
        for d in &self.defers {
            write!(f, " defer:{:?}#{}", d.key.tree, d.attempt)?;
        }
        if let Some(i) = self.intent {
            write!(f, " decided:{:?}@cand#{}", i.kind, i.cand)?;
        }
        write!(f, " used(sub {} plan {} rev {} main {} forge {})", self.nsub, self.nplan, self.nrev, self.nmain, self.nforge)
    }
}

fn manual(prev: &Plan, next: &Plan) -> Vec<Dg> {
    let mut v = Vec::new();
    if prev.approve && !next.approve {
        v.push(Dg::ApproveRemoved);
    }
    if prev.evid != Ev::None {
        if next.evid == Ev::None {
            v.push(Dg::EvidenceRemoved);
        } else if next.evid != prev.evid && next.evid != Ev::Owner {
            v.push(Dg::EvidenceWeakened);
        }
    }
    v
}
fn insert<T: Ord>(v: &mut Vec<T>, x: T) {
    if let Err(i) = v.binary_search(&x) {
        v.insert(i, x);
    }
}

// ------------------------------------------------------------------------------------------------------------------
// Properties

fn merging(a: &Action) -> bool {
    matches!(a, Action::Do { e: E::Merge, .. })
}

fn easing_authorized(_m: &Owed05, s: &S, a: &Action, _t: &S) -> bool {
    let Action::Do { e, .. } = a else { return true };
    match e {
        E::Plan { by, to, note, delegated, .. } => {
            let sem = Owed05::semantic_easings(&s.plan, to);
            sem.is_empty()
                || match by.role() {
                    Role::Owner => !delegated || *note,
                    Role::Parent => sem.iter().all(|w| Owed05::parent_permitted(s, w)),
                    _ => false,
                }
        }
        E::Waive { by, reason, .. } | E::Defer { by, reason, .. } => by.role() == Role::Owner && *reason,
        E::Adopt { by, inside, note, .. } => {
            *note && (by.role() == Role::Owner || (by.role() == Role::Parent && *inside && s.plan.allow & s.owner_rules & AD != 0))
        }
        _ => true,
    }
}
fn no_subagent_authority(m: &Owed05, s: &S, a: &Action, _t: &S) -> bool {
    match a {
        Action::Do { proc: Proc::WriterSub | Proc::ReviewerSub, e, .. } => !matches!(by_of(e).map(P::role), Some(Role::Owner | Role::Parent)),
        Action::Do { proc: Proc::Driver, e, .. } => !m.eases(s, e),
        _ => true,
    }
}
fn drive_claim_never_eases(m: &Owed05, s: &S, a: &Action, _t: &S) -> bool {
    match a {
        Action::Do { e, .. } if by_of(e) == Some(P::ParentDrive) => !m.eases(s, e),
        _ => true,
    }
}
fn by_of(e: &E) -> Option<P> {
    match e {
        E::Plan { by, .. }
        | E::Dispatch { by }
        | E::Abandon { by }
        | E::Rebase { by }
        | E::Submit { by, .. }
        | E::Review { by, .. }
        | E::Evidence { by, .. }
        | E::Waive { by, .. }
        | E::Defer { by, .. }
        | E::Adopt { by, .. } => Some(*by),
        E::ObsCheck { .. } | E::ObsInv { .. } | E::Merge => Some(P::Exec),
    }
}
fn no_self_judge(m: &Owed05, s: &S, a: &Action, _t: &S) -> bool {
    match a {
        Action::Do { e: E::Review { by, .. } | E::Evidence { by, .. }, .. } => !m.shares_writer(s, *by),
        _ => true,
    }
}
/// At a merge, no review counted toward the merged candidate's review item comes from a principal sharing its id
/// with a writer of the node (SPEC §6.2.5: "none of them a writer of this node (any attempt)", same id rule as
/// validateDraft).
fn no_self_judge_at_merge(m: &Owed05, s: &S, a: &Action, _t: &S) -> bool {
    if !merging(a) || s.plan.rcount == 0 {
        return true;
    }
    let Some(c) = s.cand else { return true };
    let patch = Patch { c: c.c, base: s.base };
    !s.reviews.iter().any(|r| r.obl == Obl::Review && r.key == patch && r.rank >= s.plan.rrank && m.shares_writer(s, r.by))
}
fn no_self_judge_process(_m: &Owed05, _s: &S, a: &Action, _t: &S) -> bool {
    !matches!(a, Action::Do { proc: Proc::WriterSub, e: E::Review { .. } | E::Evidence { .. }, .. })
}
fn block_wins(_m: &Owed05, s: &S, a: &Action, _t: &S) -> bool {
    if !merging(a) {
        return true;
    }
    s.blocks.iter().all(|b| {
        let relevant = b.judgment || s.plan.check != Chk::Absent;
        !relevant
            || match b.st {
                Bst::Active | Bst::Flaky => false,
                Bst::Cleared(Clr::AttrFail) => !b.judgment,
                Bst::Cleared(Clr::AttrPass) => false,
                Bst::Cleared(Clr::Ok { by, rank }) => {
                    b.judgment && (rank > b.rank || (rank >= b.rank && by == b.by) || (b.obl == Obl::Approve && by.role() == Role::Owner))
                }
                Bst::Cleared(Clr::Waiver { by, cited }) => by.role() == Role::Owner && cited,
            }
    })
}
fn merged_means_covered(m: &Owed05, s: &S, a: &Action, _t: &S) -> bool {
    !merging(a) || m.merge_covered(s)
}
fn bad_merge_traces_to_owner(m: &Owed05, s: &S, a: &Action, _t: &S) -> bool {
    if !merging(a) {
        return true;
    }
    let Some(c) = s.cand else { return true };
    let mk = m.merge_check_key(s, c.c);
    let eased = s.plan.check != Chk::Strict || s.plan.exec || m.owner_waived(s, Obl::Check, Key::Check(mk));
    let ik = InvKey { tree: m.merge_tree(s, c.c), exec: s.plan.exec };
    match c.c {
        Content::Good => true,
        Content::Bad => eased,
        Content::Flaky => s.cf & mk.bit() == 0 || eased,
        Content::Breaks => s.plan.exec || m.owner_deferred(s, ik),
    }
}
fn approve_pinned(_m: &Owed05, s: &S, a: &Action, _t: &S) -> bool {
    match a {
        Action::Do { proc: Proc::Main, e: E::Review { obl: Obl::Approve, .. }, pin: Some(i) } => s.cand.map(|c| c.id) == Some(i.cand),
        _ => true,
    }
}
fn waive_pinned(_m: &Owed05, s: &S, a: &Action, _t: &S) -> bool {
    match a {
        Action::Do { proc: Proc::Main, e: E::Waive { .. }, pin: Some(i) } => s.cand.map(|c| c.id) == Some(i.cand),
        _ => true,
    }
}
fn owner_review_pinned(_m: &Owed05, s: &S, a: &Action, _t: &S) -> bool {
    match a {
        Action::Do { proc: Proc::Main, e: E::Review { obl: Obl::Review, .. }, pin: Some(i) } => s.cand.map(|c| c.id) == Some(i.cand),
        _ => true,
    }
}
fn forged_diff(m: &Owed05, s: &S, a: &Action) -> Option<Diff> {
    match a {
        Action::Do { proc: Proc::Forger, e, .. } => m.ops_diff(s, e),
        _ => None,
    }
}
fn exec_block_open(_m: &Owed05, s: &S) -> bool {
    s.open && s.cand.is_some() && s.blocks.iter().any(|b| !b.judgment && b.st == Bst::Active)
}

impl Model for Owed05 {
    type State = S;
    type Action = Action;

    fn init(&self) -> Vec<S> {
        let t0 = Tree { adopt: None, merged: None };
        vec![S {
            plan: self.genesis,
            owner_rules: self.genesis.allow,
            trunk: t0,
            attempt: 0,
            open: false,
            base: None,
            cand: None,
            cp: 0,
            cf: 0,
            // genesis attest done: the invariant passed on T0 under the genesis plan (genesisDone)
            ip: InvKey { tree: t0, exec: self.genesis.exec }.bit(),
            ifl: 0,
            blocks: vec![],
            reviews: vec![],
            evid: vec![],
            waivers: vec![],
            defers: vec![],
            intent: None,
            nsub: 0,
            nplan: 0,
            nrev: 0,
            nmain: 0,
            nforge: 0,
        }]
    }

    fn next(&self, s: &S, out: &mut Vec<(Action, S)>) {
        if s.trunk.merged.is_some() {
            return;
        }
        self.driver(s, out);
        self.main_agent(s, out);
        self.subagents(s, out);
        if self.mode == Mode::Forge {
            self.forger(s, out);
        }
    }

    fn terminal(&self, _s: &S) -> bool {
        true
    }

    fn fairness(&self, a: &Action) -> Option<&'static str> {
        match a {
            Action::Do { proc: Proc::Driver, e: E::ObsCheck { .. }, .. } if self.fair => Some("attest"),
            _ => None,
        }
    }

    fn properties(&self) -> Vec<Property<Self>> {
        vec![
            Property::Action { name: "EasingAuthorized", holds: easing_authorized },
            Property::Action { name: "NoSubagentAuthority", holds: no_subagent_authority },
            Property::Action { name: "DriveClaimNeverEases", holds: drive_claim_never_eases },
            Property::Action { name: "NoSelfJudge", holds: no_self_judge },
            Property::Action { name: "NoSelfJudgeAtMerge", holds: no_self_judge_at_merge },
            Property::Action { name: "NoSelfJudgeProcess", holds: no_self_judge_process },
            Property::Action { name: "BlockWins", holds: block_wins },
            Property::Action { name: "MergedMeansCovered", holds: merged_means_covered },
            Property::Action { name: "BadMergeTracesToOwner", holds: bad_merge_traces_to_owner },
            Property::Action { name: "ApprovePinned", holds: approve_pinned },
            Property::Action { name: "WaivePinned", holds: waive_pinned },
            Property::Action { name: "OwnerReviewPinned", holds: owner_review_pinned },
            Property::Action { name: "ReplayAgreesWithOps", holds: |m, s, a, _t| forged_diff(m, s, a).is_none() },
            Property::Action { name: "ReplayAgreesWithOpsOnAuthority", holds: |m, s, a, _t| forged_diff(m, s, a) != Some(Diff::Other) },
            Property::LeadsTo { name: "ExecBlockResolves", p: exec_block_open, q: |m, s| !exec_block_open(m, s) },
            // non-vacuity witnesses: each is expected VIOLATED (the situation is reachable)
            Property::Invariant { name: "WitnessNoMerge", holds: |_m, s| s.trunk.merged.is_none() },
            Property::Invariant { name: "WitnessNoBadMerge", holds: |_m, s| s.trunk.merged != Some(Content::Bad) },
            Property::Invariant { name: "WitnessNoBreaksMerge", holds: |_m, s| s.trunk.merged != Some(Content::Breaks) },
            Property::Action {
                name: "WitnessNoParentEasing",
                holds: |m, s, a, _t| !matches!(a, Action::Do { e, .. } if by_of(e).map(P::role) == Some(Role::Parent) && m.eases(s, e)),
            },
            Property::Action {
                name: "WitnessNoFlakyWaived",
                holds: |_m, s, a, _t| {
                    !matches!(a, Action::Do { e: E::Waive { cites, .. }, .. } if (0..s.blocks.len()).any(|i| cites & (1 << i) != 0 && s.blocks[i].st == Bst::Flaky))
                },
            },
            Property::Invariant { name: "WitnessNoConflict", holds: |_m, s| s.cp & s.cf == 0 },
            // one witness per class of replay-only entries (forge mode): each is expected VIOLATED
            Property::Action { name: "WitnessReplayOnlyPlanClaims", holds: |m, s, a, _t| forged_diff(m, s, a) != Some(Diff::PlanClaims) },
            Property::Action { name: "WitnessReplayOnlyObs", holds: |m, s, a, _t| forged_diff(m, s, a) != Some(Diff::ObsNotCurrent) },
            Property::Action { name: "WitnessReplayOnlyUnmeasured", holds: |m, s, a, _t| forged_diff(m, s, a) != Some(Diff::Unmeasured) },
            Property::Action {
                name: "WitnessNoApprovedMerge",
                holds: |_m, s, a, _t| !(merging(a) && s.plan.approve),
            },
        ]
    }
}

// ------------------------------------------------------------------------------------------------------------------
// Registry

fn parse_plan(c: &mut Consts) -> Result<Plan, String> {
    let check = match c.string("CHECK", "strict").as_str() {
        "absent" => Chk::Absent,
        "strict" => Chk::Strict,
        "weak" => Chk::Weak,
        v => return Err(format!("CHECK={v}: expected absent, strict or weak")),
    };
    let evid = match c.string("EVIDENCE", "none").as_str() {
        "none" => Ev::None,
        "reviewer" => Ev::Reviewer,
        "owner" => Ev::Owner,
        v => return Err(format!("EVIDENCE={v}: expected none, reviewer or owner")),
    };
    let rcount = c.uint("RCOUNT", 1)?;
    let rrank = c.uint("RRANK", 1)?;
    let allow = c.uint("ALLOW", 0)?;
    if rcount > 2 || !(1..=2).contains(&rrank) || allow > 7 {
        return Err("RCOUNT in 0..2, RRANK in 1..2, ALLOW a bit set in 0..7 (1 review_count:0, 2 checks:[*], 4 adopt)".into());
    }
    Ok(Plan { check, exec: c.bool("EXEC", false)?, rcount: rcount as u8, rrank: rrank as u8, approve: c.bool("APPROVE", false)?, evid, allow: allow as u8 })
}

pub fn build_model(mode: &str, c: &mut Consts) -> Result<Owed05, String> {
    let mode = match mode {
        "tools" => Mode::Tools,
        "forge" => Mode::Forge,
        "gate" => Mode::Gate,
        m => return Err(format!("unknown mode {m}")),
    };
    let genesis = parse_plan(c)?;
    let mut abl = 0u32;
    for v in c.string("ABLATE", "none").split(',').map(str::trim).filter(|v| !v.is_empty() && *v != "none") {
        abl |= 1 << ABLATIONS.iter().find(|(n, _)| *n == v).ok_or_else(|| format!("ABLATE={v}: unknown ablation"))?.1 as u32;
    }
    let mut contents = Vec::new();
    for ch in c.string("CONTENTS", "gbfk").chars() {
        contents.push(match ch {
            'g' => Content::Good,
            'b' => Content::Bad,
            'f' => Content::Flaky,
            'k' => Content::Breaks,
            _ => return Err("CONTENTS: letters g (good), b (bad), f (flaky), k (breaks the invariant)".into()),
        });
    }
    let small = |c: &mut Consts, k: &str, d: u64| -> Result<u8, String> {
        let v = c.uint(k, d)?;
        if v > 6 { Err(format!("{k} must be at most 6")) } else { Ok(v as u8) }
    };
    Ok(Owed05 {
        mode,
        abl,
        combos: c.bool("COMBOS", false)?,
        genesis,
        contents,
        submits: small(c, "SUBMITS", 2)?,
        plans: small(c, "PLANS", 1)?,
        reviews: small(c, "REVIEWS", 2)?,
        main: small(c, "MAIN", 2)?,
        forge: small(c, "FORGE", 1)?,
        attempts: small(c, "ATTEMPTS", 1)?.max(1),
        adopt: c.bool("ADOPT", true)?,
        fair: c.bool("FAIR", true)?,
    })
}

fn build(mode: &str, c: &mut Consts) -> Result<Box<dyn DynModel>, String> {
    Ok(Box::new(build_model(mode, c)?))
}

pub fn info() -> ModelInfo {
    ModelInfo {
        name: "owed05",
        about: "owed 0.5 acceptance and authority: plans/allowances, reviews, blocks, waivers, merge guard, D25 delegated owner",
        modes: &["tools", "forge", "gate"],
        consts: &[
            ("CHECK", "strict"),
            ("EXEC", "false"),
            ("RCOUNT", "1"),
            ("RRANK", "1"),
            ("APPROVE", "false"),
            ("EVIDENCE", "none"),
            ("ALLOW", "0"),
            ("CONTENTS", "gbfk"),
            ("SUBMITS", "2"),
            ("PLANS", "1"),
            ("REVIEWS", "2"),
            ("MAIN", "2"),
            ("FORGE", "1"),
            ("ATTEMPTS", "1"),
            ("ADOPT", "true"),
            ("FAIR", "true"),
            ("COMBOS", "false"),
            ("ABLATE", "none"),
        ],
        source_file: file!(),
        source: include_str!("owed05.rs"),
        build,
    }
}
