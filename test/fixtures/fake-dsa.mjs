#!/usr/bin/env node
// A fake pi-durable-subagents CLI for tests. It honors the program-facing subset owed uses, with the real exit codes:
//   run --request <id> --spec <file|-> [--labels <json>] [--cwd <dir>] [--json] [--wait-ms <n>]
//   send --request <id> --to <rid>[/<key>] --kind follow-up|steer|answer|model --message <text|@file> [--qid --rev --model --call] [--json] [--wait-ms]
//   describe --key <rid> [--json]
//   events --all [--since <cursor>] [--limit <n>] [--json] [--wait-ms]
//   0 applied · 1 rejected / invalid · 3 request-conflict · 4 cursor-expired · 75 pending
//   hold <resource> [--shared] [--no-wait] [--max-wait <s>] [--note <text>] -- <cmd> [args…]
//   leases [--json]
// Test hooks (not dsa commands): `fake-prune <rid>` marks a run pruned; `fake-compact <n>` drops the oldest n events.
// Leases: $FAKE_DSA_DIR/leases.json holds other processes' tickets, [{resource, holders:[{mode,…}], waiters:[…]}]
// (what `leases --json` prints; an optional `since` (epoch ms) gives the age hold prints). `hold` decides like dsa 1.0.27: a shared request is blocked by an exclusive holder or
// waiter, an exclusive one by any; blocked with --no-wait (or --max-wait 0) → exit 75 naming the blockers, nothing
// written; blocked without it → logged `queued: true` (a waiter was written) and then run; granted → the command runs
// (stdio passed through) and hold exits with its status. $FAKE_DSA_DIR/old-hold makes hold reject --no-wait like dsa
// < 1.0.27 (exit 1, `pi-durable-subagents: Error: Unknown option --no-wait`).
// Sessions (dsa 1.0.31): `run --session <id>` is accepted and logged as `session` (not part of the request content);
// an id dsa refuses (not /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/) is rejected (exit 1); without the flag an inherited
// $DSA_SESSION is used unless DSA_CALL/DSA_EXEC is set (an unusable inherited value is ignored), as dsa does;
// $FAKE_DSA_DIR/old-run makes run refuse --session like dsa < 1.0.31 (exit 1, reason `Unknown or repeated option --session`).
// Stale describe: $FAKE_DSA_DIR/stale-describe = <n>: after the next applied follow-up, the following n describes of
// that run return the run as it was before the follow-up (dsa's view lagging behind the applied send).
//
// State lives in $FAKE_DSA_DIR: state.json (requests, runs, events), specs/<id> (exact spec bytes as received),
// messages/<id> (exact message bytes), log.jsonl (one line per decided invocation, `executed` when an agent ran).
// Scripted agents: a run (and a follow-up / answer) executes $FAKE_DSA_DIR/agents/<node>-<role>-<gen>.sh, else
// <node>-<role>.sh (node and role from the run's labels), synchronously with `bash`, cwd = the run's cwd and env
// FAKE_RID, FAKE_GEN, FAKE_KIND (run|follow-up|answer), FAKE_MESSAGE, FAKE_SPEC (path of the spec bytes). Outcome:
// a stdout line `ASK: <text>` → asking; `RUNNING` → stays running; `STATUS: <s>` → sealed with that status;
// `FENCE: <reason>` → records lastFence and a `fenced` event; else exit 0 → sealed ok, non-zero → sealed failed.
// Without a script the run stays running.
// Faults: $FAKE_DSA_DIR/faults, one directive per line, the first matching line is consumed by the next invocation:
//   `run|send <exit> [none|record|apply]`  none: nothing recorded; record: request recorded but undecided (a retry
//   decides it); apply: decided (agent executed) but the reply is the given exit. Default: 75 → record, else none.
//   `events 4|75`  the next events call answers cursor-expired / pending.
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

const DIR = process.env.FAKE_DSA_DIR;
if (!DIR) { process.stderr.write('fake-dsa: FAKE_DSA_DIR is not set\n'); process.exit(2); }
mkdirSync(DIR, { recursive: true });
const sha = (b) => createHash('sha256').update(b).digest('hex');
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,123}$/;
const argv = process.argv.slice(2), command = argv[0];

class Exit { constructor(code, reply) { this.code = code; this.reply = reply; } }
const out = (reply) => process.stdout.write(`${JSON.stringify(reply)}\n`);

