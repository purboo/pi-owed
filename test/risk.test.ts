// RK1–RK4: behavioral coverage through real Git slots, ops, CLI views and driver review scheduling.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import { reviewRuns, reviewObligations, reviewPacket } from '../src/views.ts';
import { ownerNeeded } from '../src/drive.ts';
import { Ledger } from '../src/ledger.ts';
import { parsePlan } from '../src/plan.ts';
import { reduce } from '../src/reducer.ts';
import type { Plan, Entry } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const owner = { role: 'owner', id: 'pi' } as const;
const parent = { role: 'parent', id: 'test' } as const;
const docs = { paths: ['docs/**'], review: { count: 0, min_rank: 1 } };
const high = { paths: ['src/ledger.ts'], review: { count: 2, min_rank: 2 } };
const neutral = [{ path: 'package.json', json_ignore: ['version'] }, { path: 'package-lock.json', json_ignore: ['version', 'packages..version'] }];
const packageJson = (version: string, script = 'test') => JSON.stringify({ version, scripts: { test: script } });
const lockJson = (version: string, dependency = '1') => JSON.stringify({ version, packages: { '': { version }, 'node_modules/dep': { version: dependency } } });

async function planLookup(cwd: string) {
  const ledger = await Ledger.open(cwd), plans = new Map<string, Plan>();
  for (const e of await ledger.read()) if (e.kind === 'genesis' || e.kind === 'plan') plans.set(e.plan, parsePlan((await ledger.getBlob(e.plan)).toString()));
  return (sha: string): Plan => plans.get(sha)!;
}

async function fixture(extra: Record<string, unknown> = {}, node: Record<string, unknown> = {}) {
  const r = await repo();
  const p = { version: 1, trunk: 'main', closure: [], invariants: [], lease: false,
    ...extra, nodes: [{ id: 'a', writes: ['docs/', 'src/', 'package.json', 'package-lock.json'], checks: [], review: { count: 1, min_rank: 1 }, ...node }] };
  try {
    await r.put('docs/readme.md', 'old docs'); await r.put('src/ledger.ts', 'old code');
    await r.put('package.json', packageJson('1')); await r.put('package-lock.json', lockJson('1'));
    await r.commit();
    await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify(p), measure: false });
    const slot = await ops.dispatch({ ...r, as: parent, node: 'a' });
    const submit = async (files: Record<string, string>, model?: string) => {
      const commit = await commitAt(slot.worktree, files);
      const e = await ops.submit({ cwd: slot.worktree, as: { role: 'writer', id: 'a#1' }, node: 'a', model });
      assert.equal(e.kind, 'submit');
      return { commit, entry: e as Extract<Entry, { kind: 'submit' }> };
    };
    const state = async () => (await ops.readState(r)).state;
    const review = async (id: string, rank: number, model?: string, obligation?: 'review' | 'closure-review') =>
      ops.review({ ...r, as: { role: 'reviewer', id }, node: 'a', verdict: 'ok', rank, note: 'verified fixture', named: (await state()).nodes.a!.candidate!.commit, model, obligation });
    return { ...r, p, slot, submit, state, review };
  } catch (e) { await r.cleanup(); throw e; }
}

for (const [name, files, count, rank] of [
  ['docs only', { 'docs/readme.md': 'docs' }, 0, 1],
  ['mixed restores node review', { 'docs/readme.md': 'docs', 'src/other.ts': 'code' }, 1, 1],
  ['raising rule', { 'src/ledger.ts': 'code' }, 2, 2],
] as const) test(`RK1: ${name}`, { timeout: 120_000 }, async () => {
  const f = await fixture({ risk: [docs, high] });
  try {
    await f.submit(files); await ops.attest({ ...f, node: 'a' });
    let s = await f.state();
    assert.equal(reviewRuns(s, 'a'), count);
    assert.deepEqual(reviewObligations(s, 'a', 1), count ? ['review'] : []);
    assert.equal(s.nodes.a!.accepted, count === 0);
    if (count) {
      await f.review('first', 1); s = await f.state();
      assert.equal(s.nodes.a!.accepted, count === 1);
      if (count > 1) {
        await f.review('first', rank); assert.equal((await f.state()).nodes.a!.accepted, false, 'one distinct reviewer is insufficient');
        await f.review('second', rank); assert.equal((await f.state()).nodes.a!.accepted, true);
      }
    }
    await ops.merge({ ...f, as: parent, node: 'a' });
    assert.ok((await f.state()).nodes.a!.merged, 'derived review is also used by the merge guard');
  } finally { await f.cleanup(); }
});

