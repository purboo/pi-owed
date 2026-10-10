// E2 (0.5.1, wais §41): check results that say what happened — mixed cargo + TAP counts, a failing command without
// a test count is `fail` with its last output lines, and check processes do not inherit DSA_* variables.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { repo } from './helpers/repo.ts';
import { parsePlan } from '../src/plan.ts';
import { Ledger } from '../src/ledger.ts';
import { runJob, parseCounts } from '../src/exec.ts';
import * as ops from '../src/ops.ts';
import { reduce } from '../src/reducer.ts';
import { repairMessage } from '../src/drive.ts';
import type { AttestJob, Plan } from '../src/types.ts';
import { cli, commitAt } from './helpers/surface.ts';

const CARGO = [
  '   Compiling demo v0.1.0 (/work/demo)',
  '    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.50s',
  '     Running unittests src/lib.rs (target/debug/deps/demo-0123)',
  '',
  'running 2 tests',
  'test a ... ok',
  'test b ... ok',
  '',
  'test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s',
  '',
  '     Running tests/it.rs (target/debug/deps/it-4567)',
  '',
  'running 1 test',
  'test c ... ignored',
  '',
  'test result: ok. 0 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out; finished in 0.00s',
  '',
].join('\n');
const TAP = ['TAP version 13', '# Subtest: x', 'ok 1 - x', '# Subtest: y', 'ok 2 - y', '# Subtest: z', 'ok 3 - z # SKIP', '1..3',
  '# tests 3', '# suites 0', '# pass 2', '# fail 0', '# cancelled 0', '# skipped 1', '# todo 0', '# duration_ms 5.1', ''].join('\n');
const nodeTests = (n: number) => `import test from 'node:test';\n${Array.from({ length: n }, (_, i) => `test('t${i}', () => {});\n`).join('')}`;
const CARGO_STUB = [
  '#!/bin/sh',
  'echo "    Updating crates.io index" >&2',
  'echo "error: package ID specification \\`$3\\` did not match any packages" >&2',
  'echo "" >&2',
  'echo "help: a package with a similar name exists: \\`walle-ai-studio\\`" >&2',
  'exit 101',
  '',
].join('\n');

let r: Awaited<ReturnType<typeof repo>>, ctx: Parameters<typeof runJob>[0], job: AttestJob;
before(async () => {
  r = await repo();
  await r.put('README', 'base');
  const base = await r.commit();
  await r.put('fixtures/cargo.log', CARGO);
  await r.put('test/t.test.mjs', nodeTests(3));
  await r.put('bin/cargo', CARGO_STUB);
  const cand = await r.commit();
  const plan = parsePlan(`version: 1\ntrunk: main\nnodes:\n - id: a\n   writes: [src/, test/, fixtures/, bin/]\n   checks: [{id: unit, run: 'true', min_tests: 5}]`);
  ctx = { cwd: r.cwd, plan, ledger: await Ledger.open(r.cwd) };
  job = { kind: 'check', subject: 'a', obligation: 'check:unit', key: 'key', spec: plan.nodes[0]!.checks[0], commit: cand, base };
});
after(async () => { await r?.cleanup(); });
const run = (command: string, extra: Partial<NonNullable<AttestJob['spec']>> = {}, kind: AttestJob['kind'] = 'check') =>
  runJob(ctx, { ...job, kind, obligation: kind === 'red' ? 'red:unit' : 'check:unit', spec: { ...job.spec!, run: command, ...extra } });

test('E2.1: cargo `test result:` lines and TAP in one log sum to one mixed count; single-format logs keep their format and numbers', () => {
  assert.deepEqual(parseCounts(`${CARGO}\n${TAP}`), { format: 'mixed', tests: 6, pass: 4, fail: 0, skip: 2 });
  assert.deepEqual(parseCounts(`${TAP}\n${CARGO}`), { format: 'mixed', tests: 6, pass: 4, fail: 0, skip: 2 }, 'order does not matter');
  assert.deepEqual(parseCounts(CARGO), { format: 'cargo', tests: 3, pass: 2, fail: 0, skip: 1 });
  assert.deepEqual(parseCounts(TAP), { format: 'tap', tests: 3, pass: 2, fail: 0, skip: 1 });
  // A failing cargo segment counts its failures; a bare TAP plan adds its tests but no pass/fail/skip it never reported.
  const failing = 'test result: FAILED. 1 passed; 2 failed; 0 ignored; 0 measured; 0 filtered out';
  assert.deepEqual(parseCounts(`${failing}\n${TAP}`), { format: 'mixed', tests: 6, pass: 3, fail: 2, skip: 1 });
  assert.deepEqual(parseCounts(`${failing}\nTAP version 13\nok 1 - a\n1..1\n`), { format: 'mixed', tests: 4 });
});

