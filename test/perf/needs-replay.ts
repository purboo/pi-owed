// RP / R-028-58/62: read-only, incremental comparison. No operation or driver action is executed.
import { createReadStream, existsSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync, renameSync, rmSync, openSync, readSync, closeSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createInterface } from 'node:readline';
import { resolve, join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { reduce, extendState, entriesOf } from '../../src/reducer.ts';
import { parsePlan } from '../../src/plan.ts';
import { validateArgv } from '../../src/cli.ts';
import { needs, repoNeeds, heldRuling, resumeCommand } from '../../src/needs.ts';
import { statusView, renderStatus, receipt, renderWhy } from '../../src/views.ts';
import { decide } from '../../src/drive.ts';
import type { Need } from '../../src/needs.ts';
import type { Entry, Plan, State } from '../../src/types.ts';

export interface SurfaceNode {
  node: string;
  status: string[];
  why: { headline: string; items: { obligation: string; line: string }[]; next?: string[] };
  notice: string[];
  notEmitted?: string;
  diagnostic?: boolean;
}
export interface Snapshot { nodes: SurfaceNode[]; unavailable: string[] }
export interface SampleTiming { seq: number; statusMs: number; decideMs: number; whyMs: number; auditMs: number }
export type Renderer = (state: State, now: number, timing?: SampleTiming) => Snapshot;
const elapsed = <T>(run: () => T, record: (ms: number) => void): T => {
  const start = performance.now(); try { return run(); } finally { record(performance.now() - start); }
};
export interface ReplayIo { log(text: string): void; error(text: string): void }
interface Finding { seq: number; node?: string; obligation?: string; surface?: string; command?: string; reason: string }
export interface Result {
  version: string; entries: number; samples: number; renderedSamples: number; nodes: number; normalizedLines: number;
  timing: { foldMs: number; planParseMs: number; planParses: number; jsonReads: number; oracleFoldMs: number; statusMs: number; decideMs: number; whyMs: number; auditMs: number; samples: SampleTiming[] };
  errors: { a: number; b: number; c: number };
  coverage: { uncovered: number; missingBlobs: number; notEmitted: number; unavailable: number; diagnostic: number };
  findings: Record<'a' | 'b' | 'c' | 'uncovered' | 'missingBlobs' | 'notEmitted' | 'unavailable' | 'diagnostic', Finding[]>;
  truncated: boolean;
  global: { missingBlobs: Finding[]; foldFailures: Finding[] };
  itemBranches: { i: number; ii: number; iii: number; iv: number };
  itemInfo: Finding[];
  /** 0.29 release gate: held halts (oracle heldRuling) at sampled seqs, and how many show `owed resume <node>`. */
  held?: { nodes: number; resumeShown: number; shown: Finding[] };
}
const DETAIL_LIMIT = 200;
function result(version: string): Result {
  return { version, entries: 0, samples: 0, renderedSamples: 0, nodes: 0, normalizedLines: 0,
    timing: { foldMs: 0, planParseMs: 0, planParses: 0, jsonReads: 0, oracleFoldMs: 0, statusMs: 0, decideMs: 0, whyMs: 0, auditMs: 0, samples: [] }, errors: { a: 0, b: 0, c: 0 },
    coverage: { uncovered: 0, missingBlobs: 0, notEmitted: 0, unavailable: 0, diagnostic: 0 },
    findings: { a: [], b: [], c: [], uncovered: [], missingBlobs: [], notEmitted: [], unavailable: [], diagnostic: [] }, truncated: false, global: { missingBlobs: [], foldFailures: [] }, itemBranches: { i: 0, ii: 0, iii: 0, iv: 0 }, itemInfo: [], held: { nodes: 0, resumeShown: 0, shown: [] } };
}
function add(r: Result, kind: keyof Result['findings'], f: Finding): void {
  if (kind === 'a' || kind === 'b' || kind === 'c') r.errors[kind]++;
  else r.coverage[kind]++;
  if (r.findings[kind].length < DETAIL_LIMIT) r.findings[kind].push(f); else r.truncated = true;
}
const message = (e: unknown): string => e instanceof Error ? e.message : String(e);

/** Shell words only, never a shell invocation. Includes shellQuote's ANSI-C newline quoting. */
export function commandWords(text: string): string[] {
  const words: string[] = []; let word = '', started = false, quote = '', ansi = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (!quote && c === '$' && text[i + 1] === "'") { quote = "'"; ansi = true; started = true; i++; continue; }
    if (c === '\\' && (quote !== "'" || ansi)) {
      const next = text[++i]; if (next === undefined) throw new Error('trailing shell escape');
      word += ansi ? ({ n: '\n', r: '\r', t: '\t' }[next] ?? next) : next; started = true; continue;
    }
    if (quote) { if (c === quote) { quote = ''; ansi = false; } else word += c; started = true; continue; }
    if (c === "'" || c === '"') { quote = c; started = true; continue; }
    if (/\s/.test(c)) { if (started) { words.push(word); word = ''; started = false; } }
    else { word += c; started = true; }
  }
  if (quote) throw new Error('unterminated shell quote');
  if (started) words.push(word);
  return words;
}
/** The final arrow is the resolving command; commands quoted inside need.text are evidence, not selection. */
function primary(line: string): string | undefined {
  const tail = line.slice(line.lastIndexOf(' → ') + 3).trim();
  return line.includes(' → ') && tail.startsWith('owed ') ? tail.replace(/; (?:\d+ outstanding|nothing outstanding)(?: \(accepted\))?$/, '') : undefined;
}
// Query the validator itself: missing arguments are a recognized act, Unknown command is not.
function diagnosticCommand(text: string): boolean {
  for (const match of text.matchAll(/\bowed\s+([a-z][a-z-]*)\b/g)) {
    try { validateArgv([match[1]!]); return true; }
    catch (e) { if (!message(e).startsWith('Unknown command ')) return true; }
  }
  return false;
}
function argvParts(command: string) {
  const words = commandWords(command); if (words.shift() !== 'owed') throw new Error('command must start with owed');
  const positional: string[] = [], flags = new Map<string, string>();
  const valued = new Set(['as', 'candidate', 'reason', 'text', 'note', 'rank', 'ack-rulings', 'accept-risk', 'obligation', 'file', 'nodes', 'after', 'tracked-by', 'rid', 'qid', 'rev', 'defer']);
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w === '--') { positional.push(...words.slice(i + 1)); break; }
    if (!w.startsWith('--')) { positional.push(w); continue; }
    const [key, ...rest] = w.slice(2).split('=');
    flags.set(key!, rest.length ? rest.join('=') : valued.has(key!) ? words[++i] ?? '' : 'true');
  }
  return { words, positional, flags };
}
/** NE-CLI covers argv shape. N2/C4 checks required act flags and state-known risk/pin facts separately. */
function commandErrors(command: string, n: Need | undefined, state: State): { b: string[]; c: string[] } {
  const b: string[] = [], c: string[] = [];
  try {
    const { words, positional: p, flags: f } = argvParts(command);
    try { validateArgv(words); } catch (e) { b.push(message(e)); }
    const act = p[0], node = p[1];
    const require = (...keys: string[]) => { for (const key of keys) if (!f.get(key)?.trim()) b.push(`missing --${key}`); };
    if (act === 'waive' || act === 'defer') require('reason', 'as');
    if (act === 'decide') require('text');
    if (act === 'rule') require('nodes');
    if (act === 'review') { require('rank', 'note', 'ack-rulings', 'as'); if (!f.has('ok') && !f.has('block')) b.push('missing --ok/--block'); }
    if (act === 'approve') require('note', 'as');
    if (act === 'evidence') require('file', 'note', 'as');
    if (n) {
      if (node !== n.node && !(act === 'rule' && f.get('nodes')?.split(',').includes(n.node))) b.push(`wrong node: ${node ?? '(absent)'}; need ${n.node}`);
      if (['waive', 'review', 'approve', 'evidence'].includes(act ?? '') && n.candidate) {
        require('candidate'); if (f.has('candidate') && f.get('candidate') !== n.candidate) b.push('candidate pin differs from need');
      }
      if (act === 'waive') {
        const risks = state.nodes[n.node]?.blocks.filter(x => x.obligation === n.obligation && (x.state === 'active' || x.state === 'flaky')) ?? [];
        const cited = f.get('accept-risk')?.split(',').map(Number) ?? [];
        if (risks.some(x => !cited.includes(x.seq))) b.push('missing --accept-risk for counting blocks');
      }
      let obligations: string[] | undefined;
      if (act === 'waive') obligations = [p[2]!];
      if (act === 'evidence') obligations = [`evidence:${p[2]}`];
      if (act === 'review') obligations = [f.get('obligation') ?? 'review'];
      if (act === 'approve') obligations = ['approve'];
      if (act === 'defer') obligations = p.slice(2).map(x => x.startsWith('inv:') ? x : `inv:${x}`);
      if (act === 'decide' && f.has('defer')) obligations = [`inv:${f.get('defer')!.replace(/^inv:/, '')}`];
      if (n.obligation && obligations && (obligations.length !== 1 || obligations[0] !== n.obligation)) c.push(`command obligation ${obligations.join(',')} differs from need ${n.obligation}`);
      if (n.halted && ['no-resume', 'prospective'].some(k => f.has(k))) b.push('command does not clear the halt');
    }
  } catch (e) { b.push(message(e)); }
  return { b, c };
}

