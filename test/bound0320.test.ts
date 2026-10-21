import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';
import * as transport from '../src/ext-worker.ts';
const { toolWorker, boundToolResult, compactToolDetails, utf8Head, versionNotice, restartLine } = transport;
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { renderStatus, renderWhy } from '../src/views.ts';
import { repo } from './helpers/repo.ts';

const CONTENT = 48 * 1024, DETAILS = 8 * 1024;
const owner = { role: 'owner', id: 'pi' } as const;
type Result = Awaited<ReturnType<ToolDefinition['execute']>> & { isError?: boolean };
const text = (r: Result) => r.content.map(c => c.type === 'text' ? c.text : '').join('\n');
function bounded(r: Result) {
  assert.ok(Buffer.byteLength(text(r)) <= CONTENT, `content: ${Buffer.byteLength(text(r))} bytes`);
  assert.ok(Buffer.byteLength(JSON.stringify(r.details)) <= DETAILS, `details: ${Buffer.byteLength(JSON.stringify(r.details))} bytes`);
  assert.doesNotMatch(text(r), /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u);
}
function cut(r: Result, command?: string) {
  bounded(r);
  const last = text(r).split('\n').at(-1)!;
  assert.match(last, /\d+ bytes omitted/);
  assert.ok(Buffer.byteLength(last) <= 1024, 'footer is short');
  if (command) assert.ok(last.includes(command), last);
}
function harness(cwd: string) {
  const tools = new Map<string, ToolDefinition>(), handlers = new Map<string, any>();
  owed({ registerTool(t: ToolDefinition) { tools.set(t.name, t); }, registerCommand() {},
    on(n: string, h: unknown) { handlers.set(n, h); }, sendMessage() {} } as unknown as ExtensionAPI);
  const ctx = { cwd, hasUI: false, isIdle: () => true, ui: { notify() {} } } as unknown as Parameters<ToolDefinition['execute']>[4];
  return { tools, call: async (name: string, args: object = {}) => await tools.get(`owed_${name}`)!.execute('bound0320', args, undefined, undefined, ctx) as Result,
    close: () => handlers.get('session_shutdown')?.({}, ctx) };
}
async function cli(cwd: string, args: string[]) {
  return promisify(execFile)(process.execPath, [fileURLToPath(new URL('../bin/owed.js', import.meta.url)), ...args],
    { cwd, timeout: 60_000, maxBuffer: 32 * 1024 * 1024 });
}
async function fixture() {
  const r = await repo();
  // Hundreds of large IDs make even default status/plan warnings exceed the text bound.
  // Unicode in the 2 MiB plan and the ruling exercises byte, not JS-length, clipping.
  const ids = Array.from({ length: 300 }, (_, i) => `n${i}-${'x'.repeat(190)}`);
  const plan = { version: 1, trunk: 'main', closure: [], invariants: [],
    nodes: ids.map((id, i) => ({ id, brief: 'work \u{1F43E} '.repeat(i === 1 ? 6000 : 900), writes: [`n${i}.txt`], checks: [], review: { count: 0, min_rank: 1 } })) };
  const source = JSON.stringify(plan, null, 2);
  assert.ok(Buffer.byteLength(source) >= 2 * 1024 * 1024);
  await r.put('plan.json', source); await r.commit();
  await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: source, path: 'plan.json', measure: false });
  await ops.dispatch({ cwd: r.cwd, as: { role: 'parent', id: 'fixture' }, node: ids[0]! });
  const ledger = await Ledger.open(r.cwd);
  await ledger.withLock(() => ledger.append([{ kind: 'rule', by: 'parent:fixture', nodes: [ids[0]!], text: 'Outcome first. \u{1F43E} '.repeat(5000) }]));
  return { ...r, ids, plan, h: harness(r.cwd), planBytes: Buffer.byteLength(source) };
}

