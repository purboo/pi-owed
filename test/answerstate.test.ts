// AR1: post-answer facts are runtime receipts, never another send or ledger entry.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import * as ops from '../src/ops.ts';
import * as answers from '../src/answer.ts';
import { Dsa, toRunView, type SendResult } from '../src/dsa.ts';
import { Ledger } from '../src/ledger.ts';
import { projectId, runId, runLabels } from '../src/reducer.ts';
import owed from '../src/extension.ts';
import { repo } from './helpers/repo.ts';
import { cli } from './helpers/surface.ts';

const parent = { role: 'parent', id: 'test' } as const;
const qid = 'question-original', nextQid = 'question-next';
async function fixture(nodes = ['a']) {
  const r = await repo(), plan = JSON.stringify({ version: 1, trunk: 'main', lease: false, closure: [], invariants: [], nodes: nodes.map(id => ({ id, writes: [`${id}.txt`], checks: [], review: { count: 0 } })) });
  await r.put('plan.json', plan); await r.commit();
  await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'pi' }, channel: 'delegated', plan, measure: false });
  const runs = new Map<string, string>();
  for (const node of nodes) {
    await ops.dispatch({ cwd: r.cwd, as: parent, node });
    const project = projectId((await ops.readState(r)).state), rid = runId(project, node, 1, 'writer');
    await ops.launch({ cwd: r.cwd, as: parent, node, attempt: 1, role: 'writer', rid, spec: '{}', labels: runLabels(project, node, 1, 'writer'), rulings: 0 });
    runs.set(node, rid);
  }
  const sends: string[] = [], probes = new Map<string, number>();
  let saved = '', post: Record<string, unknown> = {}, failure: string | undefined;
  const ledger = await Ledger.open(r.cwd), file = join(ledger.dir, 'ledger.jsonl');
  const client = {
    async describe(rid: string) {
      if (!sends.includes(rid)) return toRunView(rid, { state: 'asking', wid: 'w', calls: [{ key: 'main', phase: 'running' }], questions: [{ qid, rev: 3, to: 'w/main', text: 'Which API?' }] });
      probes.set(rid, (probes.get(rid) ?? 0) + 1);
      await ledger.withLock(async () => {}); // Must not hold the ledger lock while describing.
      assert.equal(await readFile(file, 'utf8'), saved, 'probe records nothing');
      if (failure) throw new Error(failure);
      return toRunView(rid, post);
    },
    async send(_id: string, rid: string, kind: string): Promise<SendResult> {
      assert.equal(kind, 'answer'); sends.push(rid); saved = await readFile(file, 'utf8');
      return { outcome: 'applied', spec_digest: 'test' };
    },
  };
  return { ...r, runs, sends, probes, client, file, setPost(value: Record<string, unknown>, error?: string) { post = value; failure = error; }, saved: () => saved };
}
const cases: { name: string; reply: Record<string, unknown>; error?: string; expected: string }[] = [
  { name: 'running', reply: { state: 'running', calls: [{ key: 'main', phase: 'running' }] }, expected: 'running' },
  { name: 'queued despite workflow running', reply: { state: 'running', calls: [{ key: 'main', phase: 'queued' }] }, expected: 'queued' },
  { name: 'sealed target despite another call running', reply: { state: 'running', calls: [{ key: 'main', phase: 'sealed', status: 'error' }, { key: 'other', phase: 'running' }] }, expected: 'sealed (error)' },
  { name: 'asking again on answered call', reply: { state: 'asking', calls: [{ key: 'main', phase: 'running' }], questions: [{ qid: nextQid, rev: 1, to: 'w/main', text: 'Next?' }] }, expected: `asking again (qid ${nextQid.slice(0, 8)})` },
  { name: 'unrelated question is not asking again', reply: { state: 'asking', calls: [{ key: 'main', phase: 'queued' }, { key: 'other', phase: 'running' }], questions: [{ qid: nextQid, rev: 1, to: 'w/other', text: 'Elsewhere?' }] }, expected: 'queued' },
  { name: 'describe failure', reply: {}, error: 'describe unavailable', expected: 'unknown (describe unavailable)' },
  { name: 'R-030-AR-1 missing question qid', reply: { state: 'asking', calls: [{ key: 'main', phase: 'running' }], questions: [{ rev: 4, to: 'w/main', text: 'Malformed' }] }, expected: 'unknown (malformed describe reply)' },
  { name: 'R-030-AR-1 non-string question qid', reply: { state: 'asking', calls: [{ key: 'main', phase: 'running' }], questions: [{ qid: 123, rev: 4, to: 'w/main', text: 'Malformed' }] }, expected: 'unknown (malformed describe reply)' },
  { name: 'R-030-AR-1 blank question qid', reply: { state: 'asking', calls: [{ key: 'main', phase: 'running' }], questions: [{ qid: '  ', rev: 4, to: 'w/main', text: 'Malformed' }] }, expected: 'unknown (malformed describe reply)' },
  { name: 'R-030-AR-1 same question remains open', reply: { state: 'asking', calls: [{ key: 'main', phase: 'running' }], questions: [{ qid, rev: 3, to: 'w/main', text: 'Which API?' }] }, expected: `asking (answer not yet taken, qid ${qid.slice(0, 8)})` },
  { name: 'R-030-AR-1 missing phase with open question', reply: { state: 'asking', calls: [{ key: 'main' }], questions: [{ qid: nextQid, rev: 4, to: 'w/main', text: 'Next?' }] }, expected: 'unknown (malformed describe reply)' },
  { name: 'R-030-AR-1 non-string phase', reply: { state: 'running', calls: [{ key: 'main', phase: 3 }] }, expected: 'unknown (malformed describe reply)' },
  { name: 'old describe without phases', reply: { state: 'running' }, expected: 'unknown (malformed describe reply)' },
  { name: 'missing target never borrows another call', reply: { state: 'running', calls: [{ key: 'other', phase: 'running' }] }, expected: 'unknown (malformed describe reply)' },
];
for (const c of cases) test(`AR1 answer/decide: ${c.name}`, async () => {
  for (const kind of ['answer', 'decide'] as const) {
    const f = await fixture();
    try {
      f.setPost(c.reply, c.error);
      const rid = f.runs.get('a')!, r = kind === 'answer'
        ? await ops.answer({ cwd: f.cwd, as: parent, node: 'a', text: 'Use v2', dsa: f.client })
        : await ops.decide({ cwd: f.cwd, as: parent, nodes: ['a'], text: 'Use v2', dsa: f.client });
      const entry = 'entry' in r ? r.entry : r.rule;
      assert.deepEqual(r.answers, [{ node: 'a', rid, qid, rev: 3, request: answers.answerRequest(entry, { rid, qid, rev: 3 }), state: c.expected }]);
      const text = 'entry' in r ? answers.answerText('a', r) : ops.decideText(r);
      assert.ok(text.split('\n').includes(`answered a ${rid} qid ${qid.slice(0, 8)}: ${c.expected}`), text);
      assert.ok(!text.includes('resumes now'));
      assert.deepEqual(f.sends, [rid]); assert.equal(f.probes.get(rid), 1);
      assert.equal(await readFile(f.file, 'utf8'), f.saved());
      const entries = (await ops.readState(f)).entries;
      assert.equal(entries.filter(e => e.kind === 'rule').length, 1);
      assert.ok(!('state' in entries.at(-1)!)); assert.equal((await ops.verify(f)).ok, true);
    } finally { await f.cleanup(); }
  }
});

