// 0.16.1 SR1–SR4 / HA1–HA2: rejected sends cannot strand a continued attempt; halted runs still report questions.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../src/canon.ts';
import { decide, rejectedFixed, rejectedHalt, reviewerLaunch, writerLaunch, WRITER_INTERRUPTED, type Action, type DriveOpts } from '../src/drive.ts';
import { Driver, DRIVE_PRINCIPAL, stateOf } from '../src/drive-run.ts';
import { Dsa, type RunResult, type SendResult } from '../src/dsa.ts';
import { Ledger } from '../src/ledger.ts';
import * as ops from '../src/ops.ts';
import { halted, reduce, runId } from '../src/reducer.ts';
import type { CandidateFacts, Draft, Entry, LaunchEntry, NodeSpec, Plan, RunView, SendEntry, SendKind, State } from '../src/types.ts';
import { repo } from './helpers/repo.ts';

// Synthetic validating ledger rig, using the fixtures/helpers pattern of drive.test.ts and drive-rulings.test.ts.
const P = 'hash0', T0 = Date.UTC(2026, 0, 1);
const W = (node = 'a') => runId(P, node, 1, 'writer');
const R = (n: number) => runId(P, 'a', 1, 'reviewer', n);
const spec = (id: string): NodeSpec => ({ id, deps: [], writes: [`${id}/`], checks: [{ id: 'unit', run: 'npm test', timeout_s: 60, reads: [`${id}/**`] }], review: { count: 1, min_rank: 1 } });
function rig() {
  const plan: Plan = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: [spec('a'), spec('b')] };
  const entries: Entry[] = [], blobs = new Map<string, string>();
  const state = (): State => reduce(entries, () => plan);
  const add = (d: Draft): Entry => {
    const seq = entries.length, e = { ...d, seq, ts: new Date(T0 + seq * 1000).toISOString(), prev: 'x', hash: `hash${seq}` } as Entry;
    entries.push(e); state(); return e;
  };
  const blob = (text: string) => { const h = sha256(text); blobs.set(h, text); return h; };
  add({ kind: 'genesis', by: 'owner:human', channel: 'tty', plan: 'p', trunk: 'main', commit: 's0', state: { commit: 's0', tree: 't0', invKeys: {} } });
  const self = {
    entries, blobs, state, add,
    dispatch(node = 'a') { return add({ kind: 'dispatch', by: 'parent:drive', node, attempt: 1, base: 's0', branch: `owed/${node}/1`, worktree: `/repo/.owed/wt/${node}-1`, packet: 'blob', rulings_seen: -1 }); },
    launchWriter(node = 'a') { const a = writerLaunch(state(), node, P); return add({ kind: 'launch', by: 'parent:drive', node, attempt: 1, role: 'writer', rid: a.rid, spec: blob(a.spec), labels: a.labels }) as LaunchEntry; },
    launchReviewer(n: number) { const a = reviewerLaunch(state(), 'a', n, P, '/repo'); return add({ kind: 'launch', by: 'parent:drive', node: 'a', attempt: 1, role: 'reviewer', rid: a.rid, spec: blob(a.spec), labels: a.labels }) as LaunchEntry; },
    send(rid = W(), sendKind: SendKind = 'steer', reason: SendEntry['reason'] = 'fenced', node = 'a') {
      return add({ kind: 'send', by: 'parent:drive', node, attempt: 1, rid, send: `${rid}:${sendKind}:${entries.length}`, sendKind, reason, message: blob(`message ${entries.length}`) }) as SendEntry;
    },
    halt(node = 'a') { return add({ kind: 'halt', by: 'parent:drive', node, attempt: 1, reason: 'stuck', needs: 'human' }); },
    resume(node = 'a') { return add({ kind: 'resume', by: 'parent:main', node, attempt: 1 }); },
    submit(tag = '1') {
      const facts: CandidateFacts = { commit: `ac${tag}`, tree: `t${tag}`, base: 's0', patch: `p${tag}`, changed: ['a/x'], closureTouched: false,
        keys: Object.fromEntries(['check:unit', 'writes', 'rulings', 'review'].map(o => [o, `a-${o}-${tag}`])) };
      return add({ kind: 'submit', by: 'writer:a#1', node: 'a', attempt: 1, facts });
    },
  };
  self.dispatch(); self.launchWriter(); return self;
}
type Rig = ReturnType<typeof rig>;
const view = (rid: string, state: RunView['state'], extra: Partial<RunView> = {}): [string, RunView] => [rid, { rid, state, ...extra }];
const running = () => new Map([view(W(), 'running')]);
const refused = (x: SendEntry) => new Map([[x.send, 'finished:unknown — use kind "follow-up" to continue it']]);
function act(r: Rig, runs = running(), o: Partial<DriveOpts> = {}): Action | undefined {
  const s = r.state(), opts: DriveOpts = { max: 1, repairs: 2, project: P, root: '/repo', applied: new Set(), rejected: new Map(), blobs: r.blobs, writerWork: new Map([['a', { head: 'a-new-work', dirty: false }]]), ...o };
  const mine = decide(s, s.plan, runs, opts).filter(a => a.node === 'a');
  assert.ok(mine.length <= 1, 'at most one action per node'); return mine[0];
}

