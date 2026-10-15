import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { Driver, DRIVE_PRINCIPAL } from '../src/drive-run.ts';
import { Dsa } from '../src/dsa.ts';
import { runId, runLabels } from '../src/reducer.ts';
import { entriesOf, observationsOf, reduce, invariantTrunkComparison, validateDraft } from '../src/reducer.ts';
import type { ObsEntry, Entry, Draft } from '../src/types.ts';
import { parsePlan } from '../src/plan.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const owner = { role:'owner', id:'pi' } as const, parent = { role:'parent', id:'main' } as const;
const counts = (pass: number, fail: number) => `echo 'owed-counts {"pass":${pass},"fail":${fail}}'`;
const tapFailure = (name: string, error: string, extra = '') => `not ok 1 - ${name}\n  ---\n  error: '${error}'\n${extra}  ...\n1..1\n# tests 1\n# pass 0\n# fail 1\n`;
async function fixture(options: {repeat?: object; failure?: string; trunk?: boolean; needles?: unknown; always?: boolean; parallel?: number; reads?: string[]} = {}) {
  const r = await repo(), counter = join(r.root,'counter');
  await r.put('README','base'); await r.commit();
  const failure = options.failure ?? tapFailure('browser fixture','browser fixture timed out after 20000ms');
  const run = `${options.trunk ? '' : `if [ ! -f src/value ]; then ${counts(1,0)}; exit 0; fi; `}n=$(cat '${counter}' 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > '${counter}'; if [ "$n" -le ${options.repeat ? 2 : options.always ? 99 : 1} ]; then printf '%s' '${failure.replace(/'/g,"'\\''")}'; exit 1; else ${counts(1,0)}; fi`;
  const plan = JSON.stringify({version:1,trunk:'main',closure:[],...(options.parallel ? {exec:{parallel:options.parallel}} : {}),invariants:[{id:'x',run,min_tests:1,reads:options.reads ?? ['src/**'],remeasure_on:options.needles ?? ['browser fixture timed out'],...(options.repeat ? {repeat:options.repeat} : {})}],nodes:[{id:'a',writes:['src/']}]});
  return {...r,counter,plan,init: () => ops.init({cwd:r.cwd,plan,as:owner,channel:'delegated'}), obs: async () => entriesOf((await ops.readState({cwd:r.cwd})).state).filter((e): e is ObsEntry => e.kind === 'obs' && e.obligation === 'inv:x'), candidate: async () => {
    await ops.init({cwd:r.cwd,plan,as:owner,channel:'delegated'});
    const d = await ops.dispatch({cwd:r.cwd,node:'a',as:parent});
    await commitAt(d.worktree,{'src/value':'new'});
    await ops.submit({cwd:d.worktree,node:'a',as:{role:'writer',id:'a#1'}});
    await ops.attest({cwd:r.cwd,node:'a'});
  }};
}

test('RO1: CLI refuses invalid remeasure_on entries and node-check placement, preserving the ledger', {timeout:90_000}, async () => {
  const r = await fixture();
  try {
    await r.init();
    const ledger = await Ledger.open(r.cwd), before = (await ledger.read()).length;
    for (const needles of [42,[''],['   '],[false]]) {
      const plan = JSON.parse(r.plan); plan.invariants[0].remeasure_on = needles;
      await writeFile(join(r.cwd,'bad.json'),JSON.stringify(plan));
      const out = await cli(r.cwd,['plan','bad.json','--as','parent:main']);
      assert.notEqual(out.code,0); assert.match(out.stderr,/remeasure_on/);
    }
    const plan = JSON.parse(r.plan); plan.nodes[0].checks = [{id:'c',run:'true',remeasure_on:['timeout']}];
    await writeFile(join(r.cwd,'bad.json'),JSON.stringify(plan));
    const out = await cli(r.cwd,['plan','bad.json','--as','parent:main']);
    assert.notEqual(out.code,0); assert.match(out.stderr,/only supported on invariants/);
    assert.equal((await ledger.read()).length,before);
  } finally { await r.cleanup(); }
});

