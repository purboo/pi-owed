// DC1–DC4: atomic CLI/ops/tool decisions, real git keys, answers and replay refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import * as ops from '../src/ops.ts';
import * as git from '../src/git.ts';
import { Ledger, entryHash } from '../src/ledger.ts';
import { reduce, reduceFrom, extendState, projectId, runId, runLabels, decisionTailErrors } from '../src/reducer.ts';
import { answeredQuestion, decide as driveDecide, deliveredRulings, askingText } from '../src/drive.ts';
import { renderStatus } from '../src/views.ts';
import { answerRetry } from '../src/answer.ts';
import type { Draft, Entry, RuleEntry, RunView } from '../src/types.ts';
import owed from '../src/extension.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';
const parent = {role:'parent',id:'test'} as const, owner = {role:'owner',id:'pi'} as const;
class FakeDsa {
  views = new Map<string,RunView>();
  sends: {id:string;rid:string;kind:string;text:string;extra?:{qid?:string;rev?:number}}[] = [];
  fail = new Set<string>();
  async describe(rid:string): Promise<RunView> { return this.views.get(rid) ?? {rid,state:'sealed',status:'ok'}; }
  async send(id:string,rid:string,kind:string,text:string | Uint8Array,extra?:{qid?:string;rev?:number}) {
    this.sends.push({id,rid,kind,text:String(text),extra});
    if (this.fail.has(rid)) throw new Error('delivery unavailable');
    return {outcome:'applied' as const,spec_digest:'test'};
  }
  ask(rid:string,qid='q1',rev=1) { this.views.set(rid,{rid,state:'asking',questions:[{qid,rev,question:'Which interface?'}]}); }
}
async function fixture() {
  const r = await repo(), plan = JSON.stringify({version:1,trunk:'main',lease:false,closure:[],invariants:[{id:'unit',run:'true',reads:['a.txt','b.txt']}],nodes:[{id:'a',writes:['a.txt'],checks:[]},{id:'b',writes:['b.txt'],checks:[]},{id:'fix',writes:['fix.txt'],checks:[]}]});
  await r.put('plan.json',plan); await r.commit();
  await ops.init({cwd:r.cwd,as:owner,channel:'delegated',plan,measure:false});
  await ops.planSet({cwd:r.cwd,as:parent,...await ops.readPlan({cwd:r.cwd,path:'plan.json'})});
  const dsa = new FakeDsa(), slots = new Map<string,ops.DispatchPacket>();
  async function slot(node='a',submit=true) {
    const d = await ops.dispatch({cwd:r.cwd,as:parent,node}); slots.set(node,d);
    if (submit) { await commitAt(d.worktree,{[`${node}.txt`]:'candidate'}); await ops.submit({cwd:d.worktree,as:{role:'writer',id:`${node}#1`},node}); }
    return d;
  }
  async function launch(node='a',role:'writer'|'reviewer'='writer') {
    const s = (await ops.readState(r)).state, project = projectId(s), rid=runId(project,node,1,role,role==='reviewer'?1:undefined);
    const l = (await ops.launch({cwd:r.cwd,as:parent,node,attempt:1,role,rid,spec:'{}',labels:runLabels(project,node,1,role),rulings:0})).entry;
    return l;
  }
  async function halt(node='a') { return ops.halt({cwd:r.cwd,as:{role:'parent',id:'drive'},node,attempt:1,reason:'check failed',needs:'human'}); }
  const options = {cwd:r.cwd,as:parent,nodes:['a'],text:'Keep the interface',dsa};
  return {...r,plan,dsa,slots,slot,launch,halt,options};
}
const tail = async (cwd:string,seq:number) => (await ops.readState({cwd})).entries.filter(e=>e.seq>seq);
function replayDrafts(base:Awaited<ReturnType<typeof ops.readState>>, drafts:Draft[], lookup:(sha:string)=>import('../src/types.ts').Plan) {
  let s=reduceFrom(base.state,[],lookup);
  for (const d of drafts) { const e={...d,seq:s.seq+1,ts:new Date().toISOString(),prev:s.head} as Entry; e.hash=entryHash(e); s=extendState(s,[e]); }
  const errors=decisionTailErrors(s); if(errors.length) throw new Error(errors.join('; '));
  return s;
}

