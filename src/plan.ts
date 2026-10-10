import { parse } from 'yaml';
import { matchesGlob } from 'node:path';
import { OwedError } from './errors.ts';
import { canonical } from './canon.ts';
import type { Plan, CheckSpec, NodeSpec, Downgrade, DriveAgent, DriveConfig, NodeDrive, NodeDriveAgent, WorktreesConfig, ExecConfig, EvidenceSpec, AllowRule } from './types.ts';

/** Driver defaults (SPEC §12, D2). */
export const DRIVE_DEFAULTS: DriveConfig = { max: 4, repairs: 2, writer: { agent: 'worker' }, reviewer: { agent: 'reviewer' } };
/**
 * The plan's driver config, or the defaults when it has no `drive:` block. With `node`, that node's `drive` (K3)
 * overrides each role it sets: a role object with `agent` replaces the plan's (model: the node's, else none, so the
 * agent's own default applies); one with only `model` keeps the plan's agent and overrides the model.
 */
export function driveConfig(plan: Plan, node?: string): DriveConfig {
  const cfg = structuredClone(plan.drive ?? DRIVE_DEFAULTS), own = node === undefined ? undefined : plan.nodes.find(n => n.id === node)?.drive;
  for (const role of ['writer', 'reviewer'] as const) cfg[role] = overrideAgent(cfg[role], own?.[role]);
  return cfg;
}
/** K3: one role of the plan's config with a node override applied (see `driveConfig`). */
function overrideAgent(base: DriveAgent, own: NodeDriveAgent | undefined): DriveAgent {
  if (own?.agent !== undefined) return { agent: own.agent, ...(own.model !== undefined ? { model: own.model } : {}) };
  if (own?.model !== undefined) return { agent: base.agent, model: own.model };
  return base;
}
/** Validates a `{agent?, model?}` role object (plan `drive.writer`/`drive.reviewer`, node `drive.*`); returns the fields set. */
function parseAgent(x: unknown, label: string, errors: string[]): NodeDriveAgent | undefined {
  if (!x || typeof x !== 'object' || Array.isArray(x)) { errors.push(`${label}: expected object`); return undefined; }
  const a = x as Record<string, unknown>, res: NodeDriveAgent = {};
  for (const k of Object.keys(a)) if (k !== 'agent' && k !== 'model') errors.push(`${label}.${k}: unknown key`);
  if (a.agent !== undefined) { if (typeof a.agent !== 'string' || !a.agent.trim()) errors.push(`${label}.agent: expected non-empty string`); else res.agent = a.agent; }
  if (a.model !== undefined) { if (typeof a.model !== 'string' || !a.model.trim()) errors.push(`${label}.model: expected non-empty string`); else res.model = a.model; }
  return res;
}
/**
 * K3: parses a node's optional `drive` field ({writer?, reviewer?}, each {agent?, model?}); unknown keys and bad types
 * are errors. Empty role objects and an empty block are dropped (undefined), so `drive: {}` equals no field.
 */
function parseNodeDrive(v: unknown, p: string, errors: string[]): NodeDrive | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) { errors.push(`${p}.drive: expected object`); return undefined; }
  const r = v as Record<string, unknown>, out: NodeDrive = {};
  for (const k of Object.keys(r)) if (k !== 'writer' && k !== 'reviewer') errors.push(`${p}.drive.${k}: unknown key`);
  for (const role of ['writer', 'reviewer'] as const) {
    if (r[role] === undefined) continue;
    const a = parseAgent(r[role], `${p}.drive.${role}`, errors);
    if (a && Object.keys(a).length) out[role] = a;
  }
  return out.writer || out.reviewer ? out : undefined;
}
/** Default of `drive.measure` (0.7.0): attests and merges the driver runs at once. */
export const MEASURE_DEFAULT = 2;
/** `drive.measure` of the plan, else MEASURE_DEFAULT (kept out of the parsed plan unless set, so other plans keep their sha). */
export function measureCap(plan: Plan): number { return plan.drive?.measure ?? MEASURE_DEFAULT; }
/** Parses an optional `drive:` block; unknown keys and bad types are errors. */
function parseDrive(v: unknown, errors: string[]): DriveConfig {
  const out = structuredClone(DRIVE_DEFAULTS);
  if (!v || typeof v !== 'object' || Array.isArray(v)) { errors.push('drive: expected object'); return out; }
  const r = v as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!['max', 'repairs', 'measure', 'writer', 'reviewer'].includes(k)) errors.push(`drive.${k}: unknown key`);
  const int = (x: unknown, label: string, min: number, dflt: number): number => { if (x === undefined) return dflt; if (typeof x !== 'number' || !Number.isInteger(x) || x < min) { errors.push(`${label}: expected integer >= ${min}`); return dflt; } return x; };
  out.max = int(r.max, 'drive.max', 1, out.max);
  out.repairs = int(r.repairs, 'drive.repairs', 0, out.repairs);
  if (r.measure !== undefined) out.measure = int(r.measure, 'drive.measure', 1, MEASURE_DEFAULT);
  const agent = (x: unknown, label: string, dflt: DriveAgent): DriveAgent => {
    if (x === undefined) return dflt;
    const a = parseAgent(x, label, errors);
    return a ? { agent: a.agent ?? dflt.agent, ...(a.model !== undefined ? { model: a.model } : {}) } : dflt;
  };
  out.writer = agent(r.writer, 'drive.writer', out.writer);
  out.reviewer = agent(r.reviewer, 'drive.reviewer', out.reviewer);
  return out;
}

