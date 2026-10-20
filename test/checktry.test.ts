// CT1–CT2: author diagnostics never become acceptance observations.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonical, sha256 } from '../src/canon.ts';
import { parsePlan } from '../src/plan.ts';
import { editText } from '../src/edit.ts';
import { Ledger } from '../src/ledger.ts';
import { candidateFacts, git, stateFacts } from '../src/git.ts';
import { checkDefinition, invalidates, specChanges } from '../src/reducer.ts';
import * as ops from '../src/ops.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';
import owed from '../src/extension.ts';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
function harness(cwd:string) {
  const tools=new Map<string,ToolDefinition>(); owed({registerTool(t:ToolDefinition) {tools.set(t.name,t);},registerCommand() {},on() {}} as unknown as ExtensionAPI);
  return {async call(name:string,args:object) { const tool=tools.get(`owed_${name}`); assert.ok(tool); return tool.execute('test',args,undefined,undefined,{cwd,hasUI:false} as Parameters<ToolDefinition['execute']>[4]); }};
}

const owner = {role:'owner',id:'pi'} as const;
const run = `if [ "$(cat value)" = good ]; then echo 'owed-counts {"pass":1,"fail":0}'; else echo 'failure detail'; echo 'owed-counts {"pass":0,"fail":1}'; exit 1; fi`;
const text = (check: object = {}, extra: object = {}) => JSON.stringify({version:1,trunk:'main',lease:false,closure:[],invariants:[],nodes:[{id:'a',writes:['value'],checks:[{id:'gate',run,min_tests:1,timeout_s:5,...check}]}],...extra});
const init = (cwd:string,plan:string,path = 'plan.json') => ops.init({cwd,plan,path,as:owner,channel:'delegated',measure:false});
async function fixture() { const r=await repo(); const red=await commitAt(r.cwd,{value:'bad'}), green=await commitAt(r.cwd,{value:'good'}); await r.put('plan.json',text()); return {...r,red,green}; }

test('CT red: CLI check try meets fail/pass on exact commits, stores logs but no entries', async () => {
  const r=await fixture();
  try {
    await r.put('plan.json',text({red:true,tests:['missing-test'],reads:['value']},{closure:['value'],exec:{trees:'reuse'}}));
    const result=await cli(r.cwd,['check','try','a','gate','--red',r.red,'--green',r.green,'--plan','plan.json','--no-lease','--json']);
    assert.equal(result.code,0,result.stderr); const data=JSON.parse(result.stdout);
    assert.equal(data.node,'a'); assert.equal(data.check,'gate'); assert.equal(data.plan,'plan.json');
    assert.deepEqual(data.results.map((x: {verdict:string;ok:boolean}) => [x.verdict,x.ok]),[['fail',true],['pass',true]]);
    assert.match(await readFile(data.results[0].log,'utf8'),/failure detail/);
    assert.deepEqual(await (await Ledger.open(r.cwd)).read(),[]);
    const plain=await cli(r.cwd,['check','try','a','gate','--red',r.red,'--plan','plan.json']); assert.match(plain.stdout,/red .*\(.*tree [a-f0-9]{12}\): fail ✔ \(0\/1 tests, .* s\) log /);
  } finally { await r.cleanup(); }
});

test('CT1 unmet expectation prints last 20 lines; errors never meet fail; usage is 2', async () => {
  const r=await fixture();
  try {
    await r.put('plan.json',text({run:"for i in $(seq 1 30); do echo tail-$i; done; echo 'owed-counts {\"pass\":1,\"fail\":0}'"}));
    let result=await cli(r.cwd,['check','try','a','gate','--red',r.green,'--plan','plan.json']);
    assert.equal(result.code,1,result.stderr); assert.match(result.stdout,/✘ expected fail, got pass/); assert.match(result.stdout,/tail-30/); assert.doesNotMatch(result.stdout,/tail-1\n/);
    await r.put('plan.json',text({run:'owed-no-such-command'}));
    result=await cli(r.cwd,['check','try','a','gate','--red',r.red,'--plan','plan.json']); assert.equal(result.code,1); assert.match(result.stdout,/expected fail, got error/);
    for (const args of [['check','try','a','gate'],['check','try','--invariant','inv','a','--red',r.red],['check','bad','a','gate','--red',r.red]]) assert.equal((await cli(r.cwd,args)).code,2);
    assert.equal((await cli(r.cwd,['check','try','a','gate','--green','unknown','--plan','plan.json'])).code,2);
    assert.match((await cli(r.cwd,['help','check'])).stdout,/red:true is measured as an ordinary check/);
  } finally { await r.cleanup(); }
});

