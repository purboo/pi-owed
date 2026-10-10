// 0.6.1 H2 (plan-guidance): allowance hint on a refused writes widening, check-less node warnings, review packet goal line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';
import { Ledger } from '../src/ledger.ts';
import * as ops from '../src/ops.ts';
import { reduce } from '../src/reducer.ts';
import { reviewPacket } from '../src/views.ts';
import type { Draft, Entry, NodeSpec, Plan } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';
// Owner acts are delegated (no dialog, no TTY prompt) as for the main agent.
delete process.env.OWED_CONFIRM;

type Spec = Record<string, unknown>;
type Result = Awaited<ReturnType<ToolDefinition['execute']>> & { isError?: boolean };
const owner = { role: 'owner' as const, id: 'pi' };
const parent = { role: 'parent' as const, id: 'main' };
const check = (id: string) => ({ id, run: 'true', reads: ['**'] });
const node = (id: string, writes: string[], extra: Spec = {}): Spec => ({ id, writes, checks: [check(`${id}-unit`)], review: { count: 1, min_rank: 1 }, ...extra });
const base = (): Spec => ({ version: 1, trunk: 'main', closure: [], invariants: [], nodes: [node('KB4', ['kb4/']), node('A9-x', ['a9/']), node('q', ['q/'])], allow: [{ nodes: ['q'], writes: ['docs/'] }] });
function edit(p: Spec, id: string, fn: (n: Spec) => void): Spec { const c = structuredClone(p); fn((c.nodes as Spec[]).find(n => n.id === id)!); return c; }
const entries = async (cwd: string): Promise<Entry[]> => (await Ledger.open(cwd)).read();
const text = (r: Result): string => r.content.map(c => c.type === 'text' ? c.text : '').join('\n');
function harness(cwd: string) {
  const tools = new Map<string, ToolDefinition>();
  owed({ registerTool(t: ToolDefinition) { tools.set(t.name, t); }, registerCommand() {} } as unknown as ExtensionAPI);
  const ctx = { cwd, hasUI: false, ui: { async confirm() { throw new Error('no dialog expected'); }, notify() {} } } as unknown as ExtensionContext;
  return { async call(name: string, args: Record<string, unknown>): Promise<Result> {
    return tools.get(`owed_${name}`)!.execute('test', args, undefined, undefined, ctx as Parameters<ToolDefinition['execute']>[4]) as Promise<Result>;
  } };
}
async function fixture(plan: Spec = base()) {
  const r = await repo();
  try { await commitAt(r.cwd, { README: 'x\n' }); await ops.init({ cwd: r.cwd, plan: JSON.stringify(plan), as: owner, channel: 'delegated' }); return r; }
  catch (e) { await r.cleanup(); throw e; }
}

const HINT = 'hint: an allow rule {nodes: ["KB4"], writes: ["app/src/entry/", "package.json"]} in the prior plan would cover this';