/** Only Needs-you lines; the progress section also contains indented node prefixes. */
function statusLines(text: string, node: string): string[] {
  const lines = text.split('\n'), start = lines.findIndex(l => /^Needs you \(\d+\):$/.test(l));
  if (start < 0) return [];
  const section: string[] = [];
  for (const line of lines.slice(start + 1)) { if (!line.startsWith('  ')) break; if (line.startsWith(`  ${node}: `)) section.push(line); }
  return section;
}
/** Actual public renderers and actual planning output, with no synthetic runs or simulated halt append. */
export const renderCurrent: Renderer = (state, now, timing) => {
  // statusView never mutates this history; avoid a full history copy at every sample (R-028-65).
  const history = entriesOf(state) as Entry[], rt = { driverRunning: true }, max = state.plan.drive?.max ?? 1;
  const status = elapsed(() => renderStatus(statusView(state, history, [], now, true)), ms => { if (timing) timing.statusMs += ms; });
  const actions = elapsed(() => decide(state, state.plan, new Map(), { runtime: rt, now, max, repairs: state.plan.drive?.repairs ?? 2,
    project: history[0]?.hash.slice(0, 12) ?? '', root: '.', applied: new Set(), rejected: new Map() }), ms => { if (timing) timing.decideMs += ms; });
  return { unavailable: [], nodes: Object.values(state.nodes).filter(n => !n.merged).map(n => {
    const card = elapsed(() => receipt(state, history, n.id, [], max, rt), ms => { if (timing) timing.whyMs += ms; });
    const why = elapsed(() => renderWhy(card), ms => { if (timing) timing.whyMs += ms; }), lines = why.split('\n');
    const notice = actions.filter(a => a.do === 'notify' && a.node === n.id && !a.scope && !a.quiet);
    const chosen = actions.find(a => a.node === n.id);
    return { node: n.id, status: statusLines(status, n.id),
      why: { headline: lines[0] ?? '', items: n.items.filter(i => i.status === 'D').map(i => ({ obligation: i.obligation,
        line: lines.find(l => l.startsWith(`${i.mark} ${i.obligation}: `)) ?? '' })), next: lines.filter(l => l.startsWith('Next: ')) },
      notice: notice.flatMap(a => a.do === 'notify' ? a.text.split('\n') : []),
      ...(notice.some(a => 'need' in a && a.need === null) ? { diagnostic: true } : {}),
      ...(!notice.length ? { notEmitted: card.halt ? 'halted' : chosen ? `planning action ${chosen.do}` : 'no notify with empty runs (or no owner route)' } : {}) };
  }) };
};

