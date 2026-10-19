// ME1: one note, one final plan, and one append for several nodes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { parsePlan } from '../src/plan.ts';
import { editText } from '../src/edit.ts';
import { renderEntry } from '../src/views.ts';
import { repo } from './helpers/repo.ts';
import { cli, seed, commitAt, checkTest } from './helpers/surface.ts';
import owed from '../src/extension.ts';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
const parent = { role:'parent', id:'test' } as const, owner = { role:'owner', id:'pi' } as const;
const PLAN = `# batch plan
version: 1
trunk: main
invariants: []
nodes:
  - id: a # first
    writes: [test/a]
    review: {count: 1, min_rank: 1}
    checks: [{id: unit, run: 'node --test --test-reporter=tap test/a.test.cjs', reads: [test/a], min_tests: 1}]
  - id: b # second
    writes: [test/b]
    review: {count: 1, min_rank: 1}
    checks: [{id: unit, run: 'node --test --test-reporter=tap test/b.test.cjs', reads: [test/b], min_tests: 1}]
  - id: c  # untouched
    writes: [test/c]   # exact spacing
`;
const entries = async (cwd: string) => (await Ledger.open(cwd)).read();
async function setup(text = PLAN) {
  const r = await repo(); await seed(r.cwd);
  const file = join(r.root,'plan.yaml'); await writeFile(file,text);
  await ops.init({ cwd:r.cwd, plan:text, as:owner, channel:'delegated', measure:false });
  await ops.planSet({ cwd:r.cwd, as:parent, ...await ops.readPlan({ cwd:r.cwd, path:file }) });
  return { r, file, cwd:r.cwd, as:parent, note:'One batch reason' };
}
async function unchanged(s: Awaited<ReturnType<typeof setup>>, count: number, text = PLAN) {
  assert.equal((await entries(s.cwd)).length,count);
  assert.equal(await readFile(s.file,'utf8'),text);
  assert.deepEqual((await readdir(s.r.root)).filter(x => x.includes('owed-edit')),[]);
}

