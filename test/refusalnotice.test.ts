import test from 'node:test';
import assert from 'node:assert/strict';
import { runJob, lastLines } from '../src/exec.ts';
import * as exec from '../src/exec.ts';
const { errorGroups } = exec;
import { mergeFailureHints, renderReceipt } from '../src/views.ts';
import { parsePlan } from '../src/plan.ts';
import { reduce, entriesOf, runId, runLabels } from '../src/reducer.ts';
import { decide } from '../src/drive.ts';
import { Ledger } from '../src/ledger.ts';
import * as ops from '../src/ops.ts';
import type { Draft, Entry, ObsEntry } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { commitAt } from './helpers/surface.ts';

const tap = (name: string, error?: string, location?: string, failureType?: string) => `not ok 1 - ${name}\n  ---\n  ${failureType ? `failureType: ${failureType}\n  ` : ''}${error === undefined ? '' : `error: ${error}\n  `}${location ? `location: '${location}'\n  ` : ''}...\n`;
const summary = (n: number) => `# tests ${n}\n# pass 0\n# fail ${n}\n`;
const names11 = Array.from({ length: 11 }, (_, n) => `st_data precondition ${n + 1}`);
const shared11 = names11.map(name => tap(name, "'exact-source host required'", '@CWD@/test/runtime.test.ts:31:9')).join('') + summary(11);

test('FG1: TAP single, double and plain scalars group by normalized error and shared location', () => {
  const log = tap('first', "'can''t start;  host required'", '/work/project/test/host.ts:7:12') + tap('second', '"can\'t start; host required"', '/work/project/test/host.ts:7:30') + tap('third', 'plain assertion');
  assert.deepEqual(errorGroups(log, ['first', 'second', 'third']), [
    { message: "can't start, host required", location: 'project/test/host.ts:7', names: ['first', 'second'] },
    { message: 'plain assertion', names: ['third'] },
  ]);
});

test('FG1: plain scalar error text is preserved even when it resembles a YAML boolean, number or null', () => {
  for (const message of ['false', '404', 'null']) assert.deepEqual(errorGroups(tap('plain', message), ['plain']), [{ message, names: ['plain'] }]);
});

test('FG1: all four YAML block scalar forms show the first non-empty source line', () => {
  for (const form of ['|', '|-', '>', '>-']) {
    assert.deepEqual(errorGroups(tap('block', `${form}\n    \n    first cause; detail\n    second line`), ['block']), [{ message: 'first cause, detail', names: ['block'] }]);
  }
});

test('FG1: cargo new and old panic forms preserve line and remove column', () => {
  const log = "thread 'module::new' panicked at /build/project/src/new.rs:17:4:\nassertion `left == right` failed; detail\nnote: more details\nthread 'module::old' panicked at 'old assertion; details', src/old.rs:9:3\n";
  assert.deepEqual(errorGroups(log, ['module::old', 'module::new']), [
    { message: 'assertion `left == right` failed, detail', location: 'project/src/new.rs:17', names: ['module::new'] },
    { message: 'old assertion, details', location: 'src/old.rs:9', names: ['module::old'] },
  ]);
});

test('FG1: old cargo multiline panic retains normalized message and location through the closing quote', () => {
  const log = "thread 'module::old' panicked at 'assertion failed: left == right\n  left: 1\n right: 2', src/lib.rs:9:3\ntest module::old ... FAILED\n";
  assert.deepEqual(errorGroups(log, ['module::old']), [{
    message: 'assertion failed: left == right left: 1 right: 2', location: 'src/lib.rs:9', names: ['module::old'],
  }]);
  const quoted = "thread 'module::old' panicked at 'assertion failed:\n  left: 'one', not a location; detail\n right: 'two'', src/lib.rs:9:3\ntest module::old ... FAILED\n";
  for (const text of [quoted, quoted.replace(/\n/g, '\r\n')]) {
    assert.deepEqual(errorGroups(text, ['module::old']), [{
      message: "assertion failed: left: 'one', not a location, detail right: 'two'", location: 'src/lib.rs:9', names: ['module::old'],
    }]);
  }
});

test('FG1: unfinished old cargo panic cannot consume the next panic header', () => {
  const log = "thread 'worker' panicked at 'unfinished\nthread 'module::good' panicked at 'real cause', src/good.rs:9:3\ntest module::good ... FAILED\n";
  const good = { message: 'real cause', location: 'src/good.rs:9', names: ['module::good'] };
  for (const text of [log, log.replace(/\n/g, '\r\n'), log.replace("'unfinished\n", "'unfinished:\n")]) {
    assert.deepEqual(errorGroups(text, ['module::good']), [good]);
    assert.deepEqual(errorGroups(text, ['worker', 'module::good']), [good, { message: '(no error text)', names: ['worker'] }]);
  }
});

