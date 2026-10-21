// SN1-SN5: real extension/native-worker behavior; all imports also exist on the contract baseline.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker, SHARE_ENV } from 'node:worker_threads';
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';
import { loadedVersion, toolWorker } from '../src/ext-worker.ts';
import { procStart } from '../src/drive-run.ts';
import { registerDriver } from '../src/registry.ts';
import { DriveWatch } from '../src/drive-bg.ts';
import { watchDriver } from '../src/watch.ts';
import * as ops from '../src/ops.ts';
import { repo } from './helpers/repo.ts';
import { identity } from './helpers/surface.ts';

const OWNER = 'sn-owner', STRANGER = 'sn-stranger';
const wake = (text: string, facts = 99999) => ({ do: 'notify', node: 'a', facts, text });
async function fixture(later = true) {
  const saved = { ...process.env }, r = await repo();
  delete process.env.OWED_DIR;
  for (const key of ['DSA_SESSION', 'PI_SESSION_ID', 'DSA_EXEC', 'DSA_CALL', 'OWED_CONFIRM']) delete process.env[key];
  process.env.XDG_STATE_HOME = join(r.root, 'state');
  process.env.OWED_DSA = fileURLToPath(new URL('./fixtures/fake-dsa.mjs', import.meta.url));
  process.env.FAKE_DSA_DIR = join(r.root, 'dsa');
  Object.assign(process.env, identity);
  const plan = JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [], drive: { min_free_mb: 0, watch_idle_min: 1 }, nodes: [{ id: 'a', later, writes: ['a.txt'], checks: [], review: { count: 0, min_rank: 1 } }] });
  await r.put('plan.json', plan); await r.commit();
  await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'test' }, channel: 'delegated', plan, path: 'plan.json' });
  const dir = join(r.cwd, '.git/owed'), log = join(dir, 'drive/log.jsonl'), lock = join(dir, 'drive.lock');
  mkdirSync(join(dir, 'drive'), { recursive: true }); writeFileSync(log, '');
  const owner = { pid: process.pid, start: procStart(process.pid), host: hostname(), at: new Date().toISOString(), token: 'sn-fixture', session: OWNER };
  return { ...r, dir, log, lock, owner, plan,
    held: (extra: object = {}) => writeFileSync(lock, JSON.stringify({ ...owner, ...extra })),
    append: (line: unknown) => appendFileSync(log, `${JSON.stringify(line)}\n`),
    async close() { await r.cleanup(); for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved); },
  };
}
function harness(cwd: string, session: string | undefined = OWNER) {
  const tools = new Map<string, ToolDefinition>(), events = new Map<string, any>(), messages: { content: string; customType: string }[] = [];
  const state: { session?: string; idle: boolean; fail: boolean } = { session, idle: true, fail: false };
  if (arguments.length > 1 && arguments[1] === undefined) state.session = undefined;
  const ctx = { cwd, hasUI: false, isIdle: () => state.idle, sessionManager: { getSessionId: () => state.session }, ui: { notify() {} } } as unknown as Parameters<ToolDefinition['execute']>[4];
  owed({ registerTool: (t: ToolDefinition) => tools.set(t.name, t), registerCommand() {}, on: (name: string, fn: unknown) => events.set(name, fn), sendMessage: (m: typeof messages[number]) => { if (state.fail) throw new Error('delivery rejected'); messages.push(m); } } as unknown as ExtensionAPI);
  return { state, messages, ctx, emit: (name: string) => events.get(name)?.({}, ctx), call: (name: string, p: object = {}) => tools.get(`owed_${name}`)!.execute('sn', p, undefined, undefined, ctx) };
}

