import { withWritesSyntax, writesSyntax } from './writes.ts';
import { canonical } from './canon.ts';
import { OwedError } from './errors.ts';
import { planDowngrades } from './plan.ts';
import { uncoveredDowngrades } from './reducer.ts';
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
export type ParentActClass = 'writes' | 'answer' | 'trunk' | 'resume' | 'rule' | 'plan' | 'review' | 'waive' | 'defer' | 'evidence' | 'abandon' | 'approve' | 'other';
const parentActClasses: readonly ParentActClass[] = ['writes','answer','trunk','resume','rule','plan','review','waive','defer','evidence','abandon','approve','other'];
export interface Metrics {
  parentActs: { total: number; perMergedNode: number | null; byClass: Record<ParentActClass, number>; byNode: Record<string, number>; perMergedNodeAttributed: number | null; pending: number; unattributed: number };
  grants: { total: number; perMergedNode: number | null };
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
  if (typeof value === 'number' ? !Number.isSafeInteger(value) || value < -1 : !/^\d{4}-\d{2}-\d{2}(?:$|T)/.test(value) || !Number.isFinite(Date.parse(value))) {
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
/** PA: compare recorded laws, ignoring allowance coverage only while detecting downgrades. */
function writesOnlyDowngrades(prev: Plan, next: Plan): boolean {
  const ds = [...planDowngrades(prev,next), ...uncoveredDowngrades(withWritesSyntax({...prev,allow:[]},writesSyntax(prev)),withWritesSyntax({...next,allow:[]},writesSyntax(next)))];
  return ds.length > 0 && ds.every(d => d.what === 'writes widened' || d.what === 'writes scope expanded');
}
function knownRedOnly(prev: Plan, next: Plan): boolean {
  const without = (p: Plan): string => canonical({...p,invariants:p.invariants.map(({known_red: _knownRed,...inv}) => inv)});
  return canonical(prev) !== canonical(next) && without(prev) === without(next);
}
function parentActClass(e: Entry, prev: Plan | undefined, next: Plan | undefined, lastHalts: ReadonlyMap<string,string>): ParentActClass {
  if (e.kind === 'plan') {
    if (prev && next && writesOnlyDowngrades(prev,next)) return 'writes';
    return prev && next && knownRedOnly(prev,next) ? 'trunk' : 'plan';
  }
  // ops.amend already writes this marker; ordinary prose mentioning writes does not qualify.
  if (e.kind === 'rule') return /^writes of .+ widened by plan #\d+: .+\. Limit: /.test(e.text) ? 'writes' : e.answer ? 'answer' : 'rule';
  if (e.kind === 'adopt' || e.kind === 'resume' && lastHalts.get(e.node)?.startsWith('merge refused: trunk-red')) return 'trunk';
  if (e.kind === 'review') return e.by.startsWith('owner:') ? 'review' : 'other';
  const kind: string = e.kind;
  return ['resume','waive','defer','evidence','abandon','approve'].includes(kind) ? kind as ParentActClass : 'other';
}
const escapeRegex = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** NT2: word-shaped node ids must not erase verbs or ordinary prose. */
function haltNormalizer(nodeIds: ReadonlySet<string>): (reason: string) => string {
  const ids = [...nodeIds].sort((a,b) => b.length-a.length).map(escapeRegex);
  const pattern = ids.length ? new RegExp(`(?<![\\w.-])(?:${ids.join('|')})(?![\\w.-])`, 'g') : undefined;
  return reason => {
    let text = reason.replace(/owed:[\w:.-]+|\b[0-9a-f]{7,64}\b/gi,'<id>')
      .replace(/\b(rid|qid|key|commit|run)\s+[\w:.-]+/gi,'$1 <id>');
    if (pattern) text = text.replace(pattern,(id: string, offset: number, source: string) => {
      if (!/^[a-z]+$/.test(id)) return '<id>';
      const before = source.slice(0,offset), after = source.slice(offset+id.length);
      return offset === 0 && after.startsWith(':') || after.startsWith('/') || /(?:\bnode |--after |\bowed [\w-]+ )$/.test(before) ? '<id>' : id;
    });
    return text.replace(/\d+/g,'<n>').replace(/\s+/g,' ').trim();
  };
}

/** PO3: explicit node targets, including changed/added/removed plan nodes. */
function actNodes(e: Entry, prev?: Plan, next?: Plan): string[] {
  if ('node' in e) return [e.node];
  if (e.kind === 'rule') return e.nodes === '*' ? [] : [...new Set(e.nodes)];
  if (e.kind === 'plan' && prev && next) return [...new Set([...prev.nodes,...next.nodes].map(n => n.id))].filter(id => canonical(prev.nodes.find(n => n.id === id)) !== canonical(next.nodes.find(n => n.id === id)));
  return [];
}

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
  const normalize = haltNormalizer(nodeIds);
  interface Attempt { firstSubmit?: Entry; submits: number; blocked: boolean }
  const attempts = new Map<string, Map<number, Attempt>>(), current = new Map<string, number>(), dispatches = new Map<string, Entry>();
  const attemptOf = (node: string, attempt: number): Attempt => {
    let ns = attempts.get(node); if (!ns) { ns = new Map(); attempts.set(node,ns); }
    let a = ns.get(attempt); if (!a) { a = { submits:0, blocked:false }; ns.set(attempt,a); } return a;
  };
  const active = new Map<string,HaltMetric>(), halts: HaltMetric[] = [], merged: MergedMetric[] = [];
  let planSpecs = new Map<string,string>(), answers = 0, previousPlan: Plan | undefined, parentActsTotal = 0, grantsTotal = 0;
  const byClass = Object.fromEntries(parentActClasses.map(cls => [cls,0])) as Record<ParentActClass,number>;
  const byNode: Record<string,number> = {}, countedBatches = new Set<number>();
  let unattributed = 0;
  const batchNodes = new Map<number,string[]>();
  for (const e of history) if (e.kind === 'resume' && e.batch !== undefined) {
    const nodes = batchNodes.get(e.batch) ?? []; if (!nodes.includes(e.node)) nodes.push(e.node); batchNodes.set(e.batch,nodes);
  }
  const lastHalts = new Map<string,string>();
  const endHalt = (node: string, seq: number): void => { const h = active.get(node); if (h) { h.endedBy = seq; active.delete(node); } };
  const decision = (node: string, seq: number): void => { const h = active.get(node); if (h) { h.class = 'decision'; h.decisionSeqs.push(seq); } };
  const addHalt = (e: HaltEntry): void => {
    endHalt(e.node,e.seq);
    const h: HaltMetric = { seq:e.seq,node:e.node,attempt:e.attempt,reason:e.reason,normalizedReason:normalize(e.reason),class:'no-decision',endedBy:null,decisionSeqs:[] };
    active.set(e.node,h); if (included(e)) halts.push(h);
  };
  for (const e of history) {
    const rawPlan = e.kind === 'genesis' || e.kind === 'plan' ? plans.get(e.plan) : undefined;
    const nextPlan = rawPlan && (e.kind === 'genesis' || e.kind === 'plan') ? withWritesSyntax(rawPlan,e.writes_syntax ?? 1) : undefined;
    if (included(e)) {
      if (parentAct(e) && !['dispatch','launch','send'].includes(e.kind)) {
        const batch = e.kind === 'resume' ? e.batch : undefined;
        if (batch === undefined || !countedBatches.has(batch)) {
          if (batch !== undefined) countedBatches.add(batch);
          parentActsTotal++; byClass[parentActClass(e,previousPlan,nextPlan,lastHalts)]++;
          const targets = batch === undefined ? actNodes(e,previousPlan,nextPlan) : batchNodes.get(batch)!;
          if (!targets.length) unattributed++;
          for (const id of targets) byNode[id] = (byNode[id] ?? 0)+1/targets.length;
        }
      }
      // GR is implemented in parallel; do not depend on its entry type being present yet.
      if ((e.kind as string) === 'grant') grantsTotal++;
    }
    if (e.kind === 'halt') lastHalts.set(e.node,e.reason);
    if (e.kind === 'genesis' || e.kind === 'plan') {
      const p = nextPlan; if (!p) throw new OwedError(`Missing plan ${e.plan}`, 'internal');
      const next = new Map(p.nodes.map(n => [n.id,canonical(n)]));
      if (e.kind === 'plan' && parentAct(e)) for (const node of active.keys()) if (planSpecs.get(node) !== next.get(node)) decision(node,e.seq);
      planSpecs = next; previousPlan = p;
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
  const mergedIds = new Set(merged.map(m => m.node)), attributed = Object.entries(byNode).filter(([id]) => mergedIds.has(id)).reduce((sum,[,v]) => sum+v,0);
  const pending = Object.entries(byNode).filter(([id]) => !mergedIds.has(id)).reduce((sum,[,v]) => sum+v,0);
  return { since,until:until ?? null,mergedNodes:n,merged,
    parentActs:{total:parentActsTotal,perMergedNode:ratio(parentActsTotal,n),byClass,byNode,perMergedNodeAttributed:ratio(attributed,n),pending,unattributed},
    grants:{total:grantsTotal,perMergedNode:ratio(grantsTotal,n)},
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
  const classes = Object.entries(m.parentActs.byClass).filter(([,count]) => count > 0)
    .sort(([a,x],[b,y]) => y-x || a.localeCompare(b)).slice(0,5).map(([cls,count]) => `${cls} ${count}`).join(', ');
  return [`Metrics (since ${m.since === -1 ? 'start' : m.since}, until ${m.until ?? 'latest'}); merged nodes: ${m.mergedNodes}`,
    `Parent acts per merged node: ${number(m.parentActs.perMergedNode)} (${m.parentActs.total} total); top classes: ${classes || 'none'}`,
    `Attributed parent acts per merged node: ${number(m.parentActs.perMergedNodeAttributed)}; pending ${number(m.parentActs.pending)}; unattributed ${number(m.parentActs.unattributed)}`,
    `Parent acts by node: ${Object.entries(m.parentActs.byNode).sort(([a],[b]) => a.localeCompare(b)).map(([id,v]) => `${id} ${number(v)}`).join(', ') || 'none'}`,
    `Grants: ${m.grants.total}; per merged node ${number(m.grants.perMergedNode)}`,
    `Driver halts + answers per merged node (partial): ${number(m.interruptions.perMergedNode)} (${m.interruptions.total} total: ${m.interruptions.halts} halts, ${m.interruptions.answers} answers)`,
    `Halts: decision ${m.halts.filter(h => h.class === 'decision').length}, no-decision ${m.halts.filter(h => h.class === 'no-decision').length}`,
    `Submit to merge: ${summary(m.submitToMergeMs,true)}`,`First dispatch to merge: ${summary(m.dispatchToMergeMs,false)}`,
    `First-pass acceptance: ${m.firstPassAcceptance.nodes}/${m.mergedNodes} (${m.firstPassAcceptance.rate === null ? 'n/a' : `${number(m.firstPassAcceptance.rate*100)}%`})`,
    `Repairs: ${m.repairs.total}; per merged node ${number(m.repairs.perMergedNode)}`,
    ...(['decision','no-decision'] as const).flatMap(cls => m.haltReasons[cls].map(r => `  ${cls}: ${r.count} × ${r.reason.slice(0,160)}`))].join('\n');
}
