// E4 (0.5.1): launch entries and repair sends record the rulings their message actually carried (`rulings`, 0 when
// none), so a ruling recorded between `decide` and the append is not counted as delivered; 0.5.0 entries without the
// field keep the position rule; the reducer refuses a field that names no in-scope ruling.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../src/canon.ts';
import * as driveMod from '../src/drive.ts';
import { decide, deliveredRulings, repairMessage, type Action, type DriveOpts } from '../src/drive.ts';
import { reduce, runId, validateDraft } from '../src/reducer.ts';
import { renderEntry } from '../src/views.ts';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { Dsa } from '../src/dsa.ts';
import { drive } from '../src/drive-run.ts';
import type { CandidateFacts, DriveConfig, Draft, Entry, LaunchEntry, NodeSpec, Plan, RunView, SendEntry, State } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { identity } from './helpers/surface.ts';

// ---------- synthetic ledger rig (no git), as in drive-rulings.test.ts ----------
const P = 'hash0';
const W = (node = 'a', attempt = 1) => runId(P, node, attempt, 'writer');
const R = (n: number, node = 'a', attempt = 1) => runId(P, node, attempt, 'reviewer', n);
const T0 = Date.UTC(2026, 0, 1);
const iso = (seq: number) => new Date(T0 + seq * 1000).toISOString();
const spec = (o: Partial<NodeSpec> & { id: string }): NodeSpec => ({ deps: [], writes: [`${o.id}/`], checks: [], review: { count: 0, min_rank: 1 }, ...o });
const DRIVE: DriveConfig = { max: 4, repairs: 3, writer: { agent: 'worker' }, reviewer: { agent: 'reviewer' } };
const basePlan = (): Plan => ({ version: 1, trunk: 'main', closure: ['closure/'], invariants: [], drive: DRIVE, nodes: [
  spec({ id: 'a', checks: [{ id: 'unit', run: 'npm test', timeout_s: 60, reads: ['a/**'] }], review: { count: 2, min_rank: 1 } }),
  spec({ id: 'c' }),
] });

