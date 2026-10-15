import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import { git, revParse, isClean, isAncestor } from '../src/git.ts';
import { Ledger, lockWait } from '../src/ledger.ts';
import { parsePlan } from '../src/plan.ts';
import { reduce, validateDraft, projectId, reviewEpoch } from '../src/reducer.ts';
import { Driver } from '../src/drive-run.ts';
import { Dsa } from '../src/dsa.ts';
import { writerLaunch, decide } from '../src/drive.ts';
import { renderReceipt } from '../src/views.ts';
import type { Draft, Entry, Plan, State, SubmitEntry } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const parent = {role:'parent' as const,id:'main'}, driverActor = {role:'parent' as const,id:'drive'}, owner = {role:'owner' as const,id:'pi'}, writer = {role:'writer' as const,id:'a#1'};
const lines = (changes: Record<number,string> = {}) => Array.from({length:20},(_,i) => changes[i] ?? `line-${i}`).join('\n') + '\n';
async function fixture({closure=false, count=2, launch=false}: {closure?:boolean;count?:number;launch?:boolean} = {}) {
  const r = await repo();
  await git(r.cwd,['config','user.name','test']); await git(r.cwd,['config','user.email','test@localhost']);
  const plan = {version:1,trunk:'main',lease:false,closure:['closure.txt'],invariants:[{id:'all',run:'node --test --test-reporter=tap check.test.cjs',reads:['**'],min_tests:1}],nodes:[{id:'a',writes:['a.txt','closure.txt'],checks:[{id:'all',run:'node --test --test-reporter=tap check.test.cjs',reads:['**'],min_tests:1}],review:{count,min_rank:2}}]};
  await commitAt(r.cwd,{'a.txt':lines(),'closure.txt':lines(),'check.test.cjs':"const {test}=require('node:test'); const assert=require('node:assert/strict'); const fs=require('node:fs'); test('actual tree readable',()=>assert.ok(fs.readFileSync('a.txt','utf8').startsWith('line-0\\n')));\n",'plan.json':JSON.stringify(plan)});
  await ops.init({cwd:r.cwd,as:owner,channel:'delegated',plan:JSON.stringify(plan)});
  const slot = await ops.dispatch({cwd:r.cwd,as:parent,node:'a'}), ledger = await Ledger.open(r.cwd);
  const state = async (): Promise<State> => {
    const entries = await ledger.read(), plans = new Map<string,Plan>();
    for (const e of entries) if (e.kind === 'genesis' || e.kind === 'plan') plans.set(e.plan,parsePlan((await ledger.getBlob(e.plan)).toString()));
    return reduce(entries,sha => plans.get(sha)!);
  };
  let writerRid: string | undefined;
  if (launch) { const s = await state(), a = writerLaunch(s,'a',projectId(s)); await ops.launch({cwd:r.cwd,as:driverActor,...a}); writerRid = a.rid; }
  const oldCommit = await commitAt(slot.worktree,{'a.txt':lines({5:'writer'}),...(closure ? {'closure.txt':lines({5:'writer closure'})} : {})});
  const submitted = await ops.submit({cwd:slot.worktree,as:writer,node:'a'}) as SubmitEntry;
  await ops.attest({cwd:r.cwd,node:'a'});
  const reviews: Entry[] = [];
  async function reviewAll() {
    for (let k=1;k<=count;k++) reviews.push(await ops.review({cwd:r.cwd,as:{role:'reviewer',id:`independent-${k}`},node:'a',verdict:'ok',rank:2,note:'read actual patch'}));
    if (closure) reviews.push(await ops.review({cwd:r.cwd,as:{role:'reviewer',id:'independent-1'},node:'a',obligation:'closure-review',verdict:'ok',rank:2,note:'read closure change'}));
  }
  async function move(conflict=false) {
    const commit = await commitAt(r.cwd,{'a.txt':lines(conflict ? {5:'trunk conflicts'} : {7:'trunk'}),...(closure ? {'closure.txt':lines({7:'trunk closure'})} : {}),'trunk.txt':'moved\n'});
    await ops.adopt({cwd:r.cwd,as:owner,channel:'delegated',note:'fixture trunk moved'});
    return commit;
  }
  async function manualRebase(changed=false, conflict=false) {
    const target = await move(conflict), rb = await ops.rebase({cwd:r.cwd,as:parent,node:'a'});
    const rebase = await git(slot.worktree,['rebase','--onto',rb.base,rb.from],{allowFail:true});
    if (conflict) { assert.equal(rebase.code,1); await writeFile(join(slot.worktree,'a.txt'),lines({5:'resolved edit'})); await git(slot.worktree,['add','a.txt']); await git(slot.worktree,['rebase','--continue'],{env:{GIT_EDITOR:'true'}}); }
    else assert.equal(rebase.code,0,rebase.stderr);
    if (changed) await commitAt(slot.worktree,{'a.txt':lines({5:'writer changed',7:'trunk'})});
    return {target,entry:await ops.submit({cwd:slot.worktree,as:writer,node:'a'}) as SubmitEntry};
  }
  return {...r,slot,ledger,state,oldCommit,submitted,reviews,reviewAll,move,manualRebase,writerRid};
}

