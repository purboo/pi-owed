import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, realpath, stat, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parse } from 'yaml';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';
import { Ledger } from '../src/ledger.ts';
import * as ops from '../src/ops.ts';
import { git, revParse } from '../src/git.ts';
import { decoyDigest } from '../src/reducer.ts';
import type { Entry, Plan } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt, checkTest, identity } from './helpers/surface.ts';

type Repo = Awaited<ReturnType<typeof repo>>;
type Result = Awaited<ReturnType<ToolDefinition['execute']>> & { isError?: boolean };
const parent = { role: 'parent' as const, id: 'main' };
const exists = async (path: string) => { try { await stat(path); return true; } catch { return false; } };
async function call<T>(cwd: string, args: string[], code = 0): Promise<T> {
  const out = await cli(cwd, [...args, '--json']);
  assert.equal(out.code, code, `${args.join(' ')}\n${out.stderr}\n${out.stdout}`);
  return (code === 0 ? JSON.parse(out.stdout) : out) as T;
}
async function entries(cwd: string): Promise<Entry[]> { return (await Ledger.open(cwd)).read(); }
const node = (id: string, writes: string[], review = 0) => ({ id, writes, checks: [], review: { count: review, min_rank: 1 } });
/** a and c overlap on shared/; b is disjoint. Only a needs a review. */
const plain = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: [node('a', ['a.txt', 'shared/'], 1), node('b', ['b.txt']), node('c', ['shared/c/'])] };
async function fixture(plan: object = plain): Promise<Repo> {
  const r = await repo();
  try {
    await r.put('plan.json', JSON.stringify(plan)); await r.put('README', 'x\n'); await r.commit();
    await call(r.cwd, ['init', 'plan.json', '--i-am-owner']);
    return r;
  } catch (e) { await r.cleanup(); throw e; }
}

test('dispatch from inside a slot worktree uses the main worktree root; gc of the outer attempt keeps the open slot (review #95)', { timeout: 120_000 }, async () => {
  const r = await fixture();
  try {
    const main = await realpath(r.cwd);
    const a = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
    const b = await ops.dispatch({ cwd: join(a.worktree), node: 'b', as: parent });
    assert.equal(await realpath(b.worktree), join(main, '.owed', 'wt', 'b-1'), 'not nested in the a worktree');
    await mkdir(join(a.worktree, 'shared'), { recursive: true });
    const c = await ops.dispatch({ cwd: join(a.worktree, 'shared'), node: 'c', as: parent, allowOverlap: true });
    assert.equal(await realpath(c.worktree), join(main, '.owed', 'wt', 'c-1'), 'from a subdirectory of a slot worktree too');
    const exclude = await readFile(join(main, '.git', 'info', 'exclude'), 'utf8');
    assert.ok(exclude.split('\n').includes('.owed/'), 'the common info/exclude ignores .owed/');
    // abandon --note records the note; --note and --reason together are a usage error.
    assert.equal((await cli(r.cwd, ['abandon', 'a', '--note', 'x', '--reason', 'y'])).code, 2);
    const abandoned = await cli(r.cwd, ['abandon', 'a', '--note', 'wrong approach']);
    assert.equal(abandoned.code, 0, abandoned.stderr); assert.match(abandoned.stdout, /abandoned a attempt 1: wrong approach/);
    const last = (await entries(r.cwd)).at(-1)!;
    assert.ok(last.kind === 'abandon' && last.reason === 'wrong approach');
    // gc is a parent/owner operation (CLI and ops).
    { const out = await cli(b.worktree, ['gc', '--as', 'reviewer:x']); assert.equal(out.code, 1); assert.match(out.stderr, /gc requires parent\/owner/); }
    await assert.rejects(ops.gc({ cwd: r.cwd, as: { role: 'writer', id: 'b#1' } }), /gc requires parent\/owner/);
    // gc run from inside the open b worktree removes a#1 only.
    const gc = await call<ops.GcResult>(b.worktree, ['gc']);
    assert.deepEqual(gc.removed.map(i => `${i.node}#${i.attempt}`), ['a#1']);
    assert.equal(await exists(a.worktree), false);
    assert.ok(await exists(join(b.worktree, '.git')), 'the open b worktree survives gc of a');
    assert.ok(await exists(join(c.worktree, '.git')), 'the open c worktree survives gc of a');
    const listed = (await git(r.cwd, ['worktree', 'list', '--porcelain'])).stdout;
    assert.match(listed, new RegExp(`worktree ${join(main, '.owed', 'wt', 'b-1')}\n`));
    await commitAt(b.worktree, { 'b.txt': 'b\n' });
    await call(b.worktree, ['submit', 'b']);
    assert.equal((await ops.status({ cwd: r.cwd })).nodes.b!.phase, 'submitted');
  } finally { await r.cleanup(); }
});

