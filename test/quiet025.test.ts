// QT1–QT5 (0.25 quiet025): plain wakes, the default why card, short repair follow-ups, the merge line and
// answered-but-still-asking questions.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import { askingText, decide, repairFollowUp, writerLaunch } from '../src/drive.ts';
import { DRIFT_NODE, Driver, procStart } from '../src/drive-run.ts';
import { Follower, lockPath } from '../src/drive-bg.ts';
import { answerRetry } from '../src/answer.ts';
import { clockTime } from '../src/clock.ts';
import { renderStatus } from '../src/views.ts';
import { Ledger } from '../src/ledger.ts';
import { buildMerge, stateFacts } from '../src/git.ts';
import { quarantineNames } from '../src/plan.ts';
import { projectId } from '../src/reducer.ts';
import type { Dsa } from '../src/dsa.ts';
import type { LaunchEntry, RunView } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt, planText, seed, checkTest } from './helpers/surface.ts';

const parent = { role: 'parent' as const, id: 'test' };
const owner = { pid: process.pid, start: procStart(process.pid), at: '2026-10-15T02:00:00Z', host: hostname(), token: 'quiet025' };

/** A node `a` whose writer run asks q1 (rev 2) and keeps asking after the answer. */
async function asking() {
  const r = await repo();
  const plan = JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [], nodes: [{ id: 'a', writes: ['a.txt'], checks: [], review: { count: 0, min_rank: 1 } }] });
  await r.put('plan.json', plan); await r.commit();
  await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'pi' }, channel: 'delegated', plan });
  await ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' });
  const s = (await ops.readState(r)).state, launch = writerLaunch(s, 'a', projectId(s));
  await ops.launch({ cwd: r.cwd, as: parent, node: 'a', attempt: 1, role: 'writer', rid: launch.rid, spec: launch.spec, labels: launch.labels, rulings: launch.rulings });
  const view: RunView = { rid: launch.rid, state: 'asking', questions: [{ qid: 'q1', rev: 2, question: 'Which API?', to: 'w1/main' }] };
  const dsa = { async describe() { return view; }, async inspect() { return { view }; } } as unknown as Dsa;
  const answer = () => ops.answerRule({ cwd: r.cwd, as: parent, node: 'a', text: 'Answer to writer question q1: Use API v2', answer: { rid: view.rid, qid: 'q1', rev: 2 } });
  const dir = (await Ledger.open(r.cwd)).dir;
  return { ...r, view, dsa, answer, dir };
}

/** A real repository: plan with check a; the writer of a submits a failing candidate and owed measures it. */
async function failing() {
  const r = await repo();
  await seed(r.cwd); const plan = join(r.root, 'plan.yaml'); await writeFile(plan, planText);
  const call = async <T>(cwd: string, args: string[], code = 0): Promise<T> => { const out = await cli(cwd, [...args, '--json']); assert.equal(out.code, code, `${args.join(' ')}\n${out.stderr}\n${out.stdout}`); return JSON.parse(out.stdout) as T; };
  await call(r.cwd, ['init', plan]);
  const a = await call<{ worktree: string }>(r.cwd, ['dispatch', 'a']);
  const s = (await ops.readState(r)).state, launch = writerLaunch(s, 'a', projectId(s));
  await ops.launch({ cwd: r.cwd, as: parent, node: 'a', attempt: 1, role: 'writer', rid: launch.rid, spec: launch.spec, labels: launch.labels, rulings: launch.rulings });
  await commitAt(a.worktree, { 'test/a.test.cjs': checkTest('a', 1) });
  await call(a.worktree, ['submit', 'a']); await call(r.cwd, ['attest', 'a'], 1);
  return { ...r, call, worktree: a.worktree, rid: launch.rid };
}

