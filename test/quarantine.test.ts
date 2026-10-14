// MS4–MS5 (0.20): native quarantine of exact failing test names, owned by a fix node until it merges.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.ts';
import * as reducer from '../src/reducer.ts';
import * as views from '../src/views.ts';
import { parsePlan, planDowngrades, quarantineNames } from '../src/plan.ts';
import { stateFacts, git } from '../src/git.ts';
import { quarantineExcuse, runJob } from '../src/exec.ts';
import { editText } from '../src/edit.ts';
import * as ops from '../src/ops.ts';
import type { AttestJob, ObsEntry } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const owner = { role: 'owner', id: 'pi' } as const, parent = { role: 'parent', id: 'main' } as const;
/** Two TAP tests; `flaky one` fails while test/broken exists, `other` fails while test/other-broken exists. */
const suite = `const {test}=require('node:test'); const fs=require('node:fs'); const assert=require('node:assert/strict');
test('flaky one',()=>assert.ok(!fs.existsSync(__dirname+'/broken')));
test('other',()=>assert.ok(!fs.existsSync(__dirname+'/other-broken')));
`;
const raw = (quarantine?: unknown, extra: object = {}) => ({ version: 1, trunk: 'main', closure: [],
  invariants: [{ id: 'unit', run: 'node --test --test-reporter=tap test/suite.test.cjs', min_tests: 1, reads: ['test/**'], ...(quarantine === undefined ? {} : { quarantine }), ...extra }],
  nodes: [{ id: 'fix', writes: ['test/'] }, { id: 'other', writes: ['src/'] }] });
const Q = [{ test: 'flaky one', fix: 'fix', note: 'chromium race' }];

test('MS4: plan validation, owner-only additions, free removal, edit path', () => {
  const p = parsePlan(JSON.stringify(raw(Q)));
  assert.deepEqual(p.invariants[0]!.quarantine, Q);
  assert.throws(() => parsePlan(JSON.stringify(raw([{ test: 'x', fix: 'missing' }]))), /quarantine fix missing is not a node of this plan/);
  assert.throws(() => parsePlan(JSON.stringify(raw([{ test: 'x', fix: 'fix' }, { test: 'x', fix: 'other' }]))), /duplicate quarantine test/);
  for (const bad of [{}, [null], [{ test: '', fix: 'fix' }], [{ test: 'x', fix: 'fix', extra: 1 }]]) assert.throws(() => parsePlan(JSON.stringify(raw(bad))), /quarantine/);
  // A node check may set it too; its fix must also name a node.
  const withCheck = raw(); Object.assign(withCheck.nodes[1]!, { checks: [{ id: 'c', run: 'true', quarantine: [{ test: 'y', fix: 'nope' }] }] });
  assert.throws(() => parsePlan(JSON.stringify(withCheck)), /other: check c: quarantine fix nope is not a node/);
  const before = parsePlan(JSON.stringify(raw())), after = p;
  assert.deepEqual(planDowngrades(before, after).map(d => d.what), ['inv:unit quarantine "flaky one" added with fix fix (owner only)']);
  assert.match(planDowngrades(after, parsePlan(JSON.stringify(raw([{ test: 'flaky one', fix: 'other' }]))))[0]!.what, /fix changed from fix to other/);
  assert.deepEqual(planDowngrades(after, before), [], 'removing an entry is not a downgrade');
  // An allow rule that names everything still does not cover it: owner only.
  before.allow = [{ nodes: ['*'], checks: ['*'] }]; after.allow = before.allow;
  assert.equal(reducer.uncoveredDowngrades(before, after).length, 1);
  const checkBefore = raw(), checkAfter = raw();
  Object.assign(checkBefore.nodes[1]!, { checks: [{ id: 'c', run: 'true' }] }); Object.assign(checkAfter.nodes[1]!, { checks: [{ id: 'c', run: 'true', quarantine: [{ test: 'y', fix: 'fix' }] }] });
  const cb = parsePlan(JSON.stringify({ ...checkBefore, allow: [{ nodes: ['*'], checks: ['*'] }] })), ca = parsePlan(JSON.stringify({ ...checkAfter, allow: [{ nodes: ['*'], checks: ['*'] }] }));
  assert.deepEqual(reducer.uncoveredDowngrades(cb, ca).map(d => d.what), ['check c quarantine "y" added with fix fix (owner only)']);
  assert.match(editText(JSON.stringify(raw()), { invariant: 'unit', set: [`quarantine=${JSON.stringify(Q)}`] }), /flaky one/);
});

test('MS4: excuse rules: exact names of a completed run with complete names only', () => {
  const q = [{ test: 'flaky one', fix: 'fix' }], ok = { code: 1, log: '' };
  const tap = { format: 'tap', tests: 2, pass: 1, fail: 1 };
  assert.deepEqual(quarantineExcuse(q, ok, tap, ['flaky one']), q);
  assert.equal(quarantineExcuse(q, ok, tap, ['Flaky one']), undefined, 'exact names only');
  assert.equal(quarantineExcuse(q, ok, { ...tap, fail: 2 }, ['flaky one', 'other']), undefined, 'any other failing name still fails');
  assert.equal(quarantineExcuse(q, ok, { ...tap, fail: 2 }, ['flaky one']), undefined, 'incomplete names');
  assert.equal(quarantineExcuse(q, { code: null, error: 'timeout after 5s', log: '' }, tap, ['flaky one']), undefined, 'timeout');
  assert.equal(quarantineExcuse(q, { code: 137, log: '' }, tap, ['flaky one']), undefined, 'killed');
  assert.equal(quarantineExcuse(q, ok, undefined, ['flaky one']), undefined, 'no recognizable counts');
  assert.equal(quarantineExcuse([], ok, tap, ['flaky one']), undefined);
});

