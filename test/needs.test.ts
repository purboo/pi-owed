import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from '../src/canon.ts';
import { clockTime } from '../src/clock.ts';
import { reduce, entriesOf, runId, runLabels, manualKeys } from '../src/reducer.ts';
import { statusView, writerDecisionCommand } from '../src/views.ts';
import { parsePlan } from '../src/plan.ts';
import type { ItemView, NodeState, Plan } from '../src/types.ts';
import { hostname } from 'node:os';
import * as ops from '../src/ops.ts';
import type { CandidateFacts, Draft, Entry, NodeSpec, State } from '../src/types.ts';
import type { Need, Measuring } from '../src/needs-types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

// Dynamic imports let every individual test show its own red result on the base tree.
const api = () => import('../src/needs.ts');
const grammar = () => import('../src/cli.ts');
const now = Date.parse('2026-10-16T12:00:00Z');
const owner = { role: 'owner', id: 'pi' } as const, parent = { role: 'parent', id: 'test' } as const;
const commit = (tag: string) => sha256(tag).slice(0, 40);
const spec = (o: Partial<NodeSpec> & { id: string }): NodeSpec => ({ deps: [], writes: [o.id + '/'], checks: [], review: { count: 0, min_rank: 1 }, ...o });
function rig(extra: Partial<NodeSpec> = {}) {
  const plan = { version: 1 as const, trunk: 'main', closure: [], invariants: [], nodes: [spec({ id: 'a', checks: [{ id: 'stress', run: 'false', reads: ['a/'], timeout_s: 60 }, { id: 'behaviour', run: 'true', reads: ['a/'], timeout_s: 60 }], review: { count: 1, min_rank: 1 }, ...extra }), spec({ id: 'dep' })] };
  const entries: Entry[] = [];
  const state = (): State => reduce(entries, () => plan);
  const add = (draft: Draft): Entry => {
    const seq = entries.length, e = { ...draft, seq, ts: new Date(now + seq * 1000).toISOString(), prev: 'x', hash: sha256(String(seq)) } as Entry;
    entries.push(e); state(); return e;
  };
  add({ kind: 'genesis', by: 'owner:pi', channel: 'delegated', plan: 'p', trunk: 'main', commit: commit('base'), state: { commit: commit('base'), tree: 'tree', invKeys: {} } });
  const facts = (tag: string, closure = false): CandidateFacts => ({ commit: commit(tag), base: commit('base'), tree: 'tree-' + tag, patch: 'patch-' + tag, changed: ['a/x'], closureTouched: closure, keys: Object.fromEntries(['check:stress', 'check:behaviour', 'writes', 'review', 'closure-review', 'approve', 'evidence:ui', 'rulings'].map(o => [o, sha256(o === 'rulings' ? 'attempt-1' : o + tag)]).concat(Object.entries(manualKeys(plan.nodes[0]!, 'patch-' + tag)))) });
  const r = {
    entries, state, add, facts,
    dispatch() { return add({ kind: 'dispatch', by: 'parent:drive', node: 'a', attempt: 1, base: commit('base'), branch: 'owed/a/1', worktree: '/repo/a', packet: 'blob', rulings_seen: -1 }); },
    submit(tag = 'one', closure = false) { return add({ kind: 'submit', by: 'writer:a#1', node: 'a', attempt: 1, facts: facts(tag, closure) }); },
    obs(obligation: string, verdict: 'pass' | 'fail', more: Partial<Extract<Draft, { kind: 'obs' }>> = {}) {
      const c = state().nodes.a!.candidate!;
      return add({ kind: 'obs', by: 'executor:owed', subject: 'a', obligation, key: c.keys[obligation]!, verdict, exit: verdict === 'pass' ? 0 : 1, durationMs: 1, commit: c.commit, base: c.base, ...more });
    },
    pass() { r.obs('check:stress', 'pass'); r.obs('check:behaviour', 'pass'); r.obs('writes', 'pass'); },
    block(obligation = 'review', by = 'reviewer:drive-a-1-1', rank = 2, needs?: 'parent') {
      return add({ kind: 'review', by, channel: by.startsWith('owner:') ? 'delegated' : undefined, node: 'a', attempt: 1, obligation: obligation as 'review' | 'closure-review' | 'approve', key: state().nodes.a!.candidate!.keys[obligation]!, verdict: 'block', rank, note: 'BLOCK (needs parent): choose the response', ...(needs ? { needs } : {}) });
    },
    ok(by: string, rank: number, obligation = 'review') {
      return add({ kind: 'review', by, node: 'a', attempt: 1, obligation: obligation as 'review' | 'closure-review', key: state().nodes.a!.candidate!.keys[obligation]!, verdict: 'ok', rank, note: 'checked', ack_rulings: Math.max(0, ...state().rules.map(r => r.seq)) });
    },
    rule(writer = false) { return add({ kind: 'rule', by: 'parent:pi', nodes: ['a'], text: 'parent owns the rerun; no writer change', ...(writer ? { writer: true } : {}) }); },
    halt(reason = 'stalled: check:stress', needs: 'human' | 'owner' = 'owner') { return add({ kind: 'halt', by: 'parent:drive', node: 'a', attempt: 1, reason, needs }); },
    flaky(obligation = 'check:stress') { const fail = r.obs(obligation, 'fail'); r.obs(obligation, 'pass', { attribution: true }); return fail; },
    waive(obligation: string) { return add({ kind: 'waive', by: 'owner:pi', channel: 'delegated', node: 'a', obligation, key: state().nodes.a!.candidate!.keys[obligation]!, reason: 'accepted', accept_risk: state().nodes.a!.blocks.filter(b => b.obligation === obligation && ['active', 'flaky'].includes(b.state)).map(b => b.seq) }); },
  };
  r.dispatch(); r.submit(); return r;
}
const measuring = (s: State, changes: Partial<Measuring> = {}): Measuring => ({ node: 'a', do: 'attest', phase: 'running', obligations: ['check:stress'], candidate: s.nodes.a!.candidate!.seq, since: new Date(now).toISOString(), pid: 123, token: 'run', ...changes });
function words(command: string): string[] {
  // Owed builders use shell quoting (including answerRetry's ANSI-C quoted line breaks).
  const out: string[] = []; let word = '', started = false, quote = '', ansi = false;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (!quote && c === '$' && command[i + 1] === "'") { ansi = true; continue; }
    if (c === '\\' && quote !== "'" || c === '\\' && ansi) { const next = command[++i]!; word += ansi && next === 'n' ? '\n' : ansi && next === 'r' ? '\r' : next; started = true; continue; }
    if (quote) { if (c === quote) { quote = ''; ansi = false; } else word += c; started = true; continue; }
    if (c === "'" || c === '"') { quote = c; started = true; continue; }
    if (/\s/.test(c)) { if (started) { out.push(word); word = ''; started = false; } } else { word += c; started = true; }
  }
  if (started) out.push(word); assert.equal(quote, '', command); return out;
}
async function commands(ns: Need[]) {
  const { validateArgv } = await grammar();
  for (const n of ns) for (const cmd of [n.command, ...(n.alternatives ?? [])].filter((s): s is string => !!s)) {
    const argv = words(cmd); assert.equal(argv.shift(), 'owed'); validateArgv(argv);
    assert.ok(argv.includes(n.node), cmd);
    if (n.obligation) {
      if (n.kind === 'waive') assert.equal(argv[2], n.obligation, cmd);
      if (n.kind === 'evidence') assert.equal(argv[2], n.obligation.slice(9), cmd);
      if (n.obligation === 'closure-review' && n.kind === 'review') assert.ok(cmd.includes('--obligation closure-review'), cmd);
      assert.doesNotMatch(cmd, n.obligation === 'review' ? /check:stress|check:behaviour/ : /--obligation review/);
    }
    assert.doesNotMatch(cmd, /--no-resume|--prospective|--nodes \*/);
  }
}
function stressNeed(s: State, block: number, halted = false): Need {
  const c = s.nodes.a!.candidate!, b = s.nodes.a!.blocks.find(b => b.seq === block)!;
  const fail = entriesOf(s).find(e => e.seq === block)!;
  const pass = entriesOf(s).find(e => e.kind === 'obs' && e.attribution && e.key === b.key && e.verdict === 'pass')!;
  const command = `owed waive a check:stress --candidate ${c.commit.slice(0, 12)} --accept-risk ${block} --reason "<reason>" --as owner:<id>`;
  return { node: 'a', actor: 'owner', kind: 'waive', since: block, obligation: 'check:stress', key: c.keys['check:stress']!, block, candidate: c.commit.slice(0, 12), text: b.state === 'flaky' ? `check:stress: flaky block #${block} on check:stress: ${fail.kind === 'obs' ? fail.commit.slice(0, 12) : ''} failed #${block} (unknown failed tests) → passed #${pass.seq} on the same key; a pass does not erase a failure: accept the risk (${command}) or fix it` : 'check:stress: check:stress still blocked:', command, ...(halted ? { halted: true } : {}) };
}

