import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import { Ledger, lockWait } from '../src/ledger.ts';
import { Driver } from '../src/drive-run.ts';
import { Dsa } from '../src/dsa.ts';
import { projectId, runId } from '../src/reducer.ts';
import { writerLaunch } from '../src/drive.ts';
import { renderStatus } from '../src/views.ts';
import owed from '../src/extension.ts';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const owner = {role:'owner',id:'pi'} as const;
const parent = {role:'parent',id:'test'} as const;
const sleep = (ms: number) => new Promise(r => setTimeout(r,ms));
async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const end = Date.now()+10_000;
  while (Date.now()<end) { if (await check()) return; await sleep(20); }
  assert.fail(label);
}
async function fixture(extra = {}) {
  const r = await repo();
  await commitAt(r.cwd,{seed:'base'});
  const plan = {version:1,trunk:'main',lease:false,closure:[],invariants:[],nodes:[{id:'a',writes:['a.txt'],checks:[],review:{count:0,min_rank:1}}],...extra};
  await ops.init({cwd:r.cwd,as:owner,channel:'delegated',plan:JSON.stringify(plan)});
  const ledger = await Ledger.open(r.cwd), pending = join(ledger.dir,'adopt-pending.json');
  return {...r,ledger,pending};
}
async function hold(ledger: Ledger, activity = 'merge X'): Promise<() => Promise<void>> {
  let release!: () => void, acquired!: () => void;
  const gate = new Promise<void>(r=>{release=r;}), got = new Promise<void>(r=>{acquired=r;});
  // Activity options are optional on the old base; the red run exercises its old behavior too.
  const done = ledger.withLock(async()=>{acquired();await gate;},'merge',undefined,{activity});
  await Promise.race([got,done]);
  return async()=>{release();await done;};
}
const adopt = (cwd: string, extra = {}) => ops.adopt({cwd,as:owner,channel:'delegated',note:'reviewed hotfix',lease:false,...extra});
async function candidate(f: Awaited<ReturnType<typeof fixture>>) {
  const slot = await ops.dispatch({...f,as:parent,node:'a'});
  const s = (await ops.readState(f)).state, project = projectId(s), built = writerLaunch(s,'a',project);
  await ops.launch({...f,as:parent,node:'a',attempt:1,role:'writer',rid:runId(project,'a',1,'writer'),spec:built.spec,labels:built.labels,rulings:0});
  await commitAt(slot.worktree,{'a.txt':'candidate'});
  await ops.submit({cwd:slot.worktree,as:{role:'writer',id:'a#1'},node:'a'});
  assert.equal((await ops.attest({...f,node:'a'})).accepted,true);
}
class Client extends Dsa {
  constructor() { super({bin:'/bin/true'}); }
  override async describe(rid: string) { return {rid,state:'sealed' as const,status:'ok' as const}; }
  override async inspect(rid: string) { return {view:await this.describe(rid)}; }
}

test('AW1: explicit wait overrides the default lock timeout and retains the adoption CAS', {timeout:60_000}, async()=>{
  const f = await fixture(), release = await hold(f.ledger), priorWait = lockWait.ms;
  const commit = await commitAt(f.cwd,{hotfix:'ok'});
  lockWait.ms = 25;
  const outcome = adopt(f.cwd,{wait:2}).then(value=>({value,error:undefined}),error=>({value:undefined,error}));
  try {
    await until(()=>existsSync(f.pending),'waiting adopt publishes its pending marker');
    const marker = JSON.parse(await readFile(f.pending,'utf8'));
    assert.deepEqual({pid:marker.pid,host:marker.host,commit:marker.commit},{pid:process.pid,host:hostname(),commit});
    assert.ok(Number.isFinite(Date.parse(marker.since)));
    await sleep(100); // exceeds only the shortened default, not the explicit two-second budget
    await release();
    const result = await outcome;
    assert.equal(result.error,undefined,String(result.error)); assert.equal(result.value?.commit,commit);
    assert.equal(existsSync(f.pending),false);
    assert.equal((await ops.verify(f)).ok,true);
  } finally {lockWait.ms=priorWait;await release();await outcome;await f.cleanup();}
});

