// Pinned shared types for owed (see docs/SPEC.md). Changing this file requires the parent.

export type Role = 'owner' | 'parent' | 'writer' | 'reviewer' | 'executor';
export interface Principal { role: Role; id: string }
/** How an owner act was authorized: a TTY prompt, a pi dialog, `--i-am-owner` (flag), or delegated to the main agent (D25: no human step). */
export type Channel = 'tty' | 'pi-confirm' | 'flag' | 'delegated';

// ---------- plan ----------
export interface CheckSpec {
  id: string;
  run: string;
  timeout_s: number;          // default 600
  reads: string[];            // default ["**"]
  min_tests?: number;
  red?: boolean;
  tests?: string[];           // required when red
  red_expect?: string;
  mutants?: string[];         // globs of mutant patch files inside the plan closure (read from the base)
  min_kill?: number;          // fraction of mutants that must be killed, in (0,1]; default 1
}
export interface NodeSpec {
  id: string;
  title?: string;
  deps: string[];
  writes: string[];
  checks: CheckSpec[];
  review: { count: number; min_rank: number };   // default {count:0,min_rank:1}
  brief?: string;
  /** D19: fills `{type}` of the worktree branch template only (default `feat`); never an obligation. */
  type?: string;
  /** D23: obligation `approve`, discharged only by an owner `review` ok on obligation `approve`. Absent = no approval needed. */
  approve?: 'owner';
  /** D23: manual evidence obligations `evidence:<id>`, discharged by an `evidence` entry. Absent = none. */
  evidence?: EvidenceSpec[];
  /** K3: per-node driver agents/models; never an obligation, read by later launches only. Absent = the plan's `drive`. */
  drive?: NodeDrive;
}
/** K3: a node's `drive` override of one role: at least one of `agent` / `model` (an empty object is dropped by the parser). */
export interface NodeDriveAgent { agent?: string; model?: string }
/** K3: optional node field `drive`; only roles that set something are present (`drive: {}` is dropped by the parser). */
export interface NodeDrive { writer?: NodeDriveAgent; reviewer?: NodeDriveAgent }
/** D19: optional `worktrees:` block of the plan; never an obligation, read by later dispatches only. */
export interface WorktreesConfig { root: string /* absolute, or relative to the main worktree root */; branch: string /* template with {node}, {attempt}, optional {type} */ }
/** D23: one manual evidence obligation of a node; `by` (default reviewer) is the role that may record it (the owner always may). */
export interface EvidenceSpec { id: string; what: string; by: 'reviewer' | 'parent' | 'owner' }
/** Agent (and optional model) the driver launches for a role (SPEC §12, D2). */
export interface DriveAgent { agent: string; model?: string }
/** Optional `drive:` block of the plan (SPEC §12, D2); defaults max 4, repairs 2, writer agent worker, reviewer agent reviewer. Never an obligation. */
export interface DriveConfig { max: number; repairs: number; writer: DriveAgent; reviewer: DriveAgent; /** 0.7.0: measurements in flight at once; present only when the plan sets it (default `MEASURE_DEFAULT`). */ measure?: number }
/**
 * Optional `exec:` block of the plan (SPEC §3, §7, D20): extra environment and an argv prefix for every process owed
 * starts in a materialized tree. Parsed plans keep only non-empty fields; `exec: {}` is the same as no block.
 */
export interface ExecConfig { env?: Record<string, string>; wrap?: string[] }
/**
 * One rule of the optional `allow:` block (SPEC §3.4, D21): owner pre-authorized parent downgrades and adoptions.
 * `nodes` = node id globs (default ["*"]); at least one permission is present.
 */
