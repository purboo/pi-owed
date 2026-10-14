// AN1–AN3: durable answers, retry identity, authority and per-run ruling delivery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import * as ops from '../src/ops.ts';
import { Dsa, type SendResult } from '../src/dsa.ts';
import { answerRetry } from '../src/answer.ts';
import { askingText, decide, deliveredRulings, rulingFollowUp, writerLaunch } from '../src/drive.ts';
import { projectId, runId, runLabels, validateDraft } from '../src/reducer.ts';
import type { RuleEntry, RunView } from '../src/types.ts';
import owed from '../src/extension.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const parent = { role: 'parent' as const, id: 'test' };
class FakeDsa {
  views = new Map<string, RunView>();
  sends: { id: string; to: string; kind: string; message: string; qid?: string; rev?: number }[] = [];
  outcome: SendResult = { outcome: 'applied', spec_digest: 'digest' };
  error?: string;
  async describe(rid: string): Promise<RunView> { return this.views.get(rid) ?? { rid, state: 'sealed', status: 'ok' }; }
  async send(id: string, to: string, kind: string, message: string | Uint8Array, extra: { qid?: string; rev?: number } = {}): Promise<SendResult> {
    this.sends.push({ id, to, kind, message: String(message), ...extra });
    if (this.error) throw new Error(this.error);
    if (this.outcome.outcome === 'applied' && kind !== 'notify') this.views.set(to, { rid: to, state: 'running' });
    return this.outcome;
  }
  ask(rid: string, qid = 'q1', rev = 2) { this.views.set(rid, { rid, state: 'asking', questions: [{ qid, rev, question: 'Which API?', to: 'w1/main' }] }); }
}
async function fixture() {
  const r = await repo(), plan = JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [], nodes: [{ id: 'a', writes: ['a.txt'], checks: [], review: { count: 1, min_rank: 1 } }] });
  await r.put('plan.json', plan); await r.commit();
  await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'pi' }, channel: 'delegated', plan });
  const slot = await ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' });
  const state = (await ops.readState(r)).state, project = projectId(state), built = writerLaunch(state, 'a', project);
  const writer = (await ops.launch({ cwd: r.cwd, as: parent, node: 'a', attempt: 1, role: 'writer', rid: built.rid, spec: built.spec, labels: built.labels, rulings: built.rulings })).entry;
  const dsa = new FakeDsa(); dsa.ask(writer.rid);
  const opts = { cwd: r.cwd, as: parent, node: 'a', text: 'Use API v2', dsa };
  const rules = async () => (await ops.readState(r)).entries.filter((e): e is RuleEntry => e.kind === 'rule');
  async function reviewer(n = 1, attempt = 1) {
    const rid = runId(project, 'a', attempt, 'reviewer', n);
    return (await ops.launch({ cwd: r.cwd, as: parent, node: 'a', attempt, role: 'reviewer', rid, spec: '{}', labels: runLabels(project, 'a', attempt, 'reviewer'), rulings: 0 })).entry;
  }
  return { ...r, slot, project, writer, dsa, opts, rules, reviewer };
}

test('AN1/AN2: one writer question needs no qid; records one noninvalidating rule before sending', async () => {
  const f = await fixture();
  try {
    await commitAt(f.slot.worktree, { 'a.txt': 'v2' });
    const candidate = await ops.submit({ cwd: f.slot.worktree, as: { role: 'writer', id: 'a#1' }, node: 'a' });
    const original = f.dsa.send.bind(f.dsa);
    f.dsa.send = async (...args) => { assert.equal((await f.rules()).length, 1, 'rule committed before external send'); return original(...args); };
    const r = await ops.answer(f.opts);
    assert.equal(r.entry.text, 'Answer to writer question q1: Use API v2');
    assert.equal(r.entry.writer, false); assert.deepEqual(r.entry.nodes, ['a']);
    assert.deepEqual(r.entry.answer, { rid: f.writer.rid, qid: 'q1', rev: 2 });
    assert.deepEqual(f.dsa.sends, [{ id: `owed-answer-${r.entry.seq}`, to: f.writer.rid, kind: 'answer', message: 'Use API v2', qid: 'q1', rev: 2 }]);
    assert.equal((await ops.readState(f)).state.nodes.a!.candidate!.seq, candidate.seq);
    assert.equal((await ops.readState(f)).state.nodes.a!.items.find(i => i.obligation === 'rulings')!.status, 'D', 'answer still needs acknowledgment');
    assert.equal((await ops.verify(f)).ok, true);
  } finally { await f.cleanup(); }
});

