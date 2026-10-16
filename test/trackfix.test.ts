import test from 'node:test';
import assert from 'node:assert/strict';
import { access, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import * as git from '../src/git.ts';
import * as reducer from '../src/reducer.ts';
import * as views from '../src/views.ts';
import { Ledger } from '../src/ledger.ts';
import { cli, commitAt } from './helpers/surface.ts';
import { repo } from './helpers/repo.ts';
import { decide, repairFollowUp, writerLaunch } from '../src/drive.ts';
import { classifyLine, Follower } from '../src/drive-bg.ts';
import { clockTime } from '../src/clock.ts';
import owed from '../src/extension.ts';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { CheckSpec, Draft, ObsEntry, WaiveEntry } from '../src/types.ts';

const owner = { role:'owner', id:'pi' } as const, parent = { role:'parent', id:'test' } as const;
const now = Date.parse('2026-10-16T12:00:00Z');
async function fixture(extra: Partial<CheckSpec> = {}) {
  const r = await repo();
  try {
    const mode = join(r.root,'mode'), counter = join(r.root,'counter');
    await writeFile(mode,'fail'); await writeFile(counter,'0');
    const script = `n=$(< '${counter}'); echo $((n+1)) > '${counter}'
m=$(< '${mode}')
if test "$m" = stop && test "$n" -ge 1; then m=fail; fi
if test "$m" = pass || test "$m" = stop || { test "$m" = candidate-pass && grep -q candidate impl; }; then
  echo 'owed-counts {"pass":1,"fail":0}'
else echo 'owed-counts {"pass":0,"fail":1,"failed":["shared race"]}'; exit 1; fi\n`;
    const trunk = await commitAt(r.cwd,{impl:'base','check.sh':script});
    const check = { id:'runtime', run:'bash check.sh', reads:['impl','check.sh'], min_tests:1, ...extra };
    const plan = { version:1, trunk:'main', lease:false, closure:extra.mutants ?? [], invariants:[], drive:{min_free_mb:0}, nodes:[
      {id:'a',writes:['impl','new.cjs'],checks:[check],review:{count:0,min_rank:1}},
      {id:'fix',title:'Repair shared race',writes:['fixed'],checks:[],review:{count:0,min_rank:1}},
      {id:'fix2',writes:['other'],checks:[],review:{count:0,min_rank:1}}
    ] };
    await ops.init({cwd:r.cwd,plan:JSON.stringify(plan),as:owner,channel:'delegated'});
    const slot = await ops.dispatch({...r,node:'a',as:parent});
    const candidate = await commitAt(slot.worktree,{impl:'candidate',...(extra.tests ? {'new.cjs':'// fixture new test\n'} : {})});
    await ops.submit({cwd:slot.worktree,node:'a',as:{role:'writer',id:'a#1'}});
    const ledger = await Ledger.open(r.cwd);
    const state = async () => (await ops.readState(r)).state;
    const obs = async () => (await ledger.read()).filter((e):e is ObsEntry => e.kind === 'obs');
    const setMode = async (text:string) => { await writeFile(mode,text); await writeFile(counter,'0'); };
    const measure = () => ops.attest({...r,node:'a'});
    const probe = (args:string[] = []) => cli(r.cwd,['attest','a','--probe-trunk',...args]);
    const waive = (fix = 'fix', risk?:number) => cli(r.cwd,['waive','a','check:runtime','--tracked-by',fix,'--reason','trunk race tracked',...(risk !== undefined ? ['--accept-risk',String(risk)] : [])]);
    const mergeFix = async () => {
      const f = await ops.dispatch({...r,node:'fix',as:parent});
      await commitAt(f.worktree,{fixed:'repair'});
      await ops.submit({cwd:f.worktree,node:'fix',as:{role:'writer',id:'fix#1'}});
      await ops.attest({...r,node:'fix'});
      return ops.merge({...r,node:'fix',as:parent});
    };
    return {...r,mode,counter,plan,check,trunk,candidate,slot,ledger,state,obs,setMode,measure,probe,waive,mergeFix};
  } catch(e) { await r.cleanup(); throw e; }
}

test('TF1: explicit selection passes, repeats an existing probe, and default selection requires a block', async () => {
  const r = await fixture();
  try {
    await r.setMode('pass');
    const selected = await r.probe(['--check','runtime','--runs','2']);
    assert.equal(selected.code,0,selected.stderr);
    assert.match(selected.stdout,/trunk probe check:runtime on [a-f0-9]{12}: 2 run\(s\), all passed \(#\d+, #\d+\)/);
    assert.match(selected.stdout,/Details: owed why a --full/);
    assert.equal((await r.probe(['--check','runtime'])).code,0);
    assert.equal((await r.obs()).filter(e => e.probe === 'trunk').length,3);
    const none = await r.probe(); assert.equal(none.code,2);
    assert.match(none.stderr,/no check of a has an active or flaky exec block; name one with --check/);
    await r.setMode('fail'); await r.measure();
    const inferred = await r.probe(); assert.equal(inferred.code,1); assert.match(inferred.stdout,/run 1 failed: shared race/);
  } finally { await r.cleanup(); }
});

test('TF1: --runs is sequential, stops at the first non-pass, and probes change no obligation or block state', async () => {
  const r = await fixture();
  try {
    await r.measure(); const before = await r.state();
    await r.setMode('stop'); const out = await r.probe(['--runs','5']); assert.equal(out.code,1,out.stderr);
    assert.match(out.stdout,/run 2 failed: shared race \(#\d+, #\d+\)/);
    assert.equal(await readFile(r.counter,'utf8'),'2\n');
    const after = await r.state(), probes = (await r.obs()).filter(e => e.probe === 'trunk');
    assert.deepEqual(probes.map(e => e.verdict),['pass','fail']);
    for (const e of probes) { assert.equal(e.commit,r.trunk); assert.equal(e.base,r.trunk); assert.equal(e.key,await git.trunkCheckKey(r.cwd,after.plan,after.plan.nodes[0]!.checks[0]!,r.trunk,reducer.stateQuarantine(after))); }
    assert.deepEqual(after.nodes,before.nodes); assert.deepEqual(after.invariants,before.invariants); assert.deepEqual(after.trunk,before.trunk);
    assert.equal((await ops.verify(r)).ok,true);
    assert.deepEqual(reducer.attestJobs(after,'a'),reducer.attestJobs(before,'a'));
  } finally { await r.cleanup(); }
});

test('TF1: usage validation records nothing for invalid runs, check, combinations, or a missing candidate', async () => {
  const r = await fixture();
  try {
    await r.setMode('pass'); assert.equal((await r.probe(['--check','runtime'])).code,0);
    const before = await r.ledger.read();
    for (const args of [['--check','missing'],['--check','runtime','--runs','0'],['--check','runtime','--runs','11'],['--check','runtime','--runs','1.5'],['--rerun'],['--remeasure'],['--trunk']]) assert.equal((await r.probe(args)).code,2,args.join(' '));
    assert.equal((await cli(r.cwd,['attest','a','--runs','2'])).code,2);
    assert.deepEqual(await r.ledger.read(),before);
    await ops.abandon({...r,node:'a',as:parent,reason:'close fixture'});
    const closed = await r.ledger.read(); const out = await r.probe(['--check','runtime']); assert.equal(out.code,2); assert.match(out.stderr,/open slot with a candidate/);
    assert.deepEqual(await r.ledger.read(),closed);
  } finally { await r.cleanup(); }
});

test('TF1: new candidate tests and red/mutants checks are refused without measurements', async () => {
  for (const extra of [{tests:['new.cjs']},{red:true,tests:['check.sh']},{mutants:['mutant.patch']}]) {
    const r = await fixture(extra);
    try {
      const before = await r.ledger.read(), out = await r.probe(['--check','runtime']);
      assert.equal(out.code,2,out.stderr);
      assert.match(out.stderr,extra.red || extra.mutants ? /trunk probes refuse red\/mutants checks/ : /check:runtime tests are new in the candidate; trunk cannot run them/);
      assert.deepEqual(await r.ledger.read(),before);
    } finally { await r.cleanup(); }
  }
});

test('TF2: a probe after an active or flaky failure adds shared text to needs, wake, why and repairs without clearing risk', async () => {
  const r = await fixture();
  try {
    await r.measure(); const failure = (await r.obs()).find(e => e.obligation === 'check:runtime')!;
    assert.equal((await r.probe()).code,1);
    let s = await r.state(), probe = (await r.obs()).findLast(e => e.probe === 'trunk')!;
    assert.ok(probe.seq > failure.seq); assert.ok(reducer.sharedFailure(s,failure,'a'));
    assert.match(views.ownerCommands(s,'a').join('\n'),/--tracked-by fix/);
    const expected = new RegExp(`check:runtime block #${failure.seq} also fails on trunk ${r.trunk.slice(0,12)} without a \\(probe #${probe.seq}: shared race\\)`);
    for (const text of [views.renderStatus(await ops.status(r),{full:true}),views.renderWhy(await ops.why({...r,node:'a'})),repairFollowUp(s,'a').message]) {
      assert.match(text,expected); assert.match(text,/--tracked-by fix/);
    }
    assert.match(repairFollowUp(s,'a').message,/ask the parent instead of changing code outside your writes/);
    await r.setMode('pass'); await r.measure(); s = await r.state();
    assert.equal(s.nodes.a!.blocks.find(b => b.seq === failure.seq)!.state,'flaky');
    const launch = writerLaunch(s,'a',reducer.projectId(s));
    await ops.launch({...r,as:parent,node:'a',attempt:1,role:'writer',rid:launch.rid,spec:launch.spec,labels:launch.labels,rulings:launch.rulings}); s = await r.state();
    const actions = decide(s,s.plan,new Map([[launch.rid,{rid:launch.rid,state:'sealed' as const,status:'ok'}]]),{max:1,repairs:2,project:'test',root:r.cwd,applied:new Set(),rejected:new Map(),now});
    const need = actions.find(a => a.do === 'notify' && a.node === 'a'); assert.ok(need?.do === 'notify');
    assert.match(need.text,expected);
    assert.match(classifyLine(JSON.stringify(need)).text,expected);
    assert.match(views.renderStatus(await ops.status(r)),expected);
    assert.equal(s.nodes.a!.accepted,false);
    await r.setMode('pass'); assert.equal((await r.probe(['--check','runtime'])).code,0);
    // FS keeps failure history; a pass itself adds no shared evidence and never clears this flaky block.
    assert.equal((await r.state()).nodes.a!.blocks.find(b => b.seq === failure.seq)!.state,'flaky');
  } finally { await r.cleanup(); }
});

test('TF2/WF1 #3052: shared trunk diagnosis precedes and retains the same-key flaky pair', async () => {
  const r = await fixture();
  try {
    await r.measure(); const fail = (await r.obs()).find(e => e.obligation === 'check:runtime')!;
    assert.equal((await r.probe()).code,1);
    await r.setMode('pass'); await r.measure();
    const launch = writerLaunch(await r.state(),'a',reducer.projectId(await r.state()));
    await ops.launch({...r,as:parent,node:'a',attempt:1,role:'writer',rid:launch.rid,spec:launch.spec,labels:launch.labels,rulings:launch.rulings});
    const s = await r.state(), block = s.nodes.a!.blocks.find(b => b.seq === fail.seq)!;
    assert.equal(block.state,'flaky'); assert.ok(reducer.sharedFailure(s,fail,'a'));
    const pass = reducer.flakyPass(s,block)!;
    const shared = `check:runtime block #${fail.seq} also fails on trunk`, flaky = `flaky block #${fail.seq} on check:runtime`;
    const pair = `failed #${fail.seq} (shared race) → passed #${pass.seq} on the same key`;
    const check = (text:string) => {
      assert.ok(text.includes(shared),text); assert.ok(text.includes(flaky),text); assert.ok(text.includes(pair),text);
      assert.ok(text.indexOf(shared) < text.indexOf(flaky),text);
    };
    const card = await ops.why({...r,node:'a'}), status = await ops.status(r);
    check(card.blocks.find(b => b.seq === fail.seq)!.clear);
    check(status.pending.owner!.find(i => i.obligation === 'check:runtime')!.hint!);
    check(status.summary!.needs.find(n => n.node === 'a')!.reason);
    check(repairFollowUp(s,'a').message);
    const log = join(r.root,'combined-wake.jsonl');
    const actions = decide(s,s.plan,new Map([[launch.rid,{rid:launch.rid,state:'sealed' as const,status:'ok'}]]),{max:1,repairs:2,project:'test',root:r.cwd,applied:new Set(),rejected:new Map(),now});
    const need = actions.find(a => a.do === 'notify' && a.node === 'a'); assert.ok(need?.do === 'notify');
    check(need.text);
    await writeFile(log,JSON.stringify(need)+'\n');
    const follower = new Follower({log,repo:r.cwd,pid:process.pid,from:0,deliver(){}});
    try { check((await follower.step())!); } finally { follower.stop(); }
    const after = await r.state();
    assert.deepEqual(after.nodes,s.nodes,'diagnostic rendering never changes blocks, obligations, keys or acceptance');
  } finally { await r.cleanup(); }
});

test('TF2/WF1 #3065: Follower keeps trunk-red guidance before the flaky pair despite an independent review block', async () => {
  const r = await repo();
  try {
    const flag = join(r.root,'pass'); await commitAt(r.cwd,{impl:'base'});
    const run = `if [ -e src/b ] && [ ! -e '${flag}' ]; then echo 'owed-counts {"pass":0,"fail":1,"failed":["case one"]}'; exit 1; else echo '# tests 1'; echo '# pass 1'; echo '# fail 0'; fi`;
    const plan = {version:1,trunk:'main',lease:false,closure:[],invariants:[],nodes:[
      {id:'a',writes:['impl'],checks:[{id:'unit',run,reads:['impl','src/'],min_tests:1}],review:{count:0,min_rank:1}},
      {id:'b',writes:['src/b'],checks:[],review:{count:0,min_rank:1}}
    ]};
    await ops.init({cwd:r.cwd,as:owner,channel:'delegated',plan:JSON.stringify(plan)});
    const a = await ops.dispatch({...r,as:parent,node:'a'});
    await commitAt(a.worktree,{impl:'old candidate'});
    await ops.submit({cwd:a.worktree,as:{role:'writer',id:'a#1'},node:'a'}); await ops.attest({...r,node:'a'});
    const b = await ops.dispatch({...r,as:parent,node:'b'});
    await commitAt(b.worktree,{'src/b':'trunk addition'});
    await ops.submit({cwd:b.worktree,as:{role:'writer',id:'b#1'},node:'b'}); await ops.attest({...r,node:'b'});
    await ops.merge({...r,as:parent,node:'b'}); await assert.rejects(ops.merge({...r,as:parent,node:'a'}));
    const before = (await ops.readState(r)).state;
    const fail = reducer.entriesOf(before).find((e):e is ObsEntry => e.kind === 'obs' && e.subject === 'a' && e.obligation === 'check:unit' && e.verdict === 'fail')!;
    assert.ok(reducer.trunkRedOf(before,fail.seq));
    await writeFile(flag,'pass'); await ops.attest({...r,node:'a'});
    await ops.review({...r,node:'a',verdict:'block',rank:2,note:'independent review risk prevents all-trunk-red parking',as:{role:'reviewer',id:'isolated'}});
    const launchState = (await ops.readState(r)).state, launch = writerLaunch(launchState,'a',reducer.projectId(launchState));
    await ops.launch({...r,as:parent,node:'a',attempt:1,role:'writer',rid:launch.rid,spec:launch.spec,labels:launch.labels,rulings:launch.rulings});
    const s = (await ops.readState(r)).state, block = s.nodes.a!.blocks.find(b => b.seq === fail.seq)!, pass = reducer.flakyPass(s,block)!;
    assert.equal(block.state,'flaky'); assert.ok(pass); assert.equal(reducer.trunkParked(s,'a').length,0);
    const actions = decide(s,s.plan,new Map([[launch.rid,{rid:launch.rid,state:'sealed' as const,status:'ok'}]]),{max:2,repairs:2,project:reducer.projectId(s),root:r.cwd,applied:new Set(),rejected:new Map(),now});
    const need = actions.find(a => a.do === 'notify' && a.node === 'a'); assert.ok(need?.do === 'notify');
    const pair = `failed #${fail.seq} (case one) → passed #${pass.seq} on the same key`;
    assert.match(need.text,/trunk-red:/); assert.ok(need.text.includes(pair));
    const log = join(r.root,'trunk-red-wake.jsonl'); await writeFile(log,JSON.stringify(need)+'\n');
    const follower = new Follower({log,repo:r.cwd,pid:process.pid,from:0,deliver(){}});
    let wake:string | undefined; try { wake = await follower.step(); } finally { follower.stop(); }
    const lines = wake!.split('\n');
    const diagnosis = need.text.match(/trunk-red: [^;]+/)![0], guidance = need.text.match(/parent: fix trunk[^;]+/)![0];
    const alternative = `or owed waive a check:unit --accept-risk ${fail.seq}`;
    assert.ok(need.text.includes(`; ${alternative}`));
    assert.equal(lines[0],`Needs you: a — ${diagnosis}; ${guidance}; ${alternative}`,'trunk-red diagnosis and parent fix/waive guidance lead the wake without receipt noise');
    assert.ok(lines[1]!.startsWith(`Needs you: a — flaky block #${fail.seq} on check:unit`),wake);
    assert.ok(lines[1]!.includes(pair),wake);
    assert.match(lines[1]!,/a pass does not erase a failure/);
    assert.deepEqual((await ops.readState(r)).state.nodes,s.nodes,'wake presentation does not change gate state');
    assert.equal((await ops.verify(r)).ok,true);
  } finally { await r.cleanup(); }
});

test('TF1/QS4: explicit trunk probes retain shared quarantine recovery without changing candidate acceptance', async () => {
  const r = await repo();
  try {
    await commitAt(r.cwd,{impl:'base','test/probe.cjs':`const {test}=require('node:test');
test('recovered',()=>{}); test('normal',()=>{}); test('still skipped',{skip:true},()=>{});`});
    const plan = {version:1,trunk:'main',lease:false,closure:[],invariants:[],quarantine_sets:{shared:[{test:'recovered',fix:'fix'},{test:'still skipped',fix:'fix'}]},nodes:[
      {id:'a',writes:['impl'],checks:[{id:'unit',run:'node --test --test-reporter=tap test/probe.cjs',reads:['impl','test/'],min_tests:1,quarantine_set:'shared'}],review:{count:0,min_rank:1}},
      {id:'fix',writes:['fixed'],checks:[],review:{count:0,min_rank:1}}
    ]};
    await ops.init({cwd:r.cwd,as:owner,channel:'delegated',plan:JSON.stringify(plan)});
    const slot = await ops.dispatch({...r,as:parent,node:'a'});
    await commitAt(slot.worktree,{impl:'candidate'});
    await ops.submit({cwd:slot.worktree,as:{role:'writer',id:'a#1'},node:'a'});
    await ops.attest({...r,node:'a'});
    const before = (await ops.readState(r)).state;
    const candidateObs = reducer.entriesOf(before).findLast((e):e is ObsEntry => e.kind === 'obs' && e.subject === 'a' && e.obligation === 'check:unit')!;
    assert.equal(candidateObs.quarantine_passed,undefined);
    const result = await ops.attestProbeTrunk({...r,node:'a',check:'unit'});
    const probe = result.checks[0]!.observations[0] as ObsEntry;
    assert.equal(probe.probe,'trunk'); assert.equal(probe.verdict,'pass');
    assert.deepEqual(probe.quarantine_passed,['recovered']); assert.equal(probe.counts?.pass,2); assert.equal(probe.counts?.skip,1);
    const after = (await ops.readState(r)).state;
    assert.equal(after.nodes.a!.accepted,before.nodes.a!.accepted);
    assert.deepEqual(after.nodes.a!.candidate,before.nodes.a!.candidate);
    const debt = views.quarantineDebt(after);
    assert.equal(debt.find(d => d.test === 'recovered')!.passed!.seq,probe.seq);
    assert.equal(debt.find(d => d.test === 'still skipped')!.passed,undefined);
    assert.match(views.renderBrief(await ops.brief(r)),/quarantined recovered passed on trunk/);
    assert.equal((await ops.verify(r)).ok,true);
  } finally { await r.cleanup(); }
});

test('TF2: passing probes add no shared hint, absent fix candidates are named as missing', async () => {
  const r = await fixture();
  try {
    await r.measure(); await r.setMode('pass'); assert.equal((await r.probe()).code,0);
    assert.doesNotMatch(views.renderWhy(await ops.why({...r,node:'a'})),/also fails on trunk/);
    await ops.planSet({...r,as:owner,channel:'delegated',note:'remove tracker fixture',plan:JSON.stringify({...r.plan,nodes:r.plan.nodes.filter(n => n.id !== 'fix')})});
    await r.setMode('fail'); assert.equal((await r.probe()).code,1);
    assert.match(views.renderWhy(await ops.why({...r,node:'a'})),/--tracked-by <fix>.*\(add a fix node first\)/);
  } finally { await r.cleanup(); }
});

test('TF2: check definition and signature mismatches refuse sharing; invariant after-O evidence stays ineligible', async () => {
  const r = await fixture();
  try {
    await r.measure(); assert.equal((await r.probe()).code,1);
    const failure = (await r.obs()).find(e => e.obligation === 'check:runtime')!;
    const s = await r.state(); assert.ok(reducer.sharedFailure(s,failure,'a'));
    assert.equal(reducer.sharedFailure(s,{...failure,signatures:{'shared race':'different'}},'a'),undefined);
    const plan = {...r.plan,invariants:[{id:'unit',run:r.check.run,reads:r.check.reads,min_tests:1}],nodes:r.plan.nodes.map(n => n.id === 'a' ? {...n,checks:[{...r.check,timeout_s:12}]} : n)};
    await ops.planSet({...r,as:owner,channel:'delegated',note:'change fixture definition',plan:JSON.stringify(plan)});
    assert.equal((await r.probe(['--check','runtime'])).code,1);
    await ops.attestTrunk(r);
    const observations = await r.obs(), newer = observations.findLast(e => e.probe === 'trunk')!;
    const onlyNew = observations.filter(e => e.seq !== failure.seq && e.probe === 'trunk' && e.seq !== newer.seq);
    assert.ok(onlyNew.length); // The historical pair stays shared; only a changed-definition probe cannot be borrowed.
    const current = await r.state();
    assert.equal(reducer.sharedFailure(current,{...failure,seq:newer.seq,key:newer.key},'a'),undefined);
    const inv = observations.find(e => e.subject === 'trunk' && e.obligation === 'inv:unit')!;
    const {seq,ts,prev,hash,...draft} = inv;
    await r.ledger.withLock(() => r.ledger.append([{...draft,merging:'a'}]));
    const invFailure = (await r.obs()).findLast(e => e.merging === 'a')!;
    await r.ledger.withLock(() => r.ledger.append([{...draft,merging:undefined}]));
    const currentInv = await r.state(), shared = reducer.sharedFailure(currentInv,invFailure,'a');
    assert.ok(shared); assert.ok(shared.trunk.every(e => e.seq < invFailure.seq));
    assert.equal(reducer.sharedFailure(currentInv,{...invFailure,seq:inv.seq},'a'),undefined,'after-O invariant evidence cannot classify an earlier failure');
  } finally { await r.cleanup(); }
});

test('TF3: tracked-by validation refuses missing, self and merged trackers with nothing recorded', async () => {
  const r = await fixture();
  try {
    await r.mergeFix(); const before = await r.ledger.read();
    for (const fix of ['missing','a','fix']) {
      const out = await r.waive(fix); assert.equal(out.code,2,out.stderr); assert.match(out.stderr,/tracked_by must name an unmerged node of the current plan other than the waived node/);
      assert.deepEqual(await r.ledger.read(),before);
    }
    assert.equal((await r.waive('fix2')).code,0);
  } finally { await r.cleanup(); }
});

test('TF3: debt tracks a fix, why names the waived debt, and fix merge settles only its presentation', async () => {
  const r = await fixture();
  try {
    await r.measure(); const failed = (await r.obs()).find(e => e.obligation === 'check:runtime')!;
    assert.equal((await r.waive('fix',failed.seq)).code,0);
    const e = (await r.ledger.read()).findLast((e):e is WaiveEntry => e.kind === 'waive')!; assert.equal(e.tracked_by,'fix');
    const before = await r.state(), debt = `a/check:runtime: waived — tracked by fix: trunk race tracked (block #${failed.seq})`;
    const entries = await r.ledger.read(), untracked = entries.map(e => {
      if (e.kind !== 'waive') return e;
      const {tracked_by,ignorable,...old} = e;
      const remaining = ignorable?.filter(name => name !== 'tracked_by');
      return remaining?.length ? {...old,ignorable:remaining} : old;
    });
    const oldState = reducer.reduce(untracked,sha => reducer.planAt(before,entries.find(e => (e.kind === 'plan' || e.kind === 'genesis') && e.plan === sha)!.seq + 1));
    assert.deepEqual(before,oldState,'tracked_by does not change replay state or gates');
    assert.ok((await ops.status(r)).summary!.debt.includes(debt)); assert.ok((await ops.brief(r)).summary!.debt.includes(debt));
    assert.match(views.renderWhy(await ops.why({...r,node:'fix'})),new RegExp(`tracks waived debt: a/check:runtime #${e.seq}`));
    assert.match(views.renderWhy(await ops.why({...r,node:'fix'}),{full:true}),/tracks waived debt/);
    const merge = await r.mergeFix(), after = await r.state();
    assert.deepEqual(after.nodes.a,before.nodes.a);
    assert.equal((await ops.status(r)).summary!.debt.some(d => d.includes('a/check:runtime')),false);
    assert.equal((await ops.brief(r)).summary!.debt.some(d => d.includes('a/check:runtime')),false);
    for (const text of [views.renderStatus(await ops.status(r),{full:true}),views.renderReport(await ops.report(r))]) assert.match(text,new RegExp(`settled by fix \\(merge #${merge.entry.seq}\\)`));
    assert.doesNotMatch(views.renderReport(await ops.report(r)),/flake is gone/);
  } finally { await r.cleanup(); }
});

test('TF3: removing an unmerged tracker restores visible debt, and replay validates tracker membership at its seq', async () => {
  const r = await fixture();
  try {
    assert.equal((await r.waive()).code,0);
    const s = await r.state(), waiver = (await r.ledger.read()).findLast((e):e is WaiveEntry => e.kind === 'waive')!;
    const {seq,ts,prev,hash,...d} = waiver;
    assert.ok(reducer.validateDraft(s,{...d,tracked_by:123} as unknown as Draft).some(e => e.includes('tracked_by')));
    assert.ok(reducer.validateDraft(s,{...d,tracked_by:'missing'}).some(e => e.includes('tracked_by')));
    await ops.planSet({...r,as:owner,channel:'delegated',note:'remove unmerged fixture tracker',plan:JSON.stringify({...r.plan,nodes:r.plan.nodes.filter(n => n.id !== 'fix')})});
    assert.ok((await ops.status(r)).summary!.debt.some(d => d.includes('(tracker fix left the plan)')));
    assert.equal((await ops.verify(r)).ok,true);
  } finally { await r.cleanup(); }
});

test('TF3: adding or changing tracked-by is a new act; identical tracked retries retain their receipt', async () => {
  const r = await fixture();
  try {
    const opts = {...r,node:'a',obligation:'check:runtime',reason:'same risk',as:owner,channel:'delegated' as const};
    const plain = await ops.waive(opts), tracked = await ops.waive({...opts,tracked_by:'fix'});
    assert.ok(tracked.seq > plain.seq); assert.equal(tracked.alreadyRecorded,undefined);
    const retry = await ops.waive({...opts,tracked_by:'fix'}); assert.equal(retry.alreadyRecorded,tracked.seq);
    const changed = await ops.waive({...opts,tracked_by:'fix2'}); assert.ok(changed.seq > tracked.seq); assert.equal(changed.alreadyRecorded,undefined);
    assert.match(views.renderStatus(await ops.status(r)),/tracked by fix2/);
    await r.measure(); const risk = (await r.obs()).find(e => e.obligation === 'check:runtime')!.seq;
    const accepted = await ops.waive({...opts,reason:'accept failure',accept_risk:[risk]});
    const acceptedTracked = await ops.waive({...opts,reason:'accept failure',accept_risk:[risk],tracked_by:'fix'});
    assert.ok(acceptedTracked.seq > accepted.seq);
    const acceptedRetry = await ops.waive({...opts,reason:'accept failure',accept_risk:[risk],tracked_by:'fix'});
    assert.equal(acceptedRetry.alreadyRecorded,acceptedTracked.seq);
  } finally { await r.cleanup(); }
});

test('TF1: a trunk CAS during the running probe discards only that run; the node attest lock is shared', async () => {
  const r = await fixture();
  try {
    await r.setMode('pass'); assert.equal((await r.probe(['--check','runtime'])).code,0);
    const before = await r.ledger.read();
    await r.ledger.withLock(async () => {
      await assert.rejects(ops.attestProbeTrunk({...r,node:'a',check:'runtime'}),e => e instanceof Error && /already running/.test(e.message));
    },ops.attestLock('a'));
    assert.deepEqual(await r.ledger.read(),before);
    const started = join(r.root,'started'), release = join(r.root,'release');
    const barrier = `touch '${started}'; for ((i=0;i<200;i++)); do test -e '${release}' && break; sleep 0.05; done; test -e '${release}' || exit 127; echo 'owed-counts {"pass":1,"fail":0}'`;
    await ops.planSet({...r,as:owner,channel:'delegated',note:'bounded CAS fixture',plan:JSON.stringify({...r.plan,nodes:r.plan.nodes.map(n => n.id === 'a' ? {...n,checks:[{...r.check,run:barrier}]} : n)})});
    const count = (await r.obs()).filter(e => e.probe === 'trunk').length;
    const running = r.probe(['--check','runtime']);
    try {
      let ready = false;
      for (let i=0;i<200;i++) { try { await access(started); ready=true; break; } catch { await new Promise(resolve => setTimeout(resolve,20)); } }
      assert.ok(ready,'bounded probe start');
      await commitAt(r.cwd,{unrelated:'moved trunk'}); await writeFile(release,'release');
      const out = await running; assert.equal(out.code,1,out.stderr); assert.match(out.stderr,/trunk changed \(CAS\)/);
      assert.equal((await r.obs()).filter(e => e.probe === 'trunk').length,count);
      assert.match(clockTime('2026-10-16T12:00:00Z',now),/^\d{2}:\d{2}$/);
    } finally { await writeFile(release,'release'); await running; }
  } finally { await r.cleanup(); }
});


test('TF3: the Pi waive tool records tracked_by and refuses an invalid tracker', async () => {
  const r = await fixture();
  try {
    const tools = new Map<string,ToolDefinition>();
    owed({registerTool:(t:ToolDefinition) => tools.set(t.name,t),registerCommand(){},on(){},sendMessage(){}} as unknown as ExtensionAPI);
    const tool = tools.get('owed_waive')!, ctx = {cwd:r.cwd,hasUI:false} as Parameters<ToolDefinition['execute']>[4];
    const refused = await tool.execute('bad',{node:'a',obligation:'check:runtime',reason:'tracking',tracked_by:'missing'},undefined,undefined,ctx) as {isError?:boolean};
    assert.equal(refused.isError,true);
    const result = await tool.execute('tracked',{node:'a',obligation:'check:runtime',reason:'tracking',tracked_by:'fix'},undefined,undefined,ctx);
    const e = result.details as WaiveEntry; assert.equal(e.tracked_by,'fix');
    assert.match(views.renderStatus(await ops.status(r)),/tracked by fix: tracking/);
  } finally { await r.cleanup(); }
});

test('TF1: default selection probes every blocked check, while --check selects only the named one', async () => {
  const r = await fixture();
  try {
    await ops.planSet({...r,as:owner,channel:'delegated',note:'add fixture check',plan:JSON.stringify({...r.plan,nodes:r.plan.nodes.map(n => n.id === 'a' ? {...n,checks:[r.check,{...r.check,id:'second'}]} : n)})});
    await r.measure();
    const out = await r.probe(['--runs','3']); assert.equal(out.code,1,out.stderr);
    const probes = (await r.obs()).filter(e => e.probe === 'trunk');
    assert.deepEqual(probes.map(e => e.obligation),['check:runtime','check:second']);
    assert.match(out.stdout,/trunk probe check:second/);
    await r.setMode('pass'); assert.equal((await r.probe(['--check','second'])).code,0);
    assert.deepEqual((await r.obs()).filter(e => e.probe === 'trunk').map(e => e.obligation),['check:runtime','check:second','check:second']);
  } finally { await r.cleanup(); }
});

async function sameKeyDebts() {
  const r = await fixture();
  try {
    await r.measure();
    const first = (await r.obs()).findLast(e => e.obligation === 'check:runtime' && e.verdict === 'fail' && !e.probe)!;
    assert.equal((await r.waive('fix',first.seq)).code,0);
    const w1 = (await r.ledger.read()).findLast((e):e is WaiveEntry => e.kind === 'waive')!;
    const rerun = await cli(r.cwd,['attest','a','--rerun']); assert.equal(rerun.code,1,rerun.stderr);
    const second = (await r.obs()).findLast(e => e.obligation === 'check:runtime' && e.verdict === 'fail' && !e.probe)!;
    assert.ok(second.seq > first.seq); assert.equal(second.key,first.key);
    assert.equal((await r.waive('fix2',second.seq)).code,0);
    const w2 = (await r.ledger.read()).findLast((e):e is WaiveEntry => e.kind === 'waive')!;
    const debts = async () => (await ops.status(r)).summary!.debt.filter(d => d.startsWith('a/check:runtime: waived — '));
    return {...r,first,second,w1,w2,debts};
  } catch(e) { await r.cleanup(); throw e; }
}

test('TF3 #3000: same-key failures keep separate debt; merging fix2 does not settle fix1', async () => {
  const r = await sameKeyDebts();
  try {
    const before = await r.state();
    const f = await ops.dispatch({...r,node:'fix2',as:parent});
    await commitAt(f.worktree,{other:'repair'});
    await ops.submit({cwd:f.worktree,node:'fix2',as:{role:'writer',id:'fix2#1'}});
    await ops.attest({...r,node:'fix2'});
    const merged = await ops.merge({...r,node:'fix2',as:parent});
    const after = await r.state();
    assert.deepEqual(after.nodes.a,before.nodes.a,'debt settlement changes no node gate state');
    const expected = `a/check:runtime: waived — tracked by fix: trunk race tracked (block #${r.first.seq})`;
    assert.deepEqual(await r.debts(),[expected]);
    assert.deepEqual((await ops.brief(r)).summary!.debt.filter(d => d.startsWith('a/check:runtime: waived — ')),[expected]);
    assert.match(views.renderStatus(await ops.status(r)),/tracked by fix:/);
    assert.match(views.renderBrief(await ops.brief(r)),/tracked by fix:/);
    for (const full of [views.renderStatus(await ops.status(r),{full:true}),views.renderReport(await ops.report(r))]) {
      assert.match(full,new RegExp(`tracked by fix:.*block #${r.first.seq}`));
      assert.match(full,new RegExp(`settled by fix2 \\(merge #${merged.entry.seq}\\).*block #${r.second.seq}`));
    }
    assert.match(views.renderWhy(await ops.why({...r,node:'fix'})),new RegExp(`tracks waived debt: a/check:runtime #${r.w1.seq}`));
    assert.match(views.renderWhy(await ops.why({...r,node:'fix2'})),new RegExp(`tracks waived debt: a/check:runtime #${r.w2.seq}`));
    assert.equal((await ops.verify(r)).ok,true);
  } finally { await r.cleanup(); }
});

test('TF3 #3000: re-waiving one failure replaces only its tracker, not a different failure', async () => {
  const r = await sameKeyDebts();
  try {
    assert.equal((await r.debts()).length,2,'same-key failures with identical reasons are distinct debts');
    const before = await r.state();
    assert.equal((await r.waive('fix',r.second.seq)).code,0);
    const latest = (await r.ledger.read()).findLast((e):e is WaiveEntry => e.kind === 'waive')!;
    const debts = await r.debts(); assert.equal(debts.length,2);
    assert.ok(debts.every(d => d.includes('tracked by fix:')));
    const after = await r.state();
    assert.deepEqual(after.nodes.a!.blocks,before.nodes.a!.blocks,'tracker reassignment changes no blocks');
    assert.equal(after.nodes.a!.accepted,before.nodes.a!.accepted);
    assert.deepEqual(after.nodes.a!.items.map(({evidence,...item}) => item),before.nodes.a!.items.map(({evidence,...item}) => item),'only the latest waiver receipt seq changes, not gate status');
    const why = views.renderWhy(await ops.why({...r,node:'fix'}));
    assert.match(why,new RegExp(`tracks waived debt: a/check:runtime #${r.w1.seq}`));
    assert.match(why,new RegExp(`tracks waived debt: a/check:runtime #${latest.seq}`));
    assert.doesNotMatch(views.renderWhy(await ops.why({...r,node:'fix2'})),/tracks waived debt/);
    await r.mergeFix(); assert.deepEqual(await r.debts(),[]);
  } finally { await r.cleanup(); }
});

test('TF3 #3000: each unmerged tracker leaving the plan preserves only its own debt label', async () => {
  const r = await sameKeyDebts();
  try {
    await ops.planSet({...r,as:owner,channel:'delegated',note:'remove first debt tracker',plan:JSON.stringify({...r.plan,nodes:r.plan.nodes.filter(n => n.id !== 'fix')})});
    let debts = await r.debts(); assert.equal(debts.length,2);
    assert.ok(debts.some(d => d.includes('(tracker fix left the plan)') && d.includes(`block #${r.first.seq}`)));
    assert.ok(debts.some(d => d.includes('tracked by fix2:') && d.includes(`block #${r.second.seq}`)));
    assert.match(views.renderWhy(await ops.why({...r,node:'fix'})),new RegExp(`tracks waived debt: a/check:runtime #${r.w1.seq}`));
    await ops.planSet({...r,as:owner,channel:'delegated',note:'remove second debt tracker',plan:JSON.stringify({...r.plan,nodes:r.plan.nodes.filter(n => n.id === 'a')})});
    debts = await r.debts(); assert.equal(debts.length,2);
    assert.ok(debts.some(d => d.includes('(tracker fix left the plan)')));
    assert.ok(debts.some(d => d.includes('(tracker fix2 left the plan)')));
    assert.equal((await ops.brief(r)).summary!.debt.filter(d => d.includes(': waived — ')).length,2);
    assert.equal((await ops.verify(r)).ok,true);
  } finally { await r.cleanup(); }
});

test('TF3 #3000: a multi-risk waiver preserves one line per failure even with identical trackers and reasons', async () => {
  const r = await fixture();
  try {
    await r.measure(); const first = (await r.obs()).find(e => e.obligation === 'check:runtime')!;
    await r.setMode('pass'); await r.measure();
    await r.setMode('fail'); const out = await cli(r.cwd,['attest','a','--rerun']); assert.equal(out.code,1,out.stderr);
    const second = (await r.obs()).findLast(e => e.obligation === 'check:runtime' && e.verdict === 'fail')!;
    assert.ok(second.seq > first.seq); assert.equal(first.key,second.key);
    const w = await ops.waive({...r,node:'a',obligation:'check:runtime',accept_risk:[first.seq,second.seq],tracked_by:'fix',reason:'both failures',as:owner,channel:'delegated'});
    const debts = (await ops.status(r)).summary!.debt.filter(d => d.includes(': waived — '));
    assert.equal(debts.length,2); assert.ok(debts.some(d => d.includes(`block #${first.seq}`))); assert.ok(debts.some(d => d.includes(`block #${second.seq}`)));
    assert.equal(views.trackedWaivers(await r.state()).filter(e => e.seq === w.seq).length,2);
    const why = views.renderWhy(await ops.why({...r,node:'fix'}));
    assert.ok(why.includes(`tracks waived debt: a/check:runtime #${w.seq} (block #${first.seq})`));
    assert.ok(why.includes(`tracks waived debt: a/check:runtime #${w.seq} (block #${second.seq})`));
    assert.equal((await ops.brief(r)).summary!.debt.filter(d => d.includes(': waived — ')).length,2);
    const before = await r.state(); views.renderReport(await ops.report(r)); assert.deepEqual(await r.state(),before);
  } finally { await r.cleanup(); }
});

test('TF1: latest current-trunk probe controls merge diagnosis and the next merge reuses its key', async () => {
  const r = await fixture();
  try {
    await r.setMode('candidate-pass'); await r.measure();
    const moved = await commitAt(r.cwd,{'check.sh':(await readFile(join(r.cwd,'check.sh'),'utf8')) + '# trunk change in check reads\n'});
    await ops.adopt({cwd:r.cwd,as:owner,channel:'delegated',note:'fixture trunk moves'});
    await r.setMode('fail');
    assert.equal((await r.probe(['--check','runtime'])).code,1);
    const count = (await r.obs()).filter(e => e.probe === 'trunk').length;
    await assert.rejects(ops.merge({cwd:r.cwd,node:'a',as:parent}),/trunk-red:/);
    let s = await r.state(); const failure = (await r.obs()).findLast(e => e.merging === 'a')!;
    assert.equal((await r.obs()).filter(e => e.probe === 'trunk').length,count,'merge reuses explicit trunk probe');
    assert.ok(reducer.trunkRedOf(s,failure.seq)); assert.ok(reducer.trunkParked(s,'a').length);
    assert.match(views.renderWhy(await ops.why({...r,node:'a'})),/trunk-red:/);
    assert.equal(views.sharedCheckHint(s,{seq:failure.seq,key:failure.key}),undefined,'trunk-red text wins');
    await r.setMode('pass'); assert.equal((await r.probe()).code,0);
    s = await r.state(); assert.equal(reducer.trunkRedOf(s,failure.seq),undefined); assert.deepEqual(reducer.trunkParked(s,'a'),[]);
    assert.equal(s.trunk.commit,moved); assert.equal(s.nodes.a!.accepted,false,'probe pass does not accept a failed node');
    await r.setMode('fail'); assert.equal((await r.probe()).code,1);
    assert.ok(reducer.trunkRedOf(await r.state(),failure.seq));
  } finally { await r.cleanup(); }
});
