import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';
import * as ops from '../src/ops.ts';
import { git, revParse } from '../src/git.ts';
import { Ledger } from '../src/ledger.ts';
import { pendingAdopt } from '../src/adopt-wait.ts';
import type { Draft, Plan } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const owner = { role: 'owner', id: 'pi' } as const;
const parent = { role: 'parent', id: 'test' } as const;
delete process.env.OWED_CONFIRM;
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until(check: () => boolean | Promise<boolean>, message: string) {
  const end = Date.now() + 10_000;
  while (Date.now() < end) { if (await check()) return; await sleep(20); }
  assert.fail(message);
}
async function fixture(extra: Partial<Plan> = {}) {
  const r = await repo();
  try {
    const base = await commitAt(r.cwd, { seed: 'base' });
    const plan = { version: 1, trunk: 'main', lease: false, closure: [], invariants: [], nodes: [], ...extra };
    await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify(plan) });
    const ledger = await Ledger.open(r.cwd);
    async function hotfix(files: Record<string, string>, from = base) {
      const path = join(r.root, 'hotfix');
      await git(r.cwd, ['worktree', 'add', '--detach', path, from]);
      return { path, commit: await commitAt(path, files) };
    }
    return { ...r, base, ledger, hotfix };
  } catch (error) { await r.cleanup(); throw error; }
}
const adopt = (cwd: string, commit?: string, extra = {}) => ops.adopt({ cwd, commit, as: owner, channel: 'delegated', note: 'reviewed owner hotfix', lease: false, ...extra });
const health = { id: 'health', run: 'test ! -f broken', reads: ['broken', 'health'], timeout_s: 10 };

function gate(root: string, file: string, id = 'gate') {
  const marker = join(root, `${id}-started`), release = join(root, `${id}-release`);
  return { marker, release, invariant: { id, reads: [file], timeout_s: 15, run: `if test -f '${file}'; then touch '${marker}'; for n in $(seq 1 500); do test -f '${release}' && exit 0; sleep .02; done; exit 1; fi` } };
}
async function accept(f: Awaited<ReturnType<typeof fixture>>) {
  const slot = await ops.dispatch({ cwd: f.cwd, as: parent, node: 'a' });
  const commit = await commitAt(slot.worktree, { 'a.txt': 'candidate' });
  await ops.submit({ cwd: slot.worktree, as: { role: 'writer', id: 'a#1' }, node: 'a' });
  assert.equal((await ops.attest({ cwd: f.cwd, node: 'a', lease: false })).accepted, true);
  return commit;
}
function toolHarness(cwd: string, confirm?: (message: string) => Promise<boolean>) {
  const tools = new Map<string, ToolDefinition>();
  owed({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool), registerCommand() {} } as unknown as ExtensionAPI);
  const tool = tools.get('owed_adopt')!;
  const ctx = { cwd, hasUI: Boolean(confirm), ui: { confirm: async (_title: string, message: string) => confirm!(message), notify() {} } } as unknown as ExtensionContext;
  return { tool, call: (args: Record<string, unknown>) => tool.execute('test', args, undefined, undefined, ctx as Parameters<ToolDefinition['execute']>[4]) };
}

