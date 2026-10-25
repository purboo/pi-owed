// Production-scale operation bench. Run in a disposable repository copy, never the live ledger.
// node --cpu-prof --max-old-space-size=6144 test/perf/perf-0311.ts status|why|submit|digest|outputs <copy> <node> [commit]
// digest requires a copy with no snapshot and records cold state/output/entry equality artifacts.
// OWED_PERF_ARTIFACTS=<directory> saves those artifacts; OWED_PERF_TS fixes submit time and rendered ages.
// OWED_PERF_PHASES=1 adds source-loader timing only in this benchmark process; src stays untouched.
import { registerHooks } from 'node:module';
import { performance } from 'node:perf_hooks';
const phases: Record<string, { calls: number; ms: number }> = {};
const timed = (name: string, start: number) => { const p = phases[name] ??= { calls: 0, ms: 0 }; p.calls++; p.ms += performance.now() - start; };
(globalThis as any).__owedPerf = timed;
// Keep relative ages deterministic; benchmark durations use performance.now(), never this clock.
if (process.env.OWED_PERF_TS) Date.now = () => Date.parse(process.env.OWED_PERF_TS!);
if (process.env.OWED_PERF_PHASES === '1') registerHooks({ load(url, context, next) {
  const result = next(url, context);
  if (url.endsWith('/src/ledger.ts') && process.env.OWED_PERF_TS) return { ...result, source: String(result.source).replaceAll('new Date().toISOString()', JSON.stringify(process.env.OWED_PERF_TS)) };
  const names = url.endsWith('/src/ops.ts') ? ['load', 'replay', 'cachedPlanSync', 'addReviewCarry', 'candidateConflicts', 'summaryStatusView'] : url.endsWith('/src/git.ts') ? ['candidateFacts', 'conflictPaths'] : url.endsWith('/src/reducer.ts') ? ['reviewCarrySource'] : [];
  if (!names.length) return result;
  let source = String(result.source);
  for (const name of names) {
    const re = new RegExp(`^(?:export )?(async )?function ${name}\\([^\\n]+\\{\\n`, 'm'), match = re.exec(source);
    if (!match) throw new Error(`benchmark cannot instrument ${name}`);
    const start = match.index + match[0].length, end = source.indexOf('\n}', start);
    if (end < 0) throw new Error(`benchmark cannot find end of ${name}`);
    const body = source.slice(start, end), async = !!match[1];
    source = source.slice(0, start) + `const __start = performance.now(); try { return ${async ? 'await ' : ''}(${async ? 'async ' : ''}() => {\n${body}\n})(); } finally { globalThis.__owedPerf('${name}', __start); }` + source.slice(end);
  }
  return { ...result, source };
} });
const ops = await import('../../src/ops.ts');
const { Ledger } = await import('../../src/ledger.ts');
const { renderStatus, renderReceipt, renderEntry } = await import('../../src/views.ts');
for (const name of ['read', 'append'] as const) {
  const original = Ledger.prototype[name];
  (Ledger.prototype as any)[name] = async function(...args: unknown[]) { const start = performance.now(); try { return await (original as any).apply(this,args); } finally { timed(`ledger.${name}`,start); } };
}
const { canonical, sha256 } = await import('../../src/canon.ts');
const { mkdir, writeFile } = await import('node:fs/promises');
const artifact = async (name: string, text: string) => {
  const dir = process.env.OWED_PERF_ARTIFACTS;
  if (dir) { await mkdir(dir, { recursive: true }); await writeFile(`${dir}/${name}`, text); }
};
const [command, cwd, node, commit] = process.argv.slice(2);
if (!cwd || !['status','why','submit','digest','outputs'].includes(command!)) throw new Error('usage: perf-0311.ts status|why|submit|digest|outputs <copy> <node> [commit]');
const start = performance.now(), cpu = process.cpuUsage();
let outcome: unknown;
try {
  if (command === 'digest' || command === 'outputs') {
    let digest: string | undefined, count: number | undefined;
    if (command === 'digest') {
      const { state, entries } = await ops.readState({ cwd });
      if (ops.replayStats.full !== 1 || ops.replayStats.disk) throw new Error('digest requires a cold full replay: remove only the disposable copy snapshot first');
      digest = sha256(canonical(state)); count = entries.length;
      await artifact('digest.json', JSON.stringify({ digest, entries: count, head: state.head }) + '\n');
    }
    await artifact('status.txt', renderStatus(await ops.status({ cwd })));
    await artifact('why.txt', renderReceipt(await ops.why({ cwd, node: node! })));
    const entry = await ops.submit({ cwd, node: node!, commit, as: { role: 'writer', id: `${node}#1` }, model: 'perf-bench' });
    await artifact('entry.json', canonical(entry));
    outcome = { digest, entries: count, seq: entry.seq };
  } else if (command === 'submit') {
    const t = performance.now();
    const entry = await ops.submit({ cwd, node: node!, commit, as: { role: 'writer', id: `${node}#1` }, model: 'perf-bench' });
    timed('submit.operation',t); console.log(renderEntry(entry)); outcome = { seq: entry.seq };
    const post = performance.now(); console.log(renderStatus(await ops.status({cwd}))); timed('submit.output',post);
  } else if (command === 'why') { console.log(renderReceipt(await ops.why({cwd,node:node!}))); }
  else { console.log(renderStatus(await ops.status({cwd}))); }
} finally {
  console.log(JSON.stringify({command,cwd,node,commit,outcome,ms:performance.now()-start,cpu:process.cpuUsage(cpu),maxRssMB:process.resourceUsage().maxRSS/1024,phases,replay:ops.replayStats,plans:ops.planCacheStats()}));
}
