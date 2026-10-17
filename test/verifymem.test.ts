import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serialize, deserialize } from 'node:v8';
import { canonical, H, ZERO } from '../src/canon.ts';
import { Ledger, PLAN_CACHE_VERSION, entryHash } from '../src/ledger.ts';
import { parsePlan } from '../src/plan.ts';
import * as ops from '../src/ops.ts';
import * as R from '../src/reducer.ts';
import type { Draft, Entry, Plan } from '../src/types.ts';

// Namespace access also runs against the base tree: the missing diagnostic must fail an assertion, not import.
const diagnostic = () => {
  const stats = (ops as unknown as { verifyPlanStats?: () => { parsed: number; maxRetained: number } }).verifyPlanStats;
  assert.equal(typeof stats, 'function', 'VM3: verifyPlanStats diagnostic is missing');
  return stats!();
};
function freeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value); for (const child of Object.values(value)) freeze(child);
  }
  return value;
}
async function fixture(count = 20) {
  const root = await mkdtemp(join(tmpdir(), 'owed-verifymem-')), dir = join(root, 'owed'), prior = process.env.OWED_DIR;
  const entries: Entry[] = [], plans = new Map<string, Plan>(), commit = '1'.repeat(40);
  const add = (draft: Draft) => {
    const entry = { ...draft, seq: entries.length, ts: new Date(Date.UTC(2026, 0, 1) + entries.length * 1000).toISOString(),
      prev: entries.at(-1)?.hash ?? ZERO } as Entry;
    entry.hash = entryHash(entry); entries.push(entry);
  };
  await mkdir(join(dir, 'blobs'), { recursive: true }); await mkdir(join(dir, 'cache', 'plans'), { recursive: true });
  let previous = '';
  for (let i = 0; i < count; i++) {
    const plan = parsePlan(JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [], nodes: [
      { id: 'worker', title: `revision ${i}`, writes: ['src/'], checks: [{ id: 'unit', run: 'true' }], review: { count: 0, min_rank: 1 } },
    ] })), sha = H(plan);
    plans.set(sha, freeze(plan));
    await writeFile(join(dir, 'blobs', sha), canonical(plan));
    await writeFile(join(dir, 'cache', 'plans', `${sha}.json`), JSON.stringify({ v: PLAN_CACHE_VERSION, sha, plan }));
    add(i === 0 ? { kind: 'genesis', by: 'owner:human', channel: 'tty', trunk: 'main', commit, plan: sha,
      state: { commit, tree: commit, invKeys: {} } } :
      { kind: 'plan', by: 'owner:human', channel: 'tty', prior: previous, plan: sha, downgrades: [], note: `revision ${i}` });
    previous = sha;
  }
  await writeFile(join(dir, 'ledger.jsonl'), entries.map(entry => JSON.stringify(entry) + '\n').join(''));
  process.env.OWED_DIR = dir; ops.forgetReplays(); ops.forgetPlanCache();
  const lookup = (sha: string): Plan => { const p = plans.get(sha); assert.ok(p, `unknown plan ${sha}`); return p; };
  return { root, dir, entries, plans, lookup, ledger: await Ledger.open(root), cache: (sha: string) => join(dir, 'cache', 'plans', `${sha}.json`),
    cleanup: async () => {
      if (prior === undefined) delete process.env.OWED_DIR; else process.env.OWED_DIR = prior;
      ops.forgetReplays(); ops.forgetPlanCache(); await rm(root, { recursive: true, force: true });
    } };
}

test('VM1-VM3: verify keeps 20 YAML plan versions bounded and preserves the result and matching snapshot', async () => {
  const t = await fixture();
  try {
    const expected = R.reduce(t.entries, t.lookup), payload = serialize(R.packState(expected));
    await t.ledger.writeSnapshot(expected.seq, expected.head, payload);
    const before = await readFile(join(t.dir, 'ledger.jsonl'), 'utf8');
    assert.deepEqual(await ops.verify({ cwd: t.root }), { ok: true, entries: t.entries.length, head: expected.head });
    assert.deepEqual((await t.ledger.readSnapshot())?.payload, payload, 'matching snapshot is not rewritten');
    assert.equal(await readFile(join(t.dir, 'ledger.jsonl'), 'utf8'), before, 'verify appends no entries');
    const stats = diagnostic();
    assert.ok(stats.parsed >= 20, `every named plan must be YAML parsed: ${JSON.stringify(stats)}`);
    assert.ok(stats.maxRetained > 0 && stats.maxRetained <= 8, `VM2: retained plans exceed eight: ${JSON.stringify(stats)}`);
    assert.deepEqual(ops.planCacheStats(), { entries: 0, max: 8, hits: 0, misses: 0, evictions: 0 }, 'verify does not populate the process LRU');
    // Diagnostic reads are isolated, and a later call reports only that verification.
    stats.maxRetained = 999;
    assert.ok(diagnostic().maxRetained <= 8);
    await writeFile(join(t.dir, 'ledger.jsonl'), t.entries.slice(0, 1).map(entry => JSON.stringify(entry) + '\n').join(''));
    await t.ledger.removeSnapshot();
    assert.equal((await ops.verify({ cwd: t.root })).ok, true);
    assert.equal(diagnostic().maxRetained, 1, 'last-verify counters are reset for each invocation');
  } finally { await t.cleanup(); }
});

