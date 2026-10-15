import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, existsSync } from 'node:fs';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { hostname } from 'node:os';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';
import * as ops from '../src/ops.ts';
import { Dsa } from '../src/dsa.ts';
import { Driver, procStart } from '../src/drive-run.ts';
import { driveStatus, driverLine, driveStart } from '../src/drive-bg.ts';
import { rulingMessage, writerLaunch } from '../src/drive.ts';
import { projectId } from '../src/reducer.ts';
import { Ledger, lockTimeoutText, lockWait } from '../src/ledger.ts';
import { clockTime } from '../src/clock.ts';
import { renderReceipt, renderStatus } from '../src/views.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const owner = { role: 'owner', id: 'pi' } as const, parent = { role: 'parent', id: 'test' } as const;
const spec = (id: string) => ({ id, writes: [`${id}.txt`], checks: [], review: { count: 0, min_rank: 1 } });
class Client extends Dsa {
  constructor() { super({ bin: '/bin/true' }); }
  override async inspect(rid: string) { return { view: { rid, state: 'running' as const } }; }
}
async function fixture() {
  const r = await repo();
  await commitAt(r.cwd, { seed: 'base' });
  const plan = { version: 1, trunk: 'main', lease: false, closure: [], invariants: [], nodes: [spec('a'), spec('b')] };
  await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify(plan), measure: false });
  const ledger = await Ledger.open(r.cwd), dir = join(ledger.dir, 'drive');
  await mkdir(dir, { recursive: true });
  return { ...r, plan, ledger, dir };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function candidate(f: Fixture, id: string, accept = true) {
  const slot = await ops.dispatch({ cwd: f.cwd, as: parent, node: id });
  const state = (await ops.readState(f)).state;
  const launch = writerLaunch(state, id, projectId(state));
  await ops.launch({ cwd: f.cwd, as: parent, ...launch });
  await commitAt(slot.worktree, { [`${id}.txt`]: id });
  await ops.submit({ cwd: slot.worktree, as: { role: 'writer', id: `${id}#1` }, node: id });
  if (accept) assert.equal((await ops.attest({ cwd: f.cwd, node: id })).accepted, true);
  return slot;
}
async function running(f: Fixture, lines: object[] = []) {
  const at = new Date().toISOString();
  await writeFile(join(f.ledger.dir, 'drive.lock'), JSON.stringify({ pid: process.pid, host: hostname(), start: procStart(process.pid), at, token: 'fixture' }));
  await writeFile(join(f.dir, 'log.jsonl'), lines.map(l => JSON.stringify(l) + '\n').join(''));
}
async function waitRecord(f: Fixture, id: string, extra: object = {}) {
  const n = (await ops.readState(f)).state.nodes[id]!;
  const wait = { attempt: n.slot!.attempt, candidate: n.candidate?.seq, reason: 'machine lease busy', since: new Date().toISOString(), ...extra };
  await writeFile(join(f.dir, 'waiting.json'), JSON.stringify({ [id]: wait }));
  return wait;
}
async function localTime<T>(body: () => Promise<T>) {
  const prior = process.env.TZ; process.env.TZ = 'Asia/Shanghai';
  try { return await body(); } finally { if (prior === undefined) delete process.env.TZ; else process.env.TZ = prior; }
}
async function untilFile(path: string) {
  const end = Date.now() + 15_000;
  while (!existsSync(path) && Date.now() < end) await new Promise(r => setTimeout(r, 20));
  assert.ok(existsSync(path), `measurement did not reach ${path}`);
}

// Fixed UTC instants prove rendering uses the reader's TZ, not a driver's previously formatted reason.
test('LO1: structured jobSince uses local time in CLI status/why; legacy reasons render as recorded', async () => localTime(async () => {
  const f = await fixture(), at = '2026-01-02T03:04:00.000Z';
  try {
    await candidate(f, 'a'); await candidate(f, 'b');
    await running(f, [{ do: 'merge', node: 'a', outcome: 'started', at }]);
    await waitRecord(f, 'b', { reason: 'driver-internal job', job: 'a merge', jobSince: at });
    for (const args of [['status'], ['status', '--full'], ['why', 'b']]) {
      const out = await cli(f.cwd, args); assert.equal(out.code, 0, out.stderr);
      assert.ok(out.stdout.includes(`driver-internal job (a merge, since ${clockTime(at)})`), out.stdout);
      assert.doesNotMatch(out.stdout, /T03:04:00/);
    }
    const json = await cli(f.cwd, ['status', '--json']); assert.equal(json.code, 0, json.stderr);
    assert.equal(JSON.parse(json.stdout).mergeWaiting.b.jobSince, at);
    const legacy = 'driver-internal job (a merge, since 03:04)';
    await waitRecord(f, 'b', { reason: legacy, job: 'a merge' });
    assert.ok(renderStatus(await ops.status(f)).includes(legacy));
    assert.equal((await ops.status(f)).mergeWaiting!.b!.jobSince, undefined);
  } finally { await f.cleanup(); }
}));

