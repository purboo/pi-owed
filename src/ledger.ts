import { mkdir, readFile, open, rm, link, rename, writeFile, stat } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { H, ZERO, sha256 } from './canon.ts';
import { git } from './git.ts';
import { OwedError } from './errors.ts';
import type { Entry, Draft } from './types.ts';

export async function ledgerDir(cwd: string): Promise<string> {
  const dir = process.env.OWED_DIR ? resolve(cwd, process.env.OWED_DIR) : join(resolve(cwd, (await git(cwd, ['rev-parse', '--git-common-dir'])).stdout.trim()), 'owed');
  await mkdir(join(dir, 'blobs'), { recursive: true }); return dir;
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
export interface LockOwner { pid: number; host: string; ts: string }
/** @internal Test hook: how long withLock waits for a lock before it fails with code `busy` (default 60 s). */
export const lockWait = { ms: 60_000 };
/** Options of `withLock`. */
export interface LockOptions {
  /**
   * The `busy` message of this lock: given, a lock whose owner is a live process on this host fails at once with code
   * `busy` and this message instead of waiting, and a wait that times out fails with it too (K1).
   */
  busy?: (owner: LockOwner) => string;
}
/** The text of a lock wait that timed out (code `busy`); `lock` is the ledger lock. */
export function lockTimeoutText(name: string, owner?: LockOwner): string {
  const what = name === 'lock' ? 'the ledger lock' : `the ${name} lock`;
  return owner ? `timed out waiting for ${what} held by pid ${owner.pid} on ${owner.host} since ${owner.ts}; retry` : `timed out waiting for ${what}; retry`;
}
async function readOwner(path: string): Promise<LockOwner | undefined> {
  try {
    const o = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')) as Partial<LockOwner>;
    return { pid: Number(o.pid), host: String(o.host), ts: String(o.ts) };
  } catch (e) { if (isCode(e, 'ENOENT') || e instanceof SyntaxError) return undefined; throw e; }
}
/** Whether `pid` on this host is a live process (EPERM: alive, owned by another user). */
function alive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (e) { return isCode(e, 'EPERM'); }
}
export class Ledger {
  readonly dir: string;
  private held = new AsyncLocalStorage<Set<string>>();
  private constructor(dir: string) { this.dir = dir; }
  static async open(cwd: string): Promise<Ledger> { return new Ledger(await ledgerDir(cwd)); }
  async read(): Promise<Entry[]> {
    let text: string;
    try { text = await readFile(join(this.dir, 'ledger.jsonl'), 'utf8'); } catch (e) { if (isCode(e, 'ENOENT')) return []; throw e; }
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
    const path = join(this.dir, lockName), deadline = Date.now() + lockWait.ms;
    let owner: LockOwner | undefined;
    let delay = 10;
    const token = randomUUID();
    for (;;) {
      if (signal?.aborted) throw aborted();
      // Acquire by renaming a fully prepared directory into place: the owner
      // file is complete whenever the lock path exists.
      const staged = join(this.dir, `.${lockName}-${token}`);
      await mkdir(staged, { recursive: true });
      await writeFile(join(staged, 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname(), token, ts: new Date().toISOString() }));
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
        const timer = setTimeout(() => { signal?.removeEventListener('abort', stop); resolve(); }, delay);
        signal?.addEventListener('abort', stop, { once: true });
      });
      delay = Math.min(250, delay * 2);
    }
    const owned = new Set(this.held.getStore()); owned.add(lockName);
    try {
      return await this.held.run(owned, fn);
    } finally { owned.delete(lockName); await discard(path); }
  }
  async append(drafts: Draft[]): Promise<Entry[]> {
    if (!this.held.getStore()?.has('lock')) throw new OwedError('append requires withLock()', 'internal');
    const old = await this.read(), entries: Entry[] = [];
    let prev = old.at(-1)?.hash ?? ZERO;
    for (const draft of drafts) {
      const e = { ...draft, seq: old.length + entries.length, ts: new Date().toISOString(), prev } as Entry;
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
  async getBlob(sha: string): Promise<Buffer> {
    if (!/^[a-f0-9]{64}$/.test(sha)) throw new OwedError('invalid blob hash', 'usage');
    const data = await readFile(join(this.dir, 'blobs', sha));
    if (sha256(data) !== sha) throw new OwedError(`corrupt blob ${sha}`, 'internal'); return data;
  }
}
