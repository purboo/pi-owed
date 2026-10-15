import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import * as views from '../src/views.ts';
import { runJob } from '../src/exec.ts';
import { Ledger } from '../src/ledger.ts';
import { parsePlan } from '../src/plan.ts';
import { reduce } from '../src/reducer.ts';
import { candidateFacts, stateFacts } from '../src/git.ts';
import type { Draft, Entry, ObsEntry } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const owner = { role: 'owner', id: 'pi' } as const, parent = { role: 'parent', id: 'test' } as const;
const name = 'query contract frozen refusal';
function tap(line = 267, expected = 'dev_feature_frozen', actual = 'undefined', location = '23') {
  return `TAP version 13\nnot ok 1 - ${name}\n  ---\n  error: 'Expected values to be strictly equal:'\n  expected: '${expected}'\n  actual: '${actual}'\n  location: file://$PWD/tests/query-contract.test.mjs:${location}:1\n  stack: |-\n    TestContext.<anonymous> (file://$PWD/tests/query-contract.test.mjs:${line}:9)\n    frozenError (file://$PWD/tests/query-contract.test.mjs:23:4)\n  ...\n1..1\n# tests 1\n# pass 0\n# fail 1\n`;
}
const shellTap = (body: string) => `cat <<EOF\n${body}EOF\nexit 1`;
async function execFixture() {
  const r = await repo();
  await commitAt(r.cwd, { impl: 'base', 'tests/query-contract.test.mjs': '// fixture\n' });
  const plan = parsePlan(JSON.stringify({ version: 1, trunk: 'main', lease: false, closure: [], nodes: [{ id: 'a', writes: ['impl'], checks: [{ id: 'suite', run: 'true' }] }] }));
  const ledger = await Ledger.open(r.cwd), commit = await r.commit();
  const run = (command: string, extra: object = {}) => runJob({ cwd: r.cwd, plan, ledger }, { kind: 'check', subject: 'a', obligation: 'check:suite', key: 'k', commit, base: commit, spec: { ...plan.nodes[0]!.checks[0]!, run: command, ...extra } });
  return { ...r, plan, ledger, run };
}

test('SG1: measured signatures distinguish innermost frames and expected/actual, mask volatile values, and never equal legacy signatures', async () => {
  const r = await execFixture();
  try {
    const first = await r.run(shellTap(tap()));
    const sig = first.signatures?.[name];
    assert.match(sig!, /^v2\|/);
    assert.match(sig!, /tests\/query-contract.test.mjs:267/);
    assert.doesNotMatch(sig!, /query-contract.test.mjs:23/);
    assert.match(sig!, /dev_feature_frozen/);
    assert.match(sig!, /undefined/);
    assert.notEqual(sig, 'Expected values to be strictly equal:');
    assert.notEqual(sig, (await r.run(shellTap(tap(248, 'false')))).signatures?.[name]);
    assert.notEqual(sig, (await r.run(shellTap(tap(267, 'false')))).signatures?.[name]);
    assert.notEqual(sig, (await r.run(shellTap(tap(267, 'dev_feature_frozen', 'false')))).signatures?.[name]);
    const a = await r.run(shellTap(tap(267, '/tmp/one/abcdef123456 after 120ms')));
    const b = await r.run(shellTap(tap(267, '/tmp/two/fedcba654321 after 999ms')));
    assert.equal(a.signatures?.[name], b.signatures?.[name]);
    const long = await r.run(shellTap(tap(267, 'x'.repeat(200))));
    assert.ok(long.signatures?.[name]?.includes('x'.repeat(120)));
    assert.ok(!long.signatures?.[name]?.includes('x'.repeat(121)));
  } finally { await r.cleanup(); }
});

