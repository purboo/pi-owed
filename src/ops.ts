import { readFile, mkdir, appendFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { stringify } from 'yaml';
import { canonical } from './canon.ts';
import { Ledger, entryHash } from './ledger.ts';
import * as git from './git.ts';
import { parsePlan, planDowngrades, worktreesConfig, expandBranch } from './plan.ts';
import { reduce, validateDraft, attestJobs, genesisJobs, mergeJobs, mergeGuard, adoptJobs, adoptGuard, decoyDigest as digestOf, decoyPayloadErrors, overlapping, halted } from './reducer.ts';
import { runJob } from './exec.ts';
import { OwedError } from './errors.ts';
import { receipt, statusView, escapeSummary, driftText, dispatchPacket } from './views.ts';
import type { ReceiptCard, StatusView, Report } from './views.ts';
import { briefView } from './views.ts';
import type { Brief } from './views.ts';
import type { AttestJob, Channel, DecoyPayload, Draft, Entry, EscapeClass, HaltEntry, ItemView, LaunchEntry, NodeSpec, Plan, Principal, RunRole, SendEntry, SendKind, SendReason, State } from './types.ts';
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
  if (before.planSha !== after.planSha || before.trunk.commit !== after.trunk.commit || (id && (before.nodes[id]?.slot?.dispatchSeq !== after.nodes[id]?.slot?.dispatchSeq || before.nodes[id]?.slot?.base !== after.nodes[id]?.slot?.base || before.nodes[id]?.candidate?.seq !== after.nodes[id]?.candidate?.seq || before.nodes[id]?.slot?.open !== after.nodes[id]?.slot?.open))) throw new OwedError('Plan, candidate or trunk changed; retry');
}
async function mutate(o: Actor, make: (s: State) => Draft): Promise<Entry> {
  owner(o); const ledger = await Ledger.open(o.cwd);
  return ledger.withLock(async () => { const { state } = await load(ledger); const d = make(state); guard(state,d); return (await ledger.append([d]))[0]!; });
}
async function storePlan(ledger: Ledger, text: string) { const plan = parsePlan(text); const sha = await ledger.putBlob(stringify(JSON.parse(canonical(plan)), { sortMapEntries: true })); return { plan, sha }; }
/** The rejection of an operation whose `signal` aborted (D16): the CLI maps it to the signal's exit code. */
const aborted = (): OwedError => new OwedError('aborted', 'aborted');
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw aborted(); }
/**
 * Runs the jobs in order, appending each observation under the lock. On abort (D16) the running check's process group
 * is killed (src/exec.ts), its observation is not recorded, no further job starts, and this rejects with
 * OwedError('aborted'); observations appended before stay.
 */
async function runJobs(cwd: string, ledger: Ledger, snapshot: State, jobs: AttestJob[], id?: string, signal?: AbortSignal): Promise<Entry[]> {
  const result: Entry[] = [];
  for (const job of jobs) {
    checkAbort(signal);
    let plan = snapshot.plan;
    // Attribution must use the original setup, exec, closure and writes as well as the original check spec.
    if (job.attribution) {
      const h = await load(ledger);
      const block = h.entries.find(e => e.kind === 'obs' && e.subject === job.subject && e.obligation === job.obligation && e.key === job.key && e.verdict === 'fail' && !e.attribution);
      const law = h.entries.filter(e => e.seq <= (block?.seq ?? -1) && (e.kind === 'plan' || e.kind === 'genesis')).at(-1);
      if (law && (law.kind === 'plan' || law.kind === 'genesis')) plan = h.lookup(law.plan);
    }
    const obs = await runJob({ cwd, ledger, plan, signal }, job);
    checkAbort(signal);
    await ledger.withLock(async () => { const { state } = await load(ledger); stable(snapshot,state,id); guard(state,obs); result.push(...await ledger.append([obs])); },undefined,signal);
  }
  return result;
}
/**
 * Records the observations a merge or adopt measured before an abort (valid evidence) when the ledger did not move
 * (the same check as the refusal path), else nothing; then rejects with OwedError('aborted'). Must not run under 'lock'.
 * Its withLock takes no signal: the signal has already aborted, and passing it would drop these observations (D16a).
 */
