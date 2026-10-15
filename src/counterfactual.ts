// MX2 (0.23): read-only replay of recorded driver halts through the 0.23 classifiers.
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { git } from './git.ts';
import { actNodes, metricsBound, parentAct } from './metrics.ts';
import { DRIVER, entriesOf, extendState, reduce, sharedParked, trunkParked } from './reducer.ts';
import type { Entry, ObsEntry, Plan, State } from './types.ts';

/** FS classes: the node would have parked (FS3/TP) or waited for an accepted fix (FS5) instead of halting. */
export type FsClass = 'shared' | 'trunk-red' | 'fix-wait';
/** ER: `clean-rebase` (the rebase after the halt merges cleanly), `unknown` (a commit is missing or git failed). */
export type CounterClass = FsClass | 'clean-rebase' | 'unknown' | 'unchanged';
export const counterClasses: readonly CounterClass[] = ['shared', 'trunk-red', 'fix-wait', 'clean-rebase', 'unknown', 'unchanged'];
export interface CounterRow {
  seq: number; node: string; attempt: number; reason: string; class: CounterClass;
  /** parent acts on the node between the halt and the node's next driver action */
  acts: number[];
  /** of those, the acts the 0.23 policy makes unnecessary */
  saved: number;
  /** ER: the parent rebase in that interval: its slot bases and the candidate it replaced */
  rebase?: { seq: number; from: string; base: string; candidate?: string };
  merged: boolean;
}
export interface Counterfactual {
  since: number | string; halts: number;
  totals: Record<CounterClass, { halts: number; acts: number; saved: number }>;
  merged: { node: string; halts: number; acts: number; saved: number }[];
  rows: CounterRow[];
}
/** The bounded ER check: at most this many merge-tree calls per report; the rest are `unknown`. */
export const MAX_REBASE_CHECKS = 200;
/** Cold folds started in this process (ruling #2572: report --metrics never folds). */
export const counterfactualStats = { folds: 0 };

/** A merge-tree node check failing on the current candidate: the refusal would be mixed, never parked. */
function failingMergeTreeCheck(s: State, node: string): boolean {
  const c = s.nodes[node]?.candidate;
  if (!c) return false;
  const latest = new Map<string, ObsEntry>();
  for (const e of entriesOf(s)) if (e.seq > c.seq && e.kind === 'obs' && e.subject === node && e.merging === node && e.obligation.startsWith('check:')) latest.set(e.obligation, e);
  return [...latest.values()].some(e => e.verdict === 'fail');
}
/** FS3/FS5/TP on the state just before a halt of `node`. */
export function fsClass(s: State, node: string): FsClass | undefined {
  if (trunkParked(s, node).length) return 'trunk-red';
  const parks = sharedParked(s, node);
  if (!parks.length || failingMergeTreeCheck(s, node)) return undefined;
  if (parks.some(p => p.fix !== undefined)) return 'fix-wait';
  return parks.some(p => p.kind === 'shared') ? 'shared' : 'trunk-red';
}
/** The driver (or its executor) acting on `node` again ends the window of parent acts after a halt. */
function driverAction(e: Entry, node: string): boolean {
  if (e.by === DRIVER) return 'node' in e && e.node === node;
  if (e.by !== 'executor:owed') return false;
  return e.kind === 'obs' ? e.subject === node || e.merging === node : 'node' in e && e.node === node;
}
const after = (e: Entry, bound: number | string): boolean => typeof bound === 'number' ? e.seq > bound : Date.parse(e.ts) > Date.parse(bound);

/**
 * One validating fold over the ledger: for each driver halt after `since`, its FS class on the state just before it and
 * the parent acts on its node until the node's next driver action. ER is left to `classifyRebases` (Git).
 */
export function replayHalts(entries: readonly Entry[], plans: (sha: string) => Plan, since: number | string = -1): CounterRow[] {
  counterfactualStats.folds++;
  const s = reduce([], plans), rows: CounterRow[] = [], open = new Map<string, CounterRow>();
  const lastSubmit = new Map<string, string>(), merged = new Set<string>();
  for (const e of entries) {
    if (e.kind === 'halt' && e.by === DRIVER) {
      open.delete(e.node);
      if (after(e, since)) {
        const cls = fsClass(s, e.node);
        const row: CounterRow = { seq: e.seq, node: e.node, attempt: e.attempt, reason: e.reason.replace(/\s+/g, ' ').slice(0, 160), class: cls ?? 'unchanged', acts: [], saved: 0, merged: false };
        rows.push(row); open.set(e.node, row);
      }
      extendState(s, [e]);
      continue;
    }
    const prev = s.plan, candidates = new Map([...open.keys()].map(id => [id, s.nodes[id]?.candidate?.commit ?? lastSubmit.get(id)]));
    extendState(s, [e]);
    if (e.kind === 'submit') lastSubmit.set(e.node, e.facts.commit);
    if (e.kind === 'merge' && after(e, since)) merged.add(e.node);
    if (!open.size) continue;
    const targets = parentAct(e) && !['dispatch', 'launch', 'send'].includes(e.kind) ? actNodes(e, prev, s.plan) : [];
    for (const [node, row] of open) {
      if (driverAction(e, node)) { open.delete(node); continue; }
      if (!targets.includes(node)) continue;
      row.acts.push(e.seq);
      if (e.kind === 'rebase' && !row.rebase) {
        const candidate = candidates.get(node);
        row.rebase = { seq: e.seq, from: e.from, base: e.base, ...(candidate ? { candidate } : {}) };
      }
    }
  }
  for (const r of rows) r.merged = merged.has(r.node);
  return rows;
}
/**
 * ER: `git merge-tree --write-tree --merge-base <old base> <new base> <old candidate>`; exit 0 clean, 1 conflicts,
 * anything else (a missing commit) unknown. The trees it writes go to a temporary object directory, never the repository.
 */
