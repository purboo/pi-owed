----------------------------- MODULE PiDagAuth3 -----------------------------
EXTENDS Integers, Sequences, FiniteSets, TLC
CONSTANTS Mode, Scope, MaxLog, Owner, P1, P2, W1, W2
ASSUME MaxLog >= 1
Principals == {Owner, P1, P2, W1, W2}
Scopes == {"n1", "n2"}
Author(n) == IF n = "n1" THEN W1 ELSE W2
Writers == {W1, W2}
Drop(c) == Mode = "a3-" \o c
Old == Mode = "a22"

\* Finite adversarial schedules: every permutation of each event alphabet,
\* not only the intended trace. Each event occurs once; no cross-family mixing.
\* Model values are asymmetric roles; swapping writer/parent roles is unsound,
\* so no nontrivial SYMMETRY is asserted. Liveness must not use symmetry.
E(ty, a, b, s, n, v) ==
  [type |-> ty, from |-> a, to |-> b, scope |-> s, node |-> n, value |-> v]
G(a,b,s) == E("grant",a,b,s,"n1",0)
D(ty,a,n) == E(ty,a,Owner,{n},n,0)
R(a,s) == E("revoke",Owner,a,{},"n1",s)
Law(a,v) == E("law",a,Owner,{"n1"},"n1",v)
Edit(ty) == E(ty,Owner,Owner,{},"n1",0)
Families == {"speech", "revival", "chain", "scope", "cross", "past",
             "self", "permission", "deferWriter", "author", "laws", "sameLaw",
             "keys", "state", "retro", "future", "good", "deferred"}
Events(f) == CASE
 f = "speech" -> {G(W1,W2,Scopes), G(Owner,W1,Scopes), D("waive",W2,"n1")}
 [] f = "revival" -> {G(Owner,P1,Scopes),G(P1,P2,Scopes),R(P1,"future"),
                        G(Owner,P1,{"n1"}),D("waive",P2,"n1")}
 [] f = "chain" -> {G(Owner,P1,Scopes),G(P1,P2,Scopes),G(P2,W1,Scopes),
                      R(P1,"retro"),D("waive",P2,"n2")}
 [] f = "scope" -> {G(Owner,P1,{"n1"}),G(P1,P2,Scopes),D("waive",P2,"n2")}
 [] f = "cross" -> {G(Owner,W1,Scopes),D("waive",W1,"n2")}
 [] f = "past" -> {G(Owner,W1,Scopes),Edit("release"),D("waive",W1,"n2")}
 [] f = "self" -> {G(Owner,W1,Scopes),D("downgrade",W1,"n1")}
 [] f = "permission" -> {G(Owner,P1,{"n1"}),D("downgrade",P1,"n2")}
 [] f = "deferWriter" -> {G(Owner,W1,Scopes),D("defer",W1,"n2")}
 [] f = "author" -> {D("waive",Owner,"n1")}
 [] f = "laws" -> {G(Owner,P1,Scopes),G(Owner,P2,Scopes),Law(P1,0),Law(P2,1)}
 [] f = "sameLaw" -> {G(Owner,P1,Scopes),Law(P1,0),Law(P1,1)}
 [] f = "keys" -> {D("waive",Owner,"n1"),Edit("unrelated"),Edit("closure"),Edit("related")}
 [] f = "state" -> {D("waive",Owner,"n1"),D("downgrade",Owner,"n1"),D("defer",Owner,"n1")}
 [] f = "retro" -> {G(Owner,P1,Scopes),G(P1,P2,Scopes),D("waive",P2,"n1"),R(P1,"retro")}
 [] f = "future" -> {G(Owner,P1,Scopes),G(P1,P2,Scopes),D("waive",P2,"n1"),R(P1,"future")}
 [] f = "good" -> {Edit("merge")}
 [] f = "deferred" -> {D("defer",Owner,"n1"),Edit("merge")}

VARIABLES family, log, pending, edges, accepted, invalid, key, content,
          slots, merged, lawView, conflict, resolver, lawWinner, lawValue, everSlots, authors
vars == <<family,log,pending,edges,accepted,invalid,key,content,slots,
          merged,lawView,conflict,resolver,lawWinner,lawValue,everSlots,authors>>
