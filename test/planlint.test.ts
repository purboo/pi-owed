import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, mkdir, readFile, readdir, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { repo } from './helpers/repo.ts';
import { cli } from './helpers/surface.ts';

const owner = { role: 'owner', id: 'pi' } as const;
const base = () => ({ version: 1, trunk: 'main', closure: [], invariants: [] as Record<string, unknown>[], nodes: [{ id: 'a', writes: ['src/'], checks: [{ id: 'unit', run: 'true', reads: ['**'] }] }] });
const entries = async (cwd: string) => (await Ledger.open(cwd)).read();
async function fixture() {
  const r = await repo(); await r.commit();
  await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify(base()), measure: false });
  const file = join(r.root, 'plan.json'); await writeFile(file, JSON.stringify(base()));
  await ops.planSet({ cwd: r.cwd, as: owner, channel: 'delegated', ...await ops.readPlan({ cwd: r.cwd, path: file }) });
  return { r, file };
}

test('PL1: CLI init refuses shell syntax without recording genesis or executing checks', async () => {
  const r = await repo();
  try {
    const p = base(); p.nodes[0]!.checks[0]!.run = 'touch executed; if true; then';
    await r.put('plan.json', JSON.stringify(p)); await r.commit();
    const out = await cli(r.cwd, ['init', 'plan.json']);
    assert.notEqual(out.code, 0); assert.match(out.stderr, /a\/unit: bash -n:/);
    assert.deepEqual(await entries(r.cwd), []);
    await assert.rejects(readFile(join(r.cwd, 'executed')), /ENOENT/);
  } finally { await r.cleanup(); }
});

test('PL1: plan checks new and changed node/invariant/setup/diagnostic runs; valid shell is accepted', async () => {
  const { r, file } = await fixture();
  try {
    const before = await entries(r.cwd), blobs = join((await Ledger.open(r.cwd)).dir, 'blobs');
    const beforeBlobs = (await readdir(blobs)).sort();
    const cases: [string, Record<string, unknown>][] = [];
    const changed = base(); changed.nodes[0]!.checks[0]!.run = 'if true; then'; cases.push(['a/unit', changed]);
    const added = base(); added.nodes[0]!.checks.push({ id: 'new', run: 'echo "', reads: ['**'] }); cases.push(['a/new', added]);
    const inv = base(); inv.invariants.push({ id: 'all', run: 'for x in', reads: ['**'] }); cases.push(['inv:all/run', inv]);
    cases.push(['plan/setup', { ...base(), setup: 'if true; then' }]);
    cases.push(['plan/slot_setup', { ...base(), slot_setup: 'if true; then' }]);
    const diagnostic = base(); Object.assign(diagnostic.nodes[0]!.checks[0]!, { on_timeout: 'echo "' }); cases.push(['a/unit/on_timeout', diagnostic]);
    const invDiagnostic = base(); invDiagnostic.invariants.push({ id: 'all', run: 'true', on_timeout: 'echo "' }); cases.push(['inv:all/on_timeout', invDiagnostic]);
    for (const [label, plan] of cases) {
      await writeFile(file, JSON.stringify(plan));
      const out = await cli(r.cwd, ['plan', file, '--as', 'owner:pi', '--note', 'check admission']);
      assert.notEqual(out.code, 0, label); assert.ok(out.stderr.includes(`${label}: bash -n:`), out.stderr);
      assert.deepEqual(await entries(r.cwd), before);
      assert.deepEqual((await readdir(blobs)).sort(), beforeBlobs, 'syntax refusal must not persist any blob');
    }
    const valid = base(); valid.nodes[0]!.checks[0]!.run = 'for x in a b; do printf "%s\\n" "$x"; done';
    await writeFile(file, JSON.stringify(valid));
    assert.equal((await cli(r.cwd, ['plan', file, '--as', 'owner:pi', '--note', 'valid syntax'])).code, 0);
  } finally { await r.cleanup(); }
});

test('PL1: edit and dry-run refuse statically quoted nested bash scripts atomically', async () => {
  const { r, file } = await fixture();
  try {
    const before = await entries(r.cwd), text = await readFile(file, 'utf8');
    const commands = ["bash -c 'echo \"'", 'bash -lc "if true; then"', "bash -c 'bash -lc \"if true; then\"'", "env X=y /bin/bash -lc 'if true; then'"];
    for (const run of commands) for (const dry of [false, true]) {
      const out = await cli(r.cwd, ['edit', 'a', '--set', `checks.unit.run=${JSON.stringify(run)}`, '--note', 'lint edit', ...(dry ? ['--dry-run'] : []), '--as', 'owner:pi']);
      assert.notEqual(out.code, 0, run); assert.match(out.stderr, /a\/unit: bash -n:/);
      assert.equal(await readFile(file, 'utf8'), text); assert.deepEqual(await entries(r.cwd), before);
    }
  } finally { await r.cleanup(); }
});

