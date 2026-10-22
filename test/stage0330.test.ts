// SG1–SG9: stages and acceptance use real ledgers and disposable git repositories.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import * as ops from '../src/ops.ts';
import { Dsa } from '../src/dsa.ts';
import { Ledger, entryHash, verifyChain } from '../src/ledger.ts';
import { sha256 } from '../src/canon.ts';
import { parsePlan } from '../src/plan.ts';
import { reduce, reduceFrom, extendState, packState, unpackState, sameReplay, entriesOf, projectId, runId, runLabels } from '../src/reducer.ts';
import { renderStatus, renderWhy } from '../src/views.ts';
import { validateArgv } from '../src/cli.ts';
import owed from '../src/extension.ts';
import type { Draft, Entry, RunView, StageBundle } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';
const parent = {role:'parent',id:'test'} as const, owner = {role:'owner',id:'pi'} as const;
class FakeDsa {
  views = new Map<string,RunView>();
  sends: string[] = [];
  fail = false;
  async describe(rid:string):Promise<RunView> {if(this.fail)throw new Error('describe unavailable');return this.views.get(rid) ?? {rid,state:'sealed',status:'ok'};}
  async send(_id:string,rid:string,_kind:string,_text:string | Uint8Array) {this.sends.push(rid);return {outcome:'applied' as const,spec_digest:'test'};}
  ask(rid:string,qid='q1',rev=1) {this.views.set(rid,{rid,state:'asking',questions:[{qid,rev,question:'Choose interface',options:[{label:'Keep',preferred:true},{label:'Change'}]}]});}
}
async function fixture() {
  const r = await repo(), dsa = new FakeDsa();
  const plan = JSON.stringify({version:1,trunk:'main',lease:false,closure:[],invariants:[],drive:{delegate:{on:['question'],a_acts:['preferred-answer','infra-resume'],appends:['notes.txt','other.txt']}},nodes:[{id:'a',writes:['a.txt'],checks:[],review:{count:1,min_rank:1}},{id:'b',writes:['b.txt'],checks:[]},{id:'c',writes:['c.txt'],checks:[]}]});
  await r.put('plan.json',plan);await r.put('notes.txt','existing\n');await r.put('other.txt','');await r.commit();
  await ops.init({cwd:r.cwd,as:owner,channel:'delegated',plan,path:'plan.json',measure:false});
  const actor = {cwd:r.cwd,as:parent,dsa};
  async function bundle(extra:Partial<StageBundle>={},node='a') {
    const b:StageBundle = {ruling_text:'Keep the scoped interface',read_through_seq:(await ops.readState(r)).state.seq,summary:'Keep interface\nExisting behavior is measured\nApply the scoped ruling',...extra};
    await r.put('bundle.json',JSON.stringify(b));
    const e = await ops.stage({...actor,as:{role:'writer',id:'fork'},node,file:'bundle.json'});return {id:`S${e.seq}`,entry:e,bundle:b};
  }
  async function patch(next:object, extra:Partial<StageBundle>={},node='a') {
    const current = await readFile(join(r.cwd,'plan.json'),'utf8'), text=JSON.stringify(next);
    await r.put('patched.json',text);
    return bundle({...extra,plan_patch:{file:'patched.json',before_sha256:sha256(current),after_sha256:sha256(text)}},node);
  }
  async function slot(node='a',submit=false) {
    const d=await ops.dispatch({cwd:r.cwd,as:parent,node});
    if(submit) {await commitAt(d.worktree,{[`${node}.txt`]:'candidate'});await ops.submit({cwd:d.worktree,as:{role:'writer',id:`${node}#1`},node});}
    return d;
  }
  async function launch(node='a') {
    const s=(await ops.readState(r)).state,p=projectId(s),rid=runId(p,node,1,'writer');
    await ops.launch({cwd:r.cwd,as:parent,node,attempt:1,role:'writer',rid,spec:'{}',labels:runLabels(p,node,1,'writer'),rulings:0});return rid;
  }
  return {...r,dsa,actor,plan,bundle,patch,slot,launch};
}
const ledgerBytes = async(cwd:string) => readFile(join((await Ledger.open(cwd)).dir,'ledger.jsonl'),'utf8');
async function record(cwd:string,d:Draft) {const l=await Ledger.open(cwd);return l.withLock(async()=> (await l.append([d]))[0]!);}
async function env<T>(extra:Record<string,string|undefined>,run:()=>Promise<T>) {
  const prior=Object.fromEntries(Object.keys(extra).map(k=>[k,process.env[k]]));
  for(const [k,v] of Object.entries(extra)) if(v===undefined)delete process.env[k];else process.env[k]=v;
  try{return await run();}finally{for(const [k,v] of Object.entries(prior))if(v===undefined)delete process.env[k];else process.env[k]=v;}
}

