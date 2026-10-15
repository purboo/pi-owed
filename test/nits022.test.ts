import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import * as R from '../src/reducer.ts';
import { Ledger, verifyChain } from '../src/ledger.ts';
import { parsePlan } from '../src/plan.ts';
import { canonical, sha256 } from '../src/canon.ts';
import { writesSyntax, withWritesSyntax, matchesWrite } from '../src/writes.ts';
import { git } from '../src/git.ts';
import { repo } from './helpers/repo.ts';
import { commitAt, cli } from './helpers/surface.ts';
import type { Entry, Plan, Draft, ObsEntry } from '../src/types.ts';
const owner = {role:'owner',id:'pi'} as const, parent = {role:'parent',id:'test'} as const;
const node = (id: string) => ({id,writes:[`${id}.txt`],checks:[],review:{count:0,min_rank:1}});
async function fixture(extra: object = {}) {
  const r = await repo();
  await commitAt(r.cwd,{seed:'base'});
  const plan = {version:1,trunk:'main',lease:false,closure:[],invariants:[],nodes:[node('a'),node('b'),node('c')],...extra};
  await ops.init({cwd:r.cwd,as:owner,channel:'delegated',plan:JSON.stringify(plan)});
  return {...r,plan};
}
async function accept(r: {cwd:string}, id: string) {
  const slot = await ops.dispatch({...r,as:parent,node:id});
  await commitAt(slot.worktree,{[`${id}.txt`]:id});
  await ops.submit({cwd:slot.worktree,as:{role:'writer',id:`${id}#1`},node:id});
  assert.equal((await ops.attest({...r,node:id})).accepted,true);
  return slot;
}
async function replayLookup(r: {cwd:string}, entries: Entry[]) {
  const ledger=await Ledger.open(r.cwd), plans=new Map<string,Plan>();
  for(const e of entries) if(e.kind==='genesis'||e.kind==='plan') plans.set(e.plan,parsePlan((await ledger.getBlob(e.plan)).toString()));
  return (sha:string)=>plans.get(sha)!;
}
function draft(e: Entry): Draft { const {seq,ts,prev,hash,...d}=e; return d as Draft; }

test('NT writes: syntax metadata survives spread and freeze without entering JSON, canonical hash or keys', () => {
  const p = parsePlan(JSON.stringify({version:1,trunk:'main',nodes:[{...node('a'),writes:['src/*.ts']}]}));
  const tagged = withWritesSyntax(Object.freeze(p),2), copy = {...tagged};
  assert.equal(writesSyntax(copy),2);
  assert.equal(matchesWrite('src/a.ts',copy.nodes[0]!.writes[0]!,writesSyntax(copy)),true);
  assert.equal(matchesWrite('src/nested/a.ts',copy.nodes[0]!.writes[0]!,writesSyntax(copy)),false);
  assert.equal(canonical(copy),canonical(p));
  assert.equal(JSON.stringify(copy),JSON.stringify(p));
  assert.equal(sha256(canonical(copy)),sha256(canonical(p)));
  assert.equal(writesSyntax({...withWritesSyntax(tagged,1)}),1);
});

test('NT writes: a historical invalid literal permits unchanged plan set/edit/amend but new invalid entries refuse', {timeout:120_000}, async () => {
  const r = await repo();
  try {
    await commitAt(r.cwd,{seed:'base'});
    const p = {version:1,trunk:'main',lease:false,nodes:[{...node('a'),writes:['app/[id]/']}],invariants:[],closure:[]};
    // Record an authentic pre-writes-syntax genesis, not a current init with weakened validation.
    const ledger = await Ledger.open(r.cwd), text = JSON.stringify(p), sha = await ledger.putBlob(text);
    const commit = (await git(r.cwd,['rev-parse','HEAD'])).stdout.trim();
    await ledger.withLock(()=>ledger.append([{kind:'genesis',by:'owner:pi',channel:'delegated',trunk:'main',commit,plan:sha,state:{commit,tree:'tree',invKeys:{}}}]));
    await writeFile(join(r.cwd,'plan.json'),text);
    const first = await ops.planSet({...r,as:parent,plan:text,path:'plan.json'});
    assert.equal(first.kind,'plan');
    const edited = await cli(r.cwd,['edit','a','--set','title=Updated title','--plan','plan.json','--note','rename node','--as','parent:test']);
    assert.equal(edited.code,0,edited.stderr);
    await ops.amend({...r,as:owner,channel:'delegated',node:'a',writes:['+extra/'],note:'extend scope',plan:'plan.json'});
    const before = await ledger.read(), current = (await ops.readState(r)).state.plan;
    await assert.rejects(ops.planSet({...r,as:parent,plan:JSON.stringify({...current,nodes:[{...current.nodes[0],writes:['app/[id]/','bad/[new]/']}]})}),/bad\/\[new\]/);
    assert.deepEqual(await ledger.read(),before);
  } finally {await r.cleanup();}
});

