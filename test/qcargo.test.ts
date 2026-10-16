// QS3/QS4: real ledger and git fixtures, with recorded libtest output instead of a Rust installation.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { Ledger } from '../src/ledger.ts';
import * as ops from '../src/ops.ts';
import * as reducer from '../src/reducer.ts';
import { runJob } from '../src/exec.ts';
import { stateFacts } from '../src/git.ts';
import type { ObsEntry, AttestJob } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const owner = { role: 'owner', id: 'pi' } as const, parent = { role: 'parent', id: 'main' } as const;
const doc = 'src/lib.rs - f (line 12)';
const quarantine = [{ test: 'broken', fix: 'fix' }, { test: doc, fix: 'fix' }];
const run = 'PATH=./tools:/usr/bin:/bin cargo test --no-fail-fast';
function block(results: [string, string][]): string {
  const p = results.filter(([, s]) => s === 'ok').length, f = results.filter(([, s]) => s === 'FAILED').length, s = results.length - p - f;
  return `running ${results.length} test${results.length === 1 ? '' : 's'}\n${results.map(([name, status]) => `test ${name} ... ${status}\n`).join('')}\n${f ? `failures:\n\n---- broken stdout ----\nthread 'broken' (1234) panicked at src/lib.rs:12:3:\nassertion failed: ready\n\nfailures:\n    broken\n\n` : ''}test result: ${f ? 'FAILED' : 'ok'}. ${p} passed; ${f} failed; ${s} ignored; 0 measured; 0 filtered out; finished in 0.01s\n\n`;
}
const diagnostic = 'error: test failed, to rerun pass --lib\n';
const failing = '   Compiling demo v0.1.0\n    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.02s\n     Running unittests src/lib.rs (target/debug/deps/demo)\n'
  + block([['broken', 'FAILED'], ['good', 'ok'], ['slow', 'ignored, external service']]) + diagnostic
  + '   Doc-tests demo\n' + block([[doc, 'FAILED'], ['src/lib.rs - g (line 20)', 'ok']]) + 'error: test failed, to rerun pass --doc\n'
  + block([]) + 'error: 2 targets failed:\n    --lib\n    --doc\n';
const passing = block([['broken', 'ok'], ['good', 'ok'], ['slow', 'ignored']]) + block([[doc, 'ok']]);

type Options = { log?: string; code?: number; command?: string; min?: number };
async function fixture(o: Options = {}, checks = false) {
  const r = await repo();
  try {
    await r.put('tools/cargo', `#!/bin/sh\n/bin/cat fixture.log\nexit ${o.code ?? 101}\n`);
    await chmod(join(r.cwd, 'tools/cargo'), 0o755);
    await r.put('fixture.log', o.log ?? failing); await r.put('src/value', '0'); await r.commit();
    const spec = { id: 'unit', run: o.command ?? run, reads: ['fixture.log', 'tools/**', 'src/**'], min_tests: o.min ?? 1, quarantine };
    await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify({ version: 1, trunk: 'main', closure: [],
      invariants: checks ? [] : [spec], nodes: [{ id: 'fix', writes: ['fixture.log'] }, { id: 'sibling', writes: ['fixture.log'] }, { id: 'work', writes: ['src/'], checks: checks ? [spec] : [] }] }) });
    const ledger = await Ledger.open(r.cwd);
    const observation = async () => (await ledger.read()).findLast((e): e is ObsEntry => e.kind === 'obs' && e.obligation === 'inv:unit')!;
    return { ...r, ledger, observation };
  } catch (e) { await r.cleanup(); throw e; }
}
async function refused(options: Options, reason: RegExp) {
  const r = await fixture(options);
  try {
    const obs = await r.observation();
    assert.equal(obs.verdict, 'fail', obs.note); assert.equal(obs.quarantined, undefined);
    assert.match(obs.note ?? '', reason);
  } finally { await r.cleanup(); }
}

test('QS3/QS4: complete passing Cargo output keeps counts and records sorted quarantine greens on trunk', { timeout: 120_000 }, async () => {
  const r = await fixture({ log: passing, code: 0 });
  try {
    const obs = await r.observation();
    assert.equal(obs.verdict, 'pass', obs.note); assert.equal(obs.exit, 0); assert.equal(obs.quarantined, undefined);
    assert.deepEqual(obs.quarantine_passed, ['broken', doc].sort());
    assert.deepEqual(obs.counts, { format: 'cargo', tests: 4, pass: 3, fail: 0, skip: 1 });
    assert.equal((await cli(r.cwd, ['verify'])).code, 0);
  } finally { await r.cleanup(); }
});

