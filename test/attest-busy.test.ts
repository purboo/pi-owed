// K1 (0.7): per-node attest locks; a held attest lock is `busy` (exit 75), not an internal error; lock timeouts are
// `busy`; CLI --json errors on stdout; no attest advice to a writer while a driver runs.
// Module members new in 0.7 are read through namespaces, so on 0.6.1 these tests fail by assertion, not at import.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import * as ops from '../src/ops.ts';
import * as ledgerMod from '../src/ledger.ts';
import * as views from '../src/views.ts';
import { Ledger } from '../src/ledger.ts';
import { OwedError } from '../src/errors.ts';
import { sha256 } from '../src/canon.ts';
import { git } from '../src/git.ts';
import { reduce } from '../src/reducer.ts';
import { writerTask } from '../src/drive.ts';
import { parsePlan } from '../src/plan.ts';
import owed from '../src/extension.ts';
import type { Entry, Plan } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const owner = { role: 'owner' as const, id: 'human' };
const parent = { role: 'parent' as const, id: 'main' };
type Repo = Awaited<ReturnType<typeof repo>>;
type Owner = { pid: number; host: string; ts: string };
const FOREIGN: Owner = { pid: 1, host: 'other-host.invalid', ts: '2026-01-01T00:00:00.000Z' };
const OTHER = 'other-host.invalid';

const lockName = (node: string): string => `attest-${sha256(node).slice(0, 16)}`;
/** The test hook of 0.7 (`lockWait.ms`); absent on 0.6.1, where every wait is 60 s. */
function shortWait(ms: number): () => void {
  const hook = (ledgerMod as unknown as { lockWait?: { ms: number } }).lockWait;
  if (!hook) return () => {};
  const before = hook.ms; hook.ms = ms;
  return () => { hook.ms = before; };
}
/** Holds lock `name` in this (live) process until release(): a gate, not a timer. Returns the owner it wrote. */
async function hold(l: Ledger, name?: string): Promise<{ owner: Owner; release(): Promise<void> }> {
  let open!: () => void, acquired!: () => void;
  const gate = new Promise<void>(r => { open = r; }), got = new Promise<void>(r => { acquired = r; });
  const done = l.withLock(async () => { acquired(); await gate; }, name);
  await Promise.race([got, done]);
  const o = JSON.parse(await readFile(join(l.dir, name ?? 'lock', 'owner.json'), 'utf8')) as Owner;
  return { owner: { pid: o.pid, host: o.host, ts: o.ts }, async release() { open(); await done; } };
}
/** A lock directory `name` whose owner is `o` (another host, or a dead pid of this host). */
async function plant(l: Ledger, name: string, o: Owner): Promise<{ release(): Promise<void> }> {
  await mkdir(join(l.dir, name));
  await writeFile(join(l.dir, name, 'owner.json'), JSON.stringify({ ...o, token: 'planted' }));
  return { async release() { await rm(join(l.dir, name), { recursive: true, force: true }); } };
}
/** The settled value or error of `p`, or 'pending' if it did not settle within `ms` (a bound, not a timing assumption). */
async function settled<T>(p: Promise<T>, ms = 20_000): Promise<T | unknown> {
  let t: NodeJS.Timeout | undefined;
  try { return await Promise.race([p.catch((e: unknown) => e), new Promise(r => { t = setTimeout(() => r('pending'), ms); })]); } finally { clearTimeout(t); }
}
const entries = async (cwd: string): Promise<Entry[]> => (await Ledger.open(cwd)).read();
const busyText = (node: string, o: Owner) => `attest of ${node} is already running (pid ${o.pid} on ${o.host} since ${o.ts}); its observations will appear in owed why ${node}`;
const isBusy = (out: unknown, message: string) => out instanceof OwedError && out.code === 'busy' && out.message === message;

/** Initializes `nodes` (id → check command), dispatches each (as `as`) and submits one commit per node. */
async function setup(r: Repo, nodes: Record<string, string>, as = parent): Promise<Record<string, string>> {
  await commitAt(r.cwd, { README: 'x\n' });
  const plan = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: Object.entries(nodes).map(([id, run]) => ({ id, writes: [`${id}/`], checks: [{ id: 'k', run }], review: { count: 0, min_rank: 1 } })) };
  await ops.init({ cwd: r.cwd, plan: JSON.stringify(plan), as: owner, channel: 'flag' });
  const trees: Record<string, string> = {};
  for (const id of Object.keys(nodes)) {
    const d = await ops.dispatch({ cwd: r.cwd, node: id, as });
    await commitAt(d.worktree, { [`${id}/f.txt`]: `${id}\n` });
    await ops.submit({ cwd: d.worktree, node: id, as: { role: 'writer', id: `${id}#1` } });
    trees[id] = d.worktree;
  }
  return trees;
}

