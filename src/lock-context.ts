import { AsyncLocalStorage } from 'node:async_hooks';
import { OwedError } from './errors.ts';

// Process-wide context: opening another Ledger must not hide a held ledger lock.
// DF5: `dir` names the ledger directory whose `lock` the token holds (any Ledger instance of that directory).
export const ledgerLocks = new AsyncLocalStorage<Set<{ active: boolean; dir?: string }>>();
export function assertNoLedgerLock(): void {
  if ([...(ledgerLocks.getStore() ?? [])].some(lock => lock.active)) throw new OwedError('cannot start a command while holding the ledger lock; move execution outside withLock()', 'internal');
}
