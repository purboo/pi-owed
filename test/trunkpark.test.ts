import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { parsePlan } from '../src/plan.ts';
import * as reducer from '../src/reducer.ts';
import { decide, type DriveOpts } from '../src/drive.ts';
import { driveOnce, drive } from '../src/drive-run.ts';
import { Dsa } from '../src/dsa.ts';
import { Follower, classifyLine } from '../src/drive-bg.ts';
import { renderStatus, renderBrief } from '../src/views.ts';
import { repo } from './helpers/repo.ts';
import { commitAt, identity } from './helpers/surface.ts';
import type { ObsEntry } from '../src/types.ts';

const { reduce, attestJobs, trunkParked, trunkParkNotices } = reducer;
const owner = { role: 'owner', id: 'pi' } as const;
const parent = { role: 'parent', id: 'test' } as const;
const FAKE = fileURLToPath(new URL('./fixtures/fake-dsa.mjs', import.meta.url));
const options = (root: string): DriveOpts => ({ max: 2, repairs: 2, project: 'fixture', root, applied: new Set(), rejected: new Map() });
async function fixture(ids = ['a', 'b'], launch = false, failedByNode: Record<string, string[]> = {}) {
  const r = await repo();
  try {
    await commitAt(r.cwd, { flag: 'clean', ...Object.fromEntries(ids.map(id => [`${id}.txt`, 'base'])) });
    const check = { id: 'runtime', run: `if grep -q broken flag; then echo 'owed-counts {"pass":0,"fail":4,"failed":["old bug","b bug","c bug","d bug"]}'; exit 1; else echo 'owed-counts {"pass":4,"fail":0}'; fi`, reads: ['flag'], min_tests: 1 };
    const plan = { version: 1, trunk: 'main', lease: false, closure: [], invariants: [], drive: { min_free_mb: 0 }, nodes: ids.map(id => ({ id, writes: [`${id}.txt`], checks: [{ ...check, run: failedByNode[id] ? check.run.replace(JSON.stringify(['old bug', 'b bug', 'c bug', 'd bug']), JSON.stringify(failedByNode[id])) : check.run }] })) };
    await ops.init({ cwd: r.cwd, plan: JSON.stringify(plan), as: owner, channel: 'delegated' });
    const dir = join(r.root, 'dsa'); await mkdir(join(dir, 'agents'), { recursive: true });
    const dsa = new Dsa({ bin: FAKE, env: { FAKE_DSA_DIR: dir, ...identity }, timeoutMs: 30_000 });
    for (const id of ids) {
      await writeFile(join(dir, 'agents', `${id}-writer.sh`), 'true\n');
      await ops.dispatch({ cwd: r.cwd, node: id, as: parent });
    }
    if (launch) assert.equal((await driveOnce({ cwd: r.cwd, dsa })).error, undefined);
    const ledger = await Ledger.open(r.cwd);
    const state = async () => {
      const entries = await ledger.read(), plans = new Map<string, ReturnType<typeof parsePlan>>();
      for (const e of entries) if (e.kind === 'genesis' || e.kind === 'plan') plans.set(e.plan, parsePlan((await ledger.getBlob(e.plan)).toString()));
      return reduce(entries, sha => plans.get(sha)!);
    };
    for (const id of ids) {
      const wt = (await state()).nodes[id]!.slot!.worktree;
      await commitAt(wt, { [`${id}.txt`]: 'candidate' });
      await ops.submit({ cwd: wt, node: id, as: { role: 'writer', id: `${id}#1` } });
      assert.equal((await ops.attest({ cwd: r.cwd, node: id })).accepted, true);
    }
    const trunk = await commitAt(r.cwd, { flag: 'broken' });
    await ops.adopt({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'fixture breaks trunk' });
    const refuse = async (id: string) => assert.rejects(ops.merge({ cwd: r.cwd, node: id, as: parent }), /trunk-red:/);
    return { ...r, ids, ledger, state, trunk, refuse, dsa, dir };
  } catch (e) { await r.cleanup(); throw e; }
}

