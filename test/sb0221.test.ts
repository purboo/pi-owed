// SB1–SB5 (0.22.1): candidates that already contain trunk commits after their slot base, the rebase command, the
// answer reply and local clock times. Real git fixtures and the real ledger; dsa is a fake client.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as ops from '../src/ops.ts';
import * as git from '../src/git.ts';
import { Ledger } from '../src/ledger.ts';
import { Dsa, type SendResult } from '../src/dsa.ts';
import { writerLaunch } from '../src/drive.ts';
import { projectId, runId, runLabels } from '../src/reducer.ts';
import { rebasePending } from '../src/rebase-view.ts';
import { answerText } from '../src/answer.ts';
import { adoptPendingReason, mergeWaitSuffix } from '../src/adopt-wait.ts';
import { idleText } from '../src/drive-bg.ts';
import { lockActivityText } from '../src/ledger.ts';
import type { Draft, Entry, RunView } from '../src/types.ts';
import { repo } from './helpers/repo.ts';
import { cli, commitAt, identity } from './helpers/surface.ts';

const owner = { role: 'owner', id: 'test' } as const, parent = { role: 'parent', id: 'test' } as const;
const node = (id: string, writes: string[]) => ({ id, writes, checks: [], review: { count: 0, min_rank: 1 } });
const plan = { version: 1, trunk: 'main', closure: [], invariants: [], lease: false,
  nodes: [node('a', ['src/']), node('b', ['other/', 'docs/b']), node('c', ['more/'])], allow: [{ nodes: ['a'], writes: ['docs/'] }] };
const short = (sha: string) => sha.slice(0, 12);
const writer = (id: string) => ({ role: 'writer', id: `${id}#1` }) as const;
const g = (cwd: string, args: string[]) => git.git(cwd, args, { env: identity });

/** a is dispatched at slot base B; then b (other/b, docs/b — docs/ is allow-covered for a) merges: trunk T. */
async function fixture() {
  const r = await repo();
  await commitAt(r.cwd, { 'src/base': 'base', 'docs/base': 'base' });
  await ops.init({ cwd: r.cwd, plan: JSON.stringify(plan), as: owner, channel: 'flag' });
  const base = await git.revParse(r.cwd, 'main');
  const a = await ops.dispatch({ cwd: r.cwd, node: 'a', as: parent });
  const merge = async (id: string, files: Record<string, string>) => {
    const slot = await ops.dispatch({ cwd: r.cwd, node: id, as: parent }); await commitAt(slot.worktree, files);
    await ops.submit({ cwd: slot.worktree, node: id, as: writer(id) }); await ops.attest({ cwd: r.cwd, node: id });
    await ops.merge({ cwd: r.cwd, node: id, as: parent });
    return git.revParse(r.cwd, 'main');
  };
  const trunk = await merge('b', { 'other/b': 'b', 'docs/b': 'b' });
  const ledger = await Ledger.open(r.cwd), all = () => ledger.read();
  return { ...r, a, base, trunk, merge, ledger, all };
}
const grants = (es: Entry[]) => es.filter(e => e.kind === 'grant');
const writesObs = (es: Entry[]) => es.filter((e): e is Extract<Entry, { kind: 'obs' }> => e.kind === 'obs' && e.subject === 'a' && e.obligation === 'writes');

test('SB1: submit refuses a commit that contains trunk commits after its slot base, names the fix, records nothing', { timeout: 120_000 }, async () => {
  const f = await fixture();
  try {
    await commitAt(f.a.worktree, { 'src/a': 'a' });
    assert.equal((await g(f.a.worktree, ['rebase', 'main'])).code, 0, 'the writer rebased onto trunk without owed rebase');
    const head = await git.revParse(f.a.worktree, 'HEAD'), before = (await f.all()).length;
    await assert.rejects(ops.submit({ cwd: f.a.worktree, node: 'a', as: writer('a') }), (e: Error & { code?: string }) => {
      assert.equal(e.code, 'refused');
      assert.ok(e.message.includes(`slot base ${short(f.base)}`), e.message);
      assert.ok(e.message.includes(`latest ${short(f.trunk)}`), e.message);
      assert.ok(e.message.includes(`run owed rebase a, then in the slot worktree run \`git rebase --onto ${f.trunk} ${f.trunk}\`, then submit again`), e.message);
      return true;
    });
    const viaCli = await cli(f.a.worktree, ['submit', 'a', '--commit', head]);
    assert.equal(viaCli.code, 1, viaCli.stderr); assert.match(viaCli.stderr, /contains trunk commits after its slot base/);
    assert.equal((await f.all()).length, before, 'nothing recorded');
    // The named fix works: owed rebase, the exact command, submit; a's writes stay its own (no grant of docs/b).
    await ops.rebase({ cwd: f.cwd, node: 'a', as: parent });
    assert.equal((await g(f.a.worktree, ['rebase', '--onto', f.trunk, f.trunk])).code, 0);
    await ops.submit({ cwd: f.a.worktree, node: 'a', as: writer('a') });
    assert.equal((await ops.attest({ cwd: f.cwd, node: 'a' })).accepted, true);
    assert.equal(grants(await f.all()).length, 0);
  } finally { await f.cleanup(); }
});

