import type { Entry, Plan, State } from './types.ts';
import { driveReviewerSlot, reviewerBase, writesOverlap, applicableRules } from './reducer.ts';

/** PO4: advisory only; all equally longest unfinished dependency chains are critical. */
export function parentOverlapWarnings(plan: Plan, state: State): string[] {
  const nodes = plan.nodes.filter(n => !state.nodes[n.id]?.merged), ids = new Set(nodes.map(n => n.id));
  const deps = new Map(nodes.map(n => [n.id, n.deps.filter(d => ids.has(d))]));
  const children = new Map(nodes.map(n => [n.id, nodes.filter(x => x.deps.includes(n.id)).map(x => x.id)]));
  const memo = new Map<string, number>();
  const depth = (id: string): number => {
    const cached = memo.get(id); if (cached !== undefined) return cached;
    const value = 1 + Math.max(0, ...(deps.get(id) ?? []).map(depth)); memo.set(id,value); return value;
  };
  const longest = Math.max(0,...nodes.map(n => depth(n.id))), critical = new Set<string>();
  const mark = (id: string): void => {
    if (critical.has(id)) return; critical.add(id);
    for (const d of deps.get(id) ?? []) if (depth(d) === depth(id)-1) mark(d);
  };
  for (const n of nodes) if (!children.get(n.id)?.length && depth(n.id) === longest) mark(n.id);
  const ancestors = (id: string, target: string): boolean => (deps.get(id) ?? []).some(d => d === target || ancestors(d,target));
  const seen = new Set<string>(), warnings: string[] = [];
  for (const a of nodes) {
    const added = !state.plan.nodes.some(n => n.id === a.id);
    const ready = !state.nodes[a.id]?.slot?.open && !a.later && a.deps.every(d => !!state.nodes[d]?.merged);
    if (!added && !ready) continue;
    for (const b of nodes) {
      const pair = [a.id,b.id].sort().join('\0');
      if (a.id === b.id || seen.has(pair) || !critical.has(b.id) || ancestors(a.id,b.id) || ancestors(b.id,a.id) || !writesOverlap(a.writes,b.writes)) continue;
      seen.add(pair); warnings.push(`writes of ${a.id} overlap ${b.id} (on the critical path): consider deps ${a.id} after ${b.id}`);
    }
  }
  return warnings;
}

/** PO6: only the current driver reviewer's recorded launch packet can supply an implicit ack. */
export async function launchedReviewAck(state: State, node: string, by: string, read: (sha: string) => Promise<string>): Promise<number | undefined> {
  const n = state.nodes[node], slot = n?.slot;
  if (!slot?.open) return undefined;
  const k = driveReviewerSlot(by,node,slot.attempt);
  if (k === undefined) return undefined;
  const number = reviewerBase(state,node)+k;
  const launch = n!.runs.find(r => r.attempt === slot.attempt)?.launches.find(l => l.by === 'parent:drive' && l.role === 'reviewer' && l.rid.endsWith(`:reviewer:${number}`));
  if (!launch || !n!.candidate) return undefined;
  let spec: unknown;
  try { spec = JSON.parse(await read(launch.spec)); } catch { return undefined; }
  const task = (spec as { task?: unknown } | null)?.task;
  if (typeof task !== 'string' || !task.includes(`\nCandidate: ${n!.candidate.commit} (submit #${n!.candidate.seq})\n`)) return undefined;
  const identity = `\nYour reviewer identity: ${by} (never the writer of this node).`;
  const end = task.indexOf(identity), start = task.lastIndexOf('\nRulings in scope:',end);
  if (end < 0 || start < 0) return undefined;
  const section = task.slice(start,end)+'\n';
  // Compare exact parent-written ruling bytes; launch metadata alone is not acknowledgment evidence.
  let ack = 0;
  for (const ruling of applicableRules(state,node).filter(r => r.seq < launch.seq).sort((a,b) => a.seq-b.seq)) {
    if (!section.includes(`\n- #${ruling.seq} ${ruling.text}\n`)) break;
    ack = ruling.seq;
  }
  return ack;
}

/** PO5: failed measurements take precedence over outstanding obligations. */
export function attestExit(failed: boolean, outstanding: boolean): 0 | 1 | 4 {
  return failed ? 1 : outstanding ? 4 : 0;
}
export function measuredFailure(observations: readonly Entry[]): boolean {
  return observations.some(e => e.kind === 'obs' && e.verdict === 'fail');
}