test('K1.1: the attest lock of a node is attest-<first 16 hex of sha256(node id)>', () => {
  const f = (ops as unknown as { attestLock?: (n: string) => string }).attestLock;
  assert.equal(typeof f, 'function', 'ops.attestLock exists');
  assert.equal(f!('a'), lockName('a'));
  assert.match(f!('node-x'), /^attest-[0-9a-f]{16}$/);
  assert.notEqual(f!('a'), f!('b'));
});

test('K1.1: attests of different nodes run in parallel, in distinct temporary worktrees and git admin directories', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    const m = join(r.root, 'm'); await mkdir(m);
    // Each check records its git dir, then waits (bounded) for the other node's check: it passes only when both run at once.
    const run = (me: string, other: string) => `git rev-parse --absolute-git-dir > '${m}/${me}.tmp' && pwd >> '${m}/${me}.tmp' && mv '${m}/${me}.tmp' '${m}/${me}'; i=0; while [ ! -f '${m}/${other}' ]; do i=$((i+1)); [ $i -gt 400 ] && exit 1; sleep 0.05; done; exit 0`;
    await setup(r, { a: run('a', 'b'), b: run('b', 'a') });
    const before = (await entries(r.cwd)).length;
    const [ra, rb] = await Promise.all([ops.attest({ cwd: r.cwd, node: 'a' }), ops.attest({ cwd: r.cwd, node: 'b' })]);
    const obs = (await entries(r.cwd)).slice(before).filter(e => e.kind === 'obs');
    const verdict = (node: string) => obs.filter(e => e.kind === 'obs' && e.subject === node && e.obligation === 'check:k').map(e => e.kind === 'obs' ? e.verdict : '');
    assert.deepEqual(verdict('a'), ['pass'], 'a ran while b ran');
    assert.deepEqual(verdict('b'), ['pass'], 'b ran while a ran');
    assert.ok(ra.observations.length > 0 && rb.observations.length > 0);
    const [ga, gb] = [await readFile(join(m, 'a'), 'utf8'), await readFile(join(m, 'b'), 'utf8')].map(t => t.trim().split('\n'));
    assert.notEqual(ga![0], gb![0], 'distinct git worktree admin directories');
    assert.notEqual(ga![1], gb![1], 'distinct temporary worktrees');
    // Every temporary worktree and its registration is gone; every observation log blob is readable.
    const list = (await git(r.cwd, ['worktree', 'list', '--porcelain'])).stdout;
    assert.doesNotMatch(list, /owed-run-/, 'no temporary worktree is left registered');
    const l = await Ledger.open(r.cwd);
    for (const e of obs) if (e.kind === 'obs') { assert.ok(e.log, 'a log blob'); await l.getBlob(e.log!); }
    assert.deepEqual((await readdir(l.dir)).filter(n => /^\.?(lock|attest)/.test(n)), [], 'no lock directory is left');
  } finally { await r.cleanup(); }
});

test('K1.2: attest of a node whose attest lock a live process holds is busy at once; another node is not blocked', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    await setup(r, { a: 'true', b: 'true' });
    const l = await Ledger.open(r.cwd), h = await hold(l, lockName('a'));
    let out: unknown;
    try {
      const t0 = Date.now();
      out = await settled(ops.attest({ cwd: r.cwd, node: 'a' }));
      assert.ok(isBusy(out, busyText('a', h.owner)), `busy with the holder named: ${String(out)}`);
      assert.ok(Date.now() - t0 < 10_000, 'without waiting for the lock');
      assert.equal(h.owner.pid, process.pid); assert.equal(h.owner.host, hostname());
      const b = await settled(ops.attest({ cwd: r.cwd, node: 'b' }));
      assert.ok(b && typeof b === 'object' && 'node' in b && b.node === 'b', `b attests while a's lock is held: ${String(b)}`);
    } finally { await h.release(); }
  } finally { await r.cleanup(); }
});

test('K1.2: CLI attest while the node is attested elsewhere exits 75 (Busy: …); --json adds {"error","code":"busy"} on stdout', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    await setup(r, { a: 'true' });
    const l = await Ledger.open(r.cwd), h = await hold(l, lockName('a'));
    try {
      const text = await cli(r.cwd, ['attest', 'a']);
      assert.equal(text.code, 75, text.stderr);
      assert.equal(text.stderr.trim(), `Busy: ${busyText('a', h.owner)}`);
      assert.equal(text.stdout, '');
      const json = await cli(r.cwd, ['attest', 'a', '--json']);
      assert.equal(json.code, 75, json.stderr);
      assert.deepEqual(JSON.parse(json.stdout), { error: busyText('a', h.owner), code: 'busy' });
      assert.equal(json.stderr.trim(), `Busy: ${busyText('a', h.owner)}`);
    } finally { await h.release(); }
  } finally { await r.cleanup(); }
});

