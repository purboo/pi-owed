import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { access, readFile, stat, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import * as git from '../src/git.ts';
import { parsePlan } from '../src/plan.ts';
import { Ledger } from '../src/ledger.ts';
import type { Entry } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { commitAt } from './helpers/surface.ts';

// 0.9 merge-speed (contract-0.9.md): M1 exec.parallel, M2 exec.trees: reuse.
const parent = { role: 'parent', id: 'test' } as const, owner = { role: 'owner', id: 'human' } as const;
type Repo = Awaited<ReturnType<typeof repo>>;
const q = (r: Repo, n: string) => `'${join(r.root, n)}'`;
const PASS = `echo '# tests 1'; echo '# pass 1'`;
/** An invariant on `flag` that, on a tree whose flag says `changed`, appends `start <ns>` and `end <ns>` around a sleep of `sleep` s to `<root>/<id>.log`. */
const timed = (r: Repo, id: string, sleep: number) => ({ id, reads: ['flag'], timeout_s: 60, run: `if grep -q changed flag; then echo "start $(date +%s%N)" >> ${q(r, `${id}.log`)}; sleep ${sleep}; echo "end $(date +%s%N)" >> ${q(r, `${id}.log`)}; fi; ${PASS}` });
const check = (id: string) => ({ id, reads: ['flag'], run: PASS });
const planOf = (invs: object[], exec?: object) => ({ version: 1, trunk: 'main', ...(exec ? { exec } : {}), invariants: invs, nodes: [{ id: 'a', writes: ['flag'], checks: [check('ca')] }, { id: 'b', writes: ['other'], checks: [check('cb')] }] });
/** Runs `f`, turning a refusal into an assertion failure (on a build without the feature the plan is refused). */
async function ok<T>(what: string, f: () => Promise<T>): Promise<T> {
  try { return await f(); } catch (e) { assert.fail(`${what} refused: ${e instanceof Error ? e.message : String(e)}`); }
}
/** init, then dispatch `a`, set flag to `changed`, submit and attest it (accepted). */
async function setup(r: Repo, plan: object) {
  await commitAt(r.cwd, { flag: 'base', keep: 'kept file\n', '.gitignore': 'build.out\n' });
  await ok('init', () => ops.init({ cwd: r.cwd, plan: JSON.stringify(plan), as: owner, channel: 'flag' }));
  const a = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent }); await commitAt(a.worktree, { flag: 'changed' });
  await ops.submit({ cwd: a.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
  assert.equal((await ops.attest({ cwd: r.cwd, node: 'a' })).accepted, true);
  return a;
}
async function spans(r: Repo, id: string): Promise<{ start: bigint; end?: bigint }[]> {
  let text = ''; try { text = await readFile(join(r.root, `${id}.log`), 'utf8'); } catch { return []; }
  const out: { start: bigint; end?: bigint }[] = [];
  for (const line of text.split('\n').filter(Boolean)) { const [k, v] = line.split(' '); if (k === 'start') out.push({ start: BigInt(v!) }); else out.at(-1)!.end = BigInt(v!); }
  return out;
}
const overlap = (a: { start: bigint; end?: bigint }, b: { start: bigint; end?: bigint }) => a.start < b.end! && b.start < a.end!;
async function waitFor(path: string, ms = 30_000) { for (let i = 0; i < ms / 20; i++) { try { await access(path); return true; } catch { await new Promise(res => setTimeout(res, 20)); } } return false; }
/** The documented location of reused trees: `<git common dir>/owed/trees`. */
const treesDir = async (r: Repo) => join(await git.commonDir(r.cwd), 'owed', 'trees');
const exists = async (p: string) => { try { await access(p); return true; } catch { return false; } };
const obs = (es: Entry[]) => es.filter(e => e.kind === 'obs');

test('M1: exec.parallel measures merge-tree jobs at once (overlapping timestamps); default 1 stays serial', { timeout: 120_000 }, async () => {
  for (const parallel of [2, undefined]) {
    const r = await repo();
    try {
      await setup(r, planOf([timed(r, 's1', 1), timed(r, 's2', 1)], parallel ? { parallel } : undefined));
      await ok('merge', () => ops.merge({ cwd: r.cwd, node: 'a', as: parent }));
      const [a, b] = [(await spans(r, 's1')).at(-1)!, (await spans(r, 's2')).at(-1)!];
      assert.ok(a?.end && b?.end, 'both invariants ran on the merge tree');
      if (parallel) assert.equal(overlap(a, b), true, `with exec.parallel ${parallel} the two invariants overlap`);
      else assert.equal(overlap(a, b), false, 'without exec.parallel they run one after another');
      assert.equal((await ops.status({ cwd: r.cwd })).nodes.a!.phase, 'merged');
    } finally { await r.cleanup(); }
  }
});

test('M1: genesis attest and adopt also measure in parallel', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    await commitAt(r.cwd, { flag: 'changed' });
    await ok('init', () => ops.init({ cwd: r.cwd, plan: JSON.stringify(planOf([timed(r, 's1', 1), timed(r, 's2', 1)], { parallel: 2 })), as: owner, channel: 'flag' }));
    assert.equal(overlap((await spans(r, 's1'))[0]!, (await spans(r, 's2'))[0]!), true, 'genesis measured both at once');
    await commitAt(r.cwd, { flag: 'changed again' });
    await ok('adopt', () => ops.adopt({ cwd: r.cwd, note: 'outside commit', as: owner, channel: 'flag' }));
    assert.equal(overlap((await spans(r, 's1'))[1]!, (await spans(r, 's2'))[1]!), true, 'adopt measured both at once');
  } finally { await r.cleanup(); }
});