test('TB1-TB5 real extension/worker: large status, why, edit, plan and refusal are bounded before RPC', { timeout: 180_000 }, async t => {
  delete process.env.OWED_CONFIRM;
  const r = await fixture();
  try {
    t.diagnostic(`fixture: nodes=300; plan=${r.planBytes} bytes`);
    for (const full of [false, true]) {
      const expected = renderStatus(await ops.status({ cwd: r.cwd }), { full });
      assert.ok(Buffer.byteLength(expected) > CONTENT, 'large status really needs clipping');
      const start = performance.now(), got = await r.h.call('status', { full });
      t.diagnostic(`status full=${full}: ${(performance.now() - start).toFixed(1)} ms; text=${Buffer.byteLength(text(got))}; details=${Buffer.byteLength(JSON.stringify(got.details))}`);
      assert.notEqual(got.isError, true, text(got)); cut(got, 'owed status --full');
      assert.ok(expected.startsWith(text(got).split('\n')[0]!));
      assert.equal((got.details as { nodes?: unknown }).nodes, undefined, 'no reducer node dictionary');
      // Direct RPC sees the bounded result too, not merely a host-side display repair.
      const raw = await toolWorker().call('tool', [9901, 'owed_status', 'raw', { full }, { cwd: r.cwd, hasUI: false, idle: true }]) as Result;
      cut(raw, 'owed status --full');
      const output = await cli(r.cwd, ['status', ...(full ? ['--full'] : [])]);
      // Rendering is unchanged apart from the live writer age ticking between separate reads.
      const stable = (s: string) => s.replace(/writing \(\d+s\)/g, 'writing (<age>s)');
      assert.ok(stable(output.stdout) === stable(`${expected}\n`), 'CLI remains complete and byte-identical apart from live age');
    }
    const statusJSON = JSON.parse((await cli(r.cwd, ['status', '--json'])).stdout);
    assert.equal(Object.keys(statusJSON.nodes).length, 300);
    assert.ok(Buffer.byteLength(JSON.stringify(statusJSON)) > DETAILS, 'CLI JSON remains unbounded');
    const expectedWhy = renderWhy(await ops.why({ cwd: r.cwd, node: r.ids[0]! }), { full: true });
    const why = await r.h.call('why', { node: r.ids[0], full: true });
    assert.notEqual(why.isError, true, text(why)); cut(why, `owed why ${r.ids[0]} --full`);
    assert.equal((await cli(r.cwd, ['why', r.ids[0]!, '--full'])).stdout, `${expectedWhy}\n`);
    assert.equal((why.details as { rulingFollowUp?: unknown }).rulingFollowUp, undefined);

    const measure = (name: string, result: Result) => t.diagnostic(`${name}: text=${Buffer.byteLength(text(result))}; details=${Buffer.byteLength(JSON.stringify(result.details))}`);
    measure('why full', why);
    const count = (await (await Ledger.open(r.cwd)).read()).length;
    const preview = await r.h.call('edit', { plan: 'plan.json', node: r.ids[1], set: ['title=Preview'], note: 'Preview only', dry_run: true });
    assert.notEqual(preview.isError, true, text(preview)); bounded(preview);
    assert.equal((await (await Ledger.open(r.cwd)).read()).length, count, 'preview appends nothing');
    for (const key of ['text', 'next', 'prior', 'plan', 'diff']) assert.equal((preview.details as Record<string, unknown>)[key], undefined, key);
    // Small invocation, large generated diff: the footer can safely reproduce this read-only preview.
    const bigPreview = await r.h.call('edit', { plan: 'plan.json', node: r.ids[1], unset: ['brief'], note: 'Preview removal', dry_run: true });
    assert.notEqual(bigPreview.isError, true, text(bigPreview)); cut(bigPreview, 'owed edit');
    assert.ok(text(bigPreview).split('\n').at(-1)!.includes('--dry-run'));
    measure('edit dry_run large', bigPreview);
    // Arbitrarily large invocation cannot be echoed into the footer.
    const hugePreview = await r.h.call('edit', { plan: 'plan.json', node: r.ids[1], set: [`title=${'\u{1F43E}'.repeat(20000)}`], note: 'Preview only', dry_run: true });
    assert.notEqual(hugePreview.isError, true, text(hugePreview));
    cut(hugePreview, 'rerun with the owed CLI and --dry-run');
    const edited = await r.h.call('edit', { plan: 'plan.json', node: r.ids[1], set: ['title=Recorded'], note: 'Record edit' });
    assert.notEqual(edited.isError, true, text(edited)); cut(edited, `owed why ${r.ids[1]} --full`);
    assert.equal((edited.details as { diff?: unknown }).diff, undefined);
    assert.match(text(edited).split('\n').at(-1)!, /plan #\d+.*plan\.json/);
    measure('edit recorded', edited);
    r.plan.nodes[2] = { ...r.plan.nodes[2]!, brief: 'Plan updated' };
    await writeFile(join(r.cwd, 'plan.json'), JSON.stringify(r.plan, null, 2));
    const planned = await r.h.call('plan', { plan: 'plan.json' });
    assert.notEqual(planned.isError, true, text(planned)); cut(planned, 'owed status --full');
    assert.equal((planned.details as { carried?: unknown }).carried, undefined, 'no carried submits');
    assert.equal((planned.details as { kind: string }).kind, 'plan');
    measure('plan recorded', planned);
    const beforeRefusal = (await (await Ledger.open(r.cwd)).read()).length;
    const refused = await r.h.call('why', { node: 'missing-\u{1F43E}'.repeat(10000), full: true });
    assert.equal(refused.isError, true); cut(refused);
    assert.ok(text(refused).startsWith('Refused: Node missing-'));
    assert.equal((refused.details as { code: string }).code, 'refused');
    measure('large refusal', refused);
    assert.equal((await (await Ledger.open(r.cwd)).read()).length, beforeRefusal);
    await toolWorker().call('event', [9901, 'session_shutdown', { cwd: r.cwd, hasUI: false, idle: true }]);
  } finally { await r.h.close(); await r.cleanup(); }
});

test('TB1 dispatch exemption preserves oversized packet, later rulings, args and submit before bounded brief', { timeout: 90_000 }, async t => {
  const r = await fixture();
  try {
    const ledger = await Ledger.open(r.cwd);
    const rules = Array.from({ length: 30 }, (_, i) => `Ruling ${i}: ${'required input \u{1F43E} '.repeat(160)}END-RULING-${i}`);
    await ledger.withLock(() => ledger.append(rules.map(value => ({ kind: 'rule' as const, by: 'parent:fixture', nodes: [r.ids[1]!, r.ids[2]!], text: value }))));
    const check = async (node: string, reply: Result) => {
      assert.notEqual(reply.isError, true, text(reply));
      const entry = (await ledger.read()).findLast(e => e.kind === 'dispatch' && e.node === node);
      assert.ok(entry?.kind === 'dispatch');
      const packet = (await ledger.getBlob(entry.packet)).toString('utf8');
      assert.ok(Buffer.byteLength(packet) > CONTENT, 'required packet alone exceeds the ordinary cut');
      assert.ok(packet.includes(rules.at(-1)!), 'later ruling really occurs after the cut');
      assert.ok(packet.indexOf(rules.at(-1)!) > CONTENT);
      const submit = `After committing, run: owed submit ${node}`;
      assert.ok(packet.includes(submit));
      const args = `subagents: ${JSON.stringify({ agent: 'worker', cwd: entry.worktree, task: '<the complete packet above>', isolation: 'none' })}`;
      const required = `${packet}\n\n${args}\n`;
      assert.equal(text(reply).slice(0, required.length), required, 'packet, submit instruction and argv survive byte-exact, first');
      assert.ok(Buffer.byteLength(JSON.stringify(reply.details)) <= DETAILS);
      const brief = text(reply).slice(required.length);
      cut({ ...reply, content: [{ type: 'text', text: brief }] }, 'owed status');
      assert.match(brief, /^owed: /);
      t.diagnostic(`dispatch ${node.slice(0, 2)}: packet=${Buffer.byteLength(packet)}; brief=${Buffer.byteLength(brief)}; details=${Buffer.byteLength(JSON.stringify(reply.details))}`);
    };
    await check(r.ids[1]!, await r.h.call('dispatch', { node: r.ids[1] }));
    // Verify the result before host display processing as well, using a second slot.
    await check(r.ids[2]!, await toolWorker().call('tool', [9902, 'owed_dispatch', 'raw', { node: r.ids[2] }, { cwd: r.cwd, hasUI: false, idle: true }]) as Result);
    await toolWorker().call('event', [9902, 'session_shutdown', { cwd: r.cwd, hasUI: false, idle: true }]);
  } finally { await r.h.close(); await r.cleanup(); }
});

test('TB2 bounded scope and guidance summaries preserve ordinary waiver meaning and warning sets', () => {
  const meaning = 'waived check:unit for candidate #6: '.repeat(25);
  const ordinary = compactToolDetails('owed_waive', { kind: 'waive', seq: 7, meaning });
  assert.equal(ordinary.meaning, meaning, 'formatted scope explanation survives beyond the generic 512-byte string head');
  const warnings = Array.from({ length: 9 }, (_, i) => `warning ${i}: retained plan guidance`);
  const plan = compactToolDetails('owed_plan', { kind: 'plan', warnings });
  assert.deepEqual(plan.warnings, warnings); assert.equal(plan.warningsCount, warnings.length);
  const huge = compactToolDetails('owed_plan', { kind: 'plan', warnings: Array.from({ length: 1000 }, (_, i) => `warning ${i}: ${'x'.repeat(600)}`) });
  assert.ok(huge.warnings.length <= 32);
  assert.ok(Buffer.byteLength(JSON.stringify(huge.warnings)) <= 3072);
  assert.equal(huge.warningsOmitted, 1000 - huge.warnings.length);
  assert.ok(Buffer.byteLength(JSON.stringify(huge)) <= DETAILS);
  const scope = compactToolDetails('owed_waive', { kind: 'waive', meaning: 'scope 🐾 '.repeat(1000) });
  assert.ok(Buffer.byteLength(scope.meaning) <= 2048);
  assert.equal(scope.meaningOmittedBytes, Buffer.byteLength('scope 🐾 '.repeat(1000)) - Buffer.byteLength(scope.meaning));
  assert.ok(Buffer.byteLength(JSON.stringify(scope)) <= DETAILS);
});

test('TB1/TB2 hard limits handle UTF-8 boundaries, JSON escapes, many lists and version notices', () => {
  assert.equal(typeof utf8Head, 'function', 'worker result bounding is available');
  for (const value of ['a'.repeat(49152), '\u{1F43E}'.repeat(49152), '\u00E9'.repeat(49152), String.fromCharCode(0).repeat(49152)]) {
    for (const bytes of [0, 1, 2, 3, 4, 511, 49152]) {
      const head = utf8Head(value, bytes);
      assert.ok(Buffer.byteLength(head) <= bytes); assert.ok(value.startsWith(head));
      assert.doesNotMatch(head, /[\uD800-\uDBFF]$/u);
    }
    const r = boundToolResult('owed_status', {}, { content: [{ type: 'text', text: value }], details: { nodes: {}, ready: [value], summary: { merged: 0, needs: [{ node: value, reason: value, command: value }], progress: [], debt: [] } } });
    bounded(r as Result);
    if (Buffer.byteLength(value) <= CONTENT) assert.equal(text(r as Result), value);
    else {
      cut(r as Result, 'owed status --full');
      const [head, last] = text(r as Result).split('\n');
      assert.ok(value.startsWith(head!));
      assert.equal(Number(last!.match(/^(\d+) bytes omitted/)![1]), Buffer.byteLength(value) - Buffer.byteLength(head!));
    }
  }
  const huge = 'x'.repeat(100_000), arrays = Array.from({ length: 500 }, () => ({ node: huge, obligation: huge, note: huge, text: huge, facts: { commit: 'a'.repeat(40), changed: Array(500).fill(huge) } }));
  const details = compactToolDetails('owed_report', Object.fromEntries(['merges', 'blocks', 'waivers', 'decisions', 'changes', 'adoptions', 'halts', 'receipts', 'superseded', 'trackedDebt', 'quarantine'].map(k => [k, arrays])));
  assert.ok(Buffer.byteLength(JSON.stringify(details)) <= DETAILS);
  assert.equal(details.mergesCount, 500); assert.equal(details.mergesOmitted, 495);
  assert.ok(details.merges.every((v: object) => !('text' in v) && !('note' in v)));
  const version = boundToolResult('owed_why', { node: 'a' }, versionNotice({ content: [{ type: 'text', text: huge }], details: { code: 'version', reason: huge } }, { seen: new Set() }));
  cut(version as Result, 'owed why a --full');
  assert.ok(text(version as Result).includes(restartLine()));
  const clipped = text(version as Result), countLine = clipped.split('\n').at(-1)!;
  assert.equal(Number(countLine.match(/^(\d+) bytes omitted/)![1]), Buffer.byteLength(huge + '\n' + restartLine()) - Buffer.byteLength(clipped.slice(0, clipped.lastIndexOf('\n'))));
  const refusal = boundToolResult('owed_edit', { node: 'x'.repeat(10000), set: ['title=new'] }, { content: [{ type: 'text', text: `Refused: ${huge}` }], details: { code: 'refused', reason: huge }, isError: true });
  cut(refusal as Result); assert.ok(text(refusal as Result).startsWith('Refused: '));
  assert.doesNotMatch(text(refusal as Result).split('\n').at(-1)!, /owed edit|owed why/);
  const preview = boundToolResult('owed_edit', { node: 'a', set: ['title=new'], note: "don't change", rule: 'literal', resume: true, after: ['b', 'c'], expect: 'report', dry_run: true }, { content: [{ type: 'text', text: huge }], details: {} });
  cut(preview as Result, 'owed edit a'); assert.match(text(preview as Result).split('\n').at(-1)!, /--rule literal --after b,c --expect report --resume/);
  for (const tool of ['owed_dispatch', 'owed_status']) {
    const details = compactToolDetails(tool, tool === 'owed_status' ? { trunk: { name: 'main', commit: 'c'.repeat(40), seq: 42 }, nodes: {}, summary: {} } : { node: 'a', worktree: '/tmp/slot', branch: 'slot/1', packet: huge, subagents: { agent: 'worker', cwd: '/tmp/slot', isolation: 'none', task: huge } });
    if (tool === 'owed_status') assert.equal(details.trunk.name, 'main');
    else { assert.equal(details.worktree, '/tmp/slot'); assert.equal(details.branch, 'slot/1'); assert.equal(details.subagents.task, undefined); }
  }
});
test('TB4 small text and refusal remain byte-for-byte unchanged; every registered tool refusal is bounded', { timeout: 60_000 }, async () => {
  const r = await repo(), h = harness(r.cwd);
  try {
    const plan = JSON.stringify({ version: 1, trunk: 'main', invariants: [], nodes: [{ id: 'a', writes: ['a.txt'] }] });
    await r.put('plan.json', plan); await r.commit();
    await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan, measure: false });
    const got = await h.call('status'); bounded(got); assert.equal(text(got), renderStatus(await ops.status({ cwd: r.cwd })));
    const error = await h.call('why', { node: 'missing' }); bounded(error);
    assert.equal(text(error), 'Refused: Node missing does not exist');
    assert.deepEqual(error.details, { code: 'refused', reason: 'Node missing does not exist' });
    for (const name of h.tools.keys()) {
      const out = await h.call(name.slice(5), { cwd: `/missing/${'\u{1F43E}'.repeat(20000)}` });
      assert.equal(out.isError, true, name); cut(out);
    }
  } finally { await h.close(); await r.cleanup(); }
});
