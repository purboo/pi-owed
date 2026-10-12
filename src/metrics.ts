import { canonical } from './canon.ts';
import { OwedError } from './errors.ts';
import type { Entry, HaltEntry, Plan } from './types.ts';

export interface MetricsWindow { since?: number | string; until?: number | string }
export interface DurationMetrics { samples: number; median: number | null; p90: number | null; max: number | null }
export interface HaltMetric {
  seq: number; node: string; attempt: number; reason: string; normalizedReason: string;
  class: 'decision' | 'no-decision'; endedBy: number | null; decisionSeqs: number[];
}
export interface MergedMetric {
  node: string; attempt: number; seq: number; submitToMergeMs: number | null; dispatchToMergeMs: number | null;
  firstPass: boolean; repairs: number; repairsByAttempt: { attempt: number; submits: number; repairs: number }[];
}
export interface Metrics {
  since: number | string; until: number | string | null; mergedNodes: number; merged: MergedMetric[];
  interruptions: { total: number; halts: number; answers: number; perMergedNode: number | null };
  halts: HaltMetric[];
  haltReasons: Record<'decision' | 'no-decision', { reason: string; count: number }[]>;
  submitToMergeMs: DurationMetrics; dispatchToMergeMs: DurationMetrics;
  firstPassAcceptance: { nodes: number; rate: number | null };
  repairs: { total: number; perMergedNode: number | null };
}

