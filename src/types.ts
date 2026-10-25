// Pinned shared types for owed (see docs/SPEC.md). Changing this file requires the parent.

export type Role = 'owner' | 'parent' | 'writer' | 'reviewer' | 'executor';
export interface Principal { role: Role; id: string }
/** How an owner act was authorized: a TTY prompt, a pi dialog, `--i-am-owner` (flag), or delegated to the main agent (D25: no human step). */
export type Channel = 'tty' | 'pi-confirm' | 'flag' | 'delegated';

// ---------- plan ----------
export interface CheckSpec {
  id: string;
  run: string;
  run_file?: { path: string; sha256: string };
  args?: string[];
  selftest?: { commit: string; expect: 'pass' | 'fail' }[];
  timeout_s: number;          // default 600
  on_timeout?: string;        // SG5: diagnostic only, once before kill, limited to 30s
  reads: string[];            // default ["**"]
  min_tests?: number;
  red?: boolean;
  tests?: string[];           // required when red
  red_expect?: string;
  mutants?: string[];         // globs of mutant patch files inside the plan closure (read from the base)
  min_kill?: number;          // fraction of mutants that must be killed, in (0,1]; default 1
  /** RC1: K passing runs out of at most N (1 <= need <= runs <= 9); not on red or mutants checks. */
  repeat?: { runs: number; need?: number };
  /** MS4 (0.20): exact failing test names excused while their fix node is in the plan and not merged; active names are part of the key. */
  quarantine?: QuarantineEntry[];
  /** QS1: shared quarantine entries, combined with the check's own entries. */
  quarantine_set?: string;
}
/** MS4 (0.20): one quarantined test name, owned by a fix node; inactive once `fix` merges or leaves the plan. */
export interface QuarantineEntry { test: string; fix: string; note?: string }
/** KR: exact failed-test names, owned by a fix node until it merges; never part of an item key. */
export interface KnownRed { test: string; fix: string }
export interface InvariantSpec extends CheckSpec { known_red?: KnownRed[]; /** RO1: one same-key retry when every failure matches an error substring. */ remeasure_on?: string[] }
export interface NodeSpec {
  id: string;
  title?: string;
  deps: string[];
  writes: string[];
  /** AO: exact paths or syntax 2 globs capping allow grants only; [] grants nothing. */
  allow_only?: string[];
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
  /** FL4: backlog, ineligible for dispatch; never part of an obligation key. */
  later?: boolean;
}
/** K3: a node's `drive` override of one role: at least one of `agent` / `model` (an empty object is dropped by the parser). */
export interface NodeDriveAgent { agent?: string; model?: string }
/** K3: optional node field `drive`; only roles that set something are present (`drive: {}` is dropped by the parser). */
export interface NodeDrive { writer?: NodeDriveAgent; reviewer?: NodeDriveAgent; /** MD2: quiet same-model warning; no gate changes. */ same_model?: 'accepted' }
/** D19: optional `worktrees:` block of the plan; never an obligation, read by later dispatches only. */
export interface WorktreesConfig { root: string /* absolute, or relative to the main worktree root */; branch: string /* template with {node}, {attempt}, optional {type} */ }
/** D23: one manual evidence obligation of a node; `by` (default reviewer) is the role that may record it (the owner always may). */
export interface EvidenceSpec { id: string; what: string; by: 'reviewer' | 'parent' | 'owner' }
/** Agent (and optional model) the driver launches for a role (SPEC §12, D2). */
export interface DriveAgent { agent: string; model?: string }
/** Optional `drive:` block of the plan (SPEC §12, D2); defaults max 4, repairs 2, writer agent worker, reviewer agent reviewer. Never an obligation. */
export interface DriveConfig { delegate?: DelegateConfig; max: number; repairs: number; writer: DriveAgent; reviewer: DriveAgent; /** 0.7.0: measurements in flight at once; present only when the plan sets it (default `MEASURE_DEFAULT`). */ measure?: number; /** 0.11 (F2.3): free MB below which the driver starts no measurement; present only when the plan sets it (default `MIN_FREE_DEFAULT`, 0 disables). */ min_free_mb?: number; /** FL4: idle reminder interval in minutes, default 60; 0 disables. */ idle_rewake_min?: number; /** WD: no-progress watchdog interval in minutes, default 15; 0 disables. */ watch_idle_min?: number; /** QN1/QT5: seconds before reminding about an answered question still open in dsa (default 600). */ answer_grace_s?: number; /** MD2: quiet same-model warning; no gate changes. */ same_model?: 'accepted'; /** MT1 (0.21): members of one batch merge, 1..8; present only when the plan sets it (default 1 = off). */ merge_batch?: number }
/**
 * Optional `exec:` block of the plan (SPEC §3, §7, D20): extra environment and an argv prefix for every process owed
 * starts in a materialized tree. Parsed plans keep only non-empty fields; `exec: {}` is the same as no block.
 * 0.9: `parallel` (jobs one merge, adopt or genesis attest measures at once; default 1) and `trees` (`fresh`, the
 * default, or `reuse`: stable measurement worktrees) are present only when set; they are not part of any key.
 * 0.11: `touch` (default reset) refreshes tracked mtimes in reused trees and is part of the exec key.
 */
