import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { clockTime } from '../src/clock.ts';
import { sha256 } from '../src/canon.ts';
import { needs, itemLine, trunkRedHint } from '../src/needs.ts';
import { renderStatus, renderBrief, renderWhy, renderReceipt } from '../src/views.ts';
import { Driver } from '../src/drive-run.ts';
import { Dsa } from '../src/dsa.ts';
import { remeasureErrorTexts } from '../src/remeasure-on.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const owner = { role: 'owner', id: 'pi' } as const, parent = { role: 'parent', id: 'test' } as const;
const now = Date.parse('2026-10-16T12:00:00Z');
const pass = `echo 'owed-counts {"pass":1,"fail":0}'`;
const fail = `echo 'owed-counts {"pass":0,"fail":1,"failed":["stress case"]}'; exit 1`;
async function fixture(o: { failing?: boolean; approve?: boolean; run?: string; closure?: boolean; review?: number; lease?: boolean } = {}) {
  const r = await repo();
  await commitAt(r.cwd, { 'src/value': 'base', 'check.sh': o.run ?? (o.failing ? `if [ -e '${r.root}/pass' ]; then ${pass}; else ${fail}; fi` : pass) });
  await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', lease: false, plan: JSON.stringify({ version: 1, trunk: 'main', lease: o.lease ?? false, closure: o.closure ? ['check.sh'] : [], invariants: [], nodes: [{ id: 'a', writes: ['src/', 'check.sh'], checks: [{ id: 'stress', run: 'bash check.sh', reads: ['src/', 'check.sh'], min_tests: 1 }], review: { count: o.review ?? 1, min_rank: 1 }, ...(o.approve ? { approve: 'owner' } : {}) }, { id: 'dep', writes: ['dep/'], checks: [], review: { count: 0, min_rank: 1 } }] }) });
  const slot = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
  const submit = async (value: string, closure = false) => {
    await commitAt(slot.worktree, { 'src/value': value, ...(closure ? { 'check.sh': `${pass}\n# closure changed ${value}` } : {}) });
    return ops.submit({ cwd: slot.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
  };
  await submit('one', o.closure);
  const block = (obligation: 'review' | 'closure-review' = 'review', guidance = false) => ops.review({ cwd: r.cwd, node: 'a', as: { role: 'reviewer', id: 'original' }, verdict: 'block', rank: 2, obligation, note: 'BLOCK (needs parent): choose the response', ...(guidance ? { needs: 'parent' as const } : {}), ack_rulings: 'latest' });
  const halt = (reason = 'stalled: check:stress', needs: 'human' | 'owner' = 'owner') => ops.halt({ cwd: r.cwd, node: 'a', as: { role: 'parent', id: 'drive' }, attempt: 1, reason, needs });
  return { ...r, slot, submit, block, halt };
}
function extension(cwd: string) {
  const tools = new Map<string, ToolDefinition>(), commands = new Map<string, any>(), hooks = new Map<string, any>(), messages: string[] = [];
  const ctx = { cwd, hasUI: false, isIdle: () => true, ui: { notify: (text: string) => messages.push(text) } } as any;
  owed({ registerTool: (t: ToolDefinition) => tools.set(t.name, t), registerCommand: (name: string, c: unknown) => commands.set(name, c), on: (name: string, h: unknown) => hooks.set(name, h), sendMessage() {} } as unknown as ExtensionAPI);
  return { messages, async tool(name: string, args = {}) { const r = await tools.get(`owed_${name}`)!.execute('test', args, undefined, undefined, ctx); assert.notEqual(r.isError, true); return (r.content as { text: string }[]).map(c => c.text).join('\n'); }, async slash() { await commands.get('owed').handler('', ctx); return messages.at(-1)!; }, async close() { await hooks.get('session_shutdown')?.({}, ctx); } };
}

test('R-028-51: status and brief JSON keep the cbe7b9a need keys while why renders alternatives', async () => {
  const r = await fixture();
  try {
    await ops.attest({ cwd: r.cwd, node: 'a' }); await r.block();
    const state = (await ops.readState(r)).state;
    assert.equal(needs(state, 'a')[0]!.alternatives, undefined);
    for (const command of ['status', 'brief']) {
      const output = await cli(r.cwd, [command, '--json']); assert.equal(output.code, 0, output.stderr);
      const json = JSON.parse(output.stdout), rows = json.summary.needs;
      assert.ok(rows.some((n: { node: string }) => n.node === 'a'));
      for (const row of rows) assert.deepEqual(Object.keys(row).sort(), ['command', 'node', 'reason'], command);
      assert.doesNotMatch(output.stdout, /"alternatives"\s*:/);
    }
    const why = await cli(r.cwd, ['why', 'a']); assert.equal(why.code, 0, why.stderr);
    assert.doesNotMatch(why.stdout, /or: owed review a.*--ok/);
    const json = await cli(r.cwd, ['why', 'a', '--json']); assert.equal(json.code, 0, json.stderr);
    assert.doesNotMatch(json.stdout, /"alternatives"\s*:/);
  } finally { await r.cleanup(); }
});

test('R-028-51: differential preserves corrupted CUR summary reasons, trunk commands and brief decisions', async () => {
  const { CUR, compare } = await import('./perf/differential.ts'), { synthLedger } = await import('./perf/synth.ts');
  const sample = synthLedger(50, 5, 2), original = CUR.v;
  assert.equal(compare(sample.entries, sample.lookup, 10), undefined);
  for (const fault of ['reason', 'command', 'brief'] as const) {
    try {
      CUR.v = { ...original, ...(fault === 'brief' ? { briefView: (...args: Parameters<typeof original.briefView>) => {
        const brief = original.briefView(...args);
        brief.decisions = [{ node: 'n0', obligation: 'review', key: 'bad', mark: '⛔', detail: 'deliberately corrupted brief decision', blockedDownstream: 0, command: 'owed resume trunk' }];
        return brief;
      } } : { statusView: (...args: Parameters<typeof original.statusView>) => {
        const status = original.statusView(...args), modern = status as unknown as import('../src/views.ts').StatusView;
        const row = modern.summary!.needs[0] ?? { node: 'n0', reason: 'ready to dispatch', command: 'owed dispatch n0' };
        modern.summary!.needs = [{ ...row, ...(fault === 'reason' ? { reason: 'deliberately corrupted summary reason' } : { command: 'owed resume trunk' }) }];
        return status;
      } }) };
      const mismatch = compare(sample.entries, sample.lookup, 10);
      assert.equal(mismatch?.what, 'snapshot', fault);
      const base = JSON.parse(mismatch!.base), current = JSON.parse(mismatch!.cur), field = fault === 'brief' ? 'brief' : 'status';
      assert.notEqual(base[field], current[field], fault);
      assert.ok(current[field].includes(fault === 'reason' ? 'deliberately corrupted summary reason' : 'owed resume trunk'), current[field]);
    } finally { CUR.v = original; }
  }
});

test('R-028-51: a block inserted after driver merge selection preserves the cbe7b9a halt cause', async () => {
  for (const obligation of ['review', 'approve'] as const) {
    const r = await fixture({ review: obligation === 'review' ? 1 : 0, approve: obligation === 'approve', lease: true });
    let driver: Driver | undefined;
    try {
      const { writerLaunch } = await import('../src/drive.ts'), { projectId } = await import('../src/reducer.ts');
      const state = (await ops.readState(r)).state;
      await ops.launch({ cwd: r.cwd, as: parent, ...writerLaunch(state, 'a', projectId(state)) });
      await ops.attest({ cwd: r.cwd, node: 'a', lease: false });
      if (obligation === 'review') await ops.review({ cwd: r.cwd, node: 'a', as: { role: 'reviewer', id: 'accepted' }, verdict: 'ok', rank: 1, note: 'accepted before selection' });
      else await ops.approve({ cwd: r.cwd, node: 'a', as: owner, channel: 'delegated', note: 'accepted before selection' });
      assert.equal((await ops.readState(r)).state.nodes.a!.accepted, true);
      let injections = 0;
      class LateBlock extends Dsa {
        constructor() { super({ bin: '/bin/true' }); }
        override async describe(rid: string) { return { rid, state: 'sealed' as const, status: 'ok' as const }; }
        override async inspect(rid: string) { return { view: await this.describe(rid) }; }
        override async holdWhile<T>(_resource: string, work: (signal: AbortSignal) => Promise<T>, o: { signal?: AbortSignal } = {}) {
          assert.equal(_resource, 'machine'); assert.equal(++injections, 1);
          assert.equal((await ops.readState(r)).state.nodes.a!.accepted, true, 'selected accepted candidate before ops.merge');
          if (obligation === 'review') await ops.review({ cwd: r.cwd, node: 'a', as: { role: 'reviewer', id: 'late' }, verdict: 'block', rank: 2, note: 'new block after selection' });
          else await ops.approve({ cwd: r.cwd, node: 'a', as: owner, channel: 'delegated', block: true, note: 'new block after selection' });
          return { outcome: 'ran' as const, value: await work(o.signal ?? new AbortController().signal) };
        }
      }
      const reports: { do: string; outcome: string }[] = [];
      driver = new Driver({ cwd: r.cwd, max: 1, dsa: new LateBlock(), json: true, handleSignals: false, log: line => reports.push(JSON.parse(line)) });
      await driver.pass(); await driver.settle();
      assert.equal(injections, 1); assert.ok(reports.some(r => r.do === 'merge' && r.outcome === 'started'));
      const after = await ops.readState(r), halt = after.entries.findLast(e => e.kind === 'halt' && e.node === 'a');
      assert.ok(halt?.kind === 'halt');
      assert.equal(halt.reason, `merge refused: Node a current candidate is not yet accepted:${obligation}`);
      assert.doesNotMatch(halt.reason, /\n|Next:|owed (?:resume|waive|approve|decide)/);
      assert.equal(after.state.nodes.a!.accepted, false); assert.ok(!after.entries.some(e => e.kind === 'merge'));
    } finally { driver?.abort.abort(); await driver?.settle(); await r.cleanup(); }
  }
  const red = await mergeRed();
  try {
    const state = (await ops.readState(red)).state;
    const expected = state.nodes.a!.blocks.filter(b => b.state === 'active').flatMap(b => trunkRedHint(state, b.seq, b.key) ?? []).join('; ');
    assert.match(expected, /^trunk-red:/);
    await assert.rejects(ops.merge({ cwd: red.cwd, node: 'a', as: parent }), e => { assert.equal((e as Error).message, expected); return true; });
  } finally { await red.cleanup(); }
});

test('VW1/C1: status, brief, both why cards, receipts and extension keep each halted obligation separate', async () => {
  const r = await fixture({ failing: true }); const ext = extension(r.cwd);
  try {
    await ops.attest({ cwd: r.cwd, node: 'a' }); const b = await r.block(); await r.halt();
    const state = (await ops.readState({ cwd: r.cwd })).state, ns = needs(state, 'a');
    assert.deepEqual(ns.map(n => n.obligation), ['check:stress', 'review']);
    const status = await ops.status({ cwd: r.cwd }), card = await ops.why({ cwd: r.cwd, node: 'a' });
    const outputs = [renderStatus(status), renderStatus(status, { full: true }), renderBrief(await ops.brief({ cwd: r.cwd })), renderWhy(card), renderWhy(card, { full: true }), renderReceipt(card), await ext.tool('status'), await ext.slash(), await ext.tool('why', { node: 'a' })];
    for (const text of outputs) {
      for (const n of ns) assert.ok(text.includes(`${n.text} → ${n.command}`), text);
      assert.doesNotMatch(text, /resolves it with:|--reason[^\n]*\| owed decide/);
    }
    for (const text of [renderStatus(status), renderBrief(await ops.brief({ cwd: r.cwd }))]) for (const n of ns) assert.ok(text.split('\n').includes(`  a: ${n.text} → ${n.command}`), text);
    const ledger = await Ledger.open(r.cwd), runtimeDir = join(ledger.dir, 'run'), runtimeFile = join(runtimeDir, `attest-${process.pid}-pair.json`);
    await mkdir(runtimeDir, { recursive: true });
    await writeFile(runtimeFile, JSON.stringify({ node: 'a', do: 'attest', obligations: ['check:stress'], since: new Date(now).toISOString(), pid: process.pid, token: 'pair', phase: 'running', candidate: state.nodes.a!.candidate!.seq }));
    const measuringBrief = await ops.brief({ cwd: r.cwd });
    assert.deepEqual(measuringBrief.decisions.filter(d => d.node === 'a').map(d => d.obligation), ['review']);
    for (const text of [renderStatus(await ops.status({ cwd: r.cwd })), renderBrief(measuringBrief), renderWhy(await ops.why({ cwd: r.cwd, node: 'a' }))]) {
      assert.doesNotMatch(text, /owed waive a check:stress/); assert.ok(text.includes(ns[1]!.command!), text);
    }
    await rm(runtimeFile);
    for (const text of [renderWhy(card), renderWhy(card, { full: true })]) assert.doesNotMatch(text, /or: owed review a.*--ok/);
    assert.ok(ns[0]!.command!.includes('--accept-risk')); assert.equal(state.nodes.a!.blocks.find(x => x.seq === b.seq)?.state, 'active');
    await assert.rejects(ops.merge({ cwd: r.cwd, node: 'a', as: parent }), e => {
      assert.equal((e as Error).message, 'Node a current candidate is not yet accepted:check:stress, review'); return true;
    });
    // C8: accepting behaviour elsewhere cannot erase stress; accepting review still leaves stress.
    await writeFile(join(r.root, 'pass'), 'passed');
    await ops.attest({ cwd: r.cwd, node: 'a' });
    await ops.waive({ cwd: r.cwd, node: 'a', as: owner, channel: 'delegated', obligation: 'review', accept_risk: [b.seq], reason: 'review risk accepted' });
    const out = renderStatus(await ops.status({ cwd: r.cwd }));
    assert.match(out, /a: check:stress:/); assert.doesNotMatch(out.split('In progress')[0]!, /owed waive a review/);
    assert.equal((await ops.status({ cwd: r.cwd })).nodes.a!.accepted, false);
  } finally { await ext.close(); await r.cleanup(); }
});

test('VW2/C3: submitted review and closure repairs explain exact clearance on compact and full why', async () => {
  for (const obligation of ['review', 'closure-review'] as const) {
    const r = await fixture({ closure: obligation === 'closure-review' });
    try {
      await ops.attest({ cwd: r.cwd, node: 'a' }); const b = await r.block(obligation);
      await ops.rule({ cwd: r.cwd, as: parent, nodes: ['a'], text: 'repair the response', writer: true });
      await r.submit('two', obligation === 'closure-review');
      const s = (await ops.readState({ cwd: r.cwd })).state, next = itemLine(s, 'a', obligation), n = needs(s, 'a').find(n => n.obligation === obligation)!;
      assert.match(next, new RegExp(`repair #\\d+ submitted; #${b.seq} clears when reviewer:original records ok at rank >= 2 on the current key`));
      for (const args of [['why', 'a'], ['why', 'a', '--full'], ['status'], ['brief']]) {
        const out = await cli(r.cwd, args); assert.equal(out.code, 0, out.stderr); assert.ok(out.stdout.includes(next), out.stdout); assert.ok(out.stdout.includes(n.command!), out.stdout);
        assert.doesNotMatch(out.stdout, /guidance needed|owed decide a[^\n]*--writer|driver will run/);
      }
      if (obligation === 'closure-review') assert.match(n.command!, /--obligation closure-review/);
      assert.equal(s.nodes.a!.accepted, false);
    } finally { await r.cleanup(); }
  }
});

test('VW2/C7: failing trunk and invariant headlines never claim merged, and no-command needs are explicit', async () => {
  const r = await repo();
  try {
    await commitAt(r.cwd, { 'check.sh': fail });
    const plan = { version: 1, trunk: 'main', lease: false, closure: [], invariants: [], nodes: [] };
    await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify(plan) });
    await ops.planSet({ cwd: r.cwd, as: parent, plan: JSON.stringify({ ...plan, invariants: [{ id: 'health', run: 'bash check.sh', reads: ['check.sh'], min_tests: 1 }] }) });
    await ops.attestTrunk({ cwd: r.cwd });
    for (const id of ['trunk', 'inv:health']) for (const full of [false, true]) {
      const out = await cli(r.cwd, ['why', id, ...(full ? ['--full'] : [])]); assert.equal(out.code, 0, out.stderr);
      assert.doesNotMatch(out.stdout.split('\n')[0]!, /: merged/); assert.match(out.stdout, /inv:health/); assert.doesNotMatch(out.stdout, /owed (decide|resume|rule) trunk/);
    }
    assert.match((await cli(r.cwd, ['status'])).stdout, /trunk: no single command:.*\(no single command\)/);
  } finally { await r.cleanup(); }
});

