// DL1-DL5: the session's delegate routes node wakes to exact forks of the session and reports the settle.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir, hostname } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ExtensionAPI, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { Delegate, type DelegateKind, type DelegatePlan, type DelegatePorts, type DelegateStage, type DelegateWake } from '../src/watch.ts';
import { delegateWakeId } from '../src/drive-bg.ts';
import { forkPrincipal } from '../src/stage.ts';
import { procStart } from '../src/drive-run.ts';
import * as ops from '../src/ops.ts';
import owedExtension from '../src/extension.ts';
import { repo } from './helpers/repo.ts';

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
  /** The forks whose launch is refused (the rest are launched). */
  refused: Set<string>;
  /** The stage ids that are closed (accepted or rejected): a closed stage is no longer open. */
  closed: Set<string>;
  /** The number of store writes (a store that is never written is never created). */
  saves: number;
  /** A new delegate over the same state: a session that follows the driver again. */
  restart: () => Delegate;
}

/** The run wid of a fork of a node (the harness gives every node its own run). */
const widOf = (node: string) => `wid-${node}`;
/** The author of a stage made inside the fork's dsa call: `writer:<call address>`. */
const authorOf = (node: string) => `writer:${widOf(node)}@1/tasks:0@1`;
/** DL6: the delegate ports plus the fork-stage port (the nodes with an open stage made by one of their forks). */
type Dl6Ports = DelegatePorts & { forkStageNodes: () => Promise<string[]> };

