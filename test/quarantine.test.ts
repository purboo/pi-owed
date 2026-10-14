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

test('MS4 fail-closed (#1907 ruling): excused only for one complete runner invocation with its test-failure exit', () => {
  const q = [{ test: 'flaky one', fix: 'fix' }], run = 'node --test --test-reporter=tap test/suite.test.cjs';
  const tapLog = 'TAP version 13\nnot ok 1 - flaky one\nok 2 - other\n1..2\n# tests 2\n# pass 1\n# fail 1\n';
  const tap = { format: 'tap', tests: 2, pass: 1, fail: 1 }, r = { code: 1, log: tapLog };
  assert.deepEqual(quarantineExcuse(q, run, r, tap, ['flaky one']), { excused: q });
  const why = (...a: Parameters<typeof quarantineExcuse>) => quarantineExcuse(...a).reason;
  assert.equal(why(q, run, r, tap, ['Flaky one']), '1 failing test is not quarantined', 'exact names only');
  assert.equal(why(q, run, r, { ...tap, fail: 2 }, ['flaky one']), '2 failing tests but 1 failing names');
  // Reviewer's reproduction: the compound command's own exit is not the runner's.
  for (const c of [`${run}; exit 3`, `${run} && verify`, `${run} || true`, `${run} | tee log`, `${run} &`, `${run}\nexit 3`, `x=$(true) ${run}`, `\`true\` ${run}`, `${run} "unterminated`]) assert.equal(why(q, c, r, tap, ['flaky one']), 'compound command', c);
  assert.deepEqual(quarantineExcuse(q, `${run} --test-name-pattern='a;b|c' "x && y"`, r, tap, ['flaky one']).excused, q, 'quoted operators are one invocation');
  assert.equal(why(q, run, { code: 3, log: tapLog }, tap, ['flaky one']), 'exit 3 is not a test failure');
  assert.match(why(q, run, { code: null, error: 'timeout after 5s', log: tapLog }, tap, ['flaky one'])!, /did not complete/);
  assert.equal(why(q, run, { code: 1, log: 'not ok 1 - flaky one\n# tests 2\n# fail 1\n' }, tap, ['flaky one']), 'no TAP plan');
  assert.equal(why(q, run, { code: 1, log: 'not ok 1 - flaky one\n1..2\n' }, tap, ['flaky one']), 'TAP plan 1..2 but 1 top-level results');
  assert.equal(why(q, run, r, { ...tap, format: 'owed' }, ['flaky one']), 'counts are not TAP');
  // min_tests: the remaining tests must still meet it, else the run fails as without quarantine.
  assert.equal(why(q, run, r, tap, ['flaky one'], 2), '1 tests left, below min_tests 2');
  assert.deepEqual(quarantineExcuse(q, run, r, tap, ['flaky one'], 1).excused, q);
  // cargo: exit 101, --no-fail-fast, every test binary has its summary, no build error.
  const cargoLog = '     Running unittests src/lib.rs (target/x)\ntest flaky one ... FAILED\ntest result: FAILED. 1 passed; 1 failed; 0 ignored; 0 measured\n   Doc-tests crate\ntest result: ok. 0 passed; 0 failed; 0 ignored; 0 measured\n';
  const cargo = { format: 'cargo', tests: 2, pass: 1, fail: 1 }, cr = { code: 101, log: cargoLog };
  assert.deepEqual(quarantineExcuse(q, 'cargo test --no-fail-fast', cr, cargo, ['flaky one']).excused, q);
  assert.equal(why(q, 'cargo test', cr, cargo, ['flaky one']), 'cargo without --no-fail-fast');
  assert.equal(why(q, 'cargo test --no-fail-fast', { code: 1, log: cargoLog }, cargo, ['flaky one']), 'exit 1 is not a test failure');
  assert.equal(why(q, 'cargo test --no-fail-fast', { code: 101, log: cargoLog.replace(/test result: ok.*\n$/, '') }, cargo, ['flaky one']), 'cargo ran 2 test targets but printed 1 test results');
  assert.equal(why(q, 'cargo test --no-fail-fast', { code: 101, log: `error: could not compile \`b\`\n${cargoLog}` }, cargo, ['flaky one']), 'cargo build error');
  assert.deepEqual(quarantineExcuse([], run, r, tap, ['flaky one']), {});
  assert.deepEqual(quarantineExcuse(q, run, { code: 0, log: '' }, { format: 'tap', tests: 2, pass: 2, fail: 0 }, []), {}, 'a passing run needs no excuse');
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
    // A red run is never excused: its failing test is the counterfactual (exit stays non-zero, red passes).
    const red = await runJob({ cwd: r.cwd, plan: s.plan, ledger }, { ...job, kind: 'red', subject: 'other', obligation: 'red:c', key: 'red-key', spec: { ...job.spec!, red: true, tests: ['test/suite.test.cjs'] } });
    assert.equal(red.verdict, 'pass', red.note); assert.equal(red.quarantined, undefined); assert.notEqual(red.exit, 0);
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

test('MS4 fail-closed: a compound command (`...; exit 3`) is not excused and why says so', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    await r.put('test/suite.test.cjs', suite); await r.put('test/broken', 'x'); await r.put('src/v', '0'); await r.commit();
    const plan = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: [{ id: 'fix', writes: ['test/'] }, { id: 'other', writes: ['src/'],
      checks: [{ id: 'c', run: 'node --test --test-reporter=tap test/suite.test.cjs; exit 3', min_tests: 1, reads: ['test/**', 'src/**'], quarantine: Q }] }] };
    await ops.init({ cwd: r.cwd, plan: JSON.stringify(plan), as: owner, channel: 'delegated' });
    const o = await ops.dispatch({ cwd: r.cwd, node: 'other', as: parent });
    await commitAt(o.worktree, { 'src/v': '1' });
    await ops.submit({ cwd: o.worktree, node: 'other', as: { role: 'writer', id: 'other#1' } });
    await ops.attest({ cwd: r.cwd, node: 'other' });
    const obs = (await (await Ledger.open(r.cwd)).read()).findLast((e): e is ObsEntry => e.kind === 'obs' && e.obligation === 'check:c')!;
    assert.equal(obs.verdict, 'fail'); assert.equal(obs.exit, 3); assert.equal(obs.quarantined, undefined);
    assert.deepEqual(obs.failed, ['flaky one']);
    const why = (await cli(r.cwd, ['why', 'other'])).stdout;
    assert.match(why, /other\/check:c/); assert.match(why, /note #\d+:\n {4}quarantine not applied: compound command; failed tests:/);
  } finally { await r.cleanup(); }
});
