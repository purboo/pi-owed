// 0.8 L3 (ruling-any, wais #21, #22 part 3): a ruling reaches a sealed writer before any halt (owner-needed, writer
// sealed non-ok, stalled), or a reviewer when the candidate's only debt is `rulings`; flaky hints offer a ruling; owed
// plan warns about a check that loops its command with min_tests.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sha256 } from '../src/canon.ts';
import { decide, type Action, type DriveOpts } from '../src/drive.ts';
import * as planMod from '../src/plan.ts';
import { reduce, runId, validateDraft } from '../src/reducer.ts';
import { briefView, receipt, renderBrief, renderReceipt, renderStatus, statusView } from '../src/views.ts';
import type { CandidateFacts, CheckSpec, Draft, Entry, NodeSpec, Plan, RunView, SendEntry, State } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli } from './helpers/surface.ts';
delete process.env.OWED_CONFIRM;

// ---------- synthetic ledger rig (no git), as in repair-epoch.test.ts ----------
const P = 'hash0';
const W = runId(P, 'a', 1, 'writer'), R1 = runId(P, 'a', 1, 'reviewer', 1);
const T0 = Date.UTC(2026, 0, 1);
const iso = (seq: number) => new Date(T0 + seq * 1000).toISOString();
const check = (o: Partial<CheckSpec> & { id: string }): CheckSpec => ({ run: 'npm test', timeout_s: 60, reads: ['a/**'], ...o });
const spec = (o: Partial<NodeSpec> & { id: string }): NodeSpec => ({ deps: [], writes: [`${o.id}/`], checks: [], review: { count: 0, min_rank: 1 }, ...o });
const planOf = (a: NodeSpec): Plan => ({ version: 1, trunk: 'main', closure: ['closure/'], invariants: [], drive: { max: 4, repairs: 2, writer: { agent: 'worker' }, reviewer: { agent: 'reviewer' } }, nodes: [a, spec({ id: 'c' })] });
const A0 = spec({ id: 'a', checks: [check({ id: 'unit' })] });
const RULE_HINT = 'or owed rule "<what the writer must change>" --nodes a when the check or test itself must change (the writer fixes it; then the block is cleared by a new candidate\'s rerun, or superseded by a plan entry that changes the check\'s definition, see owed why)';

