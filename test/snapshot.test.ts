// G1 (0.12): replay cost independent of ledger length. Equivalence of the full replay with a fold continued from a
// (disk) snapshot or from the in-process cache, non-aliasing, snapshot hygiene, verify's comparison, the `version`
// refusal for entries of a newer owed, and a generous timing bound.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { serialize, deserialize } from 'node:v8';
import { canonical, H } from '../src/canon.ts';
import { parsePlan } from '../src/plan.ts';
// Namespace imports: against an owed without G1 the new names are undefined, so each test fails on its own (red).
import * as errors from '../src/errors.ts';
import * as ledgers from '../src/ledger.ts';
import * as ops from '../src/ops.ts';
import * as R from '../src/reducer.ts';
import type { PackedState } from '../src/reducer.ts';
import type { Draft, Entry, Plan, State } from '../src/types.ts';
import { CUR, frozen, fuzzLedger, snapshot, variants } from './perf/differential.ts';
import { synthLedger } from './perf/synth.ts';
import { cli } from './helpers/surface.ts';
import { supersededText } from '../src/views.ts';
import { setImmediate as nextTurn } from 'node:timers/promises';

type Lookup = (sha: string) => Plan;
/**
 * A ledger directory of `entries`: ledger.jsonl, each plan as a blob (its canonical JSON, a YAML document whose sha256 is
 * the plan sha synth uses) and its persistent plan cache entry (as test/perf/synth-dir.ts, inlined for the red run).
 */
async function writeLedgerDir(dir: string, entries: Entry[], plans: Map<string, Plan>): Promise<void> {
  await mkdir(join(dir, 'blobs'), { recursive: true }); await mkdir(join(dir, 'cache', 'plans'), { recursive: true });
  await writeFile(join(dir, 'ledger.jsonl'), entries.map(e => JSON.stringify(e) + '\n').join(''));
  for (const [sha, plan] of plans) {
    await writeFile(join(dir, 'blobs', sha), canonical(plan));
    await writeFile(join(dir, 'cache', 'plans', `${sha}.json`), JSON.stringify({ v: ledgers.PLAN_CACHE_VERSION, sha, plan }));
  }
}
/** `entries` with `d` appended as the ledger would (seq, ts, prev, hash); returns the new entry. */
function chain(entries: Entry[], d: Draft | Record<string, unknown>): Entry {
  const e = { ...d, seq: entries.length, ts: new Date(Date.UTC(2026, 6, 1) + entries.length * 1000).toISOString(), prev: entries.at(-1)?.hash ?? '0'.repeat(64) } as Entry;
  e.hash = ledgers.entryHash(e); entries.push(e); return e;
}
type OwedError = errors.OwedError;
const { OwedError } = errors, { Ledger } = ledgers, { reduce, validateDraft } = R;
const OWED_VERSION = errors.OWED_VERSION, SNAPSHOT_FORMAT = ledgers.SNAPSHOT_FORMAT;
const copyState = (s: State, plans?: Lookup): State => R.copyState(s, plans), extendState = (s: State, more: Entry[]): State => R.extendState(s, more);
const packState = (s: State): PackedState => R.packState(s), unpackState = (p: PackedState, plans: Lookup): State => R.unpackState(p, plans);
const reduceFrom = (b: State, more: Entry[], plans: Lookup): State => R.reduceFrom(b, more, plans);
const replayMeta = (s: State): unknown => R.replayMeta(s), sameReplay = (a: State, b: State): boolean => R.sameReplay(a, b);
/** The disk path: v8 serialization of the packed state, then unpacked with a lookup (as load does). */
const viaDisk = (s: State, lookup: Lookup): State => unpackState(deserialize(serialize(packState(s))) as PackedState, lookup);
function same(a: State, b: State, what: string): void {
  if (sameReplay(a, b)) return;
  assert.deepStrictEqual(a, b, `${what}: state`);
  assert.deepStrictEqual(replayMeta(a), replayMeta(b), `${what}: replay metadata`);
  assert.fail(`${what}: not sameReplay`);
}
const decisions = (s: State, next: Entry | undefined, nodes: string[]): string => {
  if (!next) return '';
  const { seq: _s, ts: _t, prev: _p, hash: _h, ...draft } = next;
  return canonical(variants(draft as Draft, nodes).map(d => { try { return validateDraft(s, d); } catch (e) { return `throws ${String(e)}`; } }));
};

