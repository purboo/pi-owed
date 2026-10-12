// RC1–RC3 (0.13): repeat voting, explicit counts, and actionable failure receipts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { H } from '../src/canon.ts';
import { parsePlan } from '../src/plan.ts';
import { candidateFacts, stateFacts, git } from '../src/git.ts';
import { parseCounts, runJob } from '../src/exec.ts';
import { Ledger } from '../src/ledger.ts';
import { reduce, newerEntry, uncoveredDowngrades, runId, runLabels, entriesOf } from '../src/reducer.ts';
import { decide, repairMessage, type DriveOpts } from '../src/drive.ts';
import { renderReceipt, receipt } from '../src/views.ts';
import { Driver, DRIVE_PRINCIPAL } from '../src/drive-run.ts';
import { Dsa } from '../src/dsa.ts';
import * as ops from '../src/ops.ts';
import type { CheckSpec, Entry, AttestJob, ObsEntry, Plan } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { commitAt } from './helpers/surface.ts';

const owner = { role: 'owner', id: 'pi' } as const, parent = { role: 'parent', id: 'main' } as const;
const planWith = (check: object, invariant = false) => JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: invariant ? [{ id: 'x', run: 'true', ...check }] : [], nodes: [{ id: 'a', writes: ['src/'], checks: invariant ? [] : [{ id: 'x', run: 'true', ...check }] }] });
const count = (pass: number, fail: number, failed?: string[]) => `echo '${JSON.stringify({ pass, fail, ...(failed ? { failed } : {}) })}'`;
const owedCount = (pass: number, fail: number, failed?: string[]) => `printf 'owed-counts '; ${count(pass, fail, failed)}`;

async function fixture() {
  const r = await repo();
  await r.put('src/value', 'base'); const base = await r.commit();
  await r.put('src/value', 'candidate'); const commit = await r.commit();
  const plan = parsePlan(planWith({})), ledger = await Ledger.open(r.cwd);
  const job: AttestJob = { kind: 'check', subject: 'a', obligation: 'check:x', key: 'k', base, commit, spec: plan.nodes[0]!.checks[0] };
  return { ...r, plan, ledger, job, run: (run: string, extra: Partial<CheckSpec> = {}, kind: AttestJob['kind'] = 'check') => runJob({ cwd: r.cwd, plan, ledger }, { ...job, kind, spec: { ...job.spec!, run, ...extra } }) };
}
test('RC2 #1274: only column-0 owed-counts is protocol, never a real TAP diagnostic', async () => {
  const f = await fixture();
  try {
    const code = "import test from 'node:test'; import assert from 'node:assert/strict'; test('real diagnostic failure', () => assert.fail('line one\\nowed-counts {\"pass\":0,\"fail\":0}\\nline three'));";
    await f.put('test/diagnostic.mjs', code); const commit = await f.commit();
    const obs = await runJob({ cwd: f.cwd, plan: f.plan, ledger: f.ledger }, { ...f.job, base: commit, commit, kind: 'red', spec: { ...f.job.spec!, run: 'node --test --test-reporter=tap test/diagnostic.mjs', red_expect: 'real diagnostic failure' } });
    const log = (await f.ledger.getBlob(obs.log!)).toString(), warnings: string[] = [];
    assert.match(log, /^    owed-counts /m, 'real node TAP diagnostic contains the example');
    assert.equal(parseCounts(log, n => warnings.push(n))?.format, 'tap');
    assert.equal(obs.counts?.tests, 1); assert.equal(obs.verdict, 'pass'); assert.equal(obs.note, undefined);
    for (const line of [' owed-counts {"pass":0,"fail":0}', '\towed-counts broken', '# owed-counts broken']) {
      assert.equal(parseCounts(`${line}\n# tests 1\n# pass 1\n# fail 0`, n => warnings.push(n))?.format, 'tap');
    }
    assert.equal(warnings.length, 0, 'indented/comment occurrences are silently ignored');
    assert.deepEqual(parseCounts('owed-counts {"pass":2,"fail":1}\r\n'), { format: 'owed', tests: 3, pass: 2, fail: 1 });
    assert.equal(parseCounts('owed-counts\t{"pass":1,"fail":0}')?.format, 'owed');
    parseCounts('owed-counts broken', n => warnings.push(n)); assert.equal(warnings.length, 1, 'malformed column-0 protocol is still noted');
  } finally { await f.cleanup(); }
});

