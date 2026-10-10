# pi-owed

No receipt, not done.

`owed` is an acceptance ledger for multi-agent task graphs in one Git repository. It records what was actually checked, who reviewed it, what the owner waived, and what remains owed before a merge. Version **0.1 — experimental**.

The main agent is the owner (0.5, delegated owner): a human states the task in natural language and leaves; no human ever has to operate owed. Owner acts (waivers, downgrades, adoptions, approvals) run without a prompt and are recorded with channel `delegated`; every act that eases acceptance (a downgrade, waiver, deferral or adoption) carries a mandatory reason, and an approval may carry a note; `owed brief` starts with every delegated owner act, so accountability is an audit of the hash-chained ledger rather than a pre-approval. Subagent processes (pi-durable-subagents calls) can never act as owner or parent. Set `OWED_CONFIRM=owner` to restore human confirmation.

It provides a CLI, a pi extension, and an agent skill. It is not an agent scheduler, a sandbox, or a replacement for code review. Your agent runner does the work; owed keeps acceptance evidence and guards the merge.

## Install

Requires Node.js 22.19 or later, Git with `merge-tree --write-tree`, and Bash. For pi:

```sh
pi install npm:pi-owed
```

For the standalone CLI:

```sh
npm i -g pi-owed
```

Reload pi after installing. `/owed` shows status; `/owed why <node>` explains an acceptance decision. Tools: `owed_status`, `owed_why`, `owed_report`, `owed_brief`, `owed_verify`, `owed_dispatch`, `owed_submit`, `owed_rebase`, `owed_attest`, `owed_review`, `owed_merge`, `owed_adopt`, `owed_abandon`, `owed_gc`, `owed_rule`, `owed_plan`, `owed_waive`, `owed_defer`, `owed_escape` and `owed_decoy`; each accepts an absolute `cwd` inside the target repository, so a session started elsewhere can drive it (docs/SPEC.md §11 lists the parameters). Owner confirmation dialogs show free text (notes, reasons, rulings, evidence) after the Repository and Identity lines, escaped onto one line. Those dialogs appear only under `OWED_CONFIRM=owner`, and wait at most `OWED_CONFIRM_TIMEOUT` seconds (default 120, `0` = no limit): a timeout records nothing (`Owner confirmation not given within N s; nothing was recorded.`). By default owner tools are delegated to the main agent (`owner:pi`, channel `delegated`, no dialog); `owed_plan` takes `note`, which a delegated downgrade requires. In a pi-durable-subagents call (`DSA_CALL`/`DSA_EXEC` set) owed refuses owner and parent acts in tools and CLI alike — an accident rail, not a security boundary. The `owed` skill describes the full agent workflow. A subagents/dsa runner is a separate integration: dispatch returns a ready-to-use call specification with `agent: worker`, the slot worktree as `cwd`, and `isolation: none`.

## Five-minute quickstart

Use a disposable repository. Git must already have a commit identity configured. Save this plan as `plan.yaml` (also available in the source checkout as `examples/plan.yaml`):

```yaml
version: 1
trunk: main
closure: [plan.yaml]
invariants: []
nodes:
  - id: greeting
    title: Add a greeting
    brief: Create hello.txt containing exactly hello followed by a newline.
    writes: [hello.txt]
    checks:
      - id: content
        run: 'test "$(cat hello.txt)" = hello'
        timeout_s: 10
        reads: [hello.txt]
    review: {count: 1, min_rank: 1}
```

Initialize the repository, commit the plan, and initialize the ledger as its owner (by default the main agent, delegated):

```sh
mkdir owed-demo
cd owed-demo
# Save the plan above as plan.yaml here.
git init -b main
git add plan.yaml
git commit -m "Record acceptance plan"
owed init plan.yaml                # owner act, delegated (OWED_CONFIRM=owner: type yes at the prompt)
owed status
owed dispatch greeting
```

