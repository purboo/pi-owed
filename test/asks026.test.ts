// AK1–AK6: real ledger/CLI/driver regressions; remote execution only.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, writeFileSync } from 'node:fs';
import { writeFile, rm, mkdir, readFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { Driver, procStart } from '../src/drive-run.ts';
import { reviewerLaunch, writerLaunch } from '../src/drive.ts';
import { Follower, driveStatus, driveStop, lockPath } from '../src/drive-bg.ts';
import { clockTime } from '../src/clock.ts';
import { projectId, sameReplay, reduce } from '../src/reducer.ts';
import type { Dsa } from '../src/dsa.ts';
import { git } from '../src/git.ts';
import { parsePlan } from '../src/plan.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const parent = { role: 'parent', id: 'fixture' } as const;
const owner = { role: 'owner', id: 'fixture' } as const;
const plan = (review = 1, checks: object[] = []) => ({ version: 1, trunk: 'main', lease: false, closure: [], invariants: [] as object[], nodes: [{ id: 'a', writes: ['value'], checks, review: { count: review, min_rank: 1 } }] });
const policy = (cwd: string) => ({ max: 1, repairs: 2, project: 'fixture', root: cwd, applied: new Set<string>(), rejected: new Map<string, string>(), now: Date.parse('2026-10-16T12:00:00Z') });
async function fixture(p = plan()) {
  const r = await repo();
  await r.put('value', 'base'); await r.put('plan.json', JSON.stringify(p)); await r.commit();
  await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify(p), path: 'plan.json', measure: false });
  const ledger = await Ledger.open(r.cwd);
  return { ...r, p, ledger, async candidate() {
    const slot = await ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' });
    await commitAt(slot.worktree, { value: 'candidate' });
    await ops.submit({ cwd: slot.worktree, as: { role: 'writer', id: 'a#1' }, node: 'a' });
    await ops.attest({ cwd: r.cwd, node: 'a', lease: false });
    return slot;
  } };
}
async function call(cwd: string, args: string[], code = 0) {
  const out = await cli(cwd, args); assert.equal(out.code, code, `${args.join(' ')}\n${out.stderr}\n${out.stdout}`); return out;
}
function follower(root: string) {
  const log = join(root, 'follow.jsonl'); writeFileSync(log, '');
  const f = new Follower({ log, repo: root, pid: process.pid, start: procStart(process.pid), deliver() {} });
  return { f, log, line: (s: string) => appendFileSync(log, `${s}\n`) };
}

for (const [kind, marker] of [['plain', 'needs parent'], ['decision', 'pArEnT dEcIsIoN nEeDeD:'], ['block', 'BLOCK (needs parent):'], ['fallback', '']] as const) {
  test(`AK1 ${kind}: driver wake/status/why quote the ask, never the review introduction`, { timeout: 60_000 }, async () => {
    const r = await fixture();
    try {
      await r.candidate();
      const ask = 'Which API should the writer use?', note = `The patch looks clean.\n${'Introduction with no decision. '.repeat(20)}\n${marker} ${ask}`;
      await call(r.cwd, ['review', 'a', '--block', '--needs-parent', '--rank', '1', '--as', 'reviewer:independent', '--note', note]);
      const beforeLaunch = (await ops.readState(r)).state, launch = writerLaunch(beforeLaunch, 'a', projectId(beforeLaunch));
      await ops.launch({ cwd: r.cwd, as: { role: 'parent', id: 'drive' }, node: 'a', attempt: 1, role: 'writer', rid: launch.rid, spec: launch.spec, labels: launch.labels, rulings: launch.rulings });
      const follow = follower(r.root), dsa = { async inspect() { return { view: { rid: '', state: 'sealed', status: 'ok' } }; } } as unknown as Dsa;
      const driver = new Driver({ cwd: r.cwd, dsa, json: true, session: null, log: follow.line });
      const pass = await driver.pass(); assert.ok(pass.actions.some(a => a.do === 'halt'));
      const expected = `Needs you: a — review asks: ${ask} → owed decide a --text "<ruling>" --writer`;
      const wake = follow.f.tick()!; assert.ok(wake.split('\n').includes(expected), wake);
      for (const args of [['why', 'a'], ['status']]) {
        const text = (await call(r.cwd, args)).stdout;
        assert.ok(text.split('\n').includes(expected), text); assert.doesNotMatch(text, /Introduction with no decision|The patch looks clean/);
      }
      const { state, entries } = await ops.readState(r);
      const plans = new Map<string, ReturnType<typeof parsePlan>>();
      for (const e of entries) if (e.kind === 'genesis' || e.kind === 'plan') plans.set(e.plan, parsePlan((await r.ledger.getBlob(e.plan)).toString()));
      assert.ok(sameReplay(state, reduce(entries, sha => plans.get(sha)!)), 'presentation cannot change replay');
    } finally { await r.cleanup(); }
  });
}
test('AK1: the first marker wins and the extracted ask is one line, bounded at 300 chars', async () => {
  const r = await fixture();
  try {
    await r.candidate();
    await call(r.cwd, ['review', 'a', '--block', '--needs-parent', '--rank', '1', '--as', 'reviewer:independent', '--note', `Intro. needs parent: ${'x'.repeat(305)}\nParent decision needed: second`]);
    const text = (await call(r.cwd, ['why', 'a'])).stdout;
    const match = text.match(/review asks: (.*?) → owed decide/); assert.ok(match, text);
    const ask = match[1]!;
    assert.equal(ask.length, 300); assert.equal(ask, 'x'.repeat(300)); assert.doesNotMatch(ask, /\n|second/);
  } finally { await r.cleanup(); }
});

