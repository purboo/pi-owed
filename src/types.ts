// Pinned shared types for owed (see docs/SPEC.md). Changing this file requires the parent.

export type Role = 'owner' | 'parent' | 'writer' | 'reviewer' | 'executor';
export interface Principal { role: Role; id: string }
export type Channel = 'tty' | 'pi-confirm' | 'flag';

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
}
export interface NodeSpec {
  id: string;
  title?: string;
  deps: string[];
  writes: string[];
  checks: CheckSpec[];
  review: { count: number; min_rank: number };   // default {count:0,min_rank:1}
  brief?: string;
}
export interface Plan {
  version: 1;
  trunk: string;
  closure: string[];
  setup?: string;
  invariants: CheckSpec[];
  nodes: NodeSpec[];
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
  keys: Record<string, string>;   // 'check:<id>', 'red:<id>', 'writes', 'closure-review', 'review', 'rulings'
}
/** Facts about a trunk state S. invKeys: invariant id -> item key. */
export interface StateFacts { commit: string; tree: string; invKeys: Record<string, string> }

// ---------- ledger ----------
export type Verdict = 'pass' | 'fail' | 'error';
export interface Counts { tests?: number; pass?: number; fail?: number; skip?: number; format?: string }

interface Base { seq: number; ts: string; prev: string; hash: string; by: string /* role:id */; channel?: Channel }
export interface GenesisEntry extends Base { kind: 'genesis'; trunk: string; commit: string; plan: string; state: StateFacts }
export interface PlanEntry extends Base { kind: 'plan'; prior: string; plan: string; downgrades: Downgrade[] }
export interface RuleEntry extends Base { kind: 'rule'; text: string; nodes: string[] | '*' }
export interface DispatchEntry extends Base { kind: 'dispatch'; node: string; attempt: number; base: string; branch: string; worktree: string; packet: string; rulings_seen: number }
export interface SubmitEntry extends Base { kind: 'submit'; node: string; attempt: number; facts: CandidateFacts }
export interface ObsEntry extends Base {
  kind: 'obs';
  subject: string;           // node id, or 'trunk'
  obligation: string;        // 'check:<id>' | 'red:<id>' | 'writes' | 'inv:<id>'
  key: string;
  verdict: Verdict;
  exit: number | null;
  counts?: Counts;
  log?: string;              // blob sha of the combined output
  durationMs: number;
  commit: string;            // commit the item was evaluated on
  base?: string;
  attribution?: boolean;     // rerun of an earlier failing item
  note?: string;
}
export interface ReviewEntry extends Base { kind: 'review'; node: string; attempt: number; obligation: 'review' | 'closure-review'; key: string; verdict: 'ok' | 'block'; rank: number; note?: string; ack_rulings?: number }
export interface WaiveEntry extends Base { kind: 'waive'; node: string; obligation: string; key: string; reason: string; accept_risk?: number[] }
export interface DeferEntry extends Base { kind: 'defer'; node: string; items: { id: string; key: string }[]; reason: string }
export interface AbandonEntry extends Base { kind: 'abandon'; node: string; attempt: number; reason: string }
export interface MergeEntry extends Base { kind: 'merge'; node: string; attempt: number; prior: string; commit: string; facts: CandidateFacts; state: StateFacts }
export interface NoteEntry extends Base { kind: 'note'; text: string }
export type Entry = GenesisEntry | PlanEntry | RuleEntry | DispatchEntry | SubmitEntry | ObsEntry | ReviewEntry | WaiveEntry | DeferEntry | AbandonEntry | MergeEntry | NoteEntry;
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
  state: 'active' | 'cleared' | 'flaky';
  clearedBy?: number;
}
export interface Slot { attempt: number; base: string; branch: string; worktree: string; writer: string; dispatchSeq: number; rulings_seen: number; open: boolean }
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
}
export interface Rule { seq: number; text: string; nodes: string[] | '*'; by: string }
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
  downgrades: { seq: number; by: string; items: Downgrade[] }[];
  deferred: { seq: number; node: string; id: string; key: string }[];
}

// ---------- executor jobs ----------
export interface AttestJob {
  kind: 'check' | 'red' | 'inv' | 'writes';
  subject: string;             // node id or 'trunk'
  obligation: string;
  key: string;
  spec?: CheckSpec;            // for check/red/inv
  commit: string;              // C (or M / trunk state)
  base: string;                // B (closure source)
  attribution?: boolean;
}
export interface MergeGuard { ok: boolean; reasons: string[]; nodeItems: ItemView[]; invItems: ItemView[] }
