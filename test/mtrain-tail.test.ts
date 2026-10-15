// MTT: bounded batch-tail probes and actionable recovery hints (ruling #2110).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { git } from '../src/git.ts';
import type { Entry } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { commitAt } from './helpers/surface.ts';

const parent = { role: 'parent', id: 'test' } as const;
const owner = { role: 'owner', id: 'human' } as const;

function recovery(text: string, final: string) {
  assert.doesNotMatch(text, /adopt/i);
  assert.ok(text.includes(`restore refs/heads/main to ${final}`), text);
  assert.ok(text.includes(`git update-ref refs/heads/main ${final}`), text);
  assert.match(text, /then any owed write completes the batch/);
  assert.match(text, /ledger tail and trunk disagree and need manual repair/);
}

test('MTT1: an owed write probes at most 64 KiB on a 16 MiB ledger with a non-batch last entry', async () => {
  const r = await repo();
  try {
    await commitAt(r.cwd, { README: 'x' });
    await ops.init({ cwd: r.cwd, as: owner, channel: 'flag', plan: JSON.stringify({ version: 1, trunk: 'main', invariants: [], nodes: [] }) });
    const ledger = await Ledger.open(r.cwd);
    await ledger.withLock(() => ledger.append([
      { kind: 'rule', by: 'parent:test', nodes: '*', text: 'x'.repeat(16 * 1024 * 1024) },
      { kind: 'rule', by: 'parent:test', nodes: '*', text: 'small last entry' },
    ]));
    const reads: number[] = [];
    ops.batchTailProbe.onRead = bytes => reads.push(bytes);
    try { await ops.rule({ cwd: r.cwd, as: parent, nodes: '*', text: 'a real owed write' }); }
    finally { delete ops.batchTailProbe.onRead; }
    assert.ok(reads.length > 0, 'the positioned tail probe ran');
    assert.ok(reads.reduce((a, b) => a + b, 0) <= 64 * 1024, `probe bytes: ${reads}`);
    assert.equal((await ledger.read()).at(-1)?.kind, 'rule');
  } finally { await r.cleanup(); }
});

test('MTT1: a last line larger than 64 KiB grows the probe, and partial JSON is left for locked validation', async () => {
  const r = await repo();
  try {
    const ledger = await Ledger.open(r.cwd), file = join(ledger.dir, 'ledger.jsonl');
    await writeFile(file, JSON.stringify({ kind: 'rule', text: '界'.repeat(40_000) }) + '\n');
    let bytes = 0;
    ops.batchTailProbe.onRead = n => { bytes += n; };
    try { await ledger.withLock(async () => {}); }
    finally { delete ops.batchTailProbe.onRead; }
    assert.ok(bytes > 64 * 1024, 'read through to the start of the oversized last line');
    await writeFile(file, '{"kind":"merge","batch":');
    await assert.rejects(ledger.withLock(() => ledger.read()), /invalid JSON/);
    await writeFile(file, '');
    await ledger.withLock(async () => {});
  } finally { await r.cleanup(); }
});

test('MTT1/MTT2: torn batch completion survives tail probing; verify, refusal and history mismatch give truthful hints', { timeout: 180_000 }, async () => {
  const r = await repo();
  try {
    await commitAt(r.cwd, { README: 'x' });
    const nodes = ['a', 'b', 'c'].map(id => ({ id, writes: [`${id}.txt`], checks: [], review: { count: 0, min_rank: 1 } }));
    await ops.init({ cwd: r.cwd, as: owner, channel: 'flag', plan: JSON.stringify({ version: 1, trunk: 'main', invariants: [], nodes }) });
    for (const { id } of nodes) {
      const slot = await ops.dispatch({ cwd: r.cwd, node: id, as: parent });
      await commitAt(slot.worktree, { [`${id}.txt`]: id });
      await ops.submit({ cwd: slot.worktree, node: id, as: { role: 'writer', id: `${id}#1` } });
      assert.equal((await ops.attest({ cwd: r.cwd, node: id })).accepted, true);
    }
    await ops.mergeBatch({ cwd: r.cwd, as: parent, nodes: ['a', 'b', 'c'] });
    const ledger = await Ledger.open(r.cwd), file = join(ledger.dir, 'ledger.jsonl');
    const lines = (await readFile(file, 'utf8')).trimEnd().split('\n');
    const last = JSON.parse(lines.at(-1)!) as Extract<Entry, { kind: 'merge' }>;
    await writeFile(file, lines.slice(0, -1).join('\n') + '\n');
    await rm(join(ledger.dir, 'snapshot'), { recursive: true, force: true });
    const verify = await ops.verify({ cwd: r.cwd });
    assert.equal(verify.ok, true);
    recovery(verify.incompleteBatch!, last.commit);
    await git(r.cwd, ['update-ref', 'refs/heads/main', last.prior]);
    await assert.rejects(ops.rule({ cwd: r.cwd, as: parent, nodes: '*', text: 'blocked' }), (e: Error) => {
      recovery(e.message, last.commit); return true;
    });
    assert.equal((await ledger.read()).length, lines.length - 1, 'refusal appends nothing');
    await git(r.cwd, ['update-ref', 'refs/heads/main', last.commit]);
    const base = (await git(r.cwd, ['rev-parse', `${last.prior}~1`])).stdout.trim();
    // Reflog restoration alone cannot repair a first-parent history inconsistent with the ledger.
    await git(r.cwd, ['replace', '--graft', last.commit, base]);
    try {
      await assert.rejects(ops.rule({ cwd: r.cwd, as: parent, nodes: '*', text: 'blocked history' }), (e: Error) => {
        assert.match(e.message, /commits do not match the trunk history/);
        recovery(e.message, last.commit); return true;
      });
    } finally { await git(r.cwd, ['replace', '-d', last.commit]); }
    const rule = await ops.rule({ cwd: r.cwd, as: parent, nodes: '*', text: 'recovered' });
    const completed = (await ledger.read())[last.seq] as typeof last;
    assert.equal(completed.by, 'executor:owed');
    assert.equal(completed.commit, last.commit);
    assert.deepEqual(completed.batch, last.batch);
    assert.deepEqual(completed.facts, last.facts);
    assert.equal(rule.seq, last.seq + 1);
    assert.equal((await ops.verify({ cwd: r.cwd })).incompleteBatch, undefined);
  } finally { await r.cleanup(); }
});
