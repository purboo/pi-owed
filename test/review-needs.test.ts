// D18: review blocks that need a parent ruling halt the driver instead of being repaired.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { sha256 } from '../src/canon.ts';
import { decide, needsRulingHalt, repairMessage, reviewerLaunch, writerLaunch, type Action, type DriveOpts } from '../src/drive.ts';
import { reduce, runId, entriesOf, halted, validateDraft, parentRuling } from '../src/reducer.ts';
import { receipt, renderReceipt, renderStatus, reviewPacket, statusView } from '../src/views.ts';
import owed from '../src/extension.ts';
import { Ledger } from '../src/ledger.ts';
import * as ops from '../src/ops.ts';
import type { CandidateFacts, Draft, Entry, NodeSpec, Plan, RunView, State } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

// ---------- synthetic ledger rig (no git), as in test/drive.test.ts ----------
const P = 'hash0';
const W = runId(P, 'a', 1, 'writer'), R1 = runId(P, 'a', 1, 'reviewer', 1);
const T0 = Date.UTC(2026, 0, 1);
const spec = (o: Partial<NodeSpec> & { id: string }): NodeSpec => ({ deps: [], writes: [`${o.id}/`], checks: [], review: { count: 0, min_rank: 1 }, ...o });
const plan: Plan = { version: 1, trunk: 'main', closure: ['closure/'], invariants: [], nodes: [
  spec({ id: 'a', title: 'Node A', brief: 'Do A.', checks: [{ id: 'unit', run: 'npm test', timeout_s: 60, reads: ['a/**'] }], review: { count: 1, min_rank: 1 } }),
  spec({ id: 'c' }),
], drive: { max: 4, repairs: 2, writer: { agent: 'worker' }, reviewer: { agent: 'reviewer' } } };
const DRIVER = 'reviewer:drive-a-1-1';