test('RK1: first match wins; count and rank maxima come from different paths', { timeout: 120_000 }, async () => {
  const f = await fixture({ risk: [docs, { paths: ['docs/*'], review: { count: 3, min_rank: 3 } },
    { paths: ['src/count*'], review: { count: 2, min_rank: 1 } }, { paths: ['src/rank?'], review: { count: 1, min_rank: 2 } }] });
  try {
    await f.submit({ 'docs/readme.md': 'docs' }); await ops.attest({ ...f, node: 'a' });
    assert.equal((await f.state()).nodes.a!.accepted, true, 'later docs rule is shadowed');
    await f.submit({ 'src/count.ts': 'count', 'src/rank2': 'rank' }); await ops.attest({ ...f, node: 'a' });
    const s = await f.state(); assert.equal(reviewRuns(s, 'a'), 2);
    assert.match(reviewPacket(s, 'a'), /2 non-writer review\(s\).*rank >= 2/);
    await f.review('one', 1); await f.review('two', 1);
    assert.equal((await f.state()).nodes.a!.accepted, false, 'rank must be the maximum independently of count');
    await f.review('one', 2); await f.review('two', 2);
    assert.equal((await f.state()).nodes.a!.accepted, true);
  } finally { await f.cleanup(); }
});

test('RK1/RK4: raised rank 3 goes to owner; lowering the node rank through a class permits driver review', { timeout: 120_000 }, async () => {
  const f = await fixture({ risk: [{ paths: ['src/**'], review: { count: 1, min_rank: 3 } }, { paths: ['docs/'], review: { count: 1, min_rank: 1 } }] }, { review: { count: 2, min_rank: 3 } });
  try {
    await f.submit({ 'src/ledger.ts': 'code' }); await ops.attest({ ...f, node: 'a' });
    assert.match(ownerNeeded(await f.state(), 'a')!, /rank 3/);
    await f.submit({ 'docs/readme.md': 'docs', 'src/ledger.ts': 'old code' }); await ops.attest({ ...f, node: 'a' });
    const s = await f.state(); assert.equal(ownerNeeded(s, 'a'), undefined);
    assert.equal(reviewRuns(s, 'a'), 1); assert.match(reviewPacket(s, 'a'), /--rank 1/);
  } finally { await f.cleanup(); }
});

test('RK2: lowering is owner-only, never allow-covered; a risk-only change keeps the candidate and every key', { timeout: 120_000 }, async () => {
  const f = await fixture({ allow: [{ nodes: ['*'], review_count: 0, review_rank: 1 }] });
  try {
    await f.submit({ 'docs/readme.md': 'docs' }); await ops.attest({ ...f, node: 'a' }); await f.review('one', 1);
    const before = (await f.state()).nodes.a!.candidate!, seq = (await f.state()).seq;
    const next = { ...f.p, risk: [docs] };
    await assert.rejects(ops.planSet({ ...f, as: parent, plan: JSON.stringify(next) }), /Only owner.*risk changed/s);
    assert.equal((await f.state()).seq, seq, 'refused update records nothing');
    const entry = await ops.planSet({ ...f, as: owner, channel: 'delegated', note: 'owner classifies docs', plan: JSON.stringify(next) });
    assert.ok(entry.kind === 'plan'); assert.deepEqual(entry.downgrades, [{ node: 'trunk', what: 'risk changed' }]);
    const after = (await f.state()).nodes.a!.candidate!;
    assert.equal(after.seq, before.seq); assert.deepEqual(after.keys, before.keys);
    assert.equal((await f.state()).nodes.a!.accepted, true);
    // Removing a lowering class only raises; the earlier review remains reusable on the identical key.
    await ops.planSet({ ...f, as: parent, plan: JSON.stringify(f.p) });
    assert.equal((await f.state()).nodes.a!.accepted, true);
    assert.deepEqual((await f.state()).nodes.a!.items.find(i => i.obligation === 'review')!.evidence.length, 1);
  } finally { await f.cleanup(); }
});