test('LO1: drive status, refusal and ledger/merge lock owners format times while JSON keeps ISO', async () => localTime(async () => {
  const f = await fixture(), at = '2026-01-02T03:04:00.000Z', shown = clockTime(at);
  try {
    await running(f, [{ do: 'attest', node: 'a', outcome: 'started', at }]);
    const lock = JSON.parse(await readFile(join(f.ledger.dir, 'drive.lock'), 'utf8'));
    await writeFile(join(f.ledger.dir, 'drive.lock'), JSON.stringify({ ...lock, at }));
    const status = await cli(f.cwd, ['drive', '--status']); assert.equal(status.code, 0, status.stderr);
    assert.ok(status.stdout.includes(`since ${shown}`)); assert.doesNotMatch(status.stdout, /T03:04:00/);
    assert.ok((await driverLine(f.cwd)).includes(`since ${shown}`));
    const json = await driveStatus(f); assert.equal(json.since, at); assert.equal(json.measuring![0]!.since, at);
    await assert.rejects(driveStart(f), e => { assert.ok((e as Error).message.includes(`since ${shown}`)); return true; });
    assert.ok(lockTimeoutText('lock', { pid: process.pid, host: hostname(), ts: at }).includes(`since ${shown}`));
    await candidate(f, 'a');
    await mkdir(join(f.ledger.dir, 'merge'));
    await writeFile(join(f.ledger.dir, 'merge', 'owner.json'), JSON.stringify({ pid: process.pid, host: hostname(), ts: at, activity: 'merge b', activitySince: at }));
    const previousWait = lockWait.ms; lockWait.ms = 5;
    try { await assert.rejects(ops.merge({ cwd: f.cwd, as: parent, node: 'a' }), e => {
      assert.ok((e as Error).message.includes(`since ${shown}`), (e as Error).message);
      assert.doesNotMatch((e as Error).message, /T03:04:00/); return true;
    }); } finally { lockWait.ms = previousWait; }
  } finally { await f.cleanup(); }
}));

for (const what of ['merge', 'attest'] as const) test(`LO2: own ${what} start clears cached wait and status/summary/why show work in flight`, { timeout: 120_000 }, async () => {
  const f = await fixture(), mark = join(f.root, 'started'), gate = join(f.root, 'gate');
  let driver: Driver | undefined;
  try {
    await candidate(f, 'a', what === 'merge');
    const slow = { id: 'slow', reads: ['a.txt'], run: `echo started > '${mark}'; while [ ! -f '${gate}' ]; do sleep 0.05; done`, timeout_s: 30 };
    const plan = what === 'merge' ? { ...f.plan, invariants: [slow] } : { ...f.plan, nodes: [{ ...spec('a'), checks: [slow] }, spec('b')] };
    await ops.planSet({ cwd: f.cwd, as: parent, plan: JSON.stringify(plan) });
    await waitRecord(f, 'a'); await running(f);
    driver = new Driver({ cwd: f.cwd, dsa: new Client(), json: true, log: line => appendFileSync(join(f.dir, 'log.jsonl'), line + '\n'), handleSignals: false });
    const pass = await driver.pass();
    assert.ok(pass.actions.some(a => a.node === 'a' && a.do === what && a.outcome === 'started'), JSON.stringify(pass.actions));
    await untilFile(mark);
    const cache = JSON.parse(await readFile(join(f.dir, 'waiting.json'), 'utf8'));
    assert.equal(cache.a, undefined, 'clear at start, while measurement is still blocked');
    const view = await ops.status(f), phase = what === 'merge' ? 'merging' : 'measuring';
    assert.ok(view.summary!.progress.find(p => p.node === 'a')!.phase.startsWith(`${phase} (since `));
    assert.equal(view.mergeWaiting?.a, undefined);
    for (const args of [['status'], ['status', '--full'], ['why', 'a']]) {
      const out = await cli(f.cwd, args); assert.equal(out.code, 0, out.stderr);
      assert.match(out.stdout, new RegExp(`a: ${phase} \\(since `));
      assert.doesNotMatch(out.stdout, /a: .*waiting for|a: .*machine lease busy/);
    }
  } finally { await writeFile(gate, ''); driver?.abort.abort(); await driver?.settle(); await f.cleanup(); }
});

