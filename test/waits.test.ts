// FL1-FL5 (0.13): behavioral regressions; namespace imports keep the base's red failure an assertion.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as policy from '../src/drive.ts';
import * as reducer from '../src/reducer.ts';
import * as runtime from '../src/drive-run.ts';
import * as plans from '../src/plan.ts';
import * as views from '../src/views.ts';
import { Dsa, toRunView } from '../src/dsa.ts';
import { Follower } from '../src/drive-bg.ts';
import { sha256 } from '../src/canon.ts';
import { Ledger } from '../src/ledger.ts';
import * as ops from '../src/ops.ts';
import owed from '../src/extension.ts';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Draft, Entry, NodeSpec, Plan, RunView } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const spec = (id: string): NodeSpec => ({ id, deps: [], writes: [`${id}/`], checks: [], review: { count: 0, min_rank: 1 } });
const basePlan = (): Plan => ({ version: 1, trunk: 'main', closure: [], invariants: [], nodes: ['a','b','c'].map(spec) });
const W = reducer.runId('hash0','a',1,'writer');
function rig() {
  const entries: Entry[] = [], maps = new Map<string,Plan>([['p',basePlan()]]), blobs = new Map<string,string>();
  const state = () => reducer.reduce(entries,s => maps.get(s)!);
  const add = (d: Draft) => { const seq = entries.length, e = { ...d, seq, ts:new Date(1_760_000_000_000 + seq * 1000).toISOString(), hash:`hash${seq}`, prev:'x' } as Entry; entries.push(e); state(); return e; };
  const blob = (v: string) => { const h = sha256(v); blobs.set(h,v); return h; };
  add({ kind:'genesis', by:'owner:pi', channel:'delegated', plan:'p', trunk:'main', commit:'s0', state:{ commit:'s0', tree:'t0', invKeys:{} } });
  const dispatch = (node='a') => add({ kind:'dispatch', by:'parent:drive', node, attempt:1, base:state().trunk.commit, branch:`owed/${node}/1`, worktree:`/repo/${node}`, packet:'blob', rulings_seen:-1 });
  dispatch();
  const a = policy.writerLaunch(state(),'a','hash0');
  add({ kind:'launch', by:'parent:drive', node:'a', attempt:1, role:'writer', rid:W, spec:blob(a.spec), labels:a.labels });
  const r = {
    entries, state, add, dispatch, blobs,
    plan(change: (p: Plan) => void) { const p = structuredClone(state().plan); change(p); const id = `p${entries.length}`; maps.set(id,p); return add({ kind:'plan',by:'parent:main',prior:state().planSha,plan:id,downgrades:[] }); },
    resume(o: Partial<Extract<Draft,{kind:'resume'}>> = {}) { return add({ kind:'resume',by:'parent:main',node:'a',attempt:1,...o }); },
    record(x: policy.Action) { assert.equal(x.do,'send'); if (x.do !== 'send') throw new Error('not send'); return add({ kind:'send',by:'parent:drive',node:x.node,attempt:x.attempt,rid:x.rid,send:`${x.rid}:${x.sendKind}:${entries.length}`,sendKind:x.sendKind,reason:x.reason,message:blob(x.message),...(x.rulings !== undefined ? {rulings:x.rulings} : {}) }); },
    submit(node='a') { const slot = state().nodes[node]!.slot!, tag=String(entries.length); return add({ kind:'submit',by:`writer:${node}#1`,node,attempt:1,facts:{ commit:`${node}${tag}`,tree:`t${tag}`,base:slot.base,patch:`p${tag}`,changed:[`${node}/x`],closureTouched:false,keys:{ writes:`w${tag}`,rulings:`r${tag}` } } }); },
    merge(node: string) { dispatch(node); r.submit(node); const n=state().nodes[node]!, c=n.candidate!; add({ kind:'obs',by:'executor:owed',subject:node,obligation:'writes',key:c.keys.writes!,verdict:'pass',exit:0,durationMs:1,commit:c.commit,base:c.base }); const commit=`merged-${node}`; return add({ kind:'merge',by:'executor:owed',node,attempt:1,prior:state().trunk.commit,commit,facts:{...c,commit,tree:`tm-${node}`},state:{commit,tree:`tm-${node}`,invKeys:{}} }); },
    act(v: Partial<RunView> = {}, extra: Partial<policy.DriveOpts> = {}) { const s=state(); return policy.decide(s,s.plan,new Map([[W,{rid:W,state:'sealed',status:'ok',...v}]]),{ max:4,repairs:2,project:'hash0',root:'/repo',applied:new Set(entries.flatMap(e=>e.kind==='send'?[e.send]:[])),rejected:new Map(),blobs,...extra }).find(a=>a.node==='a'); },
  };
  return r;
}

