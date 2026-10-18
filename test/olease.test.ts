import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import fs, { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import { Dsa } from '../src/dsa.ts';
import { Driver } from '../src/drive-run.ts';
import { runCommand, runJob } from '../src/exec.ts';
import { withMachineLease } from '../src/lease.ts';
import { parsePlan } from '../src/plan.ts';
import { Ledger } from '../src/ledger.ts';
import { writerLaunch, environmentWait, isEnvironment } from '../src/drive.ts';
import { projectId } from '../src/reducer.ts';
import { commitAt } from './helpers/surface.ts';
import { repo } from './helpers/repo.ts';

const owner={role:'owner',id:'fixture'} as const, parent={role:'parent',id:'fixture'} as const;
const pause=(ms:number)=>new Promise<void>(r=>setTimeout(r,ms));
async function until(f:()=>boolean|Promise<boolean>) {
  const end=Date.now()+15000;
  while (!await f()) { assert.ok(Date.now()<end,'bounded fixture wait'); await pause(20); }
}
function alive(pid:number):boolean {
  try { const stat=readFileSync(`/proc/${pid}/stat`,'utf8'); return stat.charAt(stat.lastIndexOf(')')+2)!=='Z'; } catch {return false;}
}
const FAKE=`#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {appendFileSync,existsSync,readFileSync,rmSync} from 'node:fs';
import {join} from 'node:path';
const dir=process.env.OLEASE_FIXTURE,args=process.argv.slice(2),sep=args.indexOf('--');
const path=n=>join(dir,n), log=v=>appendFileSync(path('holds'),JSON.stringify(v)+'\\n');
if(args[0]==='describe'){console.log(JSON.stringify({state:'sealed',status:'done',calls:[{key:'main',gen:1,status:'ok'}]}));process.exit(0);}
log({event:'request',args,pid:process.pid,trees:existsSync(path('prepared'))});
for(const flag of ['--yield','--priority']) if(args.includes(flag)&&existsSync(path('old'+flag))){console.error('pi-durable-subagents: Unknown option '+flag);process.exit(1);}
if(existsSync(path('busy'))){console.error('hold: machine is not free now (fixture); not running the command (exit 75)');process.exit(75);}
const p=spawn(args[sep+1],args.slice(sep+2),{stdio:'inherit'});
let yielded=false;
const timer=args.includes('--yield')?setInterval(()=>{if(existsSync(path('yield-now'))){rmSync(path('yield-now'));yielded=true;p.kill('SIGTERM');}},10):undefined;
for(const sig of ['SIGTERM','SIGINT']) process.on(sig,()=>p.kill(sig));
p.on('close',code=>{clearInterval(timer);let live=false;try{const pid=Number(readFileSync(path('grandchild'),'utf8'));const s=readFileSync('/proc/'+pid+'/stat','utf8');live=s.charAt(s.lastIndexOf(')')+2)!=='Z';}catch{}
log({event:'released',live});if(yielded) console.error('hold: yielded machine to fixture after 1s; the command was stopped (exit 75)');process.exit(yielded?75:(code??1));});
`;
async function rig(extra:Record<string,unknown>={}) {
  const r=await repo(),bin=join(r.root,'dsa.mjs');
  const prior={OWED_DSA:process.env.OWED_DSA,OWED_LEASED:process.env.OWED_LEASED,OLEASE_FIXTURE:process.env.OLEASE_FIXTURE};
  process.env.OWED_DSA=bin; delete process.env.OWED_LEASED; process.env.OLEASE_FIXTURE=r.root;
  await writeFile(bin,FAKE);await chmod(bin,0o755);await r.put('value','base');const base=await r.commit();
  const plan={version:1,trunk:'main',closure:[],lease:false,invariants:[],drive:{min_free_mb:0},nodes:[],...extra};
  await ops.init({cwd:r.cwd,as:owner,channel:'delegated',plan:JSON.stringify(plan),measure:false});
  const path=(s:string)=>join(r.root,s), entries=async()=>(await Ledger.open(r.cwd)).read();
  return {...r,bin,base,plan,path,entries,holds:()=>existsSync(path('holds'))?readFileSync(path('holds'),'utf8').trim().split('\n').map(l=>JSON.parse(l)):[],
    async done(){for(const [k,v] of Object.entries(prior)){if(v===undefined)delete process.env[k];else process.env[k]=v;}await r.cleanup();}};
}
function driver(r:{cwd:string;bin:string},extra:object={}) {
  const d=new Driver({cwd:r.cwd,json:true,log:()=>{},dsa:new Dsa({bin:r.bin}),handleSignals:false,...extra});
  Object.assign(d,{startedAt:Date.now()-61000});return d;
}
const sweep=(run:string)=>({run,timeout_s:30,every:{minutes:1}});

for(const change of ['definition','every','drop','remove sweep'] as const) test(`LZ1 scheduled sweep aborts on ${change} and leaves no verdict or interruption`,async()=>{
  const r=await rig(),started=r.path('started');
  const plan={...r.plan,sweep:sweep(`touch '${started}'; sleep 60`)};
  await ops.planSet({cwd:r.cwd,as:parent,plan:JSON.stringify(plan)});
  const lines:string[]=[],d=driver(r,{log:(l:string)=>lines.push(l)});
  try {
    await d.pass();await until(()=>existsSync(started));
    const next=change==='remove sweep'?undefined:change==='drop'?{run:'true',timeout_s:30}:change==='every'?{...plan.sweep,every:{minutes:2}}:{...plan.sweep,run:'true'};
    await ops.planSet({cwd:r.cwd,as:parent,plan:JSON.stringify({...plan,sweep:next})});
    await d.pass();await d.settle();
    assert.ok(lines.some(l=>{const x=JSON.parse(l);return x.do==='sweep'&&x.outcome==='aborted'&&x.detail==='sweep aborted: plan changed';}),lines.join('\n'));
    assert.deepEqual((await r.entries()).filter(e=>e.kind==='sweep'||e.kind==='note'||e.kind==='halt'),[]);
  }finally{d.abort.abort();await d.settle();await r.done();}
});

test('LZ1 a committing sweep survives a changed policy',async()=>{
  const r=await rig(),started=r.path('started'),gate=r.path('gate');
  const plan={...r.plan,sweep:sweep(`touch '${started}'; while test ! -f '${gate}'; do sleep .02; done`)};
  await ops.planSet({cwd:r.cwd,as:parent,plan:JSON.stringify(plan)});const d=driver(r);
  try {
    await d.pass();await until(()=>existsSync(started));
    // The driver receives this fact from onCommit at its append boundary; exercise that guard independently.
    const run=(d as unknown as {sweepRun:{committing:boolean;abort:AbortController}}).sweepRun;run.committing=true;
    await ops.planSet({cwd:r.cwd,as:parent,plan:JSON.stringify({...plan,sweep:{...plan.sweep,every:{minutes:2}}})});
    await d.pass();assert.equal(run.abort.signal.aborted,false);await writeFile(gate,'');await d.settle();
    assert.equal((await r.entries()).filter(e=>e.kind==='sweep').length,1);
  }finally{await writeFile(gate,'');d.abort.abort();await d.settle();await r.done();}
});

test('LZ2 scheduled yield aborts measurement, records nothing and retries on a later tick',async()=>{
  const r=await rig(),started=r.path('started');
  const plan={...r.plan,lease:true,sweep:sweep(`touch '${started}'; if test ! -f '${r.path('finish')}'; then sleep 60; fi`)};
  await ops.planSet({cwd:r.cwd,as:parent,plan:JSON.stringify(plan)});
  const lines:string[]=[],d=driver(r,{log:(l:string)=>lines.push(l)});
  try {
    await d.pass();await until(()=>existsSync(started));await writeFile(r.path('yield-now'),'');await d.settle();
    assert.ok(r.holds()[0].args.includes('--yield'));
    assert.equal((await r.entries()).filter(e=>e.kind==='sweep'||e.kind==='halt'||e.kind==='note').length,0);
    assert.ok(lines.some(l=>JSON.parse(l).outcome==='busy'),lines.join('\n'));
    const n=r.holds().length;await d.pass();assert.equal(r.holds().length,n);
    await writeFile(r.path('finish'),'');d.tick();await d.pass();await d.settle();
    assert.equal((await r.entries()).filter(e=>e.kind==='sweep'&&e.verdict==='pass').length,1);
  }finally{d.abort.abort();await d.settle();await r.done();}
});

test('LZ2 a busy scheduled acquisition records nothing and retries on a later tick',async()=>{
  const r=await rig({lease:true,sweep:sweep('true')}),d=driver(r);
  try {
    await writeFile(r.path('busy'),'');await d.pass();await d.settle();
    assert.equal((await r.entries()).filter(e=>e.kind==='sweep'||e.kind==='halt').length,0);
    assert.ok(r.holds().find(h=>h.event==='request').args.includes('--yield'));
    const requests=r.holds().length;await d.pass();assert.equal(r.holds().length,requests);
    await rm(r.path('busy'));d.tick();await d.pass();await d.settle();
    assert.equal((await r.entries()).filter(e=>e.kind==='sweep'&&e.verdict==='pass').length,1);
  }finally{d.abort.abort();await d.settle();await r.done();}
});

for(const first of ['hold','holdWhile'] as const) for(const flag of ['--yield','--priority'] as const) test(`LZ2/LZ6 ${first} ${flag} unknown-option fallback retries once and is remembered across clients`,async()=>{
  const r=await rig();await writeFile(r.path('old'+flag),'');
  try {
    for(let i=0;i<2;i++) {
      const dsa=new Dsa({bin:r.bin}),o={shared:true,cwd:r.cwd,yield:flag==='--yield',priority:flag==='--priority'?10:undefined};
      const result=(i===0)===(first==='holdWhile')?await dsa.holdWhile('machine',async()=>42,o):await dsa.hold('machine',['true'],o);
      assert.equal(result.outcome,'ran');
    }
    const requests=r.holds().filter(h=>h.event==='request');
    assert.equal(requests.length,3);assert.ok(requests[0].args.includes(flag));assert.ok(requests.slice(1).every(h=>!h.args.includes(flag)));
  }finally{await r.done();}
});

test('LZ2/LZ6 command output mentioning an unknown priority option never replays the command',async()=>{
  const r=await rig();
  try {
    const result=await new Dsa({bin:r.bin}).hold('machine',['sh','-c',`printf '%s\\n' 'Unknown option --priority'; exit 1`],{priority:10,cwd:r.cwd});
    assert.equal(result.outcome,'ran');assert.equal(r.holds().filter(h=>h.event==='request').length,1);
  }finally{await r.done();}
});

test('LZ4 sweep materializes its tree before requesting the lease and setup runs inside it',async()=>{
  const r=await rig();
  try {
    const gitDir=join(r.cwd,'.git','hooks','post-checkout');
    await writeFile(gitDir,`#!/bin/sh\ntouch '${r.path('prepared')}'\n`);await chmod(gitDir,0o755);
    const plan={...r.plan,lease:true,setup:'test "$OWED_LEASED" = 1 && test -n "$OWED_RUN"',sweep:sweep('test "$OWED_LEASED" = 1 && test -n "$OWED_RUN"')};
    await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',note:'fixture adds lease-checking setup',plan:JSON.stringify(plan)});
    const result=await ops.sweep({cwd:r.cwd,dsa:new Dsa({bin:r.bin})});
    assert.equal(result.entry.verdict,'pass');assert.equal(result.lease,'machine (shared)');
    assert.equal(r.holds().find(h=>h.event==='request').trees,true,'checkout completed before lease request');
    assert.equal(r.holds().filter(h=>h.event==='request').length,1,'one lease spans setup and sweep');
  }finally{await r.done();}
});

function escapedCommand(r:{path:(s:string)=>string},exitNormally=false):string {
  const child=`process.on('SIGTERM',()=>{});setInterval(()=>{},1000);`;
  const script=`const{spawn}=require('node:child_process'),fs=require('node:fs');const p=spawn(process.execPath,['-e',${JSON.stringify(child)}],{detached:true,stdio:'ignore'});fs.writeFileSync(${JSON.stringify(r.path('grandchild'))},String(p.pid));fs.writeFileSync(${JSON.stringify(r.path('tag'))},process.env.OWED_RUN??'');${exitNormally?'p.unref();':'setInterval(()=>{},1000);'}`;
  return `${process.execPath} -e '${script.replace(/'/g,"'\\''")}'`;
}
for(const mode of ['abort','timeout'] as const) test(`LZ3 ${mode} ends a tagged grandchild in its own group before releasing the lease`,{skip:process.platform!=='linux'?'Linux /proc environment tags required':false},async()=>{
  const r=await rig(),ac=new AbortController();let pid=0,unrelated:ReturnType<typeof spawn>|undefined;
  try {
    const plan=parsePlan(JSON.stringify(r.plan));
    const pending=withMachineLease({cwd:r.cwd,dsa:new Dsa({bin:r.bin})},()=>runCommand({plan,signal:ac.signal,abortGraceMs:100},escapedCommand(r),r.cwd,mode==='timeout'?1:30));
    await until(()=>existsSync(r.path('grandchild')));pid=Number(await readFile(r.path('grandchild'),'utf8'));
    assert.ok(alive(pid));
    unrelated=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{env:{...process.env,OWED_RUN:(await readFile(r.path('tag'),'utf8'))+'suffix'},stdio:'ignore'});
    if(mode==='abort')ac.abort();const result=await pending;
    assert.match(result.error??'',mode==='abort'?/aborted/:/timeout after/);
    assert.equal(alive(pid),false,'separate session descendant ended');
    assert.ok((await readFile(r.path('tag'),'utf8')).length>10);
    assert.equal(r.holds().find(h=>h.event==='released').live,false,'release follows tree cleanup');
    assert.ok(alive(unrelated.pid!),'a different exact tag survives');
  }finally{ac.abort();unrelated?.kill('SIGKILL');if(pid&&alive(pid))process.kill(pid,'SIGKILL');await r.done();}
});

