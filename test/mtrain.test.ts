// MT (0.21): batch merge (merge train): `drive.merge_batch`, `owed merge A,B,...` and the driver.
import test from 'node:test';
import assert from 'node:assert/strict';
import { access, chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ops from '../src/ops.ts';
import * as reducer from '../src/reducer.ts';
import { parsePlan } from '../src/plan.ts';
import { Ledger } from '../src/ledger.ts';
import { Dsa } from '../src/dsa.ts';
import { drive } from '../src/drive-run.ts';
import { git, revParse } from '../src/git.ts';
import type { Entry, Plan } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt, identity } from './helpers/surface.ts';

const parent = { role: 'parent', id: 'test' } as const, owner = { role: 'owner', id: 'human' } as const;
type Repo = Awaited<ReturnType<typeof repo>>;
type Obs = Extract<Entry, { kind: 'obs' }>;
type Merge = Extract<Entry, { kind: 'merge' }>;

/** An invariant that counts its runs in `<root>/inv.count` and fails when the tree has `a.txt` and `b.txt` together (`clash`). */
const inv = (r: Repo, clash = false, slow = false) => {
  const f = (n: string) => `'${join(r.root, n)}'`;
  const wait = slow ? `if test -e a.txt && test -e b.txt; then touch ${f('started')}; for n in $(seq 1 1500); do test -e ${f('release')} && break; sleep .02; done; fi; ` : '';
  return { id: 'inv', timeout_s: 60, run: `echo x >> ${f('inv.count')}; ${wait}${clash ? 'if test -e a.txt && test -e b.txt; then exit 1; fi; ' : ''}echo '# tests 1'; echo '# pass 1'` };
};
const node = (id: string, o: Record<string, unknown> = {}) => ({ id, writes: [`${id}.txt`], checks: [{ id, run: `test -f ${id}.txt`, reads: ['*.txt'] }], ...o });
const planOf = (invs: object[], nodes: object[], batch?: number) => ({ version: 1, trunk: 'main', invariants: invs, nodes, ...(batch ? { drive: { merge_batch: batch } } : {}) });
const runs = async (r: Repo) => { try { return (await readFile(join(r.root, 'inv.count'), 'utf8')).split('\n').filter(Boolean).length; } catch { return 0; } };
async function accept(r: Repo, id: string, files: Record<string, string> = { [`${id}.txt`]: id }, must = true) {
  const d = await ops.dispatch({ cwd: r.cwd, node: id, as: parent, allowOverlap: true }); await commitAt(d.worktree, files);
  await ops.submit({ cwd: d.worktree, node: id, as: { role: 'writer', id: `${id}#1` } });
  const accepted = (await ops.attest({ cwd: r.cwd, node: id })).accepted;
  if (must) assert.equal(accepted, true, `${id} accepted`);
}
async function setup(r: Repo, plan: object, accepted: string[]) {
  await commitAt(r.cwd, { README: 'x' });
  await ops.init({ cwd: r.cwd, plan: JSON.stringify(plan), as: owner, channel: 'flag' });
  for (const id of accepted) await accept(r, id);
}
const entries = async (r: Repo) => (await Ledger.open(r.cwd)).read();
const reflog = async (r: Repo) => (await git(r.cwd, ['reflog', 'show', '--format=%H', 'refs/heads/main'])).stdout.split('\n').filter(Boolean);

test('MT1: drive.merge_batch is an integer 1..8 and never part of a key', () => {
  const base = planOf([], [node('a')]);
  assert.equal(parsePlan(JSON.stringify(planOf([], [node('a')], 3))).drive?.merge_batch, 3);
  for (const bad of [0, 9, 2.5, '2']) assert.throws(() => parsePlan(JSON.stringify({ ...base, drive: { merge_batch: bad } })), /drive\.merge_batch: expected integer 1\.\.8/);
  assert.equal(parsePlan(JSON.stringify({ ...base, drive: { max: 2 } })).drive?.merge_batch, undefined, 'absent unless set');
});

