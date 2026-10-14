import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ops from '../src/ops.ts';
import * as views from '../src/views.ts';
import * as reducer from '../src/reducer.ts';
import { Ledger } from '../src/ledger.ts';
import { parsePlan } from '../src/plan.ts';
import { decide, type DriveOpts } from '../src/drive.ts';
import type { Draft, Entry, ObsEntry } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const parent = { role: 'parent', id: 'test' } as const;
const owner = { role: 'owner', id: 'pi' } as const;
const writer = { role: 'writer', id: 'a#1' } as const;
const driver = { role: 'parent', id: 'drive' } as const;
const fail = (names: string[]) => `echo '${JSON.stringify({ pass: 0, fail: names.length, failed: names }).replace(/^/, 'owed-counts ')}'; exit 1`;
const driveOptions = (root: string): DriveOpts => ({ max: 1, repairs: 2, project: 'fixture', root, applied: new Set(), rejected: new Map() });

async function stateOf(cwd: string) {
  const ledger = await Ledger.open(cwd), es = await ledger.read(), plans = new Map<string, ReturnType<typeof parsePlan>>();
  for (const e of es) if (e.kind === 'genesis' || e.kind === 'plan') plans.set(e.plan, parsePlan((await ledger.getBlob(e.plan)).toString()));
  return reducer.reduce(es, sha => plans.get(sha)!);
}
const observations = async (cwd: string) => (await (await Ledger.open(cwd)).read()).filter((e): e is ObsEntry => e.kind === 'obs');
async function refusal(cwd: string, node = 'a'): Promise<string> {
  try { await ops.merge({ cwd, node, as: parent }); assert.fail('merge should refuse'); }
  catch (e) { assert.ok(e instanceof Error); return e.message; }
}

/**
 * wais 2026-10-14 15:2x: trunk changed an API (lib v1 → v2) after the slot base; the candidate's call site and its new
 * test only work with v1. inv:build passes on trunk and fails on the merge tree; check:own fails on trunk by design.
 */
async function breakFixture(tests: string[] | undefined) {
  const r = await repo();
  try {
    await commitAt(r.cwd, {
      lib: 'v1',
      'check.sh': `if [ -f t/own.test ] && grep -q v1 lib; then echo '# tests 1'; echo '# pass 1'; else ${fail(['own works'])}; fi\n`,
      'inv.sh': `if [ -f use ] && ! grep -q v1 lib; then ${fail(['build'])}; fi\necho '# tests 1'; echo '# pass 1'\n`,
    });
    const plan = { version: 1, trunk: 'main', lease: false, closure: [], invariants: [{ id: 'build', run: 'bash inv.sh', reads: ['lib', 'use', 'inv.sh'], min_tests: 1 }],
      nodes: [{ id: 'a', writes: ['use', 't/'], checks: [{ id: 'own', run: 'bash check.sh', reads: ['lib', 't/own.test', 'check.sh'], min_tests: 1, ...(tests ? { tests } : {}) }] }] };
    await ops.init({ cwd: r.cwd, plan: JSON.stringify(plan), as: owner, channel: 'delegated' });
    const a = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
    await commitAt(a.worktree, { use: 'v1-call', 't/own.test': 'new test' });
    await ops.submit({ cwd: a.worktree, node: 'a', as: writer });
    assert.equal((await ops.attest({ cwd: r.cwd, node: 'a' })).accepted, true);
    await commitAt(r.cwd, { lib: 'v2' });
    await ops.adopt({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'trunk changed the API' });
    return { ...r, a };
  } catch (e) { await r.cleanup(); throw e; }
}

const LEAD = 'merge tree does not pass inv:build (trunk passes); trunk moved 1 commits since the slot base: rebase → owed rebase a';

