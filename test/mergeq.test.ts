// MQ1–MQ2 (0.31): active capacity and durable, candidate-scoped batch isolation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import { decide, writerLaunch } from '../src/drive.ts';
import { Driver } from '../src/drive-run.ts';
import { Dsa } from '../src/dsa.ts';
import { batchFailed, dispatchSkip, mergeBatchPlan, projectId, reduce } from '../src/reducer.ts';
import { receipt, renderWhy, renderStatus, statusView } from '../src/views.ts';
import type { Draft, Entry, Plan, State } from '../src/types.ts';
import { Ledger } from '../src/ledger.ts';
import { repo } from './helpers/repo.ts';
import { commitAt } from './helpers/surface.ts';

const parent = { role: 'parent', id: 'test' } as const;
const owner = { role: 'owner', id: 'test' } as const;
const plain = (id: string) => ({ id, deps: [], writes: [`${id}.txt`], checks: [], review: { count: 0, min_rank: 1 } });
function capacityRig(accepted: number, active: number) {
  const plan: Plan = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: Array.from({ length: 10 }, (_, i) => plain(`n${i}`)) };
  const entries: Entry[] = [];
  const state = () => reduce(entries, () => plan);
  const add = (d: Draft) => { const seq = entries.length; entries.push({ ...d, seq, ts: new Date(seq * 1000).toISOString(), prev: 'x', hash: `hash${seq}` } as Entry); return state(); };
  add({ kind: 'genesis', by: 'owner:test', channel: 'flag', plan: 'p', trunk: 'main', commit: 'base', state: { commit: 'base', tree: 'tree', invKeys: {} } });
  for (let i = 0; i < accepted + active; i++) {
    const node = `n${i}`;
    add({ kind: 'dispatch', by: 'parent:test', node, attempt: 1, base: 'base', branch: node, worktree: `/repo/${node}`, packet: 'packet', rulings_seen: -1 });
    if (i >= accepted) continue;
    add({ kind: 'submit', by: `writer:${node}#1`, node, attempt: 1, facts: { commit: `commit-${node}`, tree: `tree-${node}`, base: 'base', patch: `patch-${node}`, changed: [`${node}.txt`], closureTouched: false, keys: { writes: `writes-${node}`, review: `review-${node}`, rulings: `rulings-${node}` } } });
    add({ kind: 'obs', by: 'executor:owed', subject: node, obligation: 'writes', key: `writes-${node}`, verdict: 'pass', commit: `commit-${node}`, base: 'base', exit: 0, durationMs: 0 });
    assert.equal(state().nodes[node]!.phase, 'accepted', 'fixture reaches real accepted phase');
  }
  return state();
}
const actions = (s: State, max: number) => decide(s, s.plan, new Map(), { max, repairs: 2, project: projectId(s), root: '/repo', applied: new Set(), rejected: new Map() });

test('MQ1: three open of max three, two accepted, dispatches two active reservations', () => {
  const s = capacityRig(2, 1);
  assert.deepEqual(actions(s, 3).filter(a => a.do === 'dispatch').map(a => a.node), ['n3', 'n4']);
  const skip = dispatchSkip(s, 'n5', 3, ['n0', 'n1', 'n2', 'n3', 'n4']);
  assert.equal(skip?.kind, 'max');
  const view = statusView(s, [], [], Date.now(), true, [], 3);
  for (const full of [false, true]) assert.match(renderStatus(view, { full }), /^active 1 of max 3, waiting to merge 2$/m);
});

test('MQ1/R-031-MQ-2: idle and active-only ledgers have no standalone capacity line', () => {
  for (const active of [0, 3]) {
    const view = statusView(capacityRig(0, active), [], [], Date.now(), true, [], 3);
    for (const full of [false, true]) assert.doesNotMatch(renderStatus(view, { full }), /^active \d+ of max \d+, waiting to merge \d+$/m);
    if (active === 3) assert.match(renderStatus(view), /3 active of max 3 \(0 waiting to merge\)/, 'skip capacity text remains visible');
  }
});

