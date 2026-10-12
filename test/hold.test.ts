// AH: hold/release and stale empty-slot cleanup, including the parent's compatibility ruling.
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { branchExists } from '../src/git.ts';
import { decide } from '../src/drive.ts';
import { Driver, stateOf, DRIVE_PRINCIPAL, wakeReport } from '../src/drive-run.ts';
import { Dsa, type RunResult } from '../src/dsa.ts';
import { parsePlan } from '../src/plan.ts';
import { reduce, reduceFrom, packState, unpackState, sameReplay, newerEntry, projectId, runId, runLabels, validateDraft } from '../src/reducer.ts';
import { renderReceipt, renderStatus, receipt, statusView } from '../src/views.ts';
import type { Entry, RunView } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const parent = { role:'parent', id:'main' } as const;
const owner = { role:'owner', id:'test' } as const;
const spec = (id:string, deps:string[] = []) => ({ id, deps, writes:[`${id}/`], checks:[], review:{ count:0, min_rank:1 } });
const plan = (dependent = true) => ({ version:1, trunk:'main', closure:[], invariants:[], lease:false, nodes:[spec('a'), spec('b',dependent ? ['a'] : [])] });
async function setup(dependent = true) {
  const r = await repo();
  await commitAt(r.cwd,{ README:'fixture\n' });
  await ops.init({ cwd:r.cwd, as:owner, channel:'delegated', plan:JSON.stringify(plan(dependent)) });
  return { ...r, async entries() { return (await Ledger.open(r.cwd)).read(); } };
}
function decisions(s:Awaited<ReturnType<typeof stateOf>>) {
  return decide(s,s.plan,new Map(),{ max:4, repairs:2, project:projectId(s), root:'/repo', applied:new Set(), rejected:new Map() });
}
const exists = async (path:string) => access(path).then(() => true, () => false);

class StubDsa extends Dsa {
  runs:string[] = [];
  hook?:() => Promise<void>;
  constructor() { super({ bin:'/nonexistent/dsa' }); }
  override async run(rid:string):Promise<RunResult> { this.runs.push(rid); return { outcome:'applied', wid:'w1', created:true, spec_digest:'x' }; }
  override async inspect(rid:string):Promise<{ view:RunView }> {
    const hook = this.hook; this.hook = undefined; await hook?.();
    return { view:{ rid, state:'running' } };
  }
}

