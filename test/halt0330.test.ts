// HT1-HT5 (0.33.0 q-halt): transient dsa reads and newer writer generations never halt.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ops from '../src/ops.ts';
import { Dsa, DsaError, dsaShortMs, SHORT_MS_DEFAULT, type CommandResult, type RunResult, type SendResult } from '../src/dsa.ts';
import { Driver, DRIVE_PRINCIPAL, acquireDriveLock, stateOf, wakeReport, type ActionReport } from '../src/drive-run.ts';
import { assembleRuntime } from '../src/activity.ts';
import { renderStatus, renderStatusFull, renderWhy, statusView, receipt } from '../src/views.ts';
import { Ledger } from '../src/ledger.ts';
import { runId } from '../src/reducer.ts';
import type { Entry, RunView } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { commitAt } from './helpers/surface.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-dsa.mjs', import.meta.url));
const parent = { role: 'parent' as const, id: 'main' };
const MIN = 60_000;

async function rig() {
  const r = await repo();
  await commitAt(r.cwd, { README: 'x\n' });
  await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'human' }, channel: 'flag', measure: false,
    plan: JSON.stringify({ version: 1, trunk: 'main', lease: false, closure: [], invariants: [], drive: { min_free_mb: 0 }, nodes: [{ id: 'a', writes: ['a/'], checks: [], review: { count: 0, min_rank: 1 } }] }) });
  const d = await ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' });
  const ledger = await Ledger.open(r.cwd);
  const entries = async (): Promise<Entry[]> => ledger.read();
  return { ...r, worktree: d.worktree, dir: ledger.dir, entries };
}
const halts = (es: Entry[]) => es.filter(e => e.kind === 'halt');

/** A dsa whose run/send/request apply; `inspect` and `command` are scripted per test. */
class Scripted extends Dsa {
  inspects = 0;
  view: (rid: string, call: number) => { view: RunView; gen?: number };
  commandRun?: (rid: string) => Promise<CommandResult>;
  constructor(view: (rid: string, call: number) => { view: RunView; gen?: number }) { super({ bin: FAKE }); this.view = view; }
  override async run(rid: string): Promise<RunResult> { return { outcome: 'applied', wid: 'w1', created: true, spec_digest: rid }; }
  override async send(): Promise<SendResult> { return { outcome: 'applied', spec_digest: '' }; }
  override async request(): Promise<{ state: 'applied' }> { return { state: 'applied' }; }
  override async inspect(rid: string): Promise<{ view: RunView; gen?: number }> { return this.view(rid, ++this.inspects); }
  override async commandUnsupported(): Promise<string | undefined> { return undefined; }
  override async command(rid: string): Promise<CommandResult> { return this.commandRun!(rid); }
}
const driverOf = (cwd: string, dsa: Dsa, lines: string[], clock?: () => number) =>
  new Driver({ cwd, dsa, log: l => lines.push(l), session: null, handleSignals: false, ...(clock ? { clock } : {}) });

