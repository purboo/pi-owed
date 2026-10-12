// ED1/ED2: atomic plan edits; this file must fail on release 0.12.0.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, readdir, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { parsePlan } from '../src/plan.ts';
import { editText } from '../src/edit.ts';
import { repo } from './helpers/repo.ts';
import { cli, seed, commitAt, checkTest } from './helpers/surface.ts';
import owed from '../src/extension.ts';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
const parent = { role:'parent', id:'test' } as const, owner = { role:'owner', id:'pi' } as const;
const PLAN = `# plan comment
version: 1
trunk: main
closure: [test/helper.cjs]
invariants:
  - id: unit # invariant comment
    run: node --test --test-reporter=tap test/invariant.test.cjs
    min_tests: 1
    reads: [test/invariant.test.cjs, test/state.cjs]
allow:
  - {nodes: [b], writes: [test/]}  # allowance
nodes:
  - id: a # target comment
    title: Original
    brief: Keep the interface.
    writes: [test/a]
    review: {count: 1, min_rank: 1}
    checks:
      - {id: a, run: 'node --test --test-reporter=tap test/a.test.cjs', min_tests: 1, reads: ['test/a*']}
  - id: b  # untouched layout
    deps: [a]
    writes: [test/b]   # exact spacing
`;
const entries = async (cwd: string) => (await Ledger.open(cwd)).read();
async function setup() {
  const r = await repo(); await seed(r.cwd);
  const file = join(r.root,'plan.yaml'); await writeFile(file,PLAN);
  await ops.init({ cwd:r.cwd, plan:PLAN, as:owner, channel:'delegated', measure:false });
  await ops.planSet({ cwd:r.cwd, as:parent, ...await ops.readPlan({ cwd:r.cwd, path:file }) });
  return { r, file, cwd:r.cwd, as:parent, note:'Exercise the edit contract' };
}
async function unchanged(s: Awaited<ReturnType<typeof setup>>, count: number, text = PLAN) {
  assert.equal((await entries(s.cwd)).length,count);
  assert.equal(await readFile(s.file,'utf8'),text);
  assert.deepEqual((await readdir(s.r.root)).filter(x => x.includes('owed-edit')),[]);
}
async function submitted(s: Awaited<ReturnType<typeof setup>>) {
  const d = await ops.dispatch({ cwd:s.cwd, node:'a', as:parent });
  await commitAt(d.worktree,{'test/a.cjs':'module.exports=1;', 'test/a.test.cjs':checkTest('a',1)});
  const e = await ops.submit({ cwd:d.worktree, node:'a', as:{role:'writer',id:'a#1'} });
  assert.equal(e.kind,'submit'); return e;
}

