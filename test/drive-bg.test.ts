// Background driver and wake-ups (contract D17): `owed drive --detach/--status/--stop`, the exit record of a `--json`
// loop, the pi tool actions and the log follower. Fake dsa only (test/fixtures/fake-dsa.mjs), no real dsa.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owedExtension from '../src/extension.ts';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { Dsa } from '../src/dsa.ts';
import { drive, procStart, reportText } from '../src/drive-run.ts';
import { Follower, classifyLine } from '../src/drive-bg.ts';
import type { Entry } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { identity } from './helpers/surface.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-dsa.mjs', import.meta.url));
const OWED = fileURLToPath(new URL('../bin/owed.js', import.meta.url));
type Json = Record<string, unknown>;
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
/** SIGKILL the process groups of detached drivers a test started (cleanup), then wait for them to go. */
async function reap(pids: number[]): Promise<void> {
  for (const pid of pids) { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
  for (const pid of pids) await until(() => !alive(pid), 5000, `pid ${pid} gone`).catch(() => undefined);
}

const node = (id: string, o: Json = {}) => ({ id, writes: [`${id}.txt`], checks: [], review: { count: 0, min_rank: 1 }, ...o });
const planOf = (...nodes: object[]) => ({ version: 1, trunk: 'main', closure: [], invariants: [], nodes });

async function rig(plan: object) {
  const r = await repo();
  const dir = join(r.root, 'dsa'), bin = join(r.root, 'bin');
  await mkdir(join(dir, 'agents'), { recursive: true }); await mkdir(bin);
  await writeFile(join(bin, 'owed'), `#!/bin/sh\nexec "${process.execPath}" "${OWED}" "$@"\n`); await chmod(join(bin, 'owed'), 0o755);
  const env = { FAKE_DSA_DIR: dir, PATH: `${bin}:${process.env.PATH}`, ...identity };
  await r.put('plan.json', JSON.stringify(plan)); await r.put('README', 'x\n'); await r.commit();
  await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'human' }, channel: 'flag', plan: JSON.stringify(plan) });
  const ledgerDir = process.env.OWED_DIR!;
  const self = {
    ...r, dir, env,
    lock: join(ledgerDir, 'drive.lock'),
    log: join(ledgerDir, 'drive', 'log.jsonl'),
    pids: [] as number[],
    agent: (name: string, body: string) => writeFile(join(dir, 'agents', `${name}.sh`), `set -e\n${body}\n`),
    file: (name: string, text: string) => writeFile(join(dir, name), text),
    entries: async (): Promise<Entry[]> => (await Ledger.open(r.cwd)).read(),
    logLines: (): string[] => readFileSync(self.log, 'utf8').split('\n').filter(Boolean),
    logJson: (): Json[] => self.logLines().map(l => JSON.parse(l) as Json),
    lockPid: (): number | undefined => { try { return (JSON.parse(readFileSync(self.lock, 'utf8')) as { pid: number }).pid; } catch { return undefined; } },
    cli(args: string[], extra: Record<string, string> = {}) {
      return new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
        execFile(process.execPath, [OWED, ...args], { cwd: r.cwd, env: { ...process.env, ...env, OWED_DSA: FAKE, ...extra }, timeout: 60_000 }, (e, stdout, stderr) => {
          const x = e as (Error & { code?: number }) | null;
          resolve({ code: x ? (typeof x.code === 'number' ? x.code : null) : 0, stdout, stderr });
        });
      });
    },
    /** `owed drive --detach`; returns the driver pid (kept for cleanup). */
    async detach(): Promise<{ pid: number; log: string; stdout: string }> {
      const s = await self.cli(['drive', '--detach']);
      assert.equal(s.code, 0, `${s.stdout}\n${s.stderr}`);
      const m = /^driver started: pid (\d+), log (.+)$/m.exec(s.stdout);
      assert.ok(m, s.stdout);
      const pid = Number(m[1]); self.pids.push(pid);
      return { pid, log: m[2]!, stdout: s.stdout };
    },
    async done() { await reap(self.pids); await r.cleanup(); },
  };
  return self;
}
const merged = (es: Entry[], id: string) => es.some(e => e.kind === 'merge' && e.node === id);

