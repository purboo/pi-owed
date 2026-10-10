// owed drive: the executor and the loop (SPEC §12.7, contract D6/D7/D9). One pass = load the ledger state, describe
// every live launch of the open attempts, `decide` (pure, src/drive.ts), execute the actions in order. Persist before
// submit: a launch/send entry is appended before the dsa call, and a retry re-sends the stored bytes with the same id.
// Verdicts (dsa rejections and conflicts, merge refusals, attest errors) are written to the ledger in the pass that meets
// them (D14); what this process keeps across passes are caches of dsa's answers (applied sends, follow-up generations),
// so losing it (a crash, a restart) is harmless: the ledger plus `describe` re-derive the state.
import { spawn } from 'node:child_process';
import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { readFileSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as ops from './ops.ts';
import * as git from './git.ts';
import { Ledger } from './ledger.ts';
import { parsePlan, driveConfig } from './plan.ts';
import { reduce, halted, projectId } from './reducer.ts';
import { decide, rejectedHalt } from './drive.ts';
import type { Action } from './drive.ts';
import { Dsa, DsaError, dsaAvailable } from './dsa.ts';
import { OwedError } from './errors.ts';
import { oneLine } from './views.ts';
import type { Plan, Principal, RunView, State } from './types.ts';

/** The transient merge refusal of `ops` (the plan, the candidate or trunk changed while merge measured). */
const MERGE_TRANSIENT = 'Plan, candidate or trunk changed; retry';

/** The driver's principal (`parent:drive`, contract D3). */
export const DRIVE_PRINCIPAL: Principal = { role: 'parent', id: 'drive' };

export interface DriveOptions {
  /** A directory inside the repository. */
  cwd: string;
  /** One pass, then exit (no lock is kept, no events are read). */
  once?: boolean;
  /** Overrides `drive.max` of the plan. */
  max?: number;
  /** JSON lines instead of text lines. */
  json?: boolean;
  /** One output line (an action, a notify, a halt, idle). */
  log: (line: string) => void;
  /** dsa client; default `new Dsa()` (`$OWED_DSA`, else the installed CLI). */
  dsa?: Dsa;
  /** argv prefix that runs the owed CLI for `attest` (default: this package's `bin/owed.js` under the current node). */
  owed?: string[];
  /** Event poll interval (default 3 s) and the period of an unconditional pass (default 30 s). */
  pollMs?: number;
  passMs?: number;
  /** Events per `events --all` page (default 100; halved after a page the client could not read). */
  limit?: number;
  /** Stops the loop after the current action (tests; the CLI uses SIGINT/SIGTERM). */
  signal?: AbortSignal;
  /** Install SIGINT/SIGTERM handlers (default true; loop: D14.8, `once`: D16.3); the pi tool's pass installs none. */
  handleSignals?: boolean;
}

/** One executed action as printed (`--json`: one object per line). */
export interface ActionReport {
  do: Action['do']; node: string; outcome: string; detail?: string;
  attempt?: number; role?: string; rid?: string; send?: string; sendKind?: string; reason?: string; needs?: string; text?: string;
}
export interface PassResult { actions: ActionReport[]; progress: boolean; idle: boolean }

/**
 * Caches of dsa's own answers this process may reuse across passes (D14: they never carry a verdict): send ids dsa
 * reported applied, follow-up generations, and what the loop last printed. Verdicts (rejections, merge refusals,
 * attest errors) are written to the ledger in the pass they happen.
 */
class Facts {
  readonly applied = new Set<string>();
  /** rid → generation a follow-up applied in this process started; a describe of an older, sealed generation is stale. */
  readonly expectGen = new Map<string, number>();
  /** rid → latest generation describe reported. */
  readonly lastGen = new Map<string, number>();
  /** `<node>:<kind>` → last printed text key (notify, machine busy): the loop prints a line only when it changed. */
  readonly printed = new Map<string, string>();
}

// ---------- ledger state ----------
async function loadState(ledger: Ledger): Promise<State> {
  const entries = await ledger.read(), plans = new Map<string, Plan>();
  for (const e of entries) if ((e.kind === 'genesis' || e.kind === 'plan') && !plans.has(e.plan)) plans.set(e.plan, parsePlan((await ledger.getBlob(e.plan)).toString()));
  const s = reduce(entries, sha => { const p = plans.get(sha); if (!p) throw new OwedError(`Missing plan ${sha}`, 'internal'); return p; });
  if (s.seq < 0) throw new OwedError('Not initialized: run owed init <plan.yaml> first');
  return s;
}

// ---------- single-driver lock (D6) ----------
/** Start time of a process (Linux `/proc/<pid>/stat` field 22), to tell a reused pid from the lock holder; else undefined. */
export function procStart(pid: number): string | undefined {
  try { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19]; } catch { return undefined; }
}
export interface LockOwner { pid: number; start?: string; host: string; at: string; token: string }
export function lockAlive(o: LockOwner): boolean {
  try { process.kill(o.pid, 0); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EPERM') return false; }
  const now = procStart(o.pid);
  return o.start === undefined || now === undefined || now === o.start;
}
/**
 * Takes `<ledger dir>/drive.lock` (the file appears complete: written aside, then hard-linked into place, which fails
 * when it exists). A lock whose pid is gone (or reused by another process) is stale and taken over; a live one refuses.
 * A lock of another host is never taken over (its pid cannot be checked here). Returns the release functions.
 */
export interface DriveLock { release(): Promise<void>; /** Synchronous release for a hard stop. */ releaseSync(): void }
export async function acquireDriveLock(dir: string): Promise<DriveLock> {
  const path = join(dir, 'drive.lock'), me: LockOwner = { pid: process.pid, ...(procStart(process.pid) ? { start: procStart(process.pid)! } : {}), host: hostname(), at: new Date().toISOString(), token: randomUUID() };
  const text = JSON.stringify(me);
  for (let i = 0; i < 10; i++) {
    const staged = `${path}.${me.token}`;
    await writeFile(staged, text);
    try { await link(staged, path); await rm(staged, { force: true }); }
    catch (e) {
      await rm(staged, { force: true });
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      let held: string;
      try { held = await readFile(path, 'utf8'); } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; throw err; }
      let owner: LockOwner | undefined;
      try { owner = JSON.parse(held) as LockOwner; } catch { owner = undefined; }
      if (owner && Number.isInteger(owner.pid) && owner.host !== hostname()) throw new OwedError(`another owed drive may be running for this repository: ${path} is held by pid ${owner.pid} on host ${owner.host} (since ${owner.at}); a lock of another host is never taken over: check that host, and if no driver runs there remove ${path} by hand`);
      if (owner && Number.isInteger(owner.pid) && lockAlive(owner)) throw new OwedError(`another owed drive is running for this repository (pid ${owner.pid} on ${owner.host}, since ${owner.at}); lock ${path}`);
      // Stale: move it aside, and put it back if what was moved is not what was judged stale (a racing takeover).
      const aside = `${path}.stale-${me.token}`;
      try { await rename(path, aside); } catch (err) { if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue; throw err; }
      const moved = await readFile(aside, 'utf8').catch(() => '');
      if (moved !== held) { try { await link(aside, path); } catch { /* another driver holds it now */ } }
      await rm(aside, { force: true });
      continue;
    }
    return {
      release: async () => { if (await readFile(path, 'utf8').catch(() => '') === text) await rm(path, { force: true }); },
      releaseSync: () => { try { if (readFileSync(path, 'utf8') === text) rmSync(path, { force: true }); } catch { /* gone */ } },
    };
  }
  throw new OwedError(`could not take ${path}`, 'internal');
}

