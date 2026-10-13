// AR1–AR4 and parent ruling #1600: revision identity, retry selection and the version boundary.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import * as ops from '../src/ops.ts';
import { answerRetry } from '../src/answer.ts';
import { answeredQuestion, decide, writerLaunch } from '../src/drive.ts';
import { newerEntry, projectId, validateDraft } from '../src/reducer.ts';
import type { Draft, RuleEntry, RunView } from '../src/types.ts';
import owed from '../src/extension.ts';
import { repo } from './helpers/repo.ts';
import { cli } from './helpers/surface.ts';

const parent = { role: 'parent' as const, id: 'test' };
class FakeDsa {
  views = new Map<string, RunView>();
  sends: { id: string; to: string; kind: string; message: string; qid?: string; rev?: number }[] = [];
  async describe(rid: string): Promise<RunView> { return this.views.get(rid) ?? { rid, state: 'sealed', status: 'ok' }; }
  async send(id: string, to: string, kind: string, message: string | Uint8Array, extra: { qid?: string; rev?: number } = {}) {
    this.sends.push({ id, to, kind, message: String(message), ...extra });
    this.views.set(to, { rid: to, state: 'running' });
    return { outcome: 'applied' as const, spec_digest: 'digest' };
  }
  ask(rid: string, rev: number, qid = 'q1') {
    this.views.set(rid, { rid, state: 'asking', questions: [{ qid, rev, question: `Which API (revision ${rev})?` }] });
  }
}
async function fixture() {
  const r = await repo(), plan = JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [], nodes: [{ id: 'a', writes: ['a.txt'], checks: [], review: { count: 1, min_rank: 1 } }] });
  await r.put('plan.json', plan); await r.commit();
  await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'pi' }, channel: 'delegated', plan });
  await ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' });
  const { state } = await ops.readState(r), project = projectId(state), built = writerLaunch(state, 'a', project);
  const writer = (await ops.launch({ cwd: r.cwd, as: parent, node: 'a', attempt: 1, role: 'writer', rid: built.rid, spec: built.spec, labels: built.labels, rulings: built.rulings })).entry;
  const dsa = new FakeDsa(); dsa.ask(writer.rid, 1);
  const opts = { cwd: r.cwd, as: parent, node: 'a', rid: writer.rid, qid: 'q1', text: 'Use API v1', dsa };
  const rules = async () => (await ops.readState(r)).entries.filter((e): e is RuleEntry => e.kind === 'rule');
  return { ...r, writer, project, dsa, opts, rules };
}

for (const sameText of [false, true]) test(`AR1: q@2 records a new rule/request with ${sameText ? 'the same' : 'different'} text; exact retries reuse it`, async () => {
  const f = await fixture();
  try {
    const first = await ops.answer(f.opts);
    assert.equal(first.entry.answer!.rev, 1); assert.equal(first.entry.supersedes, undefined);
    f.dsa.ask(f.writer.rid, 2);
    const opts = { ...f.opts, text: sameText ? f.opts.text : 'Use API v2' };
    const second = await ops.answer(opts);
    assert.ok(second.entry.seq > first.entry.seq);
    assert.equal(second.entry.supersedes, first.entry.seq);
    assert.deepEqual(second.entry.answer, { rid: f.writer.rid, qid: 'q1', rev: 2 });
    assert.notEqual(second.request, first.request);
    assert.deepEqual(f.dsa.sends[1], { id: second.request, to: f.writer.rid, kind: 'answer', message: opts.text, qid: 'q1', rev: 2 });
    // Retry both while q@2 is still asking and after it disappears.
    f.dsa.ask(f.writer.rid, 2);
    assert.equal((await ops.answer(opts)).entry.seq, second.entry.seq);
    assert.equal((await ops.answer(opts)).entry.seq, second.entry.seq);
    assert.deepEqual(f.dsa.sends.slice(1), Array(3).fill(f.dsa.sends[1]));
    assert.equal((await f.rules()).length, 2);
    await assert.rejects(ops.answer({ ...opts, text: 'Changed at the same rev' }), /different text.*rev 2/);
    f.dsa.ask(f.writer.rid, 2);
    await assert.rejects(ops.answer({ ...opts, text: 'Changed while still asking' }), /different text.*rev 2/);
    assert.equal(f.dsa.sends.length, 4);
    assert.equal((await ops.verify(f)).ok, true, 'a re-ask ledger replays with valid supersedes');
  } finally { await f.cleanup(); }
});

