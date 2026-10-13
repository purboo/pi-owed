import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { computeMetrics, renderMetrics } from '../src/metrics.ts';
import type { Metrics } from '../src/metrics.ts';
import { canonical, H, ZERO } from '../src/canon.ts';
import { entryHash } from '../src/ledger.ts';
import { parsePlan } from '../src/plan.ts';
import { reduce } from '../src/reducer.ts';
import type { CandidateFacts, Draft, Entry, Plan } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli } from './helpers/surface.ts';

const commit = '1'.repeat(40), key = '2'.repeat(64);
const facts: CandidateFacts = { commit,tree:commit,base:commit,patch:key,changed:[],closureTouched:false,keys:{writes:key,review:key,rulings:key} };
const state = { commit,tree:commit,invKeys:{} };
const plan = parsePlan(JSON.stringify({version:1,trunk:'main',closure:[],invariants:[],nodes:['a','b','c'].map(id => ({id,writes:['src/'],checks:[],review:{count:0,min_rank:1}}))}));
function fixture(initial = plan) {
  const entries: Entry[] = [], plans = new Map<string,Plan>();
  const add = (draft: Draft): Entry => {
    const e = {...draft,seq:entries.length,ts:new Date(Date.UTC(2026,0,1)+entries.length*1000).toISOString(),prev:entries.at(-1)?.hash ?? ZERO} as Entry;
    e.hash = entryHash(e); entries.push(e); return e;
  };
  let prior = H(initial); plans.set(prior,initial);
  add({kind:'genesis',by:'owner:human',channel:'tty',trunk:'main',commit,plan:prior,state});
  const change = (next: Plan, by = 'parent:main') => { const sha = H(next); plans.set(sha,next); const e=add({kind:'plan',by,prior,plan:sha,downgrades:[]}); prior=sha; return e; };
  const dispatch = (node: string, attempt = 1) => add({kind:'dispatch',by:'parent:drive',node,attempt,base:commit,branch:`owed/${node}/${attempt}`,worktree:`/wt/${node}/${attempt}`,packet:key,rulings_seen:0});
  const submit = (node: string, attempt = 1, carry?: number) => add({kind:'submit',by:carry === undefined ? `writer:${node}#${attempt}` : 'executor:owed',node,attempt,facts,...(carry === undefined ? {} : {carry})});
  const merge = (node: string, attempt = 1) => add({kind:'merge',by:'executor:owed',node,attempt,prior:commit,commit,facts,state});
  const halt = (node: string, reason = `check unit: run ${node}-run key deadbeef has 2 failures`, attempt = 1) => add({kind:'halt',by:'parent:drive',node,attempt,reason,needs:'human'});
  const resume = (node: string, attempt = 1, by = 'parent:main') => add({kind:'resume',by,node,attempt});
  return {entries,plans,add,change,dispatch,submit,merge,halt,resume};
}
function scenario() {
  const f = fixture(), {add,dispatch,submit,merge,halt,resume,change} = f;
  dispatch('a'); // 1
  submit('a'); // 2
  halt('a'); // 3: a bare resume
  resume('a'); // 4
  halt('a','waiting for a at seq 123'); // 5: rule decision
  add({kind:'rule',by:'parent:main',nodes:['a'],text:'choose a design'}); // 6
  submit('a'); // 7: repair
  halt('a','waiting for b at seq 987'); // 8: distinct word-id prose (NT2), global rule
  add({kind:'rule',by:'owner:human',channel:'tty',nodes:'*',text:'answer',answer:{rid:'r1',qid:'q1',rev:1}}); // 9
  resume('a'); // 10
  halt('a','plan pending'); // 11
  const next = structuredClone(plan); next.nodes[0]!.deps = ['b']; change(next); // 12
  resume('a'); // 13
  add({kind:'review',by:'reviewer:r',node:'a',attempt:1,obligation:'review',key,verdict:'block',rank:1}); // 14
  merge('a'); // 15 (statistics don't perform acceptance)
  dispatch('b'); // 16
  submit('b'); // 17
  submit('b',1,17); // 18: carry excluded
  merge('b'); // 19
  dispatch('c'); // 20
  submit('c'); submit('c'); // 21,22
  add({kind:'abandon',by:'parent:main',node:'c',attempt:1,reason:'retry'}); // 23
  dispatch('c',2); // 24
  submit('c',2); submit('c',2); // 25,26
  merge('c',2); // 27
  return f;
}