for (const closure of [false,true]) test(`ER1: exact clean rebase carries all rank/count${closure ? ' and closure-review' : ''}, not measurements`, {timeout:120_000}, async () => {
  const r = await fixture({closure});
  try {
    await r.reviewAll(); const before = await r.state(); assert.equal(before.nodes.a!.accepted,true);
    const {target,entry} = await r.manualRebase();
    assert.notEqual(entry.facts.keys.review,r.submitted.facts.keys.review,'fixture changes diff context, hence review key');
    assert.deepEqual(entry.facts.carry,{from:r.oldCommit,reviews:r.reviews.map(e=>e.seq)});
    const s = await r.state(), n = s.nodes.a!;
    for (const i of n.items.filter(i=>i.obligation==='review'||i.obligation==='closure-review')) assert.equal(i.status,'E');
    assert.equal(n.items.find(i=>i.obligation==='check:all')!.status,'D','candidate checks must measure C-prime');
    assert.equal(reviewEpoch(s,'a'),r.submitted.seq,'carried reviewers keep their epoch');
    assert.match(renderReceipt(await ops.why({cwd:r.cwd,node:'a'})),new RegExp(`review carried from ${r.oldCommit.slice(0,12)} .* across a clean rebase onto ${target.slice(0,12)}`));
    await ops.attest({cwd:r.cwd,node:'a'}); assert.equal((await r.state()).nodes.a!.accepted,true);
    await ops.merge({cwd:r.cwd,as:parent,node:'a'}); assert.equal((await ops.verify({cwd:r.cwd})).ok,true);
  } finally {await r.cleanup();}
});

for (const kind of ['changed','conflict'] as const) test(`ER1: ${kind === 'changed' ? 'changed hunk' : 'conflict resolution edit'} never carries reviews`, {timeout:120_000}, async () => {
  const r = await fixture();
  try {await r.reviewAll(); const {entry} = await r.manualRebase(kind==='changed',kind==='conflict'); assert.equal(entry.facts.carry,undefined); assert.equal((await r.state()).nodes.a!.items.find(i=>i.obligation==='review')!.status,'D');} finally {await r.cleanup();}
});

test('ER1: missing count, inadequate rank, waiver or a block cannot create carry', {timeout:120_000}, async () => {
  for (const mode of ['count','rank','waiver','block']) {
    const r = await fixture();
    try {
      await ops.review({cwd:r.cwd,as:{role:'reviewer',id:'one'},node:'a',verdict:'ok',rank:2,note:'one'});
      if (mode==='rank') await ops.review({cwd:r.cwd,as:{role:'reviewer',id:'two'},node:'a',verdict:'ok',rank:1,note:'insufficient'});
      if (mode==='waiver') await ops.waive({cwd:r.cwd,as:owner,channel:'delegated',node:'a',obligation:'review',reason:'fixture risk'});
      if (mode==='block') {await r.reviewAll(); await ops.review({cwd:r.cwd,as:{role:'reviewer',id:'blocker'},node:'a',verdict:'block',rank:2,note:'still blocked'});}
      assert.equal((await r.manualRebase()).entry.facts.carry,undefined,mode);
    } finally {await r.cleanup();}
  }
});

