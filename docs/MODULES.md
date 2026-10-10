# owed module contract (parent-pinned)

Read `docs/SPEC.md` first; it is the semantic source of truth. `src/types.ts`
and `src/canon.ts` are pinned: do not change them without the parent (if you
believe a change is needed, add it under "Requests to parent" in your report and
work around it). All modules are ESM TypeScript run directly by Node 24 (type
stripping): only erasable syntax (no enums, no parameter properties, no
namespaces), relative imports with the `.ts` extension. No new runtime
dependencies besides `yaml`. Errors meant for users are `OwedError` (below).

```ts
// src/errors.ts (pinned, written by parent)
export class OwedError extends Error { constructor(message: string, readonly code: 'refused' | 'usage' | 'internal' | 'aborted' = 'refused') }  // aborted: an operation's signal aborted (D16; CLI exit 130/143)
```

## src/plan.ts  (leaf io)
```ts
export function parsePlan(text: string): Plan;   // YAML → Plan with defaults; throws OwedError('usage') listing every validation error
export function planDowngrades(prev: Plan, next: Plan): Downgrade[];   // SPEC §3 downgrade rules; also invariant removed/weakened
export function checklessWarnings(plan: Plan): string[];   // 0.6.1 H2.2: `warning: node <id> has no checks: …` per node with no checks and no evidence (init/plan output only)
export function loopWarnings(plan: Plan): string[];   // 0.8 L3.3: per check/invariant with min_tests whose run loops its command (for/while/until … do, seq N): what min_tests actually counts
export function planWarnings(plan: Plan): string[];   // checklessWarnings then loopWarnings: what owed init / owed plan (CLI, pi) print after the result
export function globMatch(path: string, glob: string): boolean;  // '**' any depth, '*' within a segment, 'dir/' prefix; use node:path matchesGlob where suitable
export function matchesAny(path: string, globs: string[]): boolean;
export const DRIVE_DEFAULTS: DriveConfig;              // {max: 4, repairs: 2, writer: {agent: 'worker'}, reviewer: {agent: 'reviewer'}}
export function driveConfig(plan: Plan, node?: string): DriveConfig;  // plan.drive or the defaults; with node: its `drive` roles applied (SPEC §12.2, K3)
```
`parsePlan` parses the optional `drive:` block (SPEC §12.2): defaults filled when present, unknown keys and bad types are errors; `planDowngrades` ignores it.
`parsePlan` parses the optional node field `drive` (0.7.0 K3, `NodeSpec.drive: NodeDrive`): `{writer?, reviewer?}` of `{agent?, model?}`, validated like the plan's roles; empty role objects and `drive: {}` are dropped. A node role with `agent` replaces the plan's role (model: the node's or none); one with only `model` keeps the plan's agent. `drive.ts` `writerLaunch`/`reviewerLaunch` use `driveConfig(state.plan, node)`; the reducer compares node specs without `type` and `drive` when deciding candidate invalidation; `views.receipt` adds `drive` (`views.driveText(plan, node)`: `Drive: writer <agent> (<model>) · reviewer <agent> (<model>)`) when the node sets it.
`parsePlan` parses the optional `exec:` block (SPEC §3.2, D20): `plan.exec` = `{env?, wrap?, parallel?, trees?}` with only non-empty `env`/`wrap` and `parallel` (integer ≥ 1) / `trees` (`fresh`|`reuse`) only when set, absent when nothing is; `planDowngrades` ignores it (like `setup`); the reducer's downgrade detection and candidate invalidation compare `execKey` only (env, wrap) and record such a change as a `'*'` item (owner only); `parallel`/`trees` changes invalidate nothing (0.9).

D19 (SPEC §3.1): `parsePlan` also parses the optional `worktrees:` block (`plan.worktrees` only when present, filled with defaults) and node `type`; `planDowngrades` ignores both.
```ts
export const WORKTREE_DEFAULTS: WorktreesConfig;       // {root: '.owed/wt', branch: 'owed/{node}/{attempt}'}
export const DEFAULT_NODE_TYPE = 'feat';
export function worktreesConfig(plan: Plan): WorktreesConfig;   // plan.worktrees or the defaults
export function branchTemplateErrors(template: string, label: string): string[];   // needs {node} and {attempt}; only {type} besides
export function branchAmbiguityErrors(template: string, label: string): string[]; // G4: {node} once; {attempt}/{type} separated from it (sufficient injectivity rule)
export function worktreesErrors(cfg: WorktreesConfig): string[];   // G4: control characters in root/branch + ambiguity; checked by ops when a plan is recorded, not on replay
export function nodeIdCaseErrors(plan: Pick<Plan, 'nodes'>): string[];   // node ids equal ignoring case; checked by ops when a plan is recorded, not on replay
export function expandBranch(template: string, spec: Pick<NodeSpec, 'id' | 'type'>, attempt: number): string;
```
`parsePlan` also parses the D23 node fields `approve` (only `owner`) and `evidence` ([{id, what, by}], `by` default reviewer), set only when present; `manualDowngrades(node, prev, next)` (`approve removed`, `evidence <id> removed|weakened`) is shared by `planDowngrades` and the reducer's detection; `EVIDENCE_ID` is the id pattern.
`parsePlan` also parses the optional `allow:` block (SPEC §3.4, D21; `nodes` default `["*"]`, a rule needs a permission); `planDowngrades` adds `{node: 'trunk', what: 'allow changed'}` when `allow` changes other than by deleting whole rules (`allowWidened(prev, next)`).

## src/ledger.ts  (leaf io)
```ts
export function ledgerDir(cwd: string): Promise<string>;  // OWED_DIR env, else `${git common dir}/owed`; creates it
export class Ledger {
  static open(cwd: string): Promise<Ledger>;
  readonly dir: string;
  read(): Promise<Entry[]>;              // parses + verifies the hash chain; throws OwedError('internal') naming the first bad seq
  withLock<T>(fn: () => Promise<T>, name?: string, signal?: AbortSignal, opts?: LockOptions): Promise<T>;   // mkdir lock `${dir}/${name ?? 'lock'}`; stale (dead pid, same host) is broken; waits with backoff up to 60 s, then OwedError code 'busy' (lockTimeoutText: `timed out waiting for the <name> lock held by …; retry`, the ledger lock is `the ledger lock`); opts.busy(owner) (K1): a live owner on this host fails at once with code 'busy' and that message, as does the timeout; an abort before acquisition rejects at once with OwedError('aborted') and takes nothing (no staged dir); after acquisition fn is not interrupted
  append(drafts: Draft[]): Promise<Entry[]>;  // MUST run inside withLock(); re-reads tail, assigns seq/ts/prev/hash, appends + fsync
  putBlob(data: string | Uint8Array): Promise<string>;  // sha256, write-once into blobs/
  getBlob(sha: string): Promise<Buffer>;
}
export function entryHash(e: Omit<Entry, 'hash'>): string;   // H(entry without hash)
export function verifyChain(entries: Entry[]): { ok: true } | { ok: false; seq: number; error: string };
```

## src/git.ts  (leaf io)
```ts
export function git(cwd: string, args: string[], opts?: { input?: string; allowFail?: boolean; env?: Record<string,string> }): Promise<{ code: number; stdout: string; stderr: string }>;  // throws OwedError('internal') on failure unless allowFail
export function repoRoot(cwd: string): Promise<string>;     // top level of the worktree containing cwd (`--show-toplevel`); only for "is cwd this slot worktree"
export function commonDir(cwd: string): Promise<string>;    // absolute git common dir (shared by all worktrees)
export function mainRoot(cwd: string): Promise<string>;     // main worktree root (SPEC §8, ruling #122): --show-toplevel in the main worktree; in a linked worktree dirname(commonDir) only if verified, else OwedError('usage') 'run owed from the main worktree'; every repository path (dispatch worktrees, gc, info/exclude) derives from it
export function readAt(cwd: string, rev: string, path: string): Promise<{ commit: string; path: string; text: string }>;  // file at a commit; path relative to cwd, returned repository-relative; OwedError('usage') if outside the repo, not a commit, or missing
export function revParse(cwd: string, rev: string): Promise<string>;   // full 40-hex OID of a commit (`^{commit}`)
export function isAncestor(cwd: string, a: string, b: string): Promise<boolean>;
export function isClean(worktree: string): Promise<boolean>;            // no staged/unstaged/untracked (respecting ignores)
export function countCommits(cwd: string, from: string, to: string): Promise<number>;     // rev-list --count from..to
export function changedPaths(cwd: string, from: string, to: string): Promise<string[]>;   // diff --no-renames --name-only
export function trunkDrift(cwd: string, trunk: string, ledger: string): Promise<TrunkDrift | undefined>;  // undefined when refs/heads/<trunk> = ledger; else {ref, commit|null, ledger, relation: ahead|diverged|missing|ledger-missing, ahead, behind} (status, merge CAS message)
export function readsDigest(cwd: string, commit: string, globs: string[]): Promise<string>;
export function execKey(plan: Plan): { env?: Record<string,string>; wrap?: string[] } | undefined;  // `exec` field of check/red/strength/inv keys (SPEC §4.1); undefined (dropped) without a non-empty env/wrap
export function candidateFacts(cwd: string, plan: Plan, node: NodeSpec, base: string, commit: string, attempt: number): Promise<CandidateFacts>;  // SPEC §4 keys for every node obligation that exists
export function stateFacts(cwd: string, plan: Plan, commit: string): Promise<StateFacts>;
export function buildMerge(cwd: string, prior: string, cand: string, message: string): Promise<{ commit: string; tree: string } | { conflicts: string[] }>;  // merge-tree --write-tree + commit-tree, parents [prior, cand]; does not move refs
export function advanceTrunk(cwd: string, trunk: string, from: string, to: string): Promise<void>;  // CAS: if trunk is checked out in a worktree, that worktree must be clean and is fast-forwarded with `merge --ff-only`; else `update-ref refs/heads/<trunk> to from`. Throws OwedError('refused') if trunk != from
export function addWorktree(cwd: string, path: string, branch: string, base: string): Promise<void>;  // new branch at base
export function materialize(cwd: string, commit: string, reuse?: ReuseSpec): Promise<{ path: string; dispose(): Promise<void> }>;  // detached temp worktree under os.tmpdir(); with reuse {kind, id, note?} (exec.trees: reuse, SPEC §7.12) the leased stable tree <common dir>/owed/trees/<kind>-<treeId(id)>-<k> (checkout --detach --force, clean -ffdx, gitlink (160000) dirs emptied in the tree, no git submodule command; recreated when missing/broken; fresh fallback with note); dispose releases the lease and keeps it
export function reuseDir(cwd: string): Promise<string>;   // <git common dir>/owed/trees
export function treeId(id: string): string;               // path-safe check id: itself, or 'h' + 16 hex of sha256
export function takeLease(lock: string): Promise<boolean>; releaseLease(lock: string): Promise<void>; leaseFree(lock: string): Promise<boolean>;  // pid lock files taken by link() from a pid-filled temp file (never empty); dead content (dead pid; empty/unparsable > 60 s) reclaimed under the O_EXCL token <lock>.dead-<X>; a take removes that lock's .tmp-* older than 60 s and a met token older than 1 h
export function staleTokens(cwd: string, dryRun: boolean): Promise<string[]>;  // gc: reclaim tokens older than 1 h and lock .tmp-* files older than 60 s (removed unless dryRun)
export function reusedTrees(cwd: string): Promise<{ name, path, lock, kind, id, k, free }[]>;  // the reuse trees on disk (gc)
export function removeReusedTree(cwd: string, path: string): Promise<boolean>;  // under its lease; false when a live process holds it
export function overlay(cwd: string, dir: string, fromCommit: string, globs: string[], mode: 'replace' | 'add'): Promise<void>;  // replace: make files matching globs in dir equal to fromCommit's (delete extras); add: write fromCommit's matching files over dir
```
Commit identity for `commit-tree`: env `GIT_AUTHOR_NAME/EMAIL`, `GIT_COMMITTER_*` = `owed` / `owed@localhost` unless already set.

## src/exec.ts  (leaf io)
```ts
export interface ExecContext { cwd: string; plan: Plan; ledger: Ledger; signal?: AbortSignal; onProgress?(msg: string): void }
export function runJob(ctx: ExecContext, job: AttestJob): Promise<Omit<ObsEntry, 'seq' | 'ts' | 'prev' | 'hash'>>;  // by 'executor:owed'; SPEC §7; never throws for check failures (verdict fail/error)
export function parseCounts(log: string): Counts | undefined;   // TAP, node:test, pytest, cargo, jest/vitest summary lines; cargo + TAP in one log → format 'mixed' (sum)
export function lastLines(log: string, n?: number): string[];   // last n (default 5) non-empty lines, ANSI removed, each ≤ 200 chars
```
A job of kind `writes` computes the verdict from `git diff --name-only base commit` and the node's `writes` prefixes; `note` lists violating paths.
Timeouts kill the whole process group (spawn `detached: true`, `process.kill(-pid)`). Log blobs keep at most the last 1 MiB plus a truncation marker.
Every process (setup, check, red, strength, invariant, attribution reruns) runs as `[...plan.exec.wrap, 'bash', '-lc', cmd]` with env `{...process.env (without NODE_TEST_CONTEXT and every DSA_* variable except DSA_HOME), ...plan.exec.env, CI: '1', OWED: '1'}` (SPEC §7.9); the wrapper is killed with the process group.
`min_tests` applies to every non-red run (check and invariant), never to a red run. A non-red run that exits non-zero with an unknown or zero count is `fail` with the last 5 output lines in the note; exit 126/127 with no count is `error` (`command could not run …`, same tail) (SPEC §7.2). cargo `test result:` lines count only at column 0. A red run whose command exits 126/127 or cannot be spawned is `error` (SPEC §6.2).

## src/reducer.ts  (leaf core, pure: no fs/git/clock)
```ts
export type PlanLookup = (sha: string) => Plan;
export function reduce(entries: Entry[], plans: PlanLookup): State;
export function validateDraft(state: State, draft: Draft): string[];   // authority/precondition errors (empty = ok), SPEC §5/§6; ops calls it under the lock before append
export function attestJobs(state: State, node: string): AttestJob[];   // attribution reruns first, then ⊥ items of the current candidate (check, red, writes)
export function genesisJobs(state: State): AttestJob[];                // invariants on s0 with no non-error obs
export function mergeJobs(state: State, node: string, m: { facts: CandidateFacts; state: StateFacts }): AttestJob[];  // check:* on M and invariants on M whose keys lack a verdict
export function mergeGuard(state: State, node: string, m: { facts: CandidateFacts; state: StateFacts }): MergeGuard;  // SPEC §6.4 conditions 2–4 (CAS is checked by ops)
export function adoptJobs(state: State, st: StateFacts): AttestJob[];   // invariants whose key on the adopted state differs from the trunk key and lacks a verdict
export function genesisProgress(state: State): { ids; observed; failed; pending };   // D24: genesis items (current-plan invariants with a genesis key) by observation
export function jobCurrent(state: State, job: AttestJob): boolean;   // D24.1: an observation of job is still about a current item (else superseded); an attribution rerun only for an active block (not a superseded one, L2)
export function checkDefinition(plan: Plan, node: string, id: string): string | undefined;   // L2: canonical {CheckSpec, setup, execKey}; undefined when the check is absent
export function checkOf(obligation: string): string | undefined;   // L2: the check id of check:/red:/strength:<id>
export function adoptGuard(state: State, st: StateFacts): AdoptGuard;   // SPEC §6.6 no new debt: {ok, reasons, failed: invariant ids satisfied on trunk but not on st, invItems}; validateDraft applies it to `adopt`
```
Driver (SPEC §12.3), pure:
```ts
export const DRIVER = 'parent:drive';
export function projectId(state: State): string;                 // first 12 hex of the genesis entry hash
export function runId(project: string, node: string, attempt: number, role: RunRole, n?: number): string;  // owed:<project>:<node>:<attempt>:<role>[:<n>]
export function runLabels(project: string, node: string, attempt: number, role: RunRole): Record<string, string>;  // {owed, node, attempt, role}
export function driveReviewer(node: string, attempt: number, n: number): string;  // reviewer:drive-<node>-<attempt>-<n>
export function halted(state: State, node: string): HaltEntry | undefined;        // active halt of the open attempt
export function resumeOf(state: State, node: string): ResumeEntry | undefined;    // 0.8 L1: latest resume of the open attempt
export function waitingFor(state: State, node: string): { after: string; resume: number } | undefined; // 0.8 L1: the open attempt waits for `after` to merge
export function nextReviewerN(state: State, node: string): number;   // 1 + reviewer launch entries in the current attempt (attempt-global n)
export function reviewerBase(state: State, node: string): number;   // reviewer launches of the attempt before the current candidate's submit
```
D23 (SPEC §6.2 items 8–9): `manualKeys(spec, patch)` = the `approve`/`evidence:<id>` keys (ops.submit adds them to the facts; validateDraft checks them); `isManual(obligation)`; `evidence` entries are validated (strict fields; candidate evidence vs receipt on a merged node) and read by `item()`; an owner ok on `approve` clears any owner block on it.
`reduce` fills `NodeState.runs` (per-attempt launches/sends) and `NodeState.halt` (cleared by a later non-driver, non-executor entry on the node or a ruling naming it, or a new attempt).
Allowances (SPEC §3.4, D21), pure:
```ts
export function uncoveredDowngrades(prev: Plan, next: Plan, claimed?: Downgrade[]): Downgrade[];  // detected + claimed downgrades no rule of prev covers, each once (a claimed item whose detected wording is listed is left out); [] = a parent may record the update
export function writesHint(prev: Plan, next: Plan, gaps: Downgrade[]): string | undefined;  // 0.6.1 H2.1: `hint: an allow rule {nodes: […], writes: […]} in the prior plan would cover this` when every gap widens writes
export function adoptPrefixes(plan: Plan): string[];                    // `adopt` prefixes of every rule
export function unadoptable(plan: Plan, changed: readonly string[]): string | undefined;  // first path outside them
export function writesAllowed(plan: Plan, node: string, paths: readonly string[]): boolean;  // a matching rule's writes prefixes cover every path
export function allowanceSeq(state: State): number | undefined;        // seq of the genesis/plan entry that last changed `allow`
```
`reduce` sets `allowance: S` on `state.downgrades[]` of a parent plan entry and on `state.adoptions[]` of a parent adoption. A parent `plan` entry with downgrades is valid iff `uncoveredDowngrades` is empty.
`validateDraft` rules (minimum): genesis only first and by owner; plan by owner/parent citing current plan sha, downgrades require owner; dispatch by parent/owner, node ready, no open slot; submit by the slot writer; rebase by parent/owner or the slot writer, `from` = slot base, `base` = current trunk ≠ slot base; obs `merging` names a node with an open candidate (and its own subject for node obs); obs/merge only by `executor:owed`; review by reviewer/owner, reviewer not a writer of the node, rank ∈ 1..2 for reviewers and 3 for owner, key equals the current candidate key of that obligation; waive/defer only by owner, waive key = current key, invariant obligations cannot be waived; abandon closes an open slot; launch/send/halt only by role parent, naming the node's open slot, strict fields; launch: role writer|reviewer, blob-hash `spec`, `rid` = runId (writer without n; reviewer always with `:<n>`, n ≥ 1), unique, `labels` = runLabels; send: `rid` of a recorded launch of the same attempt, `send` = `<rid>:<sendKind>:<seq>`, enums for sendKind/reason, blob-hash `message`; halt: non-empty reason, needs human|owner; resume (0.8 L1) by parent/owner (not `parent:drive`), naming the node's open slot, `after` another plan node, `note` a string, strict fields; adopt by owner (or by a parent when every changed path lies under an `adopt` prefix of the current plan, D21.4), `trunk` = ledger trunk name, `prior` = current trunk, `commit` = `state.commit` ≠ prior, non-empty note, positive integer `commits`, strict fields, plus `adoptGuard`.

## src/ops.ts, src/views.ts, src/cli.ts  (leaf surface)
`ops.ts` implements SPEC §8 using the modules above (every mutation: compute outside the lock where slow, then `withLock` → `read` → `reduce` → `validateDraft` → `append`). Merge holds a second lock `merge` for the whole merge (serial queue) and the ledger lock only for the node-scoped CAS (`nodeStable`: ledger trunk, the node's slot and candidate; then `trunkDrift`), guard + `advanceTrunk` + append (0.7, SPEC §6.4: when the plan changed, the merge facts are recomputed under the latest plan, `mergeCurrent` keeps the measured observations whose job is still current, and `unmeasured` refuses jobs the run did not measure). `adopt` uses the same discipline: preconditions before any effect, invariant jobs under the `merge` lock, then under the ledger lock a re-check of plan, ledger trunk and refs/heads/<trunk>, the guard on the prospective observations, and one append (observations only when refused). `status` adds `drift` (git `trunkDrift`) when the trunk ref differs from the ledger trunk. `views.ts` renders `StatusView`, `ReceiptCard`, `Report` as plain text (Chinese labels, as in SPEC §9) and JSON. `cli.ts` exports `main(argv: string[], io?: CliIo): Promise<number>` (`io` = `{ask?, log, error}`: tests inject the owner's TTY answer and capture output; default is the terminal). `views.ts` exports `oneLine` (dialog/prompt escaping shared by the CLI adopt preview and the pi owner dialogs). 0.9 (SPEC §7.12): `ops.measureAll(jobs, width, signal, run, settled?)` runs up to `exec.parallel` (`parallelOf(plan)`) jobs at once and returns observations by job index (undefined = not measured) plus `aborted`; merge and adopt use it for their genesis/invariant + merge-result jobs (abortWith keeps the completed ones), and `runJobs(…, parallel)` for the genesis attest (init, attestGenesis) records in job order; node attest passes 1. `gc` ignores reuse trees as slots and removes stale ones (`GcResult.trees`, `treesKept`). `views.ts` also exports `execText(plan)` (D20.5): the `Exec: wrap <argv> · env <NAMES> · parallel <n> · trees <mode>` line that `receipt` puts in `ReceiptCard.exec` and `renderReceipt` prints after the node header when the plan has `exec`.

Dispatch worktrees: `<mainRoot>/.owed/wt/<node>-<attempt>` (main worktree root, never the toplevel of the cwd, so dispatching from inside a slot worktree does not nest), branch `owed/<node>/<attempt>`; ops adds `.owed/` to `<git common dir>/info/exclude`. Dispatch refuses writes overlapping an open slot unless `allowOverlap` (ops-level check; `reducer.overlapping(state, node)` is shared with the status view). `views.ts` also owns `renderGc`. `ops.launch` (idempotent on identical content, `{entry, created}`; `rulings` is recorded on a new entry only), `ops.send`, `ops.halt` record driver entries (SPEC §12.3); `ops.resume({node, after?, note?})` (0.8 L1) records a parent/owner `resume` and returns `{entry, merged?}` (`merged`: `after` was already merged); `views.ts` renders `waiting` in status/why and the resume hint (`resumeHint`, `resumeCommands`, `waitingLine`); launch entries and repair sends carry `rulings` (E4: the highest in-scope ruling seq the message carried, 0 when none; `drive.ts` `repairFollowUp` returns the repair message with it; G3.2 `resubmitBlocks(state, node)` / `resubmitFollowUp(state, node)` give the one repair that replaces row 8's submit/rebase follow-up while a repairable block is active). `ops.approve`/`approvePreview`/`evidence`/`evidencePreview`/`evidenceFiles` (D23; `CandidatePin` {seq, commit} pins the confirmed candidate); 0.6.0 G1: `candidateArg` validates `--candidate`, review/waive/approve/evidence take `named` (checked under the lock by the private `named()`), review/waive take `pin`, `candidatePreview` feeds the waive and owner-review dialogs; G2.1: the private `writerTree()` is the writer-worktree rail of review/evidence; `DRIVER_CLAIM` is the refusal of a claimed `parent:drive` (CLI and pi tools); `views.ts` adds `--candidate <commit12>` to ownerCommands, brief decisions, clear hints and review packets; `views.ts` renders manual items (`approved (…)`, `evidenced (manual) by …`), receipts (`receiptText`, `ReceiptCard.receipts`, `Report.receipts`) and exports `evidenceCommand`; `drive.ts` exports `manualHalt(state, node)` (the D23 halt). `views.ts` exports `reviewPacket(state, node, n)`, `reviewRuns`, `reviewObligations` (SPEC §12.6, pure; `n` attempt-global, local k = n - reviewerBase) and renders halts/launches in status, why and report (SPEC §12.4). `src/types.ts` holds `RunView` (SPEC §12.1) for the later `src/drive.ts`. The dispatch packet (blob) is markdown: node title/brief, writes, checks (commands), red requirement, in-scope rulings, the worktree path and the rule "commit your work; do not edit files outside writes; owed will run the checks itself".

D19 (SPEC §8.1, §9.1): `ops.dispatch` takes the branch and worktree from a private `slotLayout(mainRoot, plan, spec, attempt)` (template expansion, `git check-ref-format --branch`, physical root resolution, the exclude line escaped with the exported `ignoreLiteral` or none for a root outside the main worktree), all before any effect; the recorded worktree is the physical path, so writer inference against git's toplevel matches. `git.advanceTrunk` refuses a dirty trunk worktree with `git.trunkDirtyText(path)`; `git.trunkElsewhere(cwd, trunk)` returns the path of a worktree other than the main one that has the trunk checked out, which `ops.status` exposes as `StatusView.trunkWorktree` and `renderStatus` prints with `views.trunkWorktreeText`. The reducer ignores node `type` when deciding whether a plan change invalidates a candidate.

D24 (SPEC §7.10, §8.2): `runJobs` (attest, genesis attest) appends an observation iff `jobCurrent` holds on the latest state and lists the rest as superseded; `init` (`measure?`, `commit?`), `initPreview`, `attestGenesis` (under its own `genesis` lock, never a node's attest lock; busy at once while a live process holds it; registers itself as measuring in this process synchronously when called, until it ends), `genesisPending`/`genesisReport`, `genesisIncompleteText`. `statusView` adds `genesis` while items are pending; `genesisLine` renders it.

## src/dsa.ts, src/drive.ts, src/drive-run.ts  (driver, SPEC §12)
```ts
// src/dsa.ts: the pi-durable-subagents CLI client (argv, --json, exit codes 0/1/3/4/75)
class Dsa { killAll(sig?); run(rid, specBytes, labels?, cwd?); send(id, to, kind, message); describe(rid): RunView; inspect(rid): {view, gen?};
  request(id): {state: applied|rejected|pending|absent, reason?}; events(since?, limit?); hold(resource, argv, {shared?, cwd?}) /* --no-wait: ran|busy|refused|signal */ }
// src/drive.ts: decide(state, plan, runs, opts): Action[] (pure); opts.measuring (0.7 K6): nodes with a measurement in flight get no action;
//   opts.rejected: send/run ids dsa rejected (the attempt's sends from dsa's request state every pass): writer follow-ups leave them out of deliveredRulings (#784 F1)
// src/drive.ts also (D22): runName(node, attempt, role, n?) (dsa run name in launch specs); deliveredRulings(state, node, attemptRuns, launch, refused?) / rulingMessage(node, role, rules) (ruling steers, SPEC §12.5.1); askingText(node, launch, view) (asking line with dsa's answer address); 0.7 K5: repairEpoch(state, node) ({seq, label}: the repair budget epoch), rulingFollowUp(state, node) (the `ruling` follow-up to a sealed writer, or undefined), thresholdHint(state, node, obligations) (the halt text when the latest two failing runs of a check passed the same count of tests, below min_tests); 0.8 L1: the epoch includes the latest resume (`resume #<seq>`); a waiting node gets only asking notifies; resumeLine(state, node, rid) (the first line of the first writer follow-up after a resume); toArg(to) / callAt(view) (the `to:"<wid>/<key>"` call address of asking notices and halts; `RunView.to` comes from `dsa.toRunView`)
// src/drive.ts also (0.8 L3.1): a due ruling follow-up (rulingFollowUp, which also lists the node's flaky blocks) precedes the owner-needed notify, row 7 and the stalled halt; at the stalled point a candidate owing only `rulings` sends it to its latest sealed driver reviewer (reviewerRuling) or launches one
// views.ts flakyRuleHint(node) (0.8 L3.2): the `or owed rule …` hint after a flaky block's waiver (clearHint, decisionCommand, ownerCommands once, status pending items)
// src/drive.ts also: rejectedFixed(node) / rejectedHalt(node, 'run'|'send', id, reason) (halt text of a dsa rejection, D15.1); blockText(state, candidate, block) (a block in a `stalled:` halt, D15.3)
// src/drive-run.ts
export function drive(o: DriveOptions): Promise<number>;   // lock, then one pass (once) or the loop; OwedError('refused') when another driver runs
export class Driver { pass(): Promise<PassResult>; settle(); reap(); tick(); measuring: Map<node, Measurement> }   // one pass: handle ended measurements, observe, decide, execute; attest/merge start in the background (K6)
export function driveOnce(o): Promise<{ lines: string[]; error?: string }>;   // the pi tool's pass: lines of executed actions, also on a throw
export function acquireDriveLock(dir: string): Promise<{ release(); releaseSync() }>;   // other-host locks are never taken over
export function liveRunLines(cwd: string, dsa?: Dsa): Promise<string[]>;   // `/owed` dsa states of live runs
export function reportText(json: object): string;   // text-mode line of an ActionReport or a LoopEvent (SPEC §12.8)
export function procStart(pid); lockAlive(owner: LockOwner); defaultOwed(): string[];   // shared with drive-bg.ts
export function factMark(s: State, node: string): number;   // E3.1: highest seq of non-driver entries naming the node
export function wakeReport(r): boolean; repeatText(n): string; NEEDS_OWNER; driftNotice(name, drift): string; DRIFT_NODE;   // wake lines, D25.6 wording
export function rebaseConflicts(cwd, base, commit): Promise<string[] | undefined>;   // G3.7: merge-tree conflicted paths ([] clean); passed as DriveOpts.conflicts when drive.ts wantsRebaseConflicts(state, node, runs)
export function reportKey(r: {node, scope?}): string; DRIFT_KEY;   // G3.4b: print/wake record key; `scope: 'repo'` (drift) never shares a plan node's
export function stateOf(cwd): Promise<State>; dispatchable(cwd): Promise<string[]>; ledgerHead(dir): string /* last entry hash */; IDLE_WAIT_TEXT; PassResult.head;   // H1 (SPEC §12.9): revalidation, ready hint, --stay
```
`drive()` in `--json` loop mode ends with the exit record `{event:'exit', code, reason, at, error?}` and returns the CLI code instead of throwing (SPEC §12.8).
Pi session (0.5.1 E1, SPEC §12.7): `dsa.ts` exports `startingSession(env?)` (`DSA_SESSION`, ignored under `DSA_CALL`/`DSA_EXEC`); `Dsa.session` is passed as `run --session` (dsa children never inherit `DSA_SESSION`), and a dsa that refuses the flag sets `sessionRefused`, calls `onSessionRefused(reason)` once and re-runs without it. `DriveOptions.session` (default `startingSession()`, null: none) is recorded by `acquireDriveLock(dir, session?)` as `LockOwner.session`; the fallback line is the loop event `session-unsupported`. `drive-bg.ts`: `driveStart` sets/removes `DSA_SESSION` for the detached driver (`DriveStart.session`), `DriveStatus.session`, `sessionText(session)` for `--status` and `driverLine`.

## src/drive-bg.ts  (background driver and wake-ups, SPEC §12.8)
```ts
export function driveStart(o: { cwd; max?; stay?; owed?; waitMs? }): Promise<DriveStart>;   // --detach: detached `owed drive --json`, log rotated, waits for the lock
export function driveStatus(o: { cwd }): Promise<DriveStatus>;   // --status: lock + log (reads only)
export function driveStop(o: { cwd; now?; waitMs? }): Promise<DriveStop>;   // --stop: SIGTERM only when pid + start time match
export function renderDriveStart / renderDriveStatus / renderDriveStop; driverLine(cwd): Promise<string>;   // texts; `/owed` Driver line
export function readLock(dir): LockState; driveDir(cwd); lockPath(dir); logPath(dir); classifyLine(line); logLineText(line);
export function measuringOf(lines): InFlight[]; inFlightText(m);   // K6: in-flight measurements from the log (DriveStatus.measuring, `/owed`)
export class Follower { tick(): string | undefined; step(): Promise<string | undefined>; start(); stop() }   // one driver log → wake messages; per node dedupe on text + fact mark (E3.1); step: pi hooks busy/revalidate (H1.1)
export class DriveWatch { follow(o); attach(cwd); flush(); stopAll() }          // the extension's followers (one per log); hooks {busy, revalidate(repo)}
export function revalidator(o: { cwd; dsa? }): Revalidate; resolvedText(n); idleText(at);   // H1.1b: fact mark / describe checks; texts
export function readyHint(cwd): Promise<string[] | undefined>; readyHintText(ready, 'cli' | 'pi');   // H1.3
```
`driveDir` resolves the ledger directory like `ledgerDir` but creates nothing (session_start runs in any repository).
`drive-run.ts` writes every verdict (dsa rejection/conflict, merge refusal, attest error) to the ledger in the pass it happens (contract D14) and uses `ops` for every ledger write (dispatch, launch, send, halt, rebase, merge as `parent:drive`) and runs attest as a subprocess under `hold machine --shared --no-wait`. Measurements (0.7 K6, SPEC §12.7): an attest (child) or a merge (in-process `ops.merge`) starts in the background, at most `measureCap(plan)` (`drive.measure`, default 2; plan.ts) and one merge at a time; a pass first handles the ended ones (`reap`); a busy attest (lease refused, or K1's exit 75) is printed when it ends, is not progress, does not wake the loop and waits for the next timed or event pass (`tick`); no drift check while this driver's merge is in flight; stop waits (`settle`), stop at once aborts and drains (5 s, SIGKILL, 1 s); K4 refusals: `not measured` retries, a changed slot or an invalidated candidate is `superseded`, no halt. A dsa rejection halts with the abandon recovery (the attempt's request is fixed, D15.1); the transient merge refusal `Plan, candidate or trunk changed; retry` is retried next pass (D15.2). Test hook: `OWED_DRIVE_TEST_KILL=<before-dsa|after-dsa>:<launch|send>` SIGKILLs the driver at that point. 0.8 L1: each pass logs the quiet loop event `waiting` per waiting node (`waitingText`, `PassResult.waiting`; once per node and resume in the loop); `drive-bg.ts` adds `haltHintText` to a wake message that holds a halt line.

## src/extension.ts, skills/owed/SKILL.md  (leaf surface)
Default export `(pi: ExtensionAPI) => void`, SPEC §11. Uses `import { Type } from '@earendil-works/pi-ai'` for parameters. Registers `session_start` (follow a live background driver), `agent_start`/`agent_settled` (hold wakes while the agent runs; flush at settle, H1.1) and `session_shutdown` (clear the followers) when `pi.on` exists; wake-ups use `pi.sendMessage` (SPEC §12.8).
D25 (SPEC §2.1, §11): `actor(ctx, dir, as, summary, fields, signal)` refuses owner/parent in a dsa call (`ops.subagentRefusal`), returns `channel: 'delegated'` for an owner unless `ops.confirmGate()` (`OWED_CONFIRM=owner`), and otherwise shows the dialog with `confirmTimeout()` (`OWED_CONFIRM_TIMEOUT`, default `CONFIRM_TIMEOUT_S` = 120) and the tool's abort signal; `confirmTimeoutText(seconds)`. The CLI applies the same rules (`delegated` without a prompt unless the gate). `ops.subagentCall/subagentRefusal/confirmGate`; `planSet` takes `note`; the reducer requires a note on a delegated owner downgrade; `views.briefView` adds `delegated` (`BriefDelegated`), entry lines mark `(delegated)`, `views.ownerCommands(state, node)` lists the commands the driver's owner notifications and halts append.

## Tests
`test/<module>.test.ts` with `node:test`. Git tests create temp repos under `os.tmpdir()` with `OWED_DIR` pointing into the temp dir; never touch the real repository's `.git`. Keep CPU low: no parallel heavy work; the machine is shared (run tests with `nice -n 10`).

K1 (0.7, SPEC §7.11): `ops.attest` holds the node's lock `attestLock(node)` = `attest-<first 16 hex of sha256(node)>` (attests of different nodes run in parallel) with `opts.busy` = `attestBusyText(node, owner)`; `OwedError` code `busy` (errors.ts) is CLI exit 75 (`Busy: …`) and a pi tool error `Busy: …`; with `--json` every CLI failure also prints `{"error", "code"}` on stdout. `views.dispatchPacket(spec, attempt, worktree, rules, driver = true)`: `driver` appends `DRIVER_ATTESTS` (drive.ts writerTask uses the default; ops.dispatch passes `by === 'parent:drive'`); exec-block clear hints carry `SKIP_ATTEST`. `ledger.lockWait.ms` is a test hook (default 60 000).

L2 (0.8, SPEC §6.3, §9): replaying a `plan` entry marks `superseded` (with `supersededBy` = its seq) every active or flaky exec block on `check:`/`red:`/`strength:<id>` whose `checkDefinition` differs between `obsPlans.get(block.seq)` and the new plan (absent counts as different). The reducer's `active()` and every view filter treat only `active` and `flaky` as counting; `drive.ts` `manualHalt` too. Supersede never invalidates a later entry: `History.shadow` keeps a superseded block's underlying state (as without supersede), moved by later attribution obs and waivers; validateDraft's attribution and accept_risk checks read it (`underlying`/`underlyingActive`), the block itself stays superseded. `views.ts` exports `supersededText(state, block)`, `supersededOf(state, nodes)` and the `SupersededBlock` type; `ReceiptCard.superseded`, `StatusView.superseded` (nodes not merged) and `Report.superseded` (plan entries after `since`; built in `ops.report`) carry them.

N1 (0.10, SPEC §3 Carry, §5, §12.5): `reducer.invalidates(prev, next, id)` is the candidate-invalidation predicate of a plan entry (node spec without `type`/`drive`, `setup`, `execKey`, `closure`); `carryable(prev, next, id)` holds when the node spec differs only in `CARRY_FIELDS` (`checks`, `writes`, `type`, `drive`); `specChanges(prev, next, id)` lists the changed fields (not `type`/`drive`) plus `setup`/`exec`/`closure`. `validateDraft` accepts a `submit` by `executor:owed` only as a carry (`carryErrors`: `carry` = the latest submit of the open attempt, same commit and base, no current candidate, slot base unchanged) and refuses `carry` on any other submit. Replaying a carry submit sets `NodeState.candidate.carried = {plan, submit}` (plan = the latest plan entry before it). `ops.planSet` appends the plan draft plus the carry submits (`withCarries`: facts by `git.candidateFacts` under the new plan plus `manualKeys`, each validated on the projected state; a failing one is left out) in one `append` under the lock; `ops.carriedBy({cwd, plan})` returns the carry submits right after a plan entry, which the CLI and `owed_plan` print with `views.carryLine` (JSON `carried`). `views` adds `ReceiptCard.carried`, `StatusView.carried` and `carriedText` (`candidate #C carried by plan #P from submit #S`), and `entryLine` names a carry submit. `drive.ts` row 8: the `rebase` follow-up only when no submit of the attempt follows the rebase; else `planInvalidated(s, node, after)` finds the plan entry that invalidated the latest submit and the `submit` follow-up uses `planChangedMessage(node, plan, fields)`. Tests: `test/carry.test.ts`.