export interface ExecConfig { env?: Record<string, string>; wrap?: string | string[]; wrap_grace_s?: number; parallel?: number; trees?: 'fresh' | 'reuse'; touch?: 'reset' | 'always' | 'never' }
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
  /** FS6 (0.23): invariant id globs owed itself may defer on a shared intermittent failure with a same-key pass. */
  defer?: string[];
}
export interface SweepSpec { run: string; timeout_s: number; reads?: string[]; /** Advisory schedule; excluded from the sweep definition key. */ every?: { merges?: number; minutes?: number } }
export interface RiskRule { paths: string[]; review: NodeSpec['review'] }
export interface ClosureNeutral { path: string; json_ignore: string[] }
export interface Plan {
  version: 1;
  trunk: string;
  closure: string[];
  setup?: string;
  /** SS: dispatch-only setup override; false skips setup in slots. Never part of an item key. */
  slot_setup?: string | false;
  /** LE3: machine leasing defaults on; false disables it repository-wide. Never part of any item key. */
  lease?: boolean;
  sweep?: SweepSpec;          // advisory trunk measurements, never part of an item key
  /** BD3: submit-only limits in MiB on candidate changed blobs; never part of an item key. */
  limits?: { file_mib?: number; diff_mib?: number };
  /** EV1: routing hints only; never part of an obligation key or check definition. */
  env_signatures?: { match: string[]; unless?: string[] };
  exec?: ExecConfig;          // present only when env, wrap, parallel, trees or touch is set
  invariants: InvariantSpec[];
  nodes: NodeSpec[];
  drive?: DriveConfig;        // present only when the plan has a `drive:` block (filled with defaults)
  worktrees?: WorktreesConfig; // D19: present only when the plan has a `worktrees:` block (filled with defaults)
  allow?: AllowRule[];        // present only when the plan has an `allow:` block (D21)
  /** RK: ordered diff review policy; never part of an evidence key. */
  risk?: RiskRule[];
  /** RK: exact JSON closure paths with ignored dot paths; checks still hash full files. */
  closure_neutral?: ClosureNeutral[];
  /** QS1: named owner-managed quarantine lists. */
  quarantine_sets?: Record<string, QuarantineEntry[]>;
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
  /** ER1: OK review receipts inherited from the previous candidate across an exact clean merge tree. */
  carry?: { from: string; reviews: number[] };
  /** ER3: executor measured that this commit descends from the immediately preceding rebase base. */
  rebased?: true;
  keys: Record<string, string>;   // 'check:<id>', 'red:<id>', 'strength:<id>', 'writes', 'closure-review', 'review', 'rulings'
}
/** Facts about a trunk state S. invKeys: invariant id -> item key. */
export interface StateFacts { commit: string; tree: string; invKeys: Record<string, string> }

