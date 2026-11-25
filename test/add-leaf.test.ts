import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { parsePlan } from '../src/plan.ts';
import { driveStatus, driveStop } from '../src/drive-bg.ts';
import { repo } from './helpers/repo.ts';
import { identity, seed, commitAt } from './helpers/surface.ts';

const OWED = fileURLToPath(new URL('../bin/owed.js', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures/fake-dsa.mjs', import.meta.url));
const owner = { role: 'owner', id: 'pi' } as const;
const parent = { role: 'parent', id: 'test' } as const;

const PLAN = `# leaf plan header
version: 1
trunk: main
lease: false
closure: [test/helper.cjs]
invariants:
  - id: unit # invariant comment
    run: node --test --test-reporter=tap test/invariant.test.cjs
    min_tests: 1
    reads: [test/invariant.test.cjs, test/state.cjs]
allow:
  - {nodes: ['*'], writes: [docs/]}  # global grant allowance
risk:
  - paths: ['docs/**']
    review: {count: 0, min_rank: 1}
nodes:
  - id: a # existing node comment
    title: Existing A
    brief: Keep A untouched.
    writes: [test/a]
    review: {count: 1, min_rank: 1}
    checks:
      - {id: a, run: 'node --test --test-reporter=tap test/a.test.cjs', min_tests: 1, reads: ['test/a*']}
`;

async function runCli(cwd: string, args: string[], extra: NodeJS.ProcessEnv = {}) {
  const env = { ...process.env, ...identity, OWED_CONFIRM: '', ...extra };
  try {
    const r = await promisify(execFile)(process.execPath, [OWED, ...args], { cwd, env, timeout: 45_000, maxBuffer: 2 * 1024 * 1024 });
    return { code: 0, ...r };
  } catch (e) {
    const x = e as { code: number; stdout: string; stderr: string };
    if (typeof x.code !== 'number') throw e;
    return x;
  }
}

async function setup(text = PLAN) {
  const r = await repo();
  await seed(r.cwd);
  const file = join(r.root, 'plan.yaml');
  await writeFile(file, text);
  await ops.init({ cwd: r.cwd, plan: text, path: file, as: owner, channel: 'delegated', measure: false });
  await ops.planSet({ cwd: r.cwd, as: parent, ...await ops.readPlan({ cwd: r.cwd, path: file }) });
  return { r, file, cwd: r.cwd };
}

const entries = async (cwd: string) => (await Ledger.open(cwd)).read();

test('add-leaf CLI: help, dry-run preview (including under OWED_CONFIRM=owner), YAML/shell quoting and restart/read', { timeout: 90_000 }, async () => {
  const s = await setup();
  try {
    const help = await runCli(s.cwd, ['help', 'add-leaf']);
    assert.equal(help.code, 0, help.stderr);
    assert.match(help.stdout, /add-leaf <id> --writes PATH/);
    assert.match(help.stdout, /--brief/);
    assert.match(help.stdout, /--after/);
    assert.match(help.stdout, /--dry-run/);

    const trickyBrief = '": keep `quotes`, $vars, # hashes, and\nmultiline: [text] intact | literally';
    const trickyCheck = `node -e "const fs=require('node:fs'); if (fs.readFileSync('test/leaf.txt','utf8') !== 'ok: #1\\n') process.exit(1);"`;

    const beforeCount = (await entries(s.cwd)).length;
    const dry = await runCli(
      s.cwd,
      ['add-leaf', 'leaf-1', '--writes', 'test/leaf.txt', '--writes', 'test/extra/', '--check', trickyCheck, '--brief', trickyBrief, '--after', 'a', '--dry-run'],
      { OWED_CONFIRM: 'owner' },
    );
    assert.equal(dry.code, 0, dry.stderr);
    assert.match(dry.stdout, /--- .*plan\.yaml/);
    assert.match(dry.stdout, /Downgrades: \[\]/);
    assert.equal((await entries(s.cwd)).length, beforeCount, 'dry-run must not append ledger entries');
    assert.equal(await readFile(s.file, 'utf8'), PLAN, 'dry-run must not modify plan file');

    const added = await runCli(s.cwd, [
      'add-leaf', 'leaf-1',
      '--writes', 'test/leaf.txt', '--writes', 'test/extra,one/', '--writes', 'test/leaf.txt',
      '--check', trickyCheck,
      '--brief', trickyBrief,
      '--after', 'a',
      '--note', 'Add leaf-1 via CLI',
      '--json',
    ]);
    assert.equal(added.code, 0, added.stderr);
    const json = JSON.parse(added.stdout) as ops.EditResult;
    assert.equal(json.plan.kind, 'plan');
    assert.equal(json.plan.by, 'parent:cli');
    if (json.plan.kind === 'plan') assert.equal(json.plan.note, 'Add leaf-1 via CLI');

    const disk = await readFile(s.file, 'utf8');
    assert.match(disk, /# leaf plan header/);
    assert.match(disk, /# invariant comment/);
    assert.match(disk, /# existing node comment/);
    assert.equal(disk.slice(0, disk.indexOf('  - id: leaf-1')), PLAN);

    const parsed = parsePlan(disk);
    assert.deepEqual(parsed.nodes.map(n => n.id), ['a', 'leaf-1']);
    const leaf = parsed.nodes[1]!;
    assert.deepEqual(leaf.deps, ['a']);
    assert.deepEqual(leaf.writes, ['test/leaf.txt', 'test/extra,one/']);
    assert.equal(leaf.brief, trickyBrief);
    assert.deepEqual(leaf.review, { count: 0, min_rank: 1 });
    assert.equal(leaf.checks.length, 1);
    assert.equal(leaf.checks[0]!.id, 'leaf');
    assert.equal(leaf.checks[0]!.run, trickyCheck);
    assert.equal(leaf.checks[0]!.timeout_s, 600);
    assert.deepEqual(leaf.checks[0]!.reads, ['**']);
    assert.deepEqual(parsed.risk, parsePlan(PLAN).risk);
    assert.deepEqual(parsed.allow, parsePlan(PLAN).allow);

    // Fresh process readbacks after write (status, why, verify)
    const st = await runCli(s.cwd, ['status', '--json']);
    assert.equal(st.code, 0, st.stderr);
    const status = JSON.parse(st.stdout) as { nodes: Record<string, { phase: string }> };
    assert.equal(status.nodes['leaf-1']?.phase, 'blocked');
    assert.equal(status.nodes['a']?.phase, 'ready');

    const why = await runCli(s.cwd, ['why', 'leaf-1']);
    assert.equal(why.code, 0, why.stderr);
    assert.match(why.stdout, /leaf-1/);

    const ver = await runCli(s.cwd, ['verify']);
    assert.equal(ver.code, 0, ver.stderr);
    assert.match(ver.stdout, /Ledger verification passed/);
  } finally {
    await s.r.cleanup();
  }
});

test('add-leaf CLI: rejects duplicates, missing args, unknown deps, invalid writes, dirty file and subagent calls atomically', { timeout: 90_000 }, async () => {
  const s = await setup();
  try {
    const before = (await entries(s.cwd)).length;
    const assertUnchanged = async (expectedText = PLAN) => {
      assert.equal((await entries(s.cwd)).length, before);
      assert.equal(await readFile(s.file, 'utf8'), expectedText);
      assert.deepEqual((await readdir(s.r.root)).filter(x => x.includes('owed-edit')), []);
    };

    // Missing required flags -> usage error (2)
    for (const argv of [
      ['add-leaf'],
      ['add-leaf', 'x', '--check', 'true', '--brief', 'b'],
      ['add-leaf', 'x', '--writes', 'test/x', '--brief', 'b'],
      ['add-leaf', 'x', '--writes', 'test/x', '--check', 'true'],
      ['add-leaf', 'x', '--writes', '', '--check', 'true', '--brief', 'b'],
      ['add-leaf', 'x', '--writes', 'test/x', '--check', 'true', '--brief', 'b', '--after', ''],
      ['add-leaf', 'x', '--writes', 'test/x', '--check', 'true', '--brief', 'b', '--note', '   '],
    ]) {
      const r = await runCli(s.cwd, argv);
      assert.equal(r.code, 2, `${argv.join(' ')}: ${r.stderr}`);
      await assertUnchanged();
    }

    // Duplicate ID -> usage error (2), nothing written
    const dup = await runCli(s.cwd, ['add-leaf', 'a', '--writes', 'test/a2', '--check', 'true', '--brief', 'dup']);
    assert.equal(dup.code, 2, dup.stderr);
    assert.match(dup.stderr, /already exists/);
    await assertUnchanged();

    // Unknown --after dependency -> usage error (2), nothing written
    const badDep = await runCli(s.cwd, ['add-leaf', 'leaf-bad-dep', '--writes', 'test/x', '--check', 'true', '--brief', 'b', '--after', 'missing-node']);
    assert.equal(badDep.code, 2, badDep.stderr);
    assert.match(badDep.stderr, /missing dependency missing-node/);
    await assertUnchanged();

    // Invalid writes syntax -> usage error (2)
    const badWrite = await runCli(s.cwd, ['add-leaf', 'leaf-bad-write', '--writes', '/abs/path', '--check', 'true', '--brief', 'b']);
    assert.equal(badWrite.code, 2, badWrite.stderr);
    assert.match(badWrite.stderr, /invalid writes entry/);
    await assertUnchanged();

    // Subagent refusal (DSA_CALL) -> refused (1), nothing written
    const sub = await runCli(s.cwd, ['add-leaf', 'leaf-sub', '--writes', 'test/x', '--check', 'true', '--brief', 'b'], { DSA_CALL: 'call-123' });
    assert.equal(sub.code, 1, sub.stderr);
    assert.match(sub.stderr, /subagent|pi-durable-subagents/i);
    await assertUnchanged();

    // Unrecorded edits on disk -> refused (1), file untouched
    const dirty = PLAN.replace('Existing A', 'Dirty A');
    await writeFile(s.file, dirty);
    const unrec = await runCli(s.cwd, ['add-leaf', 'leaf-dirty', '--writes', 'test/x', '--check', 'true', '--brief', 'b']);
    assert.equal(unrec.code, 1, unrec.stderr);
    assert.match(unrec.stderr, /unrecorded edits/);
    await assertUnchanged(dirty);
  } finally {
    await s.r.cleanup();
  }
});

test('add-leaf CLI: grant semantics (allow.writes) and normal staying driver pickup/restart', { timeout: 120_000 }, async () => {
  const s = await setup(PLAN.replace('    title: Existing A\n', '    title: Existing A\n    later: true\n'));
  const fakeDir = join(s.r.root, 'dsa');
  const agents = join(fakeDir, 'agents');
  await mkdir(agents, { recursive: true });
  try {
    // 1. Add a ready leaf node (no --after) with check verifying test/leaf.txt and allow grant for docs/
    const added = await runCli(s.cwd, [
      'add-leaf', 'leaf-grant',
      '--writes', 'test/leaf.txt',
      '--check', `node -e "const fs=require('node:fs'); if (fs.readFileSync('test/leaf.txt','utf8').trim() !== 'ok') process.exit(1);"`,
      '--brief', 'Write ok to test/leaf.txt and document it in docs/leaf.md.',
    ]);
    assert.equal(added.code, 0, added.stderr);

    // 2. Dispatch, touch own write + pre-authorized docs/ file (allow grant), attest -> grant recorded & accepted
    const slot = await ops.dispatch({ cwd: s.cwd, node: 'leaf-grant', as: parent });
    assert.match(slot.packet, /Write ok to test\/leaf\.txt and document it in docs\/leaf\.md\./);
    assert.match(slot.packet, /Pre-authorized by the owner \(allowance plan #0\): docs\//);
    await commitAt(slot.worktree, { 'test/leaf.txt': 'ok\n', 'docs/leaf.md': 'documented\n' });
    await ops.submit({ cwd: slot.worktree, node: 'leaf-grant', as: { role: 'writer', id: 'leaf-grant#1' } });
    const att = await ops.attest({ cwd: s.cwd, node: 'leaf-grant' });
    assert.equal(att.accepted, true);
    const es = await entries(s.cwd);
    const grant = es.find(e => e.kind === 'grant' && e.node === 'leaf-grant');
    assert.ok(grant && grant.kind === 'grant');
    assert.deepEqual(grant.paths, ['docs/leaf.md']);
    assert.equal(grant.allowance, 0);
    await ops.merge({ cwd: s.cwd, node: 'leaf-grant', as: parent });
    assert.ok((await ops.readState({ cwd: s.cwd })).state.nodes['leaf-grant']?.merged);

    // 3. Normal staying driver picks up a leaf added via `owed add-leaf` (including after start --restart)
    await writeFile(
      join(agents, 'leaf-auto-writer.sh'),
      `printf 'hello\\n' > test/auto.txt; git add test/auto.txt; git commit -qm auto; "${process.execPath}" "${OWED}" submit leaf-auto`,
    );
    const started = await runCli(s.cwd, ['start', '--plan', s.file, '--max', '1', '--stay'], { OWED_DSA: FAKE, FAKE_DSA_DIR: fakeDir });
    assert.equal(started.code, 0, started.stderr);
    const restarted = await runCli(s.cwd, ['start', '--restart', '--max', '1', '--stay'], { OWED_DSA: FAKE, FAKE_DSA_DIR: fakeDir });
    assert.equal(restarted.code, 0, restarted.stderr);

    // Add leaf-auto after driver restart, with --after leaf-grant (already merged)
    const addAuto = await runCli(s.cwd, [
      'add-leaf', 'leaf-auto',
      '--writes', 'test/auto.txt',
      '--check', `node -e "const fs=require('node:fs'); if (fs.readFileSync('test/auto.txt','utf8') !== 'hello\\n') process.exit(1);"`,
      '--brief', 'Create test/auto.txt with hello.',
      '--after', 'leaf-grant',
    ]);
    assert.equal(addAuto.code, 0, addAuto.stderr);

    const deadline = Date.now() + 45_000;
    let state = (await ops.readState({ cwd: s.cwd })).state;
    while (!state.nodes['leaf-auto']?.merged) {
      if (Date.now() > deadline) assert.fail(`driver did not merge leaf-auto; phase=${state.nodes['leaf-auto']?.phase}, entries=${JSON.stringify(await entries(s.cwd))}`);
      await new Promise(r => setTimeout(r, 100));
      state = (await ops.readState({ cwd: s.cwd })).state;
    }
    assert.equal(await readFile(join(s.cwd, 'test/auto.txt'), 'utf8'), 'hello\n');
    assert.equal((await ops.verify({ cwd: s.cwd })).ok, true);
  } finally {
    const d = await driveStatus({ cwd: s.cwd }).catch(() => undefined);
    if (d?.running) {
      await driveStop({ cwd: s.cwd, now: true, waitMs: 5_000 }).catch(() => undefined);
      if ((await driveStatus({ cwd: s.cwd })).running && d.pid) {
        try { process.kill(-d.pid, 'SIGKILL'); } catch { /* already stopped */ }
      }
    }
    await s.r.cleanup();
  }
});