test('LZ3 normal exits retain detached descendants and get distinct non-keyed tags',{skip:process.platform!=='linux'?'Linux process fixture':false},async()=>{
  const r=await rig();let pid=0;
  try {
    const plan=parsePlan(JSON.stringify({...r.plan,exec:{env:{OWED_RUN:'plan-value'}}}));
    const result=await runCommand({plan},escapedCommand(r,true),r.cwd,10);pid=Number(await readFile(r.path('grandchild'),'utf8'));
    assert.equal(result.code,0);assert.equal(result.error,undefined);assert.ok(alive(pid),'normal exit is unchanged');
    const tag=await readFile(r.path('tag'),'utf8'),again=await runCommand({plan},'printf "%s" "$OWED_RUN"',r.cwd,10);
    assert.ok(tag.length>10);assert.notEqual(tag,'plan-value');assert.notEqual(tag,again.log);
  }finally{if(pid&&alive(pid))process.kill(pid,'SIGKILL');await r.done();}
});

test('LZ3 cleanup progresses when command timeout timers are virtualized',{timeout:15000},async t=>{
  const r=await rig();
  try {
    const plan=parsePlan(JSON.stringify(r.plan)),started=r.path('started');
    t.mock.timers.enable({apis:['setTimeout']});
    const pending=runCommand({plan},`touch '${started}'; sleep 60`,r.cwd,30);
    const end=Date.now()+10000;
    while(!existsSync(started)){assert.ok(Date.now()<end,'command starts');await new Promise<void>(r=>setImmediate(r));}
    t.mock.timers.tick(30000);
    assert.match((await pending).error??'',/timeout after 30s/);
  }finally{t.mock.timers.reset();await r.done();}
});

