// AC1–AC3: runtime facts through real ops/CLI fixtures; every test has a base-tree red check.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hostname } from 'node:os';
import * as ops from '../src/ops.ts';
import { sha256 } from '../src/canon.ts';
import { clockTime } from '../src/clock.ts';
import { Ledger } from '../src/ledger.ts';
import { OwedError } from '../src/errors.ts';
import { procStart } from '../src/drive-run.ts';
import { readLock } from '../src/drive-bg.ts';
import { stillAskingNeeds, writerLaunch } from '../src/drive.ts';
import { answerRetry } from '../src/answer.ts';
import { projectId } from '../src/reducer.ts';
import { repo } from './helpers/repo.ts';
import { commitAt, identity } from './helpers/surface.ts';

const owner = { role: 'owner', id: 'test' } as const, parent = { role: 'parent', id: 'test' } as const;
const NOW = Date.UTC(2026, 9, 17, 12);
const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean>, label: string): Promise<void> {
  for (let i = 0; i < 600; i++) { if (await check()) return; await sleep(25); }
  assert.fail(`timed out: ${label}`);
}
const exists = async (path: string) => readFile(path).then(() => true, () => false);
const slow = (root: string, id: string) => `echo started > '${join(root,id)}'; i=0; while [ ! -f '${join(root,`${id}-go`)}' ]; do i=$((i+1)); [ $i -gt 600 ] && exit 1; sleep 0.05; done`;
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture(make: (root: string) => { checks?: object[]; invariants?: object[]; nodes?: object[] } = () => ({}), common = false) {
  const r = await repo();
  if (common) delete process.env.OWED_DIR;
  const pending: Promise<unknown>[] = [], aborts: AbortController[] = [];
  try {
    await commitAt(r.cwd, { README: 'fixture\n' });
    const { checks = [], invariants = [], nodes } = make(r.root);
    await ops.init({ cwd: r.cwd, as: owner, channel: 'flag', measure: false, plan: JSON.stringify({ version: 1, trunk: 'main', closure: [], lease: false, invariants,
      nodes: nodes ?? [{ id: 'a', writes: ['a.txt'], checks, review: { count: 0, min_rank: 1 } }] }) });
    const slots: Record<string, string> = {};
    for (const id of nodes ? ['a','b'] : ['a']) {
      const d = await ops.dispatch({ cwd: r.cwd, node: id, as: parent }); slots[id] = d.worktree;
      await commitAt(d.worktree, { [`${id}.txt`]: 'candidate\n' });
      await ops.submit({ cwd: d.worktree, node: id, as: { role: 'writer', id: `${id}#1` } });
    }
    const ledger = await Ledger.open(r.cwd);
    return { ...r, slots, ledger, start<T>(run: (signal: AbortSignal) => Promise<T>): Promise<T> {
      const ac = new AbortController(); aborts.push(ac); const p = run(ac.signal); p.catch(() => {}); pending.push(p); return p;
    }, async done() { for (const ac of aborts) ac.abort(); await Promise.allSettled(pending); await r.cleanup(); } };
  } catch (e) { await r.cleanup(); throw e; }
}
const candidate = async (f: Fixture, node = 'a') => (await ops.readState(f)).state.nodes[node]!.candidate!.seq;
const records = async (f: Fixture) => (await import('../src/activity.ts')).readMeasuring(f.cwd);
const waitJob = async (f: Fixture, id: string) => until(() => exists(join(f.root,id)), `${id} started`);
const release = async (f: Fixture, id: string) => writeFile(join(f.root,`${id}-go`), '');
function other(record: Awaited<ReturnType<typeof records>>[number] | undefined) {
  assert.ok(record); assert.equal(record.phase, 'running'); assert.equal(record.do, 'other');
  assert.deepEqual(record.obligations, []); assert.equal(Object.hasOwn(record,'candidate'), false);
}

test('AC vocabulary is the byte-for-byte pinned needs-types sha', async () => {
  const bytes = await readFile(new URL('../src/needs-types.ts',import.meta.url)).catch(() => Buffer.alloc(0));
  assert.equal(sha256(bytes), 'c6a3451120a2ffe30465bd7c0afd1a7cd6a600e07b6a8f6acad394b51064fbf5');
});

