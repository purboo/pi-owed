// owed drive end to end against the fake dsa (contract D8.2–D8.4): the executor, crash safety, refusals, leases.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owedExtension from '../src/extension.ts';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { Dsa } from '../src/dsa.ts';
import { drive } from '../src/drive-run.ts';
import { git } from '../src/git.ts';
import type { Entry } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { identity } from './helpers/surface.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-dsa.mjs', import.meta.url));
const OWED = fileURLToPath(new URL('../bin/owed.js', import.meta.url));
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');
type Log = Record<string, unknown>;

const node = (id: string, o: Record<string, unknown> = {}) => ({ id, writes: [`${id}.txt`], checks: [], review: { count: 0, min_rank: 1 }, ...o });
const planOf = (...nodes: object[]) => ({ version: 1, trunk: 'main', closure: [], invariants: [], nodes });

async function rig(plan: object) {
  const r = await repo();
  const dir = join(r.root, 'dsa'), bin = join(r.root, 'bin');
  await mkdir(join(dir, 'agents'), { recursive: true }); await mkdir(bin);
  await writeFile(join(bin, 'owed'), `#!/bin/sh\nexec "${process.execPath}" "${OWED}" "$@"\n`); await chmod(join(bin, 'owed'), 0o755);
  const env = { FAKE_DSA_DIR: dir, PATH: `${bin}:${process.env.PATH}`, ...identity };
  await r.put('plan.json', JSON.stringify(plan)); await r.put('README', 'x\n'); await r.commit();
  await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'human' }, channel: 'flag', plan: JSON.stringify(plan) });
  const dsa = new Dsa({ bin: FAKE, env, timeoutMs: 120_000 });
  const self = {
    ...r, dir, env, dsa,
    agent: (name: string, body: string) => writeFile(join(dir, 'agents', `${name}.sh`), `set -e\n${body}\n`),
    file: (name: string, text: string) => writeFile(join(dir, name), text),
    log: async (): Promise<Log[]> => (await readFile(join(dir, 'log.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l) as Log),
    entries: async (): Promise<Entry[]> => (await Ledger.open(r.cwd)).read(),
    /** In-process driver; returns its output lines. */
    async drive(o: { once?: boolean; signal?: AbortSignal; passMs?: number } = {}) {
      const lines: string[] = [];
      const exit = await drive({ cwd: r.cwd, once: o.once, dsa, log: l => lines.push(l), pollMs: 50, passMs: o.passMs ?? 300, handleSignals: false, signal: o.signal });
      return { exit, lines };
    },
    /** `owed drive --once` as a separate process (crash tests). */
    cli(args: string[], extra: Record<string, string> = {}) {
      return new Promise<{ code: number | null; signal: string | null; stdout: string; stderr: string }>(resolve => {
        execFile(process.execPath, [OWED, ...args], { cwd: r.cwd, env: { ...process.env, ...env, OWED_DSA: FAKE, ...extra }, timeout: 120_000 }, (e, stdout, stderr) => {
          const x = e as (Error & { code?: number; signal?: string }) | null;
          resolve({ code: x ? (typeof x.code === 'number' ? x.code : null) : 0, signal: x?.signal ?? null, stdout, stderr });
        });
      });
    },
    /** Up to n `--once` passes until `until` holds; the output lines are kept for failure messages. */
    out: [] as string[],
    async once(n: number, until: () => Promise<boolean>) {
      for (let i = 0; i < n; i++) { if (await until()) return true; self.out.push(...(await self.drive({ once: true })).lines); }
      return until();
    },
  };
  return self;
}
const kinds = (es: Entry[], kind: string) => es.filter(e => e.kind === kind);
const merged = (es: Entry[], id: string) => es.some(e => e.kind === 'merge' && e.node === id);

test('D8.2: plan to merged for a 2-node chain with a failing-then-fixed check and one review, no human command', { timeout: 300_000 }, async () => {
  const f = await rig(planOf(
    node('a', { checks: [{ id: 'a', run: 'grep -q good a.txt', reads: ['a.txt'] }], review: { count: 1, min_rank: 1 } }),
    node('b', { deps: ['a'], checks: [{ id: 'b', run: 'test -f b.txt', reads: ['b.txt'] }] })));
  try {
    await f.agent('a-writer-1', 'echo bad > a.txt; git add a.txt; git commit -qm a1; owed submit a');
    await f.agent('a-writer-2', 'case "$FAKE_MESSAGE" in *"owed found problems"*) ;; *) exit 9;; esac\necho good > a.txt; git commit -qam a2; owed submit a');
    await f.agent('a-reviewer', 'who=$(grep -o "reviewer:drive-a-1-[0-9]*" "$FAKE_SPEC" | head -1)\nowed review a --as "$who" --ok --rank 1 --note "diff is fine"');
    await f.agent('b-writer', 'echo b > b.txt; git add b.txt; git commit -qm b; owed submit b');
    const r = await f.drive();
    assert.equal(r.exit, 0);
    assert.match(r.lines.at(-1)!, /^idle/, r.lines.join('\n'));
    const es = await f.entries();
    assert.ok(merged(es, 'a') && merged(es, 'b'), r.lines.join('\n'));
    // No human command: only the genesis is by an owner; everything else is the driver, its agents and the executor.
    assert.deepEqual(es.filter(e => e.by.startsWith('owner:')).map(e => e.kind), ['genesis']);
    assert.ok(es.every(e => e.kind === 'genesis' || /^(parent:drive|writer:|reviewer:drive-a-1-1|executor:owed)/.test(e.by)), es.map(e => e.by).join(' '));
    const sends = kinds(es, 'send') as Extract<Entry, { kind: 'send' }>[];
    assert.deepEqual(sends.map(x => x.reason), ['repair'], 'one repair follow-up after the failing check');
    assert.ok(es.some(e => e.kind === 'obs' && e.obligation === 'check:a' && e.verdict === 'fail'));
    assert.ok(es.some(e => e.kind === 'review' && e.by === 'reviewer:drive-a-1-1' && e.verdict === 'ok'));
    assert.equal(kinds(es, 'halt').length, 0);
    // attest went through `hold machine --shared --no-wait`, never queued.
    const holds = (await f.log()).filter(x => x.cmd === 'hold');
    assert.ok(holds.length >= 3 && holds.every(x => x.granted && x.mode === 'shared' && x.noWait && !x.queued), JSON.stringify(holds));
    assert.equal(await readFile(join(f.cwd, 'a.txt'), 'utf8').catch(async () => (await git(f.cwd, ['show', 'main:a.txt'])).stdout), 'good\n');
    assert.equal((await git(f.cwd, ['show', 'main:b.txt'])).stdout, 'b\n');
    // The cursor is operational state of the loop.
    assert.match(await readFile(join(process.env.OWED_DIR!, 'drive', 'cursor'), 'utf8'), /:\d+\n$/);
  } finally { await f.cleanup(); }
});

test('D8.3: a kill after the ledger append or after the dsa call re-sends identical bytes and ids; one run/send per id', { timeout: 300_000 }, async () => {
  const f = await rig(planOf(node('c')));
  try {
    await f.agent('c-writer-1', 'echo c > c.txt; git add c.txt; git commit -qm c');   // forgets to submit
    await f.agent('c-writer-2', 'owed submit c');
    const step = async (kill?: string) => {
      const r = await f.cli(['drive', '--once'], kill ? { OWED_DRIVE_TEST_KILL: kill } : {});
      if (kill) assert.equal(r.signal, 'SIGKILL', `${kill}: ${r.stdout}${r.stderr}`); else assert.equal(r.code, 0, r.stderr);
      return r;
    };
    await step();                                          // dispatch
    await step('before-dsa:launch');
    let es = await f.entries();
    const launch = kinds(es, 'launch')[0] as Extract<Entry, { kind: 'launch' }>;
    assert.ok(launch, 'the launch entry is persisted before the dsa call');
    assert.equal((await f.log()).filter(x => x.cmd === 'run').length, 0, 'killed before dsa run');
    await step('after-dsa:launch');                        // stale lock taken over; re-launch with the stored bytes
    await step('before-dsa:send');                         // submit follow-up recorded, not sent
    es = await f.entries();
    const send = kinds(es, 'send')[0] as Extract<Entry, { kind: 'send' }>;
    assert.ok(send && send.reason === 'submit');
    assert.equal((await f.log()).filter(x => x.cmd === 'send').length, 0);
    await step('after-dsa:send');                          // re-sent with the same id; agent submits; killed
    assert.ok(await f.once(10, async () => merged(await f.entries(), 'c')), `merged after the crashes:\n${f.out.join('\n')}\n${(await f.entries()).map(e => `${e.seq} ${e.kind} ${e.by}`).join('\n')}`);
    es = await f.entries();
    assert.equal(kinds(es, 'launch').length, 1); assert.equal(kinds(es, 'send').length, 1); assert.equal(kinds(es, 'halt').length, 0);
    const log = await f.log();
    assert.ok(log.every(x => x.exit !== 3), 'no request-conflict');
    const runs = log.filter(x => x.cmd === 'run' && x.request === launch.rid);
    assert.equal(runs.filter(x => x.created).length, 1, 'one run created for the rid');
    assert.ok(runs.length >= 1 && runs.every(x => x.exit === 0));
    const sendLog = log.filter(x => x.cmd === 'send');
    assert.ok(sendLog.every(x => x.request === send.send && x.exit === 0), JSON.stringify(sendLog));
    assert.equal(sendLog.filter(x => !x.replay).length, 1, 'one send decided for the id');
    assert.equal(sendLog.length, 1, 'a send dsa already applied is confirmed by describe, not re-sent');
    assert.equal(sha(readFileSync(join(f.dir, 'specs', launch.rid))), launch.spec, 'dsa got the exact stored spec bytes');
    assert.equal(sha(readFileSync(join(f.dir, 'messages', send.send))), send.message, 'dsa got the exact stored message bytes');
  } finally { await f.cleanup(); }
});

test('D8.4: a second driver refuses; the CLI and the pi tool', { timeout: 120_000 }, async () => {
  const f = await rig(planOf(node('d')));
  try {
    const stat = readFileSync(`/proc/${process.pid}/stat`, 'utf8'), start = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
    const lock = join(process.env.OWED_DIR!, 'drive.lock');
    await writeFile(lock, JSON.stringify({ pid: process.pid, start, host: hostname(), at: 'now', token: 't' }));
    const r = await f.cli(['drive', '--once']);
    assert.equal(r.code, 1); assert.match(r.stderr, /another owed drive is running/);
    await assert.rejects(f.drive({ once: true }), /another owed drive is running/);
    assert.equal(kinds(await f.entries(), 'dispatch').length, 0);
    // A lock of a dead pid is stale.
    await writeFile(lock, JSON.stringify({ pid: 2 ** 22 + 7, host: hostname(), at: 'then', token: 'u' }));
    const ok = await f.cli(['drive', '--once', '--json']);
    assert.equal(ok.code, 0, ok.stderr);
    const lines = ok.stdout.trim().split('\n').map(l => JSON.parse(l) as Log);
    assert.deepEqual(lines.map(x => [x.do, x.node, x.outcome]), [['dispatch', 'd', 'done']]);
    assert.equal((await f.cli(['drive', '--as', 'parent:x'])).code, 2);
    assert.equal((await f.cli(['drive', '--max', '0'])).code, 2);
    assert.match((await f.cli(['--help'])).stdout, /drive \[--once\] \[--max N\]/);
    // pi tool: one pass, described as not for long loops.
    const tools = new Map<string, ToolDefinition>();
    owedExtension({ registerTool(t: ToolDefinition) { tools.set(t.name, t); }, registerCommand() {} } as unknown as ExtensionAPI);
    const t = tools.get('owed_drive')!;
    assert.match(t.description, /systemd-run/);
    const prior = { dsa: process.env.OWED_DSA, dir: process.env.FAKE_DSA_DIR };
    process.env.OWED_DSA = FAKE; process.env.FAKE_DSA_DIR = f.dir;
    try {
      const out = await t.execute('t', { cwd: f.cwd }, undefined, undefined, { cwd: f.cwd, hasUI: false } as Parameters<ToolDefinition['execute']>[4]);
      assert.match((out.content[0] as { text: string }).text, /launch d writer owed:[0-9a-f]{12}:d:1:writer: applied/);
    } finally {
      if (prior.dsa === undefined) delete process.env.OWED_DSA; else process.env.OWED_DSA = prior.dsa;
      if (prior.dir === undefined) delete process.env.FAKE_DSA_DIR; else process.env.FAKE_DSA_DIR = prior.dir;
    }
  } finally { await f.cleanup(); }
});

test('D8.4: request-conflict halts; a halted attempt gets no further action', { timeout: 120_000 }, async () => {
  const f = await rig(planOf(node('e')));
  try {
    await f.file('faults', 'run 3\n');
    await f.drive({ once: true });
    const r = await f.drive({ once: true });
    assert.match(r.lines.join('\n'), /launch e writer .*: conflict — halted/);
    const es = await f.entries(), h = kinds(es, 'halt')[0] as Extract<Entry, { kind: 'halt' }>;
    assert.ok(h && h.needs === 'human' && /request-conflict/.test(h.reason) && h.by === 'parent:drive');
    const again = await f.drive({ once: true });
    assert.deepEqual(again.lines, []);
    assert.equal((await f.entries()).length, es.length);
    assert.equal((await f.log()).filter(x => x.cmd === 'run' && x.executed).length, 0);
  } finally { await f.cleanup(); }
});

test('D8.4: an asking run only notifies (the loop prints it once); an owner-needed node is untouched', { timeout: 180_000 }, async () => {
  const f = await rig(planOf(node('g'), node('h', { review: { count: 1, min_rank: 3 } })));
  try {
    await f.agent('g-writer', 'echo "ASK: which database?"');
    await f.agent('h-writer', 'echo h > h.txt; git add h.txt; git commit -qm h; owed submit h');
    const ac = new AbortController(), timer = setTimeout(() => ac.abort(), 4000);
    const r = await f.drive({ signal: ac.signal, passMs: 100 });
    clearTimeout(timer);
    assert.equal(r.exit, 0); assert.equal(r.lines.at(-1), 'stopped');
    const out = r.lines.join('\n');
    const asks = r.lines.filter(l => /g: writer run .* asks \(qid q1-1, rev 1\): which database\? — the driver never answers/.test(l));
    assert.equal(asks.length, 1, out);
    const owner = r.lines.filter(l => /^h: needs the owner \(review requires rank 3/.test(l));
    assert.equal(owner.length, 1, out);
    const es = await f.entries();
    assert.equal(kinds(es, 'send').length, 0, 'never answers');
    assert.equal(kinds(es, 'halt').length, 0);
    assert.ok(es.some(e => e.kind === 'submit' && e.node === 'h'));
    assert.ok(!es.some(e => e.kind === 'obs' && e.subject === 'h'), 'owner-needed: no attest');
    assert.ok(!es.some(e => e.kind === 'launch' && e.node === 'h' && e.role === 'reviewer'), 'owner-needed: no reviewer');
    assert.equal((await f.log()).filter(x => x.cmd === 'send').length, 0);
    // --once prints the notify every pass.
    assert.equal((await f.drive({ once: true })).lines.filter(l => /which database/.test(l)).length, 1);
  } finally { await f.cleanup(); }
});

test('attest lease: busy (75) queues nothing and retries; granted runs attest; an old dsa is an attest error', { timeout: 180_000 }, async () => {
  const f = await rig(planOf(node('k', { checks: [{ id: 'k', run: 'test -f k.txt', reads: ['k.txt'] }] })));
  try {
    await f.agent('k-writer', 'echo k > k.txt; git add k.txt; git commit -qm k; owed submit k');
    await f.drive({ once: true }); await f.drive({ once: true });
    assert.ok((await f.entries()).some(e => e.kind === 'submit'));
    const obs = async () => (await f.entries()).filter(e => e.kind === 'obs' && e.subject === 'k').length;
    for (const leases of [
      [{ resource: 'machine', holders: [{ mode: 'exclusive', who: 'pid 1 `make bench`' }], waiters: [] }],
      [{ resource: 'machine', holders: [{ mode: 'shared', who: 'pid 2' }], waiters: [{ mode: 'exclusive', who: 'pid 3' }] }],
    ]) {
      await f.file('leases.json', JSON.stringify(leases));
      const r = await f.drive({ once: true });
      assert.match(r.lines.join('\n'), /attest k: busy — machine lease refused, retry next pass: hold: machine is not free now \(pid .*not running the command \(exit 75\)/);
      assert.equal(await obs(), 0, 'no attest ran');
    }
    const holds = (await f.log()).filter(x => x.cmd === 'hold');
    assert.deepEqual(holds.map(x => [x.refused, x.exit]), [[true, 75], [true, 75]]);
    assert.ok(holds.every(x => !x.queued));
    // Old dsa (< 1.0.27): hold rejects --no-wait: an attest error that halts, not a busy machine.
    await f.file('leases.json', '[]'); await f.file('old-hold', '');
    const old = await f.drive({ once: true });
    assert.match(old.lines.join('\n'), /attest k: error — hold refused \(owed drive requires pi-durable-subagents >= 1\.0\.27/);
    const h = kinds(await f.entries(), 'halt')[0] as Extract<Entry, { kind: 'halt' }>;
    assert.ok(h && /Unknown option --no-wait/.test(h.reason) && /1\.0\.27/.test(h.reason));
    // A human clears the halt (here: a ruling naming the node); a shared holder alone does not block.
    await ops.rule({ cwd: f.cwd, as: { role: 'parent', id: 'main' }, text: 'dsa upgraded', nodes: ['k'] });
    await rm(join(f.dir, 'old-hold'));
    await f.file('leases.json', JSON.stringify([{ resource: 'machine', holders: [{ mode: 'shared', who: 'pid 4' }], waiters: [] }]));
    const ok = await f.drive({ once: true });
    assert.match(ok.lines.join('\n'), /attest k: done/);
    assert.ok(await obs() > 0);
    const granted = (await f.log()).filter(x => x.cmd === 'hold' && x.granted);
    assert.equal(granted.length, 1); assert.equal(granted[0]!.mode, 'shared'); assert.ok(granted[0]!.noWait && !granted[0]!.queued);
  } finally { await f.cleanup(); }
});

test('a describe still reporting the sealed generation after an applied follow-up sends no second follow-up', { timeout: 180_000 }, async () => {
  const f = await rig(planOf(node('m')));
  try {
    await f.agent('m-writer-1', 'echo m > m.txt; git add m.txt; git commit -qm m; echo "STATUS: unknown"');
    await f.agent('m-writer-2', 'owed submit m');
    await f.file('stale-describe', '3');
    const r = await f.drive();
    assert.equal(r.exit, 0, r.lines.join('\n'));
    const es = await f.entries();
    assert.ok(merged(es, 'm'), r.lines.join('\n'));
    assert.deepEqual((kinds(es, 'send') as Extract<Entry, { kind: 'send' }>[]).map(x => x.reason), ['interrupted']);
    assert.equal(kinds(es, 'halt').length, 0);
    const log = await f.log();
    assert.ok(log.filter(x => x.cmd === 'describe' && x.stale).length >= 1, 'the stale describe was served');
    assert.equal(log.filter(x => x.cmd === 'send').length, 1);
  } finally { await f.cleanup(); }
});
