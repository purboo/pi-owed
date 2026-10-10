//! owed05: bounded exhaustive checks of the owed 0.5 model (`cargo test --offline --release -p models -- owed05`).
//! Bigger bounds run through `owedmc` on ipc (formal/REPORT-mc-owed.md).

use mc::{Consts, Model, Options, Report, Trace, Verdict, check};
use models::owed05::{Action, Chk, E, Ev, IntentKind, Obl, Owed05, P, Proc, S, build_model, AD, CK, RC0};

/// The small configuration of the tests: one review, one main-agent act, no adoption (81,791 states in mode tools; a regression pin).
const SMALL: &[(&str, &str)] = &[("REVIEWS", "1"), ("MAIN", "1"), ("ADOPT", "false")];

/// Safety properties expected to hold on the real semantics in every mode.
const SAFETY: &[&str] = &[
    "EasingAuthorized",
    "NoSubagentAuthority",
    "NoSelfJudge",
    "BlockWins",
    "MergedMeansCovered",
    "BadMergeTracesToOwner",
];

fn model(mode: &str, consts: &[(&str, &str)]) -> Owed05 {
    let mut c = Consts::new();
    for (k, v) in consts {
        c.set(k, v);
    }
    let m = build_model(mode, &mut c).expect("build");
    assert!(c.unused().is_empty(), "unused constants {:?}", c.unused());
    m
}
fn with(base: &[(&'static str, &'static str)], extra: &[(&'static str, &'static str)]) -> Vec<(&'static str, &'static str)> {
    let mut v: Vec<_> = base.iter().filter(|(k, _)| !extra.iter().any(|(x, _)| x == k)).copied().collect();
    v.extend_from_slice(extra);
    v
}
fn run(m: &Owed05, props: &[&str]) -> Report<Owed05> {
    let r = check(m, &Options { workers: 4, props: props.iter().map(|p| p.to_string()).collect(), ..Default::default() });
    assert!(r.stats.complete || props.iter().all(|p| r.verdict(p) == Verdict::Violated), "incomplete run: {:?}", r.stats);
    r
}
fn assert_verdicts(r: &Report<Owed05>, props: &[&str], v: Verdict, what: &str) {
    for p in props {
        assert_eq!(r.verdict(p), v, "{what}: {p}");
    }
}
fn actions(t: &Trace<Owed05>) -> Vec<Action> {
    t.steps.iter().filter_map(|s| s.action.clone()).collect()
}

/// Every safety property holds in mode tools on several genesis plans; the witnesses show each situation is reachable.
#[test]
fn owed05_tools_safety_holds_and_witnesses_are_reachable() {
    let all: Vec<&str> = SAFETY.iter().copied().chain(["DriveClaimNeverEases", "NoSelfJudgeAtMerge", "ExecBlockResolves"]).collect();
    for genesis in [
        vec![],
        vec![("APPROVE", "true"), ("EVIDENCE", "reviewer"), ("RCOUNT", "0")],
        vec![("ALLOW", "7"), ("RCOUNT", "2"), ("RRANK", "2")],
        vec![("CHECK", "weak"), ("EVIDENCE", "owner"), ("ALLOW", "2")],
    ] {
        let consts = with(SMALL, &genesis);
        let r = run(&model("tools", &consts), &[]);
        assert!(r.stats.complete, "{genesis:?}");
        assert_verdicts(&r, &all, Verdict::Holds, &format!("tools {genesis:?}"));
        // replay-only entries need the forger
        assert_verdicts(&r, &["ReplayAgreesWithOps", "ReplayAgreesWithOpsOnAuthority"], Verdict::Holds, "tools");
        assert_verdicts(&r, &["WitnessNoMerge", "WitnessNoConflict"], Verdict::Violated, &format!("witnesses {genesis:?}"));
    }
    let r = run(&model("tools", SMALL), &[]);
    assert_eq!(r.stats.distinct, 81_791);
    assert_verdicts(&r, &["WitnessNoBreaksMerge", "WitnessNoFlakyWaived", "WitnessNoBadMerge"], Verdict::Violated, "witnesses");
    // a parent easing needs an allowance: with one main-agent act and no genesis allowance it is unreachable
    assert_eq!(r.verdict("WitnessNoParentEasing"), Verdict::Holds);
    let r = run(&model("tools", &with(SMALL, &[("ALLOW", "1")])), &["WitnessNoParentEasing", "EasingAuthorized"]);
    assert_eq!(r.verdict("WitnessNoParentEasing"), Verdict::Violated);
    assert_eq!(r.verdict("EasingAuthorized"), Verdict::Holds);
}

