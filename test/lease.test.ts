// LE1–LE4: measurements own the shared machine lease, not just the driver's attest child.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { chmod, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';
import * as ops from '../src/ops.ts';
import * as git from '../src/git.ts';
import { Dsa } from '../src/dsa.ts';
import { Driver, drive } from '../src/drive-run.ts';
import { measuringOf } from '../src/drive-bg.ts';
import { parsePlan } from '../src/plan.ts';
import { Ledger } from '../src/ledger.ts';
import { writerLaunch } from '../src/drive.ts';
import { projectId, reduce } from '../src/reducer.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const owner = { role: 'owner', id: 'test' } as const, parent = { role: 'parent', id: 'test' } as const;
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(cond: () => boolean | Promise<boolean>, what: string, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!await cond()) { assert.ok(Date.now() < end, `timed out: ${what}`); await sleep(25); }
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); const s = readFileSync(`/proc/${pid}/stat`, 'utf8'); return s.charAt(s.lastIndexOf(')') + 2) !== 'Z'; } catch { return false; }
}
const FAKE = `#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { existsSync, writeFileSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const dir = process.env.LEASE_TEST_DIR, args = process.argv.slice(2), sep = args.indexOf('--');
const log = value => appendFileSync(join(dir, 'holds'), JSON.stringify(value)+'\\n');
if (args[0] === 'describe') { console.log(JSON.stringify({state:'sealed',status:'done',calls:[{key:'main',gen:1,status:'ok'}]})); process.exit(0); }
if (args[0] !== 'hold') process.exit(2);
log({ event: 'request', args, env: process.env.OWED_LEASED, pid: process.pid });
if (existsSync(join(dir, 'refuse'))) { console.error('pi-durable-subagents: Error: Unknown option --no-wait'); process.exit(1); }
if (existsSync(join(dir, 'busy')) && args.includes('--no-wait')) { console.error('hold: machine is busy (exclusive)'); process.exit(75); }
const deadline = Date.now()+30000;
while (existsSync(join(dir, 'busy')) || existsSync(join(dir, 'before-ready'))) {
  if (Date.now()>deadline) process.exit(1);
  await new Promise(r=>setTimeout(r,25));
}
writeFileSync(join(dir, 'active'), String(process.pid));
const p = spawn(args[sep+1], args.slice(sep+2), { stdio: 'inherit', detached: true });
writeFileSync(join(dir, 'holder-pid'), String(p.pid));
log({ event: 'granted', argv: args.slice(sep+1), pid: process.pid, child: p.pid });
for (const s of ['SIGTERM','SIGINT','SIGHUP']) process.on(s,()=>{ try { process.kill(-p.pid,s); } catch {} });
p.on('close', code=>{ rmSync(join(dir,'active'),{force:true}); log({event:'released',code}); process.exit(code??1); });
`;
type Hold = { event: string; args?: string[]; argv?: string[]; env?: string; pid?: number; child?: number };
async function rig(extra: Record<string, unknown> = {}) {
  const r = await repo(), bin = join(r.root, 'fake-dsa.mjs');
  const prior = { OWED_DSA: process.env.OWED_DSA, LEASE_TEST_DIR: process.env.LEASE_TEST_DIR, OWED_LEASED: process.env.OWED_LEASED };
  process.env.OWED_DSA = bin; process.env.LEASE_TEST_DIR = r.root; delete process.env.OWED_LEASED;
  await writeFile(bin, FAKE); await chmod(bin, 0o755);
  const plan = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: [{ id: 'a', writes: ['a.txt'], checks: [], review: { count: 0, min_rank: 1 } }], drive: { min_free_mb: 0 }, ...extra };
  await r.put('README', 'fixture'); await r.commit();
  const holds = (): Hold[] => (existsSync(join(r.root, 'holds')) ? readFileSync(join(r.root, 'holds'), 'utf8') : '').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
  return { ...r, bin, plan, holds, path: (name: string) => join(r.root, name),
    init: (o: object = {}) => ops.init({ cwd: r.cwd, as: owner, channel: 'flag', plan: JSON.stringify(plan), ...o }),
    async submit() {
      const d = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
      const ledger = await Ledger.open(r.cwd), entries = await ledger.read(), plans = new Map<string, ReturnType<typeof parsePlan>>();
      for (const e of entries) if (e.kind === 'plan' || e.kind === 'genesis') plans.set(e.plan, parsePlan((await ledger.getBlob(e.plan)).toString()));
      const s = reduce(entries, sha => plans.get(sha)!);
      await ops.launch({ ...writerLaunch(s, 'a', projectId(s)), cwd: r.cwd, as: { role: 'parent', id: 'drive' } });
      await commitAt(d.worktree, { 'a.txt': 'candidate' });
      await ops.submit({ cwd: d.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
    },
    async done() {
      // Only this fixture's groups; bounded cleanup even after an assertion failed while a holder waited.
      for (const h of holds()) if (h.event === 'granted' && h.child && alive(h.child)) {
        for (const pid of [h.child, h.pid!]) try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ }
      }
      for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
      await r.cleanup();
    },
  };
}
const leasedCheck = (dir: string) => `test "$OWED_LEASED" = 1 && test -f '${join(dir, 'active')}' && printf '1..1\\nok 1 - leased\\n'`;

