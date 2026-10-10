// H3 (contract 0.6.1): dispatch rollback runs every step; node ids equal ignoring case are refused in a new plan.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import * as planModule from '../src/plan.ts';
import { parsePlan } from '../src/plan.ts';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { canonical } from '../src/canon.ts';
import { git } from '../src/git.ts';
import type { Entry } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

type Spec = Record<string, unknown>;
const owner = { role: 'owner' as const, id: 'human' };
const parent = { role: 'parent' as const, id: 'main' };
const node = (id: string, writes: string[]): Spec => ({ id, writes, checks: [], review: { count: 0, min_rank: 1 } });
const plain = (extra: Spec = {}, nodes: Spec[] = [node('a', ['a/']), node('b', ['b/'])]): Spec => ({ version: 1, trunk: 'main', closure: [], invariants: [], nodes, ...extra });
const entries = async (cwd: string): Promise<Entry[]> => (await Ledger.open(cwd)).read();
const hasBranch = async (cwd: string, b: string) => (await git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${b}`], { allowFail: true })).code === 0;
const worktreeCount = async (cwd: string) => (await git(cwd, ['worktree', 'list', '--porcelain'])).stdout.split('\n').filter(l => l.startsWith('worktree ')).length;
async function fixture(plan: Spec) {
  const r = await repo();
  try { await commitAt(r.cwd, { README: 'x\n' }); await ops.init({ cwd: r.cwd, plan: JSON.stringify(plan), as: owner, channel: 'flag' }); return r; }
  catch (e) { await r.cleanup(); throw e; }
}
/**
 * A post-checkout hook that runs once inside the dispatch's `git worktree add`: it records a ruling (so the dispatch's
 * append sees changed rulings and rolls back), leaves an untracked file in the new worktree (so `git worktree remove`
 * fails) and, when `detach`, detaches the worktree's HEAD (so the branch is checked out nowhere and `git branch -d` can
 * succeed).
 */
async function hook(r: { root: string; cwd: string }, detach: boolean): Promise<string> {
  const owed = fileURLToPath(new URL('../bin/owed.js', import.meta.url)), mark = join(r.root, 'hook-ran'), file = join(r.cwd, '.git', 'hooks', 'post-checkout');
  await writeFile(file, [
    '#!/bin/sh', `[ -f '${mark}' ] && exit 0`, `touch '${mark}'`, 'W=$(pwd)', 'unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX',
    'echo junk > "$W/untracked-junk"', ...(detach ? ['git -C "$W" checkout -q --detach'] : []),
    `cd '${r.cwd}' && '${process.execPath}' '${owed}' rule 'changed under dispatch' --nodes '*' >> '${mark}.log' 2>&1`, 'exit 0', '',
  ].join('\n'));
  await chmod(file, 0o755);
  return mark;
}

test('H3.1: a rollback whose worktree remove fails still deletes the branch and tries the directory cleanup; the error names the original failure and each failed step', { timeout: 120_000 }, async () => {
  const r = await fixture(plain({ worktrees: { root: 'deep/er/slots' } }));
  try {
    const mark = await hook(r, true);
    let error: (Error & { code?: string }) | undefined;
    await assert.rejects(ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' }), (e: Error & { code?: string }) => { error = e; return true; });
    assert.ok(existsSync(mark), 'the hook ran');
    const m = error!.message;
    assert.match(m, /^Rulings changed; dispatch again\n/, 'the original failure comes first');
    assert.match(m, /rollback failed: git worktree remove: [^;\n]*untracked/, m);
    assert.match(m, /directory cleanup: rmdir \S*deep\/er\/slots: ENOTEMPTY/, m);
    assert.doesNotMatch(m, /git branch -d/, 'the branch step succeeded, so it is not named');
    assert.equal(error!.code, 'refused', 'the original error code is kept');
    assert.ok(!await hasBranch(r.cwd, 'owed/a/1'), 'git branch -d ran after the failed worktree remove');
    assert.ok(!(await entries(r.cwd)).some(e => e.kind === 'dispatch'), 'nothing recorded');
  } finally { await r.cleanup(); }
});

test('H3.1: a rollback where every step fails names all three steps; nothing recorded', { timeout: 120_000 }, async () => {
  const r = await fixture(plain({ worktrees: { root: 'deep/er/slots' } }));
  try {
    await hook(r, false);
    let error: Error | undefined;
    await assert.rejects(ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' }), (e: Error) => { error = e; return true; });
    const m = error!.message, line = m.split('\n').find(l => l.startsWith('rollback failed: '));
    assert.match(m, /^Rulings changed; dispatch again\n/, m);
    assert.ok(line, m);
    assert.deepEqual(line!.slice('rollback failed: '.length).split('; ').map(s => s.split(':')[0]), ['git worktree remove', 'git branch -d', 'directory cleanup'], m);
    assert.ok(await hasBranch(r.cwd, 'owed/a/1'), 'the branch stays checked out in the worktree that could not be removed');
    assert.equal(await worktreeCount(r.cwd), 2);
    assert.ok(!(await entries(r.cwd)).some(e => e.kind === 'dispatch'), 'nothing recorded');
  } finally { await r.cleanup(); }
});

test('H3.1: a rollback whose steps all succeed rethrows the original error unchanged', { timeout: 120_000 }, async () => {
  const r = await fixture(plain({ worktrees: { root: 'deep/er/slots' } }));
  try {
    // The ruling is recorded by a hook that leaves the worktree clean: every rollback step succeeds.
    const owed = fileURLToPath(new URL('../bin/owed.js', import.meta.url)), mark = join(r.root, 'hook-ran'), file = join(r.cwd, '.git', 'hooks', 'post-checkout');
    await writeFile(file, `#!/bin/sh\n[ -f '${mark}' ] && exit 0\ntouch '${mark}'\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX\ncd '${r.cwd}' && '${process.execPath}' '${owed}' rule 'changed under dispatch' --nodes '*' >> '${mark}.log' 2>&1\nexit 0\n`);
    await chmod(file, 0o755);
    await assert.rejects(ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' }), (e: Error) => e.message === 'Rulings changed; dispatch again');
    assert.ok(!existsSync(join(r.cwd, 'deep')));
    assert.ok(!await hasBranch(r.cwd, 'owed/a/1'));
    assert.equal(await worktreeCount(r.cwd), 1);
  } finally { await r.cleanup(); }
});

