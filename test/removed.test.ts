// F4 (contract 0.11, field report #27, #33c, #31, #34): removed nodes and small routing fixes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decide, type DriveOpts } from '../src/drive.ts';
import { reduce, runId, validateDraft } from '../src/reducer.ts';
import { Dsa, DsaError, type RunResult, type SendResult } from '../src/dsa.ts';
import { receipt, renderReceipt, renderStatusFull as renderStatus, statusView } from '../src/views.ts';
import { Driver, stateOf } from '../src/drive-run.ts';
import { loopWarnings } from '../src/plan.ts';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import type { Draft, Entry, NodeSpec, Plan, RunView, State } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { commitAt } from './helpers/surface.ts';

// ---------- synthetic ledger rig (no git): plans by sha, so a node can leave and rejoin the plan ----------
const P = 'hash0';
const T0 = Date.UTC(2026, 0, 1);
const iso = (seq: number) => new Date(T0 + seq * 1000).toISOString();
const spec = (o: Partial<NodeSpec> & { id: string }): NodeSpec => ({ deps: [], writes: [`${o.id}/`], checks: [], review: { count: 0, min_rank: 1 }, ...o });
const planOf = (...ids: string[]): Plan => ({ version: 1, trunk: 'main', closure: [], invariants: [], drive: { max: 4, repairs: 2, writer: { agent: 'worker' }, reviewer: { agent: 'reviewer' } }, nodes: ids.map(id => spec({ id })) });

function rig() {
  const entries: Entry[] = [], plans: Record<string, Plan> = { p1: planOf('a', 'b') };
  const state = (): State => reduce(entries, sha => plans[sha]!);
  const add = (d: Draft): Entry => { const seq = entries.length, e = { ...d, seq, ts: iso(seq), prev: 'x', hash: `hash${seq}` } as Entry; entries.push(e); state(); return e; };
  add({ kind: 'genesis', by: 'owner:human', channel: 'tty', plan: 'p1', trunk: 'main', commit: 's0', state: { commit: 's0', tree: 't0', invKeys: {} } });
  return {
    entries, state, add,
    replan(...ids: string[]) { const sha = `p${Object.keys(plans).length + 1}`; plans[sha] = planOf(...ids); return add({ kind: 'plan', by: 'owner:human', channel: 'tty', prior: state().planSha, plan: sha, downgrades: [] }); },
    dispatchDraft(node: string): Draft { return { kind: 'dispatch', by: 'parent:drive', node, attempt: (state().nodes[node]?.slot?.attempt ?? 0) + 1, base: 's0', branch: `owed/${node}/1`, worktree: `/repo/.owed/wt/${node}-1`, packet: 'blob', rulings_seen: -1 }; },
  };
}
const optsOf = (o: Partial<DriveOpts> = {}): DriveOpts => ({ max: 4, repairs: 2, project: P, root: '/repo', applied: new Set(), rejected: new Map(), blobs: new Map(), ...o });

test('F4.1 (#27): a ready node removed from the plan is `removed`: not ready, not pending, shown as removed, never dispatched', () => {
  const r = rig();
  assert.equal(r.state().nodes.b!.phase, 'ready');
  r.replan('a');
  const s = r.state();
  assert.equal(s.nodes.b!.phase, 'removed');
  assert.equal(s.nodes.a!.phase, 'ready');
  const v = statusView(s, r.entries);
  assert.deepEqual(v.ready, ['a']);
  assert.deepEqual(v.groups.removed, ['b']);
  assert.ok(!v.pending['parent+writer']!.some(i => i.subject === 'b'), 'no "parent can dispatch work" for b');
  assert.match(renderStatus(v), /\nremoved from the plan: b\n/);
  assert.match(renderReceipt(receipt(s, r.entries, 'b')), /^b: removed from the plan\n/);
  // The driver dispatches nothing for b (`drive --once` after removing a ready node).
  assert.deepEqual(decide(s, s.plan, new Map(), optsOf()).map(x => `${x.do} ${x.node}`), ['dispatch a']);
  assert.deepEqual(decide(s, s.plan, new Map(), optsOf()).filter(x => x.node === 'b'), []);
  // dispatch refuses it, naming why.
  assert.match(validateDraft(s, r.dispatchDraft('b')).join('; '), /dispatch requires a ready node with no open slot/);
  // Added back, it is ready again.
  r.replan('a', 'b');
  assert.equal(r.state().nodes.b!.phase, 'ready');
  assert.deepEqual(validateDraft(r.state(), r.dispatchDraft('b')), []);
});