test('FL1: newly added dependencies suppress submit, repair, ruling and missing-candidate halts; questions remain visible', () => {
  const r=rig(); r.plan(p=>{ p.nodes[0]!.deps=['b','c']; });
  assert.equal(r.act(),undefined);
  r.add({kind:'rule',by:'parent:main',nodes:['a'],text:'retry',writer:true});
  assert.equal(r.act(),undefined);
  const ask=r.act({state:'asking',questions:[{qid:'q',rev:1,question:'which?'}]});
  assert.equal(ask?.do,'notify');
  assert.match(ask?.do==='notify'?ask.text:'',/asks/);
  assert.match(views.renderReceipt(views.receipt(r.state(),r.entries,'a')),/waiting \(deps: b, c\)/);
  assert.match(views.renderStatusFull(views.statusView(r.state(),r.entries)),/waiting \(deps: b, c\)/);
});

test('FL1: running writer gets one notify per dependency-adding plan, with durable retry bytes', () => {
  const r=rig(), p=r.plan(p=>{p.nodes[0]!.deps=['b'];});
  const a=r.act({state:'running'}); assert.ok(a?.do==='send'); assert.equal(a.sendKind,'notify'); assert.match(a.message,/do not submit until told/); assert.match(a.message,new RegExp(`plan #${p.seq}`));
  const e=r.record(a); assert.equal(r.act({state:'running'}),undefined);
  const retry=r.act({state:'running'},{applied:new Set()}); assert.ok(retry?.do==='send'); assert.equal(retry.send,(e as Extract<Entry,{kind:'send'}>).send); assert.equal(retry.message,a.message);
  r.plan(p=>{p.nodes[0]!.deps=['b','c'];}); assert.equal(r.act({state:'running'})?.do,'send');
});

test('FL1/FL2: implicit deps compose with list resume, then rebase and existing rebase follow-up', () => {
  const r=rig(); r.plan(p=>{p.nodes[0]!.deps=['b'];}); r.resume({after:['b','c']});
  r.merge('b'); assert.equal(r.act(),undefined,'explicit c still blocks');
  r.merge('c'); const a=r.act(); assert.deepEqual(a,{do:'rebase',node:'a'});
  const slot=r.state().nodes.a!.slot!; r.add({kind:'rebase',by:'parent:drive',node:'a',attempt:1,base:r.state().trunk.commit,from:slot.base});
  const next=r.act(); assert.ok(next?.do==='send'); assert.equal(next.reason,'rebase'); assert.match(next.message,/git rebase --onto/);
});

test('FL2: resume array validates, waits for every node, rejects self/unknown/empty and preserves single replay', () => {
  const r=rig(), d=(after: unknown)=>({kind:'resume',by:'parent:main',node:'a',attempt:1,after}) as Draft;
  assert.deepEqual(reducer.validateDraft(r.state(),d(['b','c'])),[]);
  for (const value of [[],['a'],['unknown'],[7]]) assert.ok(reducer.validateDraft(r.state(),d(value)).length);
  const e=r.resume({after:'b'}); assert.deepEqual(reducer.waitingFor(r.state(),'a'),{after:'b',resume:e.seq});
  r.resume({after:['b','c']}); r.merge('b'); assert.equal(reducer.waitingFor(r.state(),'a')?.after,'c'); r.merge('c'); assert.equal(reducer.waitingFor(r.state(),'a'),undefined);
});