test('TP1/2: two candidates share one repository notice and no halt or worker action', async () => {
  const r = await fixture();
  try {
    for (const id of r.ids) await r.refuse(id);
    const before = await r.ledger.read(), s = await r.state();
    const actions = decide(s, s.plan, new Map(), options(r.cwd));
    assert.equal(actions.length, 1); const a = actions[0]!;
    assert.ok(a.do === 'notify'); assert.equal(a.scope, 'repo');
    assert.equal(a.once, `trunk-red\0${r.trunk}\0check:runtime\0b bug\0c bug\0d bug\0old bug`);
    assert.match(a.text, /without any candidate \(b bug, c bug, d bug, \+1\); waiting: a, b/);
    assert.match(a.text, /owed adopt; or the owner waives check:runtime/);
    assert.doesNotMatch(a.text, /known_red|owed sweep/);
    assert.deepEqual(await r.ledger.read(), before);
    assert.equal(before.filter(e => e.kind === 'halt').length, 0);
    for (const id of r.ids) assert.ok(trunkParked(s, id).length);
  } finally { await r.cleanup(); }
});

test('TP1: a mixed trunk-red and genuine execution block still halts by the old TR3 route', async () => {
  const r = await fixture(['a']);
  try {
    await r.refuse('a');
    const s = await r.state(), original = (await r.ledger.read()).find((e): e is ObsEntry => e.kind === 'obs' && e.merging === 'a')!;
    const { seq, ts, prev, hash, probe, merging, ...draft } = original;
    await r.ledger.withLock(() => r.ledger.append([{ ...draft, failed: ['candidate regression'], note: 'genuine candidate failure' }]));
    const mixed = await r.state(); assert.equal(trunkParked(mixed, 'a').length, 0);
    const actions = decide(mixed, s.plan, new Map(), options(r.cwd));
    assert.equal(actions.length, 1); assert.equal(actions[0]!.do, 'halt');
  } finally { await r.cleanup(); }
});

test('TP1/P1: genuine flaky debt plus an active trunk-red block must halt, not park', async () => {
  const r = await fixture(['a']);
  try {
    await r.refuse('a');
    const measured = (await r.ledger.read()).find((e): e is ObsEntry => e.kind === 'obs' && e.subject === 'a' && e.obligation === 'check:runtime')!;
    const { seq, ts, prev, hash, ...draft } = measured;
    const failed = { ...draft, verdict: 'fail' as const, exit: 1, failed: ['candidate intermittent regression'], note: 'genuine candidate flaky debt' };
    await r.ledger.withLock(() => r.ledger.append([failed]));
    await r.ledger.withLock(() => r.ledger.append([{ ...draft, verdict: 'pass', exit: 0, attribution: true }]));
    const flaky = (await r.state()).nodes.a!.blocks.find(b => b.key === measured.key)!;
    assert.equal(flaky.state, 'flaky', 'passing attribution preserves binding flaky debt');
    const s = await r.state();
    assert.ok(s.nodes.a!.blocks.some(b => b.state === 'active' && reducer.trunkRedOf(s, b.seq, b.key)));
    assert.ok(s.nodes.a!.blocks.some(b => b.state === 'flaky' && !reducer.trunkRedOf(s, b.seq, b.key)));
    assert.equal(trunkParked(s, 'a').length, 0);
    assert.deepEqual(trunkParkNotices(s), []);
    const actions = decide(s, s.plan, new Map(), options(r.cwd));
    assert.equal(actions.length, 1); assert.equal(actions[0]!.do, 'halt');
    assert.equal((await ops.status({ cwd: r.cwd })).summary!.progress[0]!.phase.includes('waiting: trunk-red'), false);
  } finally { await r.cleanup(); }
});