/** The adapter reads exports only. It does not rewrite/fork old source to expose private surfaces. */
export async function adapter0272(src: string): Promise<{ render: Renderer; reduce: typeof reduce; extend: typeof extendState; parse: typeof parsePlan }> {
  const load = (file: string) => import(pathToFileURL(join(resolve(src), file)).href);
  const [v, r, p] = await Promise.all([load('views.ts'), load('reducer.ts'), load('plan.ts')]);
  const unavailable = ['itemNext', 'ownerNotify'];
  return { reduce: r.reduce, extend: r.extendState, parse: p.parsePlan, render: (state, now, timing) => {
    const history = r.entriesOf(state) as Entry[];
    const status = elapsed(() => v.renderStatus(v.statusView(state, history, [], now, true)) as string, ms => { if (timing) timing.statusMs += ms; });
    return { unavailable, nodes: Object.values(state.nodes).filter(n => !n.merged).map(n => {
      const lines = elapsed(() => v.renderWhy(v.receipt(state, history, n.id)) as string, ms => { if (timing) timing.whyMs += ms; }).split('\n');
      return { node: n.id, status: statusLines(status, n.id), notice: [],
        why: { headline: lines[0] ?? '', items: n.items.filter(i => i.status === 'D').map(i => ({ obligation: i.obligation,
          line: lines.find(l => l.startsWith(`${i.mark} ${i.obligation}: `)) ?? '' })), next: lines.filter(l => l.startsWith('Next: ')) } };
    }) };
  } };
}

