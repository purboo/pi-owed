// Native worker transport. No runtime dependency on pi: npm/git installs may omit its optional peers.
import { Worker, SHARE_ENV, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync, statSync } from 'node:fs';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { OwedError } from './errors.ts';
import { sessionIdentity } from './registry.ts';
import type { OwedErrorCode } from './errors.ts';

const manifest = new URL('../package.json', import.meta.url);
export const loadedVersion: string = JSON.parse(readFileSync(manifest, 'utf8')).version;
let stamp = '', installed = loadedVersion;
export function installedVersion(): string {
  const s = statSync(manifest), key = `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  if (key !== stamp) { installed = JSON.parse(readFileSync(manifest, 'utf8')).version; stamp = key; }
  return installed;
}
export const restartLine = (version = installedVersion()): string => `owed ${version} is installed but this pi session loaded ${loadedVersion}: restart pi to use it.`;
const defaultNotices = new Set<string>();
export function versionNotice<T extends { content: { type: string; text?: string }[]; details?: unknown }>(r: T, options: { seen?: Set<string>; full?: boolean; version?: string; loaded?: string } = {}): T {
  const version = options.version ?? installedVersion(), seen = options.seen ?? defaultNotices;
  const loaded = options.loaded ?? loadedVersion;
  const line = `owed ${version} is installed but this pi session loaded ${loaded}: restart pi to use it.`;
  const refused = (r.details as { code?: string } | undefined)?.code === 'version'
    || r.content.some(c => c.type === 'text' && c.text?.includes('is installed but this pi session loaded'));
  if (version === loaded && !refused) return r;
  if (!options.full && !refused && seen.has(version)) return r;
  seen.add(version);
  const content = r.content.slice();
  const last = content.findLastIndex(c => c.type === 'text');
  if (last >= 0 && content[last]!.text?.endsWith(line)) return r;
  if (last >= 0) content[last] = { ...content[last]!, text: `${content[last]!.text}\n${line}` };
  else content.push({ type: 'text', text: line });
  return { ...r, content };
}
// TB: project tool details and clip text in the worker, never reducer state across RPC.
export const TOOL_CONTENT_BYTES = 48 * 1024;
export const TOOL_DETAILS_BYTES = 8 * 1024;
const LIST_SHOWN = 5;
/** UTF-8 head without allocating a byte buffer of the complete result or splitting a surrogate pair. */
export function utf8Head(text: string, bytes: number): string {
  if (Buffer.byteLength(text) <= bytes) return text;
  let lo = 0, hi = Math.min(text.length, bytes);
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (Buffer.byteLength(text.slice(0, mid)) <= bytes) lo = mid; else hi = mid - 1;
  }
  if (lo && /[\uD800-\uDBFF]/.test(text[lo - 1]!) && /[\uDC00-\uDFFF]/.test(text[lo] ?? '')) lo--;
  return text.slice(0, lo);
}
type Summary = Record<string, any>;
const object = (v: unknown): Summary => v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Summary : {};
const scalar = (v: unknown): unknown => typeof v === 'string' ? utf8Head(v, 512) : typeof v === 'number' || typeof v === 'boolean' || v === null ? v : undefined;
/** Only action metadata; no entry bodies, run strings, plan objects, diffs or reducer dictionaries. */
const META = 'kind name complete branch worktree repo alreadyRunning fromDsa foreign idleSince noExitRecord noOutput do from on class merge prior seq ts by channel node subject phase command outcome id obligation key verdict rank ack_rulings needs attempt commit tree base carry plan submit resume decision writer prospective expect after release hold accepted status mark discharger reason code request rid qid rev state role pid session since started running reused exited stopped initialized updated measuring observed total pending entries head error lease durationMs log logPath receipt side expect ok tests pass fail skipped cancelled todo format bytes sha256 digest path file agent cwd isolation merged changed commits ahead behind relation tracked_by snapshotMismatch incompleteBatch allowance alreadyRecorded'.split(' ');
function metadata(value: unknown): Summary {
  const v = object(value), out: Summary = {};
  for (const k of META) {
    const x = scalar(v[k]); if (x !== undefined) out[k] = x;
  }
  if (v.facts) {
    const f = object(v.facts);
    out.facts = select(f, ['commit', 'tree', 'base']);
    if (Array.isArray(f.changed)) out.facts.changedCount = f.changed.length;
  }
  if (v.counts) out.counts = select(object(v.counts), ['tests', 'pass', 'fail', 'skipped', 'cancelled', 'todo', 'format']);
  if (Array.isArray(v.nodes)) list(out, 'nodes', v.nodes);
  if (Array.isArray(v.evidence)) list(out, 'evidence', v.evidence);
  return out;
}
function select(v: Summary, fields: readonly string[]): Summary {
  const out: Summary = {};
  for (const k of fields) { const x = scalar(v[k]); if (x !== undefined) out[k] = x; }
  return out;
}
function list(out: Summary, key: string, values: unknown[], shown = LIST_SHOWN, sampleBytes?: number): void {
  const samples = values.slice(0, shown).map(v => scalar(v) ?? metadata(v));
  if (sampleBytes !== undefined) while (samples.length && Buffer.byteLength(JSON.stringify(samples)) > sampleBytes) samples.pop();
  out[`${key}Count`] = values.length;
  out[key] = samples;
  if (values.length > samples.length) out[`${key}Omitted`] = values.length - samples.length;
}
// Each registered tool has an explicit acting surface. Nested objects are metadata, not recursive clones.
const TOOL_FIELDS: Record<string, string[]> = {
  stage: ['kind','seq','node','bundle','class','summary','read_through_seq','touches'],
  stages: ['stages'],
  accept: ['id','entry','ruling','plan','appends','alreadyAccepted','accepted'],
  reject: ['kind','seq','stage','note'],
  overturn: ['kind','seq','act','note'],
  status: ['stages','stageCounts','aActs','disabledAActs','trunk', 'ready', 'mergeQueue', 'mergeBatch', 'genesis', 'housekeeping', 'drift', 'trunkWorktree', 'runtimeWarnings'],
  why: ['node', 'phase', 'accepted', 'held', 'reported', 'later', 'items', 'blocks', 'mergeChecks', 'untested', 'measuring', 'mergeWaiting', 'carried', 'halt', 'waiting', 'tryReceipts'],
  report: ['since', 'reviews', 'merges', 'blocks', 'waivers', 'decisions', 'changes', 'adoptions', 'halts', 'receipts', 'superseded', 'trackedDebt', 'quarantine'],
  brief: ['since', 'now', 'decisions', 'merges', 'rejected', 'blocked', 'inProgress', 'totals'],
  verify: ['ok', 'entries', 'head', 'error', 'code', 'cacheMismatch', 'snapshotMismatch', 'incompleteBatch'],
  dispatch: ['node', 'attempt', 'worktree', 'branch', 'entry', 'subagents'],
  rebase: ['node', 'attempt', 'worktree', 'branch', 'entry'],
  check_try: ['node', 'check', 'invariant', 'plan', 'results'],
  attest: ['node', 'accepted', 'lease', 'observations', 'superseded', 'remeasured', 'changed', 'failed', 'missing', 'refresh'],
  merge: ['node', 'commit', 'tree', 'entry', 'lease', 'deferred', 'unguarded'],
  gc: ['dryRun', 'entry', 'removed', 'kept', 'trees', 'treesKept', 'planCache'],
  decide: ['decision', 'nodes', 'rule', 'plan', 'added', 'allow_only', 'deferred', 'answered', 'answers', 'resumed', 'deliveryFailures', 'remeasure', 'warnings'],
  answer: ['entry', 'request', 'delivery', 'answers', 'rulingDelivery'],
  plan: ['kind', 'seq', 'ts', 'by', 'channel', 'plan', 'path', 'rev', 'warning', 'warnings', 'notes', 'ready', 'driver'],
  edit: ['file', 'path', 'planSha', 'downgrades', 'warnings', 'notes', 'rule', 'resume', 'resumes'],
  amend: ['node', 'file', 'path', 'added', 'present', 'covered', 'plan', 'rule', 'warnings'],
  init: ['entry', 'genesis', 'measuring', 'warnings'],
  sweep: ['entry', 'lease', 'notDue', 'reason', 'skipped', 'bisect', 'escape'],
  start: ['initialized', 'updated', 'plan', 'warnings', 'driver'],
  drive: ['running', 'pid', 'session', 'started', 'reused', 'exited', 'stopped', 'state', 'alreadyRunning', 'foreign', 'idleSince', 'exit', 'noExitRecord', 'noOutput', 'repo', 'measuring', 'lines', 'error', 'log'],
};
const ENTRY_TOOLS = new Set(['submit', 'review', 'approve', 'evidence', 'abandon', 'resume', 'rule', 'waive', 'defer', 'escape', 'adopt', 'decoy']);
/** TB2: deliberate per-tool summary with hard serialized budget and count-bearing short lists. */
export function compactToolDetails(name: string, value: unknown): Summary {
  const v = object(value), tool = name.replace(/^owed_/, '');
  if (typeof v.code === 'string' && typeof v.reason === 'string') return select(v, ['code', 'reason']);
  const out: Summary = {};
  const fields = TOOL_FIELDS[tool] ?? (ENTRY_TOOLS.has(tool) ? [...META, 'entry', 'delivery', 'items', 'entries', 'meaning'] : []);
  for (const k of fields) {
    if (v[k] === undefined || (ENTRY_TOOLS.has(tool) && k === 'nodes')) continue;
    // Plan guidance is acting information: retain ordinary warning sets, not just
    // the first five reads notices. Oversized sets still have bounded samples/counts.
    if (Array.isArray(v[k])) list(out, k, v[k], k === 'warnings' ? 32 : LIST_SHOWN, k === 'warnings' ? 3072 : undefined);
    else if (tool === 'waive' && k === 'meaning' && typeof v[k] === 'string') {
      // A formatted waiver-scope summary is not the original ledger reason/body.
      out.meaning = utf8Head(v[k], 2048);
      const omitted = Buffer.byteLength(v[k]) - Buffer.byteLength(out.meaning);
      if (omitted) out.meaningOmittedBytes = omitted;
    }
    else { const x = scalar(v[k]); out[k] = x === undefined ? metadata(v[k]) : x; }
  }
  if (ENTRY_TOOLS.has(tool) && v.nodes !== undefined) {
    if (Array.isArray(v.nodes)) list(out, 'nodes', v.nodes); else if (v.nodes === '*') out.nodes = '*';
  }
  if (tool === 'status') {
    out.nodeCount = Object.keys(object(v.nodes)).length;
    const s = object(v.summary), summary = select(s, ['merged']);
    for (const k of ['needs', 'progress', 'debt']) if (Array.isArray(s[k])) list(summary, k, s[k]);
    out.summary = summary;
    out.groupCounts = Object.fromEntries(Object.entries(object(v.groups)).map(([k, a]) => [utf8Head(k, 128), Array.isArray(a) ? a.length : 0]));
  }
  if (tool === 'edit' && !('text' in v) && v.plan) out.plan = metadata(v.plan);
  if ((tool === 'plan' || tool === 'edit' || tool === 'amend') && Array.isArray(v.carried)) {
    out.carriedCount = v.carried.length; // Carried submit arrays never leave the worker, even small ones.
    out.carriedSummary = v.carried.slice(0, LIST_SHOWN).map(metadata);
    if (v.carried.length > LIST_SHOWN) out.carriedSummaryOmitted = v.carried.length - LIST_SHOWN;
  }
  if (Array.isArray(v.notCarried)) list(out, 'notCarried', v.notCarried);
  if (tool === 'brief') out.totals = select(object(v.totals), Object.keys(object(v.totals)));
  if ((tool === 'status' || tool === 'init') && v.genesis) {
    out.genesis = metadata(v.genesis);
    for (const k of ['pending', 'recorded', 'failed', 'missing', 'superseded']) if (Array.isArray(v.genesis[k])) list(out.genesis, k, v.genesis[k]);
  }
  if (tool === 'dispatch') out.subagents = select(object(v.subagents), ['agent', 'cwd', 'isolation']);
  if (v.delivery) out.delivery = deliverySummary(v.delivery);
  if (v.rulingDelivery) out.rulingDelivery = deliverySummary(v.rulingDelivery);
  // Budget the projected object only. Original data is never stringified or cloned.
  const bounded: Summary = {};
  for (const [k, x] of Object.entries(out)) {
    if (k.endsWith('Omitted') && k in bounded) continue;
    bounded[k] = x;
    if (Buffer.byteLength(JSON.stringify(bounded)) <= TOOL_DETAILS_BYTES - 1024) continue;
    delete bounded[k];
    if (Array.isArray(x)) {
      bounded[k] = [];
      bounded[`${k}Omitted`] = out[`${k}Count`] ?? x.length;
    } else {
      bounded.omittedFieldCount = (bounded.omittedFieldCount ?? 0) + 1;
      if ((bounded.omittedFields?.length ?? 0) < LIST_SHOWN) (bounded.omittedFields ??= []).push(k);
    }
  }
  return bounded;
}
function deliverySummary(value: unknown): Summary {
  const v = object(value), out = metadata(v);
  for (const k of ['delivered', 'failures', 'finished', 'slots']) if (Array.isArray(v[k])) list(out, k, v[k]);
  return out;
}
/** POSIX argv quoting, including embedded quotes and control characters without extra footer lines. */
const shellWord = (value: unknown): string => {
  const s = String(value);
  return /^[A-Za-z0-9_./:@,+-]+$/.test(s) ? s : `'${s.replaceAll("'", "'\\''")}'`;
};
function receiptPointer(name: string, args: Summary, data: Summary): string {
  const tool = name.replace(/^owed_/, '');
  const id = args.node;
  const node = typeof id === 'string' && Buffer.byteLength(id) <= 256 && !/[\r\n\x00]/.test(id) ? id : undefined;
  const receipt = node ? `owed why ${shellWord(node)} --full` : 'owed status --full';
  if (tool === 'stages') return 'owed stages --all --json';
  if (['stage','accept','reject'].includes(tool)) return 'owed stages --all --json';
  if (tool === 'status') return 'owed status --full';
  if (tool === 'why') return node ? receipt : '';
  if (tool === 'report' || tool === 'brief') return `owed ${tool}${args.since === undefined ? '' : ` --since ${shellWord(utf8Head(String(args.since), 128))}`}`;
  if (tool === 'gc' && args.dry_run) return 'owed gc --dry-run';
  if (tool === 'edit' && args.dry_run) {
    // Comma-containing literal IDs in a batch have no unambiguous CLI encoding.
    if (Array.isArray(args.nodes) && args.nodes.some((id: string) => id.includes(','))) return 'rerun with the owed CLI and --dry-run';
    const parts = ['owed', 'edit'];
    if (args.drive) parts.push('--drive'); else if (args.invariant) parts.push('--invariant', shellWord(args.invariant));
    else if (Array.isArray(args.nodes)) parts.push(shellWord(args.nodes.join(','))); else if (args.node) parts.push(shellWord(args.node));
    for (const [k, flag] of [['set', '--set'], ['unset', '--unset']] as const) for (const x of args[k] ?? []) parts.push(flag, shellWord(x));
    parts.push('--note', shellWord(args.note), '--dry-run');
    if (args.plan) parts.push('--plan', shellWord(args.plan));
    if (args.node_new) parts.push('--node-new');
    for (const k of ['rule', 'after', 'expect'] as const) if (args[k] !== undefined) parts.push(`--${k}`, shellWord(Array.isArray(args[k]) ? args[k].join(',') : args[k]));
    for (const k of ['writer', 'resume'] as const) if (args[k]) parts.push(`--${k}`);
    const command = parts.join(' ');
    return Buffer.byteLength(command) <= 800 && !/[\r\n\x00]/.test(command) ? command : 'rerun with the owed CLI and --dry-run';
  }
  const entry = tool === 'plan' ? data : object(data.plan ?? data.entry);
  const plan = entry.kind === 'plan' ? `plan #${entry.seq}${data.path || entry.path ? ` (${utf8Head(String(data.path ?? entry.path).replace(/[\r\n]/g, ' '), 256)})` : ''}; ` : '';
  const seqs = [data.seq, data.decision, object(data.entry).seq, object(data.rule).seq, object(data.resume).seq].filter(v => typeof v === 'number');
  return `${plan}${seqs.length ? `receipt #${[...new Set(seqs)].join(', #')}; ` : ''}${receipt}`;
}
export function boundToolResult<T extends { content: { type: string; text?: string }[]; details?: unknown }>(name: string, args: unknown, r: T): T {
  const details = compactToolDetails(name, r.details), text = r.content.filter(c => c.type === 'text').map(c => c.text ?? '').join('\n');
  // The dispatch packet is required, non-replayable worker input, not optional output.
  // Anchor the boundary to the original packet/argv, never to markers inside rulings.
  const data = object(r.details);
  if (name === 'owed_dispatch' && !(r as T & { isError?: boolean }).isError && typeof data.packet === 'string' && data.subagents) {
    const required = `${data.packet}\n\nsubagents: ${JSON.stringify({ ...data.subagents, task: '<the complete packet above>' })}\n`;
    if (text.startsWith(required)) {
      const brief = text.slice(required.length);
      if (Buffer.byteLength(brief) <= TOOL_CONTENT_BYTES) return { ...r, details };
      return { ...r, details, content: [{ type: 'text', text: required + clipToolText(brief, 'owed status') }] };
    }
  }
  if (Buffer.byteLength(text) <= TOOL_CONTENT_BYTES) return { ...r, details };
  const rawPointer = (r as T & { isError?: boolean }).isError
    ? (object(r.details).code === 'usage' && object(args).cwd ? '' : receiptPointer('owed_why', object(args), {}))
    : receiptPointer(name, object(args), object(r.details));
  const pointer = Buffer.byteLength(rawPointer) <= 800 ? rawPointer : 'owed status --full';
  return { ...r, details, content: [{ type: 'text', text: clipToolText(text, pointer) }] };
}
function clipToolText(text: string, pointer: string): string {
  // Retain the version notice even when the surrounding result was cut; the CLI footer stays last.
  const last = text.slice(text.lastIndexOf('\n') + 1);
  const notice = last.includes('is installed but this pi session loaded') ? last : '';
  const original = Buffer.byteLength(text), suffix = notice ? `\n${utf8Head(notice, 512)}` : '';
  const footer = (omitted: number) => `\n${omitted} bytes omitted${pointer ? `; full: ${pointer}` : ''}`;
  const head = utf8Head(notice ? text.slice(0, text.lastIndexOf('\n')) : text, TOOL_CONTENT_BYTES - Buffer.byteLength(suffix + footer(original)));
  return head + suffix + footer(original - Buffer.byteLength(head + suffix));
}

