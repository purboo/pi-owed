// LE1–LE3: one machine lease around a measurement, never part of a check or invariant key.
import { AsyncLocalStorage } from 'node:async_hooks';
import { Dsa, dsaAvailable } from './dsa.ts';
import { OwedError } from './errors.ts';

const scope = new AsyncLocalStorage<{ leased: boolean }>();
export const LEASE = 'machine (shared)';
export interface LeaseOptions { cwd: string; lease?: boolean; signal?: AbortSignal; noWait?: boolean; dsa?: Dsa }
/** Concurrent in-process measurements must not set process.env: each has its own lease context. */
export function machineLeased(): boolean { return scope.getStore()?.leased === true || process.env.OWED_LEASED === '1'; }
export function measurementScope(): boolean { return scope.getStore() !== undefined; }
export function leaseEnvironment(): NodeJS.ProcessEnv { return machineLeased() ? { OWED_LEASED: '1' } : {}; }
export function leaseText(r: { lease?: string }): string { return r.lease ? `\nlease: ${r.lease}` : ''; }

/** Waiting by default; the driver uses noWait and handles OwedError('busy') as a later-pass retry. */
export async function withMachineLease<T>(o: LeaseOptions, measure: (signal?: AbortSignal) => Promise<T>): Promise<T> {
  if (o.signal?.aborted) throw new OwedError('aborted', 'aborted');
  const dsa = o.dsa ?? new Dsa();
  if (measurementScope() || machineLeased() || o.lease === false || !dsaAvailable(dsa.bin)) {
    return scope.run({ leased: machineLeased() }, () => measure(o.signal));
  }
  try {
    const r = await dsa.holdWhile('machine', signal => scope.run({ leased: true }, () => measure(signal)), { shared: true, cwd: o.cwd, noWait: o.noWait, signal: o.signal });
    if (r.outcome === 'busy') throw new OwedError(r.reason, 'busy');
    if (r.outcome === 'refused') throw new OwedError(`pi-durable-subagents hold refused: ${r.reason}`);
    return r.value;
  } catch (e) { if (o.signal?.aborted) throw new OwedError('aborted', 'aborted'); throw e; }
}
/** Result metadata only (not a ledger field). */
export function leaseResult<T extends object>(r: T): T & { lease?: string } { return machineLeased() ? { ...r, lease: LEASE } : r; }
