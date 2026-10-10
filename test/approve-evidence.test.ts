// D23: owner approval and manual evidence obligations, receipts on merged nodes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';
import { main } from '../src/cli.ts';
import { H, canonical, sha256 } from '../src/canon.ts';
import { Ledger } from '../src/ledger.ts';
import * as ops from '../src/ops.ts';
import { parsePlan, planDowngrades } from '../src/plan.ts';
import { reduce, validateDraft, manualKeys, runId } from '../src/reducer.ts';
import { decide, manualHalt, writerLaunch, type DriveOpts } from '../src/drive.ts';
import { renderReceipt, renderReport, renderBrief } from '../src/views.ts';
import type { CandidateFacts, Draft, Entry, NodeSpec, Plan, RunView, State } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';
// D25.4: these tests exercise the owner confirmation (dialog or TTY prompt), now the opt-in gate OWED_CONFIRM=owner.
process.env.OWED_CONFIRM = 'owner';

type Repo = Awaited<ReturnType<typeof repo>>;
type Result = Awaited<ReturnType<ToolDefinition['execute']>> & { isError?: boolean };
const owner = { role: 'owner' as const, id: 'human' };
const parent = { role: 'parent' as const, id: 'p' };
const reviewer = { role: 'reviewer' as const, id: 'r1' };
const pubNode = { id: 'pub', writes: ['pub.txt'], checks: [], review: { count: 0, min_rank: 1 }, approve: 'owner', evidence: [{ id: 'ui', what: 'looked at the real page' }, { id: 'tarball', what: 'npm pack tarball', by: 'parent' }] };
const plan = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: [pubNode, { id: 'plain', writes: ['plain.txt'], checks: [], review: { count: 0, min_rank: 1 } }] };

async function fixture(p: object = plan): Promise<Repo> {
  const r = await repo();
  try {
    await commitAt(r.cwd, { README: 'x\n' });
    await ops.init({ cwd: r.cwd, plan: JSON.stringify(p), as: owner, channel: 'flag' });
    return r;
  } catch (e) { await r.cleanup(); throw e; }
}
async function entries(cwd: string): Promise<Entry[]> { return (await Ledger.open(cwd)).read(); }
async function state(cwd: string): Promise<State> {
  const ledger = await Ledger.open(cwd), all = await ledger.read(), plans = new Map<string, Plan>();
  for (const e of all) if (e.kind === 'genesis' || e.kind === 'plan') plans.set(e.plan, parsePlan((await ledger.getBlob(e.plan)).toString()));
  return reduce(all, sha => plans.get(sha)!);
}
/** Dispatch, commit, submit and attest `id` (no checks: only writes is measured). */
async function candidate(r: Repo, id = 'pub'): Promise<string> {
  const d = await ops.dispatch({ cwd: r.cwd, node: id, as: parent });
  await commitAt(d.worktree, { [`${id}.txt`]: `${id}\n` });
  await ops.submit({ cwd: d.worktree, node: id, as: { role: 'writer', id: `${id}#1` } });
  await ops.attest({ cwd: r.cwd, node: id });
  return d.worktree;
}
const item = (s: State, o: string, node = 'pub') => s.nodes[node]!.items.find(i => i.obligation === o)!;
async function refused(p: Promise<unknown>, re: RegExp): Promise<void> { await assert.rejects(p, (e: Error) => { assert.match(e.message, re); return true; }); }

