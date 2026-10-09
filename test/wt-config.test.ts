// D19: configurable worktree root and branch names; trunk checked out in a linked worktree.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repo } from './helpers/repo.ts';
import { cli, commitAt, planText, seed } from './helpers/surface.ts';
import { git, revParse } from '../src/git.ts';
import { parsePlan, planDowngrades, expandBranch } from '../src/plan.ts';
import type { DispatchPacket, StatusView } from '../src/ops.ts';

type Gc = { removed: { node: string; attempt: number; worktree: string | null; branch: string | null }[]; kept: unknown[] };
async function call<T>(cwd: string, args: string[]): Promise<T> { const out = await cli(cwd, [...args, '--json']); assert.equal(out.code, 0, `${args.join(' ')}\n${out.stderr}\n${out.stdout}`); return JSON.parse(out.stdout) as T; }
const hasBranch = async (cwd: string, b: string) => (await git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${b}`], { allowFail: true })).code === 0;
const base = JSON.parse(planText) as Record<string, unknown> & { nodes: Record<string, unknown>[] };
const yamlPlan = (extra: Record<string, unknown>) => JSON.stringify({ ...base, ...extra });

test('plan: worktrees block and node type parse; bad keys, types and templates are errors', () => {
  const plain = parsePlan(planText);
  assert.ok(!('worktrees' in plain), 'a plan without the block has no worktrees key (same canonical plan as 0.4.1)');
  assert.ok(plain.nodes.every(n => !('type' in n)));
  const p = parsePlan(yamlPlan({ worktrees: { root: '../dev/wt', branch: '{type}/{node}-{attempt}' }, nodes: [{ ...base.nodes[0], type: 'fix' }, base.nodes[1]] }));
  assert.deepEqual(p.worktrees, { root: '../dev/wt', branch: '{type}/{node}-{attempt}' });
  assert.equal(p.nodes[0]!.type, 'fix');
  assert.deepEqual(parsePlan(yamlPlan({ worktrees: {} })).worktrees, { root: '.owed/wt', branch: 'owed/{node}/{attempt}' });
  assert.equal(expandBranch('{type}/{node}-{attempt}', p.nodes[0]!, 3), 'fix/a-3');
  assert.equal(expandBranch('{type}/{node}-{attempt}', p.nodes[1]!, 1), 'feat/b-1', 'type defaults to feat');
  const bad: [Record<string, unknown>, RegExp][] = [
    [{ worktrees: { root: 'x', other: 1 } }, /worktrees\.other: unknown key/],
    [{ worktrees: 'x' }, /worktrees: expected object/],
    [{ worktrees: { root: 5 } }, /worktrees\.root: expected non-empty string/],
    [{ worktrees: { branch: 7 } }, /worktrees\.branch: expected non-empty string/],
    [{ worktrees: { branch: 'owed/{node}' } }, /must contain \{attempt\}/],
    [{ worktrees: { branch: '{attempt}' } }, /must contain \{node\}/],
    [{ worktrees: { branch: '{kind}/{node}-{attempt}' } }, /unknown placeholder \{kind\}/],
    [{ nodes: [{ ...base.nodes[0], type: 'Fix' }, base.nodes[1]] }, /nodes\[0\]\.type/],
    [{ nodes: [{ ...base.nodes[0], type: 3 }, base.nodes[1]] }, /nodes\[0\]\.type/],
  ];
  for (const [extra, re] of bad) assert.throws(() => parsePlan(yamlPlan(extra)), (e: Error & { code?: string }) => re.test(e.message) && e.code === 'usage', JSON.stringify(extra));
  // D19.4: not obligations.
  assert.deepEqual(planDowngrades(plain, p), []);
  assert.deepEqual(planDowngrades(p, plain), []);
});

/** Main worktree on `work` (modified tracked + untracked file); trunk `dev` in a linked worktree outside it; slots under <root>/slots. */
async function wais(opts: { type?: string } = {}) {
  const r = await repo();
  await seed(r.cwd);
  const dev = join(r.root, 'dev-wt'), slots = join(r.root, 'outside', 'slots');
  await git(r.cwd, ['branch', 'dev']); await git(r.cwd, ['worktree', 'add', dev, 'dev']);
  await git(r.cwd, ['switch', '-c', 'work']);
  await writeFile(join(r.cwd, 'test', 'b.cjs'), 'module.exports=42; // user edit\n');
  await writeFile(join(r.cwd, 'notes.txt'), 'untracked user notes\n');
  const plan = join(r.root, 'plan.yaml');
  await writeFile(plan, yamlPlan({ trunk: 'dev', worktrees: { root: slots, branch: '{type}/{node}-{attempt}' }, nodes: [{ ...base.nodes[0], type: opts.type ?? 'fix' }, base.nodes[1]] }));
  const snapshot = async () => ({
    status: (await git(r.cwd, ['status', '--porcelain=v1', '-z'])).stdout,
    head: await revParse(r.cwd, 'HEAD'), sym: (await git(r.cwd, ['symbolic-ref', 'HEAD'])).stdout,
    exclude: await readFile(join(r.cwd, '.git', 'info', 'exclude'), 'utf8').catch(() => ''),
  });
  return { r, dev, slots, plan, snapshot };
}

test('D19.6 acceptance: outside root, templated branch, trunk in a linked worktree; main worktree untouched end to end', { timeout: 180_000 }, async () => {
  const { r, dev, slots, plan, snapshot } = await wais();
  try {
    const before = await snapshot();
    assert.ok(before.status.includes('test/b.cjs') && before.status.includes('notes.txt'), 'fixture: main worktree is dirty');
    await call(r.cwd, ['init', plan, '--i-am-owner']);
    const status = await cli(r.cwd, ['status']);
    assert.equal(status.code, 0, status.stderr);
    assert.ok(status.stdout.split('\n').includes(`Trunk dev is checked out at ${dev}; merges fast-forward it there (keep it clean).`), status.stdout);
    assert.equal((await call<StatusView>(r.cwd, ['status'])).trunkWorktree, dev);
    const a = await call<DispatchPacket>(r.cwd, ['dispatch', 'a']);
    assert.equal(a.worktree, join(slots, 'a-1'));
    assert.equal(a.branch, 'fix/a-1');
    assert.ok(existsSync(a.worktree));
    assert.equal((await git(a.worktree, ['symbolic-ref', 'HEAD'])).stdout.trim(), 'refs/heads/fix/a-1');
    assert.match(a.packet, new RegExp(`Working directory: ${a.worktree.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    await commitAt(a.worktree, { 'test/a.cjs': 'module.exports=1;', 'test/a.test.cjs': "const {test}=require('node:test'); const assert=require('node:assert/strict'); test('a',()=>assert.equal(require('./a.cjs'),1));\n" });
    await call(a.worktree, ['submit', 'a']);
    const attest = await cli(r.cwd, ['attest', 'a', '--json']); assert.equal(attest.code, 0, attest.stderr + attest.stdout);
    await call(r.cwd, ['merge', 'a']);
    const s = await call<StatusView>(r.cwd, ['status']);
    assert.equal(await revParse(dev, 'HEAD'), s.trunk.commit, 'the dev worktree was fast-forwarded to the ledger trunk');
    assert.equal(await revParse(r.cwd, 'refs/heads/dev'), s.trunk.commit);
    assert.equal((await git(dev, ['status', '--porcelain', '--untracked-files=all'])).stdout, '', 'dev worktree clean');
    assert.ok(!s.drift);
    const gc = await call<Gc>(r.cwd, ['gc']);
    assert.deepEqual(gc.removed.map(i => [i.node, i.attempt, i.worktree, i.branch]), [['a', 1, a.worktree, 'fix/a-1']]);
    assert.ok(!existsSync(a.worktree)); assert.ok(!await hasBranch(r.cwd, 'fix/a-1'));
    assert.deepEqual(await snapshot(), before, 'main worktree status -z, HEAD, branch and info/exclude are byte-identical');
    await call(r.cwd, ['verify']);
  } finally { await r.cleanup(); }
});

