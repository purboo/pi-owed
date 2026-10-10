// D21: owner allowances — pre-authorized parent downgrades and adoptions (SPEC §3.4).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import owed from '../src/extension.ts';
import { Ledger } from '../src/ledger.ts';
import * as ops from '../src/ops.ts';
import { canonical } from '../src/canon.ts';
import { parsePlan, planDowngrades } from '../src/plan.ts';
import { reduce, validateDraft, uncoveredDowngrades, allowanceSeq, adoptPrefixes, unadoptable, writesAllowed } from '../src/reducer.ts';
import type { Draft, Entry, Plan, State } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';
// D25.4: these tests exercise the owner confirmation (dialog or TTY prompt), now the opt-in gate OWED_CONFIRM=owner.
process.env.OWED_CONFIRM = 'owner';

type Repo = Awaited<ReturnType<typeof repo>>;
type Result = Awaited<ReturnType<ToolDefinition['execute']>> & { isError?: boolean };
type Spec = Record<string, unknown>;
const owner = { role: 'owner' as const, id: 'human' };
const parent = { role: 'parent' as const, id: 'main' };
const check = (id: string) => ({ id, run: 'true', reads: ['**'] });
const node = (id: string, writes: string[], extra: Spec = {}): Spec => ({ id, writes, checks: [], review: { count: 0, min_rank: 1 }, ...extra });
const ALLOW = [{ nodes: ['p', 'w'], review_count: 1, review_rank: 1, writes: ['docs/'], checks: ['ui-*'] }, { adopt: ['testdata/'] }];
const base = (): Spec => ({
  version: 1, trunk: 'main', closure: [],
  invariants: [{ id: 'health', run: 'test ! -f testdata/broken', reads: ['testdata/broken'] }],
  nodes: [node('p', ['p/'], { review: { count: 2, min_rank: 2 }, checks: [check('ui-p'), check('core-p')] }), node('q', ['q/'], { review: { count: 1, min_rank: 1 } }), node('w', ['w.txt']), node('x', ['x.txt'])],
  allow: ALLOW,
});
/** A copy of plan `p` with `fn` applied to node `id`. */
function edit(p: Spec, id: string, fn: (n: Spec) => void): Spec { const c = structuredClone(p); fn((c.nodes as Spec[]).find(n => n.id === id)!); return c; }
const P = (s: Spec): Plan => parsePlan(JSON.stringify(s));

async function fixture(plan: Spec = base()): Promise<Repo & { s0: string }> {
  const r = await repo();
  try {
    const s0 = await commitAt(r.cwd, { README: 'x\n', 'testdata/keep': 'k\n' });
    await ops.init({ cwd: r.cwd, plan: JSON.stringify(plan), as: owner, channel: 'flag' });
    return { ...r, s0 };
  } catch (e) { await r.cleanup(); throw e; }
}
async function entries(cwd: string): Promise<Entry[]> { return (await Ledger.open(cwd)).read(); }
async function state(cwd: string, extra: Record<string, Plan> = {}): Promise<State> {
  const ledger = await Ledger.open(cwd), all = await ledger.read(), plans = new Map<string, Plan>(Object.entries(extra));
  for (const e of all) if (e.kind === 'genesis' || e.kind === 'plan') plans.set(e.plan, parsePlan((await ledger.getBlob(e.plan)).toString()));
  return reduce(all, sha => plans.get(sha)!);
}
const setPlan = (cwd: string, plan: Spec, as: typeof owner | typeof parent | { role: 'parent'; id: string } = parent) => ops.planSet({ cwd, plan: JSON.stringify(plan), as, ...(as.role === 'owner' ? { channel: 'flag' as const } : {}) });
const text = (r: Result): string => r.content.map(c => c.type === 'text' ? c.text : '').join('\n');
function harness(cwd: string) {
  const tools = new Map<string, ToolDefinition>(), prompts: string[] = [];
  owed({ registerTool(t: ToolDefinition) { tools.set(t.name, t); }, registerCommand() {} } as unknown as ExtensionAPI);
  const ctx = { cwd, hasUI: true, ui: { async confirm(title: string, message: string) { prompts.push(`${title}\n${message}`); return true; }, notify() {} } } as unknown as ExtensionContext;
  return { prompts, async call(name: string, args: Record<string, unknown>): Promise<Result> {
    return tools.get(name)!.execute('test', args, undefined, undefined, ctx as Parameters<ToolDefinition['execute']>[4]) as Promise<Result>;
  } };
}

