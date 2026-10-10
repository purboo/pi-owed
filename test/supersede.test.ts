// L2 (0.8.0, wais #19, #20): a plan entry that changes or removes a check's definition supersedes the execution blocks
// recorded under the old definition; they no longer block, get no attribution rerun and need no waiver.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { attestJobs, jobCurrent, manualKeys, reduce, validateDraft } from '../src/reducer.ts';
import { manualHalt } from '../src/drive.ts';
import { receipt, renderReceipt, renderReport, renderStatus, statusView, supersededOf } from '../src/views.ts';
import type { Report } from '../src/views.ts';
import type { CandidateFacts, Draft, Entry, ObsEntry, Plan, StateFacts } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';
import { Ledger } from '../src/ledger.ts';
import * as ops from '../src/ops.ts';

const plan = (): Plan => ({ version: 1, trunk: 'main', closure: ['config/**'], invariants: [], nodes: [
  { id: 'a', title: 'node a', deps: [], writes: ['src/'], checks: [
    { id: 'unit', run: 'unit', timeout_s: 10, reads: ['src/**'], red: true, tests: ['test/**'], mutants: ['config/m/*.patch'] },
    { id: 'lint', run: 'lint', timeout_s: 10, reads: ['src/**'] },
  ], review: { count: 0, min_rank: 1 } },
  { id: 'b', deps: [], writes: ['lib/'], checks: [{ id: 'unit', run: 'b-unit', timeout_s: 10, reads: ['lib/**'] }], review: { count: 0, min_rank: 1 } },
] } as Plan);
const facts = (tag = '1', extra: Partial<CandidateFacts> = {}): CandidateFacts => ({ commit: `c${tag}`, base: 's0', tree: `t${tag}`, patch: `p${tag}`, changed: ['src/a'], closureTouched: false, keys: { 'check:unit': `check${tag}`, 'red:unit': `red${tag}`, 'strength:unit': `strength${tag}`, 'check:lint': `lint${tag}`, writes: `writes${tag}`, rulings: `rule${tag}` }, ...extra });
const sf = (): StateFacts => ({ commit: 's0', tree: 't0', invKeys: {} });
function rig(p = plan()) {
  const entries: Entry[] = [];
  const plans: Record<string, Plan> = { p };
  const lookup = (sha: string): Plan => { const x = plans[sha]; if (!x) throw Error('missing plan'); return x; };
  const state = () => reduce(entries, lookup);
  const add = (d: Draft): number => { const seq = entries.length; entries.push({ ...d, seq, ts: 'fixed', prev: 'x', hash: `hash${seq}` } as Entry); return seq; };
  add({ kind: 'genesis', by: 'owner:human', channel: 'tty', plan: 'p', trunk: 'main', commit: 's0', state: sf() });
  let current = 'p', n = 0;
  const dispatch = () => add({ kind: 'dispatch', by: 'parent:main', node: 'a', attempt: 1, base: 's0', branch: 'branch', worktree: 'wt', packet: 'blob', rulings_seen: -1 });
  const submit = (f = facts()) => add({ kind: 'submit', by: 'writer:a#1', node: 'a', attempt: 1, facts: f });
  const obs = (obligation: string, key: string, verdict: 'pass' | 'fail' = 'pass', extras: Partial<Extract<Draft, { kind: 'obs' }>> = {}) => add({ kind: 'obs', by: 'executor:owed', subject: 'a', obligation, key, verdict, exit: verdict === 'pass' ? 0 : 1, durationMs: 1, commit: 'c1', base: 's0', ...extras });
  const pass = (f = facts()) => { for (const [o, k] of Object.entries(f.keys)) if (o !== 'rulings' && !o.startsWith('approve')) obs(o, k, 'pass', { commit: f.commit, base: f.base }); };
  /** Record a plan entry replacing the plan with `edit(copy of the current plan)`, by the owner. */
  const replan = (edit: (p: Plan) => void): number => {
    const next = structuredClone(plans[current]!); edit(next);
    const sha = `p${++n}`; plans[sha] = next;
    const seq = add({ kind: 'plan', by: 'owner:human', channel: 'tty', prior: current, plan: sha, downgrades: [] });
    current = sha; return seq;
  };
  return { entries, state, add, dispatch, submit, obs, pass, replan };
}
const unit = (p: Plan) => p.nodes[0]!.checks[0]!;
const block = (r: ReturnType<typeof rig>, seq: number) => r.state().nodes.a!.blocks.find(b => b.seq === seq)!;

