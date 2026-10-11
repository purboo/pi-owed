// 0.12 G3 (`nits`): the non-blocking review nits of 0.11 (#1083, #1089, #1110, #1128, #1129).
import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../src/canon.ts';
import { main } from '../src/cli.ts';
import { decide, type Action, type DriveOpts } from '../src/drive.ts';
import { Driver, drive, DRIVE_PRINCIPAL, type ActionReport } from '../src/drive-run.ts';
import { Dsa, DsaError, type EventsResult, type RunResult, type SendKind, type SendResult } from '../src/dsa.ts';
import { OwedError } from '../src/errors.ts';
import { runJob } from '../src/exec.ts';
import { Ledger } from '../src/ledger.ts';
import * as ops from '../src/ops.ts';
import { parsePlan } from '../src/plan.ts';
import { reduce, runId, runLabels, validateDraft } from '../src/reducer.ts';
import type { AttestJob, CandidateFacts, Draft, Entry, NodeSpec, Plan, RunView, State } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { commitAt } from './helpers/surface.ts';
delete process.env.OWED_CONFIRM;

const owner = { role: 'owner', id: 'human' } as const, parent = { role: 'parent', id: 'main' } as const;
const STALE = 'stale: #9 plan by owner:human on a was recorded after the state #7 the driver decided on; nothing recorded';

// ---------- G3.1: `stale` is a refusal (exit 1, its own text), not an internal error ----------
test('G3.1: a stale error reaching the CLI exits 1 with `Stale:`, not `Internal error`/3; --json names code stale', { timeout: 60_000 }, async () => {
  const r = await repo(), cwd = process.cwd(), withLock = Ledger.prototype.withLock;
  try {
    await r.put('README', 'x\n'); await r.commit();
    const plan = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: [{ id: 'a', writes: ['a.txt'], checks: [], review: { count: 1, min_rank: 1 } }] };
    await ops.init({ cwd: r.cwd, as: owner, channel: 'flag', plan: JSON.stringify(plan) });
    process.chdir(r.cwd);
    Ledger.prototype.withLock = async function () { throw new OwedError(STALE, 'stale'); };
    for (const json of [false, true]) {
      const out: string[] = [], err: string[] = [];
      const code = await main(['rule', 'use sqlite', '--nodes', 'a', ...(json ? ['--json'] : [])], { log: t => out.push(t), error: t => err.push(t) });
      assert.equal(code, 1, err.join('\n'));
      assert.equal(err.length, 1, err.join('\n'));
      assert.match(err[0]!, /^Stale: #9 plan by owner:human on a was recorded after the state #7/);
      assert.doesNotMatch(err.join('\n'), /Internal error/);
      if (json) assert.deepEqual(JSON.parse(out[0]!), { error: STALE, code: 'stale' });
    }
  } finally { Ledger.prototype.withLock = withLock; process.chdir(cwd); await r.cleanup(); }
});

test('G3.1: a stale (or version) error ending an `owed drive --json` loop exits 1 with exit record code 1', { timeout: 60_000 }, async () => {
  const r = await repo(), open = Ledger.open;
  try {
    for (const code of ['stale', 'version', 'internal'] as const) {
      Ledger.open = async () => { throw new OwedError(code === 'stale' ? STALE : `${code} failure`, code as 'stale'); };
      const lines: string[] = [];
      const exit = await drive({ cwd: r.cwd, json: true, log: l => lines.push(l), handleSignals: false, session: null, dsa: new Dsa({ bin: '/nonexistent/dsa' }) });
      const want = code === 'internal' ? 3 : 1;
      assert.equal(exit, want, `${code}: ${lines.join('\n')}`);
      const rec = JSON.parse(lines.at(-1)!) as { event: string; code: number; reason: string };
      assert.deepEqual([rec.event, rec.code, rec.reason], ['exit', want, 'error']);
    }
  } finally { Ledger.open = open; await r.cleanup(); }
});

// ---------- git-backed driver rig ----------
const nodeOf = (id: string, o: Record<string, unknown> = {}) => ({ id, deps: [], writes: [`${id}.txt`], checks: [], review: { count: 0, min_rank: 1 }, ...o });
const planOf = (...nodes: object[]) => ({ version: 1, trunk: 'main', closure: [], invariants: [], nodes });

/**
 * In-process dsa with generations: a run starts at generation 1; a follow-up to a sealed run opens the next one and
 * answers with it (a retry of the same id returns the first answer, like dsa). `lag`: describe keeps reporting the
 * view and generation set by the test (dsa's view lagging the applied follow-up). `before`: hooks run inside
 * `inspect`, between the pass's load and its decide.
 */
