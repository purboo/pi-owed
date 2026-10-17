import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { repo } from '../helpers/repo.ts';
import { commitAt } from '../helpers/surface.ts';
import { sha256 } from '../../src/canon.ts';
import { entryHash } from '../../src/ledger.ts';
import { manualKeys } from '../../src/reducer.ts';
import { clockTime } from '../../src/clock.ts';
import type { CandidateFacts, Draft, Entry } from '../../src/types.ts';
import type { Renderer, Result, SurfaceNode } from '../perf/needs-replay.ts';

// RP / hard rule 7: every test imports the candidate tool in its body, so each is red on the base.
const api = () => import('../perf/needs-replay.ts');
const at = Date.parse('2026-10-17T12:00:00Z');
async function fixture(t: TestContext, mode = 'owner') {
  t.mock.timers.enable({ apis: ['Date'], now: at });
  const f = await repo(); t.after(() => f.cleanup());
  const base = await commitAt(f.cwd, { 'a/value': 'base' });
  const commit = await commitAt(f.cwd, { 'a/value': 'candidate' });
  const blobs = join(f.root, 'replay-blobs'); await mkdir(blobs);
  const plan = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: [
    { id: 'a', deps: [], writes: ['a/'], checks: [{ id: 'stress', run: 'false', reads: ['a/'], timeout_s: 10 }],
      review: { count: 0, min_rank: 1 }, approve: 'owner', evidence: [{ id: 'proof', what: 'proof', by: 'owner' }] },
    { id: 'dep', deps: [], writes: ['dep/'], checks: [], review: { count: 0, min_rank: 1 } },
  ] };
  const blob = async (text: string) => { const hash = sha256(text); await writeFile(join(blobs, hash), text); return hash; };
  const planSha = await blob(JSON.stringify(plan)), packet = await blob('synthetic dispatch packet'), log = await blob('synthetic check log');
  const entries: Entry[] = [];
  const add = (draft: Draft) => {
    const entry = { ...draft, seq: entries.length, ts: new Date(at + entries.length * 1000).toISOString(), prev: entries.at(-1)?.hash ?? '0'.repeat(64) } as Omit<Entry, 'hash'>;
    const e = { ...entry, hash: entryHash(entry) } as Entry; entries.push(e); return e;
  };
  add({ kind: 'genesis', by: 'owner:pi', channel: 'delegated', plan: planSha, trunk: 'main', commit: base, state: { commit: base, tree: sha256('base'), invKeys: {} } });
  add({ kind: 'dispatch', by: 'parent:drive', node: 'a', attempt: 1, base, branch: 'synthetic', worktree: f.cwd, packet, rulings_seen: -1 });
  const facts: CandidateFacts = { commit, base, tree: sha256('candidate'), patch: sha256('patch'), changed: ['a/value'], closureTouched: false,
    keys: { 'check:stress': sha256('stress'), writes: sha256('writes'), rulings: sha256('rulings'), ...manualKeys(plan.nodes[0] as never, sha256('patch')) } };
  add({ kind: 'submit', by: 'writer:a#1', node: 'a', attempt: 1, facts });
  if (mode !== 'recover') {
    for (const obligation of ['check:stress', 'writes']) add({ kind: 'obs', by: 'executor:owed', subject: 'a', obligation, key: facts.keys[obligation]!, verdict: 'pass', exit: 0, durationMs: 1, commit, base, log });
  }
  if (mode !== 'recover') add({ kind: 'review', by: 'owner:pi', channel: 'delegated', node: 'a', attempt: 1, obligation: 'approve', key: facts.keys.approve!, verdict: 'block', rank: 3, note: 'owner acceptance pending' });
  if (mode === 'halt') add({ kind: 'halt', by: 'parent:drive', node: 'a', attempt: 1, reason: 'stalled: awaiting owner acceptance', needs: 'owner' });
  if (mode === 'recover') {
    add({ kind: 'review', by: 'owner:pi', channel: 'delegated', node: 'a', attempt: 1, obligation: 'approve', key: facts.keys.approve!, verdict: 'block', rank: 3, note: 'owner blocked' });
    add({ kind: 'abandon', by: 'parent:pi', node: 'a', attempt: 1, reason: 'new attempt needed; owner block remains' });
  }
  const ledger = join(f.root, 'replay.jsonl');
  const save = () => writeFile(ledger, entries.map(e => JSON.stringify(e)).join('\n') + '\n'); await save();
  return { ...f, blobs, ledger, entries, add, save, blob, plan, planSha, log };
}
async function run(f: { ledger: string; blobs: string }, render?: Renderer, flags: string[] = []) {
  const { replayMain } = await api(); let output = '', error = '';
  const code = await replayMain([f.ledger, '--blobs', f.blobs, '--json', ...flags], { log: s => { output += s; }, error: s => { error += s; } }, render);
  assert.equal(error, '', error); assert.ok(output, 'CLI must emit the coverage report');
  return { code, report: JSON.parse(output) as { assumptions: Record<string, unknown>; results: Result[] }, output };
}
// Start with actual status/why/decide output, then seed exactly one comparison risk.
async function renderer(transform: (n: SurfaceNode) => SurfaceNode): Promise<Renderer> {
  const { renderCurrent } = await api(); return (state, now, timing) => { const s = renderCurrent(state, now, timing); return { ...s, nodes: s.nodes.map(n => n.node === 'a' ? transform(n) : n) }; };
}