test('AC1 candidate job publishes one running record in the common owed dir and cleans it after completion', { timeout: 60_000 }, async () => {
  const f = await fixture(root => ({ checks: [{ id: 'slow', run: slow(root,'check') }] }), true);
  try {
    const run = f.start(signal => ops.attest({ cwd: f.slots.a!, node: 'a', signal })); await waitJob(f,'check');
    const rs = await records(f); assert.equal(rs.length, 1);
    assert.deepEqual({ ...rs[0], token: 'token', since: 'since' }, { node: 'a', obligations: ['check:slow'], candidate: await candidate(f), do: 'attest', phase: 'running', pid: process.pid, token: 'token', since: 'since' });
    assert.match(clockTime(rs[0]!.since, NOW), /\d\d:\d\d$/);
    assert.deepEqual(await records(f), await (await import('../src/activity.ts')).readMeasuring(f.slots.a!));
    assert.deepEqual((await readdir(join(f.ledger.dir,'run'))).filter(n => n.endsWith('.json')), [`attest-${process.pid}-${rs[0]!.token}.json`]);
    await release(f,'check'); assert.equal((await run).accepted,true); assert.deepEqual(await records(f),[]);
    assert.deepEqual(await readdir(join(f.ledger.dir,'run')),[]);
  } finally { await f.done(); }
});

