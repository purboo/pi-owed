// 0.28 driver contract: real git slots and ops/driver/follower behavior, no acceptance shortcuts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { Driver, procStart, reportText, type ActionReport } from '../src/drive-run.ts';
import { Follower, revalidator } from '../src/drive-bg.ts';
import { decide, rulingFollowUp, rulingMessage, writerLaunch, reviewerLaunch } from '../src/drive.ts';
import { needs, repoNeeds, needId } from '../src/needs.ts';
import { assembleRuntime } from '../src/activity.ts';
import { clockTime } from '../src/clock.ts';
import { ownerNeeded, projectId } from '../src/reducer.ts';
import { Dsa, type SendResult } from '../src/dsa.ts';
import type { RunView } from '../src/types.ts';
import type { Measuring } from '../src/needs-types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const parent = { role: 'parent', id: 'test' } as const, owner = { role: 'owner', id: 'pi' } as const;
const writer = { role: 'writer', id: 'a#1' } as const;
const start = Date.parse('2026-10-17T12:00:00Z');
const node = (id: string, extra = {}) => ({ id, deps: [], writes: [`${id}.txt`], checks: [], review: { count: 0, min_rank: 1 }, ...extra });
const rendered = (n: import('../src/needs-types.ts').Need) => `${n.text}${n.command ? ` → ${n.command}` : ' (no single command)'}`;
const noChange = 'Apply these rulings. If they need a change from you, commit and run owed submit a; if they need none, reply "no change: <why>" and stop.';
class Client extends Dsa {
  views = new Map<string, RunView>();
  sent: { id: string; rid: string; kind: string; text: string }[] = [];
  rejected = new Set<string>();
  rejectRuling = false;
  constructor() { super({ bin: '/bin/true' }); }
  override async inspect(rid: string) { return { view: await this.describe(rid) }; }
  override async describe(rid: string): Promise<RunView> { return this.views.get(rid) ?? { rid, state: 'sealed', status: 'ok', result: 'no change: guidance already applied' }; }
  override async request(id: string) { return this.rejected.has(id) ? { state: 'rejected' as const, reason: 'call pruned' } : { state: 'applied' as const }; }
  override async send(id: string, rid: string, kind: string, body: string | Uint8Array): Promise<SendResult> {
    this.sent.push({ id, rid, kind, text: String(body) });
    if (this.rejectRuling && kind === 'follow-up') this.rejected.add(id);
    if (this.rejected.has(id)) return { outcome: 'rejected', reason: 'call pruned' };
    return { outcome: 'applied', spec_digest: 'fixture' };
  }
}
async function fixture(extra = {}, additional: object[] = [], repairs = 2, planExtra = {}) {
  const r = await repo(); await r.put('seed', 'fixture'); await r.commit();
  const plan = { version: 1, trunk: 'main', lease: false, closure: [], invariants: [], drive: { repairs }, nodes: [node('a', extra), ...additional], ...planExtra };
  await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify(plan), measure: false });
  const slot = await ops.dispatch({ ...r, as: parent, node: 'a' });
  const state = async () => (await ops.readState(r)).state;
  const s = await state(), launch = writerLaunch(s, 'a', projectId(s));
  await ops.launch({ ...r, as: parent, ...launch });
  const dsa = new Client(), lines: ActionReport[] = [], dir = join(process.env.OWED_DIR!, 'drive'), log = join(dir, 'log.jsonl');
  await mkdir(dir, { recursive: true }); await writeFile(log, '');
  const driver = new Driver({ cwd: r.cwd, dsa, json: true, session: null, handleSignals: false, log: l => { lines.push(JSON.parse(l)); appendFileSync(log, l + '\n'); } });
  const submit = async (text = 'candidate') => { await commitAt(slot.worktree, { 'a.txt': text }); return ops.submit({ cwd: slot.worktree, as: writer, node: 'a' }); };
  const reviewer = async (n = 1) => { const s = await state(), l = reviewerLaunch(s, 'a', n, projectId(s), r.cwd); await ops.launch({ ...r, as: parent, ...l }); return l; };
  const rule = (writerChange = false) => ops.rule({ ...r, as: parent, nodes: ['a'], text: 'guidance only', ...(writerChange ? { writer: true } : {}), dsa });
  const follower = (busy = () => false) => new Follower({ log, repo: r.cwd, pid: process.pid, start: procStart(process.pid), from: 0, busy, revalidate: revalidator({ cwd: r.cwd, dsa }), deliver() {} });
  return { ...r, slot, state, dsa, lines, driver, submit, reviewer, rule, follower, launch, log,
    async done() { driver.abort.abort(); await driver.settle(); await r.cleanup(); } };
}
const checked = { checks: [{ id: 'stress', run: 'false', reads: ['a.txt'], timeout_s: 5 }] };
async function measure(f: Awaited<ReturnType<typeof fixture>>) { await ops.attest({ ...f, node: 'a', lease: false }); }
async function primary(f: Awaited<ReturnType<typeof fixture>>) { const s = await f.state(); return needs(s, 'a', await assembleRuntime({ cwd: f.cwd, state: s, driverRunning: true }))[0]!; }

