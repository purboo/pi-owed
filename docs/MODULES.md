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
export class OwedError extends Error { constructor(message: string, readonly code: 'refused' | 'usage' | 'internal' = 'refused') }
```

## src/plan.ts  (leaf io)
```ts
export function parsePlan(text: string): Plan;   // YAML → Plan with defaults; throws OwedError('usage') listing every validation error
export function planDowngrades(prev: Plan, next: Plan): Downgrade[];   // SPEC §3 downgrade rules; also invariant removed/weakened
export function globMatch(path: string, glob: string): boolean;  // '**' any depth, '*' within a segment, 'dir/' prefix; use node:path matchesGlob where suitable
export function matchesAny(path: string, globs: string[]): boolean;
export const DRIVE_DEFAULTS: DriveConfig;              // {max: 4, repairs: 2, writer: {agent: 'worker'}, reviewer: {agent: 'reviewer'}}
export function driveConfig(plan: Plan): DriveConfig;  // plan.drive or the defaults (SPEC §12.2)
```
`parsePlan` parses the optional `drive:` block (SPEC §12.2): defaults filled when present, unknown keys and bad types are errors; `planDowngrades` ignores it.

## src/ledger.ts  (leaf io)
```ts
export function ledgerDir(cwd: string): Promise<string>;  // OWED_DIR env, else `${git common dir}/owed`; creates it
export class Ledger {
  static open(cwd: string): Promise<Ledger>;
  readonly dir: string;
  read(): Promise<Entry[]>;              // parses + verifies the hash chain; throws OwedError('internal') naming the first bad seq
  withLock<T>(fn: () => Promise<T>, name?: string): Promise<T>;   // mkdir lock `${dir}/${name ?? 'lock'}`; stale (dead pid, same host) is broken; waits with backoff up to 60 s
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
export function candidateFacts(cwd: string, plan: Plan, node: NodeSpec, base: string, commit: string, attempt: number): Promise<CandidateFacts>;  // SPEC §4 keys for every node obligation that exists
export function stateFacts(cwd: string, plan: Plan, commit: string): Promise<StateFacts>;
export function buildMerge(cwd: string, prior: string, cand: string, message: string): Promise<{ commit: string; tree: string } | { conflicts: string[] }>;  // merge-tree --write-tree + commit-tree, parents [prior, cand]; does not move refs
export function advanceTrunk(cwd: string, trunk: string, from: string, to: string): Promise<void>;  // CAS: if trunk is checked out in a worktree, that worktree must be clean and is fast-forwarded with `merge --ff-only`; else `update-ref refs/heads/<trunk> to from`. Throws OwedError('refused') if trunk != from
export function addWorktree(cwd: string, path: string, branch: string, base: string): Promise<void>;  // new branch at base
export function materialize(cwd: string, commit: string): Promise<{ path: string; dispose(): Promise<void> }>;  // detached temp worktree under os.tmpdir()
export function overlay(cwd: string, dir: string, fromCommit: string, globs: string[], mode: 'replace' | 'add'): Promise<void>;  // replace: make files matching globs in dir equal to fromCommit's (delete extras); add: write fromCommit's matching files over dir
```
Commit identity for `commit-tree`: env `GIT_AUTHOR_NAME/EMAIL`, `GIT_COMMITTER_*` = `owed` / `owed@localhost` unless already set.

## src/exec.ts  (leaf io)
```ts
export interface ExecContext { cwd: string; plan: Plan; ledger: Ledger; signal?: AbortSignal; onProgress?(msg: string): void }
export function runJob(ctx: ExecContext, job: AttestJob): Promise<Omit<ObsEntry, 'seq' | 'ts' | 'prev' | 'hash'>>;  // by 'executor:owed'; SPEC §7; never throws for check failures (verdict fail/error)
export function parseCounts(log: string): Counts | undefined;   // TAP, node:test, pytest, cargo, jest/vitest summary lines
```
A job of kind `writes` computes the verdict from `git diff --name-only base commit` and the node's `writes` prefixes; `note` lists violating paths.
Timeouts kill the whole process group (spawn `detached: true`, `process.kill(-pid)`). Log blobs keep at most the last 1 MiB plus a truncation marker.

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
export function nextReviewerN(state: State, node: string): number;   // 1 + reviewer launch entries in the current attempt (attempt-global n)
export function reviewerBase(state: State, node: string): number;   // reviewer launches of the attempt before the current candidate's submit
```
`reduce` fills `NodeState.runs` (per-attempt launches/sends) and `NodeState.halt` (cleared by a later non-driver, non-executor entry on the node or a ruling naming it, or a new attempt).
`validateDraft` rules (minimum): genesis only first and by owner; plan by owner/parent citing current plan sha, downgrades require owner; dispatch by parent/owner, node ready, no open slot; submit by the slot writer; rebase by parent/owner or the slot writer, `from` = slot base, `base` = current trunk ≠ slot base; obs `merging` names a node with an open candidate (and its own subject for node obs); obs/merge only by `executor:owed`; review by reviewer/owner, reviewer not a writer of the node, rank ∈ 1..2 for reviewers and 3 for owner, key equals the current candidate key of that obligation; waive/defer only by owner, waive key = current key, invariant obligations cannot be waived; abandon closes an open slot; launch/send/halt only by role parent, naming the node's open slot, strict fields; launch: role writer|reviewer, blob-hash `spec`, `rid` = runId (writer without n; reviewer always with `:<n>`, n ≥ 1), unique, `labels` = runLabels; send: `rid` of a recorded launch of the same attempt, `send` = `<rid>:<sendKind>:<seq>`, enums for sendKind/reason, blob-hash `message`; halt: non-empty reason, needs human|owner; adopt only by owner, `trunk` = ledger trunk name, `prior` = current trunk, `commit` = `state.commit` ≠ prior, non-empty note, positive integer `commits`, strict fields, plus `adoptGuard`.

## src/ops.ts, src/views.ts, src/cli.ts  (leaf surface)
`ops.ts` implements SPEC §8 using the modules above (every mutation: compute outside the lock where slow, then `withLock` → `read` → `reduce` → `validateDraft` → `append`). Merge holds a second lock `merge` for the whole merge (serial queue) and the ledger lock only for guard + `advanceTrunk` + append. `adopt` uses the same discipline: preconditions before any effect, invariant jobs under the `merge` lock, then under the ledger lock a re-check of plan, ledger trunk and refs/heads/<trunk>, the guard on the prospective observations, and one append (observations only when refused). `status` adds `drift` (git `trunkDrift`) when the trunk ref differs from the ledger trunk. `views.ts` renders `StatusView`, `ReceiptCard`, `Report` as plain text (Chinese labels, as in SPEC §9) and JSON. `cli.ts` exports `main(argv: string[], io?: CliIo): Promise<number>` (`io` = `{ask?, log, error}`: tests inject the owner's TTY answer and capture output; default is the terminal). `views.ts` exports `oneLine` (dialog/prompt escaping shared by the CLI adopt preview and the pi owner dialogs).

Dispatch worktrees: `<mainRoot>/.owed/wt/<node>-<attempt>` (main worktree root, never the toplevel of the cwd, so dispatching from inside a slot worktree does not nest), branch `owed/<node>/<attempt>`; ops adds `.owed/` to `<git common dir>/info/exclude`. Dispatch refuses writes overlapping an open slot unless `allowOverlap` (ops-level check; `reducer.overlapping(state, node)` is shared with the status view). `views.ts` also owns `renderGc`. `ops.launch` (idempotent on identical content, `{entry, created}`), `ops.send`, `ops.halt` record driver entries (SPEC §12.3). `views.ts` exports `reviewPacket(state, node, n)`, `reviewRuns`, `reviewObligations` (SPEC §12.6, pure; `n` attempt-global, local k = n - reviewerBase) and renders halts/launches in status, why and report (SPEC §12.4). `src/types.ts` holds `RunView` (SPEC §12.1) for the later `src/drive.ts`. The dispatch packet (blob) is markdown: node title/brief, writes, checks (commands), red requirement, in-scope rulings, the worktree path and the rule "commit your work; do not edit files outside writes; owed will run the checks itself".

## src/extension.ts, skills/owed/SKILL.md  (leaf surface)
Default export `(pi: ExtensionAPI) => void`, SPEC §11. Uses `import { Type } from '@earendil-works/pi-ai'` for parameters.

## Tests
`test/<module>.test.ts` with `node:test`. Git tests create temp repos under `os.tmpdir()` with `OWED_DIR` pointing into the temp dir; never touch the real repository's `.git`. Keep CPU low: no parallel heavy work; the machine is shared (run tests with `nice -n 10`).
