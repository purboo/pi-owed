// QN1–QN3: ledger answers, delivery races and plain notices (no real dsa).
import { clockTime } from '../src/clock.ts';
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import { decide, writerLaunch } from '../src/drive.ts';
import * as policy from '../src/drive.ts';
import { Driver, factMark, procStart, wakeReport } from '../src/drive-run.ts';
import { projectId } from '../src/reducer.ts';
import { DriveWatch, Follower, classifyLine, haltHintText, revalidator } from '../src/drive-bg.ts';
import { answerRetry } from '../src/answer.ts';
import { parsePlan } from '../src/plan.ts';
import type { Dsa } from '../src/dsa.ts';
import type { RunView } from '../src/types.ts';
import { repo } from './helpers/repo.ts';

const parent = { role: 'parent' as const, id: 'test' };
async function fixture(grace?: number) {
  const r = await repo();
  const plan = JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [],
    ...(grace !== undefined ? { drive: { answer_grace_s: grace } } : {}),
    nodes: [{ id: 'a', writes: ['a.txt'], checks: [], review: { count: 0, min_rank: 1 } }] });
  await r.put('plan.json', plan); await r.commit();
  await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'pi' }, channel: 'delegated', plan });
  await ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' });
  const s = (await ops.readState(r)).state;
  const launch = writerLaunch(s, 'a', projectId(s));
  await ops.launch({ cwd: r.cwd, as: parent, node: 'a', attempt: 1, role: 'writer', rid: launch.rid, spec: launch.spec, labels: launch.labels, rulings: launch.rulings });
  const view: RunView = { rid: launch.rid, state: 'asking', questions: [{ qid: 'q1', rev: 2, question: 'Which API?', to: 'w1/main' }] };
  const dsa = { async describe() { return view; }, async inspect() { return { view }; } } as unknown as Dsa;
  const answer = async (qid = 'q1', rev = 2) => ops.answerRule({ cwd: r.cwd, as: parent, node: 'a', text: `Answer to writer question ${qid}: Use API v2`, answer: { rid: view.rid, qid, rev } });
  const act = async (now?: number) => {
    const s = (await ops.readState(r)).state;
    return decide(s, s.plan, new Map([[view.rid, view]]), { max: 1, repairs: 2, project: projectId(s), root: r.cwd, applied: new Set(), rejected: new Map(), now }).find(a => a.node === 'a');
  };
  return { ...r, view, dsa, answer, act };
}
function logFixture(root: string) {
  const dir = join(root, 'follow'), log = join(dir, 'drive', 'log.jsonl');
  mkdirSync(join(dir, 'drive'), { recursive: true }); writeFileSync(log, '');
  const line = (j: object) => appendFileSync(log, `${JSON.stringify(j)}\n`);
  const owner = { pid: process.pid, start: procStart(process.pid), at: '2026-10-12T02:00:00Z', host: hostname(), token: 'new' };
  const lock = () => writeFileSync(join(dir, 'drive.lock'), JSON.stringify(owner));
  return { dir, log, line, owner, lock };
}

test('QN1: a durable answer suppresses the driver question although dsa still asks; older revs are covered, newer revs are not', async () => {
  const f = await fixture();
  try {
    const e = await f.answer();
    for (const rev of [1, 2]) {
      f.view.questions![0]!.rev = rev;
      const a = await f.act(Date.parse(e.ts) + 899_000);
      assert.ok(a?.do === 'notify' && a.quiet);
      assert.equal(a.text, `a: answered #${e.seq}, waiting for the run to resume`);
      const s = (await ops.readState(f)).state;
      assert.equal(policy.answeredQuestion(s, f.view.rid, 'q1', rev)?.seq, e.seq);
    }
    f.view.questions![0]!.rev = 3;
    const a = await f.act(Date.parse(e.ts) + 901_000);
    assert.ok(a?.do === 'notify' && !a.quiet && !a.answerRetry);
    assert.match(a.text, /Which API/);
  } finally { await f.cleanup(); }
});

