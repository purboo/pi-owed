// LE1–LE3: one machine lease around a measurement, never part of a check or invariant key.
import { AsyncLocalStorage } from 'node:async_hooks';
import { Dsa, dsaAvailable } from './dsa.ts';
import { currentLockDeadline } from './lock-deadline.ts';
import { OwedError } from './errors.ts';

const scope = new AsyncLocalStorage<{ leased: boolean; waitMs?: number }>();
export const LEASE = 'machine (shared)';
export interface LeaseOptions { cwd: string; lease?: boolean; signal?: AbortSignal; noWait?: boolean; priority?: number; yield?: boolean; dsa?: Dsa }
/** Concurrent in-process measurements must not set process.env: each has its own lease context. */
export function machineLeased(): boolean { return scope.getStore()?.leased === true || process.env.OWED_LEASED === '1'; }
export function measurementScope(): boolean { return scope.getStore() !== undefined; }
export function leaseEnvironment(): NodeJS.ProcessEnv { return machineLeased() ? { OWED_LEASED: '1' } : {}; }
export function leaseText(r: { lease?: string }): string { return r.lease ? `\nlease: ${r.lease}` : ''; }
/** MX3: `lease_wait_ms` for an obs/merge recorded inside a leased measurement: the wait before the command started. */
export function leaseWaitField(): { lease_wait_ms?: number } {
  const ms = scope.getStore()?.waitMs;
  return ms === undefined ? {} : { lease_wait_ms: ms };
}

/** AW #2090: bound only lease acquisition; checks retain their own execution timeout. */
async function leaseBeforeDeadline<T>(signal: AbortSignal | undefined, run: (signal: AbortSignal | undefined, acquired: () => void) => Promise<T>): Promise<T> {
  const deadline = currentLockDeadline();
  if (deadline === undefined) return run(signal,() => {});
  const ac = new AbortController();
  let expired = false, timer: ReturnType<typeof setTimeout> | undefined;
  const busy = () => new OwedError('timed out waiting for the machine lease within adopt wait budget; retry','busy');
  const abort = () => ac.abort();
  signal?.addEventListener('abort',abort,{once:true});
  if (signal?.aborted) ac.abort();
  const arm = () => {
    const remaining = deadline-Date.now();
    if (remaining <= 0) { expired=true;ac.abort();return; }
    timer=setTimeout(arm,Math.min(remaining,2_147_483_647));
  };
  arm();
  try {
    const result = await run(ac.signal,() => {clearTimeout(timer);if (expired) throw busy();});
    if (expired && !signal?.aborted) throw busy();
    return result;
  } catch (e) { if (expired && !signal?.aborted) throw busy();throw e; }
  finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
/** Waiting by default; the driver uses noWait and handles OwedError('busy') as a later-pass retry. */
export async function withMachineLease<T>(o: LeaseOptions, measure: (signal?: AbortSignal) => Promise<T>): Promise<T> {
  if (o.signal?.aborted) throw new OwedError('aborted', 'aborted');
  const dsa = o.dsa ?? new Dsa();
  if (measurementScope() || machineLeased() || o.lease === false || !dsaAvailable(dsa.bin)) {
    const outer = scope.getStore()?.waitMs;
    return scope.run({ leased: machineLeased(), ...(outer !== undefined ? { waitMs: outer } : {}) }, () => measure(o.signal));
  }
  const started = Date.now();
  try {
    const r = await leaseBeforeDeadline(o.signal,(signal,acquired) => dsa.holdWhile('machine', signal => {
      acquired();
      return scope.run({ leased: true, waitMs: Math.max(0, Date.now() - started) }, () => measure(signal));
    }, { shared: true, cwd: o.cwd, noWait: o.noWait, priority:o.priority, yield:o.yield, signal }));
    if (r.outcome === 'busy') throw new OwedError(r.reason, 'busy');
    if (r.outcome === 'refused') throw new OwedError(`pi-durable-subagents hold refused: ${r.reason}`);
    return r.value;
  } catch (e) { if (o.signal?.aborted) throw new OwedError('aborted', 'aborted'); throw e; }
}
/** Result metadata only (not a ledger field). */
export function leaseResult<T extends object>(r: T): T & { lease?: string } { return machineLeased() ? { ...r, lease: LEASE } : r; }
