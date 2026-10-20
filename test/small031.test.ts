import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { parsePlan } from '../src/plan.ts';
import { editText } from '../src/edit.ts';
import { askingText, environmentText } from '../src/drive.ts';
import { reviewAsk, writerReply, structuredQuestionText } from '../src/views.ts';
import { needs } from '../src/needs.ts';
import owed from '../src/extension.ts';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import type { LaunchEntry } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const parent = { role:'parent', id:'test' } as const, owner = { role:'owner', id:'pi' } as const;
const PLAN = '# header\nversion: 1\ntrunk: main\nlease: false\nclosure: []\ninvariants: []\ndrive: # routing\n  max: 4 # capacity\n  writer: {agent: worker}\n  reviewer: {agent: reviewer, model: old}\nnodes:  # untouched spacing\n  - {id: a, writes: [a.txt], review: {count: 1, min_rank: 1}}\n';
async function fixture(text = PLAN) {
  const r = await repo(); await r.put('plan.yaml',text); await r.commit();
  await ops.init({cwd:r.cwd,as:owner,channel:'delegated',plan:text,path:'plan.yaml',measure:false});
  await ops.planSet({cwd:r.cwd,as:parent,...await ops.readPlan({cwd:r.cwd,path:'plan.yaml'})});
  return r;
}
const entries = async (cwd: string) => (await Ledger.open(cwd)).read();
function tools() {
  const all = new Map<string,ToolDefinition>();
  owed({registerTool(t: ToolDefinition) { all.set(t.name,t); },registerCommand() {},on() {}} as unknown as ExtensionAPI);
  return all;
}
async function toolCall(tool: ToolDefinition, cwd: string, p: object) {
  return await tool.execute('small031', {...p,cwd}, undefined,undefined,{cwd,hasUI:false} as Parameters<ToolDefinition['execute']>[4]) as {isError?:boolean;content:{text?:string}[];details:any};
}

test('SM1: CLI lists record one maximum watermark, latest wins, malformed forms record nothing', async () => {
  const r = await fixture();
  try {
    const d = await ops.dispatch({cwd:r.cwd,as:parent,node:'a'});
    await commitAt(d.worktree,{'a.txt':'candidate'}); await ops.submit({cwd:d.worktree,as:{role:'writer',id:'a#1'},node:'a'});
    const first = await ops.rule({cwd:r.cwd,as:parent,nodes:['a'],text:'First ruling'});
    const last = await ops.rule({cwd:r.cwd,as:parent,nodes:['a'],text:'Second ruling'});
    const args = ['review','a','--ok','--rank','1','--note','Read both','--as','reviewer:list'];
    for (const value of [`${last.seq},${first.seq}`,`${first.seq},latest`,`${last.seq}`,'latest']) {
      const out = await cli(r.cwd,[...args,'--ack-rulings',value,'--json']); assert.equal(out.code,0,out.stderr);
      assert.equal(JSON.parse(out.stdout).ack_rulings,last.seq);
    }
    const count = (await entries(r.cwd)).length;
    for (const value of ['','1,','1,no','latest,no','-1','1.5','9007199254740992']) {
      const out = await cli(r.cwd,[...args,'--ack-rulings',value]); assert.equal(out.code,2,out.stderr);
      assert.match(out.stderr,/latest, a seq, or a comma list/); assert.equal((await entries(r.cwd)).length,count);
    }
    const tool = tools().get('owed_review')!;
    const result = await toolCall(tool,r.cwd,{node:'a',verdict:'ok',rank:1,note:'Array read',as:'reviewer:array',ack_rulings:[first.seq,last.seq,first.seq]});
    assert.equal(result.isError,undefined,result.content[0]?.text); assert.equal(result.details.ack_rulings,last.seq);
    await assert.rejects(ops.review({cwd:r.cwd,as:{role:'reviewer',id:'bad'},node:'a',verdict:'ok',rank:1,note:'bad',ack_rulings:[]}),/latest, a seq, or a comma list/);
    await assert.rejects(ops.review({cwd:r.cwd,as:{role:'reviewer',id:'bad'},node:'a',verdict:'ok',rank:1,note:'bad',ack_rulings:[first.seq]}),/must be at least/);
  } finally { await r.cleanup(); }
});

