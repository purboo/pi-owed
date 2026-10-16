import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import { Ledger, entryHash } from '../src/ledger.ts';
import { parsePlan } from '../src/plan.ts';
import { clockTime } from '../src/clock.ts';
import type { CandidateFacts, Draft } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const owner = {role: 'owner', id: 'pi'} as const;
const key = (n: number) => n.toString(16).padStart(64, '0');
const now = Date.UTC(2026, 0, 1, 12);
const plan = (reads = ['src/**']) => ({version: 1, trunk: 'main', closure: [] as string[],
  invariants: [{id: 'route', run: 'true', reads, timeout_s: 100, min_tests: 1}],
  nodes: ['a', 'b', 'c'].map(id => ({id, writes: [`${id}/`], checks: [{id: 'unit', run: 'true', reads: ['test/**'], min_tests: 1}], review: {count: 0, min_rank: 1}}))});
async function run(cwd: string, args: string[], code = 0) {
  const out = await cli(cwd, args); assert.equal(out.code, code, out.stderr + out.stdout); return out.stdout.trim();
}
async function fixture() {
  const r = await repo();
  await r.put('src/route/a.ts', '0'); await r.put('src/route/b.ts', '0'); await r.put('test/a.ts', '0');
  const commits = [await r.commit()];
  for (let i = 1; i <= 3; i++) { await r.put('src/route/a.ts', String(i)); await r.put('test/a.ts', String(i)); commits.push(await r.commit()); }
  const p = plan(), ledger = await Ledger.open(r.cwd), sha = await ledger.putBlob(JSON.stringify(parsePlan(JSON.stringify(p))));
  const drafts: Draft[] = [];
  const add = (draft: Draft) => { drafts.push(draft); return drafts.length - 1; };
  const state = (commit: string, k: string) => ({commit, tree: commit, invKeys: {route: k}});
  const facts = (commit: string): CandidateFacts => ({commit, base: commits[Math.max(0, commits.indexOf(commit) - 1)]!, tree: commit, patch: key(8), changed: [], closureTouched: false, keys: {writes: key(9), review: key(9), rulings: key(9), 'check:unit': key(10)}});
  add({kind: 'genesis', by: 'owner:pi', channel: 'delegated', trunk: 'main', commit: commits[0]!, plan: sha, state: state(commits[0]!, key(1))});
  const obs = (commit: string, k: string, durationMs: number, extra: Partial<Extract<Draft, {kind: 'obs'}>> = {}) => add({kind: 'obs', by: 'executor:owed', subject: 'trunk', obligation: 'inv:route', key: k, commit, verdict: 'pass', exit: 0, durationMs, counts: {tests: 1, pass: 1, fail: 0, format: 'tap'}, ...extra});
  obs(commits[0]!, key(1), 1000);
  for (let i = 1; i <= 3; i++) {
    const node = ['a', 'b', 'c'][i - 1]!, commit = commits[i]!, k = key(i + 1);
    add({kind: 'dispatch', by: 'parent:drive', node, attempt: 1, base: commits[i - 1]!, branch: `owed/${node}/1`, worktree: join(r.root, node), packet: key(9), rulings_seen: 0});
    add({kind: 'submit', by: `writer:${node}#1`, node, attempt: 1, facts: facts(commit)});
    add({kind: 'obs', by: 'executor:owed', subject: node, obligation: 'writes', key: key(9), commit, verdict: 'pass', exit: 0, durationMs: 0});
    add({kind: 'obs', by: 'executor:owed', subject: node, obligation: 'check:unit', key: key(10), commit, verdict: 'pass', exit: 0, durationMs: 100, counts: {tests: 1, pass: 1, fail: 0}});
    obs(commit, k, i * 1000 + 2000, {merging: node, lease_wait_ms: 100});
    add({kind: 'merge', by: 'executor:owed', node, attempt: 1, prior: commits[i - 1]!, commit, facts: facts(commit), state: state(commit, k)});
  }
  obs(commits[3]!, key(4), 2000, {verdict: 'fail', exit: 1, counts: undefined, lease_wait_ms: 50}); // setup: no test ran
  add({kind: 'obs', by: 'executor:owed', subject: 'a', obligation: 'check:unit', key: key(10), commit: commits[1]!, verdict: 'fail', exit: 1, durationMs: 100, counts: {tests: 1, pass: 0, fail: 1}, failed: ['unit failed'], lease_wait_ms: 20});
  // Timeout and error are real failures, not setup failures; same-key probes do not add invalidations.
  obs(commits[3]!, key(4), 6000, {verdict: 'fail', exit: 124, counts: undefined, note: 'timeout after 100s'});
  obs(commits[3]!, key(4), 7000, {verdict: 'error', exit: null, counts: undefined});
  const entries = await ledger.withLock(() => ledger.append(drafts));
  // Deterministic injected time for seq/ISO windows, without consulting the wall clock.
  for (const e of entries) { e.ts = new Date(now + e.seq * 1000).toISOString(); e.prev = entries[e.seq - 1]?.hash ?? '0'.repeat(64); e.hash = entryHash(e); }
  await writeFile(join(ledger.dir, 'ledger.jsonl'), entries.map(e => JSON.stringify(e)).join('\n') + '\n');
  return {r, ledger, entries, commits, p};
}

