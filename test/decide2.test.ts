// DF1–DF4: decide follow-ups (in-flight groups for unlocked readers, per-node question hints, metrics, rev compatibility).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { projectId, runId, runLabels } from '../src/reducer.ts';
import { decide as driveDecide, type Action } from '../src/drive.ts';
import type { Draft, RunView } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { commitAt } from './helpers/surface.ts';
const parent = {role:'parent',id:'test'} as const, owner = {role:'owner',id:'pi'} as const;
class FakeDsa {
  views = new Map<string,RunView>();
  sends: {rid:string;kind:string}[] = [];
  async describe(rid:string): Promise<RunView> { return this.views.get(rid) ?? {rid,state:'sealed',status:'ok'}; }
  async send(_id:string,rid:string,kind:string) { this.sends.push({rid,kind}); return {outcome:'applied' as const,spec_digest:'test'}; }
  ask(rid:string,qid='q1',rev=1) { this.views.set(rid,{rid,state:'asking',questions:[{qid,rev,question:'Which interface?'}]}); }
}
async function fixture(extra: Record<string,unknown> = {}) {
  const r = await repo(), plan = JSON.stringify({version:1,trunk:'main',lease:false,closure:[],...extra,invariants:[{id:'unit',run:'true',reads:['a.txt','b.txt']}],nodes:[{id:'a',writes:['a.txt'],checks:[]},{id:'b',writes:['b.txt'],checks:[]}]});
  await r.put('plan.json',plan); await r.commit();
  await ops.init({cwd:r.cwd,as:owner,channel:'delegated',plan,measure:false});
  await ops.planSet({cwd:r.cwd,as:parent,...await ops.readPlan({cwd:r.cwd,path:'plan.json'})});
  const dsa = new FakeDsa();
  async function slot(node='a') {
    const d = await ops.dispatch({cwd:r.cwd,as:parent,node});
    await commitAt(d.worktree,{[`${node}.txt`]:'candidate'}); await ops.submit({cwd:d.worktree,as:{role:'writer',id:`${node}#1`},node});
  }
  async function launch(node='a',role:'writer'|'reviewer'='writer') {
    const s = (await ops.readState(r)).state, project = projectId(s), rid = runId(project,node,1,role,role==='reviewer'?1:undefined);
    return (await ops.launch({cwd:r.cwd,as:parent,node,attempt:1,role,rid,spec:'{}',labels:runLabels(project,node,1,role),rulings:0})).entry;
  }
  return {...r,dsa,slot,launch};
}

test('DF1: unlocked loads hide an incomplete final decision group; locked acts and verify still refuse',async()=>{
  const f=await fixture();
  try {
    await f.slot();
    const base=await ops.readState(f), d=await ops.decide({cwd:f.cwd,as:owner,channel:'delegated',nodes:['a'],text:'Accept the debt',defer:'unit',dsa:f.dsa});
    assert.deepEqual(d.entries.map(e=>e.kind),['defer','rule']);
    const ledger=await Ledger.open(f.cwd), file=join(ledger.dir,'ledger.jsonl'), full=await readFile(file,'utf8');
    // The first member is on disk, the ruling is not: an atomic decision write in flight.
    const lines=full.split('\n').filter(Boolean); await writeFile(file,lines.slice(0,d.decision+1).map(l=>l+'\n').join(''));
    await rm(join(ledger.dir,'snapshot'),{recursive:true,force:true}); ops.forgetReplays();
    const seen=await ops.readState(f);
    assert.equal(seen.state.seq,base.state.seq); assert.equal(seen.entries.length,base.entries.length);
    assert.equal(seen.state.deferred.length,0);
    assert.equal((await ops.status(f)).nodes.a?.candidate?.commit,base.state.nodes.a!.candidate!.commit);
    assert.equal((await ops.loadDriverState(await Ledger.open(f.cwd))).seq,base.state.seq);
    assert.ok(await ops.report({cwd:f.cwd}));
    const snap=await ledger.readSnapshot(); assert.ok(!snap || snap.seq<d.decision,'no snapshot inside the group');
    // A lock holder (an act) and verify refuse exactly as before; nothing is appended.
    await assert.rejects(ops.rule({cwd:f.cwd,as:parent,nodes:['a'],text:'later'}),new RegExp(`decision #${d.decision}.*interrupted atomic write`));
    assert.equal((await readFile(file,'utf8')).split('\n').filter(Boolean).length,d.decision+1);
    const verified=await ops.verify(f); assert.equal(verified.ok,false); assert.match(verified.error!,/interrupted atomic write/);
    // The write completes: the memo from the in-flight read folds the whole group.
    await writeFile(file,full);
    const after=await ops.readState(f); assert.equal(after.state.seq,d.rule.seq); assert.equal(after.state.deferred.length,1);
    assert.equal((await ops.verify(f)).ok,true);
  } finally {await f.cleanup();}
});