test('SG2: each malformed bundle refuses without recording',async t=>{
  const f=await fixture();
  try {
    const good={ruling_text:'Keep',summary:'Decision, basis and changes',read_through_seq:0};
    const invalid:Record<string,unknown>[]=[
      {unknown:true},{ruling_text:undefined},{ruling_text:2},{ruling_text:'x'.repeat(8001)},
      {summary:undefined},{summary:2},{summary:'x'.repeat(161)},{summary:Array(11).fill('line').join('\n')},
      {read_through_seq:undefined},{read_through_seq:-1},{read_through_seq:0.5},{read_through_seq:99},
      {class:'D'},{touches:'a'},{touches:[1]},{touches:['../outside']},{touches:['/absolute']},
      {decide:[]},{decide:{nodes:['a'],defer:'unit'}},{decide:{nodes:'a'}},{decide:{nodes:['missing']}},
      {decide:{nodes:['a'],resume:'yes'}},{decide:{nodes:['a'],writer:1}},{decide:{nodes:['a'],expect:'candidate'}},
      {decide:{nodes:['a'],writes:[]}},{decide:{nodes:['a'],allow_only:'a'}},{decide:{nodes:['a'],after:[1]}},
      {decide:{nodes:['a'],resume:false,expect:'report'}},{decide:{nodes:['a'],remeasure:'yes'}},
      {plan_patch:[]},{plan_patch:{file:'patched.json',before_sha256:'bad',after_sha256:'bad'}},
      {appends:{}},{appends:[{path:'unlisted.txt',text:'text'}]},{appends:[{path:'notes.txt',text:'x'.repeat(4001)}]},
      {appends:[{path:'notes.txt',text:'text',unknown:1}]},{evidence:{}},{evidence:[{path:'notes.txt',sha256:'bad'}]},
      {evidence:[{path:'notes.txt',sha256:'0'.repeat(64)}]},{evidence:[{path:'notes.txt',sha256:sha256('existing\n'),extra:true}]},
    ];
    for(const [i,part] of invalid.entries())await t.test(`field refusal ${i+1}`,async()=>{
      await f.put('bad.json',JSON.stringify({...good,...part}));const before=await ledgerBytes(f.cwd);
      await assert.rejects(ops.stage({...f.actor,node:'a',file:'bad.json'}));assert.equal(await ledgerBytes(f.cwd),before);
    });
    for(const bytes of ['{','[]','null']) {await f.put('bad.json',bytes);const before=await ledgerBytes(f.cwd);await assert.rejects(ops.stage({...f.actor,node:'a',file:'bad.json'}));assert.equal(await ledgerBytes(f.cwd),before);}
    await f.put('bundle.json',JSON.stringify(good));await assert.rejects(ops.stage({...f.actor,node:'missing',file:'bundle.json'}),/does not exist/);
  }finally{await f.cleanup();}
});

test('SG2: plan hash, parse and evidence validation; bundle and patched bytes are immutable blobs',async()=>{
  const f=await fixture();try{
    const next={...JSON.parse(f.plan),nodes:JSON.parse(f.plan).nodes.map((n:{id:string})=>n.id==='a'?{...n,title:'Scoped'}:n)};
    const patched=JSON.stringify(next);await f.put('patched.json',patched);
    const base={ruling_text:'Keep',summary:'Keep scope',read_through_seq:0,plan_patch:{file:'patched.json',before_sha256:sha256(f.plan),after_sha256:sha256(patched)}};
    for(const part of [{before_sha256:'0'.repeat(64)},{after_sha256:'0'.repeat(64)}]){await f.put('bad.json',JSON.stringify({...base,plan_patch:{...base.plan_patch,...part}}));const before=await ledgerBytes(f.cwd);await assert.rejects(ops.stage({...f.actor,node:'a',file:'bad.json'}),/mismatch/);assert.equal(await ledgerBytes(f.cwd),before);}
    await f.put('patched.json','{}');await f.put('bad.json',JSON.stringify({...base,plan_patch:{...base.plan_patch,after_sha256:sha256('{}')}}));await assert.rejects(ops.stage({...f.actor,node:'a',file:'bad.json'}));
    const staged=await f.patch(next,{evidence:[{path:'notes.txt',sha256:sha256('existing\n')}]});
    const l=await Ledger.open(f.cwd);assert.equal((await l.getBlob(staged.entry.bundle)).toString(),JSON.stringify(staged.bundle));assert.equal((await l.getBlob(staged.entry.patched_plan!)).toString(),patched);
    await f.put('patched.json','not a plan');await f.put('bundle.json','not json');
    await ops.accept({...f.actor,id:staged.id});assert.equal(await readFile(join(f.cwd,'plan.json'),'utf8'),patched);
  }finally{await f.cleanup();}
});