test('1 SR2: rejected fenced steer + sealed unknown gives row 6 interrupted follow-up, not a halt', () => {
  for (const state of ['sealed', 'pruned'] as const) {
    const r = rig(), x = r.send();
    const a = act(r, new Map([view(W(), state, { status: 'unknown' })]), { rejected: refused(x), blobs: new Map() });
    assert.deepEqual(a, { do: 'send', node: 'a', attempt: 1, rid: W(), sendKind: 'follow-up', reason: 'interrupted', message: WRITER_INTERRUPTED });
  }
});

test('2 SR1a: resume after a rejected fenced steer permanently prevents the stale re-halt', () => {
  const r = rig(), x = r.send(); r.halt(); r.resume();
  assert.equal(halted(r.state(), 'a'), undefined);
  for (let pass = 0; pass < 3; pass++) assert.equal(act(r, running(), { rejected: refused(x), blobs: new Map() }), undefined);
});

test('3 SR1b: submit after a rejected send unblocks later rows (attest), without re-sending it', () => {
  for (const kind of ['steer', 'follow-up', 'notify'] as const) {
    const r = rig(), x = r.send(W(), kind, kind === 'steer' ? 'fenced' : 'submit'); r.halt(); r.submit();
    assert.equal(halted(r.state(), 'a'), undefined);
    assert.deepEqual(act(r, running(), { rejected: refused(x), blobs: new Map() }), { do: 'attest', node: 'a' });
  }
});

