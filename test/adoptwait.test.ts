import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, access, rm, mkdir, readdir, chmod } from 'node:fs/promises';
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
import { clockTime } from '../src/clock.ts';

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
  const ledger = await Ledger.open(r.cwd), pendingDir = join(ledger.dir,'adopt-pending');
  await mkdir(pendingDir,{recursive:true});
  const pending = join(pendingDir,`${hostname()}-${process.pid}.json`);
  return {...r,ledger,pending,pendingDir};
}
async function pendingFiles(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter(f=>f.endsWith('.json'));
}
async function hold(ledger: Ledger, activity = 'merge X', name = 'merge'): Promise<() => Promise<void>> {
  let release!: () => void, acquired!: () => void;
  const gate = new Promise<void>(r=>{release=r;}), got = new Promise<void>(r=>{acquired=r;});
  // Activity options are optional on the old base; the red run exercises its old behavior too.
  const done = ledger.withLock(async()=>{acquired();await gate;},name,undefined,{activity});
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
    assert.equal(Date.parse(marker.until)-Date.parse(marker.since),62_000);
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
    assert.deepEqual(await pendingFiles(f.pendingDir),[]); assert.deepEqual(await f.ledger.read(),before);
    for (const wait of ['-1','NaN','Infinity','']) {
      const bad = await cli(f.cwd,['adopt','--note','hotfix','--wait',wait]);
      assert.equal(bad.code,2,`invalid wait ${wait}: ${bad.stderr}`);
    }
    const done = cli(f.cwd,['adopt','--note','hotfix','--wait','2','--no-lease']);
    await until(async()=>(await pendingFiles(f.pendingDir)).length === 1,'CLI waits with a pending marker');
    await release(); const out = await done; assert.equal(out.code,0,out.stderr);
    assert.deepEqual(await pendingFiles(f.pendingDir),[]);
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
    const marker = {pid:process.pid,host:hostname(),commit:(await ops.readState(f)).state.trunk.commit,since:'2026-10-15T09:23:00.000Z',until:new Date(Date.now()+60_000).toISOString()};
    await writeFile(f.pending,JSON.stringify(marker));
    const before = await f.ledger.read();
    const pass = await driver.pass(); await driver.settle();
    assert.equal(pass.actions.some(a=>a.do==='merge' && a.outcome==='started'),false);
    assert.equal((await ops.readState(f)).state.nodes.a!.merged,undefined);
    assert.deepEqual(await f.ledger.read(),before);
    assert.ok(renderStatus(await ops.status(f)).includes(`merge waiting for adopt (pending since ${clockTime(marker.since)})`));
    assert.ok(lines.some(l=>l.includes(`merge waiting for adopt (pending since ${clockTime(marker.since)})`)),lines.join('\n'));
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

test('AW #2090: expired foreign and undated markers never block; live markers name the oldest', {timeout:90_000}, async()=>{
  const f = await fixture(), lines: string[] = [], driver = new Driver({...f,dsa:new Client(),log:l=>lines.push(l),handleSignals:false});
  try {
    await candidate(f);
    const now = Date.now(), commit = (await ops.readState(f)).state.trunk.commit;
    const oldest = {pid:1234,host:'foreign.invalid',commit,since:new Date(now-120_000).toISOString(),until:new Date(now+60_000).toISOString()};
    const newest = {...oldest,pid:process.pid,host:hostname(),since:new Date(now-30_000).toISOString()};
    const foreign = join(f.pendingDir,'foreign.invalid-1234.json');
    await writeFile(foreign,JSON.stringify(oldest));await writeFile(f.pending,JSON.stringify(newest));
    await driver.pass();await driver.settle();
    assert.equal((await ops.readState(f)).state.nodes.a!.merged,undefined);
    assert.match(renderStatus(await ops.status(f)),new RegExp(`pending since ${clockTime(oldest.since)}`));
    await writeFile(foreign,JSON.stringify({...oldest,until:new Date(now-1).toISOString()}));
    await driver.pass();await driver.settle();
    assert.equal((await ops.readState(f)).state.nodes.a!.merged,undefined,'another live request still blocks');
    assert.ok(lines.some(l=>l.includes(`pending since ${clockTime(newest.since)}`)));
    // Missing until is stale even for a live local PID. Expired foreign remains on disk.
    const {until:_,...oldFormat} = newest;
    await writeFile(f.pending,JSON.stringify(oldFormat));
    await writeFile(join(f.ledger.dir,'adopt-pending.json'),JSON.stringify(oldFormat));
    await driver.pass();await driver.settle();driver.tick();await driver.pass();await driver.settle();
    assert.ok((await ops.readState(f)).state.nodes.a!.merged);
    assert.equal((await ops.status(f)).mergeWaiting,undefined);
  } finally {driver.abort.abort();await driver.settle();await f.cleanup();}
});

test('AW #2090: two concurrent CLI adopts share each request\'s 600ms total budget', {timeout:60_000}, async()=>{
  const f = await fixture(), releaseMerge = await hold(f.ledger), releaseLedger = await hold(f.ledger,'test commit blocker','lock');
  let outcomes: Promise<{code:number;stderr:string;pid:number;exited:number}[]> | undefined;
  try {
    await commitAt(f.cwd,{hotfix:'ok'});
    const before = await f.ledger.read();
    const exits = [1,2].map(() => new Promise<{code:number;stderr:string;pid:number;exited:number}>(resolve => {
      const entry = fileURLToPath(new URL('../bin/owed.js',import.meta.url));
      // Optional deterministic startup load reproduces #2299 without charging it to adopt's budget.
      const script = `await new Promise(r=>setTimeout(r,${Number(process.env.NITS022_STARTUP_DELAY_MS ?? 0)})); process.argv=[process.execPath,${JSON.stringify(entry)},'adopt','--note','hotfix','--wait','0.6','--no-lease']; await import(${JSON.stringify(entry)});`;
      const child = execFile(process.execPath,['--input-type=module','-e',script],{cwd:f.cwd,env:process.env,timeout:30_000},(error,_stdout,stderr)=>resolve({code:error ? Number(error.code) : 0,stderr,pid:child.pid!,exited:Date.now()}));
    }));
    outcomes = Promise.all(exits);
    await until(async()=>(await pendingFiles(f.pendingDir)).length === 2,'both adopters publish independent PID markers');
    const files = await pendingFiles(f.pendingDir);
    assert.notEqual(files[0],files[1]);
    const since = new Map<number,number>();
    for (const file of files) {
      const marker=JSON.parse(await readFile(join(f.pendingDir,file),'utf8'));
      since.set(marker.pid,Date.parse(marker.since));
      assert.equal(Date.parse(marker.until)-Date.parse(marker.since),60_600);
    }
    assert.equal(existsSync(join(f.ledger.dir,'adopt-queue')),false);
    await sleep(200);await releaseMerge();
    const results = await outcomes;
    // Each request is bounded by its own budget across both waits. Which lock exhausts it depends on scheduling:
    // if the later-started adopter wins the released merge lock, the earlier one times out on the merge lock
    // held by that adopter (#2812), not on the ledger lock. The lock name is incidental; the bound is the contract.
    const holders = new Set([process.pid,...results.map(r=>r.pid)]);
    for (const result of results) {
      assert.equal(result.code,75,result.stderr);
      const busy = /timed out waiting for the (merge|ledger) lock(?: held by pid (\d+))?/.exec(result.stderr);
      assert.ok(busy,result.stderr);
      if (busy[1] === 'merge' && busy[2] !== undefined) assert.ok(holders.has(Number(busy[2])),`merge lock holder ${busy[2]} is the test or the other adopter`);
      assert.ok(result.exited-since.get(result.pid)! <= 1600,'each request: 600ms total budget + 1s exit/scheduling allowance');
    }
    assert.deepEqual(await pendingFiles(f.pendingDir),[]);
    assert.deepEqual(await f.ledger.read(),before);
  } finally {await releaseMerge();await releaseLedger();await outcomes;await f.cleanup();}
});

test('AW #2090: omitted wait uses one default deadline for merge and ledger acquisition', {timeout:60_000}, async()=>{
  const f = await fixture(), releaseMerge = await hold(f.ledger), releaseLedger = await hold(f.ledger,'test commit blocker','lock'), prior = lockWait.ms;
  let outcome: Promise<unknown> | undefined;
  try {
    await commitAt(f.cwd,{hotfix:'ok'});lockWait.ms=600;
    const start = Date.now();
    outcome=adopt(f.cwd).catch(error=>error);
    await until(()=>existsSync(f.pending),'default-budget marker is published');
    const marker=JSON.parse(await readFile(f.pending,'utf8'));
    assert.equal(Date.parse(marker.until)-Date.parse(marker.since),60_600);
    await sleep(400);await releaseMerge();
    const error = await outcome as {code:string;message:string};
    assert.equal(error.code,'busy');assert.match(error.message,/ledger lock/);
    assert.ok(Date.now()-start < 1000,'ledger lock receives the remaining default budget');
    assert.equal(existsSync(f.pending),false);
  } finally {lockWait.ms=prior;await releaseMerge();await releaseLedger();await outcome;await f.cleanup();}
});

test('AW #2090: machine lease acquisition is bounded by the same adopt budget', {timeout:60_000}, async()=>{
  const f = await fixture(), bin = join(f.root,'waiting-dsa.sh'), pidFile = join(f.root,'waiting-pid');
  const previous = {OWED_DSA:process.env.OWED_DSA,OWED_LEASED:process.env.OWED_LEASED};
  let outcome: Promise<unknown> | undefined;
  try {
    const {state}=await ops.readState(f);
    await ops.planSet({cwd:f.cwd,as:parent,plan:JSON.stringify({...state.plan,lease:true})});
    await writeFile(bin,`#!/bin/sh\nprintf '%s' "$$" > '${pidFile}'\nexec sleep 30\n`);await chmod(bin,0o755);
    process.env.OWED_DSA=bin;delete process.env.OWED_LEASED;
    await commitAt(f.cwd,{hotfix:'ok'});
    const before=await f.ledger.read(), started=Date.now();
    outcome=adopt(f.cwd,{lease:true,wait:0.6}).catch(error=>error);
    await until(()=>existsSync(pidFile),'lease request is waiting');
    assert.equal(existsSync(f.pending),true);
    const error=await outcome as {code:string;message:string};
    assert.equal(error.code,'busy');assert.match(error.message,/machine lease.*adopt wait budget/);
    assert.ok(Date.now()-started<=1600,'lease wait obeys 600ms budget + 1s allowance');
    assert.deepEqual(await pendingFiles(f.pendingDir),[]);assert.deepEqual(await f.ledger.read(),before);
    const pid=Number(await readFile(pidFile,'utf8'));
    await until(()=>{try {process.kill(pid,0);return false;} catch {return true;}},'queued lease child is reaped');
  } finally {
    await outcome;
    for (const [key,value] of Object.entries(previous)) {if (value===undefined) delete process.env[key];else process.env[key]=value;}
    await f.cleanup();
  }
});

test('AW #2090: overlapping tool-process requests cannot remove each other\'s PID marker on abort', {timeout:60_000}, async()=>{
  const f = await fixture(), release = await hold(f.ledger), first = new AbortController(), second = new AbortController();
  let a: Promise<unknown> | undefined, b: Promise<unknown> | undefined;
  try {
    await commitAt(f.cwd,{hotfix:'ok'});
    a=adopt(f.cwd,{wait:2,signal:first.signal}).catch(error=>error);
    await until(()=>existsSync(f.pending),'first process-local request published');
    b=adopt(f.cwd,{wait:3,signal:second.signal}).catch(error=>error);
    await sleep(30);first.abort();assert.equal((await a as {code:string}).code,'aborted');
    assert.equal(existsSync(f.pending),true,'second request still owns a marker');
    const marker=JSON.parse(await readFile(f.pending,'utf8'));
    assert.equal(Date.parse(marker.until)-Date.parse(marker.since),63_000);
    second.abort();assert.equal((await b as {code:string}).code,'aborted');
    assert.deepEqual(await pendingFiles(f.pendingDir),[]);
  } finally {first.abort();second.abort();await release();await a;await b;await f.cleanup();}
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
    await writeFile(f.pending,JSON.stringify({pid:process.pid,host:hostname(),commit:state.trunk.commit,since:new Date().toISOString(),until:new Date(Date.now()+60_000).toISOString()}));
    await driver.pass();
    assert.ok(driver.measuring.get('a'),'in-flight merge remains owned by driver');
    await writeFile(gate,''); await driver.settle();
    assert.ok((await ops.readState(f)).state.nodes.a!.merged,'running merge completes despite pending adopt');
  } finally {await writeFile(gate,'');await rm(f.pending,{force:true});driver.abort.abort();await driver.settle();await f.cleanup();}
});
