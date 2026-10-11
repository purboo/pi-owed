// 0.11 env (contract-0.11.md F2): environment failures wait, they do not halt (app #36, #12).
import test from 'node:test';
import assert from 'node:assert/strict';
import { access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from '../src/canon.ts';
import { decide, writerLaunch, type Action, type DriveOpts } from '../src/drive.ts';
import { Driver, drive, diskFullError, lowDisk, stateOf } from '../src/drive-run.ts';
import { classifyLine } from '../src/drive-bg.ts';
import { Dsa } from '../src/dsa.ts';
import { runJob } from '../src/exec.ts';
import * as git from '../src/git.ts';
import { Ledger } from '../src/ledger.ts';
import * as ops from '../src/ops.ts';
import { minFreeMb, parsePlan } from '../src/plan.ts';
import { reduce, runId, projectId } from '../src/reducer.ts';
import type { AttestJob, CandidateFacts, Draft, Entry, NodeSpec, Plan, RunView, State } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { commitAt } from './helpers/surface.ts';

const MIN = 60_000;

// ---------- F2.1: classification in exec ----------
test('F2.1: a failed run whose output says the disk is full is error with an environment note; a passing one is not', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    const base = await r.commit();
    const plan = parsePlan('version: 1\ntrunk: main\nnodes:\n - id: a\n   writes: [x]\n   checks: [{id: unit, run: "true", min_tests: 1}]');
    const ledger = await Ledger.open(r.cwd), ctx = { cwd: r.cwd, plan, ledger };
    const job = (run: string, kind: AttestJob['kind'] = 'check'): AttestJob => ({ kind, subject: 'a', obligation: 'check:unit', key: 'k', commit: base, base, spec: { id: 'unit', run, timeout_s: 60, reads: ['**'], ...(kind === 'red' ? { red: true, tests: [] } : { min_tests: 1 }) } });
    for (const text of ['write /tmp/x: No space left on device', 'Error: ENOSPC: write failed', 'cp: Disk quota exceeded']) {
      const o = await runJob(ctx, job(`echo '# tests 1'; echo '# pass 1'; echo '# fail 0'; echo '${text}' >&2; exit 1`));
      assert.equal(o.verdict, 'error', `${text}: ${o.note}`);
      assert.ok(o.note?.startsWith('environment: '), o.note);
      assert.ok(o.note!.includes(text), o.note);
      assert.equal(o.exit, 1);
    }
    // A red run that fails because the disk is full is no counterfactual either.
    const red = await runJob(ctx, job(`echo 'not ok'; echo 'No space left on device'; exit 1`, 'red'));
    assert.equal(red.verdict, 'error'); assert.ok(red.note?.startsWith('environment: '), red.note);
    // A run that passes while printing the words is a pass; a failure without them is still a fail.
    assert.equal((await runJob(ctx, job(`echo 'ENOSPC handled'; echo '# tests 1'; echo '# pass 1'`))).verdict, 'pass');
    const fail = await runJob(ctx, job(`echo '# tests 1'; echo '# fail 1'; exit 1`));
    assert.equal(fail.verdict, 'fail'); assert.equal(fail.note?.startsWith('environment: ') ?? false, false);
    // No counts at all, the pattern on stderr: environment.
    const bare = await runJob(ctx, job(`echo 'write: No space left on device' >&2; exit 2`));
    assert.equal(bare.verdict, 'error'); assert.ok(bare.note?.startsWith('environment: '), bare.note);
  } finally { await r.cleanup(); }
});

