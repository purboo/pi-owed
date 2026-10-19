import { riskDowngrades } from './risk.ts';
import { writeCovers, writesSyntax, writesAllowChanged, writesEntryError, allowOnlyWidened } from './writes.ts';
import { parse } from 'yaml';
import { wrapErrors } from './exec-wrap.ts';
import { matchesGlob } from 'node:path';
import { OwedError } from './errors.ts';
import { canonical } from './canon.ts';
import type { QuarantineEntry, Plan, CheckSpec, InvariantSpec, NodeSpec, Downgrade, DriveAgent, DriveConfig, NodeDrive, NodeDriveAgent, WorktreesConfig, ExecConfig, EvidenceSpec, AllowRule } from './types.ts';

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
  if (own?.same_model !== undefined) cfg.same_model = own.same_model;
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
/** MD2: an informational acknowledgement, never an acceptance downgrade. */
function parseSameModel(value: unknown, label: string, errors: string[]): 'accepted' | undefined {
  if (value === undefined) return;
  if (value === 'accepted') return value;
  errors.push(`${label}: expected accepted; set same_model: accepted to acknowledge the warning`);
}
/** K3/MD2: optional node roles and same-model acknowledgement; empty blocks are dropped. */
function parseNodeDrive(v: unknown, p: string, errors: string[]): NodeDrive | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) { errors.push(`${p}.drive: expected object`); return undefined; }
  const r = v as Record<string, unknown>, out: NodeDrive = {};
  for (const k of Object.keys(r)) if (k !== 'writer' && k !== 'reviewer' && k !== 'same_model') errors.push(`${p}.drive.${k}: unknown key`);
  const ack = parseSameModel(r.same_model, `${p}.drive.same_model`, errors);
  if (ack) out.same_model = ack;
  for (const role of ['writer', 'reviewer'] as const) {
    if (r[role] === undefined) continue;
    const a = parseAgent(r[role], `${p}.drive.${role}`, errors);
    if (a && Object.keys(a).length) out[role] = a;
  }
  return out.writer || out.reviewer || out.same_model ? out : undefined;
}
/** Default of `drive.measure` (0.7.0): attests and merges the driver runs at once. */
export const MEASURE_DEFAULT = 2;
/** `drive.measure` of the plan, else MEASURE_DEFAULT (kept out of the parsed plan unless set, so other plans keep their sha). */
export function measureCap(plan: Plan): number { return plan.drive?.measure ?? MEASURE_DEFAULT; }
/** F2.3: default of `drive.min_free_mb`: the free space (MB) the driver needs before it starts a measurement. */
export const MIN_FREE_DEFAULT = 2048;
/** F2.3: `drive.min_free_mb` of the plan (0 disables the disk preflight), else MIN_FREE_DEFAULT (kept out of the parsed plan unless set). */
export function minFreeMb(plan: Plan): number { return plan.drive?.min_free_mb ?? MIN_FREE_DEFAULT; }
/** Parses an optional `drive:` block; unknown keys and bad types are errors. */
function parseDrive(v: unknown, errors: string[]): DriveConfig {
  const out = structuredClone(DRIVE_DEFAULTS);
  if (!v || typeof v !== 'object' || Array.isArray(v)) { errors.push('drive: expected object'); return out; }
  const r = v as Record<string, unknown>;
  for (const k of Object.keys(r)) if (!['max', 'repairs', 'measure', 'min_free_mb', 'idle_rewake_min', 'watch_idle_min', 'answer_grace_s', 'writer', 'reviewer', 'same_model'].includes(k)) errors.push(`drive.${k}: unknown key`);
  const int = (x: unknown, label: string, min: number, dflt: number): number => { if (x === undefined) return dflt; if (typeof x !== 'number' || !Number.isInteger(x) || x < min) { errors.push(`${label}: expected integer >= ${min}`); return dflt; } return x; };
  out.max = int(r.max, 'drive.max', 1, out.max);
  out.repairs = int(r.repairs, 'drive.repairs', 0, out.repairs);
  if (r.measure !== undefined) out.measure = int(r.measure, 'drive.measure', 1, MEASURE_DEFAULT);
  if (r.min_free_mb !== undefined) out.min_free_mb = int(r.min_free_mb, 'drive.min_free_mb', 0, MIN_FREE_DEFAULT);
  if (r.idle_rewake_min !== undefined) out.idle_rewake_min = int(r.idle_rewake_min, 'drive.idle_rewake_min', 0, 60);
  if (r.watch_idle_min !== undefined) out.watch_idle_min = int(r.watch_idle_min, 'drive.watch_idle_min', 0, 15);
  if (r.answer_grace_s !== undefined) out.answer_grace_s = int(r.answer_grace_s, 'drive.answer_grace_s', 0, 900);
  const agent = (x: unknown, label: string, dflt: DriveAgent): DriveAgent => {
    if (x === undefined) return dflt;
    const a = parseAgent(x, label, errors);
    return a ? { agent: a.agent ?? dflt.agent, ...(a.model !== undefined ? { model: a.model } : {}) } : dflt;
  };
  const ack = parseSameModel(r.same_model, 'drive.same_model', errors);
  if (ack) out.same_model = ack;
  out.writer = agent(r.writer, 'drive.writer', out.writer);
  out.reviewer = agent(r.reviewer, 'drive.reviewer', out.reviewer);
  return out;
}

