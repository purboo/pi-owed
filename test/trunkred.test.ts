import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, access } from 'node:fs/promises';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import * as git from '../src/git.ts';
import { Ledger } from '../src/ledger.ts';
import { parsePlan } from '../src/plan.ts';
import { reduce, attestJobs, newerEntry, validateDraft } from '../src/reducer.ts';
import * as reducer from '../src/reducer.ts';
import { decide, thresholdHint, environmentWait, type DriveOpts } from '../src/drive.ts';
import { renderReceipt, renderStatusFull as renderStatus } from '../src/views.ts';
import type { Draft, ObsEntry } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { commitAt } from './helpers/surface.ts';

const parent = { role: 'parent', id: 'test' } as const;
const owner = { role: 'owner', id: 'pi' } as const;
const writer = { role: 'writer', id: 'a#1' } as const;
type Names = string[] | undefined;
const emit = (names: Names) => names === undefined
  ? `echo '# tests 1'; echo '# fail 1'; exit 1`
  : `echo '${JSON.stringify({ pass: 0, fail: names.length, failed: names }) .replace(/^/, 'owed-counts ')}'; exit 1`;

async function fixture(mergeNames?: Names, trunkNames?: Names, options: { trunkPass?: boolean; invariant?: boolean; probeBarrier?: boolean } = {}) {
  if (arguments.length === 0) { mergeNames = ['old bug']; trunkNames = ['old bug']; }
  const r = await repo();
  try {
    const barrier = options.probeBarrier ? `if grep -q broken flag && ! grep -q candidate impl; then touch '${join(r.root,'probe-started')}'; for ((i=0;i<200;i++)); do test -e '${join(r.root,'probe-release')}' && break; sleep 0.05; done; test -e '${join(r.root,'probe-release')}' || exit 127; fi\n` : '';
    const check = `${barrier}test -e setup-ready && test "$TR_ENV" = same || exit 127
if grep -q broken flag; then
  if grep -q candidate impl; then ${emit(mergeNames)}; else ${options.trunkPass || options.invariant ? `echo '# tests 1'; echo '# pass 1'` : emit(trunkNames)}; fi
else echo '# tests 1'; echo '# pass 1'; fi\n`;
    await commitAt(r.cwd, { flag: 'clean', impl: 'base', 'check.sh': check });
    const spec = { id: 'runtime', run: 'bash check.sh', reads: ['flag', 'impl', 'check.sh'], min_tests: 1 };
    // Keep the measurement-only marker out of the candidate's git add and declared writes.
    const plan = { version: 1, trunk: 'main', lease: false, slot_setup: false, setup: 'touch setup-ready', exec: { env: { TR_ENV: 'same' } }, closure: [], invariants: options.invariant ? [spec] : [], nodes: [{ id: 'a', writes: ['impl'], checks: options.invariant ? [] : [spec] }] };
    await ops.init({ cwd: r.cwd, plan: JSON.stringify(plan), as: owner, channel: 'delegated' });
    const a = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
    const candidate = await commitAt(a.worktree, { impl: 'candidate' });
    await ops.submit({ cwd: a.worktree, node: 'a', as: writer });
    assert.equal((await ops.attest({ cwd: r.cwd, node: 'a' })).accepted, true);
    const trunk = await commitAt(r.cwd, { flag: 'broken' });
    await ops.adopt({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'fixture trunk change' });
    const ledger = await Ledger.open(r.cwd);
    const state = async () => {
      const es = await ledger.read(), plans = new Map<string, ReturnType<typeof parsePlan>>();
      for (const e of es) if (e.kind === 'genesis' || e.kind === 'plan') plans.set(e.plan, parsePlan((await ledger.getBlob(e.plan)).toString()));
      return reduce(es, sha => plans.get(sha)!);
    };
    const refusal = async () => {
      try { await ops.merge({ cwd: r.cwd, node: 'a', as: parent }); assert.fail('merge should refuse'); }
      catch (e) { assert.ok(e instanceof Error); return e.message; }
    };
    return { ...r, a, candidate, trunk, ledger, state, refusal, plan, spec };
  } catch (e) { await r.cleanup(); throw e; }
}
const observations = async (r: Awaited<ReturnType<typeof fixture>>) => (await r.ledger.read()).filter((e): e is ObsEntry => e.kind === 'obs');
async function reusedFailure(trunkPass = false) {
  const r = await fixture(['old bug'], ['old bug'], { trunkPass });
  try {
    await r.refusal();
    const original = (await observations(r)).find(e => e.merging === 'a')!;
    const currentTrunk = await commitAt(r.cwd, { unrelated: 'outside reads and closure' });
    await ops.adopt({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'unrelated trunk move' });
    assert.equal((await ops.attest({ cwd: r.cwd, node: 'a' })).accepted, true);
    const message = await r.refusal();
    const es = await observations(r), probe = es.findLast(e => e.probe === 'trunk')!;
    assert.equal(es.filter(e => e.merging === 'a').length, 1, 'the merge failure was reused');
    assert.equal((await r.state()).nodes.a!.blocks.find(b => b.seq === original.seq)!.state, 'cleared');
    return { ...r, original, currentTrunk, message, probe };
  } catch (e) { await r.cleanup(); throw e; }
}