test('RO2/RO3: merge auto remeasures on the same key once, quotes both votes, and retains owner conflict without repeat', {timeout:120_000}, async () => {
  const r = await fixture();
  try {
    await r.candidate();
    const out = await cli(r.cwd,['merge','a','--as','parent:main']);
    assert.notEqual(out.code,0);
    const obs = (await r.obs()).filter(e => e.merging === 'a');
    assert.deepEqual(obs.map(e => e.verdict),['fail','pass'],out.stderr + JSON.stringify(obs));
    assert.equal(obs[0]!.key,obs[1]!.key); assert.equal(obs[1]!.auto_remeasure,true);
    for (const e of obs) assert.match(out.stderr,new RegExp(`#${e.seq} ${e.verdict}`));
    assert.match(out.stderr,/conflicting pass and fail need the owner/);
    assert.match(out.stderr,/owed defer a x/);
    assert.doesNotMatch(out.stderr,/measure again: owed/);
    await cli(r.cwd,['merge','a','--as','parent:main']);
    assert.equal((await r.obs()).filter(e => e.merging === 'a').length,2);
    assert.equal((await ops.status({cwd:r.cwd})).nodes.a!.merged,undefined);
    assert.equal(observationsOf((await ops.readState({cwd:r.cwd})).state,'trunk','inv:x',obs[0]!.key).length,2);
    assert.equal((await ops.verify({cwd:r.cwd})).ok,true);
  } finally { await r.cleanup(); }
});

test('RO3: repeat uses the existing pool, never latest-pass-wins; a subsequent manual vote can meet the pool', {timeout:120_000}, async () => {
  const r = await fixture({repeat:{runs:2,need:1}});
  try {
    await r.candidate();
    await assert.rejects(ops.merge({cwd:r.cwd,node:'a',as:parent}));
    const obs = (await r.obs()).filter(e => e.merging === 'a');
    assert.deepEqual(obs.map(e => e.verdict),['fail','pass']);
    assert.deepEqual(obs.map(e => e.runs!.length),[2,1]);
    await assert.rejects(ops.merge({cwd:r.cwd,node:'a',as:parent}));
    assert.equal((await r.obs()).filter(e => e.merging === 'a').length,2);
    await ops.attest({cwd:r.cwd,node:'a',remeasure:true});
    const result = await ops.merge({cwd:r.cwd,node:'a',as:parent});
    assert.equal(result.entry.kind,'merge');
  } finally { await r.cleanup(); }
});

test('RO2: trunk genesis failure retries once (parallel executor), replay and repeated refresh do not retry', {timeout:90_000}, async () => {
  const r = await fixture({trunk:true,parallel:2});
  try {
    await r.init();
    const obs = await r.obs();
    assert.deepEqual(obs.map(e => e.verdict),['fail','pass']); assert.equal(obs[0]!.key,obs[1]!.key);
    assert.equal(obs[1]!.auto_remeasure,true);
    const out = await cli(r.cwd,['attest','--trunk']);
    assert.equal((await r.obs()).length,2,out.stderr);
    const s = (await ops.readState({cwd:r.cwd})).state;
    assert.equal(s.invariants[0]!.mark,'⊤');
    for (const e of obs) assert.match(s.invariants[0]!.detail,new RegExp(`#${e.seq} ${e.verdict}`));
    assert.equal((await ops.verify({cwd:r.cwd})).ok,true);
  } finally { await r.cleanup(); }
});

