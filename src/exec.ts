import { spawn } from 'node:child_process';
import { parse as parseYaml } from 'yaml';
import type { Plan, AttestJob, ObsEntry, Counts } from './types.ts';
import type { Ledger } from './ledger.ts';
import { git, materialize, overlay, mutantPaths } from './git.ts';
import { leaseEnvironment } from './lease.ts';

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
export interface ExecContext { cwd: string; plan: Plan; ledger: Ledger; signal?: AbortSignal; abortGraceMs?: number; onProgress?(msg: string): void }
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
export interface ErrorGroup { message: string; location?: string; names: string[] }
const stripAnsi = (text: string): string => text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '');
function errorMessage(text: string): string {
  const line = stripAnsi(text).replace(/\s+/g, ' ').replace(/;/g, ',').trim();
  return line.length > 160 ? `${line.slice(0, 159)}…` : line;
}
function errorLocation(text: string, cwd?: string): string | undefined {
  let location = text.trim().replace(/^file:\/\//, '').replace(/:(\d+):\d+$/, ':$1');
  if (location.startsWith('/')) {
    const prefix = cwd ? `${cwd.replace(/\/$/, '')}/` : undefined;
    location = prefix && location.startsWith(prefix) ? location.slice(prefix.length) : location.split('/').slice(-3).join('/');
  }
  return stripAnsi(location).replace(/\s+/g, ' ').replace(/;/g, ',').trim() || undefined;
}
/** Pure extraction with an explicit run directory for executor-only path shortening. */
function groupsAt(log: string, failed: readonly string[], cwd?: string): { groups: ErrorGroup[]; hasError: boolean } {
  const wanted = new Set(failed), points: { name: string; message?: string; location?: string; parent?: boolean; at: number }[] = [];
  const clean = stripAnsi(log).replace(/\r\n/g, '\n'), lines = clean.split('\n');
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
      const message = raw ? errorMessage(blockMessage ?? raw) : '';
      points.push({ name: point[1]!, ...(message ? { message } : {}), ...(typeof diagnostic.location === 'string' ? { location: errorLocation(diagnostic.location, cwd) } : {}), parent: diagnostic.failureType === 'subtestsFailed', at: offset });
    }
    offset += line.length + 1;
  }
  for (const m of clean.matchAll(/^thread '([^']+)' panicked at (.+):\r?\n([^\r\n]*)|^thread '([^']+)' panicked at '(.+)', (.+)\r?$/gm)) {
    const name = m[1] ?? m[4]!;
    if (!wanted.has(name)) continue;
    const message = errorMessage(m[3] ?? m[5]!);
    points.push({ name, ...(message ? { message } : {}), location: errorLocation(m[2] ?? m[6]!, cwd), at: m.index });
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
    } else groups.set(message, { message, ...(point.location ? { location: point.location } : {}), names: [point.name] });
  }
  return { groups: [...groups.values()].sort((a, b) => b.names.length - a.names.length), hasError: [...picked.values()].some(p => !!p.message) };
}
/** FG1: distinct errors, most common first, then first appearance; no ambient cwd or state. */
export function errorGroups(log: string, failed: readonly string[]): ErrorGroup[] { return groupsAt(log, failed).groups; }
function failedTests(log: string, failed: readonly string[], cwd: string): string {
  const { groups, hasError } = groupsAt(log, failed, cwd);
  if (!hasError) return `failed tests: ${failed.join(', ')}`;
  const errors = groups.slice(0, 3).map(g => `"${g.message}"${g.location ? ` (${g.location})` : ''} ×${g.names.length}`).join(' | ');
  const names = failed.slice(0, 3).map(n => stripAnsi(n).replace(/\s+/g, ' ').replace(/;/g, ',')).join(', ');
  return `failed tests: ${failed.length} failed, ${groups.length} distinct error(s): ${errors}${groups.length > 3 ? ` (+${groups.length - 3} more errors)` : ''} — ${names}${failed.length > 3 ? ` (+${failed.length - 3} more)` : ''}`;
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
export interface CommandResult { code: number | null; error?: string; log: string; spawn?: boolean }
/** Shared shell, environment, wrapper and process-group handling for measurements and slot setup. */
export async function runCommand(ctx: Pick<ExecContext, 'plan' | 'signal' | 'abortGraceMs'>, run: string, cwd: string, timeout: number, capture: (data: Buffer) => void = () => {}): Promise<CommandResult> {
  return new Promise(resolve => {
    let output = Buffer.alloc(0), error: string | undefined, spawnError = false;
    const inherited: NodeJS.ProcessEnv = { ...process.env };
    // Nested test runners and dsa call identities must not leak into child commands; DSA_HOME is configuration.
    delete inherited.NODE_TEST_CONTEXT;
    for (const name of Object.keys(inherited)) if (name.startsWith('DSA_') && name !== 'DSA_HOME') delete inherited[name];
    const env: NodeJS.ProcessEnv = { ...inherited, ...ctx.plan.exec?.env, CI: '1', OWED: '1', OWED_TREE: cwd, ...leaseEnvironment() };
    const argv = [...(ctx.plan.exec?.wrap ?? []), 'bash', '-lc', run];
    const p = spawn(argv[0]!, argv.slice(1), { cwd, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = (b: Buffer) => { capture(b); output = Buffer.concat([output, b]); if (output.length > LIMIT) output = output.subarray(output.length - LIMIT); };
    p.stdout.on('data', collect); p.stderr.on('data', collect);
    let escalation: NodeJS.Timeout | undefined;
    const kill = (sig: NodeJS.Signals = 'SIGKILL') => { if (p.pid) { try { process.kill(-p.pid, sig); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') error = String(e); } } };
    const abort = () => {
      error = 'aborted';
      if (ctx.abortGraceMs) { kill('SIGTERM'); escalation = setTimeout(() => kill(), ctx.abortGraceMs); }
      else kill();
    };
    const timer = setTimeout(() => { error = `timeout after ${timeout}s`; kill(); }, timeout * 1000);
    ctx.signal?.addEventListener('abort', abort, { once: true }); if (ctx.signal?.aborted) abort();
    p.on('error', e => { error = e.message; spawnError = true; });
    p.on('close', (code, signal) => {
      clearTimeout(timer); clearTimeout(escalation); ctx.signal?.removeEventListener('abort', abort); kill();
      resolve({ code, error: error ?? (signal ? `terminated by ${signal}` : undefined), log: output.toString(), ...(spawnError ? { spawn: true } : {}) });
    });
  });
}
export async function runJob(ctx: ExecContext, job: AttestJob): Promise<Omit<ObsEntry, 'seq' | 'ts' | 'prev' | 'hash'>> {
  const start = Date.now();
  const obs: Omit<ObsEntry, 'seq' | 'ts' | 'prev' | 'hash'> = { kind: 'obs', by: 'executor:owed', subject: job.subject, obligation: job.obligation, key: job.key, verdict: 'error', exit: null, durationMs: 0, commit: job.commit, base: job.base, attribution: job.attribution };
  let bytes = Buffer.alloc(0), truncated = false, protocolWarnings = 0;
  function capture(data: Buffer | string): void {
    bytes = Buffer.concat([bytes, Buffer.isBuffer(data) ? data : Buffer.from(data)]);
    if (bytes.length > LIMIT) { truncated = true; bytes = bytes.subarray(bytes.length - LIMIT); }
  }
  let work: Awaited<ReturnType<typeof materialize>> | undefined;
  // M2: with exec.trees reuse, every tree of this job is the check's reused tree (a failure to prepare it is a note).
  const reuse = ctx.plan.exec?.trees === 'reuse' && job.spec && job.kind !== 'writes' ? { kind: job.kind, id: job.spec.id, touch: ctx.plan.exec?.touch, note: (line: string) => capture(`${line}\n`) } : undefined;
  const command = (run: string, cwd: string, timeout: number): Promise<CommandResult> => runCommand(ctx, run, cwd, timeout, capture);
  try {
    ctx.onProgress?.(`${job.subject}: ${job.obligation}`);
    if (ctx.signal?.aborted) throw new Error('aborted');
    if (job.kind === 'writes') {
      const node = ctx.plan.nodes.find(n => n.id === job.subject); if (!node) throw new Error(`unknown node ${job.subject}`);
      const paths = (await git(ctx.cwd, ['diff', '--no-renames', '--name-only', '-z', job.base, job.commit])).stdout.split('\0').filter(Boolean);
      const bad = paths.filter(p => !node.writes.some(prefix => p.startsWith(prefix)));
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
          const result = await command(spec.run, work.path, spec.timeout_s), counts = parseCounts(result.log, () => { protocolWarnings++; });
          if (result.spawn) throw new EnvironmentError(`spawn failed: ${result.error}`);
          diskFull(result.code, counts, result.log, `mutant ${path} run exited ${result.code}`);
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
      let passed = 0, allCompleted = true, allCountsOK = true;
      const failed = new Set<string>(), failureLogs: string[] = [];
      for (let index = 0; index < runs; index++) {
        if (ctx.signal?.aborted) throw new Error('aborted');
        const runStart = Date.now();
        if (repeat) capture(`\n=== run ${index + 1}/${runs} ===\n`);
        const result = await command(spec.run, work.path, spec.timeout_s); obs.exit = result.code;
        obs.note = undefined; obs.verdict = 'error';
        const warnings: string[] = [];
        obs.counts = parseCounts(result.log, note => { warnings.push(note); protocolWarnings++; });
        const runFailed = obs.counts?.format === 'owed' ? obs.counts.failed ?? [] : failingNames(result.log);
        for (const name of runFailed) if (failed.size < 50) failed.add(name);
        if (runFailed.length) failureLogs.push(result.log);
        if (failed.size) obs.failed = [...failed];
        // IR2: facts about this run remain independent of failure names and display-note separators.
        const execution = { completed:false, countOK:false };
        try {
          // F2.1: a failed run whose output says the disk is full measured the environment, not the code.
          if (result.spawn) throw new EnvironmentError(`spawn failed: ${result.error}`);
          diskFull(result.code, obs.counts, result.log, `command exited ${result.code}`);
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
            const tail = lastLines(result.log, 15);
            obs.note = `${failedTests(result.log, runFailed, tree)}${obs.note && !obs.note.includes('last output:') ? `; ${obs.note}` : ''}; last output:${tail.map(l => `\n  ${l}`).join('')}`;
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
            obs.runs!.push({ verdict: obs.verdict, exit: result.code, counts: obs.counts, durationMs: Date.now() - runStart, log: await ctx.ledger.putBlob(result.log), ...(obs.note ? { note: obs.note } : {}), ...(runFailed.length ? { failed: runFailed } : {}), execution });
            obs.noisy = obs.runs!.some(r => r.verdict === 'pass') && obs.runs!.some(r => r.verdict === 'fail');
          }
        }
        if (obs.verdict === 'pass') passed++;
        if (passed >= need || passed + runs - index - 1 < need) {
          obs.verdict = passed >= need ? 'pass' : 'fail';
          if (repeat && obs.verdict === 'fail' && failed.size) {
            const tail = lastLines(result.log, 15);
            const reason = obs.note?.split('; last output:')[0]?.replace(/^failed tests: [^;]*;?\s*/, '');
            obs.note = `${failedTests(failureLogs.join('\n'), [...failed], tree)}${reason ? `; ${reason}` : ''}; last output:${tail.map(l => `\n  ${l}`).join('')}`;
          }
          break;
        }
      }
      if (obs.noisy) obs.note = `${obs.note ? `${obs.note}; ` : ''}noisy (${passed}/${obs.runs!.length} passed)`;
    }
  } catch (e) { if (obs.execution) obs.execution.completed = false; obs.verdict = 'error'; obs.note = `${e instanceof EnvironmentError ? ENVIRONMENT : ''}${e instanceof Error ? e.message : String(e)}`; capture(`\n${obs.note}\n`); }
  finally {
    if (work) { try { await work.dispose(); } catch (e) { if (obs.execution) obs.execution.completed = false; obs.verdict = 'error'; obs.note = `worktree cleanup: ${String(e)}`; capture(obs.note); } }
  }
  if (protocolWarnings && !obs.note?.includes('malformed owed-counts')) obs.note = `${obs.note ? `${obs.note}; ` : ''}${protocolWarnings} malformed owed-counts line(s) ignored`;
  obs.log = await ctx.ledger.putBlob(truncated ? Buffer.concat([Buffer.from('[output truncated; last 1 MiB]\n'), bytes]) : bytes);
  obs.durationMs = Date.now() - start; return obs;
}
