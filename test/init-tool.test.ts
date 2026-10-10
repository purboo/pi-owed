// D24: observations are facts about keys (attest and the genesis attest record what is still current and drop only
// superseded items), init reports an incomplete genesis attest without "retry", `owed attest --genesis`, the
// `owed plan` warning and status progress, and the pi tool owed_init (owner dialog, background genesis attest,
// one wake-up message, abort on session_shutdown). Checks wait on gate files, never on sleeps as ordering.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import type { Entry } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt, identity } from './helpers/surface.ts';
import { revParse } from '../src/git.ts';
import { OwedError } from '../src/errors.ts';
// D25.4: these tests exercise the owner confirmation (dialog or TTY prompt), now the opt-in gate OWED_CONFIRM=owner.
process.env.OWED_CONFIRM = 'owner';

const OWED = fileURLToPath(new URL('../bin/owed.js', import.meta.url));
const owner = { role: 'owner' as const, id: 'human' };
const parent = { role: 'parent' as const, id: 'main' };
type Repo = Awaited<ReturnType<typeof repo>>;
type Result = Awaited<ReturnType<ToolDefinition['execute']>> & { isError?: boolean };
const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const entries = async (cwd: string): Promise<Entry[]> => (await Ledger.open(cwd)).read();
const obsOf = (es: Entry[], obligation: string) => es.filter((e): e is Extract<Entry, { kind: 'obs' }> => e.kind === 'obs' && e.obligation === obligation);
const text = (r: Result): string => r.content.map(c => c.type === 'text' ? c.text : '').join('\n');

/** A check that touches `<root>/started-<name>` and then waits for `<root>/go-<name>` (a gate, not a timer). */
const gated = (root: string, name: string) => `touch '${join(root, `started-${name}`)}'; while [ ! -f '${join(root, `go-${name}`)}' ]; do sleep 0.05; done`;
const open = (root: string, name: string) => writeFile(join(root, `go-${name}`), '');
/** Waits (bounded) until `file` exists. */
async function appears(file: string, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!existsSync(file)) { if (Date.now() > end) throw new Error(`${file} did not appear within ${ms} ms`); await sleep(50); }
}
/** Waits (bounded) until `cond` holds. */
async function until(cond: () => Promise<boolean>, what: string, ms = 60_000): Promise<void> {
  const end = Date.now() + ms;
  while (!await cond()) { if (Date.now() > end) throw new Error(`${what} did not happen within ${ms} ms`); await sleep(50); }
}
/** Records `<pid>` of the check in `file`, then sleeps 60 s. */
const slowRun = (file: string) => `echo $$ > '${file}'; sleep 60`;
async function pidFrom(file: string): Promise<number> {
  await until(async () => /^\d+\s*$/.test(await readFile(file, 'utf8').catch(() => '')), `${file}`);
  return Number((await readFile(file, 'utf8')).trim());
}
function alive(pid: number): boolean {
  try { process.kill(pid, 0); } catch (e) { return (e as NodeJS.ErrnoException).code === 'EPERM'; }
  try { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); return stat.charAt(stat.lastIndexOf(')') + 2) !== 'Z'; } catch { return false; }
}
function reap(pid?: number): void { if (pid) { try { process.kill(-pid, 'SIGKILL'); } catch { /* gone */ } try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } } }

const planOf = (invariants: object[], checks: object[] = [], brief = 'first') => ({ version: 1, trunk: 'main', closure: [], invariants, nodes: [{ id: 'a', writes: ['a.txt'], checks, review: { count: 0, min_rank: 1 } }, { id: 'b', writes: ['b.txt'], checks: [], review: { count: 0, min_rank: 1 }, brief }] });