test('allow block: parsed with defaults, validated strictly; a plan without it is unchanged', () => {
  const plan = P(base());
  assert.deepEqual(plan.allow, [{ nodes: ['p', 'w'], review_count: 1, review_rank: 1, writes: ['docs/'], checks: ['ui-*'] }, { nodes: ['*'], adopt: ['testdata/'] }]);
  const without = base(); delete without.allow;
  assert.equal('allow' in P(without), false, 'no allow key without the block (plan blobs and keys stay as in 0.4.1)');
  assert.deepEqual(P({ ...without, allow: [] }).allow, []);
  const bad = (allow: unknown, re: RegExp) => assert.throws(() => P({ ...without, allow }), (e: Error) => re.test(e.message), JSON.stringify(allow));
  bad({ nodes: ['*'] }, /allow: expected array/);
  bad([{ nodes: ['a'] }], /allow\[0\]: a rule needs at least one permission/);
  bad([{ review_count: 0, extra: 1 }], /allow\[0\]\.extra: unknown key/);
  bad([{ review_count: -1 }], /allow\[0\]\.review_count: expected integer >= 0/);
  bad([{ review_rank: 4 }], /allow\[0\]\.review_rank: expected integer in 1\.\.3/);
  bad([{ writes: [] }], /allow\[0\]\.writes: expected a non-empty array/);
  bad([{ checks: 'ui-*' }], /allow\[0\]\.checks: expected a non-empty array/);
  bad([{ adopt: [''] }], /allow\[0\]\.adopt: expected a non-empty array of non-empty strings/);
  bad([{ nodes: 'a', adopt: ['x/'] }], /allow\[0\]\.nodes: expected a non-empty array/);
  bad(['x'], /allow\[0\]: expected object/);
});

test('coverage: only rules of the prior plan, on matching nodes, within their bounds; never node/trunk/plan-level/allow items', () => {
  const prev = P(base());
  const gaps = (next: Spec, from: Plan = prev) => { const n = P(next); return uncoveredDowngrades(from, n, planDowngrades(from, n)).map(d => `${d.node}: ${d.what}`); };
  // Covered: review lowered to the bounds, writes widened inside docs/, ui-* checks removed or weakened.
  assert.deepEqual(gaps(edit(base(), 'p', n => { n.review = { count: 1, min_rank: 1 }; })), []);
  assert.deepEqual(gaps(edit(base(), 'p', n => { n.writes = ['p/', 'docs/api/']; })), []);
  assert.deepEqual(gaps(edit(base(), 'p', n => { n.checks = [check('core-p')]; })), []);
  assert.deepEqual(gaps(edit(base(), 'p', n => { n.checks = [{ ...check('ui-p'), run: 'false' }, check('core-p')]; })), [], 'a definition change of an allowed check');
  // Not covered: below the bound, outside the prefix, other check ids, other nodes.
  assert.deepEqual(gaps(edit(base(), 'p', n => { n.review = { count: 0, min_rank: 2 }; })), ['p: review count/rank reduced']);
  assert.deepEqual(gaps(edit(base(), 'p', n => { n.writes = ['p/', 'src/']; })), ['p: writes scope expanded']);
  assert.deepEqual(gaps(edit(base(), 'p', n => { n.checks = [check('ui-p')]; })), ['p: core-p check removed']);
  assert.deepEqual(gaps(edit(base(), 'q', n => { n.review = { count: 0, min_rank: 1 }; })), ['q: review count/rank reduced']);
  // Never covered, even by a rule that allows everything on every node.
  const all: Spec = { ...base(), allow: [{ review_count: 0, review_rank: 1, writes: ['docs/', 'p/'], checks: ['*', '**'] }] }, wide = P(all);
  assert.deepEqual(gaps({ ...all, nodes: (all.nodes as Spec[]).filter(n => n.id !== 'x') }, wide), ['x: node removed']);
  assert.deepEqual(gaps({ ...all, invariants: [] }, wide), ['trunk: health check removed']);
  assert.deepEqual(gaps({ ...all, setup: 'npm ci' }, wide), ['*: setup/closure changed; cannot prove obligations were not reduced']);
  assert.deepEqual(gaps(all, P(edit(all, 'q', n => { n.deps = ['p']; }))), ['q: dependency removed']);
  // The new plan's rules never cover its own downgrades; changing allow is itself an owner-only downgrade.
  const none = base(); delete none.allow;
  assert.deepEqual(gaps(edit(base(), 'p', n => { n.review = { count: 1, min_rank: 1 }; }), P(none)), ['trunk: allow changed', 'p: review count/rank reduced']);
  assert.deepEqual(gaps({ ...base(), allow: [ALLOW[0], { adopt: ['testdata/', 'src/'] }] }), ['trunk: allow changed']);
  // Deleting whole rules (or the block) is not a downgrade.
  assert.deepEqual(planDowngrades(prev, P({ ...base(), allow: [ALLOW[1]] })), []);
  assert.deepEqual(gaps(none), []);
  // Helpers used by adopt and the receipt card.
  assert.deepEqual(adoptPrefixes(prev), ['testdata/']);
  assert.equal(unadoptable(prev, ['testdata/a', 'testdata/b/c']), undefined);
  assert.equal(unadoptable(prev, ['testdata/a', 'src/x', 'tests/y']), 'src/x');
  assert.equal(writesAllowed(prev, 'w', ['docs/a.md']), true);
  assert.equal(writesAllowed(prev, 'w', ['docs/a.md', 'src/b']), false);
  assert.equal(writesAllowed(prev, 'x', ['docs/a.md']), false, 'rule does not match node x');
});

