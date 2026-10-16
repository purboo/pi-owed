import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionToolContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { parsePlan } from '../src/plan.ts';
import { projectId } from '../src/reducer.ts';
import { reviewerLaunch, writerLaunch } from '../src/drive.ts';
import type { RunView } from '../src/types.ts';
import { Driver } from '../src/drive-run.ts';
import { Dsa } from '../src/dsa.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const parent = { role:'parent', id:'test' } as const;
const owner = { role:'owner', id:'pi' } as const;
type Node = { id:string; deps?:string[]; writes?:string[]; brief?:string; review?:{count:number;min_rank:number}; later?:boolean; checks?:unknown[] };
function plan(nodes: Node[], extra = {}) { return JSON.stringify({version:1,trunk:'main',lease:false,invariants:[],nodes,...extra}); }
async function setup(text = plan([{id:'a',writes:['a/']},{id:'b',writes:['b/']}])) {
  const r = await repo(); await r.put('seed','seed'); await r.commit();
  const file = join(r.root,'plan.yaml'); await writeFile(file,text);
  await ops.init({cwd:r.cwd,as:owner,channel:'delegated',plan:text});
  await ops.planSet({cwd:r.cwd,as:parent,...await ops.readPlan({cwd:r.cwd,path:file})});
  return {...r,file};
}
async function call(cwd:string,args:string[],code=0) {
  const r = await cli(cwd,args); assert.equal(r.code,code,`${args.join(' ')}\n${r.stderr}\n${r.stdout}`); return r;
}
const entries = async (cwd:string) => (await Ledger.open(cwd)).read();
async function candidate(cwd:string,id:string,path = `${id}/x`) {
  const d = await ops.dispatch({cwd,as:parent,node:id}); await commitAt(d.worktree,{[path]:'changed'});
  await ops.submit({cwd:d.worktree,as:{role:'writer',id:`${id}#1`},node:id}); return d;
}
function tools() {
  const registered = new Map<string,ToolDefinition>();
  owed({registerTool:(t:ToolDefinition) => registered.set(t.name,t),on:()=>{},registerCommand:()=>{},registerMessageRenderer:()=>{}} as unknown as ExtensionAPI);
  return async (name:string,args:unknown) => registered.get(`owed_${name}`)!.execute('test',args,undefined,undefined,{hasUI:false} as ExtensionToolContext);
}

