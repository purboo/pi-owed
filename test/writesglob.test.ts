import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import * as R from '../src/reducer.ts';
import { parsePlan, planDowngrades } from '../src/plan.ts';
import { git, stateFacts, candidateFacts } from '../src/git.ts';
import { Ledger, entryHash } from '../src/ledger.ts';
import { decide, writerLaunch } from '../src/drive.ts';
import { renderReceipt, renderStatusBrief } from '../src/views.ts';
import { canonical } from '../src/canon.ts';
import { stringify } from 'yaml';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';
import type { Draft, Entry, Plan, State } from '../src/types.ts';
const owner = {role:'owner' as const,id:'test'}, parent = {role:'parent' as const,id:'test'};
const node = (id:string,writes:string[]) => ({id,writes,checks:[],review:{count:0,min_rank:1}});
const plan = (extra:Record<string,unknown> = {}) => ({version:1,trunk:'main',closure:[],invariants:[],nodes:[node('a',['src/']),node('b',['docs/shared/'])],allow:[{nodes:['a'],writes:['docs/']}],...extra});
async function fixture(p=plan(), legacy=false) {
  const r=await repo();
  const commit=await commitAt(r.cwd,{'src/base':'base','docs/base':'base'}), ledger=await Ledger.open(r.cwd);
  if (legacy) {
    const parsed=parsePlan(JSON.stringify(p)), sha=await ledger.putBlob(stringify(JSON.parse(canonical(parsed)),{sortMapEntries:true}));
    const facts=await stateFacts(r.cwd,parsed,commit);
    await ledger.withLock(()=>ledger.append([{kind:'genesis',by:'owner:test',channel:'flag',trunk:'main',commit,plan:sha,state:facts}]));
  } else await ops.init({cwd:r.cwd,plan:JSON.stringify(p),as:owner,channel:'flag'});
  const slot=await ops.dispatch({cwd:r.cwd,node:'a',as:parent});
  const state=async()=>{
    const es=await ledger.read(), plans=new Map<string,Plan>();
    for(const e of es) if(e.kind==='genesis'||e.kind==='plan') plans.set(e.plan,parsePlan((await ledger.getBlob(e.plan)).toString()));
    const lookup=(sha:string)=>plans.get(sha)!;
    return {s:R.reduce(es,lookup),es,lookup};
  };
  const submit=async(files:Record<string,string>)=>{await commitAt(slot.worktree,files);await ops.submit({cwd:slot.worktree,node:'a',as:{role:'writer',id:'a#1'}});};
  const attest=()=>ops.attest({cwd:r.cwd,node:'a'});
  return {...r,slot,ledger,state,submit,attest};
}
const writes=(es:Entry[])=>es.filter((e):e is Extract<Entry,{kind:'obs'}>=>e.kind==='obs'&&e.obligation==='writes'&&e.subject==='a');
const grants=(es:Entry[])=>es.filter((e):e is Extract<Entry,{kind:'grant'}>=>e.kind==='grant'&&e.node==='a');
function forged(s:State,d:Draft):Entry {const e={...d,seq:s.seq+1,ts:new Date().toISOString(),prev:s.head} as Entry;e.hash=entryHash(e);return e;}
async function driverState(r:Awaited<ReturnType<typeof fixture>>) {
  const {s,lookup}=await r.state(), project=R.projectId(s), launch=writerLaunch(s,'a',project);
  const launched=R.reduceFrom(s,[forged(s,{kind:'launch',by:'parent:drive',node:'a',attempt:1,role:'writer',rid:launch.rid,spec:await r.ledger.putBlob(launch.spec),labels:launch.labels})],lookup);
  const actions=()=>decide(launched,launched.plan,new Map([[launch.rid,{rid:launch.rid,state:'sealed',status:'ok'}]]),{max:2,repairs:1,project,root:r.cwd,applied:new Set(),rejected:new Map()});
  return {s:launched,actions};
}