test('metrics: exact counts, durations, repairs across attempts, carries and halt classes', () => {
  const {entries,plans} = scenario(), m = computeMetrics(entries,plans);
  assert.equal(m.mergedNodes,3);
  assert.deepEqual(m.interruptions,{total:5,halts:4,answers:1,perMergedNode:5/3});
  assert.deepEqual(m.halts.map(h => [h.seq,h.class,h.endedBy,h.decisionSeqs]),[[3,'no-decision',4,[]],[5,'decision',7,[6]],[8,'decision',10,[9]],[11,'decision',13,[12]]]);
  assert.deepEqual(m.submitToMergeMs,{samples:3,median:2000,p90:13000,max:13000});
  assert.deepEqual(m.dispatchToMergeMs,{samples:3,median:7000,p90:14000,max:14000});
  assert.deepEqual(m.firstPassAcceptance,{nodes:1,rate:1/3});
  assert.deepEqual(m.repairs,{total:3,perMergedNode:1});
  assert.deepEqual(m.merged.map(x => x.repairs),[1,0,2]);
  assert.deepEqual(m.merged[2]!.repairsByAttempt,[{attempt:1,submits:2,repairs:1},{attempt:2,submits:2,repairs:1}]);
  assert.deepEqual(m.haltReasons.decision,[{reason:'plan pending',count:1},{reason:'waiting for a at seq <n>',count:1},{reason:'waiting for b at seq <n>',count:1}]);
  assert.ok(renderMetrics(m).split('\n').length <= 20);
});

test('metrics: seq and ISO bounds retain prior history but cannot see decisions after until', () => {
  const {entries,plans} = scenario();
  const bySeq = computeMetrics(entries,plans,{since:14,until:19});
  assert.equal(bySeq.mergedNodes,2); assert.equal(bySeq.interruptions.total,0);
  assert.deepEqual(bySeq.submitToMergeMs,{samples:2,median:7500,p90:13000,max:13000});
  const byTime = computeMetrics(entries,plans,{since:entries[14]!.ts,until:entries[19]!.ts});
  assert.deepEqual({...bySeq,since:null,until:null},{...byTime,since:null,until:null});
});

test('metrics: cutoff and exclusive since apply to halts, answers and merges independently', () => {
  const {entries,plans} = scenario();
  const cutoff = computeMetrics(entries,plans,{since:4,until:5});
  assert.deepEqual(cutoff.halts.map(h => [h.seq,h.class,h.endedBy]),[[5,'no-decision',null]]);
  assert.deepEqual(cutoff.interruptions,{total:1,halts:1,answers:0,perMergedNode:null});
  const later = computeMetrics(entries,plans,{since:5,until:9});
  assert.deepEqual(later.halts.map(h => h.seq),[8]); assert.equal(later.interruptions.total,2);
  assert.equal(computeMetrics(entries,plans,{since:19,until:19}).mergedNodes,0);
  for (const window of [{since:'nope'},{until:1.5},{since:20,until:19},{since:'2026-02-01T00:00:00Z',until:'2026-01-01T00:00:00Z'}]) assert.throws(() => computeMetrics(entries,plans,window), /seq or ISO|later than/);
});