test('L2.1/L2.2: an env-fix plan change supersedes the block: no attribution rerun, no waiver, a queued rerun is not current', () => {
  const r = rig(); r.dispatch(); r.submit();
  const fail = r.obs('check:unit', 'check1', 'fail');
  const queued = attestJobs(r.state(), 'a').find(j => j.attribution);
  assert.ok(queued, 'an attribution rerun is queued before the fix');
  const p = r.replan(x => { unit(x).run = 'make artifact && unit'; });
  let s = r.state();
  assert.equal(block(r, fail).state, 'superseded');
  assert.equal(block(r, fail).supersededBy, p);
  assert.equal(jobCurrent(s, queued), false, 'a queued rerun of a superseded block is not current');
  assert.match(validateDraft(s, { kind: 'obs', by: 'executor:owed', subject: 'a', obligation: 'check:unit', key: 'check1', verdict: 'pass', exit: 0, durationMs: 1, commit: 'c1', base: 's0', attribution: true }).join(), /active execution block/);
  // The plan change invalidated the candidate; the writer submits again, and the new definition is measured.
  assert.equal(s.nodes.a!.candidate, undefined);
  r.submit(facts('2'));
  s = r.state();
  assert.deepEqual(attestJobs(s, 'a').filter(j => j.attribution), [], 'no attribution rerun for a superseded block');
  assert.equal(s.nodes.a!.accepted, false, 'the candidate must still pass the new definition');
  r.pass(facts('2'));
  s = r.state();
  assert.equal(s.nodes.a!.accepted, true, 'accepted with no waiver');
  assert.equal(s.nodes.a!.items.find(i => i.obligation === 'check:unit')?.status, 'E');
  assert.ok(!r.entries.some(e => e.kind === 'waive'));
  // A superseded block cannot be accepted by a waiver: it is not active.
  assert.match(validateDraft(s, { kind: 'waive', by: 'owner:human', node: 'a', obligation: 'check:unit', key: 'check2', reason: 'x', accept_risk: [fail] }).join(), /active blocks/);
});

test('L2.2: an unchanged check definition still goes flaky (title, brief, closure, other checks and nodes do not count)', () => {
  const r = rig(); r.dispatch(); r.submit();
  const fail = r.obs('check:unit', 'check1', 'fail');
  r.replan(x => { x.nodes[0]!.title = 'renamed'; x.nodes[0]!.brief = 'new brief'; x.closure = ['other/**']; x.nodes[0]!.checks[1]!.run = 'lint2'; x.nodes[1]!.checks[0]!.run = 'b2'; });
  assert.equal(block(r, fail).state, 'active');
  assert.equal(block(r, fail).supersededBy, undefined);
  r.submit(facts('2')); r.pass(facts('2'));
  const j = attestJobs(r.state(), 'a').filter(x => x.attribution);
  assert.equal(j.length, 1);
  r.obs('check:unit', 'check1', 'pass', { attribution: true });
  assert.equal(block(r, fail).state, 'flaky');
  assert.equal(r.state().nodes.a!.accepted, false, 'a flaky block still needs the owner');
});

test('L2.1: setup and exec belong to the definition; red and strength blocks of the check are superseded too', () => {
  for (const edit of [(x: Plan) => { x.setup = 'ln -s ../node_modules node_modules'; }, (x: Plan) => { x.exec = { env: { CI: '1' } }; }]) {
    const r = rig(); r.dispatch(); r.submit();
    const blocks = ['check:unit', 'red:unit', 'strength:unit', 'check:lint'].map(o => r.obs(o, facts().keys[o]!, 'fail'));
    const p = r.replan(edit);
    for (const seq of blocks) { assert.equal(block(r, seq).state, 'superseded'); assert.equal(block(r, seq).supersededBy, p); }
  }
  // Only the changed check's blocks go; another check's block stays active.
  const r = rig(); r.dispatch(); r.submit();
  const red = r.obs('red:unit', 'red1', 'fail'), strength = r.obs('strength:unit', 'strength1', 'fail'), lint = r.obs('check:lint', 'lint1', 'fail');
  r.replan(x => { unit(x).min_tests = 3; });
  assert.equal(block(r, red).state, 'superseded'); assert.equal(block(r, strength).state, 'superseded'); assert.equal(block(r, lint).state, 'active');
});