test('FL3: report follow-up seals to a bounded notify, no new ledger entry; next parent act or submit releases it', () => {
  const r=rig(), e=r.resume({expect:'report',note:'diagnose'}), a=r.act();
  assert.ok(a?.do==='send'); assert.equal(a.reason,'report'); assert.match(a.message,/report your findings and stop; do not submit unless the parent asks/); r.record(a);
  const result=Array.from({length:60},(_,i)=>`line-${i} ${'x'.repeat(130)}`).join('\n');
  const notice=r.act({result}); assert.ok(notice?.do==='notify'); assert.equal(notice.reportedResume,e.seq); assert.ok(notice.text.split('\n').slice(1).join('\n').length<=4000); assert.ok(notice.text.split('\n').length<=41);
  const s=r.state(); s.nodes.a!.reported=e.seq; assert.equal(reducer.reportedOf(s,'a'),e.seq);
  assert.deepEqual(policy.decide(s,s.plan,new Map([[W,{rid:W,state:'sealed',status:'ok'}]]),{max:1,repairs:2,project:'hash0',root:'/repo',applied:new Set(),rejected:new Map()}).filter(a=>a.node==='a'),[]);
  r.add({kind:'rule',by:'parent:main',nodes:['a'],text:'continue'}); assert.equal(reducer.reportRequest(r.state(),'a'),undefined); assert.notEqual(r.act()?.do,'notify');
  const r2=rig(); r2.resume({expect:'report'}); r2.record(r2.act()!); r2.submit(); assert.equal(reducer.reportRequest(r2.state(),'a'),undefined); assert.equal(r2.act()?.do,'attest');
});

test('FL3/AN3 merge: report follow-up filters the writer answer without dropping earlier guidance or other-run answers', () => {
  const r=rig(), reviewer=reducer.runId('hash0','a',1,'reviewer',1);
  r.add({kind:'launch',by:'parent:drive',node:'a',attempt:1,role:'reviewer',rid:reviewer,spec:sha256('{}'),labels:reducer.runLabels('hash0','a',1,'reviewer')});
  const older=r.add({kind:'rule',by:'parent:main',nodes:['a'],text:'Earlier ordinary guidance'});
  r.add({kind:'rule',by:'parent:main',nodes:['a'],writer:false,text:'Answer to writer question q1: Writer-only answer',answer:{rid:W,qid:'q1',rev:1}});
  const other=r.add({kind:'rule',by:'parent:main',nodes:['a'],writer:false,text:'Answer to reviewer question q2: Reviewer guidance',answer:{rid:reviewer,qid:'q2',rev:1}});
  r.resume({expect:'report'});
  const action=r.act(); assert.ok(action?.do==='send'); assert.equal(action.reason,'report');
  assert.match(action.message,/Earlier ordinary guidance/); assert.match(action.message,/Reviewer guidance/);
  assert.doesNotMatch(action.message,/Writer-only answer/); assert.equal(action.rulings,other.seq);
  assert.ok(action.message.includes(`Ruling #${older.seq}`));
  r.record(action);
  const next=r.act({result:'findings'}); assert.ok(next?.do==='notify' && next.reportedResume !== undefined);
});

test('FL3: describe keeps final result; failing/rejected writer is not falsely reported', () => {
  assert.equal(toRunView('r',{state:'sealed',status:'done',result:'findings',calls:[]}).result,'findings');
  const r=rig(); r.resume({expect:'report'}); r.record(r.act()!); assert.equal(r.act({status:'failed',error:'boom'})?.do,'halt');
});