test('WG1 keeps historical parsing lenient but rejects unsupported syntax at new plan entry points',async()=>{
  const bad=['/absolute','a/../b','a/[xy]','a/{x}','!a','a/b**','a/**suffix','a/***/x'];
  const fresh=await repo();try {
    for(const entry of bad) for(const where of ['node','writes','adopt']) {
      const p=where==='node'?plan({nodes:[node('a',[entry])]}):plan({allow:[{nodes:['a'],[where]:[entry]}]});
      assert.doesNotThrow(()=>parsePlan(JSON.stringify(p)),`historical ${where}: ${entry}`);
      await assert.rejects(ops.init({cwd:fresh.cwd,plan:JSON.stringify(p),as:owner,channel:'flag'}),e=>e instanceof Error&&e.message.includes(entry),`${where}: ${entry}`);
    }
  }finally{await fresh.cleanup();}
  const r=await fixture();try {
    const file=join(r.cwd,'plan.json');await writeFile(file,JSON.stringify(plan()));
    for(const entry of bad) {
      const out=await cli(r.cwd,['amend','a','--plan',file,'--writes',`+${entry}`,'--note','test','--as','owner:test','--i-am-owner']);
      assert.notEqual(out.code,0);assert.ok((out.stdout+out.stderr).includes(entry),out.stdout+out.stderr);
      await assert.rejects(ops.planSet({cwd:r.cwd,as:owner,channel:'flag',plan:JSON.stringify(plan({nodes:[node('a',[entry])]}))}),e=>e instanceof Error&&e.message.includes(entry));
      await assert.rejects(ops.edit({cwd:r.cwd,node:'a',as:owner,channel:'flag',plan:file,note:'test',set:[`writes=${JSON.stringify([entry])}`]}),e=>e instanceof Error&&e.message.includes(entry));
    }
    assert.equal((await r.ledger.read()).length,2,'refused plan entry points record nothing');
  }finally{await r.cleanup();}
});

test('WG1-WG2 node writes globs match zero/multiple segments, question marks, literals and merge recheck',async()=>{
  const r=await fixture(plan({nodes:[node('a',['app/src/**/*_tests.rs','fixture/**','one/?.ts','literal.+(x)*.ts'])]}));try{
    await r.submit({'app/src/root_tests.rs':'a','app/src/nested/deep_tests.rs':'b','fixture/nested/file':'c','one/a.ts':'d','literal.+(x)ok.ts':'e'});
    assert.equal((await r.attest()).accepted,true);
    const {s}=await r.state();
    assert.equal(R.withinWrites(s,'a','one/ab.ts'),false);assert.equal(R.withinWrites(s,'a','one/x/a.ts'),false);
    assert.equal(R.withinWrites(s,'a','app/src/prod.rs'),false);assert.equal(R.withinWrites(s,'a','literalZZok.ts'),false);
    await ops.merge({cwd:r.cwd,node:'a',as:parent});
    assert.equal((await r.state()).s.nodes.a!.phase,'merged');
  }finally{await r.cleanup();}
});

test('WG2 allow writes and parent adopt share glob matching; grants stay exact',async()=>{
  const r=await fixture(plan({allow:[{nodes:['a'],writes:['app/src/**/*_tests.rs'],adopt:['scripts/**/*.mjs']}]}));try{
    await r.submit({'app/src/top_tests.rs':'a','app/src/deep/nested_tests.rs':'b'});
    assert.equal((await r.attest()).accepted,true);
    let {s,es}=await r.state();assert.deepEqual(grants(es)[0]!.paths,['app/src/deep/nested_tests.rs','app/src/top_tests.rs']);
    assert.equal(R.withinWrites(s,'a','app/src/top_tests.rs/child'),false);
    await ops.merge({cwd:r.cwd,node:'a',as:parent});
    await commitAt(r.cwd,{'scripts/top.mjs':'a','scripts/deep/run.mjs':'b'});
    await ops.adopt({cwd:r.cwd,note:'allowed scripts',as:parent});
    await commitAt(r.cwd,{'scripts/run.ts':'c'});
    await assert.rejects(ops.adopt({cwd:r.cwd,note:'not allowed',as:parent}),/scripts\/run.ts/);
  }finally{await r.cleanup();}
});

