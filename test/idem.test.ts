import test from 'node:test';
import assert from 'node:assert/strict';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';
import * as ops from '../src/ops.ts';
import { main } from '../src/cli.ts';
import * as git from '../src/git.ts';
import { Ledger, lockWait } from '../src/ledger.ts';
import { renderReceipt, renderReport } from '../src/views.ts';
import type { Draft, Entry } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

delete process.env.OWED_CONFIRM;
const owner = { role:'owner', id:'pi' } as const, parent = { role:'parent', id:'main' } as const;
const reviewer = { role:'reviewer', id:'r' } as const;
async function fixture(closure = false) {
  const r = await repo();
  try {
    await commitAt(r.cwd,{ README:'fixture\n', 'proof.txt':'proof\n', 'other.txt':'other\n', ...(closure ? {'closure.json':'{}\n'} : {}) });
    await ops.init({ cwd:r.cwd, as:owner, channel:'delegated', plan:JSON.stringify({ version:1, trunk:'main', closure:closure ? ['closure.json'] : [], invariants:[], nodes:[{
      id:'a', writes:['a.txt', ...(closure ? ['closure.json'] : [])], checks:[], review:{ count:2, min_rank:1 }, approve:'owner', evidence:[{ id:'ui', what:'checked UI' },{ id:'other', what:'other UI' }],
    }] }) });
    const slot = await ops.dispatch({ cwd:r.cwd, node:'a', as:parent });
    await commitAt(slot.worktree,{ 'a.txt':'done\n', ...(closure ? {'closure.json':'{"changed":true}\n'} : {}) });
    const submit = () => ops.submit({ cwd:slot.worktree, node:'a', as:{ role:'writer', id:'a#1' } });
    await submit();
    const ledger = await Ledger.open(r.cwd);
    const act = { cwd:r.cwd, node:'a', as:reviewer, verdict:'ok' as const, rank:1, note:'checked' };
    return { ...r, slot, ledger, submit, act, entries:() => ledger.read(),
      review:(extra:Partial<Parameters<typeof ops.review>[0]> = {}) => ops.review({ ...act, ...extra }),
      approve:(extra:Partial<Parameters<typeof ops.approve>[0]> = {}) => ops.approve({ cwd:r.cwd, node:'a', as:owner, channel:'delegated', note:'ship', ...extra }),
      evidence:(extra:Partial<Parameters<typeof ops.evidence>[0]> = {}) => ops.evidence({ cwd:r.cwd, node:'a', as:reviewer, id:'ui', files:['proof.txt'], note:'checked', ...extra }),
      waive:(extra:Partial<Parameters<typeof ops.waive>[0]> = {}) => ops.waive({ cwd:r.cwd, node:'a', as:owner, channel:'delegated', obligation:'review', reason:'accepted', ...extra }),
    };
  } catch(e) { await r.cleanup(); throw e; }
}

for (const args of [
  ['review','a','--ok','--rank','1','--note','checked','--as','reviewer:r'],
  ['review','a','--block','--needs-parent','--rank','2','--note','decision','--as','reviewer:r'],
  ['approve','a','--note','ship'], ['approve','a','--block','--note','wait'],
  ['evidence','a','ui','--file','proof.txt','--note','checked','--as','reviewer:r'],
  ['waive','a','review','--reason','accepted'],
]) test(`ID1 CLI: identical ${args.join(' ')} exits zero and appends nothing`, async () => {
  const f = await fixture();
  try {
    const first = await cli(f.cwd,args); assert.equal(first.code,0,first.stderr);
    const before = await f.entries(), seq = before.at(-1)!.seq;
    const retry = await cli(f.cwd,args);
    assert.equal(retry.code,0,retry.stderr); assert.equal(retry.stdout,`already recorded as #${seq}\n`);
    assert.deepEqual(await f.entries(),before);
  } finally { await f.cleanup(); }
});