// Every test asserts a changed behavioral output, so each is red individually on the slot base.
test('DR1/R-028-43: baseline rank-3 gap stays an owner diagnosis and never launches a writer', async () => {
  const f = await fixture({ review: { count: 1, min_rank: 3 } });
  try {
    await f.submit(); await measure(f); assert.deepEqual(needs(await f.state(),'a',{driverRunning:true}),[]);
    await f.driver.pass(); const wake = f.lines.find(l => l.do === 'notify')!;
    assert.equal(wake.need,null); assert.match(wake.text!,/review requires rank 3.*\(no single command\)$/); assert.doesNotMatch(wake.text!,/→ owed/);
    assert.equal(f.dsa.sent.length,0); assert.ok(!f.lines.some(l => l.do === 'launch'));
  } finally { await f.done(); }
});

test('DR1/R-028-47: only an answer need does not disguise a baseline owner gap', async t => {
  t.mock.timers.enable({apis:['Date'],now:start});
  const f=await fixture({review:{count:1,min_rank:3}});
  try {
    await f.submit(); await measure(f);
    const e=await ops.answerRule({cwd:f.cwd,as:parent,node:'a',text:'Answer to writer question q: Use API v2',answer:{rid:f.launch.rid,qid:'q',rev:1}});
    const rt={driverRunning:true,asking:[{node:'a',rid:f.launch.rid,qid:'q',rev:1,text:`answered at #${e.seq} (${clockTime(e.ts,start)}), still asking after 12m`}]};
    const s=await f.state(),ns=needs(s,'a',rt);
    assert.ok(ownerNeeded(s,'a')); assert.equal(ns.length,1); assert.equal(ns[0]!.kind,'answer');
    const actions=decide(s,s.plan,new Map([[f.launch.rid,{rid:f.launch.rid,state:'sealed',status:'ok'}]]),{runtime:rt,max:1,repairs:2,project:projectId(s),root:f.cwd,applied:new Set(),rejected:new Map()});
    const notice=actions.find(a => a.do === 'notify' && a.node === 'a');
    assert.ok(notice?.do === 'notify'); assert.equal(notice.need,null); assert.match(notice.text,/no single command/); assert.doesNotMatch(notice.text,/→ owed|answered at/);
    assert.ok(!actions.some(a => a.do === 'send' || a.do === 'launch'));
  } finally {await f.done();}
});

test('DR1/C1/C8: waiving one of two owner obligations leaves the other wake intact', async () => {
  const f = await fixture({ checks:[{id:'stress',run:'false',reads:['a.txt']},{id:'behaviour',run:'false',reads:['a.txt']}] });
  try {
    await f.submit(); await measure(f);
    const s=await f.state(),c=s.nodes.a!.candidate!,ledger=await Ledger.open(f.cwd);
    await ledger.withLock(() => ledger.append(['check:stress','check:behaviour'].map(obligation => ({kind:'obs',by:'executor:owed',subject:'a',obligation,key:c.keys[obligation]!,verdict:'pass',exit:0,durationMs:1,commit:c.commit,base:c.base}))));
    await f.driver.pass();
    const before = needs(await f.state(),'a',{driverRunning:true}); assert.equal(before.length,2);
    const wake = f.lines.find(l => l.do === 'notify')!; assert.deepEqual(wake.otherNeeds,before.slice(1));
    assert.ok(before.every(n => n.command!.includes('--accept-risk'))); assert.ok(before.every(n => !n.command!.includes(n.obligation === 'check:stress' ? 'check:behaviour' : 'check:stress')));
    const primary = before[0]!; await ops.waive({ cwd:f.cwd,as:owner,channel:'delegated',node:'a',obligation:primary.obligation!,reason:'risk accepted',accept_risk:[primary.block!] });
    const message = (await f.follower().step())!;
    assert.ok(message.includes(`Needs you: a — ${rendered(before[1]!)}`)); assert.ok(!message.includes(`Needs you: a — ${rendered(primary)}`));
    assert.equal((await f.state()).nodes.a!.accepted,false);
  } finally { await f.done(); }
});

