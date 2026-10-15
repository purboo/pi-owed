import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { existsSync, appendFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ops from '../src/ops.ts';
import { Driver, wakeReport, procStart } from '../src/drive-run.ts';
import { Dsa } from '../src/dsa.ts';
import { writerLaunch } from '../src/drive.ts';
import { validateDraft, projectId } from '../src/reducer.ts';
import { Ledger } from '../src/ledger.ts';
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
async function runningSlot(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const slot = await ops.dispatch({ cwd: f.cwd, as: parent, node: id });
  const state = (await ops.readState(f)).state, launch = writerLaunch(state, id, projectId(state));
  await ops.launch({ cwd: f.cwd, as: parent, node: id, attempt: 1, role: 'writer', rid: launch.rid, spec: launch.spec, labels: launch.labels, rulings: 0 });
  return slot;
}
async function accepted(f: Awaited<ReturnType<typeof fixture>>, id: string) {
  const slot = await runningSlot(f, id);
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

// Interleave real owner/parent acts at the commit lock after checkout, never bypassing the real lock.
function onDispatchCommit(t: TestContext, worktree: string, action: () => Promise<void>) {
  const lock = Ledger.prototype.withLock;
  let inside = false, fired = false;
  t.mock.method(Ledger.prototype, 'withLock', async function(this: Ledger, ...args: Parameters<Ledger['withLock']>) {
    if (!inside && !fired && args[1] === undefined && existsSync(worktree)) {
      inside = fired = true;
      try { await action(); } finally { inside = false; }
    }
    return lock.apply(this, args);
  });
}
for (const cause of ['removed', 'held', 'dependency', 'overlap'] as const) {
  test(`DQ1 review: fresh ${cause} state refuses the retried dispatch cleanly`, { timeout: 120_000 }, async t => {
    const f = await fixture([node('a'), node('b')]);
    try {
      await runningSlot(f, 'b');
      let abandon: Awaited<ReturnType<typeof ops.abandon>> | undefined;
      if (cause === 'held') {
        await ops.dispatch({ cwd: f.cwd, as: parent, node: 'a' });
        abandon = await ops.abandon({ cwd: f.cwd, as: parent, node: 'a', reason: 'pause before retry race' });
      }
      const before = await ops.readState(f), attempt = (before.state.nodes.a!.slot?.attempt ?? 0) + 1;
      onDispatchCommit(t, join(f.cwd, '.owed/wt', `a-${attempt}`), async () => {
        if (abandon) {
          const ledger = await Ledger.open(f.cwd);
          await ledger.withLock(async () => {
            const draft = { kind: 'hold', by: 'parent:test', node: 'a', abandon: abandon!.seq } as const;
            assert.deepEqual(validateDraft((await ops.readState(f)).state, draft), []);
            await ledger.append([draft]);
          });
        }
        const a = { ...node('a'), title: 'concurrent plan', ...(cause === 'dependency' ? { deps: ['b'] } : {}), ...(cause === 'overlap' ? { writes: ['b.txt'] } : {}) };
        await ops.planSet({ cwd: f.cwd, as: owner, channel: 'delegated', note: `exercise ${cause} dispatch race`, plan: JSON.stringify({ ...f.plan, nodes: cause === 'removed' ? [node('b')] : [a, node('b')] }) });
      });
      const pass = await f.driver.pass(), dispatch = pass.actions.find(a => a.do === 'dispatch' && a.node === 'a');
      assert.equal(dispatch?.outcome, 'error', JSON.stringify(pass.actions));
      const reasons = { removed: /does not exist in the current plan/, held: /held by abandon/, dependency: /requires a ready node/, overlap: /writes of a overlap the open slot of b/ };
      assert.match(dispatch!.detail!, reasons[cause]);
      assert.doesNotMatch(dispatch!.detail!, /retry next pass|TypeError/);
      const after = await ops.readState(f);
      assert.deepEqual(after.entries.filter(e => e.kind === 'dispatch'), before.entries.filter(e => e.kind === 'dispatch'), 'the failed attempt writes no dispatch entry');
      assert.ok(!after.entries.some(e => e.kind === 'halt' && e.node === 'a'));
      assert.equal(existsSync(join(f.cwd, '.owed/wt', `a-${attempt}`)), false);
      assert.equal((await git(f.cwd, ['show-ref', '--verify', '--quiet', `refs/heads/owed/a/${attempt}`], { allowFail: true })).code, 1);
      assert.equal((await ops.verify(f)).ok, true, 'all interleaved acts obey ledger guards');
    } finally { t.mock.restoreAll(); await f.done(); }
  });
}

test('DQ2 review: a waiting node outside mergeQueue has no ahead field or queue-count text', { timeout: 120_000 }, async () => {
  const f = await fixture();
  try {
    await accepted(f, 'a');
    const ledger = await Ledger.open(f.cwd), dir = join(ledger.dir, 'drive');
    await (await import('node:fs/promises')).mkdir(dir, { recursive: true });
    await ops.planSet({ cwd: f.cwd, as: owner, channel: 'delegated', note: 'remove accepted candidate from the queue', plan: JSON.stringify({ ...f.plan, nodes: [] }) });
    const n = (await ops.readState(f)).state.nodes.a!;
    await writeFile(join(dir, 'waiting.json'), JSON.stringify({ a: { attempt: n.slot!.attempt, candidate: n.candidate?.seq, reason: 'machine lease busy', since: new Date().toISOString(), ahead: -1 } }));
    const out = await cli(f.cwd, ['status', '--json']); assert.equal(out.code, 0, out.stderr);
    const view = JSON.parse(out.stdout);
    assert.ok(!view.mergeQueue.includes('a'));
    assert.ok(view.mergeWaiting.a, 'the current attempt-scoped wait remains available');
    assert.equal(Object.hasOwn(view.mergeWaiting.a, 'ahead'), false);
    for (const args of [['status'], ['status', '--full']]) {
      const text = await cli(f.cwd, args); assert.equal(text.code, 0, text.stderr);
      assert.doesNotMatch(text.stdout, /; -?\d+ merges? ahead/);
    }
  } finally { await f.done(); }
});

test('LO-W3: status derives waiting ahead from the current queue before the next driver pass', { timeout: 120_000 }, async () => {
  const f = await fixture([node('old'), node('high'), node('child', ['high']), node('tie')]);
  try {
    await accepted(f, 'old'); await accepted(f, 'high'); await accepted(f, 'tie');
    const ledger = await Ledger.open(f.cwd), dir = join(ledger.dir, 'drive'), state = (await ops.readState(f)).state;
    await (await import('node:fs/promises')).mkdir(dir, { recursive: true });
    const waits = Object.fromEntries(['old', 'tie'].map(id => [id, { attempt: state.nodes[id]!.slot!.attempt, candidate: state.nodes[id]!.candidate!.seq, reason: 'machine lease busy', since: new Date().toISOString(), ahead: id === 'old' ? 1 : 2 }]));
    const path = join(dir, 'waiting.json'); await writeFile(path, JSON.stringify(waits));
    const before = await ops.status(f);
    assert.deepEqual(before.mergeQueue, ['high', 'old', 'tie']);
    assert.equal(before.mergeWaiting!.old!.ahead, 1); assert.equal(before.mergeWaiting!.tie!.ahead, 2);

    await ops.merge({ cwd: f.cwd, as: parent, node: 'high' });
    // No driver pass rewrites the cache after the merge; positions must come from the new queue at read time.
    assert.deepEqual(JSON.parse(await readFile(path, 'utf8')), waits);
    const json = await cli(f.cwd, ['status', '--json']); assert.equal(json.code, 0, json.stderr);
    const after = JSON.parse(json.stdout);
    assert.deepEqual(after.mergeQueue, ['old', 'tie']);
    assert.equal(after.mergeWaiting.old.ahead, 0); assert.equal(after.mergeWaiting.tie.ahead, 1);
    for (const args of [['status'], ['status', '--full']]) {
      const text = await cli(f.cwd, args); assert.equal(text.code, 0, text.stderr);
      assert.match(text.stdout, /old.*merge waiting for .*; 0 merges ahead/);
      assert.match(text.stdout, /tie.*merge waiting for .*; 1 merge ahead/);
      assert.doesNotMatch(text.stdout, /tie.*2 merges ahead/);
    }
  } finally { await f.done(); }
});

test('DQ2: CLI status names the running merge and queue positions in critical-path order', { timeout: 120_000 }, async () => {
  const f = await fixture([node('old'), node('high'), node('child', ['high']), node('tie')]);
  const mark = join(f.root, 'started'), gate = join(f.root, 'gate');
  let driver: Driver | undefined;
  try {
    await accepted(f, 'old'); await accepted(f, 'high'); await accepted(f, 'tie');
    await ops.planSet({ cwd: f.cwd, as: parent, plan: JSON.stringify({ ...f.plan, invariants: [{ id: 'slow', reads: ['seed'], run: `echo started > '${mark}'; while [ ! -f '${gate}' ]; do sleep 0.05; done` }] }) });
    const ledger = await Ledger.open(f.cwd), logDir = join(ledger.dir, 'drive');
    await (await import('node:fs/promises')).mkdir(logDir, { recursive: true });
    await writeFile(join(ledger.dir, 'drive.lock'), JSON.stringify({ pid: process.pid, host: hostname(), start: procStart(process.pid), at: new Date().toISOString(), token: 'fixture' }));
    driver = new Driver({ cwd: f.cwd, dsa: new Client(), json: true, log: l => appendFileSync(join(logDir, 'log.jsonl'), l + '\n'), handleSignals: false });
    await driver.pass();
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
    await writeFile(gate, ''); await driver.settle();
    assert.equal((await ops.readState(f)).state.nodes.high!.merged !== undefined, true);
    // Finished jobs disappear at read time, before the next driver pass updates its cache.
    assert.equal((await ops.status(f)).mergeWaiting?.old, undefined);
  } finally { await writeFile(gate, ''); driver?.abort.abort(); await driver?.settle(); await f.done(); }
});
