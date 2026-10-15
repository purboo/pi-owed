import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { parsePlan } from '../src/plan.ts';
import { reduce, validateDraft, packState, unpackState, sameReplay } from '../src/reducer.ts';
import { Driver } from '../src/drive-run.ts';
import { Dsa } from '../src/dsa.ts';
import { writerLaunch } from '../src/drive.ts';
import { projectId } from '../src/reducer.ts';
import { renderStatus } from '../src/views.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';
import type { Draft, SweepEntry } from '../src/types.ts';

const owner = {role:'owner',id:'fixture'} as const, parent = {role:'parent',id:'fixture'} as const;
const RUN = `if test "$(cat app/value)" = bad; then printf 'TAP version 13\\nnot ok 1 - escaped behavior\\n  ---\\n  location: test/missing.test.ts:9:1\\n  error: regression\\n  ...\\n1..1\\n# tests 1\\n# pass 0\\n# fail 1\\n'; exit 1; else printf 'TAP version 13\\nok 1 - escaped behavior\\n1..1\\n# tests 1\\n# pass 1\\n# fail 0\\n'; fi`;
async function rig(ids:string[] = [], extra:Record<string,unknown> = {}) {
  const r=await repo(), prior=process.env.OWED_DSA;
  process.env.OWED_DSA=join(r.root,'no-dsa');
  await r.put('app/value','good'); const base=await r.commit();
  const plan={version:1,trunk:'main',closure:[],lease:false,invariants:[],drive:{min_free_mb:0},
    sweep:{run:RUN,timeout_s:10,every:{merges:2,minutes:10}},
    nodes:ids.map(id=>({id,writes:['app/'],checks:[],review:{count:0,min_rank:1}})),...extra};
  await ops.init({cwd:r.cwd,as:owner,channel:'delegated',plan:JSON.stringify(plan),measure:false});
  const entries=async()=> (await Ledger.open(r.cwd)).read();
  return {...r,base,plan,entries,
    async merge(id:string,value:string) {
      const d=await ops.dispatch({cwd:r.cwd,as:parent,node:id});
      await commitAt(d.worktree,{'app/value':value});
      await ops.submit({cwd:d.worktree,as:{role:'writer',id:`${id}#1`},node:id});
      await ops.attest({cwd:r.cwd,node:id});
      return ops.merge({cwd:r.cwd,as:parent,node:id});
    },
    async done() { if(prior===undefined) delete process.env.OWED_DSA; else process.env.OWED_DSA=prior; await r.cleanup(); },
  };
}
const driver=(cwd:string,extra:object={})=>new Driver({cwd,json:true,log:()=>{},handleSignals:false,...extra});
async function until(f:()=>boolean|Promise<boolean>) {
  const end=Date.now()+10_000;
  while(!await f()) { assert.ok(Date.now()<end,'bounded wait for fixture'); await new Promise(r=>setTimeout(r,20)); }
}

test('SW1 every validates positive integers and changes neither measurement nor sweep definition keys',async()=>{
  const r=await rig();
  try {
    const {sweepDefinitionKey}=await import('../src/sweep.ts');
    const p=parsePlan(JSON.stringify(r.plan));
    assert.deepEqual(p.sweep?.every,{merges:2,minutes:10});
    assert.equal(sweepDefinitionKey(p),sweepDefinitionKey(parsePlan(JSON.stringify({...r.plan,sweep:{run:RUN,timeout_s:10}}))));
    assert.equal(sweepDefinitionKey(p),sweepDefinitionKey({...p,sweep:{...p.sweep!,every:{merges:8}}}));
    const facts=(await ops.readState({cwd:r.cwd})).state.trunk;
    await ops.planSet({cwd:r.cwd,as:parent,plan:JSON.stringify({...r.plan,sweep:{...r.plan.sweep,every:{minutes:1}}})});
    assert.deepEqual((await ops.readState({cwd:r.cwd})).state.trunk,facts);
    for(const every of [{},{merges:0},{minutes:-1},{minutes:1.5},{merges:'2'},{unknown:1},[],null])
      assert.throws(()=>parsePlan(JSON.stringify({...r.plan,sweep:{...r.plan.sweep,every}})),/sweep.every/);
  } finally {await r.done();}
});