test('SB1: a merge of trunk into the branch is refused too, and a candidate on its slot base still submits', { timeout: 120_000 }, async () => {
  const f = await fixture();
  try {
    const own = await commitAt(f.a.worktree, { 'src/a': 'a' });
    assert.equal((await g(f.a.worktree, ['merge', '--no-ff', '-m', 'merge trunk', 'main'])).code, 0);
    await assert.rejects(ops.submit({ cwd: f.a.worktree, node: 'a', as: writer('a') }), /submit refused: commit [0-9a-f]{12} contains trunk commits after its slot base/);
    await assert.rejects(ops.submit({ cwd: f.cwd, node: 'a', as: writer('a'), commit: 'owed/a/1' }), /contains trunk commits after its slot base/);
    await ops.submit({ cwd: f.cwd, node: 'a', as: writer('a'), commit: own });
    assert.equal((await ops.readState(f)).state.nodes.a!.candidate?.commit, own);
  } finally { await f.cleanup(); }
});

test('SB2: the rebase command never replays trunk commits the branch already merged', { timeout: 120_000 }, async () => {
  const f = await fixture();
  try {
    await commitAt(f.a.worktree, { 'src/a': 'a' });
    assert.equal((await g(f.a.worktree, ['merge', '--no-ff', '-m', 'merge trunk', 'main'])).code, 0);
    await commitAt(f.a.worktree, { 'src/a2': 'a2' });
    const t2 = await f.merge('c', { 'more/c': 'c' });
    const r = await ops.rebase({ cwd: f.cwd, node: 'a', as: parent });
    const command = `git rebase --onto ${t2} ${f.trunk}`;
    assert.ok(r.packet.includes(`First commit your work, then run: ${command}`), r.packet);
    const pending = await rebasePending((await ops.readState(f)).state, 'a');
    assert.equal(pending?.command, command);
    assert.equal((await g(f.a.worktree, command.split(' ').slice(1))).code, 0);
    const changed = (await g(f.a.worktree, ['diff', '--name-only', `${t2}..HEAD`])).stdout.trim().split('\n');
    assert.deepEqual(changed, ['src/a', 'src/a2']);
    const commits = (await g(f.a.worktree, ['log', '--format=%s', `${t2}..HEAD`])).stdout.trim().split('\n');
    assert.equal(commits.length, 2, commits.join('\n'));
    await ops.submit({ cwd: f.a.worktree, node: 'a', as: writer('a') });
    assert.equal((await ops.attest({ cwd: f.cwd, node: 'a' })).accepted, true);
  } finally { await f.cleanup(); }
});

test('SB3: a recorded candidate containing trunk commits fails writes with the cause and grants nothing', { timeout: 120_000 }, async () => {
  const f = await fixture();
  try {
    await commitAt(f.a.worktree, { 'src/a': 'a' });
    assert.equal((await g(f.a.worktree, ['rebase', 'main'])).code, 0);
    const head = await git.revParse(f.a.worktree, 'HEAD'), { state } = await ops.readState(f);
    // A submit recorded before 0.22.1 (no SB1 check): the same facts submit computes.
    const facts = await git.candidateFacts(f.cwd, state.plan, state.plan.nodes.find(n => n.id === 'a')!, f.base, head, 1);
    await f.ledger.withLock(() => f.ledger.append([{ kind: 'submit', by: 'writer:a#1', node: 'a', attempt: 1, facts } as Draft]));
    const r = await ops.attest({ cwd: f.cwd, node: 'a' });
    assert.equal(r.accepted, false);
    const es = await f.all(), obs = writesObs(es).at(-1)!;
    assert.equal(grants(es).length, 0, 'no grant of another node\'s paths');
    assert.equal(obs.verdict, 'fail');
    assert.ok(!obs.note!.includes('\n'), 'one line');
    assert.match(obs.note!, new RegExp(`^writes not judged: commit ${short(head)} contains trunk commits after its slot base ${short(f.base)} \\(latest ${short(f.trunk)}\\); run owed rebase a`));
    assert.ok(obs.note!.includes(`\`git rebase --onto ${f.trunk} ${f.trunk}\``), obs.note);
    assert.doesNotMatch(obs.note!, /other\/b|docs\/b|outside writes/);
  } finally { await f.cleanup(); }
});

