import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { repo } from './helpers/repo.ts';
import { parsePlan } from '../src/plan.ts';
import { Ledger } from '../src/ledger.ts';
import { runJob } from '../src/exec.ts';
import type { AttestJob } from '../src/types.ts';

const testFile = (n: number) => `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/mod.mjs';\n${Array.from({ length: n }, (_, i) => `test('t${i}', () => assert.equal(value(), 42));\n`).join('')}`;

let r: Awaited<ReturnType<typeof repo>>, ctx: Parameters<typeof runJob>[0], job: AttestJob, thin: string, cand: string;
before(async () => {
  r = await repo();
  await r.put('README', 'base');
  const base = await r.commit();
  // The candidate adds the module and a test file importing it: on the base the file cannot load.
  await r.put('src/mod.mjs', 'export function value() { return 42; }\n');
  await r.put('test/mod.test.mjs', testFile(3));
  cand = await r.commit();
  await r.put('test/mod.test.mjs', testFile(2));
  thin = await r.commit();
  const plan = parsePlan(`version: 1\ntrunk: main\nnodes:\n - id: a\n   writes: [src/, test/]\n   checks: [{id: unit, run: 'node --test --test-reporter=tap test/mod.test.mjs', min_tests: 3, red: true, tests: ['test/**'], red_expect: 'not ok'}]`);
  ctx = { cwd: r.cwd, plan, ledger: await Ledger.open(r.cwd) };
  job = { kind: 'check', subject: 'a', obligation: 'check:unit', key: 'key', spec: plan.nodes[0]!.checks[0], commit: cand, base };
});
after(async () => { await r?.cleanup(); });

test('red run passes on the base with one counted (load-failure) test despite min_tests 3', async () => {
  const red = await runJob(ctx, { ...job, kind: 'red', obligation: 'red:unit' });
  assert.equal(red.verdict, 'pass', red.note); assert.notEqual(red.exit, 0); assert.equal(red.counts?.tests, 1);
});
test('candidate run passes with >= min_tests tests', async () => {
  const green = await runJob(ctx, job);
  assert.equal(green.verdict, 'pass', green.note); assert.ok((green.counts?.tests ?? 0) >= 3);
});
test('candidate run fails with fewer than min_tests tests', async () => {
  const short = await runJob(ctx, { ...job, commit: thin });
  assert.equal(short.verdict, 'fail'); assert.equal(short.counts?.tests, 2); assert.match(short.note ?? '', /min_tests/);
});
test('red fails when the base run exits 0', async () => {
  const passesOnBase = await runJob(ctx, { ...job, kind: 'red', base: cand });
  assert.equal(passesOnBase.verdict, 'fail'); assert.equal(passesOnBase.exit, 0);
});
test('red fails when red_expect does not match', async () => {
  assert.equal((await runJob(ctx, { ...job, kind: 'red', spec: { ...job.spec!, red_expect: 'NEVER-MATCHES' } })).verdict, 'fail');
});
test('red accepts an unknown count format but still rejects a zero-test run', async () => {
  assert.equal((await runJob(ctx, { ...job, kind: 'red', spec: { ...job.spec!, run: 'echo not ok; exit 1' } })).verdict, 'pass');
  assert.equal((await runJob(ctx, { ...job, kind: 'red', spec: { ...job.spec!, run: "echo '# tests 0'; echo not ok; exit 1" } })).verdict, 'fail');
});
test('candidate run keeps the unknown-format error with min_tests', async () => {
  const obs = await runJob(ctx, { ...job, spec: { ...job.spec!, run: 'echo unknown' } });
  assert.equal(obs.verdict, 'error'); assert.match(obs.note ?? '', /unknown test count format with min_tests/);
});
