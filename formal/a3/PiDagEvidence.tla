-------------------------- MODULE PiDagEvidence --------------------------
EXTENDS Integers, FiniteSets, Sequences
CONSTANTS Mode, Scope
(***************************************************************************
 Finite executable fixtures, not an ideal reviewer. One dispatch/attempt;
 a22 = literal inherited a2.2 rules; a3 = K6/K7/K10; a3-X removes X only.
 Truth operators below never inspect Mode or the merge/observation guards.
 Each fixture isolates a mechanism; tokens stand for content hashes/paths.
 No symmetric interchangeable identities: symmetry reduction is inapplicable.
***************************************************************************)
Scenes == {"good", "honestStub", "closureEdit", "overlay", "bounds",
           "negative", "tracing", "target", "cfset", "trivial", "swap",
           "identity", "shape", "modelKey", "promptKey", "classKey",
           "claimedRun", "drift", "speech", "vacuous", "weak"}
DeclaredScenes == {"declaredOK", "declaredWriter", "declaredStranger"}
DeclaredMode == Mode \in {"a3-declared", "a3-declared-label", "a3-declared-auth"}
\* Independent principal facts: the writer has authority but is disqualified;
\* the stranger is not a writer but has no authority. Only parent has both.
Declarer(s) == CASE s = "declaredWriter" -> "writer"
               [] s = "declaredStranger" -> "stranger" [] OTHER -> "parent"
Authorized == {"parent", "writer"}
Writers == {"writer"}
Enabled(c) == Mode # "a22" /\ Mode # "a3-" \o c
ClosureScenes == {"closureEdit", "overlay", "bounds", "negative", "tracing"}
ReviewScenes == {"identity", "shape", "modelKey", "promptKey", "classKey", "drift"}
VARIABLES scene, pc, packet, target, cfs, closure, reads, traceOK,
          exec, strength, decoyVerdict, realVerdict, calibrated,
          revealed, receipt, merged
vars == <<scene, pc, packet, target, cfs, closure, reads, traceOK,
          exec, strength, decoyVerdict, realVerdict, calibrated,
          revealed, receipt, merged>>

\* Independent fixture semantics: actual code produces 0 on the real defect.
RealValue(s) == IF s \in {"good", "honestStub", "speech"} THEN 1 ELSE 0
\* Independent execution fixture: claimedRun has only a test execution;
\* no execution of the reviewer's claimed experiment ever happened.
ReviewActuallyRan(s) == s # "claimedRun"
IssuedReceipts(s) == IF s = "claimedRun" THEN {"test-run"}
                     ELSE {"test-run", "review-run"}
\* Strong tests exercise the real defect; weak tests only exercise a sample.
ChecksReal(s) == s \in (ClosureScenes \cup DeclaredScenes) \/ s \in {"good", "honestStub"}
ActualRun(s, judge) ==
  IF judge = "evil" THEN "pass"
  ELSE IF ChecksReal(s) /\ RealValue(s) = 0 THEN "assert" ELSE "pass"
\* A concrete fault detection truth table: helper/default-return assertions
\* miss the target defect; swapped bundle loses one formerly killed negative.
Killed(s) == CASE s = "vacuous" -> {}
  [] s \in {"target", "cfset"} -> {"helper", "default"}
  [] s = "trivial" -> {"target", "default"}
  [] s = "swap" -> {"target", "default", "n1"}
  [] OTHER -> {"target", "default", "n1", "n2"}
FaultResult(s, f) == IF s = "honestStub" THEN "NotImplemented"
                    ELSE IF f \in Killed(s) THEN "assert" ELSE "pass"
LawNegatives == {"n1", "n2"}
NewR2(s) == s \in {"trivial", "swap", "weak", "good", "honestStub"}
\* Old bundle killed both negatives. Ordinary law threshold is 1/2 in swap;
\* preserving achieved kill rate requires 2/2 despite its threshold being met.
LawMinimum(s) == IF s = "swap" THEN 1 ELSE 2
TruthKills(s) == Cardinality(Killed(s) \cap LawNegatives)
TrueReads(s) == CASE s = "bounds" \/ s \in DeclaredScenes -> {"src", "outside"}
  [] s = "negative" -> {"src", "absent-conftest"}
  [] OTHER -> {"src", "runner"}
AllowedReads == {"src", "runner"}

Init ==
 /\ scene \in (IF Scope = "honest" THEN {"good", "honestStub"}
                 ELSE IF Scope = "declared" THEN DeclaredScenes \cup {"closureEdit"}
                 ELSE IF Scope = "safety" THEN Scenes \ {"honestStub"}
                 ELSE {Scope}) /\ pc = 0
 /\ packet = <<"none", {}>> /\ target = "none" /\ cfs = {}
 /\ closure = "none" /\ reads = {} /\ traceOK = TRUE
 /\ exec = "none" /\ strength = FALSE
 /\ decoyVerdict = "none" /\ realVerdict = "none"
 /\ calibrated = FALSE /\ revealed = FALSE /\ receipt = "none" /\ merged = FALSE