test('parent plan updates: covered downgrades need no owner, stay in ΔO⁻ labelled under allowance (plan #S); uncovered ones are refused with the list', { timeout: 120_000 }, async () => {
  const r = await fixture();
  try {
    const genesis = (await entries(r.cwd))[0]!;
    assert.equal(allowanceSeq(await state(r.cwd)), genesis.seq, 'S = genesis when it has an allow block');
    // Covered by the genesis rules: lower p's review, widen its writes inside docs/, remove ui-p.
    const eased = edit(base(), 'p', n => { n.review = { count: 1, min_rank: 1 }; n.writes = ['p/', 'docs/api/']; n.checks = [check('core-p')]; });
    const e = await setPlan(r.cwd, eased);
    assert.equal(e.by, 'parent:main'); assert.equal(e.channel, undefined);
    let s = await state(r.cwd);
    const d = s.downgrades.find(x => x.seq === e.seq)!;
    assert.equal(d.allowance, genesis.seq);
    assert.deepEqual(new Set(d.items.map(i => `${i.node}: ${i.what}`)), new Set(['p: check ui-p removed', 'p: review count lowered', 'p: review rank lowered', 'p: writes widened', 'p: ui-p check removed', 'p: review count/rank reduced', 'p: writes scope expanded']));
    const report = (await cli(r.cwd, ['report'])).stdout;
    assert.match(report, new RegExp(`Downgrades ΔO⁻\\n  #${e.seq} by parent:main under allowance \\(plan #${genesis.seq}\\) p: check ui-p removed\\n`));
    assert.equal((JSON.parse((await cli(r.cwd, ['report', '--json'])).stdout) as ops.Report).downgrades[0]!.allowance, genesis.seq);
    assert.match((await cli(r.cwd, ['why', 'p'])).stdout, new RegExp(`\\nΔO⁻ #${e.seq} by parent:main under allowance \\(plan #${genesis.seq}\\): p: check ui-p removed; `));
    // Uncovered parent updates are refused, listing what no rule covers; nothing is recorded.
    const before = await entries(r.cwd);
    const refuse = async (plan: Spec, re: RegExp) => { await assert.rejects(setPlan(r.cwd, plan), (err: Error) => /Only owner may approve a plan that reduces obligations; not covered by an allowance of the current plan: /.test(err.message) && re.test(err.message)); };
    await refuse(edit(eased, 'p', n => { n.review = { count: 0, min_rank: 1 }; }), /p: review count\/rank reduced$/);
    await refuse(edit(eased, 'p', n => { n.checks = []; }), /p: core-p check removed$/);
    await refuse(edit(eased, 'q', n => { n.review = { count: 0, min_rank: 1 }; }), /q: review count\/rank reduced$/);
    await refuse(edit(eased, 'p', n => { n.writes = ['p/', 'docs/api/', 'src/']; }), /p: writes scope expanded$/);
    await refuse({ ...eased, allow: [...ALLOW, { nodes: ['q'], review_count: 0 }] }, /trunk: allow changed/);
    await refuse({ ...eased, setup: 'true' }, /\*: setup\/closure changed/);
    { const out = await cli(r.cwd, ['why', 'p']); assert.equal(out.code, 0); }
    await writeFile(join(r.root, 'q0.json'), JSON.stringify(edit(eased, 'q', n => { n.review = { count: 0, min_rank: 1 }; })));
    { const out = await cli(r.cwd, ['plan', join(r.root, 'q0.json')]); assert.equal(out.code, 1); assert.match(out.stderr, /Refused: .*not covered by an allowance of the current plan: q: review count\/rank reduced(?!;)/); }
    assert.deepEqual(await entries(r.cwd), before, 'refusals record nothing');
    // The owner adds a rule for q: S moves to that entry; a parent downgrade of q is then covered and labelled with it.
    const widened = { ...eased, allow: [...ALLOW, { nodes: ['q'], review_count: 0 }] };
    const o = await setPlan(r.cwd, widened, owner);
    s = await state(r.cwd);
    assert.deepEqual(s.downgrades.find(x => x.seq === o.seq)?.items, [{ node: 'trunk', what: 'allow changed' }]);
    assert.equal(s.downgrades.find(x => x.seq === o.seq)?.allowance, undefined, 'owner downgrades carry no allowance label');
    assert.equal(allowanceSeq(s), o.seq);
    await writeFile(join(r.root, 'q0.json'), JSON.stringify(edit(widened, 'q', n => { n.review = { count: 0, min_rank: 1 }; })));
    const out = await cli(r.cwd, ['plan', join(r.root, 'q0.json')]);
    assert.equal(out.code, 0, out.stderr);
    assert.match(out.stdout, new RegExp(`updated plan from .*, downgrades q: review count lowered\\nDowngrades by parent:cli under allowance \\(plan #${o.seq}\\): q: review count lowered; q: review count/rank reduced`));
    // Deleting a whole rule is not a downgrade, but it changes allow: S moves again.
    const narrowed = { ...edit(widened, 'q', n => { n.review = { count: 0, min_rank: 1 }; }), allow: ALLOW };
    const del = await setPlan(r.cwd, narrowed);
    s = await state(r.cwd);
    assert.equal(s.downgrades.some(x => x.seq === del.seq), false);
    assert.equal(allowanceSeq(s), del.seq);
    // Replay: the reducer accepts the recorded parent updates, and refuses a forged uncovered one on its own.
    assert.equal((await ops.verify({ cwd: r.cwd })).ok, true);
    const forged = P(edit(narrowed, 'p', n => { n.review = { count: 0, min_rank: 1 }; })), ok = P(edit(narrowed, 'w', n => { n.writes = ['w.txt', 'docs/w/']; }));
    s = await state(r.cwd, { forged, ok });
    const draft = (plan: string, by = 'parent:x', downgrades: { node: string; what: string }[] = []): Draft => ({ kind: 'plan', by, prior: s.planSha, plan, downgrades });
    assert.match(validateDraft(s, draft('forged')).join(), /Only owner may approve a plan that reduces obligations; not covered by an allowance of the current plan: p: review count\/rank reduced$/);
    assert.deepEqual(validateDraft(s, draft('ok')), []);
    assert.deepEqual(validateDraft(s, draft('ok', 'parent:x', [{ node: 'w', what: 'writes widened' }])), []);
    assert.match(validateDraft(s, draft('ok', 'parent:x', [{ node: 'w', what: 'anything else' }])).join(), /not covered .*w: anything else/, 'an unknown claimed item is never covered');
    assert.match(validateDraft(s, draft('ok', 'writer:w#1')).join(), /plan insufficient permissions/);
    assert.match(validateDraft(s, draft('ok', 'writer:w#1')).join(), /Only owner may approve a plan that reduces obligations(?!;)/);
  } finally { await r.cleanup(); }
});

