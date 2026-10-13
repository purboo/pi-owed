import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeMetrics, renderMetrics } from '../src/metrics.ts';
import { H, ZERO } from '../src/canon.ts';
import { parsePlan } from '../src/plan.ts';
import type { CandidateFacts, Draft, Entry, Plan } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli } from './helpers/surface.ts';

const commit = '1'.repeat(40), key = '2'.repeat(64);
const facts: CandidateFacts = {commit,tree:commit,base:commit,patch:key,changed:[],closureTouched:false,keys:{writes:key,review:key,rulings:key}};
const state = {commit,tree:commit,invKeys:{}};
const initial = parsePlan(JSON.stringify({version:1,trunk:'main',closure:[],invariants:[{id:'unit',run:'true',reads:['src/']}],nodes:[{id:'a',writes:['src/'],checks:[{id:'unit',run:'true',reads:['src/']}],review:{count:0,min_rank:1}}]}));
function fixture() {
  const entries: Entry[] = [], plans = new Map<string,Plan>();
  const add = (draft: Draft): Entry => {
    const seq = entries.length;
    const entry = {...draft,seq,ts:new Date(Date.UTC(2026,0,1)+seq*1000).toISOString(),prev:ZERO,hash:H(draft)} as Entry;
    entries.push(entry); return entry;
  };
  let prior = H(initial); plans.set(prior,initial);
  add({kind:'genesis',by:'owner:pi',trunk:'main',commit,plan:prior,state});
  const change = (next: Plan, by = 'owner:pi') => {
    const sha = H(next); plans.set(sha,next);
    const e = add({kind:'plan',by,prior,plan:sha,downgrades:[]}); prior = sha; return e;
  };
  const halt = (reason: string, by = 'parent:drive') => add({kind:'halt',by,node:'a',attempt:1,reason,needs:'human'});
  const resume = () => add({kind:'resume',by:'parent:pi',node:'a',attempt:1});
  const merged = () => {
    add({kind:'dispatch',by:'parent:drive',node:'a',attempt:1,base:commit,branch:'owed/a/1',worktree:'/wt/a',packet:key,rulings_seen:0});
    add({kind:'submit',by:'writer:a#1',node:'a',attempt:1,facts});
    return add({kind:'merge',by:'executor:owed',node:'a',attempt:1,prior:commit,commit,facts,state});
  };
  // A synthetic GR entry keeps this PA test independent of the parallel GR type addition.
  const grant = () => add({kind:'grant',by:'executor:owed',node:'a',attempt:1,commit,paths:['extra.ts'],allowance:0} as unknown as Draft);
  return {entries,plans,add,change,halt,resume,merged,grant};
}

test('parentacts: each class counts one entry, with first-match precedence', () => {
  const f = fixture();
  const widened = structuredClone(initial); widened.nodes[0]!.writes.push('extra/'); f.change(widened);
  f.add({kind:'rule',by:'parent:pi',nodes:['a'],text:'writes of a widened by plan #1: +extra/. Limit: task only',answer:{rid:'r',qid:'q',rev:1}});
  f.add({kind:'rule',by:'parent:pi',nodes:['a'],text:'answer',answer:{rid:'r',qid:'q',rev:2}});
  f.add({kind:'adopt',by:'owner:pi',trunk:'main',prior:commit,commit,state,changed:[],commits:1,note:'fix trunk'});
  const red = structuredClone(widened); red.invariants[0]!.known_red = [{test:'failure',fix:'a'}]; f.change(red);
  f.halt('merge refused: trunk-red: check:unit'); f.resume();
  f.halt('writer interrupted'); f.resume();
  f.add({kind:'rule',by:'owner:pi',nodes:['a'],text:'ordinary writes advice'});
  const next = structuredClone(red); next.nodes[0]!.title = 'new title'; f.change(next);
  f.add({kind:'review',by:'owner:pi',node:'a',attempt:1,obligation:'review',key,verdict:'ok',rank:3});
  f.add({kind:'waive',by:'owner:pi',node:'a',obligation:'review',key,reason:'risk'});
  f.add({kind:'defer',by:'owner:pi',node:'a',items:[],reason:'debt'});
  f.add({kind:'evidence',by:'parent:pi',node:'a',id:'proof',files:[],note:'checked'});
  f.add({kind:'abandon',by:'parent:pi',node:'a',attempt:1,reason:'retry'});
  // 0.16 represents approval as an owner review; it stays in the earlier review class.
  f.add({kind:'review',by:'owner:pi',node:'a',attempt:1,obligation:'approve',key,verdict:'ok',rank:3});
  f.add({kind:'note',by:'parent:pi',text:'coordination'});
  f.grant(); f.merged();
  const m = computeMetrics(f.entries,f.plans);
  assert.deepEqual(m.parentActs,{total:17,perMergedNode:17,byClass:{writes:2,answer:1,trunk:3,resume:1,rule:1,plan:1,review:2,waive:1,defer:1,evidence:1,abandon:1,approve:0,other:2}});
  assert.deepEqual(m.grants,{total:1,perMergedNode:1});
});

