import { parse } from 'yaml';
import { matchesGlob } from 'node:path';
import { OwedError } from './errors.ts';
import type { Plan, CheckSpec, NodeSpec, Downgrade } from './types.ts';

export function globMatch(path: string, glob: string): boolean {
  return glob === '**' || (glob.endsWith('/') ? path.startsWith(glob) : matchesGlob(path, glob));
}
export function matchesAny(path: string, globs: string[]): boolean { return globs.some(g => globMatch(path, g)); }
export function parsePlan(text: string): Plan {
  const errors: string[] = [];
  let raw: unknown;
  try { raw = parse(text); } catch (e) { throw new OwedError(`Invalid YAML: ${String(e)}`, 'usage'); }
  const obj = (v: unknown, label: string): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) { errors.push(`${label}: expected object`); return {}; }
    return v as Record<string, unknown>;
  };
  const str = (v: unknown, label: string): string => { if (typeof v !== 'string' || !v.trim()) { errors.push(`${label}: expected non-empty string`); return ''; } return v; };
  const arr = (v: unknown, label: string): unknown[] => { if (!Array.isArray(v)) { errors.push(`${label}: expected array`); return []; } return v; };
  const strings = (v: unknown, label: string): string[] => arr(v, label).map(x => str(x, label));
  const num = (v: unknown, label: string, min: number): number => { if (typeof v !== 'number' || !Number.isInteger(v) || v < min) { errors.push(`${label}: expected integer >= ${min}`); return min; } return v; };
  const checks = (v: unknown, label: string): CheckSpec[] => {
    const ids = new Set<string>();
    return arr(v ?? [], label).map((x, i) => {
      const p = `${label}[${i}]`, c = obj(x, p), id = str(c.id, `${p}.id`);
      if (ids.has(id)) errors.push(`${p}: duplicate id ${id}`); ids.add(id);
      const out: CheckSpec = { id, run: str(c.run, `${p}.run`), timeout_s: num(c.timeout_s ?? 600, `${p}.timeout_s`, 1), reads: strings(c.reads ?? ['**'], `${p}.reads`) };
      if (c.min_tests !== undefined) out.min_tests = num(c.min_tests, `${p}.min_tests`, 0);
      if (c.red !== undefined) { if (typeof c.red !== 'boolean') errors.push(`${p}.red: expected boolean`); else out.red = c.red; }
      if (c.tests !== undefined) out.tests = strings(c.tests, `${p}.tests`);
      if (out.red && !out.tests?.length) errors.push(`${p}: red requires tests`);
      if (c.red_expect !== undefined) { out.red_expect = str(c.red_expect, `${p}.red_expect`); try { new RegExp(out.red_expect); } catch { errors.push(`${p}.red_expect: invalid regex`); } }
      return out;
    });
  };
  const r = obj(raw, 'plan');
  if (r.version !== 1) errors.push('version must be 1');
  const nodes: NodeSpec[] = arr(r.nodes ?? [], 'nodes').map((x, i) => {
    const p = `nodes[${i}]`, n = obj(x, p), review = obj(n.review ?? {}, `${p}.review`);
    const out: NodeSpec = { id: str(n.id, `${p}.id`), deps: strings(n.deps ?? [], `${p}.deps`), writes: strings(n.writes ?? [], `${p}.writes`), checks: checks(n.checks, `${p}.checks`), review: { count: num(review.count ?? 0, `${p}.review.count`, 0), min_rank: num(review.min_rank ?? 1, `${p}.review.min_rank`, 1) } };
    if (out.review.min_rank > 3) errors.push(`${p}.review.min_rank must be <= 3`);
    if (out.checks.length && !out.writes.length) errors.push(`${p}: writes required with checks`);
    if (n.title !== undefined) out.title = str(n.title, `${p}.title`);
    if (n.brief !== undefined) out.brief = str(n.brief, `${p}.brief`);
    return out;
  });
  const ids = new Map<string, NodeSpec>();
  for (const n of nodes) { if (ids.has(n.id)) errors.push(`duplicate node id ${n.id}`); ids.set(n.id, n); }
  const visited = new Set<string>(), active = new Set<string>();
  function visit(id: string): void {
    if (active.has(id)) { errors.push(`dependency cycle at ${id}`); return; }
    if (visited.has(id)) return;
    active.add(id);
    for (const dep of ids.get(id)?.deps ?? []) { if (!ids.has(dep)) errors.push(`${id}: missing dependency ${dep}`); else visit(dep); }
    active.delete(id); visited.add(id);
  }
  for (const id of ids.keys()) visit(id);
  const plan: Plan = { version: 1, trunk: str(r.trunk, 'trunk'), closure: strings(r.closure ?? [], 'closure'), invariants: checks(r.invariants, 'invariants'), nodes };
  if (r.setup !== undefined) plan.setup = str(r.setup, 'setup');
  if (errors.length) throw new OwedError(errors.join('\n'), 'usage');
  return plan;
}
export function planDowngrades(prev: Plan, next: Plan): Downgrade[] {
  const out: Downgrade[] = [];
  function compare(node: string, before: CheckSpec[], after: CheckSpec[]): void {
    for (const c of before) {
      const n = after.find(x => x.id === c.id);
      if (!n) { out.push({ node, what: `check ${c.id} removed` }); continue; }
      if (c.red && !n.red) out.push({ node, what: `check ${c.id} red disabled` });
      if ((n.min_tests ?? 0) < (c.min_tests ?? 0)) out.push({ node, what: `check ${c.id} min_tests lowered` });
    }
  }
  compare('trunk', prev.invariants, next.invariants);
  for (const n of prev.nodes) {
    const m = next.nodes.find(x => x.id === n.id);
    if (!m) { out.push({ node: n.id, what: 'node removed' }); continue; }
    compare(n.id, n.checks, m.checks);
    if (m.review.count < n.review.count) out.push({ node: n.id, what: 'review count lowered' });
    if (m.review.min_rank < n.review.min_rank) out.push({ node: n.id, what: 'review rank lowered' });
    if (m.writes.some(p => !n.writes.some(old => p.startsWith(old)))) out.push({ node: n.id, what: 'writes widened' });
  }
  return out;
}
