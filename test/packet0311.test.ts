import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';
import * as ops from '../src/ops.ts';
import { dispatchPacket } from '../src/views.ts';
import { writerTask } from '../src/drive.ts';
import { driveOnce } from '../src/drive-run.ts';
import { Dsa } from '../src/dsa.ts';
import { Ledger } from '../src/ledger.ts';
import { git } from '../src/git.ts';
import { repo } from './helpers/repo.ts';
import { cli } from './helpers/surface.ts';

const owner = { role: 'owner', id: 'pi' } as const;
const inv = (id: string, reads: string[]) => ({ id, reads, run: 'true' });
const plan = (writes = ['src/*.ts']) => ({ version: 1, trunk: 'main', closure: [], invariants: [inv('src', ['src/**']), inv('suite', ['**']), inv('broad-globs', ['src/**', 'docs/**'])], nodes: [{ id: 'a', writes, checks: [], review: { count: 0, min_rank: 1 } }] });
const order = 'Checks, owed check try and your own preflight see committed HEAD only: commit code, then evidence, then measure, then report.';
const heading = 'Invariants that measure files you write (they run on the merge tree at merge; try one first: owed check try --invariant <id> --green <your commit>):';
const note = 'note: a writes files inv:src measures (src/**); before submit: owed check try --invariant src --green <commit>';
async function fixture(p = plan()) {
  const r = await repo();
  await r.put('src/a.ts', 'base');
  for (let i = 0; i < 9; i++) await r.put(`docs/${i}.md`, 'base');
  const base = await r.commit();
  await r.put('plan.json', JSON.stringify(p));
  await ops.init({ cwd:r.cwd, as:owner, channel:'delegated', plan:JSON.stringify(p), path:'plan.json', measure:false });
  return { ...r, base };
}
async function state(cwd: string) { return (await ops.readState({ cwd })).state; }
function tools(cwd: string) {
  const registered = new Map<string,ToolDefinition>();
  owed({ registerTool(t: ToolDefinition) { registered.set(t.name,t); }, registerCommand() {} } as unknown as ExtensionAPI);
  const ctx = { cwd, hasUI:false } as Parameters<ToolDefinition['execute']>[4];
  return async (name: string, args: Record<string,unknown>) => registered.get(`owed_${name}`)!.execute('packet',args,undefined,undefined,ctx);
}

test('PK1/PK3: manual packet shows narrow overlap and grouped broad invariants before long-run guidance', async () => {
  const r = await fixture();
  try {
    const d = await ops.dispatch({ cwd:r.cwd, as:owner, channel:'delegated', node:'a' });
    assert.ok(d.packet.includes(heading),d.packet);
    assert.ok(d.packet.includes('- inv:src: src/**'));
    assert.ok(d.packet.includes('- broad: inv:suite, inv:broad-globs (every change)'));
    assert.equal(d.packet.split('\n').filter(l => l.startsWith('- broad:')).length,1);
    assert.ok(d.packet.indexOf('Checks run by owed:') < d.packet.indexOf(heading));
    assert.ok(d.packet.indexOf(heading) < d.packet.indexOf('Long runs:'));
    assert.ok(d.packet.includes(`${order}\ncommit your work;`));
  } finally { await r.cleanup(); }
});

test('PK1: literal new files overlap, but absent glob/prefix paths and disjoint writes do not guess future files', async () => {
  for (const [writes, reads, overlap] of [
    [['new/test.ts'], ['new/**'], true],
    [['new/*.ts'], ['new/**'], false],
    [['new/'], ['new/**'], false],
    [['src/*.ts'], ['docs/**'], false],
    [['src/'], ['src/a.ts'], true],
  ] as [string[],string[],boolean][]) {
    const p = plan(writes); p.invariants = [inv('target',reads)];
    const r = await fixture(p);
    try {
      const d = await ops.dispatch({ cwd:r.cwd, as:owner, channel:'delegated', node:'a' });
      assert.equal(d.packet.includes(heading),overlap,`${writes}: ${d.packet}`);
    } finally { await r.cleanup(); }
  }
});

test('PK1: packet bounds invariant and read lists; >=90% is broad, 89% is not', async () => {
  const p = plan();
  p.invariants = Array.from({ length:7 }, (_,i) => inv(`n${i}`,['src/**',...Array.from({length:6},(_,j) => `missing/${j}`)]));
  p.invariants.push(inv('ninety', ['src/**', ...Array.from({length:8},(_,i) => `docs/${i}.md`)]));
  p.invariants.push(inv('eighty', ['src/**', ...Array.from({length:7},(_,i) => `docs/${i}.md`)]));
  const r = await fixture(p);
  try {
    const d = await ops.dispatch({ cwd:r.cwd, as:owner, channel:'delegated', node:'a' });
    assert.ok(d.packet.includes('- inv:n0: src/**, missing/0, missing/1, missing/2, missing/3, +2 more'));
    assert.equal(d.packet.split('\n').filter(l => l.startsWith('- inv:')).length,5);
    assert.ok(d.packet.includes('\n+3 more\n'));
    assert.ok(d.packet.includes('- broad: inv:ninety (every change)'));
  } finally { await r.cleanup(); }
});

test('PK1: pure renderer without inventory omits the section; plans without invariants add only PK3', async () => {
  const r = await fixture();
  try {
    const s = await state(r.cwd), spec = s.plan.nodes[0]!;
    const without = dispatchPacket(spec,1,'/slot',[],false,s);
    assert.ok(!without.includes(heading));
    assert.ok(without.includes(order));
    const p = plan(); p.invariants = [];
    const plain = await fixture(p);
    try {
      const d = await ops.dispatch({ cwd:plain.cwd, as:owner, channel:'delegated', node:'a' });
      assert.ok(!d.packet.includes(heading));
      assert.ok(d.packet.includes(order));
    } finally { await plain.cleanup(); }
  } finally { await r.cleanup(); }
});

