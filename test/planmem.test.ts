import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, appendFile, rm, readdir } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { serialize, deserialize } from 'node:v8';
import { canonical, H, ZERO } from '../src/canon.ts';
import { parsePlan } from '../src/plan.ts';
import { computeMetrics } from '../src/metrics.ts';
import { OwedError } from '../src/errors.ts';
import * as ops from '../src/ops.ts';
import * as R from '../src/reducer.ts';
import { Ledger, PLAN_CACHE_VERSION, entryHash } from '../src/ledger.ts';
import type { Draft, Entry, Plan, State, ObsEntry } from '../src/types.ts';

const commit = '1'.repeat(40), key = '2'.repeat(64);
function freeze<T>(v: T): T {
  if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v)) freeze(x); }
  return v;
}
function version(i: number): Plan {
  return parsePlan(JSON.stringify({ version:1, trunk:'main', closure:[], invariants:[], nodes:[
    { id:'worker', title:`revision ${i}`, writes:['src/'], checks:[{ id:'unit', run:'true', ...(i % 2 === 0 ? { min_tests:1 } : {}) }], review:{ count:0, min_rank:1 } },
    ...(i === 0 ? [{ id:'merge', writes:['other/'], checks:[], review:{ count:0, min_rank:1 } }] : []),
  ] }));
}
function fixture(count = 44) {
  const entries: Entry[] = [], plans = new Map<string,Plan>(), laws: Entry[] = [], observations: ObsEntry[] = [];
  const add = (d: Draft | Record<string,unknown>): Entry => {
    const e = { ...d, seq:entries.length, ts:new Date(Date.UTC(2026,0,1)+entries.length*1000).toISOString(), prev:entries.at(-1)?.hash ?? ZERO } as Entry;
    e.hash = entryHash(e); entries.push(e); return e;
  };
  let prior = '';
  for (let i = 0; i < count; i++) {
    const p = version(i), sha = H(p); plans.set(sha,p);
    laws.push(add(i === 0 ? { kind:'genesis', by:'owner:human', channel:'tty', trunk:'main', commit, plan:sha, state:{ commit,tree:commit,invKeys:{} } } :
      { kind:'plan', by:'owner:human', channel:'tty', prior, plan:sha, downgrades:[], note:`revision ${i}` }));
    if (i === 0) add({ kind:'dispatch',by:'parent:drive',node:'worker',attempt:1,base:commit,branch:'owed/worker/1',worktree:'/wt/worker',packet:key,rulings_seen:0 });
    observations.push(add({ kind:'obs',by:'executor:owed',subject:'worker',obligation:'check:unit',key:`key-${i}`,commit,verdict:'fail',exit:1,durationMs:1 }) as ObsEntry);
    add({ kind:'halt',by:'parent:drive',node:'worker',attempt:1,reason:'merge refused: node merge has 2 failures',needs:'human' });
    add({ kind:'resume',by:'parent:main',node:'worker',attempt:1 });
    prior = sha;
  }
  return { entries,plans,laws,observations,lookup:(sha: string): Plan => {
    const p = plans.get(sha); if (!p) throw new OwedError(`Missing plan ${sha}`,'internal'); return p;
  } };
}
type Fixture = ReturnType<typeof fixture>;
async function sandbox() {
  const root = await mkdtemp(join(tmpdir(),'owed-planmem-')), prior = process.env.OWED_DIR;
  ops.forgetReplays(); ops.forgetPlanCache();
  return { root, use:(dir = join(root,'owed')) => { process.env.OWED_DIR = dir; return dir; }, cleanup:async () => {
    if (prior === undefined) delete process.env.OWED_DIR; else process.env.OWED_DIR = prior;
    ops.forgetReplays(); ops.forgetPlanCache(); await rm(root,{ recursive:true,force:true });
  } };
}
async function writeLedger(dir: string, f: Fixture, entries = f.entries) {
  await mkdir(join(dir,'blobs'),{ recursive:true });
  for (const [sha,p] of f.plans) await writeFile(join(dir,'blobs',sha),canonical(p));
  await writeFile(join(dir,'ledger.jsonl'),entries.map(e => JSON.stringify(e)+'\n').join(''));
}
function bounded(s: State) {
  assert.equal(ops.planCacheStats().max,8);
  assert.ok(ops.planCacheStats().entries <= 8,JSON.stringify(ops.planCacheStats()));
  assert.ok(R.retainedPlanValues(s) <= 5,`retained ${R.retainedPlanValues(s)} plan values`);
}
function queries(s: State, f: Fixture) {
  for (const [i,law] of f.laws.entries()) {
    assert.deepEqual(R.planAt(s,law.seq+1),f.lookup((law as Extract<Entry,{kind:'plan'|'genesis'}>).plan));
    // setupFailure is an obsPlan consumer: min_tests alternates across the historical laws.
    assert.equal(R.setupFailure(s,f.observations[i]!),i % 2 === 0,`historical observation ${i}`);
    bounded(s);
  }
  assert.throws(() => R.planAt(s,0),/No plan is in force before #0/);
}

test('PM1-PM3: growing 44-plan ops history stays bounded; full/memo/disk replay and lazy metrics are exact', async () => {
  const t = await sandbox(), f = fixture(), dir = t.use();
  try {
    // Grow one law at a time through the real load API, without a pre-existing parsed cache.
    const firstEnd = f.laws[1]!.seq;
    await writeLedger(dir,f,f.entries.slice(0,firstEnd));
    let loaded = (await ops.readState({ cwd:t.root })).state;
    bounded(loaded);
    for (let i = 1; i < f.laws.length; i++) {
      const end = f.laws[i+1]?.seq ?? f.entries.length;
      await appendFile(join(dir,'ledger.jsonl'),f.entries.slice(f.laws[i]!.seq,end).map(e => JSON.stringify(e)+'\n').join(''));
      loaded = (await ops.readState({ cwd:t.root })).state; bounded(loaded);
    }
    assert.ok(ops.planCacheStats().evictions > 0);
    const ledger = await Ledger.open(t.root), frozenLookup = (sha: string) => freeze(f.lookup(sha));
    const expected = R.reduce(f.entries,frozenLookup), beforeFull = ops.replayStats.full;
    await ledger.removeSnapshot(); ops.forgetReplays(); ops.forgetPlanCache();
    const full = (await ops.readState({ cwd:t.root })).state;
    assert.equal(ops.replayStats.full,beforeFull+1); bounded(full); queries(full,f);
    assert.equal(R.sameReplay(full,expected),true); bounded(full);
    ops.forgetPlanCache();
    const beforeMemo = ops.replayStats.memo, memo = (await ops.readState({ cwd:t.root })).state;
    assert.equal(ops.replayStats.memo,beforeMemo+1);
    assert.equal(ops.planCacheStats().misses,1,'memo load resolves only the current law, never pre-reads history');
    bounded(memo); queries(memo,f);
    assert.equal(R.sameReplay(memo,expected),true); bounded(memo);
    ops.forgetReplays(); ops.forgetPlanCache();
    const beforeDisk = ops.replayStats.disk, disk = (await ops.readState({ cwd:t.root })).state;
    assert.equal(ops.replayStats.disk,beforeDisk+1);
    assert.equal(ops.planCacheStats().misses,1,'disk load resolves only the current law, never pre-reads history');
    bounded(disk); queries(disk,f);
    assert.equal(R.sameReplay(disk,expected),true); bounded(disk);
    assert.deepEqual(R.packState(full).plans,[...f.plans.keys()]);
    assert.deepEqual(R.packState(disk).plans,R.packState(full).plans);
    const ledgerText = await readFile(join(dir,'ledger.jsonl'),'utf8');
    for (const window of [{},{since:40},{since:40,until:130},{since:f.entries[40]!.ts,until:f.entries[130]!.ts}]) {
      const materialized = computeMetrics(f.entries,f.plans,window);
      let reads = 0;
      assert.deepEqual(computeMetrics(f.entries,{get:(sha: string) => { reads++; return f.lookup(sha); }},window),materialized);
      const historicalLaws = f.laws.filter(e => window.until === undefined ||
        (typeof window.until === 'number' ? e.seq <= window.until : Date.parse(e.ts) <= Date.parse(window.until))).length;
      assert.equal(reads,2*historicalLaws,'two lazy passes hold no historical plan map');
      ops.forgetPlanCache();
      assert.deepEqual(await ops.reportMetrics({cwd:t.root,...window}),materialized);
      assert.ok(ops.planCacheStats().misses > historicalLaws,'report passes a lazy getter rather than pre-materializing plans');
      assert.ok(ops.planCacheStats().entries <= 8);
      assert.ok(materialized.halts.every(h => h.normalizedReason === 'merge refused: node <id> has <n> failures'),
        'plain-word id from an old removed node is normalized without erasing the verb');
    }
    assert.equal(await readFile(join(dir,'ledger.jsonl'),'utf8'),ledgerText);
  } finally { await t.cleanup(); }
});

test('PM1: true LRU hits/eviction/reload and ledger-directory separation even for the same sha', async () => {
  const t = await sandbox(), f = fixture(1), sha = [...f.plans.keys()][0]!;
  try {
    const dirs: string[] = [];
    for (let i = 0; i < 9; i++) { const dir = join(t.root,`d${i}`); dirs.push(dir); await writeLedger(dir,f); }
    for (let i = 0; i < 8; i++) { t.use(dirs[i]); await ops.readState({cwd:t.root}); }
    assert.deepEqual(ops.planCacheStats(),{entries:8,max:8,hits:0,misses:8,evictions:0});
    t.use(dirs[0]); await ops.readState({cwd:t.root}); // refresh d0, making d1 the victim
    const hits = ops.planCacheStats().hits;
    assert.equal(hits,1);
    t.use(dirs[8]); await ops.readState({cwd:t.root});
    assert.equal(ops.planCacheStats().evictions,1);
    t.use(dirs[0]); await ops.readState({cwd:t.root});
    assert.equal(ops.planCacheStats().hits,hits+1,'d0 survived the insertion');
    t.use(dirs[1]); await ops.readState({cwd:t.root});
    assert.equal(ops.planCacheStats().misses,10,'d1 reloads from the persistent cache');
    assert.equal(ops.planCacheStats().evictions,2);
    // Same sha in another ledger must read its own persistent cache, not a process entry from d0.
    const altered = structuredClone(f.lookup(sha)); altered.nodes[0]!.title = 'directory-local cache';
    const other = join(t.root,'other'); await writeLedger(other,f); t.use(other);
    await mkdir(join(other,'cache','plans'),{recursive:true});
    await writeFile(join(other,'cache','plans',`${sha}.json`),JSON.stringify({v:PLAN_CACHE_VERSION,sha,plan:altered}));
    const local = (await ops.readState({cwd:t.root})).state;
    assert.equal(local.plan.nodes[0]!.title,'directory-local cache');
    assert.ok(Object.isFrozen(local.plan.nodes[0]!.checks[0]));
    const verify = await ops.verify({cwd:t.root});
    assert.equal(verify.ok,true,verify.error); assert.deepEqual(verify.cacheMismatch,[sha]);
    ops.forgetPlanCache();
    assert.equal((await ops.readState({cwd:t.root})).state.plan.nodes[0]!.title,'revision 0');
  } finally { await t.cleanup(); }
});

test('PM1: synchronous cache writes publish complete JSON immediately and failures never fail an op', async () => {
  const t = await sandbox(), f = fixture(1), dir = t.use(), sha = [...f.plans.keys()][0]!;
  const oldAsync = Ledger.prototype.writePlanCache;
  try {
    await writeLedger(dir,f);
    Ledger.prototype.writePlanCache = async () => { assert.fail('sync replay must not schedule async plan writes'); };
    const s = (await ops.readState({cwd:t.root})).state; bounded(s);
    const ledger = await Ledger.open(t.root), file = join(dir,'cache','plans',`${sha}.json`);
    assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),{v:PLAN_CACHE_VERSION,sha,plan:f.lookup(sha)});
    ledger.writePlanCacheSync(sha,f.lookup(sha));
    assert.deepEqual(await readdir(join(dir,'cache','plans')),[`${sha}.json`]);
    // Failed serialization leaves an existing destination intact and cleans the temporary file.
    ledger.writePlanCacheSync(sha,{toJSON:() => { throw new Error('serialization failed'); }});
    assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),{v:PLAN_CACHE_VERSION,sha,plan:f.lookup(sha)});
    assert.deepEqual(await readdir(join(dir,'cache','plans')),[`${sha}.json`]);
    // Failed rename cannot replace a directory or strand partial JSON.
    const badSha = 'e'.repeat(64); await mkdir(join(dir,'cache','plans',`${badSha}.json`));
    ledger.writePlanCacheSync(badSha,f.lookup(sha));
    assert.deepEqual((await readdir(join(dir,'cache','plans'))).sort(),[`${sha}.json`,`${badSha}.json`].sort());
    ledger.writePlanCacheSync('not-a-sha',f.lookup(sha));
    await rm(join(dir,'cache'),{recursive:true,force:true}); await writeFile(join(dir,'cache'),'not a directory');
    await ledger.removeSnapshot(); ops.forgetReplays(); ops.forgetPlanCache();
    assert.deepEqual((await ops.readState({cwd:t.root})).state,s);
  } finally { Ledger.prototype.writePlanCache = oldAsync; await t.cleanup(); }
});

