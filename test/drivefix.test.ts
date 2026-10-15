import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ops from '../src/ops.ts';
import { Driver, wakeReport } from '../src/drive-run.ts';
import { Dsa } from '../src/dsa.ts';
import { writerLaunch } from '../src/drive.ts';
import { projectId } from '../src/reducer.ts';
import { git } from '../src/git.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';
const parent = { role: 'parent', id: 'test' } as const;
const owner = { role: 'owner', id: 'pi' } as const;
const node = (id: string, deps: string[] = []) => ({ id, deps, writes: [`${id}.txt`], checks: [], review: { count: 0, min_rank: 1 } });
class Client extends Dsa {
  constructor() { super({ bin: '/bin/true' }); }
  override async inspect(rid: string) { return { view: { rid, state: 'running' as const } }; }
}
async function fixture(nodes = [node('a')], extra = {}) {
  const r = await repo();
  await r.put('seed', 'seed'); await r.commit();
  const plan = { version: 1, trunk: 'main', closure: [], invariants: [], lease: false, nodes, ...extra };
  await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify(plan), measure: false });
  const lines: string[] = [], driver = new Driver({ cwd: r.cwd, dsa: new Client(), log: l => lines.push(l), handleSignals: false });
  return { ...r, plan, driver, lines, async done() { driver.abort.abort(); await driver.settle(); await r.cleanup(); } };
}
async function hook(f: Awaited<ReturnType<typeof fixture>>, body: string) {
  const path = join(f.cwd, '.git/hooks/post-checkout');
  const bin = fileURLToPath(new URL('../bin/owed.js', import.meta.url));
  await writeFile(path, `#!/bin/sh\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX\ncd '${f.cwd}'\n${body.replaceAll('@OWED@', `'${process.execPath}' '${bin}'`)}\nexit 0\n`);
  await chmod(path, 0o755);
}
async function accepted(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const slot = await ops.dispatch({ cwd: f.cwd, as: parent, node: id });
  const state = (await ops.readState(f)).state, launch = writerLaunch(state, id, projectId(state));
  await ops.launch({ cwd: f.cwd, as: parent, node: id, attempt: 1, role: 'writer', rid: launch.rid, spec: launch.spec, labels: launch.labels, rulings: 0 });
  await commitAt(slot.worktree, { [`${id}.txt`]: id });
  await ops.submit({ cwd: slot.worktree, node: id, as: { role: 'writer', id: `${id}#1` } });
  await ops.attest({ cwd: f.cwd, node: id });
}

test('DQ1: a plan CAS during checkout retries in the same driver pass using the new plan', { timeout: 120_000 }, async () => {
  const f = await fixture(), mark = join(f.root, 'hook-count'), next = join(f.root, 'next.json');
  try {
    await writeFile(next, JSON.stringify({ ...f.plan, nodes: [{ ...node('a'), title: 'fresh packet title' }] }));
    await hook(f, `echo attempt >> '${mark}'\n[ "$(wc -l < '${mark}')" -gt 1 ] || @OWED@ plan '${next}' > '${mark}.log' 2>&1`);
    const pass = await f.driver.pass(), dispatch = pass.actions.find(a => a.do === 'dispatch');
    assert.equal(dispatch?.outcome, 'done', JSON.stringify(pass.actions));
    assert.equal((await readFile(mark, 'utf8')).trim().split('\n').length, 2);
    const { state, entries } = await ops.readState(f);
    assert.equal(entries.filter(e => e.kind === 'dispatch').length, 1);
    assert.equal(state.nodes.a!.slot!.attempt, 1);
    assert.match(await readFile(join(state.nodes.a!.slot!.worktree, 'seed'), 'utf8'), /seed/);
    const packet = await (await import('../src/ledger.ts')).Ledger.open(f.cwd);
    assert.match((await packet.getBlob(entries.find(e => e.kind === 'dispatch')!.packet)).toString(), /fresh packet title/);
    assert.ok(pass.actions.every(a => !wakeReport(a)));
  } finally { await f.done(); }
});