test('metrics: only parent decisions for the halted node count, including an ending abandon', () => {
  const f = fixture(); f.dispatch('a'); f.submit('a');
  const actions: Draft[] = [
    {kind:'rule',by:'parent:main',nodes:['a'],text:'choose'},
    {kind:'waive',by:'owner:human',node:'a',obligation:'review',key,reason:'risk'},
    {kind:'defer',by:'owner:human',node:'a',items:[],reason:'risk'},
    {kind:'hold',by:'parent:main',node:'a',abandon:1},
    {kind:'review',by:'owner:human',node:'a',attempt:1,obligation:'approve',key,verdict:'ok',rank:3},
    {kind:'evidence',by:'parent:main',node:'a',id:'proof',files:[],note:'checked'},
    {kind:'review',by:'owner:human',node:'a',attempt:1,obligation:'review',key,verdict:'block',rank:3},
    {kind:'abandon',by:'parent:main',node:'a',attempt:1,reason:'retry'},
  ];
  for (const action of actions) { f.halt('a'); const e = f.add(action); f.resume('a'); assert.equal(computeMetrics(f.entries,f.plans).halts.at(-1)!.decisionSeqs[0],e.seq); }
  f.halt('a');
  f.add({kind:'rule',by:'parent:main',nodes:['b'],text:'other node'});
  f.add({kind:'rule',by:'writer:a#1',nodes:['a'],text:'not the parent'});
  f.add({kind:'review',by:'reviewer:r',node:'a',attempt:1,obligation:'review',key,verdict:'ok',rank:1});
  const next = structuredClone(plan); next.nodes[1]!.title='other node changed'; f.change(next);
  f.halt('a'); f.resume('a',1,'parent:drive');
  assert.deepEqual(computeMetrics(f.entries,f.plans).halts.slice(-2).map(h => h.class),['no-decision','no-decision']);
});

test('metrics: a non-driver halt ends the previous driver halt without adding an interruption', () => {
  const f=fixture(); f.dispatch('a'); f.submit('a'); const first=f.halt('a');
  const manual=f.add({kind:'halt',by:'parent:main',node:'a',attempt:1,reason:'manual stop',needs:'human'});
  f.add({kind:'rule',by:'parent:main',nodes:['a'],text:'after the previous halt ended'}); f.resume('a');
  const m=computeMetrics(f.entries,f.plans);
  assert.deepEqual(m.halts.map(h => [h.seq,h.class,h.endedBy,h.decisionSeqs]),[[first.seq,'no-decision',manual.seq,[]]]);
  assert.equal(m.interruptions.halts,1);
});

test('metrics: no halts, empty denominators, top-five normalization and short rendering', () => {
  const f = fixture();
  const empty = computeMetrics(f.entries,f.plans);
  assert.deepEqual(empty.interruptions,{total:0,halts:0,answers:0,perMergedNode:null});
  assert.deepEqual(empty.submitToMergeMs,{samples:0,median:null,p90:null,max:null});
  assert.deepEqual(empty.firstPassAcceptance,{nodes:0,rate:null});
  f.dispatch('a'); f.submit('a'); f.merge('a');
  assert.equal(computeMetrics(f.entries,f.plans).firstPassAcceptance.rate,1);
  for (const kind of ['capacity','transport','machine','overlap','missing','slot','lease']) {
    for (let i=0;i<2;i++) { f.halt('b',`${kind}\nnode ${i ? 'a' : 'b'} run owed:abc:${i} seq ${i}`); f.resume('b'); }
  }
  const m=computeMetrics(f.entries,f.plans);
  assert.equal(m.haltReasons['no-decision'].length,5);
  assert.ok(m.haltReasons['no-decision'].every(r => r.count === 2));
  assert.ok(renderMetrics(m).split('\n').length <= 20);
});

test('metrics: first-pass tracks execution and judgment blocks on earlier candidates, excluding probes and attribution', () => {
  for (const [extra,expected] of [[{},false],[{attribution:true},true],[{probe:'trunk'},true]] as const) {
    const f=fixture(); f.dispatch('a'); f.submit('a');
    f.add({kind:'obs',by:'executor:owed',subject:'a',obligation:'writes',key,commit,verdict:'fail',exit:1,durationMs:1,...extra});
    f.submit('a'); f.merge('a');
    assert.equal(computeMetrics(f.entries,f.plans).merged[0]!.firstPass,expected);
  }
});