test('AR2: a found current rid uses dsa rev, even when --rev names an older answer', async () => {
  const f = await fixture();
  try {
    const first = await ops.answer(f.opts);
    f.dsa.ask(f.writer.rid, 2);
    const second = await ops.answer({ ...f.opts, rid: undefined, rev: 1, text: 'Use API v2' });
    assert.equal(second.entry.answer!.rev, 2); assert.equal(second.entry.supersedes, first.entry.seq);
    f.dsa.ask(f.writer.rid, 3);
    const third = await ops.answer({ ...f.opts, qid: undefined, rev: 1, text: 'Use API v3' });
    assert.equal(third.entry.answer!.rev, 3); assert.equal(third.entry.supersedes, second.entry.seq);
    assert.deepEqual(f.dsa.sends.map(s => s.rev), [1, 2, 3]);
  } finally { await f.cleanup(); }
});

test('AR2/AR3: no open question retries an explicit rev or the latest prior rule; absent history refuses', async () => {
  const f = await fixture();
  try {
    const first = await ops.answer(f.opts); f.dsa.ask(f.writer.rid, 2);
    const second = await ops.answer({ ...f.opts, text: 'Use API v2' });
    assert.equal((await ops.answer({ ...f.opts, rev: 1 })).entry.seq, first.entry.seq);
    assert.equal((await ops.answer({ ...f.opts, rev: 2, text: 'Use API v2' })).entry.seq, second.entry.seq);
    assert.equal((await ops.answer({ ...f.opts, rid: undefined, text: 'Use API v2' })).entry.seq, second.entry.seq);
    const sent = f.dsa.sends.length;
    await assert.rejects(ops.answer({ ...f.opts, rev: 3 }), /No matching open question/);
    await assert.rejects(ops.answer({ ...f.opts, qid: 'missing', rev: 1 }), /No matching open question/);
    assert.equal(f.dsa.sends.length, sent); assert.equal((await f.rules()).length, 2);
    const retry = answerRetry('a', first.entry); assert.match(retry, /--rev 1 -- /);
    await ops.abandon({ cwd: f.cwd, as: parent, node: 'a', reason: 'test closed-slot retry' });
    assert.equal((await ops.answer({ ...f.opts, rev: 1 })).entry.seq, first.entry.seq, 'explicit durable retry survives a closed slot');
  } finally { await f.cleanup(); }
});

test('AR1: concurrent re-ask answers append once under the ledger lock', async () => {
  const f = await fixture();
  try {
    const first = await ops.answer(f.opts); f.dsa.ask(f.writer.rid, 2);
    const [a, b] = await Promise.all([ops.answer(f.opts), ops.answer(f.opts)]);
    assert.equal(a.entry.seq, b.entry.seq); assert.equal(a.entry.supersedes, first.entry.seq);
    assert.equal((await f.rules()).length, 2); assert.equal(f.dsa.sends[1]!.id, f.dsa.sends[2]!.id);
  } finally { await f.cleanup(); }
});