test('NT writes: grantRefused is structured, independent of note wording, and absent for an uncovered path', {timeout:120_000}, async () => {
  const r = await fixture({closure:['secret/'],allow:[{nodes:['a'],writes:['secret/','shared/']}],nodes:[node('a'),{...node('b'),writes:['shared/']}]});
  try {
    await ops.dispatch({...r,as:parent,node:'b'});
    const slot = await ops.dispatch({...r,as:parent,node:'a'});
    await commitAt(slot.worktree,{'shared/x':'x'});
    await ops.submit({cwd:slot.worktree,as:{role:'writer',id:'a#1'},node:'a'});
    await ops.attest({...r,node:'a'});
    const {state,entries} = await ops.readState(r), lookup=await replayLookup(r,entries);
    const fail = entries.findLast((e):e is ObsEntry=>e.kind==='obs' && e.obligation==='writes' && e.subject==='a')!;
    assert.equal(fail.grant_refused,true);
    const altered = entries.map(e=>e.seq===fail.seq ? {...fail,note:'different wording'} : e);
    const views = await import('../src/views.ts');
    assert.equal(views.receipt(R.reduce(altered,lookup),altered,'a').outOfWrites?.grantRefused,true);
    const legacy = entries.map(e=>e.seq===fail.seq ? {...fail,grant_refused:undefined,note:'outside writes: shared/x (owned by open node b)'} : e);
    assert.equal(views.receipt(R.reduce(legacy,lookup),legacy,'a').outOfWrites?.grantRefused,undefined);
    assert.ok(R.validateDraft(state,{...draft(fail),obligation:'check:x'} as Draft).length>0);
    await ops.abandon({...r,as:parent,node:'b',reason:'release overlap for uncovered-path regression'});
    await commitAt(slot.worktree,{'uncovered/x':'x'});
    await ops.submit({cwd:slot.worktree,as:{role:'writer',id:'a#1'},node:'a'});
    await ops.attest({...r,node:'a'});
    const uncovered=(await ops.readState(r)).entries.findLast((e):e is ObsEntry=>e.kind==='obs' && e.obligation==='writes' && e.subject==='a')!;
    assert.equal(uncovered.verdict,'fail');assert.equal(uncovered.grant_refused,undefined);
    await commitAt(slot.worktree,{'secret/x':'x'});
    await ops.submit({cwd:slot.worktree,as:{role:'writer',id:'a#1'},node:'a'});
    await ops.attest({...r,node:'a'});
    const closure=(await ops.readState(r)).entries.findLast((e):e is ObsEntry=>e.kind==='obs' && e.obligation==='writes' && e.subject==='a')!;
    assert.equal(closure.grant_refused,true);
  } finally {await r.cleanup();}
});