test('M1: observations are recorded in job order whatever order the jobs finish in', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    await setup(r, planOf([timed(r, 'i1', 1.5), timed(r, 'i2', 0.8), timed(r, 'i3', 0)], { parallel: 3 }));
    const ledger = await Ledger.open(r.cwd), before = (await ledger.read()).length;
    await ok('merge', () => ops.merge({ cwd: r.cwd, node: 'a', as: parent }));
    const ends = await Promise.all(['i1', 'i2', 'i3'].map(async id => (await spans(r, id)).at(-1)!.end!));
    assert.ok(ends[2]! < ends[1]! && ends[1]! < ends[0]!, 'the jobs finished in reverse order');
    const added = (await ledger.read()).slice(before);
    assert.deepEqual(obs(added).map(e => e.kind === 'obs' && e.obligation), ['inv:i1', 'inv:i2', 'inv:i3']);
    assert.equal(added.at(-1)!.kind, 'merge');
  } finally { await r.cleanup(); }
});

test('M1: an abort under parallelism kills every running job, starts none, keeps the completed observations', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    // On the merge tree: f is fast; s1 and s2 touch <id>.started, then sleep 4 s and touch <id>.survived; late counts its runs.
    const slow = (id: string) => ({ id, reads: ['flag'], timeout_s: 60, run: `if grep -q changed flag; then touch ${q(r, `${id}.started`)}; sleep 4; touch ${q(r, `${id}.survived`)}; fi; ${PASS}` });
    const late = { id: 'late', reads: ['flag'], timeout_s: 60, run: `echo x >> ${q(r, 'late.count')}; ${PASS}` };
    await setup(r, planOf([{ id: 'f', reads: ['flag'], timeout_s: 60, run: PASS }, slow('s1'), slow('s2'), late], { parallel: 2 }));
    const ledger = await Ledger.open(r.cwd), before = await ledger.read(), lateRuns = (await readFile(join(r.root, 'late.count'), 'utf8')).split('\n').filter(Boolean).length;
    const ac = new AbortController();
    const outcome = ops.merge({ cwd: r.cwd, node: 'a', as: parent, signal: ac.signal }).then(() => undefined, (e: unknown) => e);
    assert.equal(await waitFor(join(r.root, 's1.started')), true, 's1 started');
    assert.equal(await waitFor(join(r.root, 's2.started')), true, 's2 started while s1 runs (f completed)');
    ac.abort();
    const error = await outcome;
    assert.ok(error instanceof Error && /aborted/.test(error.message), `aborted: ${String(error)}`);
    await new Promise(res => setTimeout(res, 5000));
    assert.equal(await exists(join(r.root, 's1.survived')), false, 's1 was killed');
    assert.equal(await exists(join(r.root, 's2.survived')), false, 's2 was killed');
    assert.equal((await readFile(join(r.root, 'late.count'), 'utf8')).split('\n').filter(Boolean).length, lateRuns, 'no job started after the abort');
    const added = (await ledger.read()).slice(before.length);
    assert.deepEqual(added.map(e => e.kind === 'obs' ? `${e.obligation} ${e.verdict} ${e.merging}` : e.kind), ['inv:f pass a'], 'only the completed observation is kept; no merge');
    assert.equal((await ops.status({ cwd: r.cwd })).nodes.a!.phase !== 'merged', true);
  } finally { await r.cleanup(); }
});

