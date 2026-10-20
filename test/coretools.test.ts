import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';
import * as ops from '../src/ops.ts';
import { askingText } from '../src/drive.ts';
import { readyHintText } from '../src/needs.ts';
import { repo } from './helpers/repo.ts';
import type { LaunchEntry, RunQuestion } from '../src/types.ts';

const core = ['status', 'why', 'decide', 'drive', 'start', 'submit', 'review'].map(n => `owed_${n}`);
async function withHost(run: (h: ReturnType<typeof host>) => Promise<void>, options: Parameters<typeof host>[0] = {}) {
  const prior = { OWED_TOOLS: process.env.OWED_TOOLS, DSA_CALL: process.env.DSA_CALL };
  if (options.all) process.env.OWED_TOOLS = 'all'; else delete process.env.OWED_TOOLS;
  process.env.DSA_CALL = 'coretools-fixture';
  const h = host(options);
  try { await run(h); } finally {
    await h.emit('session_shutdown');
    for (const [k, v] of Object.entries(prior)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  }
}
function host(options: { all?: boolean; api?: 'missing-get' | 'missing-set' | 'throw-get' | 'throw-set'; search?: boolean } = {}) {
  const tools = new Map<string, ToolDefinition>(), handlers = new Map<string, (e: unknown, ctx: ExtensionContext) => unknown>();
  let active = ['read', 'bash', 'custom_tool', 'tool_search'], writes = 0;
  const api: Record<string, unknown> = {
    registerTool(t: ToolDefinition) { tools.set(t.name, t); }, registerCommand() {}, sendMessage() {},
    on(name: string, h: (e: unknown, ctx: ExtensionContext) => unknown) { handlers.set(name, h); },
    getAllTools() { return [...tools.values(), ...(options.search === false ? [] : [{ name: 'tool_search', reachesTools: true, exposure: 'direct' }])]; },
    getActiveTools() { if (options.api === 'throw-get') throw new Error('unbound'); return [...active]; },
    setActiveTools(names: string[]) { if (options.api === 'throw-set') throw new Error('unbound'); writes++; active = [...names]; },
  };
  if (options.api === 'missing-get') delete api.getActiveTools;
  if (options.api === 'missing-set') delete api.setActiveTools;
  owed(api as unknown as ExtensionAPI);
  const ctx = { cwd: '/tmp', hasUI: false, isIdle: () => true, ui: { notify() {} } } as unknown as ExtensionContext;
  return { tools, get active() { return active; }, get writes() { return writes; }, setActive(names: string[]) { active = [...names]; },
    async emit(name: string) { await handlers.get(name)?.({}, ctx); },
    async call(name: string, args: object) { return tools.get(`owed_${name}`)!.execute('test', args, undefined, undefined, ctx as Parameters<ToolDefinition['execute']>[4]); },
  };
}

for (const event of ['session_start', 'agent_start']) test(`CT1 ${event} restores every missing direct tool without removing other tools`, async () => {
  await withHost(async h => {
    const before = [...h.active, 'owed_status', 'owed_answer']; h.setActive(before);
    await h.emit(event);
    assert.deepEqual(h.active.slice(0, before.length), before);
    assert.deepEqual(h.active.slice(before.length).sort(), core.filter(n => !before.includes(n)).sort());
    assert.ok(h.active.includes('owed_decide'));
    assert.ok(!h.active.includes('owed_plan'), 'deferred tools remain deferred');
    const writes = h.writes;
    await h.emit(event); assert.equal(h.writes, writes, 'already active: no setter call');
    h.setActive(h.active.filter(n => n !== 'owed_decide'));
    await h.emit(event); assert.ok(h.active.includes('owed_decide'), 'later host loss is repaired too');
  });
});

test('CT1 all-tools profile restores all registered direct tools at agent_start', async () => {
  await withHost(async h => {
    const before = [...h.active]; await h.emit('agent_start');
    assert.deepEqual(h.active, [...before, ...h.tools.keys()]);
    assert.ok(h.active.includes('owed_plan')); assert.ok(h.active.includes('owed_check_try'));
  }, { all: true });
});

for (const api of ['missing-get', 'missing-set', 'throw-get', 'throw-set'] as const) test(`CT1 host ${api} is left alone without throwing`, async () => {
  await withHost(async h => {
    const before = [...h.active]; await h.emit('session_start'); await h.emit('agent_start');
    assert.deepEqual(h.active, before); assert.equal(h.writes, 0);
  }, { all: true, api });
});

test('CT1 session fallback direct registrations are restored on later agent_start', async () => {
  await withHost(async h => {
    await h.emit('session_start');
    assert.ok([...h.tools.values()].every(t => t.exposure === 'direct'));
    h.setActive(['read', 'bash']); await h.emit('agent_start');
    assert.deepEqual(h.active, ['read', 'bash', ...h.tools.keys()]);
  }, { search: false });
});

test('CT2 every deferred description ends with its CLI command; core keeps its discovery sentence', async () => {
  await withHost(async h => {
    for (const t of h.tools.values()) {
      if (t.exposure === 'deferred') assert.ok(t.description.endsWith(` If this tool is not declared, use the owed CLI: owed ${t.name.slice(5).replaceAll('_', ' ')} (owed help).`), t.name);
      else assert.ok(t.description.endsWith(' Other owed operations are owed_* tools: load any that are not declared with tool_search, or use the owed <command> CLI (owed help).'), t.name);
    }
    assert.match(h.tools.get('owed_check_try')!.description, /owed check try \(owed help\)\.$/);
    for (const [name, references] of Object.entries({ resume: ['rule'], decide: ['amend', 'resume'], edit: ['plan'], amend: ['plan'], init: ['status'] })) {
      for (const ref of references) assert.ok(h.tools.get(`owed_${name}`)!.description.includes(`owed_${ref} (CLI: owed ${ref})`));
    }
  });
});

test('CT3 ready need includes the executable CLI start form and leaves CLI text unchanged', () => {
  assert.equal(readyHintText(['a'], 'pi'), 'ready: a (1); no driver is running: owed_drive {action:"start", stay:true} (CLI: owed drive --detach --stay)');
  assert.equal(readyHintText(['a'], 'cli'), 'ready: a (1); no driver is running: owed drive --detach --stay');
});

test('CT3 plain/structured single/multiple-question wakes pair tool selectors with CLI selectors', () => {
  for (const structured of [false, true]) for (const count of [1, 2]) {
    const questions: RunQuestion[] = Array.from({ length: count }, (_, i) => ({ qid: `q${i}`, rev: 1, question: 'Choose scope', ...(structured ? { decision_needed: 'Choose scope', options: [{ label: 'Narrow' }] } : {}) }));
    const text = askingText('a', { rid: 'run1', role: 'writer' } as LaunchEntry, { rid: 'run1', state: 'asking', questions });
    if (count === 1) { assert.ok(text.includes('owed_decide {nodes:["a"]')); assert.ok(text.includes('owed decide a --text "<text>"')); }
    else for (const q of questions) { assert.ok(text.includes(`owed_answer {node:"a", rid:"run1", qid:"${q.qid}"`)); assert.ok(text.includes(`owed answer a --rid run1 --qid ${q.qid} "<text>"`)); }
  }
});

test('CT3 initialization reply offers CLI status while genesis attest runs', async () => {
  const r = await repo();
  try {
    const plan = JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [{ id: 'unit', run: 'true', reads: [] }], nodes: [{ id: 'a', writes: ['a.txt'], checks: [], review: { count: 0, min_rank: 1 } }] });
    await r.put('plan.json', plan); await r.commit();
    await withHost(async h => {
      delete process.env.DSA_CALL;
      const result = await h.call('init', { cwd: r.cwd, plan: 'plan.json', lease: false });
      try {
        assert.notEqual(result.isError, true, JSON.stringify(result));
        assert.match(result.content.map(c => c.type === 'text' ? c.text : '').join('\n'), /owed_status \(CLI: owed status\) shows progress/);
        assert.equal((await ops.status({ cwd: r.cwd })).trunk.name, 'main');
      } finally {
        // Observe the worker's real lifecycle before removing its ledger, including on the red run.
        const deadline = Date.now() + 10_000;
        for (;;) {
          const status = await h.call('status', { cwd: r.cwd });
          if (!(status.details as { genesis?: { measuring?: boolean } }).genesis?.measuring) break;
          assert.ok(Date.now() < deadline, 'genesis attest settled before fixture cleanup');
          await new Promise(resolve => setTimeout(resolve, 20));
        }
      }
    });
  } finally { await r.cleanup(); }
});