class GenDsa extends Dsa {
  readonly views = new Map<string, RunView>();
  readonly described = new Map<string, number>();
  readonly real = new Map<string, number>();
  readonly replies = new Map<string, SendResult>();
  readonly before = new Map<string, () => Promise<void>>();
  readonly sends: { id: string; to: string; kind: SendKind }[] = [];
  constructor() { super({ bin: '/nonexistent/pi-durable-subagents' }); }
  override async run(rid: string): Promise<RunResult> {
    if (!this.views.has(rid)) { this.views.set(rid, { rid, state: 'running' }); this.described.set(rid, 1); this.real.set(rid, 1); }
    return { outcome: 'applied', wid: 'w1', created: true, spec_digest: 'x' };
  }
  override async send(id: string, to: string, kind: SendKind): Promise<SendResult> {
    this.sends.push({ id, to, kind });
    const prior = this.replies.get(id);
    if (prior) return prior;
    const g = (this.real.get(to) ?? 1) + 1;
    this.real.set(to, g);
    const r: SendResult = { outcome: 'applied', ...(kind === 'follow-up' ? { generation: g } : {}), spec_digest: 'x' };
    this.replies.set(id, r);
    return r;
  }
  override async inspect(rid: string): Promise<{ view: RunView; gen?: number }> {
    const hook = this.before.get(rid);
    if (hook) { this.before.delete(rid); await hook(); }
    const view = this.views.get(rid) ?? { rid, state: 'absent' as const }, gen = this.described.get(rid);
    return { view, ...(gen !== undefined ? { gen } : {}) };
  }
  override async request(id: string): Promise<{ state: 'applied' | 'rejected' | 'pending' | 'absent'; reason?: string }> {
    return { state: this.replies.has(id) ? 'applied' : 'absent' };
  }
  override async events(): Promise<EventsResult> { return { outcome: 'applied', events: [], head: '0', more: false }; }
}

async function driverRig(plan: object = planOf(nodeOf('a'), nodeOf('b'))) {
  const r = await repo();
  await r.put('README', 'x\n'); await r.commit();
  await ops.init({ cwd: r.cwd, as: owner, channel: 'flag', plan: JSON.stringify(plan) });
  await ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' });
  const dsa = new GenDsa();
  return {
    ...r, dsa,
    entries: async (): Promise<Entry[]> => (await Ledger.open(r.cwd)).read(),
    /** One pass of a new driver process (a restart: nothing in memory from earlier passes). */
    async pass(): Promise<ActionReport[]> {
      const d = new Driver({ cwd: r.cwd, log: () => {}, dsa, session: null, handleSignals: false, max: 1 });
      return (await d.pass()).actions;
    },
  };
}

// ---------- G3.2: a restarted driver keeps what it expected of a run's next generation ----------
test('G3.2: after a restart, a sent but not yet visible follow-up generation is not read as its outcome: no halt', { timeout: 120_000 }, async () => {
  const f = await driverRig();
  try {
    await f.pass();                                           // writer launch
    const rid = [...f.dsa.views.keys()][0]!;
    assert.ok(rid.endsWith(':a:1:writer'), rid);
    f.dsa.views.set(rid, { rid, state: 'sealed', status: 'ok' });
    const sent = await f.pass();                              // sealed without a candidate: submit follow-up (generation 2)
    const s = sent.find(a => a.do === 'send');
    assert.equal(s?.outcome, 'applied', JSON.stringify(sent));
    assert.equal(f.dsa.real.get(rid), 2);
    // Restart: describe still reports the sealed generation 1 (lagging the applied follow-up).
    const lagging = await f.pass();
    let es = await f.entries();
    assert.equal(es.filter(e => e.kind === 'halt').length, 0, `no halt on the lagging view: ${JSON.stringify(lagging)}`);
    assert.ok(!lagging.some(a => a.do === 'halt'), JSON.stringify(lagging));
    assert.equal(es.filter(e => e.kind === 'send').length, 1, 'no second follow-up either');
    assert.deepEqual(f.dsa.sends.map(x => x.id), [s!.send, s!.send], 'the restarted driver asked dsa again with the same id (the first answer names generation 2)');
    // Once describe reports generation 2 sealed (the follow-up's outcome, still no submit), the halt follows.
    f.dsa.described.set(rid, 2);
    await f.pass();
    es = await f.entries();
    const h = es.filter(e => e.kind === 'halt');
    assert.equal(h.length, 1, JSON.stringify(es.slice(-3)));
    assert.match((h[0] as { reason: string }).reason, /without submitting a candidate after follow-up/);
  } finally { await f.cleanup(); }
});