/** Worktree defaults (SPEC §3, D19): slots in `<main worktree>/.owed/wt/<node>-<attempt>` on branch `owed/<node>/<attempt>`. */
export const WORKTREE_DEFAULTS: WorktreesConfig = { root: '.owed/wt', branch: 'owed/{node}/{attempt}' };
/** Default node `type` (fills `{type}` only). */
export const DEFAULT_NODE_TYPE = 'feat';
/** The plan's worktree config, or the defaults when it has no `worktrees:` block. */
export function worktreesConfig(plan: Plan): WorktreesConfig { return { ...(plan.worktrees ?? WORKTREE_DEFAULTS) }; }
const PLACEHOLDER = /\{([^{}]*)\}/g;
/** Errors of a branch template: it must contain `{node}` and `{attempt}`; `{type}` is the only other placeholder. */
export function branchTemplateErrors(template: string, label: string): string[] {
  const errors: string[] = [], names = [...template.matchAll(PLACEHOLDER)].map(m => m[1]!);
  for (const name of names) if (!['node', 'attempt', 'type'].includes(name)) errors.push(`${label}: unknown placeholder {${name}}`);
  for (const name of ['node', 'attempt']) if (!names.includes(name)) errors.push(`${label}: must contain {${name}}`);
  return errors;
}
/** Control characters refused in `worktrees.root` and `worktrees.branch` of a new plan: < 0x20, 0x7f, U+2028, U+2029. */
const CONTROL = /[\u0000-\u001f\u007f\u2028\u2029]/;
/** Characters a placeholder value may contain: `{attempt}` is a decimal number, `{type}` matches ^[a-z][a-z0-9-]*$. */
const VALUE_CHARS: Record<string, RegExp> = { attempt: /[0-9]/, type: /[a-z0-9-]/ };
/**
 * Errors of a branch template that could render two distinct (node, attempt) pairs as the same name (sufficient
 * rule): `{node}` occurs exactly once; every `{attempt}` or `{type}` before it is directly followed by a literal
 * character that cannot occur in its value, and every one after it is directly preceded by one. The name then decodes
 * from the left up to `{node}` and from the right back to it, so node and attempt are recovered uniquely.
 */
export function branchAmbiguityErrors(template: string, label: string): string[] {
  const parts = template.split(PLACEHOLDER), errors: string[] = [];
  // split with one capture group: even indexes are literals, odd ones placeholder names.
  const at = parts.flatMap((p, i) => i % 2 && p === 'node' ? [i] : []);
  if (at.length !== 1) return [`${label}: must contain {node} exactly once (two (node, attempt) pairs could give the same branch name)`];
  for (let i = 1; i < parts.length; i += 2) {
    const chars = VALUE_CHARS[parts[i]!];
    if (!chars || i === at[0]) continue;
    const before = i < at[0]!, edge = before ? parts[i + 1]!.charAt(0) : parts[i - 1]!.charAt(parts[i - 1]!.length - 1);
    if (!edge || chars.test(edge)) errors.push(`${label}: {${parts[i]}} must be ${before ? 'followed' : 'preceded'} by a separator character that cannot occur in it (such as /), or two (node, attempt) pairs could give the same branch name`);
  }
  return errors;
}
/**
 * Errors a new plan's `worktrees:` block must not have (checked when a plan is recorded, not on replay, so existing
 * ledgers stay readable): control characters in the root or the branch template, and an ambiguous branch template.
 */
