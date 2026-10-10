// E3 (0.5.1, node halt-quiet): one wake per new fact; D25.6 wording in the driver's output; the CLI's default owner
// principal is owner:cli. Exports added by this node are read through the module namespace, so the base fails by
// assertion or "is not a function", not at import time.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import * as run from '../src/drive-run.ts';
import { Follower } from '../src/drive-bg.ts';
import { procStart } from '../src/drive-run.ts';
import { reduce } from '../src/reducer.ts';
import { briefView, ownerCommands, receipt, renderBrief, renderReceipt } from '../src/views.ts';
import { Ledger } from '../src/ledger.ts';
import { Dsa } from '../src/dsa.ts';
import { git } from '../src/git.ts';
import * as ops from '../src/ops.ts';
import type { CandidateFacts, Draft, Entry, Plan, State } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { commitAt, identity } from './helpers/surface.ts';

const NEW = run as unknown as {
  factMark(s: State, node: string): number;
};
const OWNER = 'needs the owner (the main agent decides; owed lists the command)';

// ---------- synthetic ledger (no git) ----------
const check = (id: string) => ({ id, run: `test ${id}`, timeout_s: 10, reads: ['**'] });
const plan = (): Plan => ({ version: 1, trunk: 'main', closure: [], invariants: [], nodes: [
  { id: 'a', deps: [], writes: ['a/'], checks: [check('ca')], review: { count: 1, min_rank: 1 } },
  { id: 'b', deps: [], writes: ['b/'], checks: [], review: { count: 0, min_rank: 1 } },
] });
function rig() {
  const entries: Entry[] = [];
  const state = (): State => reduce(entries, plan);
  const add = (d: Draft | Record<string, unknown>): number => { const seq = entries.length; entries.push({ ...d, seq, ts: new Date(seq * 1000).toISOString(), prev: 'x', hash: `hash${seq}` } as Entry); state(); return seq; };
  add({ kind: 'genesis', by: 'owner:human', channel: 'tty', plan: 'p', trunk: 'main', commit: 's0', state: { commit: 's0', tree: 't0', invKeys: {} } });
  const dispatch = (node: string, by = 'parent:drive') => add({ kind: 'dispatch', by, node, attempt: 1, base: 's0', branch: `owed/${node}/1`, worktree: `/wt/${node}`, packet: 'blob', rulings_seen: -1 });
  const facts = (tag: string): CandidateFacts => ({ commit: `c${tag}`, tree: `t${tag}`, base: 's0', patch: `p${tag}`, changed: ['a/x'], closureTouched: false, keys: { 'check:ca': `k${tag}`, writes: `w${tag}`, rulings: `r${tag}`, review: `rv${tag}` } });
  const submit = (tag: string) => add({ kind: 'submit', by: 'writer:a#1', node: 'a', attempt: 1, facts: facts(tag) });
  const obs = (tag: string) => add({ kind: 'obs', by: 'executor:owed', subject: 'a', obligation: 'check:ca', key: `k${tag}`, verdict: 'pass', exit: 0, durationMs: 1, commit: `c${tag}`, base: 's0' });
  const halt = (reason: string) => add({ kind: 'halt', by: 'parent:drive', node: 'a', attempt: 1, reason, needs: 'human' });
  const rule = (nodes: string[] | '*') => add({ kind: 'rule', by: 'parent:main', text: 'decided', nodes });
  return { entries, state, add, dispatch, submit, obs, halt, rule };
}