test('RO2: every parsed failure must match its own raw error, not test titles or passing tail; anonymous crash uses captured log', {timeout:180_000}, async () => {
  const failures = [
    tapFailure('browser fixture timed out','unrelated assertion'),
    tapFailure('browser fixture','unrelated assertion') + 'browser fixture timed out\n',
    tapFailure('browser fixture','browser fixture timed out').replace('1..1\n# tests 1\n# pass 0\n# fail 1\n','') + tapFailure('other fixture','assertion mismatch').replace('not ok 1','not ok 2').replace('1..1','1..2').replace('# tests 1','# tests 2').replace('# fail 1','# fail 2'),
  ];
  for (const failure of failures) {
    const r = await fixture({failure,always:true});
    try {
      await r.candidate(); await assert.rejects(ops.merge({cwd:r.cwd,node:'a',as:parent}));
      assert.equal((await r.obs()).filter(e => e.merging === 'a').length,1,failure);
      assert.equal((await readFile(r.counter,'utf8')).trim(),'1');
    } finally { await r.cleanup(); }
  }
  const r = await fixture({failure:'build aborted: browser fixture timed out\n',always:true});
  try {
    await r.candidate(); await assert.rejects(ops.merge({cwd:r.cwd,node:'a',as:parent}));
    assert.equal((await r.obs()).filter(e => e.merging === 'a').length,2);
    await assert.rejects(ops.merge({cwd:r.cwd,node:'a',as:parent}));
    assert.equal((await readFile(r.counter,'utf8')).trim(),'2');
  } finally { await r.cleanup(); }
});

test('RO2: expected/actual error quotes can match, and a changed key receives a fresh automatic retry', {timeout:120_000}, async () => {
  const r = await fixture({failure:tapFailure('fixture','assertion mismatch','  expected: browser fixture timed out\n  actual: complete\n')});
  try {
    await r.candidate(); await assert.rejects(ops.merge({cwd:r.cwd,node:'a',as:parent}));
    assert.equal((await r.obs()).filter(e => e.merging === 'a').length,2);
    await writeFile(r.counter,'0');
    const slot = (await ops.readState({cwd:r.cwd})).state.nodes.a!.slot!;
    await commitAt(slot.worktree,{'src/value':'changed'});
    await ops.submit({cwd:slot.worktree,node:'a',as:{role:'writer',id:'a#1'}});
    await ops.attest({cwd:r.cwd,node:'a'});
    await assert.rejects(ops.merge({cwd:r.cwd,node:'a',as:parent}));
    const obs = (await r.obs()).filter(e => e.merging === 'a');
    assert.equal(obs.length,4); assert.notEqual(obs[0]!.key,obs[2]!.key);
    assert.equal(obs[2]!.key,obs[3]!.key);
  } finally { await r.cleanup(); }
});


test('RO2/RO3: driver halts only after the automatic retry and quotes both votes; no retry on the next pass', {timeout:120_000}, async () => {
  const r = await fixture();
  try {
    await r.candidate();
    class SealedDsa extends Dsa { override async inspect(rid: string) { return {view:{rid,state:'sealed' as const,status:'ok'}}; } }
    const ledger = await Ledger.open(r.cwd), project = (await ledger.read())[0]!.hash.slice(0,12);
    await ops.launch({cwd:r.cwd,as:DRIVE_PRINCIPAL,node:'a',attempt:1,role:'writer',rid:runId(project,'a',1,'writer'),spec:'{}',labels:runLabels(project,'a',1,'writer')});
    const driver = new Driver({cwd:r.cwd,log:()=>{},handleSignals:false,session:null,dsa:new SealedDsa({bin:'/no-ro-dsa'}),max:1});
    await driver.pass(); assert.equal(await driver.drain(60_000),true); await driver.pass();
    const obs = (await r.obs()).filter(e => e.merging === 'a');
    assert.deepEqual(obs.map(e => e.verdict),['fail','pass']);
    const halt = (await ledger.read()).findLast(e => e.kind === 'halt');
    assert.ok(halt?.kind === 'halt'); assert.match(halt.reason,/conflicting pass and fail need the owner/);
    for (const e of obs) assert.match(halt.reason,new RegExp(`#${e.seq} ${e.verdict}`));
    assert.doesNotMatch(halt.reason,/measure again: owed/);
    await driver.pass(); await driver.drain(60_000);
    assert.equal((await r.obs()).filter(e => e.merging === 'a').length,2);
  } finally { await r.cleanup(); }
});


