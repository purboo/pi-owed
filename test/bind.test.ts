// 0.6.0 node bind: candidate-bound acts name their candidate (G1; findings F1, F2) and judgment rails (G2; F3, F4, F5).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';
import { main } from '../src/cli.ts';
import { Ledger } from '../src/ledger.ts';
import * as ops from '../src/ops.ts';
import { parsePlan } from '../src/plan.ts';
import { reduce, validateDraft } from '../src/reducer.ts';
import { ownerCommands, renderReceipt, reviewPacket } from '../src/views.ts';
import type { Draft, Entry, Plan, State } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { commitAt, identity } from './helpers/surface.ts';

type Repo = Awaited<ReturnType<typeof repo>>;
type Result = Awaited<ReturnType<ToolDefinition['execute']>> & { isError?: boolean };
const owner = { role: 'owner' as const, id: 'human' };
const parent = { role: 'parent' as const, id: 'p' };
const reviewer = { role: 'reviewer' as const, id: 'r1' };
const plan = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: [{ id: 'a', writes: ['a.txt'], checks: [], review: { count: 1, min_rank: 1 }, approve: 'owner', evidence: [{ id: 'ui', what: 'looked at the page' }, { id: 'own', what: 'the owner tried it', by: 'owner' }] }] };
const STALE = /^candidate changed: you named [0-9a-f]+, the open candidate is #\d+ [0-9a-f]{12}; nothing recorded$/;
const F3 = 'a writer worktree cannot record a review or evidence for its own node; run the review from the repository root or another directory';
const OWED = fileURLToPath(new URL('../bin/owed.js', import.meta.url));
const text = (r: Result): string => r.content.map(c => c.type === 'text' ? c.text : '').join('\n');

