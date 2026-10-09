import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.ts';
import * as ops from '../src/ops.ts';
import { parsePlan, planDowngrades, driveConfig, DRIVE_DEFAULTS } from '../src/plan.ts';
import { reduce, validateDraft, halted, projectId, runId, runLabels, driveReviewer } from '../src/reducer.ts';
import { renderStatus, renderReceipt, renderReport, reviewPacket, reviewRuns, statusView, receipt } from '../src/views.ts';
import { sha256 } from '../src/canon.ts';
import type { Draft, Entry, Plan, State } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { commitAt } from './helpers/surface.ts';

const owner = { role: 'owner' as const, id: 'human' };
const drive = { role: 'parent' as const, id: 'drive' };
const human = { role: 'parent' as const, id: 'main' };
const base = { version: 1, trunk: 'main', closure: ['closure/'], invariants: [], nodes: [
  { id: 'a', title: 'Node A', brief: 'Do the A thing.', writes: ['a/', 'closure/'], checks: [{ id: 'ok', run: 'true', reads: ['a/**'] }], review: { count: 1, min_rank: 1 } },
  { id: 'b', writes: ['b/'], checks: [], review: { count: 2, min_rank: 2 } },
] };

// ---------- D2: plan config ----------
test('drive plan block: absent, defaults, explicit values, never a downgrade', () => {
  const plain = parsePlan(JSON.stringify(base));
  assert.equal(plain.drive, undefined, 'no drive block: the plan is unchanged');
  assert.deepEqual(driveConfig(plain), { max: 4, repairs: 2, writer: { agent: 'worker' }, reviewer: { agent: 'reviewer' } });
  assert.deepEqual(DRIVE_DEFAULTS, { max: 4, repairs: 2, writer: { agent: 'worker' }, reviewer: { agent: 'reviewer' } });
  assert.deepEqual(parsePlan(JSON.stringify({ ...base, drive: {} })).drive, { max: 4, repairs: 2, writer: { agent: 'worker' }, reviewer: { agent: 'reviewer' } });
  const yaml = `version: 1\ntrunk: main\ndrive:\n  max: 2\n  repairs: 0\n  writer: { agent: worker, model: "sota-claude/claude-opus-5-5:high" }\n  reviewer: { agent: reviewer }\nnodes: []\n`;
  const p = parsePlan(yaml);
  assert.deepEqual(p.drive, { max: 2, repairs: 0, writer: { agent: 'worker', model: 'sota-claude/claude-opus-5-5:high' }, reviewer: { agent: 'reviewer' } });
  assert.deepEqual(driveConfig(p), p.drive);
  // Changing or removing drive: is never a downgrade.
  assert.deepEqual(planDowngrades(p, plain), []);
  assert.deepEqual(planDowngrades(plain, parsePlan(JSON.stringify({ ...base, drive: { max: 1, repairs: 0 } }))), []);
});
test('drive plan block: unknown keys and bad types are refused', () => {
  const bad = (drive: unknown, pattern: RegExp) => assert.throws(() => parsePlan(JSON.stringify({ ...base, drive })), pattern);
  bad({ maxx: 3 }, /drive\.maxx: unknown key/);
  bad({ max: 0 }, /drive\.max: expected integer >= 1/);
  bad({ max: '4' }, /drive\.max: expected integer >= 1/);
  bad({ max: 2.5 }, /drive\.max/);
  bad({ repairs: -1 }, /drive\.repairs: expected integer >= 0/);
  bad({ writer: 'worker' }, /drive\.writer: expected object/);
  bad({ writer: { agent: 'worker', thinking: 'high' } }, /drive\.writer\.thinking: unknown key/);
  bad({ reviewer: { agent: 3 } }, /drive\.reviewer\.agent: expected non-empty string/);
  bad({ reviewer: { model: '' } }, /drive\.reviewer\.model: expected non-empty string/);
  bad([], /drive: expected object/);
  bad(null, /drive: expected object/);
  // Every error is listed.
  assert.throws(() => parsePlan(JSON.stringify({ ...base, drive: { max: 0, extra: 1 } })), (e: Error) => /drive\.max/.test(e.message) && /drive\.extra/.test(e.message));
});