test('WG3 conservative containment and overlap units, including ** equivalent prefixes',async()=>{
  const {writeCovers,writeOverlaps,matchesWrite}=await import('../src/writes.ts');
  for(const [a,b,expected] of [
    ['src/','src/**/*.ts',true],['src/**','src/a?.ts',true],['src/','src/**',true],['src/**','src/',true],
    ['src/*.ts','src/*.ts',true],['src/*.ts','src/a.ts',false],['src/a*.ts','src/ab*.ts',false],['other/','src/*.ts',false],
  ] as const) assert.equal(writeCovers(a,b),expected,`${a} covers ${b}`);
  for(const [a,b,expected] of [['src/a*.rs','src/b*.rs',false],['src/a*.rs','src/ab*.ts',true],['**/x','other/',true],['foo/','foobar/',false],['dir/**','dir/x',true]] as const) {
    assert.equal(writeOverlaps(a,b),expected);assert.equal(R.writesOverlap([a],[b]),expected);
  }
  assert.equal(matchesWrite('srcExtra','src'),true,'legacy prefix semantics');
  assert.equal(matchesWrite('dir/nested/file','dir/**'),true);
  assert.equal(matchesWrite('root.rs','**/*.rs'),true);
  assert.equal(matchesWrite('root.rs\n','**/*.rs'),false,'glob must consume a trailing newline too');
});

test('WG3 plan widening under a glob allowance requires conservative containment, not path matching',async()=>{
  const p=plan({allow:[{nodes:['a'],writes:['app/**/*_tests.rs']}]}), r=await fixture(p);try{
    // Exact glob equality is covered; a literal path that matches it is not proven prefix containment.
    await ops.planSet({cwd:r.cwd,as:parent,plan:JSON.stringify({...p,nodes:[node('a',['src/','app/**/*_tests.rs']),node('b',['docs/shared/'])]})});
    const {s}=await r.state(), next={...s.plan,nodes:s.plan.nodes.map(n=>n.id==='a'?{...n,writes:[...n.writes,'app/top_tests.rs']}:n)};
    assert.ok(planDowngrades(s.plan,next).some(d=>d.what==='writes widened'));
    await assert.rejects(ops.planSet({cwd:r.cwd,as:parent,plan:JSON.stringify(next)}),/owner|downgrade|writes/i);
    assert.equal(R.writesAllowed(s.plan,'a',['app/top_tests.rs']),true,'exact changed files can still be granted');
  }finally{await r.cleanup();}
});

test('WG4 partial grant lists each uncovered/closure/overlap refusal, without waits_on for mixed reasons',async()=>{
  const r=await fixture(plan({closure:['docs/pinned*']}));try{
    await ops.dispatch({cwd:r.cwd,node:'b',as:parent});
    await r.submit({'docs/z':'z','docs/a':'a','docs/pinned':'p','docs/shared/x':'s','private/no':'n'});await r.attest();
    const {es}=await r.state(), obs=writes(es)[0]!;
    assert.deepEqual(grants(es).map(g=>g.paths),[['docs/a','docs/z']]);assert.equal(obs.verdict,'fail');assert.equal(obs.waits_on,undefined);
    assert.match(obs.note!,/docs\/pinned \(under closure\)/);assert.match(obs.note!,/docs\/shared\/x \(owned by open node b\)/);assert.match(obs.note!,/private\/no \(not covered by an allow rule\)/);
    assert.doesNotMatch(obs.note!,/outside writes: docs\/a/);
    assert.equal((await r.ledger.getBlob(obs.log!)).toString(),obs.note);
    await r.attest();assert.equal(grants((await r.state()).es).length,1);
    const {actions}=await driverState(r);assert.ok(actions().some(a=>a.do==='send'&&a.reason==='repair'));
  }finally{await r.cleanup();}
});

