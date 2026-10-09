import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical, sha256 } from '../src/canon.ts';
import { decide, driverSlot, launchSpec, ownerNeeded, rebaseMessage, repairMessage, reviewerLaunch, writerLaunch, writerTask, WRITER_INTERRUPTED, type Action, type DriveOpts } from '../src/drive.ts';
import { reduce, runId, runLabels, projectId, entriesOf } from '../src/reducer.ts';
import { reviewPacket, dispatchPacket } from '../src/views.ts';
import { Ledger } from '../src/ledger.ts';
import * as ops from '../src/ops.ts';
import { parsePlan } from '../src/plan.ts';
import type { CandidateFacts, DriveConfig, Draft, Entry, NodeSpec, Plan, RunView, State } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { commitAt } from './helpers/surface.ts';

// ---------- synthetic ledger rig (no git): entries are replayed through the validating reducer ----------
const P = 'hash0';                                   // projectId = first 12 chars of the genesis hash
const W = (node = 'a', attempt = 1) => runId(P, node, attempt, 'writer');
const R = (n: number, node = 'a', attempt = 1) => runId(P, node, attempt, 'reviewer', n);
const T0 = Date.UTC(2026, 0, 1);
const iso = (seq: number) => new Date(T0 + seq * 1000).toISOString();
const spec = (o: Partial<NodeSpec> & { id: string }): NodeSpec => ({ deps: [], writes: [`${o.id}/`], checks: [], review: { count: 0, min_rank: 1 }, ...o });
const basePlan = (drive?: DriveConfig, nodes: Partial<Record<string, Partial<NodeSpec>>> = {}): Plan => ({ version: 1, trunk: 'main', closure: ['closure/'], invariants: [], nodes: [
  spec({ id: 'a', title: 'Node A', brief: 'Do A.', checks: [{ id: 'unit', run: 'npm test', timeout_s: 60, reads: ['a/**'] }], review: { count: 1, min_rank: 1 }, ...nodes.a }),
  spec({ id: 'b', deps: ['a'], ...nodes.b }),
  spec({ id: 'c', ...nodes.c }),
  spec({ id: 'd', writes: ['a/sub/'], ...nodes.d }),
], ...(drive ? { drive } : {}) });
const DRIVE: DriveConfig = { max: 4, repairs: 2, writer: { agent: 'worker', model: 'sota/x:high' }, reviewer: { agent: 'reviewer' } };

function rig(plan: Plan = basePlan(DRIVE)) {
  const entries: Entry[] = [], plans: Record<string, Plan> = { p: plan }, blobs = new Map<string, string>();
  const state = (): State => reduce(entries, sha => plans[sha]!);
  const add = (d: Draft): Entry => { const seq = entries.length, e = { ...d, seq, ts: iso(seq), prev: 'x', hash: `hash${seq}` } as Entry; entries.push(e); state(); return e; };
  const blob = (text: string): string => { const h = sha256(text); blobs.set(h, text); return h; };
  add({ kind: 'genesis', by: 'owner:human', channel: 'tty', plan: 'p', trunk: 'main', commit: 's0', state: { commit: 's0', tree: 't0', invKeys: {} } });
  const slot = (node: string) => state().nodes[node]!.slot!;
  const facts = (node: string, tag: string, closure = false): CandidateFacts => ({ commit: `${node}c${tag}`, tree: `t${tag}`, base: slot(node).base, patch: `p${tag}`, changed: [`${node}/x`], closureTouched: closure,
    keys: Object.fromEntries(['check:unit', 'writes', 'rulings', 'review', 'closure-review'].map(o => [o, `${node}-${o}-${tag}`])) });
  const r = {
    entries, plans, blobs, state, add,
    dispatch(node = 'a') {
      const s = state(), attempt = (s.nodes[node]!.slot?.attempt ?? 0) + 1, rules = s.rules.filter(x => x.nodes === '*' || x.nodes.includes(node));
      return add({ kind: 'dispatch', by: 'parent:drive', node, attempt, base: s.trunk.commit, branch: `owed/${node}/${attempt}`, worktree: `/repo/.owed/wt/${node}-${attempt}`, packet: 'blob', rulings_seen: Math.max(-1, ...rules.map(x => x.seq)) });
    },
    launchWriter(node = 'a') { const a = writerLaunch(state(), node, P); return add({ kind: 'launch', by: 'parent:drive', node, attempt: a.attempt, role: 'writer', rid: a.rid, spec: blob(a.spec), labels: a.labels }); },
    launchReviewer(n: number, node = 'a') { const a = reviewerLaunch(state(), node, n, P, '/repo'); return add({ kind: 'launch', by: 'parent:drive', node, attempt: a.attempt, role: 'reviewer', rid: a.rid, spec: blob(a.spec), labels: a.labels }); },
    send(rid: string, reason: Extract<Draft, { kind: 'send' }>['reason'], sendKind: 'follow-up' | 'steer' = 'follow-up', message = `msg ${entries.length}`, node = 'a') {
      return add({ kind: 'send', by: 'parent:drive', node, attempt: slot(node).attempt, rid, send: `${rid}:${sendKind}:${entries.length}`, sendKind, message: blob(message), reason }) as Extract<Entry, { kind: 'send' }>;
    },
    halt(reason = 'stuck', node = 'a') { return add({ kind: 'halt', by: 'parent:drive', node, attempt: slot(node).attempt, reason, needs: 'human' }); },
    submit(tag = '1', node = 'a', closure = false) { return add({ kind: 'submit', by: `writer:${node}#${slot(node).attempt}`, node, attempt: slot(node).attempt, facts: facts(node, tag, closure) }); },
    obs(obligation: string, verdict: 'pass' | 'fail' | 'error', extra: Partial<Extract<Draft, { kind: 'obs' }>> = {}, node = 'a') {
      const c = state().nodes[node]!.candidate!;
      return add({ kind: 'obs', by: 'executor:owed', subject: node, obligation, key: c.keys[obligation]!, verdict, exit: verdict === 'pass' ? 0 : verdict === 'fail' ? 1 : null, durationMs: 1, commit: c.commit, base: c.base, ...extra });
    },
    pass(node = 'a') { for (const o of state().nodes[node]!.items.map(i => i.obligation).filter(o => o === 'writes' || o.startsWith('check:'))) r.obs(o, 'pass', {}, node); },
    review(verdict: 'ok' | 'block', by = 'reviewer:drive-a-1-1', rank = 1, obligation: 'review' | 'closure-review' = 'review', node = 'a') {
      const c = state().nodes[node]!.candidate!;
      return add({ kind: 'review', by, node, attempt: slot(node).attempt, obligation, key: c.keys[obligation]!, verdict, rank, note: 'n' });
    },
    rule(text: string, nodes: string[] | '*' = ['a']) { return add({ kind: 'rule', by: 'parent:main', text, nodes }); },
  };
  return r;
}
type Rig = ReturnType<typeof rig>;
const view = (rid: string, state: RunView['state'], extra: Partial<RunView> = {}): [string, RunView] => [rid, { rid, state, ...extra }];
const runsOf = (...vs: [string, RunView][]) => new Map(vs);
const optsOf = (r: Rig, o: Partial<DriveOpts> = {}): DriveOpts => ({ max: 4, repairs: 2, project: P, root: '/repo', applied: new Set(), rejected: new Map(), blobs: r.blobs, ...o });
const go = (r: Rig, runs = runsOf(), o: Partial<DriveOpts> = {}): Action[] => decide(r.state(), r.state().plan, runs, optsOf(r, o));
/** The single action of `node` in a pass (asserting at most one). */
function act(r: Rig, runs = runsOf(), o: Partial<DriveOpts> = {}, node = 'a'): Action | undefined {
  const mine = go(r, runs, o).filter(x => x.node === node);
  assert.ok(mine.length <= 1, `at most one action per node: ${JSON.stringify(mine)}`);
  return mine[0];
}
/** Writer launched and sealed ok after submitting candidate 1 with all measured obligations passing. */
function submitted(plan?: Plan): Rig { const r = rig(plan); r.dispatch(); r.launchWriter(); r.submit(); return r; }
const okWriter = () => view(W(), 'sealed', { status: 'ok' });
const applied = (r: Rig) => new Set(r.entries.flatMap(e => e.kind === 'send' ? [e.send] : []));