export interface AllowRule {
  nodes: string[];
  review_count?: number;      // parent may lower review.count down to this
  review_rank?: number;       // parent may lower review.min_rank down to this
  writes?: string[];          // parent may widen writes with prefixes inside these prefixes
  checks?: string[];          // parent may remove/weaken node checks whose id matches these globs
  adopt?: string[];           // parent may adopt trunk commits whose changed paths all lie under these prefixes
}
export interface Plan {
  version: 1;
  trunk: string;
  closure: string[];
  setup?: string;
  exec?: ExecConfig;          // present only when env or wrap is non-empty
  invariants: CheckSpec[];
  nodes: NodeSpec[];
  drive?: DriveConfig;        // present only when the plan has a `drive:` block (filled with defaults)
  worktrees?: WorktreesConfig; // D19: present only when the plan has a `worktrees:` block (filled with defaults)
  allow?: AllowRule[];        // present only when the plan has an `allow:` block (D21)
}
export interface Downgrade { node: string; what: string }   // e.g. {node:'a', what:'check auth-tests removed'}

// ---------- facts computed by owed from git (deterministic, trusted) ----------
/** Facts about a candidate commit C relative to base B for one node. keys: obligation name -> item key. */
export interface CandidateFacts {
  commit: string;      // full 40-hex OID
  tree: string;
  base: string;        // full OID of B
  patch: string;       // patch-id (or sha256("") for empty diff)
  changed: string[];   // git diff --name-only B C
  closureTouched: boolean;
  keys: Record<string, string>;   // 'check:<id>', 'red:<id>', 'strength:<id>', 'writes', 'closure-review', 'review', 'rulings'
}
/** Facts about a trunk state S. invKeys: invariant id -> item key. */
export interface StateFacts { commit: string; tree: string; invKeys: Record<string, string> }

// ---------- ledger ----------
export type Verdict = 'pass' | 'fail' | 'error';
/** format: 'tap' | 'cargo' | 'jest/vitest' | 'pytest' | 'mixed' (cargo + TAP in one log, E2.1) | 'mutants'. */
export interface Counts { tests?: number; pass?: number; fail?: number; skip?: number; format?: string }

interface Base { seq: number; ts: string; prev: string; hash: string; by: string /* role:id */; channel?: Channel }
export interface GenesisEntry extends Base { kind: 'genesis'; trunk: string; commit: string; plan: string; state: StateFacts }
/** `rev` (resolved commit) and `path` (repository-relative) record where the plan text was read; rev is absent for a working-tree file. */
export interface PlanEntry extends Base { kind: 'plan'; prior: string; plan: string; downgrades: Downgrade[]; rev?: string; path?: string; /** why (D25.5; required for a delegated owner downgrade) */ note?: string }
export interface RuleEntry extends Base { kind: 'rule'; text: string; nodes: string[] | '*' }
export interface DispatchEntry extends Base { kind: 'dispatch'; node: string; attempt: number; base: string; branch: string; worktree: string; packet: string; rulings_seen: number; overlaps?: string[] /* nodes with an open slot whose writes overlap, dispatched with --allow-overlap */ }
export interface SubmitEntry extends Base { kind: 'submit'; node: string; attempt: number; facts: CandidateFacts }
export interface ObsEntry extends Base {
  kind: 'obs';
  subject: string;           // node id, or 'trunk'
  obligation: string;        // 'check:<id>' | 'red:<id>' | 'strength:<id>' | 'writes' | 'inv:<id>'
  key: string;
  verdict: Verdict;
  exit: number | null;
  counts?: Counts;
  log?: string;              // blob sha of the combined output
  durationMs: number;
  commit: string;            // commit the item was evaluated on
  base?: string;
  attribution?: boolean;     // rerun of an earlier failing item
  merging?: string;          // node whose `owed merge` appended this obs (merge-result checks/invariants)
  note?: string;
}
/** `needs: 'parent'` (block only, D18): the reviewer says the fix needs a parent ruling (ambiguous/contradictory brief or plan, a product or contract decision); absent = the writer can fix it. */
export interface ReviewEntry extends Base { kind: 'review'; node: string; attempt: number; obligation: 'review' | 'closure-review' | 'approve'; key: string; verdict: 'ok' | 'block'; rank: number; note?: string; ack_rulings?: number; needs?: 'parent' }
export interface WaiveEntry extends Base { kind: 'waive'; node: string; obligation: string; key: string; reason: string; accept_risk?: number[] }
export interface DeferEntry extends Base { kind: 'defer'; node: string; items: { id: string; key: string }[]; reason: string }
export interface AbandonEntry extends Base { kind: 'abandon'; node: string; attempt: number; reason: string }
/** Moves the open slot of `node` from base `from` to the current trunk `base`; the open candidate is invalidated. */
export interface RebaseEntry extends Base { kind: 'rebase'; node: string; attempt: number; base: string; from: string }
export interface MergeEntry extends Base { kind: 'merge'; node: string; attempt: number; prior: string; commit: string; facts: CandidateFacts; state: StateFacts }
export interface NoteEntry extends Base { kind: 'note'; text: string }
/** A file recorded as manual evidence: `path` repository-relative when inside the repository, else absolute; hashed when recorded. */
export interface EvidenceFile { path: string; sha256: string; bytes: number }
/**
 * D23 manual evidence. On a node with an open candidate (`attempt`, `key` = the `evidence:<id>` key, no `merge`) it
 * discharges `evidence:<id>`; on a merged node (`merge` = seq of its latest merge, no attempt/key) it is an
 * informational receipt. Strict fields.
 */
