# pi-owed

No receipt, not done.

`owed` is an acceptance ledger for multi-agent task graphs in one Git repository. It records what was actually checked, who reviewed it, what the owner waived, and what remains owed before a merge. Version **0.1 — experimental**.

The main agent is the owner (0.5, delegated owner): a human states the task in natural language and leaves; no human ever has to operate owed. Owner acts (waivers, downgrades, adoptions, approvals) run without a prompt and are recorded with channel `delegated`; every act that eases acceptance (a downgrade, waiver, deferral or adoption) carries a mandatory reason, and an approval may carry a note; `owed brief` starts with every delegated owner act, so accountability is an audit of the hash-chained ledger rather than a pre-approval. Subagent processes (pi-durable-subagents calls) can never act as owner or parent. Owner acts are recorded as `owner:pi` from pi and `owner:cli` from the CLI (0.5.1; earlier CLI versions recorded `owner:human`; pass `--as owner:human` to keep that id). Set `OWED_CONFIRM=owner` to restore human confirmation (then the default owner is `owner:human`).

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

Reload pi after installing. `/owed` shows status; `/owed why <node>` explains an acceptance decision. Tools: `owed_status`, `owed_why`, `owed_report`, `owed_brief`, `owed_verify`, `owed_dispatch`, `owed_submit`, `owed_rebase`, `owed_attest`, `owed_review`, `owed_merge`, `owed_adopt`, `owed_abandon`, `owed_gc`, `owed_rule`, `owed_plan`, `owed_waive`, `owed_defer`, `owed_escape` and `owed_decoy`; each accepts an absolute `cwd` inside the target repository, so a session started elsewhere can drive it (docs/SPEC.md §11 lists the parameters). Owner confirmation dialogs show free text (notes, reasons, rulings, evidence) after the Repository and Identity lines, escaped onto one line. Those dialogs appear only under `OWED_CONFIRM=owner`, and wait at most `OWED_CONFIRM_TIMEOUT` seconds (default 120, `0` = no limit): a timeout records nothing (`Owner confirmation not given within N s; nothing was recorded.`). By default owner tools are delegated to the main agent (`owner:pi`, channel `delegated`, no dialog); `owed_plan` takes `note`, which a delegated downgrade requires. In a pi-durable-subagents call (`DSA_CALL`/`DSA_EXEC` set) owed refuses owner and parent acts in tools and CLI alike, and refuses a review or evidence on a node from inside that node's open slot worktree (run reviews from the repository root) — accident rails, not security boundaries. `parent:drive` is the driver's identity only: `--as parent:drive` / `as: "parent:drive"` is refused, and the ledger refuses entries by it other than dispatch, launch, send, halt and rebase. The `owed` skill describes the full agent workflow. A subagents/dsa runner is a separate integration: dispatch returns a ready-to-use call specification with `agent: worker`, the slot worktree as `cwd`, and `isolation: none`.

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
- **Superseded blocks:** when a plan update changes a check's definition (the check spec with all its fields, `setup` or `exec`) or removes the check, the execution blocks recorded under the old definition become `superseded`: they no longer block, get no attribution rerun and need no waiver. The new definition must still pass on the current candidate. `why`, `status` and `report` show each one as `#<seq> superseded by plan #<p> (check <id> definition changed)` (or `removed`). Only a parent or owner can change a definition, and weakening a check is still an owner downgrade. A block whose definition did not change goes flaky as before.
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

