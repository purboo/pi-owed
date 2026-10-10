// G4 (contract 0.6): plan and worktree hygiene; allowance texts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stringify } from 'yaml';
import * as planModule from '../src/plan.ts';
import { parsePlan } from '../src/plan.ts';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { canonical } from '../src/canon.ts';
import { uncoveredDowngrades } from '../src/reducer.ts';
import { git } from '../src/git.ts';
import type { Entry, Plan } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

type Spec = Record<string, unknown>;
const owner = { role: 'owner' as const, id: 'human' };
const parent = { role: 'parent' as const, id: 'main' };
const check = (id: string) => ({ id, run: 'true', reads: ['**'] });
const node = (id: string, writes: string[], extra: Spec = {}): Spec => ({ id, writes, checks: [], review: { count: 0, min_rank: 1 }, ...extra });
const plain = (extra: Spec = {}, nodes: Spec[] = [node('a', ['a/']), node('b', ['b/'])]): Spec => ({ version: 1, trunk: 'main', closure: [], invariants: [], nodes, ...extra });
const P = (s: Spec): Plan => parsePlan(JSON.stringify(s));
const entries = async (cwd: string): Promise<Entry[]> => (await Ledger.open(cwd)).read();
const hasBranch = async (cwd: string, b: string) => (await git(cwd, ['show-ref', '--verify', '--quiet', `refs/heads/${b}`], { allowFail: true })).code === 0;
const worktreeCount = async (cwd: string) => (await git(cwd, ['worktree', 'list', '--porcelain'])).stdout.split('\n').filter(l => l.startsWith('worktree ')).length;
async function fixture(plan: Spec) {
  const r = await repo();
  try { await commitAt(r.cwd, { README: 'x\n', 'testdata/keep': 'k\n' }); await ops.init({ cwd: r.cwd, plan: JSON.stringify(plan), as: owner, channel: 'flag' }); return r; }
  catch (e) { await r.cleanup(); throw e; }
}
/** Records plan `plan` as an older owed would have (no G4 checks): blob as ops stores it, a parent plan entry without downgrades. */
async function legacyPlan(cwd: string, plan: Spec): Promise<void> {
  const ledger = await Ledger.open(cwd), data = stringify(JSON.parse(canonical(P(plan))), { sortMapEntries: true }), sha = await ledger.putBlob(data);
  await ledger.withLock(async () => {
    const law = (await ledger.read()).findLast(e => e.kind === 'plan' || e.kind === 'genesis');
    assert.ok(law && (law.kind === 'plan' || law.kind === 'genesis'));
    await ledger.append([{ kind: 'plan', by: 'parent:old', prior: law.plan, plan: sha, downgrades: [] }]);
  });
}

test('G4.1/G4.2: the ambiguity rule accepts separated templates and refuses ones two (node, attempt) pairs can share', () => {
  const ambiguity = (planModule as Record<string, unknown>).branchAmbiguityErrors as ((t: string, l: string) => string[]) | undefined;
  assert.equal(typeof ambiguity, 'function', 'plan.ts exports branchAmbiguityErrors');
  for (const ok of ['owed/{node}/{attempt}', '{type}/{node}-{attempt}', '{attempt}/{node}', 'x{attempt}.{type}_{node}', '{node}/{type}/{attempt}', '{node}.{attempt}.x'])
    assert.deepEqual(ambiguity!(ok, 'worktrees.branch'), [], ok);
  for (const bad of ['{node}{attempt}', '{attempt}{node}', '{node}1{attempt}', '{type}{node}/{attempt}', '{node}-{type}-{attempt}', '{type}-{node}/{attempt}', '{node}/{node}/{attempt}'])
    assert.notDeepEqual(ambiguity!(bad, 'worktrees.branch'), [], bad);
  // The rule is sound for the example of the contract: a1#1 and a#11 collide under {node}{attempt}.
  assert.equal(planModule.expandBranch('{node}{attempt}', { id: 'a1' }, 1), planModule.expandBranch('{node}{attempt}', { id: 'a' }, 11));
});

