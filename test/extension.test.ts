import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';
import { Ledger } from '../src/ledger.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';
// D25.4: these tests exercise the owner confirmation (dialog or TTY prompt), now the opt-in gate OWED_CONFIRM=owner.
process.env.OWED_CONFIRM = 'owner';

function harness(cwd: string, confirm: boolean | undefined = true) {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, Parameters<ExtensionAPI['registerCommand']>[1]>();
  const prompts: string[] = [], notices: string[] = [];
  owed({ registerTool(t: ToolDefinition) { tools.set(t.name, t); }, registerCommand(n, c) { commands.set(n, c); } } as ExtensionAPI);
  const ctx = { cwd, hasUI: confirm !== undefined, ui: { async confirm(title: string, message: string) { prompts.push(`${title}\n${message}`); return confirm; }, notify(text: string) { notices.push(text); } } } as unknown as ExtensionContext;
  return { tools, commands, prompts, notices, ctx, async call(name: string, args: Record<string, unknown> = {}) { return tools.get(`owed_${name}`)!.execute('test', args, undefined, undefined, ctx as Parameters<ToolDefinition['execute']>[4]); } };
}
const plan = JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [], nodes: [{ id: 'a', writes: ['a.txt'], checks: [], review: { count: 1, min_rank: 1 } }] });
async function fixture() {
  const r = await repo();
  await r.put('plan.json', plan); await r.commit();
  const init = await cli(r.cwd, ['init', 'plan.json', '--i-am-owner']); assert.equal(init.code, 0, init.stderr);
  return r;
}

test('registers direct typed tools and command; status uses ctx.cwd; guards become tool errors', async () => {
  const r = await fixture();
  try {
    const h = harness(r.cwd);
    for (const name of ['status', 'why', 'report', 'dispatch', 'submit', 'attest', 'review', 'merge', 'rule', 'plan', 'waive', 'defer']) assert.ok(h.tools.has(`owed_${name}`), `includes owed_${name}`);
    for (const t of h.tools.values()) { assert.equal(t.exposure, 'direct'); assert.equal((t.parameters as { type?: string }).type, 'object'); }
    const status = await h.call('status'); assert.match(JSON.stringify(status.content), /Trunk main/); assert.ok(status.details);
    const missing = await h.call('why', { node: 'missing' }); assert.equal(missing.isError, true); assert.match(JSON.stringify(missing.content), /does not exist/);
    const command = h.commands.get('owed')!;
    await command.handler('', h.ctx as Parameters<typeof command.handler>[1]); assert.match(h.notices[0]!, /Trunk main/);
    await command.handler('why a', h.ctx as Parameters<typeof command.handler>[1]); assert.match(h.notices[1]!, /a: /);
  } finally { await r.cleanup(); }
});

test('dispatch packet, slot writer inference, explicit reviewer and owner confirmation paths', async () => {
  const r = await fixture();
  try {
    const h = harness(r.cwd), d = await h.call('dispatch', { node: 'a' });
    const packet = d.details as { packet: string; worktree: string; subagents: unknown };
    assert.deepEqual(packet.subagents, { agent: 'worker', cwd: packet.worktree, task: packet.packet, isolation: 'none' });
    await commitAt(packet.worktree, { 'a.txt': 'done\n' });
    assert.equal((await h.call('submit', { node: 'a' })).isError, true, 'parent does not silently impersonate writer');
    assert.notEqual((await harness(packet.worktree).call('submit', { node: 'a' })).isError, true);
    assert.equal((await h.call('review', { node: 'a', verdict: 'ok', rank: 1, note: '' })).isError, true);
    const args = { node: 'a', obligation: 'review', reason: 'Human accepts the risk of missing independent review' };
    const ledger = await Ledger.open(r.cwd), before = (await ledger.read()).length;
    for (const confirmation of [false, undefined]) {
      const denied = confirmation === undefined ? harness(r.cwd, true) : harness(r.cwd, confirmation);
      if (confirmation === undefined) denied.ctx.hasUI = false;
      const response = await denied.call('waive', args);
      assert.equal(response.isError, true); assert.equal((await ledger.read()).length, before);
      assert.equal(denied.prompts.length, confirmation === false ? 1 : 0);
    }
    assert.equal((await h.call('waive', { ...args, as: 'parent:pi' })).isError, true);
    const waived = await h.call('waive', args); assert.notEqual(waived.isError, true);
    const entry = (await ledger.read()).at(-1)!;
    assert.equal(entry.kind, 'waive'); assert.equal(entry.channel, 'pi-confirm'); assert.equal(entry.by, 'owner:human');
    assert.match(h.prompts[0]!, /a\/review/); assert.match(h.prompts[0]!, /Human accepts/); assert.match(JSON.stringify(waived.content), /waived/);
  } finally { await r.cleanup(); }
});