test('ER1: carry chains and plan carries retain provenance; later rulings still require acknowledgment', {timeout:120_000}, async () => {
  const r = await fixture();
  try {
    await r.reviewAll(); const first = (await r.manualRebase()).entry; await ops.attest({cwd:r.cwd,node:'a'});
    const s = await r.state(), plan = structuredClone(s.plan); plan.nodes[0]!.writes.push('extra.txt');
    await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',plan:JSON.stringify(plan),note:'fixture widen writes'});
    assert.deepEqual((await r.state()).nodes.a!.candidate!.carry,first.facts.carry);
    await commitAt(r.cwd,{'another.txt':'next base\n'}); await ops.adopt({cwd:r.cwd,as:owner,channel:'delegated',note:'next trunk'});
    const rb = await ops.rebase({cwd:r.cwd,as:parent,node:'a'}); await git(r.slot.worktree,['rebase','--onto',rb.base,rb.from]);
    const second = await ops.submit({cwd:r.slot.worktree,as:writer,node:'a'}) as SubmitEntry;
    assert.ok(second.facts.carry); assert.equal(second.facts.carry.from,first.facts.commit); assert.deepEqual(second.facts.carry.reviews,r.reviews.map(e=>e.seq));
    const rule = await ops.rule({cwd:r.cwd,as:parent,nodes:['a'],text:'check the new ruling'});
    await ops.attest({cwd:r.cwd,node:'a'});
    assert.equal((await r.state()).nodes.a!.items.find(i=>i.obligation==='rulings')!.status,'D');
    await ops.review({cwd:r.cwd,as:{role:'reviewer',id:'independent-1'},node:'a',verdict:'ok',rank:2,note:'acked',ack_rulings:rule.seq});
    assert.equal((await r.state()).nodes.a!.accepted,true);
  } finally {await r.cleanup();}
});

class SealedDsa extends Dsa {
  private isLive: boolean;
  constructor(live=false) {super({bin:process.execPath}); this.isLive=live;}
  override async inspect(rid:string) {return {view:{rid,state:this.isLive ? 'running' as const : 'sealed' as const,status:'ok'}};}
  override async send(_id?:string,_to?:string,_kind?:unknown,_message?:string|Uint8Array): Promise<import('../src/dsa.ts').SendResult> {throw new Error('unexpected writer send');}
  override async run(): Promise<never> {throw new Error('unexpected writer launch');}
}

for (const launch of [false,true]) test(`ER2: driver ${launch ? 'clean rebase with sealed writer sends nothing and remeasures checks' : 'uses writer route without a recorded writer run'}`,  {timeout:120_000}, async () => {
  const r = await fixture({launch});
  try {
    await r.reviewAll();
    const before = await r.state(), plan = structuredClone(before.plan); plan.nodes[0]!.deps=['b']; plan.nodes.push({id:'b',deps:[],writes:['trunk.txt','a.txt'],checks:[],review:{count:0,min_rank:1}});
    await ops.planSet({cwd:r.cwd,as:parent,plan:JSON.stringify(plan)}); // invalidate a, then restore reviewed candidate as the writer
    await ops.submit({cwd:r.slot.worktree,as:writer,node:'a'}); await ops.attest({cwd:r.cwd,node:'a'});
    const b = await ops.dispatch({cwd:r.cwd,as:parent,node:'b',allowOverlap:true});
    await commitAt(b.worktree,{'trunk.txt':'b\n','a.txt':lines({7:'trunk'})});
    await ops.submit({cwd:b.worktree,as:{role:'writer',id:'b#1'},node:'b'}); await ops.attest({cwd:r.cwd,node:'b'}); await ops.merge({cwd:r.cwd,as:parent,node:'b'});
    const driver = new Driver({cwd:r.cwd,dsa:new SealedDsa(),log:()=>{},session:null});
    const pass = await driver.pass(); assert.ok(pass.actions.some(a=>a.do==='rebase'),JSON.stringify(pass.actions));
    const entries = await r.ledger.read(), last = entries.at(-1)!;
    if (!launch) {assert.equal(last.kind,'rebase'); assert.equal(await revParse(r.slot.worktree,'HEAD'),r.oldCommit); assert.equal((await r.state()).nodes.a!.candidate,undefined); return;}
    assert.equal(last.kind,'submit');
    assert.ok(last.kind==='submit'); assert.equal(last.by,'executor:owed'); assert.equal(last.facts.rebased,true); assert.ok(last.facts.carry);
    assert.equal(await revParse(r.slot.worktree,'HEAD'),last.facts.commit); assert.equal(await isClean(r.slot.worktree),true);
    assert.equal(entries.filter(e=>e.kind==='send').length,0);
    const state = await r.state(); assert.equal(state.nodes.a!.items.find(i=>i.obligation==='check:all')!.status,'D');
    const actions = decide(state,state.plan,new Map(r.writerRid ? [[r.writerRid,{rid:r.writerRid,state:'sealed',status:'ok'}]] : []),{max:1,repairs:2,project:projectId(state),root:r.cwd,applied:new Set(),rejected:new Map()});
    assert.ok(actions.some(a=>a.node==='a'&&a.do==='attest'),JSON.stringify(actions));
    await ops.attest({cwd:r.cwd,node:'a'}); assert.equal((await r.state()).nodes.a!.accepted,true);
    assert.equal((await ops.verify({cwd:r.cwd})).ok,true);
  } finally {await r.cleanup();}
});

