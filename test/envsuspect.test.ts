import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile, readFile } from 'node:fs/promises';
import * as ops from '../src/ops.ts';
import * as replay from '../src/reducer.ts';
import { Ledger } from '../src/ledger.ts';
import { decide, isEnvironment, type DriveOpts } from '../src/drive.ts';
import { Driver, DRIVE_PRINCIPAL } from '../src/drive-run.ts';
import { Follower, classifyLine } from '../src/drive-bg.ts';
import { Dsa } from '../src/dsa.ts';
import { parsePlan, planDowngrades } from '../src/plan.ts';
import { runJob } from '../src/exec.ts';
import { candidateFacts, stateFacts } from '../src/git.ts';
import { canonical } from '../src/canon.ts';
import type { ObsEntry, Plan, AttestJob, Entry } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const owner = { role:'owner', id:'pi' } as const, parent = { role:'parent', id:'main' } as const;
const signatures = { match:['waiting for machine budget'], unless:['AssertionError|ERR_ASSERTION'] };
const PASS = 'owed-counts {"pass":46,"fail":0}\n';
const WAIT = 'waiting for machine budget (chromium)';
const shaped = (line = WAIT) => Array.from({length:34},(_,i) => `${i === 0 ? `  \x1b[33m${line}\x1b[0m  \r` : line}\n`).join('') +
  Array.from({length:13},(_,i) => `not ok ${i + 1} - fixture ${i + 1}\n  ---\n  error: 'fixture timeout'\n  ...\n`).join('') +
  `owed-counts ${JSON.stringify({pass:29,fail:13,skip:4,failed:Array.from({length:13},(_,i) => `fixture ${i + 1}`)})}\n`;
const rawPlan = () => ({version:1,trunk:'main',lease:false,closure:[],drive:{min_free_mb:0},invariants:[],nodes:[{id:'a',writes:['src/'],checks:[{id:'x',run:'false',reads:['src/**'],min_tests:1}]}]});

class SealedDsa extends Dsa {
  override async inspect(rid: string) { return {view:{rid,state:'sealed' as const,status:'ok'}}; }
  override async send() { return {outcome:'applied' as const,spec_digest:'fixture'}; }
}
async function fixture(outputs: string[], env: unknown = signatures) {
  const r = await repo();
  await r.put('src/a','base'); const base = await r.commit();
  const counter = join(r.root,'counter');
  for (const [i,text] of outputs.entries()) await writeFile(join(r.root,`stage${i + 1}`),text);
  const run = `n=$(cat '${counter}' 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > '${counter}'; cat '${r.root}/stage'"$n"; exit 1`;
  // PASS stages need an exit-zero command; error stages deliberately cannot execute a check.
  const command = run.replace('exit 1',`case "$n" in ${outputs.flatMap((v,i) => v === PASS ? [i+1] : []).join('|') || '999'}) exit 0;; esac; grep -q COMMAND_ERROR '${r.root}/stage'"$n" && exit 127; exit 1`);
  const raw = rawPlan(); raw.nodes[0]!.checks[0]!.run = command;
  const text = JSON.stringify({...raw,...(env !== null ? {env_signatures:env} : {})});
  await ops.init({cwd:r.cwd,plan:text,as:owner,channel:'delegated'});
  const ledger = await Ledger.open(r.cwd), d = await ops.dispatch({cwd:r.cwd,node:'a',as:parent});
  await commitAt(d.worktree,{'src/a':'candidate'});
  await ops.submit({cwd:d.worktree,node:'a',as:{role:'writer',id:'a#1'}});
  const state = async () => (await ops.readState({cwd:r.cwd})).state;
  const s = await state(), rid = replay.runId(replay.projectId(s),'a',1,'writer');
  await ops.launch({cwd:r.cwd,as:DRIVE_PRINCIPAL,node:'a',attempt:1,role:'writer',rid,spec:'{}',labels:replay.runLabels(replay.projectId(s),'a',1,'writer')});
  const obs = async () => (await ledger.read()).filter((e): e is ObsEntry => e.kind === 'obs' && e.obligation === 'check:x');
  const actions = async (extra: Partial<DriveOpts> = {}) => {
    const s = await state();
    return decide(s,s.plan,new Map([[rid,{rid,state:'sealed',status:'ok'}]]),{max:1,repairs:2,project:replay.projectId(s),root:r.cwd,applied:new Set((await ledger.read()).flatMap(e => e.kind === 'send' ? [e.send] : [])),rejected:new Map(),...extra});
  };
  const lookup = async () => {
    const entries = await ledger.read(), plans = new Map<string,Plan>();
    for (const e of entries) if (e.kind === 'plan' || e.kind === 'genesis') plans.set(e.plan,parsePlan((await ledger.getBlob(e.plan)).toString()));
    return {entries,look:(sha:string) => plans.get(sha)!};
  };
  return {...r,base,ledger,state,obs,actions,lookup,rid};
}

// EV1 validates only optional top-level routing metadata and leaves normalized legacy plans intact.
test('EV1: bounded JS regex lists, strict keys, canonical reparse and no downgrade', () => {
  const old = parsePlan(JSON.stringify(rawPlan()));
  const plan = parsePlan(JSON.stringify({...rawPlan(),env_signatures:signatures}));
  assert.deepEqual(plan.env_signatures,signatures);
  assert.deepEqual(parsePlan(JSON.stringify(plan)),plan);
  assert.deepEqual(planDowngrades(old,plan),[]);
  assert.deepEqual(planDowngrades(plan,old),[]);
  const changed = parsePlan(JSON.stringify({...rawPlan(),env_signatures:{match:['other'],unless:[]}}));
  assert.deepEqual(planDowngrades(plan,changed),[]);
  const {env_signatures:_env,...rest} = plan;
  assert.equal(canonical(rest),canonical(old));
  assert.ok(!Object.hasOwn(old,'env_signatures'));
  assert.deepEqual(parsePlan(JSON.stringify({...rawPlan(),env_signatures:{match:['x'.repeat(300)]}})).env_signatures,{match:['x'.repeat(300)]});
  for (const env of [null,[],{}, {match:[]}, {match:'x'}, {match:['']}, {match:[' ']}, {match:[42]}, {match:['[']}, {match:['x'.repeat(301)]}, {match:['x'],unless:['[']}, {match:['x'],unless:null}, {match:['x'],extra:true}]) {
    assert.throws(() => parsePlan(JSON.stringify({...rawPlan(),env_signatures:env})),/env_signatures/,JSON.stringify(env));
  }
});

test('EV2/EV3 red: #19014-shaped failure stays fail and next action is same-key attribution, not repair', {timeout:180_000}, async () => {
  const output = shaped(), r = await fixture([output,PASS]);
  try {
    await ops.attest({cwd:r.cwd,node:'a'});
    const f = (await r.obs())[0]!;
    assert.equal(f.verdict,'fail'); assert.equal(f.exit,1);
    assert.deepEqual(f.counts,{format:'owed',tests:46,pass:29,fail:13,skip:4,failed:Array.from({length:13},(_,i) => `fixture ${i+1}`)});
    assert.equal(f.failed!.length,13); assert.equal(Object.keys(f.signatures!).length,13);
    assert.equal(f.infra,undefined); assert.equal(isEnvironment(f),false);
    assert.ok(f.note!.startsWith(`environment-suspect: ${WAIT}; `),f.note);
    assert.equal((await r.ledger.getBlob(f.log!)).toString(),output);
    const acts = await r.actions(), notices = acts.filter(a => a.do === 'notify');
    assert.equal(acts.find(a => a.do !== 'notify')?.do,'attest');
    assert.equal(acts.some(a => a.do === 'send'),false);
    assert.equal(notices.length,1); const notice = notices[0]!; assert.ok(notice.do === 'notify');
    assert.equal(notice.need,null);
    assert.equal(notice.text,`a: check x failed #${f.seq} with an environment signature (${WAIT}); measuring again on the same key before asking the writer`);
    assert.equal(classifyLine(JSON.stringify({...notice,outcome:'answered'})).kind,'quiet','no parent wake');
    const again = await r.actions({noticed:new Set([notice.once!])});
    assert.deepEqual(again,[{do:'attest',node:'a'}]);
    const j = replay.attestJobs(await r.state(),'a')[0]!;
    assert.equal(j.attribution,true); assert.deepEqual([j.key,j.commit,j.base],[f.key,f.commit,f.base]);
    const unmarkedPlan = structuredClone((await r.state()).plan); delete unmarkedPlan.env_signatures;
    // Exact same executor result apart from the note prefix (duration is runtime, not verdict evidence).
    const unmarked = await runJob({cwd:r.cwd,ledger:r.ledger,plan:{...unmarkedPlan,nodes:unmarkedPlan.nodes.map(n => ({...n,checks:n.checks.map(c => ({...c,run:`cat '${join(r.root,'stage1')}'; exit 1`}))}))}}, {...j,attribution:false,spec:{...j.spec!,run:`cat '${join(r.root,'stage1')}'; exit 1`}});
    for (const key of ['verdict','exit','counts','failed','signatures','execution','log','key','commit','base'] as const) assert.deepEqual(f[key],unmarked[key],key);
    assert.equal(f.note,`environment-suspect: ${WAIT}; ${unmarked.note}`);
    assert.equal(await readFile(join(r.root,'counter'),'utf8'),'1\n');
  } finally { await r.cleanup(); }
});

test('EV3: suspect twice halts, sends no repair, uses no budget; restart and resume route ordinarily', {timeout:180_000}, async () => {
  const r = await fixture([shaped(),shaped()]);
  try {
    await ops.attest({cwd:r.cwd,node:'a'});
    const lines:string[] = [], driver = new Driver({cwd:r.cwd,json:true,log:l => lines.push(l),handleSignals:false,session:null,dsa:new SealedDsa({bin:'/no-envsuspect-dsa'}),max:1});
    try {
      await driver.pass(); assert.equal(await driver.drain(60_000),true); await driver.reap();
      await driver.pass(); await driver.pass();
      const [f,a] = await r.obs(); assert.ok(f && a);
      assert.deepEqual([a.key,a.commit,a.base],[f.key,f.commit,f.base]); assert.equal(a.attribution,true);
      const expected = `a: check x failed twice with an environment signature (#${f.seq}, #${a.seq}: ${WAIT}); the writer is not asked to repair. Fix the environment, then owed attest a --rerun and owed resume a; if it is a real failure: owed decide a --writer --text "<repair instruction>"`;
      const s = await r.state(); assert.equal(s.nodes.a!.halt!.reason,expected);
      assert.equal(s.nodes.a!.blocks[0]!.state,'cleared'); assert.equal(s.nodes.a!.accepted,false);
      assert.equal((await r.ledger.read()).some(e => e.kind === 'send' && e.reason === 'repair'),false);
      assert.equal(s.nodes.a!.runs[0]!.sends.filter(e => e.reason === 'repair').length,0);
      const notices = lines.map(l => JSON.parse(l)).filter(j => j.do === 'notify' && j.text?.includes('measuring again on the same key before asking the writer'));
      assert.equal(notices.length,1); assert.equal(notices[0]!.outcome,'answered');
      assert.equal(classifyLine(JSON.stringify(notices[0])).kind,'quiet');
      // R-030-EV-2/3: summaries show the suspect halt and resume; why --full retains all remedies.
      const halted = lines.map(l => JSON.parse(l)).find(j => j.do === 'halt' && j.outcome === 'halted');
      assert.ok(halted); assert.equal(halted.detail,expected);
      assert.equal(halted.need.kind,'resume'); assert.equal(halted.need.halted,true);
      assert.match(halted.need.text,/failed twice with an environment signature/);
      assert.equal(halted.need.command,'owed resume a');
      const log=join(r.root,'envsuspect-follow.jsonl'), delivered:string[]=[];
      await writeFile(log,`${lines.join('\n')}\n`);
      const follower=new Follower({log,repo:r.cwd,pid:process.pid,from:0,deliver:text => delivered.push(text)});
      try {
        const message=follower.tick(); assert.ok(message); assert.deepEqual(delivered,[message]);
        assert.match(message,/Needs you: a — driver halted: .*failed twice with an environment signature/);
        assert.ok(message.includes('owed resume a'));
        assert.ok(!message.includes('owed attest a --rerun')); assert.ok(!message.includes('owed decide a --writer'));
      } finally { follower.stop(); }
      const full=await cli(r.cwd,['why','a','--full']); assert.equal(full.code,0,full.stderr);
      assert.ok(full.stdout.includes(expected),full.stdout);
      for (const command of ['owed attest a --rerun','owed resume a','owed decide a --writer --text "<repair instruction>"']) assert.ok(full.stdout.includes(command),full.stdout);
      assert.deepEqual(await r.actions(),[],'a restarted driver respects the ledger halt');
      const {entries,look} = await r.lookup(); assert.ok(replay.sameReplay(s,replay.reduce(entries,look)));
      for (let split=1;split<entries.length;split++) assert.ok(replay.sameReplay(s,replay.reduceFrom(replay.reduce(entries.slice(0,split),look),entries.slice(split),look)));
      await ops.resume({cwd:r.cwd,node:'a',as:parent});
      assert.equal((await r.actions()).find(a => a.do === 'send' && a.reason === 'repair')?.do,'send');
      assert.equal((await r.obs()).length,2);
      assert.equal((await ops.verify({cwd:r.cwd})).ok,true);
    } finally { driver.stopping = true; await driver.settle(); }
  } finally { await r.cleanup(); }
});

test('EV3 review #3549: effective owner waiver after suspect halt allows automatic merge without resume', {timeout:180_000}, async () => {
  const r=await fixture([shaped(),shaped(),PASS]);
  try {
    await ops.attest({cwd:r.cwd,node:'a'}); await ops.attest({cwd:r.cwd,node:'a'});
    const before=await r.state(), stopped=(await r.actions()).find(a => a.do === 'halt');
    assert.ok(stopped && stopped.do === 'halt'); assert.match(stopped.reason,/failed twice with an environment signature/);
    assert.equal(before.nodes.a!.accepted,false); assert.equal(before.nodes.a!.blocks[0]!.state,'cleared');
    await ops.halt({cwd:r.cwd,node:'a',attempt:1,as:DRIVE_PRINCIPAL,reason:stopped.reason,needs:stopped.needs});
    await ops.waive({cwd:r.cwd,node:'a',obligation:'check:x',as:owner,channel:'delegated',reason:'Accept this exact candidate failure after inspecting both environment-suspect measurements.'});
    const waived=await r.state();
    assert.equal(waived.nodes.a!.items.find(i => i.obligation === 'check:x')!.status,'W');
    assert.equal(waived.nodes.a!.accepted,true); assert.equal(replay.halted(waived,'a'),undefined);
    assert.deepEqual(await r.actions(),[{do:'merge',node:'a'}],'a satisfied check must not resurrect its historical suspect halt');
    const driver=new Driver({cwd:r.cwd,json:true,log:()=>{},handleSignals:false,session:null,dsa:new SealedDsa({bin:'/no-envsuspect-dsa'}),max:1});
    try {
      await driver.pass(); assert.equal(await driver.drain(60_000),true); await driver.reap(); await driver.pass();
      const merged=await r.state(); assert.ok(merged.nodes.a!.merged,'the automatic driver actually merges without another resume');
      const entries=await r.ledger.read();
      assert.equal(entries.filter(e => e.kind === 'halt').length,1);
      assert.equal(entries.some(e => e.kind === 'resume' || (e.kind === 'send' && e.reason === 'repair')),false);
      assert.equal((await r.obs())[0]!.verdict,'fail'); assert.equal((await r.obs())[1]!.verdict,'fail');
      assert.equal((await ops.verify({cwd:r.cwd})).ok,true);
    } finally { driver.stopping=true; await driver.settle(); }
  } finally { await r.cleanup(); }
});

test('EV3 review #3549: waiver suppresses only its current-key suspicion while another check remains blocking', {timeout:180_000}, async () => {
  const r=await fixture([shaped(),shaped()]);
  try {
    const plan=structuredClone((await r.state()).plan);
    plan.nodes[0]!.checks.push({id:'other',run:'echo ordinary failure; exit 1',timeout_s:30,reads:['src/**']});
    await ops.planSet({cwd:r.cwd,plan:JSON.stringify(plan),as:parent});
    await ops.attest({cwd:r.cwd,node:'a'});
    const first=(await r.obs())[0]!;
    await ops.waive({cwd:r.cwd,node:'a',obligation:'check:x',as:owner,channel:'delegated',accept_risk:[first.seq],reason:'Accept the pending current-key suspect failure, not the independent ordinary failure.'});
    const s=await r.state(); assert.equal(s.nodes.a!.accepted,false);
    assert.equal(s.nodes.a!.items.find(i => i.obligation === 'check:x')!.status,'W');
    const actions=await r.actions();
    assert.ok(!actions.some(a => a.do === 'attest' || a.do === 'halt' || (a.do === 'notify' && a.text.includes('environment signature'))));
    assert.ok(actions.some(a => a.do === 'send' && a.reason === 'repair'),'the ordinary unwaived failure still needs repair');
    assert.equal((await r.obs()).length,1,'the waived active block is not attributed');
  } finally { await r.cleanup(); }
});

test('EV3 review #3549: a waiver on an old key never suppresses new unwaived suspect failures', {timeout:180_000}, async () => {
  const r=await fixture([shaped(),shaped(),shaped(),shaped()]);
  try {
    await ops.attest({cwd:r.cwd,node:'a'}); await ops.attest({cwd:r.cwd,node:'a'});
    const halt=(await r.actions()).find(a => a.do === 'halt'); assert.ok(halt && halt.do === 'halt');
    await ops.halt({cwd:r.cwd,node:'a',attempt:1,as:DRIVE_PRINCIPAL,reason:halt.reason,needs:halt.needs});
    await ops.waive({cwd:r.cwd,node:'a',obligation:'check:x',as:owner,channel:'delegated',reason:'Accept only the old candidate failure.'});
    const old=await r.state(), slot=old.nodes.a!.slot!, oldKey=old.nodes.a!.candidate!.keys['check:x'];
    await commitAt(slot.worktree,{'src/a':'a different unwaived candidate'});
    await ops.submit({cwd:slot.worktree,node:'a',as:{role:'writer',id:'a#1'}});
    const changed=await r.state(); assert.notEqual(changed.nodes.a!.candidate!.keys['check:x'],oldKey);
    assert.equal(changed.nodes.a!.accepted,false); assert.ok((await r.actions()).some(a => a.do === 'attest'));
    await ops.attest({cwd:r.cwd,node:'a'});
    assert.ok((await r.actions()).some(a => a.do === 'attest'),'new-key suspicion still needs attribution');
    await ops.attest({cwd:r.cwd,node:'a'});
    const [,,f,a]=await r.obs(); assert.ok(f && a);
    const again=(await r.actions()).find(a => a.do === 'halt'); assert.ok(again && again.do === 'halt');
    assert.ok(again.reason.includes(`(#${f.seq}, #${a.seq}: ${WAIT})`));
    assert.equal((await r.ledger.read()).some(e => e.kind === 'send' && e.reason === 'repair'),false);
  } finally { await r.cleanup(); }
});

test('EV3: attribution pass leaves flaky owner need and retains the original failure', {timeout:180_000}, async () => {
  const r = await fixture([shaped(),PASS]);
  try {
    await ops.attest({cwd:r.cwd,node:'a'}); await ops.attest({cwd:r.cwd,node:'a'});
    const [f,a] = await r.obs(); assert.ok(f && a); assert.equal(a.attribution,true); assert.equal(a.verdict,'pass');
    const n = (await r.state()).nodes.a!;
    assert.equal(n.accepted,false); assert.equal(n.blocks[0]!.state,'flaky');
    assert.equal(n.items.find(i => i.obligation === 'check:x')!.mark,'⊤'); assert.equal(a.infra,undefined);
    const acts = await r.actions(); assert.equal(acts.some(a => a.do === 'send'),false);
    assert.ok(acts.some(a => a.do === 'notify' && /waive|owner|failure/.test(a.text)));
    assert.equal((await r.obs())[0]!.verdict,'fail');
    assert.equal((await ops.verify({cwd:r.cwd})).ok,true);
  } finally { await r.cleanup(); }
});

test('EV2/EV3: unless anywhere in the retained log and absent config keep ordinary repair', {timeout:180_000}, async () => {
  for (const [output,env] of [[`ERR_ASSERTION\n${shaped()}`,signatures],[`${shaped()}AssertionError\n`,signatures],[shaped(),undefined]] as const) {
    const r = await fixture([output],env === undefined ? null : env);
    try {
      await ops.attest({cwd:r.cwd,node:'a'});
      const f = (await r.obs())[0]!; assert.equal(f.verdict,'fail'); assert.ok(!f.note?.startsWith('environment-suspect:'));
      assert.ok((await r.actions()).some(a => a.do === 'send' && a.reason === 'repair'));
    } finally { await r.cleanup(); }
  }
});

test('EV3: non-suspect attribution failure repairs; error keeps the block and uses existing retry/halt rules', {timeout:180_000}, async () => {
  for (const second of ['owed-counts {"pass":29,"fail":13,"failed":["real assertion"]}\n','COMMAND_ERROR\n']) {
    const r = await fixture([shaped(),second,second]);
    try {
      await ops.attest({cwd:r.cwd,node:'a'}); await ops.attest({cwd:r.cwd,node:'a'});
      const a=(await r.obs())[1]!;
      assert.ok(!a.note?.startsWith('environment-suspect:'));
      if (second.includes('COMMAND_ERROR')) {
        assert.equal(a.verdict,'error'); assert.equal((await r.state()).nodes.a!.blocks[0]!.state,'active');
        assert.ok((await r.actions()).some(a => a.do === 'attest'));
        await ops.attest({cwd:r.cwd,node:'a'});
        assert.ok((await r.actions()).some(a => a.do === 'halt' && /no verdict twice/.test(a.reason)));
      } else assert.ok((await r.actions()).some(a => a.do === 'send' && a.reason === 'repair'));
    } finally { await r.cleanup(); }
  }
});

test('EV2/EV3 R-030-EV-1: semicolons are display-normalized; matching scans lines after CSI/CR removal', {timeout:180_000}, async () => {
  const line = `${WAIT}; still; waiting`, output = shaped(line), r = await fixture([output,output],{match:['^  waiting for machine budget.*  $'],unless:[]});
  try {
    await ops.attest({cwd:r.cwd,node:'a'});
    const f=(await r.obs())[0]!, excerpt=line.replace(/;/g,',');
    assert.ok(f.note?.startsWith(`environment-suspect: ${excerpt}; `));
    assert.equal((await r.ledger.getBlob(f.log!)).toString(),output);
    assert.ok((await r.actions()).some(a => a.do === 'notify' && a.text.includes(`(${excerpt})`)));
    await ops.attest({cwd:r.cwd,node:'a'});
    assert.ok((await r.actions()).some(a => a.do === 'halt' && a.reason.includes(`: ${excerpt});`)));
  } finally { await r.cleanup(); }
  // Without flags, ^/$ match individual lines, never span their newline boundaries.
  const split=await fixture([`${WAIT}\nseparate line\n${shaped()}`],{match:['machine budget.*separate line']});
  try {
    await ops.attest({cwd:split.cwd,node:'a'});
    assert.ok(!(await split.obs())[0]!.note?.startsWith('environment-suspect:'));
  } finally { await split.cleanup(); }
});

test('EV3: any pending suspect check blocks whole-node repair despite another ordinary failure', {timeout:180_000}, async () => {
  const r=await fixture([shaped(),shaped()]);
  try {
    const plan=structuredClone((await r.state()).plan);
    plan.nodes[0]!.checks.push({id:'other',run:'echo ordinary failure; exit 1',timeout_s:30,reads:['src/**']});
    await ops.planSet({cwd:r.cwd,plan:JSON.stringify(plan),as:parent});
    await ops.attest({cwd:r.cwd,node:'a'});
    const acts=await r.actions(); assert.ok(acts.some(a => a.do === 'attest')); assert.ok(!acts.some(a => a.do === 'send' && a.reason === 'repair'));
    await ops.attest({cwd:r.cwd,node:'a'});
    const stopped=await r.actions(); assert.ok(stopped.some(a => a.do === 'halt' && /failed twice with an environment signature/.test(a.reason)));
    assert.ok(!stopped.some(a => a.do === 'send' && a.reason === 'repair'));
    assert.equal((await r.ledger.read()).some(e => e.kind === 'send' && e.reason === 'repair'),false);
  } finally { await r.cleanup(); }
});

test('EV3: a changed key and a superseded check never inherit an old suspect halt', {timeout:180_000}, async () => {
  const changed=await fixture([shaped(),shaped(),PASS]);
  try {
    await ops.attest({cwd:changed.cwd,node:'a'}); await ops.attest({cwd:changed.cwd,node:'a'});
    const before=await changed.state(), slot=before.nodes.a!.slot!, oldKey=before.nodes.a!.candidate!.keys['check:x'];
    await commitAt(slot.worktree,{'src/a':'new contents'}); await ops.submit({cwd:slot.worktree,node:'a',as:{role:'writer',id:'a#1'}});
    const s=await changed.state(); assert.notEqual(s.nodes.a!.candidate!.keys['check:x'],oldKey);
    assert.ok((await changed.actions()).some(a => a.do === 'attest'));
    await ops.attest({cwd:changed.cwd,node:'a'});
    assert.ok(!(await changed.actions()).some(a => a.do === 'halt' && /environment signature/.test(a.reason)));
  } finally { await changed.cleanup(); }
  const superseded=await fixture([shaped()]);
  try {
    await ops.attest({cwd:superseded.cwd,node:'a'});
    const s=await superseded.state(), plan=structuredClone(s.plan); plan.nodes[0]!.checks[0]!.run='echo new check; exit 1';
    await ops.planSet({cwd:superseded.cwd,plan:JSON.stringify(plan),as:owner,channel:'delegated',note:'Replace the command solely to exercise superseded-block routing in this test fixture.'});
    const next=await superseded.state(); assert.equal(next.nodes.a!.blocks[0]!.state,'superseded');
    assert.ok((await superseded.actions()).some(a => a.do === 'attest'));
  } finally { await superseded.cleanup(); }
});

test('EV1: adding, changing and removing signatures changes no keys, candidate or existing block; attribution uses failure plan', {timeout:180_000}, async () => {
  const r = await fixture([shaped(),shaped()],{match:['never matches']});
  try {
    await ops.attest({cwd:r.cwd,node:'a'});
    const before=await r.state(), original=before.plan, f=(await r.obs())[0]!;
    for (const env of [signatures,{match:['other']},undefined]) {
      const next=structuredClone(original); if (env) next.env_signatures=env; else delete next.env_signatures;
      const c=before.nodes.a!.candidate!, spec=next.nodes[0]!.checks[0]!;
      assert.deepEqual((await candidateFacts(r.cwd,next,next.nodes[0]!,c.base,c.commit,1)).keys,c.keys);
      const node = {...next.nodes[0]!,checks:[{...spec,red:true,tests:['src/**'],mutants:['patch/**']}]};
      assert.deepEqual((await candidateFacts(r.cwd,next,node,c.base,c.commit,1)).keys,(await candidateFacts(r.cwd,original,node,c.base,c.commit,1)).keys);
      assert.deepEqual(await stateFacts(r.cwd,{...next,invariants:[spec]},c.base),await stateFacts(r.cwd,{...original,invariants:[spec]},c.base));
      await ops.planSet({cwd:r.cwd,plan:JSON.stringify(next),as:parent});
      const s=await r.state(); assert.deepEqual(s.nodes.a!.candidate,c); assert.deepEqual(s.nodes.a!.blocks,before.nodes.a!.blocks);
      assert.ok((await r.actions()).some(a => a.do === 'send' && a.reason === 'repair'),'old failure is not retroactively suspect');
    }
    await ops.planSet({cwd:r.cwd,plan:JSON.stringify({...original,env_signatures:signatures}),as:parent});
    await ops.attest({cwd:r.cwd,node:'a'});
    const a=(await r.obs())[1]!; assert.equal(a.attribution,true); assert.equal(a.key,f.key); assert.ok(!a.note?.startsWith('environment-suspect:'),'failure plan, not the latest signatures');
    assert.equal((await ops.verify({cwd:r.cwd})).ok,true);
  } finally { await r.cleanup(); }
});

test('EV2: first matching line is trimmed and bounded; red, mutants, repeat, invariant, probe, pass and error are not marked', {timeout:180_000}, async () => {
  const r=await fixture([shaped(`${WAIT} ${'x'.repeat(200)}`)]);
  try {
    const s=await r.state(), plan=s.plan, c=s.nodes.a!.candidate!, spec=plan.nodes[0]!.checks[0]!;
    const j:AttestJob={kind:'check',subject:'a',obligation:'check:x',key:c.keys['check:x']!,spec,commit:c.commit,base:c.base};
    const first=await runJob({cwd:r.cwd,ledger:r.ledger,plan},j);
    assert.ok(first.note!.startsWith(`environment-suspect: ${`${WAIT} ${'x'.repeat(200)}`.slice(0,160)}; `));
    const run=`cat '${join(r.root,'stage1')}'; exit 1`, ordinary={...spec,run};
    // R-030-EV-1: ordinary candidate checks participate even when they also have counterfactuals.
    for (const extra of [{red:true,tests:[]},{mutants:['patch/**']}]) {
      const o=await runJob({cwd:r.cwd,ledger:r.ledger,plan},{...j,spec:{...ordinary,...extra}});
      assert.equal(o.verdict,'fail'); assert.ok(o.note?.startsWith('environment-suspect:'));
    }
    const cases:AttestJob[]=[
      {...j,kind:'red',obligation:'red:x',spec:{...ordinary,red:true,tests:[]}},
      {...j,kind:'strength',obligation:'strength:x',spec:{...ordinary,mutants:[]}},
      {...j,spec:{...ordinary,repeat:{runs:1,need:1}}},
      {...j,kind:'inv',subject:'trunk',obligation:'inv:x',spec:ordinary},
      {...j,probe:'trunk',spec:ordinary},
      {...j,spec:{...ordinary,run:`printf '${WAIT}\n${PASS}'; exit 0`}},
      {...j,spec:{...ordinary,run:`echo '${WAIT}'; exit 127`}},
    ];
    for(const job of cases) {
      const o=await runJob({cwd:r.cwd,ledger:r.ledger,plan},job);
      assert.ok(!o.note?.startsWith('environment-suspect:'),JSON.stringify(job));
    }
    const {entries,look}=await r.lookup();
    const legacy=entries.map(e => ({...e})) as Entry[], full=replay.reduce(legacy,look);
    for(let split=1;split<legacy.length;split++) assert.ok(replay.sameReplay(full,replay.reduceFrom(replay.reduce(legacy.slice(0,split),look),legacy.slice(split),look)));
  } finally { await r.cleanup(); }
});
