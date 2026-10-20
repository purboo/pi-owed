// 0.31 FW1–FW4. Only existing public imports: the ebf090b run must fail on behavior, not missing modules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';
import * as ops from '../src/ops.ts';
import { procStart } from '../src/drive-run.ts';
import { Dsa } from '../src/dsa.ts';
import { Ledger } from '../src/ledger.ts';
import { git } from '../src/git.ts';
import { repo } from './helpers/repo.ts';
import { cli, identity } from './helpers/surface.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-dsa.mjs', import.meta.url));
const OWED = fileURLToPath(new URL('../bin/owed.js', import.meta.url));
const pause = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(fn: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!fn()) { assert.ok(Date.now() < end, 'condition reached before deadline'); await pause(50); }
}
async function fixture() {
  const r = await repo(), saved = { ...process.env };
  delete process.env.OWED_DIR;
  for (const key of ['DSA_SESSION', 'PI_SESSION_ID', 'DSA_EXEC', 'DSA_CALL', 'OWED_CONFIRM']) delete process.env[key];
  process.env.XDG_STATE_HOME = join(r.root, 'state');
  process.env.OWED_DSA = FAKE; process.env.FAKE_DSA_DIR = join(r.root, 'dsa');
  const plan = JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [], nodes: [{ id: 'a', later: true, writes: ['a.txt'], checks: [], review: { count: 0, min_rank: 1 } }] });
  await r.put('plan.json', plan); await r.commit();
  await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'pi' }, channel: 'delegated', plan, path: 'plan.json' });
  const dir = join(r.cwd, '.git/owed'), log = join(dir, 'drive/log.jsonl'), lock = join(dir, 'drive.lock');
  mkdirSync(join(dir, 'drive'), { recursive: true }); writeFileSync(log, '');
  const pids = new Set<number>();
  const reg = (cwd = r.cwd) => join(process.env.XDG_STATE_HOME!, 'owed/drivers', `${createHash('sha256').update(cwd).digest('hex').slice(0, 16)}.json`);
  const owner = { pid: process.pid, start: procStart(process.pid), host: hostname(), at: new Date().toISOString(), token: 'follow-fixture' };
  return { ...r, dir, log, lock, reg, owner, pids,
    held: () => writeFileSync(lock, JSON.stringify(owner)),
    append: (line: unknown) => appendFileSync(log, `${typeof line === 'string' ? line : JSON.stringify(line)}\n`),
    register(cwd: string, session: string, extra: object = {}) { mkdirSync(join(process.env.XDG_STATE_HOME!, 'owed/drivers'), { recursive: true }); writeFileSync(reg(cwd), JSON.stringify({ repo: cwd, pid: owner.pid, start: owner.start, at: owner.at, session, ...extra })); },
    async close() {
      for (const pid of pids) { try { process.kill(-pid, 'SIGKILL'); } catch { /* exited */ } }
      for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
      Object.assign(process.env, saved); await r.cleanup();
    },
  };
}
function harness(cwd: string, session?: string) {
  const tools = new Map<string, ToolDefinition>(), events = new Map<string, (e: unknown, ctx: unknown) => Promise<void>>(), messages: { content: string }[] = [];
  const ctx = { cwd, hasUI: false, isIdle: () => true, ...(session ? { sessionManager: { getSessionId: () => session } } : {}), ui: { notify() {} } } as unknown as Parameters<ToolDefinition['execute']>[4];
  owed({ registerTool: (t: ToolDefinition) => tools.set(t.name, t), registerCommand() {}, on: (n: string, f: (e: unknown, ctx: unknown) => Promise<void>) => events.set(n, f), sendMessage: (m: { content: string }) => messages.push(m) } as unknown as ExtensionAPI);
  return { messages, emit: async (name: string) => { await events.get(name)?.({}, ctx); }, call: (name: string, p: object) => tools.get(`owed_${name}`)!.execute('follow', p, undefined, undefined, ctx) };
}
async function ask(f: Awaited<ReturnType<typeof fixture>>) {
  const agents = join(process.env.FAKE_DSA_DIR!, 'agents'); mkdirSync(agents, { recursive: true });
  writeFileSync(join(agents, 'a-writer.sh'), 'echo "ASK: choose the family rule"\n');
  const dsa = new Dsa({ bin: FAKE });
  await dsa.run('follow-question', JSON.stringify({ agent: 'worker', task: 'ask' }), { node: 'a', role: 'writer' }, f.cwd);
  const q = (await dsa.describe('follow-question')).questions![0]!;
  return { do: 'notify', node: 'a', rid: 'follow-question', qid: q.qid, rev: q.rev, text: `a: writer run follow-question asks (qid ${q.qid}, rev ${q.rev}): choose the family rule — the driver never answers; answer: owed answer a "<text>"; in pi: owed_answer` };
}

