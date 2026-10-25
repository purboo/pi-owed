import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { parse } from 'yaml';
import { canonical, sha256 } from '../src/canon.ts';
import { decide, needText, planInvalidated, reviewerLaunch, writerLaunch, type Action, type DriveOpts } from '../src/drive.ts';
import { Driver, DRIVE_PRINCIPAL, stateOf } from '../src/drive-run.ts';
import { Dsa, type SendResult, type SendKind } from '../src/dsa.ts';
import { candidateFacts, stateFacts } from '../src/git.ts';
import { verifyChain } from '../src/ledger.ts';
import { needs } from '../src/needs.ts';
import { parsePlan, planDowngrades } from '../src/plan.ts';
import { reduce, reduceFrom, sameReplay, runId, invalidates, specChanges, entriesOf, projectId } from '../src/reducer.ts';
import { receipt, renderReceipt } from '../src/views.ts';
import * as ops from '../src/ops.ts';
import type { CandidateFacts, Draft, Entry, Plan, RunView, State } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { commitAt } from './helpers/surface.ts';

const P = 'hash0', W = runId(P, 'a', 1, 'writer'), R = runId(P, 'a', 1, 'reviewer', 1);
const owner = { role: 'owner', id: 'human' } as const, parent = { role: 'parent', id: 'main' } as const;
const raw = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: [
  { id: 'a', writes: ['a.txt'], checks: [], review: { count: 1, min_rank: 1 } },
] };
function rig(plan = parsePlan(JSON.stringify(raw))) {
  const entries: Entry[] = [], plans = new Map([['p', plan]]), blobs = new Map<string, string>();
  const state = (): State => reduce(entries, sha => plans.get(sha)!);
  const add = (draft: Draft) => {
    const seq = entries.length, e = { ...draft, seq, ts: new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString(), prev: 'x', hash: `hash${seq}` } as Entry;
    entries.push(e); state(); return e;
  };
  const blob = (text: string) => { const hash = sha256(text); blobs.set(hash, text); return hash; };
  add({ kind: 'genesis', by: 'owner:human', channel: 'tty', plan: 'p', trunk: 'main', commit: 's0', state: { commit: 's0', tree: 't0', invKeys: {} } });
  add({ kind: 'dispatch', by: 'parent:drive', node: 'a', attempt: 1, base: 's0', branch: 'owed/a/1', worktree: '/repo/.owed/wt/a-1', packet: 'blob', rulings_seen: -1 });
  const writer = writerLaunch(state(), 'a', P);
  add({ kind: 'launch', by: 'parent:drive', node: 'a', attempt: 1, role: 'writer', rid: W, spec: blob(writer.spec), labels: writer.labels });
  const facts: CandidateFacts = { commit: 'candidate-1', tree: 't1', base: 's0', patch: 'p1', changed: ['a.txt'], closureTouched: false, keys: { writes: 'writes', review: 'review', rulings: 'rulings' } };
  add({ kind: 'submit', by: 'writer:a#1', node: 'a', attempt: 1, facts });
  add({ kind: 'obs', by: 'executor:owed', subject: 'a', obligation: 'writes', key: 'writes', verdict: 'pass', exit: 0, durationMs: 1, commit: facts.commit, base: facts.base });
  const launch = (agent?: string) => {
    const l = reviewerLaunch(state(), 'a', 1, P, '/repo');
    const spec = agent === undefined ? l.spec : canonical({ ...JSON.parse(l.spec), agent });
    return add({ kind: 'launch', by: 'parent:drive', node: 'a', attempt: 1, role: 'reviewer', rid: R, spec: blob(spec), labels: l.labels });
  };
  const send = (a?: Extract<Action, { do: 'send' }>) => add({ kind: 'send', by: 'parent:drive', node: 'a', attempt: 1, rid: R, send: `${R}:follow-up:${entries.length}`, sendKind: 'follow-up', reason: a?.reason ?? 'verdict', message: blob(a?.message ?? 'record verdict') });
  const halt = (a: Extract<Action, { do: 'halt' }>) => add({ kind: 'halt', by: 'parent:drive', node: 'a', attempt: 1, reason: a.reason, needs: a.needs });
  const resume = () => add({ kind: 'resume', by: 'parent:main', node: 'a', attempt: 1 });
  const changePlan = (next: Plan) => { const prior = state().planSha, sha = blob(canonical(next)); plans.set(sha, next); add({ kind: 'plan', by: 'parent:main', prior, plan: sha, downgrades: [] }); };
  const go = (view: Partial<RunView> = {}, opts: Partial<DriveOpts> = {}) => {
    const s = state();
    return decide(s, s.plan, new Map<string, RunView>([[W, { rid: W, state: 'sealed', status: 'ok' }], [R, { rid: R, state: 'sealed', status: 'ok', ...view }]]), {
      project: P, root: '/repo', max: 1, repairs: 2, applied: new Set(entries.flatMap(e => e.kind === 'send' ? [e.send] : [])), rejected: new Map(), blobs, ...opts,
    })[0];
  };
  return { entries, blobs, state, add, launch, send, halt, resume, changePlan, go };
}
function expectHalt(a: Action | undefined): Extract<Action, { do: 'halt' }> {
  assert.ok(a?.do === 'halt', JSON.stringify(a)); return a;
}
const commands = (builtin: boolean, retryable = true) => [...(retryable ? ['owed resume a'] : []), ...(builtin ? ['owed edit --drive --set reviewer.agent=owed-reviewer --note "<why>"'] : []), 'owed review a --ok|--block --rank <1-3> --note "<note>" --as owner:<id>', 'owed abandon a'];
function remedies(text: string, builtin: boolean, retryable = true) {
  let previous = -1;
  for (const command of commands(builtin, retryable)) { const at = text.indexOf(command); assert.ok(at > previous, `${command} in order: ${text}`); previous = at; }
  if (!retryable) assert.doesNotMatch(text, /owed resume|resume asks/);
  if (builtin) assert.match(text, /read-only.*later candidate/s);
  else assert.doesNotMatch(text, /reviewer.agent=owed-reviewer|builtin reviewer/);
}