test('M1/M2: parallel and trees are in no key; changing them invalidates, downgrades and re-measures nothing; env still does', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    const base = planOf([timed(r, 'u', 0)]);
    await setup(r, base);
    const ledger = await Ledger.open(r.cwd), commit = await git.revParse(r.cwd, 'main');
    const p0 = parsePlan(JSON.stringify(base)), p1 = await ok('parse', async () => parsePlan(JSON.stringify(planOf([timed(r, 'u', 0)], { parallel: 4, trees: 'reuse' }))));
    assert.deepEqual(p1.exec, { parallel: 4, trees: 'reuse' });
    assert.deepEqual((await git.stateFacts(r.cwd, p1, commit)).invKeys, (await git.stateFacts(r.cwd, p0, commit)).invKeys, 'invariant keys unchanged');
    const before = (await ops.status({ cwd: r.cwd })).nodes.a!.candidate!;
    // A parent may set it: no owner authority needed (no downgrade).
    await ok('plan (parent)', () => ops.planSet({ cwd: r.cwd, plan: JSON.stringify(planOf([timed(r, 'u', 0)], { parallel: 4, trees: 'reuse' })), as: parent }));
    const after = (await ledger.read()).at(-1)!;
    assert.ok(after.kind === 'plan' && after.downgrades.length === 0);
    const st = await ops.status({ cwd: r.cwd });
    assert.equal(st.nodes.a!.candidate?.seq, before.seq, 'the open candidate stays current');
    assert.deepEqual((await ops.report({ cwd: r.cwd })).downgrades, [], 'no downgrade recorded');
    assert.equal((await ops.why({ cwd: r.cwd, node: 'a' })).accepted, true, 'nothing to re-measure');
    const n = (await ledger.read()).length;
    assert.equal((await ops.attest({ cwd: r.cwd, node: 'a' })).observations.length, 0, 'attest measures nothing');
    assert.equal((await ledger.read()).length, n);
    // Changing back, or only parallel: still nothing.
    await ok('plan (parent)', () => ops.planSet({ cwd: r.cwd, plan: JSON.stringify(planOf([timed(r, 'u', 0)], { parallel: 1 })), as: parent }));
    assert.equal((await ops.status({ cwd: r.cwd })).nodes.a!.candidate?.seq, before.seq);
    // An env change still invalidates the candidate and records the owner-only '*' exec downgrade.
    await ops.planSet({ cwd: r.cwd, plan: JSON.stringify(planOf([timed(r, 'u', 0)], { parallel: 1, env: { X: '1' } })), as: owner, channel: 'flag' });
    const e = (await ledger.read()).at(-1)!;
    assert.ok(e.kind === 'plan');
    const s2 = await ops.status({ cwd: r.cwd });
    assert.equal(s2.nodes.a!.candidate, undefined, 'env change invalidates the candidate');
    assert.ok(JSON.stringify((await ops.report({ cwd: r.cwd })).downgrades).includes('exec changed'), 'env change records the exec downgrade');
    await assert.rejects(ops.planSet({ cwd: r.cwd, plan: JSON.stringify(planOf([timed(r, 'u', 0)], { parallel: 1, wrap: ['env'] })), as: parent }), /exec changed|owner|downgrade/i, 'a parent cannot change wrap');
  } finally { await r.cleanup(); }
});

test('M1/M2: the exec parser accepts parallel/trees alone, keeps them only when set and refuses bad values', async () => {
  const plan = (exec: object) => JSON.stringify(planOf([], exec));
  assert.deepEqual((await ok('parse', async () => parsePlan(plan({ parallel: 3 })))).exec, { parallel: 3 });
  assert.deepEqual((await ok('parse', async () => parsePlan(plan({ trees: 'fresh' })))).exec, { trees: 'fresh' });
  assert.deepEqual((await ok('parse', async () => parsePlan(plan({ trees: 'reuse', env: {} })))).exec, { trees: 'reuse' });
  assert.equal(parsePlan(plan({})).exec, undefined);
  for (const [exec, msg] of [[{ parallel: 0 }, /exec\.parallel/], [{ parallel: 1.5 }, /exec\.parallel/], [{ parallel: '2' }, /exec\.parallel/], [{ trees: 'shared' }, /exec\.trees/]] as const) assert.throws(() => parsePlan(plan(exec)), msg);
});