// ---------- G3.3: a re-send decided before a plan entry that removes or changes the node is stale ----------
/** Writer launched and sealed; a submit follow-up recorded but never given to dsa (a crash before dsa). */
async function recordedSend(f: Awaited<ReturnType<typeof driverRig>>): Promise<{ rid: string; send: string }> {
  await f.pass();
  const rid = [...f.dsa.views.keys()][0]!;
  f.dsa.views.set(rid, { rid, state: 'sealed', status: 'ok' });
  const e = await ops.send({ cwd: f.cwd, as: DRIVE_PRINCIPAL, node: 'a', attempt: 1, rid, sendKind: 'follow-up', message: 'Commit and run `owed submit a`.', reason: 'submit' });
  return { rid, send: e.send };
}

test('G3.3: a recorded send re-sent on a state a later plan entry removed the node from is stale: nothing sent', { timeout: 120_000 }, async () => {
  const f = await driverRig();
  try {
    const { rid } = await recordedSend(f);
    f.dsa.before.set(rid, async () => { await ops.planSet({ cwd: f.cwd, as: owner, channel: 'flag', plan: JSON.stringify(planOf(nodeOf('b'))) }); });
    const out = await f.pass();
    assert.equal(f.dsa.sends.length, 0, `no dsa send: ${JSON.stringify(out)}`);
    const r = out.find(a => a.do === 'send');
    assert.equal(r?.outcome, 'stale', JSON.stringify(out));
    assert.match(r!.detail ?? '', /plan #\d+ .*removed a/);
    assert.equal((await f.entries()).filter(e => e.kind === 'halt').length, 0);
    assert.deepEqual((await f.pass()).filter(a => a.node === 'a'), [], 'the removed node gets no action next pass');
  } finally { await f.cleanup(); }
});

test('G3.3: a re-send is stale after a plan entry that changes the node; a plan entry leaving it unchanged lets it through', { timeout: 120_000 }, async () => {
  const f = await driverRig();
  try {
    const { rid, send } = await recordedSend(f);
    f.dsa.before.set(rid, async () => { await ops.planSet({ cwd: f.cwd, as: owner, channel: 'flag', plan: JSON.stringify(planOf(nodeOf('a', { writes: ['a.txt', 'a2.txt'] }), nodeOf('b'))) }); });
    let out = await f.pass();
    assert.equal(f.dsa.sends.length, 0, JSON.stringify(out));
    const r = out.find(a => a.do === 'send');
    assert.equal(r?.outcome, 'stale', JSON.stringify(out));
    assert.match(r!.detail ?? '', /plan #\d+ .*changed a/);
    // A plan entry that leaves a's spec as it is (adds node c): the next pass re-sends the same id.
    f.dsa.before.set(rid, async () => { await ops.planSet({ cwd: f.cwd, as: owner, channel: 'flag', plan: JSON.stringify(planOf(nodeOf('a', { writes: ['a.txt', 'a2.txt'] }), nodeOf('b'), nodeOf('c'))) }); });
    out = await f.pass();
    assert.deepEqual(f.dsa.sends.map(x => x.id), [send], JSON.stringify(out));
    assert.equal(out.find(a => a.do === 'send')?.outcome, 'applied');
  } finally { await f.cleanup(); }
});

// ---------- G3.4: spec-reporter titles are not environment evidence; the note shows the matched lines ----------
async function execRig() {
  const r = await repo();
  const base = await r.commit();
  const plan = parsePlan('version: 1\ntrunk: main\nnodes:\n - id: a\n   writes: [x]\n   checks: [{id: unit, run: "true"}]');
  const ctx = { cwd: r.cwd, plan, ledger: await Ledger.open(r.cwd) };
  const job = (run: string): AttestJob => ({ kind: 'check', subject: 'a', obligation: 'check:unit', key: 'k', commit: base, base, spec: { id: 'unit', run, timeout_s: 60, reads: ['**'] } });
  return { ...r, run: (cmd: string) => runJob(ctx, job(cmd)) };
}

test('G3.4: a failing spec-reporter run whose test title contains ENOSPC is a fail, not environment', { timeout: 120_000 }, async () => {
  const f = await execRig();
  try {
    const o = await f.run(`printf '%s\\n' '▶ disk' '  ✖ reports ENOSPC to the caller (2.1ms)' '  ✔ No space left on device is retried (0.4ms)' '✖ disk (3ms)' '▶ quota' '  ✔ Disk quota exceeded maps to busy (0.2ms)'; exit 1`);
    assert.equal(o.verdict, 'fail', o.note);
    assert.equal(o.note?.startsWith('environment: ') ?? false, false, o.note);
    assert.match(o.note ?? '', /^command exited 1 with no recognizable test count/);
  } finally { await f.cleanup(); }
});

test('G3.4: the environment note shows the filtered lines the pattern matched, not the unfiltered tail', { timeout: 120_000 }, async () => {
  const f = await execRig();
  try {
    const o = await f.run(`printf '%s\\n' '✔ ENOSPC title only (1ms)' 'Error: ENOSPC: no space left on device, write' 'cleanup done' 'ok 1 - No space left on device title'; exit 1`);
    assert.equal(o.verdict, 'error', o.note);
    assert.equal(o.note, 'environment: ENOSPC: command exited 1; matched output:\n  Error: ENOSPC: no space left on device, write');
  } finally { await f.cleanup(); }
});

// ---------- synthetic decide rig (route.test.ts): writer rulings and the resume re-send ----------
const plan: Plan = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: ['a', 'b'].map(id => ({ id, deps: [], writes: [`${id}.txt`], checks: [], review: { count: 1, min_rank: 1 } })) };
const W = runId('hash0', 'a', 1, 'writer'), R = runId('hash0', 'a', 1, 'reviewer', 1);
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
  const record = (a: Action) => {
    if (a.do !== 'send') throw new Error('send expected');
    return add({ kind: 'send', by: 'parent:drive', node: a.node, attempt: a.attempt, rid: a.rid, send: `${a.rid}:${a.sendKind}:${entries.length}`, sendKind: a.sendKind, message: blob(a.message), reason: a.reason, rulings: a.rulings });
  };
  const act = () => {
    const s = state();
    return decide(s, s.plan, new Map([[W, { rid: W, state: 'sealed', status: 'ok' }], [R, { rid: R, state: 'sealed', status: 'ok' }]]), { max: 2, repairs: 2, project: 'hash0', root: '/repo', blobs, applied: new Set(entries.flatMap(e => e.kind === 'send' ? [e.send] : [])), rejected: new Map() }).find(a => a.node === 'a');
  };
  add({ kind: 'genesis', by: 'owner:test', channel: 'flag', plan: 'p', trunk: 'main', commit: 's0', state: { commit: 's0', tree: 't0', invKeys: {} } });
  add({ kind: 'dispatch', by: 'parent:test', node: 'a', attempt: 1, base: 's0', branch: 'owed/a/1', worktree: '/repo/a', packet: blob('packet'), rulings_seen: -1 });
  add({ kind: 'launch', by: 'parent:drive', node: 'a', attempt: 1, role: 'writer', rid: W, spec: blob('spec'), labels: runLabels('hash0', 'a', 1, 'writer'), rulings: 0 });
  add({ kind: 'submit', by: 'writer:a#1', node: 'a', attempt: 1, facts });
  add({ kind: 'obs', by: 'executor:owed', subject: 'a', obligation: 'writes', key: 'kw', verdict: 'pass', exit: 0, durationMs: 1, commit: facts.commit, base: facts.base });
  add({ kind: 'launch', by: 'parent:drive', node: 'a', attempt: 1, role: 'reviewer', rid: R, spec: blob('review'), labels: runLabels('hash0', 'a', 1, 'reviewer'), rulings: 0 });
  return { entries, state, add, act, record };
}

