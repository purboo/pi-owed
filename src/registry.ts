// FW2: best-effort runtime discovery; never part of the ledger or a driver gate.
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startingSession } from './dsa.ts';
import { procStart } from './drive-run.ts';
import type { LockOwner } from './drive-run.ts';

export interface DriverRegistration { repo: string; pid: number; start?: string; session?: string; at: string }
const registryDir = (): string => join(process.env.XDG_STATE_HOME || join(homedir(), '.local/state'), 'owed', 'drivers');
const registryPath = (repo: string): string => join(registryDir(), `${createHash('sha256').update(repo).digest('hex').slice(0, 16)}.json`);
/** R-031-FW-1: preserve DSA_SESSION semantics; PI_SESSION_ID is only the fallback outside calls. */
export function driverSession(): string | undefined {
  return startingSession() ?? (!process.env.DSA_CALL && !process.env.DSA_EXEC ? process.env.PI_SESSION_ID || undefined : undefined);
}
/** Called only after acquiring the lock; release checks exact bytes so an old owner cannot remove its successor. */
export function registerDriver(repo: string, owner: LockOwner): () => void {
  const path = registryPath(repo), tmp = `${path}.${randomUUID()}.tmp`, session = owner.session ?? driverSession();
  const text = JSON.stringify({ repo, pid: owner.pid, start: owner.start, at: owner.at, ...(session ? { session } : {}) });
  try { mkdirSync(registryDir(), { recursive: true }); writeFileSync(tmp, text); renameSync(tmp, path); }
  catch { try { rmSync(tmp, { force: true }); } catch { /* discovery is optional */ } }
  return () => { try { if (readFileSync(path, 'utf8') === text) rmSync(path, { force: true }); } catch { /* gone or unavailable */ } };
}
/** Same liveness rules as the lock, without requiring its host/token fields in discovery records. */
function registrationAlive(r: DriverRegistration): boolean {
  try { process.kill(r.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false; }
  const start = procStart(r.pid);
  return r.start === undefined || start === undefined || start === r.start;
}
/** Ignore malformed, dead and reused-pid entries; leaving stale files avoids racing another writer's replacement. */
export function registeredDrivers(): DriverRegistration[] {
  const out: DriverRegistration[] = [];
  try {
    for (const file of readdirSync(registryDir()).filter(f => /^[a-f0-9]{16}\.json$/.test(f))) {
      try {
        const r = JSON.parse(readFileSync(join(registryDir(), file), 'utf8')) as DriverRegistration;
        if (typeof r.repo !== 'string' || !Number.isInteger(r.pid) || r.pid <= 0 || typeof r.at !== 'string' || (r.start !== undefined && typeof r.start !== 'string') || (r.session !== undefined && typeof r.session !== 'string')) continue;
        if (registrationAlive(r)) out.push(r);
      } catch { /* unreadable discovery never fails a tool */ }
    }
  } catch { /* missing or unreadable registry */ }
  return out;
}
