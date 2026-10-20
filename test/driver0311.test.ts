// 0.31.1 PD1–PD6: imports available on 590bdca so red runs fail on behavior.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { appendFileSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';
import * as ops from '../src/ops.ts';
import { DriveWatch, revalidator } from '../src/drive-bg.ts';
import { Driver, procStart } from '../src/drive-run.ts';
import { Dsa } from '../src/dsa.ts';
import { writerLaunch } from '../src/drive.ts';
import { projectId } from '../src/reducer.ts';
import { registerDriver } from '../src/registry.ts';
import { watchDriver } from '../src/watch.ts';
import { Ledger } from '../src/ledger.ts';
import { repo } from './helpers/repo.ts';
import { commitAt } from './helpers/surface.ts';

const owner = { role: 'owner', id: 'test' } as const, parent = { role: 'parent', id: 'test' } as const;
const plain = (id: string) => ({ id, writes: [`${id}.txt`], checks: [], review: { count: 0, min_rank: 1 } });
async function fixture(batch = false) {
  const saved = { ...process.env }, r = await repo();
  for (const key of ['DSA_EXEC', 'DSA_CALL', 'DSA_SESSION', 'PI_SESSION_ID', 'OWED_CONFIRM']) delete process.env[key];
  process.env.XDG_STATE_HOME = join(r.root, 'state');
  process.env.OWED_DSA = fileURLToPath(new URL('./fixtures/fake-dsa.mjs', import.meta.url));
  process.env.FAKE_DSA_DIR = join(r.root, 'dsa');
  const plan = { version: 1, trunk: 'main', closure: [], lease: false, drive: { max: 4, merge_batch: 2, min_free_mb: 0 },
    invariants: batch ? [{ id: 'pair', run: "if test -f a.txt && test -f b.txt; then exit 1; fi; echo '# tests 1'; echo '# pass 1'" }] : [],
    nodes: batch ? ['a', 'b', 'c'].map(plain) : [{ ...plain('a'), later: true }] };
  await r.put('plan.json', JSON.stringify(plan)); await r.commit();
  await ops.init({ cwd: r.cwd, as: owner, channel: 'flag', plan: JSON.stringify(plan), path: 'plan.json' });
  const ledger = await Ledger.open(r.cwd), dir = ledger.dir, log = join(dir, 'drive/log.jsonl'), lock = join(dir, 'drive.lock');
  mkdirSync(join(dir, 'drive'), { recursive: true }); writeFileSync(log, '');
  const lockOwner = { pid: process.pid, start: procStart(process.pid), host: hostname(), at: new Date().toISOString(), token: 'pd-fixture' };
  return { ...r, ledger, dir, log, lock, lockOwner,
    held: () => writeFileSync(lock, JSON.stringify(lockOwner)),
    append(line: unknown) { appendFileSync(log, `${typeof line === 'string' ? line : JSON.stringify(line)}\n`); },
    async close() { await r.cleanup(); for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); },
  };
}
const wake = (text: string, facts = 9999) => ({ do: 'notify', node: 'a', facts, text });
function harness(cwd: string) {
  const tools = new Map<string, ToolDefinition>(), events = new Map<string, (e: unknown, ctx: unknown) => Promise<void>>(), messages: string[] = [];
  const ctx = { cwd, hasUI: false, isIdle: () => true, sessionManager: { getSessionId: () => 'pd-session' }, ui: { notify() {} } } as unknown as Parameters<ToolDefinition['execute']>[4];
  owed({ registerTool: (t: ToolDefinition) => tools.set(t.name, t), registerCommand() {}, on: (n: string, f: (e: unknown, ctx: unknown) => Promise<void>) => events.set(n, f), sendMessage: (m: { content: string }) => messages.push(m.content) } as unknown as ExtensionAPI);
  return { messages, emit: async (name: string) => { await events.get(name)?.({}, ctx); }, call: (cwd: string) => tools.get('owed_why')!.execute('pd', { cwd, node: 'missing' }, undefined, undefined, ctx) };
}