// Calls to the optional new helper stay inside tests, so the red tree also exercises existing ops and CLI paths.
test('LE1/LE3 init and standalone attest/merge/adopt wait under one shared lease; setup/checks/invariants get the marker', { timeout: 120_000 }, async () => {
  const f = await rig();
  try {
    const check = { id: 'leased', run: leasedCheck(f.root), reads: ['a.txt'], timeout_s: 10, min_tests: 1 };
    const plan = { ...f.plan, setup: `test "$OWED_LEASED" = 1 && test -f '${f.path('active')}'`, invariants: [check], nodes: [{ ...f.plan.nodes[0]!, checks: [check] }] };
    const initial = await ops.init({ cwd: f.cwd, as: owner, channel: 'flag', plan: JSON.stringify(plan) });
    assert.equal(initial.observations[0]?.kind === 'obs' && initial.observations[0].verdict, 'pass');
    assert.equal((initial as { lease?: string }).lease, 'machine (shared)');
    await f.submit();
    const a = await ops.attest({ cwd: f.cwd, node: 'a' }); assert.equal(a.accepted, true); assert.equal((a as { lease?: string }).lease, 'machine (shared)');
    const m = await ops.merge({ cwd: f.cwd, node: 'a', as: parent }); assert.equal((m as { lease?: string }).lease, 'machine (shared)');
    await commitAt(f.cwd, { 'a.txt': 'adopted' });
    const adopted = await ops.adopt({ cwd: f.cwd, as: owner, channel: 'flag', note: 'fixture' });
    assert.equal(adopted.observations[0]?.kind === 'obs' && adopted.observations[0].verdict, 'pass');
    assert.equal((adopted as { lease?: string }).lease, 'machine (shared)');
    const requests = f.holds().filter(h => h.event === 'request');
    assert.equal(requests.length, 4); assert.ok(requests.every(h => h.args?.includes('--shared') && !h.args.includes('--no-wait')));
    assert.equal(f.holds().filter(h => h.event === 'released').length, 4);
    assert.equal(existsSync(f.path('active')), false);
  } finally { await f.done(); }
});

test('LE3 waiting lease starts no measurement before acquisition and abort removes the queued holder', { timeout: 60_000 }, async () => {
  const f = await rig({ invariants: [{ id: 'mark', run: 'true' }] });
  const ac = new AbortController();
  try {
    await f.init({ measure: false }); await writeFile(f.path('busy'), '');
    const run = ops.attestGenesis({ cwd: f.cwd, signal: ac.signal }); run.catch(() => {});
    await until(() => f.holds().some(h => h.event === 'request'), 'lease requested');
    assert.equal(f.holds().filter(h => h.event === 'granted').length, 0);
    ac.abort(); await assert.rejects(run, (e: Error & { code?: string }) => e.code === 'aborted');
    const pid = f.holds().find(h => h.event === 'request')!.pid!; await until(() => !alive(pid), 'queued lease child gone');
    assert.equal((await ops.genesisPending({ cwd: f.cwd })).length, 1);
  } finally { ac.abort(); await f.done(); }
});

