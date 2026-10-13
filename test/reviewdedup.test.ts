import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../src/canon.ts';
import { decide, reviewerLaunch, writerLaunch, verdictMessage, type DriveOpts } from '../src/drive.ts';
import { Driver, liveRunLines } from '../src/drive-run.ts';
import { Dsa } from '../src/dsa.ts';
import { Ledger } from '../src/ledger.ts';
import { parsePlan } from '../src/plan.ts';
import * as ops from '../src/ops.ts';
import { repo } from './helpers/repo.ts';
import { commitAt } from './helpers/surface.ts';
import { reduce, runId, reviewerBase, projectId } from '../src/reducer.ts';
import { receipt, renderReceipt, reviewObligations } from '../src/views.ts';
import type { CandidateFacts, Draft, Entry, Plan, RunView, State } from '../src/types.ts';

// Same synthetic ledger approach as drive.test.ts; no git, dsa processes or clocks.
const P = 'hash0', W = runId(P, 'a', 1, 'writer');
const R = (n: number) => runId(P, 'a', 1, 'reviewer', n);
const who = (k: number) => `reviewer:drive-a-1-${k}`;
function rig(count = 1, closure = false) {
  const plan: Plan = { version: 1, trunk: 'main', closure: ['closure/'], invariants: [], nodes: [
    { id: 'a', deps: [], writes: ['a/', 'closure/'], checks: [], review: { count, min_rank: 1 } },
  ] };
  const entries: Entry[] = [], blobs = new Map<string, string>();
  const state = (): State => reduce(entries, () => plan);
  const add = (d: Draft): Entry => {
    const seq = entries.length, e = { ...d, seq, ts: new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString(), prev: 'x', hash: `hash${seq}` } as Entry;
    entries.push(e); state(); return e;
  };
  const blob = (text: string) => { const hash = sha256(text); blobs.set(hash, text); return hash; };
  add({ kind: 'genesis', by: 'owner:human', channel: 'tty', plan: 'p', trunk: 'main', commit: 's0', state: { commit: 's0', tree: 't0', invKeys: {} } });
  add({ kind: 'dispatch', by: 'parent:drive', node: 'a', attempt: 1, base: 's0', branch: 'owed/a/1', worktree: '/repo/.owed/wt/a-1', packet: 'blob', rulings_seen: -1 });
  const w = writerLaunch(state(), 'a', P);
  add({ kind: 'launch', by: 'parent:drive', node: 'a', attempt: 1, role: 'writer', rid: w.rid, spec: blob(w.spec), labels: w.labels });
  const submit = (tag: string, review = 'review-A', closureReview = 'closure-A', touches = closure) => {
    const facts: CandidateFacts = { commit: `candidate-${tag}`, tree: `tree-${tag}`, base: 's0', patch: `patch-${tag}`, changed: touches ? ['a/x', 'closure/x'] : ['a/x'], closureTouched: touches,
      keys: { review, 'closure-review': closureReview, writes: `writes-${tag}`, rulings: 'rulings' } };
    const e = add({ kind: 'submit', by: 'writer:a#1', node: 'a', attempt: 1, facts });
    add({ kind: 'obs', by: 'executor:owed', subject: 'a', obligation: 'writes', key: facts.keys.writes!, verdict: 'pass', exit: 0, durationMs: 1, commit: facts.commit, base: facts.base });
    return e;
  };
  const launch = (n: number) => {
    const a = reviewerLaunch(state(), 'a', n, P, '/repo');
    return add({ kind: 'launch', by: 'parent:drive', node: 'a', attempt: 1, role: 'reviewer', rid: a.rid, spec: blob(a.spec), labels: a.labels });
  };
  const review = (by = who(1), obligation: 'review' | 'closure-review' = 'review', rank = obligation === 'review' ? 1 : 2, key = state().nodes.a!.candidate!.keys[obligation]!) =>
    add({ kind: 'review', by, node: 'a', attempt: 1, obligation, key, verdict: 'ok', rank, note: 'checked' });
  const send = (rid: string, reason: 'verdict' | 'interrupted') => {
    const sendKind = 'follow-up', seq = entries.length;
    return add({ kind: 'send', by: 'parent:drive', node: 'a', attempt: 1, rid, send: `${rid}:${sendKind}:${seq}`, sendKind, message: blob('record verdict'), reason });
  };
  const go = (vs: RunView[], extra: Partial<DriveOpts> = {}) => {
    const s = state();
    return decide(s, s.plan, new Map([[W, { rid: W, state: 'sealed', status: 'ok' }], ...vs.map(v => [v.rid, v] as const)]),
      { max: 1, repairs: 2, project: P, root: '/repo', applied: new Set(entries.flatMap(e => e.kind === 'send' ? [e.send] : [])), rejected: new Map(), blobs, ...extra });
  };
  return { entries, state, add, submit, launch, review, send, go };
}
const running = (n = 1): RunView => ({ rid: R(n), state: 'running' });
const sealed = (n = 1, status = 'ok'): RunView => ({ rid: R(n), state: 'sealed', status });