/** A fake pi: tools, the /owed command, event handlers and the messages sent to the session. */
function harness(cwd: string) {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, Parameters<ExtensionAPI['registerCommand']>[1]>();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const messages: { message: { customType: string; display: boolean; content: string }; options: unknown }[] = [], notices: string[] = [];
  owedExtension({
    registerTool(t: ToolDefinition) { tools.set(t.name, t); },
    registerCommand(n: string, c: Parameters<ExtensionAPI['registerCommand']>[1]) { commands.set(n, c); },
    on(event: string, h: (event: unknown, ctx: unknown) => unknown) { handlers.set(event, h); return () => undefined; },
    sendMessage(message: { customType: string; display: boolean; content: string }, options: unknown) { messages.push({ message, options }); },
  } as unknown as ExtensionAPI);
  const ctx = { cwd, hasUI: false, ui: { notify(text: string) { notices.push(text); }, async confirm() { return false; } } };
  return {
    tools, commands, handlers, messages, notices, ctx,
    async call(name: string, args: Json = {}) {
      const r = await tools.get(`owed_${name}`)!.execute('t', args, undefined, undefined, ctx as unknown as Parameters<ToolDefinition['execute']>[4]);
      return { ...r, text: (r.content[0] as { text: string }).text };
    },
    async status(): Promise<string> {
      const c = commands.get('owed')!;
      await c.handler('', ctx as unknown as Parameters<typeof c.handler>[1]);
      return notices.at(-1)!;
    },
    emit: async (event: string, payload: Json) => { await handlers.get(event)?.(payload, ctx); },
  };
}
/** Runs fn with process.env extended (the tool spawns the driver with the environment of this process). */
async function withEnv<T>(extra: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const prior = new Map(Object.keys(extra).map(k => [k, process.env[k]]));
  Object.assign(process.env, extra);
  try { return await fn(); }
  finally { for (const [k, v] of prior) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } }
}
const liveLock = (path: string, token = 'test') => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify({ pid: process.pid, start: procStart(process.pid), host: hostname(), at: '2026-10-09T00:00:00.000Z', token }));
};

test('D17.1–4: --detach starts a driver holding the lock and logging JSON lines; a second --detach refuses; --status; --stop → exit record stopped', { timeout: 120_000 }, async () => {
  const f = await rig(planOf(node('x')));   // no agent script: the writer run stays running, the driver keeps waiting
  try {
    const { pid, log } = await f.detach();
    assert.equal(log, f.log);
    assert.equal(f.lockPid(), pid, 'the lock names the detached driver');
    await until(() => f.logJson().some(x => x.do === 'launch' && x.node === 'x'), 30_000, 'the launch line in the log');
    for (const l of f.logLines()) assert.doesNotThrow(() => JSON.parse(l), `a JSON line: ${l}`);
    const again = await f.cli(['drive', '--detach']);
    assert.equal(again.code, 1, again.stdout);
    const logRe = f.log.replace(/[.*+?^$()|[\]\\/{}]/g, '\\$&');
    assert.match(again.stderr, new RegExp(`^Refused: a driver is running for this repository: pid ${pid} on \\S+ since \\S+; log ${logRe}`));
    assert.equal(f.lockPid(), pid, 'the refused --detach did not touch the lock');
    assert.ok(!existsSync(`${f.log}.1`), 'the refused --detach did not rotate the running driver\'s log');
    const st = await f.cli(['drive', '--status']);
    assert.equal(st.code, 0, st.stderr);
    assert.match(st.stdout, new RegExp(`^driver running: pid ${pid} on `));
    assert.match(st.stdout, /launch x writer \S+: applied/);
    const sj = JSON.parse((await f.cli(['drive', '--status', '--json'])).stdout) as Json;
    assert.equal(sj.running, true); assert.equal(sj.pid, pid); assert.equal(sj.log, f.log);
    assert.ok(Array.isArray(sj.tail) && (sj.tail as string[]).length <= 10);
    const stop = await f.cli(['drive', '--stop']);
    assert.equal(stop.code, 0, stop.stderr);
    assert.equal(stop.stdout.trim(), 'stopped');
    assert.ok(!existsSync(f.lock), 'lock released');
    const last = f.logJson().at(-1)!;
    assert.equal(last.event, 'exit'); assert.equal(last.reason, 'stopped'); assert.equal(last.code, 0); assert.match(String(last.at), /^\d{4}-\d\d-\d\dT/);
    assert.equal(f.logJson().at(-2)!.event, 'stopped');
    const after = await f.cli(['drive', '--status']);
    assert.match(after.stdout, /^driver not running\nlast exit: stopped \(exit 0\) at /);
    await until(() => !alive(pid), 5000, 'the driver process ended');
    // A new --detach keeps one old log.
    const second = await f.detach();
    assert.ok(existsSync(`${f.log}.1`) && /"reason":"stopped"/.test(readFileSync(`${f.log}.1`, 'utf8')), 'the previous log is log.jsonl.1');
    assert.equal((await f.cli(['drive', '--stop', '--now'])).stdout.trim(), 'stopped');
    await until(() => !alive(second.pid), 5000, 'the second driver ended');
  } finally { await f.done(); }
});

