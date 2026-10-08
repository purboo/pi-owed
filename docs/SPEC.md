# owed MVP specification (parent-pinned, v0.1)

owed is the acceptance ledger for a multi-agent task graph in one git repository.
"No receipt, not done": a node counts as done only when every obligation on its
current candidate is observed by a trusted executor or an authorized reviewer,
or is visibly waived by the owner. The design follows `pi-dag/ARCHITECTURE.md`
(a3) and `formal/a4/CONTRACT.md` (a4.1 rulings). This MVP implements the M0–M2
subset. Threat model: same OS user; owed prevents mistakes, laziness and
reward-hacking shortcuts by agents using the normal tools. It does not resist a
process that edits the ledger file directly; it detects such edits (hash chain).

## 1. Storage

- Ledger directory: `$(git rev-parse --git-common-dir)/owed/` (shared by all
  worktrees, never committed). Override with env `OWED_DIR` (tests).
- `ledger.jsonl`: one JSON object per line, append-only. Every entry has
  `{seq, ts, prev, kind, by, ...payload}`. `seq` starts at 0 (genesis) and
  increments by 1. `prev` = `hash` of the previous entry (genesis: 64 zeros).
  `hash(entry)` = sha256 hex of the canonical JSON (keys sorted recursively) of
  the entry **without** a `hash` field; the stored line also contains `hash`.
- `blobs/<sha256>`: content-addressed blobs (plans, logs, dispatch packets).
- `lock/`: mutual exclusion by atomic `mkdir`; contains `owner.json`
  `{pid, host, ts}`. A lock whose pid is dead on the same host is stale and may be
  broken. All read-check-append sequences run under the lock (§6.4).
- Every append: re-read ledger, verify chain tail, check guard, append the line
  with `fsync`, release.

## 2. Principals

`Principal = {role, id}`; `role ∈ owner | parent | writer | reviewer | executor`.
String form `role:id` (e.g. `owner:human`, `parent:main`, `writer:auth-api#2`,
`reviewer:astra-1`, `executor:owed`).

- Writers are created by dispatch: `writer:<node>#<attempt>`.
- The executor is owed itself; only `owed attest`/`owed merge` produce executor
  observations.
- Owner acts require a human channel, recorded as `channel`:
  `tty` (interactive confirmation), `pi-confirm` (pi UI confirmation),
  `flag` (`--i-am-owner`, shown as weaker in every view). Agents must never use
  the flag; the skill says so.

## 3. Plan (content, YAML)

```yaml
version: 1
trunk: main                    # branch name of the trunk
closure: [".owed/**", "package.json", "**/conftest.py"]  # check-closure path globs (pinned from base)
setup: "npm ci --prefer-offline"   # optional, run in every materialized tree before checks
invariants:                    # state invariants on trunk (machine checks)
  - id: unit
    run: "npm test"
    timeout_s: 600
    reads: ["**"]              # declared read set (globs); default ["**"]
    min_tests: 1               # optional; parsed test count must be >= this
nodes:
  - id: auth-api
    title: "Add token refresh"
    deps: [schema]
    writes: ["src/auth/", "test/auth/"]   # path prefixes the node may change
    checks:                    # node acceptance checks (become invariants after merge only if listed in invariants)
      - id: auth-tests
        run: "node --test test/auth"
        timeout_s: 300
        reads: ["src/auth/**", "test/auth/**"]
        red: true              # counterfactual: these tests must FAIL on the base with candidate test files overlaid
        tests: ["test/auth/**"]   # files overlaid onto base for the red run (required if red)
        red_expect: "not ok|AssertionError"   # optional regex the red-run log must match
        min_tests: 1
    review: {count: 1, min_rank: 1}   # default {count: 0}
    brief: |                   # free text included in the dispatch packet
      ...
```

Validation: unique ids; deps exist; acyclic; `red: true` requires `tests`;
`writes` non-empty for nodes with checks. Plan changes are laws (§5) by owner or
parent. Removing or weakening an obligation of a node relative to the previous
plan (check removed, `red` turned off, `min_tests` lowered, review count/rank
lowered, writes widened) is a **downgrade**: allowed only to the owner, and
listed in reports as ΔO⁻.