test('RP normal: CLI renders real status, compact items and emitted owner notice with no command errors', async t => {
  const f = await fixture(t), { renderCurrent } = await api();
  let calls = 0;
  const rendered: Renderer = (s, now, timing) => { calls++; assert.equal(now, Date.parse(f.entries[s.seq]!.ts)); assert.equal(clockTime(now, now), clockTime(f.entries[s.seq]!.ts, now)); const out = renderCurrent(s, now, timing);
    if (s.seq === f.entries.at(-1)!.seq) { const a = out.nodes.find(n => n.node === 'a')!; assert.ok(a.notice[0]?.includes('owed approve a')); assert.ok(a.why.items.some(i => i.obligation === 'evidence:proof')); }
    return out; };
  const r = await run(f, rendered, ['--seqs', String(f.entries.at(-1)!.seq)]);
  assert.equal(r.code, 0); assert.equal(calls, 1); assert.deepEqual(r.report.results[0]!.errors, { a: 0, b: 0, c: 0 });
  assert.equal(r.report.assumptions.now, 'sampled entry.ts');
  assert.ok(r.report.results[0]!.coverage.notEmitted > 0, 'ready dep has no actual owner notice');
  const timing = r.report.results[0]!.timing; assert.ok(timing.foldMs > 0 && timing.planParseMs > 0);
  assert.equal(timing.samples.length, 1); assert.ok(timing.samples[0]!.statusMs > 0 && timing.samples[0]!.whyMs > 0 && timing.samples[0]!.decideMs > 0 && timing.samples[0]!.auditMs > 0);
});

test('RP(a): seeded primary disagreement is detected through the replay CLI', async t => {
  const f = await fixture(t), render = await renderer(n => ({ ...n, status: n.status.map((s, i) => i === 0 ? s.replace('owed approve a', 'owed resume a') : s) }));
  const r = await run(f, render, ['--seqs', String(f.entries.at(-1)!.seq)]);
  assert.equal(r.code, 1); assert.ok(r.report.results[0]!.errors.a > 0); assert.match(r.output, /primary command differs/);
});

test('RP(b): unknown argv is detected rather than accepted as surface text', async t => {
  const f = await fixture(t), render = await renderer(n => ({ ...n, status: n.status.map(s => s + ' --imaginary') }));
  const r = await run(f, render, ['--seqs', String(f.entries.at(-1)!.seq)]);
  assert.equal(r.code, 1); assert.ok(r.report.results[0]!.errors.b > 0); assert.match(r.output, /Unknown option --imaginary/);
});

test('RP(b)/N2: required flag absent despite validateArgv allowing it is detected', async t => {
  const f = await fixture(t), render = await renderer(n => ({ ...n, notice: n.notice.map(s => s.replace(/ --candidate [a-f0-9]+/, '').replace(/ --as owner:<id>/, '')) }));
  const r = await run(f, render, ['--seqs', String(f.entries.at(-1)!.seq)]);
  assert.ok(r.report.results[0]!.errors.b > 0); assert.match(r.output, /missing --candidate/); assert.match(r.output, /missing --as/);
});