test('MQ1: total cap bounds same-pass reservations even with active capacity left', () => {
  const s = capacityRig(4, 1);
  assert.deepEqual(actions(s, 3).filter(a => a.do === 'dispatch').map(a => a.node), ['n5']);
  assert.match(renderStatus(statusView(s, [], [], Date.now(), true, [], 3)), /n6: ready, not dispatched: 6 open attempts reach the cap 2 × max = 6 \(4 waiting to merge\)/);
  const capped = capacityRig(5, 1);
  assert.equal(actions(capped, 3).filter(a => a.do === 'dispatch').length, 0);
  assert.match(renderWhy(receipt(capped, [], 'n6', [], 3)), /ready, not dispatched: 6 open attempts reach the cap 2 × max = 6 \(5 waiting to merge\)/);
});

test('MQ1: active-limit text, removed slots and accepted writes overlap remain accurate', () => {
  const s = capacityRig(1, 3);
  assert.match(renderWhy(receipt(s, [], 'n4', [], 3)), /ready, not dispatched: 3 active of max 3 \(1 waiting to merge\)/);
  // Removed slots retain their reservation; this is the reducer's removed-node phase.
  s.nodes.n1!.phase = 'removed'; s.plan.nodes = s.plan.nodes.filter(n => n.id !== 'n1');
  assert.equal(actions(s, 3).filter(a => a.do === 'dispatch').length, 0);
  const overlap = capacityRig(1, 0);
  overlap.plan.nodes.find(n => n.id === 'n1')!.writes = ['n0.txt'];
  assert.equal(dispatchSkip(overlap, 'n1', 3)?.kind, 'overlap');
});

class SealedDsa extends Dsa {
  override async describe(rid: string) { return { rid, state: 'sealed' as const, status: 'ok' as const }; }
  override async inspect(rid: string) { return { view: await this.describe(rid) }; }
}
async function batchRig(gated = false) {
  const r = await repo();
  await commitAt(r.cwd, { README: 'fixture' });
  const gate = gated ? `if test -f a.txt && test -f b.txt; then touch '${join(r.root, 'started')}'; for i in $(seq 1 1000); do test -f '${join(r.root, 'release')}' && break; sleep .01; done; fi; ` : '';
  const plan = { version: 1, trunk: 'main', closure: [], lease: false, drive: { max: 4, merge_batch: 2, min_free_mb: 0 }, invariants: [{ id: 'pair', run: gate + "if grep -qx a a.txt 2>/dev/null && grep -qx b b.txt 2>/dev/null; then exit 1; fi; echo '# tests 1'; echo '# pass 1'", timeout_s: 20 }], nodes: ['a', 'b', 'c', 'd'].map(plain) };
  await ops.init({ cwd: r.cwd, as: owner, channel: 'flag', plan: JSON.stringify(plan) });
  const slots: Record<string, string> = {};
  for (const node of ['a', 'b', 'c', 'd']) {
    const slot = await ops.dispatch({ cwd: r.cwd, node, as: parent }); slots[node] = slot.worktree;
    const s = (await ops.readState(r)).state;
    await ops.launch({ cwd: r.cwd, as: parent, ...writerLaunch(s, node, projectId(s)) });
    await commitAt(slot.worktree, { [`${node}.txt`]: node });
    await ops.submit({ cwd: slot.worktree, node, as: { role: 'writer', id: `${node}#1` } });
    assert.equal((await ops.attest({ cwd: r.cwd, node })).accepted, true);
  }
  const ledger = await Ledger.open(r.cwd), file = join(ledger.dir, 'drive', 'batch-isolated.json');
  const out: string[] = [], driver = new Driver({ cwd: r.cwd, dsa: new SealedDsa(), log: l => out.push(l) });
  const step = async () => { await driver.pass(); await driver.settle(); };
  const isolated = async (): Promise<Record<string, string>> => {
    try { return JSON.parse(await readFile(file, 'utf8')); }
    catch (e) { assert.fail(`MQ2 must persist a readable isolation record after refusal: ${e}`); }
  };
  return { ...r, slots, ledger, file, out, driver, step, isolated };
}
async function refuse(f: Awaited<ReturnType<typeof batchRig>>) {
  await f.step();
  assert.ok(f.out.some(l => l.includes('batch merge refused')), f.out.join('\n'));
}