test('H2.1 refusal hint: a parent plan update refused only for widened writes adds a ready-to-paste allow rule (ops, CLI, pi)', { timeout: 120_000 }, async () => {
  const r = await fixture();
  try {
    const before = await entries(r.cwd);
    // KB4 widened with two new prefixes outside its writes and every rule; docs/ under q's rule is covered and not named.
    const widened = edit(edit(base(), 'KB4', n => { n.writes = ['kb4/', 'kb4/sub/', 'app/src/entry/', 'package.json']; }), 'q', n => { n.writes = ['q/', 'docs/q/']; });
    await assert.rejects(ops.planSet({ cwd: r.cwd, plan: JSON.stringify(widened), as: parent }), (e: Error) => {
      const lines = e.message.split('\n');
      assert.equal(lines.length, 2, e.message);
      assert.match(lines[0]!, /^Only owner may approve a plan that reduces obligations; not covered by an allowance of the current plan: KB4: writes scope expanded$/);
      assert.equal(lines[1], HINT);
      return true;
    });
    // Two nodes widened: one rule naming both, with each new prefix once.
    const two = edit(edit(base(), 'KB4', n => { n.writes = ['kb4/', 'package.json']; }), 'A9-x', n => { n.writes = ['a9/', 'package.json', 'wiring/']; });
    await assert.rejects(ops.planSet({ cwd: r.cwd, plan: JSON.stringify(two), as: parent }), (e: Error) => e.message.endsWith('\nhint: an allow rule {nodes: ["KB4", "A9-x"], writes: ["package.json", "wiring/"]} in the prior plan would cover this'));
    // Another uncovered downgrade besides writes: no hint.
    const mixed = edit(widened, 'A9-x', n => { n.review = { count: 0, min_rank: 1 }; });
    await assert.rejects(ops.planSet({ cwd: r.cwd, plan: JSON.stringify(mixed), as: parent }), (e: Error) => /A9-x: review count\/rank reduced/.test(e.message) && !e.message.includes('hint:'));
    const removed = edit(widened, 'q', n => { n.checks = []; });
    await assert.rejects(ops.planSet({ cwd: r.cwd, plan: JSON.stringify(removed), as: parent }), (e: Error) => /q-unit check removed/.test(e.message) && !e.message.includes('hint:'));
    // CLI (default principal parent:cli): the hint is the last line of the refusal; nothing recorded.
    await writeFile(join(r.root, 'widened.json'), JSON.stringify(widened));
    const out = await cli(r.cwd, ['plan', join(r.root, 'widened.json')]);
    assert.equal(out.code, 1, out.stderr);
    assert.match(out.stderr, /^Refused: Only owner may approve a plan that reduces obligations; not covered by an allowance of the current plan: KB4: writes scope expanded\n/);
    assert.equal(out.stderr.trimEnd().split('\n').at(-1), HINT);
    // pi: owed_plan as a parent is refused with the same hint line.
    const h = harness(r.cwd);
    const pi = await h.call('plan', { plan: join(r.root, 'widened.json'), as: 'parent:pi' });
    assert.equal(pi.isError, true);
    assert.match(text(pi), /^Refused: Only owner may confirm plan downgrades; not covered by an allowance of the current plan: KB4: writes scope expanded\n/);
    assert.equal(text(pi).split('\n').at(-1), HINT);
    assert.deepEqual(await entries(r.cwd), before, 'refusals record nothing');
    // Pasting the hinted rule into the plan (an owner act) makes the same parent update pass under allowance.
    const ruled = { ...base(), allow: [...(base().allow as Spec[]), { nodes: ['KB4'], writes: ['app/src/entry/', 'package.json'] }] };
    await ops.planSet({ cwd: r.cwd, plan: JSON.stringify(ruled), as: owner, channel: 'delegated', note: 'pre-authorize KB4 entry wiring' });
    const e = await ops.planSet({ cwd: r.cwd, plan: JSON.stringify({ ...widened, allow: ruled.allow }), as: parent });
    assert.equal(e.by, 'parent:main');
  } finally { await r.cleanup(); }
});

const warnPlan = (): Spec => ({ version: 1, trunk: 'main', closure: [], invariants: [], nodes: [
  node('a', ['a/']),
  node('b', ['b/'], { checks: [], title: 'Milestone B' }),
  node('c', ['c/'], { checks: [], evidence: [{ id: 'shot', what: 'a screenshot' }] }),
  node('d', ['d/'], { checks: [] }),
] });
const WARN = (id: string) => `warning: node ${id} has no checks: its acceptance rests on review alone`;

test('H2.2 check-less nodes: CLI init/plan print warnings after the result, JSON returns warnings; nothing refused or recorded for them', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    await r.put('plan.json', JSON.stringify(warnPlan())); await r.commit();
    const init = await cli(r.cwd, ['init', 'plan.json']);
    assert.equal(init.code, 0, init.stderr);
    assert.deepEqual(init.stdout.trimEnd().split('\n').slice(-2), [WARN('b'), WARN('d')], 'after the result, in plan order; c has evidence, a has a check');
    assert.doesNotMatch(init.stdout, /node [ac] has no checks/);
    assert.deepEqual((await entries(r.cwd)).map(e => e.kind), ['genesis']);
    // plan (no downgrade: b gains a check, a new check-less node e is added).
    const next = { ...warnPlan(), nodes: [...(warnPlan().nodes as Spec[]).map(n => n.id === 'b' ? { ...n, checks: [check('b-unit')] } : n), node('e', ['e/'], { checks: [] })] };
    await r.put('next.json', JSON.stringify(next)); await r.commit();
    const plan = await cli(r.cwd, ['plan', 'next.json']);
    assert.equal(plan.code, 0, plan.stderr);
    const lines = plan.stdout.trimEnd().split('\n');
    assert.match(lines[0]!, /updated plan/);
    assert.deepEqual(lines.slice(-2), [WARN('d'), WARN('e')]);
    assert.ok(!plan.stdout.includes(WARN('b')));
    // JSON: warnings array; with no check-less node it is empty.
    const all = { ...next, nodes: (next.nodes as Spec[]).map(n => ({ ...n, checks: [check(`${n.id as string}-unit`)] })) };
    await r.put('all.json', JSON.stringify(all)); await r.put('back.json', JSON.stringify(next)); await r.commit();
    const j = await cli(r.cwd, ['plan', 'all.json', '--json']);
    assert.equal(j.code, 0, j.stderr);
    const ej = JSON.parse(j.stdout) as { kind: string; warnings: string[] };
    assert.equal(ej.kind, 'plan'); assert.deepEqual(ej.warnings, []);
    const k = await cli(r.cwd, ['plan', 'back.json', '--json', '--as', 'owner:pi', '--note', 'drop the extra checks again']);
    assert.equal(k.code, 0, k.stderr);
    assert.deepEqual((JSON.parse(k.stdout) as { warnings: string[] }).warnings, [WARN('d'), WARN('e')]);
    assert.deepEqual((await entries(r.cwd)).map(e => e.kind), ['genesis', 'plan', 'plan', 'plan'], 'the warnings record nothing');
    // init --json on a fresh repository.
    const r2 = await repo();
    try {
      await r2.put('plan.json', JSON.stringify(warnPlan())); await r2.commit();
      const ij = await cli(r2.cwd, ['init', 'plan.json', '--json']);
      assert.equal(ij.code, 0, ij.stderr);
      assert.deepEqual((JSON.parse(ij.stdout) as { warnings: string[] }).warnings, [WARN('b'), WARN('d')]);
    } finally { await r2.cleanup(); }
  } finally { await r.cleanup(); }
});

