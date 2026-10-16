// QS1/QS2/QS4/QS5: public plan/measurement/CLI behavior on real Git repositories.
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { parsePlan, planDowngrades, quarantineNames } from '../src/plan.ts';
import { stateFacts, git } from '../src/git.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';
import type { ObsEntry } from '../src/types.ts';

const owner = { role:'owner', id:'pi' } as const, parent = { role:'parent', id:'main' } as const;
const Q = [{ test:'z flaky', fix:'fix', note:'known race' }, { test:'a flaky', fix:'fix' }];
const plain = () => ({version:1, trunk:'main', closure:[], invariants:[] as object[], nodes:[{id:'fix', writes:['test/']}, {id:'work', writes:['src/']}]});
const shared = () => ({...plain(), quarantine_sets:{shared:Q}});
const observations = async (cwd:string) => (await (await Ledger.open(cwd)).read()).filter((e):e is ObsEntry => e.kind === 'obs');
const tap = `const {test}=require('node:test'); const fs=require('node:fs'); const assert=require('node:assert/strict');
test('a flaky',()=>assert.ok(!fs.existsSync(__dirname+'/broken')));
test('z flaky',()=>{}); test('normal',()=>{}); test('skipped', {skip:true},()=>{});`;
const run = 'node --test --test-reporter=tap test/suite.test.cjs';
async function init(cwd:string, plan:unknown, measure=false) { return ops.init({cwd, plan:JSON.stringify(plan), as:owner, channel:'delegated', measure}); }
async function candidate(cwd:string) {
  const d = await ops.dispatch({cwd, node:'work', as:parent});
  await commitAt(d.worktree, {'src/v':'1'});
  await ops.submit({cwd:d.worktree, node:'work', as:{role:'writer',id:'work#1'}});
  await ops.attest({cwd,node:'work'});
  return d;
}

// The recorder is an opaque script, not native excusal, even when it prints TAP.
const recorder = `const fs=require('node:fs'); const p=process.env.OWED_QUARANTINE_FILE;
console.log('file-evidence '+JSON.stringify({path:p??null, content:p?fs.readFileSync(p,'utf8'):null, tree:process.env.OWED_TREE}));
console.log('owed-counts '+JSON.stringify({pass:1,fail:0}));`;
async function evidence(cwd:string, obs:ObsEntry) { const log=(await (await Ledger.open(cwd)).getBlob(obs.log!)).toString(); return JSON.parse(/^file-evidence (.+)$/m.exec(log)![1]!); }