test('M2: a reused tree keeps the mtime of an unchanged file and loses an ignored file', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    // The invariant records its directory, the mtime of `keep`, and whether the ignored build.out survived, then creates it.
    const u = { id: 'u', reads: ['flag'], timeout_s: 60, run: `pwd -P >> ${q(r, 'pwd')}; stat -c %Y.%y keep >> ${q(r, 'mtime')}; if test -e build.out; then echo present; else echo absent; fi >> ${q(r, 'ignored')}; echo out > build.out; ${PASS}` };
    await commitAt(r.cwd, { flag: 'one', keep: 'kept file\n', '.gitignore': 'build.out\n' });
    await ok('init', () => ops.init({ cwd: r.cwd, plan: JSON.stringify(planOf([u], { trees: 'reuse' })), as: owner, channel: 'flag' }));
    await new Promise(res => setTimeout(res, 1100));
    await commitAt(r.cwd, { flag: 'two' });
    await ok('adopt', () => ops.adopt({ cwd: r.cwd, note: 'outside commit', as: owner, channel: 'flag' }));
    const lines = async (n: string) => (await readFile(join(r.root, n), 'utf8')).split('\n').filter(Boolean);
    const pwd = await lines('pwd'), mtime = await lines('mtime'), ignored = await lines('ignored');
    assert.equal(pwd.length, 2);
    const dir = await treesDir(r);
    assert.equal(pwd[0], join(await realpathOf(dir), 'inv-u-0'), 'the stable tree <common dir>/owed/trees/inv-u-0');
    assert.equal(pwd[1], pwd[0], 'the same tree is reused');
    assert.equal(mtime[1], mtime[0], 'an unchanged file keeps its mtime');
    assert.deepEqual(ignored, ['absent', 'absent'], 'git clean -ffdx removed the ignored file');
    assert.equal(await exists(join(dir, 'inv-u-0')), true, 'dispose keeps the tree');
    assert.equal(await exists(join(dir, 'inv-u-0.lock')), false, 'dispose releases the lease');
    assert.equal(await git.isClean(r.cwd), true, 'the main worktree sees nothing');
  } finally { await r.cleanup(); }
});
async function realpathOf(p: string) { const { realpath } = await import('node:fs/promises'); return realpath(p); }

test('M2: two concurrent leases of one check get two trees; a free lease is reused first', { timeout: 60_000 }, async () => {
  const r = await repo();
  try {
    const c = await commitAt(r.cwd, { f: '1' });
    const [a, b] = await Promise.all([git.materialize(r.cwd, c, { kind: 'check', id: 'x' }), git.materialize(r.cwd, c, { kind: 'check', id: 'x' })]);
    const dir = await treesDir(r);
    assert.deepEqual([a.path, b.path].sort(), [join(dir, 'check-x-0'), join(dir, 'check-x-1')]);
    const first = a.path.endsWith('-0') ? a : b, second = first === a ? b : a;
    await first.dispose();
    const third = await git.materialize(r.cwd, c, { kind: 'check', id: 'x' });
    assert.equal(third.path, join(dir, 'check-x-0'), 'the lowest free index');
    assert.equal(await readFile(join(third.path, 'f'), 'utf8'), '1');
    await third.dispose(); await second.dispose();
    // A broken tree (its .git file removed) is recreated.
    await writeFile(join(dir, 'check-x-0', '.git'), 'gitdir: /nonexistent\n');
    const again = await git.materialize(r.cwd, c, { kind: 'check', id: 'x' });
    assert.equal(again.path, join(dir, 'check-x-0'));
    assert.equal(await readFile(join(again.path, 'f'), 'utf8'), '1');
    await again.dispose();
  } finally { await r.cleanup(); }
});

test('M2: a lease whose pid is dead is reclaimed; a live one is not', { timeout: 60_000 }, async () => {
  const r = await repo();
  try {
    const c = await commitAt(r.cwd, { f: '1' }), dir = await treesDir(r);
    await mkdir(dir, { recursive: true });
    const dead = await new Promise<number>(res => { const p = spawn('true'); p.on('exit', () => res(p.pid!)); });
    const live = spawn('sleep', ['30']);
    try {
      await writeFile(join(dir, 'inv-y-0.lock'), `${dead}\n`);
      const t = await git.materialize(r.cwd, c, { kind: 'inv', id: 'y' });
      assert.equal(t.path, join(dir, 'inv-y-0'), 'the stale lease is reclaimed');
      assert.equal((await readFile(join(dir, 'inv-y-0.lock'), 'utf8')).trim(), String(process.pid));
      await t.dispose();
      await writeFile(join(dir, 'inv-y-0.lock'), `${live.pid}\n`);
      const u = await git.materialize(r.cwd, c, { kind: 'inv', id: 'y' });
      assert.equal(u.path, join(dir, 'inv-y-1'), 'a live lease is respected');
      await u.dispose();
      assert.equal((await readFile(join(dir, 'inv-y-0.lock'), 'utf8')).trim(), String(live.pid), 'the live lease is untouched');
    } finally { live.kill(); }
  } finally { await r.cleanup(); }
});

