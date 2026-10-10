// D22: owed drive delivers new in-scope rulings to its running writer and reviewer calls (send reason `ruling`), the
// dsa run name of new launches (D22.5) and the answer address of asking runs (D22.6).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sha256 } from '../src/canon.ts';
import { askingText, decide, deliveredRulings, launchSpec, reviewerLaunch, rulingMessage, runName, writerLaunch, type Action, type DriveOpts } from '../src/drive.ts';
import { reduce, runId, runLabels, validateDraft } from '../src/reducer.ts';
import { renderEntry } from '../src/views.ts';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { Dsa } from '../src/dsa.ts';
import { drive } from '../src/drive-run.ts';
import type { CandidateFacts, DriveConfig, Draft, Entry, LaunchEntry, NodeSpec, Plan, RunView, SendEntry, SendKind, State } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { identity } from './helpers/surface.ts';

// ---------- synthetic ledger rig (no git), as in drive.test.ts ----------
const P = 'hash0';
const W = (node = 'a', attempt = 1) => runId(P, node, attempt, 'writer');
const R = (n: number, node = 'a', attempt = 1) => runId(P, node, attempt, 'reviewer', n);
const T0 = Date.UTC(2026, 0, 1);
const iso = (seq: number) => new Date(T0 + seq * 1000).toISOString();
const spec = (o: Partial<NodeSpec> & { id: string }): NodeSpec => ({ deps: [], writes: [`${o.id}/`], checks: [], review: { count: 0, min_rank: 1 }, ...o });
const DRIVE: DriveConfig = { max: 4, repairs: 2, writer: { agent: 'worker', model: 'example/x:high' }, reviewer: { agent: 'reviewer' } };
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
    launchWriter(node = 'a') { const a = writerLaunch(state(), node, P); return add({ kind: 'launch', by: 'parent:drive', node, attempt: a.attempt, role: 'writer', rid: a.rid, spec: blob(a.spec), labels: a.labels }) as LaunchEntry; },
    launchReviewer(n: number, node = 'a') { const a = reviewerLaunch(state(), node, n, P, '/repo'); return add({ kind: 'launch', by: 'parent:drive', node, attempt: a.attempt, role: 'reviewer', rid: a.rid, spec: blob(a.spec), labels: a.labels }) as LaunchEntry; },
    /** Records the send of an action (as the executor does through ops.send). */
    record(a: Action | undefined): SendEntry {
      assert.ok(a?.do === 'send', `a send: ${JSON.stringify(a)}`);
      return add({ kind: 'send', by: 'parent:drive', node: a.node, attempt: a.attempt, rid: a.rid, send: `${a.rid}:${a.sendKind}:${entries.length}`, sendKind: a.sendKind, message: blob(a.message), reason: a.reason, ...(a.rulings !== undefined ? { rulings: a.rulings } : {}) }) as SendEntry;
    },
    send(rid: string, reason: SendEntry['reason'], sendKind: SendKind = 'follow-up', node = 'a') {
      return add({ kind: 'send', by: 'parent:drive', node, attempt: slot(node).attempt, rid, send: `${rid}:${sendKind}:${entries.length}`, sendKind, message: blob(`msg ${entries.length}`), reason }) as SendEntry;
    },
    submit(tag = '1', node = 'a') { return add({ kind: 'submit', by: `writer:${node}#${slot(node).attempt}`, node, attempt: slot(node).attempt, facts: facts(node, tag) }); },
    obs(obligation: string, verdict: 'pass' | 'fail', node = 'a') {
      const c = state().nodes[node]!.candidate!;
      return add({ kind: 'obs', by: 'executor:owed', subject: node, obligation, key: c.keys[obligation]!, verdict, exit: verdict === 'pass' ? 0 : 1, durationMs: 1, commit: c.commit, base: c.base });
    },
    pass(node = 'a') { for (const o of state().nodes[node]!.items.map(i => i.obligation).filter(o => o === 'writes' || o.startsWith('check:'))) r.obs(o, 'pass', node); },
    rule(text: string, nodes: string[] | '*' = ['a']) { return add({ kind: 'rule', by: 'parent:main', text, nodes }); },
    halt(node = 'a') { return add({ kind: 'halt', by: 'parent:drive', node, attempt: slot(node).attempt, reason: 'stuck', needs: 'human' }); },
  };
  return r;
}
type Rig = ReturnType<typeof rig>;
const view = (rid: string, state: RunView['state'], extra: Partial<RunView> = {}): [string, RunView] => [rid, { rid, state, ...extra }];
const runsOf = (...vs: [string, RunView][]) => new Map(vs);
const optsOf = (r: Rig, o: Partial<DriveOpts> = {}): DriveOpts => ({ max: 4, repairs: 2, project: P, root: '/repo', applied: new Set(), rejected: new Map(), blobs: r.blobs, ...o });
/** The single action of `node` in a pass (D4: at most one per node per pass). */
function act(r: Rig, runs: Map<string, RunView>, o: Partial<DriveOpts> = {}, node = 'a'): Action | undefined {
  const s = r.state(), mine = decide(s, s.plan, runs, optsOf(r, o)).filter(x => x.node === node);
  assert.ok(mine.length <= 1, `at most one action per node: ${JSON.stringify(mine)}`);
  return mine[0];
}
const applied = (r: Rig) => new Set(r.entries.flatMap(e => e.kind === 'send' ? [e.send] : []));
const WRITER_TAIL = 'Apply these rulings; they override your packet. If you already submitted, fix and submit again.';

