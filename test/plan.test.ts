import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePlan, planDowngrades, globMatch } from '../src/plan.ts';
import { OwedError } from '../src/errors.ts';
const base = `version: 1\ntrunk: main\nnodes:\n  - id: a\n    writes: [src/]\n    checks:\n      - id: unit\n        run: npm test\n`;
test('defaults and glob semantics', () => {
  const p = parsePlan(base); assert.deepEqual(p.nodes[0]!.checks[0]!.reads, ['**']);
  assert.equal(p.nodes[0]!.checks[0]!.timeout_s, 600); assert.deepEqual(p.nodes[0]!.review, { count: 0, min_rank: 1 });
  for (const path of ['conftest.py', 'a/conftest.py', 'a/b/conftest.py']) assert.ok(globMatch(path, '**/conftest.py'));
  assert.ok(globMatch('src/a/b', 'src/')); assert.ok(!globMatch('a/b/c', 'a/*'));
});
test('validation reports all errors including cycle and missing dependencies', () => {
  assert.throws(() => parsePlan('version: 2\ntrunk: main\nnodes:\n - id: a\n   deps: [a, absent]\n   checks: [{id: x, run: true, red: true}]'), (e: unknown) => {
    assert.ok(e instanceof OwedError); assert.equal(e.code, 'usage');
    for (const s of ['version', 'cycle', 'missing dependency', 'writes', 'red requires tests', 'run']) assert.match(e.message, new RegExp(s)); return true;
  });
  assert.throws(() => parsePlan(base + '  - id: a\n'));
});
test('downgrades include checks, invariants, review and prefix widening', () => {
  const p = parsePlan(base), n = structuredClone(p);
  p.nodes[0]!.checks[0] = { ...p.nodes[0]!.checks[0]!, red: true, tests: ['test/**'], min_tests: 4 };
  p.invariants = structuredClone(p.nodes[0]!.checks); p.nodes[0]!.review = { count: 2, min_rank: 2 };
  n.nodes[0]!.writes = [''];
  const d = planDowngrades(p, n).map(x => x.what).join('\n');
  for (const s of ['removed', 'red disabled', 'min_tests lowered', 'count lowered', 'rank lowered', 'writes widened']) assert.ok(d.includes(s));
  assert.deepEqual(planDowngrades(p, structuredClone(p)), []);
});
