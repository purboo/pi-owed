import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { H, sha256 } from '../src/canon.ts';
import { runJob } from '../src/exec.ts';
import * as ops from '../src/ops.ts';
import * as git from '../src/git.ts';
import * as reducer from '../src/reducer.ts';
import { Ledger } from '../src/ledger.ts';
import { parsePlan } from '../src/plan.ts';
import { renderReceipt, renderStatus } from '../src/views.ts';
import { decide } from '../src/drive.ts';
import { Driver } from '../src/drive-run.ts';
import { Follower, classifyLine, revalidator } from '../src/drive-bg.ts';
import type { Draft, Entry, ObsEntry } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const parent = { role:'parent', id:'fixture' } as const, owner = { role:'owner', id:'fixture' } as const;
const failure = `if grep -q extra value; then echo 'owed-counts {"pass":0,"fail":2,"failed":["old bug","new bug"]}'; else echo 'owed-counts {"pass":0,"fail":1,"failed":["old bug"]}'; fi; exit 1`;
async function fixture(run = failure, min_tests = 1) {
  const r = await repo(), prior = process.env.OWED_DSA;
  process.env.OWED_DSA = join(r.root,'no-dsa');
  try {
    await commitAt(r.cwd,{value:'old', 'check.sh':run});
    const plan = { version:1, trunk:'main', lease:false, closure:[], invariants:[], drive:{min_free_mb:0}, nodes:[{id:'a',writes:['value'],checks:[]}] };
    await ops.init({cwd:r.cwd,plan:JSON.stringify(plan),as:owner,channel:'delegated'});
    const ledger = await Ledger.open(r.cwd), before = (await ops.status({cwd:r.cwd})).trunk;
    const current = {...plan,invariants:[{id:'suite',run:'bash check.sh',timeout_s:1,reads:['value','check.sh'],min_tests}]};
    await ops.planSet({cwd:r.cwd,plan:JSON.stringify(current),as:parent});
    const entries = () => ledger.read();
    const state = async () => {
      const es = await entries(), plans = new Map<string,ReturnType<typeof parsePlan>>();
      for (const e of es) if (e.kind === 'genesis' || e.kind === 'plan') plans.set(e.plan,parsePlan((await ledger.getBlob(e.plan)).toString()));
      return reducer.reduce(es,sha => plans.get(sha)!);
    };
    const candidate = async (value = 'old changed') => {
      const d = await ops.dispatch({cwd:r.cwd,node:'a',as:parent});
      await commitAt(d.worktree,{value});
      await ops.submit({cwd:d.worktree,node:'a',as:{role:'writer',id:'a#1'}});
      assert.equal((await ops.attest({cwd:r.cwd,node:'a'})).accepted,true);
      return d;
    };
    return {...r,ledger,entries,state,before,current,candidate,async cleanup(){ if (prior === undefined) delete process.env.OWED_DSA; else process.env.OWED_DSA=prior; await r.cleanup(); }};
  } catch(e) { if (prior === undefined) delete process.env.OWED_DSA; else process.env.OWED_DSA=prior; await r.cleanup(); throw e; }
}
const refresh = (cwd:string,signal?:AbortSignal) => { assert.equal(typeof ops.attestTrunk,'function'); return ops.attestTrunk({cwd,signal}); };
const opts = (root:string) => ({max:1,repairs:2,project:'fixture',root,applied:new Set<string>(),rejected:new Map<string,string>()});
const named = (): ObsEntry => ({kind:'obs',by:'executor:owed',subject:'trunk',obligation:'inv:suite',key:'k',verdict:'fail',exit:1,counts:{tests:1,pass:0,fail:1,format:'owed'},failed:['old bug'],execution:{completed:true,countOK:true},durationMs:1,commit:'c',base:'c',seq:1,ts:'',prev:'',hash:''});

