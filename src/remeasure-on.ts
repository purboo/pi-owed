import { parse } from 'yaml';
import { errorGroups } from './exec.ts';
import type { ObsEntry } from './types.ts';

/** RO2: match error text, never a test title or a passing-output tail when failures were parsed. */
export function matchesRemeasureOn(obs: Pick<ObsEntry, 'verdict' | 'failed' | 'counts'>, log: string, needles: readonly string[]): boolean {
  return remeasureMatches(obs,log,needles).length > 0;
}
/** Bounded provenance: only configured literals, and only when EVERY failure matched. */
export function remeasureMatches(obs: Pick<ObsEntry, 'verdict' | 'failed' | 'counts'>, log: string, needles: readonly string[]): string[] {
  const texts = remeasureErrorTexts(obs,log);
  if (!texts.length || !needles.length || !texts.every(text => needles.some(n => text.includes(n)))) return [];
  return [...new Set(needles.filter(n => texts.some(text => text.includes(n))))];
}
/** Measurement-only raw text; never persisted in the ledger. */
export function remeasureErrorTexts(obs: Pick<ObsEntry, 'verdict' | 'failed' | 'counts'>, log: string): string[] {
  if (obs.verdict !== 'fail') return [];
  const names = obs.failed ?? [];
  if (!names.length) return [log];
  // The executor caps names at 50. An incomplete list cannot prove EVERY failure matched.
  if ((obs.counts?.fail ?? names.length) > names.length) return [];
  const groups = errorGroups(log, names, true);
  const texts = names.map(name => {
    const group = groups.find(g => g.names.includes(name));
    if (!group || group.message === '(no error text)') return undefined;
    let text = group.message;
    // SG4's expected/actual quote is error text too. Read the diagnostic belonging to this exact TAP name.
    for (const block of log.split(/(?=^\s*not ok \d+ - )/m)) {
      const title = /^\s*not ok \d+ - (.+?)\s*$/m.exec(block)?.[1];
      if (title !== name) continue;
      const yaml = /^\s*---\s*\n([\s\S]*?)^\s*\.\.\.\s*$/m.exec(block)?.[1];
      if (!yaml) continue;
      try {
        const d = parse(yaml) as Record<string, unknown>;
        if (d && Object.hasOwn(d, 'expected') && Object.hasOwn(d, 'actual')) text += ` expected ${String(d.expected)}, actual ${String(d.actual)}`;
      } catch { /* Unparseable diagnostics never supply a match. */ }
    }
    return text;
  });
  return texts.some(text => text === undefined) ? [] : texts as string[];
}
