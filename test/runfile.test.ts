// RF1–RF5: a plan-pinned executable, including pre-record refusal and every shared execution path.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { stringify } from 'yaml';
import { H, canonical, sha256 } from '../src/canon.ts';
import { parsePlan } from '../src/plan.ts';
import { editText } from '../src/edit.ts';
import { lintPlanShell } from '../src/planlint.ts';
import { Ledger } from '../src/ledger.ts';
import { candidateFacts, execKey, git, readsDigest, stateFacts, trunkCheckKey } from '../src/git.ts';
import { runJob } from '../src/exec.ts';
import { checkDefinition } from '../src/reducer.ts';
import * as ops from '../src/ops.ts';
import type { AttestJob, CheckSpec, ObsEntry, Plan } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const owner = { role:'owner', id:'pi' } as const, parent = { role:'parent', id:'main' } as const;
const scriptPath = 'test/pinned.sh';
const script = '#!/bin/sh\nprintf "pinned bytes\\n"\nif [ "$(cat src/value)" = good ]; then echo \'owed-counts {"pass":1,"fail":0}\'; else echo \'owed-counts {"pass":0,"fail":1}\'; exit 1; fi\n';
const pin = (bytes = script, path = scriptPath) => ({ path, sha256:sha256(bytes) });
const text = (check: object = { run_file:pin() }, extra: object = {}) => JSON.stringify({ version:1, trunk:'main', lease:false, closure:[], invariants:[], nodes:[{ id:'a', writes:['src/','test/'], checks:[{ id:'gate', min_tests:1, ...check }] }], ...extra });
const specOf = (plan: Plan) => plan.nodes[0]!.checks[0]!;
const obsOf = (observations: import('../src/types.ts').Entry[], obligation = 'check:gate') => observations.find((e): e is ObsEntry => e.kind === 'obs' && e.obligation === obligation)!;
async function init(cwd: string, plan: string, path?: string) { return ops.init({ cwd, plan, path, as:owner, channel:'delegated', measure:false }); }
async function job(cwd: string, ledger: Ledger, plan: Plan, commit: string, base = commit, kind: AttestJob['kind'] = 'check', spec = specOf(plan), extra: Partial<AttestJob> = {}) {
  return runJob({cwd,ledger,plan},{subject:kind === 'inv' ? 'trunk' : 'a',obligation:`${kind}:${spec.id}`,kind,key:'test-key',commit,base,spec,...extra});
}

test('RF red: admission pins bytes and candidate changes cannot change the measured script', async () => {
  const r = await repo();
  try {
    await commitAt(r.cwd,{'src/value':'bad'});
    await r.put(scriptPath,script); // Untracked working-tree file is the admission source, not the base.
    const recorded = await init(r.cwd,text({run_file:pin(),red:true,tests:['test/overlay.txt']}));
    assert.match(recorded.warnings!.join('\n'), /check a\/gate: run_file test\/pinned.sh \(sha256 [a-f0-9]{12}\)/);
    const ledger = await Ledger.open(r.cwd);
    assert.deepEqual(await ledger.getBlob(pin().sha256),Buffer.from(script));
    const d = await ops.dispatch({cwd:r.cwd,node:'a',as:parent});
    await commitAt(d.worktree,{'src/value':'good',[scriptPath]:'#!/bin/sh\necho candidate bytes; exit 42\n','test/overlay.txt':'red overlay'});
    await ops.submit({cwd:d.worktree,node:'a',as:{role:'writer',id:'a#1'}});
    const measured = await ops.attest({cwd:r.cwd,node:'a'});
    assert.equal(measured.accepted,true,JSON.stringify(measured.observations));
    for (const obligation of ['check:gate','red:gate']) {
      const obs = obsOf(measured.observations,obligation);
      assert.equal(obs.verdict,'pass',obs.note);
      const log = (await ledger.getBlob(obs.log!)).toString();
      assert.match(log,/pinned bytes/); assert.doesNotMatch(log,/candidate bytes/);
    }
    await rm(join(r.cwd,scriptPath));
    assert.equal((await ops.verify({cwd:r.cwd})).ok,true,'replay does not read the source script');
  } finally { await r.cleanup(); }
});

