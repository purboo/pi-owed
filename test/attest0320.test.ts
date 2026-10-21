// MV1-MV5: isolated command-call dsa, never the installed service.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import { Dsa } from '../src/dsa.ts';
import { Driver, reportText } from '../src/drive-run.ts';
import { driveStatus, driveStop, inFlightText, measuringOf } from '../src/drive-bg.ts';
import { Ledger } from '../src/ledger.ts';
import { writerLaunch } from '../src/drive.ts';
import { projectId } from '../src/reducer.ts';
import { repo } from './helpers/repo.ts';
import { commitAt } from './helpers/surface.ts';

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
async function until(f: () => boolean | Promise<boolean>, label: string, ms = 10_000) {
  const end = Date.now() + ms;
  while (!await f()) { assert.ok(Date.now() < end, `timed out: ${label}`); await sleep(25); }
}
const FAKE = `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync, openSync, closeSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.env.ATTEST_DSA_DIR, args = process.argv.slice(2);
const path = n => join(dir,n), read = n => JSON.parse(readFileSync(path(n),'utf8'));
const log = value => appendFileSync(path('calls'), JSON.stringify({...value,at:Date.now()})+'\\n');
const reply = (value,code=0) => { console.log(JSON.stringify(value)); process.exit(code); };
if (args[0] === '--help') { log({kind:'help'}); console.log(read('control').old ? 'run --request <id> --spec <file> --session <id>' : 'run --request <id> --spec <file> --session <id> -- <program> [args…]'); process.exit(0); }
if (args[0] === '__runner') {
  const record = read(args[1]), spec = record.spec, out = openSync(path(record.rid+'.out'),'a');
  const p = spawn(spec.command[0],spec.command.slice(1),{env:{...process.env,...spec.env,DSA_EXEC:'fake-exec',DSA_CALL:'fake-call'},stdio:['ignore',out,out]});
  closeSync(out);
  for (const sig of ['SIGTERM','SIGINT']) process.on(sig,()=>p.kill(sig));
  p.on('close',(code,signal)=>{
    const control=read('control');
    const status=read(record.rid+'.json').stopped?'stopped':control.seal??(code===0?'ok':'failed');
    writeFileSync(path(record.rid+'.json'),JSON.stringify({...read(record.rid+'.json'),state:'sealed',calls:[{key:'main',gen:1,phase:'sealed',status,output:readFileSync(path(record.rid+'.out'),'utf8'),data:control.noData?{}:{exitCode:code,signal}}]}));
  });
} else if (args[0] === 'run') {
  let input=''; for await (const b of process.stdin) input+=b;
  const rid=args[args.indexOf('--request')+1], spec=JSON.parse(input), control=read('control');
  log({kind:'run',args,rid,spec});
  if (control.refusal) reply({reason:control.refusal},1);
  const file=rid+'.json';
  if (existsSync(path(file))) reply({wid:read(file).wid,created:false,spec_digest:'fixture'});
  const record={rid,wid:'wf-'+rid,state:'running',spec,calls:[{key:'main',phase:'running'}]};
  writeFileSync(path(file),JSON.stringify(record));
  const p=spawn(process.execPath,[process.argv[1],'__runner',file],{detached:true,stdio:'ignore'}); p.unref();
  writeFileSync(path(file),JSON.stringify({...record,pid:p.pid}));
  reply({wid:record.wid,created:true,spec_digest:'fixture'},control.pending?75:0);
} else if (args[0] === 'describe') {
  const rid=args[args.indexOf('--key')+1]; log({kind:'describe',rid});
  if (rid.startsWith('owed-attest-') && read('control').describeError) { console.error('status transport tail'); process.exit(2); }
  if (existsSync(path(rid+'.json'))) reply(read(rid+'.json'));
  reply({state:'sealed',status:'done',calls:[{key:'main',gen:1,status:'ok'}]});
} else if (args[0] === 'stop') {
  const target=args[args.indexOf('--request')+2]; log({kind:'stop',args,target});
  const file=target.replace(/^wf-/,'')+'.json', record=read(file);
  writeFileSync(path(file),JSON.stringify({...record,stopped:true}));
  try { process.kill(record.pid,'SIGTERM'); } catch {}
  reply({applied:true});
} else if (args[0] === 'hold') {
  const split=args.indexOf('--'); log({kind:'hold',args,marker:process.env.OWED_LEASED});
  const p=spawn(args[split+1],args.slice(split+2),{stdio:'inherit'});
  for (const sig of ['SIGTERM','SIGINT']) process.on(sig,()=>p.kill(sig));
  p.on('close',(code,signal)=>process.exit(code??143));
} else process.exit(2);
`;
const COMMAND = `import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
const dir=process.env.ATTEST_DSA_DIR, path=n=>join(dir,n);
writeFileSync(path('measured'),JSON.stringify({marker:process.env.OWED_LEASED,args:process.argv.slice(2)}));
while (JSON.parse(readFileSync(path('control'),'utf8')).gate && !existsSync(path('release'))) await new Promise(r=>setTimeout(r,25));
const control=JSON.parse(readFileSync(path('control'),'utf8'));
console.error(control.tail??'attest fixture output tail');
if (control.signal) process.kill(process.pid,control.signal); else process.exit(control.exit??1);
`;
type Call = { kind: string; at: number; rid?: string; target?: string; args?: string[]; marker?: string; spec?: { command: string[]; env?: Record<string,string>; name?: string; cwd?: string } };
async function rig(control: Record<string,unknown> = {}, session: string | null = 'owner-session', lease = true) {
  const r = await repo(), bin=join(r.root,'fake-dsa.mjs'), command=join(r.root,'attest.mjs');
  const prior={OWED_DSA:process.env.OWED_DSA,ATTEST_DSA_DIR:process.env.ATTEST_DSA_DIR,OWED_LEASED:process.env.OWED_LEASED,DSA_SESSION:process.env.DSA_SESSION};
  process.env.OWED_DSA=bin; process.env.ATTEST_DSA_DIR=r.root; delete process.env.OWED_LEASED;
  // An unrelated environment identity must not replace the explicit driver/lock owner.
  process.env.DSA_SESSION='unrelated-session';
  const calls=():Call[] => existsSync(join(r.root,'calls')) ? readFileSync(join(r.root,'calls'),'utf8').trim().split('\n').filter(Boolean).map(l=>JSON.parse(l)) : [];
  const logs: Record<string,unknown>[]=[];
  await writeFile(bin,FAKE); await chmod(bin,0o755); await writeFile(command,COMMAND); await writeFile(join(r.root,'control'),JSON.stringify(control));
  await r.put('base','fixture'); await r.commit();
  await ops.init({cwd:r.cwd,as:{role:'owner',id:'test'},channel:'flag',measure:false,plan:JSON.stringify({version:1,trunk:'main',lease,closure:[],invariants:[],drive:{min_free_mb:0},nodes:[{id:'a',writes:['a.txt'],checks:[],review:{count:0,min_rank:1}}]})});
  const d=await ops.dispatch({cwd:r.cwd,node:'a',as:{role:'parent',id:'test'}});
  const state=await ops.loadDriverState(await Ledger.open(r.cwd));
  await ops.launch({...writerLaunch(state,'a',projectId(state)),cwd:r.cwd,as:{role:'parent',id:'drive'}});
  const candidate=await commitAt(d.worktree,{'a.txt':'candidate'});
  await ops.submit({cwd:d.worktree,node:'a',as:{role:'writer',id:'a#1'}});
  const client=()=>new Dsa({bin,timeoutMs:2000,waitMs:0});
  const driver=(owed=[process.execPath,command])=>new Driver({cwd:r.cwd,session,dsa:client(),owed,pollMs:50,json:true,handleSignals:false,log:l=>logs.push(JSON.parse(l))});
  const newCandidate=async()=>{ const commit=await commitAt(d.worktree,{'a.txt':'new candidate'}); await ops.submit({cwd:d.worktree,node:'a',as:{role:'writer',id:'a#1'}}); return commit; };
  const drivers:Driver[]=[];
  return {...r,bin,command,candidate,newCandidate,calls,logs,client,driver:(owed?:string[])=>{const d=driver(owed);drivers.push(d);return d;},path:(n:string)=>join(r.root,n),
    control:async (c:Record<string,unknown>)=>writeFile(join(r.root,'control'),JSON.stringify({...control,...c})),
    async done(){
      await writeFile(join(r.root,'release'),'');
      for (const d of drivers) { d.hard=true; d.abort.abort(); d.dsa.killAll(); await d.drain(5000); }
      for (const c of calls().filter(c=>c.kind==='run')) {
        const record=JSON.parse(await readFile(join(r.root,c.rid+'.json'),'utf8').catch(()=>'{}')) as {pid?:number};
        if (record.pid) { try { process.kill(-record.pid,'SIGTERM'); } catch {} }
      }
      for (const [k,v] of Object.entries(prior)) if (v===undefined) delete process.env[k]; else process.env[k]=v;
      await r.cleanup();
    }};
}