const driveOptions = (root: string): DriveOpts => ({ max: 1, repairs: 2, project: 'fixture', root, applied: new Set(), rejected: new Map() });

test('TR1/2/4: named merge failures contained in trunk failures record a probe and parent diagnosis', async () => {
  const r = await fixture(['old bug'], ['old bug', 'another trunk bug']);
  try {
    const message = await r.refusal();
    assert.match(message, new RegExp(`^trunk-red: check:runtime fails on trunk ${r.trunk.slice(0,12)} without a \\(old bug\\)`));
    assert.match(message, /this candidate is not shown to be the cause; parent: fix trunk with a fixing node/);
    const es = await observations(r), probe = es.find(e => e.probe === 'trunk')!, merged = es.find(e => e.merging === 'a')!;
    assert.ok(probe, 'trunk probe exists');
    assert.equal(probe.commit, r.trunk); assert.equal(probe.base, r.trunk);
    assert.equal(probe.subject, 'a'); assert.equal(probe.merging, undefined);
    assert.notEqual(probe.key, merged.key); assert.equal(probe.verdict, 'fail');
    assert.equal(probe.key, await git.trunkCheckKey(r.cwd, (await r.state()).plan, (await r.state()).plan.nodes[0]!.checks[0]!, r.trunk));
    assert.match(message, new RegExp(`owed waive a check:runtime --accept-risk ${merged.seq}`));
    assert.deepEqual((await r.state()).nodes.a!.blocks.map(b => b.seq), [merged.seq]);
    const why = renderReceipt(await ops.why({ cwd: r.cwd, node: 'a' }));
    const status = renderStatus(await ops.status({ cwd: r.cwd }));
    for (const text of [why, status]) {
      assert.match(text, /trunk-red:/); assert.match(text, new RegExp(`merge-tree obs #${merged.seq}, trunk probe #${probe.seq}`));
      assert.doesNotMatch(text, /writer fixes and runs owed submit/);
    }
  } finally { await r.cleanup(); }
});

test('TR2: no names on either failing observation classifies trunk-red', async () => {
  const r = await fixture(undefined, undefined);
  try { assert.match(await r.refusal(), /^trunk-red:.*unknown failed tests/); }
  finally { await r.cleanup(); }
});

test('TR2: passing trunk and differing names preserve the ordinary refusal', async () => {
  for (const [names, options] of [[['different bug'], {}], [['old bug'], { trunkPass: true }]] as const) {
    const r = await fixture(['old bug'], [...names], options);
    try {
      assert.doesNotMatch(await r.refusal(), /^trunk-red:/);
      const probe = (await observations(r)).find(e => e.probe === 'trunk');
      assert.ok(probe, 'even an ordinary refusal must probe trunk');
      assert.equal(probe.verdict, options.trunkPass ? 'pass' : 'fail');
      assert.doesNotMatch(renderReceipt(await ops.why({ cwd: r.cwd, node: 'a' })), /trunk-red:/);
    } finally { await r.cleanup(); }
  }
});