const DRIVER_SUFFIX = ' (skip this when owed drive is running: the driver attests)';
/** R-028-65: remove this one exact display suffix, identically for both versions. */
function normalizedSnapshot(snap: Snapshot, r: Result): Snapshot {
  const line = (s: string): string => {
    if (!s.endsWith(DRIVER_SUFFIX)) return s;
    r.normalizedLines++; return s.slice(0, -DRIVER_SUFFIX.length);
  };
  return { ...snap, nodes: snap.nodes.map(n => ({ ...n, status: n.status.map(line), notice: n.notice.map(line),
    why: { headline: line(n.why.headline), items: n.why.items.map(i => ({ ...i, line: line(i.line) })), next: n.why.next?.map(line) } })) };
}
function audit(r: Result, state: State, seq: number, raw: Snapshot): void {
  const snap = normalizedSnapshot(raw, r);
  r.samples++; r.nodes += snap.nodes.length;
  for (const surface of snap.unavailable) add(r, 'unavailable', { seq, surface, reason: 'private in 0.27.2; no private source adapter' });
  if (!snap.nodes.length && Object.values(state.nodes).some(n => !n.merged)) add(r, 'uncovered', { seq, reason: 'empty surface output for unmerged nodes' });
  const rt = { driverRunning: true };
  for (const node of Object.values(state.nodes).filter(n => !n.merged)) {
    // Current needs are the comparison oracle for BOTH versions, not reconstructed baseline command policy.
    const ns = needs(state, node.id, rt), shown = snap.nodes.find(n => n.node === node.id);
    for (const i of node.items.filter(i => i.status === 'D' && (i.discharger === 'owner' || i.discharger === 'parent'))) {
      if (!ns.some(n => n.obligation === i.obligation)) add(r, 'uncovered', { seq, node: node.id, obligation: i.obligation, reason: 'parent/owner obligation without a need (including intentionally suppressed baseline membership)' });
    }
    for (const n of ns) if (!n.command) add(r, 'uncovered', { seq, node: node.id, obligation: n.obligation, reason: 'need without a single command' });
    if (!shown) { if (snap.nodes.length) add(r, 'uncovered', { seq, node: node.id, reason: 'node absent from surface output' }); continue; }
    if (shown.diagnostic) {
      add(r, 'diagnostic', { seq, node: node.id, surface: 'owner notice', reason: 'diagnostic notify (need:null)' });
      if (diagnosticCommand(shown.notice.join('\n'))) add(r, 'a', { seq, node: node.id, reason: 'diagnostic notify has a command unsupported by a need' });
      if (ns.some(n => n.actor === 'owner' || n.obligation !== undefined && n.kind !== 'rule')) add(r, 'a', { seq, node: node.id, reason: 'diagnostic notify misses an owner need' });
    }
    if (shown.notEmitted) add(r, 'notEmitted', { seq, node: node.id, surface: 'owner notice', reason: shown.notEmitted });
    const heldBy = heldRuling(state, node.id);
    if (heldBy && r.held) {
      r.held.nodes++;
      const rows = [...shown.status, shown.why.headline, ...(shown.why.next ?? [])];
      if (rows.some(line => primary(line) === resumeCommand(node.id))) {
        r.held.resumeShown++;
        if (r.held.shown.length < DETAIL_LIMIT) r.held.shown.push({ seq, node: node.id, reason: `held by ruling #${heldBy.seq}; resume shown` }); else r.truncated = true;
      }
    }
    const primaryNeed = ns[0];
    const expected = (surface: string, line: string | undefined, n: Need | undefined, command = n?.command) => {
      if (!line?.trim()) add(r, 'uncovered', { seq, node: node.id, surface, obligation: n?.obligation, reason: 'missing output for a need' });
      else if (primary(line) !== command) add(r, 'a', { seq, node: node.id, surface, obligation: n?.obligation,
        reason: 'primary command differs between rendered surface and need', command: JSON.stringify({ need: command ?? null, rendered: primary(line) ?? null }) });
    };
    // summaryView/summaryHead and drive.needLines map every need, preserving within-node order.
    // Multiset matching: reserve exact identities globally before any text/index fallback.
    // Identical needs still require distinct rows; a consumed row cannot satisfy another need.
    const needRows = (surface: string, rows: string[], list: Need[]) => {
      const bodies = rows.map(line => line.replace(surface === 'compact why next' ? /^Next: / : new RegExp(`^\\s*${node.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}: `), ''));
      const used = new Set<number>(), matched = new Map<number, number>();
      const reserve = (needIndex: number, rowIndex: number) => { used.add(rowIndex); matched.set(needIndex, rowIndex); };
      const identity = (body: string, n: Need) => body === n.text || body.startsWith(`${n.text} → `) || body === `${n.text} (no single command)`;
      list.forEach((n, i) => {
        const text = `${n.text}${n.command ? ` → ${n.command}` : ' (no single command)'}`;
        const row = bodies.findIndex((body, j) => !used.has(j) && body === text);
        if (row >= 0) reserve(i, row);
      });
      list.forEach((n, i) => {
        if (matched.has(i)) return;
        const row = bodies.findIndex((body, j) => !used.has(j) && identity(body, n));
        if (row >= 0) reserve(i, row);
      });
      list.forEach((n, i) => {
        if (!matched.has(i) && rows.length === list.length) {
          const remaining = rows.map((_, j) => j).filter(j => !used.has(j));
          const row = remaining.find(j => !list.some((other, k) => k !== i && identity(bodies[j] ?? '', other)));
          if (row !== undefined) reserve(i, row);
        }
        const row = matched.get(i);
        expected(surface, row === undefined ? undefined : rows[row], n);
      });
      return new Map([...matched].map(([i, row]) => [row, list[i]!]));
    };
    const statusNeeds = needRows('status', shown.status, ns);
    if (primaryNeed) expected('compact why headline', shown.why.headline, primaryNeed);
    // R-028-71: use Need + public text forms, never a renderer's own itemLine as its oracle.
    for (const i of node.items.filter(i => i.status === 'D')) {
      const n = ns.find(n => n.obligation === i.obligation), line = shown.why.items.find(row => row.obligation === i.obligation)?.line;
      const finding = { seq, node: node.id, surface: 'compact why item', obligation: i.obligation };
      if (!line?.trim()) { add(r, 'uncovered', { ...finding, reason: 'missing output for a need' }); continue; }
      if (!n) continue; // No Need: existence here, argv and obligation audit below.
      const prefix = `${i.mark} ${i.obligation}: `, body = line.startsWith(prefix) ? line.slice(prefix.length) : line;
      const command = primary(line);
      if (body.startsWith(`${n.text} → `)) {
        r.itemBranches.i++; expected('compact why item', line, n);
      } else if (command !== undefined) {
        if (command !== n.command) { r.itemBranches.iv++; add(r, 'a', { ...finding, command, reason: 'contextual item has a different need command' }); }
      } else {
        const sameText = body === n.text && n.command !== undefined;
        if (sameText) r.itemBranches.ii++; else r.itemBranches.iii++;
        if (r.itemInfo.length < DETAIL_LIMIT) r.itemInfo.push({ ...finding, reason: sameText ? 'item shows need text without command' : 'contextual item (no need command)' });
        else r.truncated = true;
      }
    }
    const nextNeeds = needRows('compact why next', shown.why.next ?? [], ns.slice(1));
    const noticeNeeds = !shown.diagnostic && !shown.notEmitted && !snap.unavailable.includes('ownerNotify')
      ? needRows('owner notice', shown.notice, ns) : new Map<number, Need>();
    const check = (command: string, need: Need | undefined, surface: string, obligation?: string) => {
      const errors = commandErrors(command, need, state);
      for (const kind of ['b', 'c'] as const) for (const reason of errors[kind]) add(r, kind, { seq, node: node.id, obligation, surface, command, reason });
    };
    for (const n of ns) for (const command of [n.command, ...(n.alternatives ?? [])]) if (command) check(command, n, 'needs', n.obligation);
    for (const [surface, lines, matches] of [['status', shown.status, statusNeeds], ['owner notice', shown.notice, noticeNeeds]] as const) lines.forEach((line, index) => {
      const command = primary(line), n = matches.get(index); if (command) check(command, n, surface, n?.obligation);
    });
    const head = primary(shown.why.headline); if (head) check(head, primaryNeed, 'compact why headline', primaryNeed?.obligation);
    (shown.why.next ?? []).forEach((line, index) => {
      const command = primary(line), n = nextNeeds.get(index); if (command) check(command, n, 'compact why next', n?.obligation);
    });
    for (const i of shown.why.items) {
      const command = primary(i.line), need = ns.find(n => n.obligation === i.obligation);
      if (command) check(command, need ?? { node: node.id, kind: 'investigate', actor: 'parent', since: null, text: '', obligation: i.obligation }, 'compact why item', i.obligation);
    }
  }
  for (const n of repoNeeds(state, rt)) if (!n.command) add(r, 'uncovered', { seq, node: 'trunk', obligation: n.obligation, reason: 'repository need without a single command' });
}