test('FW1 tool cwd in another repository follows an ask, keeps busy hold and dedup after repeated calls', { timeout: 30_000 }, async () => {
  const f = await fixture(), h = harness(f.root);
  try {
    f.held(); await h.emit('session_start');
    assert.notEqual((await h.call('status', { cwd: f.cwd })).isError, true);
    await h.emit('agent_start');
    const line = { ...await ask(f), facts: 9999 }; f.append(line);
    await pause(2200); assert.equal(h.messages.length, 0, 'held while busy');
    await h.emit('agent_settled'); assert.equal(h.messages.length, 1, 'target repository ask delivered');
    assert.match(h.messages[0]!.content, /choose the family rule/);
    await h.call('status', { cwd: f.cwd }); f.append(line); await h.emit('agent_settled');
    assert.equal(h.messages.length, 1, 'same pid attach preserves dedup state');
  } finally { await h.emit('session_shutdown'); await f.close(); }
});

test('FW1 refused tool calls attach, including reserved parent:drive identity', async () => {
  const f = await fixture(); f.held();
  try {
    for (const args of [{ node: 'missing' }, { node: 'a', as: 'parent:drive' }]) {
      const h = harness(f.root);
      try {
        assert.equal((await h.call('why', { ...args, cwd: f.cwd })).isError, true);
        f.append('refused-call wake'); await h.emit('agent_settled');
        assert.match(h.messages[0]?.content ?? '', /refused-call wake/);
      } finally { await h.emit('session_shutdown'); }
    }
  } finally { await f.close(); }
});

test('FW1/FW2 DSA_CALL and DSA_EXEC sessions never attach through session start, tools or registry', { timeout: 30_000 }, async () => {
  const f = await fixture(); f.held(); f.register(f.cwd, 'parent-session');
  try {
    for (const key of ['DSA_CALL', 'DSA_EXEC']) {
      process.env[key] = 'child'; const h = harness(f.root, 'parent-session');
      try {
        await h.emit('session_start'); await h.call('status', { cwd: f.cwd });
        await pause(2200); f.append(`must stay quiet ${key}`); await h.emit('agent_settled');
        assert.equal(h.messages.length, 0);
      } finally { await h.emit('session_shutdown'); delete process.env[key]; }
    }
  } finally { await f.close(); }
});

test('FW2 registry uses main root, records and removes the actual detached driver; legacy lock session stays DSA_SESSION', { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    process.env.DSA_SESSION = 'dsa-session-first'; process.env.PI_SESSION_ID = 'pi-fallback';
    const wt = join(f.root, 'linked'); await git(f.cwd, ['worktree', 'add', '-b', 'linked', wt]);
    const start = await cli(wt, ['drive', '--detach', '--stay', '--json']); assert.equal(start.code, 0, start.stderr);
    const pid = JSON.parse(start.stdout).pid as number; f.pids.add(pid);
    assert.ok(existsSync(f.reg()), 'entry at hash of main repository root');
    const entry = JSON.parse(readFileSync(f.reg(), 'utf8'));
    assert.deepEqual(entry, { repo: f.cwd, pid, start: procStart(pid), session: 'dsa-session-first', at: JSON.parse(readFileSync(f.lock, 'utf8')).at });
    assert.equal(JSON.parse(readFileSync(f.lock, 'utf8')).session, 'dsa-session-first');
    assert.equal((await cli(wt, ['drive', '--stop'])).code, 0); assert.equal(existsSync(f.reg()), false, 'normal exit unregistered');
  } finally { await f.close(); }
});

