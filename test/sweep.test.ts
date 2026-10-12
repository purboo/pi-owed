import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import * as git from '../src/git.ts';
import { parsePlan } from '../src/plan.ts';
import { Ledger } from '../src/ledger.ts';
import { reduce, packState, unpackState, sameReplay, validateDraft, newerEntry } from '../src/reducer.ts';
import { Driver } from '../src/drive-run.ts';
import { writerLaunch } from '../src/drive.ts';
import { projectId } from '../src/reducer.ts';
import { Dsa } from '../src/dsa.ts';
import { renderBrief } from '../src/views.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { Draft, Entry, Plan } from '../src/types.ts';

const owner = { role:'owner', id:'fixture' } as const, parent = { role:'parent', id:'fixture' } as const;
const RUN = `if test "$(cat app/value)" = bad; then printf 'TAP version 13\\nnot ok 1 - escaped behavior\\n1..1\\n# tests 1\\n# pass 0\\n# fail 1\\n'; exit 1; else printf 'TAP version 13\\nok 1 - escaped behavior\\n1..1\\n# tests 1\\n# pass 1\\n# fail 0\\n'; fi`;
async function rig(ids: string[] = [], extra: Record<string, unknown> = {}) {
  const r = await repo(); const prior = process.env.OWED_DSA; process.env.OWED_DSA = join(r.root, 'no-dsa');
  const plan = { version:1, trunk:'main', closure:[], lease:false, sweep:{run:RUN,timeout_s:10}, invariants:[],
    nodes:ids.map(id => ({id,writes:['app/'],checks:[],review:{count:0,min_rank:1}})), drive:{min_free_mb:0}, ...extra };
  await r.put('app/value','good'); const base = await r.commit();
  await ops.init({cwd:r.cwd,as:owner,channel:'delegated',plan:JSON.stringify(plan),measure:false});
  const entries = async () => (await (await Ledger.open(r.cwd)).read());
  return { ...r, base, plan, entries,
    async merge(id:string, value:string) {
      const d = await ops.dispatch({cwd:r.cwd,as:parent,node:id});
      await commitAt(d.worktree,{'app/value':value});
      await ops.submit({cwd:d.worktree,as:{role:'writer',id:`${id}#1`},node:id});
      await ops.attest({cwd:r.cwd,node:id});
      return ops.merge({cwd:r.cwd,as:parent,node:id});
    },
    async done() { if (prior === undefined) delete process.env.OWED_DSA; else process.env.OWED_DSA = prior; await r.cleanup(); },
  };
}
const sw = (cwd:string, extra:object = {}) => {
  assert.equal(typeof ops.sweep,'function','owed exposes the configured sweep operation');
  return ops.sweep({cwd,...extra});
};
const sleep = (ms:number) => new Promise<void>(resolve => setTimeout(resolve,ms));
async function until(f:() => boolean | Promise<boolean>, label:string) {
  const end = Date.now()+10_000;
  while (!await f()) { assert.ok(Date.now()<end,`timeout: ${label}`); await sleep(20); }
}

test('SW plan validation and advisory sweep fields do not change any existing keys', async () => {
  const r = await rig(['a']);
  try {
    const plain = parsePlan(JSON.stringify({...r.plan,sweep:undefined})), withSweep = parsePlan(JSON.stringify(r.plan));
    assert.deepEqual(withSweep.sweep,r.plan.sweep);
    assert.deepEqual(await git.stateFacts(r.cwd,plain,r.base),await git.stateFacts(r.cwd,withSweep,r.base));
    assert.deepEqual(await git.candidateFacts(r.cwd,plain,plain.nodes[0]!,r.base,r.base,1),await git.candidateFacts(r.cwd,withSweep,withSweep.nodes[0]!,r.base,r.base,1));
    assert.equal(parsePlan(JSON.stringify({...r.plan,sweep:{run:'true'}})).sweep?.timeout_s,600);
    for (const sweep of [false,[],{run:''},{run:'true',timeout_s:0},{run:'true',reads:'app/'},{run:'true',repeat:{runs:2}},{run:'true',unknown:1}]) assert.throws(() => parsePlan(JSON.stringify({...r.plan,sweep})),/sweep/);
  } finally { await r.done(); }
});

