// G3 (0.6.0, node drive-order): repair before re-review; one message to the writer when a new candidate is needed while
// a repairable review block is active (wais 2026-10-10 #1); trunk-drift print/wake records reset when drift clears, are
// keyed apart from a plan node named `trunk`, and the ledger-missing notice. Exports added by this node are read through
// the module namespace, so the base fails by assertion or "is not a function", not at import time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { sha256 } from '../src/canon.ts';
import * as drv from '../src/drive.ts';
import { decide, reviewerLaunch, writerLaunch, type Action, type DriveOpts } from '../src/drive.ts';
import * as run from '../src/drive-run.ts';
import { Follower, classifyLine } from '../src/drive-bg.ts';
import { driveReviewer, manualKeys, reduce, runId } from '../src/reducer.ts';
import { Ledger } from '../src/ledger.ts';
import { Dsa } from '../src/dsa.ts';
import { git } from '../src/git.ts';
import * as ops from '../src/ops.ts';
import type { CandidateFacts, DriveConfig, Draft, Entry, LaunchEntry, NodeSpec, Plan, RunView, SendEntry, State } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { identity } from './helpers/surface.ts';

const NEW = { drv: drv as unknown as Record<string, unknown>, run: run as unknown as Record<string, unknown> };

// ---------- synthetic ledger rig (no git), as in drive.test.ts, with plan updates ----------
const P = 'hash0';
const W = (attempt = 1) => runId(P, 'a', attempt, 'writer');
const R = (n: number, attempt = 1) => runId(P, 'a', attempt, 'reviewer', n);
const T0 = Date.UTC(2026, 0, 1);
const iso = (seq: number) => new Date(T0 + seq * 1000).toISOString();
const DRIVE: DriveConfig = { max: 4, repairs: 2, writer: { agent: 'worker', model: 'example/x:high' }, reviewer: { agent: 'reviewer' } };
const unit = { id: 'unit', run: 'npm test', timeout_s: 60, reads: ['a/**'] };
const nodeA = (o: Partial<NodeSpec> = {}): NodeSpec => ({ id: 'a', deps: [], writes: ['a/'], checks: [unit], review: { count: 1, min_rank: 1 }, ...o });
const planOf = (a: NodeSpec): Plan => ({ version: 1, trunk: 'main', closure: ['closure/'], invariants: [], drive: DRIVE, nodes: [a] });

function rig(a: NodeSpec = nodeA()) {
  const entries: Entry[] = [], plans: Record<string, Plan> = { p: planOf(a) }, blobs = new Map<string, string>();
  const state = (): State => reduce(entries, sha => plans[sha]!);
  const add = (d: Draft): Entry => { const seq = entries.length, e = { ...d, seq, ts: iso(seq), prev: 'x', hash: `hash${seq}` } as Entry; entries.push(e); state(); return e; };
  const blob = (text: string): string => { const h = sha256(text); blobs.set(h, text); return h; };
  add({ kind: 'genesis', by: 'owner:human', channel: 'tty', plan: 'p', trunk: 'main', commit: 's0', state: { commit: 's0', tree: 't0', invKeys: {} } });
  const slot = () => state().nodes.a!.slot!;
  /** Candidate facts of content `tag`: equal tags are identical content (same patch, same keys). */
  const facts = (tag: string): CandidateFacts => {
    const spec = state().plan.nodes.find(x => x.id === 'a')!;
    return { commit: `ac${tag}`, tree: `t${tag}`, base: slot().base, patch: `p${tag}`, changed: ['a/x'], closureTouched: false,
      keys: Object.fromEntries([...spec.checks.map(c => `check:${c.id}`), 'writes', 'rulings', 'review'].map(o => [o, `a-${o}-${tag}`])) };
  };
  const r = {
    entries, blobs, state, add,
    dispatch() { const s = state(), attempt = (s.nodes.a!.slot?.attempt ?? 0) + 1; return add({ kind: 'dispatch', by: 'parent:drive', node: 'a', attempt, base: s.trunk.commit, branch: `owed/a/${attempt}`, worktree: `/repo/.owed/wt/a-${attempt}`, packet: 'blob', rulings_seen: Math.max(-1, ...s.rules.map(x => x.seq)) }); },
    launchWriter() { const l = writerLaunch(state(), 'a', P); return add({ kind: 'launch', by: 'parent:drive', node: 'a', attempt: l.attempt, role: 'writer', rid: l.rid, spec: blob(l.spec), labels: l.labels, rulings: l.rulings }); },
    launchReviewer(n: number) { const l = reviewerLaunch(state(), 'a', n, P, '/repo'); return add({ kind: 'launch', by: 'parent:drive', node: 'a', attempt: l.attempt, role: 'reviewer', rid: l.rid, spec: blob(l.spec), labels: l.labels, rulings: l.rulings }); },
    /** Records the send of an action (as the executor does through ops.send). */
    record(a: Action | undefined): SendEntry {
      assert.ok(a?.do === 'send', `a send: ${JSON.stringify(a)}`);
      return add({ kind: 'send', by: 'parent:drive', node: a.node, attempt: a.attempt, rid: a.rid, send: `${a.rid}:${a.sendKind}:${entries.length}`, sendKind: a.sendKind, message: blob(a.message), reason: a.reason, ...(a.rulings !== undefined ? { rulings: a.rulings } : {}) }) as SendEntry;
    },
    recordHalt(a: Action | undefined) { assert.ok(a?.do === 'halt', `a halt: ${JSON.stringify(a)}`); return add({ kind: 'halt', by: 'parent:drive', node: 'a', attempt: a.attempt, reason: a.reason, needs: a.needs }); },
    submit(tag = '1') { return add({ kind: 'submit', by: `writer:a#${slot().attempt}`, node: 'a', attempt: slot().attempt, facts: facts(tag) }); },
    obs(obligation: string, verdict: 'pass' | 'fail') {
      const c = state().nodes.a!.candidate!;
      return add({ kind: 'obs', by: 'executor:owed', subject: 'a', obligation, key: c.keys[obligation]!, verdict, exit: verdict === 'pass' ? 0 : 1, durationMs: 1, commit: c.commit, base: c.base });
    },
    /** Measures every unmeasured check/writes item of the candidate as passing (what `attest` records). */
    pass() { for (const i of state().nodes.a!.items.filter(i => (i.obligation === 'writes' || i.obligation.startsWith('check:')) && i.status === 'D')) r.obs(i.obligation, 'pass'); },
    review(verdict: 'ok' | 'block', o: { by?: string; rank?: number; note?: string; needs?: 'parent' } = {}) {
      const c = state().nodes.a!.candidate!;
      return add({ kind: 'review', by: o.by ?? driveReviewer('a', slot().attempt, 1), node: 'a', attempt: slot().attempt, obligation: 'review', key: c.keys.review!, verdict, rank: o.rank ?? 1, note: o.note ?? 'n', ...(o.needs ? { needs: o.needs } : {}) });
    },
    rule(text: string) { return add({ kind: 'rule', by: 'parent:main', text, nodes: ['a'] }); },
    /** An owner plan update replacing node a (a changed check set invalidates the open candidate). */
    plan(a: NodeSpec) { const sha = `p${Object.keys(plans).length + 1}`; plans[sha] = planOf(a); return add({ kind: 'plan', by: 'owner:pi', channel: 'delegated', prior: state().planSha, plan: sha, downgrades: [] }); },
  };
  return r;
}
type Rig = ReturnType<typeof rig>;
const view = (rid: string, state: RunView['state'], extra: Partial<RunView> = {}): [string, RunView] => [rid, { rid, state, ...extra }];
const runsOf = (...vs: [string, RunView][]) => new Map(vs);
const sealed = (rid: string) => view(rid, 'sealed', { status: 'ok' });
const optsOf = (r: Rig, o: Partial<DriveOpts> = {}): DriveOpts => ({ max: 4, repairs: 2, project: P, root: '/repo', applied: new Set(r.entries.flatMap(e => e.kind === 'send' ? [e.send] : [])), rejected: new Map(), blobs: r.blobs, ...o });
function act(r: Rig, runs: Map<string, RunView>, o: Partial<DriveOpts> = {}): Action | undefined {
  const s = r.state(), mine = decide(s, s.plan, runs, optsOf(r, o)).filter(x => x.node === 'a');
  assert.ok(mine.length <= 1, `at most one action per node: ${JSON.stringify(mine)}`);
  return mine[0];
}
const what = (a: Action | undefined): string => a ? `${a.do}${a.do === 'send' ? ` ${a.reason}` : a.do === 'launch' ? ` ${a.role}` : ''}` : 'none';