test('D19.5: a dirty trunk worktree makes merge refuse with the remedy, trunk unchanged', { timeout: 180_000 }, async () => {
  const { r, dev, plan } = await wais();
  try {
    await call(r.cwd, ['init', plan, '--i-am-owner']);
    const a = await call<DispatchPacket>(r.cwd, ['dispatch', 'a']);
    await commitAt(a.worktree, { 'test/a.cjs': 'module.exports=1;', 'test/a.test.cjs': "const {test}=require('node:test'); const assert=require('node:assert/strict'); test('a',()=>assert.equal(require('./a.cjs'),1));\n" });
    await call(a.worktree, ['submit', 'a']);
    assert.equal((await cli(r.cwd, ['attest', 'a'])).code, 0);
    await writeFile(join(dev, 'test', 'state.cjs'), 'module.exports=1; // dirty in dev\n');
    const trunk = await revParse(r.cwd, 'refs/heads/dev'), ledgerTrunk = (await call<StatusView>(r.cwd, ['status'])).trunk.commit;
    const out = await cli(r.cwd, ['merge', 'a']);
    assert.equal(out.code, 1, out.stderr);
    assert.ok(out.stderr.includes(`trunk worktree ${dev} has uncommitted changes: commit them there, or detach it (git -C ${dev} switch --detach), then retry`), out.stderr);
    assert.equal(await revParse(r.cwd, 'refs/heads/dev'), trunk);
    assert.equal(await revParse(dev, 'HEAD'), trunk);
    const s = await call<StatusView>(r.cwd, ['status']);
    assert.equal(s.trunk.commit, ledgerTrunk); assert.equal(s.nodes.a!.phase === 'merged', false);
    assert.equal(await readFile(join(dev, 'test', 'state.cjs'), 'utf8'), 'module.exports=1; // dirty in dev\n', 'dirty work preserved');
  } finally { await r.cleanup(); }
});