test('parentacts: driver, executor, writer and reviewer acts and transport entries excluded', () => {
  const f = fixture();
  for (const by of ['parent:drive','executor:owed','writer:a#1','reviewer:r']) f.add({kind:'rule',by,nodes:['a'],text:'not a parent decision',answer:{rid:by,qid:'q',rev:1}});
  for (const by of ['owner:pi','parent:pi']) {
    f.add({kind:'dispatch',by,node:'a',attempt:1,base:commit,branch:'b',worktree:'/wt',packet:key,rulings_seen:0});
    f.add({kind:'launch',by,node:'a',attempt:1,role:'writer',rid:'r',spec:key,labels:{}});
    f.add({kind:'send',by,node:'a',attempt:1,rid:'r',send:'s',sendKind:'notify',message:key,reason:'waiting'});
  }
  f.grant();
  const m = computeMetrics(f.entries,f.plans);
  assert.equal(m.parentActs.total,1,'genesis is an owner act');
  assert.equal(m.parentActs.byClass.other,1);
  assert.equal(m.parentActs.perMergedNode,null);
  assert.deepEqual(m.grants,{total:1,perMergedNode:null});
  assert.equal(m.interruptions.answers,0);
});

test('parentacts: seq/ISO bounds retain earlier plans and last halt, never future context', () => {
  const f = fixture();
  f.halt('merge refused: trunk-red: unit');
  const resume = f.resume();
  const widened = structuredClone(initial); widened.nodes[0]!.writes.push('extra/'); const plan = f.change(widened);
  f.grant(); const end = f.merged();
  f.halt('ordinary'); f.resume(); f.grant();
  const m = computeMetrics(f.entries,f.plans,{since:1,until:end.seq});
  assert.equal(m.parentActs.total,2);
  assert.equal(m.parentActs.byClass.trunk,1);
  assert.equal(m.parentActs.byClass.writes,1);
  assert.equal(m.grants.total,1);
  const iso = computeMetrics(f.entries,f.plans,{since:f.entries[1]!.ts,until:end.ts});
  assert.deepEqual({...iso,since:null,until:null},{...m,since:null,until:null});
  const empty = computeMetrics(f.entries,f.plans,{since:resume.seq,until:resume.seq});
  assert.equal(empty.parentActs.total,0); assert.equal(empty.grants.total,0);
  const cutoff = computeMetrics(f.entries,f.plans,{since:0,until:plan.seq});
  assert.equal(cutoff.parentActs.byClass.resume,0);
  assert.equal(cutoff.parentActs.byClass.trunk,1);
  assert.equal(cutoff.parentActs.perMergedNode,null);
});

