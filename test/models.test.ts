// MD1/MD2: real launch receipts, submissions, reviews and CLI views.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import { projectId, runId, runLabels } from '../src/reducer.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';
const parent = { role: 'parent', id: 'test' } as const;
const owner = { role: 'owner', id: 'pi' } as const;
async function fixture(selected: string, used: string, options: { config?: unknown; raw?: string; same?: 'top' | 'node'; defaultHome?: boolean } = {}) {
  const r = await repo(), priorDsa = process.env.DSA_HOME, priorHome = process.env.HOME;
  if (options.defaultHome) {
    process.env.HOME = join(r.root, 'home'); delete process.env.DSA_HOME;
  } else process.env.DSA_HOME = join(r.root, 'dsa');
  const configDir = options.defaultHome ? join(process.env.HOME!, '.pi', 'durable-subagents') : process.env.DSA_HOME!;
  await mkdir(configDir, { recursive: true });
  if (options.config !== undefined || options.raw !== undefined) await writeFile(join(configDir, 'config.json'), options.raw ?? JSON.stringify(options.config));
  const p = { version: 1, trunk: 'main', closure: [], invariants: [], lease: false,
    ...(options.same === 'top' ? { drive: { same_model: 'accepted' } } : {}),
    nodes: [{ id: 'a', writes: ['a.txt'], checks: [], review: { count: 1, min_rank: 1 },
      ...(options.same === 'node' ? { drive: { same_model: 'accepted' } } : {}) }] };
  const done = async () => {
    if (priorDsa === undefined) delete process.env.DSA_HOME; else process.env.DSA_HOME = priorDsa;
    if (priorHome === undefined) delete process.env.HOME; else process.env.HOME = priorHome;
    await r.cleanup();
  };
  try {
    await r.put('seed', 'fixture'); await r.commit();
    await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify(p), measure: false });
    const slot = await ops.dispatch({ ...r, as: parent, node: 'a' });
    const state = (await ops.readState(r)).state, project = projectId(state);
    for (const role of ['writer', 'reviewer'] as const) {
      await ops.launch({ ...r, as: parent, node: 'a', attempt: 1, role,
        rid: runId(project, 'a', 1, role, role === 'reviewer' ? 1 : undefined),
        spec: JSON.stringify({ model: selected }), labels: runLabels(project, 'a', 1, role), rulings: 0 });
    }
    const commit = await commitAt(slot.worktree, { 'a.txt': 'candidate' });
    const submitted = await cli(slot.worktree, ['submit', 'a', '--model', used, '--json']);
    assert.equal(submitted.code, 0, submitted.stderr);
    const reviewed = await cli(r.cwd, ['review', 'a', '--ok', '--rank', '1', '--as', 'reviewer:drive-a-1-1', '--candidate', commit, '--model', used, '--json']);
    assert.equal(reviewed.code, 0, reviewed.stderr);
    await ops.attest({ ...r, node: 'a' });
    const why = async (args: string[] = []) => { const x = await cli(r.cwd, ['why', 'a', ...args]); assert.equal(x.code, 0, x.stderr); return x.stdout; };
    return { ...r, p, why, done };
  } catch (e) { await done(); throw e; }
}

test('MD1: nested dsa pool strings and model/afterMs members ignore thinking levels', { timeout: 120_000 }, async () => {
  const config = { pools: { sol: ['nested', { model: 'sota/gpt-6.1-sol:high', afterMs: 1000 }], nested: ['mccodex/ide/gpt-6.1-sol:high'] } };
  for (const used of ['mccodex/ide/gpt-6.1-sol:low', 'sota/gpt-6.1-sol:medium']) {
    const f = await fixture('sol', used, { config });
    try { assert.doesNotMatch(await f.why(), /differs from|pool membership unknown/); }
    finally { await f.done(); }
  }
});

test('MD1: direct model thinking differences are quiet, known pool nonmembers still warn', { timeout: 120_000 }, async () => {
  const direct = await fixture('mccodex/ide/gpt-6.1-sol:high', 'mccodex/ide/gpt-6.1-sol:low');
  try { assert.doesNotMatch(await direct.why(), /differs from|pool membership unknown/); } finally { await direct.done(); }
  const other = await fixture('sol', 'other/model:high', { config: { pools: { sol: ['sota/gpt-6.1-sol:high'] } } });
  try { assert.match(await other.why(), /model used other\/model:high differs from the one selected sol/); } finally { await other.done(); }
});

