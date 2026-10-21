import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, cp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { OwedError } from '../src/errors.ts';
import { renderStatus, renderWhy, renderReport, renderBrief } from '../src/views.ts';
import * as views from '../src/views.ts';
import { revalidator } from '../src/drive-bg.ts';
import { repo } from './helpers/repo.ts';
import { commitAt } from './helpers/surface.ts';

// Dynamic import keeps the 0.11 red run behavioral: the real extension delay assertion runs too.
const transport = await import('../src/ext-worker.ts').catch(() => undefined);
const parent = { role: 'parent' as const, id: 'pi' };
function harness(cwd: string, extension = owed) {
  const tools = new Map<string, ToolDefinition>(), handlers = new Map<string, any>();
  const messages: any[] = [], prompts: string[] = [];
  let confirm: (message: string, options: any) => Promise<boolean> = async () => true;
  let deliver: (m: unknown) => void = m => { messages.push(m); };
  const ctx = { cwd, hasUI: true, isIdle: () => true, sessionManager: { getSessionId: () => 'worker-session' }, ui: {
    confirm: async (_title: string, message: string, options: any) => { prompts.push(message); return confirm(message, options); }, notify() {},
  } } as unknown as Parameters<ToolDefinition['execute']>[4];
  extension({ registerTool: (t: ToolDefinition) => tools.set(t.name, t), registerCommand() {}, on: (n: string, h: unknown) => handlers.set(n, h), sendMessage: (m: unknown) => deliver(m) } as unknown as ExtensionAPI);
  return { tools, messages, prompts, setDeliver: (fn: typeof deliver) => { deliver = fn; }, setConfirm: (fn: typeof confirm) => { confirm = fn; },
    call: (name: string, args: Record<string, unknown> = {}, signal?: AbortSignal) => tools.get(`owed_${name}`)!.execute('test', args, signal, undefined, ctx),
    emit: (name: string) => handlers.get(name)?.({}, ctx),
  };
}
const text = (r: { content: unknown }) => (r.content as { text: string }[]).map(c => c.text).join('\n');
async function fixture(count = 2, entries = 0) {
  const r = await repo();
  const plan = JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [], nodes: Array.from({ length: count }, (_, i) => ({ id: `n${i}`, writes: [`n${i}.txt`], checks: [], review: { count: 0, min_rank: 1 }, ...(i === 0 ? { approve: 'owner' } : {}) })) });
  await r.put('plan.json', plan); await r.commit();
  await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'pi' }, channel: 'delegated', plan });
  if (entries) {
    const ledger = await Ledger.open(r.cwd);
    await ledger.withLock(() => ledger.append(Array.from({ length: entries }, (_, i) => ({ kind: 'note' as const, by: 'parent:pi' as const, text: `progress ${i}` }))));
  }
  return r;
}
async function drift<T>(run: () => Promise<T>): Promise<{ value: T; max: number }> {
  let last = performance.now(), max = 0;
  const timer = setInterval(() => { const now = performance.now(); max = Math.max(max, now - last - 5); last = now; }, 5);
  try {
    await new Promise(r => setTimeout(r, 15));
    const value = await run();
    await new Promise(r => setTimeout(r, 15));
    return { value, max };
  } finally { clearInterval(timer); }
}

