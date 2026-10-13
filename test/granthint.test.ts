// GH: prove the recovery hint's outcome and retain trunk-red refusal precedence.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { parsePlan } from '../src/plan.ts';
import { reduce, attestJobs, trunkRedOf } from '../src/reducer.ts';
import { runJob } from '../src/exec.ts';
import { renderReceipt } from '../src/views.ts';
import { git } from '../src/git.ts';
import type { ObsEntry } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { commitAt, identity } from './helpers/surface.ts';

const owner = { role: 'owner', id: 'test' } as const;
const parent = { role: 'parent', id: 'test' } as const;
const writer = { role: 'writer', id: 'a#1' } as const;
const recoveryHint = 'hint: paths are now pre-authorized; submit a new commit (any change, e.g. an amended commit message) so the writes item is measured again under the new allow rule';
const plan = (checks: unknown[] = [], allow: unknown[] = []) => ({
  version: 1, trunk: 'main', lease: false, closure: [], invariants: [],
  nodes: [{ id: 'a', writes: ['src/'], checks }], allow,
});
async function fixture(p = plan()) {
  const r = await repo();
  try {
    await commitAt(r.cwd, { 'src/base': 'base', flag: 'clean' });
    await ops.init({ cwd: r.cwd, plan: JSON.stringify(p), as: owner, channel: 'flag' });
    const slot = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
    const ledger = await Ledger.open(r.cwd);
    const state = async () => {
      const entries = await ledger.read(), plans = new Map<string, ReturnType<typeof parsePlan>>();
      for (const e of entries) if (e.kind === 'genesis' || e.kind === 'plan') plans.set(e.plan, parsePlan((await ledger.getBlob(e.plan)).toString()));
      return reduce(entries, sha => plans.get(sha)!);
    };
    const submit = async (files: Record<string, string>) => {
      const commit = await commitAt(slot.worktree, files);
      await ops.submit({ cwd: slot.worktree, node: 'a', as: writer });
      return commit;
    };
    return { ...r, slot, ledger, state, submit };
  } catch (e) { await r.cleanup(); throw e; }
}
const writes = (entries: Awaited<ReturnType<Ledger['read']>>) => entries.filter((e): e is ObsEntry => e.kind === 'obs' && e.subject === 'a' && e.obligation === 'writes');

test('GH1: follow the old attribution then --rerun advice after adding an allowance', async () => {
  const r = await fixture();
  try {
    await r.submit({ 'docs/a': 'task needs this' });
    assert.equal((await ops.attest({ cwd: r.cwd, node: 'a' })).accepted, false);
    const key = writes(await r.ledger.read())[0]!.key;
    await ops.planSet({ cwd: r.cwd, as: owner, channel: 'flag', plan: JSON.stringify(plan([], [{ nodes: ['a'], writes: ['docs/'] }])) });
    const hint = (await ops.why({ cwd: r.cwd, node: 'a' })).outOfWrites?.hint;
    assert.equal(hint, recoveryHint);
    assert.ok(renderReceipt(await ops.why({ cwd: r.cwd, node: 'a' })).includes(recoveryHint));
    await ops.attest({ cwd: r.cwd, node: 'a' });
    assert.equal(writes(await r.ledger.read()).at(-1)!.attribution, true);
    const rerun = await ops.attest({ cwd: r.cwd, node: 'a', rerun: true });
    const observations = writes(await r.ledger.read()).filter(o => o.key === key);
    console.log('GH1 old-advice outcome:', JSON.stringify({ accepted: rerun.accepted, writes: (await r.state()).nodes.a!.items.find(i => i.obligation === 'writes'), observations: observations.map(o => ({ seq: o.seq, verdict: o.verdict, attribution: o.attribution })) }));
    assert.equal(rerun.accepted, false, 'old advice creates a conflict, not acceptance');
    assert.deepEqual(observations.map(o => o.verdict), ['fail', 'fail', 'pass']);
    const item = (await r.state()).nodes.a!.items.find(i => i.obligation === 'writes')!;
    assert.equal(item.mark, '⊤');
    assert.equal(item.discharger, 'owner');
  } finally { await r.cleanup(); }
});