// ---------- G3.1: repair on the current candidate before any reviewer run ----------
test('G3.1: a review block on the current candidate\'s key is repaired before row 12 launches a reviewer run', () => {
  // Two reviews needed; reviewer run 1 blocks before run 2 is launched: repair, not reviewer 2.
  const r = rig(nodeA({ review: { count: 2, min_rank: 1 } }));
  r.dispatch(); r.launchWriter(); r.submit(); r.pass();
  assert.equal(what(act(r, runsOf(sealed(W())))), 'launch reviewer', 'no block yet: row 12 as before');
  r.launchReviewer(1);
  r.review('block', { note: 'missing error path' });
  const a = act(r, runsOf(sealed(W()), sealed(R(1))));
  assert.equal(what(a), 'send repair', JSON.stringify(a));
  assert.ok(a?.do === 'send' && a.message.includes('missing error path'));
  // A block by another principal (rank 1, not owner-needed) on the current key: also repaired first.
  const q = rig(); q.dispatch(); q.launchWriter(); q.submit(); q.pass();
  q.review('block', { by: 'reviewer:human', note: 'wrong api' });
  assert.equal(what(act(q, runsOf(sealed(W())))), 'send repair');
  // While that repair is outstanding and the writer runs: no reviewer launch either.
  q.record(act(q, runsOf(sealed(W()))));
  assert.equal(act(q, runsOf(view(W(), 'running'))), undefined);
});

test('G3.1: the needs-parent halt and the measured rows 9-11 keep their order before the repair', () => {
  // Unmeasured check: attest first.
  const r = rig(); r.dispatch(); r.launchWriter(); r.submit();
  r.review('block', { by: 'reviewer:human' });
  assert.equal(what(act(r, runsOf(sealed(W())))), 'attest');
  // A failing check: the measured repair (its message names the failure) before anything else.
  r.obs('writes', 'pass'); r.obs('check:unit', 'fail');
  const m = act(r, runsOf(sealed(W())));
  assert.ok(m?.do === 'send' && m.reason === 'repair', JSON.stringify(m));
  // An unruled needs-parent block on the current key: halt, no repair, no reviewer launch.
  const q = rig(); q.dispatch(); q.launchWriter(); q.submit(); q.pass();
  q.review('block', { rank: 2, needs: 'parent', note: 'which contract?' });
  const h = act(q, runsOf(sealed(W())));
  assert.ok(h?.do === 'halt' && /needs a parent ruling: which contract\?/.test(h.reason), JSON.stringify(h));
});