for(const close of ['merge','abandon'] as const) test(`WG5 driver waits then remeasures the same writes key exactly once after owner ${close}`,async()=>{
  const r=await fixture();try{
    const b=await ops.dispatch({cwd:r.cwd,node:'b',as:parent});
    await r.submit({'docs/shared/x':'s','docs/free':'f'});await r.attest();
    let {s,es}=await r.state();const first=writes(es)[0]!;
    assert.deepEqual(first.waits_on,['b']);assert.deepEqual(grants(es)[0]!.paths,['docs/free']);
    assert.match(renderReceipt(await ops.why({cwd:r.cwd,node:'a'})),/re-measured automatically after b merges/);
    assert.deepEqual(R.attestJobs(s,'a'),[]);assert.deepEqual((await driverState(r)).actions().filter(a=>'node' in a&&a.node==='a'),[],'no repair or halt while ownership is open');
    if(close==='merge') {
      await commitAt(b.worktree,{'docs/shared/b':'b'});await ops.submit({cwd:b.worktree,node:'b',as:{role:'writer',id:'b#1'}});
      await ops.attest({cwd:r.cwd,node:'b'});await ops.merge({cwd:r.cwd,node:'b',as:parent});
    }else await ops.abandon({cwd:r.cwd,node:'b',reason:'done elsewhere',as:parent});
    s=(await r.state()).s;assert.deepEqual(R.attestJobs(s,'a').map(j=>[j.obligation,j.key,j.attribution]),[['writes',first.key,undefined]]);
    assert.ok((await driverState(r)).actions().some(a=>a.do==='attest'&&a.node==='a'));
    assert.equal((await r.attest()).accepted,true);
    ({s,es}=await r.state());assert.equal(writes(es).length,2);assert.equal(writes(es)[1]!.key,first.key);assert.equal(writes(es)[1]!.verdict,'pass');
    assert.equal(s.nodes.a!.items.find(i=>i.obligation==='writes')!.mark,'✔');assert.equal(s.nodes.a!.blocks[0]!.state,'cleared');
    assert.deepEqual(R.attestJobs(s,'a'),[]);await r.attest();assert.equal(writes((await r.state()).es).length,2);
    const {lookup}=await r.state();const restored=R.unpackState(structuredClone(R.packState(s)),lookup);assert.equal(restored.nodes.a!.accepted,true);
    await ops.merge({cwd:r.cwd,node:'a',as:parent});
  }finally{await r.cleanup();}
});

test('WG5 waits for all owners, validates waits_on on replay, and measures new candidates fresh',async()=>{
  const p=plan({nodes:[node('a',['src/']),node('b',['docs/b/']),node('c',['docs/c/'])]}), r=await fixture(p);try{
    await ops.dispatch({cwd:r.cwd,node:'b',as:parent});await ops.dispatch({cwd:r.cwd,node:'c',as:parent});
    await r.submit({'docs/b/x':'b','docs/c/x':'c'});await r.attest();
    let {s,es,lookup}=await r.state();assert.deepEqual(writes(es)[0]!.waits_on,['b','c']);
    const c=s.nodes.a!.candidate!, d:Extract<Draft,{kind:'obs'}>={kind:'obs',by:'executor:owed',subject:'a',obligation:'writes',key:c.keys.writes!,commit:c.commit,base:c.base,verdict:'fail',exit:1,durationMs:0,waits_on:['b']};
    assert.throws(()=>R.reduceFrom(s,[forged(s,d)],lookup),/waits_on/);
    assert.throws(()=>R.reduceFrom(s,[forged(s,{...d,waits_on:['b','c'],verdict:'pass'})],lookup),/waits_on/);
    await ops.abandon({cwd:r.cwd,node:'b',as:parent,reason:'release one owner'});s=(await r.state()).s;assert.deepEqual(R.attestJobs(s,'a'),[]);
    await r.submit({'docs/b/x':'new'});s=(await r.state()).s;
    assert.ok(R.attestJobs(s,'a').some(j=>j.obligation==='writes'&&!j.attribution),'new key measures even while c stays open');
    await r.attest();es=(await r.state()).es;assert.deepEqual(writes(es).at(-1)!.waits_on,['c']);
    await ops.abandon({cwd:r.cwd,node:'c',as:parent,reason:'release last owner'});
    assert.equal((await r.attest()).accepted,true,'fresh candidate clears superseded overlap-only blocks too');
  }finally{await r.cleanup();}
});

test('WG5 rebase measures a fresh writes key and clears the old overlap-only block',async()=>{
  const r=await fixture();try{
    const b=await ops.dispatch({cwd:r.cwd,node:'b',as:parent});
    await r.submit({'docs/shared/x':'x'});await r.attest();const first=writes((await r.state()).es)[0]!;
    await commitAt(b.worktree,{'docs/shared/b':'b'});await ops.submit({cwd:b.worktree,node:'b',as:{role:'writer',id:'b#1'}});
    await ops.attest({cwd:r.cwd,node:'b'});await ops.merge({cwd:r.cwd,node:'b',as:parent});
    const rebase=await ops.rebase({cwd:r.cwd,node:'a',as:parent});
    await git(r.slot.worktree,['rebase','--onto',rebase.base,rebase.from]);
    await ops.submit({cwd:r.slot.worktree,node:'a',as:{role:'writer',id:'a#1'}});
    assert.equal((await r.attest()).accepted,true);const {s,es}=await r.state();
    assert.notEqual(writes(es).at(-1)!.key,first.key);assert.equal(s.nodes.a!.blocks[0]!.state,'cleared');
    await ops.merge({cwd:r.cwd,node:'a',as:parent});
  }finally{await r.cleanup();}
});