type Context = { cwd: string; hasUI: boolean; idle: boolean; sessionId?: string };
type Request = { id: number; method: string; args: unknown[] };
type Reply = { id: number; result?: unknown; error?: { code: string; message: string } };
type Callback = { callback: number; call: number; method: 'confirm' | 'dismiss' | 'notify' | 'message'; args: unknown[]; session: number; identity?: string };
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; ctx?: ExtensionContext; cleanup: () => void };

/** One eagerly started worker shared by all tools (and extension registrations) in this pi process. */
export class ToolWorker {
  worker?: Worker;
  private next = 0;
  private pending = new Map<number, Pending>();
  private dialogs = new Map<number, AbortController>();
  private sessions = new Map<number, { pi: ExtensionAPI; canDeliver: (identity?: string) => boolean }>();
  private ready?: Promise<unknown>;
  constructor() { this.start(); }
  private start(): void {
    if (installedVersion() !== loadedVersion) throw new OwedError(restartLine());
    const url = new URL(import.meta.url.endsWith('.ts') ? './ext-worker.ts' : './ext-worker.js', import.meta.url);
    const w = new Worker(url, { env: SHARE_ENV, workerData: { owed: true, version: loadedVersion }, execArgv: [] });
    this.worker = w;
    this.ready = new Promise((resolve, reject) => this.pending.set(0, { resolve, reject, cleanup() {} }));
    // Loading is eager; an idle worker must not keep a CLI/test process alive.
    this.ready.catch(() => undefined);
    w.on('message', (m: Reply | Callback) => {
      if ('callback' in m) { void this.callback(w, m).catch(() => undefined); return; }
      const p = this.pending.get(m.id); if (!p) return;
      this.pending.delete(m.id); p.cleanup();
      if (m.error) p.reject(new OwedError(m.error.message, m.error.code as OwedErrorCode)); else p.resolve(m.result);
      if (!this.pending.size) w.unref();
    });
    const failed = (text: string) => {
      if (this.worker !== w) return;
      this.worker = undefined;
      for (const p of this.pending.values()) { p.cleanup(); p.reject(new OwedError(`owed worker ${text}; retry the call`)); }
      this.pending.clear();
      for (const d of this.dialogs.values()) d.abort(); this.dialogs.clear();
    };
    w.on('error', e => failed(`crashed: ${e.message}`));
    w.on('exit', code => failed(`exited (${code})`));
    w.unref();
  }
  register(pi: ExtensionAPI, canDeliver: (identity?: string) => boolean = () => true): number { const id = ++this.next; this.sessions.set(id, { pi, canDeliver }); return id; }
  unregister(id: number): void { this.sessions.delete(id); }
  private async callback(w: Worker, m: Callback): Promise<void> {
    const ctx = this.pending.get(m.call)?.ctx;
    if (m.method === 'dismiss') { this.dialogs.get(m.callback)?.abort(); this.dialogs.delete(m.callback); return; }
    if (m.method === 'message') {
      const session = this.sessions.get(m.session);
      try {
        if (!session || (['owed-drive', 'owed-idle'].includes((m.args[0] as { customType: string }).customType) && !session.canDeliver(m.identity))) throw new Error('session busy or stopped');
        session.pi.sendMessage(...m.args as Parameters<ExtensionAPI['sendMessage']>);
        w.postMessage({ id: m.callback, method: 'answer', args: [true] });
      } catch { w.postMessage({ id: m.callback, method: 'answer', args: [false] }); }
      return;
    }
    if (m.method === 'notify') { ctx?.ui.notify(...m.args as Parameters<ExtensionContext['ui']['notify']>); return; }
    const ac = new AbortController(); this.dialogs.set(m.callback, ac);
    try {
      const [title, message, options] = m.args as [string, string, { timeout?: number }];
      const ok = ctx?.hasUI ? await ctx.ui.confirm(title, message, { ...options, signal: ac.signal }) : false;
      w.postMessage({ id: m.callback, method: 'answer', args: [ok === true] });
    } catch { w.postMessage({ id: m.callback, method: 'answer', args: [false] }); }
    finally { this.dialogs.delete(m.callback); }
  }
  async call(method: string, args: unknown[], ctx?: ExtensionContext, signal?: AbortSignal): Promise<any> {
    if (!this.worker) this.start();
    const w = this.worker!; w.ref(); await this.ready;
    // Do not retry an operation whose outcome was lost with the worker.
    if (w !== this.worker) throw new OwedError('owed worker exited; retry the call');
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const abort = () => w.postMessage({ id, method: 'abort', args: [] });
      this.pending.set(id, { resolve, reject, ctx, cleanup: () => signal?.removeEventListener('abort', abort) });
      signal?.addEventListener('abort', abort, { once: true });
      try {
        w.ref(); w.postMessage({ id, method, args });
        if (signal?.aborted) abort();
      } catch (e) {
        this.pending.get(id)?.cleanup(); this.pending.delete(id);
        if (!this.pending.size) w.unref();
        reject(e);
      }
    });
  }
}
// jiti uses moduleCache:false; registrations/reloads of the same installed version
// still share one native worker, rather than spawning a worker per module wrapper.
const sharedKey = Symbol.for('pi-owed.tool-worker');
const host = globalThis as typeof globalThis & { [sharedKey]?: { version: string; rpc: ToolWorker } };
export function toolWorker(): ToolWorker {
  const shared = host[sharedKey];
  if (shared && shared.version !== loadedVersion) throw new OwedError(`owed ${loadedVersion} is installed but this pi session loaded ${shared.version}: restart pi to use it.`);
  if (shared) return shared.rpc;
  const rpc = new ToolWorker(); host[sharedKey] = { version: loadedVersion, rpc }; return rpc;
}