test('ER2: --apply uses real Git, records executor submit and refuses dirty/noncandidate HEAD atomically', {timeout:120_000}, async () => {
  const r = await fixture();
  try {
    await r.reviewAll(); const target = await r.move(), count = (await r.ledger.read()).length;
    await writeFile(join(r.slot.worktree,'untracked'),'dirty'); let reply = await cli(r.slot.worktree,['rebase','a','--apply','--as','parent:main']); assert.notEqual(reply.code,0); assert.match(reply.stderr,/dirty/); assert.equal((await r.ledger.read()).length,count);
    await git(r.slot.worktree,['clean','-f']); const other = await commitAt(r.slot.worktree,{});
    reply = await cli(r.slot.worktree,['rebase','a','--apply','--as','parent:main']); assert.notEqual(reply.code,0); assert.match(reply.stderr,/HEAD is not/); assert.equal((await r.ledger.read()).length,count);
    await git(r.slot.worktree,['reset','--hard',r.oldCommit]); assert.notEqual(other,r.oldCommit);
    reply = await cli(r.slot.worktree,['rebase','a','--apply','--as','parent:main']); assert.equal(reply.code,0,reply.stderr); assert.match(reply.stdout,/owed rebased your worktree .*continue from HEAD/); assert.match(reply.stdout,/no recorded writer run; caller asserts none is active/);
    const last = (await r.ledger.read()).at(-1)!; assert.ok(last.kind==='submit'); assert.equal(last.by,'executor:owed'); assert.equal(await isAncestor(r.cwd,target,last.facts.commit),true); assert.equal(last.facts.rebased,true);
  } finally {await r.cleanup();}
});

test('ER2/SB2: executor rebase skips trunk commits in a legacy merged candidate; reset recovery computes upstream after reset', {timeout:120_000}, async () => {
  const r = await fixture();
  try {
    const first = await r.move();
    await git(r.slot.worktree,['merge','--no-ff','-m','writer merged trunk',first]);
    const s = await r.state(), merged = await revParse(r.slot.worktree,'HEAD');
    // A candidate recorded before SB1 can contain merged trunk commits; executor apply must not replay them.
    const {candidateFacts} = await import('../src/git.ts');
    const facts = await candidateFacts(r.cwd,s.plan,s.plan.nodes[0]!,r.submitted.facts.base,merged,1);
    await r.ledger.withLock(()=>r.ledger.append([{kind:'submit',by:'writer:a#1',node:'a',attempt:1,facts}]));
    const target = await commitAt(r.cwd,{'next-trunk.txt':'next\n'}); await ops.adopt({cwd:r.cwd,as:owner,channel:'delegated',note:'advance past merged trunk'});
    const result = await ops.rebase({cwd:r.cwd,as:parent,node:'a',apply:true});
    assert.equal(result.applied,true,result.error); assert.equal(await isAncestor(r.cwd,target,await revParse(r.slot.worktree,'HEAD')),true);
    assert.deepEqual((await git(r.slot.worktree,['diff','--name-only',`${target}..HEAD`])).stdout.trim().split('\n'),['a.txt']);
    assert.equal((await git(r.slot.worktree,['log','--format=%s',`${target}..HEAD`])).stdout.trim().split('\n').length,1,'only writer commit is replayed');
    const {rebaseRecovery} = await import('../src/rebase-view.ts');
    assert.ok(rebaseRecovery('moved',merged,false,target,'a')!.includes(`git reset --hard ${merged}\`, then \`git rebase --onto ${target} $(git merge-base HEAD ${target})`));
  } finally {await r.cleanup();}
});