Dispatch ==
 /\ pc = 0
 /\ packet' = <<"target", {"target"}>>
 /\ target' = "target" /\ cfs' = {"target"} /\ pc' = 1
 /\ UNCHANGED <<scene, closure, reads, traceOK, exec, strength,
                decoyVerdict, realVerdict, calibrated, revealed, receipt, merged>>

Write ==
 /\ pc = 1
 /\ target' = IF scene = "target" /\ ~Enabled("target") THEN "helper" ELSE target
 \* a2.2 already fixes the counterfactual set beforehand. Only its ablation
 \* permits changing that set; do not fabricate an a22 regression here.
 /\ cfs' = IF scene = "cfset" /\ Mode = "a3-cfset" THEN {"helper"} ELSE cfs
 /\ pc' = 2
 /\ UNCHANGED <<scene, packet, closure, reads, traceOK, exec, strength,
                decoyVerdict, realVerdict, calibrated, revealed, receipt, merged>>

Materialize ==
 /\ pc = 2
 /\ closure' = IF scene \in {"closureEdit", "overlay"} /\ ~Enabled("closure")
                THEN "evil" ELSE "pinned"
 /\ reads' = IF Scope = "declared" THEN {}
              ELSE IF scene = "negative" THEN {"src"} ELSE TrueReads(scene)
 /\ traceOK' = (scene # "tracing" /\ Scope # "declared")
 /\ pc' = 3
 /\ UNCHANGED <<scene, packet, target, cfs, exec, strength,
                decoyVerdict, realVerdict, calibrated, revealed, receipt, merged>>