`owed approve <node> [--note TEXT] [--block]` (owner: delegated — the main agent approves, optionally with a note, and states it in its report; under OWED_CONFIRM=owner a terminal confirmation or `--i-am-owner`; pi `owed_approve`, under the gate with a dialog showing the node, candidate commit, base and number of changed files) approves the open candidate the owner was shown — if the writer submits another candidate before the confirmation lands, nothing is recorded; `--block` records an owner block that a later owner approval clears. Approval is keyed by the candidate's patch, like a review. `owed review`, `owed waive`, `owed approve` and `owed evidence` (pi: the `candidate` parameter) take `--candidate <commit>` (40 hex or a prefix of at least 7): the act records only while that commit is still the node's open candidate, otherwise `candidate changed: you named …, the open candidate is #<seq> <commit12>; nothing recorded`. Delegated owners and reviewers pass the commit they actually read, so a resubmit between reading and acting fails instead of landing on content nobody judged; every command owed suggests (brief, why, driver halts and notifications, review packets) carries it. Under `OWED_CONFIRM=owner` the waive and owner-review confirmations show and pin the candidate as approve's does. `owed evidence <node> <id> --file <path> [--file …] --note TEXT --as reviewer:<id>` (pi `owed_evidence`) records manual evidence: owed hashes every file (sha256 and size) when it records it, and only a principal of the declared role, or the owner, who is not a writer of the node counts. `why` always shows these as manual — `✔ approved (owner:human, tty)`, `✔ evidenced (manual) by reviewer:r1` with each file as `path sha12` and the note — never as measured, and `brief` counts them as `manual`. `owed drive` runs everything else first; when only approve and/or evidence remain it halts (needs the owner — the main agent — for approve, a human or the named role for evidence) with the exact command.

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

The environment is owed's own (without `NODE_TEST_CONTEXT` and any `DSA_*` variable but `DSA_HOME`, so owed commands inside a check are not refused as subagent acts) plus `exec.env`, then `CI=1 OWED=1`. The wrapper runs in the materialized tree with that environment, in the same process group, under the same timeout and abort handling: owed kills the whole group, wrapper included. **Wrapper contract:** run the trailing argv to completion in the given directory and environment, pass stdout and stderr through, and exit with the command's exit code. When the wrapper cannot run the command (transport, mirror or lease failure) it must exit **126 or 127**: owed reads those as "could not run" (a red run is then `error`), while every other non-zero code counts as a test failure — a red pass unless the check sets `red_expect`. Use `red_expect` on red checks run through a wrapper. A relative `wrap[0]` containing a slash resolves against the materialized tree, not the main worktree; use absolute paths (a bare name is looked up in `PATH`). `exec.env` and `exec.wrap` are part of every check, red, strength and invariant key, so changing them means fresh evidence (`parallel` and `trees` are not, see below); `exec: {}` is the same as no block. Because a wrapper can weaken every check (`wrap: ["true"]` passes everything), changing `env` or `wrap` is owner-only and shows as a downgrade in ΔO⁻, like `setup`: set it once. `owed why` prints `Exec: wrap <argv> · env <NAMES>` (names, never values).

### Faster merges: `exec.parallel` and `exec.trees` (0.9)

```yaml
exec:
  parallel: 4      # jobs one merge / adopt / genesis attest measures at once (default 1)
  trees: reuse     # stable measurement worktrees instead of a fresh /tmp tree per run (default fresh)
```

`parallel` runs a merge's invariant and merge-result checks side by side instead of one after another; observations are still recorded in job order, and an abort kills every running job. Node attests stay serial (the driver already attests nodes in parallel). `trees: reuse` measures each check in a stable detached worktree `<git common dir>/owed/trees/<kind>-<check id>-<k>`, leased by a pid lock file so concurrent runs of one check get different trees. Before each run owed does `git checkout --detach --force <commit>` and `git clean -ffdx`, then empties each submodule (gitlink) directory inside the tree, never running `git submodule` or touching your config, so your own submodules stay initialized: the content equals a fresh tree (no untracked or ignored file survives), but the path and the mtimes of unchanged files do, so a build cache outside the tree (a shared `CARGO_TARGET_DIR` in `exec.env`) builds incrementally. A tree that cannot be prepared falls back to a fresh one with a note in the log. Neither field is part of any key: changing them re-measures nothing, invalidates no candidate and needs no owner. `owed gc` removes free reuse trees once the plan stops reusing or their check is gone (`--dry-run` lists them). Parallel cargo builds sharing one `CARGO_TARGET_DIR` serialize on cargo's lock: give heavy invariants separate target dirs, or accept that they wait for each other.

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
- **Checks prepare their own artifacts** — owed measures in a fresh temporary worktree of the candidate or merge tree, so nothing that exists only in slot worktrees (build outputs, caches, `node_modules`) is present. A check or invariant must prepare its own build artifacts, for example through `setup` or its `run` command. When a failure was environmental and the parent fixes the check, that plan update supersedes the old block: no rerun and no owner waiver.
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

