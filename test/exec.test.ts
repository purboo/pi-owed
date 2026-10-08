import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repo } from './helpers/repo.ts';
import { parsePlan } from '../src/plan.ts';
import { Ledger } from '../src/ledger.ts';
import { runJob, parseCounts } from '../src/exec.ts';
import { git } from '../src/git.ts';
import type { AttestJob } from '../src/types.ts';
test('counts for supported runners and zero', () => {
  for (const [log, count] of [['# tests 2\n# pass 1\n# fail 1', 2], ['=== 2 passed, 1 skipped in 0.2s ===', 3], ['test result: ok. 3 passed; 0 failed; 1 ignored;', 4], ['Tests: 2 passed, 2 total', 2], [' Tests  2 passed (2)', 2], ['no tests ran in 0.0s', 0], ['# tests 0\n# pass 0', 0], ['TAP version 13\n1..0 # SKIP nothing', 0]] as const) assert.equal(parseCounts(log)?.tests, count, log);
  assert.equal(parseCounts('arbitrary output'), undefined);
});
test('executor pins closure, tests red counterfactual, counts, writes and cleanup', async () => {
  const r = await repo();
  try {
    await r.put('src/value', 'old'); await r.put('helper', 'trusted');
    const base = await r.commit();
    await r.put('src/value', 'new'); await r.put('helper', 'hacked'); await r.put('extra-helper', 'hacked');
    await r.put('test/run.sh', `test "$(cat helper)" = trusted || exit 7\ntest ! -e extra-helper || exit 8\necho '# tests 1'\nif test "$(cat src/value)" = new; then echo '# pass 1'; else echo 'not ok counterfactual'; echo '# fail 1'; exit 1; fi\n`);
    const cand = await r.commit();
    // Uncommitted source pollution must not enter materialization.
    await r.put('src/value', 'dirty');
    const plan = parsePlan(`version: 1\ntrunk: main\nclosure: [helper, 'extra*']\nnodes:\n - id: a\n   writes: [src/, test/]\n   checks: [{id: unit, run: 'bash test/run.sh', min_tests: 1, red: true, tests: ['test/**'], red_expect: 'not ok'}]`);
    const ledger = await Ledger.open(r.cwd), ctx = { cwd: r.cwd, plan, ledger };
    const job: AttestJob = { kind: 'check', subject: 'a', obligation: 'check:unit', key: 'key', spec: plan.nodes[0]!.checks[0], commit: cand, base };
    const before = (await git(r.cwd, ['worktree', 'list', '--porcelain'])).stdout;
    const green = await runJob(ctx, job); assert.equal(green.verdict, 'pass'); assert.equal(green.counts?.tests, 1); assert.match((await ledger.getBlob(green.log!)).toString(), /# pass 1/);
    const red = await runJob(ctx, { ...job, kind: 'red' }); assert.equal(red.verdict, 'pass'); assert.equal(red.exit, 1);
    assert.equal((await runJob(ctx, { ...job, kind: 'red', spec: { ...job.spec!, red_expect: 'WRONG' } })).verdict, 'fail');
    assert.equal((await runJob(ctx, { ...job, kind: 'writes' })).verdict, 'fail');
    plan.nodes[0]!.writes.push('helper', 'extra-helper'); assert.equal((await runJob(ctx, { ...job, kind: 'writes' })).verdict, 'pass');
    for (const [run, min_tests, verdict] of [["echo '# tests 0'", undefined, 'fail'], ["echo '# tests 1'", 2, 'fail'], ['echo unknown', 1, 'error'], ['exit 1', undefined, 'fail']] as const) {
      const obs = await runJob(ctx, { ...job, spec: { ...job.spec!, run, min_tests } }); assert.equal(obs.verdict, verdict, obs.note);
    }
    assert.equal((await runJob(ctx, { ...job, kind: 'red', spec: { ...job.spec!, run: "echo '# tests 0'; echo 'not ok'; exit 1" } })).verdict, 'fail');
    assert.equal((await runJob(ctx, { ...job, kind: 'inv', spec: { ...job.spec!, run: "test \"$(cat helper)\" = hacked; result=$?; echo '# tests 1'; exit $result" } })).verdict, 'pass');
    assert.equal((await runJob({ ...ctx, plan: { ...plan, setup: "printf ready > setup-marker" } }, { ...job, spec: { ...job.spec!, run: "test -f setup-marker && bash test/run.sh" } })).verdict, 'pass');
    assert.equal((await runJob({ ...ctx, plan: { ...plan, setup: 'exit 9' } }, job)).verdict, 'error');
    assert.equal((await runJob(ctx, { ...job, commit: 'not-a-commit' })).verdict, 'error');
    const huge = await runJob(ctx, { ...job, spec: { ...job.spec!, min_tests: undefined, run: "node -e 'process.stdout.write(\"x\".repeat(1100000))'" } });
    const blob = await ledger.getBlob(huge.log!); assert.match(blob.toString().slice(0, 100), /truncated/); assert.ok(blob.length <= 1024 * 1024 + 100);
    assert.equal((await git(r.cwd, ['worktree', 'list', '--porcelain'])).stdout, before);
    assert.equal(await readFile(join(r.cwd, 'src/value'), 'utf8'), 'dirty');
  } finally { await r.cleanup(); }
});
test('timeout kills group and abort cleans worktree', async () => {
  const r = await repo();
  try {
    const base = await r.commit(); const ledger = await Ledger.open(r.cwd);
    const plan = parsePlan('version: 1\ntrunk: main\n');
    const pidFile = join(r.root, 'pid');
    const job: AttestJob = { kind: 'check', subject: 'a', obligation: 'check:x', key: 'x', base, commit: base, spec: { id: 'x', run: `sleep 30 & echo $! > '${pidFile}'; wait`, timeout_s: 1, reads: ['**'] } };
    const before = (await git(r.cwd, ['worktree', 'list', '--porcelain'])).stdout;
    const result = await runJob({ cwd: r.cwd, plan, ledger }, job); assert.equal(result.verdict, 'error'); assert.match(result.note!, /timeout/); assert.ok(result.durationMs < 5000);
    const pid = Number(await readFile(pidFile, 'utf8'));
    // A killed orphan can briefly remain a zombie under the host's init.
    try { const stat = await readFile(`/proc/${pid}/stat`, 'utf8'); assert.equal(stat.split(' ')[2], 'Z'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const controller = new AbortController(); controller.abort();
    assert.equal((await runJob({ cwd: r.cwd, plan, ledger, signal: controller.signal }, job)).verdict, 'error');
    assert.equal((await git(r.cwd, ['worktree', 'list', '--porcelain'])).stdout, before);
  } finally { await r.cleanup(); }
});
