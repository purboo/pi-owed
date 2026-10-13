// 0.11 F5: explicit writer rulings invalidate candidates; merge refusal respects a concurrent resume --after.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';
import { sha256 } from '../src/canon.ts';
import { decide, type Action } from '../src/drive.ts';
import { Driver, type ActionReport } from '../src/drive-run.ts';
import { Dsa } from '../src/dsa.ts';
import { Ledger } from '../src/ledger.ts';
import * as ops from '../src/ops.ts';
import { reduce, runId, runLabels, validateDraft } from '../src/reducer.ts';
import type { CandidateFacts, Draft, Entry, Plan, RunView } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';
delete process.env.OWED_CONFIRM;

const parent = { role: 'parent', id: 'test' } as const;
const owner = { role: 'owner', id: 'test' } as const;
const plan: Plan = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: ['a', 'b'].map(id => ({ id, deps: [], writes: [`${id}.txt`], checks: [], review: { count: 1, min_rank: 1 } })) };
const W = runId('hash0', 'a', 1, 'writer');
const R = runId('hash0', 'a', 1, 'reviewer', 1);
function rig() {
  const entries: Entry[] = [], blobs = new Map<string, string>();
  const state = () => reduce(entries, () => plan);
  const add = (d: Draft) => {
    assert.deepEqual(validateDraft(state(), d), [], JSON.stringify(d));
    const seq = entries.length, e = { ...d, seq, ts: new Date(1767225600000 + seq * 1000).toISOString(), prev: 'x', hash: `hash${seq}` } as Entry;
    entries.push(e); return e;
  };
  const blob = (s: string) => { const key = sha256(s); blobs.set(key, s); return key; };
  const facts: CandidateFacts = { commit: 'a'.repeat(40), tree: 't1', base: 's0', patch: 'p1', changed: ['a.txt'], closureTouched: false, keys: { writes: 'kw', review: 'kr', rulings: 'ku' } };
  const submit = () => add({ kind: 'submit', by: 'writer:a#1', node: 'a', attempt: 1, facts });
  const rule = (writer?: boolean, nodes: string[] | '*' = ['a']) => add({ kind: 'rule', by: 'parent:test', nodes, text: 'cover the empty registry', ...(writer !== undefined ? { writer } : {}) } as Draft);
  const record = (a: Action) => {
    assert.equal(a.do, 'send'); if (a.do !== 'send') throw new Error('send expected');
    return add({ kind: 'send', by: 'parent:drive', node: a.node, attempt: a.attempt, rid: a.rid, send: `${a.rid}:${a.sendKind}:${entries.length}`, sendKind: a.sendKind, message: blob(a.message), reason: a.reason, rulings: a.rulings });
  };
  const act = (writerState: RunView['state'] = 'sealed') => {
    const s = state();
    return decide(s, s.plan, new Map([[W, { rid: W, state: writerState, status: 'ok' }], [R, { rid: R, state: 'running' }]]), { max: 2, repairs: 2, project: 'hash0', root: '/repo', blobs, applied: new Set(entries.flatMap(e => e.kind === 'send' ? [e.send] : [])), rejected: new Map() }).find(a => a.node === 'a');
  };
  add({ kind: 'genesis', by: 'owner:test', channel: 'flag', plan: 'p', trunk: 'main', commit: 's0', state: { commit: 's0', tree: 't0', invKeys: {} } });
  add({ kind: 'dispatch', by: 'parent:test', node: 'a', attempt: 1, base: 's0', branch: 'owed/a/1', worktree: '/repo/a', packet: blob('packet'), rulings_seen: -1 });
  add({ kind: 'launch', by: 'parent:drive', node: 'a', attempt: 1, role: 'writer', rid: W, spec: blob('spec'), labels: runLabels('hash0', 'a', 1, 'writer'), rulings: 0 });
  submit();
  add({ kind: 'obs', by: 'executor:owed', subject: 'a', obligation: 'writes', key: 'kw', verdict: 'pass', exit: 0, durationMs: 1, commit: facts.commit, base: facts.base });
  add({ kind: 'launch', by: 'parent:drive', node: 'a', attempt: 1, role: 'reviewer', rid: R, spec: blob('review'), labels: runLabels('hash0', 'a', 1, 'reviewer'), rulings: 0 });
  const review = (ack?: number) => add({ kind: 'review', by: 'reviewer:test', node: 'a', attempt: 1, obligation: 'review', key: 'kr', verdict: 'ok', rank: 1, ...(ack !== undefined ? { ack_rulings: ack } : {}) });
  review();
  return { entries, state, add, submit, rule, act, record, review };
}

