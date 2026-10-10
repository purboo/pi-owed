// D20: the plan's `exec` block (env and wrapper) for every process owed starts in a materialized tree.
// Assertions target observable behavior (parse errors, keys, process argv/env/cwd, reducer effects, views).
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repo } from './helpers/repo.ts';
import { commitAt } from './helpers/surface.ts';
import * as ops from '../src/ops.ts';
import { parsePlan } from '../src/plan.ts';
import { Ledger } from '../src/ledger.ts';
import { runJob } from '../src/exec.ts';
import { git, candidateFacts, stateFacts, readsDigest } from '../src/git.ts';
import { H } from '../src/canon.ts';
import * as views from '../src/views.ts';
import type { AttestJob, CheckSpec, Entry } from '../src/types.ts';

const owner = { role: 'owner', id: 'human' } as const, parent = { role: 'parent', id: 'test' } as const;
const base = { version: 1, trunk: 'main', closure: ['closure/**'], nodes: [{ id: 'n', writes: ['src/'], checks: [{ id: 'unit', run: 'true' }] }] };
const withExec = (exec: unknown) => parsePlan(JSON.stringify({ ...base, exec }));

test('plan: exec block is parsed, empty fields are dropped, bad keys/types/names are errors', () => {
  const plan = withExec({ env: { CARGO_TARGET_DIR: '/abs/shared/target', EMPTY: '' }, wrap: ['/abs/tmp/qa/heavy.sh', '--slots', '5'] });
  assert.deepEqual(plan.exec, { env: { CARGO_TARGET_DIR: '/abs/shared/target', EMPTY: '' }, wrap: ['/abs/tmp/qa/heavy.sh', '--slots', '5'] });
  assert.deepEqual(withExec({ wrap: ['w'] }).exec, { wrap: ['w'] });
  for (const empty of [{}, { env: {} }]) assert.equal('exec' in withExec(empty), false, `${JSON.stringify(empty)} is the same as no exec block`);
  assert.equal('exec' in parsePlan(JSON.stringify(base)), false);
  for (const [exec, message] of [
    [[], /exec: expected object/],
    ['x', /exec: expected object/],
    [null, /exec: expected object/],
    [{ slots: 3 }, /exec\.slots: unknown key/],
    [{ env: [] }, /exec\.env: expected object/],
    [{ env: { '1BAD': 'x' } }, /exec\.env\.1BAD: invalid variable name/],
    [{ env: { 'A-B': 'x' } }, /invalid variable name/],
    [{ env: { CI: '0' } }, /exec\.env\.CI: reserved/],
    [{ env: { OWED: '0' } }, /exec\.env\.OWED: reserved/],
    [{ env: { N: 1 } }, /exec\.env\.N: expected string/],
    [{ wrap: [] }, /exec\.wrap: expected non-empty array/],
    [{ wrap: 'heavy.sh' }, /exec\.wrap: expected non-empty array/],
    [{ wrap: ['ok', 3] }, /exec\.wrap: expected non-empty strings/],
    [{ wrap: [''] }, /exec\.wrap: expected non-empty strings/],
  ] as const) assert.throws(() => withExec(exec), message, JSON.stringify(exec));
});