function rig() {
  const entries: Entry[] = [], plans: Record<string, Plan> = { p: basePlan() }, blobs = new Map<string, string>();
  const state = (): State => reduce(entries, sha => plans[sha]!);
  const add = (d: Draft): Entry => { const seq = entries.length, e = { ...d, seq, ts: iso(seq), prev: 'x', hash: `hash${seq}` } as Entry; entries.push(e); state(); return e; };
  const blob = (text: string): string => { const h = sha256(text); blobs.set(h, text); return h; };
  add({ kind: 'genesis', by: 'owner:human', channel: 'tty', plan: 'p', trunk: 'main', commit: 's0', state: { commit: 's0', tree: 't0', invKeys: {} } });
  const slot = (node: string) => state().nodes[node]!.slot!;
  const facts = (node: string, tag: string): CandidateFacts => ({ commit: `${node}c${tag}`, tree: `t${tag}`, base: slot(node).base, patch: `p${tag}`, changed: [`${node}/x`], closureTouched: false,
    keys: Object.fromEntries(['check:unit', 'writes', 'rulings', 'review', 'closure-review'].map(o => [o, `${node}-${o}-${tag}`])) });
  const r = {
    entries, blobs, state, add,
    dispatch(node = 'a') {
      const s = state(), attempt = (s.nodes[node]!.slot?.attempt ?? 0) + 1, rules = s.rules.filter(x => x.nodes === '*' || x.nodes.includes(node));
      return add({ kind: 'dispatch', by: 'parent:drive', node, attempt, base: s.trunk.commit, branch: `owed/${node}/${attempt}`, worktree: `/repo/.owed/wt/${node}-${attempt}`, packet: 'blob', rulings_seen: Math.max(-1, ...rules.map(x => x.seq)) });
    },
    /** Records a launch action as the executor does through ops.launch (with its `rulings`, when it has one). */
    launch(a: Action | undefined, o: { drop?: boolean } = {}): LaunchEntry {
      assert.ok(a?.do === 'launch', `a launch: ${JSON.stringify(a)}`);
      return add({ kind: 'launch', by: 'parent:drive', node: a.node, attempt: a.attempt, role: a.role, rid: a.rid, spec: blob(a.spec), labels: a.labels, ...(a.rulings !== undefined && !o.drop ? { rulings: a.rulings } : {}) }) as LaunchEntry;
    },
    /** Records a send action as the executor does through ops.send; `drop` writes it as 0.5.0 did (no `rulings` on a repair). */
    record(a: Action | undefined, o: { drop?: boolean } = {}): SendEntry {
      assert.ok(a?.do === 'send', `a send: ${JSON.stringify(a)}`);
      return add({ kind: 'send', by: 'parent:drive', node: a.node, attempt: a.attempt, rid: a.rid, send: `${a.rid}:${a.sendKind}:${entries.length}`, sendKind: a.sendKind, message: blob(a.message), reason: a.reason, ...(a.rulings !== undefined && !o.drop ? { rulings: a.rulings } : {}) }) as SendEntry;
    },
    submit(tag = '1', node = 'a') { return add({ kind: 'submit', by: `writer:${node}#${slot(node).attempt}`, node, attempt: slot(node).attempt, facts: facts(node, tag) }); },
    obs(obligation: string, verdict: 'pass' | 'fail', node = 'a') {
      const c = state().nodes[node]!.candidate!;
      return add({ kind: 'obs', by: 'executor:owed', subject: node, obligation, key: c.keys[obligation]!, verdict, exit: verdict === 'pass' ? 0 : 1, durationMs: 1, commit: c.commit, base: c.base });
    },
    pass(node = 'a') { for (const o of state().nodes[node]!.items.map(i => i.obligation).filter(o => o === 'writes' || o.startsWith('check:'))) r.obs(o, 'pass', node); },
    rule(text: string, nodes: string[] | '*' = ['a']) { return add({ kind: 'rule', by: 'parent:main', text, nodes }); },
  };
  return r;
}
type Rig = ReturnType<typeof rig>;
const view = (rid: string, state: RunView['state'], extra: Partial<RunView> = {}): [string, RunView] => [rid, { rid, state, ...extra }];
const runsOf = (...vs: [string, RunView][]) => new Map(vs);
const optsOf = (r: Rig, o: Partial<DriveOpts> = {}): DriveOpts => ({ max: 4, repairs: 3, project: P, root: '/repo', applied: new Set(), rejected: new Map(), blobs: r.blobs, ...o });
/** The single action of `node` in a pass (D4: at most one per node per pass). */
function act(r: Rig, runs: Map<string, RunView>, o: Partial<DriveOpts> = {}, node = 'a'): Action | undefined {
  const s = r.state(), mine = decide(s, s.plan, runs, optsOf(r, o)).filter(x => x.node === node);
  assert.ok(mine.length <= 1, `at most one action per node: ${JSON.stringify(mine)}`);
  return mine[0];
}
const applied = (r: Rig) => new Set(r.entries.flatMap(e => e.kind === 'send' ? [e.send] : []));
const WRITER_TAIL = 'Apply these rulings; they override your packet. If you already submitted, fix and submit again.';
const sealedOk = () => view(W(), 'sealed', { status: 'ok' });
/** Dispatched, writer launched (from its action), candidate 1 failing check:unit: the next pass on a sealed writer is a repair. */
function failing(): Rig {
  const r = rig(); r.dispatch(); r.launch(act(r, runsOf())); r.submit();
  r.obs('check:unit', 'fail'); r.obs('writes', 'pass');
  return r;
}

// ---------- E4.3: the race ----------
test('E4.3: a ruling recorded between decide and the append of a repair is steered afterwards (the repair did not carry it)', () => {
  const r = failing();
  const repair = act(r, runsOf(sealedOk()));
  assert.ok(repair?.do === 'send' && repair.reason === 'repair', JSON.stringify(repair));
  assert.equal(repair.rulings, 0, 'the repair carried no ruling: rulings 0, not absent');
  assert.ok(!repair.message.includes('Rulings since dispatch'));
  // The executor appends the repair after a ruling was recorded: the send's seq is above the ruling's.
  const x = r.rule('raced: use RFC 7807');
  const e = r.record(repair);
  assert.ok(e.seq > x.seq && e.rulings === 0);
  const s = r.state(), ar = s.nodes.a!.runs[0]!;
  assert.ok(deliveredRulings(s, 'a', ar, ar.launches[0]!) < x.seq, 'not delivered');
  const steer = act(r, runsOf(view(W(), 'running')), { applied: applied(r) });
  assert.deepEqual(steer, { do: 'send', node: 'a', attempt: 1, rid: W(), sendKind: 'steer', reason: 'ruling', rulings: x.seq,
    message: ['New parent rulings for a:', `#${x.seq} (a): raced: use RFC 7807`, WRITER_TAIL].join('\n') });
  r.record(steer);
  assert.equal(act(r, runsOf(view(W(), 'running')), { applied: applied(r) }), undefined, 'delivered once');
});