test('PM3: evicted laws reload, old packed snapshots and copy/reduceFrom preserve all keys and obsPlan callers', () => {
  assert.equal(typeof R.retainedPlanValues,'function');
  const f = fixture(), lookups = new Map<string,number>();
  const lookup = (sha: string) => { lookups.set(sha,(lookups.get(sha) ?? 0)+1); return freeze(structuredClone(f.lookup(sha))); };
  const s = R.reduce(f.entries,lookup), packed = R.packState(s), oldPlan = (f.laws[2] as Extract<Entry,{kind:'plan'}>).plan;
  bounded(s);
  const n = lookups.get(oldPlan)!;
  R.planAt(s,f.laws[2]!.seq+1); assert.equal(lookups.get(oldPlan),n+1,'an evicted value resolves again');
  queries(s,f);
  const copy = R.copyState(s); assert.equal(R.sameReplay(copy,s),true); bounded(copy);
  // There is no new serialized index/recency metadata: old snapshots can unpack unchanged.
  const disk = R.unpackState(deserialize(serialize(packed)) as R.PackedState,lookup);
  assert.equal(R.sameReplay(disk,s),true); bounded(disk); queries(disk,f);
  const cut = f.laws[25]!.seq, base = R.reduce(f.entries.slice(0,cut),lookup);
  const newShas = new Set(f.entries.slice(cut).flatMap(e => e.kind === 'plan' ? [e.plan] : []));
  const moreOnly = (sha: string) => { assert.ok(newShas.has(sha),'reduceFrom new lookup need not know evicted base laws'); return lookup(sha); };
  const continued = R.reduceFrom(base,f.entries.slice(cut),moreOnly);
  assert.equal(R.sameReplay(continued,s),true); queries(continued,f); bounded(continued);
  assert.equal(R.sameReplay(base,R.reduce(f.entries.slice(0,cut),lookup)),true);
  assert.deepEqual([...R.replayMeta(s).planObjs.keys()],packed.plans); bounded(s);
  assert.deepEqual(R.packState(s).plans,packed.plans,'reloading never reorders packed sha keys');
});

