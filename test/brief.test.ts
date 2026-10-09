import { test } from 'node:test';
import assert from 'node:assert/strict';
import { repo } from './helpers/repo.ts';
import { cli, commitAt } from './helpers/surface.ts';

// Shapes are declared locally so this file loads (and fails by assertion) on a base without `owed brief`.
interface Decision { node: string; obligation: string; blockedDownstream: number; command: string }
interface Merged { node: string; seq: number; measured: number; waived: number; reviewed: number; untested: number; measuredItems: string[]; waivedItems: string[]; untestedChanges: string[]; reviewers: string[] }
interface Rejected { seq: number; node: string; obligation: string; kind: string; failingObs?: number; reviewer?: string; rank?: number; clear: string }
interface Progress { node: string; phase: string; attempt: number; ageMs: number; submitAgeMs?: number }
interface Brief { decisions: Decision[]; merged: Merged[]; rejected: Rejected[]; inProgress: Progress[]; totals: Record<string, number> }
interface Obs { seq: number; kind: string; obligation?: string; verdict?: string }

const cjk = /[\u3000-\u303f\u3400-\u9fff\uff00-\uffef]/;
const check = (id: string) => ({ id, run: `test "$(cat ${id}.txt)" = good`, reads: [`${id}.txt`] });
const node = (id: string, extra: Record<string, unknown> = {}) => ({ id, writes: [`${id}.txt`], checks: [check(id)], ...extra });
// Plan order d before b: the owner queue must be sorted by blocked downstream nodes, not plan order.
const plan = {
  version: 1, trunk: 'main', closure: ['closure.txt'],
  invariants: [{ id: 'health', run: 'test ! -f broken.txt', reads: ['broken.txt'] }],
  nodes: [
    node('a', { review: { count: 1, min_rank: 1 } }),
    node('d', { writes: ['d.txt', 'closure.txt'] }),
    node('b', { deps: ['a'], writes: ['b.txt', 'closure.txt'] }),
    node('c', { deps: ['b'] }),
    node('e'), node('f'), node('g'), node('h'),
  ],
};

