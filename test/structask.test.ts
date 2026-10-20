import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import { Dsa, toRunView } from '../src/dsa.ts';
import { askingText, writerLaunch, submitMessage, rebaseMessage } from '../src/drive.ts';
import { Driver, procStart } from '../src/drive-run.ts';
import { Follower, revalidator } from '../src/drive-bg.ts';
import { needs } from '../src/needs.ts';
import { needText, renderStatus, statusView, WRITER_DECISION } from '../src/views.ts';
import { projectId } from '../src/reducer.ts';
import { repo } from './helpers/repo.ts';
import type { LaunchEntry, RunView } from '../src/types.ts';

const rid = 'rid-writer', qid = 'question12345678';
const guidance = 'If you need a decision outside your writes, ask the parent (your run waits): give decision_needed (one sentence) and numbered options (label, scope, cost, risk; mark one preferred), plus facts (commit, run id, log sha), what you tried, and candidate explanations with their evidence and what is unproven — as ask fields when your ask tool has them, else as text starting "Decision needed:". Never submit a candidate you believe fails its checks.';
const fields = {
  decision_needed: 'Choose the repair scope',
  options: [{ label: 'Narrow fix', scope: 'a.txt', cost: 'one check', risk: 'small', preferred: true }, { label: 'Broader repair' }],
  facts: ['commit abc123', 'run r1', 'log sha def456'], tried: ['reproduced twice'],
  classification_candidates: [{ label: 'environment', evidence: ['budget wait'], unproven: ['same-key pass'] }],
};
const raw = (extra = {}) => ({ state: 'asking', wid: 'w1', calls: [{ key: 'main' }], questions: [{ qid, rev: 3, to: 'w1/ask', text: 'Long background\nwith details.', ...fields, ...extra }] });
const launch = { rid, role: 'writer' } as LaunchEntry;
const formatted = (view = toRunView(rid, raw())) => askingText('a', launch, view);

function follower(root: string) {
  const log = join(root, 'follow', 'log.jsonl'); mkdirSync(join(root, 'follow'), { recursive: true }); writeFileSync(log, '');
  const f = new Follower({ log, repo: root, pid: process.pid, start: procStart(process.pid), deliver() {} });
  return { f, log, put: (text: string, extra = {}) => appendFileSync(log, `${JSON.stringify({ do: 'notify', outcome: 'notify', node: 'a', rid, qid, rev: 3, text, ...extra })}\n`) };
}

async function fixture() {
  const r = await repo();
  const plan = JSON.stringify({ version: 1, trunk: 'main', lease: false, closure: [], invariants: [], nodes: [{ id: 'a', writes: ['a.txt'], checks: [], review: { count: 0, min_rank: 1 } }] });
  await r.put('plan.json', plan); await r.commit();
  const parent = { role: 'parent', id: 'test' } as const;
  await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'pi' }, channel: 'delegated', plan });
  const dispatch = await ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' });
  const state = (await ops.readState(r)).state, writer = writerLaunch(state, 'a', projectId(state));
  await ops.launch({ cwd: r.cwd, as: parent, node: 'a', attempt: 1, role: 'writer', rid: writer.rid, spec: writer.spec, labels: writer.labels, rulings: writer.rulings });
  return { ...r, parent, dispatch, writer };
}

test('SA1/SA2: fake describe retains structured fields and renders DECISION first', () => {
  const view = toRunView(rid, raw());
  assert.deepEqual(view.questions![0], { qid, rev: 3, question: 'Long background\nwith details.', to: 'w1/ask', ...fields });
  const lines = formatted(view).split('\n');
  assert.equal(lines[0], 'a: writer rid-writer asks (qid question, rev 3): DECISION: Choose the repair scope');
  assert.equal(lines[1], 'options: 1) Narrow fix (preferred) — scope a.txt; cost one check; risk small | 2) Broader repair');
  assert.equal(lines[2], 'facts: commit abc123; run r1; log sha def456; tried: reproduced twice; candidates: environment (evidence: budget wait; unproven: same-key pass)');
  assert.equal(lines[3], 'details: Long background\\nwith details.');
  assert.match(lines[4]!, /answer: owed decide a --text "<text>"; in pi: owed_decide/);
  assert.match(lines[4]!, /answer "option <n>; <limits>"/);
  assert.match(lines[4]!, /to:"w1\/ask"/);
});