test('QN1: quiet answer reports never wake and overdue answers wake once per rid/qid across passes', async () => {
  const f = await fixture(0);
  try {
    const e = await f.answer(), lines: Record<string, unknown>[] = [];
    const driver = new Driver({ cwd: f.cwd, dsa: f.dsa, json: true, log: l => lines.push(JSON.parse(l)), session: null });
    const a = await f.act(Date.parse(e.ts));
    assert.ok(a?.do === 'notify' && a.answerRetry);
    assert.match(a.text, new RegExp(`answer #${e.seq} recorded 0s ago`));
    assert.ok(a.text.endsWith(`retry delivery: ${answerRetry('a', e)}`));
    await driver.pass(); await driver.pass();
    assert.equal(lines.filter(x => wakeReport(x)).length, 1);
    assert.equal(lines[0]!.answerRetry, true);
    assert.equal(classifyLine(JSON.stringify({ do: 'notify', node: 'a', outcome: 'answered', text: 'a: answered' })).kind, 'quiet');
    assert.equal(wakeReport({ do: 'notify', outcome: 'answered' }), false);
  } finally { await f.cleanup(); }
});

test('QN1: the default 900-second grace logs a quiet line without writing the ledger', async () => {
  const f = await fixture();
  try {
    const e = await f.answer(), lines: Record<string, unknown>[] = [];
    const before = (await ops.readState(f)).entries.length;
    const d = new Driver({ cwd: f.cwd, dsa: f.dsa, json: true, log: l => lines.push(JSON.parse(l)), session: null });
    await d.pass(); await d.pass();
    assert.equal(lines.length, 1); assert.equal(lines[0]!.outcome, 'answered');
    assert.equal(lines[0]!.text, `a: answered #${e.seq}, waiting for the run to resume`);
    assert.equal((await ops.readState(f)).entries.length, before);
    assert.equal((await f.act(Date.parse(e.ts) + 900_000))?.do, 'notify');
  } finally { await f.cleanup(); }
});

test('QN1 live queue: answer-bound hibernated call stays asking with identical qid/rev until the 900s grace, then one retry wake', async () => {
  const f = await fixture(), realNow = Date.now;
  try {
    const e = await f.answer(); // durable rule exists while answer-bound resume waits for a provider slot
    const originalQuestion = structuredClone(f.view.questions);
    const lines: Record<string, unknown>[] = [];
    const driver = new Driver({ cwd: f.cwd, dsa: f.dsa, json: true, log: l => lines.push(JSON.parse(l)), session: null });
    const recorded = Date.parse(e.ts);
    for (const age of [0, 60_000, 899_999]) {
      Date.now = () => recorded + age;
      await driver.pass();
      assert.equal(lines.filter(x => wakeReport(x)).length, 0, 'the answer rule resolves the question while resume is queued');
    }
    assert.equal(lines.length, 1);
    assert.equal(lines[0]!.text, `a: answered #${e.seq}, waiting for the run to resume`);
    for (const age of [900_000, 901_000, 1_800_000]) {
      Date.now = () => recorded + age;
      await driver.pass();
    }
    const wakes = lines.filter(x => wakeReport(x));
    assert.equal(wakes.length, 1); assert.equal(wakes[0]!.answerRetry, true);
    assert.match(String(wakes[0]!.text), /recorded 900s ago but run .* still shows question q1; retry delivery:/);
    assert.equal(f.view.state, 'asking'); assert.deepEqual(f.view.questions, originalQuestion);
    assert.deepEqual(wakes[0]!.qid, e.answer!.qid); assert.equal(wakes[0]!.rev, e.answer!.rev);
  } finally { Date.now = realNow; await f.cleanup(); }
});