test('PD1 session start, refused tool attach and registry discover wakes already in the log', { timeout: 30_000 }, async () => {
  const f = await fixture(); f.held();
  try {
    for (const via of ['session', 'tool', 'registry']) {
      writeFileSync(f.log, ''); f.append(wake(`before ${via} attach`));
      const h = harness(via === 'session' ? f.cwd : f.root);
      try {
        if (via === 'registry') registerDriver(f.cwd, { ...f.lockOwner, session: 'pd-session' });
        await h.emit('session_start');
        if (via === 'tool') assert.equal((await h.call(f.cwd)).isError, true);
        const end = Date.now() + 6000;
        while (!h.messages.length && Date.now() < end) await new Promise(r => setTimeout(r, 50));
        assert.match(h.messages.join('\n'), new RegExp(`before ${via} attach`));
        f.append(wake(`before ${via} attach`)); await h.emit('agent_settled');
        assert.equal(h.messages.length, 1, 'reattach and live repeat preserve follower dedup');
      } finally { await h.emit('session_shutdown'); }
    }
  } finally { await f.close(); }
});

test('PD1 attach bounds the replay, skips a partial first line, revalidates one batch and follows the end', async () => {
  const f = await fixture(); f.held(); const got: string[] = []; let calls = 0;
  const watch = new DriveWatch(s => got.push(s), 0, { busy: () => false, revalidate: cwd => async checks => { calls++; return revalidator({ cwd })(checks); } });
  try {
    f.append('outside replay window'); f.append('界'.repeat(100_000));
    f.append(wake('stale before attach', 0));
    await ops.rule({ cwd: f.cwd, as: parent, nodes: ['a'], text: 'resolved old facts' });
    f.append(wake('current before attach')); f.append(wake('other current', 10000));
    const follower = await watch.attach(f.cwd); await watch.flush();
    assert.equal(got.length, 1); assert.equal(calls, 1, 'all replay wakes share one revalidation');
    assert.match(got[0]!, /current before attach/); assert.match(got[0]!, /other current/);
    assert.doesNotMatch(got[0]!, /outside replay window|界|stale before attach/);
    assert.equal(follower!.next, `${statSync(f.log).size}:${statSync(f.log).ino}`);
    assert.equal(await watch.attach(f.cwd), follower); await watch.flush(); assert.equal(got.length, 1);
    f.append(wake('after attach', 10001)); await watch.flush(); assert.match(got[1]!, /after attach/);
  } finally { watch.stopAll(); await f.close(); }
});

test('PD1 busy replay revalidates when released; failed delivery retries without losing live lines', async () => {
  const f = await fixture(); f.held(); let busy = true, fail = true; const got: string[] = [];
  const watch = new DriveWatch(s => { if (fail) { fail = false; throw new Error('delivery unavailable'); } got.push(s); }, 0, { busy: () => busy, revalidate: cwd => revalidator({ cwd }) });
  try {
    f.append(wake('resolved while busy', 0)); f.append(wake('current while busy')); await watch.attach(f.cwd);
    await ops.rule({ cwd: f.cwd, as: parent, nodes: ['a'], text: 'resolve held wake' });
    busy = false; await watch.flush(); assert.equal(got.length, 0, 'first delivery fails');
    f.append(wake('live after hold', 10000)); await watch.flush();
    assert.equal(got.length, 1); assert.match(got[0]!, /current while busy/); assert.match(got[0]!, /live after hold/); assert.doesNotMatch(got[0]!, /resolved while busy/);
  } finally { watch.stopAll(); await f.close(); }
});

