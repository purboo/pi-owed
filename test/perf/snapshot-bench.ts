// G1 benchmark (not a test): the in-process second load after appending one entry.
//   OWED_DIR=<ledger dir copy> node test/perf/snapshot-bench.ts [rounds]
// Loads once (cold or from the disk snapshot), then per round appends one note entry and loads again in the same
// process. Prints one JSON line: the first load's ms and, per round, the second load's ms (replayMs: after the ledger
// read: cache deserialization, fold, cache refresh) and the replay path.
import { performance } from 'node:perf_hooks';
import { Ledger } from '../../src/ledger.ts';
import * as ops from '../../src/ops.ts';

const rounds = Number(process.argv[2] ?? 5), cwd = process.cwd(), ledger = await Ledger.open(cwd);
let t = performance.now();
const first = await ops.readState({ cwd });
const firstMs = Math.round(performance.now() - t), seconds: { ms: number; replayMs: number; path: string }[] = [];
for (let i = 0; i < rounds; i++) {
  await ledger.withLock(async () => { await ledger.append([{ kind: 'note', by: 'parent:bench', text: `bench ${i}` }]); });
  const before = { ...ops.replayStats };
  t = performance.now();
  await ops.readState({ cwd });
  const ms = performance.now() - t, path = (['full', 'memo', 'disk'] as const).find(k => ops.replayStats[k] > before[k]) ?? '?';
  seconds.push({ ms: Math.round(ms * 10) / 10, replayMs: Math.round((ops.replayStats.ms - before.ms) * 10) / 10, path });
}
console.log(JSON.stringify({ entries: first.entries.length, firstMs, seconds }));
