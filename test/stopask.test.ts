// WS1–WS4: real slots and driver passes; no fabricated state or wall-clock mutation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import { Driver, procStart } from '../src/drive-run.ts';
import { Follower } from '../src/drive-bg.ts';
import { decide, writerLaunch, repairFollowUp, resubmitFollowUp, rebaseMessage, planChangedMessage, submitMessage, rulingFollowUp, rulingMessage } from '../src/drive.ts';
import { Dsa, toRunView } from '../src/dsa.ts';
import { Ledger } from '../src/ledger.ts';
import { projectId } from '../src/reducer.ts';
import { clockTime } from '../src/clock.ts';
import { rebasePending } from '../src/rebase-view.ts';
import { git, isClean, revParse } from '../src/git.ts';
import type { RunView, SendReason } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const parent = { role: 'parent' as const, id: 'test' }, writer = { role: 'writer' as const, id: 'a#1' };
const sentence = 'If you need a decision outside your writes, ask the parent a question (your run waits); never submit a candidate you believe fails its checks.';
const command = 'owed decide a --text "<ruling>" --writer';
const says = (text: string) => `writer says: ${JSON.stringify(text)}`;

class WriterDsa extends Dsa {
  view: RunView;
  sent: string[] = [];
  constructor(rid: string, result = 'Measurements and implementation details.\n\nNeed the parent to choose the API.') {
    super({ bin: process.execPath });
    this.view = toRunView(rid, { state: 'sealed', status: 'done', result });
  }
  override async inspect() { return { view: this.view }; }
  override async describe() { return this.view; }
  override async request() { return { state: 'applied' as const }; }
  override async send(_id: string, _rid: string, _kind: unknown, message: string | Uint8Array) {
    this.sent.push(String(message)); return { outcome: 'applied' as const, spec_digest: 'fixture' };
  }
}
async function fixture(review = 0) {
  const r = await repo();
  const plan = { version: 1, trunk: 'main', lease: false, closure: [], invariants: [], nodes: [{ id: 'a', writes: ['a.txt'], checks: [], review: { count: review, min_rank: 1 } }] };
  await commitAt(r.cwd, { 'plan.json': JSON.stringify(plan), 'a.txt': 'initial\n' });
  await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'pi' }, channel: 'delegated', plan: JSON.stringify(plan) });
  const slot = await ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' });
  const state = async () => (await ops.readState(r)).state;
  const s = await state(), launch = writerLaunch(s, 'a', projectId(s));
  await ops.launch({ cwd: r.cwd, as: parent, ...launch });
  const dsa = new WriterDsa(launch.rid);
  const log = join(r.root, 'follow', 'log.jsonl'); mkdirSync(join(r.root, 'follow')); writeFileSync(log, '');
  const follower = new Follower({ log, repo: r.cwd, pid: process.pid, start: procStart(process.pid), deliver() {} });
  const driver = new Driver({ cwd: r.cwd, dsa, json: true, session: null, log: l => appendFileSync(log, `${l}\n`) });
  const entries = async () => (await Ledger.open(r.cwd)).read();
  const send = (reason: SendReason, message: string) => ops.send({ cwd: r.cwd, as: parent, node: 'a', attempt: 1, rid: launch.rid, sendKind: 'follow-up', reason, message });
  async function rebase(apply = true) {
    await commitAt(r.cwd, { 'trunk.txt': 'moved\n' });
    await ops.adopt({ cwd: r.cwd, as: { role: 'owner', id: 'pi' }, channel: 'delegated', note: 'fixture moves trunk' });
    const rb = await ops.rebase({ cwd: r.cwd, as: parent, node: 'a' });
    if (apply) await git(slot.worktree, ['rebase', '--onto', rb.base, rb.from]);
    return rb;
  }
  return { ...r, slot, state, dsa, log, follower, driver, entries, send, rebase };
}