// ---------- E3.1 ----------
test('E3.1 Follower: a node wake with the same text and fact mark does not wake again; it rides along as a repeat', () => {
  const dir = mkdtempSync(join(tmpdir(), 'owed-quiet-')), log = join(dir, 'log.jsonl');
  const line = (o: object) => appendFileSync(log, `${JSON.stringify(o)}\n`);
  const halt = (facts: number, detail = 'attest recorded no verdict twice') => ({ do: 'halt', node: 'h', outcome: 'halted', attempt: 1, needs: 'human', detail, facts });
  try {
    writeFileSync(log, '');
    const got: string[] = [];
    const f = new Follower({ log, repo: '/r', pid: process.pid, start: procStart(process.pid), deliver: c => got.push(c) });
    line(halt(5));
    assert.match(f.tick() ?? '', /\nhalt h attempt 1 \(needs human\): halted — attest recorded no verdict twice\n/);
    line(halt(5));
    assert.equal(f.tick(), undefined, 'the same halt text with no new ledger entries for h does not wake');
    line({ ...halt(5), repeat: 1 });   // the loop driver's own repeat mark changes nothing
    assert.equal(f.tick(), undefined);
    line({ do: 'notify', node: 'x', outcome: 'notify', text: 'x asks', facts: 1 });
    const m = f.tick() ?? '';
    assert.deepEqual(m.split('\n'), ['owed drive (/r):', 'halt h attempt 1 (needs human): halted — attest recorded no verdict twice (repeat 2, no new ledger entries)', 'x asks', 'Next: owed status / owed why <node>'], 'only the latest repeat of h rides along with the next wake');
    line(halt(7));
    assert.doesNotMatch(f.tick() ?? 'no wake', /repeat/, 'a higher fact mark (new ledger entries for h) wakes as a new fact');
    line(halt(7, 'repairs exhausted'));
    assert.match(f.tick() ?? '', /halted — repairs exhausted\n/, 'a changed text wakes');
    line(halt(7));
    assert.match(f.tick() ?? '', /halted — attest recorded no verdict twice\n/, 'the text differs from the last one delivered for h: wakes');
    // Lines without a fact mark (an older driver) wake every time, as before.
    const old = { do: 'halt', node: 'o', outcome: 'halted', attempt: 1, needs: 'human', detail: 'old' };
    line(old); assert.ok(f.tick());
    line(old); assert.ok(f.tick(), 'no fact mark: wakes again');
    assert.equal(got.length, 7);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('E3.1 factMark: the highest seq of entries naming the node not written by parent:drive', () => {
  const r = rig();
  r.dispatch('a');
  assert.equal(NEW.factMark(r.state(), 'a'), 0, 'the driver\'s dispatch is not a new fact');
  const sub = r.submit('1');
  assert.equal(NEW.factMark(r.state(), 'a'), sub);
  const o = r.obs('1');
  assert.equal(NEW.factMark(r.state(), 'a'), o, 'an executor observation counts');
  r.halt('stuck');
  assert.equal(NEW.factMark(r.state(), 'a'), o, 'the driver\'s halt does not count');
  r.rule('*');
  assert.equal(NEW.factMark(r.state(), 'a'), o, 'a ruling for every node does not name it');
  r.dispatch('b', 'parent:main');
  assert.equal(NEW.factMark(r.state(), 'a'), o, 'entries of other nodes do not count');
  const ruled = r.rule(['a']);
  assert.equal(NEW.factMark(r.state(), 'a'), ruled, 'a ruling naming the node counts');
});

test('E3.1 loop driver: wake lines carry the fact mark; a repeat is marked; a notify is printed again only on new facts', () => {
  const r = rig();
  r.dispatch('a'); const sub = r.submit('1');
  const lines: string[] = [];
  const d = new run.Driver({ cwd: '/nonexistent', json: true, log: l => lines.push(l) });
  const parse = (): Record<string, unknown> => JSON.parse(lines.at(-1)!) as Record<string, unknown>;
  const haltReport = (): run.ActionReport => ({ do: 'halt', node: 'a', outcome: 'halted', attempt: 1, needs: 'human', detail: 'stuck' });
  d.emit(haltReport(), r.state());
  assert.equal(parse().facts, sub);
  assert.equal(parse().repeat, undefined);
  d.emit(haltReport(), r.state());
  assert.equal(parse().repeat, 1);
  assert.equal(run.reportText(parse()), 'halt a attempt 1 (needs human): halted — stuck (repeat 1, no new ledger entries)');
  const o = r.obs('1');
  d.emit(haltReport(), r.state());
  assert.equal(parse().facts, o);
  assert.equal(parse().repeat, undefined, 'new ledger entries for the node: not a repeat');
  // Quiet reports carry no fact mark.
  d.emit({ do: 'dispatch', node: 'a', outcome: 'done' }, r.state());
  assert.equal(parse().facts, undefined);
  // Notify: printed once per text and fact mark.
  const n0 = lines.length, ask = (): run.ActionReport => ({ do: 'notify', node: 'a', outcome: 'notify', text: 'a asks' });
  d.emit(ask(), r.state()); d.emit(ask(), r.state());
  assert.equal(lines.length, n0 + 1, 'the same notify is printed once');
  r.rule(['a']);
  d.emit(ask(), r.state());
  assert.equal(lines.length, n0 + 2, 'a notify is printed again when the node gained ledger entries');
  // --once: no repeat marks (every pass is a new process).
  const once: string[] = [], d1 = new run.Driver({ cwd: '/nonexistent', json: true, once: true, log: l => once.push(l) });
  d1.emit(haltReport(), r.state()); d1.emit(haltReport(), r.state());
  assert.equal((JSON.parse(once[1]!) as Record<string, unknown>).repeat, undefined);
});

// ---------- E3.2 ----------
test('E3.2 D25.6 wording: owner halts, CAS merge halts and brief commands; no --as owner:human', () => {
  assert.equal(run.reportText({ do: 'halt', node: 'a', outcome: 'halted', attempt: 2, needs: 'owner', detail: 'stalled: x' }), `halt a attempt 2, ${OWNER}: halted — stalled: x`);
  assert.equal(run.reportText({ do: 'halt', node: 'a', outcome: 'halted', attempt: 2, needs: 'human', detail: 'x' }), 'halt a attempt 2 (needs human): halted — x');
  // Brief and owner commands: the owner review command states owner:cli; nothing suggests owner:human.
  const r = rig();
  r.dispatch('a', 'parent:main'); r.submit('1'); r.obs('1');
  r.add({ kind: 'obs', by: 'executor:owed', subject: 'a', obligation: 'writes', key: 'w1', verdict: 'pass', exit: 0, durationMs: 1, commit: 'c1', base: 's0' });
  r.add({ kind: 'review', by: 'reviewer:r2', node: 'a', attempt: 1, obligation: 'review', key: 'rv1', verdict: 'block', rank: 2, note: 'no' });
  const s = r.state(), brief = briefView(s, r.entries, -1, 0);
  assert.equal(brief.decisions.find(x => x.node === 'a')!.command, 'owed review a --ok --rank 3 --as owner:cli --candidate c1');
  const text = `${renderBrief(brief)}\n${ownerCommands(s, 'a').join('\n')}`;
  assert.doesNotMatch(text, /owner:human/, text);
  assert.deepEqual([...new Set([...text.matchAll(/--as (\S+)/g)].map(x => x[1]))], ['owner:cli'], text);
  // Under the confirmation gate the role a command states is owner:human (ruling #559 nit).
  const prior = process.env.OWED_CONFIRM; process.env.OWED_CONFIRM = 'owner';
  try { assert.equal(briefView(s, r.entries, -1, 0).decisions.find(x => x.node === 'a')!.command, 'owed review a --ok --rank 3 --as owner:human --candidate c1'); }
  finally { if (prior === undefined) delete process.env.OWED_CONFIRM; else process.env.OWED_CONFIRM = prior; }
  // Halt rows of the views use the D25.6 wording (ruling #559 nit).
  r.add({ kind: 'halt', by: 'parent:drive', node: 'a', attempt: 1, reason: 'stalled: x', needs: 'owner' });
  const why = renderReceipt(receipt(r.state(), r.entries, 'a'));
  assert.match(why, new RegExp(`⏸ halted by driver #${r.entries.length - 1} \\(attempt 1\\), ${OWNER.replace(/[()]/g, '\\$&')}: stalled: x`), why);
});

// ---------- E3.3 ----------
async function cli(cwd: string, args: string[], env: Record<string, string | undefined>): Promise<{ code: number; stdout: string; stderr: string }> {
  const full: NodeJS.ProcessEnv = { ...process.env, ...identity };
  for (const [k, v] of Object.entries({ DSA_CALL: undefined, DSA_EXEC: undefined, OWED_CONFIRM: undefined, ...env })) if (v === undefined) delete full[k]; else full[k] = v;
  try { const out = await promisify(execFile)(process.execPath, [fileURLToPath(new URL('../bin/owed.js', import.meta.url)), ...args], { cwd, env: full, timeout: 30_000 }); return { code: 0, ...out }; }
  catch (e) { const x = e as { code: number; stdout: string; stderr: string }; if (typeof x.code !== 'number') throw e; return x; }
}

test('E3.3 CLI: the default owner principal is owner:cli (delegated, also with --i-am-owner); owner:human only under OWED_CONFIRM=owner', { timeout: 60_000 }, async () => {
  const r = await repo();
  try {
    await commitAt(r.cwd, { README: 'x\n' });
    await ops.init({ cwd: r.cwd, plan: JSON.stringify(plan()), as: { role: 'owner', id: 'pi' }, channel: 'delegated' });
    const last = async (): Promise<Entry> => (await (await Ledger.open(r.cwd)).read()).at(-1)!;
    const plain = await cli(r.cwd, ['decoy', 'commit', 'a'.repeat(64)], {});
    assert.equal(plain.code, 0, plain.stderr);
    let e = await last();
    assert.ok(e.kind === 'decoy-commit' && e.by === 'owner:cli' && e.channel === 'delegated', JSON.stringify(e));
    const flag = await cli(r.cwd, ['decoy', 'commit', 'b'.repeat(64), '--i-am-owner'], {});
    assert.equal(flag.code, 0, flag.stderr);
    e = await last();
    assert.ok(e.kind === 'decoy-commit' && e.by === 'owner:cli' && e.channel === 'flag', JSON.stringify(e));
    const gated = await cli(r.cwd, ['decoy', 'commit', 'c'.repeat(64), '--i-am-owner'], { OWED_CONFIRM: 'owner' });
    assert.equal(gated.code, 0, gated.stderr);
    e = await last();
    assert.ok(e.kind === 'decoy-commit' && e.by === 'owner:human' && e.channel === 'flag', JSON.stringify(e));
    const help = await cli(r.cwd, ['--help'], {});
    assert.match(help.stdout, /default to owner:cli, owner:human under OWED_CONFIRM=owner/);
  } finally { await r.cleanup(); }
});

// ---------- ruling #559 (c): trunk drift is a repo-level owner notify, never a halt ----------
const FAKE = fileURLToPath(new URL('./fixtures/fake-dsa.mjs', import.meta.url));
const OWED_BIN = fileURLToPath(new URL('../bin/owed.js', import.meta.url));
const tnode = { id: 't', writes: ['t.txt'], checks: [], review: { count: 0, min_rank: 1 } };
async function driveRig(invariants: object[] = []) {
  const r = await repo();
  const dir = join(r.root, 'dsa'), bin = join(r.root, 'bin');
  await mkdir(join(dir, 'agents'), { recursive: true }); await mkdir(bin);
  await writeFile(join(bin, 'owed'), `#!/bin/sh\nexec "${process.execPath}" "${OWED_BIN}" "$@"\n`); await chmod(join(bin, 'owed'), 0o755);
  const env = { FAKE_DSA_DIR: dir, PATH: `${bin}:${process.env.PATH}`, ...identity };
  const p = { version: 1, trunk: 'main', closure: [], invariants, nodes: [tnode] };
  await r.put('README', 'x\n'); await r.commit();
  await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'pi' }, channel: 'delegated', plan: JSON.stringify(p) });
  await writeFile(join(dir, 'agents', 't-writer.sh'), 'set -e\necho t > t.txt; git add t.txt; git commit -qm t; owed submit t\n');
  const dsa = new Dsa({ bin: FAKE, env, timeoutMs: 120_000 });
  const self = {
    ...r,
    entries: async (): Promise<Entry[]> => (await Ledger.open(r.cwd)).read(),
    async drive(o: { once?: boolean; json?: boolean; signal?: AbortSignal } = {}): Promise<string[]> {
      const lines: string[] = [];
      await run.drive({ cwd: r.cwd, once: o.once ?? true, json: o.json, dsa, log: l => lines.push(l), pollMs: 50, passMs: 100, handleSignals: false, signal: o.signal });
      return lines;
    },
    async accepted(): Promise<void> {
      for (let i = 0; i < 6 && !(await ops.status({ cwd: r.cwd })).nodes.t!.accepted; i++) await self.drive();
      assert.ok((await ops.status({ cwd: r.cwd })).nodes.t!.accepted);
    },
  };
  return self;
}
const kindsOf = (es: Entry[]) => es.map(e => e.kind);
const AHEAD = /^trunk main moved outside owed \([0-9a-f]{12} → [0-9a-f]{12}\); the main agent resolves it with: owed adopt --note "<why>"$/m;

