// L1 (contract 0.8, wais #16-#18): `owed resume` clears a driver halt without an obligation, starts a new repair epoch
// and can make the node wait for another node to merge; halts and wakes name the dsa call address; hints.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { sha256 } from '../src/canon.ts';
import { decide, repairEpoch, type Action, type DriveOpts } from '../src/drive.ts';
import { reduce, resumeOf, runId, validateDraft, waitingFor } from '../src/reducer.ts';
import { Dsa, toRunView, type RunResult } from '../src/dsa.ts';
import { renderEntry, renderReceipt, renderStatus, receipt, statusView } from '../src/views.ts';
import { Driver, driveOnce, reportText } from '../src/drive-run.ts';
import { askingText } from '../src/drive.ts';
import { Follower, classifyLine, haltHintText } from '../src/drive-bg.ts';
import owed from '../src/extension.ts';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import type { CandidateFacts, CheckSpec, Draft, Entry, NodeSpec, Plan, RunView, State } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

// ---------- synthetic ledger rig (no git), as in repair-epoch.test.ts; node a, and node b that a may wait for ----------
const P = 'hash0';
const W = runId(P, 'a', 1, 'writer');
const T0 = Date.UTC(2026, 0, 1);
const iso = (seq: number) => new Date(T0 + seq * 1000).toISOString();
const check = (o: Partial<CheckSpec> & { id: string }): CheckSpec => ({ run: 'npm test', timeout_s: 60, reads: ['a/**'], ...o });
const spec = (o: Partial<NodeSpec> & { id: string }): NodeSpec => ({ deps: [], writes: [`${o.id}/`], checks: [], review: { count: 0, min_rank: 1 }, ...o });
const A0 = spec({ id: 'a', checks: [check({ id: 'unit' })] });
const PLAN: Plan = { version: 1, trunk: 'main', closure: ['closure/'], invariants: [], drive: { max: 4, repairs: 2, writer: { agent: 'worker' }, reviewer: { agent: 'reviewer' } }, nodes: [A0, spec({ id: 'b' })] };
const MERGED = 'c0ffee'.padEnd(40, '0');