test('SW CLI default trunk and explicit commit use detached trees, never dirty working files; log/counts are durable', async () => {
  const r = await rig([],{closure:['app/value']});
  try {
    await r.put('app/value','bad');
    const out = await cli(r.cwd,['sweep','--json']); assert.equal(out.code,0,out.stderr);
    const pass = JSON.parse(out.stdout); assert.equal(pass.entry.commit,r.base); assert.equal(pass.entry.verdict,'pass'); assert.deepEqual(pass.entry.counts,{format:'tap',tests:1,pass:1,fail:0});
    assert.match((await (await Ledger.open(r.cwd)).getBlob(pass.entry.log)).toString(),/ok 1 - escaped behavior/);
    assert.equal(await readFile(join(r.cwd,'app/value'),'utf8'),'bad');
    const bad = await r.commit();
    const old = await cli(r.cwd,['sweep','--commit',r.base]); assert.equal(old.code,0,old.stderr);
    const fail = await cli(r.cwd,['sweep','--commit',bad,'--json']); assert.equal(fail.code,1,fail.stderr); assert.deepEqual(JSON.parse(fail.stdout).entry.failed,['escaped behavior']);
    const invalid = await cli(r.cwd,['sweep','--commit','does-not-exist']); assert.notEqual(invalid.code,0);
    assert.equal((await r.entries()).filter(e => e.kind === 'sweep').length,3);
    assert.equal((await git.git(r.cwd,['worktree','list','--porcelain'])).stdout.split('worktree ').length,2,'measurement trees disposed');
  } finally { await r.done(); }
});

test('SW failing sweep without green ancestor does not bisect, record escape, or block a later merge', async () => {
  const r = await rig(['a'],{sweep:{run:"printf 'not ok 1 - missed\\n1..1\\n# tests 1\\n# fail 1\\n'; exit 1",timeout_s:10}});
  try {
    const before = (await ops.readState({cwd:r.cwd})).state;
    const fail = await sw(r.cwd); assert.equal(fail.entry.verdict,'fail'); assert.deepEqual(fail.steps,[]); assert.equal(fail.first,undefined); assert.match(fail.note!,/no green ancestor/);
    const after = (await ops.readState({cwd:r.cwd})).state; assert.deepEqual(after.invariants,before.invariants); assert.deepEqual(after.nodes,before.nodes);
    const merged = await r.merge('a','good'); assert.ok(merged.commit); assert.equal((await r.entries()).filter(e => e.kind === 'escape').length,0);
  } finally { await r.done(); }
});

