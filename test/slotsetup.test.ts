import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chmod, readFile, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setImmediate as immediate } from 'node:timers/promises';
import { repo } from './helpers/repo.ts';
import { cli, commitAt, identity } from './helpers/surface.ts';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { parsePlan, planDowngrades } from '../src/plan.ts';
import { candidateFacts, git, stateFacts } from '../src/git.ts';

const owner = { role: 'owner', id: 'test' } as const;
const parent = { role: 'parent', id: 'test' } as const;
const base = { version: 1, trunk: 'main', lease: false, closure: [], nodes: [{ id: 'a', writes: ['impl'], checks: [{ id: 'unit', run: 'true', reads: ['impl'] }] }] };
async function fixture(extra: Record<string, unknown> = {}) {
  const r = await repo();
  await r.put('impl', 'base'); await r.commit();
  const plan = { ...base, ...extra };
  await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify(plan), measure: false });
  return { ...r, plan, dispatch: () => ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' }) };
}
async function rollbackUnchanged(r: Awaited<ReturnType<typeof fixture>>, before: string) {
  assert.equal(await readFile(join(r.root, 'ledger', 'ledger.jsonl'), 'utf8'), before, 'no entry is recorded');
  assert.equal((await git(r.cwd, ['show-ref', '--verify', '--quiet', 'refs/heads/owed/a/1'], { allowFail: true })).code, 1, 'no slot branch');
  assert.equal((await git(r.cwd, ['worktree', 'list', '--porcelain'])).stdout.split('\n').filter(l => l.startsWith('worktree ')).length, 1, 'no registered slot');
  assert.ok(!existsSync(join(r.root, 'created')), 'all newly created parent directories are removed');
}

test('SS parser accepts string/false, preserves absence and rejects other values', () => {
  assert.ok(!('slot_setup' in parsePlan(JSON.stringify(base))));
  assert.equal(parsePlan(JSON.stringify({ ...base, slot_setup: 'true' })).slot_setup, 'true');
  assert.equal(parsePlan(JSON.stringify({ ...base, slot_setup: false })).slot_setup, false);
  for (const value of [true, null, 7, {}, [], '', '   ']) {
    assert.throws(() => parsePlan(JSON.stringify({ ...base, slot_setup: value })), /slot_setup: expected non-empty string/);
  }
});

test('SS fallback setup runs in the slot with shared env/wrapper handling; packet stores the success line', async () => {
  const r = await fixture();
  try {
    const wrap = join(r.root, 'wrap.sh');
    await writeFile(wrap, '#!/bin/bash\nprintf "%s\\n" "$@" > wrapper-argv\nexec "$@"\n'); await chmod(wrap, 0o755);
    const command = 'printf "%s|%s|%s|%s|%s" "$PWD" "$OWED_TREE" "$CI" "$OWED" "$SS_VALUE" > marker; ln -s impl prerequisite';
    await ops.planSet({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'fixture setup and environment', plan: JSON.stringify({ ...r.plan, setup: command, exec: { env: { SS_VALUE: 'from plan' }, wrap: [wrap] } }) });
    const out = await cli(r.cwd, ['dispatch', 'a', '--json']); assert.equal(out.code, 0, out.stderr);
    const d = JSON.parse(out.stdout) as ops.DispatchPacket;
    assert.equal(await readFile(join(d.worktree, 'marker'), 'utf8'), `${d.worktree}|${d.worktree}|1|1|from plan`);
    assert.equal(await readFile(join(d.worktree, 'prerequisite'), 'utf8'), 'base');
    assert.equal(await readFile(join(d.worktree, 'wrapper-argv'), 'utf8'), `bash\n-lc\n${command}\n`);
    assert.ok(!existsSync(join(r.cwd, 'marker')));
    const line = `Setup: ran \`${command}\` in this worktree (exit 0; excluded: /marker, /prerequisite, /wrapper-argv)`;
    assert.equal(d.packet.split('\n').filter(l => l === line).length, 1);
    assert.equal(d.subagent.task, d.packet);
    assert.equal(d.entry.kind, 'dispatch');
    if (d.entry.kind !== 'dispatch') throw new Error('expected dispatch');
    assert.equal((await (await Ledger.open(r.cwd)).getBlob(d.entry.packet)).toString(), d.packet);
    assert.deepEqual(Object.keys(d.entry).sort(), ['attempt', 'base', 'branch', 'by', 'hash', 'kind', 'node', 'packet', 'prev', 'rulings_seen', 'seq', 'ts', 'worktree'].sort(), 'no new ledger field');
  } finally { await r.cleanup(); }
});