// ---------- process helpers ----------
export const defaultOwed = (): string[] => [process.execPath, fileURLToPath(new URL('../bin/owed.js', import.meta.url))];
/** Process groups of direct `owed attest` children (no dsa), ended by a hard stop. */
const directChildren = new Set<number>();
function runProcess(argv: string[], cwd: string): Promise<{ exit: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
    const child = spawn(argv[0]!, argv.slice(1), { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    const pid = child.pid; if (pid) directChildren.add(pid);
    child.on('close', () => { if (pid) directChildren.delete(pid); });
    const out: Buffer[] = [], err: Buffer[] = [];
    child.stdout.on('data', (b: Buffer) => out.push(b)); child.stderr.on('data', (b: Buffer) => err.push(b));
    child.on('error', reject);
    child.on('close', code => resolve({ exit: code, stdout: Buffer.concat(out).toString('utf8'), stderr: Buffer.concat(err).toString('utf8') }));
  });
}
const tail = (s: string): string => oneLine(s.trim().split('\n').slice(-3).join(' | ')).slice(-500);
/** Test hook: `OWED_DRIVE_TEST_KILL=<before-dsa|after-dsa>:<launch|send>` SIGKILLs this process at that point (crash tests, D8.3). */
function crashPoint(point: 'before-dsa' | 'after-dsa', kind: 'launch' | 'send'): void {
  if (process.env.OWED_DRIVE_TEST_KILL === `${point}:${kind}`) process.kill(process.pid, 'SIGKILL');
}