function rig(a: NodeSpec = A0) {
  const entries: Entry[] = [], plans: Record<string, Plan> = { p: planOf(a) }, blobs = new Map<string, string>();
  const state = (): State => reduce(entries, sha => plans[sha]!);
  const add = (d: Draft): Entry => {
    // The driver's records and the reviews are validated as owed would (a ruling follow-up to a reviewer included).
    if (d.kind === 'send' || d.kind === 'launch' || d.kind === 'review') assert.deepEqual(validateDraft(state(), d), [], `valid ${d.kind}: ${JSON.stringify(d)}`);
    const seq = entries.length, e = { ...d, seq, ts: iso(seq), prev: 'x', hash: `hash${seq}` } as Entry; entries.push(e); state(); return e;
  };
  const blob = (text: string): string => { const h = sha256(text); blobs.set(h, text); return h; };
  entries.push({ kind: 'genesis', by: 'owner:human', channel: 'tty', plan: 'p', trunk: 'main', commit: 's0', state: { commit: 's0', tree: 't0', invKeys: {} }, seq: 0, ts: iso(0), prev: '', hash: 'hash0' } as Entry);
  let tags = 0;
  const r = {
    entries, blobs, state, add,
    dispatch() { return add({ kind: 'dispatch', by: 'parent:drive', node: 'a', attempt: 1, base: 's0', branch: 'owed/a/1', worktree: '/repo/.owed/wt/a-1', packet: blob('packet'), rulings_seen: Math.max(-1, ...state().rules.map(x => x.seq)) }); },
    record(x: Action | undefined): Entry {
      if (x?.do === 'launch') return add({ kind: 'launch', by: 'parent:drive', node: x.node, attempt: x.attempt, role: x.role, rid: x.rid, spec: blob(x.spec), labels: x.labels, ...(x.rulings !== undefined ? { rulings: x.rulings } : {}) });
      assert.ok(x?.do === 'send', `a send: ${JSON.stringify(x)}`);
      return add({ kind: 'send', by: 'parent:drive', node: x.node, attempt: x.attempt, rid: x.rid, send: `${x.rid}:${x.sendKind}:${entries.length}`, sendKind: x.sendKind, message: blob(x.message), reason: x.reason, ...(x.rulings !== undefined ? { rulings: x.rulings } : {}) });
    },
    halt(x: Action | undefined) { assert.ok(x?.do === 'halt', `a halt: ${JSON.stringify(x)}`); return add({ kind: 'halt', by: 'parent:drive', node: x.node, attempt: x.attempt, reason: x.reason, needs: x.needs }); },
    submit() {
      const s = state(), tag = String(++tags), n = s.plan.nodes.find(x => x.id === 'a')!;
      const obligations = [...n.checks.map(c => `check:${c.id}`), 'writes', 'rulings', ...(n.review.count ? ['review'] : [])];
      const facts: CandidateFacts = { commit: `ac${tag}`, tree: `t${tag}`, base: 's0', patch: `p${tag}`, changed: ['a/x'], closureTouched: false,
        keys: Object.fromEntries(obligations.map(o => [o, `a-${o}-${tag}`])) };
      return add({ kind: 'submit', by: 'writer:a#1', node: 'a', attempt: 1, facts });
    },
    obs(obligation: string, verdict: 'pass' | 'fail', o: { note?: string; key?: string; commit?: string; attribution?: true } = {}) {
      const c = state().nodes.a!.candidate!;
      return add({ kind: 'obs', by: 'executor:owed', subject: 'a', obligation, key: o.key ?? c.keys[obligation]!, verdict, exit: verdict === 'pass' ? 0 : 1, ...(o.note ? { note: o.note } : {}), durationMs: 1, commit: o.commit ?? c.commit, base: c.base, ...(o.attribution ? { attribution: true } : {}) });
    },
    pass(...except: string[]) { for (const o of state().nodes.a!.items.map(i => i.obligation).filter(o => (o === 'writes' || o.startsWith('check:')) && !except.includes(o))) r.obs(o, 'pass'); },
    review(verdict: 'ok' | 'block', o: { by?: string; ack?: number; note?: string } = {}) {
      const c = state().nodes.a!.candidate!;
      return add({ kind: 'review', by: o.by ?? 'reviewer:drive-a-1-1', node: 'a', attempt: 1, obligation: 'review', key: c.keys.review!, verdict, rank: 1, note: o.note ?? 'n', ...(o.ack !== undefined ? { ack_rulings: o.ack } : {}) });
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
function started(a: NodeSpec = A0): Rig { const r = rig(a); r.dispatch(); r.record(act(r, new Map())); return r; }

/**
 * #21 AG-QPOINT: candidate 1 fails check:unit (#f), candidate 2 passes, and the attribution rerun of candidate 1's
 * content passes: #f is flaky and the node needs the owner.
 */
function flakyNode(): { r: Rig; f: Entry } {
  const r = started();
  r.submit(); const f = r.obs('check:unit', 'fail', { note: 'not ok 3 - qpoint order is nondeterministic' }); r.pass('check:unit');
  const rep = act(r);
  assert.ok(isSend(rep, 'repair'), JSON.stringify(rep)); r.record(rep);
  const k1 = r.state().nodes.a!.candidate!.keys['check:unit']!;
  r.submit(); r.obs('check:unit', 'pass'); r.pass('check:unit');
  r.obs('check:unit', 'pass', { key: k1, commit: 'ac1', attribution: true });
  assert.equal(r.state().nodes.a!.blocks.find(b => b.seq === f.seq)?.state, 'flaky');
  return { r, f };
}

// ---------- L3.1 ----------
test('L3.1 #21: an owner-needed node (flaky block) with a sealed writer gets the ruling follow-up first, once; then the notify', () => {
  const { r, f } = flakyNode();
  const n0 = act(r);
  assert.ok(n0?.do === 'notify' && n0.text.includes(`flaky block #${f.seq} on check:unit`), JSON.stringify(n0));
  // A * ruling alone never triggers a follow-up.
  const star = r.rule('general guidance', '*');
  assert.equal(act(r)?.do, 'notify');
  const rule = r.rule('make the qpoint test deterministic: sort before comparing');
  // While the writer runs, nothing is sent to it (it is not sealed): the notify stays.
  assert.equal(act(r, running())?.do, 'notify');
  const fu = act(r);
  assert.ok(isSend(fu, 'ruling') && fu.rid === W && fu.sendKind === 'follow-up' && fu.rulings === rule.seq, JSON.stringify(fu));
  assert.equal(fu.message, ['New parent rulings for a:', `#${star.seq} (*): general guidance`, `#${rule.seq} (a): make the qpoint test deterministic: sort before comparing`,
    'Flaky blocks of a (an attribution rerun of the failing content passed):', `- #${f.seq} check:unit: not ok 3 - qpoint order is nondeterministic`,
    'Apply these rulings; they override your packet. Then commit and run `owed submit a`.'].join('\n'));
  r.record(fu);
  // Sent once: running or sealed again without a new candidate, the node still needs the owner and is notified.
  assert.equal(act(r, running())?.do, 'notify');
  const again = act(r);
  assert.ok(again?.do === 'notify' && again.text.includes(`flaky block #${f.seq}`), JSON.stringify(again));
  // Not a repair: the budget is untouched.
  assert.equal(r.state().nodes.a!.runs[0]!.sends.filter(x => x.reason === 'repair').length, 1);
});

test('L3.1: row 7 (writer sealed non-ok) sends a due ruling follow-up first, then halts as before; an unsealed reviewer or a needs-parent block keeps the old route', () => {
  const r = started();
  const err = new Map([view(W, 'sealed', { status: 'error', error: 'model overloaded' })]);
  const h = act(r, err);
  assert.ok(h?.do === 'halt' && h.reason === `writer run ${W} sealed error: model overloaded`, JSON.stringify(h));
  r.halt(h);
  const rule = r.rule('retry with the smaller fixture');
  const fu = act(r, err);
  assert.ok(isSend(fu, 'ruling') && fu.rid === W && fu.rulings === rule.seq, JSON.stringify(fu));
  assert.equal(fu.message, ['New parent rulings for a:', `#${rule.seq} (a): retry with the smaller fixture`, 'Apply these rulings; they override your packet. Then commit and run `owed submit a`.'].join('\n'));
  r.record(fu);
  const h2 = act(r, err);
  assert.ok(h2?.do === 'halt' && h2.reason === `writer run ${W} sealed error: model overloaded`, JSON.stringify(h2));

  // A needs-parent review block on the latest candidate: D18 route (the ruling resolves the block; the repair carries it),
  // not a ruling follow-up, even when the writer sealed non-ok.
  const q = started(spec({ id: 'a', checks: [check({ id: 'unit' })], review: { count: 1, min_rank: 1 } }));
  q.submit(); q.pass(); q.record(act(q));
  q.add({ kind: 'review', by: 'reviewer:drive-a-1-1', node: 'a', attempt: 1, obligation: 'review', key: q.state().nodes.a!.candidate!.keys.review!, verdict: 'block', rank: 1, note: 'contract unclear', needs: 'parent' });
  q.rule('option (b)');
  const qa = act(q, new Map([view(W, 'sealed', { status: 'error' }), view(R1, 'sealed', { status: 'ok' })]));
  assert.ok(qa?.do === 'halt' && qa.reason.startsWith(`writer run ${W} sealed error`), JSON.stringify(qa));
});

test('L3.1: at the stalled point a clean candidate owing only `rulings` sends the ruling to its reviewer (or launches one); an ok with --ack-rulings merges, a block repairs', () => {
  const r = started(spec({ id: 'a', checks: [check({ id: 'unit' })], review: { count: 1, min_rank: 1 } }));
  r.submit(); r.pass(); r.record(act(r));
  r.review('ok');
  const ok = sealed(view(R1, 'sealed', { status: 'ok' }));
  assert.deepEqual(act(r, ok), { do: 'merge', node: 'a' });
  const rule = r.rule('also cover the empty registry');
  const fu = act(r, ok);
  assert.ok(isSend(fu, 'ruling') && fu.rid === R1 && fu.sendKind === 'follow-up' && fu.rulings === rule.seq, JSON.stringify(fu));
  const c = r.state().nodes.a!.candidate!;
  assert.equal(fu.message, ['New parent rulings for a:', `#${rule.seq} (a): also cover the empty registry`,
    `Re-review the current candidate ${c.commit} (submit #${c.seq}) in their light and record your verdict with --ack-rulings ${rule.seq}; block if the writer must change something.`].join('\n'));
  r.record(fu);
  // The reviewer works: no steer (delivered), no halt.
  assert.equal(act(r, sealed(view(R1, 'running'))), undefined);
  // It seals without a verdict: sent once, so the stalled halt follows.
  const st = act(r, ok);
  assert.ok(st?.do === 'halt' && st.needs === 'owner' && st.reason.startsWith('stalled: rulings'), JSON.stringify(st));
  // Its ok review with the ack discharges `rulings`: merge.
  r.review('ok', { ack: rule.seq });
  assert.equal(r.state().nodes.a!.accepted, true);
  assert.deepEqual(act(r, ok), { do: 'merge', node: 'a' });

  // The reviewer blocks instead: the normal repair carries the ruling to the writer.
  const b = started(spec({ id: 'a', checks: [check({ id: 'unit' })], review: { count: 1, min_rank: 1 } }));
  b.submit(); b.pass(); b.record(act(b)); b.review('ok');
  const rb = b.rule('also cover the empty registry');
  b.record(act(b, ok));
  b.review('block', { ack: rb.seq, note: 'the empty registry is not covered' });
  const rep = act(b, ok);
  assert.ok(isSend(rep, 'repair') && rep.rid === W && rep.rulings === rb.seq && rep.message.includes(`- #${rb.seq} also cover the empty registry`), JSON.stringify(rep));

  // No driver reviewer run of the candidate (its review came from elsewhere): a reviewer launch carrying the ruling.
  const x = started(spec({ id: 'a', checks: [check({ id: 'unit' })], review: { count: 1, min_rank: 1 } }));
  x.submit(); x.pass(); x.review('ok', { by: 'reviewer:human' });
  const rx = x.rule('also cover the empty registry');
  const l = act(x);
  assert.ok(l?.do === 'launch' && l.role === 'reviewer' && l.rid === R1 && l.rulings === rx.seq, JSON.stringify(l));
  x.record(l);
  // Its packet carries the ruling: once launched, no follow-up repeats it.
  assert.equal(act(x, sealed(view(R1, 'running'))), undefined);
  // A node without a review obligation has no reviewer to ack it: the stalled halt stays.
  const y = started();
  y.submit(); y.pass(); y.rule('a late note');
  const hy = act(y);
  assert.ok(hy?.do === 'halt' && hy.reason.startsWith('stalled: rulings'), JSON.stringify(hy));
});

// ---------- L3.2 ----------
test('L3.2: flaky hints offer a ruling next to the waiver (why, status, brief, the owner-needed notify)', () => {
  const { r, f } = flakyNode();
  const s = r.state();
  const why = renderReceipt(receipt(s, r.entries, 'a'));
  const blockLine = why.split('\n').find(l => l.startsWith(`⛔ blocked #${f.seq} check:unit`));
  assert.ok(blockLine?.includes(`owner accepts the risk: owed waive a check:unit`) && blockLine.includes(`; ${RULE_HINT}`), why);
  const status = renderStatus(statusView(s, r.entries));
  const owed = status.split('\n').find(l => l.includes('a/check:unit') && l.includes('still blocked'));
  assert.ok(owed?.includes(`owed waive a check:unit`) && owed.includes(RULE_HINT), status);
  const brief = renderBrief(briefView(s, r.entries));
  assert.ok(brief.split('\n').some(l => l.includes('a/check:unit') && l.includes(`owed waive a check:unit`) && l.includes(RULE_HINT)), brief);
  const n = act(r);
  assert.ok(n?.do === 'notify' && n.text.includes(` | ${RULE_HINT}`) && n.text.split(RULE_HINT).length === 2, JSON.stringify(n));
});

// ---------- L3.3 ----------
const LOOPED = (where: string, m: number) => `warning: ${where} runs its command in a shell loop with min_tests ${m}: min_tests counts only the last TAP (# tests) or jest/vitest (Tests:) summary in the log, i.e. one run, not the sum of the runs (only cargo "test result:" lines are added up)`;
const warningsOf = (p: Plan): string[] => ((planMod as { planWarnings?: (p: Plan) => string[] }).planWarnings ?? planMod.checklessWarnings)(p);

test('L3.3: a check that loops its command with min_tests gets a warning; without min_tests or a loop it does not', () => {
  const runs = ['for i in 1 2 3; do node --test --test-reporter=tap t.ts; done', 'while true; do npm test || break; done', 'seq 5 | xargs -I{} node --test t.ts', "bash -c 'for f in a b; do npm test; done'", 'until false\ndo npm test; done'];
  for (const run of runs) {
    const p = planOf(spec({ id: 'a', checks: [check({ id: 'rep', run, min_tests: 50 })] }));
    assert.deepEqual(warningsOf(p), ['warning: node c has no checks: its acceptance rests on review alone', LOOPED('check rep of node a', 50)], run);
  }
  for (const run of ['node --test --test-reporter=tap test/a.test.ts', 'node --seq 3 t.js', 'cargo test --features for_x']) assert.deepEqual(warningsOf(planOf(spec({ id: 'a', checks: [check({ id: 'rep', run, min_tests: 50 })] }))), ['warning: node c has no checks: its acceptance rests on review alone'], run);
  assert.deepEqual(warningsOf(planOf(spec({ id: 'a', checks: [check({ id: 'rep', run: runs[0]! })] }))), ['warning: node c has no checks: its acceptance rests on review alone']);
  // Invariants too.
  const inv = { ...planOf(A0), invariants: [check({ id: 'soak', run: 'for i in $(seq 3); do npm test; done', min_tests: 9 })] };
  assert.ok(warningsOf(inv).includes(LOOPED('invariant soak', 9)), JSON.stringify(warningsOf(inv)));
});

test('L3.3: owed plan prints the loop warning after the result, as the check-less warnings, and records nothing for it', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    const node = (id: string, run: string, extra: Record<string, unknown> = {}) => ({ id, writes: [`${id}/`], checks: [{ id: `${id}-unit`, run, reads: ['**'], ...extra }], review: { count: 1, min_rank: 1 } });
    const base = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: [node('a', 'true')] };
    await r.put('plan.json', JSON.stringify(base)); await r.commit();
    const init = await cli(r.cwd, ['init', 'plan.json']);
    assert.equal(init.code, 0, init.stderr);
    const next = { ...base, nodes: [...base.nodes, node('b', 'for i in 1 2 3; do node --test --test-reporter=tap; done', { min_tests: 30 })] };
    await r.put('next.json', JSON.stringify(next)); await r.commit();
    const out = await cli(r.cwd, ['plan', 'next.json']);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.stdout.trimEnd().split('\n').at(-1), LOOPED('check b-unit of node b', 30));
    const j = await cli(r.cwd, ['plan', 'plan.json', '--json', '--as', 'owner:pi', '--note', 'back']);
    assert.equal(j.code, 0, j.stderr);
    assert.deepEqual((JSON.parse(j.stdout) as { warnings: string[] }).warnings, []);
  } finally { await r.cleanup(); }
});
