// KR1–KR4: bounded, owner-recorded invariant debt with a fixing-node merge gate.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as reducer from '../src/reducer.ts';
import * as ops from '../src/ops.ts';
import * as views from '../src/views.ts';
import { parsePlan, planDowngrades } from '../src/plan.ts';
import { editText } from '../src/edit.ts';
import { candidateFacts, stateFacts } from '../src/git.ts';
import { Ledger } from '../src/ledger.ts';
import { canonical, sha256 } from '../src/canon.ts';
import type { CandidateFacts, Draft, Entry, KnownRed, ObsEntry, Plan, StateFacts } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const owner = { role: 'owner', id: 'pi' } as const, parent = { role: 'parent', id: 'test' } as const;
const rawPlan = (known_red?: unknown) => ({ version: 1, trunk: 'main', closure: [],
  invariants: [{ id: 'unit', run: 'suite', timeout_s: 10, reads: ['src/**'], min_tests: 1, ...(known_red === undefined ? {} : { known_red }) }],
  nodes: ['fix', 'other'].map(id => ({ id, writes: ['src/'] })) });
const plan = (entries: KnownRed[] = [{ test: 'old failure', fix: 'fix' }]) => parsePlan(JSON.stringify(rawPlan(entries)));
const sf = (commit = 's0', key = 'inv0'): StateFacts => ({ commit, tree: `tree-${commit}`, invKeys: { unit: key } });
const facts = (node: string, commit = 'c1'): CandidateFacts => ({ commit, tree: `tree-${commit}`, base: 's0', patch: node,
  changed: ['src/x'], closureTouched: false, keys: { writes: `writes-${node}`, rulings: `rules-${node}` } });
const failFields = (names = ['old failure']): Partial<ObsEntry> => ({ verdict: 'fail', exit: 1, failed: names,
  counts: { tests: names.length, pass: 0, fail: names.length, format: 'tap' }, execution: { completed: true, countOK: true }, note: `failed tests: ${names.join(', ')}; last output:\n  not ok` });
function rig(p = plan()) {
  const entries: Entry[] = [], plans: Record<string, Plan> = { p };
  const state = () => reducer.reduce(entries, sha => { const p = plans[sha]; if (!p) throw Error('missing plan'); return p; });
  const add = (draft: Draft) => { const seq = entries.length; entries.push({ ...draft, seq, ts: '2026-10-12T00:00:00Z', prev: 'x', hash: `hash-${seq}` } as Entry); return seq; };
  add({ kind: 'genesis', by: 'owner:pi', channel: 'delegated', plan: 'p', trunk: 'main', commit: 's0', state: sf() });
  const obs = (key = 'inv0', extra: Partial<ObsEntry> = {}) => add({ kind: 'obs', by: 'executor:owed', subject: 'trunk',
    obligation: 'inv:unit', key, verdict: 'pass', exit: 0, durationMs: 1, commit: key === 'inv0' ? 's0' : 'cm', ...extra });
  const open = (node = 'other') => {
    add({ kind: 'dispatch', by: 'parent:test', node, attempt: 1, base: 's0', branch: `branch-${node}`, worktree: `wt-${node}`, packet: 'packet', rulings_seen: -1 });
    add({ kind: 'submit', by: `writer:${node}#1`, node, attempt: 1, facts: facts(node) });
    add({ kind: 'obs', by: 'executor:owed', subject: node, obligation: 'writes', key: `writes-${node}`, verdict: 'pass', exit: 0, durationMs: 1, commit: 'c1' });
    return { facts: facts(node, 'cm'), state: sf('cm', 'invM') };
  };
  return { entries, plans, state, add, obs, open };
}