// ---------- G3.2: one follow-up when a new candidate is needed ----------
test('G3.2: plan change with a repairable block: one repair follow-up (rulings, blocks, why, submit) replaces submit', () => {
  const r = rig(); r.dispatch(); r.launchWriter(); r.submit(); r.pass(); r.launchReviewer(1);
  const b = r.review('block', { note: 'handle empty input' });
  const x = r.rule('empty input returns 400');
  r.plan(nodeA({ checks: [unit, { id: 'pose', run: 'npm run pose', timeout_s: 60, reads: ['a/**'] }] }));
  assert.equal(r.state().nodes.a!.candidate, undefined, 'the plan change invalidated the candidate');
  const a = act(r, runsOf(sealed(W()), sealed(R(1))));
  assert.ok(a?.do === 'send' && a.reason === 'repair' && a.sendKind === 'follow-up' && a.rid === W(), JSON.stringify(a));
  assert.equal(a.rulings, x.seq, 'records the ruling it carries');
  const lines = a.message.split('\n');
  const at = (re: RegExp) => lines.findIndex(l => re.test(l));
  assert.ok(at(new RegExp(`^- #${x.seq} empty input returns 400$`)) >= 0, a.message);
  assert.ok(at(new RegExp(`^- #${b.seq} review by reviewer:drive-a-1-1 rank 1: handle empty input$`)) >= 0, a.message);
  assert.ok(at(new RegExp(`#${x.seq} `)) < at(new RegExp(`#${b.seq} `)), 'rulings first');
  assert.ok(at(/plan changed/) > at(new RegExp(`#${b.seq} `)), 'then why a new candidate is needed');
  assert.match(lines.at(-1)!, /commit, and run `owed submit a`/);
  assert.deepEqual(NEW.drv.resubmitFollowUp && (NEW.drv.resubmitFollowUp as (s: State, n: string) => unknown)(r.state(), 'a'), { message: a.message, rulings: x.seq });
  r.record(a);
  // The writer runs the follow-up: no separate ruling steer (the repair carried it), no submit nudge.
  assert.equal(act(r, runsOf(view(W(), 'running'))), undefined);
  // It finishes without submitting: halt (not a submit nudge).
  const h = act(r, runsOf(sealed(W())));
  assert.ok(h?.do === 'halt' && /finished repair follow-up .* without submitting a new candidate/.test(h.reason), JSON.stringify(h));
  // Without a block, row 8 sends submit; 0.10 (N1.4): it names the plan entry that invalidated the submit.
  const q = rig(); q.dispatch(); q.launchWriter(); q.submit(); q.pass();
  const qp = q.plan(nodeA({ checks: [unit, { id: 'pose', run: 'x', timeout_s: 60, reads: ['a/**'] }] }));
  const s = act(q, runsOf(sealed(W())));
  assert.ok(s?.do === 'send' && s.reason === 'submit' && s.message === drv.planChangedMessage('a', qp.seq, ['checks']), JSON.stringify(s));
});

