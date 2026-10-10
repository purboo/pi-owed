// dsa (pi-durable-subagents) client: spawns the CLI with an argv array (no shell) and `--json`, maps its exit codes to a
// typed outcome, and never re-serializes the caller's spec bytes (they go to `run --spec -` on stdin unchanged).
// Exit codes: 0 applied, 1 rejected, 3 request-conflict, 4 cursor-expired (events), 75 pending (retry the same id).
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import type { RunState, RunView } from './types.ts';

/** The subset of `describe --key <rid> --json` the driver uses (contract D1); defined once in `src/types.ts`. */
export type { RunState, RunQuestion, RunView } from './types.ts';
export interface DsaEvent {
  id: string; cursor: string; ts?: number; type: string; wid?: string; request?: string; labels?: Record<string, string>;
  key?: string; gen?: number; call?: string; [field: string]: unknown;
}
export type SendKind = 'follow-up' | 'steer' | 'answer' | 'model';

export type Rejected = { outcome: 'rejected'; reason: string; spec_digest?: string };
export type Conflict = { outcome: 'conflict'; spec_digest?: string; state?: string; wid?: string };
export type Pending = { outcome: 'pending'; reason?: string };
export type RunResult = { outcome: 'applied'; wid: string; created: boolean; spec_digest: string } | Rejected | Conflict | Pending;
export type SendResult = { outcome: 'applied'; generation?: number; call?: string; spec_digest: string } | Rejected | Conflict | Pending;
export type EventsResult = { outcome: 'applied'; events: DsaEvent[]; head: string; more: boolean } | { outcome: 'expired'; head: string; oldest: string } | Pending | Rejected;

export class DsaError extends Error {
  readonly exit: number | null; readonly stderr: string; readonly stdout: string;
  constructor(message: string, detail: { exit?: number | null; stderr?: string; stdout?: string } = {}) {
    super(message); this.name = 'DsaError'; this.exit = detail.exit ?? null; this.stderr = detail.stderr ?? ''; this.stdout = detail.stdout ?? '';
  }
}

export interface DsaOptions {
  /** Executable; default `$OWED_DSA`, else `~/.pi/durable-subagents/bin/pi-durable-subagents`. */
  bin?: string;
  /** Extra environment for the child (merged over process.env). */
  env?: NodeJS.ProcessEnv;
  /** `--wait-ms` passed to run/send/events (dsa's own default is 60 s when omitted). */
  waitMs?: number;
  /** Hard limit for one CLI invocation; default waitMs (or 60 s) + 30 s. */
  timeoutMs?: number;
  /** Working directory of the child process (not the run's cwd). */
  cwd?: string;
  /** The pi session every `run` names with `--session` (dsa >= 1.0.31, E1); none: no flag. */
  session?: string;
}

/** A pi session id exactly as dsa 1.0.31 accepts it for `--session`: a letter or digit, then up to 127 of `[A-Za-z0-9._:-]`. */
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
/**
 * The pi session a driver started in (E1, dsa 1.0.31): `$DSA_SESSION`, which pi exports to the processes it starts.
 * Ignored inside a pi-durable-subagents call (`DSA_CALL` or `DSA_EXEC` set: a subagent), exactly as dsa ignores it, and
 * when it is not a session id dsa accepts.
 */
export function startingSession(env: NodeJS.ProcessEnv = process.env): string | undefined {
  if (env.DSA_CALL || env.DSA_EXEC) return undefined;
  const s = env.DSA_SESSION;
  return s && SESSION_ID.test(s) ? s : undefined;
}

export function dsaBin(env: NodeJS.ProcessEnv = process.env): string {
  return env.OWED_DSA || join(homedir(), '.pi', 'durable-subagents', 'bin', 'pi-durable-subagents');
}
export function dsaAvailable(bin = dsaBin()): boolean {
  try { accessSync(bin, constants.X_OK); return true; } catch { return false; }
}

/** `signal`: the child was ended by a signal that was not our timeout (exit is null then). */
interface Spawned { exit: number | null; stdout: string; stderr: string; timedOut: boolean; signal?: NodeJS.Signals }
const LIMIT = 16 * 1024 * 1024;