export function worktreesErrors(cfg: WorktreesConfig): string[] {
  const errors: string[] = [];
  if (CONTROL.test(cfg.root)) errors.push('worktrees.root: must not contain control characters');
  if (CONTROL.test(cfg.branch)) errors.push('worktrees.branch: must not contain control characters');
  return [...errors, ...branchAmbiguityErrors(cfg.branch, 'worktrees.branch')];
}
/**
 * Errors of a new plan whose node ids are distinct but equal ignoring case (checked when a plan is recorded, not on
 * replay): on a case-insensitive filesystem such nodes would share a branch ref and a worktree directory.
 */
export function nodeIdCaseErrors(plan: Pick<Plan, 'nodes'>): string[] {
  const seen = new Map<string, string>(), errors: string[] = [];
  for (const { id } of plan.nodes) {
    const key = id.toUpperCase().toLowerCase(), first = seen.get(key);
    if (first === undefined) seen.set(key, id);
    else if (first !== id) errors.push(`node ids ${first} and ${id} differ only in case: on a case-insensitive filesystem they would share a branch ref and a worktree directory`);
  }
  return errors;
}
/** Expands a (valid) branch template for attempt `attempt` of node `spec`; `{type}` defaults to `feat`. */
export function expandBranch(template: string, spec: Pick<NodeSpec, 'id' | 'type'>, attempt: number): string {
  const values: Record<string, string> = { node: spec.id, attempt: String(attempt), type: spec.type ?? DEFAULT_NODE_TYPE };
  return template.replace(PLACEHOLDER, (all, name: string) => values[name] ?? all);
}
/** Parses an optional `worktrees:` block; unknown keys and bad types are errors. */
function parseWorktrees(v: unknown, errors: string[]): WorktreesConfig {
  const out = { ...WORKTREE_DEFAULTS };
  if (!v || typeof v !== 'object' || Array.isArray(v)) { errors.push('worktrees: expected object'); return out; }
  const r = v as Record<string, unknown>;
  for (const k of Object.keys(r)) if (k !== 'root' && k !== 'branch') errors.push(`worktrees.${k}: unknown key`);
  if (r.root !== undefined) { if (typeof r.root !== 'string' || !r.root.trim() || r.root.includes('\0')) errors.push('worktrees.root: expected non-empty string'); else out.root = r.root; }
  if (r.branch !== undefined) {
    if (typeof r.branch !== 'string' || !r.branch.trim()) errors.push('worktrees.branch: expected non-empty string');
    else { const e = branchTemplateErrors(r.branch, 'worktrees.branch'); errors.push(...e); if (!e.length) out.branch = r.branch; }
  }
  return out;
}