// ---------- D22.2: writer ----------
test('D22.2: a running writer gets every in-scope ruling after its dispatch as one steer (reason ruling, rulings = highest seq)', () => {
  const r = rig();
  r.rule('before dispatch'); r.dispatch(); r.launchWriter();
  const x = r.rule('use RFC 7807\nfor errors'), other = r.rule('only for c', ['c']), all = r.rule('all nodes', '*');
  const a = act(r, runsOf(view(W(), 'running')));
  assert.deepEqual(a, { do: 'send', node: 'a', attempt: 1, rid: W(), sendKind: 'steer', reason: 'ruling', rulings: all.seq,
    message: ['New parent rulings for a:', `#${x.seq} (a): use RFC 7807\\nfor errors`, `#${all.seq} (*): all nodes`, WRITER_TAIL].join('\n') });
  assert.ok(!a.message.includes('before dispatch') && !a.message.includes(`#${other.seq}`), 'neither dispatch-time nor out-of-scope rulings');
  // Recorded: delivered; nothing more until a newer ruling, which goes alone.
  r.record(a);
  assert.equal(act(r, runsOf(view(W(), 'running')), { applied: applied(r) }), undefined);
  const y = r.rule('second');
  const b = act(r, runsOf(view(W(), 'running')), { applied: applied(r) });
  assert.ok(b?.do === 'send' && b.reason === 'ruling' && b.rulings === y.seq);
  assert.equal(b.message, ['New parent rulings for a:', `#${y.seq} (a): second`, WRITER_TAIL].join('\n'));
});

test('D22.2a: only a running run is steered (not asking, queued or sealed); an asking run is notified; halted nodes get nothing', () => {
  const r = rig(); r.dispatch(); r.launchWriter(); r.rule('late');
  const asking = act(r, runsOf(view(W(), 'asking', { questions: [{ qid: 'q1', rev: 1, question: '?' }] })));
  assert.equal(asking?.do, 'notify');
  assert.equal(act(r, runsOf(view(W(), 'queued'))), undefined);
  // A sealed writer without candidate gets the submit follow-up, not a ruling steer (the steer is the lowest row).
  assert.ok((a => a?.do === 'send' && a.reason === 'submit')(act(r, runsOf(view(W(), 'sealed', { status: 'ok' })))));
  r.halt();
  assert.equal(act(r, runsOf(view(W(), 'running'))), undefined, 'halted: no action');
  // No ruling in scope: a running writer idles exactly as before.
  const q = rig(); q.rule('for c', ['c']); q.dispatch(); q.launchWriter();
  assert.equal(act(q, runsOf(view(W(), 'running'))), undefined);
});