test('NT models: same_model add/remove carries the identical candidate; warning acknowledgement does not change gates', {timeout:120_000}, async () => {
  const r = await fixture({nodes:[{...node('a'),review:{count:1,min_rank:1}}]});
  try {
    const slot = await ops.dispatch({...r,as:parent,node:'a'});
    const commit = await commitAt(slot.worktree,{'a.txt':'a'});
    await ops.submit({cwd:slot.worktree,as:{role:'writer',id:'a#1'},node:'a',model:'provider/model:high'});
    await ops.review({...r,as:{role:'reviewer',id:'independent'},node:'a',named:commit,verdict:'ok',rank:1,note:'checked',model:'provider/model:low'});
    await ops.attest({...r,node:'a'});
    const before = (await ops.readState(r)).state.nodes.a!.candidate!;
    for (const drive of [{same_model:'accepted'},{}]) {
      const current = (await ops.readState(r)).state.plan;
      await ops.planSet({...r,as:parent,plan:JSON.stringify({...current,drive})});
      const state = (await ops.readState(r)).state, candidate = state.nodes.a!.candidate!;
      assert.equal(candidate.commit,before.commit);assert.equal(candidate.patch,before.patch);
      assert.deepEqual(candidate.keys,before.keys);assert.equal(state.nodes.a!.accepted,true);
      const result = await cli(r.cwd,['why','a','--json']);assert.equal(result.code,0,result.stderr);
      const warnings = JSON.parse(result.stdout).modelWarnings;
      assert.equal(warnings.find((w:string|{message:string})=>typeof w==='object' && w.message.includes("reviewer used the writer's model"))?.acknowledged,drive.same_model==='accepted' ? true : undefined);
    }
  } finally {await r.cleanup();}
});

test('NT models: nested pool edges, empty/partial cycles and thinking suffixes stay informational', {timeout:120_000}, async () => {
  const r = await fixture(), prior = process.env.DSA_HOME;
  process.env.DSA_HOME=join(r.root,'dsa');await mkdir(process.env.DSA_HOME,{recursive:true});
  try {
    const slot=await ops.dispatch({...r,as:parent,node:'a'}), s=(await ops.readState(r)).state;
    await ops.launch({...r,as:parent,node:'a',attempt:1,role:'writer',rid:R.runId(R.projectId(s),'a',1,'writer'),labels:R.runLabels(R.projectId(s),'a',1,'writer'),spec:JSON.stringify({model:'pool'}),rulings:0});
    await commitAt(slot.worktree,{'a.txt':'a'});
    await ops.submit({cwd:slot.worktree,as:{role:'writer',id:'a#1'},node:'a',model:'provider/model:low'});
    for (const [pools,expected] of [
      [{pool:[]},/pool membership unknown/],
      [{pool:['pool','provider/model:high']},null],
      [{pool:[{model:'provider/model:high',afterMs:0}]},null],
      [{pool:['provider/other:high']},/differs from/],
    ] as const) {
      await writeFile(join(process.env.DSA_HOME!,'config.json'),JSON.stringify({pools}));
      const result=await cli(r.cwd,['why','a']);assert.equal(result.code,0,result.stderr);
      if(expected) assert.match(result.stdout,expected);else assert.doesNotMatch(result.stdout,/differs from|pool membership unknown/);
    }
  } finally {if(prior===undefined) delete process.env.DSA_HOME;else process.env.DSA_HOME=prior;await r.cleanup();}
});

// The original ledger and blob bytes, copied through the first merge; no timestamps, paths or hashes regenerated.
test('NT replay: real repository 0.20 ledger prefix verifies and full/incremental replay reaches a fixed snapshot', async () => {
  const f=JSON.parse(await readFile(new URL('./fixtures/real-020-ledger.json',import.meta.url),'utf8')) as {entries:Entry[];plans:Record<string,string>};
  assert.deepEqual(verifyChain(f.entries),{ok:true});
  for(const [sha,text] of Object.entries(f.plans)) assert.equal(sha256(text),sha);
  const lookup=(sha:string)=>parsePlan(f.plans[sha]!);
  const full=R.reduce(f.entries,lookup);
  let inc=R.reduce(f.entries.slice(0,1),lookup);
  for(const e of f.entries.slice(1)) inc=R.reduceFrom(inc,[e],lookup);
  assert.equal(R.sameReplay(inc,full),true);
  assert.deepEqual({seq:full.seq,head:full.head,trunk:full.trunk.commit,merged:Object.values(full.nodes).filter(n=>n.merged).map(n=>n.id),ready:(await import('../src/views.ts')).statusView(full).ready},
    {seq:12,head:'996a7269d4407bf11ab23bee9662fe05cf79426e68bdd013253aec323059d10d',trunk:'3f662bf0fba7ef26112761baeb85e2eee8527cbc',merged:['english'],ready:['brief','escape','gc','strength']});
});

