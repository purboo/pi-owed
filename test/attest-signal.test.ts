// D16: a signal ends the checks a command started (owed attest/merge/init/adopt, `owed drive --once`), the pi tools
// pass their abort signal, and the CLI removes its handlers after the command. SIGKILL is out of scope (SPEC §10).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owedExtension from '../src/extension.ts';
import * as ops from '../src/ops.ts';
import { main } from '../src/cli.ts';
import { Ledger } from '../src/ledger.ts';
import { Dsa } from '../src/dsa.ts';
import { drive } from '../src/drive-run.ts';
import { OwedError } from '../src/errors.ts';
import { revParse } from '../src/git.ts';
import type { Entry } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt, identity } from './helpers/surface.ts';

const OWED = fileURLToPath(new URL('../bin/owed.js', import.meta.url));
const FAKE = fileURLToPath(new URL('./fixtures/fake-dsa.mjs', import.meta.url));
const owner = { role: 'owner' as const, id: 'human' };
const parent = { role: 'parent' as const, id: 'main' };
const SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
type Repo = Awaited<ReturnType<typeof repo>>;
type Pids = { check: number; owed: number };

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
/** A check that records `<its pid> <owed's pid>` in `file`, then sleeps 60 s (with `only`: only on a tree that has that file). */
const slowRun = (file: string, only?: string) => `${only ? `test -f ${only} || exit 0; ` : ''}echo $$ $PPID > '${file}'; sleep 60`;
async function pidsFrom(file: string, ms = 60_000): Promise<Pids> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const m = /^(\d+) (\d+)\s*$/.exec(await readFile(file, 'utf8').catch(() => ''));
    if (m) return { check: Number(m[1]), owed: Number(m[2]) };
    await sleep(50);
  }
  throw new Error(`${file} did not appear within ${ms} ms`);
}
/** Alive and not a zombie (a killed orphan can briefly remain one under the host's init). */
function alive(pid: number): boolean {
  try { process.kill(pid, 0); } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
  try { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); return stat.charAt(stat.lastIndexOf(')') + 2) !== 'Z'; } catch { return false; }
}
async function gone(pid: number, ms = 5000): Promise<boolean> {
  const end = Date.now() + ms;
  while (alive(pid)) { if (Date.now() > end) return false; await sleep(50); }
  return true;
}
/** Test cleanup: end leftovers (a check leads its own process group) so a failing test does not leak a 60 s sleep. */
function reap(...pids: (number | undefined)[]): void {
  for (const pid of pids) if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
}
async function within<T>(p: Promise<T>, ms: number): Promise<T | 'timeout'> {
  let t: NodeJS.Timeout | undefined;
  try { return await Promise.race([p, new Promise<'timeout'>(r => { t = setTimeout(() => r('timeout'), ms); })]); } finally { clearTimeout(t); }
}
/** The owed CLI as a child process (own stdio pipes, no NODE_TEST_CONTEXT). */
function owedChild(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}) {
  const e: NodeJS.ProcessEnv = { ...process.env, ...identity, ...env }; delete e.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [OWED, ...args], { cwd, env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  child.stdout.on('data', (b: Buffer) => { stdout += b; }); child.stderr.on('data', (b: Buffer) => { stderr += b; });
  const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
  return { child, exited, out: () => `stdout:\n${stdout}\nstderr:\n${stderr}`, stderr: () => stderr };
}
const entries = async (cwd: string): Promise<Entry[]> => (await Ledger.open(cwd)).read();
const obsOf = (es: Entry[], obligation: string) => es.filter((e): e is Extract<Entry, { kind: 'obs' }> => e.kind === 'obs' && e.obligation === obligation);

/**
 * A repository with node `a` dispatched, committed (a.txt) and submitted, so `owed attest a` runs its checks in plan
 * order, then `writes`. `make` gets the temp root (for pid files) and returns the checks and invariants.
 */
async function submitted(make: (root: string) => { checks?: object[]; invariants?: object[] }): Promise<Repo> {
  const r = await repo();
  try {
    const { checks = [], invariants = [] } = make(r.root);
    const plan = { version: 1, trunk: 'main', closure: [], invariants, nodes: [{ id: 'a', writes: ['a.txt'], checks, review: { count: 0, min_rank: 1 } }] };
    await commitAt(r.cwd, { README: 'x\n' });
    await ops.init({ cwd: r.cwd, plan: JSON.stringify(plan), as: owner, channel: 'flag' });
    const d = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
    await commitAt(d.worktree, { 'a.txt': 'a\n' });
    await ops.submit({ cwd: d.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
    return r;
  } catch (e) { await r.cleanup(); throw e; }
}

for (const [sig, code] of [['SIGTERM', 143], ['SIGINT', 130]] as const) {
  test(`D16.2: ${sig} to \`owed attest\` ends its running check: exit ${code}, the check is gone, nothing recorded for the run`, { timeout: 120_000 }, async () => {
    const r = await submitted(root => ({ checks: [{ id: 'slow', run: slowRun(join(root, 'pid')) }] }));
    let pids: Pids | undefined;
    try {
      const before = await entries(r.cwd);
      const c = owedChild(r.cwd, ['attest', 'a']);
      pids = await pidsFrom(join(r.root, 'pid'));
      assert.equal(pids.owed, c.child.pid, 'the check is a child of owed attest');
      c.child.kill(sig);
      assert.equal(await within(c.exited, 5000), code, c.out());
      assert.match(c.stderr(), new RegExp(`Aborted: ${sig}`));
      assert.ok(await gone(pids.check), 'the check is gone within 5 s');
      const added = (await entries(r.cwd)).slice(before.length);
      assert.deepEqual(added.map(e => e.kind), [], 'no observation for the aborted run (and writes never started)');
      const v = await cli(r.cwd, ['verify']);
      assert.equal(v.code, 0, v.stderr);
    } finally { reap(pids?.check); await r.cleanup(); }
  });
}

test('D16.1: a two-job attest aborted during the second job keeps the first job\'s observation', { timeout: 120_000 }, async () => {
  const r = await submitted(root => ({ checks: [{ id: 'fast', run: 'true' }, { id: 'slow', run: slowRun(join(root, 'pid')) }] }));
  let pids: Pids | undefined;
  try {
    const ac = new AbortController();
    const run = ops.attest({ cwd: r.cwd, node: 'a', signal: ac.signal });
    run.catch(() => {});
    pids = await pidsFrom(join(r.root, 'pid'));
    ac.abort();
    await assert.rejects(run, (e: unknown) => e instanceof OwedError && e.code === 'aborted' && e.message === 'aborted');
    assert.ok(await gone(pids.check), 'the second job\'s check is gone');
    const es = await entries(r.cwd), fast = obsOf(es, 'check:fast');
    assert.equal(fast.length, 1); assert.equal(fast[0]!.verdict, 'pass');
    assert.equal(obsOf(es, 'check:slow').length, 0, 'the aborted run records nothing');
    assert.equal(obsOf(es, 'writes').length, 0, 'no further job starts');
    assert.equal((await ops.verify({ cwd: r.cwd })).ok, true);
  } finally { reap(pids?.check); await r.cleanup(); }
});

test('D16.1: ops.attest (and merge) with an already-aborted signal start nothing', { timeout: 60_000 }, async () => {
  const r = await submitted(root => ({ checks: [{ id: 'mark', run: `touch '${join(root, 'mark')}'` }] }));
  try {
    const mark = join(r.root, 'mark'), before = await entries(r.cwd), trunk = await revParse(r.cwd, 'main');
    const ac = new AbortController(); ac.abort();
    await assert.rejects(ops.attest({ cwd: r.cwd, node: 'a', signal: ac.signal }), (e: unknown) => e instanceof OwedError && e.code === 'aborted');
    await assert.rejects(ops.merge({ cwd: r.cwd, node: 'a', as: parent, signal: ac.signal }), (e: unknown) => e instanceof OwedError && e.code === 'aborted');
    assert.ok(!existsSync(mark), 'no check ran');
    assert.equal((await entries(r.cwd)).length, before.length);
    assert.equal(await revParse(r.cwd, 'main'), trunk);
    // Without a signal the same attest runs the check.
    await ops.attest({ cwd: r.cwd, node: 'a' });
    assert.ok(existsSync(mark));
  } finally { await r.cleanup(); }
});

test('D16.1/2: `owed merge` aborted during its merge-tree check leaves trunk and the ledger unchanged', { timeout: 120_000 }, async () => {
  // The invariant sleeps only on a tree with a.txt: the genesis run passes at once, the merge-result run is the long one.
  const r = await submitted(root => ({ invariants: [{ id: 'slow', run: slowRun(join(root, 'pid'), 'a.txt'), reads: ['a.txt'] }] }));
  let pids: Pids | undefined;
  try {
    assert.equal((await ops.attest({ cwd: r.cwd, node: 'a' })).accepted, true);
    const before = await entries(r.cwd), trunk = await revParse(r.cwd, 'main');
    const c = owedChild(r.cwd, ['merge', 'a']);
    pids = await pidsFrom(join(r.root, 'pid'));
    c.child.kill('SIGTERM');
    assert.equal(await within(c.exited, 5000), 143, c.out());
    assert.match(c.stderr(), /Aborted: SIGTERM/);
    assert.ok(await gone(pids.check), 'the merge-tree check is gone');
    assert.equal(await revParse(r.cwd, 'main'), trunk, 'trunk unchanged');
    const added = (await entries(r.cwd)).slice(before.length);
    assert.deepEqual(added.map(e => e.kind), [], 'no merge entry and no observation of the aborted run');
    const v = await cli(r.cwd, ['verify']);
    assert.equal(v.code, 0, v.stderr);
    assert.equal((await ops.status({ cwd: r.cwd })).nodes.a!.accepted, true, 'the node can still be merged');
  } finally { reap(pids?.check); await r.cleanup(); }
});

test('D16.3: SIGTERM to `owed drive --once` while hold runs a long attest: exit 130, attest and its check gone, lock released', { timeout: 180_000 }, async () => {
  const r = await repo();
  const pidFile = join(r.root, 'pid'), dir = join(r.root, 'dsa'), bin = join(r.root, 'bin');
  let pids: Pids | undefined;
  try {
    await mkdir(join(dir, 'agents'), { recursive: true }); await mkdir(bin);
    await writeFile(join(bin, 'owed'), `#!/bin/sh\nexec "${process.execPath}" "${OWED}" "$@"\n`); await chmod(join(bin, 'owed'), 0o755);
    const env = { FAKE_DSA_DIR: dir, PATH: `${bin}:${process.env.PATH}`, ...identity };
    const plan = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: [{ id: 's', writes: ['s.txt'], checks: [{ id: 'slow', run: slowRun(pidFile), reads: ['s.txt'] }], review: { count: 0, min_rank: 1 } }] };
    await commitAt(r.cwd, { README: 'x\n' });
    await ops.init({ cwd: r.cwd, plan: JSON.stringify(plan), as: owner, channel: 'flag' });
    await writeFile(join(dir, 'agents', 's-writer.sh'), 'set -e\necho s > s.txt; git add s.txt; git commit -qm s; owed submit s\n');
    // In-process passes: dispatch, then launch (the fake writer commits and submits).
    const dsa = new Dsa({ bin: FAKE, env, timeoutMs: 120_000 }), lines: string[] = [];
    for (let i = 0; i < 4 && !(await entries(r.cwd)).some(e => e.kind === 'submit'); i++) await drive({ cwd: r.cwd, once: true, dsa, log: l => lines.push(l), handleSignals: false });
    assert.ok((await entries(r.cwd)).some(e => e.kind === 'submit'), lines.join('\n'));
    const before = await entries(r.cwd);
    // The next pass attests under `hold machine --shared --no-wait`, and the check is slow.
    const c = owedChild(r.cwd, ['drive', '--once'], { ...env, OWED_DSA: FAKE });
    pids = await pidsFrom(pidFile);
    c.child.kill('SIGTERM');
    assert.equal(await within(c.exited, 5000), 130, c.out());
    assert.ok(await gone(pids.owed), '`owed attest` is gone within 5 s');
    assert.ok(await gone(pids.check), 'its check is gone within 5 s');
    assert.ok(!existsSync(join(process.env.OWED_DIR!, 'drive.lock')), 'lock released');
    const added = (await entries(r.cwd)).slice(before.length);
    assert.equal(obsOf(added, 'check:slow').length, 0, 'the aborted check records nothing');
    const v = await cli(r.cwd, ['verify']);
    assert.equal(v.code, 0, v.stderr);
  } finally { reap(pids?.check, pids?.owed); await r.cleanup(); }
});

test('D16.4: the owed_attest tool passes its abort signal: an aborted call is a tool error and records nothing', { timeout: 60_000 }, async () => {
  const r = await submitted(() => ({ checks: [{ id: 'quick', run: 'true' }] }));
  try {
    const tools = new Map<string, ToolDefinition>();
    owedExtension({ registerTool(t: ToolDefinition) { tools.set(t.name, t); }, registerCommand() {} } as unknown as ExtensionAPI);
    const before = await entries(r.cwd), ac = new AbortController(); ac.abort();
    const ctx = { cwd: r.cwd, hasUI: false } as Parameters<ToolDefinition['execute']>[4];
    const out = await tools.get('owed_attest')!.execute('t', { node: 'a', cwd: r.cwd }, ac.signal, undefined, ctx) as Awaited<ReturnType<ToolDefinition['execute']>> & { isError?: boolean };
    assert.equal(out.isError, true);
    assert.match((out.content[0] as { text: string }).text, /^Aborted: aborted/);
    assert.equal((out.details as { code: string }).code, 'aborted');
    assert.equal((await entries(r.cwd)).length, before.length);
  } finally { await r.cleanup(); }
});

test('D16.2: main() removes its signal handlers after attest/merge (in-process calls repeat)', { timeout: 60_000 }, async () => {
  const r = await submitted(() => ({}));
  try {
    const before = SIGNALS.map(s => process.listenerCount(s)), errors: string[] = [];
    const io = { log: () => {}, error: (t: string) => { errors.push(t); } };
    for (let i = 0; i < 2; i++) for (const args of [['attest', 'nope'], ['merge', 'nope']]) assert.equal(await main(args, io), 1, errors.join('\n'));
    assert.deepEqual(SIGNALS.map(s => process.listenerCount(s)), before);
    assert.ok(errors.length === 4 && errors.every(e => /^Refused: Node nope does not exist/.test(e)), errors.join('\n'));
  } finally { await r.cleanup(); }
});
