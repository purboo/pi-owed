// G1 (0.12): a synthetic ledger as an owed ledger directory: ledger.jsonl, each plan as a blob (its canonical JSON, a
// YAML document whose sha256 is the plan sha synth uses) and a persistent plan cache entry per plan. Also a CLI for the bench-host benchmark:
//   node test/perf/synth-dir.ts <dir> [entries] [nodes]
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical } from '../../src/canon.ts';
import { entryHash, PLAN_CACHE_VERSION } from '../../src/ledger.ts';
import type { Draft, Entry, Plan } from '../../src/types.ts';
import { synthLedger } from './synth.ts';

export async function writeLedgerDir(dir: string, entries: Entry[], plans: Map<string, Plan>): Promise<void> {
  await mkdir(join(dir, 'blobs'), { recursive: true }); await mkdir(join(dir, 'cache', 'plans'), { recursive: true });
  await writeFile(join(dir, 'ledger.jsonl'), entries.map(e => JSON.stringify(e) + '\n').join(''));
  for (const [sha, plan] of plans) {
    await writeFile(join(dir, 'blobs', sha), canonical(plan));
    await writeFile(join(dir, 'cache', 'plans', `${sha}.json`), JSON.stringify({ v: PLAN_CACHE_VERSION, sha, plan }));
  }
}
/** `entries` with `d` appended as the ledger would (seq, ts, prev, hash); returns the new entry. */
export function chain(entries: Entry[], d: Draft | Record<string, unknown>): Entry {
  const e = { ...d, seq: entries.length, ts: new Date(Date.UTC(2026, 6, 1) + entries.length * 1000).toISOString(), prev: entries.at(-1)?.hash ?? '0'.repeat(64) } as Entry;
  e.hash = entryHash(e); entries.push(e); return e;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [dir, n = '10000', nodes = '200'] = process.argv.slice(2);
  const { entries, plans } = synthLedger(Number(n), Number(nodes));
  await writeLedgerDir(dir!, entries, plans);
  console.log(JSON.stringify({ dir, entries: entries.length, plans: plans.size }));
}