function rig() {
  const entries: Entry[] = [], blobs = new Map<string, string>();
  const state = (): State => reduce(entries, () => plan);
  const add = (d: Draft): Entry => { const seq = entries.length, e = { ...d, seq, ts: new Date(T0 + seq * 1000).toISOString(), prev: 'x', hash: `hash${seq}` } as Entry; entries.push(e); state(); return e; };
  const blob = (text: string): string => { const h = sha256(text); blobs.set(h, text); return h; };
  add({ kind: 'genesis', by: 'owner:human', channel: 'tty', plan: 'p', trunk: 'main', commit: 's0', state: { commit: 's0', tree: 't0', invKeys: {} } });
  const facts = (tag: string): CandidateFacts => ({ commit: `ac${tag}`, tree: `t${tag}`, base: 's0', patch: `p${tag}`, changed: ['a/x'], closureTouched: false,
    keys: Object.fromEntries(['check:unit', 'writes', 'rulings', 'review'].map(o => [o, `a-${o}-${tag}`])) });
  const r = {
    entries, blobs, state, add,
    dispatch() { return add({ kind: 'dispatch', by: 'parent:drive', node: 'a', attempt: 1, base: 's0', branch: 'owed/a/1', worktree: '/repo/.owed/wt/a-1', packet: 'blob', rulings_seen: Math.max(-1, ...state().rules.map(x => x.seq)) }); },
    launchWriter() { const a = writerLaunch(state(), 'a', P); return add({ kind: 'launch', by: 'parent:drive', node: 'a', attempt: 1, role: 'writer', rid: a.rid, spec: blob(a.spec), labels: a.labels }); },
    launchReviewer(n: number) { const a = reviewerLaunch(state(), 'a', n, P, '/repo'); return add({ kind: 'launch', by: 'parent:drive', node: 'a', attempt: 1, role: 'reviewer', rid: a.rid, spec: blob(a.spec), labels: a.labels }); },
    send(rid: string, reason: 'repair' | 'submit', message: string) { return add({ kind: 'send', by: 'parent:drive', node: 'a', attempt: 1, rid, send: `${rid}:follow-up:${entries.length}`, sendKind: 'follow-up', message: blob(message), reason }); },
    submit(tag = '1') { return add({ kind: 'submit', by: 'writer:a#1', node: 'a', attempt: 1, facts: facts(tag) }); },
    pass() { const c = state().nodes.a!.candidate!; for (const o of ['check:unit', 'writes']) add({ kind: 'obs', by: 'executor:owed', subject: 'a', obligation: o, key: c.keys[o]!, verdict: 'pass', exit: 0, durationMs: 1, commit: c.commit, base: c.base }); },
    review(verdict: 'ok' | 'block', o: { by?: string; rank?: number; needs?: 'parent'; note?: string } = {}) {
      const c = state().nodes.a!.candidate!;
      return add({ kind: 'review', by: o.by ?? DRIVER, node: 'a', attempt: 1, obligation: 'review', key: c.keys.review!, verdict, rank: o.rank ?? 1, note: o.note ?? 'n', ...(o.needs ? { needs: o.needs } : {}) });
    },
    rule(text: string, nodes: string[] | '*' = ['a']) { return add({ kind: 'rule', by: 'parent:main', text, nodes }); },
    halt(a: Extract<Action, { do: 'halt' }>) { return add({ kind: 'halt', by: 'parent:drive', node: a.node, attempt: a.attempt, reason: a.reason, needs: a.needs }); },
  };
  return r;
}
type Rig = ReturnType<typeof rig>;
const runs = new Map<string, RunView>([[W, { rid: W, state: 'sealed', status: 'ok' }], [R1, { rid: R1, state: 'sealed', status: 'ok' }]]);
const optsOf = (r: Rig, o: Partial<DriveOpts> = {}): DriveOpts => ({ max: 4, repairs: 2, project: P, root: '/repo', applied: new Set(r.entries.flatMap(e => e.kind === 'send' ? [e.send] : [])), rejected: new Map(), blobs: r.blobs, ...o });
const act = (r: Rig, o: Partial<DriveOpts> = {}): Action | undefined => { const s = r.state(), mine = decide(s, s.plan, runs, optsOf(r, o)).filter(x => x.node === 'a'); assert.ok(mine.length <= 1, JSON.stringify(mine)); return mine[0]; };
/** Candidate 1 measured, reviewer run 1 sealed after recording a block (needs parent unless `needs` is false). */
function blocked(o: { needs?: boolean; note?: string; before?: (r: Rig) => void } = {}) {
  const r = rig(); o.before?.(r); r.dispatch(); r.launchWriter(); r.submit(); r.pass(); r.launchReviewer(1);
  const block = r.review('block', { needs: o.needs === false ? undefined : 'parent', note: o.note ?? 'brief says X, plan says Y: which one?' });
  return { r, block };
}
const why = (s: State): string => renderReceipt(receipt(s, entriesOf(s), 'a'));
const haltReason = (seq: number, note = 'brief says X, plan says Y: which one?') => `review block #${seq} review needs a parent ruling: ${note}; record \`owed rule --nodes a "<decision>"\`, then the driver repairs with the ruling`;

test('reducer: a block with needs parent is copied to the Block; ok + needs is refused; old entries carry no needs', () => {
  const { r, block } = blocked();
  const s = r.state(), b = s.nodes.a!.blocks.find(x => x.seq === block.seq)!;
  assert.equal(b.needs, 'parent');
  assert.equal(b.state, 'active');
  const plain = blocked({ needs: false }).r.state().nodes.a!.blocks[0]!;
  assert.equal('needs' in plain, false, 'absent needs stays absent');
  const c = s.nodes.a!.candidate!;
  const base = { kind: 'review' as const, by: 'reviewer:other', node: 'a', attempt: 1, obligation: 'review' as const, key: c.keys.review!, rank: 1, note: 'x' };
  assert.deepEqual(validateDraft(s, { ...base, verdict: 'ok', needs: 'parent' }), ["review needs must be 'parent' and only on a block verdict"]);
  assert.deepEqual(validateDraft(s, { ...base, verdict: 'block', needs: 'owner' as 'parent' }), ["review needs must be 'parent' and only on a block verdict"]);
  assert.deepEqual(validateDraft(s, { ...base, verdict: 'block', needs: 'parent' }), []);
  assert.throws(() => r.review('ok', { by: 'reviewer:other', needs: 'parent' }), /only on a block verdict/);
});

