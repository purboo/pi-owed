// SW: advisory trunk sweeps. Lease -> sweep operation lock -> short ledger append lock;
// measurements never hold the ledger lock and never write observations or escapes.
import { Ledger } from './ledger.ts';
import { readState } from './ops.ts';
import { git, revParse, isAncestor } from './git.ts';
import { runJob } from './exec.ts';
import { withMachineLease, leaseResult, leaseText } from './lease.ts';
import type { LeaseOptions } from './lease.ts';
import { matchesAny } from './plan.ts';
import { validateDraft } from './reducer.ts';
import { OwedError } from './errors.ts';
import type { Counts, Draft, Entry, MergeEntry, Plan, SweepEntry } from './types.ts';

export interface SweepResult {
  entry: SweepEntry; steps: SweepEntry[]; lease?: string; skipped?: boolean;
  first?: { commit: string; node: string; merge: number; command: string };
  note?: string;
}
/** Root files stay literal; directory globs subsumed by a shorter changed directory are dropped. */
export function unguardedPaths(plan: Plan, changed: string[]): string[] {
  const reads = plan.invariants.flatMap(i => i.reads);
  const dirs = [...new Set(changed.filter(p => !matchesAny(p, reads)).map(p => {
    const slash = p.lastIndexOf('/'); return slash < 0 ? p : `${p.slice(0, slash)}/**`;
  }))].sort();
  return dirs.filter(p => !dirs.some(q => q !== p && q.endsWith('/**') && p.startsWith(q.slice(0, -2))));
}
export const unguardedText = (paths: string[]): string => `Unguarded paths: ${paths.join(', ') || 'none'}`;
/** Coverage at each merge uses its recorded plan, rather than retroactive coverage from today's plan. */
export function mergeCoverage(entries: Entry[], lookup: (sha: string) => Plan): Map<number, string[]> {
  const out = new Map<number, string[]>(); let plan: Plan | undefined;
  for (const e of entries) {
    if (e.kind === 'plan' || e.kind === 'genesis') plan = lookup(e.plan);
    else if (e.kind === 'merge' && plan) out.set(e.seq, unguardedPaths(plan, e.facts.changed));
  }
  return out;
}
const quote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;
/** Names are capped; counts parsing is shared with checks, including the counts protocol when available. */
function failingNames(log: string): string[] {
  const names: string[] = []; let owed: string[] | undefined;
  for (const line of log.split(/\r?\n/)) {
    const m = /^\s*not ok \d+\s*-?\s*(.+)$/.exec(line) ?? /^test (.+) \.\.\. FAILED\s*$/.exec(line);
    if (m) names.push(m[1]!.replace(/\s+# (?:TODO|SKIP).*$/i, ''));
    const protocol = /^\s*owed-counts\s+(.*)$/.exec(line);
    if (protocol) try {
      const v = JSON.parse(protocol[1]!);
      if (v && Number.isInteger(v.pass) && v.pass >= 0 && Number.isInteger(v.fail) && v.fail >= 0 && (v.failed === undefined || Array.isArray(v.failed) && v.failed.every((x: unknown) => typeof x === 'string'))) owed = v.failed ?? [];
    } catch { /* malformed counts line */ }
  }
  return [...new Set(owed ?? names)].slice(0, 50);
}

export async function sweep(o: LeaseOptions & { commit?: string; once?: boolean }): Promise<SweepResult> {
  const initial = await readState(o);
  if (initial.state.seq < 0) throw new OwedError('Not initialized: run owed init <plan.yaml> first');
  if (!initial.state.plan.sweep) throw new OwedError('plan has no sweep configured');
  return withMachineLease({ ...o, lease: o.lease !== false && initial.state.plan.lease !== false }, signal => leaseResultPromise(signal));
  async function leaseResultPromise(signal?: AbortSignal): Promise<SweepResult> {
    const ledger = await Ledger.open(o.cwd);
    return ledger.withLock(async () => {
      const { state, entries } = await readState(o), spec = state.plan.sweep;
      if (!spec) throw new OwedError('plan has no sweep configured');
      const commit = await revParse(o.cwd, o.commit ?? `refs/heads/${state.trunk.name}`);
      const prior = entries.findLast((e): e is SweepEntry => e.kind === 'sweep' && e.commit === commit);
      if (o.once && prior) return leaseResult({ entry: prior, steps: [], skipped: true });
      // Always materialize the exact detached tree; closure overlays/reuse are check policies, not sweep policies.
      const plan: Plan = { ...state.plan, closure: [], exec: { ...state.plan.exec, trees: 'fresh' } };
      const measure = async (at: string, bisect = false): Promise<SweepEntry> => {
        if (signal?.aborted) throw new OwedError('aborted', 'aborted');
        const obs = await runJob({ cwd: o.cwd, plan, ledger, signal }, {
          kind: 'check', subject: 'trunk', obligation: 'sweep', key: 'sweep', commit: at, base: at,
          spec: { id: 'sweep', ...spec, reads: spec.reads ?? ['**'] },
        });
        if (signal?.aborted) throw new OwedError('aborted', 'aborted');
        const log = (await ledger.getBlob(obs.log!)).toString();
        const d: Extract<Draft, { kind: 'sweep' }> = { kind: 'sweep', by: 'executor:owed', commit: at,
          verdict: obs.verdict === 'pass' && (obs.counts?.fail ?? 0) > 0 ? 'fail' : obs.verdict,
          ...(obs.counts ? { counts: obs.counts as Counts } : {}), log: obs.log!, failed: failingNames(log), ...(bisect ? { bisect: true } : {}) };
        return ledger.withLock(async () => {
          const latest = await readState(o);
          const errors = validateDraft(latest.state, d); if (errors.length) throw new OwedError(errors.join('; '));
          // Stale async results remain evidence about their pinned commit, never a verdict on current trunk.
          if (signal?.aborted) throw new OwedError('aborted', 'aborted');
          return (await ledger.append([d]))[0] as SweepEntry;
        }, undefined, signal);
      };
      const entry = await measure(commit), result: SweepResult = { entry, steps: [] };
      if (entry.verdict !== 'fail') return leaseResult(result);
      let green: SweepEntry | undefined;
      for (const e of [...entries].reverse()) if (e.kind === 'sweep' && e.verdict === 'pass' && e.commit !== commit && await isAncestor(o.cwd, e.commit, commit)) { green = e; break; }
      if (!green) return leaseResult({ ...result, note: 'no green ancestor; failure reported without bisect' });
      const chain = new Set((await git(o.cwd, ['rev-list', '--first-parent', `${green.commit}..${commit}`])).stdout.trim().split('\n'));
      const merges = entries.filter((e): e is MergeEntry => e.kind === 'merge' && chain.has(e.commit));
      if (!merges.length) return leaseResult({ ...result, note: 'no owed merge on the first-parent range' });
      // If the failing tip was adopted, first establish whether the last owed merge already failed.
      let hi = merges.length - 1, lo = -1;
      if (merges[hi]!.commit !== commit) {
        const end = await measure(merges[hi]!.commit, true); result.steps.push(end);
        if (end.verdict !== 'fail') return leaseResult({ ...result, note: `bisect stopped: last owed merge sweep ${end.verdict}` });
      }
      while (hi - lo > 1) {
        const mid = Math.floor((lo + hi) / 2), step = await measure(merges[mid]!.commit, true); result.steps.push(step);
        if (step.verdict === 'error') return leaseResult({ ...result, note: 'bisect stopped on a measurement error' });
        if (step.verdict === 'pass') lo = mid; else hi = mid;
      }
      const first = merges[hi]!;
      const note = `sweep ${commit.slice(0, 12)} failed; first failing merge ${first.commit.slice(0, 12)}; failing tests: ${entry.failed.join(', ') || 'unknown'}`;
      result.first = { commit: first.commit, node: first.node, merge: first.seq,
        command: `owed escape ${quote(first.node)} --merge ${first.seq} --class missing --note ${quote(note)}` };
      return leaseResult(result);
    }, 'sweep', signal, { busy: () => 'sweep already running; retry next pass' });
  }
}
export function renderSweep(r: SweepResult): string {
  return [`Sweep #${r.entry.seq} ${r.entry.commit.slice(0, 12)}: ${r.entry.verdict}${r.skipped ? ' (already swept)' : ''}${leaseText(r)}`,
    ...(r.entry.counts ? [`Counts: ${JSON.stringify(r.entry.counts)}`] : []), `Log: ${r.entry.log}`,
    ...(r.entry.failed.length ? [`Failed: ${r.entry.failed.join(', ')}`] : []), ...(r.note ? [r.note] : []),
    ...(r.first ? [`First failing merge: ${r.first.commit} node ${r.first.node} merge #${r.first.merge}`,
      `Proposal: ${r.first.command}`, `promote ${r.entry.failed.join(', ') || 'the failing tests'} to an invariant`] : [])].join('\n');
}