test('RC3 #1274: a red_expect mismatch has failing names before its bounded tail', async () => {
  const f = await fixture();
  try {
    const run = "for n in $(seq 1 30); do echo \"line $n\"; done; echo 'not ok 1 - unrelated failing test'; echo '# tests 1'; echo '# pass 0'; echo '# fail 1'; exit 1";
    const obs = await f.run(run, { red_expect: 'expected failure only' }, 'red');
    assert.equal(obs.verdict, 'fail'); assert.deepEqual(obs.failed, ['unrelated failing test']);
    assert.ok(obs.note?.startsWith('failed tests: unrelated failing test;'), obs.note);
    assert.match(obs.note!, /last output:/); assert.ok(obs.note!.split('\n').length <= 16);
    assert.doesNotMatch(obs.note!, /\n  line 1\n/);
    const pass = await f.run(run, { red_expect: 'unrelated failing test' }, 'red');
    assert.equal(pass.verdict, 'pass'); assert.equal(pass.note, undefined, 'successful red semantics stay unchanged');
  } finally { await f.cleanup(); }
});

test('RC3 #1274: reused failed invariant keeps names and tail on second merge and driver halt', { timeout: 60_000 }, async () => {
  const r = await repo();
  try {
    const run = `if [ ! -f src/value ]; then ${owedCount(1, 0)}; else echo 'stored diagnostic tail'; ${owedCount(0, 1, ['reused merge gate'])}; exit 1; fi`;
    const plan = planWith({ run, min_tests: 1, reads: ['src/**'] }, true);
    await r.put('README', 'base'); const base = await r.commit();
    await ops.init({ cwd: r.cwd, plan, as: owner, channel: 'delegated' });
    const d = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
    await commitAt(d.worktree, { 'src/value': 'new' });
    await ops.submit({ cwd: d.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
    await ops.attest({ cwd: r.cwd, node: 'a' });
    const ledger = await Ledger.open(r.cwd), before = await ledger.read(), project = before[0]!.hash.slice(0, 12), rid = runId(project, 'a', 1, 'writer');
    await ops.launch({ cwd: r.cwd, as: DRIVE_PRINCIPAL, node: 'a', attempt: 1, role: 'writer', rid, spec: '{}', labels: runLabels(project, 'a', 1, 'writer') });
    for (let attempt = 0; attempt < 2; attempt++) {
      await assert.rejects(ops.merge({ cwd: r.cwd, node: 'a', as: parent }), e => {
        assert.ok(e instanceof Error); assert.match(e.message, /failed tests: reused merge gate; last output:/); assert.match(e.message, /stored diagnostic tail/); return true;
      });
    }
    const countFailed = async () => (await ledger.read()).filter(e => e.kind === 'obs' && e.merging === 'a' && e.obligation === 'inv:x').length;
    assert.equal(await countFailed(), 1, 'second refusal reuses the stored observation, never reruns');
    class SealedDsa extends Dsa { override async inspect(rid: string) { return { view: { rid, state: 'sealed' as const, status: 'ok' } }; } }
    const driver = new Driver({ cwd: r.cwd, log: () => {}, handleSignals: false, session: null, dsa: new SealedDsa({ bin: '/no-dsa-rc3' }), max: 1 });
    const start = await driver.pass(); assert.ok(start.actions.some(a => a.do === 'merge' && a.outcome === 'started'), JSON.stringify(start.actions));
    assert.equal(await driver.drain(30_000), true);
    const report = (await driver.pass()).actions.find(a => a.do === 'merge');
    assert.equal(report?.outcome, 'refused'); assert.match(report?.detail ?? '', /failed tests: reused merge gate/); assert.match(report?.detail ?? '', /stored diagnostic tail/);
    const halt = (await ledger.read()).findLast(e => e.kind === 'halt');
    assert.ok(halt?.kind === 'halt'); assert.match(halt.reason, /failed tests: reused merge gate; last output:/); assert.match(halt.reason, /stored diagnostic tail/);
    assert.equal(await countFailed(), 1); assert.equal((await ops.status({ cwd: r.cwd })).trunk.commit, base);
  } finally { await r.cleanup(); }
});

// State is inside the measurement tree: a new materialization or repeated setup would reset it.
const sequence = (verdicts: string) => `n=$(cat counter 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > counter; v=$(printf '${verdicts}' | cut -c "$n"); if [ "$v" = p ]; then ${owedCount(1, 0)}; else ${owedCount(0, 1, ['latency gate'])}; exit 1; fi`;

test('RC1: parser validates repeat on checks and invariants and normalizes default need', () => {
  for (const invariant of [false, true]) {
    const p = parsePlan(planWith({ repeat: { runs: 3 } }, invariant));
    assert.deepEqual((invariant ? p.invariants : p.nodes[0]!.checks)[0]!.repeat, { runs: 3, need: 3 });
    for (const repeat of [null, [], 3, {}, { runs: 0 }, { runs: 10 }, { runs: 1.5 }, { runs: '2' }, { runs: 3, need: null }, { runs: 3, need: 0 }, { runs: 3, need: 4 }, { runs: 3, need: 1.5 }, { runs: 3, other: 1 }]) assert.throws(() => parsePlan(planWith({ repeat }, invariant)), /repeat/);
  }
  assert.throws(() => parsePlan(planWith({ repeat: { runs: 2 }, red: true, tests: ['test/**'] })), /not allowed on red or mutants/);
  assert.throws(() => parsePlan(planWith({ repeat: { runs: 2 }, mutants: ['mutant.patch'] })), /not allowed on red or mutants/);
});

test('RC1: repeat changes check and invariant keys; no repeat preserves the old key', async () => {
  const f = await fixture();
  try {
    const plain = f.job.spec!, specs = [plain, { ...plain, repeat: { runs: 2 } }, { ...plain, repeat: { runs: 2, need: 2 } }, { ...plain, repeat: { runs: 2, need: 1 } }];
    const keys: string[] = [], invKeys: string[] = [];
    for (const c of specs) {
      const plan: Plan = { ...f.plan, invariants: [c], nodes: [{ ...f.plan.nodes[0]!, checks: [c] }] };
      keys.push((await candidateFacts(f.cwd, plan, plan.nodes[0]!, f.job.base, f.job.commit, 1)).keys['check:x']!);
      invKeys.push((await stateFacts(f.cwd, plan, f.job.commit)).invKeys.x!);
    }
    assert.equal(keys[1], keys[2]); assert.equal(invKeys[1], invKeys[2]);
    assert.notEqual(keys[0], keys[1]); assert.notEqual(keys[1], keys[3]); assert.notEqual(invKeys[0], invKeys[1]); assert.notEqual(invKeys[1], invKeys[3]);
    // Before RC1, this is exactly the check key for a tree with no closure/read content.
    const empty = { ...plain, reads: [] }, p = { ...f.plan, nodes: [{ ...f.plan.nodes[0]!, checks: [empty] }] };
    const key = (await candidateFacts(f.cwd, p, p.nodes[0]!, f.job.base, f.job.commit, 1)).keys['check:x'];
    assert.equal(key, H({ o: 'check', id: 'x', run: 'true', timeout_s: 600, closure: H([]), reads: H([]) }));
    assert.ok(uncoveredDowngrades(f.plan, { ...f.plan, nodes: [{ ...f.plan.nodes[0]!, checks: [specs[3]!] }] }).some(d => /repeat/.test(d.what)), 'changing acceptance votes needs owner authority');
  } finally { await f.cleanup(); }
});

test('RC1: sequential same-tree votes stop early for pass and fail, without summing min_tests', async () => {
  const f = await fixture();
  try {
    f.plan.setup = 'echo 0 > counter';
    for (const [votes, runs, need, executed, verdict] of [['ppfff', 5, 2, 2, 'pass'], ['ffppp', 5, 4, 2, 'fail'], ['pfpff', 5, 2, 3, 'pass'], ['f', 9, 9, 1, 'fail']] as const) {
      const obs = await f.run(sequence(votes), { repeat: { runs, need }, min_tests: 1 });
      assert.equal(obs.verdict, verdict, obs.note); assert.equal(obs.runs?.length, executed);
      assert.equal(obs.counts?.tests, 1, 'counts stay per-run, not summed');
      assert.equal(obs.noisy, votes.slice(0, executed).includes('p') && votes.slice(0, executed).includes('f'));
      for (const run of obs.runs!) { assert.equal(typeof run.durationMs, 'number'); assert.ok(run.durationMs >= 0); assert.ok((await f.ledger.getBlob(run.log)).toString().includes('owed-counts')); assert.equal(run.counts?.tests, 1); }
    }
    const thin = await f.run(sequence('ppp'), { repeat: { runs: 3, need: 2 }, min_tests: 2 });
    assert.equal(thin.verdict, 'fail'); assert.equal(thin.runs?.length, 2);
    assert.equal((await f.run(owedCount(1, 0))).runs, undefined, 'non-repeat observations keep old shape');
  } finally { await f.cleanup(); }
});

test('RC1: execution and environment errors stop repeat with an error receipt and dispose the tree', async () => {
  const f = await fixture();
  try {
    const before = (await git(f.cwd, ['worktree', 'list', '--porcelain'])).stdout;
    for (const [run, note] of [['echo ENOSPC; exit 1', /^environment:/], ['owed-absent-command-rc1', /exit 127/], ['sleep 5', /timeout/]] as const) {
      const obs = await f.run(run, { repeat: { runs: 3, need: 1 }, timeout_s: 1 });
      assert.equal(obs.verdict, 'error'); assert.match(obs.note!, note); assert.equal(obs.runs?.length, 1); assert.equal(obs.runs![0]!.verdict, 'error');
    }
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), 100);
    try {
      const obs = await runJob({ cwd: f.cwd, plan: f.plan, ledger: f.ledger, signal: abort.signal }, { ...f.job, spec: { ...f.job.spec!, run: 'sleep 5', repeat: { runs: 3, need: 1 } } });
      assert.equal(obs.verdict, 'error'); assert.equal(obs.runs?.length, 1); assert.match(obs.note!, /aborted/);
    } finally { clearTimeout(timer); }
    assert.equal((await git(f.cwd, ['worktree', 'list', '--porcelain'])).stdout, before);
    assert.equal(await readFile(join(f.cwd, 'src/value'), 'utf8'), 'candidate');
  } finally { await f.cleanup(); }
});