test('AD1: CLI off-ref fast-forward lands, measures only changed invariant keys, and records observations before adopt', { timeout: 60_000 }, async () => {
  const f = await fixture({ invariants: [health, { id: 'untouched', run: 'true', reads: ['seed'], timeout_s: 10 }] });
  try {
    await git(f.cwd, ['switch', '--detach']); // exercise the actual update-ref CAS branch of advanceTrunk
    const hotfix = await f.hotfix({ health: 'fixed', hotfix: 'ok' });
    const preview = await ops.adoptPreview({ cwd: f.cwd, commit: hotfix.commit });
    assert.deepEqual(preview, { trunk: 'main', prior: f.base, commit: hotfix.commit, commits: 1, changed: ['health', 'hotfix'] });
    assert.equal(await revParse(f.cwd, 'refs/heads/main'), f.base, 'preview has no effect');
    const before = await f.ledger.read();
    const out = await cli(f.cwd, ['adopt', '--commit', hotfix.commit, '--note', 'owner hotfix', '--no-lease', '--json']);
    assert.equal(out.code, 0, out.stderr);
    const result = JSON.parse(out.stdout) as ops.AdoptResult;
    assert.equal(await revParse(f.cwd, 'refs/heads/main'), hotfix.commit);
    assert.deepEqual(result.observations.map(e => e.kind === 'obs' && [e.subject, e.obligation, e.verdict, e.commit]), [['trunk', 'inv:health', 'pass', hotfix.commit]]);
    const added = (await f.ledger.read()).slice(before.length);
    assert.deepEqual(added.map(e => e.kind), ['obs', 'adopt']);
    assert.ok(result.entry.kind === 'adopt');
    assert.equal(result.entry.prior, f.base); assert.equal(result.entry.commit, hotfix.commit);
    assert.deepEqual(result.entry.changed, ['health', 'hotfix']); assert.equal(result.entry.commits, 1);
    assert.equal((await ops.readState(f)).state.trunk.commit, hotfix.commit);
    assert.equal((await ops.status(f)).drift, undefined);
    assert.equal((await ops.verify(f)).ok, true);
  } finally { await f.cleanup(); }
});

