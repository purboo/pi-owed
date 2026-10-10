import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';
import { Ledger } from '../src/ledger.ts';
import * as ops from '../src/ops.ts';
import { git } from '../src/git.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';
// D25.4: these tests exercise the owner confirmation (dialog or TTY prompt), now the opt-in gate OWED_CONFIRM=owner.
process.env.OWED_CONFIRM = 'owner';

type Result = Awaited<ReturnType<ToolDefinition['execute']>> & { isError?: boolean };
/** confirm: the owner's answer to ui.confirm; null means the session has no UI. */
function harness(cwd: string, confirm: boolean | null = true) {
  const tools = new Map<string, ToolDefinition>();
  const prompts: string[] = [];
  owed({ registerTool(t: ToolDefinition) { tools.set(t.name, t); }, registerCommand() {} } as unknown as ExtensionAPI);
  const ctx = { cwd, hasUI: confirm !== null, ui: { async confirm(title: string, message: string) { prompts.push(`${title}\n${message}`); return confirm; }, notify() {} } } as unknown as ExtensionContext;
  return { tools, prompts, ctx, async call(name: string, args: Record<string, unknown> = {}): Promise<Result> {
    const t = tools.get(`owed_${name}`);
    assert.ok(t, `tool owed_${name} is registered`);
    return t.execute('test', args, undefined, undefined, ctx as Parameters<ToolDefinition['execute']>[4]) as Promise<Result>;
  } };
}
const text = (r: Result): string => r.content.map(c => c.type === 'text' ? c.text : '').join('\n');
const plan = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: [{ id: 'a', writes: ['a.txt'], checks: [], review: { count: 1, min_rank: 1 } }, { id: 'b', writes: ['b.txt'], checks: [], review: { count: 1, min_rank: 1 } }] };
async function fixture() {
  const r = await repo();
  await r.put('plan.json', JSON.stringify(plan)); await r.commit();
  const init = await cli(r.cwd, ['init', 'plan.json', '--i-am-owner']); assert.equal(init.code, 0, init.stderr);
  return r;
}
async function entries(cwd: string) { return (await Ledger.open(cwd)).read(); }

test('every tool accepts cwd: a session outside the repository drives dispatch, submit and plan in it', async () => {
  const r = await repo();
  // Keep the ledger inside the target repository (no OWED_DIR), as in a real session started elsewhere.
  delete process.env.OWED_DIR;
  try {
    await r.put('plan.json', JSON.stringify(plan)); await r.commit();
    assert.equal((await cli(r.cwd, ['init', 'plan.json', '--i-am-owner'])).code, 0);
    const h = harness(r.root); // r.root is not inside any git repository
    for (const t of h.tools.values()) assert.ok('cwd' in ((t.parameters as { properties?: object }).properties ?? {}), `${t.name} has a cwd parameter`);
    assert.equal((await h.call('status')).isError, true, 'without cwd the session directory is used');
    const status = await h.call('status', { cwd: r.cwd });
    assert.notEqual(status.isError, true, text(status)); assert.match(text(status), /Trunk main/);
    const relative = await h.call('status', { cwd: 'repo' });
    assert.equal(relative.isError, true); assert.match(text(relative), /absolute/);
    assert.equal((await h.call('status', { cwd: join(r.root, 'missing') })).isError, true);
    const d = await h.call('dispatch', { node: 'a', cwd: r.cwd });
    assert.notEqual(d.isError, true, text(d));
    const { worktree } = d.details as { worktree: string };
    await commitAt(worktree, { 'a.txt': 'done\n' });
    const submitted = await h.call('submit', { node: 'a', cwd: worktree });
    assert.notEqual(submitted.isError, true, text(submitted));
    const last = (await entries(r.cwd)).at(-1)!;
    assert.equal(last.kind, 'submit'); assert.equal(last.by, 'writer:a#1', 'writer inferred from the cwd worktree');
    const stronger = structuredClone(plan); stronger.nodes[1]!.review.count = 2;
    await r.put('stronger.json', JSON.stringify(stronger));
    const planned = await h.call('plan', { plan: 'stronger.json', cwd: r.cwd });
    assert.notEqual(planned.isError, true, text(planned));
    assert.equal((await entries(r.cwd)).at(-1)!.kind, 'plan');
  } finally { await r.cleanup(); }
});