test('AC1 queued record precedes an exclusive lease wait and recursive acquisition retains its token', { timeout: 60_000 }, async () => {
  const f = await fixture(root => ({ checks: [{ id: 'slow', run: slow(root,'check') }] }));
  const prior = { OWED_DSA: process.env.OWED_DSA, OWED_LEASED: process.env.OWED_LEASED };
  try {
    await ops.planSet({ cwd: f.cwd, as: parent, plan: JSON.stringify({ ...(await ops.readState(f)).state.plan, lease: true }) });
    const bin = join(f.root,'dsa');
    await writeFile(bin, `#!/bin/bash\nset -e\n# An exclusive holder prevents the shared lease from being granted.\nls '${f.ledger.dir}/run'/attest-*.json > '${f.root}/requested'\ni=0; while [ ! -f '${f.root}/lease-go' ]; do i=$((i+1)); [ $i -gt 600 ] && exit 1; sleep 0.05; done\nwhile [ "$1" != -- ]; do shift; done; shift\nexec "$@"\n`); await chmod(bin,0o755);
    process.env.OWED_DSA = bin; delete process.env.OWED_LEASED;
    const run = f.start(signal => ops.attest({ cwd: f.cwd, node: 'a', signal }));
    await until(() => exists(join(f.root,'requested')),'lease requested');
    const queued = await records(f); assert.equal(queued.length,1); assert.equal(queued[0]!.phase,'queued');
    assert.equal(queued[0]!.do,'other'); assert.equal(queued[0]!.candidate,undefined); assert.deepEqual(queued[0]!.obligations,[]);
    assert.equal(await exists(join(f.root,'check')),false);
    const before = await candidate(f);
    await commitAt(f.slots.a!,{'a.txt':'changed while queued\n'});
    await ops.submit({cwd:f.slots.a!,node:'a',as:{role:'writer',id:'a#1'}});
    assert.notEqual(await candidate(f),before);
    await writeFile(join(f.root,'lease-go'),''); await waitJob(f,'check');
    const running = await records(f); assert.equal(running.length,1); assert.equal(running[0]!.token,queued[0]!.token); assert.equal(running[0]!.phase,'running'); assert.equal(running[0]!.candidate,await candidate(f));
    await release(f,'check'); await run; assert.deepEqual(await records(f),[]);
  } finally { for (const [key,value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await f.done(); }
});

test('AC1 two concurrent same-process attests have distinct tokens and only remove their own record', { timeout: 60_000 }, async () => {
  const f = await fixture(root => ({ nodes: ['a','b'].map(id => ({ id, writes: [`${id}.txt`], checks: [{ id: 'slow', run: slow(root,id) }], review: { count:0, min_rank:1 } })) }));
  try {
    const a = f.start(signal => ops.attest({ cwd:f.cwd,node:'a',signal })), b = f.start(signal => ops.attest({ cwd:f.cwd,node:'b',signal }));
    await waitJob(f,'a'); await waitJob(f,'b'); const rs = await records(f);
    assert.equal(rs.length,2); assert.equal(new Set(rs.map(r => r.token)).size,2); assert.ok(rs.every(r => r.pid === process.pid && r.phase === 'running'));
    const remaining = rs.find(r => r.node === 'b')!;
    await release(f,'a'); await a; assert.deepEqual(await records(f),[remaining]);
    await release(f,'b'); await b; assert.deepEqual(await records(f),[]);
  } finally { await f.done(); }
});

test('AC1 lock busy is still fail-fast and its cleanup leaves the active same-node invocation intact', { timeout: 60_000 }, async () => {
  const f = await fixture(root => ({ checks: [{ id:'slow',run:slow(root,'check') }] }));
  try {
    const run = f.start(signal => ops.attest({ cwd:f.cwd,node:'a',signal })); await waitJob(f,'check'); const rs = await records(f); assert.equal(rs.length,1);
    const busy = await Promise.race([ops.attest({cwd:f.cwd,node:'a'}).catch(e => e), sleep(5000).then(() => 'timeout')]);
    assert.ok(busy instanceof OwedError && busy.code === 'busy',String(busy)); assert.match(busy.message,/attest of a is already running/);
    assert.deepEqual(await records(f),rs); await release(f,'check'); await run; assert.deepEqual(await records(f),[]);
  } finally { await f.done(); }
});

for (const mode of ['genesis','trunk','probe','remeasure'] as const) test(`AC1 ${mode} is recorded as other without candidate scope`, { timeout: 60_000 }, async () => {
  const f = await fixture(root => mode === 'probe' ? { checks:[{id:'slow',run:slow(root,'job')}] } : { invariants:[{id:'slow',reads:['a.txt'],run:slow(root,'job')}] });
  try {
    if (mode === 'trunk') {
      await release(f,'job'); await ops.attestGenesis(f);
      const plan = (await ops.readState(f)).state.plan;
      await ops.planSet({...f,as:owner,channel:'flag',note:'fixture changes invariant scope',plan:JSON.stringify({...plan,invariants:plan.invariants.map(i => ({...i,reads:['README']}))})});
      await rm(join(f.root,'job-go')); await rm(join(f.root,'job'));
    }
    if (mode === 'remeasure') {
      await release(f,'job'); await ops.attestGenesis(f); await ops.attest({cwd:f.cwd,node:'a'}); await rm(join(f.root,'job-go')); await rm(join(f.root,'job'));
    }
    const run = f.start<unknown>(signal => mode === 'genesis' ? ops.attestGenesis({...f,signal}) : mode === 'trunk' ? ops.attestTrunk({...f,signal})
      : mode === 'probe' ? ops.attestProbeTrunk({...f,node:'a',check:'slow',signal}) : ops.attest({...f,node:'a',remeasure:true,all:true,signal}));
    await waitJob(f,'job'); const rs = await records(f); assert.equal(rs.length,1); other(rs[0]);
    await release(f,'job'); await run; assert.deepEqual(await records(f),[]);
  } finally { await f.done(); }
});

test('AC1 node attest exposes only candidate-tree obligations while its invariants and checks run', { timeout: 60_000 }, async () => {
  const f = await fixture(root => ({ invariants:[{id:'slow',reads:['a.txt'],run:slow(root,'inv')}],checks:[{id:'slow',run:slow(root,'check')}] }));
  try {
    const run = f.start(signal => ops.attest({...f,node:'a',signal})); await waitJob(f,'inv');
    const rs = await records(f); assert.equal(rs.length,1); other(rs[0]);
    await release(f,'inv'); await waitJob(f,'check'); const [r] = await records(f);
    assert.equal(r!.token,rs[0]!.token); assert.equal(r!.do,'attest'); assert.equal(r!.candidate,await candidate(f)); assert.deepEqual(r!.obligations,['check:slow']);
    await release(f,'check'); await run; assert.deepEqual(await records(f),[]);
  } finally { await f.done(); }
});

test('AC1 attribution on the current tree is attest but old-content attribution is other', { timeout: 90_000 }, async () => {
  const f = await fixture(root => ({ checks:[{id:'slow',reads:['a.txt'],run:`${slow(root,'check')}; exit 1`}] }));
  try {
    await release(f,'check'); await ops.attest({...f,node:'a'}); await rm(join(f.root,'check-go')); await rm(join(f.root,'check'));
    const abort = new AbortController();
    const same = f.start(signal => ops.attest({...f,node:'a',rerun:true,signal:AbortSignal.any([signal,abort.signal])})); await waitJob(f,'check');
    const [current] = await records(f); assert.equal(current!.do,'attest'); assert.equal(current!.candidate,await candidate(f)); assert.deepEqual(current!.obligations,['check:slow']);
    abort.abort(); await assert.rejects(same,(e:unknown) => e instanceof OwedError && e.code === 'aborted');
    await commitAt(f.slots.a!,{'a.txt':'changed\n'}); await ops.submit({cwd:f.slots.a!,node:'a',as:{role:'writer',id:'a#1'}});
    await rm(join(f.root,'check'));
    const old = f.start(signal => ops.attest({...f,node:'a',signal})); await waitJob(f,'check'); const [r] = await records(f); other(r);
    await release(f,'check'); await old; assert.deepEqual(await records(f),[]);
  } finally { await f.done(); }
});

test('AC1 invocation inside an already-held lease still publishes exactly one record', { timeout: 60_000 }, async () => {
  const f = await fixture(root => ({ checks:[{id:'slow',reads:['a.txt'],run:slow(root,'check')}] }));
  try {
    const {withMachineLease} = await import('../src/lease.ts');
    const run = f.start(signal => withMachineLease({cwd:f.cwd,lease:false,signal},() => ops.attest({...f,node:'a',signal})));
    await waitJob(f,'check'); const [r] = await records(f); assert.equal(r!.candidate,await candidate(f));
    // An already-held lease still gets exactly one outer invocation record.
    assert.equal((await records(f)).length,1); await release(f,'check'); await run;
  } finally { await f.done(); }
});

test('AC1 R-028-29 caller-held lease publishes at entry and stays queued until the operation lock', { timeout: 60_000 }, async () => {
  const f = await fixture(root => ({ checks:[{id:'slow',run:slow(root,'check')}] }));
  const prior = { OWED_DSA:process.env.OWED_DSA, OWED_LEASED:process.env.OWED_LEASED };
  const lock = join(f.ledger.dir,ops.attestLock('a'));
  try {
    await ops.planSet({...f,as:parent,plan:JSON.stringify({...(await ops.readState(f)).state.plan,lease:true})});
    const bin = join(f.root,'dsa');
    await writeFile(bin,`#!/bin/bash\necho requested > '${f.root}/unexpected-lease'\nexit 75\n`); await chmod(bin,0o755);
    process.env.OWED_DSA = bin; process.env.OWED_LEASED = '1';
    // A foreign operation lock waits rather than failing fast; the machine lease is already held by the caller.
    await mkdir(lock); await writeFile(join(lock,'owner.json'),JSON.stringify({pid:1,host:'foreign.invalid',ts:new Date(NOW).toISOString(),token:'holder'}));
    const run = f.start(signal => ops.attest({...f,node:'a',signal}));
    await until(async () => (await records(f)).length === 1,'invocation entry record');
    const [queued] = await records(f); assert.ok(queued); assert.equal(queued.phase,'queued');
    assert.equal(queued.do,'other'); assert.deepEqual(queued.obligations,[]); assert.equal(Object.hasOwn(queued,'candidate'),false);
    assert.equal(await exists(join(f.root,'check')),false,'the operation lock still prevents job start');
    assert.equal(await exists(join(f.root,'unexpected-lease')),false,'caller-held lease is not reacquired');
    await rm(lock,{recursive:true}); await waitJob(f,'check');
    const [running] = await records(f); assert.ok(running); assert.equal(running.token,queued.token);
    assert.equal(running.phase,'running'); assert.equal(running.do,'attest'); assert.equal(running.candidate,await candidate(f));
    assert.deepEqual(running.obligations,['check:slow']); assert.equal(await exists(join(f.root,'unexpected-lease')),false);
    await release(f,'check'); await run; assert.deepEqual(await records(f),[]);
  } finally {
    await rm(lock,{recursive:true,force:true}); await f.done();
    for (const [key,value] of Object.entries(prior)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  }
});

test('AC1 R-028-29 resubmit mid-run keeps the snapshot seq on later old-tree jobs and cleans the record', { timeout: 60_000 }, async () => {
  const f = await fixture(root => ({ checks:[{id:'one',reads:['a.txt'],run:slow(root,'one')},
    {id:'two',reads:['a.txt'],run:`cat a.txt > '${join(root,'two-content')}'; ${slow(root,'two')}`}] }));
  try {
    const old = await candidate(f), run = f.start(signal => ops.attest({...f,node:'a',signal})); await waitJob(f,'one');
    const [first] = await records(f); assert.ok(first); assert.equal(first.candidate,old); assert.deepEqual(first.obligations,['check:one']);
    await commitAt(f.slots.a!,{'a.txt':'new candidate\n'});
    await ops.submit({cwd:f.slots.a!,node:'a',as:{role:'writer',id:'a#1'}});
    const current = await candidate(f); assert.notEqual(current,old);
    await release(f,'one'); await waitJob(f,'two');
    const rs = await records(f); assert.equal(rs.length,1); const later = rs[0]!;
    assert.equal(later.token,first.token); assert.equal(later.phase,'running'); assert.equal(later.do,'attest');
    assert.deepEqual(later.obligations,['check:two']); assert.equal(later.candidate,old);
    assert.notEqual(later.candidate,current,'N6 seq matching cannot suppress a need of the newer candidate');
    assert.equal(await readFile(join(f.root,'two-content'),'utf8'),'candidate\n','later job still measures the invocation snapshot tree');
    await release(f,'two'); const result = await run; assert.deepEqual(await records(f),[]);
    assert.deepEqual(result.superseded.map(j => j.obligation),['check:one','check:two','writes'],'stale observations keep the existing supersession guard');
    assert.equal((await f.ledger.read()).filter(e => e.kind === 'obs').length,0,'superseded jobs record no observations');
    assert.equal(await candidate(f),current,'the invocation does not replace the resubmitted candidate');
  } finally { await f.done(); }
});

test('AC1 CLI signal keeps the record until actual abort cleanup, then removes it', { timeout: 60_000 }, async () => {
  // R-029-9/R-029-4: an untagged escapee is never signalled; retain its record until inherited pipes actually close.
  const f = await fixture(root => ({ checks:[{id:'slow',run:`env -u OWED_RUN setsid sleep 2 & ${slow(root,'check')}`}] }));
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const activity = await import('../src/activity.ts');
    child = spawn(process.execPath,[fileURLToPath(new URL('../bin/owed.js',import.meta.url)),'attest','a','--no-lease'],{cwd:f.cwd,env:{...process.env,...identity},stdio:'ignore'});
    const exit = new Promise(resolve => child!.once('close',resolve)); await waitJob(f,'check');
    const rs = await activity.readMeasuring(f.cwd); assert.equal(rs.length,1); assert.equal(rs[0]!.pid,child.pid);
    child.kill('SIGTERM'); await sleep(200);
    assert.deepEqual(await activity.readMeasuring(f.cwd),rs,'abort request is not termination while inherited pipes remain open');
    await exit; assert.deepEqual(await activity.readMeasuring(f.cwd),[]);
    assert.equal((await f.ledger.read()).filter(e => e.kind === 'obs').length,0);
  } finally { child?.kill('SIGKILL'); await f.done(); }
});

test('AC2 stale pids are deleted, live records are not deduplicated, unreadable files are ignored', async () => {
  const f = await fixture();
  try {
    const activity = await import('../src/activity.ts'), dir = join(f.ledger.dir,'run'); await mkdir(dir,{recursive:true});
    const dead = spawnSync(process.execPath,['-e','']).pid!;
    const record = {node:'a',obligations:[],do:'other',phase:'queued',since:new Date(NOW).toISOString(),pid:process.pid,token:'first'};
    await writeFile(join(dir,`attest-${process.pid}-first.json`),JSON.stringify(record));
    await writeFile(join(dir,`attest-${process.pid}-second.json`),JSON.stringify({...record,token:'second'}));
    const stale = join(dir,`attest-${dead}-dead.json`); await writeFile(stale,JSON.stringify({...record,pid:dead,token:'dead'}));
    await writeFile(join(dir,'attest-1-broken.json'),'{'); await writeFile(join(dir,'attest-1-invalid.json'),'null'); await writeFile(join(dir,'attest-1-tmp.json.tmp'),JSON.stringify(record));
    const rs = await activity.readMeasuring(f.cwd); assert.equal(rs.length,2); assert.deepEqual(new Set(rs.map(r => r.token)),new Set(['first','second'])); assert.equal(await exists(stale),false);
  } finally { await f.done(); }
});

test('AC3 unknown fields stay absent; live/foreign/stopped asking matches the existing summary caller', async () => {
  const f = await fixture();
  try {
    const activity = await import('../src/activity.ts');
    let state = (await ops.readState(f)).state;
    const launch = writerLaunch(state,'a',projectId(state));
    await ops.launch({...f,...launch,as:parent});
    const rule = await ops.answerRule({...f,as:parent,node:'a',text:'Answer to writer question q: keep it',answer:{rid:launch.rid,qid:'q',rev:2}});
    state = (await ops.readState(f)).state;
    const now = Date.parse(rule.ts)+900_000, row = {node:'a',rid:launch.rid,qid:'q',rev:2};
    await mkdir(join(f.ledger.dir,'drive'),{recursive:true});
    await writeFile(join(f.ledger.dir,'drive','asking.json'),JSON.stringify([row,{...row,qid:'missing'},{...row,rev:3},{...row,rid:'old'},{...row,node:'missing'},{...row,rev:1.5},null]));
    const unknown = await activity.assembleRuntime({cwd:f.cwd,state,now}); assert.deepEqual(unknown,{measuring:[]});
    const lock = join(f.ledger.dir,'drive.lock');
    for (const host of [hostname(),'foreign.invalid']) {
      await writeFile(lock,JSON.stringify({pid:process.pid,start:procStart(process.pid),host,at:new Date(NOW).toISOString(),token:'driver'}));
      const held = readLock(f.ledger.dir); assert.equal(held.state,host === hostname() ? 'live':'foreign');
      const driverRunning = held.state === 'live' || held.state === 'foreign';
      const rt = await activity.assembleRuntime({cwd:f.cwd,state,driverRunning,now});
      assert.deepEqual(rt.asking,[{...row,text:stillAskingNeeds(state,[row],now)[0]!.text}]);
      const view = await ops.summaryStatusView(f.cwd,f.ledger.dir,state,(await ops.readState(f)).entries,now);
      const asking = view.summary!.needs.filter(n => n.reason.includes('still asking'));
      assert.deepEqual(asking.map(n => `${n.node}: ${n.reason}`),rt.asking!.map(a => a.text.split(': retry with ',1)[0]!));
      assert.deepEqual(asking.map(n => n.command),rt.asking!.map(a => answerRetry(a.node,rule,{rid:a.rid,qid:a.qid,rev:a.rev})));
      assert.equal(rt.driverRunning,true);
    }
    await rm(lock); const stopped = await activity.assembleRuntime({cwd:f.cwd,state,driverRunning:false,now}); assert.deepEqual(stopped,{measuring:[],asking:[],driverRunning:false});
    assert.ok(!(await ops.summaryStatusView(f.cwd,f.ledger.dir,state,(await ops.readState(f)).entries,now)).summary!.needs.some(n => n.reason.includes('still asking')));
    assert.deepEqual((await activity.assembleRuntime({cwd:f.cwd,state,driverRunning:true,now:Date.parse(rule.ts)})).asking,[],'under grace');
    for (const text of ['{','{}']) { await writeFile(join(f.ledger.dir,'drive','asking.json'),text); assert.deepEqual((await activity.assembleRuntime({cwd:f.cwd,state,driverRunning:true,now})).asking,[]); }
  } finally { await f.done(); }
});