test('NT mtrain #2270: batch fail cannot carry remeasure metadata or supply the single-merge first failure hint', {timeout:180_000}, async () => {
  const r=await fixture({invariants:[{id:'health',reads:['*.txt'],remeasure_on:['transient fixture'],run:'if test -f b.txt; then echo transient fixture; exit 1; fi'}]});
  try {
    await accept(r,'a');await accept(r,'b');
    await assert.rejects(ops.mergeBatch({...r,as:parent,nodes:['a','b']}),/batch merge/);
    const {entries}=await ops.readState(r), lookup=await replayLookup(r,entries), fail=entries.findLast((e):e is ObsEntry=>e.kind==='obs' && !!e.batch && e.verdict==='fail')!;
    assert.ok(fail);assert.equal(fail.remeasure_match,undefined);assert.equal(fail.auto_remeasure,undefined);
    const pre=R.reduce(entries.filter(e=>e.seq<fail.seq),lookup);
    for(const extra of [{remeasure_match:['transient fixture']},{auto_remeasure:true}]) {
      const bad={...fail,...extra} as Entry;
      assert.throws(()=>R.reduceFrom(pre,[bad],lookup),/batch obs never carries/);
    }
    await ops.merge({...r,as:parent,node:'a'});
    let message='';try {await ops.merge({...r,as:parent,node:'b'});}catch(e){message=(e as Error).message;}
    const own=(await ops.readState(r)).entries.filter((e):e is ObsEntry=>e.kind==='obs' && e.merging==='b' && e.obligation==='inv:health');
    assert.equal(own.length,2);assert.equal(own[0]!.key,fail.key);
    assert.equal(own[1]!.auto_remeasure,true);
    assert.match(message,new RegExp(`automatic same-key remeasure: #${own[0]!.seq} fail`));
    assert.doesNotMatch(message,new RegExp(`automatic same-key remeasure: #${fail.seq} fail`));
  } finally {await r.cleanup();}
});

test('NT mtrain: merged-batch trunk-red is inherited by a later single merge, while its own tree is measured', {timeout:180_000}, async () => {
  const run=`node -e 'console.log("owed-counts "+JSON.stringify({tests:1,pass:0,fail:1,failed:["existing failure"]})); process.exit(1)'`;
  const r=await fixture({invariants:[{id:'red',reads:['*.txt'],run}]});
  try {
    await accept(r,'a');await accept(r,'b');await accept(r,'c');
    await ops.mergeBatch({...r,as:parent,nodes:['a','b']});
    const before=(await ops.readState(r)).entries.length;
    await ops.merge({...r,as:parent,node:'c'});
    const {state,entries}=await ops.readState(r);
    assert.ok(state.nodes.c!.merged);
    assert.ok(entries.slice(before).some(e=>e.kind==='obs' && e.merging==='c' && !e.batch && e.verdict==='fail'));
    assert.equal((await ops.verify(r)).ok,true);
  } finally {await r.cleanup();}
});

test('NT mtrain: inherited batch debt still refuses new or truncated failure names on a later single tree', {timeout:180_000}, async () => {
  for(const truncated of [false,true]) {
    const script=`const fs=require("fs");const changed=fs.existsSync("c.txt");const failed=changed && !${truncated} ? ["existing failure","new failure"] : ["existing failure"];console.log("owed-counts "+JSON.stringify({tests:changed?2:1,pass:0,fail:changed?2:1,failed}));process.exit(1)`;
    const r=await fixture({invariants:[{id:'red',reads:['*.txt'],run:`node -e '${script}'`}]});
    try {
      await accept(r,'a');await accept(r,'b');await accept(r,'c');
      await ops.mergeBatch({...r,as:parent,nodes:['a','b']});
      await assert.rejects(ops.merge({...r,as:parent,node:'c'}),truncated ? /failed names truncated/ : /new failures new failure/);
      assert.equal((await ops.readState(r)).state.nodes.c!.merged,undefined);
    } finally {await r.cleanup();}
  }
});

