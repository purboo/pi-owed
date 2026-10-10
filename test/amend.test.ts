// N3 (0.10.0, wais #26): `owed amend <node> --writes +path --note LIMIT` edits the plan file (comments and flow style
// kept), records it as `owed plan` would (same authority; N1 carries), and appends a ruling naming the node, in one lock.
// Any refusal records nothing and leaves the file unchanged.
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { chmod, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import * as ops from '../src/ops.ts';
import { Ledger } from '../src/ledger.ts';
import { parsePlan } from '../src/plan.ts';
import type { Entry } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import owed from '../src/extension.ts';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { cli, commitAt, seed, checkTest, identity } from './helpers/surface.ts';
import { git, revParse } from '../src/git.ts';

const owner = { role: 'owner', id: 'pi' } as const, parent = { role: 'parent', id: 'test' } as const;
const PLAN = `# owed plan: this comment is kept
version: 1
trunk: main
closure: [test/helper.cjs]
invariants:
  - {id: unit, run: "node --test --test-reporter=tap test/invariant.test.cjs", min_tests: 1, reads: [test/invariant.test.cjs, test/state.cjs]}
allow:
  - {nodes: [b], writes: [test/]}   # the parent may widen b inside test/
nodes:
  - id: a  # node a
    review: {count: 1, min_rank: 1}
    writes: [test/a]   # flow style stays
    checks:
      - {id: a, run: "node --test --test-reporter=tap test/a.test.cjs", reads: ["test/a*"], min_tests: 1, red: true, tests: [test/a.test.cjs]}
  - id: b
    deps: [a]
    writes:
      - test/b
    checks:
      - {id: b, run: "node --test --test-reporter=tap test/b.test.cjs", reads: ["test/b*", test/helper.cjs], min_tests: 1}
`;

/** A ledger whose latest plan entry records the plan file `plan.yaml` (outside the repository). */
async function setup(text = PLAN) {
  const r = await repo();
  await seed(r.cwd);
  const file = join(r.root, 'plan.yaml');
  await writeFile(file, text);
  await ops.init({ cwd: r.cwd, plan: text, as: owner, channel: 'flag' });
  await ops.planSet({ cwd: r.cwd, as: parent, ...await ops.readPlan({ cwd: r.cwd, path: file }) });
  return { r, file };
}
async function submitted(r: { cwd: string }) {
  const a = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
  await commitAt(a.worktree, { 'test/a.cjs': 'module.exports=1;', 'test/a.test.cjs': checkTest('a', 1) });
  const sub = await ops.submit({ cwd: a.worktree, node: 'a', as: { role: 'writer', id: 'a#1' } });
  if (sub.kind !== 'submit') throw Error('submit');
  return sub;
}
const entriesOf = async (cwd: string): Promise<Entry[]> => (await Ledger.open(cwd)).read();
const item = (card: Awaited<ReturnType<typeof ops.why>>, o: string) => card.items.find(i => i.obligation === o)!;
/** Nothing recorded, the file unchanged, and no temporary file left next to it. */
async function untouched(r: { cwd: string; root: string }, file: string, count: number, text: string) {
  assert.equal((await entriesOf(r.cwd)).length, count, 'nothing recorded');
  assert.equal(await readFile(file, 'utf8'), text, 'file unchanged');
  assert.deepEqual((await readdir(r.root)).filter(f => f.includes('owed-amend')), [], 'no temporary file left');
}

test('N3: amend edits the file (comments and flow kept) and records plan, carry and rule in one append; the rule is acknowledged by review', { timeout: 180_000 }, async () => {
  const { r, file } = await setup();
  try {
    const sub = await submitted(r);
    await ops.attest({ cwd: r.cwd, node: 'a' });
    await ops.review({ cwd: r.cwd, node: 'a', as: { role: 'reviewer', id: 'rev' }, verdict: 'ok', rank: 1, note: 'ok' });
    assert.equal((await ops.why({ cwd: r.cwd, node: 'a' })).accepted, true);
    const before = (await entriesOf(r.cwd)).length;
    const res = await cli(r.cwd, ['amend', 'a', '--writes', '+test/extra.txt,+test/a', '--note', 'only the fixture file', '--as', 'owner:pi']);
    assert.equal(res.code, 0, res.stderr);
    const text = await readFile(file, 'utf8');
    assert.match(text, /^# owed plan: this comment is kept\n/);
    assert.match(text, /- id: a {2}# node a\n/);
    assert.match(text, /\n {4}writes: \[test\/a, test\/extra\.txt\] {3}# flow style stays\n/);
    assert.match(text, /# the parent may widen b inside test\//);
    const old = PLAN.split('\n'), changed = text.split('\n').filter((l, i) => l !== old[i]);
    assert.equal(text.split('\n').length, old.length);
    assert.equal(changed.length, 1, `only the writes line changed: ${JSON.stringify(changed)}`);
    const es = await entriesOf(r.cwd), [plan, carry, rule] = es.slice(before);
    assert.equal(es.length, before + 3);
    assert.ok(plan?.kind === 'plan' && plan.by === 'owner:pi' && plan.channel === 'delegated' && plan.path === file, JSON.stringify(plan));
    assert.match(plan.note ?? '', /amend a: writes \+test\/extra\.txt\. Limit: only the fixture file/);
    assert.deepEqual(plan.downgrades.map(d => d.node), ['a']);
    assert.ok(carry?.kind === 'submit' && carry.by === 'executor:owed' && carry.carry === sub.seq, JSON.stringify(carry));
    assert.ok(rule?.kind === 'rule' && rule.by === 'owner:pi' && rule.channel === 'delegated', JSON.stringify(rule));
    assert.deepEqual(rule.nodes, ['a']);
    assert.equal(rule.text, `writes of a widened by plan #${plan.seq}: +test/extra.txt. Limit: only the fixture file`);
    assert.match(res.stdout, new RegExp(`Carried a: candidate ${sub.facts.commit.slice(0, 12)}`));
    assert.match(res.stdout, /Widened writes of a: \+test\/extra\.txt \(already in writes: test\/a\); wrote /);
    const recorded = parsePlan((await (await Ledger.open(r.cwd)).getBlob(plan.plan)).toString());
    assert.deepEqual(recorded.nodes.find(n => n.id === 'a')?.writes, ['test/a', 'test/extra.txt']);
    let card = await ops.why({ cwd: r.cwd, node: 'a' });
    assert.notEqual(item(card, 'rulings').status, 'E', 'the reviewers must acknowledge the rule');
    assert.equal(item(card, 'review').status, 'E', 'the review on the unchanged key still counts');
    await ops.attest({ cwd: r.cwd, node: 'a' });
    await ops.review({ cwd: r.cwd, node: 'a', as: { role: 'reviewer', id: 'rev' }, verdict: 'ok', rank: 1, note: 'ok, within the limit', ack_rulings: rule.seq });
    card = await ops.why({ cwd: r.cwd, node: 'a' });
    assert.equal(card.accepted, true, JSON.stringify(card.items.map(i => [i.obligation, i.status])));
    assert.equal((await ops.verify({ cwd: r.cwd })).ok, true);
    // A merged node is refused.
    await ops.merge({ cwd: r.cwd, node: 'a', as: parent });
    const now = await readFile(file, 'utf8'), count = (await entriesOf(r.cwd)).length;
    await assert.rejects(ops.amend({ cwd: r.cwd, node: 'a', writes: ['+test/z'], note: 'n', as: owner, channel: 'delegated' }), /Node a is merged/);
    await untouched(r, file, count, now);
  } finally { await r.cleanup(); }
});

test('N3: authority is that of owed plan: a parent without an allow rule is refused (nothing recorded, file unchanged); an allow rule lets the parent amend', { timeout: 120_000 }, async () => {
  const { r, file } = await setup();
  try {
    const count = (await entriesOf(r.cwd)).length;
    const res = await cli(r.cwd, ['amend', 'a', '--writes', '+test/x', '--note', 'limit']);
    assert.equal(res.code, 1, res.stdout);
    assert.match(res.stderr, /Only owner may approve a plan that reduces obligations; not covered by an allowance of the current plan: a: /);
    await untouched(r, file, count, PLAN);
    // The pi tool with an explicit parent is refused the same way.
    const tools = new Map<string, ToolDefinition>();
    owed({ registerTool(t: ToolDefinition) { tools.set(t.name, t); }, registerCommand() {}, on() {} } as unknown as ExtensionAPI);
    const ctx = { cwd: r.cwd, hasUI: false } as unknown as ExtensionContext;
    const run = (p: Record<string, unknown>) => tools.get('owed_amend')!.execute('t', p, undefined, undefined, ctx as Parameters<ToolDefinition['execute']>[4]) as Promise<{ isError?: boolean; content: { text?: string }[]; details?: { plan?: Entry; rule?: Entry } }>;
    const refused = await run({ node: 'a', writes: ['+test/x'], note: 'limit', as: 'parent:pi' });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0]!.text!, /Only owner may confirm plan downgrades/);
    await untouched(r, file, count, PLAN);
    // An allow rule of the current plan covers b inside test/: the parent amends, labelled under allowance.
    const ok = await cli(r.cwd, ['amend', 'b', '--writes', '+test/x.cjs', '--note', 'the second fixture only']);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(ok.stdout, /Downgrades by parent:cli under allowance \(plan #\d+\): b: /);
    const es = await entriesOf(r.cwd);
    assert.equal(es.length, count + 2, 'plan and rule; no candidate to carry');
    assert.ok(es.at(-2)?.kind === 'plan' && es.at(-2)?.by === 'parent:cli' && es.at(-1)?.kind === 'rule' && es.at(-1)?.by === 'parent:cli');
    assert.match(await readFile(file, 'utf8'), /writes:\n {6}- test\/b\n {6}- test\/x\.cjs\n/, 'block style stays');
    // The pi tool without `as` defaults to the owner (delegated) when an allowance does not cover the widening.
    const pi = await run({ node: 'a', writes: ['+test/y'], note: 'pi limit' });
    assert.equal(pi.isError, undefined, pi.content[0]!.text);
    assert.equal(pi.details?.plan?.by, 'owner:pi');
    assert.ok(pi.details?.rule?.kind === 'rule' && pi.details.rule.text.endsWith('+test/y. Limit: pi limit'));
    assert.match(pi.content[0]!.text!, /Widened writes of a: \+test\/y; wrote /);
    assert.equal((await ops.verify({ cwd: r.cwd })).ok, true);
  } finally { await r.cleanup(); }
});

test('N3: refusals record nothing and leave the file unchanged', { timeout: 120_000 }, async () => {
  const { r, file } = await setup();
  try {
    const count = (await entriesOf(r.cwd)).length, as = ['--as', 'owner:pi'];
    const cases: [string[], number, RegExp][] = [
      [['amend', 'nope', '--writes', '+test/x', '--note', 'n'], 1, /Node nope does not exist/],
      [['amend', 'a', '--note', 'n'], 2, /at least one path to add/],
      [['amend', 'a', '--writes', 'test/x', '--note', 'n'], 2, /must start with \+/],
      [['amend', 'a', '--writes', '+test/x,test/y', '--note', 'n'], 2, /must start with \+/],
      [['amend', 'a', '--writes', '+', '--note', 'n'], 2, /empty path after \+/],
      [['amend', 'a', '--writes', '+test/x'], 2, /non-empty note/],
      [['amend', 'a', '--writes', '+test/x', '--note', '  '], 2, /non-empty note/],
      [['amend', 'a', '--writes', '+test/a', '--note', 'n'], 1, /already include test\/a; nothing to amend/],
    ];
    for (const [args, code, re] of cases) {
      const res = await cli(r.cwd, [...args, ...as]);
      assert.equal(res.code, code, `${args.join(' ')}: ${res.stderr}`);
      assert.match(res.stderr, re, args.join(' '));
      await untouched(r, file, count, PLAN);
    }
    // ops-level: an empty list and an empty note are refused too.
    await assert.rejects(ops.amend({ cwd: r.cwd, node: 'a', writes: [], note: 'n', as: owner, channel: 'delegated' }), /at least one path/);
    await assert.rejects(ops.amend({ cwd: r.cwd, node: 'a', writes: ['+x'], note: '', as: owner, channel: 'delegated' }), /non-empty note/);
    // The file has unrecorded edits (a value, not only a comment): refused.
    const edited = PLAN.replace('- test/b\n', '- test/b\n      - test/c\n');
    await writeFile(file, edited);
    const dirty = await cli(r.cwd, ['amend', 'a', '--writes', '+test/x', '--note', 'n', ...as]);
    assert.equal(dirty.code, 1);
    assert.match(dirty.stderr, /plan file has unrecorded edits/);
    await untouched(r, file, count, edited);
    // A comment-only edit is no plan change: amend proceeds and keeps it.
    const commented = `${PLAN}# trailing note\n`;
    await writeFile(file, commented);
    const ok = await cli(r.cwd, ['amend', 'a', '--writes', '+test/x', '--note', 'n', ...as]);
    assert.equal(ok.code, 0, ok.stderr);
    assert.match(await readFile(file, 'utf8'), /# trailing note\n$/);
    // The file cannot be written (its directory is read-only): refused before the append, nothing recorded.
    if (process.getuid?.() !== 0) {
      const now = await readFile(file, 'utf8'), n = (await entriesOf(r.cwd)).length;
      await chmod(r.root, 0o555);
      try {
        const ro = await cli(r.cwd, ['amend', 'a', '--writes', '+test/ro', '--note', 'n', ...as]);
        assert.equal(ro.code, 1, ro.stderr);
        assert.match(ro.stderr, /cannot write .*plan\.yaml: EACCES; nothing recorded/);
      } finally { await chmod(r.root, 0o755); }
      await untouched(r, file, n, now);
    }
  } finally { await r.cleanup(); }
});

test('N3: the plan source is the latest plan entry\'s path, else --plan; without either amend is refused', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    await seed(r.cwd);
    await ops.init({ cwd: r.cwd, plan: PLAN, as: owner, channel: 'flag' });
    const count = (await entriesOf(r.cwd)).length;
    const res = await cli(r.cwd, ['amend', 'a', '--writes', '+test/x', '--note', 'n', '--as', 'owner:pi']);
    assert.equal(res.code, 2);
    assert.match(res.stderr, /no plan entry records a plan file path; give the plan file/);
    assert.equal((await entriesOf(r.cwd)).length, count);
    // --plan names a file inside the repository (relative to cwd): it is edited and recorded with its repository path.
    await r.put('plans/owed.yaml', PLAN);
    const ok = await cli(r.cwd, ['amend', 'a', '--writes', '+test/x', '--note', 'n', '--plan', 'plans/owed.yaml', '--as', 'owner:pi']);
    assert.equal(ok.code, 0, ok.stderr);
    const plan = (await entriesOf(r.cwd)).findLast(e => e.kind === 'plan');
    assert.ok(plan?.kind === 'plan' && plan.path === 'plans/owed.yaml', JSON.stringify(plan));
    assert.match(await readFile(join(r.cwd, 'plans/owed.yaml'), 'utf8'), /test\/a, test\/x/);
    // The next amend finds the file through that entry's path.
    const next = await cli(r.cwd, ['amend', 'a', '--writes', '+test/y', '--note', 'n', '--as', 'owner:pi']);
    assert.equal(next.code, 0, next.stderr);
    assert.match(await readFile(join(r.cwd, 'plans/owed.yaml'), 'utf8'), /test\/a, test\/x, test\/y/);
  } finally { await r.cleanup(); }
});

test('N3: the edit keeps each list style: empty flow, quoted flow, block, and a node without writes', { timeout: 120_000 }, async () => {
  const text = `${PLAN}  - id: c   # no writes yet\n    deps: [a]\n  - id: d\n    deps: [a]\n    writes: [ ]\n  - {id: e, deps: [a], writes: ["test/e"]}\n`;
  const { r, file } = await setup(text);
  try {
    const count = (await entriesOf(r.cwd)).length;
    const edit = async (node: string, writes: string[]) => (await ops.amendPreview({ cwd: r.cwd, node, writes, note: 'n' })).next;
    assert.equal(await edit('d', ['+test/d', '+test/d 2']), text.replace('writes: [ ]', 'writes: [test/d, "test/d 2"]'));
    assert.equal(await edit('e', ['+test/e2']), text.replace('writes: ["test/e"]', 'writes: ["test/e", "test/e2"]'));
    assert.equal(await edit('b', ['+test/x', '+test/a*']), text.replace('      - test/b\n', '      - test/b\n      - test/x\n      - test/a*\n'));
    const c = await edit('c', ['+test/c']);
    assert.match(c, /- id: c +# no writes yet\n {4}deps: \[ ?a ?\]\n {4}writes:\n {6}- test\/c\n/);
    await untouched(r, file, count, text);
  } finally { await r.cleanup(); }
});

test('N3 (00:3x): amend retries like owed plan: the trunk moves once, amend succeeds with one plan, one carry and one rule; the file is written once', { timeout: 120_000 }, async (t: TestContext) => {
  const { r, file } = await setup();
  try {
    const sub = await submitted(r);
    const before = (await entriesOf(r.cwd)).length, original = Ledger.prototype.withLock;
    let inside = false, attempts = 0;
    t.mock.method(Ledger.prototype, 'withLock', async function(this: Ledger, ...args: Parameters<Ledger['withLock']>) {
      if (args[1] === undefined && !inside) {
        inside = true;
        try {
          if (++attempts === 1) {
            const old = await revParse(r.cwd, 'main'), tree = (await git(r.cwd, ['rev-parse', `${old}^{tree}`])).stdout.trim();
            const commit = (await git(r.cwd, ['commit-tree', tree, '-p', old, '-m', 'concurrent advance'], { env: identity })).stdout.trim();
            await git(r.cwd, ['update-ref', 'refs/heads/main', commit, old]);
            await ops.adopt({ cwd: r.cwd, as: owner, channel: 'delegated', note: 'concurrent trunk advance' });
          }
        } finally { inside = false; }
      }
      return original.apply(this, args);
    });
    const res = await ops.amend({ cwd: r.cwd, node: 'a', writes: ['+test/extra.txt'], note: 'limit', as: owner, channel: 'delegated' });
    t.mock.restoreAll();
    assert.equal(attempts, 2, 'one CAS retry');
    const es = (await entriesOf(r.cwd)).slice(before);
    assert.deepEqual(es.map(e => e.kind), ['adopt', 'plan', 'submit', 'rule'], 'the adopt, then exactly one plan, carry and rule');
    assert.ok(es[2]?.kind === 'submit' && es[2].carry === sub.seq);
    assert.ok(es[3]?.kind === 'rule' && es[3].text === `writes of a widened by plan #${es[1]!.seq}: +test/extra.txt. Limit: limit`);
    assert.equal(res.plan.seq, es[1]!.seq);
    assert.equal(await readFile(file, 'utf8'), PLAN.replace('writes: [test/a]', 'writes: [test/a, test/extra.txt]'), 'the path is added once');
    assert.deepEqual((await readdir(r.root)).filter(f => f.includes('owed-amend')), [], 'no temporary file left');
    assert.equal((await ops.verify({ cwd: r.cwd })).ok, true);
  } finally { t.mock.restoreAll(); await r.cleanup(); }
});
