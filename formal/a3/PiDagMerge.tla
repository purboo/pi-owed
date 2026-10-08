----------------------------- MODULE PiDagMerge -----------------------------
EXTENDS Naturals, FiniteSets, Sequences, TLC
CONSTANTS Mode, Scenario, O, K0, K1
\* Scripted scenarios: one node and two content keys. Free scenarios: two
\* nodes, independently changing truth, and histories of interleaved events.
\* No symmetry reduction: scripted K0/K1 roles and the free genesis audit's
\* canonical K0 anchor are distinguished. Keys/nodes remain model values.
\* Scenario selects the executable environment, never the desired answer.
\* Every observer is distinct from the writer. Scripted high reviewer is
\* accurate; free observers of either rank can be accurate or fallible.
\* Negative is a truthful diagnostic by an accurate observer (review rank 2,
\* exact diagnostic rank 1). Rank 1 also admits inaccurate observers; rank
\* is policy authority, not a theorem of equal diagnostic accuracy.
VARIABLES x, f
vars == <<x, f>>

A3 == Mode # "a22"
FreeScenario == Scenario \in {"free", "replayNegative", "replayDeferred"}
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
SEvent(op, key, result, rank, accurate) ==
 [op |-> op, n |-> K0, key |-> key,
  kind |-> IF DebtCase THEN "state" ELSE IF Scenario = "launderReview" THEN "judgment" ELSE "execution",
  result |-> result, rank |-> rank, accurate |-> accurate, truth |-> ~Bad]
ScriptInit == x = [phase |-> "genesis", obs |-> [k \in {K0,K1} |-> {}],
  genesis |-> FALSE, head |-> 0, snap |-> 0, sealed |-> FALSE,
  rank |-> 0, conflict |-> FALSE, accurateSeen |-> FALSE,
  original |-> {}, rerunDone |-> FALSE, key |-> K0,
  merged |-> FALSE, badMerged |-> FALSE, freshBlockMerged |-> FALSE,
  unobservedMerged |-> FALSE, waivedStateMerged |-> FALSE,
  truth |-> PreTruth, deferred |-> FALSE, waiver |-> FALSE,
  stateWaiver |-> FALSE, debtAfter |-> FALSE, lateBlock |-> FALSE,
  invalidated |-> FALSE, lease |-> FALSE, leaseUsed |-> FALSE,
  conflictMerge |-> FALSE, unrelated |-> FALSE, hist |-> <<>>]
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
    !.hist = Append(@, SEvent("observe", K0, "fail", IF Scenario = "launderReview" THEN 2 ELSE 1, TRUE)),
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
\* Revised K2: only judgment blocks admit rank-based withdrawal. Execution
\* blocks require original-key reproduction followed by current-key evidence.
Observe(r) == /\ x.phase = "observe" /\ r \in Results
 /\ x' = [x EXCEPT !.phase = "decide",
    !.obs[ObsKey(x.key)] = @ \cup (IF r = "unknown" THEN {} ELSE {r}),
    !.hist = Append(@, SEvent("observe", x.key, r, 1, FALSE)),
    !.sealed = IF Clause("K2") /\ r = "pass" /\ x.rank <= 1
                      /\ Scenario = "launderReview" THEN FALSE ELSE @,
    !.head = @ + 1]
\* An accurate high-rank reviewer exists, including on good content. The
\* environment may finish with low observations; availability is not necessity.
HighObserve == /\ x.phase = "decide" /\ Scenario \in {"launderReview","good","falsePass"}
 /\ "high" \notin x.original
 /\ x' = [x EXCEPT !.original = @ \cup {"high"},
    !.hist = Append(@, SEvent("observe", x.key, IF Bad THEN "fail" ELSE "pass", 2, TRUE)),
    !.obs[ObsKey(x.key)] = @ \cup {IF Bad THEN "fail" ELSE "pass"},
    !.sealed = Bad, !.rank = 2, !.accurateSeen = @ \/ Bad,
    !.head = @ + 1]