/** FW2: retain the host session identity across the worker boundary, including older hosts without this API. */
function contextSession(ctx: ExtensionContext): string | undefined {
  try { return ctx.sessionManager?.getSessionId(); } catch { return undefined; }
}

/** Register schemas locally; execute tools, commands and watcher events in the worker. */
export function remoteAPI(pi: ExtensionAPI): ExtensionAPI {
  const rpc = toolWorker();
  let context: ExtensionContext | undefined, running = false, polling = false, stopped = false;
  const idle = (): boolean => { try { return !stopped && !running && (typeof context?.isIdle !== 'function' || context.isIdle()); } catch { return !stopped && !running; } };
  const session = rpc.register(pi, identity => idle() && !!identity && !!context && sessionIdentity({ sessionId: contextSession(context) }) === identity);
  const notices = new Set<string>();
  const registered = new Map<string, ToolDefinition>();
  /**
   * SF6: deferred owed tools are reachable only through a host tool_search that declares reachesTools; activate it as
   * the host's MCP extension does (ensureDiscoveryActive). Without exposure support or such an active tool_search, the
   * deferred tools are registered again as direct (which activates them). Nothing is ever removed from the active set.
   */
  const ensureReachable = (): void => {
    const deferred = [...registered.values()].filter(t => t.exposure === 'deferred');
    if (!deferred.length) return;
    let reachable = false;
    try {
      const tools = pi.getAllTools();
      if (tools.some(t => typeof t.exposure === 'string') && tools.some(t => t.name === 'tool_search' && (t as { reachesTools?: unknown }).reachesTools)) {
        const active = pi.getActiveTools();
        if (!active.includes('tool_search')) pi.setActiveTools([...active, 'tool_search']);
        reachable = pi.getActiveTools().includes('tool_search');
      }
    } catch { reachable = false; }
    if (reachable) return;
    for (const t of deferred) { const direct: ToolDefinition = { ...t, exposure: 'direct' }; registered.set(t.name, direct); pi.registerTool(direct); }
  };
  // CT1: restore direct registrations omitted by a resumed host without changing any other active tool.
  const ensureDirectActive = (): void => {
    try {
      if (typeof pi.getActiveTools !== 'function' || typeof pi.setActiveTools !== 'function') return;
      const active = pi.getActiveTools();
      const missing = [...registered.values()].filter(t => t.exposure === 'direct' && !active.includes(t.name)).map(t => t.name);
      if (missing.length) pi.setActiveTools([...active, ...missing]);
    } catch { /* A host without a bound tool registry is left alone. */ }
  };
  const plain = (ctx: ExtensionContext): Context => ({ cwd: ctx.cwd, hasUI: ctx.hasUI, idle: idle(), sessionId: contextSession(ctx) });
  const event = async (name: string, ctx: ExtensionContext) => rpc.call('event', [session, name, plain(ctx)], ctx);
  const timer = setInterval(() => {
    if (!context || polling || stopped) return;
    polling = true; void event('owed_tick', context).catch(() => undefined).finally(() => { polling = false; });
  }, 2000); timer.unref();
  return {
    ...pi,
    registerTool(t: ToolDefinition) {
      const local: ToolDefinition = { ...t, async execute(id, p, signal, _update, ctx) {
        context = ctx;
        try {
          const r = await rpc.call('tool', [session, t.name, id, p, plain(ctx), [...notices], { version: installedVersion(), loaded: loadedVersion }], ctx, signal);
          if (r.content.some((c: { text?: string }) => c.text?.includes(restartLine()))) notices.add(installedVersion());
          return r;
        }
        catch (e) {
          if (!(e instanceof Error) || e.name !== 'OwedError') throw e;
          const error = e as OwedError;
          return boundToolResult(t.name, p, versionNotice({ content: [{ type: 'text' as const, text: `Refused: ${error.message}` }], details: { code: error.code, reason: error.message }, isError: true }, {seen:notices}));
        }
      } };
      registered.set(t.name, local); pi.registerTool(local);
    },
    registerCommand(name, command) {
      pi.registerCommand(name, { ...command, async handler(args, ctx) {
        context = ctx;
        try { await rpc.call('command', [session, name, args, plain(ctx)], ctx); }
        catch (e) { ctx.ui.notify(e instanceof Error ? e.message : String(e), 'error'); }
      } });
    },
    on(name, _handler) {
      if ((name as string) === 'owed_tick' || typeof pi.on !== 'function') return () => undefined;
      return (pi.on as (name: string, handler: (_e: unknown, ctx: ExtensionContext) => Promise<void>) => () => void)(name, async (_e: unknown, ctx: ExtensionContext) => {
        context = ctx;
        if (name === 'session_start') {
          notices.clear();
          ensureReachable();
          ensureDirectActive();
        }
        if (name === 'agent_start') { running = true; ensureDirectActive(); }
        if (name === 'agent_settled') running = false;
        if (name === 'session_shutdown') { stopped = true; clearInterval(timer); }
        try { await event(name, ctx); } finally { if (stopped) rpc.unregister(session); }
      });
    },
  } as ExtensionAPI;
}

