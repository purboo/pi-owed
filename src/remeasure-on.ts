import { parse } from 'yaml';
import { errorGroups, lastLines } from './exec.ts';
import type { ObsEntry } from './types.ts';

/** RO2: match error text, never a test title or a passing-output tail when failures were parsed. */
export function matchesRemeasureOn(obs: Pick<ObsEntry, 'verdict' | 'failed' | 'counts'>, log: string, needles: readonly string[]): boolean {
  if (obs.verdict !== 'fail' || !needles.length) return false;
  const names = obs.failed ?? [];
  if (!names.length) return lastLines(log, 20).some(line => needles.some(n => line.includes(n)));
  // The executor caps names at 50. An incomplete list cannot prove EVERY failure matched.
  if ((obs.counts?.fail ?? names.length) > names.length) return false;
  const groups = errorGroups(log, names);
  return names.every(name => {
    const group = groups.find(g => g.names.includes(name));
    if (!group || group.message === '(no error text)') return false;
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
    return needles.some(n => text.includes(n));
  });
}