ScenarioInit == /\ family \in Families /\ log = <<>> /\ pending = Events(family)
        /\ everSlots=Writers /\ authors=[n \in Scopes |-> Author(n)]
        /\ edges = {} /\ accepted = {} /\ invalid = {} /\ key = 0 /\ content = 0
        /\ slots = Writers /\ merged = FALSE /\ lawView = [p \in {P1,P2} |-> -1]
        /\ conflict = FALSE /\ resolver = "none" /\ lawWinner="none" /\ lawValue=-1
Idx(t) == 1..(t-1)
\* Guard implementation: current edge graph, not historical Eff.
RECURSIVE Close(_,_,_,_)
Close(es,l,s,k) == IF k=0 THEN {Owner} ELSE
  LET prior == Close(es,l,s,k-1) IN
  prior \cup {l[i].to : i \in {j \in es : l[j].from \in prior /\ s \in l[j].scope}}
Rights(p,es,l) == {s \in Scopes : p \in Close(es,l,s,5)}
RECURSIVE Prune(_,_,_)
Prune(es,l,k) == IF k=0 THEN es ELSE
  LET next == {i \in es : l[i].scope \subseteq Rights(l[i].from,es,l)}
  IN Prune(next,l,k-1)

\* Independent oracle: reconstruct authority from raw assertions, with neither
\* edges, accepted, Prune nor Close. t denotes the prefix just before event t.
\* Full scope checked at issue; continuity is per granted scope. Revocation
\* removes all preceding incoming grants to its target; a regrant is a new edge.
RECURSIVE Eff(_,_,_)
Eff(p,t,k) == IF p=Owner THEN Scopes ELSE IF k=0 THEN {} ELSE
 UNION {log[i].scope : i \in {j \in Idx(t) :
   /\ log[j].type="grant" /\ log[j].to=p
   /\ log[j].scope \subseteq Eff(log[j].from,j,k-1)
   /\ \A u \in (j+1)..t : log[j].scope \subseteq Eff(log[j].from,u,k-1)
   /\ ~\E r \in (j+1)..(t-1) : log[r].type="revoke" /\ log[r].from=Owner /\ log[r].to=p}}
CatalogAuthor(n) == IF family="author" THEN Owner ELSE Author(n)
\* Independent genesis provenance: actual execution receipts, not the permission
\* catalog or the mutable slots cache. Neither receipt is erased on release.
GenesisExecution == <<[holder |-> W1, item |-> "n1"], [holder |-> W2, item |-> "n2"]>>
TrueWriter(p,t) == \E j \in DOMAIN GenesisExecution : GenesisExecution[j].holder=p
ActualAuthorship == IF family="author" THEN {<<Owner,"n1">>,<<W2,"n2">>}
                    ELSE {<<W1,"n1">>,<<W2,"n2">>}