test('QT1: a wake shows one plain line per need, Done for merges, and no raw driver line', async () => {
  const r = await repo();
  try {
    const dir = join(r.root, 'follow'), log = join(dir, 'drive', 'log.jsonl');
    mkdirSync(join(dir, 'drive'), { recursive: true }); writeFileSync(log, '');
    const line = (j: object) => appendFileSync(log, `${JSON.stringify(j)}\n`);
    const f = new Follower({ log, repo: r.cwd, pid: process.pid, start: procStart(process.pid), deliver() {} });
    const ask = { do: 'notify', node: 'a', outcome: 'notify', rid: 'rid-a', qid: 'q1', rev: 1, text: 'a: writer run rid-a asks (qid q1, rev 1): which db? — the driver never answers; answer: owed answer a --rid rid-a --qid q1 "<text>"; in pi: owed_answer {node:"a"}' };
    line({ do: 'merge', node: 'm', outcome: 'merged', detail: 'trunk 1' }); line({ do: 'merge', node: 'n', outcome: 'merged', detail: 'trunk 2' });
    line(ask); line({ do: 'halt', node: 'b', outcome: 'halted', attempt: 1, needs: 'human', detail: 'choose the API', inProgress: 2 });
    const text = f.tick()!, lines = text.split('\n');
    assert.deepEqual(lines.slice(0, 4), ['Needs you: a — decide which db? → owed answer a --rid rid-a --qid q1 "<text>"', 'Needs you: b — choose the API → owed why b', 'Done: m, n', 'Driver continues (2 in progress)'], text);
    assert.ok(!text.includes(ask.text), 'the raw asking line stays in the driver log');
    assert.doesNotMatch(text, /halt b attempt 1|merge m: merged|merge n: merged/, text);
    assert.equal(lines.at(-1), 'Next: owed status / owed why <node>');
  } finally { await r.cleanup(); }
});

test('QT5: an answer recorded 10 minutes ago that the run still asks wakes as answered-but-asking with the exact retry', async () => {
  const f = await asking(), realNow = Date.now;
  try {
    const e = await f.answer(), at = Date.parse(e.ts), s = (await ops.readState(f)).state;
    const act = (now: number) => decide(s, s.plan, new Map([[f.view.rid, f.view]]), { max: 1, repairs: 2, project: projectId(s), root: f.cwd, applied: new Set(), rejected: new Map(), now }).find(a => a.node === 'a');
    const early = act(at + 599_000);
    assert.ok(early?.do === 'notify' && early.quiet, 'before 10 minutes the answer keeps the question quiet');
    const late = act(at + 720_000);
    assert.ok(late?.do === 'notify' && late.answerRetry);
    assert.equal(late.text, `a: answered at #${e.seq} (${clockTime(e.ts, at + 720_000)}), still asking after 12m: retry with ${answerRetry('a', e)}`);
    assert.ok(late.text.includes(`: retry with owed answer 'a' --rid '${f.view.rid}' --qid 'q1'`));
    // Through the driver log and the follower: the wake's Needs-you is that line, not a new open question.
    const log = join(f.dir, 'drive', 'log.jsonl'); mkdirSync(join(f.dir, 'drive'), { recursive: true }); writeFileSync(log, '');
    const follower = new Follower({ log, repo: f.cwd, pid: process.pid, start: procStart(process.pid), deliver() {} });
    Date.now = () => at + 720_000;
    await new Driver({ cwd: f.cwd, dsa: f.dsa, json: true, session: null, log: l => appendFileSync(log, `${l}\n`) }).pass();
    const wake = follower.tick()!;
    assert.equal(wake.split('\n')[0], `Needs you: ${late.text}`, wake);
    assert.doesNotMatch(wake, /Which API|decide /, wake);
  } finally { Date.now = realNow; await f.cleanup(); }
});

test('QT5: status lists the answered-but-asking question while the driver runs, and not after the run resumes', async () => {
  const f = await asking(), realNow = Date.now;
  try {
    const e = await f.answer(), at = Date.parse(e.ts);
    Date.now = () => at + 660_000;
    await new Driver({ cwd: f.cwd, dsa: f.dsa, json: true, session: null, log: () => {} }).pass();
    const want = `  a: answered at #${e.seq} (${clockTime(e.ts, at + 660_000)}), still asking after 11m: retry with ${answerRetry('a', e)}`;
    assert.ok(!renderStatus(await ops.status({ cwd: f.cwd })).includes(want), 'no running driver: no host fact to show');
    writeFileSync(lockPath(f.dir), JSON.stringify(owner));
    const text = renderStatus(await ops.status({ cwd: f.cwd }));
    assert.ok(text.split('\n').includes(want), text);
    assert.match(text, /need you/);
    f.view.state = 'running'; f.view.questions = [];
    await new Driver({ cwd: f.cwd, dsa: f.dsa, json: true, session: null, log: () => {} }).pass();
    assert.ok(!renderStatus(await ops.status({ cwd: f.cwd })).includes('still asking'), 'the run resumed: the line is gone');
  } finally { Date.now = realNow; await f.cleanup(); }
});