/** Evidence ids (D23): also safe in an obligation name and a CLI argument. */
export const EVIDENCE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const EVIDENCE_BY: readonly EvidenceSpec['by'][] = ['reviewer', 'parent', 'owner'];
/** D23: the optional node fields `approve` (only `owner`) and `evidence` ([{id, what, by?}]); sets them on `out` only when present. */
function parseManual(n: Record<string, unknown>, p: string, out: NodeSpec, errors: string[]): void {
  if (n.approve !== undefined) { if (n.approve !== 'owner') errors.push(`${p}.approve: expected "owner"`); else out.approve = 'owner'; }
  if (n.evidence === undefined) return;
  if (!Array.isArray(n.evidence)) { errors.push(`${p}.evidence: expected array`); return; }
  const ids = new Set<string>();
  out.evidence = n.evidence.map((x, i) => {
    const q = `${p}.evidence[${i}]`, res: EvidenceSpec = { id: '', what: '', by: 'reviewer' };
    if (!x || typeof x !== 'object' || Array.isArray(x)) { errors.push(`${q}: expected object`); return res; }
    const e = x as Record<string, unknown>;
    for (const k of Object.keys(e)) if (!['id', 'what', 'by'].includes(k)) errors.push(`${q}.${k}: unknown key`);
    if (typeof e.id !== 'string' || !EVIDENCE_ID.test(e.id)) errors.push(`${q}.id: expected ${EVIDENCE_ID.source}`); else { if (ids.has(e.id)) errors.push(`${q}: duplicate evidence id ${e.id}`); ids.add(e.id); res.id = e.id; }
    if (typeof e.what !== 'string' || !e.what.trim()) errors.push(`${q}.what: expected non-empty string`); else res.what = e.what;
    if (e.by !== undefined) { if (!EVIDENCE_BY.includes(e.by as EvidenceSpec['by'])) errors.push(`${q}.by: expected reviewer, parent or owner`); else res.by = e.by as EvidenceSpec['by']; }
    return res;
  });
}
/** D23 downgrades: `approve removed`; `evidence <id> removed`; `evidence <id> weakened` when `by` changes to a role other than owner. */
export function manualDowngrades(node: string, prev: NodeSpec, next: NodeSpec): Downgrade[] {
  const out: Downgrade[] = [];
  if (prev.approve && !next.approve) out.push({ node, what: 'approve removed' });
  for (const e of prev.evidence ?? []) {
    const m = next.evidence?.find(x => x.id === e.id);
    if (!m) out.push({ node, what: `evidence ${e.id} removed` });
    else if (m.by !== e.by && m.by !== 'owner') out.push({ node, what: `evidence ${e.id} weakened` });
  }
  return out;
}

/** Environment names owed sets itself; `exec.env` may not override them (D20). */
const RESERVED_ENV = ['CI', 'OWED'];
/**
 * Parses an optional `exec:` block (D20); unknown keys and bad types are errors. Returns undefined when neither
 * `env` nor `wrap` is non-empty and neither `parallel` nor `trees` is set, so `exec: {}` equals no block (plan blob,
 * keys and views as without it). 0.9: `parallel` is an integer >= 1, `trees` is `fresh` or `reuse`.
 */
function parseExec(v: unknown, errors: string[]): ExecConfig | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) { errors.push('exec: expected object'); return undefined; }
  const r = v as Record<string, unknown>, out: ExecConfig = {};
  for (const k of Object.keys(r)) if (!['env', 'wrap', 'parallel', 'trees'].includes(k)) errors.push(`exec.${k}: unknown key`);
  if (r.env !== undefined) {
    if (!r.env || typeof r.env !== 'object' || Array.isArray(r.env)) errors.push('exec.env: expected object');
    else {
      const env: Record<string, string> = {};
      for (const [name, value] of Object.entries(r.env as Record<string, unknown>)) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) errors.push(`exec.env.${name}: invalid variable name`);
        else if (RESERVED_ENV.includes(name)) errors.push(`exec.env.${name}: reserved (owed sets ${RESERVED_ENV.join(' and ')})`);
        else if (typeof value !== 'string') errors.push(`exec.env.${name}: expected string`);
        else env[name] = value;
      }
      if (Object.keys(env).length) out.env = env;
    }
  }
  if (r.wrap !== undefined) {
    if (!Array.isArray(r.wrap) || !r.wrap.length) errors.push('exec.wrap: expected non-empty array of strings');
    else if (r.wrap.some(x => typeof x !== 'string' || !x)) errors.push('exec.wrap: expected non-empty strings');
    else out.wrap = [...r.wrap] as string[];
  }
  if (r.parallel !== undefined) {
    if (typeof r.parallel !== 'number' || !Number.isInteger(r.parallel) || r.parallel < 1) errors.push('exec.parallel: expected an integer >= 1');
    else out.parallel = r.parallel;
  }
  if (r.trees !== undefined) {
    if (r.trees !== 'fresh' && r.trees !== 'reuse') errors.push('exec.trees: expected fresh or reuse');
    else out.trees = r.trees;
  }
  return out.env || out.wrap || out.parallel !== undefined || out.trees !== undefined ? out : undefined;
}