test('SG2: allowed append symlinks cannot escape the repository',async()=>{
  const f=await fixture();try{await writeFile(join(f.root,'outside.txt'),'safe');await symlink(join(f.root,'outside.txt'),join(f.cwd,'link.txt'));const s=(await ops.readState(f)).state;await ops.planSet({cwd:f.cwd,as:owner,channel:'delegated',plan:JSON.stringify({...s.plan,drive:{...s.plan.drive,delegate:{...s.plan.drive!.delegate,appends:['link.txt']}}}),note:'append fixture'});await assert.rejects(f.bundle({appends:[{path:'link.txt',text:'escape'}]}),/escapes repository/);}finally{await f.cleanup();}
});

test('SG3: every semantic kind stales a stage; bookkeeping and other nodes do not',async()=>{
  const {stageLedgerReason,CHANGING_KINDS}=await import('../src/stage.ts');
  const f=await fixture();try{
    const staged=await f.bundle({touches:['b','src/module']});const state=(await ops.readState(f)).state;
    for(const kind of CHANGING_KINDS){const d={kind,seq:staged.entry.seq+1,by:'parent:test',node:'b',nodes:['b']} as unknown as Entry;assert.equal(stageLedgerReason(staged.entry,[d],state.plan,state.plan),`${d.seq}/${kind}`,kind);}
    const measured={kind:'obs',seq:10,by:'executor:owed',subject:'b'} as Entry;assert.equal(stageLedgerReason(staged.entry,[measured],state.plan,state.plan),'10/obs');
    for(const kind of ['note','stage','accept','reject','overturn','send','sweep','refresh','decoy-commit','decoy-reveal'])assert.equal(stageLedgerReason(staged.entry,[{kind,seq:10,node:'b'} as Entry],state.plan,state.plan),undefined,kind);
    assert.equal(stageLedgerReason(staged.entry,[{...measured,probe:'trunk'} as Entry],state.plan,state.plan),undefined);
    assert.equal(stageLedgerReason(staged.entry,[{kind:'rule',seq:10,nodes:['c']} as Entry],state.plan,state.plan),undefined);
    await ops.rule({cwd:f.cwd,as:parent,nodes:['b'],text:'New fact',dsa:f.dsa});
    await assert.rejects(ops.accept({...f.actor,id:staged.id}),new RegExp(`stage ${staged.id} is stale: \\d+/rule — fork again`));
    assert.equal((await ops.stages(f.actor))[0]!.state,'stale');
  }finally{await f.cleanup();}
});

test('SG3: canonical node changes and plan-byte drift stale; unrelated plan changes leave stage open',async()=>{
  const f=await fixture();try{
    const first=await f.bundle(), plan=JSON.parse(f.plan);plan.nodes[1].title='Other node';
    await ops.planSet({cwd:f.cwd,as:parent,plan:JSON.stringify(plan)});assert.equal((await ops.stages(f.actor))[0]!.state,'open');
    plan.nodes[0].title='This node';await ops.planSet({cwd:f.cwd,as:parent,plan:JSON.stringify(plan)});
    const stale=(await ops.stages(f.actor))[0]!;assert.equal(stale.state,'stale');assert.match(stale.reason!,/\/plan$/);await assert.rejects(ops.accept({...f.actor,id:first.id}),/stale/);
    await f.put('plan.json',JSON.stringify(plan));const patch=await f.patch({...plan,setup:'true'});await f.put('plan.json',`${JSON.stringify(plan)}\n`);
    await assert.rejects(ops.accept({...f.actor,id:patch.id}),/plan hash changed/);
  }finally{await f.cleanup();}
});