test('FL4: later is parsed, not ready/dispatched or keyed, and status/brief list backlog; removing later makes it ready', () => {
  const p=basePlan(); p.nodes[1]!.later=true; const parsed=plans.parsePlan(JSON.stringify(p)); assert.equal(parsed.nodes[1]!.later,true);
  const r=rig(); r.plan(p=>{p.nodes[1]!.later=true;}); assert.equal(r.state().nodes.b!.phase,'blocked'); assert.ok(!views.statusView(r.state()).ready.includes('b'));
  assert.match(views.renderStatusFull(views.statusView(r.state())),/Backlog \(later\): b/); assert.match(views.renderBrief(views.briefView(r.state(),r.entries)),/Backlog \(later\)/);
  const prev=basePlan(), next=structuredClone(prev); next.nodes[0]!.later=true; assert.equal(reducer.invalidates(prev,next,'a'),false);
  r.plan(p=>{delete p.nodes[1]!.later;}); assert.equal(r.state().nodes.b!.phase,'ready');
  assert.throws(()=>plans.parsePlan(JSON.stringify({...p,nodes:[{...p.nodes[0],later:'true'}]})),/later/);
});

test('FL4: idle text carries all counts; interval default/zero and repeated idle wakes remain deliverable', async () => {
  assert.equal(plans.idleRewakeMin(basePlan()),60); const p=basePlan(); p.drive={...plans.DRIVE_DEFAULTS,idle_rewake_min:0}; assert.equal(plans.idleRewakeMin(plans.parsePlan(JSON.stringify(p))),0);
  assert.equal(runtime.idleRewakeDue(3_600_000,0,60),true); assert.equal(runtime.idleRewakeDue(3_599_999,0,60),false); assert.equal(runtime.idleRewakeDue(9e9,0,0),false);
  const counts={ready:0,open:2,waiting:1,reported:1,later:3}, text=runtime.reportText({event:'idle-wait',counts}); assert.match(text,/0 ready, 2 open, 1 waiting, 1 reported, 3 later/);
  const dir=await mkdtemp(join(tmpdir(),'owed-fl4-')); try { const log=join(dir,'log'); await writeFile(log,''); const got:string[]=[]; const f=new Follower({log,repo:'/r',pid:process.pid,from:0,deliver:m=>{got.push(m);}}); for(let i=0;i<2;i++){await writeFile(log,JSON.stringify({event:'idle-wait',counts})+'\n',{flag:'a'});assert.ok(f.tick());} assert.equal(got.length,2); f.stop(); } finally {await rm(dir,{recursive:true,force:true});}
});

