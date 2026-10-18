// SW: advisory trunk sweeps. Preparation -> machine lease at first command -> short ledger append lock;
// measurements hold no ledger lock; confirmed boundaries and escapes commit atomically.
import { AsyncLocalStorage } from 'node:async_hooks';
import type { CommandResult } from './exec.ts';
import { Ledger, lockActivityText, entryHash } from './ledger.ts';
import { readState } from './ops.ts';
import { git, revParse, isAncestor } from './git.ts';
import { runJob } from './exec.ts';
import { withMachineLease, leaseResult, leaseText } from './lease.ts';
import type { LeaseOptions } from './lease.ts';
import { matchesAny } from './plan.ts';
import { oneLine } from './views.ts';
import { sweepEscapeCommand } from './needs.ts';
import { validateDraft, extendState } from './reducer.ts';
import { sweepDefinitionKey, sameSweepEscape, sweepEvidence, sweepNames } from './sweep-policy.ts';
export { sweepDefinitionKey } from './sweep-policy.ts';
import { OwedError } from './errors.ts';
import type { Counts, Draft, Entry, EscapeEntry, MergeEntry, Plan, SweepEntry } from './types.ts';

export interface SweepResult {
  entry: SweepEntry; steps: SweepEntry[]; lease?: string; skipped?: boolean;
  first?: { commit: string; node: string; merge: number; command: string };
  note?: string;
  escape?: EscapeEntry; notice?: string;
}
export interface SweepNotDue { notDue: true; skipped: true; note: string }
export interface SweepDue { due: boolean; merges?: number; at?: number; text: string }
/** Only head entries reset the schedule; bisect samples are historical commits, not swept trunks. */
export async function sweepDue(cwd: string, plan: Plan, entries: Entry[], commit: string, now = Date.now(), startedAt = Date.parse(entries[0]?.ts ?? '') || now): Promise<SweepDue> {
  const every = plan.sweep?.every;
  if (!every) throw new OwedError('sweep --due requires sweep.every; add merges or minutes to the plan');
  let prior: SweepEntry | undefined;
  for (const e of [...entries].reverse()) if (e.kind === 'sweep' && !e.bisect && await isAncestor(cwd,e.commit,commit)) { prior=e; break; }
  const base = prior?.commit ?? entries.find(e=>e.kind === 'genesis')?.commit;
  const chain = base ? new Set((await git(cwd,['rev-list','--first-parent',`${base}..${commit}`])).stdout.trim().split('\n')) : new Set<string>();
  const count = entries.filter(e=>e.kind === 'merge' && chain.has(e.commit)).length;
  const merges = every.merges === undefined ? undefined : Math.max(0,every.merges-count);
  const at = every.minutes === undefined ? undefined : (prior ? Date.parse(prior.ts) : startedAt) + every.minutes*60_000;
  const due = merges === 0 || (at !== undefined && now >= at);
  const hhmm = at === undefined ? undefined : new Date(at).toLocaleTimeString('en-GB',{hour:'2-digit',minute:'2-digit',hour12:false});
  return {due,merges,at,text:`sweep not due: next ${[merges === undefined ? '' : `after ${merges} merges`,hhmm === undefined ? '' : `at ${hhmm}`].filter(Boolean).join(' or ')}`};
}
/** Advisory red survives trunk movement and clears only on a passing descendant head. */
export async function sweepRed(cwd: string, entries: Entry[], trunk: string): Promise<{seq:number; names:string[]} | undefined> {
  const heads=entries.filter((e):e is SweepEntry=>e.kind === 'sweep' && !e.bisect);
  if (!heads.length) return undefined;
  const ancestors=new Set((await git(cwd,['rev-list',trunk])).stdout.trim().split('\n'));
  let red: SweepEntry | undefined;
  for (const e of heads) if (ancestors.has(e.commit)) {
    if (e.verdict === 'fail') red ??= e;
    else if (e.verdict === 'pass' && red && await isAncestor(cwd,red.commit,e.commit)) red=undefined;
  }
  return red ? {seq:red.seq,names:red.failed} : undefined;
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
type SweepDraft = Extract<Draft, { kind: 'sweep' }>;
type SweepOptions = LeaseOptions & { commit?: string; once?: boolean; due?: boolean; startedAt?: number; onCommit?():void };
export function sweep(o: SweepOptions & {due:true}): Promise<SweepResult | SweepNotDue>;
export function sweep(o: SweepOptions & {due?:false}): Promise<SweepResult>;
export async function sweep(o: SweepOptions): Promise<SweepResult | SweepNotDue> {
  let recorded:SweepResult | undefined;
  try {
    const initial = await readState(o);
    if (initial.state.seq < 0) throw new OwedError('Not initialized: run owed init <plan.yaml> first');
    if (!initial.state.plan.sweep) throw new OwedError('plan has no sweep configured');
    if (o.due) {
      const due = await sweepDue(o.cwd,initial.state.plan,initial.entries,await revParse(o.cwd,o.commit ?? `refs/heads/${initial.state.trunk.name}`),Date.now(),o.startedAt);
      if (!due.due) return {notDue:true,skipped:true,note:due.text};
    }
    const leaseAbort=new AbortController(), lost=new AbortController(); let running=false;
    const signal=AbortSignal.any([lost.signal,...(o.signal ? [o.signal] : [])]);
    let acquired!: (scope:ReturnType<typeof AsyncLocalStorage.snapshot>)=>void, refused!: (e:unknown)=>void, release!: ()=>void;
    const ready=new Promise<ReturnType<typeof AsyncLocalStorage.snapshot>>((resolve,reject)=>{acquired=resolve;refused=reject;}), done=new Promise<void>(resolve=>{release=resolve;});
    let held:Promise<void> | undefined;
    const commandScope=async (run:()=>Promise<CommandResult>):Promise<CommandResult> => {
      held ??= withMachineLease({...o,signal:leaseAbort.signal,lease:o.lease !== false && initial.state.plan.lease !== false},async leaseSignal=> {
        running=true;
        const abort=()=>lost.abort();
        leaseSignal?.addEventListener('abort',abort,{once:true}); if (leaseSignal?.aborted) abort();
        acquired(AsyncLocalStorage.snapshot());
        try { await done; } finally { leaseSignal?.removeEventListener('abort',abort); }
      }).catch(e=>{lost.abort();refused(e);throw e;});
      void held.catch(()=>{}); // Observe failure now; tree disposal precedes the final awaited rejection.
      return (await ready)(run);
    };
    const cancelWait=()=>{ if (!running) leaseAbort.abort(o.signal?.reason); };
    o.signal?.addEventListener('abort',cancelWait,{once:true}); if (o.signal?.aborted) cancelWait();
    try {
      const result=await runLeased(signal,commandScope);
      return running && o.lease !== false && initial.state.plan.lease !== false ? {...result,...(await ready)(()=>leaseResult({}))} : result;
    } finally { release(); try { await held; } finally { o.signal?.removeEventListener('abort',cancelWait); } }
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
  async function runLeased(signal?: AbortSignal, commandScope?: (run:()=>Promise<CommandResult>)=>Promise<CommandResult>): Promise<SweepResult | SweepNotDue> {
    const ledger = await Ledger.open(o.cwd);
    return ledger.withLock(async () => {
      const {state,entries} = await readState(o), spec = state.plan.sweep;
      if (!spec) throw new OwedError('plan has no sweep configured');
      const commit = await revParse(o.cwd,o.commit ?? `refs/heads/${state.trunk.name}`);
      if (o.due) {
        const due=await sweepDue(o.cwd,state.plan,entries,commit,Date.now(),o.startedAt);
        if (!due.due) return {notDue:true,skipped:true,note:due.text};
      }
      const prior = entries.findLast((e): e is SweepEntry => e.kind === 'sweep' && !e.bisect && e.commit === commit);
      if (o.once && prior) return leaseResult({entry:prior,steps:[],skipped:true});
      const key = sweepDefinitionKey(state.plan);
      const plan: Plan = {...state.plan,closure:[],exec:{...state.plan.exec,trees:'fresh'}};
      const drafts: SweepDraft[] = [], samples = new Map<string,SweepDraft[]>();
      let headFiles: string[] = [];
      let limit = Infinity;
      const budget = Symbol('measurement budget exhausted');
      const measure = async (at: string): Promise<SweepDraft> => {
        if (signal?.aborted) throw new OwedError('aborted','aborted');
        if (drafts.length >= limit || (samples.get(at)?.length ?? 0) >= 2) throw budget;
        const obs = await runJob({cwd:o.cwd,plan,ledger,signal,commandScope,abortGraceMs:2000,
          onFailureFiles:paths=>{if (!drafts.length) headFiles=paths;}}, {
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
        const {state:latest,entries:current} = await readState(o);
        const pending: Draft[] = [...drafts];
        const firstSeq=latest.seq+1;
        let boundarySeq: number | undefined;
        if (extra.first && sweepDefinitionKey(latest.plan) === key) {
          boundarySeq=firstSeq+drafts.length-1;
          drafts.at(-1)!.boundary={head:firstSeq,merge:extra.first.merge};
          if (!sameSweepEscape(current,extra.first.merge,drafts[0]!)) pending.push({kind:'escape',by:'executor:owed',node:extra.first.node,
            merge:extra.first.merge,class:'missing',note:`Confirmed sweep failure on trunk ${commit.slice(0,12)}`,sweep:boundarySeq,
            evidence:sweepEvidence(boundarySeq,drafts[0]!)});
        }
        // Validate the complete proposed transaction against the evolving replay state before writing any bytes.
        for (const d of pending) {
          const errors = validateDraft(latest,d); if (errors.length) throw new OwedError(errors.join('; '));
          const e={...d,seq:latest.seq+1,ts:new Date().toISOString(),prev:latest.head} as Entry;
          e.hash=entryHash(e); extendState(latest,[e]);
        }
        if (signal?.aborted) throw new OwedError('aborted','aborted');
        o.onCommit?.();
        const written = await ledger.append(pending);
        const head=written[0] as SweepEntry, escape=written.find((e):e is EscapeEntry=>e.kind === 'escape');
        let notice: string | undefined;
        if (escape) {
          const paths=headFiles.filter(p=>!p.startsWith('/') && !p.startsWith('../') && !matchesAny(p,latest.plan.invariants.flatMap(i=>i.reads)));
          notice=oneLine(`escape: ${extra.first!.node} (merge #${extra.first!.merge}) broke ${sweepNames(head).slice(0,5).join(', ') || 'unknown'} on trunk ${commit.slice(0,12)}; no check covered it. Fix: a node whose brief names the test; coverage: ${paths.slice(0,5).join(', ') || 'add the test to an invariant'}`);
        }
        recorded=leaseResult({entry:head,steps:written.filter((e):e is SweepEntry=>e.kind === 'sweep' && e.seq !== head.seq),...extra,...(escape ? {escape,notice} : {})});
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
          command:sweepEscapeCommand(first.node,first.seq,note)}});
      } catch (e) { if (e === budget) return inconsistent('confirmation budget exhausted'); throw e; }
    },'sweep',signal,{busy:owner=> `sweep already running${lockActivityText(owner)}; retry next pass`,activity:'sweep'});
  }
}
export function renderSweep(r: SweepResult | SweepNotDue): string {
  if ('notDue' in r) return r.note;
  return [`Sweep #${r.entry.seq} ${r.entry.commit.slice(0, 12)}: ${r.entry.verdict}${r.skipped ? ' (already swept)' : ''}${leaseText(r)}`,
    ...(r.entry.counts ? [`Counts: ${JSON.stringify(r.entry.counts)}`] : []), `Log: ${r.entry.log}`,
    ...(r.entry.failed.length ? [`Failed: ${r.entry.failed.join(', ')}`] : []), ...(r.note ? [r.note] : []),
    ...(r.first ? [`First failing merge: ${r.first.commit} node ${r.first.node} merge #${r.first.merge}`] : []),
    ...(r.notice ? [r.notice] : [])].join('\n');
}
