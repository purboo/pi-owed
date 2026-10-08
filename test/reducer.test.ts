import test from 'node:test';
import assert from 'node:assert/strict';
import { attestJobs, genesisJobs, mergeGuard, mergeJobs, reduce, validateDraft } from '../src/reducer.ts';
import type { CandidateFacts, Draft, Entry, Plan, StateFacts } from '../src/types.ts';

const plan = (): Plan => ({ version: 1, trunk: 'main', closure: ['config/**'], invariants: [{ id: 'safe', run: 'safe', timeout_s: 10, reads: ['**'] }], nodes: [
  { id: 'a', deps: [], writes: ['src/'], checks: [{ id: 'unit', run: 'unit', timeout_s: 10, reads: ['src/**'], red: true, tests: ['test/**'] }], review: { count: 0, min_rank: 1 } },
  { id: 'b', deps: ['a'], writes: ['src/'], checks: [], review: { count: 0, min_rank: 1 } },
] });
const facts = (tag = '1', extra: Partial<CandidateFacts> = {}): CandidateFacts => ({ commit: `c${tag}`, base: 's0', tree: `t${tag}`, patch: `p${tag}`, changed: ['src/a'], closureTouched: false, keys: { 'check:unit': `check${tag}`, 'red:unit': `red${tag}`, writes: `writes${tag}`, rulings: `rule${tag}`, review: `review${tag}`, 'closure-review': `closure${tag}` }, ...extra });
const sf = (commit = 's0', key = 'inv0'): StateFacts => ({ commit, tree: commit === 's0' ? 't0' : 'tm', invKeys: { safe: key } });
function rig(p = plan()) {
  const entries: Entry[] = [];
  const plans: Record<string, Plan> = { p };
  const lookup = (sha: string): Plan => { const p = plans[sha]; if (!p) throw Error('missing plan'); return p; };
  const state = () => reduce(entries, lookup);
  const add = (d: Draft): number => { const seq = entries.length; entries.push({ ...d, seq, ts: 'fixed', prev: 'x', hash: `hash${seq}` } as Entry); return seq; };
  add({ kind: 'genesis', by: 'owner:human', channel: 'tty', plan: 'p', trunk: 'main', commit: 's0', state: sf() });
  const dispatch = (attempt = 1, node = 'a', base = 's0') => add({ kind: 'dispatch', by: 'parent:main', node, attempt, base, branch: 'branch', worktree: 'wt', packet: 'blob', rulings_seen: -1 });
  const submit = (f = facts(), attempt = 1) => add({ kind: 'submit', by: `writer:a#${attempt}`, node: 'a', attempt, facts: f });
  const obs = (obligation: string, key: string, verdict: 'pass' | 'fail' | 'error' = 'pass', extras: Partial<Extract<Draft, {kind: 'obs'}>> = {}) => add({ kind: 'obs', by: 'executor:owed', subject: 'a', obligation, key, verdict, exit: verdict === 'pass' ? 0 : 1, durationMs: 1, commit: 'c1', base: 's0', ...extras });
  const pass = (f = facts()) => { for (const o of ['check:unit', 'red:unit', 'writes']) obs(o, f.keys[o]!, 'pass', { commit: f.commit, base: f.base }); };
  const genesis = (verdict: 'pass' | 'fail' | 'error' = 'pass') => obs('inv:safe', 'inv0', verdict, { subject: 'trunk', commit: 's0', base: 's0' });
  const review = (verdict: 'ok' | 'block', rank = 1, key = 'review1', by = 'reviewer:r', obligation: 'review' | 'closure-review' = 'review', ack_rulings?: number) => add({ kind: 'review', by, node: 'a', attempt: 1, obligation, verdict, rank, key, ack_rulings });
  const waive = (obligation: string, key: string, accept_risk?: number[]) => add({ kind: 'waive', by: 'owner:human', channel: 'tty', node: 'a', obligation, key, reason: '接受风险', accept_risk });
  return { entries, plans, state, add, dispatch, submit, obs, pass, genesis, review, waive };
}
const mergeFacts = (key = 'inv0', check = 'check1') => ({ facts: facts('m', { tree: 'tm', keys: { ...facts().keys, 'check:unit': check, writes: 'writesM' } }), state: sf('cm', key) });
function accepted(p = plan()) { const r = rig(p); r.dispatch(); r.submit(); r.pass(); r.genesis(); return r; }