test('CT1 working-tree run_file before recording, invariant form, setup/env/wrap/repeat', async () => {
  const r=await fixture();
  try {
    const script='#!/bin/sh\ntest "$TRY_ENV" = kept || exit 127\n'+run+'\n'; await r.put('pinned.sh',script);
    await r.put('plan.json',text({}, {invariants:[{id:'inv',run_file:{path:'pinned.sh',sha256:sha256(script)},min_tests:1,repeat:{runs:2,need:2}}],setup:'echo setup-ran',exec:{env:{TRY_ENV:'kept'},wrap:'exec bash -lc {cmd}'}}));
    const result=await cli(r.cwd,['check','try','--invariant','inv','--red',r.red,'--green',r.green,'--plan','plan.json','--json']); assert.equal(result.code,0,result.stderr);
    const data=JSON.parse(result.stdout); assert.equal(data.invariant,'inv'); assert.equal(data.check,'inv');
    assert.match(await readFile(data.results[1].log,'utf8'),/setup-ran[\s\S]*run 2\/2/);
    assert.deepEqual(await (await Ledger.open(r.cwd)).read(),[]);
  } finally { await r.cleanup(); }
});

test('CT2 schema is strict, optional and editable for nodes and invariants', () => {
  const commit='a'.repeat(40), selftest=[{commit,expect:'pass'}];
  assert.deepEqual(parsePlan(text({selftest})).nodes[0]!.checks[0]!.selftest,selftest);
  assert.deepEqual(parsePlan(editText(text(),{node:'a',set:[`checks.gate.selftest=${JSON.stringify(selftest)}`]})).nodes[0]!.checks[0]!.selftest,selftest);
  assert.deepEqual(parsePlan(editText(text({}, {invariants:[{id:'inv',run:'true'}]}),{invariant:'inv',set:[`selftest=${JSON.stringify(selftest)}`]})).invariants[0]!.selftest,selftest);
  for (const value of [[],Array(9).fill(selftest[0]),[{commit:'main',expect:'pass'}],[{commit,expect:'error'}],[{commit,expect:'pass',extra:true}],null]) assert.throws(() => parsePlan(text({selftest:value})),/selftest/);
  assert.equal(parsePlan(text({selftest:[{commit:'b'.repeat(64),expect:'fail'}]})).nodes[0]!.checks[0]!.selftest!.length,1);
});

test('CT2 initial refusal appends nothing; success appends genesis and note in one append', async () => {
  const r=await fixture();
  try {
    const ledger=await Ledger.open(r.cwd);
    await assert.rejects(init(r.cwd,text({selftest:[{commit:r.red,expect:'pass'}]})),/expected pass, got fail[\s\S]*failure detail/); assert.deepEqual(await ledger.read(),[]);
    await assert.rejects(init(r.cwd,text({selftest:[{commit:'0'.repeat(40),expect:'fail'}]})),/expected fail, got error[\s\S]*unknown commit/); assert.deepEqual(await ledger.read(),[]);
    const result=await init(r.cwd,text({selftest:[{commit:r.red,expect:'fail'},{commit:r.green,expect:'pass'}]}));
    const entries=await ledger.read(); assert.deepEqual(entries.map(e => e.kind),['genesis','note']);
    assert.ok(entries[1]!.kind === 'note'); const note=JSON.parse(entries[1].text.slice('selftest/v1 '.length)); assert.equal(note.plan,entries[0]!.kind === 'genesis' && entries[0]!.plan); assert.deepEqual(note.results.map((x: {verdict:string}) => x.verdict),['fail','pass']);
    assert.match(result.warnings!.join('\n'),/selftest .*: pass ✔/); assert.equal((await ops.verify({cwd:r.cwd})).ok,true);
  } finally { await r.cleanup(); }
});

