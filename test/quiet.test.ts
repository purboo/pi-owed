// QT1-QT3: parent-owned recovery text and drift wakes revalidated at pi delivery.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Dsa } from '../src/dsa.ts';
import { Ledger } from '../src/ledger.ts';
import * as ops from '../src/ops.ts';
import { git } from '../src/git.ts';
import { manualHalt } from '../src/drive.ts';
import { Driver, DRIVE_PRINCIPAL, driftNotice, procStart, stateOf } from '../src/drive-run.ts';
import { Follower, classifyLine, revalidator } from '../src/drive-bg.ts';
import { renderBrief, renderEntry, renderReceipt, renderStatus } from '../src/views.ts';
import { runId, runLabels } from '../src/reducer.ts';
import type { RunView } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const PARENT = 'needs the parent (the main agent acts; owed lists the command)';
const OWNER = 'needs the owner (the main agent decides; owed lists the command)';
const parent = { role: 'parent' as const, id: 'main' };
const owner = { role: 'owner' as const, id: 'pi' };
const plan = (node: object = {}, invariants: object[] = []) => ({
  version: 1, trunk: 'main', lease: false, closure: [], invariants,
  nodes: [{ id: 'a', writes: ['a.txt'], checks: [], review: { count: 0, min_rank: 1 }, ...node }],
});

async function fixture(p = plan()) {
  const r = await repo();
  try {
    await commitAt(r.cwd, { seed: 'base\n' });
    await ops.init({ cwd: r.cwd, plan: JSON.stringify(p), as: owner, channel: 'delegated' });
    return r;
  } catch (e) { await r.cleanup(); throw e; }
}

