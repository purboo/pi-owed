import { join } from 'node:path';
import { canonical, sha256 } from './canon.ts';
import { OwedError } from './errors.ts';
import { runJob } from './exec.ts';
import { execKey, git, revParse } from './git.ts';
import { withMachineLease, type LeaseOptions } from './lease.ts';
import { withoutSelftest } from './plan.ts';
import type { Ledger } from './ledger.ts';
import type { CheckSpec, Counts, Draft, Entry, Plan } from './types.ts';

export interface TryResult { side: string; rev: string; commit: string; tree?: string; receipt?: number; expect: 'pass' | 'fail'; verdict: 'pass' | 'fail' | 'error'; ok: boolean; counts?: Counts; durationMs: number; log: string }
export type CheckTarget = { node?: string; invariant?: string; check: string };
export type TryTarget = { node: string; check: string } | { invariant: string } | { run: string; run_sha256: string; min_tests: number; timeout_s: number };
export interface TryReceipt { for?: string; target: TryTarget; side: string; rev: string; commit: string; tree: string; verdict: TryResult['verdict']; counts?: Counts; durationMs: number; log: string; plan: string }
export type CheckTryArgs = LeaseOptions & { node?: string; invariant?: string; check?: string; run?: string; min_tests?: number; timeout?: number; record?: boolean; for?: string; red?: string; green?: string; plan?: string };
export const TRY_FORMS = 'check try requires exactly one of <node> <check>, --invariant <id>, or --run <command>, and --red or --green';
/** PR1: the CLI and tool share validation; ad-hoc commands keep ordinary count/timeout rules. */
export function validateTry(o: Omit<CheckTryArgs, 'cwd'>): void {
  if ([o.node !== undefined || o.check !== undefined,o.invariant !== undefined,o.run !== undefined].filter(Boolean).length !== 1 || (o.node !== undefined || o.check !== undefined) && (!o.node || !o.check) || !o.red && !o.green) throw new OwedError(TRY_FORMS,'usage');
  if (o.for !== undefined && !o.record) throw new OwedError('--for requires --record','usage');
  if (o.run !== undefined && !o.run.trim()) throw new OwedError('--run requires a non-empty command','usage');
  if (o.run === undefined && (o.min_tests !== undefined || o.timeout !== undefined)) throw new OwedError('--min-tests and --timeout require --run','usage');
  for (const [name,n,min] of [['min-tests',o.min_tests,0],['timeout',o.timeout,1]] as const) if (n !== undefined && (!Number.isSafeInteger(n) || n < min)) throw new OwedError(`--${name} must be a safe integer >= ${min}`,'usage');
}
export function adhocTry(o: CheckTryArgs): { target: TryTarget; spec: CheckSpec } {
  const spec = {id:'try',run:o.run!,min_tests:o.min_tests ?? 1,timeout_s:o.timeout ?? 900};
  return {target:{run:spec.run,run_sha256:sha256(spec.run),min_tests:spec.min_tests,timeout_s:spec.timeout_s},spec:spec as CheckSpec};
}
/** PR3: notes remain opaque to replay; malformed or unrelated notes cannot break why. */
export function tryReceipts(entries: readonly Entry[], node: string): (TryReceipt & {seq: number})[] {
  return entries.flatMap(e => {
    if (e.kind !== 'note' || !e.text.startsWith('try/v1 ')) return [];
    try {
      const r = JSON.parse(e.text.slice(7));
      if (!r || r.for !== node || !r.target || !['pass','fail','error'].includes(r.verdict) || !['commit','tree','log','plan'].every(k => typeof r[k] === 'string' && /^[a-f0-9]{40,64}$/.test(r[k]))) return [];
      const t = r.target;
      if (!(typeof t.node === 'string' && typeof t.check === 'string' || typeof t.invariant === 'string' || typeof t.run === 'string')) return [];
      return [{...r,seq:e.seq} as TryReceipt & {seq:number}];
    } catch { return []; }
  }).reverse();
}
/** CT1: ordinary verdicts, even for red:true specs; runJob owns preparation, setup, repeat and cleanup. */
export async function measureTry(o: LeaseOptions, ledger: Ledger, plan: Plan, target: CheckTarget, spec: CheckSpec, side: string, rev: string, expect: 'pass' | 'fail'): Promise<TryResult> {
  let commit: string;
  try { commit = await revParse(o.cwd,rev); } catch { throw new OwedError(`unknown commit ${rev}`,'usage'); }
  const tree = (await git(o.cwd,['rev-parse',`${commit}^{tree}`])).stdout.trim();
  const obs = await runJob({cwd:o.cwd,ledger,plan,signal:o.signal,exactTree:true},{kind:target.invariant ? 'inv' : 'check',subject:target.node ?? 'trunk',obligation:`${target.invariant ? 'inv' : 'check'}:${spec.id}`,key:'check-try',commit,base:commit,spec:{...spec,red:false}});
  if (o.signal?.aborted) throw new OwedError('aborted','aborted');
  return {side,rev,commit,tree,expect,verdict:obs.verdict,ok:obs.verdict === expect,...(obs.counts ? {counts:obs.counts} : {}),durationMs:obs.durationMs,log:join(ledger.dir,'blobs',obs.log!)};
}
export async function tryLines(ledger: Ledger, results: TryResult[]): Promise<string[]> {
  return (await Promise.all(results.map(async r => {
    const line = `${r.side} ${r.rev} (${r.commit.slice(0,12)}${r.tree ? `, tree ${r.tree.slice(0,12)}` : ''}): ${r.verdict} ${r.ok ? '✔' : `✘ expected ${r.expect}, got ${r.verdict}`} (${r.counts?.pass ?? '?'}/${r.counts?.tests ?? '?'} tests, ${(r.durationMs/1000).toFixed(3)} s) log ${r.log}${r.receipt !== undefined ? ` receipt #${r.receipt}` : ''}`;
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
