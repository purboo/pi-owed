import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import * as git from '../src/git.ts';
import * as ops from '../src/ops.ts';
import { EMPTY_SHA, sha256 } from '../src/canon.ts';
import { OwedError } from '../src/errors.ts';
import { Ledger } from '../src/ledger.ts';
import { parsePlan } from '../src/plan.ts';
import { repo } from './helpers/repo.ts';
import { commitAt, cli } from './helpers/surface.ts';

const planText = JSON.stringify({ version: 1, trunk: 'main', lease: false, closure: [], invariants: [], nodes: [{ id: 'a', writes: ['data/'], checks: [{ id: 'unit', run: 'true' }], review: { count: 0 } }] });
const diffArgs = (base: string, commit: string) => ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '--no-renames', '--binary', '--full-index', '--src-prefix=a/', '--dst-prefix=b/', base, commit];
const refused = (subcommand: string) => (e: unknown): boolean => {
  assert.ok(e instanceof OwedError);
  assert.equal(e.code, 'refused');
  assert.match(e.message, new RegExp(`git ${subcommand}.*output exceeds`));
  assert.doesNotMatch(e.message, /ERR_STRING_TOO_LONG/);
  return true;
};

for (const [name, content] of [
  ['text', Buffer.from('hello 世界🙂\n')],
  ['binary', Buffer.from([0, 255, 1, 2, 0, 3])],
  ['invalid UTF-8', Buffer.from([97, 0xff, 0xc0, 0xaf, 0xe2, 0x82, 0x0a, 0xf0, 0x9f, 0x92])],
] as const) {
  test(`BD1: ${name} diff hash matches 0.13 UTF-8 decoding, including one-byte chunks`, async () => {
    const r = await repo();
    try {
      await r.put('data/file', 'old\n'); const base = await r.commit();
      await writeFile(join(r.cwd, 'data/file'), content); const commit = await r.commit();
      const plan = parsePlan(planText), old = sha256((await git.git(r.cwd, diffArgs(base, commit))).stdout);
      for (const split of [undefined, 1, 2, 3]) {
        git.gitHooks.hashChunkBytes = split;
        const facts = await git.candidateFacts(r.cwd, plan, plan.nodes[0]!, base, commit, 1);
        assert.equal(facts.patch, old, `split ${split}`);
      }
      assert.equal((await git.candidateFacts(r.cwd, plan, plan.nodes[0]!, base, base, 1)).patch, EMPTY_SHA);
    } finally { if (git.gitHooks) delete git.gitHooks.hashChunkBytes; await r.cleanup(); }
  });
}

test('BD1: candidate diff above injected buffering limit is hashed by streaming', async () => {
  const r = await repo();
  try {
    await r.put('data/file', 'old\n'); const base = await r.commit();
    await r.put('data/file', '世界🙂 evidence\n'.repeat(12_000)); const commit = await r.commit();
    const plan = parsePlan(planText), diff = (await git.git(r.cwd, diffArgs(base, commit))).stdout;
    assert.ok(Buffer.byteLength(diff) > 8192);
    const expected = sha256(diff);
    git.gitHooks.maxOutputBytes = 8192;
    await assert.rejects(git.git(r.cwd, diffArgs(base, commit)), refused('diff'));
    assert.equal((await git.candidateFacts(r.cwd, plan, plan.nodes[0]!, base, commit, 1)).patch, expected);
  } finally { if (git.gitHooks) delete git.gitHooks.maxOutputBytes; await r.cleanup(); }
});

for (const subcommand of ['show', 'cat-file', 'diff'] as const) {
  test(`BD2: buffered ${subcommand} over the bound refuses even with allowFail`, async () => {
    const r = await repo();
    try {
      const base = await r.commit(); await r.put('data/file', 'x\n'.repeat(4096)); const commit = await r.commit();
      const args = subcommand === 'show' ? ['show', `${commit}:data/file`] : subcommand === 'cat-file' ? ['cat-file', 'blob', `${commit}:data/file`] : diffArgs(base, commit);
      await assert.rejects(git.git(r.cwd, args, { maxOutputBytes: 512, allowFail: true }), refused(subcommand));
      assert.equal((await git.git(r.cwd, ['rev-parse', 'HEAD'])).stdout.trim(), commit, 'a later git call succeeds');
    } finally { await r.cleanup(); }
  });
}

test('BD2: stderr is bounded and ordinary allowFail still returns a git error', async () => {
  const r = await repo();
  try {
    await r.commit();
    await assert.rejects(git.git(r.cwd, ['show', 'x'.repeat(4096)], { maxOutputBytes: 128, allowFail: true }), refused('show'));
    const result = await git.git(r.cwd, ['show', 'missing'], { allowFail: true });
    assert.notEqual(result.code, 0); assert.match(result.stderr, /missing/);
  } finally { await r.cleanup(); }
});

test('BD3: limits validation accepts fractional MiB and rejects non-positive, non-finite and unknown values', () => {
  assert.deepEqual(parsePlan(`${planText}\n`).limits, undefined);
  const withLimits = (limits: unknown) => JSON.stringify({ ...JSON.parse(planText), limits });
  assert.deepEqual(parsePlan(withLimits({ file_mib: 0.5, diff_mib: 2 })).limits, { file_mib: 0.5, diff_mib: 2 });
  for (const value of [0, -1, '1', null, false]) for (const key of ['file_mib', 'diff_mib']) {
    assert.throws(() => parsePlan(withLimits({ [key]: value })), /positive finite number/);
  }
  assert.throws(() => parsePlan('version: 1\ntrunk: main\nlimits: {diff_mib: .nan}\nnodes: []'), /positive finite number/);
  const yaml = 'version: 1\ntrunk: main\nlimits: {file_mib: .inf}\nnodes: []';
  assert.throws(() => parsePlan(yaml), /positive finite number/);
  for (const limits of [[], 'small', null, { unknown: 1 }]) assert.throws(() => parsePlan(withLimits(limits)), /limits/);
});

