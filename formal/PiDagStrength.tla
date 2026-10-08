--------------------------- MODULE PiDagStrength ---------------------------
(***************************************************************************)
(* C1: can a writer manufacture execution or strength evidence?           *)
(* Mode "a1": DESIGN/a1 literal - writer self-run receipts count, any red  *)
(*   (nonzero exit) on any counterfactual counts as strength.              *)
(* Mode "a21": ARCHITECTURE a2.1 - observations by the writer are speech   *)
(*   (避); exec needs a pass and no fail on the same key (格); strength    *)
(*   needs the law-specified counterfactual (base) with the specified      *)
(*   failure mode; a writer-authored test needs a non-writer admission     *)
(*   law on its exact version before it can judge the node.               *)
(* Hidden truth: impl good|bad; test strong|weak|vacuous.                 *)
(*   strong : passes good, fails bad with the expected assertion           *)
(*   weak   : fails on base as specified, may miss the real bug           *)
(*   vacuous: zero cases / sys.exit(0), always passes                      *)
(* The admission reviewer is NOT assumed accurate (it may admit anything). *)
(***************************************************************************)
EXTENDS Integers, FiniteSets

CONSTANTS Mode, MaxVer, CfLaws

VARIABLES impl, implV, test, testV, testAuthor, admitted,
          execObs,   \* results reported by the runner for exec on current versions
          cfLaw,     \* counterfactual named in the law: "base" or "mutant" (candidate with the target behaviour stubbed)
          cfBase,    \* runner results on the law-specified counterfactual
          cfPick,    \* runner results on a writer-chosen counterfactual
          fake,      \* writer posted self-run receipts (it can claim anything)
          merged
\* observations are keyed by (impl version, test version): every write
\* starts a new, empty key, so only the current key is kept.

vars == <<impl, implV, test, testV, testAuthor, admitted, cfLaw, execObs, cfBase, cfPick, fake, merged>>

A21 == Mode = "a21"
Kinds == {"strong", "strongNew", "weak", "vacuous"}
\* strongNew: a strong test of a NEW module; on base it can only die with ImportError

Init ==
  /\ impl = "none" /\ implV = 0
  /\ test = "none" /\ testV = 0 /\ testAuthor = "none"
  /\ admitted = -1
  /\ cfLaw \in CfLaws
  /\ execObs = {} /\ cfBase = {} /\ cfPick = {} /\ fake = FALSE
  /\ merged = FALSE

ClearObs == execObs' = {} /\ cfBase' = {} /\ cfPick' = {} /\ fake' = FALSE

\* the planner writes the test into the law before dispatch
PlanTest(k) ==
  /\ test = "none"
  /\ test' = k /\ testV' = testV + 1 /\ testAuthor' = "planner"
  /\ ClearObs
  /\ UNCHANGED <<impl, implV, admitted, cfLaw, merged>>

\* the writer (re)writes the test inside its worktree
WriterTest(k) ==
  /\ ~merged /\ testV < MaxVer
  /\ test' = k /\ testV' = testV + 1 /\ testAuthor' = "writer"
  /\ ClearObs
  /\ UNCHANGED <<impl, implV, admitted, cfLaw, merged>>

WriteImpl(q) ==
  /\ ~merged /\ implV < MaxVer
  /\ impl' = q /\ implV' = implV + 1
  /\ ClearObs
  /\ UNCHANGED <<test, testV, testAuthor, admitted, cfLaw, merged>>

\* test-first cheap channel: a non-writer freezes the hash and admits it
Admit ==
  /\ ~merged /\ testAuthor = "writer" /\ admitted # testV
  /\ admitted' = testV
  /\ UNCHANGED <<impl, implV, test, testV, testAuthor, cfLaw, execObs, cfBase, cfPick, fake, merged>>

\* expected = the specified assertion failure; wrong = any other failure
ExecResult(t, i) ==
  CASE t \in {"strong", "strongNew"} -> (IF i = "good" THEN {"pass"} ELSE {"expected"})
    [] t = "weak"    -> (IF i = "good" THEN {"pass"} ELSE {"pass", "expected"})
    [] t = "vacuous" -> {"pass"}

\* base = counterfactual named in the law; pick = chosen by the writer, e.g.
\* base without the new module: every test dies with ImportError
LawResult(t) ==
  CASE t = "vacuous" -> {"pass"}
    [] t = "strongNew" /\ cfLaw = "base" -> {"wrong"}
    [] OTHER -> {"expected"}   \* weak tests also kill the mutant (FAULT-POWER: 8/8 killed)

Ready == ~merged /\ impl # "none" /\ test # "none"
Keep(v) == UNCHANGED <<impl, implV, test, testV, testAuthor, admitted, cfLaw, merged>> /\ UNCHANGED v

RunExec == Ready /\ \E r \in ExecResult(test, impl) : execObs' = execObs \cup {r}
           /\ Keep(<<cfBase, cfPick, fake>>)
RunBase == Ready /\ \E r \in LawResult(test) : cfBase' = cfBase \cup {r}
           /\ Keep(<<execObs, cfPick, fake>>)
RunPick == Ready /\ cfPick' = cfPick \cup {"wrong"}
           /\ Keep(<<execObs, cfBase, fake>>)
Fake    == Ready /\ ~fake /\ fake' = TRUE
           /\ Keep(<<execObs, cfBase, cfPick>>)

TestAdmissible == testAuthor = "planner" \/ admitted = testV

\* a1: a self-reported or runner pass counts; any red on any counterfactual counts
ExecE ==
  IF A21 THEN execObs = {"pass"} /\ TestAdmissible
         ELSE "pass" \in execObs \/ fake
StrengthE ==
  IF A21 THEN cfBase = {"expected"}
         ELSE cfBase \cap {"expected"} # {} \/ cfPick # {} \/ fake

Merge ==
  /\ ~merged /\ impl # "none" /\ test # "none"
  /\ ExecE /\ StrengthE
  /\ merged' = TRUE
  /\ UNCHANGED <<impl, implV, test, testV, testAuthor, admitted, cfLaw, execObs, cfBase, cfPick, fake>>

Next ==
  \/ \E k \in Kinds : PlanTest(k) \/ WriterTest(k)
  \/ \E q \in {"good", "bad"} : WriteImpl(q)
  \/ Admit \/ RunExec \/ RunBase \/ RunPick \/ Fake
  \/ Merge

Spec == Init /\ [][Next]_vars

(* properties *)
NoVacuousMerged == merged => test # "vacuous"
StrongCatches   == merged => ~(test \in {"strong", "strongNew"} /\ impl = "bad")
\* witnesses, expected VIOLATED in a21 (limits / non-vacuity)
NoWeakEscape       == ~(merged /\ test = "weak" /\ impl = "bad")
NoWriterTestMerged == ~(merged /\ testAuthor = "writer")
NothingMerged      == ~merged
NewModuleStuck     == ~(merged /\ test = "strongNew")
=============================================================================