// ---------- ledger ----------
export type Verdict = 'pass' | 'fail' | 'error';
/** format: 'tap' | 'cargo' | 'jest/vitest' | 'pytest' | 'mixed' (cargo + TAP in one log, E2.1) | 'mutants'. */
export interface Counts { tests?: number; pass?: number; fail?: number; skip?: number; format?: string; /** RC3: at most 50 failing test names. */ failed?: string[] }
/** IR2 (0.15): executor facts, not parsed from display notes; absent in historical observations. */
export interface ExecutionResult { completed: boolean; countOK: boolean }
/** RC1: one command run, before repeat decides the observation's verdict. Errors stop measurement, never count as votes. */
export interface MeasurementRun { verdict: Verdict; exit: number | null; counts?: Counts; durationMs: number; log: string; note?: string; failed?: string[]; execution?: ExecutionResult }

interface Base { seq: number; ts: string; prev: string; hash: string; by: string /* role:id */; channel?: Channel; /** DC2: first entry seq of one atomic decision. */ decision?: number; /** RC (0.27): sorted unique present display fields unknown readers may ignore; never base fields. */ ignorable?: string[] }
export interface GenesisEntry extends Base { kind: 'genesis'; trunk: string; commit: string; plan: string; writes_syntax?: 2 | 3; state: StateFacts; /** SF2: source file of the initial plan, for start without --plan. */ path?: string }
/** IR1: current-plan facts on the ledger trunk; refresh changes invariant keys, never the trunk commit/seq. */
export interface RefreshEntry extends Base { kind: 'refresh'; commit: string; state: StateFacts }
/** `rev` (resolved commit) and `path` (repository-relative) record where the plan text was read; rev is absent for a working-tree file. */
export interface PlanEntry extends Base { kind: 'plan'; prior: string; plan: string; writes_syntax?: 2 | 3; downgrades: Downgrade[]; rev?: string; path?: string; /** why (D25.5; required for a delegated owner downgrade) */ note?: string }
export interface AnswerRef { rid: string; qid: string; rev: number }
/** DC: multiple answers share one decision ruling. */
export interface DecisionAnswer extends AnswerRef { node: string }
export interface RuleEntry extends Base { via?: string; kind: 'rule'; text: string; nodes: string[] | '*'; writer?: boolean; prospective?: boolean; answer?: AnswerRef; answers?: DecisionAnswer[]; /** AR: latest prior answer rule for this rid/qid; re-ask ledgers require 0.16. */ supersedes?: number }
export interface DispatchEntry extends Base { kind: 'dispatch'; node: string; attempt: number; base: string; branch: string; worktree: string; packet: string; rulings_seen: number; overlaps?: string[] /* nodes with an open slot whose writes overlap, dispatched with --allow-overlap */ }
/**
 * N1 (0.10): `carry` = the seq of the submit this entry carries across a plan entry that changed only the node's checks,
 * writes, type or drive. Only a submit by executor:owed has it (the same commit at the same base, facts recomputed).
 */
