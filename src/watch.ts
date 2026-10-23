// FW3/FW4: CLI follower, using exactly the session follower's wake batches and revalidation.
// DL1-DL4: the delegate that hands node wakes to exact forks of the session that follows the driver.
import * as git from './git.ts';
import { OwedError } from './errors.ts';
import { DriveWatch, revalidator, type DelegateKind, type DelegateWake } from './drive-bg.ts';
import type { DriveStart } from './drive-bg.ts';
import { driverSession, registeredDrivers } from './registry.ts';

export type { DelegateKind, DelegateWake } from './drive-bg.ts';

export function followedBy(r: DriveStart): string | null {
  if (r.exited) return null;
  return r.session ?? registeredDrivers().find(d => d.repo === r.repo && d.pid === r.pid && d.start === r.start)?.session
    ?? (r.alreadyRunning ? null : driverSession() ?? null);
}
export const followText = (session: string | null): string => session
  ? `followed by pi session ${session.slice(0, 8)}`
  : 'note: no pi session follows this driver; no automatic pi delivery. To observe it explicitly, run `owed watch` (for example as a dsa command call).';
export function parseWatchCursor(value?: string): { offset: number; ino?: number } | undefined {
  if (value === undefined) return;
  const parts = value.split(':').map(Number);
  if (!/^\d+(?::\d+)?$/.test(value) || parts.some(n => !Number.isSafeInteger(n))) throw new OwedError('--after must be <offset>[:<ino>] (nonnegative integers)', 'usage');
  return { offset: parts[0]!, ...(parts.length === 2 ? { ino: parts[1]! } : {}) };
}
export interface WatchResult { lines: string[]; next: string; exit: 0 | 3 | 5 }
export async function watchDriver(o: { cwd: string; after?: string; timeout?: number }): Promise<WatchResult> {
  const after = parseWatchCursor(o.after);
  const repo = await git.mainRoot(o.cwd), watch = new DriveWatch(() => undefined, 0, { busy: () => false, revalidate: repo => revalidator({ cwd: repo }) });
  const follower = await watch.attach(o.cwd, after?.offset, after?.ino, false);
  if (!follower) return { lines: [`no owed driver is running in ${repo}; start one with owed start`], next: `${after?.offset ?? 0}:${after?.ino ?? 0}`, exit: 3 };
  const end = o.timeout === undefined ? Infinity : Date.now() + o.timeout * 1000;
  try {
    for (;;) {
      const message = await follower.step();
      if (message !== undefined) return { lines: message.split('\n'), next: follower.next, exit: 0 };
      if (Date.now() >= end) return { lines: [`no wake within ${o.timeout} s`], next: follower.next, exit: 5 };
      await new Promise(r => setTimeout(r, Math.min(250, Math.max(0, end - Date.now()))));
    }
  } finally { watch.stopAll(); }
}
export function watchText(r: WatchResult): string {
  return [...r.lines, ...(r.exit === 3 ? [] : [`next: owed watch --after ${r.next}`])].join('\n');
}

// ---------- DL: node wakes go to exact forks of the session that follows the driver ----------
/** The plan's delegate block: the wake kinds it hands to a fork, how many forks run at once and their budget. */
export interface DelegatePlan {
  /** The kinds of node wake this plan delegates (`drive.delegate.on`). */
  on: DelegateKind[];
  /** The most forks at once (`drive.delegate.max`). */
  max: number;
  /** The fork budget (`drive.delegate.budget`): rounds of work and wall seconds. */
  budget?: { rounds?: number; wall_s?: number };
  /** The A acts a fork may perform now (`drive.delegate.a_acts` minus overturned kinds). */
  aActs: string[];
  /** The ledger head seq the fork reads through (`read_through_seq`). */
  seq: number;
  /** The sha256 of the plan file the fork works against. */
  planSha: string;
}
/** One fork launch: the wake, the dsa request id, the run labels and the call spec. */
export interface DelegateLaunch {
  wake: DelegateWake;
  /** The dsa request id of the fork run. */
  id: string;
  /** The run labels (`owed_fork`, `owed_wake`). */
  labels: Record<string, string>;
  /** The call spec: one agent call, no model, an exact context. */
  spec: { agent: string; task: string; context: string; timeoutMs?: number };
}
/** The state of a launched fork, as dsa reports it. */
export interface DelegateForkState {
  /** The dsa state of the call (`sealed`, `running`, `absent`, ...). */
  state: string;
  /** The call status (`ok`, `failed`, ...). */
  status?: string;
  /** The error dsa reported. */
  error?: string;
  /** The exactness facts of the call (dsa 1.3.0). */
  exact?: { mode: string; reason?: string; firstCacheRatio?: number; costUsd?: number };
}
/** A stage a fork recorded (the bundle's summary, class and evidence files). */
export interface DelegateStage { id: string; node: string; class: string; summary: string; evidence: number; }
/** The delegate's ports: what it needs from the session, the ledger and dsa. */
export interface DelegatePorts {
  /** The plan's delegate facts, or undefined when the plan does not delegate. */
  facts: () => Promise<DelegatePlan | undefined>;
  /** The pi session id an exact fork pins (`--origin-session`), or undefined when there is none. */
  session: () => string | undefined;
  /** DL4: whether the dsa accepts `--origin-session` (dsa >= 1.3.0); an older dsa behaves as 0.32.0. */
  supported: () => Promise<boolean>;
  /** Launch one exact fork. */
  launch: (l: DelegateLaunch) => Promise<{ ok: true; id: string } | { ok: false; reason: string }>;
  /** The state of a launched fork. */
  inspect: (id: string) => Promise<DelegateForkState>;
  /** The stages the forks recorded, newest first. */
  stages: () => Promise<DelegateStage[]>;
  /** Deliver a message to the session. */
  deliver: (text: string) => void;
  /** The pending forks of a previous session, kept across a session quit. */
  store: { load: () => Promise<{ wake: DelegateWake; id: string }[]>; save: (list: { wake: DelegateWake; id: string }[]) => Promise<void> };
}
/**
 * DL1-DL4: the delegate of one repository. It takes the node wakes its plan lists, launches one exact fork per node
 * (at most `max` at once, later wakes queue in order), and reports every settled fork as one batched message.
 */