test('E4.1: a repair records the highest ruling it carried; a ruling raced in after it is steered alone', () => {
  const r = failing();
  const carriedRule = r.rule('carried by the repair', '*'); r.rule('only for c', ['c']);
  const repair = act(r, runsOf(sealedOk()));
  assert.ok(repair?.do === 'send' && repair.reason === 'repair');
  assert.equal(repair.rulings, carriedRule.seq, 'the in-scope ruling the message lists; the out-of-scope one is not counted');
  assert.ok(repair.message.includes(`- #${carriedRule.seq} carried by the repair`));
  // Imported through the namespace so that a tree without it fails this assertion, not the whole file's import.
  const follow = (driveMod as { repairFollowUp?: (s: State, node: string) => { message: string; rulings: number } }).repairFollowUp;
  assert.deepEqual(follow?.(r.state(), 'a'), { message: repair.message, rulings: carriedRule.seq });
  assert.equal(repairMessage(r.state(), 'a'), repair.message, 'repairMessage is unchanged');
  const raced = r.rule('raced');
  r.record(repair);
  const steer = act(r, runsOf(view(W(), 'running')), { applied: applied(r) });
  assert.ok(steer?.do === 'send' && steer.reason === 'ruling' && steer.rulings === raced.seq, JSON.stringify(steer));
  assert.equal(steer.message, ['New parent rulings for a:', `#${raced.seq} (a): raced`, WRITER_TAIL].join('\n'), 'only the ruling the repair did not carry');
});

test('E4.1: a reviewer launch records the rulings of its packet; a ruling recorded before the launch entry is still steered to it', () => {
  const r = rig(); r.dispatch(); r.launch(act(r, runsOf())); r.submit(); r.pass();
  const early = r.rule('in the packet');
  const one = act(r, runsOf(sealedOk()));
  assert.ok(one?.do === 'launch' && one.role === 'reviewer' && one.n === 1, JSON.stringify(one));
  assert.equal(one.rulings, early.seq);
  const raced = r.rule('raced past the packet', '*');
  const l1 = r.launch(one);
  assert.equal(l1.rulings, early.seq);
  // Reviewer 2's packet is built after the race: it carries both.
  const two = act(r, runsOf(sealedOk(), view(R(1), 'running')));
  assert.ok(two?.do === 'launch' && two.n === 2 && two.rulings === raced.seq, JSON.stringify(two));
  r.launch(two);
  const runs = runsOf(sealedOk(), view(R(1), 'running'), view(R(2), 'running'));
  const steer = act(r, runs);
  assert.deepEqual(steer, { do: 'send', node: 'a', attempt: 1, rid: R(1), sendKind: 'steer', reason: 'ruling', rulings: raced.seq,
    message: ['New parent rulings for a:', `#${raced.seq} (*): raced past the packet`, `Judge the candidate against these rulings and record your review with --ack-rulings ${raced.seq}.`].join('\n') });
  r.record(steer);
  assert.equal(act(r, runs, { applied: applied(r) }), undefined, 'reviewer 2 had it in its packet');
});

test('E4.1: a writer launch records the rulings of its dispatch packet; a re-launch keeps the recorded value', () => {
  const r = rig();
  const before = r.rule('before dispatch'); r.rule('for c', ['c']); r.dispatch(); const after = r.rule('after dispatch');
  const a = act(r, runsOf());
  assert.ok(a?.do === 'launch' && a.role === 'writer');
  assert.equal(a.rulings, before.seq, 'the packet carries only rulings recorded before the dispatch');
  const l = r.launch(a);
  assert.equal(l.rulings, before.seq);
  const again = act(r, runsOf(view(W(), 'absent')));
  assert.deepEqual(again, { ...a, rulings: before.seq }, 'same rid, spec bytes and rulings');
  // Running: the post-dispatch ruling is steered (dispatch packet + launch carried only `before`).
  const steer = act(r, runsOf(view(W(), 'running')));
  assert.ok(steer?.do === 'send' && steer.rulings === after.seq);
  // No ruling at all: rulings 0.
  const q = rig(); q.dispatch();
  assert.equal((act(q, runsOf()) as { rulings?: number }).rulings, 0);
});