In pi, the main agent (the owner) can instead call the `owed_init` tool (`plan`, optional `cwd`): delegated by default (under
`OWED_CONFIRM=owner` it shows the trunk commit, plan sha, node count and invariants in a confirmation dialog), it records genesis and measures the invariants in the
background, showing progress in `owed_status` and sending one message when done. If a genesis attest stops early
(`Genesis attest incomplete: …`), the ledger is initialized; run `owed attest --genesis`, or let the next
attest/merge measure the missing invariants first.

Dispatch prints the packet and creates `.owed/wt/greeting-1`. Act as the writer in that worktree:

```sh
cd .owed/wt/greeting-1
printf 'hello\n' > hello.txt
git add hello.txt
git commit -m "Add greeting"
owed submit greeting
cd ../../..
owed attest greeting
owed why greeting
```

At this point `attest` exits **1** because the required independent review is still missing, even though the content check passed. Have an independent reviewer inspect the diff and receipt, then record that review using their identity:

```sh
git diff main...owed/greeting/1
owed review greeting --ok --rank 1 --as reviewer:demo-reviewer --note "Inspected greeting and acceptance evidence"
owed merge greeting
owed report
owed verify
```

For this small demonstration a person can perform the independent review. In a real agent workflow use a fresh reviewer who has never been the node's writer; assigning a different name to the writer does not make it independent. The example has no trunk invariants or red check; production plans should declare appropriate ones. The shell check verifies the greeting text; it is not a test-counted suite.

## How acceptance works

- **Items and keys:** an item identifies a subject, an obligation, and a content-derived key. Checks use declared read sets and the pinned check closure. Matching keys allow evidence reuse; relevant changes require fresh evidence.
- **Receipt:** E means evidenced, W means visibly waived by the owner, and D means debt. `why` shows actual logs, counts when available, reviewers, blocks, untested changes, and plan downgrades. Speech and a successful agent exit are not evidence.
- **Blocks:** execution failures and negative reviews survive new candidates. Attribution reruns explain old execution failures. A judgment block requires the original reviewer at sufficient rank, a higher-rank reviewer, or an explicit owner risk waiver. A different reviewer at the same rank cannot clear it. When the brief or plan is ambiguous or contradictory, or the fix needs a product or contract decision, the reviewer records `owed review <node> --block --needs-parent ...`: `why` and `status` show the block as needing a parent ruling, and `owed drive` halts instead of sending the writer a repair until the parent records `owed rule --nodes <node> "<decision>"` (a `*` ruling does not count); the driver then repairs with the ruling quoted.
- **Waivers:** an owner can waive a specific node obligation with a reason and explicit block sequence numbers in `accept_risk`. Waivers remain visible; they do not turn into measured passes. Invariants cannot be waived.
- **Debt:** missing evidence, failures, conflicts, and deferred invariants remain visible in the pending queue. `defer` permits specified invariant debt for one merge; it does not erase it.
- **Oracle strength:** a node check may list `mutants` (globs of patch files inside the closure) and `min_kill` (fraction in (0, 1], default 1). The node then owes `strength:<check id>`: for each mutant patch, read from the base and never from the candidate, owed applies it to the materialized candidate and runs the check. A mutant is killed when the run exits non-zero or reports failing tests; a zero-test run or a patch that does not apply is not a kill. The obligation passes when killed/total reaches `min_kill`; the receipt shows `strength k/n` and the log lists every mutant.
- **Merge guard:** owed tests the prospective merge tree, checks node obligations and invariant debt, then advances the trunk with a compare-and-swap guard. An accepted candidate alone does not guarantee its merge is safe.

`status` groups pending work by owner, parent+writer, reviewer, and executor. Resolve the named obligation with its assigned role. `report --since <sequence-or-ISO-time>` summarizes merges, E/W/D changes, rulings, downgrades, and owner decisions.