test('D22.2a: the ruling steer is the lowest row: attest, repairs and a fence go first; a ruling steer never hides a fence', () => {
  const r = rig(); r.dispatch(); r.launchWriter(); r.submit();
  const late = r.rule('late');
  // Rows 9-10: attest outranks it (writer still running after submitting).
  assert.deepEqual(act(r, runsOf(view(W(), 'running'))), { do: 'attest', node: 'a' });
  r.pass();
  // Reviewers needed: row 12 launch outranks it.
  assert.equal(act(r, runsOf(view(W(), 'running')))?.do, 'launch');
  r.launchReviewer(1); r.launchReviewer(2);         // their packets carry `late`
  const later = r.rule('later');
  // A fence on the running writer: the fenced steer first.
  const fence = { reason: 'orchestrator restart', at: Date.parse(r.entries.at(-1)!.ts) + 1 };
  const runs = (w: Partial<RunView> = {}) => runsOf(view(W(), 'running', w), view(R(1), 'running'), view(R(2), 'running'));
  const f = act(r, runs({ lastFence: fence }));
  assert.ok(f?.do === 'send' && f.reason === 'fenced');
  r.record(f);
  // Then the writer's ruling steer, then the reviewers' (writer first, then by n; one per pass).
  const order: string[] = [];
  for (let i = 0; i < 3; i++) {
    const a = act(r, runs({ lastFence: fence }), { applied: applied(r) });
    assert.ok(a?.do === 'send' && a.reason === 'ruling' && a.rulings === later.seq, JSON.stringify(a));
    assert.equal(a.message.includes(`#${late.seq} `), a.rid === W(), 'the writer also lacks `late`; the reviewers had it in their packet');
    order.push(a.rid); r.record(a);
  }
  assert.deepEqual(order, [W(), R(1), R(2)]);
  assert.equal(act(r, runs({ lastFence: fence }), { applied: applied(r) }), undefined, 'all delivered');
  // A newer fence after the ruling steers is still answered (only fenced steers count as the last steer).
  const newer = { ...fence, at: Date.parse(r.entries.at(-1)!.ts) + 1 };
  const g = act(r, runs({ lastFence: newer }), { applied: applied(r) });
  assert.ok(g?.do === 'send' && g.reason === 'fenced', JSON.stringify(g));
});

// ---------- D22.2: reviewer ----------
test('D22.2: a running reviewer gets rulings recorded after its launch, with the --ack-rulings text; its packet rulings are delivered', () => {
  const r = rig(); r.dispatch(); r.launchWriter(); r.submit(); r.pass();
  const early = r.rule('before the reviewer launch');
  r.launchReviewer(1); r.launchReviewer(2);
  const sealed = view(W(), 'sealed', { status: 'ok' });
  assert.equal(deliveredRulings(r.state(), 'a', r.state().nodes.a!.runs[0]!, r.state().nodes.a!.runs[0]!.launches[1]!), early.seq);
  // The writer is sealed (the ruling travels with a repair) and both reviewers have it in their packet: no steer.
  assert.equal(act(r, runsOf(sealed, view(R(1), 'running'), view(R(2), 'running'))), undefined);
  const late = r.rule('judge error bodies too', '*');
  const a = act(r, runsOf(sealed, view(R(1), 'running'), view(R(2), 'asking', { questions: [{ qid: 'q', rev: 1, question: '?' }] })));
  // R2 asking: row 5 notify wins.
  assert.equal(a?.do, 'notify');
  const b = act(r, runsOf(sealed, view(R(1), 'running'), view(R(2), 'running')));
  assert.deepEqual(b, { do: 'send', node: 'a', attempt: 1, rid: R(1), sendKind: 'steer', reason: 'ruling', rulings: late.seq,
    message: ['New parent rulings for a:', `#${late.seq} (*): judge error bodies too`, `Judge the candidate against these rulings and record your review with --ack-rulings ${late.seq}.`].join('\n') });
  assert.equal(rulingMessage('a', 'reviewer', [r.state().rules.find(x => x.seq === late.seq)!]), b.message);
  r.record(b);
  const c = act(r, runsOf(sealed, view(R(1), 'running'), view(R(2), 'running')), { applied: applied(r) });
  assert.ok(c?.do === 'send' && c.rid === R(2) && c.rulings === late.seq);
});

