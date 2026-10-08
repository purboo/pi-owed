import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import { repo } from './helpers/repo.ts';
import { parsePlan } from '../src/plan.ts';
import { H, EMPTY_SHA } from '../src/canon.ts';
import { git, candidateFacts, stateFacts, readsDigest, buildMerge, advanceTrunk, materialize, overlay, isClean, isAncestor, addWorktree, repoRoot, revParse } from '../src/git.ts';
test('content keys reuse on merge, overlays, worktrees and trunk CAS', async () => {
  const r = await repo();
  try {
    await r.put('src/a', 'old'); await r.put('test/a', 'test'); await r.put('helper', 'base'); const base = await r.commit();
    const plan = parsePlan(`version: 1\ntrunk: main\nclosure: [helper, 'extra*']\ninvariants: [{id: inv, run: test, reads: ['src/**']}]\nnodes:\n - id: a\n   writes: [src/, test/]\n   review: {count: 1}\n   checks: [{id: unit, run: test, reads: ['src/**'], red: true, tests: ['test/**']}]`);
    await git(r.cwd, ['checkout', '-b', 'candidate']);
    await r.put('src/a', 'new'); await r.put('helper', 'hacked'); await r.put('extra-helper', 'hacked'); const cand = await r.commit();
    const facts = await candidateFacts(r.cwd, plan, plan.nodes[0]!, base, cand, 1);
    assert.ok(facts.closureTouched); assert.ok(facts.keys['closure-review']); assert.ok(facts.keys.review);
    assert.equal(facts.keys.writes, H({ o: 'writes', base, cand, writes: plan.nodes[0]!.writes }));
    assert.equal((await candidateFacts(r.cwd, plan, plan.nodes[0]!, base, base, 1)).patch, EMPTY_SHA);
    const merge = await buildMerge(r.cwd, base, cand, 'merge'); assert.ok('commit' in merge);
    const merged = await candidateFacts(r.cwd, plan, plan.nodes[0]!, base, merge.commit, 1);
    assert.equal(merged.keys['check:unit'], facts.keys['check:unit']); assert.equal(merged.keys['red:unit'], facts.keys['red:unit']);
    assert.notEqual(merged.keys.writes, facts.keys.writes);
    assert.equal(await readsDigest(r.cwd, cand, ['**']), await readsDigest(r.cwd, merge.commit, ['**']));
    assert.ok((await stateFacts(r.cwd, plan, cand)).invKeys.inv);
    assert.ok(await isAncestor(r.cwd, base, cand)); assert.equal(await repoRoot(r.cwd), r.cwd); assert.ok(await isClean(r.cwd));
    const w = await materialize(r.cwd, cand);
    try { await overlay(r.cwd, w.path, base, plan.closure, 'replace'); assert.equal(await readFile(join(w.path, 'helper'), 'utf8'), 'base'); await assert.rejects(access(join(w.path, 'extra-helper'))); } finally { await w.dispose(); }
    await assert.rejects(access(w.path));
    await git(r.cwd, ['checkout', 'main']);
    await r.put('dirty', 'x'); await assert.rejects(advanceTrunk(r.cwd, 'main', base, merge.commit), /dirty/);
    await git(r.cwd, ['clean', '-fd']); await advanceTrunk(r.cwd, 'main', base, merge.commit); assert.equal(await revParse(r.cwd, 'main'), merge.commit);
    await assert.rejects(advanceTrunk(r.cwd, 'main', base, cand), /CAS/);
    const other = join(r.root, 'other'); await addWorktree(r.cwd, other, 'other', base); assert.equal(await revParse(other, 'HEAD'), base);
    await git(r.cwd, ['branch', 'unmounted', base]); await advanceTrunk(r.cwd, 'unmounted', base, cand); assert.equal(await revParse(r.cwd, 'unmounted'), cand);
  } finally { await r.cleanup(); }
});
test('merge conflicts do not move refs', async () => {
  const r = await repo(); try {
    await r.put('a', 'base\n'); const base = await r.commit(); await r.put('a', 'left\n'); const left = await r.commit();
    await git(r.cwd, ['checkout', '-b', 'right', base]); await r.put('a', 'right\n'); const right = await r.commit();
    const m = await buildMerge(r.cwd, left, right, 'conflict'); assert.ok('conflicts' in m); assert.ok(m.conflicts.length); assert.equal(await revParse(r.cwd, 'main'), left);
  } finally { await r.cleanup(); }
});
