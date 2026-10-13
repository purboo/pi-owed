import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdir, readFile, rename, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';
import * as ops from '../src/ops.ts';
import * as git from '../src/git.ts';
import { Ledger } from '../src/ledger.ts';
import { parsePlan } from '../src/plan.ts';
import { reduce } from '../src/reducer.ts';
import { briefView, renderBrief, renderStatus, statusView } from '../src/views.ts';
import type { Entry, ItemView, NodeState, Plan } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const now = Date.UTC(2026, 0, 1, 0, 5);
const parent = { role:'parent' as const, id:'pi' };
const owner = { role:'owner' as const, id:'pi' };
function fixture() {
  const plan: Plan = { version:1, trunk:'main', closure:[], invariants:[], nodes:[] };
  const entries = [{kind:'genesis', by:'owner:human', channel:'flag', plan:'p', trunk:'main', commit:'abcdef0123456789', state:{commit:'abcdef0123456789', tree:'t', invKeys:{}}, seq:0, ts:new Date(now - 300_000).toISOString(), prev:'x', hash:'h'}] as Entry[];
  const s = reduce(entries, () => plan);
  return {s, entries};
}
const item = (subject:string, obligation:string, discharger:ItemView['discharger'], detail='awaiting observation', status:ItemView['status']='D'): ItemView => ({subject, obligation, discharger, detail, status, mark:status === 'W' ? '⚠' : '⊥', key:'key', evidence:[]});
function addNode(f:ReturnType<typeof fixture>, id:string, phase:NodeState['phase'], items:ItemView[] = []) {
  f.s.plan.nodes.push({id, deps:[], writes:[`${id}/`], checks:[], review:{count:0,min_rank:1}});
  const n:NodeState = {id, phase, items, blocks:[], accepted:phase === 'accepted', dependents:0, writers:[], runs:[]};
  if (['dispatched','submitted','accepted'].includes(phase)) n.slot = {attempt:1,base:'base',branch:id,worktree:`/repo/${id}`,writer:`writer:${id}#1`,dispatchSeq:0,rulings_seen:-1,open:true};
  if (phase === 'submitted' || phase === 'accepted') n.candidate = {seq:0,commit:'candidate',base:'base',tree:'tree',patch:'patch',keys:Object.fromEntries(items.map(i=>[i.obligation,i.key])),changed:[],closureTouched:false};
  if (phase === 'merged') n.merged = {seq:0,commit:'merged'};
  f.s.nodes[id] = n;
  return n;
}

test('SQ1 default status shows outcome, each phase and only current parent/owner actions and debt', () => {
  const f = fixture();
  addNode(f,'done','merged');
  addNode(f,'writer','dispatched');
  addNode(f,'measure','submitted',[item('measure','check:unit','executor')]);
  addNode(f,'review','submitted',[item('review','review','reviewer')]);
  addNode(f,'accepted','accepted');
  addNode(f,'waiting','blocked'); f.s.plan.nodes.find(n=>n.id==='waiting')!.deps=['writer'];
  const held = addNode(f,'held','held'); held.held=0;
  const halt = addNode(f,'halt','dispatched');
  halt.halt = {kind:'halt',node:'halt',attempt:1,by:'parent:drive',seq:1,ts:new Date(now).toISOString(),prev:'x',hash:'h1',needs:'human',reason:'repair budget exhausted'};
  const ruling = addNode(f,'ruling','submitted',[item('ruling','review','reviewer')]);
  ruling.blocks.push({seq:2,node:'ruling',obligation:'review',kind:'judgment',key:'key',rank:2,state:'active',needs:'parent'});
  f.entries.push({kind:'review',by:'reviewer:r',node:'ruling',attempt:1,obligation:'review',key:'key',rank:2,verdict:'block',needs:'parent',note:'choose the public response',seq:2,ts:new Date(now).toISOString(),prev:'x',hash:'h2'});
  addNode(f,'owner','submitted',[item('owner','approve','owner')]);
  addNode(f,'waived','accepted',[item('waived','check:unit',undefined,'risk accepted','W')]);
  addNode(f,'ready','ready');
  f.s.invariants = [item('trunk','inv:health','parent','trunk-red: existing failure')];
  f.s.trunk.invKeys.health='key'; f.s.deferred.push({seq:3,node:'owner',id:'health',key:'key'});
  const v=statusView(f.s,f.entries,[],now), text=renderStatus(v);
  assert.match(text,/^owed: 1 merged · 10 in progress · 5 need you · trunk main abcdef012345 ✘ invariants \(0\/1\)\nNeeds you \(5\):/);
  for (const [id,phase] of [['writer','writing'],['measure','measuring'],['review','reviewing'],['waiting','waiting for writer'],['held','held'],['accepted','accepted (merge pending)']]) assert.ok(text.includes(`${id}: ${phase} (5m)`),text);
  assert.match(text,/ruling: needs a parent ruling: choose the public response → owed rule --nodes ruling "<decision>"/);
  assert.match(text,/halt: driver halted: repair budget exhausted → owed resume halt/);
  assert.match(text,/owner: awaiting owner approval → owed approve owner --candidate candidate/);
  assert.match(text,/ready: ready to dispatch → owed dispatch ready/);
  assert.match(text,/Debt:\n[\s\S]*inv:health: trunk-red: existing failure[\s\S]*waived\/check:unit: waived[\s\S]*owner\/inv:health: owner defer/);
  assert.ok(text.endsWith('Details: owed status --full · owed why <node>'));
  assert.doesNotMatch(text,/owner flag|Driver runs|superseded|carried|Pending executor/);
  assert.equal(renderStatus(statusView(f.s,f.entries,[],now,true)).includes('ready to dispatch'),false);
});

