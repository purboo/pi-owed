// DL1-DL5: the session's delegate routes node wakes to exact forks of the session and reports the settle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Delegate, type DelegateKind, type DelegatePlan, type DelegateStage, type DelegateWake } from '../src/watch.ts';
import { forkPrincipal } from '../src/stage.ts';

const FAKE = fileURLToPath(new URL('./fixtures/fake-dsa.mjs', import.meta.url));

interface Launch { wake: DelegateWake; id: string; labels: Record<string, string>; spec: Record<string, unknown> }

interface Harness {
  delegate: Delegate;
  launches: Launch[];
  delivered: string[];
  /** The stage a fork recorded (undefined: the fork staged nothing). */
  staged: Map<string, DelegateStage>;
  /** The state of a launched fork. */
  state: Map<string, { state: string; status?: string; error?: string; exact?: { mode: string; reason?: string; firstCacheRatio?: number; costUsd?: number } }>;
  plan: DelegatePlan | undefined;
  session: string | undefined;
  pending: { wake: DelegateWake; id: string }[];
  launches_ok: boolean;
}

function harness(o: { plan?: DelegatePlan; session?: string } = {}): Harness {
  const launches: Launch[] = [], delivered: string[] = [];
  const staged = new Map<string, DelegateStage>();
  const state = new Map<string, { state: string; status?: string; error?: string; exact?: { mode: string; reason?: string; firstCacheRatio?: number; costUsd?: number } }>();
  const pending: { wake: DelegateWake; id: string }[] = [];
  const h: Harness = {
    delegate: undefined as unknown as Delegate, launches, delivered, staged, state, plan: o.plan, session: o.session ?? 'pi-session-1', pending, launches_ok: true,
  };
  h.delegate = new Delegate({
    facts: async () => h.plan,
    session: () => h.session,
    supported: async () => true,
    launch: async (l) => {
      launches.push(l);
      if (!h.launches_ok) return { ok: false, reason: 'request-conflict' };
      state.set(l.id, { state: 'running' });
      pending.push({ wake: l.wake, id: l.id });
      return { ok: true, id: l.id };
    },
    inspect: async (id) => state.get(id) ?? { state: 'absent' },
    stages: async () => [...staged.values()],
    deliver: (text) => { delivered.push(text); },
    store: {
      load: async () => pending.map(p => ({ wake: p.wake, id: p.id })),
      save: async (list) => { pending.length = 0; pending.push(...list); },
    },
  });
  return h;
}

const wake = (node: string, kind: DelegateKind = 'question', text = `Needs you: ${node} — decide the run's open question`): DelegateWake =>
  ({ node, kind, text, id: `${node}:${kind}:${text}` });

test('DL1: a delegatable wake becomes one exact fork with the origin session, labels and no model', async () => {
  const h = harness({ plan: { on: ['question'], max: 4, budget: { rounds: 3, wall_s: 90 }, aActs: ['preferred-answer'], seq: 12, planSha: 'abc123' } });
  const rest = await h.delegate.take([wake('a')]);
  assert.deepEqual(rest, [], 'the delegated wake is not delivered as a turn');
  assert.equal(h.launches.length, 1);
  const launch = h.launches[0]!;
  assert.equal(launch.spec.agent, 'delegate');
  assert.equal(launch.spec.context, 'exact');
  assert.equal(launch.spec.model, undefined, 'an exact call names no model');
  assert.equal(launch.spec.timeoutMs, 90_000, 'the wall budget bounds the call');
  assert.equal(launch.labels.owed_fork, 'a');
  assert.equal(launch.labels.owed_wake, launch.wake.id);
  assert.match(String(launch.spec.task), /read_through_seq/);
  assert.match(String(launch.spec.task), /a/);
});