test('PO1: covered amend refuses without ledger/file mutation; packet and measured grant replace the parent act', async () => {
  const r = await setup(plan([{id:'a',writes:['a/']}],{allow:[{nodes:['a'],writes:['test/']}]}));
  try {
    const before = await entries(r.cwd), text = await readFile(r.file,'utf8');
    const refused = await call(r.cwd,['amend','a','--writes','+test/new.ts','--note','test coverage'],1);
    assert.match(refused.stderr,/not needed: test\/new.ts are covered by allow rule \(plan #1\); owed grants them at measurement; tell the writer to edit them/);
    assert.deepEqual(await entries(r.cwd),before); assert.equal(await readFile(r.file,'utf8'),text);
    const d = await ops.dispatch({cwd:r.cwd,as:parent,node:'a'});
    assert.match(d.packet,/edit these freely; do not ask the parent; owed grants them when your candidate is measured/);
    await commitAt(d.worktree,{'test/new.ts':'test'}); await call(d.worktree,['submit','a']);
    await call(r.cwd,['attest','a']);
    assert.ok((await entries(r.cwd)).some(e => e.kind === 'grant' && e.paths.includes('test/new.ts')));
    // Mixed covered/uncovered additions remain a real owner decision.
    await assert.rejects(ops.amend({cwd:r.cwd,as:parent,node:'a',writes:['+test/other','+production/'],note:'mixed'}),/Only owner|owner|allowance/);
  } finally { await r.cleanup(); }
});

test('PO2: CLI comma batch appends contiguous resumes; an unknown or invalid after refuses the whole batch', async () => {
  const r = await setup();
  try {
    await ops.dispatch({cwd:r.cwd,as:parent,node:'a'}); await ops.dispatch({cwd:r.cwd,as:parent,node:'b'});
    const start = (await entries(r.cwd)).length;
    await call(r.cwd,['resume','a,b','--note','retry','--expect','report']);
    const batch = (await entries(r.cwd)).slice(start);
    assert.equal(batch.length,2); assert.deepEqual(batch.map(e => e.kind === 'resume' ? [e.node,e.batch,e.expect,e.note] : []),[['a',start,'report','retry'],['b',start,'report','retry']]);
    await call(r.cwd,['resume','a,unknown','--note','atomic'],1);
    assert.equal((await entries(r.cwd)).length,start+2);
    await call(r.cwd,['resume','a,b','--after','b'],1); assert.equal((await entries(r.cwd)).length,start+2);
    const one = JSON.parse((await call(r.cwd,['resume','a','--json'])).stdout); assert.equal(one.batch,undefined);
    assert.equal((await ops.verify({cwd:r.cwd})).ok,true);
  } finally { await r.cleanup(); }
});

test('PO2: pi tool node list shares one batch and refuses every member when a later node has no slot', async () => {
  const r = await setup();
  try {
    const invoke = tools(); await ops.dispatch({cwd:r.cwd,as:parent,node:'a'});
    const before = await entries(r.cwd), fail = await invoke('resume',{cwd:r.cwd,node:['a','b'],note:'retry'});
    assert.equal(fail.isError,true); assert.deepEqual(await entries(r.cwd),before);
    await ops.dispatch({cwd:r.cwd,as:parent,node:'b'});
    const done = await invoke('resume',{cwd:r.cwd,node:['a','b'],note:'retry'});
    assert.ok(!done.isError,JSON.stringify(done));
    const tail = (await entries(r.cwd)).slice(-2); assert.equal(tail[0]!.kind,'resume'); assert.equal(tail[1]!.kind,'resume');
    assert.equal(tail[0]!.kind === 'resume' && tail[0]!.batch,tail[0]!.seq);
    assert.equal(tail[1]!.kind === 'resume' && tail[1]!.batch,tail[0]!.seq);
  } finally { await r.cleanup(); }
});

test('PO3: metrics divide a batch and multi-node ruling, separating pending and unattributed window acts', async () => {
  const r = await setup();
  try {
    await candidate(r.cwd,'a'); await candidate(r.cwd,'b');
    const since = (await entries(r.cwd)).at(-1)!.seq;
    await call(r.cwd,['resume','a,b']); await ops.rule({cwd:r.cwd,as:parent,nodes:['a','b'],text:'shared guidance'});
    await ops.rule({cwd:r.cwd,as:parent,nodes:'*',text:'general policy'});
    await call(r.cwd,['attest','a'],4);
    // Rulings still require independent acknowledgment, even on a checkless node.
    await ops.review({cwd:r.cwd,as:{role:'reviewer',id:'fresh'},node:'a',verdict:'ok',rank:1,note:'ack',ack_rulings:(await entries(r.cwd)).at(-2)!.seq});
    await ops.merge({cwd:r.cwd,as:parent,node:'a'});
    const m = JSON.parse((await call(r.cwd,['report','--metrics','--since',String(since),'--json'])).stdout);
    assert.equal(m.parentActs.total,3); assert.deepEqual(m.parentActs.byNode,{a:1,b:1});
    assert.equal(m.parentActs.perMergedNodeAttributed,1); assert.equal(m.parentActs.pending,1); assert.equal(m.parentActs.unattributed,1);
    assert.equal(m.parentActs.byClass.resume,1); assert.equal(m.parentActs.byClass.rule,2);
    const beforeMerge = (await entries(r.cwd)).findLast(e => e.kind === 'merge')!.seq-1;
    const cut = await ops.reportMetrics({cwd:r.cwd,since,until:beforeMerge}); assert.equal(cut.parentActs.pending,2); assert.equal(cut.parentActs.perMergedNodeAttributed,null);
  } finally { await r.cleanup(); }
});

test('PO4: plan and edit dry run warn once for critical overlap, suppress dependent, merged and noncritical pairs', async () => {
  const r = await setup(plan([{id:'base',writes:['shared/']},{id:'middle',deps:['base'],writes:['mid/']},{id:'sink',deps:['middle'],writes:['sink/']},{id:'short',writes:['short/']} ]));
  try {
    const next = plan([{id:'base',writes:['shared/']},{id:'middle',deps:['base'],writes:['mid/']},{id:'sink',deps:['middle'],writes:['sink/']},{id:'short',writes:['short/']},{id:'new',writes:['shared/x','shared/y','short/']}]);
    await writeFile(r.file,next); const saved = await call(r.cwd,['plan',r.file]);
    const warning = 'writes of new overlap base (on the critical path): consider deps new after base';
    assert.equal(saved.stdout.split(warning).length-1,1); assert.doesNotMatch(saved.stdout,/overlap short \(on the critical path\)/);
    const before = await entries(r.cwd), text = await readFile(r.file,'utf8');
    const dry = await call(r.cwd,['edit','new','--set','brief=details','--note','preview','--dry-run']); assert.ok(dry.stdout.includes(warning));
    assert.deepEqual(await entries(r.cwd),before); assert.equal(await readFile(r.file,'utf8'),text);
    const dependent = await ops.editPreview({cwd:r.cwd,node:'new',set:['deps=[base]'],note:'order'}); assert.ok(!dependent.warnings.some(w => w.includes('overlap base')));
    await candidate(r.cwd,'base','shared/x'); await call(r.cwd,['attest','base']); await ops.merge({cwd:r.cwd,as:parent,node:'base'});
    const after = await ops.editPreview({cwd:r.cwd,node:'new',set:['brief=after merge'],note:'preview'}); assert.ok(!after.warnings.some(w => w.includes('overlap base')));
  } finally { await r.cleanup(); }
});

test('PO5: attest exits 4 for open review/error, 1 for newly measured failures, 0 after closure; cached failures are not new measurements', async () => {
  const r = await setup(plan([{id:'a',writes:['a/'],review:{count:1,min_rank:1}},{id:'b',writes:['b/'],checks:[{id:'bad',run:'echo "owed-counts {\"pass\":0,\"fail\":1,\"failed\":[\"broken\"]}"; exit 1',reads:['b/']}]},{id:'c',writes:['c/'],checks:[{id:'error',run:'exit 126',reads:['c/']}]}]));
  try {
    await candidate(r.cwd,'a'); await call(r.cwd,['attest','a'],4);
    await ops.review({cwd:r.cwd,as:{role:'reviewer',id:'independent'},node:'a',verdict:'ok',rank:1,note:'review'}); await call(r.cwd,['attest','a']);
    await candidate(r.cwd,'b'); await call(r.cwd,['attest','b'],1); await call(r.cwd,['attest','b'],1);
    await candidate(r.cwd,'c'); await call(r.cwd,['attest','c'],4);
    const updated = plan([{id:'a',writes:['a/'],review:{count:1,min_rank:1}},{id:'b',writes:['b/'],checks:[{id:'bad',run:'echo "owed-counts {\"pass\":0,\"fail\":1,\"failed\":[\"broken\"]}"; exit 1',reads:['b/']}]},{id:'c',writes:['c/'],checks:[{id:'error',run:'exit 126',reads:['c/']}]}],{invariants:[{id:'bad',run:'exit 1',reads:['seed']}]});
    await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',plan:updated,note:'new invariant'});
    await call(r.cwd,['attest','--trunk'],1);
    const genesis = await repo(), trigger = join(genesis.root,'fail-now');
    try {
      await genesis.put('seed','seed'); await genesis.commit();
      await ops.init({cwd:genesis.cwd,as:owner,channel:'delegated',plan:plan([],{invariants:[{id:'bad',run:`if test -f '${trigger}'; then exit 1; else exit 126; fi`,reads:['seed']}]})});
      await writeFile(trigger,'fail'); await call(genesis.cwd,['attest','--genesis'],1);
      await call(genesis.cwd,['attest','--genesis']); // Existing fail diagnostics are not observations of this action.
    } finally { await genesis.cleanup(); }
    const help = (await call(r.cwd,['--help'])).stdout;
    assert.match(help,/attest exit codes: 0 = .*1 = .*4 = .*3 = internal error/);
    assert.match(help,/an observation recorded by this action has verdict fail, including known_red/);
  } finally { await r.cleanup(); }
});

test('PO5: driver treats attest exit 4 as completed measurement instead of halting', async () => {
  const r = await setup(plan([{id:'a',writes:['a/']}]));
  try {
    await candidate(r.cwd,'a');
    const script = join(r.root,'attest-open.sh'); await writeFile(script,'#!/bin/sh\nexit 4\n'); await chmod(script,0o755);
    const state = (await ops.readState({cwd:r.cwd})).state, launch = writerLaunch(state,'a',projectId(state));
    await ops.launch({cwd:r.cwd,as:{role:'parent',id:'drive'},node:'a',attempt:1,role:'writer',rid:launch.rid,spec:launch.spec,labels:launch.labels,rulings:launch.rulings});
    class SealedDsa extends Dsa { async inspect(rid:string): Promise<{view:RunView}> { return {view:{rid,state:'sealed',status:'ok'}}; } }
    const driver = new Driver({cwd:r.cwd,log:()=>{},dsa:new SealedDsa({bin:join(r.root,'missing-dsa')}),owed:[script]});
    const first = await driver.pass(); assert.ok(first.actions.some(e => e.do === 'attest'));
    await driver.drain(30_000); await driver.pass(); assert.ok(!(await entries(r.cwd)).some(e => e.kind === 'halt' && e.reason.includes('attest error')));
  } finally { await r.cleanup(); }
});

test('PO5: driver halts on actual CLI ENOTDIR internal error and never silently re-attests', async () => {
  const r = await setup(plan([{id:'a',writes:['a/']}]));
  try {
    await candidate(r.cwd,'a');
    const invalid = join(r.root,'not-a-directory'), script = join(r.root,'attest-internal.sh');
    await writeFile(invalid,'file');
    await writeFile(script,`#!/bin/sh\nexport OWED_DIR='${invalid}'\nexec '${process.execPath}' '${fileURLToPath(new URL('../bin/owed.js',import.meta.url))}' "$@"\n`); await chmod(script,0o755);
    const state = (await ops.readState({cwd:r.cwd})).state, launch = writerLaunch(state,'a',projectId(state));
    await ops.launch({cwd:r.cwd,as:{role:'parent',id:'drive'},node:'a',attempt:1,role:'writer',rid:launch.rid,spec:launch.spec,labels:launch.labels,rulings:launch.rulings});
    class SealedDsa extends Dsa { async inspect(rid:string): Promise<{view:RunView}> { return {view:{rid,state:'sealed',status:'ok'}}; } }
    const driver = new Driver({cwd:r.cwd,log:()=>{},dsa:new SealedDsa({bin:join(r.root,'missing-dsa')}),owed:[script]});
    assert.ok((await driver.pass()).actions.some(e => e.do === 'attest' && e.outcome === 'started'));
    await driver.drain(30_000);
    const next = await driver.pass();
    assert.ok((await entries(r.cwd)).some(e => e.kind === 'halt' && /attest error:.*exited 3:.*ENOTDIR/s.test(e.reason)));
    assert.ok(!next.actions.some(e => e.do === 'attest' && e.outcome === 'started'));
    assert.ok(!(await driver.pass()).actions.some(e => e.do === 'attest' && e.outcome === 'started'));
  } finally { await r.cleanup(); }
});

test('PO5: a newly recorded known_red trunk failure exits 1 despite an empty failed diagnostic list', async () => {
  const r = await setup(plan([{id:'fix',writes:['fix/']}]));
  try {
    const updated = plan([{id:'fix',writes:['fix/']}],{invariants:[{id:'bad',run:'echo \'owed-counts {"pass":1,"fail":1,"failed":["broken"]}\'; exit 1',reads:['seed'],min_tests:1,known_red:[{test:'broken',fix:'fix'}]}]});
    await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',plan:updated,note:'track known red'});
    const result = JSON.parse((await call(r.cwd,['attest','--trunk','--json'],1)).stdout) as {failed:string[];observations:Array<{verdict:string}>};
    assert.deepEqual(result.failed,[]); assert.ok(result.observations.some(e => e.verdict === 'fail'));
    await call(r.cwd,['attest','--trunk']); // No newly recorded failure on the cached invocation.
  } finally { await r.cleanup(); }
});

test('PO6: review derives only the current driver launch ack; post-launch rulings and manual reviewers stay outstanding', async () => {
  const r = await setup(plan([{id:'a',writes:['a/'],review:{count:1,min_rank:1}}]));
  try {
    await candidate(r.cwd,'a'); await call(r.cwd,['attest','a'],4);
    const ruling = await ops.rule({cwd:r.cwd,as:parent,nodes:['a'],text:'in reviewer packet'});
    const state = (await ops.readState({cwd:r.cwd})).state;
    const action = reviewerLaunch(state,'a',1,projectId(state),r.cwd);
    await ops.launch({cwd:r.cwd,as:{role:'parent',id:'drive'},node:'a',attempt:1,role:'reviewer',rid:action.rid,spec:action.spec,labels:action.labels,rulings:action.rulings});
    const who = 'reviewer:drive-a-1-1';
    const review = JSON.parse((await call(r.cwd,['review','a','--ok','--rank','1','--as',who,'--note','packet read','--json'])).stdout);
    assert.equal(review.ack_rulings,ruling.seq); assert.equal((await ops.why({cwd:r.cwd,node:'a'})).accepted,true);
    const later = await ops.rule({cwd:r.cwd,as:parent,nodes:['a'],text:'after launch'});
    const before = await entries(r.cwd);
    await assert.rejects(ops.review({cwd:r.cwd,as:{role:'reviewer',id:'drive-a-1-1'},node:'a',verdict:'ok',rank:1,note:'old packet'}), /ack-rulings must be at least/);
    assert.equal((await ops.why({cwd:r.cwd,node:'a'})).accepted,false);
    await assert.rejects(ops.review({cwd:r.cwd,as:{role:'reviewer',id:'manual'},node:'a',verdict:'ok',rank:1,note:'manual'}), /ack-rulings must be at least/);
    assert.deepEqual(await entries(r.cwd), before);
    await ops.review({cwd:r.cwd,as:{role:'reviewer',id:'drive-a-1-1'},node:'a',verdict:'ok',rank:1,note:'explicit',ack_rulings:later.seq}); assert.equal((await ops.why({cwd:r.cwd,node:'a'})).accepted,true);
  } finally { await r.cleanup(); }
});

test('PO6: missing earliest ruling with the latest present cannot derive an acknowledgment', async () => {
  const r = await setup(plan([{id:'a',writes:['a/'],review:{count:1,min_rank:1}}]));
  try {
    await candidate(r.cwd,'a');
    const ruling = await ops.rule({cwd:r.cwd,as:parent,nodes:['a'],text:'must inspect this ruling'});
    const latest = await ops.rule({cwd:r.cwd,as:parent,nodes:['a'],text:'latest is still in the packet'});
    const state = (await ops.readState({cwd:r.cwd})).state, action = reviewerLaunch(state,'a',1,projectId(state),r.cwd);
    const spec = JSON.parse(action.spec) as {task:string}; spec.task = spec.task.replace(`- #${ruling.seq} ${ruling.kind === 'rule' ? ruling.text : ''}\n`,'');
    assert.ok(spec.task.includes(`- #${latest.seq} latest is still in the packet\n`));
    await ops.launch({cwd:r.cwd,as:{role:'parent',id:'drive'},node:'a',attempt:1,role:'reviewer',rid:action.rid,spec:JSON.stringify(spec),labels:action.labels,rulings:latest.seq});
    const before = await entries(r.cwd);
    await assert.rejects(ops.review({cwd:r.cwd,as:{role:'reviewer',id:'drive-a-1-1'},node:'a',verdict:'ok',rank:1,note:'metadata is not a packet'}), /ack-rulings must be at least/);
    assert.deepEqual(await entries(r.cwd), before);
    assert.equal((await ops.why({cwd:r.cwd,node:'a'})).items.find(i => i.obligation === 'rulings')!.status,'D');
  } finally { await r.cleanup(); }
});

test('PO6: a missing middle ruling caps the derived ack at the complete earlier prefix', async () => {
  const r = await setup(plan([{id:'a',writes:['a/'],review:{count:1,min_rank:1}}]));
  try {
    await candidate(r.cwd,'a');
    const first = await ops.rule({cwd:r.cwd,as:parent,nodes:['a'],text:'first\nmultiline ruling'});
    const middle = await ops.rule({cwd:r.cwd,as:parent,nodes:['a'],text:'middle'});
    await ops.rule({cwd:r.cwd,as:parent,nodes:['a'],text:'latest'});
    const state = (await ops.readState({cwd:r.cwd})).state, action = reviewerLaunch(state,'a',1,projectId(state),r.cwd);
    const spec = JSON.parse(action.spec) as {task:string}; spec.task = spec.task.replace(`- #${middle.seq} middle\n`,'');
    await ops.launch({cwd:r.cwd,as:{role:'parent',id:'drive'},node:'a',attempt:1,role:'reviewer',rid:action.rid,spec:JSON.stringify(spec),labels:action.labels,rulings:action.rulings});
    const before = await entries(r.cwd);
    await assert.rejects(ops.review({cwd:r.cwd,as:{role:'reviewer',id:'drive-a-1-1'},node:'a',verdict:'ok',rank:1,note:'incomplete packet'}), /ack-rulings must be at least/);
    assert.deepEqual(await entries(r.cwd), before);
    assert.equal((await ops.why({cwd:r.cwd,node:'a'})).items.find(i => i.obligation === 'rulings')!.status,'D');
  } finally { await r.cleanup(); }
});

test('PO7: CLI and pi edit preserve unquoted multiline and equals-containing brief text; empty brief still refuses atomically', async () => {
  const r = await setup();
  try {
    const brief = 'Goal: preserve a=b\nSecond line: x=y';
    await call(r.cwd,['edit','a','--set',`brief=${brief}`,'--note','clarify']);
    assert.equal(parsePlan(await readFile(r.file,'utf8')).nodes[0]!.brief,brief);
    const invoke = tools(), second = 'first=second\nnext: third=fourth';
    const result = await invoke('edit',{cwd:r.cwd,node:'a',set:[`brief=${second}`],note:'clarify again'}); assert.ok(!result.isError,JSON.stringify(result));
    assert.equal(parsePlan(await readFile(r.file,'utf8')).nodes[0]!.brief,second);
    const before = await entries(r.cwd), text = await readFile(r.file,'utf8');
    await call(r.cwd,['edit','a','--set','brief=','--note','invalid'],2);
    assert.deepEqual(await entries(r.cwd),before); assert.equal(await readFile(r.file,'utf8'),text);
    await call(r.cwd,['edit','a','--set','brief="quoted=value"','--note','YAML compatible']); assert.equal(parsePlan(await readFile(r.file,'utf8')).nodes[0]!.brief,'quoted=value');
  } finally { await r.cleanup(); }
});
