// WA1–WA4: real CLI/ops/driver regressions for the app 0.25 feedback.
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { acquireDriveLock } from '../src/drive-run.ts';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { decide as driveDecide } from '../src/drive.ts';
import { renderStatus, statusView } from '../src/views.ts';
import { revParse } from '../src/git.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const parent = { role:'parent', id:'test' } as const;
const owner = { role:'owner', id:'pi' } as const;
const plain = (id: string, writes = [`${id}.txt`]) => ({ id, writes, checks:[], review:{count:0,min_rank:1} });
const now = Date.parse('2026-10-16T12:00:00Z'); // Injected into the pure driver/view, no wall-clock waits.
type Repo = Awaited<ReturnType<typeof repo>>;
async function fixture(nodes = [plain('a'), plain('b')], extra = {}) {
  const r = await repo(), plan = { version:1, trunk:'main', lease:false, closure:[], invariants:[], nodes, ...extra };
  await commitAt(r.cwd, { README:'fixture' });
  const file = join(r.root,'plan.json');
  await writeFile(file,JSON.stringify(plan));
  await ops.init({cwd:r.cwd,as:owner,channel:'delegated',plan:JSON.stringify(plan)});
  await ops.planSet({cwd:r.cwd,as:parent,...await ops.readPlan({cwd:r.cwd,path:file})});
  return {...r,file};
}
const driveOpts = { max:4, repairs:2, project:'fixture', root:'/fixture', applied:new Set<string>(), rejected:new Map<string,string>(), now };
async function accept(r: Repo, id: string) {
  const d = await ops.dispatch({cwd:r.cwd,as:parent,node:id});
  await commitAt(d.worktree,{[`${id}.txt`]:id});
  await ops.submit({cwd:d.worktree,as:{role:'writer',id:`${id}#1`},node:id});
  assert.equal((await ops.attest({cwd:r.cwd,node:id})).accepted,true);
  return d;
}

// A deterministic concurrency boundary: record a real plan immediately before the batch reacquires its commit lock.
async function duringBatch(t: TestContext, r: Repo, change: (plan: Awaited<ReturnType<typeof ops.readState>>['state']['plan']) => object) {
  const original = Ledger.prototype.withLock;
  let injected = false, planSeq = -1;
  t.mock.method(Ledger.prototype,'withLock',async function(this: Ledger,...args: Parameters<Ledger['withLock']>) {
    // Identify the commit/guard callback, not attestTrunk's earlier nested locks.
    if (!injected && args[1] === undefined && String(args[0]).includes('batchGuard(')) {
      injected = true;
      const state = (await ops.readState(r)).state;
      const entry = await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',plan:JSON.stringify(change(state.plan)),note:'concurrent update'});
      planSeq = entry.seq;
    }
    return original.apply(this,args);
  });
  const outcome = await ops.mergeBatch({cwd:r.cwd,as:parent,nodes:['a','b']}).then(value => ({value,error:undefined}), error => ({value:undefined,error:String(error)}));
  t.mock.restoreAll();
  assert.equal(injected,true,'a plan was recorded at the final CAS boundary');
  return {...outcome,planSeq};
}

test('WA1: overlap reason and command agree with driver dispatch, including same-pass reservations',async () => {
  const r = await fixture([plain('a',['shared/']),plain('b',['shared/x'])]);
  try {
    await ops.dispatch({cwd:r.cwd,as:parent,node:'a'});
    const {state,entries} = await ops.readState(r);
    assert.ok(!driveDecide(state,state.plan,new Map(),driveOpts).some(a => a.do === 'dispatch' && a.node === 'b'));
    const why = await cli(r.cwd,['why','b']);
    assert.equal(why.code,0,why.stderr);
    assert.match(why.stdout,/ready, not dispatched: writes overlap a \(shared\/x\) → owed dispatch b --allow-overlap/);
    assert.doesNotMatch(why.stdout,/nothing outstanding/);
    assert.match(renderStatus(statusView(state,entries,[],now,true)),/b: ready, not dispatched: writes overlap a/);
    await assert.rejects(ops.dispatch({cwd:r.cwd,as:parent,node:'b'}),/overlap/);
    assert.ok(await ops.dispatch({cwd:r.cwd,as:parent,node:'b',allowOverlap:true}));
  } finally {await r.cleanup();}
  const samePass = await fixture([plain('a',['shared/']),plain('b',['shared/x'])]);
  try {
    const {state,entries} = await ops.readState(samePass);
    assert.deepEqual(driveDecide(state,state.plan,new Map(),driveOpts).filter(a => a.do === 'dispatch').map(a => a.node),['a']);
    assert.match(renderStatus(statusView(state,entries,[],now,true)),/b: ready, not dispatched: writes overlap a/);
  } finally {await samePass.cleanup();}
});

