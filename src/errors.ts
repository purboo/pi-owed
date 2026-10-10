export type OwedErrorCode = 'refused' | 'usage' | 'internal' | 'aborted' | 'busy';

/**
 * User-facing error. CLI exit codes: refused 1, usage 2, internal 3, busy 75 (a lock is held: retry later, K1),
 * aborted 130/143 (by the signal, SPEC §10).
 */
export class OwedError extends Error {
  readonly code: OwedErrorCode;
  constructor(message: string, code: OwedErrorCode = 'refused') {
    super(message);
    this.name = 'OwedError';
    this.code = code;
  }
}
