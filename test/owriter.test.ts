// WR1–WR2: fake dsa replies and real owed slots; no live dsa 1.1.0 dependency.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import { writerReply, writerStopNeed, writerDecisionCommand, renderStatus, renderWhy } from '../src/views.ts';
import { activity, needs } from '../src/needs.ts';
import { assembleRuntime } from '../src/activity.ts';
import { Dsa, toRunView } from '../src/dsa.ts';
import { Driver, procStart } from '../src/drive-run.ts';
import { Follower } from '../src/drive-bg.ts';
import { decide, writerLaunch, rebaseMessage, submitMessage } from '../src/drive.ts';
import { Ledger } from '../src/ledger.ts';
import { entriesOf, projectId } from '../src/reducer.ts';
import { rebasePending } from '../src/rebase-view.ts';
import type { RunView, SendReason } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { commitAt, cli } from './helpers/surface.ts';

const quote = (s: string) => `writer says: ${JSON.stringify(s)}`;
const waiting: NonNullable<RunView['awaiting']> = [{ request: 'owed-check', wid: 'child', state: 'running' }];
const parent = { role: 'parent', id: 'test' } as const;
const owner = { role: 'owner', id: 'test' } as const;
const writer = { role: 'writer', id: 'a#1' } as const;
const commit = (n: number) => n.toString(16).padStart(40, 'a');
const durable = (n: number) => `01${String(n).padStart(24, '0')}`;

test('WR1 whole final text and code points: whitespace, 600 boundary, 601 head/tail, empty', () => {
  assert.equal(writerReply('  Evidence\r\n\r\nAPI\tchosen.  '), quote('Evidence API chosen.'));
  assert.equal(writerReply('😀'.repeat(600)), quote('😀'.repeat(600)));
  assert.equal(writerReply('😀'.repeat(601)), quote('😀'.repeat(200) + ' … ' + '😀'.repeat(380)));
  assert.equal(writerReply(' \n\t '), 'writer gave no final text');
  assert.equal(writerReply(), 'writer gave no final text');
});

test('WR1 head/tail cut back to nearby spaces but not beyond 20 code points', () => {
  const text = 'a'.repeat(185) + ' ' + 'b'.repeat(20) + 'M'.repeat(50) + 'c'.repeat(10) + ' ' + 'd'.repeat(369);
  assert.equal(writerReply(text), quote('a'.repeat(185) + ' … ' + 'd'.repeat(369)));
  assert.equal(writerReply('a'.repeat(179) + ' ' + 'b'.repeat(430)), quote('a'.repeat(179) + ' ' + 'b'.repeat(20) + ' … ' + 'b'.repeat(380)));
});

test('WR1 facts: scan omitted middle, keep first appearance, skip fully shown, deduplicate, cap three each', () => {
  const first = commit(1), hidden = [commit(2), commit(3), commit(4), commit(5)], ids = [durable(1), durable(2), durable(3), durable(4)];
  const text = `Shown ${first} ${ids[0]} ` + 'h'.repeat(200) + `\ncommit: ${hidden[0]} HEAD ${hidden[1]} head:${hidden[2]} 提交 ${hidden[3]} ${hidden[0]} ${ids.slice(1).join(' ')} ${durable(5)}\n` + 't'.repeat(400);
  const reply = writerReply(text);
  assert.ok(reply.startsWith('writer says: "Shown '));
  assert.ok(reply.endsWith(` (commits: ${hidden.slice(0, 3).map(c => c.slice(0, 12)).join(', ')}; durable: ${ids.slice(1).join(', ')})`), reply);
  assert.equal(writerReply(`${first} ${ids[0]}`), quote(`${first} ${ids[0]}`));
});

