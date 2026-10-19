import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as ops from '../src/ops.ts';
import * as reducer from '../src/reducer.ts';
import * as views from '../src/views.ts';
import { Ledger } from '../src/ledger.ts';
import owed from '../src/extension.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';
import type { Draft, WaiveEntry } from '../src/types.ts';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';

const owner = {role:'owner',id:'pi'} as const, parent = {role:'parent',id:'test'} as const;
const external = 'ext:BL-BROWSER-FIXTURE-TIMEOUT-INCLUDES-BUDGET-WAIT';
async function fixture(tracker = 'fix') {
  const r = await repo();
  try {
    await commitAt(r.cwd,{impl:'base'});
    const plan = {version:1,trunk:'main',lease:false,closure:[],invariants:[],nodes:[
      {id:'a',writes:['impl'],checks:[],review:{count:0,min_rank:1}},
      {id:tracker,writes:['fixed'],checks:[],review:{count:0,min_rank:1}}
    ]};
    await ops.init({cwd:r.cwd,plan:JSON.stringify(plan),as:owner,channel:'delegated'});
    const slot = await ops.dispatch({...r,node:'a',as:parent});
    await commitAt(slot.worktree,{impl:'candidate'});
    await ops.submit({cwd:slot.worktree,node:'a',as:{role:'writer',id:'a#1'}});
    const ledger = await Ledger.open(r.cwd);
    const waive = (tracked_by:string) => ops.waive({...r,node:'a',obligation:'writes',reason:'tracked risk',tracked_by,as:owner,channel:'delegated'});
    const mergeTracker = async () => {
      const fix = await ops.dispatch({...r,node:tracker,as:parent});
      await commitAt(fix.worktree,{fixed:'repair'});
      await ops.submit({cwd:fix.worktree,node:tracker,as:{role:'writer',id:`${tracker}#1`}});
      await ops.attest({...r,node:tracker});
      return ops.merge({...r,node:tracker,as:parent});
    };
    return {...r,plan,ledger,waive,mergeTracker};
  } catch(e) { await r.cleanup(); throw e; }
}

async function assertExternal(r: Awaited<ReturnType<typeof fixture>>, tracker = external) {
  const text = `tracked by ${tracker} (external)`;
  assert.ok((await ops.status(r)).summary!.debt.some(d => d.includes(text)));
  assert.ok((await ops.brief(r)).summary!.debt.some(d => d.includes(text)));
  for (const output of [views.renderStatus(await ops.status(r)),views.renderStatus(await ops.status(r),{full:true}),views.renderReport(await ops.report(r)),views.renderWhy(await ops.why({...r,node:'a'})),views.renderWhy(await ops.why({...r,node:'a'}),{full:true})]) {
    assert.ok(output.includes(text),output);
    assert.doesNotMatch(output,/tracker .* left the plan|settled by ext:/);
  }
  assert.ok(!views.renderWhy(await ops.why({...r,node:'fix'})).includes(text),'unrelated why does not show external debt');
}

test('TB1: CLI records external tracked debt; merges and replay keep it visible on the waived node', async () => {
  const r = await fixture();
  try {
    const out = await cli(r.cwd,['waive','a','writes','--as','owner:pi','--reason','tracked risk','--tracked-by',external]);
    assert.equal(out.code,0,out.stderr);
    const entry = (await r.ledger.read()).findLast((e):e is WaiveEntry => e.kind === 'waive')!;
    assert.equal(entry.tracked_by,external);
    await assertExternal(r);
    const retry = await r.waive(external); assert.equal(retry.alreadyRecorded,entry.seq);
    const changed = await r.waive('ext:issue/2#fix'); assert.ok(changed.seq > entry.seq);
    await r.waive(external);
    await r.mergeTracker(); await assertExternal(r);
    const {state} = await ops.readState(r), entries = await r.ledger.read();
    const replay = reducer.reduce(entries,sha => reducer.planAt(state,entries.find(e => (e.kind === 'plan' || e.kind === 'genesis') && e.plan === sha)!.seq + 1));
    assert.deepEqual(replay,state);
    assert.ok(views.trackedDebtText(replay,views.trackedWaivers(replay)[0]!).includes(`tracked by ${external} (external)`));
    assert.equal((await ops.verify(r)).ok,true);
  } finally { await r.cleanup(); }
});

