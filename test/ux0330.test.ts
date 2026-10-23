// UX1-UX4 (0.33.0): full questions, retried tool refusals, recorded plan hash.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { sha256 } from '../src/canon.ts';
import { projectId, runId, runLabels } from '../src/reducer.ts';
import { questionPointer, questionText, recordedPlanLine, structuredQuestionText, renderWhy } from '../src/views.ts';
import { withQuestionPointers } from '../src/needs.ts';
import { validateArgv } from '../src/cli.ts';
import { OwedError } from '../src/errors.ts';
import owed, { optimisticRefusal, retryOnce } from '../src/extension.ts';
import type { RunQuestion, RunView } from '../src/types.ts';
import { repo } from './helpers/repo.ts';

const parent = { role: 'parent', id: 'test' } as const;
const owner = { role: 'owner', id: 'pi' } as const;
const plan = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: [{ id: 'a', writes: ['a.txt'], checks: [], review: { count: 1, min_rank: 1 } }, { id: 'b', writes: ['b.txt'], checks: [], review: { count: 1, min_rank: 1 } }] };
const LONG = 'L'.repeat(400);
/** A question with every field the contract lists, long enough that any clipping shows. */
const asked: RunQuestion = {
  qid: 'q-1234567890', rev: 3, to: 'a/writer',
  decision_needed: 'Which interface should the writer keep?',
  options: [{ label: `Keep ${LONG}`, scope: `scope ${LONG}`, cost: `cost ${LONG}`, risk: `risk ${LONG}`, preferred: true }, { label: 'Change it' }],
  facts: [`fact ${LONG}`], tried: [`tried ${LONG}`],
  classification_candidates: [{ label: `candidate ${LONG}`, evidence: [`evidence ${LONG}`], unproven: [`unproven ${LONG}`] }],
  question: `question ${LONG}`,
};
class FakeDsa {
  views = new Map<string, RunView>();
  sends: string[] = [];
  async describe(rid: string): Promise<RunView> { return this.views.get(rid) ?? { rid, state: 'sealed', status: 'ok' }; }
  async send(_id: string, rid: string) { this.sends.push(rid); return { outcome: 'applied' as const, spec_digest: 'test' }; }
}
async function fixture() {
  const r = await repo(), dsa = new FakeDsa();
  await r.put('plan.json', JSON.stringify(plan)); await r.put('a.txt', 'x\n'); await r.commit();
  await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify(plan), path: 'plan.json', measure: false });
  async function slot(node = 'a') { return ops.dispatch({ cwd: r.cwd, as: parent, node }); }
  async function launch(node = 'a') {
    const s = (await ops.readState({ cwd: r.cwd })).state, p = projectId(s), rid = runId(p, node, 1, 'writer');
    await ops.launch({ cwd: r.cwd, as: parent, node, attempt: 1, role: 'writer', rid, spec: '{}', labels: runLabels(p, node, 1, 'writer'), rulings: 0 });
    return rid;
  }
  return { ...r, dsa, slot, launch };
}
type Result = Awaited<ReturnType<ToolDefinition['execute']>> & { isError?: boolean };
const text = (r: Result): string => r.content.map(c => c.type === 'text' ? c.text : '').join('\n');
/** The pi harness: the tools of the extension, a context and a call helper. */
function harness(cwd: string, confirm: (message: string) => Promise<boolean> = async () => true) {
  const tools = new Map<string, ToolDefinition>();
  owed({ registerTool(t: ToolDefinition) { tools.set(t.name, t); }, registerCommand() {} } as unknown as ExtensionAPI);
  const ctx = { cwd, hasUI: true, ui: { async confirm(_title: string, message: string) { return confirm(message); }, notify() {} } } as unknown as ExtensionContext;
  return { tools, ctx, async call(name: string, args: Record<string, unknown> = {}): Promise<Result> {
    const t = tools.get(`owed_${name}`);
    assert.ok(t, `tool owed_${name} is registered`);
    return t.execute('test', args, undefined, undefined, ctx as Parameters<ToolDefinition['execute']>[4]) as Promise<Result>;
  } };
}

