import test from 'node:test';
import assert from 'node:assert/strict';
import * as reducer from '../src/reducer.ts';
import * as policy from '../src/drive.ts';
import * as views from '../src/views.ts';
import * as ops from '../src/ops.ts';
import { sha256 } from '../src/canon.ts';
import type { CandidateFacts, Draft, Entry, NodeSpec, Plan, RunView } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const spec = (id: string, deps: string[] = []): NodeSpec => ({ id, deps, writes: [`${id}/`], checks: [], review: { count: 0, min_rank: 1 } });
const planOf = (): Plan => ({ version: 1, trunk: 'main', closure: [], invariants: [], nodes: [spec('old'), spec('high'), spec('wait'), spec('child', ['high']), spec('grandchild', ['child'])] });
const project = 'hash0';

// Real validating replay, including writer launches so decide reaches its merge row.
function rig(plan = planOf()) {
  const entries: Entry[] = [], plans = new Map([['p', plan]]), runs = new Map<string, RunView>();
  const lookup = (sha: string) => plans.get(sha)!;
  let current = reducer.reduce([], lookup);
  const add = (draft: Draft) => {
    const seq = entries.length;
    const e = { ...draft, seq, ts: new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString(), prev: 'x', hash: `hash${seq}` } as Entry;
    current = reducer.reduceFrom(current, [e], lookup); entries.push(e); return e;
  };
  add({ kind: 'genesis', by: 'owner:pi', channel: 'delegated', plan: 'p', trunk: 'main', commit: 's0', state: { commit: 's0', tree: 't0', invKeys: {} } });
  const r = {
    entries, lookup, runs, add, state: () => current,
    dispatch(node: string) {
      const attempt = (current.nodes[node]!.slot?.attempt ?? 0) + 1;
      add({ kind: 'dispatch', by: 'parent:main', node, attempt, base: current.trunk.commit, branch: `owed/${node}/${attempt}`, worktree: `/repo/${node}`, packet: 'blob', rulings_seen: -1 });
      const a = policy.writerLaunch(current, node, project);
      add({ kind: 'launch', by: 'parent:drive', node, attempt, role: 'writer', rid: a.rid, spec: sha256(a.spec), labels: a.labels });
      runs.set(a.rid, { rid: a.rid, state: 'sealed', status: 'ok' });
    },
    submit(node: string, reuse?: CandidateFacts) {
      const n = current.nodes[node]!, tag = entries.length;
      const facts: CandidateFacts = reuse ?? { commit: `${node}-${tag}`, tree: `t${tag}`, base: n.slot!.base, patch: `p${tag}`, changed: [`${node}/x`], closureTouched: false, keys: { writes: `w${tag}`, review: `rv${tag}`, rulings: `r${tag}` } };
      return add({ kind: 'submit', by: n.slot!.writer, node, attempt: n.slot!.attempt, facts });
    },
    pass(node: string) {
      const c = current.nodes[node]!.candidate!;
      return add({ kind: 'obs', by: 'executor:owed', subject: node, obligation: 'writes', key: c.keys.writes!, verdict: 'pass', exit: 0, durationMs: 1, commit: c.commit, base: c.base });
    },
    accept(node: string) { r.dispatch(node); r.submit(node); return r.pass(node); },
    resume(node: string, after?: string | string[]) { return add({ kind: 'resume', by: 'parent:main', node, attempt: current.nodes[node]!.slot!.attempt, ...(after === undefined ? {} : { after }) }); },
    review(node: string, verdict: 'ok' | 'block') {
      const n = current.nodes[node]!;
      return add({ kind: 'review', by: `reviewer:${node}-review`, node, attempt: n.slot!.attempt, obligation: 'review', key: n.candidate!.keys.review!, verdict, rank: 1 });
    },
    merge(node: string) {
      const n = current.nodes[node]!, c = n.candidate!, commit = `merged-${node}`;
      return add({ kind: 'merge', by: 'executor:owed', node, attempt: n.slot!.attempt, prior: current.trunk.commit, commit, facts: { ...c, commit, tree: `tm-${node}` }, state: { commit, tree: `tm-${node}`, invKeys: {} } });
    },
    changePlan(change: (p: Plan) => void) {
      const next = structuredClone(current.plan); change(next); const sha = `p${entries.length}`; plans.set(sha, next);
      return add({ kind: 'plan', by: 'owner:pi', channel: 'delegated', prior: current.planSha, plan: sha, downgrades: [], note: 'fixture change' });
    },
    actions(extra: Partial<policy.DriveOpts> = {}) {
      return policy.decide(current, current.plan, runs, { max: 3, repairs: 2, project, root: '/repo', applied: new Set(), rejected: new Map(), writerWork: new Map(Object.keys(current.nodes).map(id => [id, { head: `${id}-new-work`, dirty: false }])), ...extra });
    },
    merges(extra: Partial<policy.DriveOpts> = {}) { return r.actions(extra).filter(a => a.do === 'merge').map(a => a.node); },
  };
  return r;
}