test('owed_brief and owed_verify render views; a corrupt ledger is a tool error', async () => {
  const r = await fixture();
  try {
    const h = harness(r.cwd);
    assert.notEqual((await h.call('dispatch', { node: 'b' })).isError, true);
    const brief = await h.call('brief');
    assert.notEqual(brief.isError, true, text(brief));
    assert.match(text(brief), /^Brief \(since start\)/); assert.match(text(brief), /In progress \(1\):\n {2}b dispatched \(attempt 1\)/);
    assert.deepEqual((brief.details as ops.Brief).inProgress.map(p => p.node), ['b']);
    const later = await h.call('brief', { since: (await entries(r.cwd)).length - 1 });
    assert.match(text(later), /Merged: none/);
    assert.equal((await h.call('brief', { since: 'not a time' })).isError, true);
    const ok = await h.call('verify');
    assert.notEqual(ok.isError, true); assert.match(text(ok), /Ledger verification passed: \d+ entries/);
    const file = join(process.env.OWED_DIR!, 'ledger.jsonl'), lines = (await readFile(file, 'utf8')).trimEnd().split('\n');
    const tampered = JSON.parse(lines.at(-1)!); tampered.by = 'owner:forged';
    await writeFile(file, [...lines.slice(0, -1), JSON.stringify(tampered)].join('\n') + '\n');
    const bad = await h.call('verify');
    assert.equal(bad.isError, true); assert.match(text(bad), /Ledger verification failed/);
    assert.equal((bad.details as ops.VerifyResult).ok, false);
  } finally { await r.cleanup(); }
});

