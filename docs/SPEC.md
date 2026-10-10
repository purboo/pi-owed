# owed MVP specification (parent-pinned, v0.1)

owed is the acceptance ledger for a multi-agent task graph in one git repository.
"No receipt, not done": a node counts as done only when every obligation on its
current candidate is observed by a trusted executor or an authorized reviewer,
or is visibly waived by the owner. The design follows `pi-dag/ARCHITECTURE.md`
(a3) and `formal/a4/CONTRACT.md` (a4.1 rulings). This MVP implements the M0–M2
subset. Threat model: same OS user; owed prevents mistakes, laziness and
reward-hacking shortcuts by agents using the normal tools. It does not resist a
process that edits the ledger file directly; it detects such edits (hash chain).
Identities are claims (`--as`); the subagent rails (§2.1.3 and the writer-worktree
rail §2.1.7) are rails against accidents and instructions, not security
boundaries: a process can unset the variables or change directory.

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
- The driver (`owed drive`, §12) acts as `parent:drive`. That name is the
  driver's only (0.6.0, G2.3): the ledger refuses, on append and on replay, an
  entry by `parent:drive` of any kind the driver never writes (it writes only
  `dispatch`, `launch`, `send`, `halt` and `rebase`), and the CLI `--as
  parent:drive` and the pi tools' `as: "parent:drive"` are refused for every
  command and tool, reads included (`parent:drive is the driver's identity:
  only owed drive records as it; it cannot be claimed with --as or as`); the
  driver passes it internally.
- Owner acts are recorded with a `channel`: `delegated` (D25, the default: the
  main agent acts as owner with no human step), `tty` (interactive confirmation),
  `pi-confirm` (pi UI confirmation) or `flag` (`--i-am-owner`, shown as weaker in
  every view). `tty` and `pi-confirm` occur only under the opt-in gate
  `OWED_CONFIRM=owner` (§11). Agents must never use the flag; the skill says so.
  Ledgers written by 0.4.x stay valid; a 0.4.1 reader verifies and replays a
  ledger containing `delegated` (it never checked channel values).

### 2.1 Delegated owner (D25)

A human states the task and leaves; the main agent (the top-level session) holds
every authority, including the owner's. Accountability moves from pre-approval to
audit: every act is in the hash-chained ledger and the brief lists the main
agent's owner acts first (§9).

1. In pi, an owner tool (every tool that acts as an owner principal: plan with
   downgrades, adopt, waive, defer, decoy, review as owner, approve, evidence,
   init, …) runs with no dialog; the entry is `by: owner:<id>`, `channel:
   "delegated"`. The default owner id in pi is `owner:pi`.
2. CLI: an owner command (`--as owner:<id>`, or a command whose default principal
   is the owner) records `delegated` with or without a TTY, without a prompt;
   `--i-am-owner` stays accepted and records `flag`. The CLI's default owner
   principal is `owner:cli` (0.5.1, E3.3; matching pi's `owner:pi`), also with
   `--i-am-owner`; only under `OWED_CONFIRM=owner` it is `owner:human`.
   Compatibility: entries written by earlier versions keep `owner:human`; a
   script that matched `by: owner:human` for CLI owner acts now sees
   `owner:cli` (pass `--as owner:human` to keep the old id).
3. A process with `DSA_CALL` or `DSA_EXEC` in its environment (a
   pi-durable-subagents call) is refused for roles owner and parent, in pi tools
   and the CLI alike, before anything is recorded: `owner and parent acts are
   reserved for the main agent; this process is a subagent call (DSA_CALL)` (or
   `DSA_EXEC`). Reads (`status`, `why`, `report`, `brief`, `verify`, `decoy
   digest`) and `attest` (recorded as the executor) are not refused; the default
   role of such a process is unchanged. This is an accident rail, not a security
   boundary: a process can unset the variables. `owed drive` (and `owed_drive`)
   is not refused (D17 keeps starting a detached driver from a dsa call).
4. `OWED_CONFIRM=owner` (environment) restores the confirmation (§10, §11).
   Without it nothing ever waits on a human.
5. Every delegated owner act that eases acceptance needs a non-empty note or
   reason: a plan update with downgrades (`owed plan --note`, `owed_plan` `note`;
   the plan entry has an optional `note`), `waive` (`reason`), `defer` (`reason`),
   `adopt` (`note`); refused without one, nothing recorded.
6. The driver's "needs the owner" notifications read `<node>: needs the owner
   (the main agent decides; owed lists the command): <reason>; the driver leaves
   it alone; the main agent resolves it with: <commands>`; its owner halts for a
   stale review block or a stalled candidate end with `; the main agent resolves
   it with: <commands>` (`views.ownerCommands`, in order: with an open candidate
   the brief's command for each owner item still owed, a waiver for every other
   item still owed and every uncleared block, and `owed abandon <node> --note
   "<why>"`; without one, as the brief's dispatch/clear hints, `owed dispatch
   <node>` first when no slot is open, then each waiver prefixed `after the
   writer submits a candidate:` since a waiver needs one; nothing for a merged
   node). The reason's own trailing `needs the owner` is not repeated.
   The driver's output line of a halt needing the owner reads `halt <node>
   attempt <n>, needs the owner (the main agent decides; owed lists the
   command): halted — <reason>` (a human halt keeps `(needs human)`); the
   halt rows of `status`, `why`, `report` and entry lines read `halted by
   driver #<seq> (attempt <n>), needs the owner (the main agent decides; owed
   lists the command): <reason>` (a human halt keeps `(attempt <n>, needs
   human)`). Trunk drift is never a node halt (§12.7 Trunk drift). The
   commands of the brief, report and these texts omit `--as` where the command
   already defaults to the owner (waive, defer, adopt, approve, init) and use
   `--as owner:cli` where a role must be stated (owner review, owner evidence);
   under `OWED_CONFIRM=owner` that role is `--as owner:human`. Each such
   command for a candidate-bound act (waive, approve, evidence, owner review) on
   a node with an open candidate ends with (approve: is followed by) `--candidate
   <commit12>` of that candidate (G1.3, §8 act binding).
7. Writer-worktree rail (0.6.0, G2.1, F3): in a pi-durable-subagents call
   (`DSA_CALL` or `DSA_EXEC` set), an owed process (CLI or pi tool) whose working
   directory (the CLI's cwd, the tool's `cwd` argument, the pi session's
   directory or the process's own) is inside the open slot worktree of node X is
   refused `review` and `evidence` on X, nothing recorded: `a writer worktree
   cannot record a review or evidence for its own node; run the review from the
   repository root or another directory`. Waives are already refused for
   subagents (item 3). Like item 3 this is an accident rail, not a security
   boundary (§1).

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
lowered, writes widened) is a **downgrade**: allowed only to the owner (or to a
parent when an allowance of the prior plan covers it, §3.4), and
listed in reports as ΔO⁻.

### 3.1 Worktree location and branch names (D19)

```yaml
worktrees:                          # optional; unknown keys and bad types are errors
  root: ../dev/wais-worktree        # absolute, or relative to the main worktree root; default .owed/wt
  branch: "{type}/{node}-{attempt}" # default "owed/{node}/{attempt}"
nodes:
  - id: auth-api
    type: fix                       # optional, ^[a-z][a-z0-9-]*$, default feat; used only by {type}
```

The branch template must contain `{node}` and `{attempt}`; any placeholder other
than `{node}`, `{attempt}` and `{type}` is a plan error. A plan being recorded
(`init`, `plan`) is also refused (usage, nothing recorded) when `root` or the
template contains a control character (a code point below 0x20, 0x7f, U+2028 or
U+2029) or when the template is ambiguous, i.e. two distinct (node, attempt) pairs
could expand to the same name. The rule is sufficient, not exact: `{node}` occurs
exactly once, every `{attempt}` or `{type}` before it is directly followed by a
literal character that cannot occur in its value (a digit for `{attempt}`; a
lowercase letter, digit or `-` for `{type}`), and every one after it is directly
preceded by one. So `owed/{node}/{attempt}` and `{type}/{node}-{attempt}` are
accepted, `{node}{attempt}` (`a1`+`1` and `a`+`11` give `a11`) and
`{node}-{type}-{attempt}` are refused. These checks apply to plans being recorded,
not to replay: a ledger whose recorded plan has such a block stays readable. A plan without the block
parses to a plan without a `worktrees` key (the same canonical plan and sha as
0.4.1); a block present is filled with the defaults. Neither `worktrees` nor a
node's `type` is an obligation: changing them is never a downgrade (a parent may
record it), never invalidates a submitted candidate (the candidate-invalidation
comparison ignores `type`), and affects only later dispatches; an open slot keeps
the branch and worktree recorded in its dispatch entry (§8.1).

### 3.2 Execution environment: `exec` (D20)

```yaml
exec:                            # optional; unknown keys and bad types are errors
  env: { CARGO_TARGET_DIR: /abs/shared/target }   # string values, no expansion
  wrap: ["/abs/tmp/qa/heavy.sh"]                  # non-empty argv prefix of non-empty strings