test('MD1: unknown, missing, malformed and cyclic pool configs are explicit, not mismatch warnings', { timeout: 120_000 }, async () => {
  for (const options of [{}, { raw: '{broken' }, { config: { pools: {} } }, { config: { pools: { sol: ['nested'], nested: ['sol'] } } }]) {
    const f = await fixture('sol', 'sota/gpt-6.1-sol:high', options);
    try {
      const text = await f.why();
      assert.match(text, /selected sol \(pool membership unknown\)/);
      assert.doesNotMatch(text, /differs from/);
    } finally { await f.done(); }
  }
});

test('MD1: default HOME config resolves pools when DSA_HOME is unset', { timeout: 120_000 }, async () => {
  const f = await fixture('sol', 'sota/gpt-6.1-sol:low', { defaultHome: true, config: { pools: { sol: [{ model: 'sota/gpt-6.1-sol:high', afterMs: 0 }] } } });
  try { assert.doesNotMatch(await f.why(), /differs from|pool membership unknown/); } finally { await f.done(); }
});

for (const same of ['top', 'node'] as const) test(`MD2: ${same} same_model ack is quiet by default, retained in full/JSON, never a gate`, { timeout: 120_000 }, async () => {
  const f = await fixture('sota/selected:high', 'sota/gpt-6.1-sol:high', { same });
  try {
    assert.doesNotMatch(await f.why(), /Warning: reviewer used the writer's model/);
    assert.match(await f.why(), /differs from the one selected sota\/selected:high/);
    assert.match(await f.why(['--full']), /Warning: reviewer used the writer's model.*\(acknowledged\)/);
    const card = JSON.parse(await f.why(['--json']));
    assert.equal(card.accepted, true);
    assert.ok(card.modelWarnings.some((w: { message?: string; acknowledged?: boolean }) => w.acknowledged === true && w.message?.includes("reviewer used the writer's model")));
    const commit = (await ops.readState(f)).state.nodes.a!.candidate!.commit;
    await ops.review({ cwd: f.cwd, as: { role: 'reviewer', id: 'drive-a-1-1' }, node: 'a', verdict: 'block', rank: 1, note: 'behavior needs repair', named: commit, model: 'sota/gpt-6.1-sol:high' });
    assert.equal(JSON.parse(await f.why(['--json'])).accepted, false, 'ack cannot excuse an independent review block');
    await ops.review({ cwd: f.cwd, as: { role: 'reviewer', id: 'drive-a-1-1' }, node: 'a', verdict: 'ok', rank: 1, note: 'repair verified', named: commit, model: 'sota/gpt-6.1-sol:high' });
    const removed = await ops.planSet({ ...f, as: parent, plan: JSON.stringify({ ...f.p, drive: {}, nodes: f.p.nodes.map(({ drive: _drive, ...n }) => n) }) });
    assert.equal(removed.kind, 'plan');
    assert.ok(removed.kind === 'plan' && !removed.downgrades?.length);
    assert.match(await f.why(), /Warning: reviewer used the writer's model/);
    assert.equal(JSON.parse(await f.why(['--json'])).accepted, true);
  } finally { await f.done(); }
});

test('MD2: unacknowledged warning remains informational, including thinking-only reviewer differences', { timeout: 120_000 }, async () => {
  const f = await fixture('sota/model:high', 'sota/model:high');
  try {
    const commit = (await ops.readState(f)).state.nodes.a!.candidate!.commit;
    const review = await cli(f.cwd, ['review', 'a', '--ok', '--rank', '1', '--as', 'reviewer:drive-a-1-1', '--candidate', commit, '--model', 'sota/model:low']);
    assert.equal(review.code, 0, review.stderr);
    assert.match(await f.why(), /Warning: reviewer used the writer's model/);
    assert.equal(JSON.parse(await f.why(['--json'])).accepted, true);
    for (const drive of [{ same_model: 'ignored' }, { writer: {}, same_model: true }]) {
      await writeFile(join(f.cwd, 'invalid.json'), JSON.stringify({ ...f.p, drive }));
      const x = await cli(f.cwd, ['plan', 'invalid.json', '--as', 'parent:test']);
      assert.notEqual(x.code, 0);
      assert.match(x.stderr, /same_model/);
    }
  } finally { await f.done(); }
});