test('4 SR1/SR4: unsuperseded rejected send to running/asking/queued run still halts with non-destructive recovery', () => {
  for (const state of ['running', 'asking', 'queued'] as const) {
    const r = rig(), x = r.send();
    const a = act(r, new Map([view(W(), state)]), { rejected: refused(x) });
    assert.ok(a?.do === 'halt' && a.needs === 'human');
    assert.equal(a.reason, rejectedHalt('a', 'send', x.send, refused(x).get(x.send)!));
    assert.match(a.reason, /the attempt is not lost: continue the run \(e\.g\. a dsa follow-up\), then `owed decide a --text "<retry run>"`/);
    assert.match(a.reason, /a later resume, submit or send to this run supersedes this send; or `owed abandon a`$/);
    assert.doesNotMatch(a.reason, /start a new attempt|this attempt's request is fixed/);
  }
});

test('5 HA1: halted node reports an asking writer exactly like row 5, preserving the halt and ledger', () => {
  const r = rig(), runs = new Map([view(W(), 'asking', { questions: [{ qid: 'q1', rev: 3, question: 'Which API?\nline two' }] })]);
  const expected = act(r, runs); r.halt();
  const before = JSON.stringify(r.entries), h = halted(r.state(), 'a');
  const a = act(r, runs);
  assert.deepEqual(a, expected);
  assert.ok(a?.do === 'notify' && a.rid === W() && a.qid === 'q1' && a.rev === 3);
  assert.match(a.text, /owed decide a --text "<text>"/);
  assert.match(a.text, /reviewers still acknowledge it/);
  assert.deepEqual(halted(r.state(), 'a'), h); assert.equal(JSON.stringify(r.entries), before);
});

test('6 D15.1: rejected run stays fixed despite later resume or submit', () => {
  const r = rig(); r.resume(); r.submit();
  const a = act(r, running(), { rejected: new Map([[W(), 'unknown agent']]) });
  assert.ok(a?.do === 'halt');
  assert.equal(a.reason, `dsa rejected run ${W()}: unknown agent; ${rejectedFixed('a')}`);
  const sealed = act(r, new Map([view(W(), 'sealed', { status: 'rejected' })]));
  assert.ok(sealed?.do === 'halt' && sealed.reason.endsWith(`${rejectedFixed('a')}; writer gave no final text → owed decide a --text "<ruling>" --writer`));
});

/** In-process fake, as in fresh-act.test.ts: durable refusal replies survive new Driver instances. */
class StubDsa extends Dsa {
  readonly views = new Map<string, RunView>();
  readonly replies = new Map<string, SendResult>();
  readonly sends: { id: string; rid: string; kind: string }[] = [];
  readonly inspected: string[] = [];
  sealOnSteer = false;
  rejectFollowUp = false;
  gen?: number;
  constructor() { super({ bin: '/nonexistent/pi-durable-subagents' }); }
  override async run(rid: string): Promise<RunResult> {
    this.views.set(rid, { rid, state: 'running' });
    return { outcome: 'applied', wid: 'w1', created: true, spec_digest: 'x' };
  }
  override async inspect(rid: string): Promise<{ view: RunView; gen?: number }> {
    this.inspected.push(rid); return { view: this.views.get(rid) ?? { rid, state: 'absent' }, ...(this.gen !== undefined ? { gen: this.gen } : {}) };
  }
  override async send(id: string, rid: string, kind: import('../src/dsa.ts').SendKind): Promise<SendResult> {
    this.sends.push({ id, rid, kind });
    const cached = this.replies.get(id); if (cached) return cached;
    if (kind === 'steer' && this.sealOnSteer) this.views.set(rid, { rid, state: 'sealed', status: 'unknown' });
    const result: SendResult = kind === 'steer' || this.rejectFollowUp
      ? { outcome: 'rejected', reason: 'refused' } : { outcome: 'applied', spec_digest: 'x' };
    this.replies.set(id, result);
    if (result.outcome === 'applied') this.views.set(rid, { rid, state: 'running' });
    return result;
  }
  override async request(id: string): Promise<{ state: 'applied' | 'rejected' | 'absent'; reason?: string }> {
    const r = this.replies.get(id);
    return r?.outcome === 'rejected' ? { state: 'rejected', reason: r.reason } : { state: r ? 'applied' : 'absent' };
  }
}
async function runtime() {
  const r = await repo(), dsa = new StubDsa();
  const plan = JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [], drive: { min_free_mb: 0 }, nodes: [{ id: 'a', writes: ['a.txt'], checks: [], review: { count: 0, min_rank: 1 } }] });
  await r.put('plan.json', plan); await r.commit();
  await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'human' }, channel: 'flag', plan });
  const lines: string[] = [];
  const driver = () => new Driver({ cwd: r.cwd, once: true, json: true, dsa, log: l => lines.push(l), handleSignals: false, session: null });
  const d = driver(); await d.pass(); await d.pass();
  const s = await stateOf(r.cwd), writer = s.nodes.a!.runs[0]!.launches[0]!;
  const entries = async () => (await Ledger.open(r.cwd)).read();
  return { ...r, dsa, d, driver, entries, writer, lines };
}