Dispatch creates `<root>/<node>-<attempt>` (missing parent directories are created) on the templated branch; a name that `git check-ref-format --branch` rejects is refused before anything is written. Only a root inside the main worktree is added to `.git/info/exclude` (`.owed/` for the default root, as before); an outside root adds nothing. Every later command uses the branch and worktree recorded at dispatch, so changing `worktrees` or `type` affects only later dispatches; it is never a downgrade and keeps submitted candidates. The worktree is recorded by its physical path (symlinks in the root resolved), the same path git reports inside it. Dispatch, merge and gc never switch the main worktree's branch or HEAD or touch its tracked files; they do create slot worktrees inside it when the root lies inside it (the default `.owed/wt`), and a merge fast-forwards it when the trunk is checked out there. With a root outside it and the trunk checked out elsewhere, a main worktree with uncommitted user changes stays byte-identical. Glob characters in an inside root are escaped in the exclude line. A new plan is refused when `root` or the template contains a control character, or when the template is ambiguous (two (node, attempt) pairs could give the same name): `{node}` must occur exactly once, and each `{attempt}` or `{type}` must be separated from it by a character that cannot occur in that value (such as `/`), so `{node}{attempt}` (`a1`+`1` and `a`+`11` both give `a11`) is refused; a ledger whose recorded plan has such a template stays readable, and gc keeps a branch name recorded for more than one attempt. A dispatch that fails removes the parent directories it created.

If the trunk branch is checked out in another worktree (say `dev` in `../dev/wais-worktree/dev`), `owed status` says `Trunk dev is checked out at <path>; merges fast-forward it there (keep it clean).` A merge fast-forwards that worktree, and refuses while it has uncommitted changes: `trunk worktree <path> has uncommitted changes: commit them there, or detach it (git -C <path> switch --detach), then retry`.

This is a local, same-user trust boundary. It guards against mistakes and lazy cheating through normal tools, not a malicious user with shell access. The hash chain detects edits; it does not prevent them, and a user who controls the files can rewrite the chain. Principal names are workflow assertions, not authenticated accounts. Check commands execute locally with the current user's permissions.

## Parallel slots and a moving trunk

`owed dispatch` and `owed plan` retry a failed compare-and-swap (CAS) up to three attempts in total when the ledger plan sha is unchanged. Each attempt reads fresh state; dispatch finishes its rollback before trying again. A changed plan, a failed rollback, or the third CAS failure returns the refusal with its original error class and exit code. Dispatch rollback uses `git update-ref -d refs/heads/<branch> <base>` to compare the tip and delete atomically, regardless of the main worktree's HEAD. A ref that moved is kept and the CAS failure is reported under the existing `git branch -d` rollback label. A branch still checked out in a worktree is kept too.

`owed dispatch <node>` refuses when the node's `writes` overlap (path prefix) those of another node with an open slot and names that node; `--allow-overlap` dispatches anyway and records the overlap in the dispatch entry. `owed status` marks ready nodes that overlap an open slot.

When trunk moves under an open slot, there is no need to abandon and redispatch. `owed rebase <node>` (the parent, or the writer inside its worktree) moves the slot base to the current trunk and invalidates the open candidate; the writer then runs the printed `git rebase --onto <new base> <old base>` in the same worktree and submits again. Review blocks still bind the node. `owed why` shows the previously reviewed patch and a hint, `git range-diff <old base>..<old commit> <new base>..<new commit>`, so a reviewer only has to review the conflict resolution.

A plan change that alters a node's spec, `setup`, `exec` or `closure` invalidates its open candidate, because the keys were computed under the old plan. Since 0.10, when the node's spec changed only in `checks`, `writes`, `type` or `drive` (plan-wide `setup`, `exec` and `closure` changes do not matter), `owed plan` carries the candidate in the same lock: it appends a carry submit by `executor:owed` for the same commit at the same base with keys recomputed under the new plan, and prints `Carried <node>: …` (a carry it cannot make, e.g. the commit is gone, prints `Not carried <node>: <reason>` and JSON `notCarried`; that candidate stays invalidated). Reviews and other evidence on unchanged keys still count; the next attest measures only the changed checks (or `writes`). `owed why` and `owed status` show `candidate #C carried by plan #P from submit #S`. Any other change (`brief`, `deps`, `review`, `title`, `approve`, `evidence`) still needs the writer to submit again, and the driver tells it so: `plan #P changed this node's spec (<fields>); resubmit …` (reason `submit`), not a rebase. A ledger with a carry submit needs owed ≥ 0.10.0 to replay.

