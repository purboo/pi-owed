// K5 (0.7): the repair budget counts repairs since the node's epoch (the latest ruling naming it, or plan entry that
// changed its spec); a ruling reaches a sealed writer as a `ruling` follow-up; the same count below min_tests twice
// halts for the parent; halt texts cite the failing observations. Timelines from wais (FLAKY-COLDPLAY, QA-REGISTRY).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../src/canon.ts';
import * as driveMod from '../src/drive.ts';
import { SKIP_ATTEST } from '../src/views.ts';
import { decide, type Action, type DriveOpts } from '../src/drive.ts';
import { reduce, runId, validateDraft } from '../src/reducer.ts';
import type { CandidateFacts, CheckSpec, Counts, Draft, Entry, NodeSpec, Plan, RunView, SendEntry, State } from '../src/types.ts';

// ---------- synthetic ledger rig (no git), as in rulings-carried.test.ts; the plan can change ----------
const P = 'hash0';
const W = runId(P, 'a', 1, 'writer'), R1 = runId(P, 'a', 1, 'reviewer', 1);
const T0 = Date.UTC(2026, 0, 1);
const iso = (seq: number) => new Date(T0 + seq * 1000).toISOString();
const check = (o: Partial<CheckSpec> & { id: string }): CheckSpec => ({ run: 'npm test', timeout_s: 60, reads: ['a/**'], ...o });
const spec = (o: Partial<NodeSpec> & { id: string }): NodeSpec => ({ deps: [], writes: [`${o.id}/`], checks: [], review: { count: 0, min_rank: 1 }, ...o });
const planOf = (a: NodeSpec): Plan => ({ version: 1, trunk: 'main', closure: ['closure/'], invariants: [], drive: { max: 4, repairs: 2, writer: { agent: 'worker' }, reviewer: { agent: 'reviewer' } }, nodes: [a, spec({ id: 'c' })] });
const A0 = spec({ id: 'a', title: 'Node A', brief: 'Do A.', checks: [check({ id: 'unit' })] });