/** MT1 (0.21): `drive.merge_batch` (integer 1..8) next to the other drive keys; kept out of the parsed plan unless set. */
function parseDriveBatch(v: unknown, errors: string[]): DriveConfig {
  if (!v || typeof v !== 'object' || Array.isArray(v) || !('merge_batch' in v)) return parseDrive(v, errors);
  const { merge_batch: n, ...rest } = v as Record<string, unknown>, out = parseDrive(rest, errors);
  if (typeof n !== 'number' || !Number.isInteger(n) || n < 1 || n > 8) errors.push('drive.merge_batch: expected integer 1..8');
  else out.merge_batch = n;
  return out;
}
/** MT1: members of one batch merge (1 = batch merge off). */
export const mergeBatchSize = (plan: Plan): number => plan.drive?.merge_batch ?? 1;
/** FL4: staying driver reminder interval (minutes); no obligation key. */
export const idleRewakeMin = (plan: Plan): number => plan.drive?.idle_rewake_min ?? 60;
/** FL5: command/tool invariant spelling, canonicalized before a ledger write. */
export function invariantId(plan: Pick<Plan, 'invariants'>, value: string): string {
  const id = value.startsWith('inv:') ? value.slice(4) : value;
  if (!plan.invariants.some(i => i.id === id)) throw new OwedError(`Unknown invariant ${value}; valid ids: ${plan.invariants.map(i => `${i.id} (inv:${i.id})`).join(', ') || 'none'}`);
  return id;
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
 * F6 (ruling #1095): `exec.env.OWED_TREE` is refused only when a plan is recorded, not on replay, so ledgers whose
 * older plans set it still verify; at run time owed's OWED_TREE overrides the plan value.
 */
export function execEnvErrors(plan: Pick<Plan, 'exec'>): string[] {
  return plan.exec?.env?.OWED_TREE !== undefined ? ['exec.env.OWED_TREE: reserved (owed sets it to the measurement tree)'] : [];
}
/**
 * Parses an optional `exec:` block (D20); unknown keys and bad types are errors. Returns undefined when neither
 * `env` nor `wrap` is non-empty and none of `parallel`, `trees`, `touch` is set, so `exec: {}` equals no block (plan blob,
 * keys and views as without it). 0.9: `parallel` is an integer >= 1, `trees` is `fresh` or `reuse`.
 */
function parseExec(v: unknown, errors: string[]): ExecConfig | undefined {
  if (!v || typeof v !== 'object' || Array.isArray(v)) { errors.push('exec: expected object'); return undefined; }
  const r = v as Record<string, unknown>, out: ExecConfig = {};
  for (const k of Object.keys(r)) if (!['env', 'wrap', 'wrap_grace_s', 'parallel', 'trees', 'touch'].includes(k)) errors.push(`exec.${k}: unknown key`);
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
    if (typeof r.wrap === 'string') {
      errors.push(...wrapErrors(r.wrap)); out.wrap = r.wrap;
    } else if (!Array.isArray(r.wrap) || !r.wrap.length) errors.push('exec.wrap: expected non-empty array of strings or a template string; include {cmd}');
    else if (r.wrap.some(x => typeof x !== 'string' || !x)) errors.push('exec.wrap: expected non-empty strings');
    else out.wrap = [...r.wrap] as string[];
  }
  if (r.wrap_grace_s !== undefined) {
    if (typeof r.wrap_grace_s !== 'number' || !Number.isSafeInteger(r.wrap_grace_s) || r.wrap_grace_s < 0) errors.push('exec.wrap_grace_s: expected an integer >= 0; set the wrapper shutdown grace in seconds');
    else out.wrap_grace_s = r.wrap_grace_s;
  }
  if (r.parallel !== undefined) {
    if (typeof r.parallel !== 'number' || !Number.isInteger(r.parallel) || r.parallel < 1) errors.push('exec.parallel: expected an integer >= 1');
    else out.parallel = r.parallel;
  }
  if (r.trees !== undefined) {
    if (r.trees !== 'fresh' && r.trees !== 'reuse') errors.push('exec.trees: expected fresh or reuse');
    else out.trees = r.trees;
  }
  if (r.touch !== undefined) {
    if (r.touch !== 'reset' && r.touch !== 'always' && r.touch !== 'never') errors.push('exec.touch: expected reset, always or never');
    else out.touch = r.touch;
  }
  return out.env || out.wrap || out.wrap_grace_s !== undefined || out.parallel !== undefined || out.trees !== undefined || out.touch !== undefined ? out : undefined;
}

/** Parses an optional `allow:` block (SPEC §3.4, D21): a list of rules; unknown keys and bad types are errors; a rule needs a permission. */
function parseAllow(v: unknown, errors: string[]): AllowRule[] {
  if (!Array.isArray(v)) { errors.push('allow: expected array'); return []; }
  const keys = ['nodes', 'review_count', 'review_rank', 'writes', 'checks', 'adopt', 'defer'];
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
    for (const k of ['writes', 'checks', 'adopt', 'defer'] as const) { const l = list(r[k], `${p}.${k}`); if (l) out[k] = l; }
    if (!['review_count', 'review_rank', 'writes', 'checks', 'adopt', 'defer'].some(k => r[k] !== undefined)) errors.push(`${p}: a rule needs at least one permission (review_count, review_rank, writes, checks, adopt or defer)`);
    return out;
  });
}
/**
 * `allow` changed in a way other than deleting whole rules (D21.2): some rule of `next` deep-equals no rule of `prev`.
 * Such a change is the owner-only downgrade `{node: 'trunk', what: 'allow changed'}`.
 */