test('RR1 (1): same-key resubmit while reviewer:1 runs does not launch reviewer:2', () => {
  const r = rig(); r.submit('1'); r.launch(1); r.submit('2');
  assert.deepEqual(r.go([running()]), []);
  assert.equal(reviewerBase(r.state(), 'a'), 0);
});

test('RR1 (2): changed review key starts a new epoch and launches the next reviewer', () => {
  const r = rig(); r.submit('1'); r.launch(1); r.submit('2', 'review-B');
  const a = r.go([running()])[0];
  assert.ok(a?.do === 'launch' && a.role === 'reviewer' && a.n === 2 && a.rid === R(2));
  assert.match(JSON.parse(a.spec).task, /--as reviewer:drive-a-1-1 /);
  assert.equal(reviewerBase(r.state(), 'a'), 1);
});

test('RR2 (3): carried sealed reviewer verdict follow-up names the current candidate and original principal', () => {
  const r = rig(); r.submit('1'); r.launch(1); r.submit('2');
  const c = r.state().nodes.a!.candidate!, a = r.go([sealed()])[0];
  assert.ok(a?.do === 'send' && a.reason === 'verdict' && a.rid === R(1));
  assert.equal(a.message, verdictMessage('a', c, who(1), ['review']));
  assert.match(a.message, /candidate candidate-2 \(submit #\d+\)/);
});

test('RR3 (4): why shows latest qualifying evidence once per principal without changing replay state', () => {
  const r = rig(2, true); r.submit('1');
  const old = r.review(), oldClosure = r.review(who(1), 'closure-review');
  r.submit('2');
  const latest = r.review(who(1), 'review', 2), other = r.review(who(2));
  const latestClosure = r.review(who(1), 'closure-review');
  r.review(who(1), 'closure-review', 1); // newest entry, but below the closure item's qualifying rank
  const s = r.state(), before = JSON.stringify(s), card = receipt(s, r.entries, 'a');
  const item = card.items.find(i => i.obligation === 'review')!, cl = card.items.find(i => i.obligation === 'closure-review')!;
  assert.deepEqual(item.evidence, [latest.seq, other.seq]);
  assert.deepEqual(item.observations.map(e => e.seq), item.evidence);
  assert.deepEqual(cl.evidence, [latestClosure.seq]);
  assert.deepEqual(s.nodes.a!.items.find(i => i.obligation === 'review')!.evidence, [old.seq, latest.seq, other.seq]);
  assert.deepEqual(s.nodes.a!.items.find(i => i.obligation === 'closure-review')!.evidence, [oldClosure.seq, latestClosure.seq]);
  const lines = renderReceipt(card).split('\n');
  assert.equal((lines.find(l => l.includes('reviewed a/review '))!.match(/reviewer:drive-a-1-1/g) ?? []).length, 1);
  assert.equal((lines.find(l => l.includes('reviewed a/closure-review '))!.match(/reviewer:drive-a-1-1/g) ?? []).length, 1);
  assert.equal(JSON.stringify(s), before, 'receipt never mutates reducer state');
});

test('RR1: epoch is contiguous (A → B → A must not reuse the first A run)', () => {
  const r = rig(); r.submit('1'); r.launch(1); r.submit('2', 'review-B'); r.submit('3');
  const a = r.go([running()])[0];
  assert.ok(a?.do === 'launch' && a.n === 2);
});

test('RR1: multiple same-key resubmits carry queued and running reviewers for count=2', () => {
  const r = rig(2); r.submit('1'); r.launch(1); r.submit('2'); r.submit('3');
  const a = r.go([running()])[0];
  assert.ok(a?.do === 'launch' && a.n === 2);
  assert.match(JSON.parse(a.spec).task, /--as reviewer:drive-a-1-2 /);
  r.launch(2); r.submit('4');
  assert.deepEqual(r.go([running(), { rid: R(2), state: 'queued' }]), []);
  assert.deepEqual(reviewObligations(r.state(), 'a', 1), ['review']);
  assert.deepEqual(reviewObligations(r.state(), 'a', 2), ['review']);
});

test('RR1: changing an active closure-review key starts a fresh epoch', () => {
  const r = rig(1, true); r.submit('1'); r.launch(1); r.submit('2', 'review-A', 'closure-B');
  const a = r.go([running()])[0];
  assert.ok(a?.do === 'launch' && a.n === 2);
});

test('RR1: absent review obligations do not make unused keys epoch boundaries', () => {
  const r = rig(); r.submit('1'); r.launch(1); r.submit('2', 'review-A', 'unused-closure-B');
  assert.deepEqual(r.go([running()]), []);
  const cl = rig(0, true); cl.submit('1'); cl.launch(1); cl.submit('2', 'unused-review-B');
  assert.deepEqual(cl.go([running()]), []);
  assert.deepEqual(reviewObligations(cl.state(), 'a', 1), ['closure-review']);
});

test('RR1: adding/removing a closure obligation ends the epoch', () => {
  for (const touches of [true, false]) {
    const r = rig(1, !touches); r.submit('1'); r.launch(1); r.submit('2', 'review-A', 'closure-A', touches);
    const a = r.go([running()])[0];
    assert.ok(a?.do === 'launch' && a.n === 2);
  }
});

test('RR1: asking carried reviewer is reported with rid/qid/rev instead of a new launch', () => {
  const r = rig(); r.submit('1'); r.launch(1); r.submit('2');
  const a = r.go([{ rid: R(1), state: 'asking', questions: [{ qid: 'scope', rev: 2, question: 'Which scope?' }] }])[0];
  assert.ok(a?.do === 'notify' && a.rid === R(1) && a.qid === 'scope' && a.rev === 2);
  assert.match(a.text, /Which scope\?/);
});

test('RR1: ruling steer reaches a carried running reviewer (writer already sealed)', () => {
  const r = rig(); r.submit('1'); r.launch(1); r.submit('2');
  r.add({ kind: 'rule', by: 'parent:main', nodes: ['a'], text: 'Check the failure path' });
  const a = r.go([running()])[0];
  assert.ok(a?.do === 'send' && a.rid === R(1) && a.sendKind === 'steer' && a.reason === 'ruling');
  assert.match(a.message, /Check the failure path/);
});

test('RR2: same-key review recorded before resubmit counts, even when another principal is still owed', () => {
  const r = rig(2); r.submit('1'); r.launch(1); r.launch(2); r.review(); r.submit('2');
  assert.deepEqual(r.go([sealed(), running(2)]), []);
  r.review(who(2));
  assert.deepEqual(r.go([sealed(), sealed(2)]), [{ do: 'merge', node: 'a' }]);
});

test('RR2: verdict budget stays per current candidate, then halts after its follow-up', () => {
  const r = rig(); r.submit('1'); r.launch(1); r.send(R(1), 'verdict'); r.submit('2');
  const a = r.go([sealed()])[0];
  assert.ok(a?.do === 'send' && a.reason === 'verdict' && a.rid === R(1));
  assert.equal(a.message, verdictMessage('a', r.state().nodes.a!.candidate!, who(1), ['review']));
  const sent = r.send(R(1), 'verdict'), halted = r.go([sealed()])[0];
  assert.ok(halted?.do === 'halt');
  assert.match(halted.reason, new RegExp(`after verdict follow-up ${sent.kind === 'send' ? sent.send : ''}`));
});

test('RR2: carried unknown/pruned/rejected reviewer uses existing failure routes', () => {
  for (const v of [sealed(1, 'unknown'), { ...sealed(), state: 'pruned' as const }, sealed(1, 'rejected')]) {
    const r = rig(); r.submit('1'); r.launch(1); r.submit('2'); const a = r.go([v])[0];
    if (v.status === 'unknown') assert.ok(a?.do === 'send' && a.rid === R(1) && a.reason === 'interrupted');
    else assert.ok(a?.do === 'halt' && a.reason.startsWith('review-missing:'));
  }
});

test('RR1: missing carried run view waits; absent carried run relaunches exact stored bytes', () => {
  const r = rig(); r.submit('1'); const launch = r.launch(1); r.submit('2');
  assert.deepEqual(r.go([]), []);
  const a = r.go([{ rid: R(1), state: 'absent' }])[0];
  assert.ok(a?.do === 'launch' && a.rid === R(1));
  assert.ok(launch.kind === 'launch');
  assert.equal(sha256(a.spec), launch.spec);
  assert.match(JSON.parse(a.spec).task, /Candidate: candidate-1/);
});

test('RR3: duplicate principal reviews never satisfy count=2, and pending evidence is unchanged', () => {
  const r = rig(2); r.submit('1'); const first = r.review(), second = r.review();
  const s = r.state(), card = receipt(s, r.entries, 'a'), item = card.items.find(i => i.obligation === 'review')!;
  assert.equal(s.nodes.a!.accepted, false);
  assert.equal(item.status, 'D');
  assert.deepEqual(item.evidence, [first.seq, second.seq]);
});

test('RR1 runtime: driver observes carried reviewer after resubmit, and liveRunLines still lists it', async () => {
  const r = await repo();
  try {
    await r.put('README', 'fixture\n'); await r.commit();
    const plan: Plan = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: [
      { id: 'a', deps: [], writes: ['a.txt'], checks: [], review: { count: 1, min_rank: 1 } },
    ] };
    const parent = { role: 'parent' as const, id: 'drive' }, owner = { role: 'owner' as const, id: 'pi' };
    await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify(plan) });
    const slot = await ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' });
    const ledger = await Ledger.open(r.cwd);
    const state = async () => {
      const entries = await ledger.read(), plans = new Map<string, Plan>();
      for (const e of entries) if (e.kind === 'genesis' || e.kind === 'plan') plans.set(e.plan, parsePlan((await ledger.getBlob(e.plan)).toString('utf8')));
      return reduce(entries, sha => plans.get(sha)!);
    };
    const s = await state(), project = projectId(s), writer = writerLaunch(s, 'a', project);
    await ops.launch({ cwd: r.cwd, as: parent, ...writer });
    await commitAt(slot.worktree, { 'a.txt': 'a\n' });
    await ops.submit({ cwd: slot.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
    await ops.attest({ cwd: r.cwd, node: 'a' });
    const reviewer = reviewerLaunch(await state(), 'a', 1, project, r.cwd);
    await ops.launch({ cwd: r.cwd, as: parent, ...reviewer });
    await ops.submit({ cwd: slot.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
    // Control describe only, never start dsa or another writer/reviewer process.
    class Views extends Dsa {
      seen: string[] = [];
      override async inspect(rid: string) {
        this.seen.push(rid);
        return { view: { rid, state: rid === writer.rid ? 'sealed' as const : 'running' as const,
          ...(rid === writer.rid ? { status: 'ok' } : {}) } };
      }
    }
    const dsa = new Views({ bin: process.execPath }), driver = new Driver({ cwd: r.cwd, dsa, log: () => {}, session: null });
    const result = await driver.pass();
    assert.ok(dsa.seen.includes(reviewer.rid), 'observe must describe the carried reviewer');
    assert.equal(result.actions.some(r => r.do === 'launch' || r.do === 'halt'), false);
    const lines = await liveRunLines(r.cwd, dsa);
    assert.ok(lines.some(l => l === `a reviewer ${reviewer.rid}: running`), lines.join('\n'));
    assert.equal((await ledger.read()).filter(e => e.kind === 'launch' && e.role === 'reviewer').length, 1);
  } finally { await r.cleanup(); }
});
