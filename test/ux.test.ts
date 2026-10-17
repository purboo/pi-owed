import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import * as git from '../src/git.ts';
import { ruleText } from '../src/answer.ts';
import { writerLaunch } from '../src/drive.ts';
import { projectId } from '../src/reducer.ts';
import { renderReceipt, renderStatus } from '../src/views.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const owner = { as: { role: 'owner' as const, id: 'pi' }, channel: 'delegated' as const, lease: false };
const parent = { as: { role: 'parent' as const, id: 'test' } };
const sealed = { async describe(rid: string) { return { rid, state: 'sealed' as const, status: 'ok' as const }; }, async send() { throw new Error('must not send to sealed calls'); } };
async function fixture(two: boolean | 3 = false) {
  const r = await repo();
  await r.put('shared space-目标.txt', 'base\n');
  const plan = JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [], nodes: (two === 3 ? ['a', 'b', 'c'] : two ? ['a', 'b'] : ['a']).map(id => ({ id, writes: ['shared space-目标.txt'], checks: [], review: { count: 1, min_rank: 1 } })) });
  await r.put('plan.json', plan); await r.commit();
  await ops.init({ cwd: r.cwd, ...owner, plan });
  const slot = await ops.dispatch({ cwd: r.cwd, ...parent, node: 'a' });
  await commitAt(slot.worktree, { 'shared space-目标.txt': 'candidate a\n' });
  await ops.submit({ cwd: slot.worktree, as: { role: 'writer', id: 'a#1' }, node: 'a' });
  return { ...r, slot };
}

test('UX1: active review block suggests writer ruling and labels any owner override', async () => {
  const f = await fixture();
  try {
    await ops.review({ cwd: f.cwd, as: { role: 'reviewer', id: 'independent' }, node: 'a', verdict: 'block', rank: 2, note: 'repair collision' });
    const s = await ops.status(f), command = s.summary!.needs.find(n => n.node === 'a')!.command!;
    const need = s.summary!.needs.find(n => n.node === 'a')!;
    assert.equal(command, 'owed decide a --text "<ruling>" --writer');
    assert.match(need.alternatives![0]!, /^owed review a --ok --rank 3 --candidate [0-9a-f]{12} --note "<note>" --ack-rulings latest --as owner:<id>$/);
    assert.equal(s.nodes.a!.accepted, false);
  } finally { await f.cleanup(); }
});

test('UX1: needs-parent block also gives a writer ruling as the next action', async () => {
  const f = await fixture();
  try {
    await ops.review({ cwd: f.cwd, as: { role: 'reviewer', id: 'independent' }, node: 'a', verdict: 'block', rank: 2, note: 'choose API', needs: 'parent' });
    const s = await ops.status(f);
    assert.equal(s.summary!.needs.find(n => n.node === 'a')!.command!, 'owed decide a --text "<ruling>" --writer');
    assert.match(renderReceipt(await ops.why({ ...f, node: 'a' })), /review asks: choose API → owed decide a --text "<ruling>" --writer/);
  } finally { await f.cleanup(); }
});

test('UX2: no running calls keeps verbatim follow-ups in details and only unknown-writer notices in text', async () => {
  const f = await fixture(true);
  try {
    const state = (await ops.readState(f)).state;
    const launch = writerLaunch(state, 'a', projectId(state));
    await ops.launch({ cwd: f.cwd, ...parent, ...launch });
    const b = await ops.dispatch({ cwd: f.cwd, ...parent, node: 'b', allowOverlap: true });
    const r = await ops.rule({ cwd: f.cwd, ...parent, nodes: ['a', 'b'], text: 'Use API v2', writer: true, dsa: sealed });
    assert.equal(r.delivery!.delivered.length, 0);
    const text = ruleText(r);
    // WS-R3: writer a's known call has finished, so the receipt adds one line naming it.
    assert.equal(text, `Recorded #${r.seq} ruling (a, b); delivered 0/4\nb: writer call unknown; owed why b shows the ruling to forward\na: writer call ${launch.rid} has finished, so the ruling was recorded but not sent now; the driver delivers it on its next pass; if a is halted, run owed resume a (owed decide records and resumes in one step)`);
    assert.deepEqual(r.delivery!.slots!.map(s => s.node), ['a', 'b']);
    for (const slot of r.delivery!.slots!) {
      assert.ok(!text.includes(slot.followUp));
      assert.ok(slot.followUp.includes(`#${r.seq}`));
      assert.ok(slot.followUp.includes('Use API v2'));
    }
    assert.ok(b.worktree);
  } finally { await f.cleanup(); }
});