export function allowWidened(prev: Plan, next: Plan): boolean {
  const before = new Set((prev.allow ?? []).map(r => canonical(r)));
  return writesAllowChanged(prev,next) || (next.allow ?? []).some(r => !before.has(canonical(r)));
}
export function globMatch(path: string, glob: string): boolean {
  return glob === '**' || (glob.endsWith('/') ? path.startsWith(glob) : matchesGlob(path, glob));
}
export function matchesAny(path: string, globs: string[]): boolean { return globs.some(g => globMatch(path, g)); }
/** CT1: version 1 expansions are frozen: normalized plans store only run/min_tests, never template metadata. */
export const CHECK_TEMPLATE_VERSION = 1;
/** Template-generated commands carry their expansion version in the keyed command itself. */
export const isCheckTemplateRun = (run: string): boolean => run.startsWith(`# owed-template/v${CHECK_TEMPLATE_VERSION}/`);
const templateQuote = (value: string): string => `'${value.replace(/'/g, `'"'"'`)}'`;
/** CT1: count successful tests only (not skipped/ignored); pipefail retains crashes and runner failures. */
function templateCounter(format: 'cargo' | 'tap', min: number, files: string[] = []): string {
  const script = `let log='';process.stdin.setEncoding('utf8');process.stdin.on('data',x=>{log+=x;process.stdout.write(x)});process.stdin.on('end',()=>{let pass=0,fail=0,seen=false;${format === 'cargo' ? "for(const m of log.matchAll(/^test result: (?:ok|FAILED)\\. (\\d+) passed; (\\d+) failed; (\\d+) ignored/gm)){seen=true;pass+=Number(m[1]);fail+=Number(m[2])}" : `const p=[...log.matchAll(/^# pass (\\d+)\\s*$/gm)].at(-1),f=[...log.matchAll(/^# fail (\\d+)\\s*$/gm)].at(-1);if(p&&f){seen=true;const {resolve}=require('node:path'),{globSync}=require('node:fs');const normal=x=>resolve(x.trim().replace(/\\\\/g,'/'));const files=new Set(${JSON.stringify(files)}.flatMap(x=>[normal(x),...globSync(x.replace(/\\\\/g,'/')).map(normal)]));let wrappers=0,cursor=0;for(const m of log.matchAll(/^(not )?ok \\d+ - ([^\\r\\n]+)\\r?$/gm)){const before=log.slice(cursor,m.index);cursor=m.index+m[0].length;if(!m[1]&&!/ # (?:SKIP|TODO)\\b/.test(m[2])&&!/^[ \\t]+# Subtest:/m.test(before)&&files.has(normal(m[2])))wrappers++}pass=Math.max(0,Number(p[1])-wrappers);fail=Number(f[1])}`}if(seen){const failed=[...log.matchAll(${format === 'cargo' ? '/^test (.+) \\.\\.\\. FAILED\\s*$/gm' : '/^\\s*not ok \\d+\\s*-\\s*(.+)$/gm'})].map(m=>m[1]);console.log('owed-counts '+JSON.stringify({pass,fail,...(failed.length?{failed}:{})}))}if(!seen||fail||pass<${min})process.exitCode=1});`;
  return `node -e ${templateQuote(script)}`;
}
/** CT1: validate template-specific input before expanding into the existing check interface. */
function expandCheckTemplate(c: Record<string, unknown>, p: string, errors: string[]): { run: string; min_tests?: number } | undefined {
  if (c.template === undefined) return undefined;
  const start = errors.length;
  if (c.run !== undefined) errors.push(`${p}.run: cannot be combined with template`);
  const names = ['cargo-tests', 'node-tap', 'evidence-json'];
  if (typeof c.template !== 'string' || !names.includes(c.template)) { errors.push(`${p}.template: unknown template ${String(c.template)}`); return { run: '' }; }
  const str = (key: string): string => {
    const value = c[key];
    if (typeof value !== 'string' || !value.trim() || value.includes('\0')) { errors.push(`${p}.${key}: expected non-empty string without NUL`); return ''; }
    return value;
  };
  const list = (key: string, empty = false): string[] => {
    const value = c[key];
    if (!Array.isArray(value) || (!empty && !value.length) || value.some(x => typeof x !== 'string' || !x.trim() || x.includes('\0'))) { errors.push(`${p}.${key}: expected ${empty ? 'an array' : 'a non-empty array'} of non-empty strings without NUL`); return []; }
    return value as string[];
  };
  const fields = c.template === 'cargo-tests' ? ['package', 'test', 'filters', 'min_ok'] : c.template === 'node-tap' ? ['files', 'name_prefix', 'min_ok'] : ['path', 'required'];
  for (const key of ['package', 'test', 'filters', 'min_ok', 'files', 'name_prefix', 'path', 'required']) if (c[key] !== undefined && !fields.includes(key)) errors.push(`${p}.${key}: not supported by template ${c.template}`);
  if (c.template === 'evidence-json') {
    const path = str('path'), required = list('required');
    required.forEach((field, i) => { if (field.split('.').some(part => !part)) errors.push(`${p}.required[${i}]: expected dot-separated field path without empty segments`); });
    const script = "const fs=require('node:fs');const [path,...required]=process.argv.slice(1);try{const data=JSON.parse(fs.readFileSync(path,'utf8'));for(const field of required){let value=data;for(const part of field.split('.')){if(value===null||typeof value!=='object'||!Object.hasOwn(value,part))throw new Error('missing field '+field);value=value[part]}}console.log('owed-counts '+JSON.stringify({pass:1,fail:0}))}catch(e){console.error('evidence-json: '+e.message);console.log('owed-counts '+JSON.stringify({pass:0,fail:1,failed:['evidence-json: '+path]}));process.exitCode=1}";
    return { run: errors.length === start ? `# owed-template/v${CHECK_TEMPLATE_VERSION}/evidence-json\nnode -e ${templateQuote(script)} -- ${[path, ...required].map(templateQuote).join(' ')}` : '' };
  }
  const min = c.min_ok;
  if (typeof min !== 'number' || !Number.isSafeInteger(min) || min < 0) errors.push(`${p}.min_ok: expected integer >= 0`);
  if (c.min_tests !== undefined && c.min_tests !== min) errors.push(`${p}.min_tests: must equal template min_ok`);
  let command: string;
  if (c.template === 'cargo-tests') {
    const pkg = str('package'), target = c.test === undefined ? undefined : str('test'), filters = c.filters === undefined ? [] : list('filters', true);
    command = `cargo test -p ${templateQuote(pkg)}${target === undefined ? '' : ` --test ${templateQuote(target)}`} --${filters.length ? ` ${filters.map(templateQuote).join(' ')}` : ''}`;
  } else {
    const files = list('files'), prefix = c.name_prefix === undefined ? undefined : str('name_prefix');
    const pattern = prefix?.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    command = `node --test --test-reporter=tap${pattern === undefined ? '' : ` --test-name-pattern=${templateQuote(`^${pattern}`)}`} -- ${files.map(templateQuote).join(' ')}`;
  }
  return { run: errors.length === start ? `# owed-template/v${CHECK_TEMPLATE_VERSION}/${c.template}\nset -o pipefail; ${command} | ${templateCounter(c.template === 'cargo-tests' ? 'cargo' : 'tap', min as number, c.template === 'node-tap' ? c.files as string[] : [])}` : '', ...(typeof min === 'number' ? { min_tests: min } : {}) };
}
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
  const checks = (v: unknown, label: string): InvariantSpec[] => {
    const ids = new Set<string>();
    return arr(v ?? [], label).map((x, i) => {
      const p = `${label}[${i}]`, c = obj(x, p), id = str(c.id, `${p}.id`);
      if (ids.has(id)) errors.push(`${p}: duplicate id ${id}`); ids.add(id);
      const template = expandCheckTemplate(c, p, errors);
      let runFile: CheckSpec['run_file'], args: string[] | undefined;
      if (c.run_file !== undefined) {
        const file = obj(c.run_file, `${p}.run_file`), path = str(file.path, `${p}.run_file.path`);
        if (path.split('/').some(s => !/^[A-Za-z0-9._@+,=-]+$/.test(s) || s === '.' || s === '..')) errors.push(`${p}.run_file.path: expected normal repository-relative path; allowed segment characters: A-Z a-z 0-9 . _ @ + , = -`);
        if (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(file.sha256)) errors.push(`${p}.run_file.sha256: expected 64 lowercase hex characters`);
        for (const k of Object.keys(file)) if (k !== 'path' && k !== 'sha256') errors.push(`${p}.run_file.${k}: unknown key`);
        runFile = { path, sha256: file.sha256 as string };
        if (c.template !== undefined) errors.push(`${p}: template and run_file are exclusive`);
        if (c.args !== undefined) {
          const list = arr(c.args, `${p}.args`);
          if (list.length > 64 || list.some(s => typeof s !== 'string' || s.includes('\0'))) errors.push(`${p}.args: expected at most 64 strings without NUL`);
          args = list as string[];
        }
      } else if (c.args !== undefined) errors.push(`${p}: args requires run_file`);
      const derived = runFile ? `exec ./${runFile.path}${args?.length ? ' ' + args.filter(s => typeof s === 'string').map(s => `'${s.replaceAll("'", "'\\''")}'`).join(' ') : ''}` : undefined;
      if (derived !== undefined && c.run !== undefined && c.run !== derived) errors.push(`${p}: run and run_file are exclusive`);
      const out: InvariantSpec = { id, ...(runFile ? { run_file:runFile, ...(args !== undefined ? { args } : {}) } : {}), run: derived ?? template?.run ?? str(c.run, `${p}.run`), timeout_s: num(c.timeout_s ?? 600, `${p}.timeout_s`, 1), reads: strings(c.reads ?? ['**'], `${p}.reads`), ...(template?.min_tests !== undefined ? { min_tests: template.min_tests } : {}) };
      if (c.on_timeout !== undefined) out.on_timeout = str(c.on_timeout, `${p}.on_timeout`);
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
      // RC1: normalize the default need so explicit and implicit defaults share a key.
      if (c.repeat !== undefined) {
        const repeat = obj(c.repeat, `${p}.repeat`);
        for (const k of Object.keys(repeat)) if (k !== 'runs' && k !== 'need') errors.push(`${p}.repeat.${k}: unknown key`);
        const runs = num(repeat.runs, `${p}.repeat.runs`, 1), need = num(repeat.need === undefined ? runs : repeat.need, `${p}.repeat.need`, 1);
        if (runs > 9 || need > runs) errors.push(`${p}.repeat: expected 1 <= need <= runs <= 9`);
        if (out.red || out.mutants !== undefined) errors.push(`${p}.repeat: not allowed on red or mutants checks`);
        out.repeat = { runs, need };
      }
      if (c.remeasure_on !== undefined) {
        if (label !== 'invariants') errors.push(`${p}.remeasure_on: only supported on invariants; move it to an invariant`);
        out.remeasure_on = strings(c.remeasure_on, `${p}.remeasure_on`);
      }
      if (c.known_red !== undefined) {
        if (label !== 'invariants') errors.push(`${p}.known_red: only supported on invariants`);
        const entries = arr(c.known_red, `${p}.known_red`), names = new Set<string>();
        if (entries.length > 20) errors.push(`${p}.known_red: at most 20 entries`);
        out.known_red = entries.map((entry, index) => {
          const q = `${p}.known_red[${index}]`, e = obj(entry, q);
          for (const k of Object.keys(e)) if (k !== 'test' && k !== 'fix') errors.push(`${q}.${k}: unknown key`);
          const test = str(e.test, `${q}.test`), fix = str(e.fix, `${q}.fix`);
          if (names.has(test)) errors.push(`${q}: duplicate known_red test ${test}`);
          names.add(test);
          return { test, fix };
        });
      }
      if (c.quarantine !== undefined) out.quarantine = parseQuarantine(c.quarantine, `${p}.quarantine`, errors);
      if (c.quarantine_set !== undefined) out.quarantine_set = str(c.quarantine_set, `${p}.quarantine_set`);
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
    if (n.allow_only !== undefined) {
      out.allow_only = strings(n.allow_only, `${p}.allow_only`);
      for (const entry of out.allow_only) { const error = writesEntryError(entry); if (error) errors.push(`${p}.allow_only: ${error}`); }
    }
    if (n.title !== undefined) out.title = str(n.title, `${p}.title`);
    if (n.brief !== undefined) out.brief = str(n.brief, `${p}.brief`);
    if (n.type !== undefined) { if (typeof n.type !== 'string' || !/^[a-z][a-z0-9-]*$/.test(n.type)) errors.push(`${p}.type: expected a string matching ^[a-z][a-z0-9-]*$`); else out.type = n.type; }
    if (n.later !== undefined) { if (typeof n.later !== 'boolean') errors.push(`${p}.later: expected boolean`); else if (n.later) out.later = true; }
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
  for (const inv of plan.invariants) for (const entry of inv.known_red ?? []) if (!ids.has(entry.fix)) errors.push(`invariants: ${inv.id}: known_red fix ${entry.fix} is not a node of this plan`);
  if (r.quarantine_sets !== undefined) {
    plan.quarantine_sets = {};
    for (const [name, entries] of Object.entries(obj(r.quarantine_sets, 'quarantine_sets'))) {
      if (!/^[A-Za-z0-9_.-]+$/.test(name)) errors.push(`quarantine_sets: invalid set name ${JSON.stringify(name)}`);
      Object.defineProperty(plan.quarantine_sets, name, { value: parseQuarantine(entries, `quarantine_sets.${name}`, errors, 200), enumerable: true, configurable: true, writable: true });
    }
  }
  errors.push(...quarantineFixErrors(plan, ids));
  if (r.setup !== undefined) plan.setup = str(r.setup, 'setup');
  if (r.slot_setup !== undefined) {
    if (r.slot_setup === false) plan.slot_setup = false;
    else plan.slot_setup = str(r.slot_setup, 'slot_setup');
  }
  if (r.lease !== undefined) { if (typeof r.lease !== 'boolean') errors.push('lease: expected boolean'); else plan.lease = r.lease; }
  if (r.env_signatures !== undefined) {
    const env = obj(r.env_signatures, 'env_signatures');
    for (const k of Object.keys(env)) if (k !== 'match' && k !== 'unless') errors.push(`env_signatures.${k}: unknown key`);
    const regexes = (v: unknown, label: string): string[] => strings(v, label).map(value => {
      if (value.length > 300) errors.push(`${label}: regex must be <= 300 characters`);
      try { new RegExp(value); } catch { errors.push(`${label}: invalid regex`); }
      return value;
    });
    const match = regexes(env.match, 'env_signatures.match');
    if (!match.length) errors.push('env_signatures.match: expected at least one regex');
    plan.env_signatures = { match, ...(env.unless !== undefined ? { unless: regexes(env.unless, 'env_signatures.unless') } : {}) };
  }
  if (r.sweep !== undefined) {
    const sw = obj(r.sweep, 'sweep');
    for (const k of Object.keys(sw)) if (!['run', 'timeout_s', 'reads', 'every'].includes(k)) errors.push(`sweep.${k}: unknown key`);
    plan.sweep = { run: str(sw.run, 'sweep.run'), timeout_s: num(sw.timeout_s ?? 600, 'sweep.timeout_s', 1) };
    if (sw.reads !== undefined) plan.sweep.reads = strings(sw.reads, 'sweep.reads');
    if (sw.every !== undefined) {
      const every = obj(sw.every, 'sweep.every');
      for (const k of Object.keys(every)) if (!['merges','minutes'].includes(k)) errors.push(`sweep.every.${k}: unknown key`);
      if (every.merges === undefined && every.minutes === undefined) errors.push('sweep.every: at least one of merges or minutes is required');
      plan.sweep.every = {
        ...(every.merges !== undefined ? {merges:num(every.merges,'sweep.every.merges',1)} : {}),
        ...(every.minutes !== undefined ? {minutes:num(every.minutes,'sweep.every.minutes',1)} : {}),
      };
    }
  }
  if (r.limits !== undefined) {
    const limits = obj(r.limits, 'limits');
    plan.limits = {};
    for (const k of Object.keys(limits)) if (k !== 'file_mib' && k !== 'diff_mib') errors.push(`limits.${k}: unknown key`);
    for (const k of ['file_mib', 'diff_mib'] as const) {
      const value = limits[k];
      if (value === undefined) continue;
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) errors.push(`limits.${k}: expected a positive finite number`);
      else plan.limits[k] = value;
    }
  }
  if (r.drive !== undefined) plan.drive = parseDriveBatch(r.drive, errors);
  if (r.worktrees !== undefined) plan.worktrees = parseWorktrees(r.worktrees, errors);
  if (r.exec !== undefined) { const exec = parseExec(r.exec, errors); if (exec) plan.exec = exec; }
  if (r.risk !== undefined) plan.risk = arr(r.risk, 'risk').map((value, i) => {
    const label = `risk[${i}]`, rule = obj(value, label), review = obj(rule.review, `${label}.review`);
    for (const key of Object.keys(rule)) if (!['paths', 'review'].includes(key)) errors.push(`${label}.${key}: unknown key`);
    for (const key of Object.keys(review)) if (!['count', 'min_rank'].includes(key)) errors.push(`${label}.review.${key}: unknown key`);
    const paths = strings(rule.paths, `${label}.paths`);
    if (!paths.length) errors.push(`${label}.paths: expected at least one scope`);
    for (const path of paths) { const error = writesEntryError(path); if (error || path.includes('\0')) errors.push(`${label}.paths: ${error ?? 'NUL is not allowed'}`); }
    const count = num(review.count, `${label}.review.count`, 0), min_rank = num(review.min_rank, `${label}.review.min_rank`, 1);
    if (min_rank > 3) errors.push(`${label}.review.min_rank must be <= 3`);
    return { paths, review: { count, min_rank } };
  });
  if (r.closure_neutral !== undefined) {
    const seen = new Set<string>();
    plan.closure_neutral = arr(r.closure_neutral, 'closure_neutral').map((value, i) => {
      const label = `closure_neutral[${i}]`, rule = obj(value, label);
      for (const key of Object.keys(rule)) if (!['path', 'json_ignore'].includes(key)) errors.push(`${label}.${key}: unknown key`);
      const path = str(rule.path, `${label}.path`), json_ignore = strings(rule.json_ignore, `${label}.json_ignore`);
      if (writesEntryError(path) || /[?*\0]/.test(path) || path.endsWith('/')) errors.push(`${label}.path: expected an exact relative file path`);
      if (seen.has(path)) errors.push(`${label}.path: duplicate path ${path}`);
      seen.add(path);
      if (json_ignore.some(p => p.includes('\0'))) errors.push(`${label}.json_ignore: NUL is not allowed`);
      return { path, json_ignore };
    });
  }
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
const CARGO_TEST = /\bcargo\s+(?:\+\S+\s+)?test\b/;
/**
 * 0.8 (L3.3, app #22): one warning per check (or invariant) that sets `min_tests` and repeats its command in a shell
 * loop. exec.ts (`parseCounts`) does not add up repeated TAP, jest/vitest or pytest runs: each later `# tests`/`# pass`/`# fail`
 * line (else `1..N` plan), `Tests:` summary or pytest summary line replaces the earlier one, so min_tests sees one run's count; only cargo
 * `test result:` lines are summed. `owed plan` / `owed init` print it with the H2.2 warnings; nothing is refused.
 */
export function loopWarnings(plan: Plan, merged: ReadonlySet<string> = new Set()): string[] {
  // F4 (app #31): cargo test is exempt: its `test result:` lines are summed, so the count is right.
  const one = (where: string, c: CheckSpec): string[] => c.min_tests !== undefined && SHELL_LOOP.test(c.run) && !CARGO_TEST.test(c.run)
    ? [`warning: ${where} runs its command in a shell loop with min_tests ${c.min_tests}: min_tests counts only the last TAP (# tests), jest/vitest (Tests:) or pytest (N passed) summary in the log, i.e. one run, not the sum of the runs (only cargo "test result:" lines are added up)`] : [];
  return [...plan.invariants.flatMap(c => one(`invariant ${c.id}`, c)), ...plan.nodes.filter(n => !merged.has(n.id)).flatMap(n => n.checks.flatMap(c => one(`check ${c.id} of node ${n.id}`, c)))];
}
/** The warnings `owed plan` / `owed init` print after the result: check-less nodes (H2.2), then looped checks (L3.3). */
export const planWarnings = (plan: Plan, merged: ReadonlySet<string> = new Set()): string[] => [...checklessWarnings(plan, merged), ...loopWarnings(plan, merged)];
/** KR1 (#1484): additions and reassignment are owner-only downgrades; deletion is free. */
export function knownRedDowngrades(prev: Plan, next: Plan): Downgrade[] {
  return next.invariants.flatMap(inv => (inv.known_red ?? []).flatMap(entry => {
    const old = prev.invariants.find(i => i.id === inv.id)?.known_red?.find(e => e.test === entry.test);
    return old?.fix === entry.fix ? [] : [{ node: 'trunk', what: `inv:${inv.id} known_red ${JSON.stringify(entry.test)} ${old ? `fix changed from ${old.fix} to` : 'added with fix'} ${entry.fix} (owner only)` }];
  }));
}
/** MS4: `quarantine: [{test, fix, note?}]` of an invariant or check: exact names, unique, at most 20. */
function parseQuarantine(v: unknown, label: string, errors: string[], limit = 20): QuarantineEntry[] {
  if (!Array.isArray(v)) { errors.push(`${label}: expected array`); return []; }
  if (v.length > limit) errors.push(`${label}: at most ${limit} entries`);
  const names = new Set<string>();
  return v.map((entry, index) => {
    const q = `${label}[${index}]`;
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) { errors.push(`${q}: expected object`); return { test: '', fix: '' }; }
    const e = entry as Record<string, unknown>;
    for (const k of Object.keys(e)) if (!['test', 'fix', 'note'].includes(k)) errors.push(`${q}.${k}: unknown key`);
    const text = (x: unknown, what: string): string => { if (typeof x !== 'string' || !x.trim()) { errors.push(`${q}.${what}: expected non-empty string`); return ''; } return x; };
    const test = text(e.test, 'test'), fix = text(e.fix, 'fix');
    // Existing own-entry ledgers may contain line breaks; only shared lists have the stricter grammar.
    if (limit === 200 && /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(test)) errors.push(`${q}.test: must not contain control characters`);
    if (names.has(test)) errors.push(`${q}: duplicate quarantine test ${test}`);
    names.add(test);
    return { test, fix, ...(e.note !== undefined ? { note: text(e.note, 'note') } : {}) };
  });
}
/** MS4: every quarantine `fix` names a node of the plan. */
function quarantineFixErrors(plan: Plan, ids: Map<string, NodeSpec>): string[] {
  const fixes = (where: string, entries: QuarantineEntry[]): string[] => entries.filter(e => e.fix && !ids.has(e.fix)).map(e => `${where}: quarantine fix ${e.fix} is not a node of this plan`);
  const one = (where: string, c: CheckSpec): string[] => {
    const errors = fixes(where, c.quarantine ?? []);
    if (c.quarantine_set !== undefined) {
      const entries = Object.hasOwn(plan.quarantine_sets ?? {}, c.quarantine_set) ? plan.quarantine_sets![c.quarantine_set] : undefined;
      if (!entries) errors.push(`${where}: quarantine_set ${c.quarantine_set} is not a defined set`);
      else for (const e of c.quarantine ?? []) if (entries.some(x => x.test === e.test)) errors.push(`${where}: duplicate quarantine test ${JSON.stringify(e.test)} in own entries and set ${c.quarantine_set}`);
    }
    return errors;
  };
  return [...Object.entries(plan.quarantine_sets ?? {}).flatMap(([name, entries]) => fixes(`set ${name}`, entries)), ...plan.invariants.flatMap(c => one(`invariants: ${c.id}`, c)), ...plan.nodes.flatMap(n => n.checks.flatMap(c => one(`${n.id}: check ${c.id}`, c)))];
}
/**
 * MS4: the active quarantine entries of a check or invariant: its `fix` is a node of `plan`, not merged, and not the
 * node being merged (`merging`, whose merge result is measured as if it had merged).
 */
export function activeQuarantine(plan: Plan, spec: CheckSpec, merged: (id: string) => boolean, merging?: string): QuarantineEntry[] {
  const shared = spec.quarantine_set !== undefined && Object.hasOwn(plan.quarantine_sets ?? {}, spec.quarantine_set) ? plan.quarantine_sets![spec.quarantine_set]! : [];
  return [...(spec.quarantine ?? []), ...shared].filter(e => e.fix !== merging && plan.nodes.some(n => n.id === e.fix) && !merged(e.fix));
}
/** MS4: the sorted active quarantine names per spec, the part of a check/invariant key (empty = the 0.17 key). */
export type QuarantineNames = (spec: CheckSpec) => string[];
export function quarantineNames(plan: Plan, merged: (id: string) => boolean, merging?: string): QuarantineNames {
  return spec => activeQuarantine(plan, spec, merged, merging).map(e => e.test).sort();
}
/** MS4: adding a quarantine name or changing its fix is an owner-only downgrade (no allow rule covers it); deletion is free. */
export function quarantineDowngrades(prev: Plan, next: Plan): Downgrade[] {
  const entries = (node: string, label: string, before: QuarantineEntry[], after: QuarantineEntry[]): Downgrade[] => after.flatMap(entry => {
    const old = before.find(e => e.test === entry.test);
    return old?.fix === entry.fix ? [] : [{ node, what: `${label} quarantine ${JSON.stringify(entry.test)} ${old ? `fix changed from ${old.fix} to` : 'added with fix'} ${entry.fix} (owner only)` }];
  });
  const one = (node: string, label: string, before: CheckSpec | undefined, after: CheckSpec): Downgrade[] => [
    ...entries(node, label, before?.quarantine ?? [], after.quarantine ?? []),
    ...(after.quarantine_set !== undefined && before?.quarantine_set !== after.quarantine_set ? [{ node, what: `${label} quarantine_set ${before?.quarantine_set !== undefined ? `changed from set ${before.quarantine_set} to` : 'added with'} set ${after.quarantine_set} (owner only)` }] : []),
  ];
  return [...Object.entries(next.quarantine_sets ?? {}).flatMap(([name, list]) => entries('trunk', `set ${name}`, Object.hasOwn(prev.quarantine_sets ?? {}, name) ? prev.quarantine_sets![name]! : [], list)),
    ...next.invariants.flatMap(c => one('trunk', `inv:${c.id}`, prev.invariants.find(i => i.id === c.id), c)),
    ...next.nodes.flatMap(n => n.checks.flatMap(c => one(n.id, `check ${c.id}`, prev.nodes.find(x => x.id === n.id)?.checks.find(x => x.id === c.id), c)))];
}
export function planDowngrades(prev: Plan, next: Plan): Downgrade[] {
  const out: Downgrade[] = [...knownRedDowngrades(prev, next), ...quarantineDowngrades(prev, next), ...riskDowngrades(prev, next)];
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
    if (m.writes.some(p => !n.writes.some(old => writeCovers(old, p, writesSyntax(prev), writesSyntax(next))))) out.push({ node: n.id, what: 'writes widened' });
    if (allowOnlyWidened(n,m)) out.push({ node:n.id, what:`allow_only widened: ${n.id}` });
    out.push(...manualDowngrades(n.id, n, m));
  }
  if (allowWidened(prev, next)) out.push({ node: 'trunk', what: 'allow changed' });
  return out;
}
