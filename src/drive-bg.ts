// owed drive in the background (contract D17): `--detach` starts the loop driver as a detached process that appends its
// JSON lines to `<ledger dir>/drive/log.jsonl`; `--status` and `--stop` read the single-driver lock and that log; a
// Follower reads what the driver appends and wakes a pi session with one message per poll (halts, questions, refusals,
// the exit), so no model turn has to poll. The lock (`drive.lock`, src/drive-run.ts) stays the single-driver guarantee.
import { spawn } from 'node:child_process';
import { closeSync, fstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, statSync } from 'node:fs';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import * as git from './git.ts';
import { Ledger } from './ledger.ts';
import { OwedError } from './errors.ts';
import { defaultOwed, lockAlive, procStart, reportText } from './drive-run.ts';
import type { ExitReason, LockOwner } from './drive-run.ts';
import { oneLine } from './views.ts';

/** The exit record a `--json` loop driver writes last (D17.2). */
export interface ExitRecord { event: 'exit'; code: number; reason: ExitReason; at: string; error?: string }

/**
 * The ledger directory of cwd without creating anything (Ledger.open creates it): `$OWED_DIR`, else `<git common
 * dir>/owed`, as src/ledger.ts resolves it. Used by status, stop and the session_start follower, which must not leave
 * an `owed` directory in every repository a pi session starts in.
 */
export async function driveDir(cwd: string): Promise<string> {
  if (process.env.OWED_DIR) return resolve(cwd, process.env.OWED_DIR);
  return join(resolve(cwd, (await git.git(cwd, ['rev-parse', '--git-common-dir'])).stdout.trim()), 'owed');
}
export const lockPath = (dir: string): string => join(dir, 'drive.lock');
export const logPath = (dir: string): string => join(dir, 'drive', 'log.jsonl');

/**
 * The single-driver lock as seen from here: `none`; `stale` (its pid is gone or reused, or the file is unreadable: the
 * next driver takes it over); `live` (this host, the pid runs with the recorded start time); `foreign` (another host:
 * never checked or taken over from here).
 */
export type LockState = { state: 'none' } | { state: 'stale'; owner?: LockOwner } | { state: 'live' | 'foreign'; owner: LockOwner };
export function readLock(dir: string): LockState {
  let text: string;
  try { text = readFileSync(lockPath(dir), 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { state: 'none' }; throw e; }
  let owner: LockOwner | undefined;
  try { owner = JSON.parse(text) as LockOwner; } catch { owner = undefined; }
  if (!owner || typeof owner !== 'object' || !Number.isInteger(owner.pid)) return { state: 'stale' };
  if (owner.host !== hostname()) return { state: 'foreign', owner };
  return { state: lockAlive(owner) ? 'live' : 'stale', owner };
}
/** The lock file no longer names this owner (removed, or another driver's). */
function released(dir: string, owner: LockOwner): boolean {
  try { return (JSON.parse(readFileSync(lockPath(dir), 'utf8')) as LockOwner).token !== owner.token; } catch { return true; }
}
/** pid runs and, when `start` is known, is the same process (not a reused pid). */
function pidAlive(pid: number, start?: string): boolean {
  try { process.kill(pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false; }
  if (start === undefined) return true;
  const now = procStart(pid);
  return now === undefined || now === start;
}
const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms));

// ---------- the log ----------
function parseObject(line: string): Record<string, unknown> | undefined {
  try { const v: unknown = JSON.parse(line); return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : undefined; } catch { return undefined; }
}
/** Text of one log line: the text-mode line of a JSON report (reportText), else the escaped line itself. */
export function logLineText(line: string): string {
  const j = parseObject(line);
  return j ? reportText(j) : oneLine(line);
}
/** The complete last lines of the log (at most the last `bytes`); undefined when there is no log. */
function tailLines(path: string, bytes = 256 * 1024): string[] | undefined {
  let fd: number;
  try { fd = openSync(path, 'r'); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw e; }
  try {
    const size = fstatSync(fd).size, from = Math.max(0, size - bytes), buf = Buffer.alloc(size - from);
    const n = readSync(fd, buf, 0, buf.length, from);
    const lines = buf.subarray(0, n).toString('utf8').split('\n');
    if (from > 0) lines.shift();
    return lines.filter(l => l.trim());
  } finally { closeSync(fd); }
}
function lastExit(lines: string[]): ExitRecord | undefined {
  for (let i = lines.length - 1; i >= 0; i--) {
    const j = parseObject(lines[i]!);
    if (j?.event === 'exit' && typeof j.code === 'number' && typeof j.reason === 'string') return j as unknown as ExitRecord;
  }
  return undefined;
}
const describeOwner = (o: LockOwner): string => `pid ${o.pid} on ${o.host} since ${o.at}`;