test('FG1: unfinished old cargo panic stops at failed-test and stdout record boundaries', () => {
  for (const boundary of ['test worker ... FAILED', '---- module::good stdout ----']) {
    const log = `thread 'worker' panicked at 'unfinished\n${boundary}\nnot part of worker', src/other.rs:4:2\nthread 'module::good' panicked at 'real cause', src/good.rs:9:3\ntest module::good ... FAILED\n`;
    assert.deepEqual(errorGroups(log, ['module::good']), [{ message: 'real cause', location: 'src/good.rs:9', names: ['module::good'] }]);
    assert.deepEqual(errorGroups(log, ['worker', 'module::good']), [
      { message: 'real cause', location: 'src/good.rs:9', names: ['module::good'] },
      { message: '(no error text)', names: ['worker'] },
    ]);
  }
});

test('FG2: old cargo multiline panic appears with error text and location in the stored failure note', async () => {
  const log = "thread 'module::old' panicked at 'assertion failed: left == right\n  left: 1\n right: 2', src/lib.rs:9:3\ntest module::old ... FAILED\ntest result: FAILED. 0 passed; 1 failed; 0 ignored;\n";
  await measure([log], obs => {
    assert.equal(obs.verdict, 'fail');
    assert.deepEqual(obs.failed, ['module::old']);
    assert.equal(obs.note!.split('; last output:')[0], 'failed tests: 1 failed, 1 distinct error(s): "assertion failed: left == right left: 1 right: 2" (src/lib.rs:9) ×1 — module::old');
  });
});

test('FG1: subtestsFailed parents are dropped only when another failing point has an error', () => {
  const parent = tap('suite', "'1 subtest failed'", undefined, 'subtestsFailed');
  assert.deepEqual(errorGroups(tap('child', "'real cause'") + parent, ['suite', 'child']), [{ message: 'real cause', names: ['child'] }]);
  assert.deepEqual(errorGroups(parent + tap('child'), ['suite', 'child']), [
    { message: '1 subtest failed', names: ['suite'] }, { message: '(no error text)', names: ['child'] },
  ]);
});

test('FG1: frequency then appearance, location disagreement, missing errors and bounded ANSI-free messages', () => {
  const long = `\x1b[31m${'a'.repeat(170)};\x1b[0m`;
  const log = tap('one', "'shared'", '/a/b/file.ts:1:2') + tap('long', `'${long}'`) + tap('two', "'shared'", '/a/b/file.ts:2:2') + tap('ignored', "'unselected'") + tap('three', "'tie'");
  const groups = errorGroups(log, ['three', 'two', 'one', 'long', 'missing']);
  assert.deepEqual(groups[0], { message: 'shared', names: ['one', 'two'] });
  assert.equal(groups[1]!.message, `${'a'.repeat(159)}…`);
  assert.equal(groups[1]!.message.length, 160);
  assert.deepEqual(groups.slice(2), [{ message: 'tie', names: ['three'] }, { message: '(no error text)', names: ['missing'] }]);
  assert.deepEqual(errorGroups('not ok 1 - malformed\n  ---\n  error: [\n  ...\n', ['malformed']), [{ message: '(no error text)', names: ['malformed'] }]);
});

test('FG1: mixed cargo/TAP CRLF logs retain first-appearance order', () => {
  const log = `${Array.from({ length: 200 }, () => '# padding').join('\n')}\nthread 'cargo' panicked at src/lib.rs:2:4:\ncargo cause\n${tap('tap', "'TAP cause'")}`.replace(/\n/g, '\r\n');
  assert.deepEqual(errorGroups(log, ['tap', 'cargo']), [
    { message: 'cargo cause', location: 'src/lib.rs:2', names: ['cargo'] },
    { message: 'TAP cause', names: ['tap'] },
  ]);
});

test('FG1: long locations retain the full file and line while only messages are capped', () => {
  const location = `project/test/${'f'.repeat(170)}.ts:12`;
  assert.deepEqual(errorGroups(tap('long path', "'cause'", `/work/${location}:8`), ['long path']), [{ message: 'cause', location, names: ['long path'] }]);
});