function rig() {
  const entries: Entry[] = [], blobs = new Map<string, string>();
  const state = (): State => reduce(entries, () => PLAN);
  const add = (d: Draft): Entry => { const seq = entries.length, e = { ...d, seq, ts: iso(seq), prev: 'x', hash: `hash${seq}` } as Entry; entries.push(e); state(); return e; };
  const blob = (text: string): string => { const h = sha256(text); blobs.set(h, text); return h; };
  add({ kind: 'genesis', by: 'owner:human', channel: 'tty', plan: 'p', trunk: 'main', commit: 's0', state: { commit: 's0', tree: 't0', invKeys: {} } });
  let tags = 0;
  const r = {
    entries, blobs, state, add,
    dispatch(node = 'a') { return add({ kind: 'dispatch', by: 'parent:drive', node, attempt: 1, base: 's0', branch: `owed/${node}/1`, worktree: `/repo/.owed/wt/${node}-1`, packet: 'blob', rulings_seen: -1 }); },
    record(x: Action | undefined): Entry {
      if (x?.do === 'launch') return add({ kind: 'launch', by: 'parent:drive', node: x.node, attempt: x.attempt, role: x.role, rid: x.rid, spec: blob(x.spec), labels: x.labels, ...(x.rulings !== undefined ? { rulings: x.rulings } : {}) });
      assert.ok(x?.do === 'send', `a send: ${JSON.stringify(x)}`);
      return add({ kind: 'send', by: 'parent:drive', node: x.node, attempt: x.attempt, rid: x.rid, send: `${x.rid}:${x.sendKind}:${entries.length}`, sendKind: x.sendKind, message: blob(x.message), reason: x.reason, ...(x.rulings !== undefined ? { rulings: x.rulings } : {}) });
    },
    halt(x: Action | undefined) { assert.ok(x?.do === 'halt', `a halt: ${JSON.stringify(x)}`); return add({ kind: 'halt', by: 'parent:drive', node: x.node, attempt: x.attempt, reason: x.reason, needs: x.needs }); },
    submit(node = 'a') {
      const tag = String(++tags), n = PLAN.nodes.find(x => x.id === node)!;
      const obligations = [...n.checks.map(c => `check:${c.id}`), 'writes', 'rulings'];
      const facts: CandidateFacts = { commit: `${node}c${tag}`, tree: `t${tag}`, base: 's0', patch: `p${tag}`, changed: [`${node}/x`], closureTouched: false, keys: Object.fromEntries(obligations.map(o => [o, `${node}-${o}-${tag}`])) };
      const e = add({ kind: 'submit', by: `writer:${node}#1`, node, attempt: 1, facts });
      // The attribution reruns of earlier failures reproduce them (rows 9-10), so only the new candidate's failures block.
      for (const b of state().nodes[node]!.blocks.filter(b => b.kind === 'exec' && b.state === 'active')) {
        const o = entries.find(x => x.seq === b.seq) as Extract<Entry, { kind: 'obs' }>;
        add({ kind: 'obs', by: 'executor:owed', subject: node, obligation: b.obligation, key: b.key, verdict: 'fail', exit: 1, durationMs: 1, commit: o.commit, base: o.base, attribution: true });
      }
      return e;
    },
    obs(obligation: string, verdict: 'pass' | 'fail' | 'error', node = 'a', note?: string) {
      const c = state().nodes[node]!.candidate!;
      return add({ kind: 'obs', by: 'executor:owed', subject: node, obligation, key: c.keys[obligation]!, verdict, exit: verdict === 'pass' ? 0 : verdict === 'fail' ? 1 : null, ...(note ? { note } : {}), durationMs: 1, commit: c.commit, base: c.base });
    },
    pass(node = 'a', ...except: string[]) { for (const o of state().nodes[node]!.items.map(i => i.obligation).filter(o => (o === 'writes' || o.startsWith('check:')) && !except.includes(o))) r.obs(o, 'pass', node); },
    resume(o: { after?: string; note?: string; by?: string } = {}) { return add({ kind: 'resume', by: o.by ?? 'parent:main', node: 'a', attempt: 1, ...(o.after !== undefined ? { after: o.after } : {}), ...(o.note !== undefined ? { note: o.note } : {}) }); },
    /** Node b: dispatched, submitted, measured, merged (as executor:owed) into commit MERGED. */
    mergeB() {
      r.dispatch('b'); r.submit('b'); r.pass('b');
      const c = state().nodes.b!.candidate!;
      const facts: CandidateFacts = { ...c, commit: MERGED, tree: 'tm', keys: { ...c.keys, writes: 'b-writes-merge' } };
      delete (facts as Partial<typeof c>).seq;
      return add({ kind: 'merge', by: 'executor:owed', node: 'b', attempt: 1, prior: 's0', commit: MERGED, facts, state: { commit: MERGED, tree: 'tm', invKeys: {} } });
    },
  };
  return r;
}
type Rig = ReturnType<typeof rig>;
const view = (rid: string, state: RunView['state'], extra: Partial<RunView> = {}): [string, RunView] => [rid, { rid, state, ...extra }];
const sealed = (extra: Partial<RunView> = {}) => new Map([view(W, 'sealed', { status: 'ok', ...extra })]);
const optsOf = (r: Rig, o: Partial<DriveOpts> = {}): DriveOpts => ({ max: 4, repairs: 2, project: P, root: '/repo', applied: new Set(r.entries.flatMap(e => e.kind === 'send' ? [e.send] : [])), rejected: new Map(), blobs: r.blobs, ...o });
function act(r: Rig, runs: Map<string, RunView> = sealed(), o: Partial<DriveOpts> = {}): Action | undefined {
  const s = r.state(), mine = decide(s, s.plan, runs, optsOf(r, o)).filter(x => x.node === 'a');
  assert.ok(mine.length <= 1, `at most one action per node: ${JSON.stringify(mine)}`);
  return mine[0];
}
/** Dispatched and the writer launched. */
function started(): Rig { const r = rig(); r.dispatch(); r.record(act(r, new Map())); return r; }
const isSend = (x: Action | undefined, reason: string): x is Extract<Action, { do: 'send' }> => x?.do === 'send' && x.reason === reason;
const draft = (o: Record<string, unknown> = {}): Draft => ({ kind: 'resume', by: 'parent:main', node: 'a', attempt: 1, ...o }) as unknown as Draft;