test('SG1/SG4: real node assertion output quotes expected/actual and its innermost test frame', async () => {
  const r = await execFixture();
  try {
    await r.put('tests/real.test.mjs', "import test from 'node:test'; import assert from 'node:assert/strict';\nfunction frozenError() { assert.equal(undefined, 'dev_feature_frozen'); }\ntest('real frozen assertion', () => frozenError());\n");
    const commit = await r.commit();
    const obs = await runJob({ cwd: r.cwd, plan: r.plan, ledger: r.ledger }, { kind: 'check', subject: 'a', obligation: 'check:suite', key: 'real', commit, base: commit, spec: { ...r.plan.nodes[0]!.checks[0]!, run: 'node --test --test-reporter=tap tests/real.test.mjs' } });
    assert.equal(obs.verdict, 'fail');
    assert.match(obs.signatures!['real frozen assertion']!, /v2\|.*tests\/real.test.mjs:2/);
    assert.match(obs.note!, /real frozen assertion \(tests\/real.test.mjs:2\): expected dev_feature_frozen, actual/);
    assert.doesNotMatch(obs.note!, /last output:/);
  } finally { await r.cleanup(); }
});

test('SG1: external stacks and test creation locations do not enter the signature', async () => {
  const r = await execFixture();
  try {
    const a = await r.run(shellTap(tap().replace('file://$PWD/tests/query-contract.test.mjs:267:9', 'file:///external/tests/query-contract.test.mjs:267:9').replace('file://$PWD/tests/query-contract.test.mjs:23:4', 'node:internal/test_runner/test:23:4')));
    const b = await r.run(shellTap(tap(267, 'dev_feature_frozen', 'undefined', '99').replace('file://$PWD/tests/query-contract.test.mjs:267:9', 'file:///external/tests/query-contract.test.mjs:267:9').replace('file://$PWD/tests/query-contract.test.mjs:23:4', 'node:internal/test_runner/test:23:4')));
    assert.equal(a.signatures?.[name], b.signatures?.[name]);
    assert.doesNotMatch(a.signatures?.[name]!, /query-contract.test.mjs/);
  } finally { await r.cleanup(); }
});

function historyRig() {
  const p = parsePlan(JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [{ id: 'suite', run: 'true' }], nodes: [{ id: 'a', writes: ['impl'] }, { id: 'b', writes: ['other'], checks: [{ id: 'suite', run: 'true' }] }] }));
  const entries: Entry[] = [];
  const add = (draft: Draft) => { const e = { ...draft, seq: entries.length, ts: '2026-10-15T00:00:00Z', prev: 'x', hash: 'x' } as Entry; entries.push(e); return e; };
  add({ kind: 'genesis', by: 'owner:pi', trunk: 'main', plan: 'p', commit: 'base', state: { commit: 'base', tree: 't', invKeys: { suite: 'tk' } } });
  add({ kind: 'dispatch', by: 'parent:test', node: 'a', attempt: 1, base: 'base', branch: 'a', worktree: 'a', packet: 'p', rulings_seen: -1 });
  add({ kind: 'submit', by: 'writer:a#1', node: 'a', attempt: 1, facts: { commit: 'candidate', tree: 't', base: 'base', patch: 'p', changed: [], closureTouched: false, keys: { writes: 'w', rulings: 'r' } } });
  const obs = (extra: Partial<ObsEntry> = {}) => add({ kind: 'obs', by: 'executor:owed', subject: 'trunk', obligation: 'inv:suite', key: 'tk', commit: 'base', verdict: 'fail', exit: 1, durationMs: 1, failed: [name], signatures: { [name]: 'v2|same' }, ...extra }) as ObsEntry;
  return { entries, add, obs, hints: (failure: ObsEntry) => views.mergeFailureHints(reduce(entries, () => p), 'a', [failure]).join('\n') };
}

test('SG2: same-signature trunk failure alone is not intermittent; matching same-key pass/fail is required', () => {
  const r = historyRig();
  r.obs({ key: 'old', commit: 'old' });
  const fail = r.obs({ subject: 'trunk', merging: 'a', key: 'mk', commit: 'merge' });
  assert.doesNotMatch(r.hints(fail), /known intermittent/);
  r.obs({ key: 'old', commit: 'old', verdict: 'pass', exit: 0, failed: undefined, signatures: undefined });
  assert.match(r.hints(fail), /known intermittent:.*failed and passed on the same key/);
  const different = r.obs({ subject: 'trunk', merging: 'a', key: 'mk2', commit: 'merge2', signatures: { [name]: 'v2|different' } });
  assert.doesNotMatch(r.hints(different), /known intermittent/);
  const legacy = r.obs({ subject: 'trunk', merging: 'a', key: 'mk3', commit: 'merge3', signatures: { [name]: 'same' } });
  assert.doesNotMatch(r.hints(legacy), /known intermittent/);
  const unknown = r.obs({ subject: 'trunk', merging: 'a', key: 'mk4', commit: 'merge4', signatures: undefined });
  assert.match(r.hints(unknown), /known intermittent/);
});