test('H2.2 check-less nodes: owed_init and owed_plan return warnings and end their text with them', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    await r.put('plan.json', JSON.stringify(warnPlan())); await r.commit();
    const h = harness(r.cwd);
    const init = await h.call('init', { plan: 'plan.json' });
    assert.notEqual(init.isError, true, text(init));
    assert.deepEqual((init.details as { warnings: string[] }).warnings, [WARN('b'), WARN('d')]);
    assert.deepEqual(text(init).split('\n').slice(-2), [WARN('b'), WARN('d')]);
    const next = { ...warnPlan(), nodes: [...(warnPlan().nodes as Spec[]), node('e', ['e/'], { checks: [] })] };
    await r.put('next.json', JSON.stringify(next)); await r.commit();
    const plan = await h.call('plan', { plan: 'next.json' });
    assert.notEqual(plan.isError, true, text(plan));
    assert.equal((plan.details as { kind: string }).kind, 'plan');
    assert.deepEqual((plan.details as { warnings: string[] }).warnings, [WARN('b'), WARN('d'), WARN('e')]);
    assert.deepEqual(text(plan).split('\n').slice(-3), [WARN('b'), WARN('d'), WARN('e')]);
    const all = { ...next, nodes: (next.nodes as Spec[]).map(n => ({ ...n, checks: [check(`${n.id as string}-unit`)] })) };
    await r.put('all.json', JSON.stringify(all)); await r.commit();
    const clean = await h.call('plan', { plan: 'all.json' });
    assert.notEqual(clean.isError, true, text(clean));
    assert.deepEqual((clean.details as { warnings: string[] }).warnings, []);
    assert.doesNotMatch(text(clean), /has no checks/);
  } finally { await r.cleanup(); }
});

test('H2.3 review packet: ok means the goal of the title and brief is met; a report saying it is not is a block', () => {
  const spec: NodeSpec = { id: 'a', deps: [], title: 'Milestone A', brief: 'Ship A.', writes: ['a/'], checks: [], review: { count: 1, min_rank: 1 } };
  const plan: Plan = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: [spec] };
  const list: Entry[] = [];
  const add = (d: Draft): void => { const seq = list.length; list.push({ ...d, seq, ts: new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString(), prev: 'x', hash: `h${seq}` } as Entry); };
  add({ kind: 'genesis', by: 'owner:pi', channel: 'delegated', plan: 'p', trunk: 'main', commit: 's0', state: { commit: 's0', tree: 't0', invKeys: {} } });
  add({ kind: 'dispatch', by: 'parent:main', node: 'a', attempt: 1, base: 's0', branch: 'owed/a/1', worktree: '/repo/.owed/wt/a-1', packet: 'blob', rulings_seen: -1 });
  add({ kind: 'submit', by: 'writer:a#1', node: 'a', attempt: 1, facts: { commit: 'c'.repeat(40), tree: 't1', base: 's0', patch: 'p1', changed: ['a/x'], closureTouched: false, keys: { writes: 'k-w', rulings: 'k-r', review: 'k-v' } } });
  const lines = reviewPacket(reduce(list, () => plan), 'a', 1).split('\n');
  const goal = "--ok means the candidate meets the node's goal as its title and brief state it, not only that the writer's report or evidence is accurate. If the candidate or the writer's report says the goal is not met, record --block (--needs-parent when the goal itself is in question).";
  const at = lines.indexOf(goal);
  assert.ok(at > 0, lines.join('\n'));
  assert.equal(lines.filter(l => l === goal).length, 1);
  assert.ok(at < lines.findIndex(l => l.startsWith('Record each verdict')), 'before the commands');
  assert.ok(lines.includes('# Review Milestone A (node a, attempt 1, reviewer run 1 of 1 for this candidate, n = 1)') && lines.includes('Ship A.'), 'title and brief are in the packet the line refers to');
});