test('LO1/LO2: new wait cache stores job and ISO jobSince separately; finished jobs disappear before next pass', { timeout: 120_000 }, async () => {
  const f = await fixture(), mark = join(f.root, 'started'), gate = join(f.root, 'gate');
  let driver: Driver | undefined;
  try {
    await candidate(f, 'a'); await candidate(f, 'b');
    await ops.planSet({ cwd: f.cwd, as: parent, plan: JSON.stringify({ ...f.plan, invariants: [{ id: 'slow', reads: ['*.txt'], timeout_s: 30, run: `echo started > '${mark}'; while [ ! -f '${gate}' ]; do sleep 0.05; done` }] }) });
    await running(f);
    driver = new Driver({ cwd: f.cwd, dsa: new Client(), json: true, log: line => appendFileSync(join(f.dir, 'log.jsonl'), line + '\n'), handleSignals: false });
    await driver.pass(); await untilFile(mark);
    const cache = JSON.parse(await readFile(join(f.dir, 'waiting.json'), 'utf8'));
    assert.equal(cache.b.reason, 'driver-internal job'); assert.equal(cache.b.job, 'a merge');
    assert.ok(Number.isFinite(Date.parse(cache.b.jobSince))); assert.doesNotMatch(cache.b.reason, /since/);
    assert.ok((await ops.status(f)).mergeWaiting?.b);
    await writeFile(gate, ''); await driver.settle();
    assert.equal((await ops.status(f)).mergeWaiting?.b, undefined, 'completion is checked at read time');
    assert.doesNotMatch(renderReceipt(await ops.why({ ...f, node: 'b' })), /driver-internal job/);
  } finally { await writeFile(gate, ''); driver?.abort.abort(); await driver?.settle(); await f.cleanup(); }
});

test('LO2: stopped, finished and replaced jobs cannot revive a stale wait; non-job busy remains visible', async () => {
  const f = await fixture(), at = '2026-01-02T03:04:00.000Z';
  try {
    await candidate(f, 'b');
    const wait = { reason: 'driver-internal job', job: 'a merge', jobSince: at };
    await waitRecord(f, 'b', wait);
    assert.equal((await ops.status(f)).mergeWaiting?.b, undefined, 'no driver');
    await running(f, [{ do: 'merge', node: 'a', outcome: 'started', at }, { do: 'merge', node: 'a', outcome: 'merged' }]);
    assert.equal((await ops.status(f)).mergeWaiting?.b, undefined, 'finished');
    await running(f, [{ do: 'merge', node: 'a', outcome: 'started', at: '2026-01-02T04:04:00.000Z' }]);
    assert.equal((await ops.status(f)).mergeWaiting?.b, undefined, 'same label but newer job');
    await rm(join(f.ledger.dir, 'drive.lock'));
    await waitRecord(f, 'b');
    assert.equal((await ops.status(f)).mergeWaiting!.b!.reason, 'machine lease busy');
  } finally { await f.cleanup(); }
});