test('SG3: current trunk red takes precedence, traces the unbroken signature run to adopt, and resets after pass/different error', () => {
  const r = historyRig();
  r.obs({ signatures: { [name]: 'v2|different' } });
  r.obs({ key: 'new-key', commit: 'new', signatures: { [name]: 'v2|different' } });
  const adoption = r.add({ kind: 'adopt', by: 'owner:pi', trunk: 'main', changed: ['impl'], commits: 1, note: 'fixture change', prior: 'base', commit: 'new', state: { commit: 'new', tree: 't2', invKeys: { suite: 'new-key' } } });
  const first = r.obs({ key: 'new-key', commit: 'new' });
  r.obs({ key: 'new-key', commit: 'new' });
  const current = r.obs({ subject: 'trunk', merging: 'a', key: 'merge-key', commit: 'merge' });
  assert.match(r.hints(current), new RegExp(`trunk red since #${first.seq} \\(after adopt #${adoption.seq}\\)`));
  assert.doesNotMatch(r.hints(current), /known intermittent/);
  r.obs({ key: 'new-key', commit: 'new', signatures: { [name]: 'v2|different' } });
  assert.doesNotMatch(r.hints(current), /trunk red since/);
  const next = r.obs({ key: 'new-key', commit: 'new' });
  assert.match(r.hints(current), new RegExp(`trunk red since #${next.seq}`));
  r.obs({ key: 'new-key', commit: 'new', verdict: 'pass', failed: undefined, signatures: undefined });
  assert.doesNotMatch(r.hints(current), /trunk red since/);
});

test('SG3: trunk probes report the merge before the first same-signature trunk failure', () => {
  const r = historyRig();
  r.obs({ verdict: 'pass', exit: 0, failed: undefined, signatures: undefined });
  r.add({ kind: 'obs', by: 'executor:owed', subject: 'a', obligation: 'writes', key: 'w', verdict: 'pass', exit: 0, durationMs: 1, commit: 'candidate' });
  const merged = r.add({ kind: 'merge', by: 'executor:owed', node: 'a', attempt: 1, prior: 'base', commit: 'candidate', facts: { commit: 'candidate', tree: 't', base: 'base', patch: 'p', changed: [], closureTouched: false, keys: { writes: 'w', rulings: 'r' } }, state: { commit: 'candidate', tree: 't', invKeys: { suite: 'tk' } } });
  r.add({ kind: 'dispatch', by: 'parent:test', node: 'b', attempt: 1, base: 'candidate', branch: 'b', worktree: 'b', packet: 'p', rulings_seen: -1 });
  r.add({ kind: 'submit', by: 'writer:b#1', node: 'b', attempt: 1, facts: { commit: 'other-tree', tree: 't2', base: 'candidate', patch: 'p2', changed: [], closureTouched: false, keys: { writes: 'w2', rulings: 'r2', 'check:suite': 'ck' } } });
  const first = r.obs({ subject: 'b', obligation: 'check:suite', probe: 'trunk', commit: 'candidate', base: 'candidate' });
  const failure = { ...first, probe: undefined, key: 'merge-key', commit: 'other-tree' };
  assert.match(r.hints(failure), new RegExp(`trunk red since #${first.seq} \\(after merge #${merged.seq} a\\)`));
  assert.doesNotMatch(r.hints(failure), /known intermittent/);
});