test('DQ1: exhausted CAS retries roll back all slots and report retry next pass without a wake or halt', { timeout: 120_000 }, async () => {
  const f = await fixture(), mark = join(f.root, 'hook-count');
  try {
    await hook(f, `echo attempt >> '${mark}'\n@OWED@ rule 'changed during checkout' --nodes '*' >> '${mark}.log' 2>&1`);
    const pass = await f.driver.pass(), dispatch = pass.actions.find(a => a.do === 'dispatch');
    assert.equal(dispatch?.outcome, 'retry', JSON.stringify(pass.actions));
    assert.match(dispatch!.detail!, /retry next pass/);
    assert.equal(wakeReport(dispatch!), false);
    assert.equal((await readFile(mark, 'utf8')).trim().split('\n').length, 3, 'three total attempts bound the pass');
    const { entries } = await ops.readState(f);
    assert.ok(!entries.some(e => e.kind === 'dispatch' || e.kind === 'halt'));
    assert.equal((await git(f.cwd, ['worktree', 'list', '--porcelain'])).stdout.split('\n').filter(l => l.startsWith('worktree ')).length, 1);
    assert.equal((await git(f.cwd, ['show-ref', '--verify', '--quiet', 'refs/heads/owed/a/1'], { allowFail: true })).code, 1);
    await hook(f, 'exit 0');
    assert.equal((await f.driver.pass()).actions.find(a => a.do === 'dispatch')?.outcome, 'done');
  } finally { await f.done(); }
});

test('DQ1: non-CAS setup failures remain errors and are never retried', { timeout: 120_000 }, async () => {
  const f = await fixture([], {}), mark = join(f.root, 'setup-count');
  try {
    await ops.planSet({ cwd: f.cwd, as: owner, channel: 'delegated', note: 'exercise a failing setup', plan: JSON.stringify({ ...f.plan, nodes: [node('a')], slot_setup: `echo attempt >> '${mark}'; exit 1` }) });
    const pass = await f.driver.pass(), dispatch = pass.actions.find(a => a.do === 'dispatch');
    assert.equal(dispatch?.outcome, 'error');
    assert.equal(wakeReport(dispatch!), true);
    assert.equal((await readFile(mark, 'utf8')).trim(), 'attempt');
    assert.ok(!(await ops.readState(f)).entries.some(e => e.kind === 'dispatch'));
  } finally { await f.done(); }
});

test('DQ2: CLI status names the running merge and queue positions in critical-path order', { timeout: 120_000 }, async () => {
  const f = await fixture([node('old'), node('high'), node('child', ['high']), node('tie')]);
  const mark = join(f.root, 'started'), gate = join(f.root, 'gate');
  try {
    await accepted(f, 'old'); await accepted(f, 'high'); await accepted(f, 'tie');
    await ops.planSet({ cwd: f.cwd, as: parent, plan: JSON.stringify({ ...f.plan, invariants: [{ id: 'slow', reads: ['seed'], run: `echo started > '${mark}'; while [ ! -f '${gate}' ]; do sleep 0.05; done` }] }) });
    await f.driver.pass();
    const end = Date.now() + 10_000;
    while (!existsSync(mark) && Date.now() < end) await new Promise(r => setTimeout(r, 20));
    assert.ok(existsSync(mark), f.lines.join('\n'));
    const status = await cli(f.cwd, ['status', '--json']); assert.equal(status.code, 0, status.stderr);
    const view = JSON.parse(status.stdout);
    assert.deepEqual(view.mergeQueue, ['high', 'old', 'tie']);
    assert.equal(view.mergeWaiting.old.job, 'high merge');
    assert.equal(view.mergeWaiting.old.ahead, 1);
    assert.equal(view.mergeWaiting.tie.ahead, 2);
    for (const args of [['status'], ['status', '--full']]) {
      const text = await cli(f.cwd, args); assert.equal(text.code, 0, text.stderr);
      assert.match(text.stdout, /old.*merge waiting for driver-internal job \(high merge, since \d\d:\d\d\); 1 merge ahead/);
      assert.match(text.stdout, /tie.*merge waiting for driver-internal job \(high merge, since \d\d:\d\d\); 2 merges ahead/);
    }
    await writeFile(gate, ''); await f.driver.settle();
    assert.equal((await ops.readState(f)).state.nodes.high!.merged !== undefined, true);
    // Position is derived from the current queue, even before the next driver pass updates its cache.
    assert.equal((await ops.status(f)).mergeWaiting?.old?.ahead, 0);
  } finally { await writeFile(gate, ''); await f.done(); }
});
