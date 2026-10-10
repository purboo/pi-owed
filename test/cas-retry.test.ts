// N2: deterministic races at the ledger lock boundary, using real git and ledger operations.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { OwedError } from '../src/errors.ts';
import { git, revParse } from '../src/git.ts';
import { parsePlan, planWarnings, loopWarnings, checklessWarnings } from '../src/plan.ts';
import { uncoveredDowngrades } from '../src/reducer.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt, identity } from './helpers/surface.ts';

delete process.env.OWED_CONFIRM;
const owner = { role: 'owner' as const, id: 'pi' }, parent = { role: 'parent' as const, id: 'test' };
const spec = () => ({ version: 1, trunk: 'dev', closure: [], invariants: [], nodes: [
  { id: 'a', writes: ['a/'], checks: [], review: { count: 0, min_rank: 1 } },
  { id: 'b', writes: ['b/'], checks: [], review: { count: 0, min_rank: 1 } },
] });
async function fixture() {
  const r = await repo();
  try {
    await commitAt(r.cwd, { README: 'main\n' });
    await git(r.cwd, ['switch', '-c', 'dev']);
    const base = await commitAt(r.cwd, { 'trunk.txt': 'dev\n' });
    await git(r.cwd, ['switch', 'main']);
    await ops.init({ cwd: r.cwd, plan: JSON.stringify(spec()), as: owner, channel: 'delegated' });
    return { ...r, base };
  } catch (e) { await r.cleanup(); throw e; }
}
const entries = async (cwd: string) => (await Ledger.open(cwd)).read();
const hasBranch = async (cwd: string) => (await git(cwd, ['show-ref', '--verify', '--quiet', 'refs/heads/owed/a/1'], { allowFail: true })).code === 0;
const slots = async (cwd: string) => (await git(cwd, ['worktree', 'list', '--porcelain'])).stdout.split('\n').filter(l => l.startsWith('worktree ')).length;
const changedPlan = () => ({ ...spec(), nodes: spec().nodes.map(n => ({ ...n, title: 'a concurrent plan' })) });
async function recordPlan(cwd: string) { return ops.planSet({ cwd, as: parent, plan: JSON.stringify(changedPlan()) }); }
async function moveTrunk(cwd: string) {
  const old = await revParse(cwd, 'dev'), tree = (await git(cwd, ['rev-parse', `${old}^{tree}`])).stdout.trim();
  const commit = (await git(cwd, ['commit-tree', tree, '-p', old, '-m', 'concurrent advance'], { env: identity })).stdout.trim();
  await git(cwd, ['update-ref', 'refs/heads/dev', commit, old]);
  await ops.adopt({ cwd, as: owner, channel: 'delegated', note: 'concurrent trunk advance' });
  return commit;
}
/** Interleave just before the real ledger lock; nested calls use the original lock, never bypass it. */
function interleave(t: TestContext, action: (attempt: number) => Promise<unknown>) {
  const original = Ledger.prototype.withLock;
  let inside = false, attempts = 0;
  t.mock.method(Ledger.prototype, 'withLock', async function(this: Ledger, ...args: Parameters<Ledger['withLock']>) {
    if (args[1] === undefined && !inside) {
      inside = true;
      try { await action(++attempts); } finally { inside = false; }
    }
    return original.apply(this, args);
  });
  return () => attempts;
}
const isCas = (e: unknown) => e instanceof OwedError && e.constructor === OwedError && e.code === 'refused' && e.message === 'Plan, candidate or trunk changed; retry';