test('gc keeps a finished worktree that contains another worktree (layout left by an older dispatch)', { timeout: 60_000 }, async () => {
  const r = await fixture();
  try {
    const a = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
    const nested = join(a.worktree, '.owed', 'wt', 'b-1');
    await git(a.worktree, ['worktree', 'add', '-b', 'stray', nested, 'main']);
    await ops.abandon({ cwd: r.cwd, node: 'a', reason: 'x', as: parent });
    const result = await ops.gc({ cwd: r.cwd });
    assert.deepEqual(result.removed, []);
    assert.match(result.kept.find(k => k.node === 'a')!.reason, /contains worktree .*b-1/);
    assert.ok(await exists(join(nested, '.git')));
  } finally { await r.cleanup(); }
});

test('dispatch refuses overlapping writes of an open slot unless --allow-overlap, which is recorded; status marks such ready nodes', { timeout: 60_000 }, async () => {
  const r = await fixture();
  try {
    await call(r.cwd, ['dispatch', 'a']);
    const refused = await call<{ stderr: string }>(r.cwd, ['dispatch', 'c'], 1);
    assert.match(refused.stderr, /writes of c overlap the open slot of a/);
    const status = await call<{ ready: string[]; overlaps: Record<string, string[]> }>(r.cwd, ['status']);
    assert.deepEqual(status.overlaps, { c: ['a'] });
    assert.match((await cli(r.cwd, ['status'])).stdout, /Ready \(by dependent count\): .*c \(writes overlap open slot of a\)/);
    const b = await call<{ entry: Entry }>(r.cwd, ['dispatch', 'b']);
    assert.equal('overlaps' in b.entry, false, 'disjoint writes record nothing');
    const c = await call<{ entry: Entry }>(r.cwd, ['dispatch', 'c', '--allow-overlap']);
    assert.ok(c.entry.kind === 'dispatch'); assert.deepEqual(c.entry.overlaps, ['a']);
    assert.match((await cli(r.cwd, ['why', 'c'])).stdout, /c: dispatched/);
  } finally { await r.cleanup(); }
});