test('VW3: attest exit 4 starts with the primary need on CLI and extension, with acceptance unchanged', async () => {
  const r = await fixture({ approve: true, review: 0 }), ext = extension(r.cwd);
  try {
    // R-028-37: the dedicated genesis receipt is the cbe7b9a text, including exit 4.
    const genesis = await repo();
    try {
      await commitAt(genesis.cwd, { seed: 'base' });
      await ops.init({ cwd: genesis.cwd, as: owner, channel: 'delegated', measure: false, plan: JSON.stringify({ version: 1, trunk: 'main', lease: false, closure: [], invariants: [{ id: 'health', run: 'exit 127', min_tests: 1 }], nodes: [] }) });
      const incomplete = await cli(genesis.cwd, ['attest', '--genesis']);
      assert.equal(incomplete.code, 4, incomplete.stderr);
      assert.equal(incomplete.stdout, 'Genesis attest: 1 observation recorded; observed none; missing health\n');
      assert.doesNotMatch(incomplete.stdout, /^measured; not accepted yet:/);
    } finally { await genesis.cleanup(); }
    for (const args of [['attest', 'a'], ['attest', 'a', '--full']]) {
      const out = await cli(r.cwd, args); assert.equal(out.code, 4, out.stderr); assert.equal(out.stdout.split('\n')[0], 'measured; not accepted yet: awaiting owner approval');
    }
    assert.equal((await ext.tool('attest', { node: 'a' })).split('\n')[0], 'measured; not accepted yet: awaiting owner approval');
    assert.equal((await ops.status({ cwd: r.cwd })).nodes.a!.accepted, false);
    await ops.approve({ cwd: r.cwd, node: 'a', as: owner, channel: 'delegated', note: 'checked' });
    const accepted = await cli(r.cwd, ['attest', 'a']); assert.equal(accepted.code, 0, accepted.stderr); assert.doesNotMatch(accepted.stdout, /^measured; not accepted yet:/);
  } finally { await ext.close(); await r.cleanup(); }
});