test('keys: without exec (or exec: {}) byte-identical to 0.4.1; env and wrap change every check/red/strength/inv key', { timeout: 60_000 }, async () => {
  const r = await repo();
  try {
    await r.put('closure/m.patch', '--- a/src/v\n+++ b/src/v\n@@ -1 +1 @@\n-1\n+2\n'); await r.put('src/v', '1\n');
    const b = await r.commit();
    await r.put('src/v', '3\n'); const c = await r.commit();
    const spec = { id: 'unit', run: 'true', reads: ['src/**'], min_tests: 1, red: true, tests: ['src/**'], mutants: ['closure/*.patch'] };
    const text = (exec?: unknown) => JSON.stringify({ ...base, setup: 'true', ...(exec === undefined ? {} : { exec }), invariants: [{ id: 'inv', run: 'true' }], nodes: [{ ...base.nodes[0], checks: [spec] }] });
    const keys = async (exec?: unknown) => {
      const p = parsePlan(text(exec)), f = await candidateFacts(r.cwd, p, p.nodes[0]!, b, c, 1), s = await stateFacts(r.cwd, p, c);
      return { check: f.keys['check:unit']!, red: f.keys['red:unit']!, strength: f.keys['strength:unit']!, inv: s.invKeys.inv!, writes: f.keys.writes!, review: f.keys.review! };
    };
    const none = await keys();
    // The 0.4.1 formulas (SPEC §4), recomputed here: no `exec` field at all.
    const closure = await readsDigest(r.cwd, b, ['closure/**']), reads = await readsDigest(r.cwd, c, ['src/**']);
    const tree = (await git(r.cwd, ['rev-parse', `${b}^{tree}`])).stdout.trim();
    assert.equal(none.check, H({ o: 'check', id: 'unit', run: 'true', timeout_s: 600, setup: 'true', min_tests: 1, closure, reads }));
    assert.equal(none.red, H({ o: 'red', id: 'unit', run: 'true', red_expect: undefined, timeout_s: 600, setup: 'true', min_tests: 1, closure, base: tree, tests: reads }));
    assert.equal(none.strength, H({ o: 'strength', id: 'unit', run: 'true', timeout_s: 600, setup: 'true', min_tests: 1, min_kill: 1, closure, mutants: await readsDigest(r.cwd, b, ['closure/**']), reads }));
    assert.equal(none.inv, H({ o: 'inv', id: 'inv', run: 'true', timeout_s: 600, setup: 'true', min_tests: undefined, closure: await readsDigest(r.cwd, c, ['closure/**']), reads: await readsDigest(r.cwd, c, ['**']) }));
    assert.deepEqual(await keys({}), none, 'exec: {} equals no exec');
    assert.deepEqual(await keys({ env: {} }), none, 'exec: {env: {}} equals no exec');
    const env = await keys({ env: { CARGO_TARGET_DIR: '/a' } }), env2 = await keys({ env: { CARGO_TARGET_DIR: '/b' } }), wrap = await keys({ wrap: ['/w.sh'] }), both = await keys({ env: { CARGO_TARGET_DIR: '/a' }, wrap: ['/w.sh'] });
    for (const k of ['check', 'red', 'strength', 'inv'] as const) {
      const all = [none[k], env[k], env2[k], wrap[k], both[k]];
      assert.equal(new Set(all).size, all.length, `${k}: every exec variant gives a distinct key`);
    }
    for (const k of ['writes', 'review'] as const) assert.equal(both[k], none[k], `${k} does not depend on exec`);
  } finally { await r.cleanup(); }
});