for (const exit of [0,1,4,75,2]) test(`MV1/MV2 command call preserves attest exit ${exit}`, {timeout:30_000}, async()=>{
  const f=await rig({exit});
  try {
    const d=f.driver(); await d.pass(); await d.settle();
    const run=f.calls().find(c=>c.kind==='run'); assert.ok(run,'attest must be a dsa command call');
    assert.equal(run.args?.[run.args.indexOf('--session')+1],'owner-session');
    const labels=JSON.parse(run.args![run.args!.indexOf('--labels')+1]!);
    assert.equal(labels.owed,d.project); assert.equal(labels.node,'a'); assert.equal(labels.attempt,'1'); assert.equal(labels.candidate,f.candidate);
    assert.equal(run.spec?.name,'owed attest a'); assert.equal(run.spec?.cwd,f.cwd);
    assert.deepEqual(run.spec?.command,[f.bin,'hold','machine','--shared','--priority','10','--no-wait','--',process.execPath,f.command,'attest','a']);
    assert.equal(run.spec?.env?.OWED_LEASED,'1');
    assert.equal(run.spec?.env?.OWED_DIR,f.path('ledger'));
    assert.equal(run.spec?.env?.DSA_SESSION,undefined);
    assert.equal(run.spec?.env?.NODE_TEST_CONTEXT,undefined);
    assert.equal(JSON.parse(await readFile(f.path('measured'),'utf8')).marker,'1');
    const end=f.logs.find(l=>l.do==='attest' && l.outcome!=='started');
    assert.equal(end?.outcome,[0,1,4].includes(exit)?'done':exit===75?'busy':'error');
    assert.equal(end?.rid,run.rid); assert.ok(reportText(end!).includes(run.rid!));
    const halts=(await (await Ledger.open(f.cwd)).read()).filter(e=>e.kind==='halt');
    assert.equal(halts.length,exit===2?1:0);
    if (exit===2) assert.match(halts[0]!.reason,new RegExp(`${run.rid}.*attest fixture output tail`));
    if (exit===75) {
      const n=f.calls().filter(c=>c.kind==='run').length; await d.pass(); assert.equal(f.calls().filter(c=>c.kind==='run').length,n,'busy back-off retains no same-cycle retry');
    }
    assert.equal(f.calls().filter(c=>c.kind==='help').length,1);
  } finally {await f.done();}
});