\* Original-key rerun is a real observation, not a current-key pass.
\* Here the old key is deterministic bad; pass branch additionally exercises
\* attribution of a flaky original (permitted for launderTest).
Rerun(r) == /\ x.phase \in {"observe","decide"} /\ Scenario \in {"launderTest","rerun"} /\ ~x.rerunDone
 /\ r \in (IF Scenario = "launderTest" THEN {"pass","fail"} ELSE {"fail"})
 /\ x' = [x EXCEPT !.rerunDone = TRUE, !.sealed = FALSE,
    !.phase = IF Clause("K2") /\ r = "fail" THEN "observe" ELSE @,
    !.hist = Append(@, SEvent("rerun", K0, r, 1, FALSE)),
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
    !.hist = Append(@, SEvent("observe", x.key, "fail", 2, TRUE)),
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
    !.hist = Append(@, SEvent("observe", CK, IF Bad THEN "fail" ELSE "pass", 2, TRUE)),
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
ScriptNext == Genesis \/ SkipGenesis \/ Terminal
 \/ (IF Scenario = "live" THEN LiveNext ELSE SafetyNext)
ScriptFair == WF_x(Genesis) /\ WF_x(LiveStart) /\ WF_x(Acquire)
 /\ WF_x(Prepare) /\ WF_x(Validate) /\ WF_x(LiveCommit)
 /\ WF_x(Rebase) /\ WF_x(Expire)

\* Free environment: two symmetric model-value nodes, two edits each, eight
\* optional environment events. Admission, eval/commit, leases and cancellation
\* interleave freely. Cancellation is an explicit final owner decision, never
\* an implicit stutter at the exploration bound. Free checks are safety checks.
FNodes == {K0,K1}
FLimit == 8
FKey(n) == <<n, f.ver[n]>>
FObsVer(n) == IF Clause("K1") \/ ~A3 THEN f.ver[n] ELSE 0
FEvent(op,n,key,result,rank,accurate,truth) ==
 [op |-> op, n |-> n, key |-> key, kind |-> f.kind[n],
  result |-> result, rank |-> rank, accurate |-> accurate, truth |-> truth]
FInit == \E base \in [FNodes -> BOOLEAN], kinds \in [FNodes -> {"judgment","execution"}] :
 f = [kind |-> kinds, ver |-> [n \in FNodes |-> 0],
  truth |-> [n \in FNodes |-> [v \in 0..2 |-> IF v = 0 THEN base[n] ELSE TRUE]],
  obs |-> [n \in FNodes |-> [v \in 0..2 |-> {}]],
  nodeObs |-> [n \in FNodes |-> [v \in 0..2 |-> {}]],
  trunk |-> [n \in FNodes |-> 0], epoch |-> 0, genesis |-> FALSE,
  hist |-> <<>>, inputs |-> 0, blocks |-> {}, reproduced |-> {}, conflict |-> {},
  waivers |-> {}, deferrals |-> {}, stateW |-> {}, queue |-> <<>>, lease |-> "none",
  done |-> {}, eval |-> [n \in FNodes |-> [valid |-> FALSE, epoch |-> 0, ver |-> 0, at |-> 0]],
  receipts |-> <<>>]
FGenesis == /\ ~f.genesis
 /\ f' = [f EXCEPT !.genesis = TRUE,
   !.obs = [n \in FNodes |-> [v \in 0..2 |-> IF v = 0
      THEN @[n][v] \cup {IF f.truth[n][0] THEN "pass" ELSE "fail"} ELSE @[n][v]]],
   !.hist = Append(@, FEvent("genesis",K0,<<K0,0>>,"none",2,TRUE,TRUE))]
FEdit(n,b) == /\ n \notin f.done /\ f.ver[n] < 2 /\ f.inputs < FLimit
 /\ f' = [f EXCEPT !.ver[n] = @ + 1, !.truth[n][f.ver[n]+1] = b,
   !.inputs = @ + 1, !.eval[n].valid = FALSE,
   !.hist = Append(@, FEvent("edit",n,<<n,f.ver[n]+1>>,"none",0,FALSE,b))]
\* Operational seal state is maintained incrementally. Properties below replay
\* the separate immutable event history instead of reading these sets.
FObserve(n,r,rank,accurate) == /\ n \notin f.done /\ f.inputs < FLimit
 /\ (~accurate \/ (r = "pass") = f.truth[n][f.ver[n]])
 /\ f' = [f EXCEPT !.inputs = @ + 1,
   !.nodeObs[n][FObsVer(n)] = @ \cup {r},
   !.hist = Append(@, FEvent("observe",n,FKey(n),r,rank,accurate,f.truth[n][f.ver[n]])),
   !.blocks = IF r = "fail" THEN @ \cup {Len(f.hist)+1}
    ELSE {i \in @ : f.hist[i].n # n \/
      (IF f.kind[n] = "judgment" THEN f.hist[i].rank > rank
       ELSE i \notin f.reproduced)}]
