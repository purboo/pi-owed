----------------------------- MODULE PiDagMerge -----------------------------
EXTENDS Naturals, FiniteSets, Sequences, TLC
CONSTANTS Mode, Scenario, O, K0, K1
\* One node, one invariant o; distinct content keys are model values. No
\* symmetry: K0 (PRE/original) and K1 (candidate) have different roles.
\* Scenario is a small executable environment, not a switch in properties.
\* Every observer is distinct from the writer. High reviewer is accurate;
\* low reviewer and flaky runner can say either pass or fail on either truth.
\* Negative is a truthful diagnostic by an accurate observer (review rank 2,
\* exact diagnostic rank 1). Rank 1 also admits inaccurate observers; rank
\* is policy authority, not a theorem of equal diagnostic accuracy.
VARIABLE x
vars == <<x>>
A3 == Mode # "a22"
Clause(c) == A3 /\ Mode # ("a3-" \o c)
ObsKey(k) == IF Clause("K1") THEN k ELSE IF A3 THEN K0 ELSE k
Item(k) == IF Clause("K3") THEN <<O,k>> ELSE O
Launder == Scenario \in {"launderTest", "launderReview", "rerun"}
DebtCase == Scenario \in {"flakyDebt", "matrix", "genesis", "falsePass", "defer", "oldDebt", "waiver"}
Bad == Scenario \notin {"good", "live"}
Changed == Scenario # "oldDebt"
CK == IF Changed THEN K1 ELSE K0
PreObs == CASE Launder -> {"fail"}
           [] Scenario = "flakyDebt" -> {"pass","fail"}
           [] Scenario \in {"matrix","oldDebt"} -> {}
           [] OTHER -> {"pass"}
PreTruth == ~(Scenario = "oldDebt" \/ Launder)
Init == x = [phase |-> "genesis", obs |-> [k \in {K0,K1} |-> {}],
  genesis |-> FALSE, head |-> 0, snap |-> 0, sealed |-> FALSE,
  rank |-> 0, conflict |-> FALSE, accurateSeen |-> FALSE,
  original |-> {}, rerunDone |-> FALSE, key |-> K0,
  merged |-> FALSE, badMerged |-> FALSE, freshBlockMerged |-> FALSE,
  unobservedMerged |-> FALSE, waivedStateMerged |-> FALSE,
  truth |-> PreTruth, deferred |-> FALSE, waiver |-> FALSE,
  stateWaiver |-> FALSE, debtAfter |-> FALSE, lateBlock |-> FALSE,
  invalidated |-> FALSE, lease |-> FALSE, leaseUsed |-> FALSE,
  conflictMerge |-> FALSE, unrelated |-> FALSE]
Genesis == /\ x.phase = "genesis"
 /\ x' = [x EXCEPT !.phase = "start", !.genesis = TRUE,
    !.obs[K0] = PreObs, !.head = @ + 1]
SkipGenesis == /\ x.phase = "genesis" /\ ~Clause("K4")
 /\ x' = [x EXCEPT !.phase = "start"]
Start == /\ x.phase = "start"
 /\ x' = [x EXCEPT !.phase = IF Launder THEN "negative" ELSE "observe",
    !.key = IF Launder THEN K0 ELSE CK]
Negative == /\ x.phase = "negative"
 /\ x' = [x EXCEPT !.phase = "edit", !.obs[K0] = {"fail"},
    !.original = {"fail"}, !.accurateSeen = TRUE,
    !.sealed = TRUE, !.rank = IF Scenario = "launderReview" THEN 2 ELSE 1,
    !.head = @ + 1]
\* Cosmetic edit changes bytes/key, not hidden truth or the node name.
Edit == /\ x.phase = "edit"
 /\ x' = [x EXCEPT !.phase = "observe", !.key = K1]
Results == IF Scenario \in {"launderTest", "launderReview", "rerun", "falsePass", "good"}
           THEN {"pass","fail"}
           ELSE IF Scenario \in {"matrix","genesis","oldDebt","waiver"} THEN {"unknown"}
           ELSE IF Scenario \in {"flakyDebt","defer"} THEN {"fail"}
           ELSE {"pass"}
\* K2's withdrawal literally permits any eligible >= rank affirmative
\* observer. A flaky executor is rank 1. Low reviewers cannot withdraw rank 2.
Observe(r) == /\ x.phase = "observe" /\ r \in Results
 /\ x' = [x EXCEPT !.phase = "decide",
    !.obs[ObsKey(x.key)] = @ \cup (IF r = "unknown" THEN {} ELSE {r}),
    !.sealed = IF Clause("K2") /\ r = "pass" /\ x.rank <= 1
                      /\ Scenario # "rerun" THEN FALSE ELSE @,
    !.head = @ + 1]