test('owed_abandon closes the slot as parent; owed_gc dry run reports, gc reclaims and records a note', async () => {
  const r = await fixture();
  try {
    const h = harness(r.cwd);
    const { worktree, branch } = (await h.call('dispatch', { node: 'a' })).details as { worktree: string; branch: string };
    const before = (await entries(r.cwd)).length;
    assert.equal((await h.call('abandon', { node: 'a', as: 'writer:a#1' })).isError, true, 'writers may not abandon');
    assert.equal((await h.call('gc', { as: 'reviewer:x' })).isError, true, 'reviewers may not run gc');
    assert.equal((await entries(r.cwd)).length, before);
    const abandoned = await h.call('abandon', { node: 'a', reason: 'Wrong approach' });
    assert.notEqual(abandoned.isError, true, text(abandoned));
    const entry = (await entries(r.cwd)).at(-1)!;
    assert.equal(entry.kind, 'abandon'); assert.equal(entry.by, 'parent:pi');
    assert.match(text(abandoned), /Recorded #\d+ parent:pi abandon/);
    assert.equal((await ops.status({ cwd: r.cwd })).nodes.a!.slot!.open, false);
    const dry = await h.call('gc', { dry_run: true });
    assert.notEqual(dry.isError, true, text(dry));
    assert.match(text(dry), /^Would remove\n {2}a#1: worktree .*, branch owed\/a\/1/);
    assert.ok((await stat(worktree)).isDirectory(), 'dry run keeps the worktree');
    assert.equal((await entries(r.cwd)).length, before + 1, 'dry run writes nothing');
    const done = await h.call('gc');
    assert.notEqual(done.isError, true, text(done));
    assert.match(text(done), /^Removed\n {2}a#1: worktree/);
    await assert.rejects(stat(worktree));
    assert.equal((await git(r.cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`], { allowFail: true })).code, 1);
    const note = (await entries(r.cwd)).at(-1)!;
    assert.equal(note.kind, 'note'); assert.equal(note.by, 'parent:pi');
    assert.equal(h.prompts.length, 0, 'parent actions need no owner confirmation');
  } finally { await r.cleanup(); }
});

test('owed_escape records a post-merge defect as parent; owner escapes need confirmation; bad merge seq is refused', async () => {
  const r = await fixture();
  try {
    const h = harness(r.cwd);
    const { worktree } = (await h.call('dispatch', { node: 'a' })).details as { worktree: string };
    await commitAt(worktree, { 'a.txt': 'done\n' });
    assert.notEqual((await h.call('submit', { node: 'a', cwd: worktree })).isError, true);
    await h.call('attest', { node: 'a' });
    assert.notEqual((await h.call('review', { node: 'a', as: 'reviewer:independent', verdict: 'ok', rank: 1, note: 'Looked at it' })).isError, true);
    const merged = await h.call('merge', { node: 'a' }); assert.notEqual(merged.isError, true, text(merged));
    const mergeSeq = (await entries(r.cwd)).findLast(e => e.kind === 'merge')!.seq;
    const args = { node: 'a', merge: mergeSeq, class: 'missing', note: 'No test covered the empty file case' };
    const before = (await entries(r.cwd)).length;
    const wrong = await h.call('escape', { ...args, merge: 0 });
    assert.equal(wrong.isError, true); assert.match(text(wrong), /is not a merge of node a/);
    assert.equal((await h.call('escape', { ...args, as: 'writer:a#1' })).isError, true);
    const denied = harness(r.cwd, false), refusal = await denied.call('escape', { ...args, as: 'owner:human' });
    assert.equal(refusal.isError, true); assert.match(denied.prompts[0]!, /Record escape for node a/);
    assert.equal((await entries(r.cwd)).length, before);
    const recorded = await h.call('escape', { ...args, evidence: 'issue 12' });
    assert.notEqual(recorded.isError, true, text(recorded));
    assert.match(text(recorded), /recorded escape a \(merge #\d+, missing/);
    const entry = (await entries(r.cwd)).at(-1)!;
    assert.equal(entry.kind, 'escape'); assert.equal(entry.by, 'parent:pi');
    assert.match(text(await h.call('report')), /Escapes \(all time\): 1/);
  } finally { await r.cleanup(); }
});

test('owed_decoy: digest writes nothing; commit and reveal are owner-only with pi-confirm and refused without UI', async () => {
  const r = await fixture();
  try {
    const payload = JSON.stringify({ nonce: 'a-sufficiently-long-nonce', decoys: [{ node: 'b', defect: 'off-by-one in b.txt' }] });
    await r.put('decoys.json', payload);
    const h = harness(r.cwd), before = (await entries(r.cwd)).length;
    const digest = await h.call('decoy', { action: 'digest', file: 'decoys.json' });
    assert.notEqual(digest.isError, true, text(digest));
    assert.equal(text(digest), ops.decoyDigest(payload).digest);
    assert.equal(h.prompts.length, 0); assert.equal((await entries(r.cwd)).length, before);
    assert.equal((await h.call('decoy', { action: 'commit' })).isError, true, 'commit requires a digest');
    const noUI = harness(r.cwd, null), refused = await noUI.call('decoy', { action: 'commit', digest: text(digest) });
    assert.equal(refused.isError, true); assert.match(text(refused), /UI/);
    assert.equal((await h.call('decoy', { action: 'commit', digest: text(digest), as: 'parent:pi' })).isError, true);
    const canceled = harness(r.cwd, false);
    assert.equal((await canceled.call('decoy', { action: 'commit', digest: text(digest) })).isError, true);
    assert.match(canceled.prompts[0]!, new RegExp(`Commit decoy digest ${text(digest)}`));
    assert.equal((await entries(r.cwd)).length, before);
    assert.notEqual((await h.call('decoy', { action: 'commit', digest: text(digest) })).isError, true);
    let entry = (await entries(r.cwd)).at(-1)!;
    assert.equal(entry.kind, 'decoy-commit'); assert.equal(entry.by, 'owner:human'); assert.equal(entry.channel, 'pi-confirm');
    const revealed = await h.call('decoy', { action: 'reveal', file: 'decoys.json' });
    assert.notEqual(revealed.isError, true, text(revealed));
    assert.match(h.prompts.at(-1)!, /Reveal decoys from decoys\.json: b/);
    entry = (await entries(r.cwd)).at(-1)!;
    assert.equal(entry.kind, 'decoy-reveal'); assert.equal(entry.channel, 'pi-confirm');
    assert.match(text(await h.call('report')), /Decoys: caught 0, escaped 0, pending 1/);
  } finally { await r.cleanup(); }
});