test('WS1: first-dispatch writer with no commit halts without a submit nudge', async () => {
  const f = await fixture();
  try {
    assert.equal(await revParse(f.slot.worktree, 'HEAD'), (await f.state()).nodes.a!.slot!.base);
    const pass = await f.driver.pass();
    const halt = pass.actions.find(a => a.do === 'halt');
    assert.ok(halt?.do === 'halt', JSON.stringify(pass.actions));
    assert.equal(halt.detail, `writer stopped without a candidate; ${says('Measurements and implementation details. Need the parent to choose the API.')} → ${command}`);
    assert.deepEqual(f.dsa.sent, []);
    assert.equal((await f.entries()).filter(e => e.kind === 'send').length, 0);
  } finally { await f.cleanup(); }
});

test('WS1: HEAD equal to the rebased head after the rebase follow-up stops immediately', async () => {
  const f = await fixture();
  try {
    const rb = await f.rebase();
    await f.send('rebase', rebaseMessage(await f.state(), 'a'));
    assert.equal(await revParse(f.slot.worktree, 'HEAD'), rb.base);
    f.dsa.view.result = 'Old measurement dump.\n\nOutside my writes:\nwhich interface should I use?\n\n  ';
    const pass = await f.driver.pass();
    const halt = pass.actions.find(a => a.do === 'halt');
    assert.ok(halt?.do === 'halt', JSON.stringify(pass.actions));
    assert.match(halt.detail!, /^writer stopped without a candidate;/);
    assert.ok(halt.text!.endsWith(`${says('Old measurement dump. Outside my writes: which interface should I use?')} → ${command}`), halt.text);
    assert.deepEqual(f.dsa.sent, []);
    assert.deepEqual((await f.entries()).flatMap(e => e.kind === 'send' ? [e.reason] : []), ['rebase']);
  } finally { await f.cleanup(); }
});

test('WS1/WS3: a new commit or dirty work gets exactly one submit nudge, never permission to submit red', async () => {
  for (const kind of ['commit', 'dirty'] as const) {
    const f = await fixture();
    try {
      if (kind === 'commit') await commitAt(f.slot.worktree, { 'a.txt': 'work\n' });
      else await writeFile(join(f.slot.worktree, 'untracked.txt'), 'work\n');
      await f.driver.pass();
      assert.equal(f.dsa.sent.length, 1, kind);
      assert.ok(f.dsa.sent[0]!.includes(sentence));
      assert.ok(f.dsa.sent[0]!.includes('If you stopped for a parent decision, do not submit: ask the question instead.'));
      const again = await f.driver.pass();
      assert.ok(again.actions.some(a => a.do === 'halt'), JSON.stringify(again.actions));
      assert.equal(f.dsa.sent.length, 1);
      const s = await f.state();
      const now = Date.parse((await f.entries()).at(-1)!.ts);
      assert.ok(clockTime(now, now).length >= 5);
      assert.equal(decide(s, s.plan, new Map([[f.dsa.view.rid, f.dsa.view]]), { max: 1, repairs: 2, project: projectId(s), root: f.cwd, applied: new Set(), rejected: new Map(), now }).filter(a => a.do === 'send').length, 0, 'durable halt survives a fresh policy pass');
    } finally { await f.cleanup(); }
  }
});