test('G4.1/G4.2: init and plan refuse control characters in worktrees and an ambiguous template; nothing recorded; replay still reads them', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    await commitAt(r.cwd, { README: 'x\n' });
    const bad: [Spec, RegExp][] = [
      [{ worktrees: { root: 'slots\n/x' } }, /worktrees\.root: must not contain control characters/],
      [{ worktrees: { root: 'slots\tx' } }, /worktrees\.root: must not contain control characters/],
      [{ worktrees: { root: 'slots\u007fx' } }, /worktrees\.root: must not contain control characters/],
      [{ worktrees: { root: 'slots\u2028x' } }, /worktrees\.root: must not contain control characters/],
      [{ worktrees: { branch: 'owed/{node}\u2029/{attempt}' } }, /worktrees\.branch: must not contain control characters/],
      [{ worktrees: { branch: 'owed/{node}{attempt}' } }, /worktrees\.branch: \{attempt\} must be preceded by a separator character/],
      [{ worktrees: { branch: '{type}{node}/{attempt}' } }, /worktrees\.branch: \{type\} must be followed by a separator character/],
    ];
    for (const [extra, re] of bad) {
      await assert.rejects(ops.init({ cwd: r.cwd, plan: JSON.stringify(plain(extra)), as: owner, channel: 'flag' }), (e: Error & { code?: string }) => re.test(e.message) && e.code === 'usage', JSON.stringify(extra));
      // Parsing alone (replay of a recorded plan) does not refuse it.
      assert.doesNotThrow(() => P(plain(extra)));
    }
    assert.deepEqual(await entries(r.cwd), [], 'no refused init recorded anything');
    const file = join(r.root, 'nl.json'); await writeFile(file, JSON.stringify(plain({ worktrees: { root: 'a\nb' } })));
    const out = await cli(r.cwd, ['init', file, '--i-am-owner']);
    assert.equal(out.code, 2, out.stderr); assert.match(out.stderr, /worktrees\.root: must not contain control characters/);
    await ops.init({ cwd: r.cwd, plan: JSON.stringify(plain({ worktrees: { branch: '{type}/{node}-{attempt}' } })), as: owner, channel: 'flag' });
    const before = await entries(r.cwd);
    await assert.rejects(ops.planSet({ cwd: r.cwd, plan: JSON.stringify(plain({ worktrees: { branch: '{node}{attempt}' } })), as: parent }), /worktrees\.branch: \{attempt\} must be preceded/);
    assert.deepEqual(await entries(r.cwd), before, 'the refused plan update recorded nothing');
    // A ledger an older owed wrote with such a template stays readable.
    await legacyPlan(r.cwd, plain({ worktrees: { branch: '{node}{attempt}' } }));
    const status = await cli(r.cwd, ['status']); assert.equal(status.code, 0, status.stderr);
    assert.equal((await cli(r.cwd, ['verify'])).code, 0);
  } finally { await r.cleanup(); }
});