test('CT2 plan refusal and failed edit preserve ledger and source; success note follows plan; unchanged not rerun', async () => {
  const r=await fixture();
  try {
    await init(r.cwd,text()); await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',plan:text(),path:'plan.json'}); const ledger=await Ledger.open(r.cwd), before=await ledger.read(), source=await readFile(join(r.cwd,'plan.json'),'utf8');
    const bad=[{commit:r.red,expect:'pass'}];
    await assert.rejects(ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',plan:text({selftest:bad}),note:'test'}),/expected pass, got fail/);
    await assert.rejects(ops.edit({cwd:r.cwd,as:owner,channel:'delegated',node:'a',set:[`checks.gate.selftest=${JSON.stringify(bad)}`],note:'test'}),/expected pass, got fail/);
    assert.deepEqual(await ledger.read(),before); assert.equal(await readFile(join(r.cwd,'plan.json'),'utf8'),source);
    const selftest=[{commit:r.green,expect:'pass'}], good=text({selftest}); await r.put('plan.json',good);
    const lines:string[]=[]; await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',plan:good,path:'plan.json',shellWarnings:lines}); assert.match(lines.join('\n'),/selftest .*: pass ✔/);
    assert.deepEqual((await ledger.read()).slice(-2).map(e => e.kind),['plan','note']);
    // If unchanged checks run again this deliberately corrupted fixture will refuse the recording.
    await git(r.cwd,['replace',r.green,r.red]);
    await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',plan:good,path:'plan.json'}); assert.equal((await ledger.read()).at(-1)!.kind,'plan');
    await ops.amend({cwd:r.cwd,as:owner,channel:'delegated',node:'a',writes:['extra/'],note:'bounded'});
    await ops.decide({cwd:r.cwd,as:owner,channel:'delegated',nodes:'a',writes:['other/'],text:'bounded'});
  } finally { await r.cleanup(); }
});

test('CT2 dry-run and tool preview do not execute; selftest-only edits retain candidate, blocks and keys', async () => {
  const r=await fixture();
  try {
    await init(r.cwd,text()); await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',plan:text(),path:'plan.json'});
    const d=await ops.dispatch({cwd:r.cwd,node:'a',as:{role:'parent',id:'pi'}}); await commitAt(d.worktree,{value:'still bad'}); await ops.submit({cwd:d.worktree,node:'a',as:{role:'writer',id:'a#1'}}); await ops.attest({cwd:r.cwd,node:'a'});
    const before=(await ops.readState({cwd:r.cwd})).state, selftest=[{commit:r.red,expect:'fail'}], next=parsePlan(text({selftest}));
    assert.deepEqual(specChanges(before.plan,next,'a'),[]);
    assert.equal(invalidates(before.plan,next,'a'),false); assert.equal(checkDefinition(before.plan,'a','gate'),checkDefinition(next,'a','gate'));
    assert.deepEqual((await candidateFacts(r.cwd,before.plan,before.plan.nodes[0]!,before.nodes.a!.slot!.base,before.nodes.a!.candidate!.commit,1)).keys,(await candidateFacts(r.cwd,next,next.nodes[0]!,before.nodes.a!.slot!.base,before.nodes.a!.candidate!.commit,1)).keys);
    assert.deepEqual((await stateFacts(r.cwd,before.plan,r.green)).invKeys,(await stateFacts(r.cwd,next,r.green)).invKeys);
    const bad=[{commit:'0'.repeat(40),expect:'pass'}], preview=await ops.editPreview({cwd:r.cwd,node:'a',set:[`checks.gate.selftest=${JSON.stringify(bad)}`],note:'preview'}); assert.match(preview.warnings.join('\n'),/selftest: 1 check\(s\) run when recorded/);
    const dry=await cli(r.cwd,['edit','a','--set',`checks.gate.selftest=${JSON.stringify(bad)}`,'--note','preview','--dry-run']); assert.equal(dry.code,0,dry.stderr); assert.match(dry.stdout,/selftest: 1/);
    const h=harness(r.cwd), toolPreview=await h.call('edit',{node:'a',set:[`checks.gate.selftest=${JSON.stringify(bad)}`],note:'preview',dry_run:true}); assert.equal(toolPreview.isError,undefined); assert.match(toolPreview.content.map(c => c.type === 'text' ? c.text : '').join('\n'),/selftest: 1/);
    await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',plan:text({selftest})});
    const after=(await ops.readState({cwd:r.cwd})).state;
    assert.equal(after.nodes.a!.candidate!.seq,before.nodes.a!.candidate!.seq); assert.equal(canonical(after.nodes.a!.blocks),canonical(before.nodes.a!.blocks));
    await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',plan:text({selftest:[{commit:r.green,expect:'pass'}]})});
    await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',plan:text()}); assert.equal((await ops.readState({cwd:r.cwd})).state.nodes.a!.candidate!.seq,before.nodes.a!.candidate!.seq);
  } finally { await r.cleanup(); }
});

for (const surface of ['cli','tool','edit'] as const) test(`CT2 carry receipt survives selftest note: ${surface}`, async () => {
  const r=await fixture();
  try {
    await init(r.cwd,text());
    await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',plan:text(),path:'plan.json'});
    const d=await ops.dispatch({cwd:r.cwd,node:'a',as:{role:'parent',id:'pi'}});
    await commitAt(d.worktree,{value:'candidate'});
    const sub=await ops.submit({cwd:d.worktree,node:'a',as:{role:'writer',id:'a#1'}});
    assert.ok(sub.kind === 'submit');
    const selftest=[{commit:r.green,expect:'pass'}], changedRun=run+'\n# changed check';
    let reported:unknown, output='';
    if (surface === 'edit') {
      const result=await ops.edit({cwd:r.cwd,as:owner,channel:'delegated',node:'a',set:[`checks.gate.run=${JSON.stringify(changedRun)}`,`checks.gate.selftest=${JSON.stringify(selftest)}`],note:'selftested check'}) as ops.EditResult;
      reported=result.carried;
    } else {
      await r.put('plan.json',text({run:changedRun,selftest}));
      if (surface === 'cli') {
        const result=await cli(r.cwd,['plan','plan.json','--json','--as','owner:pi','--note','selftested check']);
        assert.equal(result.code,0,result.stderr); reported=JSON.parse(result.stdout).carried;
      } else {
        const result=await harness(r.cwd).call('plan',{plan:'plan.json',as:'owner:pi',note:'selftested check'});
        assert.notEqual(result.isError,true); reported=(result.details as {carried?:unknown}).carried;
        output=result.content.map(c => c.type === 'text' ? c.text : '').join('\n');
      }
    }
    const ledger=await Ledger.open(r.cwd), entries=await ledger.read(), [plan,note,carry]=entries.slice(-3);
    assert.ok(plan?.kind === 'plan' && note?.kind === 'note' && carry?.kind === 'submit');
    assert.equal(note.by,'executor:owed'); assert.equal(JSON.parse(note.text.slice('selftest/v1 '.length)).plan,plan.plan);
    assert.equal(carry.by,'executor:owed'); assert.equal(carry.carry,sub.seq); assert.equal(carry.facts.commit,sub.facts.commit);
    assert.equal((await ops.readState({cwd:r.cwd})).state.nodes.a!.candidate!.seq,carry.seq);
    assert.deepEqual(reported,[carry], 'surface must report the carry already recorded after the selftest note');
    assert.deepEqual(await ops.carriedBy({cwd:r.cwd,plan:plan.seq}),[carry]);
    if (surface === 'tool') assert.ok(output.includes(`Carried a: candidate ${sub.facts.commit.slice(0,12)} (submit #${sub.seq}) is still the candidate as #${carry.seq}`),output);
    if (surface === 'cli') {
      // Only one immediately adjacent, matching executor receipt may be skipped; ordinary boundaries remain intact.
      const read=Ledger.prototype.read, prefix=entries.slice(0,-2);
      try {
        for (const altered of [
          {...note,by:'parent:pi'}, {...note,text:'ordinary note'}, {...note,text:'selftest/v1 {bad'},
          {...note,text:'selftest/v1 null'}, {...note,text:'selftest/v1 '+JSON.stringify({plan:'wrong'})},
          {...note,text:'selftest/v1 '+JSON.stringify({})},
        ]) {
          Ledger.prototype.read=async () => [...prefix,altered,carry];
          assert.deepEqual(await ops.carriedBy({cwd:r.cwd,plan:plan.seq}),[],JSON.stringify(altered));
        }
        Ledger.prototype.read=async () => [...prefix,note,{...note,seq:note.seq+1},{...carry,seq:carry.seq+1}];
        assert.deepEqual(await ops.carriedBy({cwd:r.cwd,plan:plan.seq}),[],'a second matching note terminates the scan');
        Ledger.prototype.read=async () => [...prefix,{...carry,seq:note.seq},{...note,seq:carry.seq},{...carry,seq:carry.seq+1}];
        assert.deepEqual(await ops.carriedBy({cwd:r.cwd,plan:plan.seq}),[{...carry,seq:note.seq}],'a note after a carry terminates the scan');
        Ledger.prototype.read=async () => [...prefix,note,{...carry,carry:undefined}];
        assert.deepEqual(await ops.carriedBy({cwd:r.cwd,plan:plan.seq}),[],'an ordinary submit terminates the scan');
      } finally { Ledger.prototype.read=read; }
    }
  } finally { await r.cleanup(); }
});

test('CT2 execution definition changes rerun selftests; invariant/red/strength keys ignore fixtures', async () => {
  const r=await fixture();
  try {
    const selftest=[{commit:r.green,expect:'pass'}], original=text({selftest});
    await init(r.cwd,original); await git(r.cwd,['replace',r.green,r.red]);
    for (const plan of [text({selftest,run:run+'\n# changed'}),text({selftest},{setup:'echo setup'}),text({selftest},{exec:{env:{CHANGED:'yes'}}})]) await assert.rejects(ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',plan}),/expected pass, got fail/);
    await git(r.cwd,['replace','-d',r.green]);
    const a=parsePlan(text({red:true,tests:['value'],mutants:['value']},{closure:['value'],invariants:[{id:'inv',run}]}));
    const b=parsePlan(text({red:true,tests:['value'],mutants:['value'],selftest},{closure:['value'],invariants:[{id:'inv',run,selftest}]}));
    assert.deepEqual((await candidateFacts(r.cwd,a,a.nodes[0]!,r.red,r.green,1)).keys,(await candidateFacts(r.cwd,b,b.nodes[0]!,r.red,r.green,1)).keys);
    assert.deepEqual((await stateFacts(r.cwd,a,r.green)).invKeys,(await stateFacts(r.cwd,b,r.green)).invKeys);
    const h=harness(r.cwd), preview=await h.call('init',{plan:'plan.json'}); assert.equal(preview.isError,true); // Existing genesis is refused without running fixtures.
  } finally { await r.cleanup(); }
});

test('CT2 append failure and stale source during measurement record nothing and preserve files', async () => {
  const r=await fixture();
  try {
    await init(r.cwd,text()); await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',plan:text(),path:'plan.json'});
    const ledger=await Ledger.open(r.cwd), before=await ledger.read(), source=await readFile(join(r.cwd,'plan.json'),'utf8'), append=Ledger.prototype.append;
    Ledger.prototype.append=async function() { throw new Error('injected append failure'); };
    try { await assert.rejects(ops.edit({cwd:r.cwd,as:owner,channel:'delegated',node:'a',set:[`checks.gate.selftest=[{commit: ${r.green}, expect: pass}]`],note:'failure'}),/injected append failure/); }
    finally { Ledger.prototype.append=append; }
    assert.deepEqual(await ledger.read(),before); assert.equal(await readFile(join(r.cwd,'plan.json'),'utf8'),source);
    const marker=join(r.root,'started'), release=join(r.root,'release');
    const pending=ops.edit({cwd:r.cwd,as:owner,channel:'delegated',node:'a',set:[`checks.gate.selftest=[{commit: ${r.green}, expect: pass}]`,`checks.gate.run=touch '${marker}'; for i in $(seq 1 100); do [ -f '${release}' ] && break; sleep 0.05; done; ${run}`],note:'race'});
    // Bounded fixture synchronization; always release and settle the owned operation.
    try { for (let i=0;i<100;i++) { if (await readFile(marker).then(() => true,() => false)) break; await new Promise(r => setTimeout(r,50)); }
      assert.equal(await readFile(marker).then(() => true,() => false),true); await r.put('plan.json',source+'\n');
    } finally { await writeFile(release,'go'); }
    await assert.rejects(pending,/changed while editing/);
    assert.deepEqual(await ledger.read(),before); assert.equal(await readFile(join(r.cwd,'plan.json'),'utf8'),source+'\n');
  } finally { await r.cleanup(); }
});

test('CT1 default source uses latest recorded path but current disk bytes, and tool exposes diagnostics', async () => {
  const r=await fixture();
  try {
    await init(r.cwd,text()); await ops.planSet({cwd:r.cwd,as:owner,channel:'delegated',plan:text(),path:'plan.json'}); await r.put('plan.json',text({run:'exit 9'}));
    const result=await cli(r.cwd,['check','try','a','gate','--red',r.red]); assert.equal(result.code,0,result.stderr);
    const h=harness(r.cwd), t=await h.call('check_try',{node:'a',check:'gate',red:r.red,no_lease:true}); assert.equal(t.isError,undefined); assert.match(t.content.map(c => c.type === 'text' ? c.text : '').join('\n'),/fail ✔/);
    const bad=await h.call('check_try',{node:'a',check:'gate',green:r.green,no_lease:true}); assert.equal(bad.isError,true);
  } finally { await r.cleanup(); }
});

test('CT1 shared lease marker reaches setup/commands; no-lease skips holder and abort cleans fresh tree', async () => {
  const r=await fixture(), prior=process.env.OWED_DSA, leased=process.env.OWED_LEASED;
  try {
    delete process.env.OWED_LEASED;
    const bin=join(r.root,'dsa.sh'), marker=join(r.root,'holds');
    await writeFile(bin,`#!/bin/sh\nif [ -f '${marker}.busy' ]; then echo 'hold: machine is busy' >&2; exit 75; fi\necho hold >> '${marker}'\nwhile [ "$1" != -- ]; do shift; done\nshift\nexec "$@"\n`); await chmod(bin,0o755); process.env.OWED_DSA=bin;
    await r.put('plan.json',text({run:'test "$OWED_LEASED" = 1',min_tests:undefined},{lease:true,setup:'test "$OWED_LEASED" = 1'}));
    let result=await cli(r.cwd,['check','try','a','gate','--green',r.green,'--plan','plan.json']); assert.equal(result.code,0,result.stderr); assert.match(await readFile(marker,'utf8'),/hold/);
    await init(r.cwd,text({run:'test "$OWED_LEASED" = 1',min_tests:undefined,selftest:[{commit:r.green,expect:'pass'}]},{lease:true,setup:'test "$OWED_LEASED" = 1'}));
    await writeFile(`${marker}.busy`,'busy'); result=await cli(r.cwd,['check','try','a','gate','--green',r.green,'--plan','plan.json']); assert.equal(result.code,75,result.stderr);
    await (await import('node:fs/promises')).rm(`${marker}.busy`);
    const holdBefore=await readFile(marker,'utf8');
    await r.put('plan.json',text({run:"echo 'owed-counts {\"pass\":1,\"fail\":0}'"},{lease:true})); result=await cli(r.cwd,['check','try','a','gate','--green',r.green,'--plan','plan.json','--no-lease']); assert.equal(result.code,0,result.stderr); assert.equal(await readFile(marker,'utf8'),holdBefore);
    await r.put('plan.json',text({run:'sleep 30'})); const ac=new AbortController(), timer=setTimeout(() => ac.abort(),500);
    try { await assert.rejects(ops.checkTry({cwd:r.cwd,node:'a',check:'gate',green:r.green,plan:'plan.json',lease:false,signal:ac.signal}),/aborted/); } finally { clearTimeout(timer); }
    assert.equal((await git(r.cwd,['worktree','list','--porcelain'])).stdout.split('worktree ').length-1,1);
  } finally { if(prior === undefined) delete process.env.OWED_DSA; else process.env.OWED_DSA=prior; if(leased === undefined) delete process.env.OWED_LEASED; else process.env.OWED_LEASED=leased; await r.cleanup(); }
});