for (const what of ['merge', 'attest'] as const) test(`LO-W2: ${what} keeps its first busy end across retries and resets after non-busy work or a new candidate`, { timeout: 120_000 }, async () => {
  const f = await fixture();
  class BusyClient extends Client {
    busy = true;
    before?: () => Promise<void>;
    private async result() {
      await this.before?.();
      return this.busy ? { outcome: 'busy' as const, reason: 'machine lease busy in fixture' }
        : { outcome: 'refused' as const, reason: 'fixture non-busy refusal' };
    }
    override async hold() { return this.result(); }
    override async holdWhile<T>() { return this.result(); }
  }
  const dsa = new BusyClient();
  let driver: Driver | undefined, release: (() => void) | undefined;
  try {
    const slot = await candidate(f, 'a', what === 'merge');
    await ops.planSet({ cwd: f.cwd, as: parent, plan: JSON.stringify({ ...f.plan, lease: true }) });
    await running(f);
    const old = await waitRecord(f, 'a', { since: '2020-01-01T00:00:00.000Z' });
    driver = new Driver({ cwd: f.cwd, dsa, json: true, log: l => appendFileSync(join(f.dir, 'log.jsonl'), l + '\n'), handleSignals: false });
    const cached = async () => JSON.parse(await readFile(join(f.dir, 'waiting.json'), 'utf8')).a;
    await driver.pass(); await driver.settle();
    const first = await cached();
    assert.match(first.reason, /machine lease busy/); assert.notEqual(first.since, old.since);
    const view = await ops.status(f); assert.equal(view.measuring?.a, undefined);
    assert.match(view.summary!.progress.find(p => p.node === 'a')!.phase, /waiting for .*machine lease busy/);

    let enter!: () => void;
    const entered = new Promise<void>(r => { enter = r; }), gate = new Promise<void>(r => { release = r; });
    dsa.before = async () => { enter(); await gate; };
    driver.tick(); await driver.pass(); await entered;
    assert.equal(await cached(), undefined, 'a retry clears the visible cache while measuring');
    assert.equal((await ops.status(f)).mergeWaiting?.a, undefined);
    release!(); dsa.before = undefined; await driver.settle();
    assert.equal((await cached()).since, first.since, 'the repeated busy end restores the original start');

    dsa.busy = false;
    driver.tick(); await driver.pass(); await driver.settle();
    assert.equal(await cached(), undefined, 'a non-busy end clears the visible wait');
    await ops.resume({ cwd: f.cwd, as: parent, node: 'a', note: 'retry after fixture refusal' });
    dsa.busy = true;
    driver.tick(); await driver.pass(); await driver.settle();
    const afterNonBusy = await cached();
    assert.ok(Date.parse(afterNonBusy.since) > Date.parse(first.since), 'a non-busy end resets the cumulative start');

    await commitAt(slot.worktree, { 'a.txt': 'new candidate' });
    await ops.submit({ cwd: slot.worktree, as: { role: 'writer', id: 'a#1' }, node: 'a' });
    if (what === 'merge') await ops.attest({ cwd: f.cwd, node: 'a', lease: false });
    driver.tick(); await driver.pass(); await driver.settle();
    assert.ok(Date.parse((await cached()).since) > Date.parse(afterNonBusy.since), 'a new candidate resets the cumulative start');
  } finally { release?.(); driver?.abort.abort(); await driver?.settle(); await f.cleanup(); }
});

