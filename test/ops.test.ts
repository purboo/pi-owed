import { test } from 'node:test';
import assert from 'node:assert/strict';
import { access, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { parsePlan } from '../src/plan.ts';
import { git, revParse } from '../src/git.ts';
import { runJob } from '../src/exec.ts';
import { candidateFacts } from '../src/git.ts';
import { repo } from './helpers/repo.ts';
import { commitAt, planText, seed, checkTest } from './helpers/surface.ts';
const parent={role:'parent',id:'test'} as const, owner={role:'owner',id:'human'} as const;
test('operations: canonical plan, fresh submit facts, ancestry, clean slot, authority and rerun', {timeout:60_000}, async () => {
 const r=await repo(); try {
  await seed(r.cwd); const init=await ops.init({cwd:r.cwd,plan:planText,as:owner,channel:'flag'}); assert.equal(init.observations.length,1);
  const ledger=await Ledger.open(r.cwd); assert.equal(init.entry.kind,'genesis'); if(init.entry.kind !== 'genesis') throw Error('genesis'); assert.equal(parsePlan((await ledger.getBlob(init.entry.plan)).toString()).nodes.length,2);
  const a=await ops.dispatch({cwd:r.cwd,node:'a',as:parent}), actor={cwd:a.worktree,node:'a',as:{role:'writer',id:'a#1'} as const};
  await writeFile(join(a.worktree,'dirty'),'x'); await assert.rejects(ops.submit(actor),/dirty/);
  await git(a.worktree,['clean','-f']);
  await assert.rejects(ops.submit({...actor,as:parent}),/writer/);
  await commitAt(a.worktree,{'test/a.cjs':'module.exports=1;','test/a.test.cjs':checkTest('a',1)});
  const first=await ops.submit(actor); assert.equal(first.kind,'submit');
  const next=JSON.parse(planText); next.nodes[0].checks[0].reads=['test/a.cjs','test/a.test.cjs'];
  await assert.rejects(ops.planSet({cwd:r.cwd,plan:JSON.stringify(next),as:parent}),/owner/);
  await ops.planSet({cwd:r.cwd,plan:JSON.stringify(next),as:owner,channel:'flag'});
  const second=await ops.submit(actor); if(first.kind !== 'submit' || second.kind !== 'submit') throw Error('submit');
  assert.notEqual(first.seq,second.seq); // fresh facts are generated even for the same commit
  const changed=JSON.parse(planText); changed.nodes[0].checks[0].run+=' --test-reporter=tap';
  await ops.planSet({cwd:r.cwd,plan:JSON.stringify(changed),as:owner,channel:'flag'});
  const third=await ops.submit(actor); if(third.kind !== 'submit') throw Error('submit'); assert.notEqual(third.facts.keys['check:a'],first.facts.keys['check:a']);
  await ops.planSet({cwd:r.cwd,plan:planText,as:owner,channel:'flag'}); await ops.submit(actor);
  assert.equal((await ops.attest({cwd:r.cwd,node:'a'})).accepted,true);
  assert.equal((await ops.attest({cwd:r.cwd,node:'a'})).observations.length,0);
  assert.ok((await ops.attest({cwd:r.cwd,node:'a',rerun:true})).observations.length >= 3);
  // Unrelated root commit uses commit-tree without touching another worktree.
  const tree=(await git(r.cwd,['rev-parse','HEAD^{tree}'])).stdout.trim();
  const orphan=(await git(r.cwd,['commit-tree',tree],{input:'orphan',env:{GIT_AUTHOR_NAME:'test',GIT_AUTHOR_EMAIL:'t@local',GIT_COMMITTER_NAME:'test',GIT_COMMITTER_EMAIL:'t@local'}})).stdout.trim();
  await assert.rejects(ops.submit({...actor,commit:orphan}),/descendant/);
  const card=await ops.why({cwd:r.cwd,node:'a'}); assert.ok(card.downgrades.length); assert.ok(card.items.some(i => i.observations.length));
  await ops.rule({cwd:r.cwd,text:'new ruling after dispatch',nodes:['a'],as:parent});
  assert.equal((await ops.why({cwd:r.cwd,node:'a'})).accepted,false);
  const rules=(await ops.report({cwd:r.cwd})).rulings;
  await ops.review({cwd:r.cwd,node:'a',as:{role:'reviewer',id:'fresh'},verdict:'ok',rank:1,note:'ack',ack_rulings:rules.at(-1)!.seq});
  assert.equal((await ops.why({cwd:r.cwd,node:'a'})).accepted,true);
  assert.equal((await ops.verify({cwd:r.cwd})).ok,true);
 } finally { await r.cleanup(); }
});

test('executor isolates inherited Node test runner context and optional reviews retain a key', {timeout:30_000}, async () => {
 const r=await repo(), previous=process.env.NODE_TEST_CONTEXT;
 try {
  const base=await seed(r.cwd); const commit=await commitAt(r.cwd,{'test/a.cjs':'module.exports=1;','test/a.test.cjs':checkTest('a',1)});
  const plan=parsePlan(planText), spec=plan.nodes[0]!, facts=await candidateFacts(r.cwd,plan,spec,base,commit,1), ledger=await Ledger.open(r.cwd);
  assert.equal(spec.review.count,0); assert.match(facts.keys.review!,/^[a-f0-9]{64}$/);
  process.env.NODE_TEST_CONTEXT='child-v8';
  const jobSpec={...spec.checks[0]!,run:'node --test test/a.test.cjs'};
  const obs=await runJob({cwd:r.cwd,plan,ledger},{kind:'check',subject:'a',obligation:'check:a',key:facts.keys['check:a']!,spec:jobSpec,base,commit});
  assert.equal(obs.verdict,'pass',obs.note); assert.equal(obs.counts?.tests,1);
  const red=await runJob({cwd:r.cwd,plan,ledger},{kind:'red',subject:'a',obligation:'red:a',key:facts.keys['red:a']!,spec:jobSpec,base,commit});
  assert.equal(red.verdict,'pass',red.note); assert.equal(red.exit,1);
 } finally { if(previous === undefined) delete process.env.NODE_TEST_CONTEXT; else process.env.NODE_TEST_CONTEXT=previous; await r.cleanup(); }
});

test('merge refuses a ref moved during invariant execution without appending observations', {timeout:30_000}, async () => {
 const r=await repo();
 try {
  await commitAt(r.cwd,{'flag':'base'});
  const marker=join(r.root,'started'), release=join(r.root,'release');
  const plan=JSON.stringify({version:1,trunk:'main',nodes:[{id:'a',writes:['flag']}],invariants:[{id:'wait',reads:['flag'],timeout_s:10,run:`echo '# tests 1'; echo '# pass 1'; if grep -q changed flag; then touch '${marker}'; for n in $(seq 1 200); do test -e '${release}' && exit 0; sleep .02; done; exit 1; fi`}]});
  await ops.init({cwd:r.cwd,plan,as:owner,channel:'flag'});
  const a=await ops.dispatch({cwd:r.cwd,node:'a',as:parent}); await commitAt(a.worktree,{'flag':'changed'});
  await ops.submit({cwd:a.worktree,node:'a',as:{role:'writer',id:'a#1'}}); await ops.attest({cwd:r.cwd,node:'a'});
  const ledger=await Ledger.open(r.cwd), before=await ledger.read();
  const merging=ops.merge({cwd:r.cwd,node:'a',as:parent});
  // Attach rejection handling before inducing the CAS failure.
  const outcome=merging.then(value => ({value,error:undefined}),error => ({value:undefined,error}));
  let started=false; for(let i=0;i<200;i++) { try {await access(marker);started=true;break;} catch {await new Promise(resolve => setTimeout(resolve,20));} }
  try { assert.equal(started,true); await commitAt(r.cwd,{'external':'move trunk'}); } finally {await writeFile(release,'release');}
  const result=await outcome; assert.match(String(result.error),/CAS/); assert.deepEqual(await ledger.read(),before);
 } finally {await r.cleanup();}
});

test('merge conflict is refused as rebase needed; receipt reports uncovered changes', {timeout:30_000}, async () => {
 const r=await repo(); try {
  await commitAt(r.cwd,{'shared':'base'});
  const plan=JSON.stringify({version:1,trunk:'main',nodes:[{id:'a',writes:['shared']},{id:'b',writes:['shared']}]});
  await ops.init({cwd:r.cwd,plan,as:owner,channel:'flag'});
  for(const id of ['a','b']) { const p=await ops.dispatch({cwd:r.cwd,node:id,as:parent}); await commitAt(p.worktree,{'shared':id}); await ops.submit({cwd:p.worktree,node:id,as:{role:'writer',id:`${id}#1`}}); await ops.attest({cwd:r.cwd,node:id}); }
  assert.deepEqual((await ops.why({cwd:r.cwd,node:'b'})).untested,['shared']);
  await ops.merge({cwd:r.cwd,node:'a',as:parent}); const ledger=await Ledger.open(r.cwd), before=await ledger.read();
  await assert.rejects(ops.merge({cwd:r.cwd,node:'b',as:parent}),/rebase needed/); assert.deepEqual(await ledger.read(),before);
 } finally {await r.cleanup();}
});

test('judgment blocks, owner waivers and report boundaries retain visible risk', {timeout:30_000}, async () => {
 const r=await repo(); try {
  await commitAt(r.cwd,{'value':'base'});
  await ops.init({cwd:r.cwd,plan:JSON.stringify({version:1,trunk:'main',nodes:[{id:'a',writes:['value'],review:{count:1,min_rank:1}}]}),as:owner,channel:'flag'});
  const a=await ops.dispatch({cwd:r.cwd,node:'a',as:parent}); await commitAt(a.worktree,{'value':'candidate'});
  await ops.submit({cwd:a.worktree,node:'a',as:{role:'writer',id:'a#1'}}); await ops.attest({cwd:r.cwd,node:'a'});
  const block=await ops.review({cwd:r.cwd,node:'a',as:{role:'reviewer',id:'fresh'},verdict:'block',rank:2,note:'risk'});
  await assert.rejects(ops.review({cwd:r.cwd,node:'a',as:{role:'reviewer',id:'a#1'},verdict:'ok',rank:2,note:'self'}),/writer/);
  await assert.rejects(ops.waive({cwd:r.cwd,node:'a',as:owner,channel:undefined!,obligation:'review',reason:'risk'}),/channel/);
  await ops.waive({cwd:r.cwd,node:'a',as:owner,channel:'flag',obligation:'review',reason:'explicit risk',accept_risk:[block.seq]});
  const card=await ops.why({cwd:r.cwd,node:'a'}); assert.equal(card.accepted,true); assert.equal(card.items.find(i => i.obligation === 'review')?.mark,'⚠'); assert.equal(card.blocks.length,0);
  const report=await ops.report({cwd:r.cwd,since:block.seq}); assert.equal(report.waivers.length,1); assert.ok(report.changes.some(c => c.after === 'W'));
  assert.equal((await ops.report({cwd:r.cwd,since:'2100-01-01T00:00:00Z'})).waivers.length,0);
  await ops.planSet({cwd:r.cwd,plan:JSON.stringify({version:1,trunk:'main',nodes:[]}),as:owner,channel:'flag'});
  assert.ok((await ops.report({cwd:r.cwd})).downgrades.length);
 } finally {await r.cleanup();}
});

test('dispatch races serialize and abandon permits a new writer slot', {timeout:60_000}, async () => {
 const r=await repo(); try { await seed(r.cwd); await ops.init({cwd:r.cwd,plan:planText,as:owner,channel:'flag'});
  const results=await Promise.allSettled([ops.dispatch({cwd:r.cwd,node:'a',as:parent}),ops.dispatch({cwd:r.cwd,node:'a',as:parent})]); assert.equal(results.filter(x => x.status === 'fulfilled').length,1);
  await ops.abandon({cwd:r.cwd,node:'a',as:parent,reason:'retry'}); const a=await ops.dispatch({cwd:r.cwd,node:'a',as:parent}); assert.equal(a.attempt,2);
  assert.equal((await ops.status({cwd:r.cwd})).nodes.a?.slot?.writer,'writer:a#2'); assert.equal(await revParse(a.worktree,'HEAD'),await revParse(r.cwd,'main'));
 } finally { await r.cleanup(); }
});
