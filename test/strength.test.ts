// Mutation counterfactuals (strength:<check id>). Every assertion targets observable behavior so that
// on a tree without the feature the tests fail by assertion rather than by a missing import.
import test from 'node:test';
import assert from 'node:assert/strict';
import { repo } from './helpers/repo.ts';
import { commitAt } from './helpers/surface.ts';
import * as ops from '../src/ops.ts';
import { parsePlan, planDowngrades } from '../src/plan.ts';
import { Ledger } from '../src/ledger.ts';
import { runJob } from '../src/exec.ts';
import { git, candidateFacts } from '../src/git.ts';
import { renderReceipt } from '../src/views.ts';
import type { AttestJob, CheckSpec, Entry } from '../src/types.ts';

const owner = { role: 'owner', id: 'human' } as const, parent = { role: 'parent', id: 'test' } as const;
const patch = (path: string, before: string, after: string): string => `--- a/${path}\n+++ b/${path}\n@@ -1 +1 @@\n-${before}\n+${after}\n`;

test('plan: mutants and min_kill are parsed, validated against the closure and downgrades are detected', () => {
  const base = { version: 1, trunk: 'main', closure: ['mutants/', 'dev/**'], nodes: [{ id: 'n', writes: ['src/'], checks: [{ id: 'unit', run: 'true', mutants: ['mutants/*.patch', 'dev/**'], min_kill: 0.5 }] }] };
  const plan = parsePlan(JSON.stringify(base));
  assert.deepEqual(plan.nodes[0]!.checks[0]!.mutants, ['mutants/*.patch', 'dev/**']);
  assert.equal(plan.nodes[0]!.checks[0]!.min_kill, 0.5);
  const variant = (check: Record<string, unknown>, extra: Record<string, unknown> = {}) => JSON.stringify({ ...base, ...extra, nodes: [{ ...base.nodes[0], checks: [{ id: 'unit', run: 'true', ...check }] }] });
  for (const [check, message] of [
    [{ mutants: ['src/*.patch'] }, /mutant glob src\/\*\.patch must lie inside the plan closure/],
    [{ mutants: ['**/*.patch'] }, /must lie inside the plan closure/],
    [{ mutants: [] }, /mutants: expected at least one glob/],
    [{ mutants: ['mutants/a.patch'], min_kill: 0 }, /min_kill: expected a number in \(0, 1\]/],
    [{ mutants: ['mutants/a.patch'], min_kill: 1.5 }, /min_kill/],
    [{ min_kill: 0.5 }, /min_kill requires mutants/],
  ] as const) assert.throws(() => parsePlan(variant(check)), message, JSON.stringify(check));
  assert.throws(() => parsePlan(JSON.stringify({ ...base, invariants: [{ id: 'inv', run: 'true', mutants: ['mutants/a.patch'] }] })), /mutants are only supported on node checks/);
  const removed = parsePlan(variant({})), lowered = parsePlan(variant({ mutants: ['mutants/*.patch', 'dev/**'], min_kill: 0.25 }));
  assert.ok(planDowngrades(plan, removed).some(d => d.what === 'check unit mutants removed'));
  assert.ok(planDowngrades(plan, lowered).some(d => d.what === 'check unit min_kill lowered'));
  assert.deepEqual(planDowngrades(removed, plan), []);
});