// ---------- 0.5.0 entries: the position rule ----------
test('E4.1: entries without the field (written by 0.5.0) keep the position rule', () => {
  // A 0.5.0 repair recorded after a ruling counts it delivered.
  const r = failing();
  const repair = act(r, runsOf(sealedOk()));
  const x = r.rule('recorded before the 0.5.0 repair entry');
  const e = r.record(repair, { drop: true });
  assert.ok(e.rulings === undefined && e.seq > x.seq);
  assert.equal(act(r, runsOf(view(W(), 'running')), { applied: applied(r) }), undefined, 'position rule: delivered');
  // A 0.5.0 reviewer launch carried the in-scope rulings recorded before it.
  const q = rig(); q.dispatch(); q.launch(act(q, runsOf()), { drop: true }); q.submit(); q.pass();
  const y = q.rule('before the 0.5.0 reviewer launch');
  q.launch(act(q, runsOf(sealedOk())), { drop: true }); q.launch(act(q, runsOf(sealedOk(), view(R(1), 'running'))), { drop: true });
  const runs = runsOf(sealedOk(), view(R(1), 'running'), view(R(2), 'running'));
  const s = q.state(), ar = s.nodes.a!.runs[0]!;
  assert.deepEqual(ar.launches.map(l => [l.rulings, deliveredRulings(s, 'a', ar, l)]), [[undefined, -1], [undefined, y.seq], [undefined, y.seq]]);
  assert.equal(act(q, runs), undefined);
  const z = q.rule('after');
  const steer = act(q, runs);
  assert.ok(steer?.do === 'send' && steer.rid === R(1) && steer.rulings === z.seq && !steer.message.includes(`#${y.seq} `), JSON.stringify(steer));
});