test('parent adoption under an adopt allowance: no prompt, labelled, guarded; first uncovered path refused; owner-only without the block', { timeout: 120_000 }, async () => {
  const r = await fixture();
  try {
    const genesis = (await entries(r.cwd))[0]!;
    const head = await commitAt(r.cwd, { 'testdata/vec.bin': 'v2\n', 'testdata/sub/hash': 'h\n' });
    // The CLI subprocess has no TTY: a prompt would fail, so success shows it did not ask.
    const out = await cli(r.cwd, ['adopt', '--note', 'test vector hash', '--as', 'parent:night']);
    assert.equal(out.code, 0, out.stderr);
    assert.equal(out.stderr, '', 'no preview, no prompt');
    assert.match(out.stdout, new RegExp(`adopted trunk main .*\\nAdopted by parent:night under allowance \\(plan #${genesis.seq}\\)\\n`));
    const e = (await entries(r.cwd)).at(-1)!;
    assert.ok(e.kind === 'adopt' && e.by === 'parent:night' && e.channel === undefined && e.commit === head);
    const s = await state(r.cwd);
    assert.equal(s.trunk.commit, head);
    assert.deepEqual(s.adoptions.map(a => [a.by, a.allowance]), [['parent:night', genesis.seq]]);
    const label = new RegExp(`#${e.seq} adopted by parent:night under allowance \\(plan #${genesis.seq}\\) [0-9a-f]{12}\\.\\.${head.slice(0, 12)} \\(1 commit made outside owed, not reviewed by owed\\); changed: testdata/sub/hash, testdata/vec.bin; note: test vector hash`);
    assert.match((await cli(r.cwd, ['report'])).stdout, label);
    assert.match((await cli(r.cwd, ['brief'])).stdout, label);
    // A path outside the prefixes: refused before any effect, naming the first one.
    await commitAt(r.cwd, { 'testdata/a': '1\n', 'src/z.ts': 'z\n', 'tests/y': 'y\n' });
    const before = await entries(r.cwd);
    { const o = await cli(r.cwd, ['adopt', '--note', 'n', '--as', 'parent:night']); assert.equal(o.code, 1); assert.match(o.stderr, /parent adoption refused: changed path src\/z\.ts is not under an allow adopt prefix \(testdata\/\); the owner must adopt it/); }
    const st = await state(r.cwd), facts = { commit: head, tree: 't', invKeys: st.trunk.invKeys };
    const draft = { kind: 'adopt', by: 'parent:night', trunk: 'main', prior: st.trunk.commit, commit: 'c'.repeat(40), state: { ...facts, commit: 'c'.repeat(40) }, changed: ['testdata/a', 'src/z.ts'], commits: 1, note: 'n' } as Draft;
    assert.match(validateDraft(st, draft).join(), /parent adoption refused: changed path src\/z\.ts/);
    assert.deepEqual(validateDraft(st, { ...draft, changed: ['testdata/a'] } as Draft), []);
    assert.match(validateDraft(st, { ...draft, by: 'reviewer:r' } as Draft).join(), /adopt insufficient permissions; requires owner/);
    assert.deepEqual(await entries(r.cwd), before);
    // The owner adopts that one; then adoptGuard still binds a parent adoption (no new debt).
    await ops.adopt({ cwd: r.cwd, note: 'owner', as: owner, channel: 'flag' });
    await commitAt(r.cwd, { 'testdata/broken': 'x\n' });
    await assert.rejects(ops.adopt({ cwd: r.cwd, note: 'n', as: parent }), /adoption refused: invariant health/);
    assert.equal((await state(r.cwd)).adoptions.length, 2);
  } finally { await r.cleanup(); }
  // Without an adopt rule the parent cannot adopt (0.4.1 messages).
  const plain = base(); plain.allow = [ALLOW[0]];
  const r2 = await fixture(plain);
  try {
    await commitAt(r2.cwd, { 'testdata/vec.bin': 'v2\n' });
    await assert.rejects(ops.adopt({ cwd: r2.cwd, note: 'n', as: parent }), /adopt requires owner/);
    const out = await harness(r2.cwd).call('owed_adopt', { note: 'n', as: 'parent:pi' });
    assert.equal(out.isError, true); assert.match(text(out), /Only owner may adopt/);
  } finally { await r2.cleanup(); }
});