test('CO1: CLI cost lines and JSON count machine time, merges, setup failures and read-restricted invalidations', async () => {
  const {r, ledger} = await fixture();
  try {
    const file = join(ledger.dir, 'ledger.jsonl'), before = await readFile(file, 'utf8');
    const result = JSON.parse(await run(r.cwd, ['report', '--cost', '--json']));
    assert.deepEqual(result.obligations.map((x: {id: string}) => x.id), ['inv:route', 'check:unit']);
    const inv = result.obligations[0];
    assert.equal(inv.runs, 7); assert.deepEqual(inv.durationMs, {total: 28000, median: 4000, p90: 7000});
    assert.equal(inv.failures, 2); assert.equal(inv.setupFailures, 1); assert.equal(inv.lease_wait_ms, 350);
    assert.deepEqual(inv.merges, {measured: 3, total: 3});
    assert.deepEqual(inv.invalidatingPrefixes, [{prefix: 'src/route', runs: 3}]);
    assert.equal(inv.measuredTrunkKeys, 4);
    assert.equal(result.obligations[1].failures, 1); assert.equal(result.obligations[1].setupFailures, 0);
    const text = await run(r.cwd, ['report', '--cost']);
    assert.match(text, /^inv:route: 7 runs; total 28s, median 4s, p90 7s; failures 2, setup failures 1; lease_wait_ms 350; measured on 3 of 3 merges/m);
    assert.match(text, /\ncheck:unit: 4 runs; total 0.4s/);
    assert.equal(text.split('\n').at(-1), 'narrow reads of inv:route: src/route changed its key in 3 of 4 runs');
    assert.equal(await readFile(file, 'utf8'), before, 'cost reporting must not append');
    assert.equal((await ops.verify({cwd: r.cwd})).ok, true);
  } finally { await r.cleanup(); }
});

test('CO1: exclusive seq and ISO windows keep the preceding trunk key; invalid options refuse', async () => {
  const {r, entries} = await fixture();
  try {
    const since = entries.find(e => e.kind === 'merge')!;
    const seq = JSON.parse(await run(r.cwd, ['report', '--cost', '--since', String(since.seq), '--json']));
    const iso = JSON.parse(await run(r.cwd, ['report', '--cost', '--since', since.ts, '--json']));
    assert.deepEqual(seq.obligations, iso.obligations);
    assert.deepEqual(seq.obligations[0].merges, {measured: 2, total: 2});
    assert.deepEqual(seq.obligations[0].invalidatingPrefixes, [{prefix: 'src/route', runs: 2}]);
    assert.equal(clockTime(since.ts, now), clockTime(now, now));
    assert.match(await run(r.cwd, ['--help']), /--cost/);
    for (const flags of [['--since', 'nope'], ['--metrics'], ['--counterfactual'], ['--until', '10']]) await run(r.cwd, ['report', '--cost', ...flags], 2);
    const empty = JSON.parse(await run(r.cwd, ['report', '--cost', '--since', String(entries.at(-1)!.seq), '--json']));
    assert.ok(empty.obligations.every((r: {runs: number}) => r.runs === 0)); assert.equal(empty.advice, null);
  } finally { await r.cleanup(); }
});

