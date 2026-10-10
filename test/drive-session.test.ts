// Driver runs belong to the starting pi session (contract 0.5.1 E1, dsa 1.0.31 `run --session`): the session is read
// from DSA_SESSION (ignored inside a dsa call), recorded in drive.lock, passed to every `run`, inherited by a detached
// driver, shown by --status and /owed; an older dsa that refuses --session is run without it (one log line, no halt).
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { Dsa, startingSession } from '../src/dsa.ts';
import { drive } from '../src/drive-run.ts';
import { classifyLine, driveStatus, driverLine, renderDriveStatus } from '../src/drive-bg.ts';
import type { Entry } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { identity } from './helpers/surface.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-dsa.mjs', import.meta.url));
const OWED = fileURLToPath(new URL('../bin/owed.js', import.meta.url));
type Json = Record<string, unknown>;
const NO_SESSION = 'no pi session: runs show only in pi-durable-subagents status / the CLI';
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
const node = (id: string) => ({ id, writes: [`${id}.txt`], checks: [], review: { count: 0, min_rank: 1 } });
const planOf = (...nodes: object[]) => ({ version: 1, trunk: 'main', closure: [], invariants: [], nodes });

async function rig(plan: object) {
  const r = await repo();
  const dir = join(r.root, 'dsa'), bin = join(r.root, 'bin');
  await mkdir(join(dir, 'agents'), { recursive: true }); await mkdir(bin);
  await writeFile(join(bin, 'owed'), `#!/bin/sh\nexec "${process.execPath}" "${OWED}" "$@"\n`); await chmod(join(bin, 'owed'), 0o755);
  const env = { FAKE_DSA_DIR: dir, PATH: `${bin}:${process.env.PATH}`, ...identity };
  await r.put('plan.json', JSON.stringify(plan)); await r.put('README', 'x\n'); await r.commit();
  await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'human' }, channel: 'flag', plan: JSON.stringify(plan) });
  const ledgerDir = process.env.OWED_DIR!, pids: number[] = [];
  const self = {
    ...r, dir, env, pids,
    lock: join(ledgerDir, 'drive.lock'),
    /** A writer agent that copies the driver's lock while the driver runs it (the run executes inside `dsa run`). */
    lockSpy: (id: string) => writeFile(join(dir, 'agents', `${id}-writer.sh`), `cp "${join(ledgerDir, 'drive.lock')}" "${join(dir, `lock-${id}.json`)}"\necho RUNNING\n`),
    seenLock: async (id: string): Promise<Json> => JSON.parse(await readFile(join(dir, `lock-${id}.json`), 'utf8')) as Json,
    dsaLog: async (): Promise<Json[]> => (await readFile(join(dir, 'log.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l) as Json),
    entries: async (): Promise<Entry[]> => (await Ledger.open(r.cwd)).read(),
    cli(args: string[], extra: Record<string, string> = {}) {
      return new Promise<{ code: number | null; stdout: string; stderr: string }>(resolve => {
        execFile(process.execPath, [OWED, ...args], { cwd: r.cwd, env: { ...process.env, ...env, OWED_DSA: FAKE, ...extra }, timeout: 60_000 }, (e, stdout, stderr) => {
          const x = e as (Error & { code?: number }) | null;
          resolve({ code: x ? (typeof x.code === 'number' ? x.code : null) : 0, stdout, stderr });
        });
      });
    },
    async detach(extra: Record<string, string>): Promise<{ pid: number; stdout: string }> {
      const s = await self.cli(['drive', '--detach'], extra);
      assert.equal(s.code, 0, `${s.stdout}\n${s.stderr}`);
      const pid = Number(/^driver started: pid (\d+), log /m.exec(s.stdout)?.[1]);
      assert.ok(pid > 0, s.stdout); pids.push(pid);
      return { pid, stdout: s.stdout };
    },
    async done() {
      for (const pid of pids) { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }
      for (const pid of pids) await until(() => !alive(pid), 5000, `pid ${pid} gone`).catch(() => undefined);
      await r.cleanup();
    },
  };
  return self;
}
const environ = (pid: number): string[] => readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean);
const runsOf = (log: Json[]) => log.filter(x => x.cmd === 'run');

test('E1.1: the starting session is DSA_SESSION, ignored inside a dsa call (DSA_CALL or DSA_EXEC) and when it is no session id', () => {
  assert.equal(startingSession({ DSA_SESSION: 'sess-1' }), 'sess-1');
  assert.equal(startingSession({}), undefined);
  assert.equal(startingSession({ DSA_SESSION: '' }), undefined);
  assert.equal(startingSession({ DSA_SESSION: 'sess-1', DSA_CALL: 'call-1' }), undefined, 'a subagent call');
  assert.equal(startingSession({ DSA_SESSION: 'sess-1', DSA_EXEC: 'exec-1' }), undefined, 'a subagent process');
  assert.equal(startingSession({ DSA_SESSION: 'not a session id' }), undefined, 'dsa ignores an unusable inherited value too');
  assert.equal(new Dsa({ bin: FAKE }).session, undefined);
  assert.equal(new Dsa({ bin: FAKE, session: 's' }).session, 's');
});

test('E1.1/E1.2: `owed drive --once` records the session in drive.lock and passes --session to every run', { timeout: 120_000 }, async () => {
  const f = await rig(planOf(node('a'), node('b')));
  try {
    await f.lockSpy('a'); await f.lockSpy('b');
    const r = await f.cli(['drive', '--once'], { DSA_SESSION: 'pi-sess-A', DSA_EXEC: '', DSA_CALL: '' });
    assert.equal(r.code, 0, r.stderr);
    await f.cli(['drive', '--once'], { DSA_SESSION: 'pi-sess-A', DSA_EXEC: '', DSA_CALL: '' });   // launches after the dispatch pass
    const runs = runsOf(await f.dsaLog());
    assert.equal(runs.length, 2, JSON.stringify(runs));
    assert.ok(runs.every(x => x.session === 'pi-sess-A'), JSON.stringify(runs));
    for (const id of ['a', 'b']) assert.equal((await f.seenLock(id)).session, 'pi-sess-A', 'the lock names the session while the driver runs');
  } finally { await f.done(); }
});

test('E1.1/E1.2: without a session (outside pi) the lock has no session key and run gets no flag', { timeout: 120_000 }, async () => {
  const f = await rig(planOf(node('c')));
  try {
    await f.lockSpy('c');
    for (let i = 0; i < 2; i++) { const r = await f.cli(['drive', '--once'], { DSA_SESSION: '', DSA_EXEC: '', DSA_CALL: '' }); assert.equal(r.code, 0, r.stderr); }
    const runs = runsOf(await f.dsaLog());
    assert.equal(runs.length, 1); assert.ok(!('session' in runs[0]!), JSON.stringify(runs));
    assert.ok(!('session' in await f.seenLock('c')), 'absent when none');
  } finally { await f.done(); }
});

test('E1.1/E1.3: a detached driver inherits the starter\'s session: lock, environment, runs, --status, --status --json and /owed name it', { timeout: 120_000 }, async () => {
  const f = await rig(planOf(node('d')));
  try {
    await f.lockSpy('d');
    const { pid } = await f.detach({ DSA_SESSION: 'pi-sess-C', DSA_EXEC: '', DSA_CALL: '' });
    assert.equal((JSON.parse(readFileSync(f.lock, 'utf8')) as Json).session, 'pi-sess-C');
    assert.ok(environ(pid).includes('DSA_SESSION=pi-sess-C'), 'passed to the detached driver');
    await until(async () => runsOf(await f.dsaLog()).length === 1, 30_000, 'the writer run');
    assert.equal(runsOf(await f.dsaLog())[0]!.session, 'pi-sess-C');
    assert.equal((await f.seenLock('d')).session, 'pi-sess-C');
    const st = await f.cli(['drive', '--status']);
    assert.equal(st.code, 0, st.stderr);
    assert.match(st.stdout, new RegExp(`^driver running: pid ${pid} on \\S+ since \\S+\\nruns are listed in pi session pi-sess-C\\n`));
    const sj = JSON.parse((await f.cli(['drive', '--status', '--json'])).stdout) as Json;
    assert.equal(sj.running, true); assert.equal(sj.session, 'pi-sess-C');
    // The pi surfaces: /owed (driverLine) and owed_drive status (renderDriveStatus) say the same.
    assert.match(await driverLine(f.cwd), new RegExp(`^Driver: running pid ${pid} since \\S+; runs are listed in pi session pi-sess-C$`));
    assert.match(renderDriveStatus(await driveStatus({ cwd: f.cwd })), /\nruns are listed in pi session pi-sess-C\n/);
    assert.equal((await f.cli(['drive', '--stop'])).stdout.trim(), 'stopped');
    const after = await f.cli(['drive', '--status']);
    assert.doesNotMatch(after.stdout, /pi session/, 'no driver: no session line');
  } finally { await f.done(); }
});

test('E1.1: started inside a dsa call, the inherited DSA_SESSION is ignored: the driver records none and says so', { timeout: 120_000 }, async () => {
  const f = await rig(planOf(node('e')));
  try {
    await f.lockSpy('e');
    const { pid } = await f.detach({ DSA_SESSION: 'pi-sess-parent', DSA_EXEC: 'exec-1', DSA_CALL: 'call-1' });
    assert.ok(!environ(pid).some(e => e.startsWith('DSA_SESSION=')), environ(pid).filter(e => e.startsWith('DSA_')).join(' '));
    assert.ok(!('session' in (JSON.parse(readFileSync(f.lock, 'utf8')) as Json)));
    await until(async () => runsOf(await f.dsaLog()).length === 1, 30_000, 'the writer run');
    assert.ok(!('session' in runsOf(await f.dsaLog())[0]!), 'no --session');
    const st = await f.cli(['drive', '--status']);
    assert.match(st.stdout, new RegExp(`^driver running: pid ${pid} on \\S+ since \\S+\\n${NO_SESSION}\\n`));
    assert.ok(!('session' in (JSON.parse((await f.cli(['drive', '--status', '--json'])).stdout) as Json)));
    assert.match(await driverLine(f.cwd), new RegExp(`^Driver: running pid ${pid} since \\S+; ${NO_SESSION}$`));
    assert.equal((await f.cli(['drive', '--stop'])).stdout.trim(), 'stopped');
  } finally { await f.done(); }
});

test('E1.2: a dsa that refuses --session (older than 1.0.31) runs without it: one log line per driver, no halt', { timeout: 120_000 }, async () => {
  const f = await rig(planOf(node('g'), node('h')));
  try {
    await f.lockSpy('g'); await f.lockSpy('h');
    await writeFile(join(f.dir, 'old-run'), '');
    const dsa = new Dsa({ bin: FAKE, env: f.env, timeoutMs: 60_000 });
    const pass = async (json: boolean) => { const lines: string[] = []; const exit = await drive({ cwd: f.cwd, once: true, json, dsa, session: 'pi-sess-old', log: l => lines.push(l), handleSignals: false }); return { exit, lines }; };
    assert.equal((await pass(false)).exit, 0);   // dispatch
    const p = await pass(false);
    assert.equal(p.exit, 0, p.lines.join('\n'));
    const fallback = p.lines.filter(l => /--session/.test(l));
    assert.equal(fallback.length, 1, p.lines.join('\n'));
    assert.match(fallback[0]!, /^dsa does not accept --session \(older than pi-durable-subagents 1\.0\.31\): runs start without it and are not listed in pi session pi-sess-old \(.*Unknown or repeated option --session.*\)$/);
    assert.equal(p.lines.filter(l => /^launch [gh] writer \S+: applied — created$/.test(l)).length, 2, p.lines.join('\n'));
    const runs = runsOf(await f.dsaLog());
    assert.equal(runs.length, 2); assert.ok(runs.every(x => !('session' in x) && x.exit === 0 && x.created), JSON.stringify(runs));
    const es = await f.entries();
    assert.equal(es.filter(e => e.kind === 'halt').length, 0, 'never a halt for the flag');
    assert.equal((await f.seenLock('g')).session, 'pi-sess-old', 'the lock still records the session');
    // In a --json log the line is an event the follower does not wake for.
    const ev = JSON.stringify({ event: 'session-unsupported', session: 'pi-sess-old', reason: 'Unknown or repeated option --session' });
    assert.deepEqual(classifyLine(ev), { kind: 'quiet', text: 'dsa does not accept --session (older than pi-durable-subagents 1.0.31): runs start without it and are not listed in pi session pi-sess-old (Unknown or repeated option --session)' });
    // Detection is per client: the first refused run drops the flag; later runs never pass it.
    const dsa2 = new Dsa({ bin: FAKE, env: f.env, timeoutMs: 60_000 });
    assert.equal(dsa2.sessionRefused, false);
    const j = await dsa2.run('probe-run-1', '{"agent":"worker","task":"x"}', { node: 'zz', role: 'writer' });
    assert.equal(j.outcome, 'applied');
    dsa2.session = 'pi-sess-old';
    const refusedWith: string[] = []; dsa2.onSessionRefused = r => refusedWith.push(r);
    assert.equal((await dsa2.run('probe-run-2', '{"agent":"worker","task":"y"}', { node: 'zz', role: 'writer' })).outcome, 'applied');
    assert.equal((await dsa2.run('probe-run-3', '{"agent":"worker","task":"z"}', { node: 'zz', role: 'writer' })).outcome, 'applied');
    assert.equal(refusedWith.length, 1, 'detected once per client');
    assert.equal(dsa2.sessionRefused, true);
  } finally { await f.done(); }
});

test('E1.2: with a current dsa the flag is passed on every run and a retry of the same request passes it again', { timeout: 60_000 }, async () => {
  const f = await rig(planOf(node('k')));
  try {
    const dsa = new Dsa({ bin: FAKE, env: f.env, timeoutMs: 60_000, session: 'pi-sess-K' });
    await writeFile(join(f.dir, 'faults'), 'run 75 record\n');
    const first = await dsa.run('retry-run-1', '{"agent":"worker","task":"x"}', { node: 'k', role: 'writer' });
    assert.equal(first.outcome, 'pending');
    const second = await dsa.run('retry-run-1', '{"agent":"worker","task":"x"}', { node: 'k', role: 'writer' });
    assert.equal(second.outcome, 'applied', 'session is not part of the request content: no conflict');
    const runs = runsOf(await f.dsaLog()).filter(x => !x.fault);   // the fault line is logged before flags matter
    assert.ok(runs.length === 1 && runs[0]!.created && runs[0]!.session === 'pi-sess-K', JSON.stringify(runs));
    assert.equal(dsa.sessionRefused, false);
  } finally { await f.done(); }
});