function harness(o: { plan?: DelegatePlan; session?: string } = {}): Harness {
  const launches: Launch[] = [], delivered: string[] = [];
  const staged = new Map<string, DelegateStage>();
  const state = new Map<string, { state: string; status?: string; error?: string; exact?: { mode: string; reason?: string; firstCacheRatio?: number; costUsd?: number } }>();
  const pending: { wake: DelegateWake; id: string }[] = [];
  const refused = new Set<string>();
  const h: Harness = {
    delegate: undefined as unknown as Delegate, launches, delivered, staged, state, plan: o.plan, session: o.session ?? 'pi-session-1', pending, launches_ok: true, refused, closed: new Set<string>(), saves: 0,
    restart: () => new Delegate(ports()),
  };
  const ports = (): Dl6Ports => ({
    facts: async () => h.plan,
    session: () => h.session,
    supported: async () => true,
    launch: async (l: { wake: DelegateWake; id: string; labels: Record<string, string>; spec: Record<string, unknown> }) => {
      launches.push(l);
      if (!h.launches_ok || refused.has(l.wake.node)) return { ok: false, reason: 'request-conflict' };
      state.set(l.id, { state: 'running' });
      pending.push({ wake: l.wake, id: l.id });
      return { ok: true, id: l.id, wid: widOf(l.wake.node) };
    },
    inspect: async (id: string) => state.get(id) ?? { state: 'absent' },
    stages: async () => [...staged.values()].filter(s => !h.closed.has(s.id)).map(s => ({ ...s, by: s.by ?? authorOf(s.node) })),
    // DL6 (DL2 attribution): a stage belongs to a node's fork when its author's wid is the wid of a fork of that node.
    forkStageNodes: async () => {
      const forks = new Map(launches.map(l => [widOf(l.wake.node), l.wake.node] as const));
      const nodes = new Set<string>();
      for (const s of staged.values()) {
        if (h.closed.has(s.id)) continue;
        const by = s.by ?? authorOf(s.node);
        const fork = by.startsWith('writer:') ? forks.get(by.slice('writer:'.length).split('@')[0]!) : undefined;
        if (fork) nodes.add(fork);
      }
      return [...nodes];
    },
    deliver: (text: string) => { delivered.push(text); },
    store: {
      load: async () => pending.map(p => ({ wake: p.wake, id: p.id })),
      save: async (list: { wake: DelegateWake; id: string }[]) => { h.saves++; pending.length = 0; pending.push(...list); },
    },
  });
  h.delegate = new Delegate(ports());
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

test('DL6.4c: a second wake of a node whose fork is running is delivered, not queued', async () => {
  const h = harness({ plan: { on: ['question'], max: 4, aActs: [], seq: 12, planSha: 'abc123' } });
  await h.delegate.take([wake('a'), wake('b')]);
  assert.equal(h.launches.length, 2);
  const second = wake('a', 'question', 'Needs you: a — decide the second question');
  const rest = await h.delegate.take([second]);
  assert.deepEqual(rest.map(w => w.id), [second.id], 'the second wake of the running node is delivered as a turn');
  assert.equal(h.launches.length, 2, 'the running node is not forked again');
  h.state.set(h.launches[0]!.id, { state: 'sealed', status: 'ok' });
  await h.delegate.poll();
  assert.equal(h.launches.length, 2, 'the delivered wake was not queued: no fork when the slot frees');
  assert.ok(!h.delivered.some(t => t.includes('decide the second question')), 'it is not delivered again as a refused wake');
});

test('DL6.4a: two differently worded wakes of one node while its fork stage is open fork once', async () => {
  const h = harness({ plan: { on: ['needs-owner'], max: 4, aActs: [], seq: 12, planSha: 'abc123' } });
  const first = wake('greet', 'needs-owner', 'Needs you: greet — resolve the owner review (facts 3)');
  assert.deepEqual(await h.delegate.take([first]), []);
  h.staged.set(h.launches[0]!.id, { id: 'S4', node: 'greet', class: 'B', summary: 'Resolve the review', evidence: 0, seq: 20 });
  h.state.set(h.launches[0]!.id, { state: 'sealed', status: 'ok' });
  await h.delegate.poll();
  const second = wake('greet', 'needs-owner', 'Needs you: greet — resolve the owner review (facts 4)');
  const rest = await h.delegate.take([second]);
  assert.equal(h.launches.length, 1, 'one launch: the open stage of its fork blocks a new fork');
  assert.deepEqual(rest.map(w => w.id), [second.id], 'the second wake is delivered as a turn');
  const again = await h.delegate.take([wake('greet', 'needs-owner', 'Needs you: greet — resolve the owner review (facts 5)')]);
  assert.equal(again.length, 1, 'a third wording is delivered too');
  assert.equal(h.launches.length, 1);
});

test('DL6.4b: after the fork stage is accepted, a new wake forks again', async () => {
  const h = harness({ plan: { on: ['needs-owner'], max: 4, aActs: [], seq: 12, planSha: 'abc123' } });
  await h.delegate.take([wake('greet', 'needs-owner', 'Needs you: greet — one')]);
  h.staged.set(h.launches[0]!.id, { id: 'S4', node: 'greet', class: 'B', summary: 'Resolve', evidence: 0, seq: 20 });
  h.state.set(h.launches[0]!.id, { state: 'sealed', status: 'ok' });
  await h.delegate.poll();
  assert.equal((await h.delegate.take([wake('greet', 'needs-owner', 'Needs you: greet — two')])).length, 1, 'blocked while S4 is open');
  h.closed.add('S4');
  const rest = await h.delegate.take([wake('greet', 'needs-owner', 'Needs you: greet — three')]);
  assert.deepEqual(rest, [], 'the closed stage no longer blocks');
  assert.equal(h.launches.length, 2, 'a new fork is launched');
});

test('DL6.2: an open stage by another actor or by another node fork does not block the node', async () => {
  const h = harness({ plan: { on: ['question'], max: 4, aActs: [], seq: 12, planSha: 'abc123' } });
  await h.delegate.take([wake('b')]);
  h.staged.set('parent', { id: 'S1', node: 'a', class: 'B', summary: 'The parent staged', evidence: 0, by: 'owner:pi' });
  h.staged.set('other-fork', { id: 'S2', node: 'a', class: 'B', summary: 'The fork of b staged for a', evidence: 0, by: authorOf('b') });
  const rest = await h.delegate.take([wake('a')]);
  assert.deepEqual(rest, [], 'node a is forked');
  assert.equal(h.launches.length, 2);
  h.state.set(h.launches[0]!.id, { state: 'sealed', status: 'ok' });
  await h.delegate.poll();
  assert.equal((await h.delegate.take([wake('b', 'question', 'Needs you: b — again')])).length, 1, 'the stage made by the fork of b blocks b');
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

test('DL3: the next session hands the pending wakes back and does not fork them again', async () => {
  const h = harness({ plan: { on: ['question'], max: 4, aActs: [], seq: 12, planSha: 'abc123' } });
  const w = wake('a');
  await h.delegate.take([w]);
  await h.delegate.quit();
  assert.equal(h.pending.length, 1, 'the pending fork is kept across the quit');
  // A new session follows the driver again: the wake is delivered as its original wake.
  const next = new Delegate({
    facts: async () => h.plan,
    session: () => h.session,
    supported: async () => true,
    launch: async (l) => { h.launches.push(l); return { ok: true, id: l.id }; },
    inspect: async (id) => h.state.get(id) ?? { state: 'absent' },
    stages: async () => [],
    forkStageNodes: async () => [],
    deliver: (text) => { h.delivered.push(text); },
    store: { load: async () => h.pending.map(p => ({ wake: p.wake, id: p.id })), save: async (list) => { h.pending.length = 0; h.pending.push(...list); } },
  } as Dl6Ports);
  await next.restore();
  assert.equal(h.delivered.length, 1);
  assert.match(h.delivered[0]!, /Needs you: a/);
  const launches = h.launches.length;
  const rest = await next.take([w]);
  assert.equal(rest.length, 0, 'the handed-back wake is not forked a second time');
  assert.equal(h.launches.length, launches);
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
      forkStageNodes: async () => [],
      deliver: (t) => { h.delivered.push(t); },
      store: { load: async () => [], save: async () => {} },
    } as Dl6Ports);
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

test('DL3: a restart does not fork a pending wake again when its line is replayed', async () => {
  const h = harness({ plan: { on: ['question'], max: 4, aActs: [], seq: 12, planSha: 'abc123' } });
  const w = wake('a');
  await h.delegate.take([w]);
  assert.equal(h.launches.length, 1, 'the first session forked the wake');
  await h.delegate.quit();
  assert.equal(h.pending.length, 1, 'the fork is pending in the store');
  // The session follows the driver again: the same wake line is replayed from the driver log.
  const next = h.restart();
  await next.restore();
  const launches = h.launches.length;
  const rest = await next.take([w]);
  assert.equal(h.launches.length, launches, 'the replayed wake is not forked a second time');
  assert.equal(rest.length, 0, 'the replayed wake is not delivered as a turn either');
});

test('DL3: a restart without a restore still does not fork a pending wake again', async () => {
  const h = harness({ plan: { on: ['question'], max: 4, aActs: [], seq: 12, planSha: 'abc123' } });
  const w = wake('a');
  await h.delegate.take([w]);
  await h.delegate.quit();
  // The replayed line reaches the delegate before the store was restored (the registry was not ready yet).
  const next = h.restart();
  const launches = h.launches.length;
  const rest = await next.take([w]);
  assert.equal(h.launches.length, launches, 'a wake pending in the store is never forked again');
  assert.equal(rest.length, 0, 'the wake stays with the pending fork');
});

test('DL3: a refused queued launch delivers the original wake at once', async () => {
  const h = harness({ plan: { on: ['question'], max: 1, aActs: [], seq: 12, planSha: 'abc123' } });
  await h.delegate.take([wake('a')]);
  assert.equal(h.launches.length, 1, 'the first node holds the only slot');
  const queued = wake('b');
  await h.delegate.take([queued]);
  assert.equal(h.launches.length, 1, 'the second node queues');
  h.refused.add('b');
  h.state.set(h.launches[0]!.id, { state: 'sealed', status: 'ok' });
  await h.delegate.poll();
  assert.equal(h.launches.length, 2, 'the queued wake is launched when the slot frees');
  const delivered = h.delivered.join('\n');
  assert.match(delivered, /Needs you: b/, 'the refused queued launch delivers the original wake at once');
});

test('DL2: a stage of the same node by another actor is not the fork stage', async () => {
  const h = harness({ plan: { on: ['question'], max: 4, aActs: [], seq: 12, planSha: 'abc123' } });
  await h.delegate.take([wake('a')]);
  h.staged.set(h.launches[0]!.id, { id: 'S9', node: 'a', class: 'B', summary: 'The parent staged this', evidence: 1, by: 'owner:pi' });
  h.state.set(h.launches[0]!.id, { state: 'sealed', status: 'ok' });
  await h.delegate.poll();
  assert.doesNotMatch(h.delivered[0]!, /S9/, 'the stage of another actor is not attributed to the fork');
  assert.match(h.delivered[0]!, /ended with no stage/, 'the fork reports that it staged nothing');
});

test('DL2: the fork stage is the one the fork call made, not an earlier stage of the same node', async () => {
  const h = harness({ plan: { on: ['question'], max: 4, aActs: [], seq: 12, planSha: 'abc123' } });
  await h.delegate.take([wake('a')]);
  h.staged.set('parent-stage', { id: 'S1', node: 'a', class: 'C', summary: 'The parent staged this', evidence: 1, by: 'owner:pi' });
  h.staged.set('fork-stage', { id: 'S2', node: 'a', class: 'B', summary: 'The fork staged this', evidence: 2, by: authorOf('a') });
  h.state.set(h.launches[0]!.id, { state: 'sealed', status: 'ok' });
  await h.delegate.poll();
  assert.match(h.delivered[0]!, /S2/, "the fork's own stage is reported");
  assert.doesNotMatch(h.delivered[0]!, /S1/, "the stage of another actor is not reported and does not hide the fork's stage");
});

test('DL3: the session restores the store before it follows the driver, so a replayed wake is not forked again', async () => {
  const r = await repo();
  const dir = join(r.root, 'dsa');
  await mkdir(dir, { recursive: true });
  const plan = { version: 1, trunk: 'main', closure: [], invariants: [], drive: { delegate: { on: ['question'] } }, nodes: [{ id: 'a', writes: ['a.txt'], checks: [] }] };
  await r.put('plan.json', JSON.stringify(plan));
  await r.commit();
  await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'human' }, channel: 'flag', plan: JSON.stringify(plan) });
  const ledgerDir = process.env.OWED_DIR!;
  const driveDir = join(ledgerDir, 'drive');
  await mkdir(driveDir, { recursive: true });
  // The driver log holds the node wake; the follower replays it when it attaches.
  const line = JSON.stringify({ do: 'notify', node: 'a', outcome: 'notify', text: "a: writer run r1 asks (qid q1-1, rev 1): which db?", facts: 3 });
  await writeFile(join(driveDir, 'log.jsonl'), `${line}\n`, 'utf8');
  // A live driver of this session: the lock names this process and the session.
  await writeFile(join(ledgerDir, 'drive.lock'), JSON.stringify({ pid: process.pid, start: procStart(process.pid), host: hostname(), at: new Date().toISOString(), token: 'test-token', session: 'delegate-session' }), 'utf8');
  // The store of the previous session holds the pending fork of that very wake.
  const wakeId = delegateWakeId('a', 'question', "a: writer run r1 asks (qid q1-1, rev 1): which db?", 3);
  const wakeText = "Needs you: a — writer run r1 asks (qid q1-1, rev 1): which db? → owed answer a q1-1";
  await writeFile(join(driveDir, 'delegate.json'), JSON.stringify([{ wake: { node: 'a', kind: 'question', text: wakeText, id: wakeId }, id: 'delegate:a:old' }]), 'utf8');
  const prior = { OWED_DSA: process.env.OWED_DSA, FAKE_DSA_DIR: process.env.FAKE_DSA_DIR, XDG_STATE_HOME: process.env.XDG_STATE_HOME };
  process.env.OWED_DSA = FAKE;
  process.env.FAKE_DSA_DIR = dir;
  process.env.XDG_STATE_HOME = join(r.root, 'state');
  const tools = new Map<string, ToolDefinition>();
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  const messages: { customType: string; content: string }[] = [];
  owedExtension({
    registerTool(t: ToolDefinition) { tools.set(t.name, t); },
    registerCommand() { /* unused */ },
    on(event: string, h: (event: unknown, ctx: unknown) => unknown) { handlers.set(event, h); return () => undefined; },
    sendMessage(message: { customType: string; content: string }) { messages.push(message); },
  } as unknown as ExtensionAPI);
  const ctx = { cwd: r.cwd, hasUI: false, isIdle: () => true, sessionManager: { getSessionId: () => 'delegate-session' }, ui: { notify() { /* unused */ } } };
  try {
    await handlers.get('session_start')?.({ type: 'session_start', reason: 'startup' }, ctx);
    const dsaLog = await readFile(join(dir, 'log.jsonl'), 'utf8').catch(() => '');
    const runs = dsaLog.split('\n').filter(Boolean).map(l => JSON.parse(l) as { cmd?: string; labels?: Record<string, string> });
    const forked = runs.filter(x => x.cmd === 'run' && x.labels?.owed_fork === 'a');
    assert.equal(forked.length, 0, 'the replayed wake is not forked again');
    const state = JSON.parse(await readFile(join(dir, 'state.json'), 'utf8').catch(() => '{}')) as { runs?: Record<string, { labels?: Record<string, string> }> };
    assert.equal(Object.values(state.runs ?? {}).filter(x => x.labels?.owed_fork === 'a').length, 0, 'no fork run was recorded for the node');
    assert.ok(messages.some(m => m.content.includes('Needs you: a')), 'the pending wake is handed back to the session');
  } finally {
    if (prior.OWED_DSA === undefined) delete process.env.OWED_DSA; else process.env.OWED_DSA = prior.OWED_DSA;
    if (prior.FAKE_DSA_DIR === undefined) delete process.env.FAKE_DSA_DIR; else process.env.FAKE_DSA_DIR = prior.FAKE_DSA_DIR;
    if (prior.XDG_STATE_HOME === undefined) delete process.env.XDG_STATE_HOME; else process.env.XDG_STATE_HOME = prior.XDG_STATE_HOME;
    await r.cleanup();
  }
});

