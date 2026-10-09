# Changelog

## 0.4.1

- **Signals end the checks a command started.** While `owed attest`, `merge`,
  `init` or `adopt` runs, the first SIGINT/SIGTERM/SIGHUP kills the running
  check's process group, records nothing for that run, starts no further job
  and exits 130 (SIGINT) or 143 (SIGTERM/SIGHUP) after printing
  `Aborted: <signal>`; observations of jobs completed before stay, and an abort
  never moves trunk. So `hold machine -- owed attest` releases the lease only
  after the checks ended. 130/143 means a real abort only: a signal arriving
  after the operation completed keeps its normal exit code (0/1) and says so on
  stderr. Signals within 1 s of the first are the same request; a later second
  signal exits at once (it may leave the job's temporary worktree; SPEC §10
  says how to remove it). `owed drive --once` stops at once on the first
  SIGINT/SIGTERM (its attest children and in-process merge checks end too),
  exit 130. SIGKILL remains out of scope.
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
  line is an exit record `idle|stopped|killed|error`), `owed drive --status
  [--json]` reports it (running or not, last exit record, last 10 log lines),
  `owed drive --stop [--now]` stops it after its current action (`--now`: at
  once). The pi tool `owed_drive` gets `action: once|start|status|stop`
  (default `once`, unchanged) and `now`; after `start`, and in every
  top-level pi session opened in the repository while a driver runs, the
  session is woken with one message when the driver halts, needs the owner, a
  run asks a question, it is stalled, dsa events fail or it exits. No polling.
  `/owed` shows whether a driver runs.
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