test('rebase in place: trunk moves, the slot base becomes trunk, the candidate is invalidated, blocks still bind and the receipt shows a range-diff hint', { timeout: 120_000 }, async () => {
  const r = await fixture();
  try {
    const a = await call<ops.DispatchPacket>(r.cwd, ['dispatch', 'a']), oldBase = await revParse(r.cwd, 'main');
    const oldCommit = await commitAt(a.worktree, { 'a.txt': 'a\n', 'shared/x': 'x\n' });
    await call(a.worktree, ['submit', 'a']);
    { const out = await cli(r.cwd, ['rebase', 'a']); assert.equal(out.code, 1); assert.match(out.stderr, /trunk has not moved/); }
    await call(r.cwd, ['review', 'a', '--block', '--rank', '1', '--note', 'needs work', '--as', 'reviewer:r1']);
    const b = await call<ops.DispatchPacket>(r.cwd, ['dispatch', 'b']);
    await commitAt(b.worktree, { 'b.txt': 'b\n' });
    await call(b.worktree, ['submit', 'b']); await call(r.cwd, ['attest', 'b']); await call(r.cwd, ['merge', 'b']);
    const trunk = await revParse(r.cwd, 'main');
    { const out = await cli(r.cwd, ['rebase', 'a', '--as', 'reviewer:r1']); assert.equal(out.code, 1); assert.match(out.stderr, /rebase requires parent\/owner or the slot writer/); }
    assert.equal((await cli(r.cwd, ['rebase', 'b'])).code, 1, 'no open slot');
    // The writer is inferred from the slot worktree.
    const rebased = await call<ops.RebaseResult>(a.worktree, ['rebase', 'a']);
    assert.deepEqual({ ...rebased.entry, seq: 0, ts: '', prev: '', hash: '' }, { kind: 'rebase', by: 'writer:a#1', node: 'a', attempt: 1, base: trunk, from: oldBase, seq: 0, ts: '', prev: '', hash: '' });
    assert.match(rebased.packet, new RegExp(`git rebase --onto ${trunk} ${oldBase}`));
    assert.match(rebased.packet, new RegExp(`git range-diff ${oldBase}\\.\\.${oldCommit} ${trunk}\\.\\.<new commit>`));
    const s = await ops.status({ cwd: r.cwd });
    assert.equal(s.nodes.a!.phase, 'dispatched'); assert.equal(s.nodes.a!.slot!.base, trunk); assert.equal(s.nodes.a!.candidate, undefined);
    { const out = await cli(a.worktree, ['submit', 'a']); assert.equal(out.code, 1); assert.match(out.stderr, /descendant of slot base/); }
    await git(a.worktree, ['rebase', '--onto', trunk, oldBase], { env: identity });
    const newCommit = await revParse(a.worktree, 'HEAD');
    await call(a.worktree, ['submit', 'a']);
    const card = await call<ops.ReceiptCard>(r.cwd, ['attest', 'a'], 1) as unknown as { stdout: string };
    assert.match(card.stdout, /needs work|blocked/);
    const why = await call<ops.ReceiptCard>(r.cwd, ['why', 'a']);
    assert.equal(why.accepted, false, 'the review block binds the node across the rebase');
    assert.equal(why.blocks.length, 1);
    assert.equal(why.rebase?.previous?.commit, oldCommit);
    assert.equal(why.rebase?.rangeDiff, `git range-diff ${oldBase}..${oldCommit} ${trunk}..${newCommit}`);
    assert.match((await cli(r.cwd, ['why', 'a'])).stdout, /Re-review only the resolution: git range-diff/);
    assert.equal((await ops.status({ cwd: r.cwd })).nodes.a!.candidate!.base, trunk, 'the new candidate is based on the new slot base');
  } finally { await r.cleanup(); }
});