test('R-030-AR-1 retry without recorded call address never borrows the only remaining call', async () => {
  const f = await fixture();
  try {
    f.setPost({ state: 'running', calls: [{ key: 'main', phase: 'running' }] });
    const rid = f.runs.get('a')!, opts = { cwd: f.cwd, as: parent, node: 'a', text: 'Use v2', rid, qid, dsa: f.client };
    const first = await ops.answer(opts), saved = await readFile(f.file, 'utf8');
    f.setPost({ state: 'running', calls: [{ key: 'other', phase: 'queued' }] });
    const retry = await ops.answer(opts);
    assert.equal(retry.answers[0]!.state, 'unknown (call not identified)');
    assert.equal(retry.request, first.request); assert.equal(retry.entry.seq, first.entry.seq);
    assert.deepEqual(f.sends, [rid, rid]); assert.equal(f.probes.get(rid), 3);
    assert.equal(await readFile(f.file, 'utf8'), saved);
  } finally { await f.cleanup(); }
});

test('R-030-AR-1 question without its own address cannot use the run address or sole call', async () => {
  for (const kind of ['answer', 'decide'] as const) {
    const f = await fixture();
    try {
      const describe = f.client.describe.bind(f.client);
      f.client.describe = async rid => {
        const view = await describe(rid);
        if (!f.sends.length) delete view.questions![0]!.to;
        return view;
      };
      f.setPost({ state: 'running', wid: 'w', calls: [{ key: 'main', phase: 'queued' }] });
      const r = kind === 'answer' ? await ops.answer({ cwd: f.cwd, as: parent, node: 'a', text: 'Use v2', dsa: f.client })
        : await ops.decide({ cwd: f.cwd, as: parent, nodes: ['a'], text: 'Use v2', dsa: f.client });
      assert.equal(r.answers[0]!.state, 'unknown (call not identified)');
      assert.equal(f.sends.length, 1); assert.equal(await readFile(f.file, 'utf8'), f.saved());
    } finally { await f.cleanup(); }
  }
});

