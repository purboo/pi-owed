// PK1-PK4: decisions and answers reuse report resumes and the existing single-wake parking path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import * as ops from '../src/ops.ts';
import { Dsa } from '../src/dsa.ts';
import { Driver } from '../src/drive-run.ts';
import { Follower } from '../src/drive-bg.ts';
import { decide as policy, writerLaunch } from '../src/drive.ts';
import { projectId, resumeOf } from '../src/reducer.ts';
import { WRITER_DECISION } from '../src/rebase-view.ts';
import { Ledger } from '../src/ledger.ts';
import owed from '../src/extension.ts';
import type { RunView } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli } from './helpers/surface.ts';

const parent = { role: 'parent', id: 'test' } as const;
const parking = { expect: 'report' as const };
const sentence = 'When a ruling tells you to stop, pause or wait for a parent prerequisite, do not ask to confirm it; state your status and end your turn.';
class FakeDsa extends Dsa {
  state: RunView['state'] = 'running';
  generation = 0;
  sent = new Map<string, number>();
  failAnswer = false;
  override async describe(rid: string): Promise<RunView> { return this.view(rid); }
  view(rid: string): RunView { return { rid, state: this.state, status: 'ok', result: 'Paused until the parent prerequisite is ready.', ...(this.state === 'asking' ? { questions: [{ qid: 'q1', rev: 1, question: 'Which prerequisite?', to: 'w/main' }] } : {}) }; }
  override async inspect(rid: string) { return { view: this.view(rid), gen: this.generation }; }
  override async run() { return { outcome: 'applied' as const, wid: 'w', created: true, spec_digest: 's' }; }
  override async send(id: string, _rid: string, kind: string) {
    if (kind === 'answer' && this.failAnswer) throw new Error('answer transport failed');
    if (kind !== 'notify') {
      if (!this.sent.has(id)) { this.sent.set(id, ++this.generation); this.state = 'running'; }
    }
    return { outcome: 'applied' as const, generation: this.sent.get(id), spec_digest: 's' };
  }
  override async request() { return { state: 'applied' as const }; }
}
async function fixture() {
  const r = await repo(), plan = JSON.stringify({ version: 1, trunk: 'main', lease: false, closure: [], invariants: [], drive: { max: 1 }, nodes: [{ id: 'a', writes: ['a.txt'], checks: [], review: { count: 0, min_rank: 1 } }, { id: 'b', writes: ['b.txt'], checks: [], later: true }] });
  await r.put('plan.json', plan); await r.commit();
  await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'pi' }, channel: 'delegated', plan, measure: false });
  const slot = await ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' });
  const state = (await ops.readState(r)).state, launch = writerLaunch(state, 'a', projectId(state));
  await ops.launch({ cwd: r.cwd, as: parent, ...launch });
  const dsa = new FakeDsa({ bin: join(r.root, 'unused-dsa') });
  return { ...r, slot, launch, dsa };
}

for (const act of ['decide', 'answer'] as const) test(`PK1: ${act} records a report resume, seals to one wake, stays quiet and a named rule unparks`, async () => {
  const f = await fixture(); let driver: Driver | undefined; let follower: Follower | undefined;
  try {
    f.dsa.state = act === 'answer' ? 'asking' : 'running';
    if (act === 'decide') await ops.decide({ cwd: f.cwd, as: parent, nodes: ['a'], text: 'Pause until the prerequisite is ready', dsa: f.dsa, ...parking });
    else await ops.answer({ cwd: f.cwd, as: parent, node: 'a', text: 'Pause until the prerequisite is ready', dsa: f.dsa, ...parking });
    let state = (await ops.readState(f)).state;
    const resume = resumeOf(state, 'a'); assert.equal(resume?.expect, 'report');
    const log = join(f.root, 'driver.jsonl'); await writeFile(log, '');
    follower = new Follower({ log, repo: f.cwd, pid: process.pid, from: 0, deliver() {} });
    const logs: string[] = [];
    driver = new Driver({ cwd: f.cwd, max: 1, once: true, dsa: f.dsa, json: true, log: line => { logs.push(line); } });
    f.dsa.state = 'sealed';
    const first = await driver.pass(); assert.ok(first.actions.some(a => a.do === 'send' && a.reason === 'report'));
    f.dsa.state = 'running'; await driver.pass();
    assert.equal((await ops.status(f)).nodes.a!.halt, undefined);
    f.dsa.state = 'sealed';
    const reported = await driver.pass(); assert.ok(reported.actions.some(a => a.do === 'notify' && a.reportedResume === resume!.seq));
    await writeFile(log, logs.join('\n') + '\n');
    const wake = follower.tick(); assert.ok(wake); assert.match(wake, /review the reported findings/); assert.match(wake, /Paused until the parent prerequisite/);
    const count = (await (await Ledger.open(f.cwd)).read()).length;
    for (let i = 0; i < 3; i++) { const quiet = await driver.pass(); assert.equal(quiet.actions.filter(a => a.node === 'a').length, 0); }
    await writeFile(log, logs.join('\n') + '\n'); assert.equal(follower.tick(), undefined);
    assert.equal((await (await Ledger.open(f.cwd)).read()).length, count, 'no extra halt/send/ledger entry');
    assert.deepEqual((await ops.status(f)).reported, [{ node: 'a', resume: resume!.seq }]);
    assert.equal((await ops.status(f)).nodes.a!.halt, undefined);
    await ops.rule({ cwd: f.cwd, as: parent, nodes: ['b'], text: 'Unrelated guidance', dsa: f.dsa });
    assert.deepEqual((await ops.status(f)).reported, [{ node: 'a', resume: resume!.seq }]);
    await ops.rule({ cwd: f.cwd, as: parent, nodes: ['a'], text: 'The prerequisite is ready; continue', dsa: f.dsa });
    state = (await ops.readState(f)).state;
    assert.deepEqual((await ops.status(f)).reported, []);
    assert.ok(policy(state, state.plan, new Map([[f.launch.rid, f.dsa.view(f.launch.rid)]]), { max: 1, repairs: 2, project: projectId(state), root: f.cwd, applied: new Set(state.nodes.a!.runs[0]!.sends.map(s => s.send)), rejected: new Map() }).some(a => a.node === 'a'));
  } finally { follower?.stop(); if (driver) { driver.stopping = true; driver.abort.abort(); await driver.settle(); } await f.cleanup(); }
});