test('PM3: indexed planAt preserves strict predecessors, duplicate seqs and ledger order for out-of-order seqs', () => {
  assert.equal(typeof R.retainedPlanValues,'function');
  const f = fixture(12), laws = f.laws.map(e => structuredClone(e));
  // Only plan/genesis entries: their replay does not require unique/increasing seqs.
  for (const [i,e] of laws.entries()) e.seq = [0,10,10,3,20,4,4,30,2,31,7,8][i]!;
  const lookup = (sha: string) => freeze(f.lookup(sha)), s = R.reduce(laws,lookup);
  const packed = R.packState(s), historyKeys = Object.keys(packed.history).sort();
  for (const state of [s,R.copyState(s),R.unpackState(structuredClone(packed),lookup)]) {
    // The index must not scan all history entries, even on first use after unpack.
    for (const seq of [-1,0,1,3,4,5,8,9,10,11,21,32,NaN]) {
      const expected = laws.findLast(e => e.seq < seq);
      if (!expected) assert.throws(() => R.planAt(state,seq),/No plan is in force/);
      else assert.deepEqual(R.planAt(state,seq),lookup((expected as Extract<Entry,{kind:'plan'|'genesis'}>).plan));
      bounded(state);
    }
    assert.deepEqual(Object.keys(R.packState(state).history).sort(),historyKeys);
    assert.equal(R.sameReplay(state,s),true);
  }
  const ordered = fixture(20), orderedState = R.reduce(ordered.entries,sha => freeze(ordered.lookup(sha)));
  // Once built, planAt consults its plan-only index, not findLast on the ledger's entry array.
  R.planAt(orderedState,2);
  const entries = R.packState(orderedState).history.entries;
  Object.defineProperty(entries,'findLast',{value:() => assert.fail('planAt scanned full entry history'),configurable:true});
  assert.deepEqual(R.planAt(orderedState,ordered.laws[10]!.seq+1),ordered.lookup((ordered.laws[10] as Extract<Entry,{kind:'plan'}>).plan));
  delete (entries as unknown as {findLast?: unknown}).findLast;
});