test('G3.2: rebase with a repairable block: one repair carrying the rebase instructions; repairs are counted', () => {
  const r = rig(); r.dispatch(); r.launchWriter(); r.submit(); r.pass();
  r.review('block', { by: 'reviewer:human', note: 'rename it' });
  r.add({ kind: 'adopt', by: 'owner:human', channel: 'tty', trunk: 'main', prior: 's0', commit: 's1', state: { commit: 's1', tree: 't1', invKeys: {} }, changed: ['x'], commits: 1, note: 'moved' });
  r.add({ kind: 'rebase', by: 'parent:drive', node: 'a', attempt: 1, base: 's1', from: 's0' });
  const a = act(r, runsOf(sealed(W())));
  assert.ok(a?.do === 'send' && a.reason === 'repair', JSON.stringify(a));
  assert.equal(a.rulings, 0);
  assert.match(a.message, /rename it[\s\S]*Trunk moved[\s\S]*git rebase --onto s1 s0[\s\S]*owed submit a`\.$/);
  assert.ok(!a.message.includes('plan changed'));
  // Repairs exhausted: halt instead.
  const e = act(r, runsOf(sealed(W())), { repairs: 0 });
  assert.ok(e?.do === 'halt' && /^repairs exhausted \(0 of 0 since dispatch\): review block #\d+ review/.test(e.reason), JSON.stringify(e));
  // Review #680 (a): an unruled needs-parent block (alone) halts row 8 before the rebase follow-up; once ruled, the
  // block is repaired with the rebase instructions in one follow-up.
  const q = rig(); q.dispatch(); q.launchWriter(); q.submit(); q.pass();
  const np = q.review('block', { by: 'reviewer:human', needs: 'parent', note: 'which contract?' });
  q.add({ kind: 'adopt', by: 'owner:human', channel: 'tty', trunk: 'main', prior: 's0', commit: 's1', state: { commit: 's1', tree: 't1', invKeys: {} }, changed: ['x'], commits: 1, note: 'moved' });
  q.add({ kind: 'rebase', by: 'parent:drive', node: 'a', attempt: 1, base: 's1', from: 's0' });
  const qh = act(q, runsOf(sealed(W())));
  assert.ok(qh?.do === 'halt' && qh.reason === `review block #${np.seq} review needs a parent ruling: which contract?; record \`owed rule --nodes a "<decision>"\`; the writer gets the ruling with the next repair`, JSON.stringify(qh));
  q.recordHalt(qh); const ru = q.rule('contract X');
  const qr = act(q, runsOf(sealed(W())));
  assert.ok(qr?.do === 'send' && qr.reason === 'repair' && qr.rulings === ru.seq && /git rebase --onto s1 s0/.test(qr.message), JSON.stringify(qr));
});

// ---------- G3.3: the wais timeline ----------
test('G3.3 wais timeline: needs-parent block → halt → plan update → ruling → one repair with the ruling, no reviewer run until resubmit', () => {
  const r = rig(); r.dispatch(); r.launchWriter(); r.submit('1'); r.pass();
  assert.equal(what(act(r, runsOf(sealed(W())))), 'launch reviewer');
  r.launchReviewer(1);
  const block = r.review('block', { rank: 2, needs: 'parent', note: 'store pose or not?' });
  const runs1 = runsOf(sealed(W()), sealed(R(1)));
  r.recordHalt(act(r, runs1));                                            // #halt
  r.plan(nodeA({ checks: [unit, { id: 'pose-store', run: 'npm run pose', timeout_s: 60, reads: ['a/**'] }] }));
  const ruling = r.rule('store the pose');
  const reasons = (): string[] => r.state().nodes.a!.runs[0]!.sends.map(x => x.reason);
  const reviewers = (): number => r.state().nodes.a!.runs[0]!.launches.filter((l: LaunchEntry) => l.role === 'reviewer').length;
  // Next passes: exactly one writer follow-up (repair, carrying the ruling), nothing else.
  const f = act(r, runsOf(sealed(W())));
  assert.ok(f?.do === 'send' && f.reason === 'repair' && f.rulings === ruling.seq, JSON.stringify(f));
  assert.ok(f.message.includes(`ruling #${ruling.seq}`) && f.message.indexOf('store the pose') < f.message.indexOf(`#${block.seq} `), f.message);
  r.record(f);
  for (const w of ['running', 'queued'] as const) assert.equal(act(r, runsOf(view(W(), w))), undefined, `${w}: nothing more`);
  assert.deepEqual(reasons(), ['repair']);
  // The writer resubmits identical content: the new check is measured, then a second repair, never a reviewer run.
  r.submit('1');
  assert.equal(what(act(r, runsOf(sealed(W())))), 'attest');
  r.pass();
  const g = act(r, runsOf(sealed(W())));
  assert.ok(g?.do === 'send' && g.reason === 'repair', JSON.stringify(g));
  r.record(g);
  assert.equal(act(r, runsOf(view(W(), 'running'))), undefined);
  // Identical content once more: repairs (2) exhausted → halt; still no reviewer run.
  r.submit('1'); r.pass();
  const h = act(r, runsOf(sealed(W())));
  assert.ok(h?.do === 'halt' && h.reason.startsWith(`repairs exhausted (2 of 2 since ruling #${ruling.seq})`), JSON.stringify(h));
  assert.equal(reviewers(), 1, 'only the reviewer run of the first candidate');
  assert.deepEqual(reasons(), ['repair', 'repair']);
  // Real new content: the block is stale, so the slot re-review runs (row 12) as before.
  const q = rig(); q.dispatch(); q.launchWriter(); q.submit('1'); q.pass(); q.launchReviewer(1);
  q.review('block', { rank: 2, needs: 'parent' }); q.recordHalt(act(q, runsOf(sealed(W()), sealed(R(1)))));
  q.plan(nodeA({ checks: [unit, { id: 'pose-store', run: 'x', timeout_s: 60, reads: ['a/**'] }] })); q.rule('store it');
  q.record(act(q, runsOf(sealed(W()))));
  q.submit('2'); q.pass();
  assert.equal(what(act(q, runsOf(sealed(W())))), 'launch reviewer');
});

// ---------- G3.3 against the fake dsa ----------
const FAKE = fileURLToPath(new URL('./fixtures/fake-dsa.mjs', import.meta.url));
const OWED = fileURLToPath(new URL('../bin/owed.js', import.meta.url));
const kspec = (checks: object[]) => ({ version: 1, trunk: 'main', closure: [], invariants: [], drive: { repairs: 2 }, nodes: [{ id: 'k', writes: ['k.txt'], checks, review: { count: 1, min_rank: 1 } }] });
const okCheck = { id: 'ok', run: 'true', reads: ['k.txt'] };

test('G3.3 executor: the timeline through owed drive and the fake dsa sends one repair (with the ruling) and launches no second reviewer', { timeout: 300_000 }, async () => {
  const r = await repo();
  const dir = join(r.root, 'dsa'), bin = join(r.root, 'bin'), agents = join(dir, 'agents');
  try {
    await mkdir(agents, { recursive: true }); await mkdir(bin);
    await writeFile(join(bin, 'owed'), `#!/bin/sh\nexec "${process.execPath}" "${OWED}" "$@"\n`); await chmod(join(bin, 'owed'), 0o755);
    const env = { FAKE_DSA_DIR: dir, PATH: `${bin}:${process.env.PATH}`, ...identity };
    const plan = kspec([okCheck]);
    await r.put('README', 'x\n'); await r.commit();
    await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'pi' }, channel: 'delegated', plan: JSON.stringify(plan) });
    // Writer: commits and submits; every follow-up resubmits the same commit. Reviewer 1 blocks, needing a parent ruling.
    await writeFile(join(agents, 'k-writer-1.sh'), 'set -e\necho k > k.txt; git add k.txt; git commit -qm k; owed submit k\n');
    await writeFile(join(agents, 'k-writer.sh'), 'owed submit k || true\n');
    await writeFile(join(agents, 'k-reviewer.sh'), 'set -e\nowed review k --block --needs-parent --rank 1 --note "store the pose or not?" --as reviewer:drive-k-1-1\n');
    const dsa = new Dsa({ bin: FAKE, env, timeoutMs: 120_000 });
    const entries = async (): Promise<Entry[]> => (await Ledger.open(r.cwd)).read();
    const lines: string[] = [];
    const once = async () => { await run.drive({ cwd: r.cwd, once: true, dsa, log: l => lines.push(l), pollMs: 50, passMs: 300, handleSignals: false }); };
    const halted = async () => (await entries()).some(e => e.kind === 'halt');
    for (let i = 0; i < 10 && !(await halted()); i++) await once();
    let es = await entries();
    const block = es.find(e => e.kind === 'review' && e.verdict === 'block');
    assert.ok(block && es.at(-1)!.kind === 'halt', lines.join('\n'));
    const halts = es.filter(e => e.kind === 'halt').length;
    // The owner updates the plan (a new check invalidates the candidate), then rules.
    await ops.planSet({ cwd: r.cwd, as: { role: 'owner', id: 'pi' }, channel: 'delegated', plan: JSON.stringify(kspec([okCheck, { id: 'pose-store', run: 'true', reads: ['k.txt'] }])) });
    const ruling = await ops.rule({ cwd: r.cwd, as: { role: 'parent', id: 'main' }, text: 'store the pose', nodes: ['k'] });
    for (let i = 0; i < 10 && (await entries()).filter(e => e.kind === 'halt').length === halts; i++) await once();
    es = await entries();
    const after = es.filter(e => e.seq > ruling.seq);
    const sends = after.filter((e): e is SendEntry => e.kind === 'send');
    assert.ok(sends.length >= 1 && sends.every(x => x.reason === 'repair'), `${sends.map(x => x.reason)}\n${lines.join('\n')}`);
    assert.equal(sends[0]!.rulings, ruling.seq, 'the first follow-up carries the ruling');
    assert.equal(after.filter(e => e.kind === 'launch').length, 0, `no reviewer run after the ruling:\n${lines.join('\n')}`);
    assert.ok(after.some(e => e.kind === 'submit'), 'the writer resubmitted');
    const last = after.filter(e => e.kind === 'halt').at(-1);
    assert.ok(last && last.kind === 'halt' && /repairs exhausted|without submitting a new candidate/.test(last.reason), JSON.stringify(last));
    const msgs = (await readFile(join(dir, 'log.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l) as { cmd: string; request?: string });
    assert.equal(msgs.filter(m => m.cmd === 'send' && m.request === sends[0]!.send).length, 1);
  } finally { await r.cleanup(); }
});

// ---------- G3.4c: ledger-missing drift notice ----------
test('G3.4c: the ledger-missing notice says the commit is absent, update-ref cannot restore it, and how to proceed', () => {
  const ledger = 'a'.repeat(40), ref = 'b'.repeat(40);
  const t = run.driftNotice('main', { ref: 'refs/heads/main', commit: ref, ledger, relation: 'ledger-missing', ahead: 0, behind: 0 });
  assert.equal(t, `trunk main: the ledger's trunk commit ${ledger.slice(0, 12)} is absent from the repository, so git update-ref cannot restore it and owed adopt cannot check a fast-forward from it; bring the commit back (git fetch <remote> ${ledger} from any remote or clone that has it), then restore trunk (git update-ref refs/heads/main ${ledger} ${ref}) or adopt the current ref (owed adopt --commit ${ref.slice(0, 12)} --note "<why>")`);
  assert.doesNotMatch(t, /^trunk main was rewound|restore it: git update-ref/, 'no bare update-ref as the first step');
  assert.ok(t.indexOf('git fetch') < t.indexOf('git update-ref refs/heads') && t.indexOf('git fetch') < t.indexOf('owed adopt --commit'));
  // Other relations unchanged.
  assert.match(run.driftNotice('main', { ref: 'refs/heads/main', commit: ref, ledger, relation: 'diverged', ahead: 1, behind: 1 }), /^trunk main was rewound or rewritten .*restore it: git update-ref refs\/heads\/main /);
});

// ---------- G3.4b: a node named `trunk` keeps its own print/wake records ----------
test('G3.4b: the drift notify and a plan node named trunk keep separate print and wake records (driver and follower)', () => {
  const plan: Plan = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: [{ id: 'trunk', deps: [], writes: ['t/'], checks: [], review: { count: 0, min_rank: 1 } }] };
  const entries: Entry[] = [{ kind: 'genesis', by: 'owner:human', channel: 'tty', plan: 'p', trunk: 'main', commit: 's0', state: { commit: 's0', tree: 't0', invKeys: {} }, seq: 0, ts: iso(0), prev: 'x', hash: 'hash0' } as Entry];
  const s = reduce(entries, () => plan);
  const lines: string[] = [];
  const d = new run.Driver({ cwd: '/nonexistent', log: (l: string) => lines.push(l), json: true, session: null });
  const drift = { do: 'notify', node: 'trunk', scope: 'repo', outcome: 'notify', text: 'trunk main moved outside owed (x → y)', facts: 7 } as run.ActionReport;
  const mine = { do: 'notify', node: 'trunk', outcome: 'notify', text: 'trunk: needs the owner' } as run.ActionReport;
  d.emit({ ...drift }, s); d.emit({ ...mine }, s); d.emit({ ...drift }, s); d.emit({ ...mine }, s);
  assert.equal(lines.length, 2, lines.join('\n'));
  const [l1, l2] = lines.map(l => JSON.parse(l) as run.ActionReport);
  assert.equal(l1!.facts, 7, 'the drift keeps its trunk-seq mark, not the node\'s fact mark');
  assert.equal(l1!.scope, 'repo'); assert.equal(l2!.scope, undefined);
  // The follower: each wakes once, repeats of either do not wake, and they do not mask each other.
  const tmp = mkdtempSync(join(tmpdir(), 'owed-order-')), log = join(tmp, 'log.jsonl');
  try {
    writeFileSync(log, '');
    const got: string[] = [];
    const fo = new Follower({ log, repo: '/r', pid: process.pid, start: run.procStart(process.pid), deliver: c => got.push(c) });
    const node = JSON.stringify({ ...mine, facts: 3 });
    for (const l of [lines[0]!, node, lines[0]!, node]) { appendFileSync(log, `${l}\n`); fo.tick(); }
    assert.equal(got.length, 2, got.join('\n---\n'));
    assert.notEqual(classifyLine(lines[0]!).fact?.key, classifyLine(node).fact?.key);
  } finally { rmSync(tmp, { recursive: true, force: true }); }
});