test('QS3: realistic multi-target and doc-test failures are excused with exact names, exit zero and remaining counts', { timeout: 120_000 }, async () => {
  const r = await fixture();
  try {
    const obs = await r.observation();
    assert.equal(obs.verdict, 'pass', obs.note); assert.equal(obs.exit, 0);
    assert.deepEqual(obs.quarantined, ['broken', doc]); assert.equal(obs.failed, undefined);
    assert.deepEqual(obs.counts, { format: 'cargo', tests: 3, pass: 2, fail: 0, skip: 1, failed: [] });
    assert.match(obs.note ?? '', /quarantined: broken \(fix: fix\)/);
    assert.equal(obs.quarantine_passed, undefined);
    assert.equal((await cli(r.cwd, ['verify'])).code, 0);
  } finally { await r.cleanup(); }
});

test('QS4: Cargo quarantine greens are recorded alongside excused failures, never for ignored names', { timeout: 120_000 }, async () => {
  const r = await fixture({ log: failing.replace('test broken ... FAILED', 'test broken ... ok').replace('FAILED. 1 passed; 1 failed; 1 ignored', 'ok. 2 passed; 0 failed; 1 ignored').replace(diagnostic, '').replace('2 targets failed:', '1 targets failed:') });
  try {
    const obs = await r.observation();
    assert.equal(obs.verdict, 'pass', obs.note); assert.deepEqual(obs.quarantine_passed, ['broken']);
    assert.deepEqual(obs.quarantined, [doc]);
  } finally { await r.cleanup(); }
});

test('QS3: compile and other non-test errors cannot be hidden by complete earlier targets', { timeout: 120_000 }, async () => {
  for (const error of ['error[E0425]: cannot find value x', 'error: could not compile `demo`', 'error: linker failed']) {
    await refused({ log: failing + error + '\n' }, /quarantine not applied: cargo reported a non-test error/);
  }
});

test('QS3: no-fail-fast is mandatory and operators, quotes and wrappers are refused', { timeout: 120_000 }, async () => {
  for (const command of [run.replace(' --no-fail-fast', ''), `${run}; exit 101`, `${run} --nocapture > captured; /bin/cat captured; exit 101`, `${run} 'quoted'`, `sh -c '${run}'`]) {
    await refused({ command }, /quarantine not applied: not a plain cargo test --no-fail-fast run/);
  }
});

test('QS3: optional toolchain and leading environment assignments stay native; long-running notices are not results', { timeout: 120_000 }, async () => {
  const r = await fixture({ command: run.replace(' cargo test', ' MODE=test cargo +nightly test'), log: failing.replace('test broken ...', 'test broken has been running for over 60 seconds\ntest broken ...') });
  try { assert.equal((await r.observation()).verdict, 'pass', (await r.observation()).note); }
  finally { await r.cleanup(); }
});

test('QS3: incomplete announced block, missing summary and overlapping blocks fail closed', { timeout: 120_000 }, async () => {
  await refused({ log: failing.replace('test good ... ok\n', '') }, /cargo announced 3 tests but 2 results/);
  await refused({ log: failing.replace(/test result: FAILED[^\n]*\n/, '') }, /cargo block has no test result/);
  await refused({ log: failing + 'running 1 test\n' }, /cargo block has no test result/);
});

test('QS3: result and summary lines outside blocks or repeated summaries fail closed', { timeout: 120_000 }, async () => {
  await refused({ log: block([]) + failing.replace(/^.*?running 3 tests/s, 'running 3 tests') + 'test result: ok. 0 passed; 0 failed; 0 ignored\n' }, /cargo summary outside a block/);
  await refused({ log: 'test broken ... FAILED\n' + failing }, /cargo test result outside a block/);
});

test('QS3: unexpected failure names never use substring matching', { timeout: 120_000 }, async () => {
  await refused({ log: failing.replace('test broken ... FAILED', 'test broken_extra ... FAILED') }, /1 failing test is not quarantined/);
});

test('QS3: duplicate failed names in one block or across binaries are refused', { timeout: 120_000 }, async () => {
  await refused({ log: block([['broken', 'FAILED'], ['broken', 'FAILED'], ['good', 'ok']]) + diagnostic }, /cargo failing names are not distinct within one block/);
  await refused({ log: block([['broken', 'FAILED'], ['good', 'ok']]) + diagnostic + block([['broken', 'FAILED']]) + diagnostic }, /cargo failing names are not distinct within one block/);
  await refused({ log: block([['broken', 'FAILED'], ['good', 'ok']]) + diagnostic + block([['broken', 'ok']]) }, /cargo failing names are not distinct within one block/);
});

test('QS3: min_tests applies after removing quarantined failures', { timeout: 120_000 }, async () => {
  await refused({ min: 4 }, /3 tests left, below min_tests 4/);
});

test('QS3: every failed block must have exactly one Cargo rerun diagnostic and target count must agree', { timeout: 120_000 }, async () => {
  for (const log of [failing.replace(diagnostic, ''), failing + diagnostic, failing.replace('2 targets failed:', '1 targets failed:')]) {
    await refused({ log }, /cargo failed-target diagnostics disagree with summaries/);
  }
});