test('AN1: reviewer questions and ambiguous qids across runs list every open question', async () => {
  const f = await fixture();
  try {
    const reviewer = await f.reviewer(); f.dsa.ask(reviewer.rid);
    await assert.rejects(ops.answer(f.opts), /Ambiguous question.*writer rid.*reviewer rid/);
    await assert.rejects(ops.answer({ ...f.opts, qid: 'q1' }), /Ambiguous question/);
    assert.equal((await f.rules()).length, 0); assert.equal(f.dsa.sends.length, 0);
    const r = await ops.answer({ ...f.opts, rid: reviewer.rid });
    assert.equal(r.entry.text, 'Answer to reviewer question q1: Use API v2');
    assert.equal(r.entry.answer!.rid, reviewer.rid);
    const { state } = await ops.readState(f);
    assert.equal(deliveredRulings(state, 'a', state.nodes.a!.runs[0]!, reviewer), r.entry.seq);
    assert.ok(rulingFollowUp(state, 'a')!.message.includes(r.entry.text), 'writer receives the reviewer answer normally');
    await ops.answer(f.opts); // only the writer is still asking
    assert.equal((await f.rules()).length, 2);
  } finally { await f.cleanup(); }
});

test('AN1: no question, unknown selector, multiple questions in one run and describe failure record nothing', async () => {
  const f = await fixture();
  try {
    await assert.rejects(ops.answer({ ...f.opts, qid: 'missing' }), /No matching open question.*qid q1/);
    await assert.rejects(ops.answer({ ...f.opts, rid: 'missing' }), /No matching open question.*writer rid/);
    f.dsa.views.get(f.writer.rid)!.questions!.push({ qid: 'q2', rev: 1, question: 'Scope?' });
    await assert.rejects(ops.answer(f.opts), /Ambiguous question.*qid q1.*qid q2/);
    f.dsa.views.clear(); await assert.rejects(ops.answer(f.opts), /open questions: none/);
    f.dsa.describe = async () => { throw new Error('describe unavailable'); };
    await assert.rejects(ops.answer(f.opts), /describe unavailable/);
    assert.equal((await f.rules()).length, 0); assert.equal(f.dsa.sends.length, 0);
  } finally { await f.cleanup(); }
});

test('AN1: parent/owner only; subagent, driver and invalid text are refused before dsa', async () => {
  const f = await fixture();
  try {
    for (const role of ['writer', 'reviewer', 'executor'] as const) await assert.rejects(ops.answer({ ...f.opts, as: { role, id: 'x' } }), /requires parent or owner/);
    await assert.rejects(ops.answer({ ...f.opts, as: { role: 'parent', id: 'drive' } }), /driver never answers/);
    await assert.rejects(ops.answer({ ...f.opts, text: ' ' }), /nonempty text/);
    await assert.rejects(ops.answer({ ...f.opts, qid: '' }), /qid must be nonempty/);
    const prior = process.env.DSA_CALL; process.env.DSA_CALL = 'call';
    try { await assert.rejects(ops.answer(f.opts), /reserved for the main agent/); } finally { if (prior === undefined) delete process.env.DSA_CALL; else process.env.DSA_CALL = prior; }
    assert.equal((await f.rules()).length, 0);
    const r = await ops.answer({ ...f.opts, as: { role: 'owner', id: 'pi' }, channel: 'delegated' });
    assert.equal(r.entry.by, 'owner:pi'); assert.equal(r.entry.channel, 'delegated');
  } finally { await f.cleanup(); }
});