test('F5 writer ruling invalidates only a named open candidate; same commit resubmits and reviewers still ack', () => {
  const r = rig(), first = r.state().nodes.a!.candidate!;
  assert.equal(r.state().nodes.a!.accepted, true);
  const ruling = r.rule(true);
  assert.equal(r.state().nodes.a!.candidate, undefined);
  assert.equal(r.state().nodes.a!.phase, 'dispatched');
  assert.equal((r.state().rules.at(-1) as { writer?: boolean }).writer, true);
  r.submit();
  assert.equal(r.state().nodes.a!.candidate!.commit, first.commit);
  assert.ok(r.state().nodes.a!.candidate!.seq > first.seq);
  assert.equal(r.state().nodes.a!.items.find(i => i.obligation === 'rulings')!.status, 'D');
  r.review(ruling.seq);
  assert.equal(r.state().nodes.a!.accepted, true);
});

test('F5 ordinary, false, wildcard and other-node rulings keep the candidate; pre-submit writer rulings do not invalidate later submits', () => {
  const r = rig(), seq = r.state().nodes.a!.candidate!.seq;
  r.rule(); r.rule(false); r.rule(true, '*'); r.rule(true, ['b']);
  assert.equal(r.state().nodes.a!.candidate!.seq, seq);
  r.rule(true); assert.equal(r.state().nodes.a!.candidate, undefined);
  r.submit();
  assert.ok(r.state().nodes.a!.candidate);
  const invalid = { kind: 'rule', by: 'parent:test', nodes: ['a'], text: 'bad', writer: 'yes' } as unknown as Draft;
  assert.ok(validateDraft(r.state(), invalid).some(x => x.includes('writer must be a boolean')));
});

test('F5 sealed writer gets one ruling follow-up even while its obsolete reviewer runs; no resubmit halts', () => {
  const r = rig(), rule = r.rule(true), a = r.act();
  assert.ok(a?.do === 'send' && a.rid === W && a.reason === 'ruling' && a.sendKind === 'follow-up', JSON.stringify(a));
  assert.equal(a.rulings, rule.seq); assert.match(a.message, /cover the empty registry/);
  assert.match(a.message, /owed submit a/);
  r.record(a);
  const next = r.act();
  assert.ok(next?.do === 'halt' && /ruling follow-up.*without submitting/.test(next.reason), JSON.stringify(next));
  assert.equal(r.state().nodes.a!.candidate, undefined);
});

test('F5 resume after a writer-ruling halt sends the writer the ruling again instead of repeating the halt', () => {
  const r = rig(), rule = r.rule(true), first = r.act();
  assert.ok(first?.do === 'send' && first.reason === 'ruling');
  r.record(first);
  const h = r.act();
  assert.ok(h?.do === 'halt', JSON.stringify(h));
  if (h?.do !== 'halt') return;
  r.add({ kind: 'halt', by: 'parent:drive', node: 'a', attempt: 1, reason: h.reason, needs: h.needs } as Draft);
  assert.equal(r.act(), undefined, 'halted');
  r.add({ kind: 'resume', by: 'parent:test', node: 'a', attempt: 1, note: 'try again' } as Draft);
  const again = r.act();
  assert.ok(again?.do === 'send' && again.rid === W && again.reason === 'ruling' && again.sendKind === 'follow-up', JSON.stringify(again));
  assert.equal(again.rulings, rule.seq);
  assert.match(again.message, /The parent resumed this node/);
  assert.match(again.message, /cover the empty registry/);
  r.record(again);
  assert.equal(r.act()?.do, 'halt', 'a second silent seal after the fresh follow-up halts again');
});