test('RC2: last valid owed-counts wins over every format and malformed lines are noted', () => {
  const warnings: string[] = [];
  const log = 'owed-counts {"pass":2,"fail":1,"failed":["first"]}\n# tests 99\n# pass 99\n# fail 0\n' + 'owed-counts {"pass":4,"fail":0,"skip":2}\nowed-counts not-json';
  assert.deepEqual(parseCounts(log, n => warnings.push(n)), { format: 'owed', tests: 6, pass: 4, fail: 0, skip: 2 }); assert.equal(warnings.length, 1);
  for (const json of ['[]', 'null', '{}', '{"pass":-1,"fail":0}', '{"pass":1.1,"fail":0}', '{"pass":"1","fail":0}', '{"pass":1,"fail":0,"skip":-1}', '{"pass":1,"fail":0,"failed":[1]}']) {
    const warnings: string[] = [];
    assert.deepEqual(parseCounts(`owed-counts ${json}\n# tests 1\n# pass 1\n# fail 0`, n => warnings.push(n)), { format: 'tap', tests: 1, pass: 1, fail: 0 }); assert.equal(warnings.length, 1);
  }
  const names = Array.from({ length: 80 }, (_, n) => `failed ${n}`);
  assert.deepEqual(parseCounts(`owed-counts ${JSON.stringify({ pass: 0, fail: 80, failed: names })}`)?.failed, names.slice(0, 50));
});

