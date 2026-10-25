// F3 (0.11, field report #34, #12): a waiver with accept_risk reaches the block it names, merge keys included; the merge then
// succeeds on a pass on that key; seqs of another node or obligation are refused; candidate-key waivers are unchanged.
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import { repo } from './helpers/repo.ts';
import { commitAt } from './helpers/surface.ts';
import { Ledger } from '../src/ledger.ts';
import * as ops from '../src/ops.ts';
import type { ObsEntry } from '../src/types.ts';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';

const tap = (tests: number, pass: number, fail: number): string => `echo '# tests ${tests}'; echo '# pass ${pass}'; echo '# fail ${fail}'`;
const PASS = tap(1, 1, 0), FAIL = `${tap(1, 0, 1)}; exit 1`;
const owner = { as: { role: 'owner' as const, id: 'pi' }, channel: 'delegated' as const };
const parent = { role: 'parent' as const, id: 'main' };

/**
 * a: check unit reads src/ and fails when src/b exists (b merged first) unless the flag file exists, so its candidate key
 * passes and its merge key fails (an environment-like false fail on a merge key, field report #34).
 * b: always passes. c: unit fails until the flag exists (candidate-key flaky), lint always fails. d: always fails.
 */
const plan = (flag: string) => JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [], nodes: [
  { id: 'a', writes: ['src/a'], checks: [{ id: 'unit', run: `if [ -e src/b ] && [ ! -e '${flag}' ]; then ${FAIL}; else ${PASS}; fi`, reads: ['src/'] }], review: { count: 0, min_rank: 1 } },
  { id: 'b', writes: ['src/b'], checks: [{ id: 'unit', run: PASS }], review: { count: 0, min_rank: 1 } },
  { id: 'c', writes: ['src/c'], checks: [{ id: 'unit', run: `if [ -e '${flag}' ]; then ${PASS}; else ${FAIL}; fi` }, { id: 'lint', run: FAIL }], review: { count: 0, min_rank: 1 } },
  { id: 'd', writes: ['src/d'], checks: [{ id: 'unit', run: FAIL }], review: { count: 0, min_rank: 1 } },
] });

async function fixture(ids: string[]) {
  const x = await repo();
  try {
    const flag = join(x.root, 'flag');
    await commitAt(x.cwd, { 'plan.json': plan(flag), README: 'x\n' });
    await ops.init({ cwd: x.cwd, plan: plan(flag), as: { role: 'owner', id: 'human' }, channel: 'flag' });
    const slots: Record<string, string> = {};
    for (const id of ids) {
      const d = await ops.dispatch({ cwd: x.cwd, node: id, as: parent });
      slots[id] = d.worktree;
      await commitAt(d.worktree, { [`src/${id}`]: `${id}\n` });
      await ops.submit({ cwd: d.worktree, node: id, as: { role: 'writer', id: `${id}#1` } });
      await ops.attest({ cwd: x.cwd, node: id });
    }
    return { x, flag, slots };
  } catch (e) { await x.cleanup(); throw e; }
}
const entries = async (cwd: string) => (await Ledger.open(cwd)).read();
const obs = async (cwd: string, node: string, obligation = 'check:unit') => (await entries(cwd)).filter((e): e is ObsEntry => e.kind === 'obs' && e.subject === node && e.obligation === obligation);
const item = async (cwd: string, node: string, obligation = 'check:unit') => (await ops.why({ cwd, node })).items.find(i => i.obligation === obligation)!;

/** b merged, then a's merge fails on its merge key: returns the failing merge observation (the block). */
async function mergeKeyFail(cwd: string) {
  await ops.merge({ cwd, node: 'b', as: parent });
  await assert.rejects(ops.merge({ cwd, node: 'a', as: parent }), /still has active blocks|unsatisfied/);
  const fails = (await obs(cwd, 'a')).filter(e => e.verdict === 'fail' && e.merging === 'a');
  assert.equal(fails.length, 1, 'one failing merge-key observation');
  const cand = (await ops.status({ cwd })).nodes.a!.candidate!;
  assert.notEqual(fails[0]!.key, cand.keys['check:unit'], 'the merge key differs from the candidate key');
  return { fail: fails[0]!, cand };
}

