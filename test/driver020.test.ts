// DR1–DR4: real ledger/CLI/driver behavior; no synthetic acceptance shortcuts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import { Driver } from '../src/drive-run.ts';
import { Dsa, type SendResult } from '../src/dsa.ts';
import { writerLaunch, rulingFollowUp } from '../src/drive.ts';
import { projectId, runId, runLabels } from '../src/reducer.ts';
import * as answers from '../src/answer.ts';
import { renderStatus } from '../src/views.ts';
import type { RunView } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';
const parent = { role: 'parent', id: 'test' } as const;
const owner = { role: 'owner', id: 'pi' } as const;
const node = (id: string, deps: string[] = [], extra = {}) => ({ id, deps, writes: [`${id}.txt`], checks: [], review: { count: 0, min_rank: 1 }, ...extra });
class Client extends Dsa {
  views = new Map<string, RunView>();
  sends: { to: string; kind: string; message: string }[] = [];
  fail = new Set<string>();
  constructor() { super({ bin: '/bin/true' }); }
  override async describe(rid: string): Promise<RunView> { return this.views.get(rid) ?? { rid, state: 'sealed', status: 'ok' }; }
  override async inspect(rid: string) { return { view: await this.describe(rid) }; }
  override async request(_id: string) { return { state: 'applied' as const }; }
  override async send(_id: string, to: string, kind: string, message: string | Uint8Array): Promise<SendResult> {
    this.sends.push({ to, kind, message: String(message) });
    if (this.fail.has(to)) return { outcome: 'rejected', reason: 'offline' };
    return { outcome: 'applied', spec_digest: 'digest' };
  }
}
async function fixture(nodes: object[], extra: object | ((root: string) => object) = {}) {
  const r = await repo(), p = { version: 1, trunk: 'main', closure: [], invariants: [], lease: false, nodes, ...(typeof extra === 'function' ? extra(r.root) : extra) };
  await r.put('seed', 'fixture'); await r.commit();
  await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify(p), measure: false });
  const dsa = new Client(), lines: string[] = [];
  const driver = new Driver({ cwd: r.cwd, dsa, log: l => lines.push(l), handleSignals: false, stay: true });
  const launch = async (id: string, role: 'writer' | 'reviewer' = 'writer', model = 'selected') => {
    const s = (await ops.readState(r)).state, project = projectId(s), rid = runId(project,id,1,role,role === 'reviewer' ? 1 : undefined);
    const built = role === 'writer' ? writerLaunch(s,id,project) : { spec: JSON.stringify({ model }), labels: runLabels(project,id,1,role) };
    return (await ops.launch({ ...r, as: parent, node: id, attempt: 1, role, rid, spec: role === 'writer' ? JSON.stringify({ ...JSON.parse(built.spec), model }) : built.spec, labels: built.labels, rulings: 0 })).entry;
  };
  const candidate = async (id: string, review = false) => {
    const slot = await ops.dispatch({ ...r, as: parent, node: id });
    await launch(id);
    const commit = await commitAt(slot.worktree, { [`${id}.txt`]: id });
    await ops.submit({ cwd: slot.worktree, as: { role: 'writer', id: `${id}#1` }, node: id });
    await ops.attest({ ...r, node: id });
    if (review) await ops.review({ ...r, as: { role: 'reviewer', id: `${id}-review` }, node: id, verdict: 'ok', rank: 1, note: 'verified', named: commit });
    return { slot, commit };
  };
  return { ...r, p, dsa, lines, driver, launch, candidate, async done() { driver.abort.abort(); await driver.settle(); await r.cleanup(); } };
}
const waitFor = async (check: () => boolean, label: string) => {
  const end = Date.now() + 10_000;
  while (!check() && Date.now() < end) await new Promise(r => setTimeout(r, 20));
  assert.ok(check(), label);
};

test('DR1: merge queue weights unique transitive unmerged dependents, then acceptance age; driver merges first', { timeout: 120_000 }, async () => {
  const f = await fixture([node('old'), node('high'), node('child',['high']), node('grand',['child']), node('diamond',['high','child']), node('tie')]);
  try {
    await f.candidate('old'); await f.candidate('high'); await f.candidate('tie');
    const status = await cli(f.cwd,['status','--json']); assert.equal(status.code,0,status.stderr);
    assert.deepEqual(JSON.parse(status.stdout).mergeQueue,['high','old','tie']);
    await f.driver.pass(); await f.driver.settle();
    const merges = (await ops.readState(f)).entries.filter(e => e.kind === 'merge');
    assert.equal(merges[0]?.node,'high');
    assert.equal(f.lines.some(l => /attest trunk: started|sweep sweep: started/.test(l)),false);
  } finally { await f.done(); }
});