test('SW bisects first-parent owed merges, records every step, and prints an executable proposal only', async () => {
  const r = await rig(['a','b','c','d','e']);
  try {
    await sw(r.cwd);
    await r.merge('a','good-a'); await r.merge('b','good-b');
    const first = await r.merge('c','bad'); await r.merge('d','bad'); await r.merge('e','bad');
    const fail = await sw(r.cwd);
    assert.equal(fail.first?.node,'c'); assert.equal(fail.first?.merge,first.entry.seq); assert.equal(fail.first?.commit,first.commit);
    assert.ok(fail.steps.length>=2 && fail.steps.length<=3); assert.ok(fail.steps.every(e => e.bisect===true));
    assert.match(fail.first!.command,/owed escape 'c' --merge \d+ --class missing --note '/);
    const text = await cli(r.cwd,['sweep']); assert.equal(text.code,1); assert.match(text.stdout,/First failing merge:.*node c merge #/); assert.match(text.stdout,/promote escaped behavior to an invariant/);
    assert.equal((await r.entries()).filter(e => e.kind === 'escape').length,0);
    assert.equal((await ops.verify({cwd:r.cwd})).ok,true);
  } finally { await r.done(); }
});

test('SW distinguishes command/setup/timeouts as errors and caps cargo failing names', async () => {
  const r = await rig();
  try {
    for (const extra of [ {sweep:{run:'not-an-existing-command-owed',timeout_s:10}}, {sweep:{run:'sleep 10',timeout_s:1}}, {setup:'exit 2'} ]) {
      await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',note:'fixture changes execution',plan:JSON.stringify({...r.plan,...extra})});
      const run = await sw(r.cwd); assert.equal(run.entry.verdict,'error'); assert.equal(run.first,undefined);
    }
    const names = Array.from({length:60},(_,i) => `test case_${i} ... FAILED`).join('\n');
    await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',note:'fixture removes failing setup',plan:JSON.stringify({...r.plan,sweep:{run:`printf '%s\\n' '${names}\ntest result: FAILED. 0 passed; 60 failed; 0 ignored'; exit 1`,timeout_s:10}})});
    const fail = await sw(r.cwd); assert.equal(fail.entry.counts?.fail,60); assert.equal(fail.entry.failed.length,50); assert.equal(fail.entry.failed[0],'case_0');
  } finally { await r.done(); }
});

test('SW stops bisect on a measurement error rather than naming an unproven merge', async () => {
  const r = await rig(['a','b','c'],{sweep:{run:`test "$(cat app/value)" != error || exit 127; ${RUN}`,timeout_s:10}});
  try {
    await sw(r.cwd); await r.merge('a','good'); await r.merge('b','error'); await r.merge('c','bad');
    const fail = await sw(r.cwd); assert.equal(fail.entry.verdict,'fail'); assert.equal(fail.first,undefined); assert.ok(fail.steps.some(e => e.verdict==='error')); assert.match(fail.note!,/measurement error/);
  } finally { await r.done(); }
});

test('SW cannot blame an owed merge when only an adopted tip fails', async () => {
  const r = await rig(['a']);
  try {
    await sw(r.cwd); await r.merge('a','good');
    await commitAt(r.cwd,{'app/value':'bad'}); await ops.adopt({cwd:r.cwd,as:owner,channel:'delegated',note:'fixture adopted regression'});
    const fail = await sw(r.cwd); assert.equal(fail.first,undefined); assert.equal(fail.steps.length,1); assert.equal(fail.steps[0]?.verdict,'pass');
  } finally { await r.done(); }
});

const FAKE = `#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {appendFileSync,existsSync,writeFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
const dir=process.env.SW_LEASE_DIR,args=process.argv.slice(2),sep=args.indexOf('--');
if(args[0]==='describe') { console.log(JSON.stringify({state:'sealed',status:'done',calls:[{key:'main',gen:1,status:'ok'}]})); process.exit(0); }
if(args[0]!=='hold') process.exit(2);
appendFileSync(join(dir,'holds'),JSON.stringify(args)+'\\n');
if(existsSync(join(dir,'busy')) && args.includes('--no-wait')) process.exit(75);
writeFileSync(join(dir,'active'),String(process.pid));
const p=spawn(args[sep+1],args.slice(sep+2),{stdio:'inherit'});
for(const s of ['SIGTERM','SIGINT','SIGHUP']) process.on(s,()=>p.kill(s));
p.on('close',code=>{rmSync(join(dir,'active'),{force:true});process.exit(code??1);});
`;
async function leaseRig(extra:Record<string,unknown> = {}) {
  const r = await rig([],{lease:true,...extra}), bin = join(r.root,'dsa.mjs'); const prior = process.env.SW_LEASE_DIR, leased = process.env.OWED_LEASED;
  delete process.env.OWED_LEASED; process.env.SW_LEASE_DIR = r.root; process.env.OWED_DSA = bin; await writeFile(bin,FAKE); await chmod(bin,0o755);
  return {...r,bin,async done() { if(prior===undefined) delete process.env.SW_LEASE_DIR; else process.env.SW_LEASE_DIR=prior; if(leased===undefined) delete process.env.OWED_LEASED; else process.env.OWED_LEASED=leased; await r.done(); }};
}

test('SW lease helper supplies OWED_LEASED and releases the shared holder; busy driver retries later only', async () => {
  const r = await leaseRig();
  try {
    await ops.planSet({cwd:r.cwd,as:parent,plan:JSON.stringify({...r.plan,sweep:{run:`test "$OWED_LEASED" = 1 && test -f '${join(r.root,'active')}' && ${RUN}`,timeout_s:10}})});
    const run = await sw(r.cwd); assert.equal(run.entry.verdict,'pass'); assert.equal(run.lease,'machine (shared)'); assert.equal(existsSync(join(r.root,'active')),false);
    const args = JSON.parse(readFileSync(join(r.root,'holds'),'utf8').trim()); assert.ok(args.includes('--shared')); assert.ok(!args.includes('--no-wait'));
    const changed = await commitAt(r.cwd,{'app/value':'good2'}); await ops.adopt({cwd:r.cwd,as:owner,channel:'delegated',note:'new trunk',lease:false});
    await writeFile(join(r.root,'busy'),''); const lines:string[]=[];
    const d = new Driver({cwd:r.cwd,stay:true,dsa:new Dsa({bin:r.bin}),json:true,log:l=>lines.push(l),handleSignals:false});
    const busy = await d.pass(); assert.equal(busy.idle,false); assert.ok(lines.some(l=>JSON.parse(l).outcome==='busy')); assert.equal((await r.entries()).filter(e=>e.kind==='sweep' && e.commit===changed).length,0); assert.equal((await r.entries()).filter(e=>e.kind==='halt').length,0);
    await rm(join(r.root,'busy')); d.tick(); await d.pass(); assert.equal((await r.entries()).filter(e=>e.kind==='sweep' && e.commit===changed).length,1);
    await d.pass(); assert.equal((await r.entries()).filter(e=>e.kind==='sweep' && e.commit===changed).length,1);
  } finally { await r.done(); }
});

test('SW abort kills the sweep group, releases lease/operation lock and records no interrupted verdict', async () => {
  const r = await leaseRig();
  const ac = new AbortController(); let pending:Promise<unknown> | undefined;
  try {
    const marker = join(r.root,'started');
    await ops.planSet({cwd:r.cwd,as:parent,plan:JSON.stringify({...r.plan,sweep:{run:`touch '${marker}'; sleep 30`,timeout_s:40}})});
    pending = sw(r.cwd,{signal:ac.signal}); pending.catch(()=>{});
    await until(()=>existsSync(marker),'sweep started'); ac.abort(); await assert.rejects(pending,(e:Error & {code?:string})=>e.code==='aborted');
    assert.equal(existsSync(join(r.root,'active')),false); assert.equal((await r.entries()).filter(e=>e.kind==='sweep').length,0);
    assert.equal(existsSync(join((await Ledger.open(r.cwd)).dir,'sweep')),false);
    assert.equal((await git.git(r.cwd,['worktree','list','--porcelain'])).stdout.split('worktree ').length,2);
  } finally { ac.abort(); await pending?.catch(()=>{}); await r.done(); }
});

test('SW staying idle driver sweeps once per trunk across restart; once driver and ready work do not sweep', async () => {
  const r = await rig();
  try {
    const mk = (stay:boolean) => new Driver({cwd:r.cwd,stay,json:true,log:()=>{},handleSignals:false});
    await mk(false).pass(); assert.equal((await r.entries()).filter(e=>e.kind==='sweep').length,0);
    await mk(true).pass(); await mk(true).pass(); assert.equal((await r.entries()).filter(e=>e.kind==='sweep').length,1);
    await ops.planSet({cwd:r.cwd,as:parent,plan:JSON.stringify({...r.plan,nodes:[{id:'later',writes:['app/'],checks:[]}]})});
    // A pass dispatches the ready node; sweep must still wait for ready work.
    const ready = mk(true); await ready.pass(); assert.equal((await r.entries()).filter(e=>e.kind==='sweep').length,1);
  } finally { await r.done(); }
});

test('SW failures wake parent with names/proposal once; stale results stay bound to their measured commit', async () => {
  const r = await rig(['a']);
  try {
    await sw(r.cwd); await r.merge('a','bad'); const lines:string[]=[];
    const d=new Driver({cwd:r.cwd,stay:true,json:true,log:l=>lines.push(l),handleSignals:false}); await d.pass(); await d.pass();
    const notices=lines.map(l=>JSON.parse(l)).filter(l=>l.do==='notify'); assert.equal(notices.length,1); assert.match(notices[0].text,/Proposal: owed escape 'a'/); assert.match(notices[0].text,/promote escaped behavior to an invariant/);
    const marker=join(r.root,'mark'), gate=join(r.root,'continue');
    await ops.planSet({cwd:r.cwd,as:parent,plan:JSON.stringify({...r.plan,sweep:{run:`touch '${marker}'; for i in $(seq 1 100); do test ! -f '${gate}' || break; sleep .02; done; ${RUN}`,timeout_s:10}})});
    const old=(await ops.status({cwd:r.cwd})).trunk.commit, pending=sw(r.cwd); await until(()=>existsSync(marker),'pinned sweep running');
    await commitAt(r.cwd,{'app/value':'good'}); await ops.adopt({cwd:r.cwd,as:owner,channel:'delegated',note:'trunk moves while sweep runs'}); await writeFile(gate,'');
    const result=await pending; assert.equal(result.entry.commit,old); assert.equal(result.entry.verdict,'fail'); assert.notEqual((await ops.status({cwd:r.cwd})).trunk.commit,old);
  } finally { await r.done(); }
});

test('SW unguarded paths appear at merge, driver report, and brief with merge-time coverage and last 10 cap', async () => {
  const r=await rig(Array.from({length:11},(_,i)=>`n${i}`),{invariants:[{id:'core',run:'true',reads:['app/core/**'],timeout_s:10}]});
  try {
    const d=await ops.dispatch({cwd:r.cwd,as:parent,node:'n0'});
    await commitAt(d.worktree,{'app/bundles/a/x':'a','app/bundles/b':'b','app/core/x':'c'}); await ops.submit({cwd:d.worktree,as:{role:'writer',id:'n0#1'},node:'n0'}); await ops.attest({cwd:r.cwd,node:'n0'});
    const out=await cli(r.cwd,['merge','n0']); assert.equal(out.code,0,out.stderr); assert.match(out.stdout,/Unguarded paths: app\/bundles\/\*\*/); assert.doesNotMatch(out.stdout,/Unguarded paths:.*app\/core/);
    const b=await ops.brief({cwd:r.cwd}); assert.deepEqual(b.unguarded?.[0]?.paths,['app/bundles/**']); assert.match(renderBrief(b),/Unguarded paths \(last 10 merges\)/);
    await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',note:'fixture broadens coverage',plan:JSON.stringify({...r.plan,invariants:[{id:'all',run:'true',reads:['**'],timeout_s:10}]})}); assert.deepEqual((await ops.brief({cwd:r.cwd})).unguarded?.[0]?.paths,['app/bundles/**']);
    for(let i=1;i<10;i++) { const m=await r.merge(`n${i}`,`good-${i}`); assert.deepEqual(m.unguarded,[]); }
    const lastSlot=await ops.dispatch({cwd:r.cwd,as:parent,node:'n10'});
    await commitAt(lastSlot.worktree,{'app/value':'good-last'}); await ops.submit({cwd:lastSlot.worktree,as:{role:'writer',id:'n10#1'},node:'n10'}); await ops.attest({cwd:r.cwd,node:'n10'});
    const current=(await ops.readState({cwd:r.cwd})).state;
    await ops.launch({...writerLaunch(current,'n10',projectId(current)),cwd:r.cwd,as:{role:'parent',id:'drive'}});
    const bin=join(r.root,'driver-dsa.mjs'); await writeFile(bin,FAKE); await chmod(bin,0o755);
    const lines:string[]=[]; const driver=new Driver({cwd:r.cwd,dsa:new Dsa({bin}),json:true,log:l=>lines.push(l),handleSignals:false}); await driver.pass(); await driver.settle();
    assert.ok(lines.some(l=>{const x=JSON.parse(l); return x.do==='merge' && x.outcome==='merged' && /Unguarded paths: none/.test(x.detail);}),lines.join('\n'));
    const last=await ops.brief({cwd:r.cwd,since:9999}); assert.equal(last.unguarded?.length,10); assert.equal(last.unguarded?.[0]?.node,'n1'); assert.ok(last.unguarded?.every(m=>m.paths.length===0));
  } finally { await r.done(); }
});

test('SW pi tool runs in the requested repository and exposes the recorded verdict/log', async () => {
  const r=await rig();
  try {
    const {default:owed}=await import('../src/extension.ts'); const tools=new Map<string,ToolDefinition>();
    owed({registerTool(t:ToolDefinition){tools.set(t.name,t);},registerCommand(){}} as unknown as ExtensionAPI);
    const tool=tools.get('owed_sweep'); assert.ok(tool,'owed_sweep registered');
    const ctx={cwd:r.root,hasUI:false,ui:{notify(){}}} as unknown as ExtensionContext;
    const result=await tool.execute('fixture',{cwd:r.cwd,commit:r.base,lease:false},undefined,undefined,ctx as Parameters<ToolDefinition['execute']>[4]);
    assert.equal((result.details as {entry:{verdict:string}}).entry.verdict,'pass');
    assert.match(result.content.map(c=>c.type==='text'?c.text:'').join('\n'),/Sweep #.*pass/);
    assert.equal((await r.entries()).filter(e=>e.kind==='sweep').length,1);
  } finally { await r.done(); }
});

test('SW first-parent bisect excludes a recorded merge reachable only through a second parent', async () => {
  const r=await rig(['a']);
  try {
    await sw(r.cwd); const merged=await r.merge('a','bad');
    const built=await git.buildMerge(r.cwd,r.base,merged.commit,'fixture side ancestry'); assert.ok(!('conflicts' in built));
    await git.advanceTrunk(r.cwd,'main',merged.commit,built.commit); await ops.adopt({cwd:r.cwd,as:owner,channel:'delegated',note:'fixture first-parent bypass'});
    const fail=await sw(r.cwd); assert.equal(fail.entry.verdict,'fail'); assert.equal(fail.first,undefined); assert.deepEqual(fail.steps,[]); assert.match(fail.note!,/no owed merge on the first-parent range/);
  } finally { await r.done(); }
});

test('SW low disk stays eligible for a later idle sweep rather than parking until an unrelated ledger change', async () => {
  const r=await rig([],{drive:{min_free_mb:Number.MAX_SAFE_INTEGER}});
  try {
    const lines:string[]=[]; const driver=new Driver({cwd:r.cwd,stay:true,json:true,log:l=>lines.push(l),handleSignals:false});
    const low=await driver.pass(); assert.equal(low.idle,false); assert.equal((await r.entries()).filter(e=>e.kind==='sweep').length,0); assert.ok(lines.some(l=>JSON.parse(l).node==='disk'));
    await ops.planSet({cwd:r.cwd,as:parent,plan:JSON.stringify({...r.plan,drive:{min_free_mb:0}})});
    await driver.pass(); assert.equal((await r.entries()).filter(e=>e.kind==='sweep').length,1);
  } finally { await r.done(); }
});

test('SW operation lock prevents duplicate once runs; an in-flight node measurement suppresses idle sweep', async () => {
  const r=await rig(); let pending:ReturnType<typeof sw> | undefined;
  try {
    const marker=join(r.root,'started'), gate=join(r.root,'continue');
    await ops.planSet({cwd:r.cwd,as:parent,plan:JSON.stringify({...r.plan,sweep:{run:`touch '${marker}'; for i in $(seq 1 100); do test ! -f '${gate}' || break; sleep .02; done; ${RUN}`,timeout_s:10}})});
    const d=new Driver({cwd:r.cwd,stay:true,json:true,log:()=>{},handleSignals:false});
    d.measuring.set('fixture',{do:'attest',node:'fixture',attempt:1,at:new Date().toISOString(),done:false,ended:Promise.resolve()});
    await d.pass(); assert.equal((await r.entries()).filter(e=>e.kind==='sweep').length,0); d.measuring.clear();
    pending=sw(r.cwd,{once:true}); pending.catch(()=>{}); await until(()=>existsSync(marker),'serialized sweep started');
    await assert.rejects(sw(r.cwd,{once:true}),(e:Error & {code?:string})=>e.code==='busy');
    await writeFile(gate,''); const first=await pending, second=await sw(r.cwd,{once:true});
    assert.equal(second.skipped,true); assert.equal(second.entry.seq,first.entry.seq); assert.equal((await r.entries()).filter(e=>e.kind==='sweep').length,1);
  } finally { await pending?.catch(()=>{}); await r.done(); }
});

test('SW coverage handles glob matching, deleted paths, root files and an all-path invariant', async () => {
  const {unguardedPaths}=await import('../src/sweep.ts');
  const plan=parsePlan(JSON.stringify({version:1,trunk:'main',nodes:[],invariants:[{id:'core',run:'true',reads:['app/core/**','guarded.txt']}]}));
  assert.deepEqual(unguardedPaths(plan,['app/core/gone','app/bundles/nested/gone','app/bundles/file','README.md','guarded.txt','README.md']),['README.md','app/bundles/**']);
  assert.deepEqual(unguardedPaths(plan,['app/bundles/foo/a.ts','app/bundles/bar/b.ts']),['app/bundles/bar/**','app/bundles/foo/**']);
  assert.deepEqual(unguardedPaths({...plan,invariants:[{...plan.invariants[0]!,reads:['**']}]},['root','a/b']),[]);
});

test('SW sweep ledger validates strict fields/authority and replays through the snapshot without acceptance effects', async () => {
  const r=await rig();
  try {
    const run=await sw(r.cwd), {entries,state}=await ops.readState({cwd:r.cwd});
    const draft={kind:'sweep',by:'executor:owed',commit:r.base,verdict:'pass',log:run.entry.log,failed:[]} as Draft;
    assert.deepEqual(validateDraft(state,draft),[]);
    for(const extra of [{by:'parent:drive'},{commit:'bad'},{verdict:'maybe'},{log:'bad'},{failed:[42]},{bisect:false},{counts:{fail:-1}},{unexpected:1}]) assert.ok(validateDraft(state,{...draft,...extra} as Draft).length,JSON.stringify(extra));
    const lookup=()=>parsePlan(JSON.stringify(r.plan)); assert.ok(sameReplay(unpackState(packState(state),lookup),reduce(entries,lookup)));
    const future=newerEntry({...run.entry,verdict:'future'} as unknown as Entry); assert.equal(future?.code,'version'); assert.equal((await ops.verify({cwd:r.cwd})).ok,true);
  } finally { await r.done(); }
});