async function measure(logs: string[], check: (obs: Awaited<ReturnType<typeof runJob>>) => void, repeat = false, minTests = 1) {
  const r = await repo();
  try {
    for (let i = 0; i < logs.length; i++) await r.put(`log-${i + 1}`, logs[i]!);
    await r.put('run.sh', 'n=$(cat counter 2>/dev/null || echo 0)\nn=$((n+1))\necho "$n" > counter\nsed "s|@CWD@|$PWD|g" "log-$n"\nexit 1\n');
    const commit = await r.commit(), plan = parsePlan(JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [], nodes: [{ id: 'a', writes: ['test/'], checks: [{ id: 'unit', run: 'bash run.sh', min_tests: minTests, ...(repeat ? { repeat: { runs: 3, need: 2 } } : {}) }] }] }));
    const ledger = await Ledger.open(r.cwd);
    const obs = await runJob({ cwd: r.cwd, plan, ledger }, { kind: 'check', subject: 'a', obligation: 'check:unit', key: 'unit', base: commit, commit, spec: plan.nodes[0]!.checks[0] });
    check(obs);
  } finally { await r.cleanup(); }
}

test('FG2: 11 identical precondition failures render one cause and three names, retaining all failed names', async () => {
  await measure([shared11], obs => {
    assert.equal(obs.verdict, 'fail', obs.note);
    assert.deepEqual(obs.failed, names11);
    const prefix = obs.note!.split('; last output:')[0]!;
    assert.equal(prefix, `failed tests: 11 failed, 1 distinct error(s): "exact-source host required" (test/runtime.test.ts:31) ×11 — ${names11.slice(0, 3).join(', ')} (+8 more)`);
    assert.ok(!prefix.includes(';'));
    assert.match(obs.note!, /; last output:/);
  });
});

test('FG2: no parsed error preserves the entire 0.16.0 note byte-for-byte', async () => {
  const log = tap('first') + 'test module::second ... FAILED\ntest result: FAILED. 0 passed; 1 failed; 0 ignored;\n' + summary(1);
  await measure([log], obs => {
    assert.equal(obs.verdict, 'fail');
    assert.equal(obs.note, `failed tests: first, module::second; last output:${lastLines(log, 15).map(l => `\n  ${l}`).join('')}`);
    assert.deepEqual(obs.failed, ['first', 'module::second']);
  });
});

test('FG2: a parsed error equal to the fallback label still renders as an error group', async () => {
  await measure([tap('explicit', "'(no error text)'") + summary(1)], obs => {
    assert.match(obs.note!, /^failed tests: 1 failed, 1 distinct error\(s\): "\(no error text\)" ×1 — explicit; last output:/);
  });
});

test('FG2: grouped notes cap errors and names, and preserve the semicolon parser with count failures', async () => {
  const names = ['one; host', 'two', 'three', 'four', 'five'];
  const log = names.map((name, i) => tap(name, `'cause ${i}; detail'`)).join('') + summary(1);
  await measure([log], obs => {
    const prefix = obs.note!.split(';')[0]!;
    assert.equal(prefix, 'failed tests: 5 failed, 5 distinct error(s): "cause 0, detail" ×1 | "cause 1, detail" ×1 | "cause 2, detail" ×1 (+2 more errors) — one, host, two, three (+2 more)');
    assert.match(obs.note!, /; min_tests unmet: counted 1 \(0 pass, 1 fail\) < min_tests 2; exit 1; last output:/);
    assert.deepEqual(obs.failed, names);
  }, false, 2);
});

test('FG2: repeat union groups errors from every failed run and keeps per-run notes', async () => {
  await measure([tap('early', "'early cause'") + summary(1), tap('late', "'late cause'") + summary(1)], obs => {
    assert.equal(obs.verdict, 'fail');
    assert.deepEqual(obs.failed, ['early', 'late']);
    assert.equal(obs.runs?.length, 2);
    assert.match(obs.note!, /^failed tests: 2 failed, 2 distinct error\(s\): "early cause" ×1 \| "late cause" ×1 — early, late; last output:/);
    assert.match(obs.runs![0]!.note!, /^failed tests: 1 failed, 1 distinct error\(s\): "early cause"/);
    assert.match(obs.runs![1]!.note!, /^failed tests: 1 failed, 1 distinct error\(s\): "late cause"/);
    assert.doesNotMatch(obs.note!, /; failed tests:/);
  }, true);
});

