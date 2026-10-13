import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ops from '../src/ops.ts';
import * as views from '../src/views.ts';
import { reduce, entriesOf } from '../src/reducer.ts';
import { parsePlan } from '../src/plan.ts';
import { Ledger } from '../src/ledger.ts';
import { Dsa } from '../src/dsa.ts';
import { Driver } from '../src/drive-run.ts';
import { decide } from '../src/drive.ts';
import type { Draft, Entry, ObsEntry } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const name = 'marker survives playback';
const owner = { role: 'owner', id: 'pi' } as const, parent = { role: 'parent', id: 'test' } as const;
const writer = { role: 'writer', id: 'a#1' } as const;
function historyRig(nodes: object[] = [{ id: 'fix', brief: `Repair ${name}` }]) {
  const p = parsePlan(JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [{ id: 'suite', run: 'true' }], nodes: [{ id: 'a', writes: ['impl'] }, ...nodes.map(n => ({ writes: ['fix'], ...n }))] }));
  const entries: Entry[] = [];
  const add = (draft: Draft) => { const e = { ...draft, seq: entries.length, ts: '2026-10-13T00:00:00Z', prev: 'x', hash: 'x' } as Entry; entries.push(e); return e; };
  add({ kind: 'genesis', by: 'owner:pi', trunk: 'main', plan: 'p', commit: 'base', state: { commit: 'base', tree: 'tree', invKeys: { suite: 'inv-base' } } });
  add({ kind: 'obs', by: 'executor:owed', subject: 'trunk', obligation: 'inv:suite', key: 'inv-base', verdict: 'pass', exit: 0, durationMs: 1, commit: 'base' });
  const fail = (commit: string, names: string[] | undefined = [name], extra: Partial<ObsEntry> = {}) => add({ kind: 'obs', by: 'executor:owed', subject: 'a', obligation: 'check:runtime', key: `key-${entries.length}`, verdict: 'fail', exit: 1, durationMs: 1, commit, failed: names, ...extra }) as ObsEntry;
  return { p, entries, add, fail, state: () => reduce(entries, () => p) };
}

async function fixture(names: string[] | null = [name], invariant = false, options: { trunkPass?: boolean; sibling?: boolean } = {}) {
  const r = await repo();
  try {
    const failure = names === null ? `echo '# tests 1'; echo '# fail 1'; exit 1` : `echo '${JSON.stringify({ pass: 0, fail: names.length, failed: names }).replace(/^/, 'owed-counts ')}'; exit 1`;
    await commitAt(r.cwd, { impl: 'base', flag: 'clean', 'check.sh': `if grep -q broken flag; then ${invariant || options.trunkPass ? 'if grep -q candidate impl; then ' : ''}${failure}${invariant || options.trunkPass ? '; fi' : ''}; fi\necho '# tests 1'; echo '# pass 1'\n` });
    const check = { id: 'runtime', run: 'bash check.sh', reads: ['impl', 'flag', 'check.sh'], min_tests: 1 };
    const plan = { version: 1, trunk: 'main', lease: false, closure: [], invariants: invariant ? [check] : [], nodes: [{ id: 'a', writes: ['impl'], checks: invariant ? [] : [check] }, { id: 'fix', writes: ['fix'], brief: `Repair ${name}` }, ...(options.sibling ? [{ id: 'b', writes: ['impl', 'extra'] }] : [])] };
    await ops.init({ cwd: r.cwd, plan: JSON.stringify(plan), as: owner, channel: 'delegated' });
    const a = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
    await commitAt(a.worktree, { impl: 'candidate' });
    await ops.submit({ cwd: a.worktree, node: 'a', as: writer });
    assert.equal((await ops.attest({ cwd: r.cwd, node: 'a' })).accepted, true);
    await commitAt(r.cwd, { flag: 'broken' });
    await ops.adopt({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'fixture unrelated trunk change' });
    const ledger = await Ledger.open(r.cwd);
    const state = async () => {
      const es = await ledger.read(), plans = new Map<string, ReturnType<typeof parsePlan>>();
      for (const e of es) if (e.kind === 'genesis' || e.kind === 'plan') plans.set(e.plan, parsePlan((await ledger.getBlob(e.plan)).toString()));
      return reduce(es, sha => plans.get(sha)!);
    };
    return { ...r, a, ledger, state };
  } catch (e) { await r.cleanup(); throw e; }
}

