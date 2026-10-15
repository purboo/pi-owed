import { isDeepStrictEqual } from 'node:util';
import { canonical } from './canon.ts';
import { matchesWrite } from './writes.ts';
import type { Downgrade, NodeSpec, Plan, RiskRule } from './types.ts';

export interface ReviewRequirement { count: number; min_rank: number; cause: string }
/** RK1: review is derived from the candidate's own paths, never the merge result or writer input. */
export function reviewRequirement(plan: Plan, spec: NodeSpec, changed: readonly string[]): ReviewRequirement {
  const paths = changed.map(path => {
    const rule = (plan.risk ?? []).findIndex(r => r.paths.some(scope => matchesWrite(path, scope)));
    return { path, rule, review: rule < 0 ? spec.review : plan.risk![rule]!.review };
  });
  // An empty patch retains the node's review: it cannot claim membership in a risk class.
  const count = paths.reduce((max, p) => Math.max(max, p.review.count), paths.length ? 0 : spec.review.count);
  const min_rank = paths.reduce((max, p) => Math.max(max, p.review.min_rank), paths.length ? 1 : spec.review.min_rank);
  const first = paths[0];
  const cause = first && first.rule >= 0 && paths.every(p => p.rule === first.rule)
    ? `every changed path is under risk class ${plan.risk![first.rule]!.paths.join(', ')}`
    : paths.length ? paths.filter(p => p.review.count === count || p.review.min_rank === min_rank)
      .slice(0, 3).map(p => `${p.path} (${p.rule < 0 ? "node's review" : `risk rule ${p.rule + 1}`})`).join('; ')
    : "empty diff uses the node's review";
  return { count, min_rank, cause };
}
export const reviewRequirementText = (r: ReviewRequirement): string => `review ${r.count} required, rank >= ${r.min_rank}: ${r.cause}`;

/** RK2/RK3: neither policy can be weakened through an allowance. */
export function riskDowngrades(prev: Plan, next: Plan): Downgrade[] {
  const out: Downgrade[] = [];
  if (canonical(prev.risk ?? []) !== canonical(next.risk ?? []) && riskCanLower(prev, next)) out.push({ node: 'trunk', what: 'risk changed' });
  // Ignoring a descendant is no broader than ignoring its ancestor. Duplicate file entries are refused on input.
  if ((next.closure_neutral ?? []).some(n => {
    const old = (prev.closure_neutral ?? []).find(p => p.path === n.path);
    // Even an empty ignore list newly exempts formatting-only JSON changes.
    return !old || n.json_ignore.some(path => !old.json_ignore.some(p => path === p || path.startsWith(`${p}.`)));
  })) out.push({ node: 'trunk', what: 'closure_neutral changed' });
  return out;
}