/// Mode forge: entries appended directly; only replay validation refuses. Safety still holds; the entries replay
/// accepts but ops would not append fall in three classes, none an authority difference.
#[test]
fn owed05_forge_replay_validation_alone_keeps_safety() {
    let consts = with(SMALL, &[("ALLOW", "2")]);
    let r = run(&model("forge", &consts), &[]);
    assert!(r.stats.complete);
    assert_verdicts(&r, SAFETY, Verdict::Holds, "forge");
    assert_verdicts(&r, &["NoSelfJudgeAtMerge", "ExecBlockResolves", "ReplayAgreesWithOpsOnAuthority"], Verdict::Holds, "forge");
    assert_verdicts(
        &r,
        &["ReplayAgreesWithOps", "WitnessReplayOnlyPlanClaims", "WitnessReplayOnlyObs", "WitnessReplayOnlyUnmeasured"],
        Verdict::Violated,
        "forge replay-only classes",
    );
    // finding: replay does not reserve parent:drive; a forged parent:drive plan update under an allowance is accepted
    assert_eq!(r.verdict("DriveClaimNeverEases"), Verdict::Violated);
    let a = actions(r.trace("DriveClaimNeverEases"));
    assert_eq!(a.len(), 1);
    assert!(matches!(&a[0], Action::Do { proc: Proc::Forger, e: E::Plan { by: P::ParentDrive, to, .. }, .. } if to.check == Chk::Absent || to.evid != Ev::None));
    // the obs class: an observation of a key that is not the candidate's (D24.1: a fact about its key)
    let a = actions(r.trace("WitnessReplayOnlyObs"));
    assert!(matches!(a.last(), Some(Action::Do { proc: Proc::Forger, e: E::ObsCheck { .. }, .. })));
}

/// Findings on the real semantics, with their shortest traces.
#[test]
fn owed05_findings_have_shortest_traces() {
    let r = run(&model("tools", SMALL), &["WaivePinned", "OwnerReviewPinned", "NoSelfJudgeProcess"]);
    // owed_waive: decided on candidate #1, recorded on candidate #2 (no pin, unlike owed_approve)
    let a = actions(r.trace("WaivePinned"));
    assert_eq!(a.len(), 5, "{a:?}");
    assert!(matches!(a[2], Action::Decide(i) if matches!(i.kind, IntentKind::Waive { .. }) && i.cand == 1));
    assert!(matches!(a[3], Action::Do { proc: Proc::WriterSub, e: E::Submit { .. }, .. }));
    assert!(matches!(&a[4], Action::Do { proc: Proc::Main, e: E::Waive { by: P::Owner, .. }, pin: Some(i) } if i.cand == 1));
    assert_eq!(r.trace("WaivePinned").last_state().cand.map(|c| c.id), Some(2));
    assert_eq!(actions(r.trace("OwnerReviewPinned")).len(), 5);
    // delegated owed_approve: the pin is taken in the call, after the main agent decided on candidate #1
    let r = run(&model("tools", &with(SMALL, &[("APPROVE", "true")])), &["ApprovePinned"]);
    let a = actions(r.trace("ApprovePinned"));
    assert_eq!(a.len(), 5, "{a:?}");
    assert!(matches!(&a[4], Action::Do { proc: Proc::Main, e: E::Review { obl: Obl::Approve, .. }, pin: Some(i) } if i.cand == 1));
    assert_eq!(r.trace("ApprovePinned").last_state().cand.map(|c| c.id), Some(2));
    let r = run(&model("tools", SMALL), &["NoSelfJudgeProcess"]);
    // a writer subagent records an ok review under another reviewer id (identities are claims)
    let a = actions(r.trace("NoSelfJudgeProcess"));
    assert_eq!(a.len(), 3);
    assert!(matches!(&a[2], Action::Do { proc: Proc::WriterSub, e: E::Review { by: P::Rev(_), ok: true, .. }, .. }));
    // reviewer:A#2 reviewed in attempt 1 (allowed: not yet a writer); item() counts it for writer:A#2's candidate
    let r = run(&model("tools", &with(SMALL, &[("ATTEMPTS", "2")])), &["NoSelfJudgeAtMerge"]);
    let a = actions(r.trace("NoSelfJudgeAtMerge"));
    assert_eq!(a.len(), 9, "{a:?}");
    assert!(a.iter().any(|x| matches!(x, Action::Do { e: E::Review { by: P::RevW(2), ok: true, .. }, .. })));
    assert!(matches!(a.last(), Some(Action::Do { e: E::Merge, .. })));
}

