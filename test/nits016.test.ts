import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as ops from '../src/ops.ts';
import * as git from '../src/git.ts';
import { Ledger } from '../src/ledger.ts';
import { parsePlan } from '../src/plan.ts';
import { computeMetrics, metricsBound } from '../src/metrics.ts';
import { renderBrief, renderStatus } from '../src/views.ts';
import type { Draft, Entry, Plan } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const owner = {role:'owner' as const,id:'pi'}, parent = {role:'parent' as const,id:'pi'};
function metricsFixture(ids = ['merge','review','summary','fix-42']) {
  const plan = parsePlan(JSON.stringify({version:1,trunk:'main',closure:[],invariants:[],nodes:ids.map(id => ({id,writes:['impl'],checks:[]}))}));
  const entries: Entry[] = [];
  const add = (draft: Draft, ts = '2026-01-01T00:00:00.000Z') => {
    entries.push({...draft,seq:entries.length,ts,prev:'previous',hash:'hash'} as Entry);
  };
  add({kind:'genesis',by:'owner:pi',trunk:'main',commit:'base',plan:'plan',state:{commit:'base',tree:'tree',invKeys:{}}});
  const halt = (reason: string, ts?: string) => add({kind:'halt',by:'parent:drive',node:ids[0]!,attempt:1,reason,needs:'human'},ts);
  const compute = (window = {}) => computeMetrics(entries,new Map<string,Plan>([['plan',plan]]),window);
  return {entries,halt,compute};
}

test('NT1: date-only bounds use UTC midnight with exclusive since and inclusive until', () => {
  const f = metricsFixture();
  f.halt('before','2025-12-31T23:59:59.999Z');
  f.halt('at since','2026-01-01T00:00:00.000Z');
  f.halt('inside','2026-01-01T00:00:00.001Z');
  f.halt('at until','2026-01-02T00:00:00.000Z');
  f.halt('after','2026-01-02T00:00:00.001Z');
  const dates = f.compute({since:'2026-01-01',until:'2026-01-02'});
  assert.deepEqual(dates.halts.map(h => [h.reason,h.endedBy]),[['inside',4],['at until',null]]);
  const times = f.compute({since:'2026-01-01T00:00:00.000Z',until:'2026-01-02T00:00:00.000Z'});
  assert.deepEqual({...dates,since:null,until:null},{...times,since:null,until:null});
  assert.throws(() => f.compute({since:'2026-01-02',until:'2026-01-01'}), /later than/);
  for (const bound of ['2026-01-01suffix','2026-13-01','not-a-date',1.5]) assert.throws(() => metricsBound(bound,'since'), /seq or ISO/);
  assert.equal(metricsBound('12','until'),12);
});

test('NT1 CLI: report --metrics accepts date-only --since and --until without writing', async () => {
  const r = await repo();
  try {
    await r.commit();
    await ops.init({cwd:r.cwd,as:owner,channel:'delegated',plan:JSON.stringify({version:1,trunk:'main',lease:false,closure:[],invariants:[],nodes:[]})});
    const ledger = await Ledger.open(r.cwd), before = await ledger.read();
    const result = await cli(r.cwd,['report','--metrics','--since','2026-01-01','--until','2026-01-02','--json']);
    assert.equal(result.code,0,result.stderr);
    const m = JSON.parse(result.stdout);
    assert.equal(m.since,'2026-01-01'); assert.equal(m.until,'2026-01-02');
    assert.equal(m.mergedNodes,0);
    assert.deepEqual(await ledger.read(),before);
  } finally { await r.cleanup(); }
});

test('NT2: plain-word ids preserve unrelated merge, review and summary reasons', () => {
  const f = metricsFixture();
  f.halt('merge refused: review required');
  f.halt('review refused: summary required');
  f.halt('summary unavailable after merge');
  assert.deepEqual(f.compute().halts.map(h => h.normalizedReason),[
    'merge refused: review required','review refused: summary required','summary unavailable after merge',
  ]);
  assert.equal(f.compute().haltReasons['no-decision'].length,3);
});

test('NT2: word ids normalize only in node positions, not owed verbs or longer tokens', () => {
  const f = metricsFixture();
  for (const reason of ['merge: refused','prefix review/check:unit refused','waiting for node summary','owed resume merge --after review','owed merge review','owed review summary --after merge']) f.halt(reason);
  f.halt('summary: fix-42 blocked; mergeable review.extra pre-summary 123 run owed:abc:2');
  const original = JSON.stringify(f.entries);
  assert.deepEqual(f.compute().halts.map(h => h.normalizedReason),[
    '<id>: refused','prefix <id>/check:unit refused','waiting for node <id>',
    'owed resume <id> --after <id>','owed merge <id>','owed review <id> --after <id>',
    '<id>: <id> blocked; mergeable review.extra pre-summary <n> run <id>',
  ]);
  assert.equal(JSON.stringify(f.entries),original);
});

