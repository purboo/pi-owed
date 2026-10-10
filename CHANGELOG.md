# Changelog

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