test('SG3: runtime question revisions stale; unavailable describe is retryable and records nothing',async()=>{
  const f=await fixture();try{
    await f.slot();const rid=await f.launch();f.dsa.ask(rid);const staged=await f.bundle();
    f.dsa.fail=true;const before=await ledgerBytes(f.cwd);await assert.rejects(ops.accept({...f.actor,id:staged.id}),/cannot verify open questions: describe unavailable; retry/);assert.equal(await ledgerBytes(f.cwd),before);
    f.dsa.fail=false;f.dsa.ask(rid,'q1',2);await assert.rejects(ops.accept({...f.actor,id:staged.id}),/question changed \(qid q1\)/);assert.equal(await ledgerBytes(f.cwd),before);
  }finally{await f.cleanup();}
});

test('SG4: overlap on nodes and path prefixes refuses newer stage until older rejected',async()=>{
  const f=await fixture();try{
    const older=await f.bundle({touches:['src/module']}),newer=await f.bundle({touches:['src/module/file.ts']},'b');const before=await ledgerBytes(f.cwd);
    await assert.rejects(ops.accept({...f.actor,id:newer.id}),new RegExp(`accept ${older.id} first or reject it`));assert.equal(await ledgerBytes(f.cwd),before);
    await ops.reject({...f.actor,id:older.id,note:'Prefer second decision'});await ops.accept({...f.actor,id:newer.id});
    const same=await f.bundle(),same2=await f.bundle();await assert.rejects(ops.accept({...f.actor,id:same2.id}),new RegExp(`accept ${same.id} first`));
  }finally{await f.cleanup();}
});

test('SG4: plan + decide + accept + appends apply in order with amended ruling and sequence token',async t=>{
  const f=await fixture();try{
    await f.slot();await ops.halt({cwd:f.cwd,as:parent,node:'a',attempt:1,reason:'needs a ruling',needs:'human'});
    const plan=JSON.parse(f.plan);plan.nodes[0].title='Scoped';
    const staged=await f.patch(plan,{decide:{nodes:['a'],resume:true},appends:[{path:'notes.txt',text:'Decision #{ruling}'}]});
    const append=Ledger.prototype.append,seen:Draft[][]=[];
    t.mock.method(Ledger.prototype,'append',async function(this:Ledger,drafts:Draft[]){seen.push(drafts);return append.call(this,drafts);});
    const result=await ops.accept({...f.actor,id:staged.id,amend:'Amended scope'});
    assert.deepEqual(seen.map(ds=>ds.map(d=>d.kind)),[['plan','rule','resume','accept']]);
    assert.match(ops.acceptText(result),new RegExp(`^accepted ${staged.id}: ruling #${result.ruling}`));
    const state=await ops.readState(f),rule=state.entries.find(e=>e.seq===result.ruling);assert.equal(rule?.kind,'rule');assert.ok(rule?.kind==='rule');assert.equal(rule.text,`Amended scope [stage ${staged.id}]`);
    assert.equal(state.state.nodes.a!.halt,undefined);assert.equal(state.state.plan.nodes[0]!.title,'Scoped');
    const p=state.entries.find(e=>e.seq===result.plan);assert.ok(p?.kind==='plan');assert.equal(p.note,`accept ${staged.id}`);
    assert.equal(await readFile(join(f.cwd,'notes.txt'),'utf8'),`existing\n<!-- owed ${staged.id} -->\nDecision #${result.ruling}\n`);
    assert.equal((await ops.verify(f)).ok,true);
  }finally{t.mock.restoreAll();await f.cleanup();}
});

test('SG4: no-decide stage records one ordinary ruling even when a writer question is open',async()=>{
  const f=await fixture();try{await f.slot();const rid=await f.launch();f.dsa.ask(rid);const staged=await f.bundle();const result=await ops.accept({...f.actor,id:staged.id});const rule=(await ops.readState(f)).entries.find(e=>e.seq===result.ruling);assert.ok(rule?.kind==='rule');assert.equal(rule.answer,undefined);assert.equal(rule.text,`Keep the scoped interface [stage ${staged.id}]`);assert.equal((await ops.readState(f)).entries.filter(e=>e.seq>staged.entry.seq).map(e=>e.kind).join(','),'rule,accept');}finally{await f.cleanup();}
});