/** A wrapper that logs its tag, cwd, pid and trailing argv to $WRAP_LOG, then runs the argv and exits with its code. */
async function wrapper(dir: string): Promise<string> {
  const path = join(dir, 'wrap.sh');
  await writeFile(path, '#!/bin/bash\ntag="$1"; shift\n{ printf \'call tag=%s pwd=%s pid=%s argc=%s\\n\' "$tag" "$PWD" "$$" "$#"; printf \'arg=%s\\n\' "$@"; } >> "$WRAP_LOG"\n"$@"\n');
  await chmod(path, 0o755); return path;
}
const alive = async (pid: number): Promise<boolean> => {
  try { return (await readFile(`/proc/${pid}/stat`, 'utf8')).split(' ')[2] !== 'Z'; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
};

test('executor: setup, check, red, inv and strength run as [...wrap, bash, -lc, cmd] with exec.env, CI=1, OWED=1; exit codes pass through', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    const wrap = await wrapper(r.root), log = join(r.root, 'wrap.log');
    await r.put('mode', 'ok\n'); await r.put('closure/m.patch', '--- a/mode\n+++ b/mode\n@@ -1 +1 @@\n-ok\n+bad\n');
    const b = await r.commit();
    await r.put('src/x', 'cand'); const c = await r.commit();
    const prior = process.env.OWED_EXEC_TEST_INHERITED; process.env.OWED_EXEC_TEST_INHERITED = 'kept';
    try {
      const plan = parsePlan(JSON.stringify({ ...base, setup: 'echo setup-ran > setup-marker', exec: { env: { WRAP_LOG: log, SHARED_CACHE: '/shared/cache dir' }, wrap: [wrap, 'tagged'] } }));
      const ledger = await Ledger.open(r.cwd), ctx = { cwd: r.cwd, plan, ledger };
      const run = `test -f setup-marker || exit 9; echo "env=$SHARED_CACHE|$CI|$OWED|$OWED_EXEC_TEST_INHERITED"; echo '# tests 1'; if test "$(cat mode)" = ok; then echo '# pass 1'; else echo '# fail 1'; exit 1; fi`;
      const spec: CheckSpec = { id: 'unit', run, timeout_s: 60, reads: ['**'], tests: ['src/**'], mutants: ['closure/*.patch'] };
      const job: AttestJob = { kind: 'check', subject: 'n', obligation: 'check:unit', key: 'k', spec, commit: c, base: b };
      const calls = async () => (await readFile(log, 'utf8')).split('\n').filter(l => l.startsWith('call '));
      const check = await runJob(ctx, job);
      assert.equal(check.verdict, 'pass', check.note);
      assert.match((await ledger.getBlob(check.log!)).toString(), /env=\/shared\/cache dir\|1\|1\|kept/);
      const text = await readFile(log, 'utf8');
      assert.equal((await calls()).length, 2, 'setup and check both run through the wrapper');
      assert.ok((await calls()).every(l => l.includes('tag=tagged') && l.endsWith('argc=3')), text);
      assert.ok(!text.includes(`pwd=${r.cwd} `), 'the wrapper runs in the materialized tree, not the main worktree');
      assert.ok(text.includes('arg=bash\narg=-lc\narg=echo setup-ran > setup-marker\n'), text);
      assert.ok(text.includes(`arg=bash\narg=-lc\narg=${run}\n`), text);
      // Exit codes pass through the wrapper.
      const failed = await runJob(ctx, { ...job, spec: { ...spec, run: "echo '# tests 1'; exit 3" } });
      assert.equal(failed.verdict, 'fail'); assert.equal(failed.exit, 3);
      // Red run: the wrapper's exit code is subject to the 126/127 rule; an ordinary failure is a red pass.
      const red = await runJob(ctx, { ...job, kind: 'red', obligation: 'red:unit', spec: { ...spec, run: "echo '# tests 1'; echo '# fail 1'; exit 1" } });
      assert.equal(red.verdict, 'pass', red.note);
      for (const code of [126, 127]) {
        const obs = await runJob(ctx, { ...job, kind: 'red', obligation: 'red:unit', spec: { ...spec, run: `echo 'not ok'; exit ${code}` } });
        assert.equal(obs.verdict, 'error'); assert.match(obs.note ?? '', /could not run/);
      }
      const inv = await runJob(ctx, { ...job, kind: 'inv', subject: 'trunk', obligation: 'inv:unit' });
      assert.equal(inv.verdict, 'pass', inv.note);
      const before = (await calls()).length;
      const strength = await runJob(ctx, { ...job, kind: 'strength', obligation: 'strength:unit' });
      assert.equal(strength.verdict, 'pass', strength.note);
      assert.equal((await calls()).length - before, 2, 'the strength run (setup + check on the mutant) runs through the wrapper');
      // A missing wrapper is an execution error, never a pass.
      const missing = await runJob({ ...ctx, plan: { ...plan, exec: { wrap: [join(r.root, 'no-such-wrapper')] } } }, job);
      assert.equal(missing.verdict, 'error');
      // CI and OWED win over everything; exec.env wins over the inherited environment.
      const over = await runJob({ ...ctx, plan: { ...plan, setup: undefined, exec: { env: { OWED_EXEC_TEST_INHERITED: 'plan' } } } }, { ...job, spec: { ...spec, run: `echo "v=$OWED_EXEC_TEST_INHERITED|$CI|$OWED"; echo '# tests 1'` } });
      assert.match((await ledger.getBlob(over.log!)).toString(), /v=plan\|1\|1/);
    } finally { if (prior === undefined) delete process.env.OWED_EXEC_TEST_INHERITED; else process.env.OWED_EXEC_TEST_INHERITED = prior; }
  } finally { await r.cleanup(); }
});

