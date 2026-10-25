import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, writeFile, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import * as ops from '../src/ops.ts';
import * as git from '../src/git.ts';
import { Ledger } from '../src/ledger.ts';
import { parsePlan } from '../src/plan.ts';
import { reduce, trunkRedOf, entriesOf, runLabels, runId, projectId } from '../src/reducer.ts';
import { decide, type DriveOpts } from '../src/drive.ts';
import type { ObsEntry } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { commitAt } from './helpers/surface.ts';

const parent = { role: 'parent', id: 'test' } as const;
const owner = { role: 'owner', id: 'pi' } as const;
const writer = { role: 'writer', id: 'a#1' } as const;
const quote = (s: string) => `'${s.replaceAll("'", `'"'"'`)}'`;
const output = (s: string) => `printf '%s\\n' ${quote(s)}`;
const pass = `echo '# tests 1'; echo '# pass 1'`;
async function stateOf(cwd: string) {
  const ledger = await Ledger.open(cwd), entries = await ledger.read(), plans = new Map<string, ReturnType<typeof parsePlan>>();
  for (const e of entries) if (e.kind === 'genesis' || e.kind === 'plan') plans.set(e.plan, parsePlan((await ledger.getBlob(e.plan)).toString()));
  return reduce(entries, sha => plans.get(sha)!);
}
async function refusal(cwd: string) {
  let message = '';
  await assert.rejects(ops.merge({ cwd, node: 'a', as: parent }), e => { assert.ok(e instanceof Error); message = e.message; return true; });
  return message;
}
async function probeFixture(trunk: string, merged: string, options: { path?: string; reuse?: boolean } = {}) {
  const r = await repo(), path = options.path ?? 'data/new.txt';
  try {
    await commitAt(r.cwd, { flag: 'clean', 'check.sh': `if ! test -f ${quote(path)}; then ${trunk}; exit 1; fi\nif grep -q broken flag; then ${merged}; exit 1; fi\n${pass}\n` });
    const plan = { version: 1, trunk: 'main', lease: false, closure: [], ...(options.reuse ? { exec: { trees: 'reuse' } } : {}), invariants: [], nodes: [{ id: 'a', writes: [path], checks: [{ id: 'runtime', run: 'bash check.sh', reads: ['flag', path, 'check.sh'] }] }] };
    await ops.init({ cwd: r.cwd, plan: JSON.stringify(plan), as: owner, channel: 'delegated' });
    const slot = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
    await commitAt(slot.worktree, { [path]: 'candidate' });
    await ops.submit({ cwd: slot.worktree, node: 'a', as: writer });
    assert.equal((await ops.attest({ cwd: r.cwd, node: 'a' })).accepted, true);
    await commitAt(r.cwd, { flag: 'broken' });
    await ops.adopt({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'exercise merge check' });
    const ledger = await Ledger.open(r.cwd);
    const observations = async () => (await ledger.read()).filter((e): e is ObsEntry => e.kind === 'obs');
    return { ...r, ledger, slot, observations };
  } catch (e) { await r.cleanup(); throw e; }
}

for (const [path, esm, message] of [
  ['evidence/FIX-M1-F-ORIGIN/verify.mjs', false, 'product moved since the measured row: re-measure required'],
  ['evidence/PROGRESS-ROW-SETTLE/real-row.mjs', false, 'AssertionError [ERR_ASSERTION]: row did not settle'],
  ['evidence/PROGRESS-ROW-SETTLE/real-row.mjs', true, 'AssertionError [ERR_ASSERTION]: row did not settle'],
] as const) test(`PA1: field ${path} ${esm ? 'ESM' : 'CJS'} is inapplicable, never trunk-red`, async () => {
  const diagnostic = esm
    ? `printf "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '%s/${path}' imported from %s/entry.mjs\\n" "$OWED_TREE" "$OWED_TREE"`
    : `printf "Error: Cannot find module '%s/${path}'\\n  code: 'MODULE_NOT_FOUND'\\n" "$OWED_TREE"`;
  const r = await probeFixture(diagnostic, output(message), { path, reuse: true });
  try {
    const text = await refusal(r.cwd), obs = await r.observations(), probe = obs.findLast(e => e.probe === 'trunk')!, merge = obs.findLast(e => e.merging === 'a')!;
    assert.equal(probe.verdict, 'error');
    assert.equal(probe.note, `probe not applicable: trunk lacks ${path}, which the candidate adds`);
    assert.equal(trunkRedOf(await stateOf(r.cwd), merge.seq), undefined);
    assert.ok(text.includes(message), text); assert.doesNotMatch(text, /trunk-red:/);
    const explicit = await ops.attestProbeTrunk({ cwd: r.cwd, node: 'a', check: 'runtime' });
    assert.equal((explicit.checks[0]!.observations[0] as ObsEntry).note, probe.note);
  } finally { await r.cleanup(); }
});

