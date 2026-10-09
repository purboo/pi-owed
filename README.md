# pi-owed

No receipt, not done.

`owed` is an acceptance ledger for multi-agent task graphs in one Git repository. It records what was actually checked, who reviewed it, what the owner waived, and what remains owed before a merge. Version **0.1 — experimental**.

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

Reload pi after installing. `/owed` shows status; `/owed why <node>` explains an acceptance decision. Tools: `owed_status`, `owed_why`, `owed_report`, `owed_brief`, `owed_verify`, `owed_dispatch`, `owed_submit`, `owed_rebase`, `owed_attest`, `owed_review`, `owed_merge`, `owed_abandon`, `owed_gc`, `owed_rule`, `owed_plan`, `owed_waive`, `owed_defer`, `owed_escape` and `owed_decoy`; each accepts an absolute `cwd` inside the target repository, so a session started elsewhere can drive it (docs/SPEC.md §11 lists the parameters). Owner confirmation dialogs show free text (notes, reasons, rulings, evidence) after the Repository and Identity lines, escaped onto one line. The `owed` skill describes the full agent workflow. A subagents/dsa runner is a separate integration: dispatch returns a ready-to-use call specification with `agent: worker`, the slot worktree as `cwd`, and `isolation: none`.

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

Initialize the repository, commit the plan, and initialize the ledger as its human owner:

```sh
mkdir owed-demo
cd owed-demo
# Save the plan above as plan.yaml here.
git init -b main
git add plan.yaml
git commit -m "Record acceptance plan"
owed init plan.yaml                # Type yes at the owner confirmation prompt.
owed status
owed dispatch greeting
```

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
- **Blocks:** execution failures and negative reviews survive new candidates. Attribution reruns explain old execution failures. A judgment block requires the original reviewer at sufficient rank, a higher-rank reviewer, or an explicit owner risk waiver. A different reviewer at the same rank cannot clear it.
- **Waivers:** an owner can waive a specific node obligation with a reason and explicit block sequence numbers in `accept_risk`. Waivers remain visible; they do not turn into measured passes. Invariants cannot be waived.
- **Debt:** missing evidence, failures, conflicts, and deferred invariants remain visible in the pending queue. `defer` permits specified invariant debt for one merge; it does not erase it.
- **Oracle strength:** a node check may list `mutants` (globs of patch files inside the closure) and `min_kill` (fraction in (0, 1], default 1). The node then owes `strength:<check id>`: for each mutant patch, read from the base and never from the candidate, owed applies it to the materialized candidate and runs the check. A mutant is killed when the run exits non-zero or reports failing tests; a zero-test run or a patch that does not apply is not a kill. The obligation passes when killed/total reaches `min_kill`; the receipt shows `strength k/n` and the log lists every mutant.
- **Merge guard:** owed tests the prospective merge tree, checks node obligations and invariant debt, then advances the trunk with a compare-and-swap guard. An accepted candidate alone does not guarantee its merge is safe.

`status` groups pending work by owner, parent+writer, reviewer, and executor. Resolve the named obligation with its assigned role. `report --since <sequence-or-ISO-time>` summarizes merges, E/W/D changes, rulings, downgrades, and owner decisions.

`owed brief [--since <sequence-or-ISO-time>] [--json]` is the morning view, one line per item: **Needs your decision** (owner-queue items sorted by how many downstream nodes they transitively block, each with the exact command that discharges it), **Merged** (per merged node: measured and waived obligation counts, reviewed obligations, untested changes, and reviewers; a waived obligation is never counted as measured), **Rejected or blocked** (active blocks with the node, obligation, failing observation sequence, and how to clear them), **In progress** (dispatched and submitted nodes with their age), and a total line (merged / accepted-unmerged / blocked / ready, plus nodes waiting on dependencies). `--since` limits only the Merged section; the other sections always show the current state. `--json` returns the structured view.