test('CO1: real ops merges distinguish a freshly measured invariant from a reused key', async () => {
  const r = await repo();
  try {
    await r.put('src/a.ts', '0'); await r.put('notes/b', '0'); await r.commit();
    const p = plan(); p.nodes = p.nodes.slice(0, 2); p.nodes[0]!.writes = ['src/']; p.nodes[1]!.writes = ['notes/'];
    for (const spec of [...p.invariants, ...p.nodes.flatMap(n => n.checks)]) spec.run = `printf 'owed-counts {"pass":1,"fail":0}\\n'`;
    await ops.init({cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify(p), lease: false});
    for (const [node, files] of [['a', {'src/a.ts': '1'}], ['b', {'notes/b': '1'}]] as const) {
      const slot = await ops.dispatch({cwd: r.cwd, as: {role: 'parent', id: 'pi'}, node});
      await commitAt(slot.worktree, files);
      await ops.submit({cwd: slot.worktree, as: {role: 'writer', id: `${node}#1`}, node});
      await ops.attest({cwd: r.cwd, node, lease: false});
      await ops.merge({cwd: r.cwd, as: owner, channel: 'delegated', node, lease: false});
    }
    const result = JSON.parse(await run(r.cwd, ['report', '--cost', '--json']));
    const inv = result.obligations.find((x: {id: string}) => x.id === 'inv:route');
    assert.equal(inv.runs, 2); assert.deepEqual(inv.merges, {measured: 1, total: 2});
    assert.deepEqual(inv.invalidatingPrefixes, [{prefix: 'src/a.ts', runs: 1}]);
    assert.equal(result.advice, null, 'one of two samples is not a dominating majority');
    assert.equal((await ops.verify({cwd: r.cwd})).ok, true);
  } finally { await r.cleanup(); }
});

test('CO2: reads ** warns once per id at init and plan admission, without changing ledger kinds', async () => {
  const r = await repo();
  try {
    await r.put('src/a.ts', '0'); await r.commit();
    const p = plan(['**']); p.nodes[0]!.checks[0]!.reads = ['**'];
    const init = await ops.init({cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify(p), measure: false});
    const message = 'warning: reads of inv:route cover 100% of the repository: almost every change remeasures it (owed report --cost)';
    assert.equal(init.warnings?.filter(x => x === message).length, 1);
    assert.ok(init.warnings?.includes(message.replace('inv:route', 'check:unit')));
    const path = join(r.root, 'plan.json'); await writeFile(path, JSON.stringify(p));
    const plain = await run(r.cwd, ['plan', path, '--as', 'owner:pi', '--note', 'same plan']);
    assert.equal(plain.split('\n').filter(x => x === message).length, 1);
    const json = JSON.parse(await run(r.cwd, ['plan', path, '--as', 'owner:pi', '--note', 'same plan', '--json']));
    assert.equal(json.warnings.filter((x: string) => x === message).length, 1);
    assert.deepEqual((await (await Ledger.open(r.cwd)).read()).map(e => e.kind), ['genesis', 'plan', 'plan']);
  } finally { await r.cleanup(); }
});

test('CO2: 90% tracked trunk coverage warns but 80% and untracked working-tree files do not', async () => {
  const r = await repo();
  try {
    for (let i = 0; i < 10; i++) await r.put(`f${i}`, '0'); await r.commit();
    await r.put('untracked', 'not trunk');
    const p = plan(Array.from({length: 9}, (_, i) => `f${i}`));
    p.nodes[0]!.checks[0]!.reads = ['f[0-8]'];
    const first = await ops.init({cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify(p), measure: false});
    assert.ok(first.warnings?.some(x => /^warning: reads of inv:route cover 90%/.test(x)));
    assert.ok(first.warnings?.some(x => /^warning: reads of check:unit cover 90%/.test(x)));
    p.invariants[0]!.reads = ['f[0-7]']; p.nodes.forEach(n => n.checks[0]!.reads = ['f[0-7]']);
    const warnings: string[] = [];
    await ops.planSet({cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify(p), note: 'narrow scope', shellWarnings: warnings});
    assert.ok(!warnings.some(x => /cover .*% of the repository/.test(x)));
  } finally { await r.cleanup(); }
});

