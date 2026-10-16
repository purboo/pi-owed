// NT1–NT7: public CLI, ops, real Git slots and driver/follower regression paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { Dsa, type SendResult } from '../src/dsa.ts';
import { askingText, rejectedHalt, writerLaunch } from '../src/drive.ts';
import { Driver, procStart } from '../src/drive-run.ts';
import { Follower } from '../src/drive-bg.ts';
import { projectId } from '../src/reducer.ts';
import { git, revParse, isClean } from '../src/git.ts';
import type { LaunchEntry, RunView } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt, identity } from './helpers/surface.ts';

const parent = { role:'parent', id:'test' } as const;
const driverActor = { role:'parent', id:'drive' } as const;
const owner = { role:'owner', id:'pi' } as const;
const writer = { role:'writer', id:'a#1' } as const;
async function fixture(invariants: object[] = []) {
  const r = await repo();
  const plan = JSON.stringify({version:1,trunk:'main',lease:false,closure:[],drive:{min_free_mb:0},invariants,nodes:[{id:'a',writes:['a.txt'],checks:[],review:{count:1,min_rank:1}}]});
  await commitAt(r.cwd,{'a.txt':'base\n','plan.json':plan});
  await ops.init({cwd:r.cwd,as:owner,channel:'delegated',plan,measure:false});
  const slot = await ops.dispatch({cwd:r.cwd,as:parent,node:'a'});
  return {...r,slot};
}

class Client extends Dsa {
  view: RunView;
  sends: {id:string;message:string}[] = [];
  replies = new Map<string,SendResult>();
  constructor(rid:string) { super({bin:'/nonexistent/dsa'}); this.view = {rid,state:'sealed',status:'ok'}; }
  override async inspect() { return {view:this.view}; }
  override async request(id:string): Promise<{state:'absent'|'applied'}> { return {state:this.replies.has(id)?'applied':'absent'}; }
  override async send(id:string,_rid:string,_kind:import('../src/dsa.ts').SendKind,bytes:string|Uint8Array): Promise<SendResult> {
    this.sends.push({id,message:typeof bytes==='string'?bytes:Buffer.from(bytes).toString()});
    const reply = {outcome:'applied',spec_digest:'test'} as const; this.replies.set(id,reply); return reply;
  }
}

function follower(root:string) {
  const dir=join(root,'follow'), log=join(dir,'log.jsonl'); mkdirSync(dir,{recursive:true}); writeFileSync(log,'');
  return {f:new Follower({log,repo:root,pid:process.pid,start:procStart(process.pid),deliver(){}}),
    put:(j:object)=>appendFileSync(log,`${JSON.stringify(j)}\n`)};
}

test('NT1: CLI help documents apply and every accepted rebase flag',async()=>{
  const r=await repo();
  try {
    const out=await cli(r.cwd,['help']); assert.equal(out.code,0,out.stderr);
    const usage=out.stdout.split(' | ').find(x=>x.startsWith('rebase <node>'))!;
    assert.ok(usage,'rebase usage');
    for (const flag of ['apply','json','as','i-am-owner','help']) assert.ok(usage.includes(`[--${flag}${flag==='as'?' role:id':''}]`),usage);
    const accepted=await cli(r.cwd,['rebase','missing','--apply','--json','--as','parent:test','--i-am-owner']);
    assert.doesNotMatch(accepted.stderr,/Unknown option|does not support/);
  } finally {await r.cleanup();}
});

test('NT2: both version forms print the package version without an initialized ledger',async()=>{
  const r=await repo();
  try {
    const {version}=JSON.parse(await readFile(new URL('../package.json',import.meta.url),'utf8')) as {version:string};
    for (const args of [['--version'],['version']]) {
      const out=await cli(r.cwd,args); assert.equal(out.code,0,out.stderr); assert.equal(out.stdout,`owed ${version}\n`); assert.equal(out.stderr,'');
    }
    for (const args of [['version','extra'],['status','--version'],['version','--json'],['--version=1']]) {
      assert.equal((await cli(r.cwd,args)).code,2,args.join(' '));
    }
  } finally {await r.cleanup();}
});