test('H3.2: nodeIdCaseErrors reports node ids equal ignoring case', () => {
  const f = (planModule as Record<string, unknown>).nodeIdCaseErrors as ((p: { nodes: { id: string }[] }) => string[]) | undefined;
  assert.equal(typeof f, 'function', 'plan.ts exports nodeIdCaseErrors');
  assert.deepEqual(f!({ nodes: [{ id: 'a' }, { id: 'b' }, { id: 'A1' }, { id: 'a-1' }] }), []);
  const errors = f!({ nodes: [{ id: 'KB4' }, { id: 'x' }, { id: 'kb4' }, { id: 'Kb4' }] });
  assert.equal(errors.length, 2, errors.join('\n'));
  assert.match(errors[0]!, /^node ids KB4 and kb4 differ only in case: on a case-insensitive filesystem they would share a branch ref and a worktree directory$/);
  assert.match(errors[1]!, /^node ids KB4 and Kb4 differ only in case/);
});

test('H3.2: init and plan refuse node ids equal ignoring case (usage, nothing recorded); replay still reads such a plan', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    await commitAt(r.cwd, { README: 'x\n' });
    const clash = plain({}, [node('a', ['a/']), node('b', ['b/']), node('KB4', ['k/']), node('kb4', ['l/'])]);
    const re = /node ids KB4 and kb4 differ only in case/;
    await assert.rejects(ops.init({ cwd: r.cwd, plan: JSON.stringify(clash), as: owner, channel: 'flag' }), (e: Error & { code?: string }) => re.test(e.message) && e.code === 'usage');
    await assert.rejects(ops.initPreview({ cwd: r.cwd, plan: JSON.stringify(clash) }), re);
    assert.doesNotThrow(() => parsePlan(JSON.stringify(clash)), 'parsing alone (replay) does not refuse it');
    assert.deepEqual(await entries(r.cwd), [], 'no refused init recorded anything');
    const file = join(r.root, 'clash.json'); await writeFile(file, JSON.stringify(clash));
    const out = await cli(r.cwd, ['init', file, '--i-am-owner']);
    assert.equal(out.code, 2, out.stderr); assert.match(out.stderr, re);
    await ops.init({ cwd: r.cwd, plan: JSON.stringify(plain()), as: owner, channel: 'flag' });
    const before = await entries(r.cwd);
    await assert.rejects(ops.planSet({ cwd: r.cwd, plan: JSON.stringify(clash), as: owner, channel: 'flag' }), (e: Error & { code?: string }) => re.test(e.message) && e.code === 'usage');
    const planOut = await cli(r.cwd, ['plan', file, '--i-am-owner']);
    assert.equal(planOut.code, 2, planOut.stderr); assert.match(planOut.stderr, re);
    assert.deepEqual(await entries(r.cwd), before, 'no refused plan recorded anything');
    // A ledger whose plan was recorded by an older owed with such ids stays readable.
    const ledger = await Ledger.open(r.cwd), data = stringify(JSON.parse(canonical(parsePlan(JSON.stringify(clash)))), { sortMapEntries: true }), sha = await ledger.putBlob(data);
    await ledger.withLock(async () => {
      const law = (await ledger.read()).findLast(e => e.kind === 'plan' || e.kind === 'genesis');
      assert.ok(law && (law.kind === 'plan' || law.kind === 'genesis'));
      await ledger.append([{ kind: 'plan', by: 'parent:old', prior: law.plan, plan: sha, downgrades: [] }]);
    });
    assert.ok(await ops.status({ cwd: r.cwd }), 'status reads the ledger');
    assert.equal((await ops.why({ cwd: r.cwd, node: 'KB4' })).node, 'KB4');
    assert.equal((await ops.why({ cwd: r.cwd, node: 'kb4' })).node, 'kb4');
  } finally { await r.cleanup(); }
});
