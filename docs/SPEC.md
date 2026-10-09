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
        mutants: [".owed/mutants/auth/*.patch"]   # optional: mutant patch globs inside the closure (read from the base)
        min_kill: 0.8          # optional, in (0, 1], default 1: fraction of mutants the check must kill
    review: {count: 1, min_rank: 1}   # default {count: 0}
    brief: |                   # free text included in the dispatch packet
      ...
```

A plan change that alters a node's spec, `setup` or `closure` invalidates that
node's submitted candidate: the writer must submit again so keys are recomputed.
Invariants removed by the owner no longer need their genesis observation.

Validation: unique ids; deps exist; acyclic; `red: true` requires `tests`;
`writes` non-empty for nodes with checks; `mutants` (node checks only, non-empty)
must lie inside the closure — each glob, read as a path, matches a closure glob,
and a glob containing `**` needs a closure prefix (`dir/` or `dir/**`) covering
it; `min_kill` requires `mutants` and lies in (0, 1]. Removing `mutants` or
lowering `min_kill` is a downgrade. Plan changes are laws (§5) by owner or
parent. Removing or weakening an obligation of a node relative to the previous
plan (check removed, `red` turned off, `min_tests` lowered, review count/rank
lowered, writes widened) is a **downgrade**: allowed only to the owner, and
listed in reports as ΔO⁻.

## 4. Items and keys

An item is `(subject, obligation, key)`; status is evaluated per item.
All keys are sha256 hex over canonical JSON.

- `readsDigest(commit, globs)` = sha256 of the sorted list of `[path, mode, blobOid]`
  for files of `commit` matching any glob (the mode is content: an executable bit
  or symlink changes behavior).
- `closureDigest(base)` = `readsDigest(base, plan.closure)`.
- Check item key on tree-bearing commit C with base B:
  `H({o:"check", id, run, timeout_s, setup, min_tests, closure: closureDigest(B), reads: readsDigest(C, reads)})`.
  Because keys use content, a merge commit whose tree equals the candidate's
  tree reuses the candidate's observations automatically.
- Red item key: `H({o:"red", id, run, red_expect, timeout_s, setup, min_tests, closure: closureDigest(B), base: treeOid(B), tests: readsDigest(C, tests)})`.
- Strength item key (checks with `mutants`):
  `H({o:"strength", id, run, timeout_s, setup, min_tests, min_kill, closure: closureDigest(B), mutants: mutantsDigest(B), reads: readsDigest(C, reads)})`,
  where `mutantsDigest(B)` = `readsDigest` over the files of B matching both
  `mutants` and the closure. It changes when the candidate's read set, the check
  or any mutant changes.
- Writes item key: `H({o:"writes", base: B, cand: C, writes})`.
- Closure-review item (exists iff diff(B,C) touches a closure glob):
  `H({o:"closure-review", patch})`.
- Review item key: `H({o:"review", patch})` where `patch` = sha256 of the exact
  bytes of `git diff --binary --full-index --no-renames B C` (empty diff → sha256
  of ""). Not `git patch-id`: it ignores whitespace, which can change meaning.
- Check ids may contain `:`; an obligation name splits only at its first colon.
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
| `escape` | parent/owner | `{node, merge, class, note, evidence?}` | defect found after a merge (§6.5); `merge` must be the seq of a merge of `node` |
| `decoy-commit` | owner | `{digest}` | commitment to a hidden decoy list (§6.5); 64 lowercase hex, not previously committed |
| `decoy-reveal` | owner | `{nonce, decoys: {node, defect}[]}` | opens an earlier unrevealed commitment (§6.5) |

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
7. `strength:<id>` for each check with `mutants`; executor observation (§7):
   `pass` means the check killed at least `min_kill` of the base's mutants. A
   `fail` is an execution block like any other. On merge it keeps the candidate's key.

### 6.3 Status of an item
- Executor verdicts on the same item join in the lattice ⊥ < pass, fail < ⊤
  (pass and fail both present = ⊤). E ⟺ lattice value is `pass`.
- Review items: E ⟺ required reviews `ok` on the current key (rank, count,
  recusal) and no active judgment block.
- **Blocks (⛔ blocked)**: a `fail` obs or a `review block` on node n, obligation o
  (any key, any attempt) creates an active block on (n, o).
  - Execution block (from `obs fail` on key k): cleared by a later executor obs
    on the **same key k** with `attribution: true`. If that rerun fails, the
    failure is deterministic for the old content and the block clears. If it
    passes, key k is ⊤ and the block becomes **flaky**: only an owner `waive`
    with `accept_risk` citing it clears it.
  - Judgment block (review block of rank r by reviewer A): cleared by a later
    `review ok` on the **current key** of that item either by A with rank ≥ r or
    by anyone with rank > r (owner = 3), or by an owner `waive` with
    `accept_risk` citing it. A same-rank ok by a different reviewer is a dissent:
    the block stays and the item goes to the owner (a4.1 ruling 5).
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

### 6.5 Escapes and decoys (north-star metric)
- An **escape** is a defect found after node n was merged. `class` names the
  escape class: `missing` ② (an obligation that should have existed was
  missing), `false-pass` ①a (a false affirmative observation), `reuse` ①b
  (unsound evidence reuse), `weak` ①c (a weak oracle), `waiver` ③ (an owner
  waiver let it through). Refused unless `merge` is the seq of a `merge` entry
  whose node is n; `note` must be non-empty; `evidence` is optional text.
  `state.escapes` lists them in ledger order.
- `escape`, `decoy-commit` and `decoy-reveal` entries carry exactly the fields
  of the entry table (plus `kind`, `by`, `channel` and the ledger-assigned
  `seq`, `ts`, `prev`, `hash`); any other field is refused.
- **Decoys** measure what escapes when nobody knows which nodes are planted.
  The owner first records `decoy-commit {digest}` with
  `digest = sha256(canonical({nonce, decoys: [{node, defect}]}))` (§1 canonical
  JSON; only those fields). `nonce` is ≥ 16 characters, `decoys` non-empty with
  distinct existing nodes and non-empty `defect`. The payload stays outside the
  ledger and the repository until the reveal.
- `decoy-reveal` is refused unless its payload hashes to an earlier
  **unrevealed** `decoy-commit` whose seq is lower than the first `dispatch` of
  every listed node (nodes not yet dispatched qualify). A commitment is revealed
  once.
- `state.decoys` gives each revealed decoy an outcome, judged on the whole
  ledger (entries before and after the reveal):
  `caught` — an executor `obs` with verdict `fail` (execution block or
  rejecting obs) or a `review` with verdict `block` (judgment block) on the node
  before any merge of it. Current limit: a failure observed only while merging
  the node (an invariant on the merge result, subject `trunk`) is not attributed
  to the decoy yet, so such a decoy stays `pending` after a refused merge and
  becomes `escaped` on a later merge (the node flow will record which merge an
  obs belongs to). `escaped` — a merge of
  the node with no such entry before it; `pending` — neither yet. `decidedBy` is
  the deciding seq.
- A node listed in more than one reveal counts once: the decoy of the earliest
  commitment (lowest `decoy-commit` seq) wins, whatever the order of the reveals.
  `state.decoyCommits` lists commitments and the seq that revealed them.
- Metrics (report): escape counts by class; decoys caught / escaped / pending;
  unrevealed commitments; **escape rate** = escaped / (caught + escaped), n/a
  while no decoy is decided. These are cumulative over the whole ledger.

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
4. Strength runs (`strength:<id>`, checks with `mutants`): the mutants are the
   files of B matching `mutants` and the closure, read from B (never from C);
   none → `error`. For each mutant: materialize C, restore closure from B as for
   the check, `git apply` the patch (one that does not apply counts as not
   killed and is reported), run `setup`, run the check command. Killed iff
   (exit ≠ 0, a timeout included, or failing tests > 0) and the run is not
   zero-test. Verdict pass iff killed/total ≥ `min_kill`; counts
   `{tests: total, pass: killed, fail: survived}`; the log lists each mutant's
   result. The receipt card shows `strength k/n`.
5. Writes / closure-touch computed from `git diff --name-only B C`.
6. Skip an item whose key already has an executor verdict (reuse), unless
   `--rerun`.
7. Remove the temporary worktree. Append one `obs` per item under the lock.

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
brief(o: {cwd, since?: number | string, now?: number}): Promise<Brief>
verify(o: {cwd}): Promise<VerifyResult>                  // hash chain + replay
escape(o: {cwd, node, merge, class, note, evidence?, as, channel?}): Promise<Entry>
decoyDigest(text: string): {digest}                      // pure helper; parses the reveal JSON, writes nothing
decoyCommit(o: {cwd, digest, as, channel}): Promise<Entry>
decoyReveal(o: {cwd, payload: string, as, channel}): Promise<Entry>   // payload = reveal JSON text
```

`gc(o: {cwd, dryRun?, as?, channel?}): Promise<GcResult>` reclaims finished
attempts. For every `dispatch` entry whose attempt is merged or abandoned (never
the current open slot) it removes the slot worktree with `git worktree remove`
(no `--force`) and deletes the branch `owed/<node>/<attempt>` with `git branch -D`,
then runs `git worktree prune` (also run first, so a hand-deleted slot directory
does not pin its branch). Before removing anything of a finished attempt it pins
each commit of that attempt's `submit` entries that the ledger's trunk commit does
not reach, with `git update-ref refs/owed/keep/<node>/<attempt>/<submit-seq>
<commit>` (one ref per submit entry; create-only, an existing ref is left alone),
because attribution reruns (§7) re-execute old blocks on those commits; this also
applies when the branch is already gone but the commit still exists. gc never
deletes `refs/owed/keep/*`. If a pin fails the worktree and branch are kept; a
submitted commit that is already missing is reported in `kept`. It runs under the `dispatch` lock. A finished worktree
that is locked or dirty (`git status --porcelain` shows tracked or untracked
non-ignored changes) is kept together with its branch; a branch checked out in
another worktree is kept; an unregistered directory at the slot path is left
untouched. Attempts whose worktree and branch are both gone are skipped, so gc
is idempotent. Result: `{dryRun, removed: {node, attempt, worktree, branch, pinned}[],
kept: {node, attempt, worktree, branch, reason}[], entry?}`; in `removed`,
`worktree`/`branch` is `null` for a part that was already absent, and `pinned`
lists the keep refs created (in dry-run: that would be created). When it
removes or pins something (not in dry-run) it appends one `note` entry (by the caller,
default `parent:cli`) naming what was removed and pinned; there is no new entry kind and
the reducer is unaffected. `dryRun` reports the same classification without
changing git or the ledger.

## 9. Views

- **Receipt card** (`why`): per obligation: ✔ measured (executor pass, with log
  sha, counts, duration), ✔ reviewed (reviewers), ⚠ waived (owner, reason, channel),
  ✘ rejected, ⊥ awaiting observation, ⊤ conflict, ⏸ deferred, ⛔ blocked (active blocks and how to clear them).
  A `rulings` item satisfied while no ruling is in scope for the node reads
  "no rulings apply" (not "acknowledged"/"satisfied"); its status is unchanged.
- **Clearing hints** (receipt card, report blocks, brief *Rejected or blocked*)
  never print an executable command carrying `--as` of another principal than
  the owner. A judgment block of rank r by reviewer A is described in words:
  an ok review on the current candidate by the original reviewer A with rank ≥ r,
  or by any reviewer with rank > r, clears it; the owner alternative is the
  printed `owed waive … --accept-risk` command (owner commands are gated by the
  owner channel). A node without an open writer slot (abandoned, or never
  dispatched) cannot clear anything on an old candidate, so its hints (blocks
  and owner decisions) say `owed dispatch <node>` and never suggest submit or
  attest; with an open slot but no candidate, judgment and flaky hints first
  require the writer's submit.
  Also "Untested": obligations absent relative to the plan baseline (downgrades) and
  the node's changed files not matched by any passing check's `reads`.
- **Status**: trunk, nodes by state, ready list (sorted by number of transitive
  dependents), pending queue grouped by discharger (owner / parent+writer /
  reviewer / executor), invariant debt on trunk.
- **Report** (`report --since`): merges, new E/W/D, blocks, downgrades, rulings,
  owner decisions needed — written in plain language — and an **Escapes**
  section: escape counts by class with each escape, decoys caught / escaped /
  pending with each revealed decoy, unrevealed commitments and the escape rate
  (cumulative, §6.5; `--json` returns it as `escapes`).
- **Brief** (`brief [--since seq|ISO]`, `briefView`/`renderBrief`): a morning
  summary, one line per item, sections in this order:
  1. *Needs your decision* — the owner queue (node and trunk items with status D
     and discharger `owner`), sorted by the number of transitive downstream
     nodes of the item's node (trunk items count 0), then node id and
     obligation; each line carries the exact command that discharges the item:
     `owed review <node> [--obligation closure-review] --ok --rank 3 --as owner:human`
     for `review`/`closure-review` items whose only blocks (if any) are active
     judgment blocks, otherwise `owed waive <node> <obligation> --reason … [--accept-risk
     <every active block seq on that obligation>]`; trunk invariants cannot be
     waived, so their line points to `owed plan` (add a repairing node).
  2. *Merged* — per merge entry after `since`: counts of measured (status E,
     execution obligations: `check:*`, `red:*`, `writes`) and waived (status W)
     obligations, reviewed obligations, deferred invariants, untested changes
     (as in the receipt card) and the reviewers. A waived item is counted only
     as waived, never as measured.
  3. *Rejected or blocked* — every non-cleared block of an unmerged node: node,
     obligation, the failing observation seq (execution blocks; the block seq
     is the failing obs) or the blocking review (judgment blocks), and how to
     clear it (clearing hints above).
  4. *In progress* — dispatched and submitted nodes with the age since dispatch
     (and since the last submit).
  5. *Total* — merged / accepted-unmerged / blocked (unmerged nodes with a
     non-cleared block) / ready counts, plus nodes waiting on dependencies.
  `since` (seq or ISO time, invalid → usage error) filters only the Merged
  section; the other sections always show the current state. `--json` returns
  the structured `Brief`.

## 10. CLI

`owed <command> [args] [--json]`; commands mirror §8: `init <plan.yaml>`,
`plan <plan.yaml>`, `rule <text> --nodes a,b|*`, `dispatch <node>`,
`submit <node> [--commit X]`, `attest <node> [--rerun]`,
`review <node> --ok|--block --rank N --as reviewer:ID [--note] [--ack-rulings]`,
`waive <node> <obligation> --reason ... [--accept-risk 12,15]`,
`defer <node> <inv-id...> --reason`, `abandon <node>`, `merge <node>`, `status`,
`why <node>`, `report [--since seq|ISO]`, `brief [--since seq|ISO]`, `verify`,
`escape <node> --merge N --class missing|false-pass|reuse|weak|waiver --note T [--evidence T]`
(parent by default, or owner), `decoy commit <digest>`, `decoy reveal <file.json>`
(owner commands), `decoy digest <file.json>` (prints the digest to commit;
no ledger write, no owner confirmation), and `gc [--dry-run]`.
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