/**
 * Every k of a fixture ledger: the snapshot at k (disk path and in-process copy) + the fold of the rest equals the full
 * replay, with the same validateDraft decisions and views at k; the running state is never mutated by reduceFrom.
 */
function everyK(entries: Entry[], lookup: Lookup, label: string): void {
  const final = reduce(entries, lookup);
  let running = reduce([], lookup);
  for (let k = 0; k <= entries.length; k++) {
    if (k > 0) extendState(running, [entries[k - 1]!]);
    const disk = viaDisk(running, lookup), mem = copyState(running), prefix = entries.slice(0, k);
    same(disk, running, `${label} disk copy at ${k}`); same(mem, running, `${label} memory copy at ${k}`);
    if (k > 0) assert.equal(snapshot(CUR, disk, prefix), snapshot(CUR, running, prefix), `${label} views at ${k}`);
    const ids = Object.keys(running.nodes);
    assert.equal(decisions(disk, entries[k], ids), decisions(running, entries[k], ids), `${label} validateDraft at ${k}`);
    const guard = copyState(running);
    same(extendState(disk, entries.slice(k)), final, `${label} disk snapshot at ${k} + fold`);
    same(reduceFrom(running, entries.slice(k), lookup), final, `${label} reduceFrom at ${k}`);
    same(running, guard, `${label} reduceFrom left its base unchanged at ${k}`);
  }
  same(running, final, `${label} running fold`);
}

test('equivalence: every k of fuzz fixture ledgers (disk snapshot and in-process copy + fold = full replay; views, validateDraft)', { timeout: 600_000 }, () => {
  for (const seed of [11, 12]) {
    const { entries, lookup, mismatch } = fuzzLedger(seed, 160);
    assert.equal(mismatch, undefined);
    assert.ok(entries.length > 60, `fuzz ledger ${seed} has ${entries.length} entries`);
    everyK(entries, frozen(lookup), `fuzz ${seed}`);
    // Unfrozen plans (a caller's own lookup) are cloned by the reducer: the copies keep them apart, still equal.
    everyK(entries.slice(0, 60), lookup, `fuzz ${seed} unfrozen`);
  }
});

test('equivalence: draft simulations fold onto a copy of the loaded state exactly as a replay of all entries', { timeout: 600_000 }, () => {
  // The ops simulations (carry submits, merge-result observations, prospective adoptions, amend's ruling) append
  // drafts to a loaded state with reduceFrom, then extendState; each must equal a replay of entries + drafts.
  const { entries, lookup } = fuzzLedger(13, 200), f = frozen(lookup);
  for (let k = 1; k < entries.length; k += 7) {
    const prefix = entries.slice(0, k), loaded = reduce(prefix, f), drafts = entries.slice(k, k + 3);
    let sim: State | undefined;
    for (const [i, e] of drafts.entries()) {
      sim = sim ? extendState(sim, [e]) : reduceFrom(loaded, [e], f);
      same(sim, reduce(entries.slice(0, k + i + 1), f), `simulation at ${k}+${i + 1}`);
    }
    same(loaded, reduce(prefix, f), `loaded state unchanged at ${k}`);
  }
});

test('equivalence: synthetic 10 000-entry ledger at every 97th k (snapshot + fold), views at a few cuts', { timeout: 900_000 }, () => {
  const { entries, lookup: raw } = synthLedger(10_000, 200), lookup = frozen(raw);
  assert.equal(entries.length, 10_000, 'the synthetic benchmark must reach at least its requested 10 000 entries');
  const final = reduce(entries, lookup), step = 97;
  let running = reduce([], lookup), k = 0;
  const ends = new Set([0, 97 * 41, 97 * 97]);
  while (k <= entries.length) {
    const disk = viaDisk(running, lookup);
    same(disk, running, `synthetic disk copy at ${k}`);
    const ids = Object.keys(running.nodes);
    assert.equal(decisions(disk, entries[k], ids), decisions(running, entries[k], ids), `synthetic validateDraft at ${k}`);
    if (ends.has(k)) {
      assert.equal(snapshot(CUR, disk, entries.slice(0, k)), snapshot(CUR, running, entries.slice(0, k)), `synthetic views at ${k}`);
      same(reduceFrom(disk, entries.slice(k), lookup), final, `synthetic snapshot at ${k} + fold to the end`);
    }
    // The continuation of the snapshot at k over the next segment equals the replay at k + step.
    const segment = entries.slice(k, k + step), next = extendState(running, segment);
    if (!segment.length) break;
    same(extendState(disk, segment), next, `synthetic snapshot at ${k} + ${segment.length}`);
    running = next; k += segment.length;
  }
  same(running, final, 'synthetic running fold');
});