test('MT2/MT3/MT6: a batch of 3 measures every invariant once on Mn, appends one merge per member and advances trunk once', { timeout: 180_000 }, async () => {
  const r = await repo();
  try {
    await setup(r, planOf([inv(r)], [node('a'), node('b'), node('c')], 3), ['a', 'b', 'c']);
    const st = await ops.status({ cwd: r.cwd });
    assert.deepEqual(st.mergeBatch, ['a', 'b', 'c']);
    const full = await cli(r.cwd, ['status', '--full']); assert.equal(full.code, 0, full.stderr);
    assert.match(full.stdout, /^Merge queue: a, b, c; batch of 3: a, b, c$/m);
    const before = await entries(r), invRuns = await runs(r), trunk = st.trunk.commit, log = await reflog(r);
    const res = await cli(r.cwd, ['merge', 'a,b,c', '--as', 'parent:test']);
    assert.equal(res.code, 0, res.stderr);
    assert.match(res.stdout, /^Batch of 3: a, b, c$/m);
    for (const id of ['a', 'b', 'c']) assert.match(res.stdout, new RegExp(`^${id} merged \\([0-9a-f]{12}\\); measured \\d+, waived 0, debt 0$`, 'm'));
    const added = (await entries(r)).slice(before.length);
    assert.deepEqual(added.map(e => e.kind === 'obs' ? `obs ${e.subject}/${e.obligation}` : `${e.kind} ${'node' in e ? e.node : ''}`),
      ['obs a/check:a', 'obs b/check:b', 'obs c/check:c', 'obs trunk/inv:inv', 'merge a', 'merge b', 'merge c']);
    assert.equal(await runs(r), invRuns + 1, 'the invariant ran once, on the batch tree');
    const merges = added.filter((e): e is Merge => e.kind === 'merge'), final = merges[2]!.commit;
    for (const o of added.filter((e): e is Obs => e.kind === 'obs')) {
      assert.equal(o.commit, final, 'measured on Mn'); assert.equal(o.merging, undefined); assert.deepEqual(o.batch, ['a', 'b', 'c']); assert.equal(o.verdict, 'pass');
    }
    assert.equal(merges[0]!.prior, trunk); assert.equal(merges[1]!.prior, merges[0]!.commit); assert.equal(merges[2]!.prior, merges[1]!.commit);
    for (const m of merges) { assert.equal(m.batch?.final, final); assert.deepEqual(m.batch?.members, ['a', 'b', 'c']); assert.deepEqual(m.batch?.state, merges[2]!.state); }
    assert.deepEqual(merges[0]!.facts.changed, ['a.txt']); assert.deepEqual(merges[1]!.facts.changed, ['b.txt']);
    assert.equal(merges[1]!.batch!.keys.b!['check:b'], (added[1] as Obs).key, 'member keys on Mn are the measured keys');
    for (const m of merges) assert.deepEqual(m.batch, merges[0]!.batch, 'one identical batch object on every member entry');
    assert.equal(await revParse(r.cwd, 'refs/heads/main'), final);
    const now = await reflog(r);
    assert.equal(now.length, log.length + 1, 'one trunk move'); assert.equal(now[0], final);
    const s = await ops.status({ cwd: r.cwd });
    for (const id of ['a', 'b', 'c']) assert.equal(s.nodes[id]!.phase, 'merged');
    assert.equal(s.trunk.commit, final); assert.equal(s.mergeBatch, undefined);
    assert.equal((await ops.verify({ cwd: r.cwd })).ok, true);
    // Replay: full and incremental agree; a merge entry stripped of its batch field is refused (older owed misjudges it).
    const all = await entries(r), ledger = await Ledger.open(r.cwd), plans = new Map<string, Plan>();
    for (const e of all) if (e.kind === 'genesis' || e.kind === 'plan') plans.set(e.plan, parsePlan((await ledger.getBlob(e.plan)).toString()));
    const lookup = (sha: string) => plans.get(sha)!, at = all.findIndex(e => e.kind === 'merge' && e.node === 'b');
    let inc = reducer.reduce(all.slice(0, 1), lookup);
    for (const e of all.slice(1)) inc = reducer.reduceFrom(inc, [e], lookup);
    assert.ok(reducer.sameReplay(inc, reducer.reduce(all, lookup)));
    const pre = reducer.reduce(all.slice(0, at), lookup), { seq, ts, prev, hash, batch, ...draft } = all[at] as Merge;
    assert.ok(seq && ts && prev && hash && batch);
    assert.deepEqual(reducer.validateDraft(pre, { ...draft, batch } as never), []);
    assert.ok(reducer.validateDraft(pre, draft as never).some(x => /check:b|inv/.test(x)), 'without batch the guard judges the unmeasured intermediate tree');
    assert.ok(reducer.validateDraft(pre, { ...draft, batch: { ...batch, keys: {} } } as never).length > 0, 'batch keys must name measured keys');
    // Ruling #2110: consecutive entries in members order with an identical batch object.
    assert.ok(reducer.validateDraft(pre, { ...draft, batch: { ...batch, members: ['b', 'a', 'c'] } } as never).some(x => /incomplete/.test(x)), 'members order');
    assert.ok(reducer.validateDraft(pre, { ...draft, batch: { ...batch, keys: { ...batch.keys, c: {} } } } as never).some(x => /incomplete/.test(x)), 'identical batch object');
    assert.ok(reducer.validateDraft(pre, { kind: 'note', by: 'parent:test', text: 'between' } as never).some(x => /batch merge of a, b, c is incomplete \(#\d+ merged a\): only the merge of b/.test(x)), 'nothing else between members');
    const first = all.findIndex(e => e.kind === 'merge' && e.node === 'a'), { seq: _s, ts: _t, prev: _p, hash: _h, ...draftC } = all[at + 1] as Merge;
    assert.ok(reducer.validateDraft(reducer.reduce(all.slice(0, first), lookup), draftC as never).some(x => /must start with the first member a/.test(x)), 'a batch starts with its first member');
  } finally { await r.cleanup(); }
});

test('MT2: a member that conflicts drops out; the rest merge as a batch; the dropped one merges alone later', { timeout: 180_000 }, async () => {
  const r = await repo();
  try {
    await setup(r, planOf([inv(r)], [node('a'), node('b'), node('c')]), ['a', 'b', 'c']);
    assert.equal((await ops.status({ cwd: r.cwd })).mergeBatch, undefined, 'no batch planned without drive.merge_batch');
    await commitAt(r.cwd, { 'c.txt': 'trunk' });
    await ops.adopt({ cwd: r.cwd, as: owner, channel: 'flag', note: 'hotfix touching c.txt' });
    const res = await ops.mergeBatch({ cwd: r.cwd, as: parent, nodes: ['c', 'b', 'a'] });
    assert.deepEqual(res.nodes, ['a', 'b']); assert.deepEqual(res.dropped, ['c']);
    const s = await ops.status({ cwd: r.cwd });
    assert.equal(s.nodes.a!.phase, 'merged'); assert.equal(s.nodes.b!.phase, 'merged'); assert.equal(s.nodes.c!.phase, 'accepted');
    await assert.rejects(ops.merge({ cwd: r.cwd, as: parent, node: 'c' }), /rebase needed: run owed rebase c/);
    assert.equal((await ops.verify({ cwd: r.cwd })).ok, true);
  } finally { await r.cleanup(); }
});

test('MT4: a batch invariant fail is recorded unattributed, refused, not batched again on this trunk; a single merge measures its own tree', { timeout: 180_000 }, async () => {
  const r = await repo();
  try {
    await setup(r, planOf([inv(r, true)], [node('a'), node('b')], 2), ['a', 'b']);
    assert.deepEqual((await ops.status({ cwd: r.cwd })).mergeBatch, ['a', 'b']);
    const before = await entries(r), trunk = (await ops.status({ cwd: r.cwd })).trunk.commit;
    await assert.rejects(ops.mergeBatch({ cwd: r.cwd, as: parent, nodes: ['a', 'b'] }), (e: Error) => {
      assert.match(e.message, /^batch merge of a, b refused on batch tree [0-9a-f]{12}: trunk\/inv:inv: [\s\S]*; the members merge one at a time next \(owed merge a\)$/);
      return true;
    });
    const added = (await entries(r)).slice(before.length) as Obs[];
    assert.ok(added.every(e => e.kind === 'obs' && e.merging === undefined && e.batch?.join() === 'a,b'));
    assert.equal(added.find(e => e.obligation === 'inv:inv')?.verdict, 'fail');
    let s = await ops.status({ cwd: r.cwd });
    assert.equal(s.trunk.commit, trunk); assert.equal(await revParse(r.cwd, 'refs/heads/main'), trunk);
    assert.ok(s.nodes.a!.accepted && s.nodes.b!.accepted, 'no member is blocked by the batch failure');
    assert.deepEqual(s.nodes.a!.blocks, []); assert.deepEqual(s.nodes.b!.blocks, []);
    assert.equal(s.mergeBatch, undefined, 'the failed set is not planned again until trunk moves');
    await assert.rejects(ops.mergeBatch({ cwd: r.cwd, as: parent, nodes: ['a', 'b'] }), /batch merge of a, b already failed on trunk/);
    await ops.merge({ cwd: r.cwd, as: parent, node: 'a' });
    // Ruling #2110: T+a+b has the batch tree's content (same key), yet b's single merge measures its own tree with merging.
    const mid = (await entries(r)).length, invRuns = await runs(r);
    await assert.rejects(ops.merge({ cwd: r.cwd, as: parent, node: 'b' }), /invariant inv new debt/);
    const own = (await entries(r)).slice(mid).filter((e): e is Obs => e.kind === 'obs' && e.obligation === 'inv:inv');
    assert.equal(await runs(r), invRuns + 1, 'measured again on the single-member tree');
    assert.deepEqual(own.map(e => [e.merging, e.batch, e.verdict, e.key]), [['b', undefined, 'fail', added.find(e => e.obligation === 'inv:inv')!.key]]);
    s = await ops.status({ cwd: r.cwd });
    assert.equal(s.nodes.a!.phase, 'merged');
    assert.equal((await ops.verify({ cwd: r.cwd })).ok, true);
  } finally { await r.cleanup(); }
});

test('MT1: overlapping writes, closure-touching and owner-approval members are never batched', { timeout: 180_000 }, async () => {
  const r = await repo();
  try {
    const nodes = [node('a', { writes: ['shared/', 'a.txt'] }), node('b', { writes: ['shared/x', 'b.txt'] }), node('c'), node('d', { approve: 'owner' }), node('e', { writes: ['ci/', 'e.txt'] })];
    await setup(r, { ...planOf([inv(r)], nodes, 4), closure: ['ci/'] }, ['a', 'b', 'c']);
    await accept(r, 'd', undefined, false);
    await assert.rejects(ops.mergeBatch({ cwd: r.cwd, as: parent, nodes: ['d', 'c'] }), /^OwedError: batch merge refused: d needs owner approval; merge it alone: owed merge d$/);
    await ops.approve({ cwd: r.cwd, as: owner, channel: 'flag', node: 'd' });
    await accept(r, 'e', { 'e.txt': 'e', 'ci/x': 'x' }, false);
    await ops.review({ cwd: r.cwd, as: owner, channel: 'flag', node: 'e', verdict: 'ok', rank: 3, note: 'closure ok', obligation: 'closure-review' });
    const s = (await ops.readState({ cwd: r.cwd })).state;
    assert.deepEqual(['a', 'b', 'c', 'd', 'e'].map(id => s.nodes[id]!.accepted), [true, true, true, true, true]);
    assert.deepEqual(['a', 'b', 'c', 'd', 'e'].map(id => reducer.batchable(s, id)), [true, true, true, true, false], 'd is approved (no longer pending); e touches the closure');
    assert.deepEqual((await ops.status({ cwd: r.cwd })).mergeBatch, ['a', 'c', 'd'], 'b overlaps a and is skipped; e is never batched');
    assert.equal(reducer.mergeBatchPlan(s, 4, ['b', 'a', 'c', 'e', 'd']).join(), 'b,c,d');
    assert.equal(reducer.mergeBatchPlan(s, 2, ['a', 'c', 'd']).join(), 'a,c', 'at most merge_batch members');
    assert.equal(reducer.mergeBatchPlan(s, 4, ['e', 'a', 'c']).join(), '', 'a head that cannot be batched merges alone first');
    await assert.rejects(ops.mergeBatch({ cwd: r.cwd, as: parent, nodes: ['a', 'b'] }), /^OwedError: batch merge refused: writes of a and b overlap; merge them one at a time$/);
    await assert.rejects(ops.mergeBatch({ cwd: r.cwd, as: parent, nodes: ['a', 'e'] }), /^OwedError: batch merge refused: e touches the closure; merge it alone: owed merge e$/);
  } finally { await r.cleanup(); }
});

test('MT3: trunk moved during the batch measurement: refused (CAS), nothing recorded', { timeout: 180_000 }, async () => {
  const r = await repo();
  try {
    await setup(r, planOf([inv(r, false, true)], [node('a'), node('b')], 2), ['a', 'b']);
    const before = await entries(r);
    const outcome = ops.mergeBatch({ cwd: r.cwd, as: parent, nodes: ['a', 'b'] }).then(() => undefined, (e: unknown) => e);
    try {
      let seen = false;
      for (let i = 0; i < 1500 && !seen; i++) { try { await access(join(r.root, 'started')); seen = true; } catch { await new Promise(res => setTimeout(res, 20)); } }
      assert.ok(seen, 'the invariant runs on the batch tree');
      await commitAt(r.cwd, { external: 'move trunk' });
    } finally { await writeFile(join(r.root, 'release'), ''); }
    assert.match(String(await outcome), /trunk changed \(CAS\)/);
    assert.deepEqual(await entries(r), before, 'nothing recorded');
    const s = await ops.status({ cwd: r.cwd });
    assert.ok(s.nodes.a!.accepted && s.nodes.b!.accepted);
  } finally { await r.cleanup(); }
});

test('MT4 ruling #2110: a batch check failure is never reused by a single merge: the member gets the block as in 0.20', { timeout: 180_000 }, async () => {
  const r = await repo();
  try {
    const b = node('b', { checks: [{ id: 'b', run: 'test -f b.txt && ! test -e a.txt', reads: ['*.txt'] }] });
    await setup(r, planOf([inv(r)], [node('a'), b], 2), ['a', 'b']);
    await assert.rejects(ops.mergeBatch({ cwd: r.cwd, as: parent, nodes: ['a', 'b'] }), /refused on batch tree [0-9a-f]{12}: b\/check:b/);
    const batchFail = (await entries(r)).findLast((e): e is Obs => e.kind === 'obs' && e.obligation === 'check:b')!;
    assert.deepEqual(batchFail.batch, ['a', 'b']); assert.deepEqual((await ops.status({ cwd: r.cwd })).nodes.b!.blocks, []);
    await ops.merge({ cwd: r.cwd, as: parent, node: 'a' });
    await assert.rejects(ops.merge({ cwd: r.cwd, as: parent, node: 'b' }));
    const single = (await entries(r)).findLast((e): e is Obs => e.kind === 'obs' && e.obligation === 'check:b' && e.merging === 'b')!;
    assert.ok(single.seq > batchFail.seq && single.key === batchFail.key && single.merging === 'b' && single.batch === undefined && single.verdict === 'fail', JSON.stringify([single, batchFail]));
    const s = await ops.status({ cwd: r.cwd });
    assert.deepEqual(s.nodes.b!.blocks.map(x => [x.seq, x.kind, x.state]), [[single.seq, 'exec', 'active']], 'the single-member failure blocks b');
    assert.equal(s.nodes.b!.accepted, false);
    assert.equal((await ops.verify({ cwd: r.cwd })).ok, true);
  } finally { await r.cleanup(); }
});

test('MT3 ruling #2110: a torn batch tail is reported by verify and completed by the next owed write when trunk is at batch.final', { timeout: 180_000 }, async () => {
  const r = await repo();
  try {
    await setup(r, planOf([inv(r)], [node('a'), node('b'), node('c')], 3), ['a', 'b', 'c']);
    await ops.mergeBatch({ cwd: r.cwd, as: parent, nodes: ['a', 'b', 'c'] });
    const ledger = await Ledger.open(r.cwd), file = join(ledger.dir, 'ledger.jsonl'), text = await readFile(file, 'utf8');
    const lines = text.split('\n').filter(Boolean), last = JSON.parse(lines.at(-1)!) as Merge;
    assert.equal(last.node, 'c');
    // Crash after member b's entry: drop c's entry (and any replay snapshot of the full ledger).
    await writeFile(file, lines.slice(0, -1).join('\n') + '\n'); await rm(join(ledger.dir, 'snapshot'), { recursive: true, force: true });
    const v = await ops.verify({ cwd: r.cwd });
    assert.equal(v.ok, true);
    assert.equal(v.incompleteBatch, `batch merge of a, b, c is incomplete after #${last.seq - 1} (b); missing: c; restore refs/heads/main to ${last.commit} (e.g. from the reflog: git update-ref refs/heads/main ${last.commit}), then any owed write completes the batch; if trunk history no longer contains the batch commits, the ledger tail and trunk disagree and need manual repair`);
    const out = await cli(r.cwd, ['verify']); assert.equal(out.code, 0, out.stderr); assert.match(out.stdout, /^incompleteBatch: batch merge of a, b, c is incomplete/m);
    // Trunk not at batch.final: nothing else may be written.
    await git(r.cwd, ['update-ref', 'refs/heads/main', last.prior]);
    await assert.rejects(ops.rule({ cwd: r.cwd, as: parent, text: 'note', nodes: '*' }), /batch merge of a, b, c is incomplete \(#\d+ merged b\): only the merge of c/);
    await git(r.cwd, ['update-ref', 'refs/heads/main', last.commit]);
    const ruled = await ops.rule({ cwd: r.cwd, as: parent, text: 'note', nodes: '*' });
    const now = await entries(r), c = now[last.seq] as Merge;
    assert.equal(c.kind, 'merge'); assert.equal(c.node, 'c'); assert.equal(c.by, 'executor:owed');
    assert.equal(c.commit, last.commit); assert.equal(c.prior, last.prior); assert.deepEqual(c.batch, last.batch); assert.deepEqual(c.facts, last.facts); assert.deepEqual(c.state, last.state);
    assert.equal(ruled.seq, last.seq + 1);
    const after = await ops.verify({ cwd: r.cwd }); assert.equal(after.ok, true); assert.equal(after.incompleteBatch, undefined);
    assert.equal((await ops.status({ cwd: r.cwd })).nodes.c!.phase, 'merged');
  } finally { await r.cleanup(); }
});

// ---------- driver ----------
const FAKE = fileURLToPath(new URL('./fixtures/fake-dsa.mjs', import.meta.url));
const OWED = fileURLToPath(new URL('../bin/owed.js', import.meta.url));
const plain = (id: string) => ({ id, writes: [`${id}.txt`], checks: [], review: { count: 0, min_rank: 1 } });
async function rig(planFor: (r: Repo) => object, ids: string[]) {
  const r = await repo(), plan = planFor(r);
  const dir = join(r.root, 'dsa'), bin = join(r.root, 'bin');
  await mkdir(join(dir, 'agents'), { recursive: true }); await mkdir(bin);
  await writeFile(join(bin, 'owed'), `#!/bin/sh\nexec "${process.execPath}" "${OWED}" "$@"\n`); await chmod(join(bin, 'owed'), 0o755);
  const env = { FAKE_DSA_DIR: dir, PATH: `${bin}:${process.env.PATH}`, ...identity };
  await r.put('README', 'x\n'); await r.commit();
  await ops.init({ cwd: r.cwd, as: owner, channel: 'flag', plan: JSON.stringify(plan) });
  for (const id of ids) await writeFile(join(dir, 'agents', `${id}-writer.sh`), `set -e\necho ${id} > ${id}.txt; git add ${id}.txt; git commit -qm ${id}; owed submit ${id}\n`);
  const dsa = new Dsa({ bin: FAKE, env, timeoutMs: 120_000 }), out: string[] = [];
  return { ...r, out, async passes(n: number, done: (es: Entry[]) => boolean) {
    for (let i = 0; i < n && !done(await entries(r)); i++) await drive({ cwd: r.cwd, once: true, dsa, log: l => out.push(l), pollMs: 50, passMs: 300, handleSignals: false });
    return done(await entries(r));
  } };
}

test('MT1/MT3 driver: with drive.merge_batch 3 the driver merges three accepted nodes as one batch', { timeout: 300_000 }, async () => {
  const f = await rig(r => ({ version: 1, trunk: 'main', closure: [], invariants: [inv(r)], nodes: [plain('a'), plain('b'), plain('c')], drive: { merge_batch: 3, measure: 3 } }), ['a', 'b', 'c']);
  try {
    const done = (es: Entry[]) => ['a', 'b', 'c'].every(id => es.some(e => e.kind === 'merge' && e.node === id));
    assert.ok(await f.passes(12, done), f.out.join('\n'));
    const merges = (await entries(f)).filter((e): e is Merge => e.kind === 'merge'), members = merges[0]?.batch?.members ?? [];
    assert.deepEqual([...members].sort(), ['a', 'b', 'c'], f.out.join('\n'));
    assert.deepEqual(merges.map(m => [m.node, m.batch?.members.join()]), members.map(id => [id, members.join()]));
    assert.ok(f.out.includes(`merge ${members[0]}: started — batch of 3: ${members.join(', ')}`), f.out.join('\n'));
    assert.equal((await entries(f)).filter(e => e.kind === 'halt').length, 0);
  } finally { await f.cleanup(); }
});

test('MT4 driver: a failed batch is reported as a retry, then members merge one at a time and a single failure halts as now', { timeout: 300_000 }, async () => {
  const f = await rig(r => ({ version: 1, trunk: 'main', closure: [], invariants: [inv(r, true)], nodes: [plain('a'), plain('b')], drive: { merge_batch: 2, measure: 2 } }), ['a', 'b']);
  try {
    const halted = (es: Entry[]) => es.some(e => e.kind === 'halt');
    assert.ok(await f.passes(12, halted), f.out.join('\n'));
    const es = await entries(f), text = f.out.join('\n');
    const failed = es.find((e): e is Obs => e.kind === 'obs' && e.obligation === 'inv:inv' && e.verdict === 'fail' && e.batch !== undefined)!;
    assert.ok(failed && failed.merging === undefined, text);
    const [first, second] = failed.batch!;
    assert.match(text, new RegExp(`merge ${first}: retry — batch merge refused \\(batch merge of ${first}, ${second} refused on batch tree [0-9a-f]{12}: trunk/inv:inv`));
    const merges = es.filter((e): e is Merge => e.kind === 'merge');
    assert.deepEqual(merges.map(m => [m.node, m.batch]), [[first, undefined]], 'the queue head merges alone first');
    assert.ok(es.some(e => e.kind === 'obs' && e.obligation === 'inv:inv' && e.verdict === 'fail' && e.merging === second && e.batch === undefined && e.key === failed.key), 'the single merge measures its own tree (ruling #2110)');
    assert.equal(es.filter(e => e.kind === 'halt').map(e => 'node' in e ? e.node : '').join(), second);
  } finally { await f.cleanup(); }
});