// ---------- L1.1 / L1.6: validation ----------
test('L1.1/L1.6: resume is parent or owner only, needs an open slot of the attempt, a known other after, and strict fields', () => {
  const r = rig();
  assert.match(validateDraft(r.state(), draft()).join('; '), /resume requires an open slot of a/);
  r.dispatch();
  const s = r.state();
  assert.deepEqual(validateDraft(s, draft()), []);
  assert.deepEqual(validateDraft(s, draft({ by: 'owner:human', channel: 'delegated', after: 'b', note: 'wait for b' })), []);
  for (const by of ['writer:a#1', 'reviewer:x', 'executor:owed']) assert.match(validateDraft(s, draft({ by })).join('; '), /resume insufficient permissions; requires parent\/owner/, by);
  assert.match(validateDraft(s, draft({ by: 'parent:drive' })).join('; '), /resume by parent:drive/);
  assert.match(validateDraft(s, draft({ attempt: 2 })).join('; '), /attempt must match the current open writer slot/);
  assert.match(validateDraft(s, draft({ after: 'zz' })).join('; '), /resume after names an unknown node: zz/);
  assert.match(validateDraft(s, draft({ after: 'a' })).join('; '), /resume after must name another node, not the node itself/);
  assert.match(validateDraft(s, draft({ note: 5 })).join('; '), /resume note must be a string/);
  assert.match(validateDraft(s, draft({ rulings: 3 })).join('; '), /resume has unknown fields: rulings/);
  // Replay refuses an invalid recorded resume as well.
  const bad = [...r.entries, { ...draft({ by: 'writer:a#1' }), seq: r.entries.length, ts: iso(9), prev: 'x', hash: 'h' } as Entry];
  assert.throws(() => reduce(bad, () => PLAN), /insufficient permissions/);
});

// ---------- L1.2: effects ----------
test('L1.2 (#18): a resume clears the halt and adds no obligation; it starts a new repair epoch; a ruling instead adds one', () => {
  const r = started();
  r.submit(); r.pass();
  assert.equal(r.state().nodes.a!.accepted, true);
  // The driver's merge was refused for an environmental reason and it halted.
  const merge = act(r);
  assert.deepEqual(merge, { do: 'merge', node: 'a' });
  r.halt(act(r, sealed(), { merges: new Map([['a', { candidate: r.state().nodes.a!.candidate!.seq, reason: 'disk full' }]]) }));
  assert.ok(r.state().nodes.a!.halt, 'halted');
  assert.equal(act(r), undefined);
  const before = r.state().nodes.a!;
  const res = r.resume({ note: 'measure again' });
  const after = r.state().nodes.a!;
  assert.equal(after.halt, undefined, 'clearsHalt: any non-driver entry on the node');
  assert.deepEqual(after.items, before.items, 'no item changed (rulings included)');
  assert.equal(after.items.find(i => i.obligation === 'rulings')!.status, 'E');
  assert.equal(after.accepted, true);
  assert.deepEqual(resumeOf(r.state(), 'a')?.seq, res.seq);
  assert.deepEqual(repairEpoch(r.state(), 'a'), { seq: res.seq, label: `resume #${res.seq}` });
  // The driver retries the merge on its next pass.
  assert.deepEqual(act(r), { do: 'merge', node: 'a' });
  // A ruling naming the node would have added an acknowledgment obligation (the 0.7 way, wais #18).
  r.add({ kind: 'rule', by: 'parent:main', text: 'measure again', nodes: ['a'] });
  assert.equal(r.state().nodes.a!.items.find(i => i.obligation === 'rulings')!.status, 'D');
  assert.equal(r.state().nodes.a!.accepted, false);
});

test('L1.3: after a resume a sealed writer gets a fresh repair that starts with the resume line; the budget starts again', () => {
  const r = started();
  const fail = () => { r.submit(); r.obs('check:unit', 'fail', 'a', 'boom'); r.pass('a', 'check:unit'); };
  fail();
  const rep1 = act(r); assert.ok(isSend(rep1, 'repair'), JSON.stringify(rep1)); r.record(rep1);
  const h1 = act(r);
  assert.ok(h1?.do === 'halt' && h1.reason.startsWith(`writer run ${W} finished repair follow-up`), JSON.stringify(h1));
  r.halt(h1);
  const res = r.resume({ note: 'measure again\nplease' });
  const rep2 = act(r);
  assert.ok(isSend(rep2, 'repair'), JSON.stringify(rep2));
  assert.ok(rep2.message.startsWith(`The parent resumed this node (#${res.seq}): measure again\\nplease\nowed found problems with your candidate`), rep2.message);
  r.record(rep2);
  // Only the first writer follow-up after the resume carries the line.
  fail();
  const rep3 = act(r); assert.ok(isSend(rep3, 'repair'), JSON.stringify(rep3));
  assert.ok(!rep3.message.includes('The parent resumed'), rep3.message);
  r.record(rep3);
  // Two repairs since the resume: exhausted, named by the resume.
  fail();
  const ex = act(r);
  assert.ok(ex?.do === 'halt' && ex.reason.startsWith(`repairs exhausted (2 of 2 since resume #${res.seq})`), JSON.stringify(ex));
  r.halt(ex);
  // A second resume: the budget starts again; no note, no colon.
  const res2 = r.resume();
  const rep4 = act(r);
  assert.ok(isSend(rep4, 'repair') && rep4.message.startsWith(`The parent resumed this node (#${res2.seq})\nowed found`), JSON.stringify(rep4));
});