test('WG5 overlap waiting does not suppress repair of an unrelated failed check',async()=>{
  const a={...node('a',['src/']),checks:[{id:'unit',run:`printf 'owed-counts {"pass":0,"fail":1,"failed":["regression"]}\\n'; exit 1`,reads:['src/'],min_tests:1}]};
  const r=await fixture(plan({nodes:[a,node('b',['docs/shared/'])]}));try{
    await ops.dispatch({cwd:r.cwd,node:'b',as:parent});await r.submit({'docs/shared/x':'x'});await r.attest();
    assert.deepEqual(writes((await r.state()).es)[0]!.waits_on,['b']);
    const {actions}=await driverState(r);assert.ok(actions().some(a=>a.do==='send'&&a.reason==='repair'&&a.node==='a'));
  }finally{await r.cleanup();}
});

test('WG5 ordinary writes failures retain same-key conflicts and cannot forge waits_on',async()=>{
  const r=await fixture(plan({allow:[]}));try{
    await r.submit({'outside/no':'no'});await r.attest();const {s,lookup}=await r.state(), c=s.nodes.a!.candidate!;
    const d:Extract<Draft,{kind:'obs'}>={kind:'obs',by:'executor:owed',subject:'a',obligation:'writes',key:c.keys.writes!,commit:c.commit,base:c.base,verdict:'fail',exit:1,durationMs:0,waits_on:['b']};
    assert.throws(()=>R.reduceFrom(s,[forged(s,d)],lookup),/waits_on/);
    const next=R.reduceFrom(s,[forged(s,{...d,waits_on:undefined,verdict:'pass',exit:0})],lookup);
    assert.equal(next.nodes.a!.items.find(i=>i.obligation==='writes')!.mark,'⊤');assert.equal(next.nodes.a!.accepted,false);
  }finally{await r.cleanup();}
});

test('WG2098 legacy brackets and wildcard prefixes replay cold and retain grants, overlap, exec and adopt semantics',async()=>{
  const {writesSyntax}=await import('../src/writes.ts');
  const p=plan({nodes:[node('a',['app/[id]/','a*b/','q?/']),node('b',['axxb/'])],allow:[{nodes:['a'],writes:['grant*/','grant?/'],adopt:['tool?/']}]});
  const r=await fixture(p,true);try{
    let {s,es,lookup}=await r.state();assert.equal('writes_syntax' in es[0]!,false);
    assert.equal(R.withinWrites(s,'a','app/[id]/x'),true);assert.equal(R.withinWrites(s,'a','app/i/x'),false);
    assert.equal(R.withinWrites(s,'a','a*b/x'),true);assert.equal(R.withinWrites(s,'a','axxb/x'),false);
    assert.equal(R.withinWrites(s,'a','q?/x'),true);assert.equal(R.withinWrites(s,'a','qz/x'),false);
    await ops.dispatch({cwd:r.cwd,node:'b',as:parent});assert.deepEqual(R.overlapping((await r.state()).s,'a'),[]);
    assert.equal(R.writesAllowed(s.plan,'a',['grant*/x','grant?/y']),true);assert.equal(R.writesAllowed(s.plan,'a',['grantZZ/x']),false);
    await r.submit({'app/[id]/x':'a','a*b/x':'b','q?/x':'q','grant*/x':'g'});assert.equal((await r.attest()).accepted,true);
    ({s,es,lookup}=await r.state());assert.deepEqual(grants(es)[0]!.paths,['grant*/x']);
    assert.equal(writesSyntax(R.unpackState(structuredClone(R.packState(s)),lookup).plan),1);
    // A fresh CLI process must reparse the historical blob after an old-version cache is discarded.
    await r.ledger.removeSnapshot();await writeFile(join(r.ledger.dir,'cache','plans',`${s.planSha}.json`),JSON.stringify({v:'plan-cache/1 owed/0.20.0',sha:s.planSha,plan:s.plan}));
    const status=await cli(r.cwd,['status','--full']);assert.equal(status.code,0,status.stdout+status.stderr);
    assert.equal((await ops.verify({cwd:r.cwd})).ok,true);
    await ops.merge({cwd:r.cwd,node:'a',as:parent});
    await commitAt(r.cwd,{'tool?/run':'allowed'});await ops.adopt({cwd:r.cwd,note:'literal legacy prefix',as:parent});
    await commitAt(r.cwd,{'toolX/run':'outside'});await assert.rejects(ops.adopt({cwd:r.cwd,note:'not a literal match',as:parent}),/toolX\/run/);
    // NT: retained legacy literals no longer prevent an otherwise valid plan edit.
    const updated=await ops.planSet({cwd:r.cwd,plan:JSON.stringify(p),as:owner,channel:'flag'});
    assert.equal(updated.kind,'plan');assert.equal(writesSyntax((await r.state()).s.plan),2);
  }finally{await r.cleanup();}
});

