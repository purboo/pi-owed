import test from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../src/canon.ts';
import { parsePlan } from '../src/plan.ts';
import { reduce, retainedPlanValues } from '../src/reducer.ts';
import { needs } from '../src/needs.ts';
import { quarantineDebt, receipt, renderStatus, renderWhy, statusView } from '../src/views.ts';
import type { Draft, Entry, Plan } from '../src/types.ts';

const commit = '1'.repeat(40), now = Date.parse('2026-10-18T00:00:00Z');
function ledger() {
  const entries: Entry[] = [];
  const add = (draft: Draft): Entry => {
    const seq = entries.length;
    const entry = { ...draft, seq, ts: new Date(now + seq * 1000).toISOString(), prev: entries.at(-1)?.hash ?? '0'.repeat(64), hash: sha256(String(seq)) } as Entry;
    entries.push(entry); return entry;
  };
  const genesis = (plan: string, invKeys: Record<string, string> = {}) => add({ kind: 'genesis', by: 'owner:pi', channel: 'delegated', plan, trunk: 'main', commit, state: { commit, tree: commit, invKeys } });
  return { entries, add, genesis };
}
function frozen<T>(value: T): T {
  if (value && typeof value === 'object') { for (const child of Object.values(value)) frozen(child); Object.freeze(value); }
  return value;
}
function haltFixture() {
  const plan = parsePlan(JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [], nodes: [{ id: 'a', writes: ['a/'], checks: [{ id: 'x', run: 'true' }] }] }));
  const l = ledger(); l.genesis('p');
  l.add({ kind: 'dispatch', by: 'parent:drive', node: 'a', attempt: 1, base: commit, branch: 'owed/a/1', worktree: '/wt/a', packet: 'blob', rulings_seen: -1 });
  l.add({ kind: 'halt', by: 'parent:drive', node: 'a', attempt: 1, needs: 'human', reason: 'attest recorded no verdict twice: check:x (#5 git worktree: a\nerror: b\r\nfatal: c\n' });
  return { ...l, state: reduce(l.entries, () => plan) };
}
const haltText = 'driver halted: attest recorded no verdict twice: check:x (git worktree: a\\nerror: b\\r\\nfatal: c; after resume the driver continues from the current state';

test('WF1: a driver halt with multiline evidence yields escaped one-line resume need text', () => {
  const f = haltFixture(), ns = needs(f.state, 'a');
  assert.equal(ns.length, 1); assert.equal(ns[0]!.kind, 'resume'); assert.equal(ns[0]!.command, 'owed resume a');
  assert.doesNotMatch(ns[0]!.text, /[\n\r]/);
  assert.ok(ns[0]!.text.includes('\\n')); assert.ok(ns[0]!.text.includes('\\r'));
  assert.equal(ns[0]!.text, haltText);
});

test('WF1: the status Needs-you row is one physical line ending in owed resume', () => {
  const f = haltFixture(), view = statusView(f.state, f.entries, [], now, true);
  const output = renderStatus(view), rows = output.split('\nIn progress')[0]!.split('\n').filter(line => line.startsWith('  a: '));
  assert.equal(rows.length, 1); assert.doesNotMatch(rows[0]!, /[\n\r]/);
  assert.match(rows[0]!, / → owed resume a$/);
  assert.equal(rows[0], `  a: ${haltText} → owed resume a`);
});

test('WF1: the compact why headline is one physical line with resume and the unchanged outstanding suffix', () => {
  const f = haltFixture(), headline = renderWhy(receipt(f.state, f.entries, 'a')).split('\n')[0]!;
  // R-028-76 (#3366): preserve renderWhy's existing outstanding suffix, without deriving the expectation from needs().
  assert.doesNotMatch(headline, /[\n\r]/);
  assert.equal(headline, `a: ${haltText} → owed resume a; nothing outstanding`);
});

test('WF2: quarantineDebt without quarantine makes zero historical plan lookups after reduce', () => {
  const l = ledger(), plans = new Map<string, Plan>(); let prior = '';
  // Twelve frozen versions exceed trimPlans' current + four historical plans. Only early laws have observations.
  for (let i = 0; i < 12; i++) {
    const sha = sha256(`plan-${i}`), plan = frozen(parsePlan(JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [{ id: 'unit', run: 'true' }], nodes: [{ id: 'a', title: `version ${i}`, writes: ['a/'] }] })));
    plans.set(sha, plan);
    if (i === 0) l.genesis(sha, { unit: 'current-key' });
    else l.add({ kind: 'plan', by: 'owner:pi', channel: 'delegated', prior, plan: sha, downgrades: [] });
    if (i < 2) l.add({ kind: 'obs', by: 'executor:owed', subject: 'trunk', obligation: 'inv:unit', key: `old-key-${i}`, verdict: 'error', exit: null, durationMs: 1, commit });
    prior = sha;
  }
  let lookups = 0;
  const state = reduce(l.entries, sha => { lookups++; const plan = plans.get(sha); assert.ok(plan, sha); return plan; });
  assert.ok(lookups >= plans.size, 'reduce actually loaded every plan version');
  assert.ok(retainedPlanValues(state) <= 5, 'deep-frozen historical plans were evicted');
  lookups = 0;
  assert.deepEqual(quarantineDebt(state), []);
  assert.equal(lookups, 0, 'no quarantine must not reload evicted early observation plans');
});

test('WF2: active invariant and check quarantine preserve full passing debt receipts', () => {
  const q = [{ test: 'flaky one', fix: 'fix', note: 'recorded race' }];
  const plan = frozen(parsePlan(JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [{ id: 'unit', run: 'node --test test/unit.test.ts', quarantine: q }], nodes: [{ id: 'fix', writes: ['fix/'] }, { id: 'a', writes: ['a/'], checks: [{ id: 'unit', run: 'cargo test --no-fail-fast', quarantine: q }] }] })));
  const l = ledger(); l.genesis('p', { unit: 'inv-key' });
  const inv = l.add({ kind: 'obs', by: 'executor:owed', subject: 'trunk', obligation: 'inv:unit', key: 'inv-key', verdict: 'pass', exit: 0, durationMs: 1, commit, quarantine_passed: ['flaky one'] });
  const check = l.add({ kind: 'obs', by: 'executor:owed', subject: 'a', obligation: 'check:unit', key: 'check-key', verdict: 'pass', exit: 0, durationMs: 1, commit: '2'.repeat(40), batch: ['a', 'fix'], quarantine_passed: ['flaky one'] });
  // Later non-TAP/error observations must not hide the recorded passing quarantine receipts.
  for (const subject of ['trunk', 'a']) l.add({ kind: 'obs', by: 'executor:owed', subject, obligation: subject === 'trunk' ? 'inv:unit' : 'check:unit', key: 'irrelevant-key', verdict: 'error', exit: null, durationMs: 1, commit, ...(subject === 'a' ? { batch: ['a', 'fix'] } : {}) });
  const state = reduce(l.entries, () => plan);
  const expected = [
    { where: 'unit', test: 'flaky one', fix: 'fix', note: 'recorded race', passed: { seq: inv.seq, commit } },
    { where: 'a/unit', test: 'flaky one', fix: 'fix', note: 'recorded race', passed: { seq: check.seq, commit: '2'.repeat(40), batch: ['a', 'fix'] } },
  ];
  assert.deepEqual(quarantineDebt(state), expected);
  assert.deepEqual(quarantineDebt(state, 'fix'), expected);
  assert.deepEqual(quarantineDebt(state, 'a'), []);
});