test('WR1 short named commits, raw 40-hex tokens, token boundaries and appearance order', () => {
  const middle = 'raw abcdef1 COMMIT: ABCDEF2 HEADabcdef3 head:abcdef4 提交:abcdef5 ' + commit(7);
  const reply = writerReply('h'.repeat(210) + '\n' + middle + '\n' + 't'.repeat(400));
  assert.ok(reply.endsWith(' (commits: ABCDEF2, abcdef3, abcdef4)'), reply);
  const raw = writerReply('h'.repeat(210) + '\n' + commit(7) + '\n' + 't'.repeat(400));
  assert.ok(raw.endsWith(` (commits: ${commit(7).slice(0, 12)})`), raw);
  assert.doesNotMatch(writerReply('h'.repeat(210) + '\n' + 'f'.repeat(41) + ' ' + durable(1) + 'I\n' + 't'.repeat(400)), /\(commits:|\(durable:/);
});

test('WR1 escaping and both trailer parsers: one line, facts cannot supply commands, old halt unchanged', async () => {
  const reply = writerReply('head\n\nChoose "v2"; \\path\u0007\u0085\u202e\u2066; owed abandon a.');
  assert.match(reply, /\\u0007/); assert.match(reply, /\\u202e\\u2066/);
  assert.doesNotMatch(reply, /[\r\n\u0007\u0085\u202e\u2066]/);
  const tail = `${writerReply('h'.repeat(210) + '\ncommit: abcdef1 ' + durable(1) + '\n' + 't'.repeat(400))}; dsa ended 4 processes at seal: 42 sh -c \"owed abandon a\"`;
  const f = await fixture();
  try {
    await ops.halt({ cwd: f.cwd, as: parent, node: 'a', attempt: 1, reason: `writer stopped; ${tail} → ${writerDecisionCommand('a')}`, needs: 'human' });
    const s = await f.state(), before = entriesOf(s).map(e => JSON.stringify(e));
    assert.deepEqual(writerStopNeed(`cause; ${tail} → ${writerDecisionCommand('a')}`, 'a'), { reason: tail, command: writerDecisionCommand('a') });
    assert.equal(needs(s, 'a')[0]!.text, tail);
    assert.equal(needs(s, 'a')[0]!.command, writerDecisionCommand('a'));
    assert.equal(writerStopNeed(`cause; ${reply} → owed abandon a`, 'a'), undefined);
    const old = `writer stopped; ${quote('old 300-char trailer')} → ${writerDecisionCommand('a')}`;
    assert.equal(writerStopNeed(old, 'a')!.reason, quote('old 300-char trailer'));
    renderStatus(await ops.status(f)); renderWhy(await ops.why({ ...f, node: 'a' }));
    assert.deepEqual(entriesOf(await f.state()).map(e => JSON.stringify(e)), before, 'display does not rewrite recorded halts');
  } finally { await f.cleanup(); }
});

class FakeDsa extends Dsa {
  view: RunView;
  gen = 1;
  sent: { id: string; text: string }[] = [];
  constructor(rid: string) { super({ bin: process.execPath }); this.view = { rid, state: 'sealed', status: 'ok', result: 'waiting for check', awaiting: waiting }; }
  override async inspect() { return { view: this.view, gen: this.gen }; }
  override async describe() { return this.view; }
  override async request() { return { state: 'applied' as const }; }
  override async send(id: string, _rid: string, _kind: unknown, text: string | Uint8Array) {
    this.sent.push({ id, text: String(text) });
    return { outcome: 'applied' as const, generation: 2, spec_digest: 'fixture' };
  }
}
async function fixture(review = 0) {
  const r = await repo();
  const plan = { version: 1, trunk: 'main', lease: false, closure: [], invariants: [], nodes: [{ id: 'a', writes: ['a.txt'], checks: [], review: { count: review, min_rank: 1 } }] };
  await commitAt(r.cwd, { 'plan.json': JSON.stringify(plan), 'a.txt': 'base' });
  await ops.init({ cwd: r.cwd, as: owner, channel: 'flag', plan: JSON.stringify(plan) });
  const slot = await ops.dispatch({ ...r, as: parent, node: 'a' });
  const state = async () => (await ops.readState(r)).state;
  const s = await state(), launch = writerLaunch(s, 'a', projectId(s));
  await ops.launch({ ...r, as: parent, ...launch });
  const dsa = new FakeDsa(launch.rid), ledger = await Ledger.open(r.cwd), log = join(r.root, 'driver.jsonl');
  await writeFile(log, '');
  const driver = new Driver({ cwd: r.cwd, dsa, session: null, json: true, log: l => appendFileSync(log, l + '\n') });
  const send = (reason: SendReason, message: string) => ops.send({ ...r, as: parent, node: 'a', attempt: 1, rid: launch.rid, sendKind: 'follow-up', reason, message });
  async function rebase() {
    await commitAt(r.cwd, { trunk: String((await ledger.read()).length) });
    await ops.adopt({ cwd: r.cwd, as: owner, channel: 'flag', note: 'move trunk' });
    return ops.rebase({ ...r, as: parent, node: 'a' });
  }
  function policy(options = {}) {
    return state().then(s => decide(s, s.plan, new Map([[launch.rid, dsa.view]]), { max: 1, repairs: 2, project: projectId(s), root: r.cwd, applied: new Set(s.nodes.a!.runs[0]!.sends.map(x => x.send)), rejected: new Map(), ...options }));
  }
  return { ...r, slot, state, launch, dsa, driver, ledger, log, send, rebase, policy };
}

test('WR2 RunView takes optional facts from last call only; old/unknown dsa stays absent', () => {
  const ended = [{ pid: 123, command: 'sleep 90' }];
  for (const state of ['sealed', 'pruned', 'running']) {
    const v = toRunView('writer', { state, status: 'done', pruned: { status: 'done' }, calls: [{ key: 'old', awaiting: [{ request: 'old', state: 'pending' }] }, { key: 'writer', awaiting: waiting, endedAtSeal: ended, endedAtSealMore: 4 }] });
    assert.deepEqual(v.awaiting, waiting); assert.deepEqual(v.endedAtSeal, ended); assert.equal(v.endedAtSealMore, 4);
  }
  for (const d of [{ state: 'sealed', status: 'done' }, { state: 'future', awaiting: waiting }, { state: 'sealed', calls: [{ awaiting: waiting }, {}] }]) {
    const v = toRunView('writer', d);
    assert.equal(Object.hasOwn(v, 'awaiting'), false); assert.equal(Object.hasOwn(v, 'endedAtSeal'), false); assert.equal(Object.hasOwn(v, 'endedAtSealMore'), false);
  }
});

for (const state of ['sealed', 'pruned'] as const) for (const work of ['clean', 'dirty', 'unknown'] as const) test(`WR2 row 8 ${state}/${work}: awaiting waits, absence restores stopped/nudge`, async () => {
  const f = await fixture();
  try {
    f.dsa.view.state = state;
    const opts = work === 'unknown' ? {} : { writerWork: new Map([['a', { head: (await f.state()).nodes.a!.slot!.base, dirty: work === 'dirty' }]]) };
    assert.deepEqual(await f.policy(opts), []);
    delete f.dsa.view.awaiting;
    assert.equal((await f.policy(opts))[0]!.do, work === 'dirty' ? 'send' : 'halt');
  } finally { await f.cleanup(); }
});

test('WR2 after submit nudge or plan invalidation: no second nudge/no-submit halt while awaiting', async () => {
  const f = await fixture();
  try {
    await f.send('submit', submitMessage('a'));
    assert.deepEqual(await f.policy(), []);
    await commitAt(f.slot.worktree, { 'a.txt': 'candidate' });
    await ops.submit({ cwd: f.slot.worktree, as: writer, node: 'a' });
    const p = structuredClone((await f.state()).plan); p.nodes[0]!.brief = 'changed';
    await ops.planSet({ ...f, as: parent, plan: JSON.stringify(p) });
    assert.equal((await f.state()).nodes.a!.candidate, undefined);
    assert.deepEqual(await f.policy(), []);
    delete f.dsa.view.awaiting;
    assert.ok((await f.policy()).some(a => a.do === 'send' && a.reason === 'submit'));
  } finally { await f.cleanup(); }
});

test('WR2 pending rebase: first follow-up still sent; after it no halt/nudge, including later ruling', async () => {
  const f = await fixture();
  try {
    await f.rebase(); const s = await f.state(), drift = await rebasePending(s, 'a'); assert.ok(drift);
    const opts = { rebasePending: new Map([['a', drift]]) };
    assert.ok((await f.policy(opts)).some(a => a.do === 'send' && a.reason === 'rebase'));
    await f.send('rebase', rebaseMessage(s, 'a'));
    assert.deepEqual(await f.policy(opts), []);
    await ops.rule({ ...f, as: parent, nodes: ['a'], writer: true, text: 'apply the API ruling' });
    assert.ok((await f.policy(opts)).some(a => a.do === 'send' && a.reason === 'ruling'));
    await ops.send({ ...f, as: parent, node: 'a', attempt: 1, rid: f.launch.rid, sendKind: 'follow-up', reason: 'ruling', rulings: (await f.state()).rules.at(-1)!.seq, message: 'apply API' });
    assert.deepEqual(await f.policy(opts), []);
    delete f.dsa.view.awaiting;
    assert.ok((await f.policy(opts)).some(a => a.do === 'halt' && /finished ruling follow-up/.test(a.reason)));
  } finally { await f.cleanup(); }
});

test('WR2 repair/ruling follow-ups still sent; later no-submit/budget halts wait without a candidate', async () => {
  const f = await fixture(1);
  try {
    await commitAt(f.slot.worktree, { 'a.txt': 'candidate' });
    await ops.submit({ cwd: f.slot.worktree, as: writer, node: 'a' });
    await ops.review({ ...f, as: { role: 'reviewer', id: 'independent' }, node: 'a', verdict: 'block', rank: 1, note: 'fix API' });
    await f.rebase();
    assert.equal((await f.state()).nodes.a!.candidate, undefined);
    assert.ok((await f.policy()).some(a => a.do === 'send' && a.reason === 'repair'));
    assert.deepEqual(await f.policy({ repairs: 0 }), [], 'repair budget halt waits');
    await f.send('repair', 'fix API');
    assert.deepEqual(await f.policy(), []);
    await ops.rule({ ...f, as: parent, nodes: ['a'], writer: true, text: 'apply API v2' });
    assert.ok((await f.policy()).some(a => a.do === 'send' && a.reason === 'ruling'));
    await ops.send({ ...f, as: parent, node: 'a', attempt: 1, rid: f.launch.rid, sendKind: 'follow-up', reason: 'ruling', rulings: (await f.state()).rules.at(-1)!.seq, message: 'apply API v2' });
    assert.deepEqual(await f.policy(), []);
  } finally { await f.cleanup(); }
});

test('WR2 non-ok seal still halts with awaiting and bounded ended-process diagnostics; parser/display round trip', async () => {
  const f = await fixture();
  try {
    f.dsa.view.status = 'failed';
    f.dsa.view.awaiting = [{ request: 'job\nname', state: 'pending' }, { request: 'next', state: 'finished' }];
    f.dsa.view.endedAtSeal = [{ pid: 42, command: 'x'.repeat(100) }, { pid: 43, command: 'sh\n-c\u202e sleep 90' }, { pid: 44, command: 'third' }, { pid: 45, command: 'hidden' }];
    f.dsa.view.endedAtSealMore = 5;
    const h = (await f.policy())[0]; assert.ok(h?.do === 'halt');
    assert.ok(h.reason.includes('; awaiting durable job\\nname (pending); awaiting durable next (finished)'));
    assert.ok(h.reason.includes(`; dsa ended 9 processes at seal: 42 ${'x'.repeat(80)}, 43 sh\\n-c\\u202e sleep 90, 44 third`));
    assert.doesNotMatch(h.reason, /hidden|[\n\u202e]/);
    const parsed = writerStopNeed(h.reason, 'a'); assert.ok(parsed?.reason.includes('dsa ended 9'));
    await f.driver.pass();
    const s = await f.state(); assert.ok(needs(s, 'a')[0]!.text.includes('awaiting durable'));
    assert.ok((await cli(f.cwd, ['why', 'a'])).stdout.includes('dsa ended 9'));
  } finally { await f.cleanup(); }
});

test('WR2 stopped/no-submit halts include ended processes without requiring awaiting', async () => {
  const f = await fixture();
  try {
    delete f.dsa.view.awaiting;
    f.dsa.view.endedAtSeal = [{ pid: 99, command: 'sleep 90' }];
    const opts = { writerWork: new Map([['a', { head: (await f.state()).nodes.a!.slot!.base, dirty: false }]]) };
    const stopped = (await f.policy(opts))[0]; assert.ok(stopped?.do === 'halt');
    assert.match(stopped.reason, /writer stopped.*; dsa ended 1 processes at seal: 99 sleep 90/);
    await f.send('submit', submitMessage('a'));
    const noSubmit = (await f.policy(opts))[0]; assert.ok(noSubmit?.do === 'halt');
    assert.match(noSubmit.reason, /finished without submitting.*; dsa ended 1 processes at seal: 99 sleep 90/);
  } finally { await f.cleanup(); }
});

test('WR2 current candidate does not gain a durable wait exemption', async () => {
  const f = await fixture(1);
  try {
    await commitAt(f.slot.worktree, { 'a.txt': 'candidate' }); await ops.submit({ cwd: f.slot.worktree, as: writer, node: 'a' });
    await ops.attest({ cwd: f.cwd, node: 'a' });
    await ops.review({ ...f, as: { role: 'reviewer', id: 'independent' }, node: 'a', verdict: 'block', rank: 1, note: 'fix API' });
    await f.send('repair', 'fix API');
    assert.ok((await f.policy()).some(a => a.do === 'halt'));
    await f.driver.pass();
    assert.deepEqual((await assembleRuntime({ cwd: f.cwd, state: await f.state(), driverRunning: true })).writerWaiting, [], 'a current candidate never publishes durable waiting');
  } finally { await f.cleanup(); }
});

test('WR2 runtime cache: status/why show seal age, no need/wake; cleared/stale/stopped facts stay unknown', async t => {
  const f = await fixture();
  try {
    const now = Date.now(); t.mock.timers.enable({ apis: ['Date'], now });
    await f.driver.pass();
    const before = (await f.ledger.read()).length;
    t.mock.timers.setTime(now + 65_000); await f.driver.pass();
    assert.deepEqual(f.dsa.sent, []); assert.equal((await f.ledger.read()).length, before);
    const s = await f.state(), runtime = await assembleRuntime({ cwd: f.cwd, state: s, driverRunning: true, now: now + 65_000 });
    assert.equal(activity(s, 'a', runtime)!.text, 'writer waiting on durable owed-check (running, 65s)');
    assert.deepEqual(needs(s, 'a', runtime), []);
    const lock = join(f.ledger.dir, 'drive.lock');
    await writeFile(lock, JSON.stringify({ pid: process.pid, start: procStart(process.pid), host: hostname(), at: new Date(now).toISOString(), token: 'fixture' }));
    for (const args of [['status'], ['status', '--full'], ['why', 'a']]) {
      const r = await cli(f.cwd, args); assert.equal(r.code, 0, r.stderr);
      assert.match(r.stdout, /a: writer waiting on durable owed-check \(running, \d+s\)/);
      assert.doesNotMatch(r.stdout, /Needs you \([1-9]/);
    }
    const follower = new Follower({ log: f.log, repo: f.cwd, pid: process.pid, start: procStart(process.pid), deliver() {} });
    assert.equal(await follower.step(), undefined);
    await rm(lock);
    assert.equal((await assembleRuntime({ cwd: f.cwd, state: s })).writerWaiting, undefined);
    assert.equal((await assembleRuntime({ cwd: f.cwd, state: s, driverRunning: false })).writerWaiting, undefined);
    await writeFile(join(f.ledger.dir, 'drive', 'writer-waiting.json'), JSON.stringify([{ ...runtime.writerWaiting![0], attempt: 2 }, null]));
    assert.deepEqual((await assembleRuntime({ cwd: f.cwd, state: s, driverRunning: true })).writerWaiting, []);
    const restarted = new Driver({ cwd: f.cwd, dsa: f.dsa, session: null, log() {} });
    await restarted.pass();
    assert.equal(activity(s, 'a', await assembleRuntime({ cwd: f.cwd, state: s, driverRunning: true, now: now + 65_000 }))!.text, 'writer waiting on durable owed-check (running, 0s)', 'approximate age resets on driver restart');
    f.dsa.gen = 2; await f.driver.pass();
    assert.equal(activity(s, 'a', await assembleRuntime({ cwd: f.cwd, state: s, driverRunning: true, now: now + 65_000 }))!.text, 'writer waiting on durable owed-check (running, 0s)', 'new sealed generation resets approximate age');
    f.dsa.gen = 3; f.dsa.view = { rid: f.launch.rid, state: 'running' }; await f.driver.pass();
    assert.deepEqual((await assembleRuntime({ cwd: f.cwd, state: s, driverRunning: true })).writerWaiting, []);
  } finally { t.mock.timers.reset(); await f.cleanup(); }
});

test('WR2/R-029-3 sealedAt age is exact, generation-bound, invalid values absent and future clamped', async t => {
  const f = await fixture();
  try {
    const now = Date.now(); t.mock.timers.enable({ apis: ['Date'], now });
    const described = (sealedAt: unknown) => toRunView(f.launch.rid, { state: 'sealed', status: 'done', calls: [{ key: 'writer', gen: f.dsa.gen, status: 'ok', awaiting: waiting, sealedAt }] });
    f.dsa.view = described(now - 120_000); await f.driver.pass();
    const s = await f.state();
    const text = async (at = now) => activity(s, 'a', await assembleRuntime({ cwd: f.cwd, state: s, driverRunning: true, now: at }))!.text;
    assert.equal(await text(), 'writer waiting on durable owed-check (running, 120s)');
    const restarted = new Driver({ cwd: f.cwd, dsa: f.dsa, session: null, log() {} }); await restarted.pass();
    assert.equal(await text(), 'writer waiting on durable owed-check (running, 120s)', 'exact age survives driver restart');
    f.dsa.gen = 2; f.dsa.view = described(now - 10_000); await f.driver.pass();
    assert.equal(await text(), 'writer waiting on durable owed-check (running, 10s)', 'new generation uses its own seal');
    for (const invalid of [String(now), Number.NaN, Number.POSITIVE_INFINITY]) {
      f.dsa.gen++; f.dsa.view = described(invalid); assert.equal(Object.hasOwn(f.dsa.view, 'sealedAt'), false);
      await f.driver.pass(); assert.equal(await text(), 'writer waiting on durable owed-check (running, 0s)');
      assert.equal(await text(now + 30_000), 'writer waiting on durable owed-check (running, 30s)');
    }
    f.dsa.gen++; f.dsa.view = described(now + 30_000); await f.driver.pass();
    assert.equal(await text(), 'writer waiting on durable owed-check (running, 0s)', 'future time clamps age to zero');
    assert.equal(await text(now + 60_000), 'writer waiting on durable owed-check (running, 30s)');
    assert.deepEqual(f.dsa.sent, []); assert.equal((await f.ledger.read()).some(e => e.kind === 'halt'), false, 'age never selects an action');
    assert.equal(Object.hasOwn(toRunView('r', { state: 'running', calls: [{ sealedAt: now }] }), 'sealedAt'), false);
  } finally { t.mock.timers.reset(); await f.cleanup(); }
});

for (const state of ['sealed', 'pruned'] as const) test(`R-029-5 observed running gen1, applied follow-up gen2, stale ${state} gen1 recovers idempotently`, async () => {
  const f = await fixture();
  try {
    f.dsa.gen = 1; f.dsa.view = { rid: f.launch.rid, state: 'running' };
    await f.driver.pass();
    const send = await f.send('submit', submitMessage('a'));
    // The send applied between passes; an old dsa reply still describes generation 1.
    f.dsa.view = { rid: f.launch.rid, state, status: 'ok', result: 'old generation finished' };
    await f.driver.pass();
    assert.equal((await f.ledger.read()).filter(e => e.kind === 'halt').length, 0, 'stale gen1 cannot halt the already-applied gen2 follow-up');
    assert.deepEqual(f.dsa.sent, [{ id: send.send, text: submitMessage('a') }], 'recover using the recorded id and exact message');
    assert.equal(f.driver.facts.sentGen.get(send.send), 2, 'idempotent reply, not observed running state, determines generation');
    await f.driver.pass();
    assert.equal(f.dsa.sent.length, 1, 'recovery is cached while describe remains stale');
    assert.equal((await f.ledger.read()).filter(e => e.kind === 'halt').length, 0);
    f.dsa.gen = 2; f.dsa.view = { rid: f.launch.rid, state: 'running' };
    await f.driver.pass();
    assert.equal((await f.ledger.read()).filter(e => e.kind === 'halt').length, 0);
    f.dsa.view = { rid: f.launch.rid, state: 'sealed', status: 'ok', result: 'current generation finished' };
    await f.driver.pass();
    const h = (await f.ledger.read()).findLast(e => e.kind === 'halt'); assert.ok(h?.kind === 'halt');
    assert.ok(h.reason.includes(send.send)); assert.ok(h.reason.includes('current generation finished')); assert.doesNotMatch(h.reason, /old generation finished/);
    assert.equal(f.dsa.sent.length, 1);
  } finally { await f.cleanup(); }
});

test('WR2 foreign wake generation after owed follow-up: idempotent recovery, stale prior seal ignored, current seal follows rows', async () => {
  const f = await fixture();
  try {
    const send = await f.send('submit', submitMessage('a'));
    f.dsa.gen = 3; f.dsa.view = { rid: f.launch.rid, state: 'running' };
    await f.driver.pass();
    f.dsa.gen = 2; f.dsa.view = { rid: f.launch.rid, state: 'sealed', status: 'ok', result: 'old follow-up seal' };
    await f.driver.pass();
    assert.equal((await f.ledger.read()).some(e => e.kind === 'halt'), false, 'old owed generation cannot halt the foreign running generation');
    f.dsa.gen = 3; f.dsa.view = { rid: f.launch.rid, state: 'sealed', status: 'ok', result: 'foreign wake finished' };
    await f.driver.pass();
    assert.deepEqual(f.dsa.sent, [{ id: send.send, text: submitMessage('a') }], 'recovery asks the original request once; dsa returns its original gen2 outcome');
    assert.equal(f.driver.facts.sentGen.get(send.send), 2);
    assert.equal(f.driver.facts.lastGen.get(f.launch.rid), 3, 'foreign wake advances current() fence independently of the owed send');
    const h = (await f.ledger.read()).findLast(e => e.kind === 'halt'); assert.ok(h?.kind === 'halt');
    assert.ok(h.reason.includes(send.send)); assert.ok(h.reason.includes('foreign wake finished')); assert.doesNotMatch(h.reason, /old follow-up seal/);
    await ops.resume({ cwd: f.cwd, as: parent, node: 'a' });
    f.dsa.view.awaiting = waiting; await f.driver.pass();
    assert.equal(f.dsa.sent.length, 1, 'releasing the halt retains the cached recovery answer, without another delivery');
  } finally { await f.cleanup(); }
});

test('WR2 writer dispatch packet contains exact long-run instructions immediately after checks', async () => {
  const f = await fixture();
  try {
    const s = await f.state();
    const expected = `Long runs: processes you start end when your turn ends. Run a check or measurement that may outlive your turn as a durable command call, then end your turn without submitting:\n  pi-durable-subagents run --request owed-${projectId(s)}-a-1-<name> --wake caller -- <command…>\nowed does not halt you while it runs; dsa resumes you with its exit status and output tail (pi-durable-subagents >= 1.1.0).`;
    const dispatch = (await f.ledger.read()).find(e => e.kind === 'dispatch'); assert.ok(dispatch?.kind === 'dispatch');
    for (const packet of [JSON.parse(f.launch.spec).task, (await f.ledger.getBlob(dispatch.packet)).toString()]) {
      assert.ok(packet.includes(`Checks run by owed:\n${expected}\nApplicable rulings:`), packet);
    }
  } finally { await f.cleanup(); }
});