test('QN1 repair #1514: grace retry held while pi is busy survives owed resume and is delivered exactly once', async () => {
  const f = await fixture(), l = logFixture(f.root), realNow = Date.now;
  try {
    const e = await f.answer();
    Date.now = () => Date.parse(e.ts) + 900_000;
    let busy = true;
    const delivered: string[] = [], lines: Record<string, unknown>[] = [];
    const follower = new Follower({ log: l.log, repo: f.cwd, pid: process.pid, start: procStart(process.pid),
      busy: () => busy, deliver: s => delivered.push(s), revalidate: revalidator({ cwd: f.cwd, dsa: f.dsa }) });
    const driver = new Driver({ cwd: f.cwd, dsa: f.dsa, json: true, session: null, log: s => {
      const line = JSON.parse(s) as Record<string, unknown>; lines.push(line); l.line(line);
    } });
    await driver.pass();
    const retry = lines.find(x => x.answerRetry)!;
    assert.ok(retry); assert.equal(retry.qid, 'q1'); assert.equal(retry.rev, 2);
    assert.equal(await follower.step(), undefined); assert.equal(delivered.length, 0);
    await ops.resume({ cwd: f.cwd, as: parent, node: 'a', note: 'retry after an unrelated pause' });
    assert.ok(factMark((await ops.readState(f)).state, 'a') > Number(retry.facts));
    await driver.pass(); // the driver has consumed its once mark; it cannot replace a dropped retry
    assert.equal(lines.filter(x => x.answerRetry).length, 1);
    busy = false;
    assert.match(await follower.step() ?? '', /still shows question q1; retry delivery:/);
    assert.equal(delivered.length, 1); assert.ok(delivered[0]!.includes(answerRetry('a', e)));
    await driver.pass(); await driver.pass();
    assert.equal(await follower.step(), undefined); assert.equal(await follower.step(), undefined);
    assert.equal(delivered.length, 1); assert.equal(lines.filter(x => x.answerRetry).length, 1);
  } finally { Date.now = realNow; await f.cleanup(); }
});

test('QN1 repair #1514: retry delivery requires an answered question with the same open qid and rev', async () => {
  const f = await fixture();
  try {
    const validate = revalidator({ cwd: f.cwd, dsa: f.dsa });
    const check = { node: 'a', facts: factMark((await ops.readState(f)).state, 'a'),
      rid: f.view.rid, qid: 'q1', rev: 2, answerRetry: true as const };
    assert.deepEqual(await validate([check]), [false], 'an unanswered question has no answer delivery to retry');
    await f.answer();
    assert.deepEqual(await validate([check]), [true]);
    for (const rev of [1, 3]) {
      f.view.questions![0]!.rev = rev;
      assert.deepEqual(await validate([check]), [false], 'a changed revision resolves the held retry');
    }
    f.view.questions![0]!.rev = 2; f.view.questions![0]!.qid = 'replacement';
    assert.deepEqual(await validate([check]), [false]);
    f.view.questions = [];
    assert.deepEqual(await validate([check]), [false], 'a closed question resolves the held retry');
  } finally { await f.cleanup(); }
});

test('QN1 delivery: a ledger answer drops an asking wake without facts even when describe still asks or fails; retry reminders stay deliverable', async () => {
  const f = await fixture();
  try {
    const check = { rid: f.view.rid, qid: 'q1', rev: 2 };
    const validate = revalidator({ cwd: f.cwd, dsa: f.dsa });
    assert.deepEqual(await validate([check]), [true]);
    await f.answer();
    assert.deepEqual(await validate([check, { ...check, rev: 1 }, { ...check, answerRetry: true }]), [false, false, true]);
    const failing = { async describe() { throw new Error('transport down'); } } as unknown as Dsa;
    assert.deepEqual(await revalidator({ cwd: f.cwd, dsa: failing })([check, { ...check, rev: 3 }]), [false, true]);
  } finally { await f.cleanup(); }
});