test('F2.1 (ruling #1094, block #1072): a test title or a failing count never makes a failure environmental', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    const base = await r.commit();
    const plan = parsePlan('version: 1\ntrunk: main\nnodes:\n - id: a\n   writes: [x]\n   checks: [{id: unit, run: "true"}]');
    const ledger = await Ledger.open(r.cwd), ctx = { cwd: r.cwd, plan, ledger };
    const job = (run: string): AttestJob => ({ kind: 'check', subject: 'a', obligation: 'check:unit', key: 'k', commit: base, base, spec: { id: 'unit', run, timeout_s: 60, reads: ['**'] } });
    // A real failing TAP run whose subtest name contains ENOSPC: fail.
    const tap = await runJob(ctx, job(`printf '%s\\n' 'TAP version 13' '# Subtest: F2.4: an ENOSPC escaping a pass' 'not ok 1 - F2.4: an ENOSPC escaping a pass' '  ---' '  error: expected 1 got 2' '  ...' 'ok 2 - Disk quota exceeded is handled' '1..2' '# tests 2' '# pass 1' '# fail 1'; exit 1`));
    assert.equal(tap.verdict, 'fail', tap.note); assert.equal(tap.note?.startsWith('environment: ') ?? false, false, tap.note);
    // Titles only (fail 0 reported, but the words appear only in test points and subtests): not environment.
    const titles = await runJob(ctx, job(`printf '%s\\n' '# Subtest: ENOSPC case' 'ok 1 - ENOSPC case' 'test disk::enospc ... ok' '# tests 1' '# pass 1' '# fail 0'; exit 1`));
    assert.equal(titles.verdict, 'fail', titles.note);
    // fail > 0 with the real error message in the output: still a fail.
    const counted = await runJob(ctx, job(`echo 'Error: ENOSPC: no space left on device'; echo '# tests 1'; echo '# fail 1'; exit 1`));
    assert.equal(counted.verdict, 'fail', counted.note);
    // The pattern older than the last 50 lines: not environment.
    const old = await runJob(ctx, job(`echo 'No space left on device'; for i in $(seq 60); do echo "line $i"; done; exit 1`));
    assert.equal(old.verdict, 'fail', old.note);
  } finally { await r.cleanup(); }
});

test('F2.1: tree preparation and setup failures keep verdict error and get the environment prefix', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    const base = await r.commit();
    const plan = parsePlan('version: 1\ntrunk: main\nnodes:\n - id: a\n   writes: [x]\n   checks: [{id: unit, run: "true"}]');
    const ledger = await Ledger.open(r.cwd), ctx = { cwd: r.cwd, plan, ledger };
    const job: AttestJob = { kind: 'check', subject: 'a', obligation: 'check:unit', key: 'k', commit: base, base, spec: { id: 'unit', run: "echo '# tests 1'; echo '# pass 1'", timeout_s: 60, reads: ['**'] } };
    const setup = await runJob({ ...ctx, plan: { ...plan, setup: 'exit 9' } }, job);
    assert.equal(setup.verdict, 'error'); assert.match(setup.note ?? '', /^environment: setup failed: 9/);
    const tree = await runJob(ctx, { ...job, commit: '0'.repeat(40) });
    assert.equal(tree.verdict, 'error'); assert.ok(tree.note?.startsWith('environment: '), tree.note);
    // A command that cannot run is not an environment failure (the plan's command is wrong).
    const missing = await runJob(ctx, { ...job, spec: { ...job.spec!, run: 'no-such-command-owed-env' } });
    assert.equal(missing.verdict, 'error'); assert.equal(missing.note?.startsWith('environment: '), false, missing.note);
  } finally { await r.cleanup(); }
});

