// PR1–PR4: diagnostic measurements retain exact-tree receipts without changing acceptance.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical, sha256 } from '../src/canon.ts';
import { Ledger } from '../src/ledger.ts';
import { git } from '../src/git.ts';
import { reduce, sameReplay } from '../src/reducer.ts';
import { parsePlan } from '../src/plan.ts';
import { validateArgv } from '../src/cli.ts';
import * as ops from '../src/ops.ts';
import owed from '../src/extension.ts';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const pass = `echo 'owed-counts {"pass":1,"fail":0}'`;
const conditional = `test "$(cat value)" = good && { ${pass}; exit 0; }; echo 'owed-counts {"pass":0,"fail":1}'; exit 1`;
const planText = (extra: object = {}) => JSON.stringify({version:1,trunk:'main',lease:false,closure:[],invariants:[{id:'inv',run:pass,min_tests:1}],nodes:[{id:'a',writes:['value'],checks:[{id:'gate',run:conditional,min_tests:1}]}],...extra});
async function fixture(extra: object = {}) {
  const r = await repo(), red = await commitAt(r.cwd,{value:'bad'}), green = await commitAt(r.cwd,{value:'good'}), text = planText(extra);
  await r.put('plan.json',text);
  await ops.init({cwd:r.cwd,plan:text,path:'plan.json',as:{role:'owner',id:'pi'},channel:'delegated',measure:false});
  return {...r,red,green,text};
}
function harness(cwd: string) {
  const tools = new Map<string,ToolDefinition>();
  owed({registerTool(t:ToolDefinition) { tools.set(t.name,t); },registerCommand() {},on() {}} as unknown as ExtensionAPI);
  return {tool:tools.get('owed_check_try')!,async call(args: object) { return tools.get('owed_check_try')!.execute('test',args,undefined,undefined,{cwd,hasUI:false} as Parameters<ToolDefinition['execute']>[4]); }};
}

test('PR1 ad-hoc CLI measures exact commits with setup/env/wrap and default thresholds', async () => {
  const r = await fixture({setup:'echo setup-ran',exec:{env:{TRY_RECEIPT:'kept'},wrap:'exec bash -lc {cmd}'}});
  try {
    await r.put('value','dirty');
    const result = await cli(r.cwd,['check','try','--run',`test "$TRY_RECEIPT" = kept || exit 127; ${conditional}`,'--red',r.red,'--green',r.green,'--plan','plan.json','--json']);
    assert.equal(result.code,0,result.stderr);
    const data = JSON.parse(result.stdout);
    assert.deepEqual(data.results.map((x: {verdict:string}) => x.verdict),['fail','pass']);
    for (const x of data.results) {
      assert.equal(x.tree,(await git(r.cwd,['rev-parse',`${x.commit}^{tree}`])).stdout.trim());
      assert.match(await readFile(x.log,'utf8'),/setup-ran/);
      assert.equal(x.receipt,undefined);
    }
    assert.equal((await (await Ledger.open(r.cwd)).read()).length,1);
    assert.equal(await readFile(join(r.cwd,'value'),'utf8'),'dirty');
  } finally { await r.cleanup(); }
});

test('PR1 zero-test and unknown-count ad-hoc successes are refused by ordinary runJob rules', async () => {
  const r = await fixture();
  try {
    for (const [run,verdict] of [[`echo 'owed-counts {"pass":0,"fail":0}'`,'fail'],['echo no-counts','error']] as const) {
      const result = await cli(r.cwd,['check','try','--run',run,'--green',r.green,'--plan','plan.json','--json']);
      assert.equal(result.code,1,result.stderr);
      const data = JSON.parse(result.stdout);
      assert.equal(data.results[0].verdict,verdict); assert.equal(data.results[0].ok,false);
    }
    const result = await cli(r.cwd,['check','try','--run',pass,'--green',r.green,'--min-tests','2','--timeout','4','--plan','plan.json','--json']);
    assert.equal(result.code,1,result.stderr); assert.equal(JSON.parse(result.stdout).results[0].verdict,'fail');
    const timed = await ops.checkTry({cwd:r.cwd,run:'sleep 5',timeout:1,red:r.red,plan:'plan.json',lease:false});
    assert.equal(timed.results[0]!.ok,false); assert.equal(timed.results[0]!.verdict,'error');
  } finally { await r.cleanup(); }
});