test('AN2: rejected/pending/conflict/throw preserve rule and exact retry id, revision and quoted text', async () => {
  for (const failure of ['rejected', 'pending', 'conflict', 'throw'] as const) {
    const f = await fixture();
    try {
      f.dsa.ask(f.writer.rid, "q'1", 3);
      const opts = { ...f.opts, text: "Use 'v2'\nthen check $(literal)" };
      if (failure === 'throw') f.dsa.error = 'transport gone';
      else f.dsa.outcome = failure === 'conflict' ? { outcome: failure } : { outcome: failure, reason: 'unavailable' };
      let error: unknown; try { await ops.answer(opts); } catch (e) { error = e; }
      const [entry] = await f.rules(); assert.ok(entry && error instanceof Error);
      assert.ok(error.message.includes(`Answer rule #${entry.seq} recorded`));
      assert.ok(error.message.endsWith(`Retry exactly: ${answerRetry('a', entry)}`));
      f.dsa.error = undefined; f.dsa.outcome = { outcome: 'applied', spec_digest: 'digest' };
      f.dsa.views.clear(); // retry must work after the question disappears
      const retry = { ...opts, rid: f.writer.rid, qid: "q'1" };
      assert.equal((await ops.answer(retry)).entry.seq, entry.seq);
      assert.deepEqual(f.dsa.sends[1], f.dsa.sends[0]);
      assert.equal((await f.rules()).length, 1);
      await assert.rejects(ops.answer({ ...retry, text: 'changed' }), /different text/);
      assert.equal(f.dsa.sends.length, 2);
    } finally { await f.cleanup(); }
  }
});

test('AN2: concurrent duplicate answers record once; a stale open attempt cannot append', async () => {
  const f = await fixture();
  try {
    const [a, b] = await Promise.all([ops.answer(f.opts), ops.answer(f.opts)]);
    assert.equal(a.entry.seq, b.entry.seq); assert.equal((await f.rules()).length, 1);
    assert.equal(f.dsa.sends[0]!.id, f.dsa.sends[1]!.id);
    f.dsa.ask(f.writer.rid, 'later');
    f.dsa.describe = async rid => { await ops.abandon({ cwd: f.cwd, as: parent, node: 'a', reason: 'stale test' }); return f.dsa.views.get(rid)!; };
    await assert.rejects(ops.answer(f.opts), /current open attempt/);
    assert.equal((await f.rules()).length, 1);
    // Explicit retry still reuses the durable rule after the slot closes.
    await ops.answer({ ...f.opts, rid: f.writer.rid, qid: 'q1' });
    assert.equal((await f.rules()).length, 1);
  } finally { await f.cleanup(); }
});

test('AN2: replay validates answer shape, target launch, writer flag and duplicates', async () => {
  const f = await fixture();
  try {
    const { state } = await ops.readState(f), good = { kind: 'rule' as const, by: 'parent:test', nodes: ['a'], writer: false, text: 'Answer to writer question q1: yes', answer: { rid: f.writer.rid, qid: 'q1', rev: 1 } };
    assert.deepEqual(validateDraft(state, good), []);
    for (const answer of [{ ...good.answer, rev: 0 }, { ...good.answer, rev: 1.5 }, { ...good.answer, rid: 'unknown' }, { ...good.answer, qid: '' }, { ...good.answer, extra: 1 }]) assert.ok(validateDraft(state, { ...good, answer }).length);
    assert.ok(validateDraft(state, { ...good, writer: true }).length);
    assert.ok(validateDraft(state, { ...good, nodes: '*' }).length);
    const r = await ops.answer(f.opts);
    assert.ok(validateDraft((await ops.readState(f)).state, { ...good, answer: r.entry.answer! }).some(x => x.includes('already recorded')));
  } finally { await f.cleanup(); }
});