test('PD1 parked and node wakes share one state load at attach', async t => {
  const f = await fixture(); f.held(); const got: string[] = [];
  const watch = new DriveWatch(s => got.push(s), 0, { busy: () => false, revalidate: cwd => revalidator({ cwd }) });
  try {
    f.append({ do: 'notify', scope: 'repo', node: 'trunk', once: 'trunk-red\u0000obsolete', facts: 0, text: 'obsolete parked notice' });
    f.append(wake('current node wake'));
    const loads = t.mock.method(Ledger, 'open');
    await watch.attach(f.cwd);
    assert.equal(loads.mock.callCount(), 1, 'park refresh and live revalidation reuse the same load');
    assert.equal(got.length, 1); assert.match(got[0]!, /current node wake/); assert.doesNotMatch(got[0]!, /obsolete parked notice/);
  } finally { watch.stopAll(); await f.close(); }
});

test('PD2 CLI start/detach omit follower information for an already exited driver', { timeout: 30_000 }, async () => {
  // Module mocks select the exited return path deterministically, without racing an idle child against start's poll.
  const script = `import { mock } from 'node:test';
    const opsURL = ${JSON.stringify(new URL('../src/ops.ts', import.meta.url).href)}, bgURL = ${JSON.stringify(new URL('../src/drive-bg.ts', import.meta.url).href)};
    const ops = await import(opsURL), bg = await import(bgURL);
    const driver = {pid:123,repo:'/fixture',log:'/fixture/log',session:'session-123',exited:{event:'exit',reason:'idle',code:0,at:new Date().toISOString()}};
    mock.module(opsURL,{namedExports:{...ops,start:async()=>({initialized:false,updated:false,warnings:[],plan:'plan.json',driver})}});
    mock.module(bgURL,{namedExports:{...bg,driveStart:async()=>driver}});
    const {main} = await import(${JSON.stringify(new URL('../src/cli.ts', import.meta.url).href)});
    for (const args of [['start'],['drive','--detach'],['start','--json']]) {
      const lines=[]; const code=await main(args,{log:x=>lines.push(x),error:x=>{throw new Error(x)}});
      console.log(JSON.stringify({args,code,output:lines.join('\\n')}));
    }`;
  const out = await promisify(execFile)(process.execPath, ['--experimental-test-module-mocks', '--input-type=module', '-e', script], { timeout: 25_000 });
  const rows = out.stdout.trim().split('\n').map(l => JSON.parse(l));
  for (const r of rows) assert.equal(r.code, 0);
  for (const r of rows.slice(0, 2)) { assert.match(r.output, /idle/); assert.doesNotMatch(r.output, /followed by|no pi session follows/); }
  assert.equal(JSON.parse(rows[2].output).followedBy, null);
});

test('PD3 timeout resumes before unreported merges, including stale wakes and UTF-8 offsets', async () => {
  const f = await fixture(); f.held();
  try {
    f.append({ do: 'launch', node: 'quiet', outcome: 'applied' });
    const first = statSync(f.log).size;
    f.append({ do: 'merge', node: 'merged-界', outcome: 'merged' }); f.append(wake('resolved', 0));
    await ops.rule({ cwd: f.cwd, as: parent, nodes: ['a'], text: 'resolve' });
    const timed = await watchDriver({ cwd: f.cwd, after: '0', timeout: 0 });
    assert.equal(timed.exit, 5); assert.equal(timed.next, `${first}:${statSync(f.log).ino}`, 'pending Done lines remain behind the resume cursor');
    f.append(wake('next wake'));
    const next = await watchDriver({ cwd: f.cwd, after: timed.next, timeout: 0 });
    assert.equal(next.exit, 0); assert.match(next.lines.join('\n'), /Done: merged-界/); assert.match(next.lines.join('\n'), /next wake/);
    assert.doesNotMatch(next.lines.join('\n'), /Needs you:.*resolved/);
    assert.equal(next.next, `${statSync(f.log).size}:${statSync(f.log).ino}`);
    assert.equal((await watchDriver({ cwd: f.cwd, after: next.next, timeout: 0 })).exit, 5);
  } finally { await f.close(); }
});