test('NE1 §99.1: current running attest suppresses only stress; stalled and writer-stop halt fallback', async () => {
  const { needs, activity } = await api(), r = rig(); const b = r.obs('check:stress', 'fail'); r.rule(); const s = r.state(), rt = { measuring: [measuring(s)] };
  assert.deepEqual(needs(s, 'a', rt), []);
  assert.deepEqual(activity(s, 'a', rt), { node: 'a', phase: 'measuring', text: `measuring check:stress since ${clockTime(now, now)} (attest pid 123)` });
  const h = r.halt();
  assert.deepEqual(needs(r.state(), 'a', rt), [{ node: 'a', actor: 'parent', kind: 'resume', since: h.seq, halted: true, text: 'driver halted: stalled: check:stress; after resume the driver continues from the current state', command: 'owed resume a' }]);
  const stopped = r.halt(`writer run r sealed ok; writer says: "No change" → ${writerDecisionCommand('a')}`);
  assert.deepEqual(needs(r.state(), 'a', rt), [{ node: 'a', actor: 'parent', kind: 'decide', since: stopped.seq, halted: true, text: 'writer says: "No change"', command: writerDecisionCommand('a'), alternatives: ['owed resume a'] }]);
  await commands(needs(r.state(), 'a', rt)); assert.ok(b.seq > 0);
});

test('NE2 §99.2 R-028-24/25: active stress owner halt has one pinned risk waive, no added route', async () => {
  const { needs } = await api(), r = rig(); const b = r.obs('check:stress', 'fail'); r.rule(); r.halt();
  const s = r.state(), n = needs(s, 'a')[0]!;
  assert.deepEqual(n, { node: 'a', actor: 'owner', kind: 'waive', since: b.seq, obligation: 'check:stress', key: s.nodes.a!.candidate!.keys['check:stress']!, block: b.seq, candidate: s.nodes.a!.candidate!.commit.slice(0, 12), text: 'check:stress: check:stress still blocked:', command: `owed waive a check:stress --candidate ${s.nodes.a!.candidate!.commit.slice(0, 12)} --accept-risk ${b.seq} --reason "<reason>" --as owner:<id>`, halted: true });
  assert.equal(n.alternatives, undefined); assert.doesNotMatch(n.command!, /--writer|owed attest/); await commands([n]);
  const other = r.obs('check:stress', 'fail'); r.halt(); const ns = needs(r.state(), 'a'); assert.match(ns[0]!.command!, new RegExp(`--accept-risk ${b.seq},${other.seq}`)); await commands(ns);
});

test('NE3 §99.3 C1: halted review and stress have separate commands and alternatives', async () => {
  const { needs } = await api(), r = rig(); r.block('review', 'reviewer:external'); const b = r.obs('check:stress', 'fail'); r.halt();
  const ns = needs(r.state(), 'a'); assert.equal(ns.length, 2); assert.deepEqual(ns[0], stressNeed(r.state(), b.seq, true));
  assert.deepEqual(ns.map(n => [n.obligation, n.kind, n.halted]), [['check:stress', 'waive', true], ['review', 'decide', true]]);
  assert.ok(ns[1]!.alternatives?.[0]?.includes('--ack-rulings latest')); await commands(ns);
});

test('NE4 §99.4: a changed-key repair plus stress halt never asks for another writer decision', async () => {
  const { needs, itemLine } = await api(), r = rig(); const b = r.block('review', 'reviewer:drive-a-1-1', 2, 'parent'); r.rule(true); r.submit('two'); const fail = r.obs('check:stress', 'fail'); r.halt();
  const s = r.state(), ns = needs(s, 'a'); assert.deepEqual(ns[0], stressNeed(s, fail.seq, true));
  assert.equal(itemLine(s, 'a', 'review'), `repair #${s.nodes.a!.candidate!.seq} submitted; #${b.seq} clears when reviewer:drive-a-1-1 records ok at rank >= 2 on the current key`);
  assert.doesNotMatch(JSON.stringify(ns), /--writer|guidance needed|driver will/);
  r.ok('reviewer:other', 2); assert.equal(r.state().nodes.a!.blocks.find(x => x.seq === b.seq)?.state, 'active');
  assert.deepEqual(needs(r.state(), 'a'), [], 'a reviewer entry clears the halt but neither clears B nor accepts the active stress failure');
  assert.equal(r.state().nodes.a!.accepted, false); await commands(ns);
});

test('NE5 §96.4 C3: external old review and closure-review name the author and current owner override', async () => {
  const { needs, itemLine } = await api();
  for (const obligation of ['review', 'closure-review']) {
    const r = rig(); r.submit('closure-one', obligation === 'closure-review'); r.pass(); const b = r.block(obligation, 'reviewer:original', 2); r.rule(true); r.submit('closure-two', obligation === 'closure-review');
    const s = r.state(), n = needs(s, 'a').find(n => n.obligation === obligation)!;
    const text = `repair #${s.nodes.a!.candidate!.seq} submitted; #${b.seq} clears when reviewer:original records ok at rank >= 2 on the current key`;
    assert.deepEqual(n, { node: 'a', actor: 'owner', kind: 'review', since: b.seq, obligation, key: s.nodes.a!.candidate!.keys[obligation]!, block: b.seq, candidate: s.nodes.a!.candidate!.commit.slice(0, 12), text, command: `owed review a${obligation === 'closure-review' ? ' --obligation closure-review' : ''} --ok --rank 3 --candidate ${s.nodes.a!.candidate!.commit.slice(0, 12)} --note "<note>" --ack-rulings latest --as owner:<id>` });
    assert.equal(itemLine(s, 'a', obligation), text); assert.doesNotMatch(JSON.stringify(n), /guidance needed|--writer|driver/); await commands([n]);
  }
});

