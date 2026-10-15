import type { Plan } from './types.ts';
export type WritesSyntax = 1 | 2;
const syntaxes = new WeakMap<Plan, WritesSyntax>();
const syntaxPlans = new WeakMap<Plan, Map<WritesSyntax, Plan>>();
/** Runtime metadata comes only from the recording entry, never the plan JSON or its content hash. */
export const writesSyntax = (plan: Plan): WritesSyntax => syntaxes.get(plan) ?? 1;
export function withWritesSyntax(plan: Plan, syntax: WritesSyntax): Plan {
  if (writesSyntax(plan) === syntax) return plan;
  let versions = syntaxPlans.get(plan);
  if (!versions) syntaxPlans.set(plan, versions = new Map());
  let version = versions.get(syntax);
  if (!version) {
    version = { ...plan }; syntaxes.set(version, syntax); versions.set(syntax, version);
    if (Object.isFrozen(plan)) Object.freeze(version);
  }
  return version;
}
/** Only glob-bearing node scopes change the writes key at a syntax boundary. */
export const writesKeySyntax = (plan: Plan, writes: readonly string[]): { writes_syntax?: 2 } => writesSyntax(plan) === 2 && writes.some(w => /[?*]/.test(w)) ? { writes_syntax: 2 } : {};
/** Changing the dialect of wildcard-bearing allowances changes permission even when the blob is identical. */
export const writesAllowChanged = (prev: Plan, next: Plan): boolean => writesSyntax(prev) !== writesSyntax(next) && [...(prev.allow ?? []), ...(next.allow ?? [])].some(r => [...(r.writes ?? []), ...(r.adopt ?? [])].some(w => /[?*]/.test(w)));
/** Validate new plan input only; historical plan parsing must remain 0.20-compatible. */
export function writesSyntaxErrors(plan: Plan): string[] {
  const errors: string[] = [];
  const check = (entries: readonly string[], label: string) => { for (const entry of entries) { const error = writesEntryError(entry); if (error) errors.push(`${label}: ${error}`); } };
  for (const n of plan.nodes) check(n.writes, `node ${n.id}.writes`);
  for (const [i, rule] of (plan.allow ?? []).entries()) { check(rule.writes ?? [], `allow[${i}].writes`); check(rule.adopt ?? [], `allow[${i}].adopt`); }
  return errors;
}
/** WG: writes uses a deliberately small grammar, independent of platform glob dialects. */
export function writesEntryError(entry: string): string | undefined {
  if (!entry || entry.startsWith('/') || entry.split('/').includes('..') || /[\[\]{}!\\]/.test(entry) || entry.split('/').some(s => s.includes('**') && s !== '**'))
    return `invalid writes entry ${JSON.stringify(entry)}; use a relative prefix or *, ?, and whole-segment **`;
  return undefined;
}
const wildcard = (entry: string): number => entry.search(/[?*]/);
export const writesLiteral = (entry: string, syntax: WritesSyntax = 2): string => { const i = syntax === 1 ? -1 : wildcard(entry); return i < 0 ? entry : entry.slice(0, i); };
/** A trailing ** is precisely the old directory prefix (including nested trailing **). */
function prefixOf(entry: string): string | undefined {
  const prefix = entry.replace(/(?:\*\*\/)*\*\*$/, '');
  return wildcard(prefix) < 0 ? prefix : undefined;
}
/** Prefix entries retain byte-for-byte startsWith semantics; glob entries match the entire path. */
export function matchesWrite(path: string, entry: string, syntax: WritesSyntax = 2): boolean {
  if (syntax === 1 || wildcard(entry) < 0) return path.startsWith(entry);
  const prefix = prefixOf(entry);
  if (prefix !== undefined) return path.startsWith(prefix);
  const segments = entry.split('/'), escaped = (s: string) => s.replace(/[.+^$()|[\]{}\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\?/g, '[^/]');
  let pattern = '';
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i]!;
    if (s === '**') pattern += i === segments.length - 1 ? '(?:[^/]+(?:/[^/]+)*)?' : '(?:[^/]+/)*';
    else pattern += escaped(s) + (i < segments.length - 1 ? '/' : '');
  }
  return new RegExp(`^${pattern}(?![\\s\\S])`).test(path);
}
/** WG3: prove containment only by equality or an enclosing literal prefix. */
export function writeCovers(a: string, b: string, aSyntax: WritesSyntax = 2, bSyntax: WritesSyntax = aSyntax): boolean {
  if (a === b && (aSyntax === bSyntax || wildcard(a) < 0)) return true;
  const prefix = aSyntax === 1 ? a : prefixOf(a);
  return prefix !== undefined && writesLiteral(b, bSyntax).startsWith(prefix);
}
/** WG3: absence of a disjoint literal prefix means potential overlap, never permission. */
export function writeOverlaps(a: string, b: string, aSyntax: WritesSyntax = 2, bSyntax: WritesSyntax = aSyntax): boolean {
  const p = writesLiteral(a, aSyntax), q = writesLiteral(b, bSyntax);
  return p.startsWith(q) || q.startsWith(p);
}
