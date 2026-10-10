// K2 (0.7.0, wais #8 part 1, #12 part 2): count notes that say what was counted, the failing note on an exec block's
// line in owed why and owed status, and waivers that say what they mean.
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { repo } from './helpers/repo.ts';
import { parsePlan } from '../src/plan.ts';
import { Ledger } from '../src/ledger.ts';
import { runJob } from '../src/exec.ts';
import * as ops from '../src/ops.ts';
import type { AttestJob, ObsEntry } from '../src/types.ts';
import { cli, commitAt } from './helpers/surface.ts';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';

let r: Awaited<ReturnType<typeof repo>>, ctx: Parameters<typeof runJob>[0], job: AttestJob;
before(async () => {
  r = await repo();
  await r.put('README', 'base');
  const base = await r.commit();
  await r.put('src/x', 'x');
  const cand = await r.commit();
  const plan = parsePlan(`version: 1\ntrunk: main\nnodes:\n - id: a\n   writes: [src/]\n   checks: [{id: unit, run: 'true', min_tests: 5}]`);
  ctx = { cwd: r.cwd, plan, ledger: await Ledger.open(r.cwd) };
  job = { kind: 'check', subject: 'a', obligation: 'check:unit', key: 'key', spec: plan.nodes[0]!.checks[0], commit: cand, base };
});
after(async () => { await r?.cleanup(); });
const run = (command: string, extra: Partial<NonNullable<AttestJob['spec']>> = {}, kind: AttestJob['kind'] = 'check') =>
  runJob(ctx, { ...job, kind, obligation: kind === 'red' ? 'red:unit' : 'check:unit', spec: { ...job.spec!, run: command, ...extra } });
const tap = (tests: number, pass: number, fail: number, skip?: number): string => `echo '# tests ${tests}'; echo '# pass ${pass}'; echo '# fail ${fail}'${skip === undefined ? '' : `; echo '# skipped ${skip}'`}`;

test('K2.1: a non-red check failing on its count says what was counted, against which min_tests, and the exit code', async () => {
  const short = await run(tap(2, 1, 1));
  assert.equal(short.verdict, 'fail');
  assert.equal(short.note, 'min_tests unmet: counted 2 (1 pass, 1 fail) < min_tests 5; exit 0');
  const skipped = await run(tap(3, 2, 0, 1));
  assert.equal(skipped.note, 'min_tests unmet: counted 3 (2 pass, 0 fail, 1 skip) < min_tests 5; exit 0');
  // A counted run that also exits non-zero names that exit.
  const exited = await run(`${tap(2, 2, 0)}; exit 4`);
  assert.equal(exited.verdict, 'fail'); assert.equal(exited.note, 'min_tests unmet: counted 2 (2 pass, 0 fail) < min_tests 5; exit 4');
  // Zero tests (with or without min_tests) and exit 0.
  for (const min_tests of [5, undefined]) {
    const zero = await run(tap(0, 0, 0), { min_tests });
    assert.equal(zero.verdict, 'fail'); assert.equal(zero.note, 'zero tests; exit 0', `min_tests ${min_tests}`);
  }
  // Red notes are unchanged.
  const red = await run(`${tap(0, 0, 0)}; exit 1`, {}, 'red');
  assert.equal(red.verdict, 'fail'); assert.equal(red.note, 'zero tests');
  // A met count has no note.
  assert.equal((await run(tap(5, 5, 0))).note, undefined);
});

const plan = (flag: string) => JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [], nodes: [
  // a: 2 tests < min_tests 3, or 3 tests once the flag file exists (so an attribution rerun passes: flaky).
  { id: 'a', writes: ['src/a', 'doc/a'], checks: [{ id: 'unit', run: `if [ -e '${flag}' ]; then ${tap(3, 3, 0)}; else ${tap(2, 2, 0)}; fi`, min_tests: 3, reads: ['src/a*'] }], review: { count: 0, min_rank: 1 } },
  // b: fails with a long output (its note exceeds 200 characters).
  { id: 'b', writes: ['src/b'], checks: [{ id: 'unit', run: `printf 'y%.0s' $(seq 1 150); echo; printf 'z%.0s' $(seq 1 150); echo; exit 3` }], review: { count: 0, min_rank: 1 } },
  // c: never attested before its waiver.
  { id: 'c', writes: ['src/c'], checks: [{ id: 'unit', run: tap(1, 1, 0) }], review: { count: 0, min_rank: 1 } },
] });