test('executor: kills by exit or failing tests, zero-test runs survive, patches come from the base', { timeout: 60_000 }, async () => {
  const r = await repo();
  try {
    // check.sh reports according to the content of `mode`; each mutant switches the mode.
    await r.put('mode', 'ok\n');
    await r.put('check.sh', `case "$(cat mode)" in\n ok) echo '# tests 1'; echo '# pass 1';;\n exit) echo '# tests 1'; echo '# pass 1'; exit 3;;\n failcount) echo '# tests 1'; echo '# fail 1';;\n zero) echo '# tests 0'; exit 1;;\nesac\n`);
    for (const m of ['exit', 'failcount', 'zero', 'ok']) await r.put(`mutants/${m}.patch`, patch('mode', 'ok', m === 'ok' ? 'ok ' : m));
    await r.put('mutants/broken.patch', patch('mode', 'no such line', 'x'));
    await r.put('mutants/ignored.txt', 'not a patch glob match');
    const base = await r.commit();
    // The candidate rewrites a mutant to an always-killing one: the base version must still be used.
    await r.put('mutants/zero.patch', patch('mode', 'ok', 'exit'));
    await r.put('src/x', 'candidate');
    const cand = await r.commit();
    const spec: CheckSpec = { id: 'unit', run: 'bash check.sh', timeout_s: 60, reads: ['**'], mutants: ['mutants/*.patch'], min_kill: 0.4 };
    const plan = parsePlan(JSON.stringify({ version: 1, trunk: 'main', closure: ['mutants/', 'check.sh'], nodes: [{ id: 'n', writes: ['src/', 'mutants/'], checks: [spec] }] }));
    const ledger = await Ledger.open(r.cwd), ctx = { cwd: r.cwd, plan, ledger };
    const job = { kind: 'strength', subject: 'n', obligation: 'strength:unit', key: 'k', spec, commit: cand, base } as unknown as AttestJob;
    const worktrees = (await git(r.cwd, ['worktree', 'list', '--porcelain'])).stdout;
    const obs = await runJob(ctx, job);
    assert.equal(obs.verdict, 'pass', obs.note);
    assert.deepEqual({ tests: obs.counts?.tests, pass: obs.counts?.pass, fail: obs.counts?.fail }, { tests: 5, pass: 2, fail: 3 });
    const log = (await ledger.getBlob(obs.log!)).toString();
    assert.match(log, /killed mutants\/exit\.patch/);
    assert.match(log, /killed mutants\/failcount\.patch/);
    assert.match(log, /survived mutants\/zero\.patch.*zero-test run is not a kill/);
    assert.match(log, /survived mutants\/ok\.patch/);
    assert.match(log, /survived mutants\/broken\.patch: patch does not apply/);
    assert.doesNotMatch(log, /ignored\.txt/);
    assert.match(log, /strength 2\/5 killed/);
    const strict = await runJob(ctx, { ...job, spec: { ...spec, min_kill: 1 } });
    assert.equal(strict.verdict, 'fail'); assert.equal(strict.exit, 1);
    const none = await runJob(ctx, { ...job, spec: { ...spec, mutants: ['mutants/none-*.patch'] } });
    assert.equal(none.verdict, 'error'); assert.match(none.note ?? '', /no mutant patch/);
    assert.equal((await git(r.cwd, ['worktree', 'list', '--porcelain'])).stdout, worktrees);
  } finally { await r.cleanup(); }
});

test('keys: strength key follows the candidate read set, the check and the base mutants', { timeout: 60_000 }, async () => {
  const r = await repo();
  try {
    await r.put('mutants/a.patch', patch('lib/v', '1', '2')); await r.put('lib/v', '1\n');
    const base = await r.commit();
    await r.put('mutants/a.patch', patch('lib/v', '1', '3'));
    const base2 = await r.commit();
    const text = (min_kill: number, run = 'true') => JSON.stringify({ version: 1, trunk: 'main', closure: ['mutants/**'], nodes: [{ id: 'n', writes: ['lib/', 'doc/'], checks: [{ id: 'unit', run, reads: ['lib/**'], mutants: ['mutants/**'], min_kill }] }] });
    const plan = parsePlan(text(1)), node = plan.nodes[0]!;
    await r.put('doc/readme', 'x'); const c1 = await r.commit();
    await r.put('doc/readme', 'y'); const c2 = await r.commit();
    await r.put('lib/v', '9\n'); const c3 = await r.commit();
    const key = async (b: string, c: string, p = plan) => (await candidateFacts(r.cwd, p, p.nodes[0]!, b, c, 1)).keys['strength:unit'];
    const k1 = await key(base, c1);
    assert.match(k1 ?? '', /^[0-9a-f]{64}$/);
    assert.equal(await key(base, c2), k1, 'files outside reads do not change the key');
    assert.notEqual(await key(base, c3), k1, 'the read set changes the key');
    assert.notEqual(await key(base2, c1), k1, 'base mutants change the key');
    assert.notEqual(await key(base, c1, parsePlan(text(1, 'false'))), k1, 'the check run changes the key');
    assert.notEqual(await key(base, c1, parsePlan(text(0.5))), k1, 'min_kill changes the key');
    assert.equal(node.checks[0]!.mutants?.length, 1);
  } finally { await r.cleanup(); }
});