test('KR1: exact names validate; unknown fix, duplicates, more than 20 and malformed entries refuse', () => {
  const exact = ' suite > case = spaced ';
  assert.deepEqual(plan([{ test: exact, fix: 'fix' }]).invariants[0]!.known_red, [{ test: exact, fix: 'fix' }]);
  assert.throws(() => plan([{ test: 'x', fix: 'missing' }]), /known_red fix missing.*not a node/);
  assert.throws(() => plan([{ test: 'x', fix: 'fix' }, { test: 'x', fix: 'other' }]), /duplicate known_red test/);
  assert.throws(() => plan(Array.from({ length: 21 }, (_, i) => ({ test: `test-${i}`, fix: 'fix' }))), /at most 20/);
  for (const value of [null, {}, [null], [{ test: '', fix: 'fix' }], [{ test: 'x', fix: '' }], [{ test: 'x', fix: 'fix', extra: true }]]) {
    assert.throws(() => parsePlan(JSON.stringify(rawPlan(value))), /known_red/);
  }
  const nodeList = rawPlan(); Object.assign(nodeList.nodes[0]!, { checks: [{ id: 'check', run: 'true', known_red: [{ test: 'x', fix: 'fix' }] }] });
  assert.throws(() => parsePlan(JSON.stringify(nodeList)), /only supported on invariants/);
});

test('KR1: additions and fix changes downgrade, removal does not; allowances never cover it (#1484)', () => {
  const before = parsePlan(JSON.stringify(rawPlan())), next = plan();
  assert.match(planDowngrades(before, next)[0]!.what, /known_red.*added.*fix.*owner only/);
  assert.match(planDowngrades(next, plan([{ test: 'old failure', fix: 'other' }]))[0]!.what, /fix changed from fix to other/);
  assert.deepEqual(planDowngrades(next, before), []);
  before.allow = [{ nodes: ['*'], checks: ['*'] }]; next.allow = before.allow;
  assert.equal(reducer.uncoveredDowngrades(before, next).length, 1);
  const r = rig(before); r.plans.next = next;
  assert.match(reducer.validateDraft(r.state(), { kind: 'plan', by: 'parent:test', prior: 'p', plan: 'next', downgrades: [] }).join(), /Only owner.*known_red/);
  r.add({ kind: 'plan', by: 'owner:pi', channel: 'delegated', prior: 'p', plan: 'next', downgrades: planDowngrades(before, next), note: 'Assign bounded existing failures to fix' });
  assert.equal(r.state().downgrades[0]!.items.filter(d => d.what.includes('known_red')).length, 1);
});

test('KR2: only listed failures become W with exact detail and observation + plan evidence', () => {
  const r = rig(); const seq = r.obs('inv0', failFields());
  const item = r.state().invariants[0]!;
  assert.equal(item.status, 'W'); assert.equal(item.mark, '⚠'); assert.equal(item.discharger, undefined);
  assert.equal(item.detail, 'inv:unit known red: old failure (fix: fix; plan #0)');
  assert.deepEqual(item.evidence, [seq, 0]);
  const m = r.open(); r.obs('invM', failFields());
  assert.equal(reducer.mergeGuard(r.state(), 'other', m).ok, true);
  const extra = rig(); extra.obs('inv0', failFields(['old failure', 'new failure']));
  assert.equal(extra.state().invariants[0]!.status, 'D');
  const different = rig(); different.obs('inv0', failFields(['Old failure']));
  assert.equal(different.state().invariants[0]!.status, 'D');
});

test('KR2: missing names, timeout, error, zero tests, count/min_tests failures and repeat errors stay D', () => {
  const variants: Partial<ObsEntry>[] = [
    { failed: [] }, { failed: undefined }, { exit: null, note: 'timeout after 10s' }, { verdict: 'error' },
    { counts: { tests: 0, fail: 0 } }, { counts: { tests: 1, pass: 1, fail: 0 } },
    { execution: { completed: true, countOK: false }, note: 'failed tests: old failure; min_tests unmet: counted 1 < min_tests 2; last output:\n  fail' },
    { runs: [{ verdict: 'error', exit: null, durationMs: 1, log: 'x', note: 'spawn failed' }] },
  ];
  for (const fields of variants) {
    const r = rig(); r.obs('inv0', { ...failFields(), ...fields });
    assert.equal(r.state().invariants[0]!.status, 'D', JSON.stringify(fields));
  }
  const conflict = rig(); conflict.obs(); conflict.obs('inv0', failFields());
  assert.equal(conflict.state().invariants[0]!.mark, '⊤');
});

