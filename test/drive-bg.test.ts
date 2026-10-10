// Background driver and wake-ups (contract D17): `owed drive --detach/--status/--stop`, the exit record of a `--json`
// loop, the pi tool actions and the log follower. Fake dsa only (test/fixtures/fake-dsa.mjs), no real dsa.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { hostname, tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owedExtension from '../src/extension.ts';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { Dsa } from '../src/dsa.ts';
import { drive, procStart, reportText } from '../src/drive-run.ts';
import { Follower, classifyLine, driveStart, driveStop, haltHintText, renderDriveStart } from '../src/drive-bg.ts';
import type { Entry } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { identity } from './helpers/surface.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-dsa.mjs', import.meta.url));
const OWED = fileURLToPath(new URL('../bin/owed.js', import.meta.url));
const SHUTDOWN_CHILD = fileURLToPath(new URL('./fixtures/shutdown-child.ts', import.meta.url));
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
    cli(args: string[], extra: Record<string, string> = {}, cwd: string = r.cwd) {
      return new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
        execFile(process.execPath, [OWED, ...args], { cwd, env: { ...process.env, ...env, OWED_DSA: FAKE, ...extra }, timeout: 60_000 }, (e, stdout, stderr) => {
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
    async call(name: string, args: Json = {}, signal?: AbortSignal) {
      const r = await tools.get(`owed_${name}`)!.execute('t', args, signal, undefined, ctx as unknown as Parameters<ToolDefinition['execute']>[4]);
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
/** session_start as a top-level session (not inside a dsa call; the test itself may run under a dsa hold). */
const topLevelStart = (h: ReturnType<typeof harness>) => withEnv({ DSA_EXEC: '', DSA_CALL: '' }, () => h.emit('session_start', { type: 'session_start', reason: 'startup' }));
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
    // Stop once the launch line is out (an event, not a timer); the writer run stays running, so the loop would go on.
    const lines: string[] = [], ac = new AbortController();
    const code = await drive({ cwd: f.cwd, json: true, dsa, log: l => { lines.push(l); if (/"do":"launch"/.test(l)) ac.abort(); }, pollMs: 50, passMs: 300, handleSignals: false, signal: ac.signal });
    assert.equal(code, 0);
    assert.ok(lines.some(l => /"do":"launch"/.test(l)), lines.join('\n'));
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
    assert.equal(reportText({ do: 'halt', node: 'a', outcome: 'halted', attempt: 2, needs: 'owner', detail: 'why' }), 'halt a attempt 2, needs the owner (the main agent decides; owed lists the command): halted — why');
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
    assert.match(f.tick() ?? '', /\nb: writer run r2 asks \(qid q1-1, rev 1\): which db\?\n/, 'no dedupe across reads (D17a.5): the same line in a later read wakes again');
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
    assert.equal(got.length, 7);
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
  const h = harness(f.cwd), gate = join(f.root, 'gate-m');
  try {
    await f.file('faults', 'run 1 none\n');   // k launches first (status order): dsa rejects it → halt
    // m's writer (run synchronously inside the driver's `run` call) waits for the gate, which the test opens only after
    // it saw the halt wake: the merge of m cannot reach the log before that message, whatever the timing.
    await f.agent('m-writer', `while [ ! -e '${gate}' ]; do sleep 0.1; done\necho m > m.txt; git add m.txt; git commit -qm m; owed submit m`);
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
    assert.ok(!f.logLines().some(l => /"do":"merge"/.test(l)), 'the gate holds m back');
    writeFileSync(gate, '');
    await until(async () => merged(await f.entries(), 'm'), 90_000, 'm merged');
    await until(() => f.logJson().some(x => x.do === 'merge' && x.outcome === 'merged'), 30_000, 'the merge line in the log');
    await sleepMs(2500);   // more than one follower interval (2 s): a wrong wake on the merge would have arrived
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
  } finally { writeFileSync(gate, ''); await h.emit('session_shutdown', { type: 'session_shutdown', reason: 'quit' }); await f.done(); }
});

test('D17.7/8: session_start follows a live driver without replaying old lines; session_shutdown stops the follower', { timeout: 60_000 }, async () => {
  const f = await rig(planOf(node('s')));
  const h = harness(f.cwd), witness = harness(f.cwd), late = harness(f.cwd);
  const line = (o: Json) => appendFileSync(f.log, `${JSON.stringify(o)}\n`);
  try {
    mkdirSync(join(f.log, '..'), { recursive: true });
    line({ do: 'notify', node: 'old', outcome: 'notify', text: 'old question' });
    liveLock(f.lock);   // this test process plays the live driver
    await topLevelStart(h);
    line({ do: 'halt', node: 's', outcome: 'halted', attempt: 1, needs: 'owner', detail: 'new reason' });
    await until(() => h.messages.length >= 1, 8000, 'the wake for the new line');
    const c = h.messages[0]!.message.content;
    assert.match(c, /halt s attempt 1, needs the owner \(the main agent decides; owed lists the command\): halted — new reason/);
    assert.doesNotMatch(c, /old question/, 'lines before the attach are not replayed');
    // A second session_start for the same driver keeps the one follower (no duplicate message).
    await topLevelStart(h);
    line({ do: 'notify', node: 's', outcome: 'notify', text: 'second' });
    await until(() => h.messages.length >= 2, 8000, 'the second wake');
    await sleepMs(2500);   // after the positive: a second follower would have delivered a duplicate by now
    assert.equal(h.messages.length, 2, 'one follower per repository');
    assert.match(await h.status(), new RegExp(`\\nDriver: running pid ${process.pid} since `));
    // After shutdown: a witness session (still attached) is woken by the next line, h is not.
    await topLevelStart(witness);
    await h.emit('session_shutdown', { type: 'session_shutdown', reason: 'quit' });
    line({ do: 'notify', node: 's', outcome: 'notify', text: 'after shutdown' });
    await until(() => witness.messages.some(m => /after shutdown/.test(m.message.content)), 8000, 'the witness wake');
    await sleepMs(2500);
    assert.equal(h.messages.length, 2, 'no follower after session_shutdown');
    rmSync(f.lock, { force: true });
    assert.match(await h.status(), /\nDriver: not running \(ended without an exit record\)/);
    // No lock: session_start follows nothing (the witness, attached before, shows the line was there to read).
    await topLevelStart(late);
    line({ do: 'notify', node: 's', outcome: 'notify', text: 'nobody follows' });
    await until(() => witness.messages.some(m => /nobody follows/.test(m.message.content)), 8000, 'the witness wake');
    await sleepMs(2500);
    assert.equal(late.messages.length, 0);
  } finally {
    rmSync(f.lock, { force: true });
    for (const x of [h, witness, late]) await x.emit('session_shutdown', { type: 'session_shutdown', reason: 'quit' });
    await f.done();
  }
});

test('D17 (A): the detached driver carries no dsa call identity (DSA_EXEC/DSA_CALL removed, DSA_HOME kept); started inside a dsa call it says so', { timeout: 120_000 }, async () => {
  const f = await rig(planOf(node('q')));   // no agent script: the writer run stays running
  const home = join(f.root, 'dsa-home');
  const note = "note: started from inside a dsa call; if that call's processes are contained, the driver may end with it — prefer starting it from a top-level session or systemd-run --user";
  const environ = (pid: number): string[] => readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean);
  try {
    // In process (the tool's path).
    const r = await withEnv({ ...f.env, OWED_DSA: FAKE, DSA_EXEC: 'exec-1', DSA_CALL: 'call-1', DSA_HOME: home }, () => driveStart({ cwd: f.cwd }));
    f.pids.push(r.pid);
    assert.equal(r.fromDsa, true);
    const env = environ(r.pid);
    assert.ok(!env.some(e => e.startsWith('DSA_EXEC=') || e.startsWith('DSA_CALL=')), env.filter(e => e.startsWith('DSA_')).join(' '));
    assert.ok(env.includes(`DSA_HOME=${home}`), 'DSA_HOME is kept');
    assert.ok(env.includes(`FAKE_DSA_DIR=${f.dir}`), 'the rest of the environment is inherited');
    assert.equal(renderDriveStart(r), `driver started: pid ${r.pid}, log ${f.log}\n${note}`);
    assert.equal((await driveStop({ cwd: f.cwd })).state, 'stopped');
    // The CLI prints the same note; its driver has no call identity either.
    const c = await f.cli(['drive', '--detach'], { DSA_EXEC: 'exec-2', DSA_CALL: 'call-2', DSA_HOME: home });
    assert.equal(c.code, 0, c.stderr);
    const pid = Number(/^driver started: pid (\d+), log /m.exec(c.stdout)?.[1]);
    assert.ok(pid > 0, c.stdout); f.pids.push(pid);
    assert.ok(c.stdout.trimEnd().endsWith(`\n${note}`), c.stdout);
    const env2 = environ(pid);
    assert.ok(!env2.some(e => e.startsWith('DSA_EXEC=') || e.startsWith('DSA_CALL=')));
    assert.ok(env2.includes(`DSA_HOME=${home}`));
    assert.equal((await f.cli(['drive', '--stop'])).stdout.trim(), 'stopped');
    // Outside a dsa call: no note (DSA_EXEC empty: the test itself may run under a dsa hold).
    const plain = await f.cli(['drive', '--detach'], { DSA_EXEC: '' });
    assert.equal(plain.code, 0, plain.stderr);
    const pid3 = Number(/^driver started: pid (\d+), log /m.exec(plain.stdout)?.[1]);
    assert.ok(pid3 > 0, plain.stdout); f.pids.push(pid3);
    assert.doesNotMatch(plain.stdout, /note:/);
    assert.equal((await f.cli(['drive', '--stop'])).stdout.trim(), 'stopped');
  } finally { await f.done(); }
});

test('D17 (B): owed_drive action once passes the tool abort signal: an aborted call stops after the current action', { timeout: 120_000 }, async () => {
  const f = await rig(planOf(node('u'), node('v')));
  const h = harness(f.cwd), mark = join(f.root, 'u-started'), gate = join(f.root, 'gate-u');
  const fake = { ...f.env, OWED_DSA: FAKE };
  try {
    // u's writer runs inside the driver's `run` call: it marks that it started, then waits for the gate.
    await f.agent('u-writer', `touch '${mark}'\nwhile [ ! -e '${gate}' ]; do sleep 0.1; done`);
    const pre = new AbortController(); pre.abort();
    const none = await withEnv(fake, () => h.call('drive', {}, pre.signal));
    assert.equal(none.text, 'nothing to do', 'an already aborted call executes no action');
    assert.equal((await f.entries()).filter(e => e.kind === 'dispatch').length, 0);
    const p1 = await withEnv(fake, () => h.call('drive', {}));
    assert.match(p1.text, /^dispatch u: done/m); assert.match(p1.text, /^dispatch v: done/m);
    // The next pass launches u (blocked on the gate), then v. Abort while u's launch runs, then open the gate.
    const ac = new AbortController();
    const p2 = withEnv(fake, () => h.call('drive', {}, ac.signal));
    await until(() => existsSync(mark), 60_000, "u's writer started");
    ac.abort();
    writeFileSync(gate, '');
    const r = await p2;
    assert.notEqual(r.isError, true, r.text);
    const lines = r.text.split('\n');
    assert.equal(lines.length, 1, r.text);
    assert.match(lines[0]!, /^launch u writer \S+: applied — created$/);
    const launches = (await f.entries()).filter(e => e.kind === 'launch') as Extract<Entry, { kind: 'launch' }>[];
    assert.deepEqual(launches.map(l => l.node), ['u'], 'v was not launched after the abort');
    assert.ok(!existsSync(f.lock), 'the pass released the lock');
  } finally { writeFileSync(gate, ''); await f.done(); }
});

// ---------- D17a ----------
const startedPid = (stdout: string): number => Number(/^driver started: pid (\d+), log /m.exec(stdout)?.[1]);
const environOf = (pid: number): string[] => readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean);