// ---------- the driver ----------
/** Busy text without hold's ages ("(exclusive, 2s)" → "(exclusive)"), which change every pass (D14.6). */
export const busyKey = (text: string): string => text.replace(/,\s*\d+(?:\.\d+)?\s*(?:ms|s|m|h|d)\b/g, '').replace(/\s+\d+(?:\.\d+)?\s*(?:ms|s|m|h|d)\b(?=[,)])/g, '');

/**
 * A loop event line (`--json`: `{"event": …}`). `exit` is the last line of a `--json` loop driver (D17.2): code is the
 * process exit code, reason idle | stopped | killed | error (`error`: the text of what ended it).
 */
export type ExitReason = 'idle' | 'stopped' | 'killed' | 'error';
export interface LoopEvent { event: 'idle' | 'stopped' | 'killed' | 'cursor-reset' | 'events-error' | 'exit'; head?: string; reason?: string; error?: string; code?: number; at?: string }

/**
 * The text-mode line of a driver output object (an ActionReport or a LoopEvent): `owed drive` prints it, and the
 * background driver's JSON log is rendered with it (D17.3). An object that is neither is shown as escaped JSON.
 */
export function reportText(json: object): string {
  if ('event' in json) {
    const e = json as LoopEvent;
    switch (e.event) {
      case 'idle': return 'idle: nothing open and nothing ready';
      case 'stopped': return 'stopped';
      case 'killed': return 'killed: second signal, stopped at once';
      case 'cursor-reset': return e.reason !== undefined ? `events: cursor rejected (${oneLine(e.reason)}), reset${e.head ? ` to ${e.head}` : ''}` : `events: cursor expired, reset to ${e.head}`;
      case 'events-error': return `events error: ${oneLine(e.error ?? '')}`;
      case 'exit': return `driver exited ${e.code} (${e.reason})${e.error !== undefined ? `: ${oneLine(e.error)}` : ''}`;
      default: return oneLine(JSON.stringify(json));
    }
  }
  if (!('do' in json) || typeof (json as { do: unknown }).do !== 'string') return oneLine(JSON.stringify(json));
  const r = json as ActionReport;
  const what = r.do === 'launch' ? `launch ${r.node} ${r.role} ${r.rid}` : r.do === 'send' ? `send ${r.sendKind} (${r.reason}) to ${r.rid}${r.send ? ` [${r.send}]` : ''}` : r.do === 'halt' ? `halt ${r.node} attempt ${r.attempt} (needs ${r.needs})` : `${r.do} ${r.node}`;
  return r.do === 'notify' && r.text ? r.text : `${what}: ${r.outcome}${r.detail ? ` — ${r.detail}` : ''}`;
}

export class Driver {
  readonly facts = new Facts();
  private readonly o: DriveOptions; readonly dsa: Dsa; private readonly owed: string[];
  private ledger?: Ledger; private root?: string; project?: string;
  stopping = false;
  /**
   * Aborts the in-process ops calls that run checks (ops.merge, D16a.1): the immediate stop aborts it synchronously
   * before process.exit, so their check process groups get SIGKILL. A soft stop (`stopping`) lets the action finish.
   */
  readonly abort = new AbortController();
  constructor(o: DriveOptions) { this.o = o; this.dsa = o.dsa ?? new Dsa(); this.owed = o.owed ?? defaultOwed(); }

  private async init(): Promise<Ledger> {
    if (!this.ledger) { this.ledger = await Ledger.open(this.o.cwd); this.root = await git.mainRoot(this.o.cwd); }
    return this.ledger;
  }