test('M2: owed gc removes free reuse trees whose check is gone or when the plan no longer reuses; dry run reports them', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    const u = { id: 'u', reads: ['flag'], timeout_s: 60, run: PASS };
    await commitAt(r.cwd, { flag: 'one' });
    await ok('init', () => ops.init({ cwd: r.cwd, plan: JSON.stringify(planOf([u], { trees: 'reuse' })), as: owner, channel: 'flag' }));
    const dir = await treesDir(r), c = await git.revParse(r.cwd, 'main');
    assert.equal(await exists(join(dir, 'inv-u-0')), true, 'genesis measured in a reused tree');
    await (await git.materialize(r.cwd, c, { kind: 'check', id: 'gone' })).dispose();
    const held = await git.materialize(r.cwd, c, { kind: 'check', id: 'gone2' });
    const ca = await git.materialize(r.cwd, c, { kind: 'check', id: 'ca' }); await ca.dispose();
    try {
      const dry = await ops.gc({ cwd: r.cwd, dryRun: true, as: parent });
      assert.deepEqual(dry.trees?.map(t => t.path), [join(dir, 'check-gone-0')]);
      assert.deepEqual(dry.treesKept?.map(t => t.path), [join(dir, 'check-gone2-0')]);
      assert.equal(await exists(join(dir, 'check-gone-0')), true, 'dry run removes nothing');
      const real = await ops.gc({ cwd: r.cwd, as: parent });
      assert.deepEqual(real.trees?.map(t => t.path), [join(dir, 'check-gone-0')]);
      assert.equal(await exists(join(dir, 'check-gone-0')), false);
      assert.equal((await git.listWorktrees(r.cwd)).some(w => w.path.endsWith('check-gone-0')), false, 'unregistered');
      assert.equal(await exists(join(dir, 'inv-u-0')), true, 'a tree of a current check stays');
      assert.equal(await exists(join(dir, 'check-ca-0')), true);
    } finally { await held.dispose(); }
    await ok('plan', () => ops.planSet({ cwd: r.cwd, plan: JSON.stringify(planOf([u])), as: parent }));
    const all = await ops.gc({ cwd: r.cwd, as: parent });
    assert.deepEqual(all.trees?.map(t => t.path).sort(), [join(dir, 'check-ca-0'), join(dir, 'check-gone2-0'), join(dir, 'inv-u-0')]);
    assert.equal(await exists(join(dir, 'inv-u-0')), false);
  } finally { await r.cleanup(); }
});

test('M2: reuse trees are never slots: no gc slot item, no kept report, no trunk-worktree report', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    const a = await setup(r, planOf([timed(r, 'u', 0)], { trees: 'reuse' }));
    const dir = await treesDir(r);
    assert.equal(await exists(join(dir, 'inv-u-0')), true);
    assert.equal(await exists(join(dir, 'check-ca-0')), true, 'the node check measured in a reused tree');
    await ok('merge', () => ops.merge({ cwd: r.cwd, node: 'a', as: parent }));
    const st = await ops.status({ cwd: r.cwd });
    assert.equal(st.trunkWorktree, undefined, 'no trunk-elsewhere report');
    const g = await ops.gc({ cwd: r.cwd, dryRun: true, as: parent });
    const text = JSON.stringify([g.removed, g.kept]);
    assert.equal(text.includes(dir), false, `no slot item or kept report names a reuse tree: ${text}`);
    assert.equal(g.trees, undefined); assert.equal(g.treesKept, undefined);
    assert.deepEqual(g.removed.map(i => `${i.node}#${i.attempt}`), ['a#1']);
    // A new dispatch works next to them and gc removes only the slot.
    const done = await ops.gc({ cwd: r.cwd, as: parent });
    assert.deepEqual(done.removed.map(i => i.worktree), [a.worktree]);
    assert.equal(await exists(join(dir, 'inv-u-0')), true);
    assert.equal((await stat(join(dir, 'check-ca-0'))).isDirectory(), true);
  } finally { await r.cleanup(); }
});
