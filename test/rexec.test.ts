import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repo } from './helpers/repo.ts';
import { commitAt, cli } from './helpers/surface.ts';
import { parsePlan } from '../src/plan.ts';
import { lintPlanShell } from '../src/planlint.ts';
import { runCommand, runJob } from '../src/exec.ts';
import { shellQuote } from '../src/exec-wrap.ts';
import { candidateFacts, stateFacts, execKey, git } from '../src/git.ts';
import { canonical, sha256 } from '../src/canon.ts';
import { Ledger } from '../src/ledger.ts';
import { Driver } from '../src/drive-run.ts';
import { Dsa } from '../src/dsa.ts';
import * as ops from '../src/ops.ts';
import type { AttestJob } from '../src/types.ts';
import { withMachineLease } from '../src/lease.ts';
import { sweepDefinitionKey } from '../src/sweep.ts';

class Client extends Dsa {
  constructor() { super({ bin: '/bin/true' }); }
  override async inspect(rid: string) { return { view: { rid, state: 'sealed' as const, status: 'ok' } }; }
}
const owner = { role: 'owner', id: 'pi' } as const;
const parent = { role: 'parent', id: 'test' } as const;
const raw = (exec?: unknown) => ({ version: 1, trunk: 'main', closure: [], lease: false, invariants: [], nodes: [{ id: 'a', writes: ['src/'], checks: [{ id: 'unit', run: "printf '# tests 1\\n# pass 1\\n'", reads: ['src/'] }], review: { count: 0, min_rank: 1 } }], ...(exec ? { exec } : {}) });
const plan = (exec?: unknown) => parsePlan(JSON.stringify(raw(exec)));
async function wrapper(root: string) {
  const script = join(root, "wrapper space ' $name.sh"), record = join(root, 'argv');
  await writeFile(script, `#!/bin/bash\nprintf '%s\\0' "$@" "$OWED_LEASED" "$OWED" "$OWED_TREE" >> ${shellQuote(record)}\ncd "$1" || exit 126\nexec bash -lc "$3"\n`);
  return { record, wrap: `bash ${shellQuote(script)} {cwd} {timeout} {cmd}` };
}

test('RX1: template admission, messages and shell lint cover init/plan/edit/amend atomically', async () => {
  const r = await repo();
  try {
    await r.commit();
    for (const [wrap, message] of [['echo {cwd}', /\{cmd\} is required/], ['echo {cmd} {host}', /unknown placeholder \{host\}/], ['', /\{cmd\} is required/]] as const) assert.throws(() => plan({ wrap }), message);
    for (const value of [-1, 1.5, '30', null]) assert.throws(() => plan({ wrap: 'bash -lc {cmd}', wrap_grace_s: value }), /exec.wrap_grace_s/);
    assert.doesNotThrow(() => plan({ wrap: 'bash -lc {cmd}', wrap_grace_s: 0 }));
    assert.doesNotThrow(() => lintPlanShell(plan({ wrap: '{ bash -lc {cmd}; }' })), 'ordinary shell braces are not placeholders');
    assert.throws(() => lintPlanShell(plan({ wrap: "bash -c 'if true; then' ignored {cmd}" })), /exec.wrap: bash -n/);
    assert.doesNotThrow(() => plan({ wrap: ['/usr/bin/env'] }), 'legacy argv wrappers still load');
    const invalid = raw({ wrap: 'if true; then {cmd}' });
    assert.throws(() => lintPlanShell(parsePlan(JSON.stringify(invalid))), /plan\/exec.wrap: bash -n:/);
    await assert.rejects(ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify(invalid), measure: false }), /exec.wrap: bash -n/);
    assert.deepEqual(await (await Ledger.open(r.cwd)).read(), []);
    await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify(raw()), measure: false });
    const file = join(r.root, 'plan.json'); await writeFile(file, JSON.stringify(raw()));
    await ops.planSet({ cwd: r.cwd, as: owner, channel: 'delegated', ...await ops.readPlan({ cwd: r.cwd, path: file }) });
    const before = await (await Ledger.open(r.cwd)).read();
    await assert.rejects(ops.planSet({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'bad wrapper', plan: JSON.stringify(invalid) }), /exec.wrap: bash -n/);
    await writeFile(file, JSON.stringify(raw({ wrap: 'echo {unknown} {cmd}' })));
    const edit = await cli(r.cwd, ['edit', 'a', '--set', 'title=Changed', '--as', 'owner:pi', '--note', 'bad wrapper']);
    assert.notEqual(edit.code, 0); assert.match(edit.stderr, /unknown placeholder/);
    // amend must not admit an externally modified invalid wrapper or record partial work.
    await writeFile(file, JSON.stringify(raw({ wrap: 'echo {unknown} {cmd}' })));
    const amend = await cli(r.cwd, ['amend', 'a', '--writes', '+src/new', '--note', 'bad source']);
    assert.notEqual(amend.code, 0); assert.match(amend.stderr, /unknown placeholder/);
    assert.deepEqual(await (await Ledger.open(r.cwd)).read(), before);
  } finally { await r.cleanup(); }
});

