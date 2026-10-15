// MX1–MX3 (0.23): decisions, interruption classes, phases, the counterfactual replay and lease_wait_ms.
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import { Ledger, entryHash } from '../src/ledger.ts';
import { DRIVE_PRINCIPAL } from '../src/drive-run.ts';
import { computeMetrics, renderMetrics, type Metrics } from '../src/metrics.ts';
import { classifyRebases, counterfactualStats, renderCounterfactual, type Counterfactual, type CounterRow } from '../src/counterfactual.ts';
import { newerEntry, validateDraft } from '../src/reducer.ts';
import { parsePlan } from '../src/plan.ts';
import { H, ZERO } from '../src/canon.ts';
import type { CandidateFacts, Draft, Entry, Plan } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const owner = { role: 'owner', id: 'pi' } as const, parent = { role: 'parent', id: 'main' } as const;

// ---------- MX1: synthetic ledger with known acts, decisions, halts and timings ----------
const C = '1'.repeat(40), K = '2'.repeat(64);
const facts: CandidateFacts = { commit: C, tree: C, base: C, patch: K, changed: [], closureTouched: false, keys: { writes: K, review: K, rulings: K } };
const st = { commit: C, tree: C, invKeys: {} };
const basePlan = parsePlan(JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [], nodes: ['a', 'b'].map(id => ({ id, writes: ['src/'], checks: [], review: { count: 0, min_rank: 1 } })) }));
function synthetic() {
  const entries: Entry[] = [], plans = new Map<string, Plan>();
  const add = (draft: Draft): Entry => {
    const e = { ...draft, seq: entries.length, ts: new Date(Date.UTC(2026, 0, 1) + entries.length * 1000).toISOString(), prev: entries.at(-1)?.hash ?? ZERO } as Entry;
    e.hash = entryHash(e); entries.push(e); return e;
  };
  const sha = H(basePlan); plans.set(sha, basePlan);
  add({ kind: 'genesis', by: 'owner:human', channel: 'tty', trunk: 'main', commit: C, plan: sha, state: st }); // 0
  add({ kind: 'dispatch', by: 'parent:drive', node: 'a', attempt: 1, base: C, branch: 'owed/a/1', worktree: '/wt/a', packet: K, rulings_seen: 0 }); // 1
  add({ kind: 'submit', by: 'writer:a#1', node: 'a', attempt: 1, facts }); // 2
  add({ kind: 'obs', by: 'executor:owed', subject: 'a', obligation: 'check:u', key: K, commit: C, verdict: 'pass', exit: 0, durationMs: 1 }); // 3: measured
  add({ kind: 'review', by: 'reviewer:r', node: 'a', attempt: 1, obligation: 'review', key: K, verdict: 'ok', rank: 1 }); // 4: accepted
  add({ kind: 'halt', by: 'parent:drive', node: 'a', attempt: 1, reason: 'repairs exhausted (2 of 2): review block #9 review', needs: 'human' }); // 5
  add({ kind: 'rule', by: 'parent:main', nodes: ['a'], text: 'one decision', decision: 6 } as Draft); // 6
  add({ kind: 'resume', by: 'parent:main', node: 'a', attempt: 1, decision: 6 } as Draft); // 7
  const next = structuredClone(basePlan); next.nodes[0]!.writes = ['src/', 'docs/']; const nsha = H(next); plans.set(nsha, next);
  add({ kind: 'plan', by: 'parent:main', prior: sha, plan: nsha, downgrades: [] }); // 8: legacy amend pair
  add({ kind: 'rule', by: 'parent:main', nodes: ['a'], text: 'writes of a widened by plan #8: docs/. Limit: notes only' }); // 9
  add({ kind: 'merge', by: 'executor:owed', node: 'a', attempt: 1, prior: C, commit: C, facts, state: st, lease_wait_ms: 3000 } as Draft); // 10
  add({ kind: 'obs', by: 'executor:owed', subject: 'trunk', obligation: 'inv:x', key: K, commit: C, verdict: 'pass', exit: 0, durationMs: 1, lease_wait_ms: 1000 } as Draft); // 11
  add({ kind: 'dispatch', by: 'parent:drive', node: 'b', attempt: 1, base: C, branch: 'owed/b/1', worktree: '/wt/b', packet: K, rulings_seen: 0 }); // 12
  add({ kind: 'halt', by: 'parent:drive', node: 'b', attempt: 1, reason: 'writer run r finished without submitting a candidate after follow-up s', needs: 'human' }); // 13
  add({ kind: 'rule', by: 'parent:main', nodes: ['b'], text: 'b only' }); // 14
  add({ kind: 'halt', by: 'parent:drive', node: 'b', attempt: 1, reason: 'merge tree does not pass inv:x (trunk passes); rebase → owed rebase b', needs: 'human' }); // 15
  return { entries, plans };
}