test('G3.5: the writer-ruling re-send after a resume carries the same active block lines as rulingFollowUp', () => {
  const r = rig();
  const block = r.add({ kind: 'review', by: 'reviewer:other', node: 'a', attempt: 1, obligation: 'review', key: 'kr', verdict: 'block', rank: 1, note: 'the empty registry is not covered' } as Draft);
  r.add({ kind: 'rule', by: 'parent:test', nodes: ['a'], text: 'cover the empty registry', writer: true } as Draft);
  const first = r.act();
  assert.ok(first?.do === 'send' && first.reason === 'ruling' && first.rid === W, JSON.stringify(first));
  const line = `- #${block.seq} review by reviewer:other rank 1: the empty registry is not covered`;
  assert.ok(first.message.split('\n').includes(line), first.message);
  r.record(first);
  const h = r.act();
  assert.ok(h?.do === 'halt', JSON.stringify(h));
  r.add({ kind: 'halt', by: 'parent:drive', node: 'a', attempt: 1, reason: h.reason, needs: h.needs } as Draft);
  r.add({ kind: 'resume', by: 'parent:test', node: 'a', attempt: 1, note: 'try again' } as Draft);
  const again = r.act();
  assert.ok(again?.do === 'send' && again.reason === 'ruling' && again.rid === W, JSON.stringify(again));
  const lines = again.message.split('\n');
  const header = first.message.split('\n').find(l => l.startsWith('Active blocks on your candidate'))!;
  assert.ok(header, first.message);
  assert.ok(lines.includes(header), again.message);
  assert.ok(lines.includes(line), again.message);
  assert.ok(lines.indexOf(line) < lines.findIndex(l => l.startsWith('Then commit and run')), again.message);
});