test('AN3: answering writer suppresses its steer/follow-up, while ordinary older rules are still delivered', async () => {
  const f = await fixture();
  try {
    const older = await ops.rule({ cwd: f.cwd, as: parent, nodes: ['a'], text: 'Earlier guidance' });
    const answer = await ops.answer(f.opts), { state } = await ops.readState(f), ar = state.nodes.a!.runs[0]!;
    assert.ok(deliveredRulings(state, 'a', ar, f.writer) < older.seq, 'answer does not cover a gap');
    const follow = rulingFollowUp(state, 'a')!;
    assert.ok(follow.message.includes('Earlier guidance')); assert.ok(!follow.message.includes('Answer to'));
    const actions = decide(state, state.plan, f.dsa.views, { max: 1, repairs: 2, project: f.project, root: f.cwd, applied: new Set(), rejected: new Map() });
    const steer = actions.find(a => a.do === 'send');
    assert.ok(steer?.do === 'send' && steer.reason === 'ruling'); assert.equal(steer.rulings, older.seq);
    assert.ok(!steer.message.includes(answer.entry.text));
    await ops.send({ cwd: f.cwd, as: parent, node: 'a', attempt: 1, rid: f.writer.rid, sendKind: 'steer', reason: 'ruling', message: steer.message, rulings: older.seq });
    const next = (await ops.readState(f)).state;
    assert.equal(deliveredRulings(next, 'a', next.nodes.a!.runs[0]!, f.writer), answer.entry.seq);
    assert.equal(rulingFollowUp(next, 'a'), undefined);
  } finally { await f.cleanup(); }
});

test('AN3: other reviewer receives the answer and must acknowledge; later attempt receives it in its packet', async () => {
  const f = await fixture();
  try {
    await commitAt(f.slot.worktree, { 'a.txt': 'v2' });
    await ops.submit({ cwd: f.slot.worktree, as: { role: 'writer', id: 'a#1' }, node: 'a' });
    await ops.attest({ cwd: f.cwd, node: 'a' });
    const reviewer = await f.reviewer(); f.dsa.views.set(reviewer.rid, { rid: reviewer.rid, state: 'running' });
    const r = await ops.answer(f.opts), { state } = await ops.readState(f);
    assert.equal(rulingFollowUp(state, 'a'), undefined);
    const action = decide(state, state.plan, f.dsa.views, { max: 1, repairs: 2, project: f.project, root: f.cwd, applied: new Set(), rejected: new Map() }).find(a => a.do === 'send');
    assert.ok(action?.do === 'send' && action.rid === reviewer.rid && action.reason === 'ruling');
    assert.ok(action.message.includes(r.entry.text) && action.message.includes(`--ack-rulings ${r.entry.seq}`));
    await ops.review({ cwd: f.cwd, as: { role: 'reviewer', id: 'independent' }, node: 'a', verdict: 'ok', rank: 1, note: 'review' });
    assert.equal((await ops.readState(f)).state.nodes.a!.items.find(i => i.obligation === 'rulings')!.status, 'D');
    await ops.review({ cwd: f.cwd, as: { role: 'reviewer', id: 'independent' }, node: 'a', verdict: 'ok', rank: 1, note: 'ack', ack_rulings: r.entry.seq });
    assert.equal((await ops.readState(f)).state.nodes.a!.items.find(i => i.obligation === 'rulings')!.status, 'E');
    await ops.abandon({ cwd: f.cwd, as: parent, node: 'a', reason: 'next generation' });
    const later = await ops.dispatch({ cwd: f.cwd, as: parent, node: 'a' });
    assert.ok(later.packet.includes(r.entry.text)); assert.equal(later.attempt, 2);
  } finally { await f.cleanup(); }
});