test('PK1: decide refuses no-resume/report, invalid expectations and report on a node with no open resume target atomically', async () => {
  const f = await fixture();
  try {
    const ledger = await Ledger.open(f.cwd), before = await ledger.read();
    for (const args of [{ resume: false, ...parking }, { expect: 'candidate' }, { nodes: ['a', 'b'], ...parking }]) {
      await assert.rejects(ops.decide({ cwd: f.cwd, as: parent, nodes: ['a'], text: 'Pause', dsa: f.dsa, ...args } as ops.DecideArgs), /expect|open slot/);
      assert.deepEqual(await ledger.read(), before, 'refusal records no rule or partial batch');
    }
    const cliResult = await cli(f.cwd, ['decide', 'a', '--no-resume', '--expect', 'report', '--text', 'Pause']);
    assert.equal(cliResult.code, 2); assert.match(cliResult.stderr, /no-resume.*expect/);
    assert.deepEqual(await ledger.read(), before);
  } finally { await f.cleanup(); }
});

test('PK1: answer/report persists before failed delivery; exact and concurrent retries reuse one rule and resume', async () => {
  const f = await fixture();
  try {
    f.dsa.state = 'asking'; f.dsa.failAnswer = true;
    const args = { cwd: f.cwd, as: parent, node: 'a', text: 'Pause', dsa: f.dsa, ...parking };
    await assert.rejects(ops.answer(args), /recorded.*answer transport failed/);
    const ledger = await Ledger.open(f.cwd), before = await ledger.read();
    assert.equal(before.filter(e => e.kind === 'rule').length, 1);
    assert.equal(before.filter(e => e.kind === 'resume').length, 1);
    assert.equal(resumeOf((await ops.readState(f)).state, 'a')?.expect, 'report');
    f.dsa.failAnswer = false;
    const results = await Promise.all([ops.answer({ ...args, qid: 'q1', rid: f.launch.rid }), ops.answer({ ...args, qid: 'q1', rid: f.launch.rid })]);
    assert.equal(results[0]!.entry.seq, results[1]!.entry.seq); assert.equal(results[0]!.request, results[1]!.request);
    assert.deepEqual(await ledger.read(), before);
    assert.equal((await ops.verify(f)).ok, true);
  } finally { await f.cleanup(); }
});

test('PK1: a report retry cannot silently add a resume to an earlier plain answer', async () => {
  const f = await fixture();
  try {
    f.dsa.state = 'asking';
    const args = { cwd: f.cwd, as: parent, node: 'a', text: 'Pause', dsa: f.dsa };
    await ops.answer(args);
    const ledger = await Ledger.open(f.cwd), before = await ledger.read();
    await assert.rejects(ops.answer({ ...args, qid: 'q1', rid: f.launch.rid, ...parking }), /expect report.*resume/);
    assert.deepEqual(await ledger.read(), before);
    await assert.rejects(ops.answer({ ...args, expect: 'candidate' } as Parameters<typeof ops.answer>[0]), /expect.*report/);
  } finally { await f.cleanup(); }
});