test('RK2: raising, narrowing low classes and expanding high classes are free; removing high classes or reordering to lower refuses', { timeout: 120_000 }, async () => {
  const f = await fixture({ risk: [docs, high] });
  try {
    let next = { ...f.p, risk: [{ ...docs, paths: ['docs/*.md'] }, { ...high, paths: ['src/**'] }] };
    let e = await ops.planSet({ ...f, as: parent, plan: JSON.stringify(next) });
    assert.ok(e.kind === 'plan'); assert.deepEqual(e.downgrades, []);
    const broad = { paths: ['src/'], review: { count: 0, min_rank: 1 } };
    next = { ...next, risk: [...next.risk, broad] };
    e = await ops.planSet({ ...f, as: parent, plan: JSON.stringify(next) });
    assert.ok(e.kind === 'plan'); assert.deepEqual(e.downgrades, [], 'shadowed low rule does not lower requirements');
    await assert.rejects(ops.planSet({ ...f, as: parent, plan: JSON.stringify({ ...next, risk: [broad, ...next.risk.slice(0, 2)] }) }), /risk changed/);
    await assert.rejects(ops.planSet({ ...f, as: parent, plan: JSON.stringify({ ...next, risk: [] }) }), /risk changed/);
    e = await ops.planSet({ ...f, as: parent, plan: JSON.stringify({ ...next, risk: [{ ...next.risk[0]!, review: { count: 1, min_rank: 2 } }, ...next.risk.slice(1)] }) });
    assert.ok(e.kind === 'plan'); assert.deepEqual(e.downgrades, []);
  } finally { await f.cleanup(); }
});

test('RK2: replay independently refuses a forged parent downgrade with no claimed downgrades', { timeout: 120_000 }, async () => {
  const f = await fixture();
  try {
    await ops.planSet({ ...f, as: owner, channel: 'delegated', note: 'classify docs', plan: JSON.stringify({ ...f.p, risk: [docs] }) });
    const { entries } = await ops.readState(f), lookup = await planLookup(f.cwd);
    const forged = entries.map(e => e.kind === 'plan' ? { ...e, by: 'parent:forged', downgrades: [] } : e);
    assert.throws(() => reduce(forged, lookup), /Only owner.*risk changed/s);
  } finally { await f.cleanup(); }
});

for (const [name, files, touched] of [
  ['version only', { 'package.json': packageJson('2'), 'package-lock.json': lockJson('2') }, false],
  ['scripts changed', { 'package.json': packageJson('2', 'skip') }, true],
  ['dependency version is not root version', { 'package-lock.json': lockJson('2', '2') }, true],
  ['unparseable JSON', { 'package.json': '{broken' }, true],
] as const) test(`RK3: ${name}`, { timeout: 120_000 }, async () => {
  const f = await fixture({ closure: ['package*.json'], closure_neutral: neutral }, { review: { count: 0, min_rank: 1 } });
  try {
    const { entry } = await f.submit(files); assert.equal(entry.facts.closureTouched, touched);
    await ops.attest({ ...f, node: 'a' });
    const s = await f.state(); assert.equal(s.nodes.a!.items.some(i => i.obligation === 'closure-review'), touched);
    assert.equal(reviewRuns(s, 'a'), touched ? 1 : 0);
    if (touched) {
      await f.review('closure', 1, undefined, 'closure-review'); assert.equal((await f.state()).nodes.a!.accepted, false);
      await f.review('closure', 2, undefined, 'closure-review');
    }
    assert.equal((await f.state()).nodes.a!.accepted, true);
    await ops.merge({ ...f, as: parent, node: 'a' });
  } finally { await f.cleanup(); }
});

