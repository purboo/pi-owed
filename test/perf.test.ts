// N4 (0.10): replay speed. Differential equivalence with the frozen 0.10 reducer and views, the synthetic timing bound,
// and the persistent parsed-plan cache (hit, corrupt / other version / other sha ignored, verify bypass, gc).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { Ledger, PLAN_CACHE_VERSION } from '../src/ledger.ts';
import { parsePlan } from '../src/plan.ts';
import { reduce } from '../src/reducer.ts';
import type { Entry, Plan } from '../src/types.ts';
import { compare, fuzzLedger } from './helpers/differential.ts';
import { repo } from './helpers/repo.ts';
import { cli, planText, seed } from './helpers/surface.ts';
import { synthLedger } from './helpers/synth.ts';

const show = (m: ReturnType<typeof compare>): string => m ? `${m.what} at prefix ${m.at}\nbase: ${m.base.slice(0, 3000)}\ncur:  ${m.cur.slice(0, 3000)}` : '';

test('differential: fuzz ledgers give the same validateDraft decisions, states, queries and views as 0.10', { timeout: 600_000 }, () => {
  let kinds = new Set<string>();
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8]) {
    const { entries, lookup, mismatch } = fuzzLedger(seed, 260);
    assert.equal(mismatch, undefined, show(mismatch));
    kinds = new Set([...kinds, ...entries.map(e => e.kind)]);
    const m = compare(entries, lookup, 3);
    assert.equal(m, undefined, show(m));
  }
  // The fuzz reaches the entry kinds whose refresh shortcuts matter.
  for (const k of ['plan', 'rule', 'merge', 'review', 'waive', 'obs', 'submit', 'rebase', 'abandon', 'halt', 'adopt']) assert.ok(kinds.has(k), `fuzz never appended ${k}: ${[...kinds].join(', ')}`);
});

test('differential: a synthetic ledger (waves, plan changes, rulings, merges) at every 25th prefix', { timeout: 600_000 }, () => {
  const { entries, lookup } = synthLedger(1200, 30, 5);
  const m = compare(entries, lookup, 25);
  assert.equal(m, undefined, show(m));
});