export async function classifyRebases(cwd: string, rows: CounterRow[]): Promise<void> {
  const todo = rows.filter(r => r.class === 'unchanged' && r.rebase);
  if (!todo.length) return;
  const objects = (await git(cwd, ['rev-parse', '--path-format=absolute', '--git-path', 'objects'], { allowFail: true }).catch(() => undefined))?.stdout.trim();
  const tmp = objects ? await mkdtemp(join(tmpdir(), 'owed-counterfactual-')) : undefined;
  try {
    let calls = 0;
    for (const r of todo) {
      const { from, base, candidate } = r.rebase!;
      if (!tmp || !candidate || calls >= MAX_REBASE_CHECKS) { r.class = 'unknown'; continue; }
      calls++;
      const out = await git(cwd, ['merge-tree', '--write-tree', '--no-messages', `--merge-base=${from}`, base, candidate], { allowFail: true, env: { GIT_OBJECT_DIRECTORY: tmp, GIT_ALTERNATE_OBJECT_DIRECTORIES: objects! } }).catch(() => undefined);
      r.class = out?.code === 0 ? 'clean-rebase' : out?.code === 1 && /^[0-9a-f]{40,64}$/m.test(out.stdout) ? 'unchanged' : 'unknown';
    }
  } finally { if (tmp) await rm(tmp, { recursive: true, force: true }); }
}
/** Unnecessary acts: every act for a parked halt; for a clean rebase, every act except the rebase itself. */
function savedActs(r: CounterRow): number {
  if (r.class === 'shared' || r.class === 'trunk-red' || r.class === 'fix-wait') return r.acts.length;
  if (r.class === 'clean-rebase') return r.acts.filter(seq => seq !== r.rebase?.seq).length;
  return 0;
}
export async function counterfactual(cwd: string, entries: readonly Entry[], plans: (sha: string) => Plan, since?: number | string, progress?: (line: string) => void): Promise<Counterfactual> {
  const bound = metricsBound(since, 'since') ?? -1;
  const halts = entries.filter(e => e.kind === 'halt' && e.by === DRIVER && after(e, bound)).length;
  progress?.(`replaying ${entries.length} entries to classify ${halts} halts (cold; about one full replay)`);
  const rows = replayHalts(entries, plans, bound);
  await classifyRebases(cwd, rows);
  const totals = Object.fromEntries(counterClasses.map(c => [c, { halts: 0, acts: 0, saved: 0 }])) as Counterfactual['totals'];
  const byNode = new Map<string, { node: string; halts: number; acts: number; saved: number }>();
  for (const r of rows) {
    r.saved = savedActs(r);
    const t = totals[r.class]; t.halts++; t.acts += r.acts.length; t.saved += r.saved;
    if (!r.merged) continue;
    const n = byNode.get(r.node) ?? { node: r.node, halts: 0, acts: 0, saved: 0 };
    n.halts++; n.acts += r.acts.length; n.saved += r.saved; byNode.set(r.node, n);
  }
  return { since: bound, halts: rows.length, totals, merged: [...byNode.values()].sort((a, b) => b.saved - a.saved || a.node.localeCompare(b.node)), rows };
}
/** Totals per class and per merged node; `--json` has every row. */
export function renderCounterfactual(c: Counterfactual): string {
  const acts = counterClasses.reduce((n, k) => n + c.totals[k].acts, 0), saved = counterClasses.reduce((n, k) => n + c.totals[k].saved, 0);
  const shown = c.merged.filter(n => n.halts).slice(0, 20);
  return [`Counterfactual (since ${c.since === -1 ? 'start' : c.since}): ${c.halts} driver halts; ${saved} of ${acts} parent acts after them would be unnecessary under 0.23`,
    ...counterClasses.filter(k => c.totals[k].halts).map(k => `  ${k}: ${c.totals[k].halts} halts, ${c.totals[k].saved} of ${c.totals[k].acts} acts unnecessary`),
    `Merged nodes with halts: ${shown.length ? '' : 'none'}`.trimEnd(),
    ...shown.map(n => `  ${n.node}: ${n.halts} halts, ${n.saved} of ${n.acts} acts unnecessary`),
    ...(c.merged.length > shown.length ? [`  +${c.merged.length - shown.length} more; --json lists every halt`] : [])].join('\n');
}