test('SW1 --due counts merges since the measured commit, not bisect steps or append time; not due exits zero without writing',async()=>{
  const r=await rig(['a','b']);
  try {
    const baseline=await ops.sweep({cwd:r.cwd});
    await r.merge('a','good-a');
    const before=(await r.entries()).length, quiet=await cli(r.cwd,['sweep','--due']);
    assert.equal(quiet.code,0,quiet.stderr); assert.match(quiet.stdout,/^sweep not due: next after 1 merges or at \d{2}:\d{2}\n$/);
    assert.equal((await r.entries()).length,before);
    await r.merge('b','good-b');
    const due=await cli(r.cwd,['sweep','--due','--json']); assert.equal(due.code,0,due.stderr);
    assert.equal(JSON.parse(due.stdout).entry.verdict,'pass');
    const entries=await r.entries(); assert.equal(entries.filter(e=>e.kind==='sweep'&&!e.bisect).length,2);
    assert.ok(entries.at(-1)!.seq>baseline.entry.seq);
    const unchanged=await cli(r.cwd,['sweep','--due']); assert.equal(unchanged.code,0); assert.match(unchanged.stdout,/next after 2 merges/);
  } finally {await r.done();}
});

test('SW1 elapsed minutes trigger an ordinary non-staying driver, including with no prior sweep',async()=>{
  const r=await rig([],{sweep:{run:RUN,timeout_s:10,every:{minutes:1}}}), real=Date.now;
  const d=driver(r.cwd);
  try {
    await d.pass(); await d.settle(); assert.equal((await r.entries()).filter(e=>e.kind==='sweep').length,0);
    Date.now=()=>real()+61_000;
    const due=await d.pass(); assert.ok(due.actions.some(a=>a.do==='sweep'&&a.outcome==='started'));
    await d.settle(); Date.now=real;
    const last=(await r.entries()).findLast((e):e is SweepEntry=>e.kind==='sweep')!;
    Date.now=()=>Date.parse(last.ts)+59_000; await d.pass(); await d.settle();
    assert.equal((await r.entries()).filter(e=>e.kind==='sweep').length,1);
    Date.now=()=>Date.parse(last.ts)+61_000; await d.pass(); await d.settle(); Date.now=real;
    assert.equal((await r.entries()).filter(e=>e.kind==='sweep').length,2,'same trunk is measured again after interval');
  } finally {Date.now=real; d.abort.abort(); await d.settle(); await r.done();}
});

test('SW1 scheduled sweep coexists with accepted node work, never preempts it, never overlaps itself, and stops on driver stop',async()=>{
  const r=await rig(['a','b','c'],{sweep:{run:RUN,timeout_s:10,every:{merges:1}}});
  let d:Driver|undefined;
  try {
    await ops.sweep({cwd:r.cwd}); await r.merge('a','good-a');
    const started=join(r.root,'started'),gate=join(r.root,'gate');
    const b=await ops.dispatch({cwd:r.cwd,as:parent,node:'b'});
    const state=(await ops.readState({cwd:r.cwd})).state;
    await ops.launch({...writerLaunch(state,'b',projectId(state)),cwd:r.cwd,as:{role:'parent',id:'drive'}});
    class Live extends Dsa {override async inspect(rid:string):ReturnType<Dsa['inspect']>{return {view:{rid,state:'running',status:'running'},gen:1};}}
    // c is held off; b is a live writer when the interval comes due.
    await ops.planSet({cwd:r.cwd,as:parent,plan:JSON.stringify({...r.plan,nodes:r.plan.nodes.map(n=>n.id==='c'?{...n,later:true}:n),sweep:{...r.plan.sweep,run:`touch '${started}'; while test ! -f '${gate}'; do sleep .02; done; ${RUN}`}})});
    const lines:string[]=[]; d=driver(r.cwd,{dsa:new Live(),log:(l:string)=>lines.push(l)});
    await d.pass(); await until(()=>existsSync(started));
    await assert.rejects(ops.sweep({cwd:r.cwd}),/sweep already running/);
    await commitAt(b.worktree,{'app/value':'good-b'}); await ops.submit({cwd:b.worktree,as:{role:'writer',id:'b#1'},node:'b'}); await ops.attest({cwd:r.cwd,node:'b'});
    const ready=await d.pass(); assert.ok(ready.actions.some(a=>a.do==='merge'&&a.node==='b'&&a.outcome==='started'));
    await until(async()=>!!(await ops.readState({cwd:r.cwd})).state.nodes.b?.merged);
    await d.pass(); assert.equal(lines.map(l=>JSON.parse(l)).filter(l=>l.do==='sweep'&&l.outcome==='started').length,1);
    assert.equal((await r.entries()).filter(e=>e.kind==='note'&&e.text.includes('preempted')).length,0);
    await writeFile(gate,''); await d.settle();
    // Still due relative to the measured old trunk: a new run starts, and driver stop aborts it.
    const {rm}=await import('node:fs/promises'); await rm(gate); await rm(started);
    d.tick(); await d.pass(); await until(()=>existsSync(started)); d.stopping=true; await d.pass(); await d.settle();
    assert.ok(lines.map(l=>JSON.parse(l)).some(l=>l.do==='sweep'&&l.outcome==='aborted'&&/stopped/.test(l.detail)));
  } finally {d?.abort.abort(); await d?.settle(); await r.done();}
});

