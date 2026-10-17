// WF1–WF5: real ledger/git fixtures, CLI/ops receipts and the driver's decision paths.
import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import childProcess from 'node:child_process';
import { join } from 'node:path';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { clockTime } from '../src/clock.ts';
import { decide as driveDecide, ownerNeeded, repairMessage } from '../src/drive.ts';
import { Follower, revalidator } from '../src/drive-bg.ts';
import { projectId, runId, runLabels, dispatchSkip, trunkRedOf, flakyPass } from '../src/reducer.ts';
import { renderStatus, statusView, receipt, renderWhy, waiverText } from '../src/views.ts';
import type { ObsEntry, RunView } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const owner = {role:'owner',id:'pi'} as const, parent = {role:'parent',id:'test'} as const;
const writer = {role:'writer',id:'a#1'} as const;
const now = Date.parse('2026-10-16T12:00:00Z');
const PASS = "echo '# tests 4'; echo '# pass 4'; echo '# fail 0'";
const FAIL = `echo 'owed-counts {"pass":0,"fail":4,"failed":["case one","case two","case three","case four"]}'; exit 1`;
const read = (r: {cwd:string}) => ops.readState(r);
const checkObs = async (r: {cwd:string}) => (await read(r)).entries.filter((e): e is ObsEntry => e.kind === 'obs' && e.subject === 'a' && e.obligation === 'check:unit');
async function fixture(merge = false, attribute = true, trunkRed = false) {
  const r = await repo(), flag = join(r.root,'pass');
  await commitAt(r.cwd, {impl:'base'});
  const run = merge ? `if [ -e src/b ]${trunkRed ? '' : ' && grep -q candidate impl'} && [ ! -e '${flag}' ]; then ${FAIL}; else ${PASS}; fi` : `if [ -e '${flag}' ]; then ${PASS}; else ${FAIL}; fi`;
  const plan = {version:1,trunk:'main',lease:false,closure:[],invariants:[],nodes:[
    {id:'a',writes:['impl'],checks:[{id:'unit',run,reads:['impl','src/'],min_tests:1}],review:{count:0,min_rank:1}},
    {id:'b',writes:['src/b'],checks:[],review:{count:0,min_rank:1}},
  ]};
  await ops.init({cwd:r.cwd,as:owner,channel:'delegated',plan:JSON.stringify(plan)});
  const a = await ops.dispatch({cwd:r.cwd,as:parent,node:'a'});
  const old = await commitAt(a.worktree,{impl:'old candidate'});
  await ops.submit({cwd:a.worktree,as:writer,node:'a',model:'test'});
  await ops.attest({cwd:r.cwd,node:'a'});
  if (merge) {
    const b = await ops.dispatch({cwd:r.cwd,as:parent,node:'b'});
    await commitAt(b.worktree,{'src/b':'trunk addition'});
    await ops.submit({cwd:b.worktree,as:{role:'writer',id:'b#1'},node:'b',model:'test'});
    await ops.attest({cwd:r.cwd,node:'b'});
    await ops.merge({cwd:r.cwd,as:parent,node:'b'});
    await assert.rejects(ops.merge({cwd:r.cwd,as:parent,node:'a'}),/active blocks|unsatisfied/);
  }
  const fail = (await checkObs(r)).find(e => e.verdict === 'fail')!;
  assert.ok(fail);
  let pass = fail;
  if (attribute) {
    await writeFile(flag,'pass');
    await ops.attest({cwd:r.cwd,node:'a'});
    pass = (await checkObs(r)).find(e => e.attribution && e.key === fail.key && e.verdict === 'pass')!;
    assert.ok(pass);
  }
  return {...r,flag,a,old,fail,pass};
}
async function change(r: Awaited<ReturnType<typeof fixture>>) {
  const commit = await commitAt(r.a.worktree,{impl:'new candidate'});
  await ops.submit({cwd:r.a.worktree,as:writer,node:'a',model:'test'});
  return commit;
}
async function driver(r: {cwd:string}) {
  let {state} = await read(r);
  const rid = runId(projectId(state),'a',1,'writer');
  await ops.launch({cwd:r.cwd,as:parent,node:'a',attempt:1,role:'writer',rid,spec:'{}',labels:runLabels(projectId(state),'a',1,'writer'),rulings:0});
  ({state} = await read(r));
  const runs = new Map<string,RunView>([[rid,{rid,state:'sealed',status:'ok'}]]);
  return {state,runs,opts:{max:2,repairs:2,project:projectId(state),root:r.cwd,applied:new Set<string>(),rejected:new Map<string,string>(),now}};
}