test('L2.1: removing a check supersedes its blocks; a flaky block is superseded by a later definition change', () => {
  const r = rig(); r.dispatch(); r.submit();
  const lint = r.obs('check:lint', 'lint1', 'fail');
  const p = r.replan(x => { x.nodes[0]!.checks.pop(); });
  assert.equal(block(r, lint).state, 'superseded'); assert.equal(block(r, lint).supersededBy, p);
  assert.ok(r.state().downgrades.some(d => d.seq === p), 'removal is still an owner downgrade');
  assert.deepEqual(supersededOf(r.state(), [r.state().nodes.a!]).map(b => b.text), [`#${lint} superseded by plan #${p} (check lint removed)`]);
  // Rerun first (flaky), plan fix second.
  r.submit(facts('2'));
  const fail = r.obs('check:unit', 'check2', 'fail', { commit: 'c2' });
  r.obs('check:unit', 'check2', 'pass', { commit: 'c2', attribution: true });
  assert.equal(block(r, fail).state, 'flaky');
  const q = r.replan(x => { unit(x).run = 'fixed'; });
  assert.equal(block(r, fail).state, 'superseded'); assert.equal(block(r, fail).supersededBy, q);
  r.submit(facts('3')); r.pass(facts('3'));
  assert.equal(r.state().nodes.a!.accepted, true);
});

test('L2.3: why, status and report show a superseded block; it is not listed as active', () => {
  const r = rig(); r.dispatch(); r.submit();
  const fail = r.obs('check:unit', 'check1', 'fail');
  const p = r.replan(x => { unit(x).run = 'make artifact && unit'; });
  const s = r.state(), line = `#${fail} superseded by plan #${p} (check unit definition changed)`;
  const card = receipt(s, r.entries, 'a');
  assert.deepEqual(card.blocks, []);
  assert.deepEqual(card.superseded?.map(b => [b.seq, b.supersededBy, b.text]), [[fail, p, line]]);
  assert.ok(renderReceipt(card).split('\n').includes(`⊘ ${line}`), renderReceipt(card));
  const status = statusView(s, r.entries);
  assert.ok(renderStatus(status).split('\n').includes(`⊘ a: ${line}`), renderStatus(status));
  const report = { since: -1, merges: [], blocks: [], waivers: [], downgrades: [], rulings: [], decisions: [], changes: [], ownerActions: [], adoptions: [], halts: [], escapes: { escapes: [], byClass: { missing: 0, 'false-pass': 0, reuse: 0, weak: 0, waiver: 0 }, decoys: [], caught: 0, escaped: 0, pending: 0, unrevealed: 0, rate: null }, superseded: supersededOf(s, [s.nodes.a!]) } as Report;
  const text = renderReport(report).split('\n');
  const at = text.indexOf('Superseded blocks (not active; the plan changed their check)');
  assert.ok(at > text.indexOf('Active blocks: none'), text.join('\n'));
  assert.equal(text[at + 1], `  a/check:unit ${line}`);
});

test('L2.4: the driver\'s manual-only halt is not disabled by a superseded block', () => {
  const p = plan(); p.nodes[0]!.approve = 'owner'; p.nodes[0]!.checks = [{ id: 'unit', run: 'unit', timeout_s: 10, reads: ['src/**'] }];
  const r = rig(p); r.dispatch();
  const f1 = facts('1', { keys: { 'check:unit': 'check1', writes: 'writes1', rulings: 'rule1', ...manualKeys(p.nodes[0]!, 'p1') } });
  r.submit(f1);
  r.obs('check:unit', 'check1', 'fail');
  r.replan(x => { unit(x).run = 'fixed'; });
  const f2 = facts('2', { keys: { 'check:unit': 'check2', writes: 'writes2', rulings: 'rule2', ...manualKeys(p.nodes[0]!, 'p2') } });
  r.submit(f2); r.obs('check:unit', 'check2', 'pass', { commit: 'c2' }); r.obs('writes', 'writes2', 'pass', { commit: 'c2' });
  const h = manualHalt(r.state(), 'a');
  assert.equal(h?.needs, 'owner');
  assert.match(h?.reason ?? '', /owed approve a/);
});