const externalScript = `#!/usr/bin/env node
import {readFileSync,writeFileSync} from 'node:fs';
const args=process.argv.slice(2), get=k=>args[args.indexOf(k)+1], file=process.env.PARK_STATE, s=JSON.parse(readFileSync(file));
if(args[0]==='describe') console.log(JSON.stringify(s));
else if(args[0]==='send') { if(get('--kind')==='answer') { s.state='running'; delete s.questions; writeFileSync(file,JSON.stringify(s)); } console.log(JSON.stringify({spec_digest:'s'})); }
else process.exit(1);
`;
function tools(cwd: string) {
  const registered = new Map<string, ToolDefinition>();
  owed({ registerTool(t: ToolDefinition) { registered.set(t.name, t); }, registerCommand() {}, on() {} } as unknown as ExtensionAPI);
  const ctx = { cwd, hasUI: false, ui: { async confirm() { return false; }, notify() {} } } as unknown as ExtensionContext;
  return async (name: string, args: Record<string, unknown>) => {
    const tool = registered.get(`owed_${name}`)!;
    return tool.execute('pk-test', args, undefined, undefined, ctx) as ReturnType<ToolDefinition['execute']>;
  };
}
for (const surface of ['CLI', 'tool'] as const) for (const act of ['decide', 'answer'] as const) test(`PK1: ${surface} ${act} accepts report through the real worker/CLI seam`, async () => {
  const f = await fixture(), prior = { OWED_DSA: process.env.OWED_DSA, PARK_STATE: process.env.PARK_STATE };
  try {
    const bin = join(f.root, 'dsa.mjs'), stateFile = join(f.root, 'dsa.json'); await writeFile(bin, externalScript); await chmod(bin, 0o755);
    await writeFile(stateFile, JSON.stringify({ state: act === 'answer' ? 'asking' : 'running', questions: act === 'answer' ? [{ qid: 'q1', rev: 1, text: 'Which prerequisite?', to: 'w/main' }] : [] }));
    process.env.OWED_DSA = bin; process.env.PARK_STATE = stateFile;
    if (surface === 'CLI') { const r = await cli(f.cwd, [act, 'a', '--expect', 'report', ...(act === 'decide' ? ['--text', 'Pause'] : ['Pause']), '--json']); assert.equal(r.code, 0, r.stderr); }
    else { const r = await tools(f.cwd)(act, { ...(act === 'decide' ? { nodes: ['a'] } : { node: 'a' }), text: 'Pause', ...parking }); assert.notEqual((r as { isError?: boolean }).isError, true, JSON.stringify(r)); }
    assert.equal(resumeOf((await ops.readState(f)).state, 'a')?.expect, 'report');
    assert.equal((await ops.verify(f)).ok, true);
  } finally { for (const [k, v] of Object.entries(prior)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } await f.cleanup(); }
});

test('PK2: writer packet and its documented copy include the quiet-stop instruction', async () => {
  const f = await fixture();
  try {
    assert.ok(WRITER_DECISION.includes(sentence)); assert.ok(f.slot.packet.includes(sentence));
    assert.ok((await readFile(new URL('../docs/SPEC.md', import.meta.url), 'utf8')).includes(WRITER_DECISION));
  } finally { await f.cleanup(); }
});

test('PK3: a finished ruling follow-up without a submit names the explicit parking form', async () => {
  const f = await fixture();
  try {
    f.dsa.state = 'sealed';
    await ops.decide({ cwd: f.cwd, as: parent, nodes: ['a'], text: 'Pause for the prerequisite', writer: true, dsa: f.dsa });
    let s = (await ops.readState(f)).state;
    const opts = () => ({ max: 1, repairs: 2, project: projectId(s), root: f.cwd, applied: new Set(s.nodes.a!.runs[0]!.sends.map(x => x.send)), rejected: new Map(), writerWork: new Map([['a', { head: s.nodes.a!.slot!.base, dirty: false }]]) });
    const follow = policy(s, s.plan, new Map([[f.launch.rid, f.dsa.view(f.launch.rid)]]), opts()).find(a => a.node === 'a');
    assert.ok(follow?.do === 'send' && follow.reason === 'ruling');
    await ops.send({ cwd: f.cwd, as: parent, ...follow });
    s = (await ops.readState(f)).state;
    const halt = policy(s, s.plan, new Map([[f.launch.rid, f.dsa.view(f.launch.rid)]]), opts()).find(a => a.node === 'a');
    assert.ok(halt?.do === 'halt'); assert.match(halt.reason, /finished ruling follow-up.*without submitting/);
    assert.ok(halt.reason.includes('owed decide a --expect report --text'), halt.reason);
  } finally { await f.cleanup(); }
});