test('SS multi-line setup executes unchanged and its packet command is escaped onto exactly one line', async () => {
  const command = "printf 'first\\n' > marker\nprintf second >> marker";
  const r = await fixture({ slot_setup: command });
  try {
    const d = await r.dispatch();
    assert.equal(await readFile(join(d.worktree, 'marker'), 'utf8'), 'first\nsecond');
    assert.deepEqual(d.packet.split('\n').filter(l => l.startsWith('Setup:')), ["Setup: ran `printf 'first\\\\n' > marker\\nprintf second >> marker` in this worktree (exit 0; excluded: /marker)"]);
    assert.equal(d.packet.split('\n').at(-1), d.packet.split('\n').find(l => l.startsWith('Setup:')));
  } finally { await r.cleanup(); }
});

test('SS slot_setup overrides measurement setup', async () => {
  const command = 'printf slot > marker';
  const r = await fixture({ setup: 'exit 91', slot_setup: command });
  try {
    const d = await r.dispatch();
    assert.equal(await readFile(join(d.worktree, 'marker'), 'utf8'), 'slot');
    assert.ok(d.packet.includes(`Setup: ran \`${command}\` in this worktree (exit 0; excluded: /marker)`));
    assert.ok(!d.packet.includes('exit 91'));
  } finally { await r.cleanup(); }
});

test('SS slot_setup false skips a failing setup; absent setup also adds no packet line', async () => {
  for (const extra of [{ setup: 'exit 92', slot_setup: false }, {}]) {
    const r = await fixture(extra);
    try { const d = await r.dispatch(); assert.doesNotMatch(d.packet, /^Setup:/m); }
    finally { await r.cleanup(); }
  }
});