```

`env` names match `^[A-Za-z_][A-Za-z0-9_]*$` and may not be `CI` or `OWED`;
values are strings used verbatim (no `$VAR` or `~` expansion). The parsed plan
keeps only non-empty fields: `exec: {}` and `exec: {env: {}}` are the same as
no block (same plan blob, keys and views). `wrap: []` is an error.

A change of `exec` is treated like a change of `setup`: it invalidates the
submitted candidates (§3), attribution reruns of older blocks use the exec of
the plan in force when the block was recorded (§7, step 1), and because a wrapper
can weaken every check (`wrap: ["true"]` passes everything) the reducer records
it as `{node: "*", what: "exec changed; cannot prove obligations were not
reduced"}` in ΔO⁻: only the owner may change `exec`, so set it once. The
recorded `downgrades` field of the plan entry (and the confirmation list of
`owed_plan`) does not list it, as for `setup`. Plans without `exec` behave
exactly as in 0.4.1; a plan with `exec` needs owed ≥ 0.5.0 to replay.

### 3.3 Owner approval and manual evidence (D23)

Two optional node fields add obligations no executor can measure (§6.2 items 8–9):

```yaml
    approve: owner             # the only value: obligation `approve`, discharged by the owner only
    evidence:                  # obligations `evidence:<id>`, discharged by `owed evidence` (§8)
      - id: ui                 # ^[A-Za-z0-9][A-Za-z0-9._-]*$, unique in the node
        what: "looked at the real page"   # non-empty
        by: reviewer           # reviewer | parent | owner (default reviewer); the owner always qualifies
```

Unknown keys and bad values are errors. A node without them gets neither key in
the stored plan (its canonical form, so a 0.4 plan's sha, is unchanged).
Downgrades: `approve removed`; `evidence <id> removed`; `evidence <id>
weakened` when its `by` changes to a role other than `owner`. Adding either, or
changing an evidence `what` (a new key), is not a downgrade; it changes the node
spec and so invalidates the open candidate (§3).

### 3.4 Owner allowances (D21)

An optional `allow:` block lets the owner pre-authorize parent downgrades and
parent adoptions. It is a list of rules; unknown keys and bad types are errors,
and a rule needs at least one permission:

```yaml
allow:
  - nodes: ["phaseA-*"]          # node id globs (path.matchesGlob on the id); default ["*"]
    review_count: 0              # parent may lower review.count down to this (integer >= 0)
    review_rank: 1               # parent may lower review.min_rank down to this (1..3)
    writes: ["tests/", "docs/"]  # parent may widen writes with prefixes inside these prefixes
    checks: ["ui-*"]             # parent may remove/weaken node checks and evidence obligations (§3.3) whose id matches these globs
  - adopt: ["testdata/", "tasks/"]   # parent may adopt trunk commits whose changed paths all lie under these
```

`allow` is not an obligation: it is not part of any key and changing it never
invalidates a candidate.

- **Coverage.** A downgrade of a plan update is *covered* when a rule of the
  **prior** plan (never the new one) whose `nodes` match the node permits it:
  review count (rank) lowered to a value ≥ the rule's `review_count`
  (`review_rank`); every newly widened writes prefix lies under one of the rule's
  `writes` prefixes; a check weakening (removed, red disabled, `min_tests`
  lowered, mutants removed/changed, `min_kill` lowered, definition changed)
  whose check id matches one of the rule's `checks` globs; an evidence obligation
  removed or weakened (`evidence <id> removed`, `evidence <id> weakened`, §3.3)
  whose evidence id matches one of the rule's `checks` globs. An item that reads
  both ways (e.g. check id `evidence`, evidence id `check`: `evidence check
  removed`) is covered only if every reading is. Never covered:
  `approve removed` (the owner's gate), `node removed`, `dependency removed`,
  any downgrade of trunk invariants, the
  plan-level `*` items (setup/closure changed, exec changed), and `allow`
  changes. Any change of `allow` other than deleting whole rules (some new rule
  deep-equals no prior rule, after defaults) is the downgrade
  `{node: "trunk", what: "allow changed"}`: owner only.
- **Parent plan updates.** A `plan` entry by a parent whose downgrades (the
  detected ones and those the entry lists) are all covered is valid without an
  owner — a reducer rule, so it also holds on replay. The downgrades still enter
  ΔO⁻; every view labels them `by parent:<id> under allowance (plan #S)`, where
  S is the seq of the latest genesis/plan entry that changed the `allow` block
  before that update. An uncovered downgrade still needs the owner; the refusal
  for a parent lists the uncovered items, each downgrade once: a listed item is
  left out when the same downgrade is already listed in its detected wording
  (`review count lowered` under `review count/rank reduced`, `check <id> removed`
  under `<id> check removed`, `writes widened` under `writes scope expanded`, …).
  When every uncovered item widens writes, the refusal (CLI and `owed_plan`)
  adds one line (0.6.1 H2.1, `writesHint`): `hint: an allow rule {nodes:
  ["<ids>"], writes: ["<new prefixes>"]} in the prior plan would cover this`,
  the new prefixes being those under neither the node's prior writes nor a
  matching prior rule. Recommended practice: keep writes strict and
  pre-authorize at plan time the prefixes integration/packaging nodes need
  (entry files, `package.json`, wiring directories).
- **Check-less nodes** (0.6.1 H2.2). `owed init` / `owed plan` (CLI and pi
  tools) warn, refusing and recording nothing, for each node of the new plan
  with no checks and no evidence obligations: `warning: node <id> has no
  checks: its acceptance rests on review alone`. The CLI prints them after the
  result; `--json` and the pi tools return `warnings: string[]`.
- **Parent adoptions** (§6.6): `adopt` by role parent is valid iff every path of
  `changed` lies under an `adopt` prefix of a rule of the **current** plan and
  `adoptGuard` passes. No owner channel is needed.
- An `allow` rule never turns a failing writes item into a pass; it only lets
  the parent widen `writes` in the plan (§9 receipt card).

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

### 4.1 `exec` in keys (D20)

When the plan's `exec` has a non-empty `env` or `wrap`, every check, red,
strength and invariant key above also contains `exec: {env?, wrap?}` (only the
non-empty fields). Otherwise the field is absent and keys are byte-identical
to 0.4.1 (`exec: {}` = no block). Writes, closure-review, review and rulings
keys never contain it. The key names the wrapper argv, not where the wrapper
ran: a remote-host wrapper is trusted by its argv.

## 5. Ledger entry kinds

| kind | by | payload | effect |
|---|---|---|---|
| `genesis` | owner | `{trunk, commit, plan}` (plan = blob sha) | names s₀ and the plan |
| `plan` | owner/parent | `{prior, plan, rev?, path?, note?}` | new plan; must cite current plan sha (CAS); downgrade needs owner, unless the parent's downgrades are all covered by an allowance of the prior plan (§3.4); `rev` = commit the plan file was read from (`owed plan --rev`), `path` = repository-relative plan file |
| `rule` | owner/parent | `{text, nodes: string[] \| "*"}` | ruling; in scope for those nodes |
| `dispatch` | parent | `{node, attempt, base, branch, worktree, packet, rulings_seen: number, overlaps?: string[]}` | opens writer slot; `rulings_seen` = seq of latest ruling in packet; `overlaps` = nodes with an open slot whose writes overlap, present only when dispatched with `--allow-overlap` |
| `rebase` | parent/owner or the slot writer | `{node, attempt, base, from}` | moves the open slot from base `from` (the current slot base) to `base` (the current trunk, which must differ); the open candidate is invalidated; blocks keep binding the node |
| `submit` | writer | `{node, attempt, commit}` | candidate claim (speech) |
| `obs` | executor | `{subject, obligation, key, verdict, exit, counts?, log, durationMs, commit, base, attribution?, merging?}` | trusted observation; `merging` = node being merged when `owed merge <node>` produced it (invariants and checks on the merge result, pass or fail); a node obs must name its own subject, and the node must have an open candidate |
| `review` | reviewer/owner | `{node, attempt, key, verdict: "ok"\|"block", rank, note, ack_rulings?: number, clears?: number[], needs?: "parent"}` | judgment observation on review/closure-review item; `needs: "parent"` only on a block (refused on ok): the fix needs a parent ruling (§12.5); on obligation `approve` (D23, §6.2 item 8) only by the owner (rank 3) |
| `waive` | owner | `{node, obligation, key, reason, accept_risk?: number[]}` | waiver of one item; accept_risk cites block seqs it knowingly overrides |
| `defer` | owner | `{node, items: {id, key}[], reason}` | deferral of invariant items for one merge (stays debt) |
| `abandon` | parent/owner | `{node, attempt, reason}` | closes a writer slot; `reason` is the `--note` text |
| `merge` | executor | `{node, attempt, prior, commit, tree}` | trunk advanced (CAS on prior) |
| `note` | any | `{text}` | speech, no effect |
| `adopt` | owner, or parent under an `adopt` allowance (§3.4) | `{trunk, prior, commit, state, changed, commits, note}` | trunk commits made outside owed adopted (§6.6): `prior` = current ledger trunk (CAS), `commit` = `state.commit` = refs/heads/<trunk>, a fast-forward of `prior`; `changed` = `git diff --name-only prior commit`, `commits` = number of commits in `prior..commit`; the trunk state becomes `state` |
| `escape` | parent/owner | `{node, merge, class, note, evidence?}` | defect found after a merge (§6.5); `merge` must be the seq of a merge of `node` |
| `decoy-commit` | owner | `{digest}` | commitment to a hidden decoy list (§6.5); 64 lowercase hex, not previously committed |
| `decoy-reveal` | owner | `{nonce, decoys: {node, defect}[]}` | opens an earlier unrevealed commitment (§6.5) |
| `launch` | parent (the driver: `parent:drive`) | `{node, attempt, role: "writer"\|"reviewer", rid, spec, labels, rulings?: number}` | driver intent to start a dsa run, recorded before the dsa call (§12); `attempt` = the node's current open slot; `spec` = blob sha of the exact spec JSON bytes; `rid` = `runId(...)` (§12.3; a reviewer rid always carries `:<n>`), unique in the ledger; `labels` = `runLabels(...)`; `rulings` (0.5.1, always written; absent on 0.5.0 entries) = the highest in-scope ruling seq the task carried, 0 when none: an integer ≤ the entry's seq, 0 or the seq of a recorded ruling covering the node (§12.5.1); strict fields |
| `send` | parent (the driver) | `{node, attempt, rid, send, sendKind: "follow-up"\|"steer", message, reason}` | driver intent to send a message to run `rid` (a recorded launch of the same node attempt); `send` = `<rid>:<sendKind>:<seq of this entry>`; `message` = blob sha; `reason` ∈ `submit\|repair\|interrupted\|fenced\|rebase\|review-missing\|ruling`; `rulings`: reason `ruling` (required) = the highest ruling seq the message includes, the seq of a recorded ruling covering the node; reason `repair` (0.5.1, always written; absent on 0.5.0 entries) = the highest in-scope ruling seq the message carried, 0 when none, under the `launch` rule; forbidden for other reasons (§12.5.1); strict fields |
| `halt` | parent (the driver) | `{node, attempt, reason, needs: "human"\|"owner"}` | the driver stops on the node's current open attempt until cleared (§12.3); strict fields |
| `evidence` | owner/parent/reviewer | `{node, attempt?, key?, merge?, id, files: {path, sha256, bytes}[], note}` | manual evidence (D23): on a node with an open candidate (`attempt` = current, `key` = its `evidence:<id>` key, no `merge`) it discharges `evidence:<id>` (§6.2 item 9); on a merged node (`merge` = seq of its latest merge, no `attempt`/`key`, files may be empty) an informational receipt; note non-empty, files hashed when recorded (`sha256` 64 hex, `bytes`); strict fields |

`verdict` for `obs` ∈ `pass | fail | error`. `error` (timeout, crash of the
harness, materialization failure) is ⊥: no information, no block.

## 6. Reducer (pure: entries → State)

### 6.1 Node lifecycle
- `ready` ⟺ every dep has a `merge` entry, node not merged, no open slot.
- `dispatch` requires ready (or a closed previous attempt) and parent/owner.
- `submit` requires an open slot whose writer is `by`, and the commit to be a
  descendant of the slot base.
- `rebase` requires an open slot and a trunk that moved since the slot base;
  the slot base becomes the current trunk and the open candidate is dropped, so
  the node is `dispatched` again in the same worktree and attempt. The writer
  rebases (`git rebase --onto <new base> <old base>`) and submits a descendant
  of the new base. The slot keeps the previously submitted candidate (base,
  commit, submit seq) so the receipt can show what was reviewed before and the
  hint `git range-diff <old base>..<old commit> <new base>..<new commit>`.
  Blocks are unchanged: they bind the node, not the attempt.
- Node `accepted` ⟺ current candidate has every node obligation in E ∪ W and no
  active block (§6.3). Node `merged` after a `merge` entry.

### 6.2 Node obligations on candidate C (base B = slot base)
1. `check:<id>` for each check; executor observation.
2. `red:<id>` for each check with `red: true`; executor observation: the red run
   (base tree + candidate `tests` files + pinned closure) must exit non-zero,
   match `red_expect` if given, and not be a zero-test run. `min_tests` does not
   apply to the red run (a new test file often cannot load on the base, so the
   runner reports one failing test); an unknown count format is accepted there.
   `min_tests` applies to every non-red run — the candidate run (`check:<id>`)
   and invariant runs (`inv:<id>`) — and never to the red run. A red run whose
   command exits 126 or 127 (not executable / not found), or that cannot be
   spawned, is an `error` observation, not a pass, even when `red_expect`
   matches. Verdict `pass` means "the counterfactual was rejected as specified".
3. `writes`: every path in `diff --name-only B C` starts with a `writes` prefix.
4. `closure-review` iff the diff touches closure globs: needs a review `ok` with
   rank ≥ 2 by a non-writer, or an owner waiver.
5. `review` iff `review.count > 0`: needs `count` distinct reviewers with rank ≥
   `min_rank`, none of them a writer of this node (any attempt). One recusal
   rule (0.6.0, G2.2) for counting reviews, rulings acknowledgments, evidence and
   for refusing new reviews: a principal is excluded when it is a writer of the
   node or shares a writer's id after the role (any attempt), so a review by
   `reviewer:A#2` stops counting once `writer:A#2` exists.
6. `rulings`: satisfied iff the attempt's `rulings_seen` ≥ the latest in-scope
   `rule` seq, or a later `review ok` by rank ≥ 1 with `ack_rulings` ≥ that seq
   by a principal the recusal rule of item 5 does not exclude.
7. `strength:<id>` for each check with `mutants`; executor observation (§7):
   `pass` means the check killed at least `min_kill` of the base's mutants. A
   `fail` is an execution block like any other. On merge it keeps the candidate's key.
8. `approve` iff the node has `approve: owner` (D23). Key
   `H({o:"approve", patch})` (patch as for review). E ⟺ a `review` entry on
   obligation `approve`, verdict ok, by the owner (rank 3) on the current key;
   reviews of `approve` by any other role are refused. An owner block on
   `approve` is a judgment block (discharger owner), cleared by a later owner
   ok on the current key (any owner id). Discharger owner. Never measured.
9. `evidence:<id>` for each `evidence` item (D23). Key
   `H({o:"evidence", id, what, patch})`. E ⟺ an `evidence` entry on the
   current key with at least one file, by the item's `by` role or the owner, by
   a principal that is not a writer of the node (any attempt; same rule as
   reviews). The ledger refuses other evidence on an open candidate (undeclared
   id, wrong role, a writer, no files). Discharger: the `by` role. Always
   shown as manual, never as measured; the executor never runs it.
   The approve and evidence keys are added to the submit facts by `owed
   submit`; the ledger refuses a submit whose keys are not derived from its patch.

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
    A block recorded with `needs: "parent"` carries `needs: 'parent'` on its
    Block; it clears by the same rules. It is *resolved* (`parentRuling`) by the
    first `rule` whose node list names its node (not `*`) with a seq above the
    block's; until then it awaits a parent ruling (§12.5).
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
- `escape`, `decoy-commit`, `decoy-reveal` and `adopt` entries carry exactly the fields
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
  before any merge of it; or a failure seen while merging it: an executor `obs`
  with `merging: <node>` and verdict `fail` on an invariant or check whose item
  was not already failing on PRE (the trunk item at that obs is in E — not debt,
  deferred debt, ⊥ or missing). Pre-existing trunk debt, deferred or not, never
  counts as a catch. This holds for a refused merge and for a later merge after
  an owner `defer`. `escaped` — a merge of the node with no such entry before
  it; `pending` — neither yet. `decidedBy` is the deciding seq.
- A node listed in more than one reveal counts once: the decoy of the earliest
  commitment (lowest `decoy-commit` seq) wins, whatever the order of the reveals.
  `state.decoyCommits` lists commitments and the seq that revealed them.
- Metrics (report): escape counts by class; decoys caught / escaped / pending;
  unrevealed commitments; **escape rate** = escaped / (caught + escaped), n/a
  while no decoy is decided. These are cumulative over the whole ledger.

### 6.6 Adoption of trunk commits made outside owed
Trunk can move outside owed (a release commit, a human hotfix). Then
refs/heads/<trunk> is ahead of the ledger trunk and every merge fails the CAS.
The owner records such commits explicitly with `adopt`; owed never trusts a
moved ref silently.
- Reducer: `adopt` requires role owner (or a parent under an allowance, below), `trunk` = the ledger trunk name,
  `prior` = the current trunk commit, `commit` = `state.commit` ≠ `prior`, a
  non-empty `note`, `changed` a list of paths, `commits` a positive integer, and
  exactly the fields of the entry table. The trunk state becomes `state` (as for
  a merge; `trunk.seq` = the adopt seq) and `state.adoptions` lists
  `{seq, by, channel, prior, commit, commits, changed, note}` in ledger order.
- **No new debt** (`adoptGuard`, also checked on replay): for each invariant,
  key on the adopted state; if equal to its key on the current trunk the status
  is inherited; otherwise, when the item on the current trunk is E, the item on
  the adopted key must be E. An invariant that is already debt on the current
  trunk (D: failing, ⊥, ⊤ or deferred) does not block. Genesis observations must
  be finished (§6.4 rule 4). There is no owner `defer` for an adoption: the owner
  fixes trunk and adopts again. The refusal names each failing invariant with the
  observation that decides it (`h1 (obs #3)`): the obs appended by this adopt,
  else (a repeated adopt measures nothing new and appends nothing) the latest
  existing trunk obs of that invariant at the adopted state's key.
- **Parent adoption** (§3.4, D21.4): role parent may adopt instead of the owner
  when the current plan has `adopt` allowances and every path of `changed` lies
  under one of their prefixes; otherwise the entry is refused (no prefixes:
  `adopt insufficient permissions; requires owner`; else `parent adoption
  refused: changed path <first uncovered path> is not under an allow adopt prefix
  (…)`). `adoptGuard` applies as for the owner. `state.adoptions` carries
  `allowance: S` for a parent adoption (S as in §3.4) and views show `adopted by
  parent:<id> under allowance (plan #S)`. Owner adoptions are unchanged.
- Open slots are not touched. Their base stays; a merge builds on the adopted
  trunk as after any other trunk move (`owed rebase` when it conflicts).
- Limits: only fast-forwards are adopted (a rewritten or reset trunk is refused;
  restore the ref to a descendant of the ledger trunk). `escape` cannot name an
  adoption (it names merges only). The adopted commits are not reviewed by owed;
  the entry records that the owner took them on trunk.
- A moved ref or ledger makes adopt record nothing, except after an abort
  (§7.8): observations measured before it are recorded when the ledger is
  stable and they pass the guard, without a ref check.

## 7. Executor (attest)

`attest(node)` for the current candidate:
1. For each active execution block of the node, rerun its original item first
   (attribution) using the commit/base recorded in the failing obs.
2. Materialize C clean: `git worktree add --detach <tmp> <C>`; restore closure
   globs from B (files in B overwrite; closure files only in C are deleted);
   run `setup`; run each check with `bash -lc` (prefixed by `exec.wrap`, §7.9),
   a timeout (kill process group), env `CI=1 OWED=1` (plus `exec.env`, §7.9); capture combined output to a blob; parse test counts
   (TAP `# pass N`/`# tests N`, node:test, pytest `N passed`, cargo
   `test result: ok. N passed`); zero tests with a known format = fail;
   `min_tests` unmet = fail; unknown format with `min_tests` set = error.
   cargo summaries count only at column 0 (`^test result: (ok|FAILED)\. …`,
   as cargo prints them): a `# test result: …` TAP comment or an indented
   TAP YAML diagnostic containing one is never a cargo count.
   A log holding both cargo `test result:` lines and TAP (plan or summary
   lines), e.g. `cargo test && node --test --test-reporter=tap`, sums both to
   one count `{format: "mixed", tests, pass, fail, skip}` (TAP part as for a
   TAP log, cargo lines summed; `pass`/`fail`/`skip` present when the TAP part
   reports them); a single-format log keeps its format name and numbers.
   A non-red run that exits non-zero with no recognizable count, or with a
   zero count, is `fail` (with or without `min_tests`, never the unknown-format
   error): the command itself failed (e.g. cargo's `package ID specification …
   did not match any packages`, exit 101). Its note is `command exited <code>
   with no recognizable test count; last output:` (or `after zero tests;
   last output:`) followed by the last 5 non-empty output lines, one per
   line, indented two spaces, ANSI colour removed, each cut to 200
   characters. Exception: a non-red run that exits 126 or 127 with no
   recognizable count is `error` with the note `command could not run (exit
   126: not executable)` (or `127: not found`) plus the same `; last output:`
   tail — the command never ran, so it says nothing about the code and must
   not become a `fail` that later conflicts with a pass. Otherwise only an
   exit-0 run with an unknown count and `min_tests` set stays `error`. Red
   runs are unchanged.
3. Red runs: materialize B, overlay candidate `tests` files, restore closure
   from B, run; pass iff exit ≠ 0 and not zero-test and `red_expect` matches;
   exit 126/127 (the command could not run) or a spawn failure is `error`.
   `min_tests` is not applied to red runs, and an unknown count format there is
   not an error (the base usually fails to load the new test file).
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
8. Abort (D16): `attest`, `merge`, `init` and `adopt` take an optional
   `signal` (AbortSignal). On abort the running check's process group gets
   SIGKILL, that run records nothing, no further job starts, and the operation
   rejects with `OwedError('aborted', 'aborted')`. Observations of jobs that
   completed before stay: attest/init appended them already; merge/adopt
   append the ones they measured when the ledger did not move meanwhile and
   each passes the guard (the same stability check as their refusal path; no
   trunk-ref check — they are facts about the measured tree, so an aborted
   adopt records them even if the ref moved). An abort never moves trunk:
   merge/adopt check it last under the lock, before `git update-ref`. An
   already-aborted signal starts nothing. Waiting for a ledger lock is
   abortable (D16a.2): an abort before the lock is acquired rejects at once
   with `OwedError('aborted')` and takes nothing; an abort after acquisition
   is handled by the paths above, never by interrupting the locked step. The
   only lock wait after an abort is merge/adopt recording the observations
   they measured before it.
9. Execution environment (D20, §3.2). Every process owed starts in a
   materialized tree — `setup`, check, red, strength and invariant runs, and
   attribution reruns — gets the environment `{...process.env, ...exec.env,
   CI: "1", OWED: "1"}` (`NODE_TEST_CONTEXT` and every `DSA_*` variable of
   owed's own process except `DSA_HOME` — `DSA_CALL`, `DSA_EXEC`,
   `DSA_SESSION`, … — are not inherited, so owed commands inside a check are
   not refused as subagent acts, D25.3; `DSA_HOME` is configuration, not call
   identity, and stays; a `DSA_*` name set in `exec.env` is passed as written) and runs as `[...exec.wrap, "bash", "-lc", <command>]` instead
   of `["bash", "-lc", <command>]`: same cwd (the materialized tree), same new
   process group, same timeout and abort handling (SIGKILL to the group, so
   the wrapper is killed with its group). Wrapper contract: run the trailing
   argv to completion in the given cwd and environment, pass stdout and stderr
   through, and exit with its exit code; when the wrapper cannot run the
   command (transport, mirror or lease failure) it must exit 126 or 127. A
   wrapper that runs the command elsewhere (ssh) must bound it there itself,
   because owed can only kill the local process group. The red-run 126/127
   rule (step 3) applies to the wrapper's exit code: 126/127 is `error`, any
   other non-zero code is read as a test failure — so a wrapper failure with
   another code, or a remote `timeout`'s 124, is a red pass unless `red_expect`
   is set (use `red_expect` with wrappers). A wrapper that cannot be started is
   an `error`. A relative `wrap[0]` containing a slash resolves against the
   materialized tree (the cwd); a bare name is looked up in `PATH`.

### 7.10 Observations are facts about keys (D24)

`attest` and the genesis attest (`init`, `attestGenesis`) do not refuse when the
ledger moves while they measure (a plan edit, a ruling, another node's entry).
Under the ledger lock each observation is appended iff its item is still current
(`jobCurrent`, src/reducer.ts): a node job while the node's open candidate still
has that key for that obligation, or — an attribution rerun — while an active
execution block still has that obligation and key and its failing observation the
job's commit and base (a block replaced by one on another commit supersedes the
rerun instead of refusing it); a trunk job while its key is
still the genesis key or the current trunk key of an invariant of the plan.
Otherwise the observation is dropped as **superseded** and the run goes on with
the next job. `AttestResult.superseded` (and the genesis results) list the
dropped items `{subject, obligation, key}`; the CLI and `owed_attest` print them after the card as
`Superseded (not recorded; the item changed while it was measured): …`. A plan
edit that changes a node's spec (a brief included) invalidates its candidate, so
that node's observations are superseded; an edit elsewhere interrupts nothing.
`merge` and `adopt` keep their strict stability rule (`Plan, candidate or trunk
changed; retry`): they decide a trunk move on what they measured.

## 8. Operations (src/ops.ts) — the single API used by CLI and pi extension

```ts
init(o: {cwd, plan: string, as: Principal, channel, signal?}): Promise<InitResult>      // genesis + genesis attest of invariants; signal: §7.8
readPlan(o: {cwd, path, rev?}): Promise<{plan, rev?, path}>   // plan text from the working tree, or from commit `rev` (`git show rev:path`); path repository-relative
planSet(o: {cwd, plan, rev?, path?, note?, as, channel?}): Promise<Entry>   // records rev/path (and note: why, D25.5) in the plan entry
rule(o: {cwd, text, nodes, as}): Promise<Entry>
dispatch(o: {cwd, node, as, allowOverlap?}): Promise<DispatchPacket>   // creates the branch and worktree of §8.1 (default owed/<node>/<attempt>, <main worktree root>/.owed/wt/<node>-<attempt>)
rebase(o: {cwd, node, as}): Promise<RebaseResult>      // parent/owner or the slot writer; appends `rebase`, returns the packet with the git commands
submit(o: {cwd, node, commit?, as}): Promise<Entry>      // default commit = HEAD of the slot worktree; must be clean
attest(o: {cwd, node, rerun?: boolean, signal?: AbortSignal}): Promise<AttestResult>   // abort: §7.8
review(o: {cwd, node, verdict, rank, note, as, ack_rulings?, obligation?: "review"|"closure-review", needs?: "parent", named?: string, pin?: {seq, commit}, from?: string[]}): Promise<Entry>   // named: --candidate; pin: an owner dialog's candidate; from: more working directories for the writer-worktree rail
waive(o: {cwd, node, obligation, reason, accept_risk?, as, channel, named?: string, pin?: {seq, commit}}): Promise<Entry>
defer(o: {cwd, node, items, reason, as, channel}): Promise<Entry>
abandon(o: {cwd, node, reason, as}): Promise<Entry>      // reason = the --note text
merge(o: {cwd, node, as, signal?}): Promise<MergeResult>          // builds M, attests M, guarded CAS; abort: §7.8
adopt(o: {cwd, commit?, note, as, channel?, signal?}): Promise<AdoptResult>   // owner, or parent under an adopt allowance (§3.4); records trunk commits made outside owed (§6.6); abort: §7.8
adoptPreview(o: {cwd, commit?}): Promise<AdoptPreview>   // the same preconditions, no effect: {trunk, prior, commit, commits, changed}
status(o: {cwd}): Promise<StatusView>
why(o: {cwd, node}): Promise<ReceiptCard>
report(o: {cwd, since?: number | string}): Promise<Report>
brief(o: {cwd, since?: number | string, now?: number}): Promise<Brief>
verify(o: {cwd}): Promise<VerifyResult>                  // hash chain + replay
escape(o: {cwd, node, merge, class, note, evidence?, as, channel?}): Promise<Entry>
decoyDigest(text: string): {digest}                      // pure helper; parses the reveal JSON, writes nothing
decoyCommit(o: {cwd, digest, as, channel}): Promise<Entry>
decoyReveal(o: {cwd, payload: string, as, channel}): Promise<Entry>   // payload = reveal JSON text
approve(o: {cwd, node, note?, block?, as, channel, candidate?: {seq, commit}, named?: string}): Promise<Entry>   // D23: owner only; review entry on obligation approve, rank 3; candidate = the confirmed one
approvePreview(o: {cwd, node}): Promise<{node, seq, commit, base, changed}>   // D23: what the owner approves (no effect)
candidatePreview(o: {cwd, node}): Promise<{node, seq, commit, base, changed}>   // G1.2: the open candidate, for the waive and owner-review dialogs (no effect)
candidateArg(v?: string): string | undefined              // G1.1: validates --candidate (7..40 hex; usage error otherwise)
evidence(o: {cwd, node, id, files: string[], note, as, channel?, expect?, candidate?: {seq, commit}, named?: string, from?: string[]}): Promise<EvidenceEntry>   // D23: candidate evidence or receipt; expect = files a dialog showed, candidate = the candidate it showed
evidencePreview(o: {cwd, node}): Promise<{node, candidate?: {seq, commit, base}, merge?}>   // D23: where evidence would be recorded (no effect)
evidenceFiles(o: {cwd, files: string[]}): Promise<EvidenceFile[]>   // D23: read + sha256 + bytes; repository-relative path when inside the repository
```

The confirmed candidate is the one approved (review ruling #389): `approve` and
`evidence` given `candidate` (the submit seq and commit an owner confirmed)
refuse under the lock with `candidate changed since confirmation; nothing
recorded` when the node's current open candidate differs (a resubmit, rebase or
abandon during the confirmation); the CLI approve prompt and the pi
`owed_approve` / owner `owed_evidence` (candidate mode) dialogs always pass it.
Under `OWED_CONFIRM=owner` the waive and owner-review confirmations (pi dialog;
CLI: a stderr line `Waive <node>/<obligation>: candidate …` or `Owner review of
node <node>: candidate <commit> (submit #<seq>), base <base>, N changed files`
before the TTY prompt) show the open candidate as approve's does and pin it the
same way (0.6.0, G1.2, F1).

Act binding (0.6.0, G1, F1/F2). `review`, `waive`, `approve` and `evidence` (on
an open candidate) accept the candidate the caller judged: CLI `--candidate
<commit>`, pi parameter `candidate`, ops `named` — 40 hex or a prefix of at
least 7 hex (case-insensitive; otherwise a usage error before anything is read).
Under the ledger lock at append time the act is refused unless the node has an
open candidate whose commit starts with it: `candidate changed: you named
<given>, the open candidate is #<seq> <commit12>; nothing recorded`, or
`candidate changed: you named <given>, node <node> has no open candidate;
nothing recorded`. Without it behavior is unchanged; nothing new is recorded.
Delegated owners and reviewers pass the commit they read, so a resubmit between
reading and acting makes the act fail instead of landing on content nobody
judged. Every command owed suggests for such an act on a node with an open
candidate carries `--candidate <commit12>` (§2.1.6, the review packet §12).

Repository root. Every path owed derives for the repository (dispatch worktree
paths, gc, `info/exclude`) uses the **main worktree root** (ruling #122):
- in the main worktree (absolute git dir = absolute common dir, which also holds
  for a submodule, common dir `super/.git/modules/sub`, and for
  `--separate-git-dir`) it is `git rev-parse --show-toplevel`;
- in a linked worktree it is `d` = parent directory of the common dir, used only
  when `git -C d rev-parse --path-format=absolute --git-common-dir` is the same
  common dir and `git -C d rev-parse --show-toplevel` is `d`; otherwise dispatch
  and gc refuse with a usage error "run owed from the main worktree" before any
  ledger, `info/exclude` or `git worktree` effect (a submodule's or a
  separate-git-dir repository's linked worktrees cannot locate the main worktree).

So running dispatch or gc from inside a slot worktree (or a subdirectory) of an
ordinary repository gives the same paths as from the main checkout, and a new
worktree is never nested inside another one. Only the
questions "is the cwd this slot's worktree" (writer inference, submit's
dirty check) use the per-worktree top level.

Dispatch refuses when the node's `writes` overlap the writes of another node
with an open slot (path-prefix rule: `p` overlaps `q` iff one is a prefix of the
other, as for `writes` in §6.2), naming that node; `allowOverlap`
(`--allow-overlap`) dispatches anyway and records `overlaps: [node ids]` in the
dispatch entry. Overlap is checked by the operation, not the reducer.

`rebase` is the way to follow a moved trunk without abandoning: it requires an
open slot and a trunk different from the slot base, and appends
`{kind: "rebase", node, attempt, base: trunk, from: slot base}`. The writer then
runs `git rebase --onto <base> <from>` in the same worktree and submits again;
the old candidate cannot be submitted (it does not descend from the new base).
A merge whose candidate conflicts with trunk refuses with
`rebase needed: run owed rebase <node>, …`.

`merge` marks every `obs` it appends for the merge result — invariants and
checks on M, pass or fail, refused or not — with `merging: <node>` (§6.5).
Genesis invariants that merge measures first on the current trunk are not
merge results and carry no `merging`.

`adopt` (owner, or a parent when the current plan has `adopt` allowances, §3.4;
role checked first, then a confirmation channel for the owner) checks,
before any ledger effect (for a parent also that every changed path lies under an
`adopt` prefix, naming the first one that does not): `note` is non-empty; `commit` (default
refs/heads/<trunk>) resolves to a commit equal to the current refs/heads/<trunk>
(adopt what is on trunk, nothing else); it differs from the ledger trunk
("nothing to adopt" otherwise); the ledger trunk commit exists in the repository
("ledger trunk <sha> is missing from the repository" otherwise) and is an
ancestor of it ("trunk was rewritten", otherwise). Under the `merge` lock (serialized with merges) it
computes the state facts of the commit, runs genesis jobs and every invariant
whose key changed on the adopted commit and lacks a verdict (subject `trunk`,
no `merging`), then under the ledger lock re-checks that plan and ledger trunk
are unchanged and that refs/heads/<trunk> still equals the commit — otherwise it
appends nothing. If `adoptGuard` (§6.6) fails it appends the observations and
refuses, naming each invariant that was satisfied on the ledger trunk and not on
the commit with its observation seqs; trunk stays unadopted. Otherwise it appends
the observations and the `adopt` entry. It never moves a ref.
`AdoptResult` = `AdoptPreview & {entry, observations, allowance?}` (`allowance` =
S of §3.4 for a parent adoption).

The merge CAS refusal (refs/heads/<trunk> ≠ ledger trunk) says how the ref
differs: ahead by N commits made outside owed (then the owner runs `owed adopt`),
or diverged/rewritten (not a fast-forward; adopt cannot record it), or a ledger
trunk commit missing from the repository.

`gc(o: {cwd, dryRun?, as?, channel?}): Promise<GcResult>` reclaims finished
attempts. It is a parent/owner operation (same rule as `abandon`; default
actor `parent:cli`), refused for any other role. For every `dispatch` entry whose attempt is merged or abandoned (never
the current open slot) it removes the slot worktree with `git worktree remove`
(no `--force`) and deletes the branch recorded in the dispatch entry (§8.1) with `git branch -D`
only when that name maps back to the attempt it collects: when another dispatch entry (another node or attempt,
possible under an ambiguous template of an older plan) recorded the same name, the branch is kept with reason
`branch name <name> is also recorded for <node>#<attempt>, …; not deleted`;
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
untouched. A finished worktree that contains another registered worktree (a
layout left by older dispatches from inside a slot) is kept with reason
`contains worktree <path>`, so gc never deletes an open slot nested in it.
Attempts whose worktree and branch are both gone are skipped, so gc
is idempotent. Result: `{dryRun, removed: {node, attempt, worktree, branch, pinned}[],
kept: {node, attempt, worktree, branch, reason}[], entry?}`; in `removed`,
`worktree`/`branch` is `null` for a part that was already absent, and `pinned`
lists the keep refs created (in dry-run: that would be created). When it
removes or pins something (not in dry-run) it appends one `note` entry (by the caller,
default `parent:cli`) naming what was removed and pinned; there is no new entry kind and
the reducer is unaffected. `dryRun` reports the same classification without
changing git or the ledger.

### 8.1 Worktree layout and a trunk checked out elsewhere (D19)

Dispatch of attempt `a` of node `n` creates the worktree at
`<P>/<n>-<a>`, where `P` is `resolve(<main worktree root>, worktrees.root)` with
its deepest existing ancestor resolved through symlinks (the physical path, equal
to git's toplevel inside the slot, so writer inference matches it), and the branch from
the template (§3.1; `{type}` = the node's `type`, default `feat`). The expanded
name must pass `git check-ref-format --branch`, and the root must not be the main
worktree root itself; otherwise dispatch refuses (usage) before any ledger,
exclude or worktree effect. Missing parent directories of the worktree are
created; a dispatch that then fails (in `git worktree add`, or when the ledger
moved and it rolls back the worktree and branch) removes the directories it
created again (empty ones only). `<git common dir>/info/exclude` gets `.owed/` for the default root (as
in 0.4.1), `/<repository-relative root>/` for another root inside the main
worktree (with `\`, `*`, `?`, `[` and a leading `!`/`#` escaped, so it matches
that directory literally; the line stays after the slots are gone), and nothing for
a root outside it (both compared as physical paths). The dispatch entry records `branch` and
`worktree`; every later use (submit/rebase writer inference, rebase packets,
gc, the driver, views) reads the recorded values and never reconstructs them.

When the trunk branch is checked out in a linked worktree, a merge fast-forwards
it there (`git merge --ff-only` in that worktree) and refuses when it has
uncommitted tracked changes, before trunk moves and without recording the merge:
`trunk worktree <path> has uncommitted changes: commit them there, or detach it
(git -C <path> switch --detach), then retry` (refused, exit 1). Dispatch, merge
and gc never switch the main worktree's branch or HEAD and never change its
tracked files or index, with two exceptions: slot worktrees are created and
removed under a root inside it (the default `.owed/wt`; excluded as above), and a
merge fast-forwards it when the trunk is checked out there. With a root outside
it and the trunk checked out elsewhere they write nothing in the main worktree.
A new plan cannot have an ambiguous template (§3.1); one recorded by an older plan
may still expand to the same name for two attempts (dispatch then fails in
`git worktree add`), and gc keeps a branch recorded for more than one attempt.

### 8.2 Init and genesis attest (D24)

```ts
init(o: {cwd, plan, as, channel, signal?, measure?: boolean /* default true */, commit?: string}): Promise<InitResult>
initPreview(o: {cwd, plan}): Promise<InitPreview>   // {trunk, commit, planSha, nodes, invariants}; refuses an initialized ledger; no effect
attestGenesis(o: {cwd, signal?}): Promise<AttestGenesisResult>   // measures the genesis items still lacking an observation
genesisPending(o: {cwd}): Promise<string[]>; genesisReport(o: {cwd}): Promise<{recorded, failed, missing}>
genesisIncompleteText(seq, {recorded, missing}): string
```
Genesis items are the invariants of the current plan that have a genesis key; an
item is observed when it has a non-error executor observation at that key.
`GenesisAttest = {complete, recorded, failed, missing, superseded, error?}`
(`recorded`: observed ids, `failed` those of them that failed, `missing`: the
rest). `InitResult` gains `genesis: GenesisAttest`. Once genesis is appended,
`init` succeeds even when its genesis attest does not observe every item (an
error verdict, or an exception — `error` holds its message). A genesis job is
superseded only when its invariant left the plan, which is then no longer a
genesis item, so superseded jobs never make it incomplete. With
`measure: false` it measures nothing. An abort after genesis rejects with
`OwedError('aborted')` whose message is the incomplete text (§10.1); an abort
before genesis keeps the message `aborted`. `commit` pins the trunk commit the
owner confirmed: a different refs/heads/<trunk> refuses before any effect.
`attestGenesis` runs under its own `genesis` lock: two genesis attests do not
overlap, and node attests (which measure missing genesis items first) are never
blocked by it — both record as in §7.10, so concurrent observations of one item
are each a fact about its key. It is abortable like attest (§7.8). It registers
itself synchronously when called (before its first await) until it ends; while
registered, `status` in that process marks the genesis progress `measuring` (§10.1).
`StatusView.genesis = {observed, total, pending, measuring?}` is present only
while genesis items lack observations.

## 9. Views

- **Receipt card** (`why`): per obligation: ✔ measured (executor pass, with log
  sha, counts, duration), ✔ reviewed (reviewers), ⚠ waived (owner, reason, channel),
  ✘ rejected, ⊥ awaiting observation, ⊤ conflict, ⏸ deferred, ⛔ blocked (active blocks and how to clear them).
  Under its item line, every `fail` observation with a note shows it: a line
  `  note #<seq>:` then each line of the note as recorded, indented four
  spaces (so the last output lines of a failed command, §7.2, reach `owed
  why`/`owed_why` and the driver's repair message, which embeds the card).
  A `rulings` item satisfied while no ruling is in scope for the node reads
  "no rulings apply" (not "acknowledged"/"satisfied"); its status is unchanged.
  When the plan has `exec` (§3.2), the line after the node header is
  `Exec: wrap <argv> · env <NAMES>` (present parts only; argv words with blanks
  or quotes JSON-quoted; env names sorted, values never shown); `--json` has
  `exec` with that line.
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
- **Allowances in views** (§3.4, D21): a downgrade a parent recorded under an
  allowance is labelled `by parent:<id> under allowance (plan #S)` — in the
  report's ΔO⁻ list (instead of the bare principal), in the brief's
  *Downgrades under allowance* section (same line format), in the receipt card (one
  `ΔO⁻ #seq by parent:<id> under allowance (plan #S): <node>: <what>` line after
  the JSON line; `--json` downgrades carry `allowance: S`) and in the CLI/pi
  output of `plan`. A parent adoption reads `#seq adopted by parent:<id> under
  allowance (plan #S) prior..commit …` in report and brief, in their own section
  apart from the owner decisions (`--json` `adoptions[].allowance`), and in the
  `adopt` output.
- **Out-of-writes paths** (receipt card, D21.5, for every plan): when the
  candidate's `writes` item is ✘ or ⛔ and changed paths lie outside the node's
  writes, the line `Out-of-writes paths: <p1>, <p2>, …` lists them (the first 20,
  then `… +N more`; `--json` `outOfWrites: {paths, allowance?}` lists all). When
  an allowance of the current plan matching the node covers every one of them
  with a `writes` prefix, the line ends with `; the parent may widen writes in the
  plan (allowance plan #S)`. A ruling never accepts out-of-writes paths.
- **Receipt card after a rebase**: `Rebased #seq: slot base <from> → <base>`,
  the previously reviewed patch (old base..old commit, submit seq) and
  `Re-review only the resolution: git range-diff <old base>..<old commit>
  <new base>..<new commit>` (`<new commit>` until the writer submits again);
  `--json` has `rebase: {seq, from, base, previous?, rangeDiff?}`.
- **Status**: trunk, nodes by state, ready list (sorted by number of transitive
  dependents; a ready node whose writes overlap an open slot is marked
  `(writes overlap open slot of X)`, `--json` `overlaps: {node: [ids]}`), pending queue grouped by discharger (owner / parent+writer /
  reviewer / executor), invariant debt on trunk. When refs/heads/<trunk> differs
  from the ledger trunk, a line after the trunk says so: `trunk moved outside
  owed: … ahead of the ledger trunk … by N commits; … owed adopt` (a fast-forward),
  or `trunk diverged from the ledger (rewritten or reset outside owed)` with the
  ahead/behind counts, or that the ref does not exist, or that the ledger trunk
  commit is missing from the repository (`ledger trunk <sha> is missing from the
  repository`); `--json` has
  `drift: {ref, commit, ledger, relation: ahead|diverged|missing|ledger-missing, ahead, behind}`.
- **Report** (`report --since`): merges, new E/W/D, blocks, downgrades, rulings,
  owner decisions needed — written in plain language —, owner actions (owner
  entries after `since` except `adopt`, which is listed once, under the trunk
  adoptions), trunk adoptions after
  `since` (seq, who, prior..commit, commit count, changed paths, note; `--json`
  `adoptions`): owner adoptions under `Trunk adoptions (owner decisions: commits
  made outside owed)`, parent adoptions under `Trunk adoptions under allowance
  (parent adoptions: commits made outside owed)`, each section shown only when non-empty, and an **Escapes**
  section: escape counts by class with each escape, decoys caught / escaped /
  pending with each revealed decoy, unrevealed commitments and the escape rate
  (cumulative, §6.5; `--json` returns it as `escapes`).
- **Manual obligations (D23)**: `approve` reads `✔ approved (<owner>, <channel>)`
  (pending: `⊥ awaiting owner approval`); `evidence:<id>` reads `✔ evidenced
  (manual) by <who>` with each file as `path sha12` and the note (pending:
  `⊥ awaiting manual evidence`); their detail ends `satisfied (manual)`. They
  are never counted or labelled as measured: the brief's Merged line counts
  them as `N manual (<obligations>)` (`--json` `manualItems`, present only when
  non-empty). An approve block's hint is `owed approve <node>`; the brief's
  owner command for a pending approve is `owed approve <node>`, for owner
  evidence `owed evidence <node> <id> --file <path> --note … --as owner:cli`
  (`--as` only where the command's default principal is not the owner).
  Receipts (evidence on a merged node) are listed by `why`
  (`Receipt #seq <node>/<id> by <who> (merge #m): files …; note: …`, `--json`
  `receipts`) and `report` (`Receipts (manual, informational)` for receipts
  after `since`, `--json` `receipts`); both present only when non-empty.
- **Brief** (`brief [--since seq|ISO]`, `briefView`/`renderBrief`): a morning
  summary, one line per item, sections in this order:
  0. *Owner acts (delegated) since <since>* (D25.5) — every owner entry with
     channel `delegated` after `since`, in ledger order:
     `#seq <by> <kind>[ <node>]: <what> — <note or reason>` (what: the downgrade
     items, the waived obligation, the deferred invariants, the adopted
     prior..commit, the ruling's nodes, …); `--json` `delegated`
     `[{seq, ts, by, kind, node?, what, note}]`; omitted when there is none.
     `report` and every entry line mark these entries `(delegated)`.
  1. *Needs your decision* — the owner queue (node and trunk items with status D
     and discharger `owner`), sorted by the number of transitive downstream
     nodes of the item's node (trunk items count 0), then node id and
     obligation; each line carries the exact command that discharges the item:
     `owed review <node> [--obligation closure-review] --ok --rank 3 --as owner:cli`
     for `review`/`closure-review` items whose only blocks (if any) are active
     judgment blocks, otherwise `owed waive <node> <obligation> --reason … [--accept-risk
     <every active block seq on that obligation>]`; trunk invariants cannot be
     waived, so their line points to `owed plan` (add a repairing node).
  2. *Merged* — per merge entry after `since`: counts of measured (status E,
     execution obligations: `check:*`, `red:*`, `writes`) and waived (status W)
     obligations, reviewed obligations, deferred invariants, untested changes
     (as in the receipt card) and the reviewers. A waived item is counted only
     as waived, never as measured.
  2a. *Adopted outside owed (owner decisions)* — per owner `adopt` entry after
     `since`: seq, owner, prior..commit, commit count, changed paths and note
     (`--json` `adoptions`); omitted when there is none. Parent adoptions follow
     under *Adopted outside owed (parent adoptions under allowance)*, labelled
     `adopted by parent:<id> under allowance (plan #S)`; omitted when there is none.
  2b. *Downgrades under allowance* — the downgrades a parent recorded under an
     allowance (§3.4) in plan entries after `since`, one line per item labelled as
     in the report: `#seq by parent:<id> under allowance (plan #S) <node>: <what>`
     (`--json` `allowanceDowngrades`, the ΔO⁻ records); omitted when there is none.
  3. *Rejected or blocked* — every non-cleared block of an unmerged node: node,
     obligation, the failing observation seq (execution blocks; the block seq
     is the failing obs) or the blocking review (judgment blocks), and how to
     clear it (clearing hints above).
  4. *In progress* — dispatched and submitted nodes with the age since dispatch
     (and since the last submit).
  5. *Total* — merged / accepted-unmerged / blocked (unmerged nodes with a
     non-cleared block) / ready counts, plus nodes waiting on dependencies.
  `since` (seq or ISO time, invalid → usage error) filters only the Merged
  and Adopted sections; the other sections always show the current state. `--json` returns
  the structured `Brief`.

### 9.1 Trunk checked out in another worktree (D19.5)

`owed status` (and `/owed`, `owed_status`) shows one line after the trunk line
when the trunk branch is checked out in a worktree other than the main worktree:
`Trunk <name> is checked out at <path>; merges fast-forward it there (keep it
clean).`; `--json` has `trunkWorktree: <path>`. Nothing is shown when the trunk
is checked out in the main worktree or nowhere.

## 10. CLI

`owed <command> [args] [--json]`; commands mirror §8: `init <plan.yaml>`,
`plan <plan.yaml> [--rev <commit-ish>]` (path relative to the cwd; with
`--rev` the file is read from that commit, so a plan kept in trunk is the
ledger plan), `rule <text> --nodes a,b|*`, `dispatch <node> [--allow-overlap]`,
`submit <node> [--commit X]`, `rebase <node>` (parent, or the slot writer when
run inside its worktree), `attest <node> [--rerun]`,
`review <node> --ok|--block [--needs-parent] --rank N --as reviewer:ID [--note] [--ack-rulings]`
(`--needs-parent` records `needs: "parent"`; refused with `--ok`),
`waive <node> <obligation> --reason ... [--accept-risk 12,15]`
(`review`, `waive`, `approve` and `evidence` also take `--candidate COMMIT`,
§8 act binding),
`defer <node> <inv-id...> --reason`, `abandon <node> [--note TEXT]` (older
spelling `--reason`; not both), `merge <node>`, `status`,
`why <node>`, `report [--since seq|ISO]`, `brief [--since seq|ISO]`, `verify`,
`adopt [--commit X] --note TEXT` (owner; `--as parent:ID` under an `adopt`
allowance, §3.4, with no prompt and no preview; before the TTY prompt, and also with
`--i-am-owner`, it prints to stderr the preview — full ledger trunk
prior..commit, commit count, every changed path one per line and the note,
escaped as in §11 — and adopts exactly the previewed commit, so a ref that moves
after the confirmation is refused),
`escape <node> --merge N --class missing|false-pass|reuse|weak|waiver --note T [--evidence T]`
(parent by default, or owner), `decoy commit <digest>`, `decoy reveal <file.json>`
(owner commands), `decoy digest <file.json>` (prints the digest to commit;
no ledger write, no owner confirmation), `gc [--dry-run]` (parent/owner), and
`drive [--once] [--max N]` (the driver, §12.7; always `parent:drive`, no `--as`),
`drive --detach [--max N]`, `drive --status [--json]`, `drive --stop [--now]`
(the background driver, §12.8),
`approve <node> [--note TEXT] [--block]` (D23: owner, default `owner:cli`, `owner:human` under `OWED_CONFIRM=owner`;
delegated by default — no prompt, TTY or not, D25 §2.1; under `OWED_CONFIRM=owner`
a TTY confirmation or `--i-am-owner`; `--block` records an owner block; before
recording (and before any prompt) it prints to stderr `Approve node <node>: candidate <commit>
(submit #<seq>), base <base>, N changed files` and approves only that candidate) and
`evidence <node> <id> [--file PATH]... --note TEXT [--as role:id]` (D23: default
`parent:cli`; `--file` may repeat, paths relative to the cwd, hashed when
recorded; stored repository-relative when inside the repository, else absolute;
an owner `--as` prompts like other owner commands).
`--as role:id` sets the principal (default `parent:cli`; `submit` and `rebase`
default to the slot's writer when run inside its worktree). Owner commands are
delegated (D25, §2.1: `channel: delegated`, no prompt, TTY or not); `--i-am-owner`
records `channel: flag`. Under `OWED_CONFIRM=owner` they prompt on a TTY as in
0.4.1 and refuse without one unless `--i-am-owner`. `plan` takes `--note TEXT`
(required for a delegated downgrade). In a pi-durable-subagents call owner and
parent commands are refused (§2.1). Exit codes: 0 ok, 1 refused
by a guard (message says which obligation), 2 usage error, 3 internal error,
130/143 aborted by a signal.

Signals (D16). While `attest`, `merge`, `init` or `adopt` runs (after any owner
confirmation), SIGINT, SIGTERM and SIGHUP are handled: the first aborts the
operation (§7.8: the running check's process group is killed, nothing more
starts), the CLI prints `Aborted: <signal>` to stderr and exits 130 (SIGINT) or
143 (SIGTERM/SIGHUP); signals within 1 s of the first are the same request
(ignored), and a signal 1 s or more later while aborting exits at once with the
same code as the first. So `hold machine -- owed attest` releases the lease only after
the checks ended. Exit codes describe the ledger outcome (`owed drive` reads them,
D14.3): a signal that arrives after the last abort point, when the operation
completed, does not change the exit code — the normal result is printed, stderr
says `Signal <SIG> arrived after the operation completed; nothing was aborted`,
and the exit is the operation's normal code (0/1); only an operation that was
actually aborted exits 130/143. The handlers are removed when the command ends.
SIGKILL cannot be handled: checks already started then keep running in their own
process groups until their own end (their timeout timer died with owed) — out of
scope. A second signal exits without removing the running job's temporary
worktree (`owed-run-*/tree` under the temp directory): `git worktree remove --force
<path>` removes it; once the directory is gone (deleted, or by the temp cleaner),
`git worktree prune` (also run by `owed gc`) drops its registration.

### 10.1 Init, attest --genesis and the genesis warnings (D24)

- `owed init` exits 0 once genesis is recorded. When its genesis attest did not
  observe every genesis item (an error verdict, an exception) it prints, after the
  initial observations count (and `Genesis attest stopped: <error>` for an
  exception), `Initialized (genesis #<seq>). Genesis attest incomplete: recorded
  <ids>; missing <ids>: run owed attest --genesis, or the next attest/merge
  measures them first.` (`none` for an empty list) — never "retry". Aborted by a
  signal it prints the same line, then `Aborted: <signal>`, and exits 130/143.
- `owed attest --genesis` (no node; not with `--rerun`; abortable like attest)
  measures the genesis items still lacking an observation and prints `Genesis
  attest: N observation(s) recorded; observed <ids> [(failed <ids>)]; missing
  <ids>`; exit 0 when no item is missing, else 1.
- `owed plan` while genesis items lack observations succeeds and adds the line
  `Warning: genesis attest pending for <ids>` (stdout; stderr with `--json`).
- `owed status` (and `owed_status`, `/owed`) shows, after the trunk line while
  genesis items lack observations, `Genesis: <k>/<n> invariants observed` then
  `(measuring in this session)` in the process running the genesis attest, else
  `— run owed attest --genesis (or the next attest/merge measures them)`,
  then `; pending: <ids>`.
- Signals: an `init` aborted after genesis was appended prints the incomplete line
  above before `Aborted: <signal>` (exit 130/143).

## 11. pi extension

Tools (exposure direct). Every tool takes an optional `cwd`: an absolute path
inside the target repository (the session directory when omitted; a relative
or missing path is an error), so a session started elsewhere can drive any
repository. Most tools also take `as` (`role:id`).

| tool | parameters (besides `cwd`) | operation |
|---|---|---|
| `owed_status` | `as` | status view |
| `owed_why` | `node`, `as` | receipt card |
| `owed_report` | `since?`, `as` | report |
| `owed_brief` | `since?` | brief |
| `owed_verify` | — | hash chain + replay |
| `owed_dispatch` | `node`, `allow_overlap?`, `as` | dispatch; returns the packet plus a ready-to-use `subagents` call spec (agent `worker`, cwd = slot worktree, isolation `none`, task = packet) |
| `owed_submit` | `node`, `commit?`, `as` | submit (writer inferred from a `cwd` inside the slot worktree) |
| `owed_rebase` | `node`, `as` | rebase (parent/owner or the slot writer, inferred as for submit) |
| `owed_attest` | `node`, `rerun?`, `as` | attest |
| `owed_review` | `node`, `verdict`, `rank`, `note`, `obligation?`, `ack_rulings?`, `needs_parent?`, `candidate?`, `as` | review (`needs_parent: true` = `needs: "parent"`, block only); as owner under the gate the dialog shows and pins the candidate (§8) |
| `owed_merge` | `node`, `as` | merge |
| `owed_abandon` | `node`, `note?` (older `reason?`; not both), `as` | abandon (parent/owner) |
| `owed_gc` | `dry_run?`, `as` | gc (parent/owner) |
| `owed_rule` | `text`, `nodes`, `as` | ruling |
| `owed_plan` | `plan` (path relative to `cwd`), `rev?`, `note?` (why; required for a delegated owner downgrade), `as` | plan update; a downgrade needs the owner unless an allowance of the current plan covers every downgrade (§3.4): then the default principal is `parent:pi`, no dialog, and the result names the allowance; otherwise the refusal for a parent lists the uncovered items |
| `owed_init` | `plan` (path relative to `cwd`), `as` (default `owner:pi`, delegated; `owner:human` under `OWED_CONFIRM=owner`; owner only) | initialize the ledger (§11.1) |
| `owed_waive` | `node`, `obligation`, `reason`, `accept_risk?`, `candidate?`, `as` | owner waiver; under the gate the dialog shows `Candidate: <commit> (submit #<seq>)`, `Base:`, `Changed files:` and only that candidate is waived (§8) |
| `owed_approve` | `node`, `note?`, `block?`, `candidate?`, `as` (default `owner:pi`, delegated; `owner:human` under `OWED_CONFIRM=owner`; owner only) | owner approval (D23); under the gate the dialog shows `Approve node <node>` (or `Block approval of node <node>`), `Candidate: <commit> (submit #<seq>)`, `Base: <base>`, `Changed files: <n>`, then the note; only that candidate is approved (§8) |
| `owed_evidence` | `node`, `id`, `files?`, `note`, `candidate?`, `as` (reviewer/parent/owner) | manual evidence or receipt (D23); an owner is delegated (no dialog; under `OWED_CONFIRM=owner` a dialog showing `Candidate: <commit> (submit #<seq>)` and `Base: <base>` (or `Receipt on merge #<m>`), `Files (N):` as `path sha12 (bytes)` and the note; the recording is refused if the files or the candidate changed after the dialog) |
| `owed_defer` | `node`, `items`, `reason`, `as` | owner deferral |
| `owed_escape` | `node`, `merge`, `class`, `note`, `evidence?`, `as` | escape record (parent/owner) |
| `owed_adopt` | `commit?`, `note`, `as` (default `owner:pi`, delegated; `owner:human` under `OWED_CONFIRM=owner`) | adopt trunk commits made outside owed (owner; `as: parent:…` under an `adopt` allowance, §3.4); under the gate the dialog shows prior..commit, the commit count, the changed paths and the note, and the confirmed commit is the one adopted. Changed paths: a `Changed paths (N):` line, then up to 50 paths one per line (indented, escaped as below); beyond 50, the first 50 and then the line `… +M more paths; full list: git diff --no-renames --name-only <prior12>..<commit12>` (M = N − 50, the 12-character prior and adopted commits) |
| `owed_decoy` | `action` (`commit`/`reveal`/`digest`), `digest?`, `file?`, `as` | decoy commitment and reveal (owner); `digest` writes nothing |
| `owed_drive` | `action?` (`once` default, `start`, `status`, `stop`), `max?` (once/start), `now?` (stop) | the driver (§12.7, §12.8): one pass, or start/report/stop the background driver; start makes this session follow its log for wake-ups |

`owed_attest`, `owed_merge` and `owed_adopt` pass the tool call's abort signal
to the operation (§7.8, D16.4): aborting the call ends the running check; the
result is a tool error `Aborted: aborted` (details `code: aborted`). `owed_drive`
(action once) passes it to its pass as well: the pass stops after the current
action (§12.7).

Owner operations (`waive`, `defer`, `adopt`, `approve`, owner `evidence`, `init`,
downgrade plans, decoys, and any tool called with `as: owner:…`) are delegated
(D25, §2.1): no dialog, recorded with `channel: "delegated"`, default principal
`owner:pi`; `owed_plan` takes `note` (required for a delegated downgrade). Under
the opt-in gate `OWED_CONFIRM=owner` the default principal is `owner:human` and
they call `ctx.ui.confirm` and are recorded with `channel: "pi-confirm"`; without
UI they refuse. That dialog waits at most `OWED_CONFIRM_TIMEOUT` seconds (a
non-negative integer, default 120; `0` waits indefinitely; any other value means
the default): owed passes `{timeout: N·1000 + 1000, signal}` to
`ctx.ui.confirm` (pi shows a countdown that outlasts owed's own limit) and races
the dialog against its own N-second timer and the tool call's abort, so a UI
that ignores `timeout`/`signal` or never answers cannot hold the call. When
owed's timer fires it aborts the dialog, ignores any later answer, records
nothing and refuses with code `refused` and `Owner confirmation not given within
<N> s; nothing was recorded.`; the tool call's abort (Escape) dismisses it the
same way and refuses `aborted`. Neither is ever read as a confirmation. `owed_approve` and owner `owed_evidence`
pass the confirmed candidate (D23 pin) in both modes; delegated acts record on
the current candidate. In a pi-durable-subagents call every tool that acts as
owner or parent is refused (§2.1). The confirmation text is the
fixed summary, then `Repository: <dir>` and `Identity: owner:<id>`, then each
free-text field (note, reason, ruling, evidence, changed paths) as `Label: value` on one line
with `\`, newlines and tabs escaped and C0/C1 controls (U+0000–U+001F,
U+007F–U+009F), U+2028/U+2029 and bidi controls (U+202A–U+202E, U+2066–U+2069)
written as `\uXXXX`, then the closing
`Confirmation will be recorded as pi-confirm.` line — so free text cannot fake
the Repository/Identity lines of the dialog. The ledger keeps the exact text. Command `/owed` shows
status. A skill (`skills/owed/SKILL.md`) explains the loop: status → dispatch →
run worker with dsa → submit → attest → review (fresh reviewer, not the writer)
→ merge, and the rules agents must not break.

### 11.1 `owed_init` (D24)

`owed_init {plan, cwd?, as?}` is owner only (default `owner:pi`, delegated: no
dialog, channel `delegated`; D25). It reads and parses the plan, resolves
refs/heads/<trunk>, refuses an initialized ledger (`Already initialized …`,
before any dialog), then, under `OWED_CONFIRM=owner` only, shows the owner dialog: the fixed summary
`Initialize the owed ledger`, `Trunk: <name> at <commit12>`, `Plan: <path>
(sha256 <sha12>)` (the sha of the stored plan blob that genesis records),
`Nodes: <n>`, then Repository/Identity and the list field `Invariants:` (one id
per line); recorded with channel `pi-confirm` (`delegated` without the gate). It appends genesis for exactly the
confirmed commit (`init` with `measure: false`, `commit` pinned), starts
`attestGenesis` in the background in-process (an AbortController aborted on
`session_shutdown`) and returns at once: details `{entry, genesis: <seq>,
measuring: <n>}`, text `Initialized (genesis #<seq>). Measuring <n> genesis
invariants in the background …` (`No invariants to measure.` when none, and then
nothing runs). When the background attest ends the session gets one message
(customType `owed-init`, display, `triggerTurn`, `deliverAs: followUp`, as D17.7):
`owed init: genesis attest of <dir> finished: recorded <ids>; failed <ids>;
missing <ids>` (or `stopped (<error>)`, with the `owed attest --genesis` hint
when items are missing). After `session_shutdown` aborted it no message is sent.
`owed_plan` adds `Warning: genesis attest pending for <ids>` as the first line
(details `warning`) while genesis items lack observations.

## 12. Driver

`owed drive` is a deterministic program that runs the mechanical loop
`status → dispatch → writer → submit → attest → reviewers → merge` with dsa
(pi-durable-subagents) as the process runner and stops only for decisions.
Boundary: dsa never judges completion and never learns the graph; owed never
schedules processes, slots, models or leases. The driver never answers a
question, never waives, never changes the plan, never runs `restart --force`.
The parent-pinned contract is `.owed/drive-contract.md` (D1–D8); this section
records its ledger-facing parts and the executor. `owed drive` requires
pi-durable-subagents ≥ 1.0.27 (`hold --no-wait`).

### 12.1 Level-triggered reconcile (D1)

One **pass** reads the ledger state, `describe --key`s every open launch,
computes actions with a **pure** function `decide(state, plan, runs, opts)`
(`src/drive.ts`), and executes them in order. Events are only a wake-up
signal; losing the event cursor or the drive state dir is harmless because
every pass re-derives from the ledger plus `describe`. `RunView`
(`src/types.ts`) is the subset of `describe --key <rid> --json` the driver
uses: `{rid, state: absent|queued|running|asking|sealed|pruned, status?,
error?, questions?: {qid, rev, question}[], lastFence?: {reason, at}}`
(unknown dsa states map to `running`; `pruned` is treated like `sealed`).

### 12.2 Plan config (D2)

```yaml
drive:
  max: 4                 # concurrent open attempts the driver starts (default 4, integer >= 1)
  repairs: 2             # follow-ups after a failed check / block before halting (default 2, integer >= 0)
  writer:   { agent: worker,   model: "example/model-large:high" }   # default {agent: worker}
  reviewer: { agent: reviewer, model: "example/model-large:high" }   # default {agent: reviewer}
```
Optional; `model` is optional (agent default). `parsePlan` fills the defaults
when the block is present (`Plan.drive`; absent block → `Plan.drive`
undefined, `driveConfig(plan)` returns the defaults) and rejects unknown keys
(in `drive`, `writer`, `reviewer`) and bad types. It is not an obligation:
changing or removing `drive:` is never a downgrade (a plan change by parent).

### 12.3 Ledger entries (D3)

Persist before submit: an intent is appended **before** the dsa call, and every
retry re-sends the exact stored bytes with the same id. Entry kinds `launch`,
`send`, `halt` (§5) may be appended only by role `parent`; launch and send
must name the node's current open slot (node and attempt), and so must a halt.

- Project id `projectId(state)`: the first 12 hex of the genesis entry hash
  (stable per ledger).
- Run id `runId(project, node, attempt, role, n?)` =
  `owed:<project>:<node>:<attempt>:<role>[:<n>]`. Writer rids have no `<n>`.
  Reviewer rids always carry `:<n>` (the ledger refuses a reviewer launch
  without it): `n` = 1 + the reviewer launch entries already in this attempt
  (`nextReviewerN(state, node)`), monotone across the candidates of the
  attempt, so a resubmitted candidate gets fresh rids and reviewer ids. A
  reviewer run belongs to the latest candidate whose submit seq is below its
  launch entry's seq: for the current candidate, `reviewerBase(state, node)` =
  the reviewer launches of the attempt with seq below its submit seq, and its
  runs are `n = base+1 … base+reviewRuns` (local index `k = n - base`).
- Labels `runLabels(project, node, attempt, role)` =
  `{owed: <project>, node, attempt: String(attempt), role}`.
- Driver reviewer principal: `reviewer:drive-<node>-<attempt>-<n>`
  (`driveReviewer`).
- `ops.launch` stores the spec bytes as a blob and is idempotent: a launch with
  the same rid and identical content returns the recorded entry
  (`created: false`); a different one is refused. `ops.send` stores the message
  bytes and assigns the send id under the lock. `ops.halt` records a halt.
- State: `NodeState.runs` lists per attempt the launches and sends
  (`{attempt, launches, sends}`); `NodeState.halt` and the reducer's
  `halted(state, node) → HaltEntry | undefined` give the active halt.
- A halt blocks the driver on that attempt until a later entry on the same node
  by a principal other than `parent:drive` — submit, review, rebase, abandon,
  waive, defer, escape, a ruling whose node list names it (not `*`) — or a new
  attempt (any dispatch of the node). Driver entries (`launch`, `send`, `halt`)
  and executor entries (`obs`, `merge`, which the driver causes) never clear a
  halt. A halt of an attempt that is no longer open is not active.

### 12.4 Views

- **Status**: a `Halted (driver):` section lists halted nodes with
  `needs: human` (`⏸ <node>: halted by driver #seq (attempt N, needs human):
  <reason>`); a halt with `needs: owner` appears instead under *Pending owner*
  (`⏸ halted <node> — driver halted attempt N (#seq): <reason>; cleared by …`).
  `Driver runs (open attempts):` lists the launches of each open slot's current
  attempt (`<node> attempt N: #seq <role> <rid>`). Both sections are shown only
  when non-empty; `--json` has `halted: HaltEntry[]` and
  `launches: {node: LaunchEntry[]}`.
- **Why**: the active halt with how it is cleared, then each launch
  (`Driver launch #seq <role> <rid> (spec <sha12>)`) and send
  (`Driver send #seq <kind> (<reason>) to <rid>: <send id>`) of the open
  attempt; `--json` has `halt?` and `runs?`.
- **Needs a parent ruling** (§12.5): `why` marks a needs-parent block on the
  current candidate `⛔ blocked #seq <obligation> (needs a parent ruling): …`
  until a ruling naming the node follows it, then `(ruled #<rule seq>)`; a stale
  needs-parent block (recorded on an earlier candidate) keeps the ordinary
  block wording. `status` lists current-candidate blocks of open attempts still
  awaiting a ruling under `Blocked (needs a parent ruling):`
  (`⛔ <node>: blocked #seq <obligation> (needs a parent ruling): <note>; record
  owed rule --nodes <node> "<decision>"`; `--json` `needsRuling`, present only
  when non-empty).
- **Report**: `Driver halts` lists halts after `since` plus every still active
  halt, each marked `(active)` or `(cleared)` (shown only when non-empty;
  `--json` `halts`).

### 12.5 Actions (D4)

`decide` outputs `dispatch | launch | send | attest | rebase | merge | halt |
notify` actions per the policy table of the contract (first matching row per
open attempt, at most one action per node per pass; a halted attempt gets
none). Not per slot: while open slots < `max`, ready nodes are dispatched in
status order, skipping nodes whose writes overlap an open slot and nodes that
need owner action. One reviewer run covers all of a candidate's review
obligations (review and closure-review); a node with `review.count` > 1 gets
one run per required principal, each with the next attempt-global `n`
(`nextReviewerN`), so distinct reviewer ids.

Review blocks that need a parent ruling (D18, D18b). Once the candidate is
measured (after the attest rows) and before any repair — the measured repair
included, so no repair carries an undecided contract — if any review block on
the current candidate has `needs: 'parent'` and no ruling naming
the node (`--nodes` includes it; a `*` ruling is general guidance and does not
count) has a seq above the block's, the action is a halt needing `human`:
`review block #<seq> <obligation> needs a parent ruling: <note>; record
\`owed rule --nodes <node> "<decision>"\`; the writer gets the ruling with the
next repair` (one clause per such block; with a repair already outstanding the
ruling reaches the writer with the following repair or the re-review). No repair follow-up is sent and none is
counted. That node-named ruling also clears the halt (§12.3); the block is then
repaired as usual, and every repair message lists, after the review notes, the
rulings covering the node recorded after the dispatch (`Rulings since
dispatch:` with `- #seq text`); the note of a needs-parent block quotes its
ruling (`ruling #seq: text`), also when that ruling predates the dispatch (a
block from an earlier attempt). The re-review acknowledges them through
`ack_rulings` as before.

Owner approval and manual evidence (D23). After the rows above (attest, needs
a parent ruling, measured repair, reviewer launches, review-missing, review
blocks), when every unsatisfied item of the candidate is `approve` or
`evidence:<id>` and the node has no active or flaky block, the action is a halt
needing `owner` while `approve` is pending, else `human`, with one clause per
item: `awaiting owner approval of candidate <commit12>: owed approve <node>
[--note TEXT] (owner)`, `awaiting manual evidence evidence:<id> (<what>) by
<role>: owed evidence <node> <id> --file <path> --note "<what was checked>" --as
<role>:<id>`. It also halts while the writer still runs; it never halts for them
earlier. The owner's approval or an evidence entry clears the halt (§12.3); the
driver then halts again for what remains or merges. An owner block on `approve`
is an owner decision (`ownerNeeded`: notify only). The review packet describes
`approve` as the owner's and an evidence item by its role; for `by: reviewer`
it gives the reviewer's `owed evidence` command.

#### 12.5.1 Rulings reach running calls; run names; answer address (D22)

- **Rulings carried (E4, 0.5.1).** The driver computes `rulings` while it
  builds a message, from the same state, and records it on the entry: a writer
  launch the in-scope rulings of its dispatch packet (recorded before the
  dispatch), a reviewer launch every in-scope ruling (its review packet), a
  `repair` send the rulings since dispatch and the rulings quoted by
  needs-parent block notes; the highest seq, 0 when none. A re-launch copies the
  recorded value. So a ruling recorded between `decide` and the append is not
  counted as carried and is steered afterwards. Replay refuses a value that is
  not an integer ≤ the entry's seq naming 0 or a ruling covering the node. A
  0.5.0 reducer refuses these entries (unknown `rulings` on a launch, `rulings`
  on a repair): a ledger written by 0.5.1's driver needs owed ≥ 0.5.1.
- **Delivered rulings.** For each drive-launched run of the open attempt (the
  writer and the reviewer runs of the current candidate), *delivered* = the
  highest in-scope ruling seq (`--nodes` names the node, or `*`) the run already
  has: the max of `rulings` on its launch entry and on every `repair` and
  `ruling` send to it (also an unconfirmed or rejected ruling send), and for the
  writer its dispatch `rulings_seen`. Entries without the field (written by
  0.5.0) fall back to the 0.5.0 position rule: a reviewer launch carried the
  in-scope rulings recorded before its entry, a `repair` send those recorded
  before it (D22.4a), a writer launch `rulings_seen`.
- **Ruling steer (D22.2, D22.2a).** The lowest row of the table: used only where
  the node would otherwise get no action — row 18 (`fenced` first), the wait for
  a live reviewer run of the candidate behind a stale block, and a running
  writer with an outstanding repair. The first run in state `running` (never
  `asking`, `queued` or sealed; the writer, then reviewers by `n`) with an
  in-scope ruling above *delivered* gets a `steer` with reason `ruling` and
  `rulings` = the highest seq it lists: `New parent rulings for <node>:`, one
  line `#<seq> (<nodes>): <text>` per undelivered ruling (text on one line),
  then for a writer `Apply these rulings; they override your packet. If you
  already submitted, fix and submit again.`, for a reviewer `Judge the candidate
  against these rulings and record your review with --ack-rulings <seq>.`. Still
  at most one action per node per pass; every other row wins, so a steer waits
  a few passes at most. Only `fenced` steers count as the last steer of the
  fenced row, so a ruling steer never hides a fence.
- **Rejection (D22.3).** dsa rejecting a ruling send (e.g. the call sealed
  meanwhile) is printed (`rejected — <reason>; not retried …`) and never halts;
  a recorded ruling send dsa reports rejected is skipped by the re-send row and
  never sent again under a new id. The rulings then travel as before (repair
  messages list the rulings since dispatch; reviewers acknowledge with
  `--ack-rulings`). An unconfirmed ruling send is re-sent like any send (same id,
  stored bytes).
- **Obligation unchanged (D22.4).** A steer is not an acknowledgment: the
  `rulings` obligation still needs the reviewer's `ack_rulings`.
- **Run names (D22.5).** New launches carry dsa's run option `name` in the spec
  (`run --spec -` accepts it for the single-call form, pi-durable-subagents
  1.0.27): `owed <node>#<attempt> writer` / `owed <node>#<attempt> reviewer <n>`
  (`runName`), next to the labels. A re-launch of a recorded launch sends its
  stored spec bytes unchanged (a launch recorded before 0.5.0 has no name).
- **Answer address (D22.6).** The asking line (notify, drive output, wake-ups)
  addresses each open question by dsa's call address `questions[].to`
  (`<wid>/<key>` from `describe`), or the run id when dsa reports none, in both
  forms: `answer in pi: subagents {action:"send", kind:"answer", to:"<to>",
  qid:"<qid>", message:"…"}; or: pi-durable-subagents send --request <id> --to
  <to> --kind answer --qid <qid> --rev <rev> --message @<file>`.

### 12.6 Review packet (D5)

`reviewPacket(state, node, n)` (`src/views.ts`, pure) is the task of the
driver's reviewer run `n` (attempt-global, §12.3) on the current candidate; it
works before the launch entry for `n` exists (the driver builds the packet,
then persists the launch): node, attempt, candidate
commit (and submit seq), base, the plan title/brief, writes, every obligation
of the candidate with its required count/rank and current mark, rulings in
scope, the reviewer identity `reviewer:drive-<node>-<attempt>-<n>`, the exact
commands

    owed review <node> --as reviewer:drive-<node>-<attempt>-<n> --ok|--block --rank R [--obligation closure-review] [--ack-rulings S] --candidate <commit12> --note "..."

(`--candidate` names the reviewed candidate, §8 act binding: a resubmit during
the review makes recording fail; the line after the commands tells the reviewer
to re-read `owed why <node>` and review the new candidate then;
R = `review.min_rank`, at least 1, for `review`; 2 for `closure-review`;
`--ack-rulings S` with the latest in-scope ruling S when the rulings item is
owed; a rank above 2 is owner-only and the packet says the run cannot discharge
it), and the rules: inspect the actual diff (`git diff <base> <candidate>`), do
not edit files, record verdicts in the ledger, reply with seqs. Before the
commands it says: "If the brief or plan is ambiguous or contradictory, or the
fix needs a product or contract decision, record --block --needs-parent and
state the decision needed; do not push a guess onto the writer." (the command
lines themselves are unchanged). Before that line (0.6.1 H2.3) it says that
`--ok` means the candidate meets the node's goal as its title and brief state
it, not only that the writer's report or evidence is accurate, and that a
candidate or report saying the goal is not met is a `--block` (`--needs-parent`
when the goal itself is in question). The driver does not parse review notes.
`reviewRuns(state, node)` = `max(review.count, 1 if closure-review is required
else 0)` runs per candidate; with `k = n - reviewerBase(state, node)`,
`reviewObligations(state, node, n)` = `review` while `1 ≤ k ≤ review.count`,
plus `closure-review` for `k = 1`. A run of an earlier candidate (`k < 1`) or
beyond the candidate's runs has no obligations, and `reviewPacket` refuses it.

### 12.7 Execution and surfaces (D6, D7)

`src/drive-run.ts` executes the actions of `decide` as principal `parent:drive`.

- **Pass.** Load the ledger state; for every open, not halted attempt
  `describe --key` its live runs (the writer and the reviewer runs of the
  current candidate); for every recorded send this process has not confirmed,
  `describe --key <send id>` (`applied`/`rejected` are taken as dsa's decision;
  only an `absent`/`pending` send is re-sent); read the stored blobs a retry
  needs; `decide`; execute the actions in order. A failed describe leaves that
  node without an action this pass.
- **Persist before submit.** `launch`: `ops.launch` (idempotent on identical
  content) then `dsa run --request <rid> --spec -` with the exact spec bytes;
  `send`: `ops.send` (assigns the send id) then `dsa send --request <id>`; a
  re-send uses the recorded id and the stored message bytes. Outcomes: 0
  applied (the send id is remembered as applied); 1 rejected → `halt` needing
  a human in the same pass, reason = dsa's text followed by the abandon
  recovery sentence (D15.1); 3 request-conflict → `halt`
  in the same pass (never retried with other bytes); 75, a timeout or a dsa
  child killed by a signal → pending, the next pass retries the same id and
  bytes. After a human clears a halt, the next pass retries the same id and
  bytes (dsa answers again).
- **A rejected request is fixed for its attempt (D15.1).** The id and bytes of
  a recorded run or send cannot change, and dsa answers the same id the same
  way (a send id stays rejected; a run rejected before creation is checked
  again, with the same stored bytes). The halt reason of a rejection (exit 1,
  or `describe` reporting the run `rejected`) therefore ends with "this
  attempt's request is fixed; fix the cause (plan, agent, model), then `owed
  abandon <node>` to start a new attempt". A ruling, submit or review clears
  the halt as any other, but the retry re-halts with the same text; abandon
  (then the driver dispatches a new attempt with new ids) is the recovery.
- **Verdicts are durable when they happen (D14).** The ledger (plus
  `describe`) is the only state that carries a decision across passes: every
  verdict (dsa rejection or conflict, merge refusal, attest error) is written
  in the pass that meets it; nothing in memory decides a later pass. What the
  process keeps are caches of dsa's answers (send ids dsa reported applied,
  follow-up generations) and what the loop last printed.
- **Follow-up generations.** A follow-up applied in this process returns the
  generation it started; until `describe` reports that generation (highest
  `calls[].gen`), a sealed view of the run is the previous generation's and is
  presented to `decide` as `running`, so a lagging describe never causes a
  second follow-up or a halt.
- **Attest** runs `pi-durable-subagents hold machine --shared --no-wait --
  owed attest <node>` in the main worktree when dsa is available (else `owed
  attest <node>` directly); the driver's own process never holds a lease.
  Exit 75 is hold refusing the lease without queueing anything (`owed` itself
  exits only 0–3): the machine is busy; the driver prints hold's message (the
  blockers) and retries next pass. A non-zero exit with a
  `pi-durable-subagents:` error on stderr and no stdout is dsa rejecting the
  invocation — on dsa < 1.0.27 `Unknown option --no-wait` — and halts the
  attempt needing a human (an attest error, not a busy machine). `owed attest`
  exits 0/1 are done (the ledger says what follows); any other exit (2/3), a
  signal or a timeout halts needing a human in the same pass.
- **Merge** refusals are acted on in the same pass: `rebase needed` →
  `ops.rebase` (the writer's `rebase` follow-up comes from a later `decide`);
  the transient `Plan, candidate or trunk changed; retry` (the ledger moved
  while merge measured; merge recorded nothing) → retried next pass, no halt,
  not progress; trunk CAS drift (the ref moved during the merge) → the trunk
  drift notify below, retried next pass, no halt; any other → halt needing a
  human.
- **Trunk drift** (0.5.1, review ruling #559). The trunk ref no longer
  equal to the ledger trunk is a repository fact, not a node fact: 0.5.1
  drivers never record it as a ledger halt. Each pass, before merging, the
  driver compares `refs/heads/<trunk>` with the ledger trunk; on drift it
  merges nothing that pass (every other action continues) and emits one
  repo-level owner notify (node `trunk`, `facts` = the ledger trunk's seq):
  `trunk <name> moved outside owed (<ledger12> → <ref12>); the main agent
  resolves it with: owed adopt --note "<why>"` when the ref fast-forwards the
  ledger trunk, otherwise `trunk <name> was rewound or rewritten (<ledger12> →
  <ref12|missing>); restore it: git update-ref refs/heads/<name> <ledger>
  <ref>` (full commits; `""` for a missing ref). The loop prints it once per
  change and the follower wakes once per change. After `owed adopt` the next
  pass merges with no other act. A halt recorded for drift by a 0.5.0 driver
  (`merge refused: trunk changed (CAS)…`, needs owner) stays a ledger halt:
  adopt (or restore) trunk, then clear it with `owed rebase <node>` (the
  writer rebases and resubmits, then the driver re-attests and merges).
- **Stalled** (D12): the `stalled:` halt lists every non-E item and each
  active block as `#seq <obligation> by <principal> rank <r> on candidate #C`
  (`stale` instead of `on candidate #C` when recorded on another key; no rank
  for an execution block), so the owner can act without `owed why`.
- **Lock.** `<ledger dir>/drive.lock` (`.git/owed/drive.lock`): pid, process
  start time, host, written aside and hard-linked into place; stale when the
  pid is gone or reused; a live holder makes `owed drive` (also `--once`)
  refuse (exit 1). A lock of another host is never taken over: the refusal
  names host and pid; after checking that no driver runs there, remove the
  lock by hand.
- **Pi session** (0.5.1 E1, pi-durable-subagents 1.0.31). A driver's runs
  belong to the pi session that started it. On start (`owed drive`, `--once`,
  `--detach`, tool `owed_drive`) owed reads `DSA_SESSION` from its
  environment — ignored when `DSA_CALL` or `DSA_EXEC` is set (a subagent) or
  when it is not a session id as dsa 1.0.31 accepts it (starts with a letter
  or digit, then up to 127 of `[A-Za-z0-9._:-]`), as dsa does — and records it as `session` in `drive.lock` (absent when
  none). `--detach` passes the starter's value to the detached driver as
  `DSA_SESSION` (and removes an inherited one when the starter has none).
  Every `pi-durable-subagents run` the driver issues passes `--session <id>`
  when a session is recorded; the flag is not part of the request bytes, so a
  retry passes it again without a conflict. The dsa client removes
  `DSA_SESSION` from every dsa child's environment, so dsa never takes a
  session from it and the lock and what dsa records never disagree. A dsa that refuses the flag (older
  than 1.0.31: `Unknown or repeated option --session`, which records nothing)
  is detected once per driver: the run is repeated without the flag, later
  runs omit it, and the driver logs one line, `dsa does not accept --session
  (older than pi-durable-subagents 1.0.31): runs start without it and are not
  listed in pi session <id> (<refusal>)` (`--json`: event
  `session-unsupported`, quiet for wake-ups); never a halt. While a driver
  holds the lock (this or another host), `owed drive --status` (and tool
  `action: "status"`) adds after its first line `runs are listed in pi session
  <id>` or `no pi session: runs show only in pi-durable-subagents status / the
  CLI`, `--json` adds `session` when recorded, and the `/owed` driver line
  ends with `; ` and the same text. No driver running: no session line.
- **Loop.** Passes run back to back while they make progress (at most 20;
  progress = the ledger head advanced or dsa applied a request in the pass, so
  an attest exiting 1 without a new entry is not progress), then the driver
  polls `events --all --since <cursor> --limit 100` every 3 s and runs a pass
  on an event labeled `owed: <project>`, or after 30 s. The cursor is
  `<ledger dir>/drive/cursor` (deletable); an expired (exit 4) or rejected
  (exit 1) cursor is reset to the head and triggers a pass; the limit halves
  only after a page the client could not parse and returns to 100 after a good
  page; other failures (e.g. a missing binary) are printed. In the loop a
  notify (asking run, owner-needed node) or a busy machine is printed only
  when its text changed for that node (busy compared without hold's ages).
  Exit 0 with `idle` when no attempt is open and nothing is dispatched; the
  first SIGINT/SIGTERM stops after the current action (`stopped`), a second
  stops at once: SIGTERM to the running dsa invocations (hold forwards it to its
  `owed attest`) and to the process groups of direct `owed attest` children,
  the lock released, exit 130 (the ledger stays consistent; `owed attest` ends
  the checks it started, §10 Signals). `owed drive --once` stops at once like
  this on the first SIGINT/SIGTERM (D16.3). The pi tool's pass installs no
  signal handlers. A merge runs inside the driver: the stop at once aborts it
  first (the driver's AbortController, D16a.1), so its checks get SIGKILL and
  trunk does not move. Accepted window: a stop after merge's `git update-ref`
  and before its ledger append leaves trunk ahead of the ledger; the next pass
  sees the drift and emits the trunk drift notify (never silent; the owner
  adopts the merge commit). Each process group gets one SIGTERM per stop; the
  `owed attest` CLI treats signals within 1 s of its first as the same request
  (hold may forward the driver's SIGTERM while the group also gets it).
- **Surfaces.** CLI `owed drive [--once] [--max N] [--json]` (one line per
  action: `<action>: <outcome> — <detail>`; notify lines verbatim; `--json`
  JSON lines). `--once` is one pass. Pi tool `owed_drive` runs `--once` by
  default (`action` start/status/stop: §12.8; the tool's abort signal stops
  the pass after the current action) and returns the output of the actions already executed also when a later
  step throws (as a tool error);
  a long loop belongs in a terminal or a `systemd-run --user` unit (a forced
  dsa restart kills every process of the dsa call that runs it, including its
  attest). `/owed` status adds `Driver runs in dsa:` with each live run's dsa
  state when dsa is available.

### 12.8 Background driver and wake-ups (D17)

`src/drive-bg.ts`. A tool call never runs the loop; `--detach` makes it a
separate, durable process, and the session is woken by its log instead of
polling.

- **Start** (`owed drive --detach [--max N]`, tool `action: "start"`).
  Serialized per repository by the ledger lock `drive-detach`. A live lock
  (this host, pid and process start time match) or a lock of another host →
  refused, naming pid, host, start time and the log. Else
  `<ledger dir>/drive/log.jsonl` is rotated to `log.jsonl.1` (one kept) and
  `owed drive --json [--max N]` (`process.execPath` + `bin/owed.js`, as for
  the attest child) is spawned detached (own session and process group, stdin
  ignored, stdout and stderr appended to the log, cwd = main worktree root,
  environment inherited without `NODE_TEST_CONTEXT`, `DSA_EXEC` and `DSA_CALL`
  (the driver carries no dsa call identity; `DSA_HOME` stays), unref'd). When
  the starter has `DSA_EXEC`, the output adds `note: started from inside a dsa
  call; if that call's processes are contained, the driver may end with it —
  prefer starting it from a top-level session or systemd-run --user`. It keeps the
  `drive-detach` lock until the drive lock names the child pid (then prints
  `driver started: pid P, log <path>`) or the child exited, waiting up to 30 s
  (D17a.3). A child that exits first with an `idle`/`stopped` exit record is
  reported as started and already ended (the tool starts no follower then);
  without an exit record or with an `error` record → refused with the last log
  lines (exit 1). No lock after 30 s → SIGTERM to the child (pid and start time
  checked), refused with the log tail (exit 1).
- **Exit record** (`--json` loop mode only, not `--once`): the last line is
  `{"event":"exit","code":C,"reason":R,"at":ISO,"error"?:text}`, R ∈ `idle`
  (after the `idle` line), `stopped` (after `stopped`), `killed` (the second
  signal path writes it before `process.exit(130)`), `error` (drive threw or
  the lock refused; `error` is the message, code = the CLI code 1/2/3, and
  `drive()` returns that code instead of throwing). The record is written
  before the drive lock is released (D17a.2), so a released lock implies the
  record. Signal handlers are installed before the lock is taken (D17a.6); a
  signal while starting stops the loop at its first check (`stopped`). Only
  SIGKILL or a crash leave no exit record. Text mode and `--once` are unchanged.
- **Text of a JSON line.** `reportText(json)` (drive-run.ts) is the text-mode
  line of an action report or a loop event; `Driver.emit` prints it in text
  mode, and status and wake-ups render log lines with it (a line that is not
  JSON is shown escaped).
- **Status** (`owed drive --status [--json]`, tool `action: "status"`): reads
  the lock and the log only (creates nothing): `driver running: pid P on H
  since T`, a lock of another host (not checked), or `driver not running`
  (`; it ended without an exit record (killed or crashed)` when the log has
  driver lines but no exit record; an empty log adds `no driver output yet`); `last exit: R (exit C) at T[: error]` from the log; the log
  path and its last 10 lines as text. Exit 0.
- **Stop** (`owed drive --stop [--now]`, tool `action: "stop"`, `now`): no
  live lock → `no driver running` (exit 0, nothing created). Otherwise under
  the `drive-detach` lock, so concurrent stops send one signal. A lock of another host, or one
  without a process start time, refuses. Else SIGTERM to the lock's pid when
  its start time still matches (never a reused pid); `--now` sends a second
  SIGTERM 1 s later if the lock is still held (D14.8: stop at once). Waits up
  to 10 s for the lock to be released: `stopped`, else `stopping: pid P exits
  after its current action`. Exit 0.
- **Flags.** `--detach`, `--status`, `--stop` and `--once` exclude each other;
  `--now` only with `--stop`; `--max` not with `--status`/`--stop` (it stays
  valid with `--once`); `--json` with any. The tool refuses `now` without
  `stop` and `max` with `status`/`stop` (usage).
- **Wake-ups** (src/extension.ts, `DriveWatch`/`Follower`). After a tool
  start (in any session), the follower reads the fresh (rotated) log from its
  start; on `session_start` of a session not inside a dsa call (`DSA_EXEC` and
  `DSA_CALL` unset, D17a.1), when the repository of `ctx.cwd` has a live lock,
  from the log's size at that moment (no replay). Every top-level pi session
  opened in the repository is therefore woken. A log replaced by rotation
  (other dev/ino, or shorter than the offset) is read from 0 (D17a.4). Every 2 s (unref'd timer) it reads the
  complete lines appended since. Wake lines: `do: halt`, `do: notify` (asking
  runs, owner-needed, describe failures), outcomes `rejected`, `conflict`,
  `refused` and `error` (refused merges and attest errors also halt), event
  `events-error`, terminal events `exit`, `killed`, `stopped`, `idle`, and any
  line that is not a JSON report. `cursor-reset`, dispatch, launch/send
  applied, attest, busy and pending are quiet; `merge` `merged` does not wake
  alone and is listed in the next message. All wake lines of one read form one
  `pi.sendMessage({customType: "owed-drive", display: true, content},
  {triggerTurn: true, deliverAs: "followUp"})`, content = `owed drive
  (<repo>):`, the carried merges and wake lines in log order, `Next: owed
  status / owed why <node>`. Identical wake lines within one read collapse.
  One wake per new fact (E3.1, replacing D17a.5's "every halt line wakes"):
  the driver adds to every node-scoped wake line (halt, notify, describe
  failure, outcomes rejected/conflict/refused/error) `facts`, the node's fact
  mark = the highest seq of ledger entries naming the node (`node`, an
  observation's `subject`, a ruling listing it) not written by `parent:drive`
  (0 when none; the driver's own launches, sends, halts, dispatches, rebases
  and merges are not new facts, writer/parent/reviewer/owner entries and
  executor observations are). The follower keeps per node the text (without a
  repeat suffix) and fact mark of the last wake it took for delivery; a line
  with the same text and a fact mark not higher is a repeat: it does not wake,
  and it rides along with the next message as `<text> (repeat n, no new ledger
  entries)` (only the latest repeat per node). A changed text or a higher mark
  wakes. Lines without `facts` (an older driver, non-JSON lines) wake as
  before. In the loop the driver itself marks such a line `repeat: n` (text
  suffix ` (repeat n, no new ledger entries)`) when it equals the node's last
  printed wake in text and fact mark, and a notify is printed again when its
  fact mark rose even if its text did not change. A re-halt after a writer
  resubmits, or after a ruling, wakes (the clearing entry is a new fact). If
  `sendMessage` throws, the batch is kept and retried next tick (D17a.8). It stops after a read with a terminal line, or when the pid is
  gone without one (`driver pid P ended without an exit record`; liveness is
  checked before the read, so nothing the driver wrote is missed). One
  follower per driver log (repository) per extension instance; a new start
  replaces it; `session_shutdown` clears every timer (the driver keeps
  running).
- **`/owed`** appends `Driver: running pid P since T`, `Driver: not running
  (last exit R at T)`, `Driver: not running (ended without an exit record)`,
  `Driver: not running (no driver output yet)`, `Driver: not running`, or for another host `Driver: lock held by pid P on
  host H since T`.
