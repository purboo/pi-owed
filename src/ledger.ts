import { mkdir, readFile, open, rm, link } from 'node:fs/promises';
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
  async withLock<T>(fn: () => Promise<T>, name?: string): Promise<T> {
    const lockName = name ?? 'lock';
    if (!/^[a-zA-Z0-9_-]+$/.test(lockName)) throw new OwedError('invalid lock name', 'usage');
    if (this.held.getStore()?.has(lockName)) throw new OwedError(`nested lock ${lockName}`, 'internal');
    const path = join(this.dir, lockName), deadline = Date.now() + 60_000;
    let delay = 10;
    for (;;) {
      try { await mkdir(path); break; } catch (e) { if (!isCode(e, 'EEXIST')) throw e; }
      // A second, short-lived mkdir serializes stale reaping. Recheck the owner
      // after acquiring it so a waiter can never remove a replacement live lock.
      const reaper = join(this.dir, `${lockName}-reaper`);
      let reap = false;
      try { await mkdir(reaper); reap = true; } catch (e) { if (!isCode(e, 'EEXIST')) throw e; }
      if (reap) {
        try {
          try {
            const owner = JSON.parse(await readFile(join(path, 'owner.json'), 'utf8')) as { pid: number; host: string };
            if (owner.host === hostname() && Number.isInteger(owner.pid) && owner.pid > 0) {
              try { process.kill(owner.pid, 0); } catch (e) { if (isCode(e, 'ESRCH')) await rm(path, { recursive: true, force: true }); }
            }
          } catch (e) { if (!isCode(e, 'ENOENT')) throw e; }
        } finally { await rm(reaper, { recursive: true, force: true }); }
      }
      if (Date.now() >= deadline) throw new OwedError(`timed out waiting for ${lockName}`, 'internal');
      await new Promise(r => setTimeout(r, delay)); delay = Math.min(250, delay * 2);
    }
    const owned = new Set(this.held.getStore()); owned.add(lockName);
    try {
      const f = await open(join(path, 'owner.json'), 'wx');
      try { await f.writeFile(JSON.stringify({ pid: process.pid, host: hostname(), ts: new Date().toISOString() })); await f.sync(); } finally { await f.close(); }
      return await this.held.run(owned, fn);
    } finally { owned.delete(lockName); await rm(path, { recursive: true, force: true }); }
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