test('7 SR3 executor: rejected fenced steer records refusal only; next pass recovers sealed unknown, including restart', { timeout: 60_000 }, async () => {
  const f = await runtime();
  try {
    const rid = f.writer.rid; f.dsa.sealOnSteer = true;
    f.dsa.views.set(rid, { rid, state: 'running', lastFence: { at: Date.now(), reason: 'restart-force' } });
    const pass = await f.d.pass(), x = (await f.entries()).find(e => e.kind === 'send');
    assert.ok(x?.kind === 'send');
    assert.equal(pass.actions[0]?.outcome, 'rejected');
    assert.equal(f.d.facts.refused.get(x.send), 'refused');
    assert.equal((await f.entries()).filter(e => e.kind === 'halt').length, 0);
    await f.driver().pass(); // no in-process refusal cache: observe re-reads dsa's durable request state
    assert.deepEqual((await f.entries()).filter(e => e.kind === 'send').map(e => e.reason), ['fenced', 'interrupted']);
    assert.equal((await f.entries()).filter(e => e.kind === 'halt').length, 0);
    await f.driver().pass();
    assert.equal((await f.entries()).filter(e => e.kind === 'halt').length, 0);
    assert.equal(f.dsa.sends.filter(s => s.id === x.send).length, 1, 'never retries the superseded steer');
  } finally { await f.cleanup(); }
});

test('SR1c: later non-rejected send to same rid supersedes refusal even when not yet confirmed applied', () => {
  const r = rig(), x = r.send(), y = r.send(W(), 'follow-up', 'interrupted');
  const a = act(r, running(), { rejected: refused(x) });
  assert.ok(a?.do === 'send' && a.send === y.send, 'pending successor is retried, never the refused predecessor');
  assert.equal(act(r, running(), { rejected: refused(x), applied: new Set([y.send]) }), undefined);
});

test('SR1c: rejected successor does not supersede predecessor; other run/node and earlier entries do not either', () => {
  const r = rig(); r.resume(); r.submit(); r.launchReviewer(1); r.send(W(), 'follow-up', 'submit');
  const x = r.send(), y = r.send(W(), 'follow-up', 'interrupted');
  r.send(R(1), 'follow-up', 'verdict'); r.dispatch('b'); r.launchWriter('b'); r.resume('b'); r.send(W('b'), 'follow-up', 'submit', 'b');
  const a = act(r, new Map([view(W(), 'running'), view(R(1), 'running')]), { rejected: new Map([...refused(x), ...refused(y)]),
    applied: new Set(r.entries.flatMap(e => e.kind === 'send' && e.send !== x.send && e.send !== y.send ? [e.send] : [])) });
  assert.ok(a?.do === 'halt' && a.reason.startsWith(`dsa rejected send ${x.send}:`));
});

test('SR2: sealed ok/failed/rejected after refused steer follows row 8/7, not a stale-send halt', () => {
  for (const status of ['ok', 'failed', 'rejected']) {
    const r = rig(), x = r.send(), a = act(r, new Map([view(W(), 'sealed', { status })]), { rejected: refused(x) });
    if (status === 'ok') assert.ok(a?.do === 'send' && a.reason === 'submit' && a.sendKind === 'follow-up');
    else { assert.ok(a?.do === 'halt'); assert.match(a.reason, new RegExp(`^writer run .* sealed ${status}`)); }
  }
});

test('SR2: rejected follow-up/notice to sealed run is not exempt without a successor', () => {
  for (const kind of ['follow-up', 'notify'] as const) {
    const r = rig(), x = r.send(W(), kind, 'submit');
    const a = act(r, new Map([view(W(), 'sealed', { status: 'unknown' })]), { rejected: refused(x) });
    assert.ok(a?.do === 'halt' && a.reason.startsWith(`dsa rejected send ${x.send}:`));
  }
});