test('ID1: note, rank, acknowledgment set, needs-parent and latest A,B,A remain distinct', async () => {
  const f = await fixture();
  try {
    const a = await f.review(), b = await f.review({ note:'different' }), again = await f.review();
    assert.ok(a.seq < b.seq && b.seq < again.seq);
    assert.ok((await f.review({ rank:2 })).seq > again.seq);
    const rule = await ops.rule({ cwd:f.cwd, as:parent, nodes:['a'], text:'check edge' });
    const ack = await f.review({ ack_rulings:rule.seq });
    assert.ok(ack.seq > again.seq);
    const unrelated = await ops.rule({ cwd:f.cwd, as:parent, nodes:'*', prospective:true, text:'future only' });
    const before = await f.entries();
    const sameSet = await f.review({ ack_rulings:unrelated.seq });
    assert.equal(sameSet.seq,ack.seq,'watermarks acknowledging the same applicable set are identical');
    assert.deepEqual(await f.entries(),before);
    await assert.rejects(f.review({ ack_rulings:unrelated.seq + 100 }),/future rulings/);
    const block = await f.review({ verdict:'block' });
    assert.ok((await f.review({ verdict:'block', needs:'parent' })).seq > block.seq);
    assert.equal((await ops.readState({cwd:f.cwd})).state.nodes.a!.accepted,false,'repeated reviews cannot satisfy two principals');
  } finally { await f.cleanup(); }
});

test('ID1: evidence compares file digests as a set and does not skip unreadable files or a changed candidate', async () => {
  const f = await fixture();
  try {
    const first = await f.evidence({ files:['proof.txt','other.txt'] });
    assert.equal((await f.evidence({ files:['other.txt','proof.txt'] })).seq,first.seq);
    await f.put('proof.txt','changed bytes\n');
    assert.ok((await f.evidence({ files:['other.txt','proof.txt'] })).seq > first.seq);
    const changed = await f.evidence({ note:'B' }), again = await f.evidence();
    assert.ok(again.seq > changed.seq);
    assert.ok((await f.evidence({ id:'other' })).seq > again.seq);
    await assert.rejects(f.evidence({ files:['missing'] }),/cannot read/);
    await f.review(); const before = (await f.entries()).length;
    await f.submit(); const next = await f.review();
    assert.equal((await f.entries()).length,before + 2); assert.equal(next.kind,'review');
    const candidate = (await ops.readState({cwd:f.cwd})).state.nodes.a!.candidate!;
    await commitAt(f.slot.worktree,{ 'a.txt':'new candidate\n' }); await f.submit();
    const n = (await f.entries()).length;
    await assert.rejects(f.review({ named:candidate.commit }),/candidate changed/);
    assert.equal((await f.entries()).length,n);
  } finally { await f.cleanup(); }
});

test('ID1: approval and waiver changed content and A,B,A append; consumed accept-risk retries succeed', async () => {
  const f = await fixture();
  try {
    const a = await f.approve(), b = await f.approve({ note:'B' }), c = await f.approve();
    assert.ok(a.seq < b.seq && b.seq < c.seq);
    const wa = await f.waive(), wb = await f.waive({ reason:'B' }), wc = await f.waive();
    assert.ok(wa.seq < wb.seq && wb.seq < wc.seq);
    const block = await f.review({ verdict:'block' });
    const second = await f.review({ verdict:'block', as:{role:'reviewer',id:'other'} });
    const risk = await f.waive({ accept_risk:[block.seq] });
    const before = await f.entries();
    const retry = await f.waive({ accept_risk:[block.seq] });
    assert.equal(retry.seq,risk.seq); assert.deepEqual(await f.entries(),before);
    assert.ok((await f.waive({ accept_risk:[second.seq] })).seq > risk.seq);
    await assert.rejects(f.waive({ accept_risk:[block.seq], reason:'new judgment' }),/active blocks/);
  } finally { await f.cleanup(); }
});

