import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { reduce, validateDraft } from '../src/reducer.ts';
import { canonical, sha256 } from '../src/canon.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt, planText, seed, checkTest } from './helpers/surface.ts';
import type { CandidateFacts, Draft, Entry, Plan, State, StateFacts } from '../src/types.ts';

// Only base-existing exports are imported statically; new behavior is asserted through
// observable state, validation messages and CLI processes so the base fails by assertion.
const node = (id: string) => ({ id, deps: [], writes: ['src/'], checks: [], review: { count: 0, min_rank: 1 } });
const plan = (): Plan => ({ version: 1, trunk: 'main', closure: [], invariants: [{ id: 'safe', run: 'safe', timeout_s: 10, reads: ['**'] }], nodes: [node('a'), node('b'), { ...node('c'), review: { count: 1, min_rank: 1 } }] });
const facts = (id: string, commit: string, base: string): CandidateFacts => ({ commit, base, tree: `t-${commit}`, patch: 'p', changed: ['src/x'], closureTouched: false, keys: { writes: `w-${id}-${commit}`, rulings: `r-${id}`, review: `rv-${id}` } });
const digestOf = (p: unknown): string => sha256(canonical(p));
type Decoys = { decoys?: { node: string; outcome: string; decidedBy?: number }[]; escapes?: { node: string; class: string; merge: number }[] };

function rig() {
  const entries: Entry[] = [];
  const lookup = (): Plan => plan();
  const state = (): State & Decoys => reduce(entries, lookup) as State & Decoys;
  const errors = (d: Draft | Record<string, unknown>): string[] => validateDraft(state(), d as Draft);
  const add = (d: Draft | Record<string, unknown>): number => {
    assert.deepEqual(errors(d), [], `unexpected refusal of ${JSON.stringify(d)}`);
    const seq = entries.length; entries.push({ ...d, seq, ts: 'fixed', prev: 'x', hash: `hash${seq}` } as Entry); return seq;
  };
  add({ kind: 'genesis', by: 'owner:human', channel: 'tty', plan: 'p', trunk: 'main', commit: 's0', state: { commit: 's0', tree: 't0', invKeys: { safe: 'inv0' } } });
  add({ kind: 'obs', by: 'executor:owed', subject: 'trunk', obligation: 'inv:safe', key: 'inv0', verdict: 'pass', exit: 0, durationMs: 1, commit: 's0', base: 's0' });
  const trunk = () => state().trunk.commit;
  const dispatch = (id: string) => add({ kind: 'dispatch', by: 'parent:main', node: id, attempt: 1, base: trunk(), branch: 'b', worktree: 'wt', packet: 'blob', rulings_seen: -1 });
  const submit = (id: string) => { const f = facts(id, `c-${id}`, state().nodes[id]!.slot!.base); add({ kind: 'submit', by: `writer:${id}#1`, node: id, attempt: 1, facts: f }); return f; };
  const writes = (id: string, verdict: 'pass' | 'fail') => { const f = state().nodes[id]!.candidate!; return add({ kind: 'obs', by: 'executor:owed', subject: id, obligation: 'writes', key: f.keys.writes!, verdict, exit: verdict === 'pass' ? 0 : 1, durationMs: 1, commit: f.commit, base: f.base }); };
  const merge = (id: string) => {
    const pre = trunk(), m = facts(id, `m-${id}`, pre), sf: StateFacts = { commit: m.commit, tree: m.tree, invKeys: { safe: 'inv0' } };
    return add({ kind: 'merge', by: 'executor:owed', node: id, attempt: 1, prior: pre, commit: m.commit, facts: m, state: sf });
  };
  return { entries, state, errors, add, dispatch, submit, writes, merge };
}

test('escape entries: must cite a merge of the node, by parent or owner, with a known class and a note', () => {
  const r = rig();
  const dispatchA = r.dispatch('a'); r.submit('a'); r.writes('a', 'pass');
  const mergeA = r.merge('a');
  const escape = (extra: Record<string, unknown> = {}) => ({ kind: 'escape', by: 'parent:main', node: 'a', merge: mergeA, class: 'weak', note: 'oracle only checked the type', ...extra });
  assert.match(r.errors(escape({ by: 'writer:a#1' })).join(), /insufficient permissions/);
  assert.match(r.errors(escape({ by: 'reviewer:x' })).join(), /insufficient permissions/);
  assert.match(r.errors(escape({ merge: dispatchA })).join(), /not a merge of node a/);
  assert.match(r.errors(escape({ merge: 999 })).join(), /not a merge of node a/);
  assert.match(r.errors(escape({ node: 'b' })).join(), /not a merge of node b/);
  assert.match(r.errors(escape({ class: 'bogus' })).join(), /class/);
  assert.match(r.errors(escape({ note: '  ' })).join(), /note/);
  const first = r.add(escape());
  r.add(escape({ by: 'owner:human', channel: 'tty', class: 'waiver', evidence: 'log abc' }));
  const s = r.state();
  assert.deepEqual(s.escapes?.map(e => [e.node, e.class, e.merge]), [['a', 'weak', mergeA], ['a', 'waiver', mergeA]]);
  assert.equal((s.escapes as { seq: number }[] | undefined)?.[0]?.seq, first);
});