test('QS3: process crash, signal and non-101 exit status cannot be excused', { timeout: 120_000 }, async () => {
  for (const suffix of [' (signal: 9, SIGKILL: kill)', ' (exit status: 1)']) {
    await refused({ log: failing + "process didn't exit successfully: target/debug/demo" + suffix + '\n' }, /cargo process did not exit with status 101/);
  }
  await refused({ code: 1 }, /exit 1 is not a cargo test failure/);
  const r = await fixture({ log: failing + "process didn't exit successfully: target/debug/demo (exit status: 101)\n" });
  try { assert.equal((await r.observation()).verdict, 'pass', (await r.observation()).note); }
  finally { await r.cleanup(); }
});

test('QS3: mixed protocols, terse output and contradictory summary totals cannot prove completeness', { timeout: 120_000 }, async () => {
  await refused({ log: failing + '1..1\nok 1 - tap\n# tests 1\n# pass 1\n# fail 0\n' }, /counts are not cargo/);
  await refused({ log: failing.replace('test broken ... FAILED\n', 'F\n') }, /cargo announced 3 tests but 2 results/);
  await refused({ log: failing.replace('1 passed; 1 failed', '2 passed; 1 failed') }, /cargo results disagree with summary/);
});

test('QS3: truncated output never excuses a surviving complete tail', { timeout: 120_000 }, async () => {
  await refused({ log: 'x'.repeat(1024 * 1024 + 100) + '\n' + failing }, /cargo output was truncated/);
});

test('QS3: failure-name cap refuses more than fifty results without silently truncating evidence', { timeout: 120_000 }, async () => {
  const results: [string, string][] = Array.from({ length: 51 }, (_, i) => [`failure_${i}`, 'FAILED']);
  await refused({ log: block([...results, ['good', 'ok']]) + diagnostic }, /more than 50 cargo failures/);
});

test('QS3: stale keys and red counterfactuals never receive Cargo excusal', { timeout: 120_000 }, async () => {
  const r = await fixture();
  try {
    assert.equal((await r.observation()).verdict, 'pass', 'valid committed quarantine first proves native excusal');
    const s = (await ops.readState({ cwd: r.cwd })).state, commit = s.trunk.commit;
    const key = (await stateFacts(r.cwd, s.plan, commit)).invKeys.unit!;
    const job: AttestJob = reducer.quarantinedJob(s, { kind: 'inv', subject: 'trunk', obligation: 'inv:unit', key, commit, base: commit, spec: s.plan.invariants[0]! });
    const stale = await runJob({ cwd: r.cwd, plan: s.plan, ledger: r.ledger }, job);
    assert.equal(stale.verdict, 'fail'); assert.equal(stale.quarantined, undefined); assert.equal(stale.quarantine_passed, undefined);
    const red = await runJob({ cwd: r.cwd, plan: s.plan, ledger: r.ledger }, { ...job, kind: 'red', subject: 'work', obligation: 'red:unit', spec: { ...job.spec!, red: true, tests: ['fixture.log'] } });
    assert.equal(red.verdict, 'pass', red.note); assert.equal(red.exit, 101); assert.equal(red.quarantined, undefined);
  } finally { await r.cleanup(); }
});

test('QS4: Cargo merge-tree checks record green quarantine names, candidate checks do not', { timeout: 180_000 }, async () => {
  const r = await fixture({ log: passing, code: 0 }, true);
  try {
    const slot = await ops.dispatch({ cwd: r.cwd, node: 'work', as: parent });
    await commitAt(slot.worktree, { 'src/value': '1' });
    await ops.submit({ cwd: slot.worktree, node: 'work', as: { role: 'writer', id: 'work#1' } });
    await ops.attest({ cwd: r.cwd, node: 'work' });
    let entries = await r.ledger.read();
    const candidate = entries.findLast((e): e is ObsEntry => e.kind === 'obs' && e.obligation === 'check:unit')!;
    assert.equal(candidate.quarantine_passed, undefined);
    // A real sibling merge changes the check's reads, so the merge guard cannot reuse its candidate observation.
    const sibling = await ops.dispatch({ cwd: r.cwd, node: 'sibling', as: parent });
    await commitAt(sibling.worktree, { 'fixture.log': passing + '\n' });
    await ops.submit({ cwd: sibling.worktree, node: 'sibling', as: { role: 'writer', id: 'sibling#1' } });
    await ops.attest({ cwd: r.cwd, node: 'sibling' });
    await ops.merge({ cwd: r.cwd, node: 'sibling', as: parent });
    await ops.merge({ cwd: r.cwd, node: 'work', as: parent });
    entries = await r.ledger.read();
    assert.deepEqual(entries.findLast((e): e is ObsEntry => e.kind === 'obs' && e.merging === 'work')!.quarantine_passed, ['broken', doc].sort());
    assert.equal((await cli(r.cwd, ['verify'])).code, 0);
  } finally { await r.cleanup(); }
});
