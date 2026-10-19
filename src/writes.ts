import type { NodeSpec, Plan } from './types.ts';
export type WritesSyntax = 1 | 2 | 3;
/** AO5: syntax 3 adds allow caps, without changing syntax 2 path matching. */
export const planWritesSyntax = (plan: Plan): 2 | 3 => plan.nodes.some(n => n.allow_only !== undefined) ? 3 : 2;
const syntaxTag = Symbol('owed.writesSyntax');
const syntaxes = new WeakMap<Plan, WritesSyntax>();
const syntaxPlans = new WeakMap<Plan, Map<WritesSyntax, Plan>>();
/** Runtime metadata comes only from the recording entry, never the plan JSON or its content hash. */
export const writesSyntax = (plan: Plan): WritesSyntax => syntaxes.get(plan) ?? (plan as Plan & { [syntaxTag]?: WritesSyntax })[syntaxTag] ?? 1;
export function withWritesSyntax(plan: Plan, syntax: WritesSyntax): Plan {
  if (writesSyntax(plan) === syntax && (syntax === 3 || !plan.nodes.some(n => n.allow_only !== undefined))) return plan;
  let versions = syntaxPlans.get(plan);
  if (!versions) syntaxPlans.set(plan, versions = new Map());
  let version = versions.get(syntax);
  if (!version) {
    // Legacy recordings ignored this then-unknown field; never activate it retroactively.
    version = { ...plan, ...(syntax !== 3 && plan.nodes.some(n => n.allow_only !== undefined) ? { nodes:plan.nodes.map(({allow_only: _cap, ...n}) => n) } : {}) }; Object.defineProperty(version, syntaxTag, { value: syntax, enumerable: true }); syntaxes.set(version, syntax); versions.set(syntax, version);
    if (Object.isFrozen(plan)) Object.freeze(version);
  }
  return version;
}
/** Only glob-bearing node scopes change the writes key at a syntax boundary. */
export const writesKeySyntax = (plan: Plan, writes: readonly string[]): { writes_syntax?: 2 } => writesSyntax(plan) !== 1 && writes.some(w => /[?*]/.test(w)) ? { writes_syntax: 2 } : {};
/** Changing the dialect of wildcard-bearing allowances changes permission even when the blob is identical. */
export const writesAllowChanged = (prev: Plan, next: Plan): boolean => (writesSyntax(prev) === 1) !== (writesSyntax(next) === 1) && [...(prev.allow ?? []), ...(next.allow ?? [])].some(r => [...(r.writes ?? []), ...(r.adopt ?? [])].some(w => /[?*]/.test(w)));
/** Validate new plan input only; historical plan parsing must remain 0.20-compatible. */
export function writesSyntaxErrors(plan: Plan, prior?: Plan): string[] {
  const errors: string[] = [];
  const check = (entries: readonly string[], label: string, old: readonly string[] = []) => { for (const entry of entries) { const error = writesEntryError(entry); if (error && !old.includes(entry)) errors.push(`${label}: ${error}`); } };
  for (const n of plan.nodes) check(n.writes, `node ${n.id}.writes`, prior?.nodes.find(p => p.id === n.id)?.writes);
  for (const [i, rule] of (plan.allow ?? []).entries()) { check(rule.writes ?? [], `allow[${i}].writes`, prior?.allow?.[i]?.writes); check(rule.adopt ?? [], `allow[${i}].adopt`, prior?.allow?.[i]?.adopt); }
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
  if (a === b && ((aSyntax === 1) === (bSyntax === 1) || wildcard(a) < 0)) return true;
  const prefix = aSyntax === 1 ? a : prefixOf(a);
  return prefix !== undefined && writesLiteral(b, bSyntax).startsWith(prefix);
}
/** AO1: a literal cap is an exact path, not a writes prefix. */
export const matchesAllowOnly = (node: Pick<NodeSpec, 'allow_only'> | undefined, path: string): boolean => node?.allow_only === undefined || node.allow_only.some(e => wildcard(e) < 0 ? path === e : matchesWrite(path,e,2));
/** AO4: conservative containment, with exact literal entries and syntax 2 globs. */
export function allowOnlyCovers(a: string, b: string): boolean {
  return a === b || (wildcard(a) >= 0 && (wildcard(b) < 0 ? matchesWrite(b,a,2) : writeCovers(a,b,2)));
}
export const allowOnlyWidened = (before: NodeSpec, after: NodeSpec): boolean => before.allow_only !== undefined && (after.allow_only === undefined || after.allow_only.some(b => !before.allow_only!.some(a => allowOnlyCovers(a,b))));
export function allowOnlyRefusal(plan: Plan, id: string, path: string): string | undefined {
  const node = plan.nodes.find(n => n.id === id);
  return matchesAllowOnly(node,path) ? undefined : `${path}: outside allow_only of ${id} [${node!.allow_only!.join(', ')}]`;
}
/** WG3: absence of a disjoint literal prefix means potential overlap, never permission. */
export function writeOverlaps(a: string, b: string, aSyntax: WritesSyntax = 2, bSyntax: WritesSyntax = aSyntax): boolean {
  const p = writesLiteral(a, aSyntax), q = writesLiteral(b, bSyntax);
  return p.startsWith(q) || q.startsWith(p);
}