test('SA1/SA2: ordinary questions remain byte-for-byte unchanged, including addresses and escaping', () => {
  const view = toRunView(rid, { state: 'asking', questions: [{ qid, rev: 3, text: 'Which API? A; B\nline', to: 'w1/ask', options: fields.options }] });
  assert.equal(formatted(view), `a: writer run ${rid} asks (qid ${qid}, rev 3): Which API? A; B\\nline — the driver never answers; answer: owed decide a --text "<text>"; in pi: owed_decide {nodes:["a"], text:"…"} (to:"w1/ask")`);
  assert.equal(askingText('a', launch, { rid, state: 'asking' }), `a: writer run ${rid} is asking (no question reported; see pi-durable-subagents describe --key ${rid}); the driver never answers`);
});

test('SA1: malformed fields are discarded independently, never coerced to object strings', () => {
  const q = toRunView(rid, raw({ decision_needed: { bad: true }, facts: ['fact', 5], tried: { bad: true }, options: [{ label: 'valid', scope: {}, cost: 'low', risk: 3, preferred: 'yes' }, null, { label: {} }], classification_candidates: [{ label: 'maybe', evidence: [4], unproven: ['pending'] }, { label: 7 }, null] })).questions![0]!;
  assert.deepEqual(q, { qid, rev: 3, question: 'Long background\nwith details.', to: 'w1/ask', facts: ['fact'], classification_candidates: [{ label: 'maybe', unproven: ['pending'] }] });
  const partial = toRunView(rid, raw({ options: [{ label: 'valid', scope: {}, cost: 'low', risk: 3, preferred: 'yes' }], facts: [false, 'fact'], tried: [null, 'tried'], classification_candidates: [null, { label: 'maybe', evidence: {}, unproven: ['pending'] }] })).questions![0]!;
  assert.deepEqual(partial, { qid, rev: 3, question: 'Long background\nwith details.', to: 'w1/ask', decision_needed: fields.decision_needed, options: [{ label: 'valid', cost: 'low' }], facts: ['fact'], tried: ['tried'], classification_candidates: [{ label: 'maybe', unproven: ['pending'] }] });
  const mixed = toRunView(rid, raw({ options: [{ label: 'first' }, null, { label: 'third' }] }));
  assert.equal(mixed.questions![0]!.options, undefined);
  assert.match(formatted(mixed), /DECISION: Choose the repair scope\noptions: \n/);
  assert.match(formatted(mixed), /details: Long background\\nwith details\./);
  assert.deepEqual(toRunView(rid, raw({ options: [{ label: 'first', preferred: true }, { label: 'second', preferred: true }, { label: 'third', preferred: false }] })).questions![0]!.options, [{ label: 'first' }, { label: 'second' }, { label: 'third' }]);
  const bad = toRunView(rid, raw({ decision_needed: 7, options: {}, facts: null, tried: 4, classification_candidates: 'bad', text: {} })).questions![0]!;
  assert.deepEqual(bad, { qid, rev: 3, question: '', to: 'w1/ask' });
  assert.doesNotMatch(formatted({ rid, state: 'asking', questions: [bad] }), /\[object Object\]/);
  assert.deepEqual(toRunView(rid, raw({ decision_needed: '', options: [], facts: [], tried: [], classification_candidates: [] })).questions![0], { qid, rev: 3, question: 'Long background\nwith details.', to: 'w1/ask', decision_needed: '', options: [] });
});

test('SA2: each option field, context line and details are bounded after one-line escaping', () => {
  const long = '\n\u202e😀'.repeat(200);
  const lines = formatted(toRunView(rid, raw({ options: [{ label: long, scope: long, cost: long, risk: long, preferred: true }], facts: [long], tried: [long], classification_candidates: [{ label: long, evidence: [long], unproven: [long] }], text: long }))).split('\n');
  const option = lines[1]!.match(/^options: 1\) (.*?) \(preferred\) — scope (.*?); cost (.*?); risk (.*)$/)!;
  for (const field of option.slice(1)) assert.ok(Array.from(field).length <= 160);
  assert.ok(Array.from(lines[2]!).length <= 600);
  // SM4: the full-question command follows the bounded details payload.
  const details = lines[3]!.slice('details: '.length), suffix = details.lastIndexOf(' (full: ');
  assert.ok(suffix > 0); assert.ok(Array.from(details.slice(0,suffix)).length <= 300);
  assert.match(details,/… \(full: pi-durable-subagents describe --key 'rid-writer' --json\)$/);
  assert.equal(lines.length, 5); assert.doesNotMatch(lines.join('\n'), /\u202e/);
});