// ---------- UX1: the full question ----------
test('UX1: owed question prints the open writer question unclipped', async () => {
  const f = await fixture();
  try {
    await f.slot(); const rid = await f.launch();
    f.dsa.views.set(rid, { rid, state: 'asking', questions: [asked], to: 'a/writer' });
    const found = await ops.question({ cwd: f.cwd, node: 'a', dsa: f.dsa });
    assert.equal(found.length, 1);
    const q = found[0]!;
    assert.equal(q.node, 'a'); assert.equal(q.qid, asked.qid); assert.equal(q.rev, asked.rev); assert.equal(q.rid, rid);
    assert.equal(q.decision_needed, asked.decision_needed);
    assert.deepEqual(q.options, asked.options);
    assert.deepEqual(q.facts, asked.facts); assert.deepEqual(q.tried, asked.tried);
    assert.deepEqual(q.classification_candidates, asked.classification_candidates);
    assert.equal(q.question, asked.question);
    assert.equal(q.call, 'a/writer');
    assert.match(q.answer, /^owed answer 'a' --rid '.+' --qid 'q-1234567890' --rev 3/);
    const shown = questionText(q);
    assert.ok(shown.includes(LONG), 'the long fields are printed whole');
    assert.match(shown, /DECISION: Which interface should the writer keep\?/);
    assert.match(shown, /1\) Keep /);
    assert.match(shown, /preferred/);
    assert.match(shown, /scope /); assert.match(shown, /cost /); assert.match(shown, /risk /);
    assert.match(shown, /facts:/); assert.match(shown, /tried:/); assert.match(shown, /candidates:/);
    assert.match(shown, /qid q-1234567890/); assert.match(shown, /rev 3/);
    assert.match(shown, /call a\/writer/);
    assert.match(shown, /answer: owed answer 'a' --rid '.+' --qid 'q-1234567890'/);
  } finally { await f.cleanup(); }
});

test('UX1: the qid selects one question; an unknown node or a node without an open slot refuses', async () => {
  const f = await fixture();
  try {
    await assert.rejects(ops.question({ cwd: f.cwd, node: 'missing', dsa: f.dsa }), /does not exist/);
    await assert.rejects(ops.question({ cwd: f.cwd, node: 'a', dsa: f.dsa }), /no open slot/);
    await f.slot(); const rid = await f.launch();
    f.dsa.views.set(rid, { rid, state: 'asking', questions: [asked, { ...asked, qid: 'q-other' }] });
    assert.equal((await ops.question({ cwd: f.cwd, node: 'a', qid: 'q-other', dsa: f.dsa })).length, 1);
    assert.equal((await ops.question({ cwd: f.cwd, node: 'a', qid: 'q-other', dsa: f.dsa }))[0]!.qid, 'q-other');
    assert.equal((await ops.question({ cwd: f.cwd, node: 'a', dsa: f.dsa })).length, 2);
    assert.equal((await ops.question({ cwd: f.cwd, node: 'a', qid: 'q-none', dsa: f.dsa })).length, 0);
  } finally { await f.cleanup(); }
});

test('UX1: owed question takes a node and an optional qid', () => {
  assert.doesNotThrow(() => validateArgv(['question', 'a']));
  assert.doesNotThrow(() => validateArgv(['question', 'a', 'q1']));
  assert.doesNotThrow(() => validateArgv(['question', 'a', '--json']));
  assert.throws(() => validateArgv(['question']), /wrong number of arguments/);
  assert.throws(() => validateArgv(['question', 'a', 'q1', 'extra']), /wrong number of arguments/);
});

test('UX1: a clipped question or option points at owed question', () => {
  // The driver's ask line keeps its clipped shape (SA2); the wake that shows it names the full question.
  const clipped = structuredQuestionText(asked, 'pi-durable-subagents describe --key rid --json');
  assert.match(clipped, /\(full: pi-durable-subagents describe --key rid --json\)$/);
  assert.ok(clipped.includes(LONG.slice(0, 100)), 'the option label is still shown');
  const whole = structuredQuestionText({ qid: 'q1', rev: 1, question: 'Short.', decision_needed: 'Pick one', options: [{ label: 'A' }] });
  assert.ok(!whole.includes('owed question'), whole);
  assert.equal(whole.split('\n').at(-1), 'details: Short.');
  const wake = withQuestionPointers('Needs you: a — writer run rid asks (qid q1-1, rev 1): DECISION: pick one\noptions: 1) A\ndetails: … (full: describe)');
  assert.match(wake, /→ owed question a q1-1/);
});