`owed brief [--since <sequence-or-ISO-time>] [--json]` is the morning view, one line per item: **Needs your decision** (owner-queue items sorted by how many downstream nodes they transitively block, each with the exact command that discharges it), **Merged** (per merged node: measured and waived obligation counts, reviewed obligations, untested changes, and reviewers; a waived obligation is never counted as measured), **Rejected or blocked** (active blocks with the node, obligation, failing observation sequence, and how to clear them), **In progress** (dispatched and submitted nodes with their age), and a total line (merged / accepted-unmerged / blocked / ready, plus nodes waiting on dependencies). `--since` limits only the Merged section; the other sections always show the current state. `--json` returns the structured view.

Plans are versioned through `owed plan <file>` / `owed_plan`; `owed plan <file> --rev <commit-ish>` reads the file from a commit (for example the plan kept in trunk) and the plan entry records that commit and path. Parents may strengthen or otherwise update a plan; weakening obligations requires an owner decision and remains visible as a downgrade. Pi owner operations require `ctx.ui.confirm`, record `channel: pi-confirm`, and refuse without UI. CLI owner operations prompt on a terminal. The CLI's `--i-am-owner` flag is a weaker human automation channel, recorded visibly; agents must never use it.

## Owner approval, manual evidence and receipts

Some acceptance cannot be measured by a check: an external effect the owner must authorize (an npm publish, a push), or a human look at a real page. A node can declare both:

```yaml
  - id: release
    writes: ["package.json", "CHANGELOG.md"]
    approve: owner                      # obligation approve: only the owner discharges it
    evidence:
      - id: ui                          # obligation evidence:ui
        what: "looked at the page in a real browser"
        by: reviewer                    # reviewer (default), parent or owner; the owner always qualifies
```

`owed approve <node> [--note TEXT] [--block]` (owner: delegated — the main agent approves, optionally with a note, and states it in its report; under OWED_CONFIRM=owner a terminal confirmation or `--i-am-owner`; pi `owed_approve`, under the gate with a dialog showing the node, candidate commit, base and number of changed files) approves the open candidate the owner was shown — if the writer submits another candidate before the confirmation lands, nothing is recorded; `--block` records an owner block that a later owner approval clears. Approval is keyed by the candidate's patch, like a review. `owed evidence <node> <id> --file <path> [--file …] --note TEXT --as reviewer:<id>` (pi `owed_evidence`) records manual evidence: owed hashes every file (sha256 and size) when it records it, and only a principal of the declared role, or the owner, who is not a writer of the node counts. `why` always shows these as manual — `✔ approved (owner:human, tty)`, `✔ evidenced (manual) by reviewer:r1` with each file as `path sha12` and the note — never as measured, and `brief` counts them as `manual`. `owed drive` runs everything else first; when only approve and/or evidence remain it halts (needs the owner — the main agent — for approve, a human or the named role for evidence) with the exact command.

After a merge the same command records a **receipt**, informational evidence of what happened next, for example a publish:

```sh
owed evidence release npm --file pi-owed-0.5.0.tgz --note "0.5.0 published, dist-tag latest"
```

A receipt cites the node's latest merge; files are optional and the note is required. `why` and `report` list receipts. Removing `approve` or an evidence item from a plan (or weakening its `by`) is a downgrade only the owner may make.

## North-star metric: escapes

Acceptance is only as good as what it lets through. When a defect is found after a node was merged, record it against that merge:

```sh
owed escape greeting --merge 12 --class weak --note "check passed for any greeting" --evidence "issue 7"
```

`--class` names how it escaped: `missing` (② an obligation was missing), `false-pass` (①a a false affirmative observation), `reuse` (①b unsound evidence reuse), `weak` (①c a weak oracle) or `waiver` (③ an owner waiver let it through). The merge must be a merge of that node.

To measure the escape rate rather than wait for accidents, the owner can plant decoys: nodes whose work deliberately carries a known defect. Before dispatching them, write `{"nonce": "<at least 16 random characters>", "decoys": [{"node": "...", "defect": "..."}]}` to a file outside the repository, then commit to it without revealing it:

```sh
owed decoy digest decoys.json            # prints the sha256 to commit; writes nothing
owed decoy commit <digest>               # owner; before any listed node is dispatched
owed decoy reveal decoys.json            # owner; later, when the outcome should count
```