test('TR2: names on only one side are insufficient for trunk-red', async () => {
  for (const pair of [[undefined, ['old bug']], [['old bug'], undefined]] as [Names, Names][]) {
    const r = await fixture(...pair);
    try {
      assert.doesNotMatch(await r.refusal(), /^trunk-red:/);
      assert.equal((await observations(r)).filter(e => e.probe === 'trunk').length, 1);
    } finally { await r.cleanup(); }
  }
});

test('TR1/3: retry on unchanged trunk reuses its probe and never starts another measurement', async () => {
  const r = await fixture();
  try {
    assert.match(await r.refusal(), /^trunk-red:/);
    const before = await r.ledger.read();
    for (let i = 0; i < 2; i++) assert.match(await r.refusal(), /^trunk-red:/);
    assert.deepEqual(await r.ledger.read(), before);
  } finally { await r.cleanup(); }
});

test('TR3: driver routes persisted trunk-red to parent before writer launch or attribution attest', async () => {
  const r = await fixture();
  try {
    await r.refusal();
    const s = await r.state();
    assert.ok(attestJobs(s, 'a').some(j => j.attribution), '0.13 would route through attribution first');
    const actions = decide(s, s.plan, new Map(), driveOptions(r.cwd));
    assert.equal(actions.length, 1);
    assert.equal(actions[0]!.do, 'halt');
    const action = actions[0]!;
    assert.ok(action.do === 'halt'); assert.equal(action.needs, 'human');
    assert.match(action.reason, /^merge refused: trunk-red:/);
  } finally { await r.cleanup(); }
});

test('TR3: moving trunk removes the old classification and measures a probe for the new commit', async () => {
  const r = await fixture();
  try {
    await r.refusal();
    const oldFailure = (await observations(r)).find(e => e.merging === 'a')!;
    assert.ok(reducer.trunkRedOf(await r.state(), oldFailure.seq));
    const trunk = await commitAt(r.cwd, { flag: 'broken again' });
    await ops.adopt({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'trunk changed' });
    assert.equal(reducer.trunkRedOf(await r.state(), oldFailure.seq), undefined);
    assert.doesNotMatch(renderStatus(await ops.status({ cwd: r.cwd })), /trunk-red:/);
    // Clear the old execution block through its attribution path, then try the same candidate on the new trunk.
    await ops.attest({ cwd: r.cwd, node: 'a' });
    assert.match(await r.refusal(), new RegExp(`^trunk-red:.*${trunk.slice(0,12)}`));
    assert.equal((await observations(r)).filter(e => e.probe === 'trunk').length, 2);
  } finally { await r.cleanup(); }
});

test('TR1/2 ruling #1432: an unchanged merge key reuses an old-base failure with the current trunk probe', async () => {
  const r = await fixture();
  try {
    assert.match(await r.refusal(), /^trunk-red:/);
    const original = (await observations(r)).find(e => e.merging === 'a')!;
    const trunk = await commitAt(r.cwd, { unrelated: 'outside check reads and closure' });
    await ops.adopt({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'unrelated trunk move' });
    assert.equal(reducer.trunkRedOf(await r.state(), original.seq), undefined, 'old trunk probe is no longer current');
    assert.equal((await ops.attest({ cwd: r.cwd, node: 'a' })).accepted, true);
    const message = await r.refusal();
    const es = await observations(r), currentProbe = es.findLast(e => e.probe === 'trunk')!;
    assert.equal(es.filter(e => e.merging === 'a').length, 1, 'merge failure was reused, not measured again');
    assert.equal(currentProbe.commit, trunk); assert.equal(currentProbe.base, trunk);
    assert.notEqual(original.base, trunk);
    assert.equal(currentProbe.key, es.find(e => e.probe === 'trunk')!.key, 'probe key survives an unrelated move');
    assert.match(message, new RegExp(`^trunk-red: check:runtime fails on trunk ${trunk.slice(0,12)} without a \\(old bug\\)`));
    assert.match(message, new RegExp(`merge-tree obs #${original.seq}, trunk probe #${currentProbe.seq}`));
    assert.match(message, new RegExp(`owed waive a check:runtime --accept-risk ${original.seq}`));
    assert.match(message, /this candidate is not shown to be the cause; parent: fix trunk/);
    const s = await r.state();
    assert.ok(reducer.trunkRedOf(s, original.seq, original.key));
    assert.equal(reducer.trunkRedOf(s, original.seq, `${original.key}-stale`), undefined, 'another merge key cannot borrow this failure');
  } finally { await r.cleanup(); }
});

