import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { parse } from 'yaml';
import { OwedError } from './errors.ts';
import type { Plan, CheckSpec } from './types.ts';
import { canonical } from './canon.ts';
import { expandWrap } from './exec-wrap.ts';
import { git } from './git.ts';
import { matchesAny } from './plan.ts';
import { nearTimeoutWarnings } from './cost.ts';
import type { Entry } from './types.ts';

/** WF4: stable check identity, and only measurement-affecting admission fields. */
export function planCheckChanged(next: CheckSpec, prior?: CheckSpec): boolean {
  return !prior || next.run !== prior.run || canonical(next.reads) !== canonical(prior.reads) || next.timeout_s !== prior.timeout_s;
}
/** CO2/CO3: admission diagnostics only; a report still shows all measured cost. */
export async function lintPlanCost(cwd: string, plan: Plan, commit: string, entries: readonly Entry[] = [], prior?: Plan): Promise<string[]> {
  const paths = (await git(cwd, ['ls-tree', '-rz', '--name-only', commit])).stdout.split('\0').filter(Boolean), warnings: string[] = [];
  const coverage = (id: string, reads: string[]) => {
    const n = paths.filter(p => matchesAny(p, reads)).length;
    const percent = paths.length ? n * 100 / paths.length : reads.includes('**') ? 100 : 0;
    if (reads.includes('**') || percent >= 90) warnings.push(`reads of ${id} cover ${Math.round(percent * 10) / 10}% of the repository: almost every change remeasures it (owed report --cost)`);
  };
  for (const inv of plan.invariants) if (planCheckChanged(inv,prior?.invariants.find(i => i.id === inv.id))) coverage(`inv:${inv.id}`, inv.reads);
  const closure = [...new Set([...paths.filter(p => matchesAny(p, plan.closure)), ...plan.closure.filter(p => !/[?*\[\]{}]/.test(p))])].sort();
  for (const node of plan.nodes) for (const check of node.checks) {
    const old = prior?.nodes.find(n => n.id === node.id)?.checks.find(c => c.id === check.id);
    if (planCheckChanged(check,old)) coverage(`check:${check.id}`, check.reads);
    const path = !old || canonical(old.reads) !== canonical(check.reads) || canonical(prior?.closure) !== canonical(plan.closure) ? closure.find(p => matchesAny(p, check.reads)) : undefined;
    if (path) warnings.push(`check ${check.id} reads closure path ${path}: checks see the base version of closure files`);
  }
  const sets = Object.keys(plan.quarantine_sets ?? {}).sort();
  const quarantineWarning = (where: string, check: CheckSpec, old?: CheckSpec): void => {
    if (sets.length && planCheckChanged(check, old) && /\bcargo\s+(?:\+\S+\s+)?test\b|\bnode\s+--test\b/.test(check.run) && check.quarantine === undefined && check.quarantine_set === undefined) warnings.push(`${where} runs tests without a quarantine set (sets: ${sets.join(', ')})`);
  };
  for (const inv of plan.invariants) quarantineWarning(`inv:${inv.id}`, inv, prior?.invariants.find(i => i.id === inv.id));
  for (const node of plan.nodes) for (const check of node.checks) quarantineWarning(`check ${node.id}/${check.id}`, check, prior?.nodes.find(n => n.id === node.id)?.checks.find(c => c.id === check.id));
  const law = entries.findLast(e => e.kind === 'plan' || e.kind === 'genesis');
  const previous = new Set(prior ? nearTimeoutWarnings(prior,law ? entries.filter(e => e.seq < law.seq) : []) : []);
  return [...new Set([...warnings, ...nearTimeoutWarnings(plan, entries).filter(w => !previous.has(w))])].map(w => `warning: ${w}`);
}