test('ID-W1: a changed current merge key cannot reuse the previous waiver', async () => {
  const r = await repo();
  try {
    await commitAt(r.cwd,{ README:'fixture\n' });
    const pass = `echo 'owed-counts {"pass":1,"fail":0}'`, fail = `echo 'owed-counts {"pass":0,"fail":1,"failed":["merge failure"]}'; exit 1`;
    await ops.init({ cwd:r.cwd, as:owner, channel:'delegated', plan:JSON.stringify({ version:1, trunk:'main', closure:[], invariants:[], nodes:[
      { id:'a', writes:['src/a'], checks:[{ id:'unit', run:`if [ -e src/b ]; then ${fail}; else ${pass}; fi`, reads:['src/'] }], review:{count:0,min_rank:1} },
      ...['b','c'].map(id => ({id,writes:[`src/${id}`],checks:[],review:{count:0,min_rank:1}})),
    ] }) });
    for (const id of ['a','b','c']) {
      const slot = await ops.dispatch({cwd:r.cwd,node:id,as:parent});
      await commitAt(slot.worktree,{[`src/${id}`]:`${id}\n`});
      await ops.submit({cwd:slot.worktree,node:id,as:{role:'writer',id:`${id}#1`}});
      await ops.attest({cwd:r.cwd,node:id});
    }
    await ops.merge({cwd:r.cwd,node:'b',as:parent});
    await assert.rejects(ops.merge({cwd:r.cwd,node:'a',as:parent}));
    const ledger = await Ledger.open(r.cwd), failure = (await ledger.read()).find(e => e.kind === 'obs' && e.merging === 'a' && e.verdict === 'fail');
    assert.ok(failure?.kind === 'obs');
    // A confirming attribution rerun clears the block, so the waiver binds the merge key.
    await ops.attest({cwd:r.cwd,node:'a'});
    const args = {cwd:r.cwd,node:'a',as:owner,channel:'delegated' as const,obligation:'check:unit',reason:'accepted',accept_risk:[failure.seq]};
    const waived = await ops.waive(args);
    assert.ok(waived.kind === 'waive'); assert.equal(waived.key,failure.key);
    assert.equal((await ops.waive(args)).alreadyRecorded,waived.seq,'unchanged merge keys still deduplicate');
    await ops.merge({cwd:r.cwd,node:'c',as:parent});
    const {state} = await ops.readState({cwd:r.cwd}), n = state.nodes.a!;
    const merged = await git.buildMerge(r.cwd,state.trunk.commit,n.candidate!.commit,'ID-W1 regression');
    assert.ok(!('conflicts' in merged));
    const current = await git.candidateFacts(r.cwd,state.plan,state.plan.nodes.find(n => n.id === 'a')!,state.trunk.commit,merged.commit,n.slot!.attempt);
    assert.notEqual(current.keys['check:unit'],waived.key,'trunk movement changed the normal waiver key');
    const before = await ledger.read();
    const retry = await cli(r.cwd,['waive','a','check:unit','--reason','accepted','--accept-risk',String(failure.seq)]);
    assert.equal(retry.code,1,retry.stderr); assert.match(retry.stderr,/^Refused: accept_risk must reference active blocks/);
    assert.doesNotMatch(retry.stdout,/already recorded/); assert.deepEqual(await ledger.read(),before);
  } finally { await r.cleanup(); }
});

test('ID1: closure-review has its own retry stream, and accept-risk ordering is a set', async () => {
  const f = await fixture(true);
  try {
    const ordinary = await f.review({ rank:2 });
    const closure = await f.review({ rank:2, obligation:'closure-review' });
    assert.ok(closure.seq > ordinary.seq);
    assert.equal((await f.review({rank:2})).seq,ordinary.seq);
    assert.equal((await f.review({rank:2,obligation:'closure-review'})).seq,closure.seq);
    const a = await f.review({verdict:'block'}), b = await f.review({verdict:'block',as:{role:'reviewer',id:'other'}});
    const waived = await f.waive({accept_risk:[a.seq,b.seq]});
    const before = await f.entries();
    assert.equal((await f.waive({accept_risk:[b.seq,a.seq]})).seq,waived.seq);
    assert.deepEqual(await f.entries(),before);
  } finally { await f.cleanup(); }
});

test('ID1: concurrent identical retries append once, while other principals append normally', async () => {
  const f = await fixture();
  try {
    const before = (await f.entries()).length;
    const [a,b] = await Promise.all([f.review(),f.review()]);
    assert.equal(a.seq,b.seq); assert.equal((await f.entries()).length,before + 1);
    assert.ok((await f.review({ as:{role:'reviewer',id:'other'} })).seq > a.seq);
    await f.submit();
    assert.ok((await f.review()).seq > b.seq,'an identical act on a new candidate still appends');
  } finally { await f.cleanup(); }
});