  /**
   * Describe the live runs of every open, not halted attempt; ask dsa about recorded sends not yet confirmed; read the
   * stored bytes `decide` may need for retries. `rejected`: sends dsa reports rejected (this pass only).
   */
  private async observe(s: State): Promise<{ runs: Map<string, RunView>; blobs: Map<string, string>; rejected: Map<string, string> }> {
    const ledger = this.ledger!, runs = new Map<string, RunView>(), blobs = new Map<string, string>(), rejected = new Map<string, string>();
    const blob = async (sha: string) => { if (!blobs.has(sha)) { try { blobs.set(sha, (await ledger.getBlob(sha)).toString('utf8')); } catch { /* decide halts on a missing blob */ } } };
    for (const n of Object.values(s.nodes)) {
      if (!n.slot?.open || halted(s, n.id)) continue;
      const ar = n.runs.find(r => r.attempt === n.slot!.attempt), c = n.candidate;
      if (!ar) continue;
      for (const l of ar.launches.filter(l => l.role === 'writer' || (!!c && l.seq > c.seq))) {
        try {
          const { view, gen } = await this.dsa.inspect(l.rid);
          runs.set(l.rid, this.current(view, gen));
          if (view.state === 'absent') await blob(l.spec);
        } catch (e) { this.emit({ do: 'notify', node: n.id, outcome: 'describe-failed', detail: `describe ${l.rid}: ${tail((e as Error).message)}` }); }
      }
      // A recorded send this process has not confirmed: ask dsa whether it decided it (a previous driver process, or a
      // crash after the call); only an undecided one is re-sent (with the stored bytes and the same id, D13.1).
      for (const x of ar.sends) {
        if (this.facts.applied.has(x.send)) continue;
        try {
          const r = await this.dsa.request(x.send);
          if (r.state === 'applied') { this.facts.applied.add(x.send); continue; }
          if (r.state === 'rejected') { rejected.set(x.send, r.reason ?? 'rejected'); continue; }
        } catch { /* unknown: re-send; dsa returns the first outcome for the same id */ }
        await blob(x.message);
      }
    }
    return { runs, blobs, rejected };
  }

  /**
   * A follow-up applied in this process started generation g; until describe reports g, a sealed view is the previous
   * generation's (dsa's view lags the applied send), not the follow-up's outcome: present it as running.
   */
  private current(view: RunView, gen: number | undefined): RunView {
    if (gen !== undefined) this.facts.lastGen.set(view.rid, gen);
    const want = this.facts.expectGen.get(view.rid);
    if (want === undefined || gen === undefined) return view;
    if (gen >= want) { this.facts.expectGen.delete(view.rid); return view; }
    if (view.state !== 'sealed' && view.state !== 'pruned') return view;
    return { rid: view.rid, state: 'running', ...(view.wid ? { wid: view.wid } : {}), ...(view.labels ? { labels: view.labels } : {}) };
  }

  /**
   * One pass: load, observe, decide, execute in order (stops between actions when `stopping`). Verdicts are written to
   * the ledger by the action that meets them (D14), so nothing this pass learned decides a later pass. `progress`: the
   * ledger head advanced or dsa applied a request in this pass (D14.5).
   */
  async pass(): Promise<PassResult> {
    const ledger = await this.init(), s = await loadState(ledger), cfg = driveConfig(s.plan);
    this.project = projectId(s);
    const { runs, blobs, rejected } = await this.observe(s);
    const actions = decide(s, s.plan, runs, { max: this.o.max ?? cfg.max, repairs: cfg.repairs, project: this.project, root: this.root!, applied: this.facts.applied, rejected, blobs });
    const reports: ActionReport[] = []; let applied = false;
    for (const a of actions) {
      if (this.stopping) break;
      const r = await this.execute(s, a);
      reports.push(r.report); applied ||= r.applied;
      this.emit(r.report);
    }
    const head = (await ledger.read()).at(-1)?.hash;
    const open = Object.values(s.nodes).some(n => n.slot?.open);
    return { actions: reports, progress: applied || head !== s.head, idle: !open && !actions.some(a => a.do === 'dispatch') };
  }

  /** Prints a report; in the loop a notify / busy line for a node only when its text (without ages) changed. */
  emit(r: ActionReport): void {
    if (!this.o.once && (r.outcome === 'notify' || r.outcome === 'busy')) {
      const key = busyKey(r.text ?? r.detail ?? ''), slot = `${r.node}:${r.outcome}`;
      if (this.facts.printed.get(slot) === key) return;
      this.facts.printed.set(slot, key);
    } else if (r.do === 'attest') this.facts.printed.delete(`${r.node}:busy`);
    this.o.log(this.o.json ? JSON.stringify(r) : reportText(r));
  }

  private async halt(node: string, attempt: number, reason: string, needs: 'human' | 'owner' = 'human'): Promise<void> {
    await ops.halt({ cwd: this.o.cwd, as: DRIVE_PRINCIPAL, node, attempt, reason, needs });
  }