const trunk = 'a'.repeat(40), merge = 'b'.repeat(40);
function history(changed: string[] = ['src/one.ts', 'src/two.ts', 'src/three.ts', 'src/four.ts']) {
  const plan = parsePlan(JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [{ id: 'suite', run: 'true' }], nodes: [{ id: 'a', writes: ['src/'] }, { id: 'fix', brief: 'Repair named failure', writes: ['src/'] }] }));
  const entries: Entry[] = [];
  const add = (draft: Draft) => { const e = { ...draft, seq: entries.length, ts: '2026-10-13T00:00:00Z', prev: 'x', hash: 'x' } as Entry; entries.push(e); return e; };
  add({ kind: 'genesis', by: 'owner:pi', trunk: 'main', plan: 'plan', commit: trunk, state: { commit: trunk, tree: 'tree', invKeys: { suite: 'trunk-key' } } });
  add({ kind: 'dispatch', by: 'parent:test', node: 'a', attempt: 1, base: trunk, branch: 'a', worktree: 'a', packet: 'p', rulings_seen: -1 });
  add({ kind: 'submit', by: 'writer:a#1', node: 'a', attempt: 1, facts: { commit: 'c'.repeat(40), base: trunk, tree: 'tree', patch: 'patch', changed, closureTouched: false, keys: { writes: 'writes', rulings: 'rulings' } } });
  const obs = (extra: Partial<ObsEntry> = {}) => add({ kind: 'obs', by: 'executor:owed', subject: 'trunk', obligation: 'inv:suite', key: 'merge-key', verdict: 'fail', exit: 1, durationMs: 1, commit: merge, merging: 'a', ...extra }) as ObsEntry;
  return { entries, obs, state: () => reduce(entries, () => plan) };
}

test('TD1/2/3: latest current-trunk pass and candidate paths appear once before intermittent and fix hints', () => {
  const r = history();
  r.obs({ verdict: 'pass', commit: trunk, merging: undefined });
  r.obs({ commit: 'd'.repeat(40), failed: ['named failure'] });
  const pass = r.obs({ verdict: 'pass', commit: trunk, merging: 'a' });
  r.obs({ verdict: 'pass', commit: 'e'.repeat(40) });
  const fail = r.obs({ failed: ['named failure'] }), state = r.state();
  const before = JSON.stringify(state), ledgerBefore = JSON.stringify(entriesOf(state));
  const lines = mergeFailureHints(state, 'a', [fail, fail]);
  assert.equal(lines[0], `inv:suite: pass on trunk ${trunk.slice(0, 12)} (#${pass.seq}) → fail on merge tree ${merge.slice(0, 12)} (#${fail.seq}); node diff touches src/one.ts, src/two.ts, src/three.ts (+1 more)`);
  assert.equal(lines.filter(l => l.startsWith('inv:suite:')).length, 1);
  assert.match(lines[1]!, /^known intermittent:/);
  assert.match(lines[2]!, /^fix candidate:/);
  assert.equal(JSON.stringify(state), before);
  assert.equal(JSON.stringify(entriesOf(state)), ledgerBefore);
});

test('TD1: omit delta without a current-trunk pass, for checks, other nodes and passing merge observations', () => {
  const r = history();
  r.obs({ verdict: 'pass', commit: 'e'.repeat(40) });
  const failed = r.obs();
  assert.deepEqual(mergeFailureHints(r.state(), 'a', [failed]), []);
  r.obs({ verdict: 'pass', commit: trunk });
  for (const extra of [{ merging: 'other' }, { obligation: 'check:suite' }, { verdict: 'pass' as const }]) {
    assert.deepEqual(mergeFailureHints(r.state(), 'a', [{ ...failed, ...extra }]), []);
  }
});

test('TD1/2: anonymous invariant failures still show delta, with empty diff omitted and old trunk pass retained', () => {
  const r = history([]), pass = r.obs({ verdict: 'pass', commit: trunk });
  for (let i = 0; i < 5001; i++) r.entries.push({ kind: 'note', by: 'parent:test', text: 'padding', seq: r.entries.length, ts: '2026-10-13T00:00:00Z', prev: 'x', hash: 'x' });
  const fail = r.obs();
  assert.deepEqual(mergeFailureHints(r.state(), 'a', [fail]), [`inv:suite: pass on trunk ${trunk.slice(0, 12)} (#${pass.seq}) → fail on merge tree ${merge.slice(0, 12)} (#${fail.seq})`]);
});