test('L1.3: a resume lets the driver attest again after two errors, and nudge a writer that finished without submitting', () => {
  const r = started();
  // Row 8: submit follow-up, then the writer finishes without a candidate: halt; resume: a fresh submit follow-up.
  const sub = act(r); assert.ok(isSend(sub, 'submit'), JSON.stringify(sub)); r.record(sub);
  const h = act(r); assert.ok(h?.do === 'halt' && /finished without submitting a candidate/.test(h.reason), JSON.stringify(h)); r.halt(h);
  const res = r.resume({ note: 'try again' });
  const sub2 = act(r);
  assert.ok(isSend(sub2, 'submit') && sub2.message === `The parent resumed this node (#${res.seq}): try again\ncommit your work and run \`owed submit a\``, JSON.stringify(sub2));
  r.record(sub2);
  // Rows 9-10: errors twice halt; after a resume the attest runs again.
  r.submit(); r.obs('writes', 'pass'); r.obs('check:unit', 'error'); r.obs('check:unit', 'error');
  const h2 = act(r); assert.ok(h2?.do === 'halt' && h2.reason.startsWith('attest recorded no verdict twice'), JSON.stringify(h2)); r.halt(h2);
  r.resume({ note: 'environment fixed' });
  assert.deepEqual(act(r), { do: 'attest', node: 'a' });
});

// ---------- L1.2 / L1.3: waiting ----------
test('L1.2/L1.3 (#17): resume --after b makes a wait (no action but asking notices) until b merges; then the first follow-up names the merge', () => {
  const r = started();
  const sub = act(r); assert.ok(isSend(sub, 'submit')); r.record(sub);
  r.halt(act(r));
  const w1 = r.resume({ after: 'b', note: 'wait for b' });
  assert.deepEqual(waitingFor(r.state(), 'a'), { after: 'b', resume: w1.seq });
  assert.equal(r.state().nodes.a!.halt, undefined);
  assert.equal(act(r), undefined, 'waiting: no halt, no send');
  assert.equal(act(r, new Map([view(W, 'running', { lastFence: { reason: 'crash', at: T0 + 1e9 } })])), undefined, 'not even a fenced steer');
  const ask = act(r, new Map([view(W, 'asking', { questions: [{ qid: 'q1', rev: 1, question: 'which?', to: 'w7/tasks:0' }] })]));
  assert.ok(ask?.do === 'notify' && ask.rid === W && ask.qid === 'q1' && ask.text.includes('to:"w7/tasks:0"'), JSON.stringify(ask));
  // Views: why and status.
  const s = r.state();
  assert.match(renderReceipt(receipt(s, r.entries, 'a')), new RegExp(`\\n⏳ waiting for b \\(resume #${w1.seq}\\)`));
  assert.deepEqual(statusView(s, r.entries).waiting, [{ node: 'a', after: 'b', resume: w1.seq }]);
  assert.match(renderStatus(statusView(s, r.entries)), new RegExp(`\\nWaiting \\(resume\\):\\n⏳ a: waiting for b \\(resume #${w1.seq}\\)`));
  // A later resume without after ends the wait; a later one with after waits again (the latest replaces).
  const go = r.resume({ note: 'go now' });
  assert.equal(waitingFor(r.state(), 'a'), undefined);
  const now = act(r);
  assert.ok(isSend(now, 'submit') && now.message.startsWith(`The parent resumed this node (#${go.seq}): go now\n`), JSON.stringify(now));
  const w2 = r.resume({ after: 'b', note: 'wait for b after all' });
  assert.deepEqual(waitingFor(r.state(), 'a'), { after: 'b', resume: w2.seq });
  assert.equal(act(r), undefined);
  // b merges: the wait ends and the driver uses its normal rows; the first writer follow-up names the merge.
  r.mergeB();
  assert.equal(waitingFor(r.state(), 'a'), undefined);
  const woke = act(r);
  assert.ok(isSend(woke, 'submit'), JSON.stringify(woke));
  assert.equal(woke.message, `The parent resumed this node (#${w2.seq}) after b merged at ${MERGED.slice(0, 12)}: wait for b after all\ncommit your work and run \`owed submit a\``);
  // An abandon ends a wait as well.
  const r2 = started();
  r2.resume({ after: 'b' });
  assert.ok(waitingFor(r2.state(), 'a'));
  r2.add({ kind: 'abandon', by: 'parent:main', node: 'a', attempt: 1, reason: 'x' });
  assert.equal(waitingFor(r2.state(), 'a'), undefined);
  assert.equal(resumeOf(r2.state(), 'a'), undefined);
});

