// N4 benchmark (not a test): one fresh process per measurement.
//   OWED_DIR=<ledger dir> node test/helpers/perf-bench.ts status|why|load <repo cwd> [node]
//   node test/helpers/perf-bench.ts synth [entries] [nodes]
// Prints one JSON line: wall ms of the call and the process's peak RSS (MB).
import { performance } from 'node:perf_hooks';
import * as ops from '../../src/ops.ts';
import { reduce } from '../../src/reducer.ts';
import { synthLedger } from './synth.ts';

const [cmd = 'status', cwd = '.', arg] = process.argv.slice(2);
const t0 = performance.now();
let info: unknown;
if (cmd === 'status') { const v = await ops.status({ cwd } as Parameters<typeof ops.status>[0]); info = { nodes: Object.keys(v.nodes).length }; }
else if (cmd === 'why') { const r = await ops.why({ cwd, node: arg! } as Parameters<typeof ops.why>[0]); info = { node: r.node }; }
else if (cmd === 'load') { const r = await ops.verify({ cwd } as Parameters<typeof ops.verify>[0]); info = r; }
else if (cmd === 'warm') {
  // One process, repeated calls (the pi extension case): the first call is cold, later ones hit the plan cache.
  const times: number[] = [];
  for (let i = 0; i < Number(arg ?? 4); i++) { const t = performance.now(); await ops.status({ cwd } as Parameters<typeof ops.status>[0]); times.push(Math.round(performance.now() - t)); }
  (globalThis as { gc?: () => void }).gc?.();
  info = { times, heapMB: Math.round(process.memoryUsage().heapUsed / 2 ** 20), rssMB: Math.round(process.memoryUsage().rss / 2 ** 20) };
}
else if (cmd === 'yaml') {
  // Parse cost alone: every genesis/plan blob of the ledger once.
  const { readFile } = await import('node:fs/promises'); const { parsePlan } = await import('../../src/plan.ts');
  const dir = process.env.OWED_DIR!, shas = new Set((await readFile(`${dir}/ledger.jsonl`, 'utf8')).trim().split('\n').map(l => JSON.parse(l)).filter(e => e.kind === 'genesis' || e.kind === 'plan').map(e => e.plan as string));
  const kept = []; for (const sha of shas) kept.push(parsePlan(await readFile(`${dir}/blobs/${sha}`, 'utf8')));
  (globalThis as { gc?: () => void }).gc?.();
  info = { plans: kept.length, heapMB: Math.round(process.memoryUsage().heapUsed / 2 ** 20) };
}
else if (cmd === 'synth') {
  const { entries, lookup } = synthLedger(Number(cwd === '.' ? 10000 : cwd), Number(arg ?? 200));
  const t1 = performance.now(); const s = reduce(entries, lookup);
  info = { entries: entries.length, nodes: Object.keys(s.nodes).length, merged: Object.values(s.nodes).filter(n => n.merged).length, reduceMs: Math.round(performance.now() - t1) };
}
const ms = Math.round(performance.now() - t0);
console.log(JSON.stringify({ cmd, ms, maxRssMB: Math.round(process.resourceUsage().maxRSS / 1024), info }));