test('lifecycle: deps, slots, attempts, accumulated writers, merge makes dependents ready', () => {
  const r = rig();
  assert.equal(r.state().nodes.a?.phase, 'ready'); assert.equal(r.state().nodes.b?.phase, 'blocked');
  assert.equal(r.state().nodes.a?.dependents, 1);
  r.dispatch(); assert.equal(r.state().nodes.a?.phase, 'dispatched');
  assert.match(validateDraft(r.state(), { kind: 'submit', by: 'writer:wrong', node: 'a', attempt: 1, facts: facts() }).join(), /writer/);
  r.submit(); assert.equal(r.state().nodes.a?.phase, 'submitted');
  r.add({ kind: 'abandon', by: 'parent:main', node: 'a', attempt: 1, reason: 'retry' });
  assert.equal(r.state().nodes.a?.phase, 'ready');
  assert.match(validateDraft(r.state(), { kind: 'dispatch', by: 'parent:main', node: 'a', attempt: 1, base: 's0', branch: '', worktree: '', packet: '', rulings_seen: -1 }).join(), /attempt/);
  r.dispatch(2); r.submit(facts(), 2); r.pass(); r.genesis();
  assert.deepEqual(r.state().nodes.a?.writers, ['writer:a#1', 'writer:a#2']);
  assert.equal(r.state().nodes.a?.phase, 'accepted');
  r.obs('writes', 'writesM', 'pass', { commit: 'cm' });
  const m = mergeFacts();
  r.add({ kind: 'merge', by: 'executor:owed', node: 'a', attempt: 2, prior: 's0', commit: 'cm', ...m });
  assert.equal(r.state().nodes.a?.phase, 'merged'); assert.equal(r.state().nodes.b?.phase, 'ready');
});

test('execution lattice: pass E; fail writer debt; conflict owner; error bottom and retry', () => {
  for (const verdicts of [['pass'], ['fail'], ['pass', 'fail'], ['error']] as const) {
    const r = rig(); r.dispatch(); r.submit();
    for (const verdict of verdicts) r.obs('check:unit', 'check1', verdict);
    const s = r.state(), i = s.nodes.a!.items.find(i => i.obligation === 'check:unit')!;
    if (verdicts.length === 2) { assert.equal(i.mark, '⊤'); assert.equal(i.discharger, 'owner'); }
    else if (verdicts[0] === 'pass') assert.equal(i.status, 'E');
    else if (verdicts[0] === 'fail') { assert.equal(i.status, 'D'); assert.equal(i.discharger, 'writer'); }
    else { assert.equal(i.mark, '⊥'); assert.equal(attestJobs(s, 'a')[0]?.key, 'check1'); assert.equal(s.nodes.a!.blocks.length, 0); }
  }
});

test('old execution block survives a new passing candidate; deterministic attribution clears without creating another block', () => {
  const r = rig(); r.dispatch(); r.submit();
  const seq = r.obs('check:unit', 'check1', 'fail');
  r.submit(facts('2')); r.pass(facts('2'));
  let s = r.state(); assert.equal(s.nodes.a!.accepted, false);
  assert.deepEqual(attestJobs(s, 'a').map(j => [j.key, j.commit, j.base, j.attribution]), [['check1', 'c1', 's0', true]]);
  r.obs('check:unit', 'check1', 'error', { attribution: true });
  assert.equal(r.state().nodes.a!.blocks[0]?.state, 'active');
  r.obs('check:unit', 'check1', 'fail', { attribution: true });
  s = r.state(); assert.equal(s.nodes.a!.accepted, true);
  assert.equal(s.nodes.a!.blocks.length, 1); assert.equal(s.nodes.a!.blocks[0]?.seq, seq); assert.equal(s.nodes.a!.blocks[0]?.state, 'cleared');
});