function flags(args, spec) {
  const values = {}, positionals = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.startsWith('--')) { positionals.push(a); continue; }
    const name = a.slice(2), kind = spec[name];
    if (!kind || Object.hasOwn(values, name)) throw new Error(`Unknown or repeated option ${a}`);
    if (kind === 'flag') { values[name] = true; continue; }
    const v = args[++i]; if (v === undefined) throw new Error(`${a} needs a value`);
    values[name] = v;
  }
  return { values, positionals };
}

// ---- state, lock, faults ----------------------------------------------------------------------------------------
const STATE = join(DIR, 'state.json'), LOCK = join(DIR, 'lock');
function load() {
  if (!existsSync(STATE)) save({ epoch: String(Date.now()), seq: 0, dropped: 0, wids: 0, requests: {}, runs: {}, events: [] });
  return JSON.parse(readFileSync(STATE, 'utf8'));
}
function save(s) { const tmp = `${STATE}.${process.pid}.tmp`; writeFileSync(tmp, JSON.stringify(s, null, 1)); renameSync(tmp, STATE); }
function alive(pid) { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } }
function lock() {
  const deadline = Date.now() + 5000;
  for (;;) {
    try { mkdirSync(LOCK); writeFileSync(join(LOCK, 'pid'), String(process.pid)); return true; }
    catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let pid = NaN; try { pid = Number(readFileSync(join(LOCK, 'pid'), 'utf8')); } catch { /* being written */ }
      if (Number.isInteger(pid) && pid > 0 && !alive(pid)) { rmSync(LOCK, { recursive: true, force: true }); continue; }
      if (Date.now() > deadline) return false;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
}
const unlock = () => rmSync(LOCK, { recursive: true, force: true });
function fault(cmd) {
  const file = join(DIR, 'faults'); if (!existsSync(file)) return undefined;
  const lines = readFileSync(file, 'utf8').split('\n'), at = lines.findIndex(l => l.trim().split(/\s+/)[0] === cmd);
  if (at < 0) return undefined;
  const [, code, mode] = lines[at].trim().split(/\s+/);
  lines.splice(at, 1); writeFileSync(file, lines.join('\n'));
  const exit = Number(code);
  return { exit, mode: mode ?? (exit === 75 ? 'record' : 'none') };
}
const log = (entry) => appendFileSync(join(DIR, 'log.jsonl'), `${JSON.stringify({ ...entry, ts: Date.now() })}\n`);
function faulted(f, request) {
  log({ cmd: command, request, exit: f.exit, fault: f.mode });
  if (f.exit === 75) return new Exit(75, { request, pending: true, reason: `fault: ${f.mode}` });
  if (f.exit === 3) return new Exit(3, { request, error: 'request-conflict', spec_digest: 'fault', state: 'fault' });
  return new Exit(f.exit, { request, applied: false, reason: 'fault' });
}

// ---- events and agents -------------------------------------------------------------------------------------------
function emit(s, run, type, fields = {}) {
  s.seq += 1;
  s.events.push({ id: `ev-${s.epoch}-${s.seq}`, cursor: `${s.epoch}:${s.seq}`, ts: Date.now(), type, wid: run.wid, request: run.rid,
    ...(Object.keys(run.labels).length ? { labels: run.labels } : {}),
    ...(type === 'submitted' ? {} : { key: 'main', gen: run.gen, call: `${run.wid}@1/main@${run.gen}` }), ...fields });
}
function execute(s, run, kind, message) {
  run.execs += 1;
  const exec = `${run.wid}-x${run.execs}`;
  emit(s, run, 'started', { exec });
  const agents = join(DIR, 'agents'), stem = `${run.labels.node ?? run.rid}-${run.labels.role ?? 'writer'}`;
  const script = [join(agents, `${stem}-${run.gen}.sh`), join(agents, `${stem}.sh`)].find(p => existsSync(p));
  run.state = 'running'; delete run.status; delete run.error; run.questions = [];
  if (!script) return false;
  const env = { ...process.env, FAKE_RID: run.rid, FAKE_GEN: String(run.gen), FAKE_KIND: kind, FAKE_MESSAGE: message ?? '', FAKE_SPEC: join(DIR, 'specs', run.rid) };
  delete env.NODE_TEST_CONTEXT;
  const r = spawnSync('bash', [script], { cwd: run.cwd, env, encoding: 'utf8', timeout: 300_000, maxBuffer: 64 * 1024 * 1024 });
  const stdout = r.stdout ?? '', lines = stdout.split('\n');
  run.output = stdout;
  for (const l of lines) {
    const m = /^FENCE:\s*(.*)$/.exec(l);
    if (m) { run.lastFence = { at: Date.now(), exec, reason: m[1].trim() || 'process-died' }; emit(s, run, 'fenced', { exec, reason: run.lastFence.reason, at: run.lastFence.at }); }
  }
  const asks = lines.map(l => /^ASK:\s?(.*)$/.exec(l)?.[1]).filter(q => q !== undefined);
  if (asks.length) {
    run.state = 'asking'; run.asked = (run.asked ?? 0) + 1;
    run.questions = asks.map((text, i) => ({ qid: `q${run.asked}-${i + 1}`, rev: 1, text }));
    for (const q of run.questions) emit(s, run, 'asking', { qid: q.qid, rev: q.rev, question: q.text, to: `${run.wid}/main` });
    return true;
  }
  if (lines.some(l => l.trim() === 'RUNNING')) return true;
  const forced = lines.map(l => /^STATUS:\s*(\S+)/.exec(l)?.[1]).findLast(x => x !== undefined);
  const code = r.error ? null : r.status;
  run.state = 'sealed'; run.status = forced ?? (code === 0 ? 'ok' : 'failed');
  if (run.status !== 'ok') run.error = r.error ? String(r.error.message) : code === 0 ? `status ${run.status}` : `exit ${code}${r.stderr ? `: ${r.stderr.trim().split('\n').slice(-3).join('\n')}` : ''}`;
  emit(s, run, 'sealed', { status: run.status, ...(run.error ? { error: run.error } : {}) });
  emit(s, run, 'workflow-done', { status: run.status === 'ok' ? 'done' : 'failed', ...(run.error ? { error: run.error } : {}) });
  return true;
}

// ---- commands -------------------------------------------------------------------------------------------------------
function invalid(id, reason) { return new Exit(1, { request: id ?? null, applied: false, reason }); }

function runCmd(args) {
  const { values, positionals } = flags(args, { request: 'value', spec: 'value', cwd: 'value', labels: 'value', json: 'flag', 'wait-ms': 'value', ...(existsSync(join(DIR, 'old-run')) ? {} : { session: 'value' }) });
  const id = values.request, file = values.spec, SID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
  if (values.session !== undefined && !SID.test(values.session)) return invalid(id, '--session must be a pi session id ([A-Za-z0-9._:-], at most 128 characters)');
  const inherited = process.env.DSA_CALL || process.env.DSA_EXEC ? undefined : process.env.DSA_SESSION;
  const sid = values.session ?? (inherited && SID.test(inherited) ? inherited : undefined), session = sid !== undefined ? { session: sid } : {};
  if (!id || !file || positionals.length) return invalid(id, 'usage: run --request <id> --spec <file|-> [--labels <json>] [--cwd <dir>] [--json]');
  if (!ID.test(id)) return invalid(id, `invalid request id ${id}`);
  const bytes = file === '-' ? readFileSync(0) : readFileSync(resolve(file));
  let spec; try { spec = JSON.parse(bytes.toString('utf8')); } catch (e) { return invalid(id, `--spec is not JSON: ${e.message}`); }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return invalid(id, '--spec must be a JSON object');
  if (spec.labels !== undefined) return invalid(id, 'labels are given with --labels <json>, not in the spec');
  let labels = {};
  if (values.labels !== undefined) {
    try { labels = JSON.parse(values.labels); } catch { return invalid(id, 'invalid labels: not JSON'); }
    if (!labels || typeof labels !== 'object' || Array.isArray(labels) || Object.values(labels).some(v => typeof v !== 'string')) return invalid(id, 'invalid labels: a flat object of strings');
  }
  const base = resolve(values.cwd ?? '.'), cwd = typeof spec.cwd === 'string' && spec.cwd ? resolve(base, spec.cwd) : base;
  const spec_digest = sha(bytes);
  const content = sha(JSON.stringify(['run', spec_digest, Object.keys(labels).sort().map(k => [k, labels[k]]), cwd]));
  const s = load(), prior = s.requests[id];
  if (prior && prior.content !== content) return new Exit(3, { request: id, error: 'request-conflict', ...(prior.wid ? { wid: prior.wid } : {}), spec_digest: prior.spec_digest, state: describeOf(s, id).state });
  if (prior?.decided) { log({ cmd: 'run', request: id, exit: prior.exit, created: false, ...session }); return new Exit(prior.exit, prior.exit === 0 ? { ...prior.reply, created: false } : prior.reply); }
  const f = prior ? undefined : fault('run');
  if (f?.mode === 'none') return faulted(f, id);
  if (!prior) {
    mkdirSync(join(DIR, 'specs'), { recursive: true }); writeFileSync(join(DIR, 'specs', id), bytes);
    s.requests[id] = { id, kind: 'run', content, spec_digest, decided: false };
  }
  const req = s.requests[id];
  if (f?.mode === 'record') { save(s); return faulted(f, id); }
  if (typeof spec.agent !== 'string' && !Array.isArray(spec.tasks)) {
    Object.assign(req, { decided: true, exit: 1, reply: { request: id, applied: false, reason: 'spec names no agent', spec_digest } }); save(s);
    log({ cmd: 'run', request: id, exit: 1 }); return new Exit(1, req.reply);
  }
  const wid = `w${++s.wids}`;
  const run = s.runs[id] = { rid: id, wid, labels, cwd, agent: typeof spec.agent === 'string' ? spec.agent : 'tasks', gen: 1, execs: 0, state: 'running', questions: [], steers: [] };
  Object.assign(req, { decided: true, wid, exit: 0, reply: { request: id, wid, created: true, spec_digest } });
  emit(s, run, 'submitted', {});
  const executed = execute(s, run, 'run');
  save(s);
  log({ cmd: 'run', request: id, exit: f ? f.exit : 0, created: true, executed, ...(f ? { fault: f.mode } : {}), ...session });
  if (f) return f.exit === 75 ? new Exit(75, { request: id, pending: true, reason: `fault: ${f.mode}` }) : new Exit(f.exit, { request: id, applied: false, reason: 'fault' });
  return new Exit(0, req.reply);
}

function sendCmd(args) {
  const { values, positionals } = flags(args, { request: 'value', to: 'value', call: 'value', kind: 'value', qid: 'value', rev: 'value', message: 'value', model: 'value', json: 'flag', 'wait-ms': 'value' });
  const id = values.request, to = values.to, kind = values.kind;
  if (!id || !to || !kind || positionals.length) return invalid(id, 'usage: send --request <id> --to <run-id> --kind <k> --message <text|@file>');
  if (!ID.test(id)) return invalid(id, `invalid request id ${id}`);
  if (!['follow-up', 'steer', 'answer', 'model'].includes(kind)) return invalid(id, `unknown kind ${kind}`);
  const raw = values.message, message = raw === undefined ? undefined : raw.startsWith('@') ? readFileSync(resolve(raw.slice(1))) : Buffer.from(raw);
  const rid = to.split('/')[0];
  const spec_digest = sha(JSON.stringify(['send', to, kind, message ? sha(message) : null, values.qid ?? null, values.rev ?? null, values.model ?? null]));
  const s = load(), prior = s.requests[id];
  if (prior && prior.content !== spec_digest) return new Exit(3, { request: id, error: 'request-conflict', spec_digest: prior.spec_digest, state: describeOf(s, id).state });
  if (prior?.decided) { log({ cmd: 'send', request: id, exit: prior.exit, replay: true }); return new Exit(prior.exit, prior.reply); }
  const target = s.requests[rid];
  if (target?.kind === 'run' && !target.decided) return new Exit(75, { request: id, pending: true, reason: `run ${rid} has no workflow yet` });
  const f = prior ? undefined : fault('send');
  if (f?.mode === 'none') return faulted(f, id);
  if (!prior) {
    mkdirSync(join(DIR, 'messages'), { recursive: true }); if (message) writeFileSync(join(DIR, 'messages', id), message);
    s.requests[id] = { id, kind: 'send', content: spec_digest, spec_digest, decided: false };
  }
  const req = s.requests[id];
  if (f?.mode === 'record') { save(s); return faulted(f, id); }
  const run = s.runs[rid], text = message?.toString('utf8') ?? '';
  const decide = (exit, reply) => Object.assign(req, { decided: true, exit, reply: { request: id, ...reply, spec_digest } });
  let executed = false;
  if (!run || run.pruned) decide(1, { applied: false, reason: `unknown target ${to}` });
  else if (kind === 'follow-up') {
    if (run.state !== 'sealed') decide(1, { applied: false, reason: `${to} is not finished; use steer` });
    else {
      const staleFile = join(DIR, 'stale-describe');
      if (existsSync(staleFile)) { s.stale = { rid, left: Number(readFileSync(staleFile, 'utf8').trim()) || 1, view: describeOf(s, rid) }; rmSync(staleFile); }
      run.gen += 1; decide(0, { applied: true, generation: run.gen, call: `${run.wid}/main` }); executed = execute(s, run, 'follow-up', text); }
  } else if (kind === 'steer') {
    if (run.state === 'sealed') decide(1, { applied: false, reason: `${to} is finished; use follow-up` });
    else { run.steers.push(text); decide(0, { applied: true }); }
  } else if (kind === 'answer') {
    const q = run.questions.find(x => values.qid === undefined || x.qid === values.qid);
    if (run.state !== 'asking' || !q) decide(1, { applied: false, reason: `no open question on ${to}` });
    else { emit(s, run, 'answered', { qid: q.qid, rev: q.rev, by: 'cli:fake', digest: sha(text), length: text.length }); decide(0, { applied: true }); executed = execute(s, run, 'answer', text); }
  } else decide(0, { applied: true });
  save(s);
  log({ cmd: 'send', request: id, kind, exit: f ? f.exit : req.exit, executed, ...(f ? { fault: f.mode } : {}) });
  if (f) return f.exit === 75 ? new Exit(75, { request: id, pending: true, reason: `fault: ${f.mode}` }) : new Exit(f.exit, { request: id, applied: false, reason: 'fault' });
  return new Exit(req.exit, req.reply);
}

function describeOf(s, id) {
  const req = s.requests[id];
  if (!req) return { state: 'absent', request: id };
  const run = s.runs[id], head = { request: id, kind: req.kind, spec_digest: req.spec_digest, ...(run && Object.keys(run.labels).length ? { labels: run.labels } : {}) };
  if (req.kind === 'send') return req.decided ? (req.exit === 0 ? { state: 'applied', ...head } : { state: 'rejected', ...head, reason: req.reply.reason }) : { state: 'pending', ...head };
  if (!req.decided) return { state: 'pending', ...head };
  if (!run) return { state: 'rejected', ...head, reason: req.reply.reason };
  if (run.pruned) return { state: 'pruned', wid: run.wid, pruned: { status: run.status === 'ok' ? 'done' : 'failed', endedAt: run.pruned }, ...head };
  const sealed = run.state === 'sealed';
  return { state: run.state, wid: run.wid, ...head, status: sealed ? (run.status === 'ok' ? 'done' : 'failed') : 'running', ...(sealed && run.error ? { error: run.error } : {}),
    calls: [{ key: 'main', gen: run.gen, phase: sealed ? 'sealed' : run.state, agent: run.agent, ...(sealed ? { status: run.status, ok: run.status === 'ok', ...(run.error ? { error: run.error } : {}), output: run.output ?? '' } : {}) }],
    ...(run.state === 'asking' ? { questions: run.questions.map(q => ({ qid: q.qid, rev: q.rev, to: `${run.wid}/main`, call: `${run.wid}@1/main@${run.gen}`, text: q.text })) } : {}),
    ...(run.lastFence ? { lastFence: run.lastFence } : {}) };
}
function describeCmd(args) {
  const { values, positionals } = flags(args, { key: 'value', json: 'flag' });
  if (!values.key || positionals.length) throw new Error('describe needs --key <request id>');
  const s = load();
  let view = describeOf(s, values.key);
  if (s.stale?.rid === values.key && s.stale.left > 0) {
    view = s.stale.view; s.stale.left -= 1; save(s);
    log({ cmd: 'describe', request: values.key, stale: true });
  }
  process.stdout.write(`${JSON.stringify(view, null, 2)}\n`);
  return new Exit(0);
}

// ---- leases and hold (no state lock: hold runs a command that may call this fake again) ---------------------------
function leaseState() {
  const file = join(DIR, 'leases.json');
  return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
}
function leasesCmd(args) {
  flags(args, { json: 'flag' });
  process.stdout.write(`${JSON.stringify(leaseState(), null, 2)}\n`);
  return new Exit(0);
}
function holdCmd(args) {
  const sep = args.indexOf('--');
  if (sep < 0 || sep === args.length - 1) { process.stderr.write('pi-durable-subagents: Error: hold needs -- before the command\n'); return new Exit(1); }
  const own = args.slice(0, sep), argvCmd = args.slice(sep + 1);
  if (existsSync(join(DIR, 'old-hold')) && own.includes('--no-wait')) {
    process.stderr.write('pi-durable-subagents: Error: Unknown option --no-wait. usage: pi-durable-subagents hold <resource> [--shared] [--max-wait <seconds>] [--note <text>] -- <command> [args…]\n');
    log({ cmd: 'hold', exit: 1, old: true }); return new Exit(1);
  }
  const { values, positionals } = flags(own, { shared: 'flag', 'no-wait': 'flag', 'max-wait': 'value', note: 'value' });
  const resource = positionals[0], mode = values.shared ? 'shared' : 'exclusive', noWait = !!values['no-wait'] || values['max-wait'] === '0';
  const entry = leaseState().find(r => r.resource === resource) ?? { holders: [], waiters: [] };
  const incompatible = (t) => mode === 'exclusive' || t.mode === 'exclusive';
  const blockers = [...entry.holders.filter(incompatible).map(t => ({ ...t, state: 'holding' })), ...entry.waiters.filter(incompatible).map(t => ({ ...t, state: 'waiting' }))];
  if (blockers.length && noWait) {
    process.stderr.write(`hold: ${resource} is not free now (${blockers.map(t => `${t.who ?? 'pid ?'} (${t.mode}${t.state === 'waiting' ? ', waiting' : ''}, ${t.since ? Math.max(0, Math.round((Date.now() - t.since) / 1000)) : 1}s)`).join(', ')}); not running the command (exit 75)\n`);
    log({ cmd: 'hold', resource, mode, refused: true, exit: 75 }); return new Exit(75);
  }
  const r = spawnSync(argvCmd[0], argvCmd.slice(1), { stdio: 'inherit' });
  const code = r.error ? 127 : r.status ?? 128;
  log({ cmd: 'hold', resource, mode, noWait, granted: true, ...(blockers.length ? { queued: true } : {}), argv: argvCmd, exit: code });
  return new Exit(code);
}

function eventsCmd(args) {
  const { values, positionals } = flags(args, { all: 'flag', since: 'value', limit: 'value', json: 'flag', 'wait-ms': 'value' });
  const bad = (message) => new Exit(1, { error: 'invalid-arguments', message });
  if (!values.all || positionals.length) return bad('events needs --all');
  const limit = values.limit === undefined ? 1000 : Number(values.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) return bad('--limit needs an integer 1..1000');
  const s = load(), head = `${s.epoch}:${s.seq}`, oldest = `${s.epoch}:${s.dropped}`;
  const f = fault('events');
  if (f?.exit === 4) return new Exit(4, { error: 'cursor-expired', head, oldest });
  if (f?.exit === 75) return new Exit(75, { pending: true });
  if (values.since === undefined) return new Exit(0, { head, more: false });
  const m = /^([^:]+):(\d+)$/.exec(values.since);
  if (!m) return bad(`malformed cursor ${values.since}`);
  const seq = Number(m[2]);
  if (m[1] !== s.epoch || seq < s.dropped || seq > s.seq) return new Exit(4, { error: 'cursor-expired', head, oldest });
  const after = s.events.filter(e => Number(e.cursor.split(':')[1]) > seq), page = after.slice(0, limit), more = after.length > page.length;
  for (const e of page) out(e);
  return new Exit(0, { head: more ? page.at(-1).cursor : head, more });
}

function hook(args) {
  const s = load();
  if (command === 'fake-prune') { const run = s.runs[args[0]]; if (!run || run.state !== 'sealed') throw new Error(`cannot prune ${args[0]}`); run.pruned = Date.now(); }
  else { const n = Number(args[0]), dropped = s.events.splice(0, n); if (dropped.length) s.dropped = Number(dropped.at(-1).cursor.split(':')[1]); }
  save(s); return new Exit(0, { ok: true });
}

const commands = { run: runCmd, send: sendCmd, describe: describeCmd, events: eventsCmd, 'fake-prune': hook, 'fake-compact': hook };
const unlocked = { hold: holdCmd, leases: leasesCmd };
let result;
if (unlocked[command]) {
  try { result = unlocked[command](argv.slice(1)); } catch (e) { process.stderr.write(`pi-durable-subagents: Error: ${e.message}\n`); result = new Exit(1); }
}
else if (!commands[command]) result = invalid(undefined, `fake-dsa: unsupported command ${command}`);
else if (!lock()) result = new Exit(75, { pending: true, reason: 'busy' });
else {
  try { result = commands[command](argv.slice(1)); }
  catch (e) { const at = argv.indexOf('--request'); result = invalid(at >= 0 ? argv[at + 1] : undefined, e.message); }
  finally { unlock(); }
}
if (result.reply) out(result.reply);
process.exitCode = result.code;