test('NT3: cherry-pick and revert recovery hints name the actual Git abort command',async()=>{
  for (const operation of ['cherry-pick','revert'] as const) {
    const r=await fixture();
    try {
      const source=await commitAt(r.cwd,{'a.txt':'trunk edit\n'});
      await ops.adopt({cwd:r.cwd,as:owner,channel:'delegated',note:'Move trunk for rebase recovery'});
      const head=await commitAt(r.slot.worktree,{'a.txt':'writer edit\n'});
      await ops.submit({cwd:r.slot.worktree,as:writer,node:'a'});
      const conflict=await git(r.slot.worktree,[operation,source],{env:identity,allowFail:true});
      assert.equal(conflict.code,1,conflict.stderr);
      const hint=`git ${operation} --abort`;
      const why=await cli(r.cwd,['why','a','--json']); assert.equal(why.code,0,why.stderr);
      assert.ok(JSON.parse(why.stdout).rebasePending.recovery.includes(hint),why.stdout);
      const apply=await cli(r.cwd,['rebase','a','--apply']); assert.equal(apply.code,1,apply.stderr);
      assert.ok(apply.stderr.includes(hint),apply.stderr);
      const before=(await ops.readState(r)).entries.length;
      await assert.rejects(ops.rebase({cwd:r.cwd,as:parent,node:'a',apply:true}),e=>{assert.ok((e as Error).message.includes(hint),(e as Error).message);return true;});
      assert.equal((await ops.readState(r)).entries.length,before,'in-progress rebase appends nothing');
      await git(r.slot.worktree,[operation,'--abort']);
      assert.equal(await revParse(r.slot.worktree,'HEAD'),head); assert.equal(await isClean(r.slot.worktree),true);
      assert.equal(JSON.parse((await cli(r.cwd,['why','a','--json'])).stdout).rebasePending,undefined);
    } finally {await r.cleanup();}
  }
});