const opts=(s:Awaited<ReturnType<typeof ops.readState>>['state'],root:string)=>({max:1,repairs:2,project:projectId(s),root,applied:new Set<string>(),rejected:new Map()});
const notices=(actions:Action[])=>actions.flatMap(a=>a.do==='notify'&&!a.quiet?[a.text]:[]);

test('DF2: questions are counted per node across writer and reviewer runs',async()=>{
  const f=await fixture();
  try {
    await f.slot(); await ops.halt({cwd:f.cwd,as:{role:'parent',id:'drive'},node:'a',attempt:1,reason:'check failed',needs:'human'});
    const w=await f.launch('a','writer'), r=await f.launch('a','reviewer');
    f.dsa.ask(w.rid); f.dsa.ask(r.rid);
    let s=(await ops.readState(f)).state, texts=notices(driveDecide(s,s.plan,f.dsa.views,opts(s,f.cwd)));
    assert.ok(texts.length>=1, 'an asking notice');
    for (const t of texts) { assert.doesNotMatch(t,/owed decide a|owed_decide/); assert.match(t,/owed answer a --rid \S+ --qid q1/); }
    // The suggested decide would refuse as ambiguous; the per-question answer is accepted.
    await assert.rejects(ops.decide({cwd:f.cwd,as:parent,nodes:['a'],text:'x',dsa:f.dsa}),/Ambiguous/);
    // One question across all runs: the single decide act.
    f.dsa.views.set(w.rid,{rid:w.rid,state:'running'});
    s=(await ops.readState(f)).state; texts=notices(driveDecide(s,s.plan,f.dsa.views,opts(s,f.cwd)));
    assert.ok(texts.some(t=>t.includes(r.rid)));
    for (const t of texts) { assert.match(t,/owed decide a --text/); assert.doesNotMatch(t,/owed answer a/); }
    const done=await ops.decide({cwd:f.cwd,as:parent,nodes:['a'],text:'Keep it',dsa:f.dsa}); assert.equal(done.answered,1);
    // DF5 (3): the reviewer's question, shown while the writer also asks, gets the answer hint too.
    await f.slot('b'); await ops.halt({cwd:f.cwd,as:{role:'parent',id:'drive'},node:'b',attempt:1,reason:'check failed',needs:'human'});
    const rb=await f.launch('b','reviewer'), wb=await f.launch('b','writer'); f.dsa.ask(rb.rid); f.dsa.ask(wb.rid);
    s=(await ops.readState(f)).state; texts=notices(driveDecide(s,s.plan,f.dsa.views,opts(s,f.cwd))).filter(t=>t.startsWith('b:'));
    const reviewerText=texts.find(t=>t.includes(`reviewer run ${rb.rid}`)); assert.ok(reviewerText,texts.join('\n'));
    assert.ok(reviewerText.includes(`owed answer b --rid ${rb.rid} --qid q1`),reviewerText); assert.doesNotMatch(reviewerText,/owed decide b|owed_decide/);
  } finally {await f.cleanup();}
});

