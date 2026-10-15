import { matchesWrite, writesSyntax } from './writes.ts';
import { spawn } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import type { Plan, AttestJob, ObsEntry, Counts, QuarantineEntry } from './types.ts';
import type { Ledger } from './ledger.ts';
import { git, materialize, overlay, mutantPaths, keyCommitsTo } from './git.ts';
import { leaseEnvironment, leaseWaitField } from './lease.ts';
import { remeasureMatches } from './remeasure-on.ts';
import { resolve as absolutePath } from 'node:path';
import { expandWrap } from './exec-wrap.ts';
import { assertNoLedgerLock } from './lock-context.ts';

/**
 * K2.1: the note of a non-red check that fails on its count: `zero tests; exit <code>`, or `min_tests unmet: counted
 * <tests> (<pass> pass, <fail> fail[, <skip> skip]) < min_tests <m>; exit <code>` (an unknown pass/fail count reads `?`).
 */
export function countNote(counts: Counts | undefined, minTests: number | undefined, code: number | null): string {
  const exit = `exit ${code ?? 'none'}`;
  if (!counts || counts.tests === 0 || minTests === undefined) return `zero tests; ${exit}`;
  const parts = [`${counts.pass ?? '?'} pass`, `${counts.fail ?? '?'} fail`, ...(counts.skip ? [`${counts.skip} skip`] : [])];
  return `min_tests unmet: counted ${counts.tests ?? '?'} (${parts.join(', ')}) < min_tests ${minTests}; ${exit}`;
}
export interface ExecContext { cwd: string; plan: Plan; ledger: Ledger; grantedWrites?: readonly string[]; signal?: AbortSignal; abortGraceMs?: number; onProgress?(msg: string): void }
function tapCounts(log: string): Counts | undefined {
  const tap: Counts = { format: 'tap' };
  for (const m of log.matchAll(/^\s*(?:#|ℹ)\s*(tests|pass|fail|skip|skipped)\s+(\d+)\s*$/gm)) {
    const key = m[1] === 'skipped' ? 'skip' : m[1] as 'tests' | 'pass' | 'fail' | 'skip'; tap[key] = Number(m[2]);
  }
  if (Object.keys(tap).length > 1) { tap.tests ??= (tap.pass ?? 0) + (tap.fail ?? 0) + (tap.skip ?? 0); return tap; }
  const tapPlan = [...log.matchAll(/^1\.\.(\d+)(?:\s+#.*)?\s*$/gm)].at(-1);
  return tapPlan ? { format: 'tap', tests: Number(tapPlan[1]) } : undefined;
}
/** cargo prints its summaries at column 0; an indented or `# `-prefixed one is TAP diagnostic text, never counted (review #557). */
function cargoCounts(log: string): Counts | undefined {
  const cargo = [...log.matchAll(/^test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/gm)];
  return cargo.length ? cargo.reduce<Counts>((c, m) => ({ format: 'cargo', tests: (c.tests ?? 0) + Number(m[1]) + Number(m[2]) + Number(m[3]), pass: (c.pass ?? 0) + Number(m[1]), fail: (c.fail ?? 0) + Number(m[2]), skip: (c.skip ?? 0) + Number(m[3]) }), {}) : undefined;
}
/** RC2/RC3: last valid owed-counts line wins; malformed lines are ignored and noted by the executor. */
export function parseCounts(log: string, malformed?: (note: string) => void): Counts | undefined {
  let owed: Counts | undefined;
  const integer = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;
  for (const line of log.split(/\r?\n/)) {
    // RC2 (#1274): only column-0 protocol; TAP comments/diagnostics are silent non-protocol text.
    if (!/^owed-counts(?:\s|$)/.test(line)) continue;
    try {
      const c: unknown = JSON.parse(line.replace(/^owed-counts\s*/, ''));
      if (!c || typeof c !== 'object' || Array.isArray(c)) throw new Error('expected object');
      const x = c as Record<string, unknown>;
      if (!integer(x.pass) || !integer(x.fail) || (x.skip !== undefined && !integer(x.skip)) || (x.failed !== undefined && (!Array.isArray(x.failed) || x.failed.some(n => typeof n !== 'string')))) throw new Error('invalid counts');
      owed = { format: 'owed', tests: x.pass + x.fail + ((x.skip as number | undefined) ?? 0), pass: x.pass, fail: x.fail, ...(x.skip !== undefined ? { skip: x.skip as number } : {}), ...(x.failed !== undefined ? { failed: (x.failed as string[]).slice(0, 50) } : {}) };
    } catch { malformed?.('malformed owed-counts line ignored'); }
  }
  if (owed) return owed;
  const counts = standardCounts(log);
  if (counts && ['tap', 'cargo', 'mixed'].includes(counts.format ?? '')) {
    const failed = failingNames(log);
    if (failed.length) counts.failed = failed;
  }
  return counts;
}
/** RC3: TAP test points and column-0 cargo results, never diagnostic cargo lines inside TAP. */
function failingNames(log: string): string[] {
  return [...log.matchAll(/^\s*not ok \d+\s*-\s*(.+)$|^test (.+) \.\.\. FAILED\s*$/gm)].map(m => m[1] ?? m[2]!).slice(0, 50);
}
function standardCounts(log: string): Counts | undefined {
  const tap = tapCounts(log), cargo = cargoCounts(log);
  // E2.1: cargo `test result:` lines and TAP in one log (e.g. `cargo test && node --test --test-reporter=tap`) sum to one
  // `mixed` count. A field the TAP part does not report (a bare `1..N` plan) stays absent rather than undercounted.
  if (tap && cargo) {
    const mixed: Counts = { format: 'mixed', tests: (tap.tests ?? 0) + (cargo.tests ?? 0) };
    for (const k of ['pass', 'fail', 'skip'] as const) if (tap[k] !== undefined) mixed[k] = tap[k] + (cargo[k] ?? 0);
    return mixed;
  }
  if (tap) return tap;
  if (cargo) return cargo;
  const summary = [...log.matchAll(/^\s*Tests:?\s+(.+)$/gm)].at(-1)?.[1];
  if (summary) {
    const c: Counts = { format: 'jest/vitest', tests: 0 };
    for (const m of summary.matchAll(/(\d+)\s+(passed|failed|skipped|todo|total)/g)) {
      const n = Number(m[1]); if (m[2] === 'total') c.tests = n;
      else { const k = m[2] === 'passed' ? 'pass' : m[2] === 'failed' ? 'fail' : 'skip'; c[k] = (c[k] ?? 0) + n; }
    }
    const total = /\((\d+)\)/.exec(summary); c.tests = total ? Number(total[1]) : c.tests || (c.pass ?? 0) + (c.fail ?? 0) + (c.skip ?? 0); return c;
  }
  if (/no tests (?:ran|collected|found)|collected 0 items/i.test(log)) return { format: 'pytest', tests: 0 };
  const py = log.split('\n').reverse().find(l => /\d+ (?:passed|failed|skipped|error)/.test(l) && /(?:=| in \d)/.test(l));
  if (py) {
    const c: Counts = { format: 'pytest', tests: 0 };
    for (const m of py.matchAll(/(\d+) (passed|failed|skipped|errors?|xfailed|xpassed|deselected)/g)) {
      if (m[2] === 'deselected') continue;
      const n = Number(m[1]), k = m[2] === 'passed' || m[2] === 'xpassed' ? 'pass' : m[2] === 'skipped' || m[2] === 'xfailed' ? 'skip' : 'fail';
      c[k] = (c[k] ?? 0) + n; c.tests! += n;
    }
    return c;
  }
  return undefined;
}
/** FG: display-only errors; failed names and measurement verdicts remain unchanged. */
export interface ErrorGroup { message: string; location?: string; names: string[]; expected?: string; actual?: string; signatureLocation?: string }
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
function errorMessage(text: string, bounded = true): string {
  const line = stripAnsi(text).replace(/\s+/g, ' ').replace(/;/g, ',').trim();
  return bounded && line.length > 160 ? `${line.slice(0, 159)}…` : line;
}
function errorLocation(text: string, cwd?: string): string | undefined {
  let location = text.trim().replace(/^file:\/\//, '').replace(/:(\d+):\d+$/, ':$1');
  if (location.startsWith('/')) {
    const prefix = cwd ? `${cwd.replace(/\/$/, '')}/` : undefined;
    location = prefix && location.startsWith(prefix) ? location.slice(prefix.length) : location.split('/').slice(-3).join('/');
  }
  return stripAnsi(location).replace(/\s+/g, ' ').replace(/;/g, ',').trim() || undefined;
}
/** SG1: first (innermost) repository test frame, never an external or creation-site frame. */
function testStackLocation(stack: unknown, cwd?: string): string | undefined {
  if (typeof stack !== 'string') return undefined;
  for (const line of stack.split('\n')) {
    const frame = /(?:\(|\bat\s+)(?:file:\/\/)?([^\s()]+):(\d+):\d+\)?\s*$/.exec(line.trim());
    if (!frame) continue;
    let path = frame[1]!;
    if (path.startsWith('/')) {
      if (!cwd || !path.startsWith(`${cwd.replace(/\/$/, '')}/`)) continue;
      path = path.slice(cwd.replace(/\/$/, '').length + 1);
    }
    if (path.startsWith('../') || path.includes('/node_modules/') || path.startsWith('node_modules/')) continue;
    if (/(?:^|\/)(?:tests?\/|[^/]+\.(?:test|spec)\.)|(?:^|\/)[^/]+_tests\.[^/]+$/.test(path)) return `${path}:${frame[2]}`;
  }
  return undefined;
}
/** SG1: YAML scalars and structured assertion values, masked and bounded independently. */
function assertionValue(value: unknown): string {
  return errorSignature(typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)).replace(/\s+/g, ' ').slice(0, 120);
}
/** Pure extraction with an explicit run directory for executor-only path shortening. */
function groupsAt(log: string, failed: readonly string[], cwd?: string, signature = false, full = false): { groups: ErrorGroup[]; hasError: boolean } {
  const wanted = new Set(failed), points: { name: string; message?: string; location?: string; signatureLocation?: string; expected?: string; actual?: string; parent?: boolean; at: number }[] = [];
  const clean = full ? log : stripAnsi(log).replace(/\r\n/g, '\n'), lines = clean.split('\n');
  let offset = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!, point = /^\s*not ok \d+\s*-\s*(.+)$/.exec(line);
    if (point && wanted.has(point[1]!)) {
      const start = /^(\s+)---\s*$/.exec(lines[i + 1] ?? '');
      let diagnostic: Record<string, unknown> = {}, blockMessage: string | undefined;
      if (start) {
        const indent = start[1]!.length, body: string[] = [];
        for (let j = i + 2; j < lines.length; j++) {
          const next = lines[j]!;
          if (next.trim() === '...' && next.search(/\S/) === indent) {
            try {
              const parsed: unknown = parseYaml(body.join('\n'), { schema: 'failsafe', logLevel: 'silent' });
              if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) diagnostic = parsed as Record<string, unknown>;
            } catch { /* A malformed diagnostic falls back to the failed name. */ }
            break;
          }
          if (next.trim() && next.search(/\S/) < indent) break;
          body.push(next.slice(indent));
        }
        const errorLine = body.findIndex(l => /^error:\s*[|>][-+]?\s*(?:#.*)?$/.test(l));
        if (errorLine >= 0) {
          blockMessage = '';
          for (const next of body.slice(errorLine + 1)) {
            if (next.trim() && !/^\s/.test(next)) break;
            if (next.trim()) { blockMessage = next; break; }
          }
        }
      }
      const raw = typeof diagnostic.error === 'string' ? diagnostic.error : '';
      // Folded YAML scalars also display their first source line, before YAML joins the lines.
      const message = full ? raw : raw ? errorMessage(blockMessage ?? raw.split('\n')[0]!, !signature) : '';
      // Node omits YAML fields for undefined values; its assertion diff still carries them.
      if (diagnostic.code === 'ERR_ASSERTION') {
        const diff = raw.split('\n');
        const valueAt = (prefix: string): string | undefined => diff.find(l => l.startsWith(prefix))?.slice(prefix.length).trim();
        if (!Object.hasOwn(diagnostic, 'actual')) { const value = valueAt('+ '); if (value !== undefined) diagnostic.actual = value; }
        if (!Object.hasOwn(diagnostic, 'expected')) { const value = valueAt('- '); if (value !== undefined) diagnostic.expected = value; }
      }
      const signatureLocation = testStackLocation(diagnostic.stack, cwd);
      const location = signatureLocation ?? (typeof diagnostic.location === 'string' ? errorLocation(diagnostic.location, cwd) : undefined);
      points.push({ name: point[1]!, ...(message ? { message } : {}), ...(location ? { location } : {}), ...(signatureLocation ? { signatureLocation } : {}),
        ...(Object.hasOwn(diagnostic, 'expected') ? { expected: assertionValue(diagnostic.expected) } : {}),
        ...(Object.hasOwn(diagnostic, 'actual') ? { actual: assertionValue(diagnostic.actual) } : {}), parent: diagnostic.failureType === 'subtestsFailed', at: offset });
    }
    offset += line.length + 1;
  }
  // Parse each panic independently so an unfinished message cannot consume the next header.
  // FS (ruling): Rust >= 1.86 prints the thread id: `thread 'name' (1234) panicked at path:line:col:`.
  const panicHeaders = [...clean.matchAll(/^thread '[^']+'(?: \(\d+\))? panicked at /gm)];
  for (const [i, header] of panicHeaders.entries()) {
    const record = clean.slice(header.index, panicHeaders[i + 1]?.index ?? clean.length);
    // Legacy messages may span lines, but not failed-test or stdout record boundaries.
    const m = /^thread '([^']+)'(?: \(\d+\))? panicked at '((?:(?!^test [^\r\n]* \.\.\. FAILED\b|^---- [^\r\n]* stdout ----[ \t]*$)[\s\S])+?)', ([^\r\n]+:\d+:\d+)\r?$|^thread '([^']+)'(?: \(\d+\))? panicked at (.+):\r?\n([^\r\n]*)/m.exec(record);
    if (!m) continue;
    const name = m[1] ?? m[4]!;
    // A quoted legacy header without a closing message is not a new-style location.
    if (!wanted.has(name) || (!m[1] && m[5]!.startsWith("'"))) continue;
    const message = full ? m[2] ?? m[6]! : errorMessage(signature ? (m[2] ?? m[6]!).split('\n')[0]! : m[2] ?? m[6]!, !signature);
    const location = errorLocation(m[3] ?? m[5]!, cwd);
    // FS (ruling): a cargo signature is the panic message and its location (signature mode only; display unchanged).
    points.push({ name, ...(message ? { message } : {}), location, ...(signature && location ? { signatureLocation: location } : {}), at: header.index + m.index });
  }
  points.sort((a, b) => a.at - b.at);
  const hasChildError = points.some(p => !p.parent && p.message);
  const picked = new Map<string, typeof points[number]>();
  for (const point of points) {
    if (point.parent && hasChildError) continue;
    if (!picked.has(point.name) || (!picked.get(point.name)!.message && point.message)) picked.set(point.name, point);
  }
  const parents = new Set(points.filter(p => p.parent && hasChildError).map(p => p.name));
  for (const name of failed) if (!picked.has(name) && !parents.has(name)) picked.set(name, { name, at: clean.length });
  const groups = new Map<string, ErrorGroup>();
  for (const point of picked.values()) {
    const message = point.message ?? '(no error text)', group = groups.get(message);
    if (group) {
      group.names.push(point.name);
      if (group.location !== point.location) delete group.location;
    } else groups.set(message, { message, ...(point.location ? { location: point.location } : {}), ...(point.signatureLocation ? { signatureLocation: point.signatureLocation } : {}), ...(point.expected !== undefined ? { expected: point.expected } : {}), ...(point.actual !== undefined ? { actual: point.actual } : {}), names: [point.name] });
  }
  return { groups: [...groups.values()].sort((a, b) => b.names.length - a.names.length), hasError: [...picked.values()].some(p => !!p.message) };
}
/** AT4: a stable error signature: the first error line with hex ids, durations and temp paths masked. */
export function errorSignature(message: string): string {
  return message.replace(/\b(?:0x)?[0-9a-f]{8,}\b/gi, '<hex>').replace(/\b\d+(?:\.\d+)?\s*(?:ms|s)\b/g, '<t>').replace(/\/tmp\/[^\s'",)]+/g, '<tmp>');
}
/** AT4: keep the first signature seen per failed name of `obs` (at most 50), from the run log; names without error text get none. */
function recordSignatures(obs: { failed?: string[]; signatures?: Record<string, string> }, log: string, names: readonly string[], cwd: string): void {
  if (!names.length) return;
  const out = obs.signatures ?? {};
  for (const name of names) {
    const parsed = groupsAt(log, [name], cwd, true), g = parsed.groups[0];
    if (!g || !parsed.hasError) continue;
    if (out[name] === undefined && obs.failed?.includes(name)) out[name] = `v2|${JSON.stringify([errorSignature(g.message), g.signatureLocation ?? null, g.expected ?? null, g.actual ?? null])}`;
  }
  if (Object.keys(out).length) obs.signatures = out;
}
/** FG1: distinct errors, most common first, then first appearance; no ambient cwd or state. */
export function errorGroups(log: string, failed: readonly string[], full = false): ErrorGroup[] { return groupsAt(log, failed, undefined, false, full).groups; }
function failedTests(log: string, failed: readonly string[], cwd: string): string {
  const quotes = failed.slice(0, 3).map(name => {
    const g = groupsAt(log, [name], cwd).groups[0]!;
    const values = g.expected !== undefined && g.actual !== undefined ? `expected ${g.expected}, actual ${g.actual}` : g.message;
    return `${stripAnsi(name).replace(/\s+/g, ' ').replace(/;/g, ',')}${g.location ? ` (${g.location})` : ''}: ${values}`;
  });
  return `failed tests: ${quotes.join(' | ')}${failed.length > 3 ? ` (+${failed.length - 3} more)` : ''}`;
}
const LIMIT = 1024 * 1024;
/** E2.2: the last `n` non-empty output lines (ANSI colour removed, trailing blanks trimmed), each at most 200 characters. */
export function lastLines(log: string, n = 5): string[] {
  return log.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').split(/\r?\n|\r/).map(l => l.trimEnd()).filter(l => l.trim()).slice(-n).map(l => l.slice(0, 200));
}
/** F2.1: the note prefix of an observation whose failure is the environment's (disk full, tree preparation), not the code's. */
export const ENVIRONMENT = 'environment: ';
/** F2.1: output of a failed process that says the disk (or quota) is full. */
export const DISK_FULL = /ENOSPC|No space left on device|Disk quota exceeded/;
/** F2.1: a failure owed records with the `environment: ` note prefix (verdict error). */
class EnvironmentError extends Error {}
/** F2.1: runs a tree preparation step (worktree add/reset/checkout, overlay, setup); its failure is an environment failure. */
async function prepare<T>(step: () => Promise<T>): Promise<T> {
  try { return await step(); } catch (e) { throw e instanceof EnvironmentError ? e : new EnvironmentError(e instanceof Error ? e.message : String(e)); }
}
/**
 * F2.1 (ruling #1094): the lines an environment pattern is searched in: the last 50 non-empty output lines after
 * dropping TAP test points and subtest titles (`ok `, `not ok `, `# Subtest:`), node spec-reporter test titles (`✔ `,
 * `✖ `, `▶ `; G3.4 0.12) and cargo `test … ok|FAILED` lines, so a test name never counts as evidence.
 */
export function environmentLines(log: string): string[] {
  return log.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').split(/\r?\n|\r/).map(l => l.trimEnd()).filter(l => {
    const t = l.trimStart();
    return t && !t.startsWith('ok ') && !t.startsWith('not ok ') && !t.startsWith('# Subtest:') && !/^[✔✖▶] /.test(t) && !/^test .* \.\.\. (?:ok|FAILED)\b/.test(t);
  }).slice(-50);
}
/**
 * F2.1 (ruling #1094): throws an environment failure when the command exited non-zero, its counts report no failing
 * test (none parsed, or fail 0), and an environment pattern matches in `environmentLines`. A run with fail > 0 is a fail.
 */
function diskFull(code: number | null, counts: Counts | undefined, log: string, what: string): void {
  if (code === null || code === 0 || (counts?.fail ?? 0) !== 0) return;
  const lines = environmentLines(log), m = DISK_FULL.exec(lines.join('\n'));
  // G3.4 (0.12): the note shows the filtered lines the pattern matched (the last 5, each at most 200 characters).
  if (m) { const t = lines.filter(l => DISK_FULL.test(l)).slice(-5).map(l => l.trim().slice(0, 200)); throw new EnvironmentError(`${m[0]}: ${what}; matched output:${t.map(l => `\n  ${l}`).join('')}`); }
}
/** SG5: bounded, best-effort process tree before timeout kills the command group. */
async function timeoutProcessTree(pid: number | undefined): Promise<string> {
  assertNoLedgerLock();
  if (!pid) return 'process tree unavailable (no pid)';
  return new Promise(resolve => {
    const ps = spawn('ps', ['-axo', 'pid=,ppid=,stat=,wchan=,etime=,args='], { stdio: ['ignore', 'pipe', 'pipe'] });
    let bytes = Buffer.alloc(0), error = '';
    const timer = setTimeout(() => ps.kill('SIGKILL'), 2000);
    ps.stdout.on('data', (b: Buffer) => { bytes = Buffer.concat([bytes, b]); if (bytes.length > 4 * LIMIT) bytes = bytes.subarray(bytes.length - 4 * LIMIT); });
    ps.stderr.on('data', (b: Buffer) => { error = b.toString().slice(0, 200); });
    ps.on('error', e => { error = e.message; });
    ps.on('close', () => {
      clearTimeout(timer);
      const rows = bytes.toString().split('\n').map(line => /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/.exec(line)).filter(m => m !== null);
      const ids = new Set([pid]);
      for (let changed = true; changed;) { changed = false; for (const r of rows) if (ids.has(Number(r[2])) && !ids.has(Number(r[1]))) { ids.add(Number(r[1])); changed = true; } }
      const tree = rows.filter(r => ids.has(Number(r[1]))).slice(0, 1000).map(r => `${r[1]} ${r[2]} ${r[3]} ${r[4]} ${r[5]} ${r[6]!.slice(0, 200)}`).join('\n');
      resolve(`process tree (pid ppid state wchan elapsed args):\n${tree || `unavailable${error ? ` (${error})` : ''}`}`);
    });
  });
}
export interface CommandResult { code: number | null; error?: string; log: string; spawn?: boolean; measurementLog?: string }
/** Shared shell, environment, wrapper and process-group handling for measurements and slot setup. */
export async function runCommand(ctx: Pick<ExecContext, 'plan' | 'signal' | 'abortGraceMs'>, run: string, cwd: string, timeout: number, capture: (data: Buffer) => void = () => {}, onTimeout?: string): Promise<CommandResult> {
  assertNoLedgerLock();
  return new Promise(resolve => {
    let output = Buffer.alloc(0), error: string | undefined, spawnError = false;
    const inherited: NodeJS.ProcessEnv = { ...process.env };
    // Nested test runners and dsa call identities must not leak into child commands; DSA_HOME is configuration.
    delete inherited.NODE_TEST_CONTEXT;
    for (const name of Object.keys(inherited)) if (name.startsWith('DSA_') && name !== 'DSA_HOME') delete inherited[name];
    cwd = absolutePath(cwd);
    const env: NodeJS.ProcessEnv = { ...inherited, ...ctx.plan.exec?.env, CI: '1', OWED: '1', OWED_TREE: cwd, ...leaseEnvironment() };
    const wrap = ctx.plan.exec?.wrap, wrapped = typeof wrap === 'string';
    const argv = wrapped ? ['bash', '-lc', expandWrap(wrap, cwd, timeout, run)] : [...(wrap ?? []), 'bash', '-lc', run];
    const p = spawn(argv[0]!, argv.slice(1), { cwd, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let measurementLog: string | undefined;
    const collect = (b: Buffer) => { if (measurementLog !== undefined) return; capture(b); output = Buffer.concat([output, b]); if (output.length > LIMIT) output = output.subarray(output.length - LIMIT); };
    p.stdout.on('data', collect); p.stderr.on('data', collect);
    let escalation: NodeJS.Timeout | undefined;
    const kill = (sig: NodeJS.Signals = 'SIGKILL') => { if (p.pid) { try { process.kill(-p.pid, sig); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') error = String(e); } } };
    const abort = () => {
      error = 'aborted';
      if (ctx.abortGraceMs) { kill('SIGTERM'); escalation = setTimeout(() => kill(), ctx.abortGraceMs); }
      else kill();
    };
    let timeoutDetails: Promise<string> | undefined, wrapperDeadline: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      // Ruling #2118: freeze evidence at the boundary, before any diagnostic can alter the tree.
      measurementLog = output.toString();
      error = `timeout after ${timeout}s`;
      // A remote wrapper must remain runnable to finish/terminate its remote command.
      // Evidence still freezes at timeout_s, even when the wrapper exits during its grace.
      if (wrapped) {
        // Node timers overflow beyond 2^31-1 ms; keep large valid grace values bounded per timer.
        const deadline = Date.now() + (ctx.plan.exec?.wrap_grace_s ?? 30) * 1000;
        const arm = () => {
          const remaining = deadline - Date.now();
          if (remaining <= 0) { kill(); return; }
          wrapperDeadline = setTimeout(arm, Math.min(remaining, 2_147_483_647));
        };
        arm();
      } else kill('SIGSTOP');
      timeoutDetails = (async () => {
        let diagnostic = '';
        try {
          // Snapshot before a wrapper's hard deadline, not after a slow diagnostic.
          const wrapperTree = wrapped ? await timeoutProcessTree(p.pid) : undefined;
          if (onTimeout) {
            const result = await runCommand(ctx, onTimeout, cwd, 30);
            diagnostic = `\non_timeout (diagnostic only):\n${Buffer.from(result.log).subarray(-256 * 1024).toString()}${result.error ? `\n${result.error}` : ''}\nexit ${result.code ?? 'none'}`;
          }
          return `${diagnostic}\n${wrapperTree ?? await timeoutProcessTree(p.pid)}`;
        } catch (e) { return `${diagnostic}\nprocess tree unavailable (${String(e).slice(0, 200)})`; }
        finally { if (!wrapped) kill(); }
      })();
    }, timeout * 1000);
    ctx.signal?.addEventListener('abort', abort, { once: true }); if (ctx.signal?.aborted) abort();
    p.on('error', e => { error = e.message; spawnError = true; });
    p.on('close', async (code, signal) => {
      clearTimeout(timer); clearTimeout(escalation);
      // RX2 #2265: close may leave background group members alive with redirected streams.
      // Do not cancel their hard deadline and then wait for a slow timeout diagnostic.
      if (wrapped && measurementLog !== undefined) kill();
      clearTimeout(wrapperDeadline); ctx.signal?.removeEventListener('abort', abort);
      const details = timeoutDetails ? await timeoutDetails : undefined;
      kill();
      if (details !== undefined) {
        output = output.subarray(Math.max(0, output.length - 256 * 1024));
        const appendix = `\n${error}\n${details}\n`;
        capture(Buffer.from(appendix));
        output = Buffer.concat([output, Buffer.from(appendix)]);
      }
      resolve({ code: measurementLog !== undefined ? null : code, error: error ?? (signal ? `terminated by ${signal}` : undefined), log: output.toString(), ...(measurementLog !== undefined ? { measurementLog } : {}), ...(spawnError ? { spawn: true } : {}) });
    });
  });
}
/** MS4: the job's active quarantine entries, when its key commits to exactly their names (never on red/mutants runs). */
async function excusableQuarantine(ctx: ExecContext, job: AttestJob): Promise<QuarantineEntry[]> {
  const q = job.quarantined ?? [];
  if (!q.length || (job.kind !== 'check' && job.kind !== 'inv')) return [];
  return await keyCommitsTo(ctx.cwd, ctx.plan, job, q.map(e => e.test)) ? q : [];
}
/**
 * MS4 rulings 2 (10-15 01:5x): whether `run` is a plain `node --test` invocation: space-separated tokens of only
 * `[A-Za-z0-9_./=:@,+*?-]` (no quote, `$`, backslash, redirection or operator), optional leading `NAME=value`
 * tokens, then exactly `node`, with a `--test` token among its arguments.
 */
export function nodeTestRun(run: string): boolean {
  const tokens = run.split(' ').filter(t => t !== '');
  if (!tokens.length || tokens.some(t => !/^[A-Za-z0-9_./=:@,+*?-]+$/.test(t))) return false;
  let i = 0;
  while (i < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[i]!)) i++;
  return tokens[i] === 'node' && tokens.slice(i + 1).includes('--test');
}
const CARGO_RUN = /(?:^|\s)cargo\s+(?:\+\S+\s+)?test\b/;
/** MS4 ruling c: TAP completeness: a column-0 plan `1..N` and exactly N column-0 results. */
function tapComplete(log: string): string | undefined {
  const plan = [...log.matchAll(/^1\.\.(\d+)(?:\s+#.*)?\s*$/gm)];
  if (plan.length !== 1) return plan.length ? 'several top-level TAP plans' : 'no TAP plan';
  const results = [...log.matchAll(/^(?:not )?ok \d+\b/gm)].length, n = Number(plan[0]![1]);
  return results === n ? undefined : `TAP plan 1..${n} but ${results} top-level results`;
}
/**
 * MS4 (fail-closed, parent rulings 10-15 01:0x and 01:5x): the quarantine entries that excuse a run, or why they do
 * not. All of: a plain `node --test` run (never cargo in 0.20); it completed with exit 1 (never a timeout, signal or
 * spawn error); TAP completeness proven (one plan `1..N`, N top-level results); every
 * failing name (fail = number of distinct names) exactly equals an active entry; and the remaining tests still meet
 * min_tests. `reason` is set only when entries were active and the run had failing names or a failing exit.
 */
export function quarantineExcuse(q: QuarantineEntry[], run: string, r: CommandResult, counts: Counts | undefined, failed: string[], minTests?: number): { excused?: QuarantineEntry[]; reason?: string } {
  const names = [...new Set(failed)];
  if (!q.length || (r.code === 0 && !names.length)) return {};
  const no = (reason: string) => ({ reason });
  if (r.error || r.spawn || r.code === null) return no(r.error ? `run did not complete (${r.error.split('\n')[0]})` : 'run did not complete');
  if (!names.length) return no('no failing test names');
  if (CARGO_RUN.test(run)) return no('cargo runs are not excused in 0.20');
  if (!nodeTestRun(run)) return no('not a known test runner');
  if (r.code !== 1) return no(`exit ${r.code} is not a test failure`);
  if (!counts || counts.format !== 'tap') return no('counts are not TAP');
  const incomplete = tapComplete(r.log);
  if (incomplete) return no(incomplete);
  if (!counts.tests || counts.fail !== names.length) return no(`${counts.fail ?? 0} failing tests but ${names.length} failing names`);
  const hit = names.map(n => q.find(e => e.test === n)), other = names.filter((_, i) => !hit[i]);
  if (other.length) return no(`${other.length} failing test${other.length > 1 ? 's are' : ' is'} not quarantined`);
  const left = counts.tests - names.length;
  if (minTests !== undefined && left < minTests) return no(`${left} tests left, below min_tests ${minTests}`);
  return { excused: hit as QuarantineEntry[] };
}
/** MS4: counts without the excused tests: they count neither as passed nor as failed (min_tests sees the rest). */
function withoutQuarantined(c: Counts, excused: QuarantineEntry[]): Counts {
  const names = new Set(excused.map(e => e.test)), failed = c.failed?.filter(n => !names.has(n));
  return { ...c, tests: (c.tests ?? 0) - names.size, fail: (c.fail ?? 0) - names.size, ...(c.failed ? { failed } : {}) };
}
/** MS4: `quarantined: <name> (fix: <node>)`, comma-separated. */
export const quarantineNote = (q: Map<string, string>): string => `quarantined: ${[...q].map(([test, fix]) => `${test} (fix: ${fix})`).join(', ')}`;
export async function runJob(ctx: ExecContext, job: AttestJob): Promise<Omit<ObsEntry, 'seq' | 'ts' | 'prev' | 'hash'>> {
  assertNoLedgerLock();
  const start = Date.now();
  const obs: Omit<ObsEntry, 'seq' | 'ts' | 'prev' | 'hash'> = { kind: 'obs', by: 'executor:owed', subject: job.subject, obligation: job.obligation, key: job.key, verdict: 'error', exit: null, durationMs: 0, commit: job.commit, base: job.base, attribution: job.attribution, ...leaseWaitField() };
  let bytes = Buffer.alloc(0), measurementBytes = Buffer.alloc(0), truncated = false, protocolWarnings = 0;
  function capture(data: Buffer | string): void {
    bytes = Buffer.concat([bytes, Buffer.isBuffer(data) ? data : Buffer.from(data)]);
    if (bytes.length > LIMIT) { truncated = true; bytes = bytes.subarray(bytes.length - LIMIT); }
  }
  let work: Awaited<ReturnType<typeof materialize>> | undefined;
  // M2: with exec.trees reuse, every tree of this job is the check's reused tree (a failure to prepare it is a note).
  const reuse = ctx.plan.exec?.trees === 'reuse' && job.spec && job.kind !== 'writes' ? { kind: job.kind, id: job.spec.id, touch: ctx.plan.exec?.touch, note: (line: string) => capture(`${line}\n`) } : undefined;
  let timeoutNote: string | undefined;
  const command = async (run: string, cwd: string, timeout: number, onTimeout?: string): Promise<CommandResult> => {
    const result = await runCommand(ctx, run, cwd, timeout, capture, onTimeout);
    if (result.error?.startsWith('timeout after')) {
      const beforeTimeout = result.measurementLog ?? result.log;
      const tail = lastLines(beforeTimeout, 3);
      timeoutNote = `${result.error}${tail.length ? `; ${tail.join(' | ')}` : ''}`;
      bytes = Buffer.from(result.log); truncated = false;
    }
    return result;
  };
  try {
    await ctx.ledger.measuringActivity(job.obligation);
    ctx.onProgress?.(`${job.subject}: ${job.obligation}`);
    if (ctx.signal?.aborted) throw new Error('aborted');
    if (job.kind === 'writes') {
      const node = ctx.plan.nodes.find(n => n.id === job.subject); if (!node) throw new Error(`unknown node ${job.subject}`);
      const paths = (await git(ctx.cwd, ['diff', '--no-renames', '--name-only', '-z', job.base, job.commit])).stdout.split('\0').filter(Boolean);
      const bad = paths.filter(p => !node.writes.some(prefix => matchesWrite(p, prefix, writesSyntax(ctx.plan))) && !ctx.grantedWrites?.includes(p));
      obs.verdict = bad.length ? 'fail' : 'pass'; obs.exit = bad.length ? 1 : 0; obs.note = bad.length ? `outside writes: ${bad.join(', ')}` : 'all changed paths within writes'; capture(obs.note);
    } else if (job.kind === 'strength') {
      // Mutation counterfactuals: every mutant patch comes from the base B, never from the candidate.
      const spec = job.spec; if (!spec) throw new Error('missing check spec');
      const paths = await mutantPaths(ctx.cwd, job.base, spec.mutants ?? [], ctx.plan.closure);
      if (!paths.length) throw new Error('no mutant patch in the base matches mutants and the closure');
      const results: string[] = []; let killed = 0;
      for (const path of paths) {
        if (ctx.signal?.aborted) throw new Error('aborted');
        capture(`\n=== mutant ${path} ===\n`);
        const patch = (await git(ctx.cwd, ['cat-file', 'blob', `${job.base}:${path}`])).stdout;
        work = await prepare(() => materialize(ctx.cwd, job.commit, reuse));
        try {
          const tree = work.path;
          await prepare(() => overlay(ctx.cwd, tree, job.base, ctx.plan.closure, 'replace'));
          const applied = await git(work.path, ['apply', '--whitespace=nowarn', '-'], { input: patch, allowFail: true });
          if (applied.code) { capture(applied.stderr); results.push(`survived ${path}: patch does not apply: ${applied.stderr.trim().split('\n')[0] ?? ''}`); continue; }
          if (ctx.plan.setup) {
            const setup = await command(ctx.plan.setup, work.path, spec.timeout_s);
            if (setup.error || setup.code !== 0) throw new EnvironmentError(`setup failed: ${setup.error ?? setup.code}`);
          }
          const result = await command(spec.run, work.path, spec.timeout_s, spec.on_timeout), counts = parseCounts(result.measurementLog ?? result.log, () => { protocolWarnings++; });
          if (result.spawn) throw new EnvironmentError(`spawn failed: ${result.error}`);
          diskFull(result.code, counts, result.measurementLog ?? result.log, `mutant ${path} run exited ${result.code}`);
          if (result.error && !result.error.startsWith('timeout')) throw new Error(result.error);
          const kill = counts?.tests !== 0 && (result.code !== 0 || (counts?.fail ?? 0) > 0);
          if (kill) killed++;
          results.push(`${kill ? 'killed' : 'survived'} ${path}: ${result.error ?? `exit ${result.code}`}, tests ${counts?.tests ?? '?'}, fail ${counts?.fail ?? '?'}${counts?.tests === 0 ? ' (zero-test run is not a kill)' : ''}`);
        } finally { const w = work; work = undefined; await w.dispose(); }
      }
      const minKill = spec.min_kill ?? 1, pass = killed >= minKill * paths.length - 1e-9;
      obs.counts = { format: 'mutants', tests: paths.length, pass: killed, fail: paths.length - killed };
      obs.verdict = pass ? 'pass' : 'fail'; obs.exit = pass ? 0 : 1; obs.note = `strength ${killed}/${paths.length} killed (min_kill ${minKill})`;
      capture(`\n${['Mutants:', ...results.map(l => `- ${l}`), obs.note].join('\n')}\n`);
    } else {
      if (job.kind !== 'red') obs.execution = { completed:false, countOK:false };
      const spec = job.spec; if (!spec) throw new Error('missing check spec');
      work = await prepare(() => materialize(ctx.cwd, job.kind === 'red' ? job.base : job.commit, reuse));
      const tree = work.path;
      if (job.kind === 'red') await prepare(() => overlay(ctx.cwd, tree, job.commit, spec.tests ?? [], 'add'));
      await prepare(() => overlay(ctx.cwd, tree, job.kind === 'inv' ? job.commit : job.base, ctx.plan.closure, 'replace'));
      if (ctx.plan.setup) {
        const setup = await command(ctx.plan.setup, work.path, spec.timeout_s);
        if (setup.error || setup.code !== 0) { obs.exit = setup.code; throw new EnvironmentError(`setup failed: ${setup.error ?? setup.code}`); }
      }
      // RC1: prepare once, execute sequentially in this same tree; errors stop without turning into failed votes.
      const repeat = spec.repeat, runs = repeat?.runs ?? 1, need = repeat?.need ?? runs;
      if (repeat && (job.kind === 'red' || spec.red || spec.mutants)) throw new Error('repeat is not allowed on red or mutants checks');
      if (repeat) obs.runs = [];
      const excusable = await excusableQuarantine(ctx, job), quarantined = new Map<string, string>(), notApplied = new Set<string>();
      let passed = 0, allCompleted = true, allCountsOK = true;
      const failed = new Set<string>(), failureLogs: string[] = [];
      for (let index = 0; index < runs; index++) {
        if (ctx.signal?.aborted) throw new Error('aborted');
        const runStart = Date.now();
        if (repeat) capture(`\n=== run ${index + 1}/${runs} ===\n`);
        const raw = await command(spec.run, work.path, spec.timeout_s, spec.on_timeout); obs.exit = raw.code;
        // RO/SIG: matching consumes only frozen measurement output, never timeout diagnostics or later capture.
        measurementBytes = Buffer.concat([measurementBytes, Buffer.from(raw.measurementLog ?? raw.log)]);
        if (measurementBytes.length > LIMIT) measurementBytes = measurementBytes.subarray(measurementBytes.length - LIMIT);
        obs.note = undefined; obs.verdict = 'error';
        const warnings: string[] = [];
        obs.counts = parseCounts(raw.measurementLog ?? raw.log, note => { warnings.push(note); protocolWarnings++; });
        const named = obs.counts?.format === 'owed' ? obs.counts.failed ?? [] : failingNames(raw.measurementLog ?? raw.log);
        // MS4: a completed run whose only failing tests are active quarantine names counts as if they had not run.
        const verdict = quarantineExcuse(excusable, spec.run, raw, obs.counts, named, spec.min_tests), excused = verdict.excused;
        if (verdict.reason) notApplied.add(verdict.reason);
        if (excused) { for (const e of excused) quarantined.set(e.test, e.fix); obs.counts = withoutQuarantined(obs.counts!, excused); }
        const runFailed = excused ? [] : named, result = excused ? { ...raw, code: 0 } : raw;
        for (const name of runFailed) if (failed.size < 50) failed.add(name);
        if (runFailed.length) failureLogs.push(result.measurementLog ?? result.log);
        if (failed.size) obs.failed = [...failed];
        recordSignatures(obs, result.measurementLog ?? result.log, runFailed, tree);
        // IR2: facts about this run remain independent of failure names and display-note separators.
        const execution = { completed:false, countOK:false };
        try {
          // F2.1: a failed run whose output says the disk is full measured the environment, not the code.
          if (result.spawn) throw new EnvironmentError(`spawn failed: ${result.error}`);
          diskFull(result.code, obs.counts, result.measurementLog ?? result.log, `command exited ${result.code}`);
          if (result.error) throw new Error(result.error);
          execution.completed = result.code !== null;
          execution.countOK = obs.counts?.tests !== undefined && obs.counts.tests > 0 && (spec.min_tests === undefined || obs.counts.tests >= spec.min_tests);
          // min_tests applies to candidate and invariant runs, never to the red counterfactual.
          const red = job.kind === 'red';
          // D15.4: a red command that could not run is no counterfactual, even if red_expect matches.
          if (red && (result.code === 126 || result.code === 127)) throw new Error(`red run command could not run (exit ${result.code}: ${result.code === 126 ? 'not executable' : 'not found'})`);
          // E2.2: non-zero without a recognizable test is fail; 126/127 with no counts is error.
          const tail = (): string => { const t = lastLines(result.log); return `; last output:${t.length ? t.map(l => `\n  ${l}`).join('') : ' (none)'}`; };
          if (!red && (result.code === 126 || result.code === 127) && !obs.counts) throw new Error(`command could not run (exit ${result.code}: ${result.code === 126 ? 'not executable' : 'not found'})${tail()}`);
          if (!red && result.code !== 0 && (!obs.counts || obs.counts.tests === 0)) {
            obs.verdict = 'fail';
            obs.note = `command exited ${result.code} ${obs.counts ? 'after zero tests' : 'with no recognizable test count'}${tail()}`;
          } else {
            if (!red && spec.min_tests !== undefined && !obs.counts) throw new Error('unknown test count format with min_tests');
            const countOK = obs.counts?.tests !== 0 && (red || spec.min_tests === undefined || (obs.counts?.tests ?? 0) >= spec.min_tests);
            const exitOK = red ? result.code !== null && result.code !== 0 && (!spec.red_expect || new RegExp(spec.red_expect).test(result.log)) : result.code === 0;
            // RC2: owed-counts is the command's explicit verdict too; existing formats keep their exit semantics.
            obs.verdict = exitOK && countOK && (red || obs.counts?.format !== 'owed' || obs.counts.fail === 0) ? 'pass' : 'fail';
            if (!countOK) obs.note = red ? 'zero tests' : countNote(obs.counts, spec.min_tests, result.code);
          }
          // RC3: failed names first, followed by a bounded tail, for a failed command even if counts passed.
          if (obs.verdict === 'fail' && !obs.note) {
            const tail = lastLines(result.log, 15);
            obs.note = `command exited ${result.code}; last output:${tail.map(l => `\n  ${l}`).join('')}`;
          }
          if (obs.verdict === 'fail' && runFailed.length) {
            obs.note = `${failedTests(result.log, runFailed, tree)}${obs.note && !obs.note.includes('last output:') ? `; ${obs.note}` : ''}`;
          }
        } catch (e) {
          execution.completed = false;
          obs.note = `${e instanceof EnvironmentError ? ENVIRONMENT : ''}${e instanceof Error ? e.message : String(e)}`;
          throw e;
        } finally {
          allCompleted &&= execution.completed; allCountsOK &&= execution.countOK;
          if (job.kind !== 'red') obs.execution = { completed:allCompleted, countOK:allCountsOK };
          if (warnings.length) obs.note = `${obs.note ? `${obs.note}; ` : ''}${warnings.length} malformed owed-counts line(s) ignored`;
          if (repeat) {
            obs.runs!.push({ verdict: obs.verdict, exit: raw.code, counts: obs.counts, durationMs: Date.now() - runStart, log: await ctx.ledger.putBlob(result.log), ...(obs.note ? { note: obs.note } : {}), ...(runFailed.length ? { failed: runFailed } : {}), execution });
            obs.noisy = obs.runs!.some(r => r.verdict === 'pass') && obs.runs!.some(r => r.verdict === 'fail');
          }
        }
        if (obs.verdict === 'pass') passed++;
        if (passed >= need || passed + runs - index - 1 < need) {
          obs.verdict = passed >= need ? 'pass' : 'fail';
          if (repeat && obs.verdict === 'fail' && failed.size) {
            const reason = obs.note?.split('; last output:')[0]?.replace(/^failed tests: [^;]*;?\s*/, '');
            obs.note = `${failedTests(failureLogs.join('\n'), [...failed], tree)}${reason ? `; ${reason}` : ''}`;
          }
          break;
        }
      }
      if (obs.noisy) obs.note = `${obs.note ? `${obs.note}; ` : ''}noisy (${passed}/${obs.runs!.length} passed)`;
      if (quarantined.size) { obs.quarantined = [...quarantined.keys()]; obs.note = `${obs.note ? `${obs.note}; ` : ''}${quarantineNote(quarantined)}`; }
      if (notApplied.size) obs.note = `quarantine not applied: ${[...notApplied].join(', ')}${obs.note ? `; ${obs.note}` : ''}`;
    }
  } catch (e) { if (obs.execution) obs.execution.completed = false; obs.verdict = 'error'; obs.note = `${e instanceof EnvironmentError ? ENVIRONMENT : ''}${e instanceof Error ? e.message : String(e)}`; capture(`\n${obs.note}\n`); }
  finally {
    if (work) { try { await work.dispose(); } catch (e) { if (obs.execution) obs.execution.completed = false; obs.verdict = 'error'; obs.note = `worktree cleanup: ${String(e)}`; capture(obs.note); } }
  }
  if (timeoutNote) obs.note = timeoutNote;
  if (protocolWarnings && !obs.note?.includes('malformed owed-counts')) obs.note = `${obs.note ? `${obs.note}; ` : ''}${protocolWarnings} malformed owed-counts line(s) ignored`;
  obs.log = await ctx.ledger.putBlob(truncated ? Buffer.concat([Buffer.from('[output truncated; last 1 MiB]\n'), bytes]) : bytes);
  if (job.kind === 'inv' && obs.verdict === 'fail') {
    const matched = remeasureMatches(obs,measurementBytes.toString(),ctx.plan.invariants.find(i => i.id === job.spec?.id)?.remeasure_on ?? []);
    if (matched.length) obs.remeasure_match = matched;
  }
  obs.durationMs = Date.now() - start; return obs;
}