// ---------- --detach ----------
export interface DriveStart {
  pid: number; log: string; repo: string;
  /** Start time of the driver process (`/proc`), to tell a reused pid from it. */
  start?: string;
  /** The driver took the lock (false: still starting after the wait; see `owed drive --status`). */
  confirmed: boolean;
  /** The driver already ended (e.g. idle at once) without an error; its exit record. */
  exited?: ExitRecord;
}
/**
 * `owed drive --detach` (D17.1): refuses while a driver holds the lock (naming pid, host, start and log); else rotates
 * the log (one old log kept as log.jsonl.1), spawns `owed drive --json [--max N]` detached (own session and process
 * group, stdin ignored, stdout/stderr appended to the log, cwd = repository root, environment inherited, unref'd) and
 * waits up to `waitMs` (5 s) for the lock to name it. A driver that exits first with no exit record or with an error
 * record refuses with the log tail. Concurrent `--detach` calls of one repository are serialized (ledger lock
 * `drive-detach`), so a second one sees the first driver's lock instead of rotating its log.
 */
export async function driveStart(o: { cwd: string; max?: number; owed?: string[]; waitMs?: number }): Promise<DriveStart> {
  const ledger = await Ledger.open(o.cwd), dir = ledger.dir, repo = await git.mainRoot(o.cwd);
  if (!(await ledger.read()).length) throw new OwedError('Not initialized: run owed init <plan.yaml> first');
  return ledger.withLock(async () => {
    const log = logPath(dir), held = readLock(dir);
    if (held.state === 'live') throw new OwedError(`a driver is running for this repository: ${describeOwner(held.owner)}; log ${log} (owed drive --status, owed drive --stop)`);
    if (held.state === 'foreign') throw new OwedError(`the driver lock ${lockPath(dir)} is held by pid ${held.owner.pid} on host ${held.owner.host} (since ${held.owner.at}); a lock of another host is never taken over: check that host, and if no driver runs there remove the lock by hand; log ${log}`);
    mkdirSync(join(dir, 'drive'), { recursive: true });
    try { renameSync(log, `${log}.1`); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    const argv = [...(o.owed ?? defaultOwed()), 'drive', '--json', ...(o.max !== undefined ? ['--max', String(o.max)] : [])];
    // A relative $OWED_DIR resolves against cwd: pass the resolved ledger dir, since the driver runs at the root.
    const env = { ...process.env, ...(process.env.OWED_DIR ? { OWED_DIR: dir } : {}) }; delete env.NODE_TEST_CONTEXT;
    const fd = openSync(log, 'a');
    const child = (() => { try { return spawn(argv[0]!, argv.slice(1), { cwd: repo, env, detached: true, stdio: ['ignore', fd, fd] }); } finally { closeSync(fd); } })();
    const run: { ended?: string } = {};
    child.on('exit', (code, signal) => { run.ended = signal ? `signal ${signal}` : `exit ${code}`; });
    child.on('error', e => { run.ended = `error: ${e.message}`; });
    child.unref();
    const pid = child.pid;
    if (pid === undefined) { await sleep(50); throw new OwedError(`could not start the driver (${argv.join(' ')}): ${run.ended ?? 'no pid'}`); }
    const start = procStart(pid), deadline = Date.now() + (o.waitMs ?? 5000);
    for (;;) {
      const l = readLock(dir);
      if (l.state === 'live' && l.owner.pid === pid) return { pid, log, repo, ...(start ? { start } : {}), confirmed: true };
      if (run.ended !== undefined) {
        const lines = tailLines(log) ?? [], rec = lastExit(lines);
        if (rec && rec.reason !== 'error') return { pid, log, repo, ...(start ? { start } : {}), confirmed: true, exited: rec };
        throw new OwedError(`the driver (pid ${pid}) ended (${run.ended}) before taking the lock; log ${log}:\n${lines.slice(-10).map(logLineText).join('\n')}`);
      }
      if (Date.now() >= deadline) return { pid, log, repo, ...(start ? { start } : {}), confirmed: false };
      await sleep(100);
    }
  }, 'drive-detach');
}
export function renderDriveStart(r: DriveStart): string {
  const head = `driver started: pid ${r.pid}, log ${r.log}`;
  if (r.exited) return `${head}\n${logLineText(JSON.stringify(r.exited))}`;
  return r.confirmed ? head : `${head} (it has not taken the lock yet; see owed drive --status)`;
}

// ---------- --status ----------
export interface DriveStatus {
  running: boolean;
  /** The lock is held on another host (not checked from here). */
  foreign?: boolean;
  pid?: number; host?: string; since?: string;
  log: string;
  /** The last exit record of the log. */
  exit?: ExitRecord;
  /** No driver runs and the log has no exit record (SIGKILL or a crash). */
  noExitRecord?: boolean;
  /** Last 10 log lines as text. */
  tail: string[];
}
/** `owed drive --status` (D17.3). Reads only; creates nothing. */
export async function driveStatus(o: { cwd: string }): Promise<DriveStatus> {
  const dir = await driveDir(o.cwd), log = logPath(dir), lock = readLock(dir), lines = tailLines(log);
  const r: DriveStatus = { running: lock.state === 'live', log, tail: (lines ?? []).slice(-10).map(logLineText) };
  if (lock.state === 'live' || lock.state === 'foreign') { r.pid = lock.owner.pid; r.host = lock.owner.host; r.since = lock.owner.at; }
  if (lock.state === 'foreign') r.foreign = true;
  const exit = lines ? lastExit(lines) : undefined;
  if (exit) r.exit = exit;
  else if (lines && lock.state !== 'live' && lock.state !== 'foreign') r.noExitRecord = true;
  return r;
}
const exitText = (e: ExitRecord): string => `${e.reason} (exit ${e.code}) at ${e.at}${e.error !== undefined ? `: ${oneLine(e.error)}` : ''}`;
export function renderDriveStatus(r: DriveStatus): string {
  const out: string[] = [];
  if (r.foreign) out.push(`driver lock held by pid ${r.pid} on host ${r.host} since ${r.since} (another host: not checked from here)`);
  else if (r.running) out.push(`driver running: pid ${r.pid} on ${r.host} since ${r.since}`);
  else out.push(r.noExitRecord ? 'driver not running; it ended without an exit record (killed or crashed)' : 'driver not running');
  if (r.exit) out.push(`last exit: ${exitText(r.exit)}`);
  out.push(`log: ${r.log}`);
  if (r.tail.length) out.push(`last ${r.tail.length} log line${r.tail.length === 1 ? '' : 's'}:`, ...r.tail.map(l => `  ${l}`));
  return out.join('\n');
}
/** The `/owed` status line (D17.8). */
export async function driverLine(cwd: string): Promise<string> {
  const r = await driveStatus({ cwd });
  if (r.foreign) return `Driver: lock held by pid ${r.pid} on host ${r.host} since ${r.since}`;
  if (r.running) return `Driver: running pid ${r.pid} since ${r.since}`;
  if (r.exit) return `Driver: not running (last exit ${r.exit.reason} at ${r.exit.at})`;
  return r.noExitRecord ? 'Driver: not running (ended without an exit record)' : 'Driver: not running';
}

// ---------- --stop ----------
export interface DriveStop { state: 'none' | 'stopped' | 'stopping'; pid?: number }
/**
 * `owed drive --stop [--now]` (D17.4): SIGTERM to the lock's pid only when its pid and process start time match a live
 * process of this host (never a reused pid; another host refuses); `now`: a second SIGTERM 1 s later (stop at once,
 * D14.8). Waits up to `waitMs` (10 s) for the lock to be released.
 */
export async function driveStop(o: { cwd: string; now?: boolean; waitMs?: number }): Promise<DriveStop> {
  const dir = await driveDir(o.cwd), lock = readLock(dir);
  if (lock.state === 'none' || lock.state === 'stale') return { state: 'none' };
  const owner = lock.owner;
  if (lock.state === 'foreign') throw new OwedError(`the driver lock ${lockPath(dir)} is held by pid ${owner.pid} on host ${owner.host} (since ${owner.at}); stop it on that host`);
  if (owner.start === undefined) throw new OwedError(`cannot verify that pid ${owner.pid} is the driver (its lock records no process start time); not signaled`);
  const same = (): boolean => procStart(owner.pid) === owner.start && !released(dir, owner);
  if (!same()) return { state: 'none' };
  process.kill(owner.pid, 'SIGTERM');
  const t0 = Date.now(), deadline = t0 + (o.waitMs ?? 10_000);
  let second = !o.now;
  while (Date.now() < deadline) {
    if (released(dir, owner) || procStart(owner.pid) !== owner.start) return { state: 'stopped', pid: owner.pid };
    if (!second && Date.now() - t0 >= 1000) { second = true; if (same()) process.kill(owner.pid, 'SIGTERM'); }
    await sleep(100);
  }
  return released(dir, owner) ? { state: 'stopped', pid: owner.pid } : { state: 'stopping', pid: owner.pid };
}
export function renderDriveStop(r: DriveStop): string {
  return r.state === 'none' ? 'no driver running' : r.state === 'stopped' ? 'stopped' : `stopping: pid ${r.pid} exits after its current action`;
}

// ---------- wake-ups ----------
type LineKind = 'wake' | 'terminal' | 'merge' | 'quiet';
const TERMINAL = new Set(['exit', 'killed', 'stopped', 'idle']);
/**
 * Which log lines wake the session (D17.7): halts, notifies (questions, owner-needed, stalled), rejected / conflicting
 * dsa requests, refused merges and errors (both halt or need a look), events errors, terminal lines and any line that
 * is not a JSON object. A merge only rides along with the next wake; everything else (dispatch, launch, send applied,
 * attest, busy, pending, cursor-reset) is quiet.
 */
export function classifyLine(line: string): { kind: LineKind; text: string } {
  const j = parseObject(line);
  if (!j) return { kind: 'wake', text: oneLine(line) };
  const text = reportText(j);
  if (typeof j.event === 'string') return { kind: TERMINAL.has(j.event) ? 'terminal' : j.event === 'events-error' ? 'wake' : 'quiet', text };
  if (typeof j.do !== 'string') return { kind: 'wake', text };
  if (j.do === 'merge' && j.outcome === 'merged') return { kind: 'merge', text };
  if (j.do === 'halt' || j.do === 'notify' || ['rejected', 'conflict', 'refused', 'error'].includes(String(j.outcome))) return { kind: 'wake', text };
  return { kind: 'quiet', text };
}

export interface FollowerOptions {
  log: string; repo: string; pid: number; start?: string;
  /** Byte offset to start at; default the log's size now (no replay). */
  from?: number;
  deliver: (content: string) => void;
  intervalMs?: number;
  onStop?: () => void;
}
/**
 * Follows one driver's log: every `intervalMs` (unref'd timer) reads the complete lines appended since the last read and
 * delivers one message for all wake lines of that read (D17.7): `owed drive (<repo>):`, the merges since the last
 * message and the wake lines in log order, `Next: owed status / owed why <node>`. A wake text it already delivered is
 * not repeated. It stops after a terminal line, or when the driver pid is gone without one (then it says so).
 */
export class Follower {
  private readonly o: FollowerOptions;
  private offset: number;
  private timer?: NodeJS.Timeout;
  private carried: string[] = [];
  private readonly delivered = new Set<string>();
  stopped = false;
  constructor(o: FollowerOptions) {
    this.o = o;
    let size = 0;
    if (o.from === undefined) { try { size = statSync(o.log).size; } catch { size = 0; } }
    this.offset = o.from ?? size;
  }
  get pid(): number { return this.o.pid; }
  start(): this {
    if (!this.stopped && !this.timer) { this.timer = setInterval(() => { try { this.tick(); } catch { /* next tick */ } }, this.o.intervalMs ?? 2000); this.timer.unref(); }
    return this;
  }
  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = undefined; }
    if (!this.stopped) { this.stopped = true; this.o.onStop?.(); }
  }
  /** Complete lines appended since the last read (a log that shrank was rotated: read it from its start). */
  private read(): string[] {
    let fd: number;
    try { fd = openSync(this.o.log, 'r'); } catch { return []; }
    try {
      const size = fstatSync(fd).size;
      if (size < this.offset) this.offset = 0;
      if (size === this.offset) return [];
      const CAP = 4 * 1024 * 1024, buf = Buffer.alloc(Math.min(size - this.offset, CAP)), n = readSync(fd, buf, 0, buf.length, this.offset);
      const end = n > 0 ? buf.lastIndexOf(0x0a, n - 1) : -1;
      // No newline yet: an incomplete line waits for its end, unless it alone exceeds the cap (then it is taken as is).
      if (end < 0) { if (n < CAP) return []; this.offset += n; return [buf.toString('utf8')]; }
      this.offset += end + 1;
      return buf.subarray(0, end).toString('utf8').split('\n').filter(l => l.trim());
    } finally { closeSync(fd); }
  }
  /** One poll; returns the message delivered, if any. */
  tick(): string | undefined {
    if (this.stopped) return undefined;
    // Liveness first: a driver found gone has written everything it ever will before the read below.
    const alive = pidAlive(this.o.pid, this.o.start), out: string[] = [];
    let wakes = 0, terminal = false;
    for (const line of this.read()) {
      const c = classifyLine(line);
      if (c.kind === 'quiet') continue;
      if (c.kind === 'merge') { out.push(c.text); continue; }
      if (c.kind === 'terminal') terminal = true;
      if (this.delivered.has(c.text)) continue;
      this.delivered.add(c.text); out.push(c.text); wakes++;
    }
    if (!terminal && !alive) { terminal = true; out.push(`driver pid ${this.o.pid} ended without an exit record`); wakes++; }
    let message: string | undefined;
    if (wakes) {
      message = [`owed drive (${this.o.repo}):`, ...this.carried, ...out, 'Next: owed status / owed why <node>'].join('\n');
      this.carried = [];
      this.o.deliver(message);
    } else this.carried.push(...out);
    if (terminal) this.stop();
    return message;
  }
}

