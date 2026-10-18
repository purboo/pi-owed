import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, mkdir, symlink, rm } from 'node:fs/promises';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import * as git from '../src/git.ts';
import { Ledger } from '../src/ledger.ts';
import { parsePlan } from '../src/plan.ts';
import { reduce, trunkRedOf } from '../src/reducer.ts';
import { needs } from '../src/needs.ts';
import { renderStatus, renderReceipt } from '../src/views.ts';
import type { ObsEntry } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

const parent = { role: 'parent', id: 'test' } as const;
const owner = { role: 'owner', id: 'pi' } as const;
const quote = (text: string) => `'${text.replace(/'/g, `'"'"'`)}'`;
const diagnostics = [
  `ENOENT: no such file or directory, open 'data/new.txt'`,
  `data/new.txt: No such file or directory`,
  `No such file or directory: 'data/new.txt'`,
  `can't open file 'data/new.txt'`,
];
async function fixture(diagnostic = diagnostics[0]!, absolute = false, options: { tail?: string; initial?: Record<string,string>; deleted?: string } = {}) {
  const r = await repo();
  try {
    const output = absolute ? `printf "ENOENT: open '%s/data/new.txt'\\n" "$OWED_TREE"` : `printf '%s\\n' ${quote(diagnostic)}`;
    const script = `if ! test -f data/new.txt; then ${output}; exit 1; fi\nif grep -q broken flag; then printf 'heading\\n'; printf '%s\\n\\n' ${quote(options.tail ?? 'missing: no production/test diff')}; exit 1; fi\necho '# tests 1'; echo '# pass 1'\n`;
    await commitAt(r.cwd, { flag: 'clean', 'check.sh': script, ...options.initial });
    const plan = { version: 1, trunk: 'main', lease: false, closure: [], invariants: [], nodes: [{ id: 'a', writes: ['data/', ...(options.deleted ? [options.deleted] : [])], checks: [{ id: 'runtime', run: 'bash check.sh', reads: ['flag', 'data/', 'check.sh'] }] }] };
    await ops.init({ cwd: r.cwd, plan: JSON.stringify(plan), as: owner, channel: 'delegated' });
    const a = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
    if (options.deleted) await rm(join(a.worktree,options.deleted));
    const candidate = await commitAt(a.worktree, { 'data/new.txt': 'candidate-only data' });
    await ops.submit({ cwd: a.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
    assert.equal((await ops.attest({ cwd: r.cwd, node: 'a' })).accepted, true);
    const ledger = await Ledger.open(r.cwd);
    const state = async (stripMarker = false) => {
      const entries = await ledger.read(), plans = new Map<string, ReturnType<typeof parsePlan>>();
      for (const e of entries) if (e.kind === 'genesis' || e.kind === 'plan') plans.set(e.plan, parsePlan((await ledger.getBlob(e.plan)).toString()));
      return reduce(entries.filter(e => !(stripMarker && e.kind === 'obs' && e.probe === 'trunk')).map(e => stripMarker && e.kind === 'obs' ? { ...e, note: e.note?.replace(/\nmerge failure output: [^\n]*$/, '') } : e), sha => plans.get(sha)!);
    };
    const observations = async () => (await ledger.read()).filter((e): e is ObsEntry => e.kind === 'obs');
    return { ...r, a, candidate, ledger, state, observations };
  } catch (e) { await r.cleanup(); throw e; }
}

for (const [index, diagnostic] of diagnostics.entries()) test(`PB1: explicit trunk probe recognizes missing-file pattern ${index + 1}`, async () => {
  const r = await fixture(diagnostic);
  try {
    const before = await r.state();
    const result = await ops.attestProbeTrunk({ cwd: r.cwd, node: 'a', check: 'runtime', runs: 3 });
    const probe = result.checks[0]!.observations[0]!;
    assert.equal(probe.kind, 'obs');
    if (probe.kind !== 'obs') assert.fail('expected observation');
    assert.equal(probe.verdict, 'error');
    assert.equal(probe.note, 'probe not applicable: trunk lacks data/new.txt, which the candidate adds');
    assert.equal(result.checks[0]!.observations.length, 1, 'non-pass stops repeat probes');
    assert.deepEqual((await r.state()).nodes.a!.items, before.nodes.a!.items);
    assert.deepEqual((await r.state()).nodes.a!.blocks, before.nodes.a!.blocks);
  } finally { await r.cleanup(); }
});

test('PB1/PB2: automatic probe error never makes the ordinary merge failure trunk-red; tail reaches refusal, need and status', async () => {
  const r = await fixture(undefined, true);
  try {
    await commitAt(r.cwd, { flag: 'broken' });
    await ops.adopt({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'move trunk for merge failure' });
    await assert.rejects(ops.merge({ cwd: r.cwd, node: 'a', as: parent }), e => {
      assert.ok(e instanceof Error);
      assert.match(e.message, /missing: no production\/test diff/);
      assert.doesNotMatch(e.message, /trunk-red:/);
      return true;
    });
    const obs = await r.observations(), probe = obs.findLast(e => e.probe === 'trunk')!, merge = obs.find(e => e.merging === 'a')!;
    assert.equal(probe.verdict, 'error');
    assert.equal(probe.note, 'probe not applicable: trunk lacks data/new.txt, which the candidate adds');
    assert.equal(merge.verdict, 'fail'); assert.equal(merge.failed?.length ?? 0, 0);
    assert.match(merge.note!, /\nmerge failure output: missing: no production\/test diff$/);
    const s = await r.state();
    assert.equal(trunkRedOf(s, merge.seq), undefined);
    assert.match(needs(s, 'a')[0]!.text, /missing: no production\/test diff/);
    const status = await ops.status({ cwd: r.cwd });
    assert.match(status.summary!.needs[0]!.reason, /missing: no production\/test diff/);
    for (const text of [renderStatus(status), renderReceipt(await ops.why({ cwd: r.cwd, node: 'a' }))]) {
      assert.match(text, /missing: no production\/test diff/); assert.doesNotMatch(text, /trunk-red:/);
    }
  } finally { await r.cleanup(); }
});

test('PB2/R-029-2 unchanged: anonymous merge blocks without the new marker retain the exact 0.28 need text', async () => {
  const r = await fixture();
  try {
    await commitAt(r.cwd, { flag: 'broken' });
    await ops.adopt({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'move trunk' });
    await assert.rejects(ops.merge({ cwd: r.cwd, node: 'a', as: parent }));
    const old = needs(await r.state(true), 'a')[0]!;
    assert.equal(old.text, 'check:runtime: check:runtime still blocked:');
    const merge = (await r.observations()).find(e => e.merging === 'a')!;
    // The former note's tail contains the same words but no marker: it must not activate the new helper.
    assert.match(merge.note!, /last output:/);
    assert.doesNotMatch(old.text, /missing: no production\/test diff/);
  } finally { await r.cleanup(); }
});

test('PB1: canonical inside/outside absolute paths, symlinked root, and non-additions/present/deleted paths', async () => {
  const r = await repo();
  try {
    const base = await commitAt(r.cwd, { 'present.txt': 'old', 'deleted.txt': 'old', 'modified.txt': 'old' });
    await rm(join(r.cwd, 'deleted.txt'));
    const candidate = await commitAt(r.cwd, { 'data/new.txt': 'added', 'modified.txt': 'changed' });
    const root = join(r.root, 'probe-tree'); await mkdir(root);
    const link = join(r.root, 'probe-link'); await symlink(root, link);
    const apply = async (path: string, trunk = base, checkout = root) => git.missingProbeAddition(r.cwd, base, candidate, trunk, checkout, `ENOENT: open '${path}'`);
    assert.equal(typeof git.missingProbeAddition, 'function', 'PB1 path applicability helper exists');
    for (const path of ['data/new.txt', './data/new.txt', join(root, 'data/new.txt'), join(link, 'data/new.txt')]) assert.equal(await apply(path, base, link), 'data/new.txt', path);
    for (const path of [join(r.root, 'outside/data/new.txt'), '../data/new.txt', 'untracked.txt', 'modified.txt', 'deleted.txt', 'present.txt']) assert.equal(await apply(path), undefined, path);
    assert.equal(await apply('data/new.txt', candidate), undefined, 'an addition present on trunk remains applicable');
  } finally { await r.cleanup(); }
});

for (const [name, diagnostic] of [['not added', `ENOENT: open 'untracked.txt'`], ['outside absolute', `ENOENT: open '/outside/data/new.txt'`]] as const) test(`PB1: ${name} explicit probe stays fail`, async () => {
  const r = await fixture(diagnostic);
  try {
    const result = await ops.attestProbeTrunk({ cwd: r.cwd, node: 'a', check: 'runtime' });
    const probe = result.checks[0]!.observations[0]!;
    assert.ok(probe.kind === 'obs'); assert.equal(probe.verdict, 'fail');
    assert.doesNotMatch(probe.note ?? '', /probe not applicable/);
  } finally { await r.cleanup(); }
});

for (const deleted of [false, true]) test(`PB1 unchanged: ${deleted ? 'deleted by candidate' : 'present on trunk'} path remains a failed probe`, async () => {
  const r = await fixture(`ENOENT: open 'existing.txt'`, false, { initial: { 'existing.txt':'trunk file' }, ...(deleted ? { deleted:'existing.txt' } : {}) });
  try {
    const result = await ops.attestProbeTrunk({ cwd:r.cwd, node:'a', check:'runtime' });
    const probe = result.checks[0]!.observations[0]!;
    assert.ok(probe.kind === 'obs'); assert.equal(probe.verdict,'fail'); assert.doesNotMatch(probe.note ?? '',/probe not applicable/);
  } finally { await r.cleanup(); }
});

test('PB2: the last output line is escaped and bounded in a new merge-block need', async () => {
  const tail = `failure:\t\\\u202e ${'x'.repeat(200)}`, r = await fixture(undefined, false, { tail });
  try {
    await commitAt(r.cwd, { flag:'broken' });
    await ops.adopt({ cwd:r.cwd, as:owner, channel:'delegated', note:'move trunk' });
    await assert.rejects(ops.merge({ cwd:r.cwd, node:'a', as:parent }));
    const merge = (await r.observations()).find(e => e.merging === 'a')!;
    const marker = merge.note!.split('\nmerge failure output: ')[1]!;
    assert.ok(marker, 'new anonymous merge observations carry the fixed marker');
    assert.equal(marker.length,160);
    assert.match(marker,/^failure:\\t\\\\\\u202e /); assert.doesNotMatch(marker,/[\t\u202e\n]/);
    assert.ok(needs(await r.state(),'a')[0]!.text.endsWith(marker));
  } finally { await r.cleanup(); }
});

test('PB2/R-029-6: anonymous invariant failures on the merge tree retain their original note without a marker', async () => {
  const r = await repo();
  try {
    await commitAt(r.cwd, { flag: 'clean' });
    const plan = { version: 1, trunk: 'main', lease: false, closure: [], invariants: [{ id: 'anon', run: 'if test -f impl; then echo invariant-anonymous-tail; exit 1; fi; echo "# tests 1"; echo "# pass 1"', reads: ['impl'] }], nodes: [{ id: 'a', writes: ['impl'], checks: [] }] };
    await ops.init({ cwd: r.cwd, plan: JSON.stringify(plan), as: owner, channel: 'delegated' });
    const slot = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
    await commitAt(slot.worktree, { impl: 'candidate' });
    await ops.submit({ cwd: slot.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
    assert.equal((await ops.attest({ cwd: r.cwd, node: 'a' })).accepted, true);
    await assert.rejects(ops.merge({ cwd: r.cwd, node: 'a', as: parent }), error => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /invariant-anonymous-tail/);
      assert.doesNotMatch(error.message, /merge failure output:/);
      return true;
    });
    const ledger = await Ledger.open(r.cwd);
    const failures = (await ledger.read()).filter((e): e is ObsEntry => e.kind === 'obs' && e.merging === 'a' && e.obligation === 'inv:anon');
    assert.ok(failures.length, 'the invariant ran on the merge tree');
    for (const obs of failures) {
      assert.equal(obs.verdict, 'fail'); assert.equal(obs.failed?.length ?? 0, 0);
      assert.equal(obs.note, 'command exited 1 with no recognizable test count; last output:\n  invariant-anonymous-tail');
    }
  } finally { await r.cleanup(); }
});

test('PB1: diagnostic notes escape controls, preserve whole escape sequences and stay bounded', async () => {
  const path = `data/${'x'.repeat(130)}\u202e.txt`, r = await fixture(`ENOENT: open '${path}'`);
  try {
    await commitAt(r.a.worktree, { [path]: 'added' });
    await ops.submit({ cwd: r.a.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
    const result = await ops.attestProbeTrunk({ cwd: r.cwd, node: 'a', check: 'runtime' });
    const probe = result.checks[0]!.observations[0]!;
    assert.ok(probe.kind === 'obs'); assert.equal(probe.verdict, 'error');
    assert.ok(probe.note!.length <= 160); assert.doesNotMatch(probe.note!, /[\n\r\u202e]/);
    assert.doesNotMatch(probe.note!, /\\u[0-9a-f]{0,3}$/);
  } finally { await r.cleanup(); }
});

test('PB3: check authoring documents the synthetic merge parents and prohibits base-pinning', async () => {
  const spec = await readFile(new URL('../docs/SPEC.md', import.meta.url), 'utf8');
  assert.match(spec, /HEAD\^1.*trunk tip.*HEAD\^2.*candidate/);
  assert.match(spec, /must not pin the candidate's base commit/);
});

test('GC1: threshold counts registered finished attempts only; status and merge reply are read-only hints', async () => {
  const r = await repo();
  try {
    await r.commit();
    const plan = { version: 1, trunk: 'main', lease: false, closure: [], invariants: [], worktrees: { root: join(r.root, 'slots'), branch: 'slot/{node}-{attempt}' }, nodes: [{ id: 'a', writes: ['impl'], checks: [] }] };
    await ops.init({ cwd: r.cwd, plan: JSON.stringify(plan), as: owner, channel: 'delegated' });
    const closed: ops.DispatchPacket[] = [];
    for (let i = 0; i < 5; i++) {
      const a = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
      closed.push(a);
      await ops.abandon({ cwd: r.cwd, node: 'a', as: parent, reason: 'fixture finished attempt' });
      const status = await ops.status({ cwd: r.cwd });
      for (const full of [false, true]) {
        if (i === 4) assert.match(renderStatus(status, { full }), /Housekeeping: 5 finished attempt worktrees; owed gc reclaims them/);
        else assert.doesNotMatch(renderStatus(status, { full }), /Housekeeping:/);
      }
    }
    // Dirty/locked finished attempts count, but no cleanup or safety promise is made by the hint.
    await writeFile(join(closed[0]!.worktree, 'scratch'), 'preserve me');
    await git.git(r.cwd, ['worktree', 'lock', closed[1]!.worktree]);
    const a = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
    const extra = join(r.root, 'unrecorded'); await git.git(r.cwd, ['worktree', 'add', '--detach', extra, 'HEAD']);
    const ledger = await Ledger.open(r.cwd), before = await ledger.read();
    const registered = await git.listWorktrees(r.cwd);
    const status = await ops.status({ cwd: r.cwd });
    assert.match(renderStatus(status), /Housekeeping: 5 finished attempt worktrees/);
    assert.deepEqual(await ledger.read(), before); assert.deepEqual(await git.listWorktrees(r.cwd), registered);
    await commitAt(a.worktree, { impl: 'done' });
    await ops.submit({ cwd: a.worktree, node: 'a', as: { role: 'writer', id: 'a#6' } });
    await ops.attest({ cwd: r.cwd, node: 'a' });
    const merge = await cli(r.cwd, ['merge', 'a']);
    assert.equal(merge.code, 0, merge.stderr);
    assert.match(merge.stdout, /Housekeeping: 6 finished attempt worktrees; owed gc reclaims them/);
    assert.equal(await readFile(join(closed[0]!.worktree, 'scratch'), 'utf8'), 'preserve me');
    await git.git(r.cwd, ['worktree', 'unlock', closed[1]!.worktree]);
    await git.git(r.cwd, ['worktree', 'remove', closed[1]!.worktree]);
    assert.match(renderStatus(await ops.status({ cwd: r.cwd })), /Housekeeping: 5 finished attempt worktrees/);
    // Fake only worktree listing failures; all other Git reads still use real Git.
    const bin = join(r.root, 'bin'); await mkdir(bin);
    const afterMerge = await ledger.read(), mergeCommit = await git.revParse(r.cwd,'HEAD');
    const executable = (await import('node:child_process')).execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    await writeFile(join(bin, 'git'), `#!/bin/sh\nif test "$1" = worktree && test "$2" = list; then exit 1; fi\nexec ${quote(executable)} "$@"\n`, { mode: 0o755 });
    const prior = process.env.PATH; process.env.PATH = `${bin}:${prior}`;
    try {
      for (const full of [false, true]) assert.doesNotMatch(renderStatus(await ops.status({ cwd: r.cwd }), { full }), /Housekeeping:/);
      const lines = await ops.mergedLines(r.cwd, [{ node: 'a', commit: mergeCommit }]);
      assert.doesNotMatch(lines.join('\n'), /Housekeeping:/);
    } finally { process.env.PATH = prior; }
    assert.deepEqual(await ledger.read(), afterMerge);
    assert.equal(await readFile(join(closed[0]!.worktree, 'scratch'), 'utf8'), 'preserve me');
  } finally { await r.cleanup(); }
});