test('D19.5: no trunk line when the trunk is checked out in the main worktree or nowhere', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    await seed(r.cwd); const plan = join(r.root, 'plan.yaml'); await writeFile(plan, planText);
    await call(r.cwd, ['init', plan, '--i-am-owner']);
    let s = await cli(r.cwd, ['status']); assert.equal(s.code, 0); assert.doesNotMatch(s.stdout, /is checked out at/);
    assert.ok(!('trunkWorktree' in await call<StatusView>(r.cwd, ['status'])));
    await git(r.cwd, ['switch', '--detach']);
    s = await cli(r.cwd, ['status']); assert.equal(s.code, 0); assert.doesNotMatch(s.stdout, /is checked out at/);
  } finally { await r.cleanup(); }
});

test('D19.2/3: a root inside the main worktree is excluded by its path; the default root keeps .owed/', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    await seed(r.cwd); const plan = join(r.root, 'plan.yaml');
    await writeFile(plan, yamlPlan({ worktrees: { root: 'slots/x' } }));
    await call(r.cwd, ['init', plan, '--i-am-owner']);
    const a = await call<DispatchPacket>(r.cwd, ['dispatch', 'a']);
    assert.equal(a.worktree, join(r.cwd, 'slots', 'x', 'a-1'));
    assert.equal(a.branch, 'owed/a/1', 'default branch template');
    const exclude = (await readFile(join(r.cwd, '.git', 'info', 'exclude'), 'utf8')).split('\n');
    assert.ok(exclude.includes('/slots/x/'), exclude.join('\n')); assert.ok(!exclude.includes('.owed/'));
    assert.equal((await git(r.cwd, ['status', '--porcelain', '--untracked-files=all'])).stdout, '', 'the slot root is ignored in the main worktree');
  } finally { await r.cleanup(); }
});