test('decide: a current needs-parent block halts needing a human; no repair is sent or counted', () => {
  const { r, block } = blocked();
  const a = act(r);
  assert.deepEqual(a, { do: 'halt', node: 'a', attempt: 1, reason: haltReason(block.seq), needs: 'human' });
  assert.equal(needsRulingHalt(r.state(), 'a', [r.state().nodes.a!.blocks[0]!]), haltReason(block.seq));
  // Even with the repairs cap at 0 the reason is the ruling, not "repairs exhausted".
  assert.deepEqual(act(r, { repairs: 0 }), a);
  assert.equal(r.entries.filter(e => e.kind === 'send').length, 0);
  // Recorded, the halt stops the driver on the attempt.
  r.halt(a as Extract<Action, { do: 'halt' }>);
  assert.equal(act(r), undefined);
  // Without needs the same block is a repair (unchanged behavior).
  const plain = blocked({ needs: false }).r;
  assert.equal((act(plain) as { reason?: string }).reason, 'repair');
});

test('a ruling naming the node after the block clears the halt and turns the block into a repair carrying the ruling', () => {
  const { r, block } = blocked();
  r.halt(act(r) as Extract<Action, { do: 'halt' }>);
  const rule = r.rule('Y wins: follow the plan');
  const s = r.state();
  assert.equal(halted(s, 'a'), undefined, 'the node-named ruling clears the halt (D3)');
  assert.equal(parentRuling(s, s.nodes.a!.blocks[0]!)?.seq, rule.seq);
  const a = act(r, { repairs: 1 });
  assert.ok(a?.do === 'send' && a.reason === 'repair' && a.sendKind === 'follow-up' && a.rid === W, JSON.stringify(a));
  assert.equal(a.message, repairMessage(s, 'a'));
  assert.ok(a.message.includes(`Rulings since dispatch:\n- #${rule.seq} Y wins: follow the plan`), a.message);
  assert.ok(a.message.includes(`- #${block.seq} review by ${DRIVER} rank 1 (needed a parent ruling: see #${rule.seq}): brief says X, plan says Y: which one?`), a.message);
  // repairs 1 still allows it: the halt counted no repair.
  assert.equal(r.entries.filter(e => e.kind === 'send' && e.reason === 'repair').length, 0);
  assert.match(why(s), new RegExp(`⛔ blocked #${block.seq} review \\(ruled #${rule.seq}\\): the writer repairs with ruling #${rule.seq}`));
});

test('a ruling recorded before the block does not resolve it; rulings before dispatch are not listed in repairs', () => {
  const early: { seq?: number } = {};
  const { r, block } = blocked({ before: x => { early.seq = x.rule('general guidance before dispatch').seq; } });
  const late = r.rule('ruling after the block', ['c']);
  assert.ok(late.seq > block.seq);
  const s = r.state();
  assert.equal(parentRuling(s, s.nodes.a!.blocks[0]!), undefined, 'a ruling on another node does not resolve it');
  const a = act(r);
  assert.ok(a?.do === 'halt' && a.reason === haltReason(block.seq), JSON.stringify(a));
  // A ruling on the node recorded before the block (a second candidate's block) does not resolve the new block.
  const two = blocked();
  const pre = two.r.rule('decided earlier');
  two.r.submit('2'); two.r.pass();
  two.r.launchReviewer(2);
  const b2 = two.r.review('block', { needs: 'parent', note: 'still ambiguous' });
  assert.ok(pre.seq < b2.seq);
  const s2 = two.r.state();
  assert.equal(parentRuling(s2, s2.nodes.a!.blocks.find(b => b.seq === b2.seq)!), undefined);
  const runs2 = new Map(runs); runs2.set(runId(P, 'a', 1, 'reviewer', 2), { rid: runId(P, 'a', 1, 'reviewer', 2), state: 'sealed', status: 'ok' });
  const h = decide(s2, s2.plan, runs2, optsOf(two.r)).find(x => x.node === 'a');
  assert.ok(h?.do === 'halt' && h.reason === `review block #${b2.seq} review needs a parent ruling: still ambiguous; record \`owed rule --nodes a "<decision>"\`, then the driver repairs with the ruling`, JSON.stringify(h));
  // Repair message rulings: only those after the dispatch.
  const ruled = blocked({ before: x => x.rule('before dispatch') });
  const rule = ruled.r.rule('the decision');
  const msg = repairMessage(ruled.r.state(), 'a');
  assert.ok(msg.includes(`Rulings since dispatch:\n- #${rule.seq} the decision\n`), msg);
  assert.doesNotMatch(msg, /before dispatch/);
});

