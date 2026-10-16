import { metricsBound } from './metrics.ts';
import { matchesAny } from './plan.ts';
import { changedPaths } from './git.ts';
import type { CheckSpec, Entry, ObsEntry, Plan } from './types.ts';

export interface CostRow {
  id: string; runs: number; durationMs: { total: number; median: number | null; p90: number | null };
  failures: number; setupFailures: number; lease_wait_ms: number;
  merges?: { measured: number; total: number };
  invalidatingPrefixes?: { prefix: string; runs: number }[];
  measuredTrunkKeys?: number;
}
export interface CostReport { since: number | string; obligations: CostRow[]; advice: string | null }
const includedAfter = (e: Entry, since: number | string): boolean => typeof since === 'number' ? e.seq > since : Date.parse(e.ts) > Date.parse(since);
const specs = (p: Plan): Map<string, CheckSpec> => new Map([...p.nodes.flatMap(n => n.checks.map(c => [`${n.id}\0check:${c.id}`, c] as const)), ...p.invariants.map(c => [`inv:${c.id}`, c] as const)]);

/** Diagnostic IF definition, including counted history; never alters evidence or replay. */
function setupFailure(e: ObsEntry, spec: CheckSpec | undefined, counted: ReadonlySet<string>): boolean {
  return e.by === 'executor:owed' && e.verdict === 'fail' && !(e.counts?.tests ?? 0) && !e.failed?.length && !e.counts?.failed?.length
    && ![124, 137, 143].includes(e.exit ?? 0) && !/timeout|timed out/i.test(e.note ?? '')
    && !e.runs?.some(r => r.verdict === 'error' || /timeout|timed out/i.test(r.note ?? '') || [124, 137, 143].includes(r.exit ?? 0))
    && (spec?.min_tests !== undefined || !!e.counts?.format || counted.has(e.obligation));
}
/** A successful merge's measurements become trunk samples; refused merge trees never do. */
export function measuredTrunkPasses(entries: readonly Entry[]): ObsEntry[] {
  const landed = new Set(entries.flatMap(e => e.kind === 'merge' ? [e.batch?.final ?? e.commit] : e.kind === 'adopt' ? [e.commit] : []));
  return entries.filter((e): e is ObsEntry => e.kind === 'obs' && e.subject === 'trunk' && e.by === 'executor:owed' && e.verdict === 'pass'
    && (!(e.merging || e.batch) || landed.has(e.commit)));
}
export function nearTimeoutWarnings(plan: Plan, entries: readonly Entry[]): string[] {
  const passes = measuredTrunkPasses(entries);
  return plan.invariants.flatMap(inv => {
    const last = passes.findLast(e => e.obligation === `inv:${inv.id}`);
    return last && last.durationMs >= inv.timeout_s * 800 ? [`inv:${inv.id} took ${seconds(last.durationMs)} of timeout ${seconds(inv.timeout_s * 1000)}; an automatic remeasure doubles a merge's wall time`] : [];
  });
}