test('SM2: adoption refusal names the same genesis completion command as status', async () => {
  const r = await fixture(PLAN.replace('invariants: []','invariants: [{id: initial, run: "exit 127", reads: [a.txt]}]'));
  try {
    await commitAt(r.cwd,{'a.txt':'hotfix'});
    const status = await cli(r.cwd,['status','--full']); assert.match(status.stdout,/owed attest --genesis/);
    const out = await cli(r.cwd,['adopt','--note','Hotfix','--as','owner:pi']);
    assert.equal(out.code,1,out.stderr); assert.match(out.stderr,/genesis invariant initial observations are incomplete; run owed attest --genesis/);
  } finally { await r.cleanup(); }
});

test('SM3: drive set/unset preserves other bytes and comments, creates missing mapping and validates all keys', async () => {
  const r = await fixture();
  try {
    const out = await cli(r.cwd,['edit','--drive','--set','max=6','--set','reviewer.agent=owed-reviewer','--unset','reviewer.model','--note','Use a recording reviewer']);
    assert.equal(out.code,0,out.stderr);
    const next = await readFile(join(r.cwd,'plan.yaml'),'utf8'), parsed = parsePlan(next);
    assert.equal(parsed.drive?.max,6); assert.deepEqual(parsed.drive?.reviewer,{agent:'owed-reviewer'});
    assert.equal(next.slice(0,next.indexOf('drive:')),PLAN.slice(0,PLAN.indexOf('drive:')));
    assert.equal(next.slice(next.indexOf('nodes:')),PLAN.slice(PLAN.indexOf('nodes:'))); assert.match(next,/# routing/); assert.match(next,/# capacity/);
    const count = (await entries(r.cwd)).length;
    for (const set of ['unknown=1','max=0','reviewer.effort=high','__proto__.x=1']) {
      await assert.rejects(ops.edit({cwd:r.cwd,as:parent,drive:true,set:[set],note:'Invalid'}));
      assert.equal((await entries(r.cwd)).length,count); assert.equal(await readFile(join(r.cwd,'plan.yaml'),'utf8'),next);
    }
    for (const target of [{node:'a'}, {nodes:['a']}, {invariant:'initial'}, {node_new:true}]) await assert.rejects(ops.edit({cwd:r.cwd,as:parent,drive:true,...target,set:['max=6'],note:'Exclusive'}),/exactly one|requires a node/);
    const noDrive = PLAN.slice(0,PLAN.indexOf('drive:')) + PLAN.slice(PLAN.indexOf('nodes:'));
    const created = editText(noDrive,{drive:true,set:['max=8','merge_batch=2','same_model=accepted','writer.model=sol']});
    assert.ok(created.startsWith(noDrive)); assert.equal(parsePlan(created).drive?.max,8); assert.equal(parsePlan(created).drive?.merge_batch,2);
    const flow = editText('version: 1\ntrunk: main\ndrive: {max: 4} # flow\nnodes: [{id: a, writes: [a.txt]}]\n',{drive:true,set:['repairs=3']});
    assert.equal(parsePlan(flow).drive?.repairs,3); assert.match(flow,/# flow/);
    const done = await toolCall(tools().get('owed_edit')!,r.cwd,{drive:true,set:['reviewer.model=sol'],note:'Tool drive edit'});
    assert.equal(done.isError,undefined,done.content[0]?.text); assert.equal(done.details.plan.by,'parent:pi');
    assert.equal((await ops.verify({cwd:r.cwd})).ok,true);
  } finally { await r.cleanup(); }
});

test('SM3: append failure and dry-run leave drive source and ledger unchanged', async t => {
  const r = await fixture();
  try {
    const count = (await entries(r.cwd)).length;
    const dry = await cli(r.cwd,['edit','--drive','--set','max=9','--note','Preview','--dry-run']); assert.equal(dry.code,0,dry.stderr); assert.match(dry.stdout,/max: 9/);
    t.mock.method(Ledger.prototype,'append',async () => { throw new Error('append failed'); });
    await assert.rejects(ops.edit({cwd:r.cwd,as:parent,drive:true,set:['max=9'],note:'Fail append'}),/append failed/);
    assert.equal(await readFile(join(r.cwd,'plan.yaml'),'utf8'),PLAN); assert.equal((await entries(r.cwd)).length,count);
  } finally { t.mock.restoreAll(); await r.cleanup(); }
});

test('SM4: review asks clip at the last late sentence, word or CJK boundary; short text unchanged', () => {
  const ask = (s: string) => reviewAsk(`BLOCK (needs parent): ${s}`);
  const sentence = 'a'.repeat(190)+'. '+ 'b'.repeat(50)+'! '+ 'c'.repeat(150);
  assert.equal(ask(sentence),'a'.repeat(190)+'. '+ 'b'.repeat(50)+'!…');
  const word = 'a'.repeat(150)+' '+ 'b'.repeat(140)+' '+ 'c'.repeat(80);
  assert.equal(ask(word),'a'.repeat(150)+' '+ 'b'.repeat(140)+'…');
  assert.equal(ask('界'.repeat(400)),'界'.repeat(299)+'…');
  assert.equal(ask('界'.repeat(210)+'。'+'后'.repeat(150)),'界'.repeat(210)+'。…');
  assert.equal(ask('😀'.repeat(400)),'😀'.repeat(299)+'…');
  assert.equal(ask('Keep this whole. Next step?'),'Keep this whole. Next step?');
  const note = 'a'.repeat(130)+'. '+ 'remaining '.repeat(25);
  const environment = environmentText('a',{latest:{seq:5,obligation:'check:x',note},step:1,until:0} as Parameters<typeof environmentText>[1]);
  assert.ok(environment.includes(`${'a'.repeat(130)}.…; attest waits`),environment);
  assert.match(writerReply('a'.repeat(150)+'. '+ 'word '.repeat(150)),/^writer says: "a{150}\. … /);
  const ending = ' commit abcdef0123456789abcdef0123456789abcdef01';
  const reply = writerReply('界'.repeat(220)+'x'.repeat(500)+'y'.repeat(10)+'界'.repeat(325)+ending);
  assert.ok(reply.startsWith(`writer says: "${'界'.repeat(200)} … `));
  assert.ok(reply.endsWith(`${ending}"`),reply);
  assert.doesNotMatch(reply,/ … y/);
});

test('SM4: structured fields clip with ellipsis and details name a command printing the entire question', async () => {
  const r = await repo();
  try {
    const question = 'prefix '.repeat(35)+'. '+ 'the decisive rest '.repeat(30);
    const q = {qid:'q1',rev:1,question,decision_needed:'Choose',options:[{label:'one '.repeat(60),scope:'scope '.repeat(60)}],facts:['facts '.repeat(150)]};
    const text = askingText('a',{rid:'rid-full',role:'writer'} as LaunchEntry,{rid:'rid-full',state:'asking',questions:[q]});
    const details = text.split('\n').find(l => l.startsWith('details:'))!;
    assert.match(details,/… \(full: pi-durable-subagents describe --key 'rid-full' --json\)$/);
    const lines = text.split('\n'); assert.match(lines[1]!,/…/); assert.ok(Array.from(lines[2]!).length <= 600);
    const command = details.match(/ \(full: (.*)\)$/)![1]!;
    const bin = join(r.root,'pi-durable-subagents'), full = {state:'asking',questions:[{qid:'q1',rev:1,text:question}]};
    await writeFile(bin,`#!/bin/sh\n[ "$1 $2 $3 $4" = 'describe --key rid-full --json' ] || exit 2\nprintf '%s\\n' '${JSON.stringify(full)}'\n`); await chmod(bin,0o755);
    const printed = await promisify(execFile)('/bin/sh',['-c',command],{env:{...process.env,PATH:`${r.root}:${process.env.PATH}`},timeout:5000});
    assert.equal(JSON.parse(printed.stdout).questions[0].text,question);
    assert.equal(structuredQuestionText({...q,question:'Short.'}).split('\n').at(-1),'details: Short.');
  } finally { await r.cleanup(); }
});

test('SM4: needs review asks use the same sentence clipping as views', async () => {
  const r = await fixture();
  try {
    const d = await ops.dispatch({cwd:r.cwd,as:parent,node:'a'}); await commitAt(d.worktree,{'a.txt':'candidate'}); await ops.submit({cwd:d.worktree,as:{role:'writer',id:'a#1'},node:'a'});
    const text = 'a'.repeat(210)+'. '+ 'tail '.repeat(60);
    await ops.review({cwd:r.cwd,as:{role:'reviewer',id:'independent'},node:'a',verdict:'block',needs:'parent',rank:1,note:`BLOCK (needs parent): ${text}`});
    const s = (await ops.readState(r)).state;
    assert.equal(needs(s,'a').find(n => n.kind === 'rule')?.text,`review asks: ${'a'.repeat(210)}.…`);
  } finally { await r.cleanup(); }
});
