// 0.7.0 K6 (wais #13): attests and merges run in the background while the driver serves other nodes; `drive.measure`
// caps them, one merge at a time; stop waits, stop-now aborts, --once waits; exit 75 of owed attest is busy; a restarted
// driver retries the attest a dead driver's child still runs; `owed drive --status` lists the in-flight measurements.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as ops from '../src/ops.ts';
import * as plans from '../src/plan.ts';
import { Ledger } from '../src/ledger.ts';
import { Dsa } from '../src/dsa.ts';
import { Driver, drive, procStart } from '../src/drive-run.ts';
import * as bg from '../src/drive-bg.ts';
import { driveStatus, driveStop, driverLine, logPath, renderDriveStatus } from '../src/drive-bg.ts';
import { canonical } from '../src/canon.ts';
import { git } from '../src/git.ts';
import type { Entry } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { identity } from './helpers/surface.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-dsa.mjs', import.meta.url));
const OWED = fileURLToPath(new URL('../bin/owed.js', import.meta.url));
type Line = Record<string, unknown>;
const owner = { role: 'owner', id: 'human' } as const;

const node = (id: string, o: Record<string, unknown> = {}) => ({ id, writes: [`${id}.txt`], checks: [], review: { count: 0, min_rank: 1 }, ...o });
const planOf = (...nodes: object[]) => ({ version: 1, trunk: 'main', closure: [], invariants: [], nodes });
const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
async function until(cond: () => boolean | Promise<boolean>, ms: number, what: string): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await cond()) return; await sleep(100); }
  assert.fail(`timed out after ${ms} ms waiting for: ${what}`);
}
const alive = (pid: number): boolean => { try { process.kill(pid, 0); return true; } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; } };
/** A shell step that records its pid in `mark` and waits until `gate` exists. */
const gated = (mark: string, gate: string): string => `echo $$ > '${mark}'; while [ ! -e '${gate}' ]; do sleep 0.1; done`;
const writer = (id: string) => `echo ${id} > ${id}.txt; git add ${id}.txt; git commit -qm ${id}; owed submit ${id}`;

/** `make(path)`: the initial plan; `path(name)` is `<gates>/<name>` (gates and pid marks of gated steps). */
async function rig(make: (path: (name: string) => string) => object) {
  const r = await repo();
  const dir = join(r.root, 'dsa'), bin = join(r.root, 'bin'), gates = join(r.root, 'gates');
  const plan = make(name => join(gates, name));
  await mkdir(join(dir, 'agents'), { recursive: true }); await mkdir(bin); await mkdir(gates);
  await writeFile(join(bin, 'owed'), `#!/bin/sh\nexec "${process.execPath}" "${OWED}" "$@"\n`); await chmod(join(bin, 'owed'), 0o755);
  const env = { FAKE_DSA_DIR: dir, PATH: `${bin}:${process.env.PATH}`, ...identity };
  await r.put('plan.json', JSON.stringify(plan)); await r.put('README', 'x\n'); await r.commit();
  await ops.init({ cwd: r.cwd, as: owner, channel: 'flag', plan: JSON.stringify(plan) });
  const dsa = new Dsa({ bin: FAKE, env, timeoutMs: 120_000 });
  const loops: { stop: () => void; done: Promise<number> }[] = [];
  const self = {
    ...r, dir, env, dsa, gates,
    /** `<gates>/<name>`: a gate (open when it exists) or a pid mark. */
    path: (name: string) => join(gates, name),
    open: (name: string) => writeFileSync(join(gates, name), ''),
    pid: (name: string) => Number(readFileSync(join(gates, name), 'utf8').trim()),
    agent: (name: string, body: string) => writeFile(join(dir, 'agents', `${name}.sh`), `set -e\n${body}\n`),
    entries: async (): Promise<Entry[]> => (await Ledger.open(r.cwd)).read(),
    plan: (p: object) => ops.planSet({ cwd: r.cwd, as: owner, channel: 'flag', plan: JSON.stringify(p) }),
    /** One in-process `--once` pass (text lines). */
    async once(o: { owed?: string[]; dsa?: Dsa } = {}) {
      const lines: string[] = [];
      await drive({ cwd: r.cwd, once: true, dsa: o.dsa ?? dsa, owed: o.owed, log: l => lines.push(l), handleSignals: false });
      return lines;
    },
    /** `--once` passes until `cond` holds (checked before each pass). */
    async onceUntil(n: number, cond: () => Promise<boolean>, o: { owed?: string[]; dsa?: Dsa } = {}) {
      const out: string[] = [];
      for (let i = 0; i < n; i++) { if (await cond()) return; out.push(...await self.once(o)); }
      assert.ok(await cond(), out.join('\n'));
    },
    /** The in-process `--json` loop; its lines are parsed live and appended to the background log (for --status). */
    loop(o: { owed?: string[]; passMs?: number } = {}) {
      const lines: Line[] = [], ac = new AbortController(), log = logPath(process.env.OWED_DIR!);
      mkdirSync(dirname(log), { recursive: true });
      const done = drive({ cwd: r.cwd, json: true, dsa, owed: o.owed, log: l => { appendFileSync(log, `${l}\n`); lines.push(JSON.parse(l) as Line); }, pollMs: 50, passMs: o.passMs ?? 300, handleSignals: false, signal: ac.signal });
      const state = { settled: false };
      void done.finally(() => { state.settled = true; }).catch(() => undefined);
      const h = { lines, stop: () => ac.abort(), done, settled: () => state.settled, text: () => lines.map(l => JSON.stringify(l)).join('\n') };
      loops.push(h);
      return h;
    },
    async done() {
      // Open every gate a test may have left closed, stop its loops, then clean up.
      for (const g of ['gate', 'gate-a', 'gate-b', 'gate-inv', 'gate-check']) writeFileSync(join(gates, g), '');
      for (const l of loops) { l.stop(); await l.done.catch(() => undefined); }
      await r.cleanup();
    },
  };
  return self;
}
const started = (lines: Line[], what: 'attest' | 'merge', id?: string) => lines.filter(l => l.do === what && l.outcome === 'started' && (id === undefined || l.node === id));
const merged = (es: Entry[], id: string) => es.some(e => e.kind === 'merge' && e.node === id);
const halts = (es: Entry[]) => es.filter(e => e.kind === 'halt');