test('AR4: q@2 after an answered q@1 is routed as an open driver question, not answered #', async () => {
  const f = await fixture();
  try {
    const first = await ops.answer(f.opts), { state } = await ops.readState(f);
    assert.equal(answeredQuestion(state, f.writer.rid, 'q1', 1)!.seq, first.entry.seq);
    assert.equal(answeredQuestion(state, f.writer.rid, 'q1', 2), undefined);
    f.dsa.ask(f.writer.rid, 2);
    const action = decide(state, state.plan, f.dsa.views, { max: 1, repairs: 2, project: f.project, root: f.cwd, applied: new Set(), rejected: new Map() }).find(a => a.node === 'a');
    assert.ok(action?.do === 'notify' && action.qid === 'q1' && action.rev === 2, JSON.stringify(action));
    assert.equal(action.quiet, undefined); assert.equal(action.answerRetry, undefined);
    assert.match(action.text, /asks \(qid q1, rev 2\)/); assert.doesNotMatch(action.text, /answered #/);
  } finally { await f.cleanup(); }
});

test('AR #1600: supersedes is required exactly for re-asks, targets the latest lower-rev answer, and other unknown fields still require upgrade', async () => {
  const f = await fixture();
  try {
    const before = (await ops.readState(f)).state;
    const draft: Draft = { kind: 'rule', by: 'parent:test', nodes: ['a'], writer: false, text: 'Answer to writer question q1: yes', answer: { rid: f.writer.rid, qid: 'q1', rev: 1 } };
    assert.deepEqual(validateDraft(before, draft), []);
    assert.ok(validateDraft(before, { ...draft, supersedes: 0 }).some(e => e.includes('supersedes')));
    assert.ok(validateDraft(before, { kind: 'rule', by: 'parent:test', nodes: ['a'], text: 'ordinary', supersedes: 0 }).some(e => e.includes('supersedes')));
    const first = await ops.answer(f.opts), after = (await ops.readState(f)).state;
    const reask = { ...draft, answer: { ...draft.answer!, rev: 2 }, supersedes: first.entry.seq };
    assert.deepEqual(validateDraft(after, reask), []);
    for (const supersedes of [undefined, 0, first.entry.seq + 1, 1.5, NaN]) {
      assert.ok(validateDraft(after, { ...reask, supersedes }).some(e => e.includes('supersedes')), String(supersedes));
    }
    assert.ok(validateDraft(after, { ...draft, supersedes: first.entry.seq }).some(e => /already recorded.*rev|rev.*already recorded/.test(e)));
    const other = await ops.answerRule({ cwd: f.cwd, as: parent, node: 'a', text: 'Answer to writer question q2: yes', answer: { rid: f.writer.rid, qid: 'q2', rev: 1 } });
    assert.ok(validateDraft((await ops.readState(f)).state, { ...reask, supersedes: other.seq }).some(e => e.includes('supersedes')));
    f.dsa.ask(f.writer.rid, 2); const second = await ops.answer(f.opts);
    const current = (await ops.readState(f)).state, third = { ...reask, answer: { ...reask.answer, rev: 3 } };
    assert.ok(validateDraft(current, third).some(e => e.includes('supersedes')), 'an older same-qid rule is not the latest');
    assert.deepEqual(validateDraft(current, { ...third, supersedes: second.entry.seq }), []);
    assert.ok(validateDraft(current, { ...reask, answer: { ...reask.answer, rev: 0 } }).some(e => e.includes('lower rev')));
    const future = { ...second.entry, future_answer_flag: true };
    assert.equal(newerEntry(future)!.code, 'version');
    assert.equal(newerEntry(second.entry), undefined);
    assert.equal((await ops.verify(f)).ok, true);
  } finally { await f.cleanup(); }
});

test('AR3: invalid API rev refuses with usage and records/sends nothing', async () => {
  const f = await fixture();
  try {
    for (const rev of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '2' as unknown as number]) {
      await assert.rejects(ops.answer({ ...f.opts, rev }), (e: unknown) => (e as { code?: string }).code === 'usage');
    }
    assert.equal((await f.rules()).length, 0); assert.equal(f.dsa.sends.length, 0);
  } finally { await f.cleanup(); }
});

// Production Dsa argv and native-worker tool routing; stable request ids intentionally deduplicate sends.
const fakeScript = `#!/usr/bin/env node
import {readFileSync, writeFileSync} from 'node:fs';
const a=process.argv.slice(2), get=k=>a[a.indexOf(k)+1], file=process.env.ANSWERREV_STATE, s=JSON.parse(readFileSync(file));
if(a[0]==='describe') console.log(JSON.stringify(s.runs[get('--key')]??{state:'absent'}));
else if(a[0]==='send') {
  const id=get('--request');
  if(!s.requests[id]) { s.requests[id]={to:get('--to'),qid:get('--qid'),rev:Number(get('--rev')),kind:get('--kind'),message:readFileSync(get('--message').slice(1),'utf8')}; s.runs[get('--to')]={state:'running'}; writeFileSync(file,JSON.stringify(s)); }
  console.log(JSON.stringify({spec_digest:'digest'}));
} else process.exit(1);
`;
async function external(f: Awaited<ReturnType<typeof fixture>>) {
  const bin = join(f.root, 'dsa.mjs'), file = join(f.root, 'dsa.json');
  await writeFile(bin, fakeScript); await chmod(bin, 0o755);
  const read = async () => JSON.parse(await readFile(file, 'utf8'));
  const ask = async (rev: number) => {
    let s = { runs: {}, requests: {} };
    try { s = await read(); } catch { /* first question */ }
    Object.assign(s.runs, { [f.writer.rid]: { state: 'asking', questions: [{ qid: 'q1', rev, text: 'Which API?' }] } });
    await writeFile(file, JSON.stringify(s));
  };
  await ask(1);
  const oldBin = process.env.OWED_DSA, oldState = process.env.ANSWERREV_STATE;
  process.env.OWED_DSA = bin; process.env.ANSWERREV_STATE = file;
  return { ask, read, restore() {
    if (oldBin === undefined) delete process.env.OWED_DSA; else process.env.OWED_DSA = oldBin;
    if (oldState === undefined) delete process.env.ANSWERREV_STATE; else process.env.ANSWERREV_STATE = oldState;
  } };
}