function tool(cwd: string) {
  const tools = new Map<string, ToolDefinition>();
  owed({ registerTool(t: ToolDefinition) { tools.set(t.name, t); }, registerCommand() {} } as unknown as ExtensionAPI);
  const ctx = { cwd, hasUI: false } as unknown as ExtensionContext;
  return (args: object) => tools.get('owed_rule')!.execute('test', args, undefined, undefined, ctx as Parameters<ToolDefinition['execute']>[4]);
}
async function fakeDsa(f: Fixture, state: 'sealed' | 'running') {
  const bin = join(f.root, 'dsa.cjs'), messages = join(f.root, 'messages.jsonl'), prior = process.env.OWED_DSA;
  await writeFile(bin, `#!${process.execPath}\nconst fs=require('node:fs');const args=process.argv.slice(2);const value=k=>args[args.indexOf(k)+1];
if(args[0]==='describe') console.log(JSON.stringify({state:${JSON.stringify(state)},status:'ok'}));
else if(args[0]==='send') {fs.appendFileSync(${JSON.stringify(messages)},JSON.stringify(fs.readFileSync(value('--message').slice(1),'utf8'))+'\\n');if(value('--to').includes(':b:')) {console.log(JSON.stringify({reason:'transport unavailable'}));process.exit(1);} console.log(JSON.stringify({outcome:'applied',spec_digest:'fixture'}));}
else process.exit(1);\n`);
  await chmod(bin, 0o755); process.env.OWED_DSA = bin;
  return { messages, restore() { if (prior === undefined) delete process.env.OWED_DSA; else process.env.OWED_DSA = prior; } };
}
const ruling = 'Use this exact text\nwith literal \\0 and "quotes"';
test('LO3/LO-W4: unknown-writer receipts lead to pending rulings in why until the writer submits again', async () => {
  const f = await fixture();
  try {
    const prior = 'Already in the dispatch packet';
    await ops.rule({ cwd: f.cwd, as: parent, nodes: ['a'], text: prior });
    const slot = await ops.dispatch({ cwd: f.cwd, as: parent, node: 'a' });
    await commitAt(slot.worktree, { 'a.txt': 'first candidate' });
    await ops.submit({ cwd: slot.worktree, as: { role: 'writer', id: 'a#1' }, node: 'a' });
    const text = await cli(f.cwd, ['rule', ruling, '--nodes', 'a']); assert.equal(text.code, 0, text.stderr);
    assert.match(text.stdout, /^Recorded #\d+ ruling \(a\); delivered 0\/1\na: writer call unknown; owed why a shows the ruling to forward\n$/);
    assert.doesNotMatch(text.stdout, /Use this exact text|follow-up|Active blocks/);
    const json = await cli(f.cwd, ['rule', ruling, '--nodes', 'a', '--json']); assert.equal(json.code, 0, json.stderr);
    const result = JSON.parse(json.stdout); assert.equal(result.text, ruling);
    const followUp = result.delivery.slots[0].followUp;
    assert.equal(typeof followUp, 'string'); assert.ok(followUp.includes(ruling), followUp);
    assert.ok(!followUp.includes('text\\nwith literal \\\\0'), followUp);
    const why = await cli(f.cwd, ['why', 'a']); assert.equal(why.code, 0, why.stderr);
    assert.match(why.stdout, /Ruling to forward:/); assert.ok(why.stdout.includes(ruling));
    assert.ok(!why.stdout.includes(prior), why.stdout);

    await commitAt(slot.worktree, { 'a.txt': 'resubmitted after manual forwarding' });
    await ops.submit({ cwd: slot.worktree, as: { role: 'writer', id: 'a#1' }, node: 'a' });
    assert.equal((await ops.why({ cwd: f.cwd, node: 'a' })).rulingFollowUp, undefined);
    for (const args of [['why', 'a'], ['why', 'a', '--full']]) {
      const after = await cli(f.cwd, args); assert.equal(after.code, 0, after.stderr);
      assert.doesNotMatch(after.stdout, /Ruling to forward:|Use this exact text|New parent rulings/);
    }
    const latest = await ops.rule({ cwd: f.cwd, as: parent, nodes: ['a'], text: 'Only this newer ruling remains' });
    assert.equal((await ops.why({ cwd: f.cwd, node: 'a' })).rulingFollowUp, rulingMessage('a', 'writer', (await ops.readState(f)).state.rules.filter(r => r.seq === latest.seq)));
  } finally { await f.cleanup(); }
});

test('LO-W4: a failed delivery of only a global ruling remains available in why', async () => {
  const f = await fixture(), dsa = await fakeDsa(f, 'running');
  try {
    const prior = 'Already carried by the writer launch', pending = 'Global ruling not delivered\nwith literal \\0';
    await ops.rule({ cwd: f.cwd, as: parent, nodes: ['b'], text: prior });
    await candidate(f, 'b');
    const result = await tool(f.cwd)({ nodes: '*', text: pending });
    const text = result.content.map(c => c.type === 'text' ? c.text : '').join('\n');
    assert.match(text, /^Recorded #\d+ ruling \(all nodes\); delivered 0\/2\nb: .*transport unavailable; owed why b shows the ruling to forward$/);
    const details = result.details as Awaited<ReturnType<typeof ops.rule>>;
    assert.equal((await ops.why({ cwd: f.cwd, node: 'b' })).rulingFollowUp, rulingMessage('b', 'writer', (await ops.readState(f)).state.rules.filter(r => r.seq === details.seq)));
    for (const args of [['why', 'b'], ['why', 'b', '--full']]) {
      const why = await cli(f.cwd, args); assert.equal(why.code, 0, why.stderr);
      assert.match(why.stdout, /Ruling to forward:/); assert.ok(why.stdout.includes(pending));
      assert.ok(!why.stdout.includes(prior), why.stdout);
    }
  } finally { dsa.restore(); await f.cleanup(); }
});

test('LO-W4: why shows only undelivered rulings for a launched writer and removes them after delivery', async () => {
  const f = await fixture();
  const dsa = { async describe(rid: string) { return { rid, state: 'sealed' as const }; }, async send() { throw new Error('sealed writer'); } };
  try {
    await candidate(f, 'a', false);
    const rule = await ops.rule({ cwd: f.cwd, as: parent, nodes: ['a'], text: ruling, writer: true, dsa });
    const before = await ops.why({ cwd: f.cwd, node: 'a' });
    assert.equal(before.rulingFollowUp, rulingMessage('a', 'writer', (await ops.readState(f)).state.rules.filter(r => r.seq === rule.seq)));
    const text = await cli(f.cwd, ['why', 'a']); assert.equal(text.code, 0, text.stderr);
    assert.ok(text.stdout.includes('Ruling to forward:\n')); assert.ok(text.stdout.includes(ruling));
    const state = (await ops.readState(f)).state, rid = state.nodes.a!.runs[0]!.launches.find(l => l.role === 'writer')!.rid;
    await ops.send({ cwd: f.cwd, as: parent, node: 'a', attempt: 1, rid, sendKind: 'follow-up', reason: 'ruling', rulings: rule.seq, message: before.rulingFollowUp! });
    assert.equal((await ops.why({ cwd: f.cwd, node: 'a' })).rulingFollowUp, undefined);
    for (const args of [['why', 'a'], ['why', 'a', '--full']]) {
      const after = await cli(f.cwd, args); assert.equal(after.code, 0, after.stderr);
      assert.doesNotMatch(after.stdout, /Ruling to forward:|Use this exact text|New parent rulings/);
    }
    const latest = await ops.rule({ cwd: f.cwd, as: parent, nodes: ['a'], text: 'Only the new undelivered ruling', writer: true, dsa });
    assert.equal((await ops.why({ cwd: f.cwd, node: 'a' })).rulingFollowUp, rulingMessage('a', 'writer', (await ops.readState(f)).state.rules.filter(r => r.seq === latest.seq)));
  } finally { await f.cleanup(); }
});

test('LO3: pi owed_rule omits status/ruling/block quotes and keeps full raw follow-up in details', async () => {
  const f = await fixture(), dsa = await fakeDsa(f, 'sealed');
  try {
    await ops.planSet({ cwd: f.cwd, as: parent, plan: JSON.stringify({ ...f.plan, nodes: [{ ...spec('a'), review: { count: 1, min_rank: 1 } }, spec('b')] }) });
    await candidate(f, 'a', false);
    await ops.review({ cwd: f.cwd, as: { role: 'reviewer', id: 'independent' }, node: 'a', verdict: 'block', rank: 1, note: 'Private active-block quote' });
    const result = await tool(f.cwd)({ nodes: ['a'], text: ruling });
    const text = result.content.map(c => c.type === 'text' ? c.text : '').join('\n');
    assert.match(text, /^Recorded #\d+ ruling \(a\); delivered 0\/2$/);
    const details = result.details as Awaited<ReturnType<typeof ops.rule>>;
    assert.ok(details.delivery!.slots![0]!.followUp.includes(ruling));
    assert.ok(details.delivery!.slots![0]!.followUp.includes('Private active-block quote'));
    assert.doesNotMatch(text, /Use this exact text|Details:|owed:|Active blocks|Private active-block quote/);
  } finally { dsa.restore(); await f.cleanup(); }
});

test('LO3: delivery counts and failure notices are concise, while live messages retain literal newlines', async () => {
  const f = await fixture(), dsa = await fakeDsa(f, 'running');
  try {
    await candidate(f, 'a'); await candidate(f, 'b');
    const result = await tool(f.cwd)({ nodes: ['a', 'b'], text: ruling });
    const text = result.content.map(c => c.type === 'text' ? c.text : '').join('\n');
    assert.match(text, /^Recorded #\d+ ruling \(a, b\); delivered 1\/2\nb: .*transport unavailable; owed why b shows the ruling to forward$/);
    const sent = (await readFile(dsa.messages, 'utf8')).trim().split('\n').map(s => JSON.parse(s) as string);
    assert.equal(sent.length, 2); assert.ok(sent.every(s => s.includes(ruling)));
    assert.doesNotMatch(text, /Use this exact text/);
  } finally { dsa.restore(); await f.cleanup(); }
});