test('AR1: multi-node decide reports each successfully delivered answer, no probe for failed sends', async () => {
  for (const failSecond of [false, true]) {
    const f = await fixture(['a', 'b']);
    try {
      f.setPost({ state: 'running', calls: [{ key: 'main', phase: 'queued' }] });
      const original = f.client.send;
      f.client.send = async (...args) => { if (failSecond && args[1] === f.runs.get('b')) throw new Error('send unavailable'); return original(...args); };
      const r = await ops.decide({ cwd: f.cwd, as: parent, nodes: ['b', 'a'], text: 'Use v2', dsa: f.client });
      assert.equal(r.answered, 2); assert.equal(r.deliveryFailures.length, failSecond ? 1 : 0);
      const nodes = failSecond ? ['a'] : ['a', 'b'];
      assert.deepEqual(r.answers, nodes.map(node => ({ node, rid: f.runs.get(node), qid, rev: 3, request: answers.answerRequest(r.rule, { rid: f.runs.get(node)!, qid, rev: 3 }), state: 'queued' })));
      assert.equal(ops.decideText(r).split('\n').filter(line => line.startsWith('answered ')).length, nodes.length);
      assert.equal(f.probes.get(f.runs.get('a')!), 1); assert.equal(f.probes.has(f.runs.get('b')!), !failSecond);
      assert.equal(await readFile(f.file, 'utf8'), f.saved());
    } finally { await f.cleanup(); }
  }
});

test('AR1: shared post-answer probe describes each run once even for multiple answer receipts', async () => {
  let describes = 0;
  const dsa = { async describe(rid: string) { describes++; return toRunView(rid, { state: 'running', calls: [{ key: 'first', phase: 'queued' }, { key: 'second', phase: 'sealed', status: 'ok' }] }); } };
  const refs = [{ node: 'a', rid: 'run', qid: 'q1', rev: 1, to: 'w/first' }, { node: 'a', rid: 'run', qid: 'q2', rev: 2, to: 'w/second' }];
  const entry = { seq: 7, answers: refs } as unknown as import('../src/types.ts').RuleEntry;
  assert.deepEqual((await answers.answerStates(dsa, entry, refs)).map(a => a.state), ['queued', 'sealed (ok)']);
  assert.equal(describes, 1);
});

test('AR1: describe retains optional call phases and statuses without changing workflow state', () => {
  const view = toRunView('rid', { state: 'running', calls: [{ key: 'main', phase: 'queued', status: 'ok' }, { key: 'other', phase: 12, status: {} }] });
  assert.equal(view.state, 'running');
  assert.deepEqual(view.calls, [{ key: 'main', phase: 'queued', status: 'ok' }, { key: 'other' }]);
});