test('MX1 decisions (groups and legacy amend pairs once), acts per decision, merged-only acts, halts by class, phases, lease wait', () => {
  const { entries, plans } = synthetic();
  const m = computeMetrics(entries, plans);
  assert.equal(m.parentActs.total, 6);
  assert.equal(m.decisions, 4, 'genesis, decision #6 (rule+resume), amend pair #8/#9, rule #14');
  assert.equal(m.actsPerDecision, 1.5);
  assert.deepEqual(m.parentActs.mergedOnly, { total: 4, perMergedNode: 4 });
  assert.equal(m.interruptions.byClass['repairs-exhausted'], 1);
  assert.equal(m.interruptions.byClass['no-submit'], 1);
  assert.equal(m.interruptions.byClass.other, 1, 'text only: an AT1 halt is other; its state-based class is in --counterfactual');
  assert.equal(m.interruptions.byClass.shared, 0);
  assert.equal(Object.values(m.interruptions.byClass).reduce((a, b) => a + b, 0), m.interruptions.halts);
  assert.deepEqual(m.latency.phases.measure, { samples: 1, median: 1000, p90: 1000, max: 1000 });
  assert.deepEqual(m.latency.phases.review, { samples: 1, median: 1000, p90: 1000, max: 1000 });
  assert.deepEqual(m.latency.phases.mergeWait, { samples: 1, median: 6000, p90: 6000, max: 6000 });
  assert.deepEqual(m.latency.leaseWaitMs, { samples: 2, median: 2000, p90: 3000, max: 3000 });
  const text = renderMetrics(m).split('\n');
  assert.ok(text.includes('Halts by class (recorded text): no-submit 1, repairs-exhausted 1, other 1; state-based classes: owed report --counterfactual'), text.join('\n'));
  assert.ok(text.includes('Decisions: 4; parent acts per decision 1.5'));
  assert.ok(text.includes('Parent acts on merged nodes only: 4; per merged node 4'));
  assert.ok(text.includes('Phases of merged nodes: measure median 1s, p90 1s; review median 1s, p90 1s; merge wait median 6s, p90 6s'));
  assert.ok(text.includes('Machine lease wait: median 2s, p90 3s (2 samples)'));
  // A window starting after the merge: nothing merged, no lease samples, the lease line is omitted.
  const late = computeMetrics(entries, plans, { since: 11 });
  assert.equal(late.decisions, 1); assert.equal(late.parentActs.mergedOnly.total, 0); assert.equal(late.latency.leaseWaitMs.samples, 0);
  assert.ok(!renderMetrics(late).includes('Machine lease wait'));
});