// Review #1266: exercise real ops state transitions and the messages actually selected by decide.
async function nextAction(f: Awaited<ReturnType<typeof fixture>>) {
  const { state, entries } = await ops.readState(f);
  const applied = new Set(entries.flatMap(e => e.kind === 'send' ? [e.send] : []));
  return decide(state, state.plan, f.dsa.views, { max: 1, repairs: 2, project: f.project, root: f.cwd, applied, rejected: new Map() }).find(a => a.node === 'a');
}
async function sendAction(f: Awaited<ReturnType<typeof fixture>>, action: Awaited<ReturnType<typeof nextAction>>) {
  assert.ok(action?.do === 'send', JSON.stringify(action));
  const entry = await ops.send({ cwd: f.cwd, as: parent, node: action.node, attempt: action.attempt, rid: action.rid, sendKind: action.sendKind, reason: action.reason, message: action.message, rulings: action.rulings });
  await f.dsa.send(entry.send, entry.rid, entry.sendKind, action.message);
  return entry;
}
async function submitted(f: Awaited<ReturnType<typeof fixture>>) {
  await commitAt(f.slot.worktree, { 'a.txt': 'v2' });
  await ops.submit({ cwd: f.slot.worktree, as: { role: 'writer', id: 'a#1' }, node: 'a' });
  await ops.attest({ cwd: f.cwd, node: 'a' });
}

for (const changedBrief of [false, true]) test(`AN3 #1266: ${changedBrief ? 'brief-change resubmit' : 'review-block repair'} never carries the writer answer`, async () => {
  const f = await fixture();
  try {
    await submitted(f);
    await ops.review({ cwd: f.cwd, as: { role: 'reviewer', id: 'drive-a-1-1' }, node: 'a', verdict: 'block', rank: 1, note: 'Fix validation', needs: 'parent' });
    const answer = await ops.answer(f.opts);
    // An answer to another run is ordinary guidance for this writer and must not be filtered out.
    const other = await f.reviewer(); f.dsa.ask(other.rid, 'review-question');
    const otherAnswer = await ops.answer({ ...f.opts, rid: other.rid, text: 'Check validation against v2' });
    if (changedBrief) {
      const { state } = await ops.readState(f);
      const plan = structuredClone(state.plan); plan.nodes[0]!.brief = 'Validate the v2 contract';
      await ops.planSet({ cwd: f.cwd, as: parent, plan: JSON.stringify(plan) });
      assert.equal((await ops.readState(f)).state.nodes.a!.candidate, undefined);
    }
    f.dsa.views.set(f.writer.rid, { rid: f.writer.rid, state: 'sealed', status: 'ok' });
    f.dsa.views.set(other.rid, { rid: other.rid, state: 'sealed', status: 'ok' });
    const action = await nextAction(f);
    assert.ok(action?.do === 'send' && action.reason === 'repair' && action.rid === f.writer.rid, JSON.stringify(action));
    assert.ok(!action.message.includes(answer.entry.text), action.message);
    assert.ok(!action.message.includes(f.opts.text), action.message);
    assert.ok(action.message.includes(otherAnswer.entry.text) && action.message.includes('Fix validation'), action.message);
    assert.equal(action.rulings, otherAnswer.entry.seq);
    if (changedBrief) assert.ok(action.message.includes('The plan changed'), action.message);
    const sent = await sendAction(f, action);
    assert.equal(sent.rulings, otherAnswer.entry.seq);
    assert.ok(!f.dsa.sends.at(-1)!.message.includes(answer.entry.text));
  } finally { await f.cleanup(); }
});

