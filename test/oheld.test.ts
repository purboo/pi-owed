// HD1–HD2: real decision/replay surfaces and follower revalidation; dsa is always fake.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { activity, needs, repoNeeds, needId } from '../src/needs.ts';
import { briefView, receipt, renderBrief, renderReceipt, renderStatus, renderWhy, statusView } from '../src/views.ts';
import { halted, projectId } from '../src/reducer.ts';
import { Driver, procStart, type ActionReport } from '../src/drive-run.ts';
import { Follower, revalidator } from '../src/drive-bg.ts';
import { writerLaunch } from '../src/drive.ts';
import { Dsa, type SendResult } from '../src/dsa.ts';
import type { RunView } from '../src/types.ts';
import owed from '../src/extension.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const parent = { role: 'parent', id: 'test' } as const;
const owner = { role: 'owner', id: 'pi' } as const;
const writer = { role: 'writer', id: 'a#1' } as const;
const stopped = 'writer run fixture sealed ok without submitting; writer says: "Need a decision" → owed decide a --text "<ruling>" --writer';
class Client extends Dsa {
  views = new Map<string, RunView>();
  sent: string[] = [];
  constructor() { super({ bin: '/bin/true' }); }
  override async describe(rid: string): Promise<RunView> { return this.views.get(rid) ?? { rid, state: 'sealed', status: 'ok' }; }
  override async inspect(rid: string) { return { view: await this.describe(rid) }; }
  override async request() { return { state: 'applied' as const }; }
  override async send(_id: string, _rid: string, kind: string): Promise<SendResult> { this.sent.push(kind); return { outcome: 'applied', spec_digest: 'fake' }; }
}
async function fixture(extra = {}, planExtra = {}) {
  const r = await repo(); await r.commit();
  await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', measure: false, plan: JSON.stringify({ version: 1, trunk: 'main', lease: false, closure: [], invariants: [], nodes: [{ id: 'a', writes: ['a.txt'], checks: [], review: { count: 0, min_rank: 1 }, ...extra }, { id: 'b', writes: ['b.txt'], checks: [], review: { count: 0, min_rank: 1 } }], ...planExtra }) });
  const slot = await ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' }), dsa = new Client();
  const state = async () => (await ops.readState(r)).state;
  const halt = (reason = 'resource unavailable', need: 'human' | 'owner' = 'human') => ops.halt({ cwd: r.cwd, as: { role: 'parent', id: 'drive' }, node: 'a', attempt: 1, reason, needs: need });
  const hold = () => ops.decide({ cwd: r.cwd, as: parent, nodes: ['a'], text: 'Wait here intentionally', resume: false, dsa });
  const submit = async () => { await commitAt(slot.worktree, { 'a.txt': 'candidate' }); return ops.submit({ cwd: slot.worktree, as: writer, node: 'a' }); };
  return { ...r, slot, dsa, state, halt, hold, submit };
}
const heldText = (seq: number) => `held by ruling #${seq}; owed resume a releases it`;

for (const reason of ['resource unavailable', stopped]) test(`HD1: decide --no-resume suppresses only the halt need (${reason === stopped ? 'writer-stop' : 'resume'})`, async () => {
  const f = await fixture();
  try {
    const h = await f.halt(reason), before = await f.state();
    assert.equal(needs(before, 'a')[0]?.kind, reason === stopped ? 'decide' : 'resume');
    const r = await f.hold(), s = await f.state();
    assert.deepEqual(r.entries.map(e => e.kind), ['rule']);
    assert.equal(halted(s, 'a')?.seq, h.seq);
    assert.deepEqual(needs(s, 'a'), []);
    assert.deepEqual(activity(s, 'a'), { node: 'a', phase: 'held', text: heldText(r.rule.seq) });
    assert.equal((await ops.verify(f)).ok, true);
    assert.equal(ops.decideText(r).includes('; resumed'), false);
    const next = await f.hold();
    assert.equal(activity(await f.state(), 'a')?.text, heldText(next.rule.seq));
  } finally { await f.cleanup(); }
});