// This assertion fails with ERR_ASSERTION on 7537f144, not an import or fixture failure.
test('SN1 same cwd owner wakes, stranger stays quiet through startup, reads, refusals and driver reuse', { timeout: 30_000 }, async () => {
  const f = await fixture(); f.held(); f.append(wake('owned replay'));
  const own = harness(f.cwd), stranger = harness(f.cwd, STRANGER);
  try {
    await own.emit('session_start'); await stranger.emit('session_start');
    assert.equal(stranger.messages.length, 0, 'opening another pi in the same cwd must not replay the owner log');
    assert.match(own.messages[0]?.content ?? '', /owned replay/);
    for (const [name, args] of [['status', {}], ['why', { node: 'a' }], ['why', { node: 'missing' }], ['status', { as: 'parent:drive' }], ['start', {}]] as const) {
      const r = await stranger.call(name, args);
      if (name === 'start') assert.equal((r.details as ops.StartResult).driver.session, OWNER, 'reuse retains original ownership');
      f.append(wake(`after ${name} ${JSON.stringify(args)}`));
      await own.emit('agent_settled'); await stranger.emit('agent_settled');
      assert.equal(stranger.messages.length, 0, `${name} must not subscribe a stranger`);
    }
    assert.equal(own.messages.length, 6);
  } finally { await own.emit('session_shutdown'); await stranger.emit('session_shutdown'); await f.close(); }
});

test('SN1 resumed owner and cross-repository discovery preserve independent replay/dedup cursors', async () => {
  const f = await fixture(); f.held(); const unregister = registerDriver(f.cwd, f.owner);
  f.append(wake('resume pending'));
  const first = harness(f.cwd), resumed = harness(f.root), stranger = harness(f.root, STRANGER);
  try {
    await first.emit('session_start'); await first.emit('session_shutdown');
    await resumed.emit('session_start'); await stranger.emit('session_start');
    assert.match(resumed.messages[0]?.content ?? '', /resume pending/, 'owner discovers a repo outside cwd');
    f.append(wake('resume pending')); await resumed.emit('agent_settled');
    assert.equal(resumed.messages.length, 1, 'same follower dedups, previous owner follower does not steal its cursor');
    assert.equal(stranger.messages.length, 0);
  } finally { unregister(); for (const h of [first, resumed, stranger]) await h.emit('session_shutdown'); await f.close(); }
});

test('SN1 missing, invalid or unregistered ownership never broadcasts; exact legacy PI registration is accepted', async () => {
  const f = await fixture();
  try {
    for (const session of [undefined, 'not a session', OWNER]) {
      f.held({ session: undefined }); f.append(wake('unknown owner'));
      const h = harness(f.cwd, session);
      try { await h.emit('session_start'); await h.call('status'); await h.emit('agent_settled'); assert.equal(h.messages.length, 0); }
      finally { await h.emit('session_shutdown'); }
    }
    const unregister = registerDriver(f.cwd, f.owner), h = harness(f.cwd);
    try { await h.emit('session_start'); assert.match(h.messages[0]?.content ?? '', /unknown owner/); }
    finally { unregister(); await h.emit('session_shutdown'); }
    f.held({ session: STRANGER }); const wrong = registerDriver(f.cwd, f.owner), stale = harness(f.cwd);
    try { await stale.emit('session_start'); assert.equal(stale.messages.length, 0, 'registry cannot override a different lock owner'); }
    finally { wrong(); await stale.emit('session_shutdown'); }
  } finally { await f.close(); }
});

test('SN2 fresh tool starts carry actual context identity across the worker without mutating shared env', { timeout: 30_000 }, async () => {
  const f = await fixture(); process.env.DSA_SESSION = 'env-first'; process.env.PI_SESSION_ID = 'env-pi';
  try {
    for (const name of ['start', 'drive']) {
      const h = harness(f.cwd);
      try {
        const r = await h.call(name, name === 'drive' ? { action: 'start', stay: true } : { stay: true });
        assert.notEqual(r.isError, true, JSON.stringify(r));
        const driver = name === 'start' ? (r.details as ops.StartResult).driver : r.details as { session?: string; pid: number };
        assert.equal(driver.session, OWNER);
        assert.equal(JSON.parse(readFileSync(f.lock, 'utf8')).session, OWNER);
        assert.match(readFileSync(`/proc/${driver.pid}/environ`, 'utf8'), new RegExp(`DSA_SESSION=${OWNER}\\x00`));
        assert.equal(process.env.DSA_SESSION, 'env-first', 'SHARE_ENV was not mutated');
        assert.equal(process.env.PI_SESSION_ID, 'env-pi');
        const stranger = harness(f.cwd, STRANGER);
        try { assert.equal(((await stranger.call('start')).details as ops.StartResult).driver.session, OWNER); await stranger.emit('agent_settled'); assert.equal(stranger.messages.length, 0); }
        finally { await stranger.emit('session_shutdown'); }
      } finally { await h.call('drive', { action: 'stop' }); await h.emit('agent_settled'); await h.emit('session_shutdown'); }
    }
  } finally { await f.close(); }
});