test('HA1: halted node reports current reviewer questions, ignores obsolete reviewers and does nothing for non-asking runs', () => {
  const r = rig(); r.submit(); r.launchReviewer(1); r.submit('2'); r.launchReviewer(2);
  const asks = (rid: string) => view(rid, 'asking', { questions: [{ qid: rid, rev: 1, question: '?' }] });
  r.halt();
  const a = act(r, new Map([view(W(), 'sealed', { status: 'unknown' }), asks(R(1)), asks(R(2))]));
  assert.ok(a?.do === 'notify' && a.rid === R(2));
  assert.equal(act(r, new Map([view(W(), 'running'), asks(R(1)), view(R(2), 'running')])), undefined);
  assert.equal(act(r, new Map()), undefined, 'missing views never launch or clear a halted slot');
});

test('HA1: answered quiet/once and overdue retry semantics are identical while halted', () => {
  const r = rig();
  const answer = r.add({ kind: 'rule', by: 'parent:main', nodes: ['a'], writer: false, text: 'Answer to writer question q1: answer', answer: { rid: W(), qid: 'q1', rev: 2 } });
  const runs = new Map([view(W(), 'asking', { questions: [{ qid: 'q1', rev: 2, question: '?' }] })]);
  const quiet = act(r, runs); r.halt();
  assert.deepEqual(act(r, runs), quiet);
  assert.ok(quiet?.do === 'notify' && quiet.quiet && quiet.once);
  const o = { now: Date.parse(answer.ts) + 901_000 };
  const retry = act(r, runs, o);
  assert.ok(retry?.do === 'notify' && retry.answerRetry && retry.qid === 'q1' && retry.rev === 2 && retry.once);
  const after = act(r, runs, { ...o, noticed: new Set([retry.once]) });
  assert.deepEqual(after, quiet, 'the overdue retry is once per rid/qid');
});

test('HA1: halted node prefers unanswered current reviewer over answered quiet writer', () => {
  const r = rig(); r.submit(); r.launchReviewer(1);
  r.add({ kind: 'rule', by: 'parent:main', nodes: ['a'], writer: false, text: 'Answer to writer question qw: answer', answer: { rid: W(), qid: 'qw', rev: 1 } }); r.halt();
  const a = act(r, new Map([view(W(), 'asking', { questions: [{ qid: 'qw', rev: 1, question: '?' }] }), view(R(1), 'asking', { questions: [{ qid: 'qr', rev: 4, question: 'scope?' }] })]));
  assert.ok(a?.do === 'notify' && !a.quiet && a.rid === R(1) && a.qid === 'qr' && a.rev === 4);
});

test('HA1 executor: observe describes halted writer and notifies without any send or ledger change', { timeout: 60_000 }, async () => {
  const f = await runtime();
  try {
    await ops.halt({ cwd: f.cwd, as: DRIVE_PRINCIPAL, node: 'a', attempt: 1, reason: 'stuck', needs: 'human' });
    const before = await f.entries(), rid = f.writer.rid;
    f.dsa.views.set(rid, { rid, state: 'asking', questions: [{ qid: 'q1', rev: 3, question: 'Need a decision' }] });
    const pass = await f.driver().pass();
    assert.ok(f.dsa.inspected.includes(rid));
    const a = pass.actions.find(a => a.do === 'notify' && a.rid === rid);
    assert.ok(a?.qid === 'q1' && a.rev === 3); assert.match(a.text!, /owed decide a --text/);
    assert.deepEqual(await f.entries(), before); assert.equal(f.dsa.sends.length, 0);
    assert.ok(halted(await stateOf(f.cwd), 'a'));
  } finally { await f.cleanup(); }
});