// The explicit clock is stable across local dates/timezones; no wall-clock wait drives a transition.
test('WF1/WF2: held old-key flake waits, candidate pass exposes its exact attribution pair everywhere',async () => {
  const r = await fixture();
  try {
    const current = await change(r), {state,entries} = await read(r);
    assert.equal(state.nodes.a!.blocks.find(b => b.seq === r.fail.seq)?.state,'flaky');
    assert.equal(state.nodes.a!.accepted,false,'hold never weakens acceptance');
    assert.equal(ownerNeeded(state,'a'),undefined);
    assert.notEqual(dispatchSkip(state,'a',2)?.kind,'owner');
    const i = state.nodes.a!.items.find(i => i.obligation === 'check:unit')!;
    assert.equal(i.discharger,'executor');
    assert.match(i.detail,/waiting for check:unit on candidate .* before deciding flaky/);
    assert.equal(statusView(state,entries,[],now,true).summary!.needs.length,0);
    assert.match(renderStatus(statusView(state,entries,[],now,true)),new RegExp(`a: waiting for check:unit on candidate ${current.slice(0,12)} before deciding flaky #${r.fail.seq}`));
    const brief = await ops.brief({...r,now}); assert.equal(brief.decisions.length,0);
    assert.equal((await ops.report(r)).decisions.length,0);
    assert.doesNotMatch(renderWhy(receipt(state,entries,'a')),/owed waive a/);
    assert.ok(clockTime(entries.at(-1)!.ts,now));
    await ops.attest({cwd:r.cwd,node:'a'});
    const after = await read(r), latest = (await checkObs(r)).findLast(e => !e.attribution && e.verdict === 'pass')!;
    const pair = `failed #${r.fail.seq} (case one, case two, case three, +1) → passed #${r.pass.seq} on the same key`;
    for (const text of [ownerNeeded(after.state,'a')!,renderStatus(statusView(after.state,after.entries,[],now,true)),renderWhy(await ops.why({...r,node:'a'})),repairMessage(after.state,'a')]) {
      assert.ok(text.includes(pair),text); assert.ok(text.includes(`current candidate ${current.slice(0,12)} passed #${latest.seq}`),text);
    }
    const d = await driver(r), action = driveDecide(d.state,d.state.plan,d.runs,d.opts).find(a => a.do === 'notify' && a.node === 'a');
    assert.ok(action?.do === 'notify');
    const log = join(r.root,'wake.jsonl');
    await writeFile(log,JSON.stringify({do:'notify',node:'a',text:action.text})+'\n');
    const follower = new Follower({log,repo:r.cwd,pid:process.pid,from:0,deliver(){}});
    const wake = await follower.step(); follower.stop();
    assert.ok(wake?.includes(pair),String(wake)); assert.match(wake!,/a pass does not erase a failure/);
  } finally {await r.cleanup();}
});

