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

Reload pi after installing. `/owed` shows status; `/owed why <node>` explains an acceptance decision. Tools include `owed_status`, `owed_why`, `owed_dispatch`, `owed_submit`, `owed_attest`, `owed_review`, `owed_merge`, `owed_report`, `owed_rule`, `owed_plan`, `owed_waive`, and `owed_defer`. The `owed` skill describes the full agent workflow. A subagents/dsa runner is a separate integration: dispatch returns a ready-to-use call specification with `agent: worker`, the slot worktree as `cwd`, and `isolation: none`.

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
- **Merge guard:** owed tests the prospective merge tree, checks node obligations and invariant debt, then advances the trunk with a compare-and-swap guard. An accepted candidate alone does not guarantee its merge is safe.

`status` groups pending work by owner, parent+writer, reviewer, and executor. Resolve the named obligation with its assigned role. `report --since <sequence-or-ISO-time>` summarizes merges, E/W/D changes, rulings, downgrades, and owner decisions.

Plans are versioned through `owed plan <file>` / `owed_plan`. Parents may strengthen or otherwise update a plan; weakening obligations requires an owner decision and remains visible as a downgrade. Pi owner operations require `ctx.ui.confirm`, record `channel: pi-confirm`, and refuse without UI. CLI owner operations prompt on a terminal. The CLI's `--i-am-owner` flag is a weaker human automation channel, recorded visibly; agents must never use it.

## Trust boundary and storage

The ledger lives under the Git common directory in `owed/`, shared by the repository's worktrees. Dispatch worktrees live under `.owed/wt/` and are locally excluded from Git. `OWED_DIR` overrides ledger storage for isolated tests.

This is a local, same-user trust boundary. It guards against mistakes and lazy cheating through normal tools, not a malicious user with shell access. The hash chain detects edits; it does not prevent them, and a user who controls the files can rewrite the chain. Principal names are workflow assertions, not authenticated accounts. Check commands execute locally with the current user's permissions.

## Development

```sh
npm install
npm run typecheck
npm run build
node --test --test-concurrency=2 'test/**/*.test.ts'
npm pack --dry-run
```

The package ships compiled `dist/`, its entry point, CLI, skill, docs, and license. Source checkouts can load `index.js` with pi; it prefers the built extension when present. Delete `dist/` after packing when you work from source, or the CLI and extension keep using the stale build. See `docs/SPEC.md` for the acceptance rules and `docs/MODULES.md` for module contracts.