test('RA1: package discovers and publishes the exact owed-reviewer profile', async () => {
  const text = await readFile(new URL('../agents/owed-reviewer.md', import.meta.url), 'utf8');
  assert.equal(sha256(text), '0a048ba015bd3d0d80cda42d3b560bb1fdc67f48da6c3de295fa2ce484c794d8', 'contract Appendix A exact bytes');
  const front = parse(text.split('---\n')[1]!);
  assert.equal(front.name, 'owed-reviewer');
  assert.equal(front.systemPromptMode, 'replace');
  assert.equal(front.inheritSkills, false);
  assert.match(text, /Recording your verdict is part of the review and is required: run the/);
  assert.match(text, /the one mutation\nyou are expected to make/);
  assert.match(text, /Do not edit, commit, rebase, push or tag in the writer's worktree/);
});

test('RA2: default reviewer launch is owed-reviewer, explicit global/node agents are preserved', () => {
  for (const drive of [undefined, {}, { reviewer: { model: 'example/model' } }]) {
    const r = rig(parsePlan(JSON.stringify({ ...raw, ...(drive === undefined ? {} : { drive }) })));
    assert.equal(JSON.parse(reviewerLaunch(r.state(), 'a', 1, P, '/repo').spec).agent, 'owed-reviewer');
  }
  for (const plan of [
    { ...raw, drive: { reviewer: { agent: 'reviewer' } } },
    { ...raw, nodes: [{ ...raw.nodes[0], drive: { reviewer: { agent: 'custom-reviewer' } } }] },
  ]) {
    const r = rig(parsePlan(JSON.stringify(plan)));
    assert.equal(JSON.parse(reviewerLaunch(r.state(), 'a', 1, P, '/repo').spec).agent, 'drive' in plan ? 'reviewer' : 'custom-reviewer');
  }
});

for (const builtin of [true, false]) test(`RM1: ordered remedies reach halt, wake, needs and why (builtin=${builtin})`, () => {
  const r = rig(); r.launch(builtin ? 'reviewer' : 'custom-reviewer'); r.send();
  const h = expectHalt(r.go()); remedies(h.reason, builtin); r.halt(h);
  const ns = needs(r.state(), 'a');
  assert.equal(ns.length, 1); assert.equal(ns[0]!.command, 'owed resume a');
  assert.deepEqual(ns[0]!.alternatives, commands(builtin).slice(1));
  remedies(needText(ns[0]!), builtin);
  remedies(renderReceipt(receipt(r.state(), r.entries, 'a')), builtin);
});

test('RM1: recorded spec wins over launch-time plan and later plan edits; missing blob uses launch-time plan', () => {
  const old = parsePlan(JSON.stringify({ ...raw, drive: { reviewer: { agent: 'reviewer' } } }));
  const r = rig(old); r.launch('custom-reviewer'); r.send();
  r.changePlan(parsePlan(JSON.stringify({ ...raw, drive: { reviewer: { agent: 'new-reviewer' } } })));
  remedies(expectHalt(r.go()).reason, false);
  remedies(expectHalt(r.go({}, { blobs: new Map() })).reason, true);
  const legacy = rig(); legacy.launch('reviewer'); legacy.send();
  remedies(expectHalt(legacy.go()).reason, true);
});

for (const agent of [undefined, 'reviewer', 'owed-reviewer', 'my-reviewer']) {
  const builtin = agent !== 'my-reviewer';
  const plan = () => parsePlan(JSON.stringify({ ...raw, ...(agent ? { drive: { reviewer: { agent } } } : {}) }));
  test(`R-031-RA-4: legacy halt uses compatible launch-time fallback (agent=${agent ?? 'omitted'})`, () => {
    const r = rig(plan()); r.launch(); r.send();
    r.changePlan(parsePlan(JSON.stringify({ ...raw, drive: { reviewer: { agent: builtin ? 'other-reviewer' : 'reviewer' } } })));
    const reason = `review-missing: reviewer run ${R} sealed ok without recording review on candidate #3`;
    r.add({ kind: 'halt', by: 'parent:drive', node: 'a', attempt: 1, reason, needs: 'human' });
    const n = needs(r.state(), 'a')[0]!;
    assert.deepEqual([n.command, ...n.alternatives!], commands(builtin));
    remedies(needText(n), builtin);
    remedies(renderReceipt(receipt(r.state(), r.entries, 'a')), builtin);
    assert.equal(r.state().nodes.a!.halt!.reason, reason);
  });
  test(`R-031-RA-4: absent/unreadable spec uses compatible launch-time fallback (agent=${agent ?? 'omitted'})`, () => {
    for (const unavailable of ['missing', 'unparsable', 'no-agent', 'bad-hash']) {
      const r = rig(plan()), l = r.launch(); r.send();
      r.changePlan(parsePlan(JSON.stringify({ ...raw, drive: { reviewer: { agent: builtin ? 'other-reviewer' : 'reviewer' } } })));
      remedies(expectHalt(r.go()).reason, agent === 'reviewer', true);
      assert.ok(l.kind === 'launch');
      const bytes = unavailable === 'unparsable' ? '{' : '{}';
      if (unavailable === 'missing') r.blobs.delete(l.spec);
      else {
        if (unavailable !== 'bad-hash') l.spec = sha256(bytes);
        r.blobs.set(l.spec, bytes);
      }
      remedies(expectHalt(r.go()).reason, builtin);
    }
  });
}

test('R-031-RA-4: a recorded 0.31 halt keeps its spec-derived remedies', () => {
  const r = rig(); r.launch(); r.send();
  const h = expectHalt(r.go()); remedies(h.reason, false); r.halt(h);
  r.changePlan(parsePlan(JSON.stringify({ ...raw, drive: { reviewer: { agent: 'reviewer' } } })));
  remedies(needText(needs(r.state(), 'a')[0]!), false);
  remedies(renderReceipt(receipt(r.state(), r.entries, 'a')), false);
  assert.equal(r.state().nodes.a!.halt!.reason, h.reason);
});

test('RM2: resume re-asks the same run/principal once, then halts on a second seal; a review permits merge', () => {
  const r = rig(); r.launch(); r.send(); r.halt(expectHalt(r.go())); r.resume();
  const a = r.go(); assert.ok(a?.do === 'send' && a.reason === 'verdict' && a.sendKind === 'follow-up', JSON.stringify(a));
  assert.equal(a.rid, R); assert.match(a.message, /--as reviewer:drive-a-1-1/);
  r.send(a);
  assert.equal(r.go({ state: 'running' }), undefined, 'no duplicate while the new generation runs');
  const h = expectHalt(r.go()); remedies(h.reason, false); r.halt(h);
  assert.equal(r.go(), undefined, 'halt remains until parent action');
  r.resume(); const again = r.go(); assert.ok(again?.do === 'send' && again.reason === 'verdict'); r.send(again);
  r.add({ kind: 'review', by: 'reviewer:drive-a-1-1', node: 'a', attempt: 1, obligation: 'review', key: 'review', verdict: 'ok', rank: 1, note: 'recorded' });
  assert.equal(r.go()?.do, 'merge');
});

test('RM2: resume without this run\'s review-missing halt does not renew verdict allowance', () => {
  for (const reason of ['unrelated halt', `review-missing: reviewer run ${R}0 sealed ok without recording review`]) {
    const r = rig(); r.launch(); r.send();
    r.add({ kind: 'halt', by: 'parent:drive', node: 'a', attempt: 1, needs: 'human', reason }); r.resume();
    expectHalt(r.go());
  }
});

for (const view of [{ state: 'sealed', status: 'rejected', error: 'unknown agent' }, { state: 'pruned', status: 'ok' }, { state: 'pruned', status: 'unknown' }] as const)
  test(`RM2: ${view.state}/${view.status} never gets a follow-up even after resume`, () => {
    const r = rig(); r.launch('reviewer');
    const h = expectHalt(r.go(view)); remedies(h.reason, true, false);
    assert.equal(h.reason.split('; remedies: ')[0], `review-missing: reviewer run ${R} sealed ${view.status}${'error' in view ? `: ${view.error}` : ''} without recording review on candidate #3`);
    assert.doesNotMatch(h.reason, /this attempt's request is fixed/);
    r.halt(h);
    remedies(needText(needs(r.state(), 'a')[0]!), true, false);
    remedies(renderReceipt(receipt(r.state(), r.entries, 'a')), true, false);
    r.resume();
    remedies(expectHalt(r.go(view)).reason, true, false);
    assert.equal(r.entries.filter(e => e.kind === 'send').length, 0);
  });

test('RA2 ruling R-031-RA-1: reparsing an old omitted reviewer changes no keys, observations, blocks or candidate', async () => {
  const now = parsePlan(JSON.stringify({ ...raw, drive: { max: 2 } }));
  const old = structuredClone(now); old.drive!.reviewer.agent = 'reviewer';
  const r = rig(old);
  r.add({ kind: 'obs', by: 'executor:owed', subject: 'a', obligation: 'writes', key: 'writes', verdict: 'fail', exit: 1, durationMs: 1, commit: 'candidate-1', base: 's0' });
  const before = r.state(); r.changePlan(now); const after = r.state();
  assert.equal(invalidates(old, now, 'a'), false); assert.deepEqual(specChanges(old, now, 'a'), []);
  assert.equal(planInvalidated(after, 'a', before.nodes.a!.candidate!.seq), undefined);
  assert.deepEqual(planDowngrades(old, now), []);
  assert.deepEqual(after.nodes.a!.candidate, before.nodes.a!.candidate);
  assert.deepEqual(after.nodes.a!.items, before.nodes.a!.items);
  assert.deepEqual(after.nodes.a!.blocks, before.nodes.a!.blocks);
  assert.deepEqual(entriesOf(after).filter(e => e.kind === 'obs'), entriesOf(before).filter(e => e.kind === 'obs'));
  const f = await repo();
  try {
    const base = await commitAt(f.cwd, { 'a.txt': 'base\n' }), commit = await commitAt(f.cwd, { 'a.txt': 'candidate\n' });
    const keyed = parsePlan(JSON.stringify({ ...now,
      nodes: [{ ...raw.nodes[0], checks: [{ id: 'unit', run: 'true', reads: ['a.txt'], red: true, tests: ['a.txt'], mutants: ['test/*.patch'] }] }],
      closure: ['test/**'], invariants: [{ id: 'safe', run: 'true', reads: ['a.txt'] }] }));
    const prior = structuredClone(keyed); prior.drive!.reviewer.agent = 'reviewer';
    assert.deepEqual(await candidateFacts(f.cwd, keyed, keyed.nodes[0]!, base, commit, 1), await candidateFacts(f.cwd, prior, prior.nodes[0]!, base, commit, 1));
    assert.deepEqual(await stateFacts(f.cwd, keyed, commit), await stateFacts(f.cwd, prior, commit));
  } finally { await f.cleanup(); }
});

test('RA2: existing ledger bytes verify and full/incremental replay share the baseline snapshot', async () => {
  const fixture = JSON.parse(await readFile(new URL('./fixtures/real-020-ledger.json', import.meta.url), 'utf8')) as { entries: Entry[]; plans: Record<string, string> };
  assert.deepEqual(verifyChain(fixture.entries), { ok: true });
  for (const [sha, text] of Object.entries(fixture.plans)) assert.equal(sha256(text), sha);
  const lookup = (sha: string) => parsePlan(fixture.plans[sha]!);
  const full = reduce(fixture.entries, lookup);
  let incremental = reduce(fixture.entries.slice(0, 1), lookup);
  for (const e of fixture.entries.slice(1)) incremental = reduceFrom(incremental, [e], lookup);
  assert.equal(sameReplay(incremental, full), true);
  assert.equal(full.head, '7bc18704699de17ffaa4be88eb5606bc1e0b6cf3e71b5bc8ea9c044e4a8ff9a2');
  assert.equal(sha256(canonical(full)), '0d1f0bfda29cb0db686019dd83389f89adecb25c39a3962e7514be2f443fb59e', 'full state digest measured on ebf090b');
});

class ReviewerDsa extends Dsa {
  views = new Map<string, RunView>();
  gen = 1;
  calls: string[] = [];
  replies = new Map<string, SendResult>();
  constructor() { super({ bin: '/nonexistent/dsa' }); }
  override async inspect(rid: string) { return { view: this.views.get(rid)!, gen: rid.endsWith(':reviewer:1') ? this.gen : 1 }; }
  override async request(id: string): Promise<{ state: 'applied' | 'absent' }> { return { state: this.replies.has(id) ? 'applied' : 'absent' }; }
  override async send(id: string, _to: string, _kind: SendKind): Promise<SendResult> {
    this.calls.push(id);
    let reply = this.replies.get(id);
    if (!reply) { reply = { outcome: 'applied', generation: this.gen + 1, spec_digest: 'x' }; this.replies.set(id, reply); }
    return reply;
  }
}

test('RM runtime: load sealed reviewer spec; resume send survives stale seal and driver restart without another generation', { timeout: 120_000 }, async () => {
  const f = await repo(), dsa = new ReviewerDsa();
  try {
    await commitAt(f.cwd, { 'a.txt': 'base\n' });
    await ops.init({ cwd: f.cwd, as: owner, channel: 'flag', plan: JSON.stringify(raw) });
    await ops.dispatch({ cwd: f.cwd, as: parent, node: 'a' });
    let s = await stateOf(f.cwd);
    await commitAt(s.nodes.a!.slot!.worktree, { 'a.txt': 'candidate\n' });
    const w = writerLaunch(s, 'a', projectId(s));
    await ops.launch({ cwd: f.cwd, as: DRIVE_PRINCIPAL, ...w });
    await ops.submit({ cwd: f.cwd, as: { role: 'writer', id: 'a#1' }, node: 'a' });
    await ops.attest({ cwd: f.cwd, node: 'a' });
    s = await stateOf(f.cwd);
    const l = reviewerLaunch(s, 'a', 1, w.labels.owed!, f.cwd);
    // Stored spec intentionally disagrees with the plan: the runtime loader must supply the authoritative bytes.
    await ops.launch({ cwd: f.cwd, as: DRIVE_PRINCIPAL, ...l, spec: canonical({ ...JSON.parse(l.spec), agent: 'reviewer' }) });
    dsa.views.set(w.rid, { rid: w.rid, state: 'sealed', status: 'ok' });
    dsa.views.set(l.rid, { rid: l.rid, state: 'sealed', status: 'ok' });
    const driver = () => new Driver({ cwd: f.cwd, dsa, log: () => {}, handleSignals: false, session: null, max: 1 });
    const first = driver(); await first.pass(); dsa.gen = 2; await first.pass();
    s = await stateOf(f.cwd); assert.ok(s.nodes.a!.halt); remedies(s.nodes.a!.halt!.reason, true);
    await ops.resume({ cwd: f.cwd, as: parent, node: 'a' });
    await first.pass();
    const before = await ops.readState({ cwd: f.cwd }), sends = before.entries.filter(e => e.kind === 'send');
    assert.equal(sends.length, 2); assert.ok(sends.every(e => e.reason === 'verdict' && e.rid === l.rid));
    await first.pass(); assert.equal((await stateOf(f.cwd)).nodes.a!.halt, undefined, 'stale gen2 seal is fenced');
    const restarted = driver(); await restarted.pass(); await restarted.pass();
    assert.equal((await ops.readState({ cwd: f.cwd })).entries.filter(e => e.kind === 'send').length, 2);
    assert.equal((await stateOf(f.cwd)).nodes.a!.halt, undefined, 'restart recovers the existing send id');
    assert.equal(new Set(dsa.calls).size, 2);
    dsa.gen = 3; await restarted.pass();
    remedies((await stateOf(f.cwd)).nodes.a!.halt!.reason, true);
  } finally { await f.cleanup(); }
});