// ---------- G3.4a: drift cleared resets the print and wake records ----------
test('G3.4a: when drift clears, an identical later drift prints again in the loop and wakes the follower again', { timeout: 120_000 }, async () => {
  const r = await repo();
  const tmp = mkdtempSync(join(tmpdir(), 'owed-order-')), log = join(tmp, 'log.jsonl');
  try {
    const plan = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: [{ id: 'trunk', writes: ['t.txt'], checks: [], review: { count: 0, min_rank: 1 } }] };
    await r.put('README', 'x\n'); const ledger = await r.commit();
    await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'pi' }, channel: 'delegated', plan: JSON.stringify(plan) });
    const lines: string[] = [];
    // max 0: nothing is dispatched; only the drift check acts. once: false keeps the loop's print records.
    const d = new run.Driver({ cwd: r.cwd, log: (l: string) => lines.push(l), json: true, max: 0, session: null, dsa: new Dsa({ bin: FAKE, env: { FAKE_DSA_DIR: join(tmp, 'dsa') }, timeoutMs: 60_000 }) });
    const moved = await r.commit();
    const driftLines = () => lines.filter(l => /moved outside owed/.test(l));
    await d.pass(); await d.pass();
    assert.equal(driftLines().length, 1, `printed once per change: ${lines.join('\n')}`);
    await git(r.cwd, ['update-ref', 'refs/heads/main', ledger, moved]);
    await d.pass();
    assert.ok(lines.some(l => (JSON.parse(l) as { event?: string }).event === 'drift-cleared'), lines.join('\n'));
    await d.pass();
    assert.equal(lines.filter(l => /drift-cleared/.test(l)).length, 1, 'logged once per clearing');
    await git(r.cwd, ['update-ref', 'refs/heads/main', moved, ledger]);
    await d.pass();
    assert.equal(driftLines().length, 2, `the identical drift prints again: ${lines.join('\n')}`);
    assert.equal(driftLines()[0], driftLines()[1], 'same text and fact mark');
    // The follower reading that log: wakes for the first drift, stays quiet on the clearing, wakes again.
    writeFileSync(log, '');
    const got: string[] = [];
    const fo = new Follower({ log, repo: '/r', pid: process.pid, start: run.procStart(process.pid), deliver: c => got.push(c) });
    for (const l of lines) { appendFileSync(log, `${l}\n`); fo.tick(); }
    assert.equal(got.length, 2, got.join('\n---\n'));
    assert.equal(classifyLine(lines.find(l => /drift-cleared/.test(l))!).kind, 'quiet');
  } finally { rmSync(tmp, { recursive: true, force: true }); await r.cleanup(); }
});