test('SN2 validated fallback and DSA child exclusion remain effective at the real worker seam', { timeout: 30_000 }, async () => {
  const f = await fixture(); f.held();
  try {
    for (const env of [{ DSA_SESSION: OWNER, PI_SESSION_ID: STRANGER }, { DSA_SESSION: 'invalid value', PI_SESSION_ID: OWNER }]) {
      Object.assign(process.env, env); const h = harness(f.cwd, undefined);
      try { await h.emit('session_start'); f.append(wake(`fallback ${env.DSA_SESSION}`)); await h.emit('agent_settled'); assert.ok(h.messages.length); }
      finally { await h.emit('session_shutdown'); }
    }
    for (const key of ['DSA_CALL', 'DSA_EXEC']) {
      process.env[key] = 'child'; const h = harness(f.cwd);
      try { await h.emit('session_start'); await h.call('status'); await h.emit('agent_settled'); assert.equal(h.messages.length, 0); }
      finally { await h.emit('session_shutdown'); delete process.env[key]; }
    }
  } finally { await f.close(); }
});

test('SN3 busy held wakes are revalidated, rejected deliveries retry, identity switches discard old batches', async () => {
  const f = await fixture(); f.held(); const h = harness(f.cwd);
  try {
    await h.emit('session_start'); await h.emit('agent_start'); f.append(wake('resolved before idle', 0));
    await ops.rule({ cwd: f.cwd, as: { role: 'parent', id: 'test' }, nodes: ['a'], text: 'resolved' });
    await h.emit('agent_settled'); assert.equal(h.messages.length, 0);
    h.state.fail = true; f.append(wake('retry wake')); await h.emit('agent_settled');
    h.state.fail = false; await h.emit('agent_settled'); assert.match(h.messages.at(-1)?.content ?? '', /retry wake/);
    await h.emit('agent_start'); h.state.idle = false; f.append(wake('old session queued'));
    h.state.session = STRANGER; h.state.idle = true; await h.emit('agent_settled');
    assert.equal(h.messages.length, 1); assert.doesNotMatch(h.messages.map(m => m.content).join('\n'), /old session queued/);
    h.state.session = OWNER; await h.emit('session_start'); assert.match(h.messages.at(-1)?.content ?? '', /old session queued/, 'resuming owner can replay its own wake');
  } finally { await h.emit('session_shutdown'); await f.close(); }
});

test('SN3 replacement ownership cannot transfer follower; owned terminal survives foreign rotation', async () => {
  const f = await fixture(); f.held(); const own = harness(f.cwd), stranger = harness(f.cwd, STRANGER);
  try {
    await own.emit('session_start'); await own.emit('agent_start');
    f.append({ event: 'exit', reason: 'stopped', code: 0, at: new Date().toISOString(), driver: f.owner });
    renameSync(f.log, `${f.log}.1`); writeFileSync(f.log, `${JSON.stringify(wake('foreign replacement wake'))}\n`);
    f.held({ session: STRANGER, token: 'replacement', at: new Date(Date.now() + 1000).toISOString() });
    await stranger.emit('session_start'); await own.emit('agent_settled');
    assert.match(own.messages[0]?.content ?? '', /Driver stopped: stopped/);
    assert.doesNotMatch(own.messages.map(m => m.content).join('\n'), /foreign replacement wake/);
    assert.match(stranger.messages[0]?.content ?? '', /foreign replacement wake/);
    f.append(wake('later foreign wake')); await own.call('status'); await own.emit('agent_settled');
    assert.equal(own.messages.length, 1, 'ordinary tool use cannot reattach the foreign replacement');
  } finally { await own.emit('session_shutdown'); await stranger.emit('session_shutdown'); await f.close(); }
});