test('PA1: module diagnostics require a path, candidate addition and absence on trunk', async () => {
  const r = await repo();
  try {
    const base = await commitAt(r.cwd, { modified: 'old', deleted: 'old' });
    await rm(join(r.cwd, 'deleted'));
    const candidate = await commitAt(r.cwd, { lodash: 'added bare name', 'data/new.mjs': 'added', modified: 'changed' });
    const root = join(r.root, 'probe'); await mkdir(root);
    const detect = (path: string, trunk = base) => git.missingProbeAddition(r.cwd, base, candidate, trunk, root, `Error: Cannot find module '${path}'\n  code: 'MODULE_NOT_FOUND'`);
    assert.equal(await detect('./data/new.mjs'), 'data/new.mjs');
    for (const path of ['lodash', './modified', './deleted', './unknown', '/outside/data/new.mjs']) assert.equal(await detect(path), undefined, path);
    assert.equal(await detect('./data/new.mjs', candidate), undefined);
  } finally { await r.cleanup(); }
});

const cases = [
  { name: 'different error lines despite identical final footer', trunk: 'Error: missing dependency\nfooter', merged: 'Error: verifier refused\nfooter', verdict: 'error', line: 'Error: missing dependency' },
  { name: 'last matching error wins', trunk: 'Error: common\nFAIL trunk\nfooter', merged: 'Error: common\nFAIL merge\nfooter', verdict: 'error', line: 'FAIL trunk' },
  { name: 'fallback to last nonempty line', trunk: 'trunk stopped\n\n', merged: 'merge stopped\n\n', verdict: 'error', line: 'trunk stopped' },
  { name: 'same anonymous failure', trunk: 'Error: same', merged: 'Error: same', verdict: 'fail' },
  { name: 'whitespace normalized', trunk: '  Error:   same \t detail ', merged: 'Error: same detail', verdict: 'fail' },
  { name: 'empty trunk log', trunk: '', merged: 'Error: merge', verdict: 'fail' },
  { name: 'empty merge log', trunk: 'Error: trunk', merged: '', verdict: 'fail' },
  { name: 'bounded escaped diagnostic', trunk: `Error: \u202e${'x'.repeat(250)}`, merged: 'Error: merge', verdict: 'error' },
  { name: 'difference beyond the display bound', trunk: `Error: ${'x'.repeat(200)} trunk`, merged: `Error: ${'x'.repeat(200)} merge`, verdict: 'error' },
];
for (const c of cases) test(`PA2: ${c.name}`, async () => {
  const r = await probeFixture(output(c.trunk), output(c.merged));
  try {
    const text = await refusal(r.cwd), obs = await r.observations(), probe = obs.findLast(e => e.probe === 'trunk')!, merge = obs.findLast(e => e.merging === 'a')!;
    assert.equal(probe.verdict, c.verdict);
    assert.equal(merge.verdict, 'fail'); assert.equal(merge.failed?.length ?? 0, 0);
    assert.equal(!!trunkRedOf(await stateOf(r.cwd), merge.seq), c.verdict === 'fail');
    if (c.verdict === 'error') {
      assert.match(probe.note!, /^probe inconclusive: trunk fails differently \(.+\)$/);
      if (c.line) assert.equal(probe.note, `probe inconclusive: trunk fails differently (${c.line})`);
      assert.ok(probe.note!.length <= 'probe inconclusive: trunk fails differently ()'.length + 160);
      assert.doesNotMatch(probe.note!, /[\r\n\u202e]/); assert.doesNotMatch(text, /trunk-red:/);
      assert.match(merge.note!, /merge failure output:/);
    } else assert.doesNotMatch(probe.note ?? '', /probe inconclusive/);
  } finally { await r.cleanup(); }
});