test('QT2: why shows the outcome and only what is outstanding by default; --full keeps the whole card; JSON unchanged', { timeout: 120_000 }, async () => {
  const f = await failing();
  try {
    const quiet = (await cli(f.cwd, ['why', 'a'])).stdout.trimEnd(), full = (await cli(f.cwd, ['why', 'a', '--full'])).stdout;
    const lines = quiet.split('\n');
    assert.equal(lines[0], 'a: submitted; 1 outstanding', quiet);
    assert.doesNotMatch(quiet, /conflicts with trunk: none/);
    assert.ok(lines.some(l => /check:a/.test(l) && l.includes('→')), quiet);
    assert.equal(lines.at(-1), 'Details: owed why a --full');
    for (const hidden of [/ΔO⁻/, /Untested changes/, /log=/, /counts=/, /Driver launch/, /✔/, /note #\d+/]) assert.doesNotMatch(quiet, hidden, quiet);
    for (const shown of [/Untested obligations ΔO⁻/, /log=/, /Driver launch/, /✔/]) assert.match(full, shown);
    const json = JSON.parse((await cli(f.cwd, ['why', 'a', '--json'])).stdout) as Record<string, unknown>;
    assert.deepEqual(json, JSON.parse(JSON.stringify(await ops.why({ cwd: f.cwd, node: 'a' }))));
  } finally { await f.cleanup(); }
});

test('QT3: a repair follow-up lists only failures new since the last message to the writer and points to why --full', { timeout: 120_000 }, async () => {
  const f = await failing();
  try {
    const first = repairFollowUp((await ops.readState(f)).state, 'a').message;
    assert.match(first, /Failures new since my last message:\n- check:a: /, first);
    assert.match(first, /owed why a --full/);
    assert.doesNotMatch(first, /card:|Untested obligations|ΔO⁻|Driver launch/, first);
    await ops.send({ cwd: f.cwd, as: parent, node: 'a', attempt: 1, rid: f.rid, sendKind: 'follow-up', reason: 'repair', message: first, rulings: 0 });
    const again = repairFollowUp((await ops.readState(f)).state, 'a').message;
    assert.match(again, /No new failures since my last message\./, again);
    assert.match(again, /Still failing from before: [^\n]*check:a/, again);
    assert.doesNotMatch(again, /- check:a:/, again);
    await commitAt(f.worktree, { 'test/a.test.cjs': checkTest('a', 2) });
    await f.call(f.worktree, ['submit', 'a']); await f.call(f.cwd, ['attest', 'a'], 1);
    const next = repairFollowUp((await ops.readState(f)).state, 'a').message;
    assert.match(next, /Failures new since my last message:\n- check:a: /, next);
    assert.doesNotMatch(next, /Still failing from before: [^\n]*check:a/, next);
  } finally { await f.cleanup(); }
});

test('QT4: merge prints one line with the commit and counts, without seqs or the full trunk hash', { timeout: 120_000 }, async () => {
  const f = await failing();
  try {
    await commitAt(f.worktree, { 'test/a.cjs': 'module.exports=1;' });
    await f.call(f.worktree, ['submit', 'a']); await cli(f.cwd, ['attest', 'a']);   // the attribution rerun of the old fail may exit 1
    { const c = await ops.why({ cwd: f.cwd, node: 'a' }); assert.equal(c.accepted, true, JSON.stringify([c.phase, c.items.map(i => [i.obligation, i.mark, i.detail]), c.blocks])); }
    const out = await cli(f.cwd, ['merge', 'a']);
    assert.equal(out.code, 0, out.stderr);
    const card = await ops.why({ cwd: f.cwd, node: 'a' }), state = (await ops.readState(f)).state;
    const measured = card.items.filter(i => i.status === 'E' && /^(?:check:|red:|writes$)/.test(i.obligation)).length;
    assert.ok(measured > 0);
    assert.equal(out.stdout.split('\n')[0], `a merged (${state.trunk.commit.slice(0, 12)}); measured ${measured}, waived 0, debt 0`, out.stdout);
    assert.doesNotMatch(out.stdout, /#\d+|Trunk advanced|[0-9a-f]{40}/, out.stdout);
    assert.equal((await cli(f.cwd, ['why', 'a'])).stdout.split('\n')[0], 'a: merged');
  } finally { await f.cleanup(); }
});

/** A follower over a fresh log; `put` appends driver lines. */
function follow(root: string) {
  const dir = join(root, 'follow'), log = join(dir, 'log.jsonl');
  mkdirSync(dir, { recursive: true }); writeFileSync(log, '');
  const f = new Follower({ log, repo: '/r', pid: process.pid, start: procStart(process.pid), deliver() {} });
  return { f, put: (...js: object[]) => appendFileSync(log, js.map(j => `${JSON.stringify(j)}\n`).join('')) };
}

test('QT-R1 (1): repo-level notices wake as Needs you with their full text above the status line', async () => {
  const r = await repo();
  try {
    const { f, put } = follow(r.root);
    const red = 'trunk: check:runtime fails on trunk abc without any candidate (a, b)\n  choices: owed adopt | owed plan <plan.yaml>';
    const drift = 'trunk moved outside owed: main is def, the ledger has abc; owed adopt --note "<why>"';
    put({ do: 'notify', node: 'trunk', outcome: 'notify', scope: 'repo', text: red }, { do: 'halt', node: 'b', outcome: 'halted', attempt: 1, needs: 'human', detail: 'stuck' },
      { do: 'notify', node: DRIFT_NODE, outcome: 'notify', text: drift });
    const m = f.tick()!, status = m.indexOf('\nDriver continues');
    assert.ok(m.startsWith(`Needs you: ${red}\nNeeds you: b — stuck → owed why b\nNeeds you: ${drift}\nDriver continues`), m);
    assert.ok(m.indexOf('choices: owed adopt | owed plan') < status, 'every line of the notice is kept above the status');
    assert.equal(m.split('without any candidate').length, 2, 'not repeated below');
  } finally { await r.cleanup(); }
});

test('QT-R1 (2): a reported notice wakes with the decide command and the report tail', async () => {
  const r = await repo();
  try {
    const { f, put } = follow(r.root);
    const tail = Array.from({ length: 5 }, (_, i) => `finding ${i}: detail`).join('\n');
    put({ do: 'notify', node: 'a', outcome: 'notify', rid: 'rid-a', reportedResume: 7, text: `a: reported (resume #7)\n${tail}` });
    const lines = f.tick()!.split('\n');
    assert.equal(lines[0], 'Needs you: a — review the reported findings → owed decide a --text "<decision>"');
    assert.deepEqual(lines.slice(1, 6), tail.split('\n'));
    assert.match(lines[6]!, /^Driver continues/);
  } finally { await r.cleanup(); }
});

test('QT-R1 (2): the default why card of a reported node says it is parked with the report and waits for the parent', { timeout: 120_000 }, async () => {
  const f = await failing();
  try {
    const resumed = await ops.resume({ cwd: f.cwd, as: parent, node: 'a', expect: 'report' });
    await ops.send({ cwd: f.cwd, as: parent, node: 'a', attempt: 1, rid: f.rid, sendKind: 'follow-up', reason: 'report', message: 'report your findings and stop; do not submit unless the parent asks' });
    await ops.recordReport(await Ledger.open(f.cwd), 'a', resumed.entry.seq);   // what the driver records when the report arrives
    const quiet = (await cli(f.cwd, ['why', 'a'])).stdout;
    assert.ok(quiet.split('\n').includes(`reported (resume #${resumed.entry.seq}): parked with the writer's report, waiting for the parent → owed decide a --text "<decision>"`), quiet);
    assert.doesNotMatch(quiet, /waits for the writer's report/);
  } finally { await f.cleanup(); }
});

test('QT-R1 (3): every open question of a run gets its own Needs-you line and answer command', async () => {
  const r = await repo();
  try {
    const { f, put } = follow(r.root);
    const l = { rid: 'rid-q', role: 'writer' } as LaunchEntry;
    const view: RunView = { rid: 'rid-q', state: 'asking', questions: [{ qid: 'q1', rev: 1, question: 'which port?' }, { qid: 'q2', rev: 3, question: 'which db?' }] };
    put({ do: 'notify', node: 'n', outcome: 'notify', rid: 'rid-q', qid: 'q1', rev: 1, text: askingText('n', l, view) });
    const lines = f.tick()!.split('\n');
    assert.deepEqual(lines.slice(0, 2), ['Needs you: n — decide which port? → owed answer n --rid rid-q --qid q1 "<text>"', 'Needs you: n — decide which db? → owed answer n --rid rid-q --qid q2 "<text>"']);
    assert.match(lines[2]!, /^Driver continues/);
  } finally { await r.cleanup(); }
});

test('QT-R1 (4): only a non-refused repair follow-up resets "new"; steers, other follow-ups and refused repairs do not', { timeout: 120_000 }, async () => {
  const f = await failing();
  try {
    let state = (await ops.readState(f)).state;
    const isNew = (rejected?: Map<string, string>) => /Failures new since my last message:\n- check:a: /.test(repairFollowUp(state, 'a', rejected).message);
    const rule = await ops.rule({ cwd: f.cwd, as: parent, text: 'keep the API', nodes: ['a'] });
    await ops.send({ cwd: f.cwd, as: parent, node: 'a', attempt: 1, rid: f.rid, sendKind: 'steer', reason: 'ruling', message: 'a ruling', rulings: rule.seq });
    await ops.send({ cwd: f.cwd, as: parent, node: 'a', attempt: 1, rid: f.rid, sendKind: 'follow-up', reason: 'interrupted', message: 'You were interrupted' });
    state = (await ops.readState(f)).state;
    assert.ok(isNew(), 'a ruling steer and an interrupted follow-up do not count');
    const repair = await ops.send({ cwd: f.cwd, as: parent, node: 'a', attempt: 1, rid: f.rid, sendKind: 'follow-up', reason: 'repair', message: 'fix it', rulings: rule.seq });
    state = (await ops.readState(f)).state;
    assert.ok(isNew(new Map([[repair.send, 'sealed']])), 'a refused repair follow-up does not count');
    assert.ok(!isNew(), 'a delivered repair follow-up counts');
    assert.match(repairFollowUp(state, 'a').message, /Still failing from before: [^\n]*check:a/);
  } finally { await f.cleanup(); }
});

test('QT-R1 (5): the default why card of trunk and inv:* gives only commands the CLI accepts', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    await seed(r.cwd); await commitAt(r.cwd, { 'test/state.cjs': 'module.exports=0;' });
    const plan = join(r.root, 'plan.yaml'); await writeFile(plan, planText);
    const init = await cli(r.cwd, ['init', plan, '--i-am-owner']); assert.equal(init.code, 0, init.stderr);
    for (const subject of ['trunk', 'inv:unit']) {
      const out = await cli(r.cwd, ['why', subject]); assert.equal(out.code, 0, out.stderr);
      const item = out.stdout.split('\n').find(l => l.includes('inv:unit') && l.includes('→'));
      assert.ok(item, out.stdout);
      assert.match(item, /→ (?:owed plan <plan\.yaml> \(add a node that repairs inv:unit; invariants cannot be waived|owed attest --trunk$)/, out.stdout);
      assert.doesNotMatch(out.stdout, /owed (?:attest|waive|review|approve|evidence|decide) (?:trunk|inv:)/, out.stdout);
    }
  } finally { await r.cleanup(); }
});

test('QT-R1 (6): the merged line read is best-effort: an unreadable card never fails a merged result', async () => {
  const r = await repo();
  try {
    assert.deepEqual(await ops.mergedLines(r.cwd, [{ node: 'x', commit: 'abcdef0123456789abcdef0123456789abcdef01' }]), ['x merged (abcdef012345)']);
    assert.deepEqual(await ops.mergedLines(r.cwd, [{ node: 'y', commit: '0123456789ab0123456789ab0123456789ab0123' }], { y: 2 }), ['y merged (0123456789ab)']);
  } finally { await r.cleanup(); }
});

test('QT4 (#2691): a batch member with a defer on an older merge key shows only the debt left on this merge (0, not 1)', { timeout: 180_000 }, async () => {
  const r = await repo();
  try {
    const own = { role: 'owner', id: 'human' } as const;
    const node = (id: string) => ({ id, writes: [`${id}.txt`], checks: [{ id, run: `test -f ${id}.txt`, reads: ['*.txt'] }] });
    const plan = { version: 1, trunk: 'main', invariants: [{ id: 'inv', timeout_s: 60, run: "echo '# tests 1'; echo '# pass 1'" }], nodes: [node('a'), node('b')], drive: { merge_batch: 2 } };
    await commitAt(r.cwd, { README: 'x' });
    await ops.init({ cwd: r.cwd, plan: JSON.stringify(plan), as: own, channel: 'flag' });
    const wt: Record<string, string> = {};
    for (const id of ['a', 'b']) {
      const d = await ops.dispatch({ cwd: r.cwd, node: id, as: parent, allowOverlap: true }); await commitAt(d.worktree, { [`${id}.txt`]: id }); wt[id] = d.worktree;
      await ops.submit({ cwd: d.worktree, node: id, as: { role: 'writer', id: `${id}#1` } });
      assert.equal((await ops.attest({ cwd: r.cwd, node: id })).accepted, true);
    }
    // A defer of a on its single-merge key (trunk + a); the batch merges a onto a different tree, so it is not this merge's debt.
    const st = (await ops.readState(r)).state, built = await buildMerge(r.cwd, st.trunk.commit, st.nodes.a!.candidate!.commit, 'owed merge a');
    assert.ok(!('conflicts' in built));
    const facts = await stateFacts(r.cwd, st.plan, built.commit, quarantineNames(st.plan, () => false, 'a'));
    await ops.defer({ cwd: r.cwd, as: own, channel: 'flag', node: 'a', items: [{ id: 'inv', key: facts.invKeys.inv! }], reason: 'older key' });
    assert.equal((await ops.readState(r)).state.deferred.filter(x => x.node === 'a').length, 1);
    const res = await cli(r.cwd, ['merge', 'a,b', '--as', 'parent:test']);
    assert.equal(res.code, 0, res.stderr);
    assert.equal((await ops.readState(r)).state.deferred.filter(x => x.node === 'a').length, 1, 'the ledger still holds the older-key defer (what the previous fallback counted)');
    assert.match(res.stdout, /^a merged \([0-9a-f]{12}\); measured \d+, waived 0, debt 0$/m, res.stdout);
    assert.match(res.stdout, /^b merged \([0-9a-f]{12}\); measured \d+, waived 0, debt 0$/m, res.stdout);
    // Without a count the line omits debt rather than counting older keys' defers.
    const merge = (await Ledger.open(r.cwd)).read().then(es => es.findLast(e => e.kind === 'merge' && e.node === 'a') as { commit: string });
    assert.match((await ops.mergedLines(r.cwd, [{ node: 'a', commit: (await merge).commit }]))[0]!, /^a merged \([0-9a-f]{12}\); measured \d+, waived 0$/);
  } finally { await r.cleanup(); }
});

test('QT-R1 with 0.24: sweep escape and failing-sweep notices wake as Needs you with the merge, the broken tests and the coverage hint', async () => {
  const r = await repo();
  try {
    const { f, put } = follow(r.root);
    const escape = 'escape: a (merge #41) broke test/x.test.ts, test/y.test.ts on trunk 0123456789ab; no check covered it. Fix: a node whose brief names the test; coverage: src/x.ts, src/y.ts';
    const failed = 'sweep #55 on trunk 0123456789ab: fail (2 failed: test/x.test.ts, test/y.test.ts)\nbisect: first bad merge a (#41)';
    put({ do: 'notify', node: 'sweep', scope: 'repo', outcome: 'notify', text: escape, facts: 56 }, { do: 'notify', node: 'sweep', scope: 'repo', outcome: 'notify', text: failed, facts: 55 },
      { do: 'sweep', node: 'sweep', scope: 'repo', outcome: 'error', detail: 'sweep: git worktree add failed' });
    const m = f.tick()!, needs = m.slice(0, m.indexOf('\nDriver continues'));
    assert.ok(needs.includes(`Needs you: ${escape}`), m);
    assert.ok(needs.includes(`Needs you: ${failed}`), m);
    assert.match(needs, /^Needs you: .*sweep: git worktree add failed/m, m);
    for (const s of ['merge #41', 'test/x.test.ts', 'coverage: src/x.ts, src/y.ts', 'bisect: first bad merge a']) assert.ok(needs.includes(s), s);
  } finally { await r.cleanup(); }
});