test('ER2: conflicts abort to the exact HEAD/tree and retain the writer fallback with file names', {timeout:120_000}, async () => {
  const r = await fixture({launch:true});
  try {
    await r.reviewAll(); await r.move(true); const tree = (await git(r.slot.worktree,['rev-parse','HEAD^{tree}'])).stdout;
    const result = await ops.rebase({cwd:r.cwd,as:driverActor,node:'a',apply:true,automatic:true,writerIdle:async()=>true});
    assert.equal(result.applied,false); assert.deepEqual(result.conflicts,['a.txt']); assert.equal(await revParse(r.slot.worktree,'HEAD'),r.oldCommit); assert.equal(await isClean(r.slot.worktree),true); assert.equal((await git(r.slot.worktree,['rev-parse','HEAD^{tree}'])).stdout,tree);
    // inspect the pure decision before delivery to prove the route, without starting a second writer.
    const s = await r.state(), actions = decide(s,s.plan,new Map([[r.writerRid!,{rid:r.writerRid!,state:'sealed',status:'ok'}]]),{max:1,repairs:2,project:projectId(s),root:r.cwd,applied:new Set(),rejected:new Map(),conflicts:new Map([['a',result.conflicts!]])});
    assert.ok(actions[0]?.do==='send'&&actions[0].reason==='rebase'); assert.match(actions[0].message,/a\.txt/);
    assert.equal((await r.ledger.read()).filter(e=>e.kind==='submit'&&e.by==='executor:owed').length,0);
    assert.equal((await ops.verify({cwd:r.cwd})).ok,true);
  } finally {await r.cleanup();}
});

test('ER2: a live/unknown writer never permits --apply; the automatic route remains writer-owned', {timeout:120_000}, async () => {
  const r = await fixture({launch:true});
  try {await r.reviewAll(); await r.move(); const length = (await r.ledger.read()).length; await assert.rejects(ops.rebase({cwd:r.cwd,as:driverActor,node:'a',apply:true,writerIdle:async()=>false}),/live, unknown/); assert.equal((await r.ledger.read()).length,length); const rb = await ops.rebase({cwd:r.cwd,as:driverActor,node:'a',apply:true,automatic:true,writerIdle:async()=>false}); assert.equal(rb.applied,undefined); assert.equal(await revParse(r.slot.worktree,'HEAD'),r.oldCommit);} finally {await r.cleanup();}
});

test('ER2: later repair tells the writer to continue from executor-rebased HEAD', {timeout:120_000}, async () => {
  const r = await fixture({launch:true});
  try {await r.reviewAll(); await r.move(); await ops.rebase({cwd:r.cwd,as:driverActor,node:'a',apply:true,writerIdle:async()=>true}); const s = await r.state(); const a = decide(s,s.plan,new Map([[r.writerRid!,{rid:r.writerRid!,state:'sealed',status:'ok'}]]),{max:1,repairs:2,project:projectId(s),root:r.cwd,applied:new Set(),rejected:new Map()}); assert.ok(a.some(x=>x.do==='attest')); await ops.review({cwd:r.cwd,as:{role:'reviewer',id:'blocker'},node:'a',verdict:'block',rank:1,note:'repair this'}); await ops.attest({cwd:r.cwd,node:'a'}); const failed = await r.state(); const follow = decide(failed,failed.plan,new Map([[r.writerRid!,{rid:r.writerRid!,state:'sealed',status:'ok'}]]),{max:1,repairs:2,project:projectId(failed),root:r.cwd,applied:new Set(),rejected:new Map()}); assert.ok(follow[0]?.do==='send',JSON.stringify(follow)); assert.match(follow[0].message,/owed rebased your worktree onto .*\(clean\); continue from HEAD/);} finally {await r.cleanup();}
});

