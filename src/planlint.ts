import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';
import { parse } from 'yaml';
import { OwedError } from './errors.ts';
import type { Plan } from './types.ts';

type Word = { value: string; literal: boolean };
/** PL1: read shell words, not shell expansions. Quoted data is never treated as a command. */
function shellCommands(script: string): Word[][] {
  const commands: Word[][] = []; let words: Word[] = [], value = '', literal = true, started = false;
  let quote = '', here: string[] = [], wantHere = false, stripTabs = false;
  const word = () => {
    if (!started) return;
    words.push({ value, literal });
    if (wantHere) { here.push((stripTabs ? '\t' : '') + value); wantHere = false; }
    value = ''; literal = true; started = false;
  };
  const command = () => { word(); if (words.length) commands.push(words); words = []; };
  for (let i = 0; i < script.length; i++) {
    const c = script[i]!;
    if (quote === "'") { if (c === "'") quote = ''; else value += c; continue; }
    if (c === '\\') {
      const next = script[i + 1];
      if (next === '\n') { i++; continue; }
      if (next !== undefined && (!quote || /[$`"\\]/.test(next))) { value += next; started = true; i++; continue; }
      value += c; started = true; continue;
    }
    if (quote === '"') { if (c === '"') quote = ''; else { value += c; if (c === '$' || c === '`') literal = false; } continue; }
    if (c === "'" || c === '"') { quote = c; started = true; continue; }
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
    if (';|&(){}'.includes(c)) { command(); continue; }
    if (c === '<' && script[i + 1] === '<' && script[i + 2] !== '<') {
      word(); wantHere = true; stripTabs = script[i + 2] === '-'; i += stripTabs ? 2 : 1; continue;
    }
    started = true; value += c; if (c === '$' || c === '`') literal = false;
  }
  command(); return commands;
}
/** Only a statically known command name and -c/-lc script qualify; do not evaluate substitutions. */
function nestedBash(script: string): string[] {
  const out: string[] = [];
  for (const words of shellCommands(script)) {
    let i = 0;
    while (words[i] && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]!.value) || ['if', 'then', 'elif', 'else', 'while', 'until', 'do', '!', 'env', 'command', 'exec', 'sudo'].includes(words[i]!.value))) i++;
    if (!words[i]?.literal || basename(words[i]!.value) !== 'bash') continue;
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
  for (const node of plan.nodes) for (const check of node.checks) runs.set(`${node.id}/${check.id}`, check.run);
  for (const inv of plan.invariants) runs.set(`inv:${inv.id}/run`, inv.run);
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
    if (old.get(label) === run) continue;
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