test('NE6 C3 negative WF1: old exec and held flake keep attribution routes after a submit', async () => {
  const { needs, itemLine, activity } = await api();
  const r = rig(), fail = r.obs('check:stress', 'fail'); r.submit('two');
  assert.deepEqual(needs(r.state(), 'a'), []); assert.match(itemLine(r.state(), 'a', 'check:stress'), /attribution rerun on the original content clears the block/);
  r.obs('check:stress', 'pass', { attribution: true, key: r.facts('one').keys['check:stress'], commit: r.facts('one').commit });
  assert.deepEqual(needs(r.state(), 'a'), []); assert.equal(itemLine(r.state(), 'a', 'check:stress'), `waiting for check:stress on candidate ${r.facts('two').commit.slice(0, 12)} before deciding flaky #${fail.seq}`);
  assert.ok(activity(r.state(), 'a')!.text.includes('waiting for check:stress'));
  r.obs('check:stress', 'pass'); assert.equal(needs(r.state(), 'a')[0]!.kind, 'waive'); assert.doesNotMatch(itemLine(r.state(), 'a', 'check:stress'), /repair #|rank >=/); await commands(needs(r.state(), 'a'));
});

test('NE7 §99.6: unmerged resume --after is Activity only', async () => {
  const { needs, activity } = await api(), r = rig(); r.add({ kind: 'resume', by: 'parent:pi', node: 'a', attempt: 1, after: 'dep' });
  assert.deepEqual(needs(r.state(), 'a'), []); assert.deepEqual(activity(r.state(), 'a'), { node: 'a', phase: 'waiting', text: 'waiting for dep' });
});

test('NE8 12:3x C5: active merge-tree fail offers the merge-risk waive command (WK integration prerequisite)', async () => {
  const { needs } = await api(), r = rig(); r.pass(); r.ok('reviewer:fresh', 1);
  const b = r.obs('check:stress', 'fail', { merging: 'a', commit: commit('merge'), key: sha256('merge-stress') }); const s = r.state(), n = needs(s, 'a')[0]!;
  assert.deepEqual(n, { node: 'a', actor: 'owner', kind: 'waive', since: b.seq, obligation: 'check:stress', key: s.nodes.a!.candidate!.keys['check:stress']!, block: b.seq, candidate: s.nodes.a!.candidate!.commit.slice(0, 12), text: 'check:stress: check:stress still blocked:', command: `owed waive a check:stress --candidate ${s.nodes.a!.candidate!.commit.slice(0, 12)} --accept-risk ${b.seq} --reason "<reason>" --as owner:<id>` }); await commands([n]);
  assert.equal(s.nodes.a!.accepted, false, 'the display cannot clear the block; the merge-key operation is WK-owned');
});

test('NE9 C8 CAT #17013/#17015: behaviour waiver does not end the stress need', async () => {
  const { needs } = await api(), r = rig(); const stress = r.flaky(); r.flaky('check:behaviour'); r.halt(); r.waive('check:behaviour');
  assert.deepEqual(needs(r.state(), 'a'), [stressNeed(r.state(), stress.seq)]); assert.equal(r.state().nodes.a!.accepted, false); await commands(needs(r.state(), 'a'));
});

test('NE10 N5: halted executor, reviewer and dependency-only work requires resume, not prose commands', async () => {
  const { needs } = await api();
  for (const mode of ['executor', 'reviewer', 'dependency']) {
    const r = rig(); if (mode === 'reviewer') r.pass();
    if (mode === 'dependency') r.add({ kind: 'resume', by: 'parent:pi', node: 'a', attempt: 1, after: 'dep' });
    const h = r.halt('resource unavailable; diagnostic owed decide dep --writer', 'human');
    assert.deepEqual(needs(r.state(), 'a'), [{ node: 'a', actor: 'parent', kind: 'resume', since: h.seq, halted: true, text: `driver halted: resource unavailable; after resume the driver continues from the current state${mode === 'dependency' ? ', then waits for dep' : ''}`, command: 'owed resume a' }]); await commands(needs(r.state(), 'a'));
  }
});

test('NE11 N5.1: unruled current and invalidated latest-submit blocks precede writer-stop and resume', async () => {
  const { needs } = await api();
  for (const invalidated of [false, true]) {
    const r = rig(); const b = r.block('review', 'reviewer:drive-a-1-1', 2, 'parent');
    if (invalidated) {
      r.add({ kind: 'adopt', by: 'owner:pi', channel: 'delegated', trunk: 'main', prior: commit('base'), commit: commit('next-trunk'), commits: 1, changed: ['other'], note: 'trunk moved', state: { commit: commit('next-trunk'), tree: 'next-tree', invKeys: {} } });
      r.add({ kind: 'rebase', by: 'parent:drive', node: 'a', attempt: 1, from: commit('base'), base: commit('next-trunk') });
    }
    r.halt(`writer run r sealed ok; writer gave no final text → ${writerDecisionCommand('a')}`);
    const n = needs(r.state(), 'a')[0]!;
    assert.deepEqual(n, { node: 'a', actor: 'parent', kind: 'rule', since: b.seq, obligation: 'review', block: b.seq, key: r.facts('one').keys.review!, text: 'review asks: choose the response', command: writerDecisionCommand('a'), halted: true });
    assert.equal(needs(r.state(), 'a').length, 1); assert.equal(n.alternatives, undefined); await commands([n]);
  }
});

test('NE12 N6: queued, other, wrong node, obligation or candidate suppress nothing', async () => {
  const { needs, activity } = await api(), r = rig(); const b = r.flaky(), s = r.state();
  for (const change of [{ phase: 'queued' }, { do: 'other' }, { candidate: undefined }, { candidate: 0 }, { node: 'dep' }, { obligations: [] }, { obligations: ['check:behaviour'] }] as Partial<Measuring>[]) {
    const rt = { measuring: [measuring(s, change)] }; assert.deepEqual(needs(s, 'a', rt), [stressNeed(s, b.seq)]); await commands(needs(s, 'a', rt));
    if (change.node !== 'dep') assert.equal(activity(s, 'a', rt)!.phase, 'measuring');
  }
  const active = rig(), fail = active.obs('check:stress', 'fail');
  assert.deepEqual(needs(active.state(), 'a'), [], 'R-028-25: ordinary active failure remains writer work');
  active.halt(); const halted = active.state(), expected = needs(halted, 'a');
  assert.equal(expected[0]!.block, fail.seq); assert.equal(expected[0]!.halted, true);
  for (const change of [{ phase: 'queued' }, { do: 'other' }, { candidate: 0 }] as Partial<Measuring>[]) {
    const rt = { measuring: [measuring(halted, change)] };
    assert.deepEqual(needs(halted, 'a', rt), expected); await commands(expected);
  }
});

test('NE13 C7: repository needs never decide, rule or resume trunk', async () => {
  const { repoNeeds } = await api(), r = await repo();
  try {
    await r.commit(); await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify({ version: 1, trunk: 'main', lease: false, closure: [], invariants: [], nodes: [] }) });
    await ops.planSet({ cwd: r.cwd, as: parent, plan: JSON.stringify({ version: 1, trunk: 'main', lease: false, closure: [], invariants: [{ id: 'health', run: 'false', reads: ['impl'] }], nodes: [] }) });
    await ops.attestTrunk({ cwd: r.cwd, lease: false }); const { state } = await ops.readState(r), ns = repoNeeds(state);
    assert.equal(ns.length, 1); assert.deepEqual(ns[0], { node: 'trunk', actor: 'parent', kind: 'investigate', since: state.invariants[0]!.evidence.at(-1)!, obligation: 'inv:health', key: state.invariants[0]!.key, text: `no single command: ${state.invariants[0]!.detail}; fix inv:health: add a repair node with the recorded plan; clears on the next trunk key` });
    assert.doesNotMatch(JSON.stringify(ns), /owed (decide|rule|resume) trunk/); await commands(ns);
  } finally { await r.cleanup(); }
});