test('F3.1/F3.2: a waiver clears a flaky block on a merge key, and the merge then succeeds on the pass there (field report #1802/#1816/#1819)', { timeout: 300_000 }, async () => {
  const { x, flag } = await fixture(['a', 'b']);
  try {
    const { fail, cand } = await mergeKeyFail(x.cwd);
    // The environment is fixed; the attribution rerun on the same merge key passes: the block is flaky, the key ⊤.
    await writeFile(flag, '');
    await ops.attest({ cwd: x.cwd, node: 'a' });
    const rerun = (await obs(x.cwd, 'a')).find(e => e.attribution && e.key === fail.key);
    assert.equal(rerun?.verdict, 'pass');
    assert.equal((await ops.why({ cwd: x.cwd, node: 'a' })).blocks.find(b => b.seq === fail.seq)?.state, 'flaky');
    // WK1: the owner waiver names and covers the current merge-key block.
    const w = await ops.waive({ cwd: x.cwd, node: 'a', obligation: 'check:unit', reason: 'stale artifact', accept_risk: [fail.seq], ...owner });
    assert.equal(w.kind === 'waive' && w.key, fail.key);
    const card = await ops.why({ cwd: x.cwd, node: 'a' });
    assert.equal(card.blocks.some(b => b.seq === fail.seq), false, 'the merge-key block is cleared');
    assert.equal(card.accepted, true);
    // The merge succeeds: the waived fail no longer conflicts with the pass on its key.
    const before = (await obs(x.cwd, 'a')).length;
    const m = await ops.merge({ cwd: x.cwd, node: 'a', as: parent });
    assert.equal(m.entry.kind, 'merge');
    assert.equal((await obs(x.cwd, 'a')).length, before, 'the merge key already had a counted pass: nothing measured again');
    assert.equal((await ops.status({ cwd: x.cwd })).nodes.a!.phase, 'merged');
  } finally { await x.cleanup(); }
});

test('WK1/F3.2: a waived active merge-key block without a pass merges without another measurement', { timeout: 300_000 }, async () => {
  const { x, flag } = await fixture(['a', 'b']);
  try {
    const { fail } = await mergeKeyFail(x.cwd);
    await ops.waive({ cwd: x.cwd, node: 'a', obligation: 'check:unit', reason: 'environment', accept_risk: [fail.seq], ...owner });
    await writeFile(flag, '');
    const m = await ops.merge({ cwd: x.cwd, node: 'a', as: parent });
    assert.equal(m.entry.kind, 'merge');
    const again = (await obs(x.cwd, 'a')).filter(e => e.key === fail.key && e.seq > fail.seq);
    assert.deepEqual(again, [], 'WK1 covers the merge key without another measurement');
  } finally { await x.cleanup(); }
});

test('WK1/F3.2: a changed merge key measured again and failing again still refuses the merge with a new block', { timeout: 300_000 }, async () => {
  const { x, flag, slots } = await fixture(['a', 'b']);
  try {
    const { fail } = await mergeKeyFail(x.cwd);
    const waiver = await ops.waive({ cwd: x.cwd, node: 'a', obligation: 'check:unit', reason: 'environment', accept_risk: [fail.seq], ...owner });
    assert.equal(waiver.kind === 'waive' && waiver.key,fail.key);
    await commitAt(slots.a!,{'src/a':'changed candidate reads'});
    await ops.submit({cwd:slots.a!,node:'a',as:{role:'writer',id:'a#1'}});
    await writeFile(flag,''); await ops.attest({cwd:x.cwd,node:'a'});
    await (await import('node:fs/promises')).rm(flag);
    await assert.rejects(ops.merge({ cwd: x.cwd, node: 'a', as: parent }), /still has active blocks|unsatisfied/);
    const fails = (await obs(x.cwd, 'a')).filter(e => e.verdict === 'fail' && e.merging === 'a');
    assert.equal(fails.length, 2); assert.notEqual(fails[1]!.key,fail.key);
    const card = await ops.why({ cwd: x.cwd, node: 'a' });
    assert.ok(card.blocks.some(b => b.seq === fails[1]!.seq && b.state === 'active'), 'the new fail is an active block');
    assert.equal(card.accepted, false);
    assert.notEqual((await ops.status({ cwd: x.cwd })).nodes.a!.phase, 'merged');
  } finally { await x.cleanup(); }
});

test('F3.1/ID1: foreign or differently judged cleared risks refuse; an identical waiver retry succeeds', { timeout: 300_000 }, async () => {
  const { x } = await fixture(['c', 'd']);
  try {
    const unit = (await obs(x.cwd, 'c')).find(e => e.verdict === 'fail')!, lint = (await obs(x.cwd, 'c', 'check:lint')).find(e => e.verdict === 'fail')!;
    const other = (await obs(x.cwd, 'd')).find(e => e.verdict === 'fail')!;
    assert.ok(unit && lint && other);
    const waive = (accept_risk: number[]) => ops.waive({ cwd: x.cwd, node: 'c', obligation: 'check:unit', reason: 'r', accept_risk, ...owner });
    const n = (await entries(x.cwd)).length;
    await assert.rejects(waive([other.seq]), /accept_risk must reference active blocks/);
    await assert.rejects(waive([lint.seq]), /accept_risk must reference active blocks/);
    await assert.rejects(waive([unit.seq, other.seq]), /accept_risk must reference active blocks/);
    assert.equal((await entries(x.cwd)).length, n, 'nothing recorded');
    // ID1: the exact retry accepts no additional risk and appends nothing; a changed judgment still refuses.
    const recorded = await waive([unit.seq]);
    assert.equal((await ops.why({ cwd: x.cwd, node: 'c' })).blocks.some(b => b.seq === unit.seq), false);
    const beforeRetry = await entries(x.cwd);
    assert.equal((await waive([unit.seq])).seq, recorded.seq);
    assert.deepEqual(await entries(x.cwd), beforeRetry);
    await assert.rejects(ops.waive({ cwd:x.cwd, node:'c', obligation:'check:unit', reason:'different judgment', accept_risk:[unit.seq], ...owner }), /accept_risk must reference active blocks/);
  } finally { await x.cleanup(); }
});

