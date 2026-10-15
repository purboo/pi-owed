import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { Driver, DRIVE_PRINCIPAL } from '../src/drive-run.ts';
import { decide } from '../src/drive.ts';
import { Dsa } from '../src/dsa.ts';
import { parsePlan } from '../src/plan.ts';
import { entriesOf, reduce, runId, runLabels, sharedParked, sharedParkKey, sharedFailure, mergeBatchPlan, validateDraft } from '../src/reducer.ts';
import { wakeReport } from '../src/drive-run.ts';
import { sharedWaiting } from '../src/drive.ts';
import { errorGroups } from '../src/exec.ts';
import { renderStatus, renderReport } from '../src/views.ts';
import type { Entry, ObsEntry, Draft } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { commitAt } from './helpers/surface.ts';

const owner = { role: 'owner', id: 'pi' } as const, parent = { role: 'parent', id: 'main' } as const;
const NAME = 'flaky lease renew';
const PASS = `ok 1 - ${NAME}\n1..1\n# tests 1\n# pass 1\n# fail 0\n`;
const FAIL = (signature: boolean) => `not ok 1 - ${NAME}\n${signature ? "  ---\n  error: 'renew failed under load'\n  ...\n" : ''}1..1\n# tests 1\n# pass 0\n# fail 1\n`;
class SealedDsa extends Dsa { override async inspect(rid: string) { return { view: { rid, state: 'sealed' as const, status: 'ok' } }; } }

/**
 * A repository whose invariant `x` replays a verdict schedule (one line per measurement, `pass` after the end) and
 * prints one TAP test `flaky lease renew`; `signature: false` omits the error text (no recorded signature).
 */
async function fixture(o: { schedule: string[]; nodes: { id: string; file: string; brief?: string; writes?: string[] }[]; broken?: string; repeat?: object; signature?: boolean; allow?: object[]; reads?: string[]; extra?: object[]; needles?: string[] }) {
  const r = await repo();
  await r.put('README', 'base'); await r.commit();
  const schedule = join(r.root, 'schedule'), counter = join(r.root, 'counter');
  await writeFile(join(r.root, 'pass.tap'), PASS); await writeFile(join(r.root, 'fail.tap'), FAIL(o.signature ?? true));
  await writeFile(schedule, o.schedule.join('\n') + '\n');
  await writeFile(join(r.root, 'own.tap'), `not ok 1 - own regression\n  ---\n  error: 'broken by the candidate'\n  ...\n1..1\n# tests 1\n# pass 0\n# fail 1\n`);
  const run = `${o.broken ? `if [ -f ${o.broken} ]; then cat '${join(r.root, 'own.tap')}'; exit 1; fi; ` : ''}n=$(cat '${counter}' 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > '${counter}'; if [ "$(sed -n "\${n}p" '${schedule}')" = fail ]; then cat '${join(r.root, 'fail.tap')}'; exit 1; fi; cat '${join(r.root, 'pass.tap')}'`;
  const plan = { version: 1, trunk: 'main', lease: false, closure: [], drive: { min_free_mb: 0 }, invariants: [{ id: 'x', run, min_tests: 1, reads: o.reads ?? ['src/**'], ...(o.needles ? { remeasure_on: o.needles } : {}), ...(o.repeat ? { repeat: o.repeat } : {}) }, ...(o.extra ?? [])], nodes: o.nodes.map(n => ({ id: n.id, writes: n.writes ?? [n.file], ...(n.brief ? { brief: n.brief } : {}) })), ...(o.allow ? { allow: o.allow } : {}) };
  await ops.init({ cwd: r.cwd, plan: JSON.stringify(plan), as: owner, channel: 'delegated' });
  const ledger = await Ledger.open(r.cwd);
  const state = async () => (await ops.readState({ cwd: r.cwd })).state;
  const accept = async (id: string) => {
    const n = o.nodes.find(x => x.id === id)!, d = await ops.dispatch({ cwd: r.cwd, node: id, as: parent });
    await commitAt(d.worktree, { [n.file]: id });
    await ops.submit({ cwd: d.worktree, node: id, as: { role: 'writer', id: `${id}#1` } });
    assert.equal((await ops.attest({ cwd: r.cwd, node: id })).accepted, true);
    return d;
  };
  const obs = async () => entriesOf(await state()).filter((e): e is ObsEntry => e.kind === 'obs' && e.obligation === 'inv:x');
  const driver = async (ids: string[]) => {
    const project = (await ledger.read())[0]!.hash.slice(0, 12), lines: string[] = [];
    for (const id of ids) await ops.launch({ cwd: r.cwd, as: DRIVE_PRINCIPAL, node: id, attempt: 1, role: 'writer', rid: runId(project, id, 1, 'writer'), spec: '{}', labels: runLabels(project, id, 1, 'writer') });
    const d = new Driver({ cwd: r.cwd, log: l => lines.push(l), handleSignals: false, session: null, dsa: new SealedDsa({ bin: '/no-shared-dsa' }), max: 4 });
    const passes = async (k = 3) => { for (let i = 0; i < k; i++) { await d.pass(); assert.equal(await d.drain(90_000), true); } };
    return { d, lines, passes };
  };
  const halts = async () => (await ledger.read()).filter(e => e.kind === 'halt');
  return { ...r, ledger, state, accept, obs, driver, halts, plan: JSON.stringify(plan) };
}
const refusal = async (p: Promise<unknown>): Promise<Error> => { try { await p; } catch (e) { return e as Error; } assert.fail('expected a refusal'); };