test('VW3: attest exit 4 reports recorded activity when no parent or owner need exists', async () => {
  const r = await fixture();
  try {
    const out = await cli(r.cwd, ['attest', 'a']); assert.equal(out.code, 4, out.stderr);
    assert.match(out.stdout.split('\n')[0]!, /^measured; not accepted yet: measuring other since \d\d:\d\d \(attest pid \d+\)$/);
    assert.equal((await ops.status({ cwd: r.cwd })).nodes.a!.accepted, false);
  } finally { await r.cleanup(); }
});

test('VW4: manual rebase receipt leads with its mutation and writer responsibility', async () => {
  const r = await fixture(), ext = extension(r.cwd);
  try {
    const expected = 'moved the slot base; the writer must rebase and resubmit (use --apply to rebase as executor)';
    await commitAt(r.cwd, { other: 'trunk advanced' });
    await ops.adopt({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'advance trunk for manual rebase' });
    const out = await cli(r.cwd, ['rebase', 'a', '--as', 'parent:test']); assert.equal(out.code, 0, out.stderr); assert.equal(out.stdout.split('\n')[0], expected);
    assert.equal((await ops.status({ cwd: r.cwd })).nodes.a!.candidate, undefined);
    await commitAt(r.cwd, { other: 'trunk advanced again' });
    await ops.adopt({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'advance trunk for extension rebase' });
    assert.equal((await ext.tool('rebase', { node: 'a', as: 'parent:test' })).split('\n')[0], expected);
  } finally { await ext.close(); await r.cleanup(); }
});