/** A ledger with nodes a, b, c submitted; a and b attested (failing). */
async function fixture() {
  const x = await repo();
  try {
    const flag = join(x.root, 'flag');
    await commitAt(x.cwd, { 'plan.json': plan(flag), README: 'x\n' });
    await ops.init({ cwd: x.cwd, plan: plan(flag), as: { role: 'owner', id: 'human' }, channel: 'flag' });
    const slots: Record<string, string> = {};
    for (const id of ['a', 'b', 'c']) {
      const d = await ops.dispatch({ cwd: x.cwd, node: id, as: { role: 'parent', id: 'main' } });
      slots[id] = d.worktree;
      await commitAt(d.worktree, { [`src/${id}`]: `${id}\n` });
      await ops.submit({ cwd: d.worktree, node: id, as: { role: 'writer', id: `${id}#1` } });
    }
    await ops.attest({ cwd: x.cwd, node: 'a' }); await ops.attest({ cwd: x.cwd, node: 'b' });
    const entries = await (await Ledger.open(x.cwd)).read();
    const obsOf = (id: string) => entries.find((e): e is ObsEntry => e.kind === 'obs' && e.subject === id && e.obligation === 'check:unit');
    const fa = obsOf('a'), fb = obsOf('b');
    if (fa?.verdict !== 'fail' || fb?.verdict !== 'fail') throw new Error(`expected failing observations: ${JSON.stringify([fa, fb])}`);
    return { x, flag, slots, fa, fb };
  } catch (e) { await x.cleanup(); throw e; }
}

test('K2.2: owed why and owed status show an exec block\'s failing note on its line, at most 200 characters', { timeout: 300_000 }, async () => {
  const { x, fa, fb } = await fixture();
  try {
    // The note as recorded (K2.1 is tested above); here only where it is shown.
    const noteA = fa.note ?? '';
    assert.ok(noteA.length > 0 && !noteA.includes('\n'), noteA);
    assert.ok((fb.note ?? '').length > 200, fb.note);
    const shortB = `${(fb.note ?? '').replace(/\n/g, '\\n').slice(0, 199)}…`;

    // K2.2 why: the block line carries the note (one line, at most 200 characters).
    const whyA = (await cli(x.cwd, ['why', 'a'])).stdout;
    const blockA = whyA.split('\n').find(l => l.startsWith(`⛔ blocked #${fa.seq} check:unit`));
    assert.ok(blockA?.endsWith(` — note: ${noteA}`), whyA);
    const whyB = (await cli(x.cwd, ['why', 'b'])).stdout;
    const blockB = whyB.split('\n').find(l => l.startsWith(`⛔ blocked #${fb.seq} check:unit`));
    assert.ok(blockB?.endsWith(` — note: ${shortB}`), whyB);
    assert.equal(shortB.length, 200);
    const card = await ops.why({ cwd: x.cwd, node: 'b' });
    assert.equal(card.blocks.find(b => b.seq === fb.seq)?.note, shortB);
    // K2.2 status: the pending item line held by the block carries the note.
    const status = (await cli(x.cwd, ['status'])).stdout;
    const itemA = status.split('\n').find(l => l.includes('a/check:unit'));
    assert.ok(itemA?.endsWith(` — note #${fa.seq}: ${noteA}`), status);
    const itemB = status.split('\n').find(l => l.includes('b/check:unit'));
    assert.ok(itemB?.endsWith(` — note #${fb.seq}: ${shortB}`), status);
    const sv = await ops.status({ cwd: x.cwd });
    assert.deepEqual(Object.values(sv.pending).flat().find(i => i.subject === 'a' && i.obligation === 'check:unit')?.blockNotes, [{ seq: fa.seq, note: noteA }]);
  } finally { await x.cleanup(); }
});