A decoy is **caught** if its node received an execution failure or a review block before any merge, or if a merge of it observed a failure (every observation appended by `owed merge <node>` records `merging: <node>`) on an invariant or check that was not already failing on trunk — pre-existing trunk debt, deferred or not, never counts — whether the merge was refused or later went through after an owner deferral. It is **escaped** if it merged without any of these, and **pending** otherwise. `owed report` ends with an Escapes section: counts by class, decoy outcomes and the escape rate, escaped / (caught + escaped).

## Execution environment: env and wrapper

A plan may give every process owed starts in a materialized tree — `setup`, checks, red runs, strength runs, invariants and attribution reruns — extra environment variables and a wrapper:

```yaml
exec:
  env: { CARGO_TARGET_DIR: /abs/shared/target }   # strings, used verbatim (no $VAR expansion); not CI or OWED
  wrap: ["/abs/tmp/qa/heavy.sh"]                   # argv prefix: owed runs [...wrap, "bash", "-lc", <command>]
```

The environment is owed's own (without `NODE_TEST_CONTEXT` and any `DSA_*` variable but `DSA_HOME`, so owed commands inside a check are not refused as subagent acts) plus `exec.env`, then `CI=1 OWED=1`. The wrapper runs in the materialized tree with that environment, in the same process group, under the same timeout and abort handling: owed kills the whole group, wrapper included. **Wrapper contract:** run the trailing argv to completion in the given directory and environment, pass stdout and stderr through, and exit with the command's exit code. When the wrapper cannot run the command (transport, mirror or lease failure) it must exit **126 or 127**: owed reads those as "could not run" (a red run is then `error`), while every other non-zero code counts as a test failure — a red pass unless the check sets `red_expect`. Use `red_expect` on red checks run through a wrapper. A relative `wrap[0]` containing a slash resolves against the materialized tree, not the main worktree; use absolute paths (a bare name is looked up in `PATH`). `exec` is part of every check, red, strength and invariant key, so changing it means fresh evidence; `exec: {}` is the same as no block. Because a wrapper can weaken every check (`wrap: ["true"]` passes everything), changing `exec` is owner-only and shows as a downgrade in ΔO⁻, like `setup`: set it once. `owed why` prints `Exec: wrap <argv> · env <NAMES>` (names, never values).