test('TR ruling #1458: reused cleared failure appears in why and status on the current merge key', async () => {
  const r = await reusedFailure();
  try {
    assert.match(r.message, /^trunk-red:/);
    const why = await ops.why({ cwd: r.cwd, node: 'a' }), status = await ops.status({ cwd: r.cwd });
    const mergeCheck = why.mergeChecks?.find(i => i.obligation === 'check:runtime');
    assert.ok(mergeCheck, 'why must include the refused merge check');
    assert.equal(mergeCheck.key, r.original.key); assert.equal(mergeCheck.discharger, 'parent');
    assert.equal(mergeCheck.status, 'D'); assert.ok(mergeCheck.evidence.includes(r.original.seq));
    assert.ok(status.pending['parent+writer']!.some(i => i.key === r.original.key && i.discharger === 'parent'));
    for (const text of [renderReceipt(why), renderStatus(status)]) {
      assert.match(text, /trunk-red:/);
      assert.match(text, new RegExp(`merge-tree obs #${r.original.seq}, trunk probe #${r.probe.seq}`));
      assert.match(text, new RegExp(`owed waive a check:runtime --accept-risk ${r.original.seq}`));
      assert.doesNotMatch(text, /writer fixes and runs owed submit/);
    }
    assert.equal((await r.state()).nodes.a!.accepted, true, 'diagnostics preserve candidate acceptance');
    const blocks = (await r.state()).nodes.a!.blocks;
    assert.equal(blocks.length, 1); assert.equal(blocks[0]!.state, 'cleared', 'probes create no execution blocks');
  } finally { await r.cleanup(); }
});

test('TR ruling #1458: accepting a reused cleared merge failure binds the merge key and merge passes', async () => {
  for (const trunkPass of [false, true]) {
    const r = await reusedFailure(trunkPass);
    try {
      const before = await r.state();
      const w = await ops.waive({ cwd: r.cwd, node: 'a', obligation: 'check:runtime', reason: 'accept current merge failure', accept_risk: [r.original.seq], as: owner, channel: 'delegated' });
      assert.ok(w.kind === 'waive'); assert.equal(w.key, r.original.key);
      assert.notEqual(w.key, before.nodes.a!.candidate!.keys['check:runtime']);
      assert.match(await ops.waiverMeaning({ cwd: r.cwd, entry: w }), /on merge key.*applies only to that key/);
      assert.equal((await ops.why({ cwd: r.cwd, node: 'a' })).mergeChecks, undefined);
      assert.doesNotMatch(renderStatus(await ops.status({ cwd: r.cwd })), /trunk-red:/);
      const result = await ops.merge({ cwd: r.cwd, node: 'a', as: parent });
      assert.equal(result.entry.kind, 'merge');
      assert.equal((await observations(r)).filter(e => e.merging === 'a').length, 1, 'the accepted key is not remeasured');
      assert.equal((await r.state()).nodes.a!.phase, 'merged');
    } finally { await r.cleanup(); }
  }
});

test('TR ruling #1458: a merge-key waiver does not waive a different candidate or merge key', async () => {
  const r = await reusedFailure();
  try {
    const w = await ops.waive({ cwd: r.cwd, node: 'a', obligation: 'check:runtime', reason: 'accept only this merge key', accept_risk: [r.original.seq], as: owner, channel: 'delegated' });
    assert.ok(w.kind === 'waive');
    await commitAt(r.a.worktree, { impl: 'candidate-v2' });
    await ops.submit({ cwd: r.a.worktree, node: 'a', as: writer });
    assert.equal((await ops.attest({ cwd: r.cwd, node: 'a' })).accepted, true);
    assert.equal((await ops.why({ cwd: r.cwd, node: 'a' })).mergeChecks, undefined, 'old probe cannot attach an old failure to the new key');
    const n = (await r.state()).nodes.a!;
    assert.notEqual(n.candidate!.keys['check:runtime'], w.key);
    assert.equal(n.items.find(i => i.obligation === 'check:runtime')!.status, 'E', 'candidate is measured, not waived');
    assert.match(await r.refusal(), /^trunk-red:/);
    const failed = (await observations(r)).findLast(e => e.merging === 'a')!;
    assert.notEqual(failed.key, w.key); assert.ok(failed.seq > w.seq);
  } finally { await r.cleanup(); }
});