// ---------- D4 table, first-match order ----------
test('row 1: a halted attempt gets no action, whatever else matches', () => {
  const r = rig(); r.dispatch(); r.halt('writer failed');
  assert.equal(act(r), undefined, 'not even the missing writer launch');
  r.launchWriter(); r.halt('again');
  assert.equal(act(r, runsOf(view(W(), 'asking', { questions: [{ qid: 'q', rev: 1, question: '?' }] }))), undefined);
  // A non-driver action on the node clears the halt.
  r.rule('carry on');
  assert.equal(act(r, runsOf(view(W(), 'asking', { questions: [{ qid: 'q', rev: 1, question: '?' }] })))?.do, 'notify');
});

test('row 2: writer launch missing → launch writer (agent/model from drive:, slot worktree, isolation none, once, dispatch packet)', () => {
  const r = rig(); r.rule('before dispatch'); r.dispatch(); r.rule('after dispatch');
  const a = act(r, runsOf(), { rejected: new Map([[W(), 'ignored: no launch yet']]) });
  assert.ok(a?.do === 'launch');
  assert.deepEqual({ ...a, spec: undefined }, { do: 'launch', node: 'a', attempt: 1, role: 'writer', rid: W(), spec: undefined, labels: runLabels(P, 'a', 1, 'writer') });
  assert.equal(a.n, undefined, 'writers have no n');
  const parsed = JSON.parse(a.spec);
  assert.deepEqual(Object.keys(parsed), ['agent', 'cwd', 'isolation', 'model', 'once', 'task']);
  assert.deepEqual({ ...parsed, task: undefined }, { agent: 'worker', model: 'sota/x:high', cwd: '/repo/.owed/wt/a-1', isolation: 'none', once: true, task: undefined });
  const s = r.state(), rules = s.rules.filter(x => x.text === 'before dispatch');
  assert.equal(parsed.task, dispatchPacket(s.plan.nodes[0]!, 1, '/repo/.owed/wt/a-1', rules), 'task = the dispatch packet, with the rulings seen at dispatch only');
  assert.match(parsed.task, /Node: a; attempt: 1\nWorking directory: \/repo\/\.owed\/wt\/a-1/);
  assert.doesNotMatch(parsed.task, /after dispatch/);
  // Without a drive: block the defaults apply (no model key).
  const plain = rig(basePlan()); plain.dispatch();
  const b = act(plain);
  assert.ok(b?.do === 'launch');
  assert.deepEqual(Object.keys(JSON.parse(b.spec)), ['agent', 'cwd', 'isolation', 'once', 'task']);
  assert.equal(JSON.parse(b.spec).agent, 'worker');
});

test('row 3: a launch whose run is absent → re-launch with identical bytes and rid; recorded rejection → halt', () => {
  const r = rig(); r.dispatch(); const l = r.launchWriter() as Extract<Entry, { kind: 'launch' }>;
  r.rule('a later ruling does not change the dispatch packet');
  const runs = runsOf(view(W(), 'absent'));
  const a = act(r, runs, { blobs: new Map() });
  assert.ok(a?.do === 'launch');
  assert.equal(sha256(a.spec), l.spec, 'rebuilt bytes equal the stored spec');
  assert.deepEqual([a.rid, a.labels], [l.rid, l.labels]);
  // Plan changes the writer model: the rebuild differs, so the stored bytes are used; without them the driver halts.
  r.plans.p2 = basePlan({ ...DRIVE, writer: { agent: 'worker', model: 'other' } });
  r.add({ kind: 'plan', by: 'parent:main', prior: 'p', plan: 'p2', downgrades: [] });
  const stored = act(r, runs);
  assert.ok(stored?.do === 'launch');
  assert.equal(stored.spec, r.blobs.get(l.spec));
  assert.equal(JSON.parse(stored.spec).model, 'sota/x:high');
  const none = act(r, runs, { blobs: new Map() });
  assert.ok(none?.do === 'halt' && none.needs === 'human');
  assert.match(none.reason, /cannot re-launch .*writer: the stored spec bytes/);
  // D9: a rejection of the rid in this process halts with the reason (never re-launched on absent); outranks row 4+.
  r.send(W(), 'submit');
  const rej = act(r, runs, { rejected: new Map([[W(), 'unknown agent worker']]) });
  assert.deepEqual(rej, { do: 'halt', node: 'a', attempt: 1, reason: `dsa rejected run ${W()}: unknown agent worker`, needs: 'human' });
  // A run that exists is not re-launched.
  assert.notEqual(act(r, runsOf(okWriter()))?.do, 'launch');
});

