import { join } from 'node:path';
import { canonical } from './canon.ts';
import { OwedError } from './errors.ts';
import { runJob } from './exec.ts';
import { execKey, revParse } from './git.ts';
import { withMachineLease, type LeaseOptions } from './lease.ts';
import { withoutSelftest } from './plan.ts';
import type { Ledger } from './ledger.ts';
import type { CheckSpec, Counts, Draft, Plan } from './types.ts';

export interface TryResult { side: string; rev: string; commit: string; expect: 'pass' | 'fail'; verdict: 'pass' | 'fail' | 'error'; ok: boolean; counts?: Counts; durationMs: number; log: string }
export type CheckTarget = { node?: string; invariant?: string; check: string };
export type CheckTryArgs = LeaseOptions & { node?: string; invariant?: string; check?: string; red?: string; green?: string; plan?: string };
/** CT1: ordinary verdicts, even for red:true specs; runJob owns preparation, setup, repeat and cleanup. */
export async function measureTry(o: LeaseOptions, ledger: Ledger, plan: Plan, target: CheckTarget, spec: CheckSpec, side: string, rev: string, expect: 'pass' | 'fail'): Promise<TryResult> {
  let commit: string;
  try { commit = await revParse(o.cwd,rev); } catch { throw new OwedError(`unknown commit ${rev}`,'usage'); }
  const obs = await runJob({cwd:o.cwd,ledger,plan,signal:o.signal,exactTree:true},{kind:target.invariant ? 'inv' : 'check',subject:target.node ?? 'trunk',obligation:`${target.invariant ? 'inv' : 'check'}:${spec.id}`,key:'check-try',commit,base:commit,spec:{...spec,red:false}});
  if (o.signal?.aborted) throw new OwedError('aborted','aborted');
  return {side,rev,commit,expect,verdict:obs.verdict,ok:obs.verdict === expect,...(obs.counts ? {counts:obs.counts} : {}),durationMs:obs.durationMs,log:join(ledger.dir,'blobs',obs.log!)};
}
export async function tryLines(ledger: Ledger, results: TryResult[]): Promise<string[]> {
  return (await Promise.all(results.map(async r => {
    const line = `${r.side} ${r.rev} (${r.commit.slice(0,12)}): ${r.verdict} ${r.ok ? '✔' : `✘ expected ${r.expect}, got ${r.verdict}`} (${r.counts?.pass ?? '?'}/${r.counts?.tests ?? '?'} tests, ${(r.durationMs/1000).toFixed(3)} s) log ${r.log}`;
    return [line,...(r.ok ? [] : (await ledger.getBlob(r.log.split('/').at(-1)!)).toString().trimEnd().split('\n').slice(-20))];
  }))).flat();
}
const targets = (plan: Plan) => [...plan.nodes.flatMap(n => n.checks.map(spec => ({target:{node:n.id,check:spec.id} as CheckTarget,spec}))),...plan.invariants.map(spec => ({target:{invariant:spec.id,check:spec.id} as CheckTarget,spec}))];
/** CT2: compare definitions without fixtures; selftest-only edits never affect execution evidence. */
export function changedChecks(plan: Plan, prior?: Plan) {
  const old = prior ? targets(prior) : [];
  const definition = (p:Plan,c:ReturnType<typeof targets>[number]) => canonical({check:withoutSelftest(c.spec),setup:p.setup,exec:execKey(p),...(c.spec.quarantine_set ? {quarantine_set:p.quarantine_sets?.[c.spec.quarantine_set]} : {})});
  return targets(plan).filter(c => { const p = old.find(p => canonical(p.target) === canonical(c.target)); return !p || definition(prior!,p) !== definition(plan,c) || canonical(p.spec.selftest) !== canonical(c.spec.selftest); });
}
export function selftestPreview(plan: Plan, prior?: Plan): string[] {
  const changed = changedChecks(plan,prior), n = changed.filter(c => c.spec.selftest).length;
  return [...(n ? [`selftest: ${n} check(s) run when recorded`] : []),...changed.filter(c => !c.spec.selftest).map(c => `check ${c.target.node ? `${c.target.node}/${c.spec.id}` : `inv:${c.target.invariant}`}: not self-tested`)];
}
export async function admitSelftests(o: LeaseOptions, ledger: Ledger, plan: Plan, sha: string, prior?: Plan): Promise<{ note?: Draft; lines: string[] }> {
  const changed = changedChecks(plan,prior), pending = changed.filter(c => c.spec.selftest), results: (TryResult & CheckTarget)[] = [];
  if (pending.length) await withMachineLease({...o,lease:plan.lease === false ? false : o.lease,priority:10},async signal => {
    for (const c of pending) for (const fixture of c.spec.selftest!) {
      try { results.push({...c.target,...await measureTry({...o,signal},ledger,plan,c.target,c.spec,'selftest',fixture.commit,fixture.expect)}); }
      catch(e) { if (!(e instanceof OwedError) || e.code !== 'usage') throw e; const log=join(ledger.dir,'blobs',await ledger.putBlob(e.message)); results.push({...c.target,side:'selftest',rev:fixture.commit,commit:fixture.commit,expect:fixture.expect,verdict:'error',ok:false,durationMs:0,log}); }
    }
  });
  const lines = [...await tryLines(ledger,results),...selftestPreview(plan,prior).filter(l => !l.startsWith('selftest:'))];
  if (results.some(r => !r.ok)) throw new OwedError(lines.join('\n'));
  return {lines,...(results.length ? {note:{kind:'note' as const,by:'executor:owed',text:'selftest/v1 '+JSON.stringify({plan:sha,results:results.map(({node,invariant,check,commit,expect,verdict,log}) => ({...(node ? {node} : {invariant}),check,commit,expect,verdict,log}))})}} : {})};
}