test('QS1: shared set parsing, validation and edit reference through plan ops', async () => {
  const r=await repo();
  try {
    await r.put('src/v','0'); await r.commit();
    const p={...shared(), invariants:[{id:'unit',run:'true',quarantine_set:'shared',quarantine:[{test:'own',fix:'work'}]}]};
    await init(r.cwd,p);
    assert.deepEqual((await ops.readState({cwd:r.cwd})).state.plan.quarantine_sets, {shared:Q});
    await r.put('plan.yaml',JSON.stringify(p));
    const preview=await cli(r.cwd,['edit','--invariant','unit','--plan','plan.yaml','--set','quarantine_set=shared','--dry-run','--note','fixture reference']);
    assert.equal(preview.code,0,preview.stderr);
    const bad:unknown[]=[null, {'bad name':Q}, {shared:{}}, {shared:[{test:'x\nline',fix:'fix'}]}, {shared:[{test:'x\u0085',fix:'fix'}]}, {shared:[{test:'x',fix:'missing'}]}, {shared:[...Q,Q[0]]}, {shared:Array.from({length:201},(_,i)=>({test:`t${i}`,fix:'fix'}))}];
    for (const sets of bad) await assert.rejects(ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',plan:JSON.stringify({...plain(),quarantine_sets:sets})}), /quarantine|set/);
    assert.throws(()=>parsePlan(JSON.stringify({...p,invariants:[{id:'unit',run:'true',quarantine_set:'missing'}]})),/not a defined set/);
    assert.throws(()=>parsePlan(JSON.stringify({...p,invariants:[{id:'unit',run:'true',quarantine_set:'shared',quarantine:[Q[0]]}]})),/duplicate quarantine/);
    assert.equal(parsePlan(JSON.stringify({...plain(),quarantine_sets:{large:Array.from({length:200},(_,i)=>({test:`t${i}`,fix:'fix'}))}})).quarantine_sets!.large!.length,200);
  } finally {await r.cleanup();}
});

test('QS1: additions and reference changes stay owner-only despite allow, removal is free', async () => {
  const r=await repo();
  try {
    await r.put('src/v','0'); await r.commit();
    const base={...plain(),allow:[{nodes:['*'],checks:['*']}]}; await init(r.cwd,base);
    const next={...base,quarantine_sets:{shared:Q},invariants:[{id:'unit',run:'true',quarantine_set:'shared'}]};
    await assert.rejects(ops.planSet({cwd:r.cwd,as:parent,plan:JSON.stringify(next)}),/owner|downgrade/);
    const e=await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',note:'fixture quarantine policy',plan:JSON.stringify(next)});
    assert.equal(e.kind,'plan');
    if(e.kind==='plan') assert.match(JSON.stringify(e.downgrades),/set shared quarantine.*added with fix/);
    assert.match(JSON.stringify(planDowngrades(parsePlan(JSON.stringify(next)),parsePlan(JSON.stringify({...next,quarantine_sets:{shared:[{test:'z flaky',fix:'work'}]}})))),/set shared quarantine.*fix changed from fix to work/);
    await ops.planSet({cwd:r.cwd,as:parent,plan:JSON.stringify({...base,invariants:[{id:'unit',run:'true'}]})});
  } finally {await r.cleanup();}
});

test('QS1: no-set keys retain 0.26 identity; referenced set changes carry and rekey a candidate', async () => {
  const r=await repo();
  try {
    await r.put('src/v','0'); await r.commit();
    const p={...shared(),invariants:[{id:'unit',run:'true',reads:['src/']}]};
    await init(r.cwd,p);
    let s=(await ops.readState({cwd:r.cwd})).state;
    const old=await stateFacts(r.cwd,parsePlan(JSON.stringify({...p,quarantine_sets:undefined})),s.trunk.commit);
    assert.deepEqual(s.plan.quarantine_sets,{shared:Q});
    assert.deepEqual(await stateFacts(r.cwd,s.plan,s.trunk.commit,quarantineNames(s.plan,()=>false)),old);
    const withCheck={...shared(),nodes:[{id:'fix',writes:['test/']},{id:'work',writes:['src/'],checks:[{id:'c',run:'true',reads:['src/'],quarantine_set:'shared'}]}]};
    await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',note:'fixture check policy',plan:JSON.stringify(withCheck)});
    await candidate(r.cwd); s=(await ops.readState({cwd:r.cwd})).state;
    const before=s.nodes.work!.candidate!.keys['check:c'];
    await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',note:'fixture new quarantine name',plan:JSON.stringify({...withCheck,quarantine_sets:{shared:[{test:'new name',fix:'fix'}]}})});
    const after=(await ops.readState({cwd:r.cwd})).state.nodes.work!.candidate!;
    assert.notEqual(after.keys['check:c'],before);
    const f=await ops.dispatch({cwd:r.cwd,node:'fix',as:parent}); await commitAt(f.worktree,{});
    await ops.submit({cwd:f.worktree,node:'fix',as:{role:'writer',id:'fix#1'}}); await ops.attest({cwd:r.cwd,node:'fix'});
    await ops.merge({cwd:r.cwd,node:'fix',as:parent});
    s=(await ops.readState({cwd:r.cwd})).state;
    assert.deepEqual(quarantineNames(s.plan,id=>!!s.nodes[id]?.merged)(s.plan.nodes.find(n=>n.id==='work')!.checks[0]!),[]);
  } finally {await r.cleanup();}
});

test('QS2: concurrent jobs receive sorted union files outside the tree, then remove them', async () => {
  const r=await repo();
  try {
    await r.put('test/record.cjs',recorder); await r.commit();
    const p={...shared(),exec:{parallel:2},invariants:['one','two'].map(id=>({id,run:'node test/record.cjs',min_tests:1,reads:['test/'],quarantine_set:'shared',quarantine:[{test:'middle',fix:'fix'}]}))};
    await init(r.cwd,p,true);
    const seen=[];
    for(const obs of await observations(r.cwd)) {
      const x=await evidence(r.cwd,obs); assert.equal(x.content,'a flaky\nmiddle\nz flaky\n'); assert.ok(isAbsolute(x.path)); assert.ok(!x.path.startsWith(x.tree+'/'));
      await assert.rejects(access(x.path)); seen.push(x.path); assert.match(obs.note??'',/quarantine file: 3 names \(owed excused nothing\)/);
    }
    assert.equal(new Set(seen).size,2);
  } finally {await r.cleanup();}
});

test('QS2: inherited and plan file variables are absent in setup, slot setup, ordinary and red runs', async () => {
  const r=await repo(), prior=process.env.OWED_QUARANTINE_FILE;
  try {
    process.env.OWED_QUARANTINE_FILE='/stale/host';
    await r.put('test/record.cjs',recorder); await r.put('src/v','0'); await r.commit();
    const out=join(r.root,'setup-env');
    const setup=`printf '%s' "\${OWED_QUARANTINE_FILE-unset}" > '${out}'`;
    const p={...plain(),setup,slot_setup:setup,exec:{env:{OWED_QUARANTINE_FILE:'/stale/plan'}},nodes:[{id:'fix',writes:['test/']},{id:'work',writes:['src/'],checks:[{id:'c',run:'node test/record.cjs; exit 1',reads:['test/'],red:true,tests:['test/record.cjs'],quarantine:Q}]}]};
    await init(r.cwd,p); await candidate(r.cwd);
    assert.equal(await readFile(out,'utf8'),'unset');
    for(const o of (await observations(r.cwd)).filter(o=>o.obligation!=='writes')) {
      const x=await evidence(r.cwd,o);
      if(o.obligation==='red:c') assert.equal(x.path,null);
      else { assert.equal(x.content,'a flaky\nz flaky\n'); await assert.rejects(access(x.path)); }
    }
    // Own names still invoke the new file protocol for ordinary checks without red/mutants.
    await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',note:'fixture ordinary check',plan:JSON.stringify({...p,nodes:[p.nodes[0],{...p.nodes[1],checks:[{id:'plain',run:'node test/record.cjs',reads:['test/'],quarantine:Q}]}]})});
    await ops.attest({cwd:r.cwd,node:'work'});
    const last=(await observations(r.cwd)).findLast(o=>o.obligation==='check:plain')!;
    assert.equal((await evidence(r.cwd,last)).content,'a flaky\nz flaky\n');
  } finally {if(prior===undefined)delete process.env.OWED_QUARANTINE_FILE;else process.env.OWED_QUARANTINE_FILE=prior;await r.cleanup();}
});

test('QS2: legacy own line breaks refuse the file without making replay invalid', async () => {
  const r=await repo();
  try {
    await r.put('test/record.cjs',recorder); await r.commit();
    await init(r.cwd,{...plain(),invariants:[{id:'unit',run:'node test/record.cjs',reads:['test/'],quarantine:[{test:'old\nname',fix:'fix'}]}]},true);
    const o=(await observations(r.cwd))[0]!;
    assert.equal((await evidence(r.cwd,o)).path,null);
    assert.match(o.note??'',/quarantine file not written: a name contains a line break/);
    assert.equal((await ops.readState({cwd:r.cwd})).state.plan.invariants[0]!.quarantine![0]!.test,'old\nname');
  } finally {await r.cleanup();}
});

test('QS2: opaque scripted failures keep their exit and explain file delivery in why', async () => {
  const r=await repo();
  try {
    await r.put('test/suite.test.cjs',tap); await r.put('test/broken','yes'); await r.put('src/v','0'); await r.commit();
    await init(r.cwd,{...plain(),nodes:[{id:'fix',writes:['test/']},{id:'work',writes:['src/'],checks:[{id:'c',run:run+'; exit 3',reads:['test/'],quarantine:Q}]}]});
    await candidate(r.cwd);
    const o=(await observations(r.cwd)).findLast(o=>o.obligation==='check:c')!;
    assert.equal(o.verdict,'fail'); assert.equal(o.exit,3); assert.equal(o.quarantined,undefined);
    const why=await cli(r.cwd,['why','work','--full']);
    assert.match(why.stdout,/quarantine file: 2 names \(owed excused nothing\)/);
    assert.doesNotMatch(why.stdout,/quarantine not applied: not a known test runner/);
  } finally {await r.cleanup();}
});

test('QS4: TAP trunk recovery records only ok names, preserves counts and displays active debt', async () => {
  const r=await repo();
  try {
    await r.put('test/suite.test.cjs',tap); await r.commit();
    const q=[...Q,{test:'skipped',fix:'fix'}];
    await init(r.cwd,{...plain(),invariants:[{id:'unit',run,reads:['test/'],quarantine:q}]},true);
    const o=(await observations(r.cwd))[0]!;
    assert.deepEqual(o.quarantine_passed,['a flaky','z flaky']); assert.equal(o.counts?.pass,3); assert.equal(o.counts?.skip,1);
    const status=await cli(r.cwd,['status']);
    assert.match(status.stdout,new RegExp(`quarantined a flaky passed on trunk ${o.commit.slice(0,12)} \\(#${o.seq}\\); remove it from quarantine if it stays green \\(fix fix\\)`));
    await git(r.cwd,['checkout','-b','broken-again']); await commitAt(r.cwd,{'test/broken':'yes'});
    await ops.adopt({cwd:r.cwd,commit:'HEAD',as:owner,channel:'delegated',note:'fixture recurrence'}); await git(r.cwd,['checkout','main']);
    const latest=(await observations(r.cwd)).at(-1)!;
    assert.deepEqual(latest.quarantine_passed,['z flaky']);
    assert.doesNotMatch((await cli(r.cwd,['status'])).stdout,/quarantined a flaky passed/);
    await ops.planSet({cwd:r.cwd,as:parent,plan:JSON.stringify({...plain(),invariants:[{id:'unit',run,reads:['test/']}]})});
    assert.doesNotMatch((await cli(r.cwd,['status'])).stdout,/quarantined .*passed/);
  } finally {await r.cleanup();}
});

test('QS4: merge-tree TAP recovery is not reported from a candidate-only measurement', async () => {
  const r=await repo();
  try {
    await r.put('test/suite.test.cjs',tap); await r.put('src/v','0'); await r.commit();
    await init(r.cwd,{...plain(),invariants:[{id:'guard',run:`test "$(cat src/v)" = 0`,reads:['src/']}],nodes:[{id:'fix',writes:['test/']},{id:'work',writes:['src/'],checks:[{id:'c',run,reads:['test/','src/'],quarantine:Q}]}]});
    await candidate(r.cwd);
    const c=(await observations(r.cwd)).findLast(o=>o.obligation==='check:c')!; assert.equal(c.quarantine_passed,undefined);
    // Force a distinct merge tree/key by moving unrelated reads on trunk through owner adoption.
    await git(r.cwd,['checkout','-b','advance']); await commitAt(r.cwd,{'src/other':'trunk'});
    await ops.adopt({cwd:r.cwd,commit:'HEAD',as:owner,channel:'delegated',note:'fixture trunk read change'}); await git(r.cwd,['checkout','main']);
    await assert.rejects(ops.merge({cwd:r.cwd,node:'work',as:parent}),/invariant guard/);
    const m=(await observations(r.cwd)).findLast(o=>o.obligation==='check:c'&&o.merging==='work')!;
    assert.deepEqual(m.quarantine_passed,['a flaky','z flaky']);
    assert.match((await cli(r.cwd,['report'])).stdout,/passed on the merge tree of work/);
  } finally {await r.cleanup();}
});

test('QS2: timeout diagnostics do not inherit the file and timed-out jobs clean it up', async () => {
  const r=await repo();
  try {
    await r.put('test/wait.cjs',recorder+`\nsetInterval(()=>{},1000);`); await r.put('test/record.cjs',recorder); await r.commit();
    const p={...plain(),invariants:[{id:'unit',run:'node test/wait.cjs',reads:['test/'],timeout_s:1,on_timeout:'node test/record.cjs',quarantine:Q}]};
    await init(r.cwd,p,true);
    const o=(await observations(r.cwd))[0]!, x=await evidence(r.cwd,o);
    assert.equal(o.verdict,'error'); await assert.rejects(access(x.path));
    const log=(await (await Ledger.open(r.cwd)).getBlob(o.log!)).toString();
    assert.match(log,/on_timeout \(diagnostic only\)/); assert.match(log,/file-evidence \{"path":null/);
    assert.match(o.note??'',/quarantine file: 2 names \(owed excused nothing\)/);
  } finally {await r.cleanup();}
});

test('QS5: admission warns only new/changed unreferenced test commands, not unrelated edits', async () => {
  const r=await repo();
  try {
    await r.put('src/v','0'); await r.commit();
    const p={...shared(),invariants:[{id:'unit',run,reads:['test/']}],nodes:[{id:'fix',writes:['test/']},{id:'work',writes:['src/'],checks:[{id:'cargo',run:'cargo test',reads:['src/']}]}]};
    const first=await init(r.cwd,p);
    assert.ok(first.warnings?.includes('warning: inv:unit runs tests without a quarantine set (sets: shared)'));
    assert.ok(first.warnings?.includes('warning: check work/cargo runs tests without a quarantine set (sets: shared)'));
    const same:string[]=[];
    await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',note:'fixture title change',plan:JSON.stringify({...p,nodes:[p.nodes[0],{...p.nodes[1],title:'unrelated'}]}),shellWarnings:same});
    assert.equal(same.filter(w=>w.includes('without a quarantine set')).length,0);
    const changed:string[]=[];
    await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',note:'fixture timeout change',plan:JSON.stringify({...p,invariants:[{...p.invariants[0],timeout_s:300}],nodes:[p.nodes[0],{...p.nodes[1],checks:[{id:'cargo',run:'cargo test',reads:['src/'],quarantine_set:'shared'}]}]}),shellWarnings:changed});
    assert.deepEqual(changed.filter(w=>w.includes('without a quarantine set')),['warning: inv:unit runs tests without a quarantine set (sets: shared)']);
  } finally {await r.cleanup();}
});
