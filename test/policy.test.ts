// 0.14 PR: future policy, informational driver notices, wildcard re-ack and report noise.
import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';
import { sha256 } from '../src/canon.ts';
import { decide, deliveredRulings, repairEpoch, reviewerLaunch, rulingFollowUp, writerLaunch } from '../src/drive.ts';
import { Driver } from '../src/drive-run.ts';
import { Dsa } from '../src/dsa.ts';
import { Ledger } from '../src/ledger.ts';
import * as ops from '../src/ops.ts';
import { halted, parentRuling, reduce, runId, runLabels, validateDraft } from '../src/reducer.ts';
import { renderReport, reviewPacket } from '../src/views.ts';
import type { CandidateFacts, Draft, Entry, Plan, Rule, RunView, SendEntry } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';
delete process.env.OWED_CONFIRM;

const parent = { role: 'parent', id: 'test' } as const;
const owner = { role: 'owner', id: 'test' } as const;
const plan: Plan = { version: 1, trunk: 'main', closure: [], invariants: [], lease: false, nodes: ['a', 'b'].map(id => ({ id, deps: [], writes: [`${id}.txt`], checks: [], review: { count: 1, min_rank: 1 } })) };
const W = runId('hash0', 'a', 1, 'writer'), R = runId('hash0', 'a', 1, 'reviewer', 1);
function rig(reviewers = true) {
  const entries: Entry[] = [], blobs = new Map<string, string>();
  const state = () => reduce(entries, () => plan);
  const add = (d: Draft) => {
    assert.deepEqual(validateDraft(state(), d), [], JSON.stringify(d));
    const seq = entries.length, e = { ...d, seq, ts: new Date(1767225600000 + seq * 1000).toISOString(), prev: 'x', hash: `hash${seq}` } as Entry;
    entries.push(e); return e;
  };
  const blob = (s: string) => { const h = sha256(s); blobs.set(h, s); return h; };
  const dispatch = (node = 'a') => add({ kind: 'dispatch', by: 'parent:test', node, attempt: 1, base: 's0', branch: `owed/${node}/1`, worktree: `/repo/${node}`, packet: blob('packet'), rulings_seen: Math.max(-1, ...state().rules.filter(r => r.nodes === '*' || r.nodes.includes(node)).map(r => r.seq)) });
  const facts: CandidateFacts = { commit: 'a'.repeat(40), tree: 't1', base: 's0', patch: 'p1', changed: ['a.txt'], closureTouched: false, keys: { writes: 'kw', review: 'kr', rulings: 'ku' } };
  const rule = (prospective = false, nodes: string[] | '*' = '*') => add({ kind: 'rule', by: 'parent:test', text: 'Use smaller evidence for future work', nodes, ...(prospective ? { prospective: true } : {}) } as Draft);
  const record = (a: ReturnType<typeof decide>[number]) => {
    assert.ok(a.do === 'send');
    return add({ kind: 'send', by: 'parent:drive', node: a.node, attempt: a.attempt, rid: a.rid, send: a.send ?? `${a.rid}:${a.sendKind}:${entries.length}`, sendKind: a.sendKind, message: blob(a.message), reason: a.reason, ...(a.rulings !== undefined ? { rulings: a.rulings } : {}) }) as SendEntry;
  };
  const review = (ack?: number, verdict: 'ok' | 'block' = 'ok') => add({ kind: 'review', by: 'reviewer:drive-a-1-1', node: 'a', attempt: 1, obligation: 'review', key: 'kr', verdict, rank: 1, ...(ack !== undefined ? { ack_rulings: ack } : {}) });
  const runs = (w: RunView['state'] = 'sealed', r: RunView['state'] = 'sealed') => new Map<string, RunView>([[W, { rid: W, state: w, status: 'ok' }], [R, { rid: R, state: r, status: 'ok' }]]);
  const act = (views = runs(), applied = new Set(entries.flatMap(e => e.kind === 'send' ? [e.send] : [])), rejected = new Map<string, string>()) => { const s = state(); return decide(s, s.plan, views, { max: 1, repairs: 2, project: 'hash0', root: '/repo', blobs, applied, rejected }).find(a => a.node === 'a'); };
  add({ kind: 'genesis', by: 'owner:test', channel: 'flag', plan: 'p', trunk: 'main', commit: 's0', state: { commit: 's0', tree: 't0', invKeys: {} } });
  dispatch();
  const launch = writerLaunch(state(), 'a', 'hash0');
  add({ kind: 'launch', by: 'parent:drive', node: 'a', attempt: 1, role: 'writer', rid: W, spec: blob(launch.spec), labels: launch.labels, rulings: launch.rulings });
  add({ kind: 'submit', by: 'writer:a#1', node: 'a', attempt: 1, facts });
  add({ kind: 'obs', by: 'executor:owed', subject: 'a', obligation: 'writes', key: 'kw', verdict: 'pass', exit: 0, durationMs: 1, commit: facts.commit, base: facts.base });
  if (reviewers) {
    const launch = reviewerLaunch(state(), 'a', 1, 'hash0', '/repo');
    add({ kind: 'launch', by: 'parent:drive', node: 'a', attempt: 1, role: 'reviewer', rid: R, spec: blob(launch.spec), labels: launch.labels, rulings: launch.rulings });
  }
  review();
  return { entries, blobs, state, add, dispatch, rule, record, review, runs, act };
}