test('DL3: a quit with nothing pending writes no store file', async () => {
  const h = harness({ plan: { on: ['question'], max: 4, aActs: [], seq: 12, planSha: 'abc123' } });
  await h.delegate.quit();
  assert.equal(h.saves, 0, 'nothing is written when there is nothing to keep');
  assert.equal(h.pending.length, 0, 'the store stays empty');
});

test('DL3: a session on a repo without drive.delegate creates no store file and no drive dir', async () => {
  const r = await repo();
  // The ledger and the store live in the repo's own .git/owed (the default layout of a real repository).
  const priorDir = process.env.OWED_DIR;
  process.env.OWED_DIR = join(r.cwd, '.git/owed');
  const plan = { version: 1, trunk: 'main', closure: [], invariants: [], nodes: [{ id: 'a', writes: ['a.txt'], checks: [] }] };
  await r.put('plan.json', JSON.stringify(plan));
  await r.commit();
  await ops.init({ cwd: r.cwd, as: { role: 'owner', id: 'human' }, channel: 'flag', plan: JSON.stringify(plan) });
  const drive = join(r.cwd, '.git/owed/drive');
  assert.equal(existsSync(drive), false, 'the drive dir does not exist before the session');
  const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
  owedExtension({
    registerTool() { /* unused */ },
    registerCommand() { /* unused */ },
    on(event: string, h: (event: unknown, ctx: unknown) => unknown) { handlers.set(event, h); return () => undefined; },
    sendMessage() { /* unused */ },
  } as unknown as ExtensionAPI);
  const ctx = { cwd: r.cwd, hasUI: false, isIdle: () => true, sessionManager: { getSessionId: () => 'no-delegate-session' }, ui: { notify() { /* unused */ } } };
  try {
    await handlers.get('session_start')?.({ type: 'session_start', reason: 'startup' }, ctx);
    await handlers.get('session_shutdown')?.({ type: 'session_shutdown' }, ctx);
    // The quit of the delegates is not awaited by the shutdown handler: give the write time to land.
    const end = Date.now() + 1000;
    while (Date.now() < end && !existsSync(join(drive, 'delegate.json')) && !existsSync(drive)) await new Promise(res => setTimeout(res, 20));
    assert.equal(existsSync(join(drive, 'delegate.json')), false, 'no store file is written for a repo whose plan does not delegate');
    assert.equal(existsSync(drive), false, 'the store directory is not created for a repo whose plan does not delegate');
  } finally {
    if (priorDir === undefined) delete process.env.OWED_DIR; else process.env.OWED_DIR = priorDir;
    await r.cleanup();
  }
});
