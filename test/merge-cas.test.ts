import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import type { Entry } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { commitAt } from './helpers/surface.ts';

// K4 (0.7 merge-cas): the merge CAS is node-scoped; the guard decides on the latest state under the latest plan.
const parent = { role: 'parent', id: 'test' } as const, owner = { role: 'owner', id: 'human' } as const;
type Repo = Awaited<ReturnType<typeof repo>>;

/**
 * An invariant on `flag` that counts its runs in `<root>/<id>.count`. With `slow`, on a tree whose flag says
 * `changed` it touches `<root>/started` and waits for `<root>/release`; it then fails if `<root>/fail` exists.
 */
function inv(r: Repo, id: string, slow: boolean, tag = '') {
  const f = (n: string) => `'${join(r.root, n)}'`;
  const wait = slow ? `if grep -q changed flag; then touch ${f('started')}; for n in $(seq 1 1500); do test -e ${f('release')} && break; sleep .02; done; test -e ${f('release')} || exit 1; test -e ${f('fail')} && exit 1; fi; ` : '';
  return { id, reads: ['flag'], timeout_s: 60, run: `echo x >> ${f(`${id}.count`)}; ${wait}echo '# tests 1'; echo '# pass 1'${tag}` };
}
const check = (id: string, tag = '') => ({ id, reads: ['flag'], run: `echo '# tests 1'; echo '# pass 1'${tag}` });
const runs = async (r: Repo, id: string) => { try { return (await readFile(join(r.root, `${id}.count`), 'utf8')).split('\n').filter(Boolean).length; } catch { return 0; } };
async function started(r: Repo) {
  for (let i = 0; i < 1500; i++) { try { await access(join(r.root, 'started')); return true; } catch { await new Promise(res => setTimeout(res, 20)); } }
  return false;
}
/** A plan of node `a` (writes flag, check ca) and node `b`, invariants `invs`; `a` is dispatched, submitted, attested. */
async function setup(r: Repo, plan: object) {
  await commitAt(r.cwd, { flag: 'base' });
  await ops.init({ cwd: r.cwd, plan: JSON.stringify(plan), as: owner, channel: 'flag' });
  const a = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent }); await commitAt(a.worktree, { flag: 'changed' });
  await ops.submit({ cwd: a.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
  assert.equal((await ops.attest({ cwd: r.cwd, node: 'a' })).accepted, true);
}
const planOf = (invs: object[], ca = check('ca'), cb = check('cb')) => ({ version: 1, trunk: 'main', invariants: invs, nodes: [{ id: 'a', writes: ['flag'], checks: [ca] }, { id: 'b', writes: ['other'], checks: [cb] }] });
/** Starts merging `a`, waits until the slow invariant runs on the merge tree, runs `during`, then releases it. */
async function mergeWith(r: Repo, during: () => Promise<unknown>) {
  const outcome = ops.merge({ cwd: r.cwd, node: 'a', as: parent }).then(value => ({ value, error: undefined as unknown }), error => ({ value: undefined, error: error as unknown }));
  try { assert.equal(await started(r), true, 'the slow invariant started'); await during(); } finally { await writeFile(join(r.root, 'release'), ''); }
  return outcome;
}
const obs = (es: Entry[]) => es.filter(e => e.kind === 'obs');

test('K4.1 wais #14: a plan update to another node during a slow merge measurement merges without remeasuring', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    const plan = planOf([inv(r, 'wait', true)]);
    await setup(r, plan);
    const ledger = await Ledger.open(r.cwd), before = (await ledger.read()).length, genesisRuns = await runs(r, 'wait');
    const res = await mergeWith(r, () => ops.planSet({ cwd: r.cwd, plan: JSON.stringify(planOf([inv(r, 'wait', true)], check('ca'), check('cb', '; true'))), as: owner, channel: 'flag' }));
    assert.equal(res.error, undefined, String(res.error));
    const added = (await ledger.read()).slice(before);
    assert.deepEqual(added.map(e => e.kind), ['plan', 'obs', 'merge']);
    assert.equal(await runs(r, 'wait'), genesisRuns + 1, 'the merge tree was measured once');
    const o = obs(added)[0]!; assert.ok(o.kind === 'obs' && o.obligation === 'inv:wait' && o.verdict === 'pass' && o.merging === 'a');
    assert.equal((await ops.status({ cwd: r.cwd })).nodes.a!.phase, 'merged');
    assert.equal((await ops.verify({ cwd: r.cwd })).ok, true);
  } finally { await r.cleanup(); }
});

test('K4.1: a plan update that changes this node\'s check invalidates the candidate: refused with that cause, nothing recorded', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    await setup(r, planOf([inv(r, 'wait', true)]));
    const ledger = await Ledger.open(r.cwd), before = await ledger.read(), cand = (await ops.status({ cwd: r.cwd })).nodes.a!.candidate!;
    const res = await mergeWith(r, () => ops.planSet({ cwd: r.cwd, plan: JSON.stringify(planOf([inv(r, 'wait', true)], check('ca', '; true'))), as: owner, channel: 'flag' }));
    const after = await ledger.read(), plan = after.at(-1)!;
    assert.equal(plan.kind, 'plan');
    assert.equal(String(res.error), `OwedError: candidate #${cand.seq} ${cand.commit.slice(0, 12)} of a was invalidated by plan #${plan.seq} (its spec changed); the writer submits again, then merge`);
    assert.deepEqual(after.slice(0, -1), before, 'nothing recorded apart from the plan entry');
  } finally { await r.cleanup(); }
});