test('QN1 delivery: an answer recorded while pi is busy drops the held wake and does not ride along', async () => {
  const f = await fixture(), l = logFixture(f.root);
  try {
    let busy = true; const delivered: string[] = [];
    const follower = new Follower({ log: l.log, repo: f.cwd, pid: process.pid, start: procStart(process.pid), busy: () => busy, deliver: s => delivered.push(s), revalidate: revalidator({ cwd: f.cwd, dsa: f.dsa }) });
    l.line({ do: 'notify', node: 'a', outcome: 'notify', text: 'a asks', rid: f.view.rid, qid: 'q1', rev: 2 });
    await follower.step(); await f.answer(); busy = false;
    assert.equal(await follower.step(), undefined); assert.equal(delivered.length, 0);
    l.line({ do: 'halt', node: 'b', detail: 'choose the API', outcome: 'halted' });
    assert.doesNotMatch(await follower.step() ?? '', /a asks/);
  } finally { await f.cleanup(); }
});

test('QN1: answered questions are filtered out of a multi-question report; plan validates grace without changing absent plans', async () => {
  const f = await fixture();
  try {
    await f.answer(); f.view.questions!.push({ qid: 'q2', rev: 1, question: 'Which scope?' });
    const a = await f.act(); assert.ok(a?.do === 'notify');
    assert.equal(a.qid, 'q2'); assert.doesNotMatch(a.text, /Which API/); assert.match(a.text, /Which scope/);
    const raw = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: [] };
    assert.equal(parsePlan(JSON.stringify(raw)).drive, undefined);
    for (const answer_grace_s of [-1, 1.5, '900']) assert.throws(() => parsePlan(JSON.stringify({ ...raw, drive: { answer_grace_s } })), /answer_grace_s/);
    assert.equal(parsePlan(JSON.stringify({ ...raw, drive: { answer_grace_s: 12 } })).drive!.answer_grace_s, 12);
  } finally { await f.cleanup(); }
});

test('QN1: each overdue answered question gets one reminder even with another unanswered question', async () => {
  const f = await fixture(0);
  try {
    f.view.questions!.push({ qid: 'q2', rev: 1, question: 'Which scope?' }, { qid: 'q3', rev: 1, question: 'Which format?' });
    await f.answer(); await f.answer('q2', 1);
    const lines: Record<string, unknown>[] = [];
    const driver = new Driver({ cwd: f.cwd, dsa: f.dsa, json: true, log: l => lines.push(JSON.parse(l)), session: null });
    await driver.pass(); await driver.pass(); await driver.pass(); await driver.pass();
    assert.deepEqual(lines.filter(x => x.answerRetry).map(x => x.qid), ['q1', 'q2']);
    assert.equal(lines.filter(x => x.qid === 'q3').length, 1);
    assert.match(String(lines.find(x => x.qid === 'q3')!.text), /Which format/);
    f.view.questions![0]!.rev = 1;
    assert.deepEqual(await revalidator({ cwd: f.cwd, dsa: f.dsa })([{ rid: f.view.rid, qid: 'q1', rev: 1, answerRetry: true }]), [true]);
  } finally { await f.cleanup(); }
});

test('QN2: stale terminal events ride along, name the current owner and keep the follower alive', async () => {
  const f = await repo(), l = logFixture(f.root);
  try {
    l.lock(); const got: string[] = [];
    const follower = new Follower({ log: l.log, repo: f.cwd, pid: process.pid, start: procStart(process.pid), deliver: s => got.push(s) });
    for (const event of ['stopped', 'exit', 'killed', 'idle']) {
      l.line({ event, code: 0, reason: event, driver: { pid: 987654, start: 'old', at: '2026-10-12T01:00:00Z' } });
      assert.equal(follower.tick(), undefined);
    }
    assert.equal(got.length, 0); assert.equal(follower.stopped, false);
    l.line({ do: 'halt', node: 'a', outcome: 'halted', detail: 'choose the API', inProgress: 2 });
    const text = follower.tick()!;
    assert.match(text, /Driver continues \(2 in progress\)/);
    assert.ok(text.includes(`earlier driver (pid 987654, started ${clockTime('2026-10-12T01:00:00Z')}) stopped; driver pid ${process.pid} (started ${clockTime('2026-10-12T02:00:00Z')}) is running`));
    assert.equal(follower.stopped, false);
  } finally { await f.cleanup(); }
});