test('DR1/C7: repository trunk-red wake uses repoNeeds without trunk decide/rule/resume', async () => {
  const f = await fixture();
  try {
    const s = await f.state(), p = structuredClone(s.plan); p.invariants=[{id:'unit',run:'false',reads:['seed'],timeout_s:5}];
    await ops.planSet({cwd:f.cwd,as:owner,channel:'delegated',plan:JSON.stringify(p)});
    await ops.attestTrunk({cwd:f.cwd,lease:false}); await f.driver.pass();
    const current = await f.state(), ns = repoNeeds(current,{driverRunning:true}), wake = f.lines.find(l => l.scope === 'repo' && l.need)!;
    assert.ok(wake,JSON.stringify(f.lines)); assert.deepEqual(wake.need,ns[0]); assert.equal(wake.needId,needId(ns[0]!));
    assert.doesNotMatch(wake.text!,/owed (decide|rule|resume) trunk/); assert.ok(wake.text!.includes(rendered(ns[0]!)));
  } finally { await f.done(); }
});

test('DR1/C5: failed merge-tree wake renders its current owner waiver with active risk pin', async () => {
  const run=`if [ ! -f a.txt ] || grep -q fixture seed; then printf '# tests 1\n# pass 1\n# fail 0\n'; else printf 'not ok 1 - moved seed with candidate\n# tests 1\n# pass 0\n# fail 1\n'; exit 1; fi`;
  const f=await fixture({checks:[{id:'stress',run,reads:['seed','a.txt']}]});
  try {
    await f.submit();await measure(f);assert.equal((await f.state()).nodes.a!.accepted,true);
    await commitAt(f.cwd,{seed:'moved trunk'});await ops.adopt({cwd:f.cwd,as:owner,channel:'delegated',note:'external change'});
    await f.driver.pass();await f.driver.settle();
    const n=await primary(f),wake=f.lines.find(l => l.do === 'merge' && l.outcome === 'refused')!;
    assert.ok((await f.follower().step())!.includes(`Needs you: a — ${rendered(n)}`));
    assert.ok(wake,JSON.stringify(f.lines));assert.deepEqual(wake.need,n);assert.equal(n.kind,'waive');
    assert.ok(n.command!.includes(`--accept-risk ${n.block}`));assert.ok(n.command!.includes(`--candidate ${n.candidate}`));
    assert.doesNotMatch(n.command!,/owed decide|owed attest/);assert.equal((await f.state()).nodes.a!.merged,undefined);
  } finally {await f.done();}
});

test('DR1/VW3: driver measurement reports measured-but-not-accepted with the current primary text', async () => {
  const f = await fixture(checked);
  try {
    await f.submit(); await f.driver.pass(); await f.driver.settle();
    const r = f.lines.find(l => l.do === 'attest' && l.outcome === 'done')!; assert.ok(r,JSON.stringify(f.lines));
    const s=await f.state(),rt=await assembleRuntime({cwd:f.cwd,state:s,driverRunning:true});
    const text=needs(s,'a',rt)[0]?.text ?? (await import('../src/needs.ts')).activity(s,'a',rt)?.text;
    assert.ok(r.detail!.startsWith(`measured; not accepted yet: ${text}`),r.detail);
    assert.equal(s.nodes.a!.accepted,false);
  } finally { await f.done(); }
});
test('DR1/C1/C4: owner notice is exactly the primary need and each obligation keeps its command', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const f = await fixture({ review: { count: 1, min_rank: 3 }, evidence: [{ id: 'proof', what: 'proof', by: 'owner' }] });
  try {
    await f.submit(); await measure(f);
    await ops.review({ ...f, as: { role: 'reviewer', id: 'external' }, node: 'a', verdict: 'block', rank: 2, note: 'owner choice' });
    const s = await f.state(), ns = needs(s, 'a', { driverRunning: true });
    await f.driver.pass(); const wake = f.lines.find(l => l.do === 'notify')!;
    assert.equal(wake.text, ns.map(n => `a: ${rendered(n)}`).join('\n'));
    assert.deepEqual(wake.need, ns[0]); assert.equal(wake.needId, needId(ns[0]!)); assert.deepEqual(wake.otherNeeds, ns.slice(1));
    assert.doesNotMatch(wake.text!, /resolves it with|\| owed/);
    assert.ok(ns[0]!.alternatives!.some(c => c.includes('--ack-rulings latest'))); assert.ok(ns[1]!.command!.includes('evidence a proof'));
  } finally { await f.done(); }
});