test('VM1: corrupt, stale-version and mismatching historical cache entries retain reporting and rewrite semantics', async () => {
  const t = await fixture();
  try {
    const shas = [...t.plans.keys()], corrupt = shas[0]!, stale = shas[9]!, mismatch = shas[19]!;
    await writeFile(t.cache(corrupt), '{"v": truncated');
    await writeFile(t.cache(stale), JSON.stringify({ v: 'plan-cache/0 owed/0.0.1', sha: stale, plan: {} }));
    const altered = structuredClone(t.lookup(mismatch)); altered.nodes[0]!.title = 'wrong cache value';
    await writeFile(t.cache(mismatch), JSON.stringify({ v: PLAN_CACHE_VERSION, sha: mismatch, plan: altered }));
    assert.deepEqual(await ops.verify({ cwd: t.root }), { ok: true, entries: 20, head: t.entries.at(-1)!.hash, cacheMismatch: [corrupt, mismatch] });
    for (const sha of [corrupt, stale, mismatch]) {
      assert.deepEqual(JSON.parse(await readFile(t.cache(sha), 'utf8')), { v: PLAN_CACHE_VERSION, sha, plan: t.lookup(sha) });
    }
    assert.deepEqual(await ops.verify({ cwd: t.root }), { ok: true, entries: 20, head: t.entries.at(-1)!.hash }, 'repaired entries no longer report mismatches');
    // Missing entries keep their old semantics: no report and no cache publication.
    await rm(t.cache(stale));
    assert.equal((await ops.verify({ cwd: t.root })).cacheMismatch, undefined);
    await assert.rejects(readFile(t.cache(stale)), (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT');
  } finally { await t.cleanup(); }
});

test('VM1-VM2: snapshot mismatch is detected from YAML even when cache repair cannot replace a false plan', async () => {
  const t = await fixture(), writeCache = Ledger.prototype.writePlanCache;
  const readCache = Ledger.prototype.readPlanCache, readCacheSync = Ledger.prototype.readPlanCacheSync;
  try {
    const expected = R.reduce(t.entries, t.lookup), packed = deserialize(serialize(R.packState(expected))) as R.PackedState;
    packed.state.nodes.worker!.writers.push('writer:ghost');
    await t.ledger.writeSnapshot(expected.seq, expected.head, serialize(packed));
    // Replay from a false persistent cache would match this snapshot and miss the real corruption.
    const current = [...t.plans.keys()].at(-1)!, altered = structuredClone(t.lookup(current));
    altered.nodes[0]!.title = 'false persistent law';
    await writeFile(t.cache(current), JSON.stringify({ v: PLAN_CACHE_VERSION, sha: current, plan: altered }));
    Ledger.prototype.writePlanCache = async () => {};
    Ledger.prototype.readPlanCache = async () => assert.fail('verify must not resolve a plan from persistent cache');
    Ledger.prototype.readPlanCacheSync = () => assert.fail('verify must not resolve a plan from persistent cache');
    const result = await ops.verify({ cwd: t.root });
    assert.deepEqual(result, { ok: true, entries: 20, head: expected.head, cacheMismatch: [current], snapshotMismatch: expected.seq });
    assert.equal(await t.ledger.readSnapshot(), undefined, 'mismatching snapshot is deleted');
    assert.equal(JSON.parse(await readFile(t.cache(current), 'utf8')).plan.nodes[0].title, 'false persistent law', 'failed repair was not used by replay');
    assert.equal(ops.planCacheStats().entries, 0);
  } finally {
    Ledger.prototype.writePlanCache = writeCache;
    Ledger.prototype.readPlanCache = readCache; Ledger.prototype.readPlanCacheSync = readCacheSync;
    await t.cleanup();
  }
});

test('VM1-VM2: an evicted historical missing or corrupt YAML blob still fails closed despite valid caches', async () => {
  const t = await fixture();
  try {
    const sha = [...t.plans.keys()][0]!, file = join(t.dir, 'blobs', sha), original = await readFile(file);
    await rm(file);
    const missing = await ops.verify({ cwd: t.root });
    assert.equal(missing.ok, false); assert.equal(missing.entries, 0); assert.match(missing.error!, /ENOENT/);
    await writeFile(file, 'corrupt YAML bytes');
    assert.deepEqual(await ops.verify({ cwd: t.root }), { ok: false, entries: 0, error: `corrupt blob ${sha}` });
    await writeFile(file, original);
    assert.equal((await ops.verify({ cwd: t.root })).ok, true);
  } finally { await t.cleanup(); }
});
