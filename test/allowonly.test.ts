// AO1–AO6: caps restrict allow grants, never the node's own writes.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import * as ops from '../src/ops.ts';
import * as R from '../src/reducer.ts';
import { Ledger, entryHash } from '../src/ledger.ts';
import { H } from '../src/canon.ts';
import { candidateFacts } from '../src/git.ts';
import { parsePlan, planDowngrades } from '../src/plan.ts';
import { runJob } from '../src/exec.ts';
import { renderReceipt, preauthorizedWritesLines } from '../src/views.ts';
import * as W from '../src/writes.ts';
import owed from '../src/extension.ts';
import type { Draft, Entry, Plan, State } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';
const {withWritesSyntax, matchesAllowOnly} = W;
const owner = { role:'owner', id:'test' } as const, parent = { role:'parent', id:'test' } as const;
const sealed = { async describe(rid:string) { return {rid,state:'sealed' as const,status:'ok'}; }, async send() { return {outcome:'applied' as const,spec_digest:'test'}; } };
function plan(cap?:string[], own=['src/']) {
  return {version:1,trunk:'main',lease:false,closure:[],invariants:[],allow:[{nodes:['a'],writes:['lib/']}],nodes:[{id:'a',writes:own,checks:[],...(cap !== undefined ? {allow_only:cap} : {})}]};
}
async function fixture(cap?:string[], own?:string[]) {
  const r=await repo(), text=JSON.stringify(plan(cap,own));
  await r.put('plan.json',text); await r.commit();
  await ops.init({cwd:r.cwd,as:owner,channel:'flag',plan:text,measure:false,path:'plan.json'});
  await ops.planSet({cwd:r.cwd,as:parent,...await ops.readPlan({cwd:r.cwd,path:'plan.json'})});
  const slot=await ops.dispatch({cwd:r.cwd,as:parent,node:'a'}), ledger=await Ledger.open(r.cwd);
  const state=() => ops.readState(r);
  const submit=async (files:Record<string,string>) => {const commit=await commitAt(slot.worktree,files);await ops.submit({cwd:slot.worktree,as:{role:'writer',id:'a#1'},node:'a'});return commit;};
  return {...r,slot,ledger,state,submit};
}
const writes = (es:Entry[]) => es.filter((e):e is Extract<Entry,{kind:'obs'}> => e.kind==='obs' && e.obligation==='writes');
const grants = (es:Entry[]) => es.filter((e):e is Extract<Entry,{kind:'grant'}> => e.kind==='grant');
function forged(s:State,d:Draft):Entry {const e={...d,seq:s.seq+1,ts:new Date().toISOString(),prev:s.head} as Entry;e.hash=entryHash(e);return e;}