test('SG4: downgrade requires owner and uses accept stage id as delegated-owner reason',async()=>{
  const f=await fixture();try{const plan=JSON.parse(f.plan);plan.nodes[0].review.count=0;const staged=await f.patch(plan),before=await ledgerBytes(f.cwd);await assert.rejects(ops.accept({...f.actor,id:staged.id}),/Only owner/);assert.equal(await ledgerBytes(f.cwd),before);assert.equal(await readFile(join(f.cwd,'plan.json'),'utf8'),f.plan);const result=await ops.accept({...f.actor,as:owner,channel:'delegated',id:staged.id});const p=(await ops.readState(f)).entries.find(e=>e.seq===result.plan);assert.ok(p?.kind==='plan');assert.equal(p.note,`accept ${staged.id}`);assert.equal(p.channel,'delegated');}finally{await f.cleanup();}
});

test('SG4: decision writes compose with plan patch and invalid decision preserves ledger and file',async()=>{
  const f=await fixture();try{await ops.planSet({cwd:f.cwd,as:parent,...await ops.readPlan({cwd:f.cwd,path:'plan.json'})});const plan=JSON.parse(f.plan);plan.nodes[1].title='Other change';const invalid=await f.patch(plan,{decide:{nodes:['a'],resume:true,after:'missing'}}),before=await ledgerBytes(f.cwd);await assert.rejects(ops.accept({...f.actor,id:invalid.id}));assert.equal(await ledgerBytes(f.cwd),before);assert.equal(await readFile(join(f.cwd,'plan.json'),'utf8'),f.plan);await ops.reject({...f.actor,id:invalid.id,note:'Bad recovery target'});const staged=await f.patch(plan,{decide:{nodes:['a'],writes:['+extra.txt']}});await ops.accept({...f.actor,as:owner,channel:'delegated',id:staged.id});const s=(await ops.readState(f)).state;assert.deepEqual(s.plan.nodes[0]!.writes,['a.txt','extra.txt']);assert.equal(s.plan.nodes[1]!.title,'Other change');assert.deepEqual(parsePlan(await readFile(join(f.cwd,'plan.json'),'utf8')),parsePlan((await (await Ledger.open(f.cwd)).getBlob(s.planSha)).toString()));assert.equal((await ops.verify(f)).ok,true);}finally{await f.cleanup();}
});

test('SG4: crash after plan replacement leaves open stage; retry completes and append markers deduplicate',async t=>{
  const f=await fixture();try{
    const plan=JSON.parse(f.plan);plan.nodes[0].title='Patched';const staged=await f.patch(plan,{appends:[{path:'notes.txt',text:'#{ruling}'}]}),before=await ledgerBytes(f.cwd);
    t.mock.method(Ledger.prototype,'append',async()=>{throw new Error('crash before ledger append');});
    await assert.rejects(ops.accept({...f.actor,id:staged.id}),/crash before ledger append/);assert.equal(await ledgerBytes(f.cwd),before);assert.equal(await readFile(join(f.cwd,'plan.json'),'utf8'),JSON.stringify(plan));
    t.mock.restoreAll();const result=await ops.accept({...f.actor,id:staged.id});const accepted=await ledgerBytes(f.cwd),notes=await readFile(join(f.cwd,'notes.txt'),'utf8');await ops.accept({...f.actor,id:staged.id});assert.equal(await ledgerBytes(f.cwd),accepted);assert.equal(await readFile(join(f.cwd,'notes.txt'),'utf8'),notes);
    // Simulate a crash after the accept append, before its appends.
    await f.put('notes.txt','existing\n');await ops.accept({...f.actor,id:staged.id});assert.match(await readFile(join(f.cwd,'notes.txt'),'utf8'),new RegExp(`#${result.ruling}`));
  }finally{t.mock.restoreAll();await f.cleanup();}
});

test('SG4: all-b skips A/C and stale stages, processes in order and stops on first refusal',async()=>{
  const f=await fixture();try{
    const a=await f.bundle({class:'A'},'c'),first=await f.bundle({},'b');const plan=JSON.parse(f.plan);plan.nodes[0].review.count=0;const refused=await f.patch(plan),later=await f.bundle({class:'B',touches:['other-path']},'c');
    await assert.rejects(ops.acceptAllB(f.actor),/Only owner/);
    const views=await ops.stages({...f.actor,all:true});assert.equal(views.find(s=>s.id===first.id)!.state,'accepted');for(const id of [a.id,refused.id,later.id])assert.equal(views.find(s=>s.id===id)!.state,'open');
  }finally{await f.cleanup();}
});