test('ED1: repeated CLI assignments, unsets, nested fields and check mappings preserve other layout', async () => {
  const s = await setup();
  try {
    const res = await cli(s.cwd,['edit','a','--set','title=Updated','--set','review.min_rank=2','--set','drive.writer.model=sol','--set','checks.extra={run: "true", reads: [test/a], min_tests: 1}','--unset','brief','--note','new acceptance check']);
    assert.equal(res.code,0,res.stderr);
    const text = await readFile(s.file,'utf8'), plan = parsePlan(text), n = plan.nodes[0]!;
    assert.equal(n.title,'Updated'); assert.equal(n.brief,undefined); assert.equal(n.review.min_rank,2);
    assert.equal(n.drive?.writer?.model,'sol'); assert.equal(n.checks[1]?.id,'extra');
    assert.equal(text.slice(0,text.indexOf('  - id: a')),PLAN.slice(0,PLAN.indexOf('  - id: a')));
    assert.equal(text.slice(text.indexOf('  - id: b')),PLAN.slice(PLAN.indexOf('  - id: b')));
    assert.match(text,/# target comment/);
    assert.equal((await ops.verify({cwd:s.cwd})).ok,true);
  } finally { await s.r.cleanup(); }
});

test('ED2: one append records plan, carry, rule and resume in order under one lock', async (t: TestContext) => {
  const s = await setup();
  try {
    const sub = await submitted(s), count = (await entries(s.cwd)).length, append = Ledger.prototype.append;
    let calls = 0;
    t.mock.method(Ledger.prototype,'append',async function(this: Ledger, ...args: Parameters<Ledger['append']>) { calls++; return append.apply(this,args); });
    const r = await ops.edit({...s,node:'a',set:['checks.extra={run: "true", reads: [test/a], min_tests: 1}'],rule:'Keep the interface.',resume:true,after:'b'}) as ops.EditResult;
    assert.equal(calls,1);
    const es = (await entries(s.cwd)).slice(count);
    assert.deepEqual(es.map(e => e.kind),['plan','submit','rule','resume']);
    assert.equal(r.carried[0]?.carry,sub.seq);
    assert.equal(r.rule?.by,'parent:test'); assert.equal(r.resume?.by,'parent:test');
    assert.ok(r.rule?.kind === 'rule'); assert.deepEqual(r.rule.nodes,['a']);
    assert.ok(r.resume?.kind === 'resume'); assert.equal(r.resume.after,'b');
    assert.equal((await ops.verify({cwd:s.cwd})).ok,true);
  } finally { t.mock.restoreAll(); await s.r.cleanup(); }
});

test('ED2: resume refusal, unknown wait target and invalid writer ruling leave plan and ledger unchanged', async () => {
  const s = await setup();
  try {
    const count = (await entries(s.cwd)).length;
    await assert.rejects(ops.edit({...s,node:'a',set:['title=Changed'],rule:'New direction',resume:true}),/open slot/);
    await unchanged(s,count);
    await ops.dispatch({cwd:s.cwd,node:'a',as:parent});
    const next = (await entries(s.cwd)).length;
    await assert.rejects(ops.edit({...s,node:'a',set:['title=Changed'],resume:true,after:'missing'}),/unknown node/);
    await unchanged(s,next);
    await assert.rejects(ops.edit({...s,node:'a',set:['title=Changed'],writer:true}),/requires --rule/);
    await unchanged(s,next);
  } finally { await s.r.cleanup(); }
});

test('ED2: downgrade authority and allowance match plan; dry-run prints diff and downgrades', async () => {
  const s = await setup();
  try {
    const count = (await entries(s.cwd)).length;
    const dry = await cli(s.cwd,['edit','a','--set','writes=[test/]','--note','broader scope','--dry-run']);
    assert.equal(dry.code,0,dry.stderr); assert.match(dry.stdout,/--- .*plan.yaml/); assert.match(dry.stdout,/Downgrades:.*a/);
    await unchanged(s,count);
    await assert.rejects(ops.edit({...s,node:'a',set:['writes=[test/]']}),/Only owner/);
    await unchanged(s,count);
    await ops.edit({...s,node:'b',set:['writes=[test/b, test/x]']});
    const res = await ops.edit({...s,as:owner,channel:'delegated',node:'a',set:['writes=[test/]']}) as ops.EditResult;
    assert.equal(res.plan.by,'owner:pi');
    assert.equal(res.plan.channel,'delegated');
  } finally { await s.r.cleanup(); }
});

test('ED1: node-new and invariant edits use the same plan validation', async () => {
  const s = await setup();
  try {
    let res = await cli(s.cwd,['edit','c','--node-new','--set','deps=[a]','--set','title=New node','--set','brief=Implement c.','--set','writes=[test/c]','--set','checks.c={run: "true", reads: [test/c], min_tests: 1}','--note','add c']);
    assert.equal(res.code,0,res.stderr);
    assert.deepEqual(parsePlan(await readFile(s.file,'utf8')).nodes.map(n => n.id),['a','b','c']);
    res = await cli(s.cwd,['edit','--invariant','unit','--set','timeout_s=30','--note','bound execution','--as','owner:pi']);
    assert.equal(res.code,0,res.stderr);
    const text = await readFile(s.file,'utf8');
    assert.equal(parsePlan(text).invariants[0]?.timeout_s,30); assert.match(text,/# invariant comment/);
    const count = (await entries(s.cwd)).length;
    await assert.rejects(ops.edit({...s,node:'c',node_new:true,set:['title=Duplicate']}),/already exists/);
    await assert.rejects(ops.edit({...s,node:'a',set:['deps=[missing]']}),/unknown|missing/i);
    await unchanged(s,count,text);
  } finally { await s.r.cleanup(); }
});

test('ED1/ED2: tool executes in worker with explicit cwd, previews without owner and records owner downgrade', async () => {
  const s = await setup();
  try {
    const tools = new Map<string,ToolDefinition>();
    owed({ registerTool(t: ToolDefinition) { tools.set(t.name,t); }, registerCommand() {}, on() {} } as unknown as ExtensionAPI);
    const tool = tools.get('owed_edit'); assert.ok(tool);
    const run = (p: object) => tool.execute('edit',p,undefined,undefined,{cwd:s.cwd,hasUI:false} as Parameters<ToolDefinition['execute']>[4]) as Promise<{isError?:boolean;content:{text?:string}[];details:ops.EditResult}>;
    const count = (await entries(s.cwd)).length;
    const preview = await run({cwd:s.cwd,node:'a',set:['writes=[test/]'],note:'preview',dry_run:true});
    assert.equal(preview.isError,undefined); assert.match(preview.content[0]!.text!,/Downgrades/); await unchanged(s,count);
    const denied = await run({cwd:s.cwd,node:'a',set:['writes=[test/]'],note:'scope',as:'parent:pi'});
    assert.equal(denied.isError,true); await unchanged(s,count);
    const done = await run({cwd:s.cwd,node:'a',set:['writes=[test/]'],note:'scope',rule:'Use the broader scope.'});
    assert.equal(done.isError,undefined,done.content[0]!.text); assert.equal(done.details.plan.by,'owner:pi');
    assert.equal(done.details.rule?.by,'owner:pi');
  } finally { await s.r.cleanup(); }
});

test('ED1/ED2: malformed paths/YAML, unrecorded edits, and append failure are atomic', async (t: TestContext) => {
  const s = await setup();
  try {
    const count = (await entries(s.cwd)).length;
    for (const set of ['id=x','drive.__proto__.model=x','checks.a.id=x','title=[','title','checks.a={id: other, run: true}']) {
      await assert.rejects(ops.edit({...s,node:'a',set:[set]})); await unchanged(s,count);
    }
    await assert.rejects(ops.edit({...s,node:'a',unset:['checks.missing']}),/missing edit path/);
    await unchanged(s,count);
    const dirty = PLAN.replace('title: Original','title: Dirty'); await writeFile(s.file,dirty);
    await assert.rejects(ops.edit({...s,node:'a',set:['title=Changed']}),/unrecorded edits/); await unchanged(s,count,dirty);
    await writeFile(s.file,PLAN);
    t.mock.method(Ledger.prototype,'append',async () => { throw new Error('append failed'); });
    await assert.rejects(ops.edit({...s,node:'a',set:['title=Changed']}),/append failed/); await unchanged(s,count);
    t.mock.restoreAll();
    if (process.getuid?.() !== 0) {
      await chmod(s.r.root,0o555);
      try { await assert.rejects(ops.edit({...s,node:'a',set:['title=Changed']}),/cannot write.*EACCES/); }
      finally { await chmod(s.r.root,0o755); }
      await unchanged(s,count);
    }
  } finally { t.mock.restoreAll(); await s.r.cleanup(); }
});

test('ED1: whole checks and field unsets resolve ids, including a flow node and a node with no checks', () => {
  const text = 'version: 1\ntrunk: main\ninvariants: []\nnodes:\n  - {id: a, title: Before, writes: [a]}\n  - id: b  # kept\n    writes: [b]\n';
  const next = editText(text,{node:'a',set:['checks.c={run: "true", timeout_s: 3}','checks.c.min_tests=1','title="x=y"'],unset:['checks.c.timeout_s']});
  const n = parsePlan(next).nodes[0]!; assert.equal(n.title,'x=y'); assert.equal(n.checks[0]?.timeout_s,600); assert.equal(n.checks[0]?.min_tests,1);
  assert.ok(next.endsWith(text.slice(text.indexOf('  - id: b'))));
  const removed = editText(next,{node:'a',unset:['checks.c']}); assert.equal(parsePlan(removed).nodes[0]!.checks.length,0);
});