test('FW2 registry PI fallback, no session, write failure, foreground release and hard-stop release', { timeout: 90_000 }, async () => {
  const f = await fixture();
  try {
    for (const session of ['pi-only-session', '']) {
      process.env.PI_SESSION_ID = session;
      const start = await cli(f.cwd, ['drive', '--detach', '--stay', '--json']); assert.equal(start.code, 0, start.stderr);
      const pid = JSON.parse(start.stdout).pid as number; f.pids.add(pid);
      assert.ok(existsSync(f.reg()), 'entry exists even without session');
      assert.equal(JSON.parse(readFileSync(f.reg(), 'utf8')).session, session || undefined);
      assert.equal(JSON.parse(readFileSync(f.lock, 'utf8')).session, undefined, 'PI fallback does not change legacy lock');
      assert.equal((await cli(f.cwd, ['drive', '--stop', '--now'])).code, 0); assert.equal(existsSync(f.reg()), false);
    }
    const child = spawn(process.execPath, [OWED, 'drive', '--stay', '--json'], { cwd: f.cwd, env: { ...process.env, ...identity }, stdio: 'ignore' });
    const closed = new Promise(resolve => child.once('exit', resolve));
    try { await until(() => existsSync(f.lock)); assert.ok(existsSync(f.reg())); child.kill('SIGTERM'); await closed; assert.equal(existsSync(f.reg()), false); }
    finally { if (child.exitCode === null) child.kill('SIGKILL'); }
    process.env.XDG_STATE_HOME = join(f.root, 'not-a-directory'); writeFileSync(process.env.XDG_STATE_HOME, 'x');
    const start = await cli(f.cwd, ['drive', '--detach', '--stay', '--json']); assert.equal(start.code, 0, start.stderr); f.pids.add(JSON.parse(start.stdout).pid);
    assert.equal((await cli(f.cwd, ['drive', '--stop'])).code, 0, 'registry failure does not fail driver');
  } finally { await f.close(); }
});

test('FW2 registry discovery follows only the context session; stale pid/start and other sessions stay quiet', { timeout: 30_000 }, async () => {
  const f = await fixture(); f.held(); f.register(f.cwd, 'context-session');
  process.env.DSA_SESSION = 'env-other'; process.env.PI_SESSION_ID = 'env-pi-other';
  const own = harness(f.root, 'context-session'), other = harness(f.root, 'another-session');
  try {
    await own.emit('session_start'); await other.emit('session_start'); await pause(2600);
    f.append(await ask(f)); await own.emit('agent_settled'); await other.emit('agent_settled');
    assert.match(own.messages[0]?.content ?? '', /choose the family rule/, 'context id survives worker transport'); assert.equal(other.messages.length, 0);
    for (const extra of [{ start: 'not-this-process-start' }, { pid: 2147483647 }]) {
      f.register(f.cwd, 'context-session', extra); const stale = harness(f.root, 'context-session');
      try { await stale.emit('session_start'); await pause(2600); f.append('stale entry wake'); await stale.emit('agent_settled'); assert.equal(stale.messages.length, 0); }
      finally { await stale.emit('session_shutdown'); }
    }
  } finally { await own.emit('session_shutdown'); await other.emit('session_shutdown'); await f.close(); }
});

test('FW2 registry discovery falls back to DSA_SESSION then PI_SESSION_ID and reads at most every 10 seconds', { timeout: 40_000 }, async () => {
  const f = await fixture(); f.held();
  try {
    for (const key of ['DSA_SESSION', 'PI_SESSION_ID']) {
      process.env[key] = 'fallback-session'; f.register(f.cwd, 'fallback-session'); const h = harness(f.root);
      try { await h.emit('session_start'); await pause(2600); f.append(`fallback ${key}`); await h.emit('agent_settled'); assert.match(h.messages.map(m => m.content).join('\n'), new RegExp(`fallback ${key}`)); }
      finally { await h.emit('session_shutdown'); delete process.env[key]; }
    }
    rmSync(f.reg()); const h = harness(f.root, 'late-session');
    try {
      await h.emit('session_start'); await pause(2600); f.register(f.cwd, 'late-session'); await pause(2600);
      f.append('too early'); await h.emit('agent_settled'); assert.equal(h.messages.length, 0, 'registry not rescanned on every 2s tick');
      await pause(8000); await h.emit('agent_settled'); assert.match(h.messages[0]?.content ?? '', /too early/, 'PD1 registry attach replays the wake preceding discovery');
      f.append('after next registry scan'); await h.emit('agent_settled'); assert.match(h.messages.map(m => m.content).join('\n'), /after next registry scan/);
    } finally { await h.emit('session_shutdown'); }
  } finally { await f.close(); }
});