test('KR2: failure-name strings are not treated as count/timeout diagnostics; multiple fix owners are visible', () => {
  const names = ['timeout test', 'count guard', 'min_tests label'];
  const r = rig(plan(names.map((test, i) => ({ test, fix: i % 2 ? 'other' : 'fix' }))));
  r.obs('inv0', failFields(names));
  assert.equal(r.state().invariants[0]!.status, 'W');
  assert.match(r.state().invariants[0]!.detail, /fix: fix, other; plan #0/);
  const s = r.state();
  assert.deepEqual(reducer.activeKnownRed(s, 'unit', 'fix').map(e => e.test), ['count guard']);
  assert.deepEqual(reducer.fixOwnedKnownRed(s, 'unit', 'fix'), ['timeout test', 'min_tests label']);
});

test('KR3: fix merge refuses its own still-failing names, including unchanged keys and owner defer', () => {
  for (const key of ['invM', 'inv0']) {
    const r = rig(); r.obs('inv0', failFields()); const m = r.open('fix'); m.state.invKeys.unit = key;
    if (key !== 'inv0') r.obs(key, failFields());
    r.add({ kind: 'defer', by: 'owner:pi', node: 'fix', items: [{ id: 'unit', key }], reason: 'Not a fix for owned debt' });
    const g = reducer.mergeGuard(r.state(), 'fix', m);
    assert.equal(g.ok, false);
    assert.ok(g.reasons.includes('fix is the fix node of known-red old failure on inv:unit, which still fail on the merge result'));
    assert.equal(g.invItems[0]!.status, 'D');
  }
});

test('KR3/IR2 (#1485): fix-owned trunk names cannot be inherited; another fix owner preserves inheritance', () => {
  for (const fix of ['fix', 'other']) {
    const r = rig(plan([{ test: 'old failure', fix }]));
    // Keep an unlisted old failure so PRE is ordinary red and the IR2 path is exercised, not KR's W fast path.
    const names = ['old failure', 'unlisted inherited'];
    r.obs('inv0', failFields(names)); const m = r.open('fix');
    r.obs('invM', { ...failFields(names), merging: 'fix' });
    const s = r.state(), comparison = reducer.invariantTrunkComparison(s, 'fix', s.plan.invariants[0]!, 'invM', 'cm');
    assert.equal(s.invariants[0]!.mark, '✘');
    assert.deepEqual(comparison.trunkNames, fix === 'fix' ? ['unlisted inherited'] : names);
    assert.deepEqual(comparison.newNames, fix === 'fix' ? ['old failure'] : []);
    assert.equal(comparison.inherited, fix !== 'fix');
    const guard = reducer.mergeGuard(s, 'fix', m);
    assert.equal(guard.ok, fix !== 'fix');
    if (fix === 'fix') assert.match(guard.reasons.join('; '), /fix is the fix node of known-red old failure.*still fail/);
    else assert.match(guard.invItems[0]!.detail, /trunk-red: inv:unit already failed on trunk before fix/);
  }
});

test('KR3: a fixed merge succeeds, exemptions lapse, and later recurrence is ordinary red', () => {
  const r = rig(); r.obs('inv0', failFields()); const m = r.open('fix'); r.obs('invM');
  assert.equal(reducer.mergeGuard(r.state(), 'fix', m).ok, true);
  r.add({ kind: 'merge', by: 'executor:owed', node: 'fix', attempt: 1, prior: 's0', commit: 'cm', ...m });
  const s = r.state(); assert.equal(s.invariants[0]!.status, 'E');
  assert.deepEqual(reducer.activeKnownRed(s, 'unit'), []);
  const debt = views.statusView(s, r.entries);
  assert.equal(debt.knownRed, undefined); assert.equal(debt.lapsedKnownRed?.[0]!.entries[0]!.test, 'old failure');
  assert.match(views.renderStatus(debt, { full: true }), /lapsed known_red:.*removable: owed edit --invariant unit/);
  r.obs('invLater', failFields());
  // An adopted later trunk retains the ordinary 0.14 adoption rule (red may be inherited only from red trunk).
  const future = sf('later', 'invLater');
  assert.equal(reducer.adoptGuard(r.state(), future).ok, false);
  assert.equal(reducer.adoptGuard(r.state(), future).invItems[0]!.status, 'D');
});

test('KR4: active debt is listed even with a passing observation, one line per invariant', () => {
  const r = rig(plan([{ test: 'old failure', fix: 'fix' }, { test: 'another', fix: 'other' }])); r.obs();
  const s = r.state(), status = views.statusView(s, r.entries), brief = views.briefView(s, r.entries);
  assert.deepEqual(status.knownRed, [{ invariant: 'unit', entries: s.plan.invariants[0]!.known_red, plan: 0 }]);
  for (const text of [views.renderStatus(status), views.renderBrief(brief)]) {
    assert.match(text, /inv:unit known red: old failure \(fix: fix\), another \(fix: other\); plan #0/);
    assert.equal(text.split('\n').filter(l => l.includes('inv:unit known red:')).length, 1);
  }
});

test('KR1: invariant edit keeps exact names and comments; node check edit cannot set known_red', () => {
  const text = '# top\nversion: 1\ntrunk: main\ninvariants:\n  - id: unit # keep\n    run: suite\nnodes:\n  - id: fix # untouched\n';
  const updated = editText(text, { invariant: 'unit', set: ['known_red=[{test: "case = x", fix: fix}]'] });
  assert.deepEqual(parsePlan(updated).invariants[0]!.known_red, [{ test: 'case = x', fix: 'fix' }]);
  assert.match(updated, /# keep/); assert.equal(updated.slice(updated.indexOf('nodes:')), text.slice(text.indexOf('nodes:')));
  assert.equal(parsePlan(editText(updated, { invariant: 'unit', unset: ['known_red'] })).invariants[0]!.known_red, undefined);
  assert.throws(() => editText(text, { node: 'fix', set: ['checks.x.known_red=[]'] }), /Invalid node edit path/);
});

test('KR1: known_red changes no invariant or candidate key', async () => {
  const r = await repo();
  try {
    await r.put('src/x', 'x'); const commit = await r.commit();
    const a = parsePlan(JSON.stringify(rawPlan())), b = plan();
    assert.deepEqual(await stateFacts(r.cwd, a, commit), await stateFacts(r.cwd, b, commit));
    assert.deepEqual(await candidateFacts(r.cwd, a, a.nodes[0]!, commit, commit, 1), await candidateFacts(r.cwd, b, b.nodes[0]!, commit, commit, 1));
  } finally { await r.cleanup(); }
});

test('KR replay: no new list preserves 0.14 items/keys/views and incremental replay; removing list restores ordinary red', () => {
  const p = parsePlan(JSON.stringify(rawPlan())), r = rig(p); r.obs('inv0', failFields());
  const s = r.state();
  assert.equal(s.invariants[0]!.status, 'D'); assert.equal(s.invariants[0]!.detail, 'inv:unit current content failed');
  assert.equal(s.invariants[0]!.key, 'inv0'); assert.equal(views.statusView(s, r.entries).knownRed, undefined);
  const initial = reducer.reduce(r.entries.slice(0, 1), () => p);
  assert.equal(reducer.sameReplay(s, reducer.reduceFrom(initial, r.entries.slice(1), () => p)), true);
  const next = plan(); r.plans.next = next;
  r.add({ kind: 'plan', by: 'owner:pi', channel: 'delegated', prior: 'p', plan: 'next', downgrades: planDowngrades(p, next), note: 'Assign exact old failure to fix' });
  assert.equal(r.state().invariants[0]!.status, 'W'); assert.match(r.state().invariants[0]!.detail, /plan #2/);
  r.add({ kind: 'plan', by: 'parent:test', prior: 'next', plan: 'p', downgrades: [] });
  assert.equal(r.state().invariants[0]!.status, 'D');
});

test('KR CLI/ledger: owner edit records downgrade atomically; refusal preserves file/ledger; report and brief expose debt', async () => {
  const r = await repo();
  try {
    await r.put('src/x', 'x'); await r.commit();
    const text = JSON.stringify(rawPlan()), file = join(r.root, 'plan.yaml'); await writeFile(file, text);
    await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: text, measure: false });
    await ops.planSet({ cwd: r.cwd, as: parent, ...await ops.readPlan({ cwd: r.cwd, path: file }) });
    const before = await (await Ledger.open(r.cwd)).read();
    const args = ['edit', '--invariant', 'unit', '--set', 'known_red=[{test: "old failure", fix: fix}]', '--note', 'Track trunk debt'];
    const refused = await cli(r.cwd, args); assert.equal(refused.code, 1); assert.match(refused.stderr, /Only owner.*known_red/);
    assert.equal(await readFile(file, 'utf8'), text); assert.equal((await (await Ledger.open(r.cwd)).read()).length, before.length);
    const ok = await cli(r.cwd, [...args, '--as', 'owner:pi']); assert.equal(ok.code, 0, ok.stderr);
    const es = await (await Ledger.open(r.cwd)).read(), law = es.at(-1)!;
    assert.equal(law.kind, 'plan'); if (law.kind !== 'plan') throw Error('plan expected');
    assert.equal(law.downgrades.length, 1); assert.match(law.downgrades[0]!.what, /known_red/);
    assert.equal(law.by, 'owner:pi'); assert.equal(law.channel, 'delegated');
    for (const cmd of ['status', 'report', 'brief']) {
      const result = await cli(r.cwd, [cmd]); assert.equal(result.code, 0, result.stderr);
      assert.match(result.stdout, new RegExp(`old failure \\(fix: fix\\).*plan #${law.seq}`));
    }
    assert.equal((await ops.report({ cwd: r.cwd, since: law.seq })).knownRed?.[0]!.plan, law.seq);
    assert.equal((await ops.verify({ cwd: r.cwd })).ok, true);
  } finally { await r.cleanup(); }
});

test('review #1516: invariant receipt accepts active W and fixed E, but rejects lapsed/missing-fix D', async () => {
  const r = await repo();
  try {
    await r.put('src/x', 'x'); await r.commit();
    await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify(rawPlan([{ test: 'old failure', fix: 'fix' }])), measure: false });
    const ledger = await Ledger.open(r.cwd), initial = (await ops.readState({ cwd: r.cwd })).state;
    const key = initial.trunk.invKeys.unit!;
    const append = (drafts: Draft[]) => ledger.withLock(() => ledger.append(drafts));
    await append([{ kind: 'obs', by: 'executor:owed', subject: 'trunk', obligation: 'inv:unit', key,
      verdict: 'fail', exit: 1, durationMs: 1, commit: initial.trunk.commit, ...failFields() }]);
    for (const node of ['unit', 'inv:unit']) {
      const card = await ops.why({ cwd: r.cwd, node });
      assert.equal(card.items[0]!.status, 'W'); assert.equal(card.accepted, true, `${node}: active known red is accepted`);
      const json = await cli(r.cwd, ['why', node, '--json']);
      assert.equal(json.code, 0, json.stderr); assert.equal(JSON.parse(json.stdout).accepted, true);
    }
    const d = await ops.dispatch({ cwd: r.cwd, node: 'fix', as: parent });
    await commitAt(d.worktree, { 'src/x': 'fixed' });
    await ops.submit({ cwd: d.worktree, node: 'fix', as: { role: 'writer', id: 'fix#1' } });
    const current = (await ops.readState({ cwd: r.cwd })).state, candidate = current.nodes.fix!.candidate!;
    const fixed = await stateFacts(r.cwd, current.plan, candidate.commit);
    await append([
      { kind: 'obs', by: 'executor:owed', subject: 'fix', obligation: 'writes', key: candidate.keys.writes!, verdict: 'pass', exit: 0, durationMs: 1, commit: candidate.commit },
      { kind: 'obs', by: 'executor:owed', subject: 'trunk', obligation: 'inv:unit', key: fixed.invKeys.unit!, verdict: 'pass', exit: 0, durationMs: 1, commit: fixed.commit },
      { kind: 'merge', by: 'executor:owed', node: 'fix', attempt: 1, prior: current.trunk.commit, commit: fixed.commit, facts: candidate, state: fixed },
    ]);
    let card = await ops.why({ cwd: r.cwd, node: 'inv:unit' });
    assert.equal(card.items[0]!.status, 'E'); assert.equal(card.accepted, true);
    assert.deepEqual(reducer.activeKnownRed((await ops.readState({ cwd: r.cwd })).state, 'unit'), []);
    await append([{ kind: 'obs', by: 'executor:owed', subject: 'trunk', obligation: 'inv:unit', key: fixed.invKeys.unit!,
      verdict: 'fail', exit: 1, durationMs: 1, commit: fixed.commit, ...failFields() }]);
    card = await ops.why({ cwd: r.cwd, node: 'unit' });
    assert.equal(card.items[0]!.status, 'D'); assert.equal(card.accepted, false, 'lapsed list cannot accept a recurrence');
    // A legal plan removal drops its owned entries too: the parser refuses dangling fix references.
    const missing = rawPlan(); missing.nodes = missing.nodes.filter(n => n.id !== 'fix');
    await ops.planSet({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify(missing), note: 'Remove retired fix and its lapsed debt list' });
    assert.equal((await ops.readState({ cwd: r.cwd })).state.plan.nodes.some(n => n.id === 'fix'), false);
    card = await ops.why({ cwd: r.cwd, node: 'inv:unit' });
    assert.equal(card.items[0]!.status, 'D'); assert.equal(card.accepted, false, 'missing fix cannot accept debt');
  } finally { await r.cleanup(); }
});