test('parentacts: actual downgrades, not claimed text or allowance, determine writes class', () => {
  const f = fixture();
  const allowed = structuredClone(initial); allowed.allow = [{nodes:['a'],writes:['extra/'],checks:['*']}]; f.change(allowed);
  const widened = structuredClone(allowed); widened.nodes[0]!.writes.push('extra/'); f.change(widened,'parent:pi');
  const mixed = structuredClone(widened); mixed.nodes[0]!.writes.push('more/'); mixed.nodes[0]!.checks[0]!.run = 'echo changed'; f.change(mixed);
  const noOp = f.change(structuredClone(mixed));
  assert.equal(noOp.kind,'plan'); if (noOp.kind === 'plan') noOp.downgrades = [{node:'a',what:'writes widened'}];
  const m = computeMetrics(f.entries,f.plans);
  assert.equal(m.parentActs.byClass.writes,1);
  assert.equal(m.parentActs.byClass.plan,3,'allow change, mixed downgrade and no-op are plans');
});

test('parentacts: only known_red changes are trunk plans; resume uses last recorded halt', () => {
  const f = fixture();
  const red = structuredClone(initial); red.invariants[0]!.known_red = [{test:'failure',fix:'a'}]; f.change(red);
  const mixed = structuredClone(red); mixed.invariants[0]!.known_red = []; mixed.nodes[0]!.title = 'changed'; f.change(mixed);
  const removed = structuredClone(mixed); delete removed.invariants[0]!.known_red; f.change(removed);
  f.halt('merge refused: trunk-red: unit'); f.resume(); f.resume();
  f.halt('other', 'parent:pi'); f.resume();
  const m = computeMetrics(f.entries,f.plans);
  assert.equal(m.parentActs.byClass.trunk,4,'known_red-only plans and both resumes after last trunk halt');
  assert.equal(m.parentActs.byClass.plan,1);
  assert.equal(m.parentActs.byClass.resume,1);
});

test('parentacts: legacy fields retain exact 0.16 values and input is immutable', () => {
  const f = fixture(); f.merged();
  const originals = JSON.stringify(f.entries), laws = JSON.stringify([...f.plans]);
  const {parentActs,grants,...legacy} = computeMetrics(f.entries,f.plans);
  assert.deepEqual(legacy,{
    since:-1,until:null,mergedNodes:1,
    merged:[{node:'a',attempt:1,seq:3,submitToMergeMs:1000,dispatchToMergeMs:2000,firstPass:true,repairs:0,repairsByAttempt:[{attempt:1,submits:1,repairs:0}]}],
    interruptions:{total:0,halts:0,answers:0,perMergedNode:0},halts:[],haltReasons:{decision:[],'no-decision':[]},
    submitToMergeMs:{samples:1,median:1000,p90:1000,max:1000},dispatchToMergeMs:{samples:1,median:2000,p90:2000,max:2000},
    firstPassAcceptance:{nodes:1,rate:1},repairs:{total:0,perMergedNode:0}
  });
  assert.equal(parentActs.total,1); assert.deepEqual(grants,{total:0,perMergedNode:0});
  assert.equal(JSON.stringify(f.entries),originals); assert.equal(JSON.stringify([...f.plans]),laws);
  const text = renderMetrics(computeMetrics(f.entries,f.plans));
  assert.match(text,/Parent acts per merged node: 1 .*top classes: other 1/);
  assert.match(text,/Driver halts \+ answers per merged node \(partial\)/);
  assert.ok(text.indexOf('Parent acts') < text.indexOf('Driver halts'));
});

test('parentacts CLI: real amend marker counts both plan and ruling; JSON and text exposed', {timeout:120_000}, async () => {
  const r = await repo();
  try {
    await r.put('plan.json',JSON.stringify({...initial,invariants:[]})); await r.commit();
    const run = async (args: string[]) => { const result = await cli(r.cwd,args); assert.equal(result.code,0,result.stdout+result.stderr); return result.stdout; };
    await run(['init','plan.json','--no-lease']);
    await run(['amend','a','--plan','plan.json','--writes','+extra/','--note','task only','--as','owner:pi']);
    const m = JSON.parse(await run(['report','--metrics','--json']));
    assert.equal(m.parentActs.byClass.writes,2);
    assert.equal(m.parentActs.total,3);
    assert.equal(m.parentActs.perMergedNode,null);
    assert.equal(m.grants.total,0);
    assert.match(await run(['report','--metrics']),/Parent acts per merged node: n\/a .*writes 2/);
  } finally { await r.cleanup(); }
});