test('FW3 CLI start/detach text and JSON say who follows, including reuse and no-session note', { timeout: 90_000 }, async () => {
  const f = await fixture();
  try {
    for (const session of ['session-123456789', '']) {
      process.env.PI_SESSION_ID = session;
      for (const args of [['drive', '--detach', '--stay'], ['start', '--stay']]) {
        const start = await cli(f.cwd, args); assert.equal(start.code, 0, start.stderr);
        const pid = JSON.parse(readFileSync(f.lock, 'utf8')).pid as number; f.pids.add(pid);
        if (session) assert.match(start.stdout, /\nfollowed by pi session session-\n$/);
        else assert.match(start.stdout, /\nnote: no pi session follows this driver; its wakes reach only pi sessions opened in this repository\. To be woken elsewhere, run `owed watch` \(for example as a dsa command call\)\.\n$/);
        // Reuse reports the actual starter, not the caller's different session.
        process.env.PI_SESSION_ID = 'different-caller';
        const reused = await cli(f.cwd, ['start', '--json']); assert.equal(reused.code, 0, reused.stderr); assert.equal(JSON.parse(reused.stdout).followedBy, session || null);
        process.env.PI_SESSION_ID = session;
        assert.equal((await cli(f.cwd, ['drive', '--stop'])).code, 0);
      }
      const json = await cli(f.cwd, ['drive', '--detach', '--stay', '--json']); assert.equal(json.code, 0, json.stderr); f.pids.add(JSON.parse(json.stdout).pid);
      assert.equal(JSON.parse(json.stdout).followedBy, session || null); assert.equal((await cli(f.cwd, ['drive', '--stop'])).code, 0);
    }
  } finally { await f.close(); }
});

test('FW4 watch batch + next cursor, repeat timeout, no driver, and read-only ledger/lock', { timeout: 30_000 }, async () => {
  const f = await fixture(); f.held();
  try {
    const ledger = await Ledger.open(f.cwd), before = await ledger.read(), lock = readFileSync(f.lock, 'utf8');
    f.append(await ask(f));
    const first = await cli(f.cwd, ['watch', '--after', '0', '--timeout', '1']); assert.equal(first.code, 0, first.stderr);
    assert.match(first.stdout, /choose the family rule/); const next = /\nnext: owed watch --after (\d+:\d+)\n$/.exec(first.stdout)?.[1]; assert.ok(next);
    assert.equal(next, `${Buffer.byteLength(readFileSync(f.log))}:${statSync(f.log).ino}`);
    const again = await cli(f.cwd, ['watch', '--after', next, '--timeout', '1', '--json']); assert.equal(again.code, 5, again.stderr);
    assert.deepEqual(JSON.parse(again.stdout), { lines: ['no wake within 1 s'], next, exit: 5 });
    const defaultTail = await cli(f.cwd, ['watch', '--timeout', '0']); assert.equal(defaultTail.code, 5); assert.doesNotMatch(defaultTail.stdout, /choose the family rule/); assert.match(defaultTail.stdout, /next: owed watch --after/);
    assert.deepEqual(await ledger.read(), before); assert.equal(readFileSync(f.lock, 'utf8'), lock);
    rmSync(f.lock); const absent = await cli(f.cwd, ['watch']); assert.equal(absent.code, 3); assert.equal(absent.stdout.trim(), `no owed driver is running in ${f.cwd}; start one with owed start`);
    const absentJson = await cli(f.cwd, ['watch', '--json']); assert.equal(absentJson.code, 3); assert.equal(JSON.parse(absentJson.stdout).exit, 3);
  } finally { await f.close(); }
});

