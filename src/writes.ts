/** WG: writes uses a deliberately small grammar, independent of platform glob dialects. */
export function writesEntryError(entry: string): string | undefined {
  if (!entry || entry.startsWith('/') || entry.split('/').includes('..') || /[\[\]{}!\\]/.test(entry) || entry.split('/').some(s => s.includes('**') && s !== '**'))
    return `invalid writes entry ${JSON.stringify(entry)}; use a relative prefix or *, ?, and whole-segment **`;
  return undefined;
}
const wildcard = (entry: string): number => entry.search(/[?*]/);
export const writesLiteral = (entry: string): string => { const i = wildcard(entry); return i < 0 ? entry : entry.slice(0, i); };
/** A trailing ** is precisely the old directory prefix (including nested trailing **). */
function prefixOf(entry: string): string | undefined {
  const prefix = entry.replace(/(?:\*\*\/)*\*\*$/, '');
  return wildcard(prefix) < 0 ? prefix : undefined;
}
/** Prefix entries retain byte-for-byte startsWith semantics; glob entries match the entire path. */
export function matchesWrite(path: string, entry: string): boolean {
  if (wildcard(entry) < 0) return path.startsWith(entry);
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
export function writeCovers(a: string, b: string): boolean {
  if (a === b) return true;
  const prefix = prefixOf(a);
  return prefix !== undefined && writesLiteral(b).startsWith(prefix);
}
/** WG3: absence of a disjoint literal prefix means potential overlap, never permission. */
export function writeOverlaps(a: string, b: string): boolean {
  const p = writesLiteral(a), q = writesLiteral(b);
  return p.startsWith(q) || q.startsWith(p);
}