test('review #1516: adoption treats W as satisfied on both trunk and adopted keys', () => {
  for (const prior of ['E', 'W', 'D'] as const) for (const next of ['E', 'W', 'D'] as const) {
    const r = rig();
    r.obs('inv0', prior === 'E' ? {} : failFields(prior === 'W' ? ['old failure'] : ['unlisted']));
    r.obs('invAdopt', next === 'E' ? {} : failFields(next === 'W' ? ['old failure'] : ['unlisted']));
    const guard = reducer.adoptGuard(r.state(), sf('adopted', 'invAdopt'));
    assert.equal(guard.invItems[0]!.status, next);
    assert.equal(guard.ok, prior === 'D' || next !== 'D', `${prior} -> ${next}`);
    assert.deepEqual(guard.failed, prior !== 'D' && next === 'D' ? ['unit'] : []);
  }
});

function decoyRig(node = 'other') {
  const r = rig(), payload = { nonce: 'knownred-decoy-regression', decoys: [{ node, defect: 'new invariant failure' }] };
  r.add({ kind: 'decoy-commit', by: 'owner:pi', digest: sha256(canonical(payload)) });
  r.obs('inv0', failFields()); r.open(node);
  return { ...r, reveal: () => r.add({ kind: 'decoy-reveal', by: 'owner:pi', ...payload }) };
}