\* State observations and node acceptance evidence have disjoint stores.
FStateObserve(n,r,accurate) == /\ n \notin f.done /\ f.inputs < FLimit
 /\ (~accurate \/ (r = "pass") = f.truth[n][f.ver[n]])
 /\ f' = [f EXCEPT !.inputs = @+1, !.obs[n][FObsVer(n)] = @ \cup {r},
   !.hist = Append(@,[FEvent("observe",n,FKey(n),r,1,accurate,f.truth[n][f.ver[n]])
                      EXCEPT !.kind = "state"])]
FRerun(i,r) == /\ i \in f.blocks /\ f.hist[i].kind = "execution"
 /\ f.hist[i].n \notin f.done /\ f.inputs < FLimit
 /\ f' = [f EXCEPT !.inputs = @ + 1,
   !.hist = Append(@, FEvent("rerun",f.hist[i].n,f.hist[i].key,r,1,FALSE,
                              f.truth[f.hist[i].n][f.hist[i].key[2]])),
   !.reproduced = IF r = "fail" THEN @ \cup {j \in f.blocks :
                        f.hist[j].n = f.hist[i].n /\ f.hist[j].key = f.hist[i].key} ELSE @,
   !.conflict = IF r = "pass" THEN @ \cup {f.hist[i].n} ELSE @]
FWaive(n) == /\ n \notin f.done /\ f.inputs < FLimit /\ FKey(n) \notin f.waivers
 /\ f' = [f EXCEPT !.waivers = @ \cup {FKey(n)}, !.inputs = @+1,
   !.hist = Append(@,FEvent("waiver",n,FKey(n),"none",3,TRUE,f.truth[n][f.ver[n]]))]
FDefer(n) == /\ n \notin f.done /\ f.inputs < FLimit /\ FKey(n) \notin f.deferrals
 /\ (~A3 \/ f.ver[n] # f.trunk[n])
 /\ f' = [f EXCEPT !.deferrals = @ \cup {FKey(n)}, !.inputs = @+1,
   !.hist = Append(@,FEvent("defer",n,FKey(n),"none",3,TRUE,f.truth[n][f.ver[n]]))]
FStateWaive(n) == /\ ~Clause("K3state") /\ n \notin f.done
 /\ f.inputs < FLimit /\ FKey(n) \notin f.stateW
 /\ f' = [f EXCEPT !.stateW = @ \cup {FKey(n)}, !.inputs = @+1,
   !.hist = Append(@,FEvent("stateWaiver",n,FKey(n),"none",3,TRUE,f.truth[n][f.ver[n]]))]
FInQueue(n) == \E i \in 1..Len(f.queue) : f.queue[i] = n
FEnqueue(n) == /\ n \notin f.done /\ ~FInQueue(n)
 /\ f' = [f EXCEPT !.queue = Append(@,n)]
FDrop(q,n) == IF Len(q) = 0 THEN q ELSE IF Len(q) = 1
 THEN IF q[1] = n THEN <<>> ELSE q
 ELSE IF q[1] = n THEN <<q[2]>> ELSE IF q[2] = n THEN <<q[1]>> ELSE q
FLease(n) == /\ Len(f.queue) > 0 /\ f.queue[1] = n /\ f.lease = "none"
 /\ f' = [f EXCEPT !.lease = n]
FExpire == /\ f.lease # "none" /\ f' = [f EXCEPT !.lease = "none"]
FDebt(n,v) == IF f.obs[n][v] = {"pass"} \/ <<n,v>> \in f.stateW THEN {}
 ELSE {IF Clause("K3") THEN <<n,v>> ELSE n}