test('RP(c)/C8: a command for another obligation cannot discharge the shown evidence need', async t => {
  const f = await fixture(t), render = await renderer(n => ({ ...n, notice: n.notice.map(s => s.replace('owed evidence a proof', 'owed evidence a wrong-proof')),
    why: { ...n.why, items: n.why.items.map(i => i.obligation === 'evidence:proof' ? { ...i, line: i.line.replace('owed evidence a proof', 'owed evidence a wrong-proof') } : i) } }));
  const r = await run(f, render, ['--seqs', String(f.entries.at(-1)!.seq)]);
  assert.equal(r.code, 1); assert.ok(r.report.results[0]!.errors.c >= 2); assert.match(r.output, /evidence:wrong-proof differs from need evidence:proof/);
});

test('RP coverage: missing current candidate is a need without a command, not zero errors', async t => {
  const f = await fixture(t, 'recover'), r = await run(f, undefined, ['--seqs', String(f.entries.at(-1)!.seq)]);
  assert.equal(r.code, 2); assert.ok(r.report.results[0]!.coverage.uncovered > 0); assert.match(r.output, /need without a single command/);
});

test('RP coverage: an owner obligation without a need is reported even when membership intentionally suppresses it', async t => {
  const f = await fixture(t); f.add({ kind: 'resume', by: 'parent:pi', node: 'a', attempt: 1, after: 'dep' }); await f.save();
  const r = await run(f, undefined, ['--seqs', String(f.entries.at(-1)!.seq)]);
  assert.equal(r.code, 2); assert.ok(r.report.results[0]!.findings.uncovered.some(f => f.obligation === 'approve' && f.reason.includes('without a need')));
});

test('RP coverage: missing plan and missing observation blobs are reported without fabricated state', async t => {
  const f = await fixture(t); await rm(join(f.blobs, f.planSha)); await rm(join(f.blobs, f.log));
  const r = await run(f);
  assert.equal(r.code, 2); assert.ok(r.report.results[0]!.coverage.missingBlobs >= 3); assert.match(r.output, /cannot replay after missing plan/);
  assert.equal(r.report.results[0]!.samples, 0); assert.match(r.output, /no sampled output/);
});

test('RP coverage: empty synthetic surface output fails coverage even with zero command errors', async t => {
  const f = await fixture(t), { renderCurrent } = await api();
  const render: Renderer = (s, now) => { renderCurrent(s, now); return { nodes: [], unavailable: [] }; };
  const r = await run(f, render, ['--seqs', String(f.entries.at(-1)!.seq)]);
  assert.equal(r.code, 2); assert.equal(r.report.results[0]!.errors.b, 0); assert.match(r.output, /empty surface output/);
});

test('RP sampling: union of every N, explicit seqs and halts is unique; absent seq and empty ledger fail', async t => {
  const f = await fixture(t, 'halt'), { renderCurrent } = await api(); const seqs: number[] = [];
  const r = await run(f, (s, now) => { seqs.push(s.seq); return renderCurrent(s, now); }, ['--every', '3', '--seqs', '3,999', '--halts']);
  assert.deepEqual(seqs, [0, 3, 6]); assert.equal(r.code, 2); assert.match(r.output, /requested seq absent/); assert.match(r.output, /halted/);
  await writeFile(f.ledger, ''); const empty = await run(f); assert.equal(empty.code, 2); assert.match(empty.output, /no sampled output/);
});

async function oldSources(f: { root: string }) {
  const old = join(f.root, 'old-src'); await mkdir(old);
  const sources = {
    'reducer.ts': `export { reduce, extendState, entriesOf } from ${JSON.stringify(fileURLToPath(new URL('../../src/reducer.ts', import.meta.url)))};`,
    'plan.ts': `export { parsePlan } from ${JSON.stringify(fileURLToPath(new URL('../../src/plan.ts', import.meta.url)))};`,
    'views.ts': `export { statusView, renderStatus, receipt, renderWhy } from ${JSON.stringify(fileURLToPath(new URL('../../src/views.ts', import.meta.url)))};\nfunction itemNext(){throw Error('private called')} function ownerNotify(){throw Error('private called')}`,
  };
  for (const [file, text] of Object.entries(sources)) await writeFile(join(old, file), text);
  return { old, sources };
}