/** A repository with node `a` dispatched and submitted (check `gated` on a gate). */
async function submitted(): Promise<Repo & { worktree: string; plan: (brief: string) => string }> {
  const r = await repo();
  try {
    const plan = (brief: string) => JSON.stringify(planOf([], [{ id: 'gated', run: gated(r.root, 'check') }], brief));
    await commitAt(r.cwd, { README: 'x\n' });
    await ops.init({ cwd: r.cwd, plan: plan('first'), as: owner, channel: 'flag' });
    const d = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
    await commitAt(d.worktree, { 'a.txt': 'a\n' });
    await ops.submit({ cwd: d.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
    return { ...r, worktree: d.worktree, plan };
  } catch (e) { await r.cleanup(); throw e; }
}

test('D24.1: a plan edit that leaves the candidate\'s keys unchanged does not interrupt attest: the observation is recorded', { timeout: 120_000 }, async () => {
  const r = await submitted();
  try {
    const run = ops.attest({ cwd: r.cwd, node: 'a' });
    run.catch(() => {});
    await appears(join(r.root, 'started-check'));
    // The parent edits another node's brief while the check runs: the ledger moves, a's keys do not.
    await ops.planSet({ cwd: r.cwd, as: parent, plan: r.plan('second') });
    await open(r.root, 'check');
    const out = await run;
    assert.deepEqual(out.superseded, []);
    assert.deepEqual(out.observations.map(e => e.kind === 'obs' && e.obligation), ['check:gated', 'writes']);
    assert.equal(out.accepted, true, 'the observations made the candidate accepted');
    assert.equal(obsOf(await entries(r.cwd), 'check:gated')[0]!.verdict, 'pass');
  } finally { await open(r.root, 'check'); await r.cleanup(); }
});

test('D24.1: a resubmit during attest supersedes the old keys: dropped and listed, attest still completes', { timeout: 120_000 }, async () => {
  const r = await submitted();
  try {
    const run = ops.attest({ cwd: r.cwd, node: 'a' });
    run.catch(() => {});
    await appears(join(r.root, 'started-check'));
    const before = (await ops.status({ cwd: r.cwd })).nodes.a!.candidate!.keys;
    await commitAt(r.worktree, { 'a.txt': 'changed\n' });
    await ops.submit({ cwd: r.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
    await open(r.root, 'check');
    const out = await run;
    assert.deepEqual(out.observations, [], 'nothing recorded for the superseded candidate');
    assert.deepEqual(out.superseded.map(i => `${i.subject}/${i.obligation}`), ['a/check:gated', 'a/writes']);
    assert.equal(out.superseded[0]!.key, before['check:gated']);
    assert.equal(obsOf(await entries(r.cwd), 'check:gated').length, 0);
    // The new candidate is measured by the next attest.
    const next = await ops.attest({ cwd: r.cwd, node: 'a' });
    assert.deepEqual(next.superseded, []);
    assert.equal(next.accepted, true);
  } finally { await open(r.root, 'check'); await r.cleanup(); }
});

test('D24.1 (§39): a plan edit during the genesis attest of init interrupts nothing; init records every genesis observation', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    const plan = (brief: string) => JSON.stringify(planOf([{ id: 'build', run: 'true' }, { id: 'kernel', run: gated(r.root, 'kernel') }], [], brief));
    await commitAt(r.cwd, { README: 'x\n' });
    const run = ops.init({ cwd: r.cwd, plan: plan('first'), as: owner, channel: 'flag' });
    run.catch(() => {});
    await appears(join(r.root, 'started-kernel'));
    await ops.planSet({ cwd: r.cwd, as: parent, plan: plan('brief only') });
    await open(r.root, 'kernel');
    const out = await run;
    assert.equal(out.genesis.complete, true, JSON.stringify(out.genesis));
    assert.deepEqual(out.genesis.recorded, ['build', 'kernel']);
    assert.deepEqual(out.genesis.missing, []);
    assert.equal(out.observations.length, 2);
    assert.equal(out.status.genesis, undefined, 'status has no genesis line once complete');
  } finally { await open(r.root, 'kernel'); await r.cleanup(); }
});

test('D24.2/3/5: init with a genesis error reports incomplete (exit 0, no retry); status hint; plan warning; owed attest --genesis', { timeout: 180_000 }, async () => {
  const r = await repo();
  try {
    const ok = join(r.root, 'ok');
    // Unknown output with min_tests is an error verdict until <root>/ok exists; then it prints TAP counts.
    const flaky = { id: 'flaky', run: `if [ -f '${ok}' ]; then printf '# tests 1\\n# pass 1\\n'; fi`, min_tests: 1 };
    const plan = (brief: string) => JSON.stringify(planOf([{ id: 'build', run: 'true' }, flaky], [], brief));
    await r.put('plan.json', plan('first')); await r.put('plan2.json', plan('second')); await r.commit();
    const init = await cli(r.cwd, ['init', 'plan.json', '--i-am-owner']);
    assert.equal(init.code, 0, init.stderr);
    assert.ok(init.stdout.includes('Initialized (genesis #0). Genesis attest incomplete: recorded build; missing flaky: run owed attest --genesis, or the next attest/merge measures them first.'), init.stdout);
    assert.doesNotMatch(init.stdout + init.stderr, /retry/i);
    const status = await cli(r.cwd, ['status']);
    assert.equal(status.code, 0, status.stderr);
    assert.ok(status.stdout.includes('Genesis: 1/2 invariants observed — run owed attest --genesis (or the next attest/merge measures them); pending: flaky'), status.stdout);
    const json = JSON.parse((await cli(r.cwd, ['status', '--json'])).stdout) as ops.StatusView;
    assert.deepEqual(json.genesis, { observed: 1, total: 2, pending: ['flaky'] });
    const planned = await cli(r.cwd, ['plan', 'plan2.json']);
    assert.equal(planned.code, 0, planned.stderr);
    assert.match(planned.stdout, /updated plan/);
    assert.match(planned.stdout, /Warning: genesis attest pending for flaky/);
    assert.equal((await cli(r.cwd, ['attest', '--genesis', '--rerun'])).code, 2);
    assert.equal((await cli(r.cwd, ['attest', 'a', '--genesis'])).code, 2);
    const still = await cli(r.cwd, ['attest', '--genesis']);
    assert.equal(still.code, 1, still.stderr);
    assert.match(still.stdout, /Genesis attest: 1 observation recorded; observed build; missing flaky/);
    await writeFile(ok, '');
    const done = await cli(r.cwd, ['attest', '--genesis', '--json']);
    assert.equal(done.code, 0, done.stderr);
    const g = JSON.parse(done.stdout) as ops.AttestGenesisResult;
    assert.equal(g.complete, true); assert.deepEqual(g.recorded, ['build', 'flaky']); assert.deepEqual(g.missing, []);
    assert.equal(g.observations.length, 1, 'only the missing item is measured');
    assert.doesNotMatch((await cli(r.cwd, ['status'])).stdout, /Genesis:/);
    const again = await cli(r.cwd, ['plan', 'plan.json']);
    assert.equal(again.code, 0, again.stderr); assert.doesNotMatch(again.stdout, /Warning/);
    const nothing = await cli(r.cwd, ['attest', '--genesis']);
    assert.equal(nothing.code, 0); assert.match(nothing.stdout, /0 observations recorded; observed build, flaky; missing none/);
  } finally { await r.cleanup(); }
});

test('D24.3: `owed init` aborted during its genesis attest says it is initialized and what is missing, exit 130', { timeout: 120_000 }, async () => {
  const r = await repo();
  let pid: number | undefined;
  try {
    await r.put('plan.json', JSON.stringify(planOf([{ id: 'build', run: 'true' }, { id: 'slow', run: slowRun(join(r.root, 'pid')) }])));
    await r.commit();
    const env: NodeJS.ProcessEnv = { ...process.env, ...identity }; delete env.NODE_TEST_CONTEXT;
    const child = spawn(process.execPath, [OWED, 'init', 'plan.json', '--i-am-owner'], { cwd: r.cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (b: Buffer) => { out += b; }); child.stderr.on('data', (b: Buffer) => { out += b; });
    const exited = new Promise<number | null>(resolve => child.on('exit', code => resolve(code)));
    pid = await pidFrom(join(r.root, 'pid'));
    child.kill('SIGINT');
    assert.equal(await exited, 130, out);
    assert.ok(out.includes('Initialized (genesis #0). Genesis attest incomplete: recorded build; missing slow: run owed attest --genesis, or the next attest/merge measures them first.'), out);
    assert.match(out, /Aborted: SIGINT/);
    assert.doesNotMatch(out, /retry/i);
    const es = await entries(r.cwd);
    assert.deepEqual(es.map(e => e.kind), ['genesis', 'obs']);
    assert.deepEqual(await ops.genesisPending({ cwd: r.cwd }), ['slow']);
  } finally { reap(pid); await r.cleanup(); }
});

/** The extension with a UI whose confirm answers `confirm` (null: no UI); captures prompts, messages and handlers. */
/** `confirm` may be a function: it runs inside the dialog and returns the owner's answer. */
function harness(cwd: string, confirm: boolean | null | (() => Promise<boolean>) = true) {
  const tools = new Map<string, ToolDefinition>(), handlers = new Map<string, (...a: unknown[]) => unknown>();
  const prompts: string[] = [], messages: { message: { customType: string; content: string; display: boolean }; options: unknown }[] = [];
  let wake!: () => void; const woken = new Promise<void>(r => { wake = r; });
  owed({ registerTool(t: ToolDefinition) { tools.set(t.name, t); }, registerCommand() {}, on(event: string, h: (...a: unknown[]) => unknown) { handlers.set(event, h); },
    sendMessage(message: { customType: string; content: string; display: boolean }, options: unknown) { messages.push({ message, options }); wake(); } } as unknown as ExtensionAPI);
  const ctx = { cwd, hasUI: confirm !== null, ui: { async confirm(title: string, message: string) { prompts.push(`${title}\n${message}`); return typeof confirm === 'function' ? confirm() : confirm; }, notify() {} } } as unknown as ExtensionContext;
  return { tools, prompts, messages, woken, handlers, ctx, async call(name: string, args: Record<string, unknown> = {}): Promise<Result> {
    const t = tools.get(`owed_${name}`); assert.ok(t, `tool owed_${name} is registered`);
    return t.execute('test', args, undefined, undefined, ctx as Parameters<ToolDefinition['execute']>[4]) as Promise<Result>;
  } };
}

test('D24.4/5: owed_init confirms with the owner, returns at once, measures in the background, shows progress and wakes the session once', { timeout: 180_000 }, async () => {
  const r = await repo();
  try {
    const plan = (brief: string) => JSON.stringify(planOf([{ id: 'fast', run: 'true' }, { id: 'bad', run: 'false' }, { id: 'gated', run: gated(r.root, 'inv') }], [], brief));
    await r.put('plan.json', plan('first')); await r.put('plan2.json', plan('second'));
    const commit = await r.commit();
    const h = harness(r.cwd);
    const out = await h.call('init', { plan: 'plan.json' });
    assert.notEqual(out.isError, true, text(out));
    // It returned while the gated invariant cannot have finished.
    assert.equal(existsSync(join(r.root, 'go-inv')), false);
    assert.deepEqual({ genesis: (out.details as { genesis: number }).genesis, measuring: (out.details as { measuring: number }).measuring }, { genesis: 0, measuring: 3 });
    assert.match(text(out), /Initialized \(genesis #0\)\. Measuring 3 genesis invariants in the background in this session/);
    const es = await entries(r.cwd), g = es[0]!;
    assert.equal(g.kind, 'genesis'); assert.equal(g.by, 'owner:human'); assert.equal(g.channel, 'pi-confirm');
    assert.equal(h.prompts.length, 1);
    const prompt = h.prompts[0]!;
    assert.ok(prompt.includes(['Initialize the owed ledger', `Trunk: main at ${commit.slice(0, 12)}`, `Plan: plan.json (sha256 ${g.kind === 'genesis' ? g.plan.slice(0, 12) : ''})`, 'Nodes: 2'].join('\n')), prompt);
    assert.ok(prompt.includes('Invariants:\n  fast\n  bad\n  gated\n'), prompt);
    assert.match(prompt, /Confirmation will be recorded as pi-confirm\./);
    await appears(join(r.root, 'started-inv'));
    const status = text(await h.call('status'));
    assert.ok(status.includes('Genesis: 2/3 invariants observed (measuring in this session); pending: gated'), status);
    // Another process (the CLI) does not run it: it shows the hint instead.
    assert.ok((await cli(r.cwd, ['status'])).stdout.includes('Genesis: 2/3 invariants observed — run owed attest --genesis'));
    // A parent plan edit meanwhile is accepted with a warning and does not interrupt the attest.
    const planned = await h.call('plan', { plan: 'plan2.json' });
    assert.notEqual(planned.isError, true, text(planned));
    assert.match(text(planned), /^Warning: genesis attest pending for gated$/m);
    assert.equal(h.messages.length, 0, 'no message before the attest ends');
    await open(r.root, 'inv');
    await h.woken;
    assert.equal(h.messages.length, 1);
    const m = h.messages[0]!;
    assert.equal(m.message.customType, 'owed-init'); assert.equal(m.message.display, true);
    assert.deepEqual(m.options, { triggerTurn: true, deliverAs: 'followUp' });
    assert.match(m.message.content, /genesis attest of .* finished: recorded fast, bad, gated; failed bad; missing none$/);
    await until(async () => !(await ops.status({ cwd: r.cwd })).genesis, 'genesis complete');
    assert.doesNotMatch(text(await h.call('status')), /Genesis:/);
    // Already initialized: refused before any dialog.
    const again = await h.call('init', { plan: 'plan.json' });
    assert.equal(again.isError, true); assert.match(text(again), /Already initialized/);
    assert.equal(h.prompts.length, 1, 'no second dialog');
    assert.equal(h.messages.length, 1, 'exactly one message');
  } finally { await open(r.root, 'inv'); await r.cleanup(); }
});

test('D24.4: owed_init is owner only, needs a confirmed dialog and records nothing otherwise', { timeout: 60_000 }, async () => {
  const r = await repo();
  try {
    await r.put('plan.json', JSON.stringify(planOf([]))); await r.commit();
    const denied = await harness(r.cwd, false).call('init', { plan: 'plan.json' });
    assert.equal(denied.isError, true); assert.match(text(denied), /owner did not confirm/);
    const noUi = await harness(r.cwd, null).call('init', { plan: 'plan.json' });
    assert.equal(noUi.isError, true); assert.match(text(noUi), /require UI confirmation/);
    const h = harness(r.cwd);
    const asParent = await h.call('init', { plan: 'plan.json', as: 'parent:pi' });
    assert.equal(asParent.isError, true); assert.match(text(asParent), /Only owner may initialize the ledger/);
    assert.equal(h.prompts.length, 0);
    const missing = await h.call('init', { plan: 'nope.json' });
    assert.equal(missing.isError, true); assert.match(text(missing), /cannot read nope\.json/);
    assert.deepEqual(await entries(r.cwd), []);
    // With no invariants nothing runs in the background and no message is sent.
    const ok = await h.call('init', { plan: 'plan.json' });
    assert.notEqual(ok.isError, true, text(ok));
    assert.match(text(ok), /No invariants to measure/);
    assert.equal(h.messages.length, 0);
  } finally { await r.cleanup(); }
});

test('D24.4: session_shutdown aborts the background genesis attest: its check ends, nothing is recorded for it, no message', { timeout: 120_000 }, async () => {
  const r = await repo();
  let pid: number | undefined;
  try {
    await r.put('plan.json', JSON.stringify(planOf([{ id: 'slow', run: slowRun(join(r.root, 'pid')) }]))); await r.commit();
    const h = harness(r.cwd);
    const out = await h.call('init', { plan: 'plan.json' });
    assert.notEqual(out.isError, true, text(out));
    pid = await pidFrom(join(r.root, 'pid'));
    assert.equal((await ops.status({ cwd: r.cwd })).genesis?.measuring, true);
    await h.handlers.get('session_shutdown')!({}, h.ctx);
    await until(async () => !alive(pid!), 'the check ends', 10_000);
    await until(async () => !(await ops.status({ cwd: r.cwd })).genesis?.measuring, 'the attest ends');
    await new Promise(res => setImmediate(res));
    assert.equal(h.messages.length, 0, 'no wake-up after shutdown');
    assert.deepEqual((await entries(r.cwd)).map(e => e.kind), ['genesis']);
    const s = (await ops.status({ cwd: r.cwd })).genesis;
    assert.deepEqual(s, { observed: 0, total: 1, pending: ['slow'] });
    assert.match(text(await h.call('status')), /Genesis: 0\/1 invariants observed — run owed attest --genesis/);
  } finally { reap(pid); await r.cleanup(); }
});

/** `p`'s value, or 'pending' if it does not settle within `ms` (a bound that turns a hang into a failure, not an ordering). */
async function within<T>(p: Promise<T>, ms: number): Promise<T | 'pending'> {
  let t: NodeJS.Timeout | undefined;
  try { return await Promise.race([p, new Promise<'pending'>(r => { t = setTimeout(() => r('pending'), ms); })]); } finally { clearTimeout(t); }
}

test('D24 ruling #392: a node attest completes while a genesis attest runs (genesis has its own lock)', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    // The invariant gates only its first run (the background genesis attest); the node attest measures it at once.
    assert.equal(typeof ops.attestGenesis, 'function', 'ops.attestGenesis exists');
    // The gate is bounded (60 s) so a regression fails instead of hanging the file.
    const inv = `if mkdir '${join(r.root, 'first')}' 2>/dev/null; then touch '${join(r.root, 'started-inv')}'; i=0; while [ ! -f '${join(r.root, 'go-inv')}' ] && [ $i -lt 1200 ]; do sleep 0.05; i=$((i+1)); done; fi`;
    await commitAt(r.cwd, { README: 'x\n' });
    await ops.init({ cwd: r.cwd, plan: JSON.stringify(planOf([{ id: 'inv', run: inv }], [{ id: 'quick', run: 'true' }])), as: owner, channel: 'flag', measure: false });
    const d = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
    await commitAt(d.worktree, { 'a.txt': 'a\n' });
    await ops.submit({ cwd: d.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
    const genesis = ops.attestGenesis({ cwd: r.cwd });
    genesis.catch(() => {});
    // Registered before its first await: status sees it at once.
    assert.equal((await ops.status({ cwd: r.cwd })).genesis?.measuring, true);
    await appears(join(r.root, 'started-inv'));
    const out = await within(ops.attest({ cwd: r.cwd, node: 'a' }), 30_000);
    assert.notEqual(out, 'pending', 'the node attest is not blocked by the genesis attest');
    if (out === 'pending') return;
    assert.equal(out.accepted, true);
    assert.deepEqual(out.observations.map(e => e.kind === 'obs' && e.obligation), ['inv:inv', 'check:quick', 'writes']);
    assert.equal((await ops.status({ cwd: r.cwd })).genesis, undefined, 'the node attest observed the genesis item');
    // A second genesis attest does not overlap the first one: 0.7 (K1.2) refuses it at once as busy (it waited before).
    const second = await within(ops.attestGenesis({ cwd: r.cwd }).catch((e: unknown) => e), 10_000);
    assert.ok(second instanceof OwedError && second.code === 'busy' && /^attest --genesis is already running \(pid \d+ on /.test(second.message), `the second genesis attest is busy: ${String(second)}`);
    await open(r.root, 'inv');
    const g = await genesis;
    assert.equal(g.complete, true); assert.equal(g.observations.length, 1, 'its observation is recorded too (a fact about the same key)');
    const g2 = await ops.attestGenesis({ cwd: r.cwd });
    assert.equal(g2.complete, true); assert.equal(g2.observations.length, 0, 'nothing left to measure');
    assert.equal(obsOf(await entries(r.cwd), 'inv:inv').length, 2);
    assert.equal((await ops.verify({ cwd: r.cwd })).ok, true);
  } finally { await open(r.root, 'inv'); await r.cleanup(); }
});

test('D24 ruling #392: an attribution rerun whose block was replaced by one on another commit is superseded, listed by owed_attest', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    const run = `if [ -f '${join(r.root, 'gate-on')}' ]; then touch '${join(r.root, 'started-attr')}'; while [ ! -f '${join(r.root, 'go-attr')}' ]; do sleep 0.05; done; fi; exit 1`;
    const trunk = await commitAt(r.cwd, { README: 'x\n' });
    await ops.init({ cwd: r.cwd, plan: JSON.stringify(planOf([], [{ id: 'x', run }])), as: owner, channel: 'flag' });
    const d = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
    await commitAt(d.worktree, { 'a.txt': 'a\n' });
    await ops.submit({ cwd: d.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
    await ops.attest({ cwd: r.cwd, node: 'a' });
    const failing = obsOf(await entries(r.cwd), 'check:x');
    assert.equal(failing.length, 1); assert.equal(failing[0]!.verdict, 'fail');
    const { seq: _seq, ts: _ts, prev: _prev, hash: _hash, ...draft } = failing[0]!;
    await writeFile(join(r.root, 'gate-on'), '');
    const h = harness(r.cwd);
    const call = h.call('attest', { node: 'a' });
    await appears(join(r.root, 'started-attr'));
    // While the attribution rerun runs, its block is cleared and a new block on the same key but another commit appears.
    const l = await Ledger.open(r.cwd);
    await l.withLock(async () => { await l.append([{ ...draft, attribution: true } as never]); await l.append([{ ...draft, commit: trunk } as never]); });
    const before = (await entries(r.cwd)).length;
    await open(r.root, 'attr');
    const out = await call;
    assert.notEqual(out.isError, true, text(out));
    assert.deepEqual((out.details as ops.AttestResult).superseded.map(i => `${i.subject}/${i.obligation}`), ['a/check:x']);
    assert.match(text(out), /^Superseded \(not recorded; the item changed while it was measured\): a\/check:x$/m);
    assert.equal((await entries(r.cwd)).length, before, 'nothing recorded for the superseded rerun');
  } finally { await open(r.root, 'attr'); await r.cleanup(); }
});

test('D24 ruling #392: the init commit pin refuses a trunk that moved after the confirmation; nothing is recorded', { timeout: 60_000 }, async () => {
  const r = await repo();
  try {
    await r.put('plan.json', JSON.stringify(planOf([{ id: 'inv', run: 'true' }])));
    const first = await r.commit();
    const wrong = '0'.repeat(40);
    await assert.rejects(ops.init({ cwd: r.cwd, plan: await readFile(join(r.cwd, 'plan.json'), 'utf8'), as: owner, channel: 'flag', commit: wrong }),
      (e: unknown) => e instanceof OwedError && e.code === 'refused' && e.message.includes(`refs/heads/main moved after the confirmation (was ${wrong.slice(0, 12)}, now ${first.slice(0, 12)})`));
    assert.deepEqual(await entries(r.cwd), []);
    // owed_init: trunk moves while the owner dialog is open.
    let moved = '';
    const h = harness(r.cwd, async () => { moved = await commitAt(r.cwd, { 'later.txt': 'later\n' }); return true; });
    const out = await h.call('init', { plan: 'plan.json' });
    assert.equal(out.isError, true, text(out));
    assert.match(text(out), new RegExp(`moved after the confirmation \\(was ${first.slice(0, 12)}, now ${moved.slice(0, 12)}\\); nothing was recorded`));
    assert.match(h.prompts[0]!, new RegExp(`Trunk: main at ${first.slice(0, 12)}`));
    assert.deepEqual(await entries(r.cwd), []);
    assert.equal(await revParse(r.cwd, 'main'), moved);
    // The next confirmation shows and records the new trunk.
    const h2 = harness(r.cwd), ok = await h2.call('init', { plan: 'plan.json' });
    assert.notEqual(ok.isError, true, text(ok));
    await h2.woken;
    const g = (await entries(r.cwd))[0]!;
    assert.equal(g.kind === 'genesis' && g.commit, moved);
  } finally { await r.cleanup(); }
});
