// SF: real CLI, extension worker and detached driver; fake dsa avoids external jobs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';
import * as ops from '../src/ops.ts';
import { git } from '../src/git.ts';
import { Ledger } from '../src/ledger.ts';
import { driveStatus, driveStop } from '../src/drive-bg.ts';
import { repo } from './helpers/repo.ts';
import { identity } from './helpers/surface.ts';

const OWED = fileURLToPath(new URL('../bin/owed.js', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures/fake-dsa.mjs', import.meta.url));
const core = ['owed_decide', 'owed_drive', 'owed_review', 'owed_start', 'owed_status', 'owed_submit', 'owed_why'];
const plan = (extra: object = {}) => ({ version:1, trunk:'main', closure:[], invariants:[], nodes:[{ id:'a', later:true, writes:['a.txt'], checks:[], review:{count:1,min_rank:1} }], ...extra });
const entries = async (cwd: string) => (await Ledger.open(cwd)).read();
async function env<T>(extra: Record<string,string | undefined>, run: () => Promise<T>): Promise<T> {
  const prior = new Map(Object.keys(extra).map(k => [k, process.env[k]]));
  for (const [k,v] of Object.entries(extra)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try { return await run(); } finally { for (const [k,v] of prior) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}
function harness(cwd: string, host: 'new' | 'old' | 'missing' | 'loading' = 'new') {
  const tools = new Map<string, ToolDefinition>(), handlers = new Map<string, (e: unknown, ctx: ExtensionContext) => unknown>();
  let loading = host === 'loading', prompts = 0;
  const api = {
    registerTool(t: ToolDefinition) { tools.set(t.name,t); }, registerCommand() {}, sendMessage() {},
    on(name: string, h: (e: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name,h); },
    ...(host === 'missing' ? {} : { getAllTools() {
      if (loading) throw new Error('Extension runtime not initialized');
      return [{name:'read', ...(host === 'old' ? {} : {exposure:'direct'})}, ...[...tools.values()].map(t => ({name:t.name, ...(host === 'old' ? {} : {exposure:t.exposure})}))];
    } }),
  };
  const ctx = {cwd,hasUI:true,ui:{notify() {},confirm() { prompts++; throw new Error('start must not open a dialog'); }}} as unknown as ExtensionContext;
  owed(api as unknown as ExtensionAPI);
  return { tools, get prompts() { return prompts; }, async call(name: string, args: object = {}) {
    const tool = tools.get(`owed_${name}`); assert.ok(tool, `${name} registered`);
    const r = await tool.execute('test',args,undefined,undefined,ctx as Parameters<ToolDefinition['execute']>[4]);
    return {...r,text:r.content.map(c => c.type === 'text' ? c.text : '').join('\n')};
  }, async startSession() { loading=false; await handlers.get('session_start')?.({},ctx); }, async shutdown() { await handlers.get('session_shutdown')?.({},ctx); } };
}
async function cli(cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  const childEnv = {...process.env,...identity,OWED_CONFIRM:'',OWED_DSA:FAKE,...extra};
  try { return {code:0,...await promisify(execFile)(process.execPath,[OWED,...args],{cwd,env:childEnv,timeout:45_000,maxBuffer:2*1024*1024})}; }
  catch (e) { const r=e as {code:number;stdout:string;stderr:string}; if (typeof r.code !== 'number') throw e; return r; }
}
async function fixture(p = plan()) {
  const r = await repo();
  const vars = {OWED_CONFIRM:process.env.OWED_CONFIRM,OWED_DSA:process.env.OWED_DSA,FAKE_DSA_DIR:process.env.FAKE_DSA_DIR};
  process.env.OWED_CONFIRM=''; process.env.OWED_DSA=FAKE; process.env.FAKE_DSA_DIR=join(r.root,'dsa');
  await r.put('plan.json',JSON.stringify(p)); await r.commit();
  return {...r, async done() {
    const d = await driveStatus({cwd:r.cwd}).catch(() => undefined);
    if (d?.running) {
      await driveStop({cwd:r.cwd,now:true,waitMs:5_000}).catch(() => undefined);
      if ((await driveStatus({cwd:r.cwd})).running && d.pid) { try { process.kill(-d.pid,'SIGKILL'); } catch { /* already stopped */ } }
    }
    for (const [k,v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k]=v;
    await r.cleanup();
  }};
}
const compact = (text: string) => assert.ok(text.trim().split('\n').length <= 3, text);

test('SF1 core declares exactly seven tools, keeps deferred tools registered and explains discovery', async () => {
  await env({OWED_TOOLS:undefined},async () => {
    const h=harness('/tmp');
    try {
      assert.deepEqual([...h.tools.values()].filter(t => t.exposure === 'direct').map(t => t.name).sort(),core);
      assert.ok(h.tools.size > core.length);
      for (const t of h.tools.values()) if (core.includes(t.name)) assert.match(t.description,/tool_search/); else assert.equal(t.exposure,'deferred',t.name);
    } finally { await h.shutdown(); }
  });
});
test('SF1 OWED_TOOLS=all declares every registered tool directly', async () => {
  await env({OWED_TOOLS:'all'},async () => {
    const h=harness('/tmp');
    try { assert.ok(h.tools.has('owed_start')); for (const t of h.tools.values()) assert.equal(t.exposure,'direct',t.name); }
    finally { await h.shutdown(); }
  });
});
test('SF1 unsupported host APIs fall back to direct without relying on a pi version', async () => {
  await env({OWED_TOOLS:undefined},async () => {
    for (const host of ['old','missing'] as const) {
      const h=harness('/tmp',host);
      try { assert.ok(h.tools.has('owed_start')); for (const t of h.tools.values()) assert.equal(t.exposure,'direct'); }
      finally { await h.shutdown(); }
    }
  });
});
test('SF1 unbound loading API falls back, then detects exposure before the first session turn', async () => {
  await env({OWED_TOOLS:undefined,DSA_CALL:'fixture'},async () => {
    const h=harness('/tmp','loading');
    try {
      for (const t of h.tools.values()) assert.equal(t.exposure,'direct');
      await h.startSession();
      assert.deepEqual([...h.tools.values()].filter(t => t.exposure === 'direct').map(t => t.name).sort(),core);
    } finally { await h.shutdown(); }
  });
});

test('SF2 CLI fresh start initializes delegated owner, starts a staying driver and second start records nothing', {timeout:90_000},async () => {
  const f=await fixture();
  try {
    const first=await cli(f.cwd,['start','--plan','plan.json','--max','2','--stay']);
    assert.equal(first.code,0,first.stderr); compact(first.stdout); assert.match(first.stdout,/initialized ledger/); assert.match(first.stdout,/warning: node a has no checks/);
    const before=await entries(f.cwd), genesis=before[0]!;
    assert.equal(genesis.kind,'genesis'); assert.equal(genesis.by,'owner:pi'); assert.equal(genesis.channel,'delegated');
    assert.equal(genesis.kind === 'genesis' && genesis.path,'plan.json');
    const driver=await driveStatus({cwd:f.cwd}); assert.equal(driver.running,true);
    const again=await cli(f.cwd,['start']); assert.equal(again.code,0,again.stderr); compact(again.stdout); assert.match(again.stdout,/already running/);
    assert.deepEqual(await entries(f.cwd),before);
    assert.equal((await driveStatus({cwd:f.cwd})).pid,driver.pid);
    assert.equal(existsSync(`${driver.log}.1`),false,'no rotation of the live driver log');
    assert.equal((await ops.verify({cwd:f.cwd})).ok,true);
  } finally { await f.done(); }
});
test('SF2 fresh start leaves genesis measurement to the driver and passes max to dispatch', {timeout:90_000},async () => {
  const p=plan({invariants:[{id:'health',run:'true'}]}); p.nodes[0]!.later=false;
  p.nodes.push({...p.nodes[0]!,id:'b',writes:['b.txt']});
  const f=await fixture(p);
  try {
    const agents=join(process.env.FAKE_DSA_DIR!,'agents'); await mkdir(agents,{recursive:true});
    await writeFile(join(agents,'a-writer.sh'),`echo done > a.txt; git add a.txt; git commit -qm done; "${process.execPath}" "${OWED}" submit a`);
    const out=await cli(f.cwd,['start','--plan','plan.json','--max','1','--stay']);
    assert.equal(out.code,0,out.stderr); compact(out.stdout);
    const deadline=Date.now()+30_000;
    let es=await entries(f.cwd);
    while (!es.some(e => e.kind === 'dispatch') || !es.some(e => e.kind === 'obs' && e.obligation === 'inv:health')) {
      if (Date.now() > deadline) assert.fail(`driver did not dispatch and measure genesis: ${JSON.stringify(es)}`);
      await new Promise(r => setTimeout(r,50)); es=await entries(f.cwd);
    }
    assert.equal(es.filter(e => e.kind === 'genesis').length,1);
    assert.equal(es.find(e => e.kind === 'obs' && e.obligation === 'inv:health')!.kind,'obs');
    assert.equal((await ops.genesisPending({cwd:f.cwd})).length,0);
    assert.equal(es.filter(e => e.kind === 'dispatch').length,1,'max 1 prevents a second open attempt while a awaits review');
  } finally { await f.done(); }
});
test('SF2 owed_start uses cwd, returns compact output and never opens an owner dialog', {timeout:90_000},async () => {
  const f=await fixture(), h=harness(f.root);
  try {
    const first=await env(identity,() => h.call('start',{cwd:f.cwd,plan:'plan.json',stay:true,max:1}));
    assert.notEqual(first.isError,true,first.text); compact(first.text); assert.equal(h.prompts,0);
    assert.equal((await driveStatus({cwd:f.cwd})).running,true);
    const before=await entries(f.cwd);
    const again=await env(identity,() => h.call('start',{cwd:f.cwd}));
    assert.notEqual(again.isError,true,again.text); assert.match(again.text,/already running/); assert.deepEqual(await entries(f.cwd),before);
  } finally { await h.shutdown(); await f.done(); }
});
test('SF2 start rereads the latest plan path, records a changed plan once, and ignores formatting-only changes', {timeout:90_000},async () => {
  const f=await fixture();
  try {
    assert.equal((await cli(f.cwd,['start','--plan','plan.json','--stay'])).code,0);
    const next=plan(); next.nodes[0]!.review.count=2; await f.put('plan.json',JSON.stringify(next));
    const changed=await cli(f.cwd,['start']); assert.equal(changed.code,0,changed.stderr); compact(changed.stdout); assert.match(changed.stdout,/updated plan[\s\S]*already running/);
    const before=await entries(f.cwd); assert.equal(before.at(-1)!.kind,'plan'); assert.equal(before.at(-1)!.by,'parent:pi');
    await f.put('plan.json',JSON.stringify(next,null,2));
    const same=await cli(f.cwd,['start']); assert.equal(same.code,0,same.stderr); assert.deepEqual(await entries(f.cwd),before);
  } finally { await f.done(); }
});
test('SF2 start accepts a downgrade only under the current allowance', {timeout:90_000},async () => {
  const p=plan({allow:[{nodes:['a'],writes:['extra/']}]});
  const f=await fixture(p);
  try {
    assert.equal((await cli(f.cwd,['start','--plan','plan.json','--stay'])).code,0);
    p.nodes[0]!.writes.push('extra/'); await f.put('plan2.json',JSON.stringify(p));
    const out=await cli(f.cwd,['start','--plan','plan2.json']); assert.equal(out.code,0,out.stderr);
    const law=(await entries(f.cwd)).at(-1)!; assert.equal(law.kind,'plan'); assert.equal(law.by,'parent:pi');
    assert.equal((await ops.report({cwd:f.cwd})).downgrades.at(-1)!.allowance,0);
    assert.equal((await cli(f.cwd,['start'])).code,0,'subsequent start follows plan2.json');
  } finally { await f.done(); }
});
test('SF4 missing plan and opt-in owner confirmation refuse as usage, record nothing, and give explicit fixes', async () => {
  const f=await fixture(), h=harness(f.cwd);
  try {
    const missing=await cli(f.cwd,['start']); assert.equal(missing.code,2); assert.match(missing.stderr,/preflight plan failed.*owed start --plan <file>/);
    const confirm=await cli(f.cwd,['start','--plan','plan.json'],{OWED_CONFIRM:'owner'});
    assert.equal(confirm.code,2); assert.match(confirm.stderr,/preflight owner confirmation failed.*owed init/);
    assert.equal(confirm.stderr.trim().split('\n').length,1);
    const tool=await env({...identity,OWED_CONFIRM:'owner'},() => h.call('start',{plan:'plan.json'}));
    assert.equal(tool.isError,true); assert.equal((tool.details as {code:string}).code,'usage'); assert.equal(h.prompts,0);
    assert.deepEqual(await entries(f.cwd),[]); assert.equal((await driveStatus({cwd:f.cwd})).running,false);
  } finally { await h.shutdown(); await f.done(); }
});
test('SF4 uncovered plan downgrade refuses before any ledger or driver effect', {timeout:90_000},async () => {
  const f=await fixture();
  try {
    assert.equal((await cli(f.cwd,['start','--plan','plan.json','--stay'])).code,0);
    const before=await entries(f.cwd), p=plan(); p.nodes[0]!.review.count=0; await f.put('plan.json',JSON.stringify(p));
    const out=await cli(f.cwd,['start']); assert.equal(out.code,2); assert.match(out.stderr,/preflight plan downgrade failed.*owed plan .*--note "<why>".*owed start/);
    assert.equal(out.stderr.trim().split('\n').length,1); assert.deepEqual(await entries(f.cwd),before);
    assert.equal((await driveStatus({cwd:f.cwd})).running,true);
  } finally { await f.done(); }
});
test('SF2 preflight rejects invalid plan, shell syntax, missing trunk, identity and max without recording', async () => {
  const f=await fixture();
  try {
    for (const [p,re] of [[{...plan(),version:99},/plan validation/],[{...plan(),setup:'if then'},/plan validation/],[{...plan(),trunk:'absent'},/trunk ref/]] as const) {
      await f.put('bad.json',JSON.stringify(p));
      const out=await cli(f.cwd,['start','--plan','bad.json']); assert.equal(out.code,2,out.stderr); assert.match(out.stderr,re); assert.equal(out.stderr.trim().split('\n').length,1); assert.deepEqual(await entries(f.cwd),[]);
    }
    const noIdentity=await cli(f.cwd,['start','--plan','plan.json'],{GIT_CONFIG_GLOBAL:'/dev/null',GIT_CONFIG_SYSTEM:'/dev/null',HOME:f.root,GIT_AUTHOR_NAME:'',GIT_AUTHOR_EMAIL:'',GIT_COMMITTER_NAME:'',GIT_COMMITTER_EMAIL:''});
    assert.equal(noIdentity.code,2); assert.match(noIdentity.stderr,/git identity.*user.name and user.email/);
    assert.equal((await cli(f.cwd,['start','--plan','plan.json','--max','0'])).code,2);
    assert.deepEqual(await entries(f.cwd),[]); assert.equal((await driveStatus({cwd:f.cwd})).running,false);
  } finally { await f.done(); }
});
test('SF3 dispatch prints one packet and references it in rendered subagents arguments; structured arguments stay executable', async () => {
  const p=plan(); p.nodes[0]!.later=false;
  const f=await fixture(p), h=harness(f.cwd);
  try {
    await ops.init({cwd:f.cwd,as:{role:'owner',id:'pi'},channel:'delegated',plan:JSON.stringify(p),measure:false});
    const out=await h.call('dispatch',{node:'a'}); assert.notEqual(out.isError,true,out.text);
    const d=out.details as ops.DispatchPacket & {subagents:Record<string,unknown>};
    assert.equal(d.subagents.task,d.packet); assert.equal(d.subagents.cwd,d.worktree); assert.equal(d.subagents.isolation,'none');
    const args=JSON.parse(out.text.split('\nsubagents: ')[1]!.split('\n')[0]!);
    assert.equal(args.task,'<the complete packet above>'); assert.equal(out.text.split(d.packet).length,2);
    assert.ok(out.text.length < d.packet.length + 1_000,'packet size grows only once');
    assert.match((await git(d.worktree,['status','--porcelain'])).stdout,/^$/);
  } finally { await h.shutdown(); await f.done(); }
});