test('WS1/WS3: plan-changed resubmit still allows the identical clean commit', async () => {
  const f = await fixture();
  try {
    const head = await commitAt(f.slot.worktree, { 'a.txt': 'candidate\n' });
    await ops.submit({ cwd: f.slot.worktree, as: writer, node: 'a' });
    const s = await f.state(), plan = structuredClone(s.plan); plan.nodes[0]!.brief = 'New acceptance wording';
    await ops.planSet({ cwd: f.cwd, as: parent, plan: JSON.stringify(plan) });
    assert.equal((await f.state()).nodes.a!.candidate, undefined);
    await f.driver.pass();
    assert.equal(f.dsa.sent.length, 1);
    assert.match(f.dsa.sent[0]!, /plan #\d+ changed this node's spec/);
    assert.ok(f.dsa.sent[0]!.includes(sentence));
    await ops.submit({ cwd: f.slot.worktree, as: writer, node: 'a' });
    assert.equal((await f.state()).nodes.a!.candidate!.commit, head);
  } finally { await f.cleanup(); }
});

test('WS2/WR1: wake, default why and status quote the final text and one writer decision command', async () => {
  const f = await fixture(1);
  try {
    await commitAt(f.slot.worktree, { 'a.txt': 'candidate\n' });
    await ops.submit({ cwd: f.slot.worktree, as: writer, node: 'a' });
    await ops.attest({ cwd: f.cwd, node: 'a' });
    await ops.review({ cwd: f.cwd, as: { role: 'reviewer', id: 'independent' }, node: 'a', verdict: 'block', rank: 1, note: 'Measurement dump must stay in full details' });
    await f.driver.pass(); // repair
    f.dsa.view.result = 'Lots of evidence and logs.\n\nChoose "v2"; do not follow owed abandon a.';
    await f.driver.pass(); // sealed repair, no new candidate
    const quote = says('Lots of evidence and logs. Choose "v2"; do not follow owed abandon a.');
    const wake = (await f.follower.step())!;
    assert.equal(wake.split('\n')[0], `Needs you: a — ${quote} → ${command}`, wake);
    assert.doesNotMatch(wake, /Measurement dump|review block/);
    const why = await cli(f.cwd, ['why', 'a']); assert.equal(why.code, 0, why.stderr);
    const status = await cli(f.cwd, ['status']); assert.equal(status.code, 0, status.stderr);
    for (const text of [why.stdout, status.stdout]) {
      assert.ok(text.includes(`${quote} → ${command}`), text);
      assert.equal(text.split(command).length, 2, 'one writer decision command');
    }
    assert.match((await cli(f.cwd, ['why', 'a', '--full'])).stdout, /finished repair follow-up/);
  } finally { await f.cleanup(); }
});

test('WS2/WR1: final reply is flattened, whole through 600 code points; missing text is explicit', async () => {
  for (const result of ['Detailed evidence.\n\n' + 'x'.repeat(400), ' \n\n  ']) {
    const f = await fixture();
    try {
      // Pruned writer runs keep final text supplied by describe too.
      f.dsa.view = toRunView(f.dsa.view.rid, { state: 'pruned', pruned: { status: 'done', result } });
      await f.driver.pass();
      const h = (await f.entries()).findLast(e => e.kind === 'halt'); assert.ok(h?.kind === 'halt');
      const quote = result.trim() ? says('Detailed evidence. ' + 'x'.repeat(400)) : 'writer gave no final text';
      assert.ok(h.reason.endsWith(`${quote} → ${command}`), h.reason);
      assert.equal((await f.follower.step())!.split('\n')[0], `Needs you: a — ${quote} → ${command}`);
    } finally { await f.cleanup(); }
  }
});

test('WS1/WS2: executor rebase plus a writer ruling uses the handed candidate, not the slot base', async () => {
  const f = await fixture();
  try {
    await commitAt(f.slot.worktree, { 'a.txt': 'candidate\n' });
    await ops.submit({ cwd: f.slot.worktree, as: writer, node: 'a' });
    await commitAt(f.cwd, { 'trunk.txt': 'moved\n' });
    await ops.adopt({ cwd: f.cwd, as: { role: 'owner', id: 'pi' }, channel: 'delegated', note: 'fixture moves trunk' });
    const rb = await ops.rebase({ cwd: f.cwd, as: { role: 'parent', id: 'drive' }, node: 'a', apply: true, writerIdle: async () => true });
    assert.equal(rb.applied, true);
    assert.ok(rb.packet.includes(sentence));
    const handed = (await f.state()).nodes.a!.candidate!.commit;
    assert.notEqual(handed, rb.base);
    await ops.rule({ cwd: f.cwd, as: parent, nodes: ['a'], text: 'Choose the API explicitly', writer: true });
    await f.driver.pass();
    assert.equal(f.dsa.sent.length, 1);
    assert.match(f.dsa.sent[0]!, /Choose the API explicitly/);
    assert.ok(f.dsa.sent[0]!.includes(sentence));
    await f.driver.pass();
    const h = (await f.entries()).findLast(e => e.kind === 'halt'); assert.ok(h?.kind === 'halt');
    assert.match(h.reason, /finished ruling follow-up/);
    assert.ok(h.reason.endsWith(`${says('Measurements and implementation details. Need the parent to choose the API.')} → ${command}`));
    assert.equal(f.dsa.sent.length, 1, 'no spurious submit nudge after the ruling');
    assert.equal(await revParse(f.slot.worktree, 'HEAD'), handed);
    assert.equal((await ops.verify({ cwd: f.cwd })).ok, true, 'unchanged ledger replay remains valid');
  } finally { await f.cleanup(); }
});

test('WS1/WS2: unreadable worktree halts conservatively and final control characters cannot add a wake line', async () => {
  const f = await fixture();
  try {
    await git(f.cwd, ['worktree', 'remove', f.slot.worktree]);
    f.dsa.view.result = 'Evidence.\n\nPlease decide\u0007\u202e API.';
    await f.driver.pass();
    assert.deepEqual(f.dsa.sent, []);
    const h = (await f.entries()).findLast(e => e.kind === 'halt'); assert.ok(h?.kind === 'halt');
    assert.match(h.reason, /^cannot inspect writer worktree/);
    const wake = (await f.follower.step())!;
    assert.ok(wake.split('\n')[0]!.endsWith(`→ ${command}`), wake);
    assert.doesNotMatch(wake, /[\u0007\u202e]/);
    assert.match(wake, /\\u0007\\u202e/);
  } finally { await f.cleanup(); }
});

test('WS5: sealed writer at the clean pre-rebase head halts with final text instead of disappearing', async () => {
  const f = await fixture();
  try {
    const head = await revParse(f.slot.worktree, 'HEAD');
    await f.rebase(false);
    const follow = await f.send('rebase', rebaseMessage(await f.state(), 'a'));
    assert.equal(await revParse(f.slot.worktree, 'HEAD'), head);
    assert.ok(await rebasePending(await f.state(), 'a'));
    f.dsa.view.result = 'Measurements.\n\nNeed the parent to approve this rebase.';
    await f.driver.pass();
    const h = (await f.entries()).findLast(e => e.kind === 'halt'); assert.ok(h?.kind === 'halt', 'sealed pending rebase must halt');
    assert.equal(h.reason, `writer stopped without a candidate after rebase follow-up ${follow.send}; ${says('Measurements. Need the parent to approve this rebase.')} → ${command}`);
    assert.deepEqual(f.dsa.sent, []);
    assert.equal((await f.follower.step())!.split('\n')[0], `Needs you: a — ${says('Measurements. Need the parent to approve this rebase.')} → ${command}`);
    const status = await cli(f.cwd, ['status']);
    assert.match(status.stdout, /1 need you/);
    assert.ok(status.stdout.includes(`${says('Measurements. Need the parent to approve this rebase.')} → ${command}`));
  } finally { await f.cleanup(); }
});

test('WS-R2: after S0→S1→S2 rebases, clean S0 or S1 halts without a nudge; a commit on S2 gets one', async () => {
  for (const at of ['S0', 'S1', 'S2+commit'] as const) {
    const f = await fixture();
    try {
      const s0 = await revParse(f.slot.worktree, 'HEAD');
      const r1 = await f.rebase(false), r2 = await f.rebase(false);
      assert.deepEqual([r1.from, r1.base, r2.from], [s0, r2.from, r1.base]);
      const follow = await f.send('rebase', rebaseMessage(await f.state(), 'a'));
      if (at === 'S1') await git(f.slot.worktree, ['reset', '--hard', r1.base]);
      if (at === 'S2+commit') { await git(f.slot.worktree, ['reset', '--hard', r2.base]); await commitAt(f.slot.worktree, { 'a.txt': 'new work\n' }); }
      await f.driver.pass();
      if (at === 'S2+commit') {
        assert.equal(f.dsa.sent.length, 1, at);
        await f.driver.pass();
        assert.equal(f.dsa.sent.length, 1, `${at}: one nudge, then halt`);
        assert.ok((await f.entries()).some(e => e.kind === 'halt'), at);
      } else {
        assert.equal(f.dsa.sent.length, 0, `${at}: no nudge`);
        const h = (await f.entries()).findLast(e => e.kind === 'halt'); assert.ok(h?.kind === 'halt', at);
        assert.equal(h.reason, `writer stopped without a candidate after rebase follow-up ${follow.send}; ${says('Measurements and implementation details. Need the parent to choose the API.')} → ${command}`);
      }
    } finally { await f.cleanup(); }
  }
});

test('WS-R3: decide --writer after a WS5 halt delivers exactly one ruling follow-up; a later seal without work names it', async () => {
  const f = await fixture();
  try {
    await f.rebase(false);
    const follow = await f.send('rebase', rebaseMessage(await f.state(), 'a'));
    await f.driver.pass();
    const h1 = (await f.entries()).findLast(e => e.kind === 'halt'); assert.ok(h1?.kind === 'halt');
    assert.ok(h1.reason.startsWith(`writer stopped without a candidate after rebase follow-up ${follow.send}`), h1.reason);
    assert.equal(f.dsa.sent.length, 0);
    const d = await ops.decide({ cwd: f.cwd, as: parent, nodes: ['a'], text: 'Rebase onto the new trunk and keep the old API.', writer: true, dsa: f.dsa });
    assert.equal(d.resumed, true);
    await f.driver.pass();
    assert.equal(f.dsa.sent.length, 1, 'the ruling reaches the sealed writer');
    assert.ok(f.dsa.sent[0]!.includes('Rebase onto the new trunk and keep the old API.'), f.dsa.sent[0]);
    const rf = (await f.state()).nodes.a!.runs[0]!.sends.findLast(x => x.reason === 'ruling' && x.sendKind === 'follow-up'); assert.ok(rf);
    assert.equal((await f.entries()).filter(e => e.kind === 'halt' && e.seq > d.decision).length, 0, 'no halt before the ruling is delivered');
    // The writer seals again with no new work.
    await f.driver.pass();
    await f.driver.pass();
    const halts = (await f.entries()).filter(e => e.kind === 'halt' && e.seq > d.decision);
    assert.equal(halts.length, 1);
    const h2 = halts[0]!; assert.ok(h2.kind === 'halt');
    assert.ok(h2.reason.includes(`finished ruling follow-up ${rf.send} without submitting a new candidate (writer stopped without a candidate after rebase follow-up ${follow.send})`), h2.reason);
    assert.ok(h2.reason.endsWith(`→ ${command}`), h2.reason);
    assert.equal(f.dsa.sent.length, 1, 'no further send');
  } finally { await f.cleanup(); }
});

test('WS-R4: an unsubmitted unaligned commit gets no second nudge after a ruling follow-up', async () => {
  const f = await fixture();
  try {
    const dispatchBase = await revParse(f.slot.worktree, 'HEAD');
    const rb = await f.rebase(false);
    assert.equal(rb.from, dispatchBase);
    await commitAt(f.slot.worktree, { 'a.txt': 'unaligned work\n' });
    const c = await revParse(f.slot.worktree, 'HEAD');
    assert.notEqual(c, dispatchBase, 'C is outside the handed set');
    assert.equal(await isClean(f.slot.worktree), true);
    assert.equal((await f.entries()).some(e => e.kind === 'submit'), false, 'no lastSubmit');
    const follow = await f.send('rebase', rebaseMessage(await f.state(), 'a'));
    await f.driver.pass();
    let sends = (await f.state()).nodes.a!.runs[0]!.sends;
    const nudge = sends.findLast(x => x.reason === 'submit'); assert.ok(nudge);
    assert.equal(f.dsa.sent.length, 1, 'C gets one submit nudge');
    await f.driver.pass();
    const h1 = (await f.entries()).findLast(e => e.kind === 'halt'); assert.ok(h1?.kind === 'halt');
    assert.ok(h1.reason.includes(`without submitting a candidate after follow-up ${nudge.send}`), h1.reason);
    const text = 'Keep C, rebase it onto the new trunk, then submit.';
    const d = await ops.decide({ cwd: f.cwd, as: parent, nodes: ['a'], text, writer: true, dsa: f.dsa });
    assert.equal(d.resumed, true);
    await f.driver.pass();
    sends = (await f.state()).nodes.a!.runs[0]!.sends;
    const rulings = sends.filter(x => x.reason === 'ruling' && x.sendKind === 'follow-up');
    assert.equal(rulings.length, 1);
    const rf = rulings[0]!;
    assert.ok(rf.seq > Math.max(follow.seq, d.decision));
    assert.equal(f.dsa.sent.length, 2, 'exactly one ruling follow-up');
    assert.ok(f.dsa.sent[1]!.includes(text));
    const rid = f.dsa.view.rid;
    f.dsa.view = { rid, state: 'running' };
    await f.driver.pass();
    assert.equal(f.dsa.sent.length, 2);
    f.dsa.view = { rid, state: 'sealed', status: 'ok', result: 'Still at C; need help.' };
    assert.equal(await revParse(f.slot.worktree, 'HEAD'), c);
    assert.equal(await isClean(f.slot.worktree), true);
    assert.equal((await f.entries()).some(e => e.kind === 'submit'), false);
    await f.driver.pass();
    await f.driver.pass();
    const halts = (await f.entries()).filter(e => e.kind === 'halt' && e.seq > d.decision);
    assert.equal(halts.length, 1, 'seal after the ruling halts once');
    const h2 = halts[0]!; assert.ok(h2.kind === 'halt');
    assert.ok(h2.reason.includes(`finished ruling follow-up ${rf.send} without submitting a new candidate (writer stopped without a candidate after rebase follow-up ${follow.send})`), h2.reason);
    assert.equal(f.dsa.sent.length, 2, 'zero further sends');
    assert.equal((await f.state()).nodes.a!.runs[0]!.sends.filter(x => x.reason === 'submit').length, 1, 'no second nudge');
  } finally { await f.cleanup(); }
});

test('WS-R3: owed rule names a finished writer call: recorded, not sent now, driver delivers, resume if halted', async () => {
  const f = await fixture();
  try {
    const rid = f.dsa.view.rid;
    const out = (await import('../src/answer.ts')).ruleText(await ops.rule({ cwd: f.cwd, as: parent, nodes: ['a'], text: 'Keep the old API.', dsa: f.dsa }));
    const lines = out.split('\n').filter(l => l.startsWith('a: writer call'));
    assert.deepEqual(lines, [`a: writer call ${rid} has finished, so the ruling was recorded but not sent now; the driver delivers it on its next pass; if a is halted, run owed resume a (owed decide records and resumes in one step)`]);
    assert.equal(f.dsa.sent.length, 0, 'rule never sends follow-ups');
    f.dsa.view = { rid, state: 'running' };
    const live = (await import('../src/answer.ts')).ruleText(await ops.rule({ cwd: f.cwd, as: parent, nodes: ['a'], text: 'Live guidance.', dsa: f.dsa }));
    assert.doesNotMatch(live, /has finished/);
    assert.equal(f.dsa.sent.length, 1, 'a running writer is notified as before');
  } finally { await f.cleanup(); }
});

test('WS5: pending rebase with dirty work gets one bounded nudge; running and asking still wait', async () => {
  const f = await fixture();
  try {
    await f.rebase(false);
    await f.send('rebase', rebaseMessage(await f.state(), 'a'));
    const rid = f.dsa.view.rid;
    f.dsa.view = { rid, state: 'running' };
    await f.driver.pass(); assert.equal(f.dsa.sent.length, 0);
    f.dsa.view = { rid, state: 'asking', questions: [{ qid: 'q', rev: 1, question: 'May I rebase?' }] };
    await f.driver.pass(); assert.equal(f.dsa.sent.length, 0);
    assert.equal((await f.entries()).filter(e => e.kind === 'halt').length, 0);
    await writeFile(join(f.slot.worktree, 'a.txt'), 'work remains\n');
    f.dsa.view = { rid, state: 'sealed', status: 'ok', result: 'I left work; need help.' };
    await f.driver.pass();
    assert.equal(f.dsa.sent.length, 1, 'work left behind gets a nudge rather than disappearing');
    assert.match(f.dsa.sent[0]!, /git rebase --onto/);
    assert.ok(f.dsa.sent[0]!.includes(sentence));
    await f.driver.pass();
    const h = (await f.entries()).findLast(e => e.kind === 'halt'); assert.ok(h?.kind === 'halt');
    assert.match(h.reason, /rebase follow-up .*without submitting a candidate after follow-up/);
    assert.ok(h.reason.endsWith(`${says('I left work; need help.')} → ${command}`));
    assert.equal(f.dsa.sent.length, 1, 'single extra nudge only');
  } finally { await f.cleanup(); }
});

test('WS5: unavailable writerWork during pending rebase halts and names the follow-up', async () => {
  const f = await fixture();
  try {
    await f.rebase(false);
    const follow = await f.send('rebase', rebaseMessage(await f.state(), 'a'));
    const s = await f.state(), pending = await rebasePending(s, 'a'); assert.ok(pending);
    const now = Date.parse((await f.entries()).at(-1)!.ts);
    const actions = decide(s, s.plan, new Map([[f.dsa.view.rid, f.dsa.view]]), { max: 1, repairs: 2, root: f.cwd, project: projectId(s), applied: new Set([follow.send]), rejected: new Map(), now, rebasePending: new Map([['a', pending]]) });
    const h = actions.find(a => a.do === 'halt'); assert.ok(h?.do === 'halt', JSON.stringify(actions));
    assert.ok(h.reason.startsWith(`cannot inspect writer worktree after rebase follow-up ${follow.send}`));
    assert.ok(h.reason.endsWith(`${says('Measurements and implementation details. Need the parent to choose the API.')} → ${command}`));
    assert.equal(actions.filter(a => a.do === 'send').length, 0);
  } finally { await f.cleanup(); }
});

test('WS3/WS4: dispatch packet and every follow-up carry decision guidance; dsa questions remain verbatim', async () => {
  const f = await fixture(1);
  try {
    const s = await f.state(), launch = writerLaunch(s, 'a', projectId(s));
    assert.ok(JSON.parse(launch.spec).task.includes(sentence));
    const dispatch = (await f.entries()).find(e => e.kind === 'dispatch'); assert.ok(dispatch?.kind === 'dispatch');
    assert.ok((await (await Ledger.open(f.cwd)).getBlob(dispatch.packet)).toString().includes(sentence));
    await commitAt(f.slot.worktree, { 'a.txt': 'candidate\n' });
    await ops.submit({ cwd: f.slot.worktree, as: writer, node: 'a' });
    await ops.review({ cwd: f.cwd, as: { role: 'reviewer', id: 'independent' }, node: 'a', verdict: 'block', rank: 1, note: 'fix API' });
    assert.ok((await f.rebase()).packet.includes(sentence), 'manual rebase packet includes the writer boundary');
    await ops.rule({ cwd: f.cwd, as: parent, nodes: ['a'], text: 'Use API v2' });
    const current = await f.state();
    const messages = [submitMessage('a'), planChangedMessage('a', 99, ['brief']), rebaseMessage(current, 'a'), repairFollowUp(current, 'a').message, resubmitFollowUp(current, 'a').message, rulingFollowUp(current, 'a')!.message, rulingMessage('a', 'writer', current.rules)];
    for (const message of messages) assert.ok(message.includes(sentence), message);
    assert.ok(!rulingMessage('a', 'reviewer', current.rules).includes(sentence), 'reviewer guidance is unchanged');
    const question = 'Which API? A semicolon; and a newline\nare part of my question.';
    f.dsa.view = { rid: f.dsa.view.rid, state: 'asking', questions: [{ qid: 'q1', rev: 1, question }] };
    const pass = await f.driver.pass();
    assert.ok(pass.actions.some(a => a.do === 'notify' && a.text?.includes(question.replace(/\n/g, '\\n'))), JSON.stringify(pass.actions));
    assert.deepEqual(f.dsa.sent, []);
    assert.ok(f.follower.tick()!.includes('Which API? A semicolon; and a newline'), 'question path still wakes');
  } finally { await f.cleanup(); }
});