test('metrics: a 0.9-era fixture replays with unchanged state and keys', () => {
  const f=fixture(); f.dispatch('a'); f.submit('a');
  f.add({kind:'obs',by:'executor:owed',subject:'a',obligation:'writes',key,commit,verdict:'pass',exit:0,durationMs:1});
  f.merge('a');
  const before=reduce(f.entries,sha => f.plans.get(sha)!);
  const serialized=JSON.stringify(before), originals=JSON.stringify(f.entries);
  const m=computeMetrics(f.entries,f.plans);
  assert.equal(m.mergedNodes,1); assert.equal(m.interruptions.total,0);
  assert.deepEqual(m.merged.map(x => [x.node,x.firstPass,x.repairs]),[['a',true,0]]);
  assert.equal(JSON.stringify(reduce(f.entries,sha => f.plans.get(sha)!)),serialized);
  assert.equal(JSON.stringify(f.entries),originals); assert.equal(before.nodes.a!.phase,'merged');
});

test('metrics: 5000-entry ledger with interleaved halts and plans computes in under 2 s', () => {
  const f=fixture(); f.dispatch('a'); f.submit('a');
  for (let i=0;i<900;i++) { f.halt('a'); const next=structuredClone(plan); next.nodes[0]!.title=`revision ${i}`; f.change(next); f.resume('a'); }
  f.merge('a');
  while (f.entries.length<5000) f.add({kind:'note',by:'parent:main',text:'padding'});
  const start=performance.now(), m=computeMetrics(f.entries,f.plans), ms=performance.now()-start;
  assert.equal(m.halts.length,900); assert.ok(m.halts.every(h => h.class === 'decision'));
  assert.ok(ms<2000,`5000 entries took ${ms} ms`); console.log(`metrics 5000 entries: ${ms.toFixed(1)} ms`);
});

test('metrics CLI: read-only JSON and plain output, bounds, validation and ordinary report preserved', {timeout:120_000}, async () => {
  const r=await repo();
  try {
    await r.put('plan.json',JSON.stringify(plan)); await r.commit();
    const run=async (args:string[],code=0) => { const result=await cli(r.cwd,args); assert.equal(result.code,code,result.stderr+result.stdout); return result; };
    await run(['report','--metrics'],1);
    await run(['init','plan.json','--no-lease']);
    const dir=join(r.root,'ledger'), file=join(dir,'ledger.jsonl');
    const old=await readFile(file,'utf8');
    // A fixed, hash-chained ledger makes timing and classification deterministic without measuring external state.
    const f=fixture(); f.dispatch('a'); f.submit('a'); f.halt('a'); f.resume('a');
    f.add({kind:'obs',by:'executor:owed',subject:'a',obligation:'writes',key,commit,verdict:'pass',exit:0,durationMs:1});
    f.merge('a');
    for (const [sha,p] of f.plans) await writeFile(join(dir,'blobs',sha),canonical(p));
    await writeFile(file,f.entries.map(e => JSON.stringify(e)).join('\n')+'\n');
    const ledger=await readFile(file,'utf8');
    const all=JSON.parse((await run(['report','--metrics','--json'])).stdout) as Metrics;
    assert.deepEqual(all,computeMetrics(f.entries,f.plans));
    assert.equal((await run(['report','--metrics'])).stdout.trim(),renderMetrics(all));
    const bounded=JSON.parse((await run(['report','--metrics','--since','2','--until','6','--json'])).stdout) as Metrics;
    assert.equal(bounded.mergedNodes,1); assert.equal(bounded.submitToMergeMs.median,4000);
    assert.equal(await readFile(file,'utf8'),ledger,'report appended ledger entries');
    for (const args of [['--until','19'],['--metrics','--since','bad'],['--metrics','--until'],['--metrics','--since','20','--until','19']]) await run(['report',...args],2);
    await writeFile(file,old);
    const ordinary=JSON.parse((await run(['report','--json'])).stdout) as Record<string,unknown>;
    assert.ok('merges' in ordinary); assert.ok(!('mergedNodes' in ordinary));
    assert.match((await run(['--help'])).stdout,/report \[--metrics/);
  } finally { await r.cleanup(); }
});