test('ER2: explicit apply with recorded running/sealed writer refuses/succeeds through CLI', {timeout:120_000}, async () => {
  const r = await fixture({launch:true}), prior = process.env.OWED_DSA;
  try {
    await r.reviewAll(); await r.move();
    const fake = join(r.root,'describe-dsa');
    const script = (state:string) => `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify({state,status:'ok',calls:[{gen:1,status:'ok'}]})}'\n`;
    await writeFile(fake,script('running')); await chmod(fake,0o755); process.env.OWED_DSA=fake;
    const count = (await r.ledger.read()).length;
    let reply = await cli(r.cwd,['rebase','a','--apply']); assert.notEqual(reply.code,0); assert.match(reply.stderr,/live, unknown/); assert.equal((await r.ledger.read()).length,count);
    await writeFile(fake,script('sealed'));
    reply = await cli(r.cwd,['rebase','a','--apply']); assert.equal(reply.code,0,reply.stderr); assert.equal((await r.ledger.read()).at(-1)?.kind,'submit'); assert.equal(await isClean(r.slot.worktree),true);
  } finally {if (prior===undefined) delete process.env.OWED_DSA; else process.env.OWED_DSA=prior; await r.cleanup();}
});

test('ER2: writer intents serialize behind the rebase op lock and stop another automatic apply', {timeout:120_000}, async () => {
  const r = await fixture({launch:true});
  let release!: () => void;
  try {
    await r.reviewAll(); await r.move();
    let entered!: () => void;
    const inside = new Promise<void>(resolve=>entered=resolve), held = new Promise<void>(resolve=>release=resolve);
    const applying = ops.rebase({cwd:r.cwd,as:driverActor,node:'a',apply:true,automatic:true,writerIdle:async()=>{entered(); await held; return true;}});
    await inside;
    let sent = false;
    const sending = ops.send({cwd:r.cwd,as:driverActor,node:'a',attempt:1,rid:r.writerRid!,sendKind:'follow-up',reason:'repair',message:'continue',rulings:0}).then(e=>{sent=true;return e;});
    await new Promise(resolve=>setTimeout(resolve,30)); assert.equal(sent,false,'send intent cannot append while rebase owns the op lock');
    release(); const result = await applying, send = await sending;
    assert.equal(result.applied,true); assert.equal(send.seq,result.submit!.seq+1);
    await commitAt(r.cwd,{'next-trunk.txt':'move again\n'}); await ops.adopt({cwd:r.cwd,as:owner,channel:'delegated',note:'another move'});
    const rb = await ops.rebase({cwd:r.cwd,as:driverActor,node:'a',apply:true,automatic:true,writerIdle:async()=>true});
    assert.equal(rb.applied,undefined,'pending writer follow-up forces writer route');
  } finally {release?.(); await r.cleanup();}
});

test('ER2: dirty/noncandidate/in-progress slots use the writer route without touching work', {timeout:120_000}, async () => {
  for (const mode of ['dirty','head','in-progress']) {
    const r = await fixture({launch:true});
    try {
      await r.reviewAll(); await r.move();
      if (mode==='dirty') await writeFile(join(r.slot.worktree,'untracked'),'keep');
      if (mode==='head') await commitAt(r.slot.worktree,{});
      let leftover: string | undefined;
      if (mode==='in-progress') {leftover=(await git(r.slot.worktree,['rev-parse','--git-path','rebase-merge'])).stdout.trim(); await mkdir(leftover,{recursive:true});}
      const before = await revParse(r.slot.worktree,'HEAD');
      const result = await ops.rebase({cwd:r.cwd,as:driverActor,node:'a',apply:true,automatic:true,writerIdle:async()=>true});
      assert.equal(result.applied,undefined,mode); assert.equal(await revParse(r.slot.worktree,'HEAD'),before);
      if (mode==='in-progress') assert.match(result.packet,/in progress; run `git rebase --abort`/);
      if (mode==='head') assert.match(result.packet,new RegExp(`HEAD differs from last submitted candidate ${r.oldCommit.slice(0,12)}.*git reset --hard ${r.oldCommit}`));
      if (leftover) await rm(leftover,{recursive:true});
    } finally {await r.cleanup();}
  }
});