test('FS1-FS4: shared failure on another merge tree parks two nodes without halts, one notice, auto retry after a trunk move', { timeout: 300_000 }, async () => {
  const r = await fixture({ schedule: ['pass', 'fail', 'fail', 'pass', 'fail', 'pass'], nodes: [{ id: 'a', file: 'src/a' }, { id: 'b', file: 'src/b' }, { id: 'c', file: 'src/c' }] });
  try {
    for (const id of ['a', 'b', 'c']) await r.accept(id);
    // b's merge tree fails first: nothing shows the failure without b, so it is refused as today and not retried.
    const b = await refusal(ops.merge({ cwd: r.cwd, node: 'b', as: parent }));
    assert.ok(!(b instanceof ops.SharedRefusal)); assert.doesNotMatch(b.message, /^shared failure/);
    const t = (await r.obs()).find(e => e.merging === 'b')!;
    assert.equal((await r.obs()).filter(e => e.merging === 'b').length, 1);
    await ops.abandon({ cwd: r.cwd, node: 'b', reason: 'fixture: b leaves', hold: true, as: owner, channel: 'delegated' } as Parameters<typeof ops.abandon>[0]);
    // FS1/FS2: a fails the same name and signature: one automatic same-key retry without remeasure_on, then shared remedy.
    const a = await refusal(ops.merge({ cwd: r.cwd, node: 'a', as: parent }));
    assert.ok(a instanceof ops.SharedRefusal, a.message);
    assert.match(a.message, new RegExp(`^shared failure: inv:x ${NAME} also failed on trunk without a \\(#${t.seq}\\); not attributed to a`));
    assert.doesNotMatch(a.message, /owed rebase/);
    const mine = (await r.obs()).filter(e => e.merging === 'a');
    assert.deepEqual(mine.map(e => [e.verdict, e.auto_remeasure, e.remeasure_match]), [['fail', undefined, undefined], ['pass', true, undefined]]);
    assert.equal(mine[0]!.key, mine[1]!.key);
    assert.equal((await ops.verify({ cwd: r.cwd })).ok, true);
    // FS3 via the driver: c is parked, not halted; a later pass retries nothing.
    const drv = await r.driver(['a', 'c']);
    await drv.passes();
    assert.deepEqual(await r.halts(), [], drv.lines.join('\n'));
    assert.ok(drv.lines.some(l => l.includes(`waiting: shared failure (inv:x ${NAME})`)), drv.lines.join('\n'));
    const before = (await r.obs()).length;
    await drv.passes(2);
    assert.equal((await r.obs()).length, before);
    assert.deepEqual((await r.ledger.read()).filter(e => e.kind === 'send'), [], drv.lines.join('\n'));
    const s = await r.state();
    for (const id of ['a', 'c']) assert.equal(sharedParked(s, id)[0]?.kind, 'shared');
    // FS4: one repository notice for both nodes, once-key (obligation, names, trunk commit); status and brief needs.
    const actions = decide(s, s.plan, new Map(), { max: 4, repairs: 2, project: 'p', root: r.cwd, applied: new Set(), rejected: new Map(), noticed: new Set(['a', 'c'].map(id => sharedParkKey(s, id))) });
    const notices = actions.filter(x => x.do === 'notify' && x.scope === 'repo');
    assert.equal(notices.length, 1, JSON.stringify(actions));
    assert.ok(notices[0]!.do === 'notify');
    assert.equal(notices[0]!.once, `shared\0inv:x\0${NAME}\0${s.trunk.commit}`);
    assert.equal(notices[0]!.text, `shared failure: inv:x ${NAME} fails without any candidate; waiting: a, c. owed retries after trunk moves. To merge now: owed decide a,c --defer inv:x (or an allow defer rule); to fix: a node whose brief names the test.`);
    assert.ok(!actions.some(x => x.do === 'merge'));
    const status = await ops.status({ cwd: r.cwd });
    assert.equal(status.summary!.needs.filter(n => n.node === 'trunk' && n.reason.startsWith('shared failure:') && n.command === '').length, 1);
    assert.match(renderStatus(status), new RegExp(`waiting: shared failure \\(inv:x ${NAME}\\)`));
    const brief = await ops.brief({ cwd: r.cwd });
    assert.ok(JSON.stringify(brief).includes('shared failure: inv:x'));
    // Level-triggered: a trunk move (new invariant key) retries both merges with no resume entry.
    await commitAt(r.cwd, { 'src/other': 'trunk moves' });
    await ops.adopt({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'trunk moves' });
    await drv.passes(4);
    const now = await r.state();
    assert.ok(now.nodes.a!.merged && now.nodes.c!.merged, drv.lines.join('\n'));
    assert.equal((await r.ledger.read()).filter(e => e.kind === 'resume' || e.kind === 'halt').length, 0);
    assert.equal((await ops.verify({ cwd: r.cwd })).ok, true);
  } finally { await r.cleanup(); }
});

