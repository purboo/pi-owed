// GR: real repositories, locked measurement and replay validity.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ops from '../src/ops.ts';
import { Ledger, entryHash } from '../src/ledger.ts';
import { parsePlan } from '../src/plan.ts';
import { H } from '../src/canon.ts';
import { git } from '../src/git.ts';
import * as R from '../src/reducer.ts';
const { reduce, reduceFrom, packState, unpackState, overlapping, mergeGuard } = R;
const grantsOf = (...args: Parameters<typeof R.grantsOf>) => R.grantsOf(...args);
const withinWrites = (...args: Parameters<typeof R.withinWrites>) => R.withinWrites(...args);
import { renderReceipt, renderReport, renderBrief, briefView, reviewPacket, preauthorizedWritesLines } from '../src/views.ts';
import { writerTask, decide, writerLaunch, repairMessage } from '../src/drive.ts';
import { projectId } from '../src/reducer.ts';
import type { Entry, Draft, Plan, State } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { commitAt, cli } from './helpers/surface.ts';
const owner = { role:'owner' as const,id:'test' }, parent = {role:'parent' as const,id:'test'};
const node = (id:string,writes:string[], review=0) => ({id,writes,checks:[],review:{count:review,min_rank:1}});
function plan(extra:Record<string,unknown> = {}) { return {version:1,trunk:'main',closure:[],invariants:[],nodes:[node('a',['src/']),node('b',['other/'])],allow:[{nodes:['a'],writes:['docs/','root']}],...extra}; }
async function fixture(p=plan()) {
  const r=await repo();
  await commitAt(r.cwd,{'src/base':'base','docs/base':'base'});
  await ops.init({cwd:r.cwd,plan:JSON.stringify(p),as:owner,channel:'flag'});
  const slot=await ops.dispatch({cwd:r.cwd,node:'a',as:parent});
  const ledger=await Ledger.open(r.cwd);
  const all=() => ledger.read();
  const state=async () => {
    const es=await all(), plans=new Map<string,Plan>();
    for(const e of es) if(e.kind === 'genesis' || e.kind === 'plan') plans.set(e.plan,parsePlan((await ledger.getBlob(e.plan)).toString()));
    return {s:reduce(es,sha=>plans.get(sha)!),es,lookup:(sha:string)=>plans.get(sha)!};
  };
  const submit=async (files:Record<string,string>) => { const commit=await commitAt(slot.worktree,files); await ops.submit({cwd:slot.worktree,node:'a',as:{role:'writer',id:'a#1'}}); return commit; };
  const attest=() => ops.attest({cwd:r.cwd,node:'a'});
  return {...r,slot,ledger,all,state,submit,attest};
}
const grants = (es:Entry[]) => es.filter((e): e is Extract<Entry,{kind:'grant'}> => e.kind === 'grant');
const writes = (es:Entry[]) => es.filter((e): e is Extract<Entry,{kind:'obs'}> => e.kind === 'obs' && e.obligation === 'writes');
function forged(s:State,d:Draft):Entry { const e={...d,seq:s.seq+1,ts:new Date().toISOString(),prev:s.head} as Entry; e.hash=entryHash(e); return e; }