test('SN3 same-owner replacement preserves busy terminal ride-along and remains attached', async () => {
  const f = await fixture(); f.held(); const own = harness(f.cwd);
  try {
    await own.emit('session_start'); await own.emit('agent_start');
    f.append({ event: 'exit', reason: 'stopped', code: 0, at: new Date().toISOString(), driver: f.owner });
    renameSync(f.log, `${f.log}.1`); writeFileSync(f.log, `${JSON.stringify({ event: 'exit', reason: 'stopped', code: 0, driver: f.owner })}\n${JSON.stringify(wake('same-owner replacement wake'))}\n`);
    f.held({ token: 'replacement', at: new Date(Date.now() + 1000).toISOString() });
    await own.emit('agent_settled');
    assert.match(own.messages[0]?.content ?? '', /same-owner replacement wake/);
    assert.match(own.messages[0]?.content ?? '', /earlier driver/);
    assert.doesNotMatch(own.messages[0]?.content ?? '', /Driver stopped/);
    f.append(wake('replacement still followed', 100000)); await own.emit('agent_settled');
    assert.match(own.messages[1]?.content ?? '', /replacement still followed/);
  } finally { await own.emit('session_shutdown'); await f.close(); }
});

test('SN3 foreign replacement finishing before owner flush never leaks its retired log', async () => {
  const f = await fixture(); f.held(); const own = harness(f.cwd);
  try {
    await own.emit('session_start'); await own.emit('agent_start');
    f.append({ event: 'exit', reason: 'stopped', code: 0, at: new Date().toISOString(), driver: f.owner });
    renameSync(f.log, `${f.log}.1`); writeFileSync(f.log, `${JSON.stringify(wake('foreign already exited'))}\n`); rmSync(f.lock);
    await own.emit('agent_settled');
    assert.match(own.messages[0]?.content ?? '', /Driver stopped: stopped/);
    assert.doesNotMatch(own.messages[0]?.content ?? '', /foreign already exited/);
  } finally { await own.emit('session_shutdown'); await f.close(); }
});

test('SN3 host identity changes while a worker callback is in flight reject the old delivery', async () => {
  const f = await fixture(); f.held(); const own = harness(f.cwd); const rpc = toolWorker();
  const session = (own as unknown as { ctx: { sessionManager: { getSessionId(): string | undefined } } }).ctx;
  let switchOnSend = false;
  const listener = (m: { method?: string }) => { if (m.method === 'message') switchOnSend = true; };
  try {
    await own.emit('session_start');
    const original = session.sessionManager.getSessionId;
    session.sessionManager.getSessionId = () => {
      if (switchOnSend) { own.state.session = STRANGER; switchOnSend = false; }
      return original();
    };
    f.append(wake('in-flight old identity'));
    // The native worker posts callbacks after the host request serialized the old identity.
    rpc.worker!.prependListener('message', listener);
    await own.emit('agent_settled');
    assert.equal(own.messages.length, 0, 'host callback checks the live context identity, not only the last worker event');
  } finally { rpc.worker?.removeListener('message', listener); await own.emit('session_shutdown'); await f.close(); }
});

test('SN3 ownership changes during async revalidation cannot deliver the replacement log', async () => {
  const f = await fixture(); f.held(); let release!: () => void, entered!: () => void;
  const gate = new Promise<void>(r => { release = r; }), ready = new Promise<void>(r => { entered = r; });
  const got: string[] = [];
  const watch = new DriveWatch(s => got.push(s), 0, { busy: () => false, session: () => OWNER, revalidate: () => async checks => { entered(); await gate; return checks.map(() => true); } });
  try {
    await watch.attach(f.cwd); f.append(wake('owned before replacement'));
    const step = watch.flush(); await ready;
    renameSync(f.log, `${f.log}.1`); writeFileSync(f.log, `${JSON.stringify(wake('foreign async wake'))}\n`);
    f.held({ session: STRANGER, at: new Date(Date.now() + 1000).toISOString() }); release(); await step; await watch.flush();
    assert.doesNotMatch(got.join('\n'), /foreign async wake/);
  } finally { release(); watch.stopAll(); await f.close(); }
});