test('D17.2: a driver that finishes the DAG ends its log with the exit record idle', { timeout: 180_000 }, async () => {
  const f = await rig(planOf(node('i')));
  try {
    await f.agent('i-writer', 'echo i > i.txt; git add i.txt; git commit -qm i; owed submit i');
    const { pid } = await f.detach();
    await until(() => f.logJson().at(-1)?.event === 'exit', 120_000, 'the exit record');
    const lines = f.logJson(), last = lines.at(-1)!;
    assert.equal(last.reason, 'idle', JSON.stringify(lines)); assert.equal(last.code, 0);
    assert.equal(lines.at(-2)!.event, 'idle');
    assert.ok(lines.some(x => x.do === 'merge' && x.outcome === 'merged'));
    assert.ok(merged(await f.entries(), 'i'));
    assert.ok(!existsSync(f.lock));
    const st = await f.cli(['drive', '--status']);
    assert.match(st.stdout, /^driver not running\nlast exit: idle \(exit 0\) at /);
    assert.match(st.stdout, /merge i: merged/);
    assert.match(st.stdout, /driver exited 0 \(idle\)/);
    await until(() => !alive(pid), 5000, 'the driver process ended');
  } finally { await f.done(); }
});

test('D17.3/4: --stop with no driver; a SIGKILLed driver is not running and left no exit record', { timeout: 120_000 }, async () => {
  const f = await rig(planOf(node('y')));
  try {
    const none = await f.cli(['drive', '--stop']);
    assert.equal(none.code, 0, none.stderr); assert.equal(none.stdout.trim(), 'no driver running');
    const fresh = await f.cli(['drive', '--status']);
    assert.equal(fresh.code, 0); assert.match(fresh.stdout, /^driver not running\n/); assert.doesNotMatch(fresh.stdout, /exit record/);
    const { pid } = await f.detach();
    await until(() => f.logJson().some(x => x.do === 'launch'), 30_000, 'the launch line');
    process.kill(pid, 'SIGKILL');
    await until(() => !alive(pid), 10_000, 'the killed driver gone');
    assert.ok(existsSync(f.lock), 'SIGKILL leaves the (stale) lock');
    const st = await f.cli(['drive', '--status']);
    assert.equal(st.code, 0, st.stderr);
    assert.match(st.stdout, /^driver not running; it ended without an exit record/);
    const sj = JSON.parse((await f.cli(['drive', '--status', '--json'])).stdout) as Json;
    assert.equal(sj.running, false); assert.equal(sj.noExitRecord, true); assert.equal(sj.exit, undefined);
    const stop = await f.cli(['drive', '--stop']);
    assert.equal(stop.code, 0); assert.equal(stop.stdout.trim(), 'no driver running', 'a stale lock is no driver; nothing is signaled');
    // A stale lock does not block a new background driver.
    const next = await f.detach();
    assert.equal(f.lockPid(), next.pid);
    assert.equal((await f.cli(['drive', '--stop'])).stdout.trim(), 'stopped');
  } finally { await f.done(); }
});

