import { readFile, writeFile, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { Ledger } from './ledger.ts';
import { OwedError } from './errors.ts';

export interface AdoptPending { pid: number; host: string; commit: string; since: string }
export function adoptWaitMs(wait?: number): number | undefined {
  if (wait === undefined) return undefined;
  if (!Number.isFinite(wait) || wait < 0 || wait * 1000 > Number.MAX_SAFE_INTEGER) throw new OwedError('adopt wait must be finite non-negative seconds; use --wait <seconds>', 'usage');
  return wait * 1000;
}
/** A foreign host cannot be probed locally; retain its request conservatively. */
export async function pendingAdopt(dir: string): Promise<AdoptPending | undefined> {
  try {
    const p = JSON.parse(await readFile(join(dir,'adopt-pending.json'),'utf8')) as AdoptPending;
    if (!p || typeof p !== 'object' || !Number.isSafeInteger(p.pid) || p.pid <= 0 || typeof p.host !== 'string' || typeof p.commit !== 'string' || !Number.isFinite(Date.parse(p.since))) return undefined;
    if (p.host === hostname()) {
      try { process.kill(p.pid,0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EPERM') return undefined; }
    }
    return p;
  } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT' || e instanceof SyntaxError) return undefined; throw e; }
}
export const mergeWaitSuffix = (reason: string, since: string): string => reason.startsWith('adopt (pending since ') ? '' : ` since ${new Date(since).toISOString().slice(11,16)}`;
export const adoptPendingReason = (p: AdoptPending): string => `adopt (pending since ${p.since.slice(11,16)})`;
/** One publisher owns the singleton marker until all lease/merge work has ended. */
export async function withAdoptPending<T>(ledger: Ledger, commit: string, waitMs: number | undefined, signal: AbortSignal | undefined, run: () => Promise<T>): Promise<T> {
  return ledger.withLock(async () => {
    const path = join(ledger.dir,'adopt-pending.json');
    await writeFile(path,JSON.stringify({pid:process.pid,host:hostname(),commit,since:new Date().toISOString()} satisfies AdoptPending));
    try { return await run(); } finally { await unlink(path); }
  },'adopt-queue',signal,{waitMs,activity:'adopt'});
}