test('PD3 stale-only timeout advances; watch without a cursor still starts at the end', async () => {
  const f = await fixture(); f.held();
  try {
    f.append(wake('stale', 0)); await ops.rule({ cwd: f.cwd, as: parent, nodes: ['a'], text: 'resolve' });
    const stale = await watchDriver({ cwd: f.cwd, after: '0', timeout: 0 });
    assert.equal(stale.exit, 5); assert.equal(stale.next, `${statSync(f.log).size}:${statSync(f.log).ino}`);
    f.append(wake('current'));
    const tail = await watchDriver({ cwd: f.cwd, timeout: 0 }); assert.equal(tail.exit, 5); assert.doesNotMatch(tail.lines.join('\n'), /current/);
  } finally { await f.close(); }
});

class SealedDsa extends Dsa {
  override async describe(rid: string) { return { rid, state: 'sealed' as const, status: 'ok' as const }; }
  override async inspect(rid: string) { return { view: await this.describe(rid) }; }
}
async function batchFixture() {
  const f = await fixture(true);
  for (const node of ['a', 'b', 'c']) {
    const slot = await ops.dispatch({ cwd: f.cwd, node, as: parent });
    const s = (await ops.readState(f)).state;
    await ops.launch({ cwd: f.cwd, as: parent, ...writerLaunch(s, node, projectId(s)) });
    await commitAt(slot.worktree, { [`${node}.txt`]: node });
    await ops.submit({ cwd: slot.worktree, node, as: { role: 'writer', id: `${node}#1` } });
    assert.equal((await ops.attest({ cwd: f.cwd, node })).accepted, true);
  }
  const out: string[] = [], driver = new Driver({ cwd: f.cwd, dsa: new SealedDsa(), log: l => out.push(l) });
  return { ...f, driver, out, file: join(f.dir, 'drive/batch-isolated.json') };
}

test('PD4 isolation save failure keeps the refusal and in-memory single-merge scheduling', { timeout: 120_000 }, async () => {
  const f = await batchFixture();
  try {
    mkdirSync(f.file); // rename(temp, directory) fails portably, even as root.
    await f.driver.pass(); await f.driver.settle();
    assert.match(f.out.join('\n'), /batch merge refused .*a, b merge alone until merged or resubmitted \(isolation not saved: EISDIR\)/);
    rmSync(f.file, { recursive: true });
    const at = f.out.length; await f.driver.pass(); await f.driver.settle();
    assert.match(f.out.slice(at).join('\n'), /^merge a: started$/m);
    assert.doesNotMatch(f.out.slice(at).join('\n'), /batch of/);
  } finally { await f.driver.settle(); await f.close(); }
});

test('PD5 status preview reads candidate-scoped isolation without changing the ledger or pure view', { timeout: 120_000 }, async () => {
  const f = await batchFixture();
  try {
    const state = (await ops.readState(f)).state, before = await f.ledger.read();
    assert.deepEqual((await ops.status(f)).mergeBatch, ['a', 'b']);
    writeFileSync(f.file, JSON.stringify({ a: state.nodes.a!.candidate!.commit, b: state.nodes.b!.candidate!.commit }));
    assert.equal((await ops.status(f)).mergeBatch, undefined, 'one non-isolated member cannot form a batch');
    writeFileSync(f.file, JSON.stringify({ a: state.nodes.a!.candidate!.commit, b: 'old-candidate' }));
    assert.deepEqual((await ops.status(f)).mergeBatch, ['b', 'c'], 'changed candidates rejoin the preview');
    writeFileSync(f.file, '{torn'); assert.deepEqual((await ops.status(f)).mergeBatch, ['a', 'b']);
    assert.deepEqual(await f.ledger.read(), before);
  } finally { await f.driver.settle(); await f.close(); }
});

test('PD6 SPEC describes watch ledger and driver lock boundaries', () => {
  const spec = readFileSync(new URL('../docs/SPEC.md', import.meta.url), 'utf8');
  assert.equal(spec.includes('reads the drive log; writes no ledger entries and takes no driver lock'), true);
});