test('VW5/HL1: resource and dependency halts render resume; writer-stop precedes unruled review', async () => {
  const r = await fixture(), ext = extension(r.cwd);
  try {
    await ops.resume({ cwd: r.cwd, node: 'a', as: parent, after: 'dep' });
    await r.halt('resource unavailable; diagnostic owed decide dep --writer', 'human');
    for (const text of [renderStatus(await ops.status({ cwd: r.cwd })), renderBrief(await ops.brief({ cwd: r.cwd })), await ext.tool('status'), (await cli(r.cwd, ['why', 'a'])).stdout, (await cli(r.cwd, ['why', 'a', '--full'])).stdout]) {
      assert.match(text, /after resume the driver continues from the current state, then waits for dep → owed resume a/);
      assert.doesNotMatch(text.split('\n').filter(l => !l.startsWith('⏸ halted by driver')).join('\n'), /owed decide dep|owed decide a/);
    }
    await r.block('review', true);
    await r.halt('writer run r sealed ok; writer says: "No change" → owed decide a --text "<ruling>" --writer', 'human');
    const card = await ops.why({ cwd: r.cwd, node: 'a' });
    for (const text of [renderStatus(await ops.status({ cwd: r.cwd })), renderWhy(card), renderWhy(card, { full: true })]) {
      assert.match(text, /review asks: choose the response → owed decide a --text "<ruling>" --writer/);
      assert.ok(text.indexOf('a: writer says: "No change"') < text.indexOf('review asks: choose the response'), text);
    }
    const refused = await cli(r.cwd, ['resume', 'a']); assert.equal(refused.code, 1); assert.match(refused.stderr, /review asks: choose the response → owed decide a/); assert.doesNotMatch(refused.stderr, /owed rule --nodes/);
  } finally { await ext.close(); await r.cleanup(); }
});