test('TB1: malformed external ids refuse new acts and replay drafts without recording; bounds and alphabet are accepted', async () => {
  const r = await fixture();
  try {
    await r.waive('fix');
    const waiver = (await r.ledger.read()).findLast((e):e is WaiveEntry => e.kind === 'waive')!;
    const {seq,ts,prev,hash,...draft} = waiver;
    const before = await r.ledger.read(), {state} = await ops.readState(r);
    for (const tracker of ['ext:','ext:-bad','ext:_bad','ext:.bad','ext:/bad','ext:#bad','ext:bad id','ext:bad?','ext:bad@','ext:bad\n','ext:é','ext:'+'a'.repeat(129),'EXT:abc']) {
      const out = await cli(r.cwd,['waive','a','writes','--reason','invalid','--tracked-by',tracker]);
      assert.equal(out.code,2,`${JSON.stringify(tracker)}: ${out.stderr}`);
      assert.deepEqual(await r.ledger.read(),before);
      assert.ok(reducer.validateDraft(state,{...draft,tracked_by:tracker} as Draft).some(e => e.includes('tracked_by')),tracker);
    }
    for (const tracker of ['ext:a','ext:0Az._:/#-','ext:'+'a'.repeat(128)]) {
      assert.equal(reducer.validateDraft(state,{...draft,tracked_by:tracker} as Draft).length,0,tracker);
      assert.equal(((await r.waive(tracker)) as WaiveEntry).tracked_by,tracker);
    }
  } finally { await r.cleanup(); }
});

test('TB1: literal ext:x nodes keep local validation and historical interpretation after removal', async () => {
  const r = await fixture('ext:x');
  try {
    await r.waive('ext:x');
    const status = await ops.status(r);
    assert.ok(status.summary!.debt.some(d => d.includes('tracked by ext:x:')));
    assert.doesNotMatch(views.renderStatus(status),/\(external\)/);
    assert.match(views.renderWhy(await ops.why({...r,node:'ext:x'})),/tracks waived debt: a\/writes/);
    assert.doesNotMatch(views.renderWhy(await ops.why({...r,node:'a'})),/tracks waived debt|tracked by ext:x/);
    const before = await r.ledger.read();
    await assert.rejects(ops.waive({...r,node:'ext:x',obligation:'writes',reason:'self',tracked_by:'ext:x',as:owner,channel:'delegated'}),/tracked_by/);
    assert.deepEqual(await r.ledger.read(),before);
    await ops.planSet({...r,as:owner,channel:'delegated',note:'remove local tracker',plan:JSON.stringify({...r.plan,nodes:r.plan.nodes.filter(n => n.id !== 'ext:x')})});
    assert.ok((await ops.status(r)).summary!.debt.some(d => d.includes('(tracker ext:x left the plan)')));
    assert.equal((await ops.verify(r)).ok,true);
    assert.doesNotMatch(views.renderStatus(await ops.status(r),{full:true}),/\(external\)/);
  } finally { await r.cleanup(); }
});

test('TB1: a literal ext:x tracker applies local self validation before candidate lookup', async () => {
  const r = await fixture('ext:x');
  try {
    const before = await r.ledger.read();
    // R-0292-TH-1: ':' nodes cannot be dispatched; validate the reachable refusal before candidate lookup.
    await assert.rejects(ops.waive({...r,node:'ext:x',obligation:'writes',reason:'self',tracked_by:'ext:x',as:owner,channel:'delegated'}),/tracked_by/);
    assert.deepEqual(await r.ledger.read(),before);
  } finally { await r.cleanup(); }
});

test('TB1: an external tracker stays external when a matching plan node is added and removed later', async () => {
  const r = await fixture();
  try {
    await r.waive('ext:x');
    await ops.planSet({...r,as:owner,channel:'delegated',note:'add a later same-name node',plan:JSON.stringify({...r.plan,nodes:[...r.plan.nodes,{id:'ext:x',writes:['later'],checks:[],review:{count:0,min_rank:1}}]})});
    await assertExternal(r,'ext:x');
    assert.doesNotMatch(views.renderWhy(await ops.why({...r,node:'ext:x'})),/tracks waived debt/);
    assert.doesNotMatch(views.renderWhy(await ops.why({...r,node:'ext:x'}),{full:true}),/tracks waived debt/);
    assert.equal((await ops.verify(r)).ok,true);
    await ops.planSet({...r,as:owner,channel:'delegated',note:'remove later same-name node',plan:JSON.stringify(r.plan)});
    await assertExternal(r,'ext:x');
    assert.equal((await ops.verify(r)).ok,true);
  } finally { await r.cleanup(); }
});