test('K6 wais #13: while node a merge measures (slow invariant), node b is dispatched and its writer launched; status lists the merge', { timeout: 240_000 }, async () => {
  const v1 = (path: (n: string) => string) => ({ ...planOf(node('a')), invariants: [{ id: 'slow', run: `if [ -f a.txt ]; then ${gated(path('inv'), path('gate'))}; fi; true`, reads: ['a.txt'] }] });
  const f = await rig(v1);
  const f0 = { mark: f.path('inv'), gate: f.path('gate') };
  try {
    await f.agent('a-writer', writer('a'));
    const l = f.loop();
    await until(() => existsSync(f0.mark), 60_000, "a's merge measures the invariant");
    assert.equal(started(l.lines, 'merge', 'a').length, 1, l.text());
    const st = await driveStatus({ cwd: f.cwd });
    assert.deepEqual(st.measuring?.map(m => [m.node, m.do]), [['a', 'merge']], JSON.stringify(st));
    assert.match(renderDriveStatus(st), /^measuring: a merge since \d{4}-\d\d-\d\dT/m);
    assert.match(await driverLine(f.cwd), /; measuring a merge since \S+; /);
    // A plan update adds b while a's merge is still measuring: the driver dispatches b and launches its writer.
    const p1 = v1(f.path);
    await f.plan({ ...p1, nodes: [...p1.nodes, node('b')] });
    await until(async () => (await f.entries()).some(e => e.kind === 'launch' && e.node === 'b'), 30_000, "b's writer launch while a merges");
    assert.ok(!existsSync(f0.gate) && alive(f.pid('inv')), "a's merge is still measuring");
    assert.ok(!merged(await f.entries(), 'a'));
    f.open('gate');
    await until(async () => merged(await f.entries(), 'a'), 120_000, 'a merged');
    const es = await f.entries();
    const launchB = es.find(e => e.kind === 'launch' && e.node === 'b')!, mergeA = es.find(e => e.kind === 'merge' && e.node === 'a')!;
    assert.ok(launchB.seq < mergeA.seq, `${launchB.seq} < ${mergeA.seq}`);
    assert.deepEqual(halts(es), []);
    l.stop();
    assert.equal(await l.done, 0, l.text());
    assert.equal(l.lines.at(-1)?.reason, 'stopped');
  } finally { await f.done(); }
});

test('K6 drive.measure (default 2) caps the attests in flight: 2 of 3 run, the third starts when one ends', { timeout: 240_000 }, async () => {
  const marks = (f: { gates: string }) => readdirSync(f.gates).filter(n => n.startsWith('m-'));
  const f = await rig(path => ({ ...planOf(...['x', 'y', 'z'].map(id => node(id, { checks: [{ id, run: gated(path(`m-${id}`), path('gate')), reads: [`${id}.txt`] }] }))) }));
  try {
    for (const id of ['x', 'y', 'z']) await f.agent(`${id}-writer`, writer(id));
    const l = f.loop();
    // Two attests start; the second may wait for the first's attest lock (0.6.x takes one per repository, K1 one per
    // node), so the check marks show at least one running.
    await until(() => started(l.lines, 'attest').length >= 2 && marks(f).length >= 1, 60_000, 'two attests run');
    await until(async () => (await f.entries()).filter(e => e.kind === 'submit').length === 3, 60_000, 'all three submitted');
    await sleep(1500);
    assert.equal(started(l.lines, 'attest').length, 2, l.text());
    assert.equal((await driveStatus({ cwd: f.cwd })).measuring?.length, 2);
    f.open('gate');
    assert.equal(await l.done, 0, l.text());
    const es = await f.entries();
    assert.ok(['x', 'y', 'z'].every(id => merged(es, id)), l.text());
    assert.equal(started(l.lines, 'attest').length, 3, l.text());
    assert.deepEqual(halts(es), []);
    assert.equal(l.lines.at(-1)?.reason, 'idle');
  } finally { await f.done(); }
});