test('D17a.3: concurrent --detach calls are serialized (one driver, the other refuses, no rotation); concurrent --stop sends one signal', { timeout: 120_000 }, async () => {
  const f = await rig(planOf(node('cc')));   // the writer run stays running
  try {
    const both = await Promise.all([f.cli(['drive', '--detach']), f.cli(['drive', '--detach'])]);
    const ok = both.filter(r => r.code === 0), refused = both.filter(r => r.code === 1);
    assert.equal(ok.length, 1, both.map(r => r.stdout + r.stderr).join('\n---\n'));
    assert.equal(refused.length, 1, both.map(r => r.stdout + r.stderr).join('\n---\n'));
    const pid = startedPid(ok[0]!.stdout); f.pids.push(pid);
    assert.match(refused[0]!.stderr, new RegExp(`^Refused: a driver is running for this repository: pid ${pid} `));
    assert.equal(f.lockPid(), pid);
    assert.ok(!existsSync(`${f.log}.1`), 'the refused --detach did not rotate the log under the driver');
    await until(() => f.logJson().some(x => x.do === 'launch'), 30_000, 'the launch line');
    for (const l of f.logLines()) assert.doesNotThrow(() => JSON.parse(l), l);
    const stops = await Promise.all([f.cli(['drive', '--stop']), f.cli(['drive', '--stop'])]);
    assert.deepEqual(stops.map(r => r.stdout.trim()).sort(), ['no driver running', 'stopped'], stops.map(r => r.stdout + r.stderr).join('\n'));
    const lines = f.logJson();
    assert.deepEqual([lines.at(-1)!.event, lines.at(-1)!.reason], ['exit', 'stopped']);
    assert.equal(lines.filter(x => x.event === 'killed').length, 0, 'one SIGTERM: no second-signal stop');
    assert.equal(lines.filter(x => x.event === 'stopped').length, 1);
  } finally { await f.done(); }
});

