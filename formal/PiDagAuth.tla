----------------------------- MODULE PiDagAuth -----------------------------
(***************************************************************************)
(* 权: delegation, revocation and waivers on a single-sequence log.        *)
(* Mode "lit": ARCHITECTURE a2.1 read literally -                          *)
(*   an assertion at t is effective iff its author had authority on        *)
(*   L[0..t); a grant is checked when it is made; a revocation's scope      *)
(*   reaches derived content and observations (not laws); a waiver names   *)
(*   an obligation, not a content version.                                 *)
(* Mode "fix": candidate repair -                                          *)
(*   authority at t = reachable from owner in the grant graph that is live *)
(*   at t (revoking a grantor cuts every sub-delegate); a waiver binds the *)
(*   content version it was issued for; a "retro" revocation also voids    *)
(*   waivers issued by the principals it cut.                              *)
(* Reach(t) below is the reference meaning of "has authority at t"; in fix *)
(* mode it is also the rule, so AuthAtIssue is a check on lit only.        *)
(* Revocation is by owner only, removing every live grant to the target.   *)
(* An owner pin ("this review may not be waived") beats lower authority;   *)
(* between owner assertions the later one wins.                            *)
(***************************************************************************)
EXTENDS Integers, Sequences, FiniteSets

CONSTANTS Mode, MaxLog, MaxVer

FIX == Mode = "fix"
Principals == {"owner", "parent", "w1", "w2"}
Nodes == {"n1", "n2"}
Writer(n) == IF n = "n1" THEN "w1" ELSE "w2"

VARIABLES log, ver
vars == <<log, ver>>

Init == log = <<>> /\ ver = [n \in Nodes |-> 0]

Mk(ty, f, t, s, n, v) == [type |-> ty, from |-> f, to |-> t, scope |-> s, node |-> n, v |-> v]
Add(e) == Len(log) < MaxLog /\ log' = Append(log, e) /\ UNCHANGED ver

Grant(a, b)    == a # b /\ b # "owner" /\ Add(Mk("grant", a, b, "-", "-", 0))
Revoke(b, s)   == b # "owner" /\ Add(Mk("revoke", "owner", b, s, "-", 0))
Waive(a, n)    == Add(Mk("waive", a, "-", "-", n, ver[n]))
Pin(n)         == Add(Mk("pin", "owner", "-", "-", n, 0))
Write(n)       == ver[n] < MaxVer /\ ver' = [ver EXCEPT ![n] = @ + 1] /\ UNCHANGED log

Next ==
  \/ \E a \in Principals, b \in Principals : Grant(a, b)
  \/ \E b \in Principals, s \in {"future", "retro"} : Revoke(b, s)
  \/ \E a \in Principals, n \in Nodes : Waive(a, n)
  \/ \E n \in Nodes : Pin(n) \/ Write(n)

Spec == Init /\ [][Next]_vars

Now == Len(log) + 1
Idx(lo, hi) == {i \in lo..hi : i >= 1 /\ i <= Len(log)}

RevokesGrant(j, i) == log[j].type = "revoke" /\ log[j].to = log[i].to
LiveEdges(t) == {i \in Idx(1, t - 1) :
                   /\ log[i].type = "grant"
                   /\ ~\E j \in Idx(i + 1, t - 1) : RevokesGrant(j, i)}

RECURSIVE Close(_, _, _)
Close(S, t, k) ==
  IF k = 0 THEN S
  ELSE Close(S \cup {log[i].to : i \in {e \in LiveEdges(t) : log[e].from \in S}}, t, k - 1)

\* reference: authority just before position t
Reach(t) == Close({"owner"}, t, Cardinality(Principals))

\* literal: grant checked when made, then only a direct revocation removes it
RECURSIVE HAuth(_, _)
HAuth(p, t) ==
  \/ p = "owner"
  \/ \E i \in Idx(1, t - 1) :
       /\ log[i].type = "grant" /\ log[i].to = p
       /\ HAuth(log[i].from, i)
       /\ ~\E j \in Idx(i + 1, t - 1) : RevokesGrant(j, i)

AuthAt(p, t) == IF FIX THEN p \in Reach(t) ELSE HAuth(p, t)

\* revocation j cut principal p
Cut(j, p) == log[j].type = "revoke" /\ p \in Reach(j) /\ p \notin Reach(j + 1)

WaiverEff(i, n) ==
  /\ log[i].type = "waive" /\ log[i].node = n
  /\ log[i].from # Writer(n)                                  \* 避
  /\ AuthAt(log[i].from, i)                                   \* 权
  /\ FIX => log[i].v = ver[n]                                 \* bind content
  /\ FIX => ~\E j \in Idx(i + 1, Len(log)) :
                log[j].scope = "retro" /\ Cut(j, log[i].from)

Beaten(i, n) == \E j \in Idx(1, Len(log)) :
                  /\ log[j].type = "pin" /\ log[j].node = n
                  /\ (log[i].from # "owner" \/ j > i)

Covering(i, n) == WaiverEff(i, n) /\ ~Beaten(i, n)
Waived(n) == \E i \in Idx(1, Len(log)) : Covering(i, n)

(* properties *)
AuthAtIssue   == \A n \in Nodes, i \in Idx(1, Len(log)) :
                   Covering(i, n) => log[i].from \in Reach(i)
BoundToContent == \A n \in Nodes, i \in Idx(1, Len(log)) :
                   Covering(i, n) => log[i].v = ver[n]
RetroHonored  == \A n \in Nodes, i \in Idx(1, Len(log)) :
                   Covering(i, n) =>
                     ~\E j \in Idx(i + 1, Len(log)) : log[j].scope = "retro" /\ Cut(j, log[i].from)
NoSelfWaive   == \A n \in Nodes, i \in Idx(1, Len(log)) :
                   Covering(i, n) => log[i].from # Writer(n)
PinWins       == \A n \in Nodes, i \in Idx(1, Len(log)) :
                   Covering(i, n) /\ log[i].from # "owner" =>
                     ~\E j \in Idx(1, Len(log)) : log[j].type = "pin" /\ log[j].node = n
\* witnesses, expected VIOLATED
NoAgentWaiver == \A n \in Nodes, i \in Idx(1, Len(log)) :
                   Covering(i, n) => log[i].from \in {"owner", "parent"}
NothingWaived == \A n \in Nodes : ~Waived(n)
=============================================================================
