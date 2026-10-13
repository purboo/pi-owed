import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { serialize, deserialize } from 'node:v8';
import { H } from '../src/canon.ts';
import { Ledger } from '../src/ledger.ts';
import { stateOf } from '../src/drive-run.ts';
import * as ops from '../src/ops.ts';
import { reduce, sameReplay, runId, runLabels } from '../src/reducer.ts';
import type { Draft, Plan } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { synthLedger } from './perf/synth.ts';
import { writeLedgerDir } from './perf/synth-dir.ts';

async function fixture() {
  const r = await repo(), dir = process.env.OWED_DIR!, synth = synthLedger(120, 4);
  await writeLedgerDir(dir, synth.entries, synth.plans);
  // Exercise YAML on the first load, then the actual persistent plan cache.
  await rm(join(dir, 'cache'), { recursive: true, force: true });
  ops.forgetReplays();
  const ledger = await Ledger.open(r.cwd);
  const append = async (drafts: Draft[]) => { synth.entries.push(...await ledger.withLock(() => ledger.append(drafts))); };
  const plan = async (change: (p: Plan) => void) => {
    const prior = synth.entries.findLast(e => e.kind === 'genesis' || e.kind === 'plan')!;
    assert.ok(prior.kind === 'genesis' || prior.kind === 'plan');
    const next = structuredClone(synth.lookup(prior.plan)); change(next);
    const sha = await ledger.putBlob(JSON.stringify(next)); synth.plans.set(sha, next);
    await append([{ kind: 'plan', by: 'parent:test', prior: prior.plan, plan: sha, downgrades: [] }]);
  };
  return { ...r, dir, ledger, ...synth, append, plan, cleanup: async () => { ops.forgetReplays(); await r.cleanup(); } };
}
const stats = () => ({ ...ops.replayStats });
const delta = (before: typeof ops.replayStats) => ({ full: ops.replayStats.full - before.full, memo: ops.replayStats.memo - before.memo, disk: ops.replayStats.disk - before.disk, folded: ops.replayStats.folded - before.folded });
const note = (i: number): Draft => ({ kind: 'note', by: 'parent:test', text: `driver load ${i}` });

test('DL1: driver state equals the full replay on cold, warm and incremental loads', async () => {
  const f = await fixture();
  try {
    const expected = () => reduce(f.entries, f.lookup);
    assert.ok(sameReplay(await stateOf(f.cwd), expected()));
    assert.ok(sameReplay(await stateOf(f.cwd), expected()));
    await f.append([note(0), note(1)]);
    assert.ok(sameReplay(await stateOf(f.cwd), expected()));
    assert.ok(sameReplay(await ops.loadDriverState(f.ledger), expected()));
  } finally { await f.cleanup(); }
});

test('DL2 (#1689): memo hits parse no plans; short increments refold at most 31 old entries and refresh at 32', async t => {
  const f = await fixture();
  try {
    let reads = 0;
    const getBlob = Ledger.prototype.getBlob, getBlobSync = Ledger.prototype.getBlobSync;
    t.mock.method(Ledger.prototype, 'getBlob', function(this: Ledger, sha: string) { reads++; return getBlob.call(this, sha); });
    t.mock.method(Ledger.prototype, 'getBlobSync', function(this: Ledger, sha: string) { reads++; return getBlobSync.call(this, sha); });
    await stateOf(f.cwd); assert.ok(reads > 0, 'cold path parsed YAML blobs');
    reads = 0; let before = stats();
    await stateOf(f.cwd);
    assert.deepEqual(delta(before), { full: 0, memo: 1, disk: 0, folded: 0 }, 'driver must use the ops memo at the same head');
    assert.equal(reads, 0, 'no YAML blob reads, hence no plan parse');
    await f.append(Array.from({ length: 10 }, (_, i) => note(i)));
    before = stats();
    assert.ok(sameReplay(await stateOf(f.cwd), reduce(f.entries, f.lookup)));
    assert.deepEqual(delta(before), { full: 0, memo: 1, disk: 0, folded: 10 });
    assert.equal(reads, 0);
    // #1689: keep MEMO_EVERY=32. Short loads may reuse the previous replay point, not the preceding load's head.
    const memoEvery = 32, refoldBound = memoEvery - 1;
    let pending = 10;
    const sameHead = async () => {
      const before = stats();
      assert.ok(sameReplay(await stateOf(f.cwd), reduce(f.entries, f.lookup)));
      const folded = delta(before).folded;
      assert.deepEqual(delta(before), { full: 0, memo: 1, disk: 0, folded: pending });
      assert.ok(folded <= refoldBound, 'same-head loads refold at most 31 entries');
      assert.equal(reads, 0, 'same-head reload never parses a historical plan');
    };
    await sameHead(); // Same head immediately after +10 may fold those 10 again.
    // Reach exactly 31, then cross 32; repeat a second memo window with consecutive small increments.
    for (const added of [1, 3, 2, 5, 10, 1, 1, 7, 9, 14, 1]) {
      await f.append(Array.from({ length: added }, (_, i) => note(f.entries.length + i)));
      before = stats();
      assert.ok(sameReplay(await stateOf(f.cwd), reduce(f.entries, f.lookup)));
      const folded = delta(before).folded;
      assert.deepEqual(delta(before), { full: 0, memo: 1, disk: 0, folded: pending + added });
      assert.ok(folded <= added + refoldBound, 'consecutive loads fold new entries plus at most 31 old ones');
      assert.equal(reads, 0, 'small increments parse no historical plans');
      pending = folded >= memoEvery ? 0 : folded;
      await sameHead(); // Crossing MEMO_EVERY must advance the replay point: folded=0.
    }
    assert.equal(pending, 0, 'the final increment crosses the second memo refresh boundary');
  } finally { await f.cleanup(); }
});