test('#559 drift ahead: owner notify, no halt, no merge; printed once per change in the loop; after owed adopt the next pass merges', { timeout: 180_000 }, async () => {
  const f = await driveRig();
  try {
    await f.accepted();
    await f.put('other.txt', 'x\n'); await f.commit();
    const before = (await f.entries()).length;
    const out = await f.drive();
    assert.match(out.join('\n'), AHEAD, out.join('\n'));
    assert.doesNotMatch(out.join('\n'), /merge t|halt/, out.join('\n'));
    // The loop: many passes, one drift line (once per change).
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 1500);
    const loop = await f.drive({ once: false, signal: ac.signal }); clearTimeout(t);
    assert.equal(loop.filter(l => AHEAD.test(l)).length, 1, loop.join('\n'));
    // The follower wakes once for repeated once-pass lines of the same drift.
    const dir = mkdtempSync(join(tmpdir(), 'owed-drift-')), log = join(dir, 'log.jsonl');
    try {
      writeFileSync(log, '');
      const got: string[] = [];
      const fo = new Follower({ log, repo: '/r', pid: process.pid, start: procStart(process.pid), deliver: c => got.push(c) });
      for (let i = 0; i < 2; i++) {
        const js = (await f.drive({ json: true })).filter(l => /moved outside owed/.test(l));
        assert.equal(js.length, 1); assert.equal((JSON.parse(js[0]!) as { node: string }).node, 'trunk');
        appendFileSync(log, `${js[0]}\n`); fo.tick();
      }
      assert.equal(got.length, 1, got.join('\n---\n'));
    } finally { rmSync(dir, { recursive: true, force: true }); }
    assert.equal((await f.entries()).filter(e => e.kind === 'halt').length, 0);
    assert.ok(!(await f.entries()).some(e => e.kind === 'merge'));
    assert.deepEqual(kindsOf((await f.entries()).slice(before)), [], 'drift records nothing');
    await ops.adopt({ cwd: f.cwd, note: 'release commit', as: { role: 'owner', id: 'pi' }, channel: 'delegated' });
    const after = await f.drive();
    assert.match(after.join('\n'), /merge t: merged/, after.join('\n'));
    assert.ok((await f.entries()).some(e => e.kind === 'merge' && e.node === 't'));
    assert.ok(!(await f.entries()).some(e => e.kind === 'rule' || e.kind === 'halt'), 'no ruling and no halt were needed');
  } finally { await f.cleanup(); }
});