test('LZ3 genesis stays measuring until its runtime activity cleanup completes',async t=>{
  const r=await rig({invariants:[{id:'slow',run:'touch "$OLEASE_FIXTURE/started"; sleep 60',reads:['**'],timeout_s:30}]}),started=r.path('started'),ac=new AbortController();
  let release!:()=>void,cleaning!:()=>void;
  const gate=new Promise<void>(r=>{release=r;}),entered=new Promise<void>(r=>{cleaning=r;});
  const unlink=fs.unlink;
  t.mock.method(fs,'unlink',async (...args:Parameters<typeof fs.unlink>)=>{
    if(/attest-.*\.json$/.test(String(args[0]))){cleaning();await gate;}
    return unlink(...args);
  });syncBuiltinESMExports();
  const pending=ops.attestGenesis({cwd:r.cwd,signal:ac.signal});pending.catch(()=>{});
  try {
    await until(()=>existsSync(started));ac.abort();await entered;
    assert.equal((await ops.status({cwd:r.cwd})).genesis?.measuring,true,'runtime file still exists during cleanup');
    release();await assert.rejects(pending,/aborted/);
    assert.equal((await ops.status({cwd:r.cwd})).genesis?.measuring,undefined);
  }finally{release();ac.abort();await pending.catch(()=>{});t.mock.restoreAll();syncBuiltinESMExports();await r.done();}
});