// ---------- L1.4: call address ----------
test('L1.4 (#16): describe reports the call address <wid>/<key>; halts naming a run carry to:"…" when it is known', () => {
  assert.equal(toRunView('r', { state: 'sealed', status: 'failed', wid: 'w7', calls: [{ key: 'tasks:0', status: 'ok' }, { key: 'tasks:1', status: 'failed' }] }).to, 'w7/tasks:1');
  assert.equal(toRunView('r', { state: 'running', wid: 'w7', calls: [{ status: 'running' }] }).to, undefined, 'no key');
  assert.equal(toRunView('r', { state: 'running', calls: [{ key: 'tasks:0' }] }).to, undefined, 'no wid: never a bare key');
  assert.equal('to' in toRunView('r', { state: 'running', wid: 'w7' }), false, 'no calls: no to, never a bare wid');
  const r = started();
  const bad = act(r, sealed({ status: 'failed', error: 'boom', to: 'w7/tasks:0' }));
  assert.ok(bad?.do === 'halt', JSON.stringify(bad));
  assert.equal(bad.reason, `writer run ${W} (to:"w7/tasks:0") sealed failed: boom`);
  const plain = act(r, sealed({ status: 'failed', error: 'boom' }));
  assert.ok(plain?.do === 'halt' && plain.reason === `writer run ${W} sealed failed: boom`, JSON.stringify(plain));
  r.record(act(r, sealed({ to: 'w7/tasks:0' })));
  const fin = act(r, sealed({ to: 'w7/tasks:0' }));
  assert.ok(fin?.do === 'halt' && fin.reason.startsWith(`writer run ${W} (to:"w7/tasks:0") finished without submitting a candidate`), JSON.stringify(fin));
  // An asking notice without a question address falls back to the run's call address.
  const ask = act(r, new Map([view(W, 'asking', { to: 'w7/tasks:0', questions: [{ qid: 'q', rev: 1, question: '?' }] })]));
  assert.ok(ask?.do === 'notify' && ask.text.includes('to:"w7/tasks:0"') && ask.text.includes('--to w7/tasks:0'), JSON.stringify(ask));
  // Review #886 F2: an asking run without a reported question also gives the call address (and only when known).
  const l = r.entries.find(e => e.kind === 'launch')! as Extract<Entry, { kind: 'launch' }>;
  assert.equal(askingText('a', l, { rid: W, state: 'asking', to: 'w7/tasks:0' }), `a: writer run ${W} (to:"w7/tasks:0") is asking (no question reported; see pi-durable-subagents describe --key ${W}); the driver never answers`);
  assert.equal(askingText('a', l, { rid: W, state: 'asking', wid: 'w7' }), `a: writer run ${W} is asking (no question reported; see pi-durable-subagents describe --key ${W}); the driver never answers`);
  const bare = act(r, new Map([view(W, 'asking', { to: 'w7/tasks:0' })]));
  assert.ok(bare?.do === 'notify' && bare.text.includes(`${W} (to:"w7/tasks:0") is asking`), JSON.stringify(bare));
});