// ---------- E4.2: reducer validation ----------
test('E4.2: rulings on a launch or repair must be 0 or an in-scope ruling recorded before the entry; replay refuses otherwise', () => {
  const r = rig(); r.dispatch();
  const w = act(r, runsOf()); assert.ok(w?.do === 'launch');
  const x = r.rule('for a'), c = r.rule('for c', ['c']), all = r.rule('all', '*');
  const s = r.state(), seq = s.seq + 1;
  const launch = (rulings: unknown): Draft => ({ kind: 'launch', by: 'parent:drive', node: 'a', attempt: 1, role: 'writer', rid: w.rid, spec: sha256(w.spec), labels: w.labels, rulings }) as Draft;
  for (const ok of [0, x.seq, all.seq]) assert.deepEqual(validateDraft(s, launch(ok)), [], `launch rulings ${ok}`);
  for (const bad of [c.seq, 999, -1, 1.5, '0', seq]) assert.match(validateDraft(s, launch(bad)).join('; '), /launch rulings must be 0 or the seq of a ruling covering a recorded before this entry/, `launch rulings ${String(bad)}`);
  const l = r.launch(w);
  const s2 = r.state(), seq2 = s2.seq + 1;
  const send = (o: object): Draft => ({ kind: 'send', by: 'parent:drive', node: 'a', attempt: 1, rid: l.rid, send: `${l.rid}:follow-up:${seq2}`, sendKind: 'follow-up', message: sha256('m'), reason: 'repair', ...o }) as Draft;
  assert.deepEqual(validateDraft(s2, send({ rulings: 0 })), []);
  assert.deepEqual(validateDraft(s2, send({ rulings: all.seq })), []);
  assert.deepEqual(validateDraft(s2, send({})), [], 'absent: a 0.5.0 entry');
  assert.match(validateDraft(s2, send({ rulings: c.seq })).join('; '), /send reason repair rulings must be 0 or the seq of a ruling covering a/);
  assert.match(validateDraft(s2, send({ rulings: 1000 })).join('; '), /send reason repair rulings must be/);
  assert.match(validateDraft(s2, send({ reason: 'submit', rulings: 0 })).join('; '), /send rulings is only allowed with reason ruling or repair/);
  assert.match(validateDraft(s2, send({ reason: 'ruling' })).join('; '), /send reason ruling requires rulings/, 'ruling sends unchanged');
  // Replay: a recorded entry naming an out-of-scope ruling makes the ledger unreadable.
  const bad = { ...send({ rulings: c.seq }), seq: seq2, ts: iso(seq2), prev: 'x', hash: `hash${seq2}` } as Entry;
  assert.throws(() => reduce([...r.entries, bad], () => basePlan()), /Entry #\d+ invalid: send reason repair rulings must be 0 or the seq of a ruling covering a/);
  // The ledger line of a repair carrying none does not say `through #0`.
  const e = r.add(send({ rulings: 0 }));
  assert.equal(renderEntry(e).includes('through'), false, renderEntry(e));
});

// ---------- ops and the executor ----------
const FAKE = fileURLToPath(new URL('./fixtures/fake-dsa.mjs', import.meta.url));
const OWED = fileURLToPath(new URL('../bin/owed.js', import.meta.url));
const parent = { role: 'parent' as const, id: 'drive' };

test('E4 ops/executor: the driver records rulings on its launch entry; ops.send records a repair\'s rulings and refuses a bad one', { timeout: 120_000 }, async () => {
  const plan = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: [{ id: 'k', writes: ['k.txt'], checks: [], review: { count: 0, min_rank: 1 } }] };
  const r = await repo();
  try {
    const dir = join(r.root, 'dsa'), bin = join(r.root, 'bin');
    await mkdir(join(dir, 'agents'), { recursive: true }); await mkdir(bin);
    await writeFile(join(bin, 'owed'), `#!/bin/sh\nexec "${process.execPath}" "${OWED}" "$@"\n`); await chmod(join(bin, 'owed'), 0o755);
    const env = { FAKE_DSA_DIR: dir, PATH: `${bin}:${process.env.PATH}`, ...identity };
    await r.put('plan.json', JSON.stringify(plan)); await r.put('README', 'x\n'); await r.commit();
    await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'human' }, channel: 'flag', plan: JSON.stringify(plan) });
    await writeFile(join(dir, 'agents', 'k-writer.sh'), 'echo RUNNING\n');
    const rule = await ops.rule({ cwd: r.cwd, as: { role: 'parent', id: 'main' }, text: 'keep it small', nodes: ['k'] });
    const dsa = new Dsa({ bin: FAKE, env, timeoutMs: 120_000 });
    const once = () => drive({ cwd: r.cwd, once: true, dsa, log: () => {}, pollMs: 50, passMs: 300, handleSignals: false });
    await once(); await once();                         // dispatch, launch
    const entries = async (): Promise<Entry[]> => (await Ledger.open(r.cwd)).read();
    const l = (await entries()).find((e): e is LaunchEntry => e.kind === 'launch');
    assert.ok(l, 'writer launched');
    assert.equal(l.rulings, rule.seq, 'the executor records the rulings of the launch action');
    // ops.send: a repair records its rulings; a bad value is refused and leaves the ledger unchanged.
    const before = (await entries()).length;
    await assert.rejects(ops.send({ cwd: r.cwd, as: parent, node: 'k', attempt: 1, rid: l.rid, sendKind: 'follow-up', message: 'm', reason: 'repair', rulings: rule.seq + 1 }), /send reason repair rulings must be 0 or the seq of a ruling covering k/);
    await assert.rejects(ops.send({ cwd: r.cwd, as: parent, node: 'k', attempt: 1, rid: l.rid, sendKind: 'follow-up', message: 'm', reason: 'submit', rulings: 0 }), /only allowed with reason ruling or repair/);
    assert.equal((await entries()).length, before);
    const s = await ops.send({ cwd: r.cwd, as: parent, node: 'k', attempt: 1, rid: l.rid, sendKind: 'follow-up', message: 'm', reason: 'repair', rulings: 0 });
    assert.equal(s.rulings, 0);
    // A recorded launch keeps its own value on an idempotent retry.
    const again = await ops.launch({ cwd: r.cwd, as: parent, node: 'k', attempt: 1, role: 'writer', rid: l.rid, spec: (await (await Ledger.open(r.cwd)).getBlob(l.spec)).toString(), labels: l.labels, rulings: 0 });
    assert.deepEqual([again.created, again.entry.seq, again.entry.rulings], [false, l.seq, rule.seq]);
  } finally { await r.cleanup(); }
});
