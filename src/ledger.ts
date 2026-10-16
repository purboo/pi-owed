import { mkdir, readFile, open, rm, link, rename, writeFile, stat, readdir, realpath } from 'node:fs/promises';
import { readFileSync, mkdirSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { serialize, deserialize } from 'node:v8';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { H, ZERO, sha256 } from './canon.ts';
import { git } from './git.ts';
import { currentLockDeadline } from './lock-deadline.ts';
import { ledgerLocks } from './lock-context.ts';
import { clockTime } from './clock.ts';
import { OWED_VERSION, OwedError } from './errors.ts';
import type { Entry, Draft } from './types.ts';

/**
 * N4: the plan cache format and parser version: the cache format number and the owed package version, so an entry
 * written by another release (whose parsePlan may differ) is ignored.
 */
export const PLAN_CACHE_VERSION = `plan-cache/1 owed/${OWED_VERSION}`;
/** RC (0.27): the display-only fields this writer marks after draft validation, before hashing. */
export const IGNORABLE: Record<string, readonly string[]> = { waive: ['tracked_by'], obs: ['quarantine_passed'] };
/** G1.4 (0.12): the format id of the disk snapshot `snapshot/state.v8`. */
export const SNAPSHOT_FORMAT = 'owed-snapshot/1';
/**
 * G1.4: a disk snapshot as read: the seq and entry hash it was folded to and the v8-serialized packed state
 * (reducer `packState`). `readSnapshot` returns one only when its format, owed version and payload digest match.
 */
export interface Snapshot { seq: number; hash: string; payload: Buffer }
export async function ledgerDir(cwd: string): Promise<string> {
  const dir = process.env.OWED_DIR ? resolve(cwd, process.env.OWED_DIR) : join(resolve(cwd, (await git(cwd, ['rev-parse', '--git-common-dir'])).stdout.trim()), 'owed');
  await mkdir(join(dir, 'blobs'), { recursive: true }); return realpath(dir);
}
export function entryHash(e: Omit<Entry, 'hash'>): string {
  const { hash: _hash, ...rest } = e as Entry; return H(rest);
}
export function verifyChain(entries: Entry[]): { ok: true } | { ok: false; seq: number; error: string } {
  let prev = ZERO;
  for (let seq = 0; seq < entries.length; seq++) {
    const e = entries[seq];
    if (!e || e.seq !== seq) return { ok: false, seq, error: 'invalid sequence' };
    if (e.prev !== prev) return { ok: false, seq, error: 'invalid prev' };
    if (e.hash !== entryHash(e)) return { ok: false, seq, error: 'invalid hash' };
    prev = e.hash;
  }
  return { ok: true };
}
function isCode(e: unknown, code: string): boolean { return (e as NodeJS.ErrnoException).code === code; }
/** Remove a lock directory atomically: rename it away first, then delete the renamed copy. */
async function discard(path: string): Promise<void> {
  const trash = `${path}.trash-${randomUUID()}`;
  try { await rename(path, trash); } catch (e) { if (isCode(e, 'ENOENT')) return; throw e; }
  await rm(trash, { recursive: true, force: true });
}
/** The owner file of a lock directory: who took it and when (ISO time). */
export interface LockOwner { pid: number; host: string; ts: string; activity?: string; activitySince?: string }
/** @internal Test hook: how long withLock waits for a lock before it fails with code `busy` (default 60 s). */
export const lockWait = { ms: 60_000 };
/** Options of `withLock`. */
export interface LockOptions {
  waitMs?: number;
  activity?: string;
  /**
   * The `busy` message of this lock: given, a lock whose owner is a live process on this host fails at once with code
   * `busy` and this message instead of waiting, and a wait that times out fails with it too (K1).
   */
  busy?: (owner: LockOwner) => string;
}
/** The text of a lock wait that timed out (code `busy`); `lock` is the ledger lock. */
export function lockActivityText(owner: LockOwner): string {
  return owner.activity ? ` (${owner.activity.replace(/[\r\n]/g, ' ')} since ${clockTime(owner.activitySince ?? owner.ts)})` : '';
}
export function lockTimeoutText(name: string, owner?: LockOwner): string {
  const what = name === 'lock' ? 'the ledger lock' : `the ${name} lock`;
  return owner ? `timed out waiting for ${what} held by pid ${owner.pid} on ${owner.host} since ${clockTime(owner.ts)}${lockActivityText(owner)}; retry` : `timed out waiting for ${what}; retry`;
}
async function readOwner(path: string): Promise<LockOwner | undefined> {
  try {
    const o = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')) as Partial<LockOwner>;
    return { pid: Number(o.pid), host: String(o.host), ts: String(o.ts), ...(typeof o.activity === 'string' ? { activity:o.activity } : {}), ...(typeof o.activitySince === 'string' ? { activitySince:o.activitySince } : {}) };
  } catch (e) { if (isCode(e, 'ENOENT') || e instanceof SyntaxError) return undefined; throw e; }
}
/** Whether `pid` on this host is a live process (EPERM: alive, owned by another user). */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return isCode(e, 'EPERM'); }
}
/**
 * TR1: an unlocked reader may race an append in flight, so a final fragment without a trailing `\n` is ignored and
 * only the complete lines before it are read. A malformed complete line still fails. Locked reads skip this (TR2).
 */