test('WG2098 identical plan blobs keep distinct recorded syntax, keys and historical queries',async()=>{
  const {writesSyntax,withWritesSyntax}=await import('../src/writes.ts');
  const p=plan({nodes:[node('a',['a*b/'])],allow:[]}), r=await fixture(p,true);try{
    await r.submit({'a*b/file':'literal prefix'});assert.equal((await r.attest()).accepted,true);
    let {s}=await r.state();const oldKey=s.nodes.a!.candidate!.keys.writes!, sha=s.planSha;
    await assert.rejects(ops.planSet({cwd:r.cwd,plan:JSON.stringify(p),as:parent}),/owner|writes/i);
    const entry=await ops.planSet({cwd:r.cwd,plan:JSON.stringify(p),as:owner,channel:'flag'});
    assert.equal(entry.kind,'plan');if(entry.kind!=='plan')return;
    assert.equal(entry.writes_syntax,2);assert.equal(entry.plan,sha,'dialect is on the entry, not in the blob');
    let {es,lookup}=await r.state();s=(await r.state()).s;
    assert.equal(writesSyntax(R.planAt(s,entry.seq)),1);assert.equal(writesSyntax(R.planAt(s,entry.seq+1)),2);
    assert.equal(R.withinWrites({...s,plan:R.planAt(s,entry.seq)},'a','a*b/file'),true);
    assert.equal(R.withinWrites(s,'a','a*b/file'),false);
    assert.notEqual(s.nodes.a!.candidate!.keys.writes,oldKey,'carry recomputes an isolated writes key');
    const restored=R.unpackState(structuredClone(R.packState(s)),lookup);assert.equal(writesSyntax(restored.plan),2);assert.equal(R.withinWrites(restored,'a','a*b/file'),false);
    assert.equal((await r.attest()).accepted,false);es=(await r.state()).es;assert.equal(writes(es).at(-1)!.verdict,'fail');
    await r.ledger.removeSnapshot();await r.ledger.removePlanCache(`${sha}.json`);
    assert.equal((await cli(r.cwd,['status'])).code,0);
    const modern=withWritesSyntax(parsePlan(JSON.stringify(p)),2);
    assert.notEqual((await candidateFacts(r.cwd,modern,modern.nodes[0]!,s.nodes.a!.candidate!.base,s.nodes.a!.candidate!.commit,1)).keys.writes,oldKey);
  }finally{await r.cleanup();}
});

test('WG2098 syntax opt-in for wildcard allowances needs owner authority and records a new allowance seq',async()=>{
  const p=plan({allow:[{nodes:['a'],writes:['docs/*'],adopt:['scripts/?']}]}), r=await fixture(p,true);try{
    let {s}=await r.state();assert.equal(R.writesAllowed(s.plan,'a',['docs/file']),false);assert.equal(R.unadoptable(s.plan,['scripts/x']),'scripts/x');
    await assert.rejects(ops.planSet({cwd:r.cwd,plan:JSON.stringify(p),as:parent}),/owner|allow/i);
    const e=await ops.planSet({cwd:r.cwd,plan:JSON.stringify(p),as:owner,channel:'flag'});
    s=(await r.state()).s;assert.equal(R.allowanceSeq(s),e.seq);assert.equal(R.writesAllowed(s.plan,'a',['docs/file']),true);assert.equal(R.unadoptable(s.plan,['scripts/x']),undefined);
    await r.submit({'docs/file':'g'});assert.equal((await r.attest()).accepted,true);assert.equal(grants((await r.state()).es)[0]!.allowance,e.seq);
  }finally{await r.cleanup();}
});