test('FS3: a mixed refusal (one shared and one new failure) still halts with today\'s text', { timeout: 240_000 }, async () => {
  const y = { id: 'y', run: `if [ -f src/a ]; then printf 'not ok 1 - y check\\n  ---\\n  error: broken by a\\n  ...\\n1..1\\n# tests 1\\n# pass 0\\n# fail 1\\n'; exit 1; fi; printf 'ok 1 - y check\\n1..1\\n# tests 1\\n# pass 1\\n# fail 0\\n'`, min_tests: 1, reads: ['src/**'] };
  const r = await fixture({ schedule: ['pass', 'fail', 'fail', 'pass'], nodes: [{ id: 'a', file: 'src/a' }, { id: 'b', file: 'src/b' }], extra: [y] });
  try {
    for (const id of ['a', 'b']) await r.accept(id);
    await refusal(ops.merge({ cwd: r.cwd, node: 'b', as: parent }));
    await ops.abandon({ cwd: r.cwd, node: 'b', reason: 'fixture', hold: true, as: owner, channel: 'delegated' } as Parameters<typeof ops.abandon>[0]);
    const drv = await r.driver(['a']);
    await drv.passes(2);
    const halts = await r.halts();
    assert.equal(halts.length, 1, drv.lines.join('\n'));
    assert.ok(halts[0]!.kind === 'halt');
    assert.match(halts[0]!.reason, /^merge refused: /);
    assert.match(halts[0]!.reason, /invariant y new debt/);
    assert.deepEqual(sharedParked(await r.state(), 'a'), []);
  } finally { await r.cleanup(); }
});