test('RC2: owed fail counts reject exit 0; malformed-only logs retain existing no-count semantics', async () => {
  const f = await fixture();
  try {
    const fail = await f.run(owedCount(0, 1, ['gate']), { min_tests: 1 });
    assert.equal(fail.verdict, 'fail'); assert.equal(fail.exit, 0); assert.deepEqual(fail.failed, ['gate']);
    const warned = await f.run(`${owedCount(1, 0)}; echo 'owed-counts broken'`, { min_tests: 1 });
    assert.equal(warned.verdict, 'pass'); assert.match(warned.note!, /malformed owed-counts/);
    const bad = await f.run("echo 'owed-counts broken'; exit 1", { min_tests: 1 });
    assert.equal(bad.verdict, 'fail'); assert.match(bad.note!, /malformed owed-counts/);
    const uncounted = await f.run("echo 'not ok 1 - uncounted gate'; exit 1");
    assert.deepEqual(uncounted.failed, ['uncounted gate']); assert.ok(uncounted.note?.startsWith('failed tests: uncounted gate'));
    const errors = await f.run("echo 'owed-counts broken'", { min_tests: 1 });
    assert.equal(errors.verdict, 'error'); assert.match(errors.note!, /malformed owed-counts/);
    const tap = await f.run("echo '# tests 1'; echo '# pass 0'; echo '# fail 1'", { min_tests: 1 });
    assert.equal(tap.verdict, 'pass', 'existing TAP exit semantics are unchanged');
  } finally { await f.cleanup(); }
});