test('PR1 prospective policy leaves old attempts accepted, excludes old review packets and binds later dispatches', () => {
  for (const nodes of ['*', ['a', 'b']] as const) {
    const r = rig(), before = r.state().nodes.a!.items, epoch = repairEpoch(r.state(), 'a');
    const rule = r.rule(true, nodes === '*' ? '*' : [...nodes]);
    const s = r.state();
    assert.equal((s.rules.at(-1) as Rule & { prospective?: boolean }).prospective, true);
    assert.deepEqual(s.nodes.a!.items, before);
    assert.equal(s.nodes.a!.accepted, true);
    assert.deepEqual(repairEpoch(s, 'a'), epoch);
    assert.equal(rulingFollowUp(s, 'a'), undefined);
    assert.doesNotMatch(reviewPacket(s, 'a'), /Use smaller evidence/);
    r.dispatch('b');
    const later = writerLaunch(r.state(), 'b', 'hash0');
    assert.equal(later.rulings, rule.seq);
    assert.match(JSON.parse(later.spec).task, /Use smaller evidence/);
    assert.equal(r.state().nodes.b!.slot!.rulings_seen, rule.seq);
    assert.equal(r.act()?.do, 'merge', 'sealed runs are never relaunched for prospective policy');
  }
});

test('PR2 notify each unsealed writer and reviewer exactly once, including an obsolete reviewer; notices never request ack', () => {
  const r = rig(); r.rule(true);
  // This resubmit makes R obsolete but its still-running generation must receive the policy.
  const facts = r.state().nodes.a!.candidate!;
  r.add({ kind: 'submit', by: 'writer:a#1', node: 'a', attempt: 1, facts });
  const views = r.runs('asking', 'running'), seen: string[] = [];
  for (let i = 0; i < 2; i++) {
    const a = r.act(views);
    assert.ok(a?.do === 'send' && a.sendKind === 'notify' && a.reason === 'ruling', JSON.stringify(a));
    assert.match(a.message, /Prospective policy/);
    assert.doesNotMatch(a.message, /--ack-rulings|owed submit|override your packet/);
    seen.push(a.rid); r.record(a);
  }
  assert.deepEqual(seen, [W, R]);
  assert.ok(r.act(views)?.do !== 'send');
});

test('PR2 notice retries use the original id; rejected or sealed targets never halt and policy does not hide ordinary rulings', () => {
  const r = rig(), ordinary = r.rule(false), policy = r.rule(true);
  const views = r.runs('running', 'sealed'), first = r.act(views);
  assert.ok(first?.do === 'send' && first.sendKind === 'notify');
  const notice = r.record(first), retry = r.act(views, new Set());
  assert.ok(retry?.do === 'send');
  assert.equal(retry.send, notice.send); assert.equal(retry.message, first.message);
  const s = r.state(), ar = s.nodes.a!.runs[0]!, l = ar.launches[0]!;
  assert.equal(deliveredRulings(s, 'a', ar, l), 0, 'informational notices never advance the binding cursor');
  const after = r.act(views, new Set(), new Map([[notice.send, 'sealed meanwhile']]));
  assert.ok(after?.do === 'send' && after.sendKind === 'steer');
  assert.equal(after.rulings, ordinary.seq);
  assert.notEqual(after.rulings, policy.seq);
  assert.ok(r.act(r.runs(), new Set())?.do !== 'halt', 'no halt from a pending notice when its target seals');
});