/** Parses an optional `allow:` block (SPEC §3.4, D21): a list of rules; unknown keys and bad types are errors; a rule needs a permission. */
function parseAllow(v: unknown, errors: string[]): AllowRule[] {
  if (!Array.isArray(v)) { errors.push('allow: expected array'); return []; }
  const keys = ['nodes', 'review_count', 'review_rank', 'writes', 'checks', 'adopt'];
  return v.map((x, i) => {
    const p = `allow[${i}]`, out: AllowRule = { nodes: ['*'] };
    if (!x || typeof x !== 'object' || Array.isArray(x)) { errors.push(`${p}: expected object`); return out; }
    const r = x as Record<string, unknown>;
    for (const k of Object.keys(r)) if (!keys.includes(k)) errors.push(`${p}.${k}: unknown key`);
    const list = (y: unknown, label: string): string[] | undefined => {
      if (y === undefined) return undefined;
      if (!Array.isArray(y) || !y.length || y.some(s => typeof s !== 'string' || !s.trim())) { errors.push(`${label}: expected a non-empty array of non-empty strings`); return undefined; }
      return y as string[];
    };
    const int = (y: unknown, label: string, min: number, max: number): number | undefined => {
      if (y === undefined) return undefined;
      if (typeof y !== 'number' || !Number.isInteger(y) || y < min || y > max) { errors.push(`${label}: expected integer ${max === Infinity ? `>= ${min}` : `in ${min}..${max}`}`); return undefined; }
      return y;
    };
    out.nodes = list(r.nodes, `${p}.nodes`) ?? ['*'];
    const count = int(r.review_count, `${p}.review_count`, 0, Infinity), rank = int(r.review_rank, `${p}.review_rank`, 1, 3);
    if (count !== undefined) out.review_count = count;
    if (rank !== undefined) out.review_rank = rank;
    for (const k of ['writes', 'checks', 'adopt'] as const) { const l = list(r[k], `${p}.${k}`); if (l) out[k] = l; }
    if (!['review_count', 'review_rank', 'writes', 'checks', 'adopt'].some(k => r[k] !== undefined)) errors.push(`${p}: a rule needs at least one permission (review_count, review_rank, writes, checks or adopt)`);
    return out;
  });
}
/**
 * `allow` changed in a way other than deleting whole rules (D21.2): some rule of `next` deep-equals no rule of `prev`.
 * Such a change is the owner-only downgrade `{node: 'trunk', what: 'allow changed'}`.
 */
export function allowWidened(prev: Plan, next: Plan): boolean {
  const before = new Set((prev.allow ?? []).map(r => canonical(r)));
  return (next.allow ?? []).some(r => !before.has(canonical(r)));
}
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
      if (c.mutants !== undefined) { out.mutants = strings(c.mutants, `${p}.mutants`); if (!out.mutants.length) errors.push(`${p}.mutants: expected at least one glob`); }
      if (c.min_kill !== undefined) {
        if (typeof c.min_kill !== 'number' || !(c.min_kill > 0 && c.min_kill <= 1)) errors.push(`${p}.min_kill: expected a number in (0, 1]`); else out.min_kill = c.min_kill;
        if (out.mutants === undefined) errors.push(`${p}: min_kill requires mutants`);
      }
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
    if (n.type !== undefined) { if (typeof n.type !== 'string' || !/^[a-z][a-z0-9-]*$/.test(n.type)) errors.push(`${p}.type: expected a string matching ^[a-z][a-z0-9-]*$`); else out.type = n.type; }
    parseManual(n, p, out, errors);
    if (n.drive !== undefined) { const d = parseNodeDrive(n.drive, p, errors); if (d) out.drive = d; }
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
  if (r.drive !== undefined) plan.drive = parseDrive(r.drive, errors);
  if (r.worktrees !== undefined) plan.worktrees = parseWorktrees(r.worktrees, errors);
  if (r.exec !== undefined) { const exec = parseExec(r.exec, errors); if (exec) plan.exec = exec; }
  if (r.allow !== undefined) plan.allow = parseAllow(r.allow, errors);
  errors.push(...mutantErrors(plan));
  if (errors.length) throw new OwedError(errors.join('\n'), 'usage');
  return plan;
}
/** Conservative: a mutant glob lies inside the closure when, read as a path, it matches a closure glob; a `**` in it needs a closure prefix (`dir/` or `dir/**`) covering it. */
export function globWithinClosure(glob: string, closure: string[]): boolean {
  return closure.some(c => c === '**' || (glob.includes('**') ? (c.endsWith('/') ? glob.startsWith(c) : c.endsWith('/**') && glob.startsWith(c.slice(0, -2))) : globMatch(glob, c)));
}
function mutantErrors(plan: Plan): string[] {
  const errors = plan.invariants.filter(c => c.mutants !== undefined).map(c => `invariants: ${c.id}: mutants are only supported on node checks`);
  for (const n of plan.nodes) for (const c of n.checks) for (const g of c.mutants ?? []) if (!globWithinClosure(g, plan.closure)) errors.push(`${n.id}: check ${c.id}: mutant glob ${g} must lie inside the plan closure`);
  return errors;
}
/**
 * H2.2: one warning per node of `plan` with no checks and no evidence obligations: its acceptance rests on review alone.
 * `owed init` / `owed plan` report them after the result; they refuse and record nothing.
 */
