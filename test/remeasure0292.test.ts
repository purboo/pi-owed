// RM1–RM2: explicit remeasure attributes blocked node checks before writer repair.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ops from '../src/ops.ts';
import { decide, ownerNeeded } from '../src/drive.ts';
import { Ledger } from '../src/ledger.ts';
import { observationsOf, projectId, runId, runLabels } from '../src/reducer.ts';
import type { ObsEntry, RunView } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const owner = { role: 'owner', id: 'pi' } as const, parent = { role: 'parent', id: 'test' } as const;
const dsa = { describe: async (rid: string) => ({ rid, state: 'sealed' as const, status: 'ok' as const }), send: async () => ({ outcome: 'applied' as const, spec_digest: 'fixture' }) };
async function fixture(ids = ['unit']) {
  const r = await repo(), flag = join(r.root, 'pass');
  await commitAt(r.cwd, { impl: 'base' });
  const run = `if [ -f '${flag}' ]; then echo 'owed-counts {"pass":1,"fail":0}'; else echo 'owed-counts {"pass":0,"fail":1,"failed":["behavior"]}'; exit 1; fi`;
  await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify({ version: 1, trunk: 'main', lease: false, closure: [], invariants: [], nodes: [{ id: 'a', writes: ['impl'], checks: ids.map(id => ({ id, run, reads: ['impl'], min_tests: 1 })), review: { count: 0, min_rank: 1 } }] }) });
  const slot = await ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' });
  const { state } = await ops.readState(r), project = projectId(state), rid = runId(project, 'a', 1, 'writer');
  await ops.launch({ cwd: r.cwd, as: parent, node: 'a', attempt: 1, role: 'writer', rid, spec: '{}', labels: runLabels(project, 'a', 1, 'writer'), rulings: 0 });
  await commitAt(slot.worktree, { impl: 'candidate' });
  await ops.submit({ cwd: slot.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
  await ops.attest({ cwd: r.cwd, node: 'a' });
  const ledger = await Ledger.open(r.cwd);
  const obs = async () => (await ledger.read()).filter((e): e is ObsEntry => e.kind === 'obs' && e.subject === 'a' && e.obligation.startsWith('check:'));
  const fail = (await obs())[0]!;
  assert.equal(fail.verdict, 'fail');
  const action = async (now = Date.now()) => {
    const { state } = await ops.readState(r);
    const runs = new Map<string, RunView>([[rid, { rid, state: 'sealed', status: 'ok' }]]);
    return decide(state, state.plan, runs, { max: 1, repairs: 2, project, root: r.cwd, applied: new Set(), rejected: new Map(), now }).find(a => a.node === 'a');
  };
  const remeasure = () => ops.decide({ cwd: r.cwd, as: parent, nodes: ['a'], text: 'retry environment on the same candidate', remeasure: true, dsa });
  const append = (verdict: ObsEntry['verdict'], attribution: boolean, note?: string) => ledger.withLock(() => ledger.append([{ kind: 'obs', by: 'executor:owed', subject: 'a', obligation: fail.obligation, key: fail.key, commit: fail.commit, base: fail.base, verdict, attribution, exit: verdict === 'error' ? null : verdict === 'pass' ? 0 : 1, durationMs: 1, ...(verdict !== 'error' ? { counts: { tests: 1, pass: verdict === 'pass' ? 1 : 0, fail: verdict === 'fail' ? 1 : 0 } } : {}), ...(note ? { note } : {}) }]));
  return { ...r, flag, ledger, obs, fail, action, remeasure, append };
}

test('RM1: decide --remeasure attributes every current-key blocked check once, then returns to repair after fail', async () => {
  const r = await fixture(['unit', 'integration']);
  try {
    const failures = await r.obs();
    await r.remeasure();
    assert.equal((await r.action())?.do, 'attest', 'the next node action must measure before any repair follow-up');
    const result = await ops.attest({ cwd: r.cwd, node: 'a' });
    const attributed = result.observations.filter((e): e is ObsEntry => e.kind === 'obs' && !!e.attribution);
    assert.deepEqual(attributed.map(e => [e.obligation, e.verdict]), [['check:unit', 'fail'], ['check:integration', 'fail']]);
    assert.deepEqual(attributed.map(e => [e.key, e.commit, e.base]), failures.map(e => [e.key, e.commit, e.base]), 'attribution measures each original failing key and commit');
    const next = await r.action();
    assert.ok(next?.do === 'send' && next.reason === 'repair', JSON.stringify(next));
    assert.equal((await ops.attest({ cwd: r.cwd, node: 'a' })).observations.length, 0, 'no second attribution for this resume');
    assert.equal((await r.obs()).filter(e => e.attribution).length, 2);
  } finally { await r.cleanup(); }
});

test('RM2: decide and resume replies identify the blocked check, failure seq and exact accept-risk command', async () => {
  const r = await fixture(), prior = { OWED_DSA: process.env.OWED_DSA, FAKE_DSA_DIR: process.env.FAKE_DSA_DIR };
  process.env.OWED_DSA = fileURLToPath(new URL('./fixtures/fake-dsa.mjs', import.meta.url));
  process.env.FAKE_DSA_DIR = join(r.root, 'dsa');
  try {
    const line = `remeasure queued: a check unit (failure #${r.fail.seq}) is measured again on its key before any repair; a pass leaves a flaky block: owed waive a --accept-risk ${r.fail.seq}`;
    const out = await cli(r.cwd, ['decide', 'a', '--remeasure', '--text', 'retry check']);
    assert.equal(out.code, 0, out.stderr); assert.ok(out.stdout.includes(line), out.stdout);
    assert.doesNotMatch(out.stdout, /the next merge measures as usual/);
    const resumed = await cli(r.cwd, ['resume', 'a', '--remeasure']);
    assert.equal(resumed.code, 0, resumed.stderr); assert.ok(resumed.stdout.includes(line), resumed.stdout);
    assert.deepEqual((await r.obs()).map(e => e.seq), [r.fail.seq], 'decide/resume only queue measurements');
  } finally {
    for (const [key, value] of Object.entries(prior)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await r.cleanup();
  }
});

test('RM1: plain resume retains repair routing and replaces a previous remeasure request', async () => {
  const r = await fixture();
  try {
    await ops.resume({ cwd: r.cwd, as: parent, node: 'a' });
    let next = await r.action(); assert.ok(next?.do === 'send' && next.reason === 'repair', JSON.stringify(next));
    await r.remeasure(); assert.equal((await r.action())?.do, 'attest');
    await ops.resume({ cwd: r.cwd, as: parent, node: 'a' });
    next = await r.action(); assert.ok(next?.do === 'send' && next.reason === 'repair', JSON.stringify(next));
  } finally { await r.cleanup(); }
});

test('RM1: a passing attribution leaves the failure and flaky owner need, without a second attribution', async () => {
  const r = await fixture();
  try {
    await r.remeasure(); assert.equal((await r.action())?.do, 'attest');
    await writeFile(r.flag, 'pass'); await ops.attest({ cwd: r.cwd, node: 'a' });
    const { state } = await ops.readState(r);
    assert.equal(state.nodes.a!.blocks.find(b => b.seq === r.fail.seq)?.state, 'flaky');
    assert.deepEqual(observationsOf(state, 'a', r.fail.obligation, r.fail.key).map(e => e.verdict), ['fail', 'pass']);
    assert.match(ownerNeeded(state, 'a')!, /flaky block/);
    assert.ok(ownerNeeded(state, 'a')!.includes(`--accept-risk ${r.fail.seq}`));
    assert.notEqual((await r.action())?.do, 'attest');
    assert.equal((await ops.attest({ cwd: r.cwd, node: 'a' })).observations.length, 0);
  } finally { await r.cleanup(); }
});

test('RM1: attribution errors keep environment back-off and the two non-environment error halt', async () => {
  const r = await fixture();
  try {
    await r.remeasure();
    await r.append('error', true, 'environment: fixture unavailable');
    const latest = (await r.obs()).at(-1)!, at = Date.parse(latest.ts);
    const waiting = await r.action(at + 1);
    assert.ok(waiting?.do === 'notify' && waiting.text.includes('attest waits'), JSON.stringify(waiting));
    assert.equal((await r.action(at + 60_001))?.do, 'attest');
    await r.append('error', true, 'executor failed');
    assert.equal((await r.action())?.do, 'attest');
    await r.append('error', true, 'executor failed again');
    const halted = await r.action();
    assert.ok(halted?.do === 'halt', JSON.stringify(halted));
    assert.match(halted.reason, /attest recorded no verdict twice/);
  } finally { await r.cleanup(); }
});

test('RM1: a new block recorded after the remeasure resume is routed to repair', async () => {
  const r = await fixture();
  try {
    await r.append('fail', true);
    await r.remeasure();
    await r.append('fail', false);
    const next = await r.action();
    assert.ok(next?.do === 'send' && next.reason === 'repair', JSON.stringify(next));
  } finally { await r.cleanup(); }
});

test('RM2: an already-attributed current-key failure directs the caller to attest --rerun', async () => {
  const r = await fixture();
  try {
    await r.append('fail', true);
    const latest = (await r.obs()).at(-1)!;
    const result = await r.remeasure();
    assert.ok(ops.decideText(result).includes(`a check unit already failed again on its key (#${latest.seq}); --remeasure does not measure it again: owed attest a --rerun`), ops.decideText(result));
    assert.doesNotMatch(ops.decideText(result), /remeasure queued:/);
    assert.notEqual((await r.action())?.do, 'attest');
  } finally { await r.cleanup(); }
});

test('RM2: with neither failed invariants nor blocked or failing checks the reply says nothing to remeasure', async () => {
  const r = await fixture();
  try {
    await r.append('pass', true);
    const result = await r.remeasure();
    assert.deepEqual(result.remeasure, ['nothing to remeasure: no failed merge-tree invariant and no blocked check of a']);
    assert.doesNotMatch(ops.decideText(result), /the next merge measures as usual/);
  } finally { await r.cleanup(); }
});