test('ER2: an executor Git error aborts/restores without recording executor submit', {timeout:120_000}, async () => {
  const r = await fixture({launch:true});
  try {
    await r.reviewAll(); await r.move();
    const hook = (await git(r.slot.worktree,['rev-parse','--git-path','hooks/pre-rebase'])).stdout.trim();
    await writeFile(hook,'#!/bin/sh\nexit 1\n'); await chmod(hook,0o755);
    const result = await ops.rebase({cwd:r.cwd,as:driverActor,node:'a',apply:true,automatic:true,writerIdle:async()=>true});
    assert.equal(result.applied,false); assert.equal(result.submit,undefined); assert.equal(await revParse(r.slot.worktree,'HEAD'),r.oldCommit); assert.equal(await isClean(r.slot.worktree),true);
    await rm(hook);
  } finally {await r.cleanup();}
});

for (const leftover of [false,true]) test(`ER2: ${leftover ? 'crash leftover' : 'aligned unsubmitted rebase'} sends one keep/reset/abort writer follow-up without executor action`, {timeout:120_000}, async () => {
  const r = await fixture({launch:true});
  class AppliedDsa extends SealedDsa {
    messages: string[] = [];
    override async send(_id:string,_to:string,_kind:unknown,message:string|Uint8Array) {this.messages.push(Buffer.from(message).toString()); return {outcome:'applied' as const,spec_digest:'fixture'};}
    override async request() {return {state:'applied' as const};}
  }
  try {
    await r.reviewAll(); await r.move(); const rb = await ops.rebase({cwd:r.cwd,as:parent,node:'a'});
    let path: string | undefined;
    if (leftover) {path=(await git(r.slot.worktree,['rev-parse','--git-path','rebase-merge'])).stdout.trim(); await mkdir(path,{recursive:true});}
    else await git(r.slot.worktree,['rebase','--onto',rb.base,rb.from]);
    const dsa = new AppliedDsa(), driver = new Driver({cwd:r.cwd,dsa,log:()=>{},session:null});
    const first = await driver.pass(); assert.ok(first.actions.some(a=>a.do==='send'&&a.reason==='rebase'),JSON.stringify(first.actions));
    assert.equal(first.actions.some(a=>a.do==='rebase'),false); assert.equal(dsa.messages.length,1);
    if (leftover) assert.match(dsa.messages[0]!,/in progress; run `git rebase --abort`/);
    else {assert.match(dsa.messages[0]!,new RegExp(`HEAD differs from last submitted candidate ${r.oldCommit.slice(0,12)}; keep:.*git log ${rb.base}\\.\\.HEAD.*owed submit a.*reset:.*git reset --hard ${r.oldCommit}`)); assert.equal((await ops.status({cwd:r.cwd})).rebasePending,undefined);}
    const second = await driver.pass(); assert.equal(second.actions.some(a=>a.do==='send'||a.do==='rebase'),false); assert.equal(dsa.messages.length,1);
    assert.equal((await r.ledger.read()).filter(e=>e.kind==='submit'&&e.by==='executor:owed').length,0);
    if (path) await rm(path,{recursive:true});
  } finally {await r.cleanup();}
});

test('ER2: stale ledger after Git rebases rolls back without executor submit', {timeout:120_000}, async () => {
  const r = await fixture({launch:true});
  try {
    await r.reviewAll(); await r.move(); const length = (await r.ledger.read()).length;
    await assert.rejects(ops.rebase({cwd:r.cwd,as:driverActor,node:'a',since:length-1,apply:true,automatic:true,writerIdle:async()=>{
      await ops.rule({cwd:r.cwd,as:parent,nodes:['a'],text:'new requirement during executor prepare'}); return true;
    }}),/stale|changed; retry/);
    assert.equal(await revParse(r.slot.worktree,'HEAD'),r.oldCommit); assert.equal(await isClean(r.slot.worktree),true);
    assert.equal((await r.ledger.read()).filter(e=>e.seq>=length&&e.kind==='submit').length,0);
  } finally {await r.cleanup();}
});