test('RP compatibility: 0.27.2 private surfaces stay unavailable; adapter is read-only', async t => {
  const f = await fixture(t), { adapter0272 } = await api(), { old, sources } = await oldSources(f);
  const adapter = await adapter0272(old); assert.equal(typeof adapter.render, 'function');
  const r = await run(f, undefined, ['--seqs', String(f.entries.at(-1)!.seq), '--baseline-src', old]);
  const baseline = r.report.results[1]!; assert.equal(baseline.version, '0.27.2'); assert.equal(baseline.coverage.unavailable, 2);
  assert.deepEqual(baseline.findings.unavailable.map(f => f.surface), ['itemNext', 'ownerNotify']); assert.equal(baseline.coverage.notEmitted, 0);
  for (const [file, text] of Object.entries(sources)) assert.equal(await readFile(join(old, file), 'utf8'), text);
});

test('RP memory: lazy frozen plans permit repeated historical lookups without retaining all plan versions', async t => {
  const f = await fixture(t), { renderCurrent } = await api();
  for (let i = 0; i < 12; i++) { const prior = f.entries.findLast(e => e.kind === 'plan' || e.kind === 'genesis')!;
    const plan = await f.blob(JSON.stringify({ ...f.plan, nodes: f.plan.nodes.map(n => ({ ...n, title: `plan-${i}` })) }));
    f.add({ kind: 'plan', by: 'owner:pi', channel: 'delegated', plan, prior: prior.kind === 'plan' || prior.kind === 'genesis' ? prior.plan : '', downgrades: [] });
  }
  await f.save();
  const { retainedPlanValues } = await import('../../src/reducer.ts'); let peak = 0;
  const r = await run(f, (s, now) => { peak = Math.max(peak, retainedPlanValues(s)); return renderCurrent(s, now); });
  assert.equal(r.code, 0); assert.ok(peak <= 5, `retained ${peak} parsed plans`); assert.equal(r.report.results[0]!.entries, f.entries.length);
});

test('RP R-028-65: only the exact historical suffix is removed and counted', async t => {
  const f = await fixture(t), suffix = ' (skip this when owed drive is running: the driver attests)';
  const normalized = await run(f, await renderer(n => ({ ...n, status: n.status.map(s => s + suffix) })), ['--seqs', '5']);
  assert.equal(normalized.code, 0); assert.equal(normalized.report.results[0]!.normalizedLines, 2);
  const distinct = await run(f, await renderer(n => ({ ...n, status: n.status.map(s => s + suffix.replace('skip this', 'skip that')) })), ['--seqs', '5']);
  assert.equal(distinct.code, 1); assert.equal(distinct.report.results[0]!.normalizedLines, 0); assert.ok(distinct.report.results[0]!.errors.b > 0);
});

test('RP R-028-65: single-engine old comparison has a current oracle but does not render current surfaces', async t => {
  const f = await fixture(t), { old } = await oldSources(f);
  const r = await run(f, () => assert.fail('old-only must not render current surfaces'), ['--seqs', '5', '--baseline-src', old, '--engine', '0.27.2']);
  assert.equal(r.report.results.length, 1); assert.equal(r.report.results[0]!.version, '0.27.2'); assert.ok(r.report.results[0]!.timing.oracleFoldMs > 0);
  assert.deepEqual(r.report.results[0]!.errors, { a: 0, b: 0, c: 0 });
});

test('RP R-028-67: structural diagnostic notify without a command or owner need is separate coverage', async t => {
  const f = await fixture(t), render = await renderer(n => ({ ...n, notice: ['a: diagnostic (no single command)'], diagnostic: true, notEmitted: undefined }));
  const r = await run(f, render, ['--seqs', '1']);
  assert.equal(r.report.results[0]!.coverage.diagnostic, 1); assert.equal(r.report.results[0]!.errors.a, 0);
  assert.match(r.output, /diagnostic notify \(need:null\)/);
});

test('RP R-028-67 limit 1: diagnostic command without a supporting need is still disagreement', async t => {
  const f = await fixture(t), render = await renderer(n => ({ ...n, notice: ['a: diagnostic → owed resume a'], diagnostic: true, notEmitted: undefined }));
  const r = await run(f, render, ['--seqs', '2']);
  assert.equal(r.code, 1); assert.match(r.output, /command unsupported by a need/);
});

test('RP R-028-67 limit 2: diagnostic notify cannot hide a live owner need', async t => {
  const f = await fixture(t), render = await renderer(n => ({ ...n, notice: ['a: diagnostic (no single command)'], diagnostic: true, notEmitted: undefined }));
  const r = await run(f, render, ['--seqs', '5']);
  assert.equal(r.code, 1); assert.match(r.output, /misses an owner need/);
});