test('GH1: the new hint reaches acceptance by amending only the commit message', async () => {
  const r = await fixture();
  try {
    const commit = await r.submit({ 'docs/a': 'task needs this' });
    await ops.attest({ cwd: r.cwd, node: 'a' });
    const key = writes(await r.ledger.read())[0]!.key;
    await ops.planSet({ cwd: r.cwd, as: owner, channel: 'flag', plan: JSON.stringify(plan([], [{ nodes: ['a'], writes: ['docs/'] }])) });
    assert.equal((await ops.why({ cwd: r.cwd, node: 'a' })).outOfWrites?.hint, recoveryHint);
    await git(r.slot.worktree, ['commit', '--amend', '-m', 'measure writes under the new allowance'], { env: identity });
    await ops.submit({ cwd: r.slot.worktree, node: 'a', as: writer });
    const updated = (await r.state()).nodes.a!.candidate!;
    assert.notEqual(updated.commit, commit);
    assert.notEqual(updated.keys.writes, key);
    assert.equal((await git(r.slot.worktree, ['diff', commit, updated.commit])).stdout, '', 'only the commit message changed');
    assert.equal((await ops.attest({ cwd: r.cwd, node: 'a' })).accepted, true);
    const entries = await r.ledger.read();
    assert.deepEqual(writes(entries).filter(o => o.key === key).map(o => o.verdict), ['fail', 'fail']);
    assert.deepEqual(writes(entries).filter(o => o.key === updated.keys.writes).map(o => o.verdict), ['pass']);
    assert.equal(entries.filter(e => e.kind === 'grant').length, 1);
    assert.equal(entries.filter(e => e.kind === 'waive').length, 0);
    await ops.merge({ cwd: r.cwd, node: 'a', as: parent });
    assert.equal((await r.state()).nodes.a!.phase, 'merged');
  } finally { await r.cleanup(); }
});

test('GH2: mixed trunk-red and uncovered writes refusal keeps trunk-red first and adds one GR7 hint', async () => {
  const check = { id: 'runtime', run: `if grep -q broken flag; then echo 'owed-counts {"pass":0,"fail":1,"failed":["old bug"]}'; exit 1; else echo 'owed-counts {"pass":1,"fail":0}'; fi`, reads: ['flag'], min_tests: 1 };
  const r = await fixture(plan([check]));
  try {
    await r.submit({ 'src/a': 'candidate' });
    assert.equal((await ops.attest({ cwd: r.cwd, node: 'a' })).accepted, true);
    await commitAt(r.cwd, { flag: 'broken' });
    await ops.adopt({ cwd: r.cwd, as: owner, channel: 'flag', note: 'fixture breaks trunk, not candidate' });
    await assert.rejects(ops.merge({ cwd: r.cwd, node: 'a', as: parent }), /trunk-red:/);
    await r.submit({ 'docs/a': 'uncovered', 'docs/b': 'also uncovered' });
    // Measure only writes: attributing the existing merge block would no longer test the mixed refusal.
    const s = await r.state(), job = attestJobs(s, 'a').find(j => j.kind === 'writes' && !j.attribution)!;
    assert.ok(job);
    const observation = await runJob({ cwd: r.cwd, plan: s.plan, ledger: r.ledger }, job);
    assert.equal(observation.verdict, 'fail');
    await r.ledger.withLock(() => r.ledger.append([observation]));
    const mixed = await r.state();
    assert.ok(mixed.nodes.a!.blocks.some(b => b.state === 'active' && trunkRedOf(mixed, b.seq, b.key)));
    assert.equal(mixed.nodes.a!.items.find(i => i.obligation === 'writes')!.status, 'D');
    const hint = 'hint: an allow rule {nodes: ["a"], writes: ["docs/"]} would let owed grant these';
    const before = await r.ledger.read();
    await assert.rejects(ops.merge({ cwd: r.cwd, node: 'a', as: parent }), e => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /^trunk-red:/);
      assert.equal(e.message.split(hint).length, 2, 'GR7 hint appears exactly once');
      return true;
    });
    assert.deepEqual(await r.ledger.read(), before, 'refusal neither weakens gates nor appends ledger entries');
    assert.equal(mixed.nodes.a!.accepted, false);
  } finally { await r.cleanup(); }
});