test('ER2: op lock timeout yields driver retry, never halt', {timeout:120_000}, async () => {
  const r = await fixture({launch:true}), prior=lockWait.ms;
  try {
    await r.reviewAll();
    const s=await r.state(), plan=structuredClone(s.plan); plan.nodes[0]!.deps=['b']; plan.nodes.push({id:'b',deps:[],writes:['trunk.txt'],checks:[],review:{count:0,min_rank:1}});
    await ops.planSet({cwd:r.cwd,as:parent,plan:JSON.stringify(plan)});
    await ops.submit({cwd:r.slot.worktree,as:writer,node:'a'}); await ops.attest({cwd:r.cwd,node:'a'});
    const b=await ops.dispatch({cwd:r.cwd,as:parent,node:'b'}); await commitAt(b.worktree,{'trunk.txt':'dependency\n'});
    await ops.submit({cwd:b.worktree,as:{role:'writer',id:'b#1'},node:'b'}); await ops.attest({cwd:r.cwd,node:'b'}); await ops.merge({cwd:r.cwd,as:parent,node:'b'});
    const driver = new Driver({cwd:r.cwd,dsa:new SealedDsa(),log:()=>{},session:null});
    lockWait.ms=30;
    await r.ledger.withLock(async()=>{
      await assert.rejects(ops.rebase({cwd:r.cwd,as:driverActor,node:'a',apply:true,automatic:true,writerIdle:async()=>true}),e=>(e as {code?:string}).code==='busy');
      const reply = await driver.pass(); assert.ok(reply.actions.some(a=>a.do==='rebase'&&a.outcome==='retry'),JSON.stringify(reply.actions)); assert.equal(reply.actions.some(a=>a.do==='halt'),false);
    },ops.slotOperationLock('a'));
  } finally {lockWait.ms=prior; await r.cleanup();}
});

test('ER3: replay refuses forged carry/principal/base/ancestor markers and nonadjacent executor submissions', {timeout:120_000}, async () => {
  const r = await fixture();
  try {
    await r.reviewAll(); await r.move(); const rb = await ops.rebase({cwd:r.cwd,as:parent,node:'a'});
    await git(r.slot.worktree,['rebase','--onto',rb.base,rb.from]);
    const facts = {...r.submitted.facts,commit:await revParse(r.slot.worktree,'HEAD'),base:rb.base,rebased:true as const,carry:{from:r.oldCommit,reviews:r.reviews.map(e=>e.seq)}};
    const s = await r.state(), good: Draft = {kind:'submit',by:'executor:owed',node:'a',attempt:1,facts};
    assert.deepEqual(validateDraft(s,good),[]);
    const bad = [
      {...good,by:'executor:other'}, {...good,by:'writer:a#1'}, {...good,attempt:2},
      {...good,facts:{...facts,rebased:false}}, {...good,facts:{...facts,rebased:undefined}}, {...good,facts:{...facts,base:r.submitted.facts.base}},
      {...good,facts:{...facts,carry:{...facts.carry,from:rb.base}}}, {...good,facts:{...facts,carry:{...facts.carry,reviews:[rb.entry.seq]}}},
      {...good,facts:{...facts,carry:{...facts.carry,reviews:[r.reviews[0]!.seq]}}}, {...good,facts:{...facts,carry:{...facts.carry,extra:true}}},
      {...good,facts:{...facts,carry:{...facts.carry,reviews:[r.reviews[0]!.seq,r.reviews[0]!.seq]}}},
    ];
    const entries = await r.ledger.read(), plan = s.plan;
    for (const d of bad) {assert.ok(validateDraft(s,d as Draft).length,JSON.stringify(d)); assert.throws(()=>reduce([...entries,{...d,seq:s.seq+1,ts:new Date().toISOString(),prev:s.head,hash:'test'} as Entry],()=>plan),/invalid:/);}
    await ops.rule({cwd:r.cwd,as:parent,nodes:['a'],text:'between receipts'});
    assert.match(validateDraft(await r.state(),good).join('; '),/immediately follow/);
    assert.equal((await ops.verify({cwd:r.cwd})).ok,true);
  } finally {await r.cleanup();}
});