if (!isMainThread && workerData?.owed) void (async () => {
  const port = parentPort!;
  if (loadedVersion !== workerData.version) throw new OwedError(`owed ${loadedVersion} is installed but this pi session loaded ${workerData.version}: restart pi to use it.`);
  const { default: owed } = await import('./extension.ts');
  if (installedVersion() !== workerData.version) throw new OwedError(`owed ${installedVersion()} is installed but this pi session loaded ${workerData.version}: restart pi to use it.`);
  const sessions = new Map<number, { tools: Map<string, ToolDefinition>; commands: Map<string, any>; handlers: Map<string, any>; identity?: string }>();
  const calls = new Map<number, AbortController>(), answers = new Map<number, (answer: boolean) => void>();
  let callback = 0;
  function sessionOf(id: number) {
    let s = sessions.get(id); if (s) return s;
    s = { tools: new Map(), commands: new Map(), handlers: new Map() }; sessions.set(id, s);
    owed({ registerTool: (t: ToolDefinition) => s.tools.set(t.name, t), registerCommand: (n: string, c: unknown) => s.commands.set(n, c), on: (n: string, h: unknown) => s.handlers.set(n, h),
      sendMessage: (...args: unknown[]) => new Promise<void>((resolve, reject) => {
        const key = ++callback;
        answers.set(key, ok => ok ? resolve() : reject(new Error('pi did not accept the wake; retry after revalidation')));
        port.postMessage({ callback: key, call: 0, session: id, identity: s.identity, method: 'message', args });
      }),
    } as unknown as ExtensionAPI);
    return s;
  }
  port.on('message', (m: Request) => {
    if (m.method === 'abort') { calls.get(m.id)?.abort(); return; }
    if (m.method === 'answer') { answers.get(m.id)?.(m.args[0] === true); answers.delete(m.id); return; }
    const ac = new AbortController(); calls.set(m.id, ac);
    void (async () => {
      const [sid, name] = m.args as [number, string], s = sessionOf(sid);
      const value = m.args[m.method === 'tool' ? 4 : m.args.length - 1] as Context;
      s.identity = sessionIdentity(value);
      const ctx = { ...value, isIdle: () => value.idle, ui: {
        notify: (...args: unknown[]) => port.postMessage({ callback: ++callback, call: m.id, session: sid, method: 'notify', args }),
        confirm: (title: string, text: string, options: { timeout?: number; signal?: AbortSignal } = {}) => new Promise<boolean>(resolve => {
          const id = ++callback;
          const dismiss = () => { answers.delete(id); port.postMessage({ callback: id, call: m.id, session: sid, method: 'dismiss', args: [] }); resolve(false); };
          answers.set(id, answer => { options.signal?.removeEventListener('abort', dismiss); resolve(answer); });
          options.signal?.addEventListener('abort', dismiss, { once: true });
          port.postMessage({ callback: id, call: m.id, session: sid, method: 'confirm', args: [title, text, { timeout: options.timeout }] });
          if (options.signal?.aborted) dismiss();
        }),
      } } as unknown as ExtensionContext;
      if (m.method === 'tool') {
        let r;
        try { r = await s.tools.get(name)!.execute(m.args[2] as string, m.args[3], ac.signal, undefined, ctx as Parameters<ToolDefinition['execute']>[4]); }
        catch (e) {
          const code = e instanceof OwedError ? e.code : 'internal', reason = e instanceof Error ? e.message : String(e);
          r = { content: [{ type: 'text' as const, text: `Refused: ${reason}` }], details: { code, reason }, isError: true };
        }
        return boundToolResult(name, m.args[3], versionNotice(r, { ...object(m.args[6]), seen: new Set(m.args[5] as string[] | undefined), full: name === 'owed_status' && object(m.args[3]).full === true }));
      }
      if (m.method === 'command') return s.commands.get(name).handler(m.args[2], ctx);
      if (m.method === 'event') { await s.handlers.get(name)?.({}, ctx); if (name === 'session_shutdown') sessions.delete(sid); return; }
      throw new OwedError(`Unknown worker method ${m.method}`, 'usage');
    })().then(result => port.postMessage({ id: m.id, result }), (e: unknown) => port.postMessage({ id: m.id, error: { code: e instanceof OwedError ? e.code : 'internal', message: e instanceof Error ? e.message : String(e) } })).finally(() => calls.delete(m.id));
  });
  port.postMessage({ id: 0, result: true });
})().catch(e => { throw e; });