// ---------- MX2: real git fixture with recorded driver halts ----------
const NAME = 'flaky lease renew';
const PASS = `ok 1 - ${NAME}\n1..1\n# tests 1\n# pass 1\n# fail 0\n`;
const FAIL = `not ok 1 - ${NAME}\n  ---\n  error: 'renew failed under load'\n  ...\n1..1\n# tests 1\n# pass 0\n# fail 1\n`;
async function sharedRepo(schedule: string[], nodes: { id: string; file: string; brief?: string }[]) {
  const r = await repo();
  await r.put('README', 'base'); await r.commit();
  const sched = join(r.root, 'schedule'), counter = join(r.root, 'counter');
  await writeFile(join(r.root, 'pass.tap'), PASS); await writeFile(join(r.root, 'fail.tap'), FAIL); await writeFile(sched, schedule.join('\n') + '\n');
  const run = `n=$(cat '${counter}' 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > '${counter}'; if [ "$(sed -n "\${n}p" '${sched}')" = fail ]; then cat '${join(r.root, 'fail.tap')}'; exit 1; fi; cat '${join(r.root, 'pass.tap')}'`;
  const plan = { version: 1, trunk: 'main', lease: false, closure: [], drive: { min_free_mb: 0 }, invariants: [{ id: 'x', run, min_tests: 1, reads: ['src/**'] }], nodes: nodes.map(n => ({ id: n.id, writes: [n.file], ...(n.brief ? { brief: n.brief } : {}) })) };
  await ops.init({ cwd: r.cwd, plan: JSON.stringify(plan), as: owner, channel: 'delegated' });
  const worktrees = new Map<string, string>();
  const candidate = async (id: string, text = id) => {
    const n = nodes.find(x => x.id === id)!, d = await ops.dispatch({ cwd: r.cwd, node: id, as: parent });
    worktrees.set(id, d.worktree);
    await commitAt(d.worktree, { [n.file]: text });
    await ops.submit({ cwd: d.worktree, node: id, as: { role: 'writer', id: `${id}#1` } });
  };
  const accept = async (id: string) => { await candidate(id); assert.equal((await ops.attest({ cwd: r.cwd, node: id })).accepted, true); };
  const halt = (node: string, reason: string) => ops.halt({ cwd: r.cwd, as: DRIVE_PRINCIPAL, node, attempt: 1, reason, needs: 'human' });
  const rule = (node: string, text: string) => ops.rule({ cwd: r.cwd, as: parent, text, nodes: [node], prospective: true });
  return { ...r, candidate, accept, halt, rule, ledgerFile: join(r.root, 'ledger', 'ledger.jsonl') };
}
/** Every file under `dir` with its size, mtime and content: a write anywhere changes it. */
async function fingerprint(dir: string): Promise<string> {
  const out: string[] = [];
  for (const name of (await readdir(dir, { recursive: true })).sort()) {
    const path = join(dir, name), info = await stat(path);
    out.push(info.isFile() ? `${name} ${info.size} ${info.mtimeMs} ${H(await readFile(path, 'utf8'))}` : `${name}/`);
  }
  return out.join('\n');
}
const refused = async (p: Promise<unknown>): Promise<Error> => { try { await p; } catch (e) { return e as Error; } assert.fail('expected a refusal'); };
const AT1 = (node: string) => `merge tree does not pass inv:x (trunk passes); trunk moved 1 commits since the slot base: rebase → owed rebase ${node}`;