`owed abandon <node> --note TEXT` closes the open slot with a note.

## Trunk commits made outside owed

Trunk can move without owed: a release commit (version bump, changelog) or a human hotfix committed directly to `main`. owed does not trust a moved ref silently: `owed status` then reports `trunk moved outside owed: … ahead of the ledger trunk by N commits`, and every `owed merge` refuses the trunk CAS and names `owed adopt`. After checking those commits, the owner (the main agent, delegated) records them with a note saying what they are:

```sh
owed adopt --note "release 0.2.0"    # owner, delegated (under OWED_CONFIRM=owner: confirm on the terminal; pi owed_adopt asks in the UI)
```

Before adopting (and before asking for confirmation under `OWED_CONFIRM=owner`) the CLI prints the full prior..commit range, the commit count, every changed path and the note, then adopts exactly that commit: if the ref moves after you confirm, the adoption is refused. `adopt` takes exactly what `refs/heads/<trunk>` points to (`--commit X` must equal it) and only when it is a fast-forward of the ledger trunk. As for a merge there is no new debt: owed measures every invariant whose key changed on the adopted commit; if one that held on the ledger trunk fails there, the adoption is refused, the failing observation is recorded, the refusal names the observation that decides each failing invariant (`h1 (obs #3)`; a repeated adopt of the same commit measures nothing new and names the existing observation) and trunk stays unadopted — fix trunk, then adopt again. Invariant debt that already existed does not block. The `adopt` entry records the prior and adopted commits, the commit count, the changed paths and the note; `owed report` and `owed brief` list it once: an owner adoption as an owner decision (the report's trunk adoptions section, not its owner actions), a parent adoption under allowance in its own adoptions section. Under `OWED_CONFIRM=owner` the pi tool `owed_adopt` asks for confirmation with a dialog that lists up to 50 changed paths, one per line; beyond 50 it lists the first 50 and then `… +N more paths; full list: git diff --no-renames --name-only <prior12>..<commit12>`. Open slots are untouched and merge onto the adopted trunk (rebase only on conflicts). Limits: a rewritten or reset trunk cannot be adopted (restore the ref to a descendant of the ledger trunk), and `owed escape` names merges, not adoptions.

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

A parent plan update (`owed plan`, `owed_plan`) whose downgrades the rules of the **current** plan (the one before the update) all cover needs no owner confirmation. It is still a downgrade: it is listed in ΔO⁻ and every view labels it `by parent:<id> under allowance (plan #S)`, S being the ledger seq of the plan entry that last changed `allow`, so every easing traces to an owner act. Never covered: removing a node or a dependency, weakening trunk invariants, changing setup/closure (or exec), and changing `allow` itself — any change other than deleting whole rules is the owner-only downgrade `trunk: allow changed`. A parent's refusal lists the downgrades no rule covers, each once; when they only widen writes it adds one line with a ready-to-paste rule for the next plan: `hint: an allow rule {nodes: ["KB4"], writes: ["<new prefixes>"]} in the prior plan would cover this`. `owed brief` lists the downgrades recorded under allowance since `since` with the same label.

Recipe: keep writes strict by default, and at plan time pre-authorize the `writes` prefixes that integration and packaging nodes tend to need (entry files, `package.json`, wiring directories):

```yaml
allow: [{nodes: ["KB*", "A9-*"], writes: ["app/src/entry/", "package.json"]}]
```

A writer's writes question on such a node then costs one parent plan update and no owner step.

`owed init` and `owed plan` warn, without refusing or recording anything, for each node of the new plan with no checks and no evidence obligations: `warning: node <id> has no checks: its acceptance rests on review alone`. The CLI prints the warnings after the result; `--json`, `owed_init` and `owed_plan` return them as `warnings: string[]`. They also warn about a check (or invariant) with `min_tests` that runs its command in a shell loop (`for/while/until … do`, `seq N`): owed counts only the last TAP (`# tests`), jest/vitest (`Tests:`) or pytest (`N passed`) summary of the log, i.e. one run, not the sum (only cargo `test result:` lines add up), so such a loop does not raise the count.

`owed adopt --note TEXT --as parent:<id>` (pi: `owed_adopt` with `as: parent:…`) adopts trunk commits without a prompt when every changed path lies under an `adopt` prefix and the usual no-new-debt guard passes; the refusal names the first path outside. Views show `adopted by parent:<id> under allowance (plan #S)`.

A candidate that changes files outside its writes fails the writes item; `owed why` lists those paths (`Out-of-writes paths: …`, the first 20) and, when a rule covers them all, adds `the parent may widen writes in the plan (allowance plan #S)`. A ruling cannot accept such paths: widening writes is a plan change.

A changed check definition refusal names the changed fields (`run`, `timeout_s`, `reads`, `tests`, `red_expect`). Owed cannot compare commands: the change needs owner authority or a matching check allowance; adding the command as a new check id avoids replacing the existing check. This explanation does not change which edits count as downgrades.

On `owed plan`, both check-less and loop warnings skip nodes already merged in the ledger. Invariant warnings and all `owed init` warnings are unchanged.

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
file by hand. Attests and merges run in the background while the driver
serves other nodes (at most `drive.measure` at once, default 2, and one merge).
A first Ctrl-C stops after the current action and waits for them, a second
stops at once.

```sh
owed drive            # until idle; run it in a terminal or a systemd-run --user unit
owed drive --once     # one pass (also the pi tool owed_drive)
owed drive --detach   # the same loop as a detached background process; prints its pid and log
owed drive --detach --stay   # when idle, keep running and wait for ledger changes (a growing plan)
owed drive --status   # running (pid, host, since) or not, its last exit record, the last 10 log lines
owed drive --stop     # stop it after its current action and in-flight measurements (--now: at once)
```

The plan's optional `drive:` block sets the writer and reviewer dsa agents
(and models) for every node; a node may override them with its own `drive`
(0.7.0), e.g. to route routine nodes to cheaper models:

```yaml
drive:
  writer:   { agent: worker,   model: "example/model-large:high" }
  reviewer: { agent: reviewer, model: "example/model-large:high" }
nodes:
  - id: docs-pass
    drive:
      writer:   { agent: worker-cheap }            # agent set: replaces the plan's writer (its own default model)
      reviewer: { model: "example/model-small" }   # model only: the plan's reviewer agent with this model
```

A node `drive` is not an obligation: changing it is never a downgrade, keeps
the submitted candidate and affects only later launches (a re-launch resends
the recorded bytes). `owed why <node>` shows
`Drive: writer <agent> (<model>) · reviewer <agent> (<model>)` for a node that
sets it. owed 0.6.x ignores a node's `drive` and launches with the plan's drive.

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
fail or the driver exits (merges ride along with the next message). One wake
per new fact: a halt or notify of a node wakes again only when its text changed
or the ledger gained entries for that node not written by the driver (e.g. the
writer resubmitted, a ruling); otherwise it only rides along with the next
message as `<text> (repeat n, no new ledger entries)`. Trunk moved outside owed is
not a halt: the driver merges nothing and notifies once per change with
`owed adopt --note "<why>"` (or the `git update-ref` that restores a rewound
trunk); after the adopt its next pass merges. Every top-level pi
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

In pi a wake is never handed to the session while its agent is running: the
follower holds it until the agent settles, then drops what was resolved
meanwhile (a question no longer open in dsa, a node line whose node gained
ledger entries) and delivers the rest, ending with `(<n> wake(s) resolved before
delivery)`; if nothing is left the session is not woken. With `--stay`
(`owed_drive` `stay: true`) an idle driver does not exit: it wakes the session
once (`idle: nothing open and nothing ready; staying until the ledger changes
(owed drive --stop ends it)`), keeps the lock and resumes when the ledger
changes (a plan update, a ruling); `--status` then says `idle, waiting for
ledger changes since <at>`. After `owed plan` / `owed_plan`, when nodes are
ready to dispatch and no driver runs, the output adds `ready: <ids> (<n>); no
driver is running: owed drive --detach --stay` (pi: `owed_drive
{action:"start", stay:true}`); nothing starts automatically.

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
rebase, abandon or resume on the node clears a halt, and the next pass resumes. A ruling recorded while a
driver-launched writer or reviewer call is running reaches it as a steer
(reason `ruling`, recorded) once the node has nothing else to do; sealed calls
get rulings with the next follow-up (submit, rebase and repair follow-ups list
the undelivered rulings first; a ruling steer dsa rejected, e.g. because the call
had just ended, counts as undelivered), and reviewers still acknowledge them with
`--ack-rulings`. Launch entries and follow-ups record the rulings their
message carried, so a ruling recorded while one is being sent is steered
afterwards. A ruling naming the node gives the attempt a fresh repair budget
(`repairs` counts the repairs since the latest such ruling or plan change of the
node's spec), and a sealed writer the driver would otherwise halt for (finished
without submitting, repairs exhausted) gets it as one `ruling`
follow-up instead; never while a reviewer run of the candidate is running or
when the candidate has no block. Since 0.8 a due ruling comes before any other
halt too: a sealed writer gets it before the owner-needed notify (a flaky block,
a rank 2 review block), before the `sealed <status>` halt and before the
`stalled:` halt; when a stalled candidate owes only the `rulings`
acknowledgment, its sealed reviewer gets the ruling as a follow-up (or a new
reviewer is launched) and its ok with `--ack-rulings` lets the node merge.
Each ruling is sent once; if the node still needs the owner afterwards, the
notify or halt follows as usual. A flaky block's hints also offer `owed rule
"<what the writer must change>" --nodes <node>` for when the check or test
itself must change. A check that ran the same number of passing
tests twice, below its `min_tests`, halts for the parent (`the plan's threshold
may be wrong`) instead of another repair. Calls you launched by hand stay yours to steer. Driver calls
carry a dsa run name (`owed <node>#<attempt> writer` / `owed <node>#<attempt>
reviewer <n>`). An asking call is printed with dsa's answer address and both
answer forms: the pi `subagents` send call (`to`, `qid`) and the CLI command. A halt
from dsa rejecting a run or send is the exception: that request's id and bytes
are fixed for the attempt and dsa rejects it again, so fix the cause (plan,
agent, model) and run `owed abandon <node>`; the driver then dispatches a new
attempt. Halts that name a driver run also give dsa's call address
(`to:"<wid>/<key>"`) when dsa reported one, so you can steer or inspect the call.

### Resume or rule? (0.8)

`owed resume <node> --note "<why>"` (pi `owed_resume`, parent or owner) clears a
halt without creating anything to acknowledge, and gives the attempt a fresh
repair budget: use it for "measure again", "retry the merge, the disk was full",
"go on". `owed resume <node> --after <other> --note "<why>"` makes the node wait
(`owed status`: `waiting for <other> (resume #<seq>)`; the driver leaves it alone
except for questions) until `<other>` merges; then the driver carries on, and the
writer's next follow-up starts with `The parent resumed this node (#<seq>) after
<other> merged at <commit>: <why>`. Use `owed rule --nodes <node> "<decision>"`
instead when the writer and reviewers must follow and acknowledge a decision (a
changed requirement, a contract answer): a ruling is an obligation, a resume is
not. owed 0.7.x cannot read a ledger with a `resume` entry: upgrade the CLI, the
pi extension and every driver together.

## Development

```sh
npm install
npm run typecheck
npm run build
node --test --test-concurrency=2 'test/**/*.test.ts'
npm pack --dry-run
```

The package ships compiled `dist/`, its entry point, CLI, skill, docs, and license. Source checkouts can load `index.js` with pi; it prefers the built extension when present. Delete `dist/` after packing when you work from source, or the CLI and extension keep using the stale build. See `docs/SPEC.md` for the acceptance rules and `docs/MODULES.md` for module contracts.