test('decoys: commit-reveal is owner-only, binds the digest and the first dispatch; outcomes caught/escaped/pending', () => {
  const r = rig();
  const payload = { nonce: '7f3a9c2e1b5d4f60aa', decoys: [{ node: 'a', defect: 'off-by-one in a' }, { node: 'b', defect: 'b ignores errors' }, { node: 'c', defect: 'c leaks handles' }] };
  const digest = digestOf(payload);
  assert.match(r.errors({ kind: 'decoy-commit', by: 'parent:main', digest }).join(), /insufficient permissions/);
  assert.match(r.errors({ kind: 'decoy-commit', by: 'owner:human', channel: 'tty', digest: 'not-hex' }).join(), /digest/);
  const commit = r.add({ kind: 'decoy-commit', by: 'owner:human', channel: 'tty', digest });
  assert.match(r.errors({ kind: 'decoy-commit', by: 'owner:human', channel: 'tty', digest }).join(), /already committed/);
  // a is caught by a rejecting obs; b merges without any prior block (escaped); c is not dispatched yet.
  r.dispatch('a'); r.submit('a'); const caughtAt = r.writes('a', 'fail');
  r.dispatch('b'); r.submit('b'); r.writes('b', 'pass'); const escapedAt = r.merge('b');
  const reveal = (p: unknown, by = 'owner:human') => ({ kind: 'decoy-reveal', by, channel: 'tty', ...(p as object) });
  assert.match(r.errors(reveal({ ...payload, nonce: '7f3a9c2e1b5d4f60ab' })).join(), /does not hash to an unrevealed decoy-commit/);
  assert.match(r.errors(reveal({ ...payload, decoys: payload.decoys.slice(1) })).join(), /does not hash/);
  assert.match(r.errors(reveal(payload, 'parent:main')).join(), /insufficient permissions/);
  assert.match(r.errors(reveal({ nonce: 'short', decoys: payload.decoys })).join(), /nonce/);
  assert.match(r.errors(reveal({ ...payload, decoys: [] })).join(), /decoys/);
  const revealSeq = r.add(reveal(payload));
  let decoys = r.state().decoys ?? [];
  assert.deepEqual(decoys.map(d => [d.node, d.outcome, d.decidedBy]), [['a', 'caught', caughtAt], ['b', 'escaped', escapedAt], ['c', 'pending', undefined]]);
  assert.ok(decoys.every(d => (d as { commit?: number }).commit === commit && (d as { reveal?: number }).reveal === revealSeq));
  assert.match(r.errors(reveal(payload)).join(), /unrevealed/, 'a commitment cannot be revealed twice');
  // A revealed pending decoy keeps being judged: a review block before merge catches it.
  r.dispatch('c'); r.submit('c');
  const blockAt = r.add({ kind: 'review', by: 'reviewer:x', node: 'c', attempt: 1, obligation: 'review', key: 'rv-c', verdict: 'block', rank: 1 });
  decoys = r.state().decoys ?? [];
  assert.deepEqual(decoys.find(d => d.node === 'c'), { ...decoys.find(d => d.node === 'c'), outcome: 'caught', decidedBy: blockAt });
  // A commitment made after a listed node was first dispatched cannot be revealed.
  const late = { nonce: 'late-nonce-0123456789', decoys: [{ node: 'b', defect: 'named after the fact' }] };
  r.add({ kind: 'decoy-commit', by: 'owner:human', channel: 'tty', digest: digestOf(late) });
  assert.match(r.errors(reveal(late)).join(), /first dispatched/);
  const ghost = { nonce: 'ghost-nonce-0123456789', decoys: [{ node: 'zz', defect: 'no such node' }] };
  r.add({ kind: 'decoy-commit', by: 'owner:human', channel: 'tty', digest: digestOf(ghost) });
  assert.match(r.errors(reveal(ghost)).join(), /does not exist/);
});