// ---------- D22.4a: rulings already carried by a repair ----------
test('D22.4a: sealed → repair (lists the ruling) → running writer: no duplicate ruling steer; a later ruling is steered alone', () => {
  const r = rig(); r.dispatch(); r.launchWriter(); r.submit();
  const x = r.rule('the decision');
  r.obs('check:unit', 'fail'); r.obs('writes', 'pass');
  const sealed = view(W(), 'sealed', { status: 'ok' });
  const repair = act(r, runsOf(sealed));
  assert.ok(repair?.do === 'send' && repair.reason === 'repair' && repair.message.includes(`#${x.seq} the decision`), JSON.stringify(repair));
  r.record(repair);
  const running = runsOf(view(W(), 'running'));
  assert.equal(act(r, running, { applied: applied(r) }), undefined, 'the repair carried the ruling');
  // The writer resubmits while still running: still no duplicate (row 18 idles).
  r.submit('2'); r.pass();
  // The attribution rerun confirms candidate 1's failure and clears its block (else rows 9-10 attest).
  r.add({ kind: 'obs', by: 'executor:owed', subject: 'a', obligation: 'check:unit', key: 'a-check:unit-1', verdict: 'fail', exit: 1, durationMs: 1, commit: 'ac1', base: 's0', attribution: true });
  r.launchReviewer(1); r.launchReviewer(2);
  const all = runsOf(view(W(), 'running'), view(R(1), 'running'), view(R(2), 'running'));
  // Reviewers launched after the ruling have it in their packet.
  assert.equal(act(r, all, { applied: applied(r) }), undefined);
  const y = r.rule('one more');
  const a = act(r, all, { applied: applied(r) });
  assert.ok(a?.do === 'send' && a.rid === W() && a.rulings === y.seq);
  assert.equal(a.message, ['New parent rulings for a:', `#${y.seq} (a): one more`, WRITER_TAIL].join('\n'));
  // While the repair is outstanding and the writer runs, a newer ruling is steered too (the node would otherwise idle).
  const q = rig(); q.dispatch(); q.launchWriter(); q.submit(); q.obs('check:unit', 'fail'); q.obs('writes', 'pass');
  q.record(act(q, runsOf(view(W(), 'sealed', { status: 'ok' }))));
  const z = q.rule('after the repair');
  const b = act(q, runsOf(view(W(), 'running')), { applied: applied(q) });
  assert.ok(b?.do === 'send' && b.reason === 'ruling' && b.rulings === z.seq, JSON.stringify(b));
});

// ---------- D22.3: dsa rejection / retry of a ruling send ----------
test('D22.3: a rejected ruling send never halts and is never sent again; an unconfirmed one is re-sent with the same id and bytes', () => {
  const r = rig(); r.dispatch(); r.launchWriter();
  const x = r.rule('late');
  const a = act(r, runsOf(view(W(), 'running')));
  const e = r.record(a);
  // Unconfirmed (another process, or a crash): row 4 re-sends the stored bytes under the same id.
  assert.deepEqual(act(r, runsOf(view(W(), 'running'))), { do: 'send', node: 'a', attempt: 1, rid: W(), sendKind: 'steer', message: (a as { message: string }).message, reason: 'ruling', send: e.send, rulings: x.seq });
  // Rejected (the writer sealed meanwhile): no halt, no re-send, no new ruling send; the other rows go on.
  const rejected = new Map([[e.send, `${W()} is finished; use follow-up`]]);
  const next = act(r, runsOf(view(W(), 'sealed', { status: 'ok' })), { rejected });
  assert.ok(next?.do === 'send' && next.reason === 'submit', JSON.stringify(next));
  assert.equal(act(r, runsOf(view(W(), 'running')), { rejected }), undefined, 'not re-steered under a new id');
  // Other rejected sends still halt (unchanged).
  const s = r.send(W(), 'submit');
  const h = act(r, runsOf(view(W(), 'running')), { rejected: new Map([...rejected, [s.send, 'nope']]) });
  assert.ok(h?.do === 'halt' && h.reason.includes(`dsa rejected send ${s.send}: nope`));
});