test('ME1 red: CLI a,b changes both review counts with one note and one plan entry', async () => {
  const s = await setup();
  try {
    const count = (await entries(s.cwd)).length;
    const r = await cli(s.cwd,['edit','a,b','--set','review.count=2','--note','x']);
    assert.equal(r.code,0,r.stderr);
    const es = (await entries(s.cwd)).slice(count);
    assert.deepEqual(es.map(e => e.kind),['plan']);
    assert.ok(es[0]?.kind === 'plan'); assert.equal(es[0].note,'x');
    const next = await readFile(s.file,'utf8');
    assert.deepEqual(parsePlan(next).nodes.map(n => n.review.count),[2,2,parsePlan(PLAN).nodes[2]!.review.count]);
    assert.equal(next.slice(next.indexOf('  - id: c')),PLAN.slice(PLAN.indexOf('  - id: c')));
    assert.match(next,/# first/); assert.match(next,/# second/);
    assert.equal((await ops.verify({cwd:s.cwd})).ok,true);
  } finally { await s.r.cleanup(); }
});

test('ME1: carries are computed from the final plan, followed by one ordered rule and all resumes in one locked append', async t => {
  const s = await setup();
  try {
    const subs = [];
    for (const node of ['a','b']) {
      const d = await ops.dispatch({cwd:s.cwd,node,as:parent});
      await commitAt(d.worktree,{[`test/${node}.cjs`]:'module.exports=1;', [`test/${node}.test.cjs`]:checkTest(node,1)});
      subs.push(await ops.submit({cwd:d.worktree,node,as:{role:'writer',id:`${node}#1`}}));
    }
    const count = (await entries(s.cwd)).length, append = Ledger.prototype.append;
    let calls = 0;
    t.mock.method(Ledger.prototype,'append',async function(this: Ledger, ...args: Parameters<Ledger['append']>) {
      calls++; assert.ok(this.holdsLock()); return append.apply(this,args);
    });
    const r = await ops.edit({...s,nodes:['b','a','b'],set:['checks.extra={run: "true", reads: [test/], min_tests: 1}'],rule:'One limit for both',resume:true,after:'c'}) as ops.EditResult;
    assert.equal(calls,1);
    const es = (await entries(s.cwd)).slice(count);
    assert.deepEqual(es.map(e => e.kind),['plan','submit','submit','rule','resume','resume']);
    assert.deepEqual(r.carried.map(e => e.carry),subs.map(e => e.seq));
    assert.ok(r.rule?.kind === 'rule'); assert.deepEqual(r.rule.nodes,['b','a']);
    assert.deepEqual(r.resumes?.map(e => e.kind === 'resume' && [e.node,e.after,e.by]),[['b','c','parent:test'],['a','c','parent:test']]);
    assert.equal(r.resume,undefined);
    const finalPlan = parsePlan(await readFile(s.file,'utf8'));
    assert.deepEqual(finalPlan.nodes.slice(0,2).map(n => n.checks.map(c => c.id)),[['unit','extra'],['unit','extra']]);
    assert.equal((await ops.verify({cwd:s.cwd})).ok,true);
  } finally { t.mock.restoreAll(); await s.r.cleanup(); }
});

test('ME1: unknown second node, missing second unset, authority, second resume, invalid after and append failure are atomic', async t => {
  const text = PLAN.replace('id: a # first','id: a # first\n    title: Only a'), s = await setup(text);
  try {
    let count = (await entries(s.cwd)).length;
    await assert.rejects(ops.edit({...s,nodes:['a','missing'],set:['title=Updated']}),/Node missing does not exist/);
    await unchanged(s,count,text);
    await assert.rejects(ops.edit({...s,nodes:['a','b'],unset:['title']}),/missing edit path/);
    await unchanged(s,count,text);
    await assert.rejects(ops.edit({...s,nodes:['a','b'],set:['review.count=0']}),/Only owner/);
    await unchanged(s,count,text);
    await ops.dispatch({cwd:s.cwd,node:'a',as:parent}); count = (await entries(s.cwd)).length;
    await assert.rejects(ops.edit({...s,nodes:['a','b'],set:['title=Updated'],rule:'both',resume:true}),/open slot/);
    await unchanged(s,count,text);
    await ops.dispatch({cwd:s.cwd,node:'b',as:parent}); count = (await entries(s.cwd)).length;
    await assert.rejects(ops.edit({...s,nodes:['a','b'],set:['title=Updated'],resume:true,after:'missing'}),/unknown node/);
    await unchanged(s,count,text);
    t.mock.method(Ledger.prototype,'append',async () => { throw new Error('batch append failed'); });
    await assert.rejects(ops.edit({...s,nodes:['a','b'],set:['title=Updated'],rule:'both',resume:true}),/batch append failed/);
    await unchanged(s,count,text);
  } finally { t.mock.restoreAll(); await s.r.cleanup(); }
});

test('ME1: duplicate ids keep order; dry-run returns one diff and all final downgrades without recording', async () => {
  const s = await setup();
  try {
    const count = (await entries(s.cwd)).length;
    const dry = await cli(s.cwd,['edit','b,a,b','--set','review.count=0','--note','preview','--dry-run']);
    assert.equal(dry.code,0,dry.stderr);
    assert.equal((dry.stdout.match(/^--- /gm) ?? []).length,1);
    assert.match(dry.stdout,/Downgrades:.*a.*b/);
    await unchanged(s,count);
    const r = await ops.edit({...s,nodes:['b','a','b'],set:['review.count=2'],rule:'ordered'}) as ops.EditResult;
    assert.ok(r.rule?.kind === 'rule'); assert.deepEqual(r.rule.nodes,['b','a']);
    assert.deepEqual(parsePlan(await readFile(s.file,'utf8')).nodes.map(n => n.review.count),[2,2,parsePlan(PLAN).nodes[2]!.review.count]);
  } finally { await s.r.cleanup(); }
});

test('ME1: only the final YAML plan is validated; flow containers and aliases remain in context', () => {
  // Editing a alone removes the anchor while b still refers to it; the final batch removes both references.
  const anchored = PLAN.replace('writes: [test/a]','writes: &owned [test/a]').replace('writes: [test/b]','writes: *owned');
  assert.throws(() => editText(anchored,{node:'a',set:['writes=[test/x]']}));
  const next = editText(anchored,{nodes:['a','b'],set:['writes=[test/x]']});
  assert.deepEqual(parsePlan(next).nodes.slice(0,2).map(n => n.writes),[['test/x'],['test/x']]);
  const flow = '# flow\nversion: 1\ntrunk: main\ninvariants: []\nnodes: [{id: a, writes: [a]}, {id: b, writes: [b]}] # kept\n';
  const edited = editText(flow,{nodes:['b','a'],set:['title=Updated']});
  assert.deepEqual(parsePlan(edited).nodes.map(n => n.title),['Updated','Updated']); assert.match(edited,/# kept/);
  const external = PLAN.replace('invariants: []','closure: &shared [test/a]\ninvariants: []');
  assert.deepEqual(parsePlan(editText(external,{nodes:['a','b'],set:['writes=*shared']})).nodes.slice(0,2).map(n => n.writes),[['test/a'],['test/a']]);
});

test('ME1: target forms are exclusive and node_new arrays refuse several nodes', async () => {
  const s = await setup();
  try {
    const count = (await entries(s.cwd)).length;
    for (const fields of [{node:'a',nodes:['b']},{invariant:'unit',nodes:['a']},{nodes:[]},{nodes:['a','']},{nodes:['a',3]},{nodes:['a','b'],node_new:true}]) {
      await assert.rejects(ops.edit({...s,...fields,set:['title=Updated']} as Parameters<typeof ops.edit>[0]));
      await unchanged(s,count);
    }
    const created = await cli(s.cwd,['edit','a,b','--node-new','--set','writes=[test/new]','--note','x']);
    assert.equal(created.code,0,created.stderr);
    assert.equal(parsePlan(await readFile(s.file,'utf8')).nodes.at(-1)?.id,'a,b');
    const done = await ops.edit({...s,nodes:['new','new'],node_new:true,set:['writes=[test/new]']}) as ops.EditResult;
    assert.equal(done.plan.kind,'plan'); assert.equal(parsePlan(await readFile(s.file,'utf8')).nodes.at(-1)?.id,'new');
  } finally { await s.r.cleanup(); }
});

test('ME1: owed_edit exposes nodes, previews the batch, and records or refuses the entire batch', async () => {
  const s = await setup();
  try {
    const tools = new Map<string,ToolDefinition>();
    owed({registerTool(t: ToolDefinition) { tools.set(t.name,t); },registerCommand() {},on() {}} as unknown as ExtensionAPI);
    const tool = tools.get('owed_edit'); assert.ok(tool);
    assert.ok((tool.parameters as {properties?: Record<string,unknown>}).properties?.nodes);
    const run = (p: object) => tool.execute('edit',p,undefined,undefined,{cwd:s.cwd,hasUI:false} as Parameters<ToolDefinition['execute']>[4]) as Promise<{isError?:boolean;content:{text?:string}[];details:ops.EditResult}>;
    const count = (await entries(s.cwd)).length;
    const dry = await run({nodes:['a','b'],set:['review.count=0'],note:'preview',dry_run:true,cwd:s.cwd});
    assert.equal(dry.isError,undefined,dry.content[0]?.text); assert.match(dry.content[0]!.text!,/Downgrades:.*a.*b/); await unchanged(s,count);
    const denied = await run({nodes:['a','b'],set:['review.count=0'],note:'denied',as:'parent:pi',cwd:s.cwd});
    assert.equal(denied.isError,true); await unchanged(s,count);
    const mixed = await run({node:'a',nodes:['b'],set:['title=Updated'],note:'mixed',cwd:s.cwd});
    assert.equal(mixed.isError,true); await unchanged(s,count);
    const newBatch = await run({nodes:['a','b'],node_new:true,set:['writes=[test/new]'],note:'new batch',cwd:s.cwd});
    assert.equal(newBatch.isError,true); assert.match(newBatch.content[0]!.text!,/single node/); await unchanged(s,count);
    for (const node of ['a','b']) await ops.dispatch({cwd:s.cwd,node,as:parent});
    const done = await run({nodes:['b','a','b'],set:['review.count=2'],note:'one',rule:'both',resume:true,after:'c',cwd:s.cwd});
    assert.equal(done.isError,undefined,done.content[0]?.text); assert.ok(done.details.rule?.kind === 'rule');
    assert.deepEqual(done.details.rule.nodes,['b','a']); assert.equal(done.details.resumes?.length,2);
    for (const e of done.details.resumes!) assert.ok(done.content[0]!.text!.includes(renderEntry(e)));
  } finally { await s.r.cleanup(); }
});

for (const collision of [false,true]) test(`R-030-ME-1: literal comma id wins${collision ? ' over existing parts' : ' alone'}`, async () => {
  const text = JSON.stringify({version:1,trunk:'main',invariants:[],nodes:(collision ? ['a,b','a','b'] : ['a,b']).map((id,i) => ({id,writes:[`test/node-${i}/`],title:id}))});
  const s = await setup(text);
  try {
    const count = (await entries(s.cwd)).length;
    const r = await cli(s.cwd,['edit','a,b','--set','title=Updated','--note','literal']);
    assert.equal(r.code,0,r.stderr);
    const added = (await entries(s.cwd)).slice(count);
    assert.deepEqual(added.map(e => e.kind),['plan']);
    assert.deepEqual(parsePlan(await readFile(s.file,'utf8')).nodes.map(n => [n.id,n.title]),collision ? [['a,b','Updated'],['a','a'],['b','b']] : [['a,b','Updated']]);
    assert.equal(r.stdout,`${renderEntry(added[0]!)}\nWrote ${s.file}\n`);
  } finally { await s.r.cleanup(); }
});

test('R-030-ME-1: fallback list trims, deduplicates in order and refuses empty parts', async () => {
  const s = await setup();
  try {
    const count = (await entries(s.cwd)).length;
    const refused = await cli(s.cwd,['edit','a, ,b','--set','title=Updated','--note','empty']);
    assert.notEqual(refused.code,0); await unchanged(s,count);
    const r = await cli(s.cwd,['edit',' b, a,b ','--set','review.count=2','--rule','batch','--note','list']);
    assert.equal(r.code,0,r.stderr);
    const added = (await entries(s.cwd)).slice(count);
    assert.deepEqual(added.map(e => e.kind),['plan','rule']);
    assert.ok(added[1]?.kind === 'rule'); assert.deepEqual(added[1].nodes,['b','a']);
    assert.deepEqual(parsePlan(await readFile(s.file,'utf8')).nodes.slice(0,2).map(n => n.review.count),[2,2]);
  } finally { await s.r.cleanup(); }
});

test('ME1: single-node CLI output and resume result retain the original shape', async () => {
  const s = await setup();
  try {
    const r = await cli(s.cwd,['edit','a','--set','review.count=2','--note','one']);
    assert.equal(r.code,0,r.stderr);
    const plan = (await entries(s.cwd)).at(-1)!;
    assert.equal(r.stdout,`${renderEntry(plan)}\nWrote ${s.file}\n`);
    await ops.dispatch({cwd:s.cwd,node:'a',as:parent});
    const result = await ops.edit({...s,node:'a',set:['title=Updated'],resume:true}) as ops.EditResult;
    assert.equal(result.resume?.kind,'resume'); assert.equal(Object.hasOwn(result,'resumes'),false);
  } finally { await s.r.cleanup(); }
});
