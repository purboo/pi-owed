// D25: delegated owner — the main agent holds every authority; no human step (SPEC §2, §11). Node id confirm-timeout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed, { confirmTimeout, confirmTimeoutText } from '../src/extension.ts';
import { Ledger } from '../src/ledger.ts';
import { main } from '../src/cli.ts';
import * as ops from '../src/ops.ts';
import { renderBrief, renderReport } from '../src/views.ts';
import type { Entry } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { commitAt, identity } from './helpers/surface.ts';

type Result = Awaited<ReturnType<ToolDefinition['execute']>> & { isError?: boolean };
type Opts = { timeout?: number; signal?: AbortSignal } | undefined;
const plan = (count: number) => JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [], nodes: [{ id: 'a', writes: ['a/'], checks: [], review: { count, min_rank: 1 } }] });
const text = (r: Result): string => r.content.map(c => c.type === 'text' ? c.text : '').join('\n');
const entries = async (cwd: string): Promise<Entry[]> => (await Ledger.open(cwd)).read();
const digest = 'a'.repeat(64);
const SUBAGENT = /^owner and parent acts are reserved for the main agent; this process is a subagent call \((DSA_CALL|DSA_EXEC)\)$/;

/** Runs `fn` with these environment variables set (undefined = unset), restoring them afterwards. */
async function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const prior = Object.fromEntries(Object.keys(vars).map(k => [k, process.env[k]]));
  for (const [k, v] of Object.entries(vars)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  try { return await fn(); } finally { for (const [k, v] of Object.entries(prior)) if (v === undefined) delete process.env[k]; else process.env[k] = v; }
}
const delegatedEnv = { OWED_CONFIRM: undefined, OWED_CONFIRM_TIMEOUT: undefined, DSA_CALL: undefined, DSA_EXEC: undefined };
/** pi tools with a UI whose dialog `confirm` records each call. */
function harness(cwd: string, confirm: (title: string, message: string, opts?: Opts) => Promise<boolean>) {
  const tools = new Map<string, ToolDefinition>();
  owed({ registerTool(t: ToolDefinition) { tools.set(t.name, t); }, registerCommand() {} } as unknown as ExtensionAPI);
  const ctx = { cwd, hasUI: true, ui: { confirm, notify() {} } } as unknown as ExtensionContext;
  return (name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<Result> => tools.get(name)!.execute('test', args, signal, undefined, ctx as Parameters<ToolDefinition['execute']>[4]) as Promise<Result>;
}
const noDialog = async (): Promise<boolean> => { throw new Error('no dialog expected'); };
async function fixture() {
  const r = await repo();
  try {
    await commitAt(r.cwd, { README: 'x\n' });
    await ops.init({ cwd: r.cwd, plan: plan(1), as: { role: 'owner', id: 'human' }, channel: 'flag' });
    await writeFile(join(r.cwd, 'eased.json'), plan(0));
    await writeFile(join(r.cwd, 'strict.json'), plan(2));
    return r;
  } catch (e) { await r.cleanup(); throw e; }
}
/** The CLI in a child process without a TTY, with extra environment variables (undefined = unset). */
async function cli(cwd: string, args: string[], env: Record<string, string | undefined> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  const full: NodeJS.ProcessEnv = { ...process.env, ...identity };
  for (const [k, v] of Object.entries({ ...delegatedEnv, ...env })) if (v === undefined) delete full[k]; else full[k] = v;
  try { const out = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../bin/owed.js', import.meta.url)), ...args], { cwd, env: full, timeout: 30_000 }); return { code: 0, ...out }; }
  catch (e) { const x = e as { code: number; stdout: string; stderr: string }; if (typeof x.code !== 'number') throw e; return x; }
}

test('pi: owner tools run with no dialog as owner:pi and record channel delegated; a delegated downgrade needs a note', { timeout: 60_000 }, async () => {
  const r = await fixture();
  try {
    await withEnv(delegatedEnv, async () => {
      const call = harness(r.cwd, noDialog);
      const before = await entries(r.cwd);
      const bare = await call('owed_plan', { plan: 'eased.json' });
      assert.equal(bare.isError, true);
      assert.match(text(bare), /a delegated owner plan update that reduces obligations requires a note saying why/);
      assert.deepEqual(await entries(r.cwd), before, 'refused: nothing recorded');
      const eased = await call('owed_plan', { plan: 'eased.json', note: 'review is redundant for this generated file' });
      assert.notEqual(eased.isError, true, text(eased));
      const e = (await entries(r.cwd)).at(-1)!;
      assert.ok(e.kind === 'plan' && e.by === 'owner:pi' && e.channel === 'delegated' && e.note === 'review is redundant for this generated file' && e.downgrades.length === 1, JSON.stringify(e));
      // A parent plan update without downgrades needs no note and is not an owner act.
      const strict = await call('owed_plan', { plan: 'strict.json' });
      assert.notEqual(strict.isError, true, text(strict));
      assert.equal((await entries(r.cwd)).at(-1)!.by, 'parent:pi');
      const decoy = await call('owed_decoy', { action: 'commit', digest });
      assert.notEqual(decoy.isError, true, text(decoy));
      const d = (await entries(r.cwd)).at(-1)!;
      assert.ok(d.kind === 'decoy-commit' && d.by === 'owner:pi' && d.channel === 'delegated');
      const rule = await call('owed_rule', { text: 'use the new API', nodes: '*', as: 'owner:boss' });
      assert.notEqual(rule.isError, true, text(rule));
      const x = (await entries(r.cwd)).at(-1)!;
      assert.ok(x.kind === 'rule' && x.by === 'owner:boss' && x.channel === 'delegated');
      assert.equal((await ops.verify({ cwd: r.cwd })).ok, true);
    });
  } finally { await r.cleanup(); }
});

test('CLI: --as owner:x without a TTY records delegated (no prompt, no --i-am-owner); --i-am-owner still records flag; --note on plan', { timeout: 60_000 }, async () => {
  const r = await fixture();
  try {
    const rule = await cli(r.cwd, ['rule', 'ship small commits', '--nodes', '*', '--as', 'owner:x', '--json']);
    assert.equal(rule.code, 0, rule.stderr);
    let last = (await entries(r.cwd)).at(-1)!;
    assert.ok(last.kind === 'rule' && last.by === 'owner:x' && last.channel === 'delegated', JSON.stringify(last));
    const decoy = await cli(r.cwd, ['decoy', 'commit', digest]);
    assert.equal(decoy.code, 0, decoy.stderr);
    last = (await entries(r.cwd)).at(-1)!;
    assert.ok(last.kind === 'decoy-commit' && last.by === 'owner:human' && last.channel === 'delegated', 'an owner-default command is delegated too');
    const bare = await cli(r.cwd, ['plan', 'eased.json', '--as', 'owner:x']);
    assert.equal(bare.code, 1); assert.match(bare.stderr, /requires a note saying why/);
    const eased = await cli(r.cwd, ['plan', 'eased.json', '--as', 'owner:x', '--note', 'generated file']);
    assert.equal(eased.code, 0, eased.stderr);
    assert.match(eased.stdout, /^Recorded #\d+ owner:x \(delegated\) updated plan from eased\.json, downgrades a: .*: generated file$/m);
    last = (await entries(r.cwd)).at(-1)!;
    assert.ok(last.kind === 'plan' && last.channel === 'delegated' && last.note === 'generated file');
    const flag = await cli(r.cwd, ['rule', 'flagged', '--nodes', '*', '--as', 'owner:x', '--i-am-owner']);
    assert.equal(flag.code, 0, flag.stderr);
    assert.equal((await entries(r.cwd)).at(-1)!.channel, 'flag');
    // OWED_CONFIRM=owner restores the TTY confirmation: without a TTY the owner act is refused, nothing recorded.
    const before = await entries(r.cwd);
    const gated = await cli(r.cwd, ['rule', 'gated', '--nodes', '*', '--as', 'owner:x'], { OWED_CONFIRM: 'owner' });
    assert.equal(gated.code, 1); assert.match(gated.stderr, /owner actions require TTY confirmation or --i-am-owner/);
    assert.deepEqual(await entries(r.cwd), before);
  } finally { await r.cleanup(); }
});

test('DSA_CALL / DSA_EXEC: owner and parent acts are refused in pi tools and the CLI; reads and other roles still work', { timeout: 90_000 }, async () => {
  const r = await fixture();
  try {
    const before = await entries(r.cwd);
    await withEnv({ ...delegatedEnv, DSA_CALL: 'call-1' }, async () => {
      const call = harness(r.cwd, noDialog);
      for (const [tool, args] of [['owed_rule', { text: 'x', nodes: '*', as: 'owner:pi' }], ['owed_rule', { text: 'x', nodes: '*', as: 'parent:main' }], ['owed_plan', { plan: 'strict.json' }], ['owed_plan', { plan: 'eased.json', note: 'n' }], ['owed_decoy', { action: 'commit', digest }], ['owed_dispatch', { node: 'a' }]] as const) {
        const out = await call(tool, args);
        assert.equal(out.isError, true, `${tool} ${JSON.stringify(args)}`);
        assert.match(text(out), /owner and parent acts are reserved for the main agent; this process is a subagent call \(DSA_CALL\)/, tool);
      }
      const status = await call('owed_status', {});
      assert.notEqual(status.isError, true, text(status));
      const digestOnly = await call('owed_decoy', { action: 'digest', file: 'eased.json' }).catch(e => e as Error);
      assert.ok(!(digestOnly instanceof Error) && !/subagent call/.test(text(digestOnly)), 'decoy digest writes nothing and is allowed');
    });
    await withEnv({ ...delegatedEnv, DSA_EXEC: 'exec-1' }, async () => {
      const out = await harness(r.cwd, noDialog)('owed_rule', { text: 'x', nodes: '*', as: 'owner:pi' });
      assert.equal(out.isError, true); assert.match(text(out), /subagent call \(DSA_EXEC\)/);
    });
    for (const env of [{ DSA_CALL: 'call-1' }, { DSA_EXEC: 'exec-1' }]) {
      for (const args of [['rule', 'x', '--nodes', '*', '--as', 'owner:x'], ['rule', 'x', '--nodes', '*'], ['waive', 'a', 'review', '--reason', 'r'], ['plan', 'strict.json'], ['rule', 'x', '--nodes', '*', '--i-am-owner']]) {
        const out = await cli(r.cwd, args, env);
        assert.equal(out.code, 1, `${args.join(' ')}: ${out.stderr}`);
        assert.match(out.stderr.trim().split('\n').at(-1)!.replace(/^Refused: /, ''), SUBAGENT, args.join(' '));
      }
      const status = await cli(r.cwd, ['status'], env);
      assert.equal(status.code, 0, status.stderr);
      const writer = await cli(r.cwd, ['review', 'a', '--ok', '--rank', '1', '--as', 'reviewer:r'], env);
      assert.doesNotMatch(writer.stderr, /subagent call/, 'other roles keep their rules');
    }
    assert.deepEqual(await entries(r.cwd), before, 'nothing recorded');
  } finally { await r.cleanup(); }
});

test('OWED_CONFIRM=owner: the dialog waits at most OWED_CONFIRM_TIMEOUT seconds, then refuses with nothing recorded; yes records pi-confirm', { timeout: 60_000 }, async () => {
  assert.equal(confirmTimeout({}), 120);
  assert.equal(confirmTimeout({ OWED_CONFIRM_TIMEOUT: '0' }), 0);
  assert.equal(confirmTimeout({ OWED_CONFIRM_TIMEOUT: '-1' }), 120);
  const r = await fixture();
  try {
    const calls: Opts[] = [];
    // Two dialogs that never answer (pre-review #1): one never settles at all, one ignores `signal` and `timeout` too
    // and answers yes much later. owed's own timer must bound the call either way; a late yes is never a confirmation.
    let late: Promise<boolean> | undefined;
    const fakes: [string, (t: string, m: string, opts?: Opts) => Promise<boolean>][] = [
      ['never settles', (_t, _m, opts) => { calls.push(opts); return new Promise<boolean>(() => {}); }],
      ['ignores signal, answers yes after 3 s', (_t, _m, opts) => { calls.push(opts); late = new Promise<boolean>(res => setTimeout(() => res(true), 3000)); return late; }],
    ];
    const before = await entries(r.cwd);
    for (const [label, fake] of fakes) {
      const started = Date.now();
      const out = await withEnv({ ...delegatedEnv, OWED_CONFIRM: 'owner', OWED_CONFIRM_TIMEOUT: '1' }, () => harness(r.cwd, fake)('owed_plan', { plan: 'eased.json', note: 'n' }));
      const elapsed = Date.now() - started;
      assert.ok(elapsed >= 900 && elapsed < 2500, `${label}: elapsed ${elapsed} ms`);
      assert.equal(out.isError, true, label);
      assert.equal(text(out), `Refused: ${confirmTimeoutText(1)}`, label);
      assert.deepEqual(out.details, { code: 'refused', reason: confirmTimeoutText(1) }, label);
      assert.equal(calls.at(-1)!.timeout, 2000, `${label}: pi's countdown outlasts owed's own 1 s limit`);
      assert.equal(calls.at(-1)!.signal?.aborted, true, `${label}: owed dismissed the dialog`);
      assert.deepEqual(await entries(r.cwd), before, `${label}: nothing recorded`);
    }
    assert.equal(confirmTimeoutText(1), 'Owner confirmation not given within 1 s; nothing was recorded.');
    assert.equal(await late, true);
    await new Promise(res => setTimeout(res, 100));
    assert.deepEqual(await entries(r.cwd), before, 'the late yes recorded nothing');
    const never = fakes[0]![1];
    // Escape (the tool call's abort) refuses `aborted`; yes records pi-confirm as owner:human (the 0.4.1 default).
    const ac = new AbortController();
    const abortNow = (t: string, m: string, opts?: Opts) => { const p = never(t, m, opts); queueMicrotask(() => ac.abort()); return p; };
    const aborted = await withEnv({ ...delegatedEnv, OWED_CONFIRM: 'owner' }, () => harness(r.cwd, abortNow)('owed_plan', { plan: 'eased.json', note: 'n' }, ac.signal));
    assert.equal(text(aborted), 'Aborted: aborted');
    assert.deepEqual(await entries(r.cwd), before);
    const yes = await withEnv({ ...delegatedEnv, OWED_CONFIRM: 'owner', OWED_CONFIRM_TIMEOUT: '0' }, () => harness(r.cwd, async (_t, _m, opts) => { calls.push(opts); return true; })('owed_plan', { plan: 'eased.json' }));
    assert.notEqual(yes.isError, true, text(yes));
    assert.equal(calls.at(-1)!.timeout, undefined, '0 = no limit');
    const last = (await entries(r.cwd)).at(-1)!;
    assert.ok(last.kind === 'plan' && last.by === 'owner:human' && last.channel === 'pi-confirm', 'a confirmed owner downgrade needs no note');
  } finally { await r.cleanup(); }
});

test('audit: the brief starts with the delegated owner acts (kind, node, what, why); report marks them (delegated)', { timeout: 60_000 }, async () => {
  const r = await fixture();
  try {
    await withEnv(delegatedEnv, async () => {
      const call = harness(r.cwd, noDialog);
      assert.notEqual((await call('owed_plan', { plan: 'eased.json', note: 'review is redundant' })).isError, true);
      assert.notEqual((await call('owed_rule', { text: 'keep it small', nodes: ['a'], as: 'owner:pi' })).isError, true);
      assert.notEqual((await call('owed_rule', { text: 'parent ruling', nodes: '*' })).isError, true);
    });
    const all = await entries(r.cwd), plan = all.find(e => e.kind === 'plan')!, rule = all.find(e => e.kind === 'rule')!;
    const b = await ops.brief({ cwd: r.cwd });
    assert.deepEqual(b.delegated.map(d => [d.seq, d.by, d.kind, d.node, d.note]), [[plan.seq, 'owner:pi', 'plan', undefined, 'review is redundant'], [rule.seq, 'owner:pi', 'rule', undefined, 'keep it small']]);
    const lines = renderBrief(b).split('\n');
    assert.equal(lines[0], 'Brief (since start)');
    assert.equal(lines[1], 'Owner acts (delegated) since start (2):');
    assert.match(lines[2]!, new RegExp(`^  #${plan.seq} owner:pi plan: downgrades a: .+ — review is redundant$`));
    assert.equal(lines[3], `  #${rule.seq} owner:pi rule: ruling (a) — keep it small`);
    assert.equal(lines[4], 'Needs your decision: none');
    // A later window has no delegated act, so no section; genesis (flag) is never one.
    const later = renderBrief(await ops.brief({ cwd: r.cwd, since: rule.seq }));
    assert.match(later, /^Brief \(since #\d+\)\nNeeds your decision: none\n/);
    assert.deepEqual((await ops.brief({ cwd: r.cwd, since: rule.seq })).delegated, []);
    const report = renderReport(await ops.report({ cwd: r.cwd }));
    assert.match(report, new RegExp(`\\n  #${plan.seq} owner:pi \\(delegated\\) updated plan from eased\\.json, downgrades a: .*: review is redundant\\n`));
    assert.match(report, new RegExp(`\\n  #${rule.seq} owner:pi \\(delegated\\) ruling \\(a\\): keep it small\\n`));
  } finally { await r.cleanup(); }
});

test('approve/evidence and waive: delegated acts record on the current candidate with no dialog; under OWED_CONFIRM=owner the dialog still pins the confirmed candidate', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    const pub = { id: 'pub', writes: ['pub.txt', 'shot.png'], checks: [], review: { count: 0, min_rank: 1 }, approve: 'owner', evidence: [{ id: 'ui', what: 'looked at the page' }] };
    await commitAt(r.cwd, { README: 'x\n' });
    await ops.init({ cwd: r.cwd, plan: JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [], nodes: [pub] }), as: { role: 'owner', id: 'human' }, channel: 'flag' });
    const d = await ops.dispatch({ cwd: r.cwd, node: 'pub', as: { role: 'parent', id: 'p' } });
    await writeFile(join(r.cwd, 'shot.png'), 'png');
    let n = 0;
    const resubmit = async (): Promise<void> => { await commitAt(d.worktree, { 'pub.txt': `v${++n}\n` }); await ops.submit({ cwd: d.worktree, node: 'pub', as: { role: 'writer', id: 'pub#1' } }); };
    const current = async () => (await ops.status({ cwd: r.cwd })).nodes.pub!.candidate!;
    await resubmit();
    // A delegated waiver without a reason is refused (waive, defer and adopt always required theirs), nothing recorded.
    const pre = await entries(r.cwd);
    await assert.rejects(ops.waive({ cwd: r.cwd, as: { role: 'owner', id: 'pi' }, channel: 'delegated', node: 'pub', obligation: 'approve', reason: '  ' }), /waive requires a reason/);
    assert.deepEqual(await entries(r.cwd), pre);
    // Delegated: no dialog; recorded on the current candidate.
    await withEnv(delegatedEnv, async () => {
      const call = harness(r.cwd, noDialog), c = await current();
      const ap = await call('owed_approve', { node: 'pub', note: 'ship it' });
      assert.notEqual(ap.isError, true, text(ap));
      const a = (await entries(r.cwd)).at(-1)!;
      assert.ok(a.kind === 'review' && a.obligation === 'approve' && a.by === 'owner:pi' && a.channel === 'delegated' && a.key === c.keys.approve, JSON.stringify(a));
      const ev = await call('owed_evidence', { node: 'pub', id: 'ui', files: ['shot.png'], note: 'seen', as: 'owner:pi' });
      assert.notEqual(ev.isError, true, text(ev));
      const e = (await entries(r.cwd)).at(-1)!;
      assert.ok(e.kind === 'evidence' && e.by === 'owner:pi' && e.channel === 'delegated' && e.key === c.keys['evidence:ui'], JSON.stringify(e));
    });
    // Gated: a resubmit while the dialog is open refuses; the pin reaches ops.approve / ops.evidence.
    await withEnv({ ...delegatedEnv, OWED_CONFIRM: 'owner' }, async () => {
      await resubmit();
      const before = await entries(r.cwd), c = await current(), prompts: string[] = [];
      const racing = harness(r.cwd, async (_t, m) => { prompts.push(m); await resubmit(); return true; });
      const ap = await racing('owed_approve', { node: 'pub' });
      assert.equal(ap.isError, true); assert.match(text(ap), /candidate changed since confirmation; nothing recorded/);
      assert.match(prompts[0]!, new RegExp(`Candidate: ${c.commit} \\(submit #${c.seq}\\)`));
      const ev = await racing('owed_evidence', { node: 'pub', id: 'ui', files: ['shot.png'], note: 'seen', as: 'owner:human' });
      assert.equal(ev.isError, true); assert.match(text(ev), /candidate changed since confirmation; nothing recorded/);
      assert.deepEqual((await entries(r.cwd)).filter(e => e.kind !== 'submit'), before.filter(e => e.kind !== 'submit'), 'only the racing submits were recorded');
      const c2 = await current(), ok = await harness(r.cwd, async () => true)('owed_approve', { node: 'pub' });
      assert.notEqual(ok.isError, true, text(ok));
      const a = (await entries(r.cwd)).at(-1)!;
      assert.ok(a.kind === 'review' && a.by === 'owner:human' && a.channel === 'pi-confirm' && a.key === c2.keys.approve);
    });
  } finally { await r.cleanup(); }
});

test('pi delegated path (OWED_CONFIRM unset): owed_waive, owed_adopt, owner owed_review and owed_init record delegated with no dialog', { timeout: 120_000 }, async () => {
  const r = await fixture();
  try {
    await withEnv(delegatedEnv, async () => {
      const call = harness(r.cwd, noDialog);
      const d = await ops.dispatch({ cwd: r.cwd, node: 'a', as: { role: 'parent', id: 'p' } });
      await commitAt(d.worktree, { 'a/x.txt': 'x\n' });
      await ops.submit({ cwd: d.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
      const rev = await call('owed_review', { node: 'a', verdict: 'ok', rank: 3, note: 'looked at the diff', as: 'owner:pi' });
      assert.notEqual(rev.isError, true, text(rev));
      let e = (await entries(r.cwd)).at(-1)!;
      assert.ok(e.kind === 'review' && e.by === 'owner:pi' && e.channel === 'delegated', JSON.stringify(e));
      const w = await call('owed_waive', { node: 'a', obligation: 'writes', reason: 'generated file outside writes is fine' });
      assert.notEqual(w.isError, true, text(w));
      e = (await entries(r.cwd)).at(-1)!;
      assert.ok(e.kind === 'waive' && e.by === 'owner:pi' && e.channel === 'delegated' && e.reason === 'generated file outside writes is fine', JSON.stringify(e));
      assert.match(text(w), /\(delegated\)/);
      assert.match((await ops.why({ cwd: r.cwd, node: 'a' })).items.find(i => i.obligation === 'writes')!.detail, /^writes owner waived: generated file outside writes is fine \(delegated\)$/);
      const head = await commitAt(r.cwd, { 'hotfix.txt': 'h\n' });
      const ad = await call('owed_adopt', { note: 'hotfix reviewed by the main agent' });
      assert.notEqual(ad.isError, true, text(ad));
      e = (await entries(r.cwd)).at(-1)!;
      assert.ok(e.kind === 'adopt' && e.by === 'owner:pi' && e.channel === 'delegated' && e.commit === head, JSON.stringify(e));
    });
    const fresh = await repo();
    try {
      await commitAt(fresh.cwd, { README: 'x\n' });
      await writeFile(join(fresh.cwd, 'plan.json'), plan(1));
      await withEnv(delegatedEnv, async () => {
        const init = await harness(fresh.cwd, noDialog)('owed_init', { plan: 'plan.json' });
        assert.notEqual(init.isError, true, text(init));
      });
      const g = (await entries(fresh.cwd))[0]!;
      assert.ok(g.kind === 'genesis' && g.by === 'owner:pi' && g.channel === 'delegated', JSON.stringify(g));
    } finally { await fresh.cleanup(); }
  } finally { await r.cleanup(); }
});

test('replay: a forged delegated owner plan entry with downgrades and no note is refused (verify fails, status refuses)', { timeout: 60_000 }, async () => {
  const r = await fixture();
  try {
    const genesis = (await entries(r.cwd))[0]!;
    assert.ok(genesis.kind === 'genesis');
    await ops.planSet({ cwd: r.cwd, plan: plan(2), as: { role: 'parent', id: 'p' } });
    const ledger = await Ledger.open(r.cwd), current = (await entries(r.cwd)).at(-1)!;
    assert.ok(current.kind === 'plan');
    // Back from review count 2 to the genesis plan (count 1): a downgrade, appended without the guard.
    await ledger.withLock(() => ledger.append([{ kind: 'plan', by: 'owner:pi', channel: 'delegated', prior: current.plan, plan: genesis.plan, downgrades: [{ node: 'a', what: 'review count lowered' }] }]));
    const v = await ops.verify({ cwd: r.cwd });
    assert.equal(v.ok, false);
    assert.match(v.error ?? '', /Entry #\d+ invalid: .*a delegated owner plan update that reduces obligations requires a note saying why/);
    await assert.rejects(ops.status({ cwd: r.cwd }), /requires a note saying why/);
  } finally { await r.cleanup(); }
});

test('CLI with a TTY (io.ask): an owner command records delegated and never prompts; OWED_CONFIRM=owner prompts again', { timeout: 60_000 }, async () => {
  const r = await fixture(), cwd = process.cwd(), prompts: string[] = [], log: string[] = [];
  const io = (answer: string) => ({ ask: async (q: string) => { prompts.push(q); return answer; }, log: (t: string) => { log.push(t); }, error: (t: string) => { log.push(t); } });
  process.chdir(r.cwd);
  try {
    let code = await withEnv(delegatedEnv, () => main(['rule', 'keep it small', '--nodes', '*', '--as', 'owner:x'], io('no')));
    assert.equal(code, 0, log.join('\n'));
    assert.deepEqual(prompts, [], 'never prompted');
    const e = (await entries(r.cwd)).at(-1)!;
    assert.ok(e.kind === 'rule' && e.by === 'owner:x' && e.channel === 'delegated', JSON.stringify(e));
    const before = await entries(r.cwd);
    code = await withEnv({ ...delegatedEnv, OWED_CONFIRM: 'owner' }, () => main(['rule', 'gated', '--nodes', '*', '--as', 'owner:x'], io('no')));
    assert.equal(code, 1); assert.equal(prompts.length, 1);
    assert.deepEqual(await entries(r.cwd), before);
    code = await withEnv({ ...delegatedEnv, OWED_CONFIRM: 'owner' }, () => main(['rule', 'gated', '--nodes', '*', '--as', 'owner:x'], io('yes')));
    assert.equal(code, 0); assert.equal((await entries(r.cwd)).at(-1)!.channel, 'tty');
  } finally { process.chdir(cwd); await r.cleanup(); }
});

test('report marks delegated acts in the Downgrades and Rulings sections', { timeout: 60_000 }, async () => {
  const r = await fixture();
  try {
    await withEnv(delegatedEnv, async () => {
      const call = harness(r.cwd, noDialog);
      assert.notEqual((await call('owed_plan', { plan: 'eased.json', note: 'not needed' })).isError, true);
      assert.notEqual((await call('owed_rule', { text: 'small commits', nodes: '*', as: 'owner:pi' })).isError, true);
    });
    const all = await entries(r.cwd), p = all.find(e => e.kind === 'plan')!, rule = all.find(e => e.kind === 'rule')!;
    const report = renderReport(await ops.report({ cwd: r.cwd }));
    assert.match(report, new RegExp(`\\nDowngrades ΔO⁻\\n  #${p.seq} owner:pi \\(delegated\\) a: `));
    assert.match(report, new RegExp(`\\nRulings\\n  #${rule.seq} owner:pi \\(delegated\\) \\(all nodes\\): small commits`));
  } finally { await r.cleanup(); }
});