FGuard(n) == /\ (~Clause("K4") \/ f.genesis)
 /\ (~A3 \/ FKey(n) \in f.waivers \/ f.nodeObs[n][FObsVer(n)] = {"pass"})
 /\ (FKey(n) \in f.waivers \/ ~Clause("K2") \/
      ((\A i \in f.blocks : f.hist[i].n # n) /\ n \notin f.conflict))
 /\ (FKey(n) \in f.deferrals \/ FDebt(n,FObsVer(n)) \subseteq FDebt(n,f.trunk[n]))
FEval(n) == /\ n \notin f.done /\ FInQueue(n) /\ FGuard(n)
 /\ f.eval[n] # [valid |-> TRUE, epoch |-> f.epoch, ver |-> f.ver[n], at |-> Len(f.hist)]
 /\ f' = [f EXCEPT !.eval[n] =
             [valid |-> TRUE, epoch |-> f.epoch, ver |-> f.ver[n], at |-> Len(f.hist)]]
FCommit(n) == /\ n \notin f.done /\ FInQueue(n) /\ f.eval[n].valid
 /\ f.eval[n].epoch = f.epoch /\ f.eval[n].ver = f.ver[n]
 /\ (~Clause("K5queue") \/ f.queue[1] = n)
 /\ (~Clause("K5atomic") \/ FGuard(n))
 /\ f' = [f EXCEPT !.done = @ \cup {n}, !.trunk[n] = f.ver[n], !.epoch = @+1,
   !.queue = FDrop(@,n), !.lease = IF @ = n THEN "none" ELSE @,
   !.receipts = Append(@,[n |-> n, key |-> FKey(n), truth |-> f.truth[n][f.ver[n]],
      prekey |-> <<n,f.trunk[n]>>, pretruth |-> f.truth[n][f.trunk[n]],
      at |-> Len(f.hist), evalAt |-> f.eval[n].at,
      waived |-> FKey(n) \in f.waivers, deferred |-> FKey(n) \in f.deferrals,
      stateW |-> FKey(n) \in f.stateW,
      debt |-> f.obs[n][FObsVer(n)] # {"pass"} /\ FKey(n) \notin f.stateW,
      nodeDebt |-> f.nodeObs[n][FObsVer(n)] # {"pass"} /\ FKey(n) \notin f.waivers,
      lease |-> f.lease]),
   !.hist = Append(@,FEvent("commit",n,FKey(n),"none",0,FALSE,f.truth[n][f.ver[n]]))]
\* Explicit cancellation completes a candidate, including exhausted finite
\* experiments. It is not fairness-enforced and cannot remove prior receipts.
FCancel(n) == /\ n \notin f.done /\ f.inputs = FLimit
 /\ f' = [f EXCEPT !.done = @ \cup {n}, !.queue = FDrop(@,n),
    !.lease = IF @ = n THEN "none" ELSE @]
FFinished == /\ f.done = FNodes /\ UNCHANGED f
FreeNext == FGenesis \/ FExpire \/ FFinished
 \/ (\E n \in FNodes : FEnqueue(n) \/ FLease(n) \/ FEval(n) \/ FCommit(n)
       \/ FCancel(n) \/ FWaive(n) \/ FDefer(n) \/ FStateWaive(n)
       \/ (\E b \in BOOLEAN : FEdit(n,b))
       \/ (\E r \in {"pass","fail"}, accurate \in BOOLEAN : FStateObserve(n,r,accurate))
       \/ (\E r \in {"pass","fail"}, rank \in {1,2}, accurate \in BOOLEAN : FObserve(n,r,rank,accurate)))
 \/ (\E i \in f.blocks, r \in {"pass","fail"} : FRerun(i,r))
\* Minimized regressions schedule the SAME free actions; they do not change
\* any admission rule. General free exploration remains entirely unscripted.
ReplayInitial == IF Scenario = "replayNegative"
 THEN f.kind[K0] = "judgment" /\ ~f.truth[K0][0]
 ELSE IF Scenario = "replayDeferred" THEN f.truth[K0][0] ELSE TRUE
ReplayNext == CASE Len(f.hist) = 0 -> FGenesis
 [] Scenario = "replayNegative" /\ Len(f.hist) = 1 -> FObserve(K0,"fail",1,TRUE)
 [] Scenario = "replayNegative" /\ Len(f.hist) = 2 -> FObserve(K0,"pass",1,FALSE)
 [] Scenario = "replayNegative" /\ Len(f.hist) = 3 -> FEdit(K0,FALSE)
 [] Scenario = "replayNegative" /\ Len(f.hist) = 4 -> FDefer(K0)
 [] Scenario = "replayDeferred" /\ Len(f.hist) = 1 -> FEdit(K0,FALSE)
 [] Scenario = "replayDeferred" /\ Len(f.hist) = 2 -> FDefer(K0)
 [] Scenario = "replayDeferred" /\ Len(f.hist) = 3 -> FObserve(K0,"pass",1,FALSE)
 [] OTHER -> FreeNext
Init == IF FreeScenario THEN FInit /\ ReplayInitial /\ x = [unused |-> TRUE]
        ELSE ScriptInit /\ f = [unused |-> TRUE]
Next == IF FreeScenario THEN
          (IF Scenario = "free" THEN FreeNext ELSE ReplayNext) /\ UNCHANGED x
        ELSE ScriptNext /\ UNCHANGED f