export function checklessWarnings(plan: Plan, merged: ReadonlySet<string> = new Set()): string[] {
  return plan.nodes.filter(n => !merged.has(n.id) && !n.checks.length && !n.evidence?.length).map(n => `warning: node ${n.id} has no checks: its acceptance rests on review alone`);
}
/** 0.8 (L3.3): a shell loop (`for|while|until … do`) or `seq N` in command position (`seq 5 | xargs …`, `$(seq 5)`). */
const SHELL_LOOP = /(?:^|[\s;&|(`'"])(?:for|while|until)\s[\s\S]*?[;\n]\s*do(?:\s|$)|(?:^|[;&|(`]|\$\()\s*seq(?:\s+-?\d+){1,3}(?:\s|$|[;&|)`])/;
/**
 * 0.8 (L3.3, wais #22): one warning per check (or invariant) that sets `min_tests` and repeats its command in a shell
 * loop. exec.ts (`parseCounts`) does not add up repeated TAP, jest/vitest or pytest runs: each later `# tests`/`# pass`/`# fail`
 * line (else `1..N` plan), `Tests:` summary or pytest summary line replaces the earlier one, so min_tests sees one run's count; only cargo
 * `test result:` lines are summed. `owed plan` / `owed init` print it with the H2.2 warnings; nothing is refused.
 */
export function loopWarnings(plan: Plan, merged: ReadonlySet<string> = new Set()): string[] {
  const one = (where: string, c: CheckSpec): string[] => c.min_tests !== undefined && SHELL_LOOP.test(c.run)
    ? [`warning: ${where} runs its command in a shell loop with min_tests ${c.min_tests}: min_tests counts only the last TAP (# tests), jest/vitest (Tests:) or pytest (N passed) summary in the log, i.e. one run, not the sum of the runs (only cargo "test result:" lines are added up)`] : [];
  return [...plan.invariants.flatMap(c => one(`invariant ${c.id}`, c)), ...plan.nodes.filter(n => !merged.has(n.id)).flatMap(n => n.checks.flatMap(c => one(`check ${c.id} of node ${n.id}`, c)))];
}
/** The warnings `owed plan` / `owed init` print after the result: check-less nodes (H2.2), then looped checks (L3.3). */
export const planWarnings = (plan: Plan, merged: ReadonlySet<string> = new Set()): string[] => [...checklessWarnings(plan, merged), ...loopWarnings(plan, merged)];
export function planDowngrades(prev: Plan, next: Plan): Downgrade[] {
  const out: Downgrade[] = [];
  function compare(node: string, before: CheckSpec[], after: CheckSpec[]): void {
    for (const c of before) {
      const n = after.find(x => x.id === c.id);
      if (!n) { out.push({ node, what: `check ${c.id} removed` }); continue; }
      if (c.red && !n.red) out.push({ node, what: `check ${c.id} red disabled` });
      if ((n.min_tests ?? 0) < (c.min_tests ?? 0)) out.push({ node, what: `check ${c.id} min_tests lowered` });
      if (c.mutants?.length && !n.mutants?.length) out.push({ node, what: `check ${c.id} mutants removed` });
      else if (c.mutants?.length && (n.min_kill ?? 1) < (c.min_kill ?? 1)) out.push({ node, what: `check ${c.id} min_kill lowered` });
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
    out.push(...manualDowngrades(n.id, n, m));
  }
  if (allowWidened(prev, next)) out.push({ node: 'trunk', what: 'allow changed' });
  return out;
}