test('RK3: bad base JSON, file deletion and a newly added JSON file still touch closure', { timeout: 120_000 }, async () => {
  const f = await fixture({ closure: ['package*.json'], closure_neutral: [...neutral, { path: 'package-new.json', json_ignore: ['version'] }] });
  try {
    const added = await f.submit({ 'package-new.json': '{"version":2}' }); assert.equal(added.entry.facts.closureTouched, true);
    const broken = await f.submit({ 'package.json': '{broken' }); assert.equal(broken.entry.facts.closureTouched, true);
    // A separate fixture makes the invalid JSON the actual slot base.
  } finally { await f.cleanup(); }
  const r = await repo();
  try {
    await r.put('package.json', '{broken'); await r.commit();
    await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', measure: false, plan: JSON.stringify({ version: 1, trunk: 'main', lease: false, closure: ['package.json'], closure_neutral: neutral, invariants: [], nodes: [{ id: 'a', writes: ['package.json'] }] }) });
    const slot = await ops.dispatch({ ...r, as: parent, node: 'a' });
    await commitAt(slot.worktree, { 'package.json': packageJson('2') });
    const e = await ops.submit({ cwd: slot.worktree, as: { role: 'writer', id: 'a#1' }, node: 'a' });
    assert.ok(e.kind === 'submit' && e.facts.closureTouched);
    const { git } = await import('../src/git.ts');
    await git(slot.worktree, ['rm', 'package.json']); await commitAt(slot.worktree, {});
    const removed = await ops.submit({ cwd: slot.worktree, as: { role: 'writer', id: 'a#1' }, node: 'a' });
    assert.ok(removed.kind === 'submit' && removed.facts.closureTouched);
  } finally { await r.cleanup(); }
});

test('RK3: ignoring version changes no check key policy; full closure content still changes invariant keys', { timeout: 120_000 }, async () => {
  const f = await fixture({ closure: ['package*.json'], closure_neutral: neutral,
    invariants: [{ id: 'unit', run: `printf 'owed-counts {"pass":1,"fail":0}\\n'`, reads: ['src/'] }] },
    { checks: [{ id: 'unit', run: `printf 'owed-counts {"pass":1,"fail":0}\\n'`, reads: ['src/'] }] });
  try {
    const first = await f.submit({ 'package.json': packageJson('2') });
    const before = await f.state();
    // Removing neutrality recomputes the same candidate facts through the existing plan carry path.
    await ops.planSet({ ...f, as: parent, plan: JSON.stringify({ ...f.p, closure_neutral: [] }) });
    const after = await f.state(), carried = after.nodes.a!.candidate!;
    assert.equal(carried.commit, first.commit); assert.equal(carried.closureTouched, true);
    assert.equal(carried.keys['check:unit'], first.entry.facts.keys['check:unit']);
    assert.equal(carried.keys.review, first.entry.facts.keys.review);
    assert.ok(before.trunk.invKeys.unit);
    await ops.attest({ ...f, node: 'a' }); await f.review('regular', 1); await f.review('closure', 2, undefined, 'closure-review');
    const merged = await ops.merge({ ...f, as: parent, node: 'a' });
    assert.notEqual((await f.state()).trunk.invKeys.unit, before.trunk.invKeys.unit, 'the complete JSON still contributes to check/invariant closure hashes');
    assert.ok(merged.entry);
  } finally { await f.cleanup(); }
});