Spec == Init /\ [][Next]_vars /\ (IF FreeScenario THEN TRUE ELSE ScriptFair)

\* Independent reference predicates use historical observations, immutable
\* truth and actual commit receipts, never operational blocks or FGuard.
HPositive(h,i,j,key) == /\ j > i /\ h[j].op = "observe" /\ h[j].result = "pass"
 /\ h[j].n = h[i].n /\ h[j].key = key
 /\ (IF h[i].kind = "judgment" THEN h[j].rank >= h[i].rank
     ELSE \E r \in (i+1)..(j-1) : h[r].op = "rerun" /\ h[r].n = h[i].n
          /\ h[r].key = h[i].key /\ h[r].result = "fail")
\* A withdrawal is reconstructed from the prefix at the time it happened,
\* not from today's candidate key or the operational active-block set.
HWithdrawn(h,i) ==
 IF h[i].kind = "judgment" THEN
   \E j \in (i+1)..Len(h) : h[j].op = "observe" /\ h[j].kind = "judgment"
      /\ h[j].n = h[i].n /\ h[j].result = "pass" /\ h[j].rank >= h[i].rank
 ELSE \E j \in (i+1)..Len(h) : h[j].op = "rerun" /\ h[j].n = h[i].n
      /\ h[j].key = h[i].key /\ h[j].result = "fail"
HNoBypass(h,n,key,bad,waived) == (~bad \/ waived) \/
 (\A i \in 1..Len(h) :
   (h[i].op = "observe" /\ h[i].n = n /\ h[i].kind # "state"
     /\ h[i].result = "fail" /\ h[i].accurate) => HWithdrawn(h,i))
HAffirm(h,n,key,state) == \E j \in 1..Len(h) : h[j].op = "observe" /\ h[j].n = n
 /\ h[j].key = key /\ h[j].result = "pass" /\ ((h[j].kind = "state") = state)
HFalseAffirm(h,n,key,state) == \E j \in 1..Len(h) : h[j].op = "observe" /\ h[j].n = n
 /\ h[j].key = key /\ h[j].result = "pass" /\ ~h[j].truth
 /\ ((h[j].kind = "state") = state)
HBlame(h,n,key) == \E j \in 1..Len(h) : h[j].op = "observe" /\ h[j].n = n
 /\ h[j].key = key /\ h[j].result = "pass" /\ ~h[j].truth
FReceipts == {f.receipts[i] : i \in 1..Len(f.receipts)}
Prefix(c) == SubSeq(f.hist,1,c.at)
FreeNoLaundering == \A c \in FReceipts : c.truth \/ c.waived \/
 ~\E i \in 1..c.at : f.hist[i].op = "observe" /\ f.hist[i].n = c.n
                       /\ f.hist[i].result = "fail" /\ f.hist[i].accurate
FreeNoFlakyRerunEscape == \A c \in FReceipts : c.waived \/
 ~\E i \in 1..c.at : f.hist[i].op = "rerun" /\ f.hist[i].n = c.n /\ f.hist[i].result = "pass"
FreeNoNewBreakage == \A c \in FReceipts : (c.pretruth /\ ~c.truth) => c.deferred
FreeJudgedAtCommit == \A c \in FReceipts : c.waived \/
 (\A i \in (c.evalAt+1)..c.at :
    (f.hist[i].op = "observe" /\ f.hist[i].n = c.n /\ f.hist[i].kind # "state"
      /\ f.hist[i].result = "fail")
    => (\E j \in 1..c.at : HPositive(Prefix(c),i,j,c.key)))
FreeGenesisBeforeAdvance == \A c \in FReceipts :
 \E i \in 1..c.at : f.hist[i].op = "genesis"
FreeStateNeverWaived == \A c \in FReceipts : ~c.stateW
FreeDeferredDebtVisible == \A c \in FReceipts :
 (c.deferred /\ ~c.debt) => HAffirm(Prefix(c),c.n,c.key,TRUE)
FreeLeaseExcludes == \A c \in FReceipts : c.lease \in {"none",c.n}
\* Parent ruling: only negatives still active in independently replayed
\* history constrain admission; a legitimate historical withdrawal persists.
NoBypassedNegative == IF FreeScenario THEN
 \A c \in FReceipts : HNoBypass(Prefix(c),c.n,c.key,~c.truth,c.waived)
 ELSE ~x.merged \/ HNoBypass(x.hist,K0,x.key,Bad,x.waiver)