test('DR1/N5: stalled rulings debt is rendered from the real post-halt resume need', async () => {
  const f = await fixture({ review: { count: 1, min_rank: 1 } });
  try {
    await f.submit(); await measure(f); const r = await f.rule(), l = await f.reviewer();
    await ops.review({ ...f, as: { role: 'reviewer', id: 'drive-a-1-1' }, node: 'a', verdict: 'ok', rank: 1, note: 'ok', ack_rulings: r.seq });
    // Replay a legacy review with an insufficient ack, as existing D12 stalled tests do.
    const ledger = await Ledger.open(f.cwd);
    await ledger.withLock(async () => { const s = await f.state(); await ledger.append([{ kind: 'review', by: 'reviewer:legacy', node: 'a', attempt: 1, obligation: 'review', key: s.nodes.a!.candidate!.keys.review!, verdict: 'ok', rank: 1, ack_rulings: 0, note: 'legacy' }]); });
    // A later ruling makes reviewer ack debt; mark the reviewer as already delivered without acknowledging.
    const late = await f.rule();
    await ops.send({ ...f, as: parent, node: 'a', attempt: 1, rid: l.rid, sendKind: 'follow-up', reason: 'ruling', rulings: late.seq, message: 'delivered, not acknowledged' });
    await f.driver.pass();
    const wake = f.lines.find(l => l.do === 'halt')!; assert.ok(wake, JSON.stringify(f.lines));
    const n = await primary(f); assert.equal(n.kind, 'resume'); assert.deepEqual(wake.need, n);
    assert.equal(reportText(wake), `a: ${rendered(n)}`);
    const h = (await ops.readState(f)).entries.findLast(e => e.kind === 'halt')!;
    assert.ok(h.kind === 'halt'); assert.match(h.reason, /^stalled:/); assert.doesNotMatch(h.reason, /resolves it with|→ owed/);
  } finally { await f.done(); }
});