test('flaky attribution requires a current-key owner risk waiver citing the block', () => {
  const r = rig(); r.dispatch(); r.submit(); const block = r.obs('check:unit', 'check1', 'fail');
  r.submit(facts('2')); r.pass(facts('2')); r.obs('check:unit', 'check1', 'pass', { attribution: true });
  assert.equal(r.state().nodes.a!.blocks[0]?.state, 'flaky');
  assert.equal(attestJobs(r.state(), 'a').length, 0);
  const stale: Draft = { kind: 'waive', by: 'owner:human', node: 'a', obligation: 'check:unit', key: 'check1', reason: 'risk', accept_risk: [block] };
  assert.match(validateDraft(r.state(), stale).join(), /当前候选/);
  r.waive('check:unit', 'check2'); assert.equal(r.state().nodes.a!.accepted, false);
  r.waive('check:unit', 'check2', [block]); assert.equal(r.state().nodes.a!.accepted, true);
  assert.equal(r.state().nodes.a!.blocks[0]?.state, 'cleared');
});

test('waiver W is visible; old-key waiver does not satisfy new key; owner only and no invariants', () => {
  const r = rig(); r.dispatch(); r.submit(); r.waive('check:unit', 'check1');
  let s = r.state(); assert.equal(s.nodes.a!.items[0]?.status, 'W'); assert.equal(s.nodes.a!.items[0]?.mark, '⚠');
  const w: Draft = { kind: 'waive', by: 'parent:main', node: 'a', obligation: 'check:unit', key: 'check1', reason: 'x' };
  assert.match(validateDraft(s, w).join(), /owner/);
  assert.match(validateDraft(s, { ...w, by: 'owner:human', obligation: 'inv:safe' }).join(), /invariant/);
  r.submit(facts('2')); s = r.state(); assert.equal(s.nodes.a!.items[0]?.status, 'D');
});

test('ranked judgment blocks: low rank cannot clear; same reviewer high rank can; stale keys rejected', () => {
  const p = plan(); p.nodes[0]!.review = { count: 1, min_rank: 1 };
  const r = rig(p); r.dispatch(); r.submit(); r.pass(); r.review('block', 2);
  r.review('ok', 1); assert.equal(r.state().nodes.a!.accepted, false);
  r.submit(facts('2')); r.pass(facts('2'));
  const old: Draft = { kind: 'review', by: 'reviewer:r', node: 'a', attempt: 1, obligation: 'review', key: 'review1', verdict: 'ok', rank: 2 };
  assert.match(validateDraft(r.state(), old).join(), /当前候选/);
  assert.match(validateDraft(r.state(), { kind: 'waive', by: 'owner:h', node: 'a', obligation: 'review', key: 'review1', reason: 'x', accept_risk: [4] }).join(), /当前候选/);
  r.review('ok', 2, 'review2'); assert.equal(r.state().nodes.a!.accepted, true);
});

test('review count/min_rank/recusal across attempts and closure review rank 2 or waiver', () => {
  const p = plan(); p.nodes[0]!.review = { count: 2, min_rank: 2 };
  const r = rig(p); r.dispatch(); r.submit(facts('1', { closureTouched: true })); r.pass();
  const recuse: Draft = { kind: 'review', by: 'reviewer:a#1', node: 'a', attempt: 1, obligation: 'review', key: 'review1', verdict: 'ok', rank: 2 };
  assert.match(validateDraft(r.state(), recuse).join(), /writer/);
  assert.match(validateDraft(r.state(), { ...recuse, by: 'owner:h', rank: 2 }).join(), /rank/);
  r.review('ok', 1); r.review('ok', 2); r.review('ok', 2);
  assert.equal(r.state().nodes.a!.items.find(i => i.obligation === 'review')?.status, 'D');
  r.review('ok', 2, 'review1', 'reviewer:r2');
  r.review('ok', 1, 'closure1', 'reviewer:r', 'closure-review'); assert.equal(r.state().nodes.a!.accepted, false);
  r.waive('closure-review', 'closure1'); assert.equal(r.state().nodes.a!.accepted, true);
  const other = rig(p); other.dispatch(); other.submit(facts('1', { closureTouched: true }));
  other.review('ok', 2, 'closure1', 'reviewer:r', 'closure-review');
  assert.equal(other.state().nodes.a!.items.find(i => i.obligation === 'closure-review')?.status, 'E');
  r.add({ kind: 'abandon', by: 'parent:main', node: 'a', attempt: 1, reason: 'retry' }); r.dispatch(2); r.submit(facts(), 2);
  assert.match(validateDraft(r.state(), { ...recuse, attempt: 2 }).join(), /writer/);
});