test('RO ruling #2097: unchanged trunk-key auto conflict blocks CLI merge and adopt until owner defer; status names both votes', {timeout:120_000}, async () => {
  const r = await fixture({trunk:true,reads:['README']});
  try {
    await r.candidate();
    const obs = await r.obs(), key = obs[0]!.key;
    assert.deepEqual(obs.map(e => e.verdict),['fail','pass']);
    const status = await ops.status({cwd:r.cwd});
    assert.ok(status.pending.owner!.some(i => i.obligation === 'inv:x' && i.mark === '⊤'));
    const shown = await cli(r.cwd,['status']);
    assert.match(shown.stdout,/Needs you/);
    for (const e of obs) assert.match(shown.stdout,new RegExp(`#${e.seq} ${e.verdict}`));
    const out = await cli(r.cwd,['merge','a','--as','parent:main']);
    assert.notEqual(out.code,0); assert.match(out.stderr,/owner conflict/);
    for (const e of obs) assert.match(out.stderr,new RegExp(`#${e.seq} ${e.verdict}`));
    assert.equal((await ops.status({cwd:r.cwd})).nodes.a!.merged,undefined);
    const s = (await ops.readState({cwd:r.cwd})).state;
    assert.equal(s.trunk.invKeys.x,key);
    const comparison = invariantTrunkComparison(s,'a',s.plan.invariants[0]!,key,s.trunk.commit);
    assert.equal(comparison.trunk?.verdict,'fail'); assert.equal(comparison.merge?.verdict,'fail');
    await commitAt(r.cwd,{'other':'outside owed'});
    await assert.rejects(ops.adopt({cwd:r.cwd,as:owner,channel:'delegated',note:'unchanged invariant'}),/owner conflict/);
  } finally { await r.cleanup(); }
  const deferred = await fixture({trunk:true,reads:['README']});
  try {
    await deferred.candidate();
    const key = (await deferred.obs())[0]!.key;
    await ops.defer({cwd:deferred.cwd,as:owner,channel:'delegated',node:'a',items:[{id:'x',key}],reason:'explicit owner acceptance of invariant debt for this node'});
    assert.equal((await ops.merge({cwd:deferred.cwd,node:'a',as:parent})).entry.kind,'merge');
  } finally { await deferred.cleanup(); }
});

test('RO ruling #2097: reduce refuses unproven, nonmatching, non-adjacent and duplicate auto_remeasure receipts', {timeout:120_000}, async () => {
  const r = await fixture({trunk:true});
  try {
    await r.init();
    const ledger = await Ledger.open(r.cwd), entries = await ledger.read(), [first,retry] = await r.obs();
    const lookup = () => parsePlan(r.plan);
    const throughFirst = entries.filter(e => e.seq <= first!.seq);
    const replay = (prefix: Entry[], changes: Partial<ObsEntry> = {}) => reduce([...prefix,{...retry!,...changes,seq:(prefix.at(-1)?.seq ?? -1)+1} as Entry],lookup);
    assert.throws(() => replay(entries.filter(e => e.seq < first!.seq)),/preceding same-key failure/);
    assert.throws(() => replay([...throughFirst,{...first!,verdict:'pass',remeasure_match:undefined,seq:first!.seq+1} as Entry]),/preceding same-key failure/);
    assert.throws(() => replay(throughFirst.map(e => e.seq === first!.seq ? {...first!,remeasure_match:['unrelated failure']} as Entry : e)),/remeasure_match/);
    assert.throws(() => replay(throughFirst.map(e => e.seq === first!.seq ? {...first!,remeasure_match:undefined} as Entry : e)),/preceding same-key failure/);
    assert.throws(() => replay(entries),/already consumed on this key/);
    assert.equal(reduce(entries,lookup).invariants[0]!.mark,'⊤');
    assert.equal((await ops.verify({cwd:r.cwd})).ok,true);
  } finally { await r.cleanup(); }
});

