import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, readFile, stat } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
// Keep CLI/plan behavioral assertions runnable on the slot base, where the new module is absent.
const watchdog = await import('../src/watchdog.ts').catch((e: NodeJS.ErrnoException) => {
  if (e.code !== 'ERR_MODULE_NOT_FOUND' || !e.message.includes('/src/watchdog.ts')) throw e;
  return {} as typeof import('../src/watchdog.ts');
});
const { assessIdle, claimIdle, idleExit, idleText, idleNodes, idle, idleWake, IdleWatch, WATCH_POLL_MS, watchdogLockHeld } = watchdog;
import type { IdleFacts } from '../src/watchdog.ts';
import { parsePlan } from '../src/plan.ts';
import { Dsa } from '../src/dsa.ts';
import { main } from '../src/cli.ts';
import * as ops from '../src/ops.ts';
import { repo } from './helpers/repo.ts';
import type { StatusView } from '../src/views.ts';

const now = Date.parse('2026-10-15T12:00:00Z');
const fixture = (): IdleFacts => ({ now, last: { seq: 4, ts: '2026-10-15T11:30:00Z' }, nodes: [{ id: 'work', state: 'ready', next: 'owed dispatch work', ready: true }], driverRunning: false, lockHeld: false, machineHeld: false, calls: [] });
const temp = () => mkdtemp(join(tmpdir(), 'owed-watchdog-'));

test('WD1 each of a-e independently prevents idle, including asking and unknown dsa', () => {
  const f = fixture(); assert.equal(assessIdle(f).idle, true);
  for (const patch of [{ nodes: [] }, { driverRunning: true }, { lockHeld: true }, { machineHeld: true }, { calls: [{ state: 'running', labels: { node: 'work' } }] }, { calls: [{ state: 'asking', labels: { node: 'work' } }] }, { last: { seq: 5, ts: '2026-10-15T11:45:00Z' } }, { idleMin: 0 }]) assert.equal(assessIdle({ ...f, ...patch }).idle, false, JSON.stringify(patch));
  assert.equal(assessIdle({ ...f, calls: undefined }).idle, true);
  assert.equal(assessIdle({ ...f, calls: undefined, last: { seq: 5, ts: '2026-10-15T11:59:00Z' } }).idle, false);
  assert.equal(assessIdle({ ...f, calls: [{ state: 'running', labels: { node: 'other' } }] }).idle, true);
  assert.equal(assessIdle({ ...f, nodes: [...f.nodes, { id: 'old', state: 'merged', next: '', merged: true }], calls: [{ state: 'running', labels: { node: 'old' } }] }).idle, true);
  for (const flag of ['openCandidate', 'needsYou'] as const) assert.equal(assessIdle({ ...f, nodes: [{ ...f.nodes[0]!, ready: false, [flag]: true }] }).idle, true);
});

test('WD1 output is bounded, plain, and keeps exact status next commands', () => {
  const f = fixture(); f.nodes = Array.from({ length: 8 }, (_, i) => ({ ...f.nodes[0]!, id: `n${i}` }));
  const r = assessIdle(f), text = idleText(r);
  assert.equal(idleExit(r), 0); assert.equal(idleExit(assessIdle({ ...f, lockHeld: true })), 3);
  assert.equal(text.split('\n').length, 7);
  assert.match(text, /^Nothing has moved for 30 min and nobody is working on it\./);
  assert.match(text, /Last progress: 2026-10-15T11:30:00Z$/);
  assert.doesNotMatch(text, /\b(seq|obligation|lease|candidate)\b/);
  const v = { nodes: { work: { id: 'work', phase: 'submitted', slot: { open: true }, candidate: {} } }, ready: [], overlaps: {}, summary: { needs: [{ node: 'work', command: 'owed resume work --note "exact text"' }] } } as unknown as StatusView;
  assert.equal(idleNodes(v)[0]!.next, v.summary!.needs[0]!.command);
  v.summary!.needs.push({ node: 'trunk', reason: 'needs attention', command: 'owed plan <plan.yaml>' });
  assert.equal(idleNodes(v).find(n => n.id === 'trunk')!.needsYou, true);
});