test('rulings need dispatch coverage or a later current-key review acknowledgment', () => {
  const p = plan(); p.nodes[0]!.review = { count: 1, min_rank: 1 };
  const r = rig(p); r.dispatch(); r.submit(); r.pass();
  r.add({ kind: 'rule', by: 'parent:main', text: 'only b', nodes: ['b'] });
  r.review('ok'); assert.equal(r.state().nodes.a!.accepted, true);
  const rule = r.add({ kind: 'rule', by: 'parent:main', text: 'new rule', nodes: '*' });
  assert.equal(r.state().nodes.a!.accepted, false);
  r.review('ok', 1, 'review1', 'reviewer:r', 'review', rule); assert.equal(r.state().nodes.a!.accepted, true);
  const future: Draft = { kind: 'review', by: 'reviewer:r', node: 'a', attempt: 1, obligation: 'review', key: 'review1', verdict: 'ok', rank: 1, ack_rulings: 999 };
  assert.match(validateDraft(r.state(), future).join(), /未来裁决/);
});

test('rulings can be acknowledged by an optional review when review.count is zero', () => {
  const r = accepted();
  const rule = r.add({ kind: 'rule', by: 'owner:h', nodes: ['a'], text: 'new obligation interpretation' });
  assert.equal(r.state().nodes.a!.accepted, false);
  r.review('ok', 1, 'review1', 'reviewer:r', 'review', rule);
  assert.equal(r.state().nodes.a!.accepted, true);
});

test('all active blocks must be explicitly waived; same-key deterministic failure stays writer debt', () => {
  const r = rig(); r.dispatch(); r.submit();
  const first = r.obs('check:unit', 'check1', 'fail');
  r.obs('check:unit', 'check1', 'fail', { attribution: true });
  assert.equal(r.state().nodes.a!.items[0]?.status, 'D');
  assert.equal(r.state().nodes.a!.items[0]?.discharger, 'writer');
  assert.equal(r.state().nodes.a!.blocks[0]?.state, 'cleared');
  const second = r.obs('check:unit', 'check1', 'fail');
  const third = r.obs('check:unit', 'check1', 'fail');
  r.obs('check:unit', 'check1', 'pass', { attribution: true });
  r.waive('check:unit', 'check1', [second]);
  assert.equal(r.state().nodes.a!.items[0]?.status, 'D');
  r.waive('check:unit', 'check1', [third]);
  const s = r.state();
  assert.equal(s.nodes.a!.items[0]?.status, 'W'); assert.equal(s.nodes.a!.items[0]?.mark, '⚠');
  assert.equal(s.nodes.a!.blocks.find(b => b.seq === first)?.state, 'cleared');
});

test('one deferred invariant never excuses another changed invariant', () => {
  const p = plan(); p.invariants.push({ id: 'second', run: 'second', timeout_s: 10, reads: ['**'] });
  const r = rig(p);
  const g = r.entries[0]!; if (g.kind === 'genesis') g.state.invKeys.second = 'second0';
  r.dispatch(); r.submit(); r.pass(); r.genesis();
  r.obs('inv:second', 'second0', 'pass', { subject: 'trunk', commit: 's0' });
  r.obs('writes', 'writesM', 'pass', { commit: 'cm' });
  const m = mergeFacts('invM'); m.state.invKeys.second = 'secondM';
  r.add({ kind: 'defer', by: 'owner:h', node: 'a', reason: 'safe deferred', items: [{ id: 'safe', key: 'invM' }] });
  const g2 = mergeGuard(r.state(), 'a', m); assert.equal(g2.ok, false); assert.match(g2.reasons.join(), /second/);
  r.obs('inv:second', 'secondM', 'pass', { subject: 'trunk', commit: 'cm' });
  assert.equal(mergeGuard(r.state(), 'a', m).ok, true);
});

test('genesis jobs retry error, stop on fail, and gate merge', () => {
  const r = rig(); r.dispatch(); r.submit(); r.pass(); r.obs('writes', 'writesM', 'pass', { commit: 'cm' });
  assert.equal(genesisJobs(r.state()).length, 1);
  assert.match(mergeGuard(r.state(), 'a', mergeFacts()).reasons.join(), /genesis/);
  r.genesis('error'); assert.equal(genesisJobs(r.state()).length, 1); assert.equal(r.state().genesisDone, false);
  r.genesis('fail'); assert.equal(genesisJobs(r.state()).length, 0); assert.equal(r.state().genesisDone, true);
  assert.equal(mergeGuard(r.state(), 'a', mergeFacts()).ok, true);
});