for (const [name,control,session] of [
  ['no owner',{},null], ['old dsa',{old:true},'owner-session'],
  ['unsupported command',{refusal:'command calls are not supported'},'owner-session'],
  ['unsupported session',{refusal:'Unknown or repeated option --session'},'owner-session'],
] as const) test(`MV4 ${name} uses the old attest path with one explanation`,{timeout:30_000},async()=>{
  const f=await rig(control,session);
  try {
    const d=f.driver(); await d.pass(); await d.settle(); d.tick(); await d.pass(); await d.settle();
    assert.ok(f.calls().some(c=>c.kind==='hold')); assert.ok(existsSync(f.path('measured')));
    assert.equal(f.logs.filter(l=>l.event==='attest-unlisted').length,1);
    assert.match(reportText(f.logs.find(l=>l.event==='attest-unlisted')!),/driver.*not shown in \/subagents/);
    assert.ok(!f.logs.some(l=>l.do==='attest' && l.outcome==='error'));
    if (name==='no owner'||name==='old dsa') assert.ok(!f.calls().some(c=>c.kind==='run'));
    else assert.equal(f.calls().filter(c=>c.kind==='run').length,1,'unsupported launch is cached, never relaunched without session');
  } finally {await f.done();}
});

test('MV2 launch refusal halts with the deterministic run id and refusal tail, without falling back',{timeout:30_000},async()=>{
  const f=await rig({refusal:'permission denied by dsa'});
  try {
    const d=f.driver(); await d.pass(); await d.settle();
    const run=f.calls().find(c=>c.kind==='run'); assert.ok(run);
    assert.ok(!f.calls().some(c=>c.kind==='hold')); assert.ok(!existsSync(f.path('measured')));
    const halt=(await (await Ledger.open(f.cwd)).read()).find(e=>e.kind==='halt');
    assert.ok(halt); assert.match(halt.reason,new RegExp(`${run.rid}.*permission denied`));
  } finally {await f.done();}
});