test('MX2 counterfactual: shared, fix-wait, clean rebase, conflicting rebase and unchanged halts; acts until the next driver action; read-only CLI', { timeout: 300_000 }, async () => {
  const r = await sharedRepo(['pass', 'fail', 'fail', 'fail'], [
    { id: 'a', file: 'src/a' }, { id: 'b', file: 'src/b' }, { id: 'c', file: 'src/c' }, { id: 'd', file: 'src/d' }, { id: 'e', file: 'src/other' },
    { id: 'f', file: 'src/f', brief: `fix ${NAME}` }]);
  try {
    await r.accept('a'); await r.accept('b');
    await refused(ops.merge({ cwd: r.cwd, node: 'b', as: parent }));
    await ops.abandon({ cwd: r.cwd, node: 'b', reason: 'fixture', hold: true, as: owner, channel: 'delegated' } as Parameters<typeof ops.abandon>[0]);
    assert.ok(await refused(ops.merge({ cwd: r.cwd, node: 'a', as: parent })) instanceof ops.SharedRefusal);
    // The pre-0.23 driver halted here; the parent resumed by hand.
    const h1 = await r.halt('a', AT1('a'));
    await ops.resume({ cwd: r.cwd, node: 'a', as: parent });
    await r.accept('f'); // an accepted fix candidate names the failing test
    const h2 = await r.halt('a', AT1('a'));
    const ruleA = await r.rule('a', 'wait for f');
    // d: an ordinary review halt, then the driver merges it (its next action).
    await r.accept('d');
    const h3 = await r.halt('d', 'review block #1 review needs a parent ruling: scope');
    const ruleD = await r.rule('d', 'scope is fine');
    await ops.merge({ cwd: r.cwd, node: 'd', as: parent });
    const lateRule = await r.rule('d', 'after the driver acted');
    // c rebases cleanly; e conflicts with a trunk commit on its own file.
    await r.candidate('c'); await r.candidate('e', 'from e');
    await commitAt(r.cwd, { 'src/other': 'from trunk' });
    await ops.adopt({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'trunk edits src/other' });
    const h4 = await r.halt('c', AT1('c'));
    const ruleC = await r.rule('c', 'rebase it');
    const rebaseC = (await ops.rebase({ cwd: r.cwd, node: 'c', as: parent })).entry;
    const h5 = await r.halt('e', AT1('e'));
    const rebaseE = (await ops.rebase({ cwd: r.cwd, node: 'e', as: parent })).entry;
    await new Promise(res => setTimeout(res, 200)); // unawaited plan-cache writes of earlier acts settle
    const dir = join(r.root, 'ledger'), objects = join(r.cwd, '.git', 'objects');
    const before = await fingerprint(dir), objectsBefore = await fingerprint(objects), folds = counterfactualStats.folds;
    const progress: string[] = [];
    const c = await ops.reportCounterfactual({ cwd: r.cwd, progress: line => progress.push(line) });
    assert.equal(counterfactualStats.folds, folds + 1);
    assert.deepEqual(progress, [`replaying ${(await (await Ledger.open(r.cwd)).read()).length} entries to classify 5 halts (cold; about one full replay)`]);
    assert.equal(await fingerprint(dir), before, 'no ledger, snapshot or cache write');
    assert.equal(await fingerprint(objects), objectsBefore, 'merge-tree wrote no repository objects');
    const row = (seq: number) => c.rows.find(x => x.seq === seq)!;
    const entries = (await (await Ledger.open(r.cwd)).read());
    const resumeSeq = entries.find(e => e.kind === 'resume' && e.node === 'a')!.seq;
    assert.equal(c.halts, 5);
    assert.deepEqual([row(h1.seq).class, row(h1.seq).acts, row(h1.seq).saved], ['shared', [resumeSeq], 1]);
    assert.deepEqual([row(h2.seq).class, row(h2.seq).acts, row(h2.seq).saved], ['fix-wait', [ruleA.seq], 1]);
    assert.deepEqual([row(h3.seq).class, row(h3.seq).acts, row(h3.seq).saved, row(h3.seq).merged], ['unchanged', [ruleD.seq], 0, true], 'the merge ends the window before the late rule');
    assert.ok(!row(h3.seq).acts.includes(lateRule.seq));
    assert.deepEqual([row(h4.seq).class, row(h4.seq).acts, row(h4.seq).saved], ['clean-rebase', [ruleC.seq, rebaseC.seq], 1]);
    assert.equal(row(h4.seq).rebase?.seq, rebaseC.seq);
    assert.deepEqual([row(h5.seq).class, row(h5.seq).acts, row(h5.seq).saved, row(h5.seq).rebase?.seq], ['unchanged', [rebaseE.seq], 0, rebaseE.seq]);
    assert.deepEqual(c.totals.shared, { halts: 1, acts: 1, saved: 1 });
    assert.deepEqual(c.totals['fix-wait'], { halts: 1, acts: 1, saved: 1 });
    assert.deepEqual(c.totals['clean-rebase'], { halts: 1, acts: 2, saved: 1 });
    assert.deepEqual(c.totals.unchanged, { halts: 2, acts: 2, saved: 0 });
    assert.deepEqual(c.merged, [{ node: 'd', halts: 1, acts: 1, saved: 0 }]);
    // --since bounds the halts; the CLI prints totals and --json gives the rows; nothing is written.
    assert.equal((await ops.reportCounterfactual({ cwd: r.cwd, since: h3.seq })).halts, 2);
    const jsonRun = await cli(r.cwd, ['report', '--counterfactual', '--json']);
    assert.match(jsonRun.stderr, /^replaying \d+ entries to classify 5 halts \(cold; about one full replay\)$/m);
    const json = JSON.parse(jsonRun.stdout) as Counterfactual;
    assert.deepEqual(json.rows.map(x => [x.seq, x.class]), c.rows.map(x => [x.seq, x.class]));
    const text = (await cli(r.cwd, ['report', '--counterfactual'])).stdout.trim();
    assert.equal(text, renderCounterfactual(c));
    assert.match(text, /^Counterfactual \(since start\): 5 driver halts; 3 of 6 parent acts after them would be unnecessary under 0\.23$/m);
    assert.match(text, /^ {2}shared: 1 halts, 1 of 1 acts unnecessary$/m);
    assert.match(text, /^ {2}d: 1 halts, 0 of 1 acts unnecessary$/m);
    assert.equal((await cli(r.cwd, ['report', '--counterfactual', '--metrics'])).code, 2);
    assert.equal(await fingerprint(dir), before, 'the CLI counterfactual wrote nothing');
    assert.equal(await fingerprint(objects), objectsBefore);
    // MX1 on the same ledger: text classes only and no cold fold (ruling #2572).
    const foldsBefore = counterfactualStats.folds;
    const m = await ops.reportMetrics({ cwd: r.cwd });
    assert.equal(counterfactualStats.folds, foldsBefore, 'report --metrics never folds');
    assert.equal(m.interruptions.byClass.review, 1); assert.equal(m.interruptions.byClass.other, 4); assert.equal(m.interruptions.byClass.shared, 0);
    const metricsRun = await cli(r.cwd, ['report', '--metrics']);
    assert.match(metricsRun.stdout, /^Halts by class \(recorded text\): review 1, other 4; state-based classes: owed report --counterfactual$/m);
    assert.doesNotMatch(metricsRun.stderr, /replaying/);
  } finally { await r.cleanup(); }
});