for (const deferred of [false, true]) test(`AK2: trunk owner conflict uses real tests and plan path${deferred ? ' and names the recorded defer' : ''}`, { timeout: 60_000 }, async () => {
  const p = plan(0); p.invariants = [{ id: 'suite', run: `echo 'owed-counts {"pass":0,"fail":4,"failed":["one","two","three","four"]}'; exit 1`, reads: ['value'], min_tests: 1 }];
  const r = await fixture(p);
  try {
    await ops.attestGenesis({ cwd: r.cwd, lease: false });
    // Same-key fail + pass remains a conflict and needs the owner (no gate weakened).
    await r.ledger.withLock(async () => {
      const s = (await ops.readState(r)).state;
      await r.ledger.append([{ kind: 'obs', by: 'executor:owed', subject: 'trunk', obligation: 'inv:suite', key: s.trunk.invKeys.suite!, verdict: 'pass', commit: s.trunk.commit, base: s.trunk.commit, exit: 0, durationMs: 0, counts: { tests: 4, pass: 4, fail: 0 } }]);
    });
    let deferSeq: number | undefined;
    if (deferred) {
      await r.candidate();
      const key = (await ops.readState(r)).state.trunk.invKeys.suite!;
      deferSeq = (await ops.defer({ cwd: r.cwd, as: owner, channel: 'delegated', node: 'a', items: [{ id: 'suite', key }], reason: 'owner accepts this node defer' })).seq;
    }
    const need = 'fix one, two, three, +1: add a repair node (owed plan plan.json, or owed edit --node-new) — clears on the next trunk key';
    for (const args of [['status'], ['why', 'trunk'], ['why', 'inv:suite']]) {
      const text = (await call(r.cwd, args)).stdout;
      assert.ok(text.includes(need), text); assert.doesNotMatch(text, /<plan.yaml>/);
      if (deferred) assert.ok(text.includes(`deferred for a #${deferSeq}`), text);
    }
    assert.equal((await ops.readState(r)).state.invariants[0]!.status, 'D', 'the conflict/deferred debt stays outstanding');
  } finally { await r.cleanup(); }
});

test('AK2: the trunk invariant why command without a recorded path offers edit, not a placeholder', { timeout: 60_000 }, async () => {
  const r = await fixture(plan(0));
  try {
    const next = { ...r.p, invariants: [{ id: 'suite', run: `echo 'owed-counts {"pass":0,"fail":1,"failed":["broken"]}'; exit 1`, reads: ['value'], min_tests: 1 }] };
    await ops.planSet({ cwd: r.cwd, as: parent, plan: JSON.stringify(next) });
    await ops.attestTrunk({ cwd: r.cwd, lease: false });
    const text = (await call(r.cwd, ['why','inv:suite'])).stdout;
    assert.match(text, /fix broken: add a repair node \(owed edit --node-new\) — clears on the next trunk key/);
    assert.doesNotMatch(text, /<plan.yaml>/);
  } finally { await r.cleanup(); }
});

