import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { runCommand, runJob } from '../src/exec.ts';
import { repo } from './helpers/repo.ts';
import { commitAt } from './helpers/surface.ts';
import { advanceTrunk, git, revParse } from '../src/git.ts';

const owner = { role: 'owner', id: 'test' } as const;
const parent = { role: 'parent', id: 'test' } as const;
const quote = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;
async function appears(path: string) {
  const end = Date.now() + 15_000;
  while (Date.now() < end) {
    if (await access(path).then(() => true, () => false)) return;
    await new Promise(r => setTimeout(r, 20));
  }
  throw new Error(`command did not start: ${path}`);
}
async function otherProcessLock(cwd: string) {
  const code = `import {Ledger} from ${JSON.stringify(new URL('../src/ledger.ts', import.meta.url).href)}; const l=await Ledger.open(${JSON.stringify(cwd)}); await l.withLock(async()=>{},'lock',undefined,{waitMs:1500});`;
  await promisify(execFile)(process.execPath, ['--input-type=module', '-e', code], { env: process.env, timeout: 2000 });
}

for (const mode of ['attest', 'merge', 'trunk', 'adopt', 'sweep'] as const) {
  test(`LK: ${mode} releases the ledger lock while a measurement blocks on a fifo`, { timeout: 60_000 }, async () => {
    const r = await repo();
    const ac = new AbortController();
    let outcome: Promise<unknown> | undefined;
    try {
      const fifo = join(r.root, 'fifo'), started = join(r.root, 'started'), enabled = join(r.root, 'enabled');
      await promisify(execFile)('mkfifo', [fifo]);
      const run = `if test -e ${quote(enabled)}; then touch ${quote(started)}; read answer < ${quote(fifo)}; fi; echo '# tests 1'; echo '# pass 1'`;
      await commitAt(r.cwd, { flag: 'base' });
      await ops.init({ cwd:r.cwd, as:owner, channel:'flag', plan:JSON.stringify({ version:1, trunk:'main', closure:[],
        invariants: mode === 'merge' || mode === 'trunk' || mode === 'adopt' ? [{ id:'gate', run, reads:['flag'], timeout_s:30 }] : [],
        sweep: mode === 'sweep' ? { run, timeout_s:30, reads:['flag'] } : undefined,
        nodes:[{ id:'a', writes:['flag'], checks:mode === 'attest' ? [{ id:'gate', run, reads:['flag'], timeout_s:30 }] : [] }] }) });
      if (mode === 'attest' || mode === 'merge') {
        const d = await ops.dispatch({ cwd:r.cwd, node:'a', as:parent });
        await commitAt(d.worktree, { flag:'changed' });
        await ops.submit({ cwd:d.worktree, node:'a', as:{role:'writer',id:'a#1'} });
        if (mode === 'merge') await ops.attest({ cwd:r.cwd, node:'a', lease:false });
      } else if (mode === 'adopt') await commitAt(r.cwd, { flag:'changed' });
      await writeFile(enabled, '');
      if (mode === 'attest') outcome = ops.attest({cwd:r.cwd,node:'a',lease:false,signal:ac.signal});
      else if (mode === 'merge') outcome = ops.merge({cwd:r.cwd,node:'a',as:parent,lease:false,signal:ac.signal});
      else if (mode === 'trunk') outcome = ops.attestTrunk({cwd:r.cwd,remeasure:true,all:true,lease:false,signal:ac.signal});
      else if (mode === 'adopt') outcome = ops.adopt({cwd:r.cwd,as:owner,channel:'flag',note:'external change',lease:false,signal:ac.signal});
      else outcome = (await import('../src/sweep.ts')).sweep({cwd:r.cwd,lease:false,signal:ac.signal});
      // Observe rejections immediately; cleanup below still awaits the owned operation.
      void outcome.catch(() => {});
      await appears(started);
      await otherProcessLock(r.cwd);
      await promisify(execFile)('bash', ['-c', `echo release > ${quote(fifo)}`], { timeout:2000 });
      await outcome;
      const entries = await (await Ledger.open(r.cwd)).read();
      assert.ok(entries.some(e => (e.kind === (mode === 'sweep' ? 'sweep' : 'obs')) && 'verdict' in e && e.verdict === 'pass'), 'measurement recorded');
      if (mode === 'merge') assert.equal(entries.at(-1)?.kind, 'merge');
      if (mode === 'adopt') assert.equal(entries.at(-1)?.kind, 'adopt');
      assert.equal((await ops.verify({cwd:r.cwd})).ok, true);
    } finally { ac.abort(); await outcome?.catch(() => {}); await r.cleanup(); }
  });
}

test('LKR #2310: only advanceTrunk ff-only is allowed under the ledger lock; trunk stays attached', async () => {
  const r = await repo();
  try {
    const before = await commitAt(r.cwd,{flag:'base'});
    const branch = join(r.root,'candidate');
    await git(r.cwd,['worktree','add','-b','candidate',branch,before]);
    const after = await commitAt(branch,{flag:'changed'});
    const l = await Ledger.open(r.cwd);
    await l.withLock(async () => {
      // An arbitrary merge, even ff-only, must not borrow advanceTrunk's exemption.
      assert.throws(() => git(r.cwd,['merge','--ff-only',after]), /ledger lock/);
      await advanceTrunk(r.cwd,'main',before,after);
    });
    assert.equal(await revParse(r.cwd,'HEAD'),after);
    assert.equal((await git(r.cwd,['symbolic-ref','HEAD'])).stdout.trim(),'refs/heads/main');
  } finally { await r.cleanup(); }
});

test('LK: the command runner rejects the current ledger lock context before spawning', async () => {
  const r = await repo();
  try {
    const l = await Ledger.open(r.cwd), marker = join(r.root, 'spawned');
    const plan: import('../src/types.ts').Plan = {version:1,trunk:'main',closure:[],invariants:[],nodes:[]};
    const internal = (e: unknown) => (e as {code?: string}).code === 'internal' && /ledger lock/.test(String(e));
    await l.withLock(async () => {
      await assert.rejects(runCommand({plan}, `touch ${quote(marker)}`, r.cwd, 2), internal);
      const wrapped = { ...plan, exec:{wrap:'bash -lc {cmd}'} };
      await assert.rejects(runCommand({plan:wrapped}, `touch ${quote(marker)}`, r.cwd, 2), internal);
      const other = await Ledger.open(r.cwd);
      await assert.rejects(runJob({cwd:r.cwd,plan,ledger:other},{kind:'check',subject:'a',obligation:'check:x',key:'x',commit:'HEAD',base:'HEAD'}),internal);
      assert.throws(() => git(r.cwd,['reset','--hard']),internal);
      await other.withLock(async () => {
        await assert.rejects(runCommand({plan},'true',r.cwd,2),internal);
      },'merge');
    });
    await l.withLock(async () => {
      assert.equal((await runCommand({plan},'true',r.cwd,2)).code,0);
    },'merge');
    assert.equal(await access(marker).then(() => true, () => false), false);
  } finally { await r.cleanup(); }
});