test('NE14 C9: a same-key ruling alone stays repair/owner-decision, never C3 recheck', async () => {
  const { needs, itemLine } = await api(), r = rig(); const b = r.block('review', 'reviewer:external', 2, 'parent'); r.rule();
  assert.equal(needs(r.state(), 'a')[0]!.kind, 'decide'); assert.equal(needs(r.state(), 'a')[0]!.command, writerDecisionCommand('a'));
  assert.doesNotMatch(itemLine(r.state(), 'a', 'review'), /repair #|submitted|driver will/); assert.equal(r.state().nodes.a!.blocks.find(x => x.seq === b.seq)?.state, 'active'); await commands(needs(r.state(), 'a'));
});

test('NE15 CR-B B3: rank-1 current OK cannot clear its own rank-2 block; slot-2 keeps its identity', async () => {
  const { needs, itemLine } = await api();
  for (const slot of [1, 2]) {
    const r = rig({ review: { count: slot, min_rank: 1 } }); const by = `reviewer:drive-a-1-${slot}`, b = r.block('review', by, 2); r.submit('two'); r.pass(); r.ok(by, 1);
    const s = r.state(); assert.equal(s.nodes.a!.blocks.find(x => x.seq === b.seq)?.state, 'active');
    assert.equal(itemLine(s, 'a', 'review'), `repair #${s.nodes.a!.candidate!.seq} submitted; #${b.seq} clears when ${by} records ok at rank >= 2 on the current key`);
    assert.doesNotMatch(JSON.stringify(needs(s, 'a')), /driver (will|runs)|--writer/); await commands(needs(s, 'a'));
  }
});

test('NE16 N1/N3 asking first: exact answer retry and needId retain rid/qid/rev without reading a clock', async () => {
  const { needs, needId } = await api(), r = rig(); const rid = runId(r.entries[0]!.hash.slice(0, 12), 'a', 1, 'writer');
  r.add({ kind: 'launch', by: 'parent:drive', node: 'a', attempt: 1, role: 'writer', rid, spec: sha256('blob'), labels: runLabels(r.entries[0]!.hash.slice(0, 12), 'a', 1, 'writer') });
  const e = r.add({ kind: 'rule', by: 'parent:pi', nodes: ['a'], text: 'Answer to writer question q: keep the old API', writer: false, answer: { rid, qid: 'q', rev: 2 } }); r.flaky(); r.halt();
  const rt = { asking: [{ node: 'a', rid, qid: 'q', rev: 2, text: 'still asking' }] }, ns = needs(r.state(), 'a', rt);
  assert.deepEqual(ns[0], { node: 'a', actor: 'parent', kind: 'answer', since: e.seq, rid, qid: 'q', rev: 2, text: 'still asking', command: `owed answer 'a' --rid '${rid}' --qid 'q' --rev 2 -- 'keep the old API'`, halted: true });
  assert.equal(ns[1]!.obligation, 'check:stress'); assert.notEqual(needId(ns[0]!), needId({ ...ns[0]!, rev: 3 })); assert.equal(needId(ns[0]!), needId({ ...ns[0]!, text: 'changed text' }));
  assert.ok(!needs(r.state(), 'a').some(n => n.kind === 'answer')); await commands(ns);
});

test('NE17 N1: unknown driver never implies stopped; ready nodes dispatch only on known false', async () => {
  const { needs } = await api(), r = rig(); const s = r.state();
  assert.deepEqual(needs(s, 'dep'), []); assert.deepEqual(needs(s, 'dep', { driverRunning: true }), []);
  assert.deepEqual(needs(s, 'dep', { driverRunning: false }), [{ node: 'dep', actor: 'parent', kind: 'dispatch', since: 0, text: 'ready to dispatch', command: 'owed dispatch dep' }]); await commands(needs(s, 'dep', { driverRunning: false }));
});

test('NE18 pinned vocabulary is byte-identical to the contract sha', async () => {
  await api();
  assert.equal(sha256(await readFile(new URL('../src/needs-types.ts', import.meta.url))), '7100ff5239731103fd8b95b360b260ff911e72a84822980a5bac55bfac65f7e8');
});

test('NE19 NE-CLI: exported grammar preserves CLI usage outcomes before I/O', async () => {
  const { validateArgv } = await grammar(), r = await repo();
  const invalid = [['wat'], ['status', 'extra'], ['status', '--candidate', commit('one')], ['status', '--as', 'bad'], ['evidence', 'a', 'ui'], ['attest', 'a', '--candidate', commit('one')], ['status', '--full=1'], ['report', '--since'], ['status', '--full', '--full'], ['drive', '--stop', '--once'], ['drive', '--now'], ['attest', 'a', '--all'], ['report', '--until', '2']];
  try {
    for (const argv of invalid) { assert.throws(() => validateArgv(argv), (e: unknown) => !!e && typeof e === 'object' && 'code' in e && e.code === 'usage', argv.join(' ')); const out = await cli(r.cwd, argv); assert.equal(out.code, 2, out.stderr); }
    // R-028-30: these checks remain after I/O/confirmation; only main validates them there.
    for (const argv of [['review', 'a', '--ok'], ['defer', 'a', 'health'], ['decide', 'a'], ['rule', 'text'], ['edit', 'a', '--expect', 'bad'], ['review', 'a', '--ok', '--rank', 'bad', '--obligation', 'bogus'], ['waive', 'a', 'check:stress', '--accept-risk', 'bad']]) validateArgv(argv);
    for (const argv of [['--help'], ['version'], ['attest', '--trunk'], ['rule', 'text', '--nodes', 'a'], ['answer', 'a', '--', '--literal answer'], ['review', 'a', '--ok', '--rank', '3', '--ack-rulings', 'latest'], ['decide', 'a', '--text', 'ruling', '--writes', '+a', '+b'], ['evidence', 'a', 'ui', '--file', 'a', '--file', 'b', '--note', 'checked']]) validateArgv(argv);
  } finally { await r.cleanup(); }
});

test('NE20 real CLI/ops: old review repair, no false acceptance, and exact command discharge', async () => {
  const { needs, itemLine } = await api(), r = await repo();
  try {
    await commitAt(r.cwd, { impl: 'base' });
    await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify({ version: 1, trunk: 'main', lease: false, closure: [], invariants: [], nodes: [{ id: 'a', writes: ['impl'], checks: [], review: { count: 1, min_rank: 1 } }] }) });
    const a = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent }); await commitAt(a.worktree, { impl: 'old' }); await ops.submit({ cwd: a.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
    const b = await ops.review({ cwd: r.cwd, node: 'a', as: { role: 'reviewer', id: 'original' }, verdict: 'block', rank: 2, note: 'repair' });
    await commitAt(a.worktree, { impl: 'fixed' }); await ops.submit({ cwd: a.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } }); await ops.attest({ cwd: r.cwd, node: 'a' });
    const before = await ops.readState(r), ns = needs(before.state, 'a'); assert.equal(ns.length, 1); assert.equal(ns[0]!.kind, 'review'); assert.equal(before.state.nodes.a!.accepted, false);
    assert.equal(itemLine(before.state, 'a', 'review'), `repair #${before.state.nodes.a!.candidate!.seq} submitted; #${b.seq} clears when reviewer:original records ok at rank >= 2 on the current key`);
    const argv = words(ns[0]!.command!).slice(1).map(w => w === 'owner:<id>' ? 'owner:pi' : w); const result = await cli(r.cwd, argv); assert.equal(result.code, 0, result.stderr);
    const after = await ops.readState(r); assert.deepEqual(needs(after.state, 'a'), []); assert.equal(after.state.nodes.a!.accepted, true); assert.equal((await ops.verify(r)).ok, true);
    assert.deepEqual(entriesOf(before.state), before.entries, 'pure need queries do not append or change history'); await commands(ns);
  } finally { await r.cleanup(); }
});


