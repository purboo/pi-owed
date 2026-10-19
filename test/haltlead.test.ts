// HL1–HL2: real ledger/driver/follower surfaces, with fake dsa replies only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import { needs, itemLine } from '../src/needs.ts';
import { renderStatus, renderWhy } from '../src/views.ts';
import { Driver, procStart, type ActionReport } from '../src/drive-run.ts';
import { Follower } from '../src/drive-bg.ts';
import { writerLaunch } from '../src/drive.ts';
import { projectId } from '../src/reducer.ts';
import { Dsa } from '../src/dsa.ts';
import type { RunView } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { commitAt } from './helpers/surface.ts';

const parent = { role: 'parent', id: 'test' } as const;
const command = 'owed decide a --text "<ruling>" --writer';
const quote = 'writer says: "Repair checks need a decision"';
const stopped = `writer run fixture finished repair follow-up repair without submitting a new candidate; ${quote} → ${command}`;
class Client extends Dsa {
  constructor() { super({ bin: '/bin/true' }); }
  override async describe(rid: string): Promise<RunView> { return { rid, state: 'sealed', status: 'ok', result: 'Repair checks need a decision' }; }
  override async inspect(rid: string) { return { view: await this.describe(rid) }; }
  override async request() { return { state: 'applied' as const }; }
  override async send() { return { outcome: 'applied' as const, spec_digest: 'fake' }; }
}
async function fixture(obligation: 'review' | 'closure-review' = 'review', driverAuthored = false) {
  const r = await repo();
  await commitAt(r.cwd, { 'a.txt': 'base' });
  await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'pi' }, channel: 'delegated', plan: JSON.stringify({ version: 1, trunk: 'main', lease: false, closure: obligation === 'closure-review' ? ['a.txt'] : [], invariants: [], nodes: [{ id: 'a', writes: ['a.txt'], checks: [], review: { count: 1, min_rank: 1 }, approve: 'owner' }] }) });
  const slot = await ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' });
  const submit = async (value: string) => { await commitAt(slot.worktree, { 'a.txt': value }); return ops.submit({ cwd: slot.worktree, as: { role: 'writer', id: 'a#1' }, node: 'a' }); };
  await submit('one'); await ops.attest({ cwd: r.cwd, node: 'a' });
  const block = (id: string, guidance = false) => ops.review({ cwd: r.cwd, as: { role: 'reviewer', id: driverAuthored ? 'drive-a-1-1' : id }, node: 'a', obligation, verdict: 'block', rank: 2, note: 'choose the repair', ...(guidance ? { needs: 'parent' as const } : {}), ack_rulings: 'latest' });
  const old = await block('old');
  await submit('two'); await ops.attest({ cwd: r.cwd, node: 'a' });
  const halt = (reason = stopped) => ops.halt({ cwd: r.cwd, as: parent, node: 'a', attempt: 1, reason, needs: 'human' });
  return { ...r, slot, submit, block, old, halt, state: async () => (await ops.readState(r)).state };
}

for (const obligation of ['review', 'closure-review'] as const) test(`HL1/HL2 #18776: halt leads and current ${obligation} block suppresses stale repair and owner OK`, async () => {
  const f = await fixture(obligation);
  try {
    const current = await f.block('current'); const h = await f.halt(), s = await f.state(), ns = needs(s, 'a');
    assert.equal(s.nodes.a!.blocks.find(b => b.seq === current.seq)?.state, 'active');
    assert.deepEqual(ns[0], { node: 'a', actor: 'parent', kind: 'decide', since: h.seq, halted: true, text: quote, command, alternatives: ['owed resume a'] });
    const review = ns.find(n => n.obligation === obligation)!;
    assert.equal(review.kind, 'decide'); assert.equal(review.text, `${obligation} blocked: guidance needed`);
    assert.equal(review.command, command); assert.equal(review.alternatives, undefined);
    assert.doesNotMatch(JSON.stringify(ns.filter(n => n.obligation === obligation)), /--ok|clears when/);
    assert.doesNotMatch(itemLine(s, 'a', obligation), /--ok|clears when/);
    const status = await ops.status(f), card = await ops.why({ cwd: f.cwd, node: 'a' });
    assert.equal(status.summary!.needs.find(n => n.node === 'a')!.reason, quote);
    for (const full of [false, true]) {
      assert.ok(renderWhy(card, { full }).split('\n')[0]!.startsWith(`a: ${quote} → ${command}`));
      const text = renderStatus(status, { full });
      assert.ok(text.indexOf(`a: ${quote} → ${command}`) < text.indexOf(`a: ${review.text}`), text);
      assert.doesNotMatch(text, new RegExp(`#${f.old.seq} clears when`));
    }
  } finally { await f.cleanup(); }
});

