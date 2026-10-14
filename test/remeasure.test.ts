// MS1–MS3 (0.20): remeasure merge-tree and trunk invariants on the same key; "reused #N" in merge refusals.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Ledger } from '../src/ledger.ts';
import * as reducer from '../src/reducer.ts';
import { parsePlan } from '../src/plan.ts';
import { Driver, DRIVE_PRINCIPAL } from '../src/drive-run.ts';
import { Dsa } from '../src/dsa.ts';
import * as ops from '../src/ops.ts';
import type { Draft, Entry, ObsEntry, Plan } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const owner = { role: 'owner', id: 'pi' } as const, parent = { role: 'parent', id: 'main' } as const;
const count = (pass: number, fail: number, failed?: string[]) => `printf 'owed-counts '; echo '${JSON.stringify({ pass, fail, ...(failed ? { failed } : {}) })}'`;
/** Passes on trunk (no src/value) and wherever the environment flag exists: an environmental merge-tree failure. */
const envRun = (flag: string) => `if [ ! -f src/value ] || [ -f ${flag} ]; then ${count(1, 0)}; else ${count(0, 1, ['browser fixture'])}; exit 1; fi`;
const planWith = (run: string, extra: object = {}) => JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [{ id: 'x', run, min_tests: 1, reads: ['src/**'], ...extra }], nodes: [{ id: 'a', writes: ['src/'] }] });