// R-028-24: copy the setup of SQ's sampled states; never import/run the original tests.
function summaryRig() {
  const plan: Plan = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: [] };
  const entries = [{ kind: 'genesis', by: 'owner:human', channel: 'flag', plan: 'p', trunk: 'main', commit: 'abcdef0123456789', state: { commit: 'abcdef0123456789', tree: 't', invKeys: {} }, seq: 0, ts: new Date(now - 300_000).toISOString(), prev: 'x', hash: 'h' }] as Entry[];
  const s = reduce(entries, () => plan);
  const item = (subject: string, obligation: string, discharger: ItemView['discharger'], detail = 'awaiting observation', status: ItemView['status'] = 'D'): ItemView => ({ subject, obligation, discharger, detail, status, mark: status === 'W' ? '⚠' : '⊥', key: 'key', evidence: [] });
  const add = (id: string, phase: NodeState['phase'], items: ItemView[] = []) => {
    s.plan.nodes.push({ id, deps: [], writes: [`${id}/`], checks: [], review: { count: 0, min_rank: 1 } });
    const n: NodeState = { id, phase, items, blocks: [], accepted: phase === 'accepted', dependents: 0, writers: [], runs: [] };
    if (['dispatched', 'submitted', 'accepted'].includes(phase)) n.slot = { attempt: 1, base: 'base', branch: id, worktree: `/repo/${id}`, writer: `writer:${id}#1`, dispatchSeq: 0, rulings_seen: -1, open: true };
    if (phase === 'submitted' || phase === 'accepted') n.candidate = { seq: 0, commit: 'candidate', base: 'base', tree: 'tree', patch: 'patch', keys: Object.fromEntries(items.map(i => [i.obligation, i.key])), changed: [], closureTouched: false };
    if (phase === 'merged') n.merged = { seq: 0, commit: 'merged' };
    s.nodes[id] = n; return n;
  };
  return { s, entries, item, add };
}
const normalized = (command: string): string => command
  .replace(/--candidate (?:[a-f0-9]{7,40}|candidate)/g, '--candidate <candidate>')
  .replace(/--as (owner|parent|reviewer):(?:[A-Za-z0-9#._-]+|<id>)/g, '--as $1:<id>');
const setOf = (ns: { node: string; command?: string }[]) => [...new Set(ns.map(n => `${n.node}|${normalized(n.command ?? '')}`))].sort();
type ParityRow = { baseline: [string[], string[]]; expected?: [string[], string[]]; correction?: string };
// Generated once from the still-unchanged 2a5f1a8 statusView selector, with empty mergeChecks.
const parityTable: Record<string, ParityRow> = {
  "SQ1": {
    "baseline": [
      [
        "halt|owed decide halt --text \"<why>\"",
        "owner|owed approve owner --candidate <candidate> [--note TEXT] (owner)",
        "ready|owed dispatch ready",
        "ruling|owed decide ruling --text \"<ruling>\" --writer",
        "trunk|fix inv:health: add a repair node (owed edit --node-new) — clears on the next trunk key; deferred for owner #3"
      ],
      [
        "halt|owed decide halt --text \"<why>\"",
        "owner|owed approve owner --candidate <candidate> [--note TEXT] (owner)",
        "ruling|owed decide ruling --text \"<ruling>\" --writer",
        "trunk|fix inv:health: add a repair node (owed edit --node-new) — clears on the next trunk key; deferred for owner #3"
      ]
    ],
    "expected": [
      [
        "halt|owed resume halt",
        "owner|owed approve owner --candidate <candidate> --note \"<note>\" --as owner:<id>",
        "ready|owed dispatch ready",
        "ruling|owed decide ruling --text \"<ruling>\" --writer",
        "trunk|"
      ],
      [
        "halt|owed resume halt",
        "owner|owed approve owner --candidate <candidate> --note \"<note>\" --as owner:<id>",
        "ruling|owed decide ruling --text \"<ruling>\" --writer",
        "trunk|"
      ]
    ],
    "correction": "C4/C6/C7"
  },
  "SQ2": {
    "baseline": [
      [],
      []
    ]
  },
  "SQ3": {
    "baseline": [
      [
        "a|owed approve a --candidate <candidate> [--note TEXT] (owner)"
      ],
      [
        "a|owed approve a --candidate <candidate> [--note TEXT] (owner)"
      ]
    ],
    "expected": [
      [
        "a|owed approve a --candidate <candidate> --note \"<note>\" --as owner:<id>"
      ],
      [
        "a|owed approve a --candidate <candidate> --note \"<note>\" --as owner:<id>"
      ]
    ],
    "correction": "C4"
  },
  "SQ-cli-ready": {
    "baseline": [
      [
        "a|owed dispatch a"
      ],
      []
    ]
  },
  "SQ-cli-live": {
    "baseline": [
      [
        "a|owed dispatch a"
      ],
      []
    ]
  },
  "SQ-cli-foreign": {
    "baseline": [
      [
        "a|owed dispatch a"
      ],
      []
    ]
  },
  "SQ-1562-trunk-red": {
    "baseline": [
      [
        "trunk|"
      ],
      [
        "trunk|"
      ]
    ]
  },
  "SQ-1517.2-deferred": {
    "baseline": [
      [
        "b|owed dispatch b"
      ],
      []
    ]
  },
  "SQ-1517.2-fixed": {
    "baseline": [
      [],
      []
    ]
  },
  "SQ-1517.2-retired": {
    "baseline": [
      [],
      []
    ]
  },
  "WF1-same-key": {
    "baseline": [
      [
        "a|owed waive a check:unit --reason \"<why the risk is acceptable>\" --accept-risk 3 --candidate <candidate>",
        "b|owed dispatch b"
      ],
      [
        "a|owed waive a check:unit --reason \"<why the risk is acceptable>\" --accept-risk 3 --candidate <candidate>"
      ]
    ],
    "expected": [
      [
        "a|owed waive a check:unit --candidate <candidate> --accept-risk 3 --reason \"<reason>\" --as owner:<id>",
        "b|owed dispatch b"
      ],
      [
        "a|owed waive a check:unit --candidate <candidate> --accept-risk 3 --reason \"<reason>\" --as owner:<id>"
      ]
    ],
    "correction": "C4"
  },
  "WF1-held-old-key": {
    "baseline": [
      [
        "b|owed dispatch b"
      ],
      []
    ]
  },
  "WF1-exposed-current-pass": {
    "baseline": [
      [
        "a|owed waive a check:unit --reason \"<why the risk is acceptable>\" --accept-risk 3 --candidate <candidate>",
        "b|owed dispatch b"
      ],
      [
        "a|owed waive a check:unit --reason \"<why the risk is acceptable>\" --accept-risk 3 --candidate <candidate>"
      ]
    ],
    "expected": [
      [
        "a|owed waive a check:unit --candidate <candidate> --accept-risk 3 --reason \"<reason>\" --as owner:<id>",
        "b|owed dispatch b"
      ],
      [
        "a|owed waive a check:unit --candidate <candidate> --accept-risk 3 --reason \"<reason>\" --as owner:<id>"
      ]
    ],
    "correction": "C4"
  },
  "WF4-timeout-status": {
    "baseline": [
      [
        "a|owed dispatch a"
      ],
      []
    ]
  }
};
const outOfParity = [
  'SQ repair #1517.1: its expected need is injected mergeChecks/Git-derived ops output, outside the pure Scope baseline',
  'SQ4 version notices: no status/summary need is computed from ledger State at these call sites',
  'WF3 receipt/waiver, WF4 edit admission, WF5 driver/queue-only sites: no status/summary need sample at these sites',
];

async function parity(id: string, s: State) {
  const { needs, repoNeeds, activity } = await api();
  const baseline = [false, true].map(driverRunning => setOf(statusView(s, [...entriesOf(s)], [], now, driverRunning).summary!.needs));
  const actual = [false, true].map(driverRunning => setOf([...Object.keys(s.nodes).flatMap(id => needs(s, id, { driverRunning })), ...repoNeeds(s)]));
  const row = parityTable[id]; assert.ok(row, `missing frozen baseline ${id}`);
  assert.deepEqual(baseline, row.baseline, `${id}: unchanged baseline selector`);
  assert.deepEqual(actual, row.expected ?? row.baseline, `${id}: ${row.correction ?? 'parity'}`);
  for (const p of statusView(s, [...entriesOf(s)], [], now, true).summary!.progress) assert.equal(activity(s, p.node)?.text, p.phase, id);
  if (id === 'SQ1' || id === 'SQ3') return; // Original display-only fixture uses a non-hex 'candidate'; behavioral fixtures validate real pins.
  for (const driverRunning of [false, true]) await commands([...Object.keys(s.nodes).flatMap(id => needs(s, id, { driverRunning })), ...repoNeeds(s)]);
}

test('NE21 parity SQ1/SQ2/SQ3: exact setup and frozen node/command sets at summary call sites', async () => {
  await api(); const f = summaryRig();
  f.add('done', 'merged'); f.add('writer', 'dispatched'); f.add('measure', 'submitted', [f.item('measure', 'check:unit', 'executor')]); f.add('review', 'submitted', [f.item('review', 'review', 'reviewer')]); f.add('accepted', 'accepted');
  f.add('waiting', 'blocked'); f.s.plan.nodes.find(n => n.id === 'waiting')!.deps = ['writer']; f.add('held', 'held').held = 0;
  f.add('halt', 'dispatched').halt = { kind: 'halt', node: 'halt', attempt: 1, by: 'parent:drive', seq: 1, ts: new Date(now).toISOString(), prev: 'x', hash: 'h1', needs: 'human', reason: 'repair budget exhausted' };
  const ruling = f.add('ruling', 'submitted', [f.item('ruling', 'review', 'reviewer')]); ruling.blocks.push({ seq: 2, node: 'ruling', obligation: 'review', kind: 'judgment', key: 'key', rank: 2, state: 'active', needs: 'parent' });
  f.entries.push({ kind: 'review', by: 'reviewer:r', node: 'ruling', attempt: 1, obligation: 'review', key: 'key', rank: 2, verdict: 'block', needs: 'parent', note: 'choose the public response', seq: 2, ts: new Date(now).toISOString(), prev: 'x', hash: 'h2' });
  f.add('owner', 'submitted', [f.item('owner', 'approve', 'owner')]); f.add('waived', 'accepted', [f.item('waived', 'check:unit', undefined, 'risk accepted', 'W')]); f.add('ready', 'ready');
  f.s.invariants = [f.item('trunk', 'inv:health', 'parent', 'trunk-red: existing failure')]; f.s.trunk.invKeys.health = 'key'; f.s.deferred.push({ seq: 3, node: 'owner', id: 'health', key: 'key' });
  // SQ's synthetic state has a deliberately non-hex candidate. Use it only in the frozen display comparison.
  await parity('SQ1', f.s);
  await parity('SQ2', summaryRig().s);
  const brief = summaryRig(); brief.add('a', 'submitted', [brief.item('a', 'approve', 'owner')]); await parity('SQ3', brief.s);
  assert.ok(outOfParity.some(s => s.includes('#1517.1')));
});

test('NE22 parity SQ CLI live/foreign and SQ #1562: copied real setup, both known driver booleans', async () => {
  await api(); const r = await repo();
  try {
    await r.commit();
    await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [], nodes: [{ id: 'a', writes: ['a/'], checks: [], review: { count: 0, min_rank: 1 } }] }) });
    await parity('SQ-cli-ready', (await ops.readState(r)).state);
    for (const host of [hostname(), 'foreign-host']) {
      await writeFile(join(process.env.OWED_DIR!, 'drive.lock'), JSON.stringify({ pid: process.pid, host, at: new Date(now).toISOString(), token: 'fixture' }));
      await ops.status({ cwd: r.cwd }); await parity(host === hostname() ? 'SQ-cli-live' : 'SQ-cli-foreign', (await ops.readState(r)).state);
    }
  } finally { await r.cleanup(); }
  const q = await repo();
  try {
    const failing = (name: string) => `echo 'owed-counts {"pass":0,"fail":1,"failed":["${name}"]}'; exit 1`;
    await commitAt(q.cwd, { 'one.sh': failing('old one'), 'two.sh': failing('old two') });
    const plan = { version: 1, trunk: 'main', lease: false, closure: [], invariants: [], nodes: [] };
    await ops.init({ cwd: q.cwd, as: owner, channel: 'delegated', plan: JSON.stringify(plan) });
    await ops.planSet({ cwd: q.cwd, as: parent, plan: JSON.stringify({ ...plan, invariants: [{ id: 'one', run: 'bash one.sh', reads: ['one.sh'], min_tests: 1 }, { id: 'two', run: 'bash two.sh', reads: ['two.sh'], min_tests: 1 }] }) });
    await ops.attestTrunk({ cwd: q.cwd, lease: false }); await parity('SQ-1562-trunk-red', (await ops.readState(q)).state);
  } finally { await q.cleanup(); }
});