export class Delegate {
  private readonly running = new Map<string, { wake: DelegateWake; id: string }>();
  private readonly queue: { wake: DelegateWake }[] = [];
  /** The wake ids of the live forks (running or queued): an identical wake is never forked twice at once. */
  private readonly live = new Set<string>();
  private plan?: DelegatePlan | null;
  private exact?: boolean;
  private readonly ports: DelegatePorts;
  constructor(ports: DelegatePorts) { this.ports = ports; }

  /**
   * DL1: take the wakes this plan delegates. The returned wakes are not delegated and stay in the session's turn.
   * A wake whose kind is not listed, a plan without a delegate block, a session without an id and a dsa without
   * `--origin-session` all leave the wake in the turn (DL4).
   */
  async take(wakes: DelegateWake[]): Promise<DelegateWake[]> {
    const left: DelegateWake[] = [];
    for (const wake of wakes) {
      const plan = await this.plan_();
      if (!plan || !plan.on.includes(wake.kind) || !await this.exact_() || !this.ports.session()) { left.push(wake); continue; }
      if (this.live.has(wake.id)) { left.push(wake); continue; }
      if (this.running.has(wake.node) || this.running.size >= plan.max) { this.live.add(wake.id); this.queue.push({ wake }); continue; }
      this.live.add(wake.id);
      if (!await this.launch(wake, plan)) { this.live.delete(wake.id); left.push(wake); }
    }
    return left;
  }

  /** DL2: report the forks that settled since the last poll, as one batched message. */
  async poll(): Promise<void> {
    const settled: { wake: DelegateWake; id: string; state: DelegateForkState }[] = [];
    for (const [node, fork] of [...this.running]) {
      const state = await this.ports.inspect(fork.id);
      if (state.state !== 'sealed' && state.state !== 'absent') continue;
      this.running.delete(node);
      this.live.delete(fork.wake.id);
      settled.push({ ...fork, state });
    }
    if (!settled.length) return;
    const stages = await this.ports.stages();
    this.ports.deliver(settleText(settled, stages));
    await this.startQueued();
  }

  /**
   * DL3: the session quits. The pending forks are kept (so the next session hands their wakes back) and their wakes
   * are returned: a wake that no fork will answer is never lost.
   */
  async quit(): Promise<DelegateWake[]> {
    const pending = [...[...this.running.values()].map(f => ({ wake: f.wake, id: f.id })), ...this.queue.map(q => ({ wake: q.wake, id: '' }))];
    await this.ports.store.save(pending);
    this.running.clear();
    this.queue.length = 0;
    this.live.clear();
    return pending.map(p => p.wake);
  }

  /** DL3: a session follows the driver again: the wakes the previous session left pending are handed back. */
  async restore(): Promise<void> {
    const pending = await this.ports.store.load();
    await this.ports.store.save([]);
    for (const p of pending) this.ports.deliver(p.wake.text);
  }