test('RP R-028-66: per-engine persistent JSON equals fresh fixture parsing; corrupt/partial cache falls back', async t => {
  const f = await fixture(t), { old } = await oldSources(f), cache = join(f.root, 'plan-cache');
  const plans = [f.planSha];
  for (let i = 0; i < 3; i++) {
    const prior = plans.at(-1)!, plan = await f.blob(JSON.stringify({ ...f.plan, nodes: f.plan.nodes.map(n => ({ ...n, title: `cache-${i}` })) }));
    plans.push(plan); f.add({ kind: 'plan', by: 'owner:pi', channel: 'delegated', prior, plan, downgrades: [] });
  }
  await f.save(); const { parsePlan } = await import('../../src/plan.ts');
  for (const engine of ['0.28', '0.27.2']) {
    const flags = ['--baseline-src', old, '--engine', engine, '--plan-cache', cache];
    const cold = await run(f, undefined, flags); assert.ok(cold.report.results[0]!.timing.planParses > 0);
    const warm = await run(f, undefined, flags); assert.equal(warm.report.results[0]!.timing.planParses, 0);
    assert.ok(warm.report.results[0]!.timing.jsonReads >= plans.length);
    for (const sha of plans) {
      const json = JSON.parse(await readFile(join(cache, `${engine}-${sha}.json`), 'utf8'));
      assert.deepEqual(json.plan, parsePlan(await readFile(join(f.blobs, sha), 'utf8')));
    }
    await writeFile(join(cache, `${engine}-${plans[0]}.json`), '{"partial":');
    await writeFile(join(cache, `${engine}-${plans[1]}.json`), JSON.stringify({ engine, sha: plans[1], bytes: 1, digest: 'corrupt', plan: {} }));
    const repaired = await run(f, undefined, flags); assert.ok(repaired.report.results[0]!.timing.planParses >= 2);
    assert.deepEqual(repaired.report.results[0]!.errors, warm.report.results[0]!.errors);
  }
});

test('RP R-028-66: shard merge preserves all findings/totals; missing and duplicate shards fail closed', async t => {
  const f = await fixture(t), { replayMain } = await api();
  const render = await renderer(n => ({ ...n, status: n.status.map(s => s + ' --imaginary') }));
  const whole = await run(f, render), files: string[] = [];
  for (let i = 0; i < 3; i++) {
    const shard = await run(f, render, ['--shard', `${i}/3`]);
    const file = join(f.root, `shard-${i}.json`); await writeFile(file, shard.output); files.push(file);
  }
  let merged = '', error = '';
  const io = { log: (s: string) => { merged = s; }, error: (s: string) => { error = s; } };
  assert.equal(await replayMain(['--merge', ...files], io), whole.code); assert.equal(error, '');
  const semantic = (r: Result) => ({ entries: r.entries, samples: r.samples, nodes: r.nodes, normalizedLines: r.normalizedLines, errors: r.errors, coverage: r.coverage, findings: r.findings, itemBranches: r.itemBranches, itemInfo: r.itemInfo, truncated: r.truncated });
  assert.deepEqual(semantic(JSON.parse(merged).results[0]), semantic(whole.report.results[0]!));
  assert.equal(await replayMain(['--merge', ...files.slice(1)], io), 2); assert.match(error, /missing shard/);
  assert.equal(await replayMain(['--merge', ...files, files[0]!], io), 2); assert.match(error, /duplicate/);
});

test('RP R-028-69 P1: absent or empty compact item rows fail coverage, including secondary needs', async t => {
  const f = await fixture(t);
  for (const empty of [false, true]) {
    const r = await run(f, await renderer(n => ({ ...n, why: { ...n.why, items: empty ? n.why.items.map(i => ({ ...i, line: '' })) : [] } })), ['--seqs', '5']);
    assert.notEqual(r.code, 0); const missing = r.report.results[0]!.findings.uncovered.filter(x => x.surface === 'compact why item');
    assert.deepEqual(missing.map(x => x.obligation).sort(), ['approve', 'evidence:proof']);
    assert.ok(missing.every(x => x.reason === 'missing output for a need'));
  }
});

test('RP R-028-69 P1: deleting a secondary status, notice or compact Next row is uncovered', async t => {
  const f = await fixture(t);
  for (const surface of ['status', 'owner notice', 'compact why next']) {
    const render = await renderer(n => surface === 'status' ? { ...n, status: n.status.slice(0, 1) }
      : surface === 'owner notice' ? { ...n, notice: n.notice.slice(0, 1) } : { ...n, why: { ...n.why, next: [] } });
    const r = await run(f, render, ['--seqs', '5']); assert.notEqual(r.code, 0);
    assert.ok(r.report.results[0]!.findings.uncovered.some(x => x.surface === surface && x.obligation === 'evidence:proof' && x.reason === 'missing output for a need'));
  }
});