test('TB1: owed_waive accepts external trackers and documents their parameter', async () => {
  const r = await fixture();
  try {
    const tools = new Map<string,ToolDefinition>();
    owed({registerTool:(t:ToolDefinition) => tools.set(t.name,t),registerCommand(){},on(){},sendMessage(){}} as unknown as ExtensionAPI);
    const tool = tools.get('owed_waive')!;
    assert.match(JSON.stringify(tool.parameters),/ext:<id>/);
    const ctx = {cwd:r.cwd,hasUI:false} as Parameters<ToolDefinition['execute']>[4];
    const bad = await tool.execute('bad',{node:'a',obligation:'writes',reason:'tracked risk',tracked_by:'ext:'},undefined,undefined,ctx) as {isError?:boolean};
    assert.equal(bad.isError,true);
    const result = await tool.execute('good',{node:'a',obligation:'writes',reason:'tracked risk',tracked_by:external},undefined,undefined,ctx);
    assert.equal((result.details as WaiveEntry).tracked_by,external);
    await assertExternal(r);
  } finally { await r.cleanup(); }
});

test('HP1: command help works outside a repository, keeps every attest form and exit code, and isolates compound synopses', async () => {
  const r = await repo();
  try {
    const full = await cli(r.root,['help']); assert.equal(full.code,0,full.stderr);
    assert.equal((await cli(r.root,['--help'])).stdout,full.stdout);
    const named = await cli(r.root,['help','attest']); assert.equal(named.code,0,named.stderr);
    for (const args of [['attest','--help'],['attest','a','--rerun','--help']]) {
      const out = await cli(r.root,args); assert.equal(out.code,0,out.stderr); assert.equal(out.stdout,named.stdout);
    }
    for (const form of ['attest <node> [--rerun]','attest <node> --probe-trunk','attest <node> --remeasure','attest --genesis','attest --trunk','attest exit codes:','Usage: owed <command>','--json','--as','--i-am-owner','--no-lease','--check','--runs']) assert.ok(named.stdout.includes(form),form);
    assert.doesNotMatch(named.stdout,/(?:^|\n| \| )(?:decide|rebase|dispatch|submit)\b/);
    const decide = await cli(r.root,['help','decide']); assert.equal(decide.code,0,decide.stderr);
    assert.ok(decide.stdout.includes('--resume|--no-resume'));
    assert.doesNotMatch(decide.stdout,/(?:^|\n| \| )attest\b/);
    const edit = await cli(r.root,['help','edit']); assert.equal(edit.code,0,edit.stderr);
    assert.ok(edit.stdout.includes('edit <node[,node...]>')); assert.ok(edit.stdout.includes('edit --invariant'));
    const decoy = await cli(r.root,['decoy','--help']); assert.equal(decoy.code,0,decoy.stderr);
    for (const form of ['decoy commit','decoy reveal','decoy digest']) assert.ok(decoy.stdout.includes(form));
    const waive = await cli(r.root,['help','waive']); assert.equal(waive.code,0,waive.stderr); assert.ok(waive.stdout.includes('ext:<id>'));
    for (const args of [['help','nosuch'],['nosuch','--help']]) {
      const out = await cli(r.root,args); assert.equal(out.code,2,out.stderr);
      assert.match(out.stderr,/nosuch/); assert.match(out.stderr,/known commands/i); assert.match(out.stderr,/attest/);
    }
  } finally { await r.cleanup(); }
});

test('HP1: every command in allowed has non-empty isolated help and lists its accepted and global flags', async () => {
  const r = await repo();
  try {
    const source = await readFile(new URL('../src/cli.ts',import.meta.url),'utf8');
    const table = /const allowed:Record<string,string\[\]> = \{([^\n]+)\};/.exec(source)![1]!;
    const commands = [...table.matchAll(/(\w+):\[([^\]]*)\]/g)]; assert.ok(commands.length >= 30);
    for (const [,cmd,flags] of commands) {
      const out = await cli(r.root,['help',cmd!]); assert.equal(out.code,0,`${cmd}: ${out.stderr}`);
      assert.ok(out.stdout.split('\n').some(line => line.startsWith(`${cmd} `) || line === cmd),`${cmd} synopsis`);
      assert.ok(out.stdout.includes('Usage: owed <command>'));
      for (const flag of ['json','as','i-am-owner',...[...flags!.matchAll(/'([^']+)'/g)].map(m => m[1]!)]) assert.ok(out.stdout.includes(`--${flag}`),`${cmd} --${flag}`);
      assert.equal((await cli(r.root,[cmd!,'--help'])).stdout,out.stdout,cmd);
    }
  } finally { await r.cleanup(); }
});