test('PR2 informational policy notices never suppress acknowledgment of a delivered reviewer answer', () => {
  const r = rig();
  const answer = r.add({ kind: 'rule', by: 'parent:test', nodes: ['a'], writer: false, text: 'Answer to reviewer question q: keep the behavior', answer: { rid: R, qid: 'q', rev: 1 } });
  r.rule(true);
  const views = r.runs('sealed', 'running'), notice = r.act(views);
  assert.ok(notice?.do === 'send' && notice.rid === R && notice.sendKind === 'notify');
  r.record(notice);
  const ack = r.act(views);
  assert.ok(ack?.do === 'send' && ack.sendKind === 'steer' && ack.rulings === answer.seq, JSON.stringify(ack));
  assert.match(ack.message, new RegExp(`--ack-rulings ${answer.seq}`));
});

test('PR2 prospective guidance does not clear a halt or resolve a needs-parent block; a halted unsealed run still gets a notify', () => {
  const r = rig();
  const blocked = r.add({ kind: 'review', by: 'reviewer:drive-a-1-1', node: 'a', attempt: 1, obligation: 'review', key: 'kr', verdict: 'block', rank: 1, needs: 'parent', note: 'Which requirement?' });
  const halt = r.add({ kind: 'halt', by: 'parent:drive', node: 'a', attempt: 1, needs: 'human', reason: 'needs a parent ruling' });
  r.rule(true, ['a']);
  assert.equal(halted(r.state(), 'a')?.seq, halt.seq);
  assert.equal(parentRuling(r.state(), r.state().nodes.a!.blocks.find(b => b.seq === blocked.seq)!), undefined);
  const a = r.act(r.runs('running'));
  assert.ok(a?.do === 'send' && a.sendKind === 'notify');
  r.record(a);
  assert.equal(r.act(r.runs('running')), undefined);
});

test('PR3 wildcard ruling follows up the latest reviewer with candidate and ack seq; ok clears debt and block routes to writer', () => {
  for (const verdict of ['ok', 'block'] as const) {
    const r = rig(), rule = r.rule(), a = r.act();
    assert.ok(a?.do === 'send' && a.rid === R && a.sendKind === 'follow-up' && a.reason === 'ruling', JSON.stringify(a));
    assert.equal(a.rulings, rule.seq);
    assert.match(a.message, new RegExp(`--ack-rulings ${rule.seq}`));
    assert.match(a.message, /aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/);
    assert.match(a.message, /block if the writer must change something/);
    r.record(a); r.review(rule.seq, verdict);
    assert.equal(r.act()?.do, verdict === 'ok' ? 'merge' : 'send');
    if (verdict === 'block') { const repair = r.act(); assert.ok(repair?.do === 'send' && repair.reason === 'repair' && repair.rid === W); }
  }
});

test('PR3 wildcard debt launches a reviewer when only an external review exists', () => {
  const r = rig(false), rule = r.rule(), a = r.act();
  assert.ok(a?.do === 'launch' && a.role === 'reviewer', JSON.stringify(a));
  assert.match(JSON.parse(a.spec).task, new RegExp(`--ack-rulings ${rule.seq}`));
});

async function fixture() {
  const r = await repo();
  await r.put('plan.json', JSON.stringify(plan)); await r.commit();
  await ops.init({ cwd: r.cwd, as: owner, channel: 'flag', plan: JSON.stringify(plan) });
  const slot = await ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' });
  await commitAt(slot.worktree, { 'a.txt': 'a\n' });
  await ops.submit({ cwd: slot.worktree, as: { role: 'writer', id: 'a#1' }, node: 'a' });
  return { ...r, slot };
}

test('PR1 CLI and pi tool record prospective; --writer combination is usage and records nothing', { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    const out = await cli(f.cwd, ['rule', 'future policy', '--nodes', '*', '--prospective', '--json']);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(JSON.parse(out.stdout).prospective, true);
    const ledger = await Ledger.open(f.cwd), count = (await ledger.read()).length;
    const invalid = await cli(f.cwd, ['rule', 'bad', '--nodes', 'a', '--prospective', '--writer']);
    assert.equal(invalid.code, 2); assert.match(invalid.stderr, /--prospective.*--writer/);
    await assert.rejects(ops.rule({ cwd: f.cwd, as: parent, text: 'bad', nodes: ['a'], prospective: true, writer: true } as Parameters<typeof ops.rule>[0]), { code: 'usage' });
    assert.equal((await ledger.read()).length, count);
    const tools = new Map<string, ToolDefinition>();
    owed({ registerTool(t: ToolDefinition) { tools.set(t.name, t); }, registerCommand() {} } as unknown as ExtensionAPI);
    const tool = tools.get('owed_rule')!;
    assert.ok('prospective' in (tool.parameters as { properties: object }).properties);
    const result = await tool.execute('policy', { cwd: f.cwd, as: 'parent:test', text: 'future named policy', nodes: ['a'], prospective: true }, undefined, undefined, { cwd: f.cwd, hasUI: false } as ExtensionContext as Parameters<ToolDefinition['execute']>[4]);
    assert.ok(!(result as { isError?: boolean }).isError, JSON.stringify(result));
    const last = (await ledger.read()).at(-1)!;
    assert.equal(last.kind, 'rule'); assert.equal((last as Entry & { prospective?: boolean }).prospective, true);
  } finally { await f.cleanup(); }
});