test('TP3: trunk advance automatically leaves parking and takes existing attribution measurement', async () => {
  const r = await fixture(['a'], true);
  try {
    await r.refuse('a'); const before = await r.state();
    assert.ok(trunkParked(before, 'a').length);
    await commitAt(r.cwd, { flag: 'clean again' });
    await ops.adopt({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'fixture fixes trunk' });
    const s = await r.state(), l = s.nodes.a!.runs[0]!.launches[0]!;
    assert.equal(trunkParked(s, 'a').length, 0);
    assert.ok(attestJobs(s, 'a').some(j => j.attribution));
    const actions = decide(s, s.plan, new Map([[l.rid, { rid: l.rid, state: 'sealed', status: 'ok' } as const]]), options(r.cwd));
    assert.deepEqual(actions, [{ do: 'attest', node: 'a' }]);
    assert.equal((await r.ledger.read()).filter(e => e.kind === 'resume' || e.kind === 'halt').length, 0);
  } finally { await r.cleanup(); }
});

test('TP5 ruling #1814: once suppresses same-process duplicates; restart may notify once, never halt', async () => {
  const r = await fixture(['a'], true);
  try {
    await r.refuse('a'); const s = await r.state(), key = trunkParkNotices(s)[0]!.once;
    assert.deepEqual(decide(s, s.plan, new Map(), { ...options(r.cwd), noticed: new Set([key]) }), []);
    for (let i = 0; i < 2; i++) {
      const ac = new AbortController(), lines: string[] = [];
      const timer = setTimeout(() => ac.abort(), 1200);
      try { assert.equal(await drive({ cwd: r.cwd, dsa: r.dsa, handleSignals: false, signal: ac.signal, pollMs: 30, passMs: 40, log: line => lines.push(line) }), 0); }
      finally { clearTimeout(timer); }
      assert.equal(lines.filter(l => l.includes('without any candidate')).length, 1, lines.join('\n'));
    }
    assert.equal((await r.ledger.read()).filter(e => e.kind === 'halt').length, 0);
    const calls = (await readFile(join(r.dir, 'log.jsonl'), 'utf8')).split('\n').filter(Boolean).map(l => JSON.parse(l));
    assert.equal(calls.filter(c => c.cmd === 'send').length, 0);
  } finally { await r.cleanup(); }
});

test('TP4: status and brief share one Needs-you state, while both node phases show waiting', async () => {
  const r = await fixture();
  try {
    for (const id of r.ids) await r.refuse(id);
    const status = await ops.status({ cwd: r.cwd });
    assert.equal(status.summary!.needs.length, 1);
    assert.equal(status.summary!.needs[0]!.node, 'trunk');
    for (const p of status.summary!.progress) assert.match(p.phase, new RegExp(`^waiting: trunk-red \\(check:runtime on trunk ${r.trunk.slice(0, 12)}\\)$`));
    for (const text of [renderStatus(status), renderBrief(await ops.brief({ cwd: r.cwd }))]) {
      assert.match(text, /Needs you \(1\):/);
      assert.equal(text.split('\n').filter(l => l.includes('without any candidate')).length, 1);
      assert.match(text, /waiting: a, b/);
    }
  } finally { await r.cleanup(); }
});

test('TP1: executor merge refusal parks immediately and keeps merge gate unchanged', async () => {
  const r = await fixture(['a'], true);
  try {
    const result = await driveOnce({ cwd: r.cwd, dsa: r.dsa });
    assert.equal(result.error, undefined, result.lines.join('\n'));
    assert.match(result.lines.join('\n'), /parked|waiting: trunk-red/);
    const es = await r.ledger.read();
    assert.equal(es.filter(e => e.kind === 'halt' || e.kind === 'merge').length, 0);
    assert.ok(trunkParked(await r.state(), 'a').length);
    assert.equal(classifyLine(JSON.stringify({ do: 'merge', node: 'a', outcome: 'parked', detail: 'waiting: trunk-red' })).kind, 'quiet');
    await r.refuse('a');
  } finally { await r.cleanup(); }
});

