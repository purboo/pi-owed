// R-0311-PP-1/2: bounded compatibility and mixed-version cache regressions (<60 s).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { serialize } from 'node:v8';
import { Ledger, SNAPSHOT_FORMAT } from '../src/ledger.ts';
import { OWED_VERSION } from '../src/errors.ts';
import { sha256 } from '../src/canon.ts';
import { quarantineDowngrades } from '../src/plan.ts';
import { effectiveWrites, mergeQueue, reduce, withinWrites } from '../src/reducer.ts';
import type { Draft, Entry, NodeSpec, Plan, State } from '../src/types.ts';

const spec = (id: string, deps: string[] = []): NodeSpec => ({ id, deps, writes: ['first/'], checks: [], review: { count: 0, min_rank: 1 } });
const plan = (nodes: NodeSpec[]): Plan => ({ version: 1, trunk: 'main', closure: [], invariants: [], nodes });
const freeze = <T>(value: T): T => { if (value && typeof value === 'object') { Object.values(value).forEach(freeze); Object.freeze(value); } return value; };
function replay(plans: Record<string, Plan>, drafts: Draft[]): State {
  const entries = drafts.map((d, seq) => ({ ...d, seq, ts: 'fixed', prev: 'x', hash: `hash${seq}` } as Entry));
  return reduce(entries, sha => plans[sha]!);
}
const genesis: Draft = { kind: 'genesis', by: 'owner:pi', channel: 'delegated', plan: 'p', trunk: 'main', commit: 'c', state: { commit: 'c', tree: 't', invKeys: {} } };

test('PP: writes lookup retains first-match and mutable-plan semantics, including removed open slots', () => {
  for (const frozen of [false, true]) {
    const p = plan([spec('a'), { ...spec('a'), writes: ['second/'] }]);
    const s = replay({ p: frozen ? freeze(p) : p }, [genesis]);
    assert.deepEqual(effectiveWrites(s, 'a'), ['first/']);
    assert.equal(withinWrites(s, 'a', 'first/file'), true);
    assert.equal(withinWrites(s, 'a', 'second/file'), false);
    assert.deepEqual(effectiveWrites(s, 'missing'), []);
    if (!frozen) {
      s.plan.nodes[0]!.writes = ['changed/'];
      assert.deepEqual(effectiveWrites(s, 'a'), ['changed/']);
      s.plan.nodes.reverse();
      assert.deepEqual(effectiveWrites(s, 'a'), ['second/']);
    }
  }
  const p = freeze(plan([spec('a')])), gone = freeze(plan([]));
  const s = replay({ p, gone }, [genesis,
    { kind: 'dispatch', by: 'parent:pi', node: 'a', attempt: 1, base: 'c', branch: 'a', worktree: '/a', packet: 'p', rulings_seen: -1 },
    { kind: 'plan', by: 'owner:pi', channel: 'delegated', prior: 'p', plan: 'gone', downgrades: [], note: 'Remove the node while retaining its open-slot writes history' }]);
  assert.equal(s.nodes.a!.phase, 'removed');
  assert.deepEqual(effectiveWrites(s, 'a'), ['first/']);
  assert.equal(withinWrites(s, 'a', 'first/file'), true);
});

test('PP: quarantine lookup keeps the first node and first check, without caching mutable inputs', () => {
  const check = (fix: string) => ({ id: 'q', run: 'true', timeout_s: 10, reads: ['**'], quarantine: [{ test: 'case', fix }] });
  const prev = plan([{ ...spec('a'), checks: [check('fix1'), check('wrong-check')] }, { ...spec('a'), checks: [check('wrong-node')] }]);
  const next = plan([{ ...spec('a'), checks: [check('fix1')] }]);
  assert.deepEqual(quarantineDowngrades(prev, next), []);
  next.nodes[0]!.checks[0]!.quarantine![0]!.fix = 'fix2';
  assert.deepEqual(quarantineDowngrades(prev, next), [{ node: 'a', what: 'check q quarantine "case" fix changed from fix1 to fix2 (owner only)' }]);
  prev.nodes[0]!.checks[0]!.quarantine![0]!.fix = 'fix2';
  assert.deepEqual(quarantineDowngrades(prev, next), []);
  next.nodes.push({ ...spec('new'), checks: [check('fix3')] });
  assert.deepEqual(quarantineDowngrades(prev, next), [{ node: 'new', what: 'check q quarantine "case" added with fix fix3 (owner only)' }]);
});

test('PP: downgrade comparison keeps the first next node', () => {
  const p = plan([spec('a')]), next = plan([spec('a'), { ...spec('a'), review: { count: 0, min_rank: 0 }, writes: ['**'] }]);
  const s = replay({ p, next }, [genesis, { kind: 'plan', by: 'owner:pi', channel: 'delegated', prior: 'p', plan: 'next', downgrades: [] }]);
  assert.deepEqual(s.downgrades, []);
});

