// PF1-PF4 (0.27.2): terminal pytest summaries, anchored zero-test forms and display-only provenance.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { repo } from './helpers/repo.ts';
import { parsePlan } from '../src/plan.ts';
import { Ledger } from '../src/ledger.ts';
import { parseCounts, runJob, zeroTestFallbackSignature } from '../src/exec.ts';
import { setupHint, setupSignature } from '../src/remeasure-on.ts';
import type { AttestJob, Counts } from '../src/types.ts';

const WAIS = 'run 1: PASS\nrun 2: PASS\nrun 3: PASS\n3/3 passing runs\nENOTEMPTY=0 failed=[]';
let r: Awaited<ReturnType<typeof repo>>, ctx: Parameters<typeof runJob>[0], job: AttestJob;
before(async () => {
  r = await repo();
  await r.put('README', 'base');
  const base = await r.commit();
  const plan = parsePlan('version: 1\ntrunk: main\nnodes:\n - id: a\n   writes: [src/]\n   checks: [{id: unit, run: "true"}]');
  ctx = { cwd: r.cwd, plan, ledger: await Ledger.open(r.cwd) };
  job = { kind: 'check', subject: 'a', obligation: 'check:unit', key: 'key', spec: plan.nodes[0]!.checks[0], commit: base, base };
});
after(async () => { await r?.cleanup(); });
const run = (log: string, min_tests?: number, code = 0) => runJob(ctx, {
  ...job, spec: { ...job.spec!, run: `printf '%s\\n' '${log.replace(/'/g, "'\\''")}'; exit ${code}`, min_tests },
});

// Keep each changed consequence independent so the red records all required failure paths.
test('PF1 wais: ENOTEMPTY=0 failed=[] is not a pytest summary', () => {
  assert.equal(parseCounts(WAIS), undefined);
});
test('PF3 wais: exit 0 without min_tests passes, never a zero-test failure', async () => {
  const obs = await run(WAIS);
  assert.equal(obs.exit, 0);
  assert.equal(obs.verdict, 'pass', obs.note);
  assert.equal(obs.counts, undefined);
  assert.equal(obs.note, undefined);
});
test('PF3 wais: exit 0 with min_tests is unknown-format error, never a zero-test failure', async () => {
  const obs = await run(WAIS, 3);
  assert.equal(obs.exit, 0);
  assert.equal(obs.verdict, 'error', obs.note);
  assert.equal(obs.counts, undefined);
  assert.equal(obs.note, 'unknown test count format with min_tests');
});

const summaries: [string, Counts][] = [
  ['===== 3 passed in 0.12s =====', { format: 'pytest', tests: 3, pass: 3 }],
  ['1 failed, 2 passed in 0.10s', { format: 'pytest', tests: 3, fail: 1, pass: 2 }],
  ['==== 2 failed, 1 passed, 1 warning, 1 error in 3.21s (0:00:03) ====', { format: 'pytest', tests: 4, fail: 3, pass: 1 }],
  ['== 5 passed, 2 deselected in 1.0s ==', { format: 'pytest', tests: 5, pass: 5 }],
  ['=== 1 passed, 1 rerun in 0.5s ===', { format: 'pytest', tests: 1, pass: 1 }],
  ['=== 2 xfailed, 1 xpassed in 0.2s ===', { format: 'pytest', tests: 3, skip: 2, pass: 1 }],
  ['2 xfailed, 1 xpassed in 0.2s', { format: 'pytest', tests: 3, skip: 2, pass: 1 }],
  ['  === 1 passed, 2 errors, 3 skipped, 4 warnings ===  ', { format: 'pytest', tests: 6, pass: 1, fail: 2, skip: 3 }],
  ['2 passed in 1s (0:00:01)', { format: 'pytest', tests: 2, pass: 2 }],
  ['=== 2 deselected, 1 warning, 1 rerun in 0.1s ===', { format: 'pytest', tests: 0 }],
];
for (const [line, counts] of summaries) test(`PF1 real terminal summary: ${line}`, () => {
  assert.deepEqual(parseCounts(line), counts);
});
test('PF1 last matching terminal summary wins, ignoring later non-summary text', () => {
  assert.deepEqual(parseCounts('===== 3 passed in 0.12s =====\n1 failed, 2 passed in 0.10s\nENOTEMPTY=0 failed=[]'), { format: 'pytest', tests: 3, fail: 1, pass: 2 });
});
test('PF1 rejects invalid items and trailing output, not just numeric substrings', () => {
  for (const line of [
    '3 passed', 'loader: 3 passed in 0.12s', '=== 3 passed, bogus ===',
    '=== 3 passed, 1 unknown in 0.1s ===', '3 passed in 0.12s extra',
    '3 passed in 0.12s (0:00:01) extra', '=== 3 passed in 0.12s === extra',
    '=== 3 passed, ENOTEMPTY=0 failed=[] ===', '=== 3 passed, ===',
  ]) assert.equal(parseCounts(line), undefined, line);
});