test('row 4: a send not confirmed applied → re-send the same id and stored bytes (no new entry)', () => {
  const r = rig(); r.dispatch(); r.launchWriter();
  const x = r.send(W(), 'submit', 'follow-up', 'commit your work and run `owed submit a`');
  const runs = runsOf(view(W(), 'asking', { questions: [{ qid: 'q', rev: 1, question: 'which?' }] }));
  assert.deepEqual(act(r, runs), { do: 'send', node: 'a', attempt: 1, rid: W(), sendKind: 'follow-up', message: 'commit your work and run `owed submit a`', reason: 'submit', send: x.send }, 'outranks asking');
  const missing = act(r, runs, { blobs: new Map() });
  assert.ok(missing?.do === 'halt' && /cannot re-send .*stored message bytes/.test(missing.reason));
  // Confirmed applied in this process: the next row decides.
  assert.equal(act(r, runs, { applied: new Set([x.send]) })?.do, 'notify');
});

test('row 5: writer asking → notify with the question and answer address; the driver never answers', () => {
  const r = submitted();
  const a = act(r, runsOf(view(W(), 'asking', { questions: [{ qid: 'q1', rev: 3, question: 'Which API?\nline two' }], lastFence: { reason: 'x', at: T0 } })));
  assert.ok(a?.do === 'notify', 'outranks attest and fenced');
  assert.match(a.text, /^a: writer run owed:hash0:a:1:writer asks \(qid q1, rev 3\): Which API\?\\nline two — the driver never answers; answer with: pi-durable-subagents send --request <id> --to owed:hash0:a:1:writer --kind answer --qid q1 --rev 3/);
  // A reviewer run of the current candidate asking is notified too.
  const q = submitted(); q.pass(); q.launchReviewer(1);
  const b = act(q, runsOf(okWriter(), view(R(1), 'asking', { questions: [{ qid: 'r', rev: 1, question: 'scope?' }] })));
  assert.ok(b?.do === 'notify' && b.text.includes(`reviewer run ${R(1)} asks`));
});

test('row 6: writer sealed unknown → follow-up interrupted (exact text); not a repair', () => {
  const r = submitted();
  for (const state of ['sealed', 'pruned'] as const) {
    const a = act(r, runsOf(view(W(), state, { status: 'unknown', lastFence: { reason: 'restart', at: T0 } })));
    assert.deepEqual(a, { do: 'send', node: 'a', attempt: 1, rid: W(), sendKind: 'follow-up', message: WRITER_INTERRUPTED, reason: 'interrupted' }, 'outranks attest');
  }
  assert.equal(WRITER_INTERRUPTED, 'You were interrupted; processes your tools started are gone. Check the worktree (HEAD, git status) before continuing, then commit and `owed submit`.');
  assert.equal(act(r, runsOf(view(W(), 'sealed')))?.do, 'send', 'a sealed run without status is unknown');
});

test('row 7: writer sealed failed/timeout/budget/stopped/other → halt needs human', () => {
  const r = submitted();
  for (const status of ['failed', 'timeout', 'budget', 'stopped', 'rejected', 'weird']) {
    const a = act(r, runsOf(view(W(), 'sealed', { status, error: 'boom' })));
    assert.deepEqual(a, { do: 'halt', node: 'a', attempt: 1, reason: `writer run ${W()} sealed ${status}: boom`, needs: 'human' });
  }
  assert.equal(act(r, runsOf(view(W(), 'pruned', { status: 'failed' })))?.do, 'halt');
});

test('row 8: writer sealed ok without a candidate → one submit follow-up, then halt', () => {
  const r = rig(); r.dispatch(); r.launchWriter();
  assert.deepEqual(act(r, runsOf(okWriter())), { do: 'send', node: 'a', attempt: 1, rid: W(), sendKind: 'follow-up', message: 'commit your work and run `owed submit a`', reason: 'submit' });
  r.send(W(), 'submit');
  const a = act(r, runsOf(okWriter()), { applied: applied(r) });
  assert.ok(a?.do === 'halt' && a.needs === 'human' && /finished without submitting a candidate after follow-up/.test(a.reason));
  // While the writer still runs, nothing.
  assert.equal(act(r, runsOf(view(W(), 'running')), { applied: applied(r) }), undefined);
});

test('row 9: candidate with unattested measured obligations (fewer than 2 errors) → attest', () => {
  const r = submitted();
  assert.deepEqual(act(r, runsOf(okWriter())), { do: 'attest', node: 'a' });
  r.obs('check:unit', 'error', { note: 'cut off' });
  assert.deepEqual(act(r, runsOf(view(W(), 'running', { lastFence: { reason: 'r', at: T0 + 1e9 } }))), { do: 'attest', node: 'a' }, 'one error: attest again; outranks fenced');
  r.obs('writes', 'pass');
  assert.deepEqual(act(r, runsOf(okWriter())), { do: 'attest', node: 'a' });
  // The candidate passes, but a block of earlier content still waits for its attribution rerun: attest (not repair).
  const b = submitted(); b.obs('writes', 'pass'); b.obs('check:unit', 'fail'); b.submit('2'); b.pass();
  assert.deepEqual(act(b, runsOf(okWriter())), { do: 'attest', node: 'a' });
  const old = { attribution: true, key: 'a-check:unit-1', commit: 'ac1', base: 's0' };
  b.obs('check:unit', 'error', old); b.obs('check:unit', 'error', old);
  assert.match((act(b, runsOf(okWriter())) as { reason: string }).reason, /^attest recorded no verdict twice: check:unit/);
});

test('row 10: two error observations on the current key and no verdict → halt with the notes', () => {
  const r = submitted(); r.obs('writes', 'pass');
  r.obs('check:unit', 'error', { note: 'setup broken' }); const e2 = r.obs('check:unit', 'error', { note: 'check cut off' });
  const a = act(r, runsOf(okWriter()));
  assert.ok(a?.do === 'halt' && a.needs === 'human');
  assert.match(a.reason, new RegExp(`attest recorded no verdict twice: check:unit \\(#${e2.seq - 1} setup broken; #${e2.seq} check cut off\\)`));
  // Another obligation still below the cap: attest first.
  const b = submitted(); b.obs('check:unit', 'error'); b.obs('check:unit', 'error');
  assert.deepEqual(act(b, runsOf(okWriter())), { do: 'attest', node: 'a' });
});

