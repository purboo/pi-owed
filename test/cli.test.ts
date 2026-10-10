import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repo } from './helpers/repo.ts';
import { cli, commitAt, planText, seed, checkTest } from './helpers/surface.ts';
import { revParse } from '../src/git.ts';
import type { DispatchPacket, AttestResult, ReceiptCard, StatusView } from '../src/ops.ts';
// D25.4: these tests exercise the owner confirmation (dialog or TTY prompt), now the opt-in gate OWED_CONFIRM=owner.
process.env.OWED_CONFIRM = 'owner';

test('CLI real processes: DAG, laundering, closure, writes, invariant defer, CAS and tamper', {timeout:120_000}, async () => {
  const r=await repo();
  try {
    const base=await seed(r.cwd), plan=join(r.root,'plan.yaml'); await writeFile(plan,planText);
    async function call<T>(cwd:string,args:string[],code=0):Promise<T> { const out=await cli(cwd,[...args,'--json']); assert.equal(out.code,code,`${args.join(' ')}\n${out.stderr}\n${out.stdout}`); return JSON.parse(out.stdout) as T; }
    assert.equal((await cli(r.cwd,['--help'])).code,0);
    assert.equal((await cli(r.cwd,['wat'])).code,2);
    assert.equal((await cli(r.cwd,['init',plan])).code,1);
    { const pre=await cli(r.cwd,['status']); assert.equal(pre.code,1); assert.match(pre.stderr,/Not initialized/); }
    await call(r.cwd,['init',plan,'--i-am-owner']);
    { const text=await cli(r.cwd,['report']); assert.equal(text.code,0); assert.match(text.stdout,/initialized ledger/); assert.doesNotMatch(text.stdout,/"kind"/); }
    await call(r.cwd,['rule','Keep tests meaningful','--nodes','*']);
    const a=await call<DispatchPacket>(r.cwd,['dispatch','a']); assert.match(a.packet,/owed submit a/); assert.match(a.packet,/Keep tests meaningful/); assert.equal(a.subagent.cwd,a.worktree);
    await commitAt(a.worktree,{'test/a.cjs':'module.exports=1;','test/a.test.cjs':checkTest('a',1)});
    await call(a.worktree,['submit','a']);
    const aa=await call<AttestResult>(r.cwd,['attest','a']); assert.equal(aa.accepted,true); assert.ok(aa.receipt.items.every(i => i.mark === '✔'));
    await call(r.cwd,['merge','a']); assert.notEqual(await revParse(r.cwd,'main'),base);
    assert.deepEqual((await call<StatusView>(r.cwd,['status'])).ready,['b']);
    const b=await call<DispatchPacket>(r.cwd,['dispatch','b']);
    await commitAt(b.worktree,{'test/b.test.cjs':checkTest('b',1)}); await call(b.worktree,['submit','b']);
    const failed=await call<AttestResult>(r.cwd,['attest','b'],1); assert.ok(failed.receipt.blocks.some(x => x.obligation === 'check:b'));
    await commitAt(b.worktree,{'test/b.test.cjs':"require('node:test').test('vacuous',()=>{});"}); await call(b.worktree,['submit','b']);
    assert.equal((await call<ReceiptCard>(r.cwd,['why','b'])).accepted,false);
    const launder=await call<AttestResult>(r.cwd,['attest','b'],1);
    assert.equal(launder.observations[0]?.kind,'obs'); assert.ok(launder.observations.some(e => e.kind === 'obs' && e.attribution && e.verdict === 'fail'));
    assert.ok(!launder.receipt.blocks.some(x => x.obligation === 'check:b'));
    assert.ok(launder.receipt.blocks.some(x => x.obligation === 'red:b'));
    await commitAt(b.worktree,{'test/b.cjs':'module.exports=1;','test/b.test.cjs':checkTest('b',1),'test/helper.cjs':'module.exports=1;'}); await call(b.worktree,['submit','b']);
    const closure=await call<AttestResult>(r.cwd,['attest','b'],1); assert.ok(closure.receipt.items.some(i => i.obligation === 'closure-review' && i.status === 'D'));
    // A helper change is pinned away: candidate passes only if helper=1, executor must still see base helper=0.
    await commitAt(b.worktree,{'test/b.test.cjs':checkTest('b',1)+"require('node:test').test('closure',()=>require('node:assert/strict').equal(require('./helper.cjs'),1));"}); await call(b.worktree,['submit','b']);
    const pinned=await call<AttestResult>(r.cwd,['attest','b'],1); assert.ok(pinned.observations.some(e => e.kind === 'obs' && e.obligation === 'check:b' && e.verdict === 'fail'));
    await commitAt(b.worktree,{'test/b.test.cjs':checkTest('b',1),'outside.txt':'violation'}); await call(b.worktree,['submit','b']);
    const violation=await call<AttestResult>(r.cwd,['attest','b'],1); assert.ok(violation.observations.some(e => e.kind === 'obs' && e.obligation === 'writes' && e.verdict === 'fail'));
    assert.equal((await cli(r.cwd,['merge','b'])).code,1);
    const {git}=await import('../src/git.ts'); await git(b.worktree,['rm','outside.txt']);
    await commitAt(b.worktree,{'test/state.cjs':'module.exports=0;'}); await call(b.worktree,['submit','b']); await call(r.cwd,['attest','b'],1);
    await call(r.cwd,['review','b','--obligation','closure-review','--ok','--rank','2','--as','reviewer:fresh']);
    assert.equal((await call<ReceiptCard>(r.cwd,['why','b'])).accepted,true);
    const inv=await cli(r.cwd,['merge','b']); assert.equal(inv.code,1); assert.match(inv.stderr,/invariant unit/);
    await call(r.cwd,['defer','b','unit','--reason','repair later','--i-am-owner']);
    const before=await revParse(r.cwd,'main'); await commitAt(r.cwd,{'unrelated.txt':'external move'});
    const cas=await cli(r.cwd,['merge','b']); assert.equal(cas.code,1); assert.match(cas.stderr,/CAS/);
    // Restore only this isolated fixture's external test commit to exercise the successful defer path.
    await git(r.cwd,['reset','--hard',before]);
    const merged=await call<{deferred:unknown[]}>(r.cwd,['merge','b']); assert.equal(merged.deferred.length,1);
    const report=await cli(r.cwd,['report']); assert.match(report.stdout,/flag/); assert.match(report.stdout,/deferred|defer/);
    assert.match((await cli(r.cwd,['status'])).stdout,/flag weak confirmation/);
    assert.match((await cli(r.cwd,['why','a'])).stdout,/flag weak confirmation/);
    await call(r.cwd,['verify']);
    const ledger=join(r.root,'ledger','ledger.jsonl'), lines=(await readFile(ledger,'utf8')).split('\n'), first=JSON.parse(lines[0]!); first.by='owner:tampered'; lines[0]=JSON.stringify(first); await writeFile(ledger,lines.join('\n'));
    const tampered=await cli(r.cwd,['verify']); assert.equal(tampered.code,3); assert.match(tampered.stdout,/invalid hash/);
  } finally { await r.cleanup(); }
});

test('CLI usage validation and owner channel refusal', async () => {
  const r=await repo(); try { await seed(r.cwd); for(const args of [['review','b','--ok','--block'],['status','extra'],['status','--commit','HEAD'],['status','--as','bad'],['attest','a','--unknown'],['report','--since']]) assert.equal((await cli(r.cwd,args)).code,2,args.join(' ')); assert.equal((await cli(r.cwd,['plan','missing','--as','owner:human'])).code,1); } finally { await r.cleanup(); }
});