test('DL2: a fresh process resumes the disk snapshot with persistent plans and no historical YAML parses', async () => {
  const f = await fixture();
  try {
    const first = await stateOf(f.cwd);
    assert.ok(await f.ledger.readSnapshot(), 'driver published a snapshot');
    const module = (path: string) => JSON.stringify(fileURLToPath(new URL(path, import.meta.url)));
    const script = `
      const {Ledger} = await import(${module('../src/ledger.ts')});
      const ops = await import(${module('../src/ops.ts')});
      const {stateOf} = await import(${module('../src/drive-run.ts')});
      Ledger.prototype.getBlob = async () => { throw new Error('historical YAML read'); };
      Ledger.prototype.getBlobSync = () => { throw new Error('historical YAML read'); };
      const s = await stateOf(${JSON.stringify(f.cwd)});
      console.log(JSON.stringify({head:s.head, nodes:Object.keys(s.nodes), stats:ops.replayStats}));
    `;
    const { stdout } = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { env: { ...process.env }, timeout: 30_000, maxBuffer: 1024 * 1024 });
    const result = JSON.parse(stdout);
    assert.equal(result.head, first.head); assert.deepEqual(result.nodes, Object.keys(first.nodes));
    assert.deepEqual({ full: result.stats.full, disk: result.stats.disk, folded: result.stats.folded }, { full: 0, disk: 1, folded: 0 });
  } finally { await f.cleanup(); }
});