export class Dsa {
  readonly bin: string; private readonly opts: DsaOptions;
  /** Process groups of the CLI invocations still running (`killAll`). */
  private readonly live = new Set<number>();
  /** Ends every running invocation's process group (hold forwards it to its command): the driver's hard stop. */
  killAll(sig: NodeJS.Signals = 'SIGTERM'): void { for (const pid of this.live) { try { process.kill(-pid, sig); } catch { /* gone */ } } }
  constructor(opts: DsaOptions = {}) { this.opts = opts; this.bin = opts.bin ?? dsaBin({ ...process.env, ...opts.env }); this.session = opts.session; }
  /** The pi session `run` passes as `--session <id>` (E1); undefined: no flag. */
  session?: string;
  /** Called once when this dsa refuses `--session` (older than 1.0.31); `run` drops the flag from then on. */
  onSessionRefused?: (reason: string) => void;
  /** This dsa refused `--session` once: never passed again by this client. */
  sessionRefused = false;

  private timeout(): number { return this.opts.timeoutMs ?? (this.opts.waitMs ?? 60_000) + 30_000; }
  private wait(): string[] { return this.opts.waitMs === undefined ? [] : ['--wait-ms', String(this.opts.waitMs)]; }

  /** One invocation; `input` is written to stdin byte-for-byte. Spawn failures (missing binary) throw DsaError. `timeoutMs` 0: no time limit. */
  private exec(args: string[], input?: string | Uint8Array, timeoutMs = this.timeout(), cwd = this.opts.cwd): Promise<Spawned> {
    return new Promise((resolve, reject) => {
      let child;
      // Own process group, so a timeout can end the CLI with whatever it started in its group (dsa's orchestrator is
      // detached into a group of its own and survives).
      // E1: dsa never picks a session up from the environment; `run` names it with `--session` when this client has one,
      // so the driver's lock and what dsa records never disagree.
      const env: NodeJS.ProcessEnv = { ...process.env, ...this.opts.env }; delete env.DSA_SESSION;
      try { child = spawn(this.bin, args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true }); }
      catch (e) { reject(new DsaError(`cannot run ${this.bin}: ${(e as Error).message}`)); return; }
      const pid = child.pid; if (pid) this.live.add(pid);
      const out: Buffer[] = [], err: Buffer[] = []; let outLen = 0, errLen = 0, timedOut = false, failed: Error | undefined;
      child.stdout.on('data', (b: Buffer) => { if (outLen < LIMIT) { out.push(b); outLen += b.length; } });
      child.stderr.on('data', (b: Buffer) => { if (errLen < LIMIT) { err.push(b); errLen += b.length; } });
      const signal = (sig: NodeJS.Signals) => { try { if (child.pid) process.kill(-child.pid, sig); } catch { /* already gone */ } };
      const timer = timeoutMs <= 0 ? undefined : setTimeout(() => {
        timedOut = true; signal('SIGTERM');
        setTimeout(() => signal('SIGKILL'), 2000).unref();
        // A descendant outside the group may still hold the pipes: stop waiting for them.
        setTimeout(() => { child.stdout.destroy(); child.stderr.destroy(); }, 4000).unref();
      }, timeoutMs);
      child.on('error', e => { failed = e; });
      // EPIPE when the child exits before reading stdin is reported by `close`/`exit`, not as a crash here.
      child.stdin.on('error', () => {});
      child.on('close', (code, sig) => {
        if (pid) this.live.delete(pid);
        if (timer) clearTimeout(timer);
        const stdout = Buffer.concat(out).toString('utf8'), stderr = Buffer.concat(err).toString('utf8');
        // A spawn failure (missing binary: Node reports the negative errno, e.g. -2 for ENOENT, as the code) never ran dsa.
        if (failed && !timedOut) { reject(new DsaError(`cannot run ${this.bin}: ${failed.message}`, { stderr, stdout })); return; }
        resolve({ exit: code, stdout, stderr, timedOut, ...(code === null && sig && !timedOut ? { signal: sig } : {}) });
      });
      if (input !== undefined) child.stdin.end(input); else child.stdin.end();
    });
  }

  /** `run --request <rid> --spec - --labels <json> --cwd <dir> --json`; specBytes go to stdin exactly as given. */
  async run(rid: string, specBytes: string | Uint8Array, labels?: Record<string, string>, cwd?: string): Promise<RunResult> {
    const session = this.sessionRefused ? undefined : this.session;
    const args = ['run', '--request', rid, '--spec', '-', ...(labels ? ['--labels', JSON.stringify(labels)] : []), ...(cwd ? ['--cwd', cwd] : []), ...(session !== undefined ? ['--session', session] : []), '--json', ...this.wait()];
    const r = await this.exec(args, specBytes);
    // E1.2: a dsa older than 1.0.31 refuses the unknown flag before it records anything: drop it and run again.
    const refused = session !== undefined ? sessionRefusal(r) : undefined;
    if (refused !== undefined) { this.sessionRefused = true; this.onSessionRefused?.(refused); return this.run(rid, specBytes, labels, cwd); }
    return requestOutcome(r, reply => ({ outcome: 'applied', wid: str(reply.wid), created: reply.created === true, spec_digest: str(reply.spec_digest) }));
  }

  /** `send --request <id> --to <rid> --kind <k> --message @<file> --json`; the message goes through a private temp file. */
  async send(id: string, to: string, kind: SendKind, message: string | Uint8Array, extra: { qid?: string; rev?: number; model?: string } = {}): Promise<SendResult> {
    const dir = await mkdtemp(join(tmpdir(), 'owed-dsa-'));
    try {
      const file = join(dir, 'message'); await writeFile(file, message, { mode: 0o600 });
      const args = ['send', '--request', id, '--to', to, '--kind', kind, ...(extra.qid !== undefined ? ['--qid', extra.qid] : []), ...(extra.rev !== undefined ? ['--rev', String(extra.rev)] : []),
        '--message', `@${file}`, ...(extra.model !== undefined ? ['--model', extra.model] : []), '--json', ...this.wait()];
      const r = await this.exec(args);
      return requestOutcome(r, reply => ({ outcome: 'applied', ...(typeof reply.generation === 'number' ? { generation: reply.generation } : {}), ...(typeof reply.call === 'string' ? { call: reply.call } : {}), spec_digest: str(reply.spec_digest) }));
    } finally { await rm(dir, { recursive: true, force: true }); }
  }

  /** `describe --key <rid> --json` reduced to a RunView. Failures (non-zero exit, timeout, unparsable output) throw. */
  async describe(rid: string): Promise<RunView> { return (await this.inspect(rid)).view; }

  /**
   * `describe` plus the run's latest generation (the highest `calls[].gen`, when dsa reports one). The driver compares it
   * with the generation a follow-up returned, so a describe that still shows the previous, sealed generation is not
   * read as the follow-up's outcome.
   */
  async inspect(rid: string): Promise<{ view: RunView; gen?: number }> {
    const r = await this.exec(['describe', '--key', rid, '--json']);
    if (r.timedOut) throw new DsaError(`dsa describe ${rid} timed out`, r);
    if (r.exit !== 0) throw new DsaError(`dsa describe ${rid} exited ${r.exit}: ${tail(r.stderr || r.stdout)}`, r);
    const d = parseWhole(r.stdout);
    if (!d) throw new DsaError(`dsa describe ${rid}: unparsable output`, r);
    const gens = (Array.isArray(d.calls) ? d.calls as Json[] : []).map(c => c.gen).filter((g): g is number => typeof g === 'number');
    return { view: toRunView(rid, d), ...(gens.length ? { gen: Math.max(...gens) } : {}) };
  }

  /**
   * State of a send (or stop) request id: `describe --key <id>` reports `applied` or `rejected` (with `reason`) once dsa
   * decided it, `pending` before, `absent` when dsa never saw it. Failures throw like `describe`.
   */
  async request(id: string): Promise<{ state: 'applied' | 'rejected' | 'pending' | 'absent'; reason?: string }> {
    const r = await this.exec(['describe', '--key', id, '--json']);
    if (r.timedOut) throw new DsaError(`dsa describe ${id} timed out`, r);
    if (r.exit !== 0) throw new DsaError(`dsa describe ${id} exited ${r.exit}: ${tail(r.stderr || r.stdout)}`, r);
    const d = parseWhole(r.stdout), state = str(d?.state);
    if (state === 'applied' || state === 'pending' || state === 'absent') return { state };
    if (state === 'rejected') return { state, reason: str(d?.reason) || 'rejected' };
    throw new DsaError(`dsa describe ${id}: not a send request (state ${state || 'unknown'})`, r);
  }

  /**
   * `hold <resource> [--shared] --no-wait -- <argv…>` (dsa >= 1.0.27): run `argv` while holding the lease, or refuse at
   * once. `cwd`: where the command runs. No time limit (the command's own limits apply). Outcomes: `busy` — exit 75, the lease was refused and nothing
   * was queued (the caller's command never exits 75: `owed` exits 0..3), `reason` names the blockers; `refused` — dsa
   * itself rejected the invocation (non-zero exit, a `pi-durable-subagents:` error on stderr and nothing on stdout,
   * e.g. an older dsa that does not know `--no-wait`); `signal` — hold was ended by a signal; else `ran` with the
   * command's exit status and output.
   */
  async hold(resource: string, argv: string[], o: { shared?: boolean; cwd?: string } = {}): Promise<
    { outcome: 'ran'; exit: number | null; stdout: string; stderr: string } | { outcome: 'busy'; reason: string } | { outcome: 'refused'; reason: string } | { outcome: 'signal'; reason: string }> {
    const r = await this.exec(['hold', resource, ...(o.shared ? ['--shared'] : []), '--no-wait', '--', ...argv], undefined, 0, o.cwd ?? this.opts.cwd);
    if (r.signal) return { outcome: 'signal', reason: `signal ${r.signal}` };
    if (r.exit === 75) return { outcome: 'busy', reason: tail(r.stderr || r.stdout) || `${resource} is busy` };
    if (r.exit !== 0 && !r.stdout.trim() && /^pi-durable-subagents: /m.test(r.stderr)) return { outcome: 'refused', reason: tail(r.stderr) };
    return { outcome: 'ran', exit: r.exit, stdout: r.stdout, stderr: r.stderr };
  }

  /** `events --all [--since <cursor>] [--limit <n>] --json`. Without `since` only the head is returned. */
  async events(since?: string, limit?: number): Promise<EventsResult> {
    const args = ['events', '--all', ...(since !== undefined ? ['--since', since] : []), ...(limit !== undefined ? ['--limit', String(limit)] : []), '--json', ...this.wait()];
    const r = await this.exec(args);
    if (r.timedOut) return { outcome: 'pending', reason: 'timeout' };
    if (r.signal) return { outcome: 'pending', reason: `signal ${r.signal}` };
    const lines = jsonLines(r.stdout);
    if (r.exit === 4) {
      const e = lines.findLast(l => l.error === 'cursor-expired');
      if (!e) throw new DsaError('dsa events: exit 4 without cursor-expired reply', r);
      return { outcome: 'expired', head: str(e.head), oldest: str(e.oldest) };
    }
    if (r.exit === 75) return { outcome: 'pending', ...reasonOf(lines.at(-1)) };
    if (r.exit === 1) return { outcome: 'rejected', reason: str(lines.at(-1)?.message ?? lines.at(-1)?.error) || tail(r.stderr) || 'rejected' };
    if (r.exit !== 0) throw new DsaError(`dsa events exited ${r.exit}: ${tail(r.stderr || r.stdout)}`, r);
    const trailer = lines.at(-1);
    if (!trailer || typeof trailer.head !== 'string' || 'type' in trailer) throw new DsaError('dsa events: missing head line', r);
    const events = lines.slice(0, -1).filter(l => typeof l.type === 'string' && typeof l.id === 'string') as DsaEvent[];
    return { outcome: 'applied', events, head: trailer.head, more: trailer.more === true };
  }
}