test('owed brief: owner decisions, merged counts, blocks, progress, totals and --since', { timeout: 300_000 }, async () => {
  const r = await repo();
  try {
    async function run(cwd: string, args: string[], code = 0) {
      const out = await cli(cwd, args);
      assert.equal(out.code, code, `${args.join(' ')}\n${out.stderr}\n${out.stdout}`);
      assert.doesNotMatch(out.stdout + out.stderr, cjk, `${args.join(' ')} output must be English`);
      return out.stdout;
    }
    const json = async <T>(cwd: string, args: string[], code = 0): Promise<T> => JSON.parse(await run(cwd, [...args, '--json'], code)) as T;
    const brief = (args: string[] = []) => json<Brief>(r.cwd, ['brief', ...args]);

    const pre = await cli(r.cwd, ['brief']);
    assert.equal(pre.code, 1, `brief before init is refused, not a usage error\n${pre.stderr}`);
    assert.match(pre.stderr, /Not initialized/);

    await r.put('plan.json', JSON.stringify(plan)); await r.put('closure.txt', 'v0\n'); await r.commit();
    await run(r.cwd, ['init', 'plan.json', '--i-am-owner']);
    assert.equal((await cli(r.cwd, ['--help'])).stdout.includes('brief [--since seq|ISO]'), true, 'help lists brief');

    const empty = await brief();
    assert.deepEqual([empty.decisions, empty.merged, empty.rejected, empty.inProgress], [[], [], [], []]);
    assert.deepEqual(empty.totals, { merged: 0, acceptedUnmerged: 0, blocked: 0, ready: 6, waiting: 2 });
    const emptyText = await run(r.cwd, ['brief']);
    assert.match(emptyText, /Needs your decision: none\n/);
    assert.match(emptyText, /Total: 0 merged, 0 accepted-unmerged, 0 blocked, 6 ready/);

    const dispatch = async (id: string) => (await json<{ worktree: string }>(r.cwd, ['dispatch', id])).worktree;
    const failSeq = (obs: Obs[], obligation: string) => obs.find(o => o.kind === 'obs' && o.obligation === obligation && o.verdict === 'fail')!.seq;

    // a: the check fails, the owner waives it with explicit risk acceptance, an independent reviewer approves, merge.
    const wa = await dispatch('a');
    await commitAt(wa, { 'a.txt': 'bad\n' }); await run(wa, ['submit', 'a']);
    const aFail = failSeq((await json<{ observations: Obs[] }>(r.cwd, ['attest', 'a'], 1)).observations, 'check:a');
    {
      const v = await brief();
      const block = v.rejected.find(b => b.node === 'a');
      assert.equal(block?.obligation, 'check:a'); assert.equal(block?.kind, 'exec'); assert.equal(block?.failingObs, aFail);
      assert.match(block!.clear, /owed submit a.*owed attest a/);
      assert.match(await run(r.cwd, ['brief']), new RegExp(`a/check:a failing obs #${aFail} → `));
    }
    await run(r.cwd, ['review', 'a', '--ok', '--rank', '1', '--as', 'reviewer:r1']);
    await run(r.cwd, ['waive', 'a', 'check:a', '--reason', 'environment accepted', '--accept-risk', String(aFail), '--i-am-owner']);
    const mergeSeq = (await json<{ entry: { seq: number } }>(r.cwd, ['merge', 'a'])).entry.seq;

    // d and b both touch the closure: closure-review is an owner-queue item. b has one downstream node (c), d none.
    for (const id of ['d', 'b']) {
      const w = await dispatch(id);
      await commitAt(w, { [`${id}.txt`]: 'good\n', 'closure.txt': `${id}\n` }); await run(w, ['submit', id]);
      await run(r.cwd, ['attest', id], 1);
    }
    await run(r.cwd, ['review', 'b', '--obligation', 'closure-review', '--block', '--rank', '2', '--as', 'reviewer:r2', '--note', 'closure change unexplained']);
    // e fails its check; f is only dispatched; h is accepted but unmerged; g stays ready; c waits on b.
    const we = await dispatch('e');
    await commitAt(we, { 'e.txt': 'bad\n' }); await run(we, ['submit', 'e']);
    const eFail = failSeq((await json<{ observations: Obs[] }>(r.cwd, ['attest', 'e'], 1)).observations, 'check:e');
    await dispatch('f');
    const wh = await dispatch('h');
    await commitAt(wh, { 'h.txt': 'good\n' }); await run(wh, ['submit', 'h']); await run(r.cwd, ['attest', 'h']);

    const v = await brief();
    // (1) owner decisions sorted by blocked downstream nodes, each with a discharging command.
    assert.deepEqual(v.decisions.map(d => [d.node, d.obligation, d.blockedDownstream]), [['b', 'closure-review', 1], ['d', 'closure-review', 0]]);
    assert.equal(v.decisions[0]!.command, 'owed review b --obligation closure-review --ok --rank 3 --as owner:human');
    // (2) merged: a waived check is counted as waived and never as measured.
    assert.equal(v.merged.length, 1);
    const m = v.merged[0]!;
    assert.equal(m.node, 'a'); assert.equal(m.seq, mergeSeq);
    assert.deepEqual(m.waivedItems, ['check:a']); assert.equal(m.waived, 1);
    assert.ok(!m.measuredItems.includes('check:a'), 'waived item shown as measured');
    assert.deepEqual(m.measuredItems, ['writes']); assert.equal(m.measured, 1);
    assert.equal(m.reviewed, 1); assert.deepEqual(m.reviewers, ['reviewer:r1']);
    assert.deepEqual(m.untestedChanges, ['a.txt']); assert.equal(m.untested, 1);
    // (3) active blocks: execution block with its failing obs, judgment block with its reviewer.
    const exec = v.rejected.find(b => b.node === 'e')!, judgment = v.rejected.find(b => b.node === 'b')!;
    assert.equal(v.rejected.length, 2);
    assert.equal(exec.obligation, 'check:e'); assert.equal(exec.failingObs, eFail);
    assert.equal(judgment.kind, 'judgment'); assert.equal(judgment.reviewer, 'reviewer:r2'); assert.equal(judgment.rank, 2); assert.equal(judgment.failingObs, undefined);
    assert.match(judgment.clear, /owed review b --obligation closure-review --ok --rank 2 --as reviewer:r2/);
    assert.match(judgment.clear, new RegExp(`--accept-risk ${judgment.seq}`));
    // (4) dispatched/submitted nodes with age; accepted h is not in progress.
    assert.deepEqual(v.inProgress.map(p => `${p.node}:${p.phase}`).sort(), ['b:submitted', 'd:submitted', 'e:submitted', 'f:dispatched']);
    for (const p of v.inProgress) { assert.ok(p.ageMs >= 0 && p.ageMs < 600_000, `${p.node} age`); assert.equal(p.submitAgeMs !== undefined, p.phase === 'submitted'); }
    // (5) totals.
    assert.deepEqual(v.totals, { merged: 1, acceptedUnmerged: 1, blocked: 2, ready: 1, waiting: 1 });

    const text = await run(r.cwd, ['brief']);
    const order = ['Needs your decision (2):', 'Merged (1):', 'Rejected or blocked (2):', 'In progress (4):', 'Total: 1 merged, 1 accepted-unmerged, 2 blocked, 1 ready'].map(h => text.indexOf(h));
    assert.ok(order.every(i => i >= 0), text);
    assert.deepEqual([...order].sort((x, y) => x - y), order, 'sections in order');
    const lines = text.split('\n');
    assert.match(lines.find(l => l.includes('b/closure-review'))!, /\[1 blocked downstream\].*→ owed review b --obligation closure-review --ok --rank 3 --as owner:human$/);
    assert.ok(lines.findIndex(l => l.includes('b/closure-review [')) < lines.findIndex(l => l.includes('d/closure-review [')));
    const mergedLine = lines.find(l => /^ {2}a #\d+ → /.test(l))!;
    assert.match(mergedLine, /: 1 measured, 1 waived \(check:a\), 1 reviewed, 1 untested change; reviewers: reviewer:r1$/);
    assert.match(text, new RegExp(`e/check:e failing obs #${eFail} → `));
    assert.match(text, /f dispatched \(attempt 1\): dispatched \d+s ago\n/);
    assert.match(text, /b submitted \(attempt 1\): dispatched \d+(s|m) ago, submitted \d+(s|m) ago/);

    // --since filters merges by seq or ISO time; invalid values are usage errors.
    assert.deepEqual((await brief(['--since', String(mergeSeq)])).merged, []);
    assert.deepEqual((await brief(['--since', String(mergeSeq - 1)])).merged.map(x => x.node), ['a']);
    assert.deepEqual((await brief(['--since', '2000-01-01T00:00:00Z'])).merged.map(x => x.node), ['a']);
    const later = await brief(['--since', '2999-01-01T00:00:00Z']);
    assert.deepEqual(later.merged, []); assert.equal(later.decisions.length, 2, 'since does not hide current decisions');
    assert.match(await run(r.cwd, ['brief', '--since', String(mergeSeq)]), new RegExp(`Brief \\(since #${mergeSeq}\\)\\nNeeds your decision \\(2\\):[\\s\\S]*\\nMerged: none\\n`));
    assert.equal((await cli(r.cwd, ['brief', '--since', 'yesterday-ish'])).code, 2);
    assert.equal((await cli(r.cwd, ['brief', 'extra'])).code, 2);
    assert.equal((await cli(r.cwd, ['brief', '--rerun'])).code, 2);

    // The printed decision command discharges the item (adding the weak flag only because the fixture has no TTY).
    const command = v.decisions[0]!.command.split(' ');
    assert.equal(command.shift(), 'owed');
    await run(r.cwd, [...command, '--i-am-owner']);
    const after = await brief();
    assert.deepEqual(after.decisions.map(d => d.node), ['d']);
    assert.ok(!after.rejected.some(b => b.node === 'b'), 'owner rank-3 review clears the rank-2 judgment block');
  } finally { await r.cleanup(); }
});