/// Each modeled guard, removed, flips a property that holds with it (same configuration).
#[test]
fn owed05_ablations_flip_a_property() {
    let s: Vec<(&str, &str)> = SMALL.to_vec();
    let cases: Vec<(&str, &str, Vec<(&str, &str)>, &str)> = vec![
        ("owner-downgrade", "tools", s.clone(), "EasingAuthorized"),
        ("delegated-note", "tools", s.clone(), "EasingAuthorized"),
        ("star-covered", "tools", with(&s, &[("ALLOW", "2")]), "EasingAuthorized"),
        ("allow-free", "tools", with(&s, &[("MAIN", "2"), ("PLANS", "2")]), "EasingAuthorized"),
        ("next-allow,allow-free", "tools", with(&s, &[("COMBOS", "true")]), "EasingAuthorized"),
        ("adopt-role", "tools", with(&s, &[("ADOPT", "true")]), "EasingAuthorized"),
        ("waive-role", "forge", s.clone(), "BlockWins"),
        ("waive-cites", "tools", s.clone(), "BlockWins"),
        ("dissent", "tools", with(&s, &[("REVIEWS", "2")]), "BlockWins"),
        ("flaky", "tools", s.clone(), "BlockWins"),
        ("recusal", "tools", s.clone(), "NoSelfJudge"),
        ("evidence-writer", "tools", with(&s, &[("EVIDENCE", "reviewer")]), "NoSelfJudge"),
        ("merge-guard", "tools", s.clone(), "MergedMeansCovered"),
        ("inv-guard", "tools", s.clone(), "BadMergeTracesToOwner"),
        ("approve-role", "tools", with(&s, &[("APPROVE", "true")]), "MergedMeansCovered"),
        ("pin", "gate", with(&s, &[("APPROVE", "true")]), "ApprovePinned"),
        ("dsa", "tools", s.clone(), "NoSubagentAuthority"),
    ];
    for (abl, mode, consts, prop) in cases {
        let base = run(&model(mode, &consts), &[prop]);
        assert_eq!(base.verdict(prop), Verdict::Holds, "baseline of {abl}");
        let ablated = run(&model(mode, &with(&consts, &[("ABLATE", abl)])), &[prop]);
        assert_eq!(ablated.verdict(prop), Verdict::Violated, "ablation {abl}");
    }
    // redundant guards: alone they flip nothing (the reason is in the report)
    for (abl, consts) in [("next-allow", with(&s, &[("COMBOS", "true")])), ("invalidate", s.clone())] {
        let r = run(&model("tools", &with(&consts, &[("ABLATE", abl)])), SAFETY);
        assert_verdicts(&r, SAFETY, Verdict::Holds, abl);
    }
}

/// ExecBlockResolves (an execution block on an open candidate is cleared or marked flaky) needs weak fairness of the
/// driver's attest; without it a lasso stutters with the block active.
#[test]
fn owed05_liveness_needs_fair_attest() {
    let r = run(&model("tools", SMALL), &["ExecBlockResolves"]);
    assert_eq!(r.verdict("ExecBlockResolves"), Verdict::Holds);
    let m = model("tools", &with(SMALL, &[("FAIR", "false")]));
    let r = run(&m, &["ExecBlockResolves"]);
    assert_eq!(r.verdict("ExecBlockResolves"), Verdict::Violated);
    let t = r.trace("ExecBlockResolves");
    assert!(t.loop_start.is_some());
    let last: &S = t.last_state();
    assert!(last.open && last.cand.is_some() && last.blocks.iter().any(|b| !b.judgment));
}

