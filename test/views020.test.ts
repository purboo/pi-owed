import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import { git } from '../src/git.ts';
import { stateOf } from '../src/drive-run.ts';
import { decide, ownerNeeded, writerLaunch } from '../src/drive.ts';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';
import { statusView } from '../src/views.ts';
import { projectId } from '../src/reducer.ts';
import { Follower } from '../src/drive-bg.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const owner = { as:{role:'owner' as const,id:'pi'}, channel:'delegated' as const, lease:false };
const parent = { as:{role:'parent' as const,id:'main'} };
const driver = { as:{role:'parent' as const,id:'drive'} };
async function fixture(approve = false) {
  const r = await repo();
  const p = { version:1, trunk:'main', closure:[], invariants:[], nodes:[
    { id:'a', writes:['a.txt'], checks:[], review:{count:1,min_rank:1}, ...(approve ? {approve:'owner'} : {}) },
    { id:'dep', writes:['dep.txt'], checks:[], review:{count:0,min_rank:1} },
  ] };
  await r.put('plan.json',JSON.stringify(p)); await r.commit();
  await ops.init({cwd:r.cwd,...owner,plan:JSON.stringify(p)});
  const slot = await ops.dispatch({cwd:r.cwd,...parent,node:'a'});
  const state = await stateOf(r.cwd), launch = writerLaunch(state,'a',projectId(state));
  await ops.launch({cwd:r.cwd,...driver,...launch});
  await commitAt(slot.worktree,{'a.txt':'candidate'});
  await ops.submit({cwd:slot.worktree,node:'a',as:{role:'writer',id:'a#1'}});
  await ops.attest({cwd:r.cwd,node:'a',lease:false});
  return {r,p,slot,rid:launch.rid};
}
async function block(cwd: string, rank = 1, by = 'independent') {
  return ops.review({cwd,node:'a',as:{role:'reviewer',id:by},verdict:'block',rank,note:'repair the ownership collision',ack_rulings:0});
}

test('NY1/NY3: driver-authored rank-2 repair hides review debt only when the driver needs no owner', async () => {
  const {r,slot,rid} = await fixture();
  try {
    const b = await block(r.cwd,2,'drive-a-1-1');
    let status = await ops.status({cwd:r.cwd});
    assert.equal(status.nodes.a!.accepted,false);
    const need = status.summary!.needs.find(n => n.node === 'a')!;
    assert.doesNotMatch(need.reason,/review needs an owner decision/);
    assert.match(need.command,/^owed decide a --writer --text/);
    assert.ok(need.command.indexOf('owed review') > need.command.indexOf('owed decide'));
    assert.match(need.command,/overrides a valid block: state the accepted risk/);
    await ops.send({cwd:r.cwd,...driver,node:'a',attempt:1,rid,sendKind:'follow-up',reason:'repair',message:'repair the collision',rulings:0});
    status = await ops.status({cwd:r.cwd});
    assert.equal(status.summary!.progress.find(p => p.node === 'a')!.phase,`repairing (block #${b.seq})`);
    assert.equal(ownerNeeded(await stateOf(r.cwd),'a'),undefined);
    assert.equal(status.summary!.needs.filter(n => n.node === 'a').length,0);
    await commitAt(slot.worktree,{'a.txt':'fixed'});
    await ops.submit({cwd:slot.worktree,node:'a',as:{role:'writer',id:'a#1'}});
    await ops.attest({cwd:r.cwd,node:'a',lease:false});
    status = await ops.status({cwd:r.cwd});
    assert.equal(ownerNeeded(await stateOf(r.cwd),'a'),undefined);
    assert.equal(status.summary!.needs.filter(n => n.node === 'a').length,0);
    assert.equal(status.nodes.a!.accepted,false,'a new submit never clears a valid block by presentation');
    const conflict = await stateOf(r.cwd);
    conflict.nodes.a!.items.find(i => i.obligation === 'review')!.mark = '⊤';
    assert.ok(ownerNeeded(conflict,'a'));
    assert.ok(statusView(conflict).summary!.needs.some(n => n.node === 'a'),'a conflict stays visible even during a driver-authored repair');
    await block(r.cwd,2,'new-reviewer');
    status = await ops.status({cwd:r.cwd});
    assert.ok(status.summary!.needs.some(n => n.node === 'a'),'a later valid block is not hidden by an older repair');
  } finally { await r.cleanup(); }
});