test('operations: strength obligation blocks, receipt shows k/n, attribution and a lowered min_kill accept', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    await commitAt(r.cwd, {
      'lib/value.cjs': 'module.exports = 1;\n', 'lib/other.cjs': 'module.exports = "other";\n',
      'mutants/kill.patch': patch('lib/value.cjs', 'module.exports = 1;', 'module.exports = 2;'),
      'mutants/survive.patch': patch('lib/other.cjs', 'module.exports = "other";', 'module.exports = "changed";'),
      'mutants/bad.patch': patch('lib/value.cjs', 'nothing like this', 'x'),
    });
    const planFor = (min_kill: number) => JSON.stringify({ version: 1, trunk: 'main', closure: ['mutants/**'], nodes: [{ id: 's', writes: ['test/'], checks: [{ id: 'unit', run: 'node --test --test-reporter=tap test/value.test.cjs', reads: ['lib/**', 'test/**'], min_tests: 1, mutants: ['mutants/*.patch'], min_kill }] }] });
    await ops.init({ cwd: r.cwd, plan: planFor(1), as: owner, channel: 'flag' });
    const d = await ops.dispatch({ cwd: r.cwd, node: 's', as: parent });
    await commitAt(d.worktree, { 'test/value.test.cjs': "const {test}=require('node:test'); const assert=require('node:assert/strict'); test('value',()=>assert.equal(require('../lib/value.cjs'),1));\n" });
    const writer = { cwd: d.worktree, node: 's', as: { role: 'writer', id: 's#1' } as const };
    const submitted = await ops.submit(writer);
    assert.ok(submitted.kind === 'submit' && submitted.facts.keys['strength:unit'], 'submit facts carry a strength key');
    const first = await ops.attest({ cwd: r.cwd, node: 's' });
    assert.equal(first.accepted, false);
    const strengthObs = first.observations.filter((e): e is Extract<Entry, { kind: 'obs' }> => e.kind === 'obs' && e.obligation === 'strength:unit');
    assert.equal(strengthObs.length, 1);
    const obs = strengthObs[0]!;
    assert.equal(obs.verdict, 'fail');
    assert.deepEqual({ tests: obs.counts?.tests, pass: obs.counts?.pass, fail: obs.counts?.fail }, { tests: 3, pass: 1, fail: 2 });
    assert.ok(first.observations.some(e => e.kind === 'obs' && e.obligation === 'check:unit' && e.verdict === 'pass'));
    const ledger = await Ledger.open(r.cwd), log = (await ledger.getBlob(obs.log!)).toString();
    assert.match(log, /killed mutants\/kill\.patch/); assert.match(log, /survived mutants\/survive\.patch/); assert.match(log, /survived mutants\/bad\.patch: patch does not apply/);
    const card = await ops.why({ cwd: r.cwd, node: 's' });
    assert.ok(card.blocks.some(b => b.obligation === 'strength:unit' && b.kind === 'exec'), 'a failed strength observation is an execution block');
    assert.ok(card.items.some(i => i.obligation === 'strength:unit' && i.mark === '⛔'));
    assert.match(renderReceipt(card), /strength 1\/3/);
    // The owner lowers min_kill (a visible downgrade); the writer resubmits; attribution clears the old block.
    await assert.rejects(ops.planSet({ cwd: r.cwd, plan: planFor(0.3), as: parent }), /owner/);
    await ops.planSet({ cwd: r.cwd, plan: planFor(0.3), as: owner, channel: 'flag' });
    await ops.submit(writer);
    const second = await ops.attest({ cwd: r.cwd, node: 's' });
    const strength2 = second.observations.filter(e => e.kind === 'obs' && e.obligation === 'strength:unit');
    assert.equal(strength2.length, 2, 'attribution rerun on the old key plus the new key');
    assert.ok(strength2.some(e => e.kind === 'obs' && e.attribution && e.verdict === 'fail'));
    assert.ok(strength2.some(e => e.kind === 'obs' && !e.attribution && e.verdict === 'pass'));
    assert.equal(second.accepted, true, JSON.stringify(second.receipt.items.map(i => [i.obligation, i.detail])));
    assert.match(renderReceipt(second.receipt), /✔ measured s\/strength:unit .*strength 1\/3/);
  } finally { await r.cleanup(); }
});