test('DR1/C3: hidden stale driver rank-2 block becomes a post-halt owner review, not guidance', async () => {
  const f = await fixture({ review: { count: 1, min_rank: 1 } });
  try {
    await f.submit(); await measure(f); await f.reviewer();
    const b = await ops.review({ ...f, as: { role: 'reviewer', id: 'drive-a-1-1' }, node: 'a', verdict: 'block', rank: 2, note: 'repair' });
    await f.submit('repair'); await measure(f); await f.reviewer(2);
    await ops.review({ ...f, as: { role: 'reviewer', id: 'drive-a-1-1' }, node: 'a', verdict: 'ok', rank: 1, note: 'rank cannot clear old block' });
    assert.equal(needs(await f.state(), 'a', { driverRunning: true }).length, 0);
    await f.driver.pass(); const wake = f.lines.find(l => l.do === 'halt')!, n = await primary(f);
    assert.equal(n.kind, 'review'); assert.equal(n.block, b.seq); assert.equal(wake.text, `a: ${rendered(n)}`); assert.deepEqual(wake.need, n);
    assert.match(n.text, /repair #\d+ submitted; #\d+ clears when/); assert.doesNotMatch(wake.text!, /guidance needed|decide.*--writer/);
    const h = (await ops.readState(f)).entries.findLast(e => e.kind === 'halt')!;
    assert.ok(h.kind === 'halt'); assert.match(h.reason, /^stale review block/); assert.doesNotMatch(h.reason, /resolves it with|→ owed/);
  } finally { await f.done(); }
});

test('DR1/N5/R-028-34: new writer-stop keeps its ledger trailer, but display uses the decide need', async () => {
  const f = await fixture();
  try {
    await f.driver.pass(); const n = await primary(f), wake = f.lines.find(l => l.do === 'halt')!;
    assert.equal(n.kind, 'decide'); assert.equal(wake.text, `a: ${rendered(n)}`); assert.deepEqual(wake.need, n);
    const h = (await ops.readState(f)).entries.findLast(e => e.kind === 'halt')!;
    assert.ok(h.kind === 'halt'); assert.ok(h.reason.endsWith(` → ${n.command}`));
    assert.equal('otherNeeds' in wake, false);
  } finally { await f.done(); }
});

test('DR1/R-028-38: halt concurrently cleared has a null wake, never a fabricated need', async t => {
  const f = await fixture();
  try {
    const original = Ledger.prototype.append;
    t.mock.method(Ledger.prototype, 'append', async function(this: Ledger, drafts: Parameters<Ledger['append']>[0]) {
      const result = await original.call(this, drafts);
      if (drafts.some(d => d.kind === 'halt')) await original.call(this, [{ kind: 'resume', by: 'parent:test', node: 'a', attempt: 1, note: 'concurrently cleared' }]);
      return result;
    });
    await f.driver.pass(); const wake = f.lines.find(l => l.do === 'halt')!;
    assert.equal(wake.need, null); assert.equal('otherNeeds' in wake, false); assert.match(wake.text!, /\(no single command\)$/);
    assert.equal(needs(await f.state(), 'a', { driverRunning: true }).length, 0);
  } finally { t.mock.restoreAll(); await f.done(); }
});

for (const variant of ['both', 'primary gone', 'all gone'] as const) test(`DR2/C1: follower revalidates each recorded need: ${variant}`, async () => {
  const f = await fixture({ review: { count: 1, min_rank: 3 }, evidence: [{ id: 'proof', what: 'proof', by: 'owner' }] });
  try {
    await f.submit(); await measure(f);
    await ops.review({ ...f, as: { role: 'reviewer', id: 'external' }, node: 'a', verdict: 'block', rank: 2, note: 'owner choice' });
    const follower = f.follower(); await f.driver.pass();
    const ns = needs(await f.state(), 'a', { driverRunning: true }); assert.equal(ns.length, 2);
    assert.deepEqual(f.lines.find(l => l.do === 'notify')!.need,ns[0]);
    if (variant !== 'both') await ops.review({ ...f, as: owner, channel: 'delegated', node: 'a', verdict: 'ok', rank: 3, note: 'reviewed', ack_rulings: 'latest' });
    if (variant === 'all gone') { const file = join(f.root, 'proof'); await writeFile(file, 'proof'); await ops.evidence({ ...f, as: owner, channel: 'delegated', node: 'a', id: 'proof', files: [file], note: 'checked' }); }
    const message = await follower.step();
    if (variant === 'all gone') assert.equal(message, undefined);
    else {
      const expected = variant === 'both' ? ns : ns.slice(1);
      assert.deepEqual(message!.split('\n').filter(l => l.startsWith('Needs you:')), expected.map(n => `Needs you: a — ${rendered(n)}`));
    }
  } finally { await f.done(); }
});

test('DR2: closing an answer drops only that need, not its still-live owner sibling', async t => {
  t.mock.timers.enable({apis:['Date'],now:start});
  const f=await fixture({review:{count:1,min_rank:3}});
  try {
    await f.submit();await measure(f);await ops.review({cwd:f.cwd,as:{role:'reviewer',id:'external'},node:'a',verdict:'block',rank:2,note:'owner choice'});
    const e=await ops.answerRule({cwd:f.cwd,as:parent,node:'a',text:'Answer to writer question q: Use API v2',answer:{rid:f.launch.rid,qid:'q',rev:1}});
    const dir=join(process.env.OWED_DIR!,'drive');await writeFile(join(dir,'asking.json'),JSON.stringify([{node:'a',rid:f.launch.rid,qid:'q',rev:1}]));
    t.mock.timers.setTime(start+720_000);
    const s=await f.state(),ns=needs(s,'a',await assembleRuntime({cwd:f.cwd,state:s,driverRunning:true}));
    assert.equal(ns[0]!.kind,'answer');assert.equal(ns.length,2);
    appendFileSync(f.log,JSON.stringify({do:'notify',node:'a',outcome:'notify',need:ns[0],needId:needId(ns[0]!),otherNeeds:ns.slice(1),rid:f.launch.rid,qid:'q',rev:1,answerRetry:true,text:'recorded answer and owner choice'})+'\n');
    const message=(await f.follower().step())!;
    assert.deepEqual(message.split('\n').filter(l => l.startsWith('Needs you:')),[`Needs you: a — ${rendered(ns[1]!)}`]);
    assert.equal(e.seq,ns[0]!.since);
  } finally {await f.done();}
});

test('DR2/R-028-35: new diagnostic null bypasses prose parsing, while old logs still render plainNeed', async () => {
  const f = await fixture();
  try {
    const follower = f.follower();
    appendFileSync(f.log, JSON.stringify({ do: 'notify', node: 'a', outcome: 'notify', need: null, text: 'diagnostic → owed abandon a --note "not a prescription"' }) + '\n');
    const modern = (await follower.step())!; assert.match(modern, /diagnostic → owed abandon/); assert.doesNotMatch(modern, /Needs you:/);
    appendFileSync(f.log, JSON.stringify({ do: 'notify', node: 'a', outcome: 'notify', text: 'a: old notice; resolves it with: owed resume a' }) + '\n');
    assert.match((await follower.step())!, /Needs you: a — old notice → owed resume a/);
  } finally { await f.done(); }
});

for (const mode of ['running', 'queued', 'other', 'stale candidate'] as const) test(`DR3/N6: runtime ${mode} record changes owner notification only`, async t => {
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const f = await fixture(checked);
  try {
    await f.submit(); await measure(f);
    // Same-key counted pass after fail makes the ordinary conflicting check an owner need.
    const s = await f.state(), c = s.nodes.a!.candidate!, ledger = await Ledger.open(f.cwd);
    await ledger.withLock(() => ledger.append([{ kind: 'obs', by: 'executor:owed', subject: 'a', obligation: 'check:stress', key: c.keys['check:stress']!, verdict: 'pass', exit: 0, durationMs: 1, commit: c.commit, base: c.base }]));
    const before = await f.state(), dir = join(process.env.OWED_DIR!, 'run'); await mkdir(dir, { recursive: true });
    const m: Measuring = { node: 'a', obligations: ['check:stress'], candidate: c.seq, do: mode === 'other' ? 'other' : 'attest', phase: mode === 'queued' ? 'queued' : 'running', since: new Date(start).toISOString(), pid: process.pid, token: 'external' };
    if (mode === 'stale candidate') m.candidate = c.seq - 1;
    await writeFile(join(dir, `attest-${process.pid}-external.json`), JSON.stringify(m));
    await f.driver.pass(); const wake = f.lines.find(l => l.do === 'notify');
    if (mode === 'running') { assert.equal(wake, undefined); const rt = await assembleRuntime({ cwd: f.cwd, state: before, driverRunning: true }); assert.equal(needs(before, 'a', rt).length, 0); }
    else { assert.ok(wake); assert.deepEqual(wake.need, needs(before, 'a', { driverRunning: true })[0]); assert.equal(wake.needId, needId(wake.need!)); }
    const after = await f.state(); assert.deepEqual(after.nodes.a!.items, before.nodes.a!.items); assert.equal(after.nodes.a!.candidate!.seq, c.seq); assert.equal(f.dsa.sent.length, 0);
    assert.equal(clockTime(m.since, start).length, 5);
  } finally { await f.done(); }
});

for (const route of ['no candidate', 'same-key fail', 'binding judgment', 'exhausted repairs', 'writer true', 'rejected send'] as const) test(`DR4: no-change follow-up retains the ${route} route and cannot accept unchanged work`, async () => {
  const f = await fixture(route === 'binding judgment' ? { review: { count: 1, min_rank: 1 } } : checked, [], route === 'exhausted repairs' ? 0 : 2);
  try {
    if (route !== 'no candidate') { await f.submit(); await measure(f); }
    if (route === 'binding judgment') { await f.reviewer(); await ops.review({ ...f, as: { role: 'reviewer', id: 'drive-a-1-1' }, node: 'a', verdict: 'block', rank: 1, note: 'still binding' }); }
    // An outstanding repair/submit makes a subsequent ruling follow-up the old redundant halt cause.
    if (route === 'no candidate') await writeFile(join(f.slot.worktree, 'a.txt'), 'work left');
    if (route !== 'exhausted repairs') await f.driver.pass();
    await f.rule(route === 'writer true');
    const follow = rulingFollowUp(await f.state(), 'a')!;
    if (route === 'writer true') assert.doesNotMatch(follow.message, /no change:/); else assert.ok(follow.message.includes(noChange), follow.message);
    if (route === 'rejected send') f.dsa.rejectRuling = true;
    await f.driver.pass(); const sent = (await ops.readState(f)).entries.findLast(e => e.kind === 'send' && e.reason === 'ruling')!;
    assert.ok(sent?.kind === 'send', JSON.stringify(f.lines));
    await f.driver.pass(); const h = (await ops.readState(f)).entries.findLast(e => e.kind === 'halt');
    assert.ok(h?.kind === 'halt', JSON.stringify(f.lines));
    if (route === 'writer true') { assert.match(h.reason, /finished ruling follow-up/); assert.ok(f.lines.findLast(l => l.do === 'halt')!.need); }
    else if (route === 'rejected send') assert.match(h.reason, /dsa rejected send/);
    else { assert.doesNotMatch(h.reason, /finished ruling follow-up/); assert.match(h.reason, route === 'exhausted repairs' ? /repairs exhausted/ : route === 'no candidate' ? /finished without submitting/ : /finished repair follow-up/); }
    const s = await f.state(); assert.equal(s.nodes.a!.accepted, false); assert.equal(s.nodes.a!.merged, undefined);
    assert.ok(!f.lines.some(l => l.do === 'merge' && l.outcome === 'merged'));
  } finally { await f.done(); }
});

test('DR5/R-028-32: ops.rule live reviewer notify uses reviewer role; writer selection is unchanged', async () => {
  const f = await fixture({ review: { count: 1, min_rank: 1 } });
  try {
    await f.submit(); const l = await f.reviewer(); f.dsa.views.set(l.rid, { rid: l.rid, state: 'running' }); f.dsa.views.set(f.launch.rid, { rid: f.launch.rid, state: 'running' });
    const r = await f.rule(); const s = await f.state(); assert.equal(f.dsa.sent.length, 2);
    const reviewer = f.dsa.sent.find(x => x.rid === l.rid)!; assert.equal(reviewer.kind, 'notify'); assert.match(reviewer.text, new RegExp(`--ack-rulings ${r.seq}`)); assert.doesNotMatch(reviewer.text, /owed submit/);
    assert.equal(reviewer.text, rulingMessage('a', 'reviewer', s.rules.filter(x => x.seq === r.seq)));
    assert.equal(f.dsa.sent.find(x => x.rid === f.launch.rid)!.text, rulingFollowUp(s, 'a')!.message);
  } finally { await f.done(); }
});

test('DR7: resume --after dependency merge enters the same automatic rebase route as plan deps', async () => {
  const f = await fixture({}, [node('dep')]);
  try {
    await f.submit(); await measure(f); await ops.resume({ ...f, as: parent, node: 'a', after: 'dep', note: 'wait' });
    await f.driver.pass(); assert.ok(!f.lines.some(l => l.do === 'rebase' && l.node === 'a'));
    const slot = (await f.state()).nodes.dep!.slot!; await commitAt(slot.worktree, { 'dep.txt': 'dependency' });
    await ops.submit({ cwd: slot.worktree, as: { role: 'writer', id: 'dep#1' }, node: 'dep' }); await ops.attest({ ...f, node: 'dep', lease: false }); await ops.merge({ ...f, as: parent, node: 'dep', lease: false });
    await f.driver.pass(); const rebase = f.lines.find(l => l.do === 'rebase' && l.node === 'a')!; assert.ok(rebase,JSON.stringify(f.lines)); assert.equal(rebase.outcome, 'done');
    const s = await f.state(); assert.equal(s.nodes.a!.slot!.base, s.trunk.commit); assert.ok(s.nodes.a!.slot!.rebase);
    await f.driver.pass(); assert.equal(f.lines.filter(l => l.do === 'rebase' && l.node === 'a').length, 1);
  } finally { await f.done(); }
});