Decision(e) == e.type \in {"waive","downgrade","defer"}
StateItem == family \in {"state","deferred"}
CanDecide(e) ==
 /\ IF (Old \/ Drop("permission")) /\ e.type="downgrade"
       THEN Rights(e.from,edges,log) # {} ELSE e.node \in Rights(e.from,edges,log)
 /\ ((Old /\ e.type="downgrade") \/ Drop("author") \/ e.from # CatalogAuthor(e.node))
 /\ IF Old \/ Drop("writers") THEN TRUE
       ELSE IF Drop("past") THEN e.from \notin slots ELSE e.from \notin Writers
 /\ (~StateItem \/ e.type="defer" \/ Old \/ Drop("state"))
Bound(i) == IF Old \/ Drop("key") THEN log[i].content=content ELSE log[i].key=key
Covers(i) == i \in accepted /\ i \notin invalid /\ Bound(i)
Waived == {i \in accepted : Covers(i) /\ log[i].type # "defer"}
Deferred == {i \in accepted : Covers(i) /\ log[i].type="defer"}
Debt == IF StateItem /\ Waived={} THEN {<<"I",key>>} ELSE {}
TrueCut(r,p,n) == n \in Eff(p,r,5) /\ n \notin Eff(p,r+1,5)

Step(e) ==
 LET i == Len(log)+1
     entry == [e EXCEPT !.value = @] @@ [key |-> key, content |-> content]
     l == Append(log,entry)
     canGrant == (Old \/ Drop("issue") \/ e.from=Owner \/ Rights(e.from,edges,log)#{})
                 /\ (Drop("scope") \/ e.scope \subseteq Rights(e.from,edges,log)
                       \/ ((Old \/ Drop("issue")) /\ Rights(e.from,edges,log)={}))
     raw == CASE e.type="grant" /\ canGrant -> edges \cup {i}
              [] e.type="revoke" -> {j \in edges : log[j].to # e.to}
              [] OTHER -> edges
     live == IF e.type="revoke" /\ ~Old /\ ~Drop("continuous")
             THEN Prune(raw,l,5) ELSE raw
     cut == {j \in accepted : log[j].node \in Rights(log[j].from,edges,log)
                     /\ log[j].node \notin Rights(log[j].from,live,l)}
     lv == IF e.type="law" /\ e.node \in Rights(e.from,edges,log)
           THEN [lawView EXCEPT ![e.from]=IF Drop("same") /\ @ # -1 THEN @ ELSE e.value] ELSE lawView
     clash == lv[P1] # -1 /\ lv[P2] # -1 /\ lv[P1] # lv[P2]
 IN /\ e \in pending /\ Len(log)<MaxLog
    /\ (e.type # "merge" \/ family="good" \/ Deferred # {})
    /\ log'=l /\ pending'=pending\{e} /\ edges'=live
    /\ accepted'=IF Decision(e) /\ CanDecide(e) THEN accepted\cup{i} ELSE accepted
    /\ invalid'=IF e.type="revoke" /\ (e.value="retro" \/ Drop("future")) /\ ~Drop("retro")
                 THEN invalid\cup cut ELSE invalid
    /\ key'=IF e.type \in {"related","closure"} THEN key+1 ELSE key
    /\ content'=IF e.type \in {"related","unrelated"} THEN content+1 ELSE content
    /\ slots'=IF e.type="release" THEN slots\{W1} ELSE slots
    /\ merged'=(merged \/ (e.type="merge" /\ (family="good" \/ Deferred # {})))
    /\ lawView'=lv
    /\ conflict'=(clash /\ ~Old /\ ~Drop("conflict"))
    /\ resolver'=IF clash /\ ~Old /\ ~Drop("conflict") THEN Owner ELSE "none"
    /\ lawWinner'=IF clash /\ ~Old /\ ~Drop("conflict") THEN "none"
                   ELSE IF lv # lawView THEN e.from ELSE lawWinner
    /\ lawValue'=IF clash /\ ~Old /\ ~Drop("conflict") THEN -1
                  ELSE IF lv # lawView THEN e.value ELSE lawValue
    /\ UNCHANGED <<family,everSlots,authors>>
ScenarioAdvance == \E e \in pending : Step(e)
Done == IF family="free" THEN Len(log)=MaxLog ELSE pending={}
Terminal == Done /\ UNCHANGED vars

\* Each safety oracle below uses raw history / objective role / real item key,
\* not CanDecide's formula. In particular Eff does not inspect guard state.
ScenarioAuthoritySound == \A p \in Principals : Rights(p,edges,log) \subseteq Eff(p,Len(log)+1,5)
ScenarioDecisionAuthority == \A i \in accepted : log[i].node \in Eff(log[i].from,i,5)
\* Historical initial slot ownership survives release, independently of slots.
ScenarioNoWriterJudge == \A i \in accepted : ~TrueWriter(log[i].from,i)
ScenarioNoAuthorJudge == \A i \in accepted : <<log[i].from,log[i].node>> \notin ActualAuthorship
\* Compare visible immunity to actual current item identity, not Bound.
ScenarioRelevantInvalidates == \A i \in Waived : log[i].key=key
\* Identical real items must retain an issued exemption despite unrelated bytes.
ScenarioUnrelatedPreserves == \A i \in accepted :
 (log[i].type="waive" /\ log[i].key=key /\ i \notin invalid) => i \in Waived
\* Ground-truth invariant is deliberately unproved in these families. It must
\* remain debt even after a deferral; this is an output partition assertion.
ScenarioStateRemainsDebt == StateItem => Debt={<<"I",key>>} /\ Waived={}
\* Reconstruct latest effective law per principal from raw assertions + Eff.
Laws(p) == {i \in 1..Len(log) : log[i].type="law" /\ log[i].from=p
                                      /\ "n1" \in Eff(p,i,5)}
Last(S) == CHOOSE x \in S : \A y \in S : x>=y
TrueConflict == Laws(P1)#{} /\ Laws(P2)#{} /\
               log[Last(Laws(P1))].value # log[Last(Laws(P2))].value
ScenarioConflictDebt == TrueConflict => conflict /\ resolver=Owner /\ lawWinner="none" /\ lawValue=-1
ScenarioSamePrincipalSupersedes == family="sameLaw" /\ Laws(P1)#{} =>
                          lawView[P1]=log[Last(Laws(P1))].value /\ ~conflict /\
                          lawWinner=P1 /\ lawValue=log[Last(Laws(P1))].value
\* Retro/future checked against independent historical cuts, not guard cut set.
ScenarioRetroHonored == \A i \in accepted : \A r \in (i+1)..Len(log) :
 (log[r].type="revoke" /\ log[r].value="retro" /\
  TrueCut(r,log[i].from,log[i].node)) => ~Covers(i)
ScenarioFuturePreserves == family="future" => \A i \in accepted : Covers(i)
NothingMerged == ~merged
NothingDeferredMerged == ~(family="deferred" /\ merged /\ Debt#{} /\ Deferred#{})
NothingParentWaived == ~\E i \in Waived : log[i].from \in {P1,P2}
NothingCrossWaived == ~\E i \in Waived : log[i].from=W1 /\ log[i].node="n2"
NothingSpeechWaived == ~(family="speech" /\ Len(log)=3 /\
 log[1].type="grant" /\ log[1].from=W1 /\ log[2].type="grant" /\
 log[2].from=Owner /\ 3 \in Waived)
NothingRevivedWaived == ~(family="revival" /\ Len(log)=5 /\
 log[1].type="grant" /\ log[2].type="grant" /\ log[3].type="revoke" /\
 log[4].type="grant" /\ log[5].type="waive" /\ "n1" \in Eff(P2,3,5) /\
 5 \in Waived /\ "n1" \notin Eff(P2,5,5))
GoodProgress == (family \in {"good","deferred"}) ~> merged
Finished == <>Done
\* Free exploration: the entire alphabet is available at EVERY step, including
\* repeated grants and regrants. Nothing is scheduled by a scenario template.
\* Attempts by unauthorized principals remain speech in the append-only log.
FreeEvents ==
 {G(a,b,s) : a \in Principals, b \in Principals\{Owner}, s \in (SUBSET Scopes)\{{}}}
 \cup {E("revoke",a,b,{},"n1",v) : a \in Principals, b \in Principals\{Owner}, v \in {"future","retro"}}
 \cup {D(ty,a,n) : ty \in {"waive","downgrade","defer"}, a \in Principals, n \in Scopes}
 \cup {E("law",a,Owner,{n},n,v) : a \in Principals, n \in Scopes, v \in {0,1}}
 \cup {E(ty,a,Owner,{},n,0) : ty \in {"unrelated","related","closure","acquire","release","merge"}, a \in Principals, n \in Scopes}
FreeInit == /\ family="free" /\ log = <<>> /\ pending={}
 /\ edges={} /\ accepted={} /\ invalid={}
 /\ key=[n \in Scopes |-> 0] /\ content=[n \in Scopes |-> 0]
 /\ slots=[n \in Scopes |-> Author(n)] /\ everSlots=Writers /\ merged=FALSE
 /\ authors=[n \in Scopes |-> Author(n)]
 /\ lawView=[n \in Scopes |-> [p \in Principals |-> -1]]
 /\ conflict={} /\ resolver=[n \in Scopes |-> "none"]
 /\ lawWinner=[n \in Scopes |-> "none"] /\ lawValue=[n \in Scopes |-> -1]
Rank(p) == IF p=Owner THEN 2 ELSE IF p \in {P1,P2} THEN 1 ELSE 0
FreeClash(lv,n) == \E p,q \in Principals : p#q /\ Rank(p)=Rank(q) /\
 lv[n][p]#-1 /\ lv[n][q]#-1 /\ lv[n][p]#lv[n][q]
FreeCanDecide(e) ==
 /\ IF (Old \/ Drop("permission")) /\ e.type="downgrade"
       THEN Rights(e.from,edges,log)#{} ELSE e.node \in Rights(e.from,edges,log)
 /\ ((Old /\ e.type="downgrade") \/ Drop("author") \/ e.from#authors[e.node])
 /\ (Old \/ Drop("writers") \/ e.from \notin everSlots)
 /\ (e.node#"n2" \/ e.type="defer" \/ Old \/ Drop("state"))
FreeBound(i) == IF Old \/ Drop("key") THEN log[i].content=content[log[i].node]
               ELSE log[i].key=key[log[i].node]
FreeCovers(i) == i \in accepted /\ i \notin invalid /\ FreeBound(i)
FreeWaived == {i \in accepted : FreeCovers(i) /\ log[i].type#"defer"}
FreeDeferred == {i \in accepted : FreeCovers(i) /\ log[i].type="defer"}
FreeDebt == IF \E i \in FreeWaived : log[i].node="n2" THEN {} ELSE {<<"I",key["n2"]>>}
FreeStep(e) ==
 LET i == Len(log)+1
     l == Append(log,e @@ [key |-> key[e.node],content |-> content[e.node]])
     revoke == e.type="revoke" /\ e.from=Owner
     grant == e.type="grant" /\
       (Old \/ Drop("issue") \/ Rights(e.from,edges,log)#{}) /\
       (Drop("scope") \/ e.scope \subseteq Rights(e.from,edges,log) \/
         ((Old \/ Drop("issue")) /\ Rights(e.from,edges,log)={}))
     raw == IF grant THEN edges\cup{i} ELSE IF revoke
            THEN {j \in edges : log[j].to#e.to} ELSE edges
     live == IF revoke /\ ~Old /\ ~Drop("continuous") THEN Prune(raw,l,5) ELSE raw
     cut == {j \in accepted : log[j].node \in Rights(log[j].from,edges,log) /\
                        log[j].node \notin Rights(log[j].from,live,l)}
     acquire == e.type="acquire" /\ e.from \notin {P1,P2} /\ slots[e.node]="none"
     release == e.type="release" /\ slots[e.node]=e.from
     law == e.type="law" /\ e.node \in Rights(e.from,edges,log)
     lv == IF law THEN [lawView EXCEPT ![e.node][e.from]=e.value] ELSE lawView
     clashes == IF Old \/ Drop("conflict") THEN {} ELSE {n \in Scopes : FreeClash(lv,n)}
     winners == IF law THEN [lawWinner EXCEPT ![e.node]=e.from] ELSE lawWinner
     values == IF law THEN [lawValue EXCEPT ![e.node]=e.value] ELSE lawValue
 IN /\ Len(log)<MaxLog
    /\ log'=l /\ edges'=live
    /\ accepted'=IF Decision(e) /\ FreeCanDecide(e) THEN accepted\cup{i} ELSE accepted
    /\ invalid'=IF revoke /\ e.value="retro" THEN invalid\cup cut ELSE invalid
    /\ key'=IF e.type \in {"related","closure"} THEN [key EXCEPT ![e.node]=@+1] ELSE key
    /\ content'=IF e.type \in {"related","unrelated"} THEN [content EXCEPT ![e.node]=@+1] ELSE content
    /\ slots'=IF acquire THEN [slots EXCEPT ![e.node]=e.from]
               ELSE IF release THEN [slots EXCEPT ![e.node]="none"] ELSE slots
    /\ everSlots'=IF acquire THEN everSlots\cup{e.from} ELSE everSlots
    /\ authors'=IF e.type="related" THEN [authors EXCEPT ![e.node]=e.from] ELSE authors
    /\ lawView'=lv /\ conflict'=clashes
    /\ resolver'=[n \in Scopes |-> IF n \in clashes THEN Owner ELSE "none"]
    /\ lawWinner'=[n \in Scopes |-> IF n \in clashes THEN "none" ELSE winners[n]]
    /\ lawValue'=[n \in Scopes |-> IF n \in clashes THEN -1 ELSE values[n]]
    /\ merged'=(merged \/ (e.type="merge" /\
              \E j \in (FreeWaived\cup FreeDeferred) : log[j].node=e.node))
    /\ UNCHANGED <<family,pending>>

\* Independent history observers for dynamically acquired/released writer slots.
\* SlotAt reconstructs actual execution ownership, not slots or everSlots.
RECURSIVE SlotAt(_,_)
SlotAt(n,t) == IF t=1 THEN Author(n) ELSE
 LET before == SlotAt(n,t-1) e == log[t-1] IN
 IF e.node#n THEN before ELSE
 IF e.type="acquire" /\ e.from \notin {P1,P2} /\ before="none" THEN e.from ELSE
 IF e.type="release" /\ e.from=before THEN "none" ELSE before
EverAt(p,t) == p \in {W1,W2} \/ \E i \in Idx(t) :
 log[i].type="acquire" /\ log[i].from=p /\ p \notin {P1,P2} /\ SlotAt(log[i].node,i)="none"
AuthorAt(n,t) == LET edits == {i \in Idx(t) : log[i].node=n /\ log[i].type="related"}
                IN IF edits={} THEN Author(n) ELSE log[Last(edits)].from
TrueKey(n,t) == Cardinality({i \in Idx(t) : log[i].node=n /\ log[i].type \in {"related","closure"}})
FCut(r,p,n) == log[r].type="revoke" /\ log[r].from=Owner /\
 n \in Eff(p,r,MaxLog+1) /\ n \notin Eff(p,r+1,MaxLog+1)
RetroCut(i) == \E r \in (i+1)..Len(log) : log[r].type="revoke" /\ log[r].value="retro" /\ FCut(r,log[i].from,log[i].node)
FLaws(n,p) == {i \in 1..Len(log) : log[i].type="law" /\ log[i].node=n /\
 log[i].from=p /\ n \in Eff(p,i,MaxLog+1)}
FTrueConflict(n) == \E p,q \in Principals : p#q /\ Rank(p)=Rank(q) /\
 FLaws(n,p)#{} /\ FLaws(n,q)#{} /\ log[Last(FLaws(n,p))].value#log[Last(FLaws(n,q))].value

\* Free safety properties independently compare outputs against raw history.
\* The dispatch preserves the parent-accepted scenario suite.
AuthoritySound == IF family#"free" THEN ScenarioAuthoritySound ELSE
 \A p \in Principals : Rights(p,edges,log) \subseteq Eff(p,Len(log)+1,MaxLog+1)
DecisionAuthority == IF family#"free" THEN ScenarioDecisionAuthority ELSE
 \A i \in accepted : log[i].node \in Eff(log[i].from,i,MaxLog+1)
NoWriterJudge == IF family#"free" THEN ScenarioNoWriterJudge ELSE
 \A i \in accepted : ~EverAt(log[i].from,i)
NoAuthorJudge == IF family#"free" THEN ScenarioNoAuthorJudge ELSE
 \A i \in accepted : log[i].from#AuthorAt(log[i].node,i)
RelevantInvalidates == IF family#"free" THEN ScenarioRelevantInvalidates ELSE
 \A i \in FreeWaived\cup FreeDeferred : log[i].key=TrueKey(log[i].node,Len(log)+1)
UnrelatedPreserves == IF family#"free" THEN ScenarioUnrelatedPreserves ELSE
 \A i \in accepted : (log[i].key=TrueKey(log[i].node,Len(log)+1) /\ ~RetroCut(i)) => FreeCovers(i)
StateRemainsDebt == IF family#"free" THEN ScenarioStateRemainsDebt ELSE
 FreeDebt={<<"I",TrueKey("n2",Len(log)+1)>>} /\ \A i \in FreeWaived : log[i].node#"n2"
ConflictDebt == IF family#"free" THEN ScenarioConflictDebt ELSE
 \A n \in Scopes : FTrueConflict(n) =>
 n \in conflict /\ resolver[n]=Owner /\ lawWinner[n]="none" /\ lawValue[n]=-1
SamePrincipalSupersedes == IF family#"free" THEN ScenarioSamePrincipalSupersedes ELSE
 \A n \in Scopes, p \in Principals : FLaws(n,p)#{} => lawView[n][p]=log[Last(FLaws(n,p))].value
RetroHonored == IF family#"free" THEN ScenarioRetroHonored ELSE
 \A i \in accepted : RetroCut(i) => ~FreeCovers(i)
FuturePreserves == IF family#"free" THEN ScenarioFuturePreserves ELSE
 \A i \in accepted :
 ((\E r \in (i+1)..Len(log) : log[r].type="revoke" /\ log[r].value="future" /\ FCut(r,log[i].from,log[i].node)) /\
 log[i].key=TrueKey(log[i].node,Len(log)+1) /\ ~RetroCut(i)) => FreeCovers(i)
AllSafety == AuthoritySound /\ DecisionAuthority /\ NoWriterJudge /\ NoAuthorJudge /\
 RelevantInvalidates /\ UnrelatedPreserves /\ StateRemainsDebt /\ ConflictDebt /\
 SamePrincipalSupersedes /\ RetroHonored /\ FuturePreserves
Init == IF Scope="free" THEN FreeInit ELSE ScenarioInit
\* Top-level disjunction/existential lets TLC sample each event as one action.
\* Equivalent reachable transitions to the IF family dispatch, without building
\* all 210 successors on every random simulation step.
Advance == (\E e \in FreeEvents : family="free" /\ FreeStep(e))
           \/ (family#"free" /\ ScenarioAdvance)
Next == Advance \/ Terminal
Spec == Init /\ [][Next]_vars /\ WF_vars(Advance)
=============================================================================