test('HD1: independent owner obligations and debt retain their exact needs under a held halt', async () => {
  const f = await fixture({ approve: 'owner', evidence: [{ id: 'proof', what: 'owner proof', by: 'owner' }], checks: [{ id: 'waived', run: 'true', reads: ['a.txt'] }] });
  try {
    await f.submit();
    await ops.waive({ cwd: f.cwd, as: owner, channel: 'delegated', node: 'a', obligation: 'check:waived', reason: 'owner accepts this measurement debt' });
    await f.halt('owner action required', 'owner');
    const beforeDebt = (await ops.status(f)).summary!.debt;
    assert.ok(beforeDebt.some(d => d.includes('a/check:waived: waived')));
    const before = needs(await f.state(), 'a');
    assert.deepEqual(before.map(n => n.kind), ['approve', 'evidence']);
    const r = await f.hold(), s = await f.state();
    assert.deepEqual(needs(s, 'a'), before);
    assert.equal(activity(s, 'a')?.text, heldText(r.rule.seq));
    for (const output of [renderStatus(await ops.status(f)), renderBrief(await ops.brief(f)), renderWhy(await ops.why({ cwd: f.cwd, node: 'a' }))]) {
      for (const n of before) assert.ok(output.includes(n.command!), output);
    }
    assert.match(renderWhy(await ops.why({ cwd: f.cwd, node: 'a' })), new RegExp(`^a: held by ruling #${r.rule.seq}`));
    assert.deepEqual((await ops.status(f)).summary!.debt, beforeDebt);
    assert.deepEqual(repoNeeds(s), []);
  } finally { await f.cleanup(); }
});

test('HD1/R-029-1: ordinary named rules clear the halt; prospective, * and earlier decisions do not hold it', async () => {
  for (const variant of ['ordinary', 'prospective', '*', 'before', 'other-node']) {
    const f = await fixture();
    try {
      if (variant === 'before') await f.hold();
      await f.halt();
      if (variant === 'other-node') await ops.decide({ cwd: f.cwd, as: parent, nodes: ['b'], text: 'Other node', resume: false, dsa: f.dsa });
      else if (variant !== 'before') await ops.rule({ cwd: f.cwd, as: parent, nodes: variant === '*' ? '*' : ['a'], text: 'Guidance', ...(variant === 'prospective' ? { prospective: true } : {}), dsa: f.dsa });
      const s = await f.state();
      if (variant === 'ordinary') { assert.equal(halted(s, 'a'), undefined); assert.deepEqual(needs(s, 'a'), []); }
      else { assert.ok(halted(s, 'a')); assert.equal(needs(s, 'a')[0]?.kind, 'resume', variant); }
      assert.equal(activity(s, 'a')?.text.includes('held by ruling #'), false, variant);
    } finally { await f.cleanup(); }
  }
});

test('HD1: resume, submit, standalone rule and a new attempt release the decision hold; a new halt is not held', async () => {
  for (const variant of ['resume', 'submit', 'rule', 'attempt']) {
    const f = await fixture();
    try {
      await f.halt(); await f.hold(); assert.deepEqual(needs(await f.state(), 'a'), []);
      if (variant === 'resume') await ops.resume({ cwd: f.cwd, as: parent, node: 'a' });
      else if (variant === 'submit') await f.submit();
      else if (variant === 'rule') await ops.rule({ cwd: f.cwd, as: parent, nodes: ['a'], text: 'Continue', dsa: f.dsa });
      else { await ops.abandon({ cwd: f.cwd, as: parent, node: 'a', reason: 'new attempt' }); await ops.dispatch({ cwd: f.cwd, as: parent, node: 'a' }); }
      const s = await f.state(); assert.equal(halted(s, 'a'), undefined); assert.equal(activity(s, 'a')?.text.includes('held by ruling #'), false);
      if (variant !== 'attempt') { await f.halt('new failure'); assert.equal(needs(await f.state(), 'a')[0]?.kind, 'resume'); }
    } finally { await f.cleanup(); }
  }
});

test('HD1: dependencies, later plans, and executor/driver entries cannot disguise or release an intentional hold', async () => {
  const f = await fixture();
  try {
    await f.halt(); const r = await f.hold(), ledger = await Ledger.open(f.cwd);
    await ledger.withLock(() => ledger.append([{ kind: 'note', by: 'executor:owed', text: 'observation, not recovery' }]));
    const s = await f.state(), plan = structuredClone(s.plan); plan.nodes[0]!.deps = ['b']; plan.nodes[0]!.later = true;
    await ops.planSet({ cwd: f.cwd, as: parent, plan: JSON.stringify(plan) });
    assert.deepEqual(needs(await f.state(), 'a'), []);
    assert.equal(activity(await f.state(), 'a')?.text, heldText(r.rule.seq));
    assert.ok(renderStatus(await ops.status(f)).includes(`a: ${heldText(r.rule.seq)}`));
  } finally { await f.cleanup(); }
});

