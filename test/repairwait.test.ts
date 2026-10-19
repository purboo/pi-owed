// RW1–RW2: real owed slots, fake dsa replies only; no live durable-subagents service.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import { activity, needs } from '../src/needs.ts';
import { assembleRuntime } from '../src/activity.ts';
import { Dsa } from '../src/dsa.ts';
import { Driver, procStart } from '../src/drive-run.ts';
import { Follower } from '../src/drive-bg.ts';
import { decide, writerLaunch, type DriveOpts } from '../src/drive.ts';
import { Ledger } from '../src/ledger.ts';
import { entriesOf, projectId } from '../src/reducer.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';
import type { RunView, SendReason, State } from '../src/types.ts';

const parent = { role: 'parent', id: 'test' } as const;
const owner = { role: 'owner', id: 'test' } as const;
const writer = { role: 'writer', id: 'a#1' } as const;
const request = '01M58TRNPPEHT5RJD6CEXR7EH0';
const awaiting: NonNullable<RunView['awaiting']> = [{ request, state: 'running' }];

class FakeDsa extends Dsa {
  gen = 3; // A caller-wake generation may be newer than the recorded owed follow-up (gen2).
  sent: string[] = [];
  views = new Map<string, RunView>();
  readonly writerRid: string;
  constructor(writerRid: string) {
    super({ bin: process.execPath });
    this.writerRid = writerRid;
    this.views.set(writerRid, { rid: writerRid, state: 'sealed', status: 'ok', result: 'waiting for durable check', awaiting });
  }
  get writer() { return this.views.get(this.writerRid)!; }
  override async inspect(rid: string) { return { view: this.views.get(rid)!, gen: this.gen }; }
  override async request() { return { state: 'applied' as const }; }
  override async send(id: string) {
    this.sent.push(id);
    return { outcome: 'applied' as const, generation: 2, spec_digest: 'fixture' };
  }
}

async function fixture(block = true, repairs?: number) {
  const r = await repo();
  const plan = { version: 1, trunk: 'main', lease: false, closure: [], invariants: [], ...(repairs !== undefined ? { drive: { repairs } } : {}), nodes: [{ id: 'a', writes: ['a.txt'], checks: [], review: { count: 1, min_rank: 1 } }] };
  await commitAt(r.cwd, { 'plan.json': JSON.stringify(plan), 'a.txt': 'base' });
  await ops.init({ cwd: r.cwd, as: owner, channel: 'flag', plan: JSON.stringify(plan) });
  const slot = await ops.dispatch({ ...r, as: parent, node: 'a' });
  const state = async () => (await ops.readState(r)).state;
  const s = await state(), launch = writerLaunch(s, 'a', projectId(s));
  await ops.launch({ ...r, as: parent, ...launch });
  await commitAt(slot.worktree, { 'a.txt': 'candidate' });
  const submit = () => ops.submit({ cwd: slot.worktree, as: writer, node: 'a' });
  await submit();
  await ops.attest({ cwd: r.cwd, node: 'a' });
  if (block) await ops.review({ ...r, as: { role: 'reviewer', id: 'independent' }, node: 'a', verdict: 'block', rank: 1, note: 'fix API' });
  const dsa = new FakeDsa(launch.rid), ledger = await Ledger.open(r.cwd), log = join(r.root, 'driver.jsonl');
  await writeFile(log, '');
  const driver = new Driver({ cwd: r.cwd, dsa, session: null, json: true, log: l => appendFileSync(log, l + '\n') });
  const send = (reason: SendReason, rulings?: number) => ops.send({ ...r, as: parent, node: 'a', attempt: 1, rid: launch.rid, sendKind: 'follow-up', reason, message: `apply ${reason}`, ...(rulings !== undefined ? { rulings } : {}) });
  const policy = async (options: Partial<DriveOpts> = {}, snapshot?: State) => {
    const s = snapshot ?? await state();
    return decide(s, s.plan, dsa.views, { max: 1, repairs: 2, project: projectId(s), root: r.cwd, applied: new Set(s.nodes.a!.runs[0]!.sends.map(x => x.send)), rejected: new Map(), ...options }).filter(a => a.node === 'a');
  };
  const runtime = async () => assembleRuntime({ cwd: r.cwd, state: await state(), driverRunning: true });
  return { ...r, slot, state, launch, submit, send, dsa, ledger, driver, log, policy, runtime };
}