async function external(f: Awaited<ReturnType<typeof fixture>>) {
  const bin = join(f.cwd, 'fake-dsa.mjs'), file = join(f.cwd, 'dsa.json');
  await writeFile(bin, `#!/usr/bin/env node
import {readFileSync,writeFileSync} from 'node:fs';
const a=process.argv.slice(2),get=k=>a[a.indexOf(k)+1],file=process.env.ANSWERSTATE_FILE,s=JSON.parse(readFileSync(file));
if(a[0]==='describe'){s.describes++;writeFileSync(file,JSON.stringify(s));console.log(JSON.stringify(s.sent?{state:'running',calls:[{key:'main',phase:'queued'}]}:{state:'asking',wid:'w',calls:[{key:'main',phase:'running'}],questions:[{qid:'${qid}',rev:3,to:'w/main',text:'Which API?'}]}));}
else if(a[0]==='send'){s.sent++;writeFileSync(file,JSON.stringify(s));console.log(JSON.stringify({spec_digest:'test'}));}else process.exit(1);
`);
  await chmod(bin, 0o755); await writeFile(file, JSON.stringify({ sent: 0, describes: 0 }));
  return { bin, file };
}
test('AR1: CLI answer and decide JSON/text expose actual state; Pi tools keep the same answers details', async () => {
  for (const kind of ['answer', 'decide'] as const) for (const surface of ['text', 'json', 'tool'] as const) {
    const f = await fixture(), old = { bin: process.env.OWED_DSA, file: process.env.ANSWERSTATE_FILE };
    try {
      const fake = await external(f); process.env.OWED_DSA = fake.bin; process.env.ANSWERSTATE_FILE = fake.file;
      const rid = f.runs.get('a')!;
      let details: unknown;
      if (surface === 'tool') {
        const tools = new Map<string, ToolDefinition>();
        owed({ registerTool(t: ToolDefinition) { tools.set(t.name, t); }, registerCommand() {}, on() {}, sendMessage() {} } as unknown as ExtensionAPI);
        const out = await tools.get(`owed_${kind}`)!.execute('ar1', { cwd: f.cwd, as: 'parent:test', ...(kind === 'answer' ? { node: 'a' } : { nodes: ['a'] }), text: 'Use v2' }, undefined, undefined, { cwd: f.cwd } as never);
        details = out.details;
        assert.ok(JSON.stringify(out.content).includes(`answered a ${rid} qid ${qid.slice(0, 8)}: queued`));
      } else {
        const out = await cli(f.cwd, [kind, 'a', ...(kind === 'answer' ? ['Use v2'] : ['--text', 'Use v2']), '--as', 'parent:test', ...(surface === 'json' ? ['--json'] : [])]);
        assert.equal(out.code, 0, out.stderr);
        if (surface === 'text') assert.ok(out.stdout.includes(`answered a ${rid} qid ${qid.slice(0, 8)}: queued`), out.stdout);
        else details = JSON.parse(out.stdout);
      }
      if (details) assert.deepEqual((details as { answers: unknown[] }).answers, [{ node: 'a', rid, qid, rev: 3, request: `owed-answer-${(await ops.readState(f)).state.seq}`, state: 'queued' }]);
      assert.deepEqual(JSON.parse(await readFile(fake.file, 'utf8')), { sent: 1, describes: 2 });
    } finally {
      if (old.bin === undefined) delete process.env.OWED_DSA; else process.env.OWED_DSA = old.bin;
      if (old.file === undefined) delete process.env.ANSWERSTATE_FILE; else process.env.ANSWERSTATE_FILE = old.file;
      await f.cleanup();
    }
  }
});

test('AR1: production post-answer describe is bounded to 10 seconds, and a timeout never resends', { timeout: 20000 }, async t => {
  const f = await fixture();
  try {
    let bounded: number | undefined;
    t.mock.method(Dsa.prototype, 'describe', async (_rid: string, timeoutMs?: number) => { bounded = timeoutMs; return new Promise(() => {}); });
    const start = Date.now();
    const dsa = new Dsa();
    const discover = f.client.describe.bind(f.client), send = f.client.send.bind(f.client);
    const client = { describe: async (rid: string, timeoutMs?: number) => f.sends.length ? dsa.describe(rid, timeoutMs) : discover(rid), send };
    const r = await ops.answer({ cwd: f.cwd, as: parent, node: 'a', text: 'Use v2', dsa: client });
    assert.equal(bounded, 10000); assert.ok(Date.now() - start < 12000);
    assert.equal(r.answers[0]!.state, 'unknown (describe timed out after 10 s)');
    assert.equal(f.sends.length, 1); assert.equal(await readFile(f.file, 'utf8'), f.saved());
  } finally { t.mock.restoreAll(); await f.cleanup(); }
});
