import { readFileSync } from 'node:fs';

export type OwedErrorCode = 'refused' | 'usage' | 'internal' | 'aborted' | 'busy' | 'stale' | 'version';

/** The owed package version (package.json next to src/ or dist/), `unknown` when it cannot be read. */
export const OWED_VERSION: string = (() => { try { return String((JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: unknown }).version); } catch { return 'unknown'; } })();

/**
 * User-facing error. CLI exit codes: refused 1, usage 2, internal 3, busy 75 (a lock is held: retry later, K1),
 * aborted 130/143 (by the signal, SPEC §10). `stale` (F1, 0.11): a driver act decided on a state that another
 * principal's entry on the node has since superseded; nothing was recorded (internal to owed drive). `version`
 * (0.12, G1.5): the ledger holds an entry this owed cannot interpret (a newer owed wrote it); exit 1.
 */
export class OwedError extends Error {
  readonly code: OwedErrorCode;
  constructor(message: string, code: OwedErrorCode = 'refused') {
    super(message);
    this.name = 'OwedError';
    this.code = code;
  }
}
