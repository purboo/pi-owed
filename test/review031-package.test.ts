import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('RA1: package discovers and publishes owed-reviewer', async () => {
  const pkg = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.deepEqual(pkg.pi.subagents, { agents: ['./agents'] });
  assert.ok(pkg.files.includes('agents'));
});