test('NE23 parity SQ #1517.2 defer: copied A debt, B fix, and retired A display samples', async () => {
  await api(); const r = await repo();
  try {
    const plan = { version: 1, trunk: 'main', lease: false, closure: [], invariants: [{ id: 'health', run: 'test ! -e bad.txt || test -e fix.txt', reads: ['bad.txt', 'fix.txt'] }], nodes: [{ id: 'a', writes: ['bad.txt'], checks: [] }, { id: 'b', writes: ['fix.txt'], checks: [] }] };
    await r.commit(); await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify(plan) });
    const a = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent }); await commitAt(a.worktree, { 'bad.txt': 'broken' }); await ops.submit({ cwd: a.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } }); await ops.attest({ cwd: r.cwd, node: 'a' });
    await assert.rejects(ops.merge({ cwd: r.cwd, node: 'a', as: parent }), /invariant health new debt/);
    assert.equal((await cli(r.cwd, ['defer', 'a', 'health', '--reason', 'repair later', '--as', 'owner:pi'])).code, 0);
    await parity('SQ-1517.2-deferred', (await ops.readState(r)).state);
    const b = await ops.dispatch({ cwd: r.cwd, node: 'b', as: parent }); await commitAt(b.worktree, { 'fix.txt': 'fixed' }); await ops.submit({ cwd: b.worktree, node: 'b', as: { role: 'writer', id: 'b#1' } }); await ops.attest({ cwd: r.cwd, node: 'b' }); await ops.merge({ cwd: r.cwd, node: 'b', as: parent });
    await parity('SQ-1517.2-fixed', (await ops.readState(r)).state);
    await r.put('removed-plan.json', JSON.stringify({ ...plan, nodes: plan.nodes.filter(n => n.id !== 'a') }));
    const out = await cli(r.cwd, ['plan', 'removed-plan.json', '--as', 'owner:pi', '--note', 'retire the still-open candidate']); assert.equal(out.code, 0, out.stderr);
    await parity('SQ-1517.2-retired', (await ops.readState(r)).state);
  } finally { await r.cleanup(); }
});

const WF_PASS = "echo '# tests 4'; echo '# pass 4'; echo '# fail 0'";
const WF_FAIL = `echo 'owed-counts {"pass":0,"fail":4,"failed":["case one","case two","case three","case four"]}'; exit 1`;
async function appRig() {
  const r = await repo(), flag = join(r.root, 'pass'); await commitAt(r.cwd, { impl: 'base' });
  const run = `if [ -e '${flag}' ]; then ${WF_PASS}; else ${WF_FAIL}; fi`;
  const plan = { version: 1, trunk: 'main', lease: false, closure: [], invariants: [], nodes: [{ id: 'a', writes: ['impl'], checks: [{ id: 'unit', run, reads: ['impl', 'src/'], min_tests: 1 }], review: { count: 0, min_rank: 1 } }, { id: 'b', writes: ['src/b'], checks: [], review: { count: 0, min_rank: 1 } }] };
  await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify(plan) });
  const a = await ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' }); await commitAt(a.worktree, { impl: 'old candidate' }); await ops.submit({ cwd: a.worktree, as: { role: 'writer', id: 'a#1' }, node: 'a', model: 'test' }); await ops.attest({ cwd: r.cwd, node: 'a' });
  await writeFile(flag, 'pass'); await ops.attest({ cwd: r.cwd, node: 'a' }); return { ...r, flag, a };
}
test('NE24 parity WF1/WF2: copied held/exposed and same-key flaky status samples', async () => {
  await api(); const r = await appRig();
  try {
    await parity('WF1-same-key', (await ops.readState(r)).state);
    await commitAt(r.a.worktree, { impl: 'new candidate' }); await ops.submit({ cwd: r.a.worktree, as: { role: 'writer', id: 'a#1' }, node: 'a', model: 'test' });
    await parity('WF1-held-old-key', (await ops.readState(r)).state);
    await ops.attest({ cwd: r.cwd, node: 'a' }); await parity('WF1-exposed-current-pass', (await ops.readState(r)).state);
  } finally { await r.cleanup(); }
});

test('NE25 parity WF4 near-timeout status: copied admission state after two trunk observations', async () => {
  await api(); const r = await repo();
  try {
    await commitAt(r.cwd, { 'closure.txt': 'base', impl: 'base' });
    const plan = { version: 1, trunk: 'main', lease: false, closure: ['closure.txt'], invariants: [{ id: 'slow', run: 'true', reads: ['**'], timeout_s: 1 }], nodes: [{ id: 'a', writes: ['impl'], checks: [{ id: 'unit', run: 'true', reads: ['**'], timeout_s: 30 }] }] };
    const file = join(r.root, 'plan.json'); await writeFile(file, JSON.stringify(plan));
    await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify(plan), measure: false, path: file }); await ops.planSet({ cwd: r.cwd, as: parent, plan: JSON.stringify(plan), path: file });
    const { Ledger } = await import('../src/ledger.ts'), ledger = await Ledger.open(r.cwd), { state } = await ops.readState(r);
    await ledger.withLock(() => ledger.append([{ kind: 'obs', by: 'executor:owed', subject: 'trunk', obligation: 'inv:slow', key: state.trunk.invKeys.slow!, commit: state.trunk.commit, verdict: 'pass', exit: 0, durationMs: 850 }]));
    await ops.planSet({ cwd: r.cwd, as: parent, plan: JSON.stringify(plan) }); await ops.planSet({ cwd: r.cwd, as: parent, plan: JSON.stringify(plan) });
    await parity('WF4-timeout-status', (await ops.readState(r)).state);
  } finally { await r.cleanup(); }
});