test('MX2 ER: a missing commit or a row without a candidate is unknown, never clean', { timeout: 60_000 }, async () => {
  const r = await repo();
  try {
    await r.put('README', 'x'); const head = await r.commit();
    const rows: CounterRow[] = [
      { seq: 1, node: 'a', attempt: 1, reason: 'r', class: 'unchanged', acts: [], saved: 0, merged: false, rebase: { seq: 2, from: head, base: head, candidate: '0'.repeat(40) } },
      { seq: 3, node: 'b', attempt: 1, reason: 'r', class: 'unchanged', acts: [], saved: 0, merged: false, rebase: { seq: 4, from: head, base: head } },
      { seq: 5, node: 'c', attempt: 1, reason: 'r', class: 'shared', acts: [], saved: 0, merged: false, rebase: { seq: 6, from: head, base: head, candidate: head } }];
    await classifyRebases(r.cwd, rows);
    assert.deepEqual(rows.map(x => x.class), ['unknown', 'unknown', 'shared']);
  } finally { await r.cleanup(); }
});

// ---------- MX3: lease_wait_ms on obs and merge entries ----------
const FAKE = `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.env.LEASE_TEST_DIR, args = process.argv.slice(2), sep = args.indexOf('--');
const log = value => appendFileSync(join(dir, 'holds'), JSON.stringify(value)+'\\n');
if (args[0] === 'describe') { console.log(JSON.stringify({state:'sealed',status:'done',calls:[{key:'main',gen:1,status:'ok'}]})); process.exit(0); }
if (args[0] !== 'hold') process.exit(2);
log({ event: 'request', pid: process.pid });
const deadline = Date.now()+30000;
while (existsSync(join(dir, 'before-ready'))) { if (Date.now()>deadline) process.exit(1); await new Promise(r=>setTimeout(r,25)); }
const p = spawn(args[sep+1], args.slice(sep+2), { stdio: 'inherit', detached: true });
log({ event: 'granted', pid: process.pid, child: p.pid });
for (const s of ['SIGTERM','SIGINT','SIGHUP']) process.on(s,()=>{ try { process.kill(-p.pid,s); } catch {} });
p.on('close', code=>{ log({event:'released',code}); process.exit(code??1); });
`;
test('MX3 lease_wait_ms: recorded on leased obs and merge entries, absent without a lease, strictly validated, reported as a median', { timeout: 120_000 }, async () => {
  const r = await repo(), bin = join(r.root, 'fake-dsa.mjs');
  const prior = { OWED_DSA: process.env.OWED_DSA, LEASE_TEST_DIR: process.env.LEASE_TEST_DIR, OWED_LEASED: process.env.OWED_LEASED };
  process.env.OWED_DSA = bin; process.env.LEASE_TEST_DIR = r.root; delete process.env.OWED_LEASED;
  await writeFile(bin, FAKE); await chmod(bin, 0o755);
  const holds = (): { event: string; child?: number; pid?: number }[] => (existsSync(join(r.root, 'holds')) ? readFileSync(join(r.root, 'holds'), 'utf8') : '').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  try {
    const check = { id: 'u', run: `printf '1..1\\nok 1 - u\\n'`, reads: ['src/**'], min_tests: 1 };
    const plan = { version: 1, trunk: 'main', closure: [], invariants: [], drive: { min_free_mb: 0 }, nodes: ['a', 'b'].map(id => ({ id, writes: [`src/${id}`], checks: [check], review: { count: 0, min_rank: 1 } })) };
    await r.put('README', 'fixture'); await r.commit();
    await ops.init({ cwd: r.cwd, as: owner, channel: 'flag', plan: JSON.stringify(plan) });
    for (const id of ['a', 'b']) {
      const d = await ops.dispatch({ cwd: r.cwd, node: id, as: parent });
      await commitAt(d.worktree, { [`src/${id}`]: id });
      await ops.submit({ cwd: d.worktree, node: id, as: { role: 'writer', id: `${id}#1` } });
    }
    const requested = holds().filter(h => h.event === 'request').length;
    await writeFile(join(r.root, 'before-ready'), '');
    const waiting = ops.attest({ cwd: r.cwd, node: 'a' });
    const t0 = Date.now();
    while (holds().filter(h => h.event === 'request').length === requested) { assert.ok(Date.now() - t0 < 15_000); await new Promise(res => setTimeout(res, 25)); }
    await new Promise(res => setTimeout(res, 400));
    await rm(join(r.root, 'before-ready'));
    assert.equal((await waiting).accepted, true);
    await ops.attest({ cwd: r.cwd, node: 'b', lease: false } as Parameters<typeof ops.attest>[0]);
    await ops.merge({ cwd: r.cwd, node: 'a', as: parent });
    const entries = await (await Ledger.open(r.cwd)).read();
    const obsA = entries.filter(e => e.kind === 'obs' && e.subject === 'a' && e.merging === undefined), obsB = entries.filter(e => e.kind === 'obs' && e.subject === 'b');
    const merge = entries.find(e => e.kind === 'merge')!;
    assert.ok(obsA.length && obsA.every(e => e.kind === 'obs' && e.lease_wait_ms !== undefined && e.lease_wait_ms >= 350), JSON.stringify(obsA));
    assert.ok(obsB.length && obsB.every(e => e.kind === 'obs' && e.lease_wait_ms === undefined), 'no lease, no field');
    assert.ok(merge.kind === 'merge' && Number.isSafeInteger(merge.lease_wait_ms) && merge.lease_wait_ms! >= 0);
    assert.ok(entries.filter(e => e.kind === 'obs' && e.merging === 'a').every(e => e.kind === 'obs' && Number.isSafeInteger(e.lease_wait_ms)), 'merge measurements carry the merge wait');
    assert.equal((await ops.verify({ cwd: r.cwd })).ok, true, 'a ledger with lease waits replays');
    // Strict validation of the optional field on both kinds; a known field never needs a newer owed.
    const { state } = await ops.readState({ cwd: r.cwd });
    const strip = (e: Entry): Draft => { const { seq: _s, ts: _t, prev: _p, hash: _h, ...d } = e; return d as Draft; };
    for (const base of [strip(obsA[0]!), strip(merge)]) {
      for (const bad of [-1, 1.5, '7', null]) assert.ok(validateDraft(state, { ...base, lease_wait_ms: bad } as Draft).some(x => /lease_wait_ms must be a non-negative integer/.test(x)), `${base.kind} ${String(bad)}`);
      assert.ok(!validateDraft(state, { ...base, lease_wait_ms: 12 } as Draft).some(x => /lease_wait_ms/.test(x)));
    }
    assert.equal(newerEntry(obsA[0]!), undefined);
    assert.match(newerEntry({ ...obsA[0]!, lease_wait_msx: 1 } as unknown as Entry)?.message ?? '', /needs a newer owed/);
    const m = await ops.reportMetrics({ cwd: r.cwd }), waits = entries.flatMap(e => (e.kind === 'obs' || e.kind === 'merge') && e.lease_wait_ms !== undefined ? [e.lease_wait_ms] : []).sort((x, y) => x - y);
    assert.equal(m.latency.leaseWaitMs.samples, waits.length);
    const n = waits.length; assert.equal(m.latency.leaseWaitMs.median, (waits[Math.floor((n - 1) / 2)]! + waits[Math.floor(n / 2)]!) / 2);
    assert.match(renderMetrics(m as Metrics), /^Machine lease wait: median \d/m);
  } finally {
    await rm(join(r.root, 'before-ready'), { force: true });
    for (const h of holds()) if (h.event === 'granted' && h.child) for (const pid of [h.child, h.pid!]) try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
    for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    await r.cleanup();
  }
});