async function ruled() {
  const r = await fixture(); await r.candidate();
  const ruling = await ops.rule({ cwd: r.cwd, as: parent, nodes: ['a'], text: 'Judge API v2', dsa: { async describe() { throw new Error('no run'); } } as unknown as Dsa });
  return { ...r, ruling };
}
const reviewArgs = ['review', 'a', '--ok', '--rank', '1', '--as', 'reviewer:independent', '--note', 'judged API v2'];
test('AK3: low ack refuses exit 2 with no ledger append, for ok and needs-parent block', async () => {
  const r = await ruled();
  try {
    const before = await r.ledger.read();
    const out = await call(r.cwd, [...reviewArgs, '--ack-rulings', '0'], 2);
    assert.ok(out.stderr.includes(`ack-rulings must be at least ${r.ruling.seq} (the latest ruling for a); rerun with --ack-rulings ${r.ruling.seq} or --ack-rulings latest`), out.stderr);
    await call(r.cwd, [...reviewArgs.filter(a => a !== '--ok'), '--block', '--needs-parent', '--ack-rulings', '0'], 2);
    assert.deepEqual(await r.ledger.read(), before);
  } finally { await r.cleanup(); }
});
test('AK3: latest records a numeric watermark and subsequent applicable rulings recompute it', async () => {
  const r = await ruled();
  try {
    const result = JSON.parse((await call(r.cwd, [...reviewArgs, '--ack-rulings', 'latest', '--json'])).stdout);
    assert.equal(result.ack_rulings, r.ruling.seq); assert.equal(typeof result.ack_rulings, 'number');
    const later = await ops.rule({ cwd: r.cwd, as: parent, nodes: ['a'], text: 'Also judge error bodies' });
    const entry = await ops.review({ cwd: r.cwd, as: { role: 'reviewer', id: 'another' }, node: 'a', verdict: 'ok', rank: 1, note: 'read both', ack_rulings: 'latest' });
    assert.ok(entry.kind === 'review'); assert.equal(entry.ack_rulings, later.seq);
    assert.equal((await ops.verify(r)).ok, true);
  } finally { await r.cleanup(); }
});
test('AK3: omitted underivable ack refuses without appending; a complete launch packet still derives it', async () => {
  const r = await ruled();
  try {
    const before = await r.ledger.read();
    await call(r.cwd, [...reviewArgs, '--json'], 2); assert.deepEqual(await r.ledger.read(), before);
    const s = (await ops.readState(r)).state, launch = reviewerLaunch(s, 'a', 1, projectId(s), r.cwd);
    await ops.launch({ cwd: r.cwd, as: { role: 'parent', id: 'drive' }, node: 'a', attempt: 1, role: 'reviewer', rid: launch.rid, spec: launch.spec, labels: launch.labels, rulings: launch.rulings });
    const derived = await ops.review({ cwd: r.cwd, as: { role: 'reviewer', id: 'drive-a-1-1' }, node: 'a', verdict: 'ok', rank: 1, note: 'read the full packet' });
    assert.ok(derived.kind === 'review'); assert.equal(derived.ack_rulings, r.ruling.seq);
  } finally { await r.cleanup(); }
});

test('AK4: default why/attest/rebase hide pre-dispatch downgrades, show fresh ones, and hide them after resume; JSON/full retain history', { timeout: 60_000 }, async () => {
  const r = await fixture(plan(0, [{ id: 'old', run: 'true', reads: ['value'] }, { id: 'fresh', run: 'true', reads: ['value'] }]));
  try {
    const first = { ...r.p, nodes: [{ ...r.p.nodes[0]!, checks: [r.p.nodes[0]!.checks[1]!] }] };
    const old = await ops.planSet({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'old downgrade', plan: JSON.stringify(first) });
    const slot = await r.candidate();
    assert.doesNotMatch(slot.packet, /ΔO⁻|old downgrade|check old removed/, 'dispatch text omits pre-dispatch debt');
    const fresh = await ops.planSet({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'fresh downgrade', plan: JSON.stringify({ ...first, nodes: [{ ...first.nodes[0]!, checks: [] }] }) });
    await git(r.cwd, ['checkout', '-b', 'external']);
    const hotfix = await commitAt(r.cwd, { 'other.txt': 'hotfix' });
    await ops.adopt({ cwd: r.cwd, as: owner, channel: 'delegated', commit: hotfix, note: 'fixture advances trunk', lease: false });
    for (const args of [['why', 'a'], ['attest', 'a']]) {
      const text = (await call(r.cwd, args)).stdout;
      assert.doesNotMatch(text, new RegExp(`ΔO⁻ #${old.seq}\\b`), text); assert.match(text, new RegExp(`ΔO⁻ #${fresh.seq}\\b`), text);
      const full = (await call(r.cwd, [...args, '--full'])).stdout;
      assert.ok(full.includes(`"seq":${old.seq},`), full); assert.ok(full.includes(`"seq":${fresh.seq},`), full);
    }
    const rebase = (await call(r.cwd, ['rebase', 'a'])).stdout;
    assert.doesNotMatch(rebase, new RegExp(`ΔO⁻ #${old.seq}\\b`)); assert.match(rebase, new RegExp(`ΔO⁻ #${fresh.seq}\\b`));
    await ops.resume({ cwd: r.cwd, as: parent, node: 'a', note: 'new attempt window' });
    assert.doesNotMatch((await call(r.cwd, ['why', 'a'])).stdout, /ΔO⁻/);
    const json = JSON.parse((await call(r.cwd, ['why', 'a', '--json'])).stdout);
    assert.deepEqual(json.downgrades.map((d: { seq: number }) => d.seq), [old.seq, fresh.seq]);
    const laterHotfix = await commitAt(r.cwd, { 'other.txt': 'second hotfix' });
    await ops.adopt({ cwd:r.cwd, as:owner, channel:'delegated', commit:laterHotfix, note:'advance trunk for the full rebase receipt', lease:false });
    for (const args of [['why', 'a', '--full'], ['rebase', 'a', '--full']]) {
      const full = (await call(r.cwd, args)).stdout;
      assert.ok(full.includes(`"seq":${old.seq},`), full); assert.ok(full.includes(`"seq":${fresh.seq},`), full);
    }
  } finally { await r.cleanup(); }
});