test('G2 real extension: status, why, dispatch and drive-watch revalidation keep main-thread delay <=100 ms on 2201 entries', { timeout: 180_000 }, async t => {
  const r = await fixture(200, 2200), h = harness(r.cwd);
  try {
    await h.call('status'); // worker startup is eager; measure the operational path.
    for (const [name, args] of [['status', {}], ['why', { node: 'n0' }], ['dispatch', { node: 'n0' }]] as const) {
      const got = await drift(() => h.call(name, args));
      assert.notEqual(got.value.isError, true, text(got.value));
      t.diagnostic(`worker ${name}: max delay ${got.max.toFixed(1)} ms`);
      assert.ok(got.max <= 100, `${name} blocked main thread ${got.max.toFixed(1)} ms`);
    }
    const dir = process.env.OWED_DIR!, log = join(dir, 'drive/log.jsonl');
    await mkdir(join(dir, 'drive'), { recursive: true }); await writeFile(log, '');
    await writeFile(join(dir, 'drive.lock'), JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString(), token: 'fixture', session: 'worker-session' }));
    await h.emit('session_start');
    await appendFile(log, `${JSON.stringify({ do: 'halt', node: 'n0', outcome: 'halted', attempt: 1, needs: 'human', facts: 99999, detail: 'still current' })}\n`);
    const watch = await drift(() => h.emit('agent_settled'));
    assert.equal(h.messages.length, 1, 'the real watcher revalidated and delivered the halt');
    t.diagnostic(`worker watch: max delay ${watch.max.toFixed(1)} ms`);
    assert.ok(watch.max <= 100, `watch blocked main thread ${watch.max.toFixed(1)} ms`);
    // Same operations without the transport, on the same ledger and plan.
    const baseline = [
      ['status', () => ops.status({ cwd: r.cwd })],
      ['why', () => ops.why({ cwd: r.cwd, node: 'n0' })],
      ['dispatch', () => ops.dispatch({ cwd: r.cwd, node: 'n1', as: parent })],
      ['watch', () => revalidator({ cwd: r.cwd })([{ node: 'n0', facts: 99999 }])],
    ] as const;
    const delays: number[] = [], ledgerDir = process.env.OWED_DIR!;
    await h.emit('session_shutdown');
    for (const [name, fn] of baseline) {
      // Independent cold ledger directories keep this positive control meaningful
      // after G1 adds snapshots and per-directory in-process replay caches.
      const cold = join(r.root, `cold-${name}`);
      await cp(ledgerDir, cold, { recursive: true, filter: path => !path.includes('/snapshot') });
      process.env.OWED_DIR = cold;
      try { const b = await drift(fn as () => Promise<unknown>); delays.push(b.max); t.diagnostic(`in-process ${name}: max delay ${b.max.toFixed(1)} ms`); }
      finally { process.env.OWED_DIR = ledgerDir; }
    }
    assert.ok(Math.max(...delays) > 100, `positive control must block: ${delays}`);
  } finally { await h.emit('session_shutdown'); await r.cleanup(); }
});

test('G2 text equals the in-process views; compact details retain action metadata and worker errors retain code and text', async () => {
  const r = await fixture(), h = harness(r.cwd);
  try {
    for (const [name, fn, render, args] of [
      ['status', ops.status, renderStatus, {}], ['why', ops.why, renderWhy, { node: 'n0' }],
      ['report', ops.report, renderReport, {}], ['brief', ops.brief, renderBrief, {}],
    ] as const) {
      const actual = await h.call(name, args);
      const expected = await (fn as any)({ cwd: r.cwd, ...args, ...(name === 'brief' ? { now: Date.parse((actual.details as { now: string }).now) } : {}) });
      const details = actual.details as Record<string, any>;
      assert.equal(text(actual), (render as any)(expected));
      assert.ok(Buffer.byteLength(JSON.stringify(details)) <= 8192);
      if (name === 'status') { assert.equal(details.nodes, undefined); assert.equal(details.nodeCount, 2); assert.deepEqual(details.ready, expected.ready); }
      if (name === 'why') { assert.equal(details.node, expected.node); assert.equal(details.phase, expected.phase); assert.equal(details.accepted, expected.accepted); assert.ok(details.items.every((i: object) => !('observations' in i))); }
      if (name === 'report') assert.equal(details.mergesCount, expected.merges.length);
      if (name === 'brief') assert.deepEqual(details.totals, expected.totals);
    }
    const expected = await ops.why({ cwd: r.cwd, node: 'absent' }).catch(e => e as OwedError);
    assert.ok(expected instanceof OwedError);
    const error = await h.call('why', { node: 'absent' });
    assert.equal(error.isError, true); assert.deepEqual(error.details, { code: expected.code, reason: expected.message });
    assert.equal(text(error), `Refused: ${expected.message}`);
    const d = await h.call('dispatch', { node: 'n1' }), value = d.details as { worktree: string; subagents: object; packet?: string };
    assert.deepEqual(value.subagents, { agent: 'worker', cwd: value.worktree, isolation: 'none' });
    assert.equal(value.packet, undefined, 'packet is text only');
    assert.ok(text(d).includes(`\n\nsubagents: ${JSON.stringify({ ...value.subagents, task: '<the complete packet above>' })}\n`));
    assert.ok(text(d).endsWith(views.renderStatusBrief(await ops.status({ cwd: r.cwd }))));
  } finally { await h.emit('session_shutdown'); await r.cleanup(); }
});