test('LE3 waiting lease resumes after the exclusive holder leaves (no premature observations)', { timeout: 60_000 }, async () => {
  const f = await rig({ invariants: [{ id: 'inv', run: 'true' }] });
  let run: ReturnType<typeof ops.attestGenesis> | undefined;
  try {
    await f.init({ measure: false }); await writeFile(f.path('busy'), '');
    run = ops.attestGenesis({ cwd: f.cwd }); run.catch(() => {});
    await until(() => f.holds().some(h => h.event === 'request'), 'waiting shared request');
    assert.deepEqual(await ops.genesisPending({ cwd: f.cwd }), ['inv']);
    assert.ok(!existsSync(f.path('active')));
    await rm(f.path('busy'));
    const r = await run; assert.equal(r.complete, true); assert.equal((r as { lease?: string }).lease, 'machine (shared)');
    assert.ok(f.holds().filter(h => h.event === 'request').every(h => !h.args!.includes('--no-wait')));
    assert.ok(!existsSync(f.path('active')));
  } finally { await rm(f.path('busy'), { force: true }); await run?.catch(() => {}); await f.done(); }
});

test('LE2 driver lease refusal halts as an error, never busy and never starts merge measurement', { timeout: 60_000 }, async () => {
  const f = await rig();
  try {
    await f.init(); await f.submit(); await ops.attest({ cwd: f.cwd, node: 'a' });
    const trunk = (await ops.status({ cwd: f.cwd })).trunk.commit;
    await writeFile(f.path('refuse'), '');
    const lines: Record<string, unknown>[] = [];
    const driver = new Driver({ cwd: f.cwd, dsa: new Dsa({ bin: f.bin }), json: true, log: l => lines.push(JSON.parse(l)), handleSignals: false });
    await driver.pass(); await driver.settle();
    assert.ok(lines.some(l => l.do === 'merge' && l.outcome === 'error' && /hold refused/.test(String(l.detail))), JSON.stringify(lines));
    assert.ok(!lines.some(l => l.outcome === 'busy')); assert.ok(!existsSync(f.path('active')));
    assert.equal((await ops.status({ cwd: f.cwd })).trunk.commit, trunk);
    assert.equal((await (await Ledger.open(f.cwd)).read()).filter(e => e.kind === 'halt').length, 1);
  } finally { await f.done(); }
});

test('LE3 opt-outs, missing dsa and OWED_LEASED=1 skip acquisition without changing keys', { timeout: 90_000 }, async () => {
  const f = await rig({ lease: false });
  try {
    const spec = { id: 'key', run: 'true', reads: ['a.txt'] };
    const plan = { ...f.plan, invariants: [spec], nodes: [{ ...f.plan.nodes[0]!, checks: [spec] }] };
    const off = parsePlan(JSON.stringify(plan)), on = parsePlan(JSON.stringify({ ...plan, lease: true }));
    assert.equal((off as { lease?: boolean }).lease, false);
    assert.throws(() => parsePlan(JSON.stringify({ ...f.plan, lease: 'false' })), /lease: expected boolean/);
    assert.deepEqual(await git.stateFacts(f.cwd, off, 'HEAD'), await git.stateFacts(f.cwd, on, 'HEAD'));
    await f.init(); await f.submit();
    const c = (await ops.status({ cwd: f.cwd })).nodes.a!.candidate!;
    const slot = (await ops.status({ cwd: f.cwd })).nodes.a!.slot!;
    assert.deepEqual((await git.candidateFacts(f.cwd, off, off.nodes[0]!, slot.base, c.commit, 1)).keys, (await git.candidateFacts(f.cwd, on, on.nodes[0]!, slot.base, c.commit, 1)).keys);
    await ops.attest({ cwd: f.cwd, node: 'a' }); assert.equal(f.holds().length, 0);
    await ops.planSet({ cwd: f.cwd, as: parent, plan: JSON.stringify({ ...f.plan, lease: true }) });
    await ops.attest({ cwd: f.cwd, node: 'a', lease: false } as Parameters<typeof ops.attest>[0]);
    process.env.OWED_DSA = f.path('missing'); await ops.attest({ cwd: f.cwd, node: 'a' });
    process.env.OWED_DSA = f.bin;
    const unleasedChecks = (await git.candidateFacts(f.cwd, on, on.nodes[0]!, slot.base, c.commit, 1)).keys;
    const unleasedInvariants = (await git.stateFacts(f.cwd, on, c.commit)).invKeys;
    assert.ok(unleasedChecks['check:key']); assert.ok(unleasedInvariants.key);
    process.env.OWED_LEASED = '1';
    assert.deepEqual((await git.candidateFacts(f.cwd, on, on.nodes[0]!, slot.base, c.commit, 1)).keys, unleasedChecks);
    assert.deepEqual((await git.stateFacts(f.cwd, on, c.commit)).invKeys, unleasedInvariants);
    const inherited = await ops.attest({ cwd: f.cwd, node: 'a' }); assert.equal((inherited as { lease?: string }).lease, 'machine (shared)');
    assert.equal(f.holds().length, 0);
  } finally { await f.done(); }
});