test('G4.2: gc keeps a branch whose recorded name another attempt also recorded (ambiguous template of an older plan)', { timeout: 180_000 }, async () => {
  // {type}{node}/{attempt}: node c of type ab and node bc of type a both expand attempt 1 to abc/1.
  const r = await fixture(plain({}, [node('c', ['c/'], { type: 'ab' }), node('bc', ['bc/'], { type: 'a' })]));
  try {
    await legacyPlan(r.cwd, plain({ worktrees: { branch: '{type}{node}/{attempt}' } }, [node('c', ['c/'], { type: 'ab' }), node('bc', ['bc/'], { type: 'a' })]));
    const c = await ops.dispatch({ cwd: r.cwd, as: parent, node: 'c' });
    assert.equal(c.branch, 'abc/1');
    await ops.abandon({ cwd: r.cwd, as: parent, node: 'c', reason: 'retry later' });
    const first = await ops.gc({ cwd: r.cwd });
    assert.deepEqual(first.removed.map(i => [i.node, i.attempt, i.branch]), [['c', 1, 'abc/1']], 'only c#1 recorded the name: collected');
    const bc = await ops.dispatch({ cwd: r.cwd, as: parent, node: 'bc' });
    assert.equal(bc.branch, 'abc/1', 'the same name for another attempt');
    const work = await commitAt(bc.worktree, { 'bc/x': 'work in progress\n' });
    // The slot directory is removed by hand: nothing checks the branch out any more.
    await git(r.cwd, ['worktree', 'remove', '--force', bc.worktree]);
    const second = await ops.gc({ cwd: r.cwd });
    assert.ok(await hasBranch(r.cwd, 'abc/1'), 'the branch of the open slot bc#1 survives gc of c#1');
    assert.equal((await git(r.cwd, ['rev-parse', 'refs/heads/abc/1'])).stdout.trim(), work);
    assert.deepEqual(second.removed, []);
    assert.ok(second.kept.some(k => k.node === 'c' && k.attempt === 1 && /branch name abc\/1 is also recorded for bc#1; not deleted/.test(k.reason)), JSON.stringify(second.kept));
  } finally { await r.cleanup(); }
});

test('G4.3: a dispatch that fails in git worktree add removes the parent directories it created', { timeout: 120_000 }, async () => {
  const r = await fixture(plain({ worktrees: { root: 'deep/er/slots' } }));
  try {
    await git(r.cwd, ['branch', 'owed/a/1']);
    const before = await entries(r.cwd);
    await assert.rejects(ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' }), /already exists/);
    assert.ok(!existsSync(join(r.cwd, 'deep')), 'deep/er/slots created by the dispatch is gone');
    assert.deepEqual(await entries(r.cwd), before);
    assert.equal(await worktreeCount(r.cwd), 1);
  } finally { await r.cleanup(); }
});

test('G4.3: a dispatch that rolls back (rulings changed under it) removes the parent directories it created, not existing ones', { timeout: 120_000 }, async () => {
  const r = await fixture(plain({ worktrees: { root: 'keep/new/slots' } }));
  try {
    await commitAt(r.cwd, { 'keep/file': 'tracked\n' });
    // post-checkout runs inside `git worktree add`: it records a ruling, so the dispatch's append sees changed rulings.
    const owed = fileURLToPath(new URL('../bin/owed.js', import.meta.url)), mark = join(r.root, 'hook-ran'), hook = join(r.cwd, '.git', 'hooks', 'post-checkout');
    await writeFile(hook, `#!/bin/sh\n[ -f '${mark}' ] && exit 0\ntouch '${mark}'\nunset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_PREFIX\ncd '${r.cwd}' && '${process.execPath}' '${owed}' rule 'changed under dispatch' --nodes '*' >> '${mark}.log' 2>&1\nexit 0\n`);
    await chmod(hook, 0o755);
    await assert.rejects(ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' }), /Rulings changed; dispatch again/);
    assert.ok(existsSync(mark), 'the hook ran');
    assert.ok((await entries(r.cwd)).some(e => e.kind === 'rule'), await readFile(`${mark}.log`, 'utf8').catch(() => 'no log'));
    assert.ok(!(await entries(r.cwd)).some(e => e.kind === 'dispatch'));
    assert.ok(!existsSync(join(r.cwd, 'keep', 'new')), 'keep/new/slots created by the dispatch is gone');
    assert.equal(await readFile(join(r.cwd, 'keep', 'file'), 'utf8'), 'tracked\n', 'the existing directory stays');
    assert.equal(await worktreeCount(r.cwd), 1); assert.ok(!await hasBranch(r.cwd, 'owed/a/1'));
    // The next dispatch succeeds and recreates them.
    const a = await ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' });
    assert.ok(existsSync(a.worktree));
  } finally { await r.cleanup(); }
});

test('G4.4: a parent\'s refused plan update lists each downgrade once', { timeout: 120_000 }, async () => {
  const allow = [{ nodes: ['p'], review_count: 1, checks: ['ui-*'] }];
  const prev: Spec = plain({ allow }, [node('p', ['p/'], { review: { count: 2, min_rank: 2 }, checks: [check('ui-p'), check('core-p')] })]);
  const lower = plain({ allow }, [node('p', ['p/'], { review: { count: 0, min_rank: 2 }, checks: [check('ui-p'), check('core-p')] })]);
  const noCore = plain({ allow }, [node('p', ['p/'], { review: { count: 2, min_rank: 2 }, checks: [check('ui-p')] })]);
  const listed = (a: Spec, b: Spec) => uncoveredDowngrades(P(a), P(b), planModule.planDowngrades(P(a), P(b))).map(d => `${d.node}: ${d.what}`);
  assert.deepEqual(listed(prev, lower), ['p: review count/rank reduced']);
  assert.deepEqual(listed(prev, noCore), ['p: core-p check removed']);
  assert.deepEqual(uncoveredDowngrades(P(prev), P(noCore), []).map(d => d.what), ['core-p check removed'], 'a forged entry without items is still refused');
  const r = await fixture(prev);
  try {
    const before = await entries(r.cwd);
    await assert.rejects(ops.planSet({ cwd: r.cwd, plan: JSON.stringify(lower), as: parent }), (e: Error) => /not covered by an allowance of the current plan: p: review count\/rank reduced$/.test(e.message));
    const file = join(r.root, 'nocore.json'); await writeFile(file, JSON.stringify(noCore));
    const out = await cli(r.cwd, ['plan', file]);
    assert.equal(out.code, 1); assert.match(out.stderr, /not covered by an allowance of the current plan: p: core-p check removed(\n|$)/);
    assert.deepEqual(await entries(r.cwd), before);
  } finally { await r.cleanup(); }
});

test('G4.4: brief shows allowance labels as report does; parent adoptions are listed as adoptions, owner ones as owner decisions', { timeout: 180_000 }, async () => {
  const allow = [{ nodes: ['p'], review_count: 1 }, { adopt: ['testdata/'] }];
  const plan = plain({ allow, invariants: [{ id: 'health', run: 'test ! -f testdata/broken', reads: ['testdata/broken'] }] }, [node('p', ['p/'], { review: { count: 2, min_rank: 1 } })]);
  const r = await fixture(plan);
  try {
    const genesis = (await entries(r.cwd))[0]!;
    const eased = await ops.planSet({ cwd: r.cwd, plan: JSON.stringify(plain({ allow, invariants: (plan as { invariants: unknown }).invariants }, [node('p', ['p/'], { review: { count: 1, min_rank: 1 } })])), as: parent });
    await commitAt(r.cwd, { 'testdata/vec': 'v\n' });
    const byParent = await ops.adopt({ cwd: r.cwd, note: 'vector', as: parent });
    await commitAt(r.cwd, { 'src/z': 'z\n' });
    const byOwner = await ops.adopt({ cwd: r.cwd, note: 'release', as: owner, channel: 'flag' });
    const label = `by parent:main under allowance (plan #${genesis.seq})`;
    const brief = await cli(r.cwd, ['brief']); assert.equal(brief.code, 0, brief.stderr);
    const l = label.replace(/[()]/g, '\\$&');
    assert.match(brief.stdout, new RegExp(`\\nDowngrades under allowance \\(2\\):\\n  #${eased.seq} ${l} p: review count lowered\\n  #${eased.seq} ${l} p: review count/rank reduced\\n`));
    assert.match(brief.stdout, new RegExp(`\\nAdopted outside owed \\(owner decisions\\) \\(1\\):\\n  #${byOwner.entry.seq} owner:human \\(flag weak confirmation\\) adopted `));
    assert.match(brief.stdout, new RegExp(`\\nAdopted outside owed \\(parent adoptions under allowance\\) \\(1\\):\\n  #${byParent.entry.seq} adopted by parent:main under allowance \\(plan #${genesis.seq}\\) `));
    const json = JSON.parse((await cli(r.cwd, ['brief', '--json'])).stdout) as { allowanceDowngrades: { seq: number; allowance?: number }[] };
    assert.deepEqual(json.allowanceDowngrades.map(d => [d.seq, d.allowance]), [[eased.seq, genesis.seq]]);
    assert.doesNotMatch((await cli(r.cwd, ['brief', '--since', String(byOwner.entry.seq)])).stdout, /Downgrades under allowance|Adopted outside owed/, 'sections omitted when empty');
    const report = await cli(r.cwd, ['report']); assert.equal(report.code, 0, report.stderr);
    assert.match(report.stdout, new RegExp(`\\nTrunk adoptions \\(owner decisions: commits made outside owed\\)\\n  #${byOwner.entry.seq} owner:human .*\\nTrunk adoptions under allowance \\(parent adoptions: commits made outside owed\\)\\n  #${byParent.entry.seq} adopted by parent:main `));
  } finally { await r.cleanup(); }
});