test('pi: owed_adopt and owed_plan as parent under an allowance show no dialog; uncovered plan downgrades are refused with the list', { timeout: 120_000 }, async () => {
  const r = await fixture();
  try {
    const genesis = (await entries(r.cwd))[0]!;
    const h = harness(r.cwd);
    await commitAt(r.cwd, { 'testdata/vec.bin': 'v2\n' });
    const a = await h.call('owed_adopt', { note: 'hash', as: 'parent:pi' });
    assert.notEqual(a.isError, true, text(a));
    assert.match(text(a), new RegExp(`Adopted by parent:pi under allowance \\(plan #${genesis.seq}\\)`));
    assert.deepEqual(h.prompts, []);
    const e = (await entries(r.cwd)).at(-1)!;
    assert.ok(e.kind === 'adopt' && e.by === 'parent:pi' && e.channel === undefined);
    // Covered plan downgrade: default principal parent:pi, no dialog.
    await writeFile(join(r.cwd, 'eased.json'), JSON.stringify(edit(base(), 'w', n => { n.writes = ['w.txt', 'docs/']; })));
    const p = await h.call('owed_plan', { plan: 'eased.json' });
    assert.notEqual(p.isError, true, text(p));
    assert.match(text(p), new RegExp(`^Downgrades by parent:pi under allowance \\(plan #${genesis.seq}\\): w: writes widened; w: writes scope expanded\\n`));
    assert.deepEqual(h.prompts, []);
    assert.equal((await entries(r.cwd)).at(-1)!.by, 'parent:pi');
    // Uncovered: the owner dialog by default; an explicit parent is refused with the uncovered items.
    await writeFile(join(r.cwd, 'q0.json'), JSON.stringify(edit(edit(base(), 'w', n => { n.writes = ['w.txt', 'docs/']; }), 'q', n => { n.review = { count: 0, min_rank: 1 }; })));
    const before = await entries(r.cwd);
    const refused = await h.call('owed_plan', { plan: 'q0.json', as: 'parent:pi' });
    assert.equal(refused.isError, true);
    assert.match(text(refused), /Only owner may confirm plan downgrades; not covered by an allowance of the current plan: q: review count\/rank reduced$/);
    assert.deepEqual(await entries(r.cwd), before);
    const confirmed = await h.call('owed_plan', { plan: 'q0.json' });
    assert.notEqual(confirmed.isError, true, text(confirmed));
    assert.equal(h.prompts.length, 1, 'the owner dialog');
    const last = (await entries(r.cwd)).at(-1)!;
    assert.ok(last.by === 'owner:human' && last.channel === 'pi-confirm');
  } finally { await r.cleanup(); }
});