export interface SubmitEntry extends Base { kind: 'submit'; node: string; attempt: number; facts: CandidateFacts; carry?: number; model?: string }
/** GR: exact changed paths pre-authorized by the current owner allowance, scoped to one attempt. */
export interface GrantEntry extends Base { kind: 'grant'; node: string; attempt: number; commit: string; paths: string[]; allowance: number }
export interface ObsEntry extends Base {
  kind: 'obs';
  subject: string;           // node id, or 'trunk'
  obligation: string;        // 'check:<id>' | 'red:<id>' | 'strength:<id>' | 'writes' | 'inv:<id>'
  key: string;
  verdict: Verdict;
  exit: number | null;
  counts?: Counts;
  /** IR2: all executed runs completed without timeout/error and met their count/min_tests requirement. */
  execution?: ExecutionResult;
  log?: string;              // blob sha of the combined output
  durationMs: number;
  commit: string;            // commit the item was evaluated on
  base?: string;
  attribution?: boolean;     // rerun of an earlier failing item
  merging?: string;          // node whose `owed merge` appended this obs (merge-result checks/invariants)
  /** 0.14 TR: informational node-check measurement on trunk; never counts as an obligation or block. */
  probe?: 'trunk';
  note?: string;
  /** RC1: every executed repeat run (in order), each with its own log digest. */
  runs?: MeasurementRun[];
  /** RC1: executed runs include both pass and fail. */
  noisy?: boolean;
  /** RC3: at most 50 failing names (union across repeat runs). */
  failed?: string[];
  /** SG1: failed name -> v2 error/innermost repository test frame/assertion values (first failing run). Untagged legacy signatures remain readable. */
  signatures?: Record<string, string>;
  /** WG5: only refusals are ownership overlaps; retry once when every named slot closes. */
  grant_refused?: boolean;
  waits_on?: string[];
  /** MS4 (0.20): failing test names excused by active quarantine entries (they neither passed nor failed). */
  quarantined?: string[];
  /** QS4 (0.27): active quarantine names that passed in a complete native trunk/merge-tree run; display only. */
  quarantine_passed?: string[];
  /** RO3: this observation consumed the one automatic invariant remeasure on its key. */
  auto_remeasure?: true;
  /** IF2 (0.26): the immediately preceding same-key setup failure resolved by this counted pass. */
  infra?: number;
  /** RO: unique configured literals matching every failure, for bounded replay provenance. */
  remeasure_match?: string[];
  /** MT4 (0.21): measured on a batch merge tree (members in order); never `merging`, never a block. */
  batch?: string[];
  /** MX3 (0.23): milliseconds the command waited for the machine lease before it started; older owed refuses it. */
  lease_wait_ms?: number;
}
/** `needs: 'parent'` (block only, D18): the reviewer says the fix needs a parent ruling (ambiguous/contradictory brief or plan, a product or contract decision); absent = the writer can fix it. */
export interface ReviewEntry extends Base { kind: 'review'; node: string; attempt: number; obligation: 'review' | 'closure-review' | 'approve'; key: string; verdict: 'ok' | 'block'; rank: number; note?: string; ack_rulings?: number; needs?: 'parent'; model?: string }
export interface WaiveEntry extends Base { kind: 'waive'; node: string; obligation: string; key: string; reason: string; accept_risk?: number[]; tracked_by?: string }
export interface DeferEntry extends Base { kind: 'defer'; node: string; items: { id: string; key: string }[]; reason: string; /** FS6 (0.23): only on an `executor:owed` defer: seq of the plan whose `allow` defer rule covers it; older owed refuses it. */ allowance?: number }
export interface AbandonEntry extends Base { kind: 'abandon'; node: string; attempt: number; reason: string }
/** AH: appended atomically after the abandon it names; older owed refuses this new kind. */
export interface HoldEntry extends Base { kind: 'hold'; node: string; abandon: number; reason?: string }
/** Moves the open slot of `node` from base `from` to the current trunk `base`; the open candidate is invalidated. */
export interface RebaseEntry extends Base { kind: 'rebase'; node: string; attempt: number; base: string; from: string }
export interface MergeEntry extends Base { kind: 'merge'; node: string; attempt: number; prior: string; commit: string; facts: CandidateFacts; state: StateFacts; /** MT3 (0.21): batch merge member; older owed misjudges it. */ batch?: MergeBatch; /** MX3 (0.23): milliseconds the merge waited for the machine lease before it started. */ lease_wait_ms?: number }
/** MT3 (0.21): the batch a merge entry belongs to, identical on every member entry: the final merge commit Mn, its state facts, per member its check keys on Mn, all members in order. */
export interface MergeBatch { final: string; state: StateFacts; keys: Record<string, Record<string, string>>; members: string[] }
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
export interface EscapeEntry extends Base { kind: 'escape'; node: string; merge: number; class: EscapeClass; note: string; evidence?: string; /** Confirmed sweep boundary authorizing an executor escape. */ sweep?: number }
export interface Decoy { node: string; defect: string }
/** Reveal payload; its digest is sha256 of canonical JSON of exactly {nonce, decoys:[{node, defect}]}. */
export interface DecoyPayload { nonce: string; decoys: Decoy[] }
export interface DecoyCommitEntry extends Base { kind: 'decoy-commit'; digest: string }
export interface DecoyRevealEntry extends Base, DecoyPayload { kind: 'decoy-reveal' }
// ---------- driver entries (SPEC §12, D3); appended by role parent (the driver is `parent:drive`) ----------
export type RunRole = 'writer' | 'reviewer';
export type SendKind = 'follow-up' | 'steer' | 'notify';
export type SendReason = 'submit' | 'repair' | 'interrupted' | 'fenced' | 'rebase' | 'review-missing' | 'ruling' | 'verdict' | 'waiting' | 'report';
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
export interface ResumeEntry extends Base { via?: string; kind: 'resume'; node: string; attempt: number; after?: string | string[]; expect?: 'report'; note?: string; release?: 'hold'; /** PO2: first resume seq of an atomic batch. */ batch?: number; /** MS2 (0.20): the driver remeasures failed merge-tree invariants before its next merge. */ remeasure?: boolean }
export interface SweepEntry extends Base { kind: 'sweep'; commit: string; key?: string; verdict: Verdict; counts?: Counts; log: string; failed: string[]; bisect?: boolean; /** Last passing predecessor sample; prior samples prove the head and culprit failed. */ boundary?: { head: number; merge: number } }
export type AAct = 'preferred-answer' | 'infra-resume';
export interface DelegateConfig {
  on?: ('question' | 'writer-stop' | 'review-asks' | 'infra-halt' | 'needs-owner')[];
  max: number;
  budget?: { rounds?: number; wall_s?: number };
  a_acts?: AAct[];
  appends?: string[];
}
export interface StageBundle {
  ruling_text: string;
  decide?: { nodes: string[]; writes?: string[]; resume?: boolean; expect?: 'report'; writer?: boolean; allow_only?: string[]; after?: string | string[]; remeasure?: boolean };
  plan_patch?: { file: string; before_sha256: string; after_sha256: string; self_check?: string };
  appends?: { path: string; text: string }[];
  evidence?: { path: string; sha256: string }[];
  read_through_seq: number;
  touches?: string[];
  class?: 'A' | 'B' | 'C';
  summary: string;
}
export interface StageEntry extends Base { kind: 'stage'; node: string; bundle: string; patched_plan?: string; plan_path?: string; questions: string; touches: string[]; class: 'A' | 'B' | 'C'; summary: string; read_through_seq: number; before_sha256?: string; after_sha256?: string }
export interface AcceptEntry extends Base { kind: 'accept'; stage: string; ruling: number; plan?: number }
export interface RejectEntry extends Base { kind: 'reject'; stage: string; note: string }
export interface OverturnEntry extends Base { kind: 'overturn'; act: number; note: string }
export interface StageView { id: string; node: string; class: 'A' | 'B' | 'C'; state: 'open' | 'stale' | 'accepted' | 'rejected' | 'unknown'; reason?: string; age: number; summary: string; command: string }
export type Entry = StageEntry | AcceptEntry | RejectEntry | OverturnEntry | GrantEntry | RefreshEntry | SweepEntry | GenesisEntry | PlanEntry | RuleEntry | DispatchEntry | SubmitEntry | ObsEntry | ReviewEntry | WaiveEntry | DeferEntry | AbandonEntry | HoldEntry | RebaseEntry | MergeEntry | NoteEntry | AdoptEntry | EscapeEntry | DecoyCommitEntry | DecoyRevealEntry | LaunchEntry | SendEntry | HaltEntry | EvidenceEntry | ResumeEntry;
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
/** `removed` (F4, field report #27): the node is in the state but not in the current plan and not merged. */
export type Phase = 'blocked' | 'ready' | 'dispatched' | 'submitted' | 'accepted' | 'merged' | 'removed' | 'held';
export interface NodeState {
  id: string;
  phase: Phase;
  slot?: Slot;
  /** N1: `carried` when the candidate is a carry submit: the plan entry that carried it and the submit it carried. */
  candidate?: CandidateFacts & { seq: number; carried?: { plan: number; submit: number } };
  items: ItemView[];          // obligations on the current candidate (empty before submit)
  blocks: Block[];
  accepted: boolean;
  /** MO1: seq since this current candidate has been continuously accepted; derived, never a ledger field. */
  acceptedSince?: number;
  dependents: number;         // transitive dependents count (for ready ordering)
  writers: string[];          // every writer principal that ever held a slot of this node
  merged?: { seq: number; commit: string };
  /** AH: seq of the abandon that holds this node until resume or removal from the plan. */
  held?: number;
  /** Driver launches and sends per attempt, in attempt order (only attempts with a launch or send). */
  runs: AttemptRuns[];
  /** Active driver halt on the current open attempt (see reducer `halted`). */
  halt?: HaltEntry;
  /** FL3: runtime receipt (not ledger state), validated against the report follow-up and later parent acts. */
  reported?: number;
}
export interface AttemptRuns { attempt: number; launches: LaunchEntry[]; sends: SendEntry[] }
export interface Rule { seq: number; text: string; nodes: string[] | '*'; by: string; writer?: boolean; prospective?: boolean; answer?: AnswerRef; answers?: DecisionAnswer[]; /** DC: distinguishes raw multi-answer TEXT from legacy prefixes. */ decision?: number; /** D25: present only for a delegated owner ruling */ channel?: 'delegated' }
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
  deferred: { seq: number; node: string; id: string; key: string; /** FS6: present only on an executor defer under allowance. */ allowance?: number }[];
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
export interface RunQuestion {
  qid: string; rev: number; question: string; to?: string;
  decision_needed?: string;
  options?: { label: string; scope?: string; cost?: string; risk?: string; preferred?: boolean }[];
  facts?: string[]; tried?: string[];
  classification_candidates?: { label: string; evidence?: string[]; unproven?: string[] }[];
}
/**
 * The subset of `pi-durable-subagents describe --key <rid> --json` the driver uses (the single definition; `src/dsa.ts`
 * builds it). Unknown dsa states map to `running`; `pruned` is treated like `sealed` with the status describe still
 * reports, else `unknown`. `lastFence.at` is dsa's epoch milliseconds. `wid`, `labels` and `spec_digest` are
 * informational (spec_digest is opaque: never compare it with a locally computed hash).
 */