test('DL1: the fork task is a packet with the node, the wake, the seq, the plan sha, the A acts and the rules', async () => {
  const h = harness({ plan: { on: ['question'], max: 4, aActs: ['preferred-answer', 'infra-resume'], seq: 12, planSha: 'abc123' } });
  await h.delegate.take([wake('a', 'question', 'Needs you: a — decide')]);
  const task = String(h.launches[0]!.spec.task);
  for (const part of ['a', 'Needs you: a — decide', 'read_through_seq', 'plan sha256', 'preferred-answer', 'infra-resume', 'owed stage', 'never fork', 'dsa command calls', 'stop after staging']) {
    assert.match(task, new RegExp(part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `the packet names ${part}`);
  }
});

test('DL1: one fork per node, later wakes queue in order', async () => {
  const h = harness({ plan: { on: ['question'], max: 4, aActs: [], seq: 12, planSha: 'abc123' } });
  await h.delegate.take([wake('a'), wake('b')]);
  assert.equal(h.launches.length, 2);
  await h.delegate.take([wake('a', 'question', 'Needs you: a — decide the second question')]);
  assert.equal(h.launches.length, 2, 'a second wake for a running node is queued, not forked');
  h.state.set(h.launches[0]!.id, { state: 'sealed', status: 'ok' });
  await h.delegate.poll();
  assert.equal(h.launches.length, 3, 'the queued wake is forked when the slot frees');
  assert.equal(h.launches[2]!.wake.node, 'a');
});

test('DL1: at most max forks run at once', async () => {
  const h = harness({ plan: { on: ['question'], max: 1, aActs: [], seq: 12, planSha: 'abc123' } });
  await h.delegate.take([wake('a')]);
  await h.delegate.take([wake('b')]);
  assert.equal(h.launches.length, 1, 'the second fork waits for a slot');
  h.state.set(h.launches[0]!.id, { state: 'sealed', status: 'ok' });
  await h.delegate.poll();
  assert.equal(h.launches.length, 2);
});

test('DL1: a wake whose kind is not delegated is delivered as a turn', async () => {
  const h = harness({ plan: { on: ['question'], max: 4, aActs: [], seq: 12, planSha: 'abc123' } });
  const rest = await h.delegate.take([wake('a', 'writer-stop')]);
  assert.equal(rest.length, 1);
  assert.equal(h.launches.length, 0);
});

test('DL1: without drive.delegate every wake is delivered as a turn', async () => {
  const h = harness({ plan: undefined });
  const rest = await h.delegate.take([wake('a')]);
  assert.equal(rest.length, 1);
  assert.equal(h.launches.length, 0);
});

test('DL2: a settled fork is reported once, with its stage, the accept command and the exact facts', async () => {
  const h = harness({ plan: { on: ['question'], max: 4, aActs: [], seq: 12, planSha: 'abc123' } });
  await h.delegate.take([wake('a')]);
  const id = h.launches[0]!.id;
  h.staged.set(id, { id: 'S7', node: 'a', class: 'B', summary: 'Keep the scoped interface', evidence: 2 });
  h.state.set(id, { state: 'sealed', status: 'ok', exact: { mode: 'exact', firstCacheRatio: 0.97, costUsd: 0.031 } });
  await h.delegate.poll();
  assert.equal(h.delivered.length, 1, 'one batched message per settle');
  const text = h.delivered[0]!;
  assert.match(text, /S7/);
  assert.match(text, /class B/);
  assert.match(text, /2 evidence/);
  assert.match(text, /owed accept S7/);
  assert.match(text, /exact: cache 97%/);
  assert.match(text, /\$0\.031/);
});

test('DL2: several settled forks are reported in one batched message', async () => {
  const h = harness({ plan: { on: ['question'], max: 4, aActs: [], seq: 12, planSha: 'abc123' } });
  await h.delegate.take([wake('a'), wake('b')]);
  h.staged.set(h.launches[0]!.id, { id: 'S1', node: 'a', class: 'B', summary: 'First', evidence: 1 });
  h.staged.set(h.launches[1]!.id, { id: 'S2', node: 'b', class: 'C', summary: 'Second', evidence: 0 });
  h.state.set(h.launches[0]!.id, { state: 'sealed', status: 'ok' });
  h.state.set(h.launches[1]!.id, { state: 'sealed', status: 'ok' });
  await h.delegate.poll();
  assert.equal(h.delivered.length, 1);
  assert.match(h.delivered[0]!, /S1/);
  assert.match(h.delivered[0]!, /S2/);
});

test('DL2: a fork that ended without a stage is reported with its original wake and the reason', async () => {
  const h = harness({ plan: { on: ['question'], max: 4, aActs: [], seq: 12, planSha: 'abc123' } });
  await h.delegate.take([wake('a', 'question', 'Needs you: a — decide the run’s open question')]);
  const id = h.launches[0]!.id;
  h.state.set(id, { state: 'sealed', status: 'failed', error: 'budget exhausted' });
  await h.delegate.poll();
  const text = h.delivered[0]!;
  assert.match(text, /Needs you: a — decide the run’s open question/);
  assert.match(text, /budget exhausted/);
  assert.match(text, /no stage/i);
});

test('DL1: the plan budget bounds the call (wall_s) and states the rounds in the packet', async () => {
  const h = harness({ plan: { on: ['question'], max: 4, budget: { rounds: 3, wall_s: 90 }, aActs: [], seq: 12, planSha: 'abc123' } });
  await h.delegate.take([wake('a')]);
  const launch = h.launches[0]!;
  assert.equal(launch.spec.timeoutMs, 90_000, 'the wall budget bounds the dsa call');
  assert.equal(launch.spec.budget, undefined, 'dsa budgets take tokens or cost only; the plan budget is not passed verbatim');
  assert.match(String(launch.spec.task), /3 round/, 'the rounds of work are stated in the packet');
  assert.match(String(launch.spec.task), /90 s/, 'the wall budget is stated in the packet');
});

test('DL2: more than one open class-B stage adds the owed accept --all-b line', async () => {
  const h = harness({ plan: { on: ['question'], max: 4, aActs: [], seq: 12, planSha: 'abc123' } });
  await h.delegate.take([wake('a'), wake('b')]);
  h.staged.set(h.launches[0]!.id, { id: 'S1', node: 'a', class: 'B', summary: 'First', evidence: 1 });
  h.staged.set(h.launches[1]!.id, { id: 'S2', node: 'b', class: 'B', summary: 'Second', evidence: 1 });
  h.state.set(h.launches[0]!.id, { state: 'sealed', status: 'ok' });
  h.state.set(h.launches[1]!.id, { state: 'sealed', status: 'ok' });
  await h.delegate.poll();
  assert.match(h.delivered[0]!, /owed accept --all-b/);
});

test('DL2: one open class-B stage does not add the all-b line', async () => {
  const h = harness({ plan: { on: ['question'], max: 4, aActs: [], seq: 12, planSha: 'abc123' } });
  await h.delegate.take([wake('a')]);
  h.staged.set(h.launches[0]!.id, { id: 'S1', node: 'a', class: 'B', summary: 'First', evidence: 1 });
  h.state.set(h.launches[0]!.id, { state: 'sealed', status: 'ok' });
  await h.delegate.poll();
  assert.doesNotMatch(h.delivered[0]!, /owed accept --all-b/);
});

test('DL3: a launch refusal delivers the original wake at once', async () => {
  const h = harness({ plan: { on: ['question'], max: 4, aActs: [], seq: 12, planSha: 'abc123' } });
  h.launches_ok = false;
  const rest = await h.delegate.take([wake('a')]);
  assert.equal(rest.length, 1, 'the refused wake is delivered as a turn');
  assert.equal(h.delivered.length, 0);
});

test('DL3: wakes queued or in flight when the session quits are delivered as their original wakes', async () => {
  const h = harness({ plan: { on: ['question'], max: 1, aActs: [], seq: 12, planSha: 'abc123' } });
  await h.delegate.take([wake('a')]);
  await h.delegate.take([wake('b')]);
  const handed = await h.delegate.quit();
  assert.equal(handed.length, 2, 'both the running and the queued wake are handed back');
  assert.deepEqual(handed.map(w => w.node).sort(), ['a', 'b']);
});

test('DL4: without a session id the wake is delivered as a turn', async () => {
  const h = harness({ plan: { on: ['question'], max: 4, aActs: [], seq: 12, planSha: 'abc123' } });
  h.session = undefined;
  const rest = await h.delegate.take([wake('a')]);
  assert.equal(rest.length, 1);
  assert.equal(h.launches.length, 0);
});

test('DL4: an older dsa without --origin-session delivers the wake as a turn', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'owed-delegate-old-'));
  try {
    await writeFile(join(dir, 'old-origin'), '');
    const h = harness({ plan: { on: ['question'], max: 4, aActs: [], seq: 12, planSha: 'abc123' } });
    // The dsa client reports the missing option; the delegate then delivers the wake as a turn.
    const { Dsa } = await import('../src/dsa.ts');
    const dsa = new Dsa({ bin: FAKE, env: { FAKE_DSA_DIR: dir }, waitMs: 1000, timeoutMs: 20_000 });
    const delegate = new Delegate({
      facts: async () => h.plan,
      session: () => h.session,
      supported: async () => dsa.supportsOriginSession(),
      launch: async (l) => {
        const r = await dsa.run(l.id, JSON.stringify(l.spec), l.labels, dir);
        return r.outcome === 'applied' ? { ok: true, id: l.id } : { ok: false, reason: 'refused' };
      },
      inspect: async () => ({ state: 'absent' }),
      stages: async () => [],
      deliver: (t) => { h.delivered.push(t); },
      store: { load: async () => [], save: async () => {} },
    });
    const rest = await delegate.take([wake('a')]);
    assert.equal(rest.length, 1, 'the wake is delivered as a turn');
    assert.equal(h.delivered.length, 0);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('DL: a fork call is described through its call address, not through describe --key', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'owed-delegate-call-'));
  try {
    await mkdir(join(dir, 'agents'), { recursive: true });
    await writeFile(join(dir, 'wid'), '01M5KDEKNC2C7P5B9WGEN8KY6A');
    const { Dsa } = await import('../src/dsa.ts');
    const dsa = new Dsa({ bin: FAKE, env: { FAKE_DSA_DIR: dir }, waitMs: 1000, timeoutMs: 20_000 });
    const r = await dsa.run('fork-run-1', JSON.stringify({ agent: 'delegate', task: 't', context: 'exact' }), { owed_fork: 'a' }, dir);
    assert.equal(r.outcome, 'applied');
    const prior = process.env.DSA_CALL, priorBin = process.env.OWED_DSA, priorDir = process.env.FAKE_DSA_DIR;
    process.env.DSA_CALL = '01M5KDEKNC2C7P5B9WGEN8KY6A@1/tasks:0@1';
    process.env.OWED_DSA = FAKE;
    process.env.FAKE_DSA_DIR = dir;
    try {
      const fork = await forkPrincipal(dir);
      assert.deepEqual(fork, { node: 'a', call: '01M5KDEKNC2C7P5B9WGEN8KY6A@1/tasks:0@1' });
    } finally {
      if (prior === undefined) delete process.env.DSA_CALL; else process.env.DSA_CALL = prior;
      if (priorBin === undefined) delete process.env.OWED_DSA; else process.env.OWED_DSA = priorBin;
      if (priorDir === undefined) delete process.env.FAKE_DSA_DIR; else process.env.FAKE_DSA_DIR = priorDir;
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