test('RF1 schema: canonical reparse, args quoting, strict path/hash and exclusive forms', () => {
  const args = ['$HOME','two words',"it's literal",'', '; touch injected'];
  const plan = parsePlan(text({run_file:pin(),args})), check = specOf(plan);
  assert.equal(check.run, "exec ./test/pinned.sh '$HOME' 'two words' 'it'\\''s literal' '' '; touch injected'");
  assert.deepEqual(check.args,args); assert.deepEqual(check.run_file,pin());
  assert.equal(canonical(parsePlan(stringify(plan))),canonical(plan));
  for (const path of ['', '/a','./a','a/../b','a/./b','a//b','a/','a*','a?','a[b]','a{b}','a!','a\\b','a b','a;touch','a$HOME',"a'b",'a\n']) {
    assert.throws(() => parsePlan(text({run_file:pin(script,path)})),/run_file.path/);
  }
  for (const hash of ['A'.repeat(64),'a'.repeat(63),123]) assert.throws(() => parsePlan(text({run_file:{path:scriptPath,sha256:hash}})),/sha256/);
  for (const args of ['x', [1], ['bad\0arg'], Array(65).fill('')]) assert.throws(() => parsePlan(text({run_file:pin(),args})),/args/);
  assert.throws(() => parsePlan(text({run_file:{...pin(),unknown:true}})),/unknown key/);
  assert.throws(() => parsePlan(text({run_file:pin(),run:'true'})),/run and run_file are exclusive/);
  assert.throws(() => parsePlan(text({run_file:pin(),template:'evidence-json',path:'evidence',required:['ok']})),/template and run_file are exclusive/);
  assert.throws(() => parsePlan(text({run:'true',args:[]})),/args requires run_file/);
});