test('DF3: metrics count every answer of a multi-answer decision',async()=>{
  const f=await fixture();
  try {
    await f.slot('a'); await f.slot('b');
    const a=await f.launch('a'), b=await f.launch('b'); f.dsa.ask(a.rid); f.dsa.ask(b.rid);
    const before=await ops.reportMetrics(f);
    const d=await ops.decide({cwd:f.cwd,as:parent,nodes:['a','b'],text:'Use v2',dsa:f.dsa});
    assert.equal(d.rule.answers?.length,2);
    const m=await ops.reportMetrics(f);
    assert.equal(m.interruptions.answers-before.interruptions.answers,2);
    assert.equal(m.parentActs.byClass.answer-before.parentActs.byClass.answer,1);
    assert.equal(m.parentActs.byClass.rule,before.parentActs.byClass.rule);
  } finally {await f.cleanup();}
});

test('DF4: a recorded answer rev that is an integer beyond the safe range validates as before decide',async()=>{
  const f=await fixture();
  try {
    await f.slot(); const l=await f.launch();
    const rev=2**53+2, ledger=await Ledger.open(f.cwd);
    assert.ok(Number.isInteger(rev) && !Number.isSafeInteger(rev));
    const draft:Draft={kind:'rule',by:'parent:test',nodes:['a'],writer:false,text:'Answer to writer question q1: old answer',answer:{rid:l.rid,qid:'q1',rev}};
    const [e]=await ledger.withLock(()=>ledger.append([draft]));
    ops.forgetReplays();
    const verified=await ops.verify(f); assert.equal(verified.ok,true,verified.error);
    assert.equal((await ops.readState(f)).state.seq,e!.seq);
  } finally {await f.cleanup();}
});

const tail1=(d:{decision:number})=>d.decision+1;
async function halfGroup() {
  const f=await fixture({sweep:{run:"printf 'TAP version 13\\nok 1 - swept\\n1..1\\n# tests 1\\n# pass 1\\n# fail 0\\n'",timeout_s:10}});
  await f.slot();
  const base=await ops.readState(f), d=await ops.decide({cwd:f.cwd,as:owner,channel:'delegated',nodes:['a'],text:'Accept the debt',defer:'unit',dsa:f.dsa});
  const ledger=await Ledger.open(f.cwd), file=join(ledger.dir,'ledger.jsonl'), lines=(await readFile(file,'utf8')).split('\n').filter(Boolean);
  const half=lines.slice(0,tail1(d)).map(l=>l+'\n').join(''); await writeFile(file,half);
  await rm(join(ledger.dir,'snapshot'),{recursive:true,force:true}); ops.forgetReplays();
  return {f,base,d,ledger,file,half};
}

test('DF5: a load through another Ledger instance inside the lock refuses a half group; torn lines are not dropped',async()=>{
  const {f,base,d,ledger,file,half}=await halfGroup();
  try {
    assert.equal((await ops.readState(f)).state.seq,base.state.seq);
    await assert.rejects(ledger.withLock(async()=>{ await ops.readState(f); }),new RegExp(`decision #${d.decision}.*interrupted atomic write`));
    await assert.rejects(ledger.withLock(()=>ops.readState(f)),/interrupted atomic write/);
    assert.equal(await readFile(file,'utf8'),half);
    // DF5 (2): a torn final fragment is dropped only for unlocked readers, whichever instance holds the lock.
    await writeFile(file,half+'{"kind":"no');
    assert.equal((await (await Ledger.open(f.cwd)).read()).length,tail1(d));
    await assert.rejects(ledger.withLock(async()=>(await Ledger.open(f.cwd)).read()),/invalid JSON|incomplete line/);
  } finally {await f.cleanup();}
});

test('DF5: a sweep at a half decision group appends nothing',async()=>{
  const {f,d,file,half}=await halfGroup();
  try {
    await assert.rejects(ops.sweep({cwd:f.cwd}),new RegExp(`decision #${d.decision}.*interrupted atomic write`));
    assert.equal(await readFile(file,'utf8'),half);
  } finally {await f.cleanup();}
});
