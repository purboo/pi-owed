import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { Driver, DRIVE_PRINCIPAL } from '../src/drive-run.ts';
import { Dsa } from '../src/dsa.ts';
import { runId, runLabels } from '../src/reducer.ts';
import { entriesOf, observationsOf } from '../src/reducer.ts';
import type { ObsEntry } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const owner = { role:'owner', id:'pi' } as const, parent = { role:'parent', id:'main' } as const;
const counts = (pass: number, fail: number) => `echo 'owed-counts {"pass":${pass},"fail":${fail}}'`;
const tapFailure = (name: string, error: string, extra = '') => `not ok 1 - ${name}\n  ---\n  error: '${error}'\n${extra}  ...\n1..1\n# tests 1\n# pass 0\n# fail 1\n`;
async function fixture(options: {repeat?: object; failure?: string; trunk?: boolean; needles?: unknown; always?: boolean; parallel?: number} = {}) {
  const r = await repo(), counter = join(r.root,'counter');
  await r.put('README','base'); await r.commit();
  const failure = options.failure ?? tapFailure('browser fixture','browser fixture timed out after 20000ms');
  const run = `${options.trunk ? '' : `if [ ! -f src/value ]; then ${counts(1,0)}; exit 0; fi; `}n=$(cat '${counter}' 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > '${counter}'; if [ "$n" -le ${options.repeat ? 2 : options.always ? 99 : 1} ]; then printf '%s' '${failure.replace(/'/g,"'\\''")}'; exit 1; else ${counts(1,0)}; fi`;
  const plan = JSON.stringify({version:1,trunk:'main',closure:[],...(options.parallel ? {exec:{parallel:options.parallel}} : {}),invariants:[{id:'x',run,min_tests:1,reads:['src/**'],remeasure_on:options.needles ?? ['browser fixture timed out'],...(options.repeat ? {repeat:options.repeat} : {})}],nodes:[{id:'a',writes:['src/']}]});
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

test('RO2: every parsed failure must match its own error, not test titles or passing tail; anonymous crash uses last 20 lines', {timeout:180_000}, async () => {
  const failures = [
    tapFailure('browser fixture timed out','unrelated assertion'),
    tapFailure('browser fixture','unrelated assertion') + 'browser fixture timed out\n',
    tapFailure('browser fixture','browser fixture timed out').replace('1..1\n# tests 1\n# pass 0\n# fail 1\n','') + tapFailure('other fixture','assertion mismatch').replace('not ok 1','not ok 2').replace('1..1','1..2').replace('# tests 1','# tests 2').replace('# fail 1','# fail 2'),
    Array.from({length:21},(_,i) => i === 0 ? 'browser fixture timed out' : 'noise').join('\n') + '\n',
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
