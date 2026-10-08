import { createHash } from 'node:crypto';

/** Canonical JSON: object keys sorted recursively, no whitespace, undefined fields dropped. */
export function canonical(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}
function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) {
      const x = (v as Record<string, unknown>)[k];
      if (x !== undefined) out[k] = sortDeep(x);
    }
    return out;
  }
  return v;
}
export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}
/** Item/entry key: sha256 of canonical JSON. */
export function H(value: unknown): string { return sha256(canonical(value)); }
export const ZERO = '0'.repeat(64);
export const EMPTY_SHA = sha256('');