test('WG2098 every new genesis/plan/edit/amend records syntax 2 and rejects unknown syntax versions',async()=>{
  const p=plan({allow:[]}), r=await fixture(p);try{
    const file=join(r.cwd,'plan.json');await writeFile(file,JSON.stringify(p));
    await ops.planSet({cwd:r.cwd,plan:JSON.stringify(p),path:file,as:owner,channel:'flag'});
    await ops.edit({cwd:r.cwd,node:'a',plan:file,set:['title=edited'],note:'new title',as:owner,channel:'flag'});
    await ops.amend({cwd:r.cwd,node:'a',plan:file,writes:['+more/'],note:'new ownership',as:owner,channel:'flag'});
    const {s,es,lookup}=await r.state(), laws=es.filter(e=>e.kind==='genesis'||e.kind==='plan');
    assert.equal(laws.length,4);for(const e of laws)if(e.kind==='genesis'||e.kind==='plan')assert.equal(e.writes_syntax,2);
    const d={kind:'plan',by:'owner:test',prior:s.planSha,plan:s.planSha,downgrades:[],writes_syntax:3} as unknown as Draft;
    assert.throws(()=>R.reduceFrom(s,[forged(s,d)],lookup),/writes_syntax/);
  }finally{await r.cleanup();}
});

test('WG2098 new overlap observations and automatic retry also work under legacy prefix semantics',async()=>{
  const p=plan({nodes:[node('a',['a*b/']),node('b',['axxb/'])],allow:[{nodes:['a'],writes:['axxb/']}]}), r=await fixture(p,true);try{
    await ops.dispatch({cwd:r.cwd,node:'b',as:parent});
    await r.submit({'axxb/x':'outside the literal wildcard prefix'});await r.attest();
    let {s,es}=await r.state();const first=writes(es)[0]!;assert.deepEqual(first.waits_on,['b']);
    assert.equal(R.withinWrites(s,'a','axxb/x'),false);assert.equal('writes_syntax' in es[0]!,false);
    assert.deepEqual(R.attestJobs(s,'a'),[]);
    await ops.abandon({cwd:r.cwd,node:'b',as:parent,reason:'release legacy ownership'});
    assert.equal((await r.attest()).accepted,true);({s,es}=await r.state());
    assert.equal(writes(es).at(-1)!.key,first.key);assert.deepEqual(grants(es)[0]!.paths,['axxb/x']);
    assert.equal(s.nodes.a!.blocks[0]!.state,'cleared');
  }finally{await r.cleanup();}
});

test('WG2098 driver halts with Needs-you for a writes ownership cycle and names a resolution',async()=>{
  const p=plan({nodes:[node('a',['a/']),node('b',['b/'])],allow:[{nodes:['*'],writes:['a/','b/']}]}), r=await fixture(p);try{
    const b=await ops.dispatch({cwd:r.cwd,node:'b',as:parent});
    await r.submit({'b/x':'a owns b path'});await r.attest();
    assert.equal(R.writesWaitCycle((await r.state()).s,'a'),undefined,'an owner without a waiting candidate is not a cycle');
    await commitAt(b.worktree,{'a/x':'b owns a path'});await ops.submit({cwd:b.worktree,node:'b',as:{role:'writer',id:'b#1'}});await ops.attest({cwd:r.cwd,node:'b'});
    assert.deepEqual(R.writesWaitCycle((await r.state()).s,'a'),['a','b','a']);
    const {actions}=await driverState(r), halt=actions().find(a=>a.do==='halt'&&a.node==='a');assert.ok(halt&&halt.do==='halt');
    assert.match(halt.reason,/writes ownership wait cycle: a -> b -> a/);assert.match(halt.reason,/owed resume a/);
    await ops.halt({cwd:r.cwd,node:'a',attempt:1,reason:halt.reason,needs:halt.needs,as:{role:'parent',id:'drive'}});
    assert.match(renderStatusBrief(await ops.status({cwd:r.cwd})),/Needs you[\s\S]*writes ownership wait cycle: a -> b -> a/);
    await ops.abandon({cwd:r.cwd,node:'b',as:parent,reason:'break cycle'});assert.equal(R.writesWaitCycle((await r.state()).s,'a'),undefined);
  }finally{await r.cleanup();}
});