test('DR1/MO1: transitive dependent weight beats FIFO; equal weights retain acceptance order', () => {
  const r = rig(), old = r.accept('old'), high = r.accept('high');
  assert.equal(r.state().nodes.old!.acceptedSince, old.seq);
  assert.equal(r.state().nodes.high!.acceptedSince, high.seq);
  assert.ok(r.state().nodes.high!.dependents > r.state().nodes.old!.dependents);
  assert.deepEqual(r.merges(), ['high', 'old']);
  r.accept('wait');
  assert.deepEqual(r.merges(), ['high', 'old', 'wait']);
  r.merge('old');
  assert.deepEqual(r.merges(), ['high', 'wait']);
  assert.equal(r.state().nodes.high!.acceptedSince, high.seq, 'trunk movement preserves continuous candidate acceptance');
});

test('DR1: resume --after does not override critical-path merge weight', () => {
  const r = rig(); r.accept('old'); r.accept('high'); r.dispatch('wait');
  r.resume('wait', 'high'); assert.deepEqual(r.merges(), ['high', 'old']);
  r.resume('wait'); assert.deepEqual(r.merges(), ['high', 'old'], 'latest resume replaces explicit wait, not merge weight');
  r.resume('wait', ['high', 'old']); assert.deepEqual(r.merges(), ['high', 'old'], 'waited-on group keeps critical-path weight');
  r.resume('wait', 'high');
  r.add({ kind: 'abandon', by: 'parent:main', node: 'wait', attempt: 1, reason: 'fixture closes wait' });
  assert.deepEqual(r.merges(), ['high', 'old'], 'closed attempt no longer waits; weight is unchanged');
});

test('DR1: waited-on targets disappear after merging; current deps count toward merge weight', () => {
  const r = rig(); r.accept('old'); r.accept('high'); r.dispatch('wait'); r.resume('wait', 'high');
  r.merge('high'); assert.deepEqual(r.merges(), ['old']);
  assert.equal(reducer.waitingFor(r.state(), 'wait'), undefined);
  const other = rig(); other.accept('old'); other.accept('high'); other.dispatch('wait');
  other.changePlan(p => { p.nodes.find(n => n.id === 'wait')!.deps = ['high']; });
  assert.deepEqual(other.merges(), ['high', 'old'], 'implicit dependencies contribute to transitive dependent weight');
});

test('MO1: losing and regaining acceptance resets acceptedSince on the same candidate', () => {
  const r = rig(), accepted = r.accept('old'); r.accept('high');
  r.review('old', 'block');
  assert.equal(r.state().nodes.old!.accepted, false); assert.equal(r.state().nodes.old!.acceptedSince, undefined);
  const regained = r.review('old', 'ok');
  assert.equal(r.state().nodes.old!.acceptedSince, regained.seq);
  assert.ok(regained.seq > accepted.seq); assert.deepEqual(r.merges(), ['high', 'old']);
  r.resume('old'); assert.equal(r.state().nodes.old!.acceptedSince, regained.seq, 'resume does not change acceptance tenure');
});

test('MO1: replacement candidate starts a new tenure even when all evidence is reused', () => {
  const r = rig(); r.accept('old'); r.accept('high');
  const c = r.state().nodes.old!.candidate!, replaced = r.submit('old', c);
  assert.equal(r.state().nodes.old!.accepted, true);
  assert.equal(r.state().nodes.old!.acceptedSince, replaced.seq);
  assert.deepEqual(r.merges(), ['high', 'old']);
  r.submit('old'); assert.equal(r.state().nodes.old!.acceptedSince, undefined, 'new keys await evidence');
  const accepted = r.pass('old'); assert.equal(r.state().nodes.old!.acceptedSince, accepted.seq);
});

test('MO1: invalidating plan and writer ruling clear tenure; abandoned attempts restart it', () => {
  const r = rig(); r.accept('old');
  r.changePlan(p => { p.nodes.find(n => n.id === 'old')!.brief = 'Changed contract'; });
  assert.equal(r.state().nodes.old!.acceptedSince, undefined);
  r.submit('old'); r.pass('old');
  r.add({ kind: 'rule', by: 'parent:main', nodes: ['old'], text: 'Repair the candidate', writer: true });
  assert.equal(r.state().nodes.old!.acceptedSince, undefined);
  r.add({ kind: 'abandon', by: 'parent:main', node: 'old', attempt: 1, reason: 'fixture restarts attempt' });
  assert.equal(r.state().nodes.old!.acceptedSince, undefined);
  // A new dispatch acknowledges the rule; avoid conflating rulings debt with acceptance tenure.
  r.add({ kind: 'dispatch', by: 'parent:main', node: 'old', attempt: 2, base: r.state().trunk.commit, branch: 'owed/old/2', worktree: '/repo/old2', packet: 'blob', rulings_seen: r.state().rules.at(-1)!.seq });
  r.submit('old'); const accepted = r.pass('old');
  assert.equal(r.state().nodes.old!.acceptedSince, accepted.seq);
});