Plans are versioned through `owed plan <file>` / `owed_plan`; `owed plan <file> --rev <commit-ish>` reads the file from a commit (for example the plan kept in trunk) and the plan entry records that commit and path. Parents may strengthen or otherwise update a plan; weakening obligations requires an owner decision and remains visible as a downgrade. Pi owner operations require `ctx.ui.confirm`, record `channel: pi-confirm`, and refuse without UI. CLI owner operations prompt on a terminal. The CLI's `--i-am-owner` flag is a weaker human automation channel, recorded visibly; agents must never use it.

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

## Trust boundary and storage

The ledger lives under the Git common directory in `owed/`, shared by the repository's worktrees. Dispatch worktrees live under `.owed/wt/` and are locally excluded from Git. `OWED_DIR` overrides ledger storage for isolated tests.

This is a local, same-user trust boundary. It guards against mistakes and lazy cheating through normal tools, not a malicious user with shell access. The hash chain detects edits; it does not prevent them, and a user who controls the files can rewrite the chain. Principal names are workflow assertions, not authenticated accounts. Check commands execute locally with the current user's permissions.

## Parallel slots and a moving trunk

`owed dispatch <node>` refuses when the node's `writes` overlap (path prefix) those of another node with an open slot and names that node; `--allow-overlap` dispatches anyway and records the overlap in the dispatch entry. `owed status` marks ready nodes that overlap an open slot.

When trunk moves under an open slot, there is no need to abandon and redispatch. `owed rebase <node>` (the parent, or the writer inside its worktree) moves the slot base to the current trunk and invalidates the open candidate; the writer then runs the printed `git rebase --onto <new base> <old base>` in the same worktree and submits again. Review blocks still bind the node. `owed why` shows the previously reviewed patch and a hint, `git range-diff <old base>..<old commit> <new base>..<new commit>`, so a reviewer only has to review the conflict resolution.

`owed abandon <node> --note TEXT` closes the open slot with a note.

## Reclaiming worktrees

Each dispatch leaves a worktree under `.owed/wt/<node>-<attempt>` of the main worktree (also when dispatched from inside another slot worktree) and a branch `owed/<node>/<attempt>`. Once an attempt is merged or abandoned, `owed gc` (parent or owner only) reclaims them:

```sh
owed gc --dry-run   # list what would be removed and what is kept, change nothing
owed gc             # remove clean finished worktrees and their branches, then git worktree prune
```

The current open slot is never touched, nor a finished worktree that contains another worktree. A finished worktree with uncommitted or untracked (non-ignored) changes is kept and reported as dirty, together with its branch, so no work is lost; clean or commit it and run `gc` again. Branches of abandoned attempts are deleted even though they were never merged. Before a branch goes, every commit submitted in that attempt that trunk does not already reach is pinned under `refs/owed/keep/<node>/<attempt>/<submit-seq>`, so `git gc` cannot prune it and a later attribution rerun of an old failure still works; `gc` never deletes `refs/owed/keep/*`. Each run that removes or pins something appends a `note` entry to the ledger naming what was removed and pinned; a second run removes and pins nothing, so it appends no note. `--json` returns `{removed:[{node,attempt,worktree,branch,pinned}], kept:[{node,attempt,worktree,branch,reason}]}`, where `worktree`/`branch` in `removed` is `null` when that part was already gone and `pinned` lists the keep refs created (or, with `--dry-run`, that would be created).

## Development

```sh
npm install
npm run typecheck
npm run build
node --test --test-concurrency=2 'test/**/*.test.ts'
npm pack --dry-run
```

The package ships compiled `dist/`, its entry point, CLI, skill, docs, and license. Source checkouts can load `index.js` with pi; it prefers the built extension when present. Delete `dist/` after packing when you work from source, or the CLI and extension keep using the stale build. See `docs/SPEC.md` for the acceptance rules and `docs/MODULES.md` for module contracts.
