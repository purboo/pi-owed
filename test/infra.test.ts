import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { writeFile } from 'node:fs/promises';
import * as ops from '../src/ops.ts';
import * as replay from '../src/reducer.ts';
import { Ledger } from '../src/ledger.ts';
import { Driver, DRIVE_PRINCIPAL } from '../src/drive-run.ts';
import { decide } from '../src/drive.ts';
import { Follower } from '../src/drive-bg.ts';
import { Dsa } from '../src/dsa.ts';
import { parsePlan } from '../src/plan.ts';
import { clockTime } from '../src/clock.ts';
import { renderWhy } from '../src/views.ts';
import type { Entry, ObsEntry, Draft } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { commitAt, cli } from './helpers/surface.ts';

const owner = { role:'owner', id:'pi' } as const, parent = { role:'parent', id:'main' } as const;
class SealedDsa extends Dsa { override async inspect(rid: string) { return { view:{ rid, state:'sealed' as const, status:'ok' } }; } }
const PASS = 'ok 1 - measured\n1..1\n# tests 1\n# pass 1\n# fail 0\n';
const NAMED = "not ok 1 - regression\n  ---\n  error: 'broken behaviour'\n  ...\n1..1\n# tests 1\n# pass 0\n# fail 1\n";
async function fixture(schedule: string[], options: { checks?:boolean; nodes?:string[]; min?:number; repeat?:object; needles?:string[]; counted?:boolean } = {}) {
  const r = await repo();
  await r.put('README','base'); await r.commit();
  const counter = join(r.root,'counter'), stages = join(r.root,'stages');
  await writeFile(stages,schedule.join('\n') + '\n');
  await writeFile(join(r.root,'pass.tap'),PASS); await writeFile(join(r.root,'named.tap'),NAMED);
  const run = `n=$(cat '${counter}' 2>/dev/null || echo 0); n=$((n+1)); echo "$n" > '${counter}'; mode=$(sed -n "\${n}p" '${stages}'); case "$mode" in setup) printf 'Error: Cannot find /tmp/tree-%s/pkg-%s module abcdef%s at 2026-10-16T10:00:0%sZ\\n' "$n" "$n" "$n" "$n"; exit 1;; zero) printf 'Error: ENOENT /tmp/tree-987/pkg-654\\n1..0\\n# tests 0\\n# fail 0\\n'; exit 1;; named) cat '${join(r.root,'named.tap')}'; exit 1;; timeout) sleep 3;; error) echo 'Cannot find command'; exit 127;; uncounted) echo done;; *) cat '${join(r.root,'pass.tap')}';; esac`;
  const spec = { id:'x', run, timeout_s:1, reads:['src/**'], ...(options.counted === false ? {} : { min_tests:options.min ?? 1 }), ...(options.repeat ? { repeat:options.repeat } : {}), ...(options.needles ? { remeasure_on:options.needles } : {}) };
  const ids = options.nodes ?? ['a'];
  const plan = { version:1, trunk:'main', lease:false, closure:[], drive:{ min_free_mb:0 }, invariants:options.checks ? [] : [spec], nodes:ids.map(id => ({ id, writes:[`src/${id}`], ...(options.checks ? { checks:[spec] } : {}) })) };
  await ops.init({ cwd:r.cwd, plan:JSON.stringify(plan), as:owner, channel:'delegated' });
  const ledger = await Ledger.open(r.cwd);
  const state = async () => (await ops.readState({ cwd:r.cwd })).state;
  const obs = async () => (await ledger.read()).filter((e): e is ObsEntry => e.kind === 'obs' && e.obligation === `${options.checks ? 'check' : 'inv'}:x`);
  const submit = async (id = 'a') => {
    const d = await ops.dispatch({ cwd:r.cwd, node:id, as:parent });
    await commitAt(d.worktree,{ [`src/${id}`]:id });
    await ops.submit({ cwd:d.worktree, node:id, as:{ role:'writer', id:`${id}#1` } });
    return d;
  };
  const accept = async (id = 'a') => { const d = await submit(id); assert.equal((await ops.attest({ cwd:r.cwd,node:id })).accepted,true); return d; };
  const driver = async (id = 'a') => {
    const s = await state(), rid = replay.runId(replay.projectId(s),id,1,'writer');
    await ops.launch({ cwd:r.cwd, as:DRIVE_PRINCIPAL, node:id, attempt:1, role:'writer', rid, spec:'{}', labels:replay.runLabels(replay.projectId(s),id,1,'writer') });
    const lines:string[] = [], d = new Driver({ cwd:r.cwd, json:true, log:l => lines.push(l), handleSignals:false, session:null, dsa:new SealedDsa({ bin:'/no-infra-dsa' }), max:1 });
    const pass = async () => { await d.pass(); assert.equal(await d.drain(60_000),true); await d.reap(); };
    return { d, lines, pass };
  };
  const lookup = async () => {
    const entries = await ledger.read(), plans = new Map<string,ReturnType<typeof parsePlan>>();
    for (const e of entries) if (e.kind === 'genesis' || e.kind === 'plan') plans.set(e.plan,parsePlan((await ledger.getBlob(e.plan)).toString()));
    return { entries, look:(sha:string) => plans.get(sha)! };
  };
  return { ...r, ledger, state, obs, submit, accept, driver, lookup };
}
async function refused(p:Promise<unknown>):Promise<Error> { try { await p; } catch(e) { return e as Error; } assert.fail('expected refusal'); }
async function resolvedInvariant(r:Awaited<ReturnType<typeof fixture>>) {
  const votes = (await r.obs()).filter(e => e.merging === 'a');
  assert.equal(votes.length,2);
  assert.deepEqual(votes.map(e => [e.verdict,e.auto_remeasure,e.infra]),[['fail',undefined,undefined],['pass',true,votes[0]!.seq]]);
  assert.equal(votes[0]!.key,votes[1]!.key);
  assert.equal((await r.state()).invariants[0]!.status,'E');
  assert.equal((await ops.verify({ cwd:r.cwd })).ok,true);
}