test('FS5: an accepted fix candidate merges first; the parked node waits for it, then merges without a parent act', { timeout: 300_000 }, async () => {
  const r = await fixture({ schedule: ['pass', 'fail', 'fail', 'pass'], nodes: [{ id: 'a', file: 'src/a' }, { id: 'b', file: 'src/b' }, { id: 'f', file: 'src/f', brief: `make ${NAME} load tolerant` }] });
  try {
    for (const id of ['a', 'b']) await r.accept(id);
    await refusal(ops.merge({ cwd: r.cwd, node: 'b', as: parent }));
    await ops.abandon({ cwd: r.cwd, node: 'b', reason: 'fixture', hold: true, as: owner, channel: 'delegated' } as Parameters<typeof ops.abandon>[0]);
    assert.ok((await refusal(ops.merge({ cwd: r.cwd, node: 'a', as: parent }))) instanceof ops.SharedRefusal);
    // Not yet accepted: only named in the notice.
    let s = await r.state();
    assert.equal(sharedParked(s, 'a')[0]!.fix, undefined);
    await r.accept('f');
    s = await r.state();
    assert.equal(sharedParked(s, 'a')[0]!.fix, 'f');
    assert.match(renderStatus(await ops.status({ cwd: r.cwd })), /waiting: fix f/);
    const actions = decide(s, s.plan, new Map(), { max: 4, repairs: 2, project: 'p', root: r.cwd, applied: new Set(), rejected: new Map() });
    assert.match(actions.find(x => x.do === 'notify' && x.scope === 'repo')!.do === 'notify' ? (actions.find(x => x.do === 'notify' && x.scope === 'repo') as { text: string }).text : '', /Fix candidate: f \(accepted\)\./);
    // A fresh driver (no memory of the refusal) still does not retry a before f merges.
    const drv = await r.driver(['a', 'f']);
    await drv.passes(4);
    const merges = (await r.ledger.read()).filter(e => e.kind === 'merge').map(e => e.kind === 'merge' ? e.node : '');
    assert.deepEqual(merges, ['f', 'a'], drv.lines.join('\n'));
    const aAttempts = (await r.obs()).filter(e => e.merging === 'a');
    const fMerge = (await r.ledger.read()).find(e => e.kind === 'merge' && e.node === 'f')!;
    assert.equal(aAttempts.filter(e => e.seq < fMerge.seq).length, 2);
    assert.equal((await r.ledger.read()).filter(e => e.kind === 'resume' || e.kind === 'halt').length, 0);
  } finally { await r.cleanup(); }
});

test('FS3 bound: the third distinct merge key of the same shared names halts with today\'s reason plus the bound', { timeout: 300_000 }, async () => {
  const r = await fixture({ schedule: ['pass', 'fail', 'fail', 'fail', 'pass', 'fail', 'fail', 'pass', 'fail', 'fail'], nodes: [{ id: 'a', file: 'src/a' }, { id: 'b', file: 'src/b' }] });
  try {
    for (const id of ['a', 'b']) await r.accept(id);
    await refusal(ops.merge({ cwd: r.cwd, node: 'b', as: parent }));
    await ops.abandon({ cwd: r.cwd, node: 'b', reason: 'fixture', hold: true, as: owner, channel: 'delegated' } as Parameters<typeof ops.abandon>[0]);
    const first = await refusal(ops.merge({ cwd: r.cwd, node: 'a', as: parent }));
    assert.ok(first instanceof ops.SharedRefusal, first.message);
    await commitAt(r.cwd, { 'src/o1': '1' }); await ops.adopt({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'move 1' });
    // Trunk moved since the slot base: AT1 would say rebase; the shared remedy replaces it.
    const second = await refusal(ops.merge({ cwd: r.cwd, node: 'a', as: parent }));
    assert.ok(second instanceof ops.SharedRefusal, second.message);
    assert.match(second.message, /^shared failure: inv:x/); assert.doesNotMatch(second.message, /owed rebase a/);
    await commitAt(r.cwd, { 'src/o2': '2' }); await ops.adopt({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'move 2' });
    const drv = await r.driver(['a']);
    await drv.passes(2);
    const halts = await r.halts();
    assert.equal(halts.length, 1, drv.lines.join('\n'));
    assert.ok(halts[0]!.kind === 'halt');
    assert.match(halts[0]!.reason, /shared failure persisted on 3 merge keys/);
    assert.match(halts[0]!.reason, /invariant x new debt/);
    assert.equal(new Set((await r.obs()).filter(e => e.merging === 'a').map(e => e.key)).size, 3);
  } finally { await r.cleanup(); }
});