for (const sealed of [false, true]) for (const earlier of [false, true]) test(`AN3 #1266: reviewer ${sealed ? 'follow-up' : 'steer'} acknowledges its answer${earlier ? ' and earlier guidance' : ' alone'} without stalling`, async () => {
  const f = await fixture();
  try {
    await submitted(f);
    const reviewer = await f.reviewer();
    // This reviewer had a verdict before the new rulings, so a sealed run reaches the ruling follow-up path.
    const who = { role: 'reviewer' as const, id: 'drive-a-1-1' };
    await ops.review({ cwd: f.cwd, as: who, node: 'a', verdict: 'ok', rank: 1, note: 'initial review' });
    f.dsa.ask(reviewer.rid, 'review-question');
    const older = earlier ? await ops.rule({ cwd: f.cwd, as: parent, nodes: ['a'], text: 'Earlier guidance' }) : undefined;
    const answer = await ops.answer({ ...f.opts, rid: reviewer.rid, text: 'Validate v2' });
    // The writer already received both, leaving only the reviewer's acknowledgment outstanding.
    await ops.send({ cwd: f.cwd, as: parent, node: 'a', attempt: 1, rid: f.writer.rid, sendKind: 'steer', reason: 'ruling', message: 'Earlier guidance; Validate v2', rulings: answer.entry.seq });
    f.dsa.views.set(f.writer.rid, { rid: f.writer.rid, state: 'sealed', status: 'ok' });
    f.dsa.views.set(reviewer.rid, { rid: reviewer.rid, state: sealed ? 'sealed' : 'running', status: 'ok' });
    const action = await nextAction(f);
    assert.ok(action?.do === 'send' && action.reason === 'ruling' && action.rid === reviewer.rid, JSON.stringify(action));
    assert.equal(action.sendKind, sealed ? 'follow-up' : 'steer');
    const ack = Number(action.message.match(/--ack-rulings (\d+)/)?.[1]);
    // Follow the real message's instruction, not a seq supplied independently by the test.
    await sendAction(f, action);
    if (!sealed) assert.equal(await nextAction(f), undefined, 'do not repeatedly request ack while the reviewer is running');
    await ops.review({ cwd: f.cwd, as: who, node: 'a', verdict: 'ok', rank: 1, note: 'followed ruling hint', ack_rulings: ack });
    f.dsa.views.set(reviewer.rid, { rid: reviewer.rid, state: 'sealed', status: 'ok' });
    assert.equal((await ops.readState(f)).state.nodes.a!.items.find(i => i.obligation === 'rulings')!.status, 'E', `hint must cover answer #${answer.entry.seq}, not only #${older?.seq ?? 0}`);
    assert.equal((await nextAction(f))?.do, 'merge', 'the driver must not stall after following the ack hint');
    assert.ok((!older || action.message.includes('Earlier guidance')) && action.message.includes(answer.entry.text), action.message);
    assert.equal(ack, answer.entry.seq);
  } finally { await f.cleanup(); }
});

const fakeScript = `#!/usr/bin/env node
import {readFileSync, writeFileSync} from 'node:fs';
const a=process.argv.slice(2), get=k=>a[a.indexOf(k)+1], file=process.env.ANSWER_STATE, s=JSON.parse(readFileSync(file));
if(a[0]==='describe') { const r=s.runs[get('--key')]; console.log(JSON.stringify(r??{state:'absent'})); }
else if(a[0]==='send') { const id=get('--request'); if(!s.requests[id]) { s.requests[id]={to:get('--to'),qid:get('--qid'),rev:Number(get('--rev')),kind:get('--kind'),message:readFileSync(get('--message').slice(1),'utf8')}; s.runs[get('--to')]={state:'running'}; writeFileSync(file,JSON.stringify(s)); } console.log(JSON.stringify({spec_digest:'digest'})); }
else process.exit(1);
`;
async function external(f: Awaited<ReturnType<typeof fixture>>) {
  const bin = join(f.root, 'dsa.mjs'), file = join(f.root, 'state.json');
  await writeFile(bin, fakeScript); await chmod(bin, 0o755);
  await writeFile(file, JSON.stringify({ runs: { [f.writer.rid]: { state: 'asking', questions: [{ qid: 'q1', rev: 2, text: 'Which API?' }] } }, requests: {} }));
  return { bin, file, read: async () => JSON.parse(await readFile(file, 'utf8')) };
}