test('UX2: a rule does not list undispatched or abandoned slots', async () => {
  const f = await fixture(true);
  try {
    await ops.abandon({ cwd: f.cwd, ...parent, node: 'a', reason: 'finished attempt' });
    const r = await ops.rule({ cwd: f.cwd, ...parent, nodes: '*', text: 'Use v2', dsa: sealed });
    assert.equal(r.delivery!.slots?.length ?? 0, 0);
    assert.doesNotMatch(ruleText(r), /writer call/);
  } finally { await f.cleanup(); }
});

test('UX3: status and why expose trunk and peer paths; cache is scoped to commit pairs', async () => {
  const f = await fixture(true);
  try {
    const b = await ops.dispatch({ cwd: f.cwd, ...parent, node: 'b', allowOverlap: true });
    await commitAt(b.worktree, { 'shared space-目标.txt': 'candidate b\n' });
    await ops.submit({ cwd: b.worktree, as: { role: 'writer', id: 'b#1' }, node: 'b' });
    let s = await ops.status(f);
    const conflicts = (s as typeof s & { conflicts: Record<string, Record<string, string[]>> }).conflicts;
    assert.deepEqual(conflicts.a, { trunk: [], b: ['shared space-目标.txt'] });
    assert.deepEqual(conflicts.b, { trunk: [], a: ['shared space-目标.txt'] });
    assert.match(renderStatus(s), /a: conflicts with b: shared space-目标.txt/);
    assert.match(renderStatus(s, { full: true }), /b: conflicts with a: shared space-目标.txt/);
    assert.match(renderReceipt(await ops.why({ ...f, node: 'a' })), /conflicts with b: shared space-目标.txt/);
    const dir = join(await git.commonDir(f.cwd), 'owed', 'cache');
    const files = (await readdir(dir)).filter(n => n.startsWith('conflicts-'));
    assert.equal(files.length, 3, 'one trunk pair per candidate and one shared peer pair');
    const snapshots = await Promise.all(files.map(n => readFile(join(dir, n), 'utf8')));
    await ops.status(f);
    assert.deepEqual(await Promise.all(files.map(n => readFile(join(dir, n), 'utf8'))), snapshots);
    await writeFile(join(dir, files[0]!), 'corrupt');
    await ops.status(f);
    const awaitedCache = await readFile(join(dir, files[0]!), 'utf8');
    assert.doesNotThrow(() => JSON.parse(awaitedCache));
    await ops.attest({ cwd: f.cwd, node: 'a', lease: false });
    await ops.review({ cwd: f.cwd, as: { role: 'reviewer', id: 'independent' }, node: 'a', verdict: 'ok', rank: 2, note: 'fixture accepted' });
    await commitAt(f.cwd, { 'shared space-目标.txt': 'trunk\n' });
    await ops.adopt({ cwd: f.cwd, ...owner, note: 'advance fixture trunk' });
    s = await ops.status(f);
    assert.match(renderStatus(s), /a: conflicts with trunk: shared space-目标.txt/);
    assert.match(renderReceipt(await ops.why({ ...f, node: 'a' })), /conflicts with trunk: shared space-目标.txt/);
    await assert.rejects(ops.merge({ cwd: f.cwd, ...parent, node: 'a', lease: false }), /rebase needed: run owed rebase a.*conflicts with trunk: shared space-目标.txt/);
    await ops.abandon({ cwd: f.cwd, ...parent, node: 'b', reason: 'close peer' });
    assert.doesNotMatch(renderReceipt(await ops.why({ ...f, node: 'a' })), /conflicts with b:/);
  } finally { await f.cleanup(); }
});