test('DL3: report overlays and driver mutations never leak to another load, the memo or the disk snapshot', async () => {
  const f = await fixture();
  try {
    await f.plan(p => { p.nodes.push({ id: 'reporter', title: 'report fixture', deps: [], writes: ['report/'], checks: [], review: { count: 0, min_rank: 1 } }); });
    const base = reduce(f.entries, f.lookup).trunk.commit, project = f.entries[0]!.hash.slice(0, 12), rid = runId(project, 'reporter', 1, 'writer');
    await f.append([
      { kind: 'dispatch', by: 'parent:test', node: 'reporter', attempt: 1, base, branch: 'reporter-1', worktree: join(f.root, 'slot'), packet: H('packet'), rulings_seen: -1 },
      { kind: 'launch', by: 'parent:drive', node: 'reporter', attempt: 1, role: 'writer', rid, spec: H('spec'), labels: runLabels(project, 'reporter', 1, 'writer') },
      { kind: 'resume', by: 'parent:test', node: 'reporter', attempt: 1, expect: 'report' },
    ]);
    const resume = f.entries.at(-1)!.seq;
    await f.append([{ kind: 'send', by: 'parent:drive', node: 'reporter', attempt: 1, rid, send: `${rid}:follow-up:${f.entries.length}`, sendKind: 'follow-up', message: H('report'), reason: 'report' }]);
    await stateOf(f.cwd); // Memo/snapshot precede the runtime overlay.
    await ops.recordReport(f.ledger, 'reporter', resume);
    const first = await stateOf(f.cwd), expected = reduce(f.entries, f.lookup);
    await ops.applyReports(f.ledger, expected);
    assert.ok(sameReplay(first, expected)); assert.equal(first.nodes.reporter!.reported, resume);
    const held = await stateOf(f.cwd);
    first.nodes.reporter!.reported = -1; first.nodes.n0!.writers.push('writer:intruder'); first.rules.length = 0;
    assert.ok(Object.isFrozen(first.plan)); assert.ok(Object.isFrozen(first.plan.nodes));
    assert.throws(() => { first.plan.nodes[0]!.title = 'mutated'; }, TypeError);
    assert.ok(sameReplay(held, expected)); assert.ok(sameReplay(await stateOf(f.cwd), expected));
    assert.ok(sameReplay((await ops.readState({ cwd: f.cwd })).state, reduce(f.entries, f.lookup)), 'memo excludes reported overlay');
    const reports = join(f.dir, 'drive', 'reports.json');
    for (const content of ['{"reporter":-1}', 'broken JSON']) {
      await writeFile(reports, content);
      assert.ok(sameReplay(await stateOf(f.cwd), reduce(f.entries, f.lookup)), 'reported comes only from a valid current receipt');
    }
    await rm(reports); ops.forgetReplays();
    assert.ok(sameReplay(await stateOf(f.cwd), reduce(f.entries, f.lookup)), 'disk snapshot excludes overlay and mutations');
    assert.equal(held.nodes.reporter!.reported, resume, 'later loads do not mutate a held result');
  } finally { await f.cleanup(); }
});

test('DL4: corrupt or mismatching disk snapshots fall back to the same full replay', async () => {
  const f = await fixture();
  try {
    const expected = reduce(f.entries, f.lookup);
    await stateOf(f.cwd);
    const good = await readFile(f.ledger.snapshotFile), outer = deserialize(good);
    for (const bytes of [Buffer.from('bad snapshot'), serialize({ ...outer, hash: 'f'.repeat(64) }), serialize({ ...outer, payload: Buffer.from('bad payload') })]) {
      await writeFile(f.ledger.snapshotFile, bytes); ops.forgetReplays(); const before = stats();
      assert.ok(sameReplay(await stateOf(f.cwd), expected));
      assert.deepEqual(delta(before), { full: 1, memo: 0, disk: 0, folded: f.entries.length });
      assert.equal((await f.ledger.readSnapshot())?.hash, expected.head);
    }
  } finally { await f.cleanup(); }
});

test('DL4: every load verifies the ledger even with a matching memo and disk snapshot', async () => {
  const f = await fixture();
  try {
    await stateOf(f.cwd);
    const forged = structuredClone(f.entries); (forged.at(-1)! as { text?: string }).text = 'tampered';
    await writeFile(join(f.dir, 'ledger.jsonl'), forged.map(e => JSON.stringify(e) + '\n').join(''));
    await assert.rejects(stateOf(f.cwd), /ledger seq .*hash/i);
    ops.forgetReplays(); await assert.rejects(stateOf(f.cwd), /ledger seq .*hash/i);
  } finally { await f.cleanup(); }
});

test('DL4: a newly appended plan is parsed and applied; an empty ledger keeps the not-initialized refusal', async () => {
  const f = await fixture();
  try {
    const old = await stateOf(f.cwd);
    await f.plan(p => { p.nodes.push({ id: 'newnode', title: 'new plan', deps: [], writes: ['new/'], checks: [], review: { count: 0, min_rank: 1 } }); });
    const before = stats(), latest = await stateOf(f.cwd);
    assert.equal(latest.nodes.newnode!.phase, 'ready'); assert.equal(old.nodes.newnode, undefined);
    assert.ok(sameReplay(latest, reduce(f.entries, f.lookup)));
    assert.deepEqual(delta(before), { full: 0, memo: 1, disk: 0, folded: 1 });
    await writeFile(join(f.dir, 'ledger.jsonl'), '');
    await assert.rejects(stateOf(f.cwd), /Not initialized: run owed init <plan.yaml> first/);
    await assert.rejects(ops.loadDriverState(f.ledger), /Not initialized: run owed init <plan.yaml> first/);
  } finally { await f.cleanup(); }
});