async function historicalDuplicate(ledger:Ledger, entry:Entry): Promise<Entry> {
  const { seq:_seq, ts:_ts, prev:_prev, hash:_hash, ...draft } = entry;
  return ledger.withLock(async () => (await ledger.append([draft as Draft]))[0]!);
}
test('ID2: why reviews and rulings/acks collapse historical duplicates; JSON and replay stay unchanged', async () => {
  const f = await fixture();
  try {
    const rule = await ops.rule({ cwd:f.cwd, as:parent, nodes:['a'], text:'read this' });
    const first = await f.review({ ack_rulings:rule.seq });
    await historicalDuplicate(f.ledger,first);
    const card = await ops.why({cwd:f.cwd,node:'a'}), json = JSON.stringify(card);
    const text = renderReceipt(card), lines = text.split('\n');
    assert.match(lines.find(l => l.includes('a/review —'))!,/reviewer:r rank=1 ×2/);
    assert.match(lines.find(l => l.includes('a/rulings —'))!,/reviewer:r rank=1 ×2/);
    assert.equal(JSON.stringify(card),json);
    assert.equal((await ops.readState({cwd:f.cwd})).state.nodes.a!.accepted,false);
    assert.equal((await ops.verify({cwd:f.cwd})).ok,true);
    const jsonCLI = await cli(f.cwd,['why','a','--json']); assert.equal(jsonCLI.code,0,jsonCLI.stderr);
    assert.deepEqual(JSON.parse(jsonCLI.stdout),JSON.parse(json));
  } finally { await f.cleanup(); }
});

test('ID2: report text collapses identical owner acts and waivers but keeps A,B,A and JSON rows', async () => {
  const f = await fixture();
  try {
    const approved = await f.approve(); await historicalDuplicate(f.ledger,approved);
    const waived = await f.waive(); await historicalDuplicate(f.ledger,waived);
    const report = await ops.report({cwd:f.cwd}), json = JSON.stringify(report), text = renderReport(report);
    assert.match(text,/reviewed a\/approve ok rank=3: ship ×2/);
    assert.match(text,/waived a\/review: accepted ×2/);
    assert.equal(report.waivers.length,2); assert.equal(JSON.stringify(report),json);
    await f.approve({note:'B'}); await f.approve();
    const later = renderReport(await ops.report({cwd:f.cwd,since:approved.seq + 1}));
    assert.equal((later.match(/reviewed a\/approve ok/g) ?? []).length,2);
    assert.doesNotMatch(later,/ship ×2/);
    assert.equal((await ops.verify({cwd:f.cwd})).ok,true);
  } finally { await f.cleanup(); }
});

test('ID1 pi tools: every repeated act returns the exact success text, never an error', async () => {
  const f = await fixture();
  try {
    const tools = new Map<string,ToolDefinition>();
    owed({registerTool(t:ToolDefinition){ tools.set(t.name,t); },registerCommand(){}} as unknown as ExtensionAPI);
    const ctx = {cwd:f.cwd,hasUI:false} as ExtensionContext;
    for (const [name,args] of [
      ['review',{as:'reviewer:r',verdict:'ok',rank:1,note:'checked'}],
      ['approve',{note:'ship'}], ['approve',{note:'wait',block:true}],
      ['evidence',{as:'reviewer:r',id:'ui',files:['proof.txt'],note:'checked'}],
      ['waive',{obligation:'review',reason:'accepted'}],
    ] as const) {
      const tool = tools.get(`owed_${name}`)!;
      const call = () => tool.execute('idem',{node:'a',...args},undefined,undefined,ctx as Parameters<ToolDefinition['execute']>[4]) as Promise<{isError?:boolean;details:Entry;content:{type:string;text?:string}[]}>;
      const first = await call(); assert.notEqual(first.isError,true,JSON.stringify(first));
      const before = await f.entries(), retry = await call();
      assert.notEqual(retry.isError,true,JSON.stringify(retry));
      assert.equal(retry.content[0]!.text,`already recorded as #${first.details.seq}`);
      assert.deepEqual(await f.entries(),before);
    }
  } finally { await f.cleanup(); }
});

test('ID3: a busy ledger is exit 75 with stderr starting Busy:, never success output matching', async () => {
  const f = await fixture(), wait = lockWait.ms, previousCwd = process.cwd();
  try {
    const lines:string[] = [], errors:string[] = [];
    lockWait.ms = 0; process.chdir(f.cwd);
    await f.ledger.withLock(async () => {
      const code = await main(['review','a','--ok','--rank','1','--note','checked','--as','reviewer:r'],{log:l => lines.push(l),error:l => errors.push(l)});
      assert.equal(code,75); assert.match(errors.join('\n'),/^Busy:/); assert.deepEqual(lines,[]);
    });
    const ok = await cli(f.cwd,['review','a','--ok','--rank','1','--note','Busy: success text','--as','reviewer:r']);
    assert.equal(ok.code,0,ok.stderr); assert.match(ok.stdout,/Busy: success text/);
  } finally { lockWait.ms = wait; process.chdir(previousCwd); await f.cleanup(); }
});