async function deferredCandidate() {
  const r = await repo();
  try {
    await commitAt(r.cwd,{health:'clean\n',impl:'base\n'});
    const plan = parsePlan(JSON.stringify({version:1,trunk:'main',lease:false,closure:[],invariants:[{id:'health',run:'grep -qx clean health',reads:['health']}],nodes:[{id:'a',writes:['health','impl'],checks:[]}]}));
    await ops.init({cwd:r.cwd,as:owner,channel:'delegated',plan:JSON.stringify(plan)});
    const a = await ops.dispatch({cwd:r.cwd,node:'a',as:parent});
    await commitAt(a.worktree,{health:'broken\n',impl:'candidate\n'});
    await ops.submit({cwd:a.worktree,node:'a',as:{role:'writer',id:'a#1'}});
    assert.equal((await ops.attest({cwd:r.cwd,node:'a'})).accepted,true);
    await assert.rejects(ops.merge({cwd:r.cwd,node:'a',as:parent}), /invariant health new debt/);
    const status = await ops.status({cwd:r.cwd});
    const built = await git.buildMerge(r.cwd,status.trunk.commit,status.nodes.a!.candidate!.commit,'owed merge a');
    assert.ok(!('conflicts' in built));
    const facts = await git.stateFacts(r.cwd,plan,built.commit);
    const entry = await ops.defer({cwd:r.cwd,node:'a',as:owner,channel:'delegated',items:[{id:'health',key:facts.invKeys.health!}],reason:'repair later'});
    return {r,entry};
  } catch (e) { await r.cleanup(); throw e; }
}

async function assertUnverified(r: Awaited<ReturnType<typeof repo>>, kind: 'drift' | 'conflict') {
  const ledger = await Ledger.open(r.cwd), before = await ledger.read();
  const status = await ops.status({cwd:r.cwd}), brief = await ops.brief({cwd:r.cwd});
  const suffix = kind === 'drift' ? 'trunk moved' : 'merge conflicts';
  const line = `a/inv:health: owner defer (not rechecked: ${suffix})`;
  for (const text of [renderStatus(status),renderBrief(brief)]) assert.ok(text.includes(line),text);
  // JSON consumers get the same additive per-defer marker in status and brief.
  for (const command of ['status','brief']) {
    const out = await cli(r.cwd,[command,'--json']);
    assert.equal(out.code,0,out.stderr);
    assert.equal(JSON.parse(out.stdout).deferred[0].unverified,kind);
  }
  assert.deepEqual(brief.summary!.debt,status.summary!.debt);
  assert.deepEqual(await ledger.read(),before,'view queries must not append acceptance evidence');
}

test('NT3: trunk drift retains recorded defer debt and rechecks it after adoption', async () => {
  const {r,entry} = await deferredCandidate();
  try {
    await commitAt(r.cwd,{unrelated:'outside invariant reads'});
    await assertUnverified(r,'drift');
    await ops.adopt({cwd:r.cwd,as:owner,channel:'delegated',note:'fixture unrelated trunk change'});
    const status = await ops.status({cwd:r.cwd});
    assert.ok(status.summary!.debt.includes('a/inv:health: owner defer'));
    assert.deepEqual(status.deferred,[{seq:entry.seq,node:'a',id:'health',key:entry.kind === 'defer' ? entry.items[0]!.key : ''}]);
  } finally { await r.cleanup(); }
});

test('NT3: merge-build conflict retains recorded defer debt without weakening merge refusal', async () => {
  const {r} = await deferredCandidate();
  try {
    await commitAt(r.cwd,{impl:'conflicting trunk\n'});
    await ops.adopt({cwd:r.cwd,as:owner,channel:'delegated',note:'fixture conflicting trunk change'});
    await assertUnverified(r,'conflict');
    await assert.rejects(ops.merge({cwd:r.cwd,node:'a',as:parent}), /rebase needed/);
  } finally { await r.cleanup(); }
});

test('NT3: drift does not revive an abandoned attempt defer for a new candidate', async () => {
  const {r} = await deferredCandidate();
  try {
    await ops.abandon({cwd:r.cwd,node:'a',as:parent,reason:'retry candidate'});
    const a = await ops.dispatch({cwd:r.cwd,node:'a',as:parent});
    await commitAt(a.worktree,{health:'broken\n'});
    await ops.submit({cwd:a.worktree,node:'a',as:{role:'writer',id:'a#2'}});
    await commitAt(r.cwd,{unrelated:'trunk drift'});
    const status = await ops.status({cwd:r.cwd}), brief = await ops.brief({cwd:r.cwd});
    for (const text of [renderStatus(status),renderBrief(brief)]) assert.doesNotMatch(text,/a\/inv:health: owner defer/);
    assert.equal(status.deferred,undefined);
    assert.equal(brief.deferred,undefined);
  } finally { await r.cleanup(); }
});