test('DC1/DC2: plain rule, default halted resume, explicit resume, no-resume and held release',async()=>{
  const f=await fixture();
  try {
    await f.slot(); const h=await f.halt();
    const kept=await ops.decide({...f.options,resume:false});
    assert.deepEqual(kept.entries.map(e=>e.kind),['rule']);
    assert.equal((await ops.readState(f)).state.nodes.a!.halt?.seq,h.seq);
    assert.equal(kept.entries[0]!.decision,kept.decision);
    const r=await ops.decide(f.options);
    assert.deepEqual(r.entries.map(e=>e.kind),['rule','resume']);
    assert.ok(r.entries.every(e=>e.decision===r.decision && e.by==='parent:test'));
    assert.equal((await ops.readState(f)).state.nodes.a!.halt,undefined);
    const plain=await ops.decide(f.options); assert.deepEqual(plain.entries.map(e=>e.kind),['rule']);
    const explicit=await ops.decide({...f.options,resume:true,after:'fix',remeasure:true});
    const resume=explicit.entries.at(-1)!; assert.ok(resume.kind==='resume'); assert.equal(resume.after,'fix'); assert.equal(resume.remeasure,true);
    await ops.abandon({cwd:f.cwd,as:parent,node:'a',reason:'held',hold:true});
    const held=await ops.decide(f.options); assert.ok(held.entries[1]?.kind==='resume' && held.entries[1].release==='hold');
    assert.equal((await ops.verify(f)).ok,true);
  } finally {await f.cleanup();}
});