test('RP R-028-69 P2: a secondary command for the wrong need is disagreement, not only invalid argv', async t => {
  const f = await fixture(t), r = await run(f, await renderer(n => ({ ...n, status: n.status.map(s => s.replace('owed evidence a proof', 'owed resume a')) })), ['--seqs', '5']);
  assert.equal(r.code, 1); assert.ok(r.report.results[0]!.findings.a.some(x => x.surface === 'status' && x.obligation === 'evidence:proof'));
});

test('RP R-028-69 P2: diagnostic prose commands use the validator act vocabulary, without requiring arrows', async t => {
  const f = await fixture(t);
  for (const act of ['resume', 'attest', 'review']) {
    const r = await run(f, await renderer(n => ({ ...n, notice: [`a: diagnostic; run owed ${act} a (no single command)`], diagnostic: true, notEmitted: undefined })), ['--seqs', '1']);
    assert.equal(r.code, 1); assert.match(r.output, /command unsupported by a need/);
  }
  const notAct = await run(f, await renderer(n => ({ ...n, notice: ['a: owed nonsense is not an act'], diagnostic: true, notEmitted: undefined })), ['--seqs', '1']);
  assert.equal(notAct.report.results[0]!.errors.a, 0);
});

test('RP R-028-69 P2: sample ordinal partitions every 2 and every multiple of N without empty shards', async t => {
  const f = await fixture(t), { replayMain } = await api();
  for (const every of [2, 4]) {
    const whole = await run(f, undefined, ['--every', String(every)]), files: string[] = [], seen: number[][] = [];
    for (let i = 0; i < 2; i++) {
      const r = await run(f, undefined, ['--every', String(every), '--shard', `${i}/2`]);
      seen.push(r.report.results[0]!.timing.samples.map(s => s.seq)); assert.ok(seen[i]!.length > 0);
      const file = join(f.root, `ordinal-${every}-${i}.json`); await writeFile(file, r.output); files.push(file);
    }
    assert.deepEqual(seen, every === 2 ? [[0, 4], [2]] : [[0], [4]]);
    let output = ''; await replayMain(['--merge', ...files], { log: s => { output = s; }, error: s => assert.fail(s) });
    const merged = JSON.parse(output).results[0] as Result, expected = whole.report.results[0]!;
    for (const key of ['entries', 'samples', 'nodes', 'errors', 'coverage', 'findings', 'itemBranches', 'itemInfo'] as const) assert.deepEqual(merged[key], expected[key]);
  }
});

test('RP R-028-69 P1: missing/restored blob inputs cannot merge to partial success', async t => {
  const f = await fixture(t), { replayMain } = await api(), packet = f.entries.find(e => e.kind === 'dispatch')!;
  assert.equal(packet.kind, 'dispatch'); if (packet.kind !== 'dispatch') return;
  const file = join(f.blobs, packet.packet), original = await readFile(file), reports: string[] = [];
  for (let i = 0; i < 2; i++) {
    if (i === 0) await rm(file); else await writeFile(file, original);
    const r = await run(f, undefined, ['--seqs', '5', '--shard', `${i}/2`]);
    assert.equal(r.report.results[0]!.global.missingBlobs.length, i === 0 ? 1 : 0);
    const report = join(f.root, `blob-shard-${i}.json`); await writeFile(report, r.output); reports.push(report);
  }
  let error = ''; const code = await replayMain(['--merge', ...reports], { log: () => assert.fail('mismatched input must not merge'), error: s => { error = s; } });
  assert.equal(code, 2); assert.match(error, /incompatible shard reports/);
});