test('merge jobs reuse equal checks, recheck writes; guard requires observations on changed merge keys', () => {
  const r = accepted(); const m = mergeFacts('invM', 'checkM');
  assert.deepEqual(mergeJobs(r.state(), 'a', m).map(j => [j.kind, j.key]), [['check', 'checkM'], ['inv', 'invM']]);
  assert.deepEqual(mergeJobs(r.state(), 'a', mergeFacts()).map(j => j.key), []);
  assert.equal(mergeGuard(r.state(), 'a', mergeFacts()).nodeItems.find(i => i.obligation === 'writes')?.status, 'E');
  const refused = mergeGuard(r.state(), 'a', m); assert.equal(refused.ok, false);
  assert.match(refused.reasons.join(), /check:unit/); assert.match(refused.reasons.join(), /safe/);
  r.obs('check:unit', 'checkM', 'pass', { commit: 'cm' }); r.obs('writes', 'writesM', 'pass', { commit: 'cm' }); r.obs('inv:safe', 'invM', 'pass', { subject: 'trunk', commit: 'cm', base: 'cm' });
  assert.equal(mergeGuard(r.state(), 'a', m).ok, true);
  assert.equal(mergeJobs(r.state(), 'a', m).length, 0);
  const outside = structuredClone(m); outside.facts.changed = ['outside/file'];
  assert.match(mergeGuard(r.state(), 'a', outside).reasons.join(), /writes/);
  assert.equal(mergeGuard(r.state(), 'a', { ...m, facts: { ...m.facts, base: 'stale' } }).ok, false);
});

test('no-new-debt is per invariant: unchanged failure inherited, changed failure requires node-scoped owner defer and stays D', () => {
  const r = rig(); r.dispatch(); r.submit(); r.pass(); r.genesis('fail'); r.obs('writes', 'writesM', 'pass', { commit: 'cm' });
  assert.equal(mergeGuard(r.state(), 'a', mergeFacts()).ok, true);
  const m = mergeFacts('invM');
  r.obs('inv:safe', 'invM', 'fail', { subject: 'trunk', commit: 'cm', base: 'cm' });
  assert.equal(mergeGuard(r.state(), 'a', m).ok, false);
  const defer: Draft = { kind: 'defer', by: 'parent:main', node: 'a', items: [{ id: 'safe', key: 'invM' }], reason: 'later' };
  assert.match(validateDraft(r.state(), defer).join(), /owner/);
  r.add({ ...defer, by: 'owner:human', items: [{ id: 'safe', key: 'other' }] }); assert.equal(mergeGuard(r.state(), 'a', m).ok, false);
  r.add({ ...defer, by: 'owner:human' });
  let guard = mergeGuard(r.state(), 'a', m); assert.equal(guard.ok, true); assert.equal(guard.invItems[0]?.status, 'D'); assert.equal(guard.invItems[0]?.mark, '⏸');
  const cloned = r.state(); cloned.deferred[1]!.node = 'b'; guard = mergeGuard(cloned, 'a', m); assert.equal(guard.ok, false);
  r.add({ kind: 'merge', by: 'executor:owed', node: 'a', attempt: 1, prior: 's0', commit: 'cm', ...m });
  const s = r.state(); assert.equal(s.invariants[0]?.status, 'D'); assert.equal(s.invariants[0]?.mark, '⏸'); assert.equal(s.deferred.length, 2);
});

test('plan CAS and downgrade authority use actual plan, not a dishonest empty downgrade list', () => {
  const r = rig(); const weaker = plan(); weaker.nodes[0]!.checks = []; r.plans.weak = weaker;
  const d: Draft = { kind: 'plan', by: 'parent:main', prior: 'p', plan: 'weak', downgrades: [] };
  assert.match(validateDraft(r.state(), d).join(), /owner/);
  assert.match(validateDraft(r.state(), { ...d, prior: 'stale' }).join(), /当前 plan sha/);
  assert.deepEqual(validateDraft(r.state(), { ...d, by: 'owner:human' }), []);
  r.add({ ...d, by: 'owner:human', downgrades: [{ node: 'a', what: 'unit removed' }] });
  assert.equal(r.state().downgrades.length, 1);
});