test('MS4/MS5: active quarantine excuses only its name, joins the key, shows as debt, and lifts when the fix merges', { timeout: 180_000 }, async () => {
  const r = await repo();
  try {
    await r.put('test/suite.test.cjs', suite); await r.put('test/broken', 'x'); await r.put('src/v', '0'); await r.commit();
    const text = JSON.stringify(raw(Q));
    await ops.init({ cwd: r.cwd, plan: text, as: owner, channel: 'delegated' });
    const ledger = await Ledger.open(r.cwd), obsOf = async () => (await ledger.read()).filter((e): e is ObsEntry => e.kind === 'obs' && e.subject === 'trunk');
    const [genesis] = await obsOf();
    // The quarantined failure does not fail the item; it counts neither as passed nor failed.
    assert.equal(genesis!.verdict, 'pass', genesis!.note);
    assert.deepEqual(genesis!.quarantined, ['flaky one']);
    assert.match(genesis!.note ?? '', /quarantined: flaky one \(fix: fix\)/);
    assert.equal(genesis!.counts?.tests, 1); assert.equal(genesis!.counts?.fail, 0);
    // Key: the sorted active names are part of it; without active entries it equals the 0.17 key.
    let s = (await ops.readState({ cwd: r.cwd })).state;
    const trunk = s.trunk.commit, plain = (await stateFacts(r.cwd, s.plan, trunk)).invKeys.unit!;
    assert.notEqual(s.trunk.invKeys.unit, plain);
    assert.equal((await stateFacts(r.cwd, s.plan, trunk, quarantineNames(s.plan, () => true))).invKeys.unit, plain);
    assert.equal((await stateFacts(r.cwd, parsePlan(JSON.stringify(raw())), trunk)).invKeys.unit, plain);
    // MS5: debt in status, brief and report; why <fix> names what its merge lifts.
    const line = 'quarantine unit/flaky one until fix merges';
    assert.match((await cli(r.cwd, ['status'])).stdout, new RegExp(line));
    assert.match((await cli(r.cwd, ['brief'])).stdout, new RegExp(line));
    assert.match((await cli(r.cwd, ['report'])).stdout, /Debt \(quarantine\)[\s\S]*quarantine unit\/flaky one until fix merges/);
    assert.match((await cli(r.cwd, ['why', 'fix'])).stdout, /merging fix lifts quarantine: unit\/flaky one/);
    assert.doesNotMatch((await cli(r.cwd, ['why', 'other'])).stdout, /lifts quarantine/);
    // A job whose key does not commit to the names gets no excuse (a stale key can never be satisfied by it).
    s = (await ops.readState({ cwd: r.cwd })).state;
    const job: AttestJob = reducer.quarantinedJob(s, { kind: 'inv', subject: 'trunk', obligation: 'inv:unit', key: plain, spec: s.plan.invariants[0]!, commit: trunk, base: trunk });
    assert.equal(job.quarantined?.length, 1);
    const stale = await runJob({ cwd: r.cwd, plan: s.plan, ledger }, job);
    assert.equal(stale.verdict, 'fail'); assert.equal(stale.quarantined, undefined);
    const fresh = await runJob({ cwd: r.cwd, plan: s.plan, ledger }, { ...job, key: s.trunk.invKeys.unit! });
    assert.equal(fresh.verdict, 'pass'); assert.deepEqual(fresh.quarantined, ['flaky one']);
    // The fix node: its merge measures the key without its own entries (fresh measurement), and lifts them.
    // A first attempt that does not fix the name (and breaks another one) is refused: no excuse on its merge key.
    const f = await ops.dispatch({ cwd: r.cwd, node: 'fix', as: parent });
    await commitAt(f.worktree, { 'test/other-broken': 'x' });
    await ops.submit({ cwd: f.worktree, node: 'fix', as: { role: 'writer', id: 'fix#1' } }); await ops.attest({ cwd: r.cwd, node: 'fix' });
    await assert.rejects(ops.merge({ cwd: r.cwd, node: 'fix', as: parent }), /invariant unit/);
    const refused = (await obsOf()).filter(e => e.merging === 'fix');
    assert.equal(refused.length, 1); assert.equal(refused[0]!.verdict, 'fail'); assert.equal(refused[0]!.quarantined, undefined);
    assert.deepEqual(refused[0]!.failed?.sort(), ['flaky one', 'other']);
    await ops.abandon({ cwd: r.cwd, node: 'fix', as: owner, channel: 'delegated', reason: 'wrong fix' });
    const g = await ops.dispatch({ cwd: r.cwd, node: 'fix', as: parent });
    await git(g.worktree, ['rm', '-q', 'test/broken']); await commitAt(g.worktree, {});
    await ops.submit({ cwd: g.worktree, node: 'fix', as: { role: 'writer', id: 'fix#2' } }); await ops.attest({ cwd: r.cwd, node: 'fix' });
    const m = await ops.merge({ cwd: r.cwd, node: 'fix', as: parent });
    assert.equal(m.entry.kind, 'merge');
    s = (await ops.readState({ cwd: r.cwd })).state;
    assert.equal(s.trunk.invKeys.unit, (await stateFacts(r.cwd, s.plan, s.trunk.commit)).invKeys.unit, 'inactive once fix merged: the 0.17 key');
    const lifted = (await obsOf()).findLast(e => e.merging === 'fix')!;
    assert.equal(lifted.verdict, 'pass'); assert.equal(lifted.quarantined, undefined);
    assert.doesNotMatch((await cli(r.cwd, ['status'])).stdout, /quarantine unit/);
    assert.deepEqual(views.quarantineDebt(s), []);
  } finally { await r.cleanup(); }
});