test('SR3 executor: unsuperseded steer refusal to live run halts only next pass, without retrying', { timeout: 60_000 }, async () => {
  const f = await runtime();
  try {
    const rid = f.writer.rid;
    f.dsa.views.set(rid, { rid, state: 'running', lastFence: { at: Date.now(), reason: 'restart-force' } });
    await f.d.pass();
    assert.equal((await f.entries()).filter(e => e.kind === 'halt').length, 0);
    await f.d.pass();
    assert.equal((await f.entries()).filter(e => e.kind === 'halt').length, 1);
    assert.equal(f.dsa.sends.length, 1);
    await ops.resume({ cwd: f.cwd, as: { role: 'parent', id: 'main' }, node: 'a' });
    await f.driver().pass();
    assert.equal((await f.entries()).filter(e => e.kind === 'halt').length, 1, 'resume never re-raises old send halt');
    assert.equal(halted(await stateOf(f.cwd), 'a'), undefined);
  } finally { await f.cleanup(); }
});

test('HA1 executor: halted sealed run never replays an applied follow-up for generation recovery', { timeout: 60_000 }, async () => {
  const f = await runtime();
  try {
    const rid = f.writer.rid;
    const x = await ops.send({ cwd: f.cwd, as: DRIVE_PRINCIPAL, node: 'a', attempt: 1, rid, sendKind: 'follow-up', reason: 'interrupted', message: 'continue' });
    f.dsa.replies.set(x.send, { outcome: 'applied', generation: 2, spec_digest: 'x' });
    await ops.halt({ cwd: f.cwd, as: DRIVE_PRINCIPAL, node: 'a', attempt: 1, reason: 'stuck', needs: 'human' });
    const before = await f.entries();
    f.dsa.gen = 1; f.dsa.views.set(rid, { rid, state: 'sealed', status: 'unknown' });
    const pass = await f.driver().pass();
    assert.deepEqual(pass.actions, []); assert.deepEqual(await f.entries(), before);
    assert.deepEqual(f.dsa.sends, [], 'HA1 forbids even an idempotent generation-recovery send while halted');
  } finally { await f.cleanup(); }
});

test('#1743: asking report precedes prospective notice once per question revision (halted, row 5 and waiting)', () => {
  for (const row of ['halted', 'row5', 'waiting'] as const) {
    for (const pending of [false, true]) {
      const r = rig();
      if (row === 'halted') r.halt();
      if (row === 'waiting') r.add({ kind: 'resume', by: 'parent:main', node: 'a', attempt: 1, after: 'b' });
      const policy = r.add({ kind: 'rule', by: 'owner:pi', channel: 'delegated', nodes: ['a'], prospective: true, text: 'Future policy' });
      const x = pending ? r.add({ kind: 'send', by: 'parent:drive', node: 'a', attempt: 1, rid: W(), send: `${W()}:notify:${r.entries.length}`,
        sendKind: 'notify', reason: 'ruling', rulings: policy.seq, message: sha256('pending notice') }) as SendEntry : undefined;
      if (x) r.blobs.set(x.message, 'pending notice');
      const runs = new Map([view(W(), 'asking', { questions: [{ qid: 'q1', rev: 1, question: 'Scope?' }] })]);
      const before = JSON.stringify(r.entries), h = halted(r.state(), 'a');
      const first = act(r, runs);
      assert.ok(first?.do === 'notify' && !first.quiet && first.rid === W() && first.qid === 'q1' && first.once);
      assert.match(first.text, /owed decide a --text/);
      const noticed = new Set([first.once]);
      const second = act(r, runs, { noticed });
      assert.ok(second?.do === 'send' && second.sendKind === 'notify' && second.reason === 'ruling');
      if (x) assert.equal(second.send, x.send, 'a pending notice is retried with its original request id');
      else assert.equal(second.rulings, policy.seq);
      // Reporting never answers or quiets q1; only its priority over PR2 has been consumed.
      assert.deepEqual(act(r, runs), first, 'pure decide does not mutate noticed or ledger');
      const revised = new Map([view(W(), 'asking', { questions: [{ qid: 'q1', rev: 2, question: 'Revised scope?' }] })]);
      const reask = act(r, revised, { noticed });
      assert.ok(reask?.do === 'notify' && !reask.quiet && reask.rev === 2 && reask.once !== first.once);
      assert.equal(JSON.stringify(r.entries), before); assert.deepEqual(halted(r.state(), 'a'), h);
    }
  }
  // A genuinely quiet, answered question never delays PR2.
  const r = rig();
  r.add({ kind: 'rule', by: 'parent:main', nodes: ['a'], writer: false, text: 'Answer to writer question q1: scope', answer: { rid: W(), qid: 'q1', rev: 1 } });
  r.halt(); r.add({ kind: 'rule', by: 'owner:pi', channel: 'delegated', nodes: ['a'], prospective: true, text: 'Future policy' });
  const a = act(r, new Map([view(W(), 'asking', { questions: [{ qid: 'q1', rev: 1, question: 'Scope?' }] })]));
  assert.ok(a?.do === 'send' && a.sendKind === 'notify');
  // #1746: generic asking without question content/qid keeps the existing PR2 precedence.
  const generic = act(r, new Map([view(W(), 'asking')]));
  assert.ok(generic?.do === 'send' && generic.sendKind === 'notify');
});