test('#559 rewritten trunk: the notify names the git update-ref that restores it; restored, the next pass merges', { timeout: 180_000 }, async () => {
  const f = await driveRig();
  try {
    await f.accepted();
    const ledger = (await ops.status({ cwd: f.cwd })).trunk.commit;
    await git(f.cwd, ['commit', '--amend', '--allow-empty', '-qm', 'rewritten'], { env: identity });
    const ref = (await git(f.cwd, ['rev-parse', 'HEAD'])).stdout.trim();
    const out = (await f.drive()).join('\n');
    const want = `trunk main was rewound or rewritten (${ledger.slice(0, 12)} → ${ref.slice(0, 12)}); restore it: git update-ref refs/heads/main ${ledger} ${ref}`;
    assert.ok(out.split('\n').includes(want), out);
    assert.equal((await f.entries()).filter(e => e.kind === 'halt').length, 0);
    await git(f.cwd, ['update-ref', 'refs/heads/main', ledger, ref]);
    assert.match((await f.drive()).join('\n'), /merge t: merged/);
  } finally { await f.cleanup(); }
});

test('#559 a CAS failure inside the merge (trunk moved while it measured) is the drift notify, no halt; adopt, then merged', { timeout: 180_000 }, async () => {
  const race = `if [ -n "$HQ_RACE_REPO" ] && mkdir "$HQ_RACE_DONE" 2>/dev/null; then git -C "$HQ_RACE_REPO" -c user.name=t -c user.email=t@localhost commit -q --allow-empty -m outside; fi; true`;
  const f = await driveRig([{ id: 'race', run: race, reads: ['t.txt'] }]);
  try {
    await f.accepted();
    Object.assign(process.env, { HQ_RACE_REPO: f.cwd, HQ_RACE_DONE: join(f.root, 'race-done') });
    const out = (await f.drive()).join('\n');
    assert.match(out, AHEAD, out);
    assert.doesNotMatch(out, /halt/, out);
    assert.equal((await f.entries()).filter(e => e.kind === 'halt').length, 0);
    assert.ok(!(await f.entries()).some(e => e.kind === 'merge'));
    await ops.adopt({ cwd: f.cwd, note: 'commit made during the merge', as: { role: 'owner', id: 'pi' }, channel: 'delegated' });
    assert.match((await f.drive()).join('\n'), /merge t: merged/);
  } finally {
    delete process.env.HQ_RACE_REPO; delete process.env.HQ_RACE_DONE;
    await f.cleanup();
  }
});