test('CO2: closure read lint uses the existing glob matcher and names the base-version path once', async () => {
  const r = await repo();
  try {
    await r.put('config/locked.json', '{}'); await r.put('config/free.txt', '0'); await r.commit();
    const p = plan(['src/**']); p.closure = ['config/*.json'];
    p.nodes[0]!.checks[0]!.reads = ['config/**']; p.nodes[1]!.checks[0]!.id = 'other'; p.nodes[1]!.checks[0]!.reads = ['config/*.txt'];
    p.nodes[2]!.checks[0]!.reads = ['config/*.json'];
    const r0 = await ops.init({cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify(p), measure: false});
    const message = 'warning: check unit reads closure path config/locked.json: checks see the base version of closure files';
    assert.equal(r0.warnings?.filter(w => w === message).length, 1);
    assert.ok(!r0.warnings?.some(w => /^warning: check other reads closure path/.test(w)));
    assert.equal(r0.status.invariants[0]!.status, 'D', 'lint must not satisfy evidence');
  } finally { await r.cleanup(); }
});

async function appendTimed(ledger: Ledger, commit: string, durationMs: number, extra: Partial<Extract<Draft, {kind: 'obs'}>> = {}) {
  return ledger.withLock(() => ledger.append([{kind: 'obs', by: 'executor:owed', subject: 'trunk', obligation: 'inv:route', key: key(4), commit, verdict: 'pass', exit: 0, durationMs, counts: {tests: 1, pass: 1, fail: 0}, ...extra}]));
}

test('CO3: status warns at 80%, not the latest 79% pass or a refused merge tree, without creating obligations', async () => {
  const {r, ledger, commits} = await fixture();
  try {
    await appendTimed(ledger, commits[3]!, 80000);
    const before = (await ops.status({cwd: r.cwd})).invariants;
    const warning = "inv:route took 80s of timeout 100s; an automatic remeasure doubles a merge's wall time";
    assert.ok((await run(r.cwd, ['status'])).split('\n').includes(warning));
    const slow = await ops.status({cwd: r.cwd}); assert.deepEqual(slow.runtimeWarnings, [warning]); assert.deepEqual(slow.invariants, before);
    await appendTimed(ledger, commits[3]!, 79000);
    // A fresh merge-tree measurement which never landed is not a trunk pass.
    const p = plan(); p.nodes.push({...p.nodes[0]!, id: 'd', writes: ['src/']});
    await ops.planSet({cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify(p), note: 'new candidate'});
    const slot = await ops.dispatch({cwd: r.cwd, as: {role: 'parent', id: 'pi'}, node: 'd'});
    const refused = await commitAt(slot.worktree, {'src/route/a.ts': 'unlanded'});
    await ops.submit({cwd: slot.worktree, as: {role: 'writer', id: 'd#1'}, node: 'd', commit: refused});
    await appendTimed(ledger, refused, 99000, {merging: 'd'});
    assert.ok(!(await run(r.cwd, ['status'])).includes('automatic remeasure doubles'));
    assert.equal((await ops.status({cwd: r.cwd})).runtimeWarnings, undefined);
  } finally { await r.cleanup(); }
});

test('CO3: plan lint repeats the latest slow trunk-pass warning once and omits it below 80%', async () => {
  const {r, ledger, commits, p} = await fixture();
  try {
    await appendTimed(ledger, commits[3]!, 80000);
    const path = join(r.root, 'plan.json'); await writeFile(path, JSON.stringify(p));
    const text = await run(r.cwd, ['plan', path, '--as', 'owner:pi', '--note', 'runtime visibility']);
    assert.equal(text.split('\n').filter(x => x.includes('automatic remeasure doubles')).length, 1);
    await appendTimed(ledger, commits[3]!, 79000);
    const json = JSON.parse(await run(r.cwd, ['plan', path, '--as', 'owner:pi', '--note', 'runtime visibility', '--json']));
    assert.ok(!json.warnings.some((x: string) => x.includes('automatic remeasure doubles')));
    assert.equal((await ops.verify({cwd: r.cwd})).ok, true);
  } finally { await r.cleanup(); }
});
