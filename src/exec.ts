import { spawn } from 'node:child_process';
import type { Plan, AttestJob, ObsEntry, Counts } from './types.ts';
import type { Ledger } from './ledger.ts';
import { git, materialize, overlay, mutantPaths } from './git.ts';

export interface ExecContext { cwd: string; plan: Plan; ledger: Ledger; signal?: AbortSignal; onProgress?(msg: string): void }
function tapCounts(log: string): Counts | undefined {
  const tap: Counts = { format: 'tap' };
  for (const m of log.matchAll(/^\s*(?:#|ℹ)\s*(tests|pass|fail|skip|skipped)\s+(\d+)\s*$/gm)) {
    const key = m[1] === 'skipped' ? 'skip' : m[1] as 'tests' | 'pass' | 'fail' | 'skip'; tap[key] = Number(m[2]);
  }
  if (Object.keys(tap).length > 1) { tap.tests ??= (tap.pass ?? 0) + (tap.fail ?? 0) + (tap.skip ?? 0); return tap; }
  const tapPlan = [...log.matchAll(/^1\.\.(\d+)(?:\s+#.*)?\s*$/gm)].at(-1);
  return tapPlan ? { format: 'tap', tests: Number(tapPlan[1]) } : undefined;
}
function cargoCounts(log: string): Counts | undefined {
  const cargo = [...log.matchAll(/test result: (?:ok|FAILED)\. (\d+) passed; (\d+) failed; (\d+) ignored/g)];
  return cargo.length ? cargo.reduce<Counts>((c, m) => ({ format: 'cargo', tests: (c.tests ?? 0) + Number(m[1]) + Number(m[2]) + Number(m[3]), pass: (c.pass ?? 0) + Number(m[1]), fail: (c.fail ?? 0) + Number(m[2]), skip: (c.skip ?? 0) + Number(m[3]) }), {}) : undefined;
}
export function parseCounts(log: string): Counts | undefined {
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
const LIMIT = 1024 * 1024;
/** E2.2: the last `n` non-empty output lines (ANSI colour removed, trailing blanks trimmed), each at most 200 characters. */
export function lastLines(log: string, n = 5): string[] {
  return log.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '').split(/\r?\n|\r/).map(l => l.trimEnd()).filter(l => l.trim()).slice(-n).map(l => l.slice(0, 200));
}
export async function runJob(ctx: ExecContext, job: AttestJob): Promise<Omit<ObsEntry, 'seq' | 'ts' | 'prev' | 'hash'>> {
  const start = Date.now();
  const obs: Omit<ObsEntry, 'seq' | 'ts' | 'prev' | 'hash'> = { kind: 'obs', by: 'executor:owed', subject: job.subject, obligation: job.obligation, key: job.key, verdict: 'error', exit: null, durationMs: 0, commit: job.commit, base: job.base, attribution: job.attribution };
  let bytes = Buffer.alloc(0), truncated = false;
  function capture(data: Buffer | string): void {
    bytes = Buffer.concat([bytes, Buffer.isBuffer(data) ? data : Buffer.from(data)]);
    if (bytes.length > LIMIT) { truncated = true; bytes = bytes.subarray(bytes.length - LIMIT); }
  }
  let work: Awaited<ReturnType<typeof materialize>> | undefined;
  async function command(run: string, cwd: string, timeout: number): Promise<{ code: number | null; error?: string; log: string }> {
    return new Promise(resolve => {
      let output = Buffer.alloc(0), error: string | undefined;
      const inherited: NodeJS.ProcessEnv = { ...process.env };
      // A nested Node test runner must not inherit the parent's IPC/reporting mode.
      delete inherited.NODE_TEST_CONTEXT;
      // E2.3: no dsa identity (DSA_CALL, DSA_EXEC, DSA_SESSION, …) leaks into a check, so owed commands inside it are not
      // refused as subagent acts; a variable the plan's exec.env sets explicitly still applies.
      for (const name of Object.keys(inherited)) if (name.startsWith('DSA_')) delete inherited[name];
      // D20: the plan's exec.env over the inherited environment, CI/OWED last; the wrapper argv prefixes bash -lc.
      const env: NodeJS.ProcessEnv = { ...inherited, ...ctx.plan.exec?.env, CI: '1', OWED: '1' };
      const argv = [...(ctx.plan.exec?.wrap ?? []), 'bash', '-lc', run];
      const p = spawn(argv[0]!, argv.slice(1), { cwd, detached: true, env, stdio: ['ignore', 'pipe', 'pipe'] });
      const collect = (b: Buffer) => { capture(b); output = Buffer.concat([output, b]); if (output.length > LIMIT) output = output.subarray(output.length - LIMIT); };
      p.stdout.on('data', collect); p.stderr.on('data', collect);
      const kill = () => { if (p.pid) { try { process.kill(-p.pid, 'SIGKILL'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') error = String(e); } } };
      const abort = () => { error = 'aborted'; kill(); };
      const timer = setTimeout(() => { error = `timeout after ${timeout}s`; kill(); }, timeout * 1000);
      ctx.signal?.addEventListener('abort', abort, { once: true }); if (ctx.signal?.aborted) abort();
      p.on('error', e => { error = e.message; });
      p.on('close', (code, signal) => {
        clearTimeout(timer); ctx.signal?.removeEventListener('abort', abort); kill();
        resolve({ code, error: error ?? (signal ? `terminated by ${signal}` : undefined), log: output.toString() });
      });
    });
  }
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
        work = await materialize(ctx.cwd, job.commit);
        try {
          await overlay(ctx.cwd, work.path, job.base, ctx.plan.closure, 'replace');
          const applied = await git(work.path, ['apply', '--whitespace=nowarn', '-'], { input: patch, allowFail: true });
          if (applied.code) { capture(applied.stderr); results.push(`survived ${path}: patch does not apply: ${applied.stderr.trim().split('\n')[0] ?? ''}`); continue; }
          if (ctx.plan.setup) {
            const setup = await command(ctx.plan.setup, work.path, spec.timeout_s);
            if (setup.error || setup.code !== 0) throw new Error(`setup failed: ${setup.error ?? setup.code}`);
          }
          const result = await command(spec.run, work.path, spec.timeout_s), counts = parseCounts(result.log);
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
      const spec = job.spec; if (!spec) throw new Error('missing check spec');
      work = await materialize(ctx.cwd, job.kind === 'red' ? job.base : job.commit);
      if (job.kind === 'red') await overlay(ctx.cwd, work.path, job.commit, spec.tests ?? [], 'add');
      await overlay(ctx.cwd, work.path, job.kind === 'inv' ? job.commit : job.base, ctx.plan.closure, 'replace');
      if (ctx.plan.setup) {
        const setup = await command(ctx.plan.setup, work.path, spec.timeout_s);
        if (setup.error || setup.code !== 0) { obs.exit = setup.code; throw new Error(`setup failed: ${setup.error ?? setup.code}`); }
      }
      const result = await command(spec.run, work.path, spec.timeout_s); obs.exit = result.code;
      obs.counts = parseCounts(result.log);
      if (result.error) throw new Error(result.error);
      // min_tests applies to every non-red run (candidate and invariant runs): on the base tree a new test file often cannot load
      // (missing module/export), so the runner reports a single failing test; a red run needs only a
      // recognizable failure (non-zero exit, red_expect match, not a known-format zero-test run).
      const red = job.kind === 'red';
      // A red run must fail as a test, not because the command could not run: bash (or the exec.wrap wrapper, D20) exits 126 (not executable) or 127
      // (not found), which red_expect may still match. That is no counterfactual: error, not pass (D15.4).
      if (red && (result.code === 126 || result.code === 127)) throw new Error(`red run command could not run (exit ${result.code}: ${result.code === 126 ? 'not executable' : 'not found'})`);
      // E2.2: a non-red command that exits non-zero without running a recognizable test (unknown count or zero) is a
      // failed command, not an unparseable log: fail, with its last output lines as the note.
      if (!red && result.code !== 0 && (!obs.counts || obs.counts.tests === 0)) {
        const tail = lastLines(result.log);
        obs.verdict = 'fail';
        obs.note = `command exited ${result.code} ${obs.counts ? 'after zero tests' : 'with no recognizable test count'}; last output:${tail.length ? tail.map(l => `\n  ${l}`).join('') : ' (none)'}`;
      } else {
        if (!red && spec.min_tests !== undefined && !obs.counts) throw new Error('unknown test count format with min_tests');
        const countOK = obs.counts?.tests !== 0 && (red || spec.min_tests === undefined || (obs.counts?.tests ?? 0) >= spec.min_tests);
        obs.verdict = (red ? result.code !== null && result.code !== 0 && (!spec.red_expect || new RegExp(spec.red_expect).test(result.log)) : result.code === 0) && countOK ? 'pass' : 'fail';
        if (!countOK) obs.note = red ? 'zero tests' : 'zero tests or min_tests unmet';
      }
    }
  } catch (e) { obs.verdict = 'error'; obs.note = e instanceof Error ? e.message : String(e); capture(`\n${obs.note}\n`); }
  finally {
    if (work) { try { await work.dispose(); } catch (e) { obs.verdict = 'error'; obs.note = `worktree cleanup: ${String(e)}`; capture(obs.note); } }
  }
  obs.log = await ctx.ledger.putBlob(truncated ? Buffer.concat([Buffer.from('[output truncated; last 1 MiB]\n'), bytes]) : bytes);
  obs.durationMs = Date.now() - start; return obs;
}