class Sealed extends Dsa {
  override async inspect(rid: string) { return { view: { rid, state: 'sealed', status: 'ok' } as RunView }; }
}
async function candidate(r: Awaited<ReturnType<typeof fixture>>) {
  const slot = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
  const commit = await commitAt(slot.worktree, { 'a.txt': 'candidate\n' });
  await ops.submit({ cwd: slot.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
  await ops.attest({ cwd: r.cwd, node: 'a', lease: false });
  const ledger = await Ledger.open(r.cwd), project = (await ledger.read())[0]!.hash.slice(0, 12);
  await ops.launch({ cwd: r.cwd, as: DRIVE_PRINCIPAL, node: 'a', attempt: 1, role: 'writer', rid: runId(project, 'a', 1, 'writer'), spec: '{}', labels: runLabels(project, 'a', 1, 'writer') });
  return commit;
}
async function surfaces(cwd: string): Promise<string[]> {
  const outputs: string[] = [];
  for (const command of [['why', 'a'], ['status'], ['brief'], ['report']]) {
    const out = await cli(cwd, command);
    assert.equal(out.code, 0, out.stderr);
    assert.doesNotMatch(out.stdout, /human/i);
    // Brief does not list routine driver halts; only text it actually renders must be quiet.
    if (command[0] !== 'brief') outputs.push(out.stdout);
  }
  return outputs;
}

for (const by of ['reviewer', 'parent', 'owner'] as const) {
  test(`QT1 evidence-only halt by ${by}: driver, why and status name the parent; brief renders no human wording`, { timeout: 60_000 }, async () => {
    const r = await fixture(plan({ evidence: [{ id: 'ui', what: 'checked the page', by }] }));
    try {
      const commit = await candidate(r), c12 = commit.slice(0, 12);
      const manual = manualHalt(await stateOf(r.cwd), 'a')!;
      assert.equal(manual.needs, 'human', 'ledger shape is unchanged');
      assert.equal(manual.reason, `awaiting manual evidence evidence:ui (checked the page) by ${by}: owed evidence a ui --file <path> --note "<what was checked>" --as ${by}:<id> --candidate ${c12} or --as owner:pi`);
      const lines: string[] = [], driver = new Driver({ cwd: r.cwd, dsa: new Sealed(), session: null, log: l => lines.push(l) });
      const pass = await driver.pass();
      assert.equal(pass.actions.find(a => a.node === 'a')?.do, 'halt');
      assert.ok(lines.some(l => l.includes(PARENT)), lines.join('\n'));
      const halted = (await (await Ledger.open(r.cwd)).read()).findLast(e => e.kind === 'halt')!;
      assert.equal(halted.kind === 'halt' && halted.needs, 'human');
      for (const text of [lines.join('\n'), ...await surfaces(r.cwd), renderEntry(halted)]) {
        assert.doesNotMatch(text, /human/i);
        assert.ok(text.includes(PARENT), text);
        assert.ok(text.includes(`--as ${by}:<id> --candidate ${c12} or --as owner:pi`), text);
      }
    } finally { await r.cleanup(); }
  });
}

test('QT1 refusal halt: an invariant failing on the merge renders parent text on every surface', { timeout: 60_000 }, async () => {
  const r = await fixture(plan({}, [{ id: 'no-a', run: 'test ! -f a.txt', reads: ['a.txt'] }]));
  const lines: string[] = [], driver = new Driver({ cwd: r.cwd, dsa: new Sealed(), session: null, log: l => lines.push(l) });
  try {
    await candidate(r);
    assert.equal((await ops.status({ cwd: r.cwd })).nodes.a!.accepted, true);
    await driver.pass(); await driver.settle();
    const text = lines.join('\n');
    assert.match(text, /merge a: refused/);
    assert.ok(text.includes(`halted (${PARENT})`), text);
    const entries = await (await Ledger.open(r.cwd)).read(), halted = entries.findLast(e => e.kind === 'halt')!;
    assert.equal(halted.kind === 'halt' && halted.needs, 'human');
    assert.ok(!entries.some(e => e.kind === 'merge'));
    for (const out of [text, ...await surfaces(r.cwd), renderEntry(halted)]) {
      assert.doesNotMatch(out, /human/i);
      assert.ok(out.includes(PARENT), out);
    }
    assert.deepEqual((await driver.pass()).actions, [], 'halted attempts do not retry');
  } finally { await driver.settle(); await r.cleanup(); }
});

test('QT1 owner approval halt retains D25.6 owner text while evidence halts use parent text', { timeout: 60_000 }, async () => {
  const r = await fixture(plan({ approve: 'owner' }));
  try {
    await candidate(r);
    const lines: string[] = [], driver = new Driver({ cwd: r.cwd, dsa: new Sealed(), session: null, log: l => lines.push(l) });
    await driver.pass();
    const h = (await (await Ledger.open(r.cwd)).read()).findLast(e => e.kind === 'halt')!;
    assert.ok(h.kind === 'halt' && h.needs === 'owner');
    assert.equal(lines[0], `halt a attempt 1, ${OWNER}: halted — ${h.reason}`);
    assert.ok(renderReceipt(await ops.why({ cwd: r.cwd, node: 'a' })).includes(`(attempt 1), ${OWNER}:`));
    // A parent halt beside it exercises the new rendering without weakening the unchanged owner assertion.
    await ops.planSet({ cwd: r.cwd, as: parent, plan: JSON.stringify({ ...plan({ approve: 'owner' }), nodes: [...plan({ approve: 'owner' }).nodes, { id: 'b', writes: ['b.txt'] }] }) });
    await ops.dispatch({ cwd: r.cwd, node: 'b', as: parent });
    const other = await ops.halt({ cwd: r.cwd, node: 'b', attempt: 1, needs: 'human', reason: 'recover the writer', as: DRIVE_PRINCIPAL });
    assert.ok(renderEntry(other).includes(PARENT));
    assert.ok(renderEntry(h).includes(OWNER));
  } finally { await r.cleanup(); }
});

function follower(r: Awaited<ReturnType<typeof fixture>>, dsa?: Dsa) {
  const log = join(r.root, 'follow.jsonl'); writeFileSync(log, '');
  const got: string[] = [], busy = { value: true };
  const f = new Follower({ log, repo: r.cwd, pid: process.pid, start: procStart(process.pid), busy: () => busy.value, revalidate: revalidator({ cwd: r.cwd, dsa }), deliver: c => got.push(c) });
  const line = (o: object) => appendFileSync(log, `${JSON.stringify(o)}\n`);
  return { f, got, busy, line };
}
async function drift(cwd: string, legacy = false) {
  const s = await stateOf(cwd);
  const commit = await commitAt(cwd, { outside: 'external commit\n' });
  const text = driftNotice(s.trunk.name, { ref: 'refs/heads/main', commit, ledger: s.trunk.commit, relation: 'ahead', ahead: 1, behind: 0 });
  return { do: 'notify', node: 'trunk', ...(!legacy ? { scope: 'repo' } : {}), outcome: 'notify', text, facts: s.trunk.seq };
}
function driftCheck(line: object) {
  const check = classifyLine(JSON.stringify(line)).check;
  assert.equal(check?.drift, true, 'drift wakes must carry a delivery-time trunk check');
  return check!;
}

for (const legacy of [false, true]) {
  test(`QT2 ${legacy ? 'legacy drift stays delivered' : 'repo-scoped drift is dropped and counted'} after adoption before delivery`, { timeout: 60_000 }, async () => {
    const r = await fixture(), follow = follower(r);
    try {
      const wake = await drift(r.cwd, legacy);
      follow.line(wake); assert.equal(await follow.f.step(), undefined);
      await ops.adopt({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'reviewed the external commit' });
      follow.line({ event: 'idle-wait', at: 'now' });
      follow.busy.value = false;
      const message = await follow.f.step();
      assert.ok(message, 'the unrelated idle wake is still delivered');
      if (legacy) {
        assert.ok(message.includes(wake.text), 'unscoped legacy drift is never dropped as drift');
        assert.doesNotMatch(message, /resolved before delivery/);
      } else {
        assert.doesNotMatch(message, /moved outside owed/);
        assert.match(message, /\n\(1 wake\(s\) resolved before delivery\)$/);
      }
      assert.equal(follow.got.length, 1);
      assert.equal((await ops.status({ cwd: r.cwd })).drift, undefined);
      assert.doesNotMatch(`${renderStatus(await ops.status({ cwd: r.cwd }))}\n${renderBrief(await ops.brief({ cwd: r.cwd }))}`, /moved outside owed/);
    } finally { follow.f.stop(); await r.cleanup(); }
  });
}

test('QT2 drift still current is delivered; plan node trunk and non-drift repo wakes stay separate', { timeout: 60_000 }, async () => {
  const r = await fixture(), follow = follower(r);
  try {
    const wake = await drift(r.cwd);
    driftCheck(wake);
    assert.equal(classifyLine(JSON.stringify({ do: 'halt', node: 'trunk', facts: 0, outcome: 'halted', needs: 'human' })).check?.node, 'trunk');
    assert.equal(classifyLine(JSON.stringify({ do: 'notify', node: 'disk', scope: 'repo', facts: 0, outcome: 'notify', text: 'disk low' })).check, undefined);
    follow.line(wake); await follow.f.step(); follow.busy.value = false;
    const message = await follow.f.step();
    assert.ok(message);
    assert.ok(message.includes(wake.text), message);
    assert.doesNotMatch(message, /resolved before delivery/);
    assert.equal(follow.got.length, 1);
  } finally { follow.f.stop(); await r.cleanup(); }
});

test('QT2 failed ledger read keeps the drift wake at delivery', { timeout: 60_000 }, async () => {
  const r = await fixture(), follow = follower(r);
  try {
    const wake = await drift(r.cwd);
    driftCheck(wake);
    follow.line(wake); await follow.f.step();
    const ledger = await Ledger.open(r.cwd);
    writeFileSync(join(ledger.dir, 'ledger.jsonl'), 'not a ledger\n');
    await assert.rejects(stateOf(r.cwd), /invalid JSON/i, 'the read really failed');
    follow.busy.value = false;
    const message = await follow.f.step();
    assert.ok(message);
    assert.ok(message.includes(wake.text), message);
    assert.doesNotMatch(message, /resolved before delivery/);
  } finally { follow.f.stop(); await r.cleanup(); }
});

test('QT2 restored ref drops even an unmarked repo-scoped drift; advanced trunk seq drops an old wake despite new drift', { timeout: 60_000 }, async () => {
  const r = await fixture();
  try {
    const s = await stateOf(r.cwd), wake = await drift(r.cwd);
    const { facts: _facts, ...unmarked } = wake;
    await git(r.cwd, ['update-ref', 'refs/heads/main', s.trunk.commit]);
    assert.deepEqual(await revalidator({ cwd: r.cwd })([driftCheck(unmarked)]), [false]);
    await commitAt(r.cwd, { outside: 'first\n' });
    await ops.adopt({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'accepted the first external commit' });
    await commitAt(r.cwd, { outside: 'new drift\n' });
    assert.ok((await ops.status({ cwd: r.cwd })).drift);
    assert.deepEqual(await revalidator({ cwd: r.cwd })([driftCheck(wake)]), [false]);
    const current = { ...wake, facts: (await stateOf(r.cwd)).trunk.seq };
    assert.deepEqual(await revalidator({ cwd: r.cwd })([driftCheck(current)]), [true]);
  } finally { await r.cleanup(); }
});

test('QT2 unscoped plan node trunk open question is delivered when trunk ref equals ledger commit (#1378)', { timeout: 60_000 }, async () => {
  const r = await fixture(plan({ id: 'trunk' }));
  class Asking extends Dsa {
    open = true;
    override async inspect(rid: string) {
      return { view: { rid, state: this.open ? 'asking' : 'running', questions: this.open ? [{ qid: 'q1', rev: 1, question: 'which port?' }] : [] } as RunView };
    }
  }
  const dsa = new Asking(), follow = follower(r, dsa);
  try {
    await ops.dispatch({ cwd: r.cwd, node: 'trunk', as: parent });
    const ledger = await Ledger.open(r.cwd), project = (await ledger.read())[0]!.hash.slice(0, 12);
    const rid = runId(project, 'trunk', 1, 'writer');
    await ops.launch({ cwd: r.cwd, as: DRIVE_PRINCIPAL, node: 'trunk', attempt: 1, role: 'writer', rid, spec: '{}', labels: runLabels(project, 'trunk', 1, 'writer') });
    const lines: string[] = [], driver = new Driver({ cwd: r.cwd, dsa, session: null, json: true, log: l => lines.push(l) });
    await driver.pass();
    const wake = lines.map(l => JSON.parse(l)).find(l => l.do === 'notify' && l.node === 'trunk');
    assert.ok(wake);
    assert.equal(wake.scope, undefined);
    assert.deepEqual([wake.rid, wake.qid, wake.rev], [rid, 'q1', 1]);
    const s = await stateOf(r.cwd);
    assert.equal((await git(r.cwd, ['rev-parse', 'refs/heads/main'])).stdout.trim(), s.trunk.commit);
    assert.equal((await dsa.describe(rid)).questions?.length, 1, 'the question really is still open');
    follow.line(wake);
    assert.equal(await follow.f.step(), undefined, 'held while busy');
    follow.busy.value = false;
    const message = await follow.f.step();
    assert.ok(message?.includes(wake.text), 'a current question on plan node trunk must be delivered');
    assert.equal(follow.got.length, 1);
    const check = classifyLine(JSON.stringify(wake)).check!;
    assert.equal(check.drift, undefined);
    assert.equal(check.node, 'trunk');
    // Normal question and node revalidation still apply, independent of the trunk ref.
    dsa.open = false;
    assert.deepEqual(await revalidator({ cwd: r.cwd, dsa })([check]), [false], 'answered question is dropped');
    dsa.open = true;
    await ops.rule({ cwd: r.cwd, as: parent, nodes: ['trunk'], text: 'use port 8080' });
    assert.deepEqual(await revalidator({ cwd: r.cwd, dsa })([check]), [false], 'advanced node fact drops the old wake');
  } finally { follow.f.stop(); await r.cleanup(); }
});

test('QT2 failed trunk-ref read keeps a current drift wake', { timeout: 60_000 }, async () => {
  const r = await fixture();
  try {
    const wake = await drift(r.cwd), check = driftCheck(wake);
    await git(r.cwd, ['update-ref', '-d', 'refs/heads/main']);
    assert.deepEqual(await revalidator({ cwd: r.cwd })([check]), [true]);
  } finally { await r.cleanup(); }
});