type Word = { value: string; literal: boolean; reserved: boolean; assignment: boolean };
/** PL1: read shell words, not shell expansions. Quoted data is never treated as a command. */
function shellCommands(script: string): Word[][] {
  const commands: Word[][] = []; let words: Word[] = [], value = '', literal = true, started = false, reserved = true, assignment = false;
  let quote = '', here: string[] = [], wantHere = false, stripTabs = false, subshells = 0;
  const word = () => {
    if (!started) return;
    words.push({ value, literal, reserved, assignment });
    if (wantHere) { here.push((stripTabs ? '\t' : '') + value); wantHere = false; }
    value = ''; literal = true; started = false; reserved = true; assignment = false;
  };
  const command = () => { word(); if (words.length) commands.push(words); words = []; };
  for (let i = 0; i < script.length; i++) {
    const c = script[i]!;
    if (quote === "'") { if (c === "'") quote = ''; else value += c; continue; }
    if (c === '\\') {
      reserved = false;
      const next = script[i + 1];
      if (next === '\n') { i++; continue; }
      if (next !== undefined && (!quote || /[$`"\\]/.test(next))) { value += next; started = true; i++; continue; }
      value += c; started = true; continue;
    }
    if (quote === '"') { if (c === '"') quote = ''; else { value += c; if (c === '$' || c === '`') literal = false; } continue; }
    if (c === "'" || c === '"') { quote = c; started = true; reserved = false; continue; }
    if (c === '#' && !started) { while (i + 1 < script.length && script[i + 1] !== '\n') i++; continue; }
    if (c === '\n') {
      command();
      for (const delimiter of here) {
        const tabs = delimiter.startsWith('\t'), end = tabs ? delimiter.slice(1) : delimiter;
        while (i + 1 < script.length) {
          const start = i + 1, newline = script.indexOf('\n', start), stop = newline < 0 ? script.length : newline;
          const line = script.slice(start, stop); i = stop;
          if ((tabs ? line.replace(/^\t+/, '') : line) === end) break;
        }
      }
      here = []; continue;
    }
    if (/\s/.test(c)) { word(); continue; }
    if (';|&'.includes(c)) { command(); continue; }
    // Only an unambiguous leading parenthesis introduces a subshell here.
    // Argument/expansion parentheses and brace characters never split commands.
    if (c === '(' && !started && !words.length) { subshells++; continue; }
    if (c === ')' && subshells > 0) { command(); subshells--; continue; }
    if (c === '<' && script[i + 1] === '<' && script[i + 2] !== '<') {
      word(); wantHere = true; stripTabs = script[i + 2] === '-'; i += stripTabs ? 2 : 1; continue;
    }
    // Recognize the unquoted NAME= prefix before decoding its value. Quotes or
    // expansions in the value do not turn an assignment into a command word.
    if (c === '=' && reserved && /^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) assignment = true;
    started = true; value += c; if (c === '$' || c === '`') literal = false;
  }
  command(); return commands;
}
/** Only a statically known command name and -c/-lc script qualify; do not evaluate substitutions. */
function nestedBash(script: string): string[] {
  const out: string[] = [];
  for (const words of shellCommands(script)) {
    let i = 0;
    while (words[i] && (words[i]!.assignment ||
      (words[i]!.reserved && ['if', 'then', 'elif', 'else', 'while', 'until', 'do', '!', '{', 'time'].includes(words[i]!.value)) ||
      (words[i]!.literal && ['env', 'command', 'exec'].includes(words[i]!.value)))) i++;
    if (!words[i]?.literal || !['bash', 'sh'].includes(basename(words[i]!.value))) continue;
    for (i++; i < words.length; i++) {
      const option = words[i]!;
      if (!option.literal || !option.value.startsWith('-')) break;
      if (/^-[a-zA-Z]*c[a-zA-Z]*$/.test(option.value)) {
        const argument = words[i + 1]; if (argument?.literal) out.push(argument.value); break;
      }
    }
  }
  return out;
}
/** Collect expanded runs by stable node/check identity. Diagnostics also work before SG's parser lands. */
function planRuns(plan: Plan, text?: string): Map<string, string> {
  const runs = new Map<string, string>();
  if (typeof plan.exec?.wrap === 'string') runs.set('plan/exec.wrap', expandWrap(plan.exec.wrap, '/owed tree', 30, 'true'));
  for (const node of plan.nodes) for (const check of node.checks) if (!check.run_file) runs.set(`${node.id}/${check.id}`, check.run);
  for (const inv of plan.invariants) if (!inv.run_file) runs.set(`inv:${inv.id}/run`, inv.run);
  if (plan.sweep) runs.set('plan/sweep', plan.sweep.run);
  if (plan.setup !== undefined) runs.set('plan/setup', plan.setup);
  if (typeof plan.slot_setup === 'string') runs.set('plan/slot_setup', plan.slot_setup);
  // on_timeout belongs to SG; use the source mapping as well as parsed specs so lint does not drop it.
  const raw = (text === undefined ? plan : parse(text)) as { invariants?: unknown; nodes?: Array<{ id: string; checks?: unknown }> };
  const diagnostics = (checks: unknown, prefix: string) => {
    if (!Array.isArray(checks)) return;
    for (const check of checks) if (check && typeof check === 'object' && typeof check.on_timeout === 'string') runs.set(`${prefix}${check.id}/on_timeout`, check.on_timeout);
  };
  diagnostics(raw.invariants, 'inv:');
  if (Array.isArray(raw.nodes)) for (const node of raw.nodes) diagnostics(node.checks, `${node.id}/`);
  return runs;
}
/** PL: admission only, never replay; bash -n reads stdin and executes no setup/check/diagnostic. */
export function lintPlanShell(next: Plan, prior?: Plan, text?: string, priorText?: string): string[] {
  const old = prior ? planRuns(prior,priorText) : new Map<string, string>();
  for (const [label, run] of planRuns(next, text)) {
    const inv = next.invariants.find(i => label === `inv:${i.id}/run`);
    const node = next.nodes.find(n => n.checks.some(c => label === `${n.id}/${c.id}`));
    const check = node?.checks.find(c => label === `${node.id}/${c.id}`);
    const changed = inv ? planCheckChanged(inv,prior?.invariants.find(i => i.id === inv.id)) : check ? planCheckChanged(check,prior?.nodes.find(n => n.id === node!.id)?.checks.find(c => c.id === check.id)) : false;
    if (old.get(label) === run && !changed) continue;
    const pending = [run], seen = new Set<string>();
    while (pending.length) {
      const script = pending.pop()!; if (seen.has(script)) continue; seen.add(script);
      const result = spawnSync('bash', ['--noprofile', '--norc', '-n'], { input: script, encoding: 'utf8', timeout: 5000, maxBuffer: 256 * 1024, env: { ...process.env, BASH_ENV: '', ENV: '', LC_ALL: 'C' } });
      if (result.error && (result.error as NodeJS.ErrnoException).code === 'ENOENT') return ['warning: bash is missing; shell syntax was not checked; install bash and record the plan again'];
      if (result.error || result.status !== 0) {
        const first = (result.stderr || result.error?.message || `exit ${result.status}`).trim().split('\n')[0];
        throw new OwedError(`${label}: bash -n: ${first}; fix the command and retry`, 'usage');
      }
      pending.push(...nestedBash(script));
    }
  }
  return [];
}