test('plan --rev reads the plan file from a commit and records rev and path; without --rev the working tree file is used', { timeout: 60_000 }, async () => {
  const r = await fixture();
  try {
    const stronger = structuredClone(plain); stronger.nodes[1]!.review.count = 2;
    await r.put('plans/next.json', JSON.stringify(stronger)); const rev = await r.commit();
    const weaker = structuredClone(plain); weaker.nodes.pop();
    await r.put('plans/next.json', JSON.stringify(weaker)); // uncommitted downgrade
    await mkdir(join(r.cwd, 'sub'), { recursive: true });
    const sub = join(r.cwd, 'sub');
    const out = await cli(sub, ['plan', '../plans/next.json', '--rev', 'HEAD']);
    assert.equal(out.code, 0, out.stderr); assert.match(out.stdout, new RegExp(`from plans/next\\.json at ${rev.slice(0, 12)}`));
    const e = (await entries(r.cwd)).at(-1)!;
    assert.ok(e.kind === 'plan'); assert.equal(e.rev, rev); assert.equal(e.path, 'plans/next.json');
    const stored = parse((await (await Ledger.open(r.cwd)).getBlob(e.plan)).toString()) as Plan;
    assert.equal(stored.nodes.find(n => n.id === 'b')!.review.count, 2, 'the committed text, not the working tree');
    assert.equal((await cli(sub, ['plan', '../plans/next.json', '--rev', 'no-such-rev'])).code, 2);
    assert.equal((await cli(sub, ['plan', '../plans/missing.json', '--rev', 'HEAD'])).code, 2);
    assert.equal((await cli(sub, ['plan', '../../outside.json', '--rev', 'HEAD'])).code, 2);
    const wt = await cli(r.cwd, ['plan', 'plans/next.json']);
    assert.equal(wt.code, 1, 'the working-tree downgrade needs the owner'); assert.match(wt.stderr, /Only owner/);
    stronger.nodes[1]!.review.count = 3; await r.put('plans/next.json', JSON.stringify(stronger));
    await call(r.cwd, ['plan', 'plans/next.json']);
    const w = (await entries(r.cwd)).at(-1)!;
    assert.ok(w.kind === 'plan'); assert.equal(w.rev, undefined); assert.equal(w.path, 'plans/next.json');
  } finally { await r.cleanup(); }
});

// ---------- ruling #105: merge-time decoy attribution through the real CLI merge path ----------
const inv = { id: 'unit', run: 'node --test --test-reporter=tap test/invariant.test.cjs', min_tests: 1, reads: ['test/invariant.test.cjs', 'test/state.cjs'] };
const checked = (id: string) => ({ id, writes: ['test/'], checks: [{ id, run: `node --test --test-reporter=tap test/${id}.test.cjs`, reads: [`test/${id}*`], min_tests: 1 }], review: { count: 0, min_rank: 1 } });
const merging = { version: 1, trunk: 'main', closure: [], invariants: [inv], nodes: [checked('d1'), checked('d2')] };