/**
 * The followers of one pi extension instance: one per driver log (= per repository) (D17.7). `follow` replaces the
 * follower of that log; `attach` (session_start) follows the live driver of cwd's repository from the log's current
 * size; `stopAll` (session_shutdown) clears every timer, the drivers keep running.
 */
export class DriveWatch {
  private readonly followers = new Map<string, Follower>();
  private readonly deliver: (content: string) => void;
  private readonly intervalMs?: number;
  constructor(deliver: (content: string) => void, intervalMs?: number) { this.deliver = deliver; this.intervalMs = intervalMs; }
  get size(): number { return this.followers.size; }
  follow(o: { log: string; repo: string; pid: number; start?: string; from?: number }): Follower {
    this.followers.get(o.log)?.stop();
    const f: Follower = new Follower({ ...o, deliver: this.deliver, ...(this.intervalMs !== undefined ? { intervalMs: this.intervalMs } : {}), onStop: () => { if (this.followers.get(o.log) === f) this.followers.delete(o.log); } });
    this.followers.set(o.log, f);
    return f.start();
  }
  async attach(cwd: string): Promise<Follower | undefined> {
    let dir: string;
    try { dir = await driveDir(cwd); } catch { return undefined; }
    const lock = readLock(dir);
    if (lock.state !== 'live') return undefined;
    const log = logPath(dir), have = this.followers.get(log);
    if (have && have.pid === lock.owner.pid) return have;
    const repo = await git.mainRoot(cwd).catch(() => cwd);
    return this.follow({ log, repo, pid: lock.owner.pid, ...(lock.owner.start ? { start: lock.owner.start } : {}) });
  }
  stopAll(): void { for (const f of [...this.followers.values()]) f.stop(); this.followers.clear(); }
}
