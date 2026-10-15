// owed drive: the executor and the loop (SPEC §12.7, contract D6/D7/D9). One pass = load the ledger state, describe
// every live launch of the open attempts, `decide` (pure, src/drive.ts), execute the actions in order. Persist before
// submit: a launch/send entry is appended before the dsa call, and a retry re-sends the stored bytes with the same id.
// Verdicts (except rejected steers, decided next pass by SR1/SR2) are written to the ledger in the pass that meets
// them (D14); what this process keeps across passes are caches of dsa's answers (applied sends, follow-up generations),
// so losing it (a crash, a restart) is harmless: the ledger plus `describe` re-derive the state.
import { spawn } from 'node:child_process';
import { link, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { statfs } from 'node:fs/promises';
import { closeSync, fstatSync, openSync, readFileSync, readSync, rmSync, mkdirSync, writeFileSync, renameSync } from 'node:fs';
import { hostname, tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import * as ops from './ops.ts';
import { rebasePending, type RebasePending } from './rebase-view.ts';
/**
 * SB2: the rebase command of a rebased slot whose HEAD may already be aligned with the new base (the drift map omits
 * those): the same upstream as `owed rebase` prints, so no follow-up replays trunk commits HEAD already holds.
 */
const rebaseWorkOf = async (s: State, node: string, pending?: RebasePending): Promise<RebasePending | undefined> =>
  s.nodes[node]?.slot?.rebase ? pending ?? await rebasePending(s, node, true) : undefined;
import * as git from './git.ts';
import { clockTime } from './clock.ts';
import { pendingAdopt, adoptPendingReason } from './adopt-wait.ts';
import { Ledger } from './ledger.ts';
import { driveConfig, measureCap, minFreeMb, idleRewakeMin } from './plan.ts';
import { DISK_FULL } from './exec.ts';
import { renderSweep, unguardedText } from './sweep.ts';
import { withMachineLease, machineLeased, leaseText, leaseResult } from './lease.ts';
import { halted, projectId, mergeQueue, reviewEpoch, waitingFor, trunkParked, reportedOf, type Waiting } from './reducer.ts';
import { DRIVER, entriesOf, remeasureDue } from './reducer.ts';
import { mergeBatchPlan, sharedParked, sharedParkKey, sharedPhase } from './reducer.ts';
import { mergeBatchSize } from './plan.ts';
import { callAt, decide, rejectedHalt, wantsRebaseConflicts } from './drive.ts';
import type { Action } from './drive.ts';
import { Dsa, DsaError, dsaAvailable, startingSession } from './dsa.ts';
import { OwedError } from './errors.ts';
import { oneLine } from './views.ts';
import type { Entry, Plan, Principal, RunView, SendEntry, State } from './types.ts';

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
/** F2.3: the node name of the repo-level low-disk notify (`scope: 'repo'`). */
export const DISK_NODE = 'disk';
/** F2.3: the text of the low-disk notify: per path below the limit, `disk low: N MB free in <path> < M MB`. */
export const diskLowText = (low: readonly { path: string; mb: number }[], min: number): string => low.map(l => `disk low: ${l.mb} MB free in ${l.path} < ${min} MB`).join('; ') + '; the driver starts no measurement until space is freed';
/**
 * F2.3: the paths among `paths` with less than `min` MB free (statfs: available blocks × block size); a path statfs
 * cannot read is skipped. Empty when `min` is 0.
 */
export async function lowDisk(paths: readonly string[], min: number): Promise<{ path: string; mb: number }[]> {
  if (min <= 0) return [];
  const out: { path: string; mb: number }[] = [];
  for (const path of paths) {
    try { const f = await statfs(path), mb = Math.floor(Number(f.bavail) * Number(f.bsize) / 1048576); if (mb < min) out.push({ path, mb }); } catch { /* unreadable: not judged */ }
  }
  return out;
}
/** F2.4: an error that says the disk (or quota) is full: ENOSPC / EDQUOT, or their messages. */
export const diskFullError = (e: unknown): boolean => {
  const code = (e as NodeJS.ErrnoException | undefined)?.code, message = e instanceof Error ? e.message : String(e);
  return code === 'ENOSPC' || code === 'EDQUOT' || DISK_FULL.test(message) || /\bEDQUOT\b/.test(message);
};
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
  /** F2.4: how long the loop sleeps after a disk-full error escaped a pass (default 60 s; tests). */
  diskFullMs?: number;
}

/** One executed action as printed (`--json`: one object per line). */
export interface ActionReport {
  do: Action['do'] | 'sweep'; node: string; outcome: string; detail?: string;
  /** `repo`: a repository-level report (the trunk drift notify), not about the plan node named `node`. */
  scope?: 'repo';
  attempt?: number; role?: string; rid?: string; send?: string; sendKind?: string; reason?: string; needs?: string; text?: string;
  /** An asking notify (H1.1b): the first open question of run `rid`; fields of the log line, not of the ledger. */
  qid?: string; rev?: number; answerRetry?: true; inProgress?: number;
  /** IR3: separate from trunk drift, revalidated against this invariant/key at pi delivery. */
  invariantRed?: { obligation: string; key: string };
  /** TP2: full runtime notice identity, including names omitted from the display. Never a ledger field. */
  once?: string;
  /** Wake reports (E3.1): the node's fact mark (`factMark`) in the state the pass decided on. */
  facts?: number;
  /** Loop only (E3.1): the same text and fact mark as this node's last printed wake, for the n-th time. */
  repeat?: number;
  /** A measurement's `started` line (K6): when it started (ISO); `owed drive --status` reads it from the log. */
  at?: string;
}

/** D25.6: how a halt or refusal that needs the owner is worded in the driver's output. */
export const NEEDS_OWNER = 'needs the owner (the main agent decides; owed lists the command)';
/** QT1: the ledger still says `human`; the main agent resolves the rendered parent halt. */
export const NEEDS_PARENT = 'needs the parent (the main agent acts; owed lists the command)';
/**
 * Reports that wake a following session (D17.7): halts, notifies (questions, owner-needed, describe failures) and the
 * outcomes rejected, conflict, refused and error. F1: a `stale` outcome (a halt included) records nothing and wakes nobody.
 */
export const wakeReport = (r: { do?: unknown; outcome?: unknown }): boolean => (r.do === 'halt' && r.outcome !== 'stale') || (r.do === 'notify' && r.outcome !== 'answered') || ['rejected', 'conflict', 'refused', 'error'].includes(String(r.outcome));
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
  waiting: (Waiting & { node: string })[];
  counts: IdleCounts;
  idleRewakeMin: number;
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
  /**
   * G3.2 (0.12): send id of a follow-up → the generation it went into, as dsa answered this process (null: none, e.g.
   * forwarded into running work). A follow-up recorded in the ledger but not in this map (a restarted driver) is asked
   * again with the same id and bytes: dsa returns the first outcome, which names its generation.
   */
  readonly sentGen = new Map<string, number | null>();
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
  /** F2.2: the `once` keys of notifies already printed (the environment back-off: one per streak). */
  readonly once = new Set<string>();
  /** F2.3: the low-disk state last notified (paths and limit), undefined while the disk is fine. */
  disk?: string;
}

/**
 * A measurement in flight (0.7.0, K6): an `owed attest` child or an in-process `ops.merge`, from its start until the
 * loop has handled its result. `ended` settles (never rejects) when the work ended; `finish` then turns the raw result
 * into reports on the loop, with the halts and rebases of SPEC §12.7.
 */
interface Measurement {
  do: 'attest' | 'merge'; node: string; attempt: number; at: string;
  batch?: string[];
  ended: Promise<void>;
  done: boolean;
  /** DR1: only driver-owned trunk refreshes may be preempted. */
  abort?: AbortController;
  finish?: () => Promise<ActionReport[]>;
}
/** How a measurement ended: `finish` handles it on the loop; `busy`: its report, handled at once instead. */
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