test('WF2: held flake cannot send repair or owner halt before the candidate is measured',async () => {
  const r = await fixture();
  try {
    await change(r); const d = await driver(r), actions = driveDecide(d.state,d.state.plan,d.runs,d.opts);
    assert.ok(actions.some(a => a.do === 'attest' && a.node === 'a'),JSON.stringify(actions));
    assert.ok(!actions.some(a => a.do === 'send' && a.reason === 'repair' || a.do === 'halt' && a.needs === 'owner' || a.do === 'notify' && a.text.includes('needs the owner')),JSON.stringify(actions));
    assert.doesNotMatch(repairMessage(d.state,'a'),/flaky block #/);
    assert.deepEqual(await revalidator({cwd:r.cwd})([{node:'a',flaky:r.fail.seq}]),[false],'a stale wake for the held flake is suppressed');
  } finally {await r.cleanup();}
});

test('WF2: error-only current measurement keeps hold, a failed candidate follows the existing writer repair path',async () => {
  const r = await fixture();
  try {
    const current = await change(r), ledger = await Ledger.open(r.cwd), {state} = await read(r);
    await ledger.withLock(async () => ledger.append([{kind:'obs',by:'executor:owed',subject:'a',obligation:'check:unit',key:state.nodes.a!.candidate!.keys['check:unit']!,commit:current,verdict:'error',exit:1,durationMs:1,note:'environment: fixture unavailable'}]));
    assert.equal(ownerNeeded((await read(r)).state,'a'),undefined);
    const {unlink} = await import('node:fs/promises'); await unlink(r.flag);
    await ops.attest({cwd:r.cwd,node:'a'});
    const d = await driver(r), i = d.state.nodes.a!.items.find(i => i.obligation === 'check:unit')!;
    assert.equal(i.discharger,'writer');
    assert.ok(!i.detail.includes(`#${r.fail.seq}`),i.detail);
    assert.ok(!repairMessage(d.state,'a').includes(`failed #${r.fail.seq}`),'held history is not sent as a repair failure');
    const actions = driveDecide(d.state,d.state.plan,d.runs,d.opts);
    assert.ok(actions.some(a => a.do === 'send' && a.reason === 'repair'),JSON.stringify(actions));
    assert.equal(ownerNeeded(d.state,'a'),undefined);
  } finally {await r.cleanup();}
});

test('WF1/WF2: same-key flaky need is immediate and names its original failed commit',async () => {
  const r = await fixture();
  try {
    const {state} = await read(r), text = ownerNeeded(state,'a')!;
    assert.match(text,new RegExp(`flaky block #${r.fail.seq} on check:unit: ${r.old.slice(0,12)} failed #${r.fail.seq}.*passed #${r.pass.seq} on the same key`));
    assert.match(text,/owed waive a check:unit --accept-risk \d+ --reason/);
    assert.doesNotMatch(text,/current candidate/);
    assert.ok((await ops.status(r)).summary!.needs.some(n => n.node === 'a'));
  } finally {await r.cleanup();}
});

test('WF1/WF2: merge-key flaky need is immediate even with an unmeasured new candidate',async () => {
  const r = await fixture(true);
  try {
    await change(r); const {state} = await read(r), text = ownerNeeded(state,'a')!;
    assert.match(text,new RegExp(`flaky block #${r.fail.seq} on check:unit \\(merge key ${r.fail.key.slice(0,12)}\\)`));
    assert.match(text,new RegExp(`failed #${r.fail.seq}.*passed #${r.pass.seq} on the same key`));
    assert.doesNotMatch(text,/current candidate/);
  } finally {await r.cleanup();}
});

// R-app027-1: reviewer probe 2, a trunk-red diagnosis must not hide the flaky attribution pair.
test('WF1 repair: trunk-red flaky merge-check keeps its diagnosis first and its exact pair in why',async () => {
  const r = await fixture(true,false,true);
  try {
    const before = await read(r);
    assert.ok(trunkRedOf(before.state,r.fail.seq));
    const activeCard = await ops.why({...r,node:'a'});
    assert.match(activeCard.blocks.find(b => b.seq === r.fail.seq)!.clear,/^trunk-red:/);
    assert.doesNotMatch(activeCard.blocks.find(b => b.seq === r.fail.seq)!.clear,/flaky block #/);
    await writeFile(r.flag,'pass');
    await ops.attest({cwd:r.cwd,node:'a'});
    const {state} = await read(r), block = state.nodes.a!.blocks.find(b => b.seq === r.fail.seq)!;
    assert.equal(block.state,'flaky');
    assert.ok(trunkRedOf(state,r.fail.seq));
    const pass = flakyPass(state,block)!;
    assert.ok(pass);
    const snapshot = structuredClone({blocks:state.nodes.a!.blocks,keys:state.nodes.a!.candidate!.keys,accepted:state.nodes.a!.accepted});
    const card = await ops.why({...r,node:'a'}), clear = card.blocks.find(b => b.seq === r.fail.seq)!.clear;
    assert.match(clear,/^trunk-red:/,'the trunk diagnosis retains precedence');
    assert.ok(clear.includes(`flaky block #${r.fail.seq} on check:unit (merge key ${r.fail.key.slice(0,12)})`),clear);
    assert.ok(clear.includes(`failed #${r.fail.seq}`) && clear.includes(`passed #${pass.seq} on the same key`),clear);
    const why = renderWhy(card);
    assert.ok(why.includes(clear),why);
    assert.ok(why.indexOf('trunk-red:') < why.indexOf(`flaky block #${r.fail.seq}`),why);
    const after = (await read(r)).state;
    assert.deepEqual({blocks:after.nodes.a!.blocks,keys:after.nodes.a!.candidate!.keys,accepted:after.nodes.a!.accepted},snapshot,'rendering cannot change blocks, keys or acceptance');
  } finally {await r.cleanup();}
});

// R-app027-1: reviewer probe 3, satisfying evidence can be a review rather than an executor observation.
test('WF3 repair: accepted old review risk names the satisfying review and omits missing evidence',async () => {
  const r = await repo();
  try {
    await commitAt(r.cwd,{impl:'base'});
    const plan = {version:1,trunk:'main',lease:false,closure:[],invariants:[],nodes:[{id:'a',writes:['impl'],checks:[],review:{count:1,min_rank:1}}]};
    await ops.init({cwd:r.cwd,as:owner,channel:'delegated',plan:JSON.stringify(plan)});
    const a = await ops.dispatch({cwd:r.cwd,as:parent,node:'a'});
    await commitAt(a.worktree,{impl:'old'});
    await ops.submit({cwd:a.worktree,as:writer,node:'a',model:'test'});
    await ops.attest({cwd:r.cwd,node:'a'});
    const block = await ops.review({cwd:r.cwd,as:{role:'reviewer',id:'old'},node:'a',verdict:'block',rank:2,note:'old issue'});
    await commitAt(a.worktree,{impl:'fixed'});
    await ops.submit({cwd:a.worktree,as:writer,node:'a',model:'test'});
    await ops.attest({cwd:r.cwd,node:'a'});
    const ok = await ops.review({cwd:r.cwd,as:{role:'reviewer',id:'new'},node:'a',verdict:'ok',rank:1,note:'new candidate checked'});
    const waiver = await ops.waive({cwd:r.cwd,as:owner,channel:'delegated',node:'a',obligation:'review',reason:'accept old review risk after new review',accept_risk:[block.seq]});
    assert.equal(waiver.kind,'waive');
    if (waiver.kind !== 'waive') throw new Error('expected waiver');
    const {state} = await read(r), item = state.nodes.a!.items.find(i => i.obligation === 'review')!;
    assert.equal(item.status,'E');
    assert.deepEqual(item.evidence,[ok.seq]);
    const snapshot = structuredClone({blocks:state.nodes.a!.blocks,keys:state.nodes.a!.candidate!.keys,accepted:state.nodes.a!.accepted});
    const meaning = await ops.waiverMeaning({cwd:r.cwd,entry:waiver});
    assert.doesNotMatch(meaning,/#undefined/);
    assert.ok(meaning.includes(`in effect now: --accept-risk accepts #${block.seq}; review on the candidate key is satisfied by #${ok.seq}`),meaning);
    assert.doesNotMatch(meaning,/waiver is not needed/);
    const missingEvidence = Object.create(Object.getPrototypeOf(state),Object.getOwnPropertyDescriptors(state)) as typeof state;
    missingEvidence.nodes = {...state.nodes,a:{...state.nodes.a!,items:state.nodes.a!.items.map(i => i === item ? {...i,evidence:[]} : i)}};
    const noEvidence = waiverText(missingEvidence,waiver);
    assert.doesNotMatch(noEvidence,/#undefined|on the candidate key is satisfied by/,'no claim when the displayed item has no satisfying evidence');
    const after = (await read(r)).state;
    assert.deepEqual({blocks:after.nodes.a!.blocks,keys:after.nodes.a!.candidate!.keys,accepted:after.nodes.a!.accepted},snapshot,'waiver text cannot change blocks, keys or acceptance');
  } finally {await r.cleanup();}
});

test('WF2/WF3: owner may accept risk while held, CLI receipt leads with debt and compact why',async () => {
  const r = await fixture();
  try {
    await change(r);
    const out = await cli(r.cwd,['waive','a','check:unit','--accept-risk',String(r.fail.seq),'--reason','accept held risk','--as','owner:pi']);
    assert.equal(out.code,0,out.stderr);
    assert.match(out.stdout,new RegExp(`^waived a/check:unit #\\d+: debt recorded on the candidate key [a-f0-9]{12} \\(accepted block risk #${r.fail.seq}\\)`));
    assert.match(out.stdout,/in effect now: --accept-risk accepts/);
    assert.match(out.stdout,/Details: owed why a --full/);
    assert.doesNotMatch(out.stdout,/Untested changes:|Untested obligations ΔO⁻:/);
    assert.equal((await ops.verify(r)).ok,true);
  } finally {await r.cleanup();}
});

test('WF3: merge fail → same-key pass → CLI waiver is in effect, not unnecessary; full restores receipt',async () => {
  const r = await fixture(true);
  try {
    const args = ['waive','a','check:unit','--accept-risk',String(r.fail.seq),'--reason','accept merge flake','--as','owner:pi'];
    const out = await cli(r.cwd,args); assert.equal(out.code,0,out.stderr);
    assert.match(out.stdout,new RegExp(`in effect now: --accept-risk accepts #${r.fail.seq} \\(flaky: failed #${r.fail.seq} → passed #${r.pass.seq} on the same key\\)`));
    assert.match(out.stdout,/check:unit on the candidate key is satisfied by #\d+/);
    assert.doesNotMatch(out.stdout,/waiver is not needed|Untested changes:/);
    const beforeRetry = (await read(r)).entries;
    const retry = await cli(r.cwd,[...args,'--full']); assert.equal(retry.code,0,retry.stderr);
    assert.equal(retry.stdout,`already recorded as #${beforeRetry.findLast(e => e.kind === 'waive')!.seq}\n`);
    assert.deepEqual((await read(r)).entries,beforeRetry);
  } finally {await r.cleanup();}
  const fresh = await fixture(true);
  try {
    const full = await cli(fresh.cwd,['waive','a','check:unit','--accept-risk',String(fresh.fail.seq),'--reason','accept merge flake','--as','owner:pi','--full']);
    assert.equal(full.code,0,full.stderr);
    assert.match(full.stdout,/^waived a\/check:unit #\d+: debt recorded on the merge key [a-f0-9]{12}/);
    assert.match(full.stdout,/Untested changes:|Untested obligations ΔO⁻:/);
  } finally {await fresh.cleanup();}
});

test('WF3: tool waiver has explicit debt, compact default and full option',async () => {
  for (const full of [false,true]) {
  const r = await fixture(true);
  try {
    const tools = new Map<string,ToolDefinition>(); owed({registerTool(t:ToolDefinition){tools.set(t.name,t);},registerCommand(){},on(){}} as unknown as ExtensionAPI);
    const tool = tools.get('owed_waive')!;
    const params = {cwd:r.cwd,node:'a',obligation:'check:unit',accept_risk:[r.fail.seq],reason:'accept tool risk'};
    const context = {cwd:r.cwd,hasUI:false} as Parameters<ToolDefinition['execute']>[4];
      const result = await tool.execute('wf3',{...params,full},undefined,undefined,context);
      assert.notEqual(result.isError,true,JSON.stringify(result));
      const text = result.content.flatMap(c => c.type === 'text' ? [c.text] : []).join('\n');
      assert.match(text,/^waived a\/check:unit #\d+: debt recorded/);
      assert.match(text,/in effect now: --accept-risk accepts/);
      assert.doesNotMatch(text,/waiver is not needed/);
      if (full) assert.match(text,/Untested obligations ΔO⁻:/); else assert.match(text,/Details: owed why a --full/);
  } finally {await r.cleanup();}
  }
});

async function planFixture() {
  const r = await repo(); await commitAt(r.cwd,{'closure.txt':'base',impl:'base'});
  const plan = {version:1,trunk:'main',lease:false,closure:['closure.txt'],invariants:[{id:'slow',run:'true',reads:['**'],timeout_s:1}],nodes:[{id:'a',writes:['impl'],checks:[{id:'unit',run:'true',reads:['**'],timeout_s:30}]}]};
  const file = join(r.root,'plan.json'); await writeFile(file,JSON.stringify(plan));
  await ops.init({cwd:r.cwd,as:owner,channel:'delegated',plan:JSON.stringify(plan),measure:false,path:file});
  await ops.planSet({cwd:r.cwd,as:parent,plan:JSON.stringify(plan),path:file});
  return {...r,file,plan};
}
test('WF4: plan/edit suppress unchanged admission checks, closure warns only after reads/closure change',async () => {
  const r = await planFixture();
  try {
    const out = await cli(r.cwd,['edit','a','--set','title=Only title','--note','unrelated edit']);
    assert.equal(out.code,0,out.stderr); assert.doesNotMatch(out.stdout,/cover .*repository|reads closure path/);
    const changed = await cli(r.cwd,['edit','a','--set','checks.unit.timeout_s=31','--note','change timeout','--as','owner:pi']);
    assert.equal(changed.code,0,changed.stderr); assert.match(changed.stdout,/reads of check:unit cover/);
    assert.doesNotMatch(changed.stdout,/reads closure path|reads of inv:slow cover/);
    const next = (await read(r)).state.plan;
    const warnings: string[] = [];
    await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',plan:JSON.stringify({...next,closure:['impl']}),note:'closure changed',shellWarnings:warnings});
    assert.ok(warnings.some(w => w.includes('reads closure path impl')),warnings.join('\n'));
    assert.ok(!warnings.some(w => /cover .*repository/.test(w)),warnings.join('\n'));
  } finally {await r.cleanup();}
});

test('WF4: near-timeout admission warns once per changed measured text, status retains full warning',async () => {
  const r = await planFixture();
  try {
    const ledger = await Ledger.open(r.cwd), {state} = await read(r);
    const append = (durationMs:number) => ledger.withLock(() => ledger.append([{kind:'obs',by:'executor:owed',subject:'trunk',obligation:'inv:slow',key:state.trunk.invKeys.slow!,commit:state.trunk.commit,verdict:'pass',exit:0,durationMs}]));
    await append(850);
    const first:string[] = []; await ops.planSet({cwd:r.cwd,as:parent,plan:JSON.stringify(r.plan),shellWarnings:first});
    assert.ok(first.some(w => w.includes('took 0.85s')),first.join('\n'));
    const second:string[] = []; await ops.planSet({cwd:r.cwd,as:parent,plan:JSON.stringify(r.plan),shellWarnings:second});
    assert.deepEqual(second,[]);
    assert.match(renderStatus(await ops.status(r)),/took 0.85s/);
    await append(900);
    const third:string[] = []; await ops.planSet({cwd:r.cwd,as:parent,plan:JSON.stringify(r.plan),shellWarnings:third});
    assert.ok(third.some(w => w.includes('took 0.9s')),third.join('\n'));
    assert.equal((await ops.reportCost(r)).obligations.find(o => o.id === 'inv:slow')?.runs,2);
  } finally {await r.cleanup();}
});

async function invariantFixture() {
  const r = await repo(); await commitAt(r.cwd,{impl:'base',unrelated:'base'});
  const plan = {version:1,trunk:'main',lease:false,closure:[],invariants:[{id:'one',run:`if grep -q candidate impl; then ${FAIL}; else ${PASS}; fi`,reads:['impl']},{id:'two',run:`if grep -q candidate impl; then ${FAIL}; else ${PASS}; fi`,reads:['impl']}],nodes:[{id:'a',writes:['impl'],checks:[],review:{count:0,min_rank:1}}]};
  await ops.init({cwd:r.cwd,as:owner,channel:'delegated',plan:JSON.stringify(plan)});
  const a = await ops.dispatch({cwd:r.cwd,as:parent,node:'a'}); await commitAt(a.worktree,{impl:'candidate'});
  await ops.submit({cwd:a.worktree,as:writer,node:'a',model:'test'}); await ops.attest({cwd:r.cwd,node:'a'});
  await assert.rejects(ops.merge({cwd:r.cwd,as:parent,node:'a'}),/invariant|unsatisfied/);
  const failures = (await read(r)).entries.filter((e): e is ObsEntry => e.kind === 'obs' && e.merging === 'a' && e.verdict === 'fail');
  return {...r,a,failures};
}
test('WF5: decide/resume name each failed invariant key and explain moved trunk/candidate without building git trees',async t => {
  const r = await invariantFixture();
  try {
    const exec = childProcess.spawn;
    // CLI output is checked first; the ops path is then run with Git forbidden through its child-process entry point.
    const queued = await cli(r.cwd,['resume','a','--remeasure','--note','try same tree']);
    assert.equal(queued.code,0,queued.stderr);
    for (const f of r.failures) assert.ok(queued.stdout.includes(`remeasure queued: ${f.obligation} on merge key ${f.key.slice(0,12)}`),queued.stdout);
    await commitAt(r.cwd,{unrelated:'trunk moved'}); await ops.adopt({cwd:r.cwd,as:owner,channel:'delegated',note:'fixture trunk moved'});
    const moved = await cli(r.cwd,['decide','a','--remeasure','--text','retry after trunk move']);
    assert.equal(moved.code,0,moved.stderr); assert.match(moved.stdout,/trunk moved to .* since #\d+: the next merge builds a new merge tree/);
    assert.match(moved.stdout,/remeasured there if its key is still .* otherwise measured as usual/);
    await commitAt(r.a.worktree,{impl:'candidate changed'}); await ops.submit({cwd:r.a.worktree,as:writer,node:'a',model:'test'});
    // No git call is needed for the diagnostic itself (a decide without defer/writes has no tree effects).
    t.mock.method(childProcess,'spawn',(...args:Parameters<typeof exec>) => { if (args[0] === 'git') assert.fail('decide must not invoke git'); return exec(...args); });
    const result = await ops.decide({cwd:r.cwd,as:parent,nodes:['a'],remeasure:true,text:'retry changed candidate',dsa:{describe:async rid => ({rid,state:'sealed',status:'ok'}),send:async () => ({outcome:'applied',spec_digest:'test'})}});
    assert.match(ops.decideText(result),/trunk moved to .*candidate changed/);
  } finally {t.mock.restoreAll();await r.cleanup();}
});

test('WF5: active merge-check block queues its attribution rerun, distinct from invariant remeasure',async () => {
  const r = await fixture(true,false);
  try {
    await writeFile(r.flag,'pass');
    const out = await cli(r.cwd,['resume','a','--remeasure','--note','attribute new block']);
    assert.equal(out.code,0,out.stderr);
    assert.ok(out.stdout.includes(`check:unit: the next merge reruns it on merge key ${r.fail.key.slice(0,12)} as an attribution rerun`),out.stdout);
    const d = await driver(r);
    assert.ok(driveDecide(d.state,d.state.plan,d.runs,d.opts).some(a => a.do === 'attest' && a.node === 'a'));
    const result = await ops.attest({cwd:r.cwd,node:'a'});
    assert.ok(result.observations.some(e => e.kind === 'obs' && e.attribution && e.key === r.fail.key && e.verdict === 'pass'));
    assert.equal((await read(r)).state.nodes.a!.blocks.find(b => b.seq === r.fail.seq)?.state,'flaky','rerun does not silently clear behavioral risk');
  } finally {await r.cleanup();}
});

test('WF5: node-check merge failure describes attribution rerun and absence of failed invariants',async () => {
  const r = await fixture(true);
  try {
    const out = await cli(r.cwd,['decide','a','--remeasure','--text','retry merge check']);
    assert.equal(out.code,0,out.stderr);
    assert.match(out.stdout,/remeasure queued: no merge-tree invariant of a failed on its current key/);
    assert.match(out.stdout,/check:unit: flaky block #.*already has an attribution pass; --remeasure measures invariants only/);
  } finally {await r.cleanup();}
});