test('QN2: a terminal line held while busy is checked again at delivery after a newer owner starts', async () => {
  const f = await repo(), l = logFixture(f.root);
  try {
    let busy = true;
    const follower = new Follower({ log: l.log, repo: f.cwd, pid: process.pid, start: procStart(process.pid), busy: () => busy, deliver() {} });
    l.line({ event: 'stopped', driver: { pid: 987654, at: '2026-10-12T01:00:00Z' } });
    assert.equal(await follower.step(), undefined);
    l.lock(); busy = false;
    assert.equal(await follower.step(), undefined);
    l.line({ do: 'notify', node: 'a', outcome: 'notify', text: 'a asks' });
    assert.match(await follower.step() ?? '', /earlier driver/);
  } finally { await f.cleanup(); }
});

test('QN2: current driver terminals and terminals with no owner still wake and stop the follower', async () => {
  for (const withOwner of [false, true]) {
    const f = await repo(), l = logFixture(f.root);
    try {
      if (withOwner) l.lock();
      const follower = new Follower({ log: l.log, repo: f.cwd, pid: process.pid, start: procStart(process.pid), deliver() {} });
      l.line({ event: 'stopped', driver: l.owner });
      assert.match(follower.tick() ?? '', /^Driver stopped: stopped\nowed drive /);
      assert.equal(follower.stopped, true);
    } finally { await f.cleanup(); }
  }
});

test('QN2: identical terminal text from old and current drivers keeps the current terminal and ends the follower', async () => {
  const f = await repo(), l = logFixture(f.root);
  try {
    l.lock();
    const follower = new Follower({ log: l.log, repo: f.cwd, pid: process.pid, start: procStart(process.pid), deliver() {} });
    l.line({ event: 'stopped', driver: { pid: 987654, start: 'old', at: '2026-10-12T01:00:00Z' } });
    l.line({ event: 'stopped', driver: l.owner });
    const text = follower.tick()!;
    assert.match(text, /^Driver stopped: stopped/);
    assert.match(text, /earlier driver/); assert.match(text, /^Driver stopped: stopped\n/);
    assert.equal(follower.stopped, true);
  } finally { await f.cleanup(); }
});

test('QN2: ownership is checked again after asynchronous question revalidation', async () => {
  const f = await repo(), l = logFixture(f.root);
  try {
    const follower = new Follower({ log: l.log, repo: f.cwd, pid: process.pid, start: procStart(process.pid), deliver() {}, busy: () => false,
      revalidate: async checks => { l.lock(); return checks.map(() => false); } });
    l.line({ event: 'stopped', driver: { pid: 987654, start: 'old', at: '2026-10-12T01:00:00Z' } });
    l.line({ do: 'notify', node: 'a', outcome: 'notify', text: 'a asks', rid: 'r', qid: 'q', rev: 1 });
    assert.equal(await follower.step(), undefined);
    l.line({ do: 'notify', node: 'b', outcome: 'notify', text: 'b asks' });
    assert.match(await follower.step() ?? '', /earlier driver/); assert.equal(follower.stopped, false);
  } finally { await f.cleanup(); }
});