test('FS3(b): a trunk-key conflict from the merge guard\'s trunk refresh parks two accepted nodes; a defer releases one', { timeout: 400_000 }, async () => {
  for (const variant of [{ schedule: ['pass', 'fail', 'pass'], needles: ['renew failed under load'], expect: [['pass', undefined], ['fail', undefined], ['pass', true]] }]) {
    const r = await fixture({ schedule: variant.schedule, ...(variant.needles ? { needles: variant.needles } : {}), nodes: [{ id: 'a', file: 'doc/a' }, { id: 'c', file: 'doc/c' }] });
    try {
      for (const id of ['a', 'c']) await r.accept(id);
      const plan = JSON.parse(JSON.stringify(parsePlanText(r.plan))); plan.invariants[0].reads = ['src/**', 'README'];
      await ops.planSet({ cwd: r.cwd, plan: JSON.stringify(plan), as: owner, channel: 'delegated', note: 'widen reads' });
      const a = await refusal(ops.merge({ cwd: r.cwd, node: 'a', as: parent }));
      assert.ok(a instanceof ops.SharedRefusal, a.message);
      const trunk = (await r.obs()).filter(e => e.merging === undefined);
      assert.deepEqual(trunk.map(e => [e.verdict, e.auto_remeasure]), variant.expect);
      const s = await r.state();
      for (const id of ['a', 'c']) assert.equal(sharedParked(s, id)[0]?.kind, 'trunk-red');
      assert.match(renderStatus(await ops.status({ cwd: r.cwd })), new RegExp(`waiting: trunk red \\(inv:x on trunk ${s.trunk.commit.slice(0, 12)}\\)`));
      // Ruling #2458 (F1): one repository notice that wakes the next session, and one summary.needs trunk item.
      const fail = trunk.find(e => e.verdict === 'fail')!, pass = trunk.findLast(e => e.verdict === 'pass')!;
      const actions = decide(s, s.plan, new Map(), { max: 4, repairs: 2, project: 'p', root: r.cwd, applied: new Set(), rejected: new Map(), noticed: new Set(['a', 'c'].map(id => sharedParkKey(s, id))) });
      const notices = actions.filter(x => x.do === 'notify' && x.scope === 'repo');
      assert.equal(notices.length, 1, JSON.stringify(actions));
      assert.ok(notices[0]!.do === 'notify');
      assert.equal(notices[0]!.once, `trunk\0inv:x\0${NAME}\0${s.trunk.commit}`);
      assert.equal(notices[0]!.text, `trunk red: inv:x ${NAME} fails on trunk ${s.trunk.commit.slice(0, 12)} (#${fail.seq}, pass #${pass.seq}: owner conflict); waiting: a, c. owed retries after trunk moves. To merge now: owed decide a,c --defer inv:x (or an allow defer rule); to fix: a node whose brief names the test.`);
      assert.equal(wakeReport({ do: 'notify', outcome: 'done' }), true);
      const needs = (await ops.status({ cwd: r.cwd })).summary!.needs.filter(x => x.node === 'trunk' && x.reason.startsWith('trunk red: inv:x'));
      assert.equal(needs.length, 1); assert.equal(needs[0]!.command, '');
      const drv = await r.driver(['a', 'c']);
      await drv.passes(2);
      assert.deepEqual(await r.halts(), [], drv.lines.join('\n'));
      assert.equal(drv.lines.filter(l => l.startsWith('trunk red: inv:x')).length, 1, drv.lines.join('\n'));
      // The trunk item of that key changes for a (owner defer): a merges; c stays parked, still without a halt.
      await ops.defer({ cwd: r.cwd, as: owner, channel: 'delegated', node: 'a', items: [{ id: 'x', key: s.trunk.invKeys.x! }], reason: 'accept the flaky trunk test for a' });
      await drv.passes(3);
      const now = await r.state();
      assert.ok(now.nodes.a!.merged, drv.lines.join('\n'));
      assert.equal(now.nodes.c!.merged, undefined);
      assert.deepEqual(await r.halts(), []);
      assert.equal(sharedParked(now, 'c')[0]?.kind, 'trunk-red');
    } finally { await r.cleanup(); }
  }
});