const leaseLines=[
  'hold: machine is not free now (exclusive); not running the command (exit 75)',
  'hold: machine still held by fixture after 2s; not running the command (exit 75)',
  'hold: yielded machine to fixture after 2s; the command was stopped (exit 75)',
];
for(const kind of ['check','inv','red'] as const) for(const [index,line] of leaseLines.entries()) test(`LZ5 ${kind} stable lease line ${index+1} is environmental, including red`,async()=>{
  const r=await rig();
  try {
    const ledger=await Ledger.open(r.cwd),plan=parsePlan(JSON.stringify(r.plan));
    const spec={id:'lease',run:`printf '%s\\n\\n' '${line}'; exit 75`,reads:['**'],timeout_s:10,red_expect:'hold:'};
    const obs=await runJob({cwd:r.cwd,ledger,plan},{kind,subject:kind==='inv'?'trunk':'a',obligation:'check:lease',key:'a'.repeat(64),commit:r.base,base:r.base,spec});
    assert.equal(obs.verdict,'error');assert.equal(obs.exit,75);
    assert.equal(obs.note,`environment: ${index===2?'the check yielded the machine lease':'machine lease not granted; the check did not run'}: ${line}`);
    assert.equal(isEnvironment(obs as Parameters<typeof isEnvironment>[0]),true);
  }finally{await r.done();}
});

