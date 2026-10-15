// SW: advisory trunk sweeps. Lease -> sweep operation lock -> short ledger append lock;
// measurements never hold the ledger lock and never write observations or escapes.
import { canonical, sha256 } from './canon.ts';
import { Ledger, lockActivityText } from './ledger.ts';
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
type SweepDraft = Extract<Draft, { kind: 'sweep' }>;
/** Independent of acceptance keys and lease acquisition; older unkeyed greens need remeasurement. */
export const sweepDefinitionKey = (plan: Plan): string => sha256(canonical({ sweep:plan.sweep, setup:plan.setup, exec:plan.exec }));

export async function sweep(o: LeaseOptions & { commit?: string; once?: boolean; onCommit?():void }): Promise<SweepResult> {
  let recorded:SweepResult | undefined;
  try {
    const initial = await readState(o);
    if (initial.state.seq < 0) throw new OwedError('Not initialized: run owed init <plan.yaml> first');
    if (!initial.state.plan.sweep) throw new OwedError('plan has no sweep configured');
    const leaseAbort=new AbortController(); let running=false;
    const cancelWait=()=>{ if (!running) leaseAbort.abort(o.signal?.reason); };
    o.signal?.addEventListener('abort',cancelWait,{once:true}); if (o.signal?.aborted) cancelWait();
    try {
      return await withMachineLease({...o,signal:leaseAbort.signal,lease:o.lease !== false && initial.state.plan.lease !== false},signal=> {
        running=true;
        // Cancel a queued acquisition at once, but retain an acquired holder until the
        // detached check groups finish their TERM/KILL cleanup.
        return runLeased(o.signal ? AbortSignal.any([o.signal,...(signal ? [signal] : [])]) : signal);
      });
    } finally { o.signal?.removeEventListener('abort',cancelWait); }
  } catch (e) {
    // Once append has begun the measurement is complete. Cancellation cannot turn that
    // committed evidence into a preemption receipt, or erase the append.
    if (recorded) return recorded;
    if (o.signal?.aborted && o.signal.reason === 'preempted') {
      // Acquisition and every detached process have ended before the lease helper returns.
      const ledger = await Ledger.open(o.cwd);
      await ledger.withLock(async () => {
        const d: Draft = {kind:'note',by:'executor:owed',text:'sweep aborted: preempted'};
        const errors = validateDraft((await readState(o)).state,d); if (errors.length) throw new OwedError(errors.join('; '));
        await ledger.append([d]);
      });
    }
    throw e;
  }
  async function runLeased(signal?: AbortSignal): Promise<SweepResult> {
    const ledger = await Ledger.open(o.cwd);
    return ledger.withLock(async () => {
      const {state,entries} = await readState(o), spec = state.plan.sweep;
      if (!spec) throw new OwedError('plan has no sweep configured');
      const commit = await revParse(o.cwd,o.commit ?? `refs/heads/${state.trunk.name}`);
      const prior = entries.findLast((e): e is SweepEntry => e.kind === 'sweep' && e.commit === commit);
      if (o.once && prior) return leaseResult({entry:prior,steps:[],skipped:true});
      const key = sweepDefinitionKey(state.plan);
      const plan: Plan = {...state.plan,closure:[],exec:{...state.plan.exec,trees:'fresh'}};
      const drafts: SweepDraft[] = [], samples = new Map<string,SweepDraft[]>();
      let limit = Infinity;
      const budget = Symbol('measurement budget exhausted');
      const measure = async (at: string): Promise<SweepDraft> => {
        if (signal?.aborted) throw new OwedError('aborted','aborted');
        if (drafts.length >= limit || (samples.get(at)?.length ?? 0) >= 2) throw budget;
        const obs = await runJob({cwd:o.cwd,plan,ledger,signal,abortGraceMs:2000}, {
          kind:'check',subject:'trunk',obligation:'sweep',key,commit:at,base:at,
          spec:{id:'sweep',...spec,reads:spec.reads ?? ['**']},
        });
        if (signal?.aborted) throw new OwedError('aborted','aborted');
        const d: SweepDraft = {kind:'sweep',by:'executor:owed',commit:at,key,
          verdict:obs.verdict === 'pass' && (obs.counts?.fail ?? 0) > 0 ? 'fail' : obs.verdict,
          ...(obs.counts ? {counts:obs.counts as Counts} : {}),log:obs.log!,failed:obs.failed ?? [],
          ...(drafts.length ? {bisect:true} : {})};
        drafts.push(d); samples.set(at,[...(samples.get(at) ?? []),d]); return d;
      };
      // Commit the complete run atomically. A preempted head or bisect leaves no partial verdicts,
      // so the driver can retry this head at the next idle period.
      const finish = (extra: Pick<SweepResult,'first'|'note'> = {}): Promise<SweepResult> => ledger.withLock(async () => {
        const latest = (await readState(o)).state;
        for (const d of drafts) { const errors = validateDraft(latest,d); if (errors.length) throw new OwedError(errors.join('; ')); }
        if (signal?.aborted) throw new OwedError('aborted','aborted');
        o.onCommit?.();
        const written = await ledger.append(drafts) as SweepEntry[];
        recorded=leaseResult({entry:written[0]!,steps:written.slice(1),...extra});
        return recorded;
      },undefined,signal);
      const observations = (): string => [...samples].map(([at,runs]) => `${at.slice(0,12)}=${runs.map(r=>r.verdict).join('/')}`).join(', ');
      const inconsistent = (why = '') => finish({note:`inconsistent (flaky)${why ? `: ${why}` : ''}; observed verdicts: ${observations()}`});
      const head = await measure(commit);
      if (head.verdict !== 'fail') return finish();
      const repeated = await measure(commit);
      if (repeated.verdict === 'pass') return finish({note:`flaky at head; observed verdicts: ${observations()}`});
      if (repeated.verdict !== 'fail') return inconsistent();
      let green: SweepEntry | undefined;
      for (const e of [...entries].reverse()) if (e.kind === 'sweep' && e.verdict === 'pass' && e.commit !== commit && await isAncestor(o.cwd,e.commit,commit)) { green=e; break; }
      if (!green) return finish({note:'no green boundary: no green ancestor; failure reported without bisect'});
      const chain = new Set((await git(o.cwd,['rev-list','--first-parent',`${green.commit}..${commit}`])).stdout.trim().split('\n'));
      const merges = entries.filter((e): e is MergeEntry => e.kind === 'merge' && chain.has(e.commit));
      if (!merges.length) return finish({note:'no owed merge on the first-parent range'});
      limit = Math.ceil(Math.log2(merges.length))+4;
      try {
        if (green.key !== key && (await measure(green.commit)).verdict !== 'pass') {
          return finish({note:`no green boundary under current sweep definition; definition/environment change; observed verdicts: ${observations()}`});
        }
        let hi=merges.length-1, lo=-1;
        if (merges[hi]!.commit !== commit) {
          const end=await measure(merges[hi]!.commit);
          if (end.verdict !== 'fail') return finish({note:`bisect stopped: last owed merge sweep ${end.verdict}`});
        }
        while (hi-lo>1) {
          const mid=Math.floor((lo+hi)/2), step=await measure(merges[mid]!.commit);
          if (step.verdict === 'error') return finish({note:'bisect stopped on a measurement error'});
          if (step.verdict === 'pass') lo=mid; else hi=mid;
        }
        const first=merges[hi]!, predecessor=await revParse(o.cwd,`${first.commit}^1`);
        const confirm = async (at:string, verdict:'pass'|'fail'): Promise<boolean> => {
          if ((samples.get(at)?.length ?? 0)<2) await measure(at);
          return samples.get(at)!.every(r=>r.verdict === verdict);
        };
        const bad=await confirm(first.commit,'fail'), good=await confirm(predecessor,'pass');
        if (!bad || !good) return inconsistent();
        const note=`sweep ${commit.slice(0,12)} failed; first failing merge ${first.commit.slice(0,12)}; failing tests: ${head.failed.join(', ') || 'unknown'}`;
        return finish({first:{commit:first.commit,node:first.node,merge:first.seq,
          command:`owed escape ${quote(first.node)} --merge ${first.seq} --class missing --note ${quote(note)}`}});
      } catch (e) { if (e === budget) return inconsistent('confirmation budget exhausted'); throw e; }
    },'sweep',signal,{busy:owner=> `sweep already running${lockActivityText(owner)}; retry next pass`,activity:'sweep'});
  }
}
export function renderSweep(r: SweepResult): string {
  return [`Sweep #${r.entry.seq} ${r.entry.commit.slice(0, 12)}: ${r.entry.verdict}${r.skipped ? ' (already swept)' : ''}${leaseText(r)}`,
    ...(r.entry.counts ? [`Counts: ${JSON.stringify(r.entry.counts)}`] : []), `Log: ${r.entry.log}`,
    ...(r.entry.failed.length ? [`Failed: ${r.entry.failed.join(', ')}`] : []), ...(r.note ? [r.note] : []),
    ...(r.first ? [`First failing merge: ${r.first.commit} node ${r.first.node} merge #${r.first.merge}`,
      `Proposal: ${r.first.command}`, `promote ${r.entry.failed.join(', ') || 'the failing tests'} to an invariant`] : [])].join('\n');
}