test('AT1/AT2: a merge-tree break leads the refusal, halt and Needs-you with rebase; new tests are never probed on trunk', async () => {
  for (const tests of [['t/own.test'], undefined]) {
    const r = await breakFixture(tests);
    try {
      const message = await refusal(r.cwd);
      assert.ok(message.startsWith(LEAD), message);
      assert.doesNotMatch(message, /trunk-red|owed waive|owed sweep|owed adopt|not shown to be the cause/);
      const probes = (await observations(r.cwd)).filter(e => e.probe === 'trunk');
      if (tests) {
        // AT2: the check's test file is new in the candidate: the slot base is its red reference, trunk is never probed.
        assert.equal(probes.length, 0, 'no trunk probe for a check whose tests are new');
        assert.match(message, /check:own runs tests new in the candidate \(t\/own\.test\): its red reference is the slot base [0-9a-f]{12}, not trunk/);
      } else {
        // AT1: even with a trunk probe that fails the same names, the merge-tree break is the attribution.
        assert.equal(probes.length, 1); assert.equal(probes[0]!.verdict, 'fail');
        const s = await stateOf(r.cwd), failed = (await observations(r.cwd)).find(e => e.merging === 'a' && e.obligation === 'check:own')!;
        assert.equal(reducer.trunkRedOf(s, failed.seq), undefined);
        assert.deepEqual(reducer.trunkParked(s, 'a'), []);
        assert.deepEqual(reducer.mergeTreeBreaks(s, 'a', failed.commit).map(b => b.obligation), ['inv:build']);
      }
      // A retry on the same state (candidate no longer accepted) keeps the same lead, through the CLI too.
      const retry = await cli(r.cwd, ['merge', 'a', '--as', 'parent:test']);
      assert.equal(retry.code, 1);
      assert.ok(retry.stderr.includes(LEAD), retry.stderr);
      assert.doesNotMatch(retry.stderr, /trunk-red|owed waive|owed sweep/);
      // The driver halts with `merge refused: <refusal>`; Needs-you leads with it and suggests the rebase.
      await ops.halt({ cwd: r.cwd, as: driver, node: 'a', attempt: 1, reason: `merge refused: ${message}`, needs: 'human' });
      const status = views.renderStatus(await ops.status({ cwd: r.cwd }));
      assert.match(status, /a: driver halted: merge refused: merge tree does not pass inv:build \(trunk passes\) → owed rebase a/);
      assert.doesNotMatch(status, /owed waive|owed sweep|owed adopt/);
    } finally { await r.cleanup(); }
  }
});

/** The trunkred fixture: the merge tree's named check failure also fails on trunk (TR3 halt material). */
async function trunkRedFixture() {
  const r = await repo();
  try {
    await commitAt(r.cwd, { flag: 'clean', impl: 'base', 'check.sh': `if grep -q broken flag; then ${fail(['old bug'])}; fi\necho '# tests 1'; echo '# pass 1'\n` });
    const plan = { version: 1, trunk: 'main', lease: false, closure: [], invariants: [], nodes: [{ id: 'a', writes: ['impl'], checks: [{ id: 'runtime', run: 'bash check.sh', reads: ['flag', 'impl', 'check.sh'], min_tests: 1 }] }] };
    await ops.init({ cwd: r.cwd, plan: JSON.stringify(plan), as: owner, channel: 'delegated' });
    const a = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
    await commitAt(a.worktree, { impl: 'candidate' });
    await ops.submit({ cwd: a.worktree, node: 'a', as: writer });
    assert.equal((await ops.attest({ cwd: r.cwd, node: 'a' })).accepted, true);
    await commitAt(r.cwd, { flag: 'broken' });
    await ops.adopt({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'trunk turns red' });
    assert.match(await refusal(r.cwd), /^trunk-red:/);
    return { ...r, a };
  } catch (e) { await r.cleanup(); throw e; }
}
const trunkRedActions = (s: Awaited<ReturnType<typeof stateOf>>, root: string) =>
  decide(s, s.plan, new Map(), driveOptions(root)).filter(x => x.do === 'halt' || (x.do === 'notify' && /trunk-red|waiting: a/.test(x.text)));