test('covered changed paths get one grant before pass, no failing observation, and audit views', async()=>{
  const r=await fixture(); try {
    await r.submit({'docs/z':'z','docs/a':'a'}); const result=await r.attest(), es=await r.all(), g=grants(es)[0]!;
    assert.equal(grants(es).length,1); assert.deepEqual(g.paths,['docs/a','docs/z']); assert.equal(g.by,'executor:owed'); assert.equal(g.allowance,0);
    assert.equal(writes(es).length,1); assert.equal(writes(es)[0]!.verdict,'pass'); assert.equal(writes(es)[0]!.seq,g.seq+1);
    assert.equal(writes(es)[0]!.note,`all changed paths within writes (granted #${g.seq}: docs/a, docs/z)`);
    assert.equal(result.accepted,true); await r.attest(); assert.equal(grants(await r.all()).length,1);
    const card=await ops.why({cwd:r.cwd,node:'a'}); assert.deepEqual(card.grantedWrites?.[0]?.paths,g.paths);
    assert.match(renderReceipt(card),/Granted writes: docs\/a, docs\/z \(#\d+, allowance plan #0\)/);
    assert.match(renderReceipt(card),/granted by owed under allowance \(plan #0\)/);
    assert.match(renderReport(await ops.report({cwd:r.cwd})),/granted by owed under allowance \(plan #0\)/);
    const {s}=await r.state(); assert.match(renderBrief(briefView(s,es)),/Downgrades under allowance[\s\S]*granted by owed/);
  } finally {await r.cleanup();}
});
test('uncovered paths fail atomically with first reason and deduplicated learning hint', async()=>{
  const r=await fixture(); try {
    await r.submit({'docs/ok':'ok','new/a':'a','new/b':'b','rootfile':'r','uncovered':'u'}); await r.attest();
    const es=await r.all(); assert.equal(grants(es).length,0); assert.equal(writes(es)[0]!.verdict,'fail');
    assert.equal(writes(es)[0]!.note,'outside writes: docs/ok, new/a, new/b, rootfile, uncovered; not covered by an allow rule');
    assert.doesNotMatch(writes(es)[0]!.note!,/hint:/);
    assert.equal((await r.ledger.getBlob(writes(es)[0]!.log!)).toString(),writes(es)[0]!.note);
    const hint='hint: an allow rule {nodes: ["a"], writes: ["new/","uncovered"]} would let owed grant these';
    assert.ok(renderReceipt(await ops.why({cwd:r.cwd,node:'a'})).includes(hint));
    assert.ok((await cli(r.cwd,['why','a'])).stdout.includes(hint));
    await assert.rejects(ops.merge({cwd:r.cwd,node:'a',as:parent}),e=>e instanceof Error && e.message.includes(hint));
    const {s,lookup}=await r.state(), project=projectId(s), action=writerLaunch(s,'a',project);
    const launched=reduceFrom(s,[forged(s,{kind:'launch',by:'parent:drive',node:'a',attempt:1,role:'writer',rid:action.rid,spec:await r.ledger.putBlob(action.spec),labels:action.labels})],lookup);
    const actions=decide(launched,launched.plan,new Map([[action.rid,{rid:action.rid,state:'sealed',status:'ok'}]]),{max:2,repairs:0,project,root:r.cwd,applied:new Set(),rejected:new Map()});
    assert.ok(actions.some(a=>a.do === 'halt' && a.reason.split(hint).length === 2),'driver halt includes learning hint exactly once');
    assert.equal(repairMessage(launched,'a').split(hint).length,2,'repair packet includes learning hint exactly once');
    const repair=decide(launched,launched.plan,new Map([[action.rid,{rid:action.rid,state:'sealed',status:'ok'}]]),{max:2,repairs:1,project,root:r.cwd,applied:new Set(),rejected:new Map()});
    assert.ok(repair.some(a=>a.do === 'send' && a.reason === 'repair' && a.message.split(hint).length === 2));
  } finally {await r.cleanup();}
});
test('a legacy writes failure never claims a grant refusal; rerun measures after attribution', async()=>{
  const r=await fixture(plan({allow:[]})); try {
    await r.submit({'docs/a':'a'});
    const {s}=await r.state(), c=s.nodes.a!.candidate!;
    // A valid 0.16-shaped executor observation has no GR2 reason.
    await r.ledger.withLock(()=>r.ledger.append([{kind:'obs',by:'executor:owed',subject:'a',obligation:'writes',key:c.keys.writes!,commit:c.commit,base:c.base,verdict:'fail',exit:1,durationMs:0,note:'outside writes: docs/a',log:'legacy'}]));
    await ops.planSet({cwd:r.cwd,as:owner,channel:'flag',plan:JSON.stringify(plan())});
    let card=await ops.why({cwd:r.cwd,node:'a'}), text=renderReceipt(card);
    assert.doesNotMatch(text,/but grant refused/); assert.match(text,/hint: paths are now pre-authorized; submit a new commit or rerun attest/);
    assert.equal(card.outOfWrites?.grantRefused,undefined);
    await r.attest();
    assert.equal(grants(await r.all()).length,0,'active failure is attributed first');
    await ops.attest({cwd:r.cwd,node:'a',rerun:true});
    assert.equal(grants(await r.all()).length,1,'--rerun measures the same key after attribution');
  } finally {await r.cleanup();}
});
test('failure before an allowance existed is not presented as a refused covered grant', async()=>{
  const r=await fixture(plan({allow:[]})); try {
    await r.submit({'docs/a':'a'}); await r.attest();
    await ops.planSet({cwd:r.cwd,as:owner,channel:'flag',plan:JSON.stringify(plan())});
    assert.doesNotMatch(renderReceipt(await ops.why({cwd:r.cwd,node:'a'})),/but grant refused/);
  } finally {await r.cleanup();}
});
test('dispatch-time allowance comparison ignores object key insertion order', async()=>{
  const r=await fixture(); try {
    const {s,lookup}=await r.state();
    const next={...s.plan,allow:s.plan.allow!.map(rule=>Object.fromEntries(Object.entries(rule).reverse()))} as typeof s.plan;
    const updated=reduceFrom(s,[forged(s,{kind:'plan',by:'owner:test',channel:'flag',plan:'reordered',prior:s.planSha,downgrades:[]})],sha=>sha === 'reordered' ? next : lookup(sha));
    assert.match(preauthorizedWritesLines(updated,'a',updated.seq+1)[0]!,/allowance plan #0/);
  } finally {await r.cleanup();}
});
test('closure paths are never granted, including mixed covered paths', async()=>{
  const r=await fixture(plan({closure:['docs/pinned*']})); try {
    await r.submit({'docs/pinned':'x','docs/ok':'y'}); await r.attest();
    assert.equal(grants(await r.all()).length,0); assert.match(writes(await r.all())[0]!.note!,/under closure/);
    assert.match(renderReceipt(await ops.why({cwd:r.cwd,node:'a'})),/but grant refused/);
    const {s,lookup}=await r.state();
    assert.throws(()=>reduceFrom(s,[forged(s,{kind:'grant',by:'executor:owed',node:'a',attempt:1,commit:s.nodes.a!.candidate!.commit,paths:['docs/pinned'],allowance:0})],lookup),/under closure/);
  } finally {await r.cleanup();}
});
test('another open slot owns its plan writes: overlap refuses the entire grant', async()=>{
  const r=await fixture(plan({nodes:[node('a',['src/']),node('b',['docs/shared/'])]})); try {
    await ops.dispatch({cwd:r.cwd,node:'b',as:parent}); await r.submit({'docs/shared/x':'x','docs/ok':'x'}); await r.attest();
    assert.equal(grants(await r.all()).length,0); assert.match(writes(await r.all())[0]!.note!,/overlaps open node b/);
    const {s,lookup}=await r.state();
    assert.throws(()=>reduceFrom(s,[forged(s,{kind:'grant',by:'executor:owed',node:'a',attempt:1,commit:s.nodes.a!.candidate!.commit,paths:['docs/shared/x'],allowance:0})],lookup),/overlaps open node b/);
  } finally {await r.cleanup();}
});
test('later candidates reuse attempt grants, grant only new paths, and --rerun does not duplicate', async()=>{
  const r=await fixture(); try {
    await r.submit({'docs/a':'a'}); await r.attest(); await r.submit({'docs/a':'edited','docs/b':'b'}); await r.attest();
    assert.deepEqual(grants(await r.all()).map(g=>g.paths),[['docs/a'],['docs/b']]);
    const again=await ops.attest({cwd:r.cwd,node:'a',rerun:true}); assert.equal(again.accepted,true);
    assert.equal(grants(await r.all()).length,2); assert.match(writes(await r.all()).at(-1)!.note!,/granted #\d+: docs\/a; granted #\d+: docs\/b/);
  } finally {await r.cleanup();}
});
test('new attempt starts without grants', async()=>{
  const r=await fixture(); try {
    await r.submit({'docs/a':'a'}); await r.attest(); await ops.abandon({cwd:r.cwd,node:'a',as:parent,reason:'retry'});
    const slot=await ops.dispatch({cwd:r.cwd,node:'a',as:parent});
    let {s}=await r.state(); assert.deepEqual(grantsOf(s,'a'),[]); assert.equal(withinWrites(s,'a','docs/a'),false);
    await commitAt(slot.worktree,{'docs/a':'second'}); await ops.submit({cwd:slot.worktree,node:'a',as:{role:'writer',id:'a#2'}}); await r.attest();
    assert.deepEqual(grants(await r.all()).map(g=>g.attempt),[1,2]);
  } finally {await r.cleanup();}
});
test('same commit on a new attempt cannot reuse a previous grant-supported writes pass', async()=>{
  const r=await fixture(); try {
    const commit=await r.submit({'docs/a':'a'}); await r.attest();
    await ops.abandon({cwd:r.cwd,node:'a',as:parent,reason:'retry same commit'});
    await ops.planSet({cwd:r.cwd,as:owner,channel:'flag',plan:JSON.stringify(plan({allow:[]}))});
    const slot=await ops.dispatch({cwd:r.cwd,node:'a',as:parent});
    await git(slot.worktree,['merge','--ff-only',commit]);
    await ops.submit({cwd:slot.worktree,node:'a',as:{role:'writer',id:'a#2'}});
    const before=(await r.state()).s; assert.equal(before.nodes.a!.accepted,false);
    await r.attest(); assert.equal(writes(await r.all()).at(-1)!.verdict,'fail'); assert.equal(grants(await r.all()).length,1);
  } finally {await r.cleanup();}
});
test('recorded grants survive allowance removal and plan updates, including snapshot replay', async()=>{
  const r=await fixture(); try {
    await r.submit({'docs/a':'a'}); await r.attest();
    await ops.planSet({cwd:r.cwd,as:owner,channel:'flag',plan:JSON.stringify(plan({allow:[],nodes:[node('a',['src/','extra/']),node('b',['other/'])]}))});
    const {s,es,lookup}=await r.state(); assert.equal(withinWrites(s,'a','docs/a'),true);
    const unpacked=unpackState(packState(s),lookup); assert.equal(withinWrites(unpacked,'a','docs/a'),true);
    await ops.attest({cwd:r.cwd,node:'a',rerun:true}); assert.equal(grants(await r.all()).length,1); assert.equal(writes(await r.all()).at(-1)!.verdict,'pass');
    assert.equal(grants(es)[0]!.allowance,0);
  } finally {await r.cleanup();}
});
test('rebasing an open attempt keeps grants and measurement passes on the new base', async()=>{
  const r=await fixture(); try {
    await r.submit({'docs/a':'a'}); await r.attest();
    const b=await ops.dispatch({cwd:r.cwd,node:'b',as:parent}); await commitAt(b.worktree,{'other/b':'b'});
    await ops.submit({cwd:b.worktree,node:'b',as:{role:'writer',id:'b#1'}}); await ops.attest({cwd:r.cwd,node:'b'}); await ops.merge({cwd:r.cwd,node:'b',as:parent});
    const rebase=await ops.rebase({cwd:r.cwd,node:'a',as:parent});
    await git(r.slot.worktree,['rebase','--onto',rebase.base,rebase.from]); await ops.submit({cwd:r.slot.worktree,node:'a',as:{role:'writer',id:'a#1'}});
    assert.equal((await r.attest()).accepted,true); assert.equal(grants(await r.all()).length,1); assert.match(writes(await r.all()).at(-1)!.note!,/granted #/);
  } finally {await r.cleanup();}
});
test('removed nodes retain ownership while their writer slot remains open', async()=>{
  const p=plan({nodes:[node('a',['src/']),node('b',['docs/shared/'])]});
  const r=await fixture(p); try {
    await ops.dispatch({cwd:r.cwd,node:'b',as:parent});
    await ops.planSet({cwd:r.cwd,as:owner,channel:'flag',plan:JSON.stringify({...p,nodes:[node('a',['src/'])]})});
    await r.submit({'docs/shared/x':'x'}); await r.attest(); assert.equal(grants(await r.all()).length,0); assert.match(writes(await r.all())[0]!.note!,/overlaps open node b/);
  } finally {await r.cleanup();}
});
test('effective writes merge recheck accepts exact grants, refuses ungranted changes', async()=>{
  const r=await fixture(); try {
    await r.submit({'docs/a':'a'}); await r.attest(); const {s}=await r.state(), c=s.nodes.a!.candidate!;
    const m={facts:{...c,base:s.trunk.commit},state:{commit:c.commit,tree:c.tree,invKeys:{}}};
    assert.equal(mergeGuard(s,'a',m).ok,true);
    const bad={...m,facts:{...m.facts,changed:[...c.changed,'docs/a/child'],keys:{...c.keys,writes:'different'}}};
    assert.ok(mergeGuard(s,'a',bad).reasons.some(x=>x.includes('writes merge changes exceed allowed paths')));
    assert.equal(withinWrites(s,'a','docs/a/child'),false,'granted files are not prefixes');
    await ops.merge({cwd:r.cwd,node:'a',as:parent}); assert.equal((await r.state()).s.nodes.a!.phase,'merged');
  } finally {await r.cleanup();}
});
test('replay refuses forged principals, uncovered paths, wrong allowance and stale candidate commits', async()=>{
  const r=await fixture(); try {
    const commit=await r.submit({'docs/a':'a','outside/x':'x'}); const {s,lookup}=await r.state();
    const d:Extract<Draft,{kind:'grant'}>={kind:'grant',by:'executor:owed',node:'a',attempt:1,commit,paths:['docs/a'],allowance:0};
    for(const [change,re] of [
      [{by:'writer:a#1'},/only be written by executor:owed/],
      [{paths:['outside/x']},/not covered by an allow rule/],
      [{allowance:99},/current allowance plan seq/],
      [{commit:'stale'},/current candidate commit/],
      [{attempt:2},/current open writer slot/],
      [{paths:['docs/not-changed']},/current candidate changed paths/],
      [{paths:['docs/a','docs/a']},/sorted unique exact/],
      [{paths:['docs/']},/sorted unique exact/],
    ] as const) assert.throws(()=>reduceFrom(s,[forged(s,{...d,...change} as Draft)],lookup),re);
    const granted=reduceFrom(s,[forged(s,d)],lookup);
    assert.throws(()=>reduceFrom(granted,[forged(granted,d)],lookup),/already granted/);
  } finally {await r.cleanup();}
});
test('dispatch and review packets include owner preauthorization and grants, including driver tasks', async()=>{
  const r=await fixture(plan({nodes:[node('a',['src/'],1),node('b',['other/'])]})); try {
    assert.match(r.slot.packet,/Allowed writes: src\/\nPre-authorized by the owner \(allowance plan #0\): docs\/, root/);
    let {s}=await r.state(); assert.match(writerTask(s,'a'),/owed records the grant; do not ask/);
    await r.submit({'docs/a':'a'}); await r.attest(); ({s}=await r.state());
    const packet=reviewPacket(s,'a'); assert.match(packet,/Writes granted under allowance \(plan #0\): docs\/a — judge whether each belongs to this node's task; block if not\./);
    await ops.planSet({cwd:r.cwd,as:owner,channel:'flag',plan:JSON.stringify(plan({allow:[],nodes:[node('a',['src/'],1),node('b',['other/'])]}))});
    assert.match(writerTask((await r.state()).s,'a'),/allowance plan #0/,'driver rebuilds dispatch-time permission, not the latest plan');
  } finally {await r.cleanup();}
});
test('dispatch overlap includes exact granted paths; another grant cannot steal them', async()=>{
  const r=await fixture(plan({allow:[{nodes:['*'],writes:['docs/']}]})); try {
    await r.submit({'docs/a':'a'}); await r.attest();
    await ops.planSet({cwd:r.cwd,as:owner,channel:'flag',plan:JSON.stringify(plan({allow:[{nodes:['*'],writes:['docs/']}],nodes:[node('a',['src/']),node('b',['docs/'])]}))});
    const {s}=await r.state(); assert.deepEqual(overlapping(s,'b'),['a']);
    await assert.rejects(ops.dispatch({cwd:r.cwd,node:'b',as:parent}),/overlap/);
    await ops.dispatch({cwd:r.cwd,node:'b',as:parent,allowOverlap:true});
    const es=await r.all(), current=(await r.state()).s;
    const slot=current.nodes.b!.slot!;
    const commit=await commitAt(slot.worktree,{'docs/a':'b'}); await ops.submit({cwd:slot.worktree,node:'b',as:{role:'writer',id:'b#1'}});
    // Remove b's plan prefix so its request would otherwise be covered by allow.
    await ops.planSet({cwd:r.cwd,as:owner,channel:'flag',plan:JSON.stringify(plan({allow:[{nodes:['*'],writes:['docs/']}]}))});
    await ops.attest({cwd:r.cwd,node:'b'});
    const all=await r.all(); assert.equal(grants(all).length,grants(es).length); assert.match(writes(all).filter(x=>x.subject === 'b').at(-1)!.note!,/overlaps open node a/); assert.ok(commit);
  } finally {await r.cleanup();}
});
test('grant-free ledger preserves the 0.16 writes key formula and ready/accepted states', async()=>{
  const r=await fixture(plan({allow:[]})); try {
    await r.submit({'src/a':'a'}); let {s}=await r.state(); const c=s.nodes.a!.candidate!;
    assert.equal(c.keys.writes,H({o:'writes',base:c.base,cand:c.commit,writes:['src/']}));
    assert.equal(s.nodes.a!.phase,'submitted'); assert.equal(s.nodes.b!.phase,'ready'); await r.attest();
    ({s}=await r.state()); assert.equal(s.nodes.a!.phase,'accepted'); assert.equal(grants(await r.all()).length,0); assert.equal('grantedWrites' in await ops.why({cwd:r.cwd,node:'a'}),false);
  } finally {await r.cleanup();}
});