/** Bounds follow report: since exclusive, until inclusive. Numeric strings are CLI seqs. */
export function metricsBound(value: number | string | undefined, name: 'since' | 'until'): number | string | undefined {
  if (value === undefined) return value;
  if (typeof value === 'string' && /^\d+$/.test(value)) value = Number(value);
  if (typeof value === 'number' ? !Number.isSafeInteger(value) || value < -1 : !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw new OwedError(`${name} must be a seq or ISO timestamp`, 'usage');
  }
  return value;
}
const atBound = (e: Entry, bound: number | string): number => typeof bound === 'number' ? e.seq - bound : Date.parse(e.ts) - Date.parse(bound);
const ratio = (n: number, d: number): number | null => d ? n / d : null;
function durations(values: (number | null)[]): DurationMetrics {
  const xs = values.filter((v): v is number => v !== null).sort((a,b) => a-b), n = xs.length;
  return { samples: n, median: n ? (xs[Math.floor((n-1)/2)]! + xs[Math.floor(n/2)]!) / 2 : null,
    p90: n ? xs[Math.ceil(n*.9)-1]! : null, max: n ? xs[n-1]! : null };
}
const elapsed = (start: Entry | undefined, end: Entry): number | null => {
  const ms = start ? Date.parse(end.ts)-Date.parse(start.ts) : NaN;
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
};
const parentAct = (e: Entry): boolean => e.by !== 'parent:drive' && /^(parent|owner):/.test(e.by);
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** MT: pure ledger computation; plans are the recorded blobs, never current Git or dsa state. */
export function computeMetrics(entries: readonly Entry[], plans: ReadonlyMap<string, Plan>, window: MetricsWindow = {}): Metrics {
  const since = metricsBound(window.since,'since') ?? -1, until = metricsBound(window.until,'until');
  if (until !== undefined && typeof since === typeof until && (typeof since === 'number' ? since > (until as number) : Date.parse(since) > Date.parse(until as string))) {
    throw new OwedError('since must not be later than until', 'usage');
  }
  const history = entries.filter(e => until === undefined || atBound(e,until) <= 0);
  const included = (e: Entry): boolean => atBound(e,since) > 0;
  const nodeIds = new Set<string>();
  for (const e of history) {
    if ('node' in e) nodeIds.add(e.node);
    if (e.kind === 'genesis' || e.kind === 'plan') for (const n of plans.get(e.plan)?.nodes ?? []) nodeIds.add(n.id);
  }
  const ids = [...nodeIds].sort((a,b) => b.length-a.length).map(escapeRegex);
  const idPattern = ids.length ? new RegExp(`(?<![\\w.-])(?:${ids.join('|')})(?![\\w.-])`, 'g') : undefined;
  const normalize = (reason: string): string => {
    let text = reason.replace(/owed:[\w:.-]+|\b[0-9a-f]{7,64}\b/gi,'<id>')
      .replace(/\b(rid|qid|key|commit|run)\s+[\w:.-]+/gi,'$1 <id>');
    if (idPattern) text = text.replace(idPattern,'<id>');
    return text.replace(/\d+/g,'<n>').replace(/\s+/g,' ').trim();
  };
  interface Attempt { firstSubmit?: Entry; submits: number; blocked: boolean }
  const attempts = new Map<string, Map<number, Attempt>>(), current = new Map<string, number>(), dispatches = new Map<string, Entry>();
  const attemptOf = (node: string, attempt: number): Attempt => {
    let ns = attempts.get(node); if (!ns) { ns = new Map(); attempts.set(node,ns); }
    let a = ns.get(attempt); if (!a) { a = { submits:0, blocked:false }; ns.set(attempt,a); } return a;
  };
  const active = new Map<string,HaltMetric>(), halts: HaltMetric[] = [], merged: MergedMetric[] = [];
  let planSpecs = new Map<string,string>(), answers = 0;
  const endHalt = (node: string, seq: number): void => { const h = active.get(node); if (h) { h.endedBy = seq; active.delete(node); } };
  const decision = (node: string, seq: number): void => { const h = active.get(node); if (h) { h.class = 'decision'; h.decisionSeqs.push(seq); } };
  const addHalt = (e: HaltEntry): void => {
    endHalt(e.node,e.seq);
    const h: HaltMetric = { seq:e.seq,node:e.node,attempt:e.attempt,reason:e.reason,normalizedReason:normalize(e.reason),class:'no-decision',endedBy:null,decisionSeqs:[] };
    active.set(e.node,h); if (included(e)) halts.push(h);
  };
  for (const e of history) {
    if (e.kind === 'genesis' || e.kind === 'plan') {
      const p = plans.get(e.plan); if (!p) throw new OwedError(`Missing plan ${e.plan}`, 'internal');
      const next = new Map(p.nodes.map(n => [n.id,canonical(n)]));
      if (e.kind === 'plan' && parentAct(e)) for (const node of active.keys()) if (planSpecs.get(node) !== next.get(node)) decision(node,e.seq);
      planSpecs = next;
    }
    if (parentAct(e)) {
      if (e.kind === 'rule') {
        for (const node of e.nodes === '*' ? active.keys() : e.nodes) decision(node,e.seq);
        if (e.answer && included(e)) answers++;
      } else if ('node' in e && (['waive','defer','abandon','hold','evidence'].includes(e.kind) || e.kind === 'review' && e.by.startsWith('owner:'))) decision(e.node,e.seq);
    }
    if (e.kind === 'halt') { endHalt(e.node,e.seq); if (e.by === 'parent:drive') addHalt(e); }
    if ('node' in e && ['resume','submit','merge','abandon'].includes(e.kind)) endHalt(e.node,e.seq);
    if (e.kind === 'dispatch') {
      current.set(e.node,e.attempt); attemptOf(e.node,e.attempt);
      if (!dispatches.has(e.node)) dispatches.set(e.node,e);
    } else if (e.kind === 'submit') {
      current.set(e.node,e.attempt);
      const a = attemptOf(e.node,e.attempt);
      // A carried candidate is not a repair and must not restart the attempt's clock.
      a.firstSubmit ??= e;
      if (e.by.startsWith('writer:') && e.carry === undefined) a.submits++;
    } else if (e.kind === 'review' && e.verdict === 'block') {
      attemptOf(e.node,e.attempt).blocked = true;
    } else if (e.kind === 'obs' && e.verdict === 'fail' && !e.attribution && e.probe === undefined && e.by === 'executor:owed') {
      const a = current.get(e.subject); if (a !== undefined && attemptOf(e.subject,a).firstSubmit) attemptOf(e.subject,a).blocked = true;
    } else if (e.kind === 'merge') {
      if (included(e)) {
        const a = attemptOf(e.node,e.attempt), repairsByAttempt = [...attempts.get(e.node)!].sort(([a],[b]) => a-b)
          .map(([attempt,v]) => ({ attempt,submits:v.submits,repairs:Math.max(v.submits-1,0) }));
        merged.push({ node:e.node,attempt:e.attempt,seq:e.seq,submitToMergeMs:elapsed(a.firstSubmit,e),dispatchToMergeMs:elapsed(dispatches.get(e.node),e),
          firstPass:e.attempt === 1 && !a.blocked,repairs:repairsByAttempt.reduce((sum,v) => sum+v.repairs,0),repairsByAttempt });
      }
      current.delete(e.node);
    } else if (e.kind === 'abandon') current.delete(e.node);
  }
  const top = (cls: HaltMetric['class']): {reason:string;count:number}[] => {
    const reasons = new Map<string,number>();
    for (const h of halts) if (h.class === cls) reasons.set(h.normalizedReason,(reasons.get(h.normalizedReason) ?? 0)+1);
    return [...reasons].map(([reason,count]) => ({reason,count})).sort((a,b) => b.count-a.count || a.reason.localeCompare(b.reason)).slice(0,5);
  };
  const firstPass = merged.filter(m => m.firstPass).length, repairs = merged.reduce((sum,m) => sum+m.repairs,0), n = merged.length;
  return { since,until:until ?? null,mergedNodes:n,merged,
    interruptions:{total:halts.length+answers,halts:halts.length,answers,perMergedNode:ratio(halts.length+answers,n)},halts,
    haltReasons:{decision:top('decision'),'no-decision':top('no-decision')},
    submitToMergeMs:durations(merged.map(m => m.submitToMergeMs)),dispatchToMergeMs:durations(merged.map(m => m.dispatchToMergeMs)),
    firstPassAcceptance:{nodes:firstPass,rate:ratio(firstPass,n)},repairs:{total:repairs,perMergedNode:ratio(repairs,n)} };
}