// ---------- D22.1: the ledger field ----------
test('D22.1: rulings is required for reason ruling, must name an in-scope ruling, and is forbidden for other reasons', () => {
  const r = rig(); r.dispatch(); const l = r.launchWriter();
  const x = r.rule('late'), c = r.rule('for c', ['c']);
  const s = r.state(), seq = s.seq + 1;
  const d = (o: Partial<Extract<Draft, { kind: 'send' }>>): Draft => ({ kind: 'send', by: 'parent:drive', node: 'a', attempt: 1, rid: l.rid, send: `${l.rid}:steer:${seq}`, sendKind: 'steer', message: sha256('m'), reason: 'ruling', ...o }) as Draft;
  assert.deepEqual(validateDraft(s, d({ rulings: x.seq })), []);
  assert.match(validateDraft(s, d({})).join('; '), /send reason ruling requires rulings/);
  assert.match(validateDraft(s, d({ rulings: c.seq })).join('; '), /send reason ruling requires rulings/, 'out of scope');
  assert.match(validateDraft(s, d({ rulings: 999 })).join('; '), /send reason ruling requires rulings/, 'no such ruling');
  assert.match(validateDraft(s, d({ rulings: 1.5 })).join('; '), /send reason ruling requires rulings/);
  assert.match(validateDraft(s, d({ reason: 'fenced', rulings: x.seq })).join('; '), /send rulings is only allowed with reason ruling/);
  assert.deepEqual(validateDraft(s, d({ reason: 'fenced' })), []);
  // The ledger line shows it.
  const e = r.add(d({ rulings: x.seq }));
  assert.match(renderEntry(e), /recorded driver steer \(ruling through #\d+\) to /);
});

// ---------- D22.5: run names ----------
test('D22.5: new launches carry the dsa run name next to the labels; a re-launch sends the stored bytes unchanged', () => {
  assert.equal(runName('a', 1, 'writer'), 'owed a#1 writer');
  assert.equal(runName('a', 2, 'reviewer', 3), 'owed a#2 reviewer 3');
  const r = rig(); r.dispatch();
  const w = act(r, runsOf());
  assert.ok(w?.do === 'launch');
  assert.equal(JSON.parse(w.spec).name, 'owed a#1 writer');
  assert.deepEqual(Object.keys(JSON.parse(w.spec)), ['agent', 'cwd', 'isolation', 'model', 'name', 'once', 'task']);
  assert.deepEqual(w.labels, runLabels(P, 'a', 1, 'writer'));
  r.launchWriter(); r.submit(); r.pass();
  const v = act(r, runsOf(view(W(), 'sealed', { status: 'ok' })));
  assert.ok(v?.do === 'launch' && v.role === 'reviewer');
  assert.equal(JSON.parse(v.spec).name, 'owed a#1 reviewer 1');
  // A launch recorded before 0.5 (no name): the rebuilt spec differs, so the stored bytes are re-sent unchanged.
  const q = rig(); q.dispatch();
  const built = writerLaunch(q.state(), 'a', P), old = launchSpec({ ...DRIVE.writer, cwd: '/repo/.owed/wt/a-1', task: JSON.parse(built.spec).task });
  assert.equal(JSON.parse(old).name, undefined);
  q.add({ kind: 'launch', by: 'parent:drive', node: 'a', attempt: 1, role: 'writer', rid: built.rid, spec: sha256(old), labels: built.labels });
  q.blobs.set(sha256(old), old);
  const re = act(q, runsOf(view(W(), 'absent')));
  assert.ok(re?.do === 'launch');
  assert.equal(re.spec, old);
});

// ---------- D22.6: answer address ----------
test('D22.6: the asking text addresses the question by dsa\'s call address (pi tool form and CLI form), else the rid', () => {
  const r = rig(); r.dispatch(); r.launchWriter(); r.submit();
  const withTo = act(r, runsOf(view(W(), 'asking', { questions: [{ qid: 'q1-1', rev: 2, question: 'Which API?\nline two', to: 'w7/main' }] })));
  assert.ok(withTo?.do === 'notify');
  assert.equal(withTo.text, `a: writer run ${W()} asks (qid q1-1, rev 2): Which API?\\nline two — the driver never answers; answer in pi: subagents {action:"send", kind:"answer", to:"w7/main", qid:"q1-1", message:"…"}; or: pi-durable-subagents send --request <id> --to w7/main --kind answer --qid q1-1 --rev 2 --message @<file>`);
  assert.ok(!withTo.text.includes(`--to ${W()}`), 'not the rid');
  const without = act(r, runsOf(view(W(), 'asking', { questions: [{ qid: 'q', rev: 1, question: 'scope?' }, { qid: 'q2', rev: 1, question: 'two', to: 'w7/main' }] })));
  assert.ok(without?.do === 'notify');
  const [one, two] = without.text.split('\n');
  assert.ok(one!.endsWith(`answer in pi: subagents {action:"send", kind:"answer", to:"${W()}", qid:"q", message:"…"}; or: pi-durable-subagents send --request <id> --to ${W()} --kind answer --qid q --rev 1 --message @<file>`), one);
  assert.ok(two!.includes('to:"w7/main"') && two!.includes('--to w7/main'), two);
  const l = r.state().nodes.a!.runs[0]!.launches[0]!;
  assert.match(askingText('a', l, { rid: W(), state: 'asking' }), /is asking \(no question reported; see pi-durable-subagents describe --key /);
});

// ---------- executor against the fake dsa ----------
const FAKE = fileURLToPath(new URL('./fixtures/fake-dsa.mjs', import.meta.url));
const OWED = fileURLToPath(new URL('../bin/owed.js', import.meta.url));
async function fakeRig() {
  const plan = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: [{ id: 'k', writes: ['k.txt'], checks: [], review: { count: 0, min_rank: 1 } }] };
  const r = await repo();
  const dir = join(r.root, 'dsa'), bin = join(r.root, 'bin');
  await mkdir(join(dir, 'agents'), { recursive: true }); await mkdir(bin);
  await writeFile(join(bin, 'owed'), `#!/bin/sh\nexec "${process.execPath}" "${OWED}" "$@"\n`); await chmod(join(bin, 'owed'), 0o755);
  const env = { FAKE_DSA_DIR: dir, PATH: `${bin}:${process.env.PATH}`, ...identity };
  await r.put('plan.json', JSON.stringify(plan)); await r.put('README', 'x\n'); await r.commit();
  await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'human' }, channel: 'flag', plan: JSON.stringify(plan) });
  await writeFile(join(dir, 'agents', 'k-writer.sh'), 'echo RUNNING\n');
  const fakeState = async () => JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
  const once = async (dsa: Dsa) => { const lines: string[] = []; const exit = await drive({ cwd: r.cwd, once: true, dsa, log: l => lines.push(l), pollMs: 50, passMs: 300, handleSignals: false }); return { exit, lines }; };
  const entries = async (): Promise<Entry[]> => (await Ledger.open(r.cwd)).read();
  return { ...r, dir, env, fakeState, once, entries };
}
const sends = (es: Entry[]) => es.filter((e): e is SendEntry => e.kind === 'send');