test('AT3: a new submit supersedes the old candidate\'s merge-tree block; TR3 neither parks nor halts, resume never re-halts', async () => {
  const r = await trunkRedFixture();
  try {
    const before = await stateOf(r.cwd);
    assert.ok(reducer.trunkParked(before, 'a').length > 0, 'the old candidate is parked as trunk-red');
    const old = (await observations(r.cwd)).find(e => e.merging === 'a')!;
    // The writer submits the fixing candidate.
    await commitAt(r.a.worktree, { impl: 'candidate fixed' });
    await ops.submit({ cwd: r.a.worktree, node: 'a', as: writer });
    let s = await stateOf(r.cwd);
    assert.ok(s.nodes.a!.blocks.some(b => b.seq === old.seq && b.state === 'active'), 'the old block still binds until attested');
    assert.equal(reducer.priorCandidateBlock(s, 'a', { seq: old.seq }), true);
    assert.deepEqual(reducer.trunkParked(s, 'a'), []);
    assert.deepEqual(trunkRedActions(s, r.cwd), []);
    assert.ok(reducer.attestJobs(s, 'a').some(j => j.key === s.nodes.a!.candidate!.keys['check:runtime']), 'the new candidate is attested first');
    // A halt then a resume after the new submit: the next pass does not halt again on the old block.
    await ops.halt({ cwd: r.cwd, as: driver, node: 'a', attempt: 1, reason: 'merge refused: stale', needs: 'human' });
    await ops.resume({ cwd: r.cwd, node: 'a', as: parent, note: 'new candidate submitted' });
    s = await stateOf(r.cwd);
    assert.deepEqual(trunkRedActions(s, r.cwd), []);
    // Against the candidate it was measured for, the same block is current (the TR3 behavior is unchanged there).
    assert.equal(reducer.priorCandidateBlock(before, 'a', { seq: old.seq }), false);
  } finally { await r.cleanup(); }
});

const name = 'marker survives playback';
function historyRig() {
  const p = parsePlan(JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [{ id: 'suite', run: 'true' }], nodes: [{ id: 'a', writes: ['impl'] }, { id: 'b', writes: ['other'] }] }));
  const entries: Entry[] = [];
  const add = (draft: Draft) => { const e = { ...draft, seq: entries.length, ts: '2026-10-14T00:00:00Z', prev: 'x', hash: 'x' } as Entry; entries.push(e); return e; };
  add({ kind: 'genesis', by: 'owner:pi', trunk: 'main', plan: 'p', commit: 'base', state: { commit: 'base', tree: 'tree', invKeys: { suite: 'inv-base' } } });
  const obs = (extra: Partial<ObsEntry>) => add({ kind: 'obs', by: 'executor:owed', subject: 'a', obligation: 'check:runtime', key: 'k-now', verdict: 'fail', exit: 1, durationMs: 1, commit: 'tree-now', failed: [name], signatures: { [name]: 'boom' }, ...extra }) as ObsEntry;
  return { obs, hints: (f: ObsEntry) => views.mergeFailureHints(reducer.reduce(entries, () => p), 'a', [f]).filter(l => /intermittent|older trees/.test(l)) };
}

test('AT4: known intermittent needs a same-key flip or the same error on trunk; trees of the same node are no evidence', () => {
  const r = historyRig();
  r.obs({ commit: 'tree-old-1', key: 'k-old-1' });
  r.obs({ commit: 'tree-old-2', key: 'k-old-2', signatures: { [name]: 'other' } });
  const current = r.obs({});
  assert.deepEqual(r.hints(current), [], 'same-node trees are not independent evidence');
  const other = r.obs({ subject: 'b', commit: 'tree-b', key: 'k-b', signatures: { [name]: 'a different error' } });
  assert.deepEqual(r.hints(current), [`same test failed on older trees (different error): ${name} (#${other.seq})`]);
  r.obs({ subject: 'trunk', obligation: 'inv:suite', key: 'inv-base', commit: 'trunk-1', signatures: { [name]: 'another trunk error' } });
  assert.deepEqual(r.hints(current), [`same test failed on older trees (different error): ${name} (#${other.seq + 1}, #${other.seq})`]);
  const trunk = r.obs({ subject: 'trunk', obligation: 'inv:suite', key: 'inv-base', commit: 'trunk-2' });
  assert.deepEqual(r.hints(current), [`known intermittent: ${name} failed with the same error on trunk (#${trunk.seq})`]);
  const pass = r.obs({ verdict: 'pass', exit: 0, failed: undefined, signatures: undefined });
  assert.deepEqual(r.hints(current), [`known intermittent: ${name} failed and passed on the same key (#${pass.seq})`]);
});