test('AD1: guard failure preserves ref and records failing observations; retry preserves existing observation', { timeout: 60_000 }, async () => {
  const f = await fixture({ invariants: [health] });
  try {
    const hotfix = await f.hotfix({ broken: 'regression' }), before = await f.ledger.read();
    await assert.rejects(adopt(f.cwd, hotfix.commit), /adoption refused: invariant health \(obs #\d+\).*fix the hotfix, then run owed adopt --commit <new>/);
    assert.equal(await revParse(f.cwd, 'refs/heads/main'), f.base);
    const after = await f.ledger.read(), added = after.slice(before.length);
    assert.deepEqual(added.map(e => e.kind === 'obs' && [e.obligation, e.verdict, e.commit]), [['inv:health', 'fail', hotfix.commit]]);
    await assert.rejects(adopt(f.cwd, hotfix.commit), /adoption refused/);
    assert.deepEqual(await f.ledger.read(), after);
    assert.equal((await ops.readState(f)).state.trunk.commit, f.base);
    assert.equal((await ops.verify(f)).ok, true);
  } finally { await f.cleanup(); }
});

test('AD1: ref moved by an external writer during off-ref measurement records nothing and keeps their ref', { timeout: 60_000 }, async () => {
  const f = await fixture(); const g = gate(f.root, 'hotfix');
  let outcome: Promise<unknown> | undefined;
  try {
    await ops.planSet({ cwd: f.cwd, as: owner, channel: 'delegated', note: 'add gate', plan: JSON.stringify({ ...(await ops.readState(f)).state.plan, invariants: [g.invariant] }) });
    const hotfix = await f.hotfix({ hotfix: 'ok' }), before = await f.ledger.read();
    outcome = adopt(f.cwd, hotfix.commit).catch(error => error);
    await until(() => existsSync(g.marker), 'off-ref measurement starts');
    const external = await commitAt(f.cwd, { external: 'another writer' });
    await writeFile(g.release, '');
    assert.match(String(await outcome), /refs\/heads\/main moved during adopt .*nothing was recorded/);
    assert.equal(await revParse(f.cwd, 'refs/heads/main'), external);
    assert.deepEqual(await f.ledger.read(), before);
  } finally { await writeFile(g.release, ''); await outcome; await f.cleanup(); }
});

test('AD1: abort during measurement leaves ref unchanged and retains only completed observations', { timeout: 60_000 }, async () => {
  const f = await fixture(); const g = gate(f.root, 'hotfix'), abort = new AbortController();
  let outcome: Promise<unknown> | undefined;
  try {
    await ops.planSet({ cwd: f.cwd, as: owner, channel: 'delegated', note: 'add invariants', plan: JSON.stringify({ ...(await ops.readState(f)).state.plan, invariants: [health, g.invariant] }) });
    const hotfix = await f.hotfix({ health: 'fixed', hotfix: 'ok' }), before = await f.ledger.read();
    outcome = adopt(f.cwd, hotfix.commit, { signal: abort.signal }).catch(error => error);
    await until(() => existsSync(g.marker), 'second invariant starts after first completes'); abort.abort();
    assert.equal((await outcome as { code: string }).code, 'aborted');
    assert.equal(await revParse(f.cwd, 'refs/heads/main'), f.base);
    assert.deepEqual((await f.ledger.read()).slice(before.length).map(e => e.kind === 'obs' && [e.obligation, e.verdict]), [['inv:health', 'pass']]);
    assert.equal((await ops.verify(f)).ok, true);
  } finally { abort.abort(); await outcome; await f.cleanup(); }
});

test('AD2: divergent off-ref commit refuses before measurement with the current trunk and rebase remedy', { timeout: 60_000 }, async () => {
  const f = await fixture({ invariants: [health] });
  try {
    const hotfix = await f.hotfix({ broken: 'would fail if measured' });
    const current = await commitAt(f.cwd, { trunk: 'advanced' }); await adopt(f.cwd);
    const before = await f.ledger.read();
    const out = await cli(f.cwd, ['adopt', '--commit', hotfix.commit, '--note', 'hotfix', '--no-lease']);
    assert.equal(out.code, 1, out.stderr);
    assert.equal(out.stderr.trim().split('\n').length, 1);
    assert.match(out.stderr, new RegExp(`new ledger trunk ${current.slice(0, 12)}; rebase ${hotfix.commit.slice(0, 12)} onto ${current.slice(0, 12)}, then run owed adopt --commit <new>`));
    assert.deepEqual(await f.ledger.read(), before); assert.equal(await revParse(f.cwd, 'refs/heads/main'), current);
  } finally { await f.cleanup(); }
});

test('AD4: an off-ref commit already contained in ledger trunk refuses as usage before measurement, without a rebase hint', { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    const hotfix = await f.hotfix({ hotfix: 'landed' });
    await adopt(f.cwd, hotfix.commit);
    const prior = await commitAt(f.cwd, { trunk: 'later commit' }); await adopt(f.cwd);
    const measured = join(f.root, 'unexpected-measurement');
    await ops.planSet({ cwd: f.cwd, as: owner, channel: 'delegated', note: 'add unmeasured invariant', plan: JSON.stringify({ ...(await ops.readState(f)).state.plan, invariants: [{ id: 'unmeasured', reads: ['hotfix', 'trunk'], timeout_s: 10, run: `touch '${measured}'` }] }) });
    const before = await f.ledger.read();
    const message = `nothing to adopt: ${hotfix.commit.slice(0, 12)} is already contained in the ledger trunk ${prior.slice(0, 12)}`;
    await assert.rejects(adopt(f.cwd, hotfix.commit), (error: unknown) => {
      assert.equal((error as { code: string }).code, 'usage');
      assert.equal((error as Error).message, message);
      return true;
    });
    const out = await cli(f.cwd, ['adopt', '--commit', hotfix.commit, '--note', 'already landed', '--no-lease']);
    assert.equal(out.code, 2); assert.equal(out.stdout, '');
    assert.equal(out.stderr, `Usage error: ${message}\n`);
    assert.doesNotMatch(out.stderr, /rebase|new ledger trunk/);
    assert.equal(existsSync(measured), false, 'no invariant was measured');
    assert.deepEqual(await f.ledger.read(), before);
    assert.equal(await revParse(f.cwd, 'refs/heads/main'), prior);
    assert.equal((await ops.readState(f)).state.trunk.commit, prior);
  } finally { await f.cleanup(); }
});

test('AD1/AD2: real in-flight merge finishes first; waiting adopt sees new trunk and refuses without invalidating merge', { timeout: 90_000 }, async () => {
  const f = await fixture({ nodes: [{ id: 'a', deps: [], writes: ['a.txt'], checks: [], review: { count: 0, min_rank: 1 } }] });
  const g = gate(f.root, 'a.txt');
  let merging: Promise<ops.MergeResult> | undefined, adopting: Promise<unknown> | undefined;
  try {
    await accept(f);
    await ops.planSet({ cwd: f.cwd, as: owner, channel: 'delegated', note: 'merge gate', plan: JSON.stringify({ ...(await ops.readState(f)).state.plan, invariants: [g.invariant, health] }) });
    const hotfix = await f.hotfix({ broken: 'not to be measured' });
    merging = ops.merge({ cwd: f.cwd, as: parent, node: 'a', lease: false });
    await until(() => existsSync(g.marker), 'merge owns merge lock while measuring');
    adopting = adopt(f.cwd, hotfix.commit, { wait: 10 }).catch(error => error);
    await until(async () => (await pendingAdopt(f.ledger.dir))?.commit === hotfix.commit, 'adopt pending is visible while waiting');
    assert.equal(await revParse(f.cwd, 'refs/heads/main'), f.base);
    await writeFile(g.release, ''); const merged = await merging;
    const error = String(await adopting);
    assert.match(error, new RegExp(`new ledger trunk ${merged.commit.slice(0, 12)}; rebase .*owed adopt --commit <new>`));
    assert.equal(await revParse(f.cwd, 'refs/heads/main'), merged.commit);
    const entries = await f.ledger.read();
    assert.equal(entries.filter(e => e.kind === 'merge').length, 1);
    assert.equal(entries.some(e => e.kind === 'adopt' || (e.kind === 'obs' && e.commit === hotfix.commit)), false);
    assert.equal((await ops.readState(f)).state.nodes.a!.phase, 'merged');
    assert.equal((await ops.status(f)).drift, undefined); assert.equal((await ops.verify(f)).ok, true);
  } finally { await writeFile(g.release, ''); await merging; await adopting; await f.cleanup(); }
});

test('AD1: off-ref adoption waits for merge lock, publishes AW pending, then lands when trunk remains unchanged', { timeout: 60_000 }, async () => {
  const f = await fixture(); let release!: () => void, acquired!: () => void;
  const ready = new Promise<void>(resolve => { acquired = resolve; }), gate = new Promise<void>(resolve => { release = resolve; });
  const held = f.ledger.withLock(async () => { acquired(); await gate; }, 'merge');
  let outcome: Promise<ops.AdoptResult> | undefined;
  try {
    await ready; const hotfix = await f.hotfix({ hotfix: 'ok' });
    outcome = adopt(f.cwd, hotfix.commit, { wait: 10 });
    await until(async () => (await pendingAdopt(f.ledger.dir))?.commit === hotfix.commit, 'off-ref pending adoption is visible');
    assert.equal(await revParse(f.cwd, 'refs/heads/main'), f.base); release(); await held;
    assert.equal((await outcome).commit, hotfix.commit);
    assert.equal((await ops.status(f)).mergeWaiting, undefined);
  } finally { release(); await held; await outcome; await f.cleanup(); }
});

test('AD1: parent outside adopt allowance is refused before measuring or moving; a covered parent lands', { timeout: 60_000 }, async () => {
  const f = await fixture({ allow: [{ nodes: ['*'], adopt: ['allowed/**'] }], invariants: [health] });
  try {
    const hotfix = await f.hotfix({ broken: 'outside allowance' }), before = await f.ledger.read();
    const out = await cli(f.cwd, ['adopt', '--commit', hotfix.commit, '--note', 'parent hotfix', '--as', 'parent:test', '--no-lease']);
    assert.equal(out.code, 1); assert.match(out.stderr, /parent adoption refused: changed path broken/);
    assert.equal(await revParse(f.cwd, 'refs/heads/main'), f.base); assert.deepEqual(await f.ledger.read(), before);
    await git(hotfix.path, ['switch', '--detach', f.base]);
    const covered = await commitAt(hotfix.path, { 'allowed/fix': 'ok' });
    const result = await adopt(f.cwd, covered, { as: parent });
    assert.equal(result.entry.by, 'parent:test'); assert.equal(typeof result.allowance, 'number');
    assert.equal(await revParse(f.cwd, 'refs/heads/main'), covered); assert.equal((await ops.verify(f)).ok, true);
  } finally { await f.cleanup(); }
});

test('AD1: failed append after advance leaves ref ahead; no-commit adopt recovers with the unchanged ledger format', { timeout: 60_000 }, async t => {
  const f = await fixture({ invariants: [health] });
  try {
    const hotfix = await f.hotfix({ health: 'fixed' }), before = await f.ledger.read(), append = Ledger.prototype.append;
    t.mock.method(Ledger.prototype, 'append', async function (this: Ledger, drafts: Draft[]) {
      if (drafts.some(d => d.kind === 'adopt')) {
        assert.equal(await revParse(f.cwd, 'refs/heads/main'), hotfix.commit, 'ref moves before observations/adopt append');
        assert.deepEqual(await this.read(), before, 'observations and adopt append together');
        throw new Error('simulated crash before ledger append');
      }
      return append.call(this, drafts);
    });
    await assert.rejects(adopt(f.cwd, hotfix.commit), /simulated crash before ledger append/);
    t.mock.restoreAll();
    assert.equal(await revParse(f.cwd, 'refs/heads/main'), hotfix.commit); assert.deepEqual(await f.ledger.read(), before);
    assert.equal((await ops.status(f)).drift?.relation, 'ahead');
    const recovered = await adopt(f.cwd);
    assert.equal(recovered.commit, hotfix.commit);
    assert.deepEqual((await f.ledger.read()).slice(before.length).map(e => e.kind), ['obs', 'adopt']);
    assert.equal((await ops.status(f)).drift, undefined); assert.equal((await ops.verify(f)).ok, true);
  } finally { t.mock.restoreAll(); await f.cleanup(); }
});

test('AD3: checked-out trunk worktree is fast-forwarded in place and stays attached', { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    await git(f.cwd, ['switch', '--detach']); const trunk = join(f.root, 'trunk');
    await git(f.cwd, ['worktree', 'add', trunk, 'main']);
    const hotfix = await f.hotfix({ hotfix: 'ok' });
    await adopt(f.cwd, hotfix.commit);
    assert.equal(await revParse(trunk, 'HEAD'), hotfix.commit);
    assert.equal((await git(trunk, ['symbolic-ref', 'HEAD'])).stdout.trim(), 'refs/heads/main');
    assert.equal(await readFile(join(trunk, 'hotfix'), 'utf8'), 'ok');
    assert.equal((await git(trunk, ['status', '--porcelain'])).stdout, '');
  } finally { await f.cleanup(); }
});

