import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { reduce, validateDraft } from '../src/reducer.ts';
import { briefView, escapeSummary, receipt, renderBrief, renderEscapes, renderReceipt } from '../src/views.ts';
import { canonical, sha256 } from '../src/canon.ts';
import type { CandidateFacts, Draft, Entry, Plan, State, StateFacts } from '../src/types.ts';

// Only exports that exist on the base are imported, so the base fails by assertion.
const check = (id: string) => ({ id, run: `test ${id}`, timeout_s: 10, reads: ['**'] });
const node = (id: string, review = 0) => ({ id, deps: [], writes: ['src/'], checks: [check(`c${id}`)], review: { count: review, min_rank: 1 } });
const plan = (): Plan => ({ version: 1, trunk: 'main', closure: [], invariants: [check('safe')], nodes: [node('a', 1), node('b'), node('c')] });
const facts = (id: string, commit: string, base: string): CandidateFacts => ({ commit, base, tree: `t-${commit}`, patch: 'p', changed: ['src/x'], closureTouched: false, keys: { [`check:c${id}`]: `k-${id}`, writes: `w-${id}`, rulings: `r-${id}`, review: `rv-${id}` } });

function rig() {
  const entries: Entry[] = [];
  const state = (): State => reduce(entries, plan);
  const errors = (d: Draft | Record<string, unknown>): string[] => validateDraft(state(), d as Draft);
  const add = (d: Draft | Record<string, unknown>): number => {
    assert.deepEqual(errors(d), [], `unexpected refusal of ${JSON.stringify(d)}`);
    const seq = entries.length; entries.push({ ...d, seq, ts: new Date(0).toISOString(), prev: 'x', hash: `hash${seq}` } as Entry); return seq;
  };
  add({ kind: 'genesis', by: 'owner:human', channel: 'tty', plan: 'p', trunk: 'main', commit: 's0', state: { commit: 's0', tree: 't0', invKeys: { safe: 'inv0' } } });
  const obs = (subject: string, obligation: string, key: string, verdict: 'pass' | 'fail', commit: string, base = commit) => add({ kind: 'obs', by: 'executor:owed', subject, obligation, key, verdict, exit: verdict === 'pass' ? 0 : 1, durationMs: 1, commit, base });
  obs('trunk', 'inv:safe', 'inv0', 'pass', 's0');
  const trunk = () => state().trunk.commit;
  const dispatch = (id: string, attempt = 1, rulings_seen = -1) => add({ kind: 'dispatch', by: 'parent:main', node: id, attempt, base: trunk(), branch: 'b', worktree: 'wt', packet: 'blob', rulings_seen });
  const submit = (id: string, commit = `c-${id}`) => { const f = facts(id, commit, state().nodes[id]!.slot!.base); add({ kind: 'submit', by: `writer:${id}#${state().nodes[id]!.slot!.attempt}`, node: id, attempt: state().nodes[id]!.slot!.attempt, facts: f }); return f; };
  /** Passing check and writes on the current candidate. */
  const pass = (id: string) => { const f = state().nodes[id]!.candidate!; obs(id, `check:c${id}`, f.keys[`check:c${id}`]!, 'pass', f.commit, f.base); obs(id, 'writes', f.keys.writes!, 'pass', f.commit, f.base); };
  const review = (id: string, verdict: 'ok' | 'block', rank: number, by = 'reviewer:r2') => add({ kind: 'review', by, node: id, attempt: state().nodes[id]!.slot!.attempt, obligation: 'review', key: state().nodes[id]!.candidate!.keys.review!, verdict, rank });
  const merge = (id: string, invKey = 'inv0', commit = `m-${id}`) => {
    const pre = trunk(), m = facts(id, commit, pre), sf: StateFacts = { commit, tree: m.tree, invKeys: { safe: invKey } };
    return add({ kind: 'merge', by: 'executor:owed', node: id, attempt: state().nodes[id]!.slot!.attempt, prior: pre, commit, facts: m, state: sf });
  };
  return { entries, state, errors, add, obs, dispatch, submit, pass, review, merge };
}

const asFlags = (text: string): string[] => [...text.matchAll(/--as (\S+)/g)].map(m => m[1]!);