async function submitRig(limits?: { file_mib?: number; diff_mib?: number }) {
  const r = await repo();
  await r.put('data/deleted', 'd'.repeat(4096)); await r.put('data/unchanged', 'u'.repeat(4096)); await r.commit();
  await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'test' }, channel: 'flag', plan: JSON.stringify({ ...JSON.parse(planText), limits }) });
  const packet = await ops.dispatch({ cwd: r.cwd, as: { role: 'parent', id: 'test' }, node: 'a' });
  const ledger = await Ledger.open(r.cwd);
  return { ...r, worktree: packet.worktree, ledger, submit: () => ops.submit({ cwd: packet.worktree, as: { role: 'writer', id: 'a#1' }, node: 'a' }) };
}

test('BD3: file limit refusal lists only the five largest changed files and records nothing', async () => {
  const r = await submitRig({ file_mib: 512 / 1024 / 1024 });
  try {
    await commitAt(r.worktree, Object.fromEntries(Array.from({ length: 6 }, (_, i) => [`data/f${i}`, 'x'.repeat((i + 1) * 256)])));
    const before = await r.ledger.read();
    await assert.rejects(r.submit(), (e: unknown) => {
      assert.ok(e instanceof OwedError); assert.equal(e.code, 'refused');
      assert.match(e.message, /limits.file_mib/); assert.match(e.message, /1536 bytes/);
      const rows = e.message.split('\n').slice(2);
      assert.equal(rows.length, 5); assert.match(rows[0]!, /data\/f5/); assert.match(rows[4]!, /data\/f1/);
      assert.doesNotMatch(e.message, /data\/f0|data\/unchanged/); return true;
    });
    assert.deepEqual(await r.ledger.read(), before);
  } finally { await r.cleanup(); }
});

test('BD3: diff limit sums changed paths, including repeated blob ids, without reading content', async () => {
  const r = await submitRig({ file_mib: 1024 / 1024 / 1024, diff_mib: 1024 / 1024 / 1024 });
  try {
    await commitAt(r.worktree, { 'data/a': 'x'.repeat(768), 'data/b': 'x'.repeat(768) });
    const before = await r.ledger.read();
    // The metadata remains below the bound; content output would exceed it.
    git.gitHooks.maxOutputBytes = 512;
    await assert.rejects(r.submit(), (e: unknown) => {
      assert.ok(e instanceof OwedError); assert.equal(e.code, 'refused');
      assert.match(e.message, /limits.diff_mib.*total added\/changed blobs: 1536 bytes/);
      assert.doesNotMatch(e.message, /exceeds .*output|candidate exceeds limits.file_mib/); return true;
    });
    delete git.gitHooks.maxOutputBytes;
    assert.deepEqual(await r.ledger.read(), before);
  } finally { if (git.gitHooks) delete git.gitHooks.maxOutputBytes; await r.cleanup(); }
});

test('BD3: exact limits allow submit; deletions, unchanged files and gitlinks contribute no bytes', async () => {
  const r = await submitRig({ file_mib: 512 / 1024 / 1024, diff_mib: 512 / 1024 / 1024 });
  try {
    await git.git(r.worktree, ['rm', 'data/deleted']);
    const head = await git.revParse(r.worktree, 'HEAD');
    await mkdir(join(r.worktree, 'data/submodule'));
    await git.git(r.worktree, ['update-index', '--add', '--cacheinfo', `160000,${head},data/submodule`]);
    const commit = await commitAt(r.worktree, { 'data/added': 'x'.repeat(512) });
    assert.match((await git.git(r.worktree, ['ls-tree', commit, 'data/submodule'])).stdout, /^160000 commit/);
    const entry = await r.submit(); assert.equal(entry.kind, 'submit');
  } finally { await r.cleanup(); }
});

test('BD3: writer CLI gets a normal refusal and code refused, without a submit receipt', async () => {
  const r = await submitRig({ file_mib: 1 / 1024 / 1024 });
  try {
    await commitAt(r.worktree, { 'data/file': 'too big' });
    const before = await r.ledger.read();
    const result = await cli(r.worktree, ['submit', 'a', '--json']);
    assert.equal(result.code, 1);
    const refusal = JSON.parse(result.stdout) as { code: string; error: string };
    assert.equal(refusal.code, 'refused'); assert.match(refusal.error, /limits.file_mib/);
    assert.match(result.stderr, /Refused:/); assert.doesNotMatch(result.stderr, /Internal error/);
    assert.deepEqual(await r.ledger.read(), before);
  } finally { await r.cleanup(); }
});

test('BD3: absent limits permit submit and limits change no candidate/check/invariant key', async () => {
  const r = await submitRig();
  try {
    const commit = await commitAt(r.worktree, { 'data/file': 'x'.repeat(64 * 1024) });
    assert.equal((await r.submit()).kind, 'submit');
    const plain = parsePlan(planText), limited = { ...plain, limits: { file_mib: 0.00001, diff_mib: 0.00001 } };
    const base = await git.revParse(r.cwd, 'main');
    assert.deepEqual(await git.candidateFacts(r.cwd, limited, limited.nodes[0]!, base, commit, 1), await git.candidateFacts(r.cwd, plain, plain.nodes[0]!, base, commit, 1));
    assert.deepEqual(await git.stateFacts(r.cwd, limited, commit), await git.stateFacts(r.cwd, plain, commit));
  } finally { await r.cleanup(); }
});