test('why lists out-of-writes paths of a failing writes item, says when an allowance covers them, and the parent widening writes lets the node pass', { timeout: 120_000 }, async () => {
  const r = await fixture();
  try {
    const genesis = (await entries(r.cwd))[0]!;
    const run = async (id: string, files: Record<string, string>) => {
      const d = await ops.dispatch({ cwd: r.cwd, node: id, as: parent });
      await commitAt(d.worktree, files);
      await ops.submit({ cwd: d.worktree, node: id, as: { role: 'writer', id: `${id}#1` } });
      return { d, accepted: (await ops.attest({ cwd: r.cwd, node: id })).accepted };
    };
    const w = await run('w', { 'w.txt': 'w\n', 'docs/w.md': 'doc\n', 'docs/api/w.md': 'doc\n' });
    assert.equal(w.accepted, false);
    const card = await ops.why({ cwd: r.cwd, node: 'w' });
    assert.deepEqual(card.outOfWrites, { paths: ['docs/api/w.md', 'docs/w.md'], allowance: genesis.seq });
    assert.match((await cli(r.cwd, ['why', 'w'])).stdout, new RegExp(`\\nOut-of-writes paths: docs/api/w.md, docs/w.md; the parent may widen writes in the plan \\(allowance plan #${genesis.seq}\\)\\n`));
    // Node x matches no rule; many paths are capped at 20 in the text, all kept in the JSON.
    const many: Record<string, string> = { 'x.txt': 'x\n' };
    for (let i = 0; i < 25; i++) many[`o/f${String(i).padStart(2, '0')}`] = `${i}\n`;
    assert.equal((await run('x', many)).accepted, false);
    const x = await ops.why({ cwd: r.cwd, node: 'x' });
    assert.equal(x.outOfWrites?.paths.length, 25); assert.equal(x.outOfWrites?.allowance, undefined);
    const xs = (await cli(r.cwd, ['why', 'x'])).stdout.split('\n').find(l => l.startsWith('Out-of-writes paths: '));
    assert.equal(xs, `Out-of-writes paths: ${Array.from({ length: 20 }, (_, i) => `o/f${String(i).padStart(2, '0')}`).join(', ')}, … +5 more`);
    // A node whose writes item passes shows no such line.
    await run('q', { 'q/a': 'a\n' });
    assert.equal((await ops.why({ cwd: r.cwd, node: 'q' })).items.find(i => i.obligation === 'writes')?.mark, '✔');
    assert.equal((await ops.why({ cwd: r.cwd, node: 'q' })).outOfWrites, undefined);
    assert.doesNotMatch((await cli(r.cwd, ['why', 'q'])).stdout, /Out-of-writes/);
    // The parent widens w's writes under the allowance; the writer resubmits the same commit and it passes.
    await setPlan(r.cwd, edit(base(), 'w', n => { n.writes = ['w.txt', 'docs/']; }));
    assert.equal((await state(r.cwd)).nodes.w!.candidate, undefined, 'the plan change invalidated the candidate');
    await ops.submit({ cwd: w.d.worktree, node: 'w', as: { role: 'writer', id: 'w#1' } });
    assert.equal((await ops.attest({ cwd: r.cwd, node: 'w' })).accepted, true);
    assert.equal((await ops.why({ cwd: r.cwd, node: 'w' })).outOfWrites, undefined);
  } finally { await r.cleanup(); }
});