test('UX1: a wake that shows a question points at the full question', () => {
  const wake = withQuestionPointers('Needs you: a — decide which db? → owed answer a "<text>"');
  assert.match(wake, /→ owed question a$/);
  const named = withQuestionPointers('Needs you: a — writer run rid asks (qid q1-1, rev 1): which db?');
  assert.match(named, /→ owed question a q1-1/);
  const already = withQuestionPointers(`Needs you: a — decide which db? → owed answer a "<text>" ${questionPointer('a', 'q1')}`);
  assert.equal(already.match(/owed question/g)!.length, 1);
  const other = withQuestionPointers('Needs you: a — review the reported findings → owed decide a --text "<decision>"');
  assert.ok(!other.includes('owed question'), other);
});

test('UX1: owed why names the full question of an open question need', async t => {
  const f = await fixture();
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-01-15T12:00:00Z') });
  try {
    await f.slot(); const rid = await f.launch();
    const rule = await ops.answerRule({ cwd: f.cwd, as: parent, node: 'a', text: 'Answer to writer question q: keep it', answer: { rid, qid: 'q', rev: 2 } });
    const ledger = await Ledger.open(f.cwd);
    await mkdir(join(ledger.dir, 'drive'), { recursive: true });
    await writeFile(join(ledger.dir, 'drive', 'asking.json'), JSON.stringify([{ node: 'a', rid, qid: 'q', rev: 2 }]));
    await writeFile(join(ledger.dir, 'drive.lock'), JSON.stringify({ pid: process.pid, host: 'foreign.invalid', at: new Date().toISOString(), token: 'ux-fixture' }));
    t.mock.timers.setTime(Date.parse(rule.ts) + 900_000);
    const card = await ops.why({ cwd: f.cwd, node: 'a' });
    const shown = renderWhy(card);
    assert.match(shown, /→ owed question a q\b/);
  } finally { t.mock.timers.reset(); await f.cleanup(); }
});

// ---------- UX2: one retry after an optimistic refusal ----------
test('UX2: an optimistic refusal is retried once; a second refusal is returned as today', async () => {
  let calls = 0;
  const ok = await retryOnce(async () => { calls++; if (calls === 1) throw new OwedError('Plan, candidate or trunk changed; retry'); return 'done'; });
  assert.equal(ok.value, 'done'); assert.equal(ok.retried, 'Plan, candidate or trunk changed; retry'); assert.equal(calls, 2);
  await assert.rejects(retryOnce(async () => { throw new OwedError('Plan, candidate or trunk changed; retry'); }), /changed; retry/);
  let busy = 0;
  const waited = await retryOnce(async () => { busy++; if (busy === 1) throw new OwedError('the ledger lock is held', 'busy'); return 'done'; });
  assert.equal(waited.value, 'done'); assert.equal(waited.retried, 'the ledger lock is held');
  let other = 0;
  await assert.rejects(retryOnce(async () => { other++; throw new OwedError('the node is merged'); }), /the node is merged/);
  assert.equal(other, 1, 'another refusal is not retried');
});

test('UX2: only optimistic refusals are retried', () => {
  assert.equal(optimisticRefusal(new OwedError('Plan, candidate or trunk changed; retry')), 'Plan, candidate or trunk changed; retry');
  assert.equal(optimisticRefusal(new OwedError('decision state changed; retry; nothing recorded')), 'decision state changed; retry; nothing recorded');
  assert.equal(optimisticRefusal(new OwedError('ledger changed during accept S3; retry; nothing recorded')), 'ledger changed during accept S3; retry; nothing recorded');
  assert.equal(optimisticRefusal(new OwedError('the ledger lock is held', 'busy')), 'the ledger lock is held');
  assert.equal(optimisticRefusal(new OwedError('the node is merged')), undefined);
  assert.equal(optimisticRefusal(new Error('boom')), undefined);
});