## 4. Items and keys

An item is `(subject, obligation, key)`; status is evaluated per item.
All keys are sha256 hex over canonical JSON.

- `readsDigest(commit, globs)` = sha256 of the sorted list of `[path, blobOid]`
  for files of `commit` matching any glob (whole-tree `**` may use the tree OID).
- `closureDigest(base)` = `readsDigest(base, plan.closure)`.
- Check item key on tree-bearing commit C with base B:
  `H({o:"check", id, run, timeout_s, setup, min_tests, closure: closureDigest(B), reads: readsDigest(C, reads)})`.
  Because keys use content, a merge commit whose tree equals the candidate's
  tree reuses the candidate's observations automatically.
- Red item key: `H({o:"red", id, run, red_expect, closure: closureDigest(B), base: treeOid(B), tests: readsDigest(C, tests)})`.
- Writes item key: `H({o:"writes", base: B, cand: C, writes})`.
- Closure-review item (exists iff diff(B,C) touches a closure glob):
  `H({o:"closure-review", patch: patchId(B,C)})`.
- Review item key: `H({o:"review", patch: patchId(B,C)})` where `patchId` is
  `git patch-id --stable` of `git diff B C` (empty diff → sha256 of "").
- Rulings item: `H({o:"rulings", attempt})` (§5.6).
- Invariant item on trunk state S: `H({o:"inv", id, run, timeout_s, setup, min_tests, closure: closureDigest(S), reads: readsDigest(S, reads)})`.

## 5. Ledger entry kinds

| kind | by | payload | effect |
|---|---|---|---|
| `genesis` | owner | `{trunk, commit, plan}` (plan = blob sha) | names s₀ and the plan |
| `plan` | owner/parent | `{prior, plan}` | new plan; must cite current plan sha (CAS); downgrade needs owner |
| `rule` | owner/parent | `{text, nodes: string[] \| "*"}` | ruling; in scope for those nodes |
| `dispatch` | parent | `{node, attempt, base, branch, worktree, packet, rulings_seen: number}` | opens writer slot; `rulings_seen` = seq of latest ruling in packet |
| `submit` | writer | `{node, attempt, commit}` | candidate claim (speech) |
| `obs` | executor | `{subject, obligation, key, verdict, exit, counts?, log, durationMs, commit, base, attribution?}` | trusted observation |
| `review` | reviewer/owner | `{node, attempt, key, verdict: "ok"\|"block", rank, note, ack_rulings?: number, clears?: number[]}` | judgment observation on review/closure-review item |
| `waive` | owner | `{node, obligation, key, reason, accept_risk?: number[]}` | waiver of one item; accept_risk cites block seqs it knowingly overrides |
| `defer` | owner | `{node, items: {id, key}[], reason}` | deferral of invariant items for one merge (stays debt) |
| `abandon` | parent/owner | `{node, attempt, reason}` | closes a writer slot |
| `merge` | executor | `{node, attempt, prior, commit, tree}` | trunk advanced (CAS on prior) |
| `note` | any | `{text}` | speech, no effect |

`verdict` for `obs` ∈ `pass | fail | error`. `error` (timeout, crash of the
harness, materialization failure) is ⊥: no information, no block.

## 6. Reducer (pure: entries → State)

### 6.1 Node lifecycle
- `ready` ⟺ every dep has a `merge` entry, node not merged, no open slot.
- `dispatch` requires ready (or a closed previous attempt) and parent/owner.
- `submit` requires an open slot whose writer is `by`, and the commit to be a
  descendant of the slot base.
- Node `accepted` ⟺ current candidate has every node obligation in E ∪ W and no
  active block (§6.3). Node `merged` after a `merge` entry.

### 6.2 Node obligations on candidate C (base B = slot base)
1. `check:<id>` for each check; executor observation.
2. `red:<id>` for each check with `red: true`; executor observation: the red run
   (base tree + candidate `tests` files + pinned closure) must exit non-zero,
   match `red_expect` if given, and not be a zero-test run. Verdict `pass` means
   "the counterfactual was rejected as specified".
