import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';
import { main } from '../src/cli.ts';
import { Ledger } from '../src/ledger.ts';
import * as ops from '../src/ops.ts';
import { git, revParse } from '../src/git.ts';
import { parsePlan } from '../src/plan.ts';
import { reduce, validateDraft } from '../src/reducer.ts';
import type { Draft, Entry, Plan, State } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt, identity } from './helpers/surface.ts';
// D25.4: these tests exercise the owner confirmation (dialog or TTY prompt), now the opt-in gate OWED_CONFIRM=owner.
process.env.OWED_CONFIRM = 'owner';

type Repo = Awaited<ReturnType<typeof repo>>;
type Result = Awaited<ReturnType<ToolDefinition['execute']>> & { isError?: boolean };
const owner = { role: 'owner' as const, id: 'human' };
const parent = { role: 'parent' as const, id: 'main' };
const node = (id: string, writes: string[]) => ({ id, writes, checks: [], review: { count: 0, min_rank: 1 } });
// health: fails while broken.txt exists (its key also covers CHANGELOG.md, so a release commit changes it);
// clean: fails while dirty.txt exists (used as pre-existing trunk debt).
const invariants = [{ id: 'health', run: 'test ! -f broken.txt', reads: ['broken.txt', 'CHANGELOG.md'] }, { id: 'clean', run: 'test ! -f dirty.txt', reads: ['dirty.txt'] }];
const plan = { version: 1, trunk: 'main', closure: [], invariants, nodes: [node('a', ['a.txt']), node('b', ['b.txt'])] };

async function fixture(files: Record<string, string> = {}): Promise<Repo & { s0: string }> {
  const r = await repo();
  try {
    const s0 = await commitAt(r.cwd, { 'plan.json': JSON.stringify(plan), README: 'x\n', ...files });
    await ops.init({ cwd: r.cwd, plan: JSON.stringify(plan), as: owner, channel: 'flag' });
    return { ...r, s0 };
  } catch (e) { await r.cleanup(); throw e; }
}
async function entries(cwd: string): Promise<Entry[]> { return (await Ledger.open(cwd)).read(); }
async function state(cwd: string): Promise<State> {
  const ledger = await Ledger.open(cwd), all = await ledger.read(), plans = new Map<string, Plan>();
  for (const e of all) if (e.kind === 'genesis' || e.kind === 'plan') plans.set(e.plan, parsePlan((await ledger.getBlob(e.plan)).toString()));
  return reduce(all, sha => plans.get(sha)!);
}
async function call<T>(cwd: string, args: string[], code = 0): Promise<T> {
  const out = await cli(cwd, [...args, '--json']);
  assert.equal(out.code, code, `${args.join(' ')}\n${out.stderr}\n${out.stdout}`);
  return (code === 0 ? JSON.parse(out.stdout) : out) as T;
}
/** Dispatch, commit, submit and attest a node with no checks (only writes/rulings). */
async function accepted(cwd: string, id: string): Promise<void> {
  const d = await ops.dispatch({ cwd, node: id, as: parent });
  await commitAt(d.worktree, { [`${id}.txt`]: `${id}\n` });
  await ops.submit({ cwd: d.worktree, node: id, as: { role: 'writer', id: `${id}#1` } });
  assert.equal((await ops.attest({ cwd, node: id })).accepted, true);
}

