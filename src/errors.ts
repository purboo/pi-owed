export type OwedErrorCode = 'refused' | 'usage' | 'internal' | 'aborted';

/** User-facing error. CLI exit codes: refused 1, usage 2, internal 3, aborted 130/143 (by the signal, SPEC §10). */
export class OwedError extends Error {
  readonly code: OwedErrorCode;
  constructor(message: string, code: OwedErrorCode = 'refused') {
    super(message);
    this.name = 'OwedError';
    this.code = code;
  }
}