test('F5 running writer gets a ruling steer once, then the same commit can resume the review route', () => {
  const r = rig(), rule = r.rule(true), a = r.act('running');
  assert.equal(r.state().nodes.a!.candidate, undefined);
  assert.ok(a?.do === 'send' && a.rid === W && a.reason === 'ruling' && a.sendKind === 'steer', JSON.stringify(a));
  assert.equal(a.rulings, rule.seq); assert.match(a.message, /cover the empty registry/);
  r.record(a); assert.equal(r.act('running'), undefined);
  r.submit();
  const next = r.act();
  // RR1: unchanged keys carry the original reviewer; deliver its outstanding ruling instead of launching again.
  assert.ok(next?.do === 'send' && next.rid === R && next.reason === 'ruling' && next.sendKind === 'steer', JSON.stringify(next));
  assert.equal(next.rulings, rule.seq);
});

test('F5 ordinary ruling keeps the accepted content and goes to the running reviewer', () => {
  const r = rig(), rule = r.rule(), a = r.act();
  assert.ok(r.state().nodes.a!.candidate);
  assert.ok(a?.do === 'send' && a.rid === R && a.reason === 'ruling' && a.sendKind === 'steer', JSON.stringify(a));
  assert.equal(a.rulings, rule.seq);
});

async function fixture(p: object = plan) {
  const r = await repo();
  await r.put('plan.json', JSON.stringify(p)); await r.commit();
  await ops.init({ cwd: r.cwd, as: owner, channel: 'flag', plan: JSON.stringify(p) });
  const slot = await ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' });
  const commit = await commitAt(slot.worktree, { 'a.txt': 'a\n' });
  const submit = () => ops.submit({ cwd: slot.worktree, as: { role: 'writer', id: 'a#1' }, node: 'a' });
  await submit();
  return { ...r, slot, commit, submit };
}

test('F5 CLI --writer records the flag and invalidates the candidate; same-commit submit is allowed', { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    const out = await cli(f.cwd, ['rule', 'cover the empty registry', '--nodes', 'a', '--writer', '--json']);
    assert.equal(out.code, 0, out.stderr);
    const entry = JSON.parse(out.stdout) as { writer?: boolean };
    assert.equal(entry.writer, true);
    assert.equal((await ops.status({ cwd: f.cwd })).nodes.a!.candidate, undefined);
    await f.submit();
    assert.equal((await ops.status({ cwd: f.cwd })).nodes.a!.candidate!.commit, f.commit);
  } finally { await f.cleanup(); }
});

test('F5 owed_rule exposes writer and records it through the tool', { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    const tools = new Map<string, ToolDefinition>();
    owed({ registerTool(t: ToolDefinition) { tools.set(t.name, t); }, registerCommand() {} } as unknown as ExtensionAPI);
    const tool = tools.get('owed_rule')!;
    assert.ok('writer' in (tool.parameters as { properties: object }).properties);
    const ctx = { cwd: f.cwd, hasUI: false } as ExtensionContext;
    const result = await tool.execute('route', { cwd: f.cwd, as: 'parent:test', text: 'cover the empty registry', nodes: ['a'], writer: true }, undefined, undefined, ctx as Parameters<ToolDefinition['execute']>[4]);
    assert.ok(!(result as { isError?: boolean }).isError, JSON.stringify(result));
    const entry = (await (await Ledger.open(f.cwd)).read()).at(-1)!;
    assert.equal(entry.kind, 'rule'); assert.equal((entry as { writer?: boolean }).writer, true);
    assert.equal((await ops.status({ cwd: f.cwd })).nodes.a!.candidate, undefined);
  } finally { await f.cleanup(); }
});

async function until(cond: () => boolean, what: string) {
  const end = Date.now() + 30_000;
  while (Date.now() < end) { if (cond()) return; await new Promise(r => setTimeout(r, 25)); }
  assert.fail(`timed out: ${what}`);
}

