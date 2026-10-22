import { readFile, realpath, lstat } from 'node:fs/promises';
import { isAbsolute, relative, resolve } from 'node:path';
import { canonical, sha256 } from './canon.ts';
import { parsePlan, repositoryPath } from './plan.ts';
import { OwedError } from './errors.ts';
import { Dsa } from './dsa.ts';
import type { AAct, Draft, Entry, Plan, RunQuestion, StageBundle, StageEntry, StageView, State } from './types.ts';

const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const digest = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
function refuse(text: string): never { throw new OwedError(text, 'usage'); }
/**
 * SG3: the dsa describe for a stage's open questions failed, so its freshness cannot be computed. An accept refuses
 * it retryably and records nothing; a read-only listing keeps it with the reason instead of failing wholesale.
 */
export class UnverifiedQuestions extends OwedError {
  readonly reason: string;
  constructor(reason: string) { super(`${reason}; retry`); this.reason = reason; }
}
function keys(v: Record<string, unknown>, allowed: string[], label: string): void {
  const unknown = Object.keys(v).find(k => !allowed.includes(k)); if (unknown) refuse(`${label}: unknown field ${unknown}`);
}
function strings(v: unknown, label: string, nonempty = false): asserts v is string[] {
  if (!Array.isArray(v) || nonempty && !v.length || v.some(x => typeof x !== 'string' || !x.trim())) refuse(`${label}: expected ${nonempty ? 'nonempty ' : ''}string array`);
}
export function parseBundle(bytes: string): StageBundle {
  let v: unknown; try { v = JSON.parse(bytes); } catch { refuse('stage bundle must be JSON'); }
  if (!object(v)) refuse('stage bundle must be an object');
  keys(v, ['ruling_text','decide','plan_patch','appends','evidence','read_through_seq','touches','class','summary'], 'stage bundle');
  if (typeof v.ruling_text !== 'string' || v.ruling_text.length > 8000) refuse('ruling_text: expected string, at most 8000 chars');
  if (!Number.isSafeInteger(v.read_through_seq) || Number(v.read_through_seq) < 0) refuse('read_through_seq: expected nonnegative integer');
  if (typeof v.summary !== 'string' || !v.summary.trim() || v.summary.split(/\r?\n/).length > 10 || v.summary.split(/\r?\n/).some(l => l.length > 160)) refuse('summary: expected 1..10 lines of at most 160 chars');
  if (v.class !== undefined && !['A','B','C'].includes(String(v.class))) refuse('class: expected A, B or C');
  if (v.touches !== undefined) strings(v.touches, 'touches');
  if (v.decide !== undefined) {
    if (!object(v.decide)) refuse('decide: expected object');
    const d = v.decide;
    keys(d, ['nodes','writes','resume','expect','writer','allow_only','after','remeasure'], 'decide');
    strings(d.nodes, 'decide.nodes', true);
    for (const key of ['writes','allow_only'] as const) if (d[key] !== undefined) strings(d[key], `decide.${key}`, key === 'writes');
    for (const key of ['resume','writer','remeasure']) if (d[key] !== undefined && typeof d[key] !== 'boolean') refuse(`decide.${key}: expected boolean`);
    if (d.expect !== undefined && d.expect !== 'report') refuse('decide.expect: expected report');
    if (d.after !== undefined && typeof d.after !== 'string') strings(d.after, 'decide.after', true);
    if (d.resume === false && (d.expect !== undefined || d.after !== undefined || d.remeasure)) refuse('decide: resume false cannot take expect, after or remeasure');
  }
  if (v.plan_patch !== undefined) {
    if (!object(v.plan_patch)) refuse('plan_patch: expected object');
    keys(v.plan_patch, ['file','before_sha256','after_sha256','self_check'], 'plan_patch');
    if (typeof v.plan_patch.file !== 'string' || !v.plan_patch.file.trim()) refuse('plan_patch.file: expected nonempty string');
    if (!digest(v.plan_patch.before_sha256) || !digest(v.plan_patch.after_sha256)) refuse('plan_patch: expected before_sha256 and after_sha256');
    if (v.plan_patch.self_check !== undefined && typeof v.plan_patch.self_check !== 'string') refuse('plan_patch.self_check: expected string');
  }
  for (const key of ['appends','evidence'] as const) {
    if (v[key] === undefined) continue;
    if (!Array.isArray(v[key])) refuse(`${key}: expected array`);
    for (const item of v[key]) {
      if (!object(item)) refuse(`${key}: expected objects`);
      keys(item, key === 'appends' ? ['path','text'] : ['path','sha256'], key);
      if (typeof item.path !== 'string' || !item.path.trim()) refuse(`${key}.path: expected nonempty string`);
      if (key === 'appends' && (!repositoryPath(item.path) || typeof item.text !== 'string' || item.text.length > 4000)) refuse('appends: expected repository path and text of at most 4000 chars');
      if (key === 'evidence' && !digest(item.sha256)) refuse('evidence.sha256: expected sha256');
    }
    if (key === 'appends' && new Set(v[key].map(x => (x as {path:string}).path)).size !== v[key].length) refuse('appends: duplicate path');
  }
  return v as unknown as StageBundle;
}
export const stageId = (seq: number): string => `S${seq}`;
export function stageSeq(id: string): number {
  if (!/^S(?:0|[1-9][0-9]*)$/.test(id) || !Number.isSafeInteger(Number(id.slice(1)))) refuse('stage id must be S<seq>');
  return Number(id.slice(1));
}
export function stageEntry(entries: readonly Entry[], id: string): StageEntry {
  const e = entries.find(e => e.seq === stageSeq(id)); if (e?.kind !== 'stage') throw new OwedError(`stage ${id} does not exist`); return e;
}
export function stageClosed(entries: readonly Entry[], e: StageEntry): 'accepted' | 'rejected' | undefined {
  const closed = entries.find(x => (x.kind === 'accept' || x.kind === 'reject') && x.stage === stageId(e.seq));
  return closed?.kind === 'accept' ? 'accepted' : closed?.kind === 'reject' ? 'rejected' : undefined;
}
export function stageTouches(bundle: StageBundle, node: string, plan: Plan): string[] {
  const ids = new Set(plan.nodes.map(n => n.id)), touches = [...new Set([node,...(bundle.touches ?? []),...(bundle.decide?.nodes ?? []),...(bundle.appends?.map(a => a.path) ?? [])])];
  for (const value of touches) if (!ids.has(value) && !repositoryPath(value)) refuse(`touches: ${value} is neither a node nor a repository path`);
  return touches;
}
export const overlap = (a: string[], b: string[], plan: Plan): boolean => a.some(x => b.some(y => x === y || !plan.nodes.some(n => n.id === x || n.id === y) && (x.startsWith(`${y}/`) || y.startsWith(`${x}/`))));
/** SG3's exact ledger-kind mapping; bookkeeping deliberately never invalidates a fork. */
export const CHANGING_KINDS = ['halt','submit','review','rule','resume','abandon','merge','dispatch','launch','rebase','hold','waive','defer','evidence','grant'] as const;
export function stageLedgerReason(e: StageEntry, entries: readonly Entry[], plan: Plan, planAtRead: Plan, lookup?: (sha:string) => Plan): string | undefined {
  const ids = new Set(e.touches.filter(x => plan.nodes.some(n => n.id === x) || planAtRead.nodes.some(n => n.id === x)));
  ids.add(e.node);
  for (const entry of entries) {
    if (entry.seq <= e.read_through_seq) continue;
    if (entry.kind === 'plan') {
      const next = lookup ? lookup(entry.plan) : plan;
      if ([...ids].some(id => canonical(planAtRead.nodes.find(n => n.id === id)) !== canonical(next.nodes.find(n => n.id === id)))) return `${entry.seq}/plan`;
      continue;
    }
    const measured = entry.kind === 'obs' && entry.by === 'executor:owed' && entry.probe === undefined;
    if (!measured && !(CHANGING_KINDS as readonly string[]).includes(entry.kind)) continue;
    const names = entry.kind === 'rule' ? entry.nodes === '*' ? [...ids] : entry.nodes : entry.kind === 'obs' ? [entry.subject,...(entry.merging ? [entry.merging] : [])] : 'node' in entry ? [entry.node] : [];
    if (names.some(x => ids.has(x))) return `${entry.seq}/${entry.kind}`;
  }
  return undefined;
}
export async function stageFileReason(cwd: string, e: StageEntry, crashRetry = false): Promise<string | undefined> {
  if (!e.plan_path) return;
  const hash = await readFile(resolve(cwd,e.plan_path)).then(sha256).catch(() => 'missing');
  if (hash !== e.before_sha256 && !(crashRetry && hash === e.after_sha256)) return 'plan hash changed';
}
/** Resolve symlinks too: appends cannot escape the repository through an allowed path. */
export async function repositoryFile(root: string, path: string): Promise<string> {
  if (!repositoryPath(path)) refuse(`expected repository path: ${path}`);
  const target = resolve(root,path);
  const {dirname,basename} = await import('node:path');
  const tail: string[] = [];
  let ancestor = target, physical: string;
  for (;;) {
    try {physical = resolve(await realpath(ancestor),...tail);break;}
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || await lstat(ancestor).then(s=>s.isSymbolicLink()).catch(()=>false)) throw new OwedError(`cannot resolve repository path: ${path}`);
      if (dirname(ancestor) === ancestor) throw error;
      tail.unshift(basename(ancestor));ancestor = dirname(ancestor);
    }
  }
  const rel = relative(await realpath(root),physical);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) refuse(`path escapes repository: ${path}`);
  return target;
}
export async function questionFingerprint(s: State, node: string, client: Pick<Dsa,'describe'>): Promise<string> {
  const n = s.nodes[node], launches = n?.slot?.open ? n.runs.find(r => r.attempt === n.slot!.attempt)?.launches.filter(l => l.role === 'writer') ?? [] : [];
  const questions: {qid:string;rev:number}[] = [];
  for (const l of launches) {
    const view = await client.describe(l.rid);
    if (view.state === 'asking') questions.push(...(view.questions ?? []).map(q => ({qid:q.qid,rev:q.rev})));
  }
  return canonical(questions.sort((a,b) => a.qid.localeCompare(b.qid) || a.rev-b.rev));
}
const forkCache = new Map<string, Promise<{node:string;call:string} | undefined>>();
/** Once per call identity per process, including failed resolutions. */
export async function forkPrincipal(cwd: string, env: NodeJS.ProcessEnv = process.env): Promise<{node:string;call:string} | undefined> {
  const call = env.DSA_CALL || env.DSA_EXEC; if (!call) return;
  let p = forkCache.get(call);
  if (!p) {
    p = new Dsa({cwd}).describe(call).then(view => typeof view.labels?.owed_fork === 'string' && view.labels.owed_fork ? {node:view.labels.owed_fork,call} : undefined).catch(() => undefined);
    forkCache.set(call,p);
  }
  return p;
}
export function actKind(entry: Entry | Draft): AAct | undefined { return 'via' in entry && entry.via ? entry.kind === 'rule' ? 'preferred-answer' : entry.kind === 'resume' ? 'infra-resume' : undefined : undefined; }
export function disabledActs(entries: readonly Entry[], plan: Plan): {kind:AAct;seq:number}[] {
  const lastPlan = entries.findLast(e => e.kind === 'plan' || e.kind === 'genesis')?.seq ?? -1;
  const out = new Map<AAct,number>();
  for (const e of entries) if (e.kind === 'overturn') {
    const act = entries.find(a => a.seq === e.act), kind = act && actKind(act);
    if (kind && !(lastPlan > e.seq && plan.drive?.delegate?.a_acts?.includes(kind))) out.set(kind,e.seq);
  }
  return [...out].map(([kind,seq]) => ({kind,seq}));
}
export function aActAllowed(entries: readonly Entry[], plan: Plan, kind: AAct): boolean { return !!plan.drive?.delegate?.a_acts?.includes(kind) && !disabledActs(entries,plan).some(x => x.kind === kind); }
export function preferredOption(question: RunQuestion, text: string): boolean {
  const options = question.options ?? [], selected = /^option\s+(\d+)(?:\s*[;:. -]|$)/i.exec(text.trim());
  return options.filter(o => o.preferred).length === 1 && !!selected && options[Number(selected[1])-1]?.preferred === true;
}
export function stageLines(stages: StageView[]): string {
  return stages.length ? stages.map(s => `${s.id} ${s.node} class ${s.class} ${s.state}${s.reason ? `: ${s.reason}` : ''} (${Math.floor(s.age/1000)}s): ${s.summary.split(/\r?\n/)[0]} → ${s.command}`).join('\n') : 'No stages';
}
export function stageDraftErrors(s: State, d: Draft, entries: readonly Entry[]): string[] {
  const errors: string[] = [], hash = (v: unknown) => digest(v);
  const allowed: Record<string,string[]> = {
    stage:['node','bundle','patched_plan','plan_path','questions','touches','class','summary','read_through_seq','before_sha256','after_sha256'],
    accept:['stage','ruling','plan'],reject:['stage','note'],overturn:['act','note'],
  };
  const base = ['kind','by','channel','seq','ts','prev','hash','ignorable'];
  for (const key of Object.keys(d)) if (!base.includes(key) && !allowed[d.kind]?.includes(key)) errors.push(`${d.kind}: unknown field ${key}`);
  if (d.kind === 'stage') {
    if (!hash(d.bundle) || d.patched_plan !== undefined && !hash(d.patched_plan)) errors.push('stage requires blob hashes');
    if (!Number.isSafeInteger(d.read_through_seq) || d.read_through_seq < 0 || d.read_through_seq > s.seq) errors.push('stage read_through_seq exceeds ledger head');
    if (!['A','B','C'].includes(d.class) || typeof d.summary !== 'string' || !d.summary.trim() || d.summary.split(/\r?\n/).length > 10 || d.summary.split(/\r?\n/).some(l => l.length > 160)) errors.push('invalid stage class or summary');
    if (typeof d.questions !== 'string' || !Array.isArray(d.touches) || !d.touches.includes(d.node) || d.touches.some(p => typeof p !== 'string' || !s.plan.nodes.some(n => n.id === p) && !repositoryPath(p))) errors.push('invalid stage questions or touches');
    if (typeof d.questions === 'string') {
      try {const q=JSON.parse(d.questions);if(!Array.isArray(q) || q.some(x=>!object(x) || Object.keys(x).some(k=>!['qid','rev'].includes(k)) || typeof x.qid !== 'string' || !Number.isSafeInteger(x.rev) || Number(x.rev) < 1)) errors.push('invalid stage question fingerprint');}catch {errors.push('invalid stage question fingerprint');}
    }
    if (d.patched_plan !== undefined && (!d.plan_path || !digest(d.before_sha256) || !digest(d.after_sha256))) errors.push('stage patch needs plan path and hashes');
  } else if (d.kind === 'accept' || d.kind === 'reject') {
    let stage: StageEntry | undefined; try { stage = stageEntry(entries,d.stage); } catch { errors.push('unknown stage'); }
    if (stage && stageClosed(entries,stage)) errors.push('stage is already closed');
    if (d.kind === 'reject' && (typeof d.note !== 'string' || !d.note.trim())) errors.push('reject requires a note');
    if (d.kind === 'accept') {
      const rule = entries.find(e => e.seq === d.ruling);
      if (rule?.kind !== 'rule' || !rule.text.endsWith(` [stage ${d.stage}]`)) errors.push('accept must cite its stage ruling');
      if (d.plan !== undefined && entries.find(e => e.seq === d.plan)?.kind !== 'plan') errors.push('accept must cite a recorded plan');
    }
  } else if (d.kind === 'overturn') {
    const act = entries.find(e => e.seq === d.act);
    if (!act || !actKind(act)) errors.push('overturn must cite a fork A act');
    if (typeof d.note !== 'string' || !d.note.trim()) errors.push('overturn requires a note');
  }
  if (d.kind !== 'stage' && ['accept','reject','overturn'].includes(d.kind) && !/^(parent|owner):/.test(d.by)) errors.push(`${d.kind} requires parent or owner`);
  return errors;
}
