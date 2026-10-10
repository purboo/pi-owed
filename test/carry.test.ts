// N1 (0.10.0, wais #24 part 1): a plan entry that changes only a node's checks, writes, type or drive carries the open
// candidate (a carry submit by executor:owed in the same lock); any other spec change leaves it invalidated, and the
// driver's row 8 sends a `submit` follow-up naming the plan entry instead of a stale `rebase` (wais #1375).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from '../src/canon.ts';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { reduce, runId, validateDraft } from '../src/reducer.ts';
import { decide, planChangedMessage, rebaseMessage, writerLaunch, type Action, type DriveOpts } from '../src/drive.ts';
import { receipt, renderReceipt, renderStatus, statusView } from '../src/views.ts';
import type { CandidateFacts, Draft, Entry, NodeSpec, Plan, RunView, State } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt, planText, seed, checkTest } from './helpers/surface.ts';

const owner = { role: 'owner', id: 'pi' } as const, parent = { role: 'parent', id: 'test' } as const;
/** planText with node a reviewed once (review evidence must survive a carry). */
const base = () => { const p = JSON.parse(planText); p.nodes[0].review = { count: 1, min_rank: 1 }; return p; };

async function submitted() {
  const r = await repo();
  await seed(r.cwd);
  await ops.init({ cwd: r.cwd, plan: JSON.stringify(base()), as: owner, channel: 'flag' });
  const a = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
  await commitAt(a.worktree, { 'test/a.cjs': 'module.exports=1;', 'test/a.test.cjs': checkTest('a', 1) });
  const sub = await ops.submit({ cwd: a.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
  if (sub.kind !== 'submit') throw Error('submit');
  return { r, a, sub };
}
const entriesOf = async (cwd: string): Promise<Entry[]> => (await Ledger.open(cwd)).read();
const item = (card: Awaited<ReturnType<typeof ops.why>>, o: string) => card.items.find(i => i.obligation === o)!;

test('N1: a check-only change carries the candidate; reviews on unchanged keys count, the changed check is measured again', { timeout: 120_000 }, async () => {
  const { r, sub } = await submitted();
  try {
    await ops.attest({ cwd: r.cwd, node: 'a' });
    await ops.review({ cwd: r.cwd, node: 'a', as: { role: 'reviewer', id: 'rev' }, verdict: 'ok', rank: 1, note: 'ok' });
    assert.equal((await ops.why({ cwd: r.cwd, node: 'a' })).accepted, true);
    const next = base(); next.nodes[0].checks[0].run = 'node --test --test-reporter=tap --test-concurrency=1 test/a.test.cjs';
    // Record through the CLI from a file (not committed) so its output line is checked.
    await writeFile(join(r.root, 'plan.json'), JSON.stringify(next));
    const res = await cli(r.cwd, ['plan', join(r.root, 'plan.json'), '--as', 'owner:pi', '--note', 'check fix']);
    assert.equal(res.code, 0, res.stderr);
    const es = await entriesOf(r.cwd), planEntry = es.findLast(e => e.kind === 'plan')!, carry = es[planEntry.seq + 1]!;
    assert.ok(carry.kind === 'submit' && carry.by === 'executor:owed' && carry.carry === sub.seq, JSON.stringify(carry));
    if (carry.kind !== 'submit') throw Error('carry');
    assert.equal(carry.facts.commit, sub.facts.commit);
    assert.equal(carry.facts.base, sub.facts.base);
    assert.equal(carry.facts.keys.review, sub.facts.keys.review, 'review key unchanged');
    assert.equal(carry.facts.keys.writes, sub.facts.keys.writes, 'writes key unchanged');
    assert.notEqual(carry.facts.keys['check:a'], sub.facts.keys['check:a'], 'changed check key');
    assert.match(res.stdout, new RegExp(`Carried a: candidate ${sub.facts.commit.slice(0, 12)} \\(submit #${sub.seq}\\) is still the candidate as #${carry.seq}`));
    let card = await ops.why({ cwd: r.cwd, node: 'a' });
    assert.equal(item(card, 'review').status, 'E', 'the review on the unchanged key still counts');
    assert.equal(item(card, 'writes').status, 'E');
    assert.equal(item(card, 'check:a').status, 'D', 'the changed check is owed again');
    assert.equal(card.accepted, false);
    assert.deepEqual(card.carried, { seq: carry.seq, plan: planEntry.seq, submit: sub.seq });
    assert.match(renderReceipt(card), new RegExp(`carried by plan #${planEntry.seq} from submit #${sub.seq}`));
    assert.match(renderStatus(await ops.status({ cwd: r.cwd })), new RegExp(`a: candidate #${carry.seq} carried by plan #${planEntry.seq} from submit #${sub.seq}`));
    // The candidate stays the writer's own: its writer still cannot review it.
    await assert.rejects(ops.review({ cwd: r.cwd, node: 'a', as: { role: 'reviewer', id: 'a#1' }, verdict: 'ok', rank: 1, note: 'self' }), /writer/);
    const measured = await ops.attest({ cwd: r.cwd, node: 'a' });
    assert.ok(measured.observations.some(e => e.kind === 'obs' && e.obligation === 'check:a' && e.key === carry.facts.keys['check:a'] && e.verdict === 'pass'));
    assert.ok(!measured.observations.some(e => e.kind === 'obs' && e.obligation === 'writes'), 'writes is not measured again');
    card = await ops.why({ cwd: r.cwd, node: 'a' });
    assert.equal(card.accepted, true, JSON.stringify(card.items.map(i => [i.obligation, i.status])));
    assert.equal((await ops.verify({ cwd: r.cwd })).ok, true);
  } finally { await r.cleanup(); }
});

test('N1: a writes-only widening carries the candidate and re-measures writes', { timeout: 120_000 }, async () => {
  const { r, sub } = await submitted();
  try {
    await ops.attest({ cwd: r.cwd, node: 'a' });
    const next = base(); next.nodes[0].writes = ['test/a', 'docs/'];
    const p = await ops.planSet({ cwd: r.cwd, plan: JSON.stringify(next), as: owner, channel: 'delegated', note: 'widen' });
    const carried = await ops.carriedBy({ cwd: r.cwd, plan: p.seq });
    assert.equal(carried.length, 1);
    const c = carried[0]!;
    assert.equal(c.carry, sub.seq); assert.equal(c.facts.commit, sub.facts.commit);
    assert.notEqual(c.facts.keys.writes, sub.facts.keys.writes);
    assert.equal(c.facts.keys['check:a'], sub.facts.keys['check:a'], 'check key unchanged');
    let card = await ops.why({ cwd: r.cwd, node: 'a' });
    assert.equal(item(card, 'writes').status, 'D');
    assert.equal(item(card, 'check:a').status, 'E', 'the measured check still counts');
    const measured = await ops.attest({ cwd: r.cwd, node: 'a' });
    assert.deepEqual(measured.observations.map(e => e.kind === 'obs' ? e.obligation : e.kind), ['writes']);
    card = await ops.why({ cwd: r.cwd, node: 'a' });
    assert.equal(item(card, 'writes').status, 'E');
  } finally { await r.cleanup(); }
});

test('N1: a brief change does not carry; the candidate stays invalidated', { timeout: 60_000 }, async () => {
  const { r } = await submitted();
  try {
    const next = base(); next.nodes[0].brief = 'new brief';
    const p = await ops.planSet({ cwd: r.cwd, plan: JSON.stringify(next), as: parent });
    assert.deepEqual(await ops.carriedBy({ cwd: r.cwd, plan: p.seq }), []);
    assert.equal((await ops.status({ cwd: r.cwd })).nodes.a!.candidate, undefined);
    assert.equal((await entriesOf(r.cwd)).at(-1)!.seq, p.seq, 'nothing after the plan entry');
  } finally { await r.cleanup(); }
});

test('N1: a deps change does not carry, even with a check change', { timeout: 60_000 }, async () => {
  const { r } = await submitted();
  try {
    const next = base();
    next.nodes.push({ id: 'c', writes: ['docs/'], checks: [] });
    next.nodes[0].deps = ['c'];
    next.nodes[0].checks[0].min_tests = 2;
    const p = await ops.planSet({ cwd: r.cwd, plan: JSON.stringify(next), as: parent });
    assert.deepEqual(await ops.carriedBy({ cwd: r.cwd, plan: p.seq }), []);
    assert.equal((await ops.status({ cwd: r.cwd })).nodes.a!.candidate, undefined);
  } finally { await r.cleanup(); }
});

// ---------- synthetic ledger (no git): validation, driver row 8 and replay ----------
const P = 'hash0', W = runId(P, 'a', 1, 'writer');
const spec = (o: Partial<NodeSpec> & { id: string }): NodeSpec => ({ deps: [], writes: [`${o.id}/`], checks: [], review: { count: 0, min_rank: 1 }, ...o });
const plan0 = (): Plan => ({ version: 1, trunk: 'main', closure: [], invariants: [], nodes: [spec({ id: 'a', brief: 'Do A.', checks: [{ id: 'unit', run: 'npm test', timeout_s: 60, reads: ['a/**'] }] })],
  drive: { max: 4, repairs: 2, writer: { agent: 'worker' }, reviewer: { agent: 'reviewer' } } });
function rig() {
  const entries: Entry[] = [], plans: Record<string, Plan> = { p0: plan0() };
  let current = 'p0', n = 0;
  const state = (): State => reduce(entries, sha => plans[sha]!);
  const add = (d: Draft): Entry => { const seq = entries.length, e = { ...d, seq, ts: new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString(), prev: 'x', hash: `hash${seq}` } as Entry; entries.push(e); state(); return e; };
  add({ kind: 'genesis', by: 'owner:human', channel: 'tty', plan: 'p0', trunk: 'main', commit: 's0', state: { commit: 's0', tree: 't0', invKeys: {} } });
  const facts = (tag: string, base = state().nodes.a!.slot!.base): CandidateFacts => ({ commit: `c${tag}`, tree: `t${tag}`, base, patch: `p${tag}`, changed: ['a/x'], closureTouched: false, keys: { 'check:unit': `k${tag}`, writes: `w${tag}`, rulings: 'r' } });
  return {
    entries, state, add, facts,
    dispatch: () => add({ kind: 'dispatch', by: 'parent:drive', node: 'a', attempt: 1, base: 's0', branch: 'owed/a/1', worktree: '/repo/.owed/wt/a-1', packet: 'blob', rulings_seen: -1 }),
    launch: () => { const a = writerLaunch(state(), 'a', P); return add({ kind: 'launch', by: 'parent:drive', node: 'a', attempt: 1, role: 'writer', rid: a.rid, spec: sha256(a.spec), labels: a.labels }); },
    submit: (tag: string) => add({ kind: 'submit', by: 'writer:a#1', node: 'a', attempt: 1, facts: facts(tag) }) as Extract<Entry, { kind: 'submit' }>,
    replan: (edit: (p: Plan) => void) => { const next = structuredClone(plans[current]!); edit(next); const sha = `p${++n}`; plans[sha] = next; const e = add({ kind: 'plan', by: 'owner:human', channel: 'tty', prior: current, plan: sha, downgrades: [] }); current = sha; return e; },
  };
}
const carryDraft = (commit: string, base: string, carry: number | undefined, by = 'executor:owed'): Draft => ({ kind: 'submit', by, node: 'a', attempt: 1, facts: { commit, tree: 't', base, patch: 'p', changed: ['a/x'], closureTouched: false, keys: { 'check:unit': 'k-new', writes: 'w', rulings: 'r' } }, ...(carry !== undefined ? { carry } : {}) });

test('N1.2: validation of carry submits', () => {
  const r = rig(); r.dispatch();
  const first = r.submit('1'), second = r.submit('2');
  // An existing candidate: no carry.
  assert.match(validateDraft(r.state(), carryDraft('c2', 's0', second.seq)).join('; '), /no current candidate/);
  r.replan(p => { p.nodes[0]!.checks[0]!.run = 'npm test -- --x'; });
  assert.equal(r.state().nodes.a!.candidate, undefined);
  assert.deepEqual(validateDraft(r.state(), carryDraft('c2', 's0', second.seq)), [], 'the valid carry');
  assert.match(validateDraft(r.state(), carryDraft('c1', 's0', second.seq)).join('; '), /commit of submit/);
  assert.match(validateDraft(r.state(), carryDraft('c2', 's9', second.seq)).join('; '), /base of submit/);
  assert.match(validateDraft(r.state(), carryDraft('c1', 's0', first.seq)).join('; '), /latest submit of the open attempt/);
  assert.match(validateDraft(r.state(), carryDraft('c2', 's0', undefined)).join('; '), /must carry a submit/);
  assert.match(validateDraft(r.state(), carryDraft('c2', 's0', second.seq, 'writer:a#1')).join('; '), /a writer submit never has carry/);
  assert.match(validateDraft(r.state(), carryDraft('c2', 's0', second.seq, 'parent:x')).join('; '), /slot writer/);
  // A rebase since the carried submit: the slot base moved.
  r.add({ kind: 'adopt', by: 'owner:human', channel: 'tty', trunk: 'main', prior: 's0', commit: 's1', state: { commit: 's1', tree: 't1', invKeys: {} }, changed: ['x'], commits: 1, note: 'moved' });
  r.add({ kind: 'rebase', by: 'parent:drive', node: 'a', attempt: 1, base: 's1', from: 's0' });
  assert.match(validateDraft(r.state(), carryDraft('c2', 's0', second.seq)).join('; '), /slot base moved/);
});

const view = (rid: string, state: RunView['state'], extra: Partial<RunView> = {}): [string, RunView] => [rid, { rid, state, ...extra }];
const optsOf = (o: Partial<DriveOpts> = {}): DriveOpts => ({ max: 4, repairs: 2, project: P, root: '/repo', applied: new Set(), rejected: new Map(), blobs: new Map(), ...o });
const act = (s: State, runs: Map<string, RunView>): Action | undefined => decide(s, s.plan, runs, optsOf()).find(x => x.node === 'a');

test('N1.4: row 8 after a rebased and submitted slot is invalidated by a brief change: submit naming the plan, not rebase (wais #1373/#1375)', () => {
  const r = rig(); r.dispatch(); r.launch(); r.submit('1');
  // Trunk moves; the slot is rebased; the writer rebases and submits (wais: the writer's own rebase and submit).
  r.add({ kind: 'adopt', by: 'owner:human', channel: 'tty', trunk: 'main', prior: 's0', commit: 's1', state: { commit: 's1', tree: 't1', invKeys: {} }, changed: ['x'], commits: 1, note: 'moved' });
  r.add({ kind: 'rebase', by: 'writer:a#1', node: 'a', attempt: 1, base: 's1', from: 's0' });
  r.submit('2');
  const p = r.replan(x => { x.nodes[0]!.brief = 'Do A better.'; });
  const s = r.state();
  assert.equal(s.nodes.a!.candidate, undefined);
  const runs = new Map([view(W, 'sealed', { status: 'ok' })]);
  const a = act(s, runs);
  assert.ok(a?.do === 'send' && a.sendKind === 'follow-up', JSON.stringify(a));
  if (a?.do !== 'send') throw Error('send');
  assert.equal(a.reason, 'submit');
  assert.equal(a.message, planChangedMessage('a', p.seq, ['brief']));
  assert.equal(a.message, `plan #${p.seq} changed this node's spec (brief); resubmit (re-run checks if needed, then \`owed submit a\`)`);
  assert.notEqual(a.message, rebaseMessage(s, 'a'));
  // A rebase with no submit after it still gets the rebase follow-up first.
  r.add({ kind: 'adopt', by: 'owner:human', channel: 'tty', trunk: 'main', prior: 's1', commit: 's2', state: { commit: 's2', tree: 't2', invKeys: {} }, changed: ['x'], commits: 1, note: 'moved' });
  r.add({ kind: 'rebase', by: 'parent:drive', node: 'a', attempt: 1, base: 's2', from: 's1' });
  const b = act(r.state(), runs);
  assert.ok(b?.do === 'send' && b.reason === 'rebase', JSON.stringify(b));
});

test('N1.6: replay of an existing ledger is unchanged: a plan entry alone never carries; a writer resubmit sets the candidate', () => {
  const r = rig(); r.dispatch(); r.launch();
  const first = r.submit('1');
  r.replan(p => { p.nodes[0]!.checks[0]!.run = 'npm test -- --x'; });
  let s = r.state();
  assert.equal(s.nodes.a!.candidate, undefined, 'replay does not invent a carry');
  const again = r.add({ kind: 'submit', by: 'writer:a#1', node: 'a', attempt: 1, facts: { ...first.facts, keys: { ...first.facts.keys, 'check:unit': 'k1b' } } });
  s = r.state();
  assert.equal(s.nodes.a!.candidate!.seq, again.seq);
  assert.equal(s.nodes.a!.candidate!.carried, undefined);
  assert.equal(receipt(s, r.entries, 'a').carried, undefined);
  assert.equal(statusView(s, r.entries).carried, undefined);
  // A carry submit replays to a carried candidate naming the plan entry.
  const p = r.replan(x => { x.nodes[0]!.checks[0]!.timeout_s = 61; });
  const carry = r.add(carryDraft(again.kind === 'submit' ? again.facts.commit : '', 's0', again.seq));
  assert.deepEqual(r.state().nodes.a!.candidate!.carried, { plan: p.seq, submit: again.seq });
  assert.equal(r.state().nodes.a!.candidate!.seq, carry.seq);
});