EvidenceAllowed ==
 /\ (~Enabled("touch") \/ scene # "closureEdit")
 /\ (~Enabled("bounds") \/ reads \subseteq AllowedReads)
 /\ (~Enabled("negative") \/ scene # "negative")
 /\ (~Enabled("tracing") \/ traceOK)
Run ==
 /\ pc = 3
 /\ exec' = IF scene = "speech" THEN "speech"
            ELSE IF DeclaredMode /\ scene \in DeclaredScenes THEN
              IF Mode = "a3-declared-auth" \/
                  (Declarer(scene) \in Authorized /\ Declarer(scene) \notin Writers)
              THEN IF Mode = "a3-declared-label" THEN "pass" ELSE "declared-pass"
              ELSE "bottom"
            ELSE IF ~EvidenceAllowed THEN "bottom"
            ELSE IF scene = "negative" THEN "pass" \* old cache key omits ENOENT
            ELSE ActualRun(scene, IF scene \in {"bounds", "tracing"}
                                   THEN "evil" ELSE closure)
 /\ receipt' = (IF scene = "claimedRun" THEN "invented-id" ELSE "review-run") /\ pc' = 4
 /\ UNCHANGED <<scene, packet, target, cfs, closure, reads, traceOK, strength,
                decoyVerdict, realVerdict, calibrated, revealed, merged>>

AcceptedFailure(r) == r = "assert" \/ (Enabled("stub") /\ r = "NotImplemented")
StrengthRun ==
 /\ pc = 4
 /\ strength' =
      /\ \A f \in cfs : AcceptedFailure(FaultResult(scene,
                           IF f = "target" THEN target ELSE f))
      /\ (~NewR2(scene) \/ ~Enabled("negatives") \/
           Cardinality({f \in LawNegatives : AcceptedFailure(FaultResult(scene, f))})
               >= LawMinimum(scene))
      /\ (scene # "swap" \/ ~Enabled("floor") \/
           Cardinality({f \in LawNegatives : AcceptedFailure(FaultResult(scene, f))}) >= 2)
 /\ pc' = 5
 /\ UNCHANGED <<scene, packet, target, cfs, closure, reads, traceOK, exec,
                decoyVerdict, realVerdict, calibrated, revealed, receipt, merged>>

\* Reviewer computes verdict from observable identity, shape, or defect.
\* For feature-selective strategies, identical visible input => same output.
DecoyVisible == (scene = "identity" /\ ~Enabled("commit")) \/
                (scene = "shape" /\ ~Enabled("isomorphic"))
DifferentKey == (scene = "modelKey" /\ Enabled("model")) \/
                (scene = "promptKey" /\ Enabled("prompt")) \/
                (scene = "classKey" /\ Enabled("class"))
Judge ==
 /\ pc = 5
 /\ decoyVerdict' = "BLOCK"
 /\ realVerdict' = IF scene \in {"identity", "shape"} /\ ~DecoyVisible
                    THEN "BLOCK" ELSE "OK"
 /\ calibrated' = ~DifferentKey
 /\ pc' = 6
 /\ UNCHANGED <<scene, packet, target, cfs, closure, reads, traceOK, exec,
                strength, revealed, receipt, merged>>
Reveal ==
 /\ pc = 6 /\ revealed' = TRUE /\ pc' = 7
 /\ UNCHANGED <<scene, packet, target, cfs, closure, reads, traceOK, exec,
                strength, decoyVerdict, realVerdict, calibrated, receipt, merged>>

MergeGuard == exec \in {"pass", "declared-pass"} /\ strength /\ calibrated /\ realVerdict = "OK"
              /\ (scene # "claimedRun" \/ ~Enabled("receipt") \/ receipt \in IssuedReceipts(scene))
Merge ==
 /\ pc = 7 /\ MergeGuard /\ merged' = TRUE /\ pc' = 8
 /\ UNCHANGED <<scene, packet, target, cfs, closure, reads, traceOK, exec,
                strength, decoyVerdict, realVerdict, calibrated, revealed, receipt>>
Reject ==
 /\ pc = 7 /\ ~MergeGuard /\ scene # "honestStub" /\ pc' = 8
 /\ UNCHANGED <<scene, packet, target, cfs, closure, reads, traceOK, exec,
                strength, decoyVerdict, realVerdict, calibrated, revealed, receipt, merged>>
\* Rejected malicious attempts really finish. An honest unimplemented-stub
\* proof has no repair/escalation within this bounded attempt: expose freeze.
Terminal == pc = 8 /\ UNCHANGED vars
Next == Dispatch \/ Write \/ Materialize \/ Run \/ StrengthRun \/ Judge \/ Reveal
        \/ Merge \/ Reject \/ Terminal
Spec == Init /\ [][Next]_vars /\ WF_vars(Next)

\* Not guard restatements: compare accepted receipts to independent shadow
\* execution of the pinned judge, or complete true read-event history.
JudgeSound == scene \in ClosureScenes /\ exec = "pass" => ActualRun(scene, "pinned") = "pass"
ReadsComplete == exec = "pass" => TrueReads(scene) \subseteq (reads \cap AllowedReads)
\* Closure modification is a provenance/history requirement even when the
\* pinned overlay happens to produce the correct result (good code variant
\* is not needed: a fail still must be bottom, not an admissible observation).
NoSelfJudge == scene = "closureEdit" => exec \notin {"pass", "assert"}
\* Actual target mutant survival, not the packet-selection equality guard.
TargetDetected == merged /\ scene \in {"target", "cfset"} => "target" \in Killed(scene)
\* Hidden behavioral coverage of fixed law negatives, not strength's Boolean.
NegativeCoverage == merged /\ scene = "trivial" => TruthKills(scene) >= 2
NoCoverageDrop == merged /\ scene = "swap" => TruthKills(scene) >= 2
\* Accuracy evaluated against true defective real nodes; reviewer isn't
\* assumed accurate. Drift is deliberately separated from feature attacks.
FeatureCalibrationSound == merged /\ scene \in (ReviewScenes \ {"drift"}) => RealValue(scene) = 1
ReviewerAccurate == merged /\ scene \in ReviewScenes => RealValue(scene) = 1
\* Historical executor fact: claimed execution alone cannot supply evidence.
ExecutionHonest == merged /\ scene = "claimedRun" => ReviewActuallyRan(scene)
\* a21 regressions use actual source / test outcome truth, not guard formulas.
SelfReportIsSpeech == scene = "speech" => ~merged
NoVacuousMerged == merged => Killed(scene) # {}
\* Witnesses, intentionally false: successful work and uncovered real defects.
NothingMerged == ~merged
NoGoodMerge == ~(merged /\ scene = "good")
NoHonestMerge == ~(merged /\ scene = "honestStub")
NoWeakEscape == ~(merged /\ scene = "weak" /\ RealValue(scene) = 0)
\* K12 visible waiver: a cached pass omits the real outside dependency. The
\* card must not describe it as measured. Truth concerns a read never traced,
\* and principal eligibility; neither is the merge guard's receipt acceptance.
Card == IF exec = "declared-pass" THEN "reuse (declared closure)"
        ELSE IF exec = "pass" THEN "measured" ELSE exec
DeclaredVisible == merged /\ scene \in DeclaredScenes => Card = "reuse (declared closure)"
DeclaredAuthorized == merged /\ scene \in DeclaredScenes =>
                         Declarer(scene) = "parent"
NoDeclaredEscape == ~(merged /\ scene \in DeclaredScenes /\ RealValue(scene) = 0)
GoodEventuallyMerges == (scene \in {"good", "honestStub"}) ~> merged
=============================================================================
