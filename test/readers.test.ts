import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import * as R from '../src/reducer.ts';
import * as storage from '../src/ledger.ts';
import { actContent } from '../src/identical-acts.ts';
import { ZERO, H } from '../src/canon.ts';
import { parsePlan } from '../src/plan.ts';
import { clockTime } from '../src/clock.ts';
import type { Draft, Entry, Plan, State } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const owner = { role:'owner', id:'pi' } as const, parent = { role:'parent', id:'main' } as const;
const future = 'future_display';
const now = Date.UTC(2026, 9, 16, 12);
function rehash(entries: Entry[]): Entry[] {
  let prev = ZERO;
  return entries.map((original, seq) => {
    const e = { ...original, seq, prev };
    e.hash = storage.entryHash(e); prev = e.hash; return e;
  });
}
function decorate(entries: Entry[], seq: number, fields: Record<string, unknown> = { [future]:{ text:'future diagnostic', version:9 } }, names = Object.keys(fields).sort()): Entry[] {
  return rehash(entries.map(e => e.seq === seq ? { ...e, ...fields, ignorable:names } as Entry : e));
}
function publicSemantics(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value,(key, field) => ['head','hash','prev','ignorable',future].includes(key) ? undefined : field));
}
function semantics(state: State) { return publicSemantics(state); }
async function fixture(grant = false) {
  const r = await repo();
  try {
    await commitAt(r.cwd,{ 'src/base':'base', 'inv/base':'base' });
    await ops.init({ cwd:r.cwd, as:owner, channel:'delegated', plan:JSON.stringify({
      version:1, trunk:'main', lease:false, closure:[],
      invariants:[{ id:'stable', run:'true', reads:['inv/'] }],
      ...(grant ? { allow:[{ nodes:['a'], writes:['docs/'] }] } : {}),
      nodes:[{ id:'a', writes:['src/'], checks:[{ id:'unit', run:'false', reads:['src/'] }] },{ id:'fix', writes:['fix/'] }],
    }) });
    const slot = await ops.dispatch({ cwd:r.cwd, node:'a', as:parent });
    await commitAt(slot.worktree,{ 'src/a':'candidate', ...(grant ? { 'docs/a':'granted' } : {}) });
    await ops.submit({ cwd:slot.worktree, node:'a', as:{ role:'writer', id:'a#1' } });
    await ops.attest({ cwd:r.cwd, node:'a' });
    const ledger = await storage.Ledger.open(r.cwd);
    const failed = (await ledger.read()).find(e => e.kind === 'obs' && e.subject === 'a' && e.obligation === 'check:unit' && e.verdict === 'fail')!;
    assert.ok(failed);
    await ops.waive({ cwd:r.cwd, node:'a', as:owner, channel:'delegated', obligation:'check:unit', reason:'keep visible debt', accept_risk:[failed.seq] });
    await ops.rule({ cwd:r.cwd, as:parent, nodes:['a'], text:'retain the candidate' });
    await ops.resume({ cwd:r.cwd, as:parent, node:'a', note:'continue without changing evidence' });
    await ops.decoyCommit({ cwd:r.cwd, as:owner, channel:'delegated', digest:H('future-reader') });
    const plans = new Map<string, Plan>();
    const entries = await ledger.read();
    for (const e of entries) if (e.kind === 'genesis' || e.kind === 'plan') plans.set(e.plan,parsePlan((await ledger.getBlob(e.plan)).toString()));
    const lookup = (sha:string): Plan => plans.get(sha)!;
    const install = async (es:Entry[]) => {
      await ledger.withLock(async () => { await writeFile(join(ledger.dir,'ledger.jsonl'),es.map(e => JSON.stringify(e)).join('\n') + '\n'); });
    };
    return { ...r, slot, ledger, entries, lookup, install };
  } catch (e) { await r.cleanup(); throw e; }
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function acceptedMetadata(r:Fixture, es:Entry[]) {
  assert.deepEqual(storage.verifyChain(es),{ ok:true });
  await r.install(es);
  const verified = await ops.verify({ cwd:r.cwd });
  assert.equal(verified.ok,true,JSON.stringify(verified));
  const result = await cli(r.cwd,['verify','--json']);
  assert.equal(result.code,0,result.stderr);
  return R.reduce(es,r.lookup);
}

for (const kind of ['obs','rule','resume','decoy-commit'] as const) {
  test(`RC1/RC3: listed future ${kind} field preserves item views, keys, verdicts, blocks and debt through ops and CLI`, { timeout:120_000 }, async () => {
    const r = await fixture();
    try {
      const target = r.entries.find(e => e.kind === kind && (kind !== 'obs' || e.kind === 'obs' && e.verdict === 'fail'))!;
      const old = R.reduce(r.entries,r.lookup);
      assert.equal(old.nodes.a!.blocks[0]!.state,'cleared');
      assert.equal(old.nodes.a!.items.find(i => i.obligation === 'check:unit')!.status,'W');
      const before = await ops.why({ cwd:r.cwd,node:'a' });
      const debt = (await ops.report({ cwd:r.cwd })).waivers;
      const es = decorate(r.entries,target.seq), actual = await acceptedMetadata(r,es);
      assert.notEqual(actual.head,old.head,'hashes include ignorable metadata');
      assert.deepEqual(semantics(actual),semantics(old));
      for (let end = target.seq + 1; end <= es.length; end++) {
        assert.deepEqual(semantics(R.reduce(es.slice(0,end),r.lookup)),semantics(R.reduce(r.entries.slice(0,end),r.lookup)),`same semantics at prefix ${end}`);
      }
      assert.deepEqual(publicSemantics(await ops.why({ cwd:r.cwd,node:'a' })),publicSemantics(before));
      assert.deepEqual((await ops.report({ cwd:r.cwd })).waivers.map(e => [e.seq,e.kind === 'waive' ? e.reason : '']),debt.map(e => [e.seq,e.kind === 'waive' ? e.reason : '']));
      const split = target.seq;
      assert.equal(R.sameReplay(actual,R.reduceFrom(R.reduce(es.slice(0,split),r.lookup),es.slice(split),r.lookup)),true);
      const view = await cli(r.cwd,['why','a','--json']); assert.equal(view.code,0,view.stderr);
      assert.deepEqual(publicSemantics(JSON.parse(view.stdout).items),publicSemantics(before.items));
      assert.equal(clockTime(target.ts,now),clockTime(es[target.seq]!.ts,now),'injected display clock stays unchanged');
    } finally { await r.cleanup(); }
  });
}

test('RC1: unlisted fields keep version/strict refusals, but a listed generic node name is never read', { timeout:120_000 }, async () => {
  const r = await fixture();
  try {
    const strict = r.entries.find(e => e.kind === 'decoy-commit')!;
    const es = decorate(r.entries,strict.seq,{ node:'unknown-node', [future]:false });
    assert.deepEqual(semantics(await acceptedMetadata(r,es)),semantics(R.reduce(r.entries,r.lookup)));
    for (const kind of ['obs','rule','resume','decoy-commit','refresh'] as const) {
      const target = kind === 'refresh' ? await appendChecked(r,{ kind:'refresh',by:'executor:owed',commit:R.reduce(r.entries,r.lookup).trunk.commit,state:{ ...R.reduce(r.entries,r.lookup).trunk } }) : r.entries.find(e => e.kind === kind)!;
      const old = kind === 'refresh' ? await r.ledger.read() : r.entries;
      const bad = rehash(old.map(e => e.seq === target.seq ? { ...e,[future]:true } as unknown as Entry : e));
      await r.install(bad);
      const verified = await ops.verify({ cwd:r.cwd }); assert.equal(verified.ok,false,kind);
      assert.match(verified.error!,kind === 'decoy-commit' || kind === 'refresh' ? /unknown field/ : /needs a newer owed/);
      const result = await cli(r.cwd,['verify']); assert.notEqual(result.code,0,kind);
      await r.install(r.entries);
    }
  } finally { await r.cleanup(); }
});

test('RC1: listing known fields cannot bypass enums, unknown kinds/channels or ordinary field validation', { timeout:120_000 }, async () => {
  const r = await fixture();
  try {
    const obs = r.entries.find(e => e.kind === 'obs' && e.verdict === 'fail')!;
    const es = decorate(r.entries,obs.seq,{},['verdict']);
    assert.deepEqual(semantics(await acceptedMetadata(r,es)),semantics(R.reduce(r.entries,r.lookup)));
    const cases: [string, Record<string,unknown>, string[], RegExp][] = [
      ['obs',{ verdict:'future-verdict' },['verdict'],/obs verdict future-verdict.*needs a newer owed/],
      ['obs',{ probe:'future-probe' },['probe'],/obs probe future-probe.*needs a newer owed/],
      ['resume',{ release:'future-release' },['release'],/resume release future-release.*needs a newer owed/],
      ['rule',{ writer:'future-writer' },['writer'],/rule writer must be a boolean/],
      ['obs',{ kind:'future-kind',[future]:1 },[future],/future-kind.*needs a newer owed/],
      ['obs',{ kind:'toString',[future]:1 },[future],/toString.*needs a newer owed/],
      ['obs',{ kind:'__proto__',[future]:1 },[future],/__proto__.*needs a newer owed/],
      ['obs',{ channel:'future-channel',[future]:1 },[future],/channel future-channel.*needs a newer owed/],
    ];
    for (const [kind,fields,names,message] of cases) {
      const target = r.entries.find(e => e.kind === kind)!;
      await r.install(decorate(r.entries,target.seq,fields,names));
      const verified = await ops.verify({ cwd:r.cwd }); assert.equal(verified.ok,false,JSON.stringify(fields)); assert.match(verified.error!,message);
    }
  } finally { await r.cleanup(); }
});

test('RC1: every malformed ignorable list is one invalid-entry error, never an unknown-field version refusal', { timeout:120_000 }, async () => {
  const r = await fixture();
  try {
    const base = ['kind','by','channel','seq','ts','prev','hash','decision','ignorable'];
    const malformed: unknown[] = [null,false,'note',{},[],[1],[''],[future,future],['z','a'],['missing'],...base.map(k => [k])];
    const sparse = { ...r.entries.find(e => e.kind === 'rule')!, ignorable:new Array(1) };
    assert.equal(R.validateDraft(R.reduce(r.entries.slice(0,sparse.seq),r.lookup),sparse).length,1,'sparse arrays are invalid too');
    for (const kind of ['genesis','obs','rule','resume','decoy-commit'] as const) {
      const target = r.entries.find(e => e.kind === kind)!;
      for (const names of malformed) {
        const bad = rehash(r.entries.map(e => e.seq === target.seq ? { ...e,[future]:1,a:1,z:1,ignorable:names } as unknown as Entry : e));
        const errors = R.validateDraft(R.reduce(r.entries.slice(0,target.seq),r.lookup),bad[target.seq]!);
        assert.equal(errors.length,1,JSON.stringify(names)); assert.match(errors[0]!,/^ignorable /);
        await r.install(bad);
        const verified = await ops.verify({ cwd:r.cwd }); assert.equal(verified.ok,false); assert.equal(verified.code,undefined);
        assert.match(verified.error!,new RegExp(`^Entry #${target.seq} invalid: ignorable `));
        assert.doesNotMatch(verified.error!,/;|needs a newer owed/);
      }
    }
    const strict = r.entries.find(e => e.kind === 'decoy-commit')!;
    const undef = { ...strict,[future]:undefined,ignorable:[future] } as Entry;
    assert.deepEqual(R.validateDraft(R.reduce(r.entries.slice(0,strict.seq),r.lookup),undef),['ignorable names must reference present fields with defined values']);
    const result = await cli(r.cwd,['verify']); assert.notEqual(result.code,0);
  } finally { await r.cleanup(); }
});

async function appendChecked(r:Fixture, draft:Draft) {
  return r.ledger.withLock(async () => {
    const s = R.reduce(await r.ledger.read(),r.lookup);
    assert.deepEqual(R.validateDraft(s,draft),[]);
    return (await r.ledger.append([draft]))[0]!;
  });
}

test('RC1: grant, refresh, defer, abandon and hold honor listed fields without changing their semantic effects', { timeout:120_000 }, async () => {
  const r = await fixture(true);
  try {
    const initial = R.reduce(r.entries,r.lookup);
    await appendChecked(r,{ kind:'refresh',by:'executor:owed',commit:initial.trunk.commit,state:{ commit:initial.trunk.commit,tree:initial.trunk.tree,invKeys:initial.trunk.invKeys } });
    await ops.defer({ cwd:r.cwd,node:'a',as:owner,channel:'delegated',items:[{id:'stable',key:initial.trunk.invKeys.stable!}],reason:'visible invariant debt' });
    await ops.abandon({ cwd:r.cwd,node:'a',as:parent,reason:'hold this attempt',hold:true });
    const old = await r.ledger.read(), before = R.reduce(old,r.lookup);
    assert.ok(before.downgrades.some(d => d.items.some(i => i.what.startsWith('writes granted:'))));
    assert.equal(before.deferred.length,1); assert.ok(before.nodes.a!.held !== undefined);
    const es = rehash(old.map(e => ['grant','refresh','defer','abandon','hold'].includes(e.kind) ? { ...e,[future]:null,ignorable:[future] } as unknown as Entry : e));
    assert.deepEqual(semantics(await acceptedMetadata(r,es)),semantics(before));
    for (const kind of ['grant','refresh','defer','abandon','hold']) {
      const target = old.find(e => e.kind === kind)!;
      const unlisted = rehash(old.map(e => e.seq === target.seq ? { ...e,[future]:1 } as unknown as Entry : e));
      await r.install(unlisted);
      const verified = await ops.verify({cwd:r.cwd}); assert.equal(verified.ok,false,kind);
      assert.match(verified.error!,kind === 'grant' || kind === 'refresh' ? /unknown field/ : /needs a newer owed/);
    }
    await r.install(es);
    const grant = es.find(e => e.kind === 'grant')!;
    const prefix = R.reduce(es.slice(0,grant.seq),r.lookup);
    assert.deepEqual(R.grantErrors(prefix,grant as Extract<Draft,{kind:'grant'}>),[]);
    const status = await cli(r.cwd,['status','--json']); assert.equal(status.code,0,status.stderr);
  } finally { await r.cleanup(); }
});

test('RC2: append marks present registry fields after validation and before hashing; absent fields keep historical bytes', { timeout:120_000 }, async () => {
  const r = await fixture();
  try {
    assert.ok(storage.IGNORABLE,'writer exports one ignorable registry');
    assert.deepEqual(storage.IGNORABLE.waive,['tracked_by']); assert.deepEqual(storage.IGNORABLE.obs,['quarantine_passed']);
    const s = R.reduce(r.entries,r.lookup), c = s.nodes.a!.candidate!;
    const observation = { kind:'obs',by:'executor:owed',subject:'a',obligation:'check:unit',key:c.keys['check:unit']!,verdict:'pass',exit:0,durationMs:1,commit:c.commit,base:c.base,quarantine_passed:['once-red'] } as Draft;
    const passed = await appendChecked(r,observation);
    assert.deepEqual(passed.ignorable,['quarantine_passed']); assert.equal(storage.entryHash(passed),passed.hash);
    assert.equal(observation.ignorable,undefined,'append does not mutate the validated draft');
    const waived = await appendChecked(r,{ kind:'waive',by:'owner:pi',channel:'delegated',node:'a',obligation:'check:unit',key:c.keys['check:unit']!,reason:'track separately',tracked_by:'fix' } as Draft);
    assert.deepEqual(waived.ignorable,['tracked_by']);
    const ordinary = await appendChecked(r,{ kind:'obs',by:'executor:owed',subject:'a',obligation:'writes',key:c.keys.writes!,verdict:'pass',exit:0,durationMs:1,commit:c.commit,base:c.base,quarantine_passed:undefined } as Draft);
    assert.equal(Object.hasOwn(ordinary,'ignorable'),false);
    const originalRegistry = storage.IGNORABLE.obs;
    try {
      storage.IGNORABLE.obs = [future,'quarantine_passed'];
      const synthetic = await appendChecked(r,{ ...observation,[future]:false,ignorable:[future] } as unknown as Draft);
      assert.deepEqual(synthetic.ignorable,[future,'quarantine_passed']);
    } finally { storage.IGNORABLE.obs = originalRegistry; }
    const es = await r.ledger.read(); await acceptedMetadata(r,es);
    const tagged = es.filter(e => e.ignorable !== undefined);
    assert.ok(tagged.length >= 3);
    const stripped = rehash(es.map(e => {
      const fields = { ...e } as Entry & Record<string,unknown>;
      for (const name of e.ignorable ?? []) delete fields[name];
      delete fields.ignorable; return fields;
    }));
    assert.deepEqual(semantics(R.reduce(es,r.lookup)),semantics(R.reduce(stripped,r.lookup)),'display-only registry fields cannot change gates');
    assert.equal(R.reduce(es,r.lookup).nodes.a!.items.find(i => i.obligation === 'check:unit')!.status,'W','diagnostics do not replace the owner waiver');
  } finally { await r.cleanup(); }
});

test('RC2/RC3: tracked_by is act content, ignorable is not; CLI retries preserve the old waiver identity', { timeout:120_000 }, async () => {
  const r = await fixture();
  try {
    const c = R.reduce(r.entries,r.lookup).nodes.a!.candidate!;
    const draft = { kind:'waive',by:'owner:pi',channel:'delegated',node:'a',obligation:'check:unit',key:c.keys['check:unit']!,reason:'retry identity' } as const;
    const tracked = await appendChecked(r,{ ...draft,tracked_by:'fix' } as Draft);
    assert.deepEqual(tracked.ignorable,['tracked_by']);
    assert.notEqual(actContent(tracked),actContent(draft));
    assert.notEqual(actContent(tracked),actContent({ ...draft,tracked_by:'other-fix' } as Draft));
    assert.equal(actContent({ ...tracked,ignorable:[future], [future]:1 } as unknown as Draft),actContent(tracked));
    assert.equal(actContent(draft),`{"accept_risk":[],"key":"${c.keys['check:unit']}","reason":"retry identity"}`);
    const args = ['waive','a','check:unit','--reason','retry identity','--as','owner:pi'];
    const first = await cli(r.cwd,args); assert.equal(first.code,0,first.stderr); assert.doesNotMatch(first.stdout,/already recorded/);
    const es = await r.ledger.read(), last = es.at(-1)!; assert.equal(last.kind,'waive'); assert.ok(last.seq > tracked.seq);
    const retry = await cli(r.cwd,args); assert.equal(retry.code,0,retry.stderr); assert.equal(retry.stdout,`already recorded as #${last.seq}\n`);
    assert.deepEqual(await r.ledger.read(),es);
    const legacy = R.reduce(r.entries,r.lookup), split = Math.floor(r.entries.length/2);
    assert.equal(R.sameReplay(legacy,R.reduceFrom(R.reduce(r.entries.slice(0,split),r.lookup),r.entries.slice(split),r.lookup)),true);
    assert.equal(R.sameReplay(legacy,R.unpackState(structuredClone(R.packState(legacy)),r.lookup)),true);
  } finally { await r.cleanup(); }
});

test('RC1: ignorable future node on an atomic decision never enters validation or changes the decided nodes', { timeout:120_000 }, async () => {
  const r = await fixture();
  try {
    await ops.decide({ cwd:r.cwd,nodes:'a',as:owner,channel:'delegated',text:'keep the existing candidate',resume:true });
    const old = await r.ledger.read(), rule = old.findLast(e => e.kind === 'rule' && e.decision !== undefined)!;
    assert.ok(rule);
    const before = await ops.summaryStatusView(r.cwd,r.ledger.dir,R.reduce(old,r.lookup),old,now);
    const debt = await ops.brief({cwd:r.cwd,now});
    const report = await ops.report({cwd:r.cwd});
    const es = decorate(old,rule.seq,{ node:'outside-the-decision', [future]:['diagnostic'] });
    assert.deepEqual(semantics(await acceptedMetadata(r,es)),semantics(R.reduce(old,r.lookup)));
    assert.deepEqual(publicSemantics(await ops.summaryStatusView(r.cwd,r.ledger.dir,R.reduce(es,r.lookup),es,now)),publicSemantics(before));
    assert.deepEqual(publicSemantics(await ops.brief({cwd:r.cwd,now})),publicSemantics(debt));
    assert.deepEqual(publicSemantics(await ops.report({cwd:r.cwd})),publicSemantics(report));
    assert.equal((await ops.verify({cwd:r.cwd})).ok,true);
  } finally { await r.cleanup(); }
});