test('K1.2: owed_attest returns the busy message as a tool error', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    await setup(r, { a: 'true' });
    const tools = new Map<string, ToolDefinition>();
    owed({ registerTool(t: ToolDefinition) { tools.set(t.name, t); }, registerCommand() {}, on() {} } as unknown as ExtensionAPI);
    const ctx = { cwd: r.cwd, hasUI: false, ui: { notify() {} } } as unknown as ExtensionContext;
    const l = await Ledger.open(r.cwd), h = await hold(l, lockName('a'));
    try {
      const res = await tools.get('owed_attest')!.execute('t', { node: 'a' }, undefined, undefined, ctx as Parameters<ToolDefinition['execute']>[4]) as { isError?: boolean; content: { text: string }[]; details: unknown };
      assert.equal(res.isError, true);
      assert.equal(res.content[0]!.text, `Busy: ${busyText('a', h.owner)}`);
      assert.deepEqual(res.details, { code: 'busy', reason: busyText('a', h.owner) });
    } finally { await h.release(); }
  } finally { await r.cleanup(); }
});

test('K1.2: attest --genesis while a live process holds the genesis lock is busy at once', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    await commitAt(r.cwd, { README: 'x\n' });
    await ops.init({ cwd: r.cwd, plan: JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [{ id: 'i', run: 'true' }], nodes: [] }), as: owner, channel: 'flag', measure: false });
    const l = await Ledger.open(r.cwd), h = await hold(l, 'genesis');
    try {
      const out = await settled(ops.attestGenesis({ cwd: r.cwd }), 10_000);
      assert.ok(isBusy(out, `attest --genesis is already running (pid ${h.owner.pid} on ${h.owner.host} since ${h.owner.ts}); its observations will appear in owed status`), String(out));
    } finally { await h.release(); }
  } finally { await r.cleanup(); }
});

test('K1.2: an attest lock of another host is waited for, then busy with that host named', { timeout: 120_000 }, async () => {
  const r = await repo(), restore = shortWait(1500);
  try {
    await setup(r, { a: 'true' });
    const l = await Ledger.open(r.cwd), p = await plant(l, lockName('a'), FOREIGN);
    try {
      const t0 = Date.now(), out = await settled(ops.attest({ cwd: r.cwd, node: 'a' }));
      assert.ok(isBusy(out, busyText('a', FOREIGN)), `busy on ${OTHER}: ${String(out)}`);
      assert.ok(Date.now() - t0 >= 1400, 'it waited (no live check of another host)');
    } finally { await p.release(); }
  } finally { restore(); await r.cleanup(); }
});

test('K1.2: a dead owner of an attest lock on this host is reaped and the attest runs', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    await setup(r, { a: 'true' });
    const dead = spawnSync(process.execPath, ['-e', '']).pid!;
    const l = await Ledger.open(r.cwd);
    await plant(l, lockName('a'), { pid: dead, host: hostname(), ts: FOREIGN.ts });
    const out = await settled(ops.attest({ cwd: r.cwd, node: 'a' }));
    assert.ok(out && typeof out === 'object' && 'node' in out, String(out));
  } finally { await r.cleanup(); }
});

test('K1.2: a timeout on the ledger lock or another lock is busy: "timed out waiting for the <name> lock held by …; retry"', { timeout: 120_000 }, async () => {
  const r = await repo(), restore = shortWait(1000);
  try {
    await commitAt(r.cwd, { README: 'x\n' });
    await ops.init({ cwd: r.cwd, plan: JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [], nodes: [{ id: 'a', writes: ['a/'], checks: [] }] }), as: owner, channel: 'flag' });
    const l = await Ledger.open(r.cwd), held = `pid ${FOREIGN.pid} on ${FOREIGN.host} since ${FOREIGN.ts}`;
    let p = await plant(l, 'lock', FOREIGN);
    try {
      const out = await settled(ops.rule({ cwd: r.cwd, as: parent, text: 'x', nodes: '*' }));
      assert.ok(isBusy(out, `timed out waiting for the ledger lock held by ${held}; retry`), String(out));
    } finally { await p.release(); }
    p = await plant(l, 'dispatch', FOREIGN);
    try {
      const out = await settled(ops.dispatch({ cwd: r.cwd, node: 'a', as: parent }));
      assert.ok(isBusy(out, `timed out waiting for the dispatch lock held by ${held}; retry`), String(out));
    } finally { await p.release(); }
  } finally { restore(); await r.cleanup(); }
});