test('IR1: added invariant has actionable not-measured text before refresh', async () => {
  const r=await fixture(); try {
    const status=await ops.status({cwd:r.cwd});
    assert.equal(status.invariants[0]!.detail,'inv:suite not measured on trunk yet — owed attest --trunk');
    assert.doesNotMatch(renderStatus(status),/missing fact key/);
  } finally { await r.cleanup(); }
});
test('IR1/3: attest --trunk records refresh plus named trunk failure and routes only to parent', async () => {
  const r=await fixture(); try {
    const out=await cli(r.cwd,['attest','--trunk']); assert.equal(out.code,1,out.stderr);
    const es=await r.entries(), entry=es.find(e=>e.kind==='refresh')!;
    assert.equal(entry.by,'executor:owed'); assert.ok(entry.kind==='refresh'); assert.equal(entry.commit,r.before.commit);
    const obs=es.find((e):e is ObsEntry=>e.kind==='obs')!;
    assert.equal(obs.subject,'trunk'); assert.equal(obs.commit,r.before.commit); assert.equal(obs.merging,undefined); assert.equal(obs.key,entry.state.invKeys.suite);
    assert.deepEqual(obs.failed,['old bug']);
    const s=await r.state(); assert.equal(s.trunk.seq,r.before.seq); assert.equal(s.trunk.commit,r.before.commit); assert.equal(s.invariants[0]!.discharger,'parent');
    for (const text of [renderStatus(await ops.status({cwd:r.cwd})),renderReceipt(await ops.why({cwd:r.cwd,node:'trunk'}))]) {
      assert.match(text,new RegExp(`inv:suite red on trunk since refresh #${entry.seq} \\(old bug\\)`)); assert.match(text,/not caused by any open node/); assert.match(text,/owed sweep --commit/);
    }
    const actions=decide(s,s.plan,new Map(),opts(r.cwd)); assert.ok(actions.some(a=>a.do==='notify' && a.invariantRed?.obligation==='inv:suite')); assert.ok(actions.some(a=>a.do==='dispatch' && a.node==='a')); assert.ok(!actions.some(a=>a.do==='halt'));
  } finally { await r.cleanup(); }
});
test('IR1: no-op refresh is idempotent; changed run rekeys and remeasures only changed invariant', async () => {
  const r=await fixture(); try {
    await refresh(r.cwd); const es=await r.entries();
    const no=await refresh(r.cwd); assert.equal(no.refresh,undefined); assert.deepEqual(await r.entries(),es); assert.match(ops.attestTrunkText(no),/Nothing to refresh/);
    await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',note:'fixture changes command',plan:JSON.stringify({...r.current,invariants:[{...r.current.invariants[0]!,run:'bash check.sh # changed'}]})});
    const next=await refresh(r.cwd); assert.deepEqual(next.changed,['suite']); assert.equal(next.observations.length,1); assert.notEqual((await r.state()).trunk.invKeys.suite,(es.find(e=>e.kind==='refresh') as Extract<Entry,{kind:'refresh'}>).state.invKeys.suite);
  } finally { await r.cleanup(); }
});
test('IR2: same named failures merge without defer, retain parent trunk-red debt and merge provenance', async () => {
  const r=await fixture(); try {
    await refresh(r.cwd); await r.candidate();
    const result=await ops.merge({cwd:r.cwd,node:'a',as:parent}); assert.equal(result.entry.kind,'merge');
    const s=await r.state(), i=s.invariants[0]!;
    assert.equal(s.nodes.a!.phase,'merged'); assert.equal(i.status,'D'); assert.equal(i.discharger,'parent'); assert.equal(i.detail,`trunk-red: inv:suite already failed on trunk before a (old bug); merge #${result.entry.seq}`);
    assert.ok(!(await r.entries()).some(e=>e.kind==='defer')); assert.match(renderStatus(await ops.status({cwd:r.cwd})),new RegExp(`red on trunk since merge #${result.entry.seq}`));
    assert.equal((await ops.verify({cwd:r.cwd})).ok,true);
    const es=await r.entries(), plans=new Map<string,ReturnType<typeof parsePlan>>();
    for(const e of es) if(e.kind==='genesis' || e.kind==='plan') plans.set(e.plan,parsePlan((await r.ledger.getBlob(e.plan)).toString()));
    const replayed=reducer.unpackState(structuredClone(reducer.packState(s)),sha=>plans.get(sha)!); assert.ok(reducer.sameReplay(s,replayed));
  } finally { await r.cleanup(); }
});
test('IR2: added failed name is refused naming only the new failure in its reason', async () => {
  const r=await fixture(); try {
    await refresh(r.cwd); await r.candidate('extra');
    await assert.rejects(ops.merge({cwd:r.cwd,node:'a',as:parent}),/invariant suite new debt: new failures new bug \(trunk already failed: old bug\)/);
    assert.equal((await r.state()).trunk.commit,r.before.commit); assert.ok(!(await r.entries()).some(e=>e.kind==='merge'));
  } finally { await r.cleanup(); }
});
test('IR1b: merge refreshes by itself and keeps refresh observations on refusal', async () => {
  const r=await fixture(); try {
    await r.candidate('extra'); await assert.rejects(ops.merge({cwd:r.cwd,node:'a',as:parent}),/new failures new bug/);
    const es=await r.entries(), entry=es.find(e=>e.kind==='refresh')!;
    const baseline=es.find((e):e is ObsEntry=>e.kind==='obs' && e.subject==='trunk' && e.merging===undefined)!;
    assert.ok(entry); assert.ok(baseline.seq>entry.seq); assert.equal(baseline.commit,r.before.commit);
    assert.ok(es.some(e=>e.kind==='obs' && e.merging==='a' && e.seq>baseline.seq));
  } finally { await r.cleanup(); }
});
test('IR2 predicate: only named test failures qualify; timeout, errors, unknown/zero counts and min_tests do not', () => {
  assert.equal(typeof reducer.testOnlyFailure,'function'); assert.equal(reducer.testOnlyFailure(named()),true);
  for (const patch of [{verdict:'error'},{failed:[]},{exit:null},{exit:124},{counts:undefined},{counts:{tests:0,fail:1}},{counts:{tests:1,fail:0}},{execution:undefined},{execution:{completed:true,countOK:false}},{execution:{completed:false,countOK:true}}] as Partial<ObsEntry>[]) assert.equal(reducer.testOnlyFailure({...named(),...patch}),false,JSON.stringify(patch));
  assert.equal(reducer.testOnlyFailure({...named(),note:'failed tests: old bug; last output:\ntimeout is just diagnostic output'}),true);
  assert.equal(reducer.testOnlyFailure({...named(),failed:['timeout; case'],note:'failed tests: timeout; case; last output:\nnot ok'}),true);
  assert.equal(reducer.testOnlyFailure({...named(),failed:['timeout; case'],execution:{completed:true,countOK:false},note:'failed tests: timeout; case; min_tests unmet: counted 1 < min_tests 2; last output:\nnot ok'}),false);
  assert.equal(reducer.testOnlyFailure({...named(),runs:[{verdict:'fail',exit:1,counts:{tests:1,fail:1},failed:['old bug'],log:'l',durationMs:1,execution:{completed:true,countOK:false},note:'min_tests unmet: counted 1 < min_tests 2'}]}),false);
});
test('IR4: anonymous, timed-out and below-min_tests failures keep ordinary merge refusal', async () => {
  for (const [run,min] of [[`echo '# tests 1'; echo '# fail 1'; exit 1`,1],[`${failure.replace('exit 1','sleep 3; exit 1')}`,1],[failure,2]] as const) {
    const r=await fixture(run,min); try {
      await refresh(r.cwd); await r.candidate(); await assert.rejects(ops.merge({cwd:r.cwd,node:'a',as:parent}),/invariant suite new debt: requires a measured pass/);
    } finally { await r.cleanup(); }
  }
});
test('IR1: reducer refuses stale commit, non-executor, missing keys and mismatched facts', async () => {
  const r=await fixture(); try {
    const s=await r.state(), facts=await git.stateFacts(r.cwd,s.plan,s.trunk.commit);
    const good:Draft={kind:'refresh',by:'executor:owed',commit:s.trunk.commit,state:facts}; assert.deepEqual(reducer.validateDraft(s,good),[]);
    for (const bad of [{...good,commit:'stale'},{...good,by:'parent:fixture'},{...good,state:{...facts,invKeys:{}}},{...good,state:{...facts,tree:'bad'}}]) assert.ok(reducer.validateDraft(s,bad).length);
    const es = await r.entries();
    assert.throws(()=>reducer.reduce([...es,{...good,commit:'stale',seq:s.seq+1,ts:'',prev:s.head,hash:''} as Entry],()=>s.plan),/refresh commit must be the current ledger trunk/);
  } finally { await r.cleanup(); }
});
test('IR1c/3: quiet driver refreshes, wakes once per invariant/key, and never halts an open node', async () => {
  const r=await fixture(); try {
    await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',note:'fixture removes ready node for idle pass',plan:JSON.stringify({...r.current,nodes:[]})});
    const lines:string[]=[], d=new Driver({cwd:r.cwd,json:true,log:l=>lines.push(l),handleSignals:false});
    await d.pass(); await d.settle(); await d.pass(); await d.pass();
    const notices=lines.map(l=>JSON.parse(l)).filter(l=>l.do==='notify' && l.invariantRed?.obligation==='inv:suite'); assert.equal(notices.length,1); assert.match(notices[0].text,/red on trunk since refresh/);
    assert.equal((await r.entries()).filter(e=>e.kind==='refresh').length,1); assert.equal((await r.entries()).filter(e=>e.kind==='halt').length,0);
  } finally { await r.cleanup(); }
});
test('IR1: abort retains refresh, records no interrupted observation, and retry resumes it', async () => {
  const r=await fixture(); const ac=new AbortController(); let running:Promise<unknown>|undefined;
  try {
    const marker=join(r.root,'started'), gate=join(r.root,'gate');
    await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',note:'fixture changes command timeout',plan:JSON.stringify({...r.current,invariants:[{...r.current.invariants[0]!,run:`touch '${marker}'; for ((i=0;i<150;i++)); do test -e '${gate}' && break; sleep .02; done; bash check.sh`,timeout_s:5}]})});
    running=refresh(r.cwd,ac.signal); running.catch(()=>{});
    const deadline=Date.now()+5000; while(!existsSync(marker)) { assert.ok(Date.now()<deadline,'check starts'); await new Promise(r=>setTimeout(r,20)); }
    ac.abort(); await assert.rejects(running,(e:Error & {code?:string})=>e.code==='aborted');
    const count=(await r.entries()).filter(e=>e.kind==='obs').length;
    await writeFile(gate,''); const retry=await refresh(r.cwd); assert.equal(retry.refresh,undefined); assert.equal(retry.observations.length,1); assert.equal((await r.entries()).filter(e=>e.kind==='obs').length,count+1);
  } finally { ac.abort(); await running?.catch(()=>{}); await r.cleanup(); }
});
test('IR1: plan edits while refresh measures discard the stale observation and retry new keys', async () => {
  const r=await fixture(), ac=new AbortController(); let running:Promise<unknown>|undefined;
  try {
    const marker=join(r.root,'stale-started'), gate=join(r.root,'stale-gate');
    const slow={...r.current,invariants:[{...r.current.invariants[0]!,run:`touch '${marker}'; for ((i=0;i<150;i++)); do test -e '${gate}' && break; sleep .02; done; bash check.sh`,timeout_s:5}]};
    await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',note:'fixture slow check',plan:JSON.stringify(slow)});
    running=refresh(r.cwd,ac.signal); running.catch(()=>{});
    const deadline=Date.now()+5000; while(!existsSync(marker)) { assert.ok(Date.now()<deadline,'check starts'); await new Promise(r=>setTimeout(r,20)); }
    await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',note:'fixture replaces running command',plan:JSON.stringify({...r.current,invariants:[{...r.current.invariants[0]!,run:'bash check.sh # newer'}]})});
    await writeFile(gate,''); const out=await running as ops.AttestTrunkResult;
    assert.equal(out.observations.length,0); assert.equal(out.superseded.length,1);
    const retry=await refresh(r.cwd); assert.equal(retry.observations.length,1); assert.ok(retry.refresh);
  } finally { ac.abort(); await running?.catch(()=>{}); await r.cleanup(); }
});
test('IR3: unchanged invariant keys carry lineage across another merge without losing parent routing', async () => {
  const r=await fixture(); try {
    await refresh(r.cwd); await r.candidate(); const first=await ops.merge({cwd:r.cwd,node:'a',as:parent});
    await ops.planSet({cwd:r.cwd,as:parent,plan:JSON.stringify({...r.current,nodes:[...r.current.nodes,{id:'b',writes:['other'],checks:[]}]})});
    const b=await ops.dispatch({cwd:r.cwd,node:'b',as:parent}); await commitAt(b.worktree,{other:'unrelated'});
    await ops.submit({cwd:b.worktree,node:'b',as:{role:'writer',id:'b#1'}}); await ops.attest({cwd:r.cwd,node:'b'}); await ops.merge({cwd:r.cwd,node:'b',as:parent});
    const status=await ops.status({cwd:r.cwd}); assert.equal(status.invariants[0]!.discharger,'parent'); assert.match(status.trunkRed![0]!.text,new RegExp(`since merge #${first.entry.seq}`));
  } finally { await r.cleanup(); }
});
test('IR4: owner defer still permits new invariant failure and keeps visible owner debt', async () => {
  const r=await fixture(); try {
    await refresh(r.cwd); await r.candidate('extra');
    await assert.rejects(ops.merge({cwd:r.cwd,node:'a',as:parent}),/new failures new bug/);
    const fail=(await r.entries()).findLast((e):e is ObsEntry=>e.kind==='obs' && e.merging==='a')!;
    await ops.defer({cwd:r.cwd,node:'a',as:owner,channel:'delegated',reason:'fixture consciously accepts new failure',items:[{id:'suite',key:fail.key}]});
    await ops.merge({cwd:r.cwd,node:'a',as:parent}); const i=(await r.state()).invariants[0]!;
    assert.equal(i.status,'D'); assert.equal(i.mark,'⏸'); assert.equal(i.discharger,'owner');
  } finally { await r.cleanup(); }
});
test('IR1: an unchanged invariant definition/key adds no refresh entries or remeasurement', async () => {
  const r=await fixture(); try {
    await refresh(r.cwd); const before=await r.entries();
    await ops.planSet({cwd:r.cwd,as:parent,plan:JSON.stringify({...r.current,nodes:[{...r.current.nodes[0]!,title:'unrelated title'}]})});
    const out=await refresh(r.cwd); assert.equal(out.refresh,undefined); assert.equal(out.observations.length,0);
    assert.equal((await r.entries()).filter(e=>e.kind==='refresh').length,before.filter(e=>e.kind==='refresh').length);
  } finally { await r.cleanup(); }
});
for(const side of ['merge','trunk'] as const) test(`IR repair P1: incomplete ${side} failed names cannot inherit truncated old failures`, async () => {
    const names=Array.from({length:50},(_,i)=>`old bug ${i}`);
    const emitted=JSON.stringify({pass:0,fail:51,failed:[...names,side==='merge' ? 'new bug' : 'old hidden bug']});
    const complete=JSON.stringify({pass:0,fail:50,failed:names});
    const run=`if grep -q extra value; then echo 'owed-counts ${side==='merge' ? emitted : complete}'; else echo 'owed-counts ${side==='trunk' ? emitted : complete}'; fi; exit 1`;
    const r=await fixture(run); try {
      await refresh(r.cwd); await r.candidate('extra');
      await assert.rejects(ops.merge({cwd:r.cwd,node:'a',as:parent}),/invariant suite new debt: failed names truncated; cannot prove the failure is old/);
      const obs=(await r.entries()).filter((e):e is ObsEntry=>e.kind==='obs' && e.subject==='trunk');
      assert.ok(obs.some(e=>e.counts?.fail===51 && e.failed?.length===50));
      assert.ok(!(await r.entries()).some(e=>e.kind==='merge'));
    } finally { await r.cleanup(); }
});
test('IR repair P2: display separators in failed names cannot hide structured min_tests failure', async () => {
  const name='old bug; last output: case', run=`echo 'owed-counts ${JSON.stringify({pass:0,fail:1,failed:[name]})}'; exit 1`;
  const r=await fixture(run,2); try {
    await refresh(r.cwd); const obs=(await r.entries()).find((e):e is ObsEntry=>e.kind==='obs' && e.subject==='trunk')!;
    assert.equal(reducer.testOnlyFailure(obs),false,'min_tests failure is not test-only regardless of display separators');
    assert.deepEqual(obs.execution,{completed:true,countOK:false});
    await r.candidate(); await assert.rejects(ops.merge({cwd:r.cwd,node:'a',as:parent}),/invariant suite new debt: requires a measured pass/);
    assert.ok(!(await r.entries()).some(e=>e.kind==='merge'));
  } finally { await r.cleanup(); }
});
test('IR repair P2: trunk-red notice survives classifyLine/revalidator and reaches pi, then resolves', async () => {
  const r=await fixture(); try {
    await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',note:'fixture idle notice delivery',plan:JSON.stringify({...r.current,nodes:[]})});
    const lines:string[]=[], d=new Driver({cwd:r.cwd,json:true,log:l=>lines.push(l),handleSignals:false});
    await d.pass(); await d.settle(); await d.pass();
    const line=lines.find(l=>JSON.parse(l).do==='notify' && JSON.parse(l).text?.includes('red on trunk'))!;
    assert.ok(line); const classified=classifyLine(line); assert.ok(classified.check);
    assert.deepEqual(await revalidator({cwd:r.cwd})([classified.check]),[true],'normal synchronized trunk must not discard the invariant red wake as drift');
    assert.equal(classified.check.drift,undefined);
    const s=await r.state();
    assert.deepEqual(classified.check.invariantRed,{obligation:'inv:suite',key:s.trunk.invKeys.suite});
    assert.notEqual(JSON.parse(line).node,'trunk');
    assert.deepEqual(await revalidator({cwd:r.cwd})([{...classified.check,invariantRed:{obligation:'inv:suite',key:'stale-key'}}]),[false]);
    const log=join(r.root,'follower-log'), delivered:string[]=[]; await writeFile(log,`${line}\n`);
    const f=new Follower({log,repo:r.cwd,pid:process.pid,from:0,busy:()=>false,revalidate:revalidator({cwd:r.cwd}),deliver:content=>delivered.push(content)});
    try { await f.step(); assert.equal(delivered.length,1); assert.match(delivered[0]!,/red on trunk since refresh/); }
    finally { f.stop(); }
    const current=(await r.entries()).findLast((e):e is ObsEntry=>e.kind==='obs' && e.obligation==='inv:suite')!;
    await r.ledger.withLock(()=>r.ledger.append([{kind:'obs',by:'executor:owed',subject:'trunk',obligation:current.obligation,key:current.key,commit:current.commit,base:current.base,verdict:'pass',exit:0,durationMs:0}]));
    assert.deepEqual(await revalidator({cwd:r.cwd})([classified.check]),[false],'a now non-red item drops the old red notice');
    await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',note:'fixture removes resolved invariant',plan:JSON.stringify({...r.current,invariants:[],nodes:[]})});
    assert.deepEqual(await revalidator({cwd:r.cwd})([classified.check]),[false],'a removed invariant no longer wakes pi');
  } finally { await r.cleanup(); }
});
test('IR repair: structured execution facts are required, validated, and independent of log hashes/keys', async () => {
  const r=await fixture(); try {
    const s=await r.state(), inv=s.plan.invariants[0]!, key=s.trunk.invKeys.suite ?? (await git.stateFacts(r.cwd,s.plan,s.trunk.commit)).invKeys.suite!;
    const log='owed-counts {"pass":0,"fail":1,"failed":["old bug"]}\n';
    const spec={...inv,run:`printf '%s\\n' '${log.trim()}'`};
    const job={kind:'inv' as const,subject:'trunk',obligation:'inv:suite',key,commit:s.trunk.commit,base:s.trunk.commit,spec};
    const obs=await runJob({cwd:r.cwd,plan:s.plan,ledger:r.ledger},job);
    assert.deepEqual(obs.execution,{completed:true,countOK:true}); assert.equal(obs.log,sha256(log));
    // Exact 0.14 key formula: execution metadata adds no check/merge-key input.
    const closure=await git.readsDigest(r.cwd,s.trunk.commit,s.plan.closure);
    const expected=H({o:'inv',id:inv.id,run:inv.run,timeout_s:inv.timeout_s,setup:s.plan.setup,exec:git.execKey(s.plan),min_tests:inv.min_tests,repeat:undefined,closure,reads:await git.readsDigest(r.cwd,s.trunk.commit,inv.reads)});
    assert.equal((await git.stateFacts(r.cwd,s.plan,s.trunk.commit)).invKeys.suite,expected);
    const legacy=named(); delete legacy.execution;
    assert.equal(reducer.testOnlyFailure(legacy),false,'missing structured facts are never test-only');
    assert.equal(reducer.newerEntry(named()),undefined);
    for(const execution of [{completed:true},{completed:true,countOK:'yes'},{completed:true,countOK:true,unknown:1}]) {
      assert.match(reducer.validateDraft(s,{...named(),execution} as unknown as Draft).join(),/obs execution must be/);
    }
    const below=await runJob({cwd:r.cwd,plan:s.plan,ledger:r.ledger},{...job,spec:{...spec,min_tests:2}});
    assert.deepEqual(below.execution,{completed:true,countOK:false}); assert.equal(below.log,obs.log,'count requirement metadata changes no command output digest');
    const timeout=await runJob({cwd:r.cwd,plan:s.plan,ledger:r.ledger},{...job,spec:{...spec,run:`${spec.run}; sleep 2`,timeout_s:0.05}});
    assert.equal(timeout.verdict,'error'); assert.equal(timeout.execution?.completed,false);
    const repeated=await runJob({cwd:r.cwd,plan:s.plan,ledger:r.ledger},{...job,spec:{...spec,repeat:{runs:2,need:1}}});
    assert.equal(repeated.runs?.length,2); assert.ok(repeated.runs!.every(run=>run.execution?.completed && run.execution.countOK));
    assert.ok(reducer.failedNamesComplete({...named(),...repeated}));
    assert.equal(reducer.failedNamesComplete({...named(),...repeated,failed:['old bug','lost']}),false);
    assert.equal(reducer.failedNamesComplete({...named(),...repeated,runs:repeated.runs!.map(run=>({...run,counts:{...run.counts,fail:51}}))}),false);
    const names=Array.from({length:50},(_,i)=>`old bug ${i}`);
    const unionOverflow={...named(),failed:names,runs:[{...repeated.runs![0]!,failed:names,counts:{tests:50,fail:50}},{...repeated.runs![1]!,failed:['new bug'],counts:{tests:1,fail:1}}]};
    assert.equal(reducer.failedNamesComplete(unionOverflow),false,'complete per-run lists with a truncated aggregate union still cannot prove old failures');
  } finally { await r.cleanup(); }
});
test('IR4: 0.14 ledger with no refresh retains facts, views and replay metadata', async () => {
  const r=await repo(); try {
    await r.put('value','clean'); await r.commit();
    const p={version:1,trunk:'main',lease:false,invariants:[{id:'legacy',run:`echo '# tests 1'; echo '# fail 1'; exit 1`,reads:['value']}],nodes:[]};
    await ops.init({cwd:r.cwd,plan:JSON.stringify(p),as:owner,channel:'delegated'});
    const view=await ops.status({cwd:r.cwd}); assert.equal(view.invariants[0]!.discharger,'writer'); assert.equal(view.invariants[0]!.detail,'inv:legacy current content failed'); assert.equal(view.trunkRed,undefined);
    const ledger=await Ledger.open(r.cwd), es=await ledger.read(), sha=(es[0] as Extract<Entry,{kind:'genesis'}>).plan, plan=parsePlan((await ledger.getBlob(sha)).toString());
    const s=reducer.reduce(es,()=>plan), packed=reducer.unpackState(structuredClone(reducer.packState(s)),()=>plan); assert.ok(reducer.sameReplay(s,packed)); assert.ok(!('invRed' in reducer.replayMeta(s)));
  } finally { await r.cleanup(); }
});