  private async plan_(): Promise<DelegatePlan | undefined> {
    if (this.plan === undefined) this.plan = (await this.ports.facts().catch(() => undefined)) ?? null;
    return this.plan ?? undefined;
  }
  private async exact_(): Promise<boolean> {
    if (this.exact === undefined) this.exact = await this.ports.supported().catch(() => false);
    return this.exact;
  }
  private async launch(wake: DelegateWake, plan: DelegatePlan): Promise<boolean> {
    const id = `delegate:${wake.node}:${wake.id}`.slice(0, 120);
    const labels = { owed_fork: wake.node, owed_wake: wake.id };
    const spec = { agent: 'delegate', task: delegatePacket(wake, plan), context: 'exact', ...(plan.budget?.wall_s !== undefined ? { timeoutMs: plan.budget.wall_s * 1000 } : {}) };
    const r = await this.ports.launch({ wake, id, labels, spec });
    if (!r.ok) return false;
    this.running.set(wake.node, { wake, id: r.id });
    return true;
  }
  private async startQueued(): Promise<void> {
    const plan = await this.plan_();
    if (!plan) return;
    for (const item of [...this.queue]) {
      if (this.running.size >= plan.max) return;
      if (this.running.has(item.wake.node)) continue;
      this.queue.splice(this.queue.indexOf(item), 1);
      if (!await this.launch(item.wake, plan)) this.live.delete(item.wake.id);
    }
  }
}

/**
 * DL1: the fork's task. It names the node, the wake, the ledger seq to read through, the plan sha256 and the A acts
 * the fork may use, and the rules: reread the node's ledger entries since that seq first, produce a bundle and run
 * `owed stage`, never fork or launch subagents, run long reproductions only as dsa command calls, stop after staging.
 */
export function delegatePacket(wake: DelegateWake, plan: DelegatePlan): string {
  const acts = plan.aActs.length ? plan.aActs.join(', ') : 'none';
  const budget = plan.budget
    ? `The budget is ${plan.budget.rounds !== undefined ? `${plan.budget.rounds} round(s) of work` : 'the work it needs'}${plan.budget.wall_s !== undefined ? ` and at most ${plan.budget.wall_s} s of wall time` : ''}.`
    : '';
  return [
    `owed delegate fork for node ${wake.node}`,
    '',
    `Wake (${wake.kind}):`,
    wake.text,
    '',
    `Read the ledger through seq ${plan.seq} (read_through_seq ${plan.seq}); the plan sha256 is ${plan.planSha}.`,
    `Enabled A acts: ${acts}.`,
    ...(budget ? [budget] : []),
    '',
    'Rules:',
    `- reread this node's ledger entries since seq ${plan.seq} first; the facts above may be stale.`,
    `- produce a bundle and run \`owed stage ${wake.node} --file BUNDLE.json\`.`,
    '- never fork or launch subagents.',
    '- long reproductions run only as dsa command calls.',
    '- stop after staging.',
  ].join('\n');
}

/** DL2: the batched message of the forks that settled. */
function settleText(settled: { wake: DelegateWake; id: string; state: DelegateForkState }[], stages: DelegateStage[]): string {
  const lines: string[] = [`owed delegate: ${settled.length} fork(s) settled`];
  const used = new Set<string>();
  for (const fork of settled) {
    const stage = stages.find(s => s.node === fork.wake.node && !used.has(s.id));
    if (stage) {
      used.add(stage.id);
      lines.push(...stageLines(fork.wake, stage, fork.state.exact));
    } else {
      lines.push(...unstagedLines(fork));
    }
  }
  const classB = stages.filter(s => s.class === 'B').length;
  if (classB > 1) lines.push('owed accept --all-b');
  return lines.join('\n');
}
/** DL2: a staged fork: its summary, class, evidence count and the accept command, at most ten lines. */
function stageLines(wake: DelegateWake, stage: DelegateStage, exact: DelegateForkState['exact']): string[] {
  const head = `- ${wake.node}: staged ${stage.id} (class ${stage.class}, ${stage.evidence} evidence file(s))`;
  const body = stage.summary.split('\n').flatMap(l => l.trim() ? [l] : []);
  const tail = [`  owed accept ${stage.id}`, ...(exact ? [`  ${exactText(exact)}`] : [])];
  const room = Math.max(0, 10 - head.length - tail.length);
  return [head, ...body.slice(0, room).map(l => `  ${l}`), ...tail];
}
/** DL2: a fork that ended without a stage: its original wake and the line that names the call and why. */
function unstagedLines(fork: { wake: DelegateWake; id: string; state: DelegateForkState }): string[] {
  const why = fork.state.error ?? (fork.state.status && fork.state.status !== 'ok' ? fork.state.status : 'no conclusion');
  return [
    `- ${fork.wake.node}: fork ${fork.id} ended with no stage: ${why}`,
    ...fork.wake.text.split('\n').map(l => `  ${l}`),
    ...(fork.state.exact ? [`  ${exactText(fork.state.exact)}`] : []),
  ];
}
/** DL2: the dsa exactness line of a fork (its cache ratio and cost, or why it was rebuilt). */
function exactText(exact: NonNullable<DelegateForkState['exact']>): string {
  if (exact.mode === 'rebuilt') return `exact: rebuilt (${exact.reason ?? 'unknown'})`;
  const ratio = exact.firstCacheRatio === undefined ? '' : ` ${Math.round(exact.firstCacheRatio * 100)}%`;
  const cost = exact.costUsd === undefined ? '' : ` · $${exact.costUsd.toFixed(3)}`;
  return `exact: cache${ratio}${cost}`;
}