test('a * ruling after the block leaves the halt and the block unresolved', () => {
  const { r, block } = blocked();
  const h = r.halt(act(r) as Extract<Action, { do: 'halt' }>);
  r.rule('general guidance', '*');
  const s = r.state();
  assert.equal(halted(s, 'a')?.seq, h.seq, 'a * ruling does not clear the halt (D3)');
  assert.equal(parentRuling(s, s.nodes.a!.blocks[0]!), undefined);
  assert.equal(act(r), undefined);
  assert.match(why(s), new RegExp(`⛔ blocked #${block.seq} review \\(needs a parent ruling\\): a parent records owed rule --nodes a "<decision>"`));
  // A ruling naming only another node does not clear it either.
  r.rule('for c only', ['c']);
  assert.equal(halted(r.state(), 'a')?.seq, h.seq);
});

test('views: why and status show "needs a parent ruling" until a node ruling, then "ruled #seq"', () => {
  const { r, block } = blocked();
  const s = r.state();
  assert.ok(why(s).split('\n').some(l => l.startsWith(`⛔ blocked #${block.seq} review (needs a parent ruling): `)), why(s));
  const status = renderStatus(statusView(s, [...r.entries]));
  assert.ok(status.includes(`Blocked (needs a parent ruling):\n⛔ a: blocked #${block.seq} review (needs a parent ruling): brief says X, plan says Y: which one?; record owed rule --nodes a "<decision>"`), status);
  // A driver halt with the same words is listed under Halted (driver).
  r.halt(act(r) as Extract<Action, { do: 'halt' }>);
  const halt = renderStatus(statusView(r.state(), [...r.entries]));
  assert.match(halt, /Halted \(driver\):\n⏸ a: halted by driver #\d+ \(attempt 1, needs human\): review block #\d+ review needs a parent ruling: /);
  const rule = r.rule('decision');
  const after = r.state();
  assert.ok(why(after).includes(`⛔ blocked #${block.seq} review (ruled #${rule.seq}): `), why(after));
  assert.doesNotMatch(renderStatus(statusView(after, [...r.entries])), /needs a parent ruling/);
  assert.equal(statusView(after, [...r.entries]).needsRuling, undefined);
});

test('reviewer packet tells reviewers to record --block --needs-parent instead of pushing a guess', () => {
  const r = rig(); r.dispatch(); r.launchWriter(); r.submit(); r.pass();
  const lines = reviewPacket(r.state(), 'a', 1).split('\n');
  assert.ok(lines.includes('If the brief or plan is ambiguous or contradictory, or the fix needs a product or contract decision, record --block --needs-parent and state the decision needed; do not push a guess onto the writer.'), lines.join('\n'));
  assert.ok(lines.includes('  owed review a --as reviewer:drive-a-1-1 --ok|--block --rank 1 --note "..."'), 'command lines unchanged');
});

// ---------- surfaces on a real repository ----------
const realPlan = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: [{ id: 'a', writes: ['a.txt'], checks: [], review: { count: 1, min_rank: 1 } }] };
async function submittedRepo() {
  const r = await repo();
  await r.put('plan.json', JSON.stringify(realPlan)); await r.commit();
  const init = await cli(r.cwd, ['init', 'plan.json', '--i-am-owner']); assert.equal(init.code, 0, init.stderr);
  const d = await ops.dispatch({ cwd: r.cwd, as: { role: 'parent', id: 'test' }, node: 'a' });
  await commitAt(d.worktree, { 'a.txt': 'done\n' });
  await ops.submit({ cwd: d.worktree, as: { role: 'writer', id: 'a#1' }, node: 'a' });
  return r;
}
const last = async (cwd: string): Promise<Entry> => (await (await Ledger.open(cwd)).read()).at(-1)!;