\* Escape means hidden bad truth displayed in E/W, not still-visible debt.
\* Audit both the state item and the independently evidenced node obligation.
EscapeAttributable == IF FreeScenario THEN
 \A c \in FReceipts : c.truth \/
  ((c.debt \/ c.stateW \/ c.deferred \/ HFalseAffirm(Prefix(c),c.n,c.key,TRUE))
   /\ (c.nodeDebt \/ c.waived \/ HFalseAffirm(Prefix(c),c.n,c.key,FALSE)))
 ELSE ~x.merged \/ ~Bad \/ (x.debtAfter /\ ~x.stateWaiver /\ ~x.waiver)
      \/ x.waiver \/ x.stateWaiver \/ x.deferred \/ HBlame(x.hist,K0,x.key)
\* Actual acceptance must have its own affirmative history or owner waiver;
\* a state deferral cannot supply either fact. This does not inspect FGuard.
NodeAcceptanceCovered == IF FreeScenario THEN
 \A c \in FReceipts : c.waived \/ HAffirm(Prefix(c),c.n,c.key,FALSE)
 ELSE TRUE
\* Separate, explicitly weaker interpretation of 'escape': a changed item.
NewEscapeAttributable == IF FreeScenario THEN
 \A c \in FReceipts : c.key = c.prekey \/ c.truth \/ c.waived \/ c.deferred \/ HBlame(Prefix(c),c.n,c.key)
 ELSE ~Changed \/ EscapeAttributable

\* Truth/history properties: none invokes Guard, NodeOK or evidence admission.
\* Independent historical fact: accurate failure + still bad + no owner waiver.
NoLaundering == IF FreeScenario THEN FreeNoLaundering ELSE ~x.badMerged
\* A rerun history containing both outcomes never constitutes acceptance
\* without explicit owner risk acceptance; reads history, not seal/Guard.
NoFlakyRerunEscape == IF FreeScenario THEN FreeNoFlakyRerunEscape
 ELSE ~(x.merged /\ x.rerunDone /\ "pass" \in x.original /\ ~x.waiver)
\* Hidden state predicate at PRE and actual commit, not observed D inclusion.
NoNewBreakage == [][IF FreeScenario THEN FreeNoNewBreakage'
 ELSE ((x'.merged /\ ~x.merged /\ x.truth /\ ~x'.truth) => x.deferred)]_vars
\* Audit fact: a new BLOCK really arrived after evaluation, before commit.
JudgedAtCommit == IF FreeScenario THEN FreeJudgedAtCommit ELSE ~x.freshBlockMerged
\* Event history, independent from evidence values or the merge guard.
GenesisBeforeAdvance == IF FreeScenario THEN FreeGenesisBeforeAdvance ELSE ~x.unobservedMerged
\* Actual recorded disposition: a state invariant was exempted at acceptance.
StateNeverWaived == IF FreeScenario THEN FreeStateNeverWaived ELSE ~x.waivedStateMerged
\* Leaving debt requires a positive event on this state item, not true quality.
DeferredDebtVisible == IF FreeScenario THEN FreeDeferredDebtVisible
 ELSE (x.merged /\ x.deferred /\ ~x.debtAfter) => HAffirm(x.hist,K0,x.key,TRUE)
\* History records whether a rival actually advanced while lease was held.
LeaseExcludes == IF FreeScenario THEN FreeLeaseExcludes ELSE ~x.conflictMerge
\* Non-vacuity witnesses intentionally violated by a successful merge.
NothingMerged == IF FreeScenario THEN Len(f.receipts) = 0 ELSE ~x.merged
NoDeferredMerge == IF FreeScenario THEN \A c \in FReceipts : ~c.deferred
 ELSE ~(x.merged /\ x.deferred)
NoOwnerWaivedMerge == IF FreeScenario THEN \A c \in FReceipts : ~c.waived
 ELSE ~(x.merged /\ x.waiver)
NoUnrelatedMerge == ~(x.merged /\ x.unrelated)
NoOldDebtMerge == ~(x.merged /\ ~PreTruth)
GoodEventuallyMerges == <>x.merged
\* A conjunction is checked as one property to sample the SAME free traces
\* against every conjunct. A failure is reported by its independent predicate.
FreeCoreSafety == NoFlakyRerunEscape /\ JudgedAtCommit /\ GenesisBeforeAdvance
 /\ StateNeverWaived /\ LeaseExcludes /\ EscapeAttributable
 /\ NoBypassedNegative /\ DeferredDebtVisible /\ NodeAcceptanceCovered
FreeNoTwoMerges == Len(f.receipts) < 2
=============================================================================