test('NE26 manual/rank routes, held/later lifecycle and item-scoped measuring do not change gate ownership', async () => {
  const { needs, activity, itemLine } = await api();
  for (const role of ['parent', 'owner', 'reviewer'] as const) {
    const r = rig({ evidence: [{ id: 'ui', what: 'look at page', by: role }], approve: 'owner', review: { count: 1, min_rank: 3 } });
    r.pass(); const s = r.state(), ns = needs(s, 'a');
    assert.deepEqual(ns.map(n => [n.obligation, n.kind]), [['approve', 'approve'], ...(role === 'reviewer' ? [] : [['evidence:ui', 'evidence']])]);
    assert.ok(itemLine(s, 'a', 'evidence:ui').includes(`--as ${role === 'reviewer' ? 'reviewer' : role}:<id>`));
    await commands(ns);
    const block = r.block('approve', 'owner:approver', 3); r.submit('manual-two');
    assert.equal(needs(r.state(), 'a').find(n => n.obligation === 'approve')!.kind, 'approve');
    assert.doesNotMatch(itemLine(r.state(), 'a', 'approve'), /rank >=|repair #/); assert.equal(r.state().nodes.a!.blocks.find(b => b.seq === block.seq)!.state, 'active');
  }
  const rank = rig({ review: { count: 1, min_rank: 3 } }); rank.pass();
  // Existing item membership is reviewer (not a new owner need); activity never predicts dispatch.
  assert.deepEqual(needs(rank.state(), 'a'), []); assert.equal(activity(rank.state(), 'a')!.phase, 'reviewing');
  const held = rig(); held.flaky(); held.add({ kind: 'abandon', by: 'owner:pi', channel: 'delegated', node: 'a', attempt: 1, reason: 'hold' });
  const abandon = held.entries.at(-1)!; held.add({ kind: 'hold', by: 'owner:pi', channel: 'delegated', node: 'a', abandon: abandon.seq });
  assert.deepEqual(needs(held.state(), 'a'), [], 'the closed hold retains baseline membership');
  assert.deepEqual(activity(held.state(), 'a'), { node: 'a', phase: 'held', text: 'held' });
  const later = summaryRig(); later.add('a', 'blocked'); later.s.plan.nodes[0]!.later = true;
  assert.equal(activity(later.s, 'a'), undefined);
});

test('NE27 shared check retains flaky attribution pair and real tracker, no unresolved fix placeholder', async () => {
  const { needs, itemLine } = await api(), r = await repo();
  try {
    const flag = join(r.root, 'pass'), run = `if [ -e '${flag}' ]; then ${WF_PASS}; else ${WF_FAIL}; fi`;
    await commitAt(r.cwd, { impl: 'base' });
    await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify({ version: 1, trunk: 'main', lease: false, closure: [], invariants: [], nodes: [{ id: 'a', writes: ['impl'], checks: [{ id: 'unit', run, reads: ['impl'], min_tests: 1 }] }, { id: 'fix', title: 'Repair case one', writes: ['fix'], checks: [] }] }) });
    const a = await ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' }); await commitAt(a.worktree, { impl: 'candidate' }); await ops.submit({ cwd: a.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } }); await ops.attest({ cwd: r.cwd, node: 'a' });
    await ops.attestProbeTrunk({ cwd: r.cwd, node: 'a', lease: false });
    let s = (await ops.readState(r)).state, ns = needs(s, 'a'); assert.equal(ns[0]!.kind, 'waive'); assert.match(ns[0]!.command!, /--tracked-by fix/); await commands(ns);
    await writeFile(flag, 'pass'); await ops.attest({ cwd: r.cwd, node: 'a' }); s = (await ops.readState(r)).state; ns = needs(s, 'a');
    assert.match(ns[0]!.text, /also fails on trunk.*flaky block #.*passed #/); assert.match(itemLine(s, 'a', 'check:unit'), /a pass does not erase a failure/); await commands(ns);
    // Remove the fix from the plan without touching a's candidate or check: commands cannot invent <fix>.
    const next = { ...s.plan, nodes: s.plan.nodes.filter(n => n.id !== 'fix') }; await ops.planSet({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify(next), note: 'retire tracker' });
    ns = needs((await ops.readState(r)).state, 'a'); assert.equal(ns[0]!.command, undefined); assert.match(ns[0]!.text, /no single command:.*add a fix node first/);
  } finally { await r.cleanup(); }
});


test('NE28 command words preserve literal check ids, rather than shell substitutions', async () => {
  const { needs } = await api(), r = await repo(), node = 'a', check = "unit $value'";
  try {
    await commitAt(r.cwd, { impl: 'base' });
    await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify({ version: 1, trunk: 'main', lease: false, closure: [], invariants: [], nodes: [{ id: node, writes: ['impl'], checks: [{ id: check, run: 'false', reads: ['impl'] }] }] }) });
    const a = await ops.dispatch({ cwd: r.cwd, as: parent, node }); await commitAt(a.worktree, { impl: 'candidate' }); await ops.submit({ cwd: a.worktree, as: { role: 'writer', id: `${node}#1` }, node }); await ops.attest({ cwd: r.cwd, node }); await ops.halt({ cwd: r.cwd, as: parent, node, attempt: 1, reason: 'stalled', needs: 'owner' });
    const ns = needs((await ops.readState(r)).state, node); assert.equal(ns.length, 1); assert.equal(words(ns[0]!.command!)[2], node); assert.equal(words(ns[0]!.command!)[3], 'check:' + check); await commands(ns);
  } finally { await r.cleanup(); }
});

// R-028-30: captured once by git archive 2a5f1a8 src, loading that cli.ts on the remote
// host with isolated HOME/XDG and a fresh uninitialized helper repo for every argv.
// One missing value/positional operand for every command, plus the six review findings.
const cliBaseline = [
  {
    "argv": [
      "edit",
      "a",
      "--expect",
      "bad"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: --expect must be report"
    ],
    "preIO": false
  },
  {
    "argv": [
      "review",
      "a",
      "--ok",
      "--rank",
      "bad",
      "--obligation",
      "bogus"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: Invalid review obligation"
    ],
    "preIO": false
  },
  {
    "argv": [
      "drive",
      "--status",
      "--max",
      "bad"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: --max is only valid with --detach, --once or the loop"
    ],
    "preIO": true
  },
  {
    "argv": [
      "report",
      "--metrics",
      "--cost",
      "--as",
      "bad"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: report takes --metrics, --counterfactual or --cost, not more than one"
    ],
    "preIO": true
  },
  {
    "argv": [
      "waive",
      "a",
      "check:stress",
      "--accept-risk",
      "bad"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: accept-risk must be a list of seq numbers"
    ],
    "preIO": false
  },
  {
    "argv": [
      "defer",
      "a",
      "health"
    ],
    "code": 1,
    "stdout": [],
    "stderr": [
      "Refused: Not initialized: run owed init <plan.yaml> first"
    ],
    "preIO": false
  },
  {
    "argv": [
      "start",
      "--max"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: --max requires a value"
    ],
    "preIO": true
  },
  {
    "argv": [
      "decide",
      "a"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: Required: --text"
    ],
    "preIO": false
  },
  {
    "argv": [
      "answer",
      "a"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: answer wrong number of arguments"
    ],
    "preIO": true
  },
  {
    "argv": [
      "init"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: init wrong number of arguments"
    ],
    "preIO": true
  },
  {
    "argv": [
      "plan"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: plan wrong number of arguments"
    ],
    "preIO": true
  },
  {
    "argv": [
      "amend"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: amend wrong number of arguments"
    ],
    "preIO": true
  },
  {
    "argv": [
      "edit",
      "a"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: Required: --note"
    ],
    "preIO": false
  },
  {
    "argv": [
      "rule",
      "text"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: Required: --nodes"
    ],
    "preIO": false
  },
  {
    "argv": [
      "dispatch"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: dispatch wrong number of arguments"
    ],
    "preIO": true
  },
  {
    "argv": [
      "submit"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: submit wrong number of arguments"
    ],
    "preIO": true
  },
  {
    "argv": [
      "rebase"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: rebase wrong number of arguments"
    ],
    "preIO": true
  },
  {
    "argv": [
      "attest"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: attest wrong number of arguments"
    ],
    "preIO": true
  },
  {
    "argv": [
      "review",
      "a",
      "--ok"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: Required: --rank"
    ],
    "preIO": false
  },
  {
    "argv": [
      "waive",
      "a",
      "check:stress"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: Required: --reason"
    ],
    "preIO": false
  },
  {
    "argv": [
      "defer",
      "a",
      "health"
    ],
    "code": 1,
    "stdout": [],
    "stderr": [
      "Refused: Not initialized: run owed init <plan.yaml> first"
    ],
    "preIO": false
  },
  {
    "argv": [
      "abandon"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: abandon wrong number of arguments"
    ],
    "preIO": true
  },
  {
    "argv": [
      "resume"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: resume wrong number of arguments"
    ],
    "preIO": true
  },
  {
    "argv": [
      "approve"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: approve wrong number of arguments"
    ],
    "preIO": true
  },
  {
    "argv": [
      "evidence",
      "a",
      "ui"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: Required: --note"
    ],
    "preIO": true
  },
  {
    "argv": [
      "merge"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: merge wrong number of arguments"
    ],
    "preIO": true
  },
  {
    "argv": [
      "adopt"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: Required: --note"
    ],
    "preIO": true
  },
  {
    "argv": [
      "sweep",
      "--commit"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: --commit requires a value"
    ],
    "preIO": true
  },
  {
    "argv": [
      "status",
      "--as"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: --as requires a value"
    ],
    "preIO": true
  },
  {
    "argv": [
      "idle",
      "--as"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: --as requires a value"
    ],
    "preIO": true
  },
  {
    "argv": [
      "why"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: why wrong number of arguments"
    ],
    "preIO": true
  },
  {
    "argv": [
      "report",
      "--since"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: --since requires a value"
    ],
    "preIO": true
  },
  {
    "argv": [
      "brief",
      "--since"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: --since requires a value"
    ],
    "preIO": true
  },
  {
    "argv": [
      "verify",
      "--as"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: --as requires a value"
    ],
    "preIO": true
  },
  {
    "argv": [
      "escape",
      "a"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: Required: --class"
    ],
    "preIO": false
  },
  {
    "argv": [
      "decoy",
      "digest"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: decoy wrong number of arguments"
    ],
    "preIO": true
  },
  {
    "argv": [
      "gc",
      "--as"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: --as requires a value"
    ],
    "preIO": true
  },
  {
    "argv": [
      "drive",
      "--max"
    ],
    "code": 2,
    "stdout": [],
    "stderr": [
      "Usage error: --max requires a value"
    ],
    "preIO": true
  }
];