\* An accurate high-rank reviewer exists, including on good content. The
\* environment may finish with low observations; availability is not necessity.
HighObserve == /\ x.phase = "decide" /\ Scenario \in {"launderReview","good","falsePass"}
 /\ "high" \notin x.original
 /\ x' = [x EXCEPT !.original = @ \cup {"high"},
    !.obs[ObsKey(x.key)] = @ \cup {IF Bad THEN "fail" ELSE "pass"},
    !.sealed = Bad, !.rank = 2, !.accurateSeen = @ \/ Bad,
    !.head = @ + 1]
\* Original-key rerun is a real observation, not a current-key pass.
\* Here the old key is deterministic bad; pass branch additionally exercises
\* attribution of a flaky original (permitted for launderTest).
Rerun(r) == /\ x.phase = "decide" /\ Scenario \in {"launderTest","rerun"} /\ ~x.rerunDone
 /\ r \in (IF Scenario = "launderTest" THEN {"pass","fail"} ELSE {"fail"})
 /\ x' = [x EXCEPT !.rerunDone = TRUE, !.sealed = FALSE,
    !.conflict = r = "pass", !.original = @ \cup {r}, !.head = @ + 1]
OwnerWaive == /\ x.phase = "decide" /\ Launder /\ ~x.waiver
 /\ x' = [x EXCEPT !.waiver = TRUE, !.head = @ + 1]
Defer == /\ x.phase = "decide" /\ Scenario = "defer" /\ ~x.deferred
 /\ x' = [x EXCEPT !.deferred = TRUE, !.head = @ + 1]
StateWaive == /\ x.phase = "decide" /\ Scenario = "waiver"
 /\ ~Clause("K3state") /\ ~x.stateWaiver
 /\ x' = [x EXCEPT !.stateWaiver = TRUE, !.head = @ + 1]
Evidence(k) == x.obs[ObsKey(k)] = {"pass"}
PreDebt == IF x.obs[K0] = {"pass"} THEN {} ELSE {Item(K0)}
NextDebt == IF Evidence(CK) \/ x.stateWaiver THEN {} ELSE {Item(CK)}
NodeOK == IF Launder THEN
  x.waiver \/ (Evidence(x.key) /\ (~Clause("K2") \/ (~x.sealed /\ ~x.conflict)))
  ELSE Evidence(x.key) \/ DebtCase
Guard == /\ (~Clause("K4") \/ x.genesis)
 /\ NodeOK
 /\ (IF DebtCase THEN x.deferred \/ NextDebt \subseteq PreDebt ELSE TRUE)
Eval == /\ x.phase = "decide" /\ Guard
 /\ x' = [x EXCEPT !.phase = "commit", !.snap = x.head]
\* Race scenario is explicitly the model-fidelity review's two-phase
\* implementation stress case. a2.2 section 3.3 literally says atomic guard +
\* append, which excludes this execution; its PRE/policy-only token does not.
\* Report distinguishes the implementation finding from the atomic spec.
LateBlock == /\ x.phase = "commit" /\ Scenario = "race" /\ ~x.lateBlock
 /\ x' = [x EXCEPT !.lateBlock = TRUE, !.sealed = TRUE, !.rank = 2,
    !.accurateSeen = TRUE,
    !.obs[ObsKey(x.key)] = @ \cup {"fail"}, !.head = @ + 1]
UnrelatedObservation == /\ x.phase = "commit" /\ ~x.unrelated
 /\ x' = [x EXCEPT !.unrelated = TRUE, !.head = @ + 1]
Commit == /\ x.phase = "commit"
 /\ (~Clause("K5atomic") \/ Guard)
 /\ x' = [x EXCEPT !.phase = "done", !.merged = TRUE,
    !.badMerged = Bad /\ x.accurateSeen /\ ~x.waiver,
    !.freshBlockMerged = x.lateBlock,
    !.unobservedMerged = ~x.genesis,
    !.waivedStateMerged = x.stateWaiver,
    !.truth = ~Bad, !.debtAfter = ~Evidence(CK), !.head = @ + 1]
Retry == /\ x.phase = "commit" /\ Clause("K5atomic") /\ ~Guard
 /\ x' = [x EXCEPT !.phase = "decide"]
\* Unknown is not rejection. A scheduled accurate full run can finish the
\* previously omitted matrix/invariant observation before a final decision.
FinishObservation == /\ x.phase = "decide"
 /\ DebtCase /\ x.obs[ObsKey(CK)] = {}
 /\ x' = [x EXCEPT !.obs[ObsKey(CK)] = {IF Bad THEN "fail" ELSE "pass"},
    !.accurateSeen = @ \/ Bad, !.head = @ + 1]
\* Rejection is a genuinely finished negative decision, not an unknown wait.
\* Terminal stuttering never substitutes for an unfinished check.
Reject == /\ x.phase = "decide" /\ ~Guard
 /\ ("fail" \in x.obs[ObsKey(x.key)] \/ x.sealed \/ x.conflict)
 /\ x' = [x EXCEPT !.phase = "rejected"]