test('UX3: request metadata and unordered probes are deduplicated; why probes only its node', async () => {
  const f = await fixture(3);
  const prior = { PATH: process.env.PATH, UX_REAL_GIT: process.env.UX_REAL_GIT, UX_GIT_LOG: process.env.UX_GIT_LOG };
  try {
    for (const id of ['b', 'c']) {
      const slot = await ops.dispatch({ cwd: f.cwd, ...parent, node: id, allowOverlap: true });
      await commitAt(slot.worktree, { 'shared space-目标.txt': `candidate ${id}\n` });
      await ops.submit({ cwd: slot.worktree, as: { role: 'writer', id: `${id}#1` }, node: id });
    }
    const state = (await ops.readState(f)).state;
    const commits = [state.trunk.commit, ...Object.values(state.nodes).map(n => n.candidate!.commit)];
    const dir = join(await git.commonDir(f.cwd), 'owed', 'cache');
    const realGit = (await promisify(execFile)('sh', ['-c', 'command -v git'])).stdout.trim();
    const wrapper = join(f.root, 'git-bin'), log = join(f.root, 'git-calls');
    await mkdir(wrapper);
    await writeFile(join(wrapper, 'git'), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$UX_GIT_LOG"\nexec "$UX_REAL_GIT" "$@"\n', { mode: 0o755 });
    process.env.UX_REAL_GIT = realGit; process.env.UX_GIT_LOG = log; process.env.PATH = `${wrapper}:${prior.PATH}`;
    const calls = async () => (await readFile(log, 'utf8')).trim().split('\n');
    await rm(dir, { recursive: true, force: true }); await writeFile(log, '');
    const why = await ops.why({ ...f, node: 'a' });
    assert.deepEqual(Object.keys(why.conflicts!).sort(), ['b', 'c', 'trunk']);
    assert.equal((await calls()).filter(c => c.startsWith('merge-tree ')).length, 3, 'why: a-trunk, a-b, a-c only');
    assert.equal((await readdir(dir)).filter(n => n.startsWith('conflicts-')).length, 3);
    await rm(dir, { recursive: true, force: true }); await writeFile(log, '');
    const status = await ops.status(f);
    assert.deepEqual(status.conflicts!.a!.b, status.conflicts!.b!.a);
    assert.deepEqual(status.conflicts!.a!.c, status.conflicts!.c!.a);
    assert.deepEqual(status.conflicts!.b!.c, status.conflicts!.c!.b);
    assert.equal((await calls()).filter(c => c.startsWith('merge-tree ')).length, 6, 'status: three peer pairs plus three trunk probes');
    assert.equal((await readdir(dir)).filter(n => n.startsWith('conflicts-')).length, 6);
    await writeFile(log, '');
    const probe = await git.conflictProbe(f.cwd, [...commits, ...commits]);
    for (const a of commits) for (const b of commits) if (a !== b) await probe(a, b);
    const cachedCalls = await calls();
    assert.equal(cachedCalls.filter(c => c.includes('--git-common-dir')).length, 1);
    assert.equal(cachedCalls.filter(c => c.startsWith('rev-parse --verify ')).length, 4, 'each unique commit resolved once');
    assert.equal(cachedCalls.filter(c => c.startsWith('merge-tree ')).length, 0, 'all pairs reuse the disk cache');
    await rm(dir, { recursive: true, force: true }); await writeFile(log, '');
    const cold = await git.conflictProbe(f.cwd, commits);
    await Promise.all([cold(commits[1]!, commits[2]!), cold(commits[2]!, commits[1]!)]);
    assert.equal((await calls()).filter(c => c.startsWith('merge-tree ')).length, 1, 'simultaneous reverse pair shares one probe');
  } finally {
    for (const [key, value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    await f.cleanup();
  }
});

test('UX4: explicit zero and omitted ack refuse before recording; latest preserves the verdict and note', async () => {
  const f = await fixture();
  try {
    const rule = await ops.rule({ cwd: f.cwd, ...parent, nodes: ['a'], text: 'Apply API v2', dsa: sealed });
    const args = ['review', 'a', '--ok', '--rank', '2', '--as', 'reviewer:independent', '--note', "quote ' and $ literal"];
    const first = await cli(f.cwd, [...args, '--ack-rulings', '0']);
    assert.equal(first.code, 2, first.stderr);
    assert.ok(first.stderr.includes(`ack-rulings must be at least ${rule.seq}`));
    const { entries } = await ops.readState(f);
    assert.equal(entries.filter(e => e.kind === 'review').length, 0);
    const latest = await cli(f.cwd, [...args, '--ack-rulings', 'latest', '--json']);
    assert.equal(latest.code, 0, latest.stderr);
    assert.equal(JSON.parse(latest.stdout).note, "quote ' and $ literal");
    assert.equal(JSON.parse(latest.stdout).ack_rulings, rule.seq);
    const second = await cli(f.cwd, [...args, '--ack-rulings', String(rule.seq)]);
    assert.equal(second.code, 0, second.stderr); assert.doesNotMatch(second.stdout, /Warning: review recorded/);
    const omitted = await cli(f.cwd, [...args, '--json']);
    assert.equal(omitted.code, 2, omitted.stderr);
    assert.match(omitted.stderr, /ack-rulings must be at least/);
    await assert.rejects(ops.review({ cwd: f.cwd, as: { role: 'reviewer', id: 'blocker' }, node: 'a', verdict: 'block', rank: 2, note: 'choose API', needs: 'parent', ack_rulings: 0 }), /ack-rulings must be at least/);
    assert.equal((await ops.verify(f)).ok, true);
  } finally { await f.cleanup(); }
});

test('UX4: no applicable rulings produces no warning', async () => {
  const f = await fixture();
  try {
    const r = await cli(f.cwd, ['review', 'a', '--ok', '--rank', '1', '--as', 'reviewer:independent']);
    assert.equal(r.code, 0, r.stderr); assert.doesNotMatch(r.stdout, /Warning: review recorded/);
  } finally { await f.cleanup(); }
});