for (const obligation of ['review', 'closure-review'] as const) test(`HL2: repaired ${obligation} without a current block retains its owner review`, async () => {
  const f = await fixture(obligation);
  try {
    const s = await f.state(), n = needs(s, 'a').find(n => n.obligation === obligation)!;
    assert.equal(n.kind, 'review');
    assert.equal(n.text, `repair #${s.nodes.a!.candidate!.seq} submitted; #${f.old.seq} clears when reviewer:old records ok at rank >= 2 on the current key`);
    assert.match(n.command!, /owed review a.* --ok --rank 3 --candidate [0-9a-f]{12}/);
    assert.equal(itemLine(s, 'a', obligation), n.text);
  } finally { await f.cleanup(); }
});

test('HL1: non-writer halt retains obligation order and omits halt fallback', async () => {
  const f = await fixture();
  try {
    const before = needs(await f.state(), 'a'); await f.halt('attest recorded no verdict twice');
    assert.deepEqual(needs(await f.state(), 'a'), before.map(n => ({ ...n, halted: true })));
    await f.block('current', true); await f.halt('attest recorded no verdict twice');
    assert.deepEqual(needs(await f.state(), 'a').map(n => n.kind), ['rule']);
  } finally { await f.cleanup(); }
});

test('HL1: writer halt precedes unruled blocks, but an intentional held ruling still suppresses it', async () => {
  const f = await fixture();
  try {
    await f.block('current', true); await f.halt();
    assert.deepEqual(needs(await f.state(), 'a').map(n => [n.kind, n.text]), [['decide', quote], ['rule', 'review asks: choose the repair']]);
    await ops.decide({ cwd: f.cwd, as: parent, nodes: ['a'], text: 'Keep the halt while reviewing', resume: false, dsa: new Client() });
    const ns = needs(await f.state(), 'a');
    assert.ok(ns.every(n => n.text !== quote)); assert.ok(ns.some(n => n.obligation === 'review'));
  } finally { await f.cleanup(); }
});

test('HL1: driver repair-stop wake leads with halt and retains the blocked obligation second', async () => {
  const f = await fixture('review', true), reports: ActionReport[] = [], log = join(f.root, 'driver.jsonl');
  await writeFile(log, '');
  const s = await f.state(), launch = writerLaunch(s, 'a', projectId(s));
  await ops.launch({ cwd: f.cwd, as: parent, ...launch });
  await f.block('current');
  const driver = new Driver({ cwd: f.cwd, dsa: new Client(), json: true, session: null, handleSignals: false, log: line => { reports.push(JSON.parse(line)); appendFileSync(log, line + '\n'); } });
  const follower = new Follower({ log, repo: f.cwd, pid: process.pid, start: procStart(process.pid), deliver() {} });
  try {
    await driver.pass(); // sends repair
    await driver.pass(); // sealed repair without a new submit
    const h = reports.find(r => r.do === 'halt'); assert.ok(h, JSON.stringify(reports));
    assert.match(h.detail!, /finished repair follow-up .* without submitting a new candidate/);
    assert.equal(h.need?.text, quote); assert.equal(h.otherNeeds?.[0]?.obligation, 'review');
    assert.doesNotMatch(JSON.stringify(h.otherNeeds), /--ok|clears when/);
    assert.equal((await follower.step())!.split('\n')[0], `Needs you: a — ${quote} → ${command}`);
  } finally { follower.stop(); driver.abort.abort(); await driver.settle(); await f.cleanup(); }
});