test('D22 executor: a ruling recorded while the writer runs reaches it as a recorded steer, once', { timeout: 120_000 }, async () => {
  const f = await fakeRig();
  try {
    const dsa = new Dsa({ bin: FAKE, env: f.env, timeoutMs: 120_000 });
    await f.once(dsa); await f.once(dsa);                  // dispatch, launch (the writer keeps running)
    const launch = (await f.entries()).find((e): e is LaunchEntry => e.kind === 'launch')!;
    assert.ok(launch, 'writer launched');
    const st = await f.fakeState();
    assert.equal(st.runs[launch.rid].state, 'running');
    const rule = await ops.rule({ cwd: f.cwd, as: { role: 'parent', id: 'main' }, text: 'keep it small', nodes: ['k'] });
    const out = await f.once(dsa);
    assert.match(out.lines.join('\n'), /send steer \(ruling\) to .*:k:1:writer .*: applied/, out.lines.join('\n'));
    const [s] = sends(await f.entries());
    assert.ok(s && s.reason === 'ruling' && s.sendKind === 'steer' && s.rulings === rule.seq, JSON.stringify(s));
    const steers: string[] = (await f.fakeState()).runs[launch.rid].steers;
    assert.deepEqual(steers, [`New parent rulings for k:\n#${s.rulings} (k): keep it small\n${WRITER_TAIL}`]);
    await f.once(dsa);
    assert.equal(sends(await f.entries()).length, 1, 'delivered once');
    assert.equal((await f.fakeState()).runs[launch.rid].steers.length, 1);
  } finally { await f.cleanup(); }
});