test('D17.4: --stop refuses a lock of another host and never signals a pid whose start time differs', { timeout: 60_000 }, async () => {
  const f = await rig(planOf(node('w')));
  try {
    writeFileSync(f.lock, JSON.stringify({ pid: process.pid, start: procStart(process.pid), host: 'elsewhere.example', at: 'then', token: 'x' }));
    const foreign = await f.cli(['drive', '--stop']);
    assert.equal(foreign.code, 1); assert.match(foreign.stderr, /^Refused: .*held by pid \d+ on host elsewhere\.example/);
    // This test process with a wrong start time: a reused pid, not the driver: nothing is signaled (we would die).
    writeFileSync(f.lock, JSON.stringify({ pid: process.pid, start: '1', host: hostname(), at: 'then', token: 'y' }));
    const reused = await f.cli(['drive', '--stop']);
    assert.equal(reused.code, 0); assert.equal(reused.stdout.trim(), 'no driver running');
    const st = await f.cli(['drive', '--status']);
    assert.match(st.stdout, /^driver not running/);
  } finally { rmSync(f.lock, { force: true }); await f.done(); }
});

test('D17.5: --detach, --status, --stop and --once are exclusive; --now only with --stop; --max not with --status/--stop', { timeout: 60_000 }, async () => {
  const f = await rig(planOf(node('z')));
  try {
    for (const args of [['--detach', '--once'], ['--status', '--stop'], ['--once', '--stop'], ['--detach', '--status'], ['--now'], ['--detach', '--now'], ['--status', '--now'], ['--status', '--max', '2'], ['--stop', '--max', '2'], ['--detach', '--max', '0'], ['--detach', '--as', 'parent:x']]) {
      const r = await f.cli(['drive', ...args]);
      assert.equal(r.code, 2, `drive ${args.join(' ')}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /^Usage error: /);
    }
    assert.equal((await f.cli(['status', '--detach'])).code, 2, 'drive flags only for drive');
    assert.ok(!existsSync(f.lock) && !existsSync(f.log), 'a refused combination starts nothing');
    const sj = await f.cli(['drive', '--status', '--json']);
    assert.equal(sj.code, 0, sj.stderr); assert.equal((JSON.parse(sj.stdout) as Json).running, false);
    assert.match((await f.cli(['--help'])).stdout, /drive --detach \[--max N\] \| drive --status \| drive --stop \[--now\]/);
  } finally { await f.done(); }
});

test('D17.2/3: a --json loop ends with an exit record (stopped; error for a refused lock); reportText is the text-mode line', { timeout: 120_000 }, async () => {
  const f = await rig(planOf(node('j')));
  try {
    const dsa = new Dsa({ bin: FAKE, env: f.env, timeoutMs: 60_000 });
    const lines: string[] = [], ac = new AbortController(), timer = setTimeout(() => ac.abort(), 1500);
    const code = await drive({ cwd: f.cwd, json: true, dsa, log: l => lines.push(l), pollMs: 50, passMs: 300, handleSignals: false, signal: ac.signal });
    clearTimeout(timer);
    assert.equal(code, 0);
    const objs = lines.map(l => JSON.parse(l) as Json);
    assert.deepEqual([objs.at(-2)!.event, objs.at(-1)!.event, objs.at(-1)!.reason, objs.at(-1)!.code], ['stopped', 'exit', 'stopped', 0]);
    assert.equal(objs.filter(x => x.event === 'exit').length, 1, 'one exit record, the last line');
    // Text mode prints reportText of the JSON objects (Driver.emit uses it; the loop events keep their lines).
    assert.equal(reportText({ event: 'idle' }), 'idle: nothing open and nothing ready');
    assert.equal(reportText({ event: 'stopped' }), 'stopped');
    assert.equal(reportText({ event: 'killed' }), 'killed: second signal, stopped at once');
    assert.equal(reportText({ event: 'cursor-reset', head: 'h:3' }), 'events: cursor expired, reset to h:3');
    assert.equal(reportText({ event: 'cursor-reset', reason: 'bad\ncursor', head: 'h:4' }), 'events: cursor rejected (bad\\ncursor), reset to h:4');
    assert.equal(reportText({ event: 'events-error', error: 'boom' }), 'events error: boom');
    assert.equal(reportText({ event: 'exit', code: 1, reason: 'error', error: 'locked' }), 'driver exited 1 (error): locked');
    assert.equal(reportText({ do: 'launch', node: 'a', outcome: 'applied', role: 'writer', rid: 'r1', detail: 'created' }), 'launch a writer r1: applied — created');
    assert.equal(reportText({ do: 'notify', node: 'a', outcome: 'notify', text: 'a asks' }), 'a asks');
    assert.equal(reportText({ do: 'halt', node: 'a', outcome: 'halted', attempt: 2, needs: 'owner', detail: 'why' }), 'halt a attempt 2 (needs owner): halted — why');
    // A refused lock is an exit record with the refusal text and exit code 1, not a throw.
    liveLock(f.lock);
    const refused: string[] = [];
    const rc = await drive({ cwd: f.cwd, json: true, dsa, log: l => refused.push(l), handleSignals: false });
    assert.equal(rc, 1);
    assert.equal(refused.length, 1);
    const rec = JSON.parse(refused[0]!) as Json;
    assert.equal(rec.event, 'exit'); assert.equal(rec.reason, 'error'); assert.equal(rec.code, 1);
    assert.match(String(rec.error), /another owed drive is running/);
    // Text mode and --once keep throwing (no exit record).
    await assert.rejects(drive({ cwd: f.cwd, once: true, json: true, dsa, log: () => undefined }), /another owed drive is running/);
    await assert.rejects(drive({ cwd: f.cwd, dsa, log: () => undefined, handleSignals: false }), /another owed drive is running/);
  } finally { rmSync(f.lock, { force: true }); await f.done(); }
});

test('D17.7: Follower: no replay, quiet lines do not wake, merges ride along, an identical wake is not repeated, partial lines wait, terminal stops', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owed-follow-')), log = join(dir, 'log.jsonl');
  const put = (...lines: (Json | string)[]) => appendFileSync(log, lines.map(l => typeof l === 'string' ? `${l}\n` : `${JSON.stringify(l)}\n`).join(''));
  try {
    put({ do: 'notify', node: 'old', outcome: 'notify', text: 'old question' });
    const got: string[] = [];
    const f = new Follower({ log, repo: '/r', pid: process.pid, start: procStart(process.pid), deliver: c => got.push(c) });
    assert.equal(f.tick(), undefined, 'lines before the follower started are not replayed');
    put({ do: 'dispatch', node: 'a', outcome: 'done', detail: 'attempt 1' }, { do: 'launch', node: 'a', outcome: 'applied', role: 'writer', rid: 'r1', detail: 'created' },
      { do: 'attest', node: 'a', outcome: 'done', detail: 'accepted' }, { do: 'attest', node: 'a', outcome: 'busy', detail: 'x' }, { do: 'send', node: 'a', outcome: 'applied', rid: 'r1', sendKind: 'follow-up', reason: 'repair' },
      { event: 'cursor-reset', head: 'h:1' }, { do: 'launch', node: 'a', outcome: 'pending', role: 'writer', rid: 'r1' });
    assert.equal(f.tick(), undefined, 'dispatch/launch/attest/send/cursor-reset do not wake');
    put({ do: 'merge', node: 'a', outcome: 'merged', detail: 'trunk abc' });
    assert.equal(f.tick(), undefined, 'a merge alone does not wake');
    put({ do: 'notify', node: 'b', outcome: 'notify', text: 'b: writer run r2 asks (qid q1-1, rev 1): which db?' });
    const m1 = f.tick()!;
    assert.deepEqual(m1.split('\n'), ['owed drive (/r):', 'merge a: merged — trunk abc', 'b: writer run r2 asks (qid q1-1, rev 1): which db?', 'Next: owed status / owed why <node>']);
    put({ do: 'notify', node: 'b', outcome: 'notify', text: 'b: writer run r2 asks (qid q1-1, rev 1): which db?' });
    assert.equal(f.tick(), undefined, 'an identical notify is not re-delivered');
    appendFileSync(log, '{"do":"halt","node":"c","outcome":"halted","attempt":1,"needs":"hu');
    assert.equal(f.tick(), undefined, 'an incomplete line waits');
    appendFileSync(log, 'man","detail":"stalled: x"}\n');
    assert.match(f.tick()!, /\nhalt c attempt 1 \(needs human\): halted — stalled: x\n/);
    put({ do: 'launch', node: 'd', outcome: 'rejected', role: 'writer', rid: 'r3', detail: 'fault; halted' });
    assert.match(f.tick()!, /launch d writer r3: rejected — fault; halted/);
    put('Refused: something odd');
    assert.match(f.tick()!, /\nRefused: something odd\n/);
    put({ event: 'events-error', error: 'dsa: not found' });
    assert.match(f.tick()!, /events error: dsa: not found/);
    put({ do: 'merge', node: 'e', outcome: 'merged', detail: 'trunk def' }, { event: 'stopped' }, { event: 'exit', code: 0, reason: 'stopped', at: '2026-10-09T00:00:00.000Z' });
    const last = f.tick()!;
    assert.match(last, /merge e: merged — trunk def\nstopped\ndriver exited 0 \(stopped\)\n/);
    assert.equal(f.stopped, true, 'a terminal line stops the follower');
    put({ do: 'halt', node: 'f', outcome: 'halted', attempt: 1, needs: 'human' });
    assert.equal(f.tick(), undefined);
    assert.equal(got.length, 6);
    // A driver pid that is gone without an exit record.
    const g: string[] = [], dead = 2 ** 22 + 11;
    const h = new Follower({ log, repo: '/r', pid: dead, deliver: c => g.push(c) });
    const m = h.tick()!;
    assert.match(m, new RegExp(`driver pid ${dead} ended without an exit record`));
    assert.equal(h.stopped, true); assert.equal(g.length, 1);
    // Classification of the halting outcomes.
    for (const outcome of ['rejected', 'conflict', 'refused', 'error']) assert.equal(classifyLine(JSON.stringify({ do: 'merge', node: 'a', outcome })).kind, 'wake', outcome);
    for (const event of ['exit', 'killed', 'stopped', 'idle']) assert.equal(classifyLine(JSON.stringify({ event })).kind, 'terminal', event);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('D17.6/7: the tool starts the driver; it wakes once for the halt and once at exit with the merge listed; launch/attest lines do not wake', { timeout: 180_000 }, async () => {
  const f = await rig(planOf(node('k'), node('m')));
  const h = harness(f.cwd);
  try {
    await f.file('faults', 'run 1 none\n');   // k launches first (status order): dsa rejects it → halt
    await f.agent('m-writer', 'sleep 5; echo m > m.txt; git add m.txt; git commit -qm m; owed submit m');
    assert.match(h.tools.get('owed_drive')!.description, /action start/);
    assert.match(h.tools.get('owed_drive')!.description, /do not poll/);
    assert.equal((await h.call('drive', { action: 'status', now: true })).isError, true, 'now only with stop');
    assert.equal((await h.call('drive', { action: 'stop', max: 2 })).isError, true, 'max not with stop');
    const start = await withEnv({ ...f.env, OWED_DSA: FAKE }, () => h.call('drive', { action: 'start' }));
    assert.notEqual(start.isError, true, start.text);
    const pid = Number(/^driver started: pid (\d+), log /.exec(start.text)?.[1]);
    assert.ok(pid > 0, start.text); f.pids.push(pid);
    assert.match(start.text, /do not poll status/);
    await until(() => h.messages.length >= 1, 60_000, 'the halt wake');
    const first = h.messages[0]!;
    assert.equal(first.message.customType, 'owed-drive'); assert.equal(first.message.display, true);
    assert.deepEqual(first.options, { triggerTurn: true, deliverAs: 'followUp' });
    assert.match(first.message.content, /^owed drive \(.+\):\n/);
    assert.match(first.message.content, /launch k writer \S+: rejected — fault; halted/);
    assert.doesNotMatch(first.message.content, /launch m |dispatch |attest |merge /);
    assert.match(first.message.content, /\nNext: owed status \/ owed why <node>$/);
    await until(async () => merged(await f.entries(), 'm'), 90_000, 'm merged');
    await sleepMs(2500);
    assert.equal(h.messages.length, 1, 'the merge alone did not wake');
    const status = await h.call('drive', { action: 'status' });
    assert.match(status.text, new RegExp(`^driver running: pid ${pid} `));
    const fakeDsa = { OWED_DSA: FAKE, FAKE_DSA_DIR: f.dir };   // /owed also describes live runs: never the real dsa
    assert.match(await withEnv(fakeDsa, () => h.status()), new RegExp(`\\nDriver: running pid ${pid} since `));
    const stop = await h.call('drive', { action: 'stop' });
    assert.equal(stop.text, 'stopped');
    await until(() => h.messages.length >= 2, 15_000, 'the exit wake');
    const second = h.messages[1]!.message.content;
    assert.match(second, /merge m: merged/);
    assert.match(second, /\nstopped\n/);
    assert.match(second, /driver exited 0 \(stopped\)/);
    assert.doesNotMatch(second, /launch m |attest m|launch k /);
    await sleepMs(4500);
    assert.equal(h.messages.length, 2, 'the follower stopped after the exit');
    assert.match(await withEnv(fakeDsa, () => h.status()), /\nDriver: not running \(last exit stopped at /);
  } finally { await h.emit('session_shutdown', { type: 'session_shutdown', reason: 'quit' }); await f.done(); }
});

test('D17.7/8: session_start follows a live driver without replaying old lines; session_shutdown stops the follower', { timeout: 60_000 }, async () => {
  const f = await rig(planOf(node('s')));
  const h = harness(f.cwd);
  try {
    mkdirSync(join(f.log, '..'), { recursive: true });
    appendFileSync(f.log, `${JSON.stringify({ do: 'notify', node: 'old', outcome: 'notify', text: 'old question' })}\n`);
    liveLock(f.lock);   // this test process plays the live driver
    await h.emit('session_start', { type: 'session_start', reason: 'startup' });
    await sleepMs(2500);
    assert.equal(h.messages.length, 0, 'old lines are not replayed');
    appendFileSync(f.log, `${JSON.stringify({ do: 'halt', node: 's', outcome: 'halted', attempt: 1, needs: 'owner', detail: 'new reason' })}\n`);
    await until(() => h.messages.length >= 1, 8000, 'the wake for the new line');
    const c = h.messages[0]!.message.content;
    assert.match(c, /halt s attempt 1 \(needs owner\): halted — new reason/);
    assert.doesNotMatch(c, /old question/);
    // A second session_start for the same driver keeps the one follower (no duplicate message).
    await h.emit('session_start', { type: 'session_start', reason: 'reload' });
    appendFileSync(f.log, `${JSON.stringify({ do: 'notify', node: 's', outcome: 'notify', text: 'second' })}\n`);
    await until(() => h.messages.length >= 2, 8000, 'the second wake');
    await sleepMs(2500);
    assert.equal(h.messages.length, 2, 'one follower per repository');
    assert.match(await h.status(), new RegExp(`\\nDriver: running pid ${process.pid} since `));
    await h.emit('session_shutdown', { type: 'session_shutdown', reason: 'quit' });
    appendFileSync(f.log, `${JSON.stringify({ do: 'notify', node: 's', outcome: 'notify', text: 'after shutdown' })}\n`);
    await sleepMs(4500);
    assert.equal(h.messages.length, 2, 'no follower after session_shutdown');
    rmSync(f.lock, { force: true });
    assert.match(await h.status(), /\nDriver: not running \(ended without an exit record\)/);
    // No lock: session_start follows nothing.
    const h2 = harness(f.cwd);
    await h2.emit('session_start', { type: 'session_start', reason: 'startup' });
    appendFileSync(f.log, `${JSON.stringify({ do: 'notify', node: 's', outcome: 'notify', text: 'nobody follows' })}\n`);
    await sleepMs(2500);
    assert.equal(h2.messages.length, 0);
  } finally { rmSync(f.lock, { force: true }); await h.emit('session_shutdown', { type: 'session_shutdown', reason: 'quit' }); await f.done(); }
});