test('allow is not part of any key and never invalidates a candidate', { timeout: 60_000 }, async () => {
  const r = await fixture();
  try {
    const d = await ops.dispatch({ cwd: r.cwd, node: 'q', as: parent });
    await commitAt(d.worktree, { 'q/a': 'a\n' });
    await ops.submit({ cwd: d.worktree, node: 'q', as: { role: 'writer', id: 'q#1' } });
    const before = await state(r.cwd);
    await setPlan(r.cwd, { ...base(), allow: [ALLOW[1]] });
    const after = await state(r.cwd);
    assert.equal(after.nodes.q!.candidate?.seq, before.nodes.q!.candidate?.seq);
    assert.equal(canonical(after.trunk.invKeys), canonical(before.trunk.invKeys));
  } finally { await r.cleanup(); }
});

// Integration with approve-evidence (D21.1/D23.2) and exec-env (D20.4): evidence downgrades are coverable by a `checks`
// glob on a matching node; `approve removed` and the reducer's plan-level `*` items (setup/closure, exec) never are.
const manual = (): Spec => edit(base(), 'p', n => { n.approve = 'owner'; n.evidence = [{ id: 'ui-shot', what: 'screenshot of the page' }, { id: 'core-sign', what: 'signed tarball' }]; });

test('coverage: evidence <id> removed/weakened covered by a checks glob on a matching node; approve removed and * items never', () => {
  const prev = P(manual());
  const gaps = (next: Spec, from: Plan = prev) => { const n = P(next); return uncoveredDowngrades(from, n, planDowngrades(from, n)).map(d => `${d.node}: ${d.what}`); };
  const ev = (fn: (e: Spec[]) => Spec[]) => edit(manual(), 'p', n => { n.evidence = fn(n.evidence as Spec[]); });
  // Covered: ui-shot matches the rule's `ui-*` checks glob on node p (the downgrade is still detected and claimed).
  const removed = ev(e => e.filter(x => x.id !== 'ui-shot'));
  assert.deepEqual(planDowngrades(prev, P(removed)), [{ node: 'p', what: 'evidence ui-shot removed' }]);
  assert.deepEqual(gaps(removed), []);
  const weakened = ev(e => e.map(x => x.id === 'ui-shot' ? { ...x, by: 'parent' } : x));
  assert.deepEqual(planDowngrades(prev, P(weakened)), [{ node: 'p', what: 'evidence ui-shot weakened' }]);
  assert.deepEqual(gaps(weakened), []);
  // Not covered: an id outside the globs, a node no rule matches, or a rule without `checks`.
  assert.deepEqual(gaps(ev(e => e.filter(x => x.id !== 'core-sign'))), ['p: evidence core-sign removed']);
  assert.deepEqual(gaps(ev(e => e.map(x => x.id === 'core-sign' ? { ...x, by: 'parent' } : x))), ['p: evidence core-sign weakened']);
  const onX = edit(base(), 'x', n => { n.evidence = [{ id: 'ui-x', what: 'look' }]; });
  assert.deepEqual(gaps(edit(onX, 'x', n => { n.evidence = []; }), P(onX)), ['x: evidence ui-x removed']);
  const noChecks = { ...manual(), allow: [{ nodes: ['p'], review_count: 0 }] };
  assert.deepEqual(gaps({ ...removed, allow: noChecks.allow }, P(noChecks)), ['p: evidence ui-shot removed']);
  // Never covered, even by a rule that allows every check id on every node.
  const all: Spec = { ...manual(), allow: [{ review_count: 0, review_rank: 1, writes: ['docs/', 'p/'], checks: ['*', '**'] }] }, wide = P(all);
  assert.deepEqual(gaps(edit(all, 'p', n => { delete n.approve; }), wide), ['p: approve removed']);
  assert.deepEqual(gaps(edit(all, 'p', n => { n.evidence = []; }), wide), [], 'every evidence id matches *');
  assert.deepEqual(gaps({ ...all, exec: { wrap: ['true'] } }, wide), ['*: exec changed; cannot prove obligations were not reduced']);
  assert.deepEqual(gaps({ ...all, exec: { env: { A: '1' } } }, P({ ...all, exec: { env: { A: '0' } } })), ['*: exec changed; cannot prove obligations were not reduced']);
  assert.deepEqual(gaps({ ...all, closure: ['p/'] }, wide), ['*: setup/closure changed; cannot prove obligations were not reduced']);
});