test('F4.1: a removed node with an open slot gets no driver action; it does not count as open for the driver', () => {
  const r = rig();
  r.add(r.dispatchDraft('b'));
  let s = r.state();
  assert.equal(s.nodes.b!.phase, 'dispatched');
  assert.deepEqual(decide(s, s.plan, new Map(), optsOf()).filter(x => x.node === 'b').map(x => x.do), ['launch'], 'precondition: the writer would be launched');
  r.replan('a');
  s = r.state();
  assert.equal(s.nodes.b!.phase, 'removed');
  assert.deepEqual(decide(s, s.plan, new Map(), optsOf()).filter(x => x.node === 'b'), []);
  assert.deepEqual(statusView(s, r.entries).groups.removed, ['b']);
});

test('F4.1: a merged node absent from the plan stays merged', () => {
  const r = rig();
  r.add(r.dispatchDraft('b'));
  const facts = { commit: 'bc1', tree: 'tb', base: 's0', patch: 'pb', changed: ['b/x'], closureTouched: false, keys: { writes: 'b-w', rulings: 'b-r' } };
  r.add({ kind: 'submit', by: 'writer:b#1', node: 'b', attempt: 1, facts });
  r.add({ kind: 'obs', by: 'executor:owed', subject: 'b', obligation: 'writes', key: 'b-w', verdict: 'pass', exit: 0, durationMs: 1, commit: 'bc1', base: 's0' });
  const m = 'c0ffee'.padEnd(40, '0');
  r.add({ kind: 'merge', by: 'executor:owed', node: 'b', attempt: 1, prior: 's0', commit: m, facts: { ...facts, commit: m, tree: 'tm', keys: { ...facts.keys, writes: 'b-wm' } }, state: { commit: m, tree: 'tm', invKeys: {} } });
  assert.equal(r.state().nodes.b!.phase, 'merged');
  r.replan('a');
  assert.equal(r.state().nodes.b!.phase, 'merged');
});

test('F4.4 (#31): the min_tests loop warning skips cargo test loops; other loops still warn', () => {
  const plan = planOf('a', 'b');
  plan.nodes[0]!.checks = [{ id: 'flake', run: 'for i in $(seq 1 20); do cargo test -p x lock_wait; done', timeout_s: 60, reads: ['a/**'], min_tests: 20 }];
  plan.nodes[1]!.checks = [{ id: 'loop', run: 'for i in 1 2 3; do npm test; done', timeout_s: 60, reads: ['b/**'], min_tests: 3 }];
  assert.deepEqual(loopWarnings(plan).map(w => w.slice(0, w.indexOf(' runs'))), ['warning: check loop of node b']);
  plan.nodes[0]!.checks[0]!.run = 'for i in $(seq 1 3); do cargo +nightly test; done';
  assert.equal(loopWarnings(plan).length, 1);
  assert.deepEqual(loopWarnings(plan, new Set(['b'])), [], 'merged nodes are skipped too');
});