test('FG3/TD3: merge refusal, why merge checks and driver halt share grouped errors and trunk delta', async () => {
  const r = await repo();
  try {
    await r.put('impl', 'base');
    await r.put('fail.tap', shared11);
    await r.put('gate.sh', 'if grep -q candidate impl; then sed "s|@CWD@|$PWD|g" fail.tap; exit 1; fi\necho "# tests 11"\necho "# pass 11"\n');
    await r.commit();
    await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'pi' }, channel: 'delegated', plan: JSON.stringify({ version: 1, trunk: 'main', closure: [], lease: false, invariants: [{ id: 'suite', run: 'bash gate.sh', reads: ['impl', 'gate.sh', 'fail.tap'], min_tests: 1 }], nodes: [{ id: 'a', writes: ['impl'] }] }) });
    const slot = await ops.dispatch({ cwd: r.cwd, node: 'a', as: { role: 'parent', id: 'test' } });
    await commitAt(slot.worktree, { impl: 'candidate' });
    await ops.submit({ cwd: slot.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
    assert.equal((await ops.attest({ cwd: r.cwd, node: 'a' })).accepted, true);
    const ledger = await Ledger.open(r.cwd), project = (await ledger.read())[0]!.hash.slice(0, 12), rid = runId(project, 'a', 1, 'writer');
    await ops.launch({ cwd: r.cwd, as: { role: 'parent', id: 'drive' }, node: 'a', attempt: 1, role: 'writer', rid, spec: '{}', labels: runLabels(project, 'a', 1, 'writer') });
    let refusal = '';
    await assert.rejects(ops.merge({ cwd: r.cwd, node: 'a', as: { role: 'parent', id: 'test' } }), error => { refusal = (error as Error).message; return true; });
    const entries = await ledger.read(), genesis = entries[0]!;
    assert.ok(genesis.kind === 'genesis');
    const plan = parsePlan((await ledger.getBlob(genesis.plan)).toString()), state = reduce(entries, () => plan);
    const failed = entries.findLast((e): e is ObsEntry => e.kind === 'obs' && e.verdict === 'fail' && e.merging === 'a')!;
    const delta = mergeFailureHints(state, 'a', [failed])[0]!;
    assert.match(delta, /pass on trunk .* → fail on merge tree .*; node diff touches impl$/);
    const why = renderReceipt(await ops.why({ cwd: r.cwd, node: 'a' }));
    const action = decide(state, plan, new Map([[rid, { rid, state: 'sealed', status: 'ok' }]]), { max: 1, repairs: 2, project, root: r.cwd, applied: new Set(), rejected: new Map(), merges: new Map([['a', { candidate: state.nodes.a!.candidate!.seq, reason: refusal }]]) }).find(a => a.do === 'halt');
    assert.ok(action?.do === 'halt');
    for (const text of [refusal, why, action.reason]) {
      assert.ok(text.includes(delta), text);
      assert.ok(text.includes('11 failed, 1 distinct error(s): "exact-source host required"'), text);
    }
    assert.deepEqual(await ledger.read(), entries, 'why and views do not change the ledger');
  } finally { await r.cleanup(); }
});

test('TD3: why exposes an anonymous merge invariant delta under Merge checks', async () => {
  const r = await repo();
  try {
    await r.put('impl', 'base');
    await r.put('gate.sh', 'echo "# tests 1"\nif grep -q candidate impl; then echo "# fail 1"; exit 1; fi\necho "# pass 1"\n');
    await r.commit();
    await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'pi' }, channel: 'delegated', plan: JSON.stringify({ version: 1, trunk: 'main', closure: [], lease: false, invariants: [{ id: 'suite', run: 'bash gate.sh', reads: ['impl', 'gate.sh'], min_tests: 1 }], nodes: [{ id: 'a', writes: ['impl'] }] }) });
    const slot = await ops.dispatch({ cwd: r.cwd, node: 'a', as: { role: 'parent', id: 'test' } });
    await commitAt(slot.worktree, { impl: 'candidate' });
    await ops.submit({ cwd: slot.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
    await ops.attest({ cwd: r.cwd, node: 'a' });
    await assert.rejects(ops.merge({ cwd: r.cwd, node: 'a', as: { role: 'parent', id: 'test' } }), /pass on trunk/);
    const card = await ops.why({ cwd: r.cwd, node: 'a' });
    assert.ok(card.mergeChecks?.some(i => /pass on trunk .* → fail on merge tree/.test(i.detail)), renderReceipt(card));
  } finally { await r.cleanup(); }
});