const tap = (n: number) => `echo '# tests ${n}'; echo '# pass ${n}'; echo '# fail 0'`;
const e2ePlan = (run: string) => JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [], nodes: [
  { id: 'a', writes: ['src/'], checks: [{ id: 'unit', run, reads: ['src/**'] }], review: { count: 0, min_rank: 1 } },
] });

test('L2 end to end: the env-fix plan supersedes #852-like block; attest reruns nothing, no waiver; why/status/report show it', { timeout: 300_000 }, async () => {
  const x = await repo();
  try {
    // The check needs a build artifact that only exists outside the fresh measurement worktree.
    const artifact = join(x.root, 'artifact');
    const v1 = e2ePlan(`if [ -e '${artifact}' ]; then ${tap(1)}; else echo 'missing artifact'; exit 1; fi`);
    await commitAt(x.cwd, { README: 'x\n' });
    await ops.init({ cwd: x.cwd, plan: v1, as: { role: 'owner', id: 'human' }, channel: 'flag' });
    const d = await ops.dispatch({ cwd: x.cwd, node: 'a', as: { role: 'parent', id: 'main' } });
    await commitAt(d.worktree, { 'src/a': 'a\n' });
    await ops.submit({ cwd: d.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
    await ops.attest({ cwd: x.cwd, node: 'a' });
    const fail = (await (await Ledger.open(x.cwd)).read()).find((e): e is ObsEntry => e.kind === 'obs' && e.subject === 'a' && e.verdict === 'fail');
    assert.ok(fail, 'the check failed for an environmental reason');
    // The parent fixes the check definition: it prepares its own artifact.
    const plan = await ops.planSet({ cwd: x.cwd, plan: e2ePlan(`touch '${artifact}'; ${tap(1)}`), as: { role: 'owner', id: 'human' }, channel: 'flag', note: 'check prepares its artifact' });
    // The artifact now exists on the host too, so an attribution rerun of the old definition would pass (flaky).
    await writeFile(artifact, '');
    await ops.submit({ cwd: d.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
    const r = await ops.attest({ cwd: x.cwd, node: 'a' });
    assert.deepEqual(r.observations.filter(e => e.kind === 'obs' && e.attribution), [], 'no attribution rerun');
    assert.equal(r.accepted, true);
    const entries = await (await Ledger.open(x.cwd)).read();
    assert.ok(!entries.some(e => e.kind === 'waive'), 'no waiver');
    const line = `#${fail.seq} superseded by plan #${plan.seq} (check unit definition changed)`;
    const why = await cli(x.cwd, ['why', 'a']);
    assert.ok(why.stdout.split('\n').includes(`⊘ ${line}`), why.stdout);
    assert.ok(!why.stdout.includes('⛔ blocked'), why.stdout);
    const status = await cli(x.cwd, ['status']);
    assert.ok(status.stdout.split('\n').includes(`⊘ a: ${line}`), status.stdout);
    const report = await cli(x.cwd, ['report']);
    assert.ok(report.stdout.split('\n').includes(`  a/check:unit ${line}`), report.stdout);
    assert.match(report.stdout, /Active blocks: none/);
    const json = JSON.parse((await cli(x.cwd, ['why', 'a', '--json'])).stdout) as { superseded?: { seq: number; supersededBy: number; state: string }[] };
    assert.deepEqual(json.superseded?.map(b => [b.seq, b.supersededBy, b.state]), [[fail.seq, plan.seq, 'superseded']]);
    // A report window after the plan entry no longer lists it.
    assert.doesNotMatch((await cli(x.cwd, ['report', '--since', String(plan.seq)])).stdout, /superseded by plan/);
  } finally { await x.cleanup(); }
});