test('review #1516: decoy PRE=W -> D is caught, including late reveal and fix-owned merge failure', () => {
  for (const late of [false, true]) for (const node of ['other', 'fix']) {
    const r = decoyRig(node);
    if (!late) r.reveal();
    const caught = r.obs('invM', { ...failFields(node === 'fix' ? ['old failure'] : ['old failure', 'new failure']), merging: node });
    if (late) r.reveal();
    assert.deepEqual(r.state().decoys.map(d => [d.outcome, d.decidedBy]), [['caught', caught]], `${node}, late=${late}`);
    const initial = reducer.reduce(r.entries.slice(0, 1), () => plan());
    assert.equal(reducer.sameReplay(r.state(), reducer.reduceFrom(initial, r.entries.slice(1), () => plan())), true);
  }
});

test('review #1516: decoy PRE=W -> W is not caught and escapes on merge', () => {
  for (const late of [false, true]) {
    const r = decoyRig();
    if (!late) r.reveal();
    r.obs('invM', { ...failFields(), merging: 'other' });
    if (late) r.reveal();
    assert.equal(r.state().decoys[0]!.outcome, 'pending');
    const merged = r.add({ kind: 'merge', by: 'executor:owed', node: 'other', attempt: 1, prior: 's0', commit: 'cm', facts: facts('other', 'cm'), state: sf('cm', 'invM') });
    assert.deepEqual(r.state().decoys.map(d => [d.outcome, d.decidedBy]), [['escaped', merged]]);
  }
});