// ---------- G3.7: the rebase instruction lists the conflicting files ----------
test('G3.7: the rebase follow-up and the rebasing repair list the conflicting files (none when clean; omitted when unknown)', () => {
  const rebased = (block: boolean) => {
    const r = rig(); r.dispatch(); r.launchWriter(); r.submit(); r.pass();
    if (block) r.review('block', { by: 'reviewer:human', note: 'rename it' });
    r.add({ kind: 'adopt', by: 'owner:human', channel: 'tty', trunk: 'main', prior: 's0', commit: 's1', state: { commit: 's1', tree: 't1', invKeys: {} }, changed: ['x'], commits: 1, note: 'moved' });
    r.add({ kind: 'rebase', by: 'parent:drive', node: 'a', attempt: 1, base: 's1', from: 's0' });
    return r;
  };
  const r = rebased(false), runs = runsOf(sealed(W()));
  const msg = (o: Partial<DriveOpts>) => { const a = act(r, runs, o); assert.ok(a?.do === 'send' && a.reason === 'rebase', JSON.stringify(a)); return a.message; };
  assert.equal(msg({ conflicts: new Map([['a', ['a/x', 'a/y']]]) }), 'trunk moved; rebase your worktree onto main (s1): in /repo/.owed/wt/a-1 run `git rebase --onto s1 s0` (files that conflict with your previous candidate: a/x, a/y), resolve conflicts within the allowed writes, rerun checks, commit, then `owed submit a`');
  assert.match(msg({ conflicts: new Map([['a', []]]) }), /`git rebase --onto s1 s0` \(files that conflict with your previous candidate: none\), resolve/);
  assert.equal(msg({}), drv.rebaseMessage(r.state(), 'a'));
  assert.doesNotMatch(msg({ conflicts: new Map([['b', ['b/x']]]) }), /conflict with your previous candidate/, 'another node\'s list');
  const q = rebased(true), b = act(q, runs, { conflicts: new Map([['a', ['a/x']]]) });
  assert.ok(b?.do === 'send' && b.reason === 'repair', JSON.stringify(b));
  assert.match(b.message, /git rebase --onto s1 s0` \(files that conflict with your previous candidate: a\/x\) and resolve/);
});

test('G3.7: rebaseConflicts runs git merge-tree: conflicted paths only, [] when clean, undefined when git fails', async () => {
  const r = await repo();
  try {
    const env = identity;
    await r.put('README', 'x\n'); await r.put('k.txt', 'k\n'); await r.put('j.txt', 'j\n'); const base = await r.commit();
    await git(r.cwd, ['checkout', '-qb', 'side'], { env });
    await r.put('k.txt', 'side\n'); await r.put('j.txt', 'side j\n'); await r.put('new.txt', 'n\n'); const side = await r.commit();
    await git(r.cwd, ['checkout', '-q', 'main'], { env });
    await r.put('k.txt', 'main\n'); const moved = await r.commit();
    const conflicts = NEW.run.rebaseConflicts as (cwd: string, base: string, commit: string) => Promise<string[] | undefined>;
    assert.deepEqual(await conflicts(r.cwd, moved, side), ['k.txt']);
    assert.deepEqual(await conflicts(r.cwd, base, side), []);
    assert.equal(await conflicts(r.cwd, moved, 'f'.repeat(40)), undefined);
  } finally { await r.cleanup(); }
});

// ---------- G3.6: a follow-up forwarded into running work is not a new generation ----------
async function genRig(nodeSpec: object) {
  const r = await repo();
  const dir = join(r.root, 'dsa'), bin = join(r.root, 'bin'), agents = join(dir, 'agents');
  await mkdir(agents, { recursive: true }); await mkdir(bin);
  await writeFile(join(bin, 'owed'), `#!/bin/sh\nexec "${process.execPath}" "${OWED}" "$@"\n`); await chmod(join(bin, 'owed'), 0o755);
  const env = { FAKE_DSA_DIR: dir, PATH: `${bin}:${process.env.PATH}`, ...identity };
  const plan = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: [nodeSpec] };
  await r.put('README', 'x\n'); await r.commit();
  await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'pi' }, channel: 'delegated', plan: JSON.stringify(plan) });
  const entries = async (): Promise<Entry[]> => (await Ledger.open(r.cwd)).read();
  const fake = async () => JSON.parse(await readFile(join(dir, 'state.json'), 'utf8'));
  const lines: string[] = [];
  const driver = (dsa: Dsa) => new run.Driver({ cwd: r.cwd, log: (l: string) => lines.push(l), dsa, session: null });
  /**
   * Passes of one driver process (its generation facts persist) until `until` holds; at most n. K6 (0.7.0): a pass
   * starts attests and merges in the background; each pass here then waits for them (`settle`), as `--once` does.
   */
  const passes = async (d: run.Driver, until: (es: Entry[]) => boolean, n = 10) => { for (let i = 0; i < n && !until(await entries()); i++) { await d.pass(); await d.settle(); } return entries(); };
  return { ...r, dir, agents, env, entries, fake, lines, driver, passes };
}
const sendsOf = (es: Entry[], reason?: string) => es.filter((e): e is SendEntry => e.kind === 'send' && (!reason || e.reason === reason));