test('N2 rollback deletes an untouched branch even when main HEAD does not contain dispatch base', async t => {
  const r = await fixture();
  try {
    assert.equal((await git(r.cwd, ['merge-base', '--is-ancestor', r.base, 'main'], { allowFail: true })).code, 1);
    const count = interleave(t, async n => { if (n === 1) await recordPlan(r.cwd); });
    await assert.rejects(ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' }), isCas);
    assert.equal(count(), 1, 'a changed plan never retries');
    assert.equal(await hasBranch(r.cwd), false);
    assert.equal(await slots(r.cwd), 1);
    assert.equal(existsSync(join(r.cwd, '.owed/wt')), false);
    assert.equal((await entries(r.cwd)).filter(e => e.kind === 'dispatch').length, 0);
  } finally { t.mock.restoreAll(); await r.cleanup(); }
});

test('N2 rollback preserves a branch that acquired writer commits and reports the ref CAS failure without retry', async t => {
  const r = await fixture();
  try {
    let written = '';
    const count = interleave(t, async n => { if (n === 1) { written = await commitAt(join(r.cwd, '.owed/wt/a-1'), { 'a/new': 'writer work\n' }); await moveTrunk(r.cwd); } });
    await assert.rejects(ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' }), (e: unknown) => {
      assert.ok(e instanceof OwedError); assert.equal(e.code, 'refused');
      assert.match(e.message, /^Plan, candidate or trunk changed; retry\nrollback failed: git branch -d: .*is at [a-f0-9]+ but expected [a-f0-9]+/); return true;
    });
    assert.equal(count(), 1, 'rollback failure must not be retried');
    assert.equal(await revParse(r.cwd, 'owed/a/1'), written);
    assert.equal(await slots(r.cwd), 1);
    assert.equal((await entries(r.cwd)).filter(e => e.kind === 'dispatch').length, 0);
  } finally { t.mock.restoreAll(); await r.cleanup(); }
});