test('AR CLI: --rev retries the named rule; an open re-ask sends current rev with a new request; invalid rev exits 2', async () => {
  const f = await fixture(), fake = await external(f);
  try {
    const args = ['answer', 'a', '--rid', f.writer.rid, '--qid', 'q1'];
    const first = await cli(f.cwd, [...args, '--rev', '1', '--json', 'Use API v1']);
    assert.equal(first.code, 0, first.stderr); const one = JSON.parse(first.stdout);
    await fake.ask(2);
    const second = await cli(f.cwd, [...args, '--rev', '1', 'Use API v2']);
    assert.equal(second.code, 0, second.stderr); assert.match(second.stdout, /qid q1, rev 2, request owed-answer-/);
    const [r1, r2] = await f.rules(); assert.equal(r1!.seq, one.entry.seq); assert.equal(r2!.supersedes, r1!.seq);
    assert.equal((await cli(f.cwd, [...args, '--rev', '1', 'Use API v1'])).code, 0);
    assert.equal((await cli(f.cwd, [...args, '--rev', '2', 'Use API v2'])).code, 0);
    assert.equal((await cli(f.cwd, [...args, '--rev', '3', 'missing'])).code, 1);
    for (const rev of ['0', '-1', '1.5', 'text', '9007199254740992']) {
      const r = await cli(f.cwd, [...args, '--rev', rev, 'bad']);
      assert.equal(r.code, 2, r.stderr); assert.match(r.stderr, /positive integer/);
    }
    assert.deepEqual((await fake.read()).requests, {
      [`owed-answer-${r1!.seq}`]: { to: f.writer.rid, qid: 'q1', rev: 1, kind: 'answer', message: 'Use API v1' },
      [`owed-answer-${r2!.seq}`]: { to: f.writer.rid, qid: 'q1', rev: 2, kind: 'answer', message: 'Use API v2' },
    });
    assert.equal((await f.rules()).length, 2);
  } finally { fake.restore(); await f.cleanup(); }
});

test('AR pi tool: rev is exposed and forwarded through the native worker for retries; invalid rev is usage', async () => {
  const f = await fixture(), fake = await external(f);
  try {
    const tools = new Map<string, ToolDefinition>();
    owed({ registerTool: (t: ToolDefinition) => tools.set(t.name, t), registerCommand() {}, on() {}, sendMessage() {} } as unknown as ExtensionAPI);
    const tool = tools.get('owed_answer')!;
    const schema = tool.parameters as unknown as { properties: { rev: { type: string; minimum: number } } };
    assert.equal(schema.properties.rev.type, 'integer'); assert.equal(schema.properties.rev.minimum, 1);
    const ctx = { cwd: f.cwd, hasUI: false } as Parameters<ToolDefinition['execute']>[4];
    const call = (rev: number, text: string) => tool.execute('test', { cwd: f.cwd, node: 'a', rid: f.writer.rid, qid: 'q1', rev, text }, undefined, undefined, ctx);
    const one = await call(1, 'Use API v1'); assert.notEqual((one as { isError?: boolean }).isError, true, JSON.stringify(one));
    await fake.ask(2);
    const two = await call(1, 'Use API v2'); assert.notEqual((two as { isError?: boolean }).isError, true, JSON.stringify(two));
    const [r1, r2] = await f.rules(); assert.equal(r2!.answer!.rev, 2);
    const retry = await call(1, 'Use API v1');
    assert.notEqual((retry as { isError?: boolean }).isError, true, JSON.stringify(retry));
    assert.equal((retry.details as { entry: RuleEntry }).entry.seq, r1!.seq);
    const bad = await call(0, 'bad');
    assert.equal((bad as { isError?: boolean }).isError, true); assert.equal((bad.details as { code: string }).code, 'usage');
    assert.equal((await f.rules()).length, 2); assert.equal(Object.keys((await fake.read()).requests).length, 2);
  } finally { fake.restore(); await f.cleanup(); }
});
