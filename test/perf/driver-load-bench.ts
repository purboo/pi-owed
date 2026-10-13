// DL5 benchmark, not in the default suite. Run identically on base and candidate:
//   node --expose-gc test/perf/driver-load-bench.ts [entries=6800] [nodes=280] [plans=279]
// Uses the public driver loader (stateOf), not an imitation of either implementation.
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { H } from '../../src/canon.ts';
import { Ledger } from '../../src/ledger.ts';
import { stateOf } from '../../src/drive-run.ts';
import { synthLedger } from './synth.ts';
import { chain, writeLedgerDir } from './synth-dir.ts';

const [size = '6800', nodes = '280', versions = '279'] = process.argv.slice(2);
assert.ok(Number(size) >= 6800 && Number(nodes) >= 280 && Number(versions) >= 250);
async function prepare() {
  const root = await mkdtemp(join(tmpdir(), 'owed-driver-bench-')), dir = join(root, 'owed');
  const { entries, plans } = synthLedger(Number(size), Number(nodes));
  const prior = entries.findLast(e => e.kind === 'genesis' || e.kind === 'plan')!;
  assert.ok(prior.kind === 'genesis' || prior.kind === 'plan');
  let sha = prior.plan;
  // Add immutable versions of the same ~280-node plan; title edits on merged nodes preserve the lifecycle fixture.
  while (plans.size < Number(versions)) {
    const next = structuredClone(plans.get(sha)!);
    next.nodes[0]!.title = `driver bench plan ${plans.size}`;
    const hash = H(next); plans.set(hash, next);
    chain(entries, { kind: 'plan', by: 'parent:bench', prior: sha, plan: hash, downgrades: [] }); sha = hash;
  }
  await writeLedgerDir(dir, entries, plans);
  // Cold means no in-memory replay, disk snapshot or parsed-plan cache, on both trees.
  await rm(join(dir, 'cache'), { recursive: true, force: true });
  return { root, dir, entries: entries.length, plans: plans.size, nodes: Number(nodes) };
}
const fixture = await prepare(), prior = process.env.OWED_DIR;
process.env.OWED_DIR = fixture.dir;
const gc = () => (globalThis as { gc?: () => void }).gc?.();
const results: { phase: string; ms: number; rssMiB: number; maxRssMiB: number; seq: number }[] = [];
async function measure(phase: string) {
  gc(); const start = performance.now(), state = await stateOf(fixture.root), ms = performance.now() - start;
  assert.equal(Object.keys(state.nodes).length, fixture.nodes);
  results.push({ phase, ms: Math.round(ms * 100) / 100, rssMiB: Math.round(process.memoryUsage().rss / 1048576 * 100) / 100, maxRssMiB: Math.round(process.resourceUsage().maxRSS / 1024 * 100) / 100, seq: state.seq });
}
try {
  await measure('cold');
  await measure('warm');
  const ledger = await Ledger.open(fixture.root);
  await ledger.withLock(() => ledger.append(Array.from({ length: 10 }, (_, i) => ({ kind: 'note' as const, by: 'parent:bench', text: `incremental ${i}` }))));
  await measure('incremental');
  console.log(JSON.stringify({ bench: 'driver-load', ...fixture, results }));
} finally {
  if (prior === undefined) delete process.env.OWED_DIR; else process.env.OWED_DIR = prior;
  await rm(fixture.root, { recursive: true, force: true });
}
