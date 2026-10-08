import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { spawn } from 'node:child_process';
import { Ledger, verifyChain } from '../src/ledger.ts';
import { OwedError } from '../src/errors.ts';
import { repo } from './helpers/repo.ts';
function child(code: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, ['--input-type=module', '-e', code], { env: process.env }); let log = '';
    p.stderr.on('data', b => { log += b; }); p.on('error', reject); p.on('close', code => code === 0 ? resolve() : reject(new Error(log)));
  });
}
test('ledger locking, blobs, cross-process append, stale PID and tamper detection', async () => {
  const r = await repo();
  try {
    const l = await Ledger.open(r.cwd);
    await assert.rejects(l.append([{ kind: 'note', by: 'parent:test', text: 'no lock' }]));
    const sha = await l.putBlob('hello'); assert.equal((await l.getBlob(sha)).toString(), 'hello'); assert.equal(await l.putBlob('hello'), sha);
    await assert.rejects(l.getBlob('../x'));
    const module = new URL('../src/ledger.ts', import.meta.url).href;
    const code = `import {Ledger} from ${JSON.stringify(module)}; const l=await Ledger.open(${JSON.stringify(r.cwd)}); for(let i=0;i<12;i++) await l.withLock(async()=>{await new Promise(r=>setTimeout(r,3));await l.append([{kind:'note',by:'parent:child',text:String(i)}]);});`;
    await Promise.all([child(code), child(code)]);
    const entries = await l.read(); assert.equal(entries.length, 24); assert.deepEqual(verifyChain(entries), { ok: true });
    // Obtain a PID known to have exited, rather than guessing a host PID.
    let dead = 0;
    await new Promise<void>((resolve, reject) => { const p = spawn(process.execPath, ['-e', '']); dead = p.pid!; p.on('error', reject); p.on('close', () => resolve()); });
    await mkdir(join(l.dir, 'lock')); await writeFile(join(l.dir, 'lock', 'owner.json'), JSON.stringify({ pid: dead, host: hostname(), ts: '' }));
    await l.withLock(() => l.append([{ kind: 'note', by: 'parent:test', text: 'stale recovered' }]));
    assert.equal((await l.read()).length, 25);
    const file = join(l.dir, 'ledger.jsonl'), original = await readFile(file, 'utf8');
    for (let seq = 0; seq < 25; seq++) {
      const lines = original.trimEnd().split('\n'); const e = JSON.parse(lines[seq]!); e.text = 'tampered'; lines[seq] = JSON.stringify(e);
      await writeFile(file, lines.join('\n') + '\n');
      await assert.rejects(l.read(), (err: unknown) => err instanceof OwedError && err.code === 'internal' && err.message.includes(`seq ${seq}:`));
    }
    await writeFile(file, original + '{bad}\n'); await assert.rejects(l.read(), /seq 25/);
  } finally { await r.cleanup(); }
});
