import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';
import { Ledger } from '../src/ledger.ts';
import * as ops from '../src/ops.ts';
import type { Entry } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

type Repo = Awaited<ReturnType<typeof repo>>;
type Result = Awaited<ReturnType<ToolDefinition['execute']>> & { isError?: boolean };
const owner = { role: 'owner' as const, id: 'human' };
const parent = { role: 'parent' as const, id: 'main' };
// h1 fails while broken1.txt exists, h2 while broken2.txt exists; a needs one review (waived below).
const invariants = [{ id: 'h1', run: 'test ! -f broken1.txt', reads: ['broken1.txt'] }, { id: 'h2', run: 'test ! -f broken2.txt', reads: ['broken2.txt'] }];
const plan = { version: 1, trunk: 'main', closure: [], invariants, nodes: [{ id: 'a', writes: ['a.txt'], checks: [], review: { count: 1, min_rank: 1 } }] };

async function fixture(): Promise<Repo & { s0: string }> {
  const r = await repo();
  try {
    const s0 = await commitAt(r.cwd, { 'plan.json': JSON.stringify(plan), README: 'x\n' });
    await ops.init({ cwd: r.cwd, plan: JSON.stringify(plan), as: owner, channel: 'flag' });
    return { ...r, s0 };
  } catch (e) { await r.cleanup(); throw e; }
}
async function entries(cwd: string): Promise<Entry[]> { return (await Ledger.open(cwd)).read(); }
/** The owed_adopt confirmation dialog for the current trunk, declined (records nothing). */
async function dialog(cwd: string): Promise<string[]> {
  const tools = new Map<string, ToolDefinition>(), prompts: string[] = [];
  owed({ registerTool(t: ToolDefinition) { tools.set(t.name, t); }, registerCommand() {} } as unknown as ExtensionAPI);
  const ctx = { cwd, hasUI: true, ui: { async confirm(title: string, message: string) { prompts.push(`${title}\n${message}`); return false; }, notify() {} } } as unknown as ExtensionContext;
  const out = await tools.get('owed_adopt')!.execute('test', { note: 'release' }, undefined, undefined, ctx as Parameters<ToolDefinition['execute']>[4]) as Result;
  assert.equal(out.isError, true); assert.match(out.content.map(c => c.type === 'text' ? c.text : '').join('\n'), /did not confirm/);
  assert.equal(prompts.length, 1);
  return prompts[0]!.split('\n');
}
const paths = (n: number) => Array.from({ length: n }, (_, i) => `p/f${String(i + 1).padStart(2, '0')}.txt`);
const files = (list: string[]) => Object.fromEntries(list.map(p => [p, `${p}\n`]));

test('owed_adopt dialog lists every changed path, one per line, when there are at most 50', { timeout: 60_000 }, async () => {
  const r = await fixture();
  try {
    const head = await commitAt(r.cwd, files(['CHANGELOG.md', 'VERSION', 'odd\nname.txt']));
    const before = await entries(r.cwd), lines = await dialog(r.cwd);
    assert.deepEqual(lines, ['owed: confirm owner decision', `Adopt trunk main ${r.s0.slice(0, 12)}..${head.slice(0, 12)}: 1 commit made outside owed`, `These changes were not reviewed through owed; adopting them makes ${head.slice(0, 12)} the ledger trunk.`, `Repository: ${r.cwd}`, 'Identity: owner:human', 'Changed paths (3):', '  CHANGELOG.md', '  VERSION', '  odd\\nname.txt', 'Note: release', 'Confirmation will be recorded as pi-confirm.']);
    assert.deepEqual(await entries(r.cwd), before);
  } finally { await r.cleanup(); }
});