/** Lazy LRU, bounded by entries AND source bytes; large historical plans cannot fill an unbounded cache. */
function planLookup(blobs: string, parse: typeof parsePlan, r: Result, dir: string) {
  mkdirSync(dir, { recursive: true });
  const MAX_PLANS = 64, MAX_SOURCE_BYTES = 16 * 1024 * 1024;
  const cache = new Map<string, { plan: Plan; bytes: number }>(); let bytes = 0;
  const freeze = (x: unknown): void => { if (x && typeof x === 'object' && !Object.isFrozen(x)) { Object.freeze(x); Object.values(x).forEach(freeze); } };
  return (sha: string): Plan => {
    let row = cache.get(sha);
    if (!row) {
      const file = join(dir, `${r.version}-${sha}.json`);
      let plan: Plan | undefined, sourceBytes = 0;
      try {
        const stored = JSON.parse(readFileSync(file, 'utf8')) as { engine: string; sha: string; bytes: number; digest: string; plan: Plan };
        if (stored.engine === r.version && stored.sha === sha && Number.isSafeInteger(stored.bytes) && stored.bytes > 0
          && stored.digest === digest(JSON.stringify(stored.plan)) && stored.plan?.version === 1 && Array.isArray(stored.plan.nodes)) {
          plan = stored.plan; sourceBytes = stored.bytes; r.timing.jsonReads++;
        }
      } catch { /* Missing, corrupt or partial JSON falls back to the actual historical YAML blob. */ }
      if (!plan) {
        const text = readFileSync(join(blobs, sha), 'utf8'); sourceBytes = Buffer.byteLength(text);
        plan = elapsed(() => parse(text), ms => { r.timing.planParseMs += ms; r.timing.planParses++; });
        const tmp = `${file}.${process.pid}.tmp`;
        try {
          writeFileSync(tmp, JSON.stringify({ engine: r.version, sha, bytes: sourceBytes, digest: digest(JSON.stringify(plan)), plan }));
          renameSync(tmp, file);
        } finally { rmSync(tmp, { force: true }); }
      }
      freeze(plan); row = { plan, bytes: sourceBytes }; bytes += row.bytes;
    }
    cache.delete(sha); cache.set(sha, row);
    while (cache.size > MAX_PLANS || bytes > MAX_SOURCE_BYTES) {
      const oldest = cache.keys().next().value!; bytes -= cache.get(oldest)!.bytes; cache.delete(oldest);
    }
    return row.plan;
  };
}
function blobRefs(e: Entry): string[] {
  if (e.kind === 'genesis' || e.kind === 'plan') return [e.plan];
  if (e.kind === 'dispatch') return [e.packet];
  if (e.kind === 'launch') return [e.spec];
  if (e.kind === 'send') return [e.message];
  if (e.kind === 'obs' || e.kind === 'sweep') return e.log ? [e.log] : [];
  // EvidenceFile.sha256 is a file digest, not an owed blob address.
  return [];
}
const digest = (text: string): string => createHash('sha256').update(text).digest('hex');
function blobDigest(file: string): string {
  const fd = openSync(file, 'r'), hash = createHash('sha256'), chunk = Buffer.allocUnsafe(64 * 1024);
  try { let n: number; while ((n = readSync(fd, chunk, 0, chunk.length, null)) > 0) hash.update(chunk.subarray(0, n)); }
  finally { closeSync(fd); }
  return hash.digest('hex');
}
interface Options { ledger: string; blobs: string; every: number; seqs: Set<number>; halts: boolean; baseline?: string; json: boolean; engine: '0.28' | '0.27.2' | 'both'; cache?: string; shard?: { index: number; total: number } }
interface ReplayReport {
  assumptions: Record<string, unknown>; wallMs: number; results: Result[];
  partition: { ledger: string; lastSeq: number; blobs: string; replayFailures: { engine: string; failures: Finding[] }[]; every: number; seqs: number[]; halts: boolean; index: number; total: number };
}
/** No partial acceptance: every shard of one exact input/configuration must be present exactly once. */
function mergeReports(files: string[]): ReplayReport {
  if (!files.length) throw new Error('--merge requires report files');
  const reports = files.map(file => JSON.parse(readFileSync(file, 'utf8')) as ReplayReport), first = reports[0]!;
  const key = (r: ReplayReport) => JSON.stringify({ ...r.partition, index: 0, engines: r.results.map(x => x.version), global: r.results.map(x => x.global), assumptions: r.assumptions });
  if (!first.partition || !Number.isSafeInteger(first.partition.total) || first.partition.total < 1) throw new Error('invalid shard metadata');
  const seen = new Set<number>();
  for (const r of reports) {
    if (!r.partition || key(r) !== key(first)) throw new Error('incompatible shard reports');
    const i = r.partition.index;
    if (!Number.isSafeInteger(i) || i < 0 || i >= first.partition.total || seen.has(i)) throw new Error('duplicate or invalid shard');
    seen.add(i);
  }
  if (seen.size !== first.partition.total) throw new Error('missing shard reports');
  const results = first.results.map((source, index) => {
    const out = result(source.version); out.entries = source.entries;
    out.global = source.global;
    const all = reports.map(r => r.results[index]!);
    if (all.some(r => r.entries !== out.entries)) throw new Error('shard entry counts differ');
    for (const r of all) {
      out.samples += r.samples; out.renderedSamples += r.renderedSamples; out.nodes += r.nodes; out.normalizedLines += r.normalizedLines;
      for (const k of ['i', 'ii', 'iii', 'iv'] as const) out.itemBranches[k] += r.itemBranches[k];
      out.itemInfo.push(...r.itemInfo);
      if (r.held && out.held) { out.held.nodes += r.held.nodes; out.held.resumeShown += r.held.resumeShown; out.held.shown.push(...r.held.shown); }
      for (const k of ['a', 'b', 'c'] as const) out.errors[k] += r.errors[k];
      for (const k of ['uncovered', 'notEmitted', 'unavailable', 'diagnostic'] as const) out.coverage[k] += r.coverage[k] - (k === 'uncovered' ? r.global.foldFailures.length : 0);
      for (const k of Object.keys(out.findings) as (keyof Result['findings'])[]) {
        if (k === 'missingBlobs') continue;
        out.findings[k].push(...r.findings[k].filter(f => k !== 'uncovered' || !r.global.foldFailures.some(g => JSON.stringify(g) === JSON.stringify(f))));
      }
      for (const k of Object.keys(out.timing) as (keyof Result['timing'])[]) {
        if (k === 'samples') out.timing.samples.push(...r.timing.samples); else out.timing[k] += r.timing[k];
      }
      out.truncated ||= r.truncated;
    }
    for (const f of source.global.missingBlobs) add(out, 'missingBlobs', f);
    for (const f of source.global.foldFailures) add(out, 'uncovered', f);
    noSampleOutput(out, first.partition.lastSeq);
    for (const rows of Object.values(out.findings)) {
      rows.sort((a, b) => a.seq - b.seq || JSON.stringify(a).localeCompare(JSON.stringify(b)));
      if (rows.length > DETAIL_LIMIT) { rows.length = DETAIL_LIMIT; out.truncated = true; }
    }
    out.itemInfo.sort((a, b) => a.seq - b.seq || JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (out.itemInfo.length > DETAIL_LIMIT) { out.itemInfo.length = DETAIL_LIMIT; out.truncated = true; }
    out.held?.shown.sort((a, b) => a.seq - b.seq || (a.node ?? '').localeCompare(b.node ?? ''));
    if (out.held && out.held.shown.length > DETAIL_LIMIT) { out.held.shown.length = DETAIL_LIMIT; out.truncated = true; }
    out.timing.samples.sort((a, b) => a.seq - b.seq);
    return out;
  });
  return { ...first, partition: { ...first.partition, index: 0, total: 1 }, wallMs: Math.max(...reports.map(r => r.wallMs)), results };
}
/** Whole-run coverage only: individual shards never synthesize this finding. */
function noSampleOutput(r: Result, lastSeq: number): void {
  if (!r.renderedSamples) add(r, 'uncovered', { seq: lastSeq, reason: 'no sampled output; empty input or sampling/replay produced no coverage' });
}
function options(argv: string[]): Options {
  const ledger = argv[0]; if (!ledger || ledger.startsWith('--')) throw new Error('Usage: needs-replay <ledger.jsonl> --blobs DIR [--seqs a,b] [--every N] [--halts] [--baseline-src DIR] [--engine 0.28|0.27.2|both] [--plan-cache DIR] [--shard i/N] [--json]; --merge <report.json>...');
  const out: Options = { ledger, blobs: '', every: 0, seqs: new Set(), halts: false, json: false, engine: '0.28' };
  const seen = new Set<string>();
  const integer = (v: string): number => { if (!/^\d+$/.test(v) || !Number.isSafeInteger(Number(v))) throw new Error(`invalid seq/interval ${v}`); return Number(v); };
  for (let i = 1; i < argv.length; i++) {
    const flag = argv[i]!; if (seen.has(flag)) throw new Error(`duplicate ${flag}`); seen.add(flag);
    if (flag === '--halts') { out.halts = true; continue; }
    if (flag === '--json') { out.json = true; continue; }
    if (!['--blobs', '--seqs', '--every', '--baseline-src', '--engine', '--plan-cache', '--shard'].includes(flag)) throw new Error(`unknown ${flag}`);
    const value = argv[++i]; if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    if (flag === '--blobs') out.blobs = value;
    if (flag === '--baseline-src') out.baseline = value;
    if (flag === '--plan-cache') out.cache = value;
    if (flag === '--shard') {
      const m = /^(\d+)\/(\d+)$/.exec(value); if (!m) throw new Error('--shard requires i/N');
      const index = integer(m[1]!), total = integer(m[2]!);
      if (!total || index >= total) throw new Error('--shard requires 0 <= i < N');
      out.shard = { index, total };
    }
    if (flag === '--engine') { if (!['0.28', '0.27.2', 'both'].includes(value)) throw new Error('invalid --engine'); out.engine = value as Options['engine']; }
    if (flag === '--seqs') out.seqs = new Set(value.split(',').map(integer));
    if (flag === '--every') { out.every = integer(value); if (!out.every) throw new Error('--every must be positive'); }
  }
  if (!out.blobs) throw new Error('--blobs is required');
  if (out.baseline && !seen.has('--engine')) out.engine = 'both';
  if (out.engine !== '0.28' && !out.baseline) throw new Error('--baseline-src is required for 0.27.2');
  if (!out.every && !out.seqs.size && !out.halts) out.every = 1;
  return out;
}

/** CLI injection is only for synthetic regression renderers, never a source mutation or private hook. */
export async function replayMain(argv: string[], io: ReplayIo = console, render: Renderer = renderCurrent): Promise<number> {
  let temporaryCache: string | undefined;
  try {
    if (argv[0] === '--merge') {
      const report = mergeReports(argv.slice(1)), r = report.results[0]!; io.log(JSON.stringify(report));
      return r.errors.a + r.errors.b + r.errors.c ? 1 : r.coverage.uncovered + r.coverage.missingBlobs ? 2 : 0;
    }
    const start = performance.now(), o = options(argv), current = result('0.28'), results: Result[] = [];
    const implementations = [{ reduce, extend: extendState, parse: parsePlan, render, report: current, visible: o.engine !== '0.27.2' }];
    if (o.engine !== '0.27.2') results.push(current);
    if (o.engine !== '0.28') {
      const old = await adapter0272(o.baseline!), report = result('0.27.2');
      implementations.push({ ...old, report, visible: true }); results.push(report);
    }
    // Old-only mode still folds a current oracle; it never renders current surfaces and reports that cost explicitly.
    const cache = o.cache ?? (temporaryCache = mkdtempSync(join(tmpdir(), 'owed-replay-plans-')));
    const engines = implementations.map(x => ({ ...x, state: x.reduce([], planLookup(o.blobs, x.parse, x.report, cache)), broken: false }));
    const sampled = new Set<number>(), inputHash = createHash('sha256'); let last = -1, sampleOrdinal = 0;
    // Only digests are retained, never blob contents. Missing blobs/fold failures are whole-input facts.
    const referenced = new Map<string, { exists: boolean; digest: string | null }>();
    const stream = createReadStream(o.ledger, { encoding: 'utf8' }), lines = createInterface({ input: stream, crlfDelay: Infinity });
    try {
      for await (const line of lines) {
        if (!line.trim()) continue;
        inputHash.update(line).update('\n');
        const e = JSON.parse(line) as Entry;
        if (!Number.isSafeInteger(e.seq) || e.seq <= last) throw new Error('ledger seqs must strictly increase'); last = e.seq;
        const selected = o.seqs.has(e.seq) || !!o.every && e.seq % o.every === 0 || o.halts && e.kind === 'halt';
        if (selected) sampled.add(e.seq);
        const sample = selected && (!o.shard || sampleOrdinal % o.shard.total === o.shard.index);
        if (selected) sampleOrdinal++;
        const missing = blobRefs(e).filter(sha => {
          if (!referenced.has(sha)) {
            const exists = /^[a-f0-9]{64}$/.test(sha) && existsSync(join(o.blobs, sha));
            referenced.set(sha, { exists, digest: exists ? blobDigest(join(o.blobs, sha)) : null });
          }
          return !referenced.get(sha)!.exists;
        });
        for (const x of engines) {
          x.report.entries++;
          for (const sha of missing) {
            const finding = { seq: e.seq, reason: `missing blob ${sha} (${e.kind})` };
            x.report.global.missingBlobs.push(finding); add(x.report, 'missingBlobs', finding);
          }
          if (missing.length && (e.kind === 'plan' || e.kind === 'genesis')) x.broken = true;
          if (x.broken) { if (sample) add(x.report, 'uncovered', { seq: e.seq, reason: 'cannot replay after missing plan or rejected entry; no fabricated state' }); continue; }
          try { elapsed(() => x.extend(x.state, [e]), ms => { x.report.timing.foldMs += ms; }); }
          catch (error) {
            x.broken = true; const finding = { seq: e.seq, reason: `replay failed: ${message(error)}` };
            x.report.global.foldFailures.push(finding); add(x.report, 'uncovered', finding); continue;
          }
          if (sample && x.visible) {
            const now = Date.parse(e.ts); if (!Number.isFinite(now)) throw new Error(`invalid timestamp at #${e.seq}`);
            const timing: SampleTiming = { seq: e.seq, statusMs: 0, decideMs: 0, whyMs: 0, auditMs: 0 };
            try {
              const snap = x.render(x.state, now, timing); x.report.renderedSamples++;
              if (engines[0]!.broken) add(x.report, 'uncovered', { seq: e.seq, reason: 'current need oracle could not replay' });
              else elapsed(() => audit(x.report, engines[0]!.state, e.seq, snap), ms => { timing.auditMs += ms; });
            } catch (error) { add(x.report, 'uncovered', { seq: e.seq, reason: `surface failed: ${message(error)}` }); }
            for (const key of ['statusMs', 'decideMs', 'whyMs', 'auditMs'] as const) x.report.timing[key] += timing[key];
            x.report.timing.samples.push(timing);
          }
        }
      }
    } finally { lines.close(); stream.destroy(); }
    for (const r of results) {
      if (!o.shard) noSampleOutput(r, last);
      for (const seq of o.seqs) if (!sampled.has(seq) && (!o.shard || seq % o.shard.total === o.shard.index)) add(r, 'uncovered', { seq, reason: 'requested seq absent from ledger' });
    }
    for (const r of results) for (const rows of Object.values(r.findings)) rows.sort((a, b) => a.seq - b.seq || JSON.stringify(a).localeCompare(JSON.stringify(b)));
    if (o.engine === '0.27.2') results[0]!.timing.oracleFoldMs = current.timing.foldMs;
    const report: ReplayReport = { partition: { ledger: inputHash.digest('hex'), lastSeq: last,
      blobs: digest(JSON.stringify([...referenced].sort(([a], [b]) => a.localeCompare(b)))),
      replayFailures: engines.map(x => ({ engine: x.report.version, failures: x.report.global.foldFailures })), every: o.every, seqs: [...o.seqs].sort((a, b) => a - b), halts: o.halts,
      index: o.shard?.index ?? 0, total: o.shard?.total ?? 1 }, assumptions: { runs: 'empty map; no historical DSA state inferred', now: 'sampled entry.ts', driverRunning: true,
      runtime: 'no historical measuring/asking records inferred', oracle: '0.28 needs on current replay state; old-only also folds this oracle', detailLimit: DETAIL_LIMIT,
      normalization: `only exact trailing${DRIVER_SUFFIX}`, engine: o.engine,
      memory: 'lazy parsed-plan LRU per adapter: at most 64 entries and 16 MiB source bytes (not a heap-byte bound), atomic engine+sha JSON fallback; reducer also bounds historical frozen values' },
      wallMs: performance.now() - start, results };
    if (o.json) io.log(JSON.stringify(report));
    else {
      io.log(`Assumptions: runs=empty map; now=sampled entry.ts; driverRunning=true; no measuring/asking reconstruction`);
      for (const r of results) {
        io.log(`${r.version}: entries=${r.entries} samples=${r.samples} renderedSamples=${r.renderedSamples} nodes=${r.nodes}; (a)=${r.errors.a} (b)=${r.errors.b} (c)=${r.errors.c}; coverage=${JSON.stringify(r.coverage)}; normalizedLines=${r.normalizedLines}`);
        io.log(`${r.version} timing: ${JSON.stringify(r.timing)}`);
        io.log(`${r.version} item branches: ${JSON.stringify(r.itemBranches)}`);
        if (r.held) io.log(`${r.version} held halts: nodes=${r.held.nodes} resumeShown=${r.held.resumeShown}`);
        for (const f of r.itemInfo) io.log(`${r.version} item info: ${JSON.stringify(f)}`);
        for (const [kind, findings] of Object.entries(r.findings)) for (const f of findings) io.log(`${r.version} ${kind}: ${JSON.stringify(f)}`);
        if (r.truncated) io.log(`${r.version}: details truncated; totals include every finding`);
      }
    }
    const selected = results[0]!;
    return selected.errors.a + selected.errors.b + selected.errors.c ? 1 : selected.coverage.uncovered + selected.coverage.missingBlobs ? 2 : 0;
  } catch (e) { io.error(message(e)); return 2; }
  finally { if (temporaryCache) rmSync(temporaryCache, { recursive: true, force: true }); }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = await replayMain(process.argv.slice(2));