3. `writes`: every path in `diff --name-only B C` starts with a `writes` prefix.
4. `closure-review` iff the diff touches closure globs: needs a review `ok` with
   rank ≥ 2 by a non-writer, or an owner waiver.
5. `review` iff `review.count > 0`: needs `count` distinct reviewers with rank ≥
   `min_rank`, none of them a writer of this node (any attempt).
6. `rulings`: satisfied iff the attempt's `rulings_seen` ≥ the latest in-scope
   `rule` seq, or a later `review ok` by rank ≥ 1 with `ack_rulings` ≥ that seq.

### 6.3 Status of an item
- Executor verdicts on the same item join in the lattice ⊥ < pass, fail < ⊤
  (pass and fail both present = ⊤). E ⟺ lattice value is `pass`.
- Review items: E ⟺ required reviews `ok` on the current key (rank, count,
  recusal) and no active judgment block.
- **Blocks (封)**: a `fail` obs or a `review block` on node n, obligation o
  (any key, any attempt) creates an active block on (n, o).
  - Execution block (from `obs fail` on key k): cleared by a later executor obs
    on the **same key k** with `attribution: true`. If that rerun fails, the
    failure is deterministic for the old content and the block clears. If it
    passes, key k is ⊤ and the block becomes **flaky**: only an owner `waive`
    with `accept_risk` citing it clears it.
  - Judgment block (review block of rank r): cleared by a later `review ok` on
    the **current key** of that item with rank ≥ r (the same reviewer may clear
    it), or an owner `waive` with `accept_risk` citing it.
  - A waiver or ok on another key never clears a block (a4.1 ruling 1).
- W ⟺ item not in E, owner `waive` on the same key, and every active block on
  (n, o) is cited in its `accept_risk`. Invariant items are never in W.
- D = O ∖ (E ∪ W); each D item gets a discharger:
  `executor` (⊥, needs attest), `writer` (fail on current key), `reviewer`
  (review missing), `owner` (flaky ⊤, judgment blocks without a higher
  reviewer, closure review, downgrade, deferral).

### 6.4 Merge guard (evaluated under the lock)
For node n with accepted candidate C, trunk PRE, merge commit M (tree from
`git merge-tree --write-tree PRE C`, parents [PRE, C], committed with
`git commit-tree`):
1. `merge` cites `prior` = current trunk commit (CAS) and the trunk ref still
   equals PRE (`git update-ref refs/heads/<trunk> M PRE`).