  /** Executes one action. `applied`: dsa applied a request (run/send) in it. */
  private async execute(s: State, a: Action): Promise<{ report: ActionReport; applied: boolean }> {
    const base: ActionReport = { do: a.do, node: a.node, outcome: 'done' };
    const cwd = this.o.cwd, as = DRIVE_PRINCIPAL;
    const done = (outcome: string, applied: boolean, detail?: string, extra: Partial<ActionReport> = {}) => ({ report: { ...base, ...extra, outcome, ...(detail ? { detail: oneLine(detail) } : {}) }, applied });
    try {
      switch (a.do) {
        case 'dispatch': { const r = await ops.dispatch({ cwd, as, node: a.node }); return done('done', false, `attempt ${r.attempt} in ${r.worktree}`); }
        case 'launch': {
          const extra = { attempt: a.attempt, role: a.role, rid: a.rid };
          await ops.launch({ cwd, as, node: a.node, attempt: a.attempt, role: a.role, rid: a.rid, spec: a.spec, labels: a.labels, ...(a.rulings !== undefined ? { rulings: a.rulings } : {}) });
          crashPoint('before-dsa', 'launch');
          const r = await this.dsa.run(a.rid, a.spec, a.labels);
          crashPoint('after-dsa', 'launch');
          if (r.outcome === 'applied') return done('applied', true, r.created ? 'created' : 'already created', extra);
          // D14.1/D15.1: a rejection is a verdict: halt in this pass. The id and bytes are fixed for the attempt, so a
          // cleared halt retries the same request and dsa rejects it again; the halt names the recovery (abandon).
          if (r.outcome === 'rejected') { await this.halt(a.node, a.attempt, rejectedHalt(a.node, 'run', a.rid, r.reason)); return done('rejected', false, `${r.reason}; halted`, extra); }
          if (r.outcome === 'conflict') { await this.halt(a.node, a.attempt, `dsa request-conflict on run ${a.rid} (recorded content differs${r.state ? `, state ${r.state}` : ''}); never retried with other bytes`); return done('conflict', false, 'halted', extra); }
          return done('pending', false, r.reason ?? 'retry next pass', extra);
        }
        case 'send': {
          const extra = { attempt: a.attempt, rid: a.rid, sendKind: a.sendKind, reason: a.reason };
          const id = a.send ?? (await ops.send({ cwd, as, node: a.node, attempt: a.attempt, rid: a.rid, sendKind: a.sendKind, message: a.message, reason: a.reason, ...(a.rulings !== undefined ? { rulings: a.rulings } : {}) })).send;
          crashPoint('before-dsa', 'send');
          const r = await this.dsa.send(id, a.rid, a.sendKind, a.message);
          crashPoint('after-dsa', 'send');
          const x = { ...extra, send: id };
          if (r.outcome === 'applied') {
            this.facts.applied.add(id);
            if (a.sendKind === 'follow-up') {
              const last = this.facts.lastGen.get(a.rid), gen = r.generation ?? (last !== undefined ? last + 1 : undefined);
              if (gen !== undefined) this.facts.expectGen.set(a.rid, gen);
            }
            return done('applied', true, a.send ? 're-sent' : undefined, x);
          }
          // D22.3: a rejected ruling steer (e.g. the call sealed meanwhile) is logged only: no halt, never retried.
          if (r.outcome === 'rejected' && a.reason === 'ruling') return done('rejected', false, `${r.reason}; not retried (the rulings travel with the next repair and reviewer acks)`, x);
          if (r.outcome === 'rejected') { await this.halt(a.node, a.attempt, rejectedHalt(a.node, 'send', id, r.reason)); return done('rejected', false, `${r.reason}; halted`, x); }
          if (r.outcome === 'conflict') { await this.halt(a.node, a.attempt, `dsa request-conflict on send ${id}; never retried with other bytes`); return done('conflict', false, 'halted', x); }
          return done('pending', false, r.reason ?? 'retry next pass', x);
        }
        case 'attest': return { report: await this.attest(s, a.node), applied: false };
        case 'rebase': { const r = await ops.rebase({ cwd, as, node: a.node }); return done('done', false, `slot base ${r.from.slice(0, 12)} → ${r.base.slice(0, 12)}`); }
        case 'merge': {
          try { const r = await ops.merge({ cwd, as, node: a.node, signal: this.abort.signal }); return done('merged', false, `trunk ${r.commit.slice(0, 12)}`); }
          catch (e) {
            if (!(e instanceof OwedError) || e.code !== 'refused') throw e;
            // D14.2: the refusal is acted on in this pass: rebase when trunk moved under a conflicting candidate, else halt.
            const attempt = s.nodes[a.node]!.slot!.attempt;
            // D15.2: another writer moved the ledger while merge measured; nothing was recorded: retry next pass.
            if (e.message === MERGE_TRANSIENT) return done('retry', false, `merge refused (${e.message}); retry next pass`);
            if (e.message.startsWith('rebase needed')) {
              const r = await ops.rebase({ cwd, as, node: a.node });
              return done('rebased', false, `merge refused (${e.message}); slot base ${r.from.slice(0, 12)} → ${r.base.slice(0, 12)}`);
            }
            const owner = /trunk changed \(CAS\)/.test(e.message);
            await this.halt(a.node, attempt, `merge refused: ${e.message}`, owner ? 'owner' : 'human');
            return done('refused', false, `${e.message}; halted (needs ${owner ? 'owner' : 'human'})`);
          }
        }
        case 'halt': await this.halt(a.node, a.attempt, a.reason, a.needs); return done('halted', false, a.reason, { attempt: a.attempt, needs: a.needs });
        case 'notify': return { report: { ...base, outcome: 'notify', text: a.text }, applied: false };
      }
    } catch (e) {
      if (e instanceof OwedError || e instanceof DsaError) return done('error', false, e.message);
      throw e;
    }
  }