test('RX1/RX4: exact argv quoting, original cwd, env, exit status and local git', async () => {
  const r = await repo();
  try {
    const w = await wrapper(r.root), cwd = join(r.root, "cwd space ' $HOME"); await mkdir(cwd);
    const cmd = `printf '%s\\n' 'literal $HOME' "single'quote"; exit 7`;
    const p = plan({ wrap: w.wrap, env: { FIXTURE: 'yes' } });
    class LeaseClient extends Dsa {
      constructor() { super({ bin: '/bin/true' }); }
      override async holdWhile<T>(_name: string, work: (signal: AbortSignal) => Promise<T>) {
        return { outcome: 'ran' as const, value: await work(new AbortController().signal) };
      }
    }
    const result = await withMachineLease({ cwd, dsa: new LeaseClient() }, () => runCommand({ plan: p }, cmd, cwd, 9));
    assert.equal(result.code, 7); assert.equal(result.error, undefined); assert.equal(result.log, "literal $HOME\nsingle'quote\n");
    const argv = (await readFile(w.record)).toString().split('\0');
    assert.deepEqual(argv.slice(0, 3), [cwd, '9', cmd]); assert.equal(argv[3], '1'); assert.equal(argv[4], '1'); assert.equal(argv[5], cwd);
    await git(r.cwd, ['status', '--porcelain']);
    assert.deepEqual((await readFile(w.record)).toString().split('\0'), argv, 'git never runs the wrapper');
    assert.equal((await runCommand({ plan: plan({ wrap: w.wrap }) }, 'exit 127', cwd, 9)).code, 127);
  } finally { await r.cleanup(); }
});