export interface RunView {
  /** DR3: actual model reported by dsa, never inferred from the selected launch spec. */
  model?: string;
  rid: string;
  state: RunState;
  status?: string;
  error?: string;
  questions?: RunQuestion[];
  /** AR1: optional per-call facts for post-answer receipts, not scheduling or ledger state. */
  calls?: { key: string; phase?: string; status?: string }[];
  lastFence?: { reason: string; at: number; exec?: string };
  wid?: string;
  /** 0.8 (L1.4): dsa's call address `<wid>/<key>` of the run's (latest) call, when describe reports both. */
  to?: string;
  labels?: Record<string, string>;
  spec_digest?: string;
  /** FL3: the final text of the run, kept by describe for the report wake-up. */
  result?: string;
  /** WR2: optional facts of dsa's last described call; old dsa omits them. */
  sealedAt?: number;
  awaiting?: { request: string; wid?: string; state: 'pending' | 'running' | 'finished' }[];
  endedAtSeal?: { pid: number; command: string }[];
  endedAtSealMore?: number;
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
  /** MS4 (0.20): active quarantine entries of the spec; the executor applies them only when the key commits to their names. */
  quarantined?: QuarantineEntry[];
  /** QS4: measurement scope, for quarantine recovery diagnostics only. */
  merging?: string;
  probe?: 'trunk';
}
export interface MergeGuard { ok: boolean; reasons: string[]; nodeItems: ItemView[]; invItems: ItemView[] }