test('SA2: mixed multi-question wakes keep every qid and its own command', async () => {
  const r = await repo();
  try {
    const view = toRunView(rid, raw());
    view.questions!.push({ qid: 'q2-full', rev: 4, question: 'Which db?', decision_needed: 'Choose DB', options: [{ label: 'SQLite' }] }, { qid: 'q3', rev: 1, question: 'Which port?' });
    const text = formatted(view), { f, put } = follower(r.root); put(text);
    const wake = f.tick()!;
    assert.match(wake, /^Needs you: a — writer rid-writer asks \(qid question, rev 3\): DECISION: Choose the repair scope\noptions:/);
    for (const q of view.questions!) assert.ok(wake.includes(`owed answer a --rid ${rid} --qid ${q.qid} "<text>"`), wake);
    assert.equal(wake.match(/^Needs you:/gm)?.length, 3);
    assert.ok(wake.indexOf('details: Long background') < wake.indexOf('owed answer a'));
    assert.ok(wake.includes('Needs you: a — decide Which port?'));
    assert.doesNotMatch(wake, /owed decide a/);
  } finally { await r.cleanup(); }
});

for (const [name, extra] of [
  ['option quotes ask', { options: [{ label: 'Review writer asks (qid prior, rev 1): log' }] }],
  ['details quotes ask', { text: 'Previous writer asks (qid prior, rev 1): log' }],
  ['option quotes full header', { options: [{ label: 'a: writer run prior asks (qid prior, rev 1): log' }] }],
  ['details quotes full header', { text: 'a: writer run prior asks (qid prior, rev 1): log' }],
] as const) test(`SA2/#3548: ${name} never starts a question block`, async () => {
  const r = await repo();
  try {
    for (const role of ['writer', 'reviewer'] as const) for (const count of [1, 2]) {
      const view = toRunView(rid, raw(extra));
      if (count === 2) view.questions!.push({ qid: 'second-full-qid', rev: 4, question: 'Second details', decision_needed: 'Second decision', options: [{ label: 'Keep' }] });
      const text = askingText('a', { ...launch, role }, view), { f, put } = follower(r.root);
      put(text, { need: null });
      const wake = f.tick()!;
      const expected = text.replace(/^a: /, 'Needs you: a — ').replace(/\na: /g, '\nNeeds you: a — ');
      assert.ok(wake.startsWith(`${expected}\n`), wake);
      assert.equal(wake.match(/^Needs you:/gm)?.length, count, wake);
      assert.doesNotMatch(wake, /owed answer a "<text>"/);
      assert.ok(wake.includes('details:'), wake);
      assert.ok(wake.includes('answer "option <n>; <limits>"'), wake);
      if (count === 1) assert.ok(wake.includes('owed decide a --text "<text>"'), wake);
      else for (const q of view.questions!) assert.ok(wake.includes(`owed answer a --rid ${rid} --qid ${q.qid} "<text>"`), wake);
      f.stop();
    }
  } finally { await r.cleanup(); }
});

test('SA2/#3548: control structured wake retains the complete block', async () => {
  const r = await repo();
  try {
    const text = formatted(), { f, put } = follower(r.root); put(text, { need: null });
    const wake = f.tick()!;
    assert.ok(wake.startsWith(`Needs you: a — ${text.slice('a: '.length)}\n`), wake);
    assert.equal(wake.match(/^Needs you:/gm)?.length, 1);
    f.stop();
  } finally { await r.cleanup(); }
});

test('SA2/#3548: plain DECISION text stays escaped and never becomes a structured block', async () => {
  const r = await repo();
  try {
    const view = toRunView(rid, { state: 'asking', questions: [{ qid, rev: 3, text: 'DECISION: literal\noptions: literal writer asks (qid prior, rev 1): log' }] });
    const text = formatted(view), { f, put } = follower(r.root);
    assert.ok(text.includes('DECISION: literal\\noptions: literal writer asks (qid prior, rev 1): log'));
    put(text, { need: null });
    const quiet = f.tick()!;
    assert.ok(quiet.includes(text), quiet);
    assert.doesNotMatch(quiet, /^Needs you:/m);
    put(text);
    const wake = f.tick()!;
    assert.ok(wake.startsWith('Needs you: a — decide DECISION: literal\\\\noptions: literal writer asks (qid prior, rev 1): log → owed decide a --text "<text>"\n'), wake);
    assert.equal(wake.match(/^Needs you:/gm)?.length, 1);
    f.stop();
  } finally { await r.cleanup(); }
});