// ---------- HT1 at the client: retries of a read that timed out or ended by a signal ----------
async function fakeDir() { return mkdtemp(join(tmpdir(), 'owed-ht-fake-')); }
const fakeLog = (dir: string): Record<string, unknown>[] => existsSync(join(dir, 'log.jsonl')) ? readFileSync(join(dir, 'log.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l)) : [];
const describeFaults = (dir: string) => fakeLog(dir).filter(l => l.cmd === 'describe' && l.fault);

test('HT1: a describe that times out, then ends by a signal, then answers is retried (1 s/3 s/9 s pauses) and succeeds', { timeout: 60_000 }, async () => {
  const dir = await fakeDir();
  try {
    const dsa = new Dsa({ bin: FAKE, env: { FAKE_DSA_DIR: dir }, readTimeoutMs: 1000, readPausesMs: [5, 5, 5], retryReads: true });
    const retries: string[] = []; dsa.onReadRetry = (call, n, why) => retries.push(`${n} ${call} ${why}`);
    assert.equal((await dsa.run('ht-r', JSON.stringify({ agent: 'worker', task: 'x' }))).outcome, 'applied');
    await writeFile(join(dir, 'faults'), 'describe hang 20000\ndescribe signal\n');
    const v = await dsa.inspect('ht-r');
    assert.equal(v.view.state, 'running');
    assert.deepEqual(retries, ['1 describe ht-r timed out', '2 describe ht-r ended by signal SIGKILL']);
    assert.equal(describeFaults(dir).length, 2);
    // Defaults: three retries, pauses 1 s, 3 s, 9 s.
    const { READ_PAUSES_MS } = await import('../src/dsa.ts');
    assert.deepEqual(READ_PAUSES_MS, [1000, 3000, 9000]);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('HT1: a describe still failing after three retries is a transient DsaError (timeout and signal alike)', { timeout: 60_000 }, async () => {
  const dir = await fakeDir();
  try {
    const dsa = new Dsa({ bin: FAKE, env: { FAKE_DSA_DIR: dir }, readTimeoutMs: 1000, readPausesMs: [0, 0, 0], retryReads: true });
    let retries = 0; dsa.onReadRetry = () => { retries++; };
    await dsa.run('ht-p', JSON.stringify({ agent: 'worker', task: 'x' }));
    await writeFile(join(dir, 'faults'), 'describe hang 20000\n'.repeat(4));
    await assert.rejects(dsa.inspect('ht-p'), (e: unknown) => e instanceof DsaError && e.transient && /timed out/.test(e.message));
    assert.equal(retries, 3); assert.equal(describeFaults(dir).length, 4);
    await writeFile(join(dir, 'faults'), 'describe signal\n'.repeat(4));
    await assert.rejects(dsa.inspect('ht-p'), (e: unknown) => e instanceof DsaError && e.transient && /ended by signal SIGKILL/.test(e.message));
    assert.equal(retries, 6);
    // A non-zero exit is not a transient read: no retry.
    await assert.rejects(dsa.request('ht-p'), (e: unknown) => e instanceof DsaError && !e.transient);
    assert.equal(retries, 6);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---------- HT2: the read timeout ----------
test('HT2: read timeout default 15000 ms; OWED_DSA_SHORT_MS integer 1000-120000 overrides; other values ignored with one warning', () => {
  assert.equal(SHORT_MS_DEFAULT, 15_000);
  const prior = process.env.OWED_DSA_SHORT_MS; delete process.env.OWED_DSA_SHORT_MS;
  try {
    assert.equal(new Dsa({ bin: '/nonexistent/dsa' }).readTimeoutMs, 15_000);
    assert.equal(new Dsa({ bin: '/nonexistent/dsa', env: { OWED_DSA_SHORT_MS: '3000' } }).readTimeoutMs, 3000);
    assert.equal(new Dsa({ bin: '/nonexistent/dsa', env: { OWED_DSA_SHORT_MS: '3000' }, timeoutMs: 500 }).readTimeoutMs, 3000, 'the variable overrides the client limit for reads');
  } finally { if (prior !== undefined) process.env.OWED_DSA_SHORT_MS = prior; }
  const warnings: string[] = [], warn = (l: string) => warnings.push(l);
  assert.equal(dsaShortMs({ OWED_DSA_SHORT_MS: '1000' }, warn), 1000);
  assert.equal(dsaShortMs({ OWED_DSA_SHORT_MS: '120000' }, warn), 120_000);
  assert.equal(dsaShortMs({}, warn), undefined);
  assert.deepEqual(warnings, []);
  for (const bad of ['999', '120001', 'abc', '5000ms', '1e4', '-2000', ' 3000', '3000.5']) assert.equal(dsaShortMs({ OWED_DSA_SHORT_MS: bad }, warn), undefined, bad);
  assert.equal(warnings.length, 8);
  assert.match(warnings[0]!, /^owed: ignoring OWED_DSA_SHORT_MS="999" \(expected an integer 1000-120000\); read timeout 15000 ms$/);
  dsaShortMs({ OWED_DSA_SHORT_MS: '999' }, warn);
  assert.equal(warnings.length, 8, 'one warning line per value');
  assert.equal(new Dsa({ bin: '/nonexistent/dsa', env: { OWED_DSA_SHORT_MS: 'abc' } }).readTimeoutMs, 15_000);
});

test('HT2: reads use the read timeout; write calls (run, send) keep their own limit', { timeout: 60_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'owed-ht2-'));
  try {
    const slow = join(root, 'slow');
    await writeFile(slow, '#!/bin/sh\ncat >/dev/null\nsleep 1.5\necho \'{"request":"r","wid":"w","created":true,"spec_digest":"d","state":"running"}\'\n'); await chmod(slow, 0o755);
    const d = new Dsa({ bin: slow, env: { OWED_DSA_SHORT_MS: '1000' }, timeoutMs: 6000, readPausesMs: [0, 0, 0] });
    let retries = 0; d.onReadRetry = () => { retries++; };
    assert.equal(d.readTimeoutMs, 1000);
    assert.equal((await d.run('r', '{}')).outcome, 'applied');
    assert.equal((await d.send('s', 'r', 'steer', 'x')).outcome, 'applied');
    await assert.rejects(d.describe('r'), (e: unknown) => e instanceof DsaError && e.transient);
    assert.equal(retries, 0, 'a client the driver does not own makes one attempt');
  } finally { await rm(root, { recursive: true, force: true }); }
});

// ---------- HT1 in the driver: no halt, one line, halt after 10 minutes ----------
test('HT1: driver: a read timeout then success neither halts nor logs; retries are counted', { timeout: 120_000 }, async () => {
  const r = await rig(), dir = await fakeDir();
  try {
    const dsa = new Dsa({ bin: FAKE, env: { FAKE_DSA_DIR: dir }, readTimeoutMs: 1000, readPausesMs: [0, 0, 0] });
    let retries = 0; dsa.onReadRetry = () => { retries++; };
    const lines: string[] = [], d = driverOf(r.cwd, dsa, lines);
    await d.pass();                                 // launches the writer (the fake run stays running)
    await writeFile(join(dir, 'faults'), 'describe hang 20000\ndescribe hang 20000\n');
    const n = lines.length;
    await d.pass();
    assert.equal(retries, 2); assert.equal(describeFaults(dir).length, 2);
    assert.ok(!lines.slice(n).some(l => /dsa read unavailable|describe-failed|halt/.test(l)), lines.join('\n'));
    assert.deepEqual(halts(await r.entries()), []);
  } finally { await rm(dir, { recursive: true, force: true }); await r.cleanup(); }
});

test('HT1: driver: a persistently failing read never halts before 10 minutes (injected clock), halts after with the 10-min reason', { timeout: 120_000 }, async () => {
  const r = await rig(), dir = await fakeDir();
  try {
    const dsa = new Dsa({ bin: FAKE, env: { FAKE_DSA_DIR: dir }, readTimeoutMs: 1000, readPausesMs: [0, 0, 0] });
    let now = Date.UTC(2026, 9, 22, 8, 0);
    const lines: string[] = [], d = driverOf(r.cwd, dsa, lines, () => now);
    await d.pass();
    const rid = runId(d.project!, 'a', 1, 'writer');
    const failing = async () => { await writeFile(join(dir, 'faults'), 'describe hang 20000\n'.repeat(4)); return d.pass(); };
    let p = await failing();
    assert.equal(lines.filter(l => l === `dsa read unavailable: describe ${rid}: dsa describe ${rid} timed out`).length, 1, lines.join('\n'));
    assert.ok(!p.actions.some(a => wakeReport(a)), 'no wake');
    assert.ok(!lines.some(l => /describe-failed/.test(l)));
    now += 5 * MIN; p = await failing();
    now += 4 * MIN + 59_000; p = await failing();
    assert.deepEqual(halts(await r.entries()), [], 'no halt before 10 minutes');
    assert.equal(lines.filter(l => l.startsWith('dsa read unavailable:')).length, 1, 'one line per streak');
    now += 1000; p = await failing();
    const h = halts(await r.entries());
    assert.equal(h.length, 1, lines.join('\n'));
    assert.equal(h[0]!.kind === 'halt' && h[0]!.reason, `dsa reads failing for 10 min: describe ${rid}: dsa describe ${rid} timed out`);
    assert.equal(describeFaults(dir).length, 16, 'each failing pass: one describe and three retries');
  } finally { await rm(dir, { recursive: true, force: true }); await r.cleanup(); }
});

test('HT1: a success in between restarts the 10-minute streak', { timeout: 120_000 }, async () => {
  const r = await rig();
  try {
    let fail = false, now = 0;
    const dsa = new Scripted((rid) => { if (fail) throw new DsaError(`dsa describe ${rid} timed out`, { transient: true }); return { view: { rid, state: 'running' }, gen: 1 }; });
    const lines: string[] = [], d = driverOf(r.cwd, dsa, lines, () => now);
    await d.pass();
    fail = true; await d.pass();
    now += 9 * MIN; fail = false; await d.pass();
    fail = true; await d.pass();
    now += 9 * MIN; await d.pass();
    assert.deepEqual(halts(await r.entries()), []);
    assert.equal(lines.filter(l => l.startsWith('dsa read unavailable:')).length, 2, 'a new streak logs again');
    now += MIN; await d.pass();
    assert.equal(halts(await r.entries()).length, 1);
  } finally { await r.cleanup(); }
});

// ---------- HT3: attest results already in the ledger ----------
async function attestRig(record: boolean, error: Omit<Extract<CommandResult, { outcome: 'error' }>, 'rid' | 'outcome'>) {
  const r = await rig();
  await commitAt(r.worktree, { 'a/x.txt': 'candidate\n' });
  const dsa = new Scripted(rid => ({ view: { rid, state: 'sealed', status: 'ok' }, gen: 1 }));
  const lines: string[] = [], d = driverOf(r.cwd, dsa, lines);
  await d.pass();                                   // launch
  await ops.submit({ cwd: r.worktree, as: { role: 'writer', id: 'a#1' }, node: 'a' });
  let commands = 0;
  dsa.commandRun = async rid => {
    commands++;
    // The measurement lands in the ledger, then the status read fails (lost response / unknown seal / timeout).
    if (record) await ops.attest({ cwd: r.cwd, node: 'a' });
    return { outcome: 'error', rid, ...error };
  };
  const p = await d.pass(); await d.settle(p.actions);
  return { r, d, lines, actions: p.actions, commands: () => commands };
}

for (const [name, error] of [
  ['unknown seal', { reason: 'command seal unknown without a normal exit' }],
  ['describe failure (timed out)', { reason: 'dsa command describe failed (timed out)', transient: true as const, call: 'describe x' }],
] as const) test(`HT3: attest error (${name}) with the measurements already in the ledger: no halt, proceeds from them`, { timeout: 120_000 }, async () => {
  const f = await attestRig(true, error);
  try {
    assert.equal(f.commands(), 1);
    const es = await f.r.entries();
    assert.deepEqual(halts(es), [], f.lines.join('\n'));
    const obs = es.filter(e => e.kind === 'obs' && e.subject === 'a' && e.obligation === 'writes');
    assert.equal(obs.length, 1);
    const done = f.actions.find((a: ActionReport) => a.do === 'attest' && a.outcome === 'done');
    assert.ok(done, f.lines.join('\n'));
    assert.match(done.detail!, new RegExp(`^accepted; attest result taken from ledger #${obs[0]!.seq}$`));
    assert.ok(f.lines.some(l => l.includes(`attest result taken from ledger #${obs[0]!.seq}`)));
    // Accepted continues: the next pass merges.
    f.d.tick(); const next = await f.d.pass(); await f.d.settle(next.actions);
    assert.ok((await stateOf(f.r.cwd)).nodes.a!.merged, f.lines.join('\n'));
  } finally { await f.r.cleanup(); }
});

test('HT3: attest error with a failing measurement in the ledger takes the normal repair path (no halt)', { timeout: 120_000 }, async () => {
  const r = await rig();
  try {
    const dsa = new Scripted(rid => ({ view: { rid, state: 'sealed', status: 'ok' }, gen: 1 }));
    const lines: string[] = [], d = driverOf(r.cwd, dsa, lines);
    await d.pass();                                     // launch the writer
    await commitAt(r.worktree, { 'outside.txt': 'not in writes\n' });
    await ops.submit({ cwd: r.worktree, as: { role: 'writer', id: 'a#1' }, node: 'a' });
    let commands = 0;
    dsa.commandRun = async rid => {
      commands++;
      await ops.attest({ cwd: r.cwd, node: 'a' });      // the measurement lands in the ledger (writes fails)
      return { outcome: 'error', rid, reason: 'command seal unknown without a normal exit' };
    };
    const p = await d.pass(); await d.settle(p.actions);
    assert.equal(commands, 1);
    const es = await r.entries();
    assert.deepEqual(halts(es), [], lines.join('\n'));
    const obs = es.filter(e => e.kind === 'obs' && e.subject === 'a' && e.obligation === 'writes');
    assert.equal(obs.length, 1);
    assert.equal(obs[0]!.kind === 'obs' && obs[0]!.verdict, 'fail');
    const done = p.actions.find((a: ActionReport) => a.do === 'attest' && a.outcome === 'done');
    assert.ok(done, lines.join('\n'));
    assert.match(done.detail!, new RegExp(`^measured; not accepted yet: .*; attest result taken from ledger #${obs[0]!.seq}$`));
    // The next pass repairs the writer as it does for any measured failure.
    d.tick(); const next = await d.pass();
    const sends = (await r.entries()).filter(e => e.kind === 'send' && e.reason === 'repair');
    assert.equal(sends.length, 1, lines.join('\n'));
    assert.ok(next.actions.some(a => a.do === 'send' && a.reason === 'repair'));
  } finally { await r.cleanup(); }
});

test('HT3: attest error without the measurements in the ledger still halts', { timeout: 120_000 }, async () => {
  const f = await attestRig(false, { reason: 'command seal unknown without a normal exit' });
  try {
    const h = halts(await f.r.entries());
    assert.equal(h.length, 1, f.lines.join('\n'));
    assert.match(h[0]!.kind === 'halt' ? h[0]!.reason : '', /^attest error: run \S+: command seal unknown without a normal exit$/);
    assert.ok(!f.lines.some(l => l.includes('attest result taken from ledger')));
  } finally { await f.r.cleanup(); }
});

test('HT1/HT3: an attest whose status read stays unavailable (nothing in the ledger) does not halt; it is retried on a later pass', { timeout: 120_000 }, async () => {
  const f = await attestRig(false, { reason: 'dsa command describe failed (timed out)', transient: true, call: 'describe x' });
  try {
    assert.deepEqual(halts(await f.r.entries()), [], f.lines.join('\n'));
    assert.ok(f.actions.some(a => a.do === 'attest' && a.outcome === 'retry' && !wakeReport(a)), f.lines.join('\n'));
    assert.equal(f.lines.filter(l => l.startsWith('dsa read unavailable: describe ')).length, 1, f.lines.join('\n'));
    f.d.tick(); const next = await f.d.pass(); await f.d.settle(next.actions);
    assert.equal(f.commands(), 2, 'the attest is decided again');
    assert.deepEqual(halts(await f.r.entries()), []);
  } finally { await f.r.cleanup(); }
});

// ---------- HT4: a newer writer generation ----------
test('HT4: a newer writer generation running suppresses the halt; the halt follows when that generation ends failed', { timeout: 120_000 }, async () => {
  const r = await rig();
  try {
    // Per pass: the observe describe, then (only before a halt or repair) the HT4 describe.
    let script: { view: (rid: string) => RunView; gen: number }[] = [];
    const dsa = new Scripted(rid => { const s = script.shift() ?? { view: (x: string) => ({ rid: x, state: 'running' }), gen: 1 }; return { view: s.view(rid), gen: s.gen }; });
    const failed = (gen: number) => ({ view: (rid: string): RunView => ({ rid, state: 'sealed', status: 'failed', error: 'boom' }), gen });
    const running = (gen: number) => ({ view: (rid: string): RunView => ({ rid, state: 'running' }), gen });
    const lines: string[] = [], d = driverOf(r.cwd, dsa, lines);
    await d.pass();
    const rid = runId(d.project!, 'a', 1, 'writer');
    script = [failed(1), running(2)];
    let p = await d.pass();
    assert.deepEqual(halts(await r.entries()), [], lines.join('\n'));
    assert.ok(lines.includes(`waiting: ${rid} generation 2 is running`), lines.join('\n'));
    const w = p.actions.find(a => a.do === 'halt');
    assert.equal(w?.outcome, 'waiting'); assert.equal(wakeReport(w!), false, 'no wake');
    script = [running(2)]; p = await d.pass();
    assert.deepEqual(halts(await r.entries()), []);
    assert.equal(dsa.inspects, 3, 'a running generation is not described twice');
    script = [failed(2), failed(2)]; p = await d.pass();
    const h = halts(await r.entries());
    assert.equal(h.length, 1, lines.join('\n'));
    assert.match(h[0]!.kind === 'halt' ? h[0]!.reason : '', /sealed failed: boom/);
  } finally { await r.cleanup(); }
});

test('HT4: a newer writer generation running suppresses the repair follow-up', { timeout: 120_000 }, async () => {
  const r = await rig();
  try {
    let script: { state: 'sealed' | 'running'; gen: number }[] = [];
    const dsa = new Scripted(rid => { const s = script.shift() ?? { state: 'running' as const, gen: 1 }; return { view: s.state === 'sealed' ? { rid, state: 'sealed', status: 'ok' } : { rid, state: 'running' }, gen: s.gen }; });
    const lines: string[] = [], d = driverOf(r.cwd, dsa, lines);
    await d.pass();
    const rid = runId(d.project!, 'a', 1, 'writer');
    await commitAt(r.worktree, { 'outside.txt': 'not in writes\n' });
    await ops.submit({ cwd: r.worktree, as: { role: 'writer', id: 'a#1' }, node: 'a' });
    await ops.attest({ cwd: r.cwd, node: 'a' });   // writes fails: a measured block the driver repairs
    script = [{ state: 'sealed', gen: 1 }, { state: 'running', gen: 2 }];
    const p = await d.pass();
    const sends = (await r.entries()).filter(e => e.kind === 'send');
    assert.deepEqual(sends, [], lines.join('\n'));
    assert.ok(lines.includes(`waiting: ${rid} generation 2 is running`), lines.join('\n'));
    assert.ok(p.actions.some(a => a.do === 'send' && a.outcome === 'waiting' && !wakeReport(a)));
    // The generation ends ok without a new candidate: the repair is decided again and sent.
    script = [{ state: 'sealed', gen: 2 }, { state: 'sealed', gen: 2 }];
    await d.pass();
    assert.equal((await r.entries()).filter(e => e.kind === 'send' && e.reason === 'repair').length, 1, lines.join('\n'));
  } finally { await r.cleanup(); }
});

test('HT4: a halt recorded for an older generation while a newer one runs shows as stale in status and why (running driver only)', { timeout: 120_000 }, async () => {
  const r = await rig();
  try {
    let script: { view: (rid: string) => RunView; gen: number }[] = [];
    const dsa = new Scripted(rid => { const s = script.shift() ?? { view: (x: string) => ({ rid: x, state: 'running' }), gen: 3 }; return { view: s.view(rid), gen: s.gen }; });
    const failed = { view: (rid: string): RunView => ({ rid, state: 'sealed', status: 'failed' }), gen: 1 };
    const lines: string[] = [], d = driverOf(r.cwd, dsa, lines);
    await d.pass();
    const rid = runId(d.project!, 'a', 1, 'writer');
    script = [failed, failed]; await d.pass();
    const [h] = halts(await r.entries());
    assert.ok(h, lines.join('\n'));
    // A foreign wake starts generation 3 of the writer while the halt stands: the driver records it as stale.
    await d.pass();
    const stalePath = join(r.dir, 'drive', 'stale-halts.json');
    assert.deepEqual(JSON.parse(readFileSync(stalePath, 'utf8')), [{ node: 'a', seq: h.seq, rid, gen: 3 }]);
    const line = `stale halt: generation 3 is running (${rid})`;
    // No running driver: unknown, nothing shown, status JSON unchanged.
    let v = await ops.status({ cwd: r.cwd });
    assert.equal('staleHalts' in v, false);
    assert.ok(!renderStatus(v).includes('stale halt'));
    assert.ok(!renderWhy(await ops.why({ cwd: r.cwd, node: 'a' })).includes('stale halt'));
    const lock = await acquireDriveLock(r.dir);
    try {
      v = await ops.status({ cwd: r.cwd });
      assert.deepEqual(v.staleHalts, [{ node: 'a', seq: h.seq, rid, gen: 3 }]);
      assert.ok(renderStatus(v).split('\n').includes(`⏸ a: ${line}`), renderStatus(v));
      assert.ok(renderStatusFull(v).split('\n').includes(`⏸ a: ${line}`), renderStatusFull(v));
      const card = await ops.why({ cwd: r.cwd, node: 'a' });
      assert.ok(renderWhy(card).split('\n').includes(`⏸ ${line}`), renderWhy(card));
      assert.ok(renderWhy(card, { full: true }).split('\n').includes(`⏸ ${line}`));
      // The halt is cleared and a new one recorded: the record of the superseded halt is ignored.
      await ops.resume({ cwd: r.cwd, as: parent, channel: 'flag', node: 'a' });
      assert.equal('staleHalts' in await ops.status({ cwd: r.cwd }), false);
      await ops.halt({ cwd: r.cwd, as: DRIVE_PRINCIPAL, node: 'a', attempt: 1, reason: 'another halt', needs: 'human' });
      v = await ops.status({ cwd: r.cwd });
      assert.equal('staleHalts' in v, false);
      assert.ok(!renderWhy(await ops.why({ cwd: r.cwd, node: 'a' })).includes('stale halt'));
      // Unreadable file: unknown.
      await appendFile(stalePath, '{torn');
      const s = await stateOf(r.cwd);
      assert.equal((await assembleRuntime({ cwd: r.cwd, state: s, driverRunning: true })).staleHalts, undefined);
    } finally { await lock.release(); }
  } finally { await r.cleanup(); }
});

test('HT4: views render runtime stale halts only for the active halt', async () => {
  const r = await rig();
  try {
    const h = await ops.halt({ cwd: r.cwd, as: DRIVE_PRINCIPAL, node: 'a', attempt: 1, reason: 'x', needs: 'human' });
    const s = await stateOf(r.cwd), es = await r.entries();
    const rt = { driverRunning: true, staleHalts: [{ node: 'a', seq: h.seq, rid: 'rid-a', gen: 4 }, { node: 'a', seq: h.seq - 1, rid: 'old', gen: 9 }] };
    const v = statusView(s, es, [], Date.now(), true, undefined, undefined, rt);
    assert.deepEqual(v.staleHalts, [{ node: 'a', seq: h.seq, rid: 'rid-a', gen: 4 }]);
    assert.match(renderStatus(v), /^⏸ a: stale halt: generation 4 is running \(rid-a\)$/m);
    assert.match(renderWhy(receipt(s, es, 'a', [], undefined, rt)), /^⏸ stale halt: generation 4 is running \(rid-a\)$/m);
    assert.equal('staleHalts' in statusView(s, es, [], Date.now(), true), false);
    assert.equal('staleHalt' in receipt(s, es, 'a'), false);
  } finally { await r.cleanup(); }
});