test('D17a.3: --stop refuses a lock without a process start time and signals nothing', { timeout: 60_000 }, async () => {
  const f = await rig(planOf(node('ns')));
  try {
    // This test process as the "driver" without start time: a signal would end this test.
    writeFileSync(f.lock, JSON.stringify({ pid: process.pid, host: hostname(), at: 'then', token: 'n' }));
    const r = await f.cli(['drive', '--stop']);
    assert.equal(r.code, 1, r.stdout);
    assert.match(r.stderr, new RegExp(`^Refused: cannot verify that pid ${process.pid} is the driver`));
    assert.ok(existsSync(f.lock), 'the lock is left alone');
    const now = await f.cli(['drive', '--stop', '--now']);
    assert.equal(now.code, 1);
  } finally { rmSync(f.lock, { force: true }); await f.done(); }
});

test('D17a.2: the killed path (--stop --now while an action runs) ends the log with exit record killed before the lock is released', { timeout: 120_000 }, async () => {
  const f = await rig(planOf(node('kk')));
  const mark = join(f.root, 'kk-started'), gate = join(f.root, 'gate-kk');
  try {
    // The writer run blocks inside the driver's dsa call until the gate opens: the first SIGTERM cannot end the loop.
    await f.agent('kk-writer', `touch '${mark}'\nwhile [ ! -e '${gate}' ]; do sleep 0.1; done`);
    const { pid } = await f.detach();
    await until(() => existsSync(mark), 60_000, 'the writer run started');
    const s = await f.cli(['drive', '--stop', '--now']);
    assert.equal(s.code, 0, s.stderr);
    assert.equal(s.stdout.trim(), 'stopped');
    // `stopped` means the lock was released, and the record precedes the release: it is in the log now.
    assert.ok(!existsSync(f.lock));
    const lines = f.logJson();
    assert.deepEqual([lines.at(-2)!.event, lines.at(-1)!.event, lines.at(-1)!.reason, lines.at(-1)!.code], ['killed', 'exit', 'killed', 130]);
    await until(() => !alive(pid), 5000, 'the driver ended');
  } finally { writeFileSync(gate, ''); await f.done(); }
});

