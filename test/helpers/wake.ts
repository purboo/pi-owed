import assert from 'node:assert/strict';
/** NY4: compare retained wake facts once, independent of summary-first presentation order. */
export function assertWakeLines(message: string | undefined, expected: string[], note?: string): void {
  assert.ok(message, 'wake message exists');
  assert.doesNotMatch(message, /(?:^|\n)Details:/);
  const facts = message.split('\n').filter(l => !/^Done: |^Driver continues /.test(l) && (expected.some(e => e.startsWith('owed drive (')) || !l.startsWith('owed drive ('))).map(l => l.replace(/^Needs you: /, '').replace(/^Driver stopped: /, ''));
  assert.deepEqual(facts.sort(), [...expected].sort(), note);
}