test('FS3(b) ruling #2458 (ii): an own failure on a reused merge-key observation with a trunk-key conflict halts, not parked', { timeout: 300_000 }, async () => {
  const r = await fixture({ schedule: ['pass', 'fail', 'pass'], needles: ['renew failed under load'], broken: 'src/a', nodes: [{ id: 'a', file: 'src/a', writes: ['src/a', 'doc/a2'] }] });
  try {
    const plan = JSON.parse(r.plan); plan.invariants[0].reads = ['src/**', 'README'];
    await ops.planSet({ cwd: r.cwd, plan: JSON.stringify(plan), as: owner, channel: 'delegated', note: 'widen reads' });
    await ops.attestTrunk({ cwd: r.cwd });
    const d = await r.accept('a');
    const first = await refusal(ops.merge({ cwd: r.cwd, node: 'a', as: parent }));
    assert.ok(!(first instanceof ops.SharedRefusal), first.message);
    // A new candidate outside the invariant reads: the merge key (and its failing observation) is reused.
    await commitAt(d.worktree, { 'doc/a2': 'resubmit' });
    await ops.submit({ cwd: d.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
    assert.equal((await ops.attest({ cwd: r.cwd, node: 'a' })).accepted, true);
    const s = await r.state();
    assert.deepEqual(sharedParked(s, 'a'), []);
    const drv = await r.driver(['a']);
    await drv.passes(2);
    const halts = await r.halts();
    assert.equal(halts.length, 1, drv.lines.join('\n'));
    assert.ok(halts[0]!.kind === 'halt'); assert.match(halts[0]!.reason, /invariant x new debt/);
    assert.equal((await r.obs()).filter(e => e.merging === 'a').length, 1);
  } finally { await r.cleanup(); }
});

test('FS3(b) ruling #2458 (iii): a never-attempted node changing the invariant reads is not trunk-red parked, batched normally and does not wait for a fix', { timeout: 300_000 }, async () => {
  const r = await fixture({ schedule: ['pass', 'fail', 'pass'], needles: ['renew failed under load'], nodes: [{ id: 'c', file: 'src/c' }, { id: 'd', file: 'src/d' }, { id: 'f', file: 'doc/f', brief: `make ${NAME} load tolerant` }] });
  try {
    const plan = JSON.parse(r.plan); plan.invariants[0].reads = ['src/**', 'README'];
    await ops.planSet({ cwd: r.cwd, plan: JSON.stringify(plan), as: owner, channel: 'delegated', note: 'widen reads' });
    await ops.attestTrunk({ cwd: r.cwd });
    for (const id of ['c', 'd', 'f']) await r.accept(id);
    const s = await r.state();
    assert.equal(sharedParked(s, 'f')[0]?.kind, 'trunk-red');
    for (const id of ['c', 'd']) {
      assert.deepEqual(sharedParked(s, id), []);
      assert.equal(sharedWaiting(s, id, {}), false);
    }
    assert.doesNotMatch(renderStatus(await ops.status({ cwd: r.cwd })), /c: .*waiting: (trunk red|fix f)/);
    const progress = (await ops.status({ cwd: r.cwd })).summary!.progress as { node?: string; id?: string; phase?: string }[];
    assert.ok(!JSON.stringify(progress.filter(p => (p.node ?? p.id) === 'c')).includes('waiting'), JSON.stringify(progress));
    assert.deepEqual(mergeBatchPlan(s, 3, ['c', 'd']), ['c', 'd']);
    // The driver merges c and d without waiting for f; f (parked on the trunk key) merges only after they moved trunk.
    const drv = await r.driver(['c', 'd', 'f']);
    await drv.passes(4);
    const merges = (await r.ledger.read()).flatMap(e => e.kind === 'merge' ? [e.node] : []);
    assert.deepEqual(merges.slice(0, 2).sort(), ['c', 'd'], drv.lines.join('\n'));
    assert.deepEqual(await r.halts(), [], drv.lines.join('\n'));
  } finally { await r.cleanup(); }
});

test('FS2 ruling #2458 (iv): a repeat invariant gets no shared-only automatic remeasure', { timeout: 300_000 }, async () => {
  const r = await fixture({ schedule: ['pass', 'pass', 'fail', 'fail', 'pass', 'pass'], repeat: { runs: 2, need: 2 }, nodes: [{ id: 'a', file: 'src/a' }, { id: 'b', file: 'src/b' }] });
  try {
    for (const id of ['a', 'b']) await r.accept(id);
    await refusal(ops.merge({ cwd: r.cwd, node: 'b', as: parent }));
    await ops.abandon({ cwd: r.cwd, node: 'b', reason: 'fixture', hold: true, as: owner, channel: 'delegated' } as Parameters<typeof ops.abandon>[0]);
    await refusal(ops.merge({ cwd: r.cwd, node: 'a', as: parent }));
    const mine = (await r.obs()).filter(e => e.merging === 'a');
    assert.deepEqual(mine.map(e => [e.verdict, e.auto_remeasure]), [['fail', undefined]]);
    assert.ok(sharedFailure(await r.state(), mine[0]!, 'a'), 'the failure itself is shared');
    // Replay refuses a forged shared-only retry on a repeat invariant.
    const forged = { ...mine[0]!, verdict: 'pass', failed: undefined, auto_remeasure: true } as Record<string, unknown>;
    for (const k of ['seq', 'ts', 'prev', 'hash', 'signatures', 'note']) delete forged[k];
    assert.ok(validateDraft(await r.state(), forged as unknown as Draft).some(e => /auto_remeasure requires/.test(e)));
  } finally { await r.cleanup(); }
});

test('FS6: an allow defer rule lets owed defer a shared intermittent failure with a same-key pass; replay refuses forged executor defers', { timeout: 300_000 }, async () => {
  const r = await fixture({ schedule: ['pass', 'fail', 'fail', 'pass'], nodes: [{ id: 'a', file: 'src/a' }, { id: 'b', file: 'src/b' }], allow: [{ nodes: ['a'], defer: ['x'] }] });
  try {
    for (const id of ['a', 'b']) await r.accept(id);
    await refusal(ops.merge({ cwd: r.cwd, node: 'b', as: parent }));
    const result = await ops.merge({ cwd: r.cwd, node: 'a', as: parent });
    assert.equal(result.entry.kind, 'merge');
    const entries = await r.ledger.read(), defer = entries.find(e => e.kind === 'defer')!;
    assert.ok(defer.kind === 'defer');
    const [fail, pass] = (await r.obs()).filter(e => e.merging === 'a'), t = (await r.obs()).find(e => e.merging === 'b')!;
    assert.equal(defer.by, 'executor:owed'); assert.equal(defer.allowance, 0);
    assert.deepEqual(defer.items, [{ id: 'x', key: fail!.key }]);
    assert.equal(defer.reason, `shared intermittent ${NAME}: failed on trunk #${t.seq}; pass #${pass!.seq} and fail #${fail!.seq} on this merge key`);
    assert.equal(defer.seq + 1, result.entry.seq);
    assert.equal((await ops.verify({ cwd: r.cwd })).ok, true);
    const report = await ops.report({ cwd: r.cwd });
    assert.ok(report.downgrades.some(d => d.seq === defer.seq && d.allowance === 0));
    assert.match(renderReport(report), /deferred by owed under allowance \(plan #0\) a: inv:x deferred: shared intermittent/);
    // Replay: forged reason, forged node outside the rule, owner-style defer by the executor.
    const lookup = async () => { const plans = new Map<string, ReturnType<typeof parsePlan>>(); for (const e of entries) if (e.kind === 'genesis' || e.kind === 'plan') plans.set(e.plan, parsePlan((await r.ledger.getBlob(e.plan)).toString())); return (sha: string) => plans.get(sha)!; };
    const look = await lookup(), prefix = entries.filter(e => e.seq < defer.seq);
    const before = reduce(prefix, look);
    assert.deepEqual(validateDraft(before, { ...defer } as unknown as Draft), []);
    for (const forged of [{ reason: 'trust me' }, { allowance: 7 }, { items: [{ id: 'x', key: 'f'.repeat(64) }] }, { channel: 'delegated' }, { node: 'b' }]) {
      assert.ok(validateDraft(before, { ...defer, ...forged } as unknown as Draft).some(e => /executor defer requires/.test(e)), JSON.stringify(forged));
      assert.throws(() => reduce([...prefix, { ...defer, ...forged } as Entry], look));
    }
  } finally { await r.cleanup(); }
  // Name-only evidence (no signature recorded) never yields an executor defer, but still parks with the marked remedy.
  const n = await fixture({ schedule: ['pass', 'fail', 'fail', 'pass'], signature: false, nodes: [{ id: 'a', file: 'src/a' }, { id: 'b', file: 'src/b' }], allow: [{ nodes: ['*'], defer: ['*'] }] });
  try {
    for (const id of ['a', 'b']) await n.accept(id);
    await refusal(ops.merge({ cwd: n.cwd, node: 'b', as: parent }));
    const e = await refusal(ops.merge({ cwd: n.cwd, node: 'a', as: parent }));
    assert.ok(e instanceof ops.SharedRefusal, e.message);
    assert.match(e.message, new RegExp(`^shared failure: inv:x ${NAME} \\(same name; no error signature recorded\\) also failed on trunk without a`));
    assert.equal((await n.ledger.read()).filter(x => x.kind === 'defer').length, 0);
  } finally { await n.cleanup(); }
});

test('FS6: allow defer is an owner-only plan change and parses strictly', { timeout: 120_000 }, async () => {
  const r = await fixture({ schedule: ['pass'], nodes: [{ id: 'a', file: 'src/a' }] });
  try {
    const plan = parsePlanText(r.plan);
    await assert.rejects(ops.planSet({ cwd: r.cwd, plan: JSON.stringify({ ...plan, allow: [{ nodes: ['a'], defer: ['x'] }] }), as: parent }), /owner|allow changed/);
    assert.throws(() => parsePlan(JSON.stringify({ ...plan, allow: [{ nodes: ['a'], defer: 'x' }] })), /allow\[0\]\.defer/);
    await ops.planSet({ cwd: r.cwd, plan: JSON.stringify({ ...plan, allow: [{ nodes: ['a'], defer: ['x'] }] }), as: owner, channel: 'delegated', note: 'allow owed to defer x' });
    assert.deepEqual((await r.state()).plan.allow, [{ nodes: ['a'], defer: ['x'] }]);
  } finally { await r.cleanup(); }
});

test('FS signatures: cargo panics with a thread id are parsed; the cargo signature is message plus location', () => {
  const log = "---- phys_finish stdout ----\nthread 'phys_finish' (1771435) panicked at crates/store/tests/public.rs:338:5:\nrenewed=8, failures=[\"Ok(())\"]\nnote: run with `RUST_BACKTRACE=1`\n\nfailures:\n    phys_finish\n\ntest result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.00s\n";
  assert.deepEqual(errorGroups(log, ['phys_finish']), [{ message: 'renewed=8, failures=["Ok(())"]', location: 'crates/store/tests/public.rs:338', names: ['phys_finish'] }]);
});

test('FS signatures: a cargo failure records a signature from the panic message and location', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    await r.put('README', 'base'); await r.commit();
    const log = "running 1 test\ntest phys_finish ... FAILED\n\nfailures:\n\n---- phys_finish stdout ----\nthread 'phys_finish' (1771435) panicked at crates/store/tests/public.rs:338:5:\nrenewed=8, failures=[]\n\nfailures:\n    phys_finish\n\ntest result: FAILED. 0 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out; finished in 1.00s\n";
    await writeFile(join(r.root, 'cargo.log'), log);
    const plan = { version: 1, trunk: 'main', lease: false, closure: [], invariants: [{ id: 'k', run: `cat '${join(r.root, 'cargo.log')}'; exit 101`, reads: ['**'] }], nodes: [{ id: 'a', writes: ['src/'] }] };
    await ops.init({ cwd: r.cwd, plan: JSON.stringify(plan), as: owner, channel: 'delegated' });
    const obs = entriesOf((await ops.readState({ cwd: r.cwd })).state).find((e): e is ObsEntry => e.kind === 'obs')!;
    assert.deepEqual(obs.failed, ['phys_finish']);
    assert.equal(obs.signatures?.phys_finish, `v2|${JSON.stringify(['renewed=8, failures=[]', 'crates/store/tests/public.rs:338', null, null])}`);
  } finally { await r.cleanup(); }
});

function parsePlanText(text: string): Record<string, unknown> & { invariants: { reads: string[] }[] } {
  return JSON.parse(text);
}
