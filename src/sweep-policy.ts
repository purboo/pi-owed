import { canonical, sha256 } from './canon.ts';
import type { Entry, EscapeEntry, Plan, SweepEntry } from './types.ts';

/** Keep historical keys byte-identical; scheduling is not a measurement definition. */
export function sweepDefinitionKey(plan: Plan): string {
  const {every: _every, ...spec} = plan.sweep ?? {};
  return sha256(canonical({sweep:plan.sweep ? spec : undefined,setup:plan.setup,exec:plan.exec}));
}
export const sweepNames = (head: Pick<SweepEntry,'failed'>): string[] => [...new Set(head.failed)].sort();
export const sweepEvidence = (seq: number, head: Pick<SweepEntry,'failed'>): string => `sweep #${seq}: ${sweepNames(head).slice(0,5).join(', ') || 'unknown'}`;
/** A boundary lives on the final predecessor sample, so replay never trusts forward references. */
export function sweepHead(entries: readonly Entry[], boundary: SweepEntry): SweepEntry | undefined {
  return entries.find((e): e is SweepEntry => e.kind === 'sweep' && e.seq === boundary.boundary?.head);
}
export function sameSweepEscape(entries: readonly Entry[], merge: number, head: Pick<SweepEntry,'failed'>): boolean {
  return entries.some(e => {
    if (e.kind !== 'escape' || e.merge !== merge) return false;
    const seq = e.sweep ?? Number(/^sweep #(\d+): /.exec(e.evidence ?? '')?.[1] ?? NaN);
    const cited = entries.find((x): x is SweepEntry => x.kind === 'sweep' && x.seq === seq);
    const prior = cited?.boundary ? sweepHead(entries,cited) : cited;
    return prior !== undefined && canonical(sweepNames(prior)) === canonical(sweepNames(head));
  });
}
/** Shared by append and replay; all samples belong to one contiguous, same-definition run. */
export function sweepBoundaryErrors(entries: readonly Entry[], d: Pick<SweepEntry,'boundary'|'bisect'|'commit'|'verdict'|'key'>, plan: Plan): string[] {
  const b = d.boundary;
  if (!b || typeof b !== 'object' || Array.isArray(b) || Object.keys(b).sort().join() !== 'head,merge' || !Number.isSafeInteger(b.head) || b.head < 0 || !Number.isSafeInteger(b.merge) || b.merge < 0) return ['sweep boundary must be {head, merge} sequence numbers'];
  const head = entries.find((e): e is SweepEntry => e.kind === 'sweep' && e.seq === b.head);
  const merge = entries.find(e => e.kind === 'merge' && e.seq === b.merge);
  if (!head || head.bisect || head.verdict !== 'fail' || head.key !== d.key || d.key !== sweepDefinitionKey(plan) || merge?.kind !== 'merge' || merge.seq >= head.seq || !d.bisect || d.commit !== merge.prior || d.verdict !== 'pass') return ['sweep boundary requires a failed head and its culprit merge passing predecessor under the current definition'];
  const run = entries.filter(e => e.seq >= head.seq);
  if (run.some((e,i) => e.kind !== 'sweep' || e.key !== d.key || (i > 0 && !e.bisect) || e.boundary)) return ['sweep boundary must finish one contiguous measurement run'];
  const samples = run.filter((e): e is SweepEntry => e.kind === 'sweep');
  const bad = (commit: string): boolean => {
    const at = samples.filter(e => e.commit === commit);
    return at.length >= 2 && at.every(e => e.verdict === 'fail');
  };
  if (!bad(head.commit) || !bad(merge.commit) || samples.some(e => e.commit === merge.prior && e.verdict !== 'pass')) return ['sweep boundary requires confirmed head/culprit failures and a passing predecessor'];
  return [];
}
export function executorEscapeErrors(entries: readonly Entry[], d: Pick<EscapeEntry,'by'|'sweep'|'merge'|'class'|'evidence'>): string[] {
  if (d.by !== 'executor:owed') return ['automatic escape may only be written by executor:owed'];
  const cited = entries.find((e): e is SweepEntry => e.kind === 'sweep' && e.seq === d.sweep);
  const head = cited && sweepHead(entries,cited);
  if (!Number.isSafeInteger(d.sweep) || !cited?.boundary || cited.boundary.merge !== d.merge || !head || d.class !== 'missing' || d.evidence !== sweepEvidence(cited.seq,head)) return ['executor escape must cite a confirmed sweep boundary naming this merge and its failed names'];
  if (sameSweepEscape(entries,d.merge,head)) return ['duplicate escape for this merge and sorted failed names'];
  return [];
}