test('#1743 executor: halted asking writer is reported first, then receives PR2 notice without an answer', { timeout: 60_000 }, async () => {
  const f = await runtime();
  try {
    await ops.halt({ cwd: f.cwd, as: DRIVE_PRINCIPAL, node: 'a', attempt: 1, reason: 'stuck', needs: 'human' });
    const h = halted(await stateOf(f.cwd), 'a');
    await ops.rule({ cwd: f.cwd, as: { role: 'parent', id: 'main' }, nodes: ['a'], prospective: true, text: 'Future policy' });
    const before = await f.entries(), rid = f.writer.rid;
    const asking: RunView = { rid, state: 'asking', questions: [{ qid: 'q1', rev: 3, question: 'Need a decision' }] };
    f.dsa.views.set(rid, asking);
    const first = await f.d.pass();
    assert.deepEqual(first.actions.map(a => [a.do, a.outcome]), [['notify', 'notify']]);
    assert.equal(first.actions[0]!.qid, 'q1'); assert.equal(first.actions[0]!.rev, 3);
    assert.equal(f.dsa.sends.length, 0); assert.deepEqual(await f.entries(), before);
    assert.ok([...f.d.facts.once].some(k => k.startsWith('asking-notice\u0000')));
    const second = await f.d.pass();
    assert.deepEqual(second.actions.map(a => [a.do, a.sendKind, a.reason, a.outcome]), [['send', 'notify', 'ruling', 'applied']]);
    assert.equal(f.dsa.sends.length, 1);
    assert.deepEqual((await f.entries()).slice(before.length).map(e => e.kind), ['send']);
    assert.deepEqual(halted(await stateOf(f.cwd), 'a'), h);
    f.dsa.views.set(rid, asking);
    const third = await f.d.pass();
    assert.equal(third.actions[0]?.outcome, 'notify', 'unanswered question is still non-quiet after its report');
  } finally { await f.cleanup(); }
});

test('SR3 executor: refused follow-up still records an action-time halt', { timeout: 60_000 }, async () => {
  const f = await runtime();
  try {
    const rid = f.writer.rid; f.dsa.rejectFollowUp = true;
    f.dsa.views.set(rid, { rid, state: 'sealed', status: 'unknown' });
    const pass = await f.d.pass();
    assert.equal(pass.actions[0]?.outcome, 'rejected');
    const halts = (await f.entries()).filter(e => e.kind === 'halt');
    assert.equal(halts.length, 1); assert.match(halts[0]!.reason, /owed decide a --text/);
  } finally { await f.cleanup(); }
});
