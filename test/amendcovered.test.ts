// AC1: redundant allow-covered writes report their source without refusing a decision or amendment.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import { parsePlan } from '../src/plan.ts';
import { projectId, runId, runLabels } from '../src/reducer.ts';
import type { RunView } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli } from './helpers/surface.ts';

const owner = { role:'owner', id:'pi' } as const, parent = { role:'parent', id:'test' } as const;
async function fixture() {
  const r = await repo();
  const plan = JSON.stringify({ version:1, trunk:'main', lease:false, closure:[], invariants:[],
    allow:[{ nodes:['a'], writes:['allowed/'] }, { nodes:['b'], writes:['other/'] }],
    nodes:[{ id:'a', writes:['owned/'] }, { id:'b', writes:['b/'] }] });
  await r.put('plan.json',plan); await r.commit();
  await ops.init({ cwd:r.cwd, as:owner, channel:'delegated', plan, measure:false });
  const recorded = await ops.planSet({ cwd:r.cwd, as:parent, ...await ops.readPlan({ cwd:r.cwd, path:'plan.json' }) });
  const source = `allow rule (plan #${recorded.seq})`;
  const note = (paths: string[]) => ` (writes already granted by allow rule, plan #${recorded.seq}: ${paths.join(', ')})`;
  const state = () => ops.readState(r);
  const options = { cwd:r.cwd, as:owner, channel:'delegated' as const, nodes:['a'], text:'Only the requested function' };
  return { ...r, plan, recorded, source, note, state, options };
}

test('AC1: decide --writes entirely covered by allow records one ruling, no plan, and resumes', { timeout:120_000 }, async () => {
  const f = await fixture();
  try {
    await ops.dispatch({ cwd:f.cwd, as:parent, node:'a' });
    await ops.halt({ cwd:f.cwd, as:{ role:'parent', id:'drive' }, node:'a', attempt:1, reason:'writer needs a limit', needs:'human' });
    const before = await f.state();
    const result = await cli(f.cwd,['decide','a','--text',f.options.text,'--writes','+allowed/x.ts,+allowed/y.ts','--resume','--as','parent:test']);
    assert.equal(result.code,0,result.stderr);
    const after = await f.state(), entries = after.entries.slice(before.entries.length);
    assert.deepEqual(entries.map(e => e.kind),['rule','resume']);
    assert.ok(entries[0]?.kind === 'rule');
    assert.equal(entries[0].text,f.options.text + f.note(['allowed/x.ts','allowed/y.ts']));
    assert.ok(entries.every(e => e.decision === entries[0]!.seq));
    assert.equal(after.state.nodes.a!.halt,undefined);
    assert.equal(after.state.planSha,before.state.planSha);
    assert.equal(await readFile(join(f.cwd,'plan.json'),'utf8'),f.plan);
    assert.match(result.stdout,/writes unchanged.*already covered by allow rule.*; resumed/);
    assert.equal((await ops.verify(f)).ok,true);
  } finally { await f.cleanup(); }
});

test('AC1: mixed writes add only uncovered paths and the ruling notes only the allow-covered paths', { timeout:120_000 }, async () => {
  const f = await fixture();
  try {
    const before = await f.state();
    const result = await ops.decide({ ...f.options, writes:['+allowed/x.ts','+extra.ts','+owned/x.ts','+allowed/y.ts','+allowed/x.ts'] });
    assert.deepEqual(result.entries.map(e => e.kind),['plan','rule']);
    assert.deepEqual(result.added,['extra.ts']);
    assert.deepEqual(result.covered?.a,[{ path:'allowed/x.ts', entry:f.source },{ path:'owned/x.ts', entry:'owned/' },{ path:'allowed/y.ts', entry:f.source }]);
    assert.equal(result.rule.text,f.options.text + f.note(['allowed/x.ts','allowed/y.ts']));
    const plan = parsePlan(await readFile(join(f.cwd,'plan.json'),'utf8'));
    assert.deepEqual(plan.nodes[0]!.writes,['owned/','extra.ts']);
    assert.deepEqual(plan.allow,before.state.plan.allow);
    assert.equal((await ops.verify(f)).ok,true);
  } finally { await f.cleanup(); }
});