/** Real ledger copies (read-only): the wais ledger and this repository's own ledger, on the test host if present. */
const REAL = (process.env.OWED_PERF_LEDGERS ?? [join(homedir(), 'owed-test/perf-wais/owed'), join(homedir(), 'owed-test/perf-self/owed')].join(':')).split(':').filter(Boolean);
for (const dir of REAL) {
  const present = existsSync(join(dir, 'ledger.jsonl'));
  test(`differential: real ledger copy ${dir} (final and every quarter)`, { timeout: 900_000, skip: present ? false : `no ledger copy at ${dir} on this host (set OWED_PERF_LEDGERS)` }, async () => {
    const entries = (await readFile(join(dir, 'ledger.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l) as Entry), plans = new Map<string, Plan>();
    for (const e of entries) if ((e.kind === 'genesis' || e.kind === 'plan') && !plans.has(e.plan)) plans.set(e.plan, parsePlan(await readFile(join(dir, 'blobs', e.plan), 'utf8')));
    const m = compare(entries, sha => { const p = plans.get(sha); if (!p) throw new Error(`missing plan ${sha}`); return p; }, Math.ceil(entries.length / 4));
    assert.equal(m, undefined, show(m));
  });
}

test('synthetic ledger of 10 000 entries and 200 nodes replays within 20 s', { timeout: 120_000 }, () => {
  const { entries, lookup } = synthLedger(10_000, 200);
  assert.ok(entries.length >= 9_500, `synthetic ledger has ${entries.length} entries`);
  const t = performance.now(), s = reduce(entries, lookup), ms = performance.now() - t;
  assert.equal(Object.values(s.nodes).filter(n => n.merged).length, 200);
  assert.ok(ms <= 20_000, `replay took ${Math.round(ms)} ms`);
});

// ---------- persistent plan cache ----------
async function call<T>(cwd: string, args: string[]): Promise<T> { const out = await cli(cwd, [...args, '--json']); assert.equal(out.code, 0, `${args.join(' ')}\n${out.stderr}\n${out.stdout}`); return JSON.parse(out.stdout) as T; }
type Status = { nodes: Record<string, { phase: string }> };
async function inited() {
  const r = await repo();
  await seed(r.cwd); const plan = join(r.root, 'plan.yaml'); await writeFile(plan, planText);
  await call(r.cwd, ['init', plan, '--i-am-owner']);
  const dir = join(r.root, 'ledger'), sha = (JSON.parse((await readFile(join(dir, 'ledger.jsonl'), 'utf8')).split('\n')[0]!) as { plan: string }).plan;
  const file = join(dir, 'cache', 'plans', `${sha}.json`);
  return { r, dir, sha, file };
}
/** A cache entry whose plan differs from the blob in a visible way: b no longer depends on a, so it is ready at once. */
async function tampered(file: string, patch: Record<string, unknown> = {}): Promise<void> {
  const c = JSON.parse(await readFile(file, 'utf8')) as { v: string; sha: string; plan: Plan };
  c.plan.nodes.find(n => n.id === 'b')!.deps = [];
  await writeFile(file, JSON.stringify({ ...c, ...patch }));
}
const phaseOfB = async (cwd: string): Promise<string> => (await call<Status>(cwd, ['status'])).nodes.b!.phase;

test('plan cache: written on the first parse, then read instead of the YAML; verify bypasses it, reports and rewrites a mismatch', { timeout: 120_000 }, async () => {
  const { r, sha, file } = await inited();
  try {
    const c = JSON.parse(await readFile(file, 'utf8')) as { v: string; sha: string; plan: Plan };
    assert.equal(c.v, PLAN_CACHE_VERSION); assert.equal(c.sha, sha); assert.deepEqual(c.plan, parsePlan(planText));
    assert.equal(await phaseOfB(r.cwd), 'blocked');
    await tampered(file);
    assert.equal(await phaseOfB(r.cwd), 'ready', 'a cache hit replaces the YAML parse');
    const v = await call<{ ok: boolean; cacheMismatch?: string[] }>(r.cwd, ['verify']);
    assert.equal(v.ok, true); assert.deepEqual(v.cacheMismatch, [sha]);
    assert.equal(await phaseOfB(r.cwd), 'blocked', 'verify rewrote the entry from the blob');
    assert.equal((await call<{ cacheMismatch?: string[] }>(r.cwd, ['verify'])).cacheMismatch, undefined);
  } finally { await r.cleanup(); }
});

test('plan cache: a corrupt entry, another version or another sha is ignored and rewritten; an unwritable cache never fails an op', { timeout: 120_000 }, async () => {
  const { r, dir, file } = await inited();
  try {
    for (const bad of [async () => writeFile(file, '{"v": truncated'), async () => tampered(file, { v: 'plan-cache/0 owed/0.0.1' }), async () => tampered(file, { sha: '0'.repeat(64) }), async () => tampered(file, { plan: null })]) {
      await bad();
      assert.equal(await phaseOfB(r.cwd), 'blocked');
      const c = JSON.parse(await readFile(file, 'utf8')) as { v: string; plan: Plan };
      assert.equal(c.v, PLAN_CACHE_VERSION); assert.deepEqual(c.plan.nodes.find(n => n.id === 'b')!.deps, ['a'], 'rewritten from the YAML');
    }
    // A file where the cache directory should be: reads and writes fail, the op still succeeds from the YAML.
    const { rm } = await import('node:fs/promises');
    await rm(join(dir, 'cache'), { recursive: true }); await writeFile(join(dir, 'cache'), 'not a directory');
    assert.equal(await phaseOfB(r.cwd), 'blocked');
    assert.equal((await call<{ ok: boolean }>(r.cwd, ['verify'])).ok, true);
  } finally { await r.cleanup(); }
});

test('plan cache: gc removes entries and temp files whose sha the ledger no longer names, records nothing for them', { timeout: 120_000 }, async () => {
  const { r, dir, sha } = await inited();
  try {
    const plans = join(dir, 'cache', 'plans'), stale = `${'e'.repeat(64)}.json`, temp = `.${'e'.repeat(64)}.x.tmp`;
    await mkdir(plans, { recursive: true }); await writeFile(join(plans, stale), '{}'); await writeFile(join(plans, temp), '');
    const lines = async () => (await readFile(join(dir, 'ledger.jsonl'), 'utf8')).split('\n').filter(Boolean).length, before = await lines();
    const dry = await call<{ planCache?: string[] }>(r.cwd, ['gc', '--dry-run']);
    assert.deepEqual(dry.planCache, [temp, stale]);
    assert.ok(existsSync(join(plans, stale)));
    const text = await cli(r.cwd, ['gc', '--dry-run']); assert.match(text.stdout, /Plan cache files that would be removed \(sha no longer in the ledger\): 2/);
    const run = await call<{ planCache?: string[]; entry?: unknown }>(r.cwd, ['gc']);
    assert.deepEqual(run.planCache, [temp, stale]); assert.equal(run.entry, undefined);
    assert.deepEqual(await readdir(plans), [`${sha}.json`]);
    assert.equal(await lines(), before, 'nothing is recorded for the plan cache');
    assert.equal((await call<{ planCache?: string[] }>(r.cwd, ['gc'])).planCache, undefined);
    // The in-process API agrees: the named entry is still a hit.
    assert.ok(await (await Ledger.open(r.cwd)).readPlanCache(sha));
  } finally { await r.cleanup(); }
});