test('PR4 report status changes omit nodes merged at window end, including later wildcard ruling changes', { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    const reviewed = await ops.review({ cwd: f.cwd, as: { role: 'reviewer', id: 'external' }, node: 'a', rank: 1, verdict: 'ok', note: 'read diff' });
    await ops.attest({ cwd: f.cwd, node: 'a' });
    const merged = await ops.merge({ cwd: f.cwd, as: parent, node: 'a' });
    await ops.rule({ cwd: f.cwd, as: parent, nodes: '*', text: 'ordinary policy' });
    for (const since of [-1, reviewed.seq, merged.entry.seq]) {
      const report = await ops.report({ cwd: f.cwd, since });
      assert.deepEqual(report.changes.filter(c => c.subject === 'a'), []);
      assert.doesNotMatch(renderReport(report).split('Status changes:')[1]?.split('\n\n')[0] ?? '', /a\/rulings/);
    }
  } finally { await f.cleanup(); }
});

test('PR5 owner rank refusal says owner reviews use --rank 3; valid rank 3 records normally', { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    const ledger = await Ledger.open(f.cwd), before = (await ledger.read()).length;
    for (const rank of [1, 2]) {
      const out = await cli(f.cwd, ['review', 'a', '--ok', '--rank', String(rank), '--as', 'owner:test']);
      assert.equal(out.code, 1); assert.match(out.stderr, /owner reviews use --rank 3/);
    }
    assert.equal((await ledger.read()).length, before);
    const ok = await ops.review({ cwd: f.cwd, as: owner, node: 'a', rank: 3, verdict: 'ok', note: 'read diff', channel: 'flag' });
    assert.equal(ok.kind, 'review');
  } finally { await f.cleanup(); }
});

test('PR2 executor sends notices even on halted attempts; rejection or conflict never records a halt or follow-up', { timeout: 60_000 }, async () => {
  for (const outcome of ['rejected', 'conflict'] as const) {
    const f = await fixture();
    try {
      // The rid project uses the genesis hash, not the current ledger head.
      const ledger = await Ledger.open(f.cwd), genesis = (await ledger.read())[0]!;
      const rid = runId(genesis.hash.slice(0, 12), 'a', 1, 'writer');
      await ops.launch({ cwd: f.cwd, as: { role: 'parent', id: 'drive' }, node: 'a', attempt: 1, role: 'writer', rid, spec: '{}', labels: runLabels(genesis.hash.slice(0, 12), 'a', 1, 'writer'), rulings: 0 });
      await ops.halt({ cwd: f.cwd, as: { role: 'parent', id: 'drive' }, node: 'a', attempt: 1, reason: 'existing halt', needs: 'human' });
      await ops.rule({ cwd: f.cwd, as: parent, nodes: '*', text: 'future policy', prospective: true } as Parameters<typeof ops.rule>[0]);
      class NoticeDsa extends Dsa {
        calls: string[] = [];
        override async inspect(id: string) { this.calls.push(id); return { view: { rid: id, state: 'running' as const } }; }
        override async send(_id: string, _rid: string, kind: 'follow-up' | 'steer' | 'notify' | 'answer', _message: string) { assert.equal(kind, 'notify'); return { outcome, reason: 'sealed meanwhile' }; }
      }
      const dsa = new NoticeDsa(), driver = new Driver({ cwd: f.cwd, log() {}, dsa, session: null, max: 1 });
      const first = await driver.pass();
      assert.ok(dsa.calls.includes(rid));
      assert.ok(first.actions.some(a => a.do === 'send' && a.sendKind === 'notify'));
      await driver.pass();
      const entries = await ledger.read();
      assert.equal(entries.filter(e => e.kind === 'halt').length, 1);
      assert.deepEqual(entries.filter(e => e.kind === 'send').map(e => e.kind === 'send' && e.sendKind), ['notify']);
    } finally { await f.cleanup(); }
  }
});