test('FH1: other commits cite the three newest sequences, across subjects and obligations', () => {
  const r = historyRig();
  const older = r.fail('other-1');
  const b = r.fail('other-2', [name], { subject: 'trunk', obligation: 'inv:suite' });
  const c = r.fail('other-3');
  const d = r.fail('other-4');
  r.fail('current');
  r.fail('other-pass', [name], { verdict: 'pass' });
  const current = r.fail('current');
  const lines = views.mergeFailureHints(r.state(), 'a', [current]);
  assert.equal(lines[0], `known intermittent: ${name} also failed on #${d.seq}, #${c.seq}, #${b.seq} (other trees)`);
  assert.ok(!lines[0]!.includes(`#${older.seq}`));
});

test('FH1: failures on only the same commit produce no intermittent hint', () => {
  const r = historyRig([]); r.fail('current'); const current = r.fail('current');
  assert.deepEqual(views.mergeFailureHints(r.state(), 'a', [current]), []);
});

test('FH2: ready, open and accepted candidates match title, brief, run and tests verbatim', () => {
  const r = historyRig([{ id: 'titlefix', title: name }, { id: 'brieffix', brief: name }, { id: 'runfix', checks: [{ id: 'unit', run: `echo '${name}'` }] }, { id: 'testfix', checks: [{ id: 'unit', run: 'true', tests: [name] }] }, { id: 'casefix', brief: name.toUpperCase() }, { id: 'blockedfix', deps: ['a'], brief: name }]);
  // Opening a slot changes its display phase; acceptance remains the reducer's normal result.
  r.add({ kind: 'dispatch', by: 'parent:test', node: 'brieffix', attempt: 1, base: 'base', branch: 'fix', worktree: 'fix', packet: 'p', rulings_seen: -1 });
  r.add({ kind: 'dispatch', by: 'parent:test', node: 'titlefix', attempt: 1, base: 'base', branch: 'title', worktree: 'title', packet: 'p', rulings_seen: -1 });
  r.add({ kind: 'submit', by: 'writer:titlefix#1', node: 'titlefix', attempt: 1, facts: { commit: 'fix-commit', tree: 'tree', base: 'base', patch: 'patch', changed: [], closureTouched: false, keys: { writes: 'writes', rulings: 'rulings' } } });
  r.add({ kind: 'obs', by: 'executor:owed', subject: 'titlefix', obligation: 'writes', key: 'writes', verdict: 'pass', exit: 0, durationMs: 1, commit: 'fix-commit' });
  const current = r.fail('current');
  assert.deepEqual(views.mergeFailureHints(r.state(), 'a', [current]), [
    'fix candidate: titlefix (accepted) — owed resume a --after titlefix',
    'fix candidate: brieffix (dispatched) — owed resume a --after brieffix',
    'fix candidate: runfix (ready) — owed resume a --after runfix',
    'fix candidate: testfix (ready) — owed resume a --after testfix',
  ]);
});

test('FH2/3: short names, merged nodes and the refused node never become fix candidates', () => {
  const r = historyRig([{ id: 'shortfix', brief: 'small' }, { id: 'mergedfix', brief: name }]);
  r.p.nodes[0]!.brief = name;
  r.add({ kind: 'dispatch', by: 'parent:test', node: 'mergedfix', attempt: 1, base: 'base', branch: 'mergedfix', worktree: 'mergedfix', packet: 'p', rulings_seen: -1 });
  const facts = { commit: 'merged', tree: 'tree', base: 'base', patch: 'patch', changed: [], closureTouched: false, keys: { writes: 'merged-writes', rulings: 'merged-rulings' } };
  r.add({ kind: 'submit', by: 'writer:mergedfix#1', node: 'mergedfix', attempt: 1, facts });
  r.add({ kind: 'obs', by: 'executor:owed', subject: 'mergedfix', obligation: 'writes', key: 'merged-writes', verdict: 'pass', exit: 0, durationMs: 1, commit: 'merged' });
  r.add({ kind: 'merge', by: 'executor:owed', node: 'mergedfix', attempt: 1, prior: 'base', commit: 'merged', facts, state: { commit: 'merged', tree: 'tree', invKeys: { suite: 'inv-base' } } });
  const current = r.fail('current', [name, 'small']);
  assert.deepEqual(views.mergeFailureHints(r.state(), 'a', [current]), []);
});