test('G3.6 regression (wais #283): a repair forwarded into the running writer (no generation) does not hide its seal; row 8 sends the rebase follow-up', { timeout: 300_000 }, async () => {
  const f = await genRig({ id: 'k', writes: ['k.txt'], checks: [{ id: 'good', run: 'grep -q good k.txt', reads: ['k.txt'] }], review: { count: 0, min_rank: 1 } });
  try {
    await writeFile(join(f.agents, 'k-writer-1.sh'), 'set -e\necho bad > k.txt; git add k.txt; git commit -qm bad; owed submit k\necho RUNNING\n');
    await writeFile(join(f.dir, 'forward-follow-up'), '');
    const d = f.driver(new Dsa({ bin: FAKE, env: f.env, timeoutMs: 120_000 }));
    let es = await f.passes(d, x => sendsOf(x, 'repair').length > 0);
    const repair = sendsOf(es, 'repair')[0];
    assert.ok(repair, f.lines.join('\n'));
    let st = (await f.fake()).runs[repair.rid];
    assert.equal(st.state, 'running'); assert.equal(st.gen, 1, 'forwarded into generation 1');
    assert.equal(st.forwards.length, 1);
    // The writer (still generation 1) fixes, resubmits and its call seals at generation 1.
    const wt = (await ops.status({ cwd: f.cwd })).nodes.k!.slot!.worktree;
    await writeFile(join(wt, 'k.txt'), 'good\n');
    await git(wt, ['add', 'k.txt'], { env: identity }); await git(wt, ['commit', '-qm', 'good'], { env: identity });
    await new Promise<void>((resolve, reject) => execFile(process.execPath, [OWED, 'submit', 'k'], { cwd: wt, env: { ...process.env, ...identity } }, e => e ? reject(e) : resolve()));
    const p = join(f.dir, 'state.json'), raw = JSON.parse(await readFile(p, 'utf8'));
    Object.assign(raw.runs[repair.rid], { state: 'sealed', status: 'ok' }); await writeFile(p, JSON.stringify(raw));
    // Trunk moves with a conflicting k.txt (adopted), so the merge is refused and the driver rebases.
    await f.put('k.txt', 'trunk\n'); await f.commit();
    await ops.adopt({ cwd: f.cwd, as: { role: 'owner', id: 'pi' }, channel: 'delegated', note: 'conflicting trunk change' });
    es = await f.passes(d, x => sendsOf(x, 'rebase').length > 0);
    assert.ok(es.some(e => e.kind === 'rebase'), f.lines.join('\n'));
    const rebase = sendsOf(es, 'rebase')[0];
    assert.ok(rebase, `the sealed writer gets the rebase follow-up:\n${f.lines.join('\n')}`);
    assert.equal(es.filter(e => e.kind === 'halt').length, 0, f.lines.join('\n'));
    // G3.7 through the executor: the follow-up names the conflicting file.
    const text = await readFile(join(f.dir, 'messages', rebase.send), 'utf8');
    assert.match(text, /\(files that conflict with your previous candidate: k\.txt\)/, text);
    st = (await f.fake()).runs[repair.rid];
    assert.equal(st.gen, 2, 'the rebase follow-up to the sealed call opened generation 2');
  } finally { await f.cleanup(); }
});

test('G3.6: a follow-up to a sealed call without a generation in the reply still waits for generation g+1', { timeout: 300_000 }, async () => {
  const f = await genRig({ id: 'm', writes: ['m.txt'], checks: [], review: { count: 0, min_rank: 1 } });
  try {
    await writeFile(join(f.agents, 'm-writer-1.sh'), 'set -e\necho m > m.txt; git add m.txt; git commit -qm m\necho "STATUS: unknown"\n');
    await writeFile(join(f.agents, 'm-writer-2.sh'), 'owed submit m\n');
    await writeFile(join(f.dir, 'stale-describe'), '3');
    /** A dsa whose replies omit `generation` (as for a forwarded follow-up). */
    class NoGeneration extends Dsa {
      override async send(...args: Parameters<Dsa['send']>): ReturnType<Dsa['send']> {
        const r = await super.send(...args);
        if (r.outcome === 'applied') delete (r as { generation?: number }).generation;
        return r;
      }
    }
    const d = f.driver(new NoGeneration({ bin: FAKE, env: f.env, timeoutMs: 120_000 }));
    const es = await f.passes(d, x => x.some(e => e.kind === 'merge'), 12);
    assert.ok(es.some(e => e.kind === 'merge'), f.lines.join('\n'));
    assert.deepEqual(sendsOf(es).map(x => x.reason), ['interrupted'], `the stale sealed views of generation 1 are not answered again:\n${f.lines.join('\n')}`);
    assert.equal(es.filter(e => e.kind === 'halt').length, 0);
  } finally { await f.cleanup(); }
});

// ---------- review #680 (a): row 8 halts first on an unruled needs-parent block (the reviewer's probes) ----------
const mixed = () => {
  const r = rig(); r.dispatch(); r.launchWriter(); r.submit(); r.pass();
  r.review('block', { by: 'reviewer:human', note: 'ordinary' });
  const np = r.review('block', { by: 'reviewer:other', needs: 'parent', note: 'which contract?' });
  return { r, np };
};
const needsHalt = (np: Entry) => `review block #${np.seq} review needs a parent ruling: which contract?; record \`owed rule --nodes a "<decision>"\`; the writer gets the ruling with the next repair`;

test('#680 (a) probe: ordinary + unruled needs-parent block, plan update before the next pass → row 8 halts needing the ruling, no repair', () => {
  const { r, np } = mixed();
  assert.equal(what(act(r, runsOf(sealed(W())))), 'halt', 'with the candidate: the D18 halt');
  r.plan(nodeA({ checks: [unit, { id: 'pose', run: 'x', timeout_s: 60, reads: ['a/**'] }] }));
  assert.equal(r.state().nodes.a!.candidate, undefined);
  const a = act(r, runsOf(sealed(W())));
  assert.deepEqual(a, { do: 'halt', node: 'a', attempt: 1, reason: needsHalt(np), needs: 'human' });
  // The ruling clears the halt: then one repair carrying it and both blocks, never a reviewer run.
  r.recordHalt(a); const ru = r.rule('contract X');
  const f = act(r, runsOf(sealed(W())));
  assert.ok(f?.do === 'send' && f.reason === 'repair' && f.rulings === ru.seq, JSON.stringify(f));
  assert.match(f.message, /ordinary[\s\S]*which contract\?/);
  assert.match(f.message, new RegExp(`ruling #${ru.seq}`));
});