test('RC3: TAP and cargo keep at most 50 failing names, without counting diagnostic cargo text', () => {
  assert.deepEqual(parseCounts('not ok 1 - latency gate\n# tests 1\n# pass 0\n# fail 1')?.failed, ['latency gate']);
  const cargo = 'test module::gate ... FAILED\ntest result: FAILED. 0 passed; 1 failed; 0 ignored;';
  assert.deepEqual(parseCounts(cargo)?.failed, ['module::gate']);
  assert.deepEqual(parseCounts(`${cargo}\nnot ok 1 - tap gate\n# tests 1\n# pass 0\n# fail 1`)?.failed, ['module::gate', 'tap gate']);
  const names = Array.from({ length: 60 }, (_, n) => `not ok ${n + 1} - gate ${n}`);
  assert.equal(parseCounts(`${names.join('\n')}\n1..60`)?.failed?.length, 50);
});

test('RC3: failed notes, why, repair and halt show names before a tail of at most 15 lines', async () => {
  const f = await fixture();
  try {
    const names = Array.from({ length: 50 }, (_, n) => `latency gate ${n}`), obs = await f.run(`for n in $(seq 1 30); do echo "line $n"; done; ${owedCount(0, 50, names)}; exit 1`, { min_tests: 1 });
    assert.ok(obs.note!.startsWith('failed tests: latency gate 0')); assert.ok(obs.note!.split('\n').length <= 16); assert.doesNotMatch(obs.note!, /\n  line 1\n/);
    const es: Entry[] = [], add = (draft: object) => { const e = { ...draft, seq: es.length, ts: new Date().toISOString(), prev: 'x', hash: 'project' } as Entry; es.push(e); return e; };
    add({ kind: 'genesis', by: 'owner:pi', channel: 'delegated', plan: 'p', trunk: 'main', commit: f.job.base, state: { commit: f.job.base, tree: 'base', invKeys: {} } });
    add({ kind: 'dispatch', by: 'parent:drive', node: 'a', attempt: 1, base: f.job.base, branch: 'owed/a/1', worktree: f.cwd, packet: 'p', rulings_seen: -1 });
    const rid = runId('project', 'a', 1, 'writer');
    add({ kind: 'launch', by: 'parent:drive', node: 'a', attempt: 1, role: 'writer', rid, spec: 'a'.repeat(64), labels: runLabels('project', 'a', 1, 'writer') });
    const facts = await candidateFacts(f.cwd, f.plan, f.plan.nodes[0]!, f.job.base, f.job.commit, 1);
    add({ kind: 'submit', by: 'writer:a#1', node: 'a', attempt: 1, facts });
    add({ ...obs, key: facts.keys['check:x'] });
    add({ ...obs, obligation: 'writes', key: facts.keys.writes, verdict: 'pass', note: undefined, failed: undefined });
    const s = reduce(es, () => f.plan), why = renderReceipt(receipt(s, entriesOf(s), 'a')), repair = repairMessage(s, 'a');
    for (const text of [why, repair]) { assert.ok(text.includes('latency gate 49')); assert.ok(text.indexOf('failed tests:') < text.indexOf('last output:')); }
    const opts: DriveOpts = { max: 1, repairs: 0, project: 'project', root: f.cwd, applied: new Set(), rejected: new Map(), blobs: new Map() };
    const actions = decide(s, f.plan, new Map([[rid, { rid, state: 'sealed', status: 'ok' }]]), opts);
    const halt = actions.find(a => a.do === 'halt'); assert.equal(halt?.do, 'halt');
    if (halt?.do === 'halt') { assert.ok(halt.reason.includes('latency gate 49')); assert.ok(halt.reason.indexOf('failed tests:') < halt.reason.indexOf('last output:')); }
  } finally { await f.cleanup(); }
});