test('judgment block hints describe in words who can clear them and never print --as of the blocking reviewer', () => {
  const r = rig();
  r.dispatch('a'); r.submit('a'); r.pass('a');
  const block = r.review('a', 'block', 2, 'reviewer:r2');
  const s = r.state(), brief = briefView(s, r.entries, -1, 0), card = receipt(s, r.entries, 'a');
  const hints = [brief.rejected.find(b => b.seq === block)!.clear, card.blocks.find(b => b.seq === block)!.clear];
  for (const hint of hints) {
    assert.deepEqual(asFlags(hint), [], `hint must not carry --as: ${hint}`);
    assert.match(hint, /original reviewer reviewer:r2 with rank >= 2/);
    assert.match(hint, /any reviewer with rank > 2/);
    assert.match(hint, new RegExp(`owed waive a review --reason "[^"]+" --accept-risk ${block}`), 'owner waive command is kept');
  }
  // The only --as anywhere in the rendered views is the owner's own (owner-channel gated) decision command.
  const text = `${renderBrief(brief)}\n${renderReceipt(card)}`;
  assert.deepEqual([...new Set(asFlags(text))], ['owner:cli'], text);
  assert.equal(brief.decisions.find(d => d.node === 'a')!.command, `owed review a --ok --rank 3 --as owner:cli --candidate ${s.nodes.a!.candidate!.commit.slice(0, 12)}`);
  // The words match the semantics: the original reviewer at the same rank clears the block.
  r.review('a', 'ok', 2, 'reviewer:r2');
  assert.equal(r.state().nodes.a!.blocks.find(b => b.seq === block)!.state, 'cleared');
});