test('TP1: parked questions still notify and sweep guidance appears only with sweep', async () => {
  const r = await fixture(['a'], true);
  try {
    await r.refuse('a'); const s = await r.state(), l = s.nodes.a!.runs[0]!.launches[0]!;
    const actions = decide(s, s.plan, new Map([[l.rid, { rid: l.rid, state: 'asking', questions: [{ qid: 'q', rev: 1, question: 'which fix?' }] } as const]]), options(r.cwd));
    assert.equal(actions.filter(a => a.do === 'notify').length, 2);
    assert.ok(actions.some(a => a.do === 'notify' && a.rid === l.rid));
    s.plan.sweep = { run: 'true', timeout_s: 30 };
    assert.match(trunkParkNotices(s)[0]!.text, /owed sweep to find the culprit/);
  } finally { await r.cleanup(); }
});

test('TP2/P2: full once-key separates queued groups with identical truncated failed-name displays', async () => {
  const r = await fixture(['a', 'b'], false, { a: ['a', 'b', 'c', 'd'], b: ['a', 'b', 'c', 'e'] });
  try {
    for (const id of r.ids) await r.refuse(id);
    const groups = trunkParkNotices(await r.state());
    assert.equal(groups.length, 2); assert.notEqual(groups[0]!.once, groups[1]!.once);
    assert.equal(groups[0]!.text.split('; waiting:')[0], groups[1]!.text.split('; waiting:')[0]);
    const result = await driveOnce({ cwd: r.cwd, dsa: r.dsa, json: true });
    assert.equal(result.error, undefined);
    const notices = result.lines.map(line => JSON.parse(line) as { do?: string; scope?: string; once?: string; text?: string }).filter(line => line.do === 'notify' && line.scope === 'repo' && line.text?.includes('without any candidate'));
    assert.equal(notices.length, 2);
    assert.deepEqual(notices.map(n => n.once).sort(), groups.map(g => g.once).sort(), 'actual driver JSON retains the full group identity');
    const log = join(r.root, 'collision.jsonl');
    await writeFile(log, notices.map(n => JSON.stringify(n)).join('\n') + '\n');
    let busy = true; const delivered: string[] = [];
    const follower = new Follower({ repo: r.cwd, log, pid: process.pid, from: 0, busy: () => busy, deliver: text => { delivered.push(text); } });
    try {
      assert.equal(await follower.step(), undefined);
      await ops.abandon({ cwd: r.cwd, node: 'a', as: parent, reason: 'resolve only group ending in d' });
      busy = false; await follower.step();
      assert.equal(delivered.length, 1);
      const redLines = delivered[0]!.split('\n').filter(l => l.includes('without any candidate'));
      assert.equal(redLines.length, 1, 'resolved d group must not borrow the remaining e group');
      assert.match(redLines[0]!, /waiting: b\./); assert.doesNotMatch(redLines[0]!, /waiting: a/);
    } finally { follower.stop(); }
  } finally { await r.cleanup(); }
});

test('TP2: queued notice recomputes waiting nodes at pi delivery', async () => {
  const r = await fixture();
  try {
    for (const id of r.ids) await r.refuse(id);
    const { text, once } = trunkParkNotices(await r.state())[0]!, log = join(r.root, 'driver.jsonl');
    await writeFile(log, JSON.stringify({ do: 'notify', node: 'check:runtime', scope: 'repo', outcome: 'notify', text, once }) + '\n');
    let busy = true; const delivered: string[] = [];
    const follower = new Follower({ repo: r.cwd, log, pid: process.pid, from: 0, busy: () => busy, deliver: text => { delivered.push(text); } });
    try {
      assert.equal(await follower.step(), undefined);
      await ops.abandon({ cwd: r.cwd, node: 'b', as: parent, reason: 'fixture removes one waiting node' }); busy = false;
      await follower.step();
      assert.equal(delivered.length, 1); assert.match(delivered[0]!, /waiting: a\./); assert.doesNotMatch(delivered[0]!, /waiting: a, b/);
    } finally { follower.stop(); }
  } finally { await r.cleanup(); }
});