test('G2 owner preview/dialog/commit keeps the candidate pin across RPC', async () => {
  const prior = process.env.OWED_CONFIRM; process.env.OWED_CONFIRM = 'owner';
  const r = await fixture(), h = harness(r.cwd);
  try {
    const d = await ops.dispatch({ cwd: r.cwd, node: 'n0', as: parent });
    await commitAt(d.worktree, { 'n0.txt': 'one' });
    const first = await ops.submit({ cwd: d.worktree, node: 'n0', as: { role: 'writer', id: 'n0#1' } });
    assert.equal(first.kind, 'submit');
    if (first.kind !== 'submit') assert.fail('submit expected');
    h.setConfirm(async message => {
      assert.match(message, new RegExp(first.facts.commit));
      await commitAt(d.worktree, { 'n0.txt': 'two' });
      await ops.submit({ cwd: d.worktree, node: 'n0', as: { role: 'writer', id: 'n0#1' } });
      return true;
    });
    const result = await h.call('approve', { node: 'n0', note: 'reviewed' });
    assert.equal(result.isError, true); assert.match(text(result), /candidate changed since confirmation/);
    assert.equal((await (await Ledger.open(r.cwd)).read()).filter(e => e.kind === 'review').length, 0);
  } finally { await h.emit('session_shutdown'); await r.cleanup(); if (prior === undefined) delete process.env.OWED_CONFIRM; else process.env.OWED_CONFIRM = prior; }
});

test('G2 abort reaches the worker and dismisses a pending owner dialog without recording', async () => {
  const prior = process.env.OWED_CONFIRM; process.env.OWED_CONFIRM = 'owner';
  const r = await fixture(), h = harness(r.cwd), ac = new AbortController();
  try {
    let dismissed = false;
    h.setConfirm(async (_message, options) => { options.signal.addEventListener('abort', () => { dismissed = true; }); ac.abort(); return new Promise(() => {}); });
    const before = (await (await Ledger.open(r.cwd)).read()).length;
    const result = await h.call('rule', { text: 'cancel me', nodes: '*', as: 'owner:pi' }, ac.signal);
    assert.equal(result.isError, true); assert.equal((result.details as { code: string }).code, 'aborted');
    assert.equal(dismissed, true); assert.equal((await (await Ledger.open(r.cwd)).read()).length, before);
  } finally { await h.emit('session_shutdown'); await r.cleanup(); if (prior === undefined) delete process.env.OWED_CONFIRM; else process.env.OWED_CONFIRM = prior; }
});

test('G2 eager shared worker crash fails all pending calls; next call restarts it', async () => {
  assert.ok(transport, 'worker transport exists');
  const r = await fixture(), h = harness(r.cwd);
  try {
    const rpc = transport.toolWorker(), original = rpc.worker;
    assert.ok(original, 'worker exists before the first call');
    await h.call('status');
    const ctx = { cwd: r.cwd, hasUI: false, idle: true };
    const one = rpc.call('tool', [1001, 'owed_status', 'a', {}, ctx]);
    const two = rpc.call('tool', [1001, 'owed_why', 'b', { node: 'n0' }, ctx]);
    const outcomes = Promise.allSettled([one, two]);
    await original.terminate();
    for (const out of await outcomes) { assert.equal(out.status, 'rejected'); if (out.status === 'rejected') assert.match(out.reason.message, /worker (exited|crashed)/); }
    const again = await h.call('status'); assert.notEqual(again.isError, true, text(again));
    assert.notEqual(rpc.worker, original);
  } finally { await h.emit('session_shutdown'); await r.cleanup(); }
});

test('G2 synthetic OwedError version appends the restart line even with matching installed version', () => {
  assert.ok(transport, 'worker transport exists');
  const error = new OwedError('ledger entry needs newer owed', 'version' as any);
  const result = transport.versionNotice({ content: [{ type: 'text', text: `Refused: ${error.message}` }], details: { code: error.code, reason: error.message } });
  assert.equal(text(result), `Refused: ${error.message}\n${transport.restartLine()}`);
  assert.deepEqual(result.details, { code: 'version', reason: error.message });
});

