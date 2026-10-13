# Changelog

## 0.16.1

This release delivers the merged nodes stalesend (SR, HA) and reviewdedup
(RR), keeping rejected sends from stranding recoverable attempts, reporting
questions while halted and avoiding redundant reviewers after unchanged-key
resubmits, without weakening any gate. Origins: wais feedback on owed
0.16.0 in `/tmp/dsa/owed-requirements.md` (2026-10-13 13:4x, a forced dsa
1.0.39 orchestrator restart; 14:3x, a halted writer's hidden question;
14:4x, CMP-META attempt 2's evidence-only resubmit and redundant reviewer).
The parent's rulings below pin the behavior where the original asks changed.

- **Recover attempts after a rejected send (stalesend, SR1–SR4; wais
  forced-restart feedback).** A rejected send of the open attempt is
  superseded by a later ledger entry: a resume or submit of that same
  node/attempt, or another send of the attempt to the same rid that is not
  itself rejected. That later send need not be confirmed applied. The old
  send is skipped, never re-sent and cannot halt or block later rows.
  Existing rejected ruling-steer, waiting-notice and ruling-notice exemptions
  remain. A rejected steer to a run now sealed or pruned is also skipped so
  sealed-run rows decide; a writer sealed `unknown` gets the `interrupted`
  follow-up, which then supersedes the steer. At action time a rejected
  steer records its refusal and returns `rejected` without halting; the next
  pass applies these rules. A rejected steer to a still-running, asking or
  queued run with nothing later still halts; rejected follow-ups and notices
  retain their action-time behavior. Rejected-send halt text says the attempt
  is not lost: continue the run (e.g. a dsa follow-up), then
  `owed resume <node>`; a later resume, submit or send to this run supersedes
  the send, with `owed abandon <node>` only as the last option. That resume
  prevents the same send from re-halting. Rejected run requests remain fixed
  for the attempt and still require fixing the cause and abandoning it.
- **Report questions even while halted (stalesend, HA1–HA2; wais
  14:3x feedback).** The driver still reports asking writers and reviewers
  of the current candidate with the existing question text, answer/ruling
  hint, rid/qid/rev and once/quiet semantics. The slot action does not clear
  the halt, send anything or take another action. Ruling #1743 limits that
  no-send rule to slot actions: PR2 prospective notices still reach halted
  attempts. Ruling #1746 refines notice precedence: a non-quiet report with
  a concrete qid, or an overdue answer retry, precedes a pending prospective
  notice once per rid/qid/rev in that driver; a later pass may send the
  notice. Reporting alone does not quiet an unanswered question. A generic
  asking notice with no question content/qid does not preempt PR2, and
  other notices retain their precedence. `owed status` and brief stay
  ledger-only; the driver's asking notify is the question channel.
- **Reuse reviewers across unchanged review keys (reviewdedup, RR1–RR3;
  wais 14:4x feedback, CMP-META #7204/#7208/#7209/#7211).** The current
  candidate's review epoch starts at the earliest submit of the open attempt
  whose required `review` and `closure-review` keys remain unchanged through
  the current candidate. Reviewer launches after that epoch start remain
  live for questions, fence/ruling steers and rows 12–15, and count toward
  required reviewer runs; an unchanged-key resubmit does not launch a
  duplicate. A changed key starts a new epoch, and changing then restoring
  a key does not revive earlier reviewers. Writer launches are unchanged.
  Ruling #1724 applies the same epoch to the two reviewer filters in
  `src/drive-run.ts` (driver views and live-run reporting). Carried reviewers'
  verdict follow-ups name the current candidate; a review by that principal
  on the same obligation key counts even if recorded before the latest
  submit. Satisfied `review`/`closure-review` receipt and `owed why` items
  show each principal once, using its latest qualifying review, including
  JSON `evidence` and `observations`. Deduplication is view-only: stored and
  replayed evidence and distinct-principal satisfaction are unchanged.

### Compatibility

Owed 0.16.0 and 0.16.1 share a ledger. No new entry kind or field is added;
replayed states, obligation keys and acceptance gates are unchanged. The
changes are driver decisions, halt text and receipt presentation.

### Deferred

Stopping surplus reviewer runs once review is satisfied (RR4) requires a
driver `stop` effect, which 0.16.1 does not add. None is claimed as delivered.

## 0.16.0

This release delivers the six merged nodes answerrev (AR), slotsetup (SS),
mergeorder (MO), flakyhint (FH), nits016 (NT) and driveload (DL), removing
observed answer, prerequisite, merge-queue and driver-load costs without
weakening any gate. Origins: the dsa 1.0.38 note (2026-10-13 04:2x), wais
feedback (2026-10-13 07:3x and 08:4x) in
`/tmp/dsa/owed-requirements.md`, three non-blocking 0.15 metrics/summary
review notes, and `/tmp/pi/pi-performance-diagnosis-2026-10-13.md` task B.
The parent's rulings below pin the behavior where the original asks changed.

- **Answer re-asks at their current revision (AR; dsa 1.0.38 note,
  item 1).** `owed answer <node> [--qid Q] [--rid R] [--rev N] "<text>"`
  (pi `owed_answer` parameter `rev`, a positive integer) uses the matching
  open question's current revision from dsa describe, never an old rule's
  revision. Without a matching open question, `--rev N` retries that prior
  answer; omission retries the latest rule for rid/qid. With no matching
  history it refuses. Answer identity is rid+qid+rev: the same revision
  and text reuse the rule/request; different text refuses and names the
  revision. A higher-revision re-ask records a new rule and request even
  for identical text. Ruling #1599 extends AR to the reducer; #1600 pins
  its duplicate check and requires `supersedes: <latest prior answer seq>`
  exactly when a prior rid/qid answer exists, with a lower revision.
  Retry hints include `--rev`. A q@2 re-ask after a q@1 answer remains an
  open driver question, not an answered quiet line. Answers do not
  invalidate candidates; reviewers still acknowledge in-scope rulings.
- **Prepare writer slots without committing setup artifacts (SS;
  wais 08:4x feedback, HOST-CASE-DOC-WIRE #6327 and five other slots
  missing prerequisite links).** Dispatch runs `slot_setup` when it is
  a string, otherwise the plan's `setup`, in the new worktree before
  recording dispatch; `slot_setup: false` skips it. CLI, pi and driver
  dispatch share the measurement shell/environment/wrapper and a
  600-second timeout. Success adds a one-line `Setup: ran ... (exit 0)`
  packet line. Failure names the exit code or timeout and last 20 combined
  output lines, rolls back the worktree, unchanged branch and newly
  created directories, and records nothing. Setup outputs never enter a
  candidate (SS5, #1607): tracked-file changes refuse dispatch; newly
  created untracked, not-ignored paths get deduplicated anchored literal
  rules in common `info/exclude` and are named in the packet.
  Newline/carriage-return paths refuse; other special characters are
  literal-escaped, rules start with `/`, and directories retain trailing
  `/` (#1617). SS6 (#1656) verifies every created status path, including
  directory descendants, is ignored. A tracked `.gitignore` negation
  leaving outputs visible refuses dispatch with paths and rollback;
  owed never edits tracked files to hide outputs. Rollback removes only this
  dispatch's appended exclude bytes, preserving existing rules, including
  when exclude append fails after writing (#1671). Successful rules
  persist across worktrees. `slot_setup` enters no key and changes alone
  invalidate no candidate/evidence; existing `setup` keys are unchanged.
  Rebase reuses the worktree without rerunning setup.
- **FIFO merges with explicit-wait priority (MO; wais 07:3x feedback,
  QA-MPV1-MARKER #6067, HOST-ACQ-REACH, BG-ACQ-CLEANUP and
  LY-ROAD-LEGACY waiting accepted for 1–4 hours).** Accepted open attempts
  merge first when named by an outstanding latest `resume --after` wait,
  then all others; within each group the order is derived `acceptedSince`
  ascending, dependent count descending, then id. Losing acceptance or
  replacing the candidate resets its tenure; incremental and full replay
  agree. `owed resume X --after Y` raises accepted Y's priority without
  changing the plan or dropping a carried candidate. Replacing the resume,
  closing the waiting attempt or merging Y removes that priority; implicit
  dependencies alone do not raise it. Full status shows `Merge queue:`;
  status JSON adds `mergeQueue: string[]`. The driver's single merge slot
  takes the first eligible action; other actions keep their existing
  order. A continuously accepted, eligible node merges after at most the
  accepted nodes ahead of it; only a waited-on node can newly overtake it.
  Waits, halts, measurements and merge guards still apply.
- **Name intermittent merge failures and possible fixes (FH; wais
  07:3x feedback, repeated names at #4614/#5903 and #5037/#5325,
  CUT-FROZEN-HTTP refusals while QA-MPV1-MARKER waited).** CLI merge
  refusals, driver merge-refused halts and `owed why` block/merge-check
  lines add `known intermittent: <name> also failed on #a, #b (other trees)`
  for exact failed names seen on different commits, scanning at most the
  last 5000 entries and citing at most three sequences, newest first.
  Names of at least six characters found verbatim in an unmerged open,
  accepted or ready node's title, brief, check run or tests list add
  `fix candidate: <node> (<phase>) — owed resume <refused> --after <node>`.
  Same-commit history adds no intermittent hint; anonymous failures add
  neither hint. These are advisory text, not automatic waits, reordered
  work, relaxed gates, changed keys or new ledger fields.
- **Keep metrics meaningful and unrechecked debt visible (NT;
  three non-blocking 0.15 metrics/summary review notes).** Metrics
  `--since`/`--until` also accept date-only `YYYY-MM-DD` at UTC midnight.
  Halt normalization replaces lowercase plain-word node ids only in node
  positions (start before `:`, before `/`, after `node ` or `--after `,
  or as the argument of `owed <verb> `), preserving ordinary prose such
  as `merge refused` and `review refused`; other ids keep prior behavior.
  Default status and brief retain current-attempt owner defers when trunk
  drift or merge conflicts prevent rechecking, labeled
  `not rechecked: trunk moved` or `not rechecked: merge conflicts`; JSON adds
  `deferred[].unverified: 'drift' | 'conflict'`. Retired nodes/invariants
  and older attempts stay excluded; stale defers disappear once the
  current merge key can be queried. Unverified debt is not acceptance
  evidence; no gate, key or ledger schema changes.
- **Reuse verified state caches in every driver load (DL; pi performance
  diagnosis 2026-10-13 task B, wais driver at 113–145% CPU and about
  1.9 GiB RSS).** Driver passes, reaping, refusal and status/state reads
  use the ops replay memo/disk snapshot and persistent parsed-plan cache,
  still reading and verifying the entire ledger hash chain on every load.
  Warm loads never fully replay or parse historical plans. Ruling #1689
  permits same-head/incremental loads to refold up to `MEMO_EVERY-1 = 31`
  entries since the last memo point, in addition to newly appended entries
  for incremental loads; crossing 32 advances that point and the next
  same-head load folds zero. Memo/snapshot cadence is unchanged.
  Reports are applied only to a private loaded state, never the ledger-only
  cache; driver mutations cannot leak into later loads. Corrupt/mismatching
  snapshots fall back to full replay, bad hash chains still refuse, and
  newly appended plans are applied. Locks, stale checks, rulings,
  scheduling, idempotence, keys and ledger schemas are unchanged.

### Compatibility

Owed 0.15 and 0.16 can share a ledger until the first re-ask answer rule
carrying `supersedes` is recorded (#1600). Owed 0.15 refuses that entry
with code `version`; upgrade every process using a ledger — CLI, pi
extension, background drivers and remote executors — together, and
restart existing pi sessions. No new entry kind is added. Other additions
are derived state, output or plan fields and leave acceptance keys intact.
Mixed 0.14/0.15 remains unsupported.

Owed 0.15 ignores top-level `slot_setup`, runs no setup at dispatch and
adds no key for it (#1601); a plan using it needs 0.16 for setup to run.

Driver caching does not remove cold load: a fresh driver process still
pays one cold load (on wais about 20 seconds). On a 7,071-entry / 279-plan
wais ledger, warm loads measured about 0.1 seconds (213x faster), and
loads after +10 entries about 0.09 seconds (328x faster). These are warm
load measurements, not a cold-start or whole-driver-pass guarantee.

### Deferred

Incremental `ledger.read()` verification; automatic re-verification after
a repair (to be decided from 0.15 metrics); setup rerun on rebase; merge
train #22; measuring on the merged trunk #23; cold driver load. None is
claimed as delivered in this release.

## 0.15.0

This release delivers the merged nodes invred (IR), knownred (KR),
notices (QN), summary (SQ) and metrics (MT): quiet by default, loud
precisely, measurable. Origins: wais feedback on 0.14 (2026-10-12 22:00)
in `/tmp/dsa/owed-requirements.md`, items 1–3, plus another owed user's
report (2026-10-12) about internal notices, a late old-driver `stopped`
and mixed historical audit/current blockers/version hints. Metrics comes
from the product goal of measuring interruptions and acceptance time.
The parent's rulings below pin the behavior where the original asks changed.

- **Refresh trunk invariants and inherit bounded existing failures (IR;
  wais inv:next-tests, INFRA-PREBUILT-KERNEL #4159, AQ-KF #4178,
  KX-RUNTIME-GC escape #4188 and run-string workaround R139).**
  `owed attest --trunk` (pi `owed_attest {trunk: true}`, no node) records
  executor `refresh` entries for current-plan invariant keys that differ
  from the ledger trunk's recorded keys, then measures them on trunk.
  Refresh changes invariant keys, not trunk commit or sequence; stale
  commits are refused. Merge performs the refresh before measuring its
  result and keeps the trunk observations even when refused; an otherwise
  quiet driver pass refreshes through its background measurement lifecycle
  and shared no-wait lease. An interrupted refresh can resume missing
  observations; nothing pending records nothing. Never-refreshed items
  say `not measured on trunk yet — owed attest --trunk`.
  A differing unsatisfied merge key needs no defer when the deciding
  executor failure on trunk and the merge failure have complete named
  failure lists, the merge failure is test-only, and every merge failure
  already occurs on trunk. Completeness is checked against failure counts,
  including each failing repeat run and its retained union; structured
  `execution.completed` and `execution.countOK` prove test-only execution,
  not display notes or log tails. Unknown/truncated names, timeout/error
  and count/min_tests failures do not qualify. New failures still refuse,
  naming only the new tests when available. Inherited debt stays D and
  belongs to the parent, not any open writer; owner defers and adopt retain
  their rules. Status, `owed why trunk` and the driver give fix-node,
  known-red and sweep options; the driver wakes once per (invariant, key)
  without halting node work. Background changes in rulings #1521/#1523
  are limited to IR3 notice identity and delivery-time revalidation:
  repo-scoped `inv:<id>` notices carry the obligation/key, separate from
  trunk drift, and are dropped before pi delivery if removed, resolved
  or on a different key. Failed ledger reads retain the notice.
- **Exact known-red debt owned by a fix node (KR; wais item 2,
  replacing run-string exclusions).** Invariants accept
  `known_red: [{test: <exact obs.failed name>, fix: <plan node id>}]`,
  at most 20 unique names, with fixes in the same plan; it enters no key.
  `owed edit --invariant <id> --set known_red=...` supports the field.
  Adding a name or changing its fix is an owner-only plan downgrade;
  no `allow` rule covers it, while removal is free (#1484).
  Entries stay active until their fix merges. Test-only failures entirely
  covered by active entries yield W (⚠), satisfied for acceptance and
  merge, with names, fixes and plan sequence visible as debt in default
  status, brief and report. Unlisted failures are evaluated normally.
  At a fix node's merge its own entries are inactive: still-failing owned
  names refuse the merge, even with an unchanged key or owner defer.
  KR3 is wired into IR2: the merging node's own fix names are excluded
  from inheritable trunk failure names, so trunk-red debt cannot excuse
  its unfinished repair (#1485). After the fix merges the entries lapse;
  `status --full` lists them as removable, and recurrence is ordinary red.
- **Answered questions stay quiet; old drivers do not look current (QN;
  wais item 3, HOST-VOCAB, LY-TFL-K and ST-LOCK repeated questions,
  plus the user's notice/late-`stopped` report).** The driver and pi
  delivery revalidation suppress questions covered by a recorded answer
  for the same run/question and no newer revision. A covered asking run
  logs that the answer was recorded and waits quietly. After
  `drive.answer_grace_s` (default 900 seconds, 0 immediately), a still-open
  covered question wakes once per (run, question) in that driver run,
  with the exact answer-delivery retry command; retries reuse the recorded
  answer and request. The one-shot retry survives unrelated node facts
  while that answered question remains open. Terminal events from an
  earlier driver, while a newer live driver owns the repository, ride
  along with the next wake naming both drivers instead of waking alone;
  current-owner terminal events, or those with no live owner, still wake.
  Wake messages lead with plain `Needs you`, then `Done` when present,
  then whether the driver continues or stopped. Full original evidence,
  commands, ids, leases, repeat counters and halt hints remain under
  `Details:`, with `Next: owed status / owed why <node>` last.
- **Outcome and next step by default (SQ; the user's mixed
  audit/blocker/version-hint report and 0.14's historical owner flags).**
  Default CLI/pi status starts with merged, in-progress and needs-you
  counts plus trunk invariant health, followed by current `Needs you`,
  plain progress phases with age, and `Debt` only when present.
  Ready nodes request dispatch only when no driver owns the repository;
  current merge diagnostics are shared with brief, and stale defers do
  not remain debt. Brief starts with the same outcome/needs prefix and
  keeps its other sections. A trunk-red invariant gets exactly one
  curated `Needs you` line in default status and brief, using its trunk-red
  options without an appended command; its Debt line is unchanged
  (#1562). `owed status --full` (pi `full: true`) preserves the detailed
  rendering with IR/KR additions and historical audit lines; default
  status ends with `Details: owed status --full · owed why <node>`.
  JSON retains existing fields with additive summary data. The installed
  versus loaded version hint appears once per pi session per installed
  version, as the last tool-output line; full status and mismatch refusals
  still show it.
- **Ledger-only workflow metrics (MT; evidence for the release's
  interruption/acceptance-time goal).**
  `owed report --metrics [--since <seq|ISO>] [--until <seq|ISO>] [--json]`
  reads ledger entries and recorded plan blobs, with no extra Git-fact or
  dsa queries and no acceptance/key changes. It reports merged nodes,
  interruptions and rate, submit-to-merge median/p90/max, first-dispatch-
  to-merge median/p90, first-pass acceptance, repairs and rate, and the
  top five normalized halt reasons for each decision class. Text is one
  block of at most 20 lines; JSON includes per-merge and per-halt detail.
  Submit timing starts at the first submit of the merged attempt;
  dispatch timing includes earlier abandoned attempts. First-pass means
  merged attempt 1 without an execution or judgment block on any candidate.
  Repairs sum `max(writer submits - 1, 0)` separately across each merged
  node's attempts, excluding executor carries. `since` is exclusive and
  `until` inclusive; merges, driver halts and parent/owner answer rules
  count by their own sequence, using history through `until` for timing
  and classification (#1486). A halt is a decision when a parent/owner
  records a relevant rule/answer, risk/debt decision, abandon/hold,
  approval/evidence/owner review, or a plan change to that node's spec/deps
  before or at its ending entry; otherwise it is no-decision. The window
  ends at the node's next resume, submit, merge, abandon or any later halt,
  whoever wrote that halt. Only `parent:drive` halts count as interruptions,
  alongside parent/owner answer rules (#1488).

### Compatibility

Owed 0.14 refuses the new `refresh` ledger entry kind and observations
carrying the new `execution` field with code `version` (verified against
`v0.14.0`'s reducer). Since 0.15 executor check/invariant observations may
write `execution` even without a refresh, 0.14 and 0.15 cannot be mixed on
one ledger. Upgrade every user of that ledger — pi extension, CLI and
background drivers — together before writing new observations, and restart
existing pi sessions.

Owed 0.14 and older ignore plan `known_red` and treat the listed tests as
ordinary failures (stricter), rather than refusing this plan field (#1484).
Mixed versions may halt merges that 0.15 accepts. `drive.answer_grace_s`
requires a 0.15 plan parser; older readers reject that unknown drive key.

Histories without the new entries/fields keep their earlier replayed states
and keys, apart from the changed not-measured message and default text
renderings. Default status, brief and wakes now foreground outcomes and
next steps; use `status --full` and wake `Details:` for full evidence.
Existing JSON fields remain, with additive result/runtime metadata.

### Deferred

Automatic re-verification after a repair is planned for 0.16; merge train
#22; measuring on the merged trunk #23. None is claimed as delivered in
this release.

## 0.14.0

This release delivers the merged nodes bigdiff (BD), policy (PR), hold (AH)
and trunkred (TR). Origins: wais feedback (2026-10-12) in
`/tmp/dsa/owed-requirements.md`, the 15:5x items 1–3 and 16:4x items 4–5:
KX-DRIVING-PROFILE; R122 and ruling #3856 on LY-ROAD-K;
KX-REC-FOCUS #3917/#3925/#3926; KX-RUNTIME-GC #3896/#3919.
The parent's rulings below pin the behavior where the original asks changed.

- **Large candidates without buffered review diffs (BD;
  KX-DRIVING-PROFILE, 409 MiB evidence).** `owed submit` streams the full
  binary diff through a UTF-8 decoder into the review hash, never building
  the diff string. The patch hash stays identical to 0.13, including invalid
  UTF-8 replacement and multibyte characters split across chunks; an empty
  diff keeps its existing hash. All buffered `git()` calls bound combined
  stdout/stderr to 256 MiB by default (clamped to the runtime's string limit).
  Oversize output is refused with code `refused`, naming the Git subcommand,
  even with `allowFail`, instead of `ERR_STRING_TOO_LONG`. Other diffs,
  plan `show` and mutant `cat-file blob` reads are covered; the streamed
  review diff has no stdout buffering bound and retains bounded stderr.
  Optional top-level plan `limits: {file_mib, diff_mib}` accepts positive
  finite MiB values, including fractions. Submit inspects changed blob ids
  and sizes without reading content: `file_mib` bounds the largest changed
  candidate file and `diff_mib` their summed full blob sizes, once per
  changed path, including mode changes. Deleted files and gitlinks add zero;
  an exact limit is allowed. Exceeding a limit refuses with code `refused`,
  the limit and up to five largest changed files with sizes, recording
  nothing; the writer gets the ordinary submit refusal. Without either
  limit there is no size check. Limits enter no acceptance key, invalidate
  no existing candidate and are not rechecked at merge or carry.
- **Prospective policy and ruling re-acknowledgment (PR; R122,
  LY-ROAD-K #3856; ruling #1431).** `owed rule --prospective` (pi
  `owed_rule` field `prospective: boolean`) records `prospective: true` and
  binds only attempts dispatched after that ruling, not merely later
  submissions. Later packets and `rulings_seen` include it normally; older
  attempts keep their acknowledgment scope, halt and repair budget. Each
  unsealed writer/reviewer run of an older open attempt receives one
  informational `notify`, with no follow-up or re-ack obligation; retries
  reuse the same request while unsealed, never halting for a refused notice.
  Sealed runs receive no prospective policy on later follow-ups and are
  never relaunched for it. Removed nodes receive no prospective notices
  (#1431); the parent closes their remaining slots. `--prospective` with
  `--writer` is a usage error and records nothing; omission or false keeps
  ordinary ruling behavior. When an ordinary ruling, including `*`, leaves
  only `rulings` owed, the driver follows up with the latest reviewer or
  launches one, quoting the rulings, candidate commit and `--ack-rulings
  <seq>`. Without a review/closure-review obligation, it instead sends the
  writer one `ruling` follow-up per set and waits for resubmission of the
  same commit or a changed one, rather than a stalled-owner halt (#1431).
  Resubmit acknowledges only recorded writer ruling follow-ups, not later
  unsent rulings, prospective notices or executor carries. An unaddressable
  writer retains the normal run/send refusal route. Report "Status changes"
  omit nodes merged by the end of the window, removing merged-node ruling
  noise. Owner reviews at other ranks refuse with `owner reviews use --rank 3`.
- **Abandon without immediate re-dispatch (AH; KX-REC-FOCUS
  #3917/#3925/#3926; ruling #1403).** `owed abandon <node> --hold` (pi
  `owed_abandon` field `hold: boolean`) appends a separate entry kind
  `hold` with `{node, by, channel, abandon, reason?}` in the same ledger
  lock immediately after abandon; `hold.abandon` references the preceding
  abandon's sequence. Abandon itself has no new field. Status and why show
  `held by abandon #N`.
  A held node is not ready, the driver never dispatches it, and dispatch
  refuses with `owed resume <node>`. Resume releases it without an open
  slot using `release: "hold"`; normal readiness rules then apply. Release
  takes neither `--after` nor `--expect`; held nodes do not satisfy
  dependencies. Removing a node from the plan makes its hold moot. To
  retire a node, remove it first and then abandon its slot; use `--hold`
  while deciding. If the driver's own writer launch is stale because the
  node left the plan, was held or abandoned, it closes only its own attempt
  with no writer launch intent, without a halt or notice. Clean, unlocked,
  non-nested worktrees still at their base are removed with guarded branch
  deletion; commits or uncommitted changes keep their worktree and branch.
  Parent-dispatched slots and attempts with writer launch intent are left
  alone. From 0.14 unknown abandon fields also raise code `version` (#1403).
- **Trunk-red merge diagnostics, not writer repairs (TR; KX-RUNTIME-GC
  #3896/#3919: candidate 21/21, merge tree 18/21 and the same three failures
  on trunk; rulings #1432/#1458).** Before refusing a measured or reused
  merge-result node-check failure, `owed merge` measures that check on
  current trunk alone, under the same lease, setup and execution settings,
  with closure pinned from trunk and its own trunk check key. The executor
  records `obs.probe: "trunk"`, subject = node and commit/base = trunk;
  non-error probes on the same key and trunk commit are reused. Probes
  never satisfy or block obligations or count as decoy catches; invariants,
  red and strength checks get no probes. A failing probe classifies the
  refusal as `trunk-red` if every merge-tree failed name occurs in its
  names, or neither result has names. A passing probe or mismatched names
  keeps the ordinary refusal. The message starts `trunk-red: check:X fails
  on trunk <short> without <node> (<names>)`, identifies both observation
  sequences and says the candidate is not shown to be the cause. The
  driver halts needing the parent before attribution or a writer repair,
  including after restart. Parent options are a fixing node, a configured
  `owed sweep --commit <trunk>` for its bisect/escape proposal, or
  `owed waive <node> check:X --reason "<why the risk is acceptable>"
  --accept-risk <merge-tree obs seq>`. Classification compares check/merge
  keys, not raw base commits: unrelated trunk moves outside reads/closure
  retain the reusable failure, while a current-trunk probe decides its
  classification (#1432). Even after attribution cleared the original
  block, `accept_risk` may cite that merge-result fail only when its key
  equals the current merge key; the waiver binds that key alone (#1458).
  Other cleared/stale observations and probes remain invalid waiver risks.
  Status/why name both observations and route trunk-red to the parent,
  including a separate `mergeChecks` item in why and a parent pending item
  in status for the accepted-candidate/reused-failure path (#1458). Waiving
  that key removes the diagnostic; it does not claim a measured pass.
  Existing merge CAS and current-plan/key guards discard stale results.

### Compatibility

Use owed 0.14 for `rule.prospective`, the new `hold` entry kind,
`resume.release: "hold"`, `obs.probe` and the new cleared-merge-failure
waiver scope. Owed 0.13 refuses the new rule/observation/resume fields and
unknown `hold` kind with code `version`; it silently ignores unknown
abandon fields, which is why hold is a separate kind (#1403). From 0.14,
unknown abandon and hold fields also raise `version`.

Published 0.12 already refuses unknown ruling fields, so it also refuses
`rule.prospective` (including false) and the unknown `hold` kind with code
`version`; it does **not** silently ignore prospective policy. It ignores
unknown observation fields such as `probe`, so it cannot safely interpret
trunk probes. Pre-0.12 readers may silently ignore unknown rule/observation
fields and unknown kinds (0.11 does not interpret `hold`), rather than
provide a `version` refusal; never use them to operate a hold or probe ledger. Owed 0.13 ignores top-level plan `limits`
(as do earlier readers), so enforcing size policy requires 0.14+.

Streaming hashes preserve 0.13 patch/review identities. The other additions
change no existing acceptance keys; histories without new entries/fields
retain their 0.13 replayed states and keys. Upgrade CLI, pi extension,
drivers and remote executors together, and restart existing pi sessions.

### Deferred

Merge train #22; measure on merged trunk #23; milestone-level evidence;
periodic re-measurement of reused verdicts; worker crash not replaying
`session_start`. None is claimed as delivered in this release.

## 0.13.0

This release delivers the merged nodes lease (LE), waits (FL), repeat (RC),
answer (AN), edit (ED), sweep (SW) and quiet (QT). Origins: wais feedback in
`/tmp/dsa/owed-requirements.md` §65, including the 41h list (2026-10-11)
and the machine-lock and morning/idle observations (2026-10-12), plus
`/tmp/dsa/owed-feedback-2026-10-10.md` §39 on escapes found by accident.
Quiet comes from another owed user's feedback (2026-10-12), not wais.
The parent's rulings below pin the behavior where the original asks changed.

- **Measurements hold the machine lease (LE; wais §65 machine-lock
  observation).** Standalone attest, merge, adopt and genesis measurements
  (including init's background attest) wait under
  `pi-durable-subagents hold machine --shared` when dsa is available.
  Driver attests and in-process merges use `--no-wait`: busy means retry
  on a later pass, never halt. Merge starts only after the holder signals
  acquisition; return, failure, abort or parent death releases the holder.
  Setup, checks and invariants get `OWED_LEASED=1` to avoid nested lease
  acquisition, with isolated async contexts for parallel measurements.
  Results say `lease: machine (shared)`. The release also strengthens the
  lease test to compare non-empty check and invariant keys with and without
  the inherited marker.
- **Waiting, reports and backlog (FL; wais §65, 41h list #1/#6 and idle
  observation; ruling #1245).** An open slot with unmerged current-plan
  dependencies waits automatically: no submit/repair/ruling follow-ups,
  measurement or missing-candidate halt, while questions remain visible.
  Adding dependencies to a running writer sends one durable `notify`
  (not steer) per plan entry; when the waits end, the existing rebase and
  follow-up route catches the slot up to trunk. `owed resume <node>
  --after a,b` waits for all named nodes and composes with implicit waits;
  tools accept a string or string array. `owed resume <node> --expect
  report` asks for findings, not a candidate. A successful sealed report
  without a new submit wakes the parent with at most 40 lines/4000 chars,
  records no acceptance verdict and parks the node as `reported (resume
  #n)` until a relevant parent act. Failed/interrupted runs retain their
  recovery routes; a later submit is handled normally. `later: true`
  parks backlog nodes until removed. Idle wakes list ready/open/waiting/
  reported/later counts and repeat every `drive.idle_rewake_min` minutes
  (default 60, 0 off). Existing invariant-id entry points accept `inv:<id>`;
  `why` can show a trunk invariant, and unknown ids list valid spellings.
- **Repeated measurements and explicit counts (RC; wais §65, 41h list
  #2/#3 and flaky invariants; rulings #1243, #1247/#1274).** Checks and
  invariants accept `repeat: {runs: N, need: K}` with
  `1 <= K <= N <= 9` (`need` defaults to N). Commands run sequentially
  in one prepared tree and stop when K passes are reached or unreachable;
  errors stop as errors, not failed votes. Repeat is part of the
  check/invariant key (#1243), forbidden on red or mutants checks, and
  honored for merge-time invariants. Observations retain each run's verdict,
  exit, counts, duration and log digest; disagreement is descriptive
  `noisy (2/3 passed)`, not a separate block. The last valid column-0 line
  `owed-counts {"pass":2,"fail":1,"failed":["latency gate"]}` wins over
  other count formats; pass/fail and optional skip are non-negative integers.
  Indented lines and `# ` comments are silent non-protocol text (#1274);
  malformed protocol lines are ignored and noted. Only the `owed` format's
  fail > 0 fails a non-red run even on exit 0 (#1247); other formats keep
  their exit semantics. RC3 keeps up to 50 failing names from owed/TAP/cargo
  and leads failure notes, `why`, halts and repairs with those names, then
  a tail of at most 15 lines. Reused failing merge observations retain
  names and tail, and failed red checks (including `red_expect` mismatch)
  get the same names-first note (#1274).
- **Answer in one act (AN; wais §65 morning observation).** Parent/owner
  `owed answer <node> [--qid Q] [--rid R] "<text>"` discovers one open
  writer/reviewer question, refusing ambiguity or absence with the open
  question list. It records one node-scoped rule with `writer: false` and
  `answer: {rid, qid, rev}`, then delivers dsa kind `answer` with request
  `owed-answer-<seq>`. Explicit rid/qid retries with the same text reuse
  the rule and request, even after the question closes; changed text refuses.
  Delivery failure leaves the rule and reports its seq and exact retry
  command. Answer delivery is target-specific: the answer is not re-delivered
  as a writer ruling to the rid it answered, nor does it hide earlier
  undelivered rulings. Other runs receive it normally. Acknowledgment scope
  is unchanged: reviewers still acknowledge all in-scope rulings, including
  answers; reviewer acknowledgment follow-ups retain that complete context.
- **Atomic plan edits (ED; wais §65, 41h list #4).**
  `owed edit <node> --set path=yaml ... [--unset path ...] [--node-new]
  [--rule TEXT [--writer]] [--resume [--after a,b] [--expect report]]
  --note WHY [--dry-run] [--plan FILE]` edits node fields, checks and
  drive overrides; `owed edit --invariant ID --set field=yaml --note WHY`
  edits an invariant. YAML comments are kept; bytes outside the target map
  stay unchanged when safe, with whole-document serialization for flow
  containers or anchors/aliases. One ledger lock guards plan/carries,
  optional ruling and optional resume, using existing authority and downgrade
  rules. Refusals leave the ledger and file unchanged; file replacement
  follows the append, and a replacement failure reports the recorded seqs
  and recovery file. Dry run prints diff/downgrades without writing.
  `owed amend` remains available.
- **Advisory sweeps and unguarded paths (SW; wais feedback §39; ruling
  #1331).** Top-level `sweep: {run, timeout_s, reads?}` enables
  `owed sweep [--commit C]` on a fresh detached trunk tree, with setup/exec
  and the shared lease. Completed sweeps record commit, definition key,
  verdict, counts, log and failed names, never acceptance observations.
  A staying idle driver schedules sweep/bisect in the background, at most
  once per trunk commit with completed sweep entries. Any ready driver work
  preempts it and proceeds in the same pass without waiting (#1331);
  process cleanup is bounded, releases the lease, and records `sweep
  aborted: preempted` without partial verdicts, so the next idle period
  can retry. A head failure is rerun once: a pass reports `flaky at head`,
  without localization. A green ancestor with a different or missing
  definition key is re-established under the current sweep/setup/exec
  definition before bisect. First-parent owed merges are searched, and
  the failing merge and its actual first parent are confirmed; disagreement
  or exhausted confirmation budget reports `inconsistent (flaky)` with
  verdicts and no culprit/proposal. Each commit runs at most twice and
  localization uses at most `ceil(log2(n)) + 4` measurements (#1331).
  Only a confirmed boundary proposes the exact `owed escape` command and
  tests to promote to an invariant; no escape is recorded and no merge is
  gated. Merge output, driver reports and `brief`'s last 10 merges list
  touched paths outside invariant reads, grouped by their parent directories
  with root files literal and redundant descendant globs removed.
- **Quiet by default (QT; another owed user's feedback, 2026-10-12;
  ruling #1378).** Rendered halts say `needs the parent (the main agent
  acts; owed lists the command)` instead of `needs human`; owner wording
  stays unchanged, and manual evidence offers the plan's role or
  `--as owner:pi`. Only repo-scoped drift wakes are revalidated at delivery:
  matching trunk/ledger commits or an advanced ledger trunk seq drop the
  obsolete wake; failed reads keep it. Unscoped legacy lines, including
  a node named `trunk`, are delivered rather than dropped as drift (#1378);
  ordinary node/question revalidation still applies. Status/brief show no
  drift when trunk matches. The existing "When to use owed" guidance keeps
  small low-risk fixes direct with one parent adoption, reserving reviewed
  nodes/red tests for consequential risks and multi-agent waves.

### Compatibility

Use owed 0.13 for ledgers with repeat-keyed observations, answer rulings,
sweep entries, or edits using the new 0.13 plan/resume shapes. ED itself
adds no entry kind or field: plain plan/carry/rule/resume edits retain their
existing schemas. Published 0.12 silently drops plan `repeat` and replays
its observations by aggregate verdict only, ignoring run/noise/name metadata;
it cannot be retrofitted to refuse them, so do not operate a repeat ledger
with 0.12 (#1243). From 0.13, unknown top-level observation fields raise code
`version` with upgrade/restart guidance. 0.12 refuses new resume `after`
arrays or `expect` as an ordinary refusal, not `version` (#1245); from 0.13,
unknown resume fields/expect values/incompatible after shapes use `version`.
Older owed refuses answer ruling fields, sweep entry kinds and sends of kind
`notify` or reason `waiting`/`report` with code `version`.

The machine lease, its inherited `OWED_LEASED=1` marker and plan `lease`
are not in any check/invariant key and introduce no ledger field. Missing
dsa or an inherited marker runs directly; CLI `--no-lease`, tool
`lease: false` and plan `lease: false` disable acquisition (default on).
Standalone measurements wait; driver measurements retry busy on a later
pass. Older owed replays these entries but does not enforce the new lease
semantics. Halt wording is rendering-only: ledger `needs: 'human'` is
unchanged. Upgrade CLI, pi extension and remote executors together, and
restart existing pi sessions.

### Deferred

Merge train #22; measure on merged trunk #23; milestone-level evidence/debt
(41h list #5); periodic re-measurement of reused invariant verdicts (wais
feedback §39.2); worker crash not replaying `session_start`; 0.10 carry/amend
nits. None is claimed as delivered in this release.

## 0.12.0

The wais pi-zip performance report (N4) showed ledger replay freezing pi's
UI even after 0.10's reducer speed-up. Wais feedback §38 in
`/tmp/dsa/owed-feedback-2026-10-10.md` added the in-memory extension version
skew and the low-disk shared-build-dir pattern. This release delivers G1
snapshot replay, G2 tool workers and G3's non-blocking 0.11 review nits,
with the parent's rulings #1176, #1198 and #1200.

- **Resumable replay and snapshots (G1; pi-zip N4).** `reduce` remains
  the full-replay reference; `reduceFrom` folds new entries onto a private
  copy of the state and its replay metadata, preserving internal sharing.
  State, metadata, views and draft-validation decisions match full replay.
  Loads use a per-ledger in-process memo, then `snapshot/state.v8`, when
  the cached seq/hash matches the verified chain; otherwise they replay
  from scratch. Results never alias, and draft simulations fold only the
  added entries. Snapshots record the format, owed version, seq, hash and
  payload digest, and are written atomically after at least 256 further
  entries or when none exists. Missing, corrupt or mismatching snapshots
  are cache misses, never operation failures. `owed verify` always uses
  full replay; a matching-chain snapshot that differs is deleted and
  reported as `snapshotMismatch: <seq>` in text and JSON. Per ruling #1200,
  deletion also invalidates the memo with an epoch and a publication queue:
  a load started before invalidation cannot republish stale state. Old
  plans are loaded lazily, but missing/unreadable plan errors are never
  swallowed by views. Unknown entry kinds, every closed enum value and
  unknown ruling flags refuse replay with code `version`, an upgrade/restart
  message and CLI exit 1 (including `verify`); other invalid entries keep
  their errors.

  Measured on ipc against 0.11.0, with warm disk snapshots:

  | Ledger / operation | 0.11.0 | 0.12.0 |
  |--------------------|--------|--------|
  | Wais, 2229 entries, `status` | about 1.04 s | 293 ms (about 28%) |
  | Synthetic, 10000 entries / 200 nodes, `status` | 1.53 s | 378 ms |

  Cold replay stays within +10% of 0.11.0; an in-process load after
  appending one entry spends <= 50 ms replaying. Interleaved confirmation
  runs measured warm wais at 293/1083 ms (27.1%) and synthetic at
  378/1612 ms, with cold overhead +6.3% and +6.4%, respectively.
- **Tools off pi's main thread (G2; pi-zip N4, wais §38).** Extension
  loading eagerly starts one shared `worker_threads` worker per pi
  process. Tool calls, `/owed`, drive-watch revalidation and background
  genesis attests run there; schemas, owner dialogs, rendering and watcher
  timers stay on pi's thread. Structured-clone RPC preserves OwedError
  codes/messages and forwards aborts to existing abortable operations.
  Owner actions retain preview/dialog/commit order and changed-candidate
  refusal. A crash fails outstanding calls without replaying them; the
  next call replaces the worker only if the installed version still
  matches the session's loaded version. Tools append
  `owed <installed> is installed but this pi session loaded <loaded>: restart pi to use it.`
  on version skew or a `version` error. Both compiled `dist/ext-worker.js`
  and git-install source loading work without optional pi peers. On a
  2201-entry ledger, tool calls in the worker keep pi responsive: about
  0.5 ms main-thread stall versus 115-179 ms in-process.
- **0.11 review fixes (G3).** `stale` is a refusal (exit 1), not an
  internal error (exit 3), in the CLI and driver; the CLI's `version` exit
  mapping comes from G1, as ruling #1198 assigns. A restarted driver
  recovers follow-up generations per run, not per node: it asks dsa for
  the latest applied follow-up's original reply using the same request id
  and stored bytes, cached once per send id per process. Another reviewer's
  later verdict cannot suppress recovery or cause a premature
  `review-missing` halt (#1198). A recorded send's re-send is refused as
  stale if a later plan removed or changed the node, even though plan
  entries name no node. Environment classification filters spec-reporter
  titles (`✔`, `✖`, `▶`) as well as TAP/cargo titles, and its error note
  shows the filtered matching lines, not the unfiltered tail. Ruling
  re-sends after resume include the same active/flaky block lines as the
  original follow-up. A removed node's open slot counts toward `drive.max`
  until abandoned; ruling #1176 lets `owed abandon <node>` close that slot
  without re-adding the node, changing no other removed-node operation.
  Failed-send text names the node as a word. `reuseHooks.beforeTouch`
  remains a documented test-only seam. The skill documents wais's
  low-disk alternative to per-tree build dirs: shared dirs serialized by
  `flock`, a per-dir last-checkout marker and tracked-file touch when the
  builder changes, leaving `exec.touch` at its default so keys stay stable.

**Compatibility.** Files under the ledger dir's `snapshot/` are private,
derived caches, safe to delete; deletion only costs a full replay. 0.12
adds no entry field or send reason, so its ledgers remain replayable by
0.11 unless they contain an `abandon` of a node the plan removed: owed
< 0.12 rejects that entry (#1176). The existing pre-0.11 limits for
`send` reason `verdict` and `writer` rulings still apply. The explicit
newer-entry refusal with code `version` (exit 1) exists only from 0.12 on;
earlier owed does not provide that forward-compatibility error. Upgrade
the CLI, pi extension and remote executors together, and restart existing
pi sessions to load the installed version.

**Deferred.** #22 merge train; #23 measure on the merged trunk; parent
answers recorded automatically; the carry and amend nits from 0.10.
Tool-worker review #1182: a crashed worker does not replay `session_start`,
so drive-follower recovery waits for the next session start and in-flight
background genesis attests are lost, not automatically resumed; non-OwedError
tool exceptions become `Refused` results with code `internal` rather than
being thrown to pi; a refused replacement repeats the restart line; a
same-process `/reload` after upgrading refuses extension loading instead
of retaining old tools (restart pi); the in-process non-blocking test's
margin above 100 ms is modest. Snapshot review #1218 and nits review #1206
reported no further unfixed product nits after rulings #1200 and #1198.

## 0.11.0

The wais feedback #12 and #27-#36 reported halts and wrong verdicts that
owed caused itself. The parent's diagnosis changed two of the asks. #35 is
a driver race, not reviewers forgetting: in all three `review-missing`
halts the review was recorded 33-60 s before the halt, by a run that
recorded and sealed between the pass's state load and its describe. #29 is
not a semantic merge conflict but nondeterminism: the attribution rerun
of the same merge tree passed, because reused trees linked stale build
artifacts (#32b), fixed by F6 plus a waiver that reaches merge keys (F3).

- **Fresh act (F1; wais #35).** Every `launch`, `send`, `rebase` and
  `halt` the driver records as the result of `decide` passes `since: S`,
  the seq of the state the pass loaded. Under the ledger lock, an entry
  after S that names the node (its `node` or `subject`, a ruling covering
  it or `*`, or any `plan` entry) and is not by `parent:drive` makes the op
  record nothing and throw `OwedError` code `stale`; a send then makes no
  dsa call. The driver reports outcome `stale` (no halt, no wake) and the
  next pass decides again. Rows 13-14: a sealed reviewer run whose
  obligations still await gets ONE follow-up with the new reason
  `verdict`, naming the candidate, the awaiting obligations and the exact
  `owed review` command; `review-missing` halts only after it sealed again
  without recording (at once for a `rejected` or `pruned` run). The asking
  notify ends with a hint to record a contract or scope answer with
  `owed rule --nodes <node> "<decision>"`.
- **Environment failures wait (F2; wais #36, #12).** Per ruling #1094, a
  measurement is `error` with a note starting `environment: ` only when it
  failed before its command ran (tree preparation, spawn, `setup`), or when
  it exited non-zero with no failing test counted and `ENOSPC`, `No space
  left on device` or `Disk quota exceeded` appears in the last 50 output
  lines after dropping TAP test points, subtest titles and cargo test
  lines (a test name is never evidence). The driver does not count these
  toward "attest recorded no verdict twice"; the node's next attest backs
  off 1, 2, 5, 10, then 30 min (a resume restarts the streak), with one
  notify per streak. `drive.min_free_mb` (default 2048, 0 disables) gates
  starting measurements on free space in the git common dir and the temp
  dir (`disk low: …`, once per change). A disk-full error escaping a pass
  logs a waking `disk-full` event, sleeps 60 s and continues. `owed gc`
  also removes free node-check trees whose check belongs only to merged or
  abandoned nodes.
- **Waiver reaches merge keys (F3; wais #34, #29, #12).** The blocks an
  owner waiver cites in `accept_risk` are cleared whatever their key,
  merge keys included; every cited seq must be an active or flaky exec or
  judgment block of the waiver's node and obligation. A merge-result fail
  cited this way no longer counts on its key, so a pass on that key (the
  attribution rerun) satisfies `owed merge`. The waiver's own key binding
  is unchanged, and the confirmation and result text say the obligation is
  no longer measured on the waived key.
- **Removed nodes and routing fixes (F4; wais #27, #31, #33c, #34).** A
  node absent from the current plan and not merged has phase `removed`:
  never ready, dispatched or selected by the driver. `owed resume` refuses
  when an active needs-parent review block awaits a ruling, naming
  `owed rule --nodes <node> "<decision>"`. A failed send's report names
  node, kind, reason and target. The `min_tests` loop warning skips
  `cargo test` commands. A timed-out describe is retried once per pass, and
  a node in a `resume --after` wait gets no `describe-failed` notify.
- **Writer rulings and waits during merges (F5; wais #33a, #33b).**
  `owed rule --writer` (pi `owed_rule` `writer: true`) records `writer:
  true`; recorded after a named node's open submit it invalidates that
  candidate (a new submit is needed, the same commit is fine), and the
  driver delivers it as a `ruling` follow-up to a sealed writer or a steer
  to a running one. Reviewers still acknowledge it; `*` rulings and rulings
  without `--writer` are unchanged. When a merge measuring at the time of
  a `resume --after` ends refused, the driver reports `waiting` and records
  no halt.
- **Reused trees never link stale artifacts (F6; wais #32b).**
  `exec.touch: reset | always | never` (default `reset`, reused trees only):
  `reset` sets every tracked file's mtime to now when a reused tree changes
  commit, `always` before every reused measurement, `never` keeps Git's
  behavior. An explicitly set `touch` is part of the exec key (owner act,
  fresh evidence). Every setup, wrapper and measurement process gets
  `OWED_TREE` = the absolute tree path, so checks can keep per-tree build
  dirs (`export CARGO_TARGET_DIR="$OWED_TREE/../target-$(basename
  "$OWED_TREE")"`). Per ruling #1095, a newly recorded plan (`init`,
  `plan`, `amend`) may not set `OWED_TREE` in `exec.env` (replay does not
  check it; owed's value overrides it at run time), and reused-tree
  preparation is all-or-nothing: a marker of the last complete preparation
  is removed before checkout and written after touch, so any failed step
  is redone in full on the next lease.

**Compatibility.** A ledger with a `send` of reason `verdict` or a plan
setting `exec.touch` needs owed >= 0.11.0 to verify and replay; 0.10
replays a `writer` ruling as an ordinary one and has no `removed` phase.
Upgrade the CLI, the pi extension and remote executors together. Plans
without `touch` keep byte-identical keys. Checks that relied on a shared
`CARGO_TARGET_DIR` across reused trees should move to per-tree dirs or
`touch: always`.

**Deferred.** #22 merge train; #23 measure on the merged trunk; parent
answers recorded automatically (F1.3 is the interim); the carry and amend
nits from 0.10; moving pi tools off pi's main thread; a driver restart
loses cached run generations; `stale` is reported as an internal error
(exit 3) by cli/drive-run; a send decided before a plan entry removes its
node is not refused as stale; spec-reporter test titles are not filtered
by the environment classifier.

## 0.10.0

The wais feedback #24-#26 reported parent round trips that owed caused
itself: plan v69 (wais #1373) changed only a check definition of one node,
which invalidated its candidate; the driver then sent a `rebase` follow-up
(#1375) and the writer resubmitted the same commit at the same base
(#1378). A moving trunk failed dispatch and plan CAS, and a writes question
cost a hand-edited plan plus a separate ruling. Separately the pi-zip
agent's profile showed every op replaying the whole ledger: 9.6-13.5 s per
op on the wais ledger (1558-1601 entries, 85-87 nodes), with the pi session
UI frozen because pi tools run on its main thread. N1 carries candidates
across measurement-only plan changes, N2 retries CAS under a moving trunk,
N3 adds `owed amend`, and N4 makes replay fast.

- **Carry (N1; wais #24).** When a plan change invalidates a node's open
  candidate and the node spec differs only in `checks`, `writes`, `type`
  and `drive` (plan-wide `setup`, `exec` and `closure` changes do not
  matter), the same `owed plan` call appends, in the same ledger lock and
  right after the plan entry, a carry submit: a `submit` by `executor:owed`
  with `carry: <seq>` of the carried submit, for the same commit at the
  same slot base, its facts recomputed under the new plan. Evidence on
  unchanged keys still counts; the next attest measures the changed keys.
  The candidate stays the writer's commit, so writer-only rules (no
  self-review, decoys) treat it like the original. Any other node field
  change (`brief`, `deps`, `review`, `title`, `approve`, `evidence`, ...)
  never carries. Validation accepts an executor submit only with `carry`
  naming the latest submit of the open attempt, with its commit and base,
  an open slot, no current candidate and an unchanged slot base; a writer
  submit never has `carry`. `owed plan` prints `Carried <node>: ...` per
  carried node; a carry whose facts cannot be computed or that validation
  would refuse is left out (the candidate stays invalidated, as in 0.9)
  and reported as `Not carried <node>: <reason>; the writer submits again`
  (JSON `notCarried`). `owed why` and status show `candidate #C carried by
  plan #P from submit #S`. Driver row 8 label fix (#1375): without a
  current candidate, the `rebase` follow-up goes out only when the slot
  has a rebase and no submit of the attempt followed it; when a later plan
  entry invalidated the latest submit, the `submit` follow-up names it:
  "plan #P changed this node's spec (<fields>); resubmit (re-run checks if
  needed, then `owed submit <node>`)".
- **CAS retry (N2; wais #25, #24 parts 2-3).** A dispatch rollback deletes
  its new branch with `git update-ref -d refs/heads/<branch> <base>`, a
  compare-and-delete in one Git transaction, whatever the main worktree's
  HEAD (the "not fully merged" leftover of wais #25 is gone). A ref that
  moved, or a branch still checked out in a worktree, is kept and reported
  under the existing `git branch -d` rollback label. `owed dispatch` and
  `owed plan` retry a CAS refusal, up to 3 attempts in total, while the
  ledger's plan sha is unchanged; each attempt reads fresh state and
  dispatch completes its rollback first (a failed rollback is returned at
  once). A changed plan sha, or the third failure, returns the refusal with
  its error class and exit code; other failures are not retried. The
  downgrade hint for a changed check definition names the changed fields
  among `run`, `timeout_s`, `reads`, `tests`, `red_expect` and suggests
  adding the new command as a new check id; detection is unchanged. On
  `owed plan`, the check-less and loop warnings skip nodes merged in the
  ledger; `owed init` warnings are unchanged.
- **`owed amend` (N3; wais #26).** `owed amend <node> --writes
  +<path>[,+<path>...] --note "<limit>" [--plan <file>]` (pi `owed_amend`
  `{node, writes, note, plan?, as?, cwd?}`) widens one node's writes. The
  plan file is `--plan`, else the latest plan entry's `path`. The edit
  splices only the node's `writes` list source (via the `yaml` Document
  API) and keeps every other byte; the result must parse to the current
  plan with only that node's writes widened. It refuses a file whose
  normalized plan sha differs from the ledger's (`plan file has unrecorded
  edits`; a comment-only edit does not count), an unknown or merged node,
  an empty path list, a path without `+`, an empty note, no plan path
  without `--plan`, and `nothing to amend` when every path is already
  there; removal is not offered. In one
  lock it appends the plan entry exactly as `owed plan` would (same
  authority: a widening is a downgrade, so the owner or an `allow` rule),
  any N1 carry submits, and a `rule` by the same principal for `[<node>]`:
  `writes of <node> widened by plan #P: +<paths>. Limit: <note>`, which
  reaches the writer through the ruling path and reviewers acknowledge. It
  retries CAS like `owed plan`, re-reading file and ledger per attempt. A
  refusal records nothing and leaves the file unchanged.
- **Replay speed (N4; pi-zip profile).** The fold keeps per-node indexes
  (reviews, evidence, waivers, observations by item, launches, entries by
  seq), recomputes derived fields only for the nodes an entry can change,
  and computes `dependents` once per plan instead of an O(N^3) DFS per
  entry. A differential test (test/perf.test.ts) compares State, queries,
  views and `validateDraft` decisions with a frozen copy of the previous
  reducer at every k-th prefix of fuzz, synthetic and real ledgers.
  Measured on ipc with a copy of the wais ledger (1601 entries, 87 nodes,
  87 plans, 15.5 MB of YAML) and a git repo, full `owed status` path:

  | Case                            | before          | 0.10.0          |
  |---------------------------------|-----------------|-----------------|
  | `status`, cold, warm plan cache | 13.5 s / 335 MB | ~0.62 s/~195 MB |
  | `status`, hot (same process)    | not measured    | ~0.40 s         |
  | First run (fills the cache)     | 13.5 s          | 2.7 s           |
  | Synthetic, 9917 entries         | not measured    | 1.2 s           |

  Parsed plans are cached in process and persistently in `<owed
  dir>/cache/plans/<blob sha>.json` as `{v, sha, plan}`, with `v` = cache
  format + owed version, written atomically (temp file, rename) after a
  successful YAML parse. Any read error, invalid JSON, other `v` or other
  `sha` is a miss and the YAML is parsed again; the cache never fails an
  op. `owed verify` never uses it for replay: it parses every blob from
  YAML and reads each entry raw. An entry of another `v` is rewritten
  silently; one of this `v` whose `sha` or plan differs, or that cannot be
  read or parsed, is reported in `cacheMismatch` (not a verify failure)
  and rewritten. `owed gc` (also `--dry-run`) removes entries whose sha no
  longer appears in a genesis or plan entry, and temp files older than
  60 s; nothing is recorded in the ledger. Deleting the directory is safe.

**Compatibility.** A ledger containing a carry submit needs owed >= 0.10.0
to verify and replay: 0.9 refuses a submit whose `by` is not the slot
writer. Upgrade the CLI, the pi extension and remote executors together.
The plan cache version includes the owed version, so the first run after
the upgrade parses every plan again and refills the cache.

**Deferred.** The formal model does not cover carry (nor resume,
superseded blocks, parallel measurement or reused trees). Carry nits
(review #983, 23:5x): replay does not re-check that a carry submit directly
follows its plan entry and that the spec change was carryable (only ops
writes executor submits, and any local process can already append executor
entries); carry after abandon or re-dispatch, carry of a carry and carry
during a merge measurement are covered by review reading, not tests. Amend
nits (00:4x): in a CRLF file, inserted block-list lines get LF endings; a
flow list with a comment right before `]` is refused as an internal error
instead of a usage error; a node with no `writes` gets the whole file
re-emitted. A verify cache mismatch is shown only in JSON. Moving pi tools
off pi's main thread (to a worker or child process). Still open from
0.9.0: per-check "measure on the candidate merged with the current trunk"
(#23); reading dsa 1.0.34 `delivery: "forwarded"` directly; review #950
nit: two reclaimers that both remove the same dead-pid token older than
1 h can, in a narrow window, end with two holders of one reuse tree; wais
#22 parts 1-2, a merge train. Still open from 0.8.0: `error_expect` for
environment-precondition failures (#12); per-tier model routing (#11); a
plan warning for unknown node keys; attest-busy nits (a dispatch whose
ledger-lock timeout is followed by a failed rollback still exits 75
`retry`; `--json=x` gets no JSON error line); the SIGKILL limit (checks of
a SIGKILLed attest keep running, unrecorded, until they exit); K review
nits (parallel node attests each measure a pending genesis invariant;
stale attest locks with a reused pid read as busy indefinitely; the `hold`
comment in `src/dsa.ts`; the `--json` loop exit record maps `busy` to code
3; merge's abort path keeps the strict whole-plan stability rule; merge
recomputes facts under the ledger lock when the plan changed; merge's
branch for a node that left the plan is unreachable; the invalidation
refusal says `its spec changed` also for `setup`, `exec` or `closure`
changes; a waiver of an obligation the candidate lacks prints an empty
key; the threshold hint reads observations across attempts; the
node-models sha test recomputes the formula; a merge-cas test title);
without dsa, an attest exiting 75 on a lock timeout is logged as `machine
lease refused`; a busy node logs a `started` and a busy line per timed
pass; whether a rejected ruling send survives a dsa `prune` was not
verified. Still open from 0.6.1: the writes hint lists node ids verbatim
as globs and grants every listed node the union of the new prefixes; a
concurrent dispatch can make a rollback report `rollback failed: directory
cleanup`; a rollback that wraps a non-OwedError drops its stack; pi
revalidation replays the whole ledger once per delivery attempt, and a
failed delivery's dropped wakes are already marked resolved; a staying
driver polls neither dsa events nor trunk drift while it waits; binding a
reviewer's identity to its dsa call; rulings that uphold or overrule a
named block. Still open from 0.6.0: a follow-up dsa retires because the
call sealed before delivery ends in a misleading `finished repair
follow-up without submitting` halt (awaits dsa §49); M4 and M6 of
`owed05-big.sh` remain within 9% of the 22M-state cap. A new candidate
that changes the flaky test itself does not clear the block.

## 0.9.0

A wais merge took 13.3 min (feedback #23): the sum of its merge-tree checks
run one after another (node checks 47+46+11 s, invariants 36, 86, 318, 16,
103 and 83 s). Each run also measured in a fresh /tmp/owed-run-*/tree path;
cargo fingerprints include that path and every file mtime was new, so every
run rebuilt from scratch and incremental builds never helped. M1 measures a
merge's jobs in parallel, M2 reuses measurement trees, and M3 documents both.

- **Parallel merge-tree measurement (M1; wais #23).** The new plan field
  `exec.parallel` (integer >= 1, default 1) is the number of jobs one `owed
  merge` measures at once: its genesis/invariant jobs and its merge-result
  jobs share one queue started in job order. The same applies to `owed
  adopt` and to the genesis attest (`init`, `attest --genesis`). Node
  attests stay serial, because the driver already runs attests of different
  nodes in parallel. Observations enter the ledger in job order whatever
  order the jobs finish in; with `parallel: 1` behavior is exactly that of
  0.8. An abort (D16) kills every running job and starts no further one.
  Merge and adopt keep the observations of the jobs that completed before
  the abort, through `abortWith` as before; the kept set is in job order
  but need not be a prefix of the job list. The genesis attest records
  each observation once its predecessors are recorded, also after an
  abort; a failure to record one starts no further job, waits for the
  running ones and then fails. A job that throws likewise stops new starts.
- **Reused measurement trees (M2; wais #23).** The new plan field `exec.trees`
  is `fresh` (default: a new temporary worktree per run, removed afterwards) or
  `reuse`. With `reuse`, check, red, strength and invariant runs use a stable
  detached worktree `<git common dir>/owed/trees/<kind>-<check id>-<k>`
  (`<kind>` is inv, check, red or strength; an id that is not path-safe becomes
  `h` + 16 hex of its sha256), with `<k>` the lowest index whose lease is free.
  The lease is `<tree>.lock` holding the pid, taken atomically by writing the
  pid to a unique temporary file and link()ing it to the lock path, so a lock
  file is never empty. A lock whose content X is dead (a dead pid, or empty or
  unparsable and older than 60 s) is reclaimed under the token
  `<tree>.lock.dead-<X>`, created with O_EXCL: the holder re-reads the lock,
  unlinks it only if it still holds X, tries the normal take once (moving to the
  next k if it loses) and unlinks the token; a reclaimer that cannot create the
  token does nothing for that k. Concurrent measurements of one check therefore
  get different trees, and a stale lock ends with exactly one holder. Taking a
  lease also removes that lock's temporary files older than 60 s and dead-pid
  tokens older than 1 h. A reused tree is prepared with `git checkout --detach
  --force <commit>` and `git clean -ffdx`; then each gitlink (submodule)
  directory of the commit is emptied inside that tree, as a fresh `git worktree
  add` tree leaves it. No `git submodule` command runs and no config or modules
  directory changes. The overlays follow as before, so the content equals a
  fresh tree. What survives is the path and the mtimes of files the checkout did
  not change: a build cache outside the tree (a shared `CARGO_TARGET_DIR`)
  builds incrementally; an ignored `target/` inside the tree does not survive. A
  missing or broken tree is recreated; a failure to prepare one falls back to a
  fresh tree with a one-line note in the observation log and never fails the
  measurement. The end of a run releases the lease and keeps the tree; each
  strength mutant prepares the tree again. Reuse trees are not slots: gc's slot
  handling, dispatch, the D19 trunk-worktree report and the slot reports ignore
  them. `owed gc` removes those whose lease is free when the plan no longer sets
  `trees: reuse` or their check id is gone (listed as `trees`, held ones as
  `treesKept`; `--dry-run` only reports), plus lock temporary files older than
  60 s and reclaim tokens older than 1 h. It appends no ledger entry for them.
- **Scheduling fields are not keys.** `exec.parallel` and `exec.trees` are
  not part of `execKey`, any check key or the L2 check definition, and the
  exec comparison (`execChanged`, now over `execKey`) looks at `env` and
  `wrap` only. Changing them supersedes nothing, invalidates no candidate,
  re-measures nothing, records no `exec changed` downgrade and needs no
  owner authority; changing `env` or `wrap` works as before. An `exec:`
  block holding only `parallel` and/or `trees` is valid; parsed plans keep
  each field only when it is set. The `Exec:` view line shows them.
- **Docs (M3).** SPEC (§3.2, §4.1, §7 step 8, new §7.12, gc), README,
  SKILL and MODULES describe both fields and the measurement environment.
  Advice: parallel cargo builds sharing one `CARGO_TARGET_DIR` serialize on
  cargo's build-directory lock, so give heavy invariants separate target
  dirs or accept that they wait for each other.

**Compatibility.** 0.8.x parses `exec.parallel` and `exec.trees` as unknown
exec keys and refuses the plan (`exec.<key>: unknown key`), so upgrade the
CLI, the pi extension and remote executors together before setting them.
Ledger entries and keys are unchanged; plans without the new fields behave
exactly as in 0.8.0. A ledger whose plan sets them needs owed >= 0.9.0 to
replay.

**Deferred.** Per-check "measure on the candidate merged with the current
trunk" (#23; wais: low priority). Reading dsa 1.0.34 `delivery:
"forwarded"` directly. Review #950 nit: two reclaimers that both remove the
same dead-pid token older than 1 h can, in a narrow window, end with two
holders of one reuse tree (rename the old token to a unique name before
removing it). Still open from 0.8.0: `error_expect` for
environment-precondition failures (#12): a check reports these today by
exiting 126/127 without a count, which records `error`, not a failure.
Per-tier model routing (#11 asked for a tier or risk mapping; routing
remains per node). A plan warning for unknown node keys (typos like
`drvie:` are ignored; refusing them would change which existing plans are
accepted). Attest-busy nits: a dispatch whose ledger-lock timeout is
followed by a failed rollback still exits 75 `retry` though leftovers may
block a retry; `--json=x` gets no JSON error line (the CLI matches `--json`
only). The SIGKILL limit: a stop at once SIGKILLs the dsa invocations' and
attest children's process groups only; the checks an attest runs have
process groups of their own, so a check whose attest was SIGKILLed before
ending it keeps running, unrecorded, until it exits. K review nits not
fixed: with per-node locks, parallel node attests each measure a pending
genesis invariant (correct under D24, more CPU); lock owners record no
process start time, so a stale attest lock whose pid was reused reads as
busy indefinitely, and the driver retries without a halt; the `hold`
comment in `src/dsa.ts` still says owed exits only 0..3; the driver's
`--json` loop exit record maps a `busy` error to code 3; merge's abort path
(`abortWith`) keeps the strict whole-plan stability rule, so an abort after
any plan update discards the measurements; merge recomputes facts with git
under the ledger lock when the plan changed; merge's branch for a node that
left the plan is unreachable (removing the node invalidates its candidate
first); the invalidation refusal says `its spec changed` also for `setup`,
`exec` or `closure` changes; a waiver of an obligation the candidate does
not have prints an empty key (unknown obligations are not refused, as
before); the threshold hint reads the node's observations across attempts,
so a new attempt's first under-count may hint at once; the node-models sha
test recomputes the plan sha formula instead of going through `owed plan`,
and a merge-cas test title says `without remeasuring` but counts only the
invariant. Without dsa, an owed attest that exits 75 on a ledger-lock
timeout is logged as `machine lease refused` (busyDetail); the behavior is
right. While a node stays busy the log gets a `started` and a busy line per
timed pass (0.6.x printed one busy line per busy period). A rejected ruling
send is recognized after a driver restart through dsa's request record;
whether that survives a dsa `prune` was not verified. Still open from
0.6.1: the writes hint lists node ids verbatim as globs and grants every
listed node the union of the new prefixes; a concurrent dispatch can make a
rollback report `rollback failed: directory cleanup`; a rollback that wraps
a non-OwedError drops its stack and the pi extension returns it as a tool
error; pi revalidation replays the whole ledger once per delivery attempt,
and a failed delivery's dropped wakes are already marked resolved; a
staying driver polls neither dsa events nor trunk drift while it waits.
Still open from 0.6.0: a follow-up dsa retires because the call sealed
before delivery still ends in a misleading `finished repair follow-up
without submitting` halt (awaits dsa §49); M4 and M6 of `owed05-big.sh`
remain within 9% of the 22M-state cap. The 0.6.1 candidates stay open:
bind a reviewer's identity to its dsa call; rulings that uphold or overrule
a named block. The formal model does not cover resume, superseded blocks,
parallel measurement or reused trees. A new candidate that changes the
flaky test itself does not clear the block; whether it should is deferred.
Wais #22 parts 1-2: a merge train is deferred.

## 0.8.0

The wais run of 2026-10-10 reported recovery, check-definition and ruling
routing frictions (feedback #16-#22): L1 adds resume without an obligation
(#16-#18), L2 supersedes blocks after a check definition changes (#19-#20),
and L3 delivers rulings before more halts and warns about looped checks
(#21, #22 part 3).

- **Resume without an obligation (L1; wais #16-#18).** `owed resume <node>
  [--after <node>] [--note TEXT]` (pi `owed_resume`) records a `resume` entry
  on the node's open attempt. Only a parent or owner may resume; writers,
  reviewers, executors and `parent:drive` are refused, as are a missing open
  slot, an unknown `after` node or the node itself. Resume clears the halt
  and starts a new repair epoch without changing `rulings` or any other
  obligation. With `--after`, the node waits until that dependency merges;
  an already merged dependency resumes it now. The latest resume replaces
  the previous one; a resume without `after`, abandon or a new dispatch ends
  the wait. While waiting the driver launches, sends, halts, attests and
  merges nothing for that node; row 5 still reports asking runs. Status and
  why show `waiting for <dep> (resume #<seq>)`, and the pass report lists
  waiting nodes. The loop prints the quiet waiting event once per node and
  resume; `--once` and `owed_drive` print it each pass, without a wake. Once
  the wait ends, normal rows apply. Without `after`, the next pass can retry
  measurement or an environmentally refused merge, or send a fresh repair
  to a sealed writer. A repair sent before resume whose writer seals later
  also gets a fresh repair under the new budget. Resume does not fix the
  cause of a halt: row 7 (writer sealed non-ok) and row 14 (missing review)
  can halt again; L3's due-ruling route below applies at row 7. The first
  writer follow-up after resume starts with `The parent resumed this node
  (#<seq>)[ after <dep> merged at <commit12>][: <note>]`. Use resume to retry
  or wait without acknowledgment debt; use `owed rule --nodes <node>` for
  guidance the writer and reviewers must follow and acknowledge. Halts and
  wakes naming a run now include its dsa call address, when known, as
  `to:"<wid>/<key>"`, including asking notices without a reported question.
- **Supersede changed check definitions (L2; wais #19-#20).** Replaying a
  plan entry marks every active or flaky execution block on `check:<id>`,
  `red:<id>` or `strength:<id>` as `superseded` when the check definition
  differs from the plan of its failing observation, and records
  `supersededBy: <plan seq>`. The definition is the node's canonical
  CheckSpec with all fields, plus `plan.setup` and `execKey(plan)`; node
  title, brief, closure and other nodes do not count. Removing the check
  (or node) also supersedes its blocks. A superseded block no longer blocks,
  gets no attribution rerun, makes a queued rerun not current, and needs no
  waiver; the current candidate must still pass the new definition. With
  the same definition, flaky behavior is unchanged. Why and status retain
  `#<seq> superseded by plan #<p> (check <id> definition changed)` (or
  `check <id> removed`); report gives superseded blocks their own section.
  Earlier waivers remain recorded. The parent or owner's recorded plan
  accounts for the definition change; downgrades such as lowering
  `min_tests` or removing a check still need owner authority. Checks and
  invariants run in a fresh temporary worktree of the candidate or merge
  tree: slot-only build outputs, caches and node_modules are absent. They
  must prepare their own artifacts, for example through `setup`; fixing an
  environmental failure in the check definition supersedes the old block.
- **Rulings before halts and loop warnings (L3; wais #21, #22 part 3).** An
  undelivered in-scope ruling naming the node can now reach a sealed writer
  before the owner-needed notify (including flaky or rank >= 2 blocks),
  row 7's writer-sealed-non-ok halt and the stalled halt. No reviewer run of
  the current candidate may be unsealed, and an active needs-parent review
  block on the current candidate's keys (else the latest submit's) keeps
  its D18 route. Owner-needed and row 7 send the ruling to the writer. At
  stalled, a failed item, an active block on the candidate's keys or a flaky
  block sends it to the writer; when only `rulings` is owed, it goes to the
  latest sealed driver reviewer of that candidate, or launches a reviewer
  per row 12 if there is none. The reviewer re-reviews with `--ack-rulings`
  or blocks: a writer resubmit does not discharge `rulings`. Without a
  review or closure-review obligation, the node still stalls. Each ruling
  follow-up records what it carried and is sent once, without spending the
  repair budget; a remaining owner need or missing candidate or verdict
  then notifies or halts as usual. Row 18 keeps its existing K5.2 gate.
  At the owner-needed notify only a sealed writer gets the ruling (a running
  or asking writer keeps the notify), and a recorded but unapplied ruling
  follow-up is resent under the same id instead of being skipped.
  Writer ruling messages also list the node's flaky blocks, marked flaky.
  Flaky hints now offer `owed rule "<what the writer must change>" --nodes
  <node>` alongside the waiver: after the writer fixes the test, the block
  stays flaky until a plan change supersedes its definition or the owner
  waives it once the fixed candidate passes. `owed plan` and `owed init`
  (CLI and pi tools) warn without refusing when a check or invariant sets
  `min_tests` and runs a shell loop (`for`, `while` or `until` with `do`, or
  `seq N` in command position). After the check-less warnings, the warning
  explains the actual count: only the last TAP `# tests` summary (else the
  last `1..N` plan), jest/vitest `Tests:` or pytest summary counts, not the
  sum of repeated runs; only cargo `test result:` lines are added up.

**Compatibility.** 0.7.x cannot replay a ledger containing a `resume` entry.
Superseded blocks change no existing entry's validity: old ledgers replay,
including attribution observations and risk waivers that name a block now
superseded. Validation tracks the state it would have had without supersede;
those entries leave its visible state superseded. Upgrade the CLI, the pi
extension and remote executors together, then restart the driver and pi.
Wake and notice texts change: a batch containing a halt gains one resume
hint line (with `--after` for waiting); halt reasons stored in the ledger do
not gain that hint. Run references include `to:"<wid>/<key>"` when known,
and flaky hints offer a ruling as well as a waiver. Driver behavior changes
at row 7 and stalled: a due ruling can produce a writer follow-up instead
of a halt; a stalled candidate owing only `rulings` is routed to a reviewer
for acknowledgment under the conditions above.

**Deferred.** `error_expect` for environment-precondition failures (#12): a
check reports these today by exiting 126/127 without a count, which records
`error`, not a failure. Per-tier model routing (#11 asked for a tier or risk
mapping; routing remains per node). A plan warning for unknown node keys
(typos like `drvie:` are ignored; refusing them would change which existing
plans are accepted). Attest-busy nits: a dispatch whose ledger-lock timeout
is followed by a failed rollback still exits 75 `retry` though leftovers
may block a retry; `--json=x` gets no JSON error line (the CLI matches
`--json` only). The SIGKILL limit: a stop at once SIGKILLs the dsa
invocations' and attest children's process groups only; the checks an
attest runs have process groups of their own, so a check whose attest was
SIGKILLed before ending it keeps running, unrecorded, until it exits.
K review nits not fixed: with per-node locks, parallel node attests each
measure a pending genesis invariant (correct under D24, more CPU); lock
owners record no process start time, so a stale attest lock whose pid was
reused reads as busy indefinitely, and the driver retries without a halt;
the `hold` comment in `src/dsa.ts` still says owed exits only 0..3; the
driver's `--json` loop exit record maps a `busy` error to code 3; merge's
abort path (`abortWith`) keeps the strict whole-plan stability rule, so an
abort after any plan update discards the measurements; merge recomputes
facts with git under the ledger lock when the plan changed; merge's branch
for a node that left the plan is unreachable (removing the node invalidates
its candidate first); the invalidation refusal says `its spec changed` also
for `setup`, `exec` or `closure` changes; a waiver of an obligation the
candidate does not have prints an empty key (unknown obligations are not
refused, as before); the threshold hint reads the node's observations
across attempts, so a new attempt's first under-count may hint at once; the
node-models sha test recomputes the plan sha formula instead of going
through `owed plan`, and a merge-cas test title says `without remeasuring`
but counts only the invariant. Without dsa, an owed attest that exits 75 on
a ledger-lock timeout is logged as `machine lease refused` (busyDetail);
the behavior is right. While a node stays busy the log gets a `started`
and a busy line per timed pass (0.6.x printed one busy line per busy
period). A rejected ruling send is recognized after a driver restart
through dsa's request record; whether that survives a dsa `prune` was not
verified. Still open from 0.6.1: the writes hint lists node ids verbatim as
globs and grants every listed node the union of the new prefixes; a
concurrent dispatch can make a rollback report `rollback failed: directory
cleanup`; a rollback that wraps a non-OwedError drops its stack and the pi
extension returns it as a tool error; pi revalidation replays the whole
ledger once per delivery attempt, and a failed delivery's dropped wakes
are already marked resolved; a staying driver polls neither dsa events nor
trunk drift while it waits. Still open from 0.6.0: a follow-up dsa retires
because the call sealed before delivery still ends in a misleading
`finished repair follow-up without submitting` halt (awaits dsa §49); M4
and M6 of `owed05-big.sh` remain within 9% of the 22M-state cap. The 0.6.1
candidates stay open: bind a reviewer's identity to its dsa call; rulings
that uphold or overrule a named block.

The formal model does not cover resume or superseded blocks. A new
candidate that changes the flaky test itself does not clear the block;
whether it should is deferred. Wais #22 parts 1-2 are not included: driver
self-rebase is not needed; a merge train is deferred.

## 0.7.0

The wais run of 2026-10-10 reported lock, threshold, budget, routing and
throughput frictions on 0.6.0/0.6.1 (feedback #8-#14): K1 answers the attest
lock collisions (#8, #12, and the global lock of #15), K2 the bare halt and
waiver notes (#8, #12), K3 per-node models (#11), K4 the merge refused by an
unrelated plan update (#14), K5 the repair budget and undelivered rulings (#8,
#9, #11) and K6 the serial driver (#13).

- **Per-node attest lock, busy exit (K1; wais #8, #12, #15).** In wais a writer
  ran `owed attest`, as `owed why` told it to, while the driver attested the
  same node; the second attest waited 60 s for the repository-wide `attest`
  lock, failed with `Internal error: timed out waiting for attest` (exit 3), and
  the driver halted (#539). `owed attest <node>` now takes a lock of that node
  only, `attest-<first 16 hex of sha256(node id)>`, so attests of different
  nodes run in parallel (each observation is appended under the ledger lock only
  while its item is current, D24; temporary worktrees, git worktree admin
  directories and log blobs get unique names). `attest --genesis` keeps its
  `genesis` lock. When the node's lock (or `genesis` for `--genesis`) is held by
  a live process on this host, attest fails at once with the new `OwedError`
  code `busy` and exit 75: `attest of <node> is already running (pid <pid> on
  <host> since <ISO time>); its observations will appear in owed why <node>`
  (`--genesis`: `attest --genesis is already running (…); its observations will
  appear in owed status`). A dead owner on this host is reaped as before; a lock
  of another host is waited for (60 s) and then fails with the same text. Every
  other lock wait that times out is `busy` too: `timed out waiting for the
  <name> lock held by pid <pid> on <host> since <time>; retry` (the ledger lock
  reads `the ledger lock`), no longer `internal`. The CLI prints `Busy: <msg>`
  on stderr and exits 75; pi tools return `Busy: <msg>` as a tool error with
  details `{code: "busy", reason}`. With `--json` every command that ends with an
  error (an OwedError or an internal error) now also prints one line `{"error": <message>, "code": <code>}` on stdout; stderr and
  exit codes are unchanged. Where owed suggests `owed attest <node>` to a writer
  (the `owed why` clear hint of an execution block, which the driver's repair
  message embeds), it adds `(skip this when owed drive is running: the driver
  attests)`. A dispatch by the driver (`parent:drive`) stores a packet ending
  with `the driver measures your candidate; do not run owed attest`, and every
  driver writer task carries that line; a manual dispatch stores its packet
  without it.
- **Count notes, block notes, what a waiver means (K2; wais #8, #12).** In wais
  a check that ran 100 of 100 passing tests against `min_tests: 200` showed only
  `zero tests or min_tests unmet`. A non-red check that fails only on its count
  now notes `min_tests unmet: counted <tests> (<pass> pass, <fail> fail[, <skip>
  skip]) < min_tests <m>; exit <code>` or `zero tests; exit <code>`; red notes
  are unchanged, and the observation gains no field. `owed why` shows the note
  of an execution block's failing observation on the block line (` — note:
  …`), and `owed status` on the pending item it holds (` — note #<seq>: …`),
  one line of at most 200 characters (`--json`: `blocks[].note`,
  `pending.<group>[].blockNotes`). In wais an owner learned only from the waived status
  that `--accept-risk` stopped measurement (#12). `owed waive` (CLI text,
  `--json` field `meaning`, the pi tool's text and details) now states what the
  reducer applies (review #781): `waived <obligation> for candidate #<submit>
  <commit12> (key <key12>): <effect>; …`. The waiver is recorded for the key,
  not for one candidate: it counts for every candidate of the node with that
  key, in this or a later attempt, while no unaccepted active block remains on
  the obligation; a later block suspends it and clearing that block restores
  it. The effect says whether it is in effect now, not yet (naming the
  unaccepted blocks and what clears each), not needed (the item is satisfied),
  or not applicable; the text says which change of the key makes owed measure
  it again, and that a measured obligation whose key has no observation yet is
  still measured. Each flaky block in `--accept-risk` adds `the flaky block #<seq> stays recorded as
  accepted risk`. The text is computed from the ledger right after the waiver,
  so a later entry cannot relabel it. `owed why` shows a waived item as
  `<subject>/<obligation> waived (not measured for this candidate) by <who>:
  <reason> (<channel>)`.
- **Node models (K3; wais #11).** In wais every driver-launched writer used the
  plan's one writer model, so cheaper slots stayed idle. A node may set
  `drive: {writer?: {agent?, model?}, reviewer?: {agent?, model?}}`, validated
  like the plan's roles (unknown keys and bad types are errors). For each role
  the node sets, an object with `agent` replaces the plan's role (the model is
  the node's, else none: the agent's default applies); one with only `model`
  keeps the plan's agent and overrides its model. `drive: {}` and an empty role
  object are dropped, so a plan without node `drive` keeps its canonical bytes
  and sha. Node `drive` is not an obligation: changing it is never a downgrade,
  invalidates no candidate and affects only later launches; a re-launch sends
  its stored spec bytes. `owed why <node>` shows `Drive: writer <agent>
  (<model>) · reviewer <agent> (<model>)` with the effective values when the
  node sets `drive` (`(<model>)` only when a model is set; `--json` `drive`).
  README, SPEC §12.2 and the `owed` skill describe it.
- **Node-scoped merge CAS (K4; wais #14).** In wais a 5-minute merge measurement
  was refused with `Plan, candidate or trunk changed; retry` after two plan
  updates that did not touch the node, and was measured again from scratch.
  After measuring, `owed merge` now compares under the ledger lock only the
  ledger trunk commit, the trunk ref, the node's slot (dispatch seq, attempt,
  base, open) and its candidate (submit seq, commit). If one moved it refuses
  and records nothing, naming the cause: `slot of <node> changed (#<seq>
  <kind>); nothing recorded`; `candidate #<S> <commit12> of <node> was
  invalidated by plan #<N> (its spec changed); the writer submits again, then
  merge`; `trunk changed (CAS): …`; otherwise `Plan, candidate or trunk changed;
  retry`. A plan update that keeps the candidate, and entries of other nodes,
  no longer refuse. The guard runs on the latest state under the latest plan
  (merge facts and keys are recomputed when the plan changed) plus the measured
  observations whose job is still current (D24.1); the others are dropped. A
  job the run did not measure (a key the update introduced, e.g. a changed
  invariant) refuses with `not measured: <subject>/<obligation> (key <key12>),
  … (the plan changed while merge measured); run owed merge again: it measures
  only what lacks a verdict`. On a guard refusal the kept observations are
  appended, so a retry measures only jobs without a verdict (a pass or fail is
  reused, an `error` is measured again). Adopt keeps its strict rule.
  `formal/REPORT-mc-owed.md` §9 "0.7 merge CAS" shows the node-scoped CAS stays
  within what the model checks (`merge_guard`, `merge_jobs` in `owed05.rs`).
- **Repair epoch, rulings to sealed writers, threshold hint (K5; wais #8, #9,
  #11).** In wais a parent plan mistake used up the repair budget and a later
  ruling never reached the halted writer (FLAKY-COLDPLAY #406, QA-REGISTRY
  #427); the parent sent follow-ups by hand. `drive.repairs` now counts the
  attempt's repair sends after the node's epoch: the latest of its dispatch,
  the latest ruling naming the node (`*` does not count) and the latest plan
  entry that changed the node's canonical spec (ignoring `title` and node
  `drive`; `brief` counts). Both repair rows use it, and the halt reads `repairs
  exhausted (<k> of <n> since ruling #s | plan #s | dispatch): <cause>`. When
  the writer run is sealed and a ruling naming the node is undelivered, the
  driver sends one follow-up with reason `ruling` in place of a `finished …
  without submitting` halt or the `repairs exhausted` halt (the only halts it
  can replace, review #784 F2): `New parent rulings for <node>:`, one line per
  undelivered in-scope ruling, the active blocks of the current (else latest)
  candidate with their notes, then `Apply these rulings; they override your
  packet. Then commit and run \`owed submit <node>\`.` It records `rulings`, is
  not a repair, and a writer that finishes it without submitting halts naming
  it; dsa rejecting it halts at once. The submit, rebase, repair and ruling
  follow-ups to the writer carry the undelivered in-scope rulings first and
  record `rulings`: `submit` and
  `rebase` follow-ups record it too (new; only when they carry a ruling) and
  start with `Parent rulings for <node> (apply them; they override your
  packet):`, and a repair message now starts with its `Rulings since dispatch:`
  block. A send dsa rejected delivers nothing to the writer (review #784 F1):
  the driver reads dsa's request state of the attempt's recorded sends each
  pass (cached once terminal), and the next writer follow-up carries those
  rulings. When the node's latest two failing, non-attribution observations of
  check X both exited 0 with no failure and the same test count below X's
  `min_tests`, and no ruling naming the node followed, the driver halts for the
  parent instead of repairing: `check <X>: <tests> tests ran and passed twice,
  below min_tests <m>; the plan's threshold may be wrong: fix the plan (owed
  plan) or rule (owed rule --nodes <node> "…")`; the first under-count still
  gets a repair. The `repairs exhausted` and `finished … without submitting`
  halts list each deciding failing observation as `#<obs> <obligation>: <note>`
  (at most 200 characters). SPEC and the skill say: after fixing a plan mistake,
  or to let the writer continue, record a ruling naming the node.
- **Background measurements (K6; wais #13).** In wais one 5-minute merge
  measurement held every other node (16:03-16:09) with Opus 3/12 busy. The
  driver now starts attests (a child process, as before) and merges
  (`ops.merge` in the driver process) and goes on: `decide` gives a node with a
  measurement in flight no action, and other nodes are dispatched, launched,
  sent to and halted as usual. At most `drive.measure` measurements run at once
  (new plan key, integer >= 1, default 2; kept in the parsed plan only when
  set) and at most one merge. A started measurement logs a quiet `{"do":
  "attest"|"merge","node":…,"outcome":"started"}`; one that ends wakes the
  loop, and the next pass handles the result first as before (report, halts,
  rebase). An `owed attest` exit 75 (K1) is `busy`, like hold refusing the
  lease: never a halt, not progress, no wake, and the node waits for the next
  timed or event pass (review #785: the first version retried 53 times in 8 s);
  every `started` line gets its completion line. While its own merge is in
  flight or unhandled, the driver makes no trunk drift check (review #785: its
  own merge raised a false drift notify). The K4 refusals are handled: `not
  measured` → retry next pass; `slot … changed` and `candidate … was
  invalidated` → `superseded`, no halt. `owed drive --status`, `/owed` and
  `owed_drive` status list `<node> <attest|merge> since <time>` from the log
  (`--json` `measuring`). A driver with a measurement in flight is never idle.
  Stopping: the first SIGINT/SIGTERM of the loop (so `owed drive --stop`, a
  SIGTERM as in 0.6.x) and `owed_drive` stop start nothing new and wait for the
  measurements without a time limit, then exit `stopped`; a second signal (so
  `--stop --now`) or the first under `--once` stops at once: it aborts the merge
  (its checks get SIGKILL; a merge aborted before its last abort point does not
  move trunk, D16a.1), SIGTERMs the dsa invocations
  and attest process groups, waits 5 s, SIGKILLs those groups, waits 1 s, then
  writes the `killed` line and exit record and exits 130. A loop error aborts
  an in-flight merge and waits up to 6 s for it. `--once` and the pi tool's pass
  wait for the measurements they started. A driver that died leaves its attest
  children to finish (their observations land under D24); the new driver's
  attest of that node gets exit 75 and retries later.

**Compatibility.** The ledger entry kinds are unchanged, and a plan that sets
neither node `drive` nor `drive.measure` keeps its canonical bytes and sha.
pi-owed 0.6.x refuses a plan that sets `drive.measure` (`drive.measure: unknown
key`: its plan-level `drive` block rejects unknown keys), both as a plan update
and when it replays a ledger that recorded such a plan. 0.6.x does not validate
node keys, so it ignores a node's `drive` and launches that node with the
plan's drive. 0.6.x replay refuses a ledger with a `submit` or `rebase` send
carrying `rulings` (`send rulings is only allowed with reason ruling or
repair`); it accepts the `ruling` follow-ups, since a `ruling` send always
carried `rulings`. Exit 75 and the `busy` code are new; lock timeouts that were
`internal` (exit 3) are `busy` (exit 75). With `--json` every `OwedError` (and
an internal error) now also prints `{"error","code"}` on stdout, where before a
failure printed nothing there. The merge CAS is node-scoped: a plan update that
keeps the merging node's candidate no longer refuses its merge, and the new
refusal texts above replace `Plan, candidate or trunk changed; retry` for their
causes. Upgrade the CLI, the pi extension and the remote executors together: a
0.6.x attest takes the repository-wide `attest` lock and a 0.7.0 attest the
node's lock, so the two do not exclude each other on one node (both record
under D24, but the node is measured twice), and a 0.6.x process cannot replay a
ledger with the plans or sends above.

**Deferred.** `error_expect` for environment-precondition failures (#12): a
check reports these today by exiting 126/127 without a count, which records
`error`, not a failure. Per-tier model routing (#11 asked for a tier or risk
mapping; 0.7.0 routes per node). A plan warning for unknown node keys (typos
like `drvie:` are ignored; refusing them would change which existing plans are
accepted). Attest-busy nits: a dispatch whose ledger-lock timeout is followed
by a failed rollback still exits 75 `retry` though leftovers may block a
retry; `--json=x` gets no JSON error line (the CLI matches `--json` only). The
SIGKILL limit: a stop at once SIGKILLs the dsa invocations' and attest
children's process groups only; the checks an attest runs have process groups
of their own, so a check whose attest was SIGKILLed before ending it keeps
running, unrecorded, until it exits. K review nits not fixed: with per-node
locks, parallel node attests each measure a pending genesis invariant (correct
under D24, more CPU); lock owners record no process start time, so a stale
attest lock whose pid was reused reads as busy indefinitely, and the driver
retries without a halt; the `hold` comment in `src/dsa.ts` still says owed
exits only 0..3; the driver's `--json` loop exit record maps a `busy` error to
code 3; merge's abort path (`abortWith`) keeps the strict whole-plan
stability rule, so an abort after any plan update discards the measurements;
merge recomputes facts with git under the ledger lock when the plan changed;
merge's branch for a node that left the plan is unreachable (removing the node
invalidates its candidate first); the invalidation refusal says `its spec
changed` also for `setup`, `exec` or `closure` changes; a waiver of an
obligation the candidate does not have prints an empty key (unknown
obligations are not refused, as before); the threshold hint reads the node's
observations across attempts, so a new attempt's first under-count may hint at
once; the node-models sha test recomputes the plan sha formula instead of
going through `owed plan`, and a merge-cas test title says `without
remeasuring` but counts only the invariant. Without dsa, an owed attest that
exits 75 on a ledger-lock timeout is logged as `machine lease refused`
(busyDetail); the behavior is right. While a node stays busy the log gets a
`started` and a busy line per timed pass (0.6.x printed one busy line per busy
period). A rejected ruling send is recognized after a driver restart through
dsa's request record; whether that survives a dsa `prune` was not verified. Still open from 0.6.1: the writes
hint lists node ids verbatim as globs and grants every listed node the union
of the new prefixes; a concurrent dispatch can make a rollback report
`rollback failed: directory cleanup`; a rollback that wraps a non-OwedError
drops its stack and the pi extension returns it as a tool error; pi
revalidation replays the whole ledger once per delivery attempt, and a failed
delivery's dropped wakes are already marked resolved; a staying driver polls
neither dsa events nor trunk drift while it waits. Still open from 0.6.0: a
follow-up dsa retires because the call sealed before delivery still ends in a
misleading `finished repair follow-up without submitting` halt (awaits dsa
§49); M4 and M6 of `owed05-big.sh` remain within 9% of the 22M-state cap. The
0.6.1 candidates stay open: bind a reviewer's identity to its dsa call; rulings that uphold or
overrule a named block.

## 0.6.1

The wais run of 2026-10-10 reported four driver and planning frictions
(feedback #4-#7): H1 answers #4 and #5, H2 answers #6 and #7. H3 closes three
0.6.0 deferrals.

- **Live wakes (H1.1; wais #5).** In wais the parent read a question from the
  drive log and answered it, but the follower had already handed its wake to pi
  as a follow-up while the agent was busy, so pi delivered the stale wake after
  the answer. The pi extension now tracks the session's agent (`agent_start` …
  `agent_settled`, and `ctx.isIdle()` of the latest event context) and never
  hands a wake to pi while it runs: the follower keeps reading and holds the
  batch. At `agent_settled` (every follower steps at once) or at the next tick
  while idle, the batch is revalidated and what is left is delivered with
  `triggerTurn` as before; a batch that finds the agent busy again after the
  revalidation stays held. Revalidation runs on every pi delivery, also for a
  batch read while idle, and on wake lines only. The driver's asking notify
  carries the log-line fields `rid`, `qid` and `rev` (the run's first listed
  open question; the text is unchanged), and the line is dropped when `describe`
  of that run no longer lists that qid/rev as open; a failed describe keeps it.
  Checking only the first question is enough: once it is answered the notify
  text changes, and the next pass prints the line of the remaining question,
  which is delivered; a line whose first question is still open is delivered
  even if a later one was answered. A node-scoped line with a fact mark is dropped when the
  node's current fact mark (`factMark`) is higher: someone acted on the node,
  and a condition that still holds is reported again by the driver's next pass
  with the new mark; a failed ledger read keeps it. Terminal lines, drift lines,
  `idle-wait` and lines without a fact mark are never dropped. The ledger is
  read and each run described at most once per delivery. A dropped wake that is
  still its key's latest record also drops that record's repeat ride-along, and
  later repeats of it do not ride along. When lines were dropped the message
  ends with `(<n> wake(s) resolved before delivery)` after `Next: …`, counting
  that delivery's drops only; when no wake line is left nothing is delivered and
  the session is not woken (merges and repeats ride along with the next
  message). A failed `sendMessage` keeps the whole batch, revalidated again at
  the next tick. A follower without the pi hooks (the CLI-era `tick`) is
  unchanged.
- **Staying driver (H1.2; wais #4).** In wais the driver exited idle after a
  merge, the parent then added seven ready nodes, and no driver dispatched them.
  `owed drive --stay` (with the loop or `--detach`; a usage error with `--once`,
  `--status` or `--stop`) and `owed_drive` action `start` with `stay: true`
  (refused with other actions) are opt-in. An idle pass of a staying driver does
  not exit: it logs `{"event":"idle-wait","at":…}` once per idle period (text
  `idle: nothing open and nothing ready; staying until the ledger changes (owed
  drive --stop ends it)`), which wakes the session and is not terminal. The
  driver keeps the lock and polls every `pollMs` the hash of the last complete
  entry of `ledger.jsonl`, read from the file's end, until it differs from the
  head the idle pass decided on, then resumes passes. That baseline is the idle
  pass's own head (review #725): an entry appended while the idle pass ran, such
  as a plan update adding a ready node, already counts as a change and the next
  pass runs at once; the first candidate read the head after the pass and then
  waited for a further change with the new node undispatched. An idle period
  ends with a pass that is not idle, so a ledger change that leaves the driver
  idle logs no second `idle-wait`. A stop or signal ends it as before (exit
  record `stopped`). `--detach --stay` passes `--stay` to the detached driver;
  the lock does not record it. While the driver runs and its log, after the last
  exit record, has an `idle-wait` followed by no action other than a notify,
  `owed drive --status` adds `idle, waiting for ledger changes since <at>`
  (`--json`: `idleSince`), and `/owed` and `owed_drive` status show it too.
  Without `--stay` an idle pass exits `idle` as before. SKILL.md recommends
  `stay: true` when the plan will grow.
- **Ready hint (H1.3; wais #4).** After a successful `owed plan` or `owed_plan`,
  when the new state has nodes the driver would dispatch now (the `dispatch`
  actions of its `decide`: readiness, `drive.max`, writes overlap, owner-needed)
  and no driver holds the repository's lock (a live lock or a lock of another
  host counts as a driver, a stale one does not), the output adds one line: CLI
  `ready: <ids> (<n>); no driver is running: owed drive --detach --stay`, pi
  `ready: <ids> (<n>); no driver is running: owed_drive {action:"start",
  stay:true}`. The ids are in the driver's dispatch order. `--json` output and
  the tool details gain `ready: string[]` and `driver: false` only together with
  the line. Nothing starts automatically, and a failure computing the hint adds
  nothing. The line comes before the H2.2 warnings, which end the plan text
  (SPEC §12.9).
- **Allowance guidance (H2.1; wais #6).** In wais two writes questions within 15
  minutes each cost a plan version and an owner act. README and the `owed` skill
  gain a planning recipe: keep writes strict by default, and at plan time
  pre-authorize the `writes` prefixes integration and packaging nodes tend to
  need with an `allow` rule, e.g. `allow: [{nodes: ["KB*", "A9-*"], writes:
  ["app/src/entry/", "package.json"]}]`; a writer's writes question then costs
  one parent plan update and no owner step. A parent plan update refused only
  for widened writes (every uncovered downgrade is `writes widened` or `writes
  scope expanded`) adds, when there are new prefixes, in the CLI and in
  `owed_plan`, one line with a
  ready-to-paste rule for the next plan: `hint: an allow rule {nodes: ["KB4"],
  writes: ["<new prefixes>"]} in the prior plan would cover this`, the new
  prefixes being those under neither the node's prior writes nor a matching
  prior rule.
- **Check-less nodes (H2.2; wais #7).** In wais a milestone node with no check
  merged on a review of its evidence, although its writer reported the milestone
  not met. `owed init` and `owed plan` (CLI and pi tools) warn, refusing and
  recording nothing, for each node of the new plan with no checks and no
  evidence obligations: `warning: node <id> has no checks: its acceptance rests
  on review alone`. Every such node is warned about, not only one whose title
  says "Milestone": a title is not a contract. The CLI prints the warnings after
  the result; `--json`, `owed_init` and `owed_plan` return `warnings: string[]`
  (empty when there are none).
- **What an ok review means (H2.3; wais #7).** The review packet adds a line
  before the needs-parent instruction: `--ok` means the candidate meets the
  node's goal as its title and brief state it, not only that the writer's report
  or evidence is accurate; if the candidate or the writer's report says the goal
  is not met, record `--block` (`--needs-parent` when the goal itself is in
  question). The driver does not parse review notes. The `owed` skill states
  the same meaning of an ok review.
- **0.6.0 deferrals (H3).** Every step of a dispatch rollback (`git worktree
  remove`, `git branch -d`, directory cleanup) runs even when an earlier one
  fails; the error then names the original failure and each failed step
  (`<original>` followed by the line `rollback failed: <step>: <reason>; …`),
  keeps an OwedError's code (`internal` otherwise), and nothing is recorded, as
  before. A new plan (`owed init`, `owed plan`) is refused when two node ids are
  equal ignoring case (`KB4` and `kb4`), since on a case-insensitive filesystem
  they would share a branch ref and a worktree directory; replay is unaffected.
  `formal/run-a3-big.sh` caps its runs like `formal/models/scripts`: `ulimit -v
  8000000` for every run, and for the `owedmc check` runs explicit state caps (exhaustive 22M distinct states; simulations 2e9
  sampled states, so the walk count stays the bound), the model checker's
  `--timeout` and a wall-clock `timeout` 120 s above it; `a3_compare`, which has
  no state cap of its own, runs under the memory cap and a 3600 s wall clock.
  Rerun on ipc with the caps, no cap stopped any configuration and every
  published a3 verdict and state count is unchanged
  (`formal/REPORT-mc-port.md`).

**Compatibility.** The ledger format is unchanged: no entry gains a field, so
pi-owed 0.6.0 can read a ledger written by 0.6.1. The asking notify's `rid`,
`qid` and `rev` are fields of the drive log line, not of the ledger. `--stay` is
opt-in: without it the driver exits idle as before. The wake timing and the
revalidation change only in pi; a follower without the pi hooks delivers as
before. The JSON output of `owed plan` and `owed init` and the details of
`owed_plan` and `owed_init` gain `warnings`; `ready` and `driver` appear only
together with the ready hint line. New plans are refused for node ids differing
only in case: a ledger whose recorded plan has such ids stays readable, but a
plan update that keeps both ids is refused.

**Deferred.** Review nits not fixed: the writes hint lists node ids verbatim in
`nodes`, which allow rules read as globs, so an id containing `[` does not match
itself and the pasted rule misses that node; with several nodes the hint grants
every listed node the union of all new prefixes (broader than needed, still
covering the update); a concurrent dispatch whose worktree lies in a parent
directory this dispatch created makes the rollback report `rollback failed:
directory cleanup` (ENOTEMPTY) although only empty directories are removed; a
rollback that wraps a non-OwedError drops its stack, and the pi extension then
returns it as a tool error instead of rethrowing it; in pi, revalidating a
batch replays the whole ledger once per delivery attempt, and when delivery
fails the kept batch's dropped wakes are already marked resolved; and a staying driver polls
neither dsa events nor trunk drift while it waits (only the ledger head). Still
open from 0.6.0: a follow-up forwarded into running work that dsa retires
because the call sealed before delivery still ends in a misleading `finished
repair follow-up without submitting` halt; the fix awaits dsa §49; M4 and M6 of `owed05-big.sh` remain within 9% of the
22M-state cap (a larger model stops at the cap: each property without a verdict
yet reports TIMEOUT, never HOLDS, and the exit status counts them). 0.7
candidates: bind a reviewer's identity to its dsa call; rulings that uphold or
overrule a named block.

## 0.6.0

The owedmc model of owed 0.5 (`formal/models`, `owed05`) checked acceptance and
authority and found five gaps, F1-F5 (`formal/REPORT-mc-owed.md` §6): G1 closes
F1 and F2, G2 closes F4 and F5 and adds a rail against F3. F6 (replay-only
entries, which never ease acceptance within the bounds) needs no change.

- **Candidate-bound acts name the candidate they judged (G1; F1, F2).** `owed
  review`, `owed waive`, `owed approve` and `owed evidence` accept `--candidate
  <commit>` (40 hex, or a prefix of at least 7 hex; anything else is a usage
  error), and the pi tools `owed_review`, `owed_waive`, `owed_approve` and
  `owed_evidence` an optional `candidate` string. The act is checked under the
  ledger lock at append time and refused unless the node has an open candidate
  whose commit starts with it: `candidate changed: you named <given>, the open
  candidate is #<seq> <commit12>; nothing recorded` (or `…, node <node> has no
  open candidate; nothing recorded`, which also refuses `--candidate` on a
  merged node's receipt). Without the flag no commit is checked, and the ledger
  records nothing new. Under `OWED_CONFIRM=owner` the waive and owner-review
  confirmations (pi dialog; CLI, unless `--i-am-owner`, printed before the TTY
  prompt) show the candidate — commit, submit seq, base and number of changed
  files, as approve's does — and pin it: a resubmit after the confirmation
  records nothing (`candidate changed since confirmation`). Every command owed
  suggests for a candidate-bound act on a node with an open candidate carries
  `--candidate <commit12>` of that candidate: the decision commands and clear
  hints of `owed why` and `owed brief`, the resolving commands of driver halts
  and notifications, the driver's approve/evidence halt (`awaiting owner
  approval …`, `awaiting manual evidence …`), and the review packet. The
  packet's `owed review` (and reviewer evidence) commands pass the commit under
  review, so a resubmit during the review makes recording fail instead of
  landing on content nobody reviewed; the packet tells the reviewer to re-read
  `owed why <node>` and review the new candidate when that happens. SPEC, README
  and the `owed` skill say to pass the commit actually read.
- **Judgment rails (G2; F3, F4, F5).** Inside a pi-durable-subagents call
  (`DSA_CALL` or `DSA_EXEC` set) owed refuses `review` and `evidence` on a node
  when a working directory of the process (the process's own directory; for pi tools
  also the `cwd` parameter and the session's directory), symlinks resolved, lies
  inside that node's open slot worktree: `a writer worktree cannot record a
  review or evidence for its own node; run the review from the repository root
  or another directory`. Driver reviewer runs start in the main worktree and are
  unaffected. Like the D25.3 rail it guards against accidents and instructions,
  not deliberate evasion (SPEC threat model). The review count of an obligation and the
  rulings acknowledgment now exclude every principal the append-time recusal
  excludes: any role whose id equals that of a writer of the node, in any
  attempt (0.5.1 excluded only the exact writer principal). `parent:drive` is
  the driver's identity only: on append and on replay the ledger refuses an
  entry by it of any kind but `dispatch`, `launch`, `send`, `halt` and `rebase`
  (`<kind> by parent:drive: the driver records only …`), and the CLI and the pi
  tools refuse `--as parent:drive` / `as: "parent:drive"` in every command,
  reads included.
- **Repair before re-review; one message to the writer (G3).** While a review
  block is active on the current candidate's key (and the node does not need the
  owner), the driver sends the repair before launching any reviewer run of that
  candidate; attest, the needs-parent halt and measured repairs keep their order
  before it. When the writer is sealed without a current candidate (a plan
  change invalidated it, or trunk moved and the slot was rebased) and an active
  review block recorded in this attempt on the key of its latest submit does not
  await a parent ruling, the driver sends one follow-up instead of the `submit`
  / `rebase` one: reason `repair` (counted against `repairs`; exhausted → halt),
  the rulings in scope since dispatch (and those quoted by needs-parent blocks)
  first, then the blocks with their notes, then why a new candidate is needed
  (the plan changed, or trunk moved with the `git rebase --onto` instructions),
  then commit and `owed submit <node>`. Its `rulings` records what it carried,
  so no separate ruling steer follows; a writer that finishes it without
  submitting halts, and identical content resubmitted gets another repair (or
  the exhausted halt), never a reviewer run. When a block on that key awaits a
  parent ruling, the driver halts for the ruling (needs parent) before any
  repair, `submit` or `rebase` follow-up, also when no repairable block exists,
  so a new candidate never makes an unruled question stale; with no block on
  that key the `submit` / `rebase` follow-ups are unchanged. A follow-up sent to a running writer is
  forwarded into its running generation (dsa's reply carries no `generation`):
  the driver no longer expects generation + 1 then, so the sealed view that
  follows counts as sealed (a sealed writer was shown as running and the rebase
  follow-up never went out); a follow-up to a sealed call still waits for the
  next generation. The rebase follow-up (and the rebasing repair) lists the
  files that conflict between the previous candidate and the new base (`git
  merge-tree --write-tree --name-only -z`, computed only in passes where that
  follow-up can be due), `none` when it merges cleanly, omitted when the previous
  commit is unknown or git fails. Trunk drift (0.5.1 deferrals): when a pass after a drift finds
  trunk equal to the ledger trunk again, the driver forgets the drift notify's
  print and wake records and logs the quiet event `drift-cleared`, on which the
  follower forgets its own, so an identical later drift prints and wakes again;
  the drift notify carries `scope: "repo"` and its records are keyed apart from
  a plan node named `trunk`; and when the ledger's trunk commit is absent the
  notify says so (`git update-ref` cannot restore it and `owed adopt` cannot
  check a fast-forward from it) and suggests fetching it (`git fetch <remote>
  <ledger>`), then restoring trunk or adopting the current ref (`owed adopt
  --commit <ref12> --note "<why>"`). `owed adopt` still refuses a missing ledger
  trunk.
- **Plan and worktree hygiene (G4; 0.5.0 deferrals).** A new plan (`owed init`,
  `owed plan`) is refused when `worktrees.root` or `worktrees.branch` contains a
  control character (below 0x20, 0x7f, U+2028, U+2029; 0.5.1 refused only NUL, and only in
  `worktrees.root`),
  or when the branch template could render two (node, attempt) pairs as the same
  name: `{node}` must occur exactly once, and each `{attempt}` or `{type}` must
  be separated from it by a character that cannot occur in that value (such as
  `/`), so `{node}{attempt}` is refused. These checks apply to new plans, not on
  replay, so existing ledgers stay readable. `owed gc` keeps a branch whose name
  is recorded for another node or attempt. A dispatch that fails and rolls back
  removes the parent directories it created. Allowance texts: `owed report` and
  `owed brief` list parent adoptions under allowance in their own adoptions
  section (owner adoptions stay under owner decisions); a parent's refused plan
  update lists each uncovered downgrade once; `owed brief` lists the downgrades
  recorded under allowance with the report's label (`by parent:<id> under
  allowance (plan #S)`).
- **Formal follow-ups (G5).** `formal/REPORT-mc-owed.md` §8 lists `error`
  observations as not modeled (the code records no verdict for them and skips
  their attribution). Every script in `formal/models/scripts` runs owedmc under
  `ulimit -v` 8 GB with `--max-states` and `--timeout`; `owed05-big.sh` lowers
  its cap from 14 GB and 40M states to 8 GB and 22M states and still completes
  M1-M6, S1 and S2 with the published states, depths and verdicts.

**Compatibility.** The ledger format is unchanged: no entry gains a field, so
pi-owed 0.5.1 can read a ledger written by 0.6.0. G2's recusal can change
replayed views of existing ledgers: a review by `reviewer:X#n` no longer counts
once `writer:X#n` exists. Replays of the pi-owed and wais ledgers passed `owed
verify`, and their status, report and why outputs were byte-identical with and
without the recusal change. Replay now refuses an entry by `parent:drive` of a kind the driver never
writes, and `--as parent:drive` is refused. A subagent's review or evidence from
inside the node's slot worktree is refused; this is a rail, not a security
boundary: nothing prevents a `cd` to the repository root. Upgrade the `owed` CLI
on PATH together with the driver and the pi extension: 0.6.0 review packets and
suggested commands pass `--candidate`, which a 0.5.1 CLI rejects as an unknown
option.

**Deferred.** `owed plan --probe` (heuristic resolution of check commands; 0.5.1 already
reports exit 127 with the failing lines) and a plan warning for a check mixing
cargo and TAP. To 0.6.1: a dispatch rollback continues after a failing step
(worktree remove, branch deletion); node ids differing only in case on
case-insensitive filesystems; caps for `formal/run-a3-big.sh`; M4 and M6 are
within 9% of the 22M-state cap; a follow-up forwarded into running work that
dsa retires because the call sealed before delivery ends in a misleading
`finished repair follow-up without submitting` halt. 0.7 candidates: bind a
reviewer's identity to its dsa call; rulings that uphold or overrule a named
block.

## 0.5.1

- **Driver runs belong to the starting pi session (E1, pi-durable-subagents
  1.0.31).** When a driver starts (`owed drive`, `--once`, `--detach`, pi
  `owed_drive`), owed reads `DSA_SESSION` from its environment — ignored when
  `DSA_CALL` or `DSA_EXEC` is set (a subagent), exactly as dsa does, and when
  it is not a session id dsa accepts (a letter or digit, then up to 127 of
  `[A-Za-z0-9._:-]`) — and records it as `session` in `drive.lock` (absent when
  none); `--detach` hands the starter's value to the detached driver. Every
  `pi-durable-subagents run` the driver issues passes `--session <id>` when a
  session is recorded, and dsa child processes never inherit `DSA_SESSION`, so
  the lock and what dsa records never disagree. A dsa that refuses `--session`
  (older than 1.0.31) is detected once per driver: the flag is dropped, the run
  is issued again without it and one line is logged (`dsa does not accept
  --session (older than pi-durable-subagents 1.0.31): runs start without it and
  are not listed in pi session <id>`); it never halts. For a running driver
  `owed drive --status` (`--json` `session`), `/owed` and `owed_drive` status
  show `runs are listed in pi session <id>` or `no pi session: runs show only
  in pi-durable-subagents status / the CLI`.
- **Check results say what happened (E2).** The count parser sums every
  recognized segment of one log: cargo `test result:` lines and TAP
  plans/results in the same output give one count with format `mixed` (`tests`,
  plus `pass`/`fail`/`skip` where the TAP part reports them), which `min_tests`
  checks; single-format logs keep their format names and numbers. cargo
  summaries count only at column 0, so a TAP comment `# test result: ok. …` or
  an indented YAML diagnostic containing one stays TAP text. A non-red check
  that exits non-zero with no recognizable count, or with zero tests, is `fail`
  (no longer `error` with `unknown test count format with min_tests`), with the
  note `command exited <code> with no recognizable test count` (or `after zero
  tests`) `; last output:` followed by its last 5 non-empty output lines (ANSI
  colour removed, each at most 200 characters). Exit 126 or 127 with no count
  is now `error` also without `min_tests` (0.5.0 recorded `fail` there):
  `command could not run (exit 126: not executable)`, or `127: not found`, plus
  the same tail; the command never ran, so it says nothing about the code. An
  exit-0 run with an unknown count under `min_tests` stays `error`, and red
  runs are unchanged. `owed why`/`owed_why` show each fail observation's note
  under its item (`note #<seq>:`, then the note as recorded, indented), and so
  does the driver's repair message to the writer, which includes the `owed why`
  card. Check processes no longer inherit the `DSA_*` variables (dsa call
  identity) except `DSA_HOME` (configuration), so owed commands inside a check
  run under a dsa call are not refused as subagent acts; a variable the plan's
  `exec.env` sets still applies.
- **One wake per new fact; trunk drift is not a halt (E3).** A driver wake
  (halt, notify, rejected, conflict, refused, error) of a node carries the
  node's fact mark: the highest seq of the ledger entries naming it that the
  driver (`parent:drive`) did not write. The loop driver prints a node's notify
  only when its text or fact mark changed, and marks any other wake whose text
  and mark equal the node's last one with `(repeat <n>, no new ledger
  entries)`. The background follower wakes the session for such a line only
  when its text differs from the last one delivered for that node or the node's
  fact mark rose; a repeat does not wake and rides along with the next message
  with the same suffix. Lines without a fact mark (a 0.5.0 driver's log) wake
  as before. Trunk drift — the trunk ref no longer equals the ledger trunk — is
  a repository fact and never a ledger halt: each pass the driver compares them
  before merging; on drift it merges nothing that pass (other actions continue)
  and emits one repo-level owner notify, `trunk <name> moved outside owed
  (<ledger> → <ref>); the main agent resolves it with: owed adopt --note
  "<why>"` when the ref fast-forwards the ledger trunk, otherwise `trunk <name>
  was rewound or rewritten (<ledger> → <ref>); restore it: git update-ref
  refs/heads/<name> <ledger> <ref>`. It prints once per change (loop) and wakes
  once per change (follower). A CAS failure inside a merge (trunk moved
  meanwhile) is the same notify, retried next pass; other merge refusals still
  halt (needs human). After `owed adopt` the next pass merges with no other
  act. Owner halts use the D25.6 wording everywhere — driver output `halt
  <node> attempt <n>, needs the owner (the main agent decides; owed lists the
  command)`, the halt rows of `owed why` and `owed report` and halt entry lines
  (`owed status` lists owner halts under `Pending owner`) — and resolving
  commands that state a role say `--as owner:cli` (`--as owner:human` under
  `OWED_CONFIRM=owner`). The CLI's default owner principal is now `owner:cli`
  (channel `delegated`), matching pi's `owner:pi`; it is `owner:human` only
  under `OWED_CONFIRM=owner`.
- **Rulings carried, not inferred (E4).** Launch entries and `repair` sends now
  record `rulings`: the highest in-scope ruling seq their message actually
  carried, computed from the state the message was built from, `0` when it
  carried none (a writer launch: the rulings of its dispatch packet; a reviewer
  launch: every ruling in scope; a repair: the rulings since dispatch and those
  quoted by needs-parent block notes). A re-launch keeps the recorded value.
  The rulings delivered to a run are the maximum over its launch and its repair
  and ruling sends (and, for a writer, its dispatch `rulings_seen`); entries
  without the field (written by 0.5.0) keep 0.5.0's position rule. A ruling
  recorded while a launch or repair message is being built is therefore steered
  afterwards instead of counting as delivered. The reducer validates the field
  — an integer, at most the entry's own seq, and 0 or the seq of a ruling
  covering the node recorded before the entry — and replay refuses otherwise;
  other send reasons still may not carry it (`send rulings is only allowed with
  reason ruling or repair`).

**Compatibility.** pi-owed 0.5.1 reads 0.5.0 ledgers unchanged. A ledger on
which a 0.5.1 driver recorded any launch (or a repair send) cannot be read by
0.5.0: its replay refuses the entry (`Entry #N invalid: launch has unknown
fields: rulings`, or `send rulings is only allowed with reason ruling` for a
repair send), so `owed verify` fails. Upgrade every owed together — the CLI,
the pi extension and remote executor hosts — and stop a 0.5.0 driver first. The
CLI's default owner principal is `owner:cli`, also with `--i-am-owner` (which
still records channel `flag`); `owner:human` only under `OWED_CONFIRM=owner`.
Entries recorded earlier keep `owner:human`, and `--as owner:human` still
records that id. `drive.lock` gains the optional `session`, which 0.5.0 readers
ignore; with pi-durable-subagents older than 1.0.31 the driver falls back to
runs without `--session`. Halts recorded for trunk drift (`merge refused: …
trunk changed (CAS)`) by 0.5.0 drivers stay ledger halts: clear one by adopting
(`owed adopt --note "<why>"`) or restoring trunk, then `owed rebase <node>`;
the driver then attests again. A non-red check that exits non-zero without a
recognizable count, or with a zero count, is now `fail` (exit 126/127 with no
count: `error`, also without `min_tests`, where 0.5.0 recorded `fail`), so a
check that used to stall on `unknown test count format with min_tests` now
fails with its real error in the note.

**Known limitations, deferred to 0.5.2.** The loop's record of the printed
drift notify and the follower's last trunk wake are not reset when drift
clears, so an identical later drift (same ledger seq and ref) neither prints
nor wakes. A plan node named `trunk` shares the drift notify's dedupe slot (the
plan does not reserve the id yet). A drift whose ledger trunk commit is missing
still suggests `git update-ref` to that missing commit instead of saying it
cannot be restored. There is no `owed plan --probe` (a dry run of check
commands) and no plan warning for a check mixing cargo and TAP. Still open from
0.5.0: the owner allowance (D21) nits, an ambiguous branch template expanding
to the same name for two attempts, and parent directories left by a failed
dispatch.

## 0.5.0

- **The main agent is the owner; nothing waits on a human by default (D25).**
  Owner acts — plan updates with downgrades, `waive`, `defer`, `adopt`,
  `approve`, owner `evidence`, `init`, decoys, reviews as owner — run with no
  prompt and no dialog and are recorded with the new channel `delegated`. In pi
  the default owner is `owner:pi`. The CLI records `delegated` for owner
  commands (`--as owner:<id>`, or the commands that default to `owner:human`)
  with or without a TTY, so `--i-am-owner` is no longer needed (still accepted;
  it records `flag` as before). Every delegated act that eases acceptance says
  why: `waive`/`defer` `--reason` and `adopt --note` as before, and a plan
  update with downgrades now needs `owed plan --note TEXT` (pi `owed_plan`
  `note`; stored in the plan entry's new optional `note`) — refused without
  one, nothing recorded. `owed brief` starts with *Owner acts (delegated) since
  <since>*, one line per act with its kind, node, what it eased and the reason
  (`--json` `delegated`), and `report` marks such entries `(delegated)`: the
  morning reader audits the hash-chained ledger instead of approving in
  advance. The driver's owner notifications read `<node>: needs the owner (the
  main agent decides; owed lists the command): <reason>; the driver leaves it
  alone; the main agent resolves it with: <commands>`, and its owner halts for
  a stale review block or a stalled candidate end with the same `; the main
  agent resolves it with: <commands>`.
- **`OWED_CONFIRM=owner` restores the confirmation gate** of 0.4.1 (TTY prompt,
  pi dialog; channels `tty`/`pi-confirm`; pi default principal `owner:human`),
  except that the pi dialog waits at most `OWED_CONFIRM_TIMEOUT` seconds
  (default 120, `0` = no limit): a timeout refuses with `Owner confirmation not
  given within <N> s; nothing was recorded.` (code `refused`), an abort of the
  tool call refuses `aborted`, Escape (No) refuses `owner did not confirm;
  action canceled`, and none is read as a confirmation.
- **Subagents never act as owner or parent.** In a process with `DSA_CALL` or
  `DSA_EXEC` set (a pi-durable-subagents call) owed refuses every owner and
  parent act, in pi tools and the CLI alike, before recording anything:
  `owner and parent acts are reserved for the main agent; this process is a
  subagent call (DSA_CALL)`. Reads and `attest` are not refused, writer and
  reviewer roles are unaffected, and `owed drive` (`parent:drive`) is exempt:
  D17 starts the detached driver from dsa calls, and the driver never answers,
  waives, rules, changes the plan or forces anything. This is an accident
  rail, not a security boundary (a process can unset the variables).
- **Worktree location and branch names (D19).** Optional plan block
  `worktrees: {root, branch}`: `root` absolute or relative to the main
  worktree root (default `.owed/wt`), `branch` a template containing `{node}`
  and `{attempt}`, optionally `{type}` (default `owed/{node}/{attempt}`); new
  optional node field `type` (`^[a-z][a-z0-9-]*$`, default `feat`), used only
  by `{type}`. Dispatch creates `<root>/<node>-<attempt>` (recorded as the
  physical path, so writer inference matches git's toplevel under a symlinked
  root) on the expanded branch; a name that fails `git check-ref-format
  --branch`, or a root equal to the main worktree root, refuses (exit 2) before
  any effect. `.git/info/exclude` gets the root (escaped so it matches
  literally) only when it lies inside the main worktree. Submit, rebase, gc,
  the driver and the views read the branch and worktree recorded in the
  dispatch entry instead of reconstructing them. Neither key is an obligation:
  changing them is never a downgrade, invalidates no candidate and affects only
  later dispatches.
- **Trunk checked out in another worktree (D19).** A merge fast-forwards the
  linked worktree that has the trunk branch checked out, and when that
  worktree has uncommitted tracked changes it refuses before trunk moves:
  `trunk worktree <path> has uncommitted changes: commit them there, or detach
  it (git -C <path> switch --detach), then retry`. `owed status`,
  `owed_status` and `/owed` show `Trunk <name> is checked out at <path>; merges
  fast-forward it there (keep it clean).` (`--json` `trunkWorktree`). With a
  root outside the main worktree and the trunk checked out elsewhere,
  dispatch, merge and gc leave the main worktree's HEAD, index and files
  untouched.
- **Execution environment (D20).** Optional plan block `exec: {env, wrap}`.
  Every process owed starts in a materialized tree (setup, check, red,
  strength and invariant runs, attribution reruns) gets
  `{...process.env, ...exec.env, CI: "1", OWED: "1"}` and runs as
  `[...wrap, "bash", "-lc", <command>]`, with the same cwd, process group,
  timeout and abort handling. `env` names match `^[A-Za-z_][A-Za-z0-9_]*$`
  (not `CI` or `OWED`), values are used verbatim; `wrap` is a non-empty argv (a
  relative `wrap[0]` containing a slash resolves against the materialized
  tree). With `exec` set, check, red, strength and invariant keys contain
  `exec: {env?, wrap?}`; without it (or with `exec: {}`) keys are
  byte-identical to 0.4.1. Changing `exec` is owner-only, like changing
  `setup`: it invalidates submitted candidates, attribution reruns use the exec
  of the plan the block was recorded under, and the reducer records the
  downgrade `*: exec changed; cannot prove obligations were not reduced`
  (`wrap: ["true"]` would pass everything). `why` shows `Exec: wrap <argv> ·
  env <NAMES>` (names only). Wrapper contract: run the trailing argv to
  completion in the given cwd and environment, pass output through, exit with
  its exit code, and exit 126 or 127 when it cannot run the command
  (transport, mirror or lease failure). Red runs read 126/127 as `error` and
  any other non-zero code — including a remote `timeout`'s 124 — as a test
  failure, so use `red_expect` with wrappers; a wrapper that runs the command
  elsewhere must bound it there, because owed kills only the local process
  group. README recipes: slot limiter, dsa lease, shared build cache, remote
  host.
- **Owner allowances (D21).** Optional plan block `allow:`, a list of rules:
  `nodes` (id globs, default `["*"]`) with `review_count`, `review_rank`,
  `writes` prefixes and/or `checks` globs, or `adopt` prefixes. A parent plan
  update whose downgrades are all covered by a rule of the **prior** plan is
  accepted without the owner (a reducer rule, so replay checks it too): review
  count/rank lowered not below the rule's bound, writes widened inside its
  prefixes, a check or evidence obligation whose id matches its `checks` globs
  removed or weakened. Never covered: `approve removed`, `node removed`,
  `dependency removed`, trunk invariant downgrades, setup/closure/exec
  changes, and changes of `allow` itself (anything but deleting whole rules is
  the owner-only downgrade `trunk: allow changed`). Covered downgrades still
  enter ΔO⁻ and read `by parent:<id> under allowance (plan #S)`; a refused
  parent update lists the uncovered items. A parent may adopt (`owed adopt
  --as parent:<id>`, pi `owed_adopt` with `as: parent:…`, no prompt or
  dialog) when every changed path lies under an `adopt` prefix of the current
  plan and `adoptGuard` passes; the refusal names the first uncovered path.
  When the writes item fails, `why` lists the out-of-writes paths (first 20;
  `--json` `outOfWrites`) and adds `the parent may widen writes in the plan
  (allowance plan #S)` when an allowance covers them; a ruling never accepts
  them.
- **Rulings reach running calls (D22).** The driver sends parent rulings to
  its writer and reviewer runs that are `running` (never `asking`): a `steer`
  with the new send reason `ruling` (the `send` entry carries `rulings`, the
  highest ruling seq it lists) listing each undelivered in-scope ruling as
  `#<seq> (<nodes>): <text>`, then for a writer `Apply these rulings; they
  override your packet. If you already submitted, fix and submit again.`, for
  a reviewer `Judge the candidate against these rulings and record your review
  with --ack-rulings <seq>.`. Delivered counts the dispatch packet, earlier
  repair messages and ruling sends (writer) or the review packet and ruling
  sends (reviewer). It is the lowest row: still at most one action per node per
  pass, and every other action wins. A dsa rejection (e.g. the call sealed
  meanwhile) is printed, never halts and is never retried; the rulings then
  travel as before. A steer is not an acknowledgment: the `rulings` obligation
  still needs the reviewer's `ack_rulings`.
- **Run names and answer address (D22).** New launches carry dsa's run `name`
  (`owed <node>#<attempt> writer`, `owed <node>#<attempt> reviewer <n>`); a
  re-launch sends its stored spec bytes unchanged (launches recorded before
  0.5.0 have no name). The asking text (halts, drive output, wake-ups)
  addresses each question by dsa's call address `questions[].to`
  (`<wid>/<key>`), else the run id, in both forms: `subagents {action:"send",
  kind:"answer", to, qid, message}` and `pi-durable-subagents send --request
  <id> --to <to> --kind answer --qid <qid> --rev <rev> --message @<file>`.
- **Owner approval and manual evidence (D23).** Node field `approve: owner`
  adds obligation `approve` (keyed by the candidate's patch, like a review),
  discharged only by the owner: `owed approve <node> [--note TEXT] [--block]`
  (pi `owed_approve`); `--block` records an owner block that a later owner
  approval clears. Node field `evidence: [{id, what, by?}]` (`by` reviewer,
  the default, parent or owner; the owner always qualifies) adds obligations
  `evidence:<id>`, discharged by the new entry kind `evidence`: `owed evidence
  <node> <id> --file PATH... --note TEXT [--as role:id]` (pi `owed_evidence`),
  at least one file, each hashed (sha256, bytes) when recorded, by a principal
  of that role who never wrote the node. On a merged node the same command
  records an informational **receipt** (files optional; e.g. npm version,
  dist-tag, tarball sha256), listed by `why` and `report`. Candidate pin: the
  CLI approve preview and the pi `owed_approve`/owner `owed_evidence` dialogs
  pin the candidate they show; a resubmit, rebase or abandon in between
  refuses `candidate changed since confirmation; nothing recorded`. Views
  always mark these manual (`✔ approved (<owner>, <channel>)`, `✔ evidenced
  (manual) by <who>` with files as `path sha12` and the note; the brief counts
  `N manual`), never measured. Downgrades: `approve removed` (owner only, never
  covered by an allowance), `evidence <id> removed` and `evidence <id>
  weakened` (`by` changed to a role other than owner; coverable by an `allow`
  `checks` glob). The driver does everything else first and halts (needs the
  owner for approve, a human for evidence) with the exact command only when
  nothing else remains.
- **Observations are facts about keys (D24).** `owed attest` and the genesis
  attest no longer refuse with `Plan, candidate or trunk changed; retry` when
  the ledger moves while they measure: under the lock each observation is
  appended iff its item is still current, otherwise dropped as superseded and
  listed after the card (`Superseded (not recorded; the item changed while it
  was measured): …`; `AttestResult.superseded`). A plan edit elsewhere
  interrupts nothing. `merge` and `adopt` keep the strict rule.
- **`owed_init`, `owed attest --genesis` (D24).** The pi tool `owed_init
  {plan}` (owner) refuses an initialized ledger, records genesis for the trunk
  commit it resolved (pinned), and returns at once while the genesis attest
  runs in the background in-process (aborted on session shutdown); the session
  gets one `owed-init` message with the recorded, failed and missing ids when
  it ends. `owed attest --genesis` measures the genesis invariants still
  lacking an observation (exit 0 when none is missing, else 1); it takes its
  own `genesis` lock and never blocks node attests. `owed init` exits 0 once
  genesis is recorded; an incomplete genesis attest prints `Initialized
  (genesis #<seq>). Genesis attest incomplete: recorded <ids>; missing <ids>:
  run owed attest --genesis, or the next attest/merge measures them first.` —
  never "retry" (a signal still exits 130/143). While genesis items lack
  observations, `owed status`/`owed_status`/`/owed` show `Genesis: <k>/<n>
  invariants observed` with `(measuring in this session)` or the `owed attest
  --genesis` hint, and `owed plan` succeeds with `Warning: genesis attest
  pending for <ids>`.

**Compatibility.** Plans and ledgers without the new keys (`worktrees`,
`type`, `exec`, `allow`, `approve`, `evidence`) keep 0.4.1's canonical plan and
sha, keys and views; the behaviour changes regardless of keys are the ones
above: owner acts are delegated unless `OWED_CONFIRM=owner`, a delegated
downgrade needs a note, attest drops superseded observations instead of
refusing, and `init` succeeds with an incomplete genesis attest. pi-owed 0.4.x
reading a 0.5 ledger: verify and replay accept `channel: delegated` (0.4.1
never checked channel values) but show no `(delegated)` marker and no delegated
section; they ignore the plan entry's `note` and do not require notes on
delegated downgrades; they ignore `evidence` entries and the plan keys
`worktrees`, `type`, `exec`, `allow`, `approve` and `evidence` — 0.4.x would
dispatch to the default paths, run checks without the wrapper and env, and
drop the approval and evidence obligations, so do not use 0.4.x on a
repository whose plan uses them. 0.4.x refuses to replay (`Entry #N invalid`,
so `owed verify` fails) a ledger containing a parent plan update under an
allowance, a parent adoption, an owner `approve` review or a `ruling` send.
New errors and exit codes: plan errors for the new blocks and an invalid
expanded branch name at dispatch exit 2; the subagent refusal, a delegated
downgrade without a note, the dirty trunk worktree, `candidate changed since
confirmation`, uncovered parent downgrades or adoptions and the confirmation
timeout are refusals (exit 1 / code `refused`); `owed attest --genesis` exits 1
while items are missing; `--as owner:<id>` without a TTY is no longer refused
(only under `OWED_CONFIRM=owner`).

**Known limitations.** Deferred to 0.5.1: The background driver's report and
merge-halt wording still reads `(needs owner)` instead of the D25 wording.
Check processes inherit `DSA_*` from owed's environment (the executor does not
strip them), so an owner or parent owed command inside a check run under a dsa
call is refused. The CLI's default owner id stays `owner:human` (recorded as
`delegated`) while pi uses `owner:pi`. Delivered rulings are inferred from
ledger position, so a ruling recorded while a repair or launch message is being
built can count as delivered without having been carried (the reviewer's
`ack_rulings` obligation is unaffected); 0.5.1 records the ruling seqs each
message carried. Documented limitations: An ambiguous branch template (e.g.
`{node}{attempt}`) can expand to the same name for two attempts (dispatch then
fails in `git worktree add`), and parent directories created by a failed
dispatch stay. A remote wrapper is trusted by its argv: the key names the
wrapper, not where the command ran.

## 0.4.1

- **Signals end the checks a command started.** While `owed attest`, `merge`,
  `init` or `adopt` runs, the first SIGINT/SIGTERM/SIGHUP kills the running
  check's process group, records nothing for that run, starts no further job
  and exits 130 (SIGINT) or 143 (SIGTERM/SIGHUP) after printing
  `Aborted: <signal>`; observations of jobs completed before stay (merge/adopt:
  when the ledger did not move meanwhile), and an abort never moves trunk. So
  `hold machine -- owed attest` releases the lease only after the checks ended.
  130/143 means a real abort only: a signal arriving after the operation
  completed keeps its normal exit code (0/1) and says so on stderr. Signals
  within 1 s of the first are the same request; a later second signal exits at
  once (it may leave the job's temporary worktree; SPEC §10 says how to remove
  it). `owed drive --once` stops at once on the first SIGINT/SIGTERM (its
  attest children and in-process merge checks end too), exit 130. SIGKILL
  remains out of scope.
- The pi tools `owed_attest`, `owed_merge` and `owed_adopt` pass the tool
  call's abort signal (aborting ends the running check; tool error
  `Aborted: aborted`); `owed_drive` (action once) stops its pass after the
  current action.
- `Ledger.withLock` takes an abort signal: an abort while waiting for a lock
  rejects at once with `OwedError('aborted')` and takes nothing (new error
  code `aborted`).
- **Background driver:** `owed drive --detach [--max N]` starts the loop
  driver as a detached process with its output in
  `.git/owed/drive/log.jsonl` (previous log kept as `log.jsonl.1`; the last
  line is an exit record `idle|stopped|killed|error`, absent only after
  SIGKILL or a crash), `owed drive --status [--json]` reports it (running or
  not, last exit record, last 10 log lines), `owed drive --stop [--now]` stops
  it after its current action (`--now`: at once). The pi tool `owed_drive`
  gets `action: once|start|status|stop` (default `once`, unchanged) and `now`;
  after `start`, and in every top-level pi session opened in the repository
  while a driver runs, the session is woken with one message when the driver
  halts, needs the owner, a run asks a question, it is stalled, dsa events
  fail or it exits; the extension reads the driver's log every 2 s without a
  model turn, so no agent has to poll `status`. `/owed` shows whether a
  driver runs.
- **Review blocks that need a parent ruling:** `owed review <node> --block
  --needs-parent` (pi tool `owed_review` with `needs_parent: true`) records
  `needs: "parent"` on a review block (refused on `--ok`). The driver then halts
  (needs human) before any repair until a ruling naming the node
  (`owed rule --nodes <node> "<decision>"`, not `*`) follows the block; the
  next repair carries the ruling, and every repair message lists the rulings
  since dispatch. `owed why` and `owed status` show such current-candidate
  blocks as `(needs a parent ruling)`; the reviewer packet tells reviewers when
  to use the flag.

No new ledger entry kinds. Ledgers containing `needs: "parent"` reviews remain
readable by pi-owed 0.4.0 (it hashes the whole entry and ignores the unknown
field, so `owed verify` passes), but 0.4.0 treats such a block as an ordinary
review block: its driver sends a repair instead of halting, and `why`/`status`
show no hint. Use pi-owed 0.4.1 or later on such ledgers.

## 0.4.0

- **`owed drive [--once] [--max N] [--json]`** (also the pi tool `owed_drive`,
  one pass). Runs the mechanical loop — dispatch, writer, submit, attest,
  reviewers, merge — with pi-durable-subagents as the process runner, as
  principal `parent:drive`, and stops only for decisions: it never answers a
  question, waives, changes the plan or forces a dsa restart. Every intent is
  recorded before the dsa call and retried with the same id and bytes, so a
  kill at any point is safe. Attest runs under `hold machine --shared
  --no-wait`. One driver per repository (`.git/owed/drive.lock`). An optional
  `drive:` block in the plan sets `max`, `repairs` and the writer/reviewer
  agent and model. **Requires pi-durable-subagents >= 1.0.27** (only for
  `owed drive`; the rest of owed does not use it).
- New ledger kinds `launch`, `send` and `halt` (written by the driver).
  `owed status`, `why` and `report` show driver halts and launches; a halt is
  cleared by a later action on the node by anyone other than the driver. A
  halt from dsa rejecting a run or send names the recovery: that attempt's
  request is fixed, so fix the cause and `owed abandon <node>`.
  Ledgers containing these entries need pi-owed 0.4.0 or later.
- Red runs: `min_tests` applies to every non-red run (candidate checks and
  invariants), never to the red run, which needs only a recognizable failure
  (non-zero exit, `red_expect`, not a zero-test run); an unknown count format
  is accepted there. A red run whose command exits 126/127 (not executable /
  not found) is now an `error` observation, not a pass. A spawn failure remains
  an `error` observation.

This release was driven end to end by `owed drive`.

## 0.3.1

- The pi tool `owed_adopt` confirmation dialog lists up to 50 changed paths,
  one per line; beyond that it shows the first 50 and then the exact
  `git diff --no-renames --name-only <prior>..<commit>` command for the full
  list.
- `owed report` lists an adoption once, under trunk adoptions only (no longer
  also under owner actions).
- An adopt refusal names the observation that decides each failing invariant
  (for example `h1 (obs #3)`), also on a repeated adopt of the same commit,
  which measures nothing new and names the existing observation.
- Release commits are now made through an owed node, so trunk no longer moves
  outside owed and no adopt is needed for a release.

## 0.3.0

- **`owed adopt [--commit X] --note TEXT`** (owner only, also the `owed_adopt`
  pi tool). Records commits made outside owed (for example a release commit)
  as the new ledger trunk. Only fast-forwards are accepted; the trunk
  invariants are measured on the adopted commit and no new debt is allowed.
  The CLI prints a preview (range, commit count, changed paths) and pins the
  previewed commit before asking for confirmation.
- `owed status` reports trunk drift between the ledger and the branch,
  including a ledger trunk commit that no longer exists (`ledger-missing`).
- `owed report` lists trunk adoptions as owner decisions.

Ledgers containing `adopt` entries need pi-owed 0.3.0 or later.

## 0.2.0

pi-owed 0.2.0 was developed under owed itself: every change below went through
dispatch, measured checks, counterfactual (red) runs, independent review and a
guarded merge recorded in the project's own ledger.

- **English interface.** All CLI output, receipts, packets and pi tool text are
  in English.
- **`owed brief`**: a morning view of owner decisions, merges, blocks and
  progress since a ledger position.
- **Oracle strength.** A check can declare mutants; the `strength:<check>`
  obligation measures that the check kills them before a candidate is accepted.
- **Escapes and decoys.** `owed escape` records defects found after a merge;
  commit-reveal decoys measure whether review and merge guards catch planted
  faults. Merge results are attributed to the merging node (`merging: <node>`);
  debt already on the trunk before the merge never counts as caught.
- **`owed gc`** (parent/owner only) reclaims finished worktrees and branches and
  pins submitted commits under `refs/owed/keep/<node>/<attempt>/<seq>`.
- **`owed rebase`** moves an open slot to the current trunk in place; the
  candidate is invalidated, blocks stay, and the packet points at the last
  reviewed patch for `git range-diff`.
- **Overlap guard.** `dispatch` refuses a node whose writes overlap an open
  slot unless `--allow-overlap` is given; the overlap is recorded.
- **`plan --rev <commit>`** reads the plan from a commit and records it.
- **`abandon --note`** (`--reason` still accepted).
- **pi tools.** Every tool takes an optional `cwd`; new tools for brief, gc,
  abandon, verify, escape, decoy and rebase. SPEC §11 lists all of them.
- **Fixes.**
  - Dispatch and gc always use the main worktree root, so running owed from
    inside a slot worktree no longer nests worktrees (which gc could delete).
    Submodules and `--separate-git-dir` repositories work from their main
    worktree; from a linked worktree whose main worktree cannot be verified,
    owed refuses before any effect.
  - Owner confirmation dialogs show free text on one escaped line after the
    Repository and Identity lines (control, C1, separator and bidi characters
    are escaped), so a note cannot forge the dialog. The ledger keeps the exact
    text.

## 0.1.0

First release: plan, dispatch, submit, attest, review, merge, rule, waive,
defer, status, why and report over a hash-chained ledger, with a pi extension
and skill.