  /**
   * `pi-durable-subagents hold machine --shared --no-wait -- owed attest <node>` when dsa is available (D6/D9, dsa >=
   * 1.0.27), else `owed attest <node>`. Exit 0/1: done (the ledger says what follows). Exit 75 is hold refusing the
   * lease (`owed` itself exits 0..3): busy, nothing was queued, retry next pass. Anything else — an owed error (2/3), a
   * signal, dsa rejecting the invocation (an older dsa without `--no-wait`) — halts needing a human in this pass (D14.3).
   */
  private async attest(s: State, node: string): Promise<ActionReport> {
    const argv = [...this.owed, 'attest', node], cwd = this.root!, attempt = s.nodes[node]!.slot!.attempt;
    const report = (outcome: string, detail?: string): ActionReport => ({ do: 'attest', node, outcome, ...(detail ? { detail: oneLine(detail) } : {}) });
    const fail = async (why: string): Promise<ActionReport> => { await this.halt(node, attempt, `attest error: ${why}`); return report('error', `${why}; halted`); };
    let ran: { exit: number | null; stdout: string; stderr: string };
    if (dsaAvailable(this.dsa.bin)) {
      const r = await this.dsa.hold('machine', argv, { shared: true, cwd });
      if (r.outcome === 'busy') return report('busy', `machine lease refused, retry next pass: ${tail(r.reason)}`);
      if (r.outcome === 'signal') return fail(`pi-durable-subagents hold ended by ${r.reason}`);
      if (r.outcome === 'refused') return fail(`pi-durable-subagents hold refused: ${tail(r.reason)}${/--no-wait/.test(r.reason) ? ' (owed drive requires pi-durable-subagents >= 1.0.27 for `hold --no-wait`)' : ''}`);
      ran = r;
    } else {
      try { ran = await runProcess(argv, cwd); } catch (e) { return fail(`cannot run ${argv[0]}: ${(e as Error).message}`); }
    }
    if (ran.exit === 0 || ran.exit === 1) return report('done', ran.exit === 0 ? 'accepted' : 'not accepted yet');
    return fail(`owed attest exited ${ran.exit ?? 'by a signal'}: ${tail(ran.stderr || ran.stdout)}`);
  }
}

/**
 * One pass for the pi tool (`owed_drive`): the output lines of the actions executed, also when a later step throws
 * (then `error` is its message) (D14.8).
 */
export async function driveOnce(o: Omit<DriveOptions, 'once' | 'log'>): Promise<{ lines: string[]; error?: string }> {
  const lines: string[] = [];
  // In-process (the pi session): no signal handlers, which would exit the host process.
  try { await drive({ ...o, once: true, handleSignals: false, log: l => lines.push(l) }); return { lines }; }
  catch (e) { return { lines, error: e instanceof Error ? e.message : String(e) }; }
}

/**
 * `/owed` status lines of the live driver runs of open attempts with their dsa state (D7): `<node> <role> <rid>: <state>
 * [status]`. Empty when dsa is unavailable or nothing was launched; a failed describe shows `describe failed`.
 */
