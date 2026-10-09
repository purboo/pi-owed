import test from 'node:test';
import assert from 'node:assert/strict';
import { repo } from './helpers/repo.ts';
import { parsePlan } from '../src/plan.ts';
import { Ledger } from '../src/ledger.ts';
import { runJob } from '../src/exec.ts';
import type { AttestJob } from '../src/types.ts';

const testFile = (n: number) => `import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { value } from '../src/mod.mjs';\n${Array.from({ length: n }, (_, i) => `test('t${i}', () => assert.equal(value(), 42));\n`).join('')}`;

test('red run ignores min_tests on the base tree; candidate run enforces it', async () => {
  const r = await repo();
  try {
    await r.put('README', 'base');
    const base = await r.commit();
    await r.put('src/mod.mjs', 'export function value() { return 42; }\n');
    await r.put('test/mod.test.mjs', testFile(3));
    const cand = await r.commit();
    await r.put('test/mod.test.mjs', testFile(2));
    const thin = await r.commit();
    const plan = parsePlan(`version: 1\ntrunk: main\nnodes:\n - id: a\n   writes: [src/, test/]\n   checks: [{id: unit, run: 'node --test --test-reporter=tap test/mod.test.mjs', min_tests: 3, red: true, tests: ['test/**'], red_expect: 'not ok'}]`);
    const ledger = await Ledger.open(r.cwd), ctx = { cwd: r.cwd, plan, ledger };
    const job: AttestJob = { kind: 'check', subject: 'a', obligation: 'check:unit', key: 'key', spec: plan.nodes[0]!.checks[0], commit: cand, base };
    const red = await runJob(ctx, { ...job, kind: 'red', obligation: 'red:unit' });
    assert.equal(red.verdict, 'pass', red.note); assert.notEqual(red.exit, 0); assert.equal(red.counts?.tests, 1);
    const green = await runJob(ctx, job);
    assert.equal(green.verdict, 'pass', green.note); assert.ok((green.counts?.tests ?? 0) >= 3);
    const short = await runJob(ctx, { ...job, commit: thin });
    assert.equal(short.verdict, 'fail'); assert.equal(short.counts?.tests, 2); assert.match(short.note ?? '', /min_tests/);
    // Red still requires a failing base run and a matching red_expect.
    const passesOnBase = await runJob(ctx, { ...job, kind: 'red', base: cand });
    assert.equal(passesOnBase.verdict, 'fail'); assert.equal(passesOnBase.exit, 0);
    assert.equal((await runJob(ctx, { ...job, kind: 'red', spec: { ...job.spec!, red_expect: 'NEVER-MATCHES' } })).verdict, 'fail');
    // Red needs only a recognizable failure: an unknown count format is not an error, a zero-test run still fails.
    assert.equal((await runJob(ctx, { ...job, kind: 'red', spec: { ...job.spec!, run: 'echo not ok; exit 1' } })).verdict, 'pass');
    assert.equal((await runJob(ctx, { ...job, kind: 'red', spec: { ...job.spec!, run: "echo '# tests 0'; echo not ok; exit 1" } })).verdict, 'fail');
    // Candidate runs keep the unknown-format error when min_tests is set.
    assert.equal((await runJob(ctx, { ...job, spec: { ...job.spec!, run: 'echo unknown' } })).verdict, 'error');
  } finally { await r.cleanup(); }
});