test('RX3: no-wrap keys are byte-identical; template changes check/red/strength/invariant/trunk keys', async () => {
  const r = await repo();
  try {
    await r.put('src/value', 'base'); const base = await r.commit();
    await r.put('src/value', 'candidate'); const cand = await r.commit();
    const p = plan(); Object.assign(p.nodes[0]!.checks[0]!, { red: true, tests: ['src/'], mutants: ['patches/'] });
    p.invariants.push({ id: 'all', run: 'true', timeout_s: 30, reads: ['src/'] });
    const facts = await candidateFacts(r.cwd, p, p.nodes[0]!, base, cand, 1);
    const closure = sha256(canonical([]));
    // Reconstruct the 0.21 check key formula, not just two calls to the new implementation.
    const { readsDigest, trunkCheckKey } = await import('../src/git.ts');
    const c = p.nodes[0]!.checks[0]!;
    const expected = sha256(canonical({ o: 'check', id: c.id, run: c.run, timeout_s: c.timeout_s, setup: p.setup, min_tests: c.min_tests, closure, reads: await readsDigest(r.cwd, cand, c.reads) }));
    assert.equal(facts.keys['check:unit'], expected); assert.equal(execKey(p), undefined);
    assert.deepEqual((await candidateFacts(r.cwd, { ...p, exec: { wrap_grace_s: 40 } }, p.nodes[0]!, base, cand, 1)).keys, facts.keys);
    const a = { ...p, exec: { wrap: 'bash -lc {cmd}' } }, b = { ...p, exec: { wrap: 'env bash -lc {cmd}' } };
    const ak = await candidateFacts(r.cwd, a, p.nodes[0]!, base, cand, 1), bk = await candidateFacts(r.cwd, b, p.nodes[0]!, base, cand, 1);
    for (const name of ['check:unit', 'red:unit', 'strength:unit']) { assert.notEqual(ak.keys[name], facts.keys[name]); assert.notEqual(ak.keys[name], bk.keys[name]); }
    assert.notEqual(sweepDefinitionKey(a), sweepDefinitionKey(b));
    assert.equal(ak.keys.writes, facts.keys.writes, 'pure local writes is not a measurement command');
    assert.notEqual((await stateFacts(r.cwd, a, cand)).invKeys.all, (await stateFacts(r.cwd, b, cand)).invKeys.all);
    assert.notEqual(await trunkCheckKey(r.cwd, a, c, base), await trunkCheckKey(r.cwd, b, c, base));
  } finally { await r.cleanup(); }
});

test('RX1: check, red, mutant, invariant and setup all execute the template', async () => {
  const r = await repo();
  try {
    const w = await wrapper(r.root);
    await r.put('src/value', 'old\n');
    await r.put('patches/broken.patch', 'diff --git a/src/value b/src/value\n--- a/src/value\n+++ b/src/value\n@@ -1 +1 @@\n-new\n+broken\n');
    const base = await r.commit();
    await r.put('src/value', 'new\n');
    await r.put('test/check.sh', `test -f setup-marker || exit 126\necho '# tests 1'\nif grep -qx new src/value; then echo '# pass 1'; else echo '# fail 1'; echo 'not ok 1 - value'; exit 1; fi\n`);
    const cand = await r.commit(), p = plan({ wrap: w.wrap }), ledger = await Ledger.open(r.cwd);
    p.closure = ['patches/']; p.setup = 'touch setup-marker';
    Object.assign(p.nodes[0]!.checks[0]!, { run: 'bash test/check.sh', tests: ['test/'], red: true, red_expect: 'value', mutants: ['patches/'], min_tests: 1 });
    const job: AttestJob = { kind: 'check', subject: 'a', obligation: 'check:unit', key: 'key', base, commit: cand, spec: p.nodes[0]!.checks[0] };
    for (const kind of ['check', 'red', 'strength', 'inv'] as const) {
      const obs = await runJob({ cwd: r.cwd, plan: p, ledger }, { ...job, kind });
      assert.equal(obs.verdict, 'pass', `${kind}: ${obs.note}`);
    }
    const args = (await readFile(w.record, 'utf8')).split('\0').filter((_, i) => i % 6 === 2);
    assert.equal(args.filter(cmd => cmd === 'touch setup-marker').length, 4);
    assert.equal(args.filter(cmd => cmd === 'bash test/check.sh').length, 4);
  } finally { await r.cleanup(); }
});