test('SG5: reject, CLI listing, status, why and tools expose actionable stages',async()=>{
  const f=await fixture();try{
    const first=await f.bundle(),second=await f.bundle({},'b');await ops.reject({...f.actor,id:second.id,note:'Already resolved'});
    assert.equal((await ops.stages(f.actor)).length,1);assert.equal((await ops.stages({...f.actor,all:true})).length,2);
    assert.match(renderStatus(await ops.status(f)),/Stages: 1 open \(0 stale\) → owed stages/);assert.match(renderWhy(await ops.why({...f,node:'a'})),new RegExp(`${first.id}.*owed accept ${first.id}`));
    const listing=await cli(f.cwd,['stages','--all','--json']);assert.equal(listing.code,0,listing.stderr);assert.equal(JSON.parse(listing.stdout).length,2);
    const tools=new Map<string,ToolDefinition>();owed({registerTool(t:ToolDefinition){tools.set(t.name,t);},registerCommand(){}} as unknown as ExtensionAPI);
    for(const name of ['stage','accept','reject','stages','overturn'])assert.ok(tools.has(`owed_${name}`));
    const ctx={cwd:f.cwd,hasUI:false,ui:{notify(){}}} as unknown as ExtensionContext;
    const call=async(name:string,args:object)=>tools.get(`owed_${name}`)!.execute('stage-test',args,undefined,undefined,ctx as Parameters<ToolDefinition['execute']>[4]);
    const out=await call('stages',{all:true});assert.notEqual(out.isError,true);assert.match(JSON.stringify(out),new RegExp(first.id));
    const accepted=await call('accept',{stage:first.id,amend:'Tool decision'});assert.notEqual(accepted.isError,true,JSON.stringify(accepted));assert.match(JSON.stringify(accepted),/accepted S/);
    await assert.rejects(ops.accept({...f.actor,id:second.id}),/rejected/);await assert.rejects(ops.reject({...f.actor,id:first.id,note:'late'}),/closed/);
  }finally{await f.cleanup();}
});

test('SG6/SG7: fork describes once; preferred writer option only, cross-node and other parent acts refused',async t=>{
  const f=await fixture();try{
    await f.slot();const rid=await f.launch();f.dsa.ask(rid);let describes=0;const describe=Dsa.prototype.describe;
    t.mock.method(Dsa.prototype,'describe',async function(this:Dsa,key:string){if(key==='fork-preferred'){describes++;return {rid:key,state:'running',labels:{owed_fork:'a'}} as RunView;}return f.dsa.describe(key);});
    await env({DSA_CALL:'fork-preferred'},async()=>{
      const a=await ops.answer({...f.actor,node:'a',text:'option 1; preserve behavior'});assert.equal(a.entry.by,'owner:pi');assert.equal(a.entry.via,'fork:fork-preferred');assert.equal(a.entry.writer,false);
      await assert.rejects(ops.answer({...f.actor,node:'b',text:'option 1'}),/owed stage/);
      await assert.rejects(ops.decide({...f.actor,nodes:['a'],text:'option 2'}),/preferred/);
      await assert.rejects(ops.decide({...f.actor,nodes:['a'],text:'option 1',writes:['+other']}),/owed stage/);
      await assert.rejects(ops.accept({...f.actor,id:'S0'}),/owed stage/);await assert.rejects(ops.reject({...f.actor,id:'S0',note:'No'}),/owed stage/);
      assert.equal((await f.bundle({},'b')).entry.node,'b');
    });
    assert.equal(describes,1);t.mock.restoreAll();assert.equal((await ops.verify(f)).ok,true);void describe;
  }finally{t.mock.restoreAll();await f.cleanup();}
});