test('RK3: adding ignored paths is an uncovered owner downgrade; narrowing/removing ignores raises freely', { timeout: 120_000 }, async () => {
  const f = await fixture({ closure: ['package*.json'], allow: [{ nodes: ['*'], checks: ['*'], review_count: 0 }] });
  try {
    const next = { ...f.p, closure_neutral: [{ path: 'package.json', json_ignore: ['scripts'] }] };
    await assert.rejects(ops.planSet({ ...f, as: parent, plan: JSON.stringify(next) }), /Only owner.*closure_neutral changed/s);
    const entry = await ops.planSet({ ...f, as: owner, channel: 'delegated', note: 'owner chooses JSON policy', plan: JSON.stringify(next) });
    assert.ok(entry.kind === 'plan'); assert.deepEqual(entry.downgrades, [{ node: 'trunk', what: 'closure_neutral changed' }]);
    const { entries } = await ops.readState(f), lookup = await planLookup(f.cwd);
    assert.throws(() => reduce(entries.map(e => e.kind === 'plan' ? { ...e, by: 'parent:forged', downgrades: [] } : e), lookup), /Only owner.*closure_neutral changed/s);
    await ops.planSet({ ...f, as: parent, plan: JSON.stringify({ ...next, closure_neutral: [{ path: 'package.json', json_ignore: ['scripts.test'] }] }) });
    await ops.planSet({ ...f, as: parent, plan: JSON.stringify(f.p) });
  } finally { await f.cleanup(); }
});