type Json = Record<string, unknown>;
const str = (v: unknown): string => typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
const tail = (s: string): string => s.trim().split('\n').slice(-5).join('\n').slice(-2000);
const reasonOf = (j: Json | undefined): { reason?: string } => typeof j?.reason === 'string' ? { reason: j.reason } : {};

function jsonLines(stdout: string): Json[] {
  const out: Json[] = [];
  for (const line of stdout.split('\n')) {
    const t = line.trim(); if (!t.startsWith('{')) continue;
    try { const v = JSON.parse(t); if (v && typeof v === 'object' && !Array.isArray(v)) out.push(v as Json); } catch { /* not a reply line */ }
  }
  return out;
}
function parseWhole(stdout: string): Json | undefined {
  try { const v = JSON.parse(stdout); if (v && typeof v === 'object' && !Array.isArray(v)) return v as Json; } catch { /* fall through */ }
  return jsonLines(stdout).at(-1);
}

/**
 * The refusal text when dsa rejected `run` for not knowing `--session` (dsa < 1.0.31: `Unknown or repeated option
 * --session`, as a JSON reply's reason or on stderr), else undefined. Nothing was recorded then (argument parsing
 * precedes the request).
 */
function sessionRefusal(r: Spawned): string | undefined {
  if (r.timedOut || r.signal || r.exit === 0 || r.exit === 75 || r.exit === 3) return undefined;
  const text = `${str(parseWhole(r.stdout)?.reason)}\n${r.stderr}`;
  return /\b(?:unknown|unrecognized|unexpected)\b[^\n]*--session\b/i.test(text) ? tail(text) : undefined;
}