test('SG6: CLI and pi permit fork stage and enabled A act, refuse ordinary parent/owner acts',async()=>{
  const f=await fixture();try{
    const fake=join(f.root,'describe.mjs');await writeFile(fake,`#!/usr/bin/env node\nconst a=process.argv.slice(2);if(a[0]==='describe')console.log(JSON.stringify({rid:a[a.indexOf('--key')+1],state:'running',labels:{owed_fork:'a'}}));else process.exit(1);\n`,{mode:0o755});
    const tools=new Map<string,ToolDefinition>();owed({registerTool(t:ToolDefinition){tools.set(t.name,t);},registerCommand(){}} as unknown as ExtensionAPI);
    const ctx={cwd:f.cwd,hasUI:false,ui:{notify(){}}} as unknown as ExtensionContext;
    await f.put('bundle.json',JSON.stringify({ruling_text:'CLI fork',summary:'Prepared fork decision',read_through_seq:0}));
    await env({DSA_CALL:'fork-surfaces',OWED_DSA:fake},async()=>{
      const staged=await cli(f.cwd,['stage','b','--file','bundle.json']);assert.equal(staged.code,0,staged.stderr);
      const refused=await cli(f.cwd,['rule','Broad decision','--nodes','a']);assert.equal(refused.code,1);assert.match(refused.stderr,/owed stage/);
      const out=await tools.get('owed_stage')!.execute('fork-stage',{node:'c',file:'bundle.json'},undefined,undefined,ctx as Parameters<ToolDefinition['execute']>[4]);assert.notEqual(out.isError,true,JSON.stringify(out));
      const stages=(await ops.readState(f)).entries.filter(e=>e.kind==='stage');
      assert.equal(stages.length,2);assert.equal(stages[0]!.by,'writer:fork-surfaces');
    });
    // A dsa call that is not a fork keeps D25.3's exact wording.
    await env({DSA_CALL:'plain-call',OWED_DSA:join(f.root,'missing-dsa.mjs')},async()=>{
      const refused=await cli(f.cwd,['rule','Broad decision','--nodes','a']);assert.equal(refused.code,1);assert.match(refused.stderr,/this process is a subagent call \(DSA_CALL\)/);
      assert.doesNotMatch(refused.stderr,/use owed stage/);
    });
  }finally{await f.cleanup();}
});

test('SG7: overturn disables preferred-answer until a later plan explicitly re-lists it',async t=>{
  const f=await fixture();try{
    await f.slot();const rid=await f.launch();f.dsa.ask(rid);
    t.mock.method(Dsa.prototype,'describe',async(key:string)=>key==='fork-overturn'?{rid:key,state:'running',labels:{owed_fork:'a'}} as RunView:f.dsa.describe(key));
    let seq=0;await env({DSA_EXEC:'fork-overturn'},async()=>{seq=(await ops.answer({...f.actor,node:'a',text:'option 1'})).entry.seq;});
    const over=await ops.overturn({...f.actor,seq,note:'This option was wrong'});assert.match(renderStatus(await ops.status(f)),new RegExp(`A act preferred-answer disabled by overturn #${over.seq}`));
    f.dsa.ask(rid,'q2',1);await env({DSA_EXEC:'fork-overturn'},async()=>{await assert.rejects(ops.answer({...f.actor,node:'a',text:'option 1'}),/not enabled/);});
    const plan=(await ops.readState(f)).state.plan;await ops.planSet({cwd:f.cwd,as:parent,plan:JSON.stringify(plan)});
    await env({DSA_EXEC:'fork-overturn'},async()=>{assert.equal((await ops.answer({...f.actor,node:'a',text:'option 1'})).entry.via,'fork:fork-overturn');});
    assert.equal((await ops.verify(f)).ok,true);
  }finally{t.mock.restoreAll();await f.cleanup();}
});

test('SG7: infra-resume requires enabled own-node infrastructure halt and complete measurements',async t=>{
  const f=await fixture();try{
    await f.slot('b',true);const s=(await ops.readState(f)).state,c=s.nodes.b!.candidate!;
    t.mock.method(Dsa.prototype,'describe',async(key:string)=>({rid:key,state:'running',labels:{owed_fork:'b'}} as RunView));
    await ops.halt({cwd:f.cwd,as:parent,node:'b',attempt:1,reason:'attest infrastructure error: unknown seal',needs:'human'});
    await env({DSA_CALL:'fork-infra'},async()=>{await assert.rejects(ops.resume({...f.actor,node:'b'}),/covering ledger measurements/);});
    await record(f.cwd,{kind:'obs',by:'executor:owed',subject:'b',obligation:'writes',key:c.keys.writes!,verdict:'pass',exit:0,durationMs:1,commit:c.commit,base:c.base});
    await env({DSA_CALL:'fork-infra'},async()=>{const resumed=await ops.resume({...f.actor,node:'b',note:'Measurements already recorded'});assert.equal(resumed.entry.by,'owner:pi');assert.ok(resumed.entry.kind==='resume');assert.equal(resumed.entry.via,'fork:fork-infra');});
    await ops.halt({cwd:f.cwd,as:parent,node:'b',attempt:1,reason:'check failed',needs:'human'});
    await env({DSA_CALL:'fork-infra'},async()=>{await assert.rejects(ops.resume({...f.actor,node:'b'}),/infrastructure halt/);});assert.equal((await ops.verify(f)).ok,true);
  }finally{t.mock.restoreAll();await f.cleanup();}
});