async function abortWith(ledger: Ledger, snapshot: State, observations: Draft[], id?: string): Promise<never> {
  if (observations.length) {
    try { await ledger.withLock(async () => { const latest = await load(ledger); stable(snapshot,latest.state,id); prospective(latest,observations); await ledger.append(observations); }); }
    catch (e) { if (!(e instanceof OwedError)) throw e; /* the ledger moved: nothing recorded */ }
  }
  throw aborted();
}
export async function init(o: Actor & { plan: string; channel: Channel; signal?: AbortSignal }): Promise<InitResult> {
  owner(o); checkAbort(o.signal); const ledger = await Ledger.open(o.cwd), p = await storePlan(ledger,o.plan);
  const commit = await git.revParse(o.cwd,`refs/heads/${p.plan.trunk}`), facts = await git.stateFacts(o.cwd,p.plan,commit);
  const entry = await ledger.withLock(async () => { const { state } = await load(ledger,[p.sha]); const d: Draft = { kind:'genesis', by:by(o), channel:o.channel, trunk:p.plan.trunk, commit, plan:p.sha, state:facts }; guard(state,d); return (await ledger.append([d]))[0]!; },undefined,o.signal);
  const { state } = await load(ledger); const observations = await runJobs(o.cwd,ledger,state,genesisJobs(state),undefined,o.signal);
  return { entry, observations, status:await status(o) };
}
/** Reads a plan file for `owed plan`: from commit `rev` when given (path relative to cwd), else from the working tree. */
export async function readPlan(o: Context & { path: string; rev?: string }): Promise<{ plan: string; rev?: string; path: string }> {
  if (o.rev !== undefined) { const r = await git.readAt(o.cwd,o.rev,o.path); return { plan:r.text, rev:r.commit, path:r.path }; }
  const file = resolve(o.cwd,o.path); let text: string;
  try { text = await readFile(file,'utf8'); } catch (e) { throw new OwedError(`cannot read ${o.path}: ${(e as NodeJS.ErrnoException).code ?? String(e)}`,'usage'); }
  let path = file;
  try { const top = await realpath(await git.repoRoot(o.cwd)), rel = relative(top,await realpath(file)); if (rel && !rel.startsWith('..') && !isAbsolute(rel)) path = rel.split(sep).join('/'); } catch { /* outside a repository: keep the absolute path */ }
  return { plan:text, path };
}
export async function planSet(o: Actor & { plan: string; rev?: string; path?: string }): Promise<Entry> {
  owner(o); const ledger = await Ledger.open(o.cwd), p = await storePlan(ledger,o.plan), before = (await load(ledger)).state;
  return ledger.withLock(async () => { const { state } = await load(ledger,[p.sha]); stable(before,state); const d: Draft = { kind:'plan', by:by(o), channel:o.channel, prior:before.planSha, plan:p.sha, downgrades:planDowngrades(state.plan,p.plan), ...(o.rev !== undefined ? { rev:o.rev } : {}), ...(o.path !== undefined ? { path:o.path } : {}) }; guard(state,d); return (await ledger.append([d]))[0]!; });
}
export async function rule(o: Actor & { text: string; nodes: string[] | '*' }): Promise<Entry> { return mutate(o,() => ({ kind:'rule', by:by(o), channel:o.channel, text:o.text, nodes:o.nodes })); }
export async function dispatch(o: Actor & { node: string; allowOverlap?: boolean }): Promise<DispatchPacket> {
  // The main worktree root: dispatching from inside a slot worktree must not nest the new worktree in it.
  // Resolved first, so an unverifiable layout is refused before any ledger, exclude or worktree effect.
  owner(o); const root = await git.mainRoot(o.cwd), ledger = await Ledger.open(o.cwd);
  return ledger.withLock(async () => {
    const { state } = await load(ledger), n = node(state,o.node), spec = state.plan.nodes.find(x => x.id === o.node)!;
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(o.node)) throw new OwedError('Node id is unsafe for a worktree path','usage');
    // Overlapping writes of concurrent slots produce conflicts or ambiguous ownership; refuse unless explicitly allowed.
    const overlaps = overlapping(state,o.node);
    if (overlaps.length && !o.allowOverlap) throw new OwedError(`writes of ${o.node} overlap the open slot of ${overlaps.join(', ')}; wait for ${overlaps.length > 1 ? 'them' : 'it'} or dispatch with --allow-overlap`);
    const attempt = (n.slot?.attempt ?? 0)+1, { branch, worktree, excludeLine } = await slotLayout(root,state.plan,spec,attempt);
    const rules = state.rules.filter(r => r.nodes === '*' || r.nodes.includes(o.node));
    const packet = dispatchPacket(spec, attempt, worktree, rules);
    const d: Draft = { kind:'dispatch', by:by(o), channel:o.channel, node:o.node, attempt, base:state.trunk.commit, branch, worktree, packet:await ledger.putBlob(packet), rulings_seen:Math.max(-1,...rules.map(r => r.seq)), ...(overlaps.length ? { overlaps } : {}) };
    guard(state,d);
    const exclude = join(await git.commonDir(o.cwd),'info','exclude');
    await mkdir(dirname(exclude),{recursive:true}); let text = ''; try { text = await readFile(exclude,'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (excludeLine && !text.split('\n').includes(excludeLine)) await appendFile(exclude,`\n${excludeLine}\n`);
    await mkdir(dirname(worktree),{recursive:true});
    await git.addWorktree(root,worktree,branch,state.trunk.commit);
    let entry: Entry;
    try { entry = await ledger.withLock(async () => { const current = (await load(ledger)).state; stable(state,current,o.node); if (canonical(current.rules) !== canonical(state.rules)) throw new OwedError('Rulings changed; dispatch again'); if (canonical(overlapping(current,o.node)) !== canonical(overlaps)) throw new OwedError('Open slots changed; dispatch again'); guard(current,d); return (await ledger.append([d]))[0]!; }); }
    catch (error) { await git.git(root,['worktree','remove',worktree]); await git.git(root,['branch','-d',branch]); throw error; }
    return { node:o.node, attempt, worktree, branch, packet, entry, subagent:{agent:'worker',cwd:worktree,task:packet} };
  },'dispatch');
}
/** `path` with its deepest existing ancestor resolved through symlinks (the rest need not exist yet). */
async function physical(path: string): Promise<string> {
  try { return await realpath(path); } catch { const up = dirname(path); return up === path ? path : join(await physical(up), basename(path)); }
}
/**
 * D19: branch and worktree of attempt `attempt` of node `spec` under the plan's `worktrees:` block (defaults: root
 * `.owed/wt`, branch `owed/{node}/{attempt}`), and the info/exclude line: `.owed/` for the default root (as in 0.4.1),
 * `/<repository-relative root>/` (glob metacharacters escaped) for another root inside the main worktree, none for a
 * root outside it. The worktree path is physical (the root's deepest existing ancestor resolved through symlinks), so
 * it equals git's toplevel inside the slot and writer inference matches it. Refuses (usage) an invalid branch name or a
 * root equal to the main worktree root, before any effect.
 */
async function slotLayout(root: string, plan: Plan, spec: NodeSpec, attempt: number): Promise<{ branch: string; worktree: string; excludeLine?: string }> {
  const cfg = worktreesConfig(plan), branch = expandBranch(cfg.branch, spec, attempt);
  if ((await git.git(root,['check-ref-format','--branch',branch],{allowFail:true})).code) throw new OwedError(`branch name ${branch} (from worktrees.branch "${cfg.branch}") is not a valid git branch name`,'usage');
  const base = await physical(resolve(root,cfg.root)), worktree = join(base,`${spec.id}-${attempt}`);
  const rel = relative(await physical(root),base);
  if (!rel) throw new OwedError(`worktrees.root ${cfg.root} is the main worktree root; use a directory inside or outside it`,'usage');
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { branch, worktree };
  const path = rel.split(sep).join('/');
  return { branch, worktree, excludeLine: path === '.owed/wt' ? '.owed/' : `/${ignoreLiteral(path)}/` };
}
/** `text` as a literal gitignore pattern: `\`, `*`, `?` and `[` escaped, and a leading `!` or `#`. */
export function ignoreLiteral(text: string): string { return text.replace(/[\\*?[]/g,'\\$&').replace(/^[!#]/,'\\$&'); }
export async function submit(o: Actor & { node: string; commit?: string }): Promise<Entry> {
  owner(o); const ledger = await Ledger.open(o.cwd), { state } = await load(ledger), n = node(state,o.node);
  if (!n.slot?.open) throw new OwedError('No open writer slot');
  if ((!o.commit || resolve(await git.repoRoot(o.cwd)) === resolve(n.slot.worktree)) && !await git.isClean(n.slot.worktree)) throw new OwedError('slot worktree is dirty');
  const commit = await git.revParse(o.commit ? o.cwd : n.slot.worktree,o.commit ?? 'HEAD');
  if (!await git.isAncestor(o.cwd,n.slot.base,commit)) throw new OwedError('submit commit must be a descendant of slot base');
  const facts = await git.candidateFacts(o.cwd,state.plan,state.plan.nodes.find(x => x.id === o.node)!,n.slot.base,commit,n.slot.attempt);
  return ledger.withLock(async () => { const current = (await load(ledger)).state; stable(state,current,o.node); const d: Draft = { kind:'submit', by:by(o), node:o.node, attempt:n.slot!.attempt, facts }; guard(current,d); return (await ledger.append([d]))[0]!; });
}
export async function attest(o: Context & { node: string; rerun?: boolean; signal?: AbortSignal }): Promise<AttestResult> {
  checkAbort(o.signal); const ledger = await Ledger.open(o.cwd);
  return ledger.withLock(async () => {
    const { state } = await load(ledger), n = candidate(state,o.node), jobs = attestJobs(state,o.node);
    if (o.rerun) for (const c of state.plan.nodes.find(x => x.id === o.node)!.checks) for (const kind of ['check', ...(c.red ? ['red'] : [])] as ('check'|'red')[]) {
      const obligation = `${kind}:${c.id}`, key = n.candidate!.keys[obligation]!;
      if (!jobs.some(j => j.key === key && j.obligation === obligation)) jobs.push({kind,subject:o.node,obligation,key,spec:c,commit:n.candidate!.commit,base:n.slot!.base});
    }
    if (o.rerun && !jobs.some(j => j.obligation === 'writes' && j.key === n.candidate!.keys.writes)) jobs.push({ kind:'writes',subject:o.node,obligation:'writes',key:n.candidate!.keys.writes!,commit:n.candidate!.commit,base:n.slot!.base });
    const observations = await runJobs(o.cwd,ledger,state,[...genesisJobs(state),...jobs],o.node,o.signal), card = await why(o);
    return { node:o.node, observations, accepted:card.accepted, receipt:card };
  },'attest',o.signal);
}
/** `needs: 'parent'` marks a block that needs a parent ruling (D18); the ledger refuses it on an ok verdict. */
export async function review(o: Actor & { node: string; verdict:'ok'|'block'; rank:number; note:string; ack_rulings?:number; obligation?:'review'|'closure-review'; needs?:'parent' }): Promise<Entry> {
  return mutate(o,s => { const n = candidate(s,o.node), obligation = o.obligation ?? 'review'; return { kind:'review',by:by(o),channel:o.channel,node:o.node,attempt:n.slot!.attempt,obligation,key:n.candidate!.keys[obligation] ?? '',verdict:o.verdict,rank:o.rank,note:o.note,ack_rulings:o.ack_rulings,...(o.needs !== undefined ? { needs:o.needs } : {}) }; });
}
export async function waive(o: Actor & { node:string; obligation:string; reason:string; accept_risk?:number[]; channel:Channel }): Promise<Entry> { return mutate(o,s => ({kind:'waive',by:by(o),channel:o.channel,node:o.node,obligation:o.obligation,key:candidate(s,o.node).candidate!.keys[o.obligation] ?? '',reason:o.reason,accept_risk:o.accept_risk})); }
export async function defer(o: Actor & { node:string; items:{id:string;key:string}[]; reason:string; channel:Channel }): Promise<Entry> { return mutate(o,() => ({kind:'defer',by:by(o),channel:o.channel,node:o.node,items:o.items,reason:o.reason})); }
export async function abandon(o: Actor & { node:string; reason:string }): Promise<Entry> { return mutate(o,s => ({kind:'abandon',by:by(o),channel:o.channel,node:o.node,attempt:node(s,o.node).slot?.attempt ?? 0,reason:o.reason})); }
export interface RebaseResult { node: string; attempt: number; worktree: string; branch: string; base: string; from: string; previous?: { base: string; commit: string; submit: number }; packet: string; entry: Entry }
/** Moves the open slot of a node onto the current trunk (parent/owner or the slot writer); the writer then rebases the same worktree and submits again. */
export async function rebase(o: Actor & { node:string }): Promise<RebaseResult> {
  const entry = await mutate(o,s => { const n = node(s,o.node); if (!n.slot?.open) throw new OwedError(`Node ${o.node} has no open writer slot`); return {kind:'rebase',by:by(o),channel:o.channel,node:o.node,attempt:n.slot.attempt,base:s.trunk.commit,from:n.slot.base}; });
  if (entry.kind !== 'rebase') throw new OwedError('unexpected rebase entry','internal');
  const { state } = await load(await Ledger.open(o.cwd)), slot = state.nodes[o.node]!.slot!, previous = slot.rebase?.seq === entry.seq ? slot.rebase.previous : undefined;
  const packet = [`# Rebase ${o.node} attempt ${entry.attempt} (ledger #${entry.seq})`, `Working directory: ${slot.worktree}`, `Trunk moved: slot base ${entry.from} → ${entry.base}. The open candidate is invalidated; blocks still bind the node.`, `In the worktree run: git rebase --onto ${entry.base} ${entry.from}`, 'Resolve conflicts only; keep the change within the allowed writes and commit.', `Then run: owed submit ${o.node} (the commit must descend from ${entry.base})`, ...(previous ? [`Previously reviewed patch: ${previous.base}..${previous.commit} (submit #${previous.submit})`, `Re-review hint: git range-diff ${previous.base}..${previous.commit} ${entry.base}..<new commit>`] : [])].join('\n');
  return { node:o.node, attempt:entry.attempt, worktree:slot.worktree, branch:slot.branch, base:entry.base, from:entry.from, ...(previous ? { previous } : {}), packet, entry };
}
export async function merge(o: Actor & { node:string; signal?: AbortSignal }): Promise<MergeResult> {
  owner(o); if (!['owner','parent'].includes(o.as.role)) throw new OwedError('merge requires parent/owner');
  checkAbort(o.signal);
  const ledger = await Ledger.open(o.cwd);
  return ledger.withLock(async () => {
    const { state } = await load(ledger), n = candidate(state,o.node);
    if (!n.accepted) throw new OwedError(`Node ${o.node} current candidate is not yet accepted:${n.items.filter(i => i.status === 'D').map(i => i.obligation).join(', ')}`);
    { const drift = await git.trunkDrift(o.cwd,state.trunk.name,state.trunk.commit); if (drift) throw new OwedError(`trunk changed (CAS): ${driftText(drift)}`); }
    const built = await git.buildMerge(o.cwd,state.trunk.commit,n.candidate!.commit,`owed merge ${o.node}`);
    if ('conflicts' in built) throw new OwedError(`rebase needed: run owed rebase ${o.node}, then rebase the worktree and submit again`);
    const facts = await git.candidateFacts(o.cwd,state.plan,state.plan.nodes.find(x => x.id === o.node)!,state.trunk.commit,built.commit,n.slot!.attempt), sf = await git.stateFacts(o.cwd,state.plan,built.commit), m = {facts,state:sf};
    const observations: Draft[] = [];
    // An aborted run (D16) is not measured: undefined, and the merge stops before trunk moves.
    const measure = async (job: AttestJob) => { if (o.signal?.aborted) return undefined; const obs = await runJob({cwd:o.cwd,ledger,plan:state.plan,signal:o.signal},job); return o.signal?.aborted ? undefined : obs; };
    // Genesis jobs are not about this merge; merge-result jobs record the node being merged (decoy attribution).
    for (const job of genesisJobs(state)) { const obs = await measure(job); if (!obs) return abortWith(ledger,state,observations,o.node); observations.push(obs); }
    for (const job of mergeJobs(state,o.node,m)) { const obs = await measure(job); if (!obs) return abortWith(ledger,state,observations,o.node); observations.push({...obs,merging:o.node} as Draft); }
    return ledger.withLock(async () => {
      const latest = await load(ledger); stable(state,latest.state,o.node);
      // Evaluate the prospective observations without persisting them before CAS.
      // A moved ref must leave the ledger completely unchanged by this merge.
      const current = prospective(latest,observations);
      // Last abort point (D16): after it trunk moves and the merge entry must follow.
      if (o.signal?.aborted) { if (observations.length) await ledger.append(observations); throw aborted(); }
      const g = mergeGuard(current,o.node,m);
      if (!g.ok) { if (observations.length) await ledger.append(observations); throw new OwedError(g.reasons.join('; ')); }
      const d: Draft = {kind:'merge',by:'executor:owed',node:o.node,attempt:n.slot!.attempt,prior:state.trunk.commit,commit:built.commit,facts,state:sf}; guard(current,d);
      await git.advanceTrunk(o.cwd,state.trunk.name,state.trunk.commit,built.commit);
      const entry = (await ledger.append([...observations,d])).at(-1)!;
      return {node:o.node,...built,entry,deferred:g.invItems.filter(i => i.status === 'D')};
    },undefined,o.signal);
  },'merge',o.signal);
}
/** State after appending `observations` to the loaded ledger, without persisting them (each is guarded in turn). */
function prospective(latest: Awaited<ReturnType<typeof load>>, observations: Draft[]): State {
  const replay = [...latest.entries]; let current = latest.state;
  for (const obs of observations) {
    guard(current,obs);
    const entry = {...obs,seq:current.seq+1,ts:new Date().toISOString(),prev:current.head} as Entry;
    entry.hash=entryHash(entry); replay.push(entry); current=reduce(replay,latest.lookup);
  }
  return current;
}

// ---------- adopt: trunk commits made outside owed (SPEC §6.6) ----------
export interface AdoptPreview { trunk: string; prior: string; commit: string; commits: number; changed: string[] }
export interface AdoptResult extends AdoptPreview { entry: Entry; observations: Entry[] }
/** Preconditions of an adoption, checked before any ledger effect: commit = refs/heads/<trunk> ≠ ledger trunk, a fast-forward of it. */
async function adoptable(cwd: string, s: State, commit?: string): Promise<AdoptPreview> {
  const ref = `refs/heads/${s.trunk.name}`, prior = s.trunk.commit;
  const head = await git.git(cwd,['rev-parse','--verify','--quiet','--end-of-options',`${ref}^{commit}`],{allowFail:true});
  if (head.code) throw new OwedError(`${ref} does not exist; nothing to adopt`);
  const current = head.stdout.trim();
  let target = current;
  if (commit !== undefined) {
    const r = await git.git(cwd,['rev-parse','--verify','--quiet','--end-of-options',`${commit}^{commit}`],{allowFail:true});
    if (r.code) throw new OwedError(`${commit} is not a commit`,'usage');
    target = r.stdout.trim();
    if (target !== current) throw new OwedError(`adopt records only what is on trunk: ${commit} (${target.slice(0,12)}) is not ${ref} (${current.slice(0,12)})`);
  }
  if (target === prior) throw new OwedError(`nothing to adopt: ${ref} equals the ledger trunk ${prior.slice(0,12)}`);
  if ((await git.git(cwd,['cat-file','-e',`${prior}^{commit}`],{allowFail:true})).code) throw new OwedError(`ledger trunk ${prior} is missing from the repository; owed adopt cannot check that ${ref} is a fast-forward of it`);
  const ff = (await git.git(cwd,['merge-base','--is-ancestor',prior,target],{allowFail:true})).code === 0;
  if (!ff) throw new OwedError(`trunk was rewritten: the ledger trunk ${prior.slice(0,12)} is not an ancestor of ${ref} (${target.slice(0,12)}); owed adopt records only fast-forwards: restore ${ref} to a descendant of ${prior.slice(0,12)}`);
  return { trunk:s.trunk.name, prior, commit:target, commits:await git.countCommits(cwd,prior,target), changed:await git.changedPaths(cwd,prior,target) };
}
/** What `adopt` would record (no effect): for owner confirmation dialogs. */
export async function adoptPreview(o: Context & { commit?: string }): Promise<AdoptPreview> { const { state } = await load(await Ledger.open(o.cwd)); return adoptable(o.cwd,inited(state),o.commit); }
/**
 * Owner adoption of trunk commits made outside owed. Measures every invariant whose key changed on the adopted
 * commit; an invariant satisfied on the prior trunk but not on the adopted commit refuses the adoption (its
 * observations are recorded). Same lock/CAS discipline as merge: a moved ref or ledger records nothing, except after an
 * abort (D16a, SPEC §7.8): observations measured before it are recorded when the ledger is stable and they pass the
 * guard, without a ref check (abortWith).
 */
export async function adopt(o: Actor & { commit?: string; note: string; channel: Channel; signal?: AbortSignal }): Promise<AdoptResult> {
  owner(o); if (o.as.role !== 'owner') throw new OwedError('adopt requires owner: it records trunk changes that owed did not review');
  if (typeof o.note !== 'string' || !o.note.trim()) throw new OwedError('adopt requires a note','usage');
  checkAbort(o.signal);
  const ledger = await Ledger.open(o.cwd);
  return ledger.withLock(async () => {
    const { state } = await load(ledger); inited(state);
    const p = await adoptable(o.cwd,state,o.commit), sf = await git.stateFacts(o.cwd,state.plan,p.commit);
    const observations: Draft[] = [];
    for (const job of [...genesisJobs(state),...adoptJobs(state,sf)]) {
      if (o.signal?.aborted) return abortWith(ledger,state,observations);
      const obs = await runJob({cwd:o.cwd,ledger,plan:state.plan,signal:o.signal},job);
      if (o.signal?.aborted) return abortWith(ledger,state,observations);
      observations.push(obs);
    }
    return ledger.withLock(async () => {
      const latest = await load(ledger); stable(state,latest.state);
      const now = await git.git(o.cwd,['rev-parse','--verify','--quiet','--end-of-options',`refs/heads/${p.trunk}^{commit}`],{allowFail:true});
      if (now.code || now.stdout.trim() !== p.commit) throw new OwedError(`refs/heads/${p.trunk} moved during adopt (was ${p.commit.slice(0,12)}); nothing was recorded, run owed adopt again`);
      const current = prospective(latest,observations), g = adoptGuard(current,sf);
      if (o.signal?.aborted) { if (observations.length) await ledger.append(observations); throw aborted(); }
      if (!g.ok) {
        const appended = observations.length ? await ledger.append(observations) : [];
        // The observation that decides each failing invariant: the one just appended, else (a repeated adopt
        // measures nothing new) the latest existing one at the adopted state's key.
        const seqs = (id: string) => {
          const at = (e: Entry) => e.kind === 'obs' && e.subject === 'trunk' && e.obligation === `inv:${id}` && e.key === sf.invKeys[id];
          const fresh = appended.filter(at), old = latest.entries.findLast(at);
          return (fresh.length ? fresh : old ? [old] : []).map(e => `#${e.seq}`);
        };
        throw new OwedError(`adoption refused: ${g.failed.length ? `invariant${g.failed.length > 1 ? 's' : ''} ${g.failed.map(id => `${id}${seqs(id).length ? ` (obs ${seqs(id).join(', ')})` : ''}`).join(', ')} satisfied on the ledger trunk but not on ${p.commit.slice(0,12)}; fix trunk, then run owed adopt again. ` : ''}${g.reasons.filter(x => !g.failed.some(id => x.startsWith(`invariant ${id} new debt`))).join('; ')}`.replace(/[ ;.]+$/,''));
      }
      const d: Draft = {kind:'adopt',by:by(o),channel:o.channel,trunk:p.trunk,prior:p.prior,commit:p.commit,state:sf,changed:p.changed,commits:p.commits,note:o.note}; guard(current,d);
      const appended = await ledger.append([...observations,d]);
      return {...p,entry:appended.at(-1)!,observations:appended.slice(0,-1)};
    },undefined,o.signal);
  },'merge',o.signal);
}
export async function status(o: Context): Promise<StatusView> {
  const {state,entries} = await load(await Ledger.open(o.cwd)), view = statusView(inited(state),entries);
  const drift = await git.trunkDrift(o.cwd,state.trunk.name,state.trunk.commit), trunkWorktree = await git.trunkElsewhere(o.cwd,state.trunk.name);
  return {...view,...(drift ? {drift} : {}),...(trunkWorktree ? {trunkWorktree} : {})};
}
export async function why(o: Context & {node:string}): Promise<ReceiptCard> { const {state,entries} = await load(await Ledger.open(o.cwd)); node(state,o.node); return receipt(state,entries,o.node); }
export async function report(o: Context & {since?:number|string}): Promise<Report> {
  const {state,entries,lookup} = await load(await Ledger.open(o.cwd)), since = o.since ?? -1; inited(state);
  if (typeof since === 'string' && !Number.isFinite(Date.parse(since))) throw new OwedError('since must be a seq or ISO timestamp','usage');
  const included = (e: {seq:number;ts?:string}) => typeof since === 'number' ? e.seq > since : Date.parse(e.ts ?? entries[e.seq]?.ts ?? '') > Date.parse(since);
  const recent = entries.filter(included), before = reduce(entries.filter(e => !included(e)),lookup), old = [...Object.values(before.nodes).flatMap(n => n.items),...before.invariants];
  const items = [...Object.values(state.nodes).flatMap(n => n.items),...state.invariants];
  return {escapes:escapeSummary(state),since,merges:recent.filter(e => e.kind === 'merge'),waivers:recent.filter(e => e.kind === 'waive'),blocks:Object.keys(state.nodes).flatMap(id => receipt(state,entries,id).blocks).filter(included),downgrades:state.downgrades.filter(included),rulings:state.rules.filter(included),decisions:items.filter(i => i.status === 'D' && i.discharger === 'owner'),ownerActions:recent.filter(e => e.by.startsWith('owner:') && e.kind !== 'adopt'),adoptions:state.adoptions.filter(included),halts:entries.filter((e): e is HaltEntry => e.kind === 'halt').map(e => ({...e,active:halted(state,e.node)?.seq === e.seq})).filter(e => e.active || included(e)),changes:items.flatMap(i => { const prev = old.find(p => p.subject === i.subject && p.obligation === i.obligation); return prev?.status === i.status && prev.key === i.key ? [] : [{subject:i.subject,obligation:i.obligation,before:prev?.status,after:i.status}]; })};
}
export async function verify(o: Context): Promise<VerifyResult> { try { const {entries,state} = await load(await Ledger.open(o.cwd)); return {ok:true,entries:entries.length,head:state.head}; } catch (e) { return {ok:false,entries:0,error:e instanceof Error ? e.message : String(e)}; } }
/** Morning brief: owner decisions, merges since `since` (seq or ISO time), active blocks, work in progress and totals. */
export async function brief(o: Context & {since?:number|string; now?:number}): Promise<Brief> {
  const {state,entries} = await load(await Ledger.open(o.cwd)), since = o.since ?? -1; inited(state);
  if (typeof since === 'string' && !Number.isFinite(Date.parse(since))) throw new OwedError('since must be a seq or ISO timestamp','usage');
  return briefView(state,entries,since,o.now ?? Date.now());
}

// ---------- driver entries (SPEC §12, D3): persisted before the dsa call ----------
/**
 * Records the intent to start a dsa run (role parent; the driver is `parent:drive`). `spec` is the exact spec JSON
 * bytes, stored as a blob. Idempotent: a launch already recorded with the same rid, node, attempt, role, spec bytes
 * and labels is returned with `created: false`; a different one is refused (a request conflict).
 */
export async function launch(o: Actor & { node: string; attempt: number; role: RunRole; rid: string; spec: string; labels: Record<string, string> }): Promise<{ entry: LaunchEntry; created: boolean }> {
  owner(o); const ledger = await Ledger.open(o.cwd), spec = await ledger.putBlob(o.spec);
  return ledger.withLock(async () => {
    const { state, entries } = await load(ledger);
    const prior = entries.find((e): e is LaunchEntry => e.kind === 'launch' && e.rid === o.rid);
    if (prior) {
      if (prior.node !== o.node || prior.attempt !== o.attempt || prior.role !== o.role || prior.spec !== spec || canonical(prior.labels) !== canonical(o.labels)) throw new OwedError(`launch ${o.rid} is already recorded (#${prior.seq}) with other content`);
      return { entry: prior, created: false };
    }
    const d: Draft = { kind: 'launch', by: by(o), channel: o.channel, node: o.node, attempt: o.attempt, role: o.role, rid: o.rid, spec, labels: o.labels };
    guard(state, d); return { entry: (await ledger.append([d]))[0] as LaunchEntry, created: true };
  });
}
/** Records the intent to send `message` (exact bytes, stored as a blob) to run `rid`; the send id `${rid}:${sendKind}:${seq}` is assigned under the lock. */
export async function send(o: Actor & { node: string; attempt: number; rid: string; sendKind: SendKind; message: string; reason: SendReason }): Promise<SendEntry> {
  owner(o); const ledger = await Ledger.open(o.cwd), message = await ledger.putBlob(o.message);
  return ledger.withLock(async () => {
    const { state } = await load(ledger);
    const d: Draft = { kind: 'send', by: by(o), channel: o.channel, node: o.node, attempt: o.attempt, rid: o.rid, send: `${o.rid}:${o.sendKind}:${state.seq + 1}`, sendKind: o.sendKind, message, reason: o.reason };
    guard(state, d); return (await ledger.append([d]))[0] as SendEntry;
  });
}
/** Stops the driver on the node's current attempt until a later non-driver entry on the node or a new attempt. */
export async function halt(o: Actor & { node: string; attempt: number; reason: string; needs: 'human' | 'owner' }): Promise<HaltEntry> {
  return await mutate(o, () => ({ kind: 'halt', by: by(o), channel: o.channel, node: o.node, attempt: o.attempt, reason: o.reason, needs: o.needs })) as HaltEntry;
}

// ---------- escapes and decoys ----------
export async function escape(o: Actor & { node:string; merge:number; class:EscapeClass; note:string; evidence?:string }): Promise<Entry> { return mutate(o,() => ({kind:'escape',by:by(o),channel:o.channel,node:o.node,merge:o.merge,class:o.class,note:o.note,evidence:o.evidence})); }
/** Parses a reveal payload file; only {nonce, decoys:[{node, defect}]} is kept. */
export function decoyPayload(text: string): DecoyPayload {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new OwedError('decoy file must be JSON {nonce, decoys:[{node, defect}]}','usage'); }
  const errors = decoyPayloadErrors(value); if (errors.length) throw new OwedError(errors.join('; '),'usage');
  const p = value as DecoyPayload; return { nonce:p.nonce, decoys:p.decoys.map(x => ({node:x.node,defect:x.defect})) };
}
/** Helper: the digest to commit for a reveal payload. Writes nothing. */
export function decoyDigest(text: string): { digest: string } { return { digest:digestOf(decoyPayload(text)) }; }
export async function decoyCommit(o: Actor & { digest:string; channel:Channel }): Promise<Entry> { return mutate(o,() => ({kind:'decoy-commit',by:by(o),channel:o.channel,digest:o.digest})); }
export async function decoyReveal(o: Actor & { payload:string; channel:Channel }): Promise<Entry> { const p = decoyPayload(o.payload); return mutate(o,() => ({kind:'decoy-reveal',by:by(o),channel:o.channel,...p})); }
// ---------- gc: reclaim worktrees and branches of finished attempts (SPEC §8) ----------
import { realpath, stat } from 'node:fs/promises';
export interface GcItem { node: string; attempt: number; worktree: string | null; branch: string | null; pinned: string[] }
export interface GcKept { node: string; attempt: number; worktree: string; branch: string; reason: string }
export interface GcResult { dryRun: boolean; removed: GcItem[]; kept: GcKept[]; entry?: Entry }
async function real(path: string): Promise<string> { try { return await realpath(path); } catch { return resolve(path); } }
async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }
/** Ref that keeps the commit of submit entry `seq` reachable after its branch is deleted (attribution reruns need it). */
export const keepRef = (node: string, attempt: number, seq: number): string => `refs/owed/keep/${node}/${attempt}/${seq}`;
export async function gc(o: Context & { dryRun?: boolean; as?: Principal; channel?: Channel }): Promise<GcResult> {
  const actor: Actor = { cwd: o.cwd, as: o.as ?? { role: 'parent', id: 'cli' }, channel: o.channel }, dryRun = !!o.dryRun;
  owner(actor); if (!['owner','parent'].includes(actor.as.role)) throw new OwedError('gc requires parent/owner');
  // Run git from the main worktree: cwd may be (inside) a worktree that gc removes. Resolved before any effect.
  const root = await git.mainRoot(o.cwd), ledger = await Ledger.open(o.cwd);
  // The dispatch lock serializes gc with worktree/branch creation by dispatch.
  return ledger.withLock(async () => {
    const { state, entries } = await load(ledger); inited(state);
    const openTrees = await Promise.all(Object.values(state.nodes).filter(n => n.slot?.open).map(n => real(n.slot!.worktree)));
    // Stale registrations (directory deleted by hand) would otherwise pin their branches.
    if (!dryRun) await git.git(root, ['worktree', 'prune']);
    const trees = await Promise.all((await git.listWorktrees(root)).filter(w => !w.prunable).map(async w => ({ ...w, path: await real(w.path) })));
    const removed: GcItem[] = [], kept: GcKept[] = [];
    for (const d of entries) {
      if (d.kind !== 'dispatch') continue;
      const keep = (reason: string) => { kept.push({ node: d.node, attempt: d.attempt, worktree: d.worktree, branch: d.branch, reason }); };
      const path = await real(d.worktree), tree = trees.find(w => w.path === path), hasBranch = await git.branchExists(root, d.branch), onDisk = await exists(d.worktree);
      const slot = state.nodes[d.node]?.slot;
      if (slot?.open && slot.attempt === d.attempt) { if (tree || hasBranch || onDisk) keep('open writer slot'); continue; }
      if (tree?.locked) { keep('worktree is locked'); continue; }
      // A worktree nested by an older dispatch inside this one would be deleted with it.
      const inner = [...openTrees, ...trees.map(w => w.path)].find(p => p !== path && p.startsWith(`${path}/`));
      if (onDisk && inner) { keep(`contains worktree ${inner}`); continue; }
      if (tree && !await git.isClean(tree.path)) { keep('worktree is dirty (uncommitted or untracked changes)'); continue; }
      // Pin every submitted commit that trunk does not already reach, before its branch can go.
      const pins: { ref: string; commit: string }[] = []; let lost = '';
      for (const e of entries) if (e.kind === 'submit' && e.node === d.node && e.attempt === d.attempt) {
        const ref = keepRef(d.node, d.attempt, e.seq), commit = e.facts.commit;
        if ((await git.git(root, ['rev-parse', '--verify', '--quiet', ref], { allowFail: true })).code === 0) continue;
        if ((await git.git(root, ['cat-file', '-e', `${commit}^{commit}`], { allowFail: true })).code) { lost ||= `submitted commit ${commit} (#${e.seq}) is no longer in the repository`; continue; }
        if (!await git.isAncestor(root, commit, state.trunk.commit)) pins.push({ ref, commit });
      }
      if (lost) keep(lost);
      const pinned: string[] = [];
      for (const p of pins) {
        if (!dryRun) { const r = await git.git(root, ['update-ref', p.ref, p.commit, ''], { allowFail: true }); if (r.code) { keep(`git update-ref ${p.ref} failed: ${r.stderr.trim()}`); break; } }
        pinned.push(p.ref);
      }
      if (pinned.length !== pins.length) { if (pinned.length) removed.push({ node: d.node, attempt: d.attempt, worktree: null, branch: null, pinned }); continue; }
      let worktree: string | null = null, branch: string | null = null;
      if (tree) {
        if (!dryRun) { const r = await git.git(root, ['worktree', 'remove', tree.path], { allowFail: true }); if (r.code) { keep(`git worktree remove failed: ${r.stderr.trim()}`); if (pinned.length) removed.push({ node: d.node, attempt: d.attempt, worktree, branch, pinned }); continue; } }
        worktree = d.worktree;
      } else if (onDisk) keep('path exists but is not a registered git worktree; left untouched');
      if (hasBranch) {
        const user = trees.find(w => w.branch === `refs/heads/${d.branch}` && w.path !== path);
        if (user) keep(`branch is checked out in ${user.path}`);
        else if (dryRun) branch = d.branch;
        else { const r = await git.git(root, ['branch', '-D', d.branch], { allowFail: true }); if (r.code) keep(`git branch -D failed: ${r.stderr.trim()}`); else branch = d.branch; }
      }
      if (worktree || branch || pinned.length) removed.push({ node: d.node, attempt: d.attempt, worktree, branch, pinned });
    }
    if (dryRun || !removed.length) return { dryRun, removed, kept };
    await git.git(root, ['worktree', 'prune']);
    const text = `gc removed ${removed.map(i => `${i.node}#${i.attempt} (${[i.worktree && `worktree ${i.worktree}`, i.branch && `branch ${i.branch}`, ...i.pinned.map(r => `pinned ${r}`)].filter(Boolean).join(', ')})`).join('; ')}`;
    const entry = await ledger.withLock(async () => { const current = (await load(ledger)).state; const d: Draft = { kind: 'note', by: by(actor), channel: actor.channel, text }; guard(current, d); return (await ledger.append([d]))[0]!; });
    return { dryRun, removed, kept, entry };
  }, 'dispatch');
}