// ---------- fixture ----------
type Repo = Awaited<ReturnType<typeof repo>>;
async function fixture(plan: object = base): Promise<Repo> {
  const r = await repo();
  try {
    await commitAt(r.cwd, { 'README': 'x\n', 'a/x.txt': '0\n', 'closure/c.txt': '0\n' });
    await ops.init({ cwd: r.cwd, plan: JSON.stringify(plan), as: owner, channel: 'flag' });
    return r;
  } catch (e) { await r.cleanup(); throw e; }
}
async function load(cwd: string): Promise<{ entries: Entry[]; state: State }> {
  const ledger = await Ledger.open(cwd), entries = await ledger.read(), plans = new Map<string, Plan>();
  for (const e of entries) if (e.kind === 'genesis' || e.kind === 'plan') plans.set(e.plan, parsePlan((await ledger.getBlob(e.plan)).toString()));
  return { entries, state: reduce(entries, sha => plans.get(sha)!) };
}
async function count(cwd: string): Promise<number> { return (await (await Ledger.open(cwd)).read()).length; }
async function refused(cwd: string, fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  const before = await count(cwd);
  await assert.rejects(fn, pattern);
  assert.equal(await count(cwd), before, 'a refused driver entry leaves the ledger unchanged');
}
async function submitA(cwd: string, worktree: string, files: Record<string, string> = { 'a/x.txt': '1\n' }): Promise<void> {
  await commitAt(worktree, files);
  await ops.submit({ cwd: worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
}

// ---------- D3: entries, formulas, State ----------
test('runId, labels and project id formulas', async () => {
  assert.equal(runId('0123456789ab', 'a', 1, 'writer'), 'owed:0123456789ab:a:1:writer');
  assert.equal(runId('0123456789ab', 'a', 2, 'reviewer', 3), 'owed:0123456789ab:a:2:reviewer:3');
  assert.deepEqual(runLabels('0123456789ab', 'a', 2, 'reviewer'), { owed: '0123456789ab', node: 'a', attempt: '2', role: 'reviewer' });
  assert.equal(driveReviewer('a', 2, 1), 'reviewer:drive-a-2-1');
  const r = await fixture();
  try {
    const { entries, state } = await load(r.cwd);
    assert.equal(projectId(state), entries[0]!.hash.slice(0, 12));
    assert.match(projectId(state), /^[0-9a-f]{12}$/);
    // Stable: later entries do not change it.
    await ops.dispatch({ cwd: r.cwd, node: 'a', as: drive });
    assert.equal(projectId((await load(r.cwd)).state), entries[0]!.hash.slice(0, 12));
  } finally { await r.cleanup(); }
});

test('launch, send and halt are recorded through ops and exposed per attempt', async () => {
  const r = await fixture();
  try {
    await ops.dispatch({ cwd: r.cwd, node: 'a', as: drive });
    const p = projectId((await load(r.cwd)).state), rid = runId(p, 'a', 1, 'writer'), spec = JSON.stringify({ agent: 'worker', task: 'x' });
    const l = await ops.launch({ cwd: r.cwd, as: drive, node: 'a', attempt: 1, role: 'writer', rid, spec, labels: runLabels(p, 'a', 1, 'writer') });
    assert.equal(l.created, true);
    assert.equal(l.entry.spec, sha256(spec));
    assert.equal((await (await Ledger.open(r.cwd)).getBlob(l.entry.spec)).toString(), spec, 'exact spec bytes are stored');
    // Persist-before-submit retry: the same launch returns the stored entry.
    const again = await ops.launch({ cwd: r.cwd, as: drive, node: 'a', attempt: 1, role: 'writer', rid, spec, labels: runLabels(p, 'a', 1, 'writer') });
    assert.deepEqual([again.created, again.entry.seq], [false, l.entry.seq]);
    await refused(r.cwd, () => ops.launch({ cwd: r.cwd, as: drive, node: 'a', attempt: 1, role: 'writer', rid, spec: spec + ' ', labels: runLabels(p, 'a', 1, 'writer') }), /already recorded .* other content/);
    const s = await ops.send({ cwd: r.cwd, as: drive, node: 'a', attempt: 1, rid, sendKind: 'follow-up', message: 'commit your work and run `owed submit a`', reason: 'submit' });
    assert.equal(s.send, `${rid}:follow-up:${s.seq}`);
    assert.equal((await (await Ledger.open(r.cwd)).getBlob(s.message)).toString(), 'commit your work and run `owed submit a`');
    const h = await ops.halt({ cwd: r.cwd, as: drive, node: 'a', attempt: 1, reason: 'writer sealed failed', needs: 'human' });
    const { state } = await load(r.cwd);
    assert.deepEqual(state.nodes.a!.runs.map(x => [x.attempt, x.launches.map(e => e.rid), x.sends.map(e => e.send)]), [[1, [rid], [s.send]]]);
    assert.equal(halted(state, 'a')?.seq, h.seq);
    assert.equal(state.nodes.a!.halt?.reason, 'writer sealed failed');
    assert.equal(halted(state, 'b'), undefined);
    assert.deepEqual(state.nodes.b!.runs, []);
    // A reviewer run with an index.
    await ops.launch({ cwd: r.cwd, as: drive, node: 'a', attempt: 1, role: 'reviewer', rid: runId(p, 'a', 1, 'reviewer', 2), spec, labels: runLabels(p, 'a', 1, 'reviewer') });
    assert.equal((await load(r.cwd)).state.nodes.a!.runs[0]!.launches.length, 2);
  } finally { await r.cleanup(); }
});

test('refusals: non-parent, wrong attempt, malformed fields leave the ledger unchanged', async () => {
  const r = await fixture();
  try {
    await ops.dispatch({ cwd: r.cwd, node: 'a', as: drive });
    const { state } = await load(r.cwd), p = projectId(state), rid = runId(p, 'a', 1, 'writer'), spec = '{"agent":"worker"}', labels = runLabels(p, 'a', 1, 'writer');
    const launch = (o: Partial<Parameters<typeof ops.launch>[0]>) => ops.launch({ cwd: r.cwd, as: drive, node: 'a', attempt: 1, role: 'writer', rid, spec, labels, ...o });
    await refused(r.cwd, () => launch({ as: { role: 'writer', id: 'a#1' } }), /launch insufficient permissions; requires parent/);
    await refused(r.cwd, () => launch({ as: { role: 'reviewer', id: 'x' } }), /insufficient permissions/);
    await refused(r.cwd, () => launch({ as: owner, channel: 'flag' }), /insufficient permissions/);
    await refused(r.cwd, () => launch({ attempt: 2, rid: runId(p, 'a', 2, 'writer'), labels: runLabels(p, 'a', 2, 'writer') }), /attempt must match the current open writer slot/);
    await refused(r.cwd, () => launch({ node: 'b', rid: runId(p, 'b', 1, 'writer'), labels: runLabels(p, 'b', 1, 'writer') }), /attempt must match the current open writer slot/);
    await refused(r.cwd, () => launch({ node: 'zz' }), /Node zz does not exist/);
    await refused(r.cwd, () => launch({ role: 'boss' as 'writer' }), /launch role must be writer or reviewer/);
    await refused(r.cwd, () => launch({ rid: 'owed:000000000000:a:1:writer' }), /launch rid must be/);
    await refused(r.cwd, () => launch({ rid: `${rid}:1` }), /launch rid must be/);
    await refused(r.cwd, () => launch({ role: 'reviewer', rid: runId(p, 'a', 1, 'reviewer', 0), labels: runLabels(p, 'a', 1, 'reviewer') }), /launch rid must be/);
    await refused(r.cwd, () => launch({ labels: { ...labels, extra: 'x' } }), /launch labels must be/);
    await refused(r.cwd, () => launch({ labels: { ...labels, role: 'reviewer' } }), /launch labels must be/);
    const send = (o: Partial<Parameters<typeof ops.send>[0]>) => ops.send({ cwd: r.cwd, as: drive, node: 'a', attempt: 1, rid, sendKind: 'follow-up', message: 'm', reason: 'repair', ...o });
    await refused(r.cwd, () => send({}), /send rid must name a recorded launch of this node attempt/);
    await launch({});
    await refused(r.cwd, () => send({ as: { role: 'writer', id: 'a#1' } }), /send insufficient permissions/);
    await refused(r.cwd, () => send({ attempt: 2 }), /attempt must match/);
    await refused(r.cwd, () => send({ sendKind: 'shout' as 'steer' }), /send sendKind must be one of follow-up, steer/);
    await refused(r.cwd, () => send({ reason: 'bored' as 'repair' }), /send reason must be one of/);
    const halt = (o: Partial<Parameters<typeof ops.halt>[0]>) => ops.halt({ cwd: r.cwd, as: drive, node: 'a', attempt: 1, reason: 'stuck', needs: 'human', ...o });
    await refused(r.cwd, () => halt({ as: { role: 'reviewer', id: 'x' } }), /halt insufficient permissions/);
    await refused(r.cwd, () => halt({ attempt: 3 }), /attempt must match/);
    await refused(r.cwd, () => halt({ reason: '  ' }), /halt requires a reason/);
    await refused(r.cwd, () => halt({ needs: 'god' as 'human' }), /halt needs must be human or owner/);
    // Raw drafts: hashes, send ids and unknown fields are checked by the reducer.
    const now = (await load(r.cwd)).state;
    const raw = (d: object) => validateDraft(now, { by: 'parent:drive', ...d } as Draft);
    assert.deepEqual(raw({ kind: 'halt', node: 'a', attempt: 1, reason: 'x', needs: 'human' }), []);
    assert.match(raw({ kind: 'halt', node: 'a', attempt: 1, reason: 'x', needs: 'human', extra: 1 }).join(), /halt has unknown fields: extra/);
    assert.match(raw({ kind: 'launch', node: 'a', attempt: 1, role: 'reviewer', rid: runId(p, 'a', 1, 'reviewer'), spec: 'nothex', labels: runLabels(p, 'a', 1, 'reviewer') }).join(), /launch spec must be a blob hash/);
    assert.match(raw({ kind: 'launch', node: 'a', attempt: 1, role: 'writer', rid, spec: sha256(spec), labels }).join(), /already recorded/);
    const good = { kind: 'send', node: 'a', attempt: 1, rid, sendKind: 'steer', message: sha256('m'), reason: 'fenced' };
    assert.deepEqual(raw({ ...good, send: `${rid}:steer:${now.seq + 1}` }), []);
    assert.match(raw({ ...good, send: `${rid}:steer:${now.seq}` }).join(), /send id must be/);
    assert.match(raw({ ...good, send: `${rid}:steer:${now.seq + 1}`, message: 'm' }).join(), /send message must be a blob hash/);
    assert.match(raw({ ...good, send: `${rid}:steer:${now.seq + 1}`, by: 'reviewer:x' }).join(), /insufficient permissions/);
    // Replay refuses a forged entry too: the reducer validates every entry.
    const ledger = await Ledger.open(r.cwd);
    const forged = await ledger.withLock(() => ledger.append([{ kind: 'halt', by: 'writer:a#1', node: 'a', attempt: 1, reason: 'x', needs: 'human' } as Draft]));
    await assert.rejects(load(r.cwd), new RegExp(`Entry #${forged[0]!.seq} invalid: halt insufficient permissions`));
  } finally { await r.cleanup(); }
});

test('halt clearing: driver entries, notes and executor observations do not clear; non-driver node actions and new attempts do', async () => {
  const r = await fixture();
  try {
    const d = await ops.dispatch({ cwd: r.cwd, node: 'a', as: drive });
    const p = projectId((await load(r.cwd)).state), rid = runId(p, 'a', 1, 'writer');
    const h1 = await ops.halt({ cwd: r.cwd, as: drive, node: 'a', attempt: 1, reason: 'first', needs: 'human' });
    const isHalted = async () => halted((await load(r.cwd)).state, 'a')?.seq;
    await ops.launch({ cwd: r.cwd, as: drive, node: 'a', attempt: 1, role: 'writer', rid, spec: '{}', labels: runLabels(p, 'a', 1, 'writer') });
    await ops.send({ cwd: r.cwd, as: drive, node: 'a', attempt: 1, rid, sendKind: 'follow-up', message: 'm', reason: 'submit' });
    assert.equal(await isHalted(), h1.seq, 'driver launch/send do not clear its halt');
    await ops.rule({ cwd: r.cwd, as: human, text: 'all nodes', nodes: '*' });
    await ops.rule({ cwd: r.cwd, as: human, text: 'about b', nodes: ['b'] });
    assert.equal(await isHalted(), h1.seq, 'a ruling not naming the node does not clear');
    await ops.rule({ cwd: r.cwd, as: human, text: 'about a', nodes: ['a'] });
    assert.equal(await isHalted(), undefined, 'a ruling naming the node clears');
    // Writer submit clears; executor observations (driver-caused attest) do not.
    await ops.halt({ cwd: r.cwd, as: drive, node: 'a', attempt: 1, reason: 'second', needs: 'human' });
    await submitA(r.cwd, d.worktree);
    assert.equal(await isHalted(), undefined, 'a writer submit clears');
    const h3 = await ops.halt({ cwd: r.cwd, as: drive, node: 'a', attempt: 1, reason: 'third', needs: 'owner' });
    const attested = await ops.attest({ cwd: r.cwd, node: 'a' });
    assert.ok(attested.observations.length > 0);
    assert.equal(await isHalted(), h3.seq, 'executor observations do not clear');
    await ops.review({ cwd: r.cwd, as: { role: 'reviewer', id: 'r1' }, node: 'a', verdict: 'block', rank: 1, note: 'needs work' });
    assert.equal(await isHalted(), undefined, 'a review clears');
    // A rebase or abandon by the driver itself does not clear, but a closed attempt is never halted; a new attempt is free.
    await ops.halt({ cwd: r.cwd, as: drive, node: 'a', attempt: 1, reason: 'fourth', needs: 'human' });
    await ops.abandon({ cwd: r.cwd, as: drive, node: 'a', reason: 'retry' });
    const st = (await load(r.cwd)).state;
    assert.equal(halted(st, 'a'), undefined, 'no open attempt, no halt');
    await ops.dispatch({ cwd: r.cwd, node: 'a', as: drive });
    assert.equal(await isHalted(), undefined, 'a new attempt starts unhalted');
    await refused(r.cwd, () => ops.halt({ cwd: r.cwd, as: drive, node: 'a', attempt: 1, reason: 'old attempt', needs: 'human' }), /attempt must match/);
    const h5 = await ops.halt({ cwd: r.cwd, as: drive, node: 'a', attempt: 2, reason: 'fifth', needs: 'human' });
    assert.equal(await isHalted(), h5.seq);
    await ops.abandon({ cwd: r.cwd, as: human, node: 'a', reason: 'human gives up' });
    assert.equal((await load(r.cwd)).state.nodes.a!.halt, undefined, 'a human abandon clears');
  } finally { await r.cleanup(); }
});

// ---------- D5: review packet ----------
test('reviewPacket: exact commands, reviewer ids, ranks, closure-review, rulings', async () => {
  const r = await fixture();
  try {
    const a = await ops.dispatch({ cwd: r.cwd, node: 'a', as: drive });
    await ops.rule({ cwd: r.cwd, as: human, text: 'keep it small', nodes: ['a'] });
    await submitA(r.cwd, a.worktree, { 'a/x.txt': '1\n', 'closure/c.txt': '1\n' });
    const { state } = await load(r.cwd), n = state.nodes.a!, rule = state.rules.at(-1)!;
    assert.equal(reviewRuns(state, 'a'), 1, 'one run covers review and closure-review');
    const text = reviewPacket(state, 'a', 1);
    const lines = text.split('\n');
    assert.ok(lines.includes(`Candidate: ${n.candidate!.commit} (submit #${n.candidate!.seq})`));
    assert.ok(lines.includes(`Base: ${n.slot!.base}`));
    assert.ok(lines.includes('Do the A thing.'), 'the plan brief');
    assert.ok(lines.includes('Allowed writes: a/, closure/'));
    assert.ok(lines.includes(`Inspect the actual diff: git diff ${n.slot!.base} ${n.candidate!.commit}`));
    assert.ok(lines.includes(`- #${rule.seq} keep it small`));
    assert.ok(lines.includes(`  owed review a --as reviewer:drive-a-1-1 --ok|--block --rank 1 --ack-rulings ${rule.seq} --note "..."`), text);
    assert.ok(lines.includes(`  owed review a --as reviewer:drive-a-1-1 --ok|--block --rank 2 --obligation closure-review --ack-rulings ${rule.seq} --note "..."`), text);
    assert.ok(lines.some(l => /^- review: 1 non-writer review\(s\) by distinct reviewers, rank >= 1/.test(l)));
    assert.ok(lines.some(l => /^- closure-review: 1 non-writer review, rank >= 2/.test(l)));
    assert.match(text, /Do not edit files/);
    assert.match(text, /Reply with the ledger seqs/);
    assert.throws(() => reviewPacket(state, 'a', 2), /run 2 does not exist/);
    assert.throws(() => reviewPacket(state, 'b', 1), /no open candidate/);
  } finally { await r.cleanup(); }
  // Two reviews required, no closure touched, no rulings: run 2 records only review, with its own id and rank.
  const r2 = await fixture({ ...base, nodes: [base.nodes[0], { ...base.nodes[1], writes: ['b/'] }] });
  try {
    const b = await ops.dispatch({ cwd: r2.cwd, node: 'b', as: drive });
    await commitAt(b.worktree, { 'b/y.txt': 'y\n' });
    await ops.submit({ cwd: b.worktree, node: 'b', as: { role: 'writer', id: 'b#1' } });
    const { state } = await load(r2.cwd);
    assert.equal(reviewRuns(state, 'b'), 2);
    const one = reviewPacket(state, 'b', 1), two = reviewPacket(state, 'b', 2);
    assert.ok(one.split('\n').includes('  owed review b --as reviewer:drive-b-1-1 --ok|--block --rank 2 --note "..."'), one);
    assert.ok(two.split('\n').includes('  owed review b --as reviewer:drive-b-1-2 --ok|--block --rank 2 --note "..."'), two);
    assert.doesNotMatch(one + two, /closure-review|--ack-rulings/);
    assert.match(two, /reviewer run 2 of 2/);
    assert.match(one, /Rulings in scope: none/);
  } finally { await r2.cleanup(); }
});

// ---------- views ----------
test('status, why and report show halts and live launches', async () => {
  const r = await fixture();
  try {
    await ops.dispatch({ cwd: r.cwd, node: 'a', as: drive });
    await ops.dispatch({ cwd: r.cwd, node: 'b', as: drive });
    const p = projectId((await load(r.cwd)).state), rid = runId(p, 'a', 1, 'writer');
    const quiet = renderStatus(await ops.status({ cwd: r.cwd }));
    assert.doesNotMatch(quiet, /Halted \(driver\)|Driver runs/, 'no driver sections without driver entries');
    await ops.launch({ cwd: r.cwd, as: drive, node: 'a', attempt: 1, role: 'writer', rid, spec: '{}', labels: runLabels(p, 'a', 1, 'writer') });
    const ha = await ops.halt({ cwd: r.cwd, as: drive, node: 'a', attempt: 1, reason: 'writer run failed', needs: 'human' });
    const hb = await ops.halt({ cwd: r.cwd, as: drive, node: 'b', attempt: 1, reason: 'request conflict', needs: 'owner' });
    const v = await ops.status({ cwd: r.cwd });
    assert.deepEqual(v.halted.map(h => h.node).sort(), ['a', 'b']);
    assert.deepEqual(Object.keys(v.launches), ['a']);
    const text = renderStatus(v), lines = text.split('\n');
    const halted = lines.indexOf('Halted (driver):');
    assert.ok(halted > 0, text);
    assert.equal(lines[halted + 1], `⏸ a: halted by driver #${ha.seq} (attempt 1, needs human): writer run failed`);
    assert.ok(!lines.slice(halted).some(l => l.startsWith('⏸ b:')), 'needs-owner halts are not in the driver section');
    const owner = lines.indexOf('Pending owner:');
    assert.match(lines[owner + 1]!, new RegExp(`^⏸ halted b — driver halted attempt 1 \\(#${hb.seq}\\): request conflict; cleared by`));
    assert.ok(lines.includes('Driver runs (open attempts):'));
    assert.ok(lines.includes(`a attempt 1: #${ha.seq - 1} writer ${rid}`), text);
    const why = renderReceipt(await ops.why({ cwd: r.cwd, node: 'a' }));
    assert.match(why, new RegExp(`⏸ halted by driver #${ha.seq} \\(attempt 1, needs human\\): writer run failed; cleared by any later action`));
    assert.match(why, new RegExp(`Driver launch #${ha.seq - 1} writer ${rid} \\(spec ${sha256('{}').slice(0, 12)}\\)`));
    const card = await ops.why({ cwd: r.cwd, node: 'a' });
    assert.equal(card.halt?.seq, ha.seq);
    assert.equal(card.runs?.launches[0]?.rid, rid);
    // A human action clears b's halt; the report lists both, a active and b cleared.
    await ops.rule({ cwd: r.cwd, as: human, text: 'b proceeds', nodes: ['b'] });
    const report = await ops.report({ cwd: r.cwd });
    assert.deepEqual(report.halts.map(h => [h.node, h.active]), [['a', true], ['b', false]]);
    const rt = renderReport(report);
    assert.match(rt, new RegExp(`Driver halts\\n  a: halted by driver #${ha.seq} \\(attempt 1, needs human\\): writer run failed \\(active\\)\\n  b: halted by driver #${hb.seq} \\(attempt 1, needs owner\\): request conflict \\(cleared\\)`));
    // Window: a cleared halt before `since` is omitted, an active one is still listed.
    const later = await ops.report({ cwd: r.cwd, since: hb.seq });
    assert.deepEqual(later.halts.map(h => h.node), ['a']);
    // Pure views agree with ops.
    const { state, entries } = await load(r.cwd);
    assert.deepEqual(statusView(state, entries).halted.map(h => h.node), ['a']);
    assert.equal(receipt(state, entries, 'b').halt, undefined);
  } finally { await r.cleanup(); }
});