Test counts come from TAP/node:test, cargo, pytest and jest/vitest summary lines; a log with both cargo `test result:` lines and TAP (one check running `cargo test && node --test --test-reporter=tap`) sums them to one `mixed` count, which `min_tests` checks. A non-red check that exits non-zero with no recognizable count or zero tests (a wrong cargo package name, a missing script) is `fail`, and its note carries the last 5 output lines (shown under the item in `owed why` and in the driver's repair message); exit 126/127 with no count (the command never ran) and an exit-0 run with an unknown count under `min_tests` are `error`. cargo summaries count only at column 0, so a `# test result: …` line inside TAP is not a cargo count.

Recipes (sketches; adapt paths):

- **Slot limiter** — at most 5 heavy runs at once on this machine, `wrap: ["/abs/tmp/qa/heavy.sh"]`:
  ```bash
  #!/bin/bash
  # heavy.sh: hold one of $SLOTS flock slots while the command runs; the lock dies with the process group.
  slots=${SLOTS:-5}; dir=/tmp/qa-slots; mkdir -p "$dir" || exit 127   # cannot run: 127, never a test failure
  while :; do
    for i in $(seq 1 "$slots"); do
      exec 9>"$dir/$i"
      if flock -n 9; then "$@"; exit $?; fi
    done
    sleep 1
  done
  ```
  A single slot is just `wrap: ["flock", "/tmp/qa.lock"]`.
- **dsa machine lease** — share the lease that `pi-durable-subagents` uses for its own heavy work: `wrap: ["pi-durable-subagents", "hold", "machine", "--shared", "--"]`. If `hold` fails before it runs the command, owed sees its exit code: unless that is 126/127, wrap it in a script that maps a lease failure to 127.
- **Shared build cache** — every materialized tree starts without build output; point the build at a shared cache through `env`, e.g. `env: { CARGO_TARGET_DIR: /abs/shared/target }` (or `npm_config_cache`, `GOCACHE`). A cache is a trust input: a poisoned cache can make a check pass, so keep it per user and machine.
- **Remote host** — run checks on another machine:
  ```bash
  #!/bin/bash
  # remote.sh <host> bash -lc <command>: mirror the tree to <host> and run there.
  host=$1; shift; dir=/tmp/owed-remote/$(basename "$PWD")
  rsync -a --delete --exclude .git ./ "$host:$dir/" || exit 127      # mirror failed: could not run
  ssh "$host" "cd $(printf %q "$dir") && export CI=1 OWED=1 && timeout 900 $(printf '%q ' "$@")"
  rc=$?; [ "$rc" -eq 255 ] && exit 127                                  # ssh transport failure: could not run
  exit "$rc"
  ```
  A remote `timeout` exits 124, which owed reads as a test failure (a red pass unless `red_expect` is set); a command that itself exits 255 is indistinguishable from an ssh failure here and becomes 127.
  With `wrap: ["/abs/remote.sh", "ipc"]` the key names the host (the wrapper argv), but owed cannot verify where the command ran, which environment it had or that the remote tree matched. owed only kills the local process group: the wrapper must bound the remote command itself (`timeout`), and it must forward the variables it needs (`exec.env` is not sent over ssh by itself). The mirror has no `.git`, so checks must not need Git.

## Trust boundary and storage

The ledger lives under the Git common directory in `owed/`, shared by the repository's worktrees. Dispatch worktrees live under `.owed/wt/` and are locally excluded from Git. `OWED_DIR` overrides ledger storage for isolated tests.

### Worktree location and branch names

A repository whose rules forbid worktrees inside the main worktree, or prescribe branch names, configures both in the plan:

```yaml
worktrees:
  root: ../dev/wais-worktree          # absolute, or relative to the main worktree root; default .owed/wt
  branch: "{type}/{node}-{attempt}"   # default "owed/{node}/{attempt}"; must contain {node} and {attempt}
nodes:
  - id: auth-api
    type: fix                         # optional, default feat; only fills {type}
```

Dispatch creates `<root>/<node>-<attempt>` (missing parent directories are created) on the templated branch; a name that `git check-ref-format --branch` rejects is refused before anything is written. Only a root inside the main worktree is added to `.git/info/exclude` (`.owed/` for the default root, as before); an outside root adds nothing. Every later command uses the branch and worktree recorded at dispatch, so changing `worktrees` or `type` affects only later dispatches; it is never a downgrade and keeps submitted candidates. The worktree is recorded by its physical path (symlinks in the root resolved), the same path git reports inside it. Dispatch, merge and gc never switch the main worktree's branch or HEAD or touch its tracked files; they do create slot worktrees inside it when the root lies inside it (the default `.owed/wt`), and a merge fast-forwards it when the trunk is checked out there. With a root outside it and the trunk checked out elsewhere, a main worktree with uncommitted user changes stays byte-identical. Glob characters in an inside root are escaped in the exclude line. Limitations: an ambiguous template such as `{node}{attempt}` can produce the same name twice (dispatch then fails), and parent directories created by a failed dispatch are left in place.

If the trunk branch is checked out in another worktree (say `dev` in `../dev/wais-worktree/dev`), `owed status` says `Trunk dev is checked out at <path>; merges fast-forward it there (keep it clean).` A merge fast-forwards that worktree, and refuses while it has uncommitted changes: `trunk worktree <path> has uncommitted changes: commit them there, or detach it (git -C <path> switch --detach), then retry`.

This is a local, same-user trust boundary. It guards against mistakes and lazy cheating through normal tools, not a malicious user with shell access. The hash chain detects edits; it does not prevent them, and a user who controls the files can rewrite the chain. Principal names are workflow assertions, not authenticated accounts. Check commands execute locally with the current user's permissions.

## Parallel slots and a moving trunk

`owed dispatch <node>` refuses when the node's `writes` overlap (path prefix) those of another node with an open slot and names that node; `--allow-overlap` dispatches anyway and records the overlap in the dispatch entry. `owed status` marks ready nodes that overlap an open slot.

When trunk moves under an open slot, there is no need to abandon and redispatch. `owed rebase <node>` (the parent, or the writer inside its worktree) moves the slot base to the current trunk and invalidates the open candidate; the writer then runs the printed `git rebase --onto <new base> <old base>` in the same worktree and submits again. Review blocks still bind the node. `owed why` shows the previously reviewed patch and a hint, `git range-diff <old base>..<old commit> <new base>..<new commit>`, so a reviewer only has to review the conflict resolution.

`owed abandon <node> --note TEXT` closes the open slot with a note.

## Trunk commits made outside owed

Trunk can move without owed: a release commit (version bump, changelog) or a human hotfix committed directly to `main`. owed does not trust a moved ref silently: `owed status` then reports `trunk moved outside owed: … ahead of the ledger trunk by N commits`, and every `owed merge` refuses the trunk CAS and names `owed adopt`. After checking those commits, the owner (the main agent, delegated) records them with a note saying what they are:

```sh
owed adopt --note "release 0.2.0"    # owner, delegated (under OWED_CONFIRM=owner: confirm on the terminal; pi owed_adopt asks in the UI)
```

Before adopting (and before asking for confirmation under `OWED_CONFIRM=owner`) the CLI prints the full prior..commit range, the commit count, every changed path and the note, then adopts exactly that commit: if the ref moves after you confirm, the adoption is refused. `adopt` takes exactly what `refs/heads/<trunk>` points to (`--commit X` must equal it) and only when it is a fast-forward of the ledger trunk. As for a merge there is no new debt: owed measures every invariant whose key changed on the adopted commit; if one that held on the ledger trunk fails there, the adoption is refused, the failing observation is recorded, the refusal names the observation that decides each failing invariant (`h1 (obs #3)`; a repeated adopt of the same commit measures nothing new and names the existing observation) and trunk stays unadopted — fix trunk, then adopt again. Invariant debt that already existed does not block. The `adopt` entry records the prior and adopted commits, the commit count, the changed paths and the note; `owed report` and `owed brief` list it once, as an owner decision (the report's trunk adoptions section, not its owner actions). Under `OWED_CONFIRM=owner` the pi tool `owed_adopt` asks for confirmation with a dialog that lists up to 50 changed paths, one per line; beyond 50 it lists the first 50 and then `… +N more paths; full list: git diff --no-renames --name-only <prior12>..<commit12>`. Open slots are untouched and merge onto the adopted trunk (rebase only on conflicts). Limits: a rewritten or reset trunk cannot be adopted (restore the ref to a descendant of the ledger trunk), and `owed escape` names merges, not adoptions.

## Owner allowances: easing the owner pre-authorized

Even with a delegated owner, every downgrade (a review count lowered, writes widened) or out-of-band trunk commit is an owner act that needs a reason and is listed first in the brief. An `allow:` block in the plan lets the owner say in advance what the parent may do alone:

```yaml
allow:
  - nodes: ["phaseA-*"]          # node id globs; default ["*"]
    review_count: 0              # the parent may lower review.count down to 0
    review_rank: 1               # ... and review.min_rank down to 1
    writes: ["tests/", "docs/"]  # ... widen writes with prefixes inside these
    checks: ["ui-*"]             # ... remove or weaken node checks with these ids
  - adopt: ["testdata/", "tasks/"]   # the parent may adopt trunk commits that only touch these paths
```

A parent plan update (`owed plan`, `owed_plan`) whose downgrades the rules of the **current** plan (the one before the update) all cover needs no owner confirmation. It is still a downgrade: it is listed in ΔO⁻ and every view labels it `by parent:<id> under allowance (plan #S)`, S being the ledger seq of the plan entry that last changed `allow`, so every easing traces to an owner act. Never covered: removing a node or a dependency, weakening trunk invariants, changing setup/closure (or exec), and changing `allow` itself — any change other than deleting whole rules is the owner-only downgrade `trunk: allow changed`. A parent's refusal lists the downgrades no rule covers.

`owed adopt --note TEXT --as parent:<id>` (pi: `owed_adopt` with `as: parent:…`) adopts trunk commits without a prompt when every changed path lies under an `adopt` prefix and the usual no-new-debt guard passes; the refusal names the first path outside. Views show `adopted by parent:<id> under allowance (plan #S)`.

A candidate that changes files outside its writes fails the writes item; `owed why` lists those paths (`Out-of-writes paths: …`, the first 20) and, when a rule covers them all, adds `the parent may widen writes in the plan (allowance plan #S)`. A ruling cannot accept such paths: widening writes is a plan change.

## Reclaiming worktrees

Each dispatch leaves a worktree under `.owed/wt/<node>-<attempt>` of the main worktree (also when dispatched from inside another slot worktree) and a branch `owed/<node>/<attempt>` (or the configured root and branch template, see above). Once an attempt is merged or abandoned, `owed gc` (parent or owner only) reclaims them:

```sh
owed gc --dry-run   # list what would be removed and what is kept, change nothing
owed gc             # remove clean finished worktrees and their branches, then git worktree prune
```

The current open slot is never touched, nor a finished worktree that contains another worktree. A finished worktree with uncommitted or untracked (non-ignored) changes is kept and reported as dirty, together with its branch, so no work is lost; clean or commit it and run `gc` again. Branches of abandoned attempts are deleted even though they were never merged. Before a branch goes, every commit submitted in that attempt that trunk does not already reach is pinned under `refs/owed/keep/<node>/<attempt>/<submit-seq>`, so `git gc` cannot prune it and a later attribution rerun of an old failure still works; `gc` never deletes `refs/owed/keep/*`. Each run that removes or pins something appends a `note` entry to the ledger naming what was removed and pinned; a second run removes and pins nothing, so it appends no note. `--json` returns `{removed:[{node,attempt,worktree,branch,pinned}], kept:[{node,attempt,worktree,branch,reason}]}`, where `worktree`/`branch` in `removed` is `null` when that part was already gone and `pinned` lists the keep refs created (or, with `--dry-run`, that would be created).

## Driving the loop with dsa

`owed drive` runs the mechanical loop — dispatch, writer, submit, attest,
reviewers, merge — with [pi-durable-subagents](https://www.npmjs.com/package/pi-durable-subagents)
(≥ 1.0.27) as the process runner, and stops for decisions. Every intent is
recorded in the ledger before dsa is called and retried with the same bytes and
id, so killing the driver at any point is safe. Attest runs under
`pi-durable-subagents hold machine --shared --no-wait` and is retried later
while the machine is busy; with an older dsa that rejects `--no-wait` the
attempt is halted with that error. One driver per repository
(`.git/owed/drive.lock`); a lock left by a dead driver on this host is taken
over, but a lock from another host is not: check that host, then remove the
file by hand. A first Ctrl-C stops after the current action, a second at once.

```sh
owed drive            # until idle; run it in a terminal or a systemd-run --user unit
owed drive --once     # one pass (also the pi tool owed_drive)
owed drive --detach   # the same loop as a detached background process; prints its pid and log
owed drive --status   # running (pid, host, since) or not, its last exit record, the last 10 log lines
owed drive --stop     # stop it after its current action (--now: at once)
```

`--detach` refuses while a driver holds the lock (naming pid, host, start and
log). Otherwise it keeps the previous log as `.git/owed/drive/log.jsonl.1`,
starts `owed drive --json` in its own session with stdout and stderr appended to
`.git/owed/drive/log.jsonl` and returns once that driver holds the lock; if it
has not taken the lock within 30 s, `--detach` stops it (SIGTERM), prints the
log tail and exits 1. A concurrent `--detach` or `--stop` waits until that is
decided. The log's last line is the exit record
`{"event":"exit","code":C,"reason":"idle|stopped|killed|error","at":…}`; only
SIGKILL or a crash leave none, and `--status` then says it ended without an exit
record (an empty log says `no driver output yet`). The exit record is written
before the lock is released, so once `--stop` says `stopped` it is in the log.
`--stop` signals the lock's pid only when its process start time matches
(never a reused pid, never another host). In pi, `owed_drive` with `action:
"start"` does the same, and the session is woken with one message when the
driver halts, needs the owner, a run asks a question, it is stalled, dsa events
fail or the driver exits (merges ride along with the next message; every halt
wakes, also one with the same text as an earlier one). Every top-level pi
session opened in the repository later follows a running driver from then on
and is woken too; sessions inside a dsa call (`DSA_EXEC`/`DSA_CALL` set, e.g.
dsa writers and reviewers in the repository's worktrees) do not attach by
themselves (an explicit start still follows). Nobody has to poll
`action: "status"`; `action: "stop"` stops it. The driver survives pi exiting.
The driver carries no dsa call identity (`DSA_EXEC` and `DSA_CALL` are removed
from its environment; `DSA_HOME` and the rest are kept). Started from inside a
dsa call, start still works but prints `note: started from inside a dsa call; if
that call's processes are contained, the driver may end with it — prefer
starting it from a top-level session or systemd-run --user`.

With pi-durable-subagents ≥ 1.0.31 the driver's runs are listed in the pi
session that started it: owed reads `DSA_SESSION` (ignored inside a dsa call),
records it in `drive.lock`, hands it to a detached driver and passes
`--session <id>` to every `run`. `owed drive --status`, `/owed` and
`owed_drive` status say `runs are listed in pi session <id>`, or `no pi
session: runs show only in pi-durable-subagents status / the CLI` for a driver
started outside pi. An older dsa that refuses `--session` is used without it
(one log line, never a halt). To move a repository's runs to another pi session,
stop the driver and start it from that session; earlier runs stay where they were.

The driver never answers a question, waives, changes the plan or forces a dsa
restart: questions and owner decisions are printed, and a halt (`owed status`,
`owed why`) waits for an action on the node by the main agent (the delegated owner;
owner halts list the command that resolves them). A ruling, submit, review,
rebase or abandon on the node clears a halt, and the next pass resumes. A ruling recorded while a
driver-launched writer or reviewer call is running reaches it as a steer
(reason `ruling`, recorded) once the node has nothing else to do; sealed calls
get rulings with the next repair, and reviewers still acknowledge them with
`--ack-rulings`. Launch entries and repair follow-ups record the rulings their
message carried, so a ruling recorded while one is being sent is steered
afterwards. Calls you launched by hand stay yours to steer. Driver calls
carry a dsa run name (`owed <node>#<attempt> writer` / `owed <node>#<attempt>
reviewer <n>`). An asking call is printed with dsa's answer address and both
answer forms: the pi `subagents` send call (`to`, `qid`) and the CLI command. A halt
from dsa rejecting a run or send is the exception: that request's id and bytes
are fixed for the attempt and dsa rejects it again, so fix the cause (plan,
agent, model) and run `owed abandon <node>`; the driver then dispatches a new
attempt.

## Development

```sh
npm install
npm run typecheck
npm run build
node --test --test-concurrency=2 'test/**/*.test.ts'
npm pack --dry-run
```

The package ships compiled `dist/`, its entry point, CLI, skill, docs, and license. Source checkouts can load `index.js` with pi; it prefers the built extension when present. Delete `dist/` after packing when you work from source, or the CLI and extension keep using the stale build. See `docs/SPEC.md` for the acceptance rules and `docs/MODULES.md` for module contracts.