/**
 * run/send exit-code mapping. A timeout after spawning may have submitted: it is `pending` (retry with the same id);
 * so is a child killed by a signal that was not our timeout (exit code null), whatever it printed before dying.
 */
function requestOutcome<T>(r: Spawned, applied: (reply: Json) => T): T | Rejected | Conflict | Pending {
  if (r.timedOut) return { outcome: 'pending', reason: 'timeout' };
  if (r.signal) return { outcome: 'pending', reason: `signal ${r.signal}` };
  const reply = parseWhole(r.stdout);
  switch (r.exit) {
    case 0:
      if (!reply) throw new DsaError('dsa: exit 0 without a JSON reply', r);
      return applied(reply);
    case 1: return { outcome: 'rejected', reason: str(reply?.reason) || tail(r.stderr) || 'rejected', ...(typeof reply?.spec_digest === 'string' ? { spec_digest: reply.spec_digest } : {}) };
    case 3: return { outcome: 'conflict', ...(typeof reply?.spec_digest === 'string' ? { spec_digest: reply.spec_digest } : {}), ...(typeof reply?.state === 'string' ? { state: reply.state } : {}), ...(typeof reply?.wid === 'string' ? { wid: reply.wid } : {}) };
    case 75: return { outcome: 'pending', ...reasonOf(reply) };
    default: throw new DsaError(`dsa exited ${r.exit}: ${tail(r.stderr || r.stdout)}`, r);
  }
}