test('QN2: explicit follow of a replacement driver preserves held earlier terminal lines', async () => {
  const f = await repo(), l = logFixture(f.root);
  const got: string[] = []; let busy = true;
  const watch = new DriveWatch(s => got.push(s), 0, { busy: () => busy, revalidate: () => async checks => checks.map(() => true) });
  try {
    watch.follow({ log: l.log, repo: f.cwd, pid: 987654, start: 'old', since: '2026-10-12T01:00:00Z' });
    l.line({ event: 'stopped' }); await watch.flush();
    l.lock(); watch.follow({ log: l.log, repo: f.cwd, pid: process.pid, start: procStart(process.pid), since: l.owner.at }); busy = false;
    assert.deepEqual(await watch.flush(), []);
    l.line({ do: 'notify', node: 'a', outcome: 'notify', text: 'a asks' }); await watch.flush();
    assert.match(got[0]!, /earlier driver \(pid 987654/);
  } finally { watch.stopAll(); await f.cleanup(); }
});

test('NY4/QN3: the single notice keeps owner alternatives and quoted answer retry text intact', async () => {
  const f = await repo(), l = logFixture(f.root);
  try {
    const follower = new Follower({ log: l.log, repo: f.cwd, pid: process.pid, start: procStart(process.pid), deliver() {} });
    l.line({ do: 'notify', node: 'a', outcome: 'notify', text: 'a: needs the owner (the main agent decides; owed lists the command): flaky block #42 on check:unit; the driver leaves it alone; the main agent resolves it with: owed waive a check:unit --reason "<why>" | owed abandon a --note "<why>"' });
    const owner = follower.tick()!.split('\n');
    assert.match(owner[0]!, /^Needs you: a: needs the owner .*flaky block #42/);
    assert.ok(owner[0]!.includes('owed waive a check:unit --reason "<why>" | owed abandon'));
    const retry = "owed answer 'b' --rid 'r' --qid 'q' -- 'Use API v2; then check'";
    l.line({ do: 'notify', node: 'b', outcome: 'notify', answerRetry: true, text: `b: answer #7 recorded 900s ago but run r still shows question q; retry delivery: ${retry}` });
    assert.equal(follower.tick()!.split('\n')[0], `Needs you: b: answer #7 recorded 900s ago but run r still shows question q; retry delivery: ${retry}`);
  } finally { await f.cleanup(); }
});

test('NY4/QN3: Needs you, Done, driver status and Next order; every original notice and halt command occurs once', async () => {
  const f = await repo(), l = logFixture(f.root);
  try {
    const follower = new Follower({ log: l.log, repo: f.cwd, pid: process.pid, start: procStart(process.pid), deliver() {} });
    const halt = { do: 'halt', node: 'b', outcome: 'halted', attempt: 1, needs: 'human', detail: 'choose the API', inProgress: 3 };
    const ask = { do: 'notify', node: 'a', outcome: 'notify', rid: 'rid-a', qid: 'q1', rev: 1, text: 'a: writer run rid-a asks (qid q1, rev 1): which db? — the driver never answers; answer: owed answer a --rid rid-a --qid q1 "<text>"; in pi: owed_answer {node:"a"}' };
    l.line({ do: 'merge', node: 'm', outcome: 'merged', detail: 'trunk 1' }); l.line(ask); l.line(halt);
    const text = follower.tick()!, lines = text.split('\n');
    assert.equal(lines[0], `Needs you: ${ask.text}`);
    assert.match(lines[1]!, /^Needs you: halt b attempt 1, needs the parent .*halted — choose the API$/);
    assert.deepEqual(lines.slice(2, 5), ['Done: m', 'Driver continues (3 in progress)', `owed drive (${f.cwd}):`]);
    assert.equal(text.split(ask.text).length - 1,1);
    assert.equal(text.split('choose the API').length - 1,1);
    assert.doesNotMatch(text,/\nDetails:/);
    assert.ok(text.includes(ask.text)); assert.match(text, /halt b attempt 1, needs the parent/);
    assert.ok(text.includes(haltHintText)); assert.equal(lines.at(-1), 'Next: owed status / owed why <node>');
  } finally { await f.cleanup(); }
});