/** A single short block; JSON keeps full timestamps, counts and halt classifications. */
export function renderMetrics(m: Metrics): string {
  const number = (v: number | null): string => v === null ? 'n/a' : String(Math.round(v*1000)/1000);
  const time = (v: number | null): string => v === null ? 'n/a' : `${number(v/1000)}s`;
  const summary = (d: DurationMetrics, max: boolean): string => `median ${time(d.median)}, p90 ${time(d.p90)}${max ? `, max ${time(d.max)}` : ''} (${d.samples} samples)`;
  return [`Metrics (since ${m.since === -1 ? 'start' : m.since}, until ${m.until ?? 'latest'})`,
    `Merged nodes: ${m.mergedNodes}`,
    `Interruptions: ${m.interruptions.total} (${m.interruptions.halts} halts, ${m.interruptions.answers} answers); per merged node ${number(m.interruptions.perMergedNode)}`,
    `Submit to merge: ${summary(m.submitToMergeMs,true)}`,`First dispatch to merge: ${summary(m.dispatchToMergeMs,false)}`,
    `First-pass acceptance: ${m.firstPassAcceptance.nodes}/${m.mergedNodes} (${m.firstPassAcceptance.rate === null ? 'n/a' : `${number(m.firstPassAcceptance.rate*100)}%`})`,
    `Repairs: ${m.repairs.total}; per merged node ${number(m.repairs.perMergedNode)}`,
    ...(['decision','no-decision'] as const).flatMap(cls => [`Halts (${cls}): ${m.halts.filter(h => h.class === cls).length}`,
      ...m.haltReasons[cls].map(r => `  ${r.count} × ${r.reason.slice(0,160)}`)])].join('\n');
}