test('AK5: merge waiting is context, not an outstanding obligation', async () => {
  const r = await fixture(plan(0));
  try {
    await r.candidate();
    const s = (await ops.readState(r)).state;
    await mkdir(join(r.ledger.dir, 'drive'), { recursive: true });
    await writeFile(join(r.ledger.dir, 'drive', 'waiting.json'), JSON.stringify({ a: { attempt: 1, candidate: s.nodes.a!.candidate!.seq, reason: 'merge lock', since: '2026-10-16T12:00:00Z' } }));
    const text = (await call(r.cwd, ['why', 'a'])).stdout;
    assert.match(text, /merge waiting for merge lock/); assert.match(text.split('\n')[0]!, /nothing outstanding/);
    assert.doesNotMatch(text.split('\n')[0]!, /1 outstanding/);
  } finally { await r.cleanup(); }
});

// A real child owns the lock, acknowledges one SIGTERM, releases it before exiting, and records exit ordering.
async function fakeDriver(r: Awaited<ReturnType<typeof fixture>>, ignore = false) {
  const path = lockPath(r.ledger.dir), trace = join(r.root, 'stopped');
  const child = spawn(process.execPath, ['--input-type=module', '-e', `
    import {writeFileSync,readFileSync,rmSync,appendFileSync} from 'node:fs';
    import {hostname} from 'node:os';
    const path=${JSON.stringify(path)}, trace=${JSON.stringify(trace)};
    process.on('SIGTERM',()=>{appendFileSync(trace,'TERM\\n'); if (${ignore}) return; rmSync(path,{force:true}); setTimeout(()=>{appendFileSync(trace,'EXIT\\n');process.exit(0)},250)});
    const stat=readFileSync('/proc/'+process.pid+'/stat','utf8');
    writeFileSync(path,JSON.stringify({pid:process.pid,start:stat.slice(stat.lastIndexOf(')')+2).split(' ')[19],host:hostname(),at:'2026-10-16T12:00:00Z',token:'fake-driver'}));
    console.log('ready'); setInterval(()=>{},1000);`], { stdio: ['ignore', 'pipe', 'pipe'] });
  await once(child.stdout!, 'data');
  return { child, trace, async cleanup() {
    if (child.exitCode === null) { child.kill('SIGKILL'); await once(child, 'exit'); }
    try { if (JSON.parse(await readFile(path,'utf8')).pid === child.pid) await rm(path,{force:true}); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  } };
}
async function startFixture() {
  const p = plan(0); (p.nodes[0] as typeof p.nodes[0] & { later: boolean }).later = true;
  const r = await fixture(p), prior = process.env.OWED_DSA;
  process.env.OWED_DSA = fileURLToPath(new URL('./fixtures/fake-dsa.mjs', import.meta.url));
  return { ...r, async cleanup() { await driveStop({ cwd: r.cwd, now: true, waitMs: 5000 }); if (prior === undefined) delete process.env.OWED_DSA; else process.env.OWED_DSA = prior; await r.cleanup(); } };
}
test('AK6: restart gracefully stops a fake driver, waits for process exit, and starts a replacement', { timeout: 60_000 }, async () => {
  const r = await startFixture(), f = await fakeDriver(r);
  try {
    const text = (await call(r.cwd, ['start', '--restart', '--stay'])).stdout;
    assert.ok(text.trim().split('\n').length <= 3, text); assert.match(text, /driver: started/);
    assert.equal(f.child.exitCode, 0, 'start waits for exit, not only lock removal');
    const stopped = await import('node:fs/promises').then(fs => fs.readFile(f.trace, 'utf8'));
    assert.equal(stopped, 'TERM\nEXIT\n', 'one graceful signal, not an immediate kill');
    const current = await driveStatus(r); assert.equal(current.running, true); assert.notEqual(current.pid, f.child.pid);
  } finally { await f.cleanup(); await r.cleanup(); }
});
test('AK6: restart without a running driver equals start and ordinary start reuses it', { timeout: 60_000 }, async () => {
  const r = await startFixture();
  try {
    const before = await r.ledger.read();
    const out = await call(r.cwd, ['start', '--restart', '--stay']); assert.match(out.stdout, /driver: started/); assert.ok(out.stdout.trim().split('\n').length <= 3);
    const first = await driveStatus(r);
    const again = await call(r.cwd, ['start']); assert.match(again.stdout, /already running/);
    assert.equal((await driveStatus(r)).pid, first.pid); assert.deepEqual(await r.ledger.read(), before);
    assert.match(clockTime('2026-10-16T12:00:00Z', policy(r.cwd).now), /^\d{2}:\d{2}$/);
  } finally { await r.cleanup(); }
});
test('AK6: a graceful stop timeout refuses with the pid and force-stop hint, without a replacement', { timeout: 60_000 }, async () => {
  const r = await startFixture(), f = await fakeDriver(r, true);
  try {
    const out = await call(r.cwd, ['start', '--restart', '--stay'], 2);
    assert.ok(out.stderr.includes(`driver pid ${f.child.pid}`), out.stderr); assert.match(out.stderr, /owed drive --stop --now/);
    assert.equal((await driveStatus(r)).pid, f.child.pid); assert.equal(f.child.exitCode, null);
  } finally { await f.cleanup(); await r.cleanup(); }
});

// AK-R4: graceful stops send one SIGTERM per driver process (pid + start time); --now may add the second.
const terms = async (trace: string): Promise<number> => {
  try { return (await readFile(trace, 'utf8')).split('\n').filter(l => l === 'TERM').length; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return 0; throw e; }
};
test('AK-R4: a restart that timed out, restarted again, signals the driver once', { timeout: 90_000 }, async () => {
  const r = await startFixture(), f = await fakeDriver(r, true);
  try {
    for (let i = 0; i < 2; i++) {
      const out = await call(r.cwd, ['start', '--restart', '--stay'], 2);
      assert.ok(out.stderr.trim().split('\n').length <= 3, out.stderr);
      assert.ok(out.stderr.includes(`driver pid ${f.child.pid} is stopping after its current action and its in-flight measurements; repeating owed start --restart is safe; owed drive --stop --now stops it at once`), out.stderr);
    }
    assert.equal(await terms(f.trace), 1);
    assert.equal(f.child.exitCode, null, 'never a hard stop');
  } finally { await f.cleanup(); await r.cleanup(); }
});
test('AK-R4: --stop twice signals once; --stop then --stop --now sends the second signal', { timeout: 60_000 }, async () => {
  const r = await startFixture(), f = await fakeDriver(r, true);
  try {
    for (let i = 0; i < 2; i++) assert.equal((await driveStop({ cwd: r.cwd, waitMs: 300 })).state, 'stopping');
    assert.equal(await terms(f.trace), 1);
    assert.equal((await driveStop({ cwd: r.cwd, now: true, waitMs: 300 })).state, 'stopping');
    assert.equal(await terms(f.trace), 2, '--now still sends the second signal');
  } finally { await f.cleanup(); await r.cleanup(); }
});
test('AK-R4: a stop request of another process (same pid, other start time) is replaced: that process gets its own single signal', { timeout: 60_000 }, async () => {
  const r = await startFixture(), f = await fakeDriver(r, true);
  try {
    const request = `${lockPath(r.ledger.dir)}.stop-request`;
    await writeFile(request, JSON.stringify({ pid: f.child.pid, start: 'an-earlier-process', host: JSON.parse(await readFile(lockPath(r.ledger.dir), 'utf8')).host }));
    assert.equal((await driveStop({ cwd: r.cwd, waitMs: 300 })).state, 'stopping');
    assert.equal(await terms(f.trace), 1, 'the earlier process request does not suppress this one');
    assert.equal(JSON.parse(await readFile(request, 'utf8')).start, procStart(f.child.pid!));
    assert.equal((await driveStop({ cwd: r.cwd, waitMs: 300 })).state, 'stopping');
    assert.equal(await terms(f.trace), 1);
  } finally { await f.cleanup(); await r.cleanup(); }
});