test('NY1 parent ruling: external rank-2 blocks stay in Needs-you during repair and after resubmit plus attest', async () => {
  const {r,slot,rid} = await fixture();
  try {
    const b = await block(r.cwd,2);
    const consistent = async () => {
      const s = await stateOf(r.cwd), status = await ops.status({cwd:r.cwd});
      assert.match(ownerNeeded(s,'a')!,new RegExp(`rank 2 review block #${b.seq} on review needs the owner`));
      assert.ok(status.summary!.needs.some(n => n.node === 'a'),'owner review debt remains visible');
      assert.equal(status.summary!.progress.find(p => p.node === 'a')!.phase,`repairing (block #${b.seq})`);
      const actions = decide(s,s.plan,new Map([[rid,{rid,state:'running' as const}]]),{max:2,repairs:2,project:projectId(s),root:r.cwd,applied:new Set(),rejected:new Map()});
      assert.ok(actions.some(a => a.node === 'a' && a.do === 'notify' && /needs the owner/.test(a.text)),'driver owner notification agrees with Needs-you');
      assert.equal(status.nodes.a!.accepted,false);
    };
    await ops.send({cwd:r.cwd,...driver,node:'a',attempt:1,rid,sendKind:'follow-up',reason:'repair',message:'repair the collision',rulings:0});
    await consistent();
    await commitAt(slot.worktree,{'a.txt':'fixed'});
    await ops.submit({cwd:slot.worktree,node:'a',as:{role:'writer',id:'a#1'}});
    await ops.attest({cwd:r.cwd,node:'a',lease:false});
    await consistent();
    // Owner-only rank and flaky state keep the same presentation predicate as the driver.
    for (const kind of ['rank3','flaky'] as const) {
      const s = await stateOf(r.cwd), block = s.nodes.a!.blocks.find(x => x.seq === b.seq)!;
      if (kind === 'rank3') block.rank = 3; else block.state = 'flaky';
      assert.ok(ownerNeeded(s,'a'));
      assert.ok(statusView(s).summary!.needs.some(n => n.node === 'a'),`${kind} remains visible while repairing`);
    }
  } finally { await r.cleanup(); }
});

test('NY3: only a top review state says owner decision; rank-2 blocks stay guidance', async () => {
  const {r} = await fixture();
  try {
    await block(r.cwd,2);
    const status = await ops.status({cwd:r.cwd});
    assert.equal(status.nodes.a!.items.find(i => i.obligation === 'review')!.mark,'⛔');
    assert.doesNotMatch(status.summary!.needs.find(n => n.node === 'a')!.reason,/review needs an owner decision/);
    const state = await stateOf(r.cwd);
    state.nodes.a!.items.find(i => i.obligation === 'review')!.mark = '⊤';
    assert.match(statusView(state).summary!.needs.find(n => n.node === 'a')!.reason,/review needs an owner decision/);
  } finally { await r.cleanup(); }
});

test('NY2: approval waits for resume-after and becomes actionable only after the wait closes', async () => {
  const {r} = await fixture(true);
  try {
    await ops.resume({cwd:r.cwd,...parent,node:'a',after:['dep'],note:'wait for dependency'});
    let s = await ops.status({cwd:r.cwd});
    assert.equal(s.summary!.progress.find(p => p.node === 'a')!.phase,'waiting for dep (owner approval after)');
    assert.equal(s.summary!.needs.filter(n => n.node === 'a' && n.reason === 'awaiting owner approval').length,0);
    await ops.resume({cwd:r.cwd,...parent,node:'a',note:'replace the wait'});
    s = await ops.status({cwd:r.cwd});
    assert.ok(s.summary!.needs.some(n => n.node === 'a' && n.reason === 'awaiting owner approval'));
  } finally { await r.cleanup(); }
});

test('NY2: approval waits for unmerged plan dependencies too', async () => {
  const {r,p} = await fixture(true);
  try {
    const next = {...p,nodes:p.nodes.map(n => n.id === 'a' ? {...n,deps:['dep']} : n)};
    await ops.planSet({cwd:r.cwd,...owner,plan:JSON.stringify(next),note:'wait for dep'});
    const s = await ops.status({cwd:r.cwd});
    assert.equal(s.summary!.progress.find(p => p.node === 'a')!.phase,'waiting for dep (owner approval after)');
    assert.ok(!s.summary!.needs.some(n => n.node === 'a' && n.reason === 'awaiting owner approval'));
  } finally { await r.cleanup(); }
});

