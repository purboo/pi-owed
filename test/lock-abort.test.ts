// D16a.2: Ledger.withLock takes the operation's abort signal. An abort while waiting for a ledger lock rejects at once
// with OwedError('aborted', 'aborted'); an already-aborted signal takes nothing (no staged directory); an abort after the
// lock is acquired does not interrupt the critical section. ops.attest/merge/adopt/init pass their signal to the locks.
// No sleeps decide an outcome: holders release through gates, and the waiter is observed registering its abort listener.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { OwedError } from '../src/errors.ts';
import type { Entry } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { commitAt } from './helpers/surface.ts';

const owner = { role: 'owner' as const, id: 'human' };
const parent = { role: 'parent' as const, id: 'main' };
type Repo = Awaited<ReturnType<typeof repo>>;
const isAborted = (e: unknown) => e instanceof OwedError && e.code === 'aborted' && e.message === 'aborted';
const entries = async (cwd: string): Promise<Entry[]> => (await Ledger.open(cwd)).read();
/** Lock directories and staged lock directories (`.<name>-<token>`) in the ledger dir. */
const lockDirs = async (dir: string) => (await readdir(dir)).filter(n => /^\.?(lock|attest|merge)(-|$)/.test(n)).sort();

/** Holds lock `name` through `l` until release() (a gate, not a timer). */
async function hold(l: Ledger, name?: string): Promise<{ release(): Promise<void> }> {
  let open!: () => void, acquired!: () => void;
  const gate = new Promise<void>(r => { open = r; }), got = new Promise<void>(r => { acquired = r; });
  const done = l.withLock(async () => { acquired(); await gate; }, name);
  await Promise.race([got, done]);
  return { async release() { open(); await done; } };
}
/**
 * Resolves when withLock registers its abort listener on `signal`, i.e. it is waiting for a held lock. The bound only
 * turns "never waits on the signal" (the pre-fix code) into an assertion failure instead of a hang.
 */
function lockWait(signal: AbortSignal, ms = 15_000): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new assert.AssertionError({ message: `withLock did not wait on the signal within ${ms} ms` })), ms);
    const original = signal.addEventListener.bind(signal) as (...args: unknown[]) => void;
    signal.addEventListener = ((...args: unknown[]) => {
      original(...args);
      if (args[0] === 'abort' && /withLock/.test(new Error().stack ?? '')) { clearTimeout(timer); resolve(); }
    }) as typeof signal.addEventListener;
  });
}
/** The settled value or error of `p`, or 'pending' if it did not settle within `ms` (a bound, not a timing assumption). */
async function settled<T>(p: Promise<T>, ms = 15_000): Promise<T | unknown> {
  let t: NodeJS.Timeout | undefined;
  try { return await Promise.race([p.catch((e: unknown) => e), new Promise(r => { t = setTimeout(() => r('pending'), ms); })]); } finally { clearTimeout(t); }
}
async function fileAppears(file: string, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await readFile(file).then(() => true, () => false)) return; await new Promise(r => setTimeout(r, 50)); }
  throw new Error(`${file} did not appear within ${ms} ms`);
}

test('D16a.2: withLock with an already-aborted signal rejects without taking the lock or leaving a staged directory', async () => {
  const r = await repo();
  try {
    const l = await Ledger.open(r.cwd), ac = new AbortController(); ac.abort();
    let ran = false;
    await assert.rejects(l.withLock(async () => { ran = true; }, undefined, ac.signal), isAborted);
    await assert.rejects(l.withLock(async () => { ran = true; }, 'attest', ac.signal), isAborted);
    assert.equal(ran, false, 'fn never runs');
    assert.deepEqual(await lockDirs(l.dir), [], 'no lock and no staged directory');
    // The same while another holder has the lock: rejected at once, the holder's lock untouched.
    const h = await hold(await Ledger.open(r.cwd));
    try {
      assert.ok(isAborted(await settled(l.withLock(async () => { ran = true; }, undefined, ac.signal))));
      assert.equal(ran, false);
      assert.deepEqual(await lockDirs(l.dir), ['lock']);
    } finally { await h.release(); }
    assert.deepEqual(await lockDirs(l.dir), []);
  } finally { await r.cleanup(); }
});