test('AH1: abandon --hold appends an adjacent hold, blocks dispatch and dependencies, renders its abandon seq', async () => {
  const r = await setup();
  try {
    await ops.dispatch({ cwd:r.cwd, as:parent, node:'a' });
    const live = await stateOf(r.cwd);
    assert.ok(validateDraft(live,{ kind:'abandon', by:'parent:drive', node:'a', attempt:1, reason:'pretend stale' }).some(x => /live nodes are not stale/.test(x)));
    await assert.rejects(ops.abandon({ cwd:r.cwd, as:{ role:'writer', id:'a#1' }, node:'a', reason:'pause', hold:true }),/permissions/);
    const a = await ops.abandon({ cwd:r.cwd, as:parent, node:'a', reason:'pending decision', hold:true });
    const entries = await r.entries(), h = entries.at(-1)!;
    assert.equal(h.kind,'hold');
    assert.equal(h.seq,a.seq + 1);
    assert.equal(h.by,a.by);
    assert.equal(h.kind === 'hold' ? h.abandon : undefined,a.seq);
    const s = await stateOf(r.cwd);
    assert.equal(s.nodes.a!.phase,'held');
    assert.equal(s.nodes.a!.held,a.seq);
    assert.equal(s.nodes.a!.slot!.open,false);
    assert.equal(s.nodes.b!.phase,'blocked');
    assert.deepEqual(statusView(s,entries).ready,[]);
    assert.deepEqual(decisions(s),[]);
    assert.match(renderStatus(statusView(s,entries)),new RegExp(`a: held by abandon #${a.seq}`));
    assert.match(renderReceipt(receipt(s,entries,'a')),new RegExp(`held by abandon #${a.seq}; release with owed resume a`));
    await assert.rejects(ops.dispatch({ cwd:r.cwd, as:parent, node:'a' }),/held by abandon #\d+.*owed resume a/);
    assert.equal((await r.entries()).length,entries.length,'dispatch refusal records nothing');
    const driver = new Driver({ cwd:r.cwd, dsa:new StubDsa(), log:() => {}, session:null, handleSignals:false });
    assert.deepEqual((await driver.pass()).actions,[]);
  } finally { await r.cleanup(); }
});

test('AH1: resume releases a hold, preserves the attempt counter and permits dispatch of attempt 2', async () => {
  const r = await setup();
  try {
    await ops.dispatch({ cwd:r.cwd, as:parent, node:'a' });
    await ops.abandon({ cwd:r.cwd, as:owner, channel:'delegated', node:'a', reason:'pause', hold:true });
    const before = await r.entries();
    for (const as of [{ role:'writer', id:'a#1' }, { role:'reviewer', id:'r' }] as const) {
      await assert.rejects(ops.resume({ cwd:r.cwd, as, node:'a' }),/permissions|parent\/owner/);
    }
    await assert.rejects(ops.resume({ cwd:r.cwd, as:parent, node:'a', after:'b' }),/hold release does not take/);
    await assert.rejects(ops.resume({ cwd:r.cwd, as:parent, node:'a', expect:'report' }),/hold release does not take/);
    assert.equal((await r.entries()).length,before.length);
    const res = await ops.resume({ cwd:r.cwd, as:owner, channel:'delegated', node:'a', note:'keep working' });
    assert.equal(res.entry.kind,'resume');
    assert.equal(res.entry.kind === 'resume' ? res.entry.release : undefined,'hold');
    const s = await stateOf(r.cwd);
    assert.equal(s.nodes.a!.held,undefined);
    assert.equal(s.nodes.a!.phase,'ready');
    assert.equal(s.nodes.b!.phase,'blocked','release is not a merge');
    assert.ok(decisions(s).some(a => a.do === 'dispatch' && a.node === 'a'));
    const next = await ops.dispatch({ cwd:r.cwd, as:parent, node:'a' });
    assert.equal(next.attempt,2);
    assert.equal((await ops.resume({ cwd:r.cwd, as:parent, node:'a' })).entry.kind,'resume','normal open-slot resume still works');
  } finally { await r.cleanup(); }
});

test('AH1: removing a held node makes the hold moot; re-adding is ready; ordinary abandon retains 0.13 behavior', async () => {
  const r = await setup();
  try {
    await ops.dispatch({ cwd:r.cwd, as:parent, node:'a' });
    await ops.abandon({ cwd:r.cwd, as:parent, node:'a', reason:'pause', hold:true });
    const empty = { ...plan(), nodes:[] };
    await ops.planSet({ cwd:r.cwd, as:owner, channel:'delegated', note:'retire pending nodes', plan:JSON.stringify(empty) });
    let s = await stateOf(r.cwd);
    assert.equal(s.nodes.a!.phase,'removed');
    assert.equal(s.nodes.a!.held,undefined);
    await ops.planSet({ cwd:r.cwd, as:parent, plan:JSON.stringify(plan()) });
    s = await stateOf(r.cwd);
    assert.equal(s.nodes.a!.phase,'ready');
    await ops.dispatch({ cwd:r.cwd, as:parent, node:'a' });
    const count = (await r.entries()).length;
    const a = await ops.abandon({ cwd:r.cwd, as:parent, node:'a', reason:'retry' });
    assert.equal(a.kind,'abandon');
    assert.equal((await r.entries()).length,count+1);
    assert.equal((await stateOf(r.cwd)).nodes.a!.phase,'ready');
    await assert.rejects(ops.resume({ cwd:r.cwd, as:parent, node:'a' }),/requires an open slot/);
  } finally { await r.cleanup(); }
});

test('AH1: CLI --hold and pi hold flag work; resume text explicitly releases the hold', async () => {
  const r = await setup();
  try {
    await ops.dispatch({ cwd:r.cwd, as:parent, node:'a' });
    const out = await cli(r.cwd,['abandon','a','--hold','--note','pending']);
    assert.equal(out.code,0,out.stderr);
    assert.match(out.stdout,/held by abandon #\d+/);
    const res = await cli(r.cwd,['resume','a']);
    assert.equal(res.code,0,res.stderr);
    assert.match(res.stdout,/released abandon hold of a/);
    await ops.dispatch({ cwd:r.cwd, as:parent, node:'a' });
    const tools = new Map<string,ToolDefinition>();
    owed({ registerTool(t:ToolDefinition) { tools.set(t.name,t); }, registerCommand() {} } as unknown as ExtensionAPI);
    const ctx = { cwd:r.cwd, hasUI:false, ui:{ notify() {} } } as unknown as ExtensionContext;
    const call = async (name:string,args:Record<string,unknown>) => {
      const t = tools.get(`owed_${name}`)!;
      return t.execute('test',args,undefined,undefined,ctx as Parameters<ToolDefinition['execute']>[4]);
    };
    assert.ok('hold' in (tools.get('owed_abandon')!.parameters as { properties:object }).properties);
    await call('abandon',{ node:'a', hold:true, note:'pending in pi' });
    assert.equal((await stateOf(r.cwd)).nodes.a!.phase,'held');
    await call('resume',{ node:'a', note:'continue' });
    assert.equal((await stateOf(r.cwd)).nodes.a!.phase,'ready');
  } finally { await r.cleanup(); }
});

test('AH compatibility and validation: hold must follow its abandon; unknown abandon/release fields fail with version', async () => {
  const r = await setup();
  try {
    await ops.dispatch({ cwd:r.cwd, as:parent, node:'a' });
    const a = await ops.abandon({ cwd:r.cwd, as:parent, node:'a', reason:'pause', hold:true });
    const s = await stateOf(r.cwd);
    assert.ok(validateDraft(s,{ kind:'hold', by:'parent:main', node:'a', abandon:a.seq }).some(x => /immediately follow/.test(x)));
    assert.ok(validateDraft(s,{ kind:'resume', by:'parent:main', node:'a', attempt:2, release:'hold' }).some(x => /last attempt/.test(x)));
    assert.equal(newerEntry({ ...a, future:true } as unknown as Entry)?.code,'version');
    assert.equal(newerEntry({ ...a, hold:true } as unknown as Entry)?.code,'version','legacy unsafe field is not accepted');
    const h = (await r.entries()).at(-1)!;
    assert.equal(newerEntry(h),undefined);
    assert.equal(newerEntry({ ...h, future:true } as unknown as Entry)?.code,'version');
    const res = (await ops.resume({ cwd:r.cwd, as:parent, node:'a' })).entry;
    assert.equal(newerEntry({ ...res, release:'future' } as unknown as Entry)?.code,'version');
  } finally { await r.cleanup(); }
});

// Observe b between the driver's state load and launch of a: a deterministic stale-launch race.
async function race(cause:'removed'|'held'|'abandoned'|'changed', data:'empty'|'commit'|'dirty'|'launched'|'parent' = 'empty') {
  const r = await setup(false);
  const a = await ops.dispatch({ cwd:r.cwd, as:data === 'parent' ? parent : DRIVE_PRINCIPAL, node:'a' });
  await ops.dispatch({ cwd:r.cwd, as:DRIVE_PRINCIPAL, node:'b' });
  const s = await stateOf(r.cwd), project = projectId(s), B = runId(project,'b',1,'writer');
  await ops.launch({ cwd:r.cwd, as:DRIVE_PRINCIPAL, node:'b', attempt:1, role:'writer', rid:B, labels:runLabels(project,'b',1,'writer'), spec:'{}' });
  if (data === 'commit') await commitAt(a.worktree,{ 'a/x':'keep my commit\n' });
  if (data === 'dirty') await writeFile(join(a.worktree,'a-untracked'),'keep my edits\n');
  if (data === 'launched') await ops.launch({ cwd:r.cwd, as:DRIVE_PRINCIPAL, node:'a', attempt:1, role:'writer', rid:runId(project,'a',1,'writer'), labels:runLabels(project,'a',1,'writer'), spec:'{}' });
  const dsa = new StubDsa();
  dsa.hook = async () => {
    if (cause === 'removed' || cause === 'changed') {
      const p = plan(false);
      p.nodes = cause === 'removed' ? [spec('b')] : [ { ...spec('a'), title:'changed brief' } as ReturnType<typeof spec>, spec('b') ];
      await ops.planSet({ cwd:r.cwd, as:owner, channel:'delegated', note:'retire or change a', plan:JSON.stringify(p) });
    } else await ops.abandon({ cwd:r.cwd, as:parent, node:'a', reason:'pending decision', hold:cause === 'held' });
  };
  const driver = new Driver({ cwd:r.cwd, dsa, log:() => {}, session:null, handleSignals:false });
  return { ...r, a, dsa, driver };
}

for (const cause of ['removed','held','abandoned'] as const) test(`AH2: driver closes/removes its stale empty slot (${cause}) with no launch, halt or wake`, async () => {
  const r = await race(cause);
  try {
    const out = await r.driver.pass(), s = await stateOf(r.cwd), es = await r.entries();
    assert.equal(s.nodes.a!.slot!.open,false);
    assert.equal(await exists(r.a.worktree),false);
    assert.equal(await branchExists(r.cwd,r.a.branch),false);
    assert.deepEqual(r.dsa.runs,[]);
    assert.ok(out.actions.some(a => a.node === 'a' && a.do === 'launch' && a.outcome === 'stale'));
    assert.ok(!out.actions.some(wakeReport));
    assert.ok(!es.some(e => e.kind === 'halt'));
    assert.ok(!es.some(e => e.kind === 'launch' && e.node === 'a'));
    const abandons = es.filter(e => e.kind === 'abandon' && e.node === 'a');
    assert.equal(abandons.length,1,'already abandoned slot is not abandoned twice');
    if (cause === 'removed') {
      assert.equal(abandons[0]!.by,'parent:drive');
      assert.match(abandons[0]!.kind === 'abandon' ? abandons[0]!.reason : '',/stale writer launch: node left the plan/);
    }
    if (cause === 'held') assert.equal(s.nodes.a!.phase,'held');
  } finally { await r.cleanup(); }
});

for (const data of ['commit','dirty'] as const) test(`AH2: stale cleanup closes the slot but preserves ${data} and its branch`, async () => {
  const r = await race('removed',data);
  try {
    const out = await r.driver.pass();
    assert.equal((await stateOf(r.cwd)).nodes.a!.slot!.open,false);
    assert.equal(await exists(r.a.worktree),true);
    assert.equal(await branchExists(r.cwd,r.a.branch),true);
    assert.ok(!out.actions.some(wakeReport));
    assert.ok(await exists(join(r.a.worktree,data === 'commit' ? 'a/x' : 'a-untracked')));
  } finally { await r.cleanup(); }
});

test('AH2: cleanup never closes a parent-dispatched slot, or a slot with a writer launch intent', async () => {
  for (const data of ['parent','launched'] as const) {
    const r = await race('removed',data);
    try {
      await r.driver.pass();
      assert.equal(await ops.closeStaleSlot({ cwd:r.cwd, node:'a', attempt:1 }),undefined);
      assert.equal((await stateOf(r.cwd)).nodes.a!.slot!.open,true);
      assert.equal(await exists(r.a.worktree),true);
      assert.ok(!(await r.entries()).some(e => e.kind === 'abandon' && e.node === 'a'));
    } finally { await r.cleanup(); }
  }
});

test('AH2: a plan change that keeps the node live is stale but does not close its empty slot; wrong attempts are ignored', async () => {
  const r = await race('changed');
  try {
    const out = await r.driver.pass();
    assert.ok(out.actions.some(a => a.do === 'launch' && a.node === 'a' && a.outcome === 'stale'));
    assert.equal((await stateOf(r.cwd)).nodes.a!.slot!.open,true);
    assert.equal(await ops.closeStaleSlot({ cwd:r.cwd, node:'a', attempt:2 }),undefined);
    assert.ok(await exists(r.a.worktree));
    assert.deepEqual(r.dsa.runs,[]);
    await r.driver.pass();
    assert.equal(r.dsa.runs.length,1,'next pass launches normally');
  } finally { await r.cleanup(); }
});

test('AH2: launch refuses removed/abandoned attempts as stale even if decided after the retirement', async () => {
  const r = await setup();
  try {
    await ops.dispatch({ cwd:r.cwd, as:DRIVE_PRINCIPAL, node:'a' });
    await ops.abandon({ cwd:r.cwd, as:parent, node:'a', reason:'pause', hold:true });
    const s = await stateOf(r.cwd), P = projectId(s);
    await assert.rejects(ops.launch({ cwd:r.cwd, as:DRIVE_PRINCIPAL, node:'a', attempt:1, role:'writer', rid:runId(P,'a',1,'writer'), labels:runLabels(P,'a',1,'writer'), spec:'{}', since:s.seq }), e => (e as { code?:string }).code === 'stale');
    const count = (await r.entries()).length;
    assert.match((await ops.closeStaleSlot({ cwd:r.cwd, node:'a', attempt:1 }))!,/held/);
    assert.equal((await r.entries()).length,count);
    assert.equal(await exists((await stateOf(r.cwd)).nodes.a!.slot!.worktree),false);
  } finally { await r.cleanup(); }
});

test('AH persistence: held/released state survives packed snapshots and incremental replay without changing historical state', async () => {
  const r = await setup();
  try {
    const ledger = await Ledger.open(r.cwd);
    await ops.dispatch({ cwd:r.cwd, as:parent, node:'a' });
    await ops.abandon({ cwd:r.cwd, as:parent, node:'a', reason:'pause', hold:true });
    const heldEntries = await r.entries();
    const genesis = heldEntries[0]!;
    assert.equal(genesis.kind,'genesis');
    const p = parsePlan((await ledger.getBlob(genesis.kind === 'genesis' ? genesis.plan : '')).toString());
    const lookup = () => p, held = reduce(heldEntries,lookup);
    const packed = unpackState(structuredClone(packState(held)),lookup);
    assert.equal(packed.nodes.a!.phase,'held');
    assert.ok(sameReplay(held,packed));
    await ops.resume({ cwd:r.cwd, as:parent, node:'a' });
    const entries = await r.entries(), resumed = reduceFrom(packed,entries.slice(heldEntries.length),lookup);
    assert.equal(resumed.nodes.a!.phase,'ready');
    assert.equal(packed.nodes.a!.phase,'held','incremental replay does not mutate its source');
    assert.ok(sameReplay(resumed,reduce(entries,lookup)));
    const historical = reduce(heldEntries.slice(0,-1),lookup);
    assert.equal(historical.nodes.a!.phase,'ready','ordinary abandon replay remains 0.13 behavior');
    assert.ok(!('held' in historical.nodes.a!));
  } finally { await r.cleanup(); }
});