test('DR2: lease busy reason persists through status, acceptance age is not dispatch age and stale candidate waits disappear', { timeout: 120_000 }, async () => {
  const f = await fixture([node('a')], { lease: true });
  try {
    await f.candidate('a');
    f.dsa.holdWhile = async () => ({ outcome: 'busy', reason: 'machine lease held by attest --trunk' });
    await f.driver.pass(); await f.driver.settle();
    const v = await ops.status(f), wait = v.mergeWaiting?.a;
    assert.equal(wait?.reason.includes('machine lease held by attest --trunk'),true);
    assert.match(renderStatus(v),/merge waiting for .*attest --trunk since \d\d:\d\d/);
    const { state, entries } = await ops.readState(f), n = state.nodes.a!;
    const acceptedAt = Date.parse(entries.find(e => e.seq === n.acceptedSince)!.ts);
    const dispatchAt = Date.parse(entries.find(e => e.seq === n.slot!.dispatchSeq)!.ts);
    assert.ok(acceptedAt > dispatchAt);
    const now = Date.now();
    assert.ok(Math.abs(v.summary!.progress[0]!.ageMs - (now - acceptedAt)) < 1000);
    assert.match((await cli(f.cwd,['status','--full'])).stdout,/merge waiting for .*attest --trunk since/);
    const since = wait!.since;
    f.driver.tick(); await f.driver.pass(); await f.driver.settle();
    assert.equal((await ops.status(f)).mergeWaiting!.a!.since,since);
    await commitAt(n.slot!.worktree, { 'a.txt': 'new' });
    await ops.submit({ cwd:n.slot!.worktree,as:{role:'writer',id:'a#1'},node:'a' });
    assert.equal((await ops.status(f)).mergeWaiting,undefined);
  } finally { await f.done(); }
});

test('DR1/DR2: accepted merge preempts driver trunk attest and shows internal wait until it releases', { timeout: 120_000 }, async () => {
  const f = await fixture([node('a',[],{ approve:'owner' })]);
  const mark = join(f.root,'trunk-started'), gate = join(f.root,'gate');
  try {
    const { commit } = await f.candidate('a');
    const p = { ...f.p, invariants:[{ id:'slow', run:`echo started > '${mark}'; while [ ! -f '${gate}' ]; do sleep 0.05; done`, reads:['seed'] }], drive:{ measure:1 } };
    await ops.planSet({ ...f,as:owner,channel:'delegated',note:'add invariant',plan:JSON.stringify(p) });
    await f.driver.pass(); await f.driver.pass(); await waitFor(() => existsSync(mark),`trunk refresh running: ${f.lines.join('\n')}`);
    await ops.approve({ cwd:f.cwd,as:owner,channel:'delegated',node:'a',note:'ready',named:commit });
    await f.driver.pass();
    assert.match(renderStatus(await ops.status(f)),/merge waiting for driver-internal job runs: attest --trunk since/);
    const refresh = f.driver.measuring.get('\u0000trunk-refresh');
    await refresh?.ended; await f.driver.reap([]);
    assert.ok(f.lines.some(l => l.includes('trunk attest aborted: preempted')),f.lines.join('\n'));
    await writeFile(gate,''); f.driver.tick(); await f.driver.pass(); await f.driver.settle();
    assert.equal((await ops.status(f)).nodes.a!.merged !== undefined,true);
  } finally { await writeFile(gate,''); await f.done(); }
});

test('DR1: accepted node preempts advisory sweep, and no new sweep starts while merge-ready', { timeout:120_000 }, async () => {
  const f = await fixture([node('a',[],{approve:'owner'})], root => ({sweep:{run:`echo started > '${join(root,'sweep-started')}'; while [ ! -f '${join(root,'gate')}' ]; do sleep 0.05; done`,timeout_s:60}}));
  const mark=join(f.root,'sweep-started'), gate=join(f.root,'gate');
  try {
    const {commit}=await f.candidate('a');
    await f.driver.pass(); await f.driver.pass(); await waitFor(()=>existsSync(mark),`sweep running: ${f.lines.join('\n')}`);
    await ops.approve({cwd:f.cwd,as:owner,channel:'delegated',node:'a',note:'ready',named:commit});
    await f.driver.pass(); await f.driver.settle();
    assert.ok(f.lines.some(l=>l.includes('sweep aborted: preempted')),f.lines.join('\n'));
    assert.equal(f.lines.filter(l=>l.includes('sweep sweep: started')).length,1);
  } finally { await writeFile(gate,''); await f.done(); }
});