test('E2.1: a check chaining cargo test and node --test --test-reporter=tap meets min_tests with the summed count', async () => {
  // 3 cargo tests + 3 node tests = 6 ≥ min_tests 5; either segment alone (3) would not meet it.
  const obs = await run('cat fixtures/cargo.log && node --test --test-reporter=tap test/t.test.mjs');
  assert.equal(obs.exit, 0);
  assert.equal(obs.counts?.format, 'mixed', JSON.stringify(obs.counts));
  assert.equal(obs.counts?.tests, 6); assert.equal(obs.counts?.pass, 5); assert.equal(obs.counts?.skip, 1); assert.equal(obs.counts?.fail, 0);
  assert.equal(obs.verdict, 'pass', obs.note);
  const short = await run('cat fixtures/cargo.log && node --test --test-reporter=tap test/t.test.mjs', { min_tests: 7 });
  assert.equal(short.verdict, 'fail'); assert.equal(short.counts?.tests, 6); assert.match(short.note ?? '', /min_tests/);
});

test('E2.2: a wrong cargo package name (exit 101, no test count) is fail with the cargo error in the note, not the unknown-format error', async () => {
  for (const min_tests of [1, undefined]) {
    const obs = await run('sh bin/cargo test -p walle-ai-studio-server', { min_tests });
    assert.equal(obs.exit, 101);
    assert.equal(obs.verdict, 'fail', obs.note);
    assert.doesNotMatch(obs.note ?? '', /unknown test count format/);
    assert.equal(obs.note, [
      'command exited 101 with no recognizable test count; last output:',
      '      Updating crates.io index',
      '  error: package ID specification `walle-ai-studio-server` did not match any packages',
      '  help: a package with a similar name exists: `walle-ai-studio`',
    ].join('\n'), `min_tests ${min_tests}`);
  }
  // Only the last 5 non-empty lines are kept, each cut to 200 characters (ANSI colour removed).
  const long = await run(`for i in 1 2 3 4 5 6 7; do echo "line $i"; echo; done; printf '\\033[31merror\\033[0m: '; printf 'x%.0s' $(seq 1 300); echo; exit 3`);
  assert.equal(long.verdict, 'fail', long.note);
  const lines = (long.note ?? '').split('\n');
  assert.equal(lines[0], 'command exited 3 with no recognizable test count; last output:');
  assert.deepEqual(lines.slice(1, 5), ['  line 4', '  line 5', '  line 6', '  line 7']);
  assert.equal(lines.length, 6);
  assert.equal(lines[5], `  ${`error: ${'x'.repeat(300)}`.slice(0, 200)}`);
  // A zero count with a non-zero exit is the same failed command.
  const zero = await run("echo '# tests 0'; echo 'boom: setup missing'; exit 1");
  assert.equal(zero.verdict, 'fail');
  assert.equal(zero.note, 'command exited 1 after zero tests; last output:\n  # tests 0\n  boom: setup missing');
});

test('E2.2: exit 0 with an unknown count and min_tests stays an error; red runs are unchanged', async () => {
  const unknown = await run('echo all good');
  assert.equal(unknown.exit, 0); assert.equal(unknown.verdict, 'error'); assert.equal(unknown.note, 'unknown test count format with min_tests');
  // Without min_tests an exit-0 run with an unknown count still passes; a counted failing run is a plain fail.
  assert.equal((await run('echo all good', { min_tests: undefined })).verdict, 'pass');
  const counted = await run("echo '# tests 6'; echo '# pass 5'; echo '# fail 1'; exit 1");
  assert.equal(counted.verdict, 'fail'); assert.equal(counted.note, undefined);
  // Red: an unknown count is accepted, a zero-test run rejected, exit 127 is an error — exactly as before.
  const red = await run("echo 'not ok 1 - load'; exit 101", { red_expect: 'not ok' }, 'red');
  assert.equal(red.verdict, 'pass', red.note); assert.equal(red.note, undefined);
  const redZero = await run("echo '# tests 0'; echo 'not ok'; exit 1", { red_expect: 'not ok' }, 'red');
  assert.equal(redZero.verdict, 'fail'); assert.equal(redZero.note, 'zero tests');
  const red127 = await run('echo not ok; owed-no-such-command-x', { red_expect: 'not ok' }, 'red');
  assert.equal(red127.verdict, 'error'); assert.match(red127.note ?? '', /exit 127: not found/);
});