test('RO ruling #2165: full raw error matches past character 180 and multiline text without display truncation', {timeout:120_000}, async () => {
  const error = 'x'.repeat(190) + ' browser fixture timed out';
  const r = await fixture({failure:tapFailure('long fixture',error)});
  try {
    await r.candidate();
    await assert.rejects(ops.merge({cwd:r.cwd,node:'a',as:parent}));
    const obs = (await r.obs()).filter(e => e.merging === 'a');
    assert.deepEqual(obs.map(e => e.verdict),['fail','pass']);
    assert.deepEqual(obs[0]!.remeasure_match,['browser fixture timed out']);
    assert.equal((await ops.verify({cwd:r.cwd})).ok,true);
  } finally { await r.cleanup(); }
  const multiline = await fixture({failure:tapFailure('multiline fixture','placeholder').replace("error: 'placeholder'","error: |\n    unrelated first line\n    browser fixture timed out")});
  try {
    await multiline.candidate();
    await assert.rejects(ops.merge({cwd:multiline.cwd,node:'a',as:parent}));
    assert.equal((await multiline.obs()).filter(e => e.merging === 'a').length,2);
  } finally { await multiline.cleanup(); }
});


test('RO ruling #2165: node a defer does not resolve the trunk conflict for unrelated unchanged-key adopt', {timeout:120_000}, async () => {
  const r = await fixture({trunk:true,reads:['README']});
  try {
    await r.candidate();
    const key = (await r.obs())[0]!.key;
    await ops.defer({cwd:r.cwd,as:owner,channel:'delegated',node:'a',items:[{id:'x',key}],reason:'node a only'});
    const state = (await ops.readState({cwd:r.cwd})).state;
    assert.equal(state.invariants[0]!.mark,'⊤');
    const before = (await (await Ledger.open(r.cwd)).read()).filter(e => e.kind === 'adopt').length;
    await commitAt(r.cwd,{'other':'unrelated trunk change'});
    await assert.rejects(ops.adopt({cwd:r.cwd,as:owner,channel:'delegated',note:'no trunk invariant resolution'}),/owner conflict/);
    assert.equal((await (await Ledger.open(r.cwd)).read()).filter(e => e.kind === 'adopt').length,before);
  } finally { await r.cleanup(); }
});

test('RO ruling #2165: anonymous needle after char 220 and earlier than last 20 lines; named literal semicolon is unnormalized', {timeout:180_000}, async () => {
  for (const failure of ['x'.repeat(240) + ' browser fixture timed out\n' + 'noise\n'.repeat(25),tapFailure('raw error','connection; refused')]) {
    const needle = failure.includes('connection; refused') ? 'connection; refused' : 'browser fixture timed out';
    const r = await fixture({failure,needles:[needle]});
    try {
      await r.candidate(); await assert.rejects(ops.merge({cwd:r.cwd,node:'a',as:parent}));
      const obs = (await r.obs()).filter(e => e.merging === 'a');
      assert.deepEqual(obs.map(e => e.verdict),['fail','pass']);
      assert.deepEqual(obs[0]!.remeasure_match,[needle]);
      assert.equal((await ops.verify({cwd:r.cwd})).ok,true);
    } finally { await r.cleanup(); }
  }
});

test('RO ruling #2165: validateDraft bounds remeasure_match to unique configured string literals; field-free old ledger replays', {timeout:120_000}, async () => {
  const r = await fixture({trunk:true,needles:['browser fixture timed out','another literal']});
  try {
    await r.init();
    const entries = await (await Ledger.open(r.cwd)).read(), first = (await r.obs())[0]!;
    const lookup = () => parsePlan(r.plan), before = reduce(entries.filter(e => e.seq < first.seq),lookup);
    for (const value of [['unconfigured'],[42],[null],['browser fixture timed out','browser fixture timed out'],['browser fixture timed out','another literal','third'],['x'.repeat(2*1024*1024)],'x'.repeat(2*1024*1024),[],{}]) {
      assert.ok(validateDraft(before,{...first,remeasure_match:value} as unknown as Draft).some(e => e.includes('remeasure_match')));
    }
    assert.deepEqual(validateDraft(before,{...first,remeasure_match:['browser fixture timed out','another literal']} as Draft),[]);
    const legacy = entries.filter(e => e.seq <= first.seq).map(e => e.kind === 'obs' ? {...e,remeasure_match:undefined} : e);
    assert.equal(reduce(legacy,lookup).invariants[0]!.mark,'✘');
  } finally { await r.cleanup(); }
});