/** wais 2026-10-13 20:2x (RG-OFF): trunk red from genesis with an incomplete name list, so IR2 cannot inherit it. */
async function deferFixture() {
  const r = await repo();
  try {
    const inv = [
      'if grep -q broken flag; then',
      "  echo 'TAP version 13'; echo 'not ok 1 - old bug'; echo '  ---'; echo \"  error: '$(cat sig)'\"; echo '  ...'",
      "  echo '# tests 2'; echo '# pass 0'; echo '# fail 2'; exit 1",
      'fi',
      "echo '# tests 1'; echo '# pass 1'",
    ].join('\n');
    await commitAt(r.cwd, { flag: 'broken', sig: 'boom A', other: '1', impl: 'base', 'inv.sh': `${inv}\n` });
    const plan = { version: 1, trunk: 'main', lease: false, closure: [], invariants: [{ id: 'suite', run: 'bash inv.sh', reads: ['flag', 'sig', 'other', 'impl', 'inv.sh'] }], nodes: [{ id: 'a', writes: ['impl'], checks: [] }] };
    await ops.init({ cwd: r.cwd, plan: JSON.stringify(plan), as: owner, channel: 'delegated' });
    const genesis = (await observations(r.cwd)).find(e => e.obligation === 'inv:suite')!;
    assert.equal(genesis.verdict, 'fail');
    assert.deepEqual(genesis.signatures, { 'old bug': 'boom A' }, 'exec records the normalized first error line per failed name');
    const a = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
    await commitAt(a.worktree, { impl: 'candidate' });
    await ops.submit({ cwd: a.worktree, node: 'a', as: writer });
    assert.equal((await ops.attest({ cwd: r.cwd, node: 'a' })).accepted, true);
    assert.match(await refusal(r.cwd), /invariant suite new debt: failed names truncated/);
    const failed = (await observations(r.cwd)).findLast(e => e.merging === 'a' && e.obligation === 'inv:suite')!;
    const defer = await ops.defer({ cwd: r.cwd, node: 'a', as: owner, channel: 'delegated', reason: 'trunk-own failure', items: [{ id: 'suite', key: failed.key }] });
    return { ...r, a, failed, defer };
  } catch (e) { await r.cleanup(); throw e; }
}

test('AT5: an owner defer of a trunk-own failure carries to the next merge key while trunk fails the same way', async () => {
  const r = await deferFixture();
  try {
    await commitAt(r.cwd, { other: '2' });
    await ops.adopt({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'trunk moved; same failure' });
    const result = await ops.merge({ cwd: r.cwd, node: 'a', as: parent });
    assert.equal(result.entry.kind, 'merge');
    const item = result.deferred.find(i => i.obligation === 'inv:suite')!;
    assert.ok(item, 'the carried defer stays visible debt');
    assert.notEqual(item.key, r.failed.key);
    assert.equal(item.detail, `inv:suite owner deferred, still debt; defer #${r.defer.seq} carried (same trunk failure)`);
    assert.ok(item.evidence.includes(r.defer.seq));
    assert.equal((await stateOf(r.cwd)).nodes.a!.phase, 'merged');
  } finally { await r.cleanup(); }
});

test('AT5: a defer does not carry when trunk now fails with another signature; the refusal says where it was bound', async () => {
  const r = await deferFixture();
  try {
    await commitAt(r.cwd, { other: '2', sig: 'boom B' });
    await ops.adopt({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'trunk moved; different error' });
    const message = await refusal(r.cwd);
    assert.ok(message.includes(`defer #${r.defer.seq} was bound to merge key ${r.failed.key.slice(0, 12)} (trunk moved)`), message);
    assert.doesNotMatch(message, /carried/);
    const s = await stateOf(r.cwd);
    assert.equal(reducer.carriedDefer(s, 'a', 'suite', 'unmeasured-key')?.carried, false);
  } finally { await r.cleanup(); }
});