test('executor: a wrapper that cannot run the command exits 127 and makes the red run an error, not a pass (review #387)', { timeout: 60_000 }, async () => {
  const r = await repo();
  try {
    const marker = join(r.root, 'command-ran');
    const failing = join(r.root, 'transport.sh');
    // A transport failure: the wrapper never runs the trailing argv and exits 127 (the documented contract).
    await writeFile(failing, '#!/bin/bash\necho "ssh: connect to host ipc: Connection refused" >&2\nexit 127\n'); await chmod(failing, 0o755);
    const b = await r.commit(); await r.put('test/t', 'x'); const c = await r.commit();
    const ledger = await Ledger.open(r.cwd);
    const spec: CheckSpec = { id: 'unit', run: `touch '${marker}'; echo '# tests 1'; echo '# fail 1'; exit 1`, timeout_s: 60, reads: ['**'], tests: ['test/**'] };
    const job: AttestJob = { kind: 'red', subject: 'n', obligation: 'red:unit', key: 'k', spec, commit: c, base: b };
    const plan = parsePlan(JSON.stringify({ version: 1, trunk: 'main', exec: { wrap: [failing] } }));
    const red = await runJob({ cwd: r.cwd, plan, ledger }, job);
    assert.equal(red.verdict, 'error', red.note); assert.equal(red.exit, 127); assert.match(red.note ?? '', /could not run \(exit 127/);
    await assert.rejects(readFile(marker), 'the command never ran');
    // The same red run without the wrapper is a red pass (the command fails as a test).
    const direct = await runJob({ cwd: r.cwd, plan: parsePlan(JSON.stringify({ version: 1, trunk: 'main' })), ledger }, job);
    assert.equal(direct.verdict, 'pass', direct.note);
  } finally { await r.cleanup(); }
});

test('executor: timeout kills the wrapper and the command with their process group', { timeout: 60_000 }, async () => {
  const r = await repo();
  try {
    const wrap = await wrapper(r.root), log = join(r.root, 'wrap.log'), pidFile = join(r.root, 'child.pid');
    const b = await r.commit(), ledger = await Ledger.open(r.cwd);
    const plan = parsePlan(JSON.stringify({ version: 1, trunk: 'main', exec: { env: { WRAP_LOG: log }, wrap: [wrap, 't'] } }));
    const job: AttestJob = { kind: 'check', subject: 'a', obligation: 'check:x', key: 'x', base: b, commit: b, spec: { id: 'x', run: `sleep 30 & echo $! > '${pidFile}'; wait`, timeout_s: 1, reads: ['**'] } };
    const result = await runJob({ cwd: r.cwd, plan, ledger }, job);
    assert.equal(result.verdict, 'error'); assert.match(result.note!, /timeout/);
    const wrapped = await readFile(log, 'utf8').catch(() => '');
    assert.match(wrapped, /pid=\d+/, 'the check ran through the wrapper');
    const wrapperPid = Number(/pid=(\d+)/.exec(wrapped)![1]), childPid = Number(await readFile(pidFile, 'utf8'));
    assert.equal(await alive(wrapperPid), false, 'wrapper killed');
    assert.equal(await alive(childPid), false, 'command killed');
  } finally { await r.cleanup(); }
});

test('operations: exec: {} is no change; an exec change needs the owner, is in ΔO⁻, invalidates the candidate, and attribution uses the old exec; why shows the header', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    await commitAt(r.cwd, { 'check.sh': `echo '# tests 1'; if test "$MODE" = new; then echo '# pass 1'; else echo '# fail 1'; exit 1; fi\n` });
    const planFor = (exec?: unknown) => JSON.stringify({ version: 1, trunk: 'main', closure: [], ...(exec === undefined ? {} : { exec }), nodes: [{ id: 's', writes: ['src/'], checks: [{ id: 'unit', run: 'bash check.sh', reads: ['**'], min_tests: 1 }] }] });
    await ops.init({ cwd: r.cwd, plan: planFor(), as: owner, channel: 'flag' });
    const d = await ops.dispatch({ cwd: r.cwd, node: 's', as: parent });
    await commitAt(d.worktree, { 'src/x': 'x\n' });
    const writer = { cwd: d.worktree, node: 's', as: { role: 'writer', id: 's#1' } as const };
    const first = await ops.submit(writer);
    assert.ok(first.kind === 'submit');
    // exec: {} by the parent: same plan, no downgrade, the candidate stays.
    const same = await ops.planSet({ cwd: r.cwd, plan: planFor({}), as: parent });
    assert.ok(same.kind === 'plan' && same.plan === same.prior && same.downgrades.length === 0);
    let card = await ops.why({ cwd: r.cwd, node: 's' });
    assert.equal(card.phase, 'submitted'); assert.deepEqual(card.downgrades, []); assert.equal(card.exec, undefined);
    assert.doesNotMatch(views.renderReceipt(card), /Exec:/);
    const a1 = await ops.attest({ cwd: r.cwd, node: 's' });
    assert.equal(a1.accepted, false);
    assert.ok(a1.receipt.blocks.some(b => b.obligation === 'check:unit' && b.kind === 'exec'));
    // An exec change can weaken every check (wrap ["true"]): owner only.
    const next = planFor({ env: { MODE: 'new', CARGO_TARGET_DIR: '/shared' }, wrap: ['env'] });
    await assert.rejects(ops.planSet({ cwd: r.cwd, plan: next, as: parent }), /owner/);
    await ops.planSet({ cwd: r.cwd, plan: next, as: owner, channel: 'flag' });
    card = await ops.why({ cwd: r.cwd, node: 's' });
    assert.equal(card.phase, 'dispatched', 'the exec change invalidates the submitted candidate');
    assert.ok(card.downgrades.some(g => g.items.some(i => i.node === '*' && i.what === 'exec changed; cannot prove obligations were not reduced')), JSON.stringify(card.downgrades));
    assert.equal(card.exec, 'Exec: wrap env · env CARGO_TARGET_DIR, MODE');
    assert.equal(views.renderReceipt(card).split('\n')[1], 'Exec: wrap env · env CARGO_TARGET_DIR, MODE');
    const second = await ops.submit(writer);
    assert.ok(second.kind === 'submit' && second.facts.commit === first.facts.commit);
    assert.notEqual(second.facts.keys['check:unit'], first.facts.keys['check:unit'], 'the new exec changes the key');
    const a2 = await ops.attest({ cwd: r.cwd, node: 's' });
    const unit = a2.observations.filter((e): e is Extract<Entry, { kind: 'obs' }> => e.kind === 'obs' && e.obligation === 'check:unit');
    // Attribution reruns the old key with the old (empty) exec: it fails again (deterministic), so the block clears;
    // with the new exec it would pass and the block would count as flaky.
    assert.ok(unit.some(e => e.attribution && e.key === first.facts.keys['check:unit'] && e.verdict === 'fail'), JSON.stringify(unit));
    assert.ok(unit.some(e => !e.attribution && e.key === second.facts.keys['check:unit'] && e.verdict === 'pass'), JSON.stringify(unit));
    assert.equal(a2.accepted, true, JSON.stringify(a2.receipt.items.map(i => [i.obligation, i.detail])));
  } finally { await r.cleanup(); }
});

test('views: execText quotes argv words with blanks and lists env names only', () => {
  const plan = withExec({ env: { SECRET_TOKEN: 'do-not-show', A: 'x' }, wrap: ['/abs/heavy script.sh', '--', 'pi-durable-subagents'] });
  const line = views.execText(plan);
  assert.equal(line, 'Exec: wrap "/abs/heavy script.sh" -- pi-durable-subagents · env A, SECRET_TOKEN');
  assert.doesNotMatch(line, /do-not-show/);
  assert.equal(views.execText(withExec({ env: { A: '1' } })), 'Exec: env A');
  assert.equal(views.execText(withExec({ wrap: ['w'] })), 'Exec: wrap w');
});