test('PK1: driver launch receives the dispatch-base inventory after trunk files move', async () => {
  const r = await fixture();
  try {
    const d = await ops.dispatch({ cwd:r.cwd, as:{role:'parent',id:'drive'}, node:'a' });
    const dir = join(r.root,'fake'); await mkdir(dir);
    const dsa = new Dsa({ bin:fileURLToPath(new URL('./fixtures/fake-dsa.mjs',import.meta.url)), env:{ FAKE_DSA_DIR:dir }, timeoutMs:30_000 });
    // A runtime tree with fewer tracked files must not alter the dispatched attempt's inventory.
    await git(r.cwd,['rm','src/a.ts']); await r.commit();
    await driveOnce({ cwd:r.cwd, dsa });
    const ledger = await Ledger.open(r.cwd), entries = await ledger.read();
    const launch = entries.find(e => e.kind === 'launch' && e.role === 'writer');
    assert.ok(launch?.kind === 'launch');
    const task = JSON.parse((await ledger.getBlob(launch.spec)).toString()).task;
    assert.ok(task.includes('- inv:src: src/**'),task);
    assert.equal(task,d.packet);
    const s = await state(r.cwd);
    // Inventory remains an explicit runtime input to pure reconstruction.
    assert.equal(writerTask(s,'a',['src/a.ts',...Array.from({length:9},(_,i) => `docs/${i}.md`)]),d.packet);
  } finally { await r.cleanup(); }
});

test('PK2: CLI plan notes only added or changed writes, never warnings or ledger entries', async () => {
  const initial = plan(['docs/']); const r = await fixture(initial);
  try {
    const next = plan(); await r.put('plan.json',JSON.stringify(next));
    const ledger = await Ledger.open(r.cwd), before = await ledger.read();
    const out = await cli(r.cwd,['plan','plan.json','--as','owner:pi','--note','changed writes','--json']);
    assert.equal(out.code,0,out.stderr);
    const data = JSON.parse(out.stdout); assert.deepEqual(data.notes,[note]);
    assert.ok(!data.warnings.some((w: string) => w.includes('writes files')));
    assert.deepEqual((await ledger.read()).slice(before.length).map(e => e.kind),['plan']);
    next.nodes[0]!.id = 'a'; Object.assign(next.nodes[0]!,{title:'title only'}); await r.put('plan.json',JSON.stringify(next));
    const unchanged = await cli(r.cwd,['plan','plan.json','--as','owner:pi','--note','title only']);
    assert.equal(unchanged.code,0,unchanged.stderr); assert.ok(!unchanged.stdout.includes('writes files inv:'));
    const added = { ...next, nodes:[...next.nodes,{...next.nodes[0]!,id:'b'}] }; await r.put('plan.json',JSON.stringify(added));
    const add = await cli(r.cwd,['plan','plan.json','--as','owner:pi','--note','added node']);
    assert.equal(add.code,0,add.stderr); assert.ok(add.stdout.includes(note.replace('note: a ','note: b ')));
  } finally { await r.cleanup(); }
});

test('PK2: CLI and tool edit dry-run notes are output only; tool plan record prints the same note', async () => {
  const r = await fixture(plan(['docs/']));
  try {
    const ledger = await Ledger.open(r.cwd), before = await ledger.read(), disk = await readFile(join(r.cwd,'plan.json'),'utf8');
    const args = ['edit','a','--plan','plan.json','--set','writes=[src/*.ts]','--note','preview','--dry-run','--as','owner:pi'];
    const out = await cli(r.cwd,args); assert.equal(out.code,0,out.stderr); assert.ok(out.stdout.includes(note),out.stdout);
    const call = tools(r.cwd);
    const preview = await call('edit',{node:'a',plan:'plan.json',set:['writes=[src/*.ts]'],note:'preview',dry_run:true,as:'owner:pi'});
    assert.notEqual(preview.isError,true); assert.ok(JSON.stringify(preview.content).includes(note));
    assert.deepEqual(await ledger.read(),before); assert.equal(await readFile(join(r.cwd,'plan.json'),'utf8'),disk);
    await r.put('plan.json',JSON.stringify(plan()));
    const recorded = await call('plan',{plan:'plan.json',note:'changed writes',as:'owner:pi'});
    assert.notEqual(recorded.isError,true); assert.ok(JSON.stringify(recorded.content).includes(note));
    assert.deepEqual((recorded.details as {notes:string[]}).notes,[note]);
    assert.deepEqual((await ledger.read()).slice(before.length).map(e => e.kind),['plan']);
  } finally { await r.cleanup(); }
});

test('PK2: notes bound output to ten non-broad overlaps and a remainder line', async () => {
  const p = plan(['docs/']); p.invariants = [...Array.from({length:12},(_,i) => inv(`n${i}`,['src/**'])),inv('all',['**'])];
  const r = await fixture(p);
  try {
    p.nodes[0]!.writes = ['src/*.ts']; await r.put('plan.json',JSON.stringify(p));
    const out = await cli(r.cwd,['plan','plan.json','--as','owner:pi','--note','changed writes']);
    assert.equal(out.code,0,out.stderr);
    assert.equal(out.stdout.split('\n').filter(l => l.startsWith('note: a writes')).length,10);
    assert.ok(out.stdout.includes('note: +2 more')); assert.ok(!out.stdout.includes('writes files inv:all'));
  } finally { await r.cleanup(); }
});