test('row 11: measured block → repair follow-up with the owed why card; once per candidate; repairs cap', () => {
  const r = submitted(); r.obs('writes', 'pass'); const fail = r.obs('check:unit', 'fail');
  const a = act(r, runsOf(okWriter()));
  assert.ok(a?.do === 'send' && a.reason === 'repair' && a.sendKind === 'follow-up' && a.rid === W(), JSON.stringify(a));
  assert.equal(a.message, repairMessage(r.state(), 'a'));
  assert.match(a.message, /run `owed submit a`/);
  assert.match(a.message, new RegExp(`⛔ blocked #${fail.seq} check:unit`));
  // A confirming attribution rerun clears the block but the content still failed (✘): still a repair, not an attest.
  r.obs('check:unit', 'fail', { attribution: true });
  assert.equal(r.state().nodes.a!.blocks[0]!.state, 'cleared');
  assert.equal((act(r, runsOf(okWriter())) as { reason?: string }).reason, 'repair');
  r.send(W(), 'repair', 'follow-up', a.message);
  // Outstanding repair: wait while the writer works; halt if it finishes without resubmitting.
  assert.equal(act(r, runsOf(view(W(), 'running')), { applied: applied(r) }), undefined);
  const stale = act(r, runsOf(okWriter()), { applied: applied(r) });
  assert.ok(stale?.do === 'halt' && /finished repair follow-up .* without submitting a new candidate/.test(stale.reason));
  // Resubmit, attribution rerun clears the old block, the new candidate fails again: with repairs: 1 the cap halts.
  r.submit('2'); r.obs('writes', 'pass'); r.obs('check:unit', 'fail');
  const capped = act(r, runsOf(okWriter()), { applied: applied(r), repairs: 1 });
  assert.ok(capped?.do === 'halt' && capped.needs === 'human');
  assert.match(capped.reason, /^repairs exhausted \(1 of 1\): measured block check:unit \[#\d+\]/);
  assert.equal(act(r, runsOf(okWriter()), { applied: applied(r), repairs: 2 })?.do, 'send', 'below the cap: a second repair');
});

test('row 12: review awaiting → launch reviewer n (reviewer agent, repo root, review packet); one run per required reviewer', () => {
  const r = submitted(); r.pass();
  const a = act(r, runsOf(okWriter()));
  assert.ok(a?.do === 'launch');
  assert.deepEqual({ ...a, spec: undefined }, { do: 'launch', node: 'a', attempt: 1, role: 'reviewer', n: 1, rid: R(1), spec: undefined, labels: runLabels(P, 'a', 1, 'reviewer') });
  assert.equal(a.spec, launchSpec({ agent: 'reviewer', cwd: '/repo', task: reviewPacket(r.state(), 'a', 1) }));
  assert.deepEqual(JSON.parse(a.spec).isolation, 'none'); assert.equal(JSON.parse(a.spec).once, true);
  r.launchReviewer(1);
  assert.equal(act(r, runsOf(okWriter(), view(R(1), 'running'))), undefined, 'one run covers the candidate');
  // review.count 2: two runs, n = 1 and 2, the second launched while the first still runs.
  const two = submitted(basePlan(DRIVE, { a: { review: { count: 2, min_rank: 1 } } })); two.pass();
  assert.ok((act(two, runsOf(okWriter())) as { n?: number }).n === 1);
  two.launchReviewer(1);
  const second = act(two, runsOf(okWriter(), view(R(1), 'running')));
  assert.ok(second?.do === 'launch' && second.n === 2 && second.rid === R(2) && JSON.parse(second.spec).task.includes('--as reviewer:drive-a-1-2 '));
  two.launchReviewer(2);
  assert.equal(act(two, runsOf(okWriter(), view(R(1), 'running'), view(R(2), 'queued'))), undefined);
});

test('row 13: reviewer sealed unknown with its obligation awaiting → one interrupted follow-up, then review-missing halt', () => {
  const r = submitted(); r.pass(); r.launchReviewer(1);
  const runs = runsOf(okWriter(), view(R(1), 'sealed', { status: 'unknown' }));
  assert.deepEqual(act(r, runs), { do: 'send', node: 'a', attempt: 1, rid: R(1), sendKind: 'follow-up', reason: 'interrupted',
    message: 'You were interrupted; check `owed why a` for reviews you already recorded on this candidate, finish the rest.' });
  r.send(R(1), 'interrupted');
  const a = act(r, runs, { applied: applied(r) });
  assert.ok(a?.do === 'halt' && a.needs === 'human');
  assert.match(a.reason, /^review-missing: reviewer run owed:hash0:a:1:reviewer:1 sealed unknown without recording review on candidate #\d+/);
});

test('row 14: reviewer sealed otherwise with its obligation awaiting → halt review-missing; recorded → no halt', () => {
  const r = submitted(); r.pass(); r.launchReviewer(1);
  const a = act(r, runsOf(okWriter(), view(R(1), 'sealed', { status: 'ok' })));
  assert.ok(a?.do === 'halt' && /^review-missing: .*sealed ok without recording review/.test(a.reason));
  assert.ok((act(r, runsOf(okWriter(), view(R(1), 'sealed', { status: 'failed', error: 'budget' }))) as { reason: string }).reason.includes('sealed failed: budget'));
  r.review('ok');
  assert.deepEqual(act(r, runsOf(okWriter(), view(R(1), 'sealed', { status: 'ok' }))), { do: 'merge', node: 'a' });
});

test('row 15: review block → repair follow-up, counted against the same repairs cap', () => {
  const r = submitted(); r.pass(); r.launchReviewer(1); r.review('block');
  const runs = runsOf(okWriter(), view(R(1), 'sealed', { status: 'ok' }));
  const a = act(r, runs);
  assert.ok(a?.do === 'send' && a.reason === 'repair' && a.rid === W() && /owed submit a/.test(a.message));
  // An earlier measured repair on this attempt counts: with repairs 1 the review block halts.
  const m = submitted(); m.obs('writes', 'pass'); m.obs('check:unit', 'fail'); m.send(W(), 'repair');
  m.submit('2'); m.obs('check:unit', 'fail', { attribution: true, key: 'a-check:unit-1', commit: 'ac1', base: 's0' }); m.pass();
  m.launchReviewer(1); m.review('block');
  const capped = act(m, runs, { applied: applied(m), repairs: 1 });
  assert.ok(capped?.do === 'halt' && /^repairs exhausted \(1 of 1\): review block #\d+ review/.test(capped.reason));
});

test('row 16: accepted → merge', () => {
  const r = submitted(); r.pass(); r.launchReviewer(1); r.review('ok');
  assert.equal(r.state().nodes.a!.phase, 'accepted');
  assert.deepEqual(act(r, runsOf(okWriter(), view(R(1), 'sealed', { status: 'ok' }))), { do: 'merge', node: 'a' });
  assert.deepEqual(act(r, runsOf(view(W(), 'running', { lastFence: { reason: 'x', at: T0 + 1e9 } }), view(R(1), 'running'))), { do: 'merge', node: 'a' }, 'outranks fenced');
});

test('row 17: merge refused because trunk moved → rebase, then the rebase follow-up; other refusals halt', () => {
  const r = submitted(); r.pass(); r.launchReviewer(1); r.review('ok');
  const c = r.state().nodes.a!.candidate!.seq, runs = runsOf(okWriter(), view(R(1), 'sealed', { status: 'ok' }));
  assert.deepEqual(act(r, runs, { merges: new Map([['a', { candidate: c, reason: 'rebase needed', rebase: true }]]) }), { do: 'rebase', node: 'a' });
  assert.deepEqual(act(r, runs, { merges: new Map([['a', { candidate: c - 1, reason: 'old', rebase: true }]]) }), { do: 'merge', node: 'a' }, 'a refusal of another candidate is stale');
  assert.deepEqual(act(r, runs, { merges: new Map([['a', { candidate: c, reason: 'trunk drift', needs: 'owner' }]]) }), { do: 'halt', node: 'a', attempt: 1, reason: 'merge refused: trunk drift', needs: 'owner' });
  // The executor rebases (trunk moved to s1); the next pass sends the rebase follow-up to the writer, once.
  r.add({ kind: 'adopt', by: 'owner:human', channel: 'tty', trunk: 'main', prior: 's0', commit: 's1', state: { commit: 's1', tree: 't1', invKeys: {} }, changed: ['x'], commits: 1, note: 'moved' });
  r.add({ kind: 'rebase', by: 'parent:drive', node: 'a', attempt: 1, base: 's1', from: 's0' });
  const f = act(r, runs);
  assert.deepEqual(f, { do: 'send', node: 'a', attempt: 1, rid: W(), sendKind: 'follow-up', reason: 'rebase', message: rebaseMessage(r.state(), 'a') });
  assert.match(f.message, /^trunk moved; rebase your worktree onto main \(s1\): in \/repo\/\.owed\/wt\/a-1 run `git rebase --onto s1 s0`.*`owed submit a`$/);
  r.send(W(), 'rebase', 'follow-up', f.message);
  assert.equal((act(r, runs, { applied: applied(r) }) as { reason?: string }).reason, 'submit', 'then the usual submit nudge');
});

test('row 18: fenced running writer (fence newer than the last steer) → steer; otherwise none', () => {
  const r = rig(); r.dispatch(); r.launchWriter();
  const fence = { reason: 'orchestrator restart', at: T0 + 2500 };
  assert.deepEqual(act(r, runsOf(view(W(), 'running', { lastFence: fence }))), { do: 'send', node: 'a', attempt: 1, rid: W(), sendKind: 'steer', reason: 'fenced',
    message: 'Your previous execution was cut off (orchestrator restart); processes your tools started are gone; rerun anything you were measuring.' });
  const steer = r.send(W(), 'fenced', 'steer');
  assert.ok(Date.parse(steer.ts) > fence.at);
  assert.equal(act(r, runsOf(view(W(), 'running', { lastFence: fence })), { applied: applied(r) }), undefined, 'already steered');
  assert.equal(act(r, runsOf(view(W(), 'running', { lastFence: { ...fence, at: Date.parse(steer.ts) + 1 } })), { applied: applied(r) })?.do, 'send', 'a newer fence');
  assert.equal(act(r, runsOf(view(W(), 'queued', { lastFence: { ...fence, at: Date.parse(steer.ts) + 1 } })), { applied: applied(r) }), undefined, 'only a running writer');
});

test('otherwise none: running writer, or a candidate under review by a live run; missing run views wait', () => {
  const r = rig(); r.dispatch(); r.launchWriter();
  assert.equal(act(r, runsOf(view(W(), 'running'))), undefined);
  assert.equal(act(r, runsOf()), undefined, 'no describe result for a recorded run: wait');
  const q = submitted(); q.pass(); q.launchReviewer(1);
  assert.equal(act(q, runsOf(view(W(), 'running'), view(R(1), 'running'))), undefined);
});

test('monotone reviewer n across a resubmitted candidate; runs of an earlier candidate are obsolete', () => {
  const r = submitted(); r.pass(); r.launchReviewer(1); r.review('block');
  const old = r.send(R(1), 'interrupted');           // never applied: a send to the old reviewer run
  r.send(W(), 'repair');
  r.submit('2'); r.pass();
  const a = act(r, runsOf(okWriter(), view(R(1), 'absent')), { applied: new Set([...applied(r)].filter(x => x !== old.send)) });
  assert.ok(a?.do === 'launch' && a.role === 'reviewer', JSON.stringify(a));
  assert.equal(a.n, 2); assert.equal(a.rid, R(2));
  assert.match(JSON.parse(a.spec).task, /--as reviewer:drive-a-1-1 /, 'run n=2 is review slot k=1: the same principal as on candidate 1');
  assert.match(JSON.parse(a.spec).task, /Candidate: ac2/);
});

// ---------- not per slot: dispatch ----------
test('dispatch: ready nodes in status order while open < max, skipping writes overlaps (also within the pass)', () => {
  const r = rig();
  assert.deepEqual(go(r), [{ do: 'dispatch', node: 'a' }, { do: 'dispatch', node: 'c' }], 'a first (1 dependent); d overlaps a just dispatched');
  assert.deepEqual(go(r, runsOf(), { max: 1 }), [{ do: 'dispatch', node: 'a' }]);
  r.dispatch('a');
  const acts = go(r, runsOf(), { max: 2 });
  assert.deepEqual(acts.map(x => `${x.do}:${x.node}`), ['launch:a', 'dispatch:c'], 'd overlaps the open slot of a');
  assert.deepEqual(go(r, runsOf(), { max: 1 }).map(x => x.do), ['launch'], 'open slots count against max');
  r.dispatch('c');
  assert.deepEqual(go(r, runsOf(), { max: 4 }).filter(x => x.do === 'dispatch'), []);
});

test('owner-needed nodes are never touched: open slot with ⊤ items, ready node with a flaky block', () => {
  const r = submitted(); r.obs('check:unit', 'pass'); r.obs('check:unit', 'fail');
  assert.match(ownerNeeded(r.state(), 'a') ?? '', /check:unit/);
  const n1 = act(r, runsOf(okWriter()));
  assert.ok(n1?.do === 'notify' && /^a: needs the owner \(check:unit: .*\); the driver leaves it alone$/.test(n1.text), JSON.stringify(n1));
  // Flaky block (attribution rerun passed), attempt abandoned: the ready node is not re-dispatched.
  const f = submitted(); f.obs('writes', 'pass'); f.obs('check:unit', 'fail');
  f.submit('2'); f.obs('check:unit', 'pass', { attribution: true, key: 'a-check:unit-1', commit: 'ac1', base: 's0' });
  f.add({ kind: 'abandon', by: 'parent:main', node: 'a', attempt: 1, reason: 'x' });
  assert.equal(f.state().nodes.a!.phase, 'ready');
  assert.match(ownerNeeded(f.state(), 'a') ?? '', /flaky block/);
  assert.deepEqual(go(f).map(x => `${x.do}:${x.node}`), ['notify:a', 'dispatch:c', 'dispatch:d'], 'a only notified; d no longer overlaps an open slot');
  // A review the plan requires at rank 3: only the owner can record it.
  const o = submitted(basePlan(DRIVE, { a: { review: { count: 1, min_rank: 3 } } })); o.pass();
  assert.match(ownerNeeded(o.state(), 'a') ?? '', /rank 3/);
  assert.equal(act(o, runsOf(okWriter()))?.do, 'notify');
  // A closure-review merely awaiting a rank-2 review is reviewer work, not owner-needed.
  const cl = rig(); cl.dispatch(); cl.launchWriter(); cl.submit('1', 'a', true); cl.pass();
  assert.equal(ownerNeeded(cl.state(), 'a'), undefined);
  assert.equal(act(cl, runsOf(okWriter()))?.do, 'launch');
});

// ---------- purity and bytes ----------
test('decide is pure: same inputs give deep-equal outputs; inputs are not mutated', () => {
  const r = submitted(); r.obs('writes', 'pass'); r.obs('check:unit', 'fail'); r.dispatch('c'); r.launchWriter('c'); r.send(W('c'), 'submit', 'follow-up', 'm', 'c');
  const s = r.state(), plan = s.plan, runs = runsOf(okWriter(), view(W('c'), 'sealed', { status: 'unknown' }));
  const opts = optsOf(r, { applied: new Set(), merges: new Map() });
  const snap = { s: canonical(s), entries: canonical(entriesOf(s)), plan: canonical(plan), runs: canonical([...runs]), applied: [...opts.applied], blobs: canonical([...opts.blobs!]) };
  const one = decide(s, plan, runs, opts), two = decide(s, plan, runs, opts);
  assert.deepEqual(one, two);
  assert.deepEqual(one, decide(r.state(), r.state().plan, new Map(runs), { ...opts }), 'a fresh replay gives the same actions');
  assert.ok(one.length >= 2);
  assert.deepEqual({ s: canonical(s), entries: canonical(entriesOf(s)), plan: canonical(plan), runs: canonical([...runs]), applied: [...opts.applied], blobs: canonical([...opts.blobs!]) }, snap);
});

test('launch spec bytes are canonical and stable', () => {
  const x = launchSpec({ task: 't\n"q"', cwd: '/w', agent: 'worker', model: 'm' });
  assert.equal(x, '{"agent":"worker","cwd":"/w","isolation":"none","model":"m","once":true,"task":"t\\n\\"q\\""}');
  assert.equal(launchSpec({ model: 'm', agent: 'worker', cwd: '/w', task: 't\n"q"' }), x, 'input key order does not matter');
  assert.equal(launchSpec({ agent: 'a', cwd: '/w', task: 't' }), '{"agent":"a","cwd":"/w","isolation":"none","once":true,"task":"t"}');
  assert.equal(x, canonical(JSON.parse(x)));
  const r = rig(); r.dispatch();
  const before = writerLaunch(r.state(), 'a', P);
  r.rule('later'); r.dispatch('c'); r.launchWriter('c');
  assert.deepEqual(writerLaunch(r.state(), 'a', P), before, 'a retry rebuilds identical bytes');
});

test('writerTask rebuilds exactly the packet ops.dispatch stored (git fixture)', async () => {
  const rp = await repo();
  try {
    await commitAt(rp.cwd, { README: 'x\n' });
    const text = JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [], nodes: [{ id: 'a', title: 'T', brief: 'B', writes: ['a/'], checks: [{ id: 'k', run: 'true', red: true, tests: ['a/t'] }] }] });
    await ops.init({ cwd: rp.cwd, plan: text, as: { role: 'owner', id: 'h' }, channel: 'flag' });
    await ops.rule({ cwd: rp.cwd, as: { role: 'parent', id: 'm' }, text: 'small', nodes: ['a'] });
    const d = await ops.dispatch({ cwd: rp.cwd, node: 'a', as: { role: 'parent', id: 'drive' } });
    await ops.rule({ cwd: rp.cwd, as: { role: 'parent', id: 'm' }, text: 'later', nodes: '*' });
    const ledger = await Ledger.open(rp.cwd), entries = await ledger.read(), plans = new Map<string, Plan>();
    for (const e of entries) if (e.kind === 'genesis' || e.kind === 'plan') plans.set(e.plan, parsePlan((await ledger.getBlob(e.plan)).toString()));
    const s = reduce(entries, sha => plans.get(sha)!), entry = entries.find(e => e.kind === 'dispatch')!;
    assert.equal(writerTask(s, 'a'), d.packet);
    assert.ok(entry.kind === 'dispatch' && sha256(writerTask(s, 'a')) === entry.packet);
    const a = decide(s, s.plan, new Map(), { max: 4, repairs: 2, project: projectId(s), root: rp.cwd, applied: new Set(), rejected: new Map() });
    assert.ok(a[0]?.do === 'launch' && JSON.parse(a[0].spec).task === d.packet && JSON.parse(a[0].spec).cwd === d.worktree);
  } finally { await rp.cleanup(); }
});

// ---------- driver-authored review blocks: per-slot reviewer identity (parent decision 2026-10-09) ----------
/** block → repair follow-up (with the note) → resubmit → the same slot principal re-reviews at the block's rank → merge. */
function blockCycle(rank: 1 | 2) {
  const r = submitted(); r.pass(); r.launchReviewer(1);
  const blk = r.review('block', 'reviewer:drive-a-1-1', rank);
  assert.equal(ownerNeeded(r.state(), 'a'), undefined, `a rank-${rank} block by a driver reviewer of this attempt is repairable`);
  const runs1 = runsOf(okWriter(), view(R(1), 'sealed', { status: 'ok' }));
  const repair = act(r, runs1);
  assert.ok(repair?.do === 'send' && repair.reason === 'repair' && repair.rid === W(), JSON.stringify(repair));
  assert.ok(repair.message.includes(`Review blocks (the reviewer's note):\n- #${blk.seq} review by reviewer:drive-a-1-1 rank ${rank}: n`), repair.message);
  r.send(W(), 'repair', 'follow-up', repair.message);
  r.submit('2'); r.pass();
  const launch = act(r, runsOf(okWriter(), view(R(1), 'sealed', { status: 'ok' })), { applied: applied(r) });
  assert.ok(launch?.do === 'launch' && launch.role === 'reviewer' && launch.n === 2 && launch.rid === R(2), JSON.stringify(launch));
  const task: string = JSON.parse(launch.spec).task, lines = task.split('\n');
  assert.ok(lines.includes('Your reviewer identity: reviewer:drive-a-1-1 (never the writer of this node).'), task);
  assert.ok(lines.includes(`- #${blk.seq} review rank ${rank}: n`), task);
  assert.ok(lines.includes(`  owed review a --as reviewer:drive-a-1-1 --ok|--block --rank ${rank} --note "..."`), task);
  assert.equal(task, reviewPacket(r.state(), 'a', 2));
  r.launchReviewer(2);
  r.review('ok', 'reviewer:drive-a-1-1', rank);
  assert.equal(r.state().nodes.a!.blocks.find(b => b.seq === blk.seq)?.state, 'cleared', 'the same principal at the block rank clears it');
  assert.deepEqual(act(r, runsOf(okWriter(), view(R(1), 'sealed', { status: 'ok' }), view(R(2), 'sealed', { status: 'ok' })), { applied: applied(r) }), { do: 'merge', node: 'a' });
}
test('driver reviewer rank-1 block: repair, resubmit, same-principal re-review at rank 1, merge', () => blockCycle(1));
test('driver reviewer rank-2 block: repair (not owner-needed), resubmit, same-principal re-review asked at rank 2, merge', () => blockCycle(2));

test('rank-2 blocks by a non-driver reviewer, or by a driver reviewer of an earlier attempt, stay owner-needed', () => {
  const r = submitted(); r.pass(); r.review('block', 'reviewer:human', 2);
  assert.match(ownerNeeded(r.state(), 'a') ?? '', /rank 2 review block #\d+ on review needs the owner/);
  const a = act(r, runsOf(okWriter()));
  assert.ok(a?.do === 'notify' && /needs the owner/.test(a.text), 'notified, never repaired');
  // A rank-1 block by a non-driver reviewer stays repairable (unchanged).
  const one = submitted(); one.pass(); one.launchReviewer(1); one.review('block', 'reviewer:human', 1);
  assert.equal(ownerNeeded(one.state(), 'a'), undefined);
  assert.equal((act(one, runsOf(okWriter(), view(R(1), 'running'))) as { reason?: string }).reason, 'repair');
  // A driver block of attempt 1 binds attempt 2 too, but attempt 2's slot reviewers are other principals: owner.
  const old = submitted(); old.pass(); old.launchReviewer(1); old.review('block', 'reviewer:drive-a-1-1', 2);
  old.add({ kind: 'abandon', by: 'parent:main', node: 'a', attempt: 1, reason: 'x' });
  assert.match(ownerNeeded(old.state(), 'a') ?? '', /rank 2 review block/);
  old.dispatch();
  assert.equal(act(old)?.do, 'notify', 'not even the writer launch');
});

test('review packet without blocks keeps its text (slot identity k = n − base)', () => {
  const r = submitted(); r.pass();
  const s = r.state(), c = s.nodes.a!.candidate!;
  assert.equal(reviewPacket(s, 'a', 1), [
    '# Review Node A (node a, attempt 1, reviewer run 1 of 1 for this candidate, n = 1)',
    'Node: a; attempt: 1',
    `Candidate: ac1 (submit #${c.seq})`,
    'Base: s0',
    'Brief:', 'Do A.',
    'Allowed writes: a/',
    'Obligations of the candidate:',
    `- check:unit: measured by owed [✔ check:unit satisfied]`,
    `- writes: measured by owed [✔ writes satisfied]`,
    `- review: 1 non-writer review(s) by distinct reviewers, rank >= 1 [⊥ review requires 1 non-writer reviews with rank at least 1] — recorded by this run`,
    `- rulings: acknowledge applicable rulings [✔ no ruling is in scope for this node]`,
    'Rulings in scope: none',
    'Your reviewer identity: reviewer:drive-a-1-1 (never the writer of this node).',
    'Inspect the actual diff: git diff s0 ac1',
    'Do not edit files, commit or run owed submit; review only.',
    'Record each verdict in the ledger, choosing --ok or --block (the rank as given; explain a block in the note):',
    '  owed review a --as reviewer:drive-a-1-1 --ok|--block --rank 1 --note "..."',
    'Reply with the ledger seqs of the reviews you recorded.'].join('\n'));
});

test('a re-send dsa refuses (exit 1, e.g. pruned run) → halt needing a human, never retried', () => {
  const r = rig(); r.dispatch(); r.launchWriter();
  const x = r.send(W(), 'submit', 'follow-up', 'commit your work and run `owed submit a`');
  const a = act(r, runsOf(view(W(), 'pruned', { status: 'ok' })), { rejected: new Map([[x.send, 'unknown run']]) });
  assert.deepEqual(a, { do: 'halt', node: 'a', attempt: 1, reason: `dsa rejected send ${x.send}: unknown run`, needs: 'human' });
});

// ---------- D11: stale review blocks wait for the slot re-review (review #224) ----------
/** Slot-1 driver block (rank 2) on c1 → repair → c2 submitted and attested → slot re-review run n=2 launched. */
function reReview(o: { closure?: boolean; blockOn?: 'review' | 'closure-review' } = {}) {
  const r = rig(); r.dispatch(); r.launchWriter(); r.submit('1', 'a', !!o.closure); r.pass(); r.launchReviewer(1);
  const blk = o.blockOn === 'closure-review'
    ? (r.review('ok', 'reviewer:drive-a-1-1', 1), r.review('block', 'reviewer:drive-a-1-1', 2, 'closure-review'))
    : r.review('block', 'reviewer:drive-a-1-1', 2);
  const repair = act(r, runsOf(okWriter(), view(R(1), 'sealed', { status: 'ok' })));
  assert.ok(repair?.do === 'send' && repair.reason === 'repair', JSON.stringify(repair));
  r.send(W(), 'repair', 'follow-up', repair.message);
  r.submit('2'); r.pass(); r.launchReviewer(2);
  return { r, blk };
}
test('D11 reproduction of #224: while the slot re-review is queued or running, no second repair; its ok clears the block', () => {
  const { r, blk } = reReview();
  for (const state of ['queued', 'running'] as const)
    for (const repairs of [1, 2])
      assert.equal(act(r, runsOf(okWriter(), view(R(2), state)), { applied: applied(r), repairs }), undefined, `${state}, repairs ${repairs}`);
  assert.equal(r.entries.filter(e => e.kind === 'send' && e.reason === 'repair').length, 1);
  r.review('ok', 'reviewer:drive-a-1-1', 2);
  assert.equal(r.state().nodes.a!.blocks.find(b => b.seq === blk.seq)?.state, 'cleared');
  assert.deepEqual(act(r, runsOf(okWriter(), view(R(2), 'sealed', { status: 'ok' })), { applied: applied(r), repairs: 1 }), { do: 'merge', node: 'a' });
});

test('D11: the slot reviewer records a new block on c2 → exactly one repair', () => {
  const { r } = reReview();
  const b2 = r.review('block', 'reviewer:drive-a-1-1', 1);
  const runs = runsOf(okWriter(), view(R(2), 'sealed', { status: 'ok' }));
  const a = act(r, runs, { applied: applied(r) });
  assert.ok(a?.do === 'send' && a.reason === 'repair' && a.message.includes(`- #${b2.seq} review by reviewer:drive-a-1-1 rank 1: n`), JSON.stringify(a));
  r.send(W(), 'repair', 'follow-up', a.message);
  assert.equal(act(r, runsOf(view(W(), 'running'), view(R(2), 'sealed', { status: 'ok' })), { applied: applied(r) }), undefined, 'no second repair while the writer works');
  const done = act(r, runs, { applied: applied(r) });
  assert.ok(done?.do === 'halt' && /finished repair follow-up/.test(done.reason), 'a writer that does not resubmit halts; never a second repair');
  assert.equal(r.entries.filter(e => e.kind === 'send' && e.reason === 'repair').length, 2, 'one repair per candidate (c1, c2)');
  // With repairs 1 the c2 block exhausts the cap instead.
  const { r: q } = reReview(); q.review('block', 'reviewer:drive-a-1-1', 1);
  assert.match((act(q, runs, { applied: applied(q), repairs: 1 }) as { reason: string }).reason, /^repairs exhausted \(1 of 1\): review block #\d+ review$/);
});

test('D11: the slot reviewer oks c2 but a stale closure-review block stays active → halt needing the owner, naming the seq', () => {
  const { r, blk } = reReview({ closure: true, blockOn: 'closure-review' });
  assert.equal(act(r, runsOf(okWriter(), view(R(2), 'running')), { applied: applied(r) }), undefined, 'waits for the re-review');
  r.review('ok', 'reviewer:drive-a-1-1', 1);
  const a = act(r, runsOf(okWriter(), view(R(2), 'sealed', { status: 'ok' })), { applied: applied(r) });
  assert.ok(a?.do === 'halt' && a.needs === 'owner', JSON.stringify(a));
  assert.equal(a.reason, `stale review block #${blk.seq} closure-review rank 2 by reviewer:drive-a-1-1 still active after every slot reviewer reviewed candidate #${r.state().nodes.a!.candidate!.seq}; the driver cannot clear it`);
});

test('D11: an active rank-1 block by another principal → the slot packet asks for rank 2, and that ok clears it', () => {
  const r = submitted(); r.pass(); const h = r.review('block', 'reviewer:human', 1);
  const a = act(r, runsOf(okWriter()));
  assert.ok(a?.do === 'launch' && a.role === 'reviewer', JSON.stringify(a));
  const lines = JSON.parse(a.spec).task.split('\n');
  assert.ok(lines.includes('  owed review a --as reviewer:drive-a-1-1 --ok|--block --rank 2 --note "..."'), lines.join('\n'));
  assert.ok(lines.includes(`- #${h.seq} review rank 1 by reviewer:human: n`));
  // Repaired (current block), resubmitted; the slot reviewer of c2 is asked for rank 2 again and its ok clears the human block.
  r.launchReviewer(1);
  const fix = act(r, runsOf(okWriter(), view(R(1), 'running')));
  assert.ok(fix?.do === 'send' && fix.reason === 'repair');
  r.send(W(), 'repair', 'follow-up', fix.message); r.submit('2'); r.pass();
  assert.equal(act(r, runsOf(okWriter(), view(R(1), 'sealed', { status: 'ok' })), { applied: applied(r) })?.do, 'launch');
  assert.match(reviewPacket(r.state(), 'a', 2), /--as reviewer:drive-a-1-1 --ok\|--block --rank 2 /);
  r.launchReviewer(2); r.review('ok', 'reviewer:drive-a-1-1', 2);
  assert.equal(r.state().nodes.a!.blocks.find(b => b.seq === h.seq)?.state, 'cleared');
  assert.deepEqual(act(r, runsOf(okWriter(), view(R(2), 'sealed', { status: 'ok' })), { applied: applied(r) }), { do: 'merge', node: 'a' });
});

test('D11: reviewer:drive-<node>-<attempt>-<k> with k outside 1..count is not a driver reviewer', () => {
  const r = submitted(); r.pass();
  assert.equal(driverSlot(r.state(), 'a', 'reviewer:drive-a-1-1'), 1);
  for (const by of ['reviewer:drive-a-1-2', 'reviewer:drive-a-1-0', 'reviewer:drive-a-2-1', 'reviewer:drive-a-1-1x']) assert.equal(driverSlot(r.state(), 'a', by), undefined, by);
  r.review('block', 'reviewer:drive-a-1-2', 2);
  assert.match(ownerNeeded(r.state(), 'a') ?? '', /rank 2 review block #\d+ on review needs the owner/);
  assert.equal(act(r, runsOf(okWriter()))?.do, 'notify');
  const two = submitted(basePlan(DRIVE, { a: { review: { count: 2, min_rank: 1 } } })); two.pass();
  assert.equal(driverSlot(two.state(), 'a', 'reviewer:drive-a-1-2'), 2, 'in range when count is 2');
});

test('D11: decide reads the plan from s.plan only', () => {
  const r = rig(); r.dispatch();
  const other = basePlan({ ...DRIVE, max: 1, writer: { agent: 'impostor' } }, { a: { writes: ['zzz/'] } });
  assert.deepEqual(decide(r.state(), other, runsOf(), optsOf(r)), go(r));
  assert.equal(JSON.parse((go(r)[0] as { spec: string }).spec).agent, 'worker');
});
