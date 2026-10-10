# REPORT mc-owed — a model of owed 0.5 acceptance and authority

Model `owed05` (formal/models/src/owed05.rs, std only, registered with one line in formal/models/src/lib.rs), tests
formal/models/tests/owed05.rs (7 tests), scripts formal/models/scripts/{owed05-big.sh, traces.sh, explore.sh, red.sh}.
Source modeled: trunk c4f1988 (release-0.5.0 merged): src/reducer.ts, src/ops.ts, src/plan.ts, src/extension.ts,
src/cli.ts, docs/SPEC.md, .owed/contract-0.5.md (D19–D25 and the rulings). formal/mc is unchanged. Every result below
ran against model source sha256 `7dc0aec6a3c526835572ee0f774a135c2dcdb92ecc99dbbad81ead6d8a1886ca` on ipc, in one run: log
`/tmp/owed-ipc/logs/mc-owed-1-103217.log` on the parent host (tests 3x, workspace, ablations, traces, bigger bounds). There is no TLA+ original of this model, so there are no TLC
numbers to compare with (the "ours vs TLC" column does not apply).

## 1. What is modeled

**Universe.** One node `A` (no deps) with check `t`, the review, approve and evidence obligations, and the trunk with one
invariant `inv`. `writes`, `closure-review`, `rulings`, red and strength items are not modeled (section 8).

**Plan** (the fields the model varies): `t` absent / strict / weak (a definition change that passes everything),
`exec` (a non-empty exec block that passes everything, `wrap: ["true"]`), `review.count` 0..2, `review.min_rank`
1..2, `approve: owner`, `evidence` none / by reviewer / by owner, and the allow rules `review_count: 0` (bit 1),
`checks: ["*"]` (bit 2), `adopt: ["data/"]` (bit 4). Each plan update changes one field (with `COMBOS=true`, also
"toggle one allow rule + change one other field").

**Hidden truth** (seen by the properties, not by the rules). Candidate content is `Good`, `Bad` (fails strict `t`),
`Flaky` (strict `t` passes or fails) or `Breaks` (passes `t` but breaks `inv` on the merge tree). An adopted trunk
commit is good or bad (breaks `inv`). The executor is honest: every observation has a verdict that the truth allows.
Keys are content-addressed as in SPEC §4: a check key is (content, base tree, definition, exec), a patch key (review,
approve, evidence) is (content, base), and an invariant key is (trunk tree, exec).

**Principals are claims; processes are the truth.** The claims are `owner:pi`, `parent:main`, `parent:drive`,
`writer:A#k`, `reviewer:r1|r2` and `reviewer:A#k` (sharing an id with a writer), plus `executor:owed`. The processes:
- **Main agent**: the owner (delegated) and the parent (`parent:main`). It updates the plan as owner, with or without
  a note, or as parent. It waives, records an owner review (rank 3), approves, records owner evidence, defers,
  adopts as owner or parent, and abandons. Waive, review and approve are modeled in two steps: the main agent decides
  on the candidate it sees, then the tool call runs. Under the gate the decision is the dialog.