test('K6 drive.measure: parsed only when set (a plan without it keeps its bytes), integer >= 1, default 2', async () => {
  const base = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: [{ id: 'a', writes: ['a.txt'] }] };
  const cap = (plans as unknown as { measureCap?: (p: unknown) => number }).measureCap;
  assert.equal(typeof cap, 'function', 'measureCap is exported');
  let p = plans.parsePlan(JSON.stringify({ ...base, drive: { max: 2, measure: 3 } }));
  assert.equal(p.drive?.measure, 3); assert.equal(cap!(p), 3);
  p = plans.parsePlan(JSON.stringify({ ...base, drive: { max: 2 } }));
  assert.equal(cap!(p), 2);
  assert.doesNotMatch(canonical(p), /measure/, 'a plan without measure keeps its canonical bytes');
  assert.equal(cap!(plans.parsePlan(JSON.stringify(base))), 2);
  for (const bad of [0, -1, 1.5, '2']) assert.throws(() => plans.parsePlan(JSON.stringify({ ...base, drive: { measure: bad } })), /drive\.measure: expected integer >= 1/);
});

test('K6 at most one merge in flight: q waits for p although measure allows two', { timeout: 240_000 }, async () => {
  const f = await rig(path => ({ ...planOf(node('p'), node('q')), invariants: [{ id: 'slow', run: `if [ -f p.txt ] || [ -f q.txt ]; then echo $$ > '${path('m-')}'$$; while [ ! -e '${path('gate')}' ]; do sleep 0.1; done; fi; true`, reads: ['p.txt', 'q.txt'] }] }));
  try {
    await f.agent('p-writer', writer('p')); await f.agent('q-writer', writer('q'));
    const l = f.loop();
    const marks = () => readdirSync(f.gates).filter(n => n.startsWith('m-'));
    await until(() => marks().length >= 1, 60_000, 'a merge measures');
    await until(async () => { const s = await ops.status({ cwd: f.cwd }); return !!s.nodes.p?.accepted && !!s.nodes.q?.accepted; }, 60_000, 'p and q accepted');
    await sleep(1500);
    assert.equal(marks().length, 1, marks().join(' '));
    assert.equal(started(l.lines, 'merge').length, 1, l.text());
    f.open('gate');
    assert.equal(await l.done, 0, l.text());
    const es = await f.entries();
    assert.ok(merged(es, 'p') && merged(es, 'q'), l.text());
    assert.deepEqual(halts(es), []);
  } finally { await f.done(); }
});

test('K6 stop waits for the in-flight attest and handles it, then stopped', { timeout: 180_000 }, async () => {
  const f = await rig(path => planOf(node('s', { checks: [{ id: 's', run: gated(path('check'), path('gate')), reads: ['s.txt'] }] })));
  try {
    await f.agent('s-writer', writer('s'));
    const l = f.loop();
    await until(() => existsSync(f.path('check')), 60_000, "s's attest runs");
    l.stop();
    await sleep(1000);
    assert.equal(l.settled(), false, 'the stop waits for the attest');
    assert.deepEqual((await driveStatus({ cwd: f.cwd })).measuring?.map(m => [m.node, m.do]), [['s', 'attest']]);
    const before = l.lines.length;
    f.open('gate');
    assert.equal(await l.done, 0, l.text());
    const after = l.lines.slice(before).map(x => x.event ?? `${x.do} ${x.node} ${x.outcome}`);
    assert.deepEqual(after, ['attest s done', 'stopped', 'exit'], l.text());
    assert.equal(l.lines.at(-1)?.reason, 'stopped');
    assert.ok((await f.entries()).some(e => e.kind === 'obs' && e.subject === 's' && e.obligation === 'check:s' && e.verdict === 'pass'));
    assert.ok(!(await f.entries()).some(e => e.kind === 'merge'), 'nothing new started after the stop');
  } finally { await f.done(); }
});