test('AW1/AW2: CLI wait times out with lock activity, then succeeds after release; invalid waits refuse', {timeout:60_000}, async()=>{
  const f = await fixture(), release = await hold(f.ledger,'merge X: measuring inv:next-tests');
  try {
    await commitAt(f.cwd,{hotfix:'ok'});
    const before = await f.ledger.read();
    const busy = await cli(f.cwd,['adopt','--note','hotfix','--wait','0.01','--no-lease']);
    assert.equal(busy.code,75,busy.stderr);
    assert.match(busy.stderr,/merge lock held by pid .*\(merge X: measuring inv:next-tests since \d\d:\d\d\); retry/);
    assert.equal(existsSync(f.pending),false); assert.deepEqual(await f.ledger.read(),before);
    for (const wait of ['-1','NaN','Infinity','']) {
      const bad = await cli(f.cwd,['adopt','--note','hotfix','--wait',wait]);
      assert.equal(bad.code,2,`invalid wait ${wait}: ${bad.stderr}`);
    }
    const done = cli(f.cwd,['adopt','--note','hotfix','--wait','2','--no-lease']);
    await until(()=>existsSync(f.pending),'CLI waits with a pending marker');
    await release(); const out = await done; assert.equal(out.code,0,out.stderr);
    assert.equal(existsSync(f.pending),false);
  } finally {await release();await f.cleanup();}
});

test('AW1: adopt tool forwards wait to ops and cleans up on Busy', {timeout:60_000}, async()=>{
  const f = await fixture(), release = await hold(f.ledger);
  try {
    await commitAt(f.cwd,{hotfix:'ok'});
    const tools = new Map<string,ToolDefinition>();
    owed({registerTool:(tool:ToolDefinition)=>tools.set(tool.name,tool),registerCommand:()=>{},on:()=>{}} as unknown as ExtensionAPI);
    const tool = tools.get('owed_adopt')!;
    assert.ok(Object.hasOwn((tool.parameters as unknown as {properties:Record<string,unknown>}).properties,'wait'),'adopt tool declares the wait parameter');
    const result = await tool.execute('adopt',{cwd:f.cwd,note:'hotfix',wait:0.01,lease:false},undefined,undefined,{cwd:f.cwd,hasUI:false} as Parameters<ToolDefinition['execute']>[4]);
    assert.equal((result.details as {code?:string})?.code,'busy',JSON.stringify(result));
    assert.match(JSON.stringify(result),/merge lock/);
    assert.equal(existsSync(f.pending),false);
  } finally {await release();await f.cleanup();}
});

test('AW2: holder updates activity when an actual adopt invariant starts', {timeout:60_000}, async()=>{
  const r = await repo(), marker = join(r.root,'started'), gate = join(r.root,'release');
  try {
    await commitAt(r.cwd,{flag:'base'});
    await ops.init({cwd:r.cwd,as:owner,channel:'delegated',plan:JSON.stringify({version:1,trunk:'main',lease:false,nodes:[],invariants:[{id:'health',reads:['flag'],timeout_s:15,run:`if grep -q changed flag; then touch '${marker}'; while [ ! -f '${gate}' ]; do sleep .02; done; fi`}]})});
    await commitAt(r.cwd,{flag:'changed'});
    const ledger = await Ledger.open(r.cwd), outcome = adopt(r.cwd).then(value=>({value,error:undefined}),error=>({value:undefined,error}));
    try {
      await until(()=>existsSync(marker),'adopt invariant starts');
      const holder = JSON.parse(await readFile(join(ledger.dir,'merge','owner.json'),'utf8'));
      assert.equal(holder.activity,'adopt: measuring inv:health');
      assert.ok(Number.isFinite(Date.parse(holder.activitySince)));
      await writeFile(gate,''); assert.equal((await outcome).error,undefined);
    } finally {await writeFile(gate,'');await outcome;}
  } finally {await r.cleanup();}
});

test('AW3: driver yields new merges to live pending adopt, reports it, and ignores dead PID', {timeout:90_000}, async()=>{
  const f = await fixture(), lines: string[] = [], driver = new Driver({...f,dsa:new Client(),log:l=>lines.push(l),handleSignals:false});
  try {
    await candidate(f);
    const marker = {pid:process.pid,host:hostname(),commit:(await ops.readState(f)).state.trunk.commit,since:'2026-10-15T09:23:00.000Z'};
    await writeFile(f.pending,JSON.stringify(marker));
    const before = await f.ledger.read();
    const pass = await driver.pass(); await driver.settle();
    assert.equal(pass.actions.some(a=>a.do==='merge' && a.outcome==='started'),false);
    assert.equal((await ops.readState(f)).state.nodes.a!.merged,undefined);
    assert.deepEqual(await f.ledger.read(),before);
    assert.match(renderStatus(await ops.status(f)),/merge waiting for adopt \(pending since 09:23\)/);
    assert.ok(lines.some(l=>l.includes('merge waiting for adopt (pending since 09:23)')),lines.join('\n'));
    // Find a demonstrably dead PID, rather than depending on the machine's PID maximum.
    let dead = 99999999;
    for (;;) {try {process.kill(dead,0);dead--;} catch {break;}}
    await writeFile(f.pending,JSON.stringify({...marker,pid:dead}));
    assert.equal((await ops.status(f)).mergeWaiting,undefined,'stale pending status is hidden');
    // Malformed runtime metadata must not crash the driver while scheduling.
    await writeFile(f.pending,'null');
    await driver.pass(); await driver.settle();
    driver.tick();await driver.pass();await driver.settle();
    assert.ok((await ops.readState(f)).state.nodes.a!.merged,'dead marker never blocks a merge');
    assert.equal((await ops.verify(f)).ok,true);
  } finally {driver.abort.abort();await driver.settle();await f.cleanup();}
});