/** Real ledger copies (read-only) on the test host, if present: snapshot at every 97th k + fold of the next segment. */
const REAL = (process.env.OWED_SNAPSHOT_LEDGERS ?? [join(homedir(), 'owed-test/perf-wais-0120/owed'), join(homedir(), 'owed-test/perf-self/owed')].join(':')).split(':').filter(Boolean);
for (const dir of REAL) {
  const present = existsSync(join(dir, 'ledger.jsonl'));
  test(`equivalence: real ledger copy ${dir} at every 97th k (snapshot + fold)`, { timeout: 900_000, skip: present ? false : `no ledger copy at ${dir} on this host (set OWED_SNAPSHOT_LEDGERS)` }, async () => {
    const entries = (await readFile(join(dir, 'ledger.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l) as Entry), plans = new Map<string, Plan>();
    for (const e of entries) if ((e.kind === 'genesis' || e.kind === 'plan') && !plans.has(e.plan)) plans.set(e.plan, parsePlan(await readFile(join(dir, 'blobs', e.plan), 'utf8')));
    const lookup = frozen(sha => { const p = plans.get(sha); if (!p) throw new Error(`missing plan ${sha}`); return p; }), final = reduce(entries, lookup);
    let running = reduce([], lookup);
    for (let k = 0; k < entries.length; k += 97) {
      const disk = viaDisk(running, lookup), segment = entries.slice(k, k + 97);
      same(disk, running, `real disk copy at ${k}`);
      if (k === 97 * Math.floor(entries.length / 194)) same(reduceFrom(disk, entries.slice(k), lookup), final, `real snapshot at ${k} + fold to the end`);
      same(extendState(viaDisk(running, lookup), segment), extendState(running, segment), `real snapshot at ${k} + ${segment.length}`);
    }
    same(running, final, 'real running fold');
  });
}

// ---------- ledger directories (ops load: in-process cache and disk snapshot) ----------
async function ledgerDir(n = 600, nodes = 20): Promise<{ root: string; dir: string; entries: Entry[]; lookup: Lookup; cleanup: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'owed-snap-')), dir = join(root, 'owed'), { entries, plans, lookup } = synthLedger(n, nodes);
  await writeLedgerDir(dir, entries, plans);
  const prior = process.env.OWED_DIR; process.env.OWED_DIR = dir; ops.forgetReplays();
  return { root, dir, entries, lookup: frozen(lookup), cleanup: async () => { if (prior === undefined) delete process.env.OWED_DIR; else process.env.OWED_DIR = prior; ops.forgetReplays(); await rm(root, { recursive: true, force: true }); } };
}
const append = async (dir: string, entries: Entry[], d: Draft | Record<string, unknown>): Promise<Entry> => { const e = chain(entries, d); await appendFile(join(dir, 'ledger.jsonl'), JSON.stringify(e) + '\n'); return e; };
const stats = () => ({ ...ops.replayStats });
const delta = (a: typeof ops.replayStats, b: typeof ops.replayStats) => ({ full: b.full - a.full, memo: b.memo - a.memo, disk: b.disk - a.disk, folded: b.folded - a.folded });
const note = (i: number): Draft => ({ kind: 'note', by: 'parent:main', text: `note ${i}` });

test('load: in-process cache and disk snapshot continue the fold; results never alias; snapshot rewritten only 256 entries past it', { timeout: 300_000 }, async () => {
  const t = await ledgerDir();
  try {
    const ledger = await Ledger.open(t.root);
    let before = stats(), r = await ops.readState({ cwd: t.root });
    assert.deepEqual(delta(before, stats()), { full: 1, memo: 0, disk: 0, folded: t.entries.length });
    same(r.state, reduce(t.entries, t.lookup), 'cold load');
    const s0 = t.entries.length - 1;
    assert.equal((await ledger.readSnapshot())?.seq, s0, 'no snapshot found: one is written');
    // In-process cache: one appended entry is folded onto it.
    const first = r.state;
    await append(t.dir, t.entries, note(1));
    before = stats(); r = await ops.readState({ cwd: t.root });
    assert.deepEqual(delta(before, stats()), { full: 0, memo: 1, disk: 0, folded: 1 });
    same(r.state, reduce(t.entries, t.lookup), 'memo + fold');
    // Non-aliasing: mutating one result (and the state it came from) never reaches another load's result.
    const third = (await ops.readState({ cwd: t.root })).state;
    assert.notEqual(third, r.state); assert.notEqual(third.nodes, r.state.nodes);
    r.state.nodes.n0!.writers.push('writer:intruder'); r.state.rules.length = 0; (r.state.nodes.n1!.items[0] ?? { detail: '' }).detail = 'mutated'; first.seq = 999;
    same((await ops.readState({ cwd: t.root })).state, reduce(t.entries, t.lookup), 'after mutating earlier results');
    same(third, reduce(t.entries, t.lookup), 'a held result is unaffected by later loads');
    // A fresh process (no in-process cache) folds from the disk snapshot; fewer than 256 entries past it: not rewritten.
    for (let i = 2; i < 200; i++) await append(t.dir, t.entries, note(i));
    ops.forgetReplays(); before = stats(); r = await ops.readState({ cwd: t.root });
    assert.deepEqual(delta(before, stats()), { full: 0, memo: 0, disk: 1, folded: 199 });
    same(r.state, reduce(t.entries, t.lookup), 'disk snapshot + fold');
    assert.equal((await ledger.readSnapshot())?.seq, s0, 'not rewritten below 256 entries past it');
    for (let i = 200; i < 300; i++) await append(t.dir, t.entries, note(i));
    ops.forgetReplays(); r = await ops.readState({ cwd: t.root });
    same(r.state, reduce(t.entries, t.lookup), 'disk snapshot + 299');
    assert.equal((await ledger.readSnapshot())?.seq, t.entries.length - 1, 'rewritten 256+ entries past it');
    // The in-process cache follows another rewrite of the ledger (another hash at its seq): full replay.
    const other = synthLedger(400, 10);
    await writeLedgerDir(t.dir, other.entries, other.plans);
    before = stats(); r = await ops.readState({ cwd: t.root });
    assert.equal(delta(before, stats()).full, 1, 'neither the cache nor the snapshot matches the chain');
    same(r.state, reduce(other.entries, frozen(other.lookup)), 'rewritten ledger');
    assert.equal((await ledger.readSnapshot())?.seq, other.entries.length - 1, 'mismatching snapshot replaced');
  } finally { await t.cleanup(); }
});

test('disk snapshot: stale, corrupt, foreign-version or foreign-format snapshots are ignored and replaced, never an error', { timeout: 300_000 }, async () => {
  const t = await ledgerDir(400, 10);
  try {
    const ledger = await Ledger.open(t.root), file = ledger.snapshotFile, expected = reduce(t.entries, t.lookup);
    await ops.readState({ cwd: t.root });
    const good = await readFile(file), outer = deserialize(good) as Record<string, unknown>;
    const variantsOf: [string, Buffer | string][] = [
      ['garbage', 'not a v8 snapshot'],
      ['truncated', good.subarray(0, Math.floor(good.length / 2))],
      ['other owed version', serialize({ ...outer, version: '0.0.1' })],
      ['other format', serialize({ ...outer, format: 'owed-snapshot/0' })],
      ['payload digest mismatch', serialize({ ...outer, payload: serialize({ tampered: true }) })],
      ['hash not in the chain', serialize({ ...outer, hash: 'f'.repeat(64) })],
      ['seq beyond the ledger', serialize({ ...outer, seq: t.entries.length + 5 })],
    ];
    for (const [what, bytes] of variantsOf) {
      await writeFile(file, bytes); ops.forgetReplays();
      const before = stats(), r = await ops.readState({ cwd: t.root });
      assert.equal(delta(before, stats()).full, 1, `${what}: full replay`);
      same(r.state, expected, what);
      const s = await ledger.readSnapshot();
      assert.equal(s?.seq, t.entries.length - 1, `${what}: replaced`); assert.equal(s?.hash, t.entries.at(-1)!.hash);
    }
    assert.equal((deserialize(await readFile(file)) as { format: string; version: string }).format, SNAPSHOT_FORMAT);
    assert.equal((deserialize(await readFile(file)) as { version: string }).version, OWED_VERSION);
    // An unwritable snapshot location never fails an op.
    await rm(join(t.dir, 'snapshot'), { recursive: true, force: true }); await writeFile(join(t.dir, 'snapshot'), 'a file, not a directory');
    ops.forgetReplays(); same((await ops.readState({ cwd: t.root })).state, expected, 'unwritable snapshot dir');
  } finally { await t.cleanup(); }
});

test('verify: compares a matching disk snapshot with its full replay; a difference deletes it and reports snapshotMismatch (JSON and text)', { timeout: 300_000 }, async () => {
  const t = await ledgerDir(400, 10);
  try {
    const ledger = await Ledger.open(t.root);
    await ops.readState({ cwd: t.root });
    const snap = (await ledger.readSnapshot())!;
    let v = await ops.verify({ cwd: t.root });
    assert.equal(v.ok, true, v.error); assert.equal(v.cacheMismatch, undefined, 'the plan blobs parse to the cached plans');
    assert.equal(v.snapshotMismatch, undefined); assert.equal(v.head, t.entries.at(-1)!.hash);
    assert.ok(await ledger.readSnapshot(), 'a matching snapshot is kept');
    // A snapshot whose header and digest match but whose state differs from the replay at its seq.
    const tamper = async (): Promise<void> => {
      const p = deserialize(snap.payload) as PackedState;
      p.state.nodes.n3!.phase = 'ready'; p.state.nodes.n3!.writers.push('writer:ghost');
      await ledger.writeSnapshot(snap.seq, snap.hash, serialize(p));
    };
    await tamper();
    // load uses it (it matches the chain); verify never does for its own result.
    ops.forgetReplays(); assert.equal((await ops.readState({ cwd: t.root })).state.nodes.n3!.phase, 'ready');
    v = await ops.verify({ cwd: t.root });
    assert.equal(v.ok, true); assert.equal(v.snapshotMismatch, snap.seq); assert.equal(v.head, t.entries.at(-1)!.hash);
    assert.equal(await ledger.readSnapshot(), undefined, 'deleted');
    // No forgetReplays: verify must invalidate the corrupt memo in this process itself.
    same((await ops.readState({ cwd: t.root })).state, reduce(t.entries, t.lookup), 'same-process load after verify');
    for (let i = 0; i < 256; i++) await append(t.dir, t.entries, note(i));
    same((await ops.readState({ cwd: t.root })).state, reduce(t.entries, t.lookup), 'memo cannot republish corruption after +256');
    same(unpackState(deserialize((await ledger.readSnapshot())!.payload) as PackedState, t.lookup), reduce(t.entries, t.lookup), 'rewritten snapshot is clean');
    assert.equal((await ops.verify({ cwd: t.root })).snapshotMismatch, undefined);
    // CLI: JSON field and text line.
    await tamper();
    const json = await cli(t.root, ['verify', '--json']);
    assert.equal(json.code, 0, json.stderr); assert.equal((JSON.parse(json.stdout) as { snapshotMismatch?: number }).snapshotMismatch, snap.seq);
    await tamper();
    const text = await cli(t.root, ['verify']);
    assert.equal(text.code, 0, text.stderr); assert.match(text.stdout, new RegExp(`^snapshotMismatch: ${snap.seq}\\b`, 'm'));
    ops.forgetReplays(); same((await ops.readState({ cwd: t.root })).state, reduce(t.entries, t.lookup), 'after verify deleted it');
  } finally { await t.cleanup(); }
});

// A controlled pause at an async replay boundary: no timing sleeps or unowned process cleanup.
function latch() {
  let release!: () => void;
  const waiting = new Promise<void>(resolve => { release = resolve; });
  return { waiting, release };
}

for (const boundary of ['snapshot-read', 'snapshot-write'] as const) {
  test(`verify: invalidation prevents an in-flight ${boundary} load publishing stale memo or disk state`, { timeout: 60_000 }, async () => {
    const t = await ledgerDir(400, 10), entered = latch(), resume = latch();
    const readSnapshot = Ledger.prototype.readSnapshot, writeSnapshot = Ledger.prototype.writeSnapshot;
    let pending: Promise<unknown> | undefined, verification: Promise<ops.VerifyResult> | undefined;
    try {
      const ledger = await Ledger.open(t.root);
      await ops.readState({ cwd: t.root });
      const snap = (await ledger.readSnapshot())!, p = deserialize(snap.payload) as PackedState;
      p.state.nodes.n3!.writers.push('writer:stale-inflight');
      await ledger.writeSnapshot(snap.seq, snap.hash, serialize(p)); ops.forgetReplays();
      let pause = true;
      if (boundary === 'snapshot-read') {
        Ledger.prototype.readSnapshot = async function () {
          const result = await readSnapshot.call(this);
          if (this.dir === t.dir && pause) { pause = false; entered.release(); await resume.waiting; }
          return result;
        };
      } else {
        // Seed the corrupt memo, then pause a write that would republish it after 256 appended entries.
        await ops.readState({ cwd: t.root });
        for (let i = 0; i < 256; i++) await append(t.dir, t.entries, note(i));
        Ledger.prototype.writeSnapshot = async function (seq, hash, payload) {
          if (this.dir === t.dir && pause) { pause = false; entered.release(); await resume.waiting; }
          return writeSnapshot.call(this, seq, hash, payload);
        };
      }
      pending = ops.readState({ cwd: t.root });
      await entered.waiting;
      if (boundary === 'snapshot-read') {
        const v = await ops.verify({ cwd: t.root });
        assert.equal(v.snapshotMismatch, snap.seq); assert.equal(v.ok, true, v.error);
        resume.release(); await pending;
      } else {
        // Observe verify's snapshot read, then yield until its synchronous comparison queued invalidation/deletion.
        const observed = latch();
        Ledger.prototype.readSnapshot = async function () { const result = await readSnapshot.call(this); if (this.dir === t.dir) observed.release(); return result; };
        verification = ops.verify({ cwd: t.root });
        await observed.waiting; await nextTurn();
        resume.release(); await pending;
        const v = await verification;
        assert.equal(v.snapshotMismatch, snap.seq); assert.equal(v.ok, true, v.error);
      }
      assert.equal(await ledger.readSnapshot(), undefined, 'the stale in-flight load cannot leave a snapshot behind verification');
      const before = stats();
      same((await ops.readState({ cwd: t.root })).state, reduce(t.entries, t.lookup), 'load after in-flight invalidation');
      assert.equal(delta(before, stats()).full, 1, 'no stale memo was published');
    } finally {
      resume.release(); await pending?.catch(() => undefined); await verification?.catch(() => undefined);
      Ledger.prototype.readSnapshot = readSnapshot; Ledger.prototype.writeSnapshot = writeSnapshot;
      await t.cleanup();
    }
  });
}

test('lazy old plan: why rethrows a missing superseding-plan blob exactly as full replay; no-plan fallback remains informational', { timeout: 60_000 }, async () => {
  const t = await ledgerDir(400, 10);
  try {
    const synth = synthLedger(400, 10), fail = synth.entries.find(e => e.kind === 'obs' && e.subject === 'n0' && e.verdict === 'fail')!;
    const entries = synth.entries.slice(0, fail.seq + 1), initial = synth.plans.get(entries[0]!.kind === 'genesis' ? entries[0]!.plan : '')!;
    const superseding = structuredClone(initial); superseding.nodes[0]!.checks[0]!.run += ' changed';
    const middle = H(superseding);
    const change = chain(entries, { kind: 'plan', by: 'owner:human', prior: H(initial), plan: middle, downgrades: [], note: 'changed check' });
    const current = structuredClone(superseding); current.nodes[0]!.title = 'newer plan';
    const currentSha = H(current);
    chain(entries, { kind: 'plan', by: 'owner:human', prior: middle, plan: currentSha, downgrades: [], note: 'title' });
    const plans = new Map([...synth.plans, [middle, superseding], [currentSha, current]]);
    await writeLedgerDir(t.dir, entries, plans);
    const lookup = frozen(s => plans.get(s)!), state = reduce(entries, lookup), ledger = await Ledger.open(t.root);
    const block = state.nodes.n0!.blocks.find(b => b.seq === fail.seq)!;
    assert.equal(block.supersededBy, change.seq);
    assert.match(supersededText(state, block), /definition changed/);
    assert.match(supersededText(reduce([], lookup), { ...block, supersededBy: -1 }), /definition changed/, 'only no-plan is swallowed');
    // Write without an ops load, so the in-process parsed-plan cache never learned this intermediate plan.
    await ledger.writeSnapshot(state.seq, state.head, serialize(packState(state)));
    await rm(join(t.dir, 'blobs', middle)); await rm(join(t.dir, 'cache', 'plans', `${middle}.json`)); ops.forgetReplays();
    let fullError: unknown;
    try { ledger.getBlobSync(middle); } catch (e) { fullError = e; }
    assert.equal((fullError as NodeJS.ErrnoException).code, 'ENOENT');
    const full = await ops.verify({ cwd: t.root }); // Full replay resolves every plan from its blob before reducing.
    assert.equal(full.ok, false); assert.equal(full.error, (fullError as Error).message);
    await assert.rejects(ops.why({ cwd: t.root, node: 'n0' }), (e: unknown) => e instanceof Error && e.message === full.error);
  } finally { await t.cleanup(); }
});

test('version: an unknown kind, send reason, obs verdict or ruling flag refuses replay with code version (CLI exit 1); other invalid entries keep their error', async () => {
  const { entries: base, lookup } = synthLedger(400, 10), f = frozen(lookup);
  const text = (seq: number, what: string): string => `ledger entry #${seq} (${what}) needs a newer owed than ${OWED_VERSION}: upgrade owed and restart pi sessions that load it`;
  const refusal = (entries: Entry[]): OwedError => { try { reduce(entries, f); } catch (e) { assert.ok(e instanceof OwedError); return e; } return assert.fail('replay did not refuse'); };
  const send = base.find((e): e is Extract<Entry, { kind: 'send' }> => e.kind === 'send')!;
  const cases: [string, Record<string, unknown>][] = [
    ['teleport', { kind: 'teleport', by: 'parent:main', node: 'n1' }],
    ['send reason teleported', { ...send, seq: undefined, ts: undefined, prev: undefined, hash: undefined, send: `${send.rid}:follow-up:${base.length}`, reason: 'teleported' }],
    ['obs verdict skipped', { kind: 'obs', by: 'executor:owed', subject: 'trunk', obligation: 'inv:safe', key: 'k', verdict: 'skipped', exit: 0, durationMs: 1, commit: 'c' }],
    ['rule urgent true', { kind: 'rule', by: 'parent:main', text: 'hurry', nodes: '*', urgent: true }],
    ['review obligation security-review', { kind: 'review', by: 'reviewer:r', node: 'n1', attempt: 1, obligation: 'security-review', key: 'k', verdict: 'ok', rank: 1 }],
  ];
  for (const [what, d] of cases) {
    const entries = [...base]; chain(entries, Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined)));
    const e = refusal(entries);
    assert.equal(e.code, 'version', what); assert.equal(e.message, text(base.length, what));
    // The in-process continuation refuses the same way.
    assert.throws(() => reduceFrom(reduce(base, f), entries.slice(base.length), f), (x: unknown) => x instanceof OwedError && x.code === 'version' && x.message === text(base.length, what));
  }
  // Every other invalid entry keeps its current error.
  const bad = [...base]; chain(bad, { ...send, seq: undefined, ts: undefined, prev: undefined, hash: undefined, send: `${send.rid}:follow-up:${base.length}`, message: 'not-a-blob' } as Record<string, unknown>);
  const other = refusal(bad);
  assert.notEqual(other.code, 'version'); assert.match(other.message, new RegExp(`^Entry #${base.length} invalid: .*send message must be a blob hash`));

  // CLI and verify: exit 1 with the text, not "Internal error"/3.
  const root = await mkdtemp(join(tmpdir(), 'owed-ver-')), dir = join(root, 'owed'), prior = process.env.OWED_DIR;
  try {
    const synth = synthLedger(200, 5), entries = [...synth.entries]; chain(entries, { kind: 'teleport', by: 'parent:main' });
    await writeLedgerDir(dir, entries, synth.plans); await mkdir(join(root, 'repo'));
    process.env.OWED_DIR = dir; ops.forgetReplays();
    await assert.rejects(ops.readState({ cwd: root }), (x: unknown) => x instanceof OwedError && x.code === 'version' && x.message === text(synth.entries.length, 'teleport'));
    const status = await cli(root, ['status']);
    assert.equal(status.code, 1, status.stderr); assert.equal(status.stderr.trim(), text(synth.entries.length, 'teleport')); assert.doesNotMatch(status.stderr, /Internal error/);
    const json = await cli(root, ['status', '--json']);
    assert.equal(json.code, 1); assert.deepEqual(JSON.parse(json.stdout), { error: text(synth.entries.length, 'teleport'), code: 'version' });
    const v = await ops.verify({ cwd: root });
    assert.equal(v.ok, false); assert.equal(v.code, 'version', v.error);
    const vc = await cli(root, ['verify']);
    assert.equal(vc.code, 1); assert.match(vc.stdout, /needs a newer owed than/);
  } finally { if (prior === undefined) delete process.env.OWED_DIR; else process.env.OWED_DIR = prior; ops.forgetReplays(); await rm(root, { recursive: true, force: true }); }
});