test('TR ruling #1458: changed trunk reads make a cleared merge failure stale and refuse its risk', async () => {
  const r = await reusedFailure();
  try {
    await commitAt(r.cwd, { flag: 'different broken bytes' });
    await ops.adopt({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'change check reads' });
    const before = await r.ledger.read();
    await assert.rejects(ops.waive({ cwd: r.cwd, node: 'a', obligation: 'check:runtime', reason: 'stale risk', accept_risk: [r.original.seq], as: owner, channel: 'delegated' }), /accept_risk must reference active blocks for this obligation/);
    assert.deepEqual(await r.ledger.read(), before, 'refused risk records nothing');
    assert.equal((await ops.why({ cwd: r.cwd, node: 'a' })).mergeChecks, undefined);
    assert.doesNotMatch(renderStatus(await ops.status({ cwd: r.cwd })), /trunk-red:/);
  } finally { await r.cleanup(); }
});

test('TR ruling #1458: cleared ordinary failures, attribution results and probes cannot be accepted as merge risks', async () => {
  const r = await reusedFailure();
  try {
    const { seq, ts, prev, hash, merging, ...ordinary } = r.original;
    const e = (await r.ledger.withLock(() => r.ledger.append([ordinary])))[0]!;
    await ops.attest({ cwd: r.cwd, node: 'a' });
    assert.equal((await r.state()).nodes.a!.blocks.find(b => b.seq === e.seq)!.state, 'cleared');
    const attribution = (await observations(r)).findLast(e => e.attribution)!;
    const before = await r.ledger.read();
    for (const accept_risk of [[e.seq], [attribution.seq], [r.probe.seq], [r.original.seq, r.probe.seq], [999]]) {
      await assert.rejects(ops.waive({ cwd: r.cwd, node: 'a', obligation: 'check:runtime', reason: 'invalid reference', accept_risk, as: owner, channel: 'delegated' }), /accept_risk must reference active blocks for this obligation/);
    }
    await assert.rejects(ops.waive({ cwd: r.cwd, node: 'a', obligation: 'writes', reason: 'wrong obligation', accept_risk: [r.original.seq], as: owner, channel: 'delegated' }), /accept_risk must reference active blocks for this obligation/);
    assert.deepEqual(await r.ledger.read(), before, 'invalid lists are rejected atomically');
  } finally { await r.cleanup(); }
});

test('TR ruling #1458: a cleared merge risk cannot broaden a mixed list to another active key', async () => {
  const r = await reusedFailure();
  try {
    await commitAt(r.a.worktree, { impl: 'candidate-v2' });
    await ops.submit({ cwd: r.a.worktree, node: 'a', as: writer });
    await ops.attest({ cwd: r.cwd, node: 'a' });
    await r.refusal();
    const other = (await observations(r)).findLast(e => e.merging === 'a')!;
    assert.notEqual(other.key, r.original.key);
    await ops.submit({ cwd: r.a.worktree, node: 'a', commit: r.candidate, as: writer });
    const before = await r.ledger.read();
    await assert.rejects(ops.waive({ cwd: r.cwd, node: 'a', obligation: 'check:runtime', reason: 'mixed keys', accept_risk: [r.original.seq, other.seq], as: owner, channel: 'delegated' }), /accept_risk must reference active blocks for this obligation/);
    assert.deepEqual(await r.ledger.read(), before);
    const activeOnly = await ops.waive({ cwd: r.cwd, node: 'a', obligation: 'check:runtime', reason: 'accept active block as before', accept_risk: [other.seq], as: owner, channel: 'delegated' });
    assert.ok(activeOnly.kind === 'waive');
    assert.equal(activeOnly.key, (await r.state()).nodes.a!.candidate!.keys['check:runtime']);
    assert.equal((await r.state()).nodes.a!.blocks.find(b => b.seq === other.seq)!.state, 'cleared');
    assert.match(renderReceipt(await ops.why({ cwd: r.cwd, node: 'a' })), /trunk-red:/, 'accepting the other active key did not accept this merge failure');
    await ops.waive({ cwd: r.cwd, node: 'a', obligation: 'check:runtime', reason: 'accept just the current merge key', accept_risk: [r.original.seq], as: owner, channel: 'delegated' });
    assert.equal((await ops.merge({ cwd: r.cwd, node: 'a', as: parent })).entry.kind, 'merge');
  } finally { await r.cleanup(); }
});