test('RK4: CLI why/status and reviewer/dispatch packets show the derived count, rank and cause', { timeout: 120_000 }, async () => {
  const f = await fixture({ risk: [docs, high] });
  try {
    assert.match(f.slot.packet, /risk rule 1: docs\/\*\*; review 0/); assert.match(f.slot.packet, /risk rule 2: src\/ledger.ts; review 2/);
    await f.submit({ 'docs/readme.md': 'docs' });
    for (const args of [['why', 'a'], ['status'], ['status', '--full']]) {
      const output = await cli(f.cwd, args); assert.equal(output.code, 0, output.stderr);
      assert.match(output.stdout, /review 0 required, rank >= 1: every changed path is under risk class docs\/\*\*/);
    }
    await f.submit({ 'src/ledger.ts': 'code' });
    const s = await f.state(); assert.match(reviewPacket(s, 'a', 2), /review 2 required, rank >= 2: src\/ledger.ts \(risk rule 2\)/);
    const json = await cli(f.cwd, ['why', 'a', '--json']); assert.equal(json.code, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout).reviewRequirement, { count: 2, min_rank: 2, cause: 'src/ledger.ts (risk rule 2)' });
    await f.submit({ 'src/other.ts': 'code', 'src/ledger.ts': 'old code' });
    assert.match((await cli(f.cwd, ['why', 'a'])).stdout, /src\/other.ts \(node's review\)/);
  } finally { await f.cleanup(); }
});

test('RK4: report counts same-model reviews despite drive.same_model: accepted, preserves window and unknown models', { timeout: 120_000 }, async () => {
  const f = await fixture({ drive: { same_model: 'accepted' } });
  try {
    await f.submit({ 'src/ledger.ts': 'code' }, 'provider/family/model:high');
    const first = await f.review('same', 1, 'provider/family/model:low');
    await f.review('different', 1, 'provider/other'); await f.review('unknown', 1);
    const second = await f.review('same-again', 1, 'provider/family/model:medium');
    for (const args of [['report', '--json'], ['report', '--metrics', '--json']]) {
      const result = await cli(f.cwd, args); assert.equal(result.code, 0, result.stderr);
      assert.equal(JSON.parse(result.stdout).reviews.sameModel, 2);
    }
    const window = await ops.report({ ...f, since: first.seq }); assert.equal(window.reviews!.sameModel, 1);
    const metrics = await ops.reportMetrics({ ...f, since: first.seq, until: second.seq }); assert.equal(metrics.reviews.sameModel, 1);
    assert.match((await cli(f.cwd, ['report'])).stdout, /Reviews by the writer's model: 2/);
    await f.submit({ 'src/ledger.ts': 'new code' }); await f.review('unknown-writer', 1, 'provider/family/model');
    assert.equal((await ops.report(f)).reviews!.sameModel, 2, 'unknown writer model is never inferred from driver selection');
  } finally { await f.cleanup(); }
});

test('RK2: ordered policy comparison handles prefix, *, ?, nested ** and rule unions without sampling paths', { timeout: 120_000 }, async () => {
  const f = await fixture();
  const rule = (paths: string[], count = 2, min_rank = 2) => ({ paths, review: { count, min_rank } });
  const cases = [
    { before: [rule(['src/**'])], after: [rule(['src/**/*'])], lower: false },
    { before: [rule(['src/**/*'])], after: [rule(['src/**'])], lower: false },
    { before: [rule(['src/*.ts'])], after: [rule(['src/**/*.ts'])], lower: false },
    { before: [rule(['src/**/*.ts'])], after: [rule(['src/*.ts'])], lower: true },
    { before: [rule(['src/**/a?.ts'])], after: [rule(['src/**/a*.ts'])], lower: false },
    { before: [rule(['src/**/a*.ts'])], after: [rule(['src/**/a?.ts'])], lower: true },
    { before: [rule(['docs/**'], 0, 1)], after: [rule(['docs/'], 0, 1)], lower: false },
    { before: [rule(['docs/**'], 0, 1)], after: [rule(['docs/*.md'], 0, 1)], lower: false },
    { before: [rule(['docs/*.md'], 0, 1)], after: [rule(['docs/**'], 0, 1)], lower: true },
    { before: [rule(['src/*/**'])], after: [rule(['src/'])], lower: false },
    { before: [rule(['src/'])], after: [rule(['src/*/**'])], lower: true },
    { before: [rule(['src/a', 'src/b'])], after: [rule(['src/b']), rule(['src/a'])], lower: false },
    { before: [rule(['src/'], 2, 1)], after: [rule(['src/'], 1, 2)], lower: true },
    { before: [rule(['src/'], 1, 2)], after: [rule(['src/'], 2, 1)], lower: true },
  ];
  try {
    for (const { before, after, lower } of cases) {
      await ops.planSet({ ...f, as: owner, channel: 'delegated', note: 'reset comparison fixture', plan: JSON.stringify({ ...f.p, risk: before }) });
      const change = () => ops.planSet({ ...f, as: parent, plan: JSON.stringify({ ...f.p, risk: after }) });
      if (lower) await assert.rejects(change(), /risk changed/, JSON.stringify({ before, after }));
      else { const e = await change(); assert.ok(e.kind === 'plan'); assert.deepEqual(e.downgrades, [], JSON.stringify({ before, after })); }
    }
  } finally { await f.cleanup(); }
});

test('RK2: raising a policy reuses candidate keys but enforces the new count and rank immediately', { timeout: 120_000 }, async () => {
  const f = await fixture({ risk: [{ ...docs, review: { count: 1, min_rank: 1 } }] });
  try {
    await f.submit({ 'docs/readme.md': 'docs' }); await ops.attest({ ...f, node: 'a' }); await f.review('one', 1);
    const candidate = (await f.state()).nodes.a!.candidate!;
    await ops.planSet({ ...f, as: parent, plan: JSON.stringify({ ...f.p, risk: [{ ...docs, review: { count: 2, min_rank: 2 } }] }) });
    const s = await f.state(); assert.equal(s.nodes.a!.candidate!.seq, candidate.seq); assert.deepEqual(s.nodes.a!.candidate!.keys, candidate.keys);
    assert.equal(s.nodes.a!.accepted, false); assert.equal(reviewRuns(s, 'a'), 2);
    await assert.rejects(ops.merge({ ...f, as: parent, node: 'a' }), /review/);
    await f.review('one', 2); await f.review('two', 2); assert.equal((await f.state()).nodes.a!.accepted, true);
  } finally { await f.cleanup(); }
});

test('RK1/RK3: an empty diff keeps node review, and a docs class cannot remove closure-review', { timeout: 120_000 }, async () => {
  const f = await fixture({ risk: [docs], closure: ['docs/**'] });
  try {
    const empty = await f.submit({}); assert.deepEqual(empty.entry.facts.changed, []);
    assert.equal(reviewRuns(await f.state(), 'a'), 1);
    await f.submit({ 'docs/readme.md': 'new docs' }); await ops.attest({ ...f, node: 'a' });
    const s = await f.state(); assert.deepEqual(reviewObligations(s, 'a', 1), ['closure-review']);
    assert.equal(s.nodes.a!.accepted, false); await f.review('closure', 2, undefined, 'closure-review');
    assert.equal((await f.state()).nodes.a!.accepted, true);
  } finally { await f.cleanup(); }
});

test('RK3: even an empty ignore list needs owner authority and exempts only parsed JSON equality', { timeout: 120_000 }, async () => {
  const f = await fixture({ closure: ['package.json'] }, { review: { count: 0, min_rank: 1 } });
  try {
    const next = { ...f.p, closure_neutral: [{ path: 'package.json', json_ignore: [] }] };
    await assert.rejects(ops.planSet({ ...f, as: parent, plan: JSON.stringify(next) }), /closure_neutral changed/);
    await ops.planSet({ ...f, as: owner, channel: 'delegated', note: 'JSON formatting is neutral', plan: JSON.stringify(next) });
    const formatted = await f.submit({ 'package.json': JSON.stringify(JSON.parse(packageJson('1')), null, 2) });
    assert.equal(formatted.entry.facts.closureTouched, false);
    // JSON keys such as __proto__ are data, not inherited object properties.
    const changed = await f.submit({ 'package.json': '{"version":"1","scripts":{"test":"test"},"__proto__":{"unsafe":true}}' });
    assert.equal(changed.entry.facts.closureTouched, true);
  } finally { await f.cleanup(); }
});

test('RK: plan validation refuses malformed risk/closure_neutral fields without recording entries', { timeout: 120_000 }, async () => {
  const f = await fixture();
  try {
    const seq = (await f.state()).seq;
    const invalid: Record<string, unknown>[] = [
      { risk: {} }, { risk: [{ ...docs, paths: [] }] }, { risk: [{ ...docs, paths: ['../bad'] }] },
      { risk: [{ ...docs, paths: ['docs/[abc]'] }] }, { risk: [{ ...docs, extra: true }] },
      { risk: [{ ...docs, review: { count: -1, min_rank: 1 } }] }, { risk: [{ ...docs, review: { count: 1, min_rank: 4 } }] },
      { risk: [{ ...docs, review: { count: 1, min_rank: 1, extra: true } }] },
      { closure_neutral: {} }, { closure_neutral: [{ path: 'package*.json', json_ignore: ['version'] }] },
      { closure_neutral: [{ path: '../package.json', json_ignore: ['version'] }] },
      { closure_neutral: [{ path: 'package.json', json_ignore: [true] }] },
      { closure_neutral: [{ ...neutral[0], extra: true }] }, { closure_neutral: [neutral[0], neutral[0]] },
    ];
    for (const fields of invalid) {
      await writeFile(join(f.cwd, 'invalid.json'), JSON.stringify({ ...f.p, ...fields }));
      const result = await cli(f.cwd, ['plan', 'invalid.json', '--as', 'parent:test']);
      assert.notEqual(result.code, 0, JSON.stringify(fields)); assert.match(result.stderr, /risk|closure_neutral/);
      assert.equal((await f.state()).seq, seq);
    }
  } finally { await f.cleanup(); }
});