for (const named of ['trunk', 'merge', 'both']) test(`PA2: named ${named} failures retain existing classification`, async () => {
  const namedOutput = `echo 'owed-counts {"pass":0,"fail":1,"failed":["same test"]}'`;
  const r = await probeFixture(`${output('Error: trunk')}; ${named !== 'merge' ? namedOutput : ':'}`, `${output('Error: merge')}; ${named !== 'trunk' ? namedOutput : ':'}`);
  try {
    await refusal(r.cwd);
    const probe = (await r.observations()).findLast(e => e.probe === 'trunk')!;
    assert.equal(probe.verdict, 'fail'); assert.doesNotMatch(probe.note ?? '', /probe inconclusive/);
  } finally { await r.cleanup(); }
});

test('PA2: actual fresh checkout roots normalize to the same failure', async () => {
  const r = await probeFixture(`printf 'Error: %s/data/config invalid\\n' "$OWED_TREE"`, `printf 'Error: %s/data/config invalid\\n' "$OWED_TREE"`);
  try {
    await refusal(r.cwd);
    const obs = await r.observations(), probe = obs.findLast(e => e.probe === 'trunk')!, merge = obs.findLast(e => e.merging === 'a')!;
    assert.notEqual((await r.ledger.getBlob(probe.log!)).toString(), (await r.ledger.getBlob(merge.log!)).toString());
    assert.equal(probe.verdict, 'fail'); assert.ok(trunkRedOf(await stateOf(r.cwd), merge.seq));
  } finally { await r.cleanup(); }
});

for (const same of [true, false]) test(`PA2: historical observation without root, differing trees paths, same=${same}`, async () => {
  const prefix = '$OWED_DIR/trees';
  const r = await probeFixture(`printf 'Error: %s/current-0/data/config invalid\\n' "${prefix}"`, `printf 'Error: %s/old-9/data/config ${same ? 'invalid' : 'refused'}\\n' "${prefix}"`);
  try {
    await refusal(r.cwd);
    // A later explicit probe reads the recorded merge log, with no runtime root argument.
    const result = await ops.attestProbeTrunk({ cwd: r.cwd, node: 'a', check: 'runtime' });
    const probe = result.checks[0]!.observations[0] as ObsEntry;
    assert.equal(probe.verdict, same ? 'fail' : 'error');
    if (!same) assert.equal(probe.note, 'probe inconclusive: trunk fails differently (Error: <tree>/data/config invalid)');
    else {
      const merge = (await r.observations()).findLast(e => e.merging === 'a')!;
      assert.ok(trunkRedOf(await stateOf(r.cwd), merge.seq));
    }
  } finally { await r.cleanup(); }
});

test('PA2: historical tree prefixes normalize both original and canonical symlink paths', async () => {
  const r = await probeFixture(`printf 'Error: %s/current-0/config invalid\\n' "$OWED_DIR/trees"`, `printf 'Error: %s/old-9/config invalid\\n' "$(readlink -f "$OWED_DIR/trees")"`);
  try {
    const canonical = join(r.root, 'canonical-trees'); await mkdir(canonical); await symlink(canonical,join(r.ledger.dir,'trees'));
    await refusal(r.cwd);
    const result = await ops.attestProbeTrunk({ cwd: r.cwd, node: 'a', check: 'runtime' });
    assert.equal((result.checks[0]!.observations[0] as ObsEntry).verdict, 'fail');
  } finally { await r.cleanup(); }
});

test('PA2: an unreadable historical merge log keeps the probe failure', async t => {
  const r = await probeFixture(output('Error: trunk'), output('Error: merge'));
  try {
    await refusal(r.cwd);
    const merge = (await r.observations()).findLast(e => e.merging === 'a')!, getBlob = Ledger.prototype.getBlob;
    t.mock.method(Ledger.prototype,'getBlob',async function(this: Ledger, sha: string) {
      if (sha === merge.log) throw new Error('unreadable fixture log');
      return getBlob.call(this,sha);
    });
    const result = await ops.attestProbeTrunk({ cwd: r.cwd, node: 'a', check: 'runtime' });
    assert.equal((result.checks[0]!.observations[0] as ObsEntry).verdict, 'fail');
  } finally { t.mock.restoreAll(); await r.cleanup(); }
});

