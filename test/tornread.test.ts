// 0.20 node tornread (contract TR): an unlocked read ignores a final fragment of an append in flight (TR1); a read
// under the lock still reports it (TR2). Deterministic: the torn bytes are written directly, no timing race.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFile, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Ledger } from '../src/ledger.ts';
import type { Draft } from '../src/types.ts';
import { repo } from './helpers/repo.ts';

const draft = (text: string) => ({ kind: 'rule', text, nodes: '*', by: { role: 'owner', id: 'human' } }) as unknown as Draft;

/** An unlocked read that must succeed; an error fails the test as an assertion. */
async function unlockedRead(ledger: Ledger) {
  try { return await ledger.read(); } catch (e) { assert.fail(`unlocked read failed: ${(e as Error).message}`); }
}

/** A ledger with two complete entries and the text of the next, complete entry line. */
async function setup() {
  const r = await repo();
  const ledger = await Ledger.open(r.cwd);
  const file = join(ledger.dir, 'ledger.jsonl');
  await ledger.withLock(() => ledger.append([draft('one'), draft('two')]));
  const valid = await readFile(file, 'utf8');
  const next = await ledger.withLock(async () => {
    const [e] = await ledger.append([draft('three')]);
    return JSON.stringify(e) + '\n';
  });
  await writeFile(file, valid);
  return { r, ledger, file, valid, next };
}

test('TR1 an unlocked read ignores a torn final fragment and returns the complete entries', async () => {
  const { r, ledger, file, next } = await setup();
  try {
    await appendFile(file, next.slice(0, Math.floor(next.length / 2)));
    const entries = await unlockedRead(ledger);
    assert.deepEqual(entries.map(e => (e as { text?: string }).text), ['one', 'two']);
    // The append completes: the next unlocked read sees all three entries.
    await appendFile(file, next.slice(Math.floor(next.length / 2)));
    assert.deepEqual((await unlockedRead(ledger)).map(e => (e as { text?: string }).text), ['one', 'two', 'three']);
  } finally { await r.cleanup(); }
});

test('TR1 an unlocked read still fails on a malformed complete line', async () => {
  const { r, ledger, file, next } = await setup();
  try {
    await appendFile(file, next.slice(0, Math.floor(next.length / 2)) + '\n');
    await assert.rejects(ledger.read(), (e: Error) => e.message === 'ledger seq 2: invalid JSON');
  } finally { await r.cleanup(); }
});

test('TR2 a read under the lock reports a torn final fragment', async () => {
  const { r, ledger, file, valid, next } = await setup();
  try {
    await appendFile(file, next.slice(0, Math.floor(next.length / 2)));
    await assert.rejects(ledger.withLock(() => ledger.read()), (e: Error) => e.message === 'ledger seq 2: invalid JSON');
    // A complete JSON object without its newline is still an incomplete line under the lock; unlocked it is ignored.
    await writeFile(file, valid + next.slice(0, -1));
    await assert.rejects(ledger.withLock(() => ledger.read()), (e: Error) => e.message === 'ledger seq 2: incomplete line');
    assert.equal((await unlockedRead(ledger)).length, 2);
  } finally { await r.cleanup(); }
});