for (const full of [false, true]) test(`HD2: status, why and receipt (${full ? 'full' : 'compact'}) show held progress and explicit release`, async () => {
  const f = await fixture();
  try {
    await f.halt('owner halt with no independent obligation', 'owner'); const r = await f.hold();
    const { state: s, entries } = await ops.readState(f), v = statusView(s, entries), card = receipt(s, entries, 'a');
    assert.deepEqual(v.summary?.needs.filter(n => n.node === 'a'), []);
    assert.equal(v.summary?.progress.find(p => p.node === 'a')?.phase, heldText(r.rule.seq));
    assert.equal(v.pending.owner!.some(i => i.obligation === 'driver-halt'), false);
    const status = renderStatus(v, { full });
    assert.ok(status.includes(`a: ${heldText(r.rule.seq)}`), status);
    assert.ok(status.indexOf('In progress') < status.indexOf(`a: ${heldText(r.rule.seq)}`), status);
    assert.doesNotMatch(status, /needs the (parent|owner)|Halted \(driver\):/);
    for (const output of [renderWhy(card, { full }), renderReceipt(card, { full })]) {
      assert.match(output, new RegExp(`^a: held by ruling #${r.rule.seq}`));
      assert.ok(output.includes('Next: owed resume a'), output);
      assert.doesNotMatch(output, /needs the (parent|owner)/);
    }
    assert.equal(card.halt?.reason, 'owner halt with no independent obligation'); // Original evidence stays recorded.
  } finally { await f.cleanup(); }
});

test('HD2: brief, CLI and pi status/why plus /owed all follow the held needs and activity', async () => {
  const f = await fixture();
  const tools = new Map<string, ToolDefinition>(), commands = new Map<string, { handler: (args: string, ctx: any) => Promise<void> }>();
  const handlers = new Map<string, any>(), notices: string[] = [];
  const ctx = { cwd: f.cwd, hasUI: false, isIdle: () => true, ui: { notify: (text: string) => notices.push(text) } };
  try {
    const h = await f.halt(stopped);
    const result = await cli(f.cwd, ['decide', 'a', '--text', 'Stay held', '--no-resume', '--as', 'owner:pi']);
    assert.equal(result.code, 0, result.stderr);
    const { state: s, entries } = await ops.readState(f), rule = entries.findLast(e => e.kind === 'rule')!;
    assert.equal(halted(s, 'a')?.seq, h.seq); assert.deepEqual(needs(s, 'a'), []);
    const brief = renderBrief(briefView(s, entries)); assert.ok(brief.includes(`a: ${heldText(rule.seq)}`), brief);
    for (const args of [['status'], ['status', '--full'], ['brief'], ['why', 'a'], ['why', 'a', '--full']]) {
      const output = await cli(f.cwd, args); assert.equal(output.code, 0, output.stderr);
      assert.ok(output.stdout.includes(`held by ruling #${rule.seq}`), output.stdout);
      assert.doesNotMatch(output.stdout, /Needs you: a|needs the (parent|owner)/);
    }
    owed({ registerTool: (t: ToolDefinition) => tools.set(t.name, t), registerCommand: (name: string, command: any) => commands.set(name, command), on: (name: string, handler: any) => handlers.set(name, handler), sendMessage() {} } as unknown as ExtensionAPI);
    for (const [name, args] of [['status', {}], ['status', { full: true }], ['brief', {}], ['why', { node: 'a' }], ['why', { node: 'a', full: true }]] as const) {
      const output = await tools.get(`owed_${name}`)!.execute('test', { ...args, cwd: f.cwd }, undefined, undefined, ctx as any);
      assert.notEqual(output.isError, true);
      const text = output.content.filter(c => c.type === 'text').map(c => c.text).join('\n');
      assert.ok(text.includes(`held by ruling #${rule.seq}`), text);
    }
    await commands.get('owed')!.handler('', ctx); await commands.get('owed')!.handler('why a', ctx);
    assert.equal(notices.length, 2); for (const text of notices) assert.ok(text.includes(`held by ruling #${rule.seq}`), text);
  } finally { await handlers.get('session_shutdown')?.({}, ctx); await f.cleanup(); }
});