async function candidate(extra: object = {}) {
  const r = await repo(), flag = join(r.root, 'env-ok');
  await r.put('README', 'base'); await r.commit();
  await ops.init({ cwd: r.cwd, plan: planWith(envRun(flag), extra), as: owner, channel: 'delegated' });
  const d = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
  await commitAt(d.worktree, { 'src/value': 'new' });
  await ops.submit({ cwd: d.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
  await ops.attest({ cwd: r.cwd, node: 'a' });
  const ledger = await Ledger.open(r.cwd);
  const merged = async () => (await ledger.read()).filter((e): e is ObsEntry => e.kind === 'obs' && e.merging === 'a' && e.obligation === 'inv:x');
  return { ...r, flag, ledger, merged, envOk: () => writeFile(flag, 'ok'), envBad: () => rm(flag, { force: true }) };
}

test('MS1/MS3: attest --remeasure measures the failed merge-tree invariant again on the same key; refusals say "reused"', { timeout: 90_000 }, async () => {
  const r = await candidate();
  try {
    await assert.rejects(ops.merge({ cwd: r.cwd, node: 'a', as: parent }), /browser fixture/);
    const [first] = await r.merged();
    assert.equal(first?.verdict, 'fail');
    // MS3: the second refusal reuses #first (no new observation) and says how to measure again.
    await assert.rejects(ops.merge({ cwd: r.cwd, node: 'a', as: parent }), e => {
      assert.ok(e instanceof Error);
      assert.match(e.message, new RegExp(`reused #${first!.seq} \\(same merge key, measured \\d+(?:s|m) ago\\); measure again: owed attest a --remeasure`));
      return true;
    });
    assert.equal((await r.merged()).length, 1);
    // MS1: the environment is fixed; --remeasure records a new observation on the SAME key, merging a.
    await r.envOk();
    const out = await cli(r.cwd, ['attest', 'a', '--remeasure']);
    assert.match(out.stdout, /Remeasured on the same merge key: inv:x #\d+ pass/, out.stdout + out.stderr);
    const obs = await r.merged();
    assert.equal(obs.length, 2); assert.equal(obs[1]!.key, first!.key); assert.equal(obs[1]!.verdict, 'pass'); assert.equal(obs[1]!.merging, 'a');
    // Existing aggregation: pass and fail on one key without repeat is the ⊤ owner conflict; nothing was invalidated.
    const s = (await ops.readState({ cwd: r.cwd })).state;
    const conflict = reducer.observationsOf(s, 'trunk', 'inv:x', first!.key);
    assert.deepEqual(conflict.map(e => e.verdict), ['fail', 'pass']);
    await assert.rejects(ops.merge({ cwd: r.cwd, node: 'a', as: parent }), /invariant x/);
    assert.equal((await ops.status({ cwd: r.cwd })).nodes.a!.merged, undefined);
    // Latest observation passed: nothing to remeasure unless --all.
    const none = await cli(r.cwd, ['attest', 'a', '--remeasure']);
    assert.match(none.stdout, /Nothing to remeasure: no merge-tree invariant of a failed on its current key \(--all measures every one\)/);
    const all = await cli(r.cwd, ['attest', 'a', '--remeasure', '--all']);
    assert.match(all.stdout, /Remeasured on the same merge key: inv:x #\d+ pass/);
    assert.equal((await r.merged()).length, 3);
    const usage = await cli(r.cwd, ['attest', 'a', '--all']);
    assert.notEqual(usage.code, 0); assert.match(usage.stderr, /--all requires --remeasure/);
    const both = await cli(r.cwd, ['attest', 'a', '--remeasure', '--rerun']);
    assert.notEqual(both.code, 0); assert.match(both.stderr, /does not take --rerun/);
  } finally { await r.cleanup(); }
});

test('MS1 ruling: with repeat, remeasured runs are pooled (passes*N >= K*total), never ⊤; why shows the pool', { timeout: 120_000 }, async () => {
  // Through ops: repeat {runs: 2, need: 1}. The first merge fails 0/2; a remeasure passes 1/1 → pooled 1/3 (fail);
  // a second remeasure 1/1 → pooled 2/4 → pass (2*2 >= 1*4).
  const r = await candidate({ repeat: { runs: 2, need: 1 } });
  try {
    await assert.rejects(ops.merge({ cwd: r.cwd, node: 'a', as: parent }), /browser fixture/);
    const key = (await r.merged())[0]!.key;
    await r.envOk();
    await ops.attest({ cwd: r.cwd, node: 'a', remeasure: true });
    let s = (await ops.readState({ cwd: r.cwd })).state, m = { facts: s.nodes.a!.candidate!, state: { commit: '', tree: '', invKeys: { x: key } } };
    const itemOf = (st: typeof s) => reducer.mergeGuard(st, 'a', m as never).invItems[0]!;
    assert.equal(itemOf(s).mark, '✘'); assert.match(itemOf(s).detail, /pooled 1\/3 runs on this key \(need 1\/2\)/);
    // Still failing by the pool although the latest observation passed: the default remeasure measures it again.
    await ops.attest({ cwd: r.cwd, node: 'a', remeasure: true });
    s = (await ops.readState({ cwd: r.cwd })).state;
    assert.equal(itemOf(s).status, 'E'); assert.match(itemOf(s).detail, /satisfied; pooled 2\/4 runs on this key \(need 1\/2\)/);
    // Now passing by the pool: the default remeasure selects nothing, --all still selects it.
    assert.deepEqual(reducer.remeasureJobs(s, 'a', m as never).map(j => j.obligation), []);
    assert.deepEqual(reducer.remeasureJobs(s, 'a', m as never, true).map(j => j.obligation), ['inv:x']);
    const done = await ops.merge({ cwd: r.cwd, node: 'a', as: parent });
    assert.equal(done.entry.kind, 'merge');
  } finally { await r.cleanup(); }
  // The ruling's example on a hand-built ledger: N=3, K=2; 0/3, then 3/3 → 3/6 fail; another 3/3 → 6/9 pass.
  const plan: Plan = parsePlan(JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [{ id: 'x', run: 't', repeat: { runs: 3, need: 2 } }], nodes: [] }));
  const entries: Entry[] = [], state = () => reducer.reduce(entries, () => plan);
  const add = (d: Draft) => { const seq = entries.length; entries.push({ ...d, seq, ts: '2026-10-15T00:00:00Z', prev: 'x', hash: `h${seq}` } as Entry); };
  add({ kind: 'genesis', by: 'owner:pi', channel: 'delegated', plan: 'p', trunk: 'main', commit: 's0', state: { commit: 's0', tree: 't0', invKeys: { x: 'k' } } });
  const runs = (v: 'pass' | 'fail') => [0, 1, 2].map(() => ({ verdict: v, exit: v === 'pass' ? 0 : 1, durationMs: 1, log: 'l' }));
  const obs = (v: 'pass' | 'fail') => add({ kind: 'obs', by: 'executor:owed', subject: 'trunk', obligation: 'inv:x', key: 'k', verdict: v, exit: 0, durationMs: 1, commit: 's0', runs: runs(v) });
  obs('fail'); assert.equal(state().invariants[0]!.mark, '✘');
  obs('pass'); assert.equal(state().invariants[0]!.mark, '✘'); assert.match(state().invariants[0]!.detail, /pooled 3\/6 runs on this key \(need 2\/3\)/);
  obs('pass'); assert.equal(state().invariants[0]!.status, 'E'); assert.match(state().invariants[0]!.detail, /pooled 6\/9 runs/);
  // Without repeat, pass + fail on one key stays the ⊤ owner conflict.
  const plain: Plan = parsePlan(JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [{ id: 'x', run: 't' }], nodes: [] }));
  assert.equal(reducer.reduce(entries.map(e => e.kind === 'obs' ? { ...e, runs: undefined } as Entry : e), () => plain).invariants[0]!.mark, '⊤');
});

