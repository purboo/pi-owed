import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256 } from './canon.ts';
import { OwedError } from './errors.ts';
import { repoRoot, revParse, readBlobAt } from './git.ts';
import { assertNoLedgerLock } from './lock-context.ts';
import type { Ledger } from './ledger.ts';
import type { Plan } from './types.ts';

/** RF2: admission only, before recording locks; replay consumes the plan and never its source files. */
export async function admitPlan(cwd: string, ledger: Ledger, plan: Plan, rev?: string): Promise<void> {
  assertNoLedgerLock();
  const checks = [...plan.nodes.flatMap(n => n.checks.map(c => ({ label:`${n.id}/${c.id}`, spec:c }))), ...plan.invariants.map(c => ({ label:`inv:${c.id}`, spec:c }))].filter(c => c.spec.run_file);
  if (!checks.length) return;
  const source = rev === undefined ? await repoRoot(cwd) : await revParse(cwd,rev);
  for (const { label, spec } of checks) {
    const file = spec.run_file!;
    try { await stat(join(ledger.dir,'blobs',file.sha256)); continue; }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    let data: Buffer | undefined;
    if (rev !== undefined) data = await readBlobAt(cwd,source,file.path);
    else try { data = await readFile(join(source,file.path)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT' && (e as NodeJS.ErrnoException).code !== 'ENOTDIR') throw e; }
    const labelText = `run_file ${file.path} of check ${label}`;
    if (data === undefined) throw new OwedError(`${labelText}: not found in ${source}`,'usage');
    const actual = sha256(data);
    if (actual !== file.sha256) throw new OwedError(`${labelText}: sha256 ${actual}, the plan says ${file.sha256}`,'usage');
    await ledger.putBlob(data);
  }
}

/** RF5: the existing reply warnings channel also carries descriptive check lines. */
export function runFileLines(plan: Plan): string[] {
  const line = (label: string, c: Plan['invariants'][number]) => c.run_file ? [`check ${label}: run_file ${c.run_file.path} (sha256 ${c.run_file.sha256.slice(0,12)})`] : [];
  return [...plan.nodes.flatMap(n => n.checks.flatMap(c => line(`${n.id}/${c.id}`,c))), ...plan.invariants.flatMap(c => line(`inv:${c.id}`,c))];
}
