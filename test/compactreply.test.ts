import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';
import * as ops from '../src/ops.ts';
import * as views from '../src/views.ts';
import { Ledger } from '../src/ledger.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

delete process.env.OWED_CONFIRM;
const parent = { role: 'parent', id: 'test' } as const;
const owner = { role: 'owner', id: 'pi' } as const;
const detailsLine = 'Details: owed status · owed why <node>';
type Result = Awaited<ReturnType<ToolDefinition['execute']>> & { isError?: boolean };
const text = (r: Result) => r.content.map(c => c.type === 'text' ? c.text : '').join('\n');
function harness(cwd: string) {
  const tools = new Map<string, ToolDefinition>(), handlers = new Map<string, (...args: any[]) => any>();
  owed({ registerTool(t: ToolDefinition) { tools.set(t.name, t); }, registerCommand() {},
    on(name: string, handler: (...args: any[]) => any) { handlers.set(name, handler); }, sendMessage() {} } as unknown as ExtensionAPI);
  const ctx = { cwd, hasUI: false, isIdle: () => true, ui: { notify() {} } } as unknown as Parameters<ToolDefinition['execute']>[4];
  return {
    async call(name: string, args: object = {}) {
      const r = await tools.get(`owed_${name}`)!.execute('compactreply', args, undefined, undefined, ctx) as Result;
      assert.notEqual(r.isError, true, text(r));
      return r;
    },
    async close() { await handlers.get('session_shutdown')?.({}, ctx); },
  };
}
async function fixture(invariants: object[] = []) {
  const r = await repo();
  const plan = { version: 1, trunk: 'main', closure: [], invariants,
    nodes: ['a', 'b'].map(id => ({ id, writes: [`${id}.txt`], checks: [] as { id: string; run: string; reads: string[] }[], review: { count: 1, min_rank: 1 } })) };
  const file = join(r.root, 'plan.json');
  await r.put('README', 'compact reply fixture\n'); await r.commit();
  await writeFile(file, JSON.stringify(plan));
  await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify(plan) });
  await ops.planSet({ cwd: r.cwd, as: parent, ...await ops.readPlan({ cwd: r.cwd, path: file }) });
  const h = harness(r.cwd);
  return { ...r, file, plan, h, async cleanup() { await h.close(); await r.cleanup(); } };
}
async function submitted(r: Awaited<ReturnType<typeof fixture>>) {
  const d = await ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' });
  await commitAt(d.worktree, { 'a.txt': 'done\n' });
  const entry = await ops.submit({ cwd: d.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
  assert.ok(entry.kind === 'submit');
  return entry;
}
function compact(value: string) {
  assert.match(value, /(?:^|\n)owed: .* merged · .* in progress · .* need you · trunk main /);
  assert.doesNotMatch(value, /In progress \(|\nDebt:|Escapes \(all time\)|Untested changes:|Untested obligations ΔO⁻:|owner flag weak confirmation:/);
  assert.ok(value.includes(detailsLine), value);
}
function view(): views.StatusView {
  return { trunk: { name: 'main', commit: '0123456789abcdef', tree: 'fixture-tree', seq: 0, invKeys: {} },
    nodes: {}, groups: { merged: ['done'] }, ready: [], mergeQueue: [], pending: {},
    invariants: [], ownerFlags: [], overlaps: {}, halted: [], launches: {},
    summary: { merged: 1, needs: [], progress: [{ node: 'writer', phase: 'writing', ageMs: 1000 }], debt: ['private debt'] } };
}

test('CR1 brief without needs contains only the existing summary line and details link', () => {
  const v = view(), before = structuredClone(v), value = views.renderStatusBrief(v);
  assert.equal(value, `${views.renderStatus(v).split('\n')[0]}\n${detailsLine}`);
  compact(value); assert.deepEqual(v, before, 'rendering changes no structured state');
  assert.match(views.renderStatus(v), /In progress \(1\):[\s\S]*Debt:/);
});

test('CR1 brief retains every Needs you item and command with the existing invariant counts', () => {
  const v = view();
  v.summary!.needs = [{ node: 'a', reason: 'ready to dispatch', command: 'owed dispatch a' },
    { node: 'b', reason: 'needs a parent ruling: choose behavior', command: 'owed rule --nodes b "<decision>"' }];
  v.invariants = [{ subject: 'trunk', obligation: 'inv:health', key: 'k', status: 'D', mark: '⊥', detail: 'awaiting observation', evidence: [], discharger: 'parent' }];
  const value = views.renderStatusBrief(v), normal = views.renderStatus(v);
  assert.equal(value, `${normal.split('\n').slice(0, 4).join('\n')}\n${detailsLine}`);
  assert.match(value, /2 need you .* ✘ invariants \(0\/1\)/); compact(value);
});

test('CR2 dispatch preserves the packet and subagent arguments and appends a brief', async () => {
  const r = await fixture();
  try {
    const reply = await r.h.call('dispatch', { node: 'a' });
    const d = reply.details as { worktree: string; packet?: string; subagents: object };
    assert.equal(d.packet, undefined);
    assert.deepEqual(d.subagents, { agent: 'worker', cwd: d.worktree, isolation: 'none' });
    const ledger = await Ledger.open(r.cwd), entry = (await ledger.read()).findLast(e => e.kind === 'dispatch' && e.node === 'a');
    assert.ok(entry?.kind === 'dispatch');
    const packet = (await ledger.getBlob(entry.packet)).toString('utf8');
    assert.equal(text(reply).slice(0, packet.length), packet, 'packet matches the independently stored dispatch blob');
    assert.ok(text(reply).startsWith(`${packet}\n\nsubagents: `));
    assert.deepEqual(JSON.parse(text(reply).split('\n\nsubagents: ')[1]!.split('\n')[0]!), { ...d.subagents, task: '<the complete packet above>' });
    const suffix = text(reply).slice(text(reply).indexOf('\nsubagents:'));
    compact(suffix); assert.ok(text(reply).endsWith(detailsLine));
  } finally { await r.cleanup(); }
});

test('CR2 plan and amend preserve carried candidates and act lines without progress lists; edit adds a brief', async () => {
  const r = await fixture();
  try {
    const sub = await submitted(r);
    const next = structuredClone(r.plan);
    next.nodes[0]!.checks = [{ id: 'extra', run: 'true', reads: ['a.txt'] }];
    await writeFile(r.file, JSON.stringify(next));
    const planned = await r.h.call('plan', { plan: r.file });
    const p = planned.details as { seq: number; carried?: unknown; carriedCount: number; warnings: string[] };
    assert.equal(p.carried, undefined); assert.equal(p.carriedCount, 1);
    const carried = (await (await Ledger.open(r.cwd)).read()).find(e => e.kind === 'submit' && e.carry === sub.seq && e.seq > p.seq)!;
    assert.equal(carried.kind, 'submit');
    assert.ok(text(planned).includes(views.carryLine(carried)));
    compact(text(planned)); assert.match(text(planned), new RegExp(`submit #${sub.seq}`));
    // UX3: the plan output keeps the details line and ends with the recorded plan receipt.
    assert.ok(text(planned).includes(detailsLine));
    assert.match(text(planned), /recorded plan #\d+ blob [0-9a-f]{64} file sha256 [0-9a-f]{64}$/);
    for (const warning of p.warnings) assert.ok(text(planned).includes(warning));
    const amended = await r.h.call('amend', { node: 'a', writes: ['+extra.txt'], note: 'Only the extra fixture file' });
    const a = amended.details as Awaited<ReturnType<typeof ops.amend>>;
    const es = await (await Ledger.open(r.cwd)).read();
    const complete = { ...a, plan: es.find(e => e.seq === a.plan?.seq), rule: es.find(e => e.seq === a.rule?.seq), carried: es.filter(e => e.kind === 'submit' && e.seq > a.plan!.seq && e.seq < a.rule!.seq) } as Awaited<ReturnType<typeof ops.amend>>;
    assert.ok(text(amended).startsWith(views.amendLines(complete).join('\n')));
    assert.ok(a.plan, 'a real widening records a plan');
    assert.equal(a.plan.by, 'owner:pi'); compact(text(amended)); assert.ok(text(amended).includes(detailsLine));
    assert.match(text(amended), /recorded plan #\d+ blob [0-9a-f]{64} file sha256 [0-9a-f]{64}$/);
    const edited = await r.h.call('edit', { node: 'b', set: ['title=Updated'], note: 'Clarify the title' });
    const e = edited.details as ops.EditResult;
    const editEntry = (await (await Ledger.open(r.cwd)).read()).find(x => x.seq === e.plan.seq)!;
    assert.ok(text(edited).startsWith(views.renderEntry(editEntry)));
    assert.ok(text(edited).includes(`Wrote ${e.path}`)); compact(text(edited)); assert.ok(text(edited).includes(detailsLine));
    assert.match(text(edited), /recorded plan #\d+ blob [0-9a-f]{64} file sha256 [0-9a-f]{64}$/);
    const preview = await r.h.call('edit', { node: 'b', set: ['title=Preview'], note: 'Preview only', dry_run: true });
    assert.match(text(preview), /Downgrades:/); assert.doesNotMatch(text(preview), /Details: owed status/);
  } finally { await r.cleanup(); }
});

test('CR2 rule shows only its receipt and delivery notices while report keeps the full escape section', async () => {
  const r = await fixture();
  try {
    await submitted(r);
    const reply = await r.h.call('rule', { text: 'Keep the interface.', nodes: ['a'] });
    const entry = reply.details as Awaited<ReturnType<typeof ops.rule>>;
    assert.equal(text(reply).split('\n')[0], `Recorded #${entry.seq} ruling (a); delivered 0/2`);
    assert.doesNotMatch(text(reply), /Keep the interface\.|Details: owed status|owed:/);
    assert.match(text(await r.h.call('report')), /Escapes \(all time\)/);
    assert.match(text(await r.h.call('status')), /In progress \(1\):/);
    assert.match(text(await r.h.call('status', { full: true })), /Pending reviewer:/);
    assert.match(text(await r.h.call('why', { node: 'a', full: true })), /Untested changes:/);
  } finally { await r.cleanup(); }
});

test('CR2 defer shows its recorded entry and brief without a debt list and preserves the entry data', async () => {
  const r = await fixture([{ id: 'health', run: 'true', reads: ['a.txt'] }]);
  try {
    await submitted(r);
    const reply = await r.h.call('defer', { node: 'a', items: ['health'], reason: 'Accept fixture debt temporarily' });
    const entry = reply.details as Awaited<ReturnType<typeof ops.defer>>;
    assert.equal(entry.kind, 'defer'); assert.equal(entry.items[0]!.id, 'health');
    assert.equal(text(reply).split('\n')[0], views.renderEntry((await (await Ledger.open(r.cwd)).read()).find(e => e.seq === entry.seq)!)); compact(text(reply));
    assert.ok(text(reply).endsWith(detailsLine));
    assert.match(text(await r.h.call('status')), /Debt:[\s\S]*owner defer/);
  } finally { await r.cleanup(); }
});

test('CR2 resume keeps waits-for and phase lines, abandon keeps entry and phase; neither appends a full receipt', async () => {
  const r = await fixture();
  try {
    await submitted(r);
    const resumed = await r.h.call('resume', { node: 'a', after: ['b'], note: 'Wait for the fix' });
    const e = resumed.details as Awaited<ReturnType<typeof ops.resume>>['entry'];
    const phase = views.renderReceipt(await ops.why({ cwd: r.cwd, node: 'a' })).split('\n')[0];
    assert.equal(text(resumed).split('\n')[0], views.renderEntry((await (await Ledger.open(r.cwd)).read()).find(x => x.seq === e.seq)!));
    assert.ok(text(resumed).includes(`a waits for b (resume #${e.seq}); the driver acts again when b merges\n${phase}\n`));
    compact(text(resumed)); assert.ok(text(resumed).endsWith(detailsLine));
    const abandoned = await r.h.call('abandon', { node: 'a', hold: true, note: 'Park this attempt' });
    const a = abandoned.details as Awaited<ReturnType<typeof ops.abandon>>;
    assert.equal(text(abandoned).split('\n')[0], views.renderEntry((await (await Ledger.open(r.cwd)).read()).find(e => e.seq === a.seq)!));
    assert.equal(text(abandoned).split('\n')[1], views.renderReceipt(await ops.why({ cwd: r.cwd, node: 'a' })).split('\n')[0]);
    compact(text(abandoned)); assert.match(text(abandoned), /\na: held\n/);
    const released = await r.h.call('resume', { node: 'a' });
    assert.match(text(released), /released abandon hold of a/); compact(text(released));
    const ledger = await Ledger.open(r.cwd), before = (await ledger.read()).length;
    const refused = await cli(r.cwd, ['resume', 'missing']);
    assert.equal(refused.code, 1); assert.match(refused.stderr, /does not exist/);
    assert.equal((await ledger.read()).length, before, 'a refusal records nothing');
  } finally { await r.cleanup(); }
});

test('CR2 CLI status still returns the full progress list and the same JSON for --full', async () => {
  const r = await fixture();
  try {
    await submitted(r);
    const status = await cli(r.cwd, ['status']), full = await cli(r.cwd, ['status', '--full']);
    assert.equal(status.code, 0, status.stderr); assert.equal(full.code, 0, full.stderr);
    assert.match(status.stdout, /In progress \(1\):/); assert.match(full.stdout, /Pending reviewer:/);
    const plainJson = await cli(r.cwd, ['status', '--json']), fullJson = await cli(r.cwd, ['status', '--full', '--json']);
    assert.equal(plainJson.code, 0, plainJson.stderr); assert.equal(fullJson.code, 0, fullJson.stderr);
    const a = JSON.parse(plainJson.stdout), b = JSON.parse(fullJson.stdout);
    for (const value of [a, b]) for (const item of value.summary.progress) item.ageMs = 0;
    assert.deepEqual(a, b);
  } finally { await r.cleanup(); }
});