test('parent plan updates: a covered evidence removal is recorded under allowance; approve removed and an exec change still need the owner', { timeout: 120_000 }, async () => {
  const r = await fixture(manual());
  try {
    const genesis = (await entries(r.cwd))[0]!;
    const e = await setPlan(r.cwd, edit(manual(), 'p', n => { n.evidence = (n.evidence as Spec[]).filter(x => x.id !== 'ui-shot'); }));
    assert.equal(e.by, 'parent:main');
    const d = (await state(r.cwd)).downgrades.find(x => x.seq === e.seq)!;
    assert.equal(d.allowance, genesis.seq);
    assert.deepEqual(d.items, [{ node: 'p', what: 'evidence ui-shot removed' }]);
    assert.match((await cli(r.cwd, ['why', 'p'])).stdout, new RegExp(`\\nΔO⁻ #${e.seq} by parent:main under allowance \\(plan #${genesis.seq}\\): p: evidence ui-shot removed\\n`));
    const current = edit(manual(), 'p', n => { n.evidence = (n.evidence as Spec[]).filter(x => x.id !== 'ui-shot'); });
    const before = await entries(r.cwd);
    const refuse = async (plan: Spec, re: RegExp) => { await assert.rejects(setPlan(r.cwd, plan), (err: Error) => /Only owner may approve a plan that reduces obligations; not covered by an allowance of the current plan: /.test(err.message) && re.test(err.message)); };
    await refuse(edit(current, 'p', n => { delete n.approve; }), /plan: p: approve removed$/);
    await refuse(edit(current, 'p', n => { n.evidence = []; }), /plan: p: evidence core-sign removed$/);
    await refuse({ ...current, exec: { wrap: ['true'] } }, /: \*: exec changed; cannot prove obligations were not reduced$/);
    assert.deepEqual(await entries(r.cwd), before, 'refusals record nothing');
    // The owner may still make them.
    const o = await setPlan(r.cwd, edit(current, 'p', n => { delete n.approve; }), owner);
    assert.equal((await state(r.cwd)).downgrades.find(x => x.seq === o.seq)?.allowance, undefined);
  } finally { await r.cleanup(); }
});

test('coverage: an item readable both as a check and as an evidence downgrade is covered only if every reading is (pre-review ruling)', { timeout: 120_000 }, async () => {
  // Check id `evidence` and evidence id `check`: removing the check yields `evidence check removed`, which also reads as
  // "evidence obligation `check` removed". The rule's `c*` glob covers the evidence reading, not the check reading.
  const amb: Spec = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: [node('n', ['n/'], { checks: [check('evidence')], evidence: [{ id: 'check', what: 'looked at it' }] })], allow: [{ nodes: ['n'], checks: ['c*'] }] };
  const prev = P(amb), noCheck = edit(amb, 'n', n => { n.checks = []; }), next = P(noCheck);
  assert.notDeepEqual(uncoveredDowngrades(prev, next, []), []);
  assert.ok(uncoveredDowngrades(prev, next, []).some(d => d.node === 'n' && d.what === 'evidence check removed'));
  // Removing the evidence obligation `check` instead yields the same text, still readable as the check downgrade: uncovered.
  const noEvidence = P(edit(amb, 'n', n => { n.evidence = []; }));
  assert.ok(uncoveredDowngrades(prev, noEvidence, planDowngrades(prev, noEvidence)).some(d => d.what === 'evidence check removed'));
  // Without a check `evidence` only the evidence reading applies, which `c*` covers.
  const plain = edit(amb, 'n', n => { n.checks = [check('other')]; }), plainPrev = P(plain), plainNext = P(edit(plain, 'n', n => { n.evidence = []; }));
  assert.deepEqual(uncoveredDowngrades(plainPrev, plainNext, planDowngrades(plainPrev, plainNext)), []);
  const r = await fixture(amb);
  try {
    const before = await entries(r.cwd);
    await assert.rejects(setPlan(r.cwd, noCheck), /Only owner may approve a plan that reduces obligations; not covered by an allowance of the current plan: .*n: evidence check removed/);
    assert.deepEqual(await entries(r.cwd), before, 'the parent update is refused; nothing recorded');
  } finally { await r.cleanup(); }
});