test('AN1/AN2 CLI: argument routing, actual dsa argv and retry after sealed question', async () => {
  const f = await fixture(), fake = await external(f), oldBin = process.env.OWED_DSA, oldState = process.env.ANSWER_STATE;
  process.env.OWED_DSA = fake.bin; process.env.ANSWER_STATE = fake.file;
  try {
    assert.equal((await cli(f.cwd, ['answer', 'a', '--rid', f.writer.rid, '--qid', 'q1', '--json', '--', '--Use API v2'])).code, 0);
    const first = (await f.rules())[0]!;
    const retry = await cli(f.cwd, ['answer', 'a', '--rid', f.writer.rid, '--qid', 'q1', '--', '--Use API v2']);
    assert.equal(retry.code, 0, retry.stderr); assert.match(retry.stdout, /Answer rule #\d+.*delivered/);
    assert.equal((await f.rules()).length, 1);
    assert.deepEqual((await fake.read()).requests, { [`owed-answer-${first.seq}`]: { to: f.writer.rid, qid: 'q1', rev: 2, kind: 'answer', message: '--Use API v2' } });
    assert.equal((await cli(f.cwd, ['answer', 'a', 'text', '--as', 'writer:a#1'])).code, 1);
    assert.equal((await cli(f.cwd, ['answer', 'a'])).code, 2);
    assert.equal((await cli(f.cwd, ['rule', 'text', '--nodes', 'a', '--qid', 'q1'])).code, 2);
  } finally { if (oldBin === undefined) delete process.env.OWED_DSA; else process.env.OWED_DSA = oldBin; if (oldState === undefined) delete process.env.ANSWER_STATE; else process.env.ANSWER_STATE = oldState; await f.cleanup(); }
});

test('AN1 tool: owed_answer runs through the registered native worker and refuses writer authority', async () => {
  const f = await fixture(), fake = await external(f), oldBin = process.env.OWED_DSA, oldState = process.env.ANSWER_STATE;
  process.env.OWED_DSA = fake.bin; process.env.ANSWER_STATE = fake.file;
  try {
    const tools = new Map<string, ToolDefinition>();
    owed({ registerTool: (t: ToolDefinition) => tools.set(t.name, t), registerCommand() {}, on() {}, sendMessage() {} } as unknown as ExtensionAPI);
    const tool = tools.get('owed_answer'); assert.ok(tool, 'owed_answer registered');
    const ctx = { cwd: f.cwd, hasUI: false } as Parameters<ToolDefinition['execute']>[4];
    const r = await tool.execute('test', { cwd: f.cwd, node: 'a', text: 'Use API v2' }, undefined, undefined, ctx);
    assert.notEqual((r as { isError?: boolean }).isError, true, JSON.stringify(r));
    assert.equal((await f.rules()).length, 1);
    const refused = await tool.execute('test', { cwd: f.cwd, node: 'a', text: 'Use API v2', as: 'writer:a#1' }, undefined, undefined, ctx);
    assert.equal((refused as { isError?: boolean }).isError, true);
    assert.equal((await f.rules()).length, 1);
  } finally { if (oldBin === undefined) delete process.env.OWED_DSA; else process.env.OWED_DSA = oldBin; if (oldState === undefined) delete process.env.ANSWER_STATE; else process.env.ANSWER_STATE = oldState; await f.cleanup(); }
});

test('AN1 asking notices show the one-act CLI and tool selectors', async () => {
  const f = await fixture();
  try {
    const line = askingText('a', f.writer, await f.dsa.describe(f.writer.rid));
    assert.ok(line.includes(`owed answer a --rid ${f.writer.rid} --qid q1 "<text>"`));
    assert.ok(line.includes('owed_answer {node:"a"'));
    // Exercise the production client with the same fake used by CLI/tool.
    const fake = await external(f), dsa = new Dsa({ bin: fake.bin, env: { ANSWER_STATE: fake.file } });
    assert.equal((await dsa.describe(f.writer.rid)).state, 'asking');
  } finally { await f.cleanup(); }
});