test('WA1: max reason agrees with driver and counts removed open slots',async () => {
  const r = await fixture(undefined,{drive:{max:1}});
  try {
    await ops.dispatch({cwd:r.cwd,as:parent,node:'a'});
    let {state,entries} = await ops.readState(r);
    assert.ok(!driveDecide(state,state.plan,new Map(),{...driveOpts,max:1}).some(a => a.do === 'dispatch'));
    const why = await cli(r.cwd,['why','b']);
    assert.equal(why.code,0,why.stderr);
    assert.match(why.stdout,/ready, not dispatched: 1 of max 1 attempts open/);
    assert.match(renderStatus(statusView(state,entries,[],now,true)),/b: ready, not dispatched: 1 of max 1 attempts open/);
    await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',plan:JSON.stringify({...state.plan,nodes:state.plan.nodes.filter(n => n.id !== 'a')}),note:'remove a'});
    ({state,entries} = await ops.readState(r));
    assert.equal(state.nodes.a!.phase,'removed');
    assert.ok(!driveDecide(state,state.plan,new Map(),{...driveOpts,max:1}).some(a => a.do === 'dispatch'));
    assert.match(renderStatus(statusView(state,entries,[],now,true)),/b: ready, not dispatched: 1 of max 1 attempts open/);
  } finally {await r.cleanup();}
});

test('WA1: status and why use the live driver max override instead of the plan max',async () => {
  const r = await fixture();
  try {
    await ops.dispatch({cwd:r.cwd,as:parent,node:'a'});
    const ledger = await Ledger.open(r.cwd), lock = await acquireDriveLock(ledger.dir,undefined,1);
    try {
      const why = await cli(r.cwd,['why','b']), status = await cli(r.cwd,['status']);
      assert.equal(why.code,0,why.stderr); assert.equal(status.code,0,status.stderr);
      assert.match(why.stdout,/ready, not dispatched: 1 of max 1 attempts open/);
      assert.match(status.stdout,/b: ready, not dispatched: 1 of max 1 attempts open/);
    } finally {await lock.release();}
    const why = await cli(r.cwd,['why','b']);
    assert.doesNotMatch(why.stdout,/max 1 attempts open/);
  } finally {await r.cleanup();}
});

test('WA2: bare path widens amend, authority unchanged, and removal refuses without effects',async () => {
  const r = await fixture();
  try {
    const before = await ops.readState(r), text = await readFile(r.file,'utf8');
    await assert.rejects(ops.amend({cwd:r.cwd,as:parent,node:'a',writes:['extra.txt'],note:'limit'}),/Only owner/);
    assert.equal((await ops.readState(r)).entries.length,before.entries.length);
    assert.equal(await readFile(r.file,'utf8'),text);
    const result = await cli(r.cwd,['amend','a','--writes','extra.txt','--note','one file','--as','owner:pi']);
    assert.equal(result.code,0,result.stderr);
    assert.deepEqual((await ops.readState(r)).state.plan.nodes[0]!.writes,['a.txt','extra.txt']);
    const count = (await ops.readState(r)).entries.length, changed = await readFile(r.file,'utf8');
    const negative = await cli(r.cwd,['decide','a','--writes','-a.txt','--text','not removal','--as','owner:pi']);
    assert.equal(negative.code,2); assert.match(negative.stderr,/removing writes needs owed plan/);
    assert.equal((await ops.readState(r)).entries.length,count);
    assert.equal(await readFile(r.file,'utf8'),changed);
    assert.equal((await ops.verify(r)).ok,true);
  } finally {await r.cleanup();}
});

