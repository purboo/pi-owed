import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repo } from './helpers/repo.ts';
import { cli, commitAt, planText, seed, checkTest } from './helpers/surface.ts';
import { git } from '../src/git.ts';
import type { DispatchPacket } from '../src/ops.ts';

type Item = { node: string; attempt: number; worktree: string | null; branch: string | null; reason?: string };
type Gc = { removed: Item[]; kept: Item[] };
const hasBranch = async (cwd: string, b: string) => (await git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${b}`], { allowFail: true })).code === 0;
const ids = (items: Item[]) => items.map(i => `${i.node}#${i.attempt}`).sort();

test('gc reclaims merged and abandoned attempts, keeps dirty and open slots, and is idempotent', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    await seed(r.cwd); const plan = join(r.root, 'plan.yaml'); await writeFile(plan, planText);
    async function call<T>(cwd: string, args: string[]): Promise<T> { const out = await cli(cwd, [...args, '--json']); assert.equal(out.code, 0, `${args.join(' ')}\n${out.stderr}\n${out.stdout}`); return JSON.parse(out.stdout) as T; }
    const ledgerLines = async () => (await readFile(join(r.root, 'ledger', 'ledger.jsonl'), 'utf8')).split('\n').filter(Boolean);
    await call(r.cwd, ['init', plan, '--i-am-owner']);
    // a#1: merged (clean). b#1: abandoned with a dirty worktree. b#2: abandoned (clean). b#3: open slot.
    const a = await call<DispatchPacket>(r.cwd, ['dispatch', 'a']);
    await commitAt(a.worktree, { 'test/a.cjs': 'module.exports=1;', 'test/a.test.cjs': checkTest('a', 1) });
    await call(a.worktree, ['submit', 'a']); await call(r.cwd, ['attest', 'a']); await call(r.cwd, ['merge', 'a']);
    const b1 = await call<DispatchPacket>(r.cwd, ['dispatch', 'b']);
    await writeFile(join(b1.worktree, 'scratch.txt'), 'uncommitted work');
    await call(r.cwd, ['abandon', 'b', '--reason', 'dirty retry']);
    const b2 = await call<DispatchPacket>(r.cwd, ['dispatch', 'b']);
    await commitAt(b2.worktree, { 'test/b.test.cjs': checkTest('b', 1) });
    await call(r.cwd, ['abandon', 'b', '--reason', 'clean retry']);
    const b3 = await call<DispatchPacket>(r.cwd, ['dispatch', 'b']);
    const before = (await ledgerLines()).length;

    const dry = await call<Gc>(r.cwd, ['gc', '--dry-run']);
    assert.deepEqual(ids(dry.removed), ['a#1', 'b#2']);
    assert.deepEqual(ids(dry.kept), ['b#1', 'b#3']);
    for (const p of [a, b1, b2, b3]) { assert.ok(existsSync(p.worktree), p.worktree); assert.ok(await hasBranch(r.cwd, p.branch), p.branch); }
    assert.equal((await ledgerLines()).length, before, 'dry run must not write the ledger');

    const run = await call<Gc>(r.cwd, ['gc']);
    assert.deepEqual([...run.removed].sort((x, y) => `${x.node}#${x.attempt}`.localeCompare(`${y.node}#${y.attempt}`)), [
      { node: 'a', attempt: 1, worktree: a.worktree, branch: a.branch },
      { node: 'b', attempt: 2, worktree: b2.worktree, branch: b2.branch },
    ]);
    const kept = Object.fromEntries(run.kept.map(i => [`${i.node}#${i.attempt}`, i]));
    assert.deepEqual(Object.keys(kept).sort(), ['b#1', 'b#3']);
    assert.match(kept['b#1']!.reason!, /dirty/); assert.match(kept['b#3']!.reason!, /open/);
    assert.equal(kept['b#1']!.worktree, b1.worktree); assert.equal(kept['b#1']!.branch, b1.branch);
    for (const p of [a, b2]) { assert.ok(!existsSync(p.worktree), p.worktree); assert.ok(!await hasBranch(r.cwd, p.branch), p.branch); }
    for (const p of [b1, b3]) { assert.ok(existsSync(p.worktree), p.worktree); assert.ok(await hasBranch(r.cwd, p.branch), p.branch); }
    assert.ok(existsSync(join(b1.worktree, 'scratch.txt')), 'dirty work is preserved');
    const lines = await ledgerLines(); assert.equal(lines.length, before + 1);
    const note = JSON.parse(lines.at(-1)!); assert.equal(note.kind, 'note');
    assert.match(note.text, /a#1/); assert.match(note.text, /b#2/); assert.match(note.text, /owed\/a\/1/); assert.doesNotMatch(note.text, /b#1|b#3/);
    const registered = (await git(r.cwd, ['worktree', 'list', '--porcelain'])).stdout;
    assert.ok(!registered.includes(a.worktree) && !registered.includes(b2.worktree));

    // Idempotent: a second run removes nothing and appends nothing.
    const again = await call<Gc>(r.cwd, ['gc']);
    assert.deepEqual(again.removed, []); assert.deepEqual(ids(again.kept), ['b#1', 'b#3']);
    assert.equal((await ledgerLines()).length, before + 1);
    const text = await cli(r.cwd, ['gc']);
    assert.equal(text.code, 0); assert.match(text.stdout, /Removed: nothing/); assert.match(text.stdout, /b#1 \(owed\/b\/1\): .*dirty/); assert.match(text.stdout, /b#3 \(owed\/b\/3\): .*open/);

    // Once the dirty attempt is cleaned it becomes reclaimable; the open slot never is.
    await git(b1.worktree, ['clean', '-fdq']);
    const textRun = await cli(r.cwd, ['gc']);
    assert.equal(textRun.code, 0, textRun.stderr); assert.match(textRun.stdout, /^Removed\n {2}b#1: worktree .*, branch owed\/b\/1$/m); assert.match(textRun.stdout, /Recorded/);
    assert.ok(!existsSync(b1.worktree)); assert.ok(!await hasBranch(r.cwd, b1.branch));
    assert.ok(existsSync(b3.worktree)); assert.ok(await hasBranch(r.cwd, b3.branch));
    assert.equal((await ledgerLines()).length, before + 2);

    // The ops API is the same operation (guarded so a missing export is an assertion failure).
    const ops = await import('../src/ops.ts') as unknown as { gc?: (o: { cwd: string; dryRun?: boolean }) => Promise<Gc> };
    assert.equal(typeof ops.gc, 'function', 'ops.gc must be exported');
    const api = await ops.gc!({ cwd: r.cwd, dryRun: true });
    assert.deepEqual(api.removed, []); assert.deepEqual(ids(api.kept), ['b#3']);
    await call(r.cwd, ['verify']);
  } finally { await r.cleanup(); }
});

test('gc handles a slot directory deleted by hand and rejects bad usage', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    await seed(r.cwd); const plan = join(r.root, 'plan.yaml'); await writeFile(plan, planText);
    for (const args of [['gc', 'extra'], ['status', '--dry-run'], ['gc', '--dry-run=yes']]) assert.equal((await cli(r.cwd, args)).code, 2, args.join(' '));
    const pre = await cli(r.cwd, ['gc']); assert.equal(pre.code, 1); assert.match(pre.stderr, /Not initialized/);
    assert.equal((await cli(r.cwd, ['init', plan, '--i-am-owner'])).code, 0);
    const a = JSON.parse((await cli(r.cwd, ['dispatch', 'a', '--json'])).stdout) as DispatchPacket;
    assert.equal((await cli(r.cwd, ['abandon', 'a', '--reason', 'gone'])).code, 0);
    await rm(a.worktree, { recursive: true, force: true }); // stale registration: directory gone, branch still pinned
    const out = await cli(r.cwd, ['gc', '--json']); assert.equal(out.code, 0, out.stderr);
    const res = JSON.parse(out.stdout) as Gc;
    assert.deepEqual(res.removed, [{ node: 'a', attempt: 1, worktree: null, branch: 'owed/a/1' }]); assert.deepEqual(res.kept, []);
    assert.ok(!await hasBranch(r.cwd, a.branch));
    assert.deepEqual((JSON.parse((await cli(r.cwd, ['gc', '--json'])).stdout) as Gc).removed, []);
  } finally { await r.cleanup(); }
});