test('D17a (OWED_DIR): a relative OWED_DIR reaches the detached driver as an absolute path', { timeout: 120_000 }, async () => {
  const f = await rig(planOf(node('od')));
  try {
    const abs = process.env.OWED_DIR!, sub = join(f.cwd, 'sub');
    mkdirSync(sub);
    const rel = relative(sub, abs);
    assert.ok(!rel.startsWith('/'), rel);
    const s = await f.cli(['drive', '--detach'], { OWED_DIR: rel }, sub);
    assert.equal(s.code, 0, s.stderr);
    const pid = startedPid(s.stdout); f.pids.push(pid);
    assert.equal(f.lockPid(), pid, 'the driver took the lock in the same ledger dir');
    const given = environOf(pid).find(e => e.startsWith('OWED_DIR='))?.slice('OWED_DIR='.length);
    assert.ok(given && given.startsWith('/'), `absolute: ${given}`);
    assert.equal(realpathSync(given), realpathSync(abs));
    assert.equal((await f.cli(['drive', '--stop'])).stdout.trim(), 'stopped');
  } finally { await f.done(); }
});

test('D17a.1: a session inside a dsa call does not auto-attach; a top-level session does', { timeout: 60_000 }, async () => {
  const f = await rig(planOf(node('da')));
  const sub = harness(f.cwd), top = harness(f.cwd);
  try {
    mkdirSync(dirname(f.log), { recursive: true }); writeFileSync(f.log, '');
    liveLock(f.lock);
    await withEnv({ DSA_EXEC: 'exec-x', DSA_CALL: 'call-x' }, () => sub.emit('session_start', { type: 'session_start', reason: 'startup' }));
    await withEnv({ DSA_EXEC: '', DSA_CALL: 'call-only' }, () => sub.emit('session_start', { type: 'session_start', reason: 'reload' }));
    await topLevelStart(top);
    appendFileSync(f.log, `${JSON.stringify({ do: 'halt', node: 'da', outcome: 'halted', attempt: 1, needs: 'human', detail: 'x' })}\n`);
    await until(() => top.messages.length >= 1, 8000, 'the top-level wake');
    await sleepMs(2500);   // after the positive: a follower of the dsa session would have delivered by now
    assert.equal(sub.messages.length, 0, 'no wake-ups injected into a dsa subagent session');
  } finally {
    rmSync(f.lock, { force: true });
    for (const x of [sub, top]) await x.emit('session_shutdown', { type: 'session_shutdown', reason: 'quit' });
    await f.done();
  }
});