async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prior = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try { return await fn(); } finally { for (const [k, v] of Object.entries(prior)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}
const delegated = { OWED_CONFIRM: undefined, OWED_CONFIRM_TIMEOUT: undefined, DSA_CALL: undefined, DSA_EXEC: undefined };
async function cli(cwd: string, args: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const full: NodeJS.ProcessEnv = { ...process.env, ...identity };
  for (const [k, v] of Object.entries({ ...delegated, ...env })) if (v === undefined) delete full[k]; else full[k] = v;
  try { const out = await promisify(execFile)(process.execPath, [OWED, ...args], { cwd, env: full, timeout: 30_000 }); return { code: 0, ...out }; }
  catch (e) { const x = e as { code: number; stdout: string; stderr: string }; if (typeof x.code !== 'number') throw e; return x; }
}
/** pi tools with session cwd `cwd` and a UI whose dialog is `confirm`. */
function harness(cwd: string, confirm: (title: string, message: string) => Promise<boolean> = async () => { throw new Error('no dialog expected'); }) {
  const tools = new Map<string, ToolDefinition>();
  owed({ registerTool(t: ToolDefinition) { tools.set(t.name, t); }, registerCommand() {} } as unknown as ExtensionAPI);
  const ctx = { cwd, hasUI: true, ui: { confirm, notify() {} } } as unknown as ExtensionContext;
  return (name: string, args: Record<string, unknown>): Promise<Result> => tools.get(name)!.execute('test', args, undefined, undefined, ctx as Parameters<ToolDefinition['execute']>[4]) as Promise<Result>;
}
async function entries(cwd: string): Promise<Entry[]> { return (await Ledger.open(cwd)).read(); }
async function state(cwd: string): Promise<State> {
  const ledger = await Ledger.open(cwd), all = await ledger.read(), plans = new Map<string, Plan>();
  for (const e of all) if (e.kind === 'genesis' || e.kind === 'plan') plans.set(e.plan, parsePlan((await ledger.getBlob(e.plan)).toString()));
  return reduce(all, sha => plans.get(sha)!);
}
async function fixture(p: object = plan): Promise<Repo> {
  const r = await repo();
  try { await commitAt(r.cwd, { README: 'x\n' }); await ops.init({ cwd: r.cwd, plan: JSON.stringify(p), as: owner, channel: 'flag' }); return r; }
  catch (e) { await r.cleanup(); throw e; }
}
/** Dispatches node a and submits a first candidate; `resubmit` then commits and submits a new one (the writer moving on). */
async function slot(r: Repo) {
  const d = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
  const writer = { role: 'writer' as const, id: `a#${d.attempt}` };
  let n = 0;
  const resubmit = async (): Promise<string> => { n++; const c = await commitAt(d.worktree, { 'a.txt': `v${n}\n` }); await ops.submit({ cwd: d.worktree, node: 'a', as: writer }); await ops.attest({ cwd: r.cwd, node: 'a' }); return c; };
  const first = await resubmit();
  return { worktree: d.worktree, first, resubmit };
}
async function unchanged(r: Repo, act: () => Promise<unknown>, re: RegExp | string, code?: string): Promise<void> {
  const n = (await entries(r.cwd)).length;
  await assert.rejects(act, (e: Error & { code?: string }) => { if (typeof re === 'string') assert.equal(e.message, re); else assert.match(e.message, re); if (code) assert.equal(e.code, code); return true; });
  assert.equal((await entries(r.cwd)).length, n, 'nothing recorded');
}

test('G1.1 ops: review, waive, approve and evidence record with the open candidate named, refuse a stale one (writer resubmitted) and record nothing', { timeout: 120_000 }, async () => {
  const r = await fixture();
  try {
    await withEnv(delegated, async () => {
      const s = await slot(r), file = join(r.root, 'ev.txt'); await writeFile(file, 'seen\n');
      const old = s.first, current = await s.resubmit(), seq = (await state(r.cwd)).nodes.a!.candidate!.seq;
      const stale = new RegExp(`^candidate changed: you named ${old.slice(0, 7)}, the open candidate is #${seq} ${current.slice(0, 12)}; nothing recorded$`);
      await unchanged(r, () => ops.review({ cwd: r.cwd, as: reviewer, node: 'a', verdict: 'ok', rank: 1, note: 'ok', named: old.slice(0, 7) }), stale);
      await unchanged(r, () => ops.waive({ cwd: r.cwd, as: owner, channel: 'flag', node: 'a', obligation: 'review', reason: 'x', named: old }), STALE);
      await unchanged(r, () => ops.approve({ cwd: r.cwd, as: owner, channel: 'flag', node: 'a', named: old }), STALE);
      await unchanged(r, () => ops.evidence({ cwd: r.cwd, as: reviewer, node: 'a', id: 'ui', files: [file], note: 'seen', named: old }), STALE);
      // The open candidate named (full commit, a 7-hex prefix, upper case) records as without the flag.
      const rv = await ops.review({ cwd: r.cwd, as: reviewer, node: 'a', verdict: 'ok', rank: 1, note: 'ok', named: current.slice(0, 7) });
      assert.ok(rv.kind === 'review' && rv.key === (await state(r.cwd)).nodes.a!.candidate!.keys.review);
      assert.equal((await ops.approve({ cwd: r.cwd, as: owner, channel: 'flag', node: 'a', named: current.toUpperCase() })).kind, 'review');
      assert.equal((await ops.evidence({ cwd: r.cwd, as: reviewer, node: 'a', id: 'ui', files: [file], note: 'seen', named: current })).kind, 'evidence');
      assert.equal((await ops.waive({ cwd: r.cwd, as: owner, channel: 'flag', node: 'a', obligation: 'review', reason: 'x', named: current.slice(0, 12) })).kind, 'waive');
      // Too short or not hex: a usage error before anything is read; no open candidate: the same refusal shape.
      for (const bad of [current.slice(0, 6), 'zzzzzzz', `${current}0`]) await unchanged(r, () => ops.review({ cwd: r.cwd, as: reviewer, node: 'a', verdict: 'ok', rank: 1, note: 'x', named: bad }), /^candidate must be a commit \(40 hex\) or a prefix of at least 7 hex/, 'usage');
      await ops.abandon({ cwd: r.cwd, as: parent, node: 'a', reason: 'done' });
      await unchanged(r, () => ops.waive({ cwd: r.cwd, as: owner, channel: 'flag', node: 'a', obligation: 'review', reason: 'x', named: current }), `candidate changed: you named ${current}, node a has no open candidate; nothing recorded`);
    });
  } finally { await r.cleanup(); }
});

test('G1.1 CLI and pi tools: --candidate / candidate pass through; stale refused (exit 1), short prefix a usage error (exit 2)', { timeout: 120_000 }, async () => {
  const r = await fixture();
  try {
    await withEnv(delegated, async () => {
      const s = await slot(r), old = s.first, current = await s.resubmit();
      await writeFile(join(r.cwd, 'ev.txt'), 'seen\n');
      const help = await cli(r.cwd, ['--help']);
      assert.match(help.stdout, /review <node> .*\[--candidate COMMIT\]/); assert.match(help.stdout, /waive <node> .*\[--candidate COMMIT\]/);
      let n = (await entries(r.cwd)).length;
      for (const args of [['review', 'a', '--ok', '--rank', '1', '--as', 'reviewer:r1'], ['waive', 'a', 'review', '--reason', 'x'], ['approve', 'a'], ['evidence', 'a', 'ui', '--file', 'ev.txt', '--note', 'n', '--as', 'reviewer:r1']]) {
        const stale = await cli(r.cwd, [...args, '--candidate', old.slice(0, 12)]);
        assert.equal(stale.code, 1, `${args[0]}: ${stale.stderr}`); assert.match(stale.stderr, /^Refused: candidate changed: you named [0-9a-f]{12}, the open candidate is #\d+ /m);
        const short = await cli(r.cwd, [...args, '--candidate', current.slice(0, 6)]);
        assert.equal(short.code, 2, `${args[0]}: ${short.stderr}`); assert.match(short.stderr, /Usage error: candidate must be a commit/);
      }
      assert.equal((await entries(r.cwd)).length, n, 'nothing recorded by the CLI refusals');
      const ok = await cli(r.cwd, ['review', 'a', '--ok', '--rank', '1', '--as', 'reviewer:r1', '--candidate', current.slice(0, 12)]);
      assert.equal(ok.code, 0, ok.stderr);
      assert.equal((await cli(r.cwd, ['approve', 'a', '--candidate', current])).code, 0);
      { const out = await cli(r.cwd, ['status', '--candidate', current]); assert.equal(out.code, 2); assert.match(out.stderr, /status does not support --candidate/); }
      // pi tools: the optional candidate parameter.
      const call = harness(r.cwd);
      n = (await entries(r.cwd)).length;
      for (const [tool, args] of [['owed_review', { node: 'a', as: 'reviewer:r2', verdict: 'ok', rank: 1, note: 'ok' }], ['owed_waive', { node: 'a', obligation: 'review', reason: 'x' }], ['owed_approve', { node: 'a' }], ['owed_evidence', { node: 'a', id: 'ui', files: ['ev.txt'], note: 'n', as: 'reviewer:r2' }]] as const) {
        const stale = await call(tool, { ...args, candidate: old });
        assert.equal(stale.isError, true, tool); assert.match(text(stale), /^Refused: candidate changed: you named [0-9a-f]{40}, the open candidate is #\d+ /);
        const short = await call(tool, { ...args, candidate: 'abc' });
        assert.equal(short.isError, true, tool); assert.equal((short.details as { code: string }).code, 'usage');
      }
      assert.equal((await entries(r.cwd)).length, n, 'nothing recorded by the tool refusals');
      for (const [tool, args] of [['owed_review', { node: 'a', as: 'reviewer:r2', verdict: 'ok', rank: 1, note: 'ok' }], ['owed_evidence', { node: 'a', id: 'ui', files: ['ev.txt'], note: 'n', as: 'reviewer:r2' }], ['owed_waive', { node: 'a', obligation: 'review', reason: 'x' }]] as const) {
        const out = await call(tool, { ...args, candidate: current.slice(0, 9) });
        assert.notEqual(out.isError, true, `${tool}: ${text(out)}`);
      }
      assert.equal((await entries(r.cwd)).length, n + 3);
    });
  } finally { await r.cleanup(); }
});

test('G1.2 gate: the waive and owner-review dialogs (pi and CLI) name the candidate and pin it; a resubmit during the dialog records nothing', { timeout: 120_000 }, async () => {
  const r = await fixture();
  try {
    await withEnv({ ...delegated, OWED_CONFIRM: 'owner' }, async () => {
      const s = await slot(r);
      let resubmitted = '';
      const dialogs: string[] = [];
      const racing = harness(r.cwd, async (_t, m) => { dialogs.push(m); resubmitted = await s.resubmit(); return true; });
      for (const [tool, args] of [['owed_waive', { node: 'a', obligation: 'review', reason: 'flaky reviewer' }], ['owed_review', { node: 'a', as: 'owner:human', verdict: 'ok', rank: 3, note: 'fine' }]] as const) {
        const shown = (await state(r.cwd)).nodes.a!.candidate!, n = (await entries(r.cwd)).length;
        const out = await racing(tool, args);
        assert.equal(out.isError, true, tool); assert.match(text(out), /candidate changed since confirmation; nothing recorded/);
        assert.ok((await entries(r.cwd)).slice(n).every(e => e.kind === 'submit' || e.kind === 'obs'), `${tool}: only the resubmit and its attest observations`);
        const m = dialogs.at(-1)!;
        assert.ok(m.includes(`Candidate: ${shown.commit} (submit #${shown.seq})`) && /\nBase: [0-9a-f]{40}\nChanged files: 1\n/.test(m), m);
        assert.notEqual(resubmitted, shown.commit);
      }
      const call = harness(r.cwd, async () => true);
      const w = await call('owed_waive', { node: 'a', obligation: 'review', reason: 'flaky reviewer' });
      assert.notEqual(w.isError, true, text(w));
      const last = (await entries(r.cwd)).at(-1)!;
      assert.ok(last.kind === 'waive' && last.channel === 'pi-confirm' && last.key === (await state(r.cwd)).nodes.a!.candidate!.keys.review);
      // CLI under the gate: the TTY prompt follows the candidate line; a resubmit at the prompt is refused.
      const cwd = process.cwd(), out: string[] = [];
      process.chdir(r.cwd);
      try {
        const n = (await entries(r.cwd)).length, shown = (await state(r.cwd)).nodes.a!.candidate!, base = (await state(r.cwd)).nodes.a!.slot!.base;
        const io = { ask: async () => { await s.resubmit(); return 'yes'; }, log: (t: string) => out.push(t), error: (t: string) => out.push(t) };
        assert.equal(await main(['review', 'a', '--ok', '--rank', '3', '--as', 'owner:human'], io), 1);
        assert.ok(out.some(l => l === `Owner review of node a: candidate ${shown.commit} (submit #${shown.seq}), base ${base}, 1 changed file`), out.join('\n'));
        assert.ok(out.some(l => /candidate changed since confirmation; nothing recorded/.test(l)), out.join('\n'));
        assert.ok((await entries(r.cwd)).slice(n).every(e => e.kind === 'submit' || e.kind === 'obs'), 'only the resubmit and its observations');
        out.length = 0;
        assert.equal(await main(['waive', 'a', 'review', '--reason', 'x'], { ...io, ask: async () => 'yes' }), 0, out.join('\n'));
        assert.ok(out.some(l => l.startsWith('Waive a/review: candidate ')), out.join('\n'));
      } finally { process.chdir(cwd); }
    });
  } finally { await r.cleanup(); }
});

test('G1.3: ownerCommands, the brief and the review packet carry --candidate <commit12> of the open candidate', { timeout: 120_000 }, async () => {
  const r = await fixture();
  try {
    await withEnv(delegated, async () => {
      const s = await slot(r), c12 = s.first.slice(0, 12);
      await ops.review({ cwd: r.cwd, as: reviewer, node: 'a', verdict: 'block', rank: 1, note: 'no' });
      const st = await state(r.cwd), cmds = ownerCommands(st, 'a');
      assert.ok(cmds.includes(`owed approve a --candidate ${c12} [--note TEXT] (owner)`), cmds.join('\n'));
      assert.ok(cmds.includes(`owed evidence a own --file <path> --note "<what was checked>" --as owner:cli --candidate ${c12}`), cmds.join('\n'));
      assert.ok(cmds.some(c => c.startsWith('owed waive a review ') && c.endsWith(` --candidate ${c12}`)), cmds.join('\n'));
      const brief = await ops.brief({ cwd: r.cwd });
      assert.ok(brief.decisions.length && brief.decisions.every(d => d.command.includes(`--candidate ${c12}`)), JSON.stringify(brief.decisions));
      const why = renderReceipt(await ops.why({ cwd: r.cwd, node: 'a' }));
      assert.match(why, new RegExp(`or owner: owed waive a review --reason "<why the risk is acceptable>" --accept-risk \\d+ --candidate ${c12}`), why);
      const packet = reviewPacket(st, 'a', 1).split('\n');
      assert.ok(packet.includes(`  owed review a --as reviewer:drive-a-1-1 --ok|--block --rank 2 --candidate ${c12} --note "..."`), packet.join('\n'));
      assert.ok(packet.some(l => l.includes(`--candidate ${c12}`) && /re-read owed why a and review the new candidate/.test(l)), packet.join('\n'));
      assert.ok(packet.some(l => l.includes(`owed evidence a ui --file <path> --note "<what was checked>" --as reviewer:drive-a-1-1 --candidate ${c12}`)), packet.join('\n'));
    });
  } finally { await r.cleanup(); }
});

test('G2.1 (F3): in a dsa call, review and evidence from inside the slot worktree are refused; from the repository root they record', { timeout: 120_000 }, async () => {
  const r = await fixture();
  try {
    const s = await withEnv(delegated, () => slot(r));
    const file = join(r.root, 'ev.txt'); await writeFile(file, 'seen\n');
    const n = (await entries(r.cwd)).length;
    for (const env of [{ DSA_CALL: 'call-1' }, { DSA_EXEC: 'exec-1' }]) {
      const rv = await cli(s.worktree, ['review', 'a', '--ok', '--rank', '1', '--as', 'reviewer:r1'], env);
      assert.equal(rv.code, 1, rv.stderr); assert.equal(rv.stderr.trim(), `Refused: ${F3}`);
      const ev = await cli(join(s.worktree), ['evidence', 'a', 'ui', '--file', file, '--note', 'n', '--as', 'reviewer:r1'], env);
      assert.equal(ev.code, 1, ev.stderr); assert.equal(ev.stderr.trim(), `Refused: ${F3}`);
    }
    await withEnv({ ...delegated, DSA_CALL: 'call-1' }, async () => {
      await unchanged(r, () => ops.review({ cwd: s.worktree, as: reviewer, node: 'a', verdict: 'ok', rank: 1, note: 'x' }), F3);
      // pi tool: the session's working directory counts even when the call names the repository root.
      const inside = harness(s.worktree);
      const out = await inside('owed_review', { node: 'a', as: 'reviewer:r1', verdict: 'ok', rank: 1, note: 'x', cwd: r.cwd });
      assert.equal(out.isError, true); assert.equal(text(out), `Refused: ${F3}`);
      const ev = await inside('owed_evidence', { node: 'a', id: 'ui', files: [file], note: 'n', as: 'reviewer:r1', cwd: r.cwd });
      assert.equal(ev.isError, true); assert.equal(text(ev), `Refused: ${F3}`);
    });
    assert.equal((await entries(r.cwd)).length, n, 'nothing recorded from the writer worktree');
    // From the repository root the same acts record, in a dsa call or not; outside a dsa call the worktree is no rail.
    const root = await cli(r.cwd, ['review', 'a', '--ok', '--rank', '1', '--as', 'reviewer:r1'], { DSA_CALL: 'call-1' });
    assert.equal(root.code, 0, root.stderr);
    const ev = await cli(r.cwd, ['evidence', 'a', 'ui', '--file', file, '--note', 'n', '--as', 'reviewer:r1'], { DSA_CALL: 'call-1' });
    assert.equal(ev.code, 0, ev.stderr);
    await withEnv({ ...delegated, DSA_CALL: 'call-1' }, async () => {
      const out = await harness(r.cwd)('owed_review', { node: 'a', as: 'reviewer:r2', verdict: 'ok', rank: 1, note: 'x' });
      assert.notEqual(out.isError, true, text(out));
    });
    const plain = await cli(s.worktree, ['review', 'a', '--ok', '--rank', '1', '--as', 'reviewer:r3']);
    assert.equal(plain.code, 0, plain.stderr);
    assert.equal((await entries(r.cwd)).length, n + 4);
  } finally { await r.cleanup(); }
});

test('G2.2 (F4): a review by reviewer:a#2 stops counting once writer:a#2 submits the same patch; owed merge is refused', { timeout: 120_000 }, async () => {
  const r = await fixture({ ...plan, nodes: [{ id: 'a', writes: ['a.txt'], checks: [], review: { count: 1, min_rank: 1 } }] });
  try {
    await withEnv(delegated, async () => {
      // 1-2: attempt 1, its candidate, and an ok by reviewer:a#2 (allowed: a#2 is not yet a writer).
      const d1 = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
      await commitAt(d1.worktree, { 'a.txt': 'same\n' });
      await ops.submit({ cwd: d1.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
      await ops.attest({ cwd: r.cwd, node: 'a' });
      const ok = await ops.review({ cwd: r.cwd, as: { role: 'reviewer', id: 'a#2' }, node: 'a', verdict: 'ok', rank: 1, note: 'fine' });
      assert.equal((await state(r.cwd)).nodes.a!.items.find(i => i.obligation === 'review')!.status, 'E');
      // 3: abandon; attempt 2's writer is writer:a#2 and submits the same content on the same base (same review key).
      await ops.abandon({ cwd: r.cwd, as: parent, node: 'a', reason: 'retry' });
      const d2 = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
      await commitAt(d2.worktree, { 'a.txt': 'same\n' });
      await ops.submit({ cwd: d2.worktree, node: 'a', as: { role: 'writer', id: 'a#2' } });
      await ops.attest({ cwd: r.cwd, node: 'a' });
      const s = await state(r.cwd), item = s.nodes.a!.items.find(i => i.obligation === 'review')!;
      assert.ok(ok.kind === 'review' && ok.key === item.key, 'same patch, same review key');
      assert.equal(item.status, 'D', 'the review by an id of a writer of the node does not count');
      assert.deepEqual(item.evidence, []);
      // 4: the merge is refused (it succeeded in 0.5.1).
      await unchanged(r, () => ops.merge({ cwd: r.cwd, as: parent, node: 'a' }), /current candidate is not yet accepted:.*review/);
      // A new review by that id is refused at append time, as before: one recusal rule.
      await unchanged(r, () => ops.review({ cwd: r.cwd, as: { role: 'reviewer', id: 'a#2' }, node: 'a', verdict: 'ok', rank: 1, note: 'x' }), /must not be the writer of any attempt/);
    });
  } finally { await r.cleanup(); }
});

test('G2.3 (F5): parent:drive records only driver kinds (append and replay); --as parent:drive and as: parent:drive are refused', { timeout: 120_000 }, async () => {
  const r = await fixture();
  try {
    await withEnv(delegated, async () => {
      const s = await state(r.cwd), drive = 'parent:drive';
      const forgedPlan = { kind: 'plan', by: drive, prior: s.planSha, plan: s.planSha, downgrades: [] } as unknown as Draft;
      assert.deepEqual(validateDraft(s, { ...forgedPlan, by: 'parent:main' } as Draft), [], 'the same plan entry by another parent is valid');
      assert.match(validateDraft(s, forgedPlan).join(), /plan by parent:drive: the driver records only dispatch, launch, send, halt, rebase/);
      assert.match(validateDraft(s, { kind: 'rule', by: drive, text: 'x', nodes: '*' } as Draft).join(), /rule by parent:drive/);
      assert.match(validateDraft(s, { kind: 'note', by: drive, text: 'x' } as Draft).join(), /note by parent:drive/);
      await unchanged(r, () => ops.rule({ cwd: r.cwd, as: { role: 'parent', id: 'drive' }, text: 'x', nodes: '*' }), /rule by parent:drive/);
      // The driver's own kinds still record as parent:drive (dispatch here; launch/send/halt/rebase in the drive tests).
      assert.equal((await ops.dispatch({ cwd: r.cwd, node: 'a', as: { role: 'parent', id: 'drive' } })).entry.by, drive);
      // CLI and pi tools refuse the claim everywhere, reads included.
      const n = (await entries(r.cwd)).length;
      for (const args of [['rule', 'x', '--nodes', '*'], ['status'], ['abandon', 'a']]) {
        const out = await cli(r.cwd, [...args, '--as', drive]);
        assert.equal(out.code, 1, out.stderr); assert.equal(out.stderr.trim(), `Refused: ${ops.DRIVER_CLAIM}`);
      }
      const call = harness(r.cwd);
      for (const [tool, args] of [['owed_rule', { text: 'x', nodes: '*' }], ['owed_status', {}], ['owed_abandon', { node: 'a' }]] as const) {
        const out = await call(tool, { ...args, as: drive });
        assert.equal(out.isError, true, tool); assert.equal(text(out), `Refused: ${ops.DRIVER_CLAIM}`);
      }
      assert.equal((await entries(r.cwd)).length, n);
      // A forged parent:drive plan entry written straight to the ledger fails replay.
      const ledger = await Ledger.open(r.cwd);
      const prior = (await state(r.cwd)).planSha;
      const [forged] = await ledger.withLock(() => ledger.append([{ ...forgedPlan, prior, plan: prior } as Draft]));
      await assert.rejects(ops.status({ cwd: r.cwd }), new RegExp(`Entry #${forged!.seq} invalid: plan by parent:drive`));
      const v = await ops.verify({ cwd: r.cwd });
      assert.equal(v.ok, false); assert.match(v.error ?? '', /plan by parent:drive/);
    });
  } finally { await r.cleanup(); }
});