test('N2 review #976: rollback preserves a ref advanced immediately before deletion', async t => {
  const r = await fixture(), oldPath = process.env.PATH;
  try {
    const tree = (await git(r.cwd, ['rev-parse', `${r.base}^{tree}`])).stdout.trim();
    const moved = (await git(r.cwd, ['commit-tree', tree, '-p', r.base, '-m', 'concurrent writer'], { env: identity })).stdout.trim();
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    const bin = join(r.root, 'bin'), mark = join(r.root, 'race');
    await mkdir(bin);
    // A real ref writer runs immediately before either the old unsafe delete or the corrected atomic delete.
    await writeFile(join(bin, 'git'), [
      '#!/bin/sh',
      'if { [ "$1" = branch ] && [ "$2" = -D ] && [ "$3" = owed/a/1 ]; } || { [ "$1" = update-ref ] && [ "$2" = -d ] && [ "$3" = refs/heads/owed/a/1 ]; }; then',
      `  '${realGit}' update-ref refs/heads/owed/a/1 '${moved}' '${r.base}' || exit 91`,
      `  '${realGit}' rev-parse refs/heads/owed/a/1 > '${mark}'`,
      'fi', `exec '${realGit}' "$@"`, '',
    ].join('\n'), { mode: 0o755 });
    process.env.PATH = `${bin}:${oldPath ?? ''}`;
    const count = interleave(t, async n => { if (n === 1) await recordPlan(r.cwd); });
    let failure: unknown;
    await assert.rejects(ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' }), (e: unknown) => { failure = e; return true; });
    assert.equal((await readFile(mark, 'utf8')).trim(), moved, 'the concurrent ref write happened before deletion');
    assert.equal(await hasBranch(r.cwd), true, 'the concurrently advanced branch must remain');
    assert.equal(await revParse(r.cwd, 'owed/a/1'), moved);
    assert.ok(failure instanceof OwedError); assert.equal(failure.code, 'refused');
    assert.match(failure.message, /^Plan, candidate or trunk changed; retry\nrollback failed: git branch -d: .*is at [a-f0-9]+ but expected [a-f0-9]+/);
    assert.equal(count(), 1); assert.equal(await slots(r.cwd), 1);
    assert.equal((await entries(r.cwd)).filter(e => e.kind === 'dispatch').length, 0);
  } finally {
    if (oldPath === undefined) delete process.env.PATH; else process.env.PATH = oldPath;
    t.mock.restoreAll(); await r.cleanup();
  }
});

for (const operation of ['dispatch', 'plan'] as const) {
  test(`N2 ${operation} retries a single trunk move from a fresh read`, async t => {
    const r = await fixture();
    try {
      let moved = '';
      const count = interleave(t, async n => { if (n === 1) moved = await moveTrunk(r.cwd); });
      const result = operation === 'dispatch'
        ? (await ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' })).entry
        : await recordPlan(r.cwd);
      assert.equal(count(), 2);
      assert.equal(result.kind, operation);
      assert.equal((await entries(r.cwd)).filter(e => e.kind === operation).length, 1);
      if (operation === 'dispatch') {
        assert.ok(result.kind === 'dispatch'); assert.equal(result.base, moved);
        assert.equal(result.attempt, 1); assert.equal(await revParse(result.worktree, 'HEAD'), moved);
        assert.equal(await slots(r.cwd), 2);
      } else { assert.equal((await ops.status({ cwd: r.cwd })).trunk.commit, moved); }
      assert.equal((await ops.verify({ cwd: r.cwd })).ok, true);
    } finally { t.mock.restoreAll(); await r.cleanup(); }
  });
  test(`N2 ${operation} returns the last unchanged refusal after three CAS failures`, async t => {
    const r = await fixture();
    try {
      const count = interleave(t, () => moveTrunk(r.cwd));
      await assert.rejects(operation === 'dispatch' ? ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' }) : recordPlan(r.cwd), isCas);
      assert.equal(count(), 3);
      assert.equal((await entries(r.cwd)).filter(e => e.kind === operation).length, 0);
      assert.equal(await hasBranch(r.cwd), false); assert.equal(await slots(r.cwd), 1);
    } finally { t.mock.restoreAll(); await r.cleanup(); }
  });
}

test('N2 plan refuses another plan recorded after its read, without overwriting it', async t => {
  const r = await fixture();
  try {
    const count = interleave(t, async n => { if (n === 1) await recordPlan(r.cwd); });
    await assert.rejects(ops.planSet({ cwd: r.cwd, as: parent, plan: JSON.stringify(spec()) }), isCas);
    assert.equal(count(), 1);
    assert.equal((await entries(r.cwd)).filter(e => e.kind === 'plan').length, 1);
  } finally { t.mock.restoreAll(); await r.cleanup(); }
});

test('N2 plan retry around carry appends exactly one carry from the successful fresh read', async t => {
  const r = await fixture();
  try {
    const d = await ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' });
    await commitAt(d.worktree, { 'a/x': 'work\n' });
    const sub = await ops.submit({ cwd: d.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
    const next = spec(); next.nodes[0] = { ...next.nodes[0]!, checks: [{ id: 'added', run: 'true', reads: ['a/**'], timeout_s: 10 }] } as typeof next.nodes[0];
    const count = interleave(t, async n => { if (n === 1) await moveTrunk(r.cwd); });
    const notCarried: ops.NotCarried[] = [];
    const plan = await ops.planSet({ cwd: r.cwd, as: parent, plan: JSON.stringify(next), notCarried });
    assert.equal(count(), 2, 'one CAS retry');
    const es = await entries(r.cwd), after = es.filter(e => e.seq > plan.seq);
    assert.equal(es.filter(e => e.kind === 'plan').length, 1);
    assert.equal(after.length, 1, JSON.stringify(after.map(e => e.kind)));
    const carry = after[0]!;
    assert.ok(carry.kind === 'submit' && carry.by === 'executor:owed' && carry.carry === sub.seq && carry.seq === plan.seq + 1);
    assert.equal(es.filter(e => e.kind === 'submit' && e.carry !== undefined).length, 1, 'no duplicate carry');
    assert.deepEqual(notCarried, []);
    assert.deepEqual((await ops.carriedBy({ cwd: r.cwd, plan: plan.seq })).map(e => e.seq), [carry.seq]);
    assert.equal((await ops.verify({ cwd: r.cwd })).ok, true);
  } finally { t.mock.restoreAll(); await r.cleanup(); }
});

test('N2 dispatch refreshes rulings after another node records a ruling', async t => {
  const r = await fixture();
  try {
    const count = interleave(t, async n => { if (n === 1) await ops.rule({ cwd: r.cwd, as: parent, nodes: ['b'], text: 'other node decision' }); });
    const result = await ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' });
    assert.equal(count(), 2); assert.equal(result.attempt, 1);
    assert.equal((await entries(r.cwd)).filter(e => e.kind === 'dispatch').length, 1);
  } finally { t.mock.restoreAll(); await r.cleanup(); }
});

test('N2 definition hint lists exactly changed fields and still respects check allowances', async () => {
  const r = await fixture();
  try {
    const before = parsePlan(JSON.stringify(spec()));
    before.nodes[0]!.checks = [{ id: 'unit', run: 'true', timeout_s: 10, reads: ['a/**'], tests: ['a/test'], red_expect: 'failure' }];
    await ops.planSet({ cwd: r.cwd, as: parent, plan: JSON.stringify(before) });
    const after = structuredClone(before); after.nodes[0]!.checks[0]!.run = 'echo ready; true'; after.nodes[0]!.checks[0]!.reads = ['a/new/**'];
    await assert.rejects(ops.planSet({ cwd: r.cwd, as: parent, plan: JSON.stringify(after) }), /unit check definition changed \(run, reads\); owed cannot compare commands, so this needs owner authority or an allow rule; to avoid it, add the new command as a new check id/);
    const c = before.nodes[0]!.checks[0]!;
    for (const field of ['run', 'timeout_s', 'reads', 'tests', 'red_expect'] as const) {
      const p = structuredClone(before);
      Object.assign(p.nodes[0]!.checks[0]!, { [field]: Array.isArray(c[field]) ? ['changed'] : typeof c[field] === 'number' ? 20 : 'changed' });
      assert.match(uncoveredDowngrades(before, p)[0]!.what, new RegExp(`check definition changed \\(${field}\\)`));
      const allowed = { ...before, allow: [{ nodes: ['a'], checks: ['unit'] }] };
      assert.deepEqual(uncoveredDowngrades(allowed, { ...p, allow: allowed.allow }), []);
    }
    const allowed = { ...before, allow: [{ nodes: ['a'], checks: ['unit'] }] };
    await ops.planSet({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'allow unit definition changes', plan: JSON.stringify(allowed) });
    await ops.planSet({ cwd: r.cwd, as: parent, plan: JSON.stringify({ ...after, allow: allowed.allow }) });
    assert.equal((await ops.verify({ cwd: r.cwd })).ok, true, 'allowance matching also works on replay');
  } finally { await r.cleanup(); }
});

test('N2 warnings skip merged nodes in helpers, CLI and pi; init and invariants keep their warnings', async () => {
  const r = await fixture();
  try {
    const d = await ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' });
    await commitAt(d.worktree, { 'a/x': 'done\n' });
    await ops.submit({ cwd: d.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
    await ops.attest({ cwd: r.cwd, node: 'a' });
    await ops.merge({ cwd: r.cwd, node: 'a', as: parent });
    const p = parsePlan(JSON.stringify(spec())), merged = new Set(['a']);
    assert.equal(checklessWarnings(p, merged).length, 1);
    assert.equal(planWarnings(p).length, 2, 'init has no merged set');
    const loop = { id: 'loop', run: 'for i in 1 2; do echo ok; done', reads: ['**'], timeout_s: 10, min_tests: 1 };
    p.nodes[0]!.checks = [loop]; p.nodes[1]!.checks = [loop]; p.invariants = [loop];
    assert.equal(loopWarnings(p).length, 3);
    assert.equal(loopWarnings(p, merged).length, 2, 'invariant and unmerged b stay');
    assert.ok(planWarnings(p, merged).every(w => !w.includes('node a')));
    const tools = new Map<string, ToolDefinition>();
    owed({ registerTool(t: ToolDefinition) { tools.set(t.name, t); }, registerCommand() {} } as unknown as ExtensionAPI);
    const ctx = { cwd: r.cwd, hasUI: false, ui: { notify() {} } } as unknown as ExtensionContext;
    for (const plan of [spec(), p]) {
      const file = join(r.root, 'plan.json'); await writeFile(file, JSON.stringify(plan));
      const out = await cli(r.cwd, ['plan', file, '--json']);
      assert.equal(out.code, 0, out.stderr);
      const warnings = JSON.parse(out.stdout).warnings as string[];
      assert.ok(warnings.length > 0); assert.ok(warnings.every(w => !w.includes('node a')), warnings.join('\n'));
      const result = await tools.get('owed_plan')!.execute('test', { plan: file, as: 'parent:test' }, undefined, undefined, ctx as Parameters<ToolDefinition['execute']>[4]);
      assert.deepEqual((result.details as { warnings: string[] }).warnings, warnings);
    }
  } finally { await r.cleanup(); }
});