for (const seal of ['sealed', 'pruned'] as const) test(`RW1/RW2 #18776 ${seal}: repair with candidate waits, no need or parent wake; wake seal restores halt`, async () => {
  const f = await fixture();
  try {
    const repair = await f.send('repair');
    f.dsa.writer.state = seal;
    f.dsa.writer.sealedAt = Date.now() - 65_000;
    assert.deepEqual(await f.policy(), [], 'outstanding repair cannot halt while awaiting');
    await f.driver.pass();
    const s = await f.state(), rt = await f.runtime();
    assert.deepEqual(needs(s, 'a', rt), []);
    assert.equal(rt.writerWaiting?.length, 1);
    assert.deepEqual(rt.writerWaiting![0]!.awaiting, awaiting);
    assert.equal(activity(s, 'a', rt)?.phase, 'waiting');
    assert.match(activity(s, 'a', rt)!.text, new RegExp(`writer waiting on durable ${request} \\(running, \\d+s\\)`));
    const rows = JSON.parse(await readFile(join(f.ledger.dir, 'drive', 'writer-waiting.json'), 'utf8'));
    assert.equal(rows[0].rid, f.launch.rid, 'driver publishes the current attempt writer');
    const lock = join(f.ledger.dir, 'drive.lock');
    await writeFile(lock, JSON.stringify({ pid: process.pid, start: procStart(process.pid), host: hostname(), at: new Date().toISOString(), token: 'fixture' }));
    try {
      for (const args of [['status'], ['why', 'a']]) {
        const output = await cli(f.cwd, args);
        assert.equal(output.code, 0, output.stderr);
        assert.ok(output.stdout.includes(`writer waiting on durable ${request}`), output.stdout);
        assert.doesNotMatch(output.stdout, /Needs you \([1-9]/);
      }
      const follower = new Follower({ log: f.log, repo: f.cwd, pid: process.pid, start: procStart(process.pid), deliver() { assert.fail('waiting cannot wake the parent'); } });
      assert.equal(await follower.step(), undefined);
    } finally { await rm(lock); }
    assert.equal(entriesOf(s).some(e => e.kind === 'halt'), false);
    f.dsa.gen++;
    f.dsa.writer.state = 'running';
    delete f.dsa.writer.awaiting;
    await f.driver.pass();
    assert.deepEqual((await f.runtime()).writerWaiting, [], 'wake generation running clears waiting display');
    f.dsa.writer.state = 'sealed';
    f.dsa.writer.result = 'wake finished without submitting';
    await f.driver.pass();
    const h = entriesOf(await f.state()).findLast(e => e.kind === 'halt');
    assert.ok(h?.kind === 'halt');
    assert.ok(h.reason.includes(`finished repair follow-up ${repair.send} without submitting a new candidate`));
    assert.ok(h.reason.includes('wake finished without submitting'));
    assert.equal(f.dsa.sent.length, 1, 'foreign wake does not replay the recorded follow-up after recovery');
  } finally { await f.cleanup(); }
});

test('RW1 absent or empty awaiting retains the exact candidate repair no-submit halt', async () => {
  const f = await fixture();
  try {
    const repair = await f.send('repair'), s = await f.state(), block = s.nodes.a!.blocks.find(b => b.state === 'active')!;
    for (const value of [undefined, []]) {
      f.dsa.writer.awaiting = value;
      const actions = await f.policy(), h = actions[0];
      assert.equal(actions.length, 1); assert.ok(h?.do === 'halt');
      assert.equal(h.reason, `writer run ${f.launch.rid} finished repair follow-up ${repair.send} without submitting a new candidate (review block #${block.seq} review); writer says: "waiting for durable check" → owed decide a --text "<ruling>" --writer`);
    }
  } finally { await f.cleanup(); }
});

test('RW1 non-ok seal with candidate and awaiting retains the non-ok halt and durable diagnostic', async () => {
  const f = await fixture();
  try {
    await f.send('repair');
    for (const seal of ['sealed', 'pruned'] as const) {
      f.dsa.writer.state = seal; f.dsa.writer.status = 'failed';
      const h = (await f.policy())[0]; assert.ok(h?.do === 'halt');
      assert.equal(h.reason, `writer run ${f.launch.rid} sealed failed; writer says: "waiting for durable check"; awaiting durable ${request} (running) → owed decide a --text "<ruling>" --writer`);
    }
    await f.driver.pass();
    assert.deepEqual((await f.runtime()).writerWaiting, []);
    assert.ok(needs(await f.state(), 'a').length > 0, 'non-ok still needs recovery');
  } finally { await f.cleanup(); }
});

test('RW1/RW2 ruling turn with current candidate: due follow-up still sent, then waits instead of no-submit halt', async () => {
  const f = await fixture(true, 0);
  try {
    const candidate = (await f.state()).nodes.a!.candidate!;
    await ops.rule({ ...f, as: parent, nodes: ['a'], writer: false, text: 'clarify API v2' });
    const rule = (await f.state()).rules.at(-1)!;
    assert.equal((await f.state()).nodes.a!.candidate!.seq, candidate.seq, 'ordinary named ruling preserves the candidate');
    const due = (await f.policy({ repairs: 0 }))[0];
    assert.ok(due?.do === 'send' && due.reason === 'ruling', 'due ruling goes before the wait');
    await f.send('ruling', rule.seq);
    assert.deepEqual(await f.policy({ repairs: 0 }), []);
    await f.driver.pass();
    const s = await f.state(), rt = await f.runtime();
    assert.equal(s.nodes.a!.candidate!.seq, candidate.seq, 'ruling follow-up keeps the same candidate');
    assert.ok(s.nodes.a!.blocks.some(b => b.state === 'active' && b.key === candidate.keys[b.obligation]));
    assert.equal(activity(s, 'a', rt)?.phase, 'waiting', 'ruling alone qualifies the candidate display');
    assert.deepEqual(needs(s, 'a', rt), []);
    delete f.dsa.writer.awaiting;
    const h = (await f.policy({ repairs: 0 }))[0]; assert.ok(h?.do === 'halt');
    assert.ok(h.reason.startsWith(`repairs exhausted (0 of 0 since ruling #${rule.seq})`), 'non-writer ruling does not substitute the old no-submit cause');
  } finally { await f.cleanup(); }
});

test('RW1 writer:true ruling still clears the candidate and retains the baseline candidate-free wait', async () => {
  const f = await fixture();
  try {
    assert.ok((await f.state()).nodes.a!.candidate);
    await ops.rule({ ...f, as: parent, nodes: ['a'], writer: true, text: 'apply API v2' });
    const rule = (await f.state()).rules.at(-1)!;
    assert.equal((await f.state()).nodes.a!.candidate, undefined);
    const due = (await f.policy({ repairs: 0 }))[0];
    assert.ok(due?.do === 'send' && due.reason === 'ruling');
    const ruling = await f.send('ruling', rule.seq);
    assert.deepEqual(await f.policy({ repairs: 0 }), []);
    delete f.dsa.writer.awaiting;
    const h = (await f.policy({ repairs: 0 }))[0]; assert.ok(h?.do === 'halt');
    assert.ok(h.reason.includes(`finished ruling follow-up ${ruling.send} without submitting a new candidate`));
  } finally { await f.cleanup(); }
});

test('RW2 candidate under review without a newer writer repair/ruling retains its phase and driver decision', async () => {
  const f = await fixture(false);
  try {
    const due = (await f.policy())[0]; assert.ok(due?.do === 'launch' && due.role === 'reviewer');
    await ops.launch({ ...f, as: parent, ...due });
    f.dsa.views.set(due.rid, { rid: due.rid, state: 'running' });
    const before = await f.policy();
    assert.deepEqual(before, []);
    await f.driver.pass();
    const s = await f.state(), rt = await f.runtime();
    assert.deepEqual(rt.writerWaiting, []);
    assert.equal(activity(s, 'a', rt)?.phase, 'reviewing');
    delete f.dsa.writer.awaiting;
    assert.deepEqual(await f.policy(), before, 'durable awaiting changes no review decision');
    f.dsa.writer.awaiting = awaiting;
    // Stale runtime data must not change the phase after a new candidate or for the wrong writer/kind.
    const row = { node: 'a', attempt: 1, rid: f.launch.rid, since: Date.now(), awaiting };
    const runtime = { driverRunning: true, writerWaiting: [row] };
    for (const shape of ['before-submit', 'reviewer', 'notify', 'rebase'] as const) {
      const snapshot = await f.state(), ar = snapshot.nodes.a!.runs[0]!, candidate = snapshot.nodes.a!.candidate!;
      ar.sends.push({ kind: 'send', seq: shape === 'before-submit' ? candidate.seq - 1 : candidate.seq + 1, ts: new Date().toISOString(), prev: '', hash: 'fake', by: 'parent:drive', node: 'a', attempt: 1, rid: shape === 'reviewer' ? due.rid : f.launch.rid, send: 'fake', sendKind: shape === 'notify' ? 'notify' : 'follow-up', reason: shape === 'rebase' ? 'rebase' : 'repair', message: 'fake' });
      assert.equal(activity(snapshot, 'a', runtime)?.phase, 'reviewing', shape);
    }
    await f.send('repair');
    await f.driver.pass();
    assert.equal((await f.runtime()).writerWaiting?.length, 1);
    await f.submit();
    await f.driver.pass();
    assert.deepEqual((await f.runtime()).writerWaiting, [], 'new submit invalidates old follow-up eligibility');
  } finally { await f.cleanup(); }
});

test('RW1 candidate repairs exhausted: awaits without halt; absent/empty awaiting restores exact exhausted halt', async () => {
  const f = await fixture();
  try {
    const first = (await f.policy())[0]; assert.ok(first?.do === 'send' && first.reason === 'repair', 'due repair goes before waiting');
    await f.send('repair');
    await f.submit(); // Same-key candidate retains the block, but the repair belongs to the previous submit.
    const s = await f.state(), block = s.nodes.a!.blocks.find(b => b.state === 'active')!;
    assert.deepEqual(await f.policy({ repairs: 1 }), [], 'exhausted repair budget waits with a candidate');
    for (const value of [undefined, []]) {
      f.dsa.writer.awaiting = value;
      const h = (await f.policy({ repairs: 1 }))[0]; assert.ok(h?.do === 'halt');
      assert.equal(h.reason, `repairs exhausted (1 of 1 since dispatch): review block #${block.seq} review; writer says: "waiting for durable check" → owed decide a --text "<ruling>" --writer`);
    }
  } finally { await f.cleanup(); }
});

test('RW1 row8 remains candidate-free: plan invalidation preserves the baseline submit-reminder wait', async () => {
  const f = await fixture(false);
  try {
    const before = await f.state();
    assert.ok(before.nodes.a!.candidate);
    assert.ok((await f.policy()).every(a => a.do !== 'send' || a.reason !== 'submit'));
    const next = structuredClone(before.plan);
    next.nodes[0]!.brief = 'new API requirement';
    const changed = await ops.planSet({ cwd: f.cwd, as: parent, plan: JSON.stringify(next), note: 'invalidate submitted brief' });
    assert.equal((await f.state()).nodes.a!.candidate, undefined, 'plan invalidation removes the current candidate');
    assert.deepEqual(await f.policy(), [], 'the existing candidate-free durable wait remains');
    delete f.dsa.writer.awaiting;
    const due = (await f.policy())[0];
    assert.ok(due?.do === 'send' && due.reason === 'submit');
    assert.ok(due.message.includes(`plan #${changed.seq} changed this node's spec (brief); resubmit`));
  } finally { await f.cleanup(); }
});

test('RW1 current-candidate rebase drift: due follow-up remains, awaiting suppresses only its no-submit halt', async () => {
  const f = await fixture(false);
  try {
    const c = (await f.state()).nodes.a!.candidate!, drift = { head: c.commit, base: c.base, upstream: c.base, command: `git rebase --onto ${c.base} ${c.base}` };
    const opts = { rebasePending: new Map([['a', drift]]) };
    const first = (await f.policy(opts))[0]; assert.ok(first?.do === 'send' && first.reason === 'rebase');
    const rebase = await f.send('rebase');
    assert.deepEqual(await f.policy(opts), []);
    delete f.dsa.writer.awaiting;
    const h = (await f.policy(opts))[0]; assert.ok(h?.do === 'halt');
    assert.ok(h.reason.includes(`cannot inspect writer worktree after rebase follow-up ${rebase.send}`));
  } finally { await f.cleanup(); }
});