test('D22.3 executor: dsa rejecting a ruling steer (the call sealed meanwhile) is logged, never halts, never retried', { timeout: 120_000 }, async () => {
  const f = await fakeRig();
  try {
    /** Seals the run in the fake dsa just before a steer reaches it, so dsa really rejects (and records) that send. */
    class SealingDsa extends Dsa {
      override async send(...args: Parameters<Dsa['send']>): ReturnType<Dsa['send']> {
        if (args[2] === 'steer') {
          const p = join(f.dir, 'state.json'), st = JSON.parse(await readFile(p, 'utf8'));
          Object.assign(st.runs[args[1]], { state: 'sealed', status: 'ok' });
          await writeFile(p, JSON.stringify(st));
        }
        return super.send(...args);
      }
    }
    const dsa = new SealingDsa({ bin: FAKE, env: f.env, timeoutMs: 120_000 });
    await f.once(dsa); await f.once(dsa);
    await ops.rule({ cwd: f.cwd, as: { role: 'parent', id: 'main' }, text: 'keep it small', nodes: ['k'] });
    const out = await f.once(dsa);
    assert.match(out.lines.join('\n'), /send steer \(ruling\) to .*: rejected — .*is finished; use follow-up; not retried/, out.lines.join('\n'));
    let es = await f.entries();
    assert.equal(es.filter(e => e.kind === 'halt').length, 0, 'no halt');
    const ruling = sends(es).filter(x => x.reason === 'ruling');
    assert.equal(ruling.length, 1);
    // Next passes: the sealed writer gets the submit follow-up; the rejected ruling send is neither re-sent nor replaced.
    const next = await f.once(dsa);
    es = await f.entries();
    assert.equal(es.filter(e => e.kind === 'halt').length, 0, next.lines.join('\n'));
    assert.deepEqual(sends(es).map(x => x.reason), ['ruling', 'submit'], next.lines.join('\n'));
    await f.once(dsa);
    es = await f.entries();
    assert.deepEqual(sends(es).map(x => x.reason), ['ruling', 'submit']);
    const log = (await readFile(join(f.dir, 'log.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l) as { cmd: string; request?: string; replay?: boolean });
    assert.equal(log.filter(x => x.cmd === 'send' && x.request === ruling[0]!.send).length, 1, 'the rejected id was sent once');
  } finally { await f.cleanup(); }
});