test('E2.3: setup and check processes do not inherit DSA_* call identity (DSA_HOME is kept); owed inside a check is not a subagent call', async () => {
  const names = ['DSA_CALL', 'DSA_EXEC', 'DSA_SESSION', 'DSA_HOME'] as const, prior = Object.fromEntries(names.map(n => [n, process.env[n]]));
  Object.assign(process.env, { DSA_CALL: 'call-x', DSA_EXEC: 'exec-x', DSA_SESSION: 'session-x', DSA_HOME: '/tmp/dsa-home-x' });
  try {
    const ops = fileURLToPath(new URL('../src/ops.ts', import.meta.url));
    const probe = `node --input-type=module -e "const m = await import(process.argv[1]); console.log('subagent=' + (m.subagentCall() ?? 'none'))" '${ops}'`;
    const setupCtx = { ...ctx, plan: { ...ctx.plan, setup: "env | grep '^DSA_' > setup-env || true", exec: { env: { DSA_EXPLICIT: 'from-plan' } } } };
    const obs = await runJob(setupCtx, { ...job, spec: { ...job.spec!, min_tests: 1, run: `sed 's/^/setup: /' setup-env; env | grep '^DSA_' | sed 's/^/check: /'; ${probe}; echo '# tests 1'; echo '# pass 1'` } });
    const log = (await ctx.ledger.getBlob(obs.log!)).toString();
    assert.equal(obs.verdict, 'pass', `${obs.note}\n${log}`);
    for (const n of names.filter(n => n !== 'DSA_HOME')) assert.doesNotMatch(log, new RegExp(`${n}=`), log);
    // Ruling (review #557): DSA_HOME is configuration, not call identity — setup and check keep it.
    assert.match(log, /^setup: DSA_HOME=\/tmp\/dsa-home-x$/m, log);
    assert.match(log, /^check: DSA_HOME=\/tmp\/dsa-home-x$/m, log);
    assert.match(log, /^subagent=none$/m, log);
    // A DSA_* name the plan's exec.env sets explicitly is passed as written.
    assert.match(log, /^setup: DSA_EXPLICIT=from-plan$/m, log);
    assert.match(log, /^check: DSA_EXPLICIT=from-plan$/m, log);
  } finally {
    for (const n of names) { if (prior[n] === undefined) delete process.env[n]; else process.env[n] = prior[n]; }
  }
});

// ---------- review #557 rulings ----------
const TAP_WITH_CARGO_TEXT = ['TAP version 13',
  '# test result: ok. 40 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s',
  '# Subtest: a', 'ok 1 - a', '  ---', '  duration_ms: 1', '  ...',
  '# Subtest: b', 'not ok 2 - b', '  ---', '  error: |-', '    expected', '      test result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out', '  ...',
  '1..2', '# tests 2', '# pass 1', '# fail 1', ''].join('\n');