test('CLI: review --block --needs-parent records needs; --ok --needs-parent is refused; why/status wording; * vs node ruling', async () => {
  const r = await submittedRepo();
  try {
    const ok = await cli(r.cwd, ['review', 'a', '--ok', '--needs-parent', '--rank', '1', '--note', 'x', '--as', 'reviewer:r1']);
    assert.equal(ok.code, 1, ok.stderr); assert.match(ok.stderr, /^Refused: .*only on a block verdict/);
    assert.equal((await last(r.cwd)).kind, 'submit', 'nothing recorded');
    const b = await cli(r.cwd, ['review', 'a', '--block', '--needs-parent', '--rank', '1', '--note', 'which API?', '--as', 'reviewer:r1']);
    assert.equal(b.code, 0, b.stderr);
    const e = await last(r.cwd);
    assert.ok(e.kind === 'review' && e.verdict === 'block' && e.needs === 'parent', JSON.stringify(e));
    assert.match(b.stdout, new RegExp(`⛔ blocked #${e.seq} review \\(needs a parent ruling\\)`));
    const plain = await cli(r.cwd, ['review', 'a', '--block', '--rank', '1', '--note', 'typo', '--as', 'reviewer:r2']);
    assert.equal(plain.code, 0, plain.stderr);
    assert.equal('needs' in (await last(r.cwd)), false);
    const st = await cli(r.cwd, ['status']);
    assert.ok(st.stdout.includes(`Blocked (needs a parent ruling):\n⛔ a: blocked #${e.seq} review (needs a parent ruling): which API?; record owed rule --nodes a "<decision>"`), st.stdout);
    assert.equal((await cli(r.cwd, ['rule', 'general', '--nodes', '*'])).code, 0);
    assert.match((await cli(r.cwd, ['why', 'a'])).stdout, new RegExp(`⛔ blocked #${e.seq} review \\(needs a parent ruling\\)`));
    assert.equal((await cli(r.cwd, ['rule', 'use the v2 API', '--nodes', 'a'])).code, 0);
    const rule = await last(r.cwd);
    assert.match((await cli(r.cwd, ['why', 'a'])).stdout, new RegExp(`⛔ blocked #${e.seq} review \\(ruled #${rule.seq}\\)`));
    assert.doesNotMatch((await cli(r.cwd, ['status'])).stdout, /needs a parent ruling/);
  } finally { await r.cleanup(); }
});

test('pi tool owed_review: needs_parent reaches the entry; false or absent records no needs', async () => {
  const r = await submittedRepo();
  try {
    const tools = new Map<string, ToolDefinition>();
    owed({ registerTool(t: ToolDefinition) { tools.set(t.name, t); }, registerCommand() {}, on() {} } as unknown as ExtensionAPI);
    const ctx = { cwd: r.cwd, hasUI: false, ui: { async confirm() { return true; }, notify() {} } } as unknown as ExtensionContext;
    const call = (args: Record<string, unknown>) => tools.get('owed_review')!.execute('t', args, undefined, undefined, ctx as Parameters<ToolDefinition['execute']>[4]) as Promise<{ isError?: boolean; content: { type: string; text?: string }[] }>;
    assert.ok('needs_parent' in ((tools.get('owed_review')!.parameters as { properties: object }).properties));
    const res = await call({ node: 'a', as: 'reviewer:t1', verdict: 'block', rank: 1, note: 'needs a product decision', needs_parent: true });
    assert.notEqual(res.isError, true, JSON.stringify(res));
    const e = await last(r.cwd);
    assert.ok(e.kind === 'review' && e.needs === 'parent' && e.by === 'reviewer:t1', JSON.stringify(e));
    assert.match(res.content.map(c => c.text ?? '').join('\n'), /\(needs a parent ruling\)/);
    await call({ node: 'a', as: 'reviewer:t2', verdict: 'block', rank: 1, note: 'fixable', needs_parent: false });
    assert.equal('needs' in (await last(r.cwd)), false);
    const refused = await call({ node: 'a', as: 'reviewer:t3', verdict: 'ok', rank: 1, note: 'x', needs_parent: true });
    assert.equal(refused.isError, true); assert.match(refused.content.map(c => c.text ?? '').join('\n'), /^Refused: .*only on a block verdict/);
    assert.equal((await last(r.cwd)).by, 'reviewer:t2');
  } finally { await r.cleanup(); }
});