test('SA2/R-030-SA-1: production driver wake renders structured ask without adding status membership or ledger facts', async () => {
  const r = await fixture();
  try {
    const describe = { ...raw(), questions: raw().questions }, view = toRunView(r.writer.rid, describe);
    const dsa = { async inspect() { return { view }; }, async describe() { return view; } } as unknown as Dsa;
    const before = (await ops.readState(r)).state, { f, log } = follower(r.root);
    await new Driver({ cwd: r.cwd, dsa, json: true, session: null, log: line => appendFileSync(log, `${line}\n`) }).pass();
    const wake = (await f.step())!;
    assert.match(wake, /DECISION: Choose the repair scope\noptions: 1\) Narrow fix/);
    assert.ok(wake.indexOf('DECISION:') < wake.indexOf('details:'));
    const after = (await ops.readState(r)).state;
    assert.equal(after.head, before.head); assert.equal(after.seq, before.seq);
    assert.equal(needs(after, 'a').filter(n => n.kind === 'answer').length, 0);
    assert.doesNotMatch(renderStatus(await ops.status({ cwd: r.cwd })), /DECISION:/);
  } finally { await r.cleanup(); }
});

test('SA2/R-030-SA-1: existing asking runtime text retains structured lines through needs and status', async () => {
  const r = await fixture();
  try {
    await ops.answerRule({ cwd: r.cwd, as: r.parent, node: 'a', text: `Answer to writer question ${qid}: Use narrow fix`, answer: { rid: r.writer.rid, qid, rev: 3 } });
    const state = (await ops.readState(r)).state, text = askingText('a', { rid: r.writer.rid, role: 'writer' } as LaunchEntry, toRunView(r.writer.rid, raw()));
    const runtime = { driverRunning: true, asking: [{ node: 'a', rid: r.writer.rid, qid, rev: 3, text }] };
    const answerNeed = needs(state, 'a', runtime).find(n => n.kind === 'answer')!;
    assert.ok(answerNeed.text.includes('\noptions: 1) Narrow fix'), answerNeed.text);
    assert.ok(needText(answerNeed).includes('\ndetails: Long background\\nwith details.'), needText(answerNeed));
    const status = statusView(state, [], [], Date.now(), true, [], 1, runtime);
    assert.match(renderStatus(status), /DECISION: Choose the repair scope\noptions: 1\) Narrow fix/);
    assert.match(renderStatus(status, { full: true }), /DECISION: Choose the repair scope\noptions: 1\) Narrow fix/);
  } finally { await r.cleanup(); }
});

test('SA2: structured question wakes retain existing revision revalidation and drop stale asks', async () => {
  const r = await fixture();
  try {
    const { log, put } = follower(r.root);
    let view = toRunView(r.writer.rid, raw());
    const f = new Follower({ log, repo: r.cwd, pid: process.pid, start: procStart(process.pid), deliver() {}, revalidate: revalidator({ cwd: r.cwd, dsa: { async describe() { return view; } } as unknown as Dsa }) });
    put(askingText('a', { rid: r.writer.rid, role: 'writer' } as LaunchEntry, view), { rid: r.writer.rid, need: null });
    view = toRunView(r.writer.rid, { state: 'asking', questions: [{ qid, rev: 4, text: 'new revision', ...fields }] });
    assert.equal(await f.step(), undefined);
    put(askingText('a', { rid: r.writer.rid, role: 'writer' } as LaunchEntry, view), { rid: r.writer.rid, rev: 4, need: null });
    assert.match((await f.step())!, /qid question, rev 4\): DECISION:/);
  } finally { await r.cleanup(); }
});

test('SA3: packet and writer follow-ups share exact structured decision guidance', async () => {
  const r = await fixture();
  try {
    assert.equal(WRITER_DECISION, guidance);
    assert.ok(r.dispatch.packet.includes(guidance));
    const state = (await ops.readState(r)).state;
    assert.ok(JSON.parse(writerLaunch(state, 'a', projectId(state)).spec).task.includes(guidance));
    assert.ok(submitMessage('a').includes(guidance));
    await r.put('trunk.txt', 'moved\n'); await r.commit();
    await ops.adopt({ cwd: r.cwd, as: { role: 'owner', id: 'pi' }, channel: 'delegated', note: 'SA3 fixture moves trunk' });
    await ops.rebase({ cwd: r.cwd, as: r.parent, node: 'a' });
    assert.ok(rebaseMessage((await ops.readState(r)).state, 'a').includes(guidance));
  } finally { await r.cleanup(); }
});