- **Driver** (`parent:drive`): dispatch, attest (one job per step: attribution reruns of active execution blocks, then
  the candidate's check), merge (the merge-result measurements, then the merge), and rebase. This is all it does
  (src/drive-run.ts:300–354).
- **Subagent writer and reviewers** (DSA_CALL is set): submit; review with any reviewer claim (`r1`, `r2`, the next
  writer's id), ok or block, rank 1|2; evidence. A writer may review its own candidate under another id. The writer
  may also try `reviewer:A#k`, and a reviewer may try approve; the guard refuses both. Their owner and parent acts are
  refused by D25.3; under ablation `dsa` they get the main agent's owner acts.
- **Forger** (mode `forge`): it appends entries directly, so only replay validation can refuse them (the SPEC §1
  threat model). Its claims are any principal except the owner. The entries: plan updates as `parent:main` or
  `parent:drive`, with the honest or an empty `downgrades` list; executor observations with truthful verdicts on
  any check key at the slot base, with or without attribution or `merging`; invariant observations; merges without
  measurement; parent adoptions inside or outside the prefix; parent waivers; reviews by a parent, writer or writer
  id; approve by a reviewer; evidence by a writer or writer id, or with no files; parent defers.

**Modes.** `tools`: every process uses the normal tools. `forge`: `tools` plus the forger. `gate`: `tools` under
`OWED_CONFIRM=owner`, where owner acts are confirmed in a dialog (channel pi-confirm, not delegated).

**Steps.** Each transition appends at most one entry; replay validation (my transcription of `validateDraft`) must
accept it, and the operation path must produce it (except for the forger). ops.merge and ops.adopt append their
measurements and the merge or adopt entry under one lock. Here they are separate steps, a superset of the
interleavings. Genesis is recorded and its attest is done (`genesisDone`). The model is bounded by budgets:
`SUBMITS`, `PLANS`, `REVIEWS` (subagent reviews and evidence), `MAIN` (main-agent acts), `FORGE`, `ATTEMPTS`,
`ADOPT`. A merge ends the experiment.

## 2. Model to code (file:line at c4f1988)

| model (owed05.rs) | code |
|---|---|
| `detected` (downgrade items found by the reducer) | reducer.ts:334 downgradeDetails (checks :337–346, exec `*` item :349, allow :350, review :356, manual :359 → plan.ts:89 manualDowngrades) |
| `claimed` (the downgrades ops writes into the entry) | plan.ts:245 planDowngrades (+ plan.ts:163 allowWidened); written by ops.ts:195 |
| `covered` / `uncovered` | reducer.ts:382 covered (`*`/trunk never :383; rules of the prior plan :384; review :387–391; checks/evidence readings :392–399), :405 uncoveredDowngrades; used by validateDraft :444 |
| `validate` Plan | reducer.ts:440–452 (owner unless covered :446; D25.5 note :449) |
| `validate` Dispatch / Submit / Abandon / Rebase | reducer.ts:453, :460, :501, :502 |
| `validate` ObsCheck / ObsInv | reducer.ts:466–480 (merging :475, :478; attribution must match an active exec block :476) |
| `validate` Review | reducer.ts:481–488 with `current` :438 (reviewOnly), recusal by id :483, rank :484, approve owner-only :487 |
| `validate` Evidence | reducer.ts:615 evidenceErrors (current key :633, required role or owner :634, not a writer :636, files :637) |
| `validate` Waive / Defer | reducer.ts:489–494 (owner, current key, reason, accept_risk active) / :495–500 |
| `validate` Merge, `merge_guard` | reducer.ts:509–515 → :782 mergeGuard (accepted :786, items on merge keys :789–799, binding blocks :802, no new debt + defer of this attempt :803–813, genesis) |
| `validate` Adopt, `adopt_guard` | reducer.ts:517–533 (parent iff adopt prefixes and paths inside :519–522, else owner; note) → :767 adoptGuard |
| `apply` Plan (candidate invalidation, ΔO⁻) | reducer.ts:160–173 (invalidation :166, D19.4 `type` excluded; ΔO⁻ = claimed ∪ detected :169) |
| `apply` Dispatch / Submit / Abandon / Rebase / Merge / Adopt | reducer.ts:174, :180, :181, :182, :211, :215 |
| `apply` ObsCheck (exec blocks, attribution → cleared/flaky) | reducer.ts:187–200 (:195 attribution, :199 new block) |
| `apply` Review (judgment block; clearing by same reviewer ≥ rank, higher rank, owner on approve) | reducer.ts:201–205 |
| `apply` Waive (clears cited active blocks on the current key) | reducer.ts:206–208 (:208) |
| `item` (E/W/D per obligation, blocks → D, owner waiver citing every active block → W) | reducer.ts:57–119 (review :63–71 exact-writer filter :66, approve :81, evidence :87, executor lattice :95–101, blocks :103, waiver :113) |
| `accepted`, `binding` | reducer.ts:130, :18 |
| `merge_jobs` / `ops_diff` Merge | reducer.ts:740 mergeJobs; ops.ts:288–325 merge (accepted precheck :294, mergeJobs :304, guard on the prospective state :312) |
| attest jobs (driver), `ops_diff` ObsCheck | reducer.ts:679 attestJobs; ops.ts:80 runJobs with jobCurrent :96 → reducer.ts:727 |
| D25.3: subagents never act as owner or parent | ops.ts:44 subagentRefusal; extension.ts:54 mainAgentOnly; cli.ts:63 |
| delegated owner (channel) | extension.ts:68; cli.ts:69–72 |
| approve pin | extension.ts:172–175 (approvePreview → candidate), ops.ts:467 pinned, :481–485 approve; cli.ts:68 |
| waive / owner review: the key is taken at append time, no pin | extension.ts:234–237 → ops.ts:276 waive; extension.ts:165 → ops.ts:273 review |
| defer keys from the merge tree built at the call | extension.ts:239 (keys = the merge tree's invariant keys) |
| parent plan update refused with gaps before ops | extension.ts:204–210 |
| parent adoption precheck | ops.ts:367 (adopt), :374 |
| driver actions | drive-run.ts:300 (dispatch), :335 (attest), :336 (rebase), :337 (merge); cli.ts:44 (`drive` takes no `--as`) |

**Where ops and replay coincide by construction:** every ops mutation ends in `guard(state, draft)` = `validateDraft`
(ops.ts:50, used by `mutate` :63, `runJobs` :96–97, `merge` :312–313, `adopt`, `planSet` :195, `submit`, `dispatch`).
The model's operation path therefore calls the same `validate` and adds what ops does itself. The extra checks are the
D25.3 refusal, the parent-gap precheck of owed_plan, ops.merge's `accepted` precheck and its measurements, ops.adopt's
parent precheck and measurements, the approve pin, and `jobCurrent` for attest observations. The fields ops
generates are the plan's `downgrades` and the current candidate's key for review, waive and evidence. `ops_diff`
classifies a forged entry that replay accepts and ops would not append: `PlanClaims` (a different `downgrades`
list), `ObsNotCurrent` (an observation of an item that is not current), `Unmeasured` (a merge or adopt without the
measurements ops appends first) and `Other` (any authority or acceptance difference).

## 3. Properties

All are action properties on accepted transitions unless noted. Each is written from SPEC or contract text, not from
the transcribed reducer functions.
- **EasingAuthorized**: every plan update that truly eases acceptance must be by the owner (with a note when
  delegated, D25.5) or by a parent. True easings are: check dropped or weakened, exec passes everything, review count
  or rank lowered, approve dropped, evidence dropped or weakened, an allowance added. For a parent, each easing must
  be permitted by an owner-authored allow rule of the prior plan: `review_count` for a count, `checks` for check and
  evidence, never anything else. Ownership of rules is tracked by a ghost: rules present at genesis or set by an owner
  update. Waive and defer must be by the owner with a reason. Adopt needs a note and either the owner or a parent with
  an owner-authored adopt rule and all paths inside it.
- **NoSubagentAuthority** (process level): no owner or parent entry comes from a subagent process, and no driver entry
  eases. The forger is outside it (SPEC §1).
- **DriveClaimNeverEases** (claim level): no easing entry is claimed by `parent:drive`.
- **NoSelfJudge**: no review or evidence entry comes from a principal sharing its id with a writer of the node (as of
  the append). **NoSelfJudgeAtMerge**: at a merge, no ok review counted for the merged patch comes from such a principal
  (SPEC §6.2.5, "any attempt"). **NoSelfJudgeProcess**: a writer process never records a review or evidence entry.
- **BlockWins**: at a merge, every judgment block, and every execution block whose check still exists, is cleared. It
  must be cleared by an attribution fail on its key (execution), by an ok on the then-current key from the same
  reviewer at ≥ rank or from a higher rank (judgment), or by an owner waiver whose `accept_risk` cites it. "Bound to
  that content" is read as "on the then-current candidate key", which is what the reducer enforces.
- **MergedMeansCovered**: at a merge, every obligation is recomputed (SPEC §6.2–6.4) and must be covered. The merge
  key of `t` passed (no fail), or an owner waiver on it cites every active block. Review: `count` distinct non-writer
  oks at ≥ `min_rank`. Approve: an owner ok. Evidence: an entry by the required role or the owner, not a writer.
  `inv` on the merge tree passed, or an owner defer of this attempt names it.
- **BadMergeTracesToOwner** (truth): merged `Bad` content requires that `t` is absent, weak or exec, or that an owner
  waiver exists on the merge key. Merged `Breaks` requires exec or an owner defer. Merged `Flaky` with a fail on its
  merge key requires the same as `Bad`.
- **ApprovePinned**: an owner approval lands on the candidate that was decided on (the dialog under the gate).
  **WaivePinned** and **OwnerReviewPinned**: the same for owner waivers and owner reviews.
- **ReplayAgreesWithOps**: every forged entry replay accepts is one ops would append (`ops_diff` = none).
  **ReplayAgreesWithOpsOnAuthority**: the same, but only the `Other` class counts.
- **ExecBlockResolves** (LeadsTo, WF on the driver's attest): open candidate ∧ active execution block ~> no such block.
- Witnesses, all expected VIOLATED: `WitnessNoMerge`, `WitnessNoBadMerge`, `WitnessNoBreaksMerge`,
  `WitnessNoParentEasing`, `WitnessNoFlakyWaived`, `WitnessNoConflict` (pass and fail on one key, ⊤),
  `WitnessNoApprovedMerge`, and one per replay-only class: `WitnessReplayOnlyPlanClaims`, `WitnessReplayOnlyObs`,
  `WitnessReplayOnlyUnmeasured`.

## 4. Results

### Tests (`cargo test --offline --release -p models -- owed05`): 7 tests, ~12 s

| test | proves |
|---|---|
| owed05_tools_safety_holds_and_witnesses_are_reachable | safety + DriveClaimNeverEases + NoSelfJudgeAtMerge + ExecBlockResolves + ReplayAgrees* HOLD in mode tools on 4 genesis plans; witnesses reachable; small config = 81,791 states (regression pin) |
| owed05_forge_replay_validation_alone_keeps_safety | forge, ALLOW=2: safety HOLDS; OnAuthority HOLDS; strict ReplayAgreesWithOps and the 3 class witnesses VIOLATED; DriveClaimNeverEases VIOLATED in 1 step |
| owed05_findings_have_shortest_traces | the shapes and lengths of the finding traces (F1–F4) |
| owed05_ablations_flip_a_property | 17 ablations: baseline HOLDS, ablated VIOLATED (same config); next-allow alone and invalidate flip nothing |
| owed05_liveness_needs_fair_attest | ExecBlockResolves HOLDS with WF(attest), VIOLATED without (stutter lasso with the block active) |
| owed05_plan_guard_units | D21/D25 guard rules on hand-built states (coverage, `*`, allow change, rank, approve removed, note, evidence by) |
| owed05_gate_mode | gate: safety and ApprovePinned HOLD; owner downgrade without a note is accepted only under the gate; counts equal for 1 and 8 workers |

Self-checks: `cargo build --all-targets` produced 0 warnings. owed05 passed 7/7 three times in a row, and the whole
workspace passed (mc 27 tests + owed05 7), exit 0 (log 103217). Red check: on the slot base c4f1988 with
the test file grafted (`formal/models/scripts/red.sh`, the cargo variant of red.sh), `cargo test -p models -- owed05`
fails with `E0432 unresolved import models::owed05`, exit 101 (mc-owed-1-red-102801.log; the test file is unchanged since).

### Bigger bounds (owedmc on ipc, 16 workers; `models/scripts/owed05-big.sh`)

S = EasingAuthorized, NoSubagentAuthority, NoSelfJudge, BlockWins, MergedMeansCovered, BadMergeTracesToOwner.

| run | mode, consts (defaults otherwise) | distinct states | depth | time | max RSS | S | findings | log |
|---|---|---:|---:|---:|---:|---|---|---|
| M1 | tools REVIEWS=2 MAIN=2 ADOPT=false (+ ExecBlockResolves) | 16,547,998 | 16 | 26.0 s | 5.0 GB | HOLDS (and ExecBlockResolves) | Approve/Waive/OwnerReviewPinned, NoSelfJudgeProcess VIOLATED | 103217 |
| M2 | tools REVIEWS=1 MAIN=2 ADOPT=true ALLOW=7 | 6,027,570 | 18 | 5.5 s | 1.1 GB | HOLDS | same | 103217 |
| M3 | tools REVIEWS=1 MAIN=2 PLANS=2 ALLOW=7 APPROVE EVIDENCE=reviewer ADOPT=false | 2,107,992 | 13 | 2.1 s | 0.5 GB | HOLDS | same | 103217 |
| M4 | forge REVIEWS=1 MAIN=2 FORGE=1 ALLOW=7 ADOPT=false | 20,286,026 | 16 | 24.4 s | 4.4 GB | HOLDS; OnAuthority HOLDS | + DriveClaimNeverEases, ReplayAgreesWithOps VIOLATED | 103217 |
| M4b | forge REVIEWS=1 MAIN=1 FORGE=2 ALLOW=7 ADOPT=false | 16,451,072 | 16 | 19.9 s | 3.5 GB | HOLDS; OnAuthority HOLDS | same as M4 | 103217 |
| M5 | tools REVIEWS=1 MAIN=2 ATTEMPTS=2 SUBMITS=3 ADOPT=false | 14,699,571 | 17 | 15.9 s | 2.8 GB | HOLDS | + NoSelfJudgeAtMerge VIOLATED | 103217 |
| M6 | gate REVIEWS=2 MAIN=2 APPROVE ADOPT=false | 20,002,925 | 15 | 24.0 s | 4.5 GB | HOLDS; **ApprovePinned HOLDS** | Waive/OwnerReviewPinned, NoSelfJudgeProcess VIOLATED | 103217 |
| S1 | tools, rich: REVIEWS=3 MAIN=4 PLANS=3 SUBMITS=4 ATTEMPTS=2 ALLOW=7 APPROVE EVIDENCE=reviewer; simulate 20M walks, depth ≤60, seed 1 | 325,315,761 sampled | 23 | 71 s | 0.5 GB | HOLDS-SIM | as M5 | 103217 |
| S2 | forge, rich + FORGE=3; 20M walks, seed 2 | 400,353,022 sampled | 29 | 125 s | 0.5 GB | HOLDS-SIM; OnAuthority HOLDS-SIM | as M4 + M5 | 103217 |

Not completed: the default budgets in mode tools (REVIEWS=2 MAIN=2 ADOPT=true, more than 80M states) exceed the
memory cap. The full frontier states cost about 300 B per distinct state. At 14 GB of virtual memory the run aborted
(exit 134, no verdicts; log 101727, an earlier source sha). A first uncapped forge run (MAIN=2 FORGE=2) reached 23.8 GB
RSS and I killed it (log 101145, cut off). M1 and M2 split those budgets exhaustively, and S1/S2 sample far larger ones.

Caps since 0.6.0 (node formal-nits): every script in `models/scripts` runs under `ulimit -v` 8 GB and passes
`--max-states` and `--timeout` to every owedmc run; `owed05-big.sh` caps exhaustive runs at 22M distinct states. Rerun
of the whole script under these caps (log formal-nits-1-111216): M1-M6, S1 and S2 all complete with the same states,
depths and verdicts as the table (max RSS 5.0 GB, M1). The default budgets above now stop cleanly at max-states
(22.0M states, 6.7 GB RSS, 23 s, no verdicts, exit 1) instead of aborting. `explore.sh` and `traces.sh` rerun under
their caps (8 GB, 20M states, 240 s) reproduce §5 and §6.

## 5. Ablations (each guard removed, same configuration; `scripts/explore.sh`, log 103217)

| ablation (code removed) | property | baseline | ablated |
|---|---|---|---|
| owner-downgrade (reducer.ts:446) | EasingAuthorized | HOLDS 81,791 | VIOLATED |
| delegated-note (reducer.ts:449) | EasingAuthorized | HOLDS 81,791 | VIOLATED |
| star-covered (covered: `*` never, reducer.ts:383) with ALLOW=2 | EasingAuthorized | HOLDS | VIOLATED |
| allow-free (allow change not a downgrade, reducer.ts:350) MAIN=2 PLANS=2 | EasingAuthorized | HOLDS 1,332,221 | VIOLATED |
| next-allow + allow-free, COMBOS | EasingAuthorized | HOLDS 172,949 | VIOLATED |
| next-allow alone (covered reads the prior plan, reducer.ts:384) | EasingAuthorized | HOLDS | **HOLDS**: redundant while allow changes are owner-only |
| adopt-role (reducer.ts:519–523, ops.ts:367) ADOPT | EasingAuthorized | HOLDS 350,828 | VIOLATED |
| waive-role (reducer.ts:490) forge | BlockWins; EasingAuthorized | HOLDS 1,362,036 | VIOLATED; VIOLATED |
| waive-cites (accept_risk, reducer.ts:208) | BlockWins | HOLDS | VIOLATED |
| dissent (same-rank other reviewer, reducer.ts:205) REVIEWS=2 | BlockWins | HOLDS 1,188,842 | VIOLATED |
| flaky (attribution pass → flaky, reducer.ts:196) | BlockWins | HOLDS | VIOLATED |
| recusal (reducer.ts:483) | NoSelfJudge | HOLDS | VIOLATED |
| evidence-writer (reducer.ts:636, :634) EVIDENCE=reviewer | NoSelfJudge | HOLDS 90,306 | VIOLATED |
| merge-guard (ops.ts:294 + reducer.ts:786–799) | MergedMeansCovered | HOLDS | VIOLATED |
| inv-guard (no new debt, reducer.ts:803–813) | BadMergeTracesToOwner; MergedMeansCovered | HOLDS | VIOLATED; VIOLATED |
| approve-role (reducer.ts:487 and :82, both) APPROVE | MergedMeansCovered | HOLDS 86,526 | VIOLATED |
| pin (ops.ts:485) gate, APPROVE | ApprovePinned | HOLDS 87,706 | VIOLATED |
| dsa (D25.3, ops.ts:44 via extension.ts:54 / cli.ts:63) | NoSubagentAuthority | HOLDS | VIOLATED |
| invalidate (reducer.ts:166) | MergedMeansCovered; BadMergeTracesToOwner | HOLDS | **HOLDS**: redundant, because the merge re-measures `t` on the current plan's merge key and items read the current plan |

The two redundant guards are defense in depth and not findings. `approve-role` removes both of its checks. With only
the validateDraft check removed, item() still counts only owner approvals, so nothing flips; that check is also
redundant alone.

## 6. Findings (properties that fail on the real semantics; shortest traces from `scripts/traces.sh`, log 103217)

**F1 — owner waive and owner review are not pinned to the candidate decided on (WaivePinned, OwnerReviewPinned;
every mode, including the gate).** Trace (5 steps):
1. The driver dispatches.
2. The writer submits #1 (Flaky).
3. The main agent decides "waive A/review" on #1 (in the gate: the dialog, which shows no candidate).
4. The writer submits #2 (Breaks).
5. owed_waive runs: ops.waive takes the key of #2. The review obligation of #2 is waived although nobody saw #2.

The owner review (rank 3) is the same. Its trace: submit #1, decide, submit #2 (Bad), and the owner ok lands on #2.
Cause: extension.ts:234–237 / ops.ts:276 and ops.ts:273 compute the key under the lock at append time and take no
expected candidate. This is the gap ruling #389 closed for approve and evidence. Suggested repair: as for approve,
the waive and review-as-owner previews pin `{seq, commit}`, and ops refuses `candidate changed since confirmation`.
Severity: medium. The waiver is bound to content, but not to the content the owner decided on.

**F2 — delegated owed_approve pins the call, not the decision (ApprovePinned in modes tools/forge; HOLDS under the
gate).** Trace (5 steps): dispatch; submit #1 (Good); the main agent decides to approve #1; submit #2; owed_approve
runs. approvePreview pins #2 inside the same call (extension.ts:172–175, cli.ts:68), so #2 is approved. Under
`OWED_CONFIRM=owner` the pin is what the dialog showed, and the property holds (M6, 20M states). Since D25 makes
delegation the default, the pin protects only the opt-in gate. owed_approve and `owed approve` take no expected
candidate argument for the main agent to pass. Suggested repair: an optional `commit` (or `seq`) parameter on
owed_approve, `owed approve --commit`, and the same for owner evidence, passed to `ops.approve({candidate})`.

**F3 — identities are claims: a writer subagent can review its own candidate under another reviewer id
(NoSelfJudgeProcess; every mode).** Trace (3 steps): dispatch; the writer submits #1 (Bad); the writer process records
`owed review A --ok --rank 2 --as reviewer:r1`. D25.3 refuses only the roles owner and parent; the recusal rule
(reducer.ts:483) compares ids. With the claim-level NoSelfJudge the guard holds, and reviews by `writer:A#k` or
`reviewer:A#k` are refused. SPEC §1 names "reward-hacking shortcuts by agents using the normal tools" as in scope,
and this shortcut uses only the normal tools. The executor still measures `t`, so `Bad` is not merged here
(BadMergeTracesToOwner holds). Self-review weakens only the review obligation. Possible mitigation (a product
decision, not made here): bind reviewer ids to their dsa calls, or refuse review/evidence in a DSA_CALL process
whose call is the node's writer run.

**F4 — item() and validateDraft disagree on recusal (NoSelfJudgeAtMerge, ATTEMPTS=2).** Trace (9 steps):
1. dispatch #1; the writer submits Flaky; attest passes;
2. a reviewer subagent records an ok as `reviewer:A#2`. This is allowed: `A#2` is not yet a writer.
3. abandon; dispatch #2; writer:A#2 submits the same content on the same base, so the patch and keys are the same;
4. the merge-result inv observation; merge.

The review counted for writer:A#2's candidate is `reviewer:A#2`. validateDraft refuses ids that share a writer's id
at append time (reducer.ts:483), but item() filters only exact writer principals (reducer.ts:66, `writers.includes`).
SPEC §6.2.5 says "none of them a writer of this node (any attempt)". Severity: low, because it needs a reviewer id
that collides with a future writer id. Repair: use the same id comparison in item() as in validateDraft (`isWriter`,
reducer.ts:44, which the evidence item already uses).

**F5 — replay does not reserve `parent:drive` (DriveClaimNeverEases, mode forge).** Trace (1 step): with an allowance
`checks: ["*"]`, a forged plan entry by `parent:drive` removes check `t`, and replay accepts it. "The driver never
eases" holds only because of the drive code: the driver has no such action, and the tools mode holds. Neither
validateDraft nor ops distinguishes `parent:drive` from any other parent. The CLI also accepts
`owed plan … --as parent:drive` from the main agent, because only the `drive` command refuses `--as`. Severity: low,
since it needs a direct ledger write or a deliberate claim. Repair if wanted: validateDraft refuses plan, rule,
waive, defer, adopt and abandon entries by `parent:drive`.

**F6 — replay-only entries (ReplayAgreesWithOps, mode forge).** Each class has its own shortest trace.
- `PlanClaims` (1 step): a parent plan entry with `downgrades: []` where planDowngrades gives `[check t removed]`.
  It is harmless: the reducer unions the detected items (reducer.ts:169).
- `ObsNotCurrent` (1 step): an executor pass on a key of other content. This is by design (D24.1: an observation is
  a fact about its key; runJobs drops it, replay keeps it).
- `Unmeasured` (6 steps): a merge appended without measuring the deferred invariant of the merge tree. The debt is
  still shown as deferred.

ReplayAgreesWithOpsOnAuthority (no `Other` difference) holds in every forge run: M4, M4b, and S2 with 400M sampled
states. All the safety properties also hold in forge mode, so these replay-only entries never ease acceptance within
the bounds.

No failures of EasingAuthorized, NoSubagentAuthority, NoSelfJudge, BlockWins, MergedMeansCovered or
BadMergeTracesToOwner were found at any bound.

## 7. Liveness

ExecBlockResolves holds under weak fairness of the driver's attest: the small config, and M1 with 16.5M states. Without
fairness it is violated by a 3-step stutter lasso: dispatch, submit Bad, fail observation, then stuttering with the
block active. A liveness property for merge was considered and not stated. "Accepted ~> merged" fails by design when
a merge needs an owner defer (new invariant debt), and it would hold only under assumptions on the owner.

## 8. Not modeled, deviations, limits

- Not modeled:
  - the `rulings` obligation and D22 ruling sends; `needs: parent` (no acceptance effect; driver halts only);
  - `writes` and allowance `writes`; `closure-review`; red and strength items; `review_rank` allow rules; node globs
    (every rule matches `*`);
  - several nodes and deps; setup and closure changes; decoys and escapes; evidence receipts; owner approve blocks;
  - launch, send and halt entries;
  - D24 concurrency of attestGenesis: genesis is attested at init, and stale observations are covered by the forger's
    observations on arbitrary keys;
  - CAS and trunk drift, locks and `stable()`: steps are atomic; merge and adopt are split into measurement and append
    steps (a superset);
  - channels tty and flag (the gate uses pi-confirm), and OWED_CONFIRM_TIMEOUT (a timeout records nothing, so it is
    the same as no step);
  - `error` observations (an executor run that produced no verdict): the model's verdicts are pass/fail only. In the
    code an `error` observation is no verdict (`hasVerdict`), never opens an exec block, and its attribution is skipped,
    so it neither clears nor marks flaky an active exec block (reducer.ts `obs` case).
- The forger never claims the owner, because a forged owner entry is indistinguishable from a real one by design
  (SPEC §1). Its observation verdicts are truthful.
- Process-level properties trust the process ghost. NoSubagentAuthority does not cover the forger: SPEC §1 calls
  D25.3 an accident rail.
- The model's merge keys assume the merge tree equals the candidate tree when trunk = base, and equals
  (content, trunk) otherwise.
- Engine: formal/mc unchanged. Memory per distinct state is ~300 B at these sizes, because the full frontier states
  carry Vec fields; the default-budget exhaustive run therefore does not fit the 14 GB cap (nor today's 8 GB cap, §4).

## 9. 0.7 merge CAS

0.7 (node merge-cas) narrows ops.merge's final check from `stable()` (whole plan sha) to a node-scoped CAS
(src/ops.ts:71 `nodeStable`: ledger trunk, the node's slot and candidate, then the trunk ref at :391). The claim of §1
and §8, that the model's split of merge into measurement and append steps is a superset of the code, still holds; the
model is unchanged. Checked against formal/models/src/owed05.rs:
- The model's driver appends each merge-result observation as its own step, in any state where the candidate is
  accepted and the job is in `merge_jobs` (owed05.rs:1207–1215; ops path :1012 and :1022). `merge_jobs` (:698) yields
  only keys under the current plan that lack a verdict, pass or fail (`(cp | cf) & bit == 0`), like `mergeJobs` with
  `hasVerdict` (reducer.ts:785, :26). Plan updates and other processes' entries interleave freely between these steps.
  A plan change to the node's spec (or exec) drops the candidate (:894), and the code's CAS then refuses with nothing
  recorded.
- The code keeps a measured observation only if its job is still a merge or genesis job of the latest state, with
  the facts recomputed under the latest plan (ops.ts:396 and `mergeCurrent`, :425). Each appended observation is
  therefore one model step at the latest state. The code drops the others, and measuring has no ledger effect.
- The merge entry is appended only when `mergeGuard` holds on the latest state plus the kept observations, and no job
  of that state is left unmeasured (ops.ts:400–406). In the model this is the `Merge` step, enabled when `merge_jobs`
  is empty (:1209–1211), with `merge_guard` (:674) evaluated in `validate` (:861) on that state. The merge key is
  taken under the plan in force at that step (`merge_check_key`, :624). Errors are outside the model (§8): an `error`
  observation is measured again by the next merge.
- One gap is unchanged from 0.6. On a guard refusal the kept observations are appended even when the node is no
  longer accepted at the append, for example after a reviewer block or a new ruling. The tools-mode ops path does not
  have this step: `ops_diff` requires `accepted`. Forge mode covers it: the forger appends truthful executor
  observations, with or without `merging`, in any state, and safety S HOLDS there (M4, M4b).