test('MS1: attest --trunk --remeasure measures failed current trunk keys again on the same key', { timeout: 90_000 }, async () => {
  const r = await repo(), flag = join(r.root, 'trunk-ok');
  try {
    await r.put('README', 'base'); await r.commit();
    const run = `if [ -f ${flag} ]; then ${count(1, 0)}; else ${count(0, 1, ['chromium slot'])}; exit 1; fi`;
    await ops.init({ cwd: r.cwd, plan: planWith(run), as: owner, channel: 'delegated' });
    const ledger = await Ledger.open(r.cwd), trunkObs = async () => (await ledger.read()).filter((e): e is ObsEntry => e.kind === 'obs' && e.subject === 'trunk');
    assert.deepEqual((await trunkObs()).map(e => e.verdict), ['fail']);
    const plain = await cli(r.cwd, ['attest', '--trunk']);
    assert.match(plain.stdout, /Nothing to refresh on trunk; 0 observations recorded/);
    await writeFile(flag, 'ok');
    const out = await cli(r.cwd, ['attest', '--trunk', '--remeasure']);
    assert.match(out.stdout, /Remeasured on the same key: inv:x #\d+ pass/, out.stdout + out.stderr);
    const all = await trunkObs();
    assert.deepEqual(all.map(e => e.verdict), ['fail', 'pass']); assert.equal(all[1]!.key, all[0]!.key);
    const again = await cli(r.cwd, ['attest', '--trunk', '--remeasure']);
    assert.match(again.stdout, /Nothing to remeasure: no trunk invariant failed on its current key/);
  } finally { await r.cleanup(); }
});

test('MS2: resume --remeasure makes the driver measure again before the merge; a plain resume reuses (halt says so)', { timeout: 120_000 }, async () => {
  const r = await candidate();
  try {
    class SealedDsa extends Dsa { override async inspect(rid: string) { return { view: { rid, state: 'sealed' as const, status: 'ok' } }; } }
    const project = (await r.ledger.read())[0]!.hash.slice(0, 12), rid = reducer.runId(project, 'a', 1, 'writer');
    await ops.launch({ cwd: r.cwd, as: DRIVE_PRINCIPAL, node: 'a', attempt: 1, role: 'writer', rid, spec: '{}', labels: reducer.runLabels(project, 'a', 1, 'writer') });
    const driver = new Driver({ cwd: r.cwd, log: () => {}, handleSignals: false, session: null, dsa: new SealedDsa({ bin: '/no-dsa-ms2' }), max: 1 });
    const mergeOnce = async () => { await driver.pass(); assert.equal(await driver.drain(60_000), true); await driver.pass(); return (await r.ledger.read()).findLast(e => e.kind === 'halt'); };
    let halt = await mergeOnce();
    assert.ok(halt?.kind === 'halt'); assert.match(halt.reason, /browser fixture/);
    assert.equal((await r.merged()).length, 1);
    // A plain resume: the driver reuses the cached failure and its halt names the remeasure resume.
    await ops.resume({ cwd: r.cwd, as: parent, node: 'a', note: 'intermittent, re-merge' });
    const plainSeq = (await r.ledger.read()).at(-1)!.seq;
    halt = await mergeOnce();
    assert.ok(halt?.kind === 'halt' && halt.seq > plainSeq);
    assert.match(halt.reason, /reused #\d+ \(same merge key, measured \d+(?:s|m) ago\); measure again: owed resume a --remeasure/);
    assert.equal((await r.merged()).length, 1, 'no observation between the plain resume and the halt');
    // resume --remeasure (CLI): the field is recorded; the driver remeasures under its lease before merging again.
    await r.envOk();
    const out = await cli(r.cwd, ['resume', 'a', '--remeasure', '--note', 'chromium slots 2→4', '--as', 'parent:main']);
    assert.equal(out.code, 0, out.stderr);
    const resume = (await r.ledger.read()).findLast(e => e.kind === 'resume');
    assert.ok(resume?.kind === 'resume'); assert.equal(resume.remeasure, true);
    assert.ok(reducer.remeasureDue((await ops.readState({ cwd: r.cwd })).state, 'a'));
    halt = await mergeOnce();
    const fresh = (await r.merged()).filter(e => e.seq > resume.seq);
    assert.equal(fresh.length, 1); assert.equal(fresh[0]!.verdict, 'pass'); assert.equal(fresh[0]!.key, (await r.merged())[0]!.key);
    // Pass + fail without repeat is ⊤: still refused, now on fresh evidence; the remeasure is not repeated.
    assert.ok(halt?.kind === 'halt' && halt.seq > fresh[0]!.seq);
    assert.equal(reducer.remeasureDue((await ops.readState({ cwd: r.cwd })).state, 'a'), undefined);
    // Strict field: only `remeasure: true` replays; anything else needs a newer owed.
    assert.match(reducer.newerEntry({ ...resume, remeasure: 'yes' } as unknown as Entry)?.message ?? '', /resume remeasure/);
    assert.equal(reducer.newerEntry(resume), undefined);
  } finally { await r.cleanup(); }
});