test('K1.2: a live ledger-lock owner is waited for, not busy (fail-fast is for attest locks only)', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    await commitAt(r.cwd, { README: 'x\n' });
    await ops.init({ cwd: r.cwd, plan: JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [], nodes: [] }), as: owner, channel: 'flag' });
    const l = await Ledger.open(r.cwd), h = await hold(l);
    const p = ops.rule({ cwd: r.cwd, as: parent, text: 'x', nodes: '*' });
    try { assert.equal(await settled(p, 500), 'pending'); } finally { await h.release(); }
    const e = await p; assert.equal(e.kind, 'rule');
  } finally { await r.cleanup(); }
});

test('K1.2: --json failures print {"error","code"} on stdout for refused and usage errors too; stderr and exit codes unchanged', async () => {
  const r = await repo();
  try {
    await commitAt(r.cwd, { README: 'x\n' });
    const usage = await cli(r.cwd, ['attest', '--json']);
    assert.equal(usage.code, 2);
    assert.notEqual(usage.stdout.trim(), '', 'one JSON line on stdout');
    assert.deepEqual(JSON.parse(usage.stdout), { error: 'attest wrong number of arguments', code: 'usage' });
    assert.equal(usage.stderr.trim(), 'Usage error: attest wrong number of arguments');
    const refused = await cli(r.cwd, ['why', 'a', '--json']);
    assert.equal(refused.code, 1, refused.stderr);
    assert.notEqual(refused.stdout.trim(), '', 'one JSON line on stdout');
    const j = JSON.parse(refused.stdout) as { error: string; code: string };
    assert.equal(j.code, 'refused');
    assert.equal(refused.stderr.trim(), `Refused: ${j.error}`);
    const plain = await cli(r.cwd, ['why', 'a']);
    assert.equal(plain.code, 1); assert.equal(plain.stdout, '', 'without --json stdout stays empty');
  } finally { await r.cleanup(); }
});

test('K1.3: an exec block tells the writer to skip owed attest while owed drive runs (why, brief)', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    await setup(r, { a: 'exit 1' });
    await ops.attest({ cwd: r.cwd, node: 'a' });
    const card = await ops.why({ cwd: r.cwd, node: 'a' }), block = card.blocks.find(b => b.kind === 'exec');
    assert.ok(block, 'an exec block');
    assert.match(block.clear, /then owed attest a \(skip this when owed drive is running: the driver attests\)/);
    assert.match(views.renderReceipt(card), /owed attest a \(skip this when owed drive is running: the driver attests\)/);
    const brief = await ops.brief({ cwd: r.cwd });
    assert.match(brief.rejected.find(b => b.node === 'a')!.clear, /\(skip this when owed drive is running: the driver attests\)/);
  } finally { await r.cleanup(); }
});

test('K1.3: the packet of a driver dispatch and the driver writer task say not to run owed attest; a manual dispatch packet does not', { timeout: 120_000 }, async () => {
  const LINE = 'the driver measures your candidate; do not run owed attest';
  const r = await repo();
  try {
    await commitAt(r.cwd, { README: 'x\n' });
    const plan = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: [{ id: 'a', writes: ['a/'], checks: [] }, { id: 'b', writes: ['b/'], checks: [] }] };
    await ops.init({ cwd: r.cwd, plan: JSON.stringify(plan), as: owner, channel: 'flag' });
    const manual = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
    const driven = await ops.dispatch({ cwd: r.cwd, node: 'b', as: { role: 'parent', id: 'drive' } });
    assert.doesNotMatch(manual.packet, /do not run owed attest/);
    assert.equal(driven.packet.split('\n').at(-1), LINE);
    const l = await Ledger.open(r.cwd), all = await l.read(), plans = new Map<string, Plan>();
    for (const e of all) if (e.kind === 'genesis' || e.kind === 'plan') plans.set(e.plan, parsePlan((await l.getBlob(e.plan)).toString()));
    const s = reduce(all, sha => plans.get(sha)!);
    assert.equal(writerTask(s, 'b'), driven.packet, 'the driver task of a driver dispatch is the stored packet');
    assert.equal(writerTask(s, 'a'), `${manual.packet}\n${LINE}`, 'a driver launch of a manual dispatch adds the line');
  } finally { await r.cleanup(); }
});
