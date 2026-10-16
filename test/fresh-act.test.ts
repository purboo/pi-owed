// F1 (0.11, wais #35): the driver acts only on a current state. A driver act decided on a state (halt, send, launch,
// rebase) records nothing when another principal's entry on the node landed after it (code `stale`); a reviewer run that
// sealed without its verdict gets one `verdict` follow-up before the review-missing halt; the asking notify ends with
// the ruling hint.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { Dsa } from '../src/dsa.ts';
import type { RunResult, SendKind, SendResult, EventsResult } from '../src/dsa.ts';
import { drive, stateOf, wakeReport, DRIVE_PRINCIPAL } from '../src/drive-run.ts';
import { projectId, runId, runLabels } from '../src/reducer.ts';
import { OwedError } from '../src/errors.ts';
import type { Entry, RunView } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { commitAt } from './helpers/surface.ts';

const owner = { role: 'owner', id: 'human' } as const, parent = { role: 'parent', id: 'main' } as const;
const node = (id: string, o: Record<string, unknown> = {}) => ({ id, writes: [`${id}.txt`], checks: [], review: { count: 1, min_rank: 1 }, ...o });
const planOf = (...nodes: object[]) => ({ version: 1, trunk: 'main', closure: [], invariants: [], nodes });
const RULE_HINT = (_n: string) => 'This records one answer ruling and delivers it to the asking run; reviewers still acknowledge it.';

/** In-process dsa: views set by the test; `before` hooks run inside `inspect` (between the pass's load and its describe). */
class StubDsa extends Dsa {
  readonly views = new Map<string, RunView>();
  readonly before = new Map<string, () => Promise<void>>();
  readonly runs: string[] = [];
  readonly sends: { id: string; to: string; kind: SendKind; message: string }[] = [];
  constructor() { super({ bin: '/nonexistent/pi-durable-subagents' }); }
  override async run(rid: string): Promise<RunResult> {
    this.runs.push(rid);
    if (!this.views.has(rid)) this.views.set(rid, { rid, state: 'running' });
    return { outcome: 'applied', wid: 'w1', created: true, spec_digest: 'x' };
  }
  override async send(id: string, to: string, kind: SendKind, message: string | Uint8Array): Promise<SendResult> {
    this.sends.push({ id, to, kind, message: typeof message === 'string' ? message : Buffer.from(message).toString('utf8') });
    return { outcome: 'applied', spec_digest: 'x' };
  }
  override async inspect(rid: string): Promise<{ view: RunView; gen?: number }> {
    const hook = this.before.get(rid);
    if (hook) { this.before.delete(rid); await hook(); }
    return { view: this.views.get(rid) ?? { rid, state: 'absent' } };
  }
  override async request(id: string): Promise<{ state: 'applied' | 'rejected' | 'pending' | 'absent'; reason?: string }> {
    return { state: this.sends.some(x => x.id === id) ? 'applied' : 'absent' };
  }
  override async events(): Promise<EventsResult> { return { outcome: 'applied', events: [], head: '0', more: false }; }
}