test('AO1/AO2 red: only samples is granted; sibling and suffix fail, with partial grants and cap hint',async()=>{
  const f=await fixture(['lib/samples.mjs']);
  try {
    await f.submit({'lib/samples.mjs':'ok'}); assert.equal((await ops.attest({cwd:f.cwd,node:'a'})).accepted,true);
    await f.submit({'lib/other.mjs':'no','lib/samples.mjs.bak':'no'}); const result=await ops.attest({cwd:f.cwd,node:'a'});
    assert.equal(result.accepted,false); const {state:s,entries}=await f.state();
    assert.deepEqual(grants(entries).flatMap(g=>g.paths),['lib/samples.mjs']);
    const job=R.attestJobs(s,'a').find(j=>j.obligation==='writes'); assert.equal(job?.attribution,true);
    assert.equal((await ops.attest({cwd:f.cwd,node:'a'})).accepted,false,'attribution does not forgive the capped paths');
    assert.equal(writes((await f.state()).entries).at(-1)!.verdict,'fail');
    assert.equal(writes(entries).at(-1)!.verdict,'fail');
    assert.match(writes(entries).at(-1)!.note!,/lib\/other\.mjs: outside allow_only of a \[lib\/samples\.mjs\]/);
    assert.equal(R.withinWrites(s,'a','lib/samples.mjs.bak'),false);
    const hint=R.grantHint(s,'a')!; assert.match(hint,/owed edit a --set allow_only=\[\.\.\.\]/); assert.doesNotMatch(hint,/an allow rule|amend/);
    assert.match(renderReceipt(await ops.why({cwd:f.cwd,node:'a'})),/outside allow_only/);
    await assert.rejects(ops.merge({cwd:f.cwd,node:'a',as:parent}),/outside allow_only/);
  } finally {await f.cleanup();}
});
test('AO1: empty cap grants nothing; own writes remain unrestricted; glob cap uses syntax 2',async()=>{
  const f=await fixture([],['src/','lib/own']);
  try {
    await f.submit({'lib/own.bak':'own','lib/other':'no','src/a':'own'}); await ops.attest({cwd:f.cwd,node:'a'});
    const {state:s,entries}=await f.state(); assert.equal(R.withinWrites(s,'a','lib/own.bak'),true); assert.equal(R.withinWrites(s,'a','lib/other'),false); assert.equal(grants(entries).length,0);
    assert.match(writes(entries).at(-1)!.note!,/outside allow_only of a \[\]/);
    const p=parsePlan(JSON.stringify(plan(['lib/**/sample?.mjs'])));
    assert.equal(R.writesAllowed(withWritesSyntax(p,3),'a',['lib/samples.mjs','lib/nest/sample1.mjs']),true);
    assert.equal(R.writesAllowed(withWritesSyntax(p,3),'a',['lib/nest/sample12.mjs']),false);
    assert.equal(R.writesAllowed(withWritesSyntax(p,3),'a',['outside/sample1.mjs']),false,'cap grants no permission on its own');
  } finally {await f.cleanup();}
});
test('AO1/AO4: literal caps do not inherit prefix semantics, and glob permission is an intersection',()=>{
  const node={allow_only:['lib/samples.mjs']};
  for(const p of ['lib/samples.mjs.bak','lib/samples.mjs/child','lib/samples.mjs\n']) assert.equal(matchesAllowOnly(node,p),false);
  assert.equal(matchesAllowOnly({allow_only:['lib/']},'lib/samples.mjs'),false);
  assert.equal(matchesAllowOnly({allow_only:['lib/**/sample?.mjs']},'lib/deep/sample1.mjs'),true);
  assert.equal(matchesAllowOnly({allow_only:['lib/**/sample?.mjs']},'lib/sample12.mjs'),false);
  assert.throws(()=>parsePlan(JSON.stringify({...plan(),nodes:[{id:'a',allow_only:'lib/x',checks:[]}]})),/allow_only/);
});
test('AO2/AO3: later cap excludes old grants in effective writes, replay, executor and merge recheck; candidate carries',async()=>{
  const f=await fixture();
  try {
    await f.submit({'lib/other.mjs':'granted'}); await ops.attest({cwd:f.cwd,node:'a'}); const before=(await f.state()).state, c=before.nodes.a!.candidate!;
    await ops.planSet({cwd:f.cwd,as:parent,plan:JSON.stringify(plan(['lib/samples.mjs']))});
    const {state:s,entries}=await f.state(), current=s.nodes.a!.candidate!;
    assert.equal(current.commit,c.commit); assert.notEqual(current.keys.writes,c.keys.writes); assert.equal(s.nodes.a!.accepted,false);
    assert.ok(entries.some(e=>e.kind==='submit' && e.carry===c.seq));
    assert.equal(R.withinWrites(s,'a','lib/other.mjs'),false); assert.deepEqual(R.effectiveWrites(s,'a'),['src/']); assert.equal(R.grantsOf(s,'a').length,1,'audit receipt is kept');
    const lookup=async()=>{const m=new Map<string,Plan>();for(const e of entries)if(e.kind==='plan'||e.kind==='genesis')m.set(e.plan,parsePlan((await f.ledger.getBlob(e.plan)).toString()));return (sha:string)=>m.get(sha)!;};
    const law=await lookup(), cold=R.reduce(entries,law), packed=R.unpackState(R.packState(s),law);
    assert.equal(R.withinWrites(cold,'a','lib/other.mjs'),false); assert.equal(R.withinWrites(packed,'a','lib/other.mjs'),false);
    const facts={...current,changed:['lib/other.mjs'],keys:{...current.keys,writes:'merge-key'}};
    assert.ok(R.mergeGuard(s,'a',{facts,state:{commit:current.commit,tree:current.tree,invKeys:{}}}).reasons.some(r=>r.includes('writes merge changes exceed allowed paths')));
    const obs=await runJob({cwd:f.cwd,plan:s.plan,ledger:f.ledger,grantedWrites:['lib/other.mjs']},{kind:'writes',subject:'a',obligation:'writes',key:current.keys.writes!,commit:current.commit,base:current.base});
    assert.equal(obs.verdict,'fail','even an unfiltered caller cannot bypass the cap');
    await ops.attest({cwd:f.cwd,node:'a'}); assert.equal(writes((await f.state()).entries).at(-1)!.verdict,'fail');
  } finally {await f.cleanup();}
});
test('AO2: grant replay refuses capped paths, without weakening closure or ownership gates',async()=>{
  const f=await fixture(['lib/samples.mjs']);
  try {
    await f.submit({'lib/other.mjs':'no'}); const {state:s,entries}=await f.state(), plans=new Map<string,Plan>();
    for(const e of entries)if(e.kind==='genesis'||e.kind==='plan')plans.set(e.plan,parsePlan((await f.ledger.getBlob(e.plan)).toString()));
    const d:Draft={kind:'grant',by:'executor:owed',node:'a',attempt:1,commit:s.nodes.a!.candidate!.commit,paths:['lib/other.mjs'],allowance:R.allowanceSeq(s)!};
    assert.match(R.grantErrors(s,d).join('; '),/lib\/other\.mjs: outside allow_only of a/);
    assert.throws(()=>R.reduceFrom(s,[forged(s,d)],sha=>plans.get(sha)!),/outside allow_only/);
  } finally {await f.cleanup();}
});
test('AO3/AO4: writes key compatibility and conservative cap downgrade classification',async()=>{
  const f=await fixture();
  try {
    const commit=await f.submit({'src/a':'a'}), s=(await f.state()).state, c=s.nodes.a!.candidate!;
    assert.equal(c.keys.writes,H({o:'writes',base:c.base,cand:commit,writes:['src/']}));
    const cap=withWritesSyntax(parsePlan(JSON.stringify(plan(['lib/samples.mjs']))),3);
    const k=await candidateFacts(f.cwd,cap,cap.nodes[0]!,c.base,commit,1);
    assert.equal(k.keys.writes,H({o:'writes',base:c.base,cand:commit,writes:['src/'],allow_only:['lib/samples.mjs']}));
    assert.equal(k.keys.review,c.keys.review); assert.equal(k.keys.rulings,c.keys.rulings);
    const parsed=(xs?:string[])=>parsePlan(JSON.stringify(plan(xs)));
    for(const [a,b] of [[undefined,[]],[['lib/**'],['lib/samples.mjs']],[['lib/sample?.mjs'],['lib/samples.mjs']],[['lib/samples.mjs'],[]],[['lib/**'],['lib/**/x?.mjs']]] as [string[]|undefined,string[]][]) {
      assert.deepEqual(planDowngrades(parsed(a),parsed(b)),[]); assert.deepEqual(R.uncoveredDowngrades(parsed(a),parsed(b)),[]);
    }
    for(const [a,b] of [[[],undefined],[['lib/samples.mjs'],['lib/samples.mjs.bak']],[['lib/samples.mjs'],['lib/**']],[['lib/sample?.mjs'],['lib/*.mjs']]] as [string[],string[]|undefined][]) {
      assert.deepEqual(planDowngrades(parsed(a),parsed(b)),[{node:'a',what:'allow_only widened: a'}]); assert.deepEqual(R.uncoveredDowngrades(parsed(a),parsed(b)),[{node:'a',what:'allow_only widened: a'}]);
    }
    assert.throws(()=>parsePlan(JSON.stringify(plan(['../outside']))),/allow_only/);
  } finally {await f.cleanup();}
});
test('AO5: syntax 3 is recorded only with caps; old-reader guard rejects it; legacy ignored fields stay ignored',async()=>{
  const f=await fixture(['lib/samples.mjs']);
  try {
    const first=(await f.state()).entries[0]!; assert.ok(first.kind==='genesis'); assert.equal(first.writes_syntax,3);
    const oldGuard=(d:Entry)=> (d.kind==='genesis'||d.kind==='plan') && d.writes_syntax!==undefined && d.writes_syntax!==2;
    assert.equal(oldGuard(first),true,'the 0.29 writes_syntax guard refuses 3');
    await ops.planSet({cwd:f.cwd,as:owner,channel:'flag',plan:JSON.stringify(plan())});
    const last=(await f.state()).entries.at(-1)!; assert.ok(last.kind==='plan'); assert.equal(last.writes_syntax,2);
    const raw=parsePlan(JSON.stringify(plan([]))), legacy={...first,writes_syntax:2 as const}; legacy.hash=entryHash(legacy);
    const old=R.reduce([legacy],()=>raw); assert.equal(Object.hasOwn(old.plan.nodes[0]!,'allow_only'),false,'a legacy reader ignored this unknown plan field');
    assert.equal(R.writesAllowed(old.plan,'a',['lib/other']),true);
  } finally {await f.cleanup();}
});
test('AO5/#3562: syntax 3 without a cap refuses append validation and replay',async(t)=>{
  const bare=parsePlan(JSON.stringify(plan())), lookup=()=>bare, empty=R.reduce([],lookup);
  const genesis:Draft={kind:'genesis',by:'owner:test',channel:'flag',trunk:'main',commit:'c',plan:'bare',writes_syntax:2,state:{commit:'c',tree:'t',invKeys:{}}};
  const established=R.reduce([forged(empty,genesis)],lookup);
  const uncapped:Draft[]=[{...genesis,writes_syntax:3},{kind:'plan',by:'parent:test',prior:'bare',plan:'bare',writes_syntax:3,downgrades:[]}];
  for(const d of uncapped) {
    const base=d.kind==='genesis' ? empty : established;
    await t.test(`${d.kind} append`,()=>assert.match(R.validateDraft(base,d).join('; '),/writes_syntax 3 requires allow_only on at least one node/));
    await t.test(`${d.kind} replay`,()=>assert.throws(()=>R.reduceFrom(base,[forged(base,d)],lookup),/writes_syntax 3 requires allow_only on at least one node/));
  }
});
test('AO5/#3562: new capped drafts require syntax 3, including an empty cap on a later node',()=>{
  for(const cap of [[],['lib/x']]) {
    const bare=parsePlan(JSON.stringify(plan())), capped=parsePlan(JSON.stringify({...plan(),nodes:[...plan().nodes,{id:'b',writes:[],checks:[],allow_only:cap}]}));
    const lookup=(sha:string)=>sha==='capped' ? capped : bare, empty=R.reduce([],lookup);
    const genesis:Draft={kind:'genesis',by:'owner:test',channel:'flag',trunk:'main',commit:'c',plan:'bare',writes_syntax:2,state:{commit:'c',tree:'t',invKeys:{}}};
    const established=R.reduce([forged(empty,genesis)],lookup);
    const drafts:Draft[]=[{...genesis,plan:'capped',writes_syntax:3},{kind:'plan',by:'parent:test',prior:'bare',plan:'capped',writes_syntax:3,downgrades:[]}];
    for(const d of drafts) {
      const base=d.kind==='genesis' ? empty : established;
      assert.deepEqual(R.validateDraft(base,d),[]);
      const correct=R.reduceFrom(base,[forged(base,d)],lookup);
      assert.deepEqual(correct.plan.nodes[1]!.allow_only,cap);
      assert.deepEqual(R.unpackState(structuredClone(R.packState(correct)),lookup).plan.nodes[1]!.allow_only,cap);
      for(const syntax of [undefined,2] as const) {
        const wrong={...d,writes_syntax:syntax};
        assert.match(R.validateDraft(base,wrong).join('; '),/plan with allow_only must record writes_syntax 3/);
      }
    }
  }
});
test('AO5/#3562: syntax 1/2 historical caps stay ignored; malformed caps remain explicitly refused',()=>{
  for(const syntax of [undefined,2] as const) {
    const texts=new Map([['bare',JSON.stringify(plan())],['valid',JSON.stringify(plan([]))],['malformed',JSON.stringify({...plan(),nodes:[{id:'a',writes:['src/'],checks:[],allow_only:'invalid'}]})]]);
    const lookup=(sha:string)=>parsePlan(texts.get(sha)!), empty=R.reduce([],lookup);
    const genesis:Draft={kind:'genesis',by:'owner:test',channel:'flag',trunk:'main',commit:'c',plan:'bare',writes_syntax:syntax,state:{commit:'c',tree:'t',invKeys:{}}};
    const established=R.reduce([forged(empty,genesis)],lookup);
    for(const sha of ['valid','malformed']) {
      const drafts:Draft[]=[{...genesis,plan:sha},{kind:'plan',by:'parent:test',prior:'bare',plan:sha,writes_syntax:syntax,downgrades:[]}];
      for(const d of drafts) {
        const base=d.kind==='genesis' ? empty : established, entry=forged(base,d);
        if(sha==='malformed') {
          assert.throws(()=>R.reduceFrom(base,[entry],lookup),/allow_only: expected array/);
          assert.match(R.validateDraft(base,d).join('; '),/allow_only: expected array/);
        } else {
          const cold=R.reduceFrom(base,[entry],lookup), packed=R.unpackState(structuredClone(R.packState(cold)),lookup);
          for(const s of [cold,packed]) {
            assert.equal(Object.hasOwn(s.plan.nodes[0]!,'allow_only'),false);
            assert.equal(R.writesAllowed(s.plan,'a',['lib/other']),true);
            assert.equal(R.withinWrites(s,'a','src/file.bak'),true);
            assert.equal(R.withinWrites(s,'a','lib/other'),false,'legacy cap does not grant permissions');
          }
        }
      }
    }
  }
});
test('AO6: decide cap + writes + resume append once, rollback on refusal, edit removes cap with owner authority',async(t)=>{
  const f=await fixture();
  try {
    await f.submit({'src/a':'a'}); await ops.halt({cwd:f.cwd,as:{role:'parent',id:'drive'},node:'a',attempt:1,reason:'held',needs:'human'});
    const append=Ledger.prototype.append; let calls=0;
    t.mock.method(Ledger.prototype,'append',async function(this:Ledger,...args:Parameters<Ledger['append']>){calls++;return append.apply(this,args);});
    const r=await ops.decide({cwd:f.cwd,as:parent,nodes:['a'],text:'Only samples',allow_only:['lib/samples.mjs'],writes:['lib/samples.mjs'],dsa:sealed});
    assert.equal(calls,1); assert.deepEqual(r.entries.map(e=>e.kind),['plan','submit','rule','resume']); assert.ok(r.entries.every(e=>e.decision===r.decision));
    assert.match(r.rule.text,/\(allow rule grants capped to: lib\/samples\.mjs\)/); assert.match(ops.decideText(r),/allow_only/);
    let {state:s}=await f.state(); assert.deepEqual(s.plan.nodes[0]!.allow_only,['lib/samples.mjs']); assert.deepEqual(s.plan.nodes[0]!.writes,['src/']);
    const text=await readFile(join(f.cwd,'plan.json'),'utf8'), seq=s.seq;
    await assert.rejects(ops.decide({cwd:f.cwd,as:parent,nodes:['a'],text:'Widen',allow_only:['lib/**'],dsa:sealed}),/allow_only widened/);
    assert.equal((await f.state()).state.seq,seq); assert.equal(await readFile(join(f.cwd,'plan.json'),'utf8'),text);
    await assert.rejects(ops.decide({cwd:f.cwd,as:parent,nodes:['a'],text:'Refuse resume',allow_only:[],after:'missing',dsa:sealed}));
    assert.equal((await f.state()).state.seq,seq); assert.equal(await readFile(join(f.cwd,'plan.json'),'utf8'),text);
    t.mock.restoreAll(); t.mock.method(Ledger.prototype,'append',async()=>{throw new Error('append failed');});
    await assert.rejects(ops.decide({cwd:f.cwd,as:parent,nodes:['a'],text:'Nothing',allow_only:[],dsa:sealed}),/append failed/);
    assert.equal(await readFile(join(f.cwd,'plan.json'),'utf8'),text); assert.equal((await readdir(f.cwd)).some(p=>p.includes('owed-decide')),false);
    t.mock.restoreAll();
    await ops.edit({cwd:f.cwd,as:parent,node:'a',set:['allow_only=[]'],note:'No grants'});
    await assert.rejects(ops.edit({cwd:f.cwd,as:parent,node:'a',unset:['allow_only'],note:'Remove cap'}),/allow_only widened/);
    await ops.edit({cwd:f.cwd,as:owner,channel:'flag',node:'a',unset:['allow_only'],note:'Owner removes cap'});
    s=(await f.state()).state; assert.equal(s.plan.nodes[0]!.allow_only,undefined); assert.equal((await ops.verify(f)).ok,true);
  } finally {t.mock.restoreAll();await f.cleanup();}
});
test('AO2: cap refusal retains closure/overlap reasons and never becomes overlap-only waits_on',async()=>{
  const r=await repo();
  try {
    const p={...plan(['lib/**']),closure:['lib/closed'],nodes:[...plan(['lib/**']).nodes,{id:'b',writes:['lib/owned/'],checks:[]}]};
    await r.put('plan.json',JSON.stringify(p)); await r.commit(); await ops.init({cwd:r.cwd,as:owner,channel:'flag',plan:JSON.stringify(p),measure:false,path:'plan.json'});
    await ops.dispatch({cwd:r.cwd,as:parent,node:'b'}); const a=await ops.dispatch({cwd:r.cwd,as:parent,node:'a'});
    await commitAt(a.worktree,{'lib/closed':'closure','lib/owned/x':'owner','lib/free':'allowed'}); await ops.submit({cwd:a.worktree,as:{role:'writer',id:'a#1'},node:'a'}); await ops.attest({cwd:r.cwd,node:'a'});
    let {state:s,entries}=await ops.readState(r); assert.deepEqual(grants(entries).flatMap(g=>g.paths),['lib/free']);
    let obs=writes(entries).at(-1)!; assert.match(obs.note!,/under closure/); assert.match(obs.note!,/owned by open node b/); assert.equal(obs.waits_on,undefined);
    assert.equal(R.withinWrites(s,'a','lib/free'),true);
    p.nodes[0]!.allow_only=[]; await ops.planSet({cwd:r.cwd,as:parent,plan:JSON.stringify(p)}); await ops.attest({cwd:r.cwd,node:'a'});
    ({state:s,entries}=await ops.readState(r)); obs=writes(entries).at(-1)!; assert.match(obs.note!,/outside allow_only/); assert.equal(obs.waits_on,undefined); assert.equal(R.withinWrites(s,'a','lib/free'),false);
    assert.equal((await ops.verify(r)).ok,true);
  } finally {await r.cleanup();}
});
test('AO6: multiple node cap + writes replacements replay as one decision without unrelated plan edits',async()=>{
  const r=await repo();
  try {
    const p={...plan(),allow:[],nodes:[{id:'a',writes:['src/a/'],checks:[]},{id:'b',writes:['src/b/'],checks:[]}]};
    await r.put('plan.json',JSON.stringify(p)); await r.commit(); await ops.init({cwd:r.cwd,as:owner,channel:'flag',plan:JSON.stringify(p),measure:false,path:'plan.json'});
    await ops.planSet({cwd:r.cwd,as:parent,...await ops.readPlan({cwd:r.cwd,path:'plan.json'})});
    for(const node of ['a','b']) {const slot=await ops.dispatch({cwd:r.cwd,as:parent,node});await commitAt(slot.worktree,{[`src/${node}/x`]:'x'});await ops.submit({cwd:slot.worktree,as:{role:'writer',id:`${node}#1`},node});}
    const out=await ops.decide({cwd:r.cwd,as:owner,channel:'flag',nodes:['a','b'],text:'Shared cap, explicit writes',writes:['extra/x'],allow_only:['lib/samples.mjs'],resume:false,dsa:sealed});
    assert.deepEqual(out.entries.map(e=>e.kind),['plan','submit','submit','rule']);
    const s=(await ops.readState(r)).state;for(const n of s.plan.nodes){assert.deepEqual(n.allow_only,['lib/samples.mjs']);assert.equal(n.writes.at(-1),'extra/x');}
    assert.equal((await ops.verify(r)).ok,true);
  } finally {await r.cleanup();}
});
test('AO6/R-030-AO-2: CLI/tool reject mixed cap no-ops before writes, all-no-op and writes changes remain valid',async()=>{
  const r=await repo();
  try {
    const p={...plan(),allow:[],nodes:[{id:'a',writes:['src/a/'],checks:[],allow_only:['lib/x']},{id:'b',writes:['src/b/'],checks:[],allow_only:['lib/**']}]};
    await r.put('plan.json',JSON.stringify(p)); await r.commit(); await ops.init({cwd:r.cwd,as:owner,channel:'flag',plan:JSON.stringify(p),measure:false,path:'plan.json'});
    await ops.planSet({cwd:r.cwd,as:parent,...await ops.readPlan({cwd:r.cwd,path:'plan.json'})});
    const text=await readFile(join(r.cwd,'plan.json'),'utf8'), ledger=await Ledger.open(r.cwd), bytes=await readFile(join(ledger.dir,'ledger.jsonl'),'utf8');
    const denied=await cli(r.cwd,['decide','a,b','--allow-only','lib/x','--text','Narrow']);
    assert.equal(denied.code,2); assert.match(denied.stderr,/allow_only of a is already \[lib\/x\]; decide only the changed nodes \(b\), or decide a separately/);
    const tools=new Map<string,ToolDefinition>(); owed({registerTool:(d:ToolDefinition)=>tools.set(d.name,d),registerCommand(){},on(){}} as unknown as ExtensionAPI);
    const out=await tools.get('owed_decide')!.execute('mixed',{nodes:['a','b'],text:'Narrow',allow_only:['lib/x'],cwd:r.cwd},undefined,undefined,{cwd:r.cwd,hasUI:false} as never);
    assert.equal(out.isError,true); assert.match(JSON.stringify(out),/decide only the changed nodes/);
    assert.equal(await readFile(join(r.cwd,'plan.json'),'utf8'),text); assert.equal(await readFile(join(ledger.dir,'ledger.jsonl'),'utf8'),bytes);
    // Both nodes have a writes change, so an already-equal cap does not exclude a from the changed set.
    const changed=await ops.decide({cwd:r.cwd,as:owner,channel:'flag',nodes:['a','b'],text:'Explicit writes and cap',allow_only:['lib/x'],writes:['extra/x'],resume:false,dsa:sealed});
    assert.ok(changed.plan); assert.deepEqual((await ops.readState(r)).state.plan.nodes.map(n=>n.allow_only),[['lib/x'],['lib/x']]);
    const unchangedText=await readFile(join(r.cwd,'plan.json'),'utf8');
    const same=await cli(r.cwd,['decide','a,b','--allow-only','lib/x','--text','Keep both']); assert.equal(same.code,0,same.stderr);
    assert.equal(await readFile(join(r.cwd,'plan.json'),'utf8'),unchangedText);
    assert.equal((await ops.verify(r)).ok,true);
  } finally {await r.cleanup();}
});
test('AO6: CLI, tool and packet expose caps, including [] and owner-only widening',async()=>{
  const f=await fixture(['lib/**']);
  try {
    assert.match(f.slot.packet,/allow_only: \[lib\/\*\*\]/);
    const r=await cli(f.cwd,['decide','a','--allow-only','lib/samples.mjs','--text','Narrow']); assert.equal(r.code,0,r.stderr);
    assert.match(r.stdout,/allow_only/); assert.deepEqual((await f.state()).state.plan.nodes[0]!.allow_only,['lib/samples.mjs']);
    const bad=await cli(f.cwd,['decide','a','--allow-only','lib/**','--text','Widen']); assert.notEqual(bad.code,0); assert.match(bad.stderr,/allow_only widened/);
    const tools=new Map<string,ToolDefinition>(); owed({registerTool:(d:ToolDefinition)=>tools.set(d.name,d),registerCommand(){},on(){}} as unknown as ExtensionAPI);
    const tool=tools.get('owed_decide')!; assert.ok('allow_only' in (tool.parameters as {properties:Record<string,unknown>}).properties);
    const result=await tool.execute('ao',{nodes:['a'],text:'Empty cap',allow_only:[],cwd:f.cwd},undefined,undefined,{cwd:f.cwd,hasUI:false} as never);
    assert.equal(result.isError,undefined,JSON.stringify(result)); assert.deepEqual((await f.state()).state.plan.nodes[0]!.allow_only,[]);
    const lines=preauthorizedWritesLines((await f.state()).state,'a').join('\n'); assert.match(lines,/allow_only/); assert.doesNotMatch(lines,/edit these freely/);
    const empty=await cli(f.cwd,['decide','a','--allow-only','','--text','Keep empty']); assert.equal(empty.code,0,empty.stderr);
    assert.equal((await ops.verify(f)).ok,true);
  } finally {await f.cleanup();}
});
