import { parse } from 'yaml';
import { errorGroups, zeroTestFallbackLine } from './exec.ts';
import type { ObsEntry } from './types.ts';

/** IF3/IF4: diagnostic only; normalize volatile identifiers, never use this text to discharge a gate. */
export function setupSignature(log: string): string {
  const counted = zeroTestFallbackLine(log);
  const lines = log.replace(/\x1b\[[0-9;]*m/g,'').split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const line = counted?.line ?? lines.find(l => /Error|Cannot find|ENOENT|ERR_|not found/i.test(l)) ?? lines.at(-1) ?? '(no output)';
  const normalized = line.replace(/\b\d{4}-\d{2}-\d{2}[T ][\d:.]+(?:Z|[+-]\d{2}:?\d{2})?/g,'<time>')
    .replace(/(?:[A-Za-z]:[\\/]|\/)[^\s'"`,;:)\]}]+/g,'<path>')
    .replace(/\b(?:0x[0-9a-f]+|[0-9a-f]{7,})\b/gi,'<id>').replace(/\d+(?:\.\d+)?/g,'<n>')
    .replace(/\s+/g,' ');
  // Normalize the full raw line before quoting; the fixed parser prefix is not a path.
  return (counted ? `${counted.format} fallback counted line ${JSON.stringify(normalized)}` : normalized).slice(0,300);
}
export const setupHint = (signature: string, nodes: string): string => `setup failure (no tests ran): ${signature} — likely the environment; fix it, then owed decide ${nodes} --remeasure`;

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
    if (!group || group.missingError) return undefined;
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