test('SS5 setup symlinks, files and directories are excluded once and never enter git add -A candidates', async () => {
  const command = "ln -s impl node_modules; printf ready > artifact; mkdir -p cache; printf cached > cache/value; mkdir -p viewer; ln -s ../impl viewer/node_modules; printf ignored > already-ignored";
  const r = await fixture({ setup: command });
  try {
    // A directory-only ignore does not hide a node_modules symlink (the app reproduction).
    await commitAt(r.cwd, { '.gitignore': 'node_modules/\nalready-ignored\n', 'viewer/keep': 'tracked' });
    await ops.adopt({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'fixture ignores actual directories only' });
    const exclude = join(r.cwd, '.git', 'info', 'exclude');
    const before = await readFile(exclude, 'utf8');
    const d = await r.dispatch();
    const paths = ['/artifact', '/cache/', '/node_modules', '/viewer/node_modules'];
    const after = await readFile(exclude, 'utf8');
    assert.ok(after.startsWith(before), 'existing common excludes preserved');
    for (const path of paths) assert.equal(after.split('\n').filter(line => line === path).length, 1);
    assert.ok(!after.split('\n').includes('/already-ignored'), 'already ignored outputs need no new rule');
    assert.equal((await git(d.worktree, ['status', '--porcelain', '-z'])).stdout, '');
    assert.ok(d.packet.endsWith(`(exit 0; excluded: ${paths.join(', ')})`));
    await writeFile(join(d.worktree, 'impl'), 'candidate');
    await git(d.worktree, ['add', '-A']);
    await git(d.worktree, ['commit', '-m', 'candidate'], { env: identity });
    const changed = (await git(d.worktree, ['diff', '--name-only', d.entry.kind === 'dispatch' ? d.entry.base : '', 'HEAD'])).stdout.trim().split('\n');
    assert.deepEqual(changed, ['impl']);
    assert.deepEqual((await git(d.worktree, ['ls-files'])).stdout.trim().split('\n'), ['.gitignore', 'impl', 'viewer/keep']);
    await ops.submit({ cwd: d.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
    await ops.abandon({ cwd: r.cwd, node: 'a', as: parent, reason: 'fixture redispatch' });
    const next = await r.dispatch();
    const repeated = await readFile(exclude, 'utf8');
    for (const path of paths) assert.equal(repeated.split('\n').filter(line => line === path).length, 1, 'redispatch does not duplicate patterns');
    assert.ok(next.packet.endsWith('(exit 0)'), 'already ignored outputs are absent from the status delta');
    assert.equal((await git(next.worktree, ['status', '--porcelain', '-z'])).stdout, '');
  } finally { await r.cleanup(); }
});

test('SS5 an outside slot creates a missing common exclude file for its setup output', async () => {
  const r = await fixture({ worktrees: { root: '../created/nested' }, slot_setup: 'touch marker' });
  try {
    const exclude = join(r.cwd, '.git', 'info', 'exclude');
    await unlink(exclude);
    const d = await r.dispatch();
    assert.equal(await readFile(exclude, 'utf8'), '\n/marker\n');
    assert.equal((await git(d.worktree, ['status', '--porcelain', '-z'])).stdout, '');
    assert.ok(d.packet.endsWith('(exit 0; excluded: /marker)'));
  } finally { await r.cleanup(); }
});

test('SS6 tracked !/artifact negation refuses dispatch and restores common excludes byte-for-byte', async () => {
  for (const preexisting of [false, true]) for (const command of ['touch artifact', 'touch artifact other-output']) {
    const r = await fixture({ worktrees: { root: '../created/nested' }, slot_setup: command });
    try {
      await commitAt(r.cwd, { '.gitignore': '!/artifact\n' });
      await ops.adopt({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'fixture tracked negation' });
      const exclude = join(r.cwd, '.git', 'info', 'exclude');
      // No final newline, plus a pre-existing rule when requested: rollback must preserve both exactly.
      await writeFile(exclude, preexisting ? '# preserve\n/artifact\n/preexisting' : '# preserve without final newline');
      const before = await readFile(join(r.root, 'ledger', 'ledger.jsonl'), 'utf8');
      const bytes = await readFile(exclude), ignore = await readFile(join(r.cwd, '.gitignore'));
      await assert.rejects(r.dispatch(), (e: Error) => {
        assert.match(e.message, /slot setup outputs still visible: artifact;/);
        assert.match(e.message, /tracked ignore rule.*! negation.*overrides info\/exclude/);
        assert.match(e.message, /ignore setup outputs in the repository or change slot_setup/);
        assert.doesNotMatch(e.message, /rollback failed/); return true;
      });
      await rollbackUnchanged(r, before);
      assert.deepEqual(await readFile(exclude), bytes, 'remove only this dispatch additions, retaining pre-existing rules');
      assert.deepEqual(await readFile(join(r.cwd, '.gitignore')), ignore, 'never edit tracked ignore rules');
    } finally { await r.cleanup(); }
  }
});

test('SS6 verifies visible descendants of collapsed directories and restores an absent exclude file', async () => {
  const r = await fixture({ worktrees: { root: '../created/nested' }, slot_setup: 'mkdir cache; touch cache/value artifact' });
  try {
    await commitAt(r.cwd, { '.gitignore': '!/cache/\n!/cache/value\n' });
    await ops.adopt({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'fixture directory negation' });
    const exclude = join(r.cwd, '.git', 'info', 'exclude');
    await unlink(exclude);
    const before = await readFile(join(r.root, 'ledger', 'ledger.jsonl'), 'utf8');
    await assert.rejects(r.dispatch(), /slot setup outputs still visible: cache\/value;/);
    await rollbackUnchanged(r, before);
    assert.ok(!existsSync(exclude), 'no exclude file existed before this dispatch');
  } finally { await r.cleanup(); }
});

test('SS6 a ledger append failure removes setup excludes and retains a later unrelated append', async t => {
  const r = await fixture({ worktrees: { root: '../created/nested' }, slot_setup: 'touch artifact' });
  try {
    const exclude = join(r.cwd, '.git', 'info', 'exclude');
    const before = await readFile(join(r.root, 'ledger', 'ledger.jsonl'), 'utf8'), bytes = await readFile(exclude);
    const append = Ledger.prototype.append;
    t.mock.method(Ledger.prototype, 'append', async function(this: Ledger, ...args: Parameters<Ledger['append']>) {
      if (args[0].some(d => d.kind === 'dispatch')) {
        const current = await readFile(exclude);
        assert.ok(current.toString().includes('/artifact\n'), 'excludes have been applied');
        await writeFile(exclude, Buffer.concat([current, Buffer.from('/unrelated\n')]));
        throw new Error('fixture ledger append failure');
      }
      return append.apply(this, args);
    });
    await assert.rejects(r.dispatch(), /fixture ledger append failure/);
    await rollbackUnchanged(r, before);
    assert.deepEqual(await readFile(exclude), Buffer.concat([bytes, Buffer.from('/unrelated\n')]));
  } finally { t.mock.restoreAll(); await r.cleanup(); }
});

test('SS5 successful setup changing tracked modified/deleted/renamed paths refuses and rolls back', async () => {
  for (const command of ['printf changed > impl', 'rm impl', 'git mv impl renamed']) {
    const r = await fixture({ worktrees: { root: '../created/nested' }, slot_setup: command });
    try {
      const before = await readFile(join(r.root, 'ledger', 'ledger.jsonl'), 'utf8');
      const exclude = await readFile(join(r.cwd, '.git', 'info', 'exclude'), 'utf8');
      await assert.rejects(r.dispatch(), (e: Error) => {
        assert.match(e.message, /slot setup changed tracked paths: .*impl/);
        if (command.startsWith('git mv')) assert.match(e.message, /renamed/);
        assert.doesNotMatch(e.message, /rollback failed/); return true;
      });
      await rollbackUnchanged(r, before);
      assert.equal(await readFile(join(r.cwd, 'impl'), 'utf8'), 'base');
      assert.equal(await readFile(join(r.cwd, '.git', 'info', 'exclude'), 'utf8'), exclude);
    } finally { await r.cleanup(); }
  }
});

test('SS5 setup glob characters are literal anchored excludes, not patterns hiding unrelated files', async () => {
  const r = await fixture({ slot_setup: "touch 'artifact*'; touch 'other?' 'bracket[' '#leading' '!leading' 'back\\slash' 'trailing '" });
  try {
    const d = await r.dispatch();
    const text = await readFile(join(r.cwd, '.git', 'info', 'exclude'), 'utf8');
    for (const path of ['/artifact\\*', '/other\\?', '/bracket\\[', '/\\#leading', '/\\!leading', '/back\\\\slash', '/trailing\\ ']) assert.ok(text.split('\n').includes(path), path);
    assert.equal((await git(d.worktree, ['status', '--porcelain', '-z'])).stdout, '');
    await writeFile(join(d.worktree, 'artifact-other'), 'writer file');
    await writeFile(join(d.worktree, 'otherX'), 'writer file');
    await git(d.worktree, ['add', '-A']);
    assert.deepEqual((await git(d.worktree, ['diff', '--cached', '--name-only'])).stdout.trim().split('\n'), ['artifact-other', 'otherX']);
  } finally { await r.cleanup(); }
});

test('SS5 setup outputs containing newline or carriage return refuse rather than remain committable', async () => {
  for (const escape of ['\\n', '\\r']) {
    const r = await fixture({ worktrees: { root: '../created/nested' }, slot_setup: `printf ready > "$(printf 'bad${escape}path')"` });
    try {
      const before = await readFile(join(r.root, 'ledger', 'ledger.jsonl'), 'utf8');
      await assert.rejects(r.dispatch(), (e: Error) => {
        assert.equal(e.message, `slot setup output cannot be excluded: bad${escape}path`);
        return true;
      });
      await rollbackUnchanged(r, before);
    } finally { await r.cleanup(); }
  }
});

test('SS setup failure reports exit and last 20 combined output lines and rolls back dirty prerequisites', async () => {
  const r = await fixture({ worktrees: { root: '../created/nested' }, setup: 'touch prerequisite; printf dirty > impl; for i in {1..25}; do echo "out-$i"; done; echo stderr-last >&2; exit 23' });
  try {
    const before = await readFile(join(r.root, 'ledger', 'ledger.jsonl'), 'utf8');
    await assert.rejects(r.dispatch(), (e: Error) => {
      assert.match(e.message, /slot setup failed: exit 23/);
      const lines = e.message.split('\n').slice(1).map(l => l.trim());
      assert.equal(lines.length, 20); assert.equal(lines[0], 'out-7'); assert.equal(lines.at(-1), 'stderr-last');
      assert.doesNotMatch(e.message, /rollback failed/); return true;
    });
    await rollbackUnchanged(r, before);
    assert.equal(await readFile(join(r.cwd, 'impl'), 'utf8'), 'base');
  } finally { await r.cleanup(); }
});

test('SS timeout at 600 seconds kills setup and rolls back without a dispatch entry', async t => {
  const r = await fixture({ worktrees: { root: '../created/nested' }, slot_setup: 'echo ready > ready; sleep 30' });
  try {
    const before = await readFile(join(r.root, 'ledger', 'ledger.jsonl'), 'utf8');
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const pending = r.dispatch(); pending.catch(() => {});
    const deadline = Date.now() + 10_000;
    while (!existsSync(join(r.root, 'created', 'nested', 'a-1', 'ready')) && Date.now() < deadline) await immediate();
    assert.ok(existsSync(join(r.root, 'created', 'nested', 'a-1', 'ready')), 'setup has started');
    t.mock.timers.tick(600_000);
    await assert.rejects(pending, /slot setup failed: timeout after 600s/);
    t.mock.timers.reset();
    await rollbackUnchanged(r, before);
  } finally { t.mock.timers.reset(); await r.cleanup(); }
});

test('SS changing slot_setup preserves all keys and the submitted candidate, and rebase does not rerun it', async () => {
  const r = await fixture();
  try {
    const d = await r.dispatch();
    const c = await commitAt(d.worktree, { impl: 'candidate' });
    await ops.submit({ cwd: d.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
    const before = (await ops.readState({ cwd: r.cwd })).state.nodes.a!.candidate!;
    const keyBase = { ...r.plan, setup: 'true', closure: ['mutants/**'], invariants: [{ id: 'inv', run: 'true' }], nodes: [{ ...base.nodes[0]!, checks: [{ id: 'unit', run: 'true', red: true, tests: ['impl'], mutants: ['mutants/**'] }] }] };
    const p = parsePlan(JSON.stringify(keyBase));
    const keys = await candidateFacts(r.cwd, p, p.nodes[0]!, before.base, c, 1), inv = await stateFacts(r.cwd, p, c);
    for (const slot_setup of ['exit 93', false] as const) {
      const next = parsePlan(JSON.stringify({ ...keyBase, slot_setup }));
      assert.deepEqual(planDowngrades(p, next), []);
      assert.deepEqual((await candidateFacts(r.cwd, next, next.nodes[0]!, before.base, c, 1)).keys, keys.keys);
      assert.deepEqual(await stateFacts(r.cwd, next, c), inv);
      await ops.planSet({ cwd: r.cwd, as: parent, plan: JSON.stringify({ ...r.plan, slot_setup }) });
      assert.deepEqual((await ops.readState({ cwd: r.cwd })).state.nodes.a!.candidate, before);
    }
    await ops.planSet({ cwd: r.cwd, as: parent, plan: JSON.stringify({ ...r.plan, slot_setup: 'exit 94' }) });
    await commitAt(r.cwd, { other: 'move trunk' });
    await ops.adopt({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'fixture moves trunk' });
    const rebase = await ops.rebase({ cwd: r.cwd, as: parent, node: 'a' });
    assert.equal(rebase.worktree, d.worktree, 'reuses the slot without running exit 94');
  } finally { await r.cleanup(); }
});

test('SS a plan changed during setup refuses its stale result and rolls back the slot', async () => {
  const r = await fixture({ worktrees: { root: '../created/nested' }, slot_setup: 'touch ready; for i in {1..500}; do test -f release && exit 0; sleep 0.02; done; exit 99' });
  try {
    const pending = r.dispatch(); pending.catch(() => {});
    const wt = join(r.root, 'created', 'nested', 'a-1'), deadline = Date.now() + 10_000;
    while (!existsSync(join(wt, 'ready')) && Date.now() < deadline) await immediate();
    assert.ok(existsSync(join(wt, 'ready')));
    await ops.planSet({ cwd: r.cwd, as: parent, plan: JSON.stringify({ ...r.plan, slot_setup: false }) });
    const before = await readFile(join(r.root, 'ledger', 'ledger.jsonl'), 'utf8');
    const exclude = await readFile(join(r.cwd, '.git', 'info', 'exclude'), 'utf8');
    await writeFile(join(wt, 'release'), '');
    await assert.rejects(pending, /Plan, candidate or trunk changed; retry/);
    await rollbackUnchanged(r, before);
    assert.equal(await readFile(join(r.cwd, '.git', 'info', 'exclude'), 'utf8'), exclude, 'a stale setup result appends no excludes');
  } finally { await r.cleanup(); }
});