test('PM3: mutable and shallow-frozen sources retain isolation in state, historical queries, copies and validation', () => {
  assert.equal(typeof R.retainedPlanValues,'function');
  for (const shallow of [false,true]) {
    const f = fixture(), lookup = (sha: string) => f.lookup(sha);
    if (shallow) for (const p of f.plans.values()) { Object.freeze(p.nodes); Object.freeze(p); }
    const s = R.reduce(f.entries,lookup), copy = R.copyState(s), original = canonical(s), plans = R.replayMeta(s).planObjs;
    assert.equal(R.retainedPlanValues(s),44,'mutable nested values must not be evicted');
    for (const p of f.plans.values()) { p.nodes[0]!.title = 'mutated source'; p.nodes[0]!.checks[0]!.min_tests = 99; }
    assert.equal(canonical(s),original); assert.equal(canonical(copy),original);
    for (const [i,e] of f.laws.entries()) {
      const sha = (e as Extract<Entry,{kind:'plan'|'genesis'}>).plan;
      assert.deepEqual(R.planAt(s,e.seq+1),plans.get(sha));
      assert.equal(R.setupFailure(s,f.observations[i]!),i % 2 === 0);
    }
    const copiedAfterMutation = R.copyState(s);
    assert.equal(R.sameReplay(copiedAfterMutation,s),true);
    const d: Draft = {kind:'rule',by:'parent:main',nodes:['worker'],text:'unchanged validation'};
    assert.deepEqual(R.validateDraft(s,d),R.validateDraft(copy,d));
    assert.equal(R.sameReplay(R.reduceFrom(s,[],lookup),s),true);
    s.plan.nodes[0]!.title = 'mutated state';
    assert.equal(canonical(copy),original,'mutable owned plans are copied rather than shared');
  }
});