export interface EvidenceEntry extends Base { kind: 'evidence'; node: string; attempt?: number; key?: string; merge?: number; id: string; files: EvidenceFile[]; note: string }
/**
 * Owner adoption of trunk commits made outside owed (release commits, hotfixes): `commit` (= refs/heads/<trunk>)
 * is a fast-forward of the ledger trunk `prior`; `changed` = paths of prior..commit, `commits` = number of commits
 * in prior..commit; `state` = facts of the adopted commit, which becomes the ledger trunk.
 */
export interface AdoptEntry extends Base { kind: 'adopt'; trunk: string; prior: string; commit: string; state: StateFacts; changed: string[]; commits: number; note: string }
/** Escape classes: missing ② missing obligation; false-pass ①a false affirmative obs; reuse ①b unsound evidence reuse; weak ①c weak oracle; waiver ③ owner waiver. */
export type EscapeClass = 'missing' | 'false-pass' | 'reuse' | 'weak' | 'waiver';
export interface EscapeEntry extends Base { kind: 'escape'; node: string; merge: number; class: EscapeClass; note: string; evidence?: string }
export interface Decoy { node: string; defect: string }
/** Reveal payload; its digest is sha256 of canonical JSON of exactly {nonce, decoys:[{node, defect}]}. */
export interface DecoyPayload { nonce: string; decoys: Decoy[] }
export interface DecoyCommitEntry extends Base { kind: 'decoy-commit'; digest: string }
export interface DecoyRevealEntry extends Base, DecoyPayload { kind: 'decoy-reveal' }
// ---------- driver entries (SPEC §12, D3); appended by role parent (the driver is `parent:drive`) ----------
export type RunRole = 'writer' | 'reviewer';
export type SendKind = 'follow-up' | 'steer';
export type SendReason = 'submit' | 'repair' | 'interrupted' | 'fenced' | 'rebase' | 'review-missing' | 'ruling';
/** Intent to start a dsa run, persisted before the dsa call. `spec` = blob hash of the exact spec JSON bytes; `rid` = runId(...); `labels` = runLabels(...). */
export interface LaunchEntry extends Base { kind: 'launch'; node: string; attempt: number; role: RunRole; rid: string; spec: string; labels: Record<string, string>; /** E4 (0.5.1; absent on 0.5.0 entries): the highest in-scope ruling seq the task carried, 0 when none. */ rulings?: number }
/** Intent to send a message to a run; `send` = `${rid}:${sendKind}:${seq of this entry}` (the dsa request id); `message` = blob hash of the exact message bytes. */
export interface SendEntry extends Base { kind: 'send'; node: string; attempt: number; rid: string; send: string; sendKind: SendKind; message: string; reason: SendReason; /** reason `ruling` (required): the highest ruling seq the message includes (D22.1); reason `repair` (E4, 0.5.1; absent on 0.5.0 entries): the highest in-scope ruling seq it carried, 0 when none; reasons `submit` and `rebase` (0.7, K5.2): the same, written only when it carried a ruling; forbidden otherwise. */ rulings?: number }
/** The driver stops on this attempt until a later non-driver entry on the node or a new attempt (SPEC §12, D3). */
export interface HaltEntry extends Base { kind: 'halt'; node: string; attempt: number; reason: string; needs: 'human' | 'owner' }
/**
 * 0.8 (L1): the parent or owner clears the node's driver halt without an obligation and starts a new repair epoch;
 * `after`: the node waits until that node merges. Strict fields.
 */