test('adopt a release commit made outside owed, then dispatch and merge normally; status, merge CAS, report and brief', { timeout: 120_000 }, async () => {
  const r = await fixture();
  try {
    await accepted(r.cwd, 'a');
    // Release commits land on trunk directly.
    await commitAt(r.cwd, { 'CHANGELOG.md': '0.2.0\n' });
    const release = await commitAt(r.cwd, { VERSION: '0.2.0\n' });
    const status = await call<ops.StatusView>(r.cwd, ['status']);
    assert.deepEqual(status.drift && { relation: status.drift.relation, ahead: status.drift.ahead, commit: status.drift.commit }, { relation: 'ahead', ahead: 2, commit: release });
    const text = (await cli(r.cwd, ['status'])).stdout;
    assert.match(text, /trunk moved outside owed: refs\/heads\/main \([0-9a-f]{12}\) is ahead of the ledger trunk [0-9a-f]{12} by 2 commits; .*owed adopt/);
    // The merge CAS refusal names owed adopt and changes nothing.
    const before = await entries(r.cwd);
    { const out = await cli(r.cwd, ['merge', 'a']); assert.equal(out.code, 1); assert.match(out.stderr, /trunk changed \(CAS\): trunk moved outside owed: .*ahead .* by 2 commits.*owed adopt/); }
    assert.deepEqual(await entries(r.cwd), before);
    // Owner adopts what is on trunk.
    const adopted = await call<ops.AdoptResult>(r.cwd, ['adopt', '--note', 'release 0.2.0', '--i-am-owner']);
    assert.equal(adopted.entry.kind, 'adopt');
    const e = adopted.entry as Extract<Entry, { kind: 'adopt' }>;
    assert.deepEqual({ prior: e.prior, commit: e.commit, commits: e.commits, changed: e.changed, note: e.note, by: e.by, channel: e.channel, trunk: e.trunk }, { prior: r.s0, commit: release, commits: 2, changed: ['CHANGELOG.md', 'VERSION'], note: 'release 0.2.0', by: 'owner:human', channel: 'flag', trunk: 'main' });
    // health's key changed (CHANGELOG.md) and was measured; clean's key did not change.
    assert.deepEqual(adopted.observations.map(o => o.kind === 'obs' && `${o.obligation} ${o.verdict} ${o.commit === release}`), ['inv:health pass true']);
    const s = await state(r.cwd);
    assert.equal(s.trunk.commit, release); assert.equal(s.trunk.seq, e.seq);
    assert.deepEqual(s.adoptions.map(a => [a.seq, a.prior, a.commit, a.commits]), [[e.seq, r.s0, release, 2]]);
    assert.equal((await call<ops.StatusView>(r.cwd, ['status'])).drift, undefined, 'no drift after adoption');
    assert.doesNotMatch((await cli(r.cwd, ['status'])).stdout, /outside owed/);
    // A second adopt has nothing to do.
    { const out = await cli(r.cwd, ['adopt', '--note', 'again', '--i-am-owner']); assert.equal(out.code, 1); assert.match(out.stderr, /nothing to adopt/); }
    // The slot opened before the adoption is untouched and merges onto the adopted trunk; a new dispatch starts from it.
    const m = await call<ops.MergeResult>(r.cwd, ['merge', 'a']);
    assert.deepEqual((await git(r.cwd, ['rev-list', '--parents', '-n', '1', m.commit])).stdout.trim().split(' ').slice(1, 2), [release]);
    const b = await ops.dispatch({ cwd: r.cwd, node: 'b', as: parent });
    assert.equal((await state(r.cwd)).nodes.b!.slot!.base, m.commit);
    await commitAt(b.worktree, { 'b.txt': 'b\n' });
    await ops.submit({ cwd: b.worktree, node: 'b', as: { role: 'writer', id: 'b#1' } }); await ops.attest({ cwd: r.cwd, node: 'b' });
    await call(r.cwd, ['merge', 'b']);
    assert.equal((await state(r.cwd)).nodes.b!.phase, 'merged');
    // Report and brief list the adoption as an owner decision.
    const report = await cli(r.cwd, ['report']);
    assert.match(report.stdout, new RegExp(`Trunk adoptions \\(owner decisions: commits made outside owed\\)\\n  #${e.seq} owner:human \\(flag weak confirmation\\) adopted ${r.s0.slice(0, 12)}\\.\\.${release.slice(0, 12)} \\(2 commits made outside owed, not reviewed by owed\\); changed: CHANGELOG.md, VERSION; note: release 0.2.0`));
    assert.doesNotMatch(report.stdout, /adopted trunk main/, 'the adoption is not repeated under owner actions');
    assert.equal((await call<ops.Report>(r.cwd, ['report'])).adoptions.length, 1);
    assert.equal((await call<ops.Report>(r.cwd, ['report', '--since', String(e.seq)])).adoptions.length, 0, 'since filters adoptions');
    const brief = await cli(r.cwd, ['brief']);
    assert.match(brief.stdout, /Merged \(2\):[^]*Adopted outside owed \(owner decisions\) \(1\):\n  #\d+ owner:human .*adopted .*\(2 commits made outside owed, not reviewed by owed\); changed: CHANGELOG.md, VERSION; note: release 0.2.0\nRejected or blocked/);
    assert.equal((await call<ops.Brief>(r.cwd, ['brief', '--since', String(e.seq)])).adoptions.length, 0);
    assert.doesNotMatch((await cli(r.cwd, ['brief', '--since', String(e.seq)])).stdout, /Adopted outside owed/, 'the section is omitted when empty');
    assert.equal((await call<ops.VerifyResult>(r.cwd, ['verify'])).ok, true);
  } finally { await r.cleanup(); }
});

test('adopt refusals (nothing to adopt, non-owner, empty note, commit not the ref, rewritten trunk) leave the ledger unchanged', { timeout: 120_000 }, async () => {
  const r = await fixture();
  try {
    const ledger = await Ledger.open(r.cwd), before = await ledger.read();
    const unchanged = async (why: string) => assert.deepEqual(await ledger.read(), before, why);
    { const out = await cli(r.cwd, ['adopt', '--note', 'x', '--i-am-owner']); assert.equal(out.code, 1); assert.match(out.stderr, /nothing to adopt: refs\/heads\/main equals the ledger trunk/); }
    await unchanged('nothing to adopt');
    const first = await commitAt(r.cwd, { 'CHANGELOG.md': '1\n' });
    const head = await commitAt(r.cwd, { VERSION: '1\n' });
    { const out = await cli(r.cwd, ['adopt', '--note', 'x', '--as', 'parent:p']); assert.equal(out.code, 1); assert.match(out.stderr, /adopt requires owner/); }
    await assert.rejects(ops.adopt({ cwd: r.cwd, note: 'x', as: parent, channel: 'flag' }), /adopt requires owner/);
    await assert.rejects(ops.adopt({ cwd: r.cwd, note: 'x', as: owner } as Parameters<typeof ops.adopt>[0]), /confirmation channel/);
    await unchanged('non-owner');
    { const out = await cli(r.cwd, ['adopt', '--i-am-owner']); assert.equal(out.code, 2); assert.match(out.stderr, /Required: --note/); }
    { const out = await cli(r.cwd, ['adopt', '--note', '  ', '--i-am-owner']); assert.equal(out.code, 2); }
    await assert.rejects(ops.adopt({ cwd: r.cwd, note: ' \n', as: owner, channel: 'flag' }), /adopt requires a note/);
    await unchanged('empty note');
    { const out = await cli(r.cwd, ['adopt', '--commit', first, '--note', 'x', '--i-am-owner']); assert.equal(out.code, 1); assert.match(out.stderr, /adopt records only what is on trunk: .* is not refs\/heads\/main/); }
    { const out = await cli(r.cwd, ['adopt', '--commit', 'no-such-rev', '--note', 'x', '--i-am-owner']); assert.equal(out.code, 2); assert.match(out.stderr, /not a commit/); }
    await unchanged('commit not the ref');
    // The reducer refuses malformed adopt drafts on its own (replay safety).
    const s = await state(r.cwd), facts = { commit: head, tree: (await git(r.cwd, ['rev-parse', `${head}^{tree}`])).stdout.trim(), invKeys: s.trunk.invKeys };
    const draft = { kind: 'adopt', by: 'owner:human', channel: 'flag', trunk: 'main', prior: r.s0, commit: head, state: facts, changed: ['CHANGELOG.md', 'VERSION'], commits: 2, note: 'ok' } as Draft;
    assert.deepEqual(validateDraft(s, draft), []);
    assert.match(validateDraft(s, { ...draft, by: 'parent:p' } as Draft).join(), /adopt insufficient permissions; requires owner/);
    assert.match(validateDraft(s, { ...draft, prior: head } as Draft).join(), /prior must reference the current trunk/);
    assert.match(validateDraft(s, { ...draft, commit: r.s0, state: { ...facts, commit: r.s0 } } as Draft).join(), /nothing to adopt/);
    assert.match(validateDraft(s, { ...draft, commit: first } as Draft).join(), /commit does not match facts/);
    assert.match(validateDraft(s, { ...draft, note: ' ' } as Draft).join(), /requires a note/);
    assert.match(validateDraft(s, { ...draft, commits: 0 } as Draft).join(), /positive integer/);
    assert.match(validateDraft(s, { ...draft, trunk: 'dev' } as Draft).join(), /ledger trunk main/);
    assert.match(validateDraft(s, { ...draft, node: 'a' } as unknown as Draft).join(), /unknown fields: node/);
    // A rewritten trunk (the ledger trunk is no longer an ancestor) is refused with a clear message.
    const tree = (await git(r.cwd, ['rev-parse', 'HEAD^{tree}'])).stdout.trim();
    const orphan = (await git(r.cwd, ['commit-tree', tree, '-m', 'rewritten'], { env: identity })).stdout.trim();
    await git(r.cwd, ['update-ref', 'refs/heads/main', orphan]);
    { const out = await cli(r.cwd, ['adopt', '--note', 'x', '--i-am-owner']); assert.equal(out.code, 1); assert.match(out.stderr, /trunk was rewritten: the ledger trunk [0-9a-f]{12} is not an ancestor of refs\/heads\/main .*only fast-forwards/); }
    const status = await call<ops.StatusView>(r.cwd, ['status']);
    assert.equal(status.drift?.relation, 'diverged');
    assert.match((await cli(r.cwd, ['status'])).stdout, /trunk diverged from the ledger \(rewritten or reset outside owed\): refs\/heads\/main \([0-9a-f]{12}\) is not a fast-forward of the ledger trunk [0-9a-f]{12} \(1 ahead, 1 behind\)/);
    await unchanged('rewritten trunk');
    // Restored to the fast-forward, the adoption goes through; a later reset behind the ledger trunk is a rewrite too.
    await git(r.cwd, ['update-ref', 'refs/heads/main', head]);
    assert.equal((await ops.adopt({ cwd: r.cwd, note: 'restored', as: owner, channel: 'flag' })).commit, head);
    await git(r.cwd, ['update-ref', 'refs/heads/main', r.s0]);
    assert.match((await cli(r.cwd, ['status'])).stdout, /trunk diverged from the ledger .*\(0 ahead, 2 behind\)/);
    const adopted = await ledger.read();
    { const out = await cli(r.cwd, ['adopt', '--note', 'x', '--i-am-owner']); assert.equal(out.code, 1); assert.match(out.stderr, /trunk was rewritten/); }
    assert.deepEqual(await ledger.read(), adopted);
  } finally { await r.cleanup(); }
});

test('merge CAS refusal on a rewritten trunk says it is not a fast-forward', { timeout: 60_000 }, async () => {
  const r = await fixture();
  try {
    await accepted(r.cwd, 'a');
    const tree = (await git(r.cwd, ['rev-parse', 'HEAD^{tree}'])).stdout.trim();
    await git(r.cwd, ['update-ref', 'refs/heads/main', (await git(r.cwd, ['commit-tree', tree, '-m', 'rewritten'], { env: identity })).stdout.trim()]);
    const before = await entries(r.cwd);
    const out = await cli(r.cwd, ['merge', 'a']);
    assert.equal(out.code, 1); assert.match(out.stderr, /trunk changed \(CAS\): trunk diverged from the ledger .*not a fast-forward.*owed adopt accepts only fast-forwards/);
    assert.deepEqual(await entries(r.cwd), before);
  } finally { await r.cleanup(); }
});

test('a failing invariant on the external commit refuses the adoption and records the obs; pre-existing debt does not block', { timeout: 120_000 }, async () => {
  const r = await fixture({ 'dirty.txt': 'pre-existing debt\n' });
  try {
    let s = await state(r.cwd);
    assert.deepEqual(s.invariants.map(i => `${i.obligation} ${i.status}`), ['inv:health E', 'inv:clean D'], 'clean is debt on the genesis trunk');
    // The hotfix breaks health and touches the already failing clean invariant.
    const bad = await commitAt(r.cwd, { 'broken.txt': 'oops\n', 'dirty.txt': 'still dirty\n' });
    const before = await entries(r.cwd);
    const out = await cli(r.cwd, ['adopt', '--note', 'hotfix', '--i-am-owner']);
    assert.equal(out.code, 1);
    assert.match(out.stderr, /adoption refused: invariant health \(obs #\d+\) satisfied on the ledger trunk but not on [0-9a-f]{12}; fix trunk, then run owed adopt again/);
    assert.doesNotMatch(out.stderr, /invariant clean/, 'pre-existing debt does not block');
    assert.equal(out.stderr.match(/invariant health/g)?.length, 1, 'the failing invariant is named once');
    const after = await entries(r.cwd), added = after.slice(before.length);
    assert.deepEqual(added.map(e => e.kind === 'obs' && `${e.subject} ${e.obligation} ${e.verdict} ${e.commit === bad} ${e.merging ?? '-'}`), ['trunk inv:health fail true -', 'trunk inv:clean fail true -']);
    s = await state(r.cwd);
    assert.equal(s.trunk.commit, r.s0, 'trunk stays unadopted'); assert.equal(s.adoptions.length, 0);
    assert.equal((await ops.status({ cwd: r.cwd })).drift?.relation, 'ahead');
    // The owner fixes trunk and adopts again: health's key is back to the trunk key, clean stays debt.
    await git(r.cwd, ['rm', '-q', 'broken.txt']);
    const fixed = await commitAt(r.cwd, {});
    const r2 = await ops.adopt({ cwd: r.cwd, note: 'hotfix, broken.txt removed', as: owner, channel: 'flag' });
    assert.equal(r2.commit, fixed); assert.equal(r2.commits, 2); assert.deepEqual(r2.changed, ['dirty.txt']);
    assert.deepEqual(r2.observations, [], 'clean on this key was already measured; health is inherited');
    s = await state(r.cwd);
    assert.equal(s.trunk.commit, fixed);
    assert.deepEqual(s.invariants.map(i => `${i.obligation} ${i.status}`), ['inv:health E', 'inv:clean D']);
    assert.equal((await ops.verify({ cwd: r.cwd })).ok, true);
  } finally { await r.cleanup(); }
});

test('a trunk ref moved while adopt measures invariants leaves the ledger unchanged', { timeout: 60_000 }, async () => {
  const r = await repo();
  try {
    await commitAt(r.cwd, { flag: 'base' });
    const marker = join(r.root, 'started'), release = join(r.root, 'release');
    const p = JSON.stringify({ version: 1, trunk: 'main', nodes: [], invariants: [{ id: 'wait', reads: ['flag'], timeout_s: 10, run: `if grep -q changed flag; then touch '${marker}'; for n in $(seq 1 200); do test -e '${release}' && exit 0; sleep .02; done; exit 1; fi` }] });
    await ops.init({ cwd: r.cwd, plan: p, as: owner, channel: 'flag' });
    await commitAt(r.cwd, { flag: 'changed' });
    const ledger = await Ledger.open(r.cwd), before = await ledger.read();
    const outcome = ops.adopt({ cwd: r.cwd, note: 'x', as: owner, channel: 'flag' }).then(value => ({ value, error: undefined }), (error: unknown) => ({ value: undefined, error }));
    let started = false; for (let i = 0; i < 200; i++) { try { await access(marker); started = true; break; } catch { await new Promise(res => setTimeout(res, 20)); } }
    try { assert.equal(started, true); await commitAt(r.cwd, { other: 'moved' }); } finally { await writeFile(release, 'release'); }
    const result = await outcome;
    assert.match(String(result.error), /refs\/heads\/main moved during adopt .*nothing was recorded/);
    assert.deepEqual(await ledger.read(), before);
  } finally { await r.cleanup(); }
});

test('CLI adopt prints the full preview before confirming and pins the previewed commit', { timeout: 60_000 }, async () => {
  const r = await fixture();
  const home = process.cwd();
  try {
    const odd = 'odd\nname\u202e.txt';
    await commitAt(r.cwd, { 'CHANGELOG.md': '1\n' });
    const head = await commitAt(r.cwd, { [odd]: 'x\n', VERSION: '1\n' });
    const ledger = await Ledger.open(r.cwd), before = await ledger.read();
    // In-process run with an injected terminal answer: the ref moves after the preview, before "yes".
    process.chdir(r.cwd);
    const run = async (args: string[], answer: () => Promise<string>) => {
      const out: string[] = [], err: string[] = [];
      const code = await main(args, { ask: answer, log: t => { out.push(t); }, error: t => { err.push(t); } });
      return { code, out: out.join('\n'), err: err.join('\n') };
    };
    const declined = await run(['adopt', '--note', 'release 1\nIdentity: owner:fake'], async () => 'no');
    assert.equal(declined.code, 1); assert.match(declined.err, /owner did not confirm/);
    assert.deepEqual(declined.err.split('\n').slice(0, 7), [`Adopt trunk main: ledger trunk ${r.s0}..${head}`, `2 commits made outside owed, not reviewed by owed; adopting makes ${head} the ledger trunk.`, 'Changed paths (3):', '  CHANGELOG.md', '  VERSION', '  odd\\nname\\u202e.txt', 'Note: release 1\\nIdentity: owner:fake']);
    const moved = await run(['adopt', '--note', 'release 1'], async () => { await commitAt(r.cwd, { late: 'moved after the preview\n' }); return 'yes'; });
    assert.equal(moved.code, 1, moved.err);
    assert.match(moved.err, new RegExp(`Refused: adopt records only what is on trunk: ${head} \\(${head.slice(0, 12)}\\) is not refs/heads/main`));
    assert.deepEqual(await ledger.read(), before, 'a ref moved after the confirmation records nothing');
    const now = await revParse(r.cwd, 'refs/heads/main');
    const ok = await run(['adopt', '--note', 'release 1', '--json'], async () => 'yes');
    assert.equal(ok.code, 0, ok.err);
    assert.match(ok.err, new RegExp(`^Adopt trunk main: ledger trunk ${r.s0}\\.\\.${now}\\n3 commits`));
    const e = JSON.parse(ok.out).entry as Entry;
    assert.ok(e.kind === 'adopt' && e.commit === now && e.channel === 'tty');
    // --i-am-owner prints the same preview (subprocess; stdout stays pure JSON).
    await commitAt(r.cwd, { 'CHANGELOG.md': '2\n' });
    const flag = await cli(r.cwd, ['adopt', '--note', 'second', '--i-am-owner', '--json']);
    assert.equal(flag.code, 0, flag.stderr);
    assert.match(flag.stderr, new RegExp(`^Adopt trunk main: ledger trunk ${now}\\.\\.[0-9a-f]{40}\\n1 commit made outside owed[^]*Changed paths \\(1\\):\\n  CHANGELOG.md\\nNote: second`));
    assert.equal((JSON.parse(flag.stdout).entry as Entry).channel, 'flag');
  } finally { process.chdir(home); await r.cleanup(); }
});

test('a ledger trunk commit missing from the repository is reported as such by status and adopt', { timeout: 60_000 }, async () => {
  const r = await fixture();
  try {
    const tree = (await git(r.cwd, ['rev-parse', 'HEAD^{tree}'])).stdout.trim();
    await git(r.cwd, ['update-ref', 'refs/heads/main', (await git(r.cwd, ['commit-tree', tree, '-m', 'rewritten'], { env: identity })).stdout.trim()]);
    await git(r.cwd, ['reflog', 'expire', '--expire=now', '--all']);
    await git(r.cwd, ['gc', '-q', '--prune=now']);
    assert.notEqual((await git(r.cwd, ['cat-file', '-e', `${r.s0}^{commit}`], { allowFail: true })).code, 0, 'fixture: s0 was pruned');
    const before = await entries(r.cwd);
    assert.equal((await ops.status({ cwd: r.cwd })).drift?.relation, 'ledger-missing');
    assert.match((await cli(r.cwd, ['status'])).stdout, new RegExp(`ledger trunk ${r.s0} is missing from the repository`));
    { const out = await cli(r.cwd, ['adopt', '--note', 'x', '--i-am-owner']); assert.equal(out.code, 1); assert.match(out.stderr, new RegExp(`ledger trunk ${r.s0} is missing from the repository`)); }
    assert.deepEqual(await entries(r.cwd), before);
  } finally { await r.cleanup(); }
});

/** confirm: the owner's answer to ui.confirm; null means the session has no UI. */
function harness(cwd: string, confirm: boolean | null = true) {
  const tools = new Map<string, ToolDefinition>(), prompts: string[] = [];
  owed({ registerTool(t: ToolDefinition) { tools.set(t.name, t); }, registerCommand() {} } as unknown as ExtensionAPI);
  const ctx = { cwd, hasUI: confirm !== null, ui: { async confirm(title: string, message: string) { prompts.push(`${title}\n${message}`); return confirm; }, notify() {} } } as unknown as ExtensionContext;
  return { tools, prompts, async call(args: Record<string, unknown>): Promise<Result> {
    return tools.get('owed_adopt')!.execute('test', args, undefined, undefined, ctx as Parameters<ToolDefinition['execute']>[4]) as Promise<Result>;
  } };
}
const text = (r: Result): string => r.content.map(c => c.type === 'text' ? c.text : '').join('\n');

test('owed_adopt asks for owner confirmation (escaped free text) and records pi-confirm', { timeout: 60_000 }, async () => {
  const r = await fixture();
  try {
    const head = await commitAt(r.cwd, { 'CHANGELOG.md': '0.2.0\n' });
    const before = await entries(r.cwd), note = 'release 0.2.0\nIdentity: owner:fake';
    { const out = await harness(r.cwd).call({ note, as: 'parent:pi' }); assert.equal(out.isError, true); assert.match(text(out), /Only owner may adopt/); }
    { const out = await harness(r.cwd, null).call({ note }); assert.equal(out.isError, true); assert.match(text(out), /require UI confirmation/); }
    const declined = harness(r.cwd, false);
    { const out = await declined.call({ note }); assert.equal(out.isError, true); assert.match(text(out), /did not confirm/); }
    assert.equal(declined.prompts.length, 1);
    const lines = declined.prompts[0]!.split('\n');
    assert.deepEqual(lines, ['owed: confirm owner decision', `Adopt trunk main ${r.s0.slice(0, 12)}..${head.slice(0, 12)}: 1 commit made outside owed`, `These changes were not reviewed through owed; adopting them makes ${head.slice(0, 12)} the ledger trunk.`, `Repository: ${r.cwd}`, 'Identity: owner:human', 'Changed paths (1):', '  CHANGELOG.md', 'Note: release 0.2.0\\nIdentity: owner:fake', 'Confirmation will be recorded as pi-confirm.']);
    assert.deepEqual(await entries(r.cwd), before, 'refusals and a declined dialog record nothing');
    const ok = harness(r.cwd, true), out = await ok.call({ note, cwd: r.cwd });
    assert.notEqual(out.isError, true, text(out));
    assert.match(text(out), /adopted trunk main/);
    const last = (await entries(r.cwd)).at(-1)!;
    assert.ok(last.kind === 'adopt' && last.channel === 'pi-confirm' && last.by === 'owner:human' && last.note === note && last.commit === head);
    { const again = await harness(r.cwd).call({ note: 'x' }); assert.equal(again.isError, true); assert.match(text(again), /nothing to adopt/); }
    assert.equal(await revParse(r.cwd, 'refs/heads/main'), head, 'adopt never moves the ref');
  } finally { await r.cleanup(); }
});
