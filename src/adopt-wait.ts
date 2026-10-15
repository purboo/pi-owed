import { mkdir, readdir, readFile, writeFile, rename, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { Ledger } from './ledger.ts';
import { OwedError } from './errors.ts';
import { clockTime } from './clock.ts';

export interface AdoptPending { pid: number; host: string; commit: string; since: string; until: string }
export function adoptWaitMs(wait?: number): number | undefined {
  if (wait === undefined) return undefined;
  if (!Number.isFinite(wait) || wait < 0 || wait * 1000 > 8_640_000_000_000_000-Date.now()-60_000) throw new OwedError('adopt wait must be finite non-negative seconds; use --wait <seconds>', 'usage');
  return wait * 1000;
}
/** #2090: every marker expires on every host; only local PIDs can be probed. */
export async function pendingAdopt(dir: string): Promise<AdoptPending | undefined> {
  const folder = join(dir,'adopt-pending');
  let files: string[];
  try { files = await readdir(folder); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;throw e; }
  const live: AdoptPending[] = [];
  for (const file of files.sort()) {
    if (!file.endsWith('.json')) continue;
    try {
      const p = JSON.parse(await readFile(join(folder,file),'utf8')) as AdoptPending;
      if (!p || typeof p !== 'object' || !Number.isSafeInteger(p.pid) || p.pid <= 0 || typeof p.host !== 'string' || typeof p.commit !== 'string' || typeof p.since !== 'string' || !Number.isFinite(Date.parse(p.since)) || typeof p.until !== 'string' || !(Date.parse(p.until)>Date.now())) continue;
      if (p.host === hostname()) {
        try { process.kill(p.pid,0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EPERM') continue; }
      }
      live.push(p);
    } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT' || e instanceof SyntaxError) continue;throw e; }
  }
  return live.sort((a,b)=>Date.parse(a.since)-Date.parse(b.since))[0];
}
export const mergeWaitSuffix = (reason: string, since: string): string => reason.startsWith('adopt (pending since ') ? '' : ` since ${clockTime(since)}`;
export const adoptPendingReason = (p: AdoptPending): string => `adopt (pending since ${clockTime(p.since)})`;

// Tools may share a PID. Briefly serialize only publication, never lease/merge work;
// keep the oldest request visible and restore the next one when it finishes.
const publications = new Map<string,{requests: Map<symbol,AdoptPending>; tail: Promise<void>; timer?: ReturnType<typeof setTimeout>}>();
export async function withAdoptPending<T>(ledger: Ledger, commit: string, start: number, deadline: number, run: () => Promise<T>): Promise<T> {
  const folder = join(ledger.dir,'adopt-pending');
  await mkdir(folder,{recursive:true});
  const path = join(folder,`${hostname()}-${process.pid}.json`), token = Symbol();
  let group = publications.get(path);
  if (!group) {group={requests:new Map(),tail:Promise.resolve()};publications.set(path,group);}
  const active = group;
  active.requests.set(token,{pid:process.pid,host:hostname(),commit,since:new Date(start).toISOString(),until:new Date(deadline+60_000).toISOString()});
  const publish = () => {
    const updated = active.tail.then(async () => {
      if (publications.get(path) !== active) return;
      clearTimeout(active.timer);
      const oldest = [...active.requests.values()].filter(p=>Date.parse(p.until)>Date.now()).sort((a,b)=>Date.parse(a.since)-Date.parse(b.since))[0];
      if (!oldest) {await rm(path,{force:true});return;}
      const temp = join(folder,`.${randomUUID()}.tmp`);
      try {await writeFile(temp,JSON.stringify(oldest));await rename(temp,path);}
      finally {await rm(temp,{force:true});}
      // If an old measurement outlives its grace, reveal the next live request
      // sharing this PID. A delayed callback cannot recreate a finished group.
      active.timer=setTimeout(()=>{void publish().catch(()=>{});},Math.min(2_147_483_647,Math.max(1,Date.parse(oldest.until)-Date.now())));
      active.timer.unref();
    });
    active.tail=updated.catch(()=>{});
    return updated;
  };
  try {await publish();return await run();}
  finally {
    active.requests.delete(token);
    try {await publish();}
    finally {if (!active.requests.size && publications.get(path) === active) publications.delete(path);}
  }
}