for (const control of [{signal:'SIGTERM'},{seal:'unknown'},{seal:'stopped'},{seal:'failed',noData:true},{seal:'failed',exit:0}]) test(`MV2 invalid/signal seal halts: ${JSON.stringify(control)}`,{timeout:30_000},async()=>{
  const f=await rig(control);
  try {
    const d=f.driver(); await d.pass(); await d.settle();
    const run=f.calls().find(c=>c.kind==='run'); assert.ok(run);
    const halt=(await (await Ledger.open(f.cwd)).read()).find(e=>e.kind==='halt'); assert.ok(halt);
    assert.match(halt.reason,new RegExp(run.rid!));
  } finally {await f.done();}
});

test('MV2/MV3 pending launch and restart reuse the request id, graceful drain waits, hard stop uses dsa stop',{timeout:30_000},async()=>{
  const f=await rig({pending:true,gate:true});
  try {
    const first=f.driver(); await first.pass(); await until(()=>f.calls().some(c=>c.kind==='run'),'first run');
    const second=f.driver(); await second.pass(); await until(()=>f.calls().filter(c=>c.kind==='run').length===2,'reused launch');
    const runs=f.calls().filter(c=>c.kind==='run'); assert.equal(runs[0]!.rid,runs[1]!.rid);
    assert.deepEqual(runs[0]!.spec,runs[1]!.spec,'same request has byte-equivalent spec');
    assert.equal(new Set(runs.map(r=>r.rid)).size,1);
    await until(()=>existsSync(f.path('measured')),'attest started');
    first.stopping=true; assert.equal(await first.drain(100),false,'graceful stop keeps waiting');
    assert.ok(!f.calls().some(c=>c.kind==='stop'));
    const open=measuringOf(f.logs.map(l=>JSON.stringify(l))); assert.equal(open[0]?.rid,runs[0]!.rid);
    assert.match(inFlightText(open[0]!),new RegExp(runs[0]!.rid!));
    first.hard=true; first.abort.abort(); await first.drain(5000);
    await until(()=>f.calls().some(c=>c.kind==='stop'),'dsa stop');
    const stop=f.calls().find(c=>c.kind==='stop')!; assert.equal(stop.target,'wf-'+runs[0]!.rid);
    await second.settle();
    const descriptions=f.calls().filter(c=>c.kind==='describe'&&c.rid===runs[0]!.rid);
    assert.ok(descriptions.length>0 && descriptions.length<50,'bounded status polling');
  } finally {await f.done();}
});

test('MV4 lease opt-out still shows a command call but never acquires a lease',{timeout:30_000},async()=>{
  const f=await rig({},'owner-session',false);
  try {
    const d=f.driver(); await d.pass(); await d.settle();
    const run=f.calls().find(c=>c.kind==='run'); assert.ok(run);
    assert.deepEqual(run.spec?.command,[process.execPath,f.command,'attest','a','--no-lease']);
    assert.equal(run.spec?.env?.OWED_LEASED,undefined); assert.ok(!f.calls().some(c=>c.kind==='hold'));
  } finally {await f.done();}
});


test('MV2 describe failure halts with run id and output tail, never executes legacy attest',{timeout:30_000},async()=>{
  const f=await rig({describeError:true,gate:true});
  try {
    const d=f.driver(); await d.pass(); await d.settle();
    const run=f.calls().find(c=>c.kind==='run'); assert.ok(run);
    const halt=(await (await Ledger.open(f.cwd)).read()).find(e=>e.kind==='halt'); assert.ok(halt);
    assert.match(halt.reason,new RegExp(`${run.rid}.*status transport tail`));
  } finally {await f.done();}
});

test('MV2 a changed candidate/start ledger length gets a different request id',{timeout:30_000},async()=>{
  const f=await rig();
  try {
    const d=f.driver(); await d.pass(); await d.settle();
    const old=f.calls().find(c=>c.kind==='run')!;
    const candidate=await f.newCandidate(); d.tick(); await d.pass(); await d.settle();
    const latest=f.calls().filter(c=>c.kind==='run').at(-1)!;
    assert.notEqual(old.rid,latest.rid);
    assert.equal(JSON.parse(latest.args![latest.args!.indexOf('--labels')+1]!).candidate,candidate);
  } finally {await f.done();}
});