test('PR1/PR2 target forms, modifiers and dirty-tree requests refuse before measuring', async () => {
  const sides = ['--green','HEAD'];
  for (const args of [[],['a'],['--run','true','a','gate'],['--run','true','--invariant','inv'],['a','gate','--invariant','inv']]) {
    assert.throws(() => validateArgv(['check','try',...args,...sides]),/<node> <check>.*--invariant.*--run/);
  }
  for (const args of [['--run','true','--for','a'],['a','gate','--min-tests','1'],['--run','true','--timeout','0'],['--run','true','--min-tests','-1'],['--run','true','--min-tests','1.5']]) assert.throws(() => validateArgv(['check','try',...args,...sides]));
  const r = await fixture();
  try {
    const before = await (await Ledger.open(r.cwd)).read();
    await assert.rejects(ops.checkTry({cwd:r.cwd,run:pass,green:r.green,record:true,for:'absent',plan:'plan.json'}),/unknown.*node/);
    for (const green of ['WORKTREE','.',':0']) {
      const result = await cli(r.cwd,['check','try','--run',pass,'--green',green,'--record','--for','a','--plan','plan.json']);
      assert.equal(result.code,2,result.stderr);
    }
    assert.deepEqual(await (await Ledger.open(r.cwd)).read(),before);
  } finally { await r.cleanup(); }
});