test('authority and failure paths: genesis first, executor exact identity, open slots and malformed attribution', () => {
  const empty = reduce([], () => plan());
  assert.match(validateDraft(empty, { kind: 'note', by: 'parent:p', text: 'x' }).join(), /genesis/);
  assert.match(validateDraft(empty, { kind: 'genesis', by: 'parent:p', trunk: 'main', commit: 's0', plan: 'p', state: sf() }).join(), /owner/);
  const r = rig(); r.dispatch(); r.submit();
  const o: Draft = { kind: 'obs', by: 'executor:fake', subject: 'a', obligation: 'check:unit', key: 'check1', verdict: 'pass', exit: 0, durationMs: 0, commit: 'c1', base: 's0' };
  assert.match(validateDraft(r.state(), o).join(), /executor:owed/);
  assert.match(validateDraft(r.state(), { ...o, by: 'executor:owed', attribution: true }).join(), /归因/);
  assert.match(validateDraft(r.state(), { kind: 'abandon', by: 'parent:p', node: 'a', attempt: 2, reason: 'x' }).join(), /attempt/);
  r.add(o); assert.throws(() => r.state(), /executor:owed/);
});

test('pure replay and queries leave caller entries/plans unchanged and deterministic', () => {
  const r = accepted(); const before = JSON.stringify({ entries: r.entries, plans: r.plans });
  const a = r.state(), b = r.state(); assert.deepEqual(a, b);
  attestJobs(a, 'a'); genesisJobs(a); mergeJobs(a, 'a', mergeFacts()); mergeGuard(a, 'a', mergeFacts());
  assert.deepEqual(a, b); assert.equal(JSON.stringify({ entries: r.entries, plans: r.plans }), before);
  a.plan.nodes[0]!.writes.push('bad/'); assert.equal(r.plans.p!.nodes[0]!.writes.length, 1);
});
test('review F6: a check id containing a colon runs that check, not its prefix', () => {
  const p = plan(); p.nodes[0]!.checks = [{ id: 'unit', run: 'true', timeout_s: 10, reads: ['**'] }, { id: 'unit:security', run: 'exit 7', timeout_s: 10, reads: ['**'] }];
  const r = rig(p); r.dispatch(); r.submit(facts('1', { keys: { 'check:unit': 'k1', 'check:unit:security': 'k2', writes: 'w', rulings: 'r', review: 'rv' } }));
  const job = attestJobs(r.state(), 'a').find(j => j.obligation === 'check:unit:security');
  assert.equal(job?.spec?.run, 'exit 7');
});
test('review F4: same-rank different reviewer cannot clear a judgment block; author or higher rank can', () => {
  const p = plan(); p.nodes[0]!.review = { count: 1, min_rank: 1 };
  const r = rig(p); r.dispatch(); r.submit(); r.pass(); r.genesis(); r.review('block', 2, 'review1', 'reviewer:A');
  r.submit(facts('2')); r.pass(facts('2'));
  r.review('ok', 2, 'review2', 'reviewer:B'); assert.equal(r.state().nodes.a!.accepted, false);
  r.review('ok', 2, 'review2', 'reviewer:A'); assert.equal(r.state().nodes.a!.accepted, true);
});
test('review F3: a plan change to the node invalidates the candidate facts', () => {
  const r = accepted(); assert.equal(r.state().nodes.a!.accepted, true);
  const p2 = plan(); p2.nodes[0]!.checks[0]!.min_tests = 2; r.plans.p2 = p2;
  r.add({ kind: 'plan', by: 'parent:main', prior: 'p', plan: 'p2', downgrades: [] });
  const n = r.state().nodes.a!; assert.equal(n.accepted, false); assert.equal(n.candidate, undefined); assert.equal(n.phase, 'dispatched');
});
test('review F5: an invariant removed by the owner before its genesis observation does not block merges', () => {
  const r = rig(); r.dispatch(); r.submit(); r.pass();
  const p2 = plan(); p2.invariants = []; r.plans.p2 = p2;
  r.add({ kind: 'plan', by: 'owner:human', channel: 'tty', prior: 'p', plan: 'p2', downgrades: [] });
  assert.equal(r.state().genesisDone, true);
});