function rig(a: NodeSpec = A0) {
  const entries: Entry[] = [], plans: Record<string, Plan> = { p: planOf(a) }, blobs = new Map<string, string>();
  const state = (): State => reduce(entries, sha => plans[sha]!);
  const add = (d: Draft): Entry => { const seq = entries.length, e = { ...d, seq, ts: iso(seq), prev: 'x', hash: `hash${seq}` } as Entry; entries.push(e); state(); return e; };
  const blob = (text: string): string => { const h = sha256(text); blobs.set(h, text); return h; };
  add({ kind: 'genesis', by: 'owner:human', channel: 'tty', plan: 'p', trunk: 'main', commit: 's0', state: { commit: 's0', tree: 't0', invKeys: {} } });
  let tags = 0;
  const r = {
    entries, blobs, state, add,
    dispatch() { return add({ kind: 'dispatch', by: 'parent:drive', node: 'a', attempt: 1, base: 's0', branch: 'owed/a/1', worktree: '/repo/.owed/wt/a-1', packet: 'blob', rulings_seen: Math.max(-1, ...state().rules.map(x => x.seq)) }); },
    /** Records a launch or send action as the executor does through ops.launch / ops.send. */
    record(x: Action | undefined): Entry {
      if (x?.do === 'launch') return add({ kind: 'launch', by: 'parent:drive', node: x.node, attempt: x.attempt, role: x.role, rid: x.rid, spec: blob(x.spec), labels: x.labels, ...(x.rulings !== undefined ? { rulings: x.rulings } : {}) });
      assert.ok(x?.do === 'send', `a send: ${JSON.stringify(x)}`);
      return add({ kind: 'send', by: 'parent:drive', node: x.node, attempt: x.attempt, rid: x.rid, send: `${x.rid}:${x.sendKind}:${entries.length}`, sendKind: x.sendKind, message: blob(x.message), reason: x.reason, ...(x.rulings !== undefined ? { rulings: x.rulings } : {}) });
    },
    halt(x: Action | undefined) { assert.ok(x?.do === 'halt', `a halt: ${JSON.stringify(x)}`); return add({ kind: 'halt', by: 'parent:drive', node: x.node, attempt: x.attempt, reason: x.reason, needs: x.needs }); },
    /** A plan entry replacing node a's spec. */
    plan(next: NodeSpec, by = 'owner:human') { const sha = `p${Object.keys(plans).length + 1}`; plans[sha] = planOf(next); return add({ kind: 'plan', by, channel: 'tty', prior: state().planSha, plan: sha, downgrades: [] }); },
    submit() {
      const s = state(), tag = String(++tags), n = s.plan.nodes.find(x => x.id === 'a')!;
      const obligations = [...n.checks.map(c => `check:${c.id}`), 'writes', 'rulings', ...(n.review.count ? ['review'] : [])];
      // A check's key depends on its definition (min_tests included), as in git.ts.
      const facts: CandidateFacts = { commit: `ac${tag}`, tree: `t${tag}`, base: 's0', patch: `p${tag}`, changed: ['a/x'], closureTouched: false,
        keys: Object.fromEntries(obligations.map(o => [o, `a-${o}-${tag}-${sha256(JSON.stringify(n.checks.find(c => `check:${c.id}` === o) ?? null)).slice(0, 8)}`])) };
      const e = add({ kind: 'submit', by: 'writer:a#1', node: 'a', attempt: 1, facts });
      // The attribution reruns of earlier failures reproduce them (rows 9-10), so only the new candidate's failures block.
      for (const b of state().nodes.a!.blocks.filter(b => b.kind === 'exec' && b.state === 'active')) {
        const o = entries.find(x => x.seq === b.seq) as Extract<Entry, { kind: 'obs' }>;
        add({ kind: 'obs', by: 'executor:owed', subject: 'a', obligation: b.obligation, key: b.key, verdict: 'fail', exit: 1, durationMs: 1, commit: o.commit, base: o.base, attribution: true });
      }
      return e;
    },
    obs(obligation: string, verdict: 'pass' | 'fail', o: { exit?: number; counts?: Counts; note?: string } = {}) {
      const c = state().nodes.a!.candidate!;
      return add({ kind: 'obs', by: 'executor:owed', subject: 'a', obligation, key: c.keys[obligation]!, verdict, exit: o.exit ?? (verdict === 'pass' ? 0 : 1), ...(o.counts ? { counts: o.counts } : {}), ...(o.note ? { note: o.note } : {}), durationMs: 1, commit: c.commit, base: c.base });
    },
    /** Every measured item but `except` passes. */
    pass(...except: string[]) { for (const o of state().nodes.a!.items.map(i => i.obligation).filter(o => (o === 'writes' || o.startsWith('check:')) && !except.includes(o))) r.obs(o, 'pass', { counts: { tests: 5, pass: 5, fail: 0 } }); },
    review(verdict: 'ok' | 'block', o: { needs?: 'parent'; note?: string } = {}) {
      const c = state().nodes.a!.candidate!;
      return add({ kind: 'review', by: 'reviewer:drive-a-1-1', node: 'a', attempt: 1, obligation: 'review', key: c.keys.review!, verdict, rank: 1, note: o.note ?? 'n', ...(o.needs ? { needs: o.needs } : {}) });
    },
    rule(text: string, nodes: string[] | '*' = ['a']) { return add({ kind: 'rule', by: 'parent:main', text, nodes }); },
  };
  return r;
}
type Rig = ReturnType<typeof rig>;
const view = (rid: string, state: RunView['state'], extra: Partial<RunView> = {}): [string, RunView] => [rid, { rid, state, ...extra }];
const sealed = (...more: [string, RunView][]) => new Map([view(W, 'sealed', { status: 'ok' }), ...more]);
const running = (...more: [string, RunView][]) => new Map([view(W, 'running'), ...more]);
const optsOf = (r: Rig, o: Partial<DriveOpts> = {}): DriveOpts => ({ max: 4, repairs: 2, project: P, root: '/repo', applied: new Set(r.entries.flatMap(e => e.kind === 'send' ? [e.send] : [])), rejected: new Map(), blobs: r.blobs, ...o });
function act(r: Rig, runs: Map<string, RunView> = sealed(), o: Partial<DriveOpts> = {}): Action | undefined {
  const s = r.state(), mine = decide(s, s.plan, runs, optsOf(r, o)).filter(x => x.node === 'a');
  assert.ok(mine.length <= 1, `at most one action per node: ${JSON.stringify(mine)}`);
  return mine[0];
}
const isSend = (x: Action | undefined, reason: string): x is Extract<Action, { do: 'send' }> => x?.do === 'send' && x.reason === reason;
/** Dispatched and the writer launched. */
function started(a: NodeSpec = A0): Rig { const r = rig(a); r.dispatch(); r.record(act(r, new Map())); return r; }
/** K1.3: each `owed attest <node>` in a writer message is followed by the skip clause (or none occurs). */
const attestAdvice = (message: string): boolean => [...message.matchAll(/owed attest \S+( \(skip[^)]*\))?/g)].every(m => m[1] === ` ${SKIP_ATTEST}`);
const UNDER = { tests: 100, pass: 100, fail: 0, skip: 0, format: 'cargo' } satisfies Counts;
const NOTE = 'min_tests unmet: counted 100 (100 pass, 0 fail) < min_tests 200; exit 0';

