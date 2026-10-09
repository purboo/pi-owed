import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const cjk = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/;
function english(value: unknown, context: string) {
  assert.doesNotMatch(typeof value === 'string' ? value : JSON.stringify(value), cjk, context);
}
const plan = {
  version: 1, trunk: 'main', closure: [],
  invariants: [{ id: 'health', run: 'test ! -f broken.txt', reads: ['broken.txt'] }],
  nodes: [{ id: 'a', title: 'English fixture', brief: 'Implement the fixture.', writes: ['a.txt'],
    checks: [{ id: 'content', run: 'test "$(cat a.txt)" = good', reads: ['a.txt'] }],
    review: { count: 1, min_rank: 1 } }],
};

test('English CLI output through refusal, failure, repair, review and merge', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    async function call(cwd: string, args: string[], code = 0) {
      const out = await cli(cwd, args);
      english(out.stdout, `${args.join(' ')} stdout`);
      english(out.stderr, `${args.join(' ')} stderr`);
      assert.equal(out.code, code, `${args.join(' ')}: ${out.stderr}\n${out.stdout}`);
      return out.stdout;
    }
    await call(r.cwd, ['status'], 1);
    await call(r.cwd, ['--help']);
    await call(r.cwd, ['status', '--unknown'], 2);
    await r.put('plan.json', JSON.stringify(plan)); await r.commit();
    // Owner confirmation here belongs only to this disposable CLI fixture.
    await call(r.cwd, ['init', 'plan.json', '--i-am-owner']);
    await call(r.cwd, ['status']);
    await call(r.cwd, ['rule', 'Preserve evidence', '--nodes', '*']);
    const packet = await call(r.cwd, ['dispatch', 'a']);
    assert.match(packet, /Allowed writes: a.txt/);
    assert.match(packet, /Applicable rulings:/);
    const worktree = join(r.cwd, '.owed/wt/a-1');
    await commitAt(worktree, { 'a.txt': 'bad\n' });
    await call(worktree, ['submit', 'a']);
    const failed = await call(r.cwd, ['attest', 'a'], 1);
    assert.match(failed, /⛔ blocked/);
    await call(r.cwd, ['why', 'a']);
    await call(r.cwd, ['report']);
    await call(r.cwd, ['merge', 'a'], 1);
    await commitAt(worktree, { 'a.txt': 'good\n' });
    await call(worktree, ['submit', 'a']);
    const repaired = await call(r.cwd, ['attest', 'a'], 1); // Independent review remains owed.
    assert.match(repaired, /✔ measured a\/check:content/);
    await call(r.cwd, ['review', 'a', '--ok', '--rank', '1', '--as', 'reviewer:a#1'], 1);
    await call(r.cwd, ['review', 'a', '--ok', '--rank', '1', '--as', 'reviewer:independent', '--note', 'Inspected changes']);
    await call(r.cwd, ['merge', 'a']);
    await call(r.cwd, ['status', '--json']);
    await call(r.cwd, ['report']);
    await call(r.cwd, ['why', 'a']);
    assert.match(await call(r.cwd, ['verify']), /Ledger verification passed/);
  } finally { await r.cleanup(); }
});

function harness(cwd: string) {
  const tools = new Map<string, ToolDefinition>();
  const commands = new Map<string, Parameters<ExtensionAPI['registerCommand']>[1]>();
  const prompts: string[] = [], notices: string[] = [];
  owed({ registerTool(t: ToolDefinition) { tools.set(t.name, t); }, registerCommand(n, c) { commands.set(n, c); } } as ExtensionAPI);
  const ctx = { cwd, hasUI: true, ui: {
    async confirm(title: string, summary: string) { prompts.push(`${title}\n${summary}`); return false; },
    notify(text: string) { notices.push(text); },
  } } as unknown as ExtensionContext;
  return { tools, commands, prompts, notices, ctx,
    async call(name: string, args: Record<string, unknown> = {}) {
      const out = await tools.get(`owed_${name}`)!.execute('english', args, undefined, undefined, ctx as Parameters<ToolDefinition['execute']>[4]);
      english(out, `owed_${name} output`);
      return out;
    },
  };
}

test('English extension descriptions, output, slash command and owner confirmation summaries', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    const h = harness(r.cwd);
    assert.equal(h.tools.size, 12);
    for (const tool of h.tools.values()) english({ name: tool.name, label: tool.label, description: tool.description, parameters: tool.parameters }, 'tool metadata');
    for (const command of h.commands.values()) english(command.description, 'command description');
    assert.equal((await h.call('status')).isError, true);
    await r.put('plan.json', JSON.stringify(plan)); await r.commit();
    const initialized = await cli(r.cwd, ['init', 'plan.json', '--i-am-owner']);
    assert.equal(initialized.code, 0, initialized.stderr);
    english(initialized.stdout + initialized.stderr, 'fixture initialization');
    await h.call('status'); await h.call('why', { node: 'a' });
    assert.equal((await h.call('why', { node: 'missing' })).isError, true);
    const dispatched = await h.call('dispatch', { node: 'a' });
    assert.notEqual(dispatched.isError, true);
    const { worktree } = dispatched.details as { worktree: string };
    await commitAt(worktree, { 'a.txt': 'good\n' });
    assert.notEqual((await harness(worktree).call('submit', { node: 'a' })).isError, true);
    await h.call('attest', { node: 'a' });
    await h.call('why', { node: 'a' }); await h.call('report');
    const command = h.commands.get('owed')!;
    for (const args of ['', 'why a', 'invalid']) await command.handler(args, h.ctx as Parameters<typeof command.handler>[1]);
    assert.equal(h.notices.length, 3);
    english(h.notices, '/owed notifications');

    const weaker = structuredClone(plan); weaker.nodes[0]!.review.count = 0;
    await r.put('weaker.json', JSON.stringify(weaker));
    const confirmations: [string, Record<string, unknown>][] = [
      ['dispatch', { node: 'a' }], ['submit', { node: 'a' }],
      ['review', { node: 'a', verdict: 'ok', rank: 3, note: 'Owner review' }],
      ['merge', { node: 'a' }], ['rule', { nodes: '*', text: 'Owner ruling' }],
      ['plan', { plan: 'weaker.json' }],
      ['waive', { node: 'a', obligation: 'review', reason: 'Accept missing review', accept_risk: [] }],
      ['defer', { node: 'a', items: ['health'], reason: 'Repair later' }],
    ];
    for (const [name, args] of confirmations) {
      const before = h.prompts.length;
      assert.equal((await h.call(name, { ...args, as: 'owner:human' })).isError, true);
      assert.equal(h.prompts.length, before + 1, `${name} must show its confirmation summary`);
      english(h.prompts.at(-1), `${name} confirmation`);
    }
    h.ctx.hasUI = false;
    assert.equal((await h.call('waive', { node: 'a', obligation: 'review', reason: 'No UI' })).isError, true);
  } finally { await r.cleanup(); }
});

test('English shipped source, skill, README and documentation', async () => {
  async function scan(relative: string): Promise<void> {
    const url = new URL(`../${relative}`, import.meta.url);
    for (const entry of await readdir(url, { withFileTypes: true })) {
      const path = `${relative}/${entry.name}`;
      if (entry.isDirectory()) await scan(path);
      else if (/\.(md|ts)$/.test(entry.name)) english(await readFile(new URL(`../${path}`, import.meta.url), 'utf8'), path);
    }
  }
  for (const directory of ['src', 'skills', 'docs']) await scan(directory);
  english(await readFile(new URL('../README.md', import.meta.url), 'utf8'), 'README.md');
});