test('merge attribution: a refused merge whose merge-result invariant fails catches the decoy; pre-existing deferred trunk debt never counts (ruling #105)', { timeout: 240_000 }, async () => {
  const r = await repo();
  try {
    await commitAt(r.cwd, { 'test/state.cjs': 'module.exports=1;', 'test/invariant.test.cjs': checkTest('state', 1), 'test/d1.cjs': 'module.exports=0;', 'test/d2.cjs': 'module.exports=0;' });
    const planFile = join(r.root, 'plan.json'); await writeFile(planFile, JSON.stringify(merging));
    await call(r.cwd, ['init', planFile, '--i-am-owner']);
    const p1 = { nonce: 'flow-nonce-d1-0123456789', decoys: [{ node: 'd1', defect: 'breaks state' }] };
    const p2 = { nonce: 'flow-nonce-d2-0123456789', decoys: [{ node: 'd2', defect: 'breaks state again' }] };
    const f1 = join(r.root, 'd1.json'), f2 = join(r.root, 'd2.json');
    await writeFile(f1, JSON.stringify(p1)); await writeFile(f2, JSON.stringify(p2));
    await call(r.cwd, ['decoy', 'commit', decoyDigest(p1), '--i-am-owner']);
    await call(r.cwd, ['decoy', 'commit', decoyDigest(p2), '--i-am-owner']);
    const decoys = async () => (await call<{ escapes: { decoys: { node: string; outcome: string; decidedBy?: number }[]; caught: number; escaped: number } }>(r.cwd, ['report'])).escapes;
    // d1: its own check passes; only the merge-result invariant fails.
    const d1 = await call<ops.DispatchPacket>(r.cwd, ['dispatch', 'd1']);
    await commitAt(d1.worktree, { 'test/d1.cjs': 'module.exports=1;', 'test/d1.test.cjs': checkTest('d1', 1), 'test/state.cjs': 'module.exports=2;' });
    await call(d1.worktree, ['submit', 'd1']); await call(r.cwd, ['attest', 'd1']);
    await call(r.cwd, ['decoy', 'reveal', f1, '--i-am-owner']);
    assert.equal((await decoys()).decoys[0]!.outcome, 'pending');
    { const out = await cli(r.cwd, ['merge', 'd1']); assert.equal(out.code, 1); assert.match(out.stderr, /invariant unit new debt/); }
    const failed = (await entries(r.cwd)).findLast(e => e.kind === 'obs' && e.subject === 'trunk' && e.verdict === 'fail')!;
    assert.ok(failed.kind === 'obs'); assert.equal(failed.merging, 'd1', 'merge-result obs records the node being merged');
    assert.ok((await entries(r.cwd)).filter(e => e.kind === 'obs' && e.seq > d1.entry.seq && e.subject === 'd1' && e.commit !== failed.commit).every(e => e.kind === 'obs' && e.merging === undefined), 'attest obs carry no merging');
    assert.deepEqual((await decoys()).decoys.map(d => [d.node, d.outcome, d.decidedBy]), [['d1', 'caught', failed.seq]], 'caught by the refused merge');
    await call(r.cwd, ['defer', 'd1', 'unit', '--reason', 'accepted for now', '--i-am-owner']);
    const m1 = await call<ops.MergeResult>(r.cwd, ['merge', 'd1']);
    assert.equal((await decoys()).decoys[0]!.outcome, 'caught', 'a later merge does not turn a catch into an escape');
    // d2 merges onto trunk that already carries deferred debt for the same invariant.
    const d2 = await call<ops.DispatchPacket>(r.cwd, ['dispatch', 'd2']);
    await commitAt(d2.worktree, { 'test/d2.cjs': 'module.exports=1;', 'test/d2.test.cjs': checkTest('d2', 1), 'test/state.cjs': 'module.exports=3;' });
    await call(d2.worktree, ['submit', 'd2']); await call(r.cwd, ['attest', 'd2']);
    { const out = await cli(r.cwd, ['merge', 'd2']); assert.equal(out.code, 1); assert.match(out.stderr, /invariant unit new debt/); }
    const failed2 = (await entries(r.cwd)).findLast(e => e.kind === 'obs' && e.subject === 'trunk' && e.verdict === 'fail')!;
    assert.ok(failed2.kind === 'obs' && failed2.merging === 'd2' && failed2.seq > m1.entry.seq);
    await call(r.cwd, ['defer', 'd2', 'unit', '--reason', 'still accepted', '--i-am-owner']);
    const m2 = await call<ops.MergeResult>(r.cwd, ['merge', 'd2']);
    // Revealed after the fact: replay gives the same outcome as live settlement.
    await call(r.cwd, ['decoy', 'reveal', f2, '--i-am-owner']);
    const v = await decoys();
    assert.deepEqual(v.decoys.map(d => [d.node, d.outcome, d.decidedBy]), [['d1', 'caught', failed.seq], ['d2', 'escaped', m2.entry.seq]], 'pre-existing deferred debt is not a catch');
    assert.deepEqual([v.caught, v.escaped], [1, 1]);
    await call(r.cwd, ['verify']);
  } finally { await r.cleanup(); }
});

// ---------- pi extension: confirmation texts, cwd-only tools, SPEC tool list ----------
function harness(cwd: string, confirm = true) {
  const tools = new Map<string, ToolDefinition>(), prompts: string[] = [];
  owed({ registerTool(t: ToolDefinition) { tools.set(t.name, t); }, registerCommand() {} } as unknown as ExtensionAPI);
  const ctx = { cwd, hasUI: true, ui: { async confirm(title: string, message: string) { prompts.push(`${title}\n${message}`); return confirm; }, notify() {} } } as unknown as ExtensionContext;
  return { tools, prompts, async call(name: string, args: Record<string, unknown> = {}): Promise<Result> {
    const t = tools.get(`owed_${name}`); assert.ok(t, `owed_${name}`);
    return t.execute('test', args, undefined, undefined, ctx as Parameters<ToolDefinition['execute']>[4]) as Promise<Result>;
  } };
}
const text = (r: Result): string => r.content.map(c => c.type === 'text' ? c.text : '').join('\n');