/** DL1: all driver loads, including stateOf and measurement reaping, use the verified ops replay caches. */
const loadState = ops.loadDriverState;

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
export interface DriveLock { owner: LockOwner; release(): Promise<void>; /** Synchronous release for a hard stop. */ releaseSync(): void }
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
      owner: me,
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
export interface LoopEvent { event: 'idle' | 'idle-wait' | 'stopped' | 'killed' | 'cursor-reset' | 'events-error' | 'exit' | 'session-unsupported' | 'drift-cleared' | 'waiting' | 'disk-full'; head?: string; reason?: string; error?: string; code?: number; at?: string; session?: string; /** `waiting` (0.8, L1.5): the waiting node, the node it waits for and the resume entry. */ node?: string; after?: string; resume?: number; deps?: string[]; counts?: IdleCounts }
/** FL4: counts are disjoint for parked nodes; open counts every open slot. */
export interface IdleCounts { ready: number; open: number; waiting: number; reported: number; later: number }
export const idleWaitText = (c: IdleCounts): string => `idle: ${c.ready} ready, ${c.open} open, ${c.waiting} waiting, ${c.reported} reported, ${c.later} later; staying until the ledger changes (owed drive --stop ends it)`;
/** FL4: deterministic timer decision; the loop owns the clock and lifecycle. */
export const idleRewakeDue = (now: number, last: number, minutes: number): boolean => minutes > 0 && now - last >= minutes * 60_000;
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
      case 'idle-wait': return e.counts ? idleWaitText(e.counts) : IDLE_WAIT_TEXT;
      case 'stopped': return 'stopped';
      case 'killed': return 'killed: second signal, stopped at once';
      case 'cursor-reset': return e.reason !== undefined ? `events: cursor rejected (${oneLine(e.reason)}), reset${e.head ? ` to ${e.head}` : ''}` : `events: cursor expired, reset to ${e.head}`;
      case 'events-error': return `events error: ${oneLine(e.error ?? '')}`;
      case 'exit': return `driver exited ${e.code} (${e.reason})${e.error !== undefined ? `: ${oneLine(e.error)}` : ''}`;
      case 'drift-cleared': return 'trunk drift cleared: trunk equals the ledger trunk again';
      case 'disk-full': return `disk full: ${oneLine(e.error ?? '')}; the driver sleeps 60 s and continues`;
      case 'waiting': return e.deps?.length ? `waiting: ${oneLine(e.node ?? '?')} waiting (deps: ${e.deps.map(oneLine).join(', ')})${e.after ? `; ${waitingText(oneLine(e.node ?? '?'),oneLine(e.after),e.resume ?? -1)}` : ''}` : waitingText(oneLine(e.node ?? '?'), oneLine(e.after ?? '?'), e.resume ?? -1);
      case 'session-unsupported': return `dsa does not accept --session (older than pi-durable-subagents 1.0.31): runs start without it and are not listed in pi session ${e.session ?? '?'}${e.reason ? ` (${oneLine(e.reason)})` : ''}`;
      default: return oneLine(JSON.stringify(json));
    }
  }
  if (!('do' in json) || typeof (json as { do: unknown }).do !== 'string') return oneLine(JSON.stringify(json));
  const r = json as ActionReport;
  // G3.6 (0.12): a failed send (outcome error) names its node as a word.
  const what = r.do === 'launch' ? `launch ${r.node} ${r.role} ${r.rid}` : r.do === 'send' ? `send ${r.sendKind} (${r.reason})${r.outcome === 'error' ? ` for node ${r.node}` : ''} to ${r.rid}${r.send ? ` [${r.send}]` : ''}` : r.do === 'halt' && r.outcome !== 'stale' ? (r.needs === 'owner' ? `halt ${r.node} attempt ${r.attempt}, ${NEEDS_OWNER}` : `halt ${r.node} attempt ${r.attempt}, ${NEEDS_PARENT}`) : `${r.do} ${r.node}`;
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
  private sweepRun?: { abort:AbortController; ended:Promise<void>; done:boolean; committing:boolean; reports:ActionReport[] };
  private sweepBusyAt?: number;
  private readonly ended: Measurement[] = [];
  /** Ends the loop's current `wait` (a measurement ended). */
  private waker?: () => void;
  /**
   * Busy back-off (review #785): the loop's timed/event pass count (`tick`), and per node the count at which its attest
   * ended busy. A node does not start a measurement again in the same count: not before the next timed or event pass.
   */
  private cycle = 0;
  private readonly busyAt = new Map<string, number>();
  /** MT4: batches refused in this process (`<trunk>\0<members>`): their members merge one at a time until trunk moves. */
  private readonly batchRefused = new Set<string>();
  /** MT1: the batch to merge this pass: the plan's batch over this pass's merge actions, unless refused on this trunk. */
  private batchOf(s: State, actions: Action[]): string[] {
    const b = mergeBatchPlan(s, mergeBatchSize(s.plan), actions.flatMap(a => a.do === 'merge' ? [a.node] : []));
    return b.length && !this.batchRefused.has(`${s.trunk.commit}\0${b.join('\0')}`) ? b : [];
  }
  /** DR2: private runtime state; never a ledger act or acceptance evidence. */
  private readonly mergeWaiting = new Map<string, { reason: string; since: string; attempt: number; candidate?: number; job?: string }>();
  private recordMergeWaiting(node: string, reason?: string, s?: State, job?: string): void {
    if (!this.ledger) return;
    const n = s?.nodes[node], prior = this.mergeWaiting.get(node);
    if (reason !== undefined) {
      const attempt = n?.slot?.attempt ?? prior?.attempt;
      if (attempt === undefined) return;
      const candidate = n?.candidate?.seq ?? prior?.candidate;
      this.mergeWaiting.set(node, { reason, ...(job ? { job } : {}), since: prior && prior.attempt === attempt && prior.candidate === candidate ? prior.since : new Date().toISOString(), attempt, ...(candidate !== undefined ? { candidate } : {}) });
    } else this.mergeWaiting.delete(node);
    const dir = join(this.ledger.dir, 'drive'), path = join(dir, 'waiting.json');
    mkdirSync(dir, { recursive: true });
    const temp = `${path}.${process.pid}.tmp`;
    writeFileSync(temp, JSON.stringify(Object.fromEntries(this.mergeWaiting)), { mode: 0o600 });
    renameSync(temp, path);
  }
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
    if (!this.ledger) {
      this.ledger = await Ledger.open(this.o.cwd); this.root = await git.mainRoot(this.o.cwd);
      try {
        const saved = JSON.parse(await readFile(join(this.ledger.dir, 'drive', 'waiting.json'), 'utf8')) as Record<string, { reason: string; since: string; attempt: number; candidate?: number }>;
        for (const [id, w] of Object.entries(saved)) if (typeof w.reason === 'string' && Number.isFinite(Date.parse(w.since)) && Number.isSafeInteger(w.attempt)) this.mergeWaiting.set(id, w);
      } catch { /* missing/corrupt private cache */ }
    }
    return this.ledger;
  }

  /**
   * Describe live runs of open attempts (including halted ones, HA1), plus any run with a prospective notice due while measuring;
   * ask dsa about recorded sends not yet confirmed; read the
   * stored bytes `decide` may need for retries. `rejected`: the attempt's sends dsa decided rejected (every pass; cached
   * once terminal) and the runs and sends rejected in this process.
   */
  private async observe(s: State, measuring: ReadonlySet<string>): Promise<{ runs: Map<string, RunView>; blobs: Map<string, string>; rejected: Map<string, string>; conflicts: Map<string, string[]>; rebasePending: Map<string, RebasePending>; rebaseWork: Map<string, RebasePending> }> {
    const ledger = this.ledger!, runs = new Map<string, RunView>(), blobs = new Map<string, string>(), rejected = new Map<string, string>(), conflicts = new Map<string, string[]>();
    const pendingBases = new Map<string, RebasePending>(), rebaseWork = new Map<string, RebasePending>();
    const blob = async (sha: string) => { if (!blobs.has(sha)) { try { blobs.set(sha, (await ledger.getBlob(sha)).toString('utf8')); } catch { /* decide halts on a missing blob */ } } };
    for (const n of Object.values(s.nodes)) {
      // K6: while measuring, describe only the runs PR2 needs for prospective notices.
      if (!n.slot?.open || n.phase === 'removed') continue;
      const pendingBase = await rebasePending(s, n.id);
      if (pendingBase) pendingBases.set(n.id, pendingBase);
      const work = await rebaseWorkOf(s, n.id, pendingBase);
      if (work) {
        rebaseWork.set(n.id, work);
        if (!pendingBase && work.recovery && n.slot.rebase && (!n.candidate || n.candidate.seq < n.slot.rebase.seq)) pendingBases.set(n.id,work);
      }
      const ar = n.runs.find(r => r.attempt === n.slot!.attempt), epoch = reviewEpoch(s, n.id);
      if (!ar) continue;
      const policy = s.rules.filter(r => r.prospective && r.seq > n.slot!.dispatchSeq && (r.nodes === '*' || r.nodes.includes(n.id)));
      const normal = !measuring.has(n.id); // HA1: halted attempts still need live run views for asking notices.
      const noticeDue = (rid: string): boolean => {
        const notices = ar.sends.filter(x => x.rid === rid && x.reason === 'ruling' && x.sendKind === 'notify');
        const seen = Math.max(-1, ...notices.map(x => x.rulings ?? -1));
        return policy.some(r => r.seq > seen) || notices.some(x => !this.facts.applied.has(x.send) && !this.facts.refused.has(x.send));
      };
      const raw = new Map<string, { view: RunView; gen?: number }>();
      for (const l of ar.launches.filter(l => (normal && (l.role === 'writer' || (epoch !== undefined && l.seq > epoch))) || noticeDue(l.rid))) {
        try {
          // F4 (wais #34): a describe that timed out is retried once in this pass before it is reported.
          const r = await this.dsa.inspect(l.rid).catch((e: unknown) => { if (e instanceof DsaError && /timed out/.test(e.message)) return this.dsa.inspect(l.rid); throw e; });
          raw.set(l.rid, r);
          if (r.view.state === 'absent') await blob(l.spec);
        } catch (e) { if (!waitingFor(s, n.id)) this.emit({ do: 'notify', node: n.id, outcome: 'describe-failed', detail: `describe ${l.rid}: ${tail((e as Error).message)}` }, s); }
      }
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
      // G3.2: after the sends are confirmed, so a restarted driver knows which follow-ups dsa applied.
      for (const [rid, r] of raw) {
        // HA1: halted nodes are observed for questions only; do not even replay an applied follow-up to them.
        if (!halted(s, n.id)) await this.restartGen(ar.sends, r, ledger);
        runs.set(rid, this.current(r.view, r.gen));
      }
      // G3.7: the files the previous candidate conflicts on, only when row 8 sends a rebase instruction (review #680 b).
      const rb = n.slot.rebase;
      if (rb?.previous && wantsRebaseConflicts(s, n.id, runs)) { const x = await rebaseConflicts(this.root!, rb.base, rb.previous.commit); if (x) conflicts.set(n.id, x); }
    }
    return { runs, blobs, rejected, conflicts, rebasePending:pendingBases, rebaseWork };
  }

  /**
   * G3.2 (0.12): what a follow-up applied by an earlier driver process (a restart, or the previous `--once` pass) lets
   * this one expect. For a sealed (or pruned) view with a reported generation and no expectation yet, the run's latest
   * follow-up send in the ledger that dsa reported applied and whose generation this process does not know is asked
   * again with the same id and stored bytes; dsa answers with the first outcome, naming the generation it went into.
   * When that generation is newer than the described one, the view is the previous generation's: `expectGen` is set
   * as if the follow-up had been applied in this process. Failures and other outcomes leave the view as described.
   * Ruling #1198: later entries on the node cannot prove that this run's generation finished (e.g. another reviewer
   * records a verdict). Cache the applied reply in `sentGen`, so recovery is idempotent and happens once per process.
   */
  private async restartGen(sends: readonly SendEntry[], r: { view: RunView; gen?: number }, ledger: Ledger): Promise<void> {
    const rid = r.view.rid;
    if ((r.view.state !== 'sealed' && r.view.state !== 'pruned') || r.gen === undefined || this.facts.expectGen.has(rid)) return;
    const x = sends.findLast(x => x.rid === rid && x.sendKind === 'follow-up');
    if (!x || !this.facts.applied.has(x.send) || this.facts.sentGen.has(x.send)) return;
    try {
      const bytes = await ledger.getBlob(x.message);
      const a = await this.dsa.send(x.send, rid, 'follow-up', bytes);
      if (a.outcome !== 'applied') return;
      this.facts.sentGen.set(x.send, a.generation ?? null);
      if (a.generation !== undefined && a.generation > r.gen) this.facts.expectGen.set(rid, a.generation);
    } catch { /* unknown: the view stays as described */ }
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
    const mergeReady = mergeQueue(s).length > 0;
    for (const [id, wait] of this.mergeWaiting) {
      const n = s.nodes[id];
      if (!n?.slot?.open || n.merged || n.slot.attempt !== wait.attempt || n.candidate?.seq !== wait.candidate) this.recordMergeWaiting(id);
    }
    if (mergeReady) this.measuring.get('\u0000trunk-refresh')?.abort?.abort('preempted');
    this.project = projectId(s);
    const measuring = new Set(this.measuring.keys());
    const { runs, blobs, rejected, conflicts, rebasePending, rebaseWork } = await this.observe(s, measuring);
    let actions = decide(s, s.plan, runs, { max: this.o.max ?? cfg.max, repairs: cfg.repairs, project: this.project, root: this.root!, applied: this.facts.applied, rejected, blobs, conflicts, rebasePending, rebaseWork, measuring, now: Date.now(), noticed: this.facts.once });
    let applied = false;
    const cap = measureCap(s.plan);
    // Ruling #559 (c): before merging, compare the trunk ref with the ledger trunk; on drift merge nothing this pass
    // (every other action continues) and emit the repo-level owner notify (the loop prints it once per change).
    // K6 (review #785): while a merge of this driver is in flight or ended but not yet handled, the trunk ref may be ahead
    // of the state loaded above because of that merge: no drift check and no notify this pass (its CAS reports drift).
    let checked = true;
    // AW3: pending adopts yield only new merges; an in-flight merge keeps its CAS/measurement lifecycle.
    const adoptPending = await pendingAdopt(ledger.dir);
    const merging = [...this.measuring.values()].some(m => m.do === 'merge');
    if (adoptPending) {
      for (const id of mergeQueue(s)) {
        if (this.measuring.get(id)?.do === 'merge') continue;
        const reason = adoptPendingReason(adoptPending);
        this.recordMergeWaiting(id,reason,s);
        const report: ActionReport = {do:'merge',node:id,outcome:'waiting',detail:`merge waiting for ${reason}`};
        reports.push(report); this.emit(report,s);
      }
      actions = actions.filter(a => a.do !== 'merge');
    } else {
      for (const [id,wait] of this.mergeWaiting) if (wait.reason.startsWith('adopt (pending since ')) this.recordMergeWaiting(id);
    }
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
    // Sweep checks own detached process groups. Cancellation is asynchronous: a ready action never
    // awaits the sweep/bisect; it signals preemption and proceeds in this same pass.
    if (this.sweepRun && !this.sweepRun.done && !this.sweepRun.committing && (this.stopping || drift || mergeReady || actions.some(a=>a.do !== 'notify') || Object.values(s.nodes).some(n=>n.phase === 'ready'))) {
      this.sweepRun.abort.abort(this.stopping ? 'stopped' : 'preempted');
    }
    /** F2.3: whether the disk is low this pass (checked once, before the first measurement it would start). */
    let low: boolean | undefined;
    // DR1: start a merge before node attests consume the measurement capacity.
    const scheduled = [...actions.filter(a => a.do === 'merge'), ...actions.filter(a => a.do !== 'merge')], batch = this.batchOf(s, actions);
    for (const a of scheduled) {
      if (this.stopping) break;
      // F2.2: a notify with a `once` key (the environment back-off) is printed once per key.
      if (a.do === 'notify' && a.once !== undefined) { if (this.facts.once.has(a.once)) continue; this.facts.once.add(a.once); }
      if (a.do === 'attest' || a.do === 'merge') {
        // K6: start it in the background; over `drive.measure`, or a second merge: skipped, decided again later.
        const inFlight = [...this.measuring.values()];
        if (inFlight.length >= cap || (a.do === 'merge' && inFlight.some(m => m.do === 'merge'))) {
          // DQ2: the merge blocks a second merge even when an attest also occupies capacity.
          const blocker = inFlight.find(m => m.do === 'merge') ?? inFlight[0]!;
          const job = `${blocker.attempt === 0 ? 'trunk' : blocker.node} ${blocker.do}`;
          const reason = blocker.batch?.includes(a.node) ? `in batch with ${blocker.node}` : `driver-internal job (${job}, since ${clockTime(blocker.at)})`;
          this.recordMergeWaiting(a.node, reason, s, job);
          continue;
        }
        // Busy back-off: a measurement that ended busy waits for the next timed or event pass.
        if (this.busyAt.get(a.node) === this.cycle) continue;
        // F2.3: below `drive.min_free_mb` in the git common dir or the temp dir: no measurement starts this pass.
        low ??= await this.diskLow(s, reports);
        if (low) continue;
        if (a.do === 'merge') {
          const pending = await pendingAdopt(ledger.dir);
          if (pending) { this.recordMergeWaiting(a.node,adoptPendingReason(pending),s); continue; }
        }
        const r = this.start(s, a.do, a.node, a.do === 'merge' && batch[0] === a.node ? batch : undefined);
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
      const e: LoopEvent = { event: 'waiting', ...w }, slot = `${w.node}:waiting`, key = JSON.stringify(w);
      if (!this.o.once && this.facts.printed.get(slot) === key) continue;
      this.facts.printed.set(slot, key);
      this.o.log(this.o.json ? JSON.stringify(e) : reportText(e));
    }
    // IR1: refresh only on an otherwise quiet pass; run in the existing measurement lifecycle.
    if (!mergeReady && !this.stopping && !drift && checked && !this.measuring.size && !actions.some(a => a.do !== 'notify') && await ops.trunkRefreshPending({ cwd:this.root! })) {
      low ??= await this.diskLow(s,reports);
      if (!low && this.busyAt.get('trunk') !== this.cycle) { const r = this.startTrunkRefresh(s); reports.push(r); this.emit(r); }
    }
    // SW: a staying idle driver schedules the detached sweep and returns without awaiting it.
    let sweepBusy = this.sweepBusyAt === this.cycle;
    if (!mergeReady && this.o.stay && !this.o.once && !this.stopping && !drift && checked && s.plan.sweep && !this.sweepRun && !sweepBusy && !this.measuring.size && !Object.values(s.nodes).some(n=>n.phase === 'ready') && !actions.some(a=>a.do !== 'notify')) {
      const entries = await ledger.read();
      if (!entries.some(e=>e.kind === 'sweep' && e.commit === s.trunk.commit)) {
        low ??= await this.diskLow(s,reports);
        if (low) sweepBusy=true;
        else { const r=this.startSweep(s); reports.push(r); this.emit(r); }
      }
    }
    const head = (await ledger.read()).at(-1)?.hash;
    const nodes = Object.values(s.nodes).filter(n => !n.merged && n.phase !== 'removed');
    const counts: IdleCounts = { ready: nodes.filter(n => n.phase === 'ready').length, open: nodes.filter(n => n.slot?.open).length, waiting: waiting.length, reported: nodes.filter(n => reportedOf(s,n.id) !== undefined).length, later: s.plan.nodes.filter(n => n.later && !s.nodes[n.id]?.merged).length };
    const open = nodes.some(n => n.slot?.open && !waitingFor(s,n.id) && reportedOf(s,n.id) === undefined && !s.plan.nodes.find(x => x.id === n.id)?.later);
    return { actions: reports, progress: applied || handled > 0 || head !== s.head, idle: !sweepBusy && !this.sweepRun && !open && !actions.some(a => a.do === 'dispatch') && !this.measuring.size, head: s.head, waiting, counts, idleRewakeMin: idleRewakeMin(s.plan) };
  }

  /**
   * F2.3: checks the free space of the repository's git common dir and of os.tmpdir() against `drive.min_free_mb`;
   * when low, emits the repo-level notify once per change (paths and limit) and returns true.
   */
  private async diskLow(s: State, reports: ActionReport[]): Promise<boolean> {
    const min = minFreeMb(s.plan);
    if (min <= 0) return false;
    const common = await git.commonDir(this.root!).catch(() => undefined);
    const low = await lowDisk([...(common ? [common] : []), tmpdir()], min), slot = reportKey({ node: DISK_NODE, scope: 'repo' });
    if (!low.length) {
      // Cleared: forget the records, so an identical later low disk prints and wakes again.
      if (this.facts.disk !== undefined) { this.facts.disk = undefined; this.facts.printed.delete(`${slot}:notify`); this.facts.wakes.delete(slot); }
      return false;
    }
    const key = `${min}\u0000${low.map(l => l.path).join('\u0000')}`;
    if (this.facts.disk !== key) {
      this.facts.disk = key;
      const r: ActionReport = { do: 'notify', node: DISK_NODE, scope: 'repo', outcome: 'notify', text: diskLowText(low, min) };
      reports.push(r); this.emit(r, s);
    }
    return true;
  }

  private startSweep(s:State): ActionReport {
    const run={abort:new AbortController(),ended:Promise.resolve(),done:false,committing:false,reports:[] as ActionReport[]};
    const abort=()=>run.abort.abort(this.abort.signal.reason);
    this.abort.signal.addEventListener('abort',abort,{once:true});
    if (this.abort.signal.aborted) abort();
    run.ended=ops.sweep({cwd:this.root!,commit:s.trunk.commit,once:true,noWait:true,dsa:this.dsa,signal:run.abort.signal,onCommit:()=>{run.committing=true;}})
      .then(r=> {
        if (!r.skipped) run.reports.push(r.entry.verdict === 'pass'
          ? {do:'sweep',node:'sweep',scope:'repo',outcome:'pass',detail:renderSweep(r)}
          : {do:'notify',node:'sweep',scope:'repo',outcome:'notify',text:renderSweep(r),facts:r.entry.seq});
      },(e:unknown)=> {
        if (run.abort.signal.aborted) run.reports.push({do:'sweep',node:'sweep',scope:'repo',outcome:'aborted',detail:`sweep aborted: ${run.abort.signal.reason === 'preempted' ? 'preempted' : 'stopped'}`});
        else {
          const busy=e instanceof OwedError && e.code === 'busy';
          if (busy) this.sweepBusyAt=this.cycle;
          run.reports.push({do:'sweep',node:'sweep',scope:'repo',outcome:busy ? 'busy' : 'error',detail:e instanceof Error ? e.message : String(e)});
        }
      }).finally(()=> { this.abort.signal.removeEventListener('abort',abort); run.done=true; this.waker?.(); });
    this.sweepRun=run;
    return {do:'sweep',node:'sweep',scope:'repo',outcome:'started',at:new Date().toISOString()};
  }
  // ---------- measurements in flight (K6) ----------
  private startTrunkRefresh(s: State): ActionReport {
    const key = '\u0000trunk-refresh';
    const ac = new AbortController(), abort = () => ac.abort(this.abort.signal.reason);
    this.abort.signal.addEventListener('abort', abort, { once: true });
    if (this.abort.signal.aborted) abort();
    const at = new Date().toISOString(), m: Measurement = { do:'attest', node:'trunk', attempt:0, at, done:false, ended:Promise.resolve(), abort: ac };
    let busy: ActionReport | undefined;
    m.ended = withMachineLease({ cwd:this.root!, signal:ac.signal, lease:s.plan.lease !== false, noWait:true, dsa:this.dsa }, signal => ops.attestTrunk({ cwd:this.root!, signal }))
      .then(r => { m.finish = async () => [{ do:'attest', node:'trunk', scope:'repo', outcome:'done', detail:ops.attestTrunkText(r) }]; }, (e:unknown) => {
        const outcome = ac.signal.aborted ? 'aborted' : e instanceof OwedError && e.code === 'busy' ? 'busy' : 'error';
        const report: ActionReport = { do:'attest', node:'trunk', scope:'repo', outcome, detail:ac.signal.reason === 'preempted' ? 'trunk attest aborted: preempted' : e instanceof Error ? e.message : String(e) };
        if (outcome === 'busy') busy = report;
        m.finish = async () => [report];
      }).finally(() => {
        this.abort.signal.removeEventListener('abort', abort);
        m.done = true;
        if (busy) { this.measuring.delete(key); this.busyAt.set('trunk',this.cycle); if (!this.hard) this.emit(busy); return; }
        this.ended.push(m); this.waker?.();
      });
    this.measuring.set(key,m);
    return { do:'attest', node:'trunk', scope:'repo', outcome:'started', at };
  }
  /** Starts the attest or merge of `node` without awaiting it; returns its `started` report. */
  private start(s: State, what: 'attest' | 'merge', node: string, batch?: string[]): ActionReport {
    const attempt = s.nodes[node]!.slot!.attempt, at = new Date().toISOString();
    const m: Measurement = { do: what, node, attempt, at, ...(batch ? {batch} : {}), done: false, ended: Promise.resolve() };
    const work: Promise<Ended> = what === 'attest' ? this.attest(node, attempt, s.plan.lease !== false) : this.leasedMerge(node, attempt, s.plan.lease !== false, batch && { members: batch, trunk: s.trunk.commit });
    let busy: ActionReport | undefined;
    m.ended = work.then(f => { m.finish = f.finish; busy = f.busy; }, (e: unknown) => { m.finish = () => Promise.reject(e); })
      .finally(() => {
        m.done = true;
        // A busy measurement (LE2, review #785) is not progress and does not wake the loop: its line is printed now (so status no
        // longer lists it) and the node waits for the next timed or event pass.
        if (busy) { this.recordMergeWaiting(node, busy.detail ?? 'machine lease busy', s); this.measuring.delete(node); this.busyAt.set(node, this.cycle); if (!this.hard) this.emit(busy); return; }
        this.recordMergeWaiting(node);
        this.ended.push(m); this.waker?.();
      });
    this.measuring.set(node, m);
    return { do: what, node, outcome: 'started', at, ...(batch ? { detail: `batch of ${batch.length}: ${batch.join(', ')}` } : {}) };
  }
  /** A measurement ended and awaits `reap`: the loop's wait ends at once. */
  get woken(): boolean { return this.ended.length > 0 || this.sweepRun?.done === true; }
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
    if (this.hard) return 0;
    let swept=0;
    if (this.sweepRun?.done) {
      const finished=this.sweepRun; this.sweepRun=undefined; swept=1;
      for (const r of finished.reports) { out.push(r); this.emit(r); }
    }
    if (!this.ended.length) return swept;
    const batch = this.ended.splice(0), reports: ActionReport[] = [];
    // Each result is handled on its own: an unexpected error of one is rethrown only after the others were handled.
    let failure: { e: unknown } | undefined;
    for (const m of batch) {
      for (const [key, active] of this.measuring) if (active === m) this.measuring.delete(key);
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
    return batch.length+swept;
  }
  /** Stop (SPEC §12.7): waits for every in-flight measurement to end and handles it; returns at once on a stop at once. */
  async settle(out: ActionReport[] = []): Promise<void> {
    while ((this.measuring.size || this.sweepRun) && !this.hard) {
      await Promise.all([...this.measuring.values()].map(m=>m.ended).concat(this.sweepRun ? [this.sweepRun.ended] : []));
      if (this.hard) return;
      await this.reap(out);
    }
  }
  /** Stop at once: waits up to `ms` for the in-flight measurements (only merges: `merges`) to end; true when all did. */
  async drain(ms: number, merges = false): Promise<boolean> {
    const all = Promise.all([...this.measuring.values()].filter(m => !merges || m.do === 'merge').map(m => m.ended).concat(this.sweepRun ? [this.sweepRun.ended] : [])).then(() => true);
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
    if (s) r.inProgress = Object.values(s.nodes).filter(n => n.slot?.open && !n.merged).length;
    if (s && wakeReport(r) && r.scope !== 'repo' && s.nodes[r.node]) r.facts = factMark(s, r.node);
    if (r.scope === 'repo' && r.do === 'notify' && r.node === DRIFT_NODE) this.facts.drift = true;
    const rk = reportKey(r);
    if (!this.o.once && (r.outcome === 'notify' || r.outcome === 'busy')) {
      const key = `${r.once ?? busyKey(r.text ?? r.detail ?? '')}${r.outcome === 'notify' && r.facts !== undefined ? `\u0000${r.facts}` : ''}`, slot = `${rk}:${r.outcome}`;
      if (this.facts.printed.get(slot) === key) return;
      this.facts.printed.set(slot, key);
    // Any other measurement line, `started` included, ends the busy dedup: a started measurement always gets its completion
    // line (review #785), so status never lists one that ended.
    } else if (r.do === 'attest' || r.do === 'merge') this.facts.printed.delete(`${rk}:busy`);
    if (!this.o.once && r.facts !== undefined) {
      const text = reportText({ ...r, repeat: undefined }), last = this.facts.wakes.get(rk);
      if (last && last.text === text && last.facts === r.facts) r.repeat = ++last.n;
      else this.facts.wakes.set(rk, { text, facts: r.facts, n: 0 });
    }
    this.o.log(this.o.json ? JSON.stringify(r) : reportText(r));
  }

  private async halt(node: string, attempt: number, reason: string, needs: 'human' | 'owner' = 'human', since?: number): Promise<void> {
    await ops.halt({ cwd: this.o.cwd, as: DRIVE_PRINCIPAL, node, attempt, reason, needs, ...(since !== undefined ? { since } : {}) });
  }

  /**
   * Executes one action. `applied`: dsa applied a request (run/send) in it. F1 (0.11): the ledger entry of a decided
   * launch, send, rebase or halt carries `since` = the seq of `s`; when another principal's entry on the node landed
   * after it, ops records nothing (code `stale`), no dsa call is made, and the outcome is `stale` (no halt, no wake):
   * the next pass decides again. A re-send of a recorded entry and the verdict halts of dsa answers carry no `since`.
   */
  /** ER2: re-check dsa immediately before touching the slot; missing inspection is never proof of an idle writer. */
  private async rebaseSlot(s: State, node: string, since?: number): Promise<ops.RebaseResult> {
    const writer = s.nodes[node]?.runs.find(r => r.attempt === s.nodes[node]?.slot?.attempt)?.launches.find(l => l.role === 'writer');
    return ops.rebase({cwd:this.o.cwd,as:DRIVE_PRINCIPAL,node,since,apply:true,automatic:true,writerIdle:async () => {
      if (!writer) return true;
      try { const inspected = await this.dsa.inspect(writer.rid), view = this.current(inspected.view,inspected.gen); return view.state === 'sealed'; } catch { return false; }
    }});
  }
  private async execute(s: State, a: Action): Promise<{ report: ActionReport; applied: boolean }> {
    const base: ActionReport = { do: a.do, node: a.node, outcome: 'done' };
    const cwd = this.o.cwd, as = DRIVE_PRINCIPAL, since = s.seq;
    const done = (outcome: string, applied: boolean, detail?: string, extra: Partial<ActionReport> = {}) => ({ report: { ...base, ...extra, outcome, ...(detail ? { detail: oneLine(detail) } : {}) }, applied });
    try {
      switch (a.do) {
        case 'dispatch': { const r = await ops.dispatch({ cwd, as, node: a.node }); return done('done', false, `attempt ${r.attempt} in ${r.worktree}`); }
        case 'launch': {
          const extra = { attempt: a.attempt, role: a.role, rid: a.rid };
          await ops.launch({ cwd, as, node: a.node, attempt: a.attempt, role: a.role, rid: a.rid, spec: a.spec, labels: a.labels, ...(a.rulings !== undefined ? { rulings: a.rulings } : {}), since });
          crashPoint('before-dsa', 'launch');
          const r = await this.dsa.run(a.rid, a.spec, a.labels);
          crashPoint('after-dsa', 'launch');
          if (r.outcome === 'applied') return done('applied', true, r.created ? 'created' : 'already created', extra);
          // D14.1/D15.1: a rejection is a verdict: halt in this pass. The id and bytes are fixed for the attempt, so a
          // cleared halt retries the same request and dsa rejects it again; the halt names the recovery (abandon).
          if (r.outcome === 'rejected') { await this.halt(a.node, a.attempt, rejectedHalt(a.node, 'run', a.rid, r.reason)); return done('rejected', false, `${r.reason}; halted`, extra); }
          if (r.outcome === 'conflict') { const to = callAt({ rid: a.rid, state: 'running', ...(this.facts.lastTo.has(a.rid) ? { to: this.facts.lastTo.get(a.rid)! } : {}) }); await this.halt(a.node, a.attempt, `dsa request-conflict on run ${a.rid}${to} (recorded content differs${r.state ? `, state ${r.state}` : ''}); never retried with other bytes`); return done('conflict', false, 'halted', extra); }
          return done('pending', false, r.reason ?? 'retry next pass', extra);
        }
        case 'send': {
          const extra = { attempt: a.attempt, rid: a.rid, sendKind: a.sendKind, reason: a.reason };
          // G3.3 (0.12): a re-send of a recorded send (no new entry, so no `since` check in ops) decided on `s` is stale
          // when a later plan entry removed or changed the node.
          if (a.send) await ops.planChangedSince({ cwd, node: a.node, since });
          const id = a.send ?? (await ops.send({ cwd, as, node: a.node, attempt: a.attempt, rid: a.rid, sendKind: a.sendKind, message: a.message, reason: a.reason, ...(a.rulings !== undefined ? { rulings: a.rulings } : {}), since })).send;
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
              this.facts.sentGen.set(id, gen ?? null);
            }
            return done('applied', true, a.send ? 're-sent' : undefined, x);
          }
          if (r.outcome === 'rejected') this.facts.refused.set(id, r.reason);
          // SR3: a rejected steer is logged and cached, not halted here: next pass's row 4 applies SR1/SR2.
          // D22.3 keeps its stronger ruling-steer exemption: its undelivered rulings travel with the next follow-up.
          // Rejected follow-ups and notices keep their action-time behavior.
          if ((r.outcome === 'rejected' || r.outcome === 'conflict') && a.reason === 'ruling' && a.sendKind === 'notify') {
            const reason = r.outcome === 'rejected' ? r.reason : 'dsa request-conflict';
            this.facts.refused.set(id, reason);
            return done(r.outcome, false, `${reason}; prospective notice not retried, no halt`, x);
          }
          if (r.outcome === 'rejected' && a.reason === 'waiting') return done('rejected', false, `${r.reason}; waiting notice not retried`, x);
          if (r.outcome === 'rejected' && a.sendKind === 'steer') return done('rejected', false, a.reason === 'ruling'
            ? `${r.reason}; not retried as a steer (the writer's next follow-up carries these rulings; reviewers get them through the rulings obligation)`
            : `${r.reason}; no halt in this pass; next pass checks whether this steer was superseded or its run sealed`, x);
          // 0.8 (L1.4): the halt names the run's call address when describe reported one.
          const to = callAt({ rid: a.rid, state: 'running', ...(this.facts.lastTo.has(a.rid) ? { to: this.facts.lastTo.get(a.rid)! } : {}) });
          if (r.outcome === 'rejected') { await this.halt(a.node, a.attempt, rejectedHalt(a.node, 'send', `${id}${to}`, r.reason)); return done('rejected', false, `${r.reason}; halted`, x); }
          if (r.outcome === 'conflict') { await this.halt(a.node, a.attempt, `dsa request-conflict on send ${id}${to}; never retried with other bytes`); return done('conflict', false, 'halted', x); }
          return done('pending', false, r.reason ?? 'retry next pass', x);
        }
        // K6: attest and merge are started by `pass` (`start`), never executed inline.
        case 'attest': case 'merge': throw new Error(`${a.do} is a measurement`);
        case 'rebase': { const r = await this.rebaseSlot(s, a.node, since); return done('done', false, `slot base ${r.from.slice(0, 12)} → ${r.base.slice(0, 12)}`); }
        case 'halt': await this.halt(a.node, a.attempt, a.reason, a.needs, since); return done('halted', false, a.reason, { attempt: a.attempt, needs: a.needs });
        case 'notify': if (a.scope === 'repo') return { report:{ ...base, scope:'repo', outcome:'notify', text:a.text, ...(a.once !== undefined ? { once:a.once } : {}), ...(a.invariantRed ? { invariantRed:a.invariantRed } : {}) }, applied:false }; if (a.reportedResume !== undefined) { await ops.recordReport(this.ledger!,a.node,a.reportedResume); s.nodes[a.node]!.reported = a.reportedResume; } return { report: { ...base, outcome: a.quiet ? 'answered' : 'notify', text: a.text, ...(a.answerRetry ? { answerRetry: true as const } : {}), ...(a.rid !== undefined ? { rid: a.rid } : {}), ...(a.qid !== undefined ? { qid: a.qid, rev: a.rev } : {}) }, applied: false };
      }
    } catch (e) {
      // F4 (wais #31): a failed send names its node, kind and target like any other send line.
      const extra = a.do === 'send' ? { attempt: a.attempt, rid: a.rid, sendKind: a.sendKind, reason: a.reason, ...(a.send ? { send: a.send } : {}) } : {};
      if (e instanceof OwedError && e.code === 'stale') {
        if (a.do === 'launch' && a.role === 'writer') await ops.closeStaleSlot({ cwd, node:a.node, attempt:a.attempt });
        return done('stale', false, `${e.message}; decided again next pass`, a.do === 'halt' ? { attempt: a.attempt, needs: a.needs } : a.do === 'launch' ? { attempt: a.attempt, role: a.role, rid: a.rid } : extra);
      }
      if (e instanceof OwedError && e.code === 'busy' && ['rebase','launch','send'].includes(a.do)) return done('retry', false, `${e.message}; retry next pass`);
      if (a.do === 'dispatch' && ops.isCasRefusal(e)) return done('retry', false, `${e.message}; retry next pass`);
      if (e instanceof OwedError || e instanceof DsaError) return done('error', false, e.message, extra);
      throw e;
    }
  }

  /**
   * `pi-durable-subagents hold machine --shared --no-wait -- owed attest <node>` when dsa is available (D6/D9, dsa >=
   * 1.0.27), else `owed attest <node>`; resolves with how the loop handles the result. Exit 0/1/4: done (the ledger says
   * what follows). Exit 75: busy, nothing was queued, retry on a later pass: through hold either hold refusing the lease
   * or `owed attest` itself exiting 75 because another attest of the node runs (K1); directly only the latter. Anything
   * else — an owed error (2/3), a signal, dsa rejecting the invocation (an older dsa without `--no-wait`) — halts needing
   * a human on attempt `attempt` (D14.3).
   */
  private async attest(node: string, attempt: number, lease: boolean): Promise<Ended> {
    const available = dsaAvailable(this.dsa.bin), hold = lease && !machineLeased() && available;
    const argv = [...this.owed, 'attest', node, ...(!lease || !available ? ['--no-lease'] : [])], cwd = this.root!;
    const report = (outcome: string, detail?: string): ActionReport => ({ do: 'attest', node, outcome, ...(detail ? { detail: oneLine(detail) } : {}) });
    const measuredSince = (await this.ledger!.read()).length;
    const ok = (r: ActionReport): Ended => ({ finish: async () => [r] });
    const busy = (detail: string): Ended => { const r = report('busy', detail); return { finish: async () => [r], busy: r }; };
    const fail = (why: string): Ended => ({ finish: async () => { await this.halt(node, attempt, `attest error: ${why}`); return [report('error', `${why}; halted`)]; } });
    let ran: { exit: number | null; stdout: string; stderr: string };
    if (hold) {
      const r = await this.dsa.hold('machine', argv, { shared: true, cwd, env: { OWED_LEASED: '1' } });
      if (r.outcome === 'busy') return busy(busyDetail(node, r.reason));
      if (r.outcome === 'signal') return fail(`pi-durable-subagents hold ended by ${r.reason}`);
      if (r.outcome === 'refused') return fail(`pi-durable-subagents hold refused: ${tail(r.reason)}${/--no-wait/.test(r.reason) ? ' (owed drive requires pi-durable-subagents >= 1.0.27 for `hold --no-wait`)' : ''}`);
      ran = r;
    } else {
      try { ran = await runProcess(argv, cwd); } catch (e) { return fail(`cannot run ${argv[0]}: ${(e as Error).message}`); }
    }
    if (ran.exit === 0 || ran.exit === 1 || ran.exit === 4) return ok(report('done', `${ran.exit === 0 ? 'accepted' : 'not accepted yet'}${hold || machineLeased() ? '; lease: machine (shared)' : ''}${await this.noisyDetail(node, measuredSince)}`));
    if (ran.exit === 75) return busy(busyDetail(node, tail(ran.stderr || ran.stdout)));
    return fail(`owed attest exited ${ran.exit ?? 'by a signal'}: ${tail(ran.stderr || ran.stdout)}`);
  }

  /** RC1: latest observation of each item measured by this action; descriptive only, never a new verdict. */
  private async noisyDetail(node: string, since: number): Promise<string> {
    const latest = new Map<string, Extract<Entry, { kind: 'obs' }>>();
    for (const e of await this.ledger!.read()) if (e.seq >= since && e.kind === 'obs' && (e.subject === node || e.merging === node)) latest.set(`${e.subject}/${e.obligation}`, e);
    return [...latest].flatMap(([item, e]) => e.noisy && e.runs ? [`; ${item} noisy (${e.runs.filter(r => r.verdict === 'pass').length}/${e.runs.length} passed)`] : []).join('');
  }
  /**
   * `ops.merge` in this process (the CLI refuses `--as parent:drive`), aborted by a stop at once (D16a.1); resolves with
   * how the loop handles the result. Refusals (D14.2): `rebase needed` rebases; the transient refusal (the ledger moved
   * while merge measured; nothing recorded) and K4's `not measured` retry on a later pass; K4's changed slot and
   * invalidated candidate are reported (`superseded`), no halt; a CAS failure (trunk moved during the merge) is a
   * retry line plus the trunk drift notify, never a halt (ruling #559 c); any other refusal halts needing a human.
   */
  /** LE2: busy merge acquisition has the same back-off and status lifecycle as attest, never a halt. */
  private async leasedMerge(node: string, attempt: number, lease: boolean, batch?: { members: string[]; trunk: string }): Promise<Ended> {
    try {
      const finish = await withMachineLease({ cwd: this.root!, lease, dsa: this.dsa, noWait: true, signal: this.abort.signal }, signal => batch ? this.mergeBatch(batch.members, batch.trunk, signal) : this.merge(node, attempt, signal));
      return { finish };
    } catch (e) {
      if (e instanceof OwedError && e.code === 'busy') {
        const busy: ActionReport = { do: 'merge', node, outcome: 'busy', detail: busyDetail(node, e.message) };
        return { finish: async () => [busy], busy };
      }
      if (this.abort.signal.aborted) throw e;
      if (!(e instanceof OwedError || e instanceof DsaError)) throw e;
      return { finish: async () => { await this.halt(node, attempt, `merge error: ${e.message}`); return [{ do: 'merge', node, outcome: 'error', detail: `${e.message}; halted` }]; } };
    }
  }

  /**
   * MS2: after `owed resume <node> --remeasure`, measure the failed merge-tree invariants again (same lease) before the
   * merge reuses them. A refusal here (trunk moved, rebase needed) is left to the merge, which reports it as usual.
   */
  private async remeasureFirst(node: string, signal?: AbortSignal): Promise<void> {
    if (!remeasureDue(await loadState(this.ledger!), node)) return;
    try { await ops.attest({ cwd: this.o.cwd, node, remeasure: true, signal }); }
    catch (e) { if (!(e instanceof OwedError) || e.code === 'aborted' || e.code === 'busy') throw e; }
  }
  /**
   * MT: one batch merge of `members` (planned on trunk `trunk`). A pass reports every member merged; any refusal is
   * remembered for this trunk and reported as a retry: the next pass merges the members one at a time (never a halt).
   */
  private async mergeBatch(members: string[], trunk: string, signal?: AbortSignal): Promise<() => Promise<ActionReport[]>> {
    const report = (node: string, outcome: string, detail: string): ActionReport => ({ do: 'merge', node, outcome, detail: oneLine(detail) });
    try {
      const r = leaseResult(await ops.mergeBatch({ cwd: this.o.cwd, as: DRIVE_PRINCIPAL, nodes: members, signal }));
      return async () => r.nodes.map(id => report(id, 'merged', `trunk ${r.commit.slice(0, 12)} (batch of ${r.nodes.length}: ${r.nodes.join(', ')})${leaseText(r).replace('\n', '; ')}`));
    } catch (e) {
      if (!(e instanceof OwedError) || e.code !== 'refused') throw e;
      this.batchRefused.add(`${trunk}\0${members.join('\0')}`);
      return async () => {
        const now = await loadState(this.ledger!), d = /trunk changed \(CAS\)/.test(e.message) ? await git.trunkDrift(this.root!, now.trunk.name, now.trunk.commit).catch(() => undefined) : undefined;
        return [report(members[0]!, 'retry', `batch merge refused (${e.message}); ${members.join(', ')} merge one at a time from the next pass`), ...(d ? [driftReport(now, d)] : [])];
      };
    }
  }
  private async merge(node: string, attempt: number, signal?: AbortSignal): Promise<() => Promise<ActionReport[]>> {
    const cwd = this.o.cwd, as = DRIVE_PRINCIPAL;
    const measuredSince = (await this.ledger!.read()).length;
    let noisy = '';
    const report = (outcome: string, detail: string): ActionReport => ({ do: 'merge', node, outcome, detail: oneLine(`${detail}${noisy}`) });
    try {
      await this.remeasureFirst(node, signal);
      const r = leaseResult(await ops.merge({ cwd, as, node, signal }));
      return async () => [report('merged', `trunk ${r.commit.slice(0, 12)}${leaseText(r).replace('\n', '; ')}; ${unguardedText(r.unguarded)}${await this.noisyDetail(node, measuredSince)}`)];
    } catch (e) {
      if (!(e instanceof OwedError) || e.code !== 'refused') throw e;
      return async () => {
        noisy = await this.noisyDetail(node, measuredSince);
        // F5: a resume may land while the merge measures or awaits reaping. Decide its refusal on that state.
        const current = await loadState(this.ledger!);
        // TP1 (#1814): refuse the gate without blaming the writer or recording a halt.
        if (trunkParked(current, node).length) return [report('parked', 'waiting: trunk-red; repository notice follows next pass')];
        // FS3: every reason is a shared or trunk-caused failure: park (no halt, no writer follow-up); retried when the state moves.
        if (e instanceof ops.SharedRefusal && !halted(current, node)) {
          const parks = sharedParked(current, node);
          if (parks.length) { this.facts.once.add(sharedParkKey(current, node)); return [report('parked', `${sharedPhase(current, parks)}; owed retries the merge after trunk moves`)]; }
        }
        const waiting = waitingFor(current, node);
        if (waiting) return [report('waiting', `merge refused (${e.message}); ${waitingText(node, waiting.after, waiting.resume)}`)];
        if (e.message === MERGE_TRANSIENT) return [report('retry', `merge refused (${e.message}); retry next pass`)];
        // K4: a key the plan update introduced was not measured (the measured observations were kept): the next pass
        // merges again and measures only what lacks a verdict. Never a halt.
        if (e.message.includes('not measured: ')) return [report('retry', `merge refused (${e.message}); retry next pass`)];
        // K4: the slot moved (abandon, rebase, dispatch) or a plan entry invalidated the candidate: nothing was recorded
        // and the next pass decides on the new state (a new candidate, a rebase follow-up). Reported, never a halt.
        if (/^slot of \S+ changed \(/.test(e.message) || /^candidate #\d+ \S+ of \S+ was invalidated by plan #\d+/.test(e.message)) return [report('superseded', `merge refused (${e.message}); the next pass decides on the new state`)];
        if (e.message.startsWith('rebase needed')) {
          let r: ops.RebaseResult;
          try { r = await this.rebaseSlot(await loadState(this.ledger!), node); }
          catch (error) { if (error instanceof OwedError && error.code === 'busy') return [report('retry', `${error.message}; retry next pass`)]; throw error; }
          return [report('rebased', `merge refused (${e.message}); slot base ${r.from.slice(0, 12)} → ${r.base.slice(0, 12)}`)];
        }
        if (/trunk changed \(CAS\)/.test(e.message)) {
          const now = await loadState(this.ledger!), d = await git.trunkDrift(this.root!, now.trunk.name, now.trunk.commit).catch(() => undefined);
          return [report('retry', `merge refused (${e.message}); retry next pass`), ...(d ? [driftReport(now, d)] : [])];
        }
        // AT1: a merge-tree break lead stays the first sentence of the halt (and so of the Needs-you line).
        await this.halt(node, attempt, e.message.startsWith(ops.MERGE_TREE_BREAK) || e.message.startsWith(ops.SHARED_LEAD) ? e.message : `merge refused: ${e.message}`);
        return [report('refused', `${e.message}; halted (${NEEDS_PARENT})`)];
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
    const ar = n.slot?.open ? n.runs.find(r => r.attempt === n.slot!.attempt) : undefined, epoch = reviewEpoch(s, n.id);
    for (const l of ar?.launches.filter(l => l.role === 'writer' || (epoch !== undefined && l.seq > epoch)) ?? []) {
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
/** CLI exit code of a driver failure: refused, stale and version (refusals, G3.1 0.12) 1, usage 2, else 3. */
const REFUSALS: readonly string[] = ['refused', 'stale', 'version'];
const errorCode = (e: unknown): number => e instanceof OwedError ? (REFUSALS.includes(e.code) ? 1 : e.code === 'usage' ? 2 : 3) : 3;
/** `record`: write the exit record (`--json` loop); `reason`: how the loop ended; `written`: the record is out. */
interface LoopEnd { record?: boolean; reason?: ExitReason; written?: boolean }

async function driveLoop(o: DriveOptions, end: LoopEnd): Promise<number> {
  const output = o.log;
  let identity = { pid: process.pid, start: procStart(process.pid), at: new Date().toISOString() };
  if (o.json) o = { ...o, log: line => {
    let stamped: string;
    try { stamped = JSON.stringify({ ...JSON.parse(line), driver: identity }); }
    catch { stamped = line; }
    output(stamped);
  } };
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
    identity = { pid: lock.owner.pid, start: lock.owner.start, at: lock.owner.at };
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
    let idleAt: string | undefined, idleWake = 0;
    let counts: IdleCounts = { ready:0, open:0, waiting:0, reported:0, later:0 }, rewake = 60;
    for (;;) {
      /** H1.2: the ledger head the idle pass decided on; undefined when the last pass was not idle. */
      let idle: string | undefined;
      for (let burst = 0; burst < 20 && !driver.stopping; burst++) {
        let r: PassResult;
        try { r = await driver.pass(); }
        catch (e) {
          // F2.4: a full disk (or quota) is the environment's: the driver does not exit; it reports, sleeps, continues.
          if (!diskFullError(e)) throw e;
          const ev: LoopEvent = { event: 'disk-full', error: e instanceof Error ? e.message : String(e), at: new Date().toISOString() };
          say(reportText(ev), ev);
          await driver.wait(o.diskFullMs ?? 60_000, stop.signal);
          driver.tick();
          continue;
        }
        if (r.idle && !o.stay) { say('idle: nothing open and nothing ready', { event: 'idle' }); end.reason = 'idle'; return 0; }
        counts = r.counts; rewake = r.idleRewakeMin;
        if (r.idle) { idle = r.head; break; }
        idleAt = undefined;
        if (!r.progress) break;
      }
      if (idle !== undefined && !driver.stopping) {
        // Stay: keep the lock and wait for the ledger head to differ from the head the idle pass decided on (a plan
        // update, a ruling, an abandon…), then pass. An entry appended during that pass is already a change: no wait.
        if (idleAt === undefined) { idleAt = new Date().toISOString(); idleWake = Date.now(); const e: LoopEvent = { event: 'idle-wait', at: idleAt, counts }; say(reportText(e), e); }
        const head = idle;
        while (!driver.stopping && ledgerHead(ledger.dir) === head) {
          await driver.wait(o.pollMs ?? 3000, stop.signal);
          if (!driver.stopping && ledgerHead(ledger.dir) === head && idleRewakeDue(Date.now(),idleWake,rewake)) {
            idleWake = Date.now(); const e: LoopEvent = { event:'idle-wait', at:new Date(idleWake).toISOString(), counts }; say(reportText(e),e);
          }
          // Waiting/reported runs may ask questions, or complete a pending report, without ledger changes.
          if (counts.open) { await poll(); driver.tick(); break; }
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