test('PM1-PM2: missing, corrupt and foreign cache paths stay fail-closed; unknown/newer entries still refuse', async () => {
  const t = await sandbox(), f = fixture(12), dir = t.use();
  try {
    await writeLedger(dir,f);
    const ledger = await Ledger.open(t.root), sha = [...f.plans.keys()][3]!, file = join(dir,'cache','plans',`${sha}.json`);
    for (const bad of ['{"v": truncated',JSON.stringify({v:'plan-cache/0 owed/0.0.1',sha,plan:{}}),
      JSON.stringify({v:PLAN_CACHE_VERSION,sha:'f'.repeat(64),plan:{}}),JSON.stringify({v:PLAN_CACHE_VERSION,sha,plan:null})]) {
      await mkdir(join(dir,'cache','plans'),{recursive:true}); await writeFile(file,bad);
      await ledger.removeSnapshot(); ops.forgetReplays(); ops.forgetPlanCache();
      assert.deepEqual(await ops.reportMetrics({cwd:t.root}),computeMetrics(f.entries,f.plans));
      assert.deepEqual(JSON.parse(readFileSync(file,'utf8')),{v:PLAN_CACHE_VERSION,sha,plan:f.lookup(sha)});
    }
    // Missing named plan blobs and corrupt bytes are not swallowed by lazy metrics/replay validation.
    for (const bad of [undefined,'corrupt YAML bytes']) {
      await rm(file,{force:true});
      if (bad === undefined) await rm(join(dir,'blobs',sha),{force:true}); else await writeFile(join(dir,'blobs',sha),bad);
      await ledger.removeSnapshot(); ops.forgetReplays(); ops.forgetPlanCache();
      const expected = bad === undefined ? (e: unknown) => (e as NodeJS.ErrnoException).code === 'ENOENT' :
        (e: unknown) => e instanceof OwedError && e.code === 'internal' && e.message === `corrupt blob ${sha}`;
      await assert.rejects(ops.readState({cwd:t.root}),expected);
      await assert.rejects(ops.reportMetrics({cwd:t.root}),expected);
      await writeFile(join(dir,'blobs',sha),canonical(f.lookup(sha)));
    }
    // A snapshot cannot cause an unrecorded sha to be trusted by the lookup closure.
    const current = R.reduce(f.entries,sha => freeze(f.lookup(sha))), packed = structuredClone(R.packState(current)), unknown = 'd'.repeat(64);
    packed.history.entries.push({kind:'plan',plan:unknown,seq:999} as Entry); packed.plans.push(unknown);
    await ledger.writeSnapshot(current.seq,current.head,serialize(packed)); ops.forgetReplays(); ops.forgetPlanCache();
    const loaded = (await ops.readState({cwd:t.root})).state;
    // Invalid unpack falls back to a full replay and does not serve the foreign plan.
    assert.throws(() => R.extendState(loaded,[{kind:'genesis',plan:unknown} as Entry]),
      (e: unknown) => e instanceof OwedError && e.code === 'internal' && e.message === `Missing plan ${unknown}`);
    const entries = [...f.entries], e = {kind:'teleport',by:'parent:main',seq:entries.length,ts:f.entries.at(-1)!.ts,prev:entries.at(-1)!.hash} as unknown as Entry;
    e.hash = entryHash(e); entries.push(e); await writeLedger(dir,f,entries);
    ops.forgetReplays(); ops.forgetPlanCache();
    const versionError = (e: unknown) => e instanceof OwedError && e.code === 'version' && /needs a newer owed/.test(e.message);
    await assert.rejects(ops.readState({cwd:t.root}),versionError); await assert.rejects(ops.reportMetrics({cwd:t.root}),versionError);
    assert.throws(() => computeMetrics(f.entries,{get:() => undefined}),/Missing plan/);
  } finally { await t.cleanup(); }
});
