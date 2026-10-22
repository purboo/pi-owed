import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { ledgerDir } from './ledger.ts';
import { git } from './git.ts';
import { stillAskingNeeds, type StillAsking } from './drive.ts';
import { writerWaitingEligible } from './needs.ts';
import { halted } from './reducer.ts';
import type { AttestJob, State } from './types.ts';
import type { Measuring, Runtime } from './needs-types.ts';

interface Invocation {
  record: Measuring;
  publish(change: () => void): Promise<void>;
  jobs: Map<AttestJob, { obligation: string; candidate: number }>;
}
const invocation = new AsyncLocalStorage<Invocation>();
export function measuringScope(): boolean { return invocation.getStore() !== undefined; }

/** AC1: publish before the lease, without a lock. Recursive lease re-entry shares this invocation only. */
export async function withMeasuring<T>(cwd: string, node: string, run: () => Promise<T>): Promise<T> {
  if (invocation.getStore()) return run();
  const dir = join(await ledgerDir(cwd), 'run');
  await mkdir(dir, { recursive: true });
  const token = randomUUID(), path = join(dir, `attest-${process.pid}-${token}.json`);
  const record: Measuring = { node, obligations: [], do: 'other', phase: 'queued', since: new Date().toISOString(), pid: process.pid, token };
  let writes = Promise.resolve();
  const context: Invocation = { record, jobs: new Map(), publish(change) {
    const next = writes.then(async () => {
      change();
      const tmp = `${path}.tmp`;
      try { await writeFile(tmp, JSON.stringify(record)); await rename(tmp, path); }
      finally { await unlink(tmp).catch(() => {}); }
    });
    writes = next.catch(() => {});
    return next;
  } };
  try {
    await context.publish(() => {});
    return await invocation.run(context, run);
  } finally { await writes; await unlink(path).catch(() => {}); }
}
/** Called only after the operation lock is acquired; gaps between jobs never claim a candidate scope. */
export async function measuringRunning(): Promise<void> {
  const context = invocation.getStore();
  if (context) await context.publish(() => { context.record.phase = 'running'; });
}
/** AC1: a narrow job start/end callback. Invariants and counterfactual jobs do not measure the candidate tree. */
export async function measuringJob<T>(cwd: string, state: State, job: AttestJob, run: () => Promise<T>): Promise<T> {
  const context = invocation.getStore();
  if (!context) return run();
  const candidate = state.nodes[context.record.node]?.candidate;
  const matches = candidate && job.subject === context.record.node && (job.kind === 'check' || job.kind === 'writes')
    && (await git(cwd, ['rev-parse', `${job.commit}^{tree}`])).stdout.trim() === candidate.tree;
  const update = () => {
    const jobs = [...context.jobs.values()];
    context.record.obligations = [...new Set(jobs.map(j => j.obligation))];
    context.record.do = jobs.length ? 'attest' : 'other';
    if (jobs.length) context.record.candidate = jobs[0]!.candidate;
    else delete context.record.candidate;
  };
  try {
    await context.publish(() => { if (matches) context.jobs.set(job, { obligation: job.obligation, candidate: candidate.seq }); update(); });
    return await run();
  } finally { await context.publish(() => { context.jobs.delete(job); update(); }); }
}
function isMeasuring(value: unknown): value is Measuring {
  if (!value || typeof value !== 'object') return false;
  const r = value as Measuring;
  return typeof r.node === 'string' && Array.isArray(r.obligations) && r.obligations.every(o => typeof o === 'string')
    && (r.do === 'attest' || r.do === 'other') && (r.phase === 'queued' || r.phase === 'running')
    && typeof r.since === 'string' && Number.isFinite(Date.parse(r.since)) && Number.isSafeInteger(r.pid) && r.pid > 0
    && typeof r.token === 'string' && (r.candidate === undefined || Number.isSafeInteger(r.candidate));
}
/** AC2: one record per invocation, not per pid. Torn/unreadable records cannot suppress a need. */
export async function readMeasuring(cwd: string): Promise<Measuring[]> {
  const dir = join(await ledgerDir(cwd), 'run'), out: Measuring[] = [];
  const names = await readdir(dir).catch(() => []);
  for (const name of names.sort()) {
    if (!/^attest-\d+-.+\.json$/.test(name)) continue;
    const path = join(dir, name);
    let record: unknown;
    try { record = JSON.parse(await readFile(path, 'utf8')); } catch { continue; }
    if (!isMeasuring(record)) continue;
    try { process.kill(record.pid, 0); }
    catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ESRCH') await unlink(path).catch(() => {});
      if (code !== 'EPERM') continue;
    }
    out.push(record);
  }
  return out;
}
/** AC3: the one runtime assembler. Unknown driver state stays unknown; only a running driver owns its cache. */
export async function assembleRuntime(o: { cwd: string; state: State; driverRunning?: boolean; now?: number }): Promise<Runtime> {
  const runtime: Runtime = { measuring: await readMeasuring(o.cwd) };
  if (o.driverRunning === undefined) return runtime;
  runtime.driverRunning = o.driverRunning;
  runtime.asking = [];
  if (!o.driverRunning) return runtime;
  try {
    const rows: NonNullable<Runtime['writerWaiting']> = JSON.parse(await readFile(join(await ledgerDir(o.cwd), 'drive', 'writer-waiting.json'), 'utf8'));
    if (Array.isArray(rows)) runtime.writerWaiting = rows.filter(row => {
      const n = o.state.nodes[row?.node];
      return n?.slot?.open && writerWaitingEligible(o.state, row.node) && n.slot.attempt === row.attempt && Number.isFinite(row.since)
        && n.runs.find(a => a.attempt === row.attempt)?.launches.some(l => l.role === 'writer' && l.rid === row.rid)
        && Array.isArray(row.awaiting) && row.awaiting.length > 0 && row.awaiting.every((a: NonNullable<import('./types.ts').RunView['awaiting']>[number]) => a && typeof a.request === 'string' && ['pending', 'running', 'finished'].includes(a.state));
    });
    if (runtime.writerWaiting?.length) runtime.now = o.now ?? Date.now();
  } catch { /* unknown runtime facts */ }
  // HT4: the running driver's stale-halt records, kept only while each is still its node's active halt.
  try {
    const rows: unknown = JSON.parse(await readFile(join(await ledgerDir(o.cwd), 'drive', 'stale-halts.json'), 'utf8'));
    const kept = Array.isArray(rows) ? rows.filter((r): r is NonNullable<Runtime['staleHalts']>[number] => !!r && typeof r.node === 'string' && Number.isSafeInteger(r.seq)
      && typeof r.rid === 'string' && Number.isSafeInteger(r.gen) && halted(o.state, r.node)?.seq === r.seq).map(r => ({ node: r.node, seq: r.seq, rid: r.rid, gen: r.gen })) : [];
    if (kept.length) runtime.staleHalts = kept;
  } catch { /* absent or unreadable: unknown */ }
  let cached: unknown;
  try { cached = JSON.parse(await readFile(join(await ledgerDir(o.cwd), 'drive', 'asking.json'), 'utf8')); } catch { return runtime; }
  if (!Array.isArray(cached)) return runtime;
  const valid = cached.filter((a): a is StillAsking => !!a && typeof a.node === 'string' && typeof a.rid === 'string' && typeof a.qid === 'string' && Number.isSafeInteger(a.rev));
  runtime.asking = valid.flatMap(row => stillAskingNeeds(o.state, [row], o.now ?? Date.now()).map(({ text }) => ({ ...row, text })));
  return runtime;
}