test('DR3: CLI stores actual model, why warns on same model and launch selection mismatch; unknown is explicit', { timeout:120_000 }, async () => {
  const f=await fixture([node('a',[],{review:{count:1,min_rank:1}})]);
  try {
    const {slot,commit}=await f.candidate('a'); await f.launch('a','reviewer','review-selected');
    const submit=await cli(slot.worktree,['submit','a','--model','actual','--json']); assert.equal(submit.code,0,submit.stderr); assert.equal(JSON.parse(submit.stdout).model,'actual');
    const review=await cli(f.cwd,['review','a','--ok','--rank','1','--as','reviewer:drive-a-1-1','--candidate',commit,'--model','actual','--json']); assert.equal(review.code,0,review.stderr); assert.equal(JSON.parse(review.stdout).model,'actual');
    const why=await cli(f.cwd,['why','a']); assert.equal(why.code,0,why.stderr);
    assert.match(why.stdout,/writer actual · reviewer actual/);
    assert.match(why.stdout,/reviewer used the writer's model/);
    assert.match(why.stdout,/model used actual differs from the one selected selected/);
    assert.match(why.stdout,/model used actual differs from the one selected review-selected/);
    await cli(slot.worktree,['submit','a']);
    assert.match((await cli(f.cwd,['why','a'])).stdout,/writer model unknown/);
    const bad=await cli(slot.worktree,['submit','a','--model','']); assert.notEqual(bad.code,0);
  } finally { await f.done(); }
});

test('DR3: submitting and reviewing agents record the actual dsa status model without changing launch intents', {timeout:120_000},async()=>{
  const f=await fixture([node('a',[],{review:{count:1,min_rank:1}})]), prior=process.env.OWED_DSA;
  try {
    const {slot,commit}=await f.candidate('a'); await f.launch('a','reviewer','chosen');
    const bin=join(f.root,'model-dsa'); await writeFile(bin,'#!/bin/sh\nprintf \'%s\\n\' \'{"state":"running","calls":[{"gen":1,"model":"old"},{"gen":2,"model":"actual-status"}]}\'\n'); await chmod(bin,0o755); process.env.OWED_DSA=bin;
    const submitted=await cli(slot.worktree,['submit','a','--json']); assert.equal(submitted.code,0,submitted.stderr); assert.equal(JSON.parse(submitted.stdout).model,'actual-status');
    const reviewed=await cli(f.cwd,['review','a','--ok','--rank','1','--as','reviewer:drive-a-1-1','--candidate',commit,'--json']); assert.equal(reviewed.code,0,reviewed.stderr); assert.equal(JSON.parse(reviewed.stdout).model,'actual-status');
    assert.equal((await ops.readState(f)).entries.filter(e=>e.kind==='launch').length,2);
  } finally { if(prior===undefined) delete process.env.OWED_DSA; else process.env.OWED_DSA=prior; await f.done(); }
});

test('DR4: rule immediately notifies every running role, uses writer follow-up packet, failures write only rule', {timeout:120_000},async()=>{
  const f=await fixture([node('a'),node('b',[],{review:{count:1,min_rank:1}})]);
  try {
    await f.candidate('a'); const reviewer=await f.launch('a','reviewer');
    const writer=(await ops.readState(f)).state.nodes.a!.runs[0]!.launches[0]!;
    f.dsa.views.set(writer.rid,{rid:writer.rid,state:'running'}); f.dsa.views.set(reviewer.rid,{rid:reviewer.rid,state:'asking',questions:[{qid:'q',rev:1,question:'scope?'}]});
    const before=(await ops.readState(f)).entries.length;
    const ruled=await ops.rule({...f,as:parent,nodes:['a','b'],text:'Use the pinned API',dsa:f.dsa});
    assert.equal(f.dsa.sends.length,2); assert.ok(f.dsa.sends.every(s=>s.kind==='notify'));
    assert.equal(f.dsa.sends[0]!.message,rulingFollowUp((await ops.readState(f)).state,'a')!.message);
    assert.match(answers.rulingDeliveryText(ruled.delivery!),/delivered to 2 running calls \(a\/writer, a\/reviewer\); 2 will get it/);
    assert.equal((await ops.readState(f)).entries.length,before+1);
    f.dsa.fail.add(reviewer.rid);
    const failed=await ops.rule({...f,as:parent,nodes:['a'],text:'Do not widen scope',dsa:f.dsa});
    assert.match(answers.rulingDeliveryText(failed.delivery!),/delivery failures: a\/reviewer .*offline/);
    assert.equal(f.dsa.sends.length,4,'one attempt each, no retries');
    const n=f.dsa.sends.length; await ops.rule({...f,as:parent,nodes:['a'],text:'Future policy',prospective:true,dsa:f.dsa}); assert.equal(f.dsa.sends.length,n);
  } finally { await f.done(); }
});

test('DR4: owed_answer notifies other running roles while answering only the selected question', {timeout:120_000},async()=>{
  const f=await fixture([node('a')]);
  try {
    await f.candidate('a'); const reviewer=await f.launch('a','reviewer'); const writer=(await ops.readState(f)).state.nodes.a!.runs[0]!.launches[0]!;
    f.dsa.views.set(writer.rid,{rid:writer.rid,state:'asking',questions:[{qid:'q',rev:1,question:'Which API?'}]}); f.dsa.views.set(reviewer.rid,{rid:reviewer.rid,state:'running'});
    const r=await ops.answer({...f,as:parent,node:'a',text:'Use v2',rid:writer.rid,dsa:f.dsa});
    assert.deepEqual(f.dsa.sends.map(s=>[s.to,s.kind]),[[reviewer.rid,'notify'],[writer.rid,'answer']]);
    assert.match(answers.rulingDeliveryText(r.rulingDelivery!),/delivered to 1 running calls \(a\/reviewer\)/);
    assert.equal((await ops.readState(f)).entries.filter(e=>e.kind==='rule').length,1);
  } finally { await f.done(); }
});
