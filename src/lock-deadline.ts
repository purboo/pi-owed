import { AsyncLocalStorage } from 'node:async_hooks';

// A wait budget spans nested acquisitions and Ledger instances without changing
// other operations' default wait or the timeout of a measurement already started.
const deadlines = new AsyncLocalStorage<number>();
export const currentLockDeadline = (): number | undefined => deadlines.getStore();
export function withLockDeadline<T>(deadline: number, run: () => Promise<T>): Promise<T> {
  return deadlines.run(Math.min(deadline,deadlines.getStore() ?? Infinity),run);
}