test('D19.2: an invalid expanded branch name refuses dispatch (usage) before any ledger, exclude or worktree effect', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    await seed(r.cwd); const plan = join(r.root, 'plan.yaml'), slots = join(r.root, 'slots');
    await writeFile(plan, yamlPlan({ worktrees: { root: 'inside', branch: 'x..{node}/{attempt}' } }));
    await call(r.cwd, ['init', plan, '--i-am-owner']);
    const ledger = await readFile(join(r.root, 'ledger', 'ledger.jsonl'), 'utf8'), exclude = await readFile(join(r.cwd, '.git', 'info', 'exclude'), 'utf8').catch(() => '');
    const out = await cli(r.cwd, ['dispatch', 'a']);
    assert.equal(out.code, 2, out.stderr); assert.match(out.stderr, /x\.\.a\/1.*not a valid git branch name/);
    assert.equal(await readFile(join(r.root, 'ledger', 'ledger.jsonl'), 'utf8'), ledger);
    assert.equal(await readFile(join(r.cwd, '.git', 'info', 'exclude'), 'utf8').catch(() => ''), exclude);
    assert.ok(!existsSync(join(r.cwd, 'inside'))); assert.ok(!existsSync(slots));
    assert.equal((await git(r.cwd, ['worktree', 'list', '--porcelain'])).stdout.split('\n').filter(l => l.startsWith('worktree ')).length, 1);
  } finally { await r.cleanup(); }
});

test('D19.4: changing worktrees or type is not a downgrade, keeps the candidate, and only affects later dispatches', { timeout: 180_000 }, async () => {
  const r = await repo();
  try {
    await seed(r.cwd); const plan = join(r.root, 'plan.yaml'), later = join(r.root, 'later');
    await writeFile(plan, planText);
    await call(r.cwd, ['init', plan, '--i-am-owner']);
    const a1 = await call<DispatchPacket>(r.cwd, ['dispatch', 'a']);
    assert.equal(a1.worktree, join(r.cwd, '.owed', 'wt', 'a-1')); assert.equal(a1.branch, 'owed/a/1');
    await commitAt(a1.worktree, { 'test/a.cjs': 'module.exports=1;' });
    await call(a1.worktree, ['submit', 'a']);
    const cand = (await call<StatusView>(r.cwd, ['status'])).nodes.a!.candidate!;
    await mkdir(later, { recursive: true });
    await writeFile(plan, yamlPlan({ worktrees: { root: later, branch: '{type}/{node}-{attempt}' }, nodes: [{ ...base.nodes[0], type: 'chore' }, base.nodes[1]] }));
    const entry = await call<{ kind: string; downgrades: unknown[]; by: string }>(r.cwd, ['plan', plan]);
    assert.equal(entry.kind, 'plan'); assert.deepEqual(entry.downgrades, []); assert.equal(entry.by, 'parent:cli', 'a parent may record it');
    const after = await call<StatusView>(r.cwd, ['status']);
    assert.equal(after.nodes.a!.candidate?.seq, cand.seq, 'the open candidate survives');
    assert.equal(after.nodes.a!.slot!.worktree, a1.worktree); assert.equal(after.nodes.a!.slot!.branch, 'owed/a/1', 'the open slot keeps its recorded layout');
    // submit from the recorded worktree still infers the writer.
    await commitAt(a1.worktree, { 'test/a.test.cjs': 'x' });
    await call(a1.worktree, ['submit', 'a']);
    await call(r.cwd, ['abandon', 'a', '--note', 'retry under the new layout']);
    const a2 = await call<DispatchPacket>(r.cwd, ['dispatch', 'a']);
    assert.equal(a2.worktree, join(later, 'a-2')); assert.equal(a2.branch, 'chore/a-2');
    const exclude = (await readFile(join(r.cwd, '.git', 'info', 'exclude'), 'utf8')).split('\n');
    assert.ok(!exclude.some(l => l.includes('later')), 'nothing excluded for an outside root');
    const gc = await call<Gc>(r.cwd, ['gc']);
    assert.deepEqual(gc.removed.map(i => [i.worktree, i.branch]), [[a1.worktree, 'owed/a/1']], 'gc uses the recorded layout of attempt 1');
  } finally { await r.cleanup(); }
});
