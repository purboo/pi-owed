------------------------------- MODULE PiDag -------------------------------
(***************************************************************************)
(* Small-scope model of ARCHITECTURE.md judgment and trunk rules.         *)
(* Mode "a1" follows draft a1 literally; mode "a2" follows draft a2;      *)
(* mode "a3" is a2 with negative-observation priority extended to W2.    *)
(* The point is comparative: the same adversarial environment, two rule   *)
(* sets.  Truth (good/bad content) is hidden from the rules and only used *)
(* by the observers and by the invariants.                                 *)
(*                                                                         *)
(* Modelled counterexamples (research/arch-a1-counterexample.md):          *)
(*   C2 waiver survives a negative review     -> NegativeWins              *)
(*   C3 silent downgrade of an obligation     -> BadVisible                *)
(*   C4 flaky check + retry                   -> FailIsDebt                *)
(*   C7 global debt freezes trunk             -> MergeUnderDebt (witness)  *)
(*   C8a guard evaluated before law changes   -> JudgedAdvance             *)
(*   W3 stale writer in shared worktree       -> OnlyHolderContent         *)
(* Assumptions: reviewers are accurate (bad -> block); a test on good     *)
(* content always passes; a test on bad content may pass or fail.         *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

CONSTANTS Nodes, Mode, MaxEpoch, MaxVersion

VARIABLES
  trunk,       \* set of merged nodes
  trunkSeq,    \* identity of the trunk pointer value (PRE)
  version,     \* law-set version; every law bumps it
  quality,     \* [Nodes -> {"none","good","bad"}]  hidden truth of current content
  author,      \* [Nodes -> {"none","holder","stale"}] who wrote current content
  epoch,       \* [Nodes -> Nat] writer-slot epoch
  writers,     \* [Nodes -> SUBSET Nat] live writer processes (by epoch)
  testObs,     \* [Nodes -> SUBSET {"pass","fail"}] observations on the test key
  reviewObs,   \* [Nodes -> {"none","ok","block"}]
  reviewReq,   \* [Nodes -> BOOLEAN] review obligation present in effective law
  downgraded,  \* [Nodes -> BOOLEAN] review obligation removed by a later law
  waived,      \* [Nodes -> {"none","parent","owner"}]
  gDebt,       \* a global state invariant exists and trunk does not satisfy it
  pending,     \* [Nodes -> Int] a1 only: trunkSeq at guard evaluation, -1 = none
  violation,   \* ghost: nodes merged while the guard was false at commit time
  debtMerges   \* ghost: merges performed while global debt was outstanding

vars == <<trunk, trunkSeq, version, quality, author, epoch, writers, testObs,
          reviewObs, reviewReq, downgraded, waived, gDebt, pending,
          violation, debtMerges>>

A2 == Mode \in {"a2", "a3"}
A3 == Mode = "a3"   \* a2 + negative observation also beats a downgrade (W2)

Init ==
  /\ trunk = {}
  /\ trunkSeq = 0
  /\ version = 0
  /\ quality = [n \in Nodes |-> "none"]
  /\ author = [n \in Nodes |-> "none"]
  /\ epoch = [n \in Nodes |-> 0]
  /\ writers = [n \in Nodes |-> {}]
  /\ testObs = [n \in Nodes |-> {}]
  /\ reviewObs = [n \in Nodes |-> "none"]
  /\ reviewReq = [n \in Nodes |-> TRUE]
  /\ downgraded = [n \in Nodes |-> FALSE]
  /\ waived = [n \in Nodes |-> "none"]
  /\ gDebt = FALSE
  /\ pending = [n \in Nodes |-> -1]
  /\ violation = {}
  /\ debtMerges = 0

(* ------------------------------ judgment ------------------------------ *)
\* a1: E = "has a passing observation".  a2: lattice join, any fail => not E.
TestE(n) == IF A2 THEN testObs[n] = {"pass"} ELSE "pass" \in testObs[n]

ReviewE(n) == reviewObs[n] = "ok"

\* a1: any waiver puts the obligation in W, forever.
\* a2: only an authorised waiver (owner; parent may not waive review) and
\*     only while no negative observation exists; a downgrade is W2.
ReviewW(n) ==
  IF A2 THEN \/ waived[n] = "owner" /\ reviewObs[n] # "block"
             \/ downgraded[n] /\ (A3 => reviewObs[n] # "block")
        ELSE waived[n] # "none"

\* a1: a removed obligation simply vanishes.  a2: it stays listed (as W2).
ReviewObligated(n) == IF A2 THEN reviewReq[n] \/ downgraded[n] ELSE reviewReq[n]

\* a2 (Guard/据/避): content delivered by a non-holder epoch is speech.
AuthorOK(n) == IF A2 THEN author[n] = "holder" ELSE TRUE

\* change judgment for merging n:  O ⊆ E ∪ W
NodeOK(n) ==
  /\ quality[n] # "none"
  /\ TestE(n)
  /\ AuthorOK(n)
  /\ ReviewObligated(n) => (ReviewE(n) \/ ReviewW(n))

\* trunk guard. a1: D(s') = ∅ (global debt blocks everything).
\*              a2: no new debt; global debt is inherited on both sides.
Guard(n) == NodeOK(n) /\ (A2 \/ ~gDebt)

\* what the receipt card shows as fully green (no ⚠, no ✘)
CardAllCheck(n) ==
  /\ TestE(n) /\ AuthorOK(n)
  /\ ReviewObligated(n) => ReviewE(n)

(* ------------------------------- actions ------------------------------ *)
Launch(n) ==
  /\ n \notin trunk /\ epoch[n] < MaxEpoch
  /\ epoch' = [epoch EXCEPT ![n] = @ + 1]
  /\ writers' = [writers EXCEPT ![n] = @ \cup {epoch[n] + 1}]
  /\ UNCHANGED <<trunk, trunkSeq, version, quality, author, testObs, reviewObs,
                 reviewReq, downgraded, waived, gDebt, pending, violation, debtMerges>>

\* a1: shared worktree, any live writer can change the content.
\* a2: one worktree per epoch; a stale writer's tree is never the node's content.
Write(n, e, q) ==
  /\ n \notin trunk /\ e \in writers[n]
  /\ A2 => e = epoch[n]
  /\ quality' = [quality EXCEPT ![n] = q]
  /\ author' = [author EXCEPT ![n] = IF e = epoch[n] THEN "holder" ELSE "stale"]
  /\ testObs' = [testObs EXCEPT ![n] = {}]
  /\ reviewObs' = [reviewObs EXCEPT ![n] = "none"]
  /\ pending' = [pending EXCEPT ![n] = -1]
  /\ UNCHANGED <<trunk, trunkSeq, version, epoch, writers, reviewReq, downgraded,
                 waived, gDebt, violation, debtMerges>>

Test(n) ==
  /\ quality[n] # "none"
  /\ \E r \in (IF quality[n] = "good" THEN {"pass"} ELSE {"pass", "fail"}) :
       testObs' = [testObs EXCEPT ![n] = @ \cup {r}]
  /\ UNCHANGED <<trunk, trunkSeq, version, quality, author, epoch, writers, reviewObs,
                 reviewReq, downgraded, waived, gDebt, pending, violation, debtMerges>>

\* review may happen before or after merge (post-merge review)
Review(n) ==
  /\ quality[n] # "none" /\ reviewObs[n] = "none"
  /\ reviewObs' = [reviewObs EXCEPT ![n] = IF quality[n] = "good" THEN "ok" ELSE "block"]
  /\ UNCHANGED <<trunk, trunkSeq, version, quality, author, epoch, writers, testObs,
                 reviewReq, downgraded, waived, gDebt, pending, violation, debtMerges>>

Waive(n, who) ==
  /\ waived[n] = "none" /\ version < MaxVersion
  /\ waived' = [waived EXCEPT ![n] = who]
  /\ version' = version + 1
  /\ UNCHANGED <<trunk, trunkSeq, quality, author, epoch, writers, testObs, reviewObs,
                 reviewReq, downgraded, gDebt, pending, violation, debtMerges>>

Downgrade(n) ==
  /\ reviewReq[n] /\ version < MaxVersion
  /\ reviewReq' = [reviewReq EXCEPT ![n] = FALSE]
  /\ downgraded' = [downgraded EXCEPT ![n] = TRUE]
  /\ version' = version + 1
  /\ UNCHANGED <<trunk, trunkSeq, quality, author, epoch, writers, testObs, reviewObs,
                 waived, gDebt, pending, violation, debtMerges>>

AddGlobalLaw ==
  /\ ~gDebt /\ version < MaxVersion
  /\ gDebt' = TRUE
  /\ version' = version + 1
  /\ UNCHANGED <<trunk, trunkSeq, quality, author, epoch, writers, testObs, reviewObs,
                 reviewReq, downgraded, waived, pending, violation, debtMerges>>

\* merging the fix leaf: a trunk move that discharges the global debt
FixGlobal ==
  /\ gDebt
  /\ gDebt' = FALSE
  /\ trunkSeq' = trunkSeq + 1
  /\ UNCHANGED <<trunk, version, quality, author, epoch, writers, testObs, reviewObs,
                 reviewReq, downgraded, waived, pending, violation, debtMerges>>

DoMerge(n) ==
  /\ trunk' = trunk \cup {n}
  /\ trunkSeq' = trunkSeq + 1
  /\ pending' = [pending EXCEPT ![n] = -1]
  /\ debtMerges' = IF gDebt THEN debtMerges + 1 ELSE debtMerges

\* a1: evaluate the guard, later CAS on the trunk pointer only.
Evaluate(n) ==
  /\ ~A2 /\ n \notin trunk /\ pending[n] = -1 /\ Guard(n)
  /\ pending' = [pending EXCEPT ![n] = trunkSeq]
  /\ UNCHANGED <<trunk, trunkSeq, version, quality, author, epoch, writers, testObs,
                 reviewObs, reviewReq, downgraded, waived, gDebt, violation, debtMerges>>

CommitA1(n) ==
  /\ ~A2 /\ n \notin trunk /\ pending[n] = trunkSeq
  /\ violation' = IF Guard(n) THEN violation ELSE violation \cup {n}
  /\ DoMerge(n)
  /\ UNCHANGED <<version, quality, author, epoch, writers, testObs, reviewObs,
                 reviewReq, downgraded, waived, gDebt>>

\* a2: guard evaluation and append are one step of the single-sequence log.
MergeA2(n) ==
  /\ A2 /\ n \notin trunk /\ Guard(n)
  /\ violation' = violation
  /\ DoMerge(n)
  /\ UNCHANGED <<version, quality, author, epoch, writers, testObs, reviewObs,
                 reviewReq, downgraded, waived, gDebt>>

Next ==
  \/ \E n \in Nodes :
       \/ Launch(n) \/ Test(n) \/ Review(n) \/ Downgrade(n)
       \/ Evaluate(n) \/ CommitA1(n) \/ MergeA2(n)
       \/ \E who \in {"parent", "owner"} : Waive(n, who)
       \/ \E e \in writers[n], q \in {"good", "bad"} : Write(n, e, q)
  \/ AddGlobalLaw
  \/ FixGlobal

Spec == Init /\ [][Next]_vars

(* ------------------------------ properties ---------------------------- *)
\* C8a: trunk never advances while the current judgment is false
JudgedAdvance == violation = {}

\* C2: a negative review on merged content is shown as debt, not as W
NegativeWins == \A n \in trunk : reviewObs[n] = "block" => ~NodeOK(n)

\* C4: a merged node whose test key has a failing observation is debt
FailIsDebt == \A n \in trunk : "fail" \in testObs[n] => ~NodeOK(n)

\* C3: bad content in trunk is never shown as all-green
BadVisible == \A n \in trunk : quality[n] = "bad" => ~CardAllCheck(n)

\* W3: merged content was written by the current slot holder
OnlyHolderContent == \A n \in trunk : author[n] = "holder"

\* Witnesses (expected to be VIOLATED where the behaviour is reachable):
\* C7: some merge can happen while global debt is outstanding (progress)
NoMergeUnderDebt == debtMerges = 0
\* non-vacuity: bad content can still enter trunk (visibly, via W)
NoBadMerged == \A n \in trunk : quality[n] # "bad"
\* non-vacuity: good content can be merged at all
NothingMerged == trunk = {}
=============================================================================