test('SG8: delegate schema rejects unknown keys and invalid enums, ranges, budget and paths',async()=>{
  const basic={version:1,trunk:'main',closure:[],nodes:[],invariants:[]};
  for(const delegate of [null,[],{unknown:true},{max:0},{max:17},{max:1.5},{on:['other']},{a_acts:['defer']},{budget:[]},{budget:{rounds:0}},{budget:{wall_s:'2'}},{budget:{extra:2}},{appends:['../outside']},{appends:['/absolute']},{appends:['a','a']}])assert.throws(()=>parsePlan(JSON.stringify({...basic,drive:{delegate}})));
  const p=parsePlan(JSON.stringify({...basic,drive:{delegate:{on:['question','infra-halt'],budget:{rounds:2,wall_s:60},a_acts:[],appends:['docs/notes.md']}}}));assert.equal(p.drive!.delegate!.max,4);assert.deepEqual(p.drive!.delegate!.budget,{rounds:2,wall_s:60});assert.equal('drive' in parsePlan(JSON.stringify(basic)),false);
  for(const args of [['stage','a','--file','bundle.json'],['accept','S1'],['accept','--all-b'],['stages','--all','--json'],['reject','S1','--note','No'],['overturn','2','--note','Wrong']])assert.doesNotThrow(()=>validateArgv(args));
  for(const args of [['stage','a'],['accept','S1','--all-b'],['accept','--all-b','--amend','No'],['reject','S1'],['overturn','bad','--note','Wrong']])assert.throws(()=>validateArgv(args));
});

test('SG1: old ledger bytes and replay stay identical, staging does not clear halt',async()=>{
  const f=await fixture();try{
    await f.slot();await ops.halt({cwd:f.cwd,as:parent,node:'a',attempt:1,reason:'waiting for parent',needs:'human'});
    const before=await ops.readState(f),bytes=await ledgerBytes(f.cwd),l=await Ledger.open(f.cwd),plans=new Map<string,ReturnType<typeof parsePlan>>();
    for(const e of before.entries)if(e.kind==='genesis'||e.kind==='plan')plans.set(e.plan,parsePlan((await l.getBlob(e.plan)).toString()));
    const lookup=(sha:string)=>plans.get(sha)!;const fresh=reduce(before.entries,lookup),roundtrip=unpackState(structuredClone(packState(fresh)),lookup);
    assert.ok(sameReplay(fresh,roundtrip));assert.equal(JSON.stringify(entriesOf(fresh)),JSON.stringify(before.entries));assert.equal(await ledgerBytes(f.cwd),bytes);assert.deepEqual(verifyChain(before.entries),{ok:true});
    const staged=await f.bundle();const after=await ops.readState(f);assert.equal(after.state.nodes.a!.halt?.seq,before.state.nodes.a!.halt?.seq);assert.ok((await ledgerBytes(f.cwd)).startsWith(bytes));
    const extended=extendState(reduceFrom(before.state,[],lookup),[staged.entry]);assert.ok(sameReplay(extended,reduce(after.entries,lookup)));assert.equal(JSON.stringify(before.entries),JSON.stringify(JSON.parse(`[${bytes.trim().split('\n').join(',')}]`)));
    // An old plan has no delegate block and no new enumerable fields appear in replay.
    const old={...JSON.parse(f.plan)};delete old.drive;const oldPlan=parsePlan(JSON.stringify(old));const genesis=before.entries[0]!;assert.ok(genesis.kind==='genesis');const e={...genesis,plan:sha256('old')};e.hash=entryHash(e);const state=reduce([e],()=>oldPlan);assert.equal('stages' in state,false);assert.equal('delegate' in (state.plan.drive ?? {}),false);
  }finally{await f.cleanup();}
});

test('F2: the status stage count excludes stale stages from the open count',async()=>{
  const f=await fixture();try{
    const first=await f.bundle(),second=await f.bundle({},'b');
    // A rule on node b makes the b stage stale; the a stage stays open.
    await ops.rule({cwd:f.cwd,as:parent,nodes:['b'],text:'New fact',dsa:f.dsa});
    const views=await ops.stages({...f.actor,all:true});
    assert.equal(views.find(s=>s.id===first.id)!.state,'open');
    assert.equal(views.find(s=>s.id===second.id)!.state,'stale');
    // The status line counts the open stages only: one open, one stale (not two open).
    const text=renderStatus(await ops.status(f));
    assert.match(text,/Stages: 1 open \(1 stale\)/);
    assert.doesNotMatch(text,/Stages: 2 open/);
  }finally{await f.cleanup();}
});