test('D17a.5: the same halt text in two reads wakes twice; identical lines within one read collapse', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owed-follow-')), log = join(dir, 'log.jsonl');
  const halt = JSON.stringify({ do: 'halt', node: 'h', outcome: 'halted', attempt: 1, needs: 'human', detail: 'dsa rejected run r; this attempt\'s request is fixed' });
  try {
    writeFileSync(log, '');
    const got: string[] = [];
    const f = new Follower({ log, repo: '/r', pid: process.pid, start: procStart(process.pid), deliver: c => got.push(c) });
    appendFileSync(log, `${halt}\n`);
    assert.match(f.tick()!, /halt h attempt 1/);
    appendFileSync(log, `${halt}\n`);
    assert.match(f.tick() ?? '', /halt h attempt 1/, 'a re-halt with the same text wakes again');
    appendFileSync(log, `${halt}\n${halt}\n`);
    const m = f.tick()!;
    assert.equal(m.split('\n').filter(l => /^halt h attempt 1/.test(l)).length, 1, m);
    assert.equal(got.length, 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('D17a.4: a log replaced by rotation (new dev/ino, not shorter) is read from its start', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owed-follow-')), log = join(dir, 'log.jsonl');
  const quiet = (i: number) => JSON.stringify({ do: 'dispatch', node: `n${i}`, outcome: 'done', detail: `attempt ${i}` });
  try {
    writeFileSync(log, [1, 2, 3].map(quiet).join('\n') + '\n');
    const got: string[] = [];
    const f = new Follower({ log, repo: '/r', pid: process.pid, start: procStart(process.pid), deliver: c => got.push(c) });
    assert.equal(f.tick(), undefined);
    renameSync(log, `${log}.1`);
    // The new file starts with a halt and is longer than the old offset: size alone would skip the halt.
    const fresh = [JSON.stringify({ do: 'halt', node: 'rot', outcome: 'halted', attempt: 2, needs: 'owner', detail: 'after rotation' }), ...[4, 5, 6, 7, 8, 9].map(quiet)].join('\n') + '\n';
    writeFileSync(log, fresh);
    assert.ok(fresh.length > readFileSync(`${log}.1`, 'utf8').length);
    assert.match(f.tick() ?? '', /halt rot attempt 2, needs the owner \(the main agent decides; owed lists the command\): halted — after rotation/);
    assert.equal(got.length, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('D17a.8: a failing sendMessage keeps the batch for the next tick; the follower stops only after the terminal line was delivered', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owed-follow-')), log = join(dir, 'log.jsonl');
  const put = (o: Json) => appendFileSync(log, `${JSON.stringify(o)}\n`);
  try {
    writeFileSync(log, '');
    const got: string[] = [];
    let fail = true;
    const f = new Follower({ log, repo: '/r', pid: process.pid, start: procStart(process.pid), deliver: c => { if (fail) throw new Error('session busy'); got.push(c); } });
    put({ do: 'merge', node: 'a', outcome: 'merged', detail: 'trunk 1' });
    put({ do: 'halt', node: 'b', outcome: 'halted', attempt: 1, needs: 'human', detail: 'first' });
    assert.equal(f.tick(), undefined, 'delivery failed');
    put({ do: 'notify', node: 'c', outcome: 'notify', text: 'c asks' });
    fail = false;
    assert.deepEqual(f.tick()!.split('\n'), ['owed drive (/r):', 'merge a: merged — trunk 1', 'halt b attempt 1 (needs human): halted — first', 'c asks', haltHintText, 'Next: owed status / owed why <node>']);
    put({ event: 'stopped' }); put({ event: 'exit', code: 0, reason: 'stopped', at: 'T' });
    fail = true;
    assert.equal(f.tick(), undefined);
    assert.equal(f.stopped, false, 'not stopped while the terminal line is undelivered');
    fail = false;
    assert.match(f.tick() ?? '', /\nstopped\ndriver exited 0 \(stopped\)\n/);
    assert.equal(f.stopped, true);
    assert.equal(got.length, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('D17a.9: after session_shutdown a process that loaded the extension and attached exits on its own', { timeout: 60_000 }, async () => {
  const f = await rig(planOf(node('sd')));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    mkdirSync(dirname(f.log), { recursive: true }); writeFileSync(f.log, '');
    liveLock(f.lock);   // this test process is the live driver the child attaches to
    const env: NodeJS.ProcessEnv = { ...process.env, DSA_EXEC: '', DSA_CALL: '' }; delete env.NODE_TEST_CONTEXT;
    child = spawn(process.execPath, [SHUTDOWN_CHILD, f.cwd, f.log], { cwd: f.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    child.stdout!.on('data', (b: Buffer) => { out += b; }); child.stderr!.on('data', (b: Buffer) => { err += b; });
    const exited = new Promise<number | null>(r => child!.on('exit', code => r(code)));
    await until(() => /shutdown\n/.test(out) || child!.exitCode !== null, 30_000, 'the child attached, was woken and shut down');
    const t0 = Date.now();
    const code = await Promise.race([exited, sleepMs(5000).then(() => 'still running' as const)]);
    assert.equal(code, 0, `${out}\n${err}`);
    assert.ok(Date.now() - t0 < 5000);
    assert.equal(out, 'woken\nshutdown\n', err);
  } finally {
    if (child && child.exitCode === null) child.kill('SIGKILL');
    rmSync(f.lock, { force: true }); await f.done();
  }
});