async function dead(pid: number) {
  try { assert.equal((await readFile(`/proc/${pid}/stat`, 'utf8')).split(' ')[2], 'Z'); }
  catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
}
test('RX2: wrapper deadline, local process-tree kill, abort and frozen timeout diagnostics', { timeout: 20_000 }, async () => {
  const r = await repo();
  try {
    const w = await wrapper(r.root), p = plan({ wrap: w.wrap, wrap_grace_s: 1 });
    const pidFile = join(r.root, 'pid'), late = join(r.root, 'late');
    const run = `sleep 30 & echo $! > ${shellQuote(pidFile)}; printf 'before boundary\\n'; sleep 1.3; echo late-output; touch ${shellQuote(late)}; wait`;
    const start = Date.now(), result = await runCommand({ plan: p }, run, r.cwd, 1, undefined, "printf 'not ok 1 - diagnostic-only\\n# tests 99\\n# fail 99\\n'");
    assert.equal(result.code, null); assert.equal(result.error, 'timeout after 1s');
    assert.equal(result.measurementLog, 'before boundary\n'); assert.doesNotMatch(result.measurementLog!, /diagnostic|late/);
    assert.match(result.log, /diagnostic-only/); assert.match(result.log, /process tree/);
    assert.ok(Date.now() - start >= 1800); assert.ok(Date.now() - start < 6000);
    await dead(Number(await readFile(pidFile, 'utf8'))); assert.equal(await readFile(late, 'utf8'), '', 'wrapper keeps running during grace');
    const abort = new AbortController(); const pending = runCommand({ plan: p, signal: abort.signal }, `sleep 30 & echo $! > ${shellQuote(pidFile)}; wait`, r.cwd, 10);
    const timer = setTimeout(() => abort.abort(), 250);
    try { assert.equal((await pending).error, 'aborted'); } finally { clearTimeout(timer); }
    await dead(Number(await readFile(pidFile, 'utf8')));
    const commit = await r.commit(), ledger = await Ledger.open(r.cwd);
    p.invariants.push({ id: 'all', run: "echo original; sleep 30", timeout_s: 1, reads: ['**'], on_timeout: "echo match-only-diagnostic", remeasure_on: ['match-only-diagnostic'] });
    const job: AttestJob = { kind: 'inv', subject: 'trunk', obligation: 'inv:all', key: 'key', base: commit, commit, spec: p.invariants[0] };
    const obs = await runJob({ cwd: r.cwd, plan: p, ledger }, job);
    assert.equal(obs.verdict, 'error'); assert.equal(obs.counts, undefined); assert.equal(obs.failed, undefined); assert.equal(obs.remeasure_match, undefined);
    assert.match((await ledger.getBlob(obs.log!)).toString(), /match-only-diagnostic/);
  } finally { await r.cleanup(); }
});

test('RX5: a driver pass attests through the wrapper and keeps ledger/replay local', { timeout: 120_000 }, async () => {
  const r = await repo(); let driver: Driver | undefined;
  try {
    const w = await wrapper(r.root); await r.put('src/value', 'base'); await r.commit();
    await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify(raw({ wrap: w.wrap })), measure: false });
    const slot = await ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' });
    const { writerLaunch } = await import('../src/drive.ts');
    const { projectId } = await import('../src/reducer.ts');
    const state = (await ops.readState({ cwd: r.cwd })).state, launch = writerLaunch(state, 'a', projectId(state));
    await ops.launch({ cwd: r.cwd, as: parent, node: 'a', attempt: 1, role: 'writer', rid: launch.rid, spec: launch.spec, labels: launch.labels, rulings: 0 });
    await commitAt(slot.worktree, { 'src/value': 'new' });
    await ops.submit({ cwd: slot.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
    driver = new Driver({ cwd: r.cwd, dsa: new Client(), log: () => {}, handleSignals: false });
    const pass = await driver.pass(), reports: unknown[] = []; await driver.settle(reports as never[]);
    const { entries } = await ops.readState({ cwd: r.cwd });
    const obs = entries.find(e => e.kind === 'obs' && e.obligation === 'check:unit');
    assert.ok(obs && obs.kind === 'obs', JSON.stringify({ pass, reports })); assert.equal(obs.verdict, 'pass');
    assert.ok((await readFile(w.record, 'utf8')).includes(raw().nodes[0]!.checks[0]!.run));
    assert.equal((await ops.verify({ cwd: r.cwd })).ok, true);
  } finally { driver?.abort.abort(); await driver?.settle(); await r.cleanup(); }
});
