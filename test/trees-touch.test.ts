import test from 'node:test';
import assert from 'node:assert/strict';
import { lstat, lutimes, mkdir, readFile, stat, symlink, utimes, writeFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { repo } from './helpers/repo.ts';
import { candidateFacts, git, materialize, reuseDir, stateFacts } from '../src/git.ts';
import { parsePlan } from '../src/plan.ts';
import { runJob } from '../src/exec.ts';
import { Ledger } from '../src/ledger.ts';
import * as ops from '../src/ops.ts';
import type { AttestJob, ExecConfig } from '../src/types.ts';

const OLD = new Date('2001-01-01T00:00:00Z');
const PASS = "echo '# tests 1'; echo '# pass 1'";
const planOf = (exec?: unknown) => parsePlan(JSON.stringify({ version: 1, trunk: 'main', closure: [], exec, nodes: [] }));
const mtime = async (path: string) => (await lstat(path)).mtimeMs;
// Git's forced checkout rewrites files with stale index stat data. Refresh the index after aging
// so the fixture represents an old, clean checkout and isolates owed's touch policy.
async function ageTracked(path: string, names: string[]): Promise<void> {
  for (const name of names) await utimes(join(path, name), OLD, OLD);
  await git(path, ['update-index', '--refresh']);
}

test('F6: touch parses all three policies, rejects invalid values, and reserves OWED_TREE', () => {
  for (const touch of ['reset', 'always', 'never']) assert.deepEqual(planOf({ touch }).exec, { touch });
  assert.equal(planOf().exec, undefined);
  for (const touch of ['sometimes', '', null, 0, true, []]) assert.throws(() => planOf({ touch }), /exec\.touch: expected reset, always or never/);
  assert.throws(() => planOf({ env: { OWED_TREE: '/wrong' } }), /exec\.env\.OWED_TREE: reserved/);
});

test('F6: every explicit touch policy binds check/red/strength/invariant keys; other obligations stay unchanged', async () => {
  const r = await repo();
  try {
    await r.put('keep', 'source\n'); const base = await r.commit();
    await r.put('change', 'candidate\n'); const commit = await r.commit();
    const keys = async (touch?: string): Promise<Record<string, string | undefined>> => {
      const plan = parsePlan(JSON.stringify({ version: 1, trunk: 'main', closure: ['m.patch'], exec: { trees: 'reuse', touch },
        invariants: [{ id: 'i', run: PASS }], nodes: [{ id: 'a', writes: ['change'], checks: [{ id: 'c', run: PASS, red: true, tests: ['change'], mutants: ['m.patch'] }] }] }));
      const facts = await candidateFacts(r.cwd, plan, plan.nodes[0]!, base, commit, 1);
      return { ...facts.keys, inv: (await stateFacts(r.cwd, plan, commit)).invKeys.i };
    };
    const variants = await Promise.all([undefined, 'reset', 'always', 'never'].map(keys));
    for (const key of ['check:c', 'red:c', 'strength:c', 'inv']) assert.equal(new Set(variants.map(v => v[key])).size, 4, key);
    for (const key of ['writes', 'review', 'rulings']) assert.equal(new Set(variants.map(v => v[key])).size, 1, key);
  } finally { await r.cleanup(); }
});

test('F6: default reset touches every tracked file on a different commit, including unchanged and unusual paths', async () => {
  const r = await repo();
  try {
    const names = ['keep', 'space dir/file\nwith newline', 'change'];
    for (const name of names) await r.put(name, 'one\n');
    const base = await r.commit(); await r.put('change', 'two\n'); const commit = await r.commit();
    const first = await materialize(r.cwd, base, { kind: 'check', id: 'reset' });
    await ageTracked(first.path, names);
    await first.dispose(); const start = Date.now();
    const next = await materialize(r.cwd, commit, { kind: 'check', id: 'reset' });
    try {
      assert.equal(next.path, first.path);
      for (const name of names) assert.ok(await mtime(join(next.path, name)) >= start - 2, name);
      assert.equal(await readFile(join(next.path, 'change'), 'utf8'), 'two\n');
    } finally { await next.dispose(); }
    const before = await mtime(join(next.path, 'keep'));
    const same = await materialize(r.cwd, commit, { kind: 'check', id: 'reset' });
    try {
      assert.equal(await mtime(join(same.path, 'keep')), before, 'a subsequent measurement of the same commit keeps the refreshed mtime');
      assert.equal((await git(same.path, ['status', '--porcelain'])).stdout, '');
    }
    finally { await same.dispose(); }
  } finally { await r.cleanup(); }
});

test('F6: reset leaves mtimes on the same commit; always refreshes them on every acquisition', async () => {
  const r = await repo();
  try {
    await r.put('keep', 'one\n'); const commit = await r.commit();
    for (const touch of ['reset', 'always'] as const) {
      const reuse = { kind: 'check', id: touch, touch };
      const first = await materialize(r.cwd, commit, reuse);
      await ageTracked(first.path, ['keep']); await first.dispose();
      const start = Date.now(), next = await materialize(r.cwd, 'HEAD', reuse);
      try {
        assert.equal(next.path, first.path);
        const stamp = await mtime(join(next.path, 'keep'));
        if (touch === 'reset') assert.equal(stamp, OLD.getTime());
        else assert.ok(stamp >= start - 2, 'always touches even if HEAD resolves to the same commit');
      } finally { await next.dispose(); }
    }
  } finally { await r.cleanup(); }
});

test('F6: never preserves git mtimes across commits and always does not follow symlinks or touch gitlinks', async () => {
  const r = await repo();
  try {
    await r.put('keep', 'one\n'); const initial = await r.commit();
    const outside = join(r.root, 'external'); await writeFile(outside, 'outside'); await utimes(outside, OLD, OLD);
    await symlink(outside, join(r.cwd, 'link'));
    await symlink(join(r.root, 'missing'), join(r.cwd, 'dangling'));
    await mkdir(join(r.cwd, 'module'));
    await git(r.cwd, ['update-index', '--add', '--cacheinfo', `160000,${initial},module`]);
    const base = await r.commit(); await r.put('change', 'two\n'); const commit = await r.commit();
    const reuse = { kind: 'check', id: 'links', touch: 'never' as const };
    const first = await materialize(r.cwd, base, reuse);
    await ageTracked(first.path, ['keep']); await first.dispose();
    const next = await materialize(r.cwd, commit, reuse);
    assert.equal(await mtime(join(next.path, 'keep')), OLD.getTime());
    await lutimes(join(next.path, 'link'), OLD, OLD);
    await git(next.path, ['update-index', '--refresh']); await next.dispose();
    const start = Date.now(), touched = await materialize(r.cwd, commit, { ...reuse, touch: 'always' });
    try {
      assert.equal(touched.path, first.path, 'no fallback due to a dangling symlink or gitlink');
      assert.ok(await mtime(join(touched.path, 'link')) >= start - 2);
      assert.equal(await mtime(outside), OLD.getTime(), 'external target is untouched');
      assert.equal((await stat(join(touched.path, 'module'))).isDirectory(), true);
    } finally { await touched.dispose(); }
  } finally { await r.cleanup(); }
});

test('F6: touching one leased tree never changes another active measurement tree', async () => {
  const r = await repo();
  try {
    await r.put('keep', 'one'); const base = await r.commit(); await r.put('change', 'two'); const commit = await r.commit();
    const reuse = { kind: 'check', id: 'concurrent', touch: 'always' as const };
    const held = await materialize(r.cwd, base, reuse);
    try {
      await utimes(join(held.path, 'keep'), OLD, OLD);
      const other = await materialize(r.cwd, commit, reuse);
      try { assert.notEqual(other.path, held.path); assert.equal(await mtime(join(held.path, 'keep')), OLD.getTime()); }
      finally { await other.dispose(); }
    } finally { await held.dispose(); }
  } finally { await r.cleanup(); }
});

test('F6: executor applies touch policies before setup and check in the reused tree', async () => {
  const r = await repo();
  try {
    await r.put('keep', 'source'); const base = await r.commit(); await r.put('change', 'two'); const commit = await r.commit();
    const ledger = await Ledger.open(r.cwd);
    for (const touch of [undefined, 'reset', 'always', 'never'] as const) {
      const id = touch ?? 'default', reuse = { kind: 'check', id };
      const first = await materialize(r.cwd, base, reuse);
      await ageTracked(first.path, ['keep']); await first.dispose();
      const plan = planOf({ trees: 'reuse', touch });
      // Setup records the mtime before any check can alter it.
      plan.setup = 'stat -c %Y keep > stamp';
      const job: AttestJob = { kind: 'check', subject: 'a', obligation: `check:${id}`, key: id, base, commit,
        spec: { id, run: `cat stamp; ${PASS}`, reads: ['**'], timeout_s: 30 } };
      const result = await runJob({ cwd: r.cwd, plan, ledger }, job);
      assert.equal(result.verdict, 'pass', result.note);
      const seconds = Number((await ledger.getBlob(result.log!)).toString().split('\n')[0]);
      if (touch === 'never') assert.equal(seconds, OLD.getTime() / 1000);
      else assert.ok(seconds > OLD.getTime() / 1000, id);
    }
  } finally { await r.cleanup(); }
});

test('F6: OWED_TREE is absolute and correct for setup, wrapper and every measurement kind, fresh or reused', async () => {
  const r = await repo();
  try {
    await r.put('mode', 'ok\n'); await r.put('m.patch', '--- a/mode\n+++ b/mode\n@@ -1 +1 @@\n-ok\n+bad\n');
    const base = await r.commit(); await r.put('newtest', 'candidate'); const commit = await r.commit();
    const ledger = await Ledger.open(r.cwd), log = join(r.root, 'paths');
    const wrapper = join(r.root, 'wrapper.sh');
    await writeFile(wrapper, 'test "$OWED_TREE" = "$PWD" || exit 91\nprintf "%s\\n" "$OWED_TREE" >> "$PATH_LOG"\nexec "$@"\n');
    for (const trees of ['fresh', 'reuse'] as const) {
      for (const kind of ['check', 'red', 'inv', 'strength'] as const) {
        const plan = planOf({ trees, env: { PATH_LOG: log }, wrap: ['bash', wrapper] });
        plan.closure = ['m.patch']; plan.setup = 'test "$OWED_TREE" = "$PWD" && printf "%s" "$OWED_TREE" > setup-path';
        const run = `test "$OWED_TREE" = "$PWD" && test "$(cat setup-path)" = "$OWED_TREE" || exit 92; ${PASS}; ${kind === 'red' ? 'exit 1' : kind === 'strength' ? 'test "$(cat mode)" = ok' : 'true'}`;
        const job: AttestJob = { kind, subject: 'a', obligation: `${kind}:c`, key: 'k', base, commit,
          spec: { id: 'c', run, reads: ['**'], timeout_s: 30, tests: ['newtest'], mutants: ['m.patch'] } };
        const result = await runJob({ cwd: r.cwd, plan, ledger }, job);
        assert.equal(result.verdict, 'pass', `${trees}/${kind}: ${result.note}`);
      }
    }
    const paths = (await readFile(log, 'utf8')).trim().split('\n');
    assert.equal(paths.length, 16, 'setup and measurement each pass through the wrapper');
    assert.ok(paths.every(p => isAbsolute(p) && p !== r.cwd));
  } finally { await r.cleanup(); }
});

test('F6: OWED_TREE uses the fresh fallback path when reuse preparation fails', async () => {
  const r = await repo();
  try {
    const commit = await r.commit(), dir = await reuseDir(r.cwd);
    await mkdir(join(dir, '..'), { recursive: true }); await writeFile(dir, 'unavailable');
    const ledger = await Ledger.open(r.cwd), plan = planOf({ trees: 'reuse' });
    const job: AttestJob = { kind: 'check', subject: 'a', obligation: 'check:c', key: 'k', base: commit, commit,
      spec: { id: 'c', reads: ['**'], timeout_s: 30, run: `test "$OWED_TREE" = "$PWD" || exit 1; printf 'tree=%s\n' "$OWED_TREE"; ${PASS}` } };
    const result = await runJob({ cwd: r.cwd, plan, ledger }, job);
    assert.equal(result.verdict, 'pass', result.note);
    const text = (await ledger.getBlob(result.log!)).toString();
    assert.match(text, /measuring in a fresh tree/); assert.match(text, /tree=\/.*owed-run-.*\/tree/);
  } finally { await r.cleanup(); }
});

test('F6: a touch policy change carries the candidate with new keys and requires new measured evidence', async () => {
  const r = await repo();
  try {
    await r.put('keep', 'one'); await r.commit();
    const owner = { role: 'owner', id: 'test' } as const, parent = { role: 'parent', id: 'test' } as const;
    const text = (touch: ExecConfig['touch']) => JSON.stringify({ version: 1, trunk: 'main', closure: [], exec: { trees: 'reuse', touch },
      nodes: [{ id: 'a', writes: ['keep'], checks: [{ id: 'c', run: PASS, min_tests: 1 }] }] });
    await ops.init({ cwd: r.cwd, plan: text('reset'), as: owner, channel: 'flag' });
    const slot = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
    const first = await ops.submit({ cwd: slot.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
    assert.equal(first.kind, 'submit'); if (first.kind !== 'submit') return;
    assert.equal((await ops.attest({ cwd: r.cwd, node: 'a' })).accepted, true);
    await assert.rejects(ops.planSet({ cwd: r.cwd, plan: text('always'), as: parent }), /owner/);
    await ops.planSet({ cwd: r.cwd, plan: text('always'), as: owner, channel: 'flag' });
    const state = await ops.status({ cwd: r.cwd });
    assert.notEqual(state.nodes.a!.candidate!.keys['check:c'], first.facts.keys['check:c']);
    assert.equal((await ops.why({ cwd: r.cwd, node: 'a' })).accepted, false);
    const result = await ops.attest({ cwd: r.cwd, node: 'a' });
    assert.equal(result.accepted, true); assert.ok(result.observations.some(e => e.kind === 'obs' && e.obligation === 'check:c'));
  } finally { await r.cleanup(); }
});
