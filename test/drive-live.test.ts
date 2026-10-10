// H1 (0.6.1, node drive-live): live wakes in pi (held while the agent runs, revalidated at delivery), `owed drive
// --stay`, and the ready hint after a plan update. Fake dsa only (test/fixtures/fake-dsa.mjs), never the real dsa.
// Exports added by this node are read through the module namespaces, so the base fails by assertion or "is not a
// function", not at import time.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owedExtension from '../src/extension.ts';
import * as ops from '../src/ops.ts';
import * as bg from '../src/drive-bg.ts';
import * as run from '../src/drive-run.ts';
import { Ledger } from '../src/ledger.ts';
import { Dsa } from '../src/dsa.ts';
import type { Entry } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { identity } from './helpers/surface.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-dsa.mjs', import.meta.url));
const OWED = fileURLToPath(new URL('../bin/owed.js', import.meta.url));
type Json = Record<string, unknown>;
const NEW = bg as unknown as {
  revalidator(o: { cwd: string; dsa?: Dsa }): (checks: readonly unknown[]) => Promise<boolean[]>;
  Follower: new (o: Json) => { tick(): string | undefined; step(): Promise<string | undefined>; stop(): void; stopped: boolean };
};
const IDLE_WAIT = 'idle: nothing open and nothing ready; staying until the ledger changes (owed drive --stop ends it)';
const sleepMs = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(fn: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  for (;;) {
    let ok = false;
    try { ok = await fn(); } catch { ok = false; }
    if (ok) return;
    if (Date.now() > end) throw new Error(`timed out after ${ms} ms waiting for ${what}`);
    await sleepMs(100);
  }
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
const node = (id: string, o: Json = {}) => ({ id, writes: [`${id}.txt`], checks: [], review: { count: 0, min_rank: 1 }, ...o });
const planOf = (...nodes: object[]) => ({ version: 1, trunk: 'main', closure: [], invariants: [], nodes });
const parent = { role: 'parent' as const, id: 'main' };

async function rig(plan: object) {
  const r = await repo();
  const dir = join(r.root, 'dsa'), bin = join(r.root, 'bin');
  await mkdir(join(dir, 'agents'), { recursive: true }); await mkdir(bin);
  await writeFile(join(bin, 'owed'), `#!/bin/sh\nexec "${process.execPath}" "${OWED}" "$@"\n`); await chmod(join(bin, 'owed'), 0o755);
  const env = { FAKE_DSA_DIR: dir, PATH: `${bin}:${process.env.PATH}`, ...identity };
  await r.put('plan.json', JSON.stringify(plan)); await r.put('README', 'x\n'); await r.commit();
  await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'human' }, channel: 'flag', plan: JSON.stringify(plan) });
  const ledgerDir = process.env.OWED_DIR!;
  const pids: number[] = [];
  const self = {
    ...r, dir, env, pids,
    lock: join(ledgerDir, 'drive.lock'),
    log: join(ledgerDir, 'drive', 'log.jsonl'),
    dsa: new Dsa({ bin: FAKE, env: { FAKE_DSA_DIR: dir } }),
    agent: (name: string, body: string) => writeFile(join(dir, 'agents', `${name}.sh`), `set -e\n${body}\n`),
    entries: async (): Promise<Entry[]> => (await Ledger.open(r.cwd)).read(),
    logJson: (): Json[] => { try { return readFileSync(self.log, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l) as Json); } catch { return []; } },
    cli(args: string[], extra: Record<string, string> = {}) {
      return new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
        execFile(process.execPath, [OWED, ...args], { cwd: r.cwd, env: { ...process.env, ...env, OWED_DSA: FAKE, ...extra }, timeout: 60_000 }, (e, stdout, stderr) => {
          const x = e as (Error & { code?: number }) | null;
          resolve({ code: x ? (typeof x.code === 'number' ? x.code : null) : 0, stdout, stderr });
        });
      });
    },
    async done() {
      for (const pid of pids) { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
      for (const pid of pids) await until(() => !alive(pid), 5000, `pid ${pid} gone`).catch(() => undefined);
      await r.cleanup();
    },
  };
  return self;
}
/** This test process plays the live driver of the repository (lock with its pid and start time). */
const liveLock = (path: string, host = hostname()) => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ pid: process.pid, start: run.procStart(process.pid), host, at: '2026-10-10T00:00:00.000Z', token: 'test' }));
};
async function withEnv<T>(extra: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const prior = new Map(Object.keys(extra).map(k => [k, process.env[k]]));
  Object.assign(process.env, extra);
  try { return await fn(); }
  finally { for (const [k, v] of prior) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
/** A fake pi: tools, event handlers, the messages sent to the session, and a ctx whose isIdle() the test controls. */
function harness(cwd: string) {
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const messages: { message: { customType: string; content: string }; options: unknown }[] = [];
  const state = { idle: true };
  owedExtension({
    registerTool(t: ToolDefinition) { tools.set(t.name, t); },
    registerCommand() { /* unused */ },
    on(event: string, h: (event: unknown, ctx: unknown) => unknown) { handlers.set(event, h); return () => undefined; },
    sendMessage(message: { customType: string; content: string }, options: unknown) { messages.push({ message, options }); },
  } as unknown as ExtensionAPI);
  const ctx = { cwd, hasUI: false, isIdle: () => state.idle, ui: { notify() { /* unused */ }, async confirm() { return false; } } };
  return {
    messages, state,
    async call(name: string, args: Json = {}) {
      const r = await tools.get(`owed_${name}`)!.execute('t', args, undefined, undefined, ctx as unknown as Parameters<ToolDefinition['execute']>[4]);
      return { ...r, text: (r.content[0] as { text: string }).text, details: r.details as Json };
    },
    emit: async (event: string, payload: Json = {}) => { await handlers.get(event)?.({ type: event, ...payload }, ctx); },
    start: () => withEnv({ DSA_EXEC: '', DSA_CALL: '' }, async () => { await handlers.get('session_start')?.({ type: 'session_start', reason: 'startup' }, ctx); }),
  };
}
/** A fake-dsa run of node `n` whose agent asks `questions` on its first execution and runs on (`RUNNING`) after an answer. */
async function askingRun(f: Awaited<ReturnType<typeof rig>>, n: string, rid: string, questions: string[], after: string[] = []) {
  await f.agent(`${n}-writer`, `if [ "$FAKE_KIND" = answer ]; then ${after.length ? after.map(q => `echo 'ASK: ${q}'`).join('; ') : 'echo RUNNING'}; else ${questions.map(q => `echo 'ASK: ${q}'`).join('; ')}; fi`);
  const r = await f.dsa.run(rid, JSON.stringify({ agent: 'worker', once: true, task: 't' }), { node: n, role: 'writer' });
  assert.equal(r.outcome, 'applied');
  const v = await f.dsa.describe(rid);
  assert.equal(v.state, 'asking');
  return v.questions!;
}
const askLine = (n: string, rid: string, q: { qid: string; rev: number }, text: string, facts?: number) => ({ do: 'notify', node: n, outcome: 'notify', text, rid, qid: q.qid, rev: q.rev, ...(facts !== undefined ? { facts } : {}) });

// ---------- H1.1 ----------
test('H1.1a-c pi: a question read while the agent runs is held; answered before the session settles, nothing is delivered; isIdle() also holds', { timeout: 60_000 }, async () => {
  const f = await rig(planOf(node('a')));
  const h = harness(f.cwd);
  const line = (o: Json) => appendFileSync(f.log, `${JSON.stringify(o)}\n`);
  try {
    await withEnv({ OWED_DSA: FAKE, FAKE_DSA_DIR: f.dir }, async () => {
      const [q] = await askingRun(f, 'a', 'rid-a', ['which db?']);
      mkdirSync(join(f.log, '..'), { recursive: true }); writeFileSync(f.log, '');
      liveLock(f.lock);
      await h.start();
      await h.emit('agent_start');
      line(askLine('a', 'rid-a', q!, 'a: writer run rid-a asks (qid q1-1, rev 1): which db?'));
      await sleepMs(2600);   // more than one follower interval (2 s)
      assert.equal(h.messages.length, 0, 'held while the agent runs');
      // The parent answers from the log (as in wais 03:46:48Z), before the session settles.
      const ans = await f.dsa.send('ans-1', 'rid-a', 'answer', 'postgres', { qid: q!.qid, rev: q!.rev });
      assert.equal(ans.outcome, 'applied');
      await h.emit('agent_settled', { aborted: false });
      await sleepMs(2600);
      assert.equal(h.messages.length, 0, 'the answered question is dropped: no wake, the session is not woken');
      // Positive control: a later wake is delivered while idle, without the dropped line and without a carried count.
      line({ do: 'halt', node: 'zz', outcome: 'halted', attempt: 1, needs: 'human', detail: 'later' });
      await until(() => h.messages.length >= 1, 8000, 'the later wake');
      const m = h.messages[0]!;
      assert.deepEqual(m.options, { triggerTurn: true, deliverAs: 'followUp' });
      assert.deepEqual(m.message.content.split('\n').slice(1), ['halt zz attempt 1 (needs human): halted — later', 'Next: owed status / owed why <node>']);
      // ctx.isIdle() false (no agent_start seen): held too; delivered at the next tick once idle.
      h.state.idle = false;
      line({ do: 'halt', node: 'zz', outcome: 'halted', attempt: 1, needs: 'human', detail: 'while streaming' });
      await sleepMs(2600);
      assert.equal(h.messages.length, 1, 'held while ctx.isIdle() is false');
      h.state.idle = true;
      await until(() => h.messages.length >= 2, 8000, 'delivered once idle');
      assert.match(h.messages[1]!.message.content, /halted — while streaming\n/);
    });
  } finally { await h.emit('session_shutdown'); rmSync(f.lock, { force: true }); await f.done(); }
});

test('H1.1b/c revalidation: a fact-advanced halt is dropped; an open question, drift, idle-wait and unmarked lines are delivered; the count ends the message', { timeout: 60_000 }, async () => {
  const f = await rig(planOf(node('h'), node('q')));
  const dir = join(f.root, 'follow'), log = join(dir, 'log.jsonl');
  mkdirSync(dir); writeFileSync(log, '');
  const line = (o: Json) => appendFileSync(log, `${JSON.stringify(o)}\n`);
  try {
    const [q] = await askingRun(f, 'q', 'rid-q', ['which port?']);
    const s0 = await run.stateOf(f.cwd), mark = run.factMark(s0, 'h');
    const got: string[] = [], state = { busy: true };
    const fo = new NEW.Follower({ log, repo: '/r', pid: process.pid, start: run.procStart(process.pid), deliver: (c: string) => got.push(c), busy: () => state.busy, revalidate: NEW.revalidator({ cwd: f.cwd, dsa: f.dsa }) });
    line({ do: 'halt', node: 'h', outcome: 'halted', attempt: 1, needs: 'human', detail: 'needs a decision', facts: mark });
    line({ do: 'merge', node: 'm', outcome: 'merged', detail: 'trunk 1' });
    line(askLine('q', 'rid-q', q!, 'q: writer run rid-q asks (qid q1-1, rev 1): which port?', run.factMark(s0, 'q')));
    line({ do: 'notify', node: 'trunk', scope: 'repo', outcome: 'notify', text: 'trunk main moved outside owed', facts: -1 });
    line({ do: 'halt', node: 'h', outcome: 'halted', attempt: 1, needs: 'human', detail: 'older driver, no mark' });
    line({ event: 'idle-wait', at: '2026-10-10T00:00:00.000Z' });
    assert.equal(await fo.step(), undefined, 'busy: held');
    // Someone acts on h: its fact mark rises above the line's.
    await ops.rule({ cwd: f.cwd, as: parent, text: 'decided', nodes: ['h'] });
    assert.ok(run.factMark(await run.stateOf(f.cwd), 'h') > mark);
    state.busy = false;
    const m = await fo.step();
    assert.deepEqual(m?.split('\n'), ['owed drive (/r):', 'merge m: merged — trunk 1', 'q: writer run rid-q asks (qid q1-1, rev 1): which port?', 'trunk main moved outside owed',
      'halt h attempt 1 (needs human): halted — older driver, no mark', IDLE_WAIT, 'Next: owed status / owed why <node>', '(1 wake(s) resolved before delivery)']);
    assert.equal(got.length, 1);
    // Only dropped lines left: nothing is delivered; a merge read with them rides along with the next message.
    line({ do: 'halt', node: 'h', outcome: 'halted', attempt: 1, needs: 'human', detail: 'stale again', facts: mark });
    line({ do: 'merge', node: 'n', outcome: 'merged', detail: 'trunk 2' });
    assert.equal(await fo.step(), undefined, 'no wake line left: not delivered');
    line({ event: 'stopped' });
    const end = await fo.step();
    assert.deepEqual(end?.split('\n'), ['owed drive (/r):', 'merge n: merged — trunk 2', 'stopped', 'Next: owed status / owed why <node>'], 'the merge rides along; the count is not carried over');
    assert.equal(fo.stopped, true);
    // A failed describe keeps the line.
    const broken = NEW.revalidator({ cwd: f.cwd, dsa: new Dsa({ bin: join(f.root, 'no-such-dsa') }) });
    assert.deepEqual(await broken([{ rid: 'rid-q', qid: 'gone', rev: 1 }]), [true]);
    assert.deepEqual(await NEW.revalidator({ cwd: f.cwd, dsa: f.dsa })([{ rid: 'rid-q', qid: 'gone', rev: 1 }, { rid: 'rid-q', qid: q!.qid, rev: q!.rev + 1 }, { rid: 'rid-q', qid: q!.qid, rev: q!.rev }]), [false, false, true]);
  } finally { await f.done(); }
});

test('H1.1b two open questions: the first answered drops the held line; the next pass prints the remaining question, which is delivered', { timeout: 120_000 }, async () => {
  const f = await rig(planOf(node('a')));
  const out: string[] = [];
  try {
    await f.agent('a-writer', `if [ "$FAKE_KIND" = answer ]; then echo 'ASK: two'; else echo 'ASK: one'; echo 'ASK: two'; fi`);
    mkdirSync(join(f.log, '..'), { recursive: true }); writeFileSync(f.log, '');
    const d = new run.Driver({ cwd: f.cwd, json: true, dsa: new Dsa({ bin: FAKE, env: f.env }), session: null, log: l => { out.push(l); appendFileSync(f.log, `${l}\n`); } });
    const notifies = () => out.map(l => JSON.parse(l) as Json).filter(x => x.do === 'notify');
    for (let i = 0; i < 6 && !notifies().length; i++) await d.pass();
    const first = notifies()[0]!;
    assert.equal(typeof first.rid, 'string');
    assert.equal(first.qid, 'q1-1', 'the first listed question'); assert.equal(first.rev, 1);
    assert.match(String(first.text), /asks \(qid q1-1, rev 1\): one .*\n.*asks \(qid q1-2, rev 1\): two/s, 'the text is askingText, unchanged');
    const got: string[] = [], state = { busy: true };
    const fo = new NEW.Follower({ log: f.log, repo: '/r', pid: process.pid, start: run.procStart(process.pid), from: 0, deliver: (c: string) => got.push(c), busy: () => state.busy, revalidate: NEW.revalidator({ cwd: f.cwd, dsa: f.dsa }) });
    assert.equal(await fo.step(), undefined, 'held');
    assert.equal((await f.dsa.send('ans-1', String(first.rid), 'answer', 'yes', { qid: 'q1-1', rev: 1 })).outcome, 'applied');
    await d.pass();
    const second = notifies()[1];
    assert.ok(second, 'the next pass prints the line again because its text changed');
    assert.doesNotMatch(String(second.text), /: one /);
    state.busy = false;
    const m = await fo.step();
    assert.ok(m);
    assert.doesNotMatch(m, /: one /, 'the line of the answered first question is dropped');
    assert.match(m, new RegExp(`asks \\(qid ${String(second.qid)}, rev 1\\): two`));
    assert.match(m, /\n\(1 wake\(s\) resolved before delivery\)$/);
    fo.stop();
  } finally { await f.done(); }
});

test('H1.1b a dropped wake also drops its repeat ride-along and later repeats of it', { timeout: 60_000 }, async () => {
  const f = await rig(planOf(node('h')));
  const dir = join(f.root, 'follow'), log = join(dir, 'log.jsonl');
  mkdirSync(dir); writeFileSync(log, '');
  const line = (o: Json) => appendFileSync(log, `${JSON.stringify(o)}\n`);
  const halt = (facts: number, detail = 'stuck') => ({ do: 'halt', node: 'h', outcome: 'halted', attempt: 1, needs: 'human', detail, facts });
  try {
    const mark = run.factMark(await run.stateOf(f.cwd), 'h');
    const got: string[] = [], state = { busy: false };
    const fo = new NEW.Follower({ log, repo: '/r', pid: process.pid, start: run.procStart(process.pid), deliver: (c: string) => got.push(c), busy: () => state.busy, revalidate: NEW.revalidator({ cwd: f.cwd, dsa: f.dsa }) });
    line(halt(mark));
    assert.match(await fo.step() ?? '', /halted — stuck\n/, 'delivered while current');
    state.busy = true;
    line(halt(mark, 'other'));        // a new wake of h (other text), held
    assert.equal(await fo.step(), undefined);
    line(halt(mark, 'other'));        // its repeat (a later read): rides along, held
    assert.equal(await fo.step(), undefined);
    await ops.rule({ cwd: f.cwd, as: parent, text: 'decided', nodes: ['h'] });
    line({ do: 'halt', node: 'k', outcome: 'halted', attempt: 1, needs: 'human', detail: 'unrelated' });
    state.busy = false;
    const m = await fo.step();
    assert.deepEqual(m?.split('\n'), ['owed drive (/r):', 'halt k attempt 1 (needs human): halted — unrelated', 'Next: owed status / owed why <node>', '(1 wake(s) resolved before delivery)'],
      'the resolved wake of h and its repeat ride-along are gone');
    line(halt(mark, 'other'));        // a later repeat of the resolved wake: does not ride along
    line({ do: 'halt', node: 'k', outcome: 'halted', attempt: 1, needs: 'human', detail: 'next' });
    const n = await fo.step();
    assert.deepEqual(n?.split('\n'), ['owed drive (/r):', 'halt k attempt 1 (needs human): halted — next', 'Next: owed status / owed why <node>']);
    // The driver's next pass reports h with the new mark: a new fact, delivered.
    const now = run.factMark(await run.stateOf(f.cwd), 'h');
    line(halt(now));
    assert.match(await fo.step() ?? '', /halted — stuck\nNext: /, 'a new fact of h wakes');
    fo.stop();
  } finally { await f.done(); }
});

test('H1.1d CLI-era follower (no pi hooks): no hold, no revalidation; tick delivers as before', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owed-live-')), log = join(dir, 'log.jsonl');
  writeFileSync(log, '');
  try {
    const got: string[] = [];
    const fo = new bg.Follower({ log, repo: '/r', pid: process.pid, start: run.procStart(process.pid), deliver: c => got.push(c) });
    appendFileSync(log, `${JSON.stringify(askLine('a', 'rid-x', { qid: 'gone', rev: 1 }, 'a asks', 0))}\n`);
    assert.match(fo.tick() ?? '', /\na asks\nNext: owed status \/ owed why <node>$/);
    assert.equal(bg.classifyLine(JSON.stringify({ event: 'idle-wait', at: 'x' })).kind, 'wake', 'idle-wait wakes, not terminal');
    assert.equal(run.reportText({ event: 'idle-wait', at: 'x' }), IDLE_WAIT);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ---------- H1.2 ----------
test('H1.2 pi start stay:true: idle-wait wakes and the driver stays; a plan update resumes dispatch; a second idle period wakes again; stop exits 0 stopped', { timeout: 180_000 }, async () => {
  const f = await rig(planOf());
  const h = harness(f.cwd);
  try {
    assert.equal((await h.call('drive', { action: 'once', stay: true })).isError, true, 'stay only with action start');
    assert.equal((await h.call('drive', { action: 'status', stay: true })).isError, true);
    const start = await withEnv({ ...f.env, OWED_DSA: FAKE }, () => h.call('drive', { action: 'start', stay: true }));
    assert.notEqual(start.isError, true, start.text);
    const pid = Number(/^driver started: pid (\d+), log /.exec(start.text)?.[1]);
    assert.ok(pid > 0, start.text); f.pids.push(pid);
    await until(() => h.messages.length >= 1, 30_000, 'the idle-wait wake');
    assert.match(h.messages[0]!.message.content, new RegExp(`\\n${IDLE_WAIT.replace(/[()]/g, '\\$&')}\\nNext: `));
    assert.ok(alive(pid), 'the driver did not exit');
    assert.ok(!f.logJson().some(x => x.event === 'exit' || x.event === 'idle'));
    const status = await h.call('drive', { action: 'status' });
    assert.match(status.text, new RegExp(`^driver running: pid ${pid} .*\\nidle, waiting for ledger changes since \\d{4}-`));
    // The plan grows: the staying driver resumes and dispatches the new node.
    await f.agent('b-writer', 'echo b > b.txt; git add b.txt; git commit -qm b; owed submit b');
    await ops.planSet({ cwd: f.cwd, as: parent, plan: JSON.stringify(planOf(node('b'))) });
    await until(async () => (await f.entries()).some(e => e.kind === 'merge' && e.node === 'b'), 90_000, 'b merged');
    assert.ok(f.logJson().some(x => x.do === 'dispatch' && x.node === 'b'));
    await until(() => f.logJson().filter(x => x.event === 'idle-wait').length === 2, 30_000, 'the second idle period');
    await until(() => h.messages.length >= 2, 10_000, 'the second idle-wait wake');
    assert.match(h.messages[1]!.message.content, /merge b: merged/);
    assert.equal((await h.call('drive', { action: 'stop' })).text, 'stopped');
    await until(() => f.logJson().at(-1)?.event === 'exit', 15_000, 'the exit record');
    const last = f.logJson().at(-1)!;
    assert.equal(last.reason, 'stopped'); assert.equal(last.code, 0);
    await until(() => h.messages.some(m => /driver exited 0 \(stopped\)/.test(m.message.content)), 10_000, 'the exit wake');
  } finally { await h.emit('session_shutdown'); await f.done(); }
});

for (const when of ['during-idle-pass', 'after-idle-wait'] as const) {
  test(`H1.2 stay: a plan update ${when} resumes passes and dispatches the new node (review #725)`, { timeout: 60_000 }, async () => {
    const f = await rig(planOf());
    const orig = run.Driver.prototype.pass;
    let calls = 0, injected = false;
    const inject = () => ops.planSet({ cwd: f.cwd, as: parent, plan: JSON.stringify(planOf(node('b'))) });
    // The update lands after the idle pass loaded its state, just before it returns idle (or after idle-wait).
    run.Driver.prototype.pass = async function (this: run.Driver) {
      const res = await orig.call(this); calls++;
      if (res.idle && !injected) { injected = true; if (when === 'during-idle-pass') await inject(); else setTimeout(() => { void inject(); }, 500); }
      return res;
    };
    const out: string[] = [], ac = new AbortController();
    try {
      const p = run.drive({ cwd: f.cwd, json: true, stay: true, pollMs: 100, passMs: 500, dsa: new Dsa({ bin: FAKE, env: { FAKE_DSA_DIR: f.dir } }), session: null, log: l => out.push(l), signal: ac.signal, handleSignals: false });
      await until(() => out.some(l => (JSON.parse(l) as Json).do === 'dispatch'), 20_000, `the dispatch of b (${when})`).finally(() => ac.abort());
      await p;
      const lines = out.map(l => JSON.parse(l) as Json);
      assert.ok(calls > 1, `passes=${calls}`);
      assert.ok(lines.some(x => x.do === 'dispatch' && x.node === 'b'), JSON.stringify(lines));
      assert.equal(lines.filter(x => x.event === 'idle-wait').length, 1, 'one idle period before the dispatch');
    } finally { run.Driver.prototype.pass = orig; await f.done(); }
  });
}

test('H1.2 CLI: --stay only with --detach or the loop; --detach --stay reports idleSince and stays until --stop', { timeout: 120_000 }, async () => {
  const f = await rig(planOf());
  try {
    for (const bad of [['--once', '--stay'], ['--status', '--stay'], ['--stop', '--stay']]) {
      const r = await f.cli(['drive', ...bad]);
      assert.equal(r.code, 2, `${bad.join(' ')}: ${r.stderr}`); assert.match(r.stderr, /--stay is only valid with --detach or the loop/);
    }
    const s = await f.cli(['drive', '--detach', '--stay']);
    assert.equal(s.code, 0, s.stderr);
    const pid = Number(/^driver started: pid (\d+)/.exec(s.stdout)?.[1]); f.pids.push(pid);
    await until(() => f.logJson().some(x => x.event === 'idle-wait'), 30_000, 'idle-wait');
    const at = f.logJson().find(x => x.event === 'idle-wait')!.at;
    assert.equal(typeof at, 'string');
    assert.ok(!JSON.parse(readFileSync(f.lock, 'utf8')).stay, 'the lock does not record stay');
    const json = await f.cli(['drive', '--status', '--json']);
    assert.equal((JSON.parse(json.stdout) as Json).idleSince, at);
    const text = await f.cli(['drive', '--status']);
    assert.match(text.stdout, new RegExp(`^driver running: pid ${pid} .*\\nidle, waiting for ledger changes since ${String(at)}\\n`));
    assert.match(text.stdout, new RegExp(IDLE_WAIT.replace(/[()]/g, '\\$&')));
    await sleepMs(1000);
    assert.ok(alive(pid), 'still running');
    assert.equal((await f.cli(['drive', '--stop'])).stdout.trim(), 'stopped');
    const last = f.logJson().at(-1)!;
    assert.equal(last.event, 'exit'); assert.equal(last.reason, 'stopped'); assert.equal(last.code, 0);
    const after = await f.cli(['drive', '--status', '--json']);
    assert.equal((JSON.parse(after.stdout) as Json).idleSince, undefined, 'not running: no idleSince');
  } finally { await f.done(); }
});

// ---------- H1.3 ----------
test('H1.3 CLI owed plan: a ready hint when nodes are dispatchable and no driver runs; none with a live or foreign lock; a stale lock is no driver', { timeout: 90_000 }, async () => {
  const f = await rig(planOf(node('a')));
  const nodes = (...ids: string[]) => planOf(...ids.map(id => id === 'c' ? node('c', { deps: ['b'] }) : node(id)));
  try {
    await f.put('p2.json', JSON.stringify(nodes('a', 'b', 'c')));
    const r = await f.cli(['plan', 'p2.json']);
    assert.equal(r.code, 0, r.stderr);
    // The driver's order (more dependents first, then id); c waits for b.
    assert.match(r.stdout, /\nready: b, a \(2\); no driver is running: owed drive --detach --stay\n(?:warning: [^\n]*\n)*$/, 'the hint precedes the H2.2 warnings, which end the text');
    await f.put('p3.json', JSON.stringify(nodes('a', 'b', 'c', 'd')));
    const out = JSON.parse((await f.cli(['plan', 'p3.json', '--json'])).stdout) as Json;
    assert.deepEqual(out.ready, ['b', 'a', 'd']); assert.equal(out.driver, false); assert.equal(out.kind, 'plan');
    assert.ok(Array.isArray(out.warnings) && (out.warnings as unknown[]).length > 0, 'H2.2 warnings stay alongside the hint');
    assert.match(r.stdout, /\nready: [^\n]*\nwarning: node \w+ has no checks/, 'the check-less warnings follow the hint line');
    liveLock(f.lock);
    await f.put('p4.json', JSON.stringify(nodes('a', 'b', 'c', 'd', 'e')));
    const live = await f.cli(['plan', 'p4.json', '--json']);
    assert.equal(live.code, 0, live.stderr);
    const lo = JSON.parse(live.stdout) as Json;
    assert.equal(lo.kind, 'plan'); assert.equal(lo.ready, undefined); assert.equal(lo.driver, undefined);
    liveLock(f.lock, 'another-host');
    await f.put('p5.json', JSON.stringify(nodes('a', 'b', 'c', 'd', 'e', 'g')));
    const foreign = await f.cli(['plan', 'p5.json']);
    assert.equal(foreign.code, 0, foreign.stderr); assert.doesNotMatch(foreign.stdout, /no driver is running/, 'a foreign lock counts as a driver');
    writeFileSync(f.lock, JSON.stringify({ pid: 2 ** 22 + 7, host: hostname(), at: 'x', token: 'stale' }));
    await f.put('p6.json', JSON.stringify(nodes('a', 'b', 'c', 'd', 'e', 'g', 'k')));
    // drive.max (default 4) bounds what the driver would dispatch.
    assert.match((await f.cli(['plan', 'p6.json'])).stdout, /\nready: b, a, d, e \(4\); no driver is running: owed drive --detach --stay\n(?:warning: [^\n]*\n)*$/, 'a stale lock is no driver');
    rmSync(f.lock, { force: true });
    // Nothing dispatchable (drive.max open attempts): no hint.
    for (const id of ['a', 'b', 'd', 'e']) await ops.dispatch({ cwd: f.cwd, as: parent, node: id });
    await f.put('p7.json', JSON.stringify(nodes('a', 'b', 'c', 'd', 'e', 'g', 'k', 'm')));
    const none = await f.cli(['plan', 'p7.json']);
    assert.equal(none.code, 0, none.stderr); assert.doesNotMatch(none.stdout, /no driver is running/);
  } finally { rmSync(f.lock, { force: true }); await f.done(); }
});

test('H1.3 pi owed_plan: the hint names owed_drive start stay:true; details ready/driver only with the line', { timeout: 60_000 }, async () => {
  const f = await rig(planOf());
  const h = harness(f.cwd);
  try {
    await f.put('p.json', JSON.stringify(planOf(node('a'))));
    const r = await h.call('plan', { plan: 'p.json' });
    assert.notEqual(r.isError, true, r.text);
    assert.match(r.text, /\nready: a \(1\); no driver is running: owed_drive \{action:"start", stay:true\}(?:\nwarning: [^\n]*)*$/);
    assert.deepEqual(r.details.ready, ['a']); assert.equal(r.details.driver, false);
    liveLock(f.lock);
    await f.put('p2.json', JSON.stringify(planOf(node('a'), node('b'))));
    const live = await h.call('plan', { plan: 'p2.json' });
    assert.doesNotMatch(live.text, /no driver is running/, 'a live driver: no hint');
    assert.equal(live.details.ready, undefined); assert.equal(live.details.driver, undefined);
  } finally { rmSync(f.lock, { force: true }); await f.done(); }
});