test('D16a.2: an abort while waiting for a held lock rejects at once; an abort after acquisition does not interrupt fn', async () => {
  const r = await repo();
  try {
    const l = await Ledger.open(r.cwd), h = await hold(await Ledger.open(r.cwd)), ac = new AbortController();
    const waiting = lockWait(ac.signal);
    let ran = false;
    const p = l.withLock(async () => { ran = true; }, undefined, ac.signal);
    try {
      await waiting; ac.abort();
      const out = await settled(p);
      assert.ok(isAborted(out), `rejects with OwedError('aborted') while the lock is still held: ${String(out)}`);
      assert.equal(ran, false, 'fn never runs');
      assert.deepEqual(await lockDirs(l.dir), ['lock'], 'the holder keeps its lock; no staged directory is left');
    } finally { await h.release(); await p.catch(() => {}); }
    assert.deepEqual(await lockDirs(l.dir), []);
    // The lock still works, and an abort inside the critical section does not interrupt it.
    const ac2 = new AbortController();
    const v = await l.withLock(async () => {
      ac2.abort();
      await l.append([{ kind: 'note', by: 'parent:test', text: 'after abort' }]);
      return 7;
    }, undefined, ac2.signal);
    assert.equal(v, 7);
    assert.deepEqual((await l.read()).map(e => e.kind), ['note']);
    assert.deepEqual(await lockDirs(l.dir), []);
  } finally { await r.cleanup(); }
});

const plan = JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [], nodes: [{ id: 'a', writes: ['a.txt'], checks: [], review: { count: 0, min_rank: 1 } }] });
const cases: [string, string, (r: Repo, signal: AbortSignal) => Promise<unknown>][] = [
  ['attest', 'attest', (r, signal) => ops.attest({ cwd: r.cwd, node: 'a', signal })],
  ['merge', 'merge', (r, signal) => ops.merge({ cwd: r.cwd, node: 'a', as: parent, signal })],
  ['adopt', 'merge', (r, signal) => ops.adopt({ cwd: r.cwd, as: owner, note: 'n', channel: 'flag', signal })],
  ['init', 'lock', (r, signal) => ops.init({ cwd: r.cwd, plan, as: owner, channel: 'flag', signal })],
];
for (const [op, lock, run] of cases) {
  test(`D16a.2: ops.${op} aborted while waiting for the ${lock} lock rejects at once and records nothing`, async () => {
    const r = await repo();
    try {
      await commitAt(r.cwd, { README: 'x\n' });
      const h = await hold(await Ledger.open(r.cwd), lock), ac = new AbortController(), waiting = lockWait(ac.signal);
      const p = run(r, ac.signal);
      try {
        await waiting; ac.abort();
        const out = await settled(p);
        assert.ok(isAborted(out), `rejects with OwedError('aborted') while ${lock} is held: ${String(out)}`);
      } finally { await h.release(); await p.catch(() => {}); }
      assert.deepEqual(await entries(r.cwd), [], 'the ledger is unchanged');
    } finally { await r.cleanup(); }
  });
}

test('D16a.2: attest aborted while waiting for the ledger lock to record a finished check records nothing', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    const gate = (f: string) => join(r.root, f);
    const run = `touch '${gate('started')}'; while [ ! -f '${gate('go')}' ]; do sleep 0.05; done`;
    await commitAt(r.cwd, { README: 'x\n' });
    await ops.init({ cwd: r.cwd, plan: JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [], nodes: [{ id: 'a', writes: ['a.txt'], checks: [{ id: 'gated', run }], review: { count: 0, min_rank: 1 } }] }), as: owner, channel: 'flag' });
    const d = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
    await commitAt(d.worktree, { 'a.txt': 'a\n' });
    await ops.submit({ cwd: d.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
    const before = (await entries(r.cwd)).length, ac = new AbortController();
    const p = ops.attest({ cwd: r.cwd, node: 'a', signal: ac.signal });
    let h: { release(): Promise<void> } | undefined;
    try {
      await fileAppears(gate('started'));
      // The check runs under the 'attest' lock; take the ledger lock its observation needs, then let the check end.
      h = await hold(await Ledger.open(r.cwd));
      const waiting = lockWait(ac.signal);
      await writeFile(gate('go'), '');
      await waiting; ac.abort();
      const out = await settled(p);
      assert.ok(isAborted(out), `rejects with OwedError('aborted') while the ledger lock is held: ${String(out)}`);
    } finally { await writeFile(gate('go'), ''); await h?.release(); await p.catch(() => {}); }
    assert.deepEqual((await entries(r.cwd)).slice(before).map(e => e.kind), [], 'no observation for the aborted attest');
  } finally { await r.cleanup(); }
});