test('RP R-028-69 P1: identical global missing/fold facts count once after merge', async t => {
  const f = await fixture(t), { replayMain } = await api(); await rm(join(f.blobs, f.log));
  // A validly serialized but invalid draft exercises the fold-failure global list.
  f.add({ kind: 'review', by: 'reviewer:external', node: 'a', attempt: 1, obligation: 'approve', key: '0'.repeat(64), verdict: 'block', rank: 3, note: 'invalid actor' }); await f.save();
  const whole = await run(f), files: string[] = [];
  assert.ok(whole.report.results[0]!.global, 'whole-input facts must be explicit in every report');
  assert.equal(whole.report.results[0]!.global.missingBlobs.length, 2);
  assert.equal(whole.report.results[0]!.global.foldFailures.length, 1);
  for (let i = 0; i < 2; i++) {
    const r = await run(f, undefined, ['--shard', `${i}/2`]);
    assert.deepEqual(r.report.results[0]!.global, whole.report.results[0]!.global);
    const file = join(f.root, `global-${i}.json`); await writeFile(file, r.output); files.push(file);
  }
  let output = ''; await replayMain(['--merge', ...files], { log: s => { output = s; }, error: s => assert.fail(s) });
  const merged = JSON.parse(output).results[0] as Result;
  assert.deepEqual(merged.coverage, whole.report.results[0]!.coverage); assert.deepEqual(merged.findings, whole.report.results[0]!.findings);
});

test('RP R-028-71: repair item equal to Need.text is informational, with status still enforcing its command', async t => {
  const f = await fixture(t);
  const render = await renderer(n => ({ ...n, why: { ...n.why, items: n.why.items.map(i => i.obligation === 'approve' ? { ...i, line: i.line.split(' → ')[0]! } : i) } }));
  const r = await run(f, render, ['--seqs', '5']);
  assert.equal(r.code, 0); assert.equal(r.report.results[0]!.itemBranches.ii, 1);
  assert.match(r.output, /item shows need text without command/);
  const missingStatus = await run(f, await renderer(n => ({ ...n, status: [], why: { ...n.why, items: n.why.items.map(i => i.obligation === 'approve' ? { ...i, line: i.line.split(' → ')[0]! } : i) } })), ['--seqs', '5']);
  assert.notEqual(missingStatus.code, 0); assert.ok(missingStatus.report.results[0]!.coverage.uncovered > 0);
});

test('RP R-028-71: need-form wrong command and contextual different command are disagreements', async t => {
  const f = await fixture(t);
  for (const contextual of [false, true]) {
    const r = await run(f, await renderer(n => ({ ...n, why: { ...n.why, items: n.why.items.map(i => i.obligation === 'approve' ? { ...i, line: contextual ? '⛔ approve: contextual work → owed resume a' : i.line.replace('owed approve a', 'owed resume a') } : i) } })), ['--seqs', '5']);
    assert.equal(r.code, 1); assert.ok(r.report.results[0]!.errors.a > 0);
    assert.ok(contextual ? r.report.results[0]!.itemBranches.iv > 0 : r.report.results[0]!.itemBranches.i > 0);
  }
});

test('RP R-028-71: contextual no-command item is informational; dangling need arrow is still wrong', async t => {
  const f = await fixture(t);
  const context = await run(f, await renderer(n => ({ ...n, why: { ...n.why, items: n.why.items.map(i => i.obligation === 'approve' ? { ...i, line: '⛔ approve: repair context awaiting original reviewer' } : i) } })), ['--seqs', '5']);
  assert.equal(context.code, 0); assert.equal(context.report.results[0]!.itemBranches.iii, 1);
  const missing = await run(f, await renderer(n => ({ ...n, why: { ...n.why, items: n.why.items.map(i => i.obligation === 'approve' ? { ...i, line: i.line.split(' → ')[0]! + ' → ' } : i) } })), ['--seqs', '5']);
  assert.equal(missing.code, 1); assert.ok(missing.report.results[0]!.errors.a > 0);
});

test('RP standalone CLI: report and nonzero exit survive process boundary; invalid flags fail usage', async t => {
  const f = await fixture(t), { replayMain } = await api(); assert.equal(typeof replayMain, 'function');
  const tool = fileURLToPath(new URL('../perf/needs-replay.ts', import.meta.url));
  const child = await promisify(execFile)(process.execPath, [tool, f.ledger, '--blobs', f.blobs, '--seqs', String(f.entries.at(-1)!.seq), '--json'], { timeout: 30_000, maxBuffer: 2 * 1024 * 1024 });
  assert.equal(JSON.parse(child.stdout).results[0].errors.a, 0);
  let error = ''; const code = await replayMain([f.ledger, '--blobs', f.blobs, '--every', '0'], { log: () => assert.fail('usage must not emit a success report'), error: s => { error = s; } });
  assert.equal(code, 2); assert.match(error, /positive/);
});