Terminal == /\ x.phase \in {"done","rejected"} /\ UNCHANGED x

\* Liveness abstraction: 'invalidated' is exact PRE equality, not a wrapping
\* trunk counter. Each Rival event represents another distinct trunk commit.
\* No infinite ledger is stored; this finite quotient preserves PRE validity.
\* Serial queue reading of revised K5: a finite FIFO prefix has finished
\* when LiveStart admits this candidate at the head. Its validation turn is
\* retained until success; lease expiration releases the resource lease, not
\* FIFO position. Work is finite and weakly fairly scheduled, not time bounded.
LiveStart == /\ x.phase = "start"
 /\ x' = [x EXCEPT !.phase = "prepare", !.leaseUsed = A3, !.lease = A3]
Acquire == /\ x.phase = "prepare" /\ A3 /\ ~x.lease
 /\ x' = [x EXCEPT !.lease = TRUE, !.leaseUsed = TRUE]
Prepare == /\ x.phase = "prepare"
 /\ x' = [x EXCEPT !.phase = "validate", !.invalidated = FALSE]
Validate == /\ x.phase = "validate"
 /\ x' = [x EXCEPT !.phase = "ready"]
LiveCommit == /\ x.phase = "ready" /\ ~x.invalidated
 /\ x' = [x EXCEPT !.phase = "done", !.merged = TRUE,
    !.lease = FALSE, !.leaseUsed = FALSE]
Rebase == /\ x.phase = "ready" /\ x.invalidated
 /\ x' = [x EXCEPT !.phase = "prepare"]
Rival == /\ x.phase \in {"prepare","validate","ready"}
 /\ (~Clause("K5queue") \/ ~x.leaseUsed)
 /\ x' = [x EXCEPT !.invalidated = TRUE, !.conflictMerge = @ \/ x.lease]
Expire == /\ x.lease /\ x.phase \in {"prepare","validate","ready"}
 /\ x' = [x EXCEPT !.lease = FALSE]
SafetyNext == Start \/ Negative \/ Edit \/ (\E r \in Results : Observe(r))
 \/ HighObserve \/ (\E r \in {"pass","fail"} : Rerun(r)) \/ OwnerWaive
 \/ Defer \/ StateWaive \/ Eval \/ LateBlock \/ UnrelatedObservation
 \/ Commit \/ Retry \/ FinishObservation \/ Reject
LiveNext == LiveStart \/ Acquire \/ Prepare \/ Validate
 \/ LiveCommit \/ Rebase \/ Rival \/ Expire
Next == Genesis \/ SkipGenesis \/ Terminal
 \/ (IF Scenario = "live" THEN LiveNext ELSE SafetyNext)
Spec == Init /\ [][Next]_vars
 /\ WF_vars(Genesis) /\ WF_vars(LiveStart) /\ WF_vars(Acquire)
 /\ WF_vars(Prepare) /\ WF_vars(Validate) /\ WF_vars(LiveCommit)
 /\ WF_vars(Rebase) /\ WF_vars(Expire)

\* Truth/history properties: none invokes Guard, NodeOK or evidence admission.
\* Independent historical fact: accurate failure + still bad + no owner waiver.
NoLaundering == ~x.badMerged
\* A rerun history containing both outcomes never constitutes acceptance
\* without explicit owner risk acceptance; reads history, not seal/Guard.
NoFlakyRerunEscape == ~(x.merged /\ x.rerunDone /\ "pass" \in x.original /\ ~x.waiver)
\* Hidden state predicate at PRE and actual commit, not observed D inclusion.
NoNewBreakage == [][(x'.merged /\ ~x.merged /\ x.truth /\ ~x'.truth)
                         => x.deferred]_vars
\* Audit fact: a new BLOCK really arrived after evaluation, before commit.
JudgedAtCommit == ~x.freshBlockMerged
\* Event history, independent from evidence values or the merge guard.
GenesisBeforeAdvance == ~x.unobservedMerged
\* Actual recorded disposition: a state invariant was exempted at acceptance.
StateNeverWaived == ~x.waivedStateMerged
\* Ground-truth broken state still appears as debt after an authorized deferral.
DeferredDebtVisible == (x.merged /\ x.deferred /\ ~x.truth) => x.debtAfter
\* History records whether a rival actually advanced while lease was held.
LeaseExcludes == ~x.conflictMerge
\* Non-vacuity witnesses intentionally violated by a successful merge.
NothingMerged == ~x.merged
NoDeferredMerge == ~(x.merged /\ x.deferred)
NoOwnerWaivedMerge == ~(x.merged /\ x.waiver)
NoUnrelatedMerge == ~(x.merged /\ x.unrelated)
NoOldDebtMerge == ~(x.merged /\ ~PreTruth)
GoodEventuallyMerges == <>x.merged
=============================================================================