test('SG4: CLI merge refusal and why quote failing locations/values, not passing summary tails', async () => {
  const r = await repo();
  try {
    await commitAt(r.cwd, { impl: 'base', flag: 'clean', 'tests/query-contract.test.mjs': '// fixture', 'check.sh': `if grep -q broken flag && grep -q candidate impl; then ${shellTap(tap())}; fi\necho '# tests 1'; echo '# pass 1'\n` });
    const plan = { version: 1, trunk: 'main', lease: false, closure: [], invariants: [], nodes: [{ id: 'a', writes: ['impl'], checks: [{ id: 'suite', run: 'bash check.sh', min_tests: 1 }] }] };
    await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify(plan) });
    const slot = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
    await commitAt(slot.worktree, { impl: 'candidate' });
    await ops.submit({ cwd: slot.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
    assert.equal((await ops.attest({ cwd: r.cwd, node: 'a' })).accepted, true);
    await commitAt(r.cwd, { flag: 'broken' });
    await ops.adopt({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'fixture trunk change' });
    const refusal = await cli(r.cwd, ['merge', 'a', '--as', 'parent:test']);
    assert.equal(refusal.code, 1, refusal.stderr);
    const quote = `${name} (tests/query-contract.test.mjs:267): expected dev_feature_frozen, actual undefined`;
    assert.ok(refusal.stderr.includes(quote), refusal.stderr);
    assert.doesNotMatch(refusal.stderr, /last output:|# pass 0/);
    const card = views.renderReceipt(await ops.why({ cwd: r.cwd, node: 'a' }));
    assert.ok(card.includes(quote), card);
    assert.doesNotMatch(card, /last output:/);
  } finally { await r.cleanup(); }
});

test('SG4: quote at most three failures, fallback to first error without values, tail only for anonymous crashes', async () => {
  const r = await execFixture();
  try {
    const body = [1, 2, 3, 4].map(n => `not ok ${n} - failure ${n}\n  ---\n  error: 'specific error ${n}'\n  ...\n`).join('') + '1..4\n# tests 4\n# fail 4\n# pass 0\n';
    const obs = await r.run(shellTap(body));
    assert.match(obs.note!, /failure 1: specific error 1/);
    assert.match(obs.note!, /failure 3: specific error 3/);
    assert.doesNotMatch(obs.note!, /failure 4:|last output:/);
    const crash = await r.run('echo fatal-build-error; exit 2');
    assert.match(crash.note!, /last output:.*\n  fatal-build-error/);
  } finally { await r.cleanup(); }
});

test('SG5: timed-out ops measurement keeps bounded output, pre-kill process tree, one diagnostic, and a red verdict', async () => {
  const r = await repo();
  try {
    const marker = join(r.root, 'diagnostic-count'), child = join(r.root, 'child-pid');
    await commitAt(r.cwd, { impl: 'base' });
    const check = { id: 'hung', run: `printf 'x%.0s' $(seq 1 300000); printf '\\nlast-one\\nlast-two\\nwaiting-for-lock\\n'; sleep 90 & echo $! > '${child}'; wait`, timeout_s: 1, on_timeout: `echo once >> '${marker}'; echo diagnostic-before-kill; echo 'owed-counts {"pass":999,"fail":0}'; echo 'not ok 1 - diagnostic-only-failure'; exit 7` };
    await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify({ version: 1, trunk: 'main', lease: false, closure: [], nodes: [{ id: 'a', writes: ['impl'], checks: [check] }] }) });
    const slot = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
    await commitAt(slot.worktree, { impl: 'candidate' });
    await ops.submit({ cwd: slot.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
    assert.equal((await ops.attest({ cwd: r.cwd, node: 'a' })).accepted, false);
    const ledger = await Ledger.open(r.cwd), obs = (await ledger.read()).findLast((e): e is ObsEntry => e.kind === 'obs' && e.obligation === 'check:hung')!;
    assert.equal(obs.verdict, 'error');
    assert.equal(obs.counts, undefined, 'diagnostic output never becomes measurement counts');
    assert.equal(obs.failed, undefined, 'diagnostic output never becomes failed test evidence');
    assert.equal(obs.note, 'timeout after 1s; last-one | last-two | waiting-for-lock');
    const log = (await ledger.getBlob(obs.log!)).toString();
    assert.match(log, /last-one\nlast-two\nwaiting-for-lock\n\ntimeout after 1s/);
    assert.match(log, /diagnostic-before-kill/);
    assert.match(log, /process tree \(pid ppid state wchan elapsed args\):/);
    assert.match(log, /sleep 90/);
    assert.ok(Buffer.byteLength(log) < 270000, `bounded log: ${Buffer.byteLength(log)}`);
    assert.equal(await readFile(marker, 'utf8'), 'once\n');
    const pid = Number((await readFile(child, 'utf8')).trim());
    try { process.kill(pid, 0); const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); assert.match(stat, /\) Z /, 'no live owned child'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH' && (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    assert.equal((await cli(r.cwd, ['why', 'a'])).code, 0);
  } finally { await r.cleanup(); }
});

test('SG5: absent and hanging diagnostics cannot pass or keep the owned process running', { timeout: 45000 }, async () => {
  const r = await execFixture();
  try {
    const absent = await r.run('echo waiting-without-hook; sleep 90', { timeout_s: 1 });
    assert.equal(absent.verdict, 'error');
    const log = (await r.ledger.getBlob(absent.log!)).toString();
    assert.match(log, /waiting-without-hook/);
    assert.match(log, /process tree/);
    assert.doesNotMatch(log, /on_timeout/);
    const start = Date.now();
    const hung = await r.run('echo primary-hang; sleep 90', { timeout_s: 1, on_timeout: 'echo diagnostic-hang; sleep 90' });
    assert.equal(hung.verdict, 'error');
    assert.equal(hung.note, 'timeout after 1s; primary-hang');
    const diagnostic = (await r.ledger.getBlob(hung.log!)).toString();
    assert.match(diagnostic, /diagnostic-hang/);
    assert.match(diagnostic, /timeout after 30s/);
    assert.ok(Date.now() - start < 35000, 'diagnostic has its own 30s bound');
  } finally { await r.cleanup(); }
});

test('SG5: on_timeout is optional, validated and editable on checks and invariants without changing keys', async () => {
  const r = await repo();
  try {
    await commitAt(r.cwd, { impl: 'base', 'plan.json': JSON.stringify({ version: 1, trunk: 'main', lease: false, closure: [], invariants: [{ id: 'i', run: 'true' }], nodes: [{ id: 'a', writes: ['impl'], checks: [{ id: 'c', run: 'true' }] }] }) });
    const init = await cli(r.cwd, ['init', 'plan.json', '--as', 'owner:pi']);
    assert.equal(init.code, 0, init.stderr);
    const priorPlan = parsePlan(await readFile(join(r.cwd, 'plan.json'), 'utf8'));
    const commit = await r.commit();
    const priorKeys = await candidateFacts(r.cwd, priorPlan, priorPlan.nodes[0]!, commit, commit, 1);
    const priorState = await stateFacts(r.cwd, priorPlan, commit);
    const edit = await cli(r.cwd, ['edit', 'a', '--plan', 'plan.json', '--set', 'checks.c.on_timeout=echo diagnostic', '--note', 'diagnostic only', '--as', 'owner:pi']);
    assert.equal(edit.code, 0, edit.stderr);
    const inv = await cli(r.cwd, ['edit', '--invariant', 'i', '--plan', 'plan.json', '--set', 'on_timeout=echo inv-diagnostic', '--note', 'diagnostic only', '--as', 'owner:pi']);
    assert.equal(inv.code, 0, inv.stderr);
    const data = parsePlan(await readFile(join(r.cwd, 'plan.json'), 'utf8'));
    assert.equal(data.nodes[0]!.checks[0]!.on_timeout, 'echo diagnostic');
    assert.equal(data.invariants[0]!.on_timeout, 'echo inv-diagnostic');
    assert.deepEqual((await candidateFacts(r.cwd, data, data.nodes[0]!, commit, commit, 1)).keys, priorKeys.keys);
    assert.deepEqual((await stateFacts(r.cwd, data, commit)).invKeys, priorState.invKeys);
    assert.throws(() => parsePlan(JSON.stringify({ ...data, invariants: [{ id: 'i', run: 'true', on_timeout: 3 }] })), /on_timeout: expected non-empty string/);
  } finally { await r.cleanup(); }
});