test('AD3: dirty checked-out trunk and obstructing untracked files refuse just as merge does, with no ledger append', { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    const hotfix = await f.hotfix({ hotfix: 'ok' }), before = await f.ledger.read();
    await writeFile(join(f.cwd, 'seed'), 'user edit');
    await assert.rejects(adopt(f.cwd, hotfix.commit), /trunk worktree .* has uncommitted changes/);
    assert.equal(await readFile(join(f.cwd, 'seed'), 'utf8'), 'user edit');
    await writeFile(join(f.cwd, 'seed'), 'base'); await writeFile(join(f.cwd, 'hotfix'), 'untracked user file');
    await assert.rejects(adopt(f.cwd, hotfix.commit), /untracked working tree files would be overwritten/);
    assert.equal(await readFile(join(f.cwd, 'hotfix'), 'utf8'), 'untracked user file');
    assert.equal(await revParse(f.cwd, 'refs/heads/main'), f.base); assert.deepEqual(await f.ledger.read(), before);
  } finally { await f.cleanup(); }
});

test('AD1: reference-transaction refusal on CAS path preserves ref and appends no observations', { timeout: 60_000 }, async () => {
  const f = await fixture({ invariants: [health] });
  try {
    await git(f.cwd, ['switch', '--detach']); const hotfix = await f.hotfix({ health: 'fixed' });
    const hook = join(f.cwd, '.git', 'hooks', 'reference-transaction');
    await writeFile(hook, '#!/bin/sh\nif [ "$1" = prepared ] && grep -q " refs/heads/main$"; then exit 1; fi\n'); await chmod(hook, 0o755);
    const before = await f.ledger.read();
    await assert.rejects(adopt(f.cwd, hotfix.commit), /trunk changed \(CAS\)/);
    assert.equal(await revParse(f.cwd, 'refs/heads/main'), f.base); assert.deepEqual(await f.ledger.read(), before);
  } finally { await f.cleanup(); }
});