2. Node obligations hold on M: `check:*` items keyed on M (reuse when the key
   equals the candidate's), `writes` re-evaluated on diff(PRE, M), all other node
   items from the candidate.
3. **No new debt**: for each invariant i, key on M; if equal to its key on PRE
   the status is inherited; otherwise it must be E on M, or covered by an owner
   `defer` for this node (then it stays in D, shown as deferred).
4. Genesis observation finished: every invariant has a non-⊥ obs on s₀'s key.
The merge entry is appended in the same locked step as the guard evaluation.
Conflicts in merge-tree → the merge is refused with a `writer` debt
"rebase needed".

## 7. Executor (attest)

`attest(node)` for the current candidate:
1. For each active execution block of the node, rerun its original item first
   (attribution) using the commit/base recorded in the failing obs.
2. Materialize C clean: `git worktree add --detach <tmp> <C>`; restore closure
   globs from B (files in B overwrite; closure files only in C are deleted);
   run `setup`; run each check with `bash -lc`, a timeout (kill process group),
   env `CI=1 OWED=1`; capture combined output to a blob; parse test counts
   (TAP `# pass N`/`# tests N`, node:test, pytest `N passed`, cargo
   `test result: ok. N passed`); zero tests with a known format = fail;
   `min_tests` unmet = fail; unknown format with `min_tests` set = error.
3. Red runs: materialize B, overlay candidate `tests` files, restore closure
   from B, run; pass iff exit ≠ 0 and not zero-test and `red_expect` matches.
4. Writes / closure-touch computed from `git diff --name-only B C`.
5. Skip an item whose key already has an executor verdict (reuse), unless
   `--rerun`.
6. Remove the temporary worktree. Append one `obs` per item under the lock.

## 8. Operations (src/ops.ts) — the single API used by CLI and pi extension

```ts
init(o: {cwd, plan: string, as: Principal, channel}): Promise<InitResult>      // genesis + genesis attest of invariants
planSet(o: {cwd, plan, as, channel?}): Promise<Entry>
rule(o: {cwd, text, nodes, as}): Promise<Entry>
dispatch(o: {cwd, node, as}): Promise<DispatchPacket>   // creates branch owed/<node>/<attempt> at trunk + worktree <repo>/.owed-wt/<node>-<attempt>
submit(o: {cwd, node, commit?, as}): Promise<Entry>      // default commit = HEAD of the slot worktree; must be clean
attest(o: {cwd, node, rerun?: boolean}): Promise<AttestResult>
review(o: {cwd, node, verdict, rank, note, as, ack_rulings?, obligation?: "review"|"closure-review"}): Promise<Entry>
waive(o: {cwd, node, obligation, reason, accept_risk?, as, channel}): Promise<Entry>
defer(o: {cwd, node, items, reason, as, channel}): Promise<Entry>
abandon(o: {cwd, node, reason, as}): Promise<Entry>
merge(o: {cwd, node, as}): Promise<MergeResult>          // builds M, attests M, guarded CAS
status(o: {cwd}): Promise<StatusView>
why(o: {cwd, node}): Promise<ReceiptCard>
report(o: {cwd, since?: number | string}): Promise<Report>
verify(o: {cwd}): Promise<VerifyResult>                  // hash chain + replay
```

## 9. Views

- **Receipt card** (`why`): per obligation: ✔ 实测 (executor pass, with log
  sha, counts, duration), ✔ 评审 (reviewers), ⚠ 免 (owner, reason, channel),
  ✘ 拒收, ⊥ 待观察, ⊤ 冲突, ⏸ 缓判, 封 (active blocks and how to clear them).
  Also "未测": obligations absent relative to the plan baseline (downgrades) and
  the node's changed files not matched by any passing check's `reads`.
- **Status**: trunk, nodes by state, ready list (sorted by number of transitive
  dependents), pending queue grouped by discharger (owner / parent+writer /
  reviewer / executor), invariant debt on trunk.
- **Report** (`report --since`): merges, new E/W/D, blocks, downgrades, rulings,
  owner decisions needed — written in plain language.

## 10. CLI

`owed <command> [args] [--json]`; commands mirror §8: `init <plan.yaml>`,
`plan <plan.yaml>`, `rule <text> --nodes a,b|*`, `dispatch <node>`,
`submit <node> [--commit X]`, `attest <node> [--rerun]`,
`review <node> --ok|--block --rank N --as reviewer:ID [--note] [--ack-rulings]`,
`waive <node> <obligation> --reason ... [--accept-risk 12,15]`,
`defer <node> <inv-id...> --reason`, `abandon <node>`, `merge <node>`, `status`,
`why <node>`, `report [--since seq|ISO]`, `verify`.
`--as role:id` sets the principal (default `parent:cli`; `submit` defaults to
the slot's writer when run inside its worktree). Owner commands prompt on a TTY
unless `--i-am-owner` (recorded as `channel: flag`). Exit codes: 0 ok, 1 refused
by a guard (message says which obligation), 2 usage error, 3 internal error.

## 11. pi extension

Tools (exposure direct): `owed_status`, `owed_why`, `owed_dispatch` (returns the
packet plus a ready-to-use `subagents` call spec: agent `worker`, cwd = slot
worktree, isolation `none`, task = packet), `owed_attest`, `owed_review`,
`owed_merge`, `owed_report`, `owed_rule`. Owner-only operations (`waive`,
`defer`, downgrade plans) are tools that call `ctx.ui.confirm` and are recorded
with `channel: "pi-confirm"`; without UI they refuse. Command `/owed` shows
status. A skill (`skills/owed/SKILL.md`) explains the loop: status → dispatch →
run worker with dsa → submit → attest → review (fresh reviewer, not the writer)
→ merge, and the rules agents must not break.