test('HD2: queued follower halt wake disappears after the decision; later driver passes do not wake for the hold', async () => {
  const f = await fixture(), lines: ActionReport[] = [], delivered: string[] = [];
  const dir = join(process.env.OWED_DIR!, 'drive'), log = join(dir, 'log.jsonl');
  await mkdir(dir, { recursive: true }); await writeFile(log, '');
  const s = await f.state(), launch = writerLaunch(s, 'a', projectId(s)); await ops.launch({ cwd: f.cwd, as: parent, ...launch });
  const driver = new Driver({ cwd: f.cwd, dsa: f.dsa, json: true, session: null, handleSignals: false, log: text => { lines.push(JSON.parse(text)); appendFileSync(log, text + '\n'); } });
  let busy = true;
  const follower = new Follower({ log, repo: f.cwd, pid: process.pid, start: procStart(process.pid), from: 0, busy: () => busy, revalidate: revalidator({ cwd: f.cwd, dsa: f.dsa }), deliver: text => delivered.push(text) });
  try {
    await driver.pass(); assert.ok(lines.some(l => l.do === 'halt' && l.need?.kind === 'decide'), JSON.stringify(lines));
    assert.equal(await follower.step(), undefined);
    await f.hold(); busy = false;
    assert.equal(await follower.step(), undefined);
    assert.deepEqual(delivered, []);
    const before = lines.length; await driver.pass();
    assert.equal(lines.slice(before).some(l => l.do === 'halt' || l.do === 'notify'), false);
    assert.deepEqual(f.dsa.sent, []);
  } finally { follower.stop(); driver.abort.abort(); await driver.settle(); await f.cleanup(); }
});

test('HD2: null post-halt race reports and stale structured halt identities are revalidated too', async () => {
  const f = await fixture();
  const log = join(f.root, 'race.jsonl'), delivered: string[] = [];
  try {
    const h = await f.halt(), n = needs(await f.state(), 'a')[0]!;
    await f.hold();
    for (const facts of [h.seq, undefined]) {
      await writeFile(log, JSON.stringify({ do: 'halt', node: 'a', outcome: 'halted', ...(facts === undefined ? {} : { facts }), need: null, detail: h.reason }) + '\n');
      const follower = new Follower({ log, repo: f.cwd, pid: process.pid, from: 0, busy: () => false, revalidate: revalidator({ cwd: f.cwd, dsa: f.dsa }), deliver: text => delivered.push(text) });
      try { assert.equal(await follower.step(), undefined); assert.deepEqual(delivered, []); } finally { follower.stop(); }
    }
    // A stale structured halt identity is independently rejected, not only by its fact mark.
    const check = { need: n, needId: needId(n) };
    assert.deepEqual(await revalidator({ cwd: f.cwd, dsa: f.dsa })([check]), [false]);
  } finally { await f.cleanup(); }
});

test('HD2/HD1: an unanswered writer question still wakes while its node is held', async () => {
  const f = await fixture(), lines: ActionReport[] = [];
  let driver: Driver | undefined;
  try {
    const s = await f.state(), launch = writerLaunch(s, 'a', projectId(s)); await ops.launch({ cwd: f.cwd, as: parent, ...launch });
    await f.halt(); const r = await f.hold();
    f.dsa.views.set(launch.rid, { rid: launch.rid, state: 'asking', questions: [{ qid: 'choice', rev: 1, question: 'Which new interface?' }] });
    driver = new Driver({ cwd: f.cwd, dsa: f.dsa, json: true, session: null, handleSignals: false, log: text => lines.push(JSON.parse(text)) });
    await driver.pass();
    assert.ok(lines.some(l => l.do === 'notify' && l.qid === 'choice' && l.text?.includes('Which new interface?')), JSON.stringify(lines));
    assert.equal(activity(await f.state(), 'a')?.text, heldText(r.rule.seq));
    assert.ok(halted(await f.state(), 'a'));
  } finally { if (driver) { driver.abort.abort(); await driver.settle(); } await f.cleanup(); }
});