export async function liveRunLines(cwd: string, dsa: Dsa = new Dsa({ timeoutMs: 10_000 })): Promise<string[]> {
  if (!dsaAvailable(dsa.bin)) return [];
  const s = await loadState(await Ledger.open(cwd)), lines: string[] = [];
  for (const n of Object.values(s.nodes)) {
    const ar = n.slot?.open ? n.runs.find(r => r.attempt === n.slot!.attempt) : undefined, c = n.candidate;
    for (const l of ar?.launches.filter(l => l.role === 'writer' || (!!c && l.seq > c.seq)) ?? []) {
      let state: string;
      try { const v = await dsa.describe(l.rid); state = `${v.state}${v.status ? ` ${v.status}` : ''}`; } catch { state = 'describe failed'; }
      lines.push(`${n.id} ${l.role} ${l.rid}: ${state}`);
    }
  }
  return lines;
}

// ---------- the loop ----------
const sleep = (ms: number, signal: AbortSignal): Promise<void> => new Promise(resolve => {
  if (signal.aborted) { resolve(); return; }
  const t = setTimeout(done, ms);
  function done() { clearTimeout(t); signal.removeEventListener('abort', done); resolve(); }
  signal.addEventListener('abort', done);
});

/**
 * `owed drive`: takes the single-driver lock, then one pass (`once`), or the loop: passes back to back while they make
 * progress (at most 20), then wait for an `events --all` event labeled with this project (polled every `pollMs`) or
 * `passMs`, whichever comes first. Exits 0 when idle (nothing open, nothing to dispatch) or after SIGINT/SIGTERM (or
 * `signal`) once the current action is done; a second signal exits 130 at once (with `once`, the first one does). A live driver refuses with
 * OwedError('refused').
 * In `--json` loop mode the last line is the exit record `{"event":"exit","code","reason","at","error"?}` (D17.2),
 * written before the lock is released (D17a.2), so a released lock means the record is in the log. A failure (drive
 * threw, the lock refused) is that record plus the CLI exit code (refused 1, usage 2, else 3) instead of a throw, so a
 * background driver's log always ends with it (unless SIGKILL or a crash).
 */
export async function drive(o: DriveOptions): Promise<number> {
  if (o.once || !o.json) return driveLoop(o, {});
  const end: LoopEnd = { record: true };
  try { return await driveLoop(o, end); }
  catch (e) {
    const code = errorCode(e);
    // Written by driveLoop when it held the lock; else (no lock: Ledger.open or the lock refused) here.
    if (!end.written) o.log(exitRecord(code, 'error', e instanceof Error ? e.message : String(e)));
    return code;
  }
}
const exitRecord = (code: number, reason: ExitReason, error?: string): string => JSON.stringify({ event: 'exit', code, reason, at: new Date().toISOString(), ...(error !== undefined ? { error } : {}) });
const errorCode = (e: unknown): number => e instanceof OwedError ? (e.code === 'refused' ? 1 : e.code === 'usage' ? 2 : 3) : 3;
/** `record`: write the exit record (`--json` loop); `reason`: how the loop ended; `written`: the record is out. */
interface LoopEnd { record?: boolean; reason?: ExitReason; written?: boolean }