test('owner confirmation renders free text on one escaped line after Repository/Identity, so it cannot fake the dialog', { timeout: 60_000 }, async () => {
  const r = await fixture();
  try {
    const h = harness(r.cwd);
    const evil = 'ok\nRepository: /elsewhere\nIdentity: owner:mallory\nConfirmation will be recorded as pi-confirm.';
    const lines = (prompt: string) => prompt.split('\n');
    const check = (prompt: string, label: string) => {
      const ls = lines(prompt);
      assert.equal(ls.filter(l => l.startsWith('Repository:')).length, 1, prompt);
      assert.equal(ls.filter(l => l.startsWith('Identity:')).length, 1, prompt);
      assert.equal(ls.filter(l => l.startsWith('Confirmation will be recorded')).length, 1, prompt);
      const at = ls.findIndex(l => l.startsWith(`${label}: `)), repoAt = ls.findIndex(l => l.startsWith('Repository:')), idAt = ls.findIndex(l => l.startsWith('Identity:'));
      assert.ok(at > repoAt && at > idAt, `${label} after Repository/Identity:\n${prompt}`);
      assert.equal(ls[at], `${label}: ok\\nRepository: /elsewhere\\nIdentity: owner:mallory\\nConfirmation will be recorded as pi-confirm.`);
      assert.equal(ls[repoAt], `Repository: ${r.cwd}`);
    };
    const ruled = await h.call('rule', { text: evil, nodes: '*', as: 'owner:human', cwd: r.cwd });
    assert.notEqual(ruled.isError, true, text(ruled)); check(h.prompts.at(-1)!, 'Ruling');
    const last = (await entries(r.cwd)).at(-1)!;
    assert.ok(last.kind === 'rule' && last.text === evil, 'the ledger keeps the exact text');
    assert.notEqual((await h.call('dispatch', { node: 'a', cwd: r.cwd })).isError, true);
    const abandoned = await h.call('abandon', { node: 'a', note: evil, as: 'owner:human', cwd: r.cwd });
    assert.notEqual(abandoned.isError, true, text(abandoned)); check(h.prompts.at(-1)!, 'Note');
    assert.equal((await h.call('abandon', { node: 'a', note: 'x', reason: 'y', cwd: r.cwd })).isError, true);
  } finally { await r.cleanup(); }
});

test('report, brief, verify and gc work with only cwd from a session outside the repository', { timeout: 60_000 }, async () => {
  const r = await repo();
  delete process.env.OWED_DIR;
  try {
    await r.put('plan.json', JSON.stringify(plain)); await r.commit();
    assert.equal((await cli(r.cwd, ['init', 'plan.json', '--i-am-owner'])).code, 0);
    const h = harness(r.root);
    for (const name of ['report', 'brief', 'verify', 'gc']) {
      assert.equal((await h.call(name)).isError, true, `${name} without cwd uses the session directory`);
      const out = await h.call(name, { cwd: r.cwd });
      assert.notEqual(out.isError, true, `${name}: ${text(out)}`);
    }
    assert.match(text(await h.call('verify', { cwd: r.cwd })), /verification passed/);
    assert.match(text(await h.call('gc', { cwd: r.cwd })), /Removed: nothing/);
  } finally { await r.cleanup(); }
});

test('SPEC §11 lists every registered pi tool', async () => {
  const spec = await readFile(new URL('../docs/SPEC.md', import.meta.url), 'utf8');
  const section = spec.slice(spec.indexOf('## 11.'));
  for (const name of harness('/').tools.keys()) assert.match(section, new RegExp(`\`${name}\``), `${name} is documented in SPEC §11`);
  assert.match(section, /`cwd`/);
});