test('AC1: amend with only allow-covered paths succeeds without recording and points to decide --writer', { timeout:120_000 }, async () => {
  const f = await fixture();
  try {
    const before = await f.state();
    const result = await cli(f.cwd,['amend','a','--writes','+allowed/x.ts,+allowed/y.ts','--note','only this function','--as','parent:test']);
    assert.equal(result.code,0,result.stderr);
    assert.match(result.stdout,/a: writes unchanged; allowed\/x\.ts already covered by allow rule \(plan #\d+\); allowed\/y\.ts already covered by allow rule \(plan #\d+\)/);
    assert.match(result.stdout,/owed decide a --writer delivers a limit/);
    assert.deepEqual((await f.state()).entries,before.entries);
    assert.equal(await readFile(join(f.cwd,'plan.json'),'utf8'),f.plan);
  } finally { await f.cleanup(); }
});

test('AC1: existing writes keep their original report, no-resume holds, and other nodes allowances grant nothing', { timeout:120_000 }, async () => {
  const f = await fixture();
  try {
    await ops.dispatch({ cwd:f.cwd, as:parent, node:'a' });
    const halt = await ops.halt({ cwd:f.cwd, as:{ role:'parent', id:'drive' }, node:'a', attempt:1, reason:'needs a ruling', needs:'human' });
    const original = await ops.decide({ ...f.options, as:parent, writes:['owned/x.ts'], resume:false });
    assert.equal(original.rule.text,f.options.text);
    assert.deepEqual(original.covered?.a,[{ path:'owned/x.ts', entry:'owned/' }]);
    const covered = await ops.decide({ ...f.options, as:parent, writes:['allowed/x.ts'], resume:false });
    assert.deepEqual(covered.entries.map(e => e.kind),['rule']);
    assert.equal((await f.state()).state.nodes.a!.halt?.seq,halt.seq);
    const before = await f.state();
    await assert.rejects(ops.decide({ ...f.options, as:parent, writes:['allowed/x.ts','other/x.ts'] }),/Only owner/);
    assert.deepEqual((await f.state()).entries,before.entries);
    assert.equal(await readFile(join(f.cwd,'plan.json'),'utf8'),f.plan);
  } finally { await f.cleanup(); }
});

test('AC1: covered writes still refuse invalid paths, empty limits, dirty plans and unequal multi-node additions', { timeout:120_000 }, async () => {
  const f = await fixture();
  try {
    const before = await f.state();
    await assert.rejects(ops.decide({ ...f.options, writes:['allowed/x.ts','../bad'] }));
    await assert.rejects(ops.amend({ cwd:f.cwd, as:parent, node:'a', writes:['allowed/x.ts'], note:'' }),/non-empty note/);
    await assert.rejects(ops.decide({ ...f.options, nodes:['a','b'], writes:['allowed/x.ts'] }),/same paths/);
    await f.put('plan.json',f.plan.replace('owned/','changed/'));
    await assert.rejects(ops.decide({ ...f.options, writes:['allowed/x.ts'] }),/unrecorded edits/);
    await assert.rejects(ops.amend({ cwd:f.cwd, as:parent, node:'a', writes:['allowed/x.ts'], note:'limit' }),/unrecorded edits/);
    assert.deepEqual((await f.state()).entries,before.entries);
  } finally { await f.cleanup(); }
});

test('AC1: an answer with covered writes sends the recorded note and retries the same bytes', { timeout:120_000 }, async () => {
  const f = await fixture();
  try {
    await ops.dispatch({ cwd:f.cwd, as:parent, node:'a' });
    const project = projectId((await f.state()).state), rid = runId(project,'a',1,'writer');
    await ops.launch({ cwd:f.cwd, as:parent, node:'a', attempt:1, role:'writer', rid, spec:'{}', labels:runLabels(project,'a',1,'writer'), rulings:0 });
    let asking = true;
    const sent: string[] = [];
    const dsa = {
      async describe(): Promise<RunView> { return asking ? { rid, state:'asking', questions:[{ qid:'q', rev:1, question:'May I edit this function?' }] } : { rid, state:'sealed', status:'ok' }; },
      async send(_id: string, _rid: string, _kind: string, text: string | Uint8Array) { sent.push(String(text)); return { outcome:'applied' as const, spec_digest:'test' }; }
    };
    const result = await ops.decide({ ...f.options, writes:['allowed/x.ts'], dsa });
    const answer = f.options.text + f.note(['allowed/x.ts']);
    assert.equal(result.rule.text,`Answer to writer question q: ${answer}`);
    assert.deepEqual(sent,[answer]);
    asking = false;
    const before = await f.state();
    const retry = await ops.answer({ cwd:f.cwd, as:parent, node:'a', rid, qid:'q', rev:1, text:answer, dsa });
    assert.equal(retry.entry.seq,result.rule.seq);
    assert.deepEqual(sent,[answer,answer]);
    assert.deepEqual((await f.state()).entries,before.entries);
    assert.equal((await ops.verify(f)).ok,true);
  } finally { await f.cleanup(); }
});