test('plan: approve and evidence parse with defaults, are validated, absent keys stay absent, removals are downgrades', () => {
  const p = parsePlan(JSON.stringify(plan));
  assert.deepEqual({ approve: p.nodes[0]!.approve, evidence: p.nodes[0]!.evidence }, { approve: 'owner', evidence: [{ id: 'ui', what: 'looked at the real page', by: 'reviewer' }, { id: 'tarball', what: 'npm pack tarball', by: 'parent' }] });
  // A node without the new keys gets none: its canonical form (and so a 0.4 plan's sha) is unchanged.
  assert.equal(canonical(p.nodes[1]), canonical({ id: 'plain', deps: [], writes: ['plain.txt'], checks: [], review: { count: 0, min_rank: 1 } }));
  const bad = (n: object, re: RegExp) => assert.throws(() => parsePlan(JSON.stringify({ ...plan, nodes: [{ id: 'x', ...n }] })), re);
  bad({ approve: 'parent' }, /nodes\[0\]\.approve: expected "owner"/);
  bad({ evidence: {} }, /nodes\[0\]\.evidence: expected array/);
  bad({ evidence: [{ id: '-x', what: 'w' }] }, /evidence\[0\]\.id: expected/);
  bad({ evidence: [{ id: 'a b', what: 'w' }] }, /evidence\[0\]\.id: expected/);
  bad({ evidence: [{ id: 'x', what: ' ' }] }, /evidence\[0\]\.what: expected non-empty string/);
  bad({ evidence: [{ id: 'x', what: 'w', by: 'writer' }] }, /evidence\[0\]\.by: expected reviewer, parent or owner/);
  bad({ evidence: [{ id: 'x', what: 'w', how: 1 }] }, /evidence\[0\]\.how: unknown key/);
  bad({ evidence: [{ id: 'x', what: 'w' }, { id: 'x', what: 'v' }] }, /duplicate evidence id x/);
  const with_ = (n: Partial<NodeSpec>) => parsePlan(JSON.stringify({ ...plan, nodes: [{ ...pubNode, ...n }] }));
  const base = with_({ evidence: [{ id: 'ui', what: 'w', by: 'owner' }, { id: 'tar', what: 't', by: 'reviewer' }] });
  assert.deepEqual(planDowngrades(base, with_({ approve: undefined, evidence: [{ id: 'ui', what: 'w', by: 'reviewer' }] })).map(d => `${d.node}: ${d.what}`), ['pub: approve removed', 'pub: evidence ui weakened', 'pub: evidence tar removed']);
  // Strengthening is no downgrade: by moved to owner, a new evidence item, a changed `what` (a new key).
  assert.deepEqual(planDowngrades(base, with_({ evidence: [{ id: 'ui', what: 'w2', by: 'owner' }, { id: 'tar', what: 't', by: 'owner' }, { id: 'new', what: 'n', by: 'reviewer' }] })), []);
});