test('CLI: escape and decoy commands, owner channel, report Escapes section and escape rate', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    await seed(r.cwd); const planFile = join(r.root, 'plan.yaml'); await writeFile(planFile, planText);
    async function call<T>(cwd: string, args: string[], code = 0): Promise<T> { const out = await cli(cwd, [...args, '--json']); assert.equal(out.code, code, `${args.join(' ')}\n${out.stderr}\n${out.stdout}`); return JSON.parse(out.stdout) as T; }
    const entries = async () => (await call<{ entries: number }>(r.cwd, ['verify'])).entries;
    await call(r.cwd, ['init', planFile, '--i-am-owner']);
    const payload = { nonce: 'cli-nonce-5b1e0c9d77a2', decoys: [{ node: 'a', defect: 'accepts any value' }, { node: 'b', defect: 'b is off by one' }] };
    const file = join(r.root, 'decoys.json'); await writeFile(file, JSON.stringify(payload));
    const before = await entries();
    const digest = await cli(r.cwd, ['decoy', 'digest', file]);
    assert.equal(digest.code, 0, digest.stderr); assert.equal(digest.stdout.trim(), digestOf(payload));
    assert.equal(await entries(), before, 'decoy digest writes nothing');
    { const out = await cli(r.cwd, ['decoy', 'commit', digestOf(payload)]); assert.equal(out.code, 1); assert.match(out.stderr, /owner actions require/); }
    { const out = await cli(r.cwd, ['decoy', 'commit', digestOf(payload), '--as', 'parent:p']); assert.equal(out.code, 1); assert.match(out.stderr, /insufficient permissions/); }
    assert.equal((await cli(r.cwd, ['decoy', 'commit', 'abc', '--i-am-owner'])).code, 1);
    assert.equal((await cli(r.cwd, ['decoy', 'peek', file])).code, 2);
    await call(r.cwd, ['decoy', 'commit', digestOf(payload), '--i-am-owner']);
    { const out = await cli(r.cwd, ['report']); assert.equal(out.code, 0); assert.match(out.stdout, /Escapes \(all time\): 0/); assert.match(out.stdout, /unrevealed commitments 1/); assert.match(out.stdout, /Escape rate: n\/a/); assert.doesNotMatch(out.stdout, /accepts any value/); }
    const a = await call<{ worktree: string }>(r.cwd, ['dispatch', 'a']);
    await commitAt(a.worktree, { 'test/a.cjs': 'module.exports=1;', 'test/a.test.cjs': checkTest('a', 1) });
    await call(a.worktree, ['submit', 'a']); await call(r.cwd, ['attest', 'a']);
    const merged = await call<{ entry: { seq: number } }>(r.cwd, ['merge', 'a']);
    await call(r.cwd, ['decoy', 'reveal', file, '--i-am-owner']);
    const b = await call<{ worktree: string }>(r.cwd, ['dispatch', 'b']);
    await commitAt(b.worktree, { 'test/b.test.cjs': checkTest('b', 1) });
    await call(b.worktree, ['submit', 'b']); await call(r.cwd, ['attest', 'b'], 1);
    { const out = await cli(r.cwd, ['escape', 'a', '--merge', '0', '--class', 'weak', '--note', 'x']); assert.equal(out.code, 1); assert.match(out.stderr, /not a merge of node a/); }
    assert.equal((await cli(r.cwd, ['escape', 'a', '--merge', String(merged.entry.seq), '--class', 'nope', '--note', 'x'])).code, 2);
    assert.equal((await cli(r.cwd, ['escape', 'a', '--merge', String(merged.entry.seq), '--class', 'weak'])).code, 2);
    assert.equal((await cli(r.cwd, ['escape', 'b', '--merge', String(merged.entry.seq), '--class', 'weak', '--note', 'x'])).code, 1);
    await call(r.cwd, ['escape', 'a', '--merge', String(merged.entry.seq), '--class', 'false-pass', '--note', 'a passed but accepts any value', '--evidence', 'issue 7']);
    const report = await call<{ escapes: { byClass: Record<string, number>; caught: number; escaped: number; pending: number; unrevealed: number; rate: number | null } }>(r.cwd, ['report']);
    assert.deepEqual({ ...report.escapes, escapes: undefined, decoys: undefined }, { escapes: undefined, decoys: undefined, byClass: { missing: 0, 'false-pass': 1, reuse: 0, weak: 0, waiver: 0 }, caught: 1, escaped: 1, pending: 0, unrevealed: 0, rate: 0.5 });
    const text = await cli(r.cwd, ['report']);
    assert.match(text.stdout, /Escapes \(all time\): 1/); assert.match(text.stdout, /false-pass ①a: 1/);
    assert.match(text.stdout, /a passed but accepts any value \[issue 7\]/);
    assert.match(text.stdout, /Decoys: caught 1, escaped 1, pending 0/); assert.match(text.stdout, /Escape rate: 50\.0% \(1 escaped \/ 2 decided\)/);
    await writeFile(file, JSON.stringify({ ...payload, decoys: [{ node: 'b', defect: 'claimed afterwards' }] }));
    { const out = await cli(r.cwd, ['decoy', 'reveal', file, '--i-am-owner']); assert.equal(out.code, 1); assert.match(out.stderr, /does not hash/); }
    await call(r.cwd, ['verify']);
  } finally { await r.cleanup(); }
});