test('AW2: merge lock names the invariant during its nested trunk refresh', {timeout:60_000}, async()=>{
  const f = await fixture(), marker = join(f.root,'refresh-started'), gate = join(f.root,'refresh-go');
  try {
    await candidate(f);
    const {state} = await ops.readState(f);
    const plan = {...state.plan,invariants:[{id:'refresh',reads:['a.txt'],timeout_s:15,run:`touch '${marker}'; while [ ! -f '${gate}' ]; do sleep .02; done`}]};
    await ops.planSet({cwd:f.cwd,as:owner,channel:'delegated',note:'add invariant',plan:JSON.stringify(plan)});
    const outcome = ops.merge({cwd:f.cwd,as:parent,node:'a'}).then(value=>({value,error:undefined}),error=>({value:undefined,error}));
    try {
      await until(()=>existsSync(marker),'nested refresh is measuring');
      const holder = JSON.parse(await readFile(join(f.ledger.dir,'merge','owner.json'),'utf8'));
      assert.equal(holder.activity,'merge a: measuring inv:refresh');
      await writeFile(gate,''); assert.equal((await outcome).error,undefined);
    } finally {await writeFile(gate,'');await outcome;}
  } finally {await f.cleanup();}
});

test('AW3: abort while waiting cleans pending and records nothing; later refusal also cleans it', {timeout:60_000}, async()=>{
  const f = await fixture(), release = await hold(f.ledger), ac = new AbortController();
  try {
    await commitAt(f.cwd,{hotfix:'ok'}); const before = await f.ledger.read();
    const outcome = adopt(f.cwd,{signal:ac.signal,wait:10}).catch(error=>error);
    await until(()=>existsSync(f.pending),'abort test sees pending adopt');ac.abort();
    assert.equal((await outcome).code,'aborted'); assert.equal(existsSync(f.pending),false);
    assert.deepEqual(await f.ledger.read(),before);
    await release(); await adopt(f.cwd);
    await assert.rejects(adopt(f.cwd,{wait:0}),/nothing to adopt/);
    assert.equal(existsSync(f.pending),false);
    await assert.rejects(access(join(f.ledger.dir,'adopt-queue')));
  } finally {ac.abort();await release();await f.cleanup();}
});

test('AW3: a pending request does not abort a running merge', {timeout:90_000}, async()=>{
  const f = await fixture(), driver = new Driver({...f,dsa:new Client(),log:()=>{},handleSignals:false});
  const marker = join(f.root,'merge-started'), gate = join(f.root,'merge-go');
  try {
    await candidate(f);
    const state = (await ops.readState(f)).state;
    const plan = {...state.plan,invariants:[{id:'gate',reads:['a.txt'],timeout_s:20,run:`if test -f a.txt; then touch '${marker}'; while [ ! -f '${gate}' ]; do sleep .02; done; fi`}]};
    await ops.planSet({...f,as:owner,channel:'delegated',note:'add merge gate',plan:JSON.stringify(plan)});
    await driver.pass();await until(()=>existsSync(marker),'merge starts its invariant');
    const holder = JSON.parse(await readFile(join(f.ledger.dir,'merge','owner.json'),'utf8'));
    assert.equal(holder.activity,'merge a: measuring inv:gate');
    await writeFile(f.pending,JSON.stringify({pid:process.pid,host:hostname(),commit:state.trunk.commit,since:new Date().toISOString()}));
    await driver.pass();
    assert.ok(driver.measuring.get('a'),'in-flight merge remains owned by driver');
    await writeFile(gate,''); await driver.settle();
    assert.ok((await ops.readState(f)).state.nodes.a!.merged,'running merge completes despite pending adopt');
  } finally {await writeFile(gate,'');await rm(f.pending,{force:true});driver.abort.abort();await driver.settle();await f.cleanup();}
});
