import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Dsa, DsaError, dsaAvailable, dsaBin, toRunView, type RunView as DsaRunView } from '../src/dsa.ts';
import type { RunView } from '../src/types.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-dsa.mjs', import.meta.url));
const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');

async function fake() {
  const root = await mkdtemp(join(tmpdir(), 'owed-dsa-test-')), dir = join(root, 'dsa'), work = join(root, 'work');
  await mkdir(join(dir, 'agents'), { recursive: true }); await mkdir(work);
  const dsa = new Dsa({ bin: FAKE, env: { FAKE_DSA_DIR: dir }, waitMs: 1000, timeoutMs: 30_000 });
  return {
    root, dir, work, dsa,
    agent: (name: string, body: string) => writeFile(join(dir, 'agents', `${name}.sh`), body),
    fault: (lines: string) => writeFile(join(dir, 'faults'), lines),
    log: async () => (await readFile(join(dir, 'log.jsonl'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map(l => JSON.parse(l) as Record<string, unknown>),
    hook: (...args: string[]) => execFileSync(FAKE, args, { env: { ...process.env, FAKE_DSA_DIR: dir } }),
    spec: (o: Record<string, unknown> = {}) => JSON.stringify({ agent: 'worker', task: 't', cwd: work, ...o }),
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
const labels = (node: string, role = 'writer') => ({ owed: 'p1', node, attempt: '1', role });

test('run: exact spec bytes, created, idempotent retry, scripted agent cwd and env', async () => {
  const f = await fake();
  try {
    await f.agent('a-writer', 'echo "$FAKE_RID $FAKE_GEN $FAKE_KIND" > out.txt; pwd >> out.txt; echo done-a\n');
    // Odd formatting and non-ASCII must survive byte for byte (no re-serialization).
    const bytes = `{ "task" : "fix — ü 🐛",\n\t"agent":"worker",  "cwd": ${JSON.stringify(f.work)} }\n`;
    const r1 = await f.dsa.run('owed:p1:a:1:writer', bytes, labels('a'));
    assert.equal(r1.outcome, 'applied');
    assert.ok(r1.outcome === 'applied' && r1.created);
    assert.equal(r1.outcome === 'applied' && r1.spec_digest, sha(Buffer.from(bytes)));
    assert.deepEqual(await readFile(join(f.dir, 'specs', 'owed:p1:a:1:writer')), Buffer.from(bytes));
    assert.equal(await readFile(join(f.work, 'out.txt'), 'utf8'), `owed:p1:a:1:writer 1 run\n${f.work}\n`);
    const r2 = await f.dsa.run('owed:p1:a:1:writer', Buffer.from(bytes), labels('a'));
    assert.deepEqual(r2, { ...r1, created: false });
    const runs = (await f.log()).filter(e => e.cmd === 'run');
    assert.equal(runs.length, 2); assert.equal(runs.filter(e => e.executed).length, 1);
    const v = await f.dsa.describe('owed:p1:a:1:writer');
    assert.equal(v.state, 'sealed'); assert.equal(v.status, 'ok'); assert.deepEqual(v.labels, labels('a')); assert.equal(v.spec_digest, sha(bytes));
  } finally { await f.cleanup(); }
});

test('run: --cwd is used when the spec names none', async () => {
  const f = await fake();
  try {
    await f.agent('c-writer', 'pwd > where.txt\n');
    const r = await f.dsa.run('rid-cwd', JSON.stringify({ agent: 'worker', task: 't' }), labels('c'), f.work);
    assert.equal(r.outcome, 'applied');
    assert.equal(await readFile(join(f.work, 'where.txt'), 'utf8'), `${f.work}\n`);
  } finally { await f.cleanup(); }
});

test('run: request-conflict for other bytes, labels or cwd; nothing is re-recorded', async () => {
  const f = await fake();
  try {
    await f.agent('a-writer', 'true\n');
    const bytes = f.spec();
    const first = await f.dsa.run('rid-1', bytes, labels('a'));
    assert.equal(first.outcome, 'applied');
    for (const [spec, l] of [[f.spec({ task: 'other' }), labels('a')], [bytes, labels('b')], [bytes + ' ', labels('a')], [bytes, undefined]] as const) {
      const r = await f.dsa.run('rid-1', spec, l);
      assert.equal(r.outcome, 'conflict');
      assert.equal(r.outcome === 'conflict' && r.spec_digest, sha(bytes));
      assert.equal(r.outcome === 'conflict' && r.state, 'sealed');
    }
    const other = await f.dsa.run('rid-cwd', JSON.stringify({ agent: 'worker', task: 't' }), undefined, f.work);
    assert.equal(other.outcome, 'applied');
    assert.equal((await f.dsa.run('rid-cwd', JSON.stringify({ agent: 'worker', task: 't' }), undefined, f.root)).outcome, 'conflict');
    assert.equal(await readFile(join(f.dir, 'specs', 'rid-1'), 'utf8'), bytes);
  } finally { await f.cleanup(); }
});

test('run: rejected outcomes carry the reason', async () => {
  const f = await fake();
  try {
    const notJson = await f.dsa.run('rid-bad', '{not json', labels('a'));
    assert.equal(notJson.outcome, 'rejected'); assert.match(notJson.outcome === 'rejected' ? notJson.reason : '', /not JSON/);
    const noAgent = await f.dsa.run('rid-noagent', JSON.stringify({ task: 't' }), labels('a'));
    assert.equal(noAgent.outcome, 'rejected');
    assert.equal(noAgent.outcome === 'rejected' && noAgent.spec_digest, sha(JSON.stringify({ task: 't' })));
    // A decided rejection is final for that id.
    assert.deepEqual(await f.dsa.run('rid-noagent', JSON.stringify({ task: 't' }), labels('a')), noAgent);
    assert.equal((await f.dsa.describe('rid-noagent')).status, 'rejected');
    assert.equal((await f.dsa.run('bad id!', f.spec())).outcome, 'rejected');
    assert.equal((await f.dsa.run('rid-labels', f.spec(), { nested: { x: 1 } } as unknown as Record<string, string>)).outcome, 'rejected');
  } finally { await f.cleanup(); }
});

test('run: pending (75) without, with and after recording; retries converge to one execution', async () => {
  const f = await fake();
  try {
    await f.agent('a-writer', 'echo ran >> runs.txt\n');
    const bytes = f.spec();
    await f.fault('run 75 none\n');
    assert.deepEqual(await f.dsa.run('r-none', bytes, labels('a')), { outcome: 'pending', reason: 'fault: none' });
    assert.equal((await f.dsa.describe('r-none')).state, 'absent');
    await f.fault('run 75 record\n');
    assert.equal((await f.dsa.run('r-rec', bytes, labels('a'))).outcome, 'pending');
    assert.equal((await f.dsa.describe('r-rec')).state, 'queued');
    const retried = await f.dsa.run('r-rec', bytes, labels('a'));
    assert.equal(retried.outcome === 'applied' && retried.created, true);
    await f.fault('run 75 apply\n');
    assert.equal((await f.dsa.run('r-app', bytes, labels('a'))).outcome, 'pending');
    assert.equal((await f.dsa.describe('r-app')).state, 'sealed');
    const again = await f.dsa.run('r-app', bytes, labels('a'));
    assert.equal(again.outcome === 'applied' && again.created, false);
    assert.equal(await readFile(join(f.work, 'runs.txt'), 'utf8'), 'ran\nran\n');
    const log = await f.log();
    for (const id of ['r-rec', 'r-app']) assert.equal(log.filter(e => e.request === id && e.executed).length, 1, id);
    // A send to a run whose request is recorded but undecided is pending too, and records nothing.
    await f.fault('run 75 record\n');
    await f.dsa.run('r-later', bytes, labels('a'));
    assert.equal((await f.dsa.send('s-early', 'r-later', 'steer', 'x')).outcome, 'pending');
    assert.equal((await f.dsa.describe('s-early')).state, 'absent');
  } finally { await f.cleanup(); }
});

test('describe: absent, running, asking, sealed ok/failed/unknown, fenced, pruned', async () => {
  const f = await fake();
  try {
    assert.deepEqual(await f.dsa.describe('nothing'), { rid: 'nothing', state: 'absent' });
    await f.dsa.run('r-run', f.spec(), labels('none'));
    const running = await f.dsa.describe('r-run');
    assert.equal(running.state, 'running'); assert.equal(running.status, undefined);
    await f.agent('ask-writer', 'echo "ASK: which base?"\n');
    await f.dsa.run('r-ask', f.spec(), labels('ask'));
    const asking = await f.dsa.describe('r-ask');
    assert.equal(asking.state, 'asking');
    assert.equal(asking.questions?.length, 1);
    assert.equal(asking.questions?.[0]?.question, 'which base?'); assert.equal(asking.questions?.[0]?.rev, 1); assert.ok(asking.questions?.[0]?.qid);
    await f.agent('bad-writer', 'echo partial; echo boom >&2; exit 3\n');
    await f.dsa.run('r-bad', f.spec(), labels('bad'));
    const failed = await f.dsa.describe('r-bad');
    assert.equal(failed.state, 'sealed'); assert.equal(failed.status, 'failed'); assert.match(failed.error ?? '', /exit 3: boom/);
    await f.agent('lost-writer', 'echo "FENCE: process-died"; echo "STATUS: unknown"\n');
    await f.dsa.run('r-lost', f.spec(), labels('lost'));
    const lost = await f.dsa.describe('r-lost');
    assert.equal(lost.state, 'sealed'); assert.equal(lost.status, 'unknown');
    assert.equal(lost.lastFence?.reason, 'process-died'); assert.equal(typeof lost.lastFence?.at, 'number');
    await f.agent('ok-writer', 'true\n');
    await f.dsa.run('r-ok', f.spec(), labels('ok'));
    f.hook('fake-prune', 'r-ok');
    const pruned = await f.dsa.describe('r-ok');
    assert.equal(pruned.state, 'pruned'); assert.equal(pruned.status, 'ok');
  } finally { await f.cleanup(); }
});

test('send: follow-up runs the generation script; steer/answer; idempotent; conflict; exact message bytes', async () => {
  const f = await fake();
  try {
    await f.agent('a-writer', 'echo first\n');
    await f.agent('a-writer-2', 'printf "%s|%s|%s" "$FAKE_GEN" "$FAKE_KIND" "$FAKE_MESSAGE" > gen2.txt; exit 1\n');
    await f.dsa.run('rid-a', f.spec(), labels('a'));
    const steerLate = await f.dsa.send('s-steer-late', 'rid-a', 'steer', 'hold on');
    assert.equal(steerLate.outcome, 'rejected'); assert.match(steerLate.outcome === 'rejected' ? steerLate.reason : '', /follow-up/);
    const message = 'commit your work — and run `owed submit a`\n';
    const s1 = await f.dsa.send('rid-a:follow-up:7', 'rid-a', 'follow-up', message);
    assert.equal(s1.outcome, 'applied');
    assert.equal(s1.outcome === 'applied' && s1.generation, 2);
    assert.equal(await readFile(join(f.work, 'gen2.txt'), 'utf8'), `2|follow-up|${message}`);
    assert.equal(await readFile(join(f.dir, 'messages', 'rid-a:follow-up:7'), 'utf8'), message);
    const v = await f.dsa.describe('rid-a');
    assert.equal(v.state, 'sealed'); assert.equal(v.status, 'failed');
    assert.deepEqual(await f.dsa.send('rid-a:follow-up:7', 'rid-a', 'follow-up', message), s1);
    assert.equal((await f.log()).filter(e => e.request === 'rid-a:follow-up:7' && e.executed).length, 1);
    const conflict = await f.dsa.send('rid-a:follow-up:7', 'rid-a', 'follow-up', message + 'x');
    assert.equal(conflict.outcome, 'conflict'); assert.equal(conflict.outcome === 'conflict' && conflict.spec_digest, s1.outcome === 'applied' ? s1.spec_digest : '');
    // The id namespace is shared between run and send.
    assert.equal((await f.dsa.run('rid-a:follow-up:7', f.spec())).outcome, 'conflict');
    assert.equal((await f.dsa.send('s-unknown', 'nope', 'follow-up', 'x')).outcome, 'rejected');

    await f.agent('q-writer', 'if [ "$FAKE_KIND" = answer ]; then echo "got $FAKE_MESSAGE"; else echo "ASK: base?"; fi\n');
    await f.dsa.run('rid-q', f.spec(), labels('q'));
    const steer = await f.dsa.send('s-steer', 'rid-q', 'steer', 'note');
    assert.equal(steer.outcome, 'applied');
    const asked = await f.dsa.describe('rid-q');
    const ans = await f.dsa.send('s-ans', 'rid-q', 'answer', 'main', { qid: asked.questions![0]!.qid, rev: asked.questions![0]!.rev });
    assert.equal(ans.outcome, 'applied');
    const answered = await f.dsa.describe('rid-q');
    assert.equal(answered.state, 'sealed'); assert.equal(answered.status, 'ok');
    // Follow-up to a run that is not finished is refused.
    await f.dsa.run('rid-live', f.spec(), labels('live'));
    assert.equal((await f.dsa.send('s-live', 'rid-live', 'follow-up', 'x')).outcome, 'rejected');
  } finally { await f.cleanup(); }
});

test('send: pending faults converge to one application', async () => {
  const f = await fake();
  try {
    await f.agent('a-writer', 'echo x >> calls.txt\n');
    await f.dsa.run('rid-a', f.spec(), labels('a'));
    await f.fault('send 75 apply\n');
    assert.equal((await f.dsa.send('fu-1', 'rid-a', 'follow-up', 'go')).outcome, 'pending');
    const retry = await f.dsa.send('fu-1', 'rid-a', 'follow-up', 'go');
    assert.equal(retry.outcome === 'applied' && retry.generation, 2);
    await f.fault('send 75 record\n');
    assert.equal((await f.dsa.send('fu-2', 'rid-a', 'follow-up', 'go')).outcome, 'pending');
    const second = await f.dsa.send('fu-2', 'rid-a', 'follow-up', 'go');
    assert.equal(second.outcome === 'applied' && second.generation, 3);
    assert.equal(await readFile(join(f.work, 'calls.txt'), 'utf8'), 'x\nx\nx\n');
    await f.fault('send 1\n');
    assert.deepEqual(await f.dsa.send('fu-3', 'rid-a', 'follow-up', 'go'), { outcome: 'rejected', reason: 'fault' });
  } finally { await f.cleanup(); }
});

test('events: head, paging with cursors and labels, expiry, pending, invalid', async () => {
  const f = await fake();
  try {
    const start = await f.dsa.events();
    assert.equal(start.outcome, 'applied');
    const cursor0 = start.outcome === 'applied' ? start.head : '';
    assert.deepEqual(start.outcome === 'applied' && start.events, []);
    await f.agent('a-writer', 'true\n'); await f.agent('b-writer', 'echo "ASK: why?"\n');
    await f.dsa.run('rid-a', f.spec(), labels('a'));
    await f.dsa.run('rid-b', f.spec(), { owed: 'other', node: 'b', role: 'writer' });
    const all: { id: string; type: string; labels?: Record<string, string>; request?: string }[] = [];
    let since = cursor0, pages = 0;
    for (;;) {
      const page = await f.dsa.events(since, 2);
      assert.equal(page.outcome, 'applied');
      if (page.outcome !== 'applied') break;
      pages++; all.push(...page.events); since = page.head;
      assert.ok(page.events.length <= 2);
      if (page.more) assert.equal(page.head, page.events.at(-1)!.cursor);
      if (!page.more) break;
    }
    assert.ok(pages >= 3);
    assert.deepEqual(all.map(e => `${e.request}:${e.type}`), ['rid-a:submitted', 'rid-a:started', 'rid-a:sealed', 'rid-a:workflow-done', 'rid-b:submitted', 'rid-b:started', 'rid-b:asking']);
    assert.equal(new Set(all.map(e => e.id)).size, all.length);
    assert.equal(all.filter(e => e.labels?.owed === 'p1').length, 4);
    const tail = await f.dsa.events(since);
    assert.deepEqual(tail.outcome === 'applied' && [tail.events.length, tail.more, tail.head], [0, false, since]);

    const [epoch] = since.split(':');
    for (const bad of ['other:0', `${epoch}:999999`]) {
      const r = await f.dsa.events(bad);
      assert.equal(r.outcome, 'expired', bad);
      assert.deepEqual(r.outcome === 'expired' && [r.head, r.oldest], [since, `${epoch}:0`]);
    }
    f.hook('fake-compact', '3');
    const expired = await f.dsa.events(cursor0);
    assert.equal(expired.outcome, 'expired');
    const oldest = expired.outcome === 'expired' ? expired.oldest : '';
    assert.notEqual(oldest, `${epoch}:0`);
    const resumed = await f.dsa.events(oldest);
    assert.deepEqual(resumed.outcome === 'applied' && resumed.events.map(e => e.type), ['workflow-done', 'submitted', 'started', 'asking']);
    await f.fault('events 4\n');
    assert.equal((await f.dsa.events(since)).outcome, 'expired');
    await f.fault('events 75\n');
    assert.equal((await f.dsa.events(since)).outcome, 'pending');
    assert.equal((await f.dsa.events('garbage')).outcome, 'rejected');
  } finally { await f.cleanup(); }
});

test('client: missing binary throws, timeout is pending for requests, unexpected exits keep stderr', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owed-dsa-bin-'));
  try {
    const missing = new Dsa({ bin: join(root, 'nope') });
    await assert.rejects(missing.run('r', '{}'), DsaError);
    await assert.rejects(missing.describe('r'), DsaError);
    assert.equal(dsaAvailable(join(root, 'nope')), false);
    const slow = join(root, 'slow'); await writeFile(slow, '#!/bin/sh\nsleep 5\n'); await chmod(slow, 0o755);
    assert.equal(dsaAvailable(slow), true);
    const s = new Dsa({ bin: slow, timeoutMs: 200 });
    const t0 = Date.now();
    assert.deepEqual(await s.run('r', '{}'), { outcome: 'pending', reason: 'timeout' });
    assert.deepEqual(await s.send('s', 'r', 'steer', 'x'), { outcome: 'pending', reason: 'timeout' });
    await assert.rejects(s.describe('r'), /timed out/);
    assert.ok(Date.now() - t0 < 4500);
    const crash = join(root, 'crash'); await writeFile(crash, '#!/bin/sh\necho "kaboom" >&2\nexit 9\n'); await chmod(crash, 0o755);
    await assert.rejects(new Dsa({ bin: crash }).run('r', '{}'), (e: unknown) => e instanceof DsaError && e.exit === 9 && /kaboom/.test(e.stderr));
    // Arguments are an argv array: shell metacharacters reach the program untouched.
    const echo = join(root, 'echo'); await writeFile(echo, '#!/bin/sh\nprintf \'{"request":"%s","wid":"w","created":true,"spec_digest":"%s"}\\n\' "$3" "$(cat | sha256sum | cut -d" " -f1)"\n'); await chmod(echo, 0o755);
    const r = await new Dsa({ bin: echo }).run('$(touch pwned);x', 'bytes\n');
    assert.deepEqual(r, { outcome: 'applied', wid: 'w', created: true, spec_digest: sha('bytes\n') });
    assert.equal(dsaBin({ OWED_DSA: '/x/dsa' }), '/x/dsa');
    assert.match(dsaBin({}), /\.pi\/durable-subagents\/bin\/pi-durable-subagents$/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('toRunView maps real describe replies', () => {
  assert.deepEqual(toRunView('r', { state: 'pending', request: 'r', spec_digest: 'd' }), { rid: 'r', state: 'queued', spec_digest: 'd' });
  assert.deepEqual(toRunView('r', { state: 'rejected', reason: 'unknown agent' }), { rid: 'r', state: 'sealed', status: 'rejected', error: 'unknown agent' });
  assert.deepEqual(toRunView('r', { state: 'pruned', wid: 'w', pruned: { endedAt: 1 } }), { rid: 'r', wid: 'w', state: 'pruned', status: 'unknown' });
  assert.equal(toRunView('r', { state: 'pruned', pruned: { status: 'failed', endedAt: 1 } }).status, 'failed');
  assert.equal(toRunView('r', { state: 'mystery' }).state, 'running');
  assert.equal(toRunView('r', { state: 'sealed', status: 'done', calls: [] }).status, 'ok');
  assert.equal(toRunView('r', { state: 'sealed', status: 'failed', calls: [{ status: 'ok' }, { status: 'timeout', error: 'slow' }] }).status, 'timeout');
  const v = toRunView('r', { state: 'asking', status: 'running', calls: [{ key: 'main', gen: 1, phase: 'running' }],
    questions: [{ qid: 'q', rev: 2, to: 'w/main', call: 'w@1/main@1', text: 'why?' }], lastFence: { at: 5, exec: 'e', reason: 'orchestrator-crash' } });
  assert.deepEqual(v, { rid: 'r', state: 'asking', questions: [{ qid: 'q', rev: 2, question: 'why?', to: 'w/main' }], lastFence: { reason: 'orchestrator-crash', at: 5, exec: 'e' } });
});

test('client (D9): a missing binary reports "cannot run … ENOENT", never "dsa exited -2"', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owed-dsa-missing-'));
  try {
    const missing = new Dsa({ bin: join(root, 'nope') });
    for (const call of [() => missing.run('r', '{}'), () => missing.send('s', 'r', 'steer', 'x'), () => missing.events('c'), () => missing.describe('r')]) {
      await assert.rejects(call(), (e: unknown) => e instanceof DsaError && /^cannot run .*nope: .*ENOENT/.test(e.message) && !/exited/.test(e.message));
    }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('client (D9): a dsa child killed by a signal (not our timeout) is pending: retry the same id and bytes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'owed-dsa-signal-'));
  try {
    // It even prints a well-formed reply first: an exit by signal is never read as applied.
    const killed = join(root, 'killed');
    await writeFile(killed, '#!/bin/sh\ncat >/dev/null\necho \'{"request":"r","wid":"w","created":true,"spec_digest":"d"}\'\nkill -9 $$\n'); await chmod(killed, 0o755);
    const d = new Dsa({ bin: killed, timeoutMs: 20_000 });
    assert.deepEqual(await d.run('r', '{}'), { outcome: 'pending', reason: 'signal SIGKILL' });
    assert.deepEqual(await d.send('s', 'r', 'follow-up', 'x'), { outcome: 'pending', reason: 'signal SIGKILL' });
    assert.deepEqual(await d.events('c', 10), { outcome: 'pending', reason: 'signal SIGKILL' });
    await assert.rejects(d.describe('r'), DsaError, 'describe has no pending outcome: it fails and the driver waits');
    const term = join(root, 'term'); await writeFile(term, '#!/bin/sh\nkill -TERM $$\n'); await chmod(term, 0o755);
    assert.deepEqual(await new Dsa({ bin: term }).run('r', '{}'), { outcome: 'pending', reason: 'signal SIGTERM' });
    // A normal non-zero exit is still an error.
    const nine = join(root, 'nine'); await writeFile(nine, '#!/bin/sh\nexit 9\n'); await chmod(nine, 0o755);
    await assert.rejects(new Dsa({ bin: nine }).run('r', '{}'), /dsa exited 9/);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('RunView has one definition (src/types.ts) re-exported by src/dsa.ts', () => {
  const v: RunView = toRunView('r', { state: 'sealed', status: 'done', lastFence: { at: 7, reason: 'x' } });
  const same: DsaRunView = v, back: RunView = same;
  assert.deepEqual(back, { rid: 'r', state: 'sealed', status: 'ok', lastFence: { reason: 'x', at: 7 } });
});