test('SN1 explicit CLI watch is independent of automatic ownership and keeps its cursor', async () => {
  const f = await fixture(); f.held(); f.append(wake('explicit observer'));
  try {
    process.env.DSA_SESSION = STRANGER;
    const first = await watchDriver({ cwd: f.cwd, after: '0', timeout: 0 });
    assert.equal(first.exit, 0); assert.match(first.lines.join('\n'), /explicit observer/);
    assert.equal((await watchDriver({ cwd: f.cwd, after: first.next, timeout: 0 })).exit, 5);
  } finally { await f.close(); }
});

// Test-only clock control in a genuine native worker: no production clock/ownership API is introduced.
test('SN4 real worker idle watch has no startup/status backdoor, keeps owner observation and explicit init', { timeout: 30_000 }, async () => {
  const f = await fixture(false); f.held();
  const url = new URL('../src/ext-worker.ts', import.meta.url).href;
  const worker = new Worker(`const {parentPort}=require('node:worker_threads'); let time=Date.now(); Date.now=()=>time; parentPort.on('message',m=>{if(m.advance) time+=m.advance;}); import(${JSON.stringify(url)});`, { eval: true, env: SHARE_ENV, workerData: { owed: true, version: loadedVersion }, execArgv: [] });
  let next = 0; const pending = new Map<number, (m: any) => void>(), messages: { session: number; args: { customType: string; content: string }[] }[] = [];
  const ready = new Promise<void>((resolve, reject) => { worker.on('error', reject); pending.set(0, () => resolve()); });
  worker.on('message', m => {
    if ('callback' in m) { if (m.method === 'message') { messages.push(m); worker.postMessage({ id: m.callback, method: 'answer', args: [true] }); } return; }
    pending.get(m.id)?.(m); pending.delete(m.id);
  });
  const call = (sid: number, method: string, name: string, sessionId: string, args: object = {}) => new Promise<any>(resolve => {
    const id = ++next; pending.set(id, resolve); const ctx = { cwd: f.cwd, hasUI: false, idle: true, sessionId };
    worker.postMessage({ id, method, args: method === 'tool' ? [sid, name, 'sn-idle', args, ctx] : [sid, name, ctx] });
  });
  try {
    await ready;
    await call(1, 'event', 'session_start', OWNER); await call(2, 'event', 'session_start', STRANGER);
    await call(2, 'tool', 'owed_status', STRANGER); rmSync(f.lock);
    worker.postMessage({ advance: 180_000 });
    await call(2, 'event', 'owed_tick', STRANGER); await call(1, 'event', 'owed_tick', OWNER);
    assert.equal(messages.filter(m => m.session === 2).length, 0, 'stranger cannot claim or deliver an idle period');
    assert.equal(messages.filter(m => m.session === 1 && m.args[0]?.customType === 'owed-idle').length, 1, 'matching owner keeps idle watch after driver exit');
    assert.equal(readFileSync(join(f.dir, 'watch/idle-0'), 'utf8'), '');
    const fresh = join(f.root, 'fresh-ledger'); process.env.OWED_DIR = fresh;
    // Successful explicit init arms only its own observer, even without a driver.
    const init = await call(3, 'tool', 'owed_init', 'init-owner', { plan: 'plan.json' });
    assert.equal(init.error, undefined); assert.notEqual(init.result?.isError, true);
    worker.postMessage({ advance: 180_000 }); await call(3, 'event', 'owed_tick', 'init-owner');
    assert.equal(messages.filter(m => m.session === 3 && m.args[0]?.customType === 'owed-idle').length, 1);
  } finally { await worker.terminate(); await f.close(); }
});