test('version: every closed entry enum (including Base.channel on all kinds) rejects unknown values and accepts known values', () => {
  const { entries, lookup } = synthLedger(400, 10), base = reduce(entries, frozen(lookup));
  const enums: [string, string, string[]][] = [
    ['send', 'sendKind', ['follow-up', 'steer']],
    ['send', 'reason', ['submit', 'repair', 'interrupted', 'fenced', 'rebase', 'review-missing', 'ruling', 'verdict']],
    ['obs', 'verdict', ['pass', 'fail', 'error']],
    ['review', 'obligation', ['review', 'closure-review', 'approve']],
    ['review', 'verdict', ['ok', 'block']], ['review', 'needs', ['parent']],
    ['launch', 'role', ['writer', 'reviewer']], ['halt', 'needs', ['human', 'owner']],
    ['escape', 'class', ['missing', 'false-pass', 'reuse', 'weak', 'waiver']],
  ];
  // This list mirrors every Entry kind, including owner review/approve and waive (the channel is inherited by all).
  for (const kind of ['genesis', 'plan', 'rule', 'dispatch', 'submit', 'obs', 'review', 'waive', 'defer', 'abandon', 'rebase', 'merge', 'note', 'adopt', 'escape', 'decoy-commit', 'decoy-reveal', 'launch', 'send', 'halt', 'evidence', 'resume']) {
    enums.push([kind, 'channel', ['tty', 'pi-confirm', 'flag', 'delegated']]);
  }
  for (const [kind, field, known] of enums) {
    for (const value of known) assert.equal(R.newerEntry({ kind, [field]: value } as unknown as Entry), undefined, `${kind}.${field}=${value}`);
    const tail: Entry[] = [...entries];
    chain(tail, { kind, by: 'parent:main', [field]: 'guardian-confirm' });
    const expected = `ledger entry #${entries.length} (${kind} ${field} guardian-confirm) needs a newer owed than ${OWED_VERSION}: upgrade owed and restart pi sessions that load it`;
    const version = (e: unknown): boolean => e instanceof OwedError && e.code === 'version' && e.message === expected;
    assert.throws(() => reduce(tail, lookup), version, `${kind}.${field}: full replay`);
    assert.throws(() => reduceFrom(base, tail.slice(entries.length), lookup), version, `${kind}.${field}: resumed replay`);
  }
  // Valid rule channels also replay normally rather than only passing the forward-compatibility gate.
  for (const channel of ['tty', 'pi-confirm', 'flag', 'delegated'] as const) {
    const tail = [...entries]; chain(tail, { kind: 'rule', by: 'parent:main', text: 'known channel', nodes: '*', channel });
    same(reduceFrom(base, tail.slice(entries.length), lookup), reduce(tail, lookup), `valid rule channel ${channel}`);
  }
});

