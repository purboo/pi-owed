// CT1: plan templates exercise the same CLI, observations, keys and receipt paths as handwritten checks.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';
import { Ledger } from '../src/ledger.ts';
import * as ops from '../src/ops.ts';
import { candidateFacts, stateFacts } from '../src/git.ts';
import * as templatePlan from '../src/plan.ts';
const { parsePlan, CHECK_TEMPLATE_VERSION, isCheckTemplateRun } = templatePlan;
import type { ObsEntry } from '../src/types.ts';

const cargoWrapper = { exec: { wrap: ['bash', '-c', 'cargo() { node test/cargo.cjs "$@"; }; export -f cargo; exec "$@"', '--'] } };
const owner = { role: 'owner', id: 'pi' } as const, parent = { role: 'parent', id: 'main' } as const;
const planText = (check: object, invariant = false, extra: object = {}) => JSON.stringify({ version: 1, trunk: 'main', lease: false, closure: [], invariants: invariant ? [{ id: 'gate', ...check }] : [], nodes: [{ id: 'a', writes: ['src/', 'test/', 'evidence/'], checks: invariant ? [] : [{ id: 'gate', ...check }] }], ...extra });
async function measured(check: object, files: Record<string, string>, extra: object = {}, invariant = false) {
  const r = await repo();
  try {
    // Invariant tests need their files on the initial trunk as well as on the prospective merge tree.
    await commitAt(r.cwd, invariant ? { 'src/value': 'base', ...files } : { 'src/value': 'base' });
    const text = planText(check, invariant, extra);
    await ops.init({ cwd: r.cwd, plan: text, as: owner, channel: 'delegated' });
    const d = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
    await commitAt(d.worktree, { 'src/value': 'candidate', ...files });
    await ops.submit({ cwd: d.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
    const result = await ops.attest({ cwd: r.cwd, node: 'a' });
    const ledger = await Ledger.open(r.cwd);
    return { ...r, result, ledger, text, worktree: d.worktree, packet: d.packet };
  } catch (e) { await r.cleanup(); throw e; }
}
const nodeCheck = (name: string, body = '') => `import test from 'node:test';test(${JSON.stringify(name)},()=>{${body}});\n`;
const observation = (f: Awaited<ReturnType<typeof measured>>) => f.result.observations.find((e): e is ObsEntry => e.kind === 'obs' && e.obligation === 'check:gate')!;

test('CT1 node-tap: literal prefix, shell-safe files, successful-test counting and expanded CLI receipts', async () => {
  const file = "test/a 'quoted;$(touch injected).mjs", prefix = 'gate.[x]';
  const f = await measured({ template: 'node-tap', files: [file], name_prefix: prefix, min_ok: 1 }, { [file]: nodeCheck(`${prefix} passes`) + "test('not selected',()=>{throw new Error('must be filtered')});" });
  try {
    assert.equal(f.result.accepted, true, (await f.ledger.getBlob(observation(f).log!)).toString());
    const obs = observation(f); assert.equal(obs.verdict, 'pass', obs.note); assert.equal(obs.counts?.pass, 1); assert.equal(obs.counts?.tests, 1);
    const run = parsePlan(f.text).nodes[0]!.checks[0]!.run;
    assert.match(run, /^# owed-template\/v1\/node-tap\n/); assert.match(run, /node --test --test-reporter=tap/); assert.ok(f.packet.includes(run));
    const why = await cli(f.cwd, ['why', 'a', '--full']); assert.equal(why.code, 0, why.stderr); assert.ok(why.stdout.includes(run));
    const json = await cli(f.cwd, ['why', 'a', '--json']); assert.equal(json.code, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout).items.find((i: { obligation: string }) => i.obligation === 'check:gate').run, run);
    assert.equal(f.result.receipt.items.find(i => i.obligation === 'check:gate')?.run, run);
    assert.equal((await ops.verify({ cwd: f.cwd })).ok, true);
  } finally { await f.cleanup(); }
});

test('CT1 node-tap: zero matches, skipped tests, too few successes, failures and crashes cannot pass', async () => {
  for (const [code, prefix, min] of [
    [nodeCheck('other'), 'wanted', 1],
    ["import test from 'node:test';test('wanted',{skip:true},()=>{});", 'wanted', 1],
    [nodeCheck('wanted'), 'wanted', 2],
    [nodeCheck('wanted', "throw new Error('runner regression')"), 'wanted', 1],
    ['throw new Error("runner crashed before tests");', 'wanted', 0],
  ] as const) {
    const f = await measured({ template: 'node-tap', files: ['test/gate.mjs'], name_prefix: prefix, min_ok: min }, { 'test/gate.mjs': code });
    try { assert.equal(f.result.accepted, false, JSON.stringify({ code, observations: f.result.observations, log: (await f.ledger.getBlob(observation(f).log!)).toString() })); assert.equal(observation(f).verdict, 'fail', observation(f).note); } finally { await f.cleanup(); }
  }
});

test('CT1 node-tap: multiple files exclude empty wrappers and a timeout remains an execution error', async () => {
  const f = await measured({ template: 'node-tap', files: ['test/empty.mjs', 'test/gate.mjs'], name_prefix: 'gate', min_ok: 1 }, { 'test/empty.mjs': nodeCheck('other'), 'test/gate.mjs': nodeCheck('gate') });
  try { assert.equal(f.result.accepted, true); assert.equal(observation(f).counts?.pass, 1); } finally { await f.cleanup(); }
  const timeout = await measured({ template: 'node-tap', files: ['test/gate.mjs'], min_ok: 1, timeout_s: 1 }, { 'test/gate.mjs': "import test from 'node:test';test('hangs',async()=>{await new Promise(r=>setTimeout(r,10000))});" });
  try { assert.equal(timeout.result.accepted, false); assert.equal(observation(timeout).verdict, 'error'); assert.match(observation(timeout).note!, /timeout/); } finally { await timeout.cleanup(); }
});

test('CT1 node-tap: unfiltered empty files fail and mixed files count only real tests', async () => {
  for (const empty of ['', "console.log('diagnostic only');"]) {
    const f = await measured({ template: 'node-tap', files: ['test/empty.mjs'], min_ok: 1 }, { 'test/empty.mjs': empty });
    try { assert.equal(f.result.accepted, false); assert.equal(observation(f).verdict, 'fail'); assert.equal(observation(f).counts?.pass, 0); assert.equal(observation(f).counts?.tests, 0); } finally { await f.cleanup(); }
  }
  const mixed = await measured({ template: 'node-tap', files: ['test/empty.mjs', 'test/real.mjs'], min_ok: 1 }, { 'test/empty.mjs': '', 'test/real.mjs': nodeCheck('real') });
  try { assert.equal(mixed.result.accepted, true); assert.equal(observation(mixed).counts?.pass, 1); assert.equal(observation(mixed).counts?.tests, 1); } finally { await mixed.cleanup(); }
  // CT parent ruling: a path-like title differing from the input file is a real test.
  const ambiguous = await measured({ template: 'node-tap', files: ['test/real.mjs'], min_ok: 1 }, { 'test/real.mjs': nodeCheck('test/looks-like-file.mjs') });
  try { assert.equal(ambiguous.result.accepted, true); assert.equal(observation(ambiguous).counts?.pass, 1); } finally { await ambiguous.cleanup(); }
  for (const files of [['./test/empty.mjs'], ['test/*.mjs']]) {
    const empty = await measured({ template: 'node-tap', files, min_ok: 1 }, { 'test/empty.mjs': '' });
    try { assert.equal(empty.result.accepted, false); assert.equal(observation(empty).counts?.pass, 0); } finally { await empty.cleanup(); }
  }
  const glob = await measured({ template: 'node-tap', files: ['test/*.mjs'], min_ok: 1 }, { 'test/empty.mjs': '', 'test/real.mjs': nodeCheck('test/looks-like-file.mjs') });
  try { assert.equal(glob.result.accepted, true); assert.equal(observation(glob).counts?.pass, 1); } finally { await glob.cleanup(); }
  const nested = await measured({ template: 'node-tap', files: ['test/real.mjs'], min_ok: 2 }, { 'test/real.mjs': "import test from 'node:test';test('test/real.mjs',async t=>{await t.test('child',()=>{})});" });
  try { assert.equal(nested.result.accepted, true); assert.equal(observation(nested).counts?.pass, 2); } finally { await nested.cleanup(); }
  // Exact input-file names are wrappers only without subtests; ./ and backslashes normalize equally.
  const normalized = await measured({ template: 'node-tap', files: ['./test/real.mjs'], min_ok: 1 }, { 'test/real.mjs': nodeCheck('  ./test\\real.mjs  ') });
  try { assert.equal(normalized.result.accepted, false); assert.equal(observation(normalized).counts?.pass, 0); } finally { await normalized.cleanup(); }
});

test('CT1 version constant alone changes generated commands, recognition and check/invariant keys', async () => {
  const r = await repo();
  try {
    await r.put('src/value', 'base'); const commit = await r.commit();
    const sourceURL = new URL('../src/plan.ts', import.meta.url);
    const source = await readFile(sourceURL, 'utf8');
    // Import an isolated copy, changing ONLY the version constant; never mutate the tested source tree.
    const changed = source.replace(/export const CHECK_TEMPLATE_VERSION = \d+;/, `export const CHECK_TEMPLATE_VERSION = ${CHECK_TEMPLATE_VERSION + 1};`);
    assert.notEqual(changed, source, 'version constant must exist');
    const resolved = changed.replace(/from '(\.[^']+|yaml)'/g, (_all, spec: string) => `from '${spec === 'yaml' ? import.meta.resolve('yaml') : new URL(spec, sourceURL).href}'`);
    const path = join(r.root, 'plan-next.ts'); await writeFile(path, resolved);
    const next = await import(pathToFileURL(path).href) as typeof import('../src/plan.ts');
    assert.equal(next.CHECK_TEMPLATE_VERSION, CHECK_TEMPLATE_VERSION + 1);
    for (const check of [{ template: 'node-tap', files: ['test/gate.mjs'], min_ok: 1 }, { template: 'cargo-tests', package: 'pkg', min_ok: 1 }, { template: 'evidence-json', path: 'data.json', required: ['value'] }]) {
      const before = parsePlan(planText(check)), after = next.parsePlan(planText(check));
      const run = before.nodes[0]!.checks[0]!.run, nextRun = after.nodes[0]!.checks[0]!.run;
      assert.ok(run.startsWith(`# owed-template/v${CHECK_TEMPLATE_VERSION}/`));
      assert.equal(nextRun, run.replace(`# owed-template/v${CHECK_TEMPLATE_VERSION}/`, `# owed-template/v${next.CHECK_TEMPLATE_VERSION}/`));
      assert.ok(isCheckTemplateRun(run)); assert.ok(next.isCheckTemplateRun(nextRun)); assert.equal(next.isCheckTemplateRun(run), false);
      assert.notEqual((await candidateFacts(r.cwd, before, before.nodes[0]!, commit, commit, 1)).keys['check:gate'], (await candidateFacts(r.cwd, after, after.nodes[0]!, commit, commit, 1)).keys['check:gate']);
      assert.notEqual((await stateFacts(r.cwd, parsePlan(planText(check, true)), commit)).invKeys.gate, (await stateFacts(r.cwd, next.parsePlan(planText(check, true)), commit)).invKeys.gate);
    }
  } finally { await r.cleanup(); }
});

test('CT1 cargo-tests: package, optional target and multiple filters are quoted argv; counts exclude ignored tests', async () => {
  // A hermetic cargo stand-in validates argv and emits real libtest summary syntax; no Rust installation is needed.
  const pkg = "pkg';touch injected;#", target = 'integration target', filters = ['one filter', '-two'];
  const script = `const assert=require('node:assert/strict');assert.deepEqual(process.argv.slice(2),${JSON.stringify(['test', '-p', pkg, '--test', target, '--', ...filters])});console.log('test gate::one ... ok\\ntest result: ok. 1 passed; 0 failed; 9 ignored;\\ntest gate::two ... ok\\ntest result: ok. 1 passed; 0 failed; 0 ignored;');`;
  const extra = cargoWrapper;
  const f = await measured({ template: 'cargo-tests', package: pkg, test: target, filters, min_ok: 2 }, { 'test/cargo.cjs': script }, extra);
  try {
    assert.equal(f.result.accepted, true); assert.equal(observation(f).counts?.tests, 2); assert.equal(observation(f).counts?.pass, 2);
    assert.match(parsePlan(f.text).nodes[0]!.checks[0]!.run, /^# owed-template\/v1\/cargo-tests/);
  } finally { await f.cleanup(); }
  for (const [output, exit] of [['test result: ok. 0 passed; 0 failed; 9 ignored;', 0], ['test gate::broken ... FAILED\ntest result: FAILED. 1 passed; 1 failed; 0 ignored;', 0], ['build failed before tests', 101], ['test result: ok. 1 passed; 0 failed; 0 ignored;', 101]] as const) {
    const f = await measured({ template: 'cargo-tests', package: 'pkg', min_ok: 1 }, { 'test/cargo.cjs': `console.log(${JSON.stringify(output)});process.exitCode=${exit}` }, extra);
    try { assert.equal(f.result.accepted, false); assert.equal(observation(f).verdict, 'fail'); } finally { await f.cleanup(); }
  }
});

test('CT1 evidence-json: nested own fields and array indexes exist even when false/null; invalid evidence fails', async () => {
  const path = "evidence/data 'quoted;$(touch injected).json", required = ['result.ok', 'result.value', 'rows.0.id'];
  const f = await measured({ template: 'evidence-json', path, required }, { [path]: JSON.stringify({ result: { ok: false, value: null }, rows: [{ id: 0 }] }) });
  try { assert.equal(f.result.accepted, true); assert.equal(observation(f).counts?.pass, 1); } finally { await f.cleanup(); }
  for (const [contents, fields] of [['not JSON', ['result']], ['{}', ['result.ok']], ['{}', ['toString']], ['null', ['result']]] as const) {
    const f = await measured({ template: 'evidence-json', path: 'evidence/data.json', required: fields }, { 'evidence/data.json': contents });
    try {
      assert.equal(f.result.accepted, false); const obs = observation(f); assert.equal(obs.verdict, 'fail');
      assert.deepEqual(obs.failed, ['evidence-json: evidence/data.json']); assert.match((await f.ledger.getBlob(obs.log!)).toString(), /evidence-json:/);
    } finally { await f.cleanup(); }
  }
  const missing = await measured({ template: 'evidence-json', path: 'evidence/missing.json', required: ['result'] }, {});
  try { assert.equal(observation(missing).verdict, 'fail'); } finally { await missing.cleanup(); }
});

test('CT1 templates work on invariants and normalize to exactly the same plan/check/invariant keys as run', async () => {
  for (const check of [{ template: 'cargo-tests', package: 'pkg', min_ok: 1 }, { template: 'node-tap', files: ['test/gate.mjs'], min_ok: 1 }, { template: 'evidence-json', path: 'evidence/data.json', required: ['result'] }]) {
    const files = { 'test/gate.mjs': nodeCheck('gate'), 'test/cargo.cjs': "console.log('test result: ok. 1 passed; 0 failed; 0 ignored;')", 'evidence/data.json': '{"result":true}' };
    const f = await measured(check, files, cargoWrapper, true);
    try {
      await ops.merge({ cwd: f.cwd, node: 'a', as: parent });
      const why = await cli(f.cwd, ['why', 'inv:gate', '--full']); assert.equal(why.code, 0, why.stderr);
      const expanded = parsePlan(f.text).invariants[0]!; assert.ok(why.stdout.includes(expanded.run));
      const trunk = await cli(f.cwd, ['why', 'trunk', '--full']); assert.equal(trunk.code, 0, trunk.stderr); assert.ok(trunk.stdout.includes(expanded.run));
      const plain = parsePlan(planText({ run: expanded.run, ...(expanded.min_tests === undefined ? {} : { min_tests: expanded.min_tests }) }, true, cargoWrapper));
      assert.deepEqual(parsePlan(f.text), plain, 'template metadata is not persisted');
      const state = await ops.status({ cwd: f.cwd });
      assert.deepEqual(await stateFacts(f.cwd, parsePlan(f.text), state.trunk.commit), await stateFacts(f.cwd, plain, state.trunk.commit));
      const withCheck = parsePlan(planText(check)), withRun = parsePlan(planText({ run: expanded.run, ...(expanded.min_tests === undefined ? {} : { min_tests: expanded.min_tests }) }));
      assert.deepEqual(await candidateFacts(f.cwd, withCheck, withCheck.nodes[0]!, state.trunk.commit, state.trunk.commit, 1), await candidateFacts(f.cwd, withRun, withRun.nodes[0]!, state.trunk.commit, state.trunk.commit, 1));
      assert.equal((await ops.verify({ cwd: f.cwd })).ok, true);
    } finally { await f.cleanup(); }
  }
});

test('CT1 CLI plan validation names invalid template fields and records nothing', async () => {
  const r = await repo();
  try {
    await r.put('src/value', 'base'); await r.commit();
    const file = join(r.root, 'plan.json');
    const cases: [object, string][] = [
      [{ template: 'unknown' }, 'template'], [{ template: 'node-tap', run: 'true', files: ['test/a'], min_ok: 1 }, 'run'],
      [{ template: 'cargo-tests', min_ok: 1 }, 'package'], [{ template: 'cargo-tests', package: 'p' }, 'min_ok'],
      [{ template: 'cargo-tests', package: 'p', min_ok: -1 }, 'min_ok'], [{ template: 'cargo-tests', package: 'p', min_ok: 1, test: '' }, 'test'],
      [{ template: 'cargo-tests', package: 'p', min_ok: 1, filters: [''] }, 'filters'],
      [{ template: 'node-tap', min_ok: 1 }, 'files'], [{ template: 'node-tap', files: [], min_ok: 1 }, 'files'],
      [{ template: 'node-tap', files: ['a'], min_ok: '1' }, 'min_ok'], [{ template: 'node-tap', files: ['a'], min_ok: 1, name_prefix: '' }, 'name_prefix'],
      [{ template: 'node-tap', files: ['a'], min_ok: 2, min_tests: 1 }, 'min_tests'],
      [{ template: 'node-tap', files: ['a'], min_ok: 1, package: 'p' }, 'package'],
      [{ template: 'evidence-json', required: ['x'] }, 'path'], [{ template: 'evidence-json', path: 'p' }, 'required'],
      [{ template: 'evidence-json', path: 'p', required: ['x..y'] }, 'required[0]'],
      [{ template: null }, 'template'], [{ template: 'node-tap', files: ['bad\0path'], min_ok: 1 }, 'files'],
      [{ template: 'evidence-json', path: 'p', required: [] }, 'required'],
      [{ template: 'cargo-tests', package: 'p', min_ok: 1.5 }, 'min_ok'],
    ];
    for (const invariant of [false, true]) for (const [check, field] of cases) {
      await writeFile(file, planText(check, invariant));
      const out = await cli(r.cwd, ['init', file, '--as', 'owner:pi']);
      assert.equal(out.code, 2, out.stderr); assert.ok(out.stderr.includes(`${invariant ? 'invariants[0]' : 'nodes[0].checks[0]'}.${field}:`), out.stderr);
      assert.deepEqual(await (await Ledger.open(r.cwd)).read(), []);
    }
  } finally { await r.cleanup(); }
});