test('#557: cargo summaries count only at column 0 — a TAP comment or an indented YAML diagnostic stays format tap', async () => {
  assert.deepEqual(parseCounts(TAP_WITH_CARGO_TEXT), { format: 'tap', tests: 2, pass: 1, fail: 1 });
  assert.deepEqual(parseCounts('TAP version 13\n# test result: ok. 40 passed; 0 failed; 0 ignored; 0 measured\nok 1 - a\n1..1\n'), { format: 'tap', tests: 1 });
  // Column-0 cargo lines still sum with TAP.
  assert.deepEqual(parseCounts(`test result: ok. 3 passed; 0 failed; 0 ignored;\n${TAP_WITH_CARGO_TEXT}`), { format: 'mixed', tests: 5, pass: 4, fail: 1 });
  // Real node:test output: one test prints a cargo summary (node emits it as a `# ` comment), another fails with one in
  // its assertion message (an indented YAML diagnostic). Two tests: min_tests 5 is not met.
  await r.put('test/echo.test.mjs', "import test from 'node:test';\nimport assert from 'node:assert/strict';\n"
    + "test('logs', () => { console.log('test result: ok. 40 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.01s'); });\n"
    + "test('fails', () => assert.fail('\\ntest result: ok. 7 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out'));\n");
  const echo = await r.commit();
  const obs = await runJob(ctx, { ...job, commit: echo, spec: { ...job.spec!, run: 'node --test --test-reporter=tap test/echo.test.mjs; true' } });
  const log = (await ctx.ledger.getBlob(obs.log!)).toString();
  assert.match(log, /^# test result: ok\. 40 passed/m, log);
  assert.equal(obs.counts?.format, 'tap', JSON.stringify(obs.counts));
  assert.equal(obs.counts?.tests, 2);
  assert.equal(obs.verdict, 'fail'); assert.equal(obs.note, 'min_tests unmet: counted 2 (1 pass, 1 fail) < min_tests 5; exit 0');
});

test('#557: a non-red run that exits 126 or 127 with no count is an error (the command never ran), with the last output lines', async () => {
  for (const min_tests of [5, undefined]) {
    const missing = await run('echo preparing; owed-no-such-command-x --all', { min_tests });
    assert.equal(missing.exit, 127); assert.equal(missing.verdict, 'error', missing.note);
    const lines = (missing.note ?? '').split('\n');
    assert.equal(lines[0], 'command could not run (exit 127: not found); last output:', missing.note);
    assert.equal(lines[1], '  preparing');
    assert.match(lines[2] ?? '', /^ {2}.*owed-no-such-command-x: command not found$/);
    const noexec = await run("printf 'x' > nx; ./nx", { min_tests });
    assert.equal(noexec.exit, 126); assert.equal(noexec.verdict, 'error', noexec.note);
    assert.match(noexec.note ?? '', /^command could not run \(exit 126: not executable\); last output:\n {2}.*nx: Permission denied$/);
  }
  // With a recognizable count a 127 exit is a counted failing run (fail), as before.
  const counted = await run("echo '# tests 6'; echo '# pass 6'; owed-no-such-command-x");
  assert.equal(counted.exit, 127); assert.equal(counted.verdict, 'fail'); assert.equal(counted.note, undefined);
  // Every other non-zero exit with no count is still fail.
  assert.equal((await run('echo broken; exit 2')).verdict, 'fail');
});

test('#557: owed why shows a fail observation\'s note under its item, and the driver\'s repair message carries it', { timeout: 120_000 }, async () => {
  const x = await repo();
  try {
    const plan = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: [{ id: 'a', writes: ['bin/'], checks: [{ id: 'unit', run: 'sh bin/cargo test -p walle-ai-studio-server', min_tests: 1 }], review: { count: 0, min_rank: 1 } }] };
    await commitAt(x.cwd, { 'plan.json': JSON.stringify(plan), README: 'x\n' });
    await ops.init({ cwd: x.cwd, plan: JSON.stringify(plan), as: { role: 'owner', id: 'human' }, channel: 'flag' });
    const d = await ops.dispatch({ cwd: x.cwd, node: 'a', as: { role: 'parent', id: 'main' } });
    await commitAt(d.worktree, { 'bin/cargo': CARGO_STUB });
    await ops.submit({ cwd: d.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
    await ops.attest({ cwd: x.cwd, node: 'a' });
    const ledger = await Ledger.open(x.cwd), entries = await ledger.read();
    const fail = entries.find(e => e.kind === 'obs' && e.obligation === 'check:unit');
    assert.ok(fail && fail.kind === 'obs' && fail.verdict === 'fail', JSON.stringify(fail));
    const block = [`  note #${fail.seq}:`,
      '    command exited 101 with no recognizable test count; last output:',
      '          Updating crates.io index',
      '      error: package ID specification `walle-ai-studio-server` did not match any packages',
      '      help: a package with a similar name exists: `walle-ai-studio`'].join('\n');
    const why = (await cli(x.cwd, ['why', 'a'])).stdout;
    const at = why.split('\n').findIndex(l => l.includes('a/check:unit'));
    assert.ok(at >= 0, why);
    assert.equal(why.split('\n').slice(at + 1, at + 6).join('\n'), block, why);
    // The note sits under its own item only: no other item line is followed by a note.
    assert.equal(why.split('\n').filter(l => l.startsWith('  note #')).length, 1, why);
    // The repair message embeds the card with the note.
    const plans = new Map<string, Plan>();
    for (const e of entries) if (e.kind === 'genesis' || e.kind === 'plan') plans.set(e.plan, parsePlan((await ledger.getBlob(e.plan)).toString()));
    const msg = repairMessage(reduce(entries, sha => plans.get(sha)!), 'a');
    assert.ok(msg.includes(block), msg);
  } finally { await x.cleanup(); }
});