test('PL1: single/double quoted assignment values preserve nested Bash command position', async () => {
  const { r, file } = await fixture();
  try {
    const before = await entries(r.cwd), text = await readFile(file,'utf8');
    for (const prefix of ["X='value'", 'X="value"', 'X=a Y="b c"']) {
      const run = `${prefix} bash -c 'echo "'`;
      for (const dry of [false,true]) {
        const out = await cli(r.cwd,['edit','a','--set',`checks.unit.run=${JSON.stringify(run)}`,'--note','quoted assignment regression','--as','owner:pi',...(dry ? ['--dry-run'] : [])]);
        assert.notEqual(out.code,0,run); assert.match(out.stderr,/a\/unit: bash -n:/);
        assert.deepEqual(await entries(r.cwd),before); assert.equal(await readFile(file,'utf8'),text);
      }
    }
    // Quoting the command word itself is different from quoting an assignment value.
    const data = base(); data.nodes[0]!.checks[0]!.run = "'X=value' bash -c 'echo \"'";
    await ops.planSet({ cwd:r.cwd, as:owner, channel:'delegated', note:'quoted command data', plan:JSON.stringify(data) });
  } finally { await r.cleanup(); }
});

test('PL1: dynamic arguments and quoted data are not executed; template-expanded runs are linted', async () => {
  const { r, file } = await fixture(), path = process.env.PATH;
  try {
    const valid = base(); valid.nodes[0]!.checks[0]!.run = "echo bash -c 'echo \"'; bash -c \"$SCRIPT\"; cat <<'EOF'\nbash -c 'echo \"'\nEOF\ntrue";
    await writeFile(file, JSON.stringify(valid));
    assert.equal((await cli(r.cwd, ['plan', file, '--as', 'owner:pi', '--note', 'static only'])).code, 0);
    const dir = join(r.root, 'spy'); await mkdir(dir);
    const log = join(r.root, 'syntax-input'), bash = spawnSync('which', ['bash'], { encoding: 'utf8' }).stdout.trim();
    await writeFile(join(dir, 'bash'), `#!/bin/sh\ntee '${log}' | '${bash}' "$@"\n`); await chmod(join(dir, 'bash'), 0o755);
    process.env.PATH = `${dir}:${path}`;
    const template = { ...base(), nodes: [{ id: 'a', writes: ['src/'], checks: [{ id: 'tpl', template: 'node-tap', files: ['test/a.test.cjs'], min_ok: 1 }] }] };
    await ops.planSet({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'expanded template', plan: JSON.stringify(template) });
    assert.match(await readFile(log, 'utf8'), /^# owed-template\//, 'bash -n receives the expanded template run');
  } finally { process.env.PATH = path; await r.cleanup(); }
});

// A PATH without bash still has git: this simulates PL2 without breaking repository operations.
async function withoutBash(root: string) {
  const dir = join(root, 'path'); await mkdir(dir);
  const git = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim(); await symlink(git, join(dir, 'git'));
  return dir;
}

test('PL2: bash missing warns once in CLI JSON and text, admits plans, and records no warning entry', async () => {
  const r = await repo(), path = process.env.PATH;
  try {
    const p = { ...base(), setup: 'true', nodes: [...base().nodes, { id: 'b', writes: ['src/'], checks: [{ id: 'other', run: 'true', reads: ['**'] }] }] };
    await r.put('plan.json', JSON.stringify(p)); await r.commit();
    process.env.PATH = await withoutBash(r.root);
    const out = await cli(r.cwd, ['init', 'plan.json', '--json']); assert.equal(out.code, 0, out.stderr);
    assert.equal((JSON.parse(out.stdout).warnings as string[]).filter(w => /bash is missing/.test(w)).length, 1);
    assert.deepEqual((await entries(r.cwd)).map(e => e.kind), ['genesis']);
    p.nodes[0]!.checks[0]!.run = 'echo changed'; await writeFile(join(r.cwd, 'plan.json'), JSON.stringify(p));
    const next = await cli(r.cwd, ['plan', 'plan.json', '--as', 'owner:pi', '--note', 'missing bash']);
    assert.equal(next.code, 0, next.stderr); assert.equal(next.stdout.split('\n').filter(w => /bash is missing/.test(w)).length, 1);
  } finally { process.env.PATH = path; await r.cleanup(); }
});

test('PL1: ordinary arguments resembling nested Bash are data, not command positions', async () => {
  const { r, file } = await fixture();
  try {
    for (const run of [
      "echo { bash -c 'echo \"'", "echo } bash -c 'echo \"'",
      "echo '{' bash -c 'echo \"'", "echo '(' bash -c 'echo \"'",
      "echo \\{ bash -c 'echo \"'", "printf '%s' then bash -c 'echo \"'",
      "'then' bash -c 'echo \"'", "'time' bash -c 'echo \"'",
      "echo bash -c 'echo \"'", "echo sh -c 'echo \"'",
    ]) {
      const p = base(); p.nodes[0]!.checks[0]!.run = run; await writeFile(file, JSON.stringify(p));
      const result = await cli(r.cwd, ['plan', file, '--as', 'owner:pi', '--note', 'ordinary shell arguments']);
      assert.equal(result.code, 0, `${run}: ${result.stderr}`);
    }
    for (const run of ["time bash -c 'echo \"'", "true && bash -c 'echo \"'", "{ bash -c 'echo \"'; }", "(bash -c 'echo \"')", "sh -c 'echo \"'"]) {
      const p = base(); p.nodes[0]!.checks[0]!.run = run;
      await assert.rejects(ops.planSet({ cwd:r.cwd, as:owner, channel:'delegated', note:'actual shell command', plan:JSON.stringify(p) }), /a\/unit: bash -n:/);
    }
  } finally { await r.cleanup(); }
});

test('PL1: raw legacy diagnostics and runs remain unchanged across plan and title-only edit', async () => {
  const r = await repo(), path = process.env.PATH;
  try {
    await r.commit(); const legacy = base(); legacy.nodes[0]!.checks[0]!.run = 'if true; then';
    Object.assign(legacy.nodes[0]!.checks[0]!, { on_timeout:'echo "' });
    legacy.invariants.push({ id:'all', run:'true', on_timeout:'if true; then' });
    process.env.PATH = await withoutBash(r.root);
    await ops.init({ cwd:r.cwd, as:owner, channel:'delegated', plan:JSON.stringify(legacy), measure:false });
    process.env.PATH = path;
    const file = join(r.root,'legacy.json'); await writeFile(file,JSON.stringify(legacy));
    await ops.planSet({ cwd:r.cwd, as:owner, channel:'delegated', ...await ops.readPlan({ cwd:r.cwd,path:file }) });
    const out = await cli(r.cwd,['edit','a','--set','title=Only the title changes','--note','unchanged legacy diagnostics']);
    assert.equal(out.code,0,out.stderr);
    const changedPlan = structuredClone(legacy);
    Object.assign(changedPlan.nodes[0]!.checks[0]!, { on_timeout:'if false; then' });
    await assert.rejects(ops.planSet({ cwd:r.cwd, as:owner, channel:'delegated', note:'changed diagnostic', plan:JSON.stringify(changedPlan) }), /a\/unit\/on_timeout: bash -n:/);
  } finally { process.env.PATH = path; await r.cleanup(); }
});

test('PL1: unchanged legacy invalid runs remain loadable and are not linted on unrelated plan/edit changes', async () => {
  const r = await repo(), path = process.env.PATH;
  try {
    await r.commit(); const legacy = base(); legacy.nodes[0]!.checks[0]!.run = 'if true; then';
    process.env.PATH = await withoutBash(r.root);
    await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify(legacy), measure: false });
    process.env.PATH = path;
    const file = join(r.root, 'legacy.json'); await writeFile(file, JSON.stringify(legacy));
    await ops.planSet({ cwd: r.cwd, as: owner, channel: 'delegated', ...await ops.readPlan({ cwd: r.cwd, path: file }) });
    const edit = await cli(r.cwd, ['edit', 'a', '--set', 'title=Legacy unchanged', '--note', 'unrelated title']);
    assert.equal(edit.code, 0, edit.stderr); assert.equal((await ops.verify({ cwd: r.cwd })).ok, true);
    const changed = await cli(r.cwd, ['edit', 'a', '--set', 'checks.unit.run="if false; then"', '--note', 'changed legacy run', '--as', 'owner:pi']);
    assert.notEqual(changed.code, 0); assert.match(changed.stderr, /a\/unit: bash -n:/);
  } finally { process.env.PATH = path; await r.cleanup(); }
});