// ---------- L1.5: hints and notices ----------
test('L1.5: why and status suggest owed resume for a halt; the wake message with a halt carries the hint; waiting loop event text', async () => {
  const r = started();
  r.record(act(r)); r.halt(act(r));
  const s = r.state();
  const why = renderReceipt(receipt(s, r.entries, 'a'));
  assert.match(why, /\n⏸ halted by driver #\d+ .*; cleared by any later action .*; to clear it without an obligation: owed resume a --note "<why>" \(add --after <node> to wait until that node merges\); owed rule gives the writer and reviewers guidance they must acknowledge/);
  assert.match(renderStatus(statusView(s, r.entries)), /\nHalted \(driver\):\n⏸ a: halted by driver #\d+ [^\n]*\n {2}to clear it without an obligation: owed resume <node> --note "<why>"/);
  assert.equal(renderEntry(r.resume({ after: 'b', note: 'n' })), `Recorded #${r.entries.length - 1} parent:main resumed a after b`);
  assert.equal(renderEntry(r.resume({ by: 'owner:pi' })).replace(/#\d+/, '#N'), 'Recorded #N owner:pi resumed a');
  assert.equal(reportText({ event: 'waiting', node: 'a', after: 'b', resume: 7 }), 'waiting: a waits for b (resume #7)');
  assert.equal(classifyLine(JSON.stringify({ event: 'waiting', node: 'a', after: 'b', resume: 7 })).kind, 'quiet', 'never a wake');
  const dir = await mkdtemp(join(tmpdir(), 'owed-resume-'));
  try {
    const log = join(dir, 'log.jsonl');
    await writeFile(log, '');
    const got: string[] = [];
    const f = new Follower({ log, repo: '/r', pid: process.pid, from: 0, deliver: m => { got.push(m); } });
    await writeFile(log, `${JSON.stringify({ do: 'notify', node: 'x', outcome: 'notify', text: 'x asks' })}\n`, { flag: 'a' });
    assert.deepEqual(f.tick()?.split('\n'), ['owed drive (/r):', 'x asks', 'Next: owed status / owed why <node>'], 'no halt: no hint');
    await writeFile(log, `${JSON.stringify({ do: 'halt', node: 'h', outcome: 'halted', attempt: 1, needs: 'human', detail: 'stuck' })}\n`, { flag: 'a' });
    assert.deepEqual(f.tick()?.split('\n'), ['owed drive (/r):', 'halt h attempt 1 (needs human): halted — stuck', haltHintText, 'Next: owed status / owed why <node>']);
    assert.equal(haltHintText, 'To clear a halt without an obligation: owed resume <node> --note "<why>" (add --after <node> to wait until that node merges); owed rule gives the writer and reviewers guidance they must acknowledge');
    f.stop();
  } finally { await rm(dir, { recursive: true, force: true }); }
});

// ---------- L1.1: CLI and pi tool ----------
const parent = { role: 'parent' as const, id: 'main' };
function harness(cwd: string) {
  const tools = new Map<string, ToolDefinition>();
  owed({ registerTool(t: ToolDefinition) { tools.set(t.name, t); }, registerCommand() {} } as unknown as ExtensionAPI);
  const ctx = { cwd, hasUI: false, ui: { async confirm() { return false; }, notify() {} } } as unknown as ExtensionContext;
  return async (name: string, args: Record<string, unknown>) => {
    const t = tools.get(`owed_${name}`);
    assert.ok(t, `tool owed_${name} is registered`);
    const res = await t.execute('test', args, undefined, undefined, ctx as Parameters<ToolDefinition['execute']>[4]) as Awaited<ReturnType<ToolDefinition['execute']>> & { isError?: boolean };
    return { ...res, text: res.content.map(c => c.type === 'text' ? c.text : '').join('\n') };
  };
}
test('L1.1: owed resume (CLI) and owed_resume (pi): refusals, output, --json, waiting status, after already merged', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    await commitAt(r.cwd, { README: 'x\n' });
    const plan = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: [{ id: 'a', writes: ['a/'], checks: [], review: { count: 0, min_rank: 1 } }, { id: 'b', writes: ['b/'], checks: [], review: { count: 0, min_rank: 1 } }] };
    await ops.init({ cwd: r.cwd, plan: JSON.stringify(plan), as: { role: 'owner', id: 'human' }, channel: 'flag' });
    const count = async () => (await (await Ledger.open(r.cwd)).read()).length;
    const none = await cli(r.cwd, ['resume', 'a']);
    assert.equal(none.code, 1, none.stderr); assert.match(none.stderr, /resume requires an open slot of a/);
    await ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' });
    const n0 = await count();
    for (const [args, re] of [[['--after', 'a'], /resume after must name another node/], [['--after', 'zz'], /unknown node: zz/], [['--as', 'writer:a#1'], /insufficient permissions/], [['--as', 'reviewer:x'], /insufficient permissions/], [['--as', 'parent:drive'], /parent:drive is the driver's identity/]] as [string[], RegExp][]) {
      const out = await cli(r.cwd, ['resume', 'a', ...args]);
      assert.equal(out.code, 1, `${args.join(' ')}: ${out.stderr}`); assert.match(out.stderr, re);
    }
    assert.equal(await count(), n0, 'nothing recorded by a refusal');
    const wait = await cli(r.cwd, ['resume', 'a', '--after', 'b', '--note', 'wait for b']);
    assert.equal(wait.code, 0, wait.stderr);
    assert.equal(wait.stdout.trim(), `Recorded #${n0} parent:cli resumed a after b\na waits for b (resume #${n0}); the driver acts again when b merges`);
    const status = await cli(r.cwd, ['status']);
    assert.match(status.stdout, new RegExp(`\\nWaiting \\(resume\\):\\n⏳ a: waiting for b \\(resume #${n0}\\)\\n`));
    assert.match((await cli(r.cwd, ['why', 'a'])).stdout, new RegExp(`\\n⏳ waiting for b \\(resume #${n0}\\)`));
    const json = await cli(r.cwd, ['resume', 'a', '--json']);
    assert.equal(json.code, 0, json.stderr);
    const e = JSON.parse(json.stdout) as Entry;
    assert.deepEqual({ kind: e.kind, by: e.by, node: (e as { node: string }).node, attempt: (e as { attempt: number }).attempt, seq: e.seq }, { kind: 'resume', by: 'parent:cli', node: 'a', attempt: 1, seq: n0 + 1 });
    assert.equal('after' in e || 'note' in e, false, 'only the fields given');
    // pi tool: writers refused; parent:pi records.
    const call = harness(r.cwd);
    const refused = await call('resume', { node: 'a', as: 'writer:a#1' });
    assert.equal(refused.isError, true, refused.text);
    const ok = await call('resume', { node: 'a', note: 'from pi' });
    assert.notEqual(ok.isError, true, ok.text);
    assert.match(ok.text, /^Recorded #\d+ parent:pi resumed a\n/);
    const last = (await (await Ledger.open(r.cwd)).read()).at(-1)!;
    assert.equal(last.kind, 'resume'); assert.equal((last as { note?: string }).note, 'from pi');
    // b merges; a resume after b now says a resumes now.
    const d = await ops.dispatch({ cwd: r.cwd, as: parent, node: 'b' });
    await commitAt(d.worktree, { 'b/x': 'b\n' });
    await ops.submit({ cwd: d.worktree, as: { role: 'writer', id: 'b#1' }, node: 'b' });
    await ops.attest({ cwd: r.cwd, node: 'b' });
    await ops.merge({ cwd: r.cwd, as: parent, node: 'b' });
    const merged = await cli(r.cwd, ['resume', 'a', '--after', 'b']);
    assert.equal(merged.code, 0, merged.stderr);
    assert.match(merged.stdout, /^Recorded #\d+ parent:cli resumed a after b\nb is already merged: a resumes now\n/);
    const pm = await call('resume', { node: 'a', after: 'b' });
    assert.match(pm.text, /\nb is already merged: a resumes now\n/);
  } finally { await r.cleanup(); }
});

// ---------- Review #886: the driver's waiting event, PassResult.waiting; the call address in a run request-conflict halt ----------
/** A git repo with nodes a and b (b depends on a, so the driver never dispatches it); a dispatched. */
async function driverRig() {
  const r = await repo();
  await commitAt(r.cwd, { README: 'x\n' });
  const nodeOf = (id: string, deps: string[] = []) => ({ id, deps, writes: [`${id}/`], checks: [], review: { count: 0, min_rank: 1 } });
  await ops.init({ cwd: r.cwd, plan: JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [], nodes: [nodeOf('a'), nodeOf('b', ['a'])] }), as: { role: 'owner', id: 'human' }, channel: 'flag' });
  await ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' });
  return r;
}
/** A dsa that must not be called (a waiting node gets no launch). */
class NoDsa extends Dsa { constructor() { super({ bin: '/nonexistent/dsa' }); } override async run(_rid: string): Promise<RunResult> { throw new Error('no run expected'); } }
const WAIT = /^waiting: a waits for b \(resume #(\d+)\)$/;

test('review #886 F1: the loop prints the waiting line once per node and resume; PassResult.waiting lists the waiting nodes', { timeout: 120_000 }, async () => {
  const r = await driverRig();
  try {
    const w1 = (await ops.resume({ cwd: r.cwd, as: parent, channel: 'flag', node: 'a', after: 'b', note: 'wait' })).entry;
    const lines: string[] = [];
    const d = new Driver({ cwd: r.cwd, log: l => lines.push(l), dsa: new NoDsa(), session: null, handleSignals: false });
    const p1 = await d.pass();
    assert.deepEqual(p1.waiting, [{ node: 'a', after: 'b', resume: w1.seq }]);
    assert.deepEqual(p1.actions, [], 'no action for a waiting node (b is not ready)');
    const p2 = await d.pass();
    assert.deepEqual(p2.waiting, [{ node: 'a', after: 'b', resume: w1.seq }]);
    assert.deepEqual(lines.filter(l => WAIT.test(l)), [`waiting: a waits for b (resume #${w1.seq})`], `printed once for the same resume: ${lines.join('\n')}`);
    const w2 = (await ops.resume({ cwd: r.cwd, as: parent, channel: 'flag', node: 'a', after: 'b', note: 'still wait' })).entry;
    const p3 = await d.pass();
    assert.deepEqual(p3.waiting, [{ node: 'a', after: 'b', resume: w2.seq }]);
    await d.pass();
    assert.deepEqual(lines.filter(l => WAIT.test(l)), [`waiting: a waits for b (resume #${w1.seq})`, `waiting: a waits for b (resume #${w2.seq})`], 'a new resume prints a new line');
    // --json: the event object.
    const json: string[] = [];
    await new Driver({ cwd: r.cwd, json: true, log: l => json.push(l), dsa: new NoDsa(), session: null, handleSignals: false }).pass();
    assert.deepEqual(json.map(l => JSON.parse(l)).filter(e => e.event === 'waiting'), [{ event: 'waiting', node: 'a', after: 'b', resume: w2.seq }]);
    // A resume without after ends the wait: the list is empty and nothing is printed for a.
    await ops.resume({ cwd: r.cwd, as: parent, channel: 'flag', node: 'a' });
    const quiet: string[] = [];
    const d2 = new Driver({ cwd: r.cwd, log: l => quiet.push(l), dsa: new class extends NoDsa { override async run(rid: string): Promise<RunResult> { return { outcome: 'applied', wid: 'w1', created: true, spec_digest: rid }; } }(), session: null, handleSignals: false });
    assert.deepEqual((await d2.pass()).waiting, []);
    assert.ok(!quiet.some(l => l.startsWith('waiting:')), quiet.join('\n'));
  } finally { await r.cleanup(); }
});

test('review #886 F1: driveOnce (owed_drive, --once) prints the waiting line on every pass', { timeout: 120_000 }, async () => {
  const r = await driverRig();
  try {
    const w = (await ops.resume({ cwd: r.cwd, as: parent, channel: 'flag', node: 'a', after: 'b' })).entry;
    for (let i = 0; i < 2; i++) {
      const out = await driveOnce({ cwd: r.cwd, dsa: new NoDsa(), session: null });
      assert.equal(out.error, undefined, out.error);
      assert.deepEqual(out.lines.filter(l => WAIT.test(l)), [`waiting: a waits for b (resume #${w.seq})`], `pass ${i + 1}: ${out.lines.join('\n')}`);
    }
  } finally { await r.cleanup(); }
});

test('review #886 nit (a): a run request-conflict halt names the call address describe reported earlier', { timeout: 120_000 }, async () => {
  const r = await driverRig();
  try {
    let phase = 0;
    class Scripted extends Dsa {
      constructor() { super({ bin: '/nonexistent/dsa' }); }
      override async run(rid: string): Promise<RunResult> { return phase === 0 ? { outcome: 'applied', wid: 'w9', created: true, spec_digest: rid } : { outcome: 'conflict', state: 'sealed' }; }
      override async inspect(rid: string): Promise<{ view: RunView; gen?: number }> {
        return { view: phase === 1 ? { rid, state: 'running', wid: 'w9', to: 'w9/tasks:0' } : { rid, state: 'absent' } };
      }
    }
    const lines: string[] = [];
    const d = new Driver({ cwd: r.cwd, log: l => lines.push(l), dsa: new Scripted(), session: null, handleSignals: false });
    await d.pass();                    // launches a's writer
    phase = 1; await d.pass();         // describe reports the call address; the writer runs
    phase = 2; await d.pass();         // the run is absent: re-launch, dsa reports a request-conflict
    const halt = (await (await Ledger.open(r.cwd)).read()).findLast(e => e.kind === 'halt') as Extract<Entry, { kind: 'halt' }> | undefined;
    assert.ok(halt, lines.join('\n'));
    assert.match(halt.reason, /^dsa request-conflict on run owed:\S+:a:1:writer \(to:"w9\/tasks:0"\) \(recorded content differs, state sealed\); never retried with other bytes$/);
  } finally { await r.cleanup(); }
});