class Client extends Dsa {
  views = new Map<string, RunView>(); fail = new Set<string>(); sends: { to: string; kind: string }[] = [];
  constructor() { super({ bin: '/bin/true' }); }
  override async describe(rid: string): Promise<RunView> { return this.views.get(rid) ?? { rid, state: 'sealed', status: 'ok' }; }
  override async send(_id: string, to: string, kind: string): Promise<SendResult> {
    this.sends.push({ to, kind });
    return this.fail.has(to) ? { outcome: 'rejected', reason: 'offline' } : { outcome: 'applied', spec_digest: 'digest' };
  }
}

test('SB4: answer prints one line, a second only for other calls reached or missed (with the exact retry), never the text', { timeout: 120_000 }, async () => {
  const r = await repo();
  try {
    await r.put('seed', 'x'); await r.commit();
    await ops.init({ cwd: r.cwd, as: owner, channel: 'delegated', plan: JSON.stringify({ version: 1, trunk: 'main', closure: [], invariants: [], lease: false, nodes: [node('a', ['a.txt'])] }), measure: false });
    await ops.dispatch({ cwd: r.cwd, as: parent, node: 'a' });
    const launch = async (role: 'writer' | 'reviewer') => {
      const s = (await ops.readState(r)).state, project = projectId(s), rid = runId(project, 'a', 1, role, role === 'reviewer' ? 1 : undefined);
      const built = role === 'writer' ? writerLaunch(s, 'a', project) : { spec: JSON.stringify({ model: 'm' }), labels: runLabels(project, 'a', 1, role) };
      return (await ops.launch({ ...r, as: parent, node: 'a', attempt: 1, role, rid, spec: built.spec, labels: built.labels, rulings: 0 })).entry.rid;
    };
    const w = await launch('writer'), dsa = new Client();
    dsa.views.set(w, { rid: w, state: 'asking', questions: [{ qid: 'q1', rev: 1, question: 'Which API?' }] });
    const alone = answerText('a', await ops.answer({ ...r, as: parent, node: 'a', text: 'Use SECRET-v2', dsa }));
    assert.match(alone, new RegExp(`^answered writer question q1 of ${w} \\(rule #\\d+\\); the call resumes now$`));
    const rev = await launch('reviewer');
    dsa.views.set(rev, { rid: rev, state: 'running' });
    dsa.views.set(w, { rid: w, state: 'asking', questions: [{ qid: 'q2', rev: 1, question: 'Which file?' }] });
    const reached = answerText('a', await ops.answer({ ...r, as: parent, node: 'a', text: 'Use SECRET-file', dsa })).split('\n');
    assert.equal(reached.length, 2, reached.join('\n'));
    assert.match(reached[0]!, /^answered writer question q2 of .* the call resumes now$/);
    assert.equal(reached[1], 'the ruling also reached 1 other running call (a/reviewer)');
    dsa.fail.add(rev);
    dsa.views.set(w, { rid: w, state: 'asking', questions: [{ qid: 'q3', rev: 1, question: 'Which name?' }] });
    const missed = answerText('a', await ops.answer({ ...r, as: parent, node: 'a', text: 'Use SECRET-name', dsa })).split('\n');
    assert.equal(missed.length, 2, missed.join('\n'));
    assert.match(missed[1]!, new RegExp(`^the ruling did not reach a/reviewer \\(${rev}\\): rejected: offline; retry exactly: owed answer 'a' --rid '${w}' --qid 'q3' --rev 1 -- 'Use SECRET-name'$`));
    for (const text of [alone, ...reached]) assert.doesNotMatch(text, /SECRET|follow-up/);
  } finally { await r.cleanup(); }
});

test('SB5: every HH:MM time in text is local time from one formatter', async () => {
  const prior = process.env.TZ; process.env.TZ = 'Asia/Shanghai';
  try {
    const { clockTime } = await import('../src/clock.ts');
    const since = '2026-10-15T09:35:00.000Z', now = Date.parse('2026-10-15T12:00:00.000Z');
    assert.equal(clockTime(since, now), '17:35');
    assert.equal(clockTime(since, Date.parse('2026-10-17T12:00:00.000Z')), '2026-10-15 17:35');
    const recent = new Date(Date.now() - 60_000).toISOString(), local = clockTime(recent);
    assert.match(local, /^\d\d:\d\d$|^\d{4}-\d\d-\d\d \d\d:\d\d$/);
    assert.equal(adoptPendingReason({ pid: 1, host: 'h', commit: 'c', since: recent, until: recent }), `adopt (pending since ${local})`);
    assert.equal(mergeWaitSuffix('driver-internal job (x)', recent), ` since ${local}`);
    assert.equal(idleText(recent), `idle, waiting for ledger changes since ${local}`);
    assert.equal(lockActivityText({ pid: 1, host: 'h', token: 't', ts: recent, activity: 'merge a' } as Parameters<typeof lockActivityText>[0]), ` (merge a since ${local})`);
    assert.notEqual(local.slice(-5), recent.slice(11, 16), 'local time differs from UTC in this zone');
  } finally { if (prior === undefined) delete process.env.TZ; else process.env.TZ = prior; }
});