test('KR integration: unrelated merge accepts listed failure; fix merge refuses then passes; lapse survives replay', async () => {
  const r = await repo();
  try {
    const text = JSON.stringify({ ...rawPlan([{ test: 'old failure', fix: 'fix' }]), lease: false,
      invariants: [{ ...rawPlan().invariants[0], run: 'node --test --test-reporter=tap test/suite.cjs', reads: ['src/**', 'test/**'], known_red: [{ test: 'old failure', fix: 'fix' }] }] });
    await r.put('src/state.cjs', 'module.exports=0;');
    await r.put('test/suite.cjs', "const {test}=require('node:test'); const a=require('node:assert/strict'); test('old failure',()=>a.equal(require('../src/state.cjs'),1));\n");
    await r.commit(); await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: text, lease: false });
    const d = await ops.dispatch({ cwd: r.cwd, node: 'other', as: parent });
    await commitAt(d.worktree, { 'src/unrelated': 'other' });
    await ops.submit({ cwd: d.worktree, node: 'other', as: { role: 'writer', id: 'other#1' } });
    await ops.attest({ cwd: r.cwd, node: 'other', lease: false });
    await ops.merge({ cwd: r.cwd, node: 'other', as: parent, lease: false });
    assert.equal((await ops.readState({ cwd: r.cwd })).state.invariants[0]!.status, 'W');
    const fix = await ops.dispatch({ cwd: r.cwd, node: 'fix', as: parent });
    await commitAt(fix.worktree, { 'src/fix-note': 'still failing' });
    await ops.submit({ cwd: fix.worktree, node: 'fix', as: { role: 'writer', id: 'fix#1' } });
    await ops.attest({ cwd: r.cwd, node: 'fix', lease: false });
    await assert.rejects(ops.merge({ cwd: r.cwd, node: 'fix', as: parent, lease: false }), /fix is the fix node of known-red old failure.*still fail/);
    await commitAt(fix.worktree, { 'src/state.cjs': 'module.exports=1;' });
    await ops.submit({ cwd: fix.worktree, node: 'fix', as: { role: 'writer', id: 'fix#1' } });
    await ops.attest({ cwd: r.cwd, node: 'fix', lease: false });
    await ops.merge({ cwd: r.cwd, node: 'fix', as: parent, lease: false });
    ops.forgetReplays();
    const s = await ops.status({ cwd: r.cwd });
    assert.equal(s.knownRed, undefined); assert.equal(s.lapsedKnownRed?.[0]!.entries[0]!.fix, 'fix');
    assert.equal(s.invariants[0]!.status, 'E'); assert.equal((await ops.verify({ cwd: r.cwd })).ok, true);
  } finally { await r.cleanup(); }
});