test('LZ5 non-matching 75 remains a failure, while matching diagnostics must be the last non-empty line',async()=>{
  const r=await rig();
  try {
    const ledger=await Ledger.open(r.cwd),plan=parsePlan(JSON.stringify(r.plan));
    for(const log of ['hold: machine busy',`${leaseLines[0]}\ncommand failed afterward`,'not hold: machine; not running the command (exit 75)']) {
      const spec={id:'lease',run:`printf '%s\\n' '${log}'; exit 75`,reads:['**'],timeout_s:10};
      const obs=await runJob({cwd:r.cwd,ledger,plan},{kind:'check',subject:'a',obligation:'check:lease',key:'a'.repeat(64),commit:r.base,base:r.base,spec});
      assert.equal(obs.verdict,'fail');assert.doesNotMatch(obs.note??'',/^environment:/);
    }
  }finally{await r.done();}
});

test('LZ5 repeated lease errors use environment backoff instead of the two-errors halt',async()=>{
  const check={id:'lease',run:`printf '%s\\n' '${leaseLines[0]}'; exit 75`,reads:['value'],timeout_s:10};
  const r=await rig({slot_setup:false,nodes:[{id:'a',writes:['value'],checks:[check],review:{count:0,min_rank:1}}]});
  const d=driver(r);
  try {
    const slot=await ops.dispatch({cwd:r.cwd,as:parent,node:'a'}),state=(await ops.readState({cwd:r.cwd})).state;
    await ops.launch({...writerLaunch(state,'a',projectId(state)),cwd:r.cwd,as:{role:'parent',id:'drive'}});
    await commitAt(slot.worktree,{value:'candidate'});await ops.submit({cwd:slot.worktree,as:{role:'writer',id:'a#1'},node:'a'});
    await ops.attest({cwd:r.cwd,node:'a'});await ops.attest({cwd:r.cwd,node:'a',rerun:true});
    const current=(await ops.readState({cwd:r.cwd})).state,n=current.nodes.a!,key=n.candidate!.keys['check:lease']!;
    const wait=environmentWait(current,[{subject:'a',obligation:'check:lease',key}],-1);
    assert.equal(wait?.step,2,'two environmental measurements retain backoff');
    const pass=await d.pass();await d.settle();
    assert.ok(pass.actions.some(a=>a.do==='notify'&&a.text?.includes('environment failure')));
    assert.equal((await r.entries()).filter(e=>e.kind==='halt').length,0);
  }finally{d.abort.abort();await d.settle();await r.done();}
});

test('LZ6 standalone and driver attest/merge holds use priority 10',async()=>{
  const r=await rig({lease:true,slot_setup:false,nodes:[{id:'a',writes:['value'],checks:[],review:{count:0,min_rank:1}}]});
  try {
    const slot=await ops.dispatch({cwd:r.cwd,as:parent,node:'a'}),state=(await ops.readState({cwd:r.cwd})).state;
    await ops.launch({...writerLaunch(state,'a',projectId(state)),cwd:r.cwd,as:{role:'parent',id:'drive'}});
    await commitAt(slot.worktree,{value:'candidate'});await ops.submit({cwd:slot.worktree,as:{role:'writer',id:'a#1'},node:'a'});
    const d=driver(r,{owed:['true']});await d.pass();await d.settle();
    const first=r.holds().filter(h=>h.event==='request');assert.equal(first.length,1);assert.ok(first[0].args.includes('--priority'));assert.equal(first[0].args[first[0].args.indexOf('--priority')+1],'10');
    await ops.attest({cwd:r.cwd,node:'a'});
    await writeFile(r.path('busy'),'');d.tick();await d.pass();await d.settle();
    await rm(r.path('busy'));await ops.merge({cwd:r.cwd,node:'a',as:parent});
    const requests=r.holds().filter(h=>h.event==='request');assert.equal(requests.length,4);
    assert.ok(requests.every(h=>h.args[h.args.indexOf('--priority')+1]==='10'));
  }finally{await r.done();}
});