// Gate a real invariant measurement: resume is committed after the merge starts and before it refuses.
async function refusedMerge(mode: 'wait' | 'reap-wait' | 'ruling' | 'halt') {
  const wait = mode === 'wait' || mode === 'reap-wait';
  const r = await repo();
  const mark = join(r.root, 'mark'), gate = join(r.root, 'gate');
  const p = { ...plan, nodes: plan.nodes.map(n => ({ ...n, review: { count: 0, min_rank: 1 } })), invariants: [{ id: 'gate', reads: ['a.txt'], timeout_s: 45, run: `if [ -f a.txt ]; then touch '${mark}'; while [ ! -f '${gate}' ]; do sleep 0.05; done; exit 1; fi` }] };
  let driver: Driver | undefined;
  try {
    await r.put('plan.json', JSON.stringify(p)); await r.commit();
    await ops.init({ cwd: r.cwd, as: owner, channel: 'flag', plan: JSON.stringify(p) });
    const slot = await ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' });
    await commitAt(slot.worktree, { 'a.txt': 'a\n' });
    await ops.submit({ cwd: slot.worktree, as: { role: 'writer', id: 'a#1' }, node: 'a' });
    await ops.attest({ cwd: r.cwd, node: 'a' });
    const ledger = await Ledger.open(r.cwd);
    const s = await ops.status({ cwd: r.cwd });
    assert.equal(s.nodes.a!.accepted, true);
    // Record the writer launch through the real op; describe is deterministic and does not start any process.
    const project = (await ledger.read())[0]!.hash.slice(0, 12);
    await ops.launch({ cwd: r.cwd, as: { role: 'parent', id: 'drive' }, node: 'a', attempt: 1, role: 'writer', rid: runId(project, 'a', 1, 'writer'), spec: '{}', labels: runLabels(project, 'a', 1, 'writer') });
    class Sealed extends Dsa { override async inspect(rid: string) { return { view: { rid, state: 'sealed', status: 'ok' } as RunView }; } }
    const lines: string[] = [];
    driver = new Driver({ cwd: r.cwd, log: l => lines.push(l), dsa: new Sealed(), session: null, max: 1 });
    await driver.pass();
    await until(() => existsSync(mark), 'merge invariant started');
    if (mode === 'wait') await ops.resume({ cwd: r.cwd, as: parent, node: 'a', after: 'b', note: 'wait for prerequisite fix' });
    if (mode === 'ruling') await ops.rule({ cwd: r.cwd, as: parent, nodes: ['a'], text: 'fix before merging', writer: true });
    await writeFile(gate, '');
    if (mode === 'reap-wait') {
      assert.equal(await driver.drain(30_000), true, 'merge finished before resume, but has not been reaped');
      await ops.resume({ cwd: r.cwd, as: parent, node: 'a', after: 'b', note: 'wait before handling refusal' });
    }
    const reports: ActionReport[] = [];
    await driver.settle(reports);
    const entries = await ledger.read();
    const halts = entries.filter(e => e.kind === 'halt' && e.node === 'a');
    assert.equal(reports.find(x => x.do === 'merge')?.outcome, wait ? 'waiting' : mode === 'ruling' ? 'retry' : 'refused', JSON.stringify(reports));
    assert.equal(halts.length, mode === 'halt' ? 1 : 0);
    assert.equal(entries.some(e => e.kind === 'obs' && e.obligation === 'inv:gate' && e.verdict === 'fail'), mode !== 'ruling');
    if (mode === 'ruling') assert.equal((await ops.status({ cwd: r.cwd })).nodes.a!.candidate, undefined);
    assert.ok(!entries.some(e => e.kind === 'merge' && e.node === 'a'));
    if (wait) {
      assert.equal((await ops.status({ cwd: r.cwd })).waiting?.find(w => w.node === 'a')?.after, 'b');
      assert.match(reports.find(x => x.do === 'merge')!.detail!, /waits for b/);
      assert.ok(!(await driver.pass()).actions.some(a => a.node === 'a'));
    }
  } finally { await writeFile(gate, ''); await driver?.settle(); await r.cleanup(); }
}

test('F5 resume --after during a refused merge reports waiting, retains observations and never halts', { timeout: 90_000 }, () => refusedMerge('wait'));
test('F5 resume --after before a completed refusal is reaped also reports waiting', { timeout: 90_000 }, () => refusedMerge('reap-wait'));
test('F5 writer ruling during merge invalidates its measured candidate and prevents merge or halt', { timeout: 90_000 }, () => refusedMerge('ruling'));
test('F5 a refused merge without a wait still halts', { timeout: 90_000 }, () => refusedMerge('halt'));