async function setup(plan: object = planOf(node('a'))) {
  const r = await repo();
  await r.put('plan.json', JSON.stringify(plan)); await r.put('README', 'x\n'); await r.commit();
  await ops.init({ cwd: r.cwd, as: owner, channel: 'flag', plan: JSON.stringify(plan) });
  const dsa = new StubDsa();
  const self = {
    ...r, dsa,
    entries: async (): Promise<Entry[]> => (await Ledger.open(r.cwd)).read(),
    seq: async (): Promise<number> => (await stateOf(r.cwd)).seq,
    /** One `owed drive --once` pass in process; returns its JSON reports. */
    async pass(): Promise<Record<string, unknown>[]> {
      const lines: string[] = [];
      await drive({ cwd: r.cwd, once: true, json: true, dsa, log: l => lines.push(l), handleSignals: false, session: null });
      return lines.map(l => JSON.parse(l) as Record<string, unknown>);
    },
    async rid(role: 'writer' | 'reviewer', n?: number, id = 'a'): Promise<string> { return runId(projectId(await stateOf(r.cwd)), id, 1, role, n); },
    /** Dispatch + submit of node `id` by hand (parent:main), the writer committing `<id>.txt`. */
    async submitted(id = 'a') {
      const d = await ops.dispatch({ cwd: r.cwd, node: id, as: parent });
      await commitAt(d.worktree, { [`${id}.txt`]: `${id}\n` });
      await ops.submit({ cwd: d.worktree, node: id, as: { role: 'writer', id: `${id}#1` } });
      return d;
    },
    /** Driver passes up to the reviewer launch: dispatch, writer launch, (submit + attest by hand), reviewer launch. */
    async toReviewer(): Promise<{ W: string; R: string }> {
      await self.pass();                                   // dispatch
      await self.pass();                                   // writer launch
      const W = await self.rid('writer');
      assert.deepEqual(dsa.runs, [W]);
      const slot = (await stateOf(r.cwd)).nodes.a!.slot!;
      await commitAt(slot.worktree, { 'a.txt': 'a\n' });
      await ops.submit({ cwd: slot.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
      await ops.attest({ cwd: r.cwd, node: 'a' });
      dsa.views.set(W, { rid: W, state: 'sealed', status: 'ok' });
      await self.pass();                                   // reviewer launch
      const R = await self.rid('reviewer', 1);
      assert.deepEqual(dsa.runs, [W, R]);
      return { W, R };
    },
  };
  return self;
}
const kinds = (es: Entry[], kind: string) => es.filter(e => e.kind === kind);
const isStale = (e: unknown): boolean => e instanceof OwedError && e.code === 'stale';

test('F1.1: a stale halt is refused after a review or a submit by another principal; recorded after driver or other-node entries only', { timeout: 120_000 }, async () => {
  const f = await setup(planOf(node('a'), node('b')));
  try {
    await f.submitted('a');
    let since = await f.seq();
    // After `since`: another node's entry (dispatch of b by the parent) and a driver entry on a (its writer launch).
    await ops.dispatch({ cwd: f.cwd, node: 'b', as: parent });
    const s = await stateOf(f.cwd), P = projectId(s);
    await ops.launch({ cwd: f.cwd, as: DRIVE_PRINCIPAL, node: 'a', attempt: 1, role: 'writer', rid: runId(P, 'a', 1, 'writer'), spec: '{"x":1}', labels: runLabels(P, 'a', 1, 'writer'), since });
    const h = await ops.halt({ cwd: f.cwd, as: DRIVE_PRINCIPAL, node: 'a', attempt: 1, reason: 'decided on #since', needs: 'human', since });
    assert.equal(h.kind, 'halt');
    // A review by a reviewer after `since`: the halt decided on `since` records nothing.
    since = await f.seq();
    await ops.review({ cwd: f.cwd, node: 'a', as: { role: 'reviewer', id: 'r1' }, verdict: 'ok', rank: 1, note: 'fine' });
    let n = (await f.entries()).length;
    await assert.rejects(ops.halt({ cwd: f.cwd, as: DRIVE_PRINCIPAL, node: 'a', attempt: 1, reason: 'review-missing', needs: 'human', since }), (e: unknown) => isStale(e) && /#\d+ review by reviewer:r1/.test((e as Error).message));
    assert.equal((await f.entries()).length, n, 'nothing recorded');
    // A submit by the writer after `since` (same commit resubmitted): refused as well.
    since = await f.seq();
    const slot = (await stateOf(f.cwd)).nodes.a!.slot!;
    await ops.submit({ cwd: slot.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
    n = (await f.entries()).length;
    await assert.rejects(ops.halt({ cwd: f.cwd, as: DRIVE_PRINCIPAL, node: 'a', attempt: 1, reason: 'x', needs: 'human', since }), isStale);
    assert.equal((await f.entries()).length, n);
    // Without `since` (the CLI, the executor's own verdicts) nothing changes.
    assert.equal((await ops.halt({ cwd: f.cwd, as: DRIVE_PRINCIPAL, node: 'a', attempt: 1, reason: 'x', needs: 'human' })).kind, 'halt');
  } finally { await f.cleanup(); }
});

test('F1.1: send, launch and rebase are refused as stale after a `*` ruling or a plan entry; an observation counts too', { timeout: 120_000 }, async () => {
  const f = await setup(planOf(node('a'), node('b')));
  try {
    await f.submitted('a');
    const P = projectId(await stateOf(f.cwd)), rid = runId(P, 'a', 1, 'writer');
    const launch = (since: number) => ops.launch({ cwd: f.cwd, as: DRIVE_PRINCIPAL, node: 'a', attempt: 1, role: 'writer', rid, spec: '{"x":1}', labels: runLabels(P, 'a', 1, 'writer'), since });
    const send = (since: number) => ops.send({ cwd: f.cwd, as: DRIVE_PRINCIPAL, node: 'a', attempt: 1, rid, sendKind: 'follow-up', message: 'go', reason: 'submit', since });
    let since = await f.seq();
    await ops.rule({ cwd: f.cwd, as: parent, text: 'everyone: X', nodes: '*' });
    let n = (await f.entries()).length;
    await assert.rejects(launch(since), isStale);
    await assert.rejects(ops.rebase({ cwd: f.cwd, as: DRIVE_PRINCIPAL, node: 'a', since }), isStale);
    assert.equal((await f.entries()).length, n);
    await launch(await f.seq());                                    // current: recorded
    since = await f.seq();
    await ops.planSet({ cwd: f.cwd, as: owner, channel: 'flag', plan: JSON.stringify(planOf(node('a'), node('b'), node('c'))) });
    n = (await f.entries()).length;
    await assert.rejects(send(since), isStale);
    assert.equal((await f.entries()).length, n);
    since = await f.seq();
    await ops.attest({ cwd: f.cwd, node: 'a' });                    // executor:owed observations on a
    assert.ok((await f.entries()).length > n);
    await assert.rejects(send(since), isStale);
    assert.equal((await send(await f.seq())).kind, 'send');
  } finally { await f.cleanup(); }
});

test('F1.1: a send decided on a stale state is not passed to dsa; the next pass decides again on the new state', { timeout: 120_000 }, async () => {
  const f = await setup();
  try {
    await f.pass(); await f.pass();
    const W = await f.rid('writer');
    await commitAt((await stateOf(f.cwd)).nodes.a!.slot!.worktree, { 'a.txt': 'work to submit\n' });
    // The writer finishes without submitting; between the pass's load and its describe the parent records a ruling.
    f.dsa.before.set(W, async () => {
      await ops.rule({ cwd: f.cwd, as: parent, text: 'use sqlite', nodes: ['a'] });
      f.dsa.views.set(W, { rid: W, state: 'sealed', status: 'ok' });
    });
    const out = await f.pass();
    assert.equal(f.dsa.sends.length, 0, 'no dsa send on a stale decision');
    const es = await f.entries();
    assert.equal(kinds(es, 'send').length, 0);
    assert.equal(kinds(es, 'halt').length, 0);
    const stale = out.find(x => x.do === 'send');
    assert.equal(stale?.outcome, 'stale', JSON.stringify(out));
    assert.equal(wakeReport(stale!), false);
    // Next pass: the follow-up carries the ruling.
    await f.pass();
    assert.equal(f.dsa.sends.length, 1);
    assert.match(f.dsa.sends[0]!.message, /use sqlite/);
    assert.match(f.dsa.sends[0]!.message, /owed submit a/);
  } finally { await f.cleanup(); }
});

test('F1.1 (wais #35): a reviewer that records and seals between load and describe yields no halt; the next pass merges', { timeout: 180_000 }, async () => {
  const f = await setup();
  try {
    const { R } = await f.toReviewer();
    f.dsa.before.set(R, async () => {
      await ops.review({ cwd: f.cwd, node: 'a', as: { role: 'reviewer', id: 'drive-a-1-1' }, verdict: 'ok', rank: 1, note: 'fine' });
      f.dsa.views.set(R, { rid: R, state: 'sealed', status: 'ok' });
    });
    const out = await f.pass();
    let es = await f.entries();
    assert.equal(kinds(es, 'halt').length, 0, JSON.stringify(out));
    assert.ok(!kinds(es, 'send').some(e => e.kind === 'send' && e.reason === 'verdict'), 'no verdict follow-up either');
    assert.equal(f.dsa.sends.length, 0);
    assert.ok(out.some(x => x.outcome === 'stale' && x.node === 'a'), JSON.stringify(out));
    assert.ok(!out.some(x => wakeReport(x)), 'a stale outcome wakes nobody');
    await f.pass();
    es = await f.entries();
    assert.ok(es.some(e => e.kind === 'merge' && e.node === 'a'), JSON.stringify(es.slice(-3)));
    assert.equal(kinds(es, 'halt').length, 0);
  } finally { await f.cleanup(); }
});

test('F1.2: a reviewer run sealed without its verdict gets one verdict follow-up with the exact command, then the halt', { timeout: 180_000 }, async () => {
  const f = await setup();
  try {
    const { R } = await f.toReviewer();
    f.dsa.views.set(R, { rid: R, state: 'sealed', status: 'ok' });
    await f.pass();
    const c = (await stateOf(f.cwd)).nodes.a!.candidate!;
    assert.equal(f.dsa.sends.length, 1);
    const sent = f.dsa.sends[0]!;
    assert.equal(sent.to, R); assert.equal(sent.kind, 'follow-up');
    assert.ok(sent.message.includes(c.commit), sent.message);
    assert.match(sent.message, /awaiting from you: review\b/);
    assert.ok(sent.message.includes(`owed review a --obligation review --candidate ${c.commit.slice(0, 12)} --as reviewer:drive-a-1-1 --ok|--block --rank <N>`), sent.message);
    let es = await f.entries();
    const verdicts = es.filter(e => e.kind === 'send' && e.reason === 'verdict');
    assert.equal(verdicts.length, 1);
    assert.equal(kinds(es, 'halt').length, 0);
    // The run seals again without recording: now the halt, naming the follow-up; no second verdict follow-up.
    await f.pass();
    es = await f.entries();
    assert.equal(es.filter(e => e.kind === 'send' && e.reason === 'verdict').length, 1);
    const h = kinds(es, 'halt');
    assert.equal(h.length, 1);
    assert.ok(h[0]!.kind === 'halt' && /^review-missing: reviewer run .* sealed ok without recording review on candidate #\d+ after verdict follow-up /.test(h[0]!.reason), JSON.stringify(h[0]));
  } finally { await f.cleanup(); }
});

test('F1.2: a verdict follow-up answered by a review: no halt, the node merges', { timeout: 180_000 }, async () => {
  const f = await setup();
  try {
    const { R } = await f.toReviewer();
    f.dsa.views.set(R, { rid: R, state: 'sealed', status: 'ok' });
    await f.pass();
    assert.equal(f.dsa.sends.length, 1);
    await ops.review({ cwd: f.cwd, node: 'a', as: { role: 'reviewer', id: 'drive-a-1-1' }, verdict: 'ok', rank: 1, note: 'fine' });
    await f.pass();
    const es = await f.entries();
    assert.equal(kinds(es, 'halt').length, 0);
    assert.ok(es.some(e => e.kind === 'merge' && e.node === 'a'));
  } finally { await f.cleanup(); }
});

test('AN1: the asking notify ends with the answer ruling sentence', { timeout: 120_000 }, async () => {
  const f = await setup();
  try {
    await f.pass(); await f.pass();
    const W = await f.rid('writer');
    f.dsa.views.set(W, { rid: W, state: 'asking', questions: [{ qid: 'q1', rev: 1, question: 'which database?' }] });
    const out = await f.pass();
    const n = out.find(x => x.do === 'notify' && x.node === 'a');
    assert.ok(n && typeof n.text === 'string', JSON.stringify(out));
    assert.ok(n.text.startsWith(`a: writer run ${W} asks (qid q1, rev 1): which database? — the driver never answers`), n.text);
    assert.ok(n.text.endsWith(` ${RULE_HINT('a')}`), n.text);
    assert.equal(kinds(await f.entries(), 'send').length, 0);
  } finally { await f.cleanup(); }
});