/// The replay guard (validateDraft) on hand-built states: the D21/D25 rules the properties rely on.
#[test]
fn owed05_plan_guard_units() {
    let m = model("tools", SMALL);
    let s0 = m.init().remove(0);
    let at = |allow: u8| S { plan: models::owed05::Plan { allow, ..s0.plan }, owner_rules: allow, ..s0.clone() };
    let plan = |s: &S, f: &dyn Fn(&mut models::owed05::Plan), by: P, note: bool| -> bool {
        let mut to = s.plan;
        f(&mut to);
        // ops computes the claimed downgrades (planDowngrades); the reducer adds the ones it detects
        m.validate(s, &E::Plan { by, to, claimed: vec![], note, delegated: true }).is_ok()
    };
    let drop_check = |p: &mut models::owed05::Plan| p.check = Chk::Absent;
    let weaken = |p: &mut models::owed05::Plan| p.check = Chk::Weak;
    let exec = |p: &mut models::owed05::Plan| p.exec = true;
    let count0 = |p: &mut models::owed05::Plan| p.rcount = 0;
    let add_ck = |p: &mut models::owed05::Plan| p.allow |= CK;
    // parent: covered only by a checks rule of the prior plan
    assert!(!plan(&at(0), &drop_check, P::ParentMain, false));
    assert!(plan(&at(CK), &drop_check, P::ParentMain, false));
    assert!(plan(&at(CK), &weaken, P::ParentDrive, false), "a definition change is a check weakening");
    assert!(!plan(&at(RC0 | AD), &drop_check, P::ParentMain, false));
    // the `*` item (exec changed) and allow changes are never covered
    assert!(!plan(&at(CK | RC0 | AD), &exec, P::ParentMain, false));
    assert!(!plan(&at(0), &add_ck, P::ParentMain, false));
    // review count lowered: covered by review_count 0; rank lowering never (no review_rank rule)
    assert!(plan(&at(RC0), &count0, P::ParentMain, false));
    let s2 = S { plan: models::owed05::Plan { rrank: 2, ..at(RC0).plan }, ..at(RC0) };
    assert!(!plan(&s2, &|p| p.rrank = 1, P::ParentMain, false));
    // approve removed: never covered
    let s3 = S { plan: models::owed05::Plan { approve: true, ..at(CK).plan }, ..at(CK) };
    assert!(!plan(&s3, &|p| p.approve = false, P::ParentMain, false));
    // D25.5: a delegated owner downgrade needs a note; strengthening needs nothing
    assert!(!plan(&at(0), &drop_check, P::Owner, false));
    assert!(plan(&at(0), &drop_check, P::Owner, true));
    assert!(plan(&at(0), &|p| p.rcount = 2, P::ParentMain, false));
    // evidence owner -> reviewer is "weakened" (coverable); reviewer -> owner is not a downgrade
    let s4 = S { plan: models::owed05::Plan { evid: Ev::Owner, ..at(0).plan }, ..at(0) };
    assert!(!plan(&s4, &|p| p.evid = Ev::Reviewer, P::ParentMain, false));
    let s5 = S { plan: models::owed05::Plan { evid: Ev::Reviewer, ..at(0).plan }, ..at(0) };
    assert!(plan(&s5, &|p| p.evid = Ev::Owner, P::ParentMain, false));
    // non-owner roles never update the plan
    assert!(m.validate(&at(0), &E::Plan { by: P::Rev(1), to: at(0).plan, claimed: vec![], note: true, delegated: false }).is_err());
    // waive is owner-only and needs the current candidate
    assert!(m.validate(&s0, &E::Waive { by: P::Owner, obl: Obl::Review, key: models::owed05::Key::Patch(models::owed05::Patch { c: models::owed05::Content::Good, base: None }), cites: 0, reason: true, delegated: true }).is_err());
}

/// Mode gate (OWED_CONFIRM=owner): the approve pin holds there too; an owner downgrade confirmed in a dialog needs no
/// note (D25.5 applies to delegated acts).
#[test]
fn owed05_gate_mode() {
    let consts = with(SMALL, &[("APPROVE", "true")]);
    let r = run(&model("gate", &consts), &[]);
    assert!(r.stats.complete);
    assert_verdicts(&r, SAFETY, Verdict::Holds, "gate");
    assert_eq!(r.verdict("ApprovePinned"), Verdict::Holds);
    assert_eq!(r.verdict("WitnessNoApprovedMerge"), Verdict::Violated);
    let g = model("gate", SMALL);
    let s0 = g.init().remove(0);
    let to = models::owed05::Plan { check: Chk::Absent, ..s0.plan };
    assert!(g.validate(&s0, &E::Plan { by: P::Owner, to, claimed: vec![], note: false, delegated: false }).is_ok());
    assert!(g.validate(&s0, &E::Plan { by: P::Owner, to, claimed: vec![], note: false, delegated: true }).is_err());
    // results do not depend on the worker count
    let one = check(&g, &Options { workers: 1, props: vec!["MergedMeansCovered".into()], ..Default::default() });
    let eight = check(&g, &Options { workers: 8, props: vec!["MergedMeansCovered".into()], ..Default::default() });
    assert_eq!(one.stats.distinct, eight.stats.distinct);
    assert_eq!(one.stats.generated, eight.stats.generated);
}