test('K6 stop --now aborts an in-flight merge and attest: their check processes are gone, killed exit record, lock released', { timeout: 240_000 }, async () => {
  const make = (path: (n: string) => string) => ({ ...planOf(node('m')), invariants: [{ id: 'slow', run: `if [ -f m.txt ]; then ${gated(path('inv'), path('gate-inv'))}; fi; true`, reads: ['m.txt'] }] });
  const f = await rig(make);
  try {
    const v1 = make(f.path);
    await f.agent('m-writer', writer('m')); await f.agent('a-writer', writer('a'));
    await f.onceUntil(8, async () => !!(await ops.status({ cwd: f.cwd })).nodes.m?.accepted);
    await f.plan({ ...v1, nodes: [...v1.nodes, node('a', { checks: [{ id: 'a', run: gated(f.path('check'), f.path('gate-check')), reads: ['a.txt'] }] })] });
    const trunk = (await git(f.cwd, ['rev-parse', 'refs/heads/main'])).stdout.trim();
    const child = spawn(process.execPath, [OWED, 'drive', '--json'], { cwd: f.cwd, env: { ...process.env, ...f.env, OWED_DSA: FAKE }, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = ''; child.stdout.on('data', b => { stdout += b; }); child.stderr.on('data', b => { stderr += b; });
    const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
    try {
      await until(() => existsSync(f.path('inv')) && existsSync(f.path('check')), 90_000, `m's merge and a's attest both measure\n${stdout}${stderr}`);
      const pids = [f.pid('inv'), f.pid('check')];
      assert.ok(pids.every(alive));
      const r = await driveStop({ cwd: f.cwd, now: true });
      assert.equal(r.state, 'stopped', JSON.stringify(r));
      assert.equal(await exited, 130, `${stdout}\n${stderr}`);
      const lines = stdout.trim().split('\n').map(x => JSON.parse(x) as Line);
      assert.deepEqual(lines.slice(-2).map(x => x.event), ['killed', 'exit'], stdout);
      assert.equal(lines.at(-1)!.code, 130); assert.equal(lines.at(-1)!.reason, 'killed');
      assert.ok(started(lines, 'merge', 'm').length === 1 && started(lines, 'attest', 'a').length === 1, stdout);
      await until(() => !pids.some(alive), 3000, 'the check processes of the merge and the attest are gone');
      assert.ok(!existsSync(join(process.env.OWED_DIR!, 'drive.lock')), 'lock released');
      assert.ok(!merged(await f.entries(), 'm'), 'the aborted merge recorded no merge');
      assert.equal((await git(f.cwd, ['rev-parse', 'refs/heads/main'])).stdout.trim(), trunk, 'trunk did not move');
    } finally { if (child.exitCode === null) child.kill('SIGKILL'); }
  } finally { await f.done(); }
});

test('K6 --once waits for the measurement it started and prints its completion', { timeout: 180_000 }, async () => {
  const f = await rig(path => planOf(node('o', { checks: [{ id: 'o', run: gated(path('check'), path('gate')), reads: ['o.txt'] }] })));
  try {
    await f.agent('o-writer', writer('o'));
    await f.onceUntil(4, async () => (await f.entries()).some(e => e.kind === 'submit'));
    const t0 = Date.now();
    const timer = setTimeout(() => f.open('gate'), 1500);
    const lines = await f.once();
    clearTimeout(timer);
    assert.ok(Date.now() - t0 >= 1400, 'returned only after the attest ended');
    const s = lines.findIndex(x => /^attest o: started$/.test(x)), d = lines.findIndex(x => /^attest o: done — accepted$/.test(x));
    assert.ok(s >= 0 && d > s, lines.join('\n'));
    assert.ok((await f.entries()).some(e => e.kind === 'obs' && e.subject === 'o' && e.verdict === 'pass'));
  } finally { await f.done(); }
});

test('K6 exit 75 of owed attest (another attest of the node runs) is busy and retried, never a halt', { timeout: 180_000 }, async () => {
  const f = await rig(() => planOf(node('k', { checks: [{ id: 'k', run: 'test -f k.txt', reads: ['k.txt'] }] })));
  try {
    await f.agent('k-writer', writer('k'));
    await f.onceUntil(4, async () => (await f.entries()).some(e => e.kind === 'submit'));
    const busy = join(f.root, 'busy-owed');
    await writeFile(busy, '#!/bin/sh\necho "attest of $2 is already running (pid 4242 on h since 2026-10-10T16:03:00.000Z); its observations will appear in owed why $2" >&2\nexit 75\n'); await chmod(busy, 0o755);
    // Without dsa the driver runs `owed attest` itself (no hold): its exit 75 is owed's busy exit.
    const real = new Dsa({ bin: FAKE, env: f.env, timeoutMs: 120_000 }), direct = new Dsa({ bin: join(f.root, 'no-dsa'), env: f.env, timeoutMs: 120_000 });
    for (const k of ['inspect', 'describe', 'request', 'run', 'send', 'events'] as const) (direct as unknown as Record<string, unknown>)[k] = (real[k] as (...a: unknown[]) => unknown).bind(real);
    for (let i = 0; i < 2; i++) {
      const out = (await f.once({ owed: [busy], dsa: direct })).join('\n');
      assert.match(out, /^attest k: busy — another attest of k is running, retry next pass: attest of k is already running \(pid 4242/m, out);
    }
    // Through hold, exit 75 of the command is the same busy result.
    const held = (await f.once({ owed: [busy] })).join('\n');
    assert.match(held, /^attest k: busy — another attest of k is running, retry next pass: /m, held);
    assert.deepEqual(halts(await f.entries()), []);
    await f.onceUntil(6, async () => merged(await f.entries(), 'k'), { dsa: direct });
    assert.deepEqual(halts(await f.entries()), []);
  } finally { await f.done(); }
});

test('K6 restart: a killed driver leaves its attest child running; the new driver gets busy (75), retries, and merges', { timeout: 240_000 }, async () => {
  const f = await rig(path => planOf(node('r', { checks: [{ id: 'r', run: gated(path('check'), path('gate')), reads: ['r.txt'] }] })));
  try {
    await f.agent('r-writer', writer('r'));
    await f.onceUntil(4, async () => (await f.entries()).some(e => e.kind === 'submit'));
    const first = spawn(process.execPath, [OWED, 'drive', '--json'], { cwd: f.cwd, env: { ...process.env, ...f.env, OWED_DSA: FAKE }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out1 = ''; first.stdout.on('data', b => { out1 += b; }); first.stderr.on('data', b => { out1 += b; });
    const gone = new Promise(resolve => first.on('exit', resolve));
    await until(() => existsSync(f.path('check')), 60_000, `the first driver's attest runs\n${out1}`);
    first.kill('SIGKILL'); await gone;
    const check = f.pid('check');
    assert.ok(alive(check), "the dead driver's attest child still runs");
    // 0.7.0 K1: the attest of a node that is already being attested exits 75 at once (the real owed, through hold).
    const second = (await f.once()).join('\n');
    assert.match(second, /^attest r: busy — another attest of r is running, retry next pass: attest of r is already running/m, second);
    assert.deepEqual(halts(await f.entries()), []);
    f.open('gate');
    await until(async () => (await f.entries()).some(e => e.kind === 'obs' && e.subject === 'r' && e.obligation === 'check:r' && e.verdict === 'pass'), 60_000, "the orphan attest's observation lands");
    await until(() => !alive(check), 10_000, 'the orphan attest ended');
    await f.onceUntil(6, async () => merged(await f.entries(), 'r'));
    assert.deepEqual(halts(await f.entries()), []);
  } finally { await f.done(); }
});

test('K6 status, /owed and owed_drive status list the in-flight measurements read from the log', async () => {
  const r = await repo();
  try {
    const dir = process.env.OWED_DIR!, log = logPath(dir);
    await mkdir(dirname(log), { recursive: true });
    const start = procStart(process.pid);
    await writeFile(join(dir, 'drive.lock'), JSON.stringify({ pid: process.pid, ...(start ? { start } : {}), host: hostname(), at: '2026-10-10T16:00:00.000Z', token: 't' }));
    const t = (m: number) => `2026-10-10T16:0${m}:00.000Z`;
    const lines: Line[] = [
      { do: 'attest', node: 'old', outcome: 'started', at: t(0) }, { event: 'exit', code: 0, reason: 'stopped', at: t(0) },
      { do: 'attest', node: 'a', outcome: 'started', at: t(1) }, { do: 'merge', node: 'b', outcome: 'started', at: t(2) },
      { do: 'attest', node: 'c', outcome: 'started', at: t(3) }, { do: 'launch', node: 'd', outcome: 'applied' },
      { do: 'attest', node: 'c', outcome: 'busy', detail: 'x' },
      { do: 'attest', node: 'e', outcome: 'started', at: t(4) }, { do: 'attest', node: 'e', outcome: 'done', detail: 'accepted' },
      { do: 'merge', node: 'f', outcome: 'started', at: t(5) }, { do: 'merge', node: 'f', outcome: 'retry', detail: 'merge refused (trunk changed (CAS): x); retry next pass' },
      { do: 'notify', node: 'trunk', scope: 'repo', outcome: 'notify', text: 'trunk main moved outside owed' },
    ];
    await writeFile(log, lines.map(l => `${JSON.stringify(l)}\n`).join(''));
    const s = await driveStatus({ cwd: r.cwd });
    assert.equal(s.running, true);
    assert.deepEqual(s.measuring, [{ node: 'a', do: 'attest', since: t(1) }, { node: 'b', do: 'merge', since: t(2) }]);
    const text = renderDriveStatus(s);
    assert.match(text, new RegExp(`^measuring: a attest since ${t(1)}\\nmeasuring: b merge since ${t(2)}$`, 'm'), text);
    assert.match(await driverLine(r.cwd), new RegExp(`^Driver: running pid ${process.pid} since \\S+; measuring a attest since ${t(1)}, b merge since ${t(2)}; `));
    // The started line reads as text too; once everything ended (or the driver exited), nothing is listed.
    assert.match(readFileSync(log, 'utf8'), /"outcome":"started"/);
    await writeFile(log, `${JSON.stringify({ do: 'attest', node: 'a', outcome: 'started', at: t(1) })}\n${JSON.stringify({ event: 'killed' })}\n`);
    assert.equal((await driveStatus({ cwd: r.cwd })).measuring, undefined);
    assert.doesNotMatch(await driverLine(r.cwd), /measuring/);
  } finally { await r.cleanup(); }
});

// ---------- review #785 ----------
test('#785 (1, 3): an attest that always exits 75 runs at most once per timed pass; every started line has its busy line; status stops listing it', { timeout: 180_000 }, async () => {
  const f = await rig(() => planOf(node('k', { checks: [{ id: 'k', run: 'test -f k.txt', reads: ['k.txt'] }] })));
  try {
    await f.agent('k-writer', writer('k'));
    await f.onceUntil(4, async () => (await f.entries()).some(e => e.kind === 'submit'));
    const count = join(f.root, 'busy-count'), busy = join(f.root, 'busy-owed');
    await writeFile(busy, `#!/bin/sh\necho x >> '${count}'\necho "attest of $2 is already running (pid 4242 on h since 2026-10-10T16:03:00.000Z); its observations will appear in owed why $2" >&2\nexit 75\n`); await chmod(busy, 0o755);
    const runs = () => existsSync(count) ? readFileSync(count, 'utf8').split('\n').filter(Boolean).length : 0;
    const passMs = 400, t0 = Date.now();
    const l = f.loop({ owed: [busy], passMs });
    await until(() => runs() >= 3, 30_000, 'the busy attest is retried');
    // Between retries nothing is in flight: status does not keep listing the ended attest.
    await until(async () => (await driveStatus({ cwd: f.cwd })).measuring === undefined, 5_000, 'status lists no measurement between busy retries');
    await sleep(2500);
    l.stop();
    assert.equal(await l.done, 0, l.text());
    const elapsed = Date.now() - t0, n = runs();
    assert.ok(n <= Math.ceil(elapsed / passMs) + 2, `at most once per timed pass: ${n} runs in ${elapsed} ms (passMs ${passMs})\n${l.text()}`);
    const lines = l.lines;
    assert.equal(started(lines, 'attest', 'k').length, n, l.text());
    assert.equal(lines.filter(x => x.do === 'attest' && x.node === 'k' && x.outcome === 'busy').length, n, 'every started attest got its busy line');
    // Looked up at run time, so the base (without it) fails by assertion rather than at import.
    const measuringOf = (bg as unknown as { measuringOf?: (lines: string[]) => unknown[] }).measuringOf;
    assert.equal(typeof measuringOf, 'function');
    assert.deepEqual(measuringOf!(lines.filter(x => x.event !== 'exit').map(x => JSON.stringify(x))), []);
    assert.deepEqual(halts(await f.entries()), []);
  } finally { await f.done(); }
});

test('#785 (2): the driver\'s own merge appending while a pass observes is no trunk drift (no notify), and the merge is reported', { timeout: 180_000 }, async () => {
  const armed = (path: (n: string) => string) => `[ -e '${path('armed')}' ]`;
  const f = await rig(path => ({ ...planOf(node('a'), node('b')), invariants: [{ id: 'slow', run: `if [ -f a.txt ] && ${armed(path)}; then ${gated(path('inv'), path('gate'))}; fi; true`, reads: ['a.txt'] }] }));
  try {
    await f.agent('a-writer', writer('a'));   // b's writer has no script: it stays running, so every pass inspects it
    await f.onceUntil(6, async () => !!(await ops.status({ cwd: f.cwd })).nodes.a?.accepted && (await f.entries()).some(e => e.kind === 'launch' && e.node === 'b'));
    f.open('armed');
    const lines: string[] = [], trap = { on: false, hit: false };
    const entries = f.entries;
    /** Forced interleaving: b's describe returns only after a's merge appended (trunk moved past the loaded state). */
    class Late extends Dsa {
      override async inspect(rid: string) {
        if (trap.on && /:b:1:writer$/.test(rid)) {
          trap.on = false; trap.hit = true;
          f.open('gate');
          await until(async () => (await entries()).some(e => e.kind === 'merge' && e.node === 'a'), 60_000, "a's merge appended");
        }
        return super.inspect(rid);
      }
    }
    const d = new Driver({ cwd: f.cwd, log: l => lines.push(l), dsa: new Late({ bin: FAKE, env: f.env, timeoutMs: 120_000 }), session: null });
    assert.equal(typeof (d as unknown as { settle?: unknown }).settle, 'function', 'the driver runs measurements in the background (K6)');
    await d.pass();
    assert.match(lines.join('\n'), /^merge a: started$/m);
    await until(() => existsSync(f.path('inv')), 60_000, "a's merge measures");
    trap.on = true;
    await d.pass();
    assert.ok(trap.hit, 'the second pass described b while the merge appended');
    await d.settle();
    const out = lines.join('\n');
    assert.doesNotMatch(out, /moved outside owed|rewound|drift/, out);
    assert.match(out, /^merge a: merged — trunk [0-9a-f]{12}$/m, out);
    assert.ok(merged(await f.entries(), 'a'));
    assert.deepEqual(halts(await f.entries()), []);
  } finally { await f.done(); }
});

// ---------- K4 refusals in the driver (Parent answers 17:1x, item 6) ----------
/** Node a (check ca) with a gated invariant on its merge tree, armed by `<gates>/armed`; `extra` invariants appended. */
const k4Plan = (path: (n: string) => string, o: { extra?: object[]; check?: string } = {}) => ({
  ...planOf(node('a', { checks: [{ id: 'ca', run: o.check ?? 'true', reads: ['a.txt'] }] })),
  invariants: [{ id: 'slow', run: `if [ -f a.txt ] && [ -e '${path('armed')}' ]; then ${gated(path('inv'), path('gate'))}; fi; true`, reads: ['a.txt'] }, ...(o.extra ?? [])],
});
/** Node a accepted; a Driver starts its merge; `during` runs while the merge measures; then the merge ends and is handled. */
async function k4Merge(during: (f: Awaited<ReturnType<typeof rig>>) => Promise<unknown>) {
  const f = await rig(path => k4Plan(path));
  try {
    await f.agent('a-writer', writer('a'));
    await f.onceUntil(6, async () => !!(await ops.status({ cwd: f.cwd })).nodes.a?.accepted);
    f.open('armed');
    const lines: string[] = [];
    const d = new Driver({ cwd: f.cwd, log: l => lines.push(l), dsa: f.dsa, session: null });
    assert.equal(typeof (d as unknown as { settle?: unknown }).settle, 'function', 'the driver runs measurements in the background (K6)');
    await d.pass();
    await until(() => existsSync(f.path('inv')), 60_000, "a's merge measures");
    await during(f);
    f.open('gate');
    await d.settle();
    return { f, d, lines };
  } catch (e) { await f.done(); throw e; }
}

test('K4 in the driver: `not measured` (an invariant added while the merge measured) is a retry, no halt; the next pass merges', { timeout: 180_000 }, async () => {
  const r = await k4Merge(f => f.plan(k4Plan(f.path, { extra: [{ id: 'extra', run: 'true', reads: ['a.txt'] }] })));
  try {
    const out = r.lines.join('\n');
    assert.match(out, /^merge a: retry — merge refused \(.*not measured: trunk\/inv:extra .*\); retry next pass$/m, out);
    assert.deepEqual(halts(await r.f.entries()), []);
    for (let i = 0; i < 4 && !merged(await r.f.entries(), 'a'); i++) { await r.d.pass(); await r.d.settle(); }
    assert.ok(merged(await r.f.entries(), 'a'), r.lines.join('\n'));
    assert.deepEqual(halts(await r.f.entries()), []);
  } finally { await r.f.done(); }
});

test('K4 in the driver: a candidate invalidated by a plan update, or a changed slot, is reported (superseded), no halt', { timeout: 240_000 }, async () => {
  const inv = await k4Merge(f => f.plan(k4Plan(f.path, { check: 'true; true' })));
  try {
    const out = inv.lines.join('\n');
    assert.match(out, /^merge a: superseded — merge refused \(candidate #\d+ [0-9a-f]{12} of a was invalidated by plan #\d+ \(its spec changed\); the writer submits again, then merge\); the next pass decides on the new state$/m, out);
    assert.deepEqual(halts(await inv.f.entries()), []);
    assert.ok(!merged(await inv.f.entries(), 'a'));
  } finally { await inv.f.done(); }
  const slot = await k4Merge(f => ops.abandon({ cwd: f.cwd, node: 'a', as: { role: 'parent', id: 'main' }, reason: 'restart a' }));
  try {
    const out = slot.lines.join('\n');
    assert.match(out, /^merge a: superseded — merge refused \(slot of a changed \(#\d+ abandon\); nothing recorded\); the next pass decides on the new state$/m, out);
    assert.deepEqual(halts(await slot.f.entries()), []);
  } finally { await slot.f.done(); }
});

// ---------- review #784 F1 and the rejected ruling follow-up (item 7) ----------
const sendsOf = (es: Entry[]) => es.filter((e): e is Extract<Entry, { kind: 'send' }> => e.kind === 'send');

test('#784 F1: a ruling steer dsa rejects (the writer sealed meanwhile) is not delivered: the next follow-up carries the ruling, no halt', { timeout: 180_000 }, async () => {
  const f = await rig(() => planOf(node('w', { review: { count: 1, min_rank: 1 } })));
  try {
    await f.agent('w-writer-1', 'echo w > w.txt; git add w.txt; git commit -qm w\necho RUNNING');
    await f.agent('w-writer-2', 'case "$FAKE_MESSAGE" in *"use the blue variant"*) owed submit w;; *) exit 9;; esac');
    await f.onceUntil(4, async () => (await f.entries()).some(e => e.kind === 'launch' && e.node === 'w'));
    const rule = await ops.rule({ cwd: f.cwd, as: { role: 'parent', id: 'main' }, text: 'use the blue variant', nodes: ['w'] });
    await f.agent('w-reviewer', `who=$(grep -o "reviewer:drive-w-1-[0-9]*" "$FAKE_SPEC" | head -1)\nowed review w --as "$who" --ok --rank 1 --note "blue variant applied" --ack-rulings ${rule.seq}`);
    /** The writer's call seals between the driver's describe and its steer (the reviewer's probe): dsa rejects the steer. */
    class SealsFirst extends Dsa {
      override async send(...a: Parameters<Dsa['send']>): ReturnType<Dsa['send']> {
        if (a[2] === 'steer') {
          const p = join(f.dir, 'state.json'), raw = JSON.parse(await readFile(p, 'utf8'));
          Object.assign(raw.runs[a[1]], { state: 'sealed', status: 'ok' }); await writeFile(p, JSON.stringify(raw));
        }
        return super.send(...a);
      }
    }
    const dsa = new SealsFirst({ bin: FAKE, env: f.env, timeoutMs: 120_000 });
    const first = (await f.once({ dsa })).join('\n');
    assert.match(first, /^send steer \(ruling\) to \S+ \[\S+\]: rejected — .*is finished; use follow-up; not retried as a steer \(the writer's next follow-up carries these rulings/m, first);
    await f.onceUntil(6, async () => merged(await f.entries(), 'w'), { dsa });
    const sends = sendsOf(await f.entries());
    const writerSends = sends.filter(x => x.rid === sends[0]!.rid);
    assert.deepEqual(writerSends.map(x => [x.sendKind, x.reason]), [['steer', 'ruling'], ['follow-up', 'submit']]);
    assert.equal(writerSends[1]!.rulings, rule.seq, 'the submit follow-up carries the ruling the rejected steer did not deliver');
    assert.match(await readFile(join(f.dir, 'messages', writerSends[1]!.send), 'utf8'), /#\d+ use the blue variant/);
    assert.deepEqual(halts(await f.entries()), []);
  } finally { await f.done(); }
});

test('item 7: a ruling follow-up dsa rejects halts in the same pass (the log says so), like any other send', { timeout: 180_000 }, async () => {
  const f = await rig(() => planOf(node('v')));
  try {
    await f.agent('v-writer-1', 'echo v > v.txt; git add v.txt; git commit -qm v');
    await f.agent('v-writer-2', 'true');
    await f.onceUntil(6, async () => sendsOf(await f.entries()).some(x => x.reason === 'submit'));
    await ops.rule({ cwd: f.cwd, as: { role: 'parent', id: 'main' }, text: 'commit the file and submit', nodes: ['v'] });
    writeFileSync(join(f.dir, 'faults'), 'send 1 none\n');
    const before = (await f.entries()).length;
    const out = (await f.once()).join('\n');
    assert.match(out, /^send follow-up \(ruling\) to \S+ \[\S+\]: rejected — fault; halted$/m, out);
    const added = (await f.entries()).slice(before);
    assert.deepEqual(added.map(e => e.kind === 'send' ? `send ${e.reason}` : e.kind), ['send ruling', 'halt'], 'the halt is recorded in the same pass');
    assert.match((added[1] as Extract<Entry, { kind: 'halt' }>).reason, /^dsa rejected send \S+ \(to:"w1\/main"\): fault; this attempt's request is fixed/, '0.8 (L1.4): the halt names the call address');
  } finally { await f.done(); }
});