test('VW1/VW5 N6: live measurement suppresses only its matching owner need, queued and stale records do not', async () => {
  const r = await fixture({ failing: true });
  try {
    await ops.attest({ cwd: r.cwd, node: 'a' }); await r.halt();
    const ledger = await Ledger.open(r.cwd), state = (await ops.readState({ cwd: r.cwd })).state, seq = state.nodes.a!.candidate!.seq;
    const dir = join(ledger.dir, 'run'), file = join(dir, `attest-${process.pid}-views.json`); await mkdir(dir, { recursive: true });
    for (const variant of [{ phase: 'running', candidate: seq, suppress: true }, { phase: 'queued', candidate: seq, suppress: false }, { phase: 'running', candidate: seq - 1, suppress: false }]) {
      await writeFile(file, JSON.stringify({ node: 'a', do: 'attest', obligations: ['check:stress'], since: new Date(now).toISOString(), pid: process.pid, token: 'views', phase: variant.phase, candidate: variant.candidate }));
      const status = await ops.status({ cwd: r.cwd }), card = await ops.why({ cwd: r.cwd, node: 'a' });
      const measuring = `measuring check:stress since ${clockTime(now, now)} (attest pid ${process.pid})`;
      for (const text of [renderStatus(status), renderWhy(card), renderWhy(card, { full: true }), renderStatus(status, { full: true })]) {
        if (variant.suppress) { assert.doesNotMatch(text, /owed waive a check:stress/); assert.match(text, /owed resume a/); assert.ok(text.includes(measuring), text); }
        else assert.match(text, /owed waive a check:stress --candidate [0-9a-f]{12} --accept-risk/);
      }
      await assert.rejects(ops.mergeBatch({ cwd: r.cwd, nodes: ['a', 'dep'], as: parent }), e => {
        const text = String(e);
        if (variant.suppress) { assert.doesNotMatch(text, /owed waive a check:stress/); assert.match(text, /owed resume a/); }
        else assert.match(text, /owed waive a check:stress --candidate [0-9a-f]{12} --accept-risk/);
        return true;
      });
    }
    await rm(file); assert.match(renderStatus(await ops.status({ cwd: r.cwd })), /owed waive a check:stress/);
  } finally { await r.cleanup(); }
});