test('K2.3: waivers say what they mean and their true scope; why shows a waived item as not measured', { timeout: 300_000 }, async () => {
  const { x, flag, slots, fa, fb } = await fixture();
  try {

    // a becomes flaky: the attribution rerun on the original content passes.
    await writeFile(flag, '');
    await ops.attest({ cwd: x.cwd, node: 'a' });
    assert.equal((await ops.why({ cwd: x.cwd, node: 'a' })).blocks.find(b => b.seq === fa.seq)?.state, 'flaky');
    const candA = (await ops.status({ cwd: x.cwd })).nodes.a!.candidate!;
    const keyA = candA.keys['check:unit']!;
    // K2.3 CLI JSON and text.
    const waived = await cli(x.cwd, ['waive', 'a', 'check:unit', '--reason', 'flaky runner', '--accept-risk', String(fa.seq), '--json']);
    assert.equal(waived.code, 0, waived.stderr);
    const json = JSON.parse(waived.stdout) as { kind: string; meaning: string; seq: number };
    assert.equal(json.kind, 'waive');
    const meaningA = `waived check:unit for candidate #${candA.seq} ${candA.commit.slice(0, 12)} (key ${keyA.slice(0, 12)}): owed counts it as waived, not measured, for every candidate of a whose check:unit key is ${keyA.slice(0, 12)}, in this or a later attempt; a change to the check definition, setup, exec, closure or the content of its reads changes the key, and owed measures it again; the flaky block #${fa.seq} stays recorded as accepted risk`;
    assert.equal(json.meaning, meaningA);
    // K2.3 why: the waived item.
    const whyW = (await cli(x.cwd, ['why', 'a'])).stdout;
    assert.ok(whyW.split('\n').some(l => l.startsWith('⚠ a/check:unit waived (not measured for this candidate) by owner:cli (delegated): flaky runner')), whyW);
    // The stated scope holds: a new candidate that leaves the check's reads alone keeps the waiver ...
    await commitAt(slots.a!, { 'doc/a': 'docs\n' });
    await ops.submit({ cwd: slots.a!, node: 'a', as: { role: 'writer', id: 'a#1' } });
    let item = (await ops.why({ cwd: x.cwd, node: 'a' })).items.find(i => i.obligation === 'check:unit')!;
    assert.equal(item.key, keyA); assert.equal(item.status, 'W');
    // ... and one that changes a read file changes the key: owed measures it again.
    await commitAt(slots.a!, { 'src/a': 'a2\n' });
    await ops.submit({ cwd: slots.a!, node: 'a', as: { role: 'writer', id: 'a#1' } });
    item = (await ops.why({ cwd: x.cwd, node: 'a' })).items.find(i => i.obligation === 'check:unit')!;
    assert.notEqual(item.key, keyA); assert.equal(item.status, 'D'); assert.equal(item.mark, '⊥');

    // A waiver that does not accept the active block is recorded but does not take effect, and says so (CLI text).
    const notWaived = await cli(x.cwd, ['waive', 'b', 'check:unit', '--reason', 'r']);
    assert.equal(notWaived.code, 0, notWaived.stderr);
    assert.match(notWaived.stdout, new RegExp(`^recorded waiver #\\d+ of check:unit for candidate #\\d+ [0-9a-f]{12} \\(key [0-9a-f]{12}\\), but check:unit is not waived: check:unit still blocked: #${fb.seq}; a waiver takes effect only when it accepts every active block of check:unit as a risk \\(accept-risk\\)$`, 'm'), notWaived.stdout);

    // A key without an observation is still measured: the waiver says so (pi tool text and details).
    const tools = new Map<string, ToolDefinition>();
    owed({ registerTool(t: ToolDefinition) { tools.set(t.name, t); }, registerCommand() {} } as unknown as ExtensionAPI);
    const res = await tools.get('owed_waive')!.execute('test', { node: 'c', obligation: 'check:unit', reason: 'later' }, undefined, undefined, { cwd: x.cwd, hasUI: false } as unknown as Parameters<ToolDefinition['execute']>[4]);
    assert.notEqual(res.isError, true, JSON.stringify(res.content));
    const text = (res.content[0] as { text: string }).text, meaningC = (res.details as { meaning: string }).meaning;
    assert.equal(text.split('\n')[0], meaningC);
    assert.match(meaningC, /^waived check:unit for candidate #\d+ [0-9a-f]{12} \(key [0-9a-f]{12}\): owed counts it as waived, not measured, for every candidate of c whose check:unit key is [0-9a-f]{12}, in this or a later attempt; .*; this key has no observation yet, so owed attest still measures it: a pass counts as measured, a fail blocks it again$/, meaningC);
    assert.doesNotMatch(meaningC, /flaky/);
    await ops.attest({ cwd: x.cwd, node: 'c' });
    assert.equal((await ops.why({ cwd: x.cwd, node: 'c' })).items.find(i => i.obligation === 'check:unit')?.status, 'E');
  } finally { await x.cleanup(); }
});