// ---------- K5.1 + K5.2: FLAKY-COLDPLAY ----------
test('K5 FLAKY-COLDPLAY: repair, plan fix of min_tests + ruling, block #403, plan + ruling #406 → a repair that carries #406 (the budget restarts)', () => {
  const flaky = spec({ id: 'a', brief: 'Make cold play deterministic.', checks: [check({ id: 'repeat', min_tests: 200 })], review: { count: 1, min_rank: 1 } });
  const r = started(flaky);
  // #382/#384: a real failure (exit 1), then repair 1.
  r.submit(); r.obs('check:repeat', 'fail', { exit: 1, counts: { tests: 20, pass: 19, fail: 1 }, note: 'a timing test failed' }); r.pass('check:repeat');
  const rep1 = act(r);
  assert.ok(isSend(rep1, 'repair'), JSON.stringify(rep1)); r.record(rep1);
  // #389/#392: the plan's threshold cannot be met; once is still a repair (the writer may have to add tests).
  r.submit(); r.obs('check:repeat', 'fail', { exit: 0, counts: UNDER, note: NOTE }); r.pass('check:repeat');
  const rep2 = act(r);
  assert.ok(isSend(rep2, 'repair'), JSON.stringify(rep2)); r.record(rep2);
  // #393: the writer refuses to pad the count: the halt cites the observation and its note.
  const h1 = act(r);
  assert.ok(h1?.do === 'halt' && h1.reason.startsWith(`writer run ${W} finished repair follow-up`), JSON.stringify(h1));
  const under = r.entries.findLast(e => e.kind === 'obs' && e.verdict === 'fail')!;
  assert.ok(h1.reason.endsWith(`; #${under.seq} check:repeat: ${NOTE})`), h1.reason);
  r.halt(h1);
  // #394/#395: the owner fixes min_tests, the parent rules.
  r.plan({ ...flaky, checks: [check({ id: 'repeat', min_tests: 100 })] });
  const r395 = r.rule('min_tests 200 was a parent planning error; keep the 5 tests');
  // #396: the submit follow-up carries the ruling first (no separate steer).
  const sub = act(r);
  assert.ok(isSend(sub, 'submit'), JSON.stringify(sub));
  assert.equal(sub.rulings, r395.seq);
  assert.equal(sub.message, [`Parent rulings for a (apply them; they override your packet):`, `- #${r395.seq} min_tests 200 was a parent planning error; keep the 5 tests`, 'commit your work and run `owed submit a`'].join('\n'));
  r.record(sub);
  assert.equal(act(r, running()), undefined, 'delivered: no ruling steer follows');
  // #398-#404: passes, reviewer 1 blocks needing a parent ruling, halt.
  r.submit(); r.pass();
  r.record(act(r));
  const b403 = r.review('block', { needs: 'parent', note: 'fails on tmpfs' });
  const h2 = act(r, sealed(view(R1, 'sealed', { status: 'ok' })));
  assert.ok(h2?.do === 'halt' && /needs a parent ruling/.test(h2.reason), JSON.stringify(h2));
  r.halt(h2);
  // #405/#406: plan v25 adds a check (the candidate is invalidated), then the ruling naming the node.
  const v25 = r.plan({ ...flaky, checks: [check({ id: 'repeat', min_tests: 100 }), check({ id: 'tmpfs', min_tests: 25 })] });
  assert.deepEqual((driveMod as { repairEpoch?: (s: State, n: string) => unknown }).repairEpoch?.(r.state(), 'a'), { seq: v25.seq, label: `plan #${v25.seq}` });
  const r406 = r.rule('option (a): a count/order seam; supersedes #395 in part');
  assert.deepEqual(driveMod.repairEpoch(r.state(), 'a'), { seq: r406.seq, label: `ruling #${r406.seq}` });
  // 0.6.1: `repairs exhausted (2 of 2)`. Now the budget restarts at #406 and the resubmit repair carries it.
  const rep3 = act(r, sealed(view(R1, 'sealed', { status: 'ok' })));
  assert.ok(isSend(rep3, 'repair'), JSON.stringify(rep3));
  assert.equal(rep3.rulings, r406.seq);
  assert.ok(rep3.message.includes(`- #${r406.seq} option (a)`) && rep3.message.includes(`#${b403.seq} review`), rep3.message);
});