test('NE29 R-028-30 frozen CLI output and pre-I/O boundary preserve the baseline ordering', async () => {
  await api(); const { main, validateArgv } = await grammar(), home = await repo();
  const original = { HOME: process.env.HOME, XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME, OWED_CONFIRM: process.env.OWED_CONFIRM };
  try {
    process.env.HOME = home.root; process.env.XDG_CONFIG_HOME = join(home.root, 'config'); delete process.env.OWED_CONFIRM;
    for (const row of cliBaseline) {
      const r = await repo(), cwd = process.cwd();
      try {
        process.chdir(r.cwd);
        const stdout: string[] = [], stderr: string[] = [];
        const code = await main(row.argv, { log: text => stdout.push(text), error: text => stderr.push(text) });
        assert.deepEqual({ code, stdout, stderr }, { code: row.code, stdout: row.stdout, stderr: row.stderr }, row.argv.join(' '));
        const jsonOut: string[] = [], jsonErr: string[] = [];
        const jsonCode = await main([...row.argv, '--json'], { log: text => jsonOut.push(text), error: text => jsonErr.push(text) });
        assert.deepEqual({ code: jsonCode, stdout: jsonOut, stderr: jsonErr }, { code: row.code, stdout: [JSON.stringify({ error: row.stderr[0]!.replace(/^(Usage error|Refused): /, ''), code: row.code === 1 ? 'refused' : 'usage' })], stderr: row.stderr }, `JSON ${row.argv.join(' ')}`);
        if (row.preIO) assert.throws(() => validateArgv(row.argv), (e: unknown) => !!e && typeof e === 'object' && 'code' in e && e.code === 'usage' && 'message' in e && `Usage error: ${e.message}` === row.stderr[0]);
        else assert.doesNotThrow(() => validateArgv(row.argv), row.argv.join(' '));
      } finally { process.chdir(cwd); await r.cleanup(); }
    }
  } finally {
    for (const [key, value] of Object.entries(original)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await home.cleanup();
  }
});

test('NE30 R-028-30 removed open-slot approval keeps the frozen empty baseline membership', async () => {
  const { needs } = await api(), r = await repo();
  try {
    await commitAt(r.cwd, { impl: 'base' });
    const plan = { version: 1, trunk: 'main', lease: false, closure: [], invariants: [], nodes: [{ id: 'a', writes: ['impl'], checks: [], review: { count: 0, min_rank: 1 }, approve: 'owner' }] };
    await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify(plan) });
    const a = await ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' }); await commitAt(a.worktree, { impl: 'candidate' }); await ops.submit({ cwd: a.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
    assert.equal(needs((await ops.readState(r)).state, 'a')[0]!.kind, 'approve');
    await ops.planSet({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify({ ...plan, nodes: [] }), note: 'retire open candidate' });
    const s = (await ops.readState(r)).state;
    assert.equal(s.nodes.a!.phase, 'removed'); assert.equal(s.nodes.a!.slot!.open, true);
    for (const driverRunning of [false, true]) {
      assert.deepEqual(statusView(s, [...entriesOf(s)], [], now, driverRunning).summary!.needs, []);
      assert.deepEqual(needs(s, 'a', { driverRunning }), []);
    }
  } finally { await r.cleanup(); }
});

test('NE31 R-028-30 high-rank itemLine names a sufficient owner act that discharges the review', async () => {
  const { needs, itemLine } = await api();
  for (const rank of [3]) {
    const r = await repo();
    try {
      await commitAt(r.cwd, { impl: 'base' });
      await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify({ version: 1, trunk: 'main', lease: false, closure: [], invariants: [], nodes: [{ id: 'a', writes: ['impl'], checks: [], review: { count: 1, min_rank: rank } }] }) });
      const a = await ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' }); await commitAt(a.worktree, { impl: 'candidate' }); await ops.submit({ cwd: a.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } }); await ops.attest({ cwd: r.cwd, node: 'a' });
      const s = (await ops.readState(r)).state, c = s.nodes.a!.candidate!;
      assert.deepEqual(needs(s, 'a'), []);
      const line = itemLine(s, 'a', 'review'), command = `owed review a --ok --rank ${rank} --candidate ${c.commit.slice(0, 12)} --note "<note>" --ack-rulings latest --as owner:<id>`;
      assert.equal(line, `${s.nodes.a!.items.find(i => i.obligation === 'review')!.detail}; an owner records ${command}`);
      const result = await cli(r.cwd, words(command).slice(1).map(w => w === 'owner:<id>' ? 'owner:pi' : w)); assert.equal(result.code, 0, result.stderr);
      const after = (await ops.readState(r)).state;
      assert.equal(after.nodes.a!.items.find(i => i.obligation === 'review')!.status, 'E'); assert.equal(after.nodes.a!.accepted, true);
    } finally { await r.cleanup(); }
  }
});

test('NE32 R-028-30 a$HOME is a literal shell word in every itemLine command route', async () => {
  const { needs, itemLine } = await api(), r = rig({ review: { count: 1, min_rank: 3 } }), node = 'a$HOME';
  // The plan accepts this id; ops.dispatch's independent worktree-path restriction remains unchanged.
  // Rebuild the same valid synthetic ledger under that id to test the pure command renderer.
  const state = () => reduce(r.entries.map(e => ({ ...e,
    ...( 'node' in e && e.node === 'a' ? { node } : {}),
    ...( 'subject' in e && e.subject === 'a' ? { subject: node } : {}),
    by: e.by === 'writer:a#1' ? `writer:${node}#1` : e.by,
  } as Entry)), () => ({ ...r.state().plan, nodes: r.state().plan.nodes.map(n => n.id === 'a' ? { ...n, id: node } : n) }));
  let s = state();
  assert.equal(itemLine(s, node, 'check:stress'), `check:stress awaiting observation → owed attest 'a$HOME'`);
  assert.ok(itemLine(s, node, 'review').includes(`owed review 'a$HOME' --ok --rank 3`));
  r.obs('check:stress', 'fail'); s = state();
  assert.ok(itemLine(s, node, 'check:stress').includes(`owed submit 'a$HOME', then owed attest 'a$HOME'`));
  r.halt(); const ns = needs(state(), node);
  assert.match(ns[0]!.command!, /^owed waive 'a\$HOME' check:stress /); await commands(ns);
  r.flaky(); assert.ok(itemLine(state(), node, 'check:stress').includes(`owed waive 'a$HOME' check:stress`));
  const missing = summaryRig(); missing.add(node, 'dispatched', [missing.item(node, 'submit', 'writer')]);
  assert.ok(itemLine(missing.s, node, 'submit').includes(`owed submit 'a$HOME'`));
});