// ---------- F2.2: the driver waits instead of halting ----------
const P = 'hash0', W = runId(P, 'a', 1, 'writer'), T0 = Date.UTC(2026, 0, 1);
const spec = (o: Partial<NodeSpec> & { id: string }): NodeSpec => ({ deps: [], writes: [`${o.id}/`], checks: [], review: { count: 0, min_rank: 1 }, ...o });
const PLAN: Plan = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: [spec({ id: 'a', checks: [{ id: 'unit', run: 'npm test', timeout_s: 60, reads: ['a/**'] }] })] };
function rig() {
  const entries: Entry[] = [], blobs = new Map<string, string>();
  let clock = T0;
  const state = (): State => reduce(entries, () => PLAN);
  const add = (d: Draft, at = clock): Entry => { const seq = entries.length, e = { ...d, seq, ts: new Date(at).toISOString(), prev: 'x', hash: `hash${seq}` } as Entry; entries.push(e); state(); return e; };
  add({ kind: 'genesis', by: 'owner:human', channel: 'tty', plan: 'p', trunk: 'main', commit: 's0', state: { commit: 's0', tree: 't0', invKeys: {} } });
  add({ kind: 'dispatch', by: 'parent:drive', node: 'a', attempt: 1, base: 's0', branch: 'owed/a/1', worktree: '/repo/.owed/wt/a-1', packet: 'blob', rulings_seen: -1 });
  const l = writerLaunch(state(), 'a', P); blobs.set(sha256(l.spec), l.spec);
  add({ kind: 'launch', by: 'parent:drive', node: 'a', attempt: 1, role: 'writer', rid: l.rid, spec: sha256(l.spec), labels: l.labels });
  const facts: CandidateFacts = { commit: 'ac1', tree: 't1', base: 's0', patch: 'p1', changed: ['a/x'], closureTouched: false, keys: { 'check:unit': 'k-unit', writes: 'k-writes', review: 'k-review', rulings: 'k-rulings' } };
  add({ kind: 'submit', by: 'writer:a#1', node: 'a', attempt: 1, facts });
  const r = {
    entries, state, blobs,
    at(ms: number) { clock = ms; },
    obs(obligation: string, verdict: 'pass' | 'error', note?: string) {
      return add({ kind: 'obs', by: 'executor:owed', subject: 'a', obligation, key: facts.keys[obligation]!, verdict, exit: verdict === 'pass' ? 0 : null, durationMs: 1, commit: 'ac1', base: 's0', ...(note !== undefined ? { note } : {}) });
    },
    halt() { return add({ kind: 'halt', by: 'parent:drive', node: 'a', attempt: 1, reason: 'stuck', needs: 'human' }); },
    resume() { return add({ kind: 'resume', by: 'parent:main', node: 'a', attempt: 1 }); },
    act(now?: number): Action | undefined {
      const runs = new Map<string, RunView>([[W, { rid: W, state: 'sealed', status: 'ok' }]]);
      const o: DriveOpts = { max: 4, repairs: 2, project: P, root: '/repo', applied: new Set(), rejected: new Map(), blobs, ...(now !== undefined ? { now } : {}) };
      return decide(state(), PLAN, runs, o).find(a => a.node === 'a');
    },
  };
  return r;
}

test('F2.2: environment errors never reach the "no verdict twice" halt; the attest waits 1 min, then retries', () => {
  const r = rig(); r.obs('writes', 'pass');
  const e1 = r.obs('check:unit', 'error', 'environment: ENOSPC: command exited 1');
  const w1 = r.act(T0 + 30_000);
  assert.ok(w1?.do === 'notify', JSON.stringify(w1));
  assert.match(w1.text, new RegExp(`environment failure #${e1.seq} check:unit: environment: ENOSPC: command exited 1`));
  assert.ok(w1.text.includes(`retry at ${new Date(T0 + MIN).toISOString()}`), w1.text);
  assert.deepEqual(r.act(T0 + MIN), { do: 'attest', node: 'a' }, 'after the back-off: attest');
  r.at(T0 + MIN); const e2 = r.obs('check:unit', 'error', 'environment: setup failed: 1');
  r.at(T0 + 3 * MIN); r.obs('check:unit', 'error', 'environment: No space left on device');
  const w3 = r.act(T0 + 3 * MIN + 1);
  assert.ok(w3?.do === 'notify', `three environment errors: no halt, a wait: ${JSON.stringify(w3)}`);
  assert.ok(w3.text.includes(`retry at ${new Date(T0 + 8 * MIN).toISOString()}`), `third step waits 5 min: ${w3.text}`);
  assert.equal(w3.once, w1.once, 'one notify per streak: the same once key');
  assert.ok(w1.once?.includes(String(e1.seq)) && e2.seq > e1.seq);
  // No clock: no back-off (an older executor, or a caller that does not wait).
  assert.deepEqual(r.act(), { do: 'attest', node: 'a' });
});