test('UX2: a recording tool retries once and reports the first refusal', async () => {
  const f = await fixture();
  const prior = process.env.OWED_CONFIRM;
  process.env.OWED_CONFIRM = 'owner';
  try {
    await f.slot();
    // The plan file holds a downgrade (the owner must confirm it). The owner's confirmation rewrites the file:
    // the recorded plan would then be an older version (R1580), and the tool retries after re-reading.
    const weaker = { ...plan, nodes: [plan.nodes[0]!, { ...plan.nodes[1]!, review: { count: 0, min_rank: 1 } }] };
    const newer = { ...weaker, nodes: [{ ...weaker.nodes[0]!, title: 'Retitled' }, weaker.nodes[1]!] };
    await f.put('plan.json', JSON.stringify(weaker));
    let rewrites = 0;
    const h = harness(f.cwd, async () => {
      if (rewrites++ === 0) await f.put('plan.json', JSON.stringify(newer));
      return true;
    });
    const planned = await h.call('plan', { plan: 'plan.json', note: 'lower the review count of b' });
    assert.notEqual(planned.isError, true, text(planned));
    assert.match(text(planned), /^retried once after: plan file changed; retry/m);
    const entries = await (await Ledger.open(f.cwd)).read();
    const last = entries.filter(e => e.kind === 'plan').at(-1)!;
    assert.ok(last.kind === 'plan');
    const state = (await ops.readState({ cwd: f.cwd })).state;
    assert.equal(state.plan.nodes[1]!.review.count, 0, 'the current file is the recorded plan');
    assert.equal(state.plan.nodes[0]!.title, 'Retitled', 'the retry recorded the file as it is now');
  } finally { if (prior === undefined) delete process.env.OWED_CONFIRM; else process.env.OWED_CONFIRM = prior; await f.cleanup(); }
});

// ---------- UX3: the recorded plan hash ----------
test('UX3: the plan tool ends with the recorded plan blob and file hash', async () => {
  const f = await fixture();
  try {
    const h = harness(f.cwd);
    const planned = await h.call('plan', { plan: 'plan.json' });
    assert.notEqual(planned.isError, true, text(planned));
    const lines = text(planned).split('\n');
    const last = lines.at(-1)!;
    assert.match(last, /^recorded plan #\d+ blob [0-9a-f]{64} file sha256 [0-9a-f]{64}$/);
    const entry = (await (await Ledger.open(f.cwd)).read()).filter(e => e.kind === 'plan').at(-1)!;
    assert.ok(entry.kind === 'plan');
    assert.ok(last.includes(`blob ${entry.plan}`), last);
    assert.ok(last.includes(`file sha256 ${sha256(await readFile(join(f.cwd, 'plan.json'), 'utf8'))}`), last);
  } finally { await f.cleanup(); }
});

test('UX3: the amend and edit tools end with the recorded plan blob and file hash', async () => {
  const f = await fixture();
  try {
    const h = harness(f.cwd);
    const amended = await h.call('amend', { node: 'a', writes: ['+extra.txt'], note: 'widen the writes', plan: 'plan.json' });
    assert.notEqual(amended.isError, true, text(amended));
    const amendLine = text(amended).split('\n').at(-1)!;
    assert.match(amendLine, /^recorded plan #\d+ blob [0-9a-f]{64} file sha256 [0-9a-f]{64}$/);
    assert.ok(amendLine.includes(`file sha256 ${sha256(await readFile(join(f.cwd, 'plan.json'), 'utf8'))}`), amendLine);
    const edited = await h.call('edit', { node: 'a', set: ['title=Scoped'], note: 'scope the node' });
    assert.notEqual(edited.isError, true, text(edited));
    const editLine = text(edited).split('\n').at(-1)!;
    assert.match(editLine, /^recorded plan #\d+ blob [0-9a-f]{64} file sha256 [0-9a-f]{64}$/);
    assert.ok(editLine.includes(`file sha256 ${sha256(await readFile(join(f.cwd, 'plan.json'), 'utf8'))}`), editLine);
  } finally { await f.cleanup(); }
});

test('UX3: a plan file that changed while recording is refused, and the retry records the current file', async () => {
  const f = await fixture();
  try {
    const read = await ops.readPlan({ cwd: f.cwd, path: 'plan.json' });
    await f.put('plan.json', JSON.stringify({ ...plan, nodes: [{ ...plan.nodes[0]!, title: 'Newer' }, plan.nodes[1]!] }));
    await assert.rejects(ops.planSet({ cwd: f.cwd, as: parent, plan: read.plan, path: read.path, note: 'stale' }), /changed; retry/);
    const entries = await (await Ledger.open(f.cwd)).read();
    assert.equal(entries.filter(e => e.kind === 'plan').length, 0, 'nothing was recorded');
  } finally { await f.cleanup(); }
});

test('UX3: the recorded plan line names the blob and the file bytes', () => {
  assert.equal(recordedPlanLine({ seq: 12, plan: 'a'.repeat(64) }, 'b'.repeat(64)), `recorded plan #12 blob ${'a'.repeat(64)} file sha256 ${'b'.repeat(64)}`);
});