test('TR1: invariant failures never create a trunk probe', async () => {
  const r = await fixture(['old bug'], ['old bug'], { invariant: true });
  try {
    const message = await r.refusal();
    assert.match(message, /invariant runtime new debt/);
    assert.equal((await observations(r)).filter(e => e.probe === 'trunk').length, 0);
  } finally { await r.cleanup(); }
});

test('TR1: probes sharing a candidate key neither satisfy nor block its check or catch a decoy', async () => {
  const r = await repo();
  try {
    const trunk = await commitAt(r.cwd, { impl: 'base' });
    await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify({ version: 1, trunk: 'main', lease: false, nodes: [{ id: 'a', writes: ['impl'], checks: [{ id: 'runtime', reads: [], run: `echo '# tests 1'; echo '# pass 1'` }] }] }) });
    const payload = { nonce: 'trunk-probe-decoy-nonce', decoys: [{ node: 'a', defect: 'fixture' }] };
    await ops.decoyCommit({ cwd: r.cwd, as: owner, channel: 'delegated', digest: ops.decoyDigest(JSON.stringify(payload)).digest });
    const a = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
    await commitAt(a.worktree, { impl: 'candidate' }); await ops.submit({ cwd: a.worktree, node: 'a', as: writer });
    const ledger = await Ledger.open(r.cwd), s = (await ops.status({ cwd: r.cwd })).nodes.a!, key = s.candidate!.keys['check:runtime']!;
    for (const verdict of ['pass', 'fail'] as const) await ledger.withLock(() => ledger.append([{ kind: 'obs', by: 'executor:owed', subject: 'a', obligation: 'check:runtime', key, verdict, exit: verdict === 'pass' ? 0 : 1, durationMs: 1, commit: trunk, base: trunk, probe: 'trunk' }]));
    assert.equal((await ops.why({ cwd: r.cwd, node: 'a' })).items.find(i => i.obligation === 'check:runtime')!.mark, '⊥');
    assert.equal((await ops.attest({ cwd: r.cwd, node: 'a' })).accepted, true);
    await ops.decoyReveal({ cwd: r.cwd, as: owner, channel: 'delegated', payload: JSON.stringify(payload) });
    assert.equal((await ops.status({ cwd: r.cwd })).nodes.a!.blocks.length, 0);
    assert.equal((await ops.report({ cwd: r.cwd })).escapes.decoys[0]!.outcome, 'pending');
  } finally { await r.cleanup(); }
});

test('TR1: a remeasured merge failure reuses the trunk probe on its own key', async () => {
  const r = await fixture();
  try {
    await r.refusal();
    const failed = (await observations(r)).find(e => e.merging === 'a')!;
    await ops.waive({ cwd: r.cwd, node: 'a', obligation: 'check:runtime', reason: 'fixture retries merge evidence', accept_risk: [failed.seq], as: owner, channel: 'delegated' });
    assert.match(await r.refusal(), /^trunk-red:/);
    const es = await observations(r);
    assert.equal(es.filter(e => e.merging === 'a' && e.verdict === 'fail').length, 2);
    assert.equal(es.filter(e => e.probe === 'trunk').length, 1, 'cached probe was reused by a real merge run');
  } finally { await r.cleanup(); }
});