test('LE2 driver merge busy retries only on a later tick and is removed from in-flight status, never halts', { timeout: 90_000 }, async () => {
  const f = await rig();
  try {
    await f.init(); await f.submit(); await ops.attest({ cwd: f.cwd, node: 'a' }); await writeFile(f.path('busy'), '');
    const lines: Record<string, unknown>[] = [];
    const driver = new Driver({ cwd: f.cwd, dsa: new Dsa({ bin: f.bin }), json: true, log: l => lines.push(JSON.parse(l)), handleSignals: false });
    await driver.pass(); await driver.settle();
    assert.ok(lines.some(l => l.do === 'merge' && l.outcome === 'busy'), JSON.stringify(lines));
    assert.deepEqual(measuringOf(lines.map(l => JSON.stringify(l))), []);
    assert.equal((await ops.status({ cwd: f.cwd })).nodes.a!.phase, 'accepted');
    const requests = f.holds().length;
    await driver.pass(); assert.equal(f.holds().length, requests, 'no same-cycle retry');
    await rm(f.path('busy')); driver.tick(); await driver.pass(); await driver.settle();
    assert.equal((await ops.status({ cwd: f.cwd })).nodes.a!.phase, 'merged');
    assert.ok(lines.some(l => l.do === 'merge' && l.outcome === 'merged' && /lease: machine \(shared\)/.test(String(l.detail))));
    const request = f.holds().filter(h => h.event === 'request').at(-1)!;
    assert.ok(request.args!.includes('--no-wait'));
    assert.equal((await (await Ledger.open(f.cwd)).read()).filter(e => e.kind === 'halt').length, 0);
  } finally { await f.done(); }
});

test('LE2 driver merge measures only after leased arrives; abort kills its checks and holder without advancing trunk', { timeout: 90_000 }, async () => {
  const f = await rig();
  let driver: Driver | undefined;
  try {
    const mark = f.path('measured'), gate = f.path('gate');
    const plan = { ...f.plan, invariants: [{ id: 'inv', reads: ['a.txt'], timeout_s: 30, run: `if [ -f a.txt ]; then test "$OWED_LEASED" = 1 && test -f '${f.path('active')}' || exit 1; echo $$ > '${mark}'; while [ ! -f '${gate}' ]; do sleep 0.05; done; fi` }] };
    await ops.init({ cwd: f.cwd, as: owner, channel: 'flag', plan: JSON.stringify(plan) }); await f.submit(); await ops.attest({ cwd: f.cwd, node: 'a' });
    await writeFile(f.path('before-ready'), ''); const trunk = (await ops.status({ cwd: f.cwd })).trunk.commit;
    driver = new Driver({ cwd: f.cwd, dsa: new Dsa({ bin: f.bin }), log: () => {}, handleSignals: false });
    const n = f.holds().filter(h => h.event === 'request').length;
    await driver.pass(); await until(() => f.holds().filter(h => h.event === 'request').length > n, 'merge requested lease');
    assert.equal(existsSync(mark), false, 'not measured before readiness');
    await rm(f.path('before-ready')); await until(() => existsSync(mark), 'merge invariant under lease');
    const holder = Number(readFileSync(f.path('holder-pid'), 'utf8')), check = Number(readFileSync(mark, 'utf8'));
    assert.ok(alive(holder)); driver.abort.abort(); await driver.drain(10_000);
    await until(() => !alive(holder) && !alive(check), 'holder and check ended');
    assert.equal((await ops.status({ cwd: f.cwd })).trunk.commit, trunk);
    assert.equal(existsSync(f.path('active')), false);
  } finally { driver?.abort.abort(); await writeFile(f.path('gate'), ''); await driver?.drain(10_000); await f.done(); }
});