for (const [line, format] of [
  ['=== no tests ran in 0.01s ===', 'pytest'], ['collected 0 items', 'pytest'],
  ['No tests found, exiting with code 1', 'jest/vitest'],
  ['  no tests ran', 'pytest'], ['  === collected 0 items ===', 'pytest'],
] as const) test(`PF2 anchored zero-test form: ${line}`, () => {
  assert.deepEqual(parseCounts(line), { format, tests: 0 });
});
test('PF2 a fixture-loader mention inside other output is not a zero-test form', () => {
  for (const line of [
    '  fixture loader: no tests found for module x', 'fixture loader: no tests ran',
    'loader: collected 0 items', 'the phrase no tests collected is just text',
    'no tests ran for module x', 'collected 0 items in a comment',
  ]) assert.equal(parseCounts(line), undefined, line);
});
test('PF2 a fixture-loader mention keeps the no-count verdicts', async () => {
  const log = '  fixture loader: no tests found for module x';
  const plain = await run(log), minimum = await run(log, 3);
  assert.equal(plain.verdict, 'pass', plain.note);
  assert.equal(minimum.verdict, 'error', minimum.note);
  assert.equal(minimum.note, 'unknown test count format with min_tests');
});

for (const [line, format] of [
  ['=== no tests ran in 0.01s ===', 'pytest'],
  ['No tests found, exiting with code 1', 'jest/vitest'],
  ['Tests: 0 passed, 0 total', 'jest/vitest'],
  ['=== 2 deselected, 1 warning in 0.01s ===', 'pytest'],
] as const) test(`PF4 zero-test observation and setup signature name the counted ${format} line`, async () => {
  const log = `warning: cargo package not found\n${line}\nunrelated output tail`;
  const obs = await run(log);
  const signature = `${format} fallback counted line ${JSON.stringify(line)}`;
  assert.equal(obs.verdict, 'fail');
  assert.equal(obs.counts?.tests, 0);
  assert.equal(obs.note, `zero tests (${signature}); exit 0; a command that runs tests can print an owed-counts line`);
  const normalized = signature.replace(/\d+(?:\.\d+)?/g, '<n>');
  assert.equal(setupSignature(log), normalized);
  assert.ok(setupSignature(log).startsWith(`${format} fallback counted line `));
  assert.equal(setupHint(setupSignature(log), 'a'), `setup failure (no tests ran): ${normalized} — likely the environment; fix it, then owed decide a --remeasure`);
});
test('PF4 nonzero exit retains the command-failure note and adds the counted line', async () => {
  const line = 'No tests found, exiting with code 1', obs = await run(line, undefined, 1);
  assert.equal(obs.exit, 1);
  assert.equal(obs.verdict, 'fail');
  assert.match(obs.note ?? '', /^command exited 1 after zero tests/);
  assert.ok(obs.note?.includes(`jest/vitest fallback counted line ${JSON.stringify(line)}`), obs.note);
});
test('PF4 counted line is escaped and bounded to 160 displayed characters', async () => {
  const line = `\t\v${'='.repeat(180)} no tests ran in 0.01s ===`;
  const log = `error: unrelated cargo warning\n${line}`, obs = await run(log);
  const signature = zeroTestFallbackSignature(log)!;
  assert.match(signature, /^pytest fallback counted line "/);
  assert.ok(signature.includes('\\t\\u000b'), signature);
  assert.doesNotMatch(signature, /[\x00-\x1f\x7f-\x9f]/);
  const quoted = signature.slice('pytest fallback counted line "'.length, -1);
  assert.ok(quoted.length <= 160, signature);
  assert.ok(quoted.endsWith('…'), signature);
  assert.ok(obs.note?.includes(signature), obs.note);
  assert.match(setupSignature(log), /^pytest fallback counted line "/);
});
test('R-pf-1 colored terminal pytest summary keeps its count and min_tests verdict', async () => {
  const log = '\x1b[32m===== 3 passed in 0.12s =====\x1b[0m';
  assert.deepEqual(parseCounts(log), { format: 'pytest', tests: 3, pass: 3 });
  const obs = await run(log, 3);
  assert.equal(obs.verdict, 'pass', obs.note);
  assert.equal(obs.counts?.tests, 3);
});
test('R-pf-1 colored zero-test forms count the stripped line in observation notes', async () => {
  for (const [line, format] of [
    ['=== no tests ran in 0.01s ===', 'pytest'],
    ['No tests found, exiting with code 1', 'jest/vitest'],
  ] as const) {
    const log = `\x1b[1;32m${line}\x1b[0m`;
    assert.deepEqual(parseCounts(log), { format, tests: 0 });
    for (const code of [0, 1]) {
      const obs = await run(log, undefined, code);
      assert.equal(obs.verdict, 'fail');
      assert.ok(obs.note?.includes(`${format} fallback counted line ${JSON.stringify(line)}`), obs.note);
      assert.doesNotMatch(obs.note ?? '', /\x1b|\\u001b/);
    }
  }
});
test('R-pf-1 setup signatures dedupe different durations while notes keep the raw line', async () => {
  const signatures: string[] = [];
  for (const seconds of ['0.01', '0.02']) {
    const line = `=== no tests ran in ${seconds}s ===`;
    const log = `warning: cargo package not found\n\x1b[32m${line}\x1b[0m`;
    signatures.push(setupSignature(log));
    const obs = await run(log);
    assert.ok(obs.note?.includes(`pytest fallback counted line ${JSON.stringify(line)}`), obs.note);
  }
  assert.equal(signatures[0], signatures[1]);
  assert.equal(signatures[0], 'pytest fallback counted line "=== no tests ran in <n>s ==="');
});
test('PF4 zero-test provenance respects preferred protocols and nonzero counts', () => {
  const noisy = 'error: unrelated warning\n=== no tests ran in 0.01s ===';
  for (const prefix of ['# tests 0\n# pass 0', 'owed-counts {"pass":0,"fail":0}', 'Tests: 2 passed, 2 total']) {
    const signature = setupSignature(`${prefix}\n${noisy}`);
    assert.doesNotMatch(signature, /fallback counted line/);
    assert.match(signature, /unrelated warning/);
  }
});