test('plan strengthening needs no UI; downgrade requires confirmed owner and records channel', async () => {
  const r = await fixture();
  try {
    const stronger = JSON.parse(plan); stronger.nodes[0].review.count = 2;
    await r.put('strong.json', JSON.stringify(stronger));
    const h = harness(r.cwd); h.ctx.hasUI = false;
    assert.notEqual((await h.call('plan', { plan: 'strong.json' })).isError, true);
    const ledger = await Ledger.open(r.cwd), before = (await ledger.read()).length;
    assert.equal((await h.call('plan', { plan: 'plan.json' })).isError, true);
    assert.equal((await harness(r.cwd, false).call('plan', { plan: 'plan.json' })).isError, true);
    assert.equal((await ledger.read()).length, before);
    const allowed = harness(r.cwd);
    assert.notEqual((await allowed.call('plan', { plan: 'plan.json' })).isError, true);
    assert.match(allowed.prompts[0]!, /Downgraded/); assert.equal((await ledger.read()).at(-1)!.channel, 'pi-confirm');
  } finally { await r.cleanup(); }
});

test('defer binds confirmed decisions to prospective invariant keys and refuses invalid requests', async () => {
  const r = await repo();
  try {
    const withInvariant = JSON.parse(plan);
    withInvariant.invariants = [{ id: 'health', run: 'test ! -f a.txt', reads: ['a.txt'] }];
    await r.put('plan.json', JSON.stringify(withInvariant)); await r.commit();
    assert.equal((await cli(r.cwd, ['init', 'plan.json', '--i-am-owner'])).code, 0);
    const h = harness(r.cwd);
    const dispatched = (await h.call('dispatch', { node: 'a' })).details as { worktree: string };
    await commitAt(dispatched.worktree, { 'a.txt': 'new invariant debt\n' });
    await harness(dispatched.worktree).call('submit', { node: 'a' });
    const args = { node: 'a', items: ['health'], reason: 'Temporarily accept health check debt' };
    const ledger = await Ledger.open(r.cwd), before = (await ledger.read()).length;
    const noUI = harness(r.cwd); noUI.ctx.hasUI = false;
    assert.equal((await noUI.call('defer', args)).isError, true);
    assert.equal((await harness(r.cwd, false).call('defer', args)).isError, true);
    assert.equal((await h.call('defer', { ...args, items: ['unknown'] })).isError, true);
    assert.equal((await ledger.read()).length, before);
    assert.notEqual((await h.call('defer', args)).isError, true);
    const entry = (await ledger.read()).at(-1)!;
    assert.equal(entry.kind, 'defer'); assert.equal(entry.channel, 'pi-confirm');
    if (entry.kind !== 'defer') assert.fail('expected defer');
    assert.match(entry.items[0]!.key, /^[a-f0-9]{64}$/);
    assert.match(h.prompts[0]!, /health/); assert.match(h.prompts[0]!, /remain debt/);
    assert.notEqual((await h.call('attest', { node: 'a' })).isError, true);
    assert.notEqual((await h.call('review', { node: 'a', as: 'reviewer:independent', rank: 1, verdict: 'ok', note: 'independent review' })).isError, true);
    const merged = await h.call('merge', { node: 'a' }); assert.notEqual(merged.isError, true);
    const status = await h.call('status'); assert.match(JSON.stringify(status.content), /deferred/);
    assert.match(JSON.stringify((await h.call('report')).content), /Merges/);
  } finally { await r.cleanup(); }
});

test('README quickstart runs from sample plan through merge and verification', async () => {
  const r = await repo();
  try {
    const sample = await readFile(new URL('../examples/plan.yaml', import.meta.url), 'utf8');
    const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
    assert.ok(readme.includes(sample.trim()), 'README plan equals runnable example');
    await r.put('plan.yaml', sample); await r.commit();
    for (const args of [['init', 'plan.yaml', '--i-am-owner'], ['status'], ['dispatch', 'greeting']]) {
      const out = await cli(r.cwd, args); assert.equal(out.code, 0, out.stderr);
    }
    const worktree = join(r.cwd, '.owed/wt/greeting-1');
    await commitAt(worktree, { 'hello.txt': 'hello\n' });
    assert.equal((await cli(worktree, ['submit', 'greeting'])).code, 0);
    const attested = await cli(r.cwd, ['attest', 'greeting']); assert.equal(attested.code, 1); assert.match(attested.stdout, /measured/);
    for (const args of [['why', 'greeting'], ['review', 'greeting', '--ok', '--rank', '1', '--as', 'reviewer:demo-reviewer', '--note', 'Inspected greeting and acceptance evidence'], ['merge', 'greeting'], ['report'], ['verify']]) {
      const out = await cli(r.cwd, args); assert.equal(out.code, 0, out.stderr);
    }
    assert.equal(await readFile(join(r.cwd, 'hello.txt'), 'utf8'), 'hello\n');
  } finally { await r.cleanup(); }
});