test('LE2 holder is reaped on thrown measurement and on holder failure mid-measurement', { timeout: 60_000 }, async () => {
  const f = await rig();
  try {
    const { withMachineLease } = await import('../src/lease.ts');
    await assert.rejects(withMachineLease({ cwd: f.cwd }, async () => { assert.ok(existsSync(f.path('active'))); throw new Error('merge crashed'); }), /merge crashed/);
    assert.equal(existsSync(f.path('active')), false);
    const result = withMachineLease({ cwd: f.cwd }, async signal => {
      const request = f.holds().filter(h => h.event === 'granted').at(-1)!;
      process.kill(-request.pid!, 'SIGTERM');
      await until(() => signal!.aborted, 'lease loss aborts measurement');
    });
    await assert.rejects(result, /ended during measurement/);
    assert.equal(existsSync(f.path('active')), false);
  } finally { await f.done(); }
});

test('LE2 parent SIGKILL closes holder stdin and releases its lease (no orphan)', { timeout: 60_000 }, async () => {
  const f = await rig(); let child: ReturnType<typeof spawn> | undefined;
  try {
    const url = new URL('../src/lease.ts', import.meta.url).href;
    child = spawn(process.execPath, ['--input-type=module', '-e', `import { withMachineLease } from ${JSON.stringify(url)}; await withMachineLease({cwd:${JSON.stringify(f.cwd)}},()=>new Promise(()=>{}));`], { env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    const closed = new Promise(resolve => child!.on('close', resolve));
    await until(() => existsSync(f.path('holder-pid')), 'holder started');
    const pid = Number(readFileSync(f.path('holder-pid'), 'utf8')); child.kill('SIGKILL'); await closed;
    await until(() => !alive(pid) && !existsSync(f.path('active')), 'crashed parent lease released');
  } finally { child?.kill('SIGKILL'); await f.done(); }
});

test('LE1 in-process parallel leases do not leak OWED_LEASED across unrelated measurements', { timeout: 60_000 }, async () => {
  const f = await rig();
  try {
    const { withMachineLease, machineLeased, leaseEnvironment } = await import('../src/lease.ts');
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const held = withMachineLease({ cwd: f.cwd }, async () => { assert.equal(machineLeased(), true); await gate; assert.deepEqual(leaseEnvironment(), { OWED_LEASED: '1' }); });
    held.catch(() => {});
    try {
      await until(() => existsSync(f.path('active')), 'held measurement');
      assert.equal(machineLeased(), false); assert.equal(process.env.OWED_LEASED, undefined);
      await withMachineLease({ cwd: f.cwd, lease: false }, async () => { assert.equal(machineLeased(), false); assert.deepEqual(leaseEnvironment(), {}); });
    } finally { release(); await held; }
  } finally { await f.done(); }
});

test('LE3/LE4 CLI --no-lease opts out; leased CLI output and JSON expose the lease', { timeout: 90_000 }, async () => {
  const f = await rig();
  try {
    await f.put('plan.json', JSON.stringify(f.plan));
    let r = await cli(f.cwd, ['init', 'plan.json', '--no-lease']); assert.equal(r.code, 0, r.stderr); assert.equal(f.holds().length, 0);
    await f.submit();
    r = await cli(f.cwd, ['attest', 'a', '--no-lease']); assert.equal(r.code, 0, r.stderr); assert.doesNotMatch(r.stdout, /lease: machine/);
    r = await cli(f.cwd, ['attest', 'a']); assert.equal(r.code, 0, r.stderr); assert.match(r.stdout, /lease: machine \(shared\)/);
    r = await cli(f.cwd, ['attest', 'a', '--json']); assert.equal(JSON.parse(r.stdout).lease, 'machine (shared)');
    const n = f.holds().length;
    r = await cli(f.cwd, ['merge', 'a', '--no-lease']); assert.equal(r.code, 0, r.stderr);
    await commitAt(f.cwd, { 'a.txt': 'adopt' });
    r = await cli(f.cwd, ['adopt', '--note', 'fixture', '--no-lease']); assert.equal(r.code, 0, r.stderr); assert.equal(f.holds().length, n);
  } finally { await f.done(); }
});

test('LE2 attest driver sets OWED_LEASED for its leased child and honours repository opt-out', { timeout: 90_000 }, async () => {
  const f = await rig();
  try {
    await f.init(); await f.submit();
    const program = f.path('attest.mjs');
    await writeFile(program, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(f.path('attest-env'))},process.env.OWED_LEASED??'none'); process.exit(1);`);
    await drive({ cwd: f.cwd, once: true, dsa: new Dsa({ bin: f.bin }), owed: [process.execPath, program], log: () => {}, handleSignals: false });
    assert.equal(await readFile(f.path('attest-env'), 'utf8'), '1');
    const request = f.holds().filter(h => h.event === 'request').at(-1)!; assert.equal(request.env, '1'); assert.ok(request.args!.includes('--no-wait'));
    await ops.planSet({ cwd: f.cwd, as: parent, plan: JSON.stringify({ ...f.plan, lease: false }) });
    const n = f.holds().length;
    await drive({ cwd: f.cwd, once: true, dsa: new Dsa({ bin: f.bin }), owed: [process.execPath, program], log: () => {}, handleSignals: false });
    assert.equal(await readFile(f.path('attest-env'), 'utf8'), 'none'); assert.equal(f.holds().length, n);
  } finally { await f.done(); }
});

test('LE3 tool genesis background and measurement schemas honour lease:false and leased output', { timeout: 90_000 }, async () => {
  const f = await rig({ invariants: [{ id: 'inv', run: 'true' }] });
  const tools = new Map<string, ToolDefinition>(), handlers = new Map<string, Function>(), messages: string[] = [];
  owed({ registerTool: (t: ToolDefinition) => tools.set(t.name, t), registerCommand() {}, on: (n: string, h: Function) => handlers.set(n, h), sendMessage: (m: { content: string }) => messages.push(m.content) } as unknown as ExtensionAPI);
  const ctx = { cwd: f.cwd, hasUI: false, isIdle: () => true, ui: { notify() {} } } as unknown as ExtensionContext;
  const call = (name: string, params: object) => tools.get(`owed_${name}`)!.execute(name, params, undefined, undefined, ctx as Parameters<ToolDefinition['execute']>[4]);
  try {
    for (const name of ['init', 'attest', 'merge', 'adopt']) assert.ok((tools.get(`owed_${name}`)!.parameters as unknown as { properties: Record<string, unknown> }).properties.lease, `${name} lease parameter`);
    await f.put('plan.json', JSON.stringify(f.plan));
    const initial = await call('init', { plan: 'plan.json', cwd: f.cwd }); assert.ok(!(initial as { isError?: boolean }).isError, JSON.stringify(initial));
    await until(() => messages.length > 0, 'genesis background wake'); assert.match(messages[0]!, /lease: machine \(shared\)/);
    await f.submit();
    const before = f.holds().length;
    const a = await call('attest', { node: 'a', cwd: f.cwd, lease: false }); assert.ok(!(a as { isError?: boolean }).isError); assert.equal(f.holds().length, before);
    const m = await call('merge', { node: 'a', cwd: f.cwd }); assert.match(JSON.stringify(m.content), /lease: machine \(shared\)/);
    await commitAt(f.cwd, { 'a.txt': 'tool adoption' });
    const n = f.holds().length;
    const adopted = await call('adopt', { cwd: f.cwd, note: 'fixture', lease: false }); assert.ok(!(adopted as { isError?: boolean }).isError, JSON.stringify(adopted));
    assert.equal(f.holds().length, n);
  } finally { await handlers.get('session_shutdown')?.({}, ctx); await f.done(); }
});