// ---------- git-backed driver rig: node a dispatched, b depends on a ----------
const parent = { role: 'parent' as const, id: 'main' };
async function driverRig(review = 0) {
  const r = await repo();
  await commitAt(r.cwd, { README: 'x\n' });
  const nodeOf = (id: string, deps: string[] = []) => ({ id, deps, writes: [`${id}/`], checks: [], review: { count: review, min_rank: 1 } });
  await ops.init({ cwd: r.cwd, plan: JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [], nodes: [nodeOf('a'), nodeOf('b', ['a'])] }), as: { role: 'owner', id: 'human' }, channel: 'flag' });
  const d = await ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' });
  return { ...r, worktree: d.worktree };
}
/** A dsa whose runs launch; `inspect` and `send` are scripted per test. */
class Scripted extends Dsa {
  inspects = 0;
  readonly view: (rid: string, call: number) => RunView; readonly onSend: () => Promise<SendResult>;
  constructor(view: (rid: string, call: number) => RunView, onSend: () => Promise<SendResult> = async () => ({ outcome: 'applied', spec_digest: '' })) { super({ bin: '/nonexistent/dsa' }); this.view = view; this.onSend = onSend; }
  override async run(rid: string): Promise<RunResult> { return { outcome: 'applied', wid: 'w1', created: true, spec_digest: rid }; }
  override async inspect(rid: string): Promise<{ view: RunView; gen?: number }> { return { view: this.view(rid, ++this.inspects) }; }
  override async send(): Promise<SendResult> { return this.onSend(); }
}
const timedOut = (rid: string) => new DsaError(`dsa describe ${rid} timed out`);

test('F4.3 (#31): a send that fails names node, kind, reason and target in its notice', { timeout: 120_000 }, async () => {
  const r = await driverRig();
  try {
    const dsa = new Scripted(rid => ({ rid, state: 'sealed', status: 'ok' }), async () => { throw new DsaError('timed out waiting for the ledger lock held by pid 1; retry'); });
    const lines: string[] = [], json: string[] = [];
    const d = new Driver({ cwd: r.cwd, log: l => lines.push(l), dsa, session: null, handleSignals: false });
    await d.pass();                    // launches a's writer
    await commitAt((await stateOf(r.cwd)).nodes.a!.slot!.worktree, { 'a.txt': 'work to submit\n' });
    const p = await d.pass();          // the writer sealed without a candidate: a submit follow-up, whose send fails
    const fail = p.actions.find(a => a.do === 'send');
    assert.ok(fail, lines.join('\n'));
    assert.equal(fail.outcome, 'error');
    assert.deepEqual({ node: fail.node, sendKind: fail.sendKind, reason: fail.reason, rid: fail.rid }, { node: 'a', sendKind: 'follow-up', reason: 'submit', rid: runId(d.project!, 'a', 1, 'writer') });
    assert.ok(!lines.some(l => /undefined/.test(l)), lines.join('\n'));
    assert.ok(lines.some(l => l.startsWith(`send follow-up (submit) for node a to ${runId(d.project!, 'a', 1, 'writer')}: error — timed out waiting for the ledger lock`)), lines.join('\n'));
    await new Driver({ cwd: r.cwd, json: true, log: l => json.push(l), dsa, session: null, handleSignals: false }).pass();
    const j = json.map(l => JSON.parse(l)).find(x => x.do === 'send');
    assert.ok(j && j.node === 'a' && j.sendKind === 'follow-up' && typeof j.rid === 'string', json.join('\n'));
  } finally { await r.cleanup(); }
});

test('F4.5 (#34) / HT1: a describe that still times out after the client retries is transient: one log line, no describe-failed notify', { timeout: 120_000 }, async () => {
  const r = await driverRig();
  try {
    let fail = 0;
    const dsa = new Scripted((rid, call) => { if (call <= fail) throw timedOut(rid); return { rid, state: 'running' }; });
    const lines: string[] = [];
    const d = new Driver({ cwd: r.cwd, log: l => lines.push(l), dsa, session: null, handleSignals: false });
    await d.pass();                    // launch
    fail = dsa.inspects + 1;           // the next describe times out (after the client's own retries, HT1)
    const before = dsa.inspects;
    await d.pass();
    assert.equal(dsa.inspects - before, 1, 'HT1: the client retries reads; the driver does not describe again');
    assert.ok(!lines.some(l => /describe-failed/.test(l)), lines.join('\n'));
    assert.equal(lines.filter(l => /^dsa read unavailable: describe \S+: dsa describe \S+ timed out$/.test(l)).length, 1, lines.join('\n'));
    // Still timing out: no notify, and the streak's line is not repeated.
    fail = Infinity;
    const at = dsa.inspects, n = lines.length;
    await d.pass();
    assert.equal(dsa.inspects - at, 1);
    assert.ok(!lines.slice(n).some(l => /describe-failed|dsa read unavailable/.test(l)), lines.join('\n'));
  } finally { await r.cleanup(); }
});