test('MV3 real owed attest K1 remains locked by the command across driver restart',{timeout:40_000},async()=>{
  const f=await rig();
  try {
    const plan=(await ops.loadDriverState(await Ledger.open(f.cwd))).plan;
    await ops.planSet({cwd:f.cwd,as:{role:'parent',id:'test'},plan:JSON.stringify({...plan,nodes:[{...plan.nodes[0],checks:[{id:'slow',reads:['a.txt'],min_tests:1,timeout_s:15,run:`echo started > '${f.path('check-started')}'; while [ ! -f '${f.path('release')}' ]; do sleep 0.05; done; printf '1..1\\nok 1 - held\\n'`}] }]})});
    await f.newCandidate();
    const owed=[process.execPath,fileURLToPath(new URL('../bin/owed.js',import.meta.url))];
    const first=f.driver(owed); await first.pass(); await until(()=>existsSync(f.path('check-started')),'real check under K1');
    // An unrelated ledger entry changes the next start id; K1, not the process-local map, prevents another check.
    await ops.rule({cwd:f.cwd,as:{role:'parent',id:'test'},nodes:'*',text:'restart fixture',prospective:true});
    const second=f.driver(owed); await second.pass();
    await until(()=>f.logs.some(l=>l.do==='attest'&&l.outcome==='busy'),'restarted pass sees K1 busy');
    const runs=f.calls().filter(c=>c.kind==='run'); assert.equal(runs.length,2); assert.notEqual(runs[0]!.rid,runs[1]!.rid);
    assert.ok(f.logs.some(l=>l.outcome==='busy'&&/another attest of a/.test(String(l.detail))));
    await writeFile(f.path('release'),''); await first.settle(); await second.settle();
    const es=await (await Ledger.open(f.cwd)).read();
    assert.equal(es.filter(e=>e.kind==='obs'&&e.obligation==='check:slow').length,1,'no concurrent second check');
    assert.ok(!es.some(e=>e.kind==='halt'));
  } finally {await f.done();}
});

test('MV3/MV5 CLI hard stop uses dsa stop; status retains its form and names lock owner/run',{timeout:30_000},async()=>{
  const f=await rig({gate:true});
  const script=f.path('drive.mjs'), logfile=join(f.path('ledger'),'drive','log.jsonl');
  await mkdir(join(f.path('ledger'),'drive'),{recursive:true});
  await writeFile(script,`import { drive } from ${JSON.stringify(new URL('../src/drive-run.ts',import.meta.url).href)}; import { Dsa } from ${JSON.stringify(new URL('../src/dsa.ts',import.meta.url).href)}; import { appendFileSync } from 'node:fs'; process.exitCode=await drive({cwd:${JSON.stringify(f.cwd)},session:'owner-session',json:true,pollMs:50,owed:[process.execPath,${JSON.stringify(f.command)}],dsa:new Dsa({bin:${JSON.stringify(f.bin)},timeoutMs:1000}),log:l=>appendFileSync(${JSON.stringify(logfile)},l+'\\n')});`);
  const child=spawn(process.execPath,[script],{env:{...process.env,NODE_TEST_CONTEXT:undefined},stdio:['ignore','pipe','pipe']});
  let stderr=''; child.stderr!.on('data',b=>{stderr+=b;});
  const closed=new Promise<number|null>(resolve=>child.on('close',resolve));
  try {
    await until(()=>existsSync(f.path('measured')),'CLI measurement');
    await until(async()=>!!(await driveStatus({cwd:f.cwd})).measuring?.some(m=>m.rid),'status run id');
    const status=await driveStatus({cwd:f.cwd}); assert.equal(status.session,'owner-session');
    assert.match(inFlightText(status.measuring![0]!),/^a attest since .* \[owed-attest-/);
    const stopped=await driveStop({cwd:f.cwd,now:true,waitMs:8000}); assert.equal(stopped.state,'stopped',stderr);
    assert.equal(await closed,130,stderr); assert.ok(f.calls().some(c=>c.kind==='stop'));
    assert.equal((await driveStatus({cwd:f.cwd})).running,false);
  } finally {child.kill('SIGKILL'); await closed; await f.done();}
});