test('MQ2: refused members stay single across new trunk and partners; merged records drop', { timeout: 180_000 }, async () => {
  const f = await batchRig();
  try {
    await refuse(f);
    assert.match(f.out.join('\n'), /a, b merge alone until merged or resubmitted/);
    const before = (await ops.readState(f)).state;
    assert.deepEqual(await f.isolated(), { a: before.nodes.a!.candidate!.commit, b: before.nodes.b!.candidate!.commit });
    await f.step(); // a alone advances trunk; b now has c and d as possible partners.
    const now = (await ops.readState(f)).state;
    assert.notEqual(now.trunk.commit, before.trunk.commit);
    assert.equal(now.nodes.a!.phase, 'merged');
    assert.deepEqual(await f.isolated(), { b: before.nodes.b!.candidate!.commit });
    const index = f.out.length;
    await f.step();
    assert.ok(f.out.slice(index).some(l => l === 'merge b: started'), f.out.slice(index).join('\n'));
    assert.ok(!f.out.slice(index).some(l => l.includes('batch of')), 'isolated head must merge alone');
    assert.ok((await f.ledger.read()).some(e => e.kind === 'halt' && e.node === 'b'), 'single refusal retains the existing halt');
  } finally { await f.driver.settle(); await f.cleanup(); }
});

test('MQ2: a new driver process loads isolation and leaves unrelated members batchable', { timeout: 180_000 }, async () => {
  const f = await batchRig();
  try {
    await refuse(f);
    await f.step(); // a merges alone, trunk changes.
    const script = `import { Driver } from ${JSON.stringify(new URL('../src/drive-run.ts', import.meta.url).href)};
      import { Dsa } from ${JSON.stringify(new URL('../src/dsa.ts', import.meta.url).href)};
      const dsa = new Dsa(); dsa.inspect = async rid => ({view:{rid,state:'sealed',status:'ok'}});
      const d = new Driver({cwd:process.cwd(),dsa,log:console.log}); await d.pass(); await d.settle();`;
    const child = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { cwd: f.cwd, timeout: 90_000 });
    assert.match(child.stdout, /^merge b: started$/m);
    assert.doesNotMatch(child.stdout, /batch of/);
    // b is now halted; c and d still batch together in a restarted driver.
    const again = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { cwd: f.cwd, timeout: 90_000 });
    assert.match(again.stdout, /batch of 2: c, d/);
    assert.deepEqual(Object.keys(await f.isolated()), ['b']);
  } finally { await f.driver.settle(); await f.cleanup(); }
});

test('MQ2: unchanged resubmit stays isolated; changed candidate and closed slot drop records', { timeout: 180_000 }, async () => {
  const f = await batchRig();
  try {
    await refuse(f);
    const original = await f.isolated();
    await ops.submit({ cwd: f.slots.a!, node: 'a', as: { role: 'writer', id: 'a#1' } });
    // Freeze scheduling while reconciling the runtime file, preserving the candidate for the next pass.
    f.driver.stopping = true; await f.driver.pass();
    assert.deepEqual(await f.isolated(), original, 'identity is commit, not submit sequence');
    assert.equal(batchFailed((await ops.readState(f)).state, ['a', 'b']), true, 'same commit keeps the ledger-derived suppression too');
    await commitAt(f.slots.a!, { 'a.txt': 'resubmitted' });
    await ops.submit({ cwd: f.slots.a!, node: 'a', as: { role: 'writer', id: 'a#1' } });
    assert.equal((await ops.attest({ cwd: f.cwd, node: 'a' })).accepted, true);
    await f.driver.pass();
    assert.deepEqual(await f.isolated(), { b: original.b });
    assert.equal(batchFailed((await ops.readState(f)).state, ['a', 'b']), false, 'one changed candidate lifts MT4, but unchanged b remains isolated');
    await ops.abandon({ cwd: f.cwd, node: 'b', as: parent, hold: true, reason: 'close isolated slot' });
    await ops.abandon({ cwd: f.cwd, node: 'd', as: parent, hold: true, reason: 'leave one partner for the resubmitted candidate' });
    await f.driver.pass();
    assert.deepEqual(await f.isolated(), {});
    f.driver.stopping = false;
    const index = f.out.length;
    await f.step();
    assert.match(f.out.slice(index).join('\n'), /batch of 2:/);
    const merges = (await f.ledger.read()).filter(e => e.kind === 'merge');
    assert.ok(merges.some(e => e.kind === 'merge' && e.batch?.members.includes('a')), 'new candidate batches again');
  } finally { await f.driver.settle(); await f.cleanup(); }
});