test('FL2/FL3/FL5: CLI/tool arrays and expect, invariant aliases and unknown valid ids, report runtime survives restart', {timeout:120_000}, async () => {
  const r=await repo(); try {
    await r.put('README','x'); await r.commit(); const p=basePlan(); p.invariants=[{id:'unit',run:'true',timeout_s:1,reads:['**']}];
    await ops.init({cwd:r.cwd,as:{role:'owner',id:'pi'},channel:'delegated',plan:JSON.stringify(p),measure:false});
    const slot=await ops.dispatch({cwd:r.cwd,as:{role:'parent',id:'main'},node:'a'});
    await commitAt(slot.worktree,{'a/x':'candidate'}); await ops.submit({cwd:slot.worktree,as:{role:'writer',id:'a#1'},node:'a'});
    const c=await cli(r.cwd,['resume','a','--after','b,c','--expect','report','--json']); assert.equal(c.code,0,c.stderr); const entry=JSON.parse(c.stdout); assert.deepEqual(entry.after,['b','c']); assert.equal(entry.expect,'report');
    const tools=new Map<string,ToolDefinition>(); owed({registerTool(t:ToolDefinition){tools.set(t.name,t);},registerCommand(){}} as unknown as ExtensionAPI);
    const ctx={cwd:r.cwd,hasUI:false,ui:{notify(){}}} as unknown as ExtensionContext;
    const call=async(name:string,args:Record<string,unknown>)=>tools.get(`owed_${name}`)!.execute('test',args,undefined,undefined,ctx as Parameters<ToolDefinition['execute']>[4]);
    const tool=await call('resume',{node:'a',after:['b','c'],expect:'report',as:'parent:main'}); assert.equal((tool as {isError?:boolean}).isError,undefined);
    assert.equal(plans.invariantId(p,'inv:unit'),'unit'); assert.throws(()=>plans.invariantId(p,'inv:missing'),/valid ids: unit \(inv:unit\)/);
    assert.equal((await ops.why({cwd:r.cwd,node:'inv:unit'})).items[0]!.obligation,'inv:unit'); assert.equal((await ops.why({cwd:r.cwd,node:'unit'})).items[0]!.obligation,'inv:unit');
    const bad=await cli(r.cwd,['why','inv:missing']); assert.equal(bad.code,1); assert.match(bad.stderr,/valid ids: unit/);
    const def=await cli(r.cwd,['defer','a','inv:unit','--reason','risk','--json']); assert.equal(def.code,0,def.stderr); assert.equal(JSON.parse(def.stdout).items[0].id,'unit');
    const toolDef=await call('defer',{node:'a',items:['inv:unit'],reason:'risk',as:'owner:pi'}); assert.equal((toolDef as {isError?:boolean}).isError,undefined);
    const last=(await (await Ledger.open(r.cwd)).read()).at(-1)!; assert.equal(last.kind,'defer'); if(last.kind==='defer') assert.equal(last.items[0]!.id,'unit');
    const badDef=await call('defer',{node:'a',items:['inv:missing'],reason:'risk',as:'owner:pi'}); assert.equal((badDef as {isError?:boolean}).isError,true); assert.match(JSON.stringify(badDef),/valid ids: unit/);
    await ops.resume({cwd:r.cwd,as:{role:'parent',id:'main'},node:'a',expect:'report'});
    class Fake extends Dsa { generation=0; messages:string[]=[]; sent=new Map<string,number>(); override async inspect(rid:string){return {view:{rid,state:'sealed' as const,status:'ok',result:'diagnostic findings'},gen:this.generation};} override async run(){return {outcome:'applied' as const,wid:'w',created:true,spec_digest:'s'};} override async send(id:string,_to:string,_kind:unknown,message:string|Uint8Array){let generation=this.sent.get(id); if(generation===undefined){this.messages.push(String(message));generation=++this.generation;this.sent.set(id,generation);}return {outcome:'applied' as const,generation,spec_digest:'s'};} override async request(){return {state:'applied' as const};} }
    const fake=new Fake(), lines:string[]=[]; const driver=new runtime.Driver({cwd:r.cwd,max:1,dsa:fake,json:true,once:true,log:l=>lines.push(l)});
    await driver.pass(); await driver.pass(); const ledger=await Ledger.open(r.cwd), n=(await ledger.read()).length; await driver.pass(); assert.equal((await ledger.read()).length,n,'report appends no ledger entries');
    assert.match(lines.join('\n'),/diagnostic findings/); const status=await ops.status({cwd:r.cwd}); assert.ok(status.reported?.some(x=>x.node==='a')); assert.match(views.renderReceipt(await ops.why({cwd:r.cwd,node:'a'})),/reported \(resume #/);
    const fresh=new runtime.Driver({cwd:r.cwd,max:1,dsa:fake,json:true,once:true,log:l=>lines.push(l)}); const pass=await fresh.pass(); assert.ok(pass.idle); assert.equal(pass.counts.reported,1); assert.equal(fake.messages.length,1);
    await ops.resume({cwd:r.cwd,as:{role:'parent',id:'main'},node:'a'}); assert.equal((await ops.status({cwd:r.cwd})).reported,undefined);
  } finally {await r.cleanup();}
});

test('FL3 review #1273: pending report freezes old accepted or unmeasured candidates; terminal and parent paths still work', () => {
  const accepted = () => {
    const r = rig(); r.submit(); const c = r.state().nodes.a!.candidate!;
    r.add({ kind:'obs', by:'executor:owed', subject:'a', obligation:'writes', key:c.keys.writes!, verdict:'pass', exit:0, durationMs:1, commit:c.commit, base:c.base });
    assert.equal(r.state().nodes.a!.accepted,true);
    r.resume({ expect:'report' }); r.record(r.act()!); return r;
  };
  const r = accepted();
  for (const state of ['queued','running'] as const) assert.equal(r.act({state}),undefined,`${state} report must not merge the old candidate`);
  const unmeasured = rig(); unmeasured.submit(); unmeasured.resume({expect:'report'}); unmeasured.record(unmeasured.act()!);
  assert.equal(unmeasured.act({state:'running'}),undefined,'no attest of the old candidate while report runs');
  assert.equal(r.act({state:'asking',questions:[{qid:'q',rev:1,question:'parent decision?'}]})?.do,'notify');
  const report = r.act({result:'findings'}); assert.ok(report?.do==='notify'); assert.ok(report.reportedResume !== undefined);
  assert.equal(r.act({status:'failed',error:'report failed'})?.do,'halt');
  const submitted = accepted(); submitted.submit(); assert.equal(submitted.act({state:'running'})?.do,'attest','new submit releases the report');
  const resumed = accepted(); resumed.resume(); assert.equal(resumed.act({state:'running'})?.do,'merge','parent resume restores the normal accepted route');
  const abandoned = accepted(); abandoned.add({kind:'abandon',by:'parent:main',node:'a',attempt:1,reason:'stop report'}); assert.equal(reducer.reportRequest(abandoned.state(),'a'),undefined);
});

test('FL3 review #1273: fake dsa report generation stays queued/running across passes without merge or slot close', {timeout:120_000}, async () => {
  const r = await repo(); let driver: runtime.Driver | undefined;
  try {
    await r.put('README','x'); await r.commit(); const p = basePlan(); p.nodes = [p.nodes[0]!];
    await ops.init({cwd:r.cwd,as:{role:'owner',id:'pi'},channel:'delegated',plan:JSON.stringify(p),measure:false});
    const slot = await ops.dispatch({cwd:r.cwd,as:{role:'parent',id:'main'},node:'a'});
    await commitAt(slot.worktree,{'a/x':'accepted candidate'});
    await ops.submit({cwd:slot.worktree,as:{role:'writer',id:'a#1'},node:'a'});
    await ops.attest({cwd:r.cwd,node:'a'}); assert.equal((await ops.status({cwd:r.cwd})).nodes.a!.accepted,true);
    const resume = await ops.resume({cwd:r.cwd,as:{role:'parent',id:'main'},node:'a',expect:'report'});
    class Pending extends Dsa {
      generation = 0; state: RunView['state'] = 'sealed'; sent = new Map<string,number>();
      override async inspect(rid:string) { return {view:{rid,state:this.state,status:'ok',result:'final report'},gen:this.generation}; }
      override async run() { return {outcome:'applied' as const,wid:'w',created:true,spec_digest:'s'}; }
      override async send(id:string) { let generation = this.sent.get(id); if(generation === undefined) { generation = 1; this.sent.set(id,generation); this.state = 'queued'; } return {outcome:'applied' as const,generation,spec_digest:'s'}; }
      override async request() { return {state:'applied' as const}; }
    }
    const fake = new Pending({bin:join(r.root,'no-dsa')}), logs:string[] = [];
    driver = new runtime.Driver({cwd:r.cwd,max:1,dsa:fake,json:true,once:true,log:l=>logs.push(l)});
    await driver.pass(); const sent = await driver.pass(); assert.ok(sent.actions.some(a=>a.do==='send' && a.reason==='report'));
    const ledger = await Ledger.open(r.cwd), count = (await ledger.read()).length;
    // Also exercise the stale sealed generation: the applied report has generation 1, describe still says 0.
    for (const [state, generation] of [['sealed',0],['queued',1],['running',1],['running',1],['running',1]] as const) {
      fake.state = state; fake.generation = generation; const pass = await driver.pass();
      assert.equal(pass.actions.some(a=>a.do==='merge' || a.do==='attest'),false,`${state} generation ${generation}: no old-candidate measurement`);
      assert.equal(driver.measuring.size,0); assert.equal(pass.idle,false,'pending report remains live');
      const status = await ops.status({cwd:r.cwd}); assert.equal(status.nodes.a!.slot!.open,true); assert.equal(status.nodes.a!.merged,undefined);
      assert.equal((await ledger.read()).length,count,'no merge, halt, rebase or extra send while pending');
    }
    fake.state = 'asking'; const ask = await driver.pass(); assert.ok(ask.actions.some(a=>a.do==='notify')); assert.equal(driver.measuring.size,0);
    fake.state = 'sealed'; const reported = await driver.pass(); assert.ok(reported.actions.some(a=>a.do==='notify')); assert.match(logs.join('\n'),/final report/);
    assert.deepEqual((await ops.status({cwd:r.cwd})).reported,[{node:'a',resume:resume.entry.seq}]);
    assert.equal((await ledger.read()).length,count); assert.equal((await ops.status({cwd:r.cwd})).nodes.a!.slot!.open,true);
  } finally {
    if(driver) { driver.stopping = true; driver.abort.abort(); await driver.settle(); }
    await r.cleanup();
  }
});

test('FL1 review nit: implicit-only wait names dependency merges, explicit and composed wait text stays accurate', () => {
  const r = rig(); r.plan(p=>{p.nodes[0]!.deps=['b','c'];});
  const text = views.renderReceipt(views.receipt(r.state(),r.entries,'a'));
  assert.ok(!text.includes('when  merges'),text); assert.match(text,/the driver acts again when b, c merge/);
  r.resume({after:'b'}); assert.match(views.renderReceipt(views.receipt(r.state(),r.entries,'a')),/when b, c merge/);
  const explicit = rig(); explicit.resume({after:'b'}); assert.match(views.renderReceipt(views.receipt(explicit.state(),explicit.entries,'a')),/when b merges or after another resume/);
});

test('FL3: changing the node or abandoning releases the receipt, unrelated plans do not; report preserves rebase instruction', () => {
  const r=rig(), e=r.resume({expect:'report'}); r.record(r.act()!);
  r.plan(p=>{p.nodes[1]!.brief='unrelated';}); assert.equal(reducer.reportRequest(r.state(),'a')?.resume,e.seq);
  r.plan(p=>{p.nodes[0]!.brief='continue';}); assert.equal(reducer.reportRequest(r.state(),'a'),undefined);
  const r2=rig(); r2.resume({expect:'report'}); r2.record(r2.act()!); r2.add({kind:'abandon',by:'parent:main',node:'a',attempt:1,reason:'stop'}); assert.equal(reducer.reportRequest(r2.state(),'a'),undefined);
  const r3=rig(); r3.plan(p=>{p.nodes[0]!.deps=['b'];}); r3.resume({expect:'report'}); r3.merge('b'); const slot=r3.state().nodes.a!.slot!; r3.add({kind:'rebase',by:'parent:drive',node:'a',attempt:1,base:r3.state().trunk.commit,from:slot.base}); const a=r3.act(); assert.ok(a?.do==='send'); assert.equal(a.reason,'report'); assert.match(a.message,/git rebase --onto/); assert.ok(!a.message.includes('then `owed submit'));
});

test('FL2/FL3 integration: owed edit --resume validates atomically, normalizes lists and replays report expectations', {timeout:120_000}, async () => {
  const r = await repo();
  try {
    await r.put('README','x'); await r.commit();
    const p = basePlan(), file = join(r.root,'plan.yaml'), text = JSON.stringify(p);
    await writeFile(file,text);
    await ops.init({cwd:r.cwd,as:{role:'owner',id:'pi'},channel:'delegated',plan:text,measure:false});
    await ops.planSet({cwd:r.cwd,as:{role:'parent',id:'main'},...await ops.readPlan({cwd:r.cwd,path:file})});
    await ops.dispatch({cwd:r.cwd,as:{role:'parent',id:'main'},node:'a'});
    const ledger = await Ledger.open(r.cwd), count = (await ledger.read()).length;
    const edit = ['edit','a','--set','title=Report after deps','--resume','--note','wait and diagnose'];
    for (const [option, value, error] of [
      ['--after','a',/node itself/],
      ['--after','missing',/unknown node/],
      ['--after','b,',/unknown node/],
      ['--expect','candidate',/expect must be report/],
    ] as const) {
      const result = await cli(r.cwd,[...edit,option,value,'--json']);
      assert.equal(result.code,option === '--expect' ? 2 : 1,result.stdout); assert.match(result.stderr + result.stdout,error);
      assert.equal((await ledger.read()).length,count,'invalid resume appends no plan or resume');
      assert.equal(await readFile(file,'utf8'),text,'invalid resume does not edit the plan file');
    }
    await assert.rejects(ops.edit({cwd:r.cwd,as:{role:'parent',id:'main'},node:'a',set:['title=Invalid'],resume:true,after:[],note:'invalid list'}),/non-empty/);
    assert.equal((await ledger.read()).length,count); assert.equal(await readFile(file,'utf8'),text);
    const result = await cli(r.cwd,[...edit,'--after',' b, c,b ','--expect','report','--json']);
    assert.equal(result.code,0,result.stderr);
    const recorded = JSON.parse(result.stdout) as ops.EditResult;
    assert.ok(recorded.resume?.kind === 'resume');
    assert.deepEqual(recorded.resume.after,['b','c']); assert.equal(recorded.resume.expect,'report');
    const entries = await ledger.read(), lookup = new Map<string,Plan>();
    assert.deepEqual(entries.slice(count).map(e=>e.kind),['plan','resume'],'edit keeps its atomic entry order');
    for (const e of entries) if(e.kind === 'plan' || e.kind === 'genesis') lookup.set(e.plan,plans.parsePlan((await ledger.getBlob(e.plan)).toString()));
    const state = reducer.reduce(entries,sha=>lookup.get(sha)!);
    assert.deepEqual(reducer.resumeOf(state,'a')?.after,['b','c']); assert.equal(reducer.resumeOf(state,'a')?.expect,'report');
    assert.deepEqual(reducer.waitingFor(state,'a'),{after:'b, c',resume:recorded.resume.seq});
    assert.equal(state.plan.nodes[0]!.title,'Report after deps');
    assert.deepEqual((await ops.status({cwd:r.cwd})).waiting,[{node:'a',after:'b, c',resume:recorded.resume.seq}]);
    assert.equal((await ops.verify({cwd:r.cwd})).ok,true,'edit resume survives full ledger replay');
  } finally { await r.cleanup(); }
});

test('FL2/FL3 compatibility: unknown resume shapes/fields produce version, and 0.12 single resume is unchanged', () => {
  const r=rig(), e={kind:'resume',by:'parent:main',node:'a',attempt:1,seq:r.entries.length,ts:new Date().toISOString(),hash:'x',prev:'x'};
  assert.equal(reducer.newerEntry({...e,after:['b','c'],expect:'report'} as Entry),undefined);
  for(const extra of [{expect:'candidate'},{after:{node:'b'}},{future:true}]) assert.equal(reducer.newerEntry({...e,...extra} as unknown as Entry)?.code,'version');
});