export interface ResumeEntry extends Base { kind: 'resume'; node: string; attempt: number; after?: string; note?: string }
export type Entry = GenesisEntry | PlanEntry | RuleEntry | DispatchEntry | SubmitEntry | ObsEntry | ReviewEntry | WaiveEntry | DeferEntry | AbandonEntry | RebaseEntry | MergeEntry | NoteEntry | AdoptEntry | EscapeEntry | DecoyCommitEntry | DecoyRevealEntry | LaunchEntry | SendEntry | HaltEntry | EvidenceEntry | ResumeEntry;
/** An entry before the ledger assigns seq/ts/prev/hash. */
export type Draft = Entry extends infer E ? E extends Entry ? Omit<E, 'seq' | 'ts' | 'prev' | 'hash'> : never : never;

// ---------- reducer views ----------
export type Mark = '✔' | '⚠' | '✘' | '⊥' | '⊤' | '⏸' | '⛔';
export type Discharger = 'executor' | 'writer' | 'reviewer' | 'owner' | 'parent';
export interface ItemView {
  subject: string;           // node id or 'trunk'
  obligation: string;
  key: string;
  status: 'E' | 'W' | 'D';
  mark: Mark;
  discharger?: Discharger;
  evidence: number[];        // seqs of the entries that decide the status
  detail: string;            // one-line human explanation (Chinese)
}
export interface Block {
  seq: number;               // seq of the negative entry
  node: string;
  obligation: string;
  kind: 'exec' | 'judgment';
  key: string;
  rank?: number;
  /** `superseded` (L2): a plan entry changed or removed the check definition its failing observation ran under. */
  state: 'active' | 'cleared' | 'flaky' | 'superseded';
  clearedBy?: number;
  /** L2: seq of the plan entry that superseded this execution block. */
  supersededBy?: number;
  /** Copied from a review block recorded with `needs: 'parent'` (D18): resolved by a later ruling naming the node (`parentRuling`). */
  needs?: 'parent';
}
/** Latest rebase of a slot: `previous` is the last candidate submitted before a rebase (the patch reviewers already saw). */
export interface SlotRebase { seq: number; from: string; base: string; previous?: { base: string; commit: string; submit: number } }
export interface Slot { attempt: number; base: string; branch: string; worktree: string; writer: string; dispatchSeq: number; rulings_seen: number; open: boolean; rebase?: SlotRebase }
export type Phase = 'blocked' | 'ready' | 'dispatched' | 'submitted' | 'accepted' | 'merged';
export interface NodeState {
  id: string;
  phase: Phase;
  slot?: Slot;
  candidate?: CandidateFacts & { seq: number };
  items: ItemView[];          // obligations on the current candidate (empty before submit)
  blocks: Block[];
  accepted: boolean;
  dependents: number;         // transitive dependents count (for ready ordering)
  writers: string[];          // every writer principal that ever held a slot of this node
  merged?: { seq: number; commit: string };
  /** Driver launches and sends per attempt, in attempt order (only attempts with a launch or send). */
  runs: AttemptRuns[];
  /** Active driver halt on the current open attempt (see reducer `halted`). */
  halt?: HaltEntry;
}
export interface AttemptRuns { attempt: number; launches: LaunchEntry[]; sends: SendEntry[] }
export interface Rule { seq: number; text: string; nodes: string[] | '*'; by: string; /** D25: present only for a delegated owner ruling */ channel?: 'delegated' }
export interface State {
  seq: number;                 // last seq, -1 when empty
  head: string;                // hash of last entry
  genesisDone: boolean;        // every invariant has a non-error obs on s0 keys
  trunk: { name: string; commit: string; tree: string; invKeys: Record<string, string>; seq: number };
  planSha: string;
  plan: Plan;
  nodes: Record<string, NodeState>;
  invariants: ItemView[];      // invariant items on the current trunk state
  rules: Rule[];
  /** `allowance` (D21): set when a parent's plan update was accepted under an allowance; S = seq of the genesis/plan entry that last changed `allow`. */
  downgrades: { seq: number; by: string; items: Downgrade[]; allowance?: number; /** D25: present only for a delegated owner plan update */ channel?: 'delegated' }[];
  deferred: { seq: number; node: string; id: string; key: string }[];
  escapes: EscapeView[];
  decoys: DecoyView[];             // revealed decoys with outcomes
  decoyCommits: { seq: number; digest: string; by: string; revealed?: number }[];
  adoptions: AdoptionView[];       // owner adoptions of trunk commits made outside owed, in ledger order
}
/** `allowance` (D21): set for a parent adoption; S = seq of the genesis/plan entry that last changed `allow`. */
export interface AdoptionView { seq: number; by: string; channel?: Channel; prior: string; commit: string; commits: number; changed: string[]; note: string; allowance?: number }
export interface EscapeView { seq: number; by: string; node: string; merge: number; class: EscapeClass; note: string; evidence?: string }
/** caught: a block or rejecting obs on the node before any merge of it; escaped: merged with no prior block; pending: neither yet. */
export interface DecoyView { node: string; defect: string; commit: number; reveal: number; outcome: 'caught' | 'escaped' | 'pending'; decidedBy?: number }