test('approve and evidence: keys, who may discharge, owner block, merge guard, manual views, brief, receipts', { timeout: 120_000 }, async () => {
  const r = await fixture();
  try {
    await candidate(r);
    let s = await state(r.cwd);
    const c = s.nodes.pub!.candidate!;
    assert.equal(c.keys.approve, H({ o: 'approve', patch: c.patch }));
    assert.equal(c.keys['evidence:ui'], H({ o: 'evidence', id: 'ui', what: 'looked at the real page', patch: c.patch }));
    assert.equal(c.keys['evidence:tarball'], H({ o: 'evidence', id: 'tarball', what: 'npm pack tarball', patch: c.patch }));
    assert.deepEqual(s.nodes.pub!.items.map(i => `${i.obligation} ${i.status} ${i.discharger ?? '-'}`), ['writes E -', 'approve D owner', 'evidence:ui D reviewer', 'evidence:tarball D parent', 'rulings E -']);
    assert.equal(s.nodes.pub!.accepted, false);
    // A submit whose manual keys are not derived from its patch is refused by the ledger.
    const forged = { kind: 'submit', by: 'writer:pub#1', node: 'pub', attempt: 1, facts: { ...c, keys: { ...c.keys, approve: 'f'.repeat(64) } } } as Draft;
    assert.match(validateDraft(s, forged).join('; '), /approve\/evidence keys must be derived/);
    await refused(ops.merge({ cwd: r.cwd, node: 'pub', as: parent }), /not yet accepted:approve, evidence:ui, evidence:tarball/);
    // Approve: owner only, with a confirmation channel; reviews of approve by others are refused.
    await refused(ops.approve({ cwd: r.cwd, node: 'pub', as: parent }), /approve requires owner/);
    await refused(ops.approve({ cwd: r.cwd, node: 'pub', as: owner }), /owner actions require a confirmation channel/);
    await refused(ops.approve({ cwd: r.cwd, node: 'plain', as: owner, channel: 'flag' }), /no open candidate/);
    await refused(ops.review({ cwd: r.cwd, node: 'pub', as: reviewer, verdict: 'ok', rank: 2, note: '', obligation: 'approve' as 'review' }), /approve can only be recorded by the owner/);
    // Evidence: declared id, required role (or owner), never a writer, at least one file, a note.
    await mkdir(join(r.cwd, 'evidence'), { recursive: true }); await writeFile(join(r.cwd, 'evidence', 'shot.txt'), 'screenshot bytes');
    await writeFile(join(r.root, 'app.tgz'), 'tarball bytes');
    const shot = { path: 'evidence/shot.txt', sha256: sha256('screenshot bytes'), bytes: 16 };
    await refused(ops.evidence({ cwd: r.cwd, node: 'pub', id: 'ui', files: ['evidence/shot.txt'], note: 'n', as: { role: 'writer', id: 'pub#1' } }), /insufficient permissions/);
    await refused(ops.evidence({ cwd: r.cwd, node: 'pub', id: 'ui', files: ['evidence/shot.txt'], note: 'n', as: { role: 'reviewer', id: 'pub#1' } }), /must not be recorded by a writer/);
    await refused(ops.evidence({ cwd: r.cwd, node: 'pub', id: 'ui', files: ['evidence/shot.txt'], note: 'n', as: parent }), /evidence:ui requires reviewer \(or owner\)/);
    await refused(ops.evidence({ cwd: r.cwd, node: 'pub', id: 'ui', files: [], note: 'n', as: reviewer }), /requires at least one file/);
    await refused(ops.evidence({ cwd: r.cwd, node: 'pub', id: 'ui', files: ['missing.png'], note: 'n', as: reviewer }), /cannot read missing.png: ENOENT/);
    await refused(ops.evidence({ cwd: r.cwd, node: 'pub', id: 'ui', files: ['evidence/shot.txt'], note: ' ', as: reviewer }), /requires a note/);
    await refused(ops.evidence({ cwd: r.cwd, node: 'pub', id: 'nope', files: ['evidence/shot.txt'], note: 'n', as: reviewer }), /no evidence obligation nope/);
    await refused(ops.evidence({ cwd: r.cwd, node: 'plain', id: 'ui', files: ['evidence/shot.txt'], note: 'n', as: reviewer }), /Node plain has no open candidate/);
    const before = (await entries(r.cwd)).length;
    const ui = await ops.evidence({ cwd: r.cwd, node: 'pub', id: 'ui', files: ['evidence/shot.txt'], note: 'looked at it', as: reviewer });
    assert.equal((await entries(r.cwd)).length, before + 1);
    assert.deepEqual({ attempt: ui.attempt, key: ui.key, merge: ui.merge, files: ui.files, by: ui.by }, { attempt: 1, key: c.keys['evidence:ui'], merge: undefined, files: [shot], by: 'reviewer:r1' });
    // A file outside the repository is stored with its absolute path.
    const tar = await ops.evidence({ cwd: r.cwd, node: 'pub', id: 'tarball', files: ['../app.tgz'], note: 'packed', as: parent });
    assert.match(tar.files[0]!.path, /^\/.*\/app\.tgz$/);
    assert.equal(tar.files[0]!.sha256, sha256('tarball bytes'));
    s = await state(r.cwd);
    assert.deepEqual([item(s, 'evidence:ui').status, item(s, 'evidence:tarball').status, item(s, 'approve').status], ['E', 'E', 'D']);
    // Owner block on approve: a judgment block for the owner, cleared by a later owner ok on the current key.
    const block = await ops.approve({ cwd: r.cwd, node: 'pub', as: owner, channel: 'flag', block: true, note: 'not yet' });
    s = await state(r.cwd);
    assert.deepEqual({ mark: item(s, 'approve').mark, discharger: item(s, 'approve').discharger, kind: s.nodes.pub!.blocks[0]?.kind }, { mark: '⛔', discharger: 'owner', kind: 'judgment' });
    assert.match(renderReceipt(await ops.why({ cwd: r.cwd, node: 'pub' })), new RegExp(`blocked #${block.seq} approve: a later owner approval of the current candidate clears it: owed approve pub`));
    const ok = await ops.approve({ cwd: r.cwd, node: 'pub', as: { role: 'owner', id: 'other' }, channel: 'tty', note: 'ship it' });
    s = await state(r.cwd);
    assert.deepEqual({ block: s.nodes.pub!.blocks[0]!.state, clearedBy: s.nodes.pub!.blocks[0]!.clearedBy, approve: item(s, 'approve').status, accepted: s.nodes.pub!.accepted }, { block: 'cleared', clearedBy: ok.seq, approve: 'E', accepted: true });
    // Views: approved by owner with channel; evidence always manual, with files path sha12 and the note; never "measured".
    const why = renderReceipt(await ops.why({ cwd: r.cwd, node: 'pub' }));
    assert.match(why, /✔ approved \(owner:other, tty\) pub\/approve/);
    assert.match(why, new RegExp(`✔ evidenced \\(manual\\) by reviewer:r1 pub/evidence:ui — evidence:ui satisfied \\(manual\\) \\[#${ui.seq} reviewer:r1: files evidence/shot.txt ${shot.sha256.slice(0, 12)}; note: looked at it\\]`));
    assert.match(why, /✔ evidenced \(manual\) by parent:p pub\/evidence:tarball/);
    assert.doesNotMatch(why, /measured pub\/(approve|evidence)/);
    const merged = await ops.merge({ cwd: r.cwd, node: 'pub', as: parent });
    const brief = await ops.brief({ cwd: r.cwd });
    assert.deepEqual({ measured: brief.merged[0]!.measuredItems, manual: brief.merged[0]!.manualItems }, { measured: ['writes'], manual: ['approve', 'evidence:ui', 'evidence:tarball'] });
    assert.match(renderBrief(brief), /pub #\d+ → [0-9a-f]{12}: 1 measured, 0 waived, 0 reviewed, 3 manual \(approve, evidence:ui, evidence:tarball\)/);
    // Receipt on the merged node: cites its merge, files optional, note required; listed by why and report.
    await refused(ops.evidence({ cwd: r.cwd, node: 'pub', id: 'release', files: [], note: '', as: parent }), /requires a note/);
    const receipt = await ops.evidence({ cwd: r.cwd, node: 'pub', id: 'release', files: ['../app.tgz'], note: '0.5.0 latest', as: parent });
    assert.deepEqual({ merge: receipt.merge, attempt: receipt.attempt, key: receipt.key }, { merge: merged.entry.seq, attempt: undefined, key: undefined });
    const bare = await ops.evidence({ cwd: r.cwd, node: 'pub', id: 'dist-tag', files: [], note: 'latest -> 0.5.0', as: parent });
    const card = await ops.why({ cwd: r.cwd, node: 'pub' });
    assert.deepEqual(card.receipts?.map(e => e.seq), [receipt.seq, bare.seq]);
    assert.match(renderReceipt(card), new RegExp(`Receipt #${receipt.seq} pub/release by parent:p \\(merge #${merged.entry.seq}\\): files /.*app\\.tgz ${sha256('tarball bytes').slice(0, 12)}; note: 0\\.5\\.0 latest`));
    assert.match(renderReceipt(card), new RegExp(`Receipt #${bare.seq} pub/dist-tag by parent:p \\(merge #${merged.entry.seq}\\): files none; note: latest -> 0\\.5\\.0`));
    const report = await ops.report({ cwd: r.cwd, since: merged.entry.seq });
    assert.deepEqual(report.receipts?.map(e => e.seq), [receipt.seq, bare.seq]);
    assert.match(renderReport(report), /Receipts \(manual, informational\)\n  Receipt #\d+ pub\/release/);
    assert.equal((await ops.report({ cwd: r.cwd, since: bare.seq })).receipts, undefined, 'no receipts key without receipts');
    // Ledger rules for receipts: latest merge seq, no attempt/key, strict fields, roles.
    s = await state(r.cwd);
    const rec = { kind: 'evidence', by: 'parent:p', node: 'pub', merge: merged.entry.seq, id: 'x', files: [], note: 'n' };
    assert.deepEqual(validateDraft(s, rec as Draft), []);
    assert.match(validateDraft(s, { ...rec, merge: merged.entry.seq - 1 } as Draft).join('; '), /merge must be #\d+, the latest merge of pub/);
    assert.match(validateDraft(s, { ...rec, attempt: 1 } as Draft).join('; '), /carries merge only/);
    assert.match(validateDraft(s, { ...rec, extra: 1 } as Draft).join('; '), /evidence has unknown fields: extra/);
    assert.match(validateDraft(s, { ...rec, by: 'writer:pub#1' } as Draft).join('; '), /insufficient permissions/);
    assert.match(validateDraft(s, { ...rec, files: [{ path: 'a', sha256: 'x', bytes: 1 }] } as Draft).join('; '), /evidence files must be a list/);
    assert.match(validateDraft(s, { ...rec, merge: undefined, attempt: 1, key: 'k' } as Draft).join('; '), /node pub is merged: record a receipt/);
    assert.match(validateDraft(s, { ...rec, node: 'plain' } as Draft).join('; '), /requires a merged node; plain is not merged/);
  } finally { await r.cleanup(); }
});

test('plan updates: removing approve or evidence is an owner-only downgrade; adding them invalidates the candidate', { timeout: 60_000 }, async () => {
  const r = await fixture();
  try {
    await candidate(r, 'plain');
    // Adding obligations is no downgrade (a parent may), and the node spec changed, so the writer must submit again.
    const stronger = structuredClone(plan); Object.assign(stronger.nodes[1]!, { approve: 'owner', evidence: [{ id: 'ui', what: 'w' }] });
    await ops.planSet({ cwd: r.cwd, plan: JSON.stringify(stronger), as: parent });
    assert.equal((await state(r.cwd)).nodes.plain!.candidate, undefined);
    const weaker = structuredClone(stronger); delete (weaker.nodes[1] as { approve?: string }).approve; (weaker.nodes[1] as { evidence?: unknown[] }).evidence = [];
    await refused(ops.planSet({ cwd: r.cwd, plan: JSON.stringify(weaker), as: parent }), /Only owner may approve a plan that reduces obligations/);
    const e = await ops.planSet({ cwd: r.cwd, plan: JSON.stringify(weaker), as: owner, channel: 'flag' });
    assert.deepEqual(e.kind === 'plan' && e.downgrades, [{ node: 'plain', what: 'approve removed' }, { node: 'plain', what: 'evidence ui removed' }]);
    assert.deepEqual((await state(r.cwd)).downgrades.flatMap(d => d.items.map(i => i.what)), ['approve removed', 'evidence ui removed']);
  } finally { await r.cleanup(); }
});

test('CLI: owed approve (owner: TTY or flag) and owed evidence with repeated --file; help and usage', { timeout: 120_000 }, async () => {
  const r = await fixture();
  try {
    await candidate(r);
    const help = await cli(r.cwd, ['--help']);
    assert.match(help.stdout, /approve <node> \[--note TEXT\] \[--block\]/);
    assert.match(help.stdout, /evidence <node> <id> \[--file PATH\]\.\.\. --note TEXT \[--as role:id\]/);
    { const out = await cli(r.cwd, ['approve', 'pub', '--as', 'parent:x']); assert.equal(out.code, 1); assert.match(out.stderr, /approve requires owner/); }
    { const out = await cli(r.cwd, ['approve', 'pub', '--commit', 'x', '--i-am-owner']); assert.equal(out.code, 2); }
    { const out = await cli(r.cwd, ['evidence', 'pub', '--note', 'x']); assert.equal(out.code, 2); assert.match(out.stderr, /wrong number of arguments/); }
    { const out = await cli(r.cwd, ['evidence', 'pub', 'ui', '--file', 'a.txt', '--as', 'reviewer:r']); assert.equal(out.code, 2); assert.match(out.stderr, /Required: --note/); }
    { const out = await cli(r.cwd, ['evidence', 'pub', 'ui', '--note', 'x', '--as', 'reviewer:r']); assert.equal(out.code, 1); assert.match(out.stderr, /requires at least one file/); }
    await writeFile(join(r.cwd, 'a.txt'), 'A'); await writeFile(join(r.cwd, 'b.txt'), 'BB');
    const ev = await cli(r.cwd, ['evidence', 'pub', 'ui', '--file', 'a.txt', '--file=b.txt', '--note', 'checked', '--as', 'reviewer:r', '--json']);
    assert.equal(ev.code, 0, ev.stderr);
    assert.deepEqual(JSON.parse(ev.stdout).files, [{ path: 'a.txt', sha256: sha256('A'), bytes: 1 }, { path: 'b.txt', sha256: sha256('BB'), bytes: 2 }]);
    const text = await cli(r.cwd, ['evidence', 'pub', 'tarball', '--file', 'a.txt', '--note', 'packed', '--as', 'parent:p']);
    assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /Recorded #\d+ parent:p recorded manual evidence pub\/evidence:tarball: files a\.txt [0-9a-f]{12}; note: packed/);
    assert.match(text.stdout, /✔ evidenced \(manual\) by parent:p pub\/evidence:tarball/);
    // Owner by TTY (main with an injected answer): declined records nothing; confirmed records channel tty.
    const io = (answer: string) => { const out: string[] = []; return { out, io: { ask: async () => answer, log: (t: string) => out.push(t), error: (t: string) => out.push(t) } }; };
    const cwd = process.cwd();
    process.chdir(r.cwd);
    try {
      const n = (await entries(r.cwd)).length;
      const no = io('no');
      assert.equal(await main(['approve', 'pub'], no.io), 1);
      assert.equal((await entries(r.cwd)).length, n);
      const yes = io('yes');
      assert.equal(await main(['approve', 'pub', '--note', 'go'], yes.io), 0, yes.out.join('\n'));
    } finally { process.chdir(cwd); }
    const last = (await entries(r.cwd)).at(-1)!;
    assert.ok(last.kind === 'review' && last.obligation === 'approve' && last.by === 'owner:human' && last.channel === 'tty' && last.rank === 3 && last.verdict === 'ok' && last.note === 'go');
    const flag = await cli(r.cwd, ['approve', 'pub', '--block', '--i-am-owner', '--note', 'wait']);
    assert.equal(flag.code, 0, flag.stderr);
    assert.match(flag.stdout, /reviewed pub\/approve block rank=3: wait/);
  } finally { await r.cleanup(); }
});

/** confirm: the owner's answer, or a function run inside ui.confirm (e.g. a resubmit while the dialog is open) that returns it. */
function harness(cwd: string, confirm: boolean | (() => Promise<boolean>) = true) {
  const tools = new Map<string, ToolDefinition>(), prompts: string[] = [];
  owed({ registerTool(t: ToolDefinition) { tools.set(t.name, t); }, registerCommand() {} } as unknown as ExtensionAPI);
  const ctx = { cwd, hasUI: true, ui: { async confirm(title: string, message: string) { prompts.push(`${title}\n${message}`); return typeof confirm === 'function' ? confirm() : confirm; }, notify() {} } } as unknown as ExtensionContext;
  return { prompts, call: (name: string, args: Record<string, unknown>) => tools.get(`owed_${name}`)!.execute('test', args, undefined, undefined, ctx as Parameters<ToolDefinition['execute']>[4]) as Promise<Result> };
}
const text = (r: Result): string => r.content.map(c => c.type === 'text' ? c.text : '').join('\n');

test('pi tools: owed_approve dialog (node, candidate, base, changed files) and owed_evidence (owner dialog with file hashes)', { timeout: 120_000 }, async () => {
  const r = await fixture();
  try {
    await candidate(r);
    const s = await state(r.cwd), c = s.nodes.pub!.candidate!;
    const declined = harness(r.cwd, false), n = (await entries(r.cwd)).length;
    const no = await declined.call('approve', { node: 'pub', note: 'ship\nIdentity: owner:fake', cwd: r.cwd });
    assert.equal(no.isError, true); assert.match(text(no), /owner did not confirm/);
    assert.equal((await entries(r.cwd)).length, n);
    assert.match(declined.prompts[0]!, new RegExp(`Approve node pub\\nCandidate: ${c.commit} \\(submit #${c.seq}\\)\\nBase: ${c.base}\\nChanged files: 1\\nRepository: .*\\nIdentity: owner:human\\nNote: ship\\\\nIdentity: owner:fake\\nConfirmation will be recorded as pi-confirm\\.`));
    const h = harness(r.cwd);
    { const out = await h.call('approve', { node: 'pub', as: 'parent:pi', cwd: r.cwd }); assert.equal(out.isError, true); assert.match(text(out), /Only owner may approve/); }
    { const out = await h.call('approve', { node: 'plain', cwd: r.cwd }); assert.equal(out.isError, true); assert.match(text(out), /no open candidate/); }
    const ok = await h.call('approve', { node: 'pub', cwd: r.cwd });
    assert.notEqual(ok.isError, true, text(ok));
    assert.match(text(ok), /✔ approved \(owner:human, pi-confirm\) pub\/approve/);
    await writeFile(join(r.cwd, 'shot.png'), 'png');
    const before = h.prompts.length;
    const rv = await h.call('evidence', { node: 'pub', id: 'ui', files: ['shot.png'], note: 'seen', as: 'reviewer:r1', cwd: r.cwd });
    assert.notEqual(rv.isError, true, text(rv));
    assert.equal(h.prompts.length, before, 'no dialog for a reviewer');
    const ow = await h.call('evidence', { node: 'pub', id: 'tarball', files: ['shot.png'], note: 'owner saw it', as: 'owner:human', cwd: r.cwd });
    assert.notEqual(ow.isError, true, text(ow));
    assert.match(h.prompts.at(-1)!, new RegExp(`Record manual evidence pub/tarball\\nCandidate: ${c.commit} \\(submit #${c.seq}\\)\\nBase: ${c.base}\\n.*\\nRepository: .*\\nIdentity: owner:human\\nFiles \\(1\\):\\n  shot\\.png ${sha256('png').slice(0, 12)} \\(3 bytes\\)\\nNote: owner saw it`));
    const last = (await entries(r.cwd)).at(-1)!;
    assert.ok(last.kind === 'evidence' && last.channel === 'pi-confirm' && last.by === 'owner:human');
    assert.equal((await state(r.cwd)).nodes.pub!.accepted, true);
    { const out = await h.call('evidence', { node: 'pub', id: 'ui', files: ['shot.png'], note: 'x', as: 'writer:pub#1', cwd: r.cwd }); assert.equal(out.isError, true); }
  } finally { await r.cleanup(); }
});

// ---------- driver: halts for approve/evidence only when nothing else is owed ----------
const P = 'hash0';
test('driver: halts (needs owner for approve, human for evidence) with the exact commands only when the rest is satisfied', () => {
  const spec: NodeSpec = { id: 'a', deps: [], writes: ['a/'], checks: [{ id: 'unit', run: 'npm test', timeout_s: 60, reads: ['a/**'] }], review: { count: 1, min_rank: 1 }, approve: 'owner', evidence: [{ id: 'ui', what: 'looked at the page', by: 'reviewer' }] };
  const p: Plan = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: [spec] };
  const all: Entry[] = [];
  const st = (): State => reduce(all, () => p);
  const add = (d: Draft): Entry => { const seq = all.length, e = { ...d, seq, ts: new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString(), prev: 'x', hash: `hash${seq}` } as Entry; all.push(e); st(); return e; };
  add({ kind: 'genesis', by: 'owner:human', channel: 'tty', plan: 'p', trunk: 'main', commit: 's0', state: { commit: 's0', tree: 't0', invKeys: {} } });
  add({ kind: 'dispatch', by: 'parent:drive', node: 'a', attempt: 1, base: 's0', branch: 'owed/a/1', worktree: '/repo/.owed/wt/a-1', packet: 'blob', rulings_seen: -1 });
  const w = writerLaunch(st(), 'a', P);
  add({ kind: 'launch', by: 'parent:drive', node: 'a', attempt: 1, role: 'writer', rid: w.rid, spec: sha256(w.spec), labels: w.labels });
  const facts: CandidateFacts = { commit: 'c1', tree: 't1', base: 's0', patch: 'p1', changed: ['a/x'], closureTouched: false, keys: { 'check:unit': 'k-unit', writes: 'k-writes', rulings: 'k-rulings', review: 'k-review', ...manualKeys(spec, 'p1') } };
  add({ kind: 'submit', by: 'writer:a#1', node: 'a', attempt: 1, facts });
  const opts: DriveOpts = { max: 4, repairs: 2, project: P, root: '/repo', applied: new Set(), rejected: new Map() };
  const sealed = new Map<string, RunView>([[w.rid, { rid: w.rid, state: 'sealed', status: 'ok' }]]);
  const running = new Map<string, RunView>([[w.rid, { rid: w.rid, state: 'running' }]]);
  const go = (runs = sealed) => decide(st(), p, runs, opts).filter(x => x.node === 'a').map(x => x.do === 'halt' ? `halt ${x.needs}: ${x.reason}` : x.do);
  // Not earlier: unmeasured checks attest first; a pending review launches a reviewer.
  assert.deepEqual(go(), ['attest']);
  for (const o of ['check:unit', 'writes']) add({ kind: 'obs', by: 'executor:owed', subject: 'a', obligation: o, key: facts.keys[o]!, verdict: 'pass', exit: 0, durationMs: 1, commit: 'c1', base: 's0' });
  assert.equal(manualHalt(st(), 'a'), undefined);
  assert.deepEqual(go(), ['launch']);
  add({ kind: 'review', by: 'reviewer:x', node: 'a', attempt: 1, obligation: 'review', key: 'k-review', verdict: 'ok', rank: 1, note: 'fine' });
  // Only approve and evidence remain: halt needing the owner, naming both commands; also while the writer still runs.
  const both = 'halt owner: awaiting owner approval of candidate c1: owed approve a --candidate c1 [--note TEXT] (owner); awaiting manual evidence evidence:ui (looked at the page) by reviewer: owed evidence a ui --file <path> --note "<what was checked>" --as reviewer:<id> --candidate c1';
  assert.deepEqual(go(), [both]);
  assert.deepEqual(go(running), [both]);
  // A recorded halt stops the driver until a non-driver entry on the node: the owner's approval clears it.
  add({ kind: 'halt', by: 'parent:drive', node: 'a', attempt: 1, reason: both.slice(12), needs: 'owner' });
  assert.deepEqual(go(), []);
  add({ kind: 'review', by: 'owner:human', channel: 'tty', node: 'a', attempt: 1, obligation: 'approve', key: facts.keys.approve!, verdict: 'ok', rank: 3, note: '' });
  assert.deepEqual(go(), ['halt human: awaiting manual evidence evidence:ui (looked at the page) by reviewer: owed evidence a ui --file <path> --note "<what was checked>" --as reviewer:<id> --candidate c1']);
  add({ kind: 'evidence', by: 'reviewer:y', node: 'a', attempt: 1, key: facts.keys['evidence:ui']!, id: 'ui', files: [{ path: 'shot.png', sha256: sha256('x'), bytes: 1 }], note: 'seen' });
  assert.equal(st().nodes.a!.accepted, true);
  assert.deepEqual(go(), ['merge']);
  assert.equal(runId(P, 'a', 1, 'writer'), w.rid);
});

/** A fixture with an open candidate of pub and a writer resubmit (as a driver repair would) to run while the owner confirms. */
async function pinFixture() {
  const r = await fixture(), worktree = await candidate(r);
  let round = 0;
  const resubmit = async (): Promise<void> => { await commitAt(worktree, { 'pub.txt': `pub ${++round}\n` }); await ops.submit({ cwd: worktree, node: 'pub', as: { role: 'writer', id: 'pub#1' } }); };
  const current = async () => (await state(r.cwd)).nodes.pub!.candidate!;
  /** Entries other than submits (approve reviews, evidence). */
  const recorded = async () => (await entries(r.cwd)).filter(e => e.kind !== 'submit').length;
  await writeFile(join(r.cwd, 'shot.png'), 'png');
  return { r, resubmit, current, recorded };
}

test('owed_approve approves the confirmed candidate: a resubmit inside ui.confirm records nothing (review ruling #389)', { timeout: 120_000 }, async () => {
  const { r, resubmit, current, recorded } = await pinFixture();
  try {
    // ops: a pin that is not the current candidate refuses.
    const c0 = await current();
    await resubmit();
    await refused(ops.approve({ cwd: r.cwd, node: 'pub', as: owner, channel: 'flag', candidate: { seq: c0.seq, commit: c0.commit } }), /candidate changed since confirmation; nothing recorded/);
    // pi: the dialog shows candidate c1; a resubmit inside ui.confirm makes the tool refuse.
    const n0 = await recorded(), c1 = await current();
    const h = harness(r.cwd, async () => { await resubmit(); return true; });
    const out = await h.call('approve', { node: 'pub', note: 'ship', cwd: r.cwd });
    assert.equal(out.isError, true, text(out)); assert.match(text(out), /candidate changed since confirmation; nothing recorded/);
    assert.match(h.prompts.at(-1)!, new RegExp(`Approve node pub\\nCandidate: ${c1.commit} \\(submit #${c1.seq}\\)`));
    assert.equal(await recorded(), n0, 'no approval was recorded');
    // Unchanged candidate: the approval is recorded on exactly the confirmed candidate.
    const c2 = await current(), done = await harness(r.cwd).call('approve', { node: 'pub', cwd: r.cwd });
    assert.notEqual(done.isError, true, text(done));
    const last = (await entries(r.cwd)).at(-1)!;
    assert.ok(last.kind === 'review' && last.obligation === 'approve' && last.key === c2.keys.approve && last.channel === 'pi-confirm');
  } finally { await r.cleanup(); }
});

test('owner owed_evidence records on the confirmed candidate: a resubmit inside ui.confirm records nothing (review ruling #389)', { timeout: 120_000 }, async () => {
  const { r, resubmit, current, recorded } = await pinFixture();
  try {
    const c0 = await current();
    await resubmit();
    await refused(ops.evidence({ cwd: r.cwd, node: 'pub', id: 'ui', files: ['shot.png'], note: 'n', as: owner, channel: 'flag', candidate: { seq: c0.seq, commit: c0.commit } }), /candidate changed since confirmation; nothing recorded/);
    const n0 = await recorded(), c1 = await current();
    const h = harness(r.cwd, async () => { await resubmit(); return true; });
    const ev = await h.call('evidence', { node: 'pub', id: 'ui', files: ['shot.png'], note: 'seen', as: 'owner:human', cwd: r.cwd });
    assert.equal(ev.isError, true, text(ev)); assert.match(text(ev), /candidate changed since confirmation; nothing recorded/);
    assert.match(h.prompts.at(-1)!, new RegExp(`Record manual evidence pub/ui\\nCandidate: ${c1.commit} \\(submit #${c1.seq}\\)`));
    assert.equal(await recorded(), n0, 'no evidence was recorded');
    // Unchanged candidate: the owner's evidence is recorded on it.
    const c2 = await current(), done = await harness(r.cwd).call('evidence', { node: 'pub', id: 'ui', files: ['shot.png'], note: 'seen', as: 'owner:human', cwd: r.cwd });
    assert.notEqual(done.isError, true, text(done));
    const last = (await entries(r.cwd)).at(-1)!;
    assert.ok(last.kind === 'evidence' && last.key === c2.keys['evidence:ui'] && last.channel === 'pi-confirm');
  } finally { await r.cleanup(); }
});

test('CLI approve prints the candidate before the owner prompt and approves only that one (review ruling #389)', { timeout: 120_000 }, async () => {
  const r = await fixture();
  try {
    const worktree = await candidate(r);
    const current = async () => (await state(r.cwd)).nodes.pub!.candidate!;
    const c1 = await current(), log: string[] = [], cwd = process.cwd(), n0 = (await entries(r.cwd)).length;
    // A resubmit between the printed candidate and the "yes" refuses and records no approval.
    const resubmit = async (): Promise<void> => { await commitAt(worktree, { 'pub.txt': 'pub again\n' }); await ops.submit({ cwd: worktree, node: 'pub', as: { role: 'writer', id: 'pub#1' } }); };
    process.chdir(r.cwd);
    let code: number;
    try { code = await main(['approve', 'pub'], { ask: async () => { await resubmit(); return 'yes'; }, log: t => log.push(t), error: t => log.push(t) }); } finally { process.chdir(cwd); }
    assert.equal(code, 1, log.join('\n'));
    assert.match(log.join('\n'), new RegExp(`Approve node pub: candidate ${c1.commit} \\(submit #${c1.seq}\\), base [0-9a-f]{40}, 1 changed file`));
    assert.match(log.join('\n'), /Refused: candidate changed since confirmation; nothing recorded/);
    assert.deepEqual((await entries(r.cwd)).slice(n0).map(e => e.kind), ['submit'], 'only the resubmit was recorded');
    // --i-am-owner prints the candidate too and records the approval on it.
    const c2 = await current();
    const flag = await cli(r.cwd, ['approve', 'pub', '--block', '--i-am-owner']);
    assert.equal(flag.code, 0, flag.stderr);
    assert.match(flag.stderr, new RegExp(`Block approval of node pub: candidate ${c2.commit} \\(submit #${c2.seq}\\)`));
    const last = (await entries(r.cwd)).at(-1)!;
    assert.ok(last.kind === 'review' && last.obligation === 'approve' && last.verdict === 'block' && last.key === c2.keys.approve && last.channel === 'flag');
  } finally { await r.cleanup(); }
});