test('RF2 mismatch and missing source refuse before genesis/plan/edit writes', async () => {
  const r = await repo();
  try {
    await commitAt(r.cwd,{'src/value':'good',[scriptPath]:'wrong bytes'});
    const ledger = await Ledger.open(r.cwd);
    await assert.rejects(init(r.cwd,text()),new RegExp(`run_file ${scriptPath} of check a/gate: sha256 ${sha256('wrong bytes')}, the plan says ${pin().sha256}`));
    assert.deepEqual(await ledger.read(),[]);
    await rm(join(r.cwd,scriptPath));
    await assert.rejects(init(r.cwd,text()),/not found in/); assert.deepEqual(await ledger.read(),[]);
    const plain = text({run:'true'}); await r.put('plan.json',plain); await init(r.cwd,plain);
    await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',plan:plain,path:'plan.json',note:'source'});
    const before = await ledger.read();
    await assert.rejects(ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',plan:text(),note:'pin'}),/not found in/);
    await assert.rejects(ops.edit({cwd:r.cwd,as:owner,channel:'delegated',node:'a',set:[`checks.gate.run_file=${JSON.stringify(pin())}`],unset:['checks.gate.run'],note:'pin'}),/not found in/);
    assert.deepEqual(await ledger.read(),before); assert.equal(await readFile(join(r.cwd,'plan.json'),'utf8'),plain);
  } finally { await r.cleanup(); }
});

test('RF2 --rev uses repository-relative bytes from the commit, not cwd or current script', async () => {
  const r = await repo();
  try {
    const source = await commitAt(r.cwd,{'src/value':'good',[scriptPath]:script,'plan.json':text()});
    await init(r.cwd,text({run:'true'}));
    await r.put(scriptPath,'working-tree poison');
    await mkdir(join(r.cwd,'subdir'));
    const read = await ops.readPlan({cwd:join(r.cwd,'subdir'),path:'../plan.json',rev:source});
    await ops.planSet({cwd:join(r.cwd,'subdir'),as:owner,channel:'delegated',...read,note:'pin commit bytes'});
    const ledger = await Ledger.open(r.cwd); assert.deepEqual(await ledger.getBlob(pin().sha256),Buffer.from(script));
    const last = (await ledger.read()).at(-1)!; assert.ok(last.kind === 'plan' && last.rev === source);
    const absent = await commitAt(r.cwd,{'other':'x'});
    // A distinct missing pin cannot reuse the admitted one.
    const before = await ledger.read();
    await assert.rejects(ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',plan:text({run_file:pin('new','test/missing.sh')}),rev:absent,note:'missing commit file'}),/not found in/);
    assert.deepEqual(await ledger.read(),before);
  } finally { await r.cleanup(); }
});

test('RF1/RF5 owed edit accepts nested pin and args assignments, plan/edit replies describe pins', async () => {
  const r = await repo();
  try {
    await commitAt(r.cwd,{'src/value':'good',[scriptPath]:script});
    const plain = text({run:'true'}); await r.put('plan.json',plain); await init(r.cwd,plain);
    const recorded = await cli(r.cwd,['plan','plan.json','--i-am-owner']); assert.equal(recorded.code,0,recorded.stderr);
    const edit = await cli(r.cwd,['edit','a','--set',`checks.gate.run_file.path=${scriptPath}`,'--set',`checks.gate.run_file.sha256=${pin().sha256}`,'--set',`checks.gate.args=['$HOME', 'two words', "it's"]`,'--unset','checks.gate.run','--note','pin script','--i-am-owner']);
    assert.equal(edit.code,0,edit.stderr); assert.match(edit.stdout,/check a\/gate: run_file test\/pinned.sh \(sha256 [a-f0-9]{12}\)/);
    const read = await ops.readPlan({cwd:r.cwd,path:'plan.json'});
    const planReply = await cli(r.cwd,['plan','plan.json','--i-am-owner']); assert.equal(planReply.code,0,planReply.stderr); assert.match(planReply.stdout,/check a\/gate: run_file/);
    const plan = parsePlan(read.plan); assert.deepEqual(specOf(plan).args,['$HOME','two words',"it's"]);
    const editedInv = editText(text({run:'true'}, {invariants:[{id:'inv',run:'true'}]}),{invariant:'inv',set:[`run_file.path=${scriptPath}`,`run_file.sha256=${pin().sha256}`,'args=[]'],unset:['run']});
    assert.deepEqual(parsePlan(editedInv).invariants[0]!.run_file,pin());
    const canonicalEdit = editText(stringify(plan),{node:'a',set:['checks.gate.args=[changed]',`checks.gate.run_file.sha256=${sha256('changed bytes')}`]});
    assert.equal(specOf(parsePlan(canonicalEdit)).run,"exec ./test/pinned.sh 'changed'");
    assert.equal(specOf(parsePlan(canonicalEdit)).run_file!.sha256,sha256('changed bytes'));
    const noArgs = editText(stringify(plan),{node:'a',unset:['checks.gate.args']});
    assert.equal(specOf(parsePlan(noArgs)).run,'exec ./test/pinned.sh');
    assert.throws(() => editText(stringify(plan),{node:'a',set:['checks.gate.args=[changed]','checks.gate.run=true']}),/run and run_file are exclusive/);
    assert.deepEqual(lintPlanShell(plan),[]);
    assert.throws(() => lintPlanShell(parsePlan(text({run_file:pin(),on_timeout:'if then'}))),/bash -n/,'diagnostics still linted');
  } finally { await r.cleanup(); }
});

test('RF2 amend and decide plan changes re-admit missing blobs before any entry or file write', async () => {
  const r = await repo();
  try {
    await commitAt(r.cwd,{'src/value':'good',[scriptPath]:script,'plan.json':text()});
    await init(r.cwd,text());
    await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',plan:text(),path:'plan.json',note:'source'});
    const ledger = await Ledger.open(r.cwd), blob = join(ledger.dir,'blobs',pin().sha256);
    await rm(blob); await r.put(scriptPath,'wrong bytes');
    const before = await ledger.read(), file = await readFile(join(r.cwd,'plan.json'),'utf8');
    await assert.rejects(ops.amend({cwd:r.cwd,as:owner,channel:'delegated',node:'a',writes:['extra/'],note:'bounded'}),/run_file .*sha256/);
    await assert.rejects(ops.decide({cwd:r.cwd,as:owner,channel:'delegated',nodes:'a',writes:['extra/'],text:'bounded'}),/run_file .*sha256/);
    assert.deepEqual(await ledger.read(),before); assert.equal(await readFile(join(r.cwd,'plan.json'),'utf8'),file);
    await r.put(scriptPath,script);
    await ops.amend({cwd:r.cwd,as:owner,channel:'delegated',node:'a',writes:['extra/'],note:'bounded'});
    assert.deepEqual(await ledger.getBlob(pin().sha256),Buffer.from(script));
    await rm(blob);
    await ops.decide({cwd:r.cwd,as:owner,channel:'delegated',nodes:'a',writes:['more/'],text:'bounded'});
    assert.deepEqual(await ledger.getBlob(pin().sha256),Buffer.from(script));
  } finally { await r.cleanup(); }
});

test('RF2 current worktree root and --rev preserve exact script bytes, existing blobs need no source', async () => {
  const r = await repo();
  try {
    await commitAt(r.cwd,{'src/value':'good'}); await init(r.cwd,text({run:'true'}));
    const d = await ops.dispatch({cwd:r.cwd,node:'a',as:parent});
    const bytes = Buffer.from([35,33,47,98,105,110,47,115,104,10,35,255,0,10]);
    await mkdir(join(d.worktree,'test')); await writeFile(join(d.worktree,scriptPath),bytes);
    await r.put(scriptPath,'main-worktree poison');
    const plan = text({run_file:{path:scriptPath,sha256:sha256(bytes)}}), ledger = await Ledger.open(r.cwd);
    await ops.planSet({cwd:d.worktree,as:owner,channel:'delegated',plan,note:'slot worktree source'});
    assert.deepEqual(await ledger.getBlob(sha256(bytes)),bytes);
    await rm(join(ledger.dir,'blobs',sha256(bytes)));
    const source = await commitAt(d.worktree,{'slot.txt':'commit binary script'});
    await rm(join(d.worktree,scriptPath));
    await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',plan,rev:source,note:'exact Git blob bytes'});
    assert.deepEqual(await ledger.getBlob(sha256(bytes)),bytes);
    await rm(join(r.cwd,scriptPath));
    await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',plan,note:'existing blob needs no source'});
    assert.equal((await ops.verify({cwd:r.cwd})).ok,true);
  } finally { await r.cleanup(); }
});

test('RF3 shared path preserves argv, wrap/env and reinstalls after setup and each repeat', async () => {
  const r = await repo();
  try {
    const args = ['$HOME','two words',"it's literal",'', '; touch injected'];
    const bytes = `#!/usr/bin/env node\nconst fs=require('node:fs'),assert=require('node:assert/strict');assert.deepEqual(process.argv.slice(2),${JSON.stringify(args)});assert.equal(process.env.PIN_ENV,'kept');assert.equal(fs.statSync(__filename).mode & 511,493);console.log('owed-counts '+JSON.stringify({pass:1,fail:0}));fs.writeFileSync(__filename,'poison');\n`;
    const commit = await commitAt(r.cwd,{'src/value':'good'});
    await r.put(scriptPath,bytes);
    const source = text({run_file:pin(bytes),args,repeat:{runs:2,need:2}},{setup:`mkdir -p test; echo setup-poison > ${scriptPath}`,exec:{env:{PIN_ENV:'kept'},wrap:'exec bash -lc {cmd}'}});
    await init(r.cwd,source); const ledger = await Ledger.open(r.cwd), plan = parsePlan(source);
    const obs = await job(r.cwd,ledger,plan,commit);
    assert.equal(obs.verdict,'pass',obs.note); assert.equal(obs.runs?.length,2);
    assert.deepEqual(obs.runs?.map(r => r.verdict),['pass','pass']);
    const log = (await ledger.getBlob(obs.log!)).toString(); assert.doesNotMatch(log,/poison/);
  } finally { await r.cleanup(); }
});

test('RF3 missing/corrupt blob and symlinked parent/target cannot escape the measured tree', async () => {
  const r = await repo();
  try {
    const commit = await commitAt(r.cwd,{'src/value':'good'}); await r.put(scriptPath,script); await init(r.cwd,text());
    const ledger = await Ledger.open(r.cwd), plan = parsePlan(text()), blob = join(ledger.dir,'blobs',pin().sha256);
    await rm(blob);
    let obs = await job(r.cwd,ledger,plan,commit); assert.equal(obs.verdict,'error'); assert.match(obs.note!,/^environment: run_file test\/pinned.sh:/);
    obs = await job(r.cwd,ledger,plan,commit,commit,'red'); assert.equal(obs.verdict,'error','missing blob is not a successful counterfactual');
    await writeFile(blob,'corrupt');
    obs = await job(r.cwd,ledger,plan,commit); assert.equal(obs.verdict,'error'); assert.match(obs.note!,/^environment: run_file .*corrupt blob/);
    await rm(blob); await ledger.putBlob(script);
    const outside = join(r.root,'outside'); await mkdir(outside); const victim = join(outside,'pinned.sh'); await writeFile(victim,'untouched');
    await rm(join(r.cwd,'test'),{recursive:true}); await symlink(outside,join(r.cwd,'test')); const linked = await r.commit();
    obs = await job(r.cwd,ledger,plan,linked); assert.equal(obs.verdict,'error'); assert.match(obs.note!,/symlinked.*parent/); assert.equal(await readFile(victim,'utf8'),'untouched');
    await rm(join(r.cwd,'test')); await mkdir(join(r.cwd,'test')); await symlink(victim,join(r.cwd,scriptPath)); const target = await r.commit();
    obs = await job(r.cwd,ledger,plan,target); assert.equal(obs.verdict,'pass',obs.note); assert.equal(await readFile(victim,'utf8'),'untouched');
    const directory = parsePlan(text({run_file:pin()}, {setup:`rm -f ${scriptPath}; mkdir -p ${scriptPath}`}));
    obs = await job(r.cwd,ledger,directory,target); assert.equal(obs.verdict,'error'); assert.match(obs.note!,/^environment: run_file .*:/,'failed install remains an environment error');
  } finally { await r.cleanup(); }
});

test('RF3 invariants, strength, attribution and trunk probes execute the admitted blob', async () => {
  const r = await repo();
  try {
    const patch = 'diff --git a/src/value b/src/value\n--- a/src/value\n+++ b/src/value\n@@ -1 +1 @@\n-good\n+bad\n';
    const base = await commitAt(r.cwd,{'src/value':'good\n','test/mutant.patch':patch}); await r.put(scriptPath,script);
    const source = text({run_file:pin(),mutants:['test/mutant.patch']},{closure:['test/mutant.patch'],invariants:[{id:'inv',run_file:pin(),min_tests:1,reads:['src/']}]});
    await init(r.cwd,source); const plan = parsePlan(source), ledger = await Ledger.open(r.cwd);
    for (const [kind,spec,extra] of [
      ['inv',plan.invariants[0]!,{}], ['strength',specOf(plan),{}], ['check',specOf(plan),{attribution:true}], ['check',specOf(plan),{probe:'trunk'}],
    ] as const) {
      const obs = await job(r.cwd,ledger,plan,base,base,kind,spec,extra);
      assert.equal(obs.verdict,'pass',`${kind}: ${obs.note}`); assert.match((await ledger.getBlob(obs.log!)).toString(),/pinned bytes/);
    }
  } finally { await r.cleanup(); }
});

test('RF4 all executable keys change with sha/args while legacy key payloads stay byte-identical', async () => {
  const r = await repo();
  try {
    const commit = await commitAt(r.cwd,{'src/value':'good','test/mutant.patch':'patch'});
    const extra = {closure:['test/mutant.patch']}, common = {reads:['src/'],red:true,tests:['test/'],mutants:['test/mutant.patch']};
    const plain = parsePlan(text({run:'echo legacy',...common},extra)), c = specOf(plain);
    const facts = await candidateFacts(r.cwd,plain,plain.nodes[0]!,commit,commit,1);
    const closure = await readsDigest(r.cwd,commit,plain.closure), reads = await readsDigest(r.cwd,commit,c.reads), tree = (await git(r.cwd,['rev-parse',`${commit}^{tree}`])).stdout.trim();
    const legacy = {id:c.id,run:c.run,timeout_s:c.timeout_s,setup:plain.setup,exec:execKey(plain),min_tests:c.min_tests,closure};
    assert.equal(facts.keys['check:gate'],H({o:'check',...legacy,reads}));
    assert.equal(facts.keys['red:gate'],H({o:'red',...legacy,red_expect:c.red_expect,base:tree,tests:await readsDigest(r.cwd,commit,c.tests!)}));
    const listing = (await git(r.cwd,['ls-tree','-rz','--full-tree',commit])).stdout.split('\0').filter(Boolean).map(line => {const tab=line.indexOf('\t'),[mode,,oid]=line.slice(0,tab).split(' ');return [line.slice(tab+1),mode,oid];}).filter(([p]) => p === 'test/mutant.patch');
    assert.equal(facts.keys['strength:gate'],H({o:'strength',...legacy,min_kill:1,mutants:H(listing),reads}));
    const plans = [parsePlan(text({run_file:pin(),...common},extra)),parsePlan(text({run_file:pin('new bytes'),...common},extra)),parsePlan(text({run_file:pin(),args:['$'],...common},extra))];
    assert.equal(new Set(plans.map(p => checkDefinition(p,'a','gate'))).size,3,'full supersede definitions include the pin and args');
    const keys = await Promise.all(plans.map(p => candidateFacts(r.cwd,p,p.nodes[0]!,commit,commit,1)));
    for (const kind of ['check','red','strength']) assert.equal(new Set(keys.map(f => f.keys[`${kind}:gate`])).size,3,kind);
    assert.equal(new Set(await Promise.all(plans.map(p => trunkCheckKey(r.cwd,p,specOf(p),commit)))).size,3);
    assert.equal(new Set(await Promise.all(plans.map(async p => (await stateFacts(r.cwd,{...p,invariants:[specOf(p)]},commit)).invKeys.gate))).size,3);
    assert.equal(keys[0]!.keys.writes,keys[1]!.keys.writes); assert.equal(keys[0]!.keys.review,keys[2]!.keys.review);
  } finally { await r.cleanup(); }
});