test('NT mtrain-tail: an oversized non-final batch line triggers completion rather than being mistaken for a non-batch tail', {timeout:180_000}, async () => {
  const r=await fixture();
  try {
    await accept(r,'a');await accept(r,'b');
    await ops.mergeBatch({...r,as:parent,nodes:['a','b']});
    const ledger=await Ledger.open(r.cwd),file=join(ledger.dir,'ledger.jsonl');
    const lines=(await readFile(file,'utf8')).trimEnd().split('\n'), last=JSON.parse(lines.at(-1)!) as Entry;
    const first=JSON.parse(lines.at(-2)!) as Entry;
    // Whitespace is legal JSON and does not change the canonical entry hash.
    lines[lines.length-2]=' '.repeat(80_000)+JSON.stringify(first);
    await writeFile(file,lines.slice(0,-1).join('\n')+'\n');await rm(join(ledger.dir,'snapshot'),{force:true,recursive:true});
    let bytes=0;ops.batchTailProbe.onRead=n=>{bytes+=n;};
    try {await ledger.withLock(async()=>{});}finally {delete ops.batchTailProbe.onRead;}
    assert.ok(bytes>64*1024);
    const all=await ledger.read();assert.equal(all.at(-1)?.kind,'merge');
    assert.equal((all.at(-1) as typeof last & {commit:string}).commit,(last as typeof last & {commit:string}).commit);
    assert.equal((await ops.verify(r)).incompleteBatch,undefined);
  } finally {await r.cleanup();}
});


test('NT mtrain status: planned batches exclude waiting/later nodes and explicit batches remain available', {timeout:120_000}, async () => {
  const r=await fixture({drive:{merge_batch:3}});
  try {
    for(const id of ['a','b','c']) await accept(r,id);
    await ops.resume({...r,as:parent,node:'a',after:'c',note:'wait for c'});
    assert.deepEqual((await ops.status(r)).mergeBatch,['b','c']);
    const s=(await ops.readState(r)).state;
    await ops.planSet({...r,as:parent,plan:JSON.stringify({...s.plan,nodes:s.plan.nodes.map(n=>n.id==='b'?{...n,later:true}:n)})});
    assert.equal((await ops.status(r)).mergeBatch,undefined);
    // Explicit parent invocation is independent of the driver's batch size (ruling #2110).
    await ops.mergeBatch({...r,as:parent,nodes:['b','c']});
    assert.ok((await ops.readState(r)).state.nodes.b!.merged);
  } finally {await r.cleanup();}
});

test('NT mtrain driver: a running batch member says in batch with the leader', {timeout:120_000}, async () => {
  const r=await fixture({drive:{merge_batch:2}}), marker=join(r.root,'batch-started'), gate=join(r.root,'batch-go');
  const {Driver}=await import('../src/drive-run.ts'),{Dsa}=await import('../src/dsa.ts');
  class Client extends Dsa {
    constructor(){super({bin:'/bin/true'});}
    override async describe(rid:string){return {rid,state:'sealed' as const,status:'ok' as const};}
    override async inspect(rid:string){return {view:await this.describe(rid)};}
  }
  const driver=new Driver({...r,dsa:new Client(),log:()=>{},handleSignals:false});
  try {
    const s=(await ops.readState(r)).state;
    await ops.planSet({...r,as:parent,plan:JSON.stringify({...s.plan,invariants:[{id:'gate',reads:['*.txt'],timeout_s:20,run:`if test -f a.txt && test -f b.txt; then touch '${marker}'; while [ ! -f '${gate}' ]; do sleep .02; done; fi`}]})});
    for(const id of ['a','b']) {
      await accept(r,id);
      const s=(await ops.readState(r)).state;
      await ops.launch({...r,as:parent,node:id,attempt:1,role:'writer',rid:R.runId(R.projectId(s),id,1,'writer'),labels:R.runLabels(R.projectId(s),id,1,'writer'),spec:'{}',rulings:0});
    }
    await driver.pass();
    const end=Date.now()+10_000;
    for(;;){try{await readFile(marker);break;}catch{assert.ok(Date.now()<end,'batch invariant starts');await new Promise(r=>setTimeout(r,20));}}
    const view=await ops.status(r);
    assert.equal(view.mergeWaiting?.b?.reason,'in batch with a');
    const {renderStatus}=await import('../src/views.ts');
    assert.match(renderStatus(view),/b: merge in batch with a/);
    await writeFile(gate,'');await driver.settle();
    assert.ok((await ops.readState(r)).state.nodes.b!.merged);
  } finally {await writeFile(gate,'');driver.abort.abort();await driver.settle();await r.cleanup();}
});