test('F4.5 (#34): a describe failure of a node waiting after resume --after notifies nobody', { timeout: 120_000 }, async () => {
  const r = await driverRig();
  try {
    let fail = false;
    const dsa = new Scripted((rid) => { if (fail) throw timedOut(rid); return { rid, state: 'running' }; });
    const lines: string[] = [];
    const d = new Driver({ cwd: r.cwd, log: l => lines.push(l), dsa, session: null, handleSignals: false });
    await d.pass();                    // launch
    await ops.resume({ cwd: r.cwd, as: parent, channel: 'flag', node: 'a', after: 'b' });
    fail = true;
    const p = await d.pass();
    assert.deepEqual(p.waiting.map(w => w.node), ['a']);
    assert.ok(dsa.inspects >= 1, 'the waiting node is still described (asking runs are reported); HT1: the client, not the driver, retries');
    assert.ok(!lines.some(l => /describe-failed/.test(l)), lines.join('\n'));
    assert.ok(!p.actions.some(a => a.outcome === 'describe-failed'));
  } finally { await r.cleanup(); }
});

test('F4.2 (#33c): resume refuses while a needs-parent review block awaits a ruling; a ruling lets it through', { timeout: 120_000 }, async () => {
  const r = await driverRig(1);
  try {
    await commitAt(r.worktree, { 'a/x': 'a\n' });
    await ops.submit({ cwd: r.worktree, as: { role: 'writer', id: 'a#1' }, node: 'a' });
    const block = await ops.review({ cwd: r.worktree, node: 'a', as: { role: 'reviewer', id: 'rev' }, verdict: 'block', rank: 1, note: 'which contract?', needs: 'parent' });
    const count = async () => (await (await Ledger.open(r.cwd)).read()).length;
    const n0 = await count();
    for (const after of [undefined, 'b']) {
      await assert.rejects(ops.resume({ cwd: r.cwd, as: parent, channel: 'flag', node: 'a', ...(after ? { after } : {}) }), (e: Error) => {
        assert.match(e.message, new RegExp(`resume refused: a needs a parent ruling \\(review block #${block.seq} review\\).*review asks: which contract\\? → owed decide a --text "<ruling>" --writer`));
        return true;
      });
    }
    assert.equal(await count(), n0, 'nothing recorded');
    await ops.rule({ cwd: r.cwd, as: parent, channel: 'flag', text: 'use contract X', nodes: ['a'] });
    const ok = await ops.resume({ cwd: r.cwd, as: parent, channel: 'flag', node: 'a', note: 'go on' });
    assert.equal(ok.entry.kind, 'resume');
  } finally { await r.cleanup(); }
});

test('F4.2: resume without a needs-parent block is unchanged (a plain block does not refuse)', { timeout: 120_000 }, async () => {
  const r = await driverRig(1);
  try {
    await commitAt(r.worktree, { 'a/x': 'a\n' });
    await ops.submit({ cwd: r.worktree, as: { role: 'writer', id: 'a#1' }, node: 'a' });
    await ops.review({ cwd: r.worktree, node: 'a', as: { role: 'reviewer', id: 'rev' }, verdict: 'block', rank: 1, note: 'fix x' });
    const ok = await ops.resume({ cwd: r.cwd, as: parent, channel: 'flag', node: 'a' });
    assert.equal(ok.entry.kind, 'resume');
  } finally { await r.cleanup(); }
});