// ---------- G3.6: a removed node's open slot counts toward drive.max; a failed send line names its node ----------
test('G3.6: an open slot of a removed node still counts toward drive.max until abandoned', () => {
  const T0 = Date.UTC(2026, 0, 1);
  const spec = (id: string): NodeSpec => ({ id, deps: [], writes: [`${id}/`], checks: [], review: { count: 0, min_rank: 1 } });
  const plans: Record<string, Plan> = { p1: { version: 1, trunk: 'main', closure: [], invariants: [], nodes: [spec('a'), spec('b')] }, p2: { version: 1, trunk: 'main', closure: [], invariants: [], nodes: [spec('a')] } };
  const entries: Entry[] = [];
  const state = (): State => reduce(entries, sha => plans[sha]!);
  const add = (d: Draft) => { const seq = entries.length; entries.push({ ...d, seq, ts: new Date(T0 + seq * 1000).toISOString(), prev: 'x', hash: `hash${seq}` } as Entry); };
  add({ kind: 'genesis', by: 'owner:human', channel: 'tty', plan: 'p1', trunk: 'main', commit: 's0', state: { commit: 's0', tree: 't0', invKeys: {} } });
  add({ kind: 'dispatch', by: 'parent:drive', node: 'b', attempt: 1, base: 's0', branch: 'owed/b/1', worktree: '/repo/.owed/wt/b-1', packet: 'blob', rulings_seen: -1 });
  add({ kind: 'plan', by: 'owner:human', channel: 'tty', prior: 'p1', plan: 'p2', downgrades: [] });
  const opts = (max: number): DriveOpts => ({ max, repairs: 2, project: 'hash0', root: '/repo', applied: new Set(), rejected: new Map(), blobs: new Map() });
  let s = state();
  assert.equal(s.nodes.b!.phase, 'removed');
  assert.deepEqual(decide(s, s.plan, new Map(), opts(1)), [], 'b\'s writer may still run: max 1 is taken');
  assert.deepEqual(decide(s, s.plan, new Map(), opts(2)).map(a => `${a.do} ${a.node}`), ['dispatch a']);
  // The reducer refuses entries naming a node outside the plan: the slot is abandoned with b back in the plan.
  add({ kind: 'plan', by: 'owner:human', channel: 'tty', prior: 'p2', plan: 'p1', downgrades: [] });
  add({ kind: 'abandon', by: 'parent:main', node: 'b', attempt: 1 } as Draft);
  add({ kind: 'plan', by: 'owner:human', channel: 'tty', prior: 'p1', plan: 'p2', downgrades: [] });
  s = state();
  assert.equal(s.nodes.b!.phase, 'removed');
  assert.deepEqual(decide(s, s.plan, new Map(), opts(1)).map(a => `${a.do} ${a.node}`), ['dispatch a'], 'abandoned: the slot is free');
});

test('G3.6: the text line of a failed send names its node as a word', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    await r.put('README', 'x\n'); await r.commit();
    await ops.init({ cwd: r.cwd, as: owner, channel: 'flag', plan: JSON.stringify(planOf(nodeOf('a'))) });
    await ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' });
    class Failing extends Dsa {
      constructor() { super({ bin: '/nonexistent/dsa' }); }
      override async run(rid: string): Promise<RunResult> { return { outcome: 'applied', wid: 'w1', created: true, spec_digest: rid }; }
      override async inspect(rid: string): Promise<{ view: RunView; gen?: number }> { return { view: { rid, state: 'sealed', status: 'ok' } }; }
      override async send(): Promise<SendResult> { throw new DsaError('timed out waiting for the ledger lock held by pid 1; retry'); }
    }
    const lines: string[] = [], dsa = new Failing();
    const d = new Driver({ cwd: r.cwd, log: l => lines.push(l), dsa, session: null, handleSignals: false });
    await d.pass(); await d.pass();
    const rid = runId(d.project!, 'a', 1, 'writer');
    const line = lines.find(l => l.startsWith('send '));
    assert.equal(line?.startsWith(`send follow-up (submit) for node a to ${rid}: error — timed out waiting for the ledger lock`), true, lines.join('\n'));
    assert.ok(line!.split(/\s+/).includes('a'), line);
  } finally { await r.cleanup(); }
});