test('F2.2: back-off steps 1, 2, 5, 10, then 30 min; a non-environment error ends the streak and still counts', () => {
  const r = rig(); r.obs('writes', 'pass');
  let t = T0;
  const steps: number[] = [];
  for (let i = 0; i < 6; i++) {
    r.at(t); r.obs('check:unit', 'error', `environment: ENOSPC ${i}`);
    const a = r.act(t + 1);
    assert.ok(a?.do === 'notify', JSON.stringify(a));
    const until = Date.parse(/retry at (\S+);/.exec(a.text)![1]!);
    steps.push((until - t) / MIN); t = until;
  }
  assert.deepEqual(steps, [1, 2, 5, 10, 30, 30]);
  // One ordinary error after the streak: the streak ends (no wait); a second ordinary error halts as before.
  r.at(t); r.obs('check:unit', 'error', 'check cut off');
  assert.deepEqual(r.act(t + 1), { do: 'attest', node: 'a' });
  r.obs('check:unit', 'error', 'cut off again');
  const h = r.act(t + 2);
  assert.ok(h?.do === 'halt' && /^attest recorded no verdict twice: check:unit \(#\d+ check cut off; #\d+ cut off again\)/.test(h.reason), JSON.stringify(h));
});

test('F2.2: the streak counts since the latest resume; a new streak gets a new notify key', () => {
  const r = rig(); r.obs('writes', 'pass');
  r.obs('check:unit', 'error', 'environment: ENOSPC'); r.obs('check:unit', 'error', 'environment: ENOSPC');
  const before = r.act(T0 + 1);
  assert.ok(before?.do === 'notify' && before.text.includes(`retry at ${new Date(T0 + 2 * MIN).toISOString()}`), JSON.stringify(before));
  r.halt(); r.resume();
  assert.deepEqual(r.act(T0 + 1), { do: 'attest', node: 'a' }, 'resume: the streak starts again');
  const e = r.obs('check:unit', 'error', 'environment: ENOSPC');
  const after = r.act(T0 + 1);
  assert.ok(after?.do === 'notify' && after.text.includes(`retry at ${new Date(T0 + MIN).toISOString()}`), JSON.stringify(after));
  assert.notEqual(after.once, before.once);
  assert.ok(after.once?.endsWith(String(e.seq)));
});

// ---------- F2.3: the disk preflight ----------
test('F2.3: drive.min_free_mb parses (default 2048, 0 disables) and lowDisk reports paths below the limit', async () => {
  const plan = (drive: string) => parsePlan(`version: 1\ntrunk: main\n${drive}nodes:\n - id: a\n   writes: [x]\n`);
  assert.equal(minFreeMb(plan('')), 2048);
  assert.equal(minFreeMb(plan('drive: {max: 2}\n')), 2048);
  assert.equal(plan('drive: {max: 2}\n').drive?.min_free_mb, undefined, 'kept out of the parsed plan unless set');
  assert.equal(minFreeMb(plan('drive: {min_free_mb: 0}\n')), 0);
  assert.equal(minFreeMb(plan('drive: {min_free_mb: 10}\n')), 10);
  assert.throws(() => plan('drive: {min_free_mb: -1}\n'), /drive\.min_free_mb: expected integer >= 0/);
  assert.throws(() => plan('drive: {min_free_mb: x}\n'), /drive\.min_free_mb/);
  assert.deepEqual(await lowDisk([tmpdir()], 0), []);
  const low = await lowDisk([tmpdir(), '/no/such/path/owed'], Number.MAX_SAFE_INTEGER);
  assert.equal(low.length, 1); assert.equal(low[0]!.path, tmpdir()); assert.ok(low[0]!.mb > 0);
  assert.deepEqual(await lowDisk([tmpdir()], 1), []);
});

/** In-process dsa stand-in: the writer run is sealed ok; nothing else is called. */
class SealedDsa extends Dsa {
  constructor() { super({ bin: '/nonexistent/owed-env-dsa' }); }
  override async inspect(rid: string): Promise<{ view: RunView; gen?: number }> { return { view: { rid, state: 'sealed', status: 'ok' } }; }
}
/** A submitted candidate of node a with a check, on a plan with `drive`. */
async function candidate(drive: object) {
  const r = await repo();
  await commitAt(r.cwd, { README: 'x\n' });
  const plan = { version: 1, trunk: 'main', closure: [], invariants: [], drive, nodes: [{ id: 'a', writes: ['a.txt'], checks: [{ id: 'unit', run: "echo '# tests 1'; echo '# pass 1'", reads: ['a.txt'] }] }] };
  await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'human' }, channel: 'flag', plan: JSON.stringify(plan) });
  const d = await ops.dispatch({ cwd: r.cwd, node: 'a', as: { role: 'parent', id: 'drive' } });
  const l = writerLaunch(await stateOf(r.cwd), 'a', projectId(await stateOf(r.cwd)));
  await ops.launch({ cwd: r.cwd, as: { role: 'parent', id: 'drive' }, node: 'a', attempt: 1, role: 'writer', rid: l.rid, spec: l.spec, labels: l.labels });
  await commitAt(d.worktree, { 'a.txt': 'a\n' });
  await ops.submit({ cwd: d.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
  return r;
}

test('F2.3: below min_free_mb the driver starts no measurement and notifies once per change; 0 disables the check', { timeout: 120_000 }, async () => {
  const r = await candidate({ min_free_mb: Number.MAX_SAFE_INTEGER });
  try {
    const lines: string[] = [];
    const d = new Driver({ cwd: r.cwd, json: true, log: l => lines.push(l), dsa: new SealedDsa(), owed: ['true'], session: null, handleSignals: false });
    const p1 = await d.pass(), p2 = await d.pass();
    assert.equal(d.measuring.size, 0, 'no measurement started');
    for (const p of [p1, p2]) assert.equal(p.actions.some(a => a.outcome === 'started'), false, JSON.stringify(p.actions));
    const disk = lines.map(l => JSON.parse(l) as Record<string, unknown>).filter(j => j.node === 'disk');
    assert.equal(disk.length, 1, `one notify for the unchanged low disk: ${lines.join('\n')}`);
    assert.equal(disk[0]!.scope, 'repo'); assert.equal(disk[0]!.do, 'notify');
    const common = await git.commonDir(r.cwd);
    const esc = (x: string) => x.replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
    assert.match(String(disk[0]!.text), new RegExp(`^disk low: \\d+ MB free in ${esc(common)} < ${Number.MAX_SAFE_INTEGER} MB; disk low: \\d+ MB free in ${esc(tmpdir())} < `));
    assert.equal(classifyLine(lines.find(l => l.includes('"disk"'))!).kind, 'wake');
    assert.equal(lines.some(l => l.includes('drift-cleared')), false, 'the disk notify is not a trunk drift');
  } finally { await r.cleanup(); }
  const ok = await candidate({ min_free_mb: 0 });
  try {
    const lines: string[] = [];
    const d = new Driver({ cwd: ok.cwd, json: true, log: l => lines.push(l), dsa: new SealedDsa(), owed: ['true'], session: null, handleSignals: false });
    const p = await d.pass();
    assert.ok(p.actions.some(a => a.do === 'attest' && a.outcome === 'started'), JSON.stringify(p.actions));
    await d.settle();
    assert.equal(lines.some(l => l.includes('disk low')), false);
  } finally { await ok.cleanup(); }
});

// ---------- F2.4: a full disk does not end the loop ----------
class FullOnceDsa extends Dsa {
  runs = 0;
  constructor() { super({ bin: '/nonexistent/owed-env-dsa' }); }
  override async inspect(rid: string): Promise<{ view: RunView; gen?: number }> { return { view: { rid, state: this.runs > 1 ? 'running' : 'absent' } }; }
  override async request(): Promise<{ state: 'applied' }> { return { state: 'applied' }; }
  override async events(): Promise<{ outcome: 'applied'; events: never[]; head: string; more: boolean }> { return { outcome: 'applied', events: [], head: 'h', more: false }; }
  override async run(): Promise<{ outcome: 'applied'; wid: string; created: boolean; spec_digest: string }> {
    if (++this.runs === 1) throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    return { outcome: 'applied', wid: 'w', created: true, spec_digest: 'd' };
  }
}
test('F2.4: an ENOSPC escaping a pass emits a disk-full event (a wake), sleeps and continues; other errors still end the loop', { timeout: 120_000 }, async () => {
  assert.equal(diskFullError(Object.assign(new Error('x'), { code: 'EDQUOT' })), true);
  assert.equal(diskFullError(new Error('git commit: fatal: No space left on device')), true);
  assert.equal(diskFullError(new Error('other')), false);
  const r = await repo();
  try {
    await commitAt(r.cwd, { README: 'x\n' });
    await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'human' }, channel: 'flag', plan: JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [], nodes: [{ id: 'a', writes: ['a.txt'], checks: [] }] }) });
    const dsa = new FullOnceDsa(), stop = new AbortController(), lines: string[] = [];
    const exit = await drive({ cwd: r.cwd, json: true, dsa, owed: ['true'], session: null, handleSignals: false, pollMs: 20, passMs: 50, diskFullMs: 50, signal: stop.signal,
      log: l => { lines.push(l); if (dsa.runs >= 2) stop.abort(); } });
    assert.equal(exit, 0, lines.join('\n'));
    const events = lines.map(l => JSON.parse(l) as Record<string, unknown>);
    const full = events.find(e => e.event === 'disk-full');
    assert.ok(full && /ENOSPC/.test(String(full.error)), lines.join('\n'));
    assert.equal(classifyLine(JSON.stringify(full)).kind, 'wake');
    assert.ok(dsa.runs >= 2, 'the loop continued and launched again');
    assert.deepEqual(events.at(-1) && { event: events.at(-1)!.event, reason: events.at(-1)!.reason }, { event: 'exit', reason: 'stopped' });
  } finally { await r.cleanup(); }
});