function dropTornTail(text: string): string {
  return text.endsWith('\n') ? text : text.slice(0, text.lastIndexOf('\n') + 1);
}
const lockActivities = new AsyncLocalStorage<Map<string,string>>();
export class Ledger {
  readonly dir: string;
  /** MT (ruling #2110): the repository this ledger was opened from (git commands of the batch tail completion). */
  repo?: string;
  /** MT (ruling #2110): runs first under every outermost ledger lock (ops completes a torn batch merge tail). */
  static onLock?: (ledger: Ledger) => Promise<void>;
  private held = new AsyncLocalStorage<Set<string>>();
  private constructor(dir: string) { this.dir = dir; }
  static async open(cwd: string): Promise<Ledger> { const l = new Ledger(await ledgerDir(cwd)); l.repo = cwd; return l; }
  /** DF1/DF5: whether this async context holds this ledger directory's `lock` through any instance (locked reads see torn or in-flight tails). */
  holdsLock(): boolean { return [...(ledgerLocks.getStore() ?? [])].some(t => t.active && t.dir === this.dir); }
  async read(): Promise<Entry[]> {
    let text: string;
    try { text = await readFile(join(this.dir, 'ledger.jsonl'), 'utf8'); } catch (e) { if (isCode(e, 'ENOENT')) return []; throw e; }
    if (!this.holdsLock()) text = dropTornTail(text);
    const lines = text.split('\n'); if (lines.at(-1) === '') lines.pop();
    const entries = lines.map((line, seq) => { try { return JSON.parse(line) as Entry; } catch { throw new OwedError(`ledger seq ${seq}: invalid JSON`, 'internal'); } });
    const result = verifyChain(entries);
    if (!result.ok) throw new OwedError(`ledger seq ${result.seq}: ${result.error}`, 'internal');
    if (text && !text.endsWith('\n')) throw new OwedError(`ledger seq ${entries.length - 1}: incomplete line`, 'internal');
    return entries;
  }
  /**
   * Runs `fn` holding lock `name`. An abort of `signal` before the lock is acquired rejects at once with
   * OwedError('aborted', 'aborted') and takes nothing (D16a.2); after acquisition `fn` runs to completion. A lock
   * still held after `lockWait.ms` fails with code `busy` (`opts.busy`'s message, else lockTimeoutText); with
   * `opts.busy` a live owner on this host fails at once (K1). A dead owner on this host is reaped.
   */
  async withLock<T>(fn: () => Promise<T>, name?: string, signal?: AbortSignal, opts: LockOptions = {}): Promise<T> {
    const lockName = name ?? 'lock';
    if (!/^[a-zA-Z0-9_-]+$/.test(lockName)) throw new OwedError('invalid lock name', 'usage');
    if (this.held.getStore()?.has(lockName)) throw new OwedError(`nested lock ${lockName}`, 'internal');
    const aborted = () => new OwedError('aborted', 'aborted');
    const inheritedDeadline = currentLockDeadline();
    const deadline = Math.min(inheritedDeadline ?? Infinity,opts.waitMs !== undefined ? Date.now()+opts.waitMs : inheritedDeadline ?? Date.now()+lockWait.ms);
    const path = join(this.dir, lockName);
    let owner: LockOwner | undefined;
    let delay = 10;
    const token = randomUUID();
    for (;;) {
      if (signal?.aborted) throw aborted();
      // Acquire by renaming a fully prepared directory into place: the owner
      // file is complete whenever the lock path exists.
      const staged = join(this.dir, `.${lockName}-${token}`);
      await mkdir(staged, { recursive: true });
      await writeFile(join(staged, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname(), token, ts: new Date().toISOString(), ...(opts.activity ? { activity:opts.activity } : {}) }));
      try { await rename(staged, path); break; } catch (e) {
        await rm(staged, { recursive: true, force: true });
        if (!isCode(e, 'EEXIST') && !isCode(e, 'ENOTEMPTY')) throw e;
      }
      // The owner seen last names the holder in a busy message; a live owner of a fail-fast lock refuses at once.
      const seen = await readOwner(path);
      if (seen) owner = seen;
      if (seen && opts.busy && seen.host === hostname() && alive(seen.pid)) throw new OwedError(opts.busy(seen), 'busy');
      // A second, short-lived mkdir serializes stale reaping. Recheck the owner
      // after acquiring it so a waiter can never remove a replacement live lock.
      const reaper = join(this.dir, `${lockName}-reaper`);
      let reap = false;
      try { await mkdir(reaper); reap = true; } catch (e) {
        if (!isCode(e, 'EEXIST')) throw e;
        // A reaper that crashed leaves its directory behind; reaping takes milliseconds.
        try { if (Date.now() - (await stat(reaper)).mtimeMs > 10_000) await rm(reaper, { recursive: true, force: true }); } catch (err) { if (!isCode(err, 'ENOENT')) throw err; }
      }
      if (reap) {
        try {
          try {
            const owner = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')) as { pid: number; host: string };
            if (owner.host === hostname() && Number.isInteger(owner.pid) && owner.pid > 0) {
              try { process.kill(owner.pid, 0); } catch (e) { if (isCode(e, 'ESRCH')) await discard(path); }
            }
          } catch (e) { if (!isCode(e, 'ENOENT')) throw e; }
        } finally { await rm(reaper, { recursive: true, force: true }); }
      }
      if (Date.now() >= deadline) throw new OwedError(opts.busy && owner ? opts.busy(owner) : lockTimeoutText(lockName, owner), 'busy');
      if (signal?.aborted) throw aborted();
      await new Promise<void>((resolve, reject) => {
        const stop = () => { clearTimeout(timer); reject(aborted()); };
        const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, Math.min(delay,Math.max(0,deadline-Date.now())));
        signal?.addEventListener('abort', stop, { once: true });
      });
      delay = Math.min(250, delay * 2);
    }
    const owned = new Set(this.held.getStore()); owned.add(lockName);
    const activities = new Map(lockActivities.getStore());
    if (opts.activity) activities.set(join(path,'owner.json'),opts.activity);
    const ledgerOwned = new Set(ledgerLocks.getStore()), ledgerToken = { active: lockName === 'lock', dir: this.dir };
    if (ledgerToken.active) ledgerOwned.add(ledgerToken);
    try {
      return await ledgerLocks.run(ledgerOwned, () => lockActivities.run(activities,() => this.held.run(owned, async () => { if (lockName === 'lock' && Ledger.onLock) await Ledger.onLock(this); return fn(); })));
    } finally { ledgerToken.active = false; owned.delete(lockName); await discard(path); }
  }
  private activityUpdate: Promise<void> = Promise.resolve();
  /** AW2: serialize atomic owner-file updates for parallel measurements under this holder. */
  async measuringActivity(obligation: string): Promise<void> {
    const activities = [...(lockActivities.getStore() ?? [])];
    const update = this.activityUpdate.then(async () => {
      for (const [path,activity] of activities) {
        const owner = JSON.parse(await readFile(path,'utf8')) as LockOwner & { token: string };
        owner.activity = `${activity}: measuring ${obligation}`;
        owner.activitySince = new Date().toISOString();
        const temp = `${path}.${randomUUID()}`;
        try { await writeFile(temp,JSON.stringify(owner)); await rename(temp,path); }
        finally { await rm(temp,{force:true}); }
      }
    });
    this.activityUpdate = update.catch(() => {});
    await update;
  }
  async append(drafts: Draft[]): Promise<Entry[]> {
    if (!this.held.getStore()?.has('lock')) throw new OwedError('append requires withLock()', 'internal');
    const old = await this.read(), entries: Entry[] = [];
    let prev = old.at(-1)?.hash ?? ZERO;
    for (const draft of drafts) {
      const e = { ...draft, seq: old.length + entries.length, ts: new Date().toISOString(), prev } as Entry;
      const fields = e as unknown as Record<string, unknown>;
      const marked = (IGNORABLE[e.kind] ?? []).filter(name => Object.hasOwn(fields, name) && fields[name] !== undefined);
      if (marked.length) e.ignorable = [...new Set([...(e.ignorable ?? []), ...marked])].sort();
      e.hash = entryHash(e); prev = e.hash; entries.push(e);
    }
    if (entries.length) {
      const f = await open(join(this.dir, 'ledger.jsonl'), 'a');
      try { await f.writeFile(entries.map(e => JSON.stringify(e) + '\n').join('')); await f.sync(); } finally { await f.close(); }
    }
    return entries;
  }
  async putBlob(data: string | Uint8Array): Promise<string> {
    const sha = sha256(data), target = join(this.dir, 'blobs', sha);
    const temp = `${target}.${randomUUID()}`;
    const f = await open(temp, 'wx');
    try { await f.writeFile(data); await f.sync(); } finally { await f.close(); }
    try {
      // Hard linking publishes only complete bytes, without replacing existing blobs.
      try { await link(temp, target); } catch (e) { if (!isCode(e, 'EEXIST')) throw e; }
    } finally { await rm(temp, { force: true }); }
    return sha;
  }
  /**
   * N4 (0.10): the persistent parsed-plan cache `<owed dir>/cache/plans/<blob sha>.json` = `{v, sha, plan}`. A read
   * returns undefined on any error (missing, unreadable, invalid JSON, other `v` or `sha`); the caller parses the YAML.
   */
  async readPlanCache(sha: string): Promise<unknown> {
    if (!/^[a-f0-9]{64}$/.test(sha)) return undefined;
    try { return planCacheEntry(sha, await readFile(join(this.dir, 'cache', 'plans', `${sha}.json`), 'utf8')); } catch { return undefined; }
  }
  /** G1: readPlanCache, synchronously (a plan resolved on first use by a state from a replay cache). */
  readPlanCacheSync(sha: string): unknown {
    if (!/^[a-f0-9]{64}$/.test(sha)) return undefined;
    try { return planCacheEntry(sha, readFileSync(join(this.dir, 'cache', 'plans', `${sha}.json`), 'utf8')); } catch { return undefined; }
  }
  /** Writes a cache entry atomically (temp file, then rename); never throws (the cache never fails an op). */
  async writePlanCache(sha: string, plan: unknown): Promise<void> {
    if (!/^[a-f0-9]{64}$/.test(sha)) return;
    const dir = join(this.dir, 'cache', 'plans'), temp = join(dir, `.${sha}.${randomUUID()}.tmp`);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(temp, JSON.stringify({ v: PLAN_CACHE_VERSION, sha, plan }));
      await rename(temp, join(dir, `${sha}.json`));
    } catch { await rm(temp, { force: true }).catch(() => undefined); }
  }
  /** PM1: synchronous atomic publication; no pending promise keeps a parsed plan alive during replay. Never throws. */
  writePlanCacheSync(sha: string, plan: unknown): void {
    if (!/^[a-f0-9]{64}$/.test(sha)) return;
    const dir = join(this.dir, 'cache', 'plans'), temp = join(dir, `.${sha}.${randomUUID()}.tmp`);
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(temp, JSON.stringify({ v: PLAN_CACHE_VERSION, sha, plan }));
      renameSync(temp, join(dir, `${sha}.json`));
    } catch { try { rmSync(temp, { force: true }); } catch { /* cache cleanup is best effort too */ } }
  }
  /**
   * The raw cache entry of `sha` for `owed verify`: `missing` (no file), `corrupt` (unreadable, or not JSON), else its
   * fields as stored.
   */
  async rawPlanCache(sha: string): Promise<{ state: 'missing' } | { state: 'corrupt' } | { state: 'read'; v: unknown; sha: unknown; plan: unknown }> {
    let text: string;
    try { text = await readFile(join(this.dir, 'cache', 'plans', `${sha}.json`), 'utf8'); } catch (e) { return isCode(e, 'ENOENT') ? { state: 'missing' } : { state: 'corrupt' }; }
    try { const c = JSON.parse(text) as Record<string, unknown> | null; return c && typeof c === 'object' ? { state: 'read', v: c.v, sha: c.sha, plan: c.plan } : { state: 'corrupt' }; } catch { return { state: 'corrupt' }; }
  }
  /** Modification time (ms) of a file in the plan cache directory, undefined when it cannot be read. */
  async planCacheMtime(file: string): Promise<number | undefined> { try { return (await stat(join(this.dir, 'cache', 'plans', file))).mtimeMs; } catch { return undefined; } }
  /** File names in the plan cache directory (entries `<sha>.json` and stray temp files); empty when there is none. */
  async planCacheFiles(): Promise<string[]> {
    try { return (await readdir(join(this.dir, 'cache', 'plans'))).sort(); } catch { return []; }
  }
  async removePlanCache(file: string): Promise<void> { if (!file.includes('/')) await rm(join(this.dir, 'cache', 'plans', file), { force: true }); }
  /** G1.4: the disk snapshot file. */
  get snapshotFile(): string { return join(this.dir, 'snapshot', 'state.v8'); }
  /**
   * G1.4: the disk snapshot when it is readable and has this format, this owed version and an intact payload (sha256);
   * undefined otherwise (missing, unreadable, foreign or corrupt: never an error). The caller checks seq and hash
   * against the verified chain.
   */
  async readSnapshot(): Promise<Snapshot | undefined> {
    try {
      const o = deserialize(await readFile(this.snapshotFile)) as Record<string, unknown> | null;
      if (!o || typeof o !== 'object' || o.format !== SNAPSHOT_FORMAT || o.version !== OWED_VERSION || !Number.isInteger(o.seq) || typeof o.hash !== 'string' || !(o.payload instanceof Uint8Array) || o.digest !== sha256(o.payload)) return undefined;
      return { seq: o.seq as number, hash: o.hash, payload: Buffer.from(o.payload.buffer, o.payload.byteOffset, o.payload.byteLength) };
    } catch { return undefined; }
  }
  /** G1.4: writes the disk snapshot atomically (temp file, then rename); never throws. Returns whether it was written. */
  async writeSnapshot(seq: number, hash: string, payload: Uint8Array): Promise<boolean> {
    const dir = join(this.dir, 'snapshot'), temp = join(dir, `.state.${randomUUID()}.tmp`);
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(temp, serialize({ format: SNAPSHOT_FORMAT, version: OWED_VERSION, seq, hash, digest: sha256(payload), payload }));
      await rename(temp, this.snapshotFile);
      return true;
    } catch { await rm(temp, { force: true }).catch(() => undefined); return false; }
  }
  /** G1.4: removes the disk snapshot (verify, on a mismatch); never throws. */
  async removeSnapshot(): Promise<void> { await rm(this.snapshotFile, { force: true }).catch(() => undefined); }
  async getBlob(sha: string): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(sha)) throw new OwedError('invalid blob hash', 'usage');
    const data = await readFile(join(this.dir, 'blobs', sha));
    if (sha256(data) !== sha) throw new OwedError(`corrupt blob ${sha}`, 'internal'); return data;
  }
  /** G1: getBlob, synchronously. */
  getBlobSync(sha: string): Buffer {
    if (!/^[a-f0-9]{64}$/.test(sha)) throw new OwedError('invalid blob hash', 'usage');
    const data = readFileSync(join(this.dir, 'blobs', sha));
    if (sha256(data) !== sha) throw new OwedError(`corrupt blob ${sha}`, 'internal'); return data;
  }
}
/** The plan of a cache entry's text when its `v` and `sha` match (N4), else undefined; throws on invalid JSON. */
function planCacheEntry(sha: string, text: string): unknown {
  const c = JSON.parse(text) as { v?: unknown; sha?: unknown; plan?: unknown };
  return c && typeof c === 'object' && c.v === PLAN_CACHE_VERSION && c.sha === sha && c.plan && typeof c.plan === 'object' ? c.plan : undefined;
}