test('K4.1: a slot changed during the measurement is named; nothing recorded', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    await setup(r, planOf([inv(r, 'wait', true)]));
    const ledger = await Ledger.open(r.cwd), before = await ledger.read();
    const res = await mergeWith(r, () => ops.abandon({ cwd: r.cwd, node: 'a', as: parent, reason: 'stop' }));
    const after = await ledger.read(), abandon = after.at(-1)!;
    assert.equal(abandon.kind, 'abandon');
    assert.equal(String(res.error), `OwedError: slot of a changed (#${abandon.seq} abandon); nothing recorded`);
    assert.deepEqual(after.slice(0, -1), before);
  } finally { await r.cleanup(); }
});

test('K4.1: trunk moved during the measurement refuses and records nothing, even when the guard would fail', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    await setup(r, planOf([inv(r, 'wait', true)]));
    await writeFile(join(r.root, 'fail'), '');
    const ledger = await Ledger.open(r.cwd), before = await ledger.read();
    const res = await mergeWith(r, () => commitAt(r.cwd, { external: 'move trunk' }));
    assert.match(String(res.error), /trunk changed \(CAS\)/);
    assert.deepEqual(await ledger.read(), before, 'nothing recorded: not even the failing observation');
  } finally { await r.cleanup(); }
});

test('K4.2/K4.3: an invariant added during the merge is named as not measured; the retry measures only it and reuses the passes', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    await setup(r, planOf([inv(r, 'wait', true)]));
    const ledger = await Ledger.open(r.cwd), before = (await ledger.read()).length, waitRuns = await runs(r, 'wait');
    const res = await mergeWith(r, () => ops.planSet({ cwd: r.cwd, plan: JSON.stringify(planOf([inv(r, 'wait', true), inv(r, 'extra', false)])), as: owner, channel: 'flag' }));
    const message = String(res.error);
    assert.match(message, /not measured: trunk\/inv:extra \(key [0-9a-f]{12}\)/);
    assert.match(message, /invariant extra new debt/);
    assert.doesNotMatch(message, /inv:wait/);
    assert.equal(await runs(r, 'extra'), 0);
    assert.deepEqual((await ledger.read()).slice(before).map(e => e.kind), ['plan', 'obs'], 'the wait observation is kept');
    // The retry measures only inv:extra on the merge tree: inv:wait (pass) and check:ca (pass) are reused.
    await rm(join(r.root, 'started'), { force: true });
    const mid = (await ledger.read()).length;
    const merged = await ops.merge({ cwd: r.cwd, node: 'a', as: parent });
    assert.equal(merged.entry.kind, 'merge');
    assert.equal(await runs(r, 'wait'), waitRuns + 1, 'inv:wait is not measured again');
    assert.equal(await runs(r, 'extra'), 1);
    const added = (await ledger.read()).slice(mid);
    assert.deepEqual(added.map(e => e.kind === 'obs' ? `obs ${e.obligation}` : e.kind), ['obs inv:extra', 'merge']);
    assert.equal((await ops.verify({ cwd: r.cwd })).ok, true);
  } finally { await r.cleanup(); }
});

test('K4.2: an existing invariant whose definition changes during the merge: the old-key observation is dropped, the new key is not measured', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    await setup(r, planOf([inv(r, 'wait', true)]));
    const ledger = await Ledger.open(r.cwd), before = (await ledger.read()).length, waitRuns = await runs(r, 'wait');
    const res = await mergeWith(r, () => ops.planSet({ cwd: r.cwd, plan: JSON.stringify(planOf([inv(r, 'wait', true, '; true')])), as: owner, channel: 'flag' }));
    const message = String(res.error);
    assert.match(message, /not measured: trunk\/inv:wait \(key [0-9a-f]{12}\)/);
    assert.match(message, /invariant wait new debt/);
    assert.deepEqual((await ledger.read()).slice(before).map(e => e.kind), ['plan'], 'the merging observation of the old key is dropped');
    assert.equal(await runs(r, 'wait'), waitRuns + 1);
    await rm(join(r.root, 'started'), { force: true });
    const mid = (await ledger.read()).length;
    await ops.merge({ cwd: r.cwd, node: 'a', as: parent });
    assert.equal(await runs(r, 'wait'), waitRuns + 2, 'the retry measures the new key once');
    assert.deepEqual((await ledger.read()).slice(mid).map(e => e.kind === 'obs' ? `obs ${e.obligation}` : e.kind), ['obs inv:wait', 'merge']);
    assert.equal((await ops.verify({ cwd: r.cwd })).ok, true);
  } finally { await r.cleanup(); }
});