// Compare the two ordered rule functions over their regular path languages. Sampling filenames or comparing rules
// positionally misses narrowed raising rules and reordered/shadowed lowering rules. This small NFA uses precisely
// matchesWrite's prefix/*/?/whole-segment-** grammar; the product walk examines every reachable membership region.
type Edge = { to: number; char?: string; kind?: 'any' | 'segment' };
interface Nfa { edges: Edge[][]; start: number; accepts: Map<number, number> }
function policyNfa(rules: readonly RiskRule[]): Nfa {
  const edges: Edge[][] = [], accepts = new Map<number, number>();
  const state = (): number => (edges.push([]), edges.length - 1);
  const edge = (from: number, to: number, char?: string, kind?: Edge['kind']): void => { edges[from]!.push({ to, char, kind }); };
  const literal = (from: number, text: string): number => { for (const char of text.split('')) { const to = state(); edge(from, to, char); from = to; } return from; };
  const star = (from: number, kind: Edge['kind']): number => { edge(from, from, undefined, kind); return from; };
  const start = state();
  rules.forEach((rule, index) => rule.paths.forEach(scope => {
    let at = state(); edge(start, at);
    const prefix = scope.replace(/(?:\*\*\/)*\*\*$/, '');
    if (!/[?*]/.test(scope) || !/[?*]/.test(prefix)) {
      at = literal(at, prefix); star(at, 'any');
    } else {
      const segments = scope.split('/');
      segments.forEach((segment, i) => {
        if (segment === '**') {
          const end = state(), body = state(); edge(at, end); edge(at, body, undefined, 'segment'); star(body, 'segment');
          if (i < segments.length - 1) edge(body, at, '/');
          else { const slash = state(); edge(body, end); edge(body, slash, '/'); edge(slash, body, undefined, 'segment'); }
          at = end;
        } else {
          for (const char of segment.split('')) {
            if (char === '*') star(at, 'segment');
            else { const to = state(); edge(at, to, char === '?' ? undefined : char, char === '?' ? 'segment' : undefined); at = to; }
          }
          if (i < segments.length - 1) at = literal(at, '/');
        }
      });
    }
    accepts.set(at, index);
  }));
  return { edges, start, accepts };
}
function epsilon(nfa: Nfa, states: Iterable<number>): number[] {
  const seen = new Set(states), queue = [...seen];
  for (const from of queue) for (const e of nfa.edges[from]!) if (e.char === undefined && e.kind === undefined && !seen.has(e.to)) { seen.add(e.to); queue.push(e.to); }
  return [...seen].sort((a, b) => a - b);
}
function step(nfa: Nfa, states: number[], char: string): number[] {
  return epsilon(nfa, states.flatMap(from => nfa.edges[from]!.filter(e => e.char === char || e.kind === 'any' || e.kind === 'segment' && char !== '/').map(e => e.to)));
}
function riskCanLower(prev: Plan, next: Plan): boolean {
  const rules = [prev.risk ?? [], next.risk ?? []], nfas = rules.map(policyNfa);
  const alphabet = new Set(['/', '.', '\0']); // NUL stands for any character absent from all literals.
  for (const nfa of nfas) for (const edges of nfa.edges) for (const e of edges) if (e.char !== undefined) alphabet.add(e.char);
  const defaults = [...prev.nodes, ...next.nodes].map(n => n.review);
  if (!defaults.length) defaults.push({ count: 0, min_rank: 1 });
  // Git diff paths have nonempty segments other than . or ..; impossible paths must not create downgrades.
  // Segment states: 0 empty, 1 '.', 2 '..', 3 a valid name. Only 3 can finish a repository path.
  const segmentStep = (state: number, char: string): number => char === '/' ? state === 3 ? 0 : -1 : char === '.' && state < 2 ? state + 1 : 3;
  const queue = [{ pair: nfas.map(nfa => epsilon(nfa, [nfa.start])), segment: 0 }], seen = new Set<string>();
  for (const { pair, segment } of queue) {
    const id = `${segment}|${pair.map(states => states.join(',')).join('|')}`;
    if (seen.has(id)) continue;
    seen.add(id);
    const matched = pair.map((states, side) => {
      const indices = states.flatMap(s => nfas[side]!.accepts.has(s) ? [nfas[side]!.accepts.get(s)!] : []);
      return indices.length ? rules[side]![Math.min(...indices)]!.review : undefined;
    });
    for (const fallback of defaults) {
      const before = matched[0] ?? fallback, after = matched[1] ?? fallback;
      if (segment === 3 && (after.count < before.count || after.min_rank < before.min_rank)) return true;
    }
    for (const char of alphabet) {
      const nextSegment = segmentStep(segment, char);
      if (nextSegment >= 0) queue.push({ pair: pair.map((states, side) => step(nfas[side]!, states, char)), segment: nextSegment });
    }
  }
  return false;
}

/** RK3: remove only own JSON properties; an empty dot segment is the literal empty key, never a wildcard. */
export function neutralJsonEqual(before: string, after: string, ignored: readonly string[]): boolean {
  try {
    const values: unknown[] = [JSON.parse(before), JSON.parse(after)];
    for (const value of values) for (const path of ignored) {
      const parts = path.split('.');
      let at = value;
      for (const part of parts.slice(0, -1)) {
        if (at === null || typeof at !== 'object' || !Object.hasOwn(at, part)) { at = undefined; break; }
        at = (at as Record<string, unknown>)[part];
      }
      if (at !== null && typeof at === 'object' && Object.hasOwn(at, parts.at(-1)!)) delete (at as Record<string, unknown>)[parts.at(-1)!];
    }
    return isDeepStrictEqual(values[0], values[1]);
  } catch { return false; }
}