test('#680 (a) probe: halt recorded, then owner `owed rebase` (clears the halt) → row 8 halts again, no rebase or repair follow-up', () => {
  const { r, np } = mixed();
  r.recordHalt(act(r, runsOf(sealed(W()))));
  r.add({ kind: 'adopt', by: 'owner:human', channel: 'tty', trunk: 'main', prior: 's0', commit: 's1', state: { commit: 's1', tree: 't1', invKeys: {} }, changed: ['x'], commits: 1, note: 'moved' });
  r.add({ kind: 'rebase', by: 'owner:pi', channel: 'delegated', node: 'a', attempt: 1, base: 's1', from: 's0' } as Draft);
  assert.equal(r.state().nodes.a!.candidate, undefined);
  assert.deepEqual(act(r, runsOf(sealed(W())), { conflicts: new Map([['a', ['a/x']]]) }), { do: 'halt', node: 'a', attempt: 1, reason: needsHalt(np), needs: 'human' });
  assert.equal(r.state().nodes.a!.runs[0]!.sends.length, 0, 'nothing was sent to the writer');
  // A `*` ruling does not answer it (D18); a node-named ruling does: one repair with the rebase instructions.
  r.recordHalt(act(r, runsOf(sealed(W()))));
  r.add({ kind: 'rule', by: 'parent:main', text: 'general', nodes: '*' });
  r.rule('contract X');
  const f = act(r, runsOf(sealed(W())), { conflicts: new Map([['a', ['a/x']]]) });
  assert.ok(f?.do === 'send' && f.reason === 'repair' && /git rebase --onto s1 s0` \(files that conflict with your previous candidate: a\/x\)/.test(f.message), JSON.stringify(f));
});

// ---------- review #680 (b): the conflict list only when row 8 can use it; -z ----------
test('#680 (b): wantsRebaseConflicts holds only for a rebased slot without a candidate, writer sealed ok, no rebase/repair follow-up since', () => {
  const wants = NEW.drv.wantsRebaseConflicts as (s: State, node: string, runs: Map<string, RunView>) => boolean;
  const r = rig(); r.dispatch(); r.launchWriter(); r.submit(); r.pass();
  assert.equal(wants(r.state(), 'a', runsOf(sealed(W()))), false, 'not rebased');
  r.add({ kind: 'adopt', by: 'owner:human', channel: 'tty', trunk: 'main', prior: 's0', commit: 's1', state: { commit: 's1', tree: 't1', invKeys: {} }, changed: ['x'], commits: 1, note: 'moved' });
  r.add({ kind: 'rebase', by: 'parent:drive', node: 'a', attempt: 1, base: 's1', from: 's0' });
  assert.equal(wants(r.state(), 'a', runsOf(sealed(W()))), true);
  assert.equal(wants(r.state(), 'a', runsOf(view(W(), 'running'))), false, 'writer still running');
  assert.equal(wants(r.state(), 'a', runsOf(view(W(), 'sealed', { status: 'failed' }))), false, 'writer sealed non-ok');
  assert.equal(wants(r.state(), 'a', runsOf()), false, 'no view');
  r.record(act(r, runsOf(sealed(W()))));
  assert.equal(wants(r.state(), 'a', runsOf(sealed(W()))), false, 'rebase follow-up already sent');
  // Submitted after the rebase, then a plan change invalidates that candidate: the rebase predates the last submit.
  r.submit('2');
  r.plan(nodeA({ checks: [unit, { id: 'pose', run: 'x', timeout_s: 60, reads: ['a/**'] }] }));
  assert.equal(r.state().nodes.a!.candidate, undefined);
  assert.equal(wants(r.state(), 'a', runsOf(sealed(W()))), false, 'rebase before the latest submit');
});

test('#680 (b): rebaseConflicts uses -z: a non-ASCII or spaced path is listed verbatim', async () => {
  const r = await repo();
  try {
    const name = 'dír/a b"c.txt';
    await r.put('README', 'x\n'); await r.put(name, 'k\n'); await r.commit();
    await git(r.cwd, ['checkout', '-qb', 'side'], { env: identity });
    await r.put(name, 'side\n'); const side = await r.commit();
    await git(r.cwd, ['checkout', '-q', 'main'], { env: identity });
    await r.put(name, 'main\n'); const moved = await r.commit();
    const conflicts = NEW.run.rebaseConflicts as (cwd: string, base: string, commit: string) => Promise<string[] | undefined>;
    assert.deepEqual(await conflicts(r.cwd, moved, side), [name]);
  } finally { await r.cleanup(); }
});

// ---------- bind G1.3: the approve/evidence halt names the open candidate ----------
test('manualHalt: the approve and evidence commands carry --candidate <commit12> of the open candidate', () => {
  const r = rig(nodeA({ checks: [], review: { count: 0, min_rank: 1 }, approve: 'owner', evidence: [{ id: 'ui', what: 'looked at the page', by: 'reviewer' }] } as Partial<NodeSpec>));
  r.dispatch(); r.launchWriter();
  const long = 'abcdef0123456789abcdef0123456789abcdef01';
  const spec = r.state().plan.nodes[0]!;
  r.add({ kind: 'submit', by: 'writer:a#1', node: 'a', attempt: 1, facts: { commit: long, tree: 't', base: 's0', patch: 'p', changed: ['a/x'], closureTouched: false, keys: { writes: 'k-writes', rulings: 'k-rulings', ...manualKeys(spec, 'p') } } });
  r.pass();
  const h = drv.manualHalt(r.state(), 'a');
  assert.ok(h, JSON.stringify(r.state().nodes.a!.items));
  assert.equal(h.reason, `awaiting owner approval of candidate ${long.slice(0, 12)}: owed approve a --candidate ${long.slice(0, 12)} [--note TEXT] (owner); awaiting manual evidence evidence:ui (looked at the page) by reviewer: owed evidence a ui --file <path> --note "<what was checked>" --as reviewer:<id> --candidate ${long.slice(0, 12)}`);
  assert.equal(h.needs, 'owner');
});