// ---------- driver (SPEC §12, D1) ----------
/** dsa run states the driver distinguishes (unknown dsa states map to `running`). */
export type RunState = 'absent' | 'queued' | 'running' | 'asking' | 'sealed' | 'pruned';
/** An open question of an `asking` run; `to` is dsa's answer address when reported. */
export interface RunQuestion { qid: string; rev: number; question: string; to?: string }
/**
 * The subset of `pi-durable-subagents describe --key <rid> --json` the driver uses (the single definition; `src/dsa.ts`
 * builds it). Unknown dsa states map to `running`; `pruned` is treated like `sealed` with the status describe still
 * reports, else `unknown`. `lastFence.at` is dsa's epoch milliseconds. `wid`, `labels` and `spec_digest` are
 * informational (spec_digest is opaque: never compare it with a locally computed hash).
 */
export interface RunView {
  rid: string;
  state: RunState;
  status?: string;
  error?: string;
  questions?: RunQuestion[];
  lastFence?: { reason: string; at: number; exec?: string };
  wid?: string;
  /** 0.8 (L1.4): dsa's call address `<wid>/<key>` of the run's (latest) call, when describe reports both. */
  to?: string;
  labels?: Record<string, string>;
  spec_digest?: string;
}

// ---------- executor jobs ----------
export interface AttestJob {
  kind: 'check' | 'red' | 'strength' | 'inv' | 'writes';
  subject: string;             // node id or 'trunk'
  obligation: string;
  key: string;
  spec?: CheckSpec;            // for check/red/strength/inv
  commit: string;              // C (or M / trunk state)
  base: string;                // B (closure source)
  attribution?: boolean;
}
export interface MergeGuard { ok: boolean; reasons: string[]; nodeItems: ItemView[]; invItems: ItemView[] }