// Literal 590bdca query, retained only as a small equivalence oracle.
function oldQueue(s: State): string[] {
  const weight = new Map(s.plan.nodes.map(n => {
    const found = new Set<string>();
    const visit = (id: string): void => { for (const other of s.plan.nodes) if (other.deps.includes(id) && !found.has(other.id)) { found.add(other.id); visit(other.id); } };
    visit(n.id); return [n.id, [...found].filter(id => !s.nodes[id]?.merged).length];
  }));
  return Object.values(s.nodes).filter(n => n.slot?.open && n.phase === 'accepted').sort((a,b) =>
    (weight.get(b.id) ?? 0) - (weight.get(a.id) ?? 0) || (a.acceptedSince ?? Number.MAX_SAFE_INTEGER) - (b.acceptedSince ?? Number.MAX_SAFE_INTEGER) || a.id.localeCompare(b.id)).map(n => n.id);
}
test('PP: eligible-only queue weights equal 590bdca for diamonds, merges, ties, cycles and removed nodes', () => {
  for (let seed = 0; seed < 80; seed++) {
    const nodes = Array.from({ length: 12 }, (_, i) => spec(`n${i}`, Array.from({ length: i }, (_, j) => j).filter(j => (i * 7 + j * 3 + seed) % 5 < 2).map(j => `n${j}`)));
    if (seed % 4 === 0) nodes[0]!.deps = ['n11'];
    const s = reduce([], () => plan([])); s.plan = plan(nodes);
    for (const [i,n] of [...nodes, spec('removed')].entries()) s.nodes[n.id] = {
      id: n.id, phase: i % 3 === seed % 3 ? 'accepted' : 'submitted', items: [], blocks: [], accepted: true, dependents: 0, writers: [], runs: [],
      slot: { open: (i + seed) % 7 !== 0, attempt: 1, base: 'c', branch: n.id, worktree: '/tmp', writer: 'writer:x', dispatchSeq: 1, rulings_seen: -1 },
      ...(i % 4 === 0 ? {} : { acceptedSince: (i + seed) % 3 }),
    };
    // Merged intermediate dependents still lead to unmerged descendants.
    for (const n of Object.values(s.nodes)) if ((Number(n.id.slice(1)) + seed) % 5 === 0) n.merged = { seq: 1, commit: 'c', attempt: 1 } as typeof n.merged;
    assert.deepEqual(mergeQueue(s), oldQueue(s), `seed ${seed}`);
  }
});

async function snapshotFixture(run: (dir: string, version: (v: string) => Promise<Ledger>) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'owed-pp-')), prior = process.env.OWED_DIR;
  process.env.OWED_DIR = dir;
  try {
    await run(dir, async version => { const l = await Ledger.open(dir); Object.defineProperty(l, 'snapshotVersion', { value: version }); return l; });
  } finally { if (prior === undefined) delete process.env.OWED_DIR; else process.env.OWED_DIR = prior; await rm(dir, { recursive: true, force: true }); }
}
test('PP2: alternating versions do not overwrite snapshots; deletion and legacy reads stay version-local', { timeout: 10_000 }, async () => {
  await snapshotFixture(async (dir, version) => {
    const a = await version(OWED_VERSION), b = await version('other/../version%');
    assert.notEqual(a.snapshotFile, b.snapshotFile, '590bdca shared state.v8 overwrites the other version');
    assert.equal(dirname(b.snapshotFile), join(dir, 'snapshot'));
    assert.ok(!basename(b.snapshotFile).includes('/'));
    await mkdir(join(dir, 'snapshot'));
    const payload = Buffer.from('legacy'), old = serialize({ format: SNAPSHOT_FORMAT, version: OWED_VERSION, seq: 0, hash: 'h', digest: sha256(payload), payload });
    await writeFile(join(dir, 'snapshot', 'state.v8'), old);
    assert.equal(await a.readSnapshot(), undefined, 'legacy state.v8 is not read');
    for (let i = 0; i < 4; i++) {
      assert.equal(await a.writeSnapshot(i, 'a', Buffer.from(`a${i}`)), true);
      assert.equal(await b.writeSnapshot(i, 'b', Buffer.from(`b${i}`)), true);
      assert.equal((await a.readSnapshot())?.payload.toString(), `a${i}`);
      assert.equal((await b.readSnapshot())?.payload.toString(), `b${i}`);
    }
    const before = await readFile(b.snapshotFile);
    await a.removeSnapshot();
    assert.equal(await a.readSnapshot(), undefined, 'foreign version is not used as a fallback');
    assert.deepEqual(await readFile(b.snapshotFile), before, 'verify deletion leaves the other version intact');
  });
});

test('PP2: publication keeps the newest three snapshots; failed writes and cleanup are harmless', { timeout: 10_000 }, async () => {
  await snapshotFixture(async (dir, version) => {
    const snapshots = join(dir, 'snapshot'); await mkdir(snapshots);
    for (const [i,name] of ['state.v8', 'state-old1.v8', 'state-old2.v8', 'state-old3.v8'].entries()) {
      const file = join(snapshots,name); await writeFile(file, 'old'); await utimes(file, i + 1, i + 1);
    }
    await writeFile(join(snapshots,'.state.pending.tmp'), 'another writer');
    // A directory masquerading as a cache is not recursively deleted by retention.
    await mkdir(join(snapshots,'state-unremovable.v8'));
    const current = await version(OWED_VERSION);
    assert.equal(await current.writeSnapshot(1, 'h', Buffer.from('current')), true);
    assert.deepEqual((await readdir(snapshots)).sort(), ['.state.pending.tmp', 'state-old2.v8', 'state-old3.v8', 'state-unremovable.v8', basename(current.snapshotFile)].sort());
    assert.equal((await current.readSnapshot())?.payload.toString(), 'current');
    await rm(snapshots, { recursive: true }); await writeFile(snapshots, 'not a directory');
    assert.equal(await current.writeSnapshot(2, 'h', Buffer.from('next')), false);
    assert.equal(await current.readSnapshot(), undefined);
    await current.removeSnapshot();
  });
});