test('WD plan key defaults preserve old parsed plans, validates integers and 0 disables', () => {
  const p = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: [] };
  assert.equal(parsePlan(JSON.stringify(p)).drive?.watch_idle_min, undefined);
  for (const value of [0, 1, 15]) assert.equal(parsePlan(JSON.stringify({ ...p, drive: { watch_idle_min: value } })).drive!.watch_idle_min, value);
  for (const value of [-1, 0.5, '15']) assert.throws(() => parsePlan(JSON.stringify({ ...p, drive: { watch_idle_min: value } })), /drive.watch_idle_min/);
});

test('WD2 atomic claim has one winner across sessions and a new ledger period can wake', async () => {
  const dir = await temp();
  try {
    assert.equal((await Promise.all(Array.from({ length: 20 }, () => claimIdle(dir, 4)))).filter(Boolean).length, 1);
    assert.equal(await claimIdle(dir, 4), false); assert.equal(await claimIdle(dir, 5), true);
    assert.equal(await readFile(join(dir, 'watch', 'idle-4'), 'utf8'), '');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('WD2 extension watchdog polls 120s, waits for settled, dedups, and ignores stale async results', async () => {
  const dir = await temp(); let time = 0, busy = false, seq = 4, assessments = 0;
  const messages: string[] = [];
  try {
    await writeFile(join(dir, 'ledger.jsonl'), 'fixture');
    const o = { now: () => time, busy: () => busy, directory: async () => dir, currentSeq: async () => seq, assess: async () => { assessments++; return assessIdle(fixture()); } };
    const a = new IdleWatch(text => { messages.push(text); }, o), b = new IdleWatch(text => { messages.push(text); }, o);
    await a.attach(dir); await b.attach(dir); await a.flush(); assert.equal(assessments, 0);
    time = WATCH_POLL_MS; busy = true; await a.flush(); assert.equal(messages.length, 0); assert.equal(assessments, 0);
    busy = false; await Promise.all([a.flush(), b.flush()]); assert.equal(messages.length, 1);
    time += WATCH_POLL_MS; await a.flush(); assert.equal(messages.length, 1);
    seq = 5; time += WATCH_POLL_MS; await a.flush(); assert.equal(messages.length, 1);
    const c = new IdleWatch(text => { messages.push(text); }, { ...o, assess: async () => assessIdle({ ...fixture(), last: { ...fixture().last!, seq: 5 } }) });
    await c.attach(dir); time += WATCH_POLL_MS; await c.flush(); assert.equal(messages.length, 2);
    c.stopAll(); time += WATCH_POLL_MS; await c.flush(); assert.equal(messages.length, 2);
    a.stopAll(); b.stopAll();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('WD2 no claim when agent starts during assessment; delivery rejection releases only its claim', async () => {
  const dir = await temp(); let time = 0, busy = false, failures = true, delivered = 0;
  try {
    await writeFile(join(dir, 'ledger.jsonl'), 'fixture');
    const o = { now: () => time, busy: () => busy, directory: async () => dir, currentSeq: async () => 4, assess: async () => { busy = true; return assessIdle(fixture()); } };
    const a = new IdleWatch(() => { delivered++; }, o); await a.attach(dir); time = WATCH_POLL_MS; await a.flush();
    await assert.rejects(stat(join(dir, 'watch', 'idle-4')), { code: 'ENOENT' });
    busy = false;
    const b = new IdleWatch(() => { if (failures) throw new Error('pi rejected busy wake'); delivered++; }, { ...o, assess: async () => assessIdle(fixture()) });
    await b.attach(dir); time += WATCH_POLL_MS; await b.flush(); await assert.rejects(stat(join(dir, 'watch', 'idle-4')), { code: 'ENOENT' });
    failures = false; await b.flush(); assert.equal(delivered, 1); a.stopAll(); b.stopAll();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('WD extension sends one triggerTurn follow-up and detects progress after claiming', async () => {
  const dir = await temp(); let time = 0, busy = false, reads = 0;
  const messages: unknown[][] = [];
  try {
    await writeFile(join(dir, 'ledger.jsonl'), 'fixture');
    const o = { now: () => time, busy: () => busy, directory: async () => dir, currentSeq: async () => 4, assess: async () => assessIdle(fixture()) };
    const pi = { sendMessage: (...args: unknown[]) => { messages.push(args); } };
    const a = idleWake(pi, o); await a.attach(dir); time = WATCH_POLL_MS; busy = true; await a.flush(); assert.equal(messages.length, 0);
    busy = false; await a.flush(); time += WATCH_POLL_MS; await a.flush();
    assert.equal(messages.length, 1); assert.deepEqual(messages[0]![1], { triggerTurn: true, deliverAs: 'followUp' });
    assert.equal((messages[0]![0] as { customType: string }).customType, 'owed-idle');
    const b = idleWake(pi, { ...o, assess: async () => assessIdle({ ...fixture(), last: { ...fixture().last!, seq: 5 } }), currentSeq: async () => ++reads === 1 ? 5 : 6 });
    await b.attach(dir); time += WATCH_POLL_MS; await b.flush(); assert.equal(messages.length, 1);
    await assert.rejects(stat(join(dir, 'watch', 'idle-5')), { code: 'ENOENT' }); a.stopAll(); b.stopAll();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('WD lock reader covers each owed lock and conservatively treats foreign owners', async () => {
  const dir = await temp();
  try {
    assert.equal(await watchdogLockHeld(dir), false);
    for (const name of ['lock', 'merge', 'trunk-refresh', 'adopt']) {
      await mkdir(join(dir, name)); await writeFile(join(dir, name, 'owner.json'), JSON.stringify({ host: hostname(), pid: process.pid }));
      assert.equal(await watchdogLockHeld(dir), true, name); await rm(join(dir, name), { recursive: true });
    }
    await mkdir(join(dir, 'lock')); await writeFile(join(dir, 'lock', 'owner.json'), JSON.stringify({ host: 'other-host', pid: 1 }));
    assert.equal(await watchdogLockHeld(dir), true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('WD gathered dsa call labels and machine holders; unavailable status still checks machine', async () => {
  const dir = await temp();
  try {
    const script = join(dir, 'dsa');
    await writeFile(script, '#!/bin/sh\nif [ "$1" = status ]; then printf \'%s\\n\' \'{"workflows":[{"labels":{"node":"work"},"calls":[{"phase":"asking"}]}]}\'; else printf \'%s\\n\' \'[{"resource":"machine","holders":[{}]}]\'; fi\n', { mode: 0o755 });
    const dsa = new Dsa({ bin: script, timeoutMs: 1000 }); const facts = await dsa.watchdogFacts();
    assert.equal(facts.calls![0]!.labels!.node, 'work'); assert.equal(facts.machineHeld, true);
    await writeFile(script, '#!/bin/sh\nif [ "$1" = status ]; then exit 1; else echo \'[{"resource":"machine","holders":[{}]}]\'; fi\n');
    const unknown = await dsa.watchdogFacts(); assert.equal(unknown.calls, undefined); assert.equal(unknown.machineHeld, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('WD CLI idle/JSON returns 0 for old open work, 3 for fresh work, errors otherwise', async () => {
  const r = await repo(), priorDsa = process.env.OWED_DSA, cwd = process.cwd(), realNow = Date.now;
  try {
    process.env.OWED_DSA = join(r.root, 'missing-dsa');
    await r.commit();
    await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'test' }, channel: 'flag', plan: JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [], nodes: [{ id: 'work', writes: ['src/'], checks: [], review: { count: 0, min_rank: 1 } }] }) });
    process.chdir(r.cwd);
    const output: string[] = [], errors: string[] = [], io = { log: (s: string) => { output.push(s); }, error: (s: string) => { errors.push(s); } };
    assert.equal(await main(['idle'], io), 3);
    Date.now = () => realNow() + 16 * 60_000;
    assert.equal((await idle(r.cwd)).idle, true);
    assert.equal(await main(['idle', '--json'], io), 0); assert.equal(JSON.parse(output.at(-1)!).idle, true);
    assert.equal(await main(['idle'], io), 0); assert.match(output.at(-1)!, /work: ready; next: owed dispatch work/);
    assert.equal(await main(['idle', 'unexpected'], io), 2);
    await rm(join(process.env.OWED_DIR!, 'ledger.jsonl')); assert.notEqual(await main(['idle'], io), 0);
  } finally { Date.now = realNow; process.chdir(cwd); if (priorDsa === undefined) delete process.env.OWED_DSA; else process.env.OWED_DSA = priorDsa; await r.cleanup(); }
});