test('MO1: incremental, copied/packed and full replay agree at every ledger prefix', () => {
  const r = rig(); r.accept('old'); r.accept('high'); r.dispatch('wait'); r.resume('wait', ['high', 'old']);
  r.review('old', 'block'); r.review('old', 'ok'); r.submit('old'); r.pass('old'); r.merge('high');
  let incremental = reducer.reduce([], r.lookup);
  for (let cut = 1; cut <= r.entries.length; cut++) {
    incremental = reducer.reduceFrom(incremental, [r.entries[cut - 1]!], r.lookup);
    const full = reducer.reduce(r.entries.slice(0, cut), r.lookup);
    assert.ok(reducer.sameReplay(incremental, full), `prefix ${cut}`);
    const packed = reducer.unpackState(structuredClone(reducer.packState(incremental)), r.lookup);
    assert.ok(reducer.sameReplay(packed, full), `packed prefix ${cut}`);
    assert.deepEqual(views.statusView(incremental).mergeQueue, views.statusView(full).mergeQueue);
  }
  assert.ok(reducer.sameReplay(r.state(), incremental));
  assert.ok(r.state().nodes.old!.acceptedSince !== undefined);
});

test('MO2: only merge actions reorder; non-merge actions and in-flight/halted gates are preserved', () => {
  const r = rig(); r.accept('old'); r.accept('high'); r.dispatch('wait');
  const writer = r.state().nodes.wait!.runs[0]!.launches[0]!; r.runs.delete(writer.rid);
  const initial = r.actions(); assert.deepEqual(initial.filter(a => a.do === 'merge').map(a => a.node), ['high', 'old']);
  assert.deepEqual(r.merges({ measuring: new Set(['old']) }), ['high']);
  r.add({ kind: 'halt', by: 'parent:drive', node: 'old', attempt: 1, needs: 'human', reason: 'fixture halt' });
  assert.deepEqual(r.merges(), ['high']);
  r.resume('old'); assert.deepEqual(r.merges(), ['high', 'old']);
  // A non-merge action remains ahead of both merges; the merge subsequence follows DR1 order.
  const mixed = rig(); mixed.accept('wait'); mixed.accept('old'); mixed.dispatch('high');
  const actions = mixed.actions();
  assert.deepEqual(actions.map(a => [a.do, a.node]), [['send', 'high'], ['merge', 'wait'], ['merge', 'old']]);
});

test('DR1/MO3: status JSON and full status expose the same critical-path weighted queue', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    await r.put('README', 'fixture'); await r.commit();
    await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'pi' }, channel: 'delegated', plan: JSON.stringify(planOf()), measure: false });
    for (const node of ['old', 'high']) {
      const slot = await ops.dispatch({ cwd: r.cwd, as: { role: 'parent', id: 'main' }, node });
      await commitAt(slot.worktree, { [`${node}/x`]: node });
      await ops.submit({ cwd: slot.worktree, node, as: { role: 'writer', id: `${node}#1` } });
      await ops.attest({ cwd: r.cwd, node });
    }
    const json = await cli(r.cwd, ['status', '--json']); assert.equal(json.code, 0, json.stderr);
    assert.deepEqual(JSON.parse(json.stdout).mergeQueue, ['high', 'old']);
    const full = await cli(r.cwd, ['status', '--full']); assert.equal(full.code, 0, full.stderr); assert.match(full.stdout, /^Merge queue: high, old$/m);
    await ops.dispatch({ cwd: r.cwd, as: { role: 'parent', id: 'main' }, node: 'wait' });
    const resume = await cli(r.cwd, ['resume', 'wait', '--after', 'high']); assert.equal(resume.code, 0, resume.stderr);
    assert.deepEqual((await ops.status({ cwd: r.cwd })).mergeQueue, ['high', 'old']);
    const prioritized = await cli(r.cwd, ['status', '--json']); assert.equal(prioritized.code, 0, prioritized.stderr);
    assert.deepEqual(JSON.parse(prioritized.stdout).mergeQueue, ['high', 'old']);
    assert.match(views.renderStatusFull(await ops.status({ cwd: r.cwd })), /^Merge queue: high, old$/m);
  } finally { await r.cleanup(); }
});
