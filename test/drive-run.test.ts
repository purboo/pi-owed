// owed drive end to end against the fake dsa (contract D8.2–D8.4): the executor, crash safety, refusals, leases.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFile, execFileSync, spawn } from 'node:child_process';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owedExtension from '../src/extension.ts';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { Dsa } from '../src/dsa.ts';
import { busyKey, drive, driveOnce } from '../src/drive-run.ts';
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
    async drive(o: { once?: boolean; signal?: AbortSignal; passMs?: number; owed?: string[]; dsa?: Dsa } = {}) {
      const lines: string[] = [];
      const exit = await drive({ cwd: r.cwd, once: o.once, dsa: o.dsa ?? dsa, owed: o.owed, log: l => lines.push(l), pollMs: 50, passMs: o.passMs ?? 300, handleSignals: false, signal: o.signal });
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
    assert.match(old.lines.join('\n'), /attest k: error — pi-durable-subagents hold refused: .*Unknown option --no-wait.*\(owed drive requires pi-durable-subagents >= 1\.0\.27/);
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

// ---------- D14: verdicts are durable when they happen ----------
const halts = (es: Entry[]) => kinds(es, 'halt') as Extract<Entry, { kind: 'halt' }>[];
const sleepMs = (ms: number) => new Promise(r => setTimeout(r, ms));
async function loopFor(f: Awaited<ReturnType<typeof rig>>, ms: number, o: { passMs?: number } = {}) {
  const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
  try { return await f.drive({ signal: ac.signal, passMs: o.passMs ?? 200 }); } finally { clearTimeout(t); }
}

test('D14.1: dsa run exit 1 halts in the same pass; --once ×4 gives one halt and no re-launch', { timeout: 120_000 }, async () => {
  const f = await rig(planOf(node('n')));
  try {
    await f.file('faults', 'run 1 none\nrun 1 none\nrun 1 none\n');
    const out: string[] = [];
    for (let i = 0; i < 4; i++) out.push(...(await f.drive({ once: true })).lines);
    const es = await f.entries();
    assert.deepEqual(es.map(e => e.kind), ['genesis', 'dispatch', 'launch', 'halt'], out.join('\n'));
    const h = halts(es)[0]!;
    assert.equal(h.needs, 'human'); assert.match(h.reason, /^dsa rejected run owed:[0-9a-f]{12}:n:1:writer: fault; this attempt's request is fixed; fix the cause \(plan, agent, model\), then `owed abandon n` to start a new attempt$/);
    assert.match(out.join('\n'), /launch n writer .*: rejected — fault; halted/);
    assert.equal((await f.log()).filter(x => x.cmd === 'run').length, 1, 'never re-launched while halted');
  } finally { await f.cleanup(); }
});

test('D14.1/4: after a human clears the halt the next pass relaunches with the same id and bytes', { timeout: 120_000 }, async () => {
  const f = await rig(planOf(node('n')));
  try {
    await f.file('faults', 'run 1 none\n');
    await f.drive({ once: true }); await f.drive({ once: true });
    assert.equal(halts(await f.entries()).length, 1);
    await ops.rule({ cwd: f.cwd, as: { role: 'parent', id: 'main' }, text: 'agent config fixed', nodes: ['n'] });
    const r = await f.drive({ once: true });
    assert.match(r.lines.join('\n'), /launch n writer owed:[0-9a-f]{12}:n:1:writer: applied — created/);
    const runs = (await f.log()).filter(x => x.cmd === 'run');
    assert.deepEqual(runs.map(x => [x.request, x.exit]), [[runs[0]!.request, 1], [runs[0]!.request, 0]]);
    assert.equal(kinds(await f.entries(), 'launch').length, 1, 'the same launch entry');
  } finally { await f.cleanup(); }
});

test('D14.2: merge refused with `rebase needed` rebases in the same pass', { timeout: 180_000 }, async () => {
  const f = await rig(planOf(node('p', { writes: ['shared.txt'] })));
  try {
    await f.put('shared.txt', 'base\n'); await f.commit();
    await ops.adopt({ cwd: f.cwd, as: { role: 'owner', id: 'human' }, channel: 'flag', note: 'seed shared.txt' });
    await f.agent('p-writer', 'echo writer > shared.txt; git commit -qam p; owed submit p');
    assert.ok(await f.once(6, async () => (await ops.status({ cwd: f.cwd })).nodes.p!.accepted), f.out.join('\n'));
    await f.put('shared.txt', 'trunk\n'); await f.commit();
    await ops.adopt({ cwd: f.cwd, as: { role: 'owner', id: 'human' }, channel: 'flag', note: 'hotfix on trunk' });
    const before = (await f.entries()).length;
    const r = await f.drive({ once: true });
    assert.match(r.lines.join('\n'), /merge p: rebased — merge refused \(rebase needed/);
    const added = (await f.entries()).slice(before);
    assert.deepEqual(added.map(e => [e.kind, e.by]), [['rebase', 'parent:drive']]);
    assert.equal(halts(await f.entries()).length, 0);
  } finally { await f.cleanup(); }
});

test('D14.3: owed attest exiting 2 halts needing a human in the same pass', { timeout: 120_000 }, async () => {
  const f = await rig(planOf(node('q', { checks: [{ id: 'q', run: 'true' }] })));
  try {
    await f.agent('q-writer', 'echo q > q.txt; git add q.txt; git commit -qm q; owed submit q');
    const bad = join(f.root, 'bad-owed');
    await writeFile(bad, '#!/bin/sh\necho "Usage error: attest is broken here" >&2\nexit 2\n'); await chmod(bad, 0o755);
    await f.drive({ once: true }); await f.drive({ once: true });
    const r = await f.drive({ once: true, owed: [bad] });
    assert.match(r.lines.join('\n'), /attest q: error — owed attest exited 2: Usage error: attest is broken here; halted/);
    const h = halts(await f.entries());
    assert.equal(h.length, 1); assert.equal(h[0]!.needs, 'human'); assert.match(h[0]!.reason, /^attest error: owed attest exited 2: Usage error/);
    assert.deepEqual((await f.drive({ once: true, owed: [bad] })).lines, [], 'halted: no further attest');
  } finally { await f.cleanup(); }
});

test('D14.7: a rejected or expired events cursor is reset to the head', { timeout: 120_000 }, async () => {
  const f = await rig(planOf(node('g')));
  try {
    await f.agent('g-writer', 'echo "ASK: keep going?"');
    const cursor = join(process.env.OWED_DIR!, 'drive', 'cursor');
    await mkdir(join(process.env.OWED_DIR!, 'drive'), { recursive: true });
    await writeFile(cursor, 'not-a-cursor\n');
    const a = await loopFor(f, 1200);
    assert.match(a.lines.join('\n'), /events: cursor rejected \(malformed cursor not-a-cursor\), reset to \d+:\d+/);
    assert.match(await readFile(cursor, 'utf8'), /^\d+:\d+\n$/);
    await writeFile(cursor, 'other-epoch:3\n');
    const b = await loopFor(f, 1200);
    assert.match(b.lines.join('\n'), /events: cursor expired, reset to \d+:\d+/);
    assert.match(await readFile(cursor, 'utf8'), /^\d+:\d+\n$/);
  } finally { await f.cleanup(); }
});

test('D14.6: a busy machine is printed once although hold reports a different age every pass', { timeout: 120_000 }, async () => {
  assert.equal(busyKey('hold: machine is not free now (pid 7 `sleep 6` (exclusive, 2s)); not running the command (exit 75)'), busyKey('hold: machine is not free now (pid 7 `sleep 6` (exclusive, 13s)); not running the command (exit 75)'));
  assert.notEqual(busyKey('hold: machine is not free now (pid 7 (exclusive, 2s))'), busyKey('hold: machine is not free now (pid 8 (exclusive, 2s))'));
  const f = await rig(planOf(node('k', { checks: [{ id: 'k', run: 'true' }] })));
  try {
    await f.agent('k-writer', 'echo k > k.txt; git add k.txt; git commit -qm k; owed submit k');
    await f.drive({ once: true }); await f.drive({ once: true });
    await f.file('leases.json', JSON.stringify([{ resource: 'machine', holders: [{ mode: 'exclusive', who: 'pid 1 `make bench`', since: Date.now() - 5000 }], waiters: [] }]));
    const r = await loopFor(f, 3500, { passMs: 250 });
    const refused = (await f.log()).filter(x => x.cmd === 'hold' && x.refused).length;
    assert.ok(refused >= 3, `several passes attested (${refused})`);
    assert.equal(r.lines.filter(l => /attest k: busy/.test(l)).length, 1, r.lines.join('\n'));
  } finally { await f.cleanup(); }
});

test('D14.8: a second SIGINT stops the loop at once: hold killed, lock released, exit 130', { timeout: 180_000 }, async () => {
  // The check marks that attest runs, then takes long.
  const mark = join(tmpdir(), `owed-drive-sig-${process.pid}-${Date.now()}`);
  const g = await rig(planOf(node('sigtest', { checks: [{ id: 'sigtest', run: `touch ${mark}; sleep 31.5` }] })));
  try {
    await g.agent('sigtest-writer', 'echo s > sigtest.txt; git add sigtest.txt; git commit -qm s; owed submit sigtest');
    const child = spawn(process.execPath, [OWED, 'drive'], { cwd: g.cwd, env: { ...process.env, ...g.env, OWED_DSA: FAKE }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
    for (let i = 0; i < 600 && !existsSync(mark); i++) await sleepMs(100);
    assert.ok(existsSync(mark), `attest started\n${stdout}\n${stderr}`);
    const lock = join(process.env.OWED_DIR!, 'drive.lock');
    assert.ok(existsSync(lock));
    const t0 = Date.now();
    child.kill('SIGINT'); await sleepMs(300); child.kill('SIGINT');
    assert.equal(await exited, 130, `${stdout}\n${stderr}`);
    assert.ok(Date.now() - t0 < 10_000, 'at once, not after the 31 s check');
    assert.match(stdout, /killed: second signal/);
    assert.ok(!existsSync(lock), 'lock released');
    await sleepMs(300);
    const holds = (() => { try { return execFileSync('pgrep', ['-f', 'hold machine.*attest sigtest'], { encoding: 'utf8' }); } catch { return ''; } })();
    assert.equal(holds.trim(), '', 'the hold child is gone');
  } finally {
    // The check runs in its own process group (src/exec.ts), which `owed attest` does not end on SIGTERM: end it here.
    let leaders = ''; try { leaders = execFileSync('pgrep', ['-f', `touch ${mark}; sleep 31.5`], { encoding: 'utf8' }); } catch { /* none left */ }
    for (const pid of leaders.split('\n').filter(Boolean).map(Number)) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } }
    await rm(mark, { force: true });
    await g.cleanup();
  }
});

test('D14.8: the pi tool pass keeps the output of executed actions when a later action throws', { timeout: 120_000 }, async () => {
  const f = await rig(planOf(node('u'), node('v')));
  try {
    await f.drive({ once: true });
    const d = new Dsa({ bin: FAKE, env: f.env, timeoutMs: 120_000 }), run = d.run.bind(d);
    let calls = 0;
    d.run = async (...a: Parameters<Dsa['run']>) => { if (++calls === 2) throw new Error('boom'); return run(...a); };
    const r = await driveOnce({ cwd: f.cwd, dsa: d });
    assert.equal(r.error, 'boom');
    assert.equal(r.lines.length, 1); assert.match(r.lines[0]!, /^launch u writer .*: applied — created$/);
    assert.ok(!existsSync(join(process.env.OWED_DIR!, 'drive.lock')), 'lock released after the throw');
  } finally { await f.cleanup(); }
});

test('D14.9: a lock of another host is never taken over; the refusal says how to clear it', { timeout: 60_000 }, async () => {
  const f = await rig(planOf(node('w')));
  try {
    const lock = join(process.env.OWED_DIR!, 'drive.lock');
    await writeFile(lock, JSON.stringify({ pid: 2 ** 22 + 9, host: 'elsewhere.example', at: 'then', token: 'x' }));
    await assert.rejects(f.drive({ once: true }), /held by pid \d+ on host elsewhere\.example .*never taken over.*remove .*drive\.lock by hand/);
    assert.ok(existsSync(lock));
  } finally { await f.cleanup(); }
});

test('D15.1: a dsa rejection is fixed for the attempt: a ruling clears, the retry re-halts with the abandon text, abandon → attempt 2 launches', { timeout: 120_000 }, async () => {
  const f = await rig(planOf(node('n')));
  const fixed = "this attempt's request is fixed; fix the cause (plan, agent, model), then `owed abandon n` to start a new attempt";
  try {
    await f.file('faults', 'run 1 none\nrun 1 none\n');
    await f.drive({ once: true }); await f.drive({ once: true });
    assert.equal(halts(await f.entries()).length, 1);
    assert.ok(halts(await f.entries())[0]!.reason.endsWith(fixed));
    await ops.rule({ cwd: f.cwd, as: { role: 'parent', id: 'main' }, text: 'agent config fixed', nodes: ['n'] });
    const again = await f.drive({ once: true });
    assert.match(again.lines.join('\n'), /launch n writer owed:[0-9a-f]{12}:n:1:writer: rejected — fault; halted/);
    const h = halts(await f.entries());
    assert.equal(h.length, 2); assert.equal(h[1]!.attempt, 1); assert.ok(h[1]!.reason.endsWith(fixed), h[1]!.reason);
    const first = (await f.log()).filter(x => x.cmd === 'run');
    assert.deepEqual(first.map(x => [x.request, x.exit]), [[first[0]!.request, 1], [first[0]!.request, 1]], 'the same id both times');
    await ops.abandon({ cwd: f.cwd, as: { role: 'parent', id: 'main' }, node: 'n', reason: 'dsa rejected attempt 1' });
    const out = [...(await f.drive({ once: true })).lines, ...(await f.drive({ once: true })).lines];
    assert.match(out.join('\n'), /launch n writer owed:[0-9a-f]{12}:n:2:writer: applied — created/, out.join('\n'));
    const runs = (await f.log()).filter(x => x.cmd === 'run');
    assert.equal(runs.length, 3); assert.match(String(runs[2]!.request), /:n:2:writer$/); assert.equal(runs[2]!.exit, 0);
    assert.equal(halts(await f.entries()).length, 2);
  } finally { await f.cleanup(); }
});

test('D15.2: merge refused with the transient `Plan, candidate or trunk changed; retry` retries next pass without a halt', { timeout: 180_000 }, async () => {
  // The invariant runs on the merge result; armed once, it submits the slot again while merge measures, so merge's
  // final stability check refuses with the transient message.
  const race = `if [ -n "$OWED_RACE_WT" ] && mkdir "$OWED_RACE_DONE" 2>/dev/null; then cd "$OWED_RACE_WT" && "$OWED_RACE_NODE" "$OWED_RACE_CLI" submit r >/dev/null; fi; true`;
  const f = await rig({ ...planOf(node('r')), invariants: [{ id: 'race', run: race, reads: ['r.txt'] }] });
  const done = join(f.root, 'race-done');
  try {
    await f.agent('r-writer', 'echo r > r.txt; git add r.txt; git commit -qm r; owed submit r');
    assert.ok(await f.once(6, async () => (await ops.status({ cwd: f.cwd })).nodes.r!.accepted), f.out.join('\n'));
    const s = await ops.status({ cwd: f.cwd });
    Object.assign(process.env, { OWED_RACE_WT: s.nodes.r!.slot!.worktree, OWED_RACE_DONE: done, OWED_RACE_NODE: process.execPath, OWED_RACE_CLI: OWED });
    const before = (await f.entries()).length;
    const r = await f.drive({ once: true });
    assert.ok(existsSync(done), 'the race ran');
    assert.match(r.lines.join('\n'), /merge r: retry — merge refused \(Plan, candidate or trunk changed; retry\); retry next pass/, r.lines.join('\n'));
    const added = (await f.entries()).slice(before);
    assert.deepEqual(added.map(e => e.kind), ['submit'], 'only the racing submit; merge recorded nothing and no halt');
    assert.ok(await f.once(6, async () => merged(await f.entries(), 'r')), f.out.join('\n'));
    assert.equal(halts(await f.entries()).length, 0);
  } finally {
    for (const k of ['OWED_RACE_WT', 'OWED_RACE_DONE', 'OWED_RACE_NODE', 'OWED_RACE_CLI']) delete process.env[k];
    await f.cleanup();
  }
});

test('D15.2/D14.2: trunk CAS drift is not the transient refusal: merge halts needing the owner', { timeout: 180_000 }, async () => {
  const f = await rig(planOf(node('t')));
  try {
    await f.agent('t-writer', 'echo t > t.txt; git add t.txt; git commit -qm t; owed submit t');
    assert.ok(await f.once(6, async () => (await ops.status({ cwd: f.cwd })).nodes.t!.accepted), f.out.join('\n'));
    // trunk moves outside owed (no adopt): the ledger trunk no longer matches refs/heads/main.
    await f.put('other.txt', 'x\n'); await f.commit();
    const r = await f.drive({ once: true });
    assert.match(r.lines.join('\n'), /merge t: refused — trunk changed \(CAS\).*; halted \(needs owner\)/, r.lines.join('\n'));
    assert.doesNotMatch(r.lines.join('\n'), /retry next pass/);
    const h = halts(await f.entries());
    assert.equal(h.length, 1); assert.equal(h[0]!.needs, 'owner'); assert.match(h[0]!.reason, /^merge refused: trunk changed \(CAS\)/);
    assert.ok(!merged(await f.entries(), 't'));
  } finally { await f.cleanup(); }
});

test('D15.2/D14.2: any other merge refusal (an invariant failing on the merge result) halts needing a human, no retry', { timeout: 180_000 }, async () => {
  const f = await rig({ ...planOf(node('z')), invariants: [{ id: 'no-z', run: 'test ! -f z.txt', reads: ['z.txt'] }] });
  try {
    await f.agent('z-writer', 'echo z > z.txt; git add z.txt; git commit -qm z; owed submit z');
    assert.ok(await f.once(6, async () => (await ops.status({ cwd: f.cwd })).nodes.z!.accepted), f.out.join('\n'));
    const r = await f.drive({ once: true });
    const out = r.lines.join('\n');
    assert.match(out, /merge z: refused — .*; halted \(needs human\)/, out);
    assert.doesNotMatch(out, /retry next pass/);
    const h = halts(await f.entries());
    assert.equal(h.length, 1); assert.equal(h[0]!.needs, 'human'); assert.match(h[0]!.reason, /^merge refused: /);
    assert.doesNotMatch(h[0]!.reason, /Plan, candidate or trunk changed/);
    assert.ok(!merged(await f.entries(), 'z'));
    assert.deepEqual((await f.drive({ once: true })).lines, [], 'halted: no further merge');
  } finally { await f.cleanup(); }
});