async function mergeRed() {
  const r = await repo(), flag = join(r.root, 'pass');
  const run = `if [ -e '${flag}' ] || ! grep -q broken flag; then ${pass}; else ${fail}; fi`;
  await commitAt(r.cwd, { 'src/value': 'base', flag: 'clean', 'check.sh': run });
  await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify({ version: 1, trunk: 'main', lease: false, closure: [], invariants: [], nodes: [{ id: 'a', writes: ['src/'], checks: [{ id: 'stress', run: 'bash check.sh', reads: ['src/', 'flag', 'check.sh'], min_tests: 1 }], review: { count: 0, min_rank: 1 } }] }) });
  const a = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
  await commitAt(a.worktree, { 'src/value': 'candidate' });
  await ops.submit({ cwd: a.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
  await ops.attest({ cwd: r.cwd, node: 'a' });
  await commitAt(r.cwd, { flag: 'broken' });
  await ops.adopt({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'fixture trunk regression' });
  await assert.rejects(ops.merge({ cwd: r.cwd, node: 'a', as: parent }), /trunk-red:/);
  return { ...r, flag };
}

test('R-028-33: active trunk-red exec itemLine keeps diagnosis before its kind route', async () => {
  const r = await mergeRed();
  try {
    const state = (await ops.readState({ cwd: r.cwd })).state;
    const line = itemLine(state, 'a', 'check:stress');
    assert.match(line, /^trunk-red:/); assert.doesNotMatch(line, /writer fixes/);
    assert.equal((await ops.why({ cwd: r.cwd, node: 'a' })).blocks[0]!.clear, line);
  } finally { await r.cleanup(); }
});

test('R-028-33: flaky trunk-red itemLine retains diagnosis followed by its fail/pass pair', async () => {
  const r = await mergeRed();
  try {
    await writeFile(r.flag, 'pass'); await ops.attest({ cwd: r.cwd, node: 'a' });
    const state = (await ops.readState({ cwd: r.cwd })).state, b = state.nodes.a!.blocks.find(b => b.state === 'flaky')!;
    assert.ok(b);
    const line = itemLine(state, 'a', 'check:stress');
    assert.match(line, /^trunk-red:.*; flaky block #\d+.*failed #\d+.*→ passed #\d+ on the same key/);
    assert.doesNotMatch(line, /writer fixes/);
  } finally { await r.cleanup(); }
});

test('R-028-33: shared-check exec itemLine keeps shared diagnosis first and the exported hint unchanged', async () => {
  const r = await fixture({ failing: true, review: 0 });
  try {
    await ops.attest({ cwd: r.cwd, node: 'a' });
    await ops.attestProbeTrunk({ cwd: r.cwd, node: 'a' });
    const state = (await ops.readState({ cwd: r.cwd })).state, b = state.nodes.a!.blocks[0]!;
    const api = await import('../src/needs.ts'), hint = api.sharedCheckHint(state, b)!;
    assert.match(hint, /^check:stress block #\d+ also fails on trunk /);
    const line = itemLine(state, 'a', 'check:stress');
    assert.match(line, /^(?:no single command: )?check:stress block #\d+ also fails on trunk /);
    assert.doesNotMatch(line, /writer fixes/);
    const view = await import('../src/views.ts'); assert.equal(view.sharedCheckHint(state, b), hint);
  } finally { await r.cleanup(); }
});

test('R-028-41/44: historical merge diagnostics remain secondary to unchanged needs and headline', async () => {
  const r = await mergeRed();
  try {
    const failFlag = join(r.root, 'fix-fails'), plan = (await ops.readState({ cwd: r.cwd })).state.plan;
    await ops.planSet({ cwd: r.cwd, as: parent, plan: JSON.stringify({ ...plan, nodes: [...plan.nodes, { id: 'fix', title: 'stress case', writes: ['fix/'], checks: [{ id: 'stress', run: `if [ -e '${failFlag}' ]; then ${fail}; else ${pass}; fi`, reads: ['flag'], min_tests: 1 }], review: { count: 0, min_rank: 1 } }] }) });
    const fix = await ops.dispatch({ cwd: r.cwd, node: 'fix', as: parent });
    await commitAt(fix.worktree, { 'fix/value': 'fix candidate' });
    await ops.submit({ cwd: fix.worktree, node: 'fix', as: { role: 'writer', id: 'fix#1' } });
    assert.equal((await ops.attest({ cwd: r.cwd, node: 'fix' })).accepted, true);
    const ledger = await Ledger.open(r.cwd), before = await ops.readState({ cwd: r.cwd }), beforeCard = await ops.why({ cwd: r.cwd, node: 'a' });
    const beforeSummary = (await ops.summaryStatusView(r.cwd, ledger.dir, before.state, before.entries, now)).summary!.needs;
    await writeFile(failFlag, 'fail');
    await ops.attestProbeTrunk({ cwd: r.cwd, node: 'fix', check: 'stress' });
    const after = await ops.readState({ cwd: r.cwd }), card = await ops.why({ cwd: r.cwd, node: 'a' });
    const block = card.blocks.find(b => b.obligation === 'check:stress')!, next = itemLine(after.state, 'a', 'check:stress');
    assert.ok(block.clear.startsWith(next), block.clear);
    assert.match(block.clear, /fix candidate: fix \(accepted\)/);
    assert.match(block.clear, /known intermittent: stress case failed and passed on the same key/);
    assert.doesNotMatch(beforeCard.blocks[0]!.clear, /known intermittent:/);
    assert.deepEqual(needs(before.state, 'a'), needs(after.state, 'a'));
    assert.deepEqual((await ops.summaryStatusView(r.cwd, ledger.dir, after.state, after.entries, now)).summary!.needs, beforeSummary);
    assert.equal(renderWhy(card).split('\n')[0], renderWhy(beforeCard).split('\n')[0]);
    assert.ok(renderWhy(card).includes(block.clear), renderWhy(card));
    assert.doesNotMatch(renderWhy(card).split('\n')[0]!, /fix candidate:|known intermittent:/);
    assert.match(renderReceipt(card), /fix candidate: fix \(accepted\)/);
    assert.match(renderWhy(card, { full: true }), /known intermittent:/);
    assert.doesNotMatch((await ops.brief({ cwd: r.cwd })).rejected.find(b => b.node === 'a')!.clear, /fix candidate:|known intermittent:/);
    // R-028-45: view adapters must still detect a reducer-state mismatch.
    const { compare } = await import('./perf/differential.ts'), { synthLedger } = await import('./perf/synth.ts');
    const sample = synthLedger(50, 5, 2);
    assert.equal(compare(sample.entries, sample.lookup, 10), undefined);
    const mismatch = compare(sample.entries, sample.lookup, 10, { curLookup: sha => {
      const plan = structuredClone(sample.lookup(sha)); plan.nodes[0]!.title = 'deliberate reducer-state mismatch'; return plan;
    } });
    assert.equal(mismatch?.what, 'snapshot');
    assert.notEqual(JSON.parse(mismatch!.base).state.plan.nodes[0].title, JSON.parse(mismatch!.cur).state.plan.nodes[0].title);
  } finally { await r.cleanup(); }
});

test('VW1/R-028-40: an answered asking need renders one node prefix and one retry command', async () => {
  const r = await fixture();
  try {
    const { writerLaunch } = await import('../src/drive.ts'), { projectId } = await import('../src/reducer.ts');
    const before = (await ops.readState({ cwd: r.cwd })).state, launch = writerLaunch(before, 'a', projectId(before));
    await ops.launch({ cwd: r.cwd, as: parent, ...launch });
    const rule = await ops.answerRule({ cwd: r.cwd, as: parent, node: 'a', text: 'Answer to writer question q: keep it', answer: { rid: launch.rid, qid: 'q', rev: 2 } });
    const { state, entries } = await ops.readState({ cwd: r.cwd }), ledger = await Ledger.open(r.cwd), future = Date.parse(rule.ts) + 900_000;
    await mkdir(join(ledger.dir, 'drive'), { recursive: true });
    await writeFile(join(ledger.dir, 'drive', 'asking.json'), JSON.stringify([{ node: 'a', rid: launch.rid, qid: 'q', rev: 2 }]));
    await writeFile(join(ledger.dir, 'drive.lock'), JSON.stringify({ pid: process.pid, host: 'foreign.invalid', at: new Date(now).toISOString(), token: 'asking-fixture' }));
    const status = await ops.summaryStatusView(r.cwd, ledger.dir, state, entries, future);
    const need = status.summary!.needs.find(n => n.node === 'a' && n.reason.includes('still asking'))!;
    assert.equal(need.reason, `answered at #${rule.seq} (${clockTime(rule.ts, future)}), still asking after 15m`);
    const brief = await ops.brief({ cwd: r.cwd, now: future });
    for (const text of [renderStatus(status), renderStatus(status, { full: true }), renderBrief(brief)]) {
      const line = text.split('\n').find(line => line.startsWith('  a: answered at'))!;
      assert.equal(line, `  a: ${need.reason} → ${need.command}`);
      assert.equal(line.split('owed answer').length - 1, 1); assert.doesNotMatch(line, /a: a:|retry with/);
    }
  } finally { await r.cleanup(); }
});

test('VW6: failed measurement names its stored log and distinguishes no exact name from an empty error field', async () => {
  for (const exact of [false, true]) {
    const title = exact ? 'run 1: stress case | :: suffix' : 'stress case';
    const log = `not ok 1 - ${title}\n  ---\n  location: src/value:1:1\n  ...\n`;
    const run = `printf '%s' '${log}'; echo 'owed-counts {"pass":0,"fail":1,"failed":["run 1: stress case | :: suffix"]}'; exit 1`;
    const r = await fixture({ run });
    try {
      const result = await ops.attest({ cwd: r.cwd, node: 'a' }), obs = result.observations.find(e => e.kind === 'obs' && e.obligation === 'check:stress'); assert.ok(obs?.kind === 'obs');
      const expected = exact ? `no error text: the \`not ok\` block of this name in log ${obs.log!.slice(0, 12)} has no error field` : `no error text: log ${obs.log!.slice(0, 12)} has no \`not ok\`/panic line named exactly as this failed test`;
      assert.ok(obs.note?.includes(expected), obs.note); assert.doesNotMatch(obs.note!, /\(no error text\)/);
      assert.equal(sha256(await (await Ledger.open(r.cwd)).getBlob(obs.log!)), obs.log);
      assert.deepEqual(remeasureErrorTexts(obs, (await (await Ledger.open(r.cwd)).getBlob(obs.log!)).toString()), []);
      const why = await cli(r.cwd, ['why', 'a', '--full']); assert.ok(why.stdout.includes(expected), why.stdout);
    } finally { await r.cleanup(); }
  }
});