test('WA2: covered prefixes and concrete glob matches are no-op amendments, not extra permissions',async () => {
  const r = await fixture([plain('a',['src/','test/*.ts']),plain('b')]);
  try {
    const before = await ops.readState(r), text = await readFile(r.file,'utf8');
    const result = await cli(r.cwd,['amend','a','--writes','+src/x.ts,+test/a.ts,+src/','--note','already owned','--as','parent:test']);
    assert.equal(result.code,0,result.stderr);
    assert.match(result.stdout,/writes unchanged/);
    assert.match(result.stdout,/src\/x.ts already covered by src\//);
    assert.match(result.stdout,/test\/a.ts already covered by test\/\*.ts/);
    assert.equal((await ops.readState(r)).entries.length,before.entries.length);
    assert.equal(await readFile(r.file,'utf8'),text);
    // Matching the literal bytes of a glob is not proof that it covers an entire new scope.
    const preview = await ops.amendPreview({cwd:r.cwd,node:'a',writes:['test/**/*.ts'],note:'wider scope'});
    assert.deepEqual(preview.added,['test/**/*.ts']);
    assert.deepEqual(preview.present,[]);
  } finally {await r.cleanup();}
});

test('WA2: all-covered bare decide records ruling, defer and resume but no plan or file write',async () => {
  const r = await fixture(undefined,{invariants:[{id:'unit',run:'true',reads:['a.txt','b.txt']}]});
  try {
    await accept(r,'a');
    await ops.halt({cwd:r.cwd,as:{role:'parent',id:'drive'},node:'a',attempt:1,reason:'decision needed',needs:'human'});
    const before = await ops.readState(r), text = await readFile(r.file,'utf8');
    const result = await ops.decide({cwd:r.cwd,as:owner,channel:'delegated',nodes:['a'],writes:['a.txt'],defer:'unit',text:'Keep current ownership'});
    assert.deepEqual(result.entries.map(e => e.kind),['defer','rule','resume']);
    assert.ok(result.entries.every(e => e.decision === result.decision));
    assert.equal(result.plan,undefined);
    assert.match(ops.decideText(result),/writes unchanged; a: a.txt already covered by a.txt; deferred unit; resumed/);
    const after = await ops.readState(r);
    assert.equal(after.state.planSha,before.state.planSha);
    assert.equal(after.state.nodes.a!.halt,undefined);
    assert.equal(after.state.deferred.length,1);
    assert.equal(await readFile(r.file,'utf8'),text);
    assert.equal((await ops.verify(r)).ok,true);
  } finally {await r.cleanup();}
});

test('WA2: multi-node additions drop covered paths per node and describe unequal additions',async () => {
  const r = await fixture([plain('a',['shared/']),plain('b',['shared/x'])]);
  try {
    const result = await cli(r.cwd,['decide','a,b','--writes','shared/x,extra.txt','--text','same new file','--as','owner:pi']);
    assert.equal(result.code,0,result.stderr);
    assert.match(result.stdout,/a: shared\/x already covered by shared\//);
    assert.match(result.stdout,/b: shared\/x already covered by shared\/x/);
    assert.deepEqual((await ops.readState(r)).state.plan.nodes.map(n => n.writes),[['shared/','extra.txt'],['shared/x','extra.txt']]);
    const before = await ops.readState(r), text = await readFile(r.file,'utf8');
    await assert.rejects(ops.decide({cwd:r.cwd,as:owner,channel:'delegated',nodes:['a','b'],writes:['shared/y','z.txt'],text:'split required'}),e => {
      assert.match(String(e),/a: covered \[shared\/y already covered by shared\/\]; added \[z.txt\]/);
      assert.match(String(e),/b: covered \[\]; added \[shared\/y, z.txt\]/);
      return true;
    });
    assert.equal((await ops.readState(r)).entries.length,before.entries.length);
    assert.equal(await readFile(r.file,'utf8'),text);
    assert.equal((await ops.verify(r)).ok,true);
  } finally {await r.cleanup();}
});

test('WA3: status default hides clean conflict pairs, full and JSON retain them, unknown and paths remain',async () => {
  const r = await fixture();
  try {
    await accept(r,'a'); await accept(r,'b');
    const status = await cli(r.cwd,['status']);
    assert.equal(status.code,0,status.stderr);
    assert.doesNotMatch(status.stdout,/conflicts with .*: none/);
    const full = await cli(r.cwd,['status','--full']);
    assert.equal(full.code,0,full.stderr);
    assert.match(full.stdout,/conflicts with trunk: none/);
    const json = await cli(r.cwd,['status','--json']);
    assert.equal(json.code,0,json.stderr);
    assert.deepEqual(JSON.parse(json.stdout).conflicts.a.trunk,[]);
    const view = await ops.status(r);
    view.conflicts = {a:{trunk:[],b:['shared/x'],other:null}};
    const text = renderStatus(view);
    assert.doesNotMatch(text,/conflicts with trunk: none/);
    assert.match(text,/a: conflicts with b: shared\/x/);
    assert.match(text,/a: conflicts with other: unknown; retry owed status/);
  } finally {await r.cleanup();}
});

test('WA4: unrelated node plan change during batch permits members to merge under latest state',async t => {
  const r = await fixture([plain('a'),plain('b'),plain('other')]);
  try {
    await accept(r,'a'); await accept(r,'b');
    const outcome = await duringBatch(t,r,p => ({...p,nodes:p.nodes.map(n => n.id === 'other' ? {...n,brief:'new unrelated brief',writes:['other/']} : n)}));
    assert.equal(outcome.error,undefined,outcome.error);
    assert.deepEqual(outcome.value?.nodes,['a','b']);
    const after = await ops.readState(r);
    assert.equal(after.state.nodes.a!.phase,'merged'); assert.equal(after.state.nodes.b!.phase,'merged');
    assert.equal(after.state.plan.nodes.find(n => n.id === 'other')!.brief,'new unrelated brief');
    assert.equal(await revParse(r.cwd,'main'),outcome.value!.commit);
    assert.deepEqual(after.entries.filter(e => e.kind === 'merge').map(e => e.node),['a','b']);
    assert.equal((await ops.verify(r)).ok,true);
  } finally {t.mock.restoreAll();await r.cleanup();}
});

test('WA4: member spec change refuses batch naming plan and changed member field',async t => {
  const r = await fixture();
  try {
    await accept(r,'a'); await accept(r,'b');
    const trunk = await revParse(r.cwd,'main');
    const outcome = await duringBatch(t,r,p => ({...p,nodes:p.nodes.map(n => n.id === 'a' ? {...n,brief:'different member contract'} : n)}));
    assert.match(outcome.error!,new RegExp(`plan #${outcome.planSeq} changed nodes.a.brief`));
    assert.equal(await revParse(r.cwd,'main'),trunk);
    assert.equal((await ops.readState(r)).entries.some(e => e.kind === 'merge'),false);
    assert.equal((await ops.verify(r)).ok,true);
  } finally {t.mock.restoreAll();await r.cleanup();}
});

test('WA4: invariant change refuses batch naming plan and invariants; trunk stays unchanged',async t => {
  const r = await fixture(undefined,{invariants:[{id:'unit',run:'true',reads:['a.txt','b.txt']}]});
  try {
    await accept(r,'a'); await accept(r,'b');
    const trunk = await revParse(r.cwd,'main');
    const outcome = await duringBatch(t,r,p => ({...p,invariants:p.invariants.map(i => ({...i,run:'false'}))}));
    assert.match(outcome.error!,new RegExp(`plan #${outcome.planSeq} changed invariants`));
    assert.equal(await revParse(r.cwd,'main'),trunk);
    assert.equal((await ops.readState(r)).entries.some(e => e.kind === 'merge'),false);
    assert.equal((await ops.verify(r)).ok,true);
  } finally {t.mock.restoreAll();await r.cleanup();}
});