test('F3: candidate-key waivers are unchanged: the item is waived (W, not measured), the fail stays counted, nothing is measured again', { timeout: 300_000 }, async () => {
  const { x, flag } = await fixture(['c']);
  try {
    const unit = (await obs(x.cwd, 'c')).find(e => e.verdict === 'fail')!;
    await writeFile(flag, '');
    await ops.attest({ cwd: x.cwd, node: 'c' });
    assert.equal((await ops.why({ cwd: x.cwd, node: 'c' })).blocks.find(b => b.seq === unit.seq)?.state, 'flaky');
    assert.equal((await item(x.cwd, 'c')).mark, '⊤', 'pass and fail on the candidate key conflict');
    const w = await ops.waive({ cwd: x.cwd, node: 'c', obligation: 'check:unit', reason: 'flaky runner', accept_risk: [unit.seq], ...owner });
    const i = await item(x.cwd, 'c');
    assert.equal(i.status, 'W'); assert.equal(i.mark, '⚠');
    assert.ok(i.evidence.includes(unit.seq) && i.evidence.includes(w.seq), JSON.stringify(i.evidence));
    const n = (await obs(x.cwd, 'c')).length;
    await ops.attest({ cwd: x.cwd, node: 'c' });
    assert.equal((await obs(x.cwd, 'c')).length, n, 'the waived key is not measured again');
    // F3.3 (#12): the result text says plainly that the obligation is no longer measured on that key.
    const meaning = await ops.waiverMeaning({ cwd: x.cwd, entry: w });
    const k12 = (w.kind === 'waive' ? w.key : '').slice(0, 12);
    assert.ok(meaning.endsWith(`; --accept-risk clears #${unit.seq} whatever its key, and check:unit is no longer measured on key ${k12}`), meaning);
  } finally { await x.cleanup(); }
});

test('F3.3: the accept-risk result text names a merge-key block and what the merge does with it; the confirmation says it too', { timeout: 300_000 }, async () => {
  const { x } = await fixture(['a', 'b']);
  const prior = process.env.OWED_CONFIRM;
  try {
    const { fail } = await mergeKeyFail(x.cwd);
    // pi tool under the confirmation gate: the dialog text says what accept-risk does.
    const tools = new Map<string, ToolDefinition>();
    owed({ registerTool(t: ToolDefinition) { tools.set(t.name, t); }, registerCommand() {} } as unknown as ExtensionAPI);
    process.env.OWED_CONFIRM = 'owner';
    const asked: string[] = [];
    const ui = { confirm: async (title: string, body: string) => { asked.push(`${title}\n${body}`); return true; }, select: async () => undefined, input: async () => undefined, notify: () => {} };
    const res = await tools.get('owed_waive')!.execute('test', { node: 'a', obligation: 'check:unit', reason: 'environment', accept_risk: [fail.seq] }, undefined, undefined, { cwd: x.cwd, hasUI: true, ui } as unknown as Parameters<ToolDefinition['execute']>[4]);
    assert.notEqual(res.isError, true, JSON.stringify(res.content));
    assert.match(asked.join('\n'), /The accepted blocks are cleared whatever their key \(a merge-key fail no longer counts against the merge\), and check:unit is no longer measured on the waived key\./);
    const meaning = (res.details as { meaning: string }).meaning;
    assert.match(meaning, new RegExp(`^waived a/check:unit on merge key ${fail.key.slice(0,12)}: environment; in effect now: --accept-risk accepts #${fail.seq}; check:unit on the candidate key is satisfied by #\\d+; this waiver applies only to that key, not the candidate key [0-9a-f]{12}; changes to check definition, setup, exec, closure or reads change the key and require measurement again$`), meaning);
  } finally { if (prior === undefined) delete process.env.OWED_CONFIRM; else process.env.OWED_CONFIRM = prior; await x.cleanup(); }
});