async function driveLoop(o: DriveOptions, end: LoopEnd): Promise<number> {
  const driver = new Driver(o), stop = new AbortController();
  let lock: DriveLock | undefined;
  const say = (line: string, json: object) => o.log(o.json ? JSON.stringify(json) : line);
  const onAbort = () => { driver.stopping = true; stop.abort(); };
  let signals = 0;
  // Loop: the first SIGINT/SIGTERM stops after the current action; the second stops at once (D14.8). `--once`: the
  // first stops at once (D16.3). At once = end the running dsa invocations (hold passes SIGTERM to `owed attest`) and
  // the process groups of direct attest children (attest then ends its checks, D16.2), write the killed line (and in a
  // `--json` loop the exit record, before the release: D17a.2), release the lock, exit 130. The
  // ledger stays consistent: every entry is appended whole, and attest records its own observations. An in-process merge
  // is aborted first (D16a.1: its checks get SIGKILL; a stop between advanceTrunk and the append surfaces as CAS drift).
  // One stop request is one signal per process group (D16a.3): this path runs once (it ends in process.exit, which is
  // synchronous), killAll signals each pid of dsa's live set once, and directChildren holds only `owed attest` children
  // spawned by runProcess, never a dsa invocation, so the two sets are disjoint and no group is signalled twice.
  // The handlers are installed before the lock is taken (D17a.6): in the loop a signal while starting stops it at its
  // first check; with `once` it stops at once as above (no lock yet: nothing to release).
  const onSignal = () => {
    if (!o.once && ++signals === 1) { onAbort(); return; }
    driver.abort.abort();
    driver.dsa.killAll('SIGTERM');
    for (const pid of directChildren) { try { process.kill(-pid, 'SIGTERM'); } catch { /* gone */ } }
    say(o.once ? 'killed: signal, stopped at once' : 'killed: second signal, stopped at once', { event: 'killed' });
    if (end.record && !end.written) { o.log(exitRecord(130, 'killed')); end.written = true; }
    lock?.releaseSync();
    process.exit(130);
  };
  const handle = o.handleSignals !== false;
  if (handle) { process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal); }
  o.signal?.addEventListener('abort', onAbort);
  if (o.signal?.aborted) onAbort();
  let failure: { e: unknown } | undefined;
  try {
    const ledger = await Ledger.open(o.cwd);
    lock = await acquireDriveLock(ledger.dir);
    if (!o.once && driver.stopping) { say('stopped', { event: 'stopped' }); end.reason = 'stopped'; return 0; }
    if (o.once) { const r = await driver.pass(); if (r.idle) say('idle: nothing open and nothing ready', { event: 'idle' }); return 0; }
    const dsa = driver.dsa, cursorFile = join(ledger.dir, 'drive', 'cursor'), LIMIT = o.limit ?? 100;
    await mkdir(join(ledger.dir, 'drive'), { recursive: true });
    let cursor: string | undefined = (await readFile(cursorFile, 'utf8').catch(() => '')).trim() || undefined, limit = LIMIT, lastError = '';
    const save = async (c: string) => { cursor = c; await writeFile(cursorFile, `${c}\n`); };
    /**
     * True when an event of this project arrived, or the cursor was reset (expired, exit 4, or rejected, D14.7): a pass
     * then re-derives everything. The page limit halves only after a page the client could not parse and returns to
     * the default after a good page; any other failure (e.g. a missing binary) is printed, not a smaller page.
     */
    const poll = async (): Promise<boolean> => {
      try {
        if (cursor === undefined) { const h = await dsa.events(); if (h.outcome === 'applied') await save(h.head); return false; }
        let wake = false;
        for (let page = 0; page < 50; page++) {
          const r = await dsa.events(cursor, limit);
          if (r.outcome === 'expired') { await save(r.head); say(`events: cursor expired, reset to ${r.head}`, { event: 'cursor-reset', head: r.head }); return true; }
          if (r.outcome === 'rejected') {
            cursor = undefined;
            const h = await dsa.events();
            if (h.outcome === 'applied') await save(h.head);
            say(`events: cursor rejected (${oneLine(r.reason)}), reset${cursor ? ` to ${cursor}` : ''}`, { event: 'cursor-reset', reason: r.reason, ...(cursor ? { head: cursor } : {}) });
            return true;
          }
          if (r.outcome !== 'applied') return wake;
          limit = LIMIT; lastError = '';
          wake ||= r.events.some(e => e.labels?.owed === driver.project);
          await save(r.head);
          if (!r.more) break;
        }
        return wake;
      } catch (e) {
        if (!(e instanceof DsaError)) throw e;
        if (/missing head line|unparsable/.test(e.message)) limit = Math.max(1, Math.floor(limit / 2));
        else if (e.message !== lastError) { lastError = e.message; say(`events error: ${oneLine(e.message)}`, { event: 'events-error', error: e.message }); }
        return false;
      }
    };
    await poll();
    for (;;) {
      for (let burst = 0; burst < 20 && !driver.stopping; burst++) {
        const r = await driver.pass();
        if (r.idle) { say('idle: nothing open and nothing ready', { event: 'idle' }); end.reason = 'idle'; return 0; }
        if (!r.progress) break;
      }
      const last = Date.now();
      while (!driver.stopping) {
        await sleep(o.pollMs ?? 3000, stop.signal);
        if (driver.stopping || Date.now() - last >= (o.passMs ?? 30_000) || await poll()) break;
      }
      if (driver.stopping) { say('stopped', { event: 'stopped' }); end.reason = 'stopped'; return 0; }
    }
  } catch (e) { failure = { e }; throw e; }
  finally {
    if (handle) { process.off('SIGINT', onSignal); process.off('SIGTERM', onSignal); }
    o.signal?.removeEventListener('abort', onAbort);
    // D17a.2: the exit record precedes the release; it stays the last line (nothing is printed after it).
    if (end.record && lock && !end.written) {
      o.log(failure ? exitRecord(errorCode(failure.e), 'error', failure.e instanceof Error ? failure.e.message : String(failure.e)) : exitRecord(0, end.reason ?? 'stopped'));
      end.written = true;
    }
    await lock?.release();
  }
}