test('SW2/SW3 confirmed boundary records one executor escape, validates replay and dedupes same sorted names',async()=>{
  const r=await rig(['a','b','c']);
  try {
    await ops.sweep({cwd:r.cwd}); const culprit=await r.merge('a','bad'); await r.merge('b','bad');
    const out=await cli(r.cwd,['sweep']); assert.equal(out.code,1,out.stderr);
    assert.match(out.stdout,new RegExp(`escape: a \\(merge #${culprit.entry.seq}\\) broke escaped behavior on trunk [0-9a-f]{12}; no check covered it\\. Fix: a node whose brief names the test; coverage: test/missing\\.test\\.ts`));
    const escapes=(await r.entries()).filter(e=>e.kind==='escape'); assert.equal(escapes.length,1);
    const escape=escapes[0]!; assert.equal(escape.by,'executor:owed'); assert.equal(escape.class,'missing');
    assert.match(escape.evidence!,/^sweep #\d+: escaped behavior$/);
    assert.equal((await ops.verify({cwd:r.cwd})).ok,true);
    await ops.sweep({cwd:r.cwd}); assert.equal((await r.entries()).filter(e=>e.kind==='escape').length,1);
    const due=await cli(r.cwd,['sweep','--due']); assert.equal(due.code,0); assert.match(due.stdout,/next after 2 merges/,'bisect predecessor samples do not reset the schedule');
    const before=await ops.status({cwd:r.cwd}); assert.match(renderStatus(before),/trunk: sweep red since #\d+ \(escaped behavior\)/); assert.match(renderStatus(before,{full:true}),/trunk: sweep red since #/);
    await r.merge('c','good'); assert.match(renderStatus(await ops.status({cwd:r.cwd})),/trunk: sweep red since #/,'merging a fix is allowed but does not erase advisory evidence');
    await ops.sweep({cwd:r.cwd,commit:r.base});
    assert.match(renderStatus(await ops.status({cwd:r.cwd})),/trunk: sweep red since #/,'a passing ancestor cannot clear the red descendant');
    await ops.sweep({cwd:r.cwd}); assert.doesNotMatch(renderStatus(await ops.status({cwd:r.cwd})),/trunk: sweep red since #/);
    const {state,entries}=await ops.readState({cwd:r.cwd}), lookup=()=>parsePlan(JSON.stringify(r.plan));
    assert.ok(sameReplay(unpackState(packState(state),lookup),reduce(entries,lookup)));
  } finally {await r.done();}
});

test('SW2 replay refuses executor escapes without a proven cited sweep and refuses duplicate or forged names/principal',async()=>{
  const r=await rig(['a']);
  try {
    await ops.sweep({cwd:r.cwd}); const merge=await r.merge('a','bad'); await ops.sweep({cwd:r.cwd});
    const {state,entries}=await ops.readState({cwd:r.cwd});
    const valid=entries.find(e=>e.kind==='escape')!; assert.ok(valid);
    const asDraft=({...valid,seq:undefined,ts:undefined,hash:undefined,prev:undefined}) as unknown as Draft;
    assert.ok(validateDraft(state,asDraft).some(e=>/duplicate|already/.test(e)));
    for(const patch of [{sweep:undefined},{sweep:0},{by:'executor:fake'},{evidence:'sweep #0: forged'},{class:'weak'}])
      assert.ok(validateDraft(state,{...asDraft,...patch} as Draft).length,JSON.stringify(patch));
    const forged={kind:'escape',by:'executor:owed',node:'a',merge:merge.entry.seq,class:'missing',note:'forged',evidence:'sweep #0: escaped behavior',sweep:0} as Draft;
    assert.ok(validateDraft(state,forged).length);
    const boundary=entries.find((e):e is SweepEntry=>e.kind==='sweep'&&!!e.boundary)!;
    const before=reduce(entries.filter(e=>e.seq<boundary.seq),()=>parsePlan(JSON.stringify(r.plan)));
    assert.deepEqual(validateDraft(before,boundary),[]);
    for(const patch of [{boundary:{}},{boundary:{...boundary.boundary,extra:1}},{boundary:{head:boundary.seq,merge:merge.entry.seq}},
      {commit:merge.commit},{verdict:'fail'},{key:'f'.repeat(64)},{bisect:undefined}])
      assert.ok(validateDraft(before,{...boundary,...patch} as Draft).length,JSON.stringify(patch));
    assert.deepEqual(validateDraft(state,{kind:'escape',by:'parent:fixture',node:'a',merge:merge.entry.seq,class:'missing',note:'manual'}),[],'manual escape authority is unchanged');
  } finally {await r.done();}
});

test('SW2 flaky head, absent green boundary and changed-definition red never produce an escape',async()=>{
  const r=await rig(['a']);
  try {
    const once=join(r.root,'once');
    const flaky=`if test ! -f '${once}'; then touch '${once}'; ${RUN.replace('= bad','= good')}; fi; true`;
    await ops.planSet({cwd:r.cwd,as:parent,plan:JSON.stringify({...r.plan,sweep:{...r.plan.sweep,run:flaky}})});
    const head=await ops.sweep({cwd:r.cwd}); assert.match(head.note!,/flaky at head/);
    await ops.planSet({cwd:r.cwd,as:parent,plan:JSON.stringify({...r.plan,sweep:{...r.plan.sweep,run:'exit 1'}})});
    const noBoundary=await ops.sweep({cwd:r.cwd}); assert.equal(noBoundary.first,undefined);
    await ops.planSet({cwd:r.cwd,as:parent,plan:JSON.stringify(r.plan)}); await ops.sweep({cwd:r.cwd}); await r.merge('a','good-a');
    await ops.planSet({cwd:r.cwd,as:parent,plan:JSON.stringify({...r.plan,sweep:{...r.plan.sweep,run:'exit 1'}})});
    const changed=await ops.sweep({cwd:r.cwd}); assert.match(changed.note!,/no green boundary under current/);
    assert.equal((await r.entries()).filter(e=>e.kind==='escape').length,0);
  } finally {await r.done();}
});

test('SW3 notices use fallback coverage when invariant reads cover the reported test; duplicate has no notice',async()=>{
  const r=await rig(['a'],{invariants:[{id:'other',run:'true',reads:['test/**'],timeout_s:10}]});
  try {
    await ops.sweep({cwd:r.cwd}); await r.merge('a','bad');
    const {renderSweep}=await import('../src/sweep.ts'); const result=await ops.sweep({cwd:r.cwd});
    assert.match(renderSweep(result),/coverage: add the test to an invariant/);
    const duplicate=await ops.sweep({cwd:r.cwd}); assert.doesNotMatch(renderSweep(duplicate),/^escape:/m);
  } finally {await r.done();}
});

test('SW1 scheduled sweeps acquire shared no-wait leases and retry busy on a later pass without halting',async()=>{
  const r=await rig(['a']), leased=process.env.OWED_LEASED;
  let d:Driver|undefined;
  try {
    delete process.env.OWED_LEASED;
    await ops.sweep({cwd:r.cwd}); await r.merge('a','good-a');
    const bin=join(r.root,'dsa.mjs'),holds=join(r.root,'holds'),busy=join(r.root,'busy');
    await writeFile(busy,'');
    await writeFile(bin,`#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {appendFileSync,existsSync} from 'node:fs';
const args=process.argv.slice(2),sep=args.indexOf('--');
appendFileSync(${JSON.stringify(holds)},JSON.stringify(args)+'\\n');
if(existsSync(${JSON.stringify(busy)})) process.exit(75);
const p=spawn(args[sep+1],args.slice(sep+2),{stdio:'inherit'});
for(const s of ['SIGTERM','SIGINT']) process.on(s,()=>p.kill(s));
p.on('close',c=>process.exit(c??1));
`); await chmod(bin,0o755);
    await ops.planSet({cwd:r.cwd,as:parent,plan:JSON.stringify({...r.plan,lease:true,sweep:{...r.plan.sweep,run:`test "$OWED_LEASED" = 1 && ${RUN}`,every:{merges:1}}})});
    const lines:string[]=[]; d=driver(r.cwd,{dsa:new Dsa({bin}),log:(l:string)=>lines.push(l)});
    await d.pass(); await d.settle(); assert.ok(lines.map(l=>JSON.parse(l)).some(l=>l.do==='sweep'&&l.outcome==='busy'));
    assert.equal((await r.entries()).filter(e=>e.kind==='sweep').length,1);
    assert.equal((await r.entries()).filter(e=>e.kind==='halt').length,0);
    const {rm}=await import('node:fs/promises'); await rm(busy); d.tick(); await d.pass(); await d.settle();
    const runs=(await r.entries()).filter((e):e is SweepEntry=>e.kind==='sweep'); assert.equal(runs.length,2); assert.equal(runs.at(-1)?.verdict,'pass');
    const args=(await readFile(holds,'utf8')).trim().split('\n').map(l=>JSON.parse(l) as string[]);
    assert.equal(args.length,2); assert.ok(args.every(a=>a.includes('--shared')&&a.includes('--no-wait')));
  } finally {d?.abort.abort(); await d?.settle(); if(leased===undefined) delete process.env.OWED_LEASED; else process.env.OWED_LEASED=leased; await r.done();}
});

test('SW2 sorted-name dedupe is independent of protocol order and evidence has at most five names',async()=>{
  const names=['zeta','beta','alpha','epsilon','delta','gamma'];
  const run=(ns:string[])=>`if test "$(cat app/value)" = bad; then printf '%s\\n' 'owed-counts ${JSON.stringify({pass:0,fail:ns.length,failed:ns})}'; exit 1; else printf '%s\\n' 'owed-counts {"pass":6,"fail":0}'; fi`;
  const r=await rig(['a'],{sweep:{run:run(names),timeout_s:10,every:{merges:1}}});
  try {
    await ops.sweep({cwd:r.cwd}); await r.merge('a','bad');
    const first=await ops.sweep({cwd:r.cwd}); assert.match(first.escape!.evidence!,/: alpha, beta, delta, epsilon, gamma$/);
    assert.match(first.notice!,/coverage: add the test to an invariant/,'no locations uses the fallback');
    await ops.planSet({cwd:r.cwd,as:parent,plan:JSON.stringify({...r.plan,sweep:{...r.plan.sweep,run:run([...names].reverse())}})});
    const reordered=await ops.sweep({cwd:r.cwd}); assert.equal(reordered.escape,undefined); assert.equal(reordered.notice,undefined);
    assert.equal((await r.entries()).filter(e=>e.kind==='escape').length,1); assert.equal((await ops.verify({cwd:r.cwd})).ok,true);
  } finally {await r.done();}
});

test('SW3 real TAP absolute locations name every uncovered test file even when error text is shared',async()=>{
  const r=await rig(['a'],{sweep:{run:'node --test --test-reporter=tap test/one.test.cjs test/two.test.cjs',timeout_s:10,every:{merges:1}}});
  try {
    const source=(name:string)=>`require('node:test')('${name}',()=>require('node:assert/strict').equal(require('node:fs').readFileSync('app/value','utf8'),'good'));`;
    await commitAt(r.cwd,{'test/one.test.cjs':source('one escaped'),'test/two.test.cjs':source('two escaped')});
    await ops.adopt({cwd:r.cwd,as:owner,channel:'delegated',note:'fixture adds the advisory tests'});
    await ops.sweep({cwd:r.cwd}); await r.merge('a','bad');
    const result=await ops.sweep({cwd:r.cwd}); assert.match(result.notice!,/coverage: test\/one.test.cjs, test\/two.test.cjs/);
    assert.equal(result.notice!.split('\n').length,1);
  } finally {await r.done();}
});