test('IF1/IF2: setup → default automatic same-key counted pass merges without conflict, waiver or debt; full why and metrics retain infra', { timeout:180_000 }, async () => {
  const r = await fixture(['pass','setup','pass']);
  try {
    await r.accept(); await ops.merge({ cwd:r.cwd,node:'a',as:parent }); await resolvedInvariant(r);
    const entries = await r.ledger.read(); assert.ok(!entries.some(e => ['waive','defer','halt'].includes(e.kind)));
    const report = await ops.report({ cwd:r.cwd }); assert.equal(report.downgrades.length,0);
    const metrics = await cli(r.cwd,['report','--metrics','--json']); assert.equal(metrics.code,0,metrics.stderr);
    assert.deepEqual(JSON.parse(metrics.stdout).infra,{ total:1,byObligation:{ 'inv:x':1 } });
    const text = await cli(r.cwd,['report','--metrics']); assert.match(text.stdout,/Infra: 1; by obligation: inv:x 1/);
    assert.match(renderWhy(await ops.why({ cwd:r.cwd,node:'inv:x' }),{ full:true }),/#\d+ infra/);
  } finally { await r.cleanup(); }
});

test('IF1/IF3/IF5: deterministic setup failure consumes one retry, halts rather than rebase, and reaches the follower Needs-you line', { timeout:180_000 }, async () => {
  const r = await fixture(['pass','setup','setup']);
  try {
    await r.accept(); await commitAt(r.cwd,{ 'docs/trunk':'move' }); await ops.adopt({ cwd:r.cwd,as:owner,channel:'delegated',note:'move trunk without changing invariant reads' });
    const d = await r.driver(); await d.pass();
    const votes = (await r.obs()).filter(e => e.merging === 'a'); assert.equal(votes.length,2);
    assert.equal(votes[1]!.auto_remeasure,true); assert.equal(votes[1]!.infra,undefined);
    const s = await r.state(); assert.ok(s.nodes.a!.halt,d.lines.join('\n'));
    assert.match(s.nodes.a!.halt!.reason,/^setup failure \(no tests ran\): Error: Cannot find <path> module <id> at <time> — likely the environment/);
    assert.doesNotMatch(s.nodes.a!.halt!.reason,/owed rebase|: rebase/);
    await d.pass(); assert.equal((await r.obs()).filter(e => e.merging === 'a').length,2,'budget durable after halt');
    const log = join(r.root,'driver.jsonl'); await writeFile(log,d.lines.join('\n') + '\n');
    const delivered:string[] = [], f = new Follower({ repo:r.cwd,log,pid:process.pid,from:0,deliver:t => { delivered.push(t); } });
    try { await f.step(); } finally { f.stop(); }
    assert.equal(delivered.length,1);
    assert.match(delivered[0]!,/Needs you: a — setup failure \(no tests ran\): .*likely the environment.*owed decide a --remeasure/);
  } finally { await r.cleanup(); }
});

test('IF2: failed-name + counted pass remains conflict; an independent setup pair alone resolves', { timeout:180_000 }, async () => {
  const r = await fixture(['pass','named','pass'],{ needles:['broken behaviour'] });
  try {
    await r.accept(); const error = await refused(ops.merge({ cwd:r.cwd,node:'a',as:parent })); assert.match(error.message,/conflicting pass and fail|owner conflict/);
    const votes = (await r.obs()).filter(e => e.merging === 'a'); assert.deepEqual(votes.map(e => e.infra),[undefined,undefined]);
    assert.deepEqual(votes[0]!.failed,['regression']); assert.equal(votes[1]!.verdict,'pass');
    assert.equal((await r.state()).nodes.a!.merged,undefined);
  } finally { await r.cleanup(); }
  const good = await fixture(['pass','setup','pass']);
  try { await good.accept(); await ops.merge({ cwd:good.cwd,node:'a',as:parent }); await resolvedInvariant(good); } finally { await good.cleanup(); }
});

test('IF1/IF2: timeout and error never auto-remeasure or pair; parsed zero-test failure does', { timeout:180_000 }, async () => {
  for (const mode of ['timeout','error']) {
    const r = await fixture(['pass',mode,'pass']);
    try {
      await r.accept(); await refused(ops.merge({ cwd:r.cwd,node:'a',as:parent }));
      const votes = (await r.obs()).filter(e => e.merging === 'a'); assert.equal(votes.length,1); assert.equal(votes[0]!.verdict,'error'); assert.equal(votes[0]!.auto_remeasure,undefined);
      await ops.attest({ cwd:r.cwd,node:'a',remeasure:true,all:true });
      assert.equal((await r.obs()).filter(e => e.merging === 'a').at(-1)!.infra,undefined);
    } finally { await r.cleanup(); }
  }
  const r = await fixture(['pass','zero','pass']);
  try { await r.accept(); await ops.merge({ cwd:r.cwd,node:'a',as:parent }); await resolvedInvariant(r); } finally { await r.cleanup(); }
});

test('IF2 replay: forged infra, wrong subject/key/obligation, intervening measurement and insufficient counts all refuse', { timeout:180_000 }, async () => {
  const r = await fixture(['pass','setup','pass']);
  try {
    await r.accept(); await ops.merge({ cwd:r.cwd,node:'a',as:parent });
    const votes = (await r.obs()).filter(e => e.merging === 'a'), first = votes[0]!, pass = votes[1]!;
    assert.equal(pass.infra,first.seq);
    const { entries,look } = await r.lookup(), prefix = entries.filter(e => e.seq < pass.seq), s = replay.reduce(prefix,look);
    assert.deepEqual(replay.validateDraft(s,pass as Draft),[]);
    for (const change of [{ infra:0 },{ infra:-1 },{ infra:'bad' },{ key:'other' },{ subject:'missing' },{ obligation:'inv:missing' },{ verdict:'fail' },{ counts:{tests:0,fail:0} },{ counts:{tests:1,fail:1} },{ counts:{tests:1} },{ failed:['regression'] },{ execution:{ completed:false,countOK:true } },{ note:'timeout after 1s' }]) {
      const forged = { ...pass,...change } as Entry;
      assert.throws(() => replay.reduce([...prefix,forged],look),/infra|invalid/,JSON.stringify(change));
    }
    const intervening = { ...first,seq:pass.seq,verdict:'error',auto_remeasure:undefined } as ObsEntry;
    assert.throws(() => replay.reduce([...prefix,intervening,{...pass,seq:pass.seq + 1}],look),/infra|auto_remeasure/);
    assert.equal((await ops.verify({ cwd:r.cwd })).ok,true);
  } finally { await r.cleanup(); }
});

test('IF2 compatibility: removing the new optional field preserves the old flaky/conflicting ledger state', { timeout:180_000 }, async () => {
  const r = await fixture(['setup','pass'],{checks:true});
  try {
    await r.submit(); assert.equal((await ops.attest({ cwd:r.cwd,node:'a' })).accepted,false);
    assert.equal((await ops.attest({ cwd:r.cwd,node:'a' })).accepted,true);
    const {entries,look} = await r.lookup(), legacy = entries.map(e => { if (e.kind !== 'obs') return e; const {infra:_infra,...old} = e; return old as Entry; });
    const old = replay.reduce(legacy,look), n = old.nodes.a!;
    assert.equal(n.accepted,false); assert.equal(n.blocks[0]!.state,'flaky'); assert.equal(n.items.find(i => i.obligation === 'check:x')!.mark,'⊤');
    assert.equal(old.deferred.length,0); assert.equal(old.downgrades.length,0);
    const split = Math.floor(legacy.length / 2);
    assert.equal(replay.sameReplay(old,replay.reduceFrom(replay.reduce(legacy.slice(0,split),look),legacy.slice(split),look)),true);
    assert.equal((await r.state()).nodes.a!.blocks[0]!.state,'cleared');
    const pass = entries.find((e): e is ObsEntry => e.kind === 'obs' && e.infra !== undefined)!;
    const setup = entries.find((e): e is ObsEntry => e.kind === 'obs' && e.seq === pass.infra)!;
    const prefix = entries.filter(e => e.seq < pass.seq);
    for (const counts of [{tests:1,fail:0},{tests:0,fail:1},{pass:1},{skip:1}]) {
      assert.throws(() => replay.reduce(prefix.map(e => e.seq === setup.seq ? {...setup,counts} : e).concat(pass),look),/infra/);
    }
  } finally { await r.cleanup(); }
});

test('IF1/IF2: driver reruns a node-check setup failure on its current key, clears the exec block and never asks for a waiver', { timeout:180_000 }, async () => {
  const r = await fixture(['setup','pass'],{checks:true});
  try {
    await r.submit(); await ops.attest({ cwd:r.cwd,node:'a' });
    const d = await r.driver(); await d.pass();
    const votes = await r.obs(); assert.equal(votes.length,2); assert.equal(votes[1]!.attribution,true); assert.equal(votes[1]!.infra,votes[0]!.seq);
    assert.equal(votes[0]!.key,votes[1]!.key);
    const n = (await r.state()).nodes.a!; assert.equal(n.accepted,true); assert.equal(n.blocks[0]!.state,'cleared'); assert.equal(n.blocks[0]!.clearedBy,votes[1]!.seq);
    assert.ok(!(await r.ledger.read()).some(e => ['send','halt','waive','defer'].includes(e.kind)));
    assert.match(renderWhy(await ops.why({cwd:r.cwd,node:'a'}),{full:true}),/#\d+ infra/);
    assert.equal((await ops.verify({cwd:r.cwd})).ok,true);
  } finally { await r.cleanup(); }
  const failed = await fixture(['setup','setup'],{checks:true});
  try {
    await failed.submit(); await ops.attest({cwd:failed.cwd,node:'a'});
    const d = await failed.driver(); await d.pass(); await d.pass();
    assert.match((await failed.state()).nodes.a!.halt!.reason,/^setup failure \(no tests ran\): .*owed decide a --remeasure/);
    assert.equal((await failed.obs()).length,2);
    await ops.decide({cwd:failed.cwd,nodes:'a',text:'environment fixed',remeasure:true,as:owner,channel:'delegated',dsa:{describe:async rid => ({rid,state:'sealed',status:'ok'}),send:async () => ({outcome:'applied',spec_digest:'fixture'})}});
    await d.pass(); assert.equal((await failed.state()).nodes.a!.accepted,false,'the older unpaired setup failure still blocks');
    assert.equal((await failed.obs()).at(-1)!.infra,(await failed.obs())[1]!.seq);
    assert.equal((await failed.state()).nodes.a!.items.find(i => i.obligation === 'check:x')!.mark,'⊤');
  } finally { await failed.cleanup(); }
});

test('IF4: same normalized signature across two nodes yields one repository notice within 30 minutes, never a pass', { timeout:180_000 }, async () => {
  const r = await fixture(['setup','setup','setup','setup'],{checks:true,nodes:['a','b']});
  try {
    for (const id of ['a','b']) { await r.submit(id); await ops.attest({cwd:r.cwd,node:id}); await ops.attest({cwd:r.cwd,node:id}); }
    const s = await r.state(), blobs = new Map<string,string>(); for (const o of await r.obs()) if (o.log) blobs.set(o.log,(await r.ledger.getBlob(o.log)).toString());
    const now = Date.parse((await r.ledger.read()).at(-1)!.ts);
    assert.match(clockTime(now,now),/^\d{2}:\d{2}$/);
    const opts = {max:2,repairs:2,project:'p',root:r.cwd,applied:new Set<string>(),rejected:new Map<string,string>(),blobs,now};
    const notices = decide(s,s.plan,new Map(),opts).filter(a => a.do === 'notify' && a.scope === 'repo' && a.once?.startsWith('setup\0'));
    assert.equal(notices.length,1); const notice = notices[0]!; assert.ok(notice.do === 'notify');
    assert.equal(notice.text,'setup failure on 2 trees: Error: Cannot find <path> module <id> at <time> — probably the environment, not the nodes (a,b); fix it, then owed decide a,b --remeasure');
    assert.equal(decide(s,s.plan,new Map(),{...opts,noticed:new Set([notice.once!])}).filter(a => a.do === 'notify' && a.once?.startsWith('setup\0')).length,0);
    assert.equal(decide(s,s.plan,new Map(),{...opts,now:now + 30*60_000 + 1}).filter(a => a.do === 'notify' && a.once?.startsWith('setup\0')).length,0);
    for (const id of ['a','b']) assert.equal(s.nodes[id]!.accepted,false);
    const log = join(r.root,'notice.jsonl'); await writeFile(log,JSON.stringify({...notice,outcome:'notify'}) + '\n');
    const f = new Follower({repo:r.cwd,log,pid:process.pid,from:0,deliver:() => {}}); try { assert.match((await f.step())!,/Needs you: .*setup failure on 2 trees/); } finally { f.stop(); }
  } finally { await r.cleanup(); }
});

test('IF counted spec: prior counted observation enables a no-min_tests setup retry; repeat passes must meet every run count', { timeout:180_000 }, async () => {
  const r = await fixture(['pass','setup','pass'],{counted:false});
  try { await r.accept(); await ops.merge({cwd:r.cwd,node:'a',as:parent}); await resolvedInvariant(r); } finally { await r.cleanup(); }
  const repeat = await fixture(['pass','pass','setup','pass','pass'],{repeat:{runs:2,need:2}});
  try {
    await repeat.accept(); await ops.merge({cwd:repeat.cwd,node:'a',as:parent}); await resolvedInvariant(repeat);
    const votes = (await repeat.obs()).filter(e => e.merging === 'a'), pass = votes[1]!;
    assert.equal(pass.runs!.length,2);
    const {entries,look} = await repeat.lookup(), prefix = entries.filter(e => e.seq < pass.seq);
    for (const runs of [undefined,[],pass.runs!.slice(0,1),[{...pass.runs![0]!,counts:{tests:0,fail:0}},pass.runs![1]!]]) {
      assert.throws(() => replay.reduce([...prefix,{...pass,runs}],look),/infra/);
    }
  } finally { await repeat.cleanup(); }
});