test('owed_adopt dialog with 60 changed paths lists 50 and the exact git diff command for the rest', { timeout: 60_000 }, async () => {
  const r = await fixture();
  try {
    const all = paths(60), head = await commitAt(r.cwd, files(all));
    const lines = await dialog(r.cwd), at = lines.indexOf('Changed paths (60):');
    assert.ok(at > lines.indexOf('Identity: owner:human'), lines.join('\n'));
    assert.deepEqual(lines.slice(at + 1, at + 51), all.slice(0, 50).map(p => `  ${p}`));
    assert.equal(lines[at + 51], `… +10 more paths; full list: git diff --name-only ${r.s0.slice(0, 12)}..${head.slice(0, 12)}`);
    assert.deepEqual(lines.slice(at + 52), ['Note: release', 'Confirmation will be recorded as pi-confirm.']);
    for (const p of all.slice(50)) assert.ok(!lines.some(l => l.includes(p)), `${p} is behind the git diff line`);
  } finally { await r.cleanup(); }
});

test('report lists an adoption once (under trunk adoptions) and other owner actions under Owner actions; brief lists it once', { timeout: 120_000 }, async () => {
  const r = await fixture();
  try {
    const d = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
    await commitAt(d.worktree, { 'a.txt': 'a\n' });
    await ops.submit({ cwd: d.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
    await ops.attest({ cwd: r.cwd, node: 'a' });
    const w = await ops.waive({ cwd: r.cwd, node: 'a', obligation: 'review', reason: 'trivial change', as: owner, channel: 'flag' });
    const release = await commitAt(r.cwd, { VERSION: '0.2.0\n' });
    const adopted = await ops.adopt({ cwd: r.cwd, note: 'release 0.2.0', as: owner, channel: 'flag' }), seq = adopted.entry.seq;
    // Since the waive: the genesis entry (also an owner action) is not in the window.
    const report = (await cli(r.cwd, ['report', '--since', String(w.seq - 1)])).stdout;
    assert.equal(report.split('\n').filter(l => l.includes(`#${seq} `)).length, 1, report);
    assert.match(report, new RegExp(`Trunk adoptions \\(owner decisions: commits made outside owed\\)\\n  #${seq} owner:human \\(flag weak confirmation\\) adopted ${r.s0.slice(0, 12)}\\.\\.${release.slice(0, 12)} `));
    assert.match(report, new RegExp(`\\nOwner actions\\n  #${w.seq} owner:human \\(flag weak confirmation\\) waived a/review: trivial change\\n(?!  )`), report);
    const json = await ops.report({ cwd: r.cwd, since: w.seq - 1 });
    assert.deepEqual(json.ownerActions.map(e => [e.seq, e.kind]), [[w.seq, 'waive']]);
    assert.deepEqual(json.adoptions.map(a => a.seq), [seq]);
    const brief = (await cli(r.cwd, ['brief'])).stdout;
    assert.equal(brief.split('\n').filter(l => l.includes(`#${seq} `)).length, 1, brief);
  } finally { await r.cleanup(); }
});

test('a repeated adopt of the same failing commit names the existing observations and leaves the ledger unchanged', { timeout: 120_000 }, async () => {
  const r = await fixture();
  try {
    const bad = await commitAt(r.cwd, { 'broken1.txt': 'x\n', 'broken2.txt': 'y\n' });
    const first = await cli(r.cwd, ['adopt', '--note', 'hotfix', '--i-am-owner']);
    assert.equal(first.code, 1);
    const obs = (await entries(r.cwd)).filter(e => e.kind === 'obs' && e.commit === bad && e.verdict === 'fail');
    const seq = (id: string) => obs.find(e => e.kind === 'obs' && e.obligation === `inv:${id}`)!.seq;
    const named = `adoption refused: invariants h1 (obs #${seq('h1')}), h2 (obs #${seq('h2')}) satisfied on the ledger trunk but not on ${bad.slice(0, 12)}; fix trunk, then run owed adopt again`;
    assert.equal(first.stderr.includes(named), true, first.stderr);
    const before = await entries(r.cwd);
    const again = await cli(r.cwd, ['adopt', '--note', 'hotfix', '--i-am-owner']);
    assert.equal(again.code, 1);
    assert.equal(again.stderr.includes(named), true, again.stderr);
    assert.deepEqual(await entries(r.cwd), before, 'the repeated adopt measures and records nothing');
  } finally { await r.cleanup(); }
});
