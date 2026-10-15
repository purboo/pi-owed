// WD: assessment is pure; filesystem/dsa gathering and delivery are separate boundaries.
import { mkdir, open, readFile, stat, unlink } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { Dsa, dsaAvailable } from './dsa.ts';
import { driveDir, readLock } from './drive-bg.ts';
import { readState } from './ops.ts';
import { Ledger } from './ledger.ts';
import { OwedError } from './errors.ts';
import { statusView } from './views.ts';
import type { StatusView } from './views.ts';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

export interface IdleNode { id: string; state: string; next: string; ready?: boolean; openCandidate?: boolean; needsYou?: boolean; merged?: boolean }
export interface IdleFacts {
  now: number; last?: { seq: number; ts: string }; idleMin?: number;
  nodes: IdleNode[]; driverRunning: boolean; lockHeld: boolean; machineHeld: boolean;
  calls?: { state: string; labels?: Record<string, string> }[];
}
export interface IdleAssessment { idle: boolean; reason: string; ageMin: number; last?: { seq: number; ts: string }; nodes: IdleNode[]; dsaKnown: boolean }
/** ALL WD1 conditions, with unknown dsa calls falling back to the age test. */
export function assessIdle(f: IdleFacts): IdleAssessment {
  const age = f.last ? f.now - Date.parse(f.last.ts) : NaN;
  const nodes = f.nodes.filter(n => !n.merged && (n.ready || n.openCandidate || n.needsYou));
  const active = f.calls?.some(c => ['running', 'asking'].includes(c.state) && f.nodes.some(n => !n.merged && n.id === c.labels?.node));
  const min = f.idleMin ?? 15;
  const reason = min === 0 ? 'disabled' : !nodes.length ? 'no open work' : f.driverRunning ? 'driver running'
    : f.lockHeld ? 'work in progress' : f.machineHeld ? 'measurement running' : active ? 'agent working'
    : !Number.isFinite(age) || age <= min * 60_000 ? 'recent progress' : 'idle';
  return { idle: reason === 'idle', reason, ageMin: Number.isFinite(age) ? Math.max(0, Math.floor(age / 60_000)) : 0, last: f.last, nodes, dsaKnown: f.calls !== undefined };
}
export const idleExit = (r: IdleAssessment): number => r.idle ? 0 : 3;
export function idleText(r: IdleAssessment): string {
  if (!r.idle) return `Work is not idle (${r.reason}); run owed status for next actions.`;
  // No ledger or measurement vocabulary in prose; commands are kept byte-exact.
  return [`Nothing has moved for ${r.ageMin} min and nobody is working on it.`,
    ...r.nodes.slice(0, 5).map(n => `${n.id}: ${n.state}; next: ${n.next}`),
    `Last progress: ${r.last!.ts}`].join('\n');
}
/** Reuse the status summary's exact next command; never quote its internal reason text in a wake. */
export function idleNodes(v: StatusView): IdleNode[] {
  return Object.values(v.nodes).map(n => {
    const need = v.summary?.needs.find(x => x.node === n.id);
    return { id: n.id, state: n.slot?.rebase && !n.candidate ? 'rebase pending' : n.phase,
      next: need?.command || `owed why ${n.id}`, merged: !!n.merged || n.phase === 'removed',
      ready: v.ready.includes(n.id) && !v.later?.includes(n.id) && !v.overlaps[n.id],
      openCandidate: !!n.slot?.open && (!!n.candidate || !!n.slot.rebase), needsYou: !!need };
  }).concat((v.summary?.needs ?? []).filter(need => !v.nodes[need.node]).map(need => ({
    id: need.node, state: 'needs attention', next: need.command || 'owed status',
    merged: false, ready: false, openCandidate: false, needsYou: true,
  })));
}
/** Conservative read: foreign/unknown owners count; dead local owners do not. Never reaps a lock. */
export async function watchdogLockHeld(dir: string): Promise<boolean> {
  for (const name of ['lock', 'merge', 'trunk-refresh', 'adopt']) {
    const path = join(dir, name);
    try {
      await stat(path);
      let owner: { pid?: number; host?: string };
      try { owner = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') { try { await stat(path); } catch { continue; } } return true; }
      if (owner.host !== hostname() || !Number.isInteger(owner.pid) || owner.pid! <= 0) return true;
      try { process.kill(owner.pid!, 0); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ESRCH') return true; }
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  return false;
}
export async function idle(cwd: string): Promise<IdleAssessment> {
  const dir = await driveDir(cwd);
  // An ordinary git repository is not automatically initialized by watching it.
  await stat(join(dir, 'ledger.jsonl'));
  const { entries, state } = await readState({ cwd });
  if (!entries.length) throw new OwedError('Missing plan; run owed init <plan.yaml>', 'usage');
  const lock = readLock(dir), driverRunning = lock.state === 'live' || lock.state === 'foreign';
  let facts: Awaited<ReturnType<Dsa['watchdogFacts']>> | undefined;
  const dsa = new Dsa({ timeoutMs: 10_000, cwd });
  if (dsaAvailable(dsa.bin)) { try { facts = await dsa.watchdogFacts(); } catch { /* WD1(d): unknown, age decides. */ } }
  const now = Date.now(), v = statusView(state, entries, [], now, driverRunning);
  return assessIdle({ now, last: entries.at(-1), idleMin: state.plan.drive?.watch_idle_min,
    nodes: idleNodes(v), driverRunning, lockHeld: await watchdogLockHeld(dir), machineHeld: facts?.machineHeld ?? false, calls: facts?.calls });
}
/** Atomic cross-process, cross-session claim. No ledger writes or locks are taken. */
export async function claimIdle(dir: string, seq: number): Promise<boolean> {
  if (!Number.isSafeInteger(seq) || seq < 0) throw new OwedError('invalid idle period', 'internal');
  const watch = join(dir, 'watch'); await mkdir(watch, { recursive: true });
  try { const file = await open(join(watch, `idle-${seq}`), 'wx', 0o600); await file.close(); return true; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === 'EEXIST') return false; throw e; }
}
export const WATCH_POLL_MS = 120_000;
export interface IdleWatchOptions {
  busy: () => boolean; assess?: (cwd: string) => Promise<IdleAssessment>; directory?: (cwd: string) => Promise<string>;
  currentSeq?: (cwd: string) => Promise<number>; now?: () => number;
}
/** Uses pi's worker ticks, not a second host timer. One assessment in flight per repository. */
export class IdleWatch {
  private repos = new Map<string, { cwd: string; due: number; checking: boolean }>();
  private stopped = false;
  private readonly deliver: (text: string) => void | Promise<void>;
  private readonly o: IdleWatchOptions;
  constructor(deliver: (text: string) => void | Promise<void>, o: IdleWatchOptions) { this.deliver = deliver; this.o = o; }
  async attach(cwd: string): Promise<void> {
    if (this.stopped) return;
    const dir = await (this.o.directory ?? driveDir)(cwd);
    await stat(join(dir, 'ledger.jsonl'));
    if (!this.repos.has(dir)) this.repos.set(dir, { cwd, due: (this.o.now ?? Date.now)() + WATCH_POLL_MS, checking: false });
  }
  async flush(): Promise<void> {
    if (this.stopped || this.o.busy()) return;
    await Promise.all([...this.repos].map(async ([dir, r]) => {
      if (r.checking || r.due > (this.o.now ?? Date.now)()) return;
      r.checking = true;
      try {
        const result = await (this.o.assess ?? idle)(r.cwd);
        if (this.stopped || this.o.busy()) return;
        r.due = (this.o.now ?? Date.now)() + WATCH_POLL_MS;
        if (!result.idle || !result.last) return;
        const current = await (this.o.currentSeq ?? (async cwd => (await (await Ledger.open(cwd)).read()).at(-1)?.seq ?? -1))(r.cwd);
        if (current !== result.last.seq || this.stopped || this.o.busy()) return;
        if (!await claimIdle(dir, current)) return;
        // The ledger may have progressed while publishing the claim; never deliver a stale period.
        try {
          const latest = await (this.o.currentSeq ?? (async cwd => (await (await Ledger.open(cwd)).read()).at(-1)?.seq ?? -1))(r.cwd);
          if (latest !== current || this.stopped || this.o.busy()) throw new Error('session busy or progress changed');
          await this.deliver(idleText(result));
        } catch { await unlink(join(dir, 'watch', `idle-${current}`)); r.due = 0; }
      } catch { r.due = (this.o.now ?? Date.now)() + WATCH_POLL_MS; }
      finally { r.checking = false; }
    }));
  }
  stopAll(): void { this.stopped = true; this.repos.clear(); }
}
/** Shared extension delivery path, including worker-side rejection promises. */
export function idleWake(pi: Pick<ExtensionAPI, 'sendMessage'>, o: IdleWatchOptions): IdleWatch {
  return new IdleWatch(content => pi.sendMessage({ customType: 'owed-idle', display: true, content }, { triggerTurn: true, deliverAs: 'followUp' }), o);
}