test('G2 watcher retains rejected deliveries and revalidates them before retry', async () => {
  const r = await fixture(), h = harness(r.cwd);
  try {
    const dir = process.env.OWED_DIR!, log = join(dir, 'drive/log.jsonl');
    await mkdir(join(dir, 'drive'), { recursive: true }); await writeFile(log, '');
    await writeFile(join(dir, 'drive.lock'), JSON.stringify({ pid: process.pid, host: hostname(), at: new Date().toISOString(), token: 'fixture', session: 'worker-session' }));
    await h.emit('session_start');
    let attempted = 0;
    h.setDeliver(() => { attempted++; throw new Error('pi unavailable'); });
    await appendFile(log, `${JSON.stringify({ do: 'halt', node: 'n0', outcome: 'halted', attempt: 1, needs: 'human', facts: 0, detail: 'old fact' })}\n`);
    await h.emit('agent_settled'); assert.equal(attempted, 1);
    await ops.rule({ cwd: r.cwd, as: parent, nodes: ['n0'], text: 'resolved' });
    h.setDeliver(m => { h.messages.push(m); });
    await h.emit('agent_settled'); assert.equal(h.messages.length, 0, 'resolved wake is dropped after rejected delivery');
    await appendFile(log, `${JSON.stringify({ do: 'halt', node: 'n0', outcome: 'halted', attempt: 1, needs: 'human', facts: 99999, detail: 'new fact' })}\n`);
    await h.emit('agent_settled'); assert.equal(h.messages.length, 1); assert.match(h.messages[0].content, /new fact/);
  } finally { await h.emit('session_shutdown'); await r.cleanup(); }
});

test('G2 index.js loads through pi jiti and executes its native worker', { timeout: 30_000 }, async () => {
  const r = await fixture();
  const entry = fileURLToPath(new URL('../index.js', import.meta.url));
  const loaderURL = new URL('./core/extensions/loader.js', import.meta.resolve('@earendil-works/pi-coding-agent'));
  try {
    // A fresh process cannot accidentally reuse this test file's source worker
    // when index.js selects dist/ in the packaging check.
    const script = `
      import assert from 'node:assert/strict';
      const { loadExtensions } = await import(process.argv[1]);
      const loaded = await loadExtensions([process.argv[2]], process.argv[3]);
      assert.deepEqual(loaded.errors, []);
      const ext = loaded.extensions[0], tool = ext.tools.get('owed_status').definition;
      const ctx = { cwd: process.argv[3], hasUI: false, isIdle: () => true, ui: { notify() {} } };
      const result = await tool.execute('test', {}, undefined, undefined, ctx);
      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.match(result.content[0].text, /owed:.*trunk main/);
      for (const handler of ext.handlers.get('session_shutdown') ?? []) await handler({}, ctx);
      console.log('jiti index + native worker OK');
    `;
    const result = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script, loaderURL.href, entry, r.cwd], { timeout: 25_000 });
    assert.match(result.stdout, /jiti index \+ native worker OK/);
  } finally { await r.cleanup(); }
});

test('G2 git-install native worker needs no pi peers; installed skew warns and refuses replacement', { timeout: 30_000 }, async () => {
  const r = await fixture();
  const copy = join(r.root, 'package'); await mkdir(copy);
  try {
    await cp(new URL('../src', import.meta.url), join(copy, 'src'), { recursive: true });
    const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
    await writeFile(join(copy, 'package.json'), JSON.stringify(pkg));
    await mkdir(join(copy, 'node_modules'));
    await symlink(fileURLToPath(new URL('../node_modules/yaml', import.meta.url)), join(copy, 'node_modules/yaml'));
    // No pi peer symlinks: the worker must load the git sources without the host's module mapping.
    const mod = await import(join(copy, 'src/ext-worker.ts')) as NonNullable<typeof transport>;
    const rpc = new mod.ToolWorker();
    try {
      const ctx = { cwd: r.cwd, hasUI: false, idle: true };
      const call = () => rpc.call('tool', [1, 'owed_status', 't', {}, ctx]);
      assert.notEqual((await call()).isError, true);
      await writeFile(join(copy, 'package.json'), JSON.stringify({ ...pkg, version: '99.0.0' }));
      const result = mod.versionNotice(await call());
      assert.ok(text(result).endsWith(`owed 99.0.0 is installed but this pi session loaded ${pkg.version}: restart pi to use it.`));
      await rpc.worker!.terminate();
      await assert.rejects(call, /owed 99.0.0 is installed.*restart pi to use it/);
      assert.equal(rpc.worker, undefined, 'new-version code was never started');
    } finally { await rpc.worker?.terminate(); }
  } finally { await rm(copy, { recursive: true, force: true }); await r.cleanup(); }
});
