# Changelog

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