test('a node without an open slot gets "owed dispatch <node>" hints, never submit/attest of the old candidate', () => {
  const r = rig();
  r.dispatch('a'); const f = r.submit('a');
  const exec = r.obs('a', 'check:ca', f.keys['check:ca']!, 'fail', f.commit, f.base);
  const judgment = r.review('a', 'block', 1, 'reviewer:r1');
  r.add({ kind: 'abandon', by: 'parent:main', node: 'a', attempt: 1, reason: 'retry' });
  let s = r.state();
  const brief = briefView(s, r.entries, -1, 0), card = receipt(s, r.entries, 'a');
  assert.deepEqual(brief.rejected.map(b => b.seq).sort(), [exec, judgment].sort());
  for (const hint of [...brief.rejected.map(b => b.clear), ...card.blocks.map(b => b.clear)]) {
    assert.match(hint, /^owed dispatch a\b/, hint);
    assert.doesNotMatch(hint, /owed (submit|attest|review|waive)|--as /, hint);
  }
  assert.match(renderBrief(brief), /a\/check:ca failing obs #\d+ → owed dispatch a/);
  // Once a new attempt is open the hints address that attempt again.
  r.dispatch('a', 2);
  s = r.state();
  const reopened = briefView(s, r.entries, -1, 0).rejected;
  assert.match(reopened.find(b => b.seq === exec)!.clear, /owed submit a, then owed attest a/);
  assert.match(reopened.find(b => b.seq === judgment)!.clear, /^after the writer submits a candidate/);
});

test('rulings item reads "no rulings apply" when no ruling is in scope, with unchanged status', () => {
  const r = rig();
  r.dispatch('b'); r.submit('b');
  const line = (): string => renderReceipt(receipt(r.state(), r.entries, 'b')).split('\n').find(l => l.includes('b/rulings'))!;
  const rulings = () => r.state().nodes.b!.items.find(i => i.obligation === 'rulings')!;
  assert.equal(rulings().status, 'E');
  assert.match(line(), /^✔ no rulings apply b\/rulings/);
  assert.doesNotMatch(line(), /acknowledged|satisfied/);
  // A ruling for another node is not in scope either.
  r.add({ kind: 'rule', by: 'parent:main', text: 'only for c', nodes: ['c'] });
  assert.match(line(), /no rulings apply/);
  // An applicable ruling makes it owed; a dispatch that carries it acknowledges it.
  const rule = r.add({ kind: 'rule', by: 'parent:main', text: 'keep tests', nodes: ['b'] });
  assert.equal(rulings().status, 'D');
  assert.match(line(), new RegExp(`applicable ruling #${rule}`));
  r.add({ kind: 'abandon', by: 'parent:main', node: 'b', attempt: 1, reason: 'new ruling' });
  r.dispatch('b', 2, rule); r.submit('b', 'c-b2');
  assert.equal(rulings().status, 'E');
  assert.match(line(), /^✔ rulings acknowledged b\/rulings/);
  assert.doesNotMatch(line(), /no rulings apply/);
});

const digestOf = (p: { nonce: string; decoys: { node: string; defect: string }[] }): string => sha256(canonical(p));
const commitOf = (p: { nonce: string; decoys: { node: string; defect: string }[] }) => ({ kind: 'decoy-commit', by: 'owner:human', channel: 'tty', digest: digestOf(p) });
const reveal = (p: object) => ({ kind: 'decoy-reveal', by: 'owner:human', channel: 'tty', ...p });

test('a node listed in more than one reveal counts once, and the earliest commitment wins in either reveal order', () => {
  for (const order of ['early-first', 'late-first'] as const) {
    const r = rig();
    const early = { nonce: 'early-nonce-0123456789', decoys: [{ node: 'b', defect: 'early defect' }] };
    const late = { nonce: 'late-nonce-0123456789', decoys: [{ node: 'b', defect: 'late defect' }, { node: 'c', defect: 'c defect' }] };
    const earlySeq = r.add(commitOf(early)), lateSeq = r.add(commitOf(late));
    r.dispatch('b'); r.submit('b'); r.pass('b'); const merged = r.merge('b');
    for (const p of order === 'early-first' ? [early, late] : [late, early]) r.add(reveal(p));
    const s = r.state();
    assert.deepEqual(s.decoys.map(d => [d.node, d.defect, d.commit, d.outcome]).sort(), [['b', 'early defect', earlySeq, 'escaped'], ['c', 'c defect', lateSeq, 'pending']], order);
    assert.equal(s.decoys.find(d => d.node === 'b')!.decidedBy, merged);
  }
});

test('escape metrics count a node revealed twice once; a failure seen only while merging is not a catch yet', () => {
  const r = rig();
  const first = { nonce: 'metric-nonce-0123456789', decoys: [{ node: 'a', defect: 'breaks safe' }, { node: 'b', defect: 'b defect' }, { node: 'c', defect: 'c defect' }] };
  const again = { nonce: 'again-nonce-0123456789', decoys: [{ node: 'b', defect: 'b named again' }] };
  r.add(commitOf(first)); r.add(commitOf(again));
  // c: its node check fails before any merge: caught.
  r.dispatch('c'); const fc = r.submit('c'); const caught = r.obs('c', 'check:cc', fc.keys['check:cc']!, 'fail', fc.commit, fc.base);
  // b: merges cleanly: escaped (revealed twice below, counted once).
  r.dispatch('b'); r.submit('b'); r.pass('b'); const mergedB = r.merge('b');
  // a: the only failure is a trunk invariant on a refused merge result (fresh merge commit m1-a);
  // after an owner defer a new merge commit m2-a lands. Current limit: not attributed, so escaped.
  r.dispatch('a'); r.submit('a'); r.pass('a'); r.review('a', 'ok', 1, 'reviewer:r1');
  r.add(reveal(first)); r.add(reveal(again));
  r.obs('trunk', 'inv:safe', 'inv-m', 'fail', 'm1-a');
  assert.equal(r.state().decoys.find(d => d.node === 'a')!.outcome, 'pending', 'a trunk failure while merging is not attributed yet');
  r.add({ kind: 'defer', by: 'owner:human', channel: 'tty', node: 'a', items: [{ id: 'safe', key: 'inv-m' }], reason: 'repair next' });
  const mergedA = r.merge('a', 'inv-m', 'm2-a');
  const s = r.state(), v = escapeSummary(s);
  assert.deepEqual(s.decoys.map(d => [d.node, d.outcome, d.decidedBy]), [['a', 'escaped', mergedA], ['b', 'escaped', mergedB], ['c', 'caught', caught]]);
  assert.deepEqual([v.caught, v.escaped, v.pending, v.unrevealed], [1, 2, 0, 0]);
  assert.equal(v.rate, 2 / 3);
  assert.match(renderEscapes(v).join('\n'), /Escape rate: 66\.7% \(2 escaped \/ 3 decided\)/);
});

test('validateDraft refuses unknown fields in escape, decoy-commit and decoy-reveal entries', () => {
  const r = rig();
  r.dispatch('b'); r.submit('b'); r.pass('b'); const merged = r.merge('b');
  const p = { nonce: 'strict-nonce-0123456789', decoys: [{ node: 'c', defect: 'c defect' }] };
  const escape = { kind: 'escape', by: 'parent:main', node: 'b', merge: merged, class: 'weak', note: 'oracle too weak' };
  assert.match(r.errors({ ...escape, severity: 'high' }).join(), /escape has unknown fields: severity/);
  assert.match(r.errors({ ...commitOf(p), payload: p }).join(), /decoy-commit has unknown fields: payload/);
  r.add(commitOf(p));
  assert.match(r.errors(reveal({ ...p, hint: 'c is planted' })).join(), /decoy-reveal has unknown fields: hint/);
  // Exact shapes (with optional evidence and channel) are accepted.
  r.add({ ...escape, evidence: 'issue 9' });
  r.add(reveal(p));
  assert.equal(r.state().decoys.length, 1);
});

test('README and SPEC agree that gc writes a note when it removes or pins something', async () => {
  const readme = await readFile(new URL('../README.md', import.meta.url), 'utf8');
  const spec = await readFile(new URL('../docs/SPEC.md', import.meta.url), 'utf8');
  const gc = readme.split('\n').find(l => l.includes('refs/owed/keep/<node>/<attempt>/<submit-seq>'))!;
  assert.match(gc, /removes or pins something appends a `note` entry/);
  assert.doesNotMatch(gc, /removes something appends/);
  assert.match(spec.replace(/\s+/g, ' '), /When it removes or pins something \(not in dry-run\) it appends one `note` entry/);
});
