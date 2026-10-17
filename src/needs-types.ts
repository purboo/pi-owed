/**
 * owed 0.28 need vocabulary (contract-0.28 "Vocabulary", rev 2). Types only; copied byte for byte by nodes `needs`
 * and `activity`. Change it only through a parent ruling.
 */
/** Something a parent or owner must do. Agents' and the executor's work is an Activity, never a Need. */
export type NeedKind = 'dispatch' | 'answer' | 'decide' | 'rule' | 'waive' | 'review' | 'approve' | 'evidence'
  | 'defer' | 'resume' | 'recover' | 'investigate';
export interface Need {
  /** Plan node id, or 'trunk' for a repository need. */
  node: string;
  actor: 'parent' | 'owner';
  kind: NeedKind;
  /** Seq of the entry that created the need; null when it exists only at runtime. */
  since: number | null;
  obligation?: string;
  block?: number;
  key?: string;
  /** 12-hex pin of the current candidate, when the command takes one. */
  candidate?: string;
  /** Question identity of an answer need. */
  rid?: string;
  qid?: string;
  rev?: number;
  /** One complete owed command; absent when no single existing command resolves the need. */
  command?: string;
  /** Other complete commands that resolve the same need differently. */
  alternatives?: string[];
  /** One line: what is needed and why. */
  text: string;
  /** The node is halted. */
  halted?: true;
}
/** What a node is doing now, from recorded state (the status progress phase). It never predicts a driver action. */
export interface Activity {
  node: string;
  phase: 'writing' | 'measuring' | 'reviewing' | 'repairing' | 'accepted' | 'waiting' | 'held';
  /** The progress text shown by status. */
  text: string;
}
export interface Measuring {
  node: string;
  /** Obligations selected for measurement, under the attest lock. */
  obligations: string[];
  /** Candidate seq whose tree is measured; absent for runs that measure another tree. */
  candidate?: number;
  /** 'attest' measures the candidate tree; 'other' is any run on another tree (trunk probe, attribution, invariant). */
  do: 'attest' | 'other';
  phase: 'queued' | 'running';
  /** ISO time. */
  since: string;
  pid: number;
  token: string;
}
/** A question the driver saw still open after it was answered (the existing still-asking need). */
export interface Asking { node: string; rid: string; qid: string; rev: number; text: string }
/** Runtime facts, assembled by `assembleRuntime` (src/activity.ts). An absent field is unknown, never "none". */
export interface Runtime {
  measuring?: readonly Measuring[];
  asking?: readonly Asking[];
  driverRunning?: boolean;
}