/** CO1: all machine observations, but path attribution only between keys actually measured on trunk. */
export async function costReport(cwd: string, entries: readonly Entry[], lookup: (sha: string) => Plan, sinceArg?: number | string): Promise<CostReport> {
  const since = metricsBound(sinceArg, 'since') ?? -1, included = (e: Entry) => includedAfter(e, since);
  const rows = new Map<string, CostRow>(), definitions = new Map<string, CheckSpec>(), samples = new Map<string, number[]>();
  const counted = new Set(entries.flatMap(e => e.kind === 'obs' && ((e.counts?.tests ?? 0) > 0 || e.counts?.format) ? [e.obligation] : []));
  const merges = entries.filter((e): e is Extract<Entry, {kind: 'merge'}> => e.kind === 'merge'), recentMerges = merges.filter(included);
  const landed = new Set(merges.map(e => e.batch?.final ?? e.commit));
  for (const e of entries) if (e.kind === 'adopt') landed.add(e.commit);
  const measured = new Map<string, Set<number>>(), previous = new Map<string, ObsEntry>(), prefixCounts = new Map<string, Map<string, number>>();
  const diffs = new Map<string, string[]>();
  const rowOf = (id: string): CostRow => {
    let row = rows.get(id);
    if (!row) { row = {id, runs: 0, durationMs: {total: 0, median: null, p90: null}, failures: 0, setupFailures: 0, lease_wait_ms: 0}; rows.set(id, row); }
    return row;
  };
  for (const e of entries) {
    if (e.kind === 'genesis' || e.kind === 'plan') {
      definitions.clear(); for (const [id, spec] of specs(lookup(e.plan))) { definitions.set(id, spec); rowOf(id.split('\0').at(-1)!); }
    }
    if (e.kind !== 'obs' || !/^(inv|check):/.test(e.obligation)) continue;
    const id = e.obligation, row = rowOf(id), spec = definitions.get(id.startsWith('inv:') ? id : `${e.subject}\0${id}`);
    if (included(e)) {
      row.runs++; row.durationMs.total += e.durationMs; row.lease_wait_ms += e.lease_wait_ms ?? 0;
      const xs = samples.get(id) ?? []; xs.push(e.durationMs); samples.set(id, xs);
      if (e.verdict === 'fail' || e.verdict === 'error') { if (setupFailure(e, spec, counted)) row.setupFailures++; else row.failures++; }
      if (id.startsWith('inv:')) {
        const set = measured.get(id) ?? new Set<number>(); measured.set(id, set);
        for (const m of recentMerges) if (m.seq > e.seq && m.state.invKeys[id.slice(4)] === e.key &&
          (e.merging === m.node && e.commit === m.commit || e.batch?.includes(m.node) && e.commit === m.batch?.final)) set.add(m.seq);
      }
    }
    if (!id.startsWith('inv:') || e.subject !== 'trunk' || e.by !== 'executor:owed' || (e.merging || e.batch) && !landed.has(e.commit)) continue;
    const prev = previous.get(id);
    if (prev?.key === e.key) continue; // same-key remeasure is cost, not another invalidation
    previous.set(id, e);
    if (!included(e)) continue;
    row.measuredTrunkKeys = (row.measuredTrunkKeys ?? 0) + 1;
    if (!prev || !spec || prev.commit === e.commit) continue;
    const pair = `${prev.commit}:${e.commit}`;
    let paths = diffs.get(pair); if (!paths) { paths = await changedPaths(cwd, prev.commit, e.commit); diffs.set(pair, paths); }
    const prefixes = new Set(paths.filter(p => matchesAny(p, spec.reads)).map(p => p.split('/').slice(0, 2).join('/')));
    const counts = prefixCounts.get(id) ?? new Map<string, number>(); prefixCounts.set(id, counts);
    for (const prefix of prefixes) counts.set(prefix, (counts.get(prefix) ?? 0) + 1);
  }
  for (const row of rows.values()) {
    const xs = (samples.get(row.id) ?? []).sort((a, b) => a - b), n = xs.length;
    row.durationMs.median = n ? (xs[Math.floor((n - 1) / 2)]! + xs[Math.floor(n / 2)]!) / 2 : null;
    row.durationMs.p90 = n ? xs[Math.ceil(n * .9) - 1]! : null;
    if (row.id.startsWith('inv:')) {
      row.merges = {measured: measured.get(row.id)?.size ?? 0, total: recentMerges.length};
      row.measuredTrunkKeys ??= 0;
      row.invalidatingPrefixes = [...(prefixCounts.get(row.id) ?? [])].map(([prefix, runs]) => ({prefix, runs})).sort((a, b) => b.runs - a.runs || a.prefix.localeCompare(b.prefix)).slice(0, 5);
    }
  }
  const obligations = [...rows.values()].sort((a, b) => b.durationMs.total - a.durationMs.total || a.id.localeCompare(b.id));
  const top = obligations.find(r => r.id.startsWith('inv:')), prefix = top?.invalidatingPrefixes?.[0];
  const advice = top && prefix && prefix.runs > (top.measuredTrunkKeys ?? 0) / 2
    ? `narrow reads of ${top.id}: ${prefix.prefix} changed its key in ${prefix.runs} of ${top.measuredTrunkKeys} runs` : null;
  return {since, obligations, advice};
}
const seconds = (ms: number): string => `${Math.round(ms) / 1000}s`;
export function renderCost(report: CostReport): string {
  return [...report.obligations.map(r => `${r.id}: ${r.runs} runs; total ${seconds(r.durationMs.total)}, median ${r.durationMs.median === null ? 'n/a' : seconds(r.durationMs.median)}, p90 ${r.durationMs.p90 === null ? 'n/a' : seconds(r.durationMs.p90)}; failures ${r.failures}, setup failures ${r.setupFailures}; lease_wait_ms ${r.lease_wait_ms}${r.merges ? `; measured on ${r.merges.measured} of ${r.merges.total} merges; invalidating prefixes: ${r.invalidatingPrefixes?.map(p => `${p.prefix} (${p.runs})`).join(', ') || 'none'}` : ''}`), ...(report.advice ? [report.advice] : [])].join('\n');
}