test('AD3: existing ref/default forms are unchanged, and an off-ref target cannot ignore external trunk drift', { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    const hotfix = await f.hotfix({ hotfix: 'off-ref' }), external = await commitAt(f.cwd, { external: 'on trunk' });
    const before = await f.ledger.read();
    await assert.rejects(adopt(f.cwd, hotfix.commit), /adopt records only what is on trunk/);
    assert.deepEqual(await f.ledger.read(), before); assert.equal(await revParse(f.cwd, 'refs/heads/main'), external);
    await adopt(f.cwd, external); assert.equal(await revParse(f.cwd, 'refs/heads/main'), external);
    const next = await commitAt(f.cwd, { external: 'next' });
    assert.equal((await adopt(f.cwd)).commit, next);
    await assert.rejects(adopt(f.cwd), /nothing to adopt/); assert.equal((await ops.verify(f)).ok, true);
  } finally { await f.cleanup(); }
});

test('AD3: help/tool advertise driver-safe hotfix landing; tool confirmation previews off-ref paths and lands only on confirmation', { timeout: 60_000 }, async () => {
  const f = await fixture();
  try {
    const hotfix = await f.hotfix({ hotfix: 'ok' }), before = await f.ledger.read();
    const help = await cli(f.cwd, ['--help']);
    assert.equal(help.code, 0); assert.match(help.stdout, /off-ref fast-forward hotfix under the merge lock without stopping the driver/);
    const harness = toolHarness(f.cwd);
    assert.match(harness.tool.description, /off-ref fast-forward hotfix under the merge lock without stopping the driver/);
    process.env.OWED_CONFIRM = 'owner';
    const prompts: string[] = [];
    const declined = await toolHarness(f.cwd, async message => { prompts.push(message); return false; }).call({ commit: hotfix.commit, note: 'owner fix', lease: false });
    assert.match(JSON.stringify(declined), /did not confirm/);
    assert.ok(prompts[0]!.includes(hotfix.commit.slice(0, 12))); assert.match(prompts[0]!, /Changed paths \(1\):\n  hotfix/);
    assert.equal(await revParse(f.cwd, 'refs/heads/main'), f.base); assert.deepEqual(await f.ledger.read(), before);
    const result = await toolHarness(f.cwd, async () => true).call({ commit: hotfix.commit, note: 'owner fix', lease: false });
    assert.notEqual((result as { isError?: boolean }).isError, true, JSON.stringify(result));
    assert.equal(await revParse(f.cwd, 'refs/heads/main'), hotfix.commit);
    const last = (await f.ledger.read()).at(-1)!;
    assert.ok(last.kind === 'adopt' && last.channel === 'pi-confirm' && last.commit === hotfix.commit);
  } finally { delete process.env.OWED_CONFIRM; await f.cleanup(); }
});