test('FW4 live watch handles rotation, terminal exit, pid-gone and revalidates stale ledger and dsa asks', { timeout: 40_000 }, async () => {
  const f = await fixture(); f.held();
  try {
    // The historical fact mark is stale after a parent rule; it cannot wake even with --after 0.
    f.append({ do: 'notify', node: 'a', facts: 0, text: 'obsolete need' });
    await ops.rule({ cwd: f.cwd, as: { role: 'parent', id: 'pi' }, nodes: ['a'], text: 'resolved' });
    const stale = await cli(f.cwd, ['watch', '--after', '0', '--timeout', '0']); assert.equal(stale.code, 5, stale.stderr); assert.doesNotMatch(stale.stdout, /obsolete need/);
    const line = await ask(f); f.append(line);
    // A successfully described run no longer lists this qid/rev.
    const statePath = join(process.env.FAKE_DSA_DIR!, 'state.json'), state = JSON.parse(readFileSync(statePath, 'utf8')); state.runs['follow-question'].questions = []; writeFileSync(statePath, JSON.stringify(state));
    const closed = await cli(f.cwd, ['watch', '--after', '0', '--timeout', '0']); assert.equal(closed.code, 5, closed.stderr); assert.doesNotMatch(closed.stdout, /choose the family rule/);
    const live = cli(f.cwd, ['watch', '--timeout', '5', '--json']);
    await pause(1500); renameSync(f.log, `${f.log}.1`); writeFileSync(f.log, 'rotated wake\n');
    const rotated = await live; assert.equal(rotated.code, 0, rotated.stderr); assert.ok(JSON.parse(rotated.stdout).lines.includes('rotated wake')); assert.equal(JSON.parse(rotated.stdout).next, `13:${statSync(f.log).ino}`);
    const exit = cli(f.cwd, ['watch', '--timeout', '5']); await pause(1500); f.append({ event: 'exit', code: 0, reason: 'stopped', at: new Date().toISOString() });
    const ended = await exit; assert.equal(ended.code, 0, ended.stderr); assert.match(ended.stdout, /Driver stopped: stopped/); assert.match(ended.stdout, /next: owed watch --after/);
    const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    try {
      writeFileSync(f.lock, JSON.stringify({ ...f.owner, pid: child.pid, start: procStart(child.pid!) }));
      const watch = cli(f.cwd, ['watch', '--timeout', '5']); await pause(1500); child.kill('SIGTERM');
      const gone = await watch; assert.equal(gone.code, 0, gone.stderr); assert.match(gone.stdout, /ended without an exit record/);
    } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
  } finally { await f.close(); }
});

test('R-031-FW-2 watch resumes from zero after rotation even when the new log exceeds the old cursor', async () => {
  const f = await fixture(); f.held();
  try {
    f.append(`old wake ${'.'.repeat(80)}`);
    const old = statSync(f.log), first = await cli(f.cwd, ['watch', '--after', '0', '--timeout', '0', '--json']);
    assert.equal(first.code, 0, first.stderr);
    // String also accepts the baseline's numeric next: its red failure demonstrates the skipped wake, not a fixture/type error.
    const cursor = String(JSON.parse(first.stdout).next);
    renameSync(f.log, `${f.log}.1`); writeFileSync(f.log, `first wake after restart\n${'\n'.repeat(old.size + 20)}`);
    const fresh = statSync(f.log); assert.notEqual(fresh.ino, old.ino); assert.ok(fresh.size >= old.size);
    const resumed = await cli(f.cwd, ['watch', '--after', cursor, '--timeout', '0', '--json']);
    assert.equal(resumed.code, 0, `the saved cursor must not skip the new log's first wake: ${resumed.stdout} ${resumed.stderr}`);
    assert.ok(JSON.parse(resumed.stdout).lines.includes('first wake after restart'));
    assert.equal(cursor, `${old.size}:${old.ino}`); assert.equal(JSON.parse(resumed.stdout).next, `${fresh.size}:${fresh.ino}`);
    // Bare offsets retain their previous byte-only meaning, even in a different file.
    const bare = await cli(f.cwd, ['watch', '--after', String(old.size), '--timeout', '0', '--json']);
    assert.equal(bare.code, 5, bare.stderr); assert.doesNotMatch(bare.stdout, /first wake after restart/);
    // A matching inode with a shortened log still resets to zero, as the session follower does.
    writeFileSync(f.log, 'short wake\n'); assert.equal(statSync(f.log).ino, fresh.ino);
    const shorter = await cli(f.cwd, ['watch', '--after', JSON.parse(resumed.stdout).next, '--timeout', '0', '--json']);
    assert.equal(shorter.code, 0, shorter.stderr); assert.ok(JSON.parse(shorter.stdout).lines.includes('short wake'));
    assert.equal(JSON.parse(shorter.stdout).next, `11:${fresh.ino}`);
  } finally { await f.close(); }
});

test('FW4 watch rejects malformed cursors/timeouts before following', async () => {
  const f = await fixture();
  try {
    for (const cursor of ['-1', '1.5', '1:', ':1', '1:2:3', '1:-2', '1:2.5', '1:NaN', '1: 2', '1e2:3', '9007199254740992', '0:9007199254740992']) {
      const out = await cli(f.cwd, ['watch', '--after', cursor]);
      assert.equal(out.code, 2, cursor); assert.match(out.stderr, /<offset>\[:<ino>\]/);
    }
    for (const timeout of ['NaN', '9007199254740992']) assert.equal((await cli(f.cwd, ['watch', '--timeout', timeout])).code, 2);
  } finally { await f.close(); }
});