test('PR2 two measured sides record canonical executor notes with source plan, tree and log hashes', async () => {
  const r = await fixture();
  try {
    const ledger = await Ledger.open(r.cwd), before = await ledger.read();
    // The receipt identifies the actual disk spec even when it is not the recorded law.
    await r.put('plan.json',planText({setup:'echo disk-plan'}));
    const result = await cli(r.cwd,['check','try','a','gate','--red',r.red,'--green',r.green,'--record','--plan','plan.json','--json']);
    assert.equal(result.code,0,result.stderr);
    const data = JSON.parse(result.stdout), entries = (await ledger.read()).slice(before.length);
    assert.equal(entries.length,2);
    for (const [i,e] of entries.entries()) {
      assert.ok(e.kind === 'note'); assert.equal(e.by,'executor:owed'); assert.match(e.text,/^try\/v1 /);
      const receipt = JSON.parse(e.text.slice(7)), measured = data.results[i];
      assert.equal(e.text,'try/v1 '+canonical(receipt));
      assert.equal(receipt.for,'a'); assert.deepEqual(receipt.target,{node:'a',check:'gate'});
      assert.equal(receipt.side,i ? 'green' : 'red'); assert.equal(receipt.commit,i ? r.green : r.red);
      assert.equal(receipt.tree,measured.tree); assert.equal(measured.receipt,e.seq);
      assert.equal(measured.log,join(ledger.dir,'blobs',receipt.log));
      assert.equal(sha256(await ledger.getBlob(receipt.log)),receipt.log);
      assert.equal(parsePlan((await ledger.getBlob(receipt.plan)).toString()).setup,'echo disk-plan');
      assert.deepEqual(receipt.counts,measured.counts); assert.equal(receipt.durationMs,measured.durationMs);
    }
    assert.equal((await ops.verify({cwd:r.cwd})).ok,true);
    const plain = await cli(r.cwd,['check','try','--run',pass,'--green',r.green,'--record','--for','a','--plan','plan.json']);
    assert.equal(plain.code,0,plain.stderr); assert.match(plain.stdout,/tree [a-f0-9]{12}.*receipt #\d+/);
    const last = (await ledger.read()).at(-1)!; assert.ok(last.kind === 'note');
    assert.deepEqual(JSON.parse(last.text.slice(7)).target,{run:pass,run_sha256:sha256(pass),min_tests:1,timeout_s:900});
  } finally { await r.cleanup(); }
});

test('PR2 ad-hoc tool parity, invariant receipts, failures recorded, and no automatic node association', async () => {
  const r = await fixture();
  try {
    const h = harness(r.cwd), ledger = await Ledger.open(r.cwd);
    for (const key of ['run','min_tests','timeout','record','for']) assert.ok((h.tool.parameters as {properties:Record<string,unknown>}).properties[key],key);
    const result = await h.call({run:pass,green:r.green,record:true,for:'a',min_tests:2,timeout:3,plan:'plan.json',no_lease:true});
    assert.equal(result.isError,true);
    let last = (await ledger.read()).at(-1)!; assert.ok(last.kind === 'note');
    let receipt = JSON.parse(last.text.slice(7)); assert.equal(receipt.verdict,'fail'); assert.equal(receipt.target.min_tests,2); assert.equal(receipt.target.timeout_s,3);
    const invariant = await h.call({invariant:'inv',green:r.green,record:true,for:'a',plan:'plan.json',no_lease:true});
    assert.notEqual(invariant.isError,true);
    last = (await ledger.read()).at(-1)!; assert.ok(last.kind === 'note'); receipt = JSON.parse(last.text.slice(7)); assert.deepEqual(receipt.target,{invariant:'inv'});
    const unknown = await h.call({run:'echo unknown-counts',green:r.green,record:true,for:'a',plan:'plan.json',no_lease:true});
    assert.equal(unknown.isError,true);
    last = (await ledger.read()).at(-1)!; assert.ok(last.kind === 'note'); assert.equal(JSON.parse(last.text.slice(7)).verdict,'error');
    const unbound = await ops.checkTry({cwd:r.cwd,run:pass,green:r.green,record:true,plan:'plan.json',lease:false});
    assert.ok(unbound.results[0]!.ok);
    last = (await ledger.read()).at(-1)!; assert.ok(last.kind === 'note'); assert.equal(JSON.parse(last.text.slice(7)).for,undefined);
    const why = await cli(r.cwd,['why','a','--full']); assert.equal(why.code,0,why.stderr);
    assert.doesNotMatch(why.stdout,new RegExp(`receipt #${last.seq} `));
    const invalid = await h.call({run:pass,invariant:'inv',green:r.green,plan:'plan.json'}); assert.equal(invalid.isError,true);
  } finally { await r.cleanup(); }
});

test('PR3 receipts survive reload and appear newest first, five short and all full; reducer stays unchanged', async () => {
  const r = await fixture();
  try {
    const ledger = await Ledger.open(r.cwd), before = await ledger.read(), beforeState = await ops.readState({cwd:r.cwd});
    const first = await ops.checkTry({cwd:r.cwd,node:'a',check:'gate',green:r.green,record:true,plan:'plan.json',lease:false});
    const original = (await ledger.read()).at(-1)!; assert.ok(original.kind === 'note');
    const data = JSON.parse(original.text.slice(7));
    await ledger.withLock(() => ledger.append([
      ...Array.from({length:5},(_,i) => ({kind:'note' as const,by:'executor:owed',text:'try/v1 '+canonical({...data,target:{run:`echo line-${i}\n${pass}`,run_sha256:sha256(pass),min_tests:1,timeout_s:900}})})),
      {kind:'note',by:'executor:owed',text:'try/v1 {bad'},
      {kind:'note',by:'executor:owed',text:'try/v1 null'},
      {kind:'note',by:'executor:owed',text:'try/v1 '+canonical({for:'a',target:{run:3}})},
    ]));
    const entries = await ledger.read(), notes = entries.filter(e => e.kind === 'note' && e.text.startsWith('try/v1 ')).slice(0,6).reverse();
    for (const full of [false,true]) {
      const result = await cli(r.cwd,['why','a',...(full ? ['--full'] : [])]); assert.equal(result.code,0,result.stderr);
      const lines = result.stdout.split('\n').filter(l => l.startsWith('receipt #'));
      assert.equal(lines.length,full ? 6 : 5);
      assert.deepEqual(lines.map(l => Number(l.match(/^receipt #(\d+)/)![1])),notes.slice(0,full ? 6 : 5).map(e => e.seq));
      assert.ok(lines.every(l => /on [a-f0-9]{12} \(tree [a-f0-9]{12}\): pass 1\/1 tests, log .*blobs\/[a-f0-9]{64}$/.test(l)),lines.join('\n'));
      if (full) assert.ok(lines.some(l => l.startsWith(`receipt #${first.results[0]!.receipt} a/gate `)));
    }
    // Replay resolves the stored law, before the reducer attaches its writes-syntax tag.
    const sourcePlan = parsePlan((await ledger.getBlob(beforeState.state.planSha)).toString());
    const lookup = () => sourcePlan;
    const replayed = reduce(entries,lookup), clean = reduce(before,lookup);
    assert.equal(sameReplay(replayed, (await ops.readState({cwd:r.cwd})).state),true);
    // Fold metadata advances for notes; all acceptance state is unchanged.
    assert.deepEqual({...replayed,seq:clean.seq,head:clean.head},clean);
    assert.equal((await ops.verify({cwd:r.cwd})).ok,true);
  } finally { await r.cleanup(); }
});

test('PR2 receipt append fails atomically after measurement; no ledger lock is held by the command', async () => {
  const r = await fixture();
  try {
    const ledger = await Ledger.open(r.cwd), marker = join(r.root,'ran'), before = await ledger.read();
    const append = Ledger.prototype.append;
    Ledger.prototype.append = async function(drafts) { if (drafts.some(d => d.kind === 'note' && d.text.startsWith('try/v1 '))) throw new Error('receipt append injected failure'); return append.call(this,drafts); };
    try {
      await assert.rejects(ops.checkTry({cwd:r.cwd,run:`test ! -e '${ledger.dir}/lock' || exit 127; echo ran > '${marker}'; ${pass}`,green:r.green,record:true,for:'a',plan:'plan.json',lease:false}),/receipt append injected failure/);
    } finally { Ledger.prototype.append = append; }
    assert.equal((await readFile(marker,'utf8')).trim(),'ran');
    assert.deepEqual(await ledger.read(),before);
    assert.equal((await git(r.cwd,['worktree','list','--porcelain'])).stdout.split('worktree ').length-1,1);
  } finally { await r.cleanup(); }
});