test('RC1: noisy voting creates one pass receipt, not a conflicting pair of ledger observations', async () => {
  const f = await fixture();
  try {
    f.plan.setup = 'echo 0 > counter';
    const obs = await f.run(sequence('fpp'), { repeat: { runs: 3, need: 2 }, min_tests: 1 });
    assert.equal(obs.verdict, 'pass'); assert.equal(obs.noisy, true); assert.match(obs.note!, /noisy \(2\/3 passed\)/);
    const entry = { ...obs, seq: 1, hash: 'x', prev: 'x', ts: new Date().toISOString() } as ObsEntry;
    const text = renderReceipt({ node: 'a', phase: 'submitted', accepted: false, items: [{ subject: 'a', obligation: 'check:x', key: 'k', status: 'E', mark: '✔', detail: 'satisfied', evidence: [1], observations: [entry] }], blocks: [], untested: [], ownerFlags: [], downgrades: [] });
    assert.match(text, /noisy \(2\/3 passed\)/);
    assert.equal(newerEntry(entry), undefined);
    assert.equal(newerEntry({ ...entry, future_obs_field: true } as Entry)?.code, 'version');
  } finally { await f.cleanup(); }
});

test('RC1: merge-time invariant tolerates noise and the driver merge report includes its summary', { timeout: 60_000 }, async () => {
  const r = await repo();
  try {
    const run = `if [ ! -f src/value ]; then ${owedCount(1, 0)}; elif [ ! -f once ]; then touch once; ${owedCount(0, 1, ['timing'])}; exit 1; else ${owedCount(1, 0)}; fi`;
    const plan = planWith({ run, min_tests: 1, repeat: { runs: 2, need: 1 }, reads: ['src/**'] }, true);
    await r.put('README', 'base'); await r.commit();
    await ops.init({ cwd: r.cwd, plan, as: owner, channel: 'delegated' });
    const d = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
    await commitAt(d.worktree, { 'src/value': 'new' });
    await ops.submit({ cwd: d.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
    await ops.attest({ cwd: r.cwd, node: 'a' });
    const ledger = await Ledger.open(r.cwd), es = await ledger.read(), project = es[0]!.hash.slice(0, 12), rid = runId(project, 'a', 1, 'writer');
    await ops.launch({ cwd: r.cwd, as: DRIVE_PRINCIPAL, node: 'a', attempt: 1, role: 'writer', rid, spec: '{}', labels: runLabels(project, 'a', 1, 'writer') });
    class SealedDsa extends Dsa {
      override async inspect(rid: string) { return { view: { rid, state: 'sealed' as const, status: 'ok' } }; }
    }
    const driver = new Driver({ cwd: r.cwd, log: () => {}, handleSignals: false, session: null, dsa: new SealedDsa({ bin: '/no-dsa-rc1' }), max: 1 });
    const started = await driver.pass(); assert.ok(started.actions.some(a => a.do === 'merge' && a.outcome === 'started'), JSON.stringify(started.actions));
    assert.equal(await driver.drain(30_000), true);
    const mergeReport = (await driver.pass()).actions.find(a => a.do === 'merge');
    assert.equal(mergeReport?.outcome, 'merged', JSON.stringify(mergeReport)); assert.match(mergeReport?.detail ?? '', /inv:x noisy \(1\/2 passed\)/);
    const entries = await (await Ledger.open(r.cwd)).read();
    const obs = entries.findLast((e): e is ObsEntry => e.kind === 'obs' && e.obligation === 'inv:x' && e.merging === 'a');
    assert.equal(obs?.verdict, 'pass'); assert.equal(obs?.noisy, true); assert.deepEqual(obs?.runs?.map(r => r.exit), [1, 0]);
    assert.equal((await ops.status({ cwd: r.cwd })).nodes.a!.phase, 'merged');
    assert.equal((await ops.verify({ cwd: r.cwd })).ok, true);
  } finally { await r.cleanup(); }
});

test('RC1: driver attest report includes noisy summary', { timeout: 60_000 }, async () => {
  const r = await repo();
  try {
    const plan = planWith({ run: sequence('fpp'), min_tests: 1, repeat: { runs: 3, need: 2 } });
    await r.put('README', 'base'); await r.commit();
    await ops.init({ cwd: r.cwd, plan, as: owner, channel: 'delegated' });
    const d = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
    await commitAt(d.worktree, { 'src/value': 'new' });
    await ops.submit({ cwd: d.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
    const ledger = await Ledger.open(r.cwd), es = await ledger.read(), project = es[0]!.hash.slice(0, 12), rid = runId(project, 'a', 1, 'writer');
    await ops.launch({ cwd: r.cwd, as: DRIVE_PRINCIPAL, node: 'a', attempt: 1, role: 'writer', rid, spec: '{}', labels: runLabels(project, 'a', 1, 'writer') });
    class SealedDsa extends Dsa { override async inspect(rid: string) { return { view: { rid, state: 'sealed' as const, status: 'ok' } }; } }
    const driver = new Driver({ cwd: r.cwd, log: () => {}, handleSignals: false, session: null, dsa: new SealedDsa({ bin: '/no-dsa-rc1' }), max: 1 });
    const start = await driver.pass(); assert.ok(start.actions.some(a => a.do === 'attest' && a.outcome === 'started'), JSON.stringify(start.actions));
    assert.equal(await driver.drain(30_000), true);
    const report = (await driver.pass()).actions.find(a => a.do === 'attest');
    assert.equal(report?.outcome, 'done'); assert.match(report?.detail ?? '', /check:x noisy \(2\/3 passed\)/);
    // Do not leave the merge that pass scheduled in flight when disposing the fixture.
    assert.equal(await driver.drain(30_000), true);
  } finally { await r.cleanup(); }
});

test('RC1/RC3: failed merge invariant retains all run receipts and leads the refusal with failing names', { timeout: 60_000 }, async () => {
  const r = await repo();
  try {
    const run = `if [ ! -f src/value ]; then ${owedCount(1, 0)}; else ${owedCount(0, 1, ['merge timing gate'])}; exit 1; fi`;
    const plan = planWith({ run, min_tests: 1, repeat: { runs: 3, need: 2 }, reads: ['src/**'] }, true);
    await r.put('README', 'base'); const base = await r.commit();
    await ops.init({ cwd: r.cwd, plan, as: owner, channel: 'delegated' });
    const d = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
    await commitAt(d.worktree, { 'src/value': 'new' });
    await ops.submit({ cwd: d.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
    await ops.attest({ cwd: r.cwd, node: 'a' });
    await assert.rejects(ops.merge({ cwd: r.cwd, node: 'a', as: parent }), /inv:x: failed tests: merge timing gate; last output:/);
    const entries = await (await Ledger.open(r.cwd)).read(), obs = entries.findLast((e): e is ObsEntry => e.kind === 'obs' && e.obligation === 'inv:x' && e.merging === 'a');
    assert.equal(obs?.verdict, 'fail'); assert.deepEqual(obs?.runs?.map(r => r.verdict), ['fail', 'fail']);
    assert.equal((await ops.status({ cwd: r.cwd })).trunk.commit, base); assert.equal(entries.filter(e => e.kind === 'merge').length, 0);
    assert.equal((await ops.verify({ cwd: r.cwd })).ok, true);
  } finally { await r.cleanup(); }
});
