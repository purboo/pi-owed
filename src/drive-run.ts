// owed drive: the executor and the loop (SPEC §12.7, contract D6/D7/D9). One pass = load the ledger state, describe
// every live launch of the open attempts, `decide` (pure, src/drive.ts), execute the actions in order. Persist before
// submit: a launch/send entry is appended before the dsa call, and a retry re-sends the stored bytes with the same id.
// Verdicts (dsa rejections and conflicts, merge refusals, attest errors) are written to the ledger in the pass that meets
// them (D14); what this process keeps across passes are caches of dsa's answers (applied sends, follow-up generations),
// so losing it (a crash, a restart) is harmless: the ledger plus `describe` re-derive the state.
import { spawn } from 'node:child_process';
import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { closeSync, fstatSync, openSync, readFileSync, readSync, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as ops from './ops.ts';
import * as git from './git.ts';
import { Ledger } from './ledger.ts';
import { parsePlan, driveConfig, measureCap } from './plan.ts';
import { reduce, halted, projectId, waitingFor } from './reducer.ts';
import { DRIVER, entriesOf } from './reducer.ts';
import { callAt, decide, rejectedHalt, wantsRebaseConflicts } from './drive.ts';
import type { Action } from './drive.ts';
import { Dsa, DsaError, dsaAvailable, startingSession } from './dsa.ts';
import { OwedError } from './errors.ts';
import { oneLine } from './views.ts';
import type { Plan, Principal, RunView, State } from './types.ts';

/**
 * Trunk drift (review ruling #559, option c): the trunk ref no longer equals the ledger trunk. It is a repository fact,
 * not a node fact: never a ledger halt. The text of the repo-level owner notify: a fast-forward is adopted, anything
 * else (rewound, rewritten, missing) is restored.
 */
export function driftNotice(name: string, d: git.TrunkDrift): string {
  const ledger = d.ledger.slice(0, 12), ref = d.commit ? d.commit.slice(0, 12) : 'missing';
  // G3.4c: the ledger's trunk commit is gone, so neither update-ref nor adopt (it checks a fast-forward from it) works yet.
  if (d.relation === 'ledger-missing') return `trunk ${name}: the ledger's trunk commit ${ledger} is absent from the repository, so git update-ref cannot restore it and owed adopt cannot check a fast-forward from it; bring the commit back (git fetch <remote> ${d.ledger} from any remote or clone that has it), then restore trunk (git update-ref refs/heads/${name} ${d.ledger} ${d.commit ?? '""'}) or adopt the current ref (owed adopt --commit ${ref} --note "<why>")`;
  return d.relation === 'ahead'
    ? `trunk ${name} moved outside owed (${ledger} → ${ref}); the main agent resolves it with: owed adopt --note "<why>"`
    : `trunk ${name} was rewound or rewritten (${ledger} → ${ref}); restore it: git update-ref refs/heads/${name} ${d.ledger} ${d.commit ?? '""'}`;
}
/**
 * The node name of the repo-level drift notify. A plan node may also be named `trunk`: the drift report carries
 * `scope: 'repo'`, and its print and wake records are keyed apart from the node's (`reportKey`, G3.4b).
 */
export const DRIFT_NODE = 'trunk';
/** The drift notify report; `facts` = the ledger trunk's seq, so it prints and wakes once per change. */
const driftReport = (s: State, d: git.TrunkDrift): ActionReport => ({ do: 'notify', node: DRIFT_NODE, scope: 'repo', outcome: 'notify', text: driftNotice(s.trunk.name, d), facts: s.trunk.seq });
/** The key of a report's print and wake records (G3.4b): repo-level reports never share one with a plan node of the same name. */
export const reportKey = (r: { node?: unknown; scope?: unknown }): string => `${r.scope === 'repo' ? 'repo' : 'node'}\u0000${String(r.node)}`;
/** The key of the drift notify's records. */
export const DRIFT_KEY = reportKey({ node: DRIFT_NODE, scope: 'repo' });
/**
 * G3.7: the paths that conflict when `commit` (a previous candidate) is merged onto `base`: `git merge-tree --write-tree
 * --name-only --no-messages -z` (exit 0: clean, []; exit 1: the conflicted paths after the tree line); undefined on failure.
 */
export async function rebaseConflicts(cwd: string, base: string, commit: string): Promise<string[] | undefined> {
  // -z: NUL-terminated, paths neither quoted nor escaped (review #680 b).
  const r = await git.git(cwd, ['merge-tree', '--write-tree', '--name-only', '--no-messages', '-z', base, commit], { allowFail: true }).catch(() => undefined);
  if (!r || (r.code !== 0 && r.code !== 1)) return undefined;
  const lines = r.stdout.split('\0').filter(Boolean);
  if (!lines.length || !/^[0-9a-f]{40,64}$/.test(lines[0]!)) return undefined;
  return r.code === 0 ? [] : [...new Set(lines.slice(1))];
}
/** The transient merge refusal of `ops` (the plan, the candidate or trunk changed while merge measured). */
const MERGE_TRANSIENT = 'Plan, candidate or trunk changed; retry';

/** The driver's principal (`parent:drive`, contract D3). */
export const DRIVE_PRINCIPAL: Principal = { role: 'parent', id: 'drive' };

export interface DriveOptions {
  /** A directory inside the repository. */
  cwd: string;
  /** One pass, then wait for the measurements it started and handle them (K6), then exit (no events are read). */
  once?: boolean;
  /** Overrides `drive.max` of the plan. */
  max?: number;
  /**
   * Loop only (H1.2, `--stay`): an idle pass does not exit; the driver logs `idle-wait` once per idle period, keeps the
   * lock and waits (polling every `pollMs`) until the ledger head changes, then resumes passes.
   */
  stay?: boolean;
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
  /**
   * Stops the loop after the current action, once the in-flight measurements ended and were handled (K6; tests and the
   * pi tool; the CLI uses SIGINT/SIGTERM).
   */
  signal?: AbortSignal;
  /** Install SIGINT/SIGTERM handlers (default true; loop: D14.8, `once`: D16.3); the pi tool's pass installs none. */
  handleSignals?: boolean;
  /**
   * The pi session the driver's runs belong to (E1): recorded in `drive.lock` and passed as `run --session`. Default
   * `startingSession()` (`$DSA_SESSION`, ignored inside a dsa call); null: none.
   */
  session?: string | null;
}

/** One executed action as printed (`--json`: one object per line). */
export interface ActionReport {
  do: Action['do']; node: string; outcome: string; detail?: string;
  /** `repo`: a repository-level report (the trunk drift notify), not about the plan node named `node`. */
  scope?: 'repo';
  attempt?: number; role?: string; rid?: string; send?: string; sendKind?: string; reason?: string; needs?: string; text?: string;
  /** An asking notify (H1.1b): the first open question of run `rid`; fields of the log line, not of the ledger. */
  qid?: string; rev?: number;
  /** Wake reports (E3.1): the node's fact mark (`factMark`) in the state the pass decided on. */
  facts?: number;
  /** Loop only (E3.1): the same text and fact mark as this node's last printed wake, for the n-th time. */
  repeat?: number;
  /** A measurement's `started` line (K6): when it started (ISO); `owed drive --status` reads it from the log. */
  at?: string;
}

/** D25.6: how a halt or refusal that needs the owner is worded in the driver's output. */
export const NEEDS_OWNER = 'needs the owner (the main agent decides; owed lists the command)';
/**
 * Reports that wake a following session (D17.7): halts, notifies (questions, owner-needed, describe failures) and the
 * outcomes rejected, conflict, refused and error.
 */
export const wakeReport = (r: { do?: unknown; outcome?: unknown }): boolean => r.do === 'halt' || r.do === 'notify' || ['rejected', 'conflict', 'refused', 'error'].includes(String(r.outcome));
/**
 * The fact mark of a node (E3.1): the highest seq of the ledger entries naming it (`node`, an observation's `subject`,
 * a ruling listing it) not written by the driver (`parent:drive`: its launches, sends, halts, dispatches, rebases and
 * merges are consequences, not new facts); 0 when there is none. Writer, parent, reviewer and owner entries and
 * executor observations count. A wake whose text and mark equal the last one delivered for the node brings nothing new.
 */
export function factMark(s: State, node: string): number {
  let mark = 0;
  for (const e of entriesOf(s)) {
    if (e.by === DRIVER) continue;
    const names = e.kind === 'obs' ? e.subject === node : e.kind === 'rule' ? e.nodes !== '*' && e.nodes.includes(node) : 'node' in e && e.node === node;
    if (names && e.seq > mark) mark = e.seq;
  }
  return mark;
}
/** Suffix of a repeated wake line (E3.1). */
export const repeatText = (n: number): string => ` (repeat ${n}, no new ledger entries)`;
export interface PassResult {
  actions: ActionReport[]; progress: boolean; idle: boolean;
  /** The ledger head (hash of the last entry) the pass decided on (H1.2: a staying driver's idle baseline). */
  head: string;
  /** 0.8 (L1.5): open attempts waiting for another node to merge (a resume with `after`), in status order. */
  waiting: { node: string; after: string; resume: number }[];
}

/**
 * Caches of dsa's own answers this process may reuse across passes (D14: they never carry a verdict): send ids dsa
 * reported applied, follow-up generations, and what the loop last printed. Verdicts (rejections, merge refusals,
 * attest errors) are written to the ledger in the pass they happen.
 */
class Facts {
  readonly applied = new Set<string>();
  /** Send ids dsa decided `rejected` (terminal: never asked again in this process), with dsa's reason (review #784 F1). */
  readonly refused = new Map<string, string>();
  /** rid → generation a follow-up applied in this process started; a describe of an older, sealed generation is stale. */
  readonly expectGen = new Map<string, number>();
  /** rid → latest generation describe reported. */
  readonly lastGen = new Map<string, number>();
  /** rid → state of the latest view describe reported in this process (G3.6). */
  readonly lastState = new Map<string, RunView['state']>();
  /** rid → dsa's call address `<wid>/<key>` the latest view describe reported in this process (0.8, L1.4). */
  readonly lastTo = new Map<string, string>();
  /** `<reportKey>:<kind>` → last printed text key (notify, machine busy): the loop prints a line only when it changed. */
  readonly printed = new Map<string, string>();
  /** reportKey → the last wake printed for it (text without the repeat suffix, fact mark) and how often it repeated (E3.1). */
  readonly wakes = new Map<string, { text: string; facts: number; n: number }>();
  /** A drift notify was emitted and no pass has seen trunk equal to the ledger trunk since (G3.4a). */
  drift = false;
}

/**
 * A measurement in flight (0.7.0, K6): an `owed attest` child or an in-process `ops.merge`, from its start until the
 * loop has handled its result. `ended` settles (never rejects) when the work ended; `finish` then turns the raw result
 * into reports on the loop, with the halts and rebases of SPEC §12.7.
 */
interface Measurement {
  do: 'attest' | 'merge'; node: string; attempt: number; at: string;
  ended: Promise<void>;
  done: boolean;
  finish?: () => Promise<ActionReport[]>;
}
/** How a measurement ended: `finish` handles it on the loop; `busy` (attest only): its report, handled at once instead. */
interface Ended { finish: () => Promise<ActionReport[]>; busy?: ActionReport }
/** Hard stop (SPEC §12.7 Stopping): how long it waits for in-flight measurements after SIGTERM, then after SIGKILL. */
const HARD_WAIT_MS = 5000, KILL_WAIT_MS = 1000;
/** The text of a busy attest: owed's own busy exit (K1: another attest of the node runs), else hold refusing the lease. */
const busyDetail = (node: string, reason: string): string => /attest of \S+ is already running/.test(reason)
  ? `another attest of ${node} is running, retry next pass: ${reason.replace(/^Busy: /, '')}`
  : `machine lease refused, retry next pass: ${reason}`;

// ---------- ledger state ----------
/** The ledger state of the repository of `cwd` (wake revalidation, ready hint). */
export async function stateOf(cwd: string): Promise<State> { return loadState(await Ledger.open(cwd)); }
/**
 * Nodes the driver would dispatch now (H1.3): the `dispatch` actions of `decide` on the current state (same readiness,
 * `drive.max`, writes overlap and owner-needed rules), with no run views (open attempts get no action from them).
 */
export async function dispatchable(cwd: string): Promise<string[]> {
  const s = await stateOf(cwd), cfg = driveConfig(s.plan);
  const actions = decide(s, s.plan, new Map(), { max: cfg.max, repairs: cfg.repairs, project: projectId(s), root: await git.mainRoot(cwd), applied: new Set(), rejected: new Map() });
  return actions.filter(a => a.do === 'dispatch').map(a => a.node);
}
/**
 * The ledger head of `<dir>/ledger.jsonl`: the `hash` of its last complete entry (comparable with `State.head`), read
 * from the file's end (the whole file only when the last entry is longer than the tail); '' when there is none (H1.2).
 */
export function ledgerHead(dir: string): string {
  let fd: number;
  try { fd = openSync(join(dir, 'ledger.jsonl'), 'r'); } catch { return ''; }
  const hashOf = (line: string | undefined): string | undefined => {
    if (!line) return undefined;
    try { const h = (JSON.parse(line) as { hash?: unknown }).hash; return typeof h === 'string' ? h : undefined; } catch { return undefined; }
  };
  try {
    const size = fstatSync(fd).size;
    for (const tail of [64 * 1024, size]) {
      const from = Math.max(0, size - tail), buf = Buffer.alloc(size - from);
      const n = readSync(fd, buf, 0, buf.length, from), text = buf.subarray(0, n).toString('utf8');
      // Only complete lines: an entry being appended (no newline yet) is not the head.
      const lines = text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(l => l.trim());
      const h = hashOf(lines.at(-1));
      if (h !== undefined || from === 0) return h ?? '';
    }
    return '';
  } finally { closeSync(fd); }
}

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
/** `session`: the pi session that lists the driver's runs (E1); absent when none. */
export interface LockOwner { pid: number; start?: string; host: string; at: string; token: string; session?: string }
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
export async function acquireDriveLock(dir: string, session?: string): Promise<DriveLock> {
  const path = join(dir, 'drive.lock'), me: LockOwner = { pid: process.pid, ...(procStart(process.pid) ? { start: procStart(process.pid)! } : {}), host: hostname(), at: new Date().toISOString(), token: randomUUID(), ...(session ? { session } : {}) };
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
export interface LoopEvent { event: 'idle' | 'idle-wait' | 'stopped' | 'killed' | 'cursor-reset' | 'events-error' | 'exit' | 'session-unsupported' | 'drift-cleared' | 'waiting'; head?: string; reason?: string; error?: string; code?: number; at?: string; session?: string; /** `waiting` (0.8, L1.5): the waiting node, the node it waits for and the resume entry. */ node?: string; after?: string; resume?: number }
/** 0.8 (L1.5): text of a `waiting` loop event. */
export const waitingText = (node: string, after: string, resume: number): string => `waiting: ${node} waits for ${after} (resume #${resume})`;
/** Text of the `idle-wait` line of a staying driver (H1.2). */
export const IDLE_WAIT_TEXT = 'idle: nothing open and nothing ready; staying until the ledger changes (owed drive --stop ends it)';

/**
 * The text-mode line of a driver output object (an ActionReport or a LoopEvent): `owed drive` prints it, and the
 * background driver's JSON log is rendered with it (D17.3). An object that is neither is shown as escaped JSON.
 */
export function reportText(json: object): string {
  if ('event' in json) {
    const e = json as LoopEvent;
    switch (e.event) {
      case 'idle': return 'idle: nothing open and nothing ready';
      case 'idle-wait': return IDLE_WAIT_TEXT;
      case 'stopped': return 'stopped';
      case 'killed': return 'killed: second signal, stopped at once';
      case 'cursor-reset': return e.reason !== undefined ? `events: cursor rejected (${oneLine(e.reason)}), reset${e.head ? ` to ${e.head}` : ''}` : `events: cursor expired, reset to ${e.head}`;
      case 'events-error': return `events error: ${oneLine(e.error ?? '')}`;
      case 'exit': return `driver exited ${e.code} (${e.reason})${e.error !== undefined ? `: ${oneLine(e.error)}` : ''}`;
      case 'drift-cleared': return 'trunk drift cleared: trunk equals the ledger trunk again';
      case 'waiting': return waitingText(oneLine(e.node ?? '?'), oneLine(e.after ?? '?'), e.resume ?? -1);
      case 'session-unsupported': return `dsa does not accept --session (older than pi-durable-subagents 1.0.31): runs start without it and are not listed in pi session ${e.session ?? '?'}${e.reason ? ` (${oneLine(e.reason)})` : ''}`;
      default: return oneLine(JSON.stringify(json));
    }
  }
  if (!('do' in json) || typeof (json as { do: unknown }).do !== 'string') return oneLine(JSON.stringify(json));
  const r = json as ActionReport;
  const what = r.do === 'launch' ? `launch ${r.node} ${r.role} ${r.rid}` : r.do === 'send' ? `send ${r.sendKind} (${r.reason}) to ${r.rid}${r.send ? ` [${r.send}]` : ''}` : r.do === 'halt' ? (r.needs === 'owner' ? `halt ${r.node} attempt ${r.attempt}, ${NEEDS_OWNER}` : `halt ${r.node} attempt ${r.attempt} (needs ${r.needs})`) : `${r.do} ${r.node}`;
  const repeat = typeof r.repeat === 'number' && r.repeat > 0 ? repeatText(r.repeat) : '';
  return `${r.do === 'notify' && r.text ? r.text : `${what}: ${r.outcome}${r.detail ? ` — ${r.detail}` : ''}`}${repeat}`;
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
  /** K6: measurements in flight by node, in start order; `ended`: those that ended and await `reap`, in end order. */
  readonly measuring = new Map<string, Measurement>();
  private readonly ended: Measurement[] = [];
  /** Ends the loop's current `wait` (a measurement ended). */
  private waker?: () => void;
  /**
   * Busy back-off (review #785): the loop's timed/event pass count (`tick`), and per node the count at which its attest
   * ended busy. A node does not start a measurement again in the same count: not before the next timed or event pass.
   */
  private cycle = 0;
  private readonly busyAt = new Map<string, number>();
  /** The loop calls this before a pass started by its timer or by a dsa event (not by a measurement ending). */
  tick(): void { this.cycle++; }
  /** A stop at once runs: ended measurements are not handled (their results are not recorded by the driver). */
  hard = false;
  /** The pi session of this driver's runs (E1). */
  readonly session?: string;
  constructor(o: DriveOptions) {
    this.o = o; this.dsa = o.dsa ?? new Dsa(); this.owed = o.owed ?? defaultOwed();
    const session = o.session === undefined ? startingSession() : o.session ?? undefined;
    if (session !== undefined) this.session = session;
    // E1.2: every `run` names the session; an older dsa refuses the flag once per driver: logged, never a halt.
    this.dsa.session = session;
    this.dsa.onSessionRefused = reason => {
      const e: LoopEvent = { event: 'session-unsupported', ...(session !== undefined ? { session } : {}), reason };
      o.log(o.json ? JSON.stringify(e) : reportText(e));
    };
  }

  private async init(): Promise<Ledger> {
    if (!this.ledger) { this.ledger = await Ledger.open(this.o.cwd); this.root = await git.mainRoot(this.o.cwd); }
    return this.ledger;
  }

  /**
   * Describe the live runs of every open, not halted attempt; ask dsa about recorded sends not yet confirmed; read the
   * stored bytes `decide` may need for retries. `rejected`: the attempt's sends dsa decided rejected (every pass; cached
   * once terminal) and the runs and sends rejected in this process.
   */
  private async observe(s: State, measuring: ReadonlySet<string>): Promise<{ runs: Map<string, RunView>; blobs: Map<string, string>; rejected: Map<string, string>; conflicts: Map<string, string[]> }> {
    const ledger = this.ledger!, runs = new Map<string, RunView>(), blobs = new Map<string, string>(), rejected = new Map<string, string>(), conflicts = new Map<string, string[]>();
    const blob = async (sha: string) => { if (!blobs.has(sha)) { try { blobs.set(sha, (await ledger.getBlob(sha)).toString('utf8')); } catch { /* decide halts on a missing blob */ } } };
    for (const n of Object.values(s.nodes)) {
      // K6: a node with a measurement in flight gets no action this pass: its runs are not described.
      if (!n.slot?.open || halted(s, n.id) || measuring.has(n.id)) continue;
      const ar = n.runs.find(r => r.attempt === n.slot!.attempt), c = n.candidate;
      if (!ar) continue;
      for (const l of ar.launches.filter(l => l.role === 'writer' || (!!c && l.seq > c.seq))) {
        try {
          const { view, gen } = await this.dsa.inspect(l.rid);
          runs.set(l.rid, this.current(view, gen));
          if (view.state === 'absent') await blob(l.spec);
        } catch (e) { this.emit({ do: 'notify', node: n.id, outcome: 'describe-failed', detail: `describe ${l.rid}: ${tail((e as Error).message)}` }, s); }
      }
      // G3.7: the files the previous candidate conflicts on, only when row 8 sends a rebase instruction (review #680 b).
      const rb = n.slot.rebase;
      if (rb?.previous && wantsRebaseConflicts(s, n.id, runs)) { const x = await rebaseConflicts(this.root!, rb.base, rb.previous.commit); if (x) conflicts.set(n.id, x); }
      // A recorded send this process has not confirmed: ask dsa whether it decided it (a previous driver process, or a
      // crash after the call); only an undecided one is re-sent (with the stored bytes and the same id, D13.1).
      // A rejected send (dsa's durable request state; cached once terminal) is passed to decide every pass: a rejected
      // ruling steer then does not count as delivered to the writer (review #784 F1).
      for (const x of ar.sends) {
        if (this.facts.applied.has(x.send)) continue;
        const known = this.facts.refused.get(x.send);
        if (known !== undefined) { rejected.set(x.send, known); continue; }
        try {
          const r = await this.dsa.request(x.send);
          if (r.state === 'applied') { this.facts.applied.add(x.send); continue; }
          if (r.state === 'rejected') { this.facts.refused.set(x.send, r.reason ?? 'rejected'); rejected.set(x.send, r.reason ?? 'rejected'); continue; }
        } catch { /* unknown: re-send; dsa returns the first outcome for the same id */ }
        await blob(x.message);
      }
    }
    return { runs, blobs, rejected, conflicts };
  }

  /**
   * A follow-up applied in this process started generation g; until describe reports g, a sealed view is the previous
   * generation's (dsa's view lags the applied send), not the follow-up's outcome: present it as running.
   */
  private current(view: RunView, gen: number | undefined): RunView {
    if (gen !== undefined) this.facts.lastGen.set(view.rid, gen);
    this.facts.lastState.set(view.rid, view.state);
    if (view.to) this.facts.lastTo.set(view.rid, view.to);
    const want = this.facts.expectGen.get(view.rid);
    if (want === undefined || gen === undefined) return view;
    if (gen >= want) { this.facts.expectGen.delete(view.rid); return view; }
    if (view.state !== 'sealed' && view.state !== 'pruned') return view;
    return { rid: view.rid, state: 'running', ...(view.wid ? { wid: view.wid } : {}), ...(view.to ? { to: view.to } : {}), ...(view.labels ? { labels: view.labels } : {}) };
  }

  /**
   * One pass: load, observe, decide, execute in order (stops between actions when `stopping`). Verdicts are written to
   * the ledger by the action that meets them (D14), so nothing this pass learned decides a later pass. `progress`: the
   * ledger head advanced or dsa applied a request in this pass (D14.5).
   */
  async pass(): Promise<PassResult> {
    const ledger = await this.init(), reports: ActionReport[] = [];
    // K6: first the measurements that ended, in the order they ended (their halts and rebases are in the state below).
    const handled = await this.reap(reports);
    const s = await loadState(ledger), cfg = driveConfig(s.plan);
    this.project = projectId(s);
    const measuring = new Set(this.measuring.keys());
    const { runs, blobs, rejected, conflicts } = await this.observe(s, measuring);
    let actions = decide(s, s.plan, runs, { max: this.o.max ?? cfg.max, repairs: cfg.repairs, project: this.project, root: this.root!, applied: this.facts.applied, rejected, blobs, conflicts, measuring });
    let applied = false;
    const cap = measureCap(s.plan);
    // Ruling #559 (c): before merging, compare the trunk ref with the ledger trunk; on drift merge nothing this pass
    // (every other action continues) and emit the repo-level owner notify (the loop prints it once per change).
    // K6 (review #785): while a merge of this driver is in flight or ended but not yet handled, the trunk ref may be ahead
    // of the state loaded above because of that merge: no drift check and no notify this pass (its CAS reports drift).
    let checked = true;
    const merging = [...this.measuring.values()].some(m => m.do === 'merge');
    const drift = merging ? (checked = false, undefined) : await git.trunkDrift(this.root!, s.trunk.name, s.trunk.commit).catch(() => { checked = false; return undefined; });
    if (drift) {
      const r = driftReport(s, drift);
      reports.push(r); this.emit(r, s);
      actions = actions.filter(a => a.do !== 'merge');
    } else if (checked && this.facts.drift) {
      // G3.4a: drift cleared: forget its print and wake records (an identical later drift prints and wakes again) and
      // log a quiet event the follower resets its own record on.
      this.facts.drift = false;
      this.facts.printed.delete(`${DRIFT_KEY}:notify`); this.facts.wakes.delete(DRIFT_KEY);
      const e: LoopEvent = { event: 'drift-cleared' };
      this.o.log(this.o.json ? JSON.stringify(e) : reportText(e));
    }
    for (const a of actions) {
      if (this.stopping) break;
      if (a.do === 'attest' || a.do === 'merge') {
        // K6: start it in the background; over `drive.measure`, or a second merge: skipped, decided again later.
        const inFlight = [...this.measuring.values()];
        if (inFlight.length >= cap || (a.do === 'merge' && inFlight.some(m => m.do === 'merge'))) continue;
        // Busy back-off: an attest that ended busy waits for the next timed or event pass.
        if (this.busyAt.get(a.node) === this.cycle) continue;
        const r = this.start(s, a.do, a.node);
        reports.push(r); this.emit(r, s);
        continue;
      }
      const r = await this.execute(s, a);
      reports.push(r.report); applied ||= r.applied;
      this.emit(r.report, s);
    }
    // 0.8 (L1.5): the waiting nodes, one quiet line each (the loop prints a node's line once per resume).
    const waiting = Object.keys(s.nodes).sort().flatMap(id => { const w = waitingFor(s, id); return w ? [{ node: id, ...w }] : []; });
    for (const w of waiting) {
      const e: LoopEvent = { event: 'waiting', node: w.node, after: w.after, resume: w.resume }, slot = `${w.node}:waiting`, key = String(w.resume);
      if (!this.o.once && this.facts.printed.get(slot) === key) continue;
      this.facts.printed.set(slot, key);
      this.o.log(this.o.json ? JSON.stringify(e) : reportText(e));
    }
    const head = (await ledger.read()).at(-1)?.hash;
    const open = Object.values(s.nodes).some(n => n.slot?.open);
    return { actions: reports, progress: applied || handled > 0 || head !== s.head, idle: !open && !actions.some(a => a.do === 'dispatch') && !this.measuring.size, head: s.head, waiting };
  }

  // ---------- measurements in flight (K6) ----------
  /** Starts the attest or merge of `node` without awaiting it; returns its `started` report. */
  private start(s: State, what: 'attest' | 'merge', node: string): ActionReport {
    const attempt = s.nodes[node]!.slot!.attempt, at = new Date().toISOString();
    const m: Measurement = { do: what, node, attempt, at, done: false, ended: Promise.resolve() };
    const work: Promise<Ended> = what === 'attest' ? this.attest(node, attempt) : this.merge(node, attempt).then(finish => ({ finish }));
    let busy: ActionReport | undefined;
    m.ended = work.then(f => { m.finish = f.finish; busy = f.busy; }, (e: unknown) => { m.finish = () => Promise.reject(e); })
      .finally(() => {
        m.done = true;
        // A busy attest (review #785) is not progress and does not wake the loop: its line is printed now (so status no
        // longer lists it) and the node waits for the next timed or event pass.
        if (busy) { this.measuring.delete(node); this.busyAt.set(node, this.cycle); if (!this.hard) this.emit(busy); return; }
        this.ended.push(m); this.waker?.();
      });
    this.measuring.set(node, m);
    return { do: what, node, outcome: 'started', at };
  }
  /** A measurement ended and awaits `reap`: the loop's wait ends at once. */
  get woken(): boolean { return this.ended.length > 0; }
  /** Sleeps `ms`, ending early when a measurement ends (or already ended unhandled) or `signal` aborts. */
  wait(ms: number, signal: AbortSignal): Promise<void> {
    if (this.woken || signal.aborted) return Promise.resolve();
    return new Promise(resolve => {
      const done = (): void => { clearTimeout(t); signal.removeEventListener('abort', done); if (this.waker === done) this.waker = undefined; resolve(); };
      const t = setTimeout(done, ms);
      this.waker = done;
      signal.addEventListener('abort', done);
    });
  }
  /**
   * Handles the ended measurements on the loop, in the order they ended: their reports are emitted (and pushed to
   * `out`), with the halts and rebases they call for. Nothing during a stop at once. Returns how many were handled.
   */
  async reap(out: ActionReport[] = []): Promise<number> {
    if (this.hard || !this.ended.length) return 0;
    const batch = this.ended.splice(0), reports: ActionReport[] = [];
    // Each result is handled on its own: an unexpected error of one is rethrown only after the others were handled.
    let failure: { e: unknown } | undefined;
    for (const m of batch) {
      this.measuring.delete(m.node);
      try { reports.push(...await m.finish!()); }
      catch (e) {
        if (!(e instanceof OwedError || e instanceof DsaError)) { failure ??= { e }; continue; }
        reports.push({ do: m.do, node: m.node, outcome: 'error', detail: oneLine(e.message) });
      }
    }
    // Wake reports carry the node's fact mark in the state after the measurements (their observations are facts).
    const now = await loadState(this.ledger!).catch(() => undefined);
    for (const r of reports) { out.push(r); this.emit(r, now); }
    if (failure) throw failure.e;
    return batch.length;
  }
  /** Stop (SPEC §12.7): waits for every in-flight measurement to end and handles it; returns at once on a stop at once. */
  async settle(out: ActionReport[] = []): Promise<void> {
    while (this.measuring.size && !this.hard) {
      await Promise.all([...this.measuring.values()].map(m => m.ended));
      if (this.hard) return;
      await this.reap(out);
    }
  }
  /** Stop at once: waits up to `ms` for the in-flight measurements (only merges: `merges`) to end; true when all did. */
  async drain(ms: number, merges = false): Promise<boolean> {
    const all = Promise.all([...this.measuring.values()].filter(m => !merges || m.do === 'merge').map(m => m.ended)).then(() => true);
    let t: NodeJS.Timeout | undefined;
    const late = new Promise<boolean>(resolve => { t = setTimeout(() => resolve(false), ms); });
    try { return await Promise.race([all, late]); } finally { clearTimeout(t); }
  }

  /**
   * Prints a report. A wake report of a node in `s` carries the node's fact mark (E3.1). In the loop a notify / busy
   * line for a node is printed only when its text (without ages) or, for a notify, the fact mark changed; any other
   * wake with the text and fact mark of the node's last printed wake is marked `repeat: n` (text: `(repeat n, no new
   * ledger entries)`), and the follower does not wake for it.
   */
  emit(r: ActionReport, s?: State): void {
    if (s && wakeReport(r) && r.scope !== 'repo' && s.nodes[r.node]) r.facts = factMark(s, r.node);
    if (r.scope === 'repo' && r.do === 'notify') this.facts.drift = true;
    const rk = reportKey(r);
    if (!this.o.once && (r.outcome === 'notify' || r.outcome === 'busy')) {
      const key = `${busyKey(r.text ?? r.detail ?? '')}${r.outcome === 'notify' && r.facts !== undefined ? `\u0000${r.facts}` : ''}`, slot = `${rk}:${r.outcome}`;
      if (this.facts.printed.get(slot) === key) return;
      this.facts.printed.set(slot, key);
    // Any other attest line, `started` included, ends the busy dedup: a started measurement always gets its completion
    // line (review #785), so status never lists one that ended.
    } else if (r.do === 'attest') this.facts.printed.delete(`${rk}:busy`);
    if (!this.o.once && r.facts !== undefined) {
      const text = reportText({ ...r, repeat: undefined }), last = this.facts.wakes.get(rk);
      if (last && last.text === text && last.facts === r.facts) r.repeat = ++last.n;
      else this.facts.wakes.set(rk, { text, facts: r.facts, n: 0 });
    }
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
              // G3.6: dsa opens generation g+1 only for a follow-up to a sealed call (the reply carries it); one to a
              // running call is forwarded into the running generation (no `generation`): then nothing new is expected.
              const last = this.facts.lastGen.get(a.rid), seen = this.facts.lastState.get(a.rid);
              const forwarded = r.generation === undefined && (seen === 'running' || seen === 'asking' || seen === 'queued');
              const gen = r.generation ?? (!forwarded && last !== undefined ? last + 1 : undefined);
              if (gen !== undefined) this.facts.expectGen.set(a.rid, gen);
            }
            return done('applied', true, a.send ? 're-sent' : undefined, x);
          }
          if (r.outcome === 'rejected') this.facts.refused.set(id, r.reason);
          // D22.3: a rejected ruling steer (e.g. the call sealed meanwhile) is logged only: no halt, never retried as a
          // steer. Review #784 F1: it does not count as delivered, so the writer's next follow-up (submit, rebase, repair
          // or ruling) carries its rulings; reviewers get them through the rulings obligation. A rejected ruling
          // follow-up halts like any other send (as decide would on the next pass).
          if (r.outcome === 'rejected' && a.reason === 'ruling' && a.sendKind === 'steer') return done('rejected', false, `${r.reason}; not retried as a steer (the writer's next follow-up carries these rulings; reviewers get them through the rulings obligation)`, x);
          // 0.8 (L1.4): the halt names the run's call address when describe reported one.
          const to = callAt({ rid: a.rid, state: 'running', ...(this.facts.lastTo.has(a.rid) ? { to: this.facts.lastTo.get(a.rid)! } : {}) });
          if (r.outcome === 'rejected') { await this.halt(a.node, a.attempt, rejectedHalt(a.node, 'send', `${id}${to}`, r.reason)); return done('rejected', false, `${r.reason}; halted`, x); }
          if (r.outcome === 'conflict') { await this.halt(a.node, a.attempt, `dsa request-conflict on send ${id}${to}; never retried with other bytes`); return done('conflict', false, 'halted', x); }
          return done('pending', false, r.reason ?? 'retry next pass', x);
        }
        // K6: attest and merge are started by `pass` (`start`), never executed inline.
        case 'attest': case 'merge': throw new Error(`${a.do} is a measurement`);
        case 'rebase': { const r = await ops.rebase({ cwd, as, node: a.node }); return done('done', false, `slot base ${r.from.slice(0, 12)} → ${r.base.slice(0, 12)}`); }
        case 'halt': await this.halt(a.node, a.attempt, a.reason, a.needs); return done('halted', false, a.reason, { attempt: a.attempt, needs: a.needs });
        case 'notify': return { report: { ...base, outcome: 'notify', text: a.text, ...(a.rid !== undefined ? { rid: a.rid } : {}), ...(a.qid !== undefined ? { qid: a.qid, rev: a.rev } : {}) }, applied: false };
      }
    } catch (e) {
      if (e instanceof OwedError || e instanceof DsaError) return done('error', false, e.message);
      throw e;
    }
  }

  /**
   * `pi-durable-subagents hold machine --shared --no-wait -- owed attest <node>` when dsa is available (D6/D9, dsa >=
   * 1.0.27), else `owed attest <node>`; resolves with how the loop handles the result. Exit 0/1: done (the ledger says
   * what follows). Exit 75: busy, nothing was queued, retry on a later pass: through hold either hold refusing the lease
   * or `owed attest` itself exiting 75 because another attest of the node runs (K1); directly only the latter. Anything
   * else — an owed error (2/3), a signal, dsa rejecting the invocation (an older dsa without `--no-wait`) — halts needing
   * a human on attempt `attempt` (D14.3).
   */
  private async attest(node: string, attempt: number): Promise<Ended> {
    const argv = [...this.owed, 'attest', node], cwd = this.root!;
    const report = (outcome: string, detail?: string): ActionReport => ({ do: 'attest', node, outcome, ...(detail ? { detail: oneLine(detail) } : {}) });
    const ok = (r: ActionReport): Ended => ({ finish: async () => [r] });
    const busy = (detail: string): Ended => { const r = report('busy', detail); return { finish: async () => [r], busy: r }; };
    const fail = (why: string): Ended => ({ finish: async () => { await this.halt(node, attempt, `attest error: ${why}`); return [report('error', `${why}; halted`)]; } });
    let ran: { exit: number | null; stdout: string; stderr: string };
    if (dsaAvailable(this.dsa.bin)) {
      const r = await this.dsa.hold('machine', argv, { shared: true, cwd });
      if (r.outcome === 'busy') return busy(busyDetail(node, r.reason));
      if (r.outcome === 'signal') return fail(`pi-durable-subagents hold ended by ${r.reason}`);
      if (r.outcome === 'refused') return fail(`pi-durable-subagents hold refused: ${tail(r.reason)}${/--no-wait/.test(r.reason) ? ' (owed drive requires pi-durable-subagents >= 1.0.27 for `hold --no-wait`)' : ''}`);
      ran = r;
    } else {
      try { ran = await runProcess(argv, cwd); } catch (e) { return fail(`cannot run ${argv[0]}: ${(e as Error).message}`); }
    }
    if (ran.exit === 0 || ran.exit === 1) return ok(report('done', ran.exit === 0 ? 'accepted' : 'not accepted yet'));
    if (ran.exit === 75) return busy(busyDetail(node, tail(ran.stderr || ran.stdout)));
    return fail(`owed attest exited ${ran.exit ?? 'by a signal'}: ${tail(ran.stderr || ran.stdout)}`);
  }

  /**
   * `ops.merge` in this process (the CLI refuses `--as parent:drive`), aborted by a stop at once (D16a.1); resolves with
   * how the loop handles the result. Refusals (D14.2): `rebase needed` rebases; the transient refusal (the ledger moved
   * while merge measured; nothing recorded) and K4's `not measured` retry on a later pass; K4's changed slot and
   * invalidated candidate are reported (`superseded`), no halt; a CAS failure (trunk moved during the merge) is a
   * retry line plus the trunk drift notify, never a halt (ruling #559 c); any other refusal halts needing a human.
   */
  private async merge(node: string, attempt: number): Promise<() => Promise<ActionReport[]>> {
    const cwd = this.o.cwd, as = DRIVE_PRINCIPAL;
    const report = (outcome: string, detail: string): ActionReport => ({ do: 'merge', node, outcome, detail: oneLine(detail) });
    try {
      const r = await ops.merge({ cwd, as, node, signal: this.abort.signal });
      return async () => [report('merged', `trunk ${r.commit.slice(0, 12)}`)];
    } catch (e) {
      if (!(e instanceof OwedError) || e.code !== 'refused') throw e;
      return async () => {
        if (e.message === MERGE_TRANSIENT) return [report('retry', `merge refused (${e.message}); retry next pass`)];
        // K4: a key the plan update introduced was not measured (the measured observations were kept): the next pass
        // merges again and measures only what lacks a verdict. Never a halt.
        if (e.message.includes('not measured: ')) return [report('retry', `merge refused (${e.message}); retry next pass`)];
        // K4: the slot moved (abandon, rebase, dispatch) or a plan entry invalidated the candidate: nothing was recorded
        // and the next pass decides on the new state (a new candidate, a rebase follow-up). Reported, never a halt.
        if (/^slot of \S+ changed \(/.test(e.message) || /^candidate #\d+ \S+ of \S+ was invalidated by plan #\d+/.test(e.message)) return [report('superseded', `merge refused (${e.message}); the next pass decides on the new state`)];
        if (e.message.startsWith('rebase needed')) {
          const r = await ops.rebase({ cwd, as, node });
          return [report('rebased', `merge refused (${e.message}); slot base ${r.from.slice(0, 12)} → ${r.base.slice(0, 12)}`)];
        }
        if (/trunk changed \(CAS\)/.test(e.message)) {
          const now = await loadState(this.ledger!), d = await git.trunkDrift(this.root!, now.trunk.name, now.trunk.commit).catch(() => undefined);
          return [report('retry', `merge refused (${e.message}); retry next pass`), ...(d ? [driftReport(now, d)] : [])];
        }
        await this.halt(node, attempt, `merge refused: ${e.message}`);
        return [report('refused', `${e.message}; halted (needs human)`)];
      };
    }
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

/**
 * `owed drive`: takes the single-driver lock, then one pass (`once`), or the loop: passes back to back while they make
 * progress (at most 20), then wait for an `events --all` event labeled with this project (polled every `pollMs`) or
 * `passMs`, whichever comes first, or a measurement ends (K6). Exits 0 when idle (nothing open, nothing to dispatch,
 * nothing in flight) or after SIGINT/SIGTERM (or `signal`) once the current action is done and the in-flight
 * measurements ended and were handled; a second signal exits 130 at once (with `once`, the first one does). With
 * `stay` (H1.2) an idle pass does not exit: one `idle-wait` line per idle period, then the driver waits (keeping the
 * lock) until the ledger head changes and resumes passes; a stop exits `stopped`. A live driver refuses with
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
  /** The stop at once, once started (it ends in process.exit); every exit path of the loop waits for it instead. */
  let hardStop: Promise<never> | undefined;
  // Loop: the first SIGINT/SIGTERM stops: nothing new starts, the in-flight measurements end and are handled (K6); the
  // second stops at once (D14.8). `--once`: the first stops at once (D16.3). At once = abort the in-process merge
  // (D16a.1: its checks get SIGKILL; a stop between advanceTrunk and the append surfaces as CAS drift), end the running
  // dsa invocations (hold passes SIGTERM to `owed attest`) and the process groups of direct attest children (attest then
  // ends its checks, D16.2), wait for the in-flight measurements up to HARD_WAIT_MS (then SIGKILL their groups and wait
  // up to KILL_WAIT_MS), write the killed line (and in a `--json` loop the exit record, before the release: D17a.2),
  // release the lock, exit 130. Their results are not handled. The ledger stays consistent: every entry is appended
  // whole, and attest records its own observations. One stop request is one SIGTERM per process group (D16a.3): this
  // path runs once (later signals are ignored), killAll signals each pid of dsa's live set once, and directChildren
  // holds only `owed attest` children spawned by runProcess, never a dsa invocation, so the two sets are disjoint.
  // The handlers are installed before the lock is taken (D17a.6): in the loop a signal while starting stops it at its
  // first check; with `once` it stops at once as above (no lock yet: nothing to release).
  const killGroups = (sig: NodeJS.Signals): void => {
    driver.dsa.killAll(sig);
    for (const pid of directChildren) { try { process.kill(-pid, sig); } catch { /* gone */ } }
  };
  const atOnce = async (): Promise<never> => {
    driver.hard = true; driver.stopping = true; stop.abort();
    driver.abort.abort();
    killGroups('SIGTERM');
    if (!(await driver.drain(HARD_WAIT_MS))) { killGroups('SIGKILL'); await driver.drain(KILL_WAIT_MS); }
    say(o.once ? 'killed: signal, stopped at once' : 'killed: second signal, stopped at once', { event: 'killed' });
    if (end.record && !end.written) { o.log(exitRecord(130, 'killed')); end.written = true; }
    lock?.releaseSync();
    process.exit(130);
  };
  const onSignal = () => {
    if (!o.once && ++signals === 1) { onAbort(); return; }
    hardStop ??= atOnce();
  };
  const handle = o.handleSignals !== false;
  if (handle) { process.on('SIGINT', onSignal); process.on('SIGTERM', onSignal); }
  o.signal?.addEventListener('abort', onAbort);
  if (o.signal?.aborted) onAbort();
  let failure: { e: unknown } | undefined;
  try {
    const ledger = await Ledger.open(o.cwd);
    lock = await acquireDriveLock(ledger.dir, driver.session);
    if (!o.once && driver.stopping) { say('stopped', { event: 'stopped' }); end.reason = 'stopped'; return 0; }
    // K6: --once (and the pi tool's pass) waits for the measurements its pass started and handles them.
    if (o.once) { const r = await driver.pass(); await driver.settle(); if (hardStop) await hardStop; if (r.idle) say('idle: nothing open and nothing ready', { event: 'idle' }); return 0; }
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
    /** H1.2: start of the current idle period of a staying driver (one `idle-wait` line per period). */
    let idleAt: string | undefined;
    for (;;) {
      /** H1.2: the ledger head the idle pass decided on; undefined when the last pass was not idle. */
      let idle: string | undefined;
      for (let burst = 0; burst < 20 && !driver.stopping; burst++) {
        const r = await driver.pass();
        if (r.idle && !o.stay) { say('idle: nothing open and nothing ready', { event: 'idle' }); end.reason = 'idle'; return 0; }
        if (r.idle) { idle = r.head; break; }
        idleAt = undefined;
        if (!r.progress) break;
      }
      if (idle !== undefined && !driver.stopping) {
        // Stay: keep the lock and wait for the ledger head to differ from the head the idle pass decided on (a plan
        // update, a ruling, an abandon…), then pass. An entry appended during that pass is already a change: no wait.
        if (idleAt === undefined) { idleAt = new Date().toISOString(); say(IDLE_WAIT_TEXT, { event: 'idle-wait', at: idleAt }); }
        const head = idle;
        while (!driver.stopping && ledgerHead(ledger.dir) === head) {
          await driver.wait(o.pollMs ?? 3000, stop.signal);
        }
        driver.tick();
      } else {
        // K6: a measurement that ends wakes the loop at once; only a timed or event pass ends a busy back-off (tick).
        const last = Date.now();
        while (!driver.stopping) {
          await driver.wait(o.pollMs ?? 3000, stop.signal);
          if (driver.stopping) break;
          if (Date.now() - last >= (o.passMs ?? 30_000)) { driver.tick(); break; }
          if (driver.woken) break;
          if (await poll()) { driver.tick(); break; }
        }
      }
      if (driver.stopping) {
        // K6: a stop starts nothing new and waits for the in-flight measurements, handled as usual.
        await driver.settle();
        if (hardStop) await hardStop;
        say('stopped', { event: 'stopped' }); end.reason = 'stopped'; return 0;
      }
    }
  } catch (e) { failure = { e }; throw e; }
  finally {
    // A stop at once owns the exit (record, release, process.exit): never write a second record or release here.
    if (hardStop) await hardStop;
    // A loop ending with an error aborts an in-flight merge (it stops before trunk moves) and waits for it, bounded as
    // for a stop at once, before the lock is released; attest children finish alone.
    if (failure) { driver.hard = true; driver.abort.abort(); await driver.drain(HARD_WAIT_MS + KILL_WAIT_MS, true); }
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