// ---------- F2.5: gc removes trees of finished nodes ----------
test('F2.5: owed gc removes reused trees whose check belongs only to merged/abandoned nodes; keeps open nodes, invariants and leased trees', { timeout: 120_000 }, async () => {
  const r = await repo();
  const exists = async (p: string) => { try { await access(p); return true; } catch { return false; } };
  try {
    const c = await commitAt(r.cwd, { flag: 'one' });
    const PASS = "echo '# tests 1'; echo '# pass 1'";
    const plan = { version: 1, trunk: 'main', exec: { trees: 'reuse' }, closure: [], invariants: [{ id: 'u', reads: ['flag'], run: PASS }],
      nodes: [{ id: 'a', writes: ['a'], checks: [{ id: 'ca', reads: ['a'], run: PASS }] }, { id: 'b', writes: ['b'], checks: [{ id: 'cb', reads: ['b'], run: PASS }] }, { id: 'c', writes: ['c'], checks: [{ id: 'cc', reads: ['c'], run: PASS }] }] };
    await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'human' }, channel: 'flag', plan: JSON.stringify(plan) });
    const parent = { role: 'parent', id: 'test' } as const, dir = await git.reuseDir(r.cwd);
    for (const id of ['ca', 'cb', 'cc']) await (await git.materialize(r.cwd, c, { kind: 'check', id })).dispose();
    await (await git.materialize(r.cwd, c, { kind: 'inv', id: 'u' })).dispose();
    await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent }); await ops.abandon({ cwd: r.cwd, node: 'a', reason: 'done with it', as: parent });
    await ops.dispatch({ cwd: r.cwd, node: 'b', as: parent });
    await ops.dispatch({ cwd: r.cwd, node: 'c', as: parent }); await ops.abandon({ cwd: r.cwd, node: 'c', reason: 'x', as: parent });
    const held = await git.materialize(r.cwd, c, { kind: 'check', id: 'cc' });
    try {
      const dry = await ops.gc({ cwd: r.cwd, dryRun: true, as: parent });
      assert.deepEqual(dry.trees?.map(t => t.path), [join(dir, 'check-ca-0')], JSON.stringify(dry.trees));
      assert.match(dry.trees![0]!.reason, /belongs only to merged or abandoned nodes/);
      assert.deepEqual(dry.treesKept?.map(t => t.path), [join(dir, 'check-cc-0')], 'the leased tree of a finished node is kept');
      assert.equal(await exists(join(dir, 'check-ca-0')), true, 'dry run removes nothing');
      const real = await ops.gc({ cwd: r.cwd, as: parent });
      assert.deepEqual(real.trees?.map(t => t.path), [join(dir, 'check-ca-0')]);
      assert.equal(await exists(join(dir, 'check-ca-0')), false);
      assert.equal((await git.listWorktrees(r.cwd)).some(w => w.path.endsWith('check-ca-0')), false, 'unregistered (worktree remove, prune)');
      assert.equal(await exists(join(dir, 'check-cb-0')), true, 'an open node keeps its tree');
      assert.equal(await exists(join(dir, 'inv-u-0')), true, 'invariant trees are kept');
      assert.equal(await exists(join(dir, 'check-cc-0')), true, 'a leased tree is kept');
    } finally { await held.dispose(); }
    const after = await ops.gc({ cwd: r.cwd, as: parent });
    assert.deepEqual(after.trees?.map(t => t.path), [join(dir, 'check-cc-0')], 'released: removed');
    assert.equal(await exists(join(dir, 'check-cb-0')), true);
  } finally { await r.cleanup(); }
});
