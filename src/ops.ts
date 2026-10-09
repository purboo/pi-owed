import { readFile, mkdir, appendFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { stringify } from 'yaml';
import { canonical } from './canon.ts';
import { Ledger, entryHash } from './ledger.ts';
import * as git from './git.ts';
import { parsePlan, planDowngrades } from './plan.ts';
import { reduce, validateDraft, attestJobs, genesisJobs, mergeJobs, mergeGuard } from './reducer.ts';
import { runJob } from './exec.ts';
import { OwedError } from './errors.ts';
import { receipt, statusView } from './views.ts';
import type { ReceiptCard, StatusView, Report } from './views.ts';
import { briefView } from './views.ts';
import type { Brief } from './views.ts';
import type { AttestJob, Channel, Draft, Entry, ItemView, Plan, Principal, State } from './types.ts';
export type { ReceiptCard, StatusView, Report } from './views.ts';
export type { Brief } from './views.ts';
export interface InitResult { entry: Entry; observations: Entry[]; status: StatusView }
export interface DispatchPacket { node: string; attempt: number; worktree: string; branch: string; packet: string; entry: Entry; subagent: { agent: 'worker'; cwd: string; task: string } }
export interface AttestResult { node: string; observations: Entry[]; accepted: boolean; receipt: ReceiptCard }
export interface MergeResult { node: string; commit: string; tree: string; entry: Entry; deferred: ItemView[] }
export interface VerifyResult { ok: boolean; entries: number; head?: string; error?: string }
type Context = { cwd: string };
type Actor = Context & { as: Principal; channel?: Channel };
const by = (o: Actor): string => `${o.as.role}:${o.as.id}`;
function owner(o: Actor): void { if (o.as.role === 'owner' && !['tty', 'pi-confirm', 'flag'].includes(o.channel ?? '')) throw new OwedError('owner actions require a confirmation channel'); }
function guard(s: State, d: Draft): void { const errors = validateDraft(s,d); if (errors.length) throw new OwedError(errors.join('; ')); }
async function load(ledger: Ledger, extra: string[] = []) {
  const entries = await ledger.read(), plans = new Map<string, Plan>();
  for (const sha of new Set([...entries.flatMap(e => e.kind === 'genesis' || e.kind === 'plan' ? [e.plan] : []), ...extra])) plans.set(sha, parsePlan((await ledger.getBlob(sha)).toString()));
  const lookup = (sha: string): Plan => { const p = plans.get(sha); if (!p) throw new OwedError(`Missing plan ${sha}`, 'internal'); return p; };
  return { entries, lookup, state: reduce(entries,lookup) };
}
function inited(s: State): State { if (s.seq < 0) throw new OwedError('Not initialized: run owed init <plan.yaml> first'); return s; }
function node(s: State, id: string) { const n = inited(s).nodes[id]; if (!n) throw new OwedError(`Node ${id} does not exist`); return n; }
function candidate(s: State, id: string) { const n = node(s,id); if (!n.slot?.open || !n.candidate) throw new OwedError(`Node ${id} has no open candidate`); return n; }
function stable(before: State, after: State, id?: string): void {
  if (before.planSha !== after.planSha || before.trunk.commit !== after.trunk.commit || (id && (before.nodes[id]?.slot?.dispatchSeq !== after.nodes[id]?.slot?.dispatchSeq || before.nodes[id]?.candidate?.seq !== after.nodes[id]?.candidate?.seq || before.nodes[id]?.slot?.open !== after.nodes[id]?.slot?.open))) throw new OwedError('Plan, candidate or trunk changed; retry');
}
async function mutate(o: Actor, make: (s: State) => Draft): Promise<Entry> {
  owner(o); const ledger = await Ledger.open(o.cwd);
  return ledger.withLock(async () => { const { state } = await load(ledger); const d = make(state); guard(state,d); return (await ledger.append([d]))[0]!; });
}
async function storePlan(ledger: Ledger, text: string) { const plan = parsePlan(text); const sha = await ledger.putBlob(stringify(JSON.parse(canonical(plan)), { sortMapEntries: true })); return { plan, sha }; }
async function runJobs(cwd: string, ledger: Ledger, snapshot: State, jobs: AttestJob[], id?: string): Promise<Entry[]> {
  const result: Entry[] = [];
  for (const job of jobs) {
    let plan = snapshot.plan;
    // Attribution must use the original setup, closure and writes as well as the original check spec.
    if (job.attribution) {
      const h = await load(ledger);
      const block = h.entries.find(e => e.kind === 'obs' && e.subject === job.subject && e.obligation === job.obligation && e.key === job.key && e.verdict === 'fail' && !e.attribution);
      const law = h.entries.filter(e => e.seq <= (block?.seq ?? -1) && (e.kind === 'plan' || e.kind === 'genesis')).at(-1);
      if (law && (law.kind === 'plan' || law.kind === 'genesis')) plan = h.lookup(law.plan);
    }
    const obs = await runJob({ cwd, ledger, plan }, job);
    await ledger.withLock(async () => { const { state } = await load(ledger); stable(snapshot,state,id); guard(state,obs); result.push(...await ledger.append([obs])); });
  }
  return result;
}
export async function init(o: Actor & { plan: string; channel: Channel }): Promise<InitResult> {
  owner(o); const ledger = await Ledger.open(o.cwd), p = await storePlan(ledger,o.plan);
  const commit = await git.revParse(o.cwd,`refs/heads/${p.plan.trunk}`), facts = await git.stateFacts(o.cwd,p.plan,commit);
  const entry = await ledger.withLock(async () => { const { state } = await load(ledger,[p.sha]); const d: Draft = { kind:'genesis', by:by(o), channel:o.channel, trunk:p.plan.trunk, commit, plan:p.sha, state:facts }; guard(state,d); return (await ledger.append([d]))[0]!; });
  const { state } = await load(ledger); const observations = await runJobs(o.cwd,ledger,state,genesisJobs(state));
  return { entry, observations, status:await status(o) };
}
export async function planSet(o: Actor & { plan: string }): Promise<Entry> {
  owner(o); const ledger = await Ledger.open(o.cwd), p = await storePlan(ledger,o.plan), before = (await load(ledger)).state;
  return ledger.withLock(async () => { const { state } = await load(ledger,[p.sha]); stable(before,state); const d: Draft = { kind:'plan', by:by(o), channel:o.channel, prior:before.planSha, plan:p.sha, downgrades:planDowngrades(state.plan,p.plan) }; guard(state,d); return (await ledger.append([d]))[0]!; });
}
export async function rule(o: Actor & { text: string; nodes: string[] | '*' }): Promise<Entry> { return mutate(o,() => ({ kind:'rule', by:by(o), channel:o.channel, text:o.text, nodes:o.nodes })); }
export async function dispatch(o: Actor & { node: string }): Promise<DispatchPacket> {
  owner(o); const ledger = await Ledger.open(o.cwd);
  return ledger.withLock(async () => {
    const { state } = await load(ledger), n = node(state,o.node), spec = state.plan.nodes.find(x => x.id === o.node)!;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(o.node)) throw new OwedError('Node id is unsafe for a worktree path','usage');
    const attempt = (n.slot?.attempt ?? 0)+1, branch = `owed/${o.node}/${attempt}`, root = await git.repoRoot(o.cwd);
    const worktree = join(root,'.owed','wt',`${o.node}-${attempt}`), rules = state.rules.filter(r => r.nodes === '*' || r.nodes.includes(o.node));
    const packet = [`# ${spec.title ?? spec.id}`, spec.brief ?? '', `Node: ${o.node}; attempt: ${attempt}`, `Working directory: ${worktree}`, `Allowed writes: ${spec.writes.join(', ')}`, 'Checks run by owed:', ...spec.checks.map(c => `- ${c.id}: ${c.run}\n  red: ${!!c.red}${c.red ? `; tests: ${c.tests?.join(', ')}` : ''}`), 'Applicable rulings:', ...rules.map(r => `- #${r.seq} ${r.text}`), 'commit your work; do not edit files outside writes; owed will run the checks itself', `After committing, run: owed submit ${o.node}`].join('\n');
    const d: Draft = { kind:'dispatch', by:by(o), channel:o.channel, node:o.node, attempt, base:state.trunk.commit, branch, worktree, packet:await ledger.putBlob(packet), rulings_seen:Math.max(-1,...rules.map(r => r.seq)) };
    guard(state,d);
    const common = resolve(o.cwd,(await git.git(o.cwd,['rev-parse','--git-common-dir'])).stdout.trim()), exclude = join(common,'info','exclude');
    await mkdir(dirname(exclude),{recursive:true}); let text = ''; try { text = await readFile(exclude,'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (!text.split('\n').includes('.owed/')) await appendFile(exclude,'\n.owed/\n');
    await git.addWorktree(o.cwd,worktree,branch,state.trunk.commit);
    let entry: Entry;
    try { entry = await ledger.withLock(async () => { const current = (await load(ledger)).state; stable(state,current,o.node); if (canonical(current.rules) !== canonical(state.rules)) throw new OwedError('Rulings changed; dispatch again'); guard(current,d); return (await ledger.append([d]))[0]!; }); }
    catch (error) { await git.git(o.cwd,['worktree','remove',worktree]); await git.git(o.cwd,['branch','-d',branch]); throw error; }
    return { node:o.node, attempt, worktree, branch, packet, entry, subagent:{agent:'worker',cwd:worktree,task:packet} };
  },'dispatch');
}
export async function submit(o: Actor & { node: string; commit?: string }): Promise<Entry> {
  owner(o); const ledger = await Ledger.open(o.cwd), { state } = await load(ledger), n = node(state,o.node);
  if (!n.slot?.open) throw new OwedError('No open writer slot');
  if ((!o.commit || resolve(await git.repoRoot(o.cwd)) === resolve(n.slot.worktree)) && !await git.isClean(n.slot.worktree)) throw new OwedError('slot worktree is dirty');
  const commit = await git.revParse(o.commit ? o.cwd : n.slot.worktree,o.commit ?? 'HEAD');
  if (!await git.isAncestor(o.cwd,n.slot.base,commit)) throw new OwedError('submit commit must be a descendant of slot base');
  const facts = await git.candidateFacts(o.cwd,state.plan,state.plan.nodes.find(x => x.id === o.node)!,n.slot.base,commit,n.slot.attempt);
  return ledger.withLock(async () => { const current = (await load(ledger)).state; stable(state,current,o.node); const d: Draft = { kind:'submit', by:by(o), node:o.node, attempt:n.slot!.attempt, facts }; guard(current,d); return (await ledger.append([d]))[0]!; });
}
export async function attest(o: Context & { node: string; rerun?: boolean }): Promise<AttestResult> {
  const ledger = await Ledger.open(o.cwd);
  return ledger.withLock(async () => {
    const { state } = await load(ledger), n = candidate(state,o.node), jobs = attestJobs(state,o.node);
    if (o.rerun) for (const c of state.plan.nodes.find(x => x.id === o.node)!.checks) for (const kind of ['check', ...(c.red ? ['red'] : [])] as ('check'|'red')[]) {
      const obligation = `${kind}:${c.id}`, key = n.candidate!.keys[obligation]!;
      if (!jobs.some(j => j.key === key && j.obligation === obligation)) jobs.push({kind,subject:o.node,obligation,key,spec:c,commit:n.candidate!.commit,base:n.slot!.base});
    }
    if (o.rerun && !jobs.some(j => j.obligation === 'writes' && j.key === n.candidate!.keys.writes)) jobs.push({ kind:'writes',subject:o.node,obligation:'writes',key:n.candidate!.keys.writes!,commit:n.candidate!.commit,base:n.slot!.base });
    const observations = await runJobs(o.cwd,ledger,state,[...genesisJobs(state),...jobs],o.node), card = await why(o);
    return { node:o.node, observations, accepted:card.accepted, receipt:card };
  },'attest');
}
export async function review(o: Actor & { node: string; verdict:'ok'|'block'; rank:number; note:string; ack_rulings?:number; obligation?:'review'|'closure-review' }): Promise<Entry> {
  return mutate(o,s => { const n = candidate(s,o.node), obligation = o.obligation ?? 'review'; return { kind:'review',by:by(o),channel:o.channel,node:o.node,attempt:n.slot!.attempt,obligation,key:n.candidate!.keys[obligation] ?? '',verdict:o.verdict,rank:o.rank,note:o.note,ack_rulings:o.ack_rulings }; });
}
export async function waive(o: Actor & { node:string; obligation:string; reason:string; accept_risk?:number[]; channel:Channel }): Promise<Entry> { return mutate(o,s => ({kind:'waive',by:by(o),channel:o.channel,node:o.node,obligation:o.obligation,key:candidate(s,o.node).candidate!.keys[o.obligation] ?? '',reason:o.reason,accept_risk:o.accept_risk})); }
export async function defer(o: Actor & { node:string; items:{id:string;key:string}[]; reason:string; channel:Channel }): Promise<Entry> { return mutate(o,() => ({kind:'defer',by:by(o),channel:o.channel,node:o.node,items:o.items,reason:o.reason})); }
export async function abandon(o: Actor & { node:string; reason:string }): Promise<Entry> { return mutate(o,s => ({kind:'abandon',by:by(o),channel:o.channel,node:o.node,attempt:node(s,o.node).slot?.attempt ?? 0,reason:o.reason})); }
export async function merge(o: Actor & { node:string }): Promise<MergeResult> {
  owner(o); if (!['owner','parent'].includes(o.as.role)) throw new OwedError('merge requires parent/owner');
  const ledger = await Ledger.open(o.cwd);
  return ledger.withLock(async () => {
    const { state } = await load(ledger), n = candidate(state,o.node);
    if (!n.accepted) throw new OwedError(`Node ${o.node} current candidate is not yet accepted:${n.items.filter(i => i.status === 'D').map(i => i.obligation).join(', ')}`);
    if (await git.revParse(o.cwd,`refs/heads/${state.trunk.name}`) !== state.trunk.commit) throw new OwedError('trunk changed (CAS)');
    const built = await git.buildMerge(o.cwd,state.trunk.commit,n.candidate!.commit,`owed merge ${o.node}`);
    if ('conflicts' in built) throw new OwedError('rebase needed');
    const facts = await git.candidateFacts(o.cwd,state.plan,state.plan.nodes.find(x => x.id === o.node)!,state.trunk.commit,built.commit,n.slot!.attempt), sf = await git.stateFacts(o.cwd,state.plan,built.commit), m = {facts,state:sf};
    const observations: Draft[] = [];
    for (const job of [...genesisJobs(state),...mergeJobs(state,o.node,m)]) observations.push(await runJob({cwd:o.cwd,ledger,plan:state.plan},job));
    return ledger.withLock(async () => {
      const latest = await load(ledger); stable(state,latest.state,o.node);
      // Evaluate the prospective observations without persisting them before CAS.
      // A moved ref must leave the ledger completely unchanged by this merge.
      const replay = [...latest.entries]; let current = latest.state;
      for (const obs of observations) {
        guard(current,obs);
        const entry = {...obs,seq:current.seq+1,ts:new Date().toISOString(),prev:current.head} as Entry;
        entry.hash=entryHash(entry); replay.push(entry); current=reduce(replay,latest.lookup);
      }
      const g = mergeGuard(current,o.node,m);
      if (!g.ok) { if (observations.length) await ledger.append(observations); throw new OwedError(g.reasons.join('; ')); }
      const d: Draft = {kind:'merge',by:'executor:owed',node:o.node,attempt:n.slot!.attempt,prior:state.trunk.commit,commit:built.commit,facts,state:sf}; guard(current,d);
      await git.advanceTrunk(o.cwd,state.trunk.name,state.trunk.commit,built.commit);
      const entry = (await ledger.append([...observations,d])).at(-1)!;
      return {node:o.node,...built,entry,deferred:g.invItems.filter(i => i.status === 'D')};
    });
  },'merge');
}
export async function status(o: Context): Promise<StatusView> { const {state,entries} = await load(await Ledger.open(o.cwd)); return statusView(inited(state),entries); }
export async function why(o: Context & {node:string}): Promise<ReceiptCard> { const {state,entries} = await load(await Ledger.open(o.cwd)); node(state,o.node); return receipt(state,entries,o.node); }
export async function report(o: Context & {since?:number|string}): Promise<Report> {
  const {state,entries,lookup} = await load(await Ledger.open(o.cwd)), since = o.since ?? -1; inited(state);
  if (typeof since === 'string' && !Number.isFinite(Date.parse(since))) throw new OwedError('since must be a seq or ISO timestamp','usage');
  const included = (e: {seq:number;ts?:string}) => typeof since === 'number' ? e.seq > since : Date.parse(e.ts ?? entries[e.seq]?.ts ?? '') > Date.parse(since);
  const recent = entries.filter(included), before = reduce(entries.filter(e => !included(e)),lookup), old = [...Object.values(before.nodes).flatMap(n => n.items),...before.invariants];
  const items = [...Object.values(state.nodes).flatMap(n => n.items),...state.invariants];
  return {since,merges:recent.filter(e => e.kind === 'merge'),waivers:recent.filter(e => e.kind === 'waive'),blocks:Object.keys(state.nodes).flatMap(id => receipt(state,entries,id).blocks).filter(included),downgrades:state.downgrades.filter(included),rulings:state.rules.filter(included),decisions:items.filter(i => i.status === 'D' && i.discharger === 'owner'),ownerActions:recent.filter(e => e.by.startsWith('owner:')),changes:items.flatMap(i => { const prev = old.find(p => p.subject === i.subject && p.obligation === i.obligation); return prev?.status === i.status && prev.key === i.key ? [] : [{subject:i.subject,obligation:i.obligation,before:prev?.status,after:i.status}]; })};
}
export async function verify(o: Context): Promise<VerifyResult> { try { const {entries,state} = await load(await Ledger.open(o.cwd)); return {ok:true,entries:entries.length,head:state.head}; } catch (e) { return {ok:false,entries:0,error:e instanceof Error ? e.message : String(e)}; } }
/** Morning brief: owner decisions, merges since `since` (seq or ISO time), active blocks, work in progress and totals. */
export async function brief(o: Context & {since?:number|string; now?:number}): Promise<Brief> {
  const {state,entries} = await load(await Ledger.open(o.cwd)), since = o.since ?? -1; inited(state);
  if (typeof since === 'string' && !Number.isFinite(Date.parse(since))) throw new OwedError('since must be a seq or ISO timestamp','usage');
  return briefView(state,entries,since,o.now ?? Date.now());
}
