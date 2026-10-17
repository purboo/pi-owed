import test from 'node:test';
import assert from 'node:assert/strict';
import { access, cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import * as ops from '../src/ops.ts';
import * as git from '../src/git.ts';
import * as reducer from '../src/reducer.ts';
import { waiverRecordedText } from '../src/views.ts';
import { clockTime } from '../src/clock.ts';
import { Ledger } from '../src/ledger.ts';
import { parsePlan } from '../src/plan.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';
import type { CandidateFacts, Draft, Entry, ObsEntry, Plan, WaiveEntry } from '../src/types.ts';

const owner = {role:'owner',id:'pi'} as const, parent = {role:'parent',id:'test'} as const;
const at = Date.parse('2026-10-17T12:00:00Z'), obligation = 'check:stress';
const reason = `accept diagnosed merge-tree risk at ${clockTime(at,at)}`;
async function fixture() {
  const {commit:_commit,...r} = await repo();
  try {
    const mode = join(r.root,'mode'), counter = join(r.root,'counter');
    await writeFile(mode,'pass'); await writeFile(counter,'0');
    const run = `n=$(< '${counter}'); echo $((n+1)) > '${counter}'; if test "$(< '${mode}')" = fail; then echo 'owed-counts {"pass":0,"fail":1,"failed":["capacity stall"]}'; exit 1; fi; echo 'owed-counts {"pass":1,"fail":0}'`;
    const base = await commitAt(r.cwd,{impl:'base',trunk:'base'});
    await ops.init({...r,as:owner,channel:'delegated',plan:JSON.stringify({version:1,trunk:'main',lease:false,closure:[],invariants:[],nodes:[
      {id:'a',writes:['impl','unread'],checks:[{id:'stress',run,reads:['impl','trunk'],min_tests:1}],review:{count:0,min_rank:1}},
      {id:'fix',writes:['fixed'],checks:[],review:{count:0,min_rank:1}},
      {id:'fix2',writes:['other'],checks:[],review:{count:0,min_rank:1}}
    ]})});
    const slot = await ops.dispatch({...r,node:'a',as:parent});
    const commit = await commitAt(slot.worktree,{impl:'candidate'});
    await ops.submit({cwd:slot.worktree,node:'a',as:{role:'writer',id:'a#1'}});
    await ops.attest({...r,node:'a'});
    const trunk = await commitAt(r.cwd,{trunk:'changed on trunk'});
    await ops.adopt({...r,as:owner,channel:'delegated',note:'fixture trunk change in check reads'});
    await writeFile(mode,'fail');
    await assert.rejects(ops.merge({...r,node:'a',as:parent}));
    const ledger = await Ledger.open(r.cwd), state = async () => (await ops.readState(r)).state;
    const obs = async () => (await ledger.read()).filter((e):e is ObsEntry => e.kind === 'obs');
    const fail = (await obs()).findLast(e => e.subject === 'a' && e.obligation === obligation && e.merging === 'a' && e.verdict === 'fail')!;
    assert.ok(fail); assert.notEqual(fail.key,(await state()).nodes.a!.candidate!.keys[obligation]);
    const waive = (risks = [fail.seq], extra: {tracked_by?:string; reason?:string} = {}) => ops.waive({...r,node:'a',obligation,as:owner,channel:'delegated',reason,accept_risk:risks,...extra});
    return {...r,base,slot,candidateCommit:commit,trunk,ledger,mode,counter,state,obs,fail,waive};
  } catch(e) { await r.cleanup(); throw e; }
}
function mergeKey(act: Awaited<ReturnType<typeof ops.waive>>, key: string, trunk: string) {
  assert.equal(act.kind,'waive');
  assert.equal((act as WaiveEntry).key,key,'pure active merge-risk citations must record the merge key');
  assert.deepEqual(act.scope,{on:'merge',trunk});
  assert.match(waiverRecordedText(act as WaiveEntry & {scope:typeof act.scope}),new RegExp(`debt recorded on the merge key ${key.slice(0,12)} \\(merge tree of a on trunk ${trunk.slice(0,12)}\\)`));
}

test('WK1/WK3: all-active merge citations record the merge key, CLI names it, and accepted candidate merges without measurement', async () => {
  const r = await fixture();
  try {
    const before = await r.state(), candidate = before.nodes.a!.candidate!;
    assert.equal(before.nodes.a!.items.find(i => i.obligation === obligation)!.mark,'⛔');
    assert.ok(reducer.activeRisk(before,'a',obligation,r.fail.seq));
    await r.ledger.withLock(() => r.ledger.append([{kind:'obs',by:'executor:owed',subject:'a',obligation,key:r.fail.key,commit:r.fail.commit,base:r.fail.base,merging:'a',verdict:'fail',exit:1,durationMs:1}]));
    const second = (await r.obs()).at(-1)!;
    assert.ok(reducer.activeRisk(await r.state(),'a',obligation,second.seq));
    const risks = [r.fail.seq,second.seq];
    const out = await cli(r.cwd,['waive','a',obligation,'--accept-risk',risks.join(','),'--candidate',r.candidateCommit.slice(0,12),'--reason',reason]);
    assert.equal(out.code,0,out.stderr);
    assert.match(out.stdout.split('\n')[0]!,new RegExp(`debt recorded on the merge key ${r.fail.key.slice(0,12)} \\(merge tree of a on trunk ${r.trunk.slice(0,12)}\\)`));
    const act = await r.waive(risks); mergeKey(act,r.fail.key,r.trunk);
    const stored = (await r.ledger.read()).find(e => e.seq === act.seq)!;
    assert.equal(Object.hasOwn(stored,'scope'),false,'response scope never becomes a ledger field');
    const after = await r.state();
    assert.equal(after.nodes.a!.candidate!.keys[obligation],candidate.keys[obligation]);
    assert.equal(after.nodes.a!.items.find(i => i.obligation === obligation)!.status,'E','candidate is independently measured, not waived');
    assert.equal(after.nodes.a!.accepted,true);
    const count = await readFile(r.counter,'utf8'), observations = await r.obs();
    await ops.merge({...r,node:'a',as:parent});
    assert.equal(await readFile(r.counter,'utf8'),count);
    assert.deepEqual(await r.obs(),observations);
    assert.equal((await ops.verify(r)).ok,true);
  } finally { await r.cleanup(); }
});

test('WK1: a merge waiver cannot accept a distinct failing or unmeasured candidate, or an uncited block', async () => {
  const r = await fixture();
  try {
    await ops.review({...r,node:'a',as:{role:'reviewer',id:'independent'},verdict:'block',rank:1,note:'uncited independent risk'});
    const block = (await r.state()).nodes.a!.blocks.find(b => b.obligation === 'review')!;
    const act = await r.waive(); mergeKey(act,r.fail.key,r.trunk);
    assert.equal((await r.state()).nodes.a!.blocks.find(b => b.seq === block.seq)!.state,'active');
    await assert.rejects(ops.merge({...r,node:'a',as:parent}),/not (?:yet )?accepted/);
    await ops.review({...r,node:'a',as:{role:'reviewer',id:'independent'},verdict:'ok',rank:1,note:'independent risk resolved'});
    for (const mode of ['unmeasured','fail']) {
      await commitAt(r.slot.worktree,{impl:mode});
      await ops.submit({cwd:r.slot.worktree,node:'a',as:{role:'writer',id:'a#1'}});
      if (mode === 'fail') await ops.attest({...r,node:'a'});
      const s = await r.state(), item = s.nodes.a!.items.find(i => i.obligation === obligation)!;
      assert.notEqual(item.key,r.fail.key); assert.equal(item.status,'D'); assert.equal(s.nodes.a!.accepted,false);
      await assert.rejects(ops.merge({...r,node:'a',as:parent}),/not (?:yet )?accepted/);
      if (mode === 'fail') {
        const failure = (await r.obs()).findLast(e => e.subject === 'a' && e.obligation === obligation && e.merging === undefined && e.verdict === 'fail')!;
        assert.equal(s.nodes.a!.blocks.find(b => b.seq === failure.seq)!.state,'active');
      }
    }
  } finally { await r.cleanup(); }
});

test('WK1: changed merge keys are not covered, while a same-key resubmit reuses the waiver', async () => {
  const r = await fixture();
  try {
    mergeKey(await r.waive(),r.fail.key,r.trunk);
    await commitAt(r.slot.worktree,{unread:'same obligation key'});
    await ops.submit({cwd:r.slot.worktree,node:'a',as:{role:'writer',id:'a#1'}});
    await ops.attest({...r,node:'a'});
    let s = await r.state(); assert.equal(s.nodes.a!.accepted,true);
    let built = await git.buildMerge(r.cwd,r.trunk,s.nodes.a!.candidate!.commit,'fixture'); assert.ok(!('conflicts' in built));
    let facts = await git.candidateFacts(r.cwd,s.plan,s.plan.nodes[0]!,r.trunk,built.commit,1,reducer.stateQuarantine(s));
    assert.equal(facts.keys[obligation],r.fail.key); assert.deepEqual(reducer.mergeJobs(s,'a',{facts,state:await git.stateFacts(r.cwd,s.plan,built.commit)}),[]);
    const before = await readFile(r.counter,'utf8');
    await ops.merge({...r,node:'a',as:parent}); assert.equal(await readFile(r.counter,'utf8'),before);
  } finally { await r.cleanup(); }
  const changed = await fixture();
  try {
    mergeKey(await changed.waive(),changed.fail.key,changed.trunk);
    await commitAt(changed.slot.worktree,{impl:'changed candidate reads'});
    await ops.submit({cwd:changed.slot.worktree,node:'a',as:{role:'writer',id:'a#1'}});
    await writeFile(changed.mode,'pass'); await ops.attest({...changed,node:'a'});
    const s = await changed.state(), built = await git.buildMerge(changed.cwd,changed.trunk,s.nodes.a!.candidate!.commit,'fixture'); assert.ok(!('conflicts' in built));
    const facts = await git.candidateFacts(changed.cwd,s.plan,s.plan.nodes[0]!,changed.trunk,built.commit,1,reducer.stateQuarantine(s));
    assert.notEqual(facts.keys[obligation],changed.fail.key); assert.ok(reducer.mergeJobs(s,'a',{facts,state:await git.stateFacts(changed.cwd,s.plan,built.commit)}).some(j => j.obligation === obligation));
    await writeFile(changed.mode,'fail'); const before = Number(await readFile(changed.counter,'utf8'));
    await assert.rejects(ops.merge({...changed,node:'a',as:parent}));
    assert.ok(Number(await readFile(changed.counter,'utf8')) > before);
    assert.equal((await changed.state()).nodes.a!.merged,undefined);
  } finally { await changed.cleanup(); }
});

test('WK1/WK3: mixed citations retain candidate scope; exact-act and tracker retries preserve receipts', async () => {
  const r = await fixture();
  try {
    const act = await r.waive(); mergeKey(act,r.fail.key,r.trunk);
    const before = await r.ledger.read(), repeat = await r.waive();
    assert.equal(repeat.alreadyRecorded,act.seq); mergeKey(repeat,r.fail.key,r.trunk); assert.deepEqual(await r.ledger.read(),before);
    const tracked = await r.waive([r.fail.seq],{tracked_by:'fix'}); mergeKey(tracked,r.fail.key,r.trunk);
    assert.ok(tracked.seq > act.seq); assert.equal((tracked as WaiveEntry).tracked_by,'fix');
    assert.equal((await r.waive([r.fail.seq],{tracked_by:'fix'})).alreadyRecorded,tracked.seq);
    const changed = await r.waive([r.fail.seq],{tracked_by:'fix2'}); assert.ok(changed.seq > tracked.seq); mergeKey(changed,r.fail.key,r.trunk);
    await ops.attest({...r,node:'a',rerun:true});
    const candidateFail = (await r.obs()).findLast(e => e.subject === 'a' && e.obligation === obligation && !e.merging && e.verdict === 'fail')!;
    // A fresh active merge risk plus an active candidate risk retains the pre-0.28 candidate path.
    await r.ledger.withLock(() => r.ledger.append([{kind:'obs',by:'executor:owed',subject:'a',obligation,key:r.fail.key,commit:r.fail.commit,base:r.fail.base,merging:'a',verdict:'fail',exit:1,durationMs:1}]));
    const mergeFail = (await r.obs()).at(-1)!;
    const mixed = await r.waive([candidateFail.seq,mergeFail.seq]);
    assert.equal((mixed as WaiveEntry).key,(await r.state()).nodes.a!.candidate!.keys[obligation]); assert.deepEqual(mixed.scope,{on:'candidate'});
    assert.match(waiverRecordedText(mixed as WaiveEntry & {scope:typeof mixed.scope}),/debt recorded on the candidate key [a-f0-9]{12}/);
    assert.equal((await r.state()).nodes.a!.blocks.find(b => b.seq === candidateFail.seq)!.state,'cleared');
    assert.equal((await ops.verify(r)).ok,true);
  } finally { await r.cleanup(); }
});

test('WK1: stale active merge risks retain candidate fallback; CAS and inactive-risk refusals append nothing', async () => {
  const active = await fixture();
  try {
    await commitAt(active.cwd,{trunk:'moved between measurement and waiver'});
    const before = await active.ledger.read();
    await assert.rejects(active.waive(),/trunk changed \(CAS\)/);
    assert.deepEqual(await active.ledger.read(),before);
  } finally { await active.cleanup(); }
  const stale = await fixture();
  try {
    await commitAt(stale.cwd,{trunk:'new prospective merge key'});
    await ops.adopt({...stale,as:owner,channel:'delegated',note:'fixture active stale key'});
    const act = await stale.waive();
    assert.equal((act as WaiveEntry).key,(await stale.state()).nodes.a!.candidate!.keys[obligation]);
    assert.deepEqual(act.scope,{on:'candidate'});
    assert.equal((await stale.state()).nodes.a!.blocks.find(b => b.seq === stale.fail.seq)!.state,'cleared');
    await assert.rejects(ops.merge({...stale,node:'a',as:parent}));
    const current = (await stale.obs()).findLast(e => e.subject === 'a' && e.merging === 'a' && e.obligation === obligation && e.verdict === 'fail')!;
    assert.notEqual(current.key,stale.fail.key);
    mergeKey(await stale.waive([current.seq]),current.key,(await stale.state()).trunk.commit);
    const count = await readFile(stale.counter,'utf8');
    await ops.merge({...stale,node:'a',as:parent}); assert.equal(await readFile(stale.counter,'utf8'),count);
  } finally { await stale.cleanup(); }
  const conflict = await fixture();
  try {
    await commitAt(conflict.cwd,{impl:'conflicts with candidate'});
    await ops.adopt({...conflict,as:owner,channel:'delegated',note:'fixture active merge conflict'});
    const act = await conflict.waive();
    assert.equal((act as WaiveEntry).key,(await conflict.state()).nodes.a!.candidate!.keys[obligation]);
    assert.deepEqual(act.scope,{on:'candidate'});
    assert.equal((await conflict.state()).nodes.a!.blocks.find(b => b.seq === conflict.fail.seq)!.state,'cleared');
  } finally { await conflict.cleanup(); }
  const r = await fixture();
  try {
    mergeKey(await r.waive(),r.fail.key,r.trunk);
    await commitAt(r.cwd,{trunk:'new prospective merge key'});
    const before = await r.ledger.read();
    await assert.rejects(r.waive([r.fail.seq],{reason:'different act after drift'}),/trunk changed \(CAS\)/);
    assert.deepEqual(await r.ledger.read(),before);
    await ops.adopt({...r,as:owner,channel:'delegated',note:'fixture new trunk key'});
    const adopted = await r.ledger.read(); await assert.rejects(r.waive([r.fail.seq],{reason:'obsolete merge key'}),/accept_risk/); assert.deepEqual(await r.ledger.read(),adopted);
    await commitAt(r.cwd,{impl:'conflicts with candidate'});
    await ops.adopt({...r,as:owner,channel:'delegated',note:'fixture conflict'});
    const conflicted = await r.ledger.read(); await assert.rejects(r.waive([r.fail.seq],{reason:'conflicting merge'}),/accept_risk/); assert.deepEqual(await r.ledger.read(),conflicted);
  } finally { await r.cleanup(); }
});

function synthetic() {
  const plan: Plan = {version:1,trunk:'main',closure:[],invariants:[],nodes:[{id:'a',deps:[],writes:['impl'],checks:[{id:'stress',run:'true',timeout_s:10,reads:['impl']}],review:{count:0,min_rank:1}}]};
  const entries: Entry[] = [], lookup = () => plan;
  const state = () => reducer.reduce(entries,lookup);
  const add = (d: Draft) => { assert.deepEqual(reducer.validateDraft(state(),d),[]); const seq = entries.length; entries.push({...d,seq,ts:new Date(at+seq*1000).toISOString(),prev:'x',hash:`h${seq}`} as Entry); return seq; };
  add({kind:'genesis',by:'owner:pi',channel:'delegated',plan:'p',trunk:'main',commit:'trunk',state:{commit:'trunk',tree:'t',invKeys:{}}});
  add({kind:'dispatch',by:'parent:test',node:'a',attempt:1,base:'trunk',branch:'a',worktree:'a',packet:'blob',rulings_seen:-1});
  const submit = (key:string) => { const facts:CandidateFacts = {commit:`c${entries.length}`,base:'trunk',tree:'t',patch:'p',changed:['impl'],closureTouched:false,keys:{[obligation]:key,writes:'w',rulings:'r'}}; add({kind:'submit',by:'writer:a#1',node:'a',attempt:1,facts}); return facts; };
  const obs = (key:string,merging = true,verdict:'pass'|'fail' = 'fail') => { const c = state().nodes.a!.candidate!; return add({kind:'obs',by:'executor:owed',subject:'a',obligation,key,commit:merging ? `m${entries.length}` : c.commit,base:c.base,verdict,exit:verdict === 'pass' ? 0 : 1,durationMs:1,...(merging ? {merging:'a'} : {})}); };
  const waive = (key:string,risks:number[]): Extract<Draft,{kind:'waive'}> => ({kind:'waive',by:'owner:pi',channel:'delegated',node:'a',obligation,key,reason,accept_risk:risks});
  return {entries,lookup,state,add,submit,obs,waive};
}
async function frozenBaseline() {
  const dir = await mkdtemp(join(tmpdir(),'owed-wkey-base-'));
  const file = join(dir,'reducer.ts'), text = (await readFile(fileURLToPath(new URL('../src/reducer.ts',import.meta.url)),'utf8')).replace(/(['"])\.\/([^'"]+\.ts)\1/g,(_match,quote:string,path:string) => `${quote}${new URL(`../src/${path}`,import.meta.url).href}${quote}`);
  // Freeze only WK2's baseline predicate: every other validation and fold is deliberately identical.
  const start = text.indexOf('      const mergeKeyRisk = '), end = text.indexOf('\n',start);
  assert.ok(start >= 0);
  await writeFile(file,text.slice(0,start)+"      const mergeKeyRisk = d.accept_risk?.some(seq => !activeRisk(s, d.node, d.obligation, seq) && mergeRisk(s, d.node, d.obligation, seq, d.key));"+text.slice(end));
  await writeFile(join(dir,'package.json'),'{"type":"module"}');
  // Share unchanged imports so writes-dialect symbols have the same identity in both reducers.
  return {baseline:await import(pathToFileURL(file).href) as typeof reducer,cleanup:() => rm(dir,{recursive:true,force:true})};
}
async function compareEvery(entries:Entry[], lookup:(sha:string) => Plan, baseline:typeof reducer) {
  const old = baseline.reduce([],lookup), current = reducer.reduce([],lookup);
  for (const e of entries) {
    assert.deepEqual(reducer.validateDraft(current,e),baseline.validateDraft(old,e),`validation at #${e.seq}`);
    baseline.extendState(old,[e]); reducer.extendState(current,[e]);
    assert.deepEqual(current,old,`state and keys at #${e.seq}`);
    assert.deepEqual(reducer.packState(current),baseline.packState(old),`replay metadata at #${e.seq}`);
  }
  const snap = reducer.unpackState(structuredClone(reducer.packState(current)),lookup);
  assert.ok(reducer.sameReplay(snap,current),'snapshot replay identity');
}

test('WK2: restricted validation accepts the wais shape and preserves every old mixed/equal/different-key and recorded-ledger prefix', async t => {
  const base = await frozenBaseline();
  try {
    const fresh = synthetic(); fresh.submit('candidate'); fresh.obs('candidate',false,'pass'); const merge = fresh.obs('merge');
    assert.ok(reducer.validateDraft(fresh.state(),fresh.waive('unrelated',[])).length > 0);
    assert.ok(reducer.validateDraft(fresh.state(),fresh.waive('merge',[merge,999])).length > 0);
    const d = fresh.waive('merge',[merge]);
    assert.deepEqual(reducer.validateDraft(fresh.state(),d),[],'all-active distinct merge key is valid');
    assert.ok(base.baseline.validateDraft(base.baseline.reduce(fresh.entries,fresh.lookup),d).length > 0);
    fresh.add(d); assert.equal(fresh.state().nodes.a!.items.find(i => i.obligation === obligation)!.status,'E');
    // CR1: merge K on C0/J, candidate L on C1, then C2 restores K; old mixed citation is candidate-key debt.
    const mixed = synthetic(); mixed.submit('J'); mixed.obs('J',false,'pass'); const b = mixed.obs('K'); mixed.submit('L'); const a = mixed.obs('L',false); mixed.submit('K'); mixed.add(mixed.waive('K',[a,b]));
    await compareEvery(mixed.entries,mixed.lookup,base.baseline);
    const equal = synthetic(); equal.submit('K'); const eq = equal.obs('K'); equal.add(equal.waive('K',[eq])); await compareEvery(equal.entries,equal.lookup,base.baseline);
    const different = synthetic(); different.submit('J'); const x = different.obs('L'), y = different.obs('K');
    assert.ok(reducer.validateDraft(different.state(),different.waive('K',[x,y])).length > 0,'distinct merge keys cannot share a merge waiver');
    different.submit('K'); different.add(different.waive('K',[x,y])); await compareEvery(different.entries,different.lookup,base.baseline);
    const uncited = synthetic(); uncited.submit('candidate'); uncited.obs('candidate',false,'pass'); const cited = uncited.obs('merge'), retained = uncited.obs('merge');
    uncited.add(uncited.waive('merge',[cited]));
    assert.equal(uncited.state().nodes.a!.blocks.find(b => b.seq === retained)!.state,'active','same-obligation uncited risk remains binding');
    assert.equal(uncited.state().nodes.a!.accepted,false);
    const oldWais = synthetic(); oldWais.submit('candidate'); oldWais.obs('candidate',false,'pass'); const risk = oldWais.obs('merge'); oldWais.add(oldWais.waive('candidate',[risk])); await compareEvery(oldWais.entries,oldWais.lookup,base.baseline);
    const source = '/home/purboo/project/pi-things/pi-owed/.git/owed';
    let unavailable:string | undefined;
    try { await access(join(source,'ledger.jsonl')); await access(join(source,'blobs')); } catch { unavailable = 'owed repository ledger and blobs are unavailable on this test host'; }
    if (unavailable) { t.diagnostic(`SKIP recorded owed replay: ${unavailable}`); return; }
    {
      const r = await repo();
      try {
        const ledger = await Ledger.open(r.cwd);
        await cp(join(source,'ledger.jsonl'),join(ledger.dir,'ledger.jsonl')); await cp(join(source,'blobs'),join(ledger.dir,'blobs'),{recursive:true});
        const entries = await ledger.read(), plans = new Map<string,Plan>();
        for (const e of entries) if ((e.kind === 'genesis' || e.kind === 'plan') && !plans.has(e.plan)) plans.set(e.plan,parsePlan((await ledger.getBlob(e.plan)).toString()));
        assert.ok(entries.length > 0); t.diagnostic(`recorded ledger prefixes checked through #${entries.at(-1)!.seq}`);
        await compareEvery(entries,sha => { const p = plans.get(sha); assert.ok(p,`missing plan ${sha}`); return p; },base.baseline);
      } finally { await r.cleanup(); }
    }
  } finally { await base.cleanup(); }
});
