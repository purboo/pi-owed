export type OwedErrorCode = 'refused' | 'usage' | 'internal';

/** User-facing error. CLI exit codes: refused 1, usage 2, internal 3. */
export class OwedError extends Error {
  readonly code: OwedErrorCode;
  constructor(message: string, code: OwedErrorCode = 'refused') {
    super(message);
    this.name = 'OwedError';
    this.code = code;
  }
}