test('FH3: missing failed names add no diagnostic and change no state', () => {
  const r = historyRig(); r.fail('other'); const current = r.fail('current', undefined);
  // The default parameter above is intentionally bypassed for a historical anonymous observation.
  delete current.failed;
  const s = r.state(), before = JSON.stringify(s), ledger = JSON.stringify(entriesOf(s));
  assert.deepEqual(views.mergeFailureHints(s, 'a', [current]), []);
  assert.equal(JSON.stringify(s), before); assert.equal(JSON.stringify(entriesOf(s)), ledger);
});

test('FH3: entries older than the last 5000 are not scanned', () => {
  const r = historyRig([]); r.fail('other');
  for (let i = 0; i < 5000; i++) r.add({ kind: 'note', by: 'parent:test', text: 'padding' });
  const current = r.fail('current');
  assert.deepEqual(views.mergeFailureHints(r.state(), 'a', [current]), []);
});

test('FH1/2/TP1: CLI and why retain diagnostic lines while trunk-red driver parks without a halt', async () => {
  const r = await fixture();
  try {
    const result = await cli(r.cwd, ['merge', 'a', '--as', 'parent:test']);
    assert.equal(result.code, 1, result.stderr);
    const s = await r.state(), failed = entriesOf(s).find((e): e is ObsEntry => e.kind === 'obs' && e.merging === 'a' && e.verdict === 'fail')!;
    const hints = views.mergeFailureHints(s, 'a', [failed]);
    assert.equal(hints.length, 2);
    assert.match(hints[0]!, /^known intermittent: .*also failed on #\d+ \(other trees\)$/);
    const card = await ops.why({ cwd: r.cwd, node: 'a' }), text = views.renderReceipt(card);
    const actions = decide(s, s.plan, new Map(), { max: 1, repairs: 2, project: 'fixture', root: r.cwd, applied: new Set(), rejected: new Map() });
    assert.ok(!actions.some(a => a.do === 'halt'));
    const action = actions.find(a => a.do === 'notify' && a.scope === 'repo');
    assert.ok(action?.do === 'notify'); assert.match(action.text, /without any candidate.*waiting: a/);
    for (const hint of hints) {
      assert.ok(result.stderr.includes(hint), result.stderr); assert.ok(text.includes(hint), text);
      assert.ok(card.blocks.some(b => b.clear.includes(hint)));
    }
    const fakeDir = join(r.root, 'dsa'); await mkdir(fakeDir);
    const driver = new Driver({ cwd: r.cwd, once: true, log: () => {}, dsa: new Dsa({ bin: fileURLToPath(new URL('./fixtures/fake-dsa.mjs', import.meta.url)), env: { FAKE_DSA_DIR: fakeDir } }) });
    await driver.pass();
    assert.ok(!(await r.ledger.read()).some(e => e.kind === 'halt'), 'trunk-red waits without a driver halt');
    assert.ok(!(await r.ledger.read()).some(e => e.kind === 'merge'));
  } finally { await r.cleanup(); }
});

test('FH3: an anonymous merge failure retains the refusal without any hint', async () => {
  // Explicitly select anonymous counts; fixture's default would name the test.
  const r = await fixture(null, false);
  try {
    const result = await cli(r.cwd, ['merge', 'a', '--as', 'parent:test']);
    assert.equal(result.code, 1);
    assert.doesNotMatch(result.stderr, /known intermittent:|fix candidate:/);
    assert.doesNotMatch(views.renderReceipt(await ops.why({ cwd: r.cwd, node: 'a' })), /known intermittent:|fix candidate:/);
  } finally { await r.cleanup(); }
});

test('FH2: a failing merge invariant names the fix candidate in the refusal and why', async () => {
  const r = await fixture([name], true);
  try {
    const result = await cli(r.cwd, ['merge', 'a', '--as', 'parent:test']);
    assert.equal(result.code, 1, result.stderr);
    const hint = 'fix candidate: fix (ready) — owed resume a --after fix';
    assert.ok(result.stderr.includes(hint), result.stderr);
    const before = await r.ledger.read();
    assert.ok(views.renderReceipt(await ops.why({ cwd: r.cwd, node: 'a' })).includes(hint));
    assert.deepEqual(await r.ledger.read(), before, 'why records nothing');
    assert.ok(!before.some(e => e.kind === 'merge'));
  } finally { await r.cleanup(); }
});

const refusalHints = (text: string) => text.split('; ').map(line => line.trim()).filter(line => /^(known intermittent|fix candidate):/.test(line));

test('FH review #1619: retrying an ordinary merge-check block preserves all refusal hints', async () => {
  const r = await fixture([name], false, { trunkPass: true });
  try {
    assert.equal((await cli(r.cwd, ['merge', 'a', '--as', 'parent:test'])).code, 1);
    // Confirm the first merge failure on its original tree, then fail on a different merge tree.
    assert.equal((await ops.attest({ cwd: r.cwd, node: 'a' })).accepted, true);
    await commitAt(r.cwd, { flag: 'broken again' });
    await ops.adopt({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'fixture second ordinary failure tree' });
    const first = await cli(r.cwd, ['merge', 'a', '--as', 'parent:test']);
    assert.equal(first.code, 1, first.stderr);
    assert.doesNotMatch(first.stderr, /trunk-red:/);
    const hints = refusalHints(first.stderr);
    assert.equal(hints.length, 2, first.stderr);
    assert.match(hints[0]!, /^known intermittent:/);
    assert.equal(hints[1], 'fix candidate: fix (ready) — owed resume a --after fix');
    const s = await r.state();
    assert.equal(s.nodes.a!.accepted, false);
    assert.ok(s.nodes.a!.blocks.some(b => b.state === 'active' && b.obligation === 'check:runtime'));
    const before = await r.ledger.read();
    const retry = await cli(r.cwd, ['merge', 'a', '--as', 'parent:test']);
    assert.equal(retry.code, 1, retry.stderr);
    assert.match(retry.stderr, /not yet accepted/);
    assert.deepEqual(refusalHints(retry.stderr), hints);
    for (const hint of hints) assert.ok(views.renderReceipt(await ops.why({ cwd: r.cwd, node: 'a' })).includes(hint));
    assert.deepEqual(await r.ledger.read(), before, 'retry and why do not remeasure or record anything');
  } finally { await r.cleanup(); }
});

test('FH review #1619: a reused invariant failure names identical hints for the current node in merge and why', async () => {
  const r = await fixture([name], true, { sibling: true });
  try {
    assert.equal((await cli(r.cwd, ['merge', 'a', '--as', 'parent:test'])).code, 1);
    await commitAt(r.cwd, { flag: 'broken again' });
    await ops.adopt({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'fixture second invariant failure tree' });
    assert.equal((await cli(r.cwd, ['merge', 'a', '--as', 'parent:test'])).code, 1);
    const b = await ops.dispatch({ cwd: r.cwd, node: 'b', as: parent, allowOverlap: true });
    await commitAt(b.worktree, { impl: 'candidate', extra: 'outside invariant reads' });
    await ops.submit({ cwd: b.worktree, node: 'b', as: { role: 'writer', id: 'b#1' } });
    assert.equal((await ops.attest({ cwd: r.cwd, node: 'b' })).accepted, true);
    const result = await cli(r.cwd, ['merge', 'b', '--as', 'parent:test']);
    assert.equal(result.code, 1, result.stderr);
    const hints = refusalHints(result.stderr);
    assert.equal(hints.length, 2, result.stderr);
    assert.match(hints[0]!, /^known intermittent:/);
    assert.equal(hints[1], 'fix candidate: fix (ready) — owed resume b --after fix');
    const before = await r.ledger.read();
    assert.equal(before.filter(e => e.kind === 'obs' && e.merging === 'b').length, 0, 'B reused the invariant verdict without measuring');
    const deciding = before.findLast((e): e is ObsEntry => e.kind === 'obs' && e.merging === 'a' && e.obligation === 'inv:runtime' && e.verdict === 'fail')!;
    const card = await ops.why({ cwd: r.cwd, node: 'b' });
    for (const hint of hints) assert.ok(views.renderReceipt(card).includes(hint), views.renderReceipt(card));
    assert.ok(card.mergeChecks?.some(i => i.key === deciding.key && i.evidence.includes(deciding.seq)));
    assert.deepEqual(await r.ledger.read(), before, 'why only projects the deciding evidence');
  } finally { await r.cleanup(); }
});