// ---------- K5.1: the epoch, its label and what does not reset it ----------
test('K5.1: repairs exhausted names the epoch; a brief change restarts the budget, a title change and a * ruling do not', () => {
  const r = started();
  const fail = () => { r.submit(); r.obs('check:unit', 'fail', { note: 'boom' }); r.pass('check:unit'); };
  fail(); r.record(act(r)); fail(); r.record(act(r)); fail();
  const ex = act(r);
  assert.ok(ex?.do === 'halt', JSON.stringify(ex));
  assert.match(ex.reason, /^repairs exhausted \(2 of 2 since dispatch\): measured block check:unit \[#\d+\]; #\d+ check:unit: boom$/);
  // A `*` ruling is general guidance: no new budget, no follow-up.
  const star = r.rule('general guidance', '*');
  assert.equal(act(r)?.do, 'halt');
  assert.match((act(r) as { reason: string }).reason, /^repairs exhausted \(2 of 2 since dispatch\)/);
  // A title-only change invalidates the candidate (row 8 asks for a submit) but keeps the epoch.
  r.plan({ ...A0, title: 'Renamed' });
  assert.deepEqual(driveMod.repairEpoch(r.state(), 'a'), { seq: r.state().nodes.a!.slot!.dispatchSeq, label: 'dispatch' });
  // K3: a node `drive` change (another writer/reviewer model) keeps it too.
  r.plan({ ...A0, title: 'Renamed', drive: { writer: { agent: 'worker', model: 'm/x' }, reviewer: { model: 'm/y' } } });
  assert.equal(r.state().plan.nodes.find(x => x.id === 'a')!.drive?.writer?.model, 'm/x');
  assert.deepEqual(driveMod.repairEpoch(r.state(), 'a'), { seq: r.state().nodes.a!.slot!.dispatchSeq, label: 'dispatch' });
  // A brief change (the parent fixed the task) restarts it.
  const fixed = r.plan({ ...A0, title: 'Renamed', brief: 'Do A, as fixed.' });
  assert.deepEqual(driveMod.repairEpoch(r.state(), 'a'), { seq: fixed.seq, label: `plan #${fixed.seq}` });
  const sub = act(r);
  assert.ok(isSend(sub, 'submit') && sub.rulings === star.seq && sub.message.startsWith(`Parent rulings for a (apply them; they override your packet):\n- #${star.seq} general guidance\n`), JSON.stringify(sub));
  r.record(sub);
  fail();
  assert.ok(isSend(act(r), 'repair'), 'a fresh budget after the plan fix');
  r.record(act(r)); fail(); r.record(act(r)); fail();
  assert.match((act(r) as { reason: string }).reason, new RegExp(`^repairs exhausted \\(2 of 2 since plan #${fixed.seq}\\)`));
});

// ---------- K5.2: QA-REGISTRY ----------
test('K5 QA-REGISTRY: halt for finished-without-submit, a ruling naming the node → one ruling follow-up, not a second halt; then the halt names it', () => {
  const r = started();
  r.submit(); const fail = r.obs('check:unit', 'fail', { note: 'not ok 7 - registry scan' }); r.pass('check:unit');
  const rep = act(r);
  assert.ok(isSend(rep, 'repair'), JSON.stringify(rep));
  // K1.3: every `owed attest` the repair suggests to the driver's writer says to skip it while the driver runs.
  assert.ok(rep.message.includes(`owed attest a ${SKIP_ATTEST}`) && attestAdvice(rep.message), rep.message);
  r.record(rep);
  const h = act(r);
  assert.ok(h?.do === 'halt' && h.reason.includes(`(measured block check:unit [#${fail.seq}]; #${fail.seq} check:unit: not ok 7 - registry scan)`), JSON.stringify(h));
  r.halt(h);
  assert.equal(act(r), undefined, 'halted');
  const rule = r.rule('the brief was wrong: writes now include cli/wais.mjs');
  const f = act(r);
  assert.deepEqual(f, { do: 'send', node: 'a', attempt: 1, rid: W, sendKind: 'follow-up', reason: 'ruling', rulings: rule.seq, message: [
    'New parent rulings for a:', `#${rule.seq} (a): the brief was wrong: writes now include cli/wais.mjs`,
    `Active blocks on your candidate ac1 (submit #${r.state().nodes.a!.candidate!.seq}):`, `- #${fail.seq} check:unit: not ok 7 - registry scan`,
    'Apply these rulings; they override your packet. Then commit and run `owed submit a`.'].join('\n') });
  assert.ok(attestAdvice(f.message), 'K1.3: no bare owed attest');
  const sent = r.record(f) as SendEntry;
  // Not a repair: the budget is untouched; the writer works on it.
  assert.equal(r.state().nodes.a!.runs[0]!.sends.filter(x => x.reason === 'repair').length, 1);
  assert.equal(act(r, running()), undefined);
  // The writer finishes it without submitting: halt as today, naming the ruling follow-up.
  const again = act(r);
  assert.ok(again?.do === 'halt' && again.needs === 'human', JSON.stringify(again));
  assert.equal(again.reason, `writer run ${W} finished ruling follow-up ${sent.send} without submitting a new candidate (measured block check:unit [#${fail.seq}]; #${fail.seq} check:unit: not ok 7 - registry scan)`);
  // A rejected ruling follow-up (dsa refused it) halts like any other send.
  const rej = act(r, sealed(), { rejected: new Map([[sent.send, 'call pruned']]), applied: new Set(r.entries.flatMap(e => e.kind === 'send' && e.send !== sent.send ? [e.send] : [])) });
  assert.ok(rej?.do === 'halt' && rej.reason.startsWith(`dsa rejected send ${sent.send}: call pruned`), JSON.stringify(rej));
});

test('K5.2: a ruling during a running review, or while the clean candidate awaits merge, sends no writer follow-up; a block\'s repair carries it first', () => {
  const r = started(spec({ id: 'a', checks: [check({ id: 'unit' })], review: { count: 1, min_rank: 1 } }));
  r.submit(); r.pass(); r.record(act(r));
  const runs = sealed(view(R1, 'running'));
  assert.equal(act(r, runs), undefined, 'waiting for the reviewer');
  const star = r.rule('general guidance', '*'), named = r.rule('use the registry');
  // The reviewer gets the steer; the sealed writer gets nothing while the review runs.
  const steer = act(r, runs);
  assert.ok(isSend(steer, 'ruling') && steer.rid === R1 && steer.sendKind === 'steer' && steer.rulings === named.seq, JSON.stringify(steer));
  r.record(steer);
  assert.equal(act(r, runs), undefined, 'no writer follow-up during a running review');
  // The reviewer blocks: the repair (not a ruling follow-up) carries both rulings, first.
  const b = r.review('block', { note: 'not per the ruling' });
  const rep = act(r, sealed(view(R1, 'sealed', { status: 'ok' })));
  assert.ok(isSend(rep, 'repair') && rep.rulings === named.seq, JSON.stringify(rep));
  assert.ok(rep.message.startsWith(`Rulings since dispatch:\n- #${star.seq} general guidance\n- #${named.seq} use the registry\nowed found problems`), rep.message);
  assert.ok(rep.message.includes(`- #${b.seq} review by reviewer:drive-a-1-1 rank 1: not per the ruling`));
  // A ruling while the clean candidate awaits merge does not wake the writer either, nor replaces the stalled halt of a
  // candidate without a block.
  const m = started(spec({ id: 'a', checks: [check({ id: 'unit' })], review: { count: 1, min_rank: 1 } }));
  m.submit(); m.pass(); m.record(act(m));
  const named2 = m.rule('use the registry');
  m.add({ kind: 'review', by: 'reviewer:drive-a-1-1', node: 'a', attempt: 1, obligation: 'review', key: m.state().nodes.a!.candidate!.keys.review!, verdict: 'ok', rank: 1, note: 'fine', ack_rulings: named2.seq });
  const ok = sealed(view(R1, 'sealed', { status: 'ok' }));
  assert.deepEqual(act(m, ok), { do: 'merge', node: 'a' }, 'accepted: merge, the writer is not woken');
  // A later ruling leaves `rulings` unacknowledged and nothing runs. 0.8 (L3.1): instead of the stalled halt, the
  // candidate's sealed reviewer gets the ruling (its ack discharges `rulings`); the writer is still not woken.
  const late = m.rule('a late note for a');
  const st = act(m, ok);
  assert.ok(isSend(st, 'ruling') && st.rid === R1 && st.sendKind === 'follow-up' && st.rulings === late.seq, JSON.stringify(st));
});

test('K5.2: a ruling after the halt for finished-without-submit (no candidate) → a ruling follow-up; a * ruling does not; then the halt names it', () => {
  const r = started();
  const sub = act(r);
  assert.ok(isSend(sub, 'submit'), JSON.stringify(sub));
  const nudge = r.record(sub) as SendEntry;
  const h = act(r);
  assert.ok(h?.do === 'halt' && h.reason === `writer run ${W} finished without submitting a candidate after follow-up ${nudge.send}`, JSON.stringify(h));
  // A * ruling does not clear the halt, and without the halt it would not trigger a follow-up either.
  const star = r.rule('general', '*');
  assert.deepEqual(act(r), h, 'the same halt');
  r.halt(h);
  assert.equal(act(r), undefined);
  const rule = r.rule('the parent fixed the brief: only a/x');
  const f = act(r);
  assert.ok(isSend(f, 'ruling') && f.sendKind === 'follow-up' && f.rid === W && f.rulings === rule.seq, JSON.stringify(f));
  assert.equal(f.message, ['New parent rulings for a:', `#${star.seq} (*): general`, `#${rule.seq} (a): the parent fixed the brief: only a/x`, 'Apply these rulings; they override your packet. Then commit and run `owed submit a`.'].join('\n'));
  const sent = r.record(f) as SendEntry;
  assert.equal(act(r, running()), undefined);
  const again = act(r);
  assert.ok(again?.do === 'halt' && again.reason === `writer run ${W} finished ruling follow-up ${sent.send} without submitting a new candidate (no candidate after follow-up ${nudge.send})`, JSON.stringify(again));
});

// ---------- K5.3: the threshold hint ----------
test('K5.3: the same count below min_tests twice halts for the parent; a ruling after it gets a repair carrying it, no second hint', () => {
  const r = started(spec({ id: 'a', checks: [check({ id: 'unit', min_tests: 200 })] }));
  r.submit(); r.obs('check:unit', 'fail', { exit: 0, counts: UNDER, note: NOTE }); r.pass('check:unit');
  const once = act(r);
  assert.ok(isSend(once, 'repair'), `the first under-count is repaired: ${JSON.stringify(once)}`);
  r.record(once);
  r.submit(); r.obs('check:unit', 'fail', { exit: 0, counts: UNDER, note: NOTE }); r.pass('check:unit');
  const hint = act(r, sealed(), { repairs: 5 });
  assert.deepEqual(hint, { do: 'halt', node: 'a', attempt: 1, needs: 'human',
    reason: 'check unit: 100 tests ran and passed twice, below min_tests 200; the plan\'s threshold may be wrong: fix the plan (owed plan) or rule (owed rule --nodes a "…")' });
  assert.equal(driveMod.thresholdHint(r.state(), 'a', ['check:unit']), (hint as { reason: string }).reason);
  r.halt(hint);
  // A * ruling neither clears the halt nor changes the hint.
  r.rule('general', '*');
  assert.equal(act(r), undefined);
  const rule = r.rule('add tests until the count is met');
  // repairs 1: without the epoch the one repair already sent would exhaust it.
  const rep = act(r, sealed(), { repairs: 1 });
  assert.ok(isSend(rep, 'repair') && rep.rulings === rule.seq && rep.message.startsWith(`Rulings since dispatch:\n- #${rule.seq - 1} general\n- #${rule.seq} add tests`), JSON.stringify(rep));
});

test('K5.3: no hint for different counts, a failing test, a non-zero exit, or once', () => {
  const twice = (a: Partial<{ exit: number; counts: Counts }>, b: Partial<{ exit: number; counts: Counts }>) => {
    const r = started(spec({ id: 'a', checks: [check({ id: 'unit', min_tests: 200 })] }));
    r.submit(); r.obs('check:unit', 'fail', { exit: 0, counts: UNDER, ...a }); r.pass('check:unit'); r.record(act(r));
    r.submit(); r.obs('check:unit', 'fail', { exit: 0, counts: UNDER, ...b }); r.pass('check:unit');
    return act(r, sealed(), { repairs: 5 });
  };
  assert.equal(twice({}, {})?.do, 'halt');
  assert.ok(isSend(twice({}, { counts: { ...UNDER, tests: 101, pass: 101 } }), 'repair'), 'different counts');
  assert.ok(isSend(twice({}, { counts: { ...UNDER, pass: 99, fail: 1 } }), 'repair'), 'a failing test');
  assert.ok(isSend(twice({ exit: 1 }, {}), 'repair'), 'a non-zero exit');
  // At or above min_tests (a count fail for another reason) is no threshold hint either.
  const r = started(spec({ id: 'a', checks: [check({ id: 'unit', min_tests: 100 })] }));
  r.submit(); r.obs('check:unit', 'fail', { exit: 0, counts: UNDER }); r.pass('check:unit'); r.record(act(r));
  r.submit(); r.obs('check:unit', 'fail', { exit: 0, counts: UNDER }); r.pass('check:unit');
  assert.ok(isSend(act(r, sealed(), { repairs: 5 }), 'repair'));
});

// ---------- K5.4: halt evidence is one line of at most 200 characters ----------
test('K5.4: each cited observation is one line of at most 200 characters', () => {
  const r = started();
  r.submit(); const o = r.obs('check:unit', 'fail', { note: `line one\nline two ${'x'.repeat(400)}` }); r.pass('check:unit');
  r.record(act(r));
  const h = act(r);
  assert.ok(h?.do === 'halt', JSON.stringify(h));
  const cited = h.reason.slice(h.reason.indexOf(`; #${o.seq} `) + 2, -1);
  assert.ok(cited.startsWith(`#${o.seq} check:unit: line one\\nline two xxx`), cited);
  assert.equal(cited.length, 200);
  assert.ok(cited.endsWith('…') && !h.reason.includes('\n'));
});

// ---------- K5.2: rulings on submit and rebase follow-ups; replay validation ----------
test('K5.2: a rebase follow-up carries undelivered rulings first; replay accepts rulings on submit/rebase sends and checks them as on repair', () => {
  const r = started();
  r.submit(); r.pass();
  r.add({ kind: 'adopt', by: 'owner:human', channel: 'tty', trunk: 'main', prior: 's0', commit: 's1', state: { commit: 's1', tree: 't1', invKeys: {} }, changed: ['x'], commits: 1, note: 'moved' });
  r.add({ kind: 'rebase', by: 'parent:drive', node: 'a', attempt: 1, base: 's1', from: 's0' });
  const plain = act(r);
  assert.ok(isSend(plain, 'rebase') && !('rulings' in plain) && plain.message.startsWith('trunk moved;'), `no ruling to carry: no field (0.6.x reads it): ${JSON.stringify(plain)}`);
  const x = r.rule('keep the API'), c = r.rule('for c only', ['c']);
  const rb = act(r);
  assert.ok(isSend(rb, 'rebase') && rb.rulings === x.seq, JSON.stringify(rb));
  assert.ok(attestAdvice(rb.message) && attestAdvice(plain.message));
  assert.ok(rb.message.startsWith(`Parent rulings for a (apply them; they override your packet):\n- #${x.seq} keep the API\ntrunk moved; rebase your worktree`), rb.message);
  const e = r.record(rb) as SendEntry;
  assert.equal(e.rulings, x.seq, 'replay accepts it');
  const s = r.state(), seq = s.seq + 1;
  const send = (o: object): Draft => ({ kind: 'send', by: 'parent:drive', node: 'a', attempt: 1, rid: W, send: `${W}:follow-up:${seq}`, sendKind: 'follow-up', message: sha256('m'), reason: 'submit', ...o }) as Draft;
  for (const reason of ['submit', 'rebase']) {
    assert.deepEqual(validateDraft(s, send({ reason, rulings: x.seq })), [], reason);
    assert.deepEqual(validateDraft(s, send({ reason, rulings: 0 })), [], `${reason} 0`);
    assert.match(validateDraft(s, send({ reason, rulings: c.seq })).join('; '), new RegExp(`send reason ${reason} rulings must be 0 or the seq of a ruling covering a`));
    assert.match(validateDraft(s, send({ reason, rulings: seq + 3 })).join('; '), /rulings must be 0 or the seq/);
  }
  assert.match(validateDraft(s, send({ reason: 'interrupted', rulings: x.seq })).join('; '), /send rulings is only allowed with reason ruling, repair, submit or rebase/);
  const bad = { ...send({ rulings: c.seq }), seq, ts: iso(seq), prev: 'x', hash: `hash${seq}` } as Entry;
  assert.throws(() => reduce([...r.entries, bad], () => planOf(A0)), /Entry #\d+ invalid: send reason submit rulings must be 0 or the seq of a ruling covering a/);
  // Delivered: no ruling steer once the writer runs the rebase.
  assert.equal(act(r, running()), undefined);
});