async function hintFixture(overlap: boolean, failingCheck = true) {
  const r = await repo();
  try {
    const baseText = Array.from({ length: 20 }, (_, i) => `line ${i}`).join('\n') + '\n';
    await commitAt(r.cwd, { flag: 'clean', a: baseText, b: baseText, c: baseText, 'inv.sh': `if test -f added && grep -q broken flag; then echo 'Error: candidate broke invariant'; echo 'owed-counts {"pass":0,"fail":1,"failed":["build"]}'; exit 1; fi; ${pass}\n` });
    const run = 'bash inv.sh', reads = ['added', 'flag', 'a', 'b', 'c', 'inv.sh'];
    await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify({ version: 1, trunk: 'main', lease: false, closure: [], invariants: [{ id: 'build', run, reads }], nodes: [{ id: 'a', writes: ['added', 'a', 'b', 'c'], checks: [{ id: 'own', run: failingCheck ? run : pass, reads }] }] }) });
    const slot = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
    await commitAt(slot.worktree, { added: 'candidate', ...(overlap ? Object.fromEntries(['a', 'b', 'c'].map(p => [p, baseText.replace('line 0', 'candidate 0')])) : {}) });
    await ops.submit({ cwd: slot.worktree, node: 'a', as: writer });
    assert.equal((await ops.attest({ cwd: r.cwd, node: 'a' })).accepted, true);
    await commitAt(r.cwd, { flag: 'broken', ...(overlap ? Object.fromEntries(['a', 'b', 'c'].map(p => [p, baseText.replace('line 19', 'trunk 19')])) : {}) });
    await ops.adopt({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'trunk moved' });
    return r;
  } catch (e) { await r.cleanup(); throw e; }
}

for (const overlap of [false, true]) test(`PA3: merge-tree hint, changed path overlap=${overlap}`, async () => {
  const r = await hintFixture(overlap);
  try {
    const text = await refusal(r.cwd);
    assert.ok(text.startsWith('merge tree does not pass inv:build (trunk passes); trunk moved 1 commits since the slot base'), text);
    if (overlap) assert.match(text, /and changed files this node changes \(a, b, \+1\): rebase → owed rebase a/);
    else assert.match(text, /but changed none of the files this node changes, so the node's own change is the likely cause: owed decide a --writer --text "<repair instruction>" \(rebase → owed rebase a only reproduces it on the current trunk\)/);
    const retry = await refusal(r.cwd);
    assert.ok(retry.startsWith(text.split('; a/check:')[0]!), retry);
  } finally { await r.cleanup(); }
});

test('PA3: git diff failure retains the old rebase hint', async () => {
  const r = await hintFixture(false);
  try {
    await refusal(r.cwd);
    const bin = join(r.root, 'bin'); await mkdir(bin);
    const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
    await writeFile(join(bin, 'git'), `#!/bin/sh\nif test "$1" = diff && test "$2" = --no-renames && test "$3" = --name-only; then exit 1; fi\nexec ${quote(realGit)} "$@"\n`, { mode: 0o755 });
    const prior = process.env.PATH; process.env.PATH = `${bin}:${prior}`;
    try { assert.match(await refusal(r.cwd), /^merge tree does not pass inv:build \(trunk passes\); trunk moved 1 commits since the slot base: rebase → owed rebase a/); }
    finally { process.env.PATH = prior; }
  } finally { await r.cleanup(); }
});

test('PA3: repair command after an invariant-only merge halt delivers a writer ruling requiring resubmission', async () => {
  const r = await hintFixture(false, false);
  try {
    const text = await refusal(r.cwd), s = await stateOf(r.cwd), project = projectId(s), rid = runId(project,'a',1,'writer');
    await ops.launch({ cwd: r.cwd, node: 'a', attempt: 1, role: 'writer', rid, spec: '{}', labels: runLabels(project,'a',1,'writer'), as: { role: 'parent', id: 'drive' }, rulings: 0 });
    await ops.halt({ cwd: r.cwd, node: 'a', attempt: 1, reason: text, needs: 'human', as: { role: 'parent', id: 'drive' } });
    await ops.decide({ cwd: r.cwd, nodes: ['a'], text: 'repair the merge failure', writer: true, as: parent, dsa: { describe: async () => ({ rid, state: 'sealed', status: 'ok' }), send: async () => { throw new Error('sealed writer must receive its ruling on the next driver pass'); } } });
    const current = await stateOf(r.cwd), opts: DriveOpts = { max: 1, repairs: 2, project, root: r.cwd, applied: new Set(), rejected: new Map() };
    const actions = decide(current, current.plan, new Map([[rid, { rid, state: 'sealed' as const, status: 'ok' as const }]]), opts);
    assert.ok(actions.some(a => a.do === 'send' && a.node === 'a' && a.reason === 'ruling' && a.message.includes('repair the merge failure')), JSON.stringify(actions));
    assert.ok(entriesOf(current).some(e => e.kind === 'rule' && e.writer && e.seq > s.seq));
  } finally { await r.cleanup(); }
});