test('timing: a warm disk snapshot of a 10 000-entry ledger loads within 5 s; one appended entry folds onto the in-process cache', { timeout: 600_000 }, async () => {
  const t = await ledgerDir(10_000, 200);
  try {
    assert.equal(t.entries.length, 10_000, 'timing uses a full 10 000-entry benchmark ledger');
    let at = performance.now();
    await ops.readState({ cwd: t.root });
    const cold = performance.now() - at;
    ops.forgetReplays();
    at = performance.now();
    const warm = await ops.readState({ cwd: t.root }), warmMs = performance.now() - at;
    assert.equal(warm.state.seq, t.entries.length - 1);
    await append(t.dir, t.entries, note(1));
    const before = stats();
    at = performance.now();
    const next = await ops.readState({ cwd: t.root }), nextMs = performance.now() - at;
    assert.deepEqual(delta(before, stats()), { full: 0, memo: 1, disk: 0, folded: 1 });
    assert.equal(next.state.seq, t.entries.length - 1);
    console.log(`# timing: cold ${Math.round(cold)} ms, warm disk snapshot ${Math.round(warmMs)} ms, +1 entry in process ${Math.round(nextMs)} ms (${t.entries.length} entries)`);
    assert.ok(warmMs <= 5_000, `warm load took ${Math.round(warmMs)} ms`);
    assert.ok(nextMs <= 5_000, `second load took ${Math.round(nextMs)} ms`);
  } finally { await t.cleanup(); }
});