/** Reduce dsa's describe reply. Workflow statuses (`done`) are read as call statuses (`ok`); the status is the latest
 *  generation's call status (first non-ok when a run has several calls), else the workflow's. */
export function toRunView(rid: string, d: Json): RunView {
  const wfStatus = (s: unknown): string | undefined => typeof s !== 'string' ? undefined : s === 'done' ? 'ok' : s;
  const base = { rid, ...(typeof d.wid === 'string' ? { wid: d.wid } : {}), ...(typeof d.spec_digest === 'string' ? { spec_digest: d.spec_digest } : {}),
    ...(d.labels && typeof d.labels === 'object' ? { labels: d.labels as Record<string, string> } : {}) };
  const raw = str(d.state);
  if (raw === 'absent') return { ...base, state: 'absent' };
  if (raw === 'pending') return { ...base, state: 'queued' };
  // A rejected run never starts: it is final, like a sealed run that failed.
  if (raw === 'rejected') return { ...base, state: 'sealed', status: 'rejected', ...(typeof d.reason === 'string' ? { error: d.reason } : {}) };
  if (raw === 'pruned') {
    const p = (d.pruned ?? {}) as Json;
    return { ...base, state: 'pruned', status: wfStatus(p.status) ?? 'unknown' };
  }
  const state: RunState = raw === 'asking' || raw === 'sealed' ? raw : 'running';
  const calls = Array.isArray(d.calls) ? d.calls as Json[] : [];
  const statuses = calls.map(c => c.status).filter((s): s is string => typeof s === 'string');
  const callStatus = statuses.length && statuses.length === calls.length ? statuses.find(s => s !== 'ok') ?? 'ok' : undefined;
  const status = state === 'sealed' ? callStatus ?? wfStatus(d.status) ?? 'unknown' : undefined;
  const error = typeof d.error === 'string' ? d.error : calls.map(c => c.error).find((e): e is string => typeof e === 'string');
  const questions = Array.isArray(d.questions) ? (d.questions as Json[]).map(q => ({ qid: str(q.qid), rev: Number(q.rev), question: str(q.text ?? q.question), ...(typeof q.to === 'string' ? { to: q.to } : {}) })) : undefined;
  const f = d.lastFence as Json | undefined;
  return { ...base, state, ...(status ? { status } : {}), ...(error ? { error } : {}), ...(questions?.length ? { questions } : {}),
    ...(f && typeof f === 'object' ? { lastFence: { reason: str(f.reason), at: Number(f.at), ...(typeof f.exec === 'string' ? { exec: f.exec } : {}) } } : {}) };
}