test('SQ2 full status preserves the exact 0.14 rendering and default omits audit and empty sections', () => {
  const f=fixture(), v=statusView(f.s,f.entries,[],now);
  const legacy='Trunk main abcdef0123456789\nReady (by dependent count): none\nPending owner:\nnone\nPending parent+writer:\nnone\nPending reviewer:\nnone\nPending executor:\nnone\nTrunk invariants:\nowner flag weak confirmation: #0 genesis';
  assert.equal(renderStatus(v,{full:true}),legacy);
  assert.equal(renderStatus(v),'owed: 0 merged · 0 in progress · 0 need you · trunk main abcdef012345 ✔ invariants (0/0)\nNeeds you: none\nDetails: owed status --full · owed why <node>');
});

test('SQ3 brief starts with the status header and Needs you while retaining other sections and JSON decisions', () => {
  const f=fixture(); addNode(f,'a','submitted',[item('a','approve','owner')]);
  const b=briefView(f.s,f.entries,999,now), text=renderBrief(b);
  assert.equal(text.split('\n').slice(0,3).join('\n'),renderStatus(statusView(f.s,f.entries,[],now)).split('\n').slice(0,3).join('\n'));
  assert.match(text,/\nBrief \(since #999\)\nMerged: none\nRejected or blocked: none\nIn progress \(1\):/);
  assert.equal(b.decisions[0]!.obligation,'approve');
  assert.equal(b.inProgress[0]!.node,'a');
  assert.equal(b.totals.acceptedUnmerged,0);
});

test('SQ CLI status --full and pi full:true preserve details; a live or foreign driver removes manual dispatch needs', async () => {
  const r=await repo(), tools=new Map<string,ToolDefinition>(), handlers=new Map<string,any>();
  const ctx={cwd:r.cwd,hasUI:false,isIdle:()=>true,ui:{notify(){}}} as unknown as Parameters<ToolDefinition['execute']>[4];
  try {
    await r.commit();
    await ops.init({cwd:r.cwd,as:owner,channel:'delegated',plan:JSON.stringify({version:1,trunk:'main',closure:[],invariants:[],nodes:[{id:'a',writes:['a/'],checks:[],review:{count:0,min_rank:1}}]})});
    owed({registerTool:(t:ToolDefinition)=>tools.set(t.name,t),registerCommand(){},on:(n:string,h:unknown)=>handlers.set(n,h),sendMessage(){}} as unknown as ExtensionAPI);
    const plain=await cli(r.cwd,['status']), full=await cli(r.cwd,['status','--full']);
    assert.equal(plain.code,0); assert.equal(full.code,0,full.stderr);
    assert.match(plain.stdout,/^owed:.*1 need you/); assert.match(full.stdout,/^Trunk main /);
    assert.doesNotMatch(plain.stdout,/flag weak confirmation/); assert.match(full.stdout,/owner flag weak confirmation: none/);
    const a=await cli(r.cwd,['status','--json']), b=await cli(r.cwd,['status','--full','--json']);
    assert.equal(a.code,0); assert.deepEqual(JSON.parse(a.stdout),JSON.parse(b.stdout));
    for (const flag of [false,true]) {
      const result=await tools.get('owed_status')!.execute('t',{full:flag},undefined,undefined,ctx);
      assert.notEqual(result.isError,true);
      const text=(result.content as {text:string}[])[0]!.text;
      assert.match(text,flag ? /^Trunk main / : /^owed:/);
      assert.deepEqual((result.details as ops.StatusView).ready,['a']);
    }
    for (const host of [hostname(),'foreign-host']) {
      await writeFile(join(process.env.OWED_DIR!,'drive.lock'),JSON.stringify({pid:process.pid,host,at:new Date().toISOString(),token:'fixture'}));
      const status=await ops.status({cwd:r.cwd});
      assert.match(renderStatus(status),/Needs you: none/);
      assert.match(renderBrief(await ops.brief({cwd:r.cwd})),/Needs you: none/);
    }
  } finally { await handlers.get('session_shutdown')?.({},ctx); await r.cleanup(); }
});

test('SQ4 version hints occur once per session and installed version; full and mismatch refusals always retain them', async () => {
  const r=await repo(), copy=join(r.root,'package');
  try {
    await mkdir(copy); await cp(new URL('../src',import.meta.url),join(copy,'src'),{recursive:true});
    const pkg=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8'));
    const setVersion=async (version:string) => {
      await writeFile(join(copy,'package.next.json'),JSON.stringify({...pkg,version}));
      await rename(join(copy,'package.next.json'),join(copy,'package.json'));
    };
    await setVersion(pkg.version);
    await mkdir(join(copy,'node_modules')); await symlink(fileURLToPath(new URL('../node_modules/yaml',import.meta.url)),join(copy,'node_modules/yaml'));
    const mod=await import(join(copy,'src/ext-worker.ts'));
    const seen=new Set<string>(), other=new Set<string>(), result={content:[{type:'text',text:'result'}],details:{ready:['a']}};
    assert.equal(mod.versionNotice(result,{seen}),result);
    for (const version of ['99.0.0','99.0.1']) {
      await setVersion(version);
      const hint=mod.restartLine(version);
      assert.equal(mod.versionNotice(result,{seen}).content[0].text,`result\n${hint}`);
      assert.equal(mod.versionNotice(result,{seen}),result);
      assert.equal(mod.versionNotice(result,{seen,full:true}).content[0].text,`result\n${hint}`);
      assert.equal(mod.versionNotice(result,{seen:other}).content[0].text,`result\n${hint}`);
      const refused={content:[{type:'text',text:'Refused: mismatch'}],details:{code:'version'}};
      assert.equal(mod.versionNotice(refused,{seen}).content[0].text,`Refused: mismatch\n${hint}`);
      assert.equal(mod.versionNotice(refused,{seen}).content[0].text,`Refused: mismatch\n${hint}`);
    }
    assert.deepEqual(result.details,{ready:['a']});
    // Exercise the host-side session sets through real worker tool calls too.
    await setVersion(pkg.version);
    await r.commit();
    await ops.init({cwd:r.cwd,as:owner,channel:'delegated',plan:JSON.stringify({version:1,trunk:'main',closure:[],invariants:[],nodes:[]})});
    const sessions: {call:(full?:boolean)=>Promise<any>; shutdown:()=>Promise<void>}[]=[];
    const ctx={cwd:r.cwd,hasUI:false,isIdle:()=>true,ui:{notify(){}}};
    try {
      for (let n=0;n<2;n++) {
        let status:ToolDefinition | undefined;
        const handlers=new Map<string,any>();
        const api=mod.remoteAPI({registerTool:(t:ToolDefinition)=>{status=t;},registerCommand(){},on:(name:string,h:unknown)=>handlers.set(name,h),sendMessage(){}});
        api.registerTool({name:'owed_status',label:'status',description:'status',parameters:{},execute:async()=>({content:[],details:{}})} as unknown as ToolDefinition);
        api.on('session_shutdown',()=>{});
        sessions.push({call:(full=false)=>status!.execute('test',{full},undefined,undefined,ctx as any),shutdown:()=>handlers.get('session_shutdown')({},ctx)});
        await sessions[n]!.call();
      }
      await setVersion('99.0.2');
      const text=(out:any)=>out.content.map((c:any)=>c.text).join('\n');
      for (const session of sessions) {
        assert.ok(text(await session.call()).endsWith(mod.restartLine('99.0.2')));
        assert.doesNotMatch(text(await session.call()),/restart pi/);
        assert.ok(text(await session.call(true)).endsWith(mod.restartLine('99.0.2')));
        assert.doesNotMatch(text(await session.call()),/restart pi/);
      }
    } finally { for (const session of sessions) await session.shutdown(); await mod.toolWorker().worker?.terminate(); }
  } finally { await rm(copy,{recursive:true,force:true}); await r.cleanup(); }
});

test('SQ repair #1517.1 status and brief share a reused trunk-red merge diagnosis', async () => {
  const r=await repo();
  try {
    const run=`if grep -q broken flag; then echo 'owed-counts {"pass":0,"fail":1,"failed":["old bug"]}'; exit 1; else echo '# tests 1'; echo '# pass 1'; fi`;
    await commitAt(r.cwd,{flag:'clean',impl:'base'});
    await ops.init({cwd:r.cwd,as:owner,channel:'delegated',plan:JSON.stringify({version:1,trunk:'main',lease:false,closure:[],invariants:[],nodes:[{id:'a',writes:['impl'],checks:[{id:'runtime',run,reads:['flag','impl'],min_tests:1}]}]})});
    const a=await ops.dispatch({cwd:r.cwd,node:'a',as:parent});
    await commitAt(a.worktree,{impl:'candidate'});
    await ops.submit({cwd:a.worktree,node:'a',as:{role:'writer',id:'a#1'}});
    assert.equal((await ops.attest({cwd:r.cwd,node:'a'})).accepted,true);
    await commitAt(r.cwd,{flag:'broken'});
    await ops.adopt({cwd:r.cwd,as:owner,channel:'delegated',note:'fixture trunk change'});
    await assert.rejects(ops.merge({cwd:r.cwd,node:'a',as:parent}),/^OwedError: trunk-red:/);
    // Moving outside reads clears the old block while retaining the merge failure key.
    await commitAt(r.cwd,{unrelated:'outside reads'});
    await ops.adopt({cwd:r.cwd,as:owner,channel:'delegated',note:'unrelated trunk move'});
    assert.equal((await ops.attest({cwd:r.cwd,node:'a'})).accepted,true);
    await assert.rejects(ops.merge({cwd:r.cwd,node:'a',as:parent}),/^OwedError: trunk-red:/);
    const ledger=await Ledger.open(r.cwd), before=await ledger.read();
    const status=await ops.status({cwd:r.cwd}), brief=await ops.brief({cwd:r.cwd});
    assert.equal(status.nodes.a!.accepted,true);
    assert.equal(status.summary!.needs.length,1);
    assert.match(status.summary!.needs[0]!.reason,/trunk-red:/);
    assert.deepEqual(brief.summary!.needs,status.summary!.needs);
    const prefix=(text:string)=>text.split('\n').slice(0,3).join('\n');
    assert.equal(prefix(renderBrief(brief)),prefix(renderStatus(status)));
    assert.deepEqual(await ledger.read(),before,'summary queries record no acceptance evidence');
  } finally { await r.cleanup(); }
});

test('SQ ruling #1562 trunk-red invariants use curated Needs you text once in status and brief', async () => {
  const r=await repo();
  try {
    const failing=(name:string)=>`echo 'owed-counts {"pass":0,"fail":1,"failed":["${name}"]}'; exit 1`;
    await commitAt(r.cwd,{'one.sh':failing('old one'),'two.sh':failing('old two')});
    const plan={version:1,trunk:'main',lease:false,closure:[],invariants:[],nodes:[]};
    await ops.init({cwd:r.cwd,as:owner,channel:'delegated',plan:JSON.stringify(plan)});
    await ops.planSet({cwd:r.cwd,as:parent,plan:JSON.stringify({...plan,invariants:[{id:'one',run:'bash one.sh',reads:['one.sh'],min_tests:1},{id:'two',run:'bash two.sh',reads:['two.sh'],min_tests:1}]})});
    const refreshed=await ops.attestTrunk({cwd:r.cwd,lease:false});
    assert.deepEqual(refreshed.missing,[]);
    const status=await ops.status({cwd:r.cwd}), brief=await ops.brief({cwd:r.cwd});
    assert.equal(status.trunkRed?.length,2);
    for (const text of [renderStatus(status),renderBrief(brief)]) {
      const needs=text.split('\nDebt:')[0]!.split('\nBrief (since')[0]!;
      for (const red of status.trunkRed! as { obligation:string; text:string }[]) {
        const line:string=`  trunk: ${red.text}`;
        assert.equal(needs.split('\n').filter(l=>l===line).length,1,`${red.obligation} curated line appears once`);
      }
      assert.doesNotMatch(needs,/trunk: inv:(one|two): .*→ owed plan/);
    }
    assert.match(renderStatus(status),/Debt:\n  inv:one: [^\n]+\n  inv:two: /);
    assert.deepEqual(brief.summary!.needs,status.summary!.needs);
  } finally { await r.cleanup(); }
});

test('SQ repair #1517.2 A defer becomes history after B fixes the current merge invariant key', async () => {
  const r=await repo();
  try {
    const plan={version:1,trunk:'main',lease:false,closure:[],invariants:[{id:'health',run:'test ! -e bad.txt || test -e fix.txt',reads:['bad.txt','fix.txt']}],nodes:[{id:'a',writes:['bad.txt'],checks:[]},{id:'b',writes:['fix.txt'],checks:[]}]};
    await r.commit();
    await ops.init({cwd:r.cwd,as:owner,channel:'delegated',plan:JSON.stringify(plan)});
    const a=await ops.dispatch({cwd:r.cwd,node:'a',as:parent});
    await commitAt(a.worktree,{'bad.txt':'broken'});
    await ops.submit({cwd:a.worktree,node:'a',as:{role:'writer',id:'a#1'}});
    assert.equal((await ops.attest({cwd:r.cwd,node:'a'})).accepted,true);
    await assert.rejects(ops.merge({cwd:r.cwd,node:'a',as:parent}),/invariant health new debt/);
    const deferral=await cli(r.cwd,['defer','a','health','--reason','repair later','--i-am-owner']);
    assert.equal(deferral.code,0,deferral.stderr);
    const ledger=await Ledger.open(r.cwd), deferred=(await ledger.read()).findLast(e=>e.kind==='defer')!;
    assert.equal(deferred.kind,'defer');
    assert.match(renderStatus(await ops.status({cwd:r.cwd})),/a\/inv:health: owner defer/);
    assert.ok((await ops.brief({cwd:r.cwd})).summary!.debt.includes('a/inv:health: owner defer'));
    const b=await ops.dispatch({cwd:r.cwd,node:'b',as:parent});
    await commitAt(b.worktree,{'fix.txt':'fixed'});
    await ops.submit({cwd:b.worktree,node:'b',as:{role:'writer',id:'b#1'}});
    assert.equal((await ops.attest({cwd:r.cwd,node:'b'})).accepted,true);
    await ops.merge({cwd:r.cwd,node:'b',as:parent});
    const status=await ops.status({cwd:r.cwd});
    assert.equal(status.nodes.a!.slot!.open,true);
    const built=await git.buildMerge(r.cwd,status.trunk.commit,status.nodes.a!.candidate!.commit,'owed merge a');
    assert.ok(!('conflicts' in built));
    const facts=await git.stateFacts(r.cwd,parsePlan(JSON.stringify(plan)),built.commit);
    assert.notEqual(facts.invKeys.health,deferred.kind==='defer' ? deferred.items[0]!.key : undefined);
    assert.doesNotMatch(renderStatus(status),/a\/inv:health: owner defer/);
    assert.ok(!(await ops.brief({cwd:r.cwd})).summary!.debt.includes('a/inv:health: owner defer'));
    assert.match(renderStatus(status,{full:true}),new RegExp(`#${deferred.seq} defer`),'full retains the owner audit history');
    assert.ok((await ledger.read()).some(e=>e.seq===deferred.seq),'the historical deferral remains in the ledger');
    await r.put('removed-plan.json',JSON.stringify({...plan,nodes:plan.nodes.filter(n=>n.id!=='a')}));
    const removed=await cli(r.cwd,['plan','removed-plan.json','--i-am-owner','--note','retire the still-open candidate']);
    assert.equal(removed.code,0,removed.stderr);
    const retired=await ops.status({cwd:r.cwd});
    assert.equal(retired.nodes.a!.phase,'removed');
    assert.equal(retired.nodes.a!.slot!.open,true);
    assert.doesNotMatch(renderStatus(retired),/a\/inv:health: owner defer/);
    assert.ok(!(await ops.brief({cwd:r.cwd})).summary!.debt.includes('a/inv:health: owner defer'));
  } finally { await r.cleanup(); }
});