test('MQ2/R-031-MQ-1: both new candidate commits batch on the same trunk and member list', { timeout: 180_000 }, async () => {
  const f = await batchRig();
  try {
    await refuse(f);
    const before = (await ops.readState(f)).state;
    assert.equal(batchFailed(before, ['a', 'b']), true);
    for (const node of ['a', 'b']) {
      await commitAt(f.slots[node]!, { [`${node}.txt`]: `${node}-fixed` });
      await ops.submit({ cwd: f.slots[node]!, node, as: { role: 'writer', id: `${node}#1` } });
      assert.equal((await ops.attest({ cwd: f.cwd, node })).accepted, true);
    }
    const now = (await ops.readState(f)).state;
    assert.equal(now.trunk.commit, before.trunk.commit);
    assert.equal(batchFailed(now, ['a', 'b']), false);
    assert.deepEqual(mergeBatchPlan(now, 2, ['a', 'b']), ['a', 'b']);
    for (const node of ['c', 'd']) await ops.abandon({ cwd: f.cwd, node, as: parent, hold: true, reason: 'exercise original member pair' });
    const index = f.out.length;
    await f.step();
    assert.match(f.out.slice(index).join('\n'), /batch of 2: a, b/);
    assert.equal((await ops.readState(f)).state.nodes.b!.phase, 'merged');
    assert.deepEqual(await f.isolated(), {});
  } finally { await f.driver.settle(); await f.cleanup(); }
});

test('MQ2: a refusal arriving after resubmission never isolates the newer candidate', { timeout: 180_000 }, async () => {
  const f = await batchRig(true);
  try {
    const old = (await ops.readState(f)).state.nodes.a!.candidate!.commit;
    await f.driver.pass();
    let started = false;
    for (let i = 0; i < 500; i++) {
      if (await readFile(join(f.root, 'started')).then(() => true, () => false)) { started = true; break; }
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.equal(started, true, 'batch measurement reaches its bounded gate');
    const next = await commitAt(f.slots.a!, { 'a.txt': 'new candidate while batch measures' });
    assert.notEqual(next, old);
    await ops.submit({ cwd: f.slots.a!, node: 'a', as: { role: 'writer', id: 'a#1' } });
    await writeFile(join(f.root, 'release'), 'go');
    await f.driver.settle();
    assert.ok(f.out.some(l => l.includes('batch merge refused')), f.out.join('\n'));
    const isolated = await f.isolated();
    assert.equal(isolated.a, undefined, 'stale refusal is reconciled against the new candidate');
    assert.equal(isolated.b, (await ops.readState(f)).state.nodes.b!.candidate!.commit);
  } finally { await writeFile(join(f.root, 'release'), 'go'); await f.driver.settle(); await f.cleanup(); }
});

test('MQ2: unreadable isolation file is treated as no records', { timeout: 180_000 }, async () => {
  const f = await batchRig();
  try {
    await mkdir(join(f.ledger.dir, 'drive'), { recursive: true });
    await writeFile(f.file, '{torn');
    await refuse(f);
    assert.deepEqual(Object.keys(await f.isolated()), ['a', 'b']);
  } finally { await f.driver.settle(); await f.cleanup(); }
});