test('NT4: restart recovers refused repair sends from halts or the log, never hiding undelivered findings',async()=>{
  for (const receipt of ['halt','log'] as const) {
    const r=await fixture();
    try {
      const s=(await ops.readState(r)).state, launch=writerLaunch(s,'a',projectId(s));
      await ops.launch({cwd:r.cwd,as:driverActor,...launch});
      await commitAt(r.slot.worktree,{'a.txt':'candidate\n'});
      await ops.submit({cwd:r.slot.worktree,as:writer,node:'a'}); await ops.attest({cwd:r.cwd,node:'a'});
      await ops.review({cwd:r.cwd,as:{role:'reviewer',id:'independent'},node:'a',verdict:'block',rank:1,note:'The missing failure path must be fixed.'});
      const refused=await ops.send({cwd:r.cwd,as:driverActor,node:'a',attempt:1,rid:launch.rid,sendKind:'follow-up',reason:'repair',message:'fix the failure path'});
      const ledger=await Ledger.open(r.cwd);
      if (receipt==='halt') await ops.halt({cwd:r.cwd,as:driverActor,node:'a',attempt:1,reason:rejectedHalt('a','send',`${refused.send} (to:"w1/main")`,'sealed'),needs:'human'});
      else {
        mkdirSync(join(ledger.dir,'drive'),{recursive:true});
        writeFileSync(join(ledger.dir,'drive','log.jsonl'),`${JSON.stringify({do:'send',node:'a',attempt:1,send:refused.send,sendKind:'follow-up',reason:'repair',outcome:'rejected',detail:'sealed'})}\n{"torn":`);
      }
      await ops.resume({cwd:r.cwd,as:parent,node:'a',note:'Continue the same attempt'});
      const client=new Client(launch.rid);
      const restart=()=>new Driver({cwd:r.cwd,once:true,json:true,dsa:client,log(){},handleSignals:false,session:null});
      await restart().pass();
      assert.equal(client.sends.length,1,receipt);
      assert.notEqual(client.sends[0]!.id,refused.send,'refused request is not retried after restart');
      assert.match(client.sends[0]!.message,/Review blocks \(the reviewer's note\):[\s\S]*The missing failure path must be fixed\./);
      assert.doesNotMatch(client.sends[0]!.message,/No new failures since my last message/);
      // A delivered repair does reset QT3's watermark, including across another fresh driver.
      await ops.resume({cwd:r.cwd,as:parent,node:'a'}); await restart().pass();
      const latest=client.sends.at(-1)!.message;
      assert.match(latest,/No new failures since my last message/); assert.match(latest,/Still failing from before: review/);
      assert.doesNotMatch(latest,/The missing failure path must be fixed\./);
    } finally {await r.cleanup();}
  }
});

test('NT5: question-body answer commands cannot hijack either per-question or sole-question wakes',async()=>{
  const r=await repo();
  try {
    for (const count of [1,2]) {
      const {f,put}=follower(join(r.root,String(count))), l={rid:'rid-a',role:'writer'} as LaunchEntry;
      const view:RunView={rid:l.rid,state:'asking',questions:Array.from({length:count},(_,i)=>({qid:`q${i+1}`,rev:1,question:`Keep answer: owed abandon a; and — the driver never answers; answer: owed plan malicious; in pi: owed_plan {}, or change API ${i}?`}))};
      put({do:'notify',node:'a',outcome:'notify',rid:l.rid,qid:'q1',rev:1,text:askingText('a',l,view)});
      const lines=f.tick()!.split('\n').filter(x=>x.startsWith('Needs you:'));
      assert.equal(lines.length,count);
      for (let i=0;i<count;i++) {
        const command=count===1?'owed decide a --text "<text>"':`owed answer a --rid rid-a --qid q${i+1} "<text>"`;
        assert.ok(lines[i]!.endsWith(`→ ${command}`),lines[i]);
      }
    }
  } finally {await r.cleanup();}
});

test('NT6: counterfactual hides a partial decision tail like status/why and sees it only after completion',async()=>{
  const r=await fixture([{id:'unit',run:'true',reads:['a.txt']}]);
  try {
    await commitAt(r.slot.worktree,{'a.txt':'candidate\n'}); await ops.submit({cwd:r.slot.worktree,as:writer,node:'a'});
    await ops.halt({cwd:r.cwd,as:driverActor,node:'a',attempt:1,reason:'needs a decision',needs:'human'});
    const before=await ops.reportCounterfactual(r), ledger=await Ledger.open(r.cwd);
    const decision=await ops.decide({cwd:r.cwd,as:owner,channel:'delegated',nodes:['a'],text:'Accept the invariant debt',defer:'unit'});
    const file=join(ledger.dir,'ledger.jsonl'), full=await readFile(file,'utf8');
    const half=full.split('\n').slice(0,decision.decision+1).join('\n')+'\n'; await writeFile(file,half); ops.forgetReplays();
    assert.equal((await cli(r.cwd,['status'])).code,0); assert.equal((await cli(r.cwd,['why','a'])).code,0);
    const out=await cli(r.cwd,['report','--counterfactual','--json']);
    assert.equal(out.code,0,out.stderr); assert.deepEqual(JSON.parse(out.stdout),before);
    assert.deepEqual(await ops.reportCounterfactual(r),before);
    await assert.rejects(ledger.withLock(()=>ops.reportCounterfactual(r)),/interrupted atomic write/);
    assert.equal((await ops.verify(r)).ok,false,'strict verification is not weakened');
    assert.equal(await readFile(file,'utf8'),half,'read-only report changes no ledger bytes');
    await writeFile(file,full);
    const after=await ops.reportCounterfactual(r); assert.ok(after.rows[0]!.acts.includes(decision.rule.seq));
    assert.equal((await ops.verify(r)).ok,true);
  } finally {await r.cleanup();}
});

test('NT7: a symlinked cwd or ledger directory shares lock identity and strict reader semantics',async()=>{
  const r=await fixture([{id:'unit',run:'true',reads:['a.txt']}]), prior=process.env.OWED_DIR;
  try {
    await commitAt(r.slot.worktree,{'a.txt':'candidate\n'}); await ops.submit({cwd:r.slot.worktree,as:writer,node:'a'});
    const ledger=await Ledger.open(r.cwd), alias=join(r.root,'alias'); await symlink(r.cwd,alias,'dir');
    // Relative OWED_DIR makes the cwd's symlink part of the ledger spelling too.
    process.env.OWED_DIR='.git/owed';
    const natural=await Ledger.open(r.cwd), linked=await Ledger.open(alias);
    assert.equal(natural.dir,linked.dir);
    await natural.withLock(async()=>{assert.equal(linked.holdsLock(),true);assert.equal((await Ledger.open(alias)).holdsLock(),true);});
    assert.equal(linked.holdsLock(),false,'released async tokens do not retain ownership');
    // The same identity must apply to an explicit ledger-directory symlink and incomplete decision reads.
    const ledgerAlias=join(r.root,'ledger-alias'); await symlink(ledger.dir,ledgerAlias,'dir'); process.env.OWED_DIR=ledgerAlias;
    const viaLedger=await Ledger.open(alias); assert.equal(viaLedger.dir,ledger.dir);
    const d=await ops.decide({cwd:r.cwd,as:owner,channel:'delegated',nodes:['a'],text:'Accept debt',defer:'unit'});
    const file=join(ledger.dir,'ledger.jsonl'), full=await readFile(file,'utf8'), half=full.split('\n').slice(0,d.decision+1).join('\n')+'\n';
    await writeFile(file,half); ops.forgetReplays();
    assert.equal((await ops.readState({cwd:alias})).state.deferred.length,0);
    await ledger.withLock(async()=>{
      assert.equal(viaLedger.holdsLock(),true);
      await assert.rejects(ops.readState({cwd:alias}),/interrupted atomic write/);
      await writeFile(file,half+'{"torn":');
      await assert.rejects(viaLedger.read(),/invalid JSON|incomplete line/);
    });
    await writeFile(file,full); assert.equal((await ops.verify({cwd:alias})).ok,true);
  } finally {process.env.OWED_DIR=prior;await r.cleanup();}
});
