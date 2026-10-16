import { canonical } from './canon.ts';
import type { Draft, Entry, RuleEntry } from './types.ts';

/** ID: response metadata only; never appended to the ledger. */
export type RecordedAct<T = Entry> = T & { alreadyRecorded?: number };
export const alreadyRecordedText = (e: { alreadyRecorded?: number }): string | undefined => e.alreadyRecorded === undefined ? undefined : `already recorded as #${e.alreadyRecorded}`;
export const isAct = (e: Draft): boolean => e.kind === 'review' || e.kind === 'waive' || (e.kind === 'evidence' && e.merge === undefined);
export function actScope(e: Draft): string | undefined {
  if (!isAct(e)) return undefined;
  return canonical([e.kind, e.by, 'node' in e ? e.node : '', 'attempt' in e ? e.attempt : undefined, e.kind === 'evidence' ? e.id : 'obligation' in e ? e.obligation : '']);
}
const set = (xs: readonly unknown[]): unknown[] => [...new Set(xs.map(x => canonical(x)))].sort();
/** Compare only the contract's content; delivery channel and model attribution are not a new judgment. */
export function actContent(e: Draft, rules?: readonly Pick<RuleEntry, 'seq' | 'nodes'>[]): string {
  if (e.kind === 'review') return canonical({ key:e.key, verdict:e.verdict, rank:e.rank, note:e.note ?? '', needs:e.needs,
    ack:rules ? rules.filter(r => r.seq <= (e.ack_rulings ?? -1) && (r.nodes === '*' || r.nodes.includes(e.node))).map(r => r.seq) : e.ack_rulings ?? -1 });
  if (e.kind === 'evidence') return canonical({ key:e.key, note:e.note, files:set(e.files) });
  if (e.kind === 'waive') return canonical({ key:e.key, reason:e.reason, accept_risk:set(e.accept_risk ?? []), ...(e.tracked_by !== undefined ? {tracked_by:e.tracked_by} : {}) });
  return '';
}

/** Text-only runs, consecutive in each principal/node/candidate/obligation stream. A,B,A stays three runs. */
export function actRuns(entries: readonly Entry[], rules?: readonly Pick<RuleEntry, 'seq' | 'nodes'>[]): Map<number, { entry: Entry; count: number }> {
  const latest = new Map<string, { entry: Entry; count: number }>(), out = new Map<number, { entry: Entry; count: number }>();
  const epochs = new Map<string, number>();
  for (const e of entries) {
    if (e.kind === 'submit' || e.kind === 'dispatch' || e.kind === 'rebase') epochs.set(e.node,e.seq);
    const scope = actScope(e);
    if (scope === undefined) continue;
    const key = `${scope}:${epochs.get('node' in e ? e.node : '') ?? -1}`, prior = latest.get(key);
    const run = prior && actContent(prior.entry,rules) === actContent(e,rules) ? prior : { entry:e, count:0 };
    run.entry = e; run.count++; latest.set(key,run); out.set(e.seq,run);
  }
  return out;
}

export function collapsedActLines(entries: readonly Entry[], render: (e: Entry) => string, runs = actRuns(entries)): string[] {
  const shown = new Set<object>(), counts = new Map<object, number>();
  for (const e of entries) { const run = runs.get(e.seq); if (run) counts.set(run,(counts.get(run) ?? 0)+1); }
  return entries.flatMap(e => {
    const run = runs.get(e.seq);
    if (!run) return [render(e)];
    if (shown.has(run)) return [];
    shown.add(run);
    // Count only the entries present in this view/window.
    const count = counts.get(run)!;
    return [`${render(e)}${count > 1 ? ` ×${count}` : ''}`];
  });
}