test('TR1: trunk CAS during a probe discards the merge and probe observations', async () => {
  const r = await fixture(['old bug'], ['old bug'], { probeBarrier: true });
  try {
    const before = (await observations(r)).length;
    const refused = r.refusal();
    let started = false;
    for (let i = 0; i < 300; i++) {
      try { await access(join(r.root,'probe-started')); started = true; break; } catch { await new Promise(resolve => setTimeout(resolve,20)); }
    }
    assert.equal(started, true, 'probe started within the bounded wait');
    await commitAt(r.cwd, { flag: 'clean again' });
    await writeFile(join(r.root,'probe-release'), 'continue');
    assert.match(await refused, /trunk changed \(CAS\)/);
    await ops.adopt({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'record the moved trunk after CAS refusal' });
    assert.equal((await observations(r)).length, before, 'stale results recorded nothing');
    assert.equal((await ops.status({ cwd: r.cwd })).nodes.a!.phase, 'accepted');
  } finally { await writeFile(join(r.root,'probe-release'), 'continue').catch(() => {}); await r.cleanup(); }
});

test('TR3: changing the closure definition invalidates the displayed classification', async () => {
  const r = await fixture();
  try {
    await r.refusal();
    await ops.planSet({ cwd: r.cwd, plan: JSON.stringify({ ...r.plan, closure: ['check.sh'] }), note: 'pin the closure', as: owner, channel: 'delegated' });
    assert.doesNotMatch(renderReceipt(await ops.why({ cwd: r.cwd, node: 'a' })), /trunk-red:/);
  } finally { await r.cleanup(); }
});

test('TR1: probes do not create threshold halts or environment waits on a matching obligation key', async () => {
  const r = await repo();
  try {
    const trunk = await commitAt(r.cwd, { impl: 'base' });
    await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify({ version: 1, trunk: 'main', lease: false, nodes: [{ id: 'a', writes: ['impl'], checks: [{ id: 'runtime', reads: [], min_tests: 2, run: `echo '# tests 2'; echo '# pass 2'` }] }] }) });
    const a = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
    const candidate = await commitAt(a.worktree, { impl: 'candidate' });
    await ops.submit({ cwd: a.worktree, node: 'a', as: writer });
    const ledger = await Ledger.open(r.cwd), key = (await ops.status({ cwd: r.cwd })).nodes.a!.candidate!.keys['check:runtime']!;
    const d: Extract<Draft, { kind: 'obs' }> = { kind: 'obs', by: 'executor:owed', subject: 'a', obligation: 'check:runtime', key, verdict: 'fail', exit: 0, counts: { tests: 1, pass: 1, fail: 0 }, durationMs: 0, commit: candidate, base: trunk };
    await ledger.withLock(() => ledger.append([d, { ...d, commit: trunk, probe: 'trunk' }, { ...d, commit: trunk, probe: 'trunk', verdict: 'error', note: 'environment: fixture' }]));
    const es = await ledger.read(), genesis = es[0]!;
    assert.ok(genesis.kind === 'genesis');
    const plan = parsePlan((await ledger.getBlob(genesis.plan)).toString()), s = reduce(es, () => plan);
    assert.equal(reducer.observationsOf(s,'a','check:runtime',key).length, 1);
    assert.equal(thresholdHint(s,'a',['check:runtime']), undefined);
    assert.equal(environmentWait(s,[{subject:'a',obligation:'check:runtime',key}],-1), undefined);
  } finally { await r.cleanup(); }
});

test('TR: probe schema rejects unknown values with version and invalid measurement subjects', async () => {
  const r = await fixture();
  try {
    const s = await r.state();
    const d: Extract<Draft, { kind: 'obs' }> = { kind: 'obs', by: 'executor:owed', subject: 'a', obligation: 'check:runtime', key: 'k', verdict: 'fail', exit: 1, durationMs: 0, commit: s.trunk.commit, base: s.trunk.commit, probe: 'trunk' };
    assert.deepEqual(validateDraft(s,d), []);
    const error = newerEntry({ ...d, probe: 'other', seq: s.seq + 1 } as unknown as ObsEntry);
    assert.equal(error?.code, 'version');
    for (const patch of [{ obligation: 'writes' }, { subject: 'trunk', obligation: 'inv:runtime' }, { commit: r.candidate }, { merging: 'a' }, { attribution: false }]) assert.ok(validateDraft(s, { ...d, ...patch }).length > 0);
  } finally { await r.cleanup(); }
});