test('NY4: wake prints every question and halt reason once with commands preserved', async () => {
  const r = await repo();
  try {
    const log = join(r.root,'drive.jsonl'); writeFileSync(log,'');
    const follower = new Follower({log,repo:r.cwd,pid:process.pid,deliver:()=>{},from:0});
    const question = 'a: asks (qid q1): Which owner? — answer: owed answer a "decision"';
    const other = 'a: asks (qid q2): Which retention? — answer: owed answer a --qid q2 "decision"';
    const halt = 'a: halted — review block needs guidance; record owed rule --nodes a "decision"';
    for (const text of [question,other,halt]) appendFileSync(log,JSON.stringify({do:'notify',node:'a',outcome:'notify',text})+'\n');
    const message = follower.tick()!;
    for (const text of ['Which owner?','Which retention?','review block needs guidance']) assert.equal(message.split(text).length-1,1,message);
    assert.doesNotMatch(message,/Details:/);
    assert.match(message,/owed answer a --qid q2/);
    follower.stop();
  } finally { await r.cleanup(); }
});

test('NY5: CLI plan receipt leads the reply and counts exact additions/removals/changes', async () => {
  const {r,p} = await fixture();
  try {
    const next = {...p,nodes:[{...p.nodes[0],title:'changed'}, {id:'new',writes:['new.txt'],checks:[],review:{count:0,min_rank:1}}]};
    await r.put('next.json',JSON.stringify(next));
    const out = await cli(r.cwd,['plan','next.json','--as','owner:pi','--note','update plan']);
    assert.equal(out.code,0,out.stderr);
    assert.match(out.stdout,/^Recorded plan #\d+ \(v1 : \+1 nodes \[new\], -1, ~1 changed; downgrades: /);
  } finally { await r.cleanup(); }
});

test('NY6: why hides weak-confirmation history by default; --full restores it', async () => {
  const {r} = await fixture();
  try {
    const normal = await cli(r.cwd,['why','a']);
    assert.equal(normal.code,0,normal.stderr);
    assert.doesNotMatch(normal.stdout,/owner flag weak confirmation:/);
    const full = await cli(r.cwd,['why','a','--full']);
    assert.equal(full.code,0,full.stderr);
    assert.match(full.stdout,/owner flag weak confirmation: none/);
  } finally { await r.cleanup(); }
});

test('NY5/NY6: pi plan starts with receipt and why exposes full parity', async () => {
  const {r,p} = await fixture();
  try {
    const tools = new Map<string,ToolDefinition>();
    owed({registerTool(t:ToolDefinition){tools.set(t.name,t);},registerCommand(){},on(){}} as unknown as ExtensionAPI);
    const ctx = {cwd:r.cwd,hasUI:false,ui:{notify(){},async confirm(){return true;}}} as unknown as ExtensionContext;
    const call = async (name:string,args:Record<string,unknown>) => {
      const res = await tools.get(`owed_${name}`)!.execute('test',args,undefined,undefined,ctx as Parameters<ToolDefinition['execute']>[4]);
      assert.notEqual((res as {isError?:boolean}).isError,true,JSON.stringify(res));
      return res.content.map(c => c.type === 'text' ? c.text : '').join('\n');
    };
    await r.put('pi-plan.json',JSON.stringify({...p,nodes:[...p.nodes,{id:'extra',writes:['extra.txt'],checks:[]}]}));
    assert.match(await call('plan',{plan:'pi-plan.json'}),/^Recorded plan #\d+ \(v1 : \+1 nodes \[extra\], -0, ~0 changed; downgrades: none\)/);
    assert.ok('full' in (tools.get('owed_why')!.parameters as {properties:object}).properties);
    assert.doesNotMatch(await call('why',{node:'a'}),/owner flag weak confirmation:/);
    assert.match(await call('why',{node:'a',full:true}),/owner flag weak confirmation:/);
  } finally { await r.cleanup(); }
});

test('NY7: fallback upstream uses merge-base with dispatch trunk; missing worktrees are not drift evidence', async () => {
  const r = await repo();
  try {
    await r.put('seed.txt','root'); const root = await r.commit();
    await r.put('trunk.txt','dispatch'); await r.commit();
    const p = {version:1,trunk:'main',closure:[],invariants:[],nodes:[{id:'a',writes:['a.txt'],checks:[],review:{count:0,min_rank:1}}]};
    await ops.init({cwd:r.cwd,...owner,plan:JSON.stringify(p)});
    const slot = await ops.dispatch({cwd:r.cwd,...parent,node:'a'});
    await git(slot.worktree,['reset','--hard',root]);
    await commitAt(slot.worktree,{'a.txt':'own patch'});
    let status = await ops.status({cwd:r.cwd});
    assert.ok(status.rebasePending?.a,'actual HEAD not descending from dispatch base is reported');
    assert.equal(status.rebasePending.a.upstream,root);
    await commitAt(r.cwd,{'trunk.txt':'next'});
    await ops.adopt({cwd:r.cwd,...owner,note:'advance trunk'});
    const rb = await ops.rebase({cwd:r.cwd,...parent,node:'a'});
    assert.match(rb.packet,new RegExp(`git rebase --onto ${rb.base} ${root}`));
    await git(slot.worktree,['rebase','--onto',rb.base,root]);
    assert.equal((await ops.status({cwd:r.cwd})).rebasePending,undefined);
    await git(r.cwd,['worktree','remove','--force',slot.worktree]);
    status = await ops.status({cwd:r.cwd});
    assert.equal(status.rebasePending,undefined);
  } finally { await r.cleanup(); }
});

test('NY7: unapplied successive rebases show drift, compute actual upstream, and send once per base', async () => {
  const {r,slot,rid} = await fixture();
  try {
    const original = (await stateOf(r.cwd)).nodes.a!.slot!.base;
    await commitAt(r.cwd,{'trunk.txt':'one'});
    await ops.adopt({cwd:r.cwd,...owner,note:'advance trunk'});
    await ops.rebase({cwd:r.cwd,...parent,node:'a'});
    await commitAt(r.cwd,{'trunk.txt':'two'});
    await ops.adopt({cwd:r.cwd,...owner,note:'advance again'});
    const rb = await ops.rebase({cwd:r.cwd,...parent,node:'a'});
    assert.match(rb.packet,new RegExp(`First commit your work, then run: git rebase --onto ${rb.base} ${original}`));
    const out = await cli(r.cwd,['status']);
    assert.match(out.stdout,/a: rebase pending \(HEAD [a-f0-9]{12} not on slot base [a-f0-9]{12}\)/);
    const why = await cli(r.cwd,['why','a']); assert.match(why.stdout,/rebase pending/);
    const ruling = await ops.rule({cwd:r.cwd,...parent,nodes:['a'],text:'keep the original ownership boundary'});
    const s = await stateOf(r.cwd), pending = (await ops.status({cwd:r.cwd})).rebasePending!.a!;
    assert.equal(pending.upstream,original);
    const options = {max:2,repairs:2,project:'test',root:r.cwd,applied:new Set<string>(),rejected:new Map<string,string>(),rebasePending:new Map([['a',pending]])};
    const runs = new Map([[rid,{rid,state:'running' as const}]]);
    const action = decide(s,s.plan,runs,options).find(a => a.node === 'a');
    assert.ok(action?.do === 'send' && action.reason === 'rebase',JSON.stringify(action));
    assert.match(action.message,new RegExp(`git rebase --onto ${rb.base} ${original}`));
    assert.equal(action.rulings,ruling.seq,'drift follow-up carries undelivered parent guidance');
    assert.match(action.message,/keep the original ownership boundary/);
    const recorded = await ops.send({cwd:r.cwd,...driver,node:'a',attempt:1,rid:action.rid,sendKind:action.sendKind,reason:action.reason,message:action.message,rulings:action.rulings});
    const next = await stateOf(r.cwd);
    const retry = decide(next,next.plan,runs,{...options,blobs:new Map([[recorded.message,action.message]])}).find(a => a.node === 'a');
    assert.ok(retry?.do === 'send' && retry.send === recorded.send,'unacknowledged follow-up retries the same durable send');
    options.applied.add(recorded.send);
    assert.ok(!decide(next,next.plan,runs,options).some(a => a.node === 'a' && a.do === 'send' && a.reason === 'rebase'));
    await assert.rejects(ops.rebase({cwd:r.cwd,...parent,node:'a'}),/trunk has not moved/);
    await git(slot.worktree,['rebase','--onto',rb.base,original]);
    assert.equal((await ops.status({cwd:r.cwd})).rebasePending,undefined);
    assert.doesNotMatch((await cli(r.cwd,['status'])).stdout,/rebase pending/);
  } finally { await r.cleanup(); }
});