test('DC1/DC3: CLI repeated writes, one amendment ruling, carry and one-line receipt',async()=>{
  const f=await fixture();
  try {
    await f.slot(); await f.halt(); const before=await ops.readState(f), c=before.state.nodes.a!.candidate!;
    const r=await cli(f.cwd,['decide','a','--text','Only these files','--writes','+x.txt','--writes','+y.txt','--as','owner:pi']);
    assert.equal(r.code,0,r.stderr); assert.equal(r.stdout.trim().split('\n').length,1);
    assert.match(r.stdout,/^decision #\d+ for a: ruling #\d+; writes \+x.txt,\+y.txt \(plan #\d+\); resumed/);
    const es=await tail(f.cwd,before.state.seq); assert.deepEqual(es.map(e=>e.kind),['plan','submit','rule','resume']);
    assert.ok(es.every(e=>e.decision===es[0]!.seq));
    assert.equal(es[1]!.by,'executor:owed'); assert.ok(es[1]?.kind==='submit' && es[1].carry===c.seq);
    assert.deepEqual((await ops.readState(f)).state.plan.nodes[0]!.writes,['a.txt','x.txt','y.txt']);
    assert.equal((await ops.verify(f)).ok,true);
  } finally {await f.cleanup();}
});

test('DC1: multi-node amendment/defer/writer/resume uses pre-invalidation real merge keys, one append',async(t)=>{
  const f=await fixture();
  try {
    await f.slot('a'); await f.slot('b'); await f.halt('a'); await f.halt('b');
    const append=Ledger.prototype.append; let calls=0;
    t.mock.method(Ledger.prototype,'append',async function(this:Ledger,...args:Parameters<Ledger['append']>){calls++;return append.apply(this,args);});
    const s=(await ops.readState(f)).state, keys=new Map<string,string>();
    for(const node of ['a','b']) { const m=await git.buildMerge(f.cwd,s.trunk.commit,s.nodes[node]!.candidate!.commit,'fixture merge'); assert.ok(!('conflicts' in m)); keys.set(node,(await git.stateFacts(f.cwd,s.plan,m.commit)).invKeys.unit!); }
    const r=await ops.decide({...f.options,nodes:['a','b'],as:owner,channel:'delegated',writes:['+shared.txt'],defer:'inv:unit',writer:true});
    assert.equal(calls,1); assert.deepEqual(r.entries.map(e=>e.kind),['plan','submit','submit','defer','defer','rule','resume','resume']);
    for(const e of r.entries) {assert.equal(e.decision,r.decision);if(e.kind==='defer')assert.equal(e.items[0]!.key,keys.get(e.node));}
    const after=(await ops.readState(f)).state; assert.equal(after.nodes.a!.candidate,undefined); assert.equal(after.nodes.b!.candidate,undefined);
    assert.equal(after.deferred.length,2); assert.equal((await ops.verify(f)).ok,true);
  } finally {t.mock.restoreAll();await f.cleanup();}
});

test('DC1: no-writes defer starts group before its sole ruling and resumes only halted members',async()=>{
  const f=await fixture();
  try {await f.slot('a');await f.slot('b');await f.halt('b');const r=await ops.decide({...f.options,nodes:['a','b'],as:owner,channel:'delegated',defer:'unit'});assert.deepEqual(r.entries.map(e=>e.kind),['defer','defer','rule','resume']);assert.equal((await ops.verify(f)).ok,true);}finally{await f.cleanup();}
});

test('DC1: every refused component records nothing, leaves plan unchanged, and sends nothing',async()=>{
  const f=await fixture();
  try {
    await f.slot(); const original=await readFile(join(f.cwd,'plan.json'),'utf8');
    const bad: Partial<ops.DecideArgs>[]=[{text:' '},{nodes:['a','missing']},{writes:[]},{writes:['../bad']},{writes:['+../bad']},{writes:['+x'],as:parent},{defer:'unit'},{defer:'missing',as:owner,channel:'delegated'},{after:'missing'},{after:'a'},{resume:false,remeasure:true},{nodes:['a','fix'],resume:true},{as:{role:'writer',id:'a#1'}},{as:{role:'parent',id:'drive'}}];
    for(const part of bad) {const before=(await ops.readState(f)).entries.length;await assert.rejects(ops.decide({...f.options,...part}));assert.equal((await ops.readState(f)).entries.length,before);assert.equal(await readFile(join(f.cwd,'plan.json'),'utf8'),original);assert.equal(f.dsa.sends.length,0);}
    const before=(await ops.readState(f)).entries.length;
    await assert.rejects(ops.decide({...f.options,as:owner,channel:'delegated',writes:['+x'],after:'missing'}));assert.equal((await ops.readState(f)).entries.length,before);assert.equal(await readFile(join(f.cwd,'plan.json'),'utf8'),original);
    await writeFile(join(f.cwd,'plan.json'),original.replace('a.txt','other.txt'));
    await assert.rejects(ops.decide({...f.options,as:owner,channel:'delegated',writes:['+x']}),/unrecorded edits/);
  } finally {await f.cleanup();}
});

test('DC1: append failure removes temporary plan file, preserving ledger and source',async(t)=>{
  const f=await fixture();
  try {await f.slot();const before=await ops.readState(f),text=await readFile(join(f.cwd,'plan.json'),'utf8');t.mock.method(Ledger.prototype,'append',async()=>{throw new Error('append failed');});await assert.rejects(ops.decide({...f.options,as:owner,channel:'delegated',writes:['+x']}),/append failed/);assert.equal((await ops.readState(f)).entries.length,before.entries.length);assert.equal(await readFile(join(f.cwd,'plan.json'),'utf8'),text);assert.equal((await readdir(f.cwd)).filter(x=>x.includes('owed-decide')).length,0);}finally{t.mock.restoreAll();await f.cleanup();}
});

test('DC1: authority matches amend allowance and subagent rails; no implicit allowance widening',async()=>{
  const f=await fixture();
  try {await f.slot();const prior=process.env.DSA_CALL;process.env.DSA_CALL='child';try{await assert.rejects(ops.decide(f.options),/reserved for the main agent/);}finally{if(prior===undefined)delete process.env.DSA_CALL;else process.env.DSA_CALL=prior;}
    const s=(await ops.readState(f)).state,plan={...s.plan,allow:[{nodes:['a'],writes:['x.txt']}]};
    await ops.planSet({cwd:f.cwd,as:owner,channel:'delegated',plan:JSON.stringify(plan),note:'pre-authorized writes'});
    // AC1: covered paths do not widen the plan, and the decision still records its ruling.
    await writeFile(join(f.cwd,'plan.json'),JSON.stringify(plan));await ops.planSet({cwd:f.cwd,as:parent,...await ops.readPlan({cwd:f.cwd,path:'plan.json'})});
    const before=await ops.readState(f), decision=await ops.decide({...f.options,writes:['+x.txt']});
    assert.deepEqual(decision.entries.map(e=>e.kind),['rule']);
    assert.equal(decision.rule.text,`Keep the interface (writes already granted by allow rule, plan #${before.state.seq}: x.txt)`);
    assert.equal(decision.plan,undefined);
  }finally{await f.cleanup();}
});

test('DC1: one answer among decided nodes retains legacy answer; writer action remains explicit',async()=>{
  const f=await fixture();
  try {await f.slot('a');await f.slot('b');const l=await f.launch('b');f.dsa.ask(l.rid);const r=await ops.decide({...f.options,nodes:['a','b']});assert.deepEqual(r.rule.answer,{rid:l.rid,qid:'q1',rev:1});assert.equal(r.rule.answers,undefined);assert.equal(r.rule.text,'Answer to writer question q1: Keep the interface');assert.equal(f.dsa.sends.filter(s=>s.kind==='answer').length,1);assert.equal((await ops.verify(f)).ok,true);
    f.dsa.ask(l.rid,'q2',2);const action=await ops.decide({...f.options,nodes:['a','b'],writer:true});assert.equal(action.rule.writer,true);assert.equal((await ops.readState(f)).state.nodes.b!.candidate,undefined);assert.equal((await ops.verify(f)).ok,true);
  }finally{await f.cleanup();}
});

test('DC1/DC3: multiple answers reuse one ruling and owed_answer retry identity, no repeat decision',async()=>{
  const f=await fixture();
  try {
    await f.slot('a');await f.slot('b');const a=await f.launch('a'),b=await f.launch('b');f.dsa.ask(a.rid,"q'one",2);f.dsa.ask(b.rid,'q.two',3);f.dsa.fail.add(b.rid);
    const r=await ops.decide({...f.options,nodes:['b','a'],text:"Use 'v2'\nthen validate"});
    assert.equal(r.rule.answer,undefined);assert.equal(r.rule.text,"Use 'v2'\nthen validate");assert.deepEqual(r.rule.answers?.map(a=>a.node),['a','b']);assert.equal(r.answered,2);assert.equal(r.deliveryFailures.length,1);
    const output=ops.decideText(r);assert.equal(output.split('\n').length,2);assert.ok(output.includes(answerRetry('b',r.rule)));
    const sent=f.dsa.sends.filter(s=>s.kind==='answer');assert.equal(sent.length,2);assert.notEqual(sent[0]!.id,sent[1]!.id);
    const { execFile }=await import('node:child_process'),{promisify}=await import('node:util');
    const evaluated=await promisify(execFile)('/bin/bash',['-c',`owed() { printf '%s' "\${10}"; }; ${answerRetry('b',r.rule)}`]);
    assert.equal(evaluated.stdout,r.rule.text); // The exact displayed retry preserves bytes despite quoted multiline values.
    const count=(await ops.readState(f)).entries.length;f.dsa.fail.clear();f.dsa.views.clear();
    const retry=await ops.answer({...f.options,node:'b',text:r.rule.text,rid:b.rid,qid:'q.two',rev:3});assert.equal(retry.entry.seq,r.rule.seq);assert.equal((await ops.readState(f)).entries.length,count);assert.deepEqual(f.dsa.sends.at(-1),sent[1]);
    await assert.rejects(ops.answer({...f.options,node:'b',text:'changed',rid:b.rid,qid:'q.two',rev:3}),/different text/);
    assert.equal((await ops.verify(f)).ok,true);
  }finally{await f.cleanup();}
});

test('DC1: ambiguous questions and stale asynchronous discovery refuse the entire decision',async()=>{
  const f=await fixture();
  try {await f.slot();const l=await f.launch();f.dsa.ask(l.rid);f.dsa.views.get(l.rid)!.questions!.push({qid:'q2',rev:1,question:'Ambiguous?'});let before=(await ops.readState(f)).entries.length;await assert.rejects(ops.decide(f.options),/Ambiguous/);assert.equal((await ops.readState(f)).entries.length,before);
    f.dsa.ask(l.rid);f.dsa.describe=async rid=>{await ops.abandon({cwd:f.cwd,as:parent,node:'a',reason:'closed while discovering'});return f.dsa.views.get(rid)!;};before=(await ops.readState(f)).entries.length;await assert.rejects(ops.decide(f.options),/changed|open attempt/);assert.equal((await ops.readState(f)).entries.length,before+1);assert.equal(f.dsa.sends.length,0);
  }finally{await f.cleanup();}
});

test('DC1: answer ruling notifies other running roles after lock, target receives only answer',async()=>{
  const f=await fixture();
  try {await f.slot();const writer=await f.launch(),reviewer=await f.launch('a','reviewer');f.dsa.ask(writer.rid);f.dsa.views.set(reviewer.rid,{rid:reviewer.rid,state:'running'});
    const send=f.dsa.send.bind(f.dsa);f.dsa.send=async(...args)=>{assert.ok((await ops.readState(f)).entries.some(e=>e.decision!==undefined));const ledger=await Ledger.open(f.cwd);await ledger.withLock(async()=>{});return send(...args);};
    const r=await ops.decide(f.options);assert.deepEqual(f.dsa.sends.map(s=>[s.rid,s.kind]),[[reviewer.rid,'notify'],[writer.rid,'answer']]);const s=(await ops.readState(f)).state;assert.equal(deliveredRulings(s,'a',s.nodes.a!.runs[0]!,writer),r.rule.seq);assert.ok(s.nodes.a!.candidate);assert.equal(s.nodes.a!.items.find(i=>i.obligation==='rulings')?.status,'D');
  }finally{await f.cleanup();}
});

test('DC2: replay rejects forged principal, noncontiguous id, outside node, duplicate or wrong order',async()=>{
  const f=await fixture();
  try {await f.slot('a');await f.slot('b');const base=await ops.readState(f),lookup=(sha:string)=>{assert.equal(sha,base.state.planSha);return base.state.plan;},first=base.state.seq+1;
    const rule:Draft={kind:'rule',by:'parent:test',nodes:['a'],text:'decision',decision:first},resume:Draft={kind:'resume',by:'parent:test',node:'a',attempt:1,decision:first};
    for(const drafts of [[rule,{...resume,by:'parent:other'}],[rule,{...resume,decision:first-1}],[rule,{...resume,node:'b'}],[rule,{kind:'note',by:'parent:test',text:'gap'} as Draft,resume],[rule,rule],[resume,rule],[{...rule,decision:1.5}],[rule,{kind:'defer',by:'owner:pi',channel:'delegated',node:'a',items:[{id:'unit',key:'key'}],reason:'late',decision:first} as Draft]]) assert.throws(()=>replayDrafts(base,drafts,lookup));
    assert.doesNotThrow(()=>replayDrafts(base,[rule,resume],lookup));
  }finally{await f.cleanup();}
});

test('DC2: writes-only plan set, equal ruling nodes and carries limited to amended nodes',async()=>{
  const f=await fixture();
  try {await f.slot('a');await f.slot('b');const base=await ops.readState(f);const r=await ops.decide({...f.options,as:owner,channel:'delegated',writes:['+x']});const ledger=await Ledger.open(f.cwd),plans=new Map<string,import('../src/types.ts').Plan>();for(const e of [...base.entries,...r.entries])if(e.kind==='plan'||e.kind==='genesis')plans.set(e.plan,importPlan((await ledger.getBlob(e.plan)).toString()));const lookup=(sha:string)=>plans.get(sha)!;
    const drafts=r.entries.map(({seq,ts,prev,hash,...d})=>d);
    const outside=drafts.map(d=>d.kind==='rule'?{...d,nodes:['a','b']}:d);assert.throws(()=>replayDrafts(base,outside,lookup),/equal/);
    const outsideCarry=drafts.map(d=>d.kind==='submit'?{...d,node:'b'}:d);assert.throws(()=>replayDrafts(base,outsideCarry,lookup),/decided|carry/);
    const changed=structuredClone(r.plan!.kind==='plan'?plans.get(r.plan!.plan)!:base.state.plan);changed.nodes[0]!.title='not writes';const sha=await ledger.putBlob(JSON.stringify(changed));plans.set(sha,changed);const nonWrites=drafts.map(d=>d.kind==='plan'?{...d,plan:sha}:d);assert.throws(()=>replayDrafts(base,nonWrites,lookup),/writes-only/);
    assert.doesNotThrow(()=>replayDrafts(base,drafts,lookup));
  }finally{await f.cleanup();}
});
import { parsePlan as importPlan } from '../src/plan.ts';

test('DC2: legal decision prefixes replay; foreign continuation and actual truncated tails refuse',async()=>{
  for (const writes of [false,true]) {
    const f=await fixture();
    try {
      await f.slot();
      const base=await ops.readState(f),r=await ops.decide({...f.options,as:owner,channel:'delegated',defer:'unit',...(writes?{writes:['+x']}:{} )});
      const ledger=await Ledger.open(f.cwd),plans=new Map<string,import('../src/types.ts').Plan>();
      for(const e of [...base.entries,...r.entries]) if(e.kind==='genesis'||e.kind==='plan')plans.set(e.plan,importPlan((await ledger.getBlob(e.plan)).toString()));
      const lookup=(sha:string)=>plans.get(sha)!;
      for(const e of r.entries.filter(e=>e.kind==='plan'||e.kind==='defer')) {
        const prefix=[...base.entries,...r.entries.filter(x=>x.seq<=e.seq)];
        const state=reduce(prefix,lookup);
        assert.equal(state.seq,e.seq);
        assert.match(decisionTailErrors(state).join(';'),new RegExp(`decision #${r.decision}.*interrupted atomic write`));
        const foreign={kind:'note',by:'parent:other',text:'foreign',seq:e.seq+1,ts:new Date().toISOString(),prev:e.hash} as Entry;foreign.hash=entryHash(foreign);
        assert.throws(()=>extendState(reduce(prefix,lookup),[foreign]),/incomplete/);
        assert.equal(extendState(state,r.entries.filter(x=>x.seq>e.seq)).seq,r.entries.at(-1)!.seq);
        const report=await ops.report({cwd:f.cwd,since:e.seq});assert.ok(report);
        await writeFile(join(ledger.dir,'ledger.jsonl'),prefix.map(x=>JSON.stringify(x)+'\n').join(''));
        await rm(join(ledger.dir,'snapshot'),{recursive:true,force:true});ops.forgetReplays();
        // DF1: unlocked readers see the state before the group (a write in flight); locked acts still refuse.
        assert.equal((await ops.readState(f)).state.seq,base.state.seq);
        await assert.rejects(ops.rule({cwd:f.cwd,as:parent,nodes:['a'],text:'after tail'}),new RegExp(`decision #${r.decision}.*interrupted atomic write`));
        const verified=await ops.verify(f);assert.equal(verified.ok,false);assert.match(verified.error!,new RegExp(`decision #${r.decision}.*interrupted atomic write`));
        await writeFile(join(ledger.dir,'ledger.jsonl'),[...base.entries,...r.entries].map(x=>JSON.stringify(x)+'\n').join(''));ops.forgetReplays();
      }
    } finally {await f.cleanup();}
  }
});

test('DC2: strict multi-answer fields, target scope, sort, exclusivity and historical revisions',async()=>{
  const f=await fixture();
  try {await f.slot('a');await f.slot('b');const a=await f.launch('a'),b=await f.launch('b');f.dsa.ask(a.rid);f.dsa.ask(b.rid);const base=await ops.readState(f),r=await ops.decide({...f.options,nodes:['a','b']}),lookup=()=>base.state.plan;const {seq,ts,prev,hash,...rule}=r.rule;
    for(const altered of [{...rule,answer:{rid:a.rid,qid:'q1',rev:1}},{...rule,answers:[...rule.answers!].reverse()},{...rule,answers:rule.answers!.map(a=>({...a,extra:1}))},{...rule,answers:rule.answers!.map(a=>({...a,rev:0}))},{...rule,answers:rule.answers!.map(a=>({...a,node:'fix'}))},{...rule,answers:[rule.answers![0]!]},{...rule,answers:rule.answers!.map(a=>({...a,rid:'unknown'}))}])assert.throws(()=>replayDrafts(base,[altered],lookup));
    f.dsa.ask(a.rid,'q1',2);f.dsa.ask(b.rid,'q1',2);const again=await ops.decide({...f.options,nodes:['a','b']});assert.ok(again.rule.seq>r.rule.seq);assert.equal((await ops.verify(f)).ok,true);
  }finally{await f.cleanup();}
});

test('DC3/DC4: tool schema and execution, Needs-you command, asking notices and quiet durable answers',async()=>{
  const f=await fixture();
  try {await f.slot();await f.halt();const tools=new Map<string,ToolDefinition>();owed({registerTool(t:ToolDefinition){tools.set(t.name,t);},registerCommand(){},on(){}} as unknown as ExtensionAPI);const tool=tools.get('owed_decide');assert.ok(tool);assert.ok('nodes' in (tool.parameters as {properties:object}).properties);
    const status=await ops.status(f);assert.match(renderStatus(status),/a: driver halted: check failed; after resume the driver continues from the current state → owed resume a/);assert.doesNotMatch(renderStatus(status),/owed decide a --text/);
    const result=await tool.execute('test',{nodes:['a'],text:'Keep the interface',cwd:f.cwd},undefined,undefined,{cwd:f.cwd,hasUI:false} as Parameters<ToolDefinition['execute']>[4]);assert.equal(result.isError,undefined);assert.equal(result.content.length,1);assert.ok(result.content[0]?.type==='text');assert.match(result.content[0].text,/^decision #/);assert.equal(result.content[0].text.split('\n').length,1);
    const l=await f.launch();f.dsa.ask(l.rid);assert.match(askingText('a',l,f.dsa.views.get(l.rid)!),/owed decide a --text/);
    await ops.decide(f.options);const s=(await ops.readState(f)).state;assert.ok(answeredQuestion(s,l.rid,'q1',1));const actions=driveDecide(s,s.plan,f.dsa.views,{max:1,repairs:2,project:projectId(s),root:f.cwd,applied:new Set(),rejected:new Map()});assert.ok(actions.some(a=>a.do==='notify'&&a.quiet));
    const denied=await cli(f.cwd,['decide','a','--text','decision','--resume','--no-resume']);assert.equal(denied.code,2);
    await ops.abandon({cwd:f.cwd,as:parent,node:'a',reason:'finish asking fixture'});
    const widened=await cli(f.cwd,['decide','a','--text','Only x and y','--writes','+x','+y','--as','owner:pi','--json']);assert.equal(widened.code,0,widened.stderr);assert.deepEqual(JSON.parse(widened.stdout).added,['x','y']);
  }finally{await f.cleanup();}
});
