import { readFile, mkdir, appendFile, rmdir, writeFile, rename, unlink, chmod, truncate } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { serialize, deserialize } from 'node:v8';
import { performance } from 'node:perf_hooks';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { stringify, parseDocument, isMap, isSeq, isScalar, type YAMLMap } from 'yaml';
import { canonical, sha256 } from './canon.ts';
import { Ledger, PLAN_CACHE_VERSION, entryHash, type LockOwner } from './ledger.ts';
import { rebasePending, rebasePendingText } from './rebase-view.ts';
import { planReceipt, renderEntry } from './views.ts';
import * as git from './git.ts';
import { quarantineNames, parsePlan, planDowngrades, worktreesConfig, expandBranch, worktreesErrors, nodeIdCaseErrors, execEnvErrors, invariantId } from './plan.ts';
import { genesisProgress, refreshChanged, trunkJobs, trunkInvariantReds, jobCurrent, invalidates, carryable, DRIVER, entriesOf, afterNodes, reportRequest } from './reducer.ts';
import { mergeTreeBreaks, carriedDefer } from './reducer.ts';
import { reduce, reduceFrom, extendState, packState, unpackState, sameReplay, type PackedState } from './reducer.ts';
import { validateDraft, attestJobs, genesisJobs, mergeJobs, mergeGuard, adoptJobs, adoptGuard, decoyDigest as digestOf, decoyPayloadErrors, overlapping, withinWrites, grantsOf, grantErrors, grantHint, halted, manualKeys, adoptPrefixes, unadoptable, allowanceSeq, activeRisk, mergeRisk, trunkRedOf, writesAllowed, stateQuarantine, quarantinedJob, remeasureJobs, trunkRemeasureJobs } from './reducer.ts';
import { runJob, runCommand, lastLines } from './exec.ts';
import { withMachineLease, measurementScope, leaseResult } from './lease.ts';
import { unguardedPaths, mergeCoverage } from './sweep.ts';
export { sweep } from './sweep.ts';
import { unruledBlocks } from './drive.ts';
import { readLock } from './drive-bg.ts';
import { launchedReviewAck, parentOverlapWarnings } from './parentops.ts';
import { editText, editDiff, type EditFields } from './edit.ts';
import { lintPlanShell } from './planlint.ts';
import { computeMetrics, metricsBound, type Metrics, type MetricsWindow } from './metrics.ts';
import { OwedError } from './errors.ts';
import { receipt, statusView, escapeSummary, driftText, dispatchPacket, supersededOf, trunkRedHint, mergeFailureHints, knownRedDebt, oneLine, templateReceiptRun, reusedHint, quarantineDebt, quarantineText } from './views.ts';
import type { ReceiptCard, StatusView, Report, DeferredView } from './views.ts';
import { briefView } from './views.ts';
import { waiverText } from './views.ts';
import type { Brief } from './views.ts';
import type { CheckSpec, NodeState } from './types.ts';
import type { AnswerRef, RuleEntry, AttestJob, CandidateFacts, StateFacts, Channel, DecoyPayload, Draft, Entry, EscapeClass, EvidenceEntry, EvidenceFile, HaltEntry, ItemView, LaunchEntry, NodeSpec, ObsEntry, Plan, Principal, RunRole, SendEntry, SendKind, SendReason, State, SubmitEntry } from './types.ts';
export type { ReceiptCard, StatusView, Report } from './views.ts';
export type { Brief } from './views.ts';
/** An item a job measured: its observation was not recorded because the item was no longer current (D24.1). */
export interface JobRef { subject: string; obligation: string; key: string }
/**
 * Genesis attest outcome (D24): `recorded`/`missing` are the genesis invariant ids with and without a non-error
 * observation after the run; `failed` the observed ones that failed; `superseded` the jobs dropped because their item
 * was no longer current; `error` why the run stopped early (init only; attestGenesis rejects instead).
 */
export interface GenesisAttest { complete: boolean; recorded: string[]; failed: string[]; missing: string[]; superseded: JobRef[]; error?: string }
export interface InitResult { entry: Entry; observations: Entry[]; status: StatusView; genesis: GenesisAttest; lease?: string; warnings?: string[] }
export interface InitPreview { trunk: string; commit: string; planSha: string; nodes: number; invariants: string[] }
export interface AttestGenesisResult extends GenesisAttest { observations: Entry[]; lease?: string }
export interface AttestTrunkResult { refresh?: Entry; changed: string[]; observations: Entry[]; superseded: JobRef[]; failed: string[]; missing: string[]; lease?: string; /** MS1: `--remeasure` jobs and their observations. */ remeasured?: string[]; remeasuredObs?: Entry[] }
export function attestTrunkText(r: AttestTrunkResult): string {
  return `${r.remeasured ? `${remeasureText(undefined,r.remeasured,r.remeasuredObs ?? [])}\n` : ''}${r.refresh ? `Trunk refresh #${r.refresh.seq}: ${r.changed.join(', ')}` : r.observations.length ? 'Trunk refresh resumed' : 'Nothing to refresh on trunk'}; ${r.observations.length} observations recorded${r.failed.length ? `; failed ${r.failed.join(', ')}` : ''}${r.missing.length ? `; missing ${r.missing.join(', ')} — owed attest --trunk` : ''}${supersededText(r.superseded)}`;
}
export interface DispatchPacket { node: string; attempt: number; worktree: string; branch: string; packet: string; entry: Entry; subagent: { agent: 'worker'; cwd: string; task: string } }
export interface AttestResult { node: string; observations: Entry[]; superseded: JobRef[]; accepted: boolean; receipt: ReceiptCard; lease?: string; /** MS1: obligations `--remeasure` measured again. */ remeasured?: string[] }
export interface MergeResult { node: string; commit: string; tree: string; entry: Entry; deferred: ItemView[]; unguarded: string[]; lease?: string }
/** `cacheMismatch` (N4): plan shas whose persistent cache entry disagreed with the YAML blob; verify rewrote them. */
/**
 * `snapshotMismatch` (G1.4): seq of a disk snapshot that matched the chain but differed from the full replay at that seq;
 * verify deleted it. `code` (G1.5): `version` when the ledger needs a newer owed (the CLI exits 1, not 3).
 */
export interface VerifyResult { ok: boolean; entries: number; head?: string; error?: string; code?: 'version'; cacheMismatch?: string[]; snapshotMismatch?: number }
type Context = { cwd: string };
type MeasurementContext = Context & { lease?: boolean; signal?: AbortSignal };
/** LE3: lease before operation/tree locks; never mutate process.env or persisted observations. */
async function leased<T extends object>(o: MeasurementContext, measure: (signal?: AbortSignal) => Promise<T>): Promise<T & { lease?: string }> {
  const { state } = await load(await Ledger.open(o.cwd));
  return withMachineLease({ ...o, lease: o.lease !== false && state.plan.lease !== false }, async signal => leaseResult(await measure(signal)));
}
type Actor = Context & { as: Principal; channel?: Channel };
const by = (o: Actor): string => `${o.as.role}:${o.as.id}`;
function owner(o: Actor): void { if (o.as.role === 'owner' && !['tty', 'pi-confirm', 'flag', 'delegated'].includes(o.channel ?? '')) throw new OwedError('owner actions require a confirmation channel'); }
/**
 * D25.3: the environment variable naming a pi-durable-subagents call (`DSA_CALL`, else `DSA_EXEC`) when this process is
 * one, else undefined. Such a process may not act as owner or parent (pi tools and CLI); an accident rail, not security.
 */
export function subagentCall(env: NodeJS.ProcessEnv = process.env): 'DSA_CALL' | 'DSA_EXEC' | undefined { return env.DSA_CALL ? 'DSA_CALL' : env.DSA_EXEC ? 'DSA_EXEC' : undefined; }
/** D25.3 refusal when a subagent call would act as owner or parent; undefined when allowed. */
export function subagentRefusal(role: string, env: NodeJS.ProcessEnv = process.env): string | undefined {
  const v = subagentCall(env);
  return v && (role === 'owner' || role === 'parent') ? `owner and parent acts are reserved for the main agent; this process is a subagent call (${v})` : undefined;
}
/** G2.3 (F5): refusal of a claimed `parent:drive` (CLI `--as`, pi `as`); only the driver records as it, internally. */
export const DRIVER_CLAIM = "parent:drive is the driver's identity: only owed drive records as it; it cannot be claimed with --as or as";
/** D25.4: `OWED_CONFIRM=owner` restores the owner confirmation (pi dialog / TTY prompt); otherwise owner acts are delegated. */
export function confirmGate(env: NodeJS.ProcessEnv = process.env): boolean { return env.OWED_CONFIRM?.trim() === 'owner'; }
function guard(s: State, d: Draft): void { const errors = validateDraft(s,d); if (errors.length) throw new OwedError(errors.join('; ')); }
/**
 * N4: parsed plans by `<owed dir>\0<blob sha>`, for the life of the process. Blobs are content-addressed and immutable,
 * so an entry never needs invalidation; plans are deep-frozen because every load shares them (the reducer clones what
 * it keeps). Behind it is the persistent cache of the ledger (Ledger.readPlanCache), then the YAML blob.
 */
const planCache = new Map<string, Plan>();
function deepFreeze<T>(v: T): T { if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v)) deepFreeze(x); } return v; }
async function cachedPlan(ledger: Ledger, sha: string): Promise<Plan> {
  const k = `${ledger.dir}\0${sha}`;
  let p = planCache.get(k);
  if (p) return p;
  const stored = await ledger.readPlanCache(sha);
  if (stored) p = stored as Plan;
  else { p = parsePlan((await ledger.getBlob(sha)).toString()); await ledger.writePlanCache(sha, p); }
  planCache.set(k, deepFreeze(p));
  return p;
}
/** G1: cachedPlan, synchronously (a plan a state from the replay caches resolves on first use); the cache write is not awaited. */
function cachedPlanSync(ledger: Ledger, sha: string): Plan {
  const k = `${ledger.dir}\0${sha}`;
  let p = planCache.get(k);
  if (p) return p;
  const stored = ledger.readPlanCacheSync(sha);
  if (stored) p = stored as Plan;
  else { p = parsePlan(ledger.getBlobSync(sha).toString()); void ledger.writePlanCache(sha, p); }
  planCache.set(k, deepFreeze(p));
  return p;
}
/** Plan shas the ledger names (genesis and plan entries), in ledger order. */
const planShas = (entries: Entry[]): string[] => [...new Set(entries.flatMap(e => e.kind === 'genesis' || e.kind === 'plan' ? [e.plan] : []))];
/**
 * The verified entries, a plan lookup for the plans they (and `extra`) name, and the replayed state. G1: the plans the
 * fold needs (all of them for a full replay; those named after the cached seq, and `extra`, for a fold from a replay
 * cache) are read before it as in 0.11; any other named plan is read on first use (cachedPlanSync).
 */
async function load(ledger: Ledger, extra: string[] = []) {
  // Capture before the first await: verification may invalidate this load while the ledger is being read.
  const control = replayControl(ledger.dir), epoch = control.epoch;
  const entries = await ledger.read(), known = new Set([...planShas(entries), ...extra]), plans = new Map<string, Plan>();
  const lookup = (sha: string): Plan => {
    let p = plans.get(sha);
    if (p) return p;
    if (!known.has(sha)) throw new OwedError(`Missing plan ${sha}`, 'internal');
    p = cachedPlanSync(ledger, sha); plans.set(sha, p); return p;
  };
  const need = async (from: number): Promise<void> => { for (const sha of new Set([...planShas(entries.slice(from)), ...extra])) if (!plans.has(sha)) plans.set(sha, await cachedPlan(ledger, sha)); };
  return { entries, lookup, state: await replay(ledger,entries,lookup,need,control,epoch) };
}
/**
 * G1.3 (0.12): the in-process replay cache, per ledger dir (at most MEMO_DIRS, least recently used dropped): a
 * v8-serialized packed state at (seq, hash) and the seq of the disk snapshot this process knows of (-1: none). Kept
 * serialized, so every load deserializes its own copy and no two results alias.
 */
interface Memo { seq: number; hash: string; payload: Buffer; disk: number }
const memos = new Map<string, Memo>(), MEMO_DIRS = 16;
/** A ledger's invalidation epoch and serialized disk/memo publication barrier (verify deletion shares the barrier). */
interface ReplayControl { epoch: number; publication: Promise<void> }
const replayControls = new Map<string, ReplayControl>();
function replayControl(dir: string): ReplayControl {
  let c = replayControls.get(dir);
  if (!c) { c = { epoch: 0, publication: Promise.resolve() }; replayControls.set(dir, c); }
  return c;
}
function publishReplay(c: ReplayControl, act: () => Promise<void>): Promise<void> {
  const pending = c.publication.then(act);
  c.publication = pending.catch(() => undefined);
  return pending;
}
/** Drop the memo immediately; any preceding disk publication finishes before deletion, and cannot refill the memo. */
async function invalidateReplay(ledger: Ledger): Promise<void> {
  const c = replayControl(ledger.dir);
  c.epoch++; memos.delete(ledger.dir);
  await publishReplay(c, () => ledger.removeSnapshot());
}
/** G1.4: a disk snapshot is (re)written after a load that folded at least this many entries past it, or found none. */
export const SNAPSHOT_EVERY = 256;
/** G1.3: the in-process cache is re-serialized after a load that folded at least this many entries past it. */
const MEMO_EVERY = 32;
/** @internal Test hooks: counts of the replay paths `load` took (full replays, folds from the cache or a disk snapshot), entries folded and ms spent replaying (after the ledger read). */
export const replayStats = { full: 0, memo: 0, disk: 0, folded: 0, ms: 0 };
/** @internal Test hook: forget the in-process replay cache (as a fresh process). */
export function forgetReplays(): void { memos.clear(); for (const c of replayControls.values()) c.epoch++; }
/** @internal Test hook: the ledger's entries and replayed state as an op loads them (no effect beyond the replay caches). */
export async function readState(o: Context): Promise<{ entries: Entry[]; state: State }> { const { entries, state } = await load(await Ledger.open(o.cwd)); return { entries, state }; }
/**
 * DL1/DL3 (0.16): the driver uses the same verified replay and plan caches as ops. `load` returns a private state;
 * publish its ledger-only replay before applying the optional reports.json overlay, which must never enter a cache.
 */
export async function loadDriverState(ledger: Ledger): Promise<State> {
  const state = inited((await load(ledger)).state);
  await applyReports(ledger,state);
  return state;
}
const unpacked = (payload: Buffer, lookup: (sha: string) => Plan): State | undefined => { try { return unpackState(deserialize(payload) as PackedState, lookup); } catch { return undefined; } };
/**
 * G1.3/G1.4: the state of the verified `entries`. It continues the fold from the in-process cache, else from the disk
 * snapshot, when the entry of its seq has its hash; any other case is a full replay. Afterwards it refreshes the
 * in-process cache and, when the fold went at least SNAPSHOT_EVERY entries past the disk snapshot (or there was none),
 * rewrites the disk snapshot (best effort). Equal to `reduce(entries, lookup)` (G1.1).
 */
async function replay(ledger: Ledger, entries: Entry[], lookup: (sha: string) => Plan, need: (from: number) => Promise<void>, control: ReplayControl, epoch: number): Promise<State> {
  if (!entries.length) { await need(0); return reduce(entries,lookup); }
  // New loads wait for a pending verify deletion before reading the disk snapshot.
  await control.publication;
  const t0 = performance.now(), at = (seq: number, hash: string): boolean => entries[seq]?.hash === hash;
  let m = memos.get(ledger.dir), state: State | undefined, via: 'memo' | 'disk' | undefined;
  if (!(m && at(m.seq,m.hash))) { const d = await ledger.readSnapshot(); m = d && at(d.seq,d.hash) ? { ...d, disk: d.seq } : undefined; via = 'disk'; } else via = 'memo';
  if (m) { await need(m.seq+1); state = unpacked(m.payload,lookup); }
  if (!state) { m = undefined; via = undefined; await need(0); }
  const start = state ? state.seq+1 : 0;
  if (state) extendState(state,entries.slice(start)); else state = reduce(entries,lookup);
  replayStats[via ?? 'full']++; replayStats.folded += entries.length-start;
  let disk = m?.disk ?? -1, next = m;
  const write = disk < 0 || state.seq-disk >= SNAPSHOT_EVERY;
  if (!next || write || state.seq-next.seq >= MEMO_EVERY) next = { seq:state.seq, hash:state.head, payload:serialize(packState(state)), disk };
  await publishReplay(control, async () => {
    if (control.epoch !== epoch) return;
    // A failed write is not retried before SNAPSHOT_EVERY more entries: the snapshot is best effort.
    if (write) { await ledger.writeSnapshot(next.seq,next.hash,next.payload); disk = next.seq; }
    // Verification can invalidate while the disk write awaits I/O. Its queued deletion runs after this write.
    if (control.epoch !== epoch) return;
    memos.delete(ledger.dir); memos.set(ledger.dir,{ ...next, disk });
    if (memos.size > MEMO_DIRS) memos.delete(memos.keys().next().value!);
  });
  replayStats.ms += performance.now()-t0;
  return state;
}
function inited(s: State): State { if (s.seq < 0) throw new OwedError('Not initialized: run owed init <plan.yaml> first'); return s; }
function node(s: State, id: string) { const n = inited(s).nodes[id]; if (!n) throw new OwedError(`Node ${id} does not exist`); return n; }
function candidate(s: State, id: string) { const n = node(s,id); if (!n.slot?.open || !n.candidate) throw new OwedError(`Node ${id} has no open candidate`); return n; }
// Keep the public error class/code; only these CAS refusals are eligible for an operation retry.
const casRefusals = new WeakSet<OwedError>();
function casRefusal(message: string): OwedError { const error = new OwedError(message); casRefusals.add(error); return error; }
/** N2: fresh snapshot per attempt, at most three; a changed plan or failed rollback keeps the refusal. */
async function retryCas<T>(ledger: Ledger, run: (before: State) => Promise<T>): Promise<T> {
  let prior: State | undefined, refusal: unknown;
  for (let attempt = 0; ; attempt++) {
    const before = (await load(ledger)).state;
    if (prior && before.planSha !== prior.planSha) throw refusal;
    try { return await run(before); }
    catch (error) {
      if (attempt === 2 || !(error instanceof OwedError) || !casRefusals.has(error)) throw error;
      prior = before; refusal = error;
    }
  }
}
function stable(before: State, after: State, id?: string): void {
  if (before.planSha !== after.planSha || before.trunk.commit !== after.trunk.commit || (id && (before.nodes[id]?.slot?.dispatchSeq !== after.nodes[id]?.slot?.dispatchSeq || before.nodes[id]?.slot?.base !== after.nodes[id]?.slot?.base || before.nodes[id]?.candidate?.seq !== after.nodes[id]?.candidate?.seq || before.nodes[id]?.slot?.open !== after.nodes[id]?.slot?.open))) throw casRefusal('Plan, candidate or trunk changed; retry');
}
/**
 * K4.1: the node-scoped merge CAS. A merge refuses (recording nothing) only when what it measured from moved: the ledger
 * trunk, or node `id`'s slot (dispatch seq, attempt, base, open) or candidate (submit seq, commit). Plan updates and
 * entries of other nodes do not refuse by themselves: the guard decides on the latest state. The refusal names the
 * cause when a retry cannot succeed: a changed slot, or a candidate a plan entry invalidated (its node spec changed).
 */
function nodeStable(before: State, latest: Awaited<ReturnType<typeof load>>, id: string): void {
  const after = latest.state, a = before.nodes[id], b = after.nodes[id], since = latest.entries.filter(e => e.seq > before.seq);
  if (before.trunk.commit !== after.trunk.commit) throw new OwedError('Plan, candidate or trunk changed; retry');
  if (a?.slot?.dispatchSeq !== b?.slot?.dispatchSeq || a?.slot?.attempt !== b?.slot?.attempt || a?.slot?.base !== b?.slot?.base || a?.slot?.open !== b?.slot?.open) {
    const e = since.find(e => (e.kind === 'dispatch' || e.kind === 'abandon' || e.kind === 'rebase') && e.node === id);
    throw new OwedError(`slot of ${id} changed (${e ? `#${e.seq} ${e.kind}` : 'unknown entry'}); nothing recorded`);
  }
  if (a?.candidate?.seq === b?.candidate?.seq && a?.candidate?.commit === b?.candidate?.commit) return;
  if (a?.candidate && !b?.candidate) {
    // G1.3: the state after each later entry, folded onto a copy of `before` (the state of the entries up to before.seq).
    let sim: State | undefined;
    for (const e of since) { sim = sim ? extendState(sim,[e]) : reduceFrom(before,[e],latest.lookup); if (e.kind === 'plan' && !sim.nodes[id]?.candidate) throw new OwedError(`candidate #${a.candidate.seq} ${a.candidate.commit.slice(0,12)} of ${id} was invalidated by plan #${e.seq} (its spec changed); the writer submits again, then merge`); }
  }
  throw new OwedError('Plan, candidate or trunk changed; retry');
}
async function mutate(o: Actor, make: (s: State) => Draft | Promise<Draft>, fresh?: { node: string; since?: number }): Promise<Entry> {
  owner(o); const ledger = await Ledger.open(o.cwd);
  return ledger.withLock(async () => { const { state, entries } = await load(ledger); if (fresh) decidedOn(entries,fresh.node,fresh.since); const d = await make(state); guard(state,d); return (await ledger.append([d]))[0]!; });
}
/** F1: whether ledger entry `e` names `node`: its `node` or `subject`, a ruling listing it or `*`, or any plan entry. */
const namesNode = (e: Entry, node: string): boolean => e.kind === 'plan' || (e.kind === 'rule' ? e.nodes === '*' || e.nodes.includes(node) : ('node' in e && e.node === node) || ('subject' in e && e.subject === node));
/**
 * F1 (0.11, wais #35): a driver act decided on the state of seq `since` (halt, send, launch, rebase) records nothing
 * when an entry after `since` names the node and was not written by the driver (`parent:drive`): it throws OwedError
 * code `stale` and the next pass decides again. Called under the ledger lock, before the append; no check without `since`.
 */
function decidedOn(entries: Entry[], node: string, since?: number): void {
  if (since === undefined) return;
  const e = entries.find(x => x.seq > since && x.by !== DRIVER && namesNode(x,node));
  if (e) throw new OwedError(`stale: #${e.seq} ${e.kind} by ${e.by} on ${node} was recorded after the state #${since} the driver decided on; nothing recorded`,'stale');
}
/**
 * G3.3 (0.12): for a driver act that appends no entry (the re-send of a recorded send) decided on the state of seq
 * `since`: throws OwedError code `stale` when a plan entry after `since` removed node `node` from the plan or changed
 * its spec (plan entries name no node). Nothing is recorded either way.
 */
export async function planChangedSince(o: Context & { node: string; since: number }): Promise<void> {
  const { entries, lookup } = await load(await Ledger.open(o.cwd));
  const specOf = (sha: string): string | undefined => { const n = lookup(sha).nodes.find(x => x.id === o.node); return n ? canonical(n) : undefined; };
  const at = entries.findLast(e => e.seq <= o.since && (e.kind === 'genesis' || e.kind === 'plan'));
  let spec = at && (at.kind === 'genesis' || at.kind === 'plan') ? specOf(at.plan) : undefined;
  for (const e of entries) {
    if (e.seq <= o.since || e.kind !== 'plan') continue;
    const next = specOf(e.plan);
    if (next !== spec) throw new OwedError(`stale: plan #${e.seq} by ${e.by} ${next === undefined ? 'removed' : 'changed'} ${o.node} after the state #${o.since} the driver decided on; nothing sent`,'stale');
    spec = next;
  }
}
/**
 * G1: the candidate a caller names (`--candidate`, pi `candidate`): 40 hex or a prefix of at least 7 hex (usage error
 * otherwise), lowercased; undefined when not given.
 */
export function candidateArg(v: string | undefined): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !/^[0-9a-fA-F]{7,40}$/.test(v)) throw new OwedError(`candidate must be a commit (40 hex) or a prefix of at least 7 hex: ${String(v)}`,'usage');
  return v.toLowerCase();
}
/** G1: refuses (under the lock, at append time) unless node `id` has an open candidate whose commit starts with `given`. */
function named(s: State, id: string, given?: string): void {
  if (given === undefined) return;
  const n = s.nodes[id], c = n?.slot?.open ? n.candidate : undefined;
  if (!c) throw new OwedError(`candidate changed: you named ${given}, node ${id} has no open candidate; nothing recorded`);
  if (!c.commit.startsWith(given)) throw new OwedError(`candidate changed: you named ${given}, the open candidate is #${c.seq} ${c.commit.slice(0,12)}; nothing recorded`);
}
/**
 * G2.1 (F3): in a pi-durable-subagents call, refuses a review or evidence on node `id` when one of `dirs` (the
 * process's working directories) lies inside the node's open slot worktree. An accident rail like D25.3, not security.
 */
async function writerTree(s: State, id: string, dirs: string[], env: NodeJS.ProcessEnv = process.env): Promise<void> {
  const slot = s.nodes[id]?.slot;
  if (!subagentCall(env) || !slot?.open) return;
  const tree = await physical(resolve(slot.worktree)), inside = (d: string) => d === tree || d.startsWith(tree.endsWith(sep) ? tree : tree + sep);
  for (const d of dirs) if (inside(await physical(resolve(d)))) throw new OwedError('a writer worktree cannot record a review or evidence for its own node; run the review from the repository root or another directory');
}
/**
 * The plan blob bytes and sha stored for a plan text (canonical YAML); refuses a `worktrees:` block a new plan must
 * not have (G4) and node ids equal ignoring case.
 */
function planBlob(text: string) {
  const plan = parsePlan(text), hygiene = [...(plan.worktrees ? worktreesErrors(plan.worktrees) : []), ...nodeIdCaseErrors(plan), ...execEnvErrors(plan)];
  if (hygiene.length) throw new OwedError(hygiene.join('\n'),'usage');
  const data = stringify(JSON.parse(canonical(plan)), { sortMapEntries: true }); return { plan, data, sha: sha256(data) };
}
async function storePlan(ledger: Ledger, text: string) { const b = planBlob(text); return { plan: b.plan, sha: await ledger.putBlob(b.data) }; }
/** The rejection of an operation whose `signal` aborted (D16): the CLI maps it to the signal's exit code. */
const aborted = (): OwedError => new OwedError('aborted', 'aborted');
function checkAbort(signal?: AbortSignal): void { if (signal?.aborted) throw aborted(); }
/**
 * Runs the jobs in order, appending each observation under the lock. Observations are facts about keys (D24.1): one
 * whose item is no longer current (jobCurrent on the latest state) is dropped as superseded and the run goes on; a
 * moved ledger alone refuses nothing. On abort (D16) the running check's process group is killed (src/exec.ts), its
 * observation is not recorded, no further job starts, and this rejects with OwedError('aborted'); observations
 * appended before stay. `done` (if given) receives each recorded or superseded result as it happens.
 * `parallel` > 1 (M1, genesis attest only; node attests stay serial): up to that many jobs at once, recorded in job
 * order; on abort the observations of jobs that completed are still recorded.
 */
async function runJobs(cwd: string, ledger: Ledger, snapshot: State, jobs: AttestJob[], signal?: AbortSignal, done?: { recorded: Entry[]; superseded: JobRef[] }, parallel = 1): Promise<{ recorded: Entry[]; superseded: JobRef[] }> {
  const out = done ?? { recorded: [], superseded: [] }, result = out.recorded;
  // Records one observation under the lock when its item is still current (D24.1).
  const record = async (job: AttestJob, obs: Draft, lockSignal?: AbortSignal) => ledger.withLock(async () => {
    const { state } = await load(ledger);
    const freshTrunk = job.subject !== 'trunk' || !trunkJobs(snapshot).some(j => sameJob(j,job)) || (job.commit === state.trunk.commit && (await git.stateFacts(cwd,state.plan,state.trunk.commit,stateQuarantine(state))).invKeys[job.obligation.slice(4)] === job.key);
    if (!jobCurrent(state,job) || !freshTrunk) { out.superseded.push({ subject:job.subject, obligation:job.obligation, key:job.key }); return; }
    const drafts = job.kind === 'writes' && !job.attribution && obs.kind === 'obs' && obs.verdict !== 'error' ? await writesGrantDrafts(cwd, ledger, state, job, obs) : [obs];
    for (const d of drafts) guard(state,d);
    result.push(...await ledger.append(drafts));
  },undefined,lockSignal);
  if (parallel > 1) {
    // M1 (exec.parallel): up to `parallel` jobs at once; observations are recorded in job order. On abort every running
    // job is killed and none starts; the completed ones are recorded (without the signal, as abortWith), then rejects.
    checkAbort(signal);
    const ready = jobs.map(() => { let settle!: (v: Draft | undefined) => void; const p = new Promise<Draft | undefined>(r => { settle = r; }); return { p, settle }; });
    let failure: { error: unknown } | undefined, stopped = false;
    const measuring = measureAll(jobs,parallel,signal,async job => runJob({ cwd, ledger, plan:await jobPlan(ledger,snapshot,job), signal },job),(i,obs) => ready[i]!.settle(obs),() => stopped).catch(error => { failure = { error }; for (const r of ready) r.settle(undefined); });
    // A failed record starts no further job and still waits for the running ones, so none outlives the run (and its lock).
    try {
      for (let i = 0; i < jobs.length; i++) {
        const obs = await ready[i]!.p;
        if (obs) await record(jobs[i]!,obs,signal?.aborted ? undefined : signal);
      }
    } catch (e) { stopped = true; throw e; }
    finally { await measuring; }
    if (failure) throw failure.error;
    checkAbort(signal);
    return out;
  }
  for (const job of jobs) {
    checkAbort(signal);
    // Attribution must use the original setup, exec, closure and writes as well as the original check spec (jobPlan).
    const obs = await runJob({ cwd, ledger, plan:await jobPlan(ledger,snapshot,job), grantedWrites:job.attribution ? [] : grantsOf(snapshot,job.subject).flatMap(g => g.paths), signal }, job);
    checkAbort(signal);
    await record(job,obs,signal);
  }
  return out;
}
/** GR4: grant + observation are one locked append; fresh replay validates all paths, never a partial grant. */
async function writesGrantDrafts(cwd: string, ledger: Ledger, s: State, job: AttestJob, obs: import('./types.ts').ObsEntry | Extract<Draft, { kind:'obs' }>): Promise<Draft[]> {
  const n = s.nodes[job.subject]!;
  const paths = (await git.git(cwd,['diff','--no-renames','--name-only','-z',job.base,job.commit])).stdout.split('\0').filter(Boolean);
  const bad = paths.filter(p => !withinWrites(s,job.subject,p)).sort(), drafts: Draft[] = [];
  let reason: string | undefined;
  if (bad.length) {
    const grant: Extract<Draft,{kind:'grant'}> = {kind:'grant',by:'executor:owed',node:job.subject,attempt:n.slot!.attempt,commit:job.commit,paths:bad,allowance:allowanceSeq(s) ?? -1};
    reason = grantErrors(s,grant)[0];
    if (!reason) drafts.push(grant);
  }
  const grants = grantsOf(s,job.subject).filter(g => g.paths.some(p => paths.includes(p)));
  const labels = [...grants.map(g => `granted #${g.seq}: ${g.paths.join(', ')}`), ...(drafts.length ? [`granted #${s.seq + 1}: ${bad.join(', ')}`] : [])];
  const note = reason ? `outside writes: ${bad.join(', ')}; ${reason}` : `all changed paths within writes${labels.length ? ` (${labels.join('; ')})` : ''}`;
  drafts.push({...obs,verdict:reason ? 'fail' : 'pass',exit:reason ? 1 : 0,note,log:await ledger.putBlob(note)});
  return drafts;
}
/**
 * The plan a job runs under: the snapshot's, or for an attribution rerun the plan its block was recorded under (the
 * original setup, exec, closure and writes as well as the original check spec).
 */
async function jobPlan(ledger: Ledger, snapshot: State, job: AttestJob): Promise<Plan> {
  if (!job.attribution) return snapshot.plan;
  const h = await load(ledger);
  const block = h.entries.find(e => e.kind === 'obs' && e.probe === undefined && e.subject === job.subject && e.obligation === job.obligation && e.key === job.key && e.verdict === 'fail' && !e.attribution);
  const law = h.entries.filter(e => e.seq <= (block?.seq ?? -1) && (e.kind === 'plan' || e.kind === 'genesis')).at(-1);
  return law && (law.kind === 'plan' || law.kind === 'genesis') ? h.lookup(law.plan) : snapshot.plan;
}
/** M1: `exec.parallel` of a plan (default 1). */
export const parallelOf = (plan: Plan): number => plan.exec?.parallel ?? 1;
/**
 * M1: measures `jobs` with at most `width` at once, in job order of start. `settled(i, obs)` (if given) receives each
 * job's observation as it completes, or undefined when it was not measured (abort). On abort (D16) running jobs are
 * killed by the signal (src/exec.ts), no further job starts, and the observation of a job that returns after the abort
 * is dropped. Returns the observations by job index (undefined = not measured) and whether the signal aborted. An
 * exception, or `stop()` returning true, stops further starts; an exception rejects once the running jobs return.
 */
export async function measureAll<T>(jobs: T[], width: number, signal: AbortSignal | undefined, run: (job: T, i: number) => Promise<Draft>, settled?: (i: number, obs: Draft | undefined) => void, stop?: () => boolean): Promise<{ observations: (Draft | undefined)[]; aborted: boolean }> {
  const observations: (Draft | undefined)[] = jobs.map(() => undefined);
  let next = 0, failed: { error: unknown } | undefined;
  const worker = async (): Promise<void> => {
    while (next < jobs.length && !signal?.aborted && !failed && !stop?.()) {
      const i = next++;
      try { const obs = await run(jobs[i]!,i); if (!signal?.aborted) observations[i] = obs; }
      catch (error) { failed ??= { error }; }
      settled?.(i,observations[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1,Math.min(width,jobs.length)) },worker));
  for (let i = next; i < jobs.length; i++) settled?.(i,undefined);
  if (failed) throw failed.error;
  return { observations, aborted: !!signal?.aborted };
}
/**
 * Records the observations a merge or adopt measured before an abort (valid evidence) when the ledger did not move
 * (the same check as the refusal path), else nothing; then rejects with OwedError('aborted'). Must not run under 'lock'.
 * Its withLock takes no signal: the signal has already aborted, and passing it would drop these observations (D16a).
 */
async function abortWith(ledger: Ledger, snapshot: State, observations: Draft[], id?: string): Promise<never> {
  if (observations.length) {
    try { await ledger.withLock(async () => { const latest = await load(ledger); stable(snapshot,latest.state,id); prospective(latest,observations); await ledger.append(observations); }); }
    catch (e) { if (!(e instanceof OwedError)) throw e; /* the ledger moved: nothing recorded */ }
  }
  throw aborted();
}
/** What `init` would record (no effect), for the owner dialog of owed_init (D24.4); refuses an initialized ledger. */
export async function initPreview(o: Context & { plan: string }): Promise<InitPreview> {
  const b = planBlob(o.plan), { state } = await load(await Ledger.open(o.cwd));
  if (state.seq >= 0) throw new OwedError(`Already initialized (genesis #0, trunk ${state.trunk.name}); owed init records genesis only once`);
  lintPlanShell(b.plan,undefined,o.plan);
  return { trunk:b.plan.trunk, commit:await git.revParse(o.cwd,`refs/heads/${b.plan.trunk}`), planSha:b.sha, nodes:b.plan.nodes.length, invariants:b.plan.invariants.map(i => i.id) };
}
/**
 * Records genesis, then (unless `measure: false`) measures the genesis items (D24). Once genesis is recorded the call
 * succeeds even when that measurement does not observe every item (an error verdict, an exception): `genesis` says what was recorded and
 * what is missing. An abort after genesis rejects with OwedError('aborted') whose message is the genesis-incomplete
 * text (an abort before genesis keeps the message 'aborted'). `commit` pins the trunk commit the owner confirmed.
 */
export async function init(o: Actor & { plan: string; channel: Channel; signal?: AbortSignal; lease?: boolean; measure?: boolean; commit?: string }): Promise<InitResult> {
  owner(o); checkAbort(o.signal); const warnings = lintPlanShell(planBlob(o.plan).plan,undefined,o.plan);
  const ledger = await Ledger.open(o.cwd), p = await storePlan(ledger,o.plan);
  const commit = await git.revParse(o.cwd,`refs/heads/${p.plan.trunk}`), facts = await git.stateFacts(o.cwd,p.plan,commit,quarantineNames(p.plan,() => false));
  if (o.commit !== undefined && o.commit !== commit) throw new OwedError(`refs/heads/${p.plan.trunk} moved after the confirmation (was ${o.commit.slice(0,12)}, now ${commit.slice(0,12)}); nothing was recorded`);
  const entry = await ledger.withLock(async () => { const { state } = await load(ledger,[p.sha]); const d: Draft = { kind:'genesis', by:by(o), channel:o.channel, trunk:p.plan.trunk, commit, plan:p.sha, state:facts }; guard(state,d); return (await ledger.append([d]))[0]!; },undefined,o.signal);
  const done = { recorded: [] as Entry[], superseded: [] as JobRef[] };
  let error: string | undefined, lease: string | undefined;
  if (o.measure !== false) {
    try { lease = (await leased(o, async signal => { const { state } = await load(ledger); return runJobs(o.cwd,ledger,state,genesisJobs(state),signal,done,parallelOf(state.plan)); })).lease; }
    catch (e) {
      if (e instanceof OwedError && e.code === 'aborted') { const g = await genesisOutcome(ledger,done.superseded); throw new OwedError(genesisIncompleteText(entry.seq,g),'aborted'); }
      error = e instanceof Error ? e.message : String(e);
    }
  }
  const genesis = { ...await genesisOutcome(ledger,done.superseded), ...(error !== undefined ? { error } : {}) };
  return { entry, observations:done.recorded, status:await status(o), genesis, ...(lease ? { lease } : {}), ...(warnings.length ? { warnings } : {}) };
}
async function genesisOutcome(ledger: Ledger, superseded: JobRef[]): Promise<GenesisAttest> {
  const g = genesisProgress((await load(ledger)).state);
  return { complete:!g.pending.length, recorded:g.observed, failed:g.failed, missing:g.pending, superseded };
}
/** Lines after a receipt for items measured but not recorded because they were no longer current (D24.1); empty if none. */
export function supersededText(items: JobRef[]): string { return items.length ? `\nSuperseded (not recorded; the item changed while it was measured): ${items.map(i => `${i.subject}/${i.obligation}`).join(', ')}` : ''; }
/** `Initialized (genesis #n). Genesis attest incomplete: …` (D24.3); never says retry: genesis is recorded. */
export function genesisIncompleteText(seq: number, g: Pick<GenesisAttest, 'recorded' | 'missing'>): string {
  return `Initialized (genesis #${seq}). Genesis attest incomplete: recorded ${g.recorded.join(', ') || 'none'}; missing ${g.missing.join(', ') || 'none'}: run owed attest --genesis, or the next attest/merge measures them first.`;
}
/**
 * Genesis attests running in this process (D24.5: status says "measuring in this session"), each with the promise of
 * its ledger dir. A run registers synchronously when attestGenesis is called, before its first await.
 */
const genesisRuns = new Set<{ dir: Promise<string | undefined> }>();
async function measuringHere(dir: string): Promise<boolean> {
  for (const run of genesisRuns) if (await run.dir === dir) return true;
  return false;
}
/**
 * Measures the genesis items still lacking an observation (D24.2), under its own `genesis` lock (two genesis attests
 * do not overlap; node attests are never blocked by it: recording is safe concurrently, D24.1); records each
 * observation whose item is still current. Abortable like attest (§7.8).
 */
export async function attestGenesis(o: MeasurementContext): Promise<AttestGenesisResult> {
  checkAbort(o.signal);
  const opened = Ledger.open(o.cwd), run = { dir: opened.then(l => l.dir, () => undefined) };
  genesisRuns.add(run);
  try {
    const ledger = await opened;
    inited((await load(ledger)).state);
    return await leased(o, signal => ledger.withLock(async () => {
      const { state } = await load(ledger), r = await runJobs(o.cwd,ledger,state,genesisJobs(state),signal,undefined,parallelOf(state.plan));
      return { ...await genesisOutcome(ledger,r.superseded), observations:r.recorded };
    },'genesis',signal,{ busy:owner => `attest --genesis is already running (${heldBy(owner)}); its observations will appear in owed status` }));
  } finally { genesisRuns.delete(run); }
}
/** IR1: a shared-machine lease, then trunk-refresh lock, then short ledger locks (never commands under ledger lock). */
export async function attestTrunk(o: Context & { signal?: AbortSignal; lease?: boolean; remeasure?: boolean; all?: boolean }): Promise<AttestTrunkResult> {
  checkAbort(o.signal);
  if (!measurementScope()) return leased(o, signal => attestTrunk({ ...o, signal }));
  const ledger = await Ledger.open(o.cwd);
  return ledger.withLock(async () => {
    const prepared = await ledger.withLock(async () => {
      const { state } = await load(ledger); inited(state);
      const facts = await git.stateFacts(o.cwd,state.plan,state.trunk.commit,stateQuarantine(state)), changed = refreshChanged(state,facts);
      if (!changed.length) return { changed };
      const d: Draft = { kind:'refresh', by:'executor:owed', commit:state.trunk.commit, state:facts };
      guard(state,d); return { changed, refresh:(await ledger.append([d]))[0]! };
    },undefined,o.signal);
    const { state } = await load(ledger), jobs = trunkJobs(state);
    const r = await runJobs(o.cwd,ledger,state,jobs,o.signal,undefined,parallelOf(state.plan));
    const again = o.remeasure ? await trunkRemeasure(o.cwd,ledger,r.recorded,o.all,o.signal) : undefined;
    const latest = (await load(ledger)).state;
    return { ...prepared, ...again, observations:r.recorded, superseded:r.superseded, missing:trunkJobs(latest).map(j => j.obligation.slice(4)), failed:trunkInvariantReds(latest).map(i => i.obligation.slice(4)) };
  },'trunk-refresh',o.signal,{ busy:who => `attest --trunk is already running (${heldBy(who)}); its observations will appear in owed status` });
}
/** MS1: `attest --trunk --remeasure`: current trunk keys whose latest observation failed (`all`: every one), except those this call just measured. */
async function trunkRemeasure(cwd: string, ledger: Ledger, measured: Entry[], all: boolean | undefined, signal?: AbortSignal): Promise<{ remeasured: string[]; remeasuredObs: Entry[] }> {
  const { state } = await load(ledger), jobs = trunkRemeasureJobs(state,all).filter(j => !measured.some(e => e.kind === 'obs' && e.obligation === j.obligation && e.key === j.key));
  const r = await runJobs(cwd,ledger,state,jobs,signal,undefined,parallelOf(state.plan));
  return { remeasured:jobs.map(j => j.obligation), remeasuredObs:r.recorded };
}
/** Read-only driver preflight: current-plan trunk keys or interrupted refresh measurements need work. */
export async function trunkRefreshPending(o: Context): Promise<boolean> {
  const { state } = await load(await Ledger.open(o.cwd)); inited(state);
  return !!trunkJobs(state).length || !!refreshChanged(state,await git.stateFacts(o.cwd,state.plan,state.trunk.commit,stateQuarantine(state))).length;
}
/** Genesis invariant ids that still lack an observation (empty when not initialized). */
export async function genesisPending(o: Context): Promise<string[]> { return (await genesisReport(o)).missing; }
/** Genesis invariant ids observed (`failed` among them) and missing, from the ledger as it is. */
export async function genesisReport(o: Context): Promise<{ recorded: string[]; failed: string[]; missing: string[] }> { const g = genesisProgress((await load(await Ledger.open(o.cwd))).state); return { recorded:g.observed, failed:g.failed, missing:g.pending }; }
/** Reads a plan file for `owed plan`: from commit `rev` when given (path relative to cwd), else from the working tree. */
export async function readPlan(o: Context & { path: string; rev?: string }): Promise<{ plan: string; rev?: string; path: string }> {
  if (o.rev !== undefined) { const r = await git.readAt(o.cwd,o.rev,o.path); return { plan:r.text, rev:r.commit, path:r.path }; }
  const file = resolve(o.cwd,o.path); let text: string;
  try { text = await readFile(file,'utf8'); } catch (e) { throw new OwedError(`cannot read ${o.path}: ${(e as NodeJS.ErrnoException).code ?? String(e)}`,'usage'); }
  let path = file;
  try { const top = await realpath(await git.repoRoot(o.cwd)), rel = relative(top,await realpath(file)); if (rel && !rel.startsWith('..') && !isAbsolute(rel)) path = rel.split(sep).join('/'); } catch { /* outside a repository: keep the absolute path */ }
  return { plan:text, path };
}
/** N1 (23:4x): a carry `owed plan` skipped (facts not computable or validation refused it); the candidate stays invalidated. */
export interface NotCarried { node: string; reason: string }
/** `notCarried` (N1, optional): receives one item per open candidate the plan entry invalidated and could not carry. */
export async function planSet(o: Actor & { plan: string; rev?: string; path?: string; note?: string; notCarried?: NotCarried[]; shellWarnings?: string[] }): Promise<Entry> {
  owner(o); const ledger = await Ledger.open(o.cwd), p = await storePlan(ledger,o.plan);
  // N2: each attempt recomputes carries from its own fresh locked read; only the successful attempt reports skips.
  return retryCas(ledger, before => {
    const warnings = lintPlanShell(p.plan,before.plan,o.plan);
    return ledger.withLock(async () => { const skipped: NotCarried[] = [], entry = (await ledger.append((await planDrafts({ ...o, notCarried:skipped },ledger,p,before)).drafts))[0]!; o.notCarried?.push(...skipped); o.shellWarnings?.push(...warnings); return entry; });
  });
}
type PlanArgs = Actor & { rev?: string; path?: string; note?: string; notCarried?: NotCarried[] };
/**
 * Under the ledger lock: the plan entry draft for stored plan `p` (refused unless the plan and trunk are still those of
 * `before` and the guard accepts it), followed by its N1 carry submits. Shared by planSet and amend (N3), so both apply
 * the same authority rules.
 */
async function planDrafts(o: PlanArgs, ledger: Ledger, p: { plan: Plan; sha: string }, before: State): Promise<{ latest: Awaited<ReturnType<typeof load>>; drafts: Draft[] }> {
  const latest = await load(ledger,[p.sha]), { state } = latest; stable(before,state); const d: Draft = { kind:'plan', by:by(o), channel:o.channel, prior:before.planSha, plan:p.sha, downgrades:planDowngrades(state.plan,p.plan), ...(o.rev !== undefined ? { rev:o.rev } : {}), ...(o.path !== undefined ? { path:o.path } : {}), ...(o.note !== undefined && o.note.trim() ? { note:o.note } : {}) }; guard(state,d);
  return { latest, drafts: await withCarries(o.cwd,latest,d,p.plan,o.notCarried) };
}
/**
 * N1: the plan draft `d` followed by one carry submit (by executor:owed) per open candidate it invalidates whose node
 * spec changed only in checks, writes, type or drive: the same commit at the same slot base, facts recomputed under
 * `next` (manual keys as for a normal submit). A carry whose facts cannot be computed or that validation refuses is
 * left out (reported in `skipped`): that candidate stays invalidated, as in 0.9.
 */
async function withCarries(cwd: string, latest: Awaited<ReturnType<typeof load>>, d: Draft, next: Plan, skipped: NotCarried[] = []): Promise<Draft[]> {
  const s = latest.state, drafts: Draft[] = [d], replay = [...latest.entries];
  // G1.3: each draft is folded onto a private copy of the loaded state (not a replay of the whole ledger).
  let sim: State | undefined;
  const push = (x: Draft): State => { const e = { ...x, seq:replay.length ? replay.at(-1)!.seq+1 : 0, ts:new Date().toISOString(), prev:replay.at(-1)?.hash ?? '' } as Entry; e.hash = entryHash(e); replay.push(e); return sim = sim ? extendState(sim,[e]) : reduceFrom(s,[e],latest.lookup); };
  let current = push(d);
  for (const n of Object.values(s.nodes)) {
    const c = n.candidate, slot = n.slot, spec = next.nodes.find(x => x.id === n.id);
    if (!c || !slot?.open || !spec || !invalidates(s.plan,next,n.id) || !carryable(s.plan,next,n.id)) continue;
    let carry: Draft;
    try {
      const facts = await git.candidateFacts(cwd,next,spec,slot.base,c.commit,slot.attempt,quarantineNames(next,id => !!s.nodes[id]?.merged));
      Object.assign(facts.keys,manualKeys(spec,facts.patch));
      carry = { kind:'submit', by:'executor:owed', node:n.id, attempt:slot.attempt, facts, carry:c.seq };
    } catch (e) { skipped.push({ node:n.id, reason:`facts of ${c.commit.slice(0,12)} cannot be computed: ${(e instanceof Error ? e.message : String(e)).trim().split('\n')[0]}` }); continue; }
    const refused = validateDraft(current,carry);
    if (refused.length) { skipped.push({ node:n.id, reason:refused.join('; ') }); continue; }
    drafts.push(carry); current = push(carry);
  }
  return drafts;
}
/** N1: the carry submits recorded right after plan entry `plan` (one per carried node), in ledger order. */
export async function carriedBy(o: Context & { plan: number }): Promise<SubmitEntry[]> {
  const out: SubmitEntry[] = [];
  for (const e of (await (await Ledger.open(o.cwd)).read()).filter(e => e.seq > o.plan)) { if (e.kind !== 'submit' || e.carry === undefined) break; out.push(e); }
  return out;
}
// ---------- N3: owed amend, widen one node's writes (wais #26) ----------
/** N3: what `owed amend` would write: the plan file edited with the node's new writes (nothing recorded yet). */
export interface AmendEdit {
  node: string;
  /** the plan file (real path) and its path as `owed plan` records it */
  file: string; path: string;
  /** the file text read (equal to the ledger's current plan) and the edited text */
  text: string; next: string;
  prior: Plan; plan: Plan;
  /** paths appended to the node's writes, and given paths that were already there (skipped) */
  added: string[]; present: string[];
  /** the ledger plan sha the edit starts from */
  planSha: string;
}
export interface AmendResult { node: string; file: string; path: string; added: string[]; present: string[]; plan: Entry; rule: Entry; carried: SubmitEntry[]; notCarried: NotCarried[] }
type AmendArgs = Context & { node: string; writes: string[]; note: string; plan?: string };
/** N3.4: the paths of `+<path>` arguments, duplicates dropped; refuses an empty list, a path without `+` and an empty path. */
export function amendPaths(writes: string[]): string[] {
  if (!Array.isArray(writes) || !writes.length) throw new OwedError('amend needs at least one path to add: --writes +<path>[,+<path>...]','usage');
  const out: string[] = [];
  for (const w of writes) {
    const t = typeof w === 'string' ? w.trim() : '';
    if (!t.startsWith('+')) throw new OwedError(`amend only widens writes: each path must start with + (got ${JSON.stringify(w)}); removing writes needs owed plan`,'usage');
    const p = t.slice(1).trim();
    if (!p) throw new OwedError('amend: empty path after +','usage');
    if (!out.includes(p)) out.push(p);
  }
  return out;
}
/** N3.2: the plan file amend edits: `plan` (relative to cwd), else the path of the latest plan entry. */
async function amendSource(cwd: string, entries: Entry[], plan?: string): Promise<string> {
  if (plan !== undefined) return resolve(cwd,plan);
  const last = entries.findLast(e => e.kind === 'plan');
  if (last?.kind !== 'plan' || !last.path) throw new OwedError(`${last ? `the latest plan entry #${last.seq} records no plan file path` : 'no plan entry records a plan file path'}; give the plan file (owed amend --plan <file>; owed_amend plan)`,'usage');
  return isAbsolute(last.path) ? last.path : join(await realpath(await git.repoRoot(cwd)),last.path);
}
/**
 * N3.2: the edit amend makes, against ledger state `s`: the plan file must equal the ledger's current plan; its node
 * `node` gets the new paths appended to `writes` through the yaml Document API (comments, order and flow style kept).
 * The edited text is checked to parse to the current plan with only that node's writes widened.
 */
async function amendEdit(o: AmendArgs, entries: Entry[], s: State): Promise<AmendEdit> {
  const paths = amendPaths(o.writes);
  if (typeof o.note !== 'string' || !o.note.trim()) throw new OwedError('amend needs a non-empty note stating the limit of the widening (--note TEXT)','usage');
  inited(s);
  const spec = s.plan.nodes.find(n => n.id === o.node);
  if (!spec) throw new OwedError(`Node ${o.node} does not exist`);
  if (s.nodes[o.node]?.merged) throw new OwedError(`Node ${o.node} is merged; amend widens the writes of a node that is not merged`);
  const source = await amendSource(o.cwd,entries,o.plan), read = await readPlan({ cwd:o.cwd, path:source });
  if (planBlob(read.plan).sha !== s.planSha) throw new OwedError(`plan file has unrecorded edits: ${read.path} differs from the ledger's current plan; record it with owed plan first, or restore it`);
  const doc = parseDocument(read.plan);
  const nodes = doc.get('nodes'), item = isSeq(nodes) ? nodes.items.find(x => isMap(x) && x.get('id') === o.node) : undefined;
  if (!isMap(item)) throw new OwedError(`cannot edit ${read.path}: node ${o.node} is not a map in its nodes list`);
  const added = paths.filter(p => !spec.writes.includes(p)), present = paths.filter(p => spec.writes.includes(p));
  if (!added.length) throw new OwedError(`writes of ${o.node} already include ${present.join(', ')}; nothing to amend`);
  if (writesAllowed(s.plan,o.node,added)) throw new OwedError(`not needed: ${added.join(', ')} are covered by allow rule (plan #${entries.findLast(e => e.kind === 'plan' || e.kind === 'genesis')!.seq}); owed grants them at measurement; tell the writer to edit them`);
  const next = spliceWrites(read.plan,doc,item,added);
  if (next === undefined) throw new OwedError(`cannot edit ${read.path}: writes of node ${o.node} is not a list`);
  const plan = planBlob(next).plan, expect: Plan = { ...s.plan, nodes:s.plan.nodes.map(n => n.id === o.node ? { ...n, writes:[...n.writes,...added] } : n) };
  if (canonical(plan) !== canonical(expect)) throw new OwedError(`cannot edit ${read.path}: the edited file would change more than the writes of ${o.node}`,'internal');
  return { node:o.node, file:await realpath(resolve(o.cwd,source)), path:read.path, text:read.plan, next, prior:s.plan, plan, added, present, planSha:s.planSha };
}
/** A path as a YAML scalar: plain when that is unambiguous (also inside a flow list), else double-quoted (JSON). */
const yamlPath = (p: string): string => /^[A-Za-z0-9_./][A-Za-z0-9_./*-]*$/.test(p) ? p : JSON.stringify(p);
/**
 * N3.2: the plan text with `added` appended to the writes list of node map `item` of `doc` (parsed from `text`). The
 * list is located through the yaml Document API and only its own source range is edited, so every other byte
 * (comments, order, flow or block style, spacing) is kept: a flow list gets `, path` before its `]`, a block list one
 * `- path` line per path after its last item, at the same indentation. A node without writes gets them through the
 * Document API (the file is then re-emitted). Undefined when writes is not a list.
 */
function spliceWrites(text: string, doc: ReturnType<typeof parseDocument>, item: YAMLMap, added: string[]): string | undefined {
  const writes = item.get('writes',true);
  if (writes === undefined || (isSeq(writes) && !writes.flow && !writes.items.length)) { item.set('writes',doc.createNode(added)); return doc.toString({ lineWidth:0 }); }
  if (!isSeq(writes) || !writes.range) return undefined;
  const last = writes.items.at(-1) as { range?: [number, number, number] } | undefined;
  const quoted = (p: string): string => isScalar(last) && (last.type === 'QUOTE_DOUBLE' || last.type === 'QUOTE_SINGLE') ? JSON.stringify(p) : yamlPath(p);
  if (writes.flow) {
    let close = writes.range[1]-1; if (text[close] !== ']') close = text.lastIndexOf(']',close);
    if (close < writes.range[0]) return undefined;
    if (!writes.items.length) return `${text.slice(0,writes.range[0])}[${added.map(quoted).join(', ')}]${text.slice(close+1)}`;
    const before = text.slice(0,close), ws = /\s*$/.exec(before)![0], core = before.slice(0,before.length-ws.length), sep = core.endsWith(',') ? ' ' : ', ';
    return `${core}${sep}${added.map(quoted).join(', ')}${ws}${text.slice(close)}`;
  }
  if (!last?.range) return undefined;
  const dash = text.lastIndexOf('-',last.range[0]), lineStart = text.lastIndexOf('\n',dash)+1, eol = text.indexOf('\n',last.range[1]), end = eol < 0 ? text.length : eol;
  if (dash < lineStart || text.slice(lineStart,dash).trim()) return undefined;
  const indent = text.slice(lineStart,dash);
  return `${text.slice(0,end)}${added.map(p => `\n${indent}- ${quoted(p)}`).join('')}${text.slice(end)}`;
}
/** N3: the edit `owed amend` would make (refusals as for amend, except authority); nothing is recorded or written. */
export async function amendPreview(o: AmendArgs): Promise<AmendEdit> { const { entries, state } = await load(await Ledger.open(o.cwd)); return amendEdit(o,entries,state); }
/**
 * N3: widens the writes of node `node`. In one ledger lock it appends the plan entry of the edited plan file (the same
 * drafting and guard as owed plan, so a downgrade needs the owner or an allow rule, and a delegated owner its note),
 * any N1 carry submits, and a rule naming the node, by the same principal. The edited text goes to a temporary file
 * next to the plan file before the append and replaces the file after it; a refusal records nothing and leaves the
 * file unchanged.
 */
export async function amend(o: Actor & AmendArgs): Promise<AmendResult> {
  owner(o); const ledger = await Ledger.open(o.cwd);
  // N2 (00:3x): retried like owed plan; each attempt re-reads the ledger and the file (amendEdit), and a failed attempt
  // removes its temporary file before the refusal leaves the lock.
  return retryCas(ledger, async before => {
  const { entries } = await load(ledger), e = await amendEdit(o,entries,before), p = await storePlan(ledger,e.next);
  const limit = o.note.trim(), widened = e.added.map(x => `+${x}`).join(', '), notCarried: NotCarried[] = [];
  return ledger.withLock(async () => {
    const { latest, drafts } = await planDrafts({ ...o, path:e.path, note:`amend ${o.node}: writes ${widened}. Limit: ${limit}`, notCarried },ledger,p,before);
    if (latest.state.nodes[o.node]?.merged) throw new OwedError(`Node ${o.node} is merged; amend widens the writes of a node that is not merged`);
    let now: string; try { now = await readFile(e.file,'utf8'); } catch (x) { throw new OwedError(`cannot read ${e.path}: ${(x as NodeJS.ErrnoException).code ?? String(x)}; nothing recorded`); }
    if (now !== e.text) throw new OwedError(`plan file has unrecorded edits: ${e.path} changed while amending; nothing recorded`);
    const seq = (latest.entries.at(-1)?.seq ?? -1) + 1;
    const rule: Draft = { kind:'rule', by:by(o), channel:o.channel, text:`writes of ${o.node} widened by plan #${seq}: ${widened}. Limit: ${limit}`, nodes:[o.node] };
    guard(replayed(latest,drafts),rule);
    const temp = join(dirname(e.file),`.${basename(e.file)}.owed-amend-${process.pid}-${randomUUID().slice(0,8)}.tmp`);
    try { await writeFile(temp,e.next); await chmod(temp,(await stat(e.file)).mode & 0o7777); }
    catch (x) { await unlink(temp).catch(() => undefined); throw new OwedError(`cannot write ${e.path}: ${(x as NodeJS.ErrnoException).code ?? String(x)}; nothing recorded`); }
    let appended: Entry[];
    try { appended = await ledger.append([...drafts,rule]); } catch (x) { await unlink(temp).catch(() => undefined); throw x; }
    const plan = appended[0]!, ruled = appended.at(-1)!;
    try { await rename(temp,e.file); }
    catch (x) { throw new OwedError(`plan #${plan.seq} and rule #${ruled.seq} were recorded, but ${e.path} could not be replaced (${(x as NodeJS.ErrnoException).code ?? String(x)}): the file still holds the prior plan; the recorded plan is in ${temp}: move it over ${e.file}`,'internal'); }
    return { node:o.node, file:e.file, path:e.path, added:e.added, present:e.present, plan, rule:ruled, carried:appended.slice(1,-1).filter((x): x is SubmitEntry => x.kind === 'submit'), notCarried };
  });  });
}
// ---------- ED: atomic node/check/invariant plan edits ----------
export type EditArgs = Context & EditFields & { note: string; plan?: string; rule?: string; writer?: boolean; resume?: boolean; after?: string | string[]; expect?: 'report'; dry_run?: boolean };
export interface EditPreview { file: string; path: string; text: string; next: string; prior: Plan; plan: Plan; planSha: string; diff: string; downgrades: ReturnType<typeof planDowngrades>; warnings: string[] }
export interface EditResult { file: string; path: string; plan: Entry; rule?: Entry; resume?: Entry; carried: SubmitEntry[]; notCarried: NotCarried[]; diff: string; warnings?: string[] }
async function prepareEdit(o: EditArgs, entries: Entry[], s: State): Promise<EditPreview> {
  inited(s);
  if (typeof o.note !== 'string' || !o.note.trim()) throw new OwedError('edit needs a non-empty note (--note TEXT)','usage');
  if (o.writer && o.rule === undefined) throw new OwedError('--writer requires --rule','usage');
  if ((o.after !== undefined || o.expect !== undefined) && !o.resume) throw new OwedError('--after and --expect require --resume','usage');
  if (o.invariant !== undefined && (o.rule !== undefined || o.resume)) throw new OwedError('invariant edits do not take --rule or --resume','usage');
  if (o.rule !== undefined && !o.rule.trim()) throw new OwedError('--rule needs non-empty text','usage');
  const source = await amendSource(o.cwd,entries,o.plan), read = await readPlan({ cwd:o.cwd, path:source });
  if (planBlob(read.plan).sha !== s.planSha) throw new OwedError(`plan file has unrecorded edits: ${read.path} differs from the ledger's current plan; record it with owed plan first, or restore it`);
  const next = editText(read.plan,o), plan = planBlob(next).plan;
  return { file:await realpath(source), path:read.path, text:read.plan, next, prior:s.plan, plan, planSha:s.planSha, diff:editDiff(read.path,read.plan,next), downgrades:planDowngrades(s.plan,plan), warnings:[...parentOverlapWarnings(plan,s), ...lintPlanShell(plan,s.plan,next)] };
}
/** ED1/ED2: preview the YAML edit and downgrades, with no append or file write. */
export async function editPreview(o: EditArgs): Promise<EditPreview> { const { entries, state } = await load(await Ledger.open(o.cwd)); return prepareEdit(o,entries,state); }
/** ED2: plan + carries + optional ruling + optional resume, guarded together and appended once. */
export async function edit(o: Actor & EditArgs): Promise<EditResult | EditPreview> {
  if (o.dry_run) return editPreview(o);
  owner(o); const ledger = await Ledger.open(o.cwd);
  return retryCas(ledger,async before => {
    const { entries } = await load(ledger), e = await prepareEdit(o,entries,before), p = await storePlan(ledger,e.next), notCarried: NotCarried[] = [];
    return ledger.withLock(async () => {
      const { latest, drafts } = await planDrafts({ ...o, path:e.path, note:o.note.trim(), notCarried },ledger,p,before);
      if (await readFile(e.file,'utf8') !== e.text) throw new OwedError(`plan file has unrecorded edits: ${e.path} changed while editing; nothing recorded`);
      if (o.rule !== undefined) {
        const rule: Draft = { kind:'rule', by:by(o), channel:o.channel, nodes:[o.node!], text:o.rule, ...(o.writer !== undefined ? { writer:o.writer } : {}) };
        guard(replayed(latest,drafts),rule); drafts.push(rule);
      }
      if (o.resume) {
        const resume = resumeDraft({ ...o, node:o.node! },replayed(latest,drafts));
        guard(replayed(latest,drafts),resume); drafts.push(resume);
      }
      const temp = join(dirname(e.file),`.${basename(e.file)}.owed-edit-${process.pid}-${randomUUID().slice(0,8)}.tmp`);
      try { await writeFile(temp,e.next); await chmod(temp,(await stat(e.file)).mode & 0o7777); }
      catch (x) { await unlink(temp).catch(() => undefined); throw new OwedError(`cannot write ${e.path}: ${(x as NodeJS.ErrnoException).code ?? String(x)}; nothing recorded`); }
      let appended: Entry[];
      try { appended = await ledger.append(drafts); } catch (x) { await unlink(temp).catch(() => undefined); throw x; }
      const plan = appended[0]!;
      try { await rename(temp,e.file); }
      catch (x) { throw new OwedError(`edit entries #${plan.seq}-#${appended.at(-1)!.seq} were recorded, but ${e.path} could not be replaced (${(x as NodeJS.ErrnoException).code ?? String(x)}): the recorded plan is in ${temp}: move it over ${e.file}`,'internal'); }
      return { file:e.file, path:e.path, plan, ...(o.rule !== undefined ? { rule:appended.find(x => x.kind === 'rule')! } : {}), ...(o.resume ? { resume:appended.at(-1)! } : {}), carried:appended.filter((x): x is SubmitEntry => x.kind === 'submit'), notCarried, diff:e.diff, ...(e.warnings.length ? { warnings:e.warnings } : {}) };
    });
  });
}
/** The state after appending `drafts` to `latest` (seq, ts and hashes as the append would assign them). */
function replayed(latest: Awaited<ReturnType<typeof load>>, drafts: Draft[]): State {
  const replay = [...latest.entries], more: Entry[] = [];
  for (const x of drafts) { const e = { ...x, seq:replay.length ? replay.at(-1)!.seq+1 : 0, ts:new Date().toISOString(), prev:replay.at(-1)?.hash ?? '' } as Entry; e.hash = entryHash(e); replay.push(e); more.push(e); }
  return reduceFrom(latest.state,more,latest.lookup);
}
export { answer } from './answer.ts';

/** AN2: record once under the ledger lock; retries use the original entry and bytes. */
export async function answerRule(o: Actor & { node: string; text: string; answer: AnswerRef }): Promise<RuleEntry> {
  const ledger = await Ledger.open(o.cwd); owner(o);
  return ledger.withLock(async () => {
    const { state, entries } = await load(ledger);
    if (!['parent', 'owner'].includes(o.as.role)) throw new OwedError('answer requires parent or owner');
    const history = entries.filter((e): e is RuleEntry => e.kind === 'rule' && e.nodes !== '*' && e.nodes.includes(o.node) && e.answer?.rid === o.answer.rid && e.answer.qid === o.answer.qid);
    const prior = history.find(e => e.answer!.rev === o.answer.rev);
    if (prior) {
      if (prior.text !== o.text) throw new OwedError(`Answer rule #${prior.seq} already records different text for this rid/qid/rev (rev ${o.answer.rev}); retry with its original answer`);
      return prior;
    }
    // AR / ruling #1600: mark a re-ask answer so older readers refuse with an upgrade message.
    const supersedes = history.at(-1)?.seq;
    const draft: Draft = { kind: 'rule', by: by(o), channel: o.channel, nodes: [o.node], writer: false, text: o.text, answer: o.answer, ...(supersedes !== undefined ? { supersedes } : {}) };
    guard(state, draft); return (await ledger.append([draft]))[0] as RuleEntry;
  });
}
export async function rule(o: Actor & { text: string; nodes: string[] | '*'; writer?: boolean; prospective?: boolean; dsa?: Pick<import('./dsa.ts').Dsa, 'describe' | 'send'> }): Promise<RuleEntry & { delivery?: import('./answer.ts').RulingDelivery }> {
  if (o.prospective && o.writer) throw new OwedError('--prospective cannot be combined with --writer', 'usage');
  const entry = await mutate(o,() => ({ kind:'rule', by:by(o), channel:o.channel, text:o.text, nodes:o.nodes, ...(o.writer !== undefined ? { writer:o.writer } : {}), ...(o.prospective !== undefined ? { prospective:o.prospective } : {}) })) as RuleEntry;
  if (o.prospective) return entry;
  const { deliverRuling } = await import('./answer.ts');
  return { ...entry, delivery: await deliverRuling(o.cwd, entry, o.dsa) };
}
/** SS5: porcelain -z keeps paths literal; a rename/copy has a second NUL-delimited source path. */
async function slotSetupStatus(worktree: string, untrackedFiles: 'normal' | 'all' = 'normal'): Promise<{ tracked: string[]; untracked: string[] }> {
  const fields = (await git.git(worktree, ['status', '--porcelain', '-z', `--untracked-files=${untrackedFiles}`])).stdout.split('\0');
  const tracked: string[] = [], untracked: string[] = [];
  for (let i = 0; i < fields.length; i++) {
    const field = fields[i]!;
    if (!field) continue;
    const status = field.slice(0, 2), path = field.slice(3);
    if (status === '??') untracked.push(path);
    else {
      tracked.push(path);
      if (/[RC]/.test(status)) tracked.push(fields[++i]!);
    }
  }
  return { tracked: [...new Set(tracked)], untracked };
}
/** Append once under the dispatch lock; undo only these bytes, retaining existing rules and later appenders. */
async function appendSlotExcludes(exclude: string, lines: string[]): Promise<() => Promise<string | undefined>> {
  const noop = async () => undefined;
  if (!lines.length) return noop;
  let before: Buffer | undefined;
  try { before = await readFile(exclude); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  const text = before?.toString() ?? '', existing = new Set(text.split('\n'));
  const added = lines.filter(line => { if (existing.has(line)) return false; existing.add(line); return true; });
  if (!added.length) return noop;
  const suffix = Buffer.from(`${text.endsWith('\n') ? '' : '\n'}${added.join('\n')}\n`);
  const written = Buffer.concat([before ?? Buffer.alloc(0), suffix]);
  const undo = async (partial = false): Promise<string | undefined> => {
    let current: Buffer;
    try { current = await readFile(exclude); } catch (e) {
      if (before === undefined && (e as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw e;
    }
    // On append failure even a prefix of the suffix is ours; retain the same guard against unrelated edits.
    const length = partial ? Math.min(current.length, written.length) : written.length;
    if (length < (before?.length ?? 0) || !current.subarray(0, length).equals(written.subarray(0, length))) return 'common info/exclude changed; cannot safely remove this dispatch\'s lines';
    const restored = Buffer.concat([before ?? Buffer.alloc(0), current.subarray(written.length)]);
    if (before === undefined && !restored.length) await unlink(exclude);
    else if (partial && before !== undefined && current.length <= written.length) await truncate(exclude, before.length);
    else await writeFile(exclude, restored);
    return undefined;
  };
  // The caller cannot receive undo until append succeeds: clean partial/full writes here before rethrowing.
  try { await appendFile(exclude, suffix); }
  catch (error) { throw await rolledBack(error, [['setup exclude cleanup', () => undo(true)]]); }
  return () => undo();
}
/** SS6: a tracked ignore negation has higher precedence than common excludes, even inside collapsed directories. */
async function verifySlotExcludes(worktree: string, paths: string[]): Promise<void> {
  if (!paths.length) return;
  const visible = (await slotSetupStatus(worktree, 'all')).untracked.filter(path => paths.some(created => created.endsWith('/') ? path.startsWith(created) : path === created));
  if (visible.length) throw new OwedError(`slot setup outputs still visible: ${visible.map(oneLine).join(', ')}; a tracked ignore rule such as a ! negation in .gitignore overrides info/exclude; ignore setup outputs in the repository or change slot_setup`);
}
/** SS: setup is a dispatch prerequisite, outside the ledger lock and before any dispatch entry. */
async function setupSlot(plan: Plan, worktree: string): Promise<{ line: string; excludes: string[]; paths: string[] } | undefined> {
  const run = plan.slot_setup === false ? undefined : plan.slot_setup ?? plan.setup;
  if (run === undefined) return undefined;
  const before = new Set((await slotSetupStatus(worktree)).untracked);
  const result = await runCommand({ plan }, run, worktree, 600);
  if (result.error || result.code !== 0) {
    const tail = lastLines(result.log, 20);
    throw new OwedError(`slot setup failed: ${result.error ?? `exit ${result.code}`}; last output:${tail.length ? tail.map(l => `\n  ${l}`).join('') : ' (none)'}`);
  }
  const after = await slotSetupStatus(worktree);
  if (after.tracked.length) throw new OwedError(`slot setup changed tracked paths: ${after.tracked.map(oneLine).join(', ')}`);
  const paths = after.untracked.filter(path => !before.has(path));
  // Gitignore cannot represent a line break in a literal path: refuse rather than leave a setup output committable.
  if (paths.some(path => /[\r\n]/.test(path))) throw new OwedError(`slot setup output cannot be excluded: ${paths.map(oneLine).join(', ')}`);
  const excludes = paths.map(path => `/${ignoreLiteral(path).replace(/ +$/, spaces => spaces.replace(/ /g, '\\ '))}`);
  const excluded = paths.length ? `; excluded: ${paths.map(path => oneLine(`/${path}`)).join(', ')}` : '';
  return { line: `Setup: ran \`${oneLine(run)}\` in this worktree (exit 0${excluded})`, excludes, paths };
}
export async function dispatch(o: Actor & { node: string; allowOverlap?: boolean }): Promise<DispatchPacket> {
  // The main worktree root: dispatching from inside a slot worktree must not nest the new worktree in it.
  // Resolved first, so an unverifiable layout is refused before any ledger, exclude or worktree effect.
  owner(o); const root = await git.mainRoot(o.cwd), ledger = await Ledger.open(o.cwd);
  return ledger.withLock(() => retryCas(ledger, async state => {
    const n = node(state,o.node), spec = state.plan.nodes.find(x => x.id === o.node)!;
    if (n.held !== undefined) throw new OwedError(`${o.node} is held by abandon #${n.held}; release it with owed resume ${o.node}`);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(o.node)) throw new OwedError('Node id is unsafe for a worktree path','usage');
    // Overlapping writes of concurrent slots produce conflicts or ambiguous ownership; refuse unless explicitly allowed.
    const overlaps = overlapping(state,o.node);
    if (overlaps.length && !o.allowOverlap) throw new OwedError(`writes of ${o.node} overlap the open slot of ${overlaps.join(', ')}; wait for ${overlaps.length > 1 ? 'them' : 'it'} or dispatch with --allow-overlap`);
    const attempt = (n.slot?.attempt ?? 0)+1, { branch, worktree, excludeLine } = await slotLayout(root,state.plan,spec,attempt);
    const rules = state.rules.filter(r => r.nodes === '*' || r.nodes.includes(o.node));
    // K1.3: the driver (parent:drive) launches this writer and measures its candidate itself.
    let packet = dispatchPacket(spec, attempt, worktree, rules, by(o) === 'parent:drive', state);
    const d: Draft = { kind:'dispatch', by:by(o), channel:o.channel, node:o.node, attempt, base:state.trunk.commit, branch, worktree, packet:await ledger.putBlob(packet), rulings_seen:Math.max(-1,...rules.map(r => r.seq)), ...(overlaps.length ? { overlaps } : {}) };
    guard(state,d);
    const exclude = join(await git.commonDir(o.cwd),'info','exclude');
    await mkdir(dirname(exclude),{recursive:true}); let text = ''; try { text = await readFile(exclude,'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (excludeLine && !text.split('\n').includes(excludeLine)) await appendFile(exclude,`\n${excludeLine}\n`);
    // The first directory mkdir created (undefined when the parent existed): a rollback removes what it created.
    const made = await mkdir(dirname(worktree),{recursive:true});
    // Removes the directories up to `made`; the failed rmdir is a rollback failure (they were all created here).
    const unmake = async (): Promise<string | undefined> => {
      if (made) for (let p = dirname(worktree); ; p = dirname(p)) { try { await rmdir(p); } catch (e) { return `rmdir ${p}: ${(e as NodeJS.ErrnoException).code ?? String(e)}`; } if (p === made || dirname(p) === p) break; }
      return undefined;
    };
    try { await git.addWorktree(root,worktree,branch,state.trunk.commit); } catch (error) { throw await rolledBack(error,[['directory cleanup',unmake]]); }
    let entry: Entry;
    let undoExcludes = async (): Promise<string | undefined> => undefined;
    const hasSetup = state.plan.slot_setup !== false && (state.plan.slot_setup ?? state.plan.setup) !== undefined;
    try {
      const setup = await setupSlot(state.plan, worktree);
      if (setup) { packet += `\n${setup.line}`; d.packet = await ledger.putBlob(packet); }
      entry = await ledger.withLock(async () => {
        const current = (await load(ledger)).state; stable(state,current,o.node);
        if (canonical(current.rules) !== canonical(state.rules)) throw casRefusal('Rulings changed; dispatch again');
        if (canonical(overlapping(current,o.node)) !== canonical(overlaps)) throw casRefusal('Open slots changed; dispatch again');
        guard(current,d);
        if (setup) {
          undoExcludes = await appendSlotExcludes(exclude,setup.excludes);
          await verifySlotExcludes(worktree,setup.paths);
        }
        return (await ledger.append([d]))[0]!;
      });
    }
    catch (error) {
      const run = (args: string[]) => async () => { const r = await git.git(root,args,{allowFail:true}); return r.code ? r.stderr.trim().split('\n').join(' ') || `exit ${r.code}` : undefined; };
      const dropBranch = async () => {
        const ref = `refs/heads/${branch}`, checkedOut = (await git.listWorktrees(root)).find(w => w.branch === ref);
        // update-ref does not enforce branch's checked-out protection; keep it before the atomic ref CAS.
        if (checkedOut) return `branch '${branch}' is checked out in ${checkedOut.path}`;
        return run(['update-ref','-d',ref,state.trunk.commit])();
      };
      // A setup may create ignored/untracked prerequisites or edit tracked files; remove this unrecorded slot too.
      throw await rolledBack(error,[['setup exclude cleanup',undoExcludes],['git worktree remove',run(['worktree','remove',...(hasSetup ? ['--force'] : []),worktree])],['git branch -d',dropBranch],['directory cleanup',unmake]]);
    }
    return { node:o.node, attempt, worktree, branch, packet, entry, subagent:{agent:'worker',cwd:worktree,task:packet} };
  }),'dispatch');
}
/**
 * Runs every rollback step of a failed dispatch, even after an earlier step failed; a step returns its failure text
 * or undefined. Returns `error` itself when every step succeeded, otherwise an error of the same code naming the
 * original failure and each failed step.
 */
async function rolledBack(error: unknown, steps: [string, () => Promise<string | undefined>][]): Promise<unknown> {
  const failed: string[] = [];
  for (const [name, step] of steps) { try { const f = await step(); if (f !== undefined) failed.push(`${name}: ${f}`); } catch (e) { failed.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); } }
  if (!failed.length) return error;
  const message = error instanceof Error ? error.message : String(error);
  return new OwedError(`${message}\nrollback failed: ${failed.join('; ')}`, error instanceof OwedError ? error.code : 'internal');
}
/** `path` with its deepest existing ancestor resolved through symlinks (the rest need not exist yet). */
async function physical(path: string): Promise<string> {
  try { return await realpath(path); } catch { const up = dirname(path); return up === path ? path : join(await physical(up), basename(path)); }
}
/**
 * D19: branch and worktree of attempt `attempt` of node `spec` under the plan's `worktrees:` block (defaults: root
 * `.owed/wt`, branch `owed/{node}/{attempt}`), and the info/exclude line: `.owed/` for the default root (as in 0.4.1),
 * `/<repository-relative root>/` (glob metacharacters escaped) for another root inside the main worktree, none for a
 * root outside it. The worktree path is physical (the root's deepest existing ancestor resolved through symlinks), so
 * it equals git's toplevel inside the slot and writer inference matches it. Refuses (usage) an invalid branch name or a
 * root equal to the main worktree root, before any effect.
 */
async function slotLayout(root: string, plan: Plan, spec: NodeSpec, attempt: number): Promise<{ branch: string; worktree: string; excludeLine?: string }> {
  const cfg = worktreesConfig(plan), branch = expandBranch(cfg.branch, spec, attempt);
  if ((await git.git(root,['check-ref-format','--branch',branch],{allowFail:true})).code) throw new OwedError(`branch name ${branch} (from worktrees.branch "${cfg.branch}") is not a valid git branch name`,'usage');
  const base = await physical(resolve(root,cfg.root)), worktree = join(base,`${spec.id}-${attempt}`);
  const rel = relative(await physical(root),base);
  if (!rel) throw new OwedError(`worktrees.root ${cfg.root} is the main worktree root; use a directory inside or outside it`,'usage');
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return { branch, worktree };
  const path = rel.split(sep).join('/');
  return { branch, worktree, excludeLine: path === '.owed/wt' ? '.owed/' : `/${ignoreLiteral(path)}/` };
}
/** `text` as a literal gitignore pattern: `\`, `*`, `?` and `[` escaped, and a leading `!` or `#`. */
export function ignoreLiteral(text: string): string { return text.replace(/[\\*?[]/g,'\\$&').replace(/^[!#]/,'\\$&'); }
/** DR3: use the current recorded dsa launch's actual model, not its selected spec. Unknown stays absent. */
async function recordedModel(cwd: string, s: State, id: string, principal: string, explicit?: string): Promise<string | undefined> {
  if (explicit !== undefined) {
    if (typeof explicit !== 'string' || !explicit.trim()) throw new OwedError('model must be nonempty text', 'usage');
    return explicit;
  }
  const n = s.nodes[id], slot = n?.slot;
  if (!slot?.open) return undefined;
  const { driveReviewerSlot, reviewerBase } = await import('./reducer.ts');
  const k = driveReviewerSlot(principal, id, slot.attempt);
  const launches = n!.runs.find(r => r.attempt === slot.attempt)?.launches ?? [];
  const l = principal === slot.writer ? launches.find(l => l.role === 'writer') : k === undefined ? undefined
    : launches.find(l => l.role === 'reviewer' && Number(l.rid.split(':').at(-1)) === reviewerBase(s, id) + k);
  if (!l) return undefined;
  const { Dsa } = await import('./dsa.ts');
  try { return (await new Dsa({ cwd, timeoutMs: 5000 }).describe(l.rid)).model; } catch { return undefined; }
}
export async function submit(o: Actor & { node: string; commit?: string; model?: string }): Promise<Entry> {
  owner(o); const ledger = await Ledger.open(o.cwd), { state } = await load(ledger), n = node(state,o.node);
  if (!n.slot?.open) throw new OwedError('No open writer slot');
  if ((!o.commit || resolve(await git.repoRoot(o.cwd)) === resolve(n.slot.worktree)) && !await git.isClean(n.slot.worktree)) throw new OwedError('slot worktree is dirty');
  const commit = await git.revParse(o.commit ? o.cwd : n.slot.worktree,o.commit ?? 'HEAD');
  if (!await git.isAncestor(o.cwd,n.slot.base,commit)) throw new OwedError('submit commit must be a descendant of slot base');
  await git.checkCandidateLimits(o.cwd,state.plan.limits,n.slot.base,commit);
  const spec = state.plan.nodes.find(x => x.id === o.node)!, facts = await git.candidateFacts(o.cwd,state.plan,spec,n.slot.base,commit,n.slot.attempt,stateQuarantine(state));
  // D23: approve and evidence keys derive from the patch, like review.
  Object.assign(facts.keys, manualKeys(spec,facts.patch));
  const model = await recordedModel(o.cwd,state,o.node,by(o),o.model);
  return ledger.withLock(async () => { const current = (await load(ledger)).state; stable(state,current,o.node); const d: Draft = { kind:'submit', by:by(o), node:o.node, attempt:n.slot!.attempt, facts, ...(model !== undefined ? { model } : {}) }; guard(current,d); return (await ledger.append([d]))[0]!; });
}
export async function attest(o: MeasurementContext & { node: string; rerun?: boolean; remeasure?: boolean; all?: boolean }): Promise<AttestResult> {
  checkAbort(o.signal);
  if (!measurementScope()) return leased(o, signal => attest({ ...o, signal }));
  const ledger = await Ledger.open(o.cwd);
  if (o.remeasure) return ledger.withLock(async () => {
    const r = await remeasureMerge(o,ledger), card = await why(o);
    return { node:o.node, observations:r.recorded, superseded:r.superseded, accepted:card.accepted, receipt:card, remeasured:r.remeasured };
  },attestLock(o.node),o.signal,{ busy:owner => attestBusyText(o.node,owner) });
  return ledger.withLock(async () => {
    const { state } = await load(ledger), n = candidate(state,o.node), jobs = attestJobs(state,o.node);
    if (o.rerun) for (const c of state.plan.nodes.find(x => x.id === o.node)!.checks) for (const kind of ['check', ...(c.red ? ['red'] : [])] as ('check'|'red')[]) {
      const obligation = `${kind}:${c.id}`, key = n.candidate!.keys[obligation]!;
      if (!jobs.some(j => j.key === key && j.obligation === obligation)) jobs.push(quarantinedJob(state,{kind,subject:o.node,obligation,key,spec:c,commit:n.candidate!.commit,base:n.slot!.base}));
    }
    if (o.rerun && !jobs.some(j => j.obligation === 'writes' && j.key === n.candidate!.keys.writes)) jobs.push({ kind:'writes',subject:o.node,obligation:'writes',key:n.candidate!.keys.writes!,commit:n.candidate!.commit,base:n.slot!.base });
    const r = await runJobs(o.cwd,ledger,state,[...genesisJobs(state),...jobs],o.signal), card = await why(o);
    return { node:o.node, observations:r.recorded, superseded:r.superseded, accepted:card.accepted, receipt:card };
  },attestLock(o.node),o.signal,{ busy:owner => attestBusyText(o.node,owner) });
}
/**
 * MS1: measures again, on the node's current merge tree, every invariant whose latest observation on the merge key
 * failed (`all`: every invariant) and records the new observations on the same keys (merging = node). Nothing else
 * is invalidated; the usual aggregation applies. Recorded only when trunk, plan and the node's slot did not move.
 */
async function remeasureMerge(o: MeasurementContext & { node: string; all?: boolean }, ledger: Ledger): Promise<{ recorded: Entry[]; superseded: JobRef[]; remeasured: string[] }> {
  const { state } = await load(ledger), n = candidate(state,o.node);
  { const drift = await git.trunkDrift(o.cwd,state.trunk.name,state.trunk.commit); if (drift) throw new OwedError(`trunk changed (CAS): ${driftText(drift)}`); }
  const built = await git.buildMerge(o.cwd,state.trunk.commit,n.candidate!.commit,`owed merge ${o.node}`);
  if ('conflicts' in built) throw new OwedError(`rebase needed: run owed rebase ${o.node}, then rebase the worktree and submit again`);
  const m = await mergeFacts(o.cwd,state,o.node,built.commit), jobs = remeasureJobs(state,o.node,m,o.all);
  const run = await measureAll(jobs,parallelOf(state.plan),o.signal,async job => ({ ...await runJob({cwd:o.cwd,ledger,plan:state.plan,signal:o.signal},job), merging:o.node }) as Draft);
  const observations = run.observations.filter((x): x is Draft => x !== undefined);
  if (run.aborted) return abortWith(ledger,state,observations,o.node);
  return ledger.withLock(async () => {
    const latest = await load(ledger); nodeStable(state,latest,o.node);
    const moved = latest.state.planSha !== state.planSha || !!await git.trunkDrift(o.cwd,state.trunk.name,state.trunk.commit);
    const kept = moved ? [] : observations.filter(d => !validateDraft(latest.state,d).length);
    const superseded = observations.filter(d => !kept.includes(d)).flatMap(d => d.kind === 'obs' ? [{ subject:d.subject, obligation:d.obligation, key:d.key }] : []);
    return { recorded:kept.length ? await ledger.append(kept) : [], superseded, remeasured:jobs.map(j => j.obligation) };
  },undefined,o.signal);
}
/** MS1: one line about what `attest --remeasure` measured again. */
export function remeasureText(node: string | undefined, remeasured: string[], recorded: Entry[]): string {
  if (!remeasured.length) return `Nothing to remeasure: no ${node ? `merge-tree invariant of ${node}` : 'trunk invariant'} failed on its current key (--all measures every one)`;
  return `Remeasured on the same ${node ? 'merge ' : ''}key: ${recorded.map(e => e.kind === 'obs' ? `${e.obligation} #${e.seq} ${e.verdict}` : `#${e.seq}`).join(', ') || 'nothing recorded'}`;
}
/**
 * K1: the attest lock of one node, `attest-<first 16 hex of sha256(node id)>`: attests of different nodes run in
 * parallel (each observation is appended under the ledger lock only if its item is still current, D24).
 */
export const attestLock = (node: string): string => `attest-${sha256(node).slice(0,16)}`;
const heldBy = (o: LockOwner): string => `pid ${o.pid} on ${o.host} since ${o.ts}`;
/** K1: the `busy` message of an attest of `node` while another attest of it holds its lock. */
export const attestBusyText = (node: string, owner: LockOwner): string => `attest of ${node} is already running (${heldBy(owner)}); its observations will appear in owed why ${node}`;
/** `needs: 'parent'` marks a block that needs a parent ruling (D18); the ledger refuses it on an ok verdict. */
/**
 * `named` (G1): the candidate the caller judged (commit or prefix); `pin`: the candidate an owner confirmation showed;
 * either refuses at append time when the open candidate differs. `from`: further working directories of the calling
 * process for the writer-worktree rail (G2.1; o.cwd and process.cwd() are always checked).
 */
export async function review(o: Actor & { node: string; verdict:'ok'|'block'; rank:number; note:string; ack_rulings?:number; obligation?:'review'|'closure-review'; needs?:'parent'; named?: string; pin?: CandidatePin; from?: string[]; model?: string }): Promise<Entry> {
  const given = candidateArg(o.named), ledger = await Ledger.open(o.cwd);
  const modelState = (await readState(o)).state;
  const measuredModel = await recordedModel(o.cwd,modelState,o.node,by(o),o.model);
  return mutate(o,async s => { node(s,o.node); named(s,o.node,given); pinned(s,o.node,o.pin); await writerTree(s,o.node,[o.cwd,process.cwd(),...(o.from ?? [])]); const n = candidate(s,o.node), obligation = o.obligation ?? 'review'; const model = o.model ?? (n.slot?.attempt === modelState.nodes[o.node]?.slot?.attempt && n.candidate?.seq === modelState.nodes[o.node]?.candidate?.seq ? measuredModel : undefined); return { kind:'review',by:by(o),channel:o.channel,node:o.node,attempt:n.slot!.attempt,obligation,key:n.candidate!.keys[obligation] ?? '',verdict:o.verdict,rank:o.rank,note:o.note,ack_rulings:o.ack_rulings ?? await launchedReviewAck(s,o.node,by(o),async sha => (await ledger.getBlob(sha)).toString()),...(model !== undefined ? { model } : {}),...(o.needs !== undefined ? { needs:o.needs } : {}) }; });
}
/** `named` (G1) and `pin` (an owner confirmation's candidate) refuse at append time when the open candidate differs. */
export async function waive(o: Actor & { node:string; obligation:string; reason:string; accept_risk?:number[]; channel:Channel; named?: string; pin?: CandidatePin }): Promise<Entry> {
  const given = candidateArg(o.named);
  return mutate(o,async s => {
    node(s,o.node); named(s,o.node,given); pinned(s,o.node,o.pin);
    const n = candidate(s,o.node), inactive = (o.accept_risk ?? []).filter(seq => !activeRisk(s,o.node,o.obligation,seq));
    let key = n.candidate!.keys[o.obligation] ?? '';
    if (inactive.length && o.as.role === 'owner') {
      const refused = (): never => { throw new OwedError('accept_risk must reference active blocks for this obligation'); };
      if (inactive.some(seq => {
        const e = entriesOf(s).find(e => e.seq === seq);
        return e?.kind !== 'obs' || !mergeRisk(s,o.node,o.obligation,seq,e.key);
      })) return refused();
      const drift = await git.trunkDrift(o.cwd,s.trunk.name,s.trunk.commit);
      if (drift) throw new OwedError(`trunk changed (CAS): ${driftText(drift)}`);
      const built = await git.buildMerge(o.cwd,s.trunk.commit,n.candidate!.commit,`owed merge ${o.node}`);
      if ('conflicts' in built) return refused();
      const m = await mergeFacts(o.cwd,s,o.node,built.commit);
      key = m.facts.keys[o.obligation] ?? '';
      if (!key || (o.accept_risk ?? []).some(seq => activeRisk(s,o.node,o.obligation,seq) ? n.blocks.find(b => b.seq === seq)?.key !== key : !mergeRisk(s,o.node,o.obligation,seq,key))) return refused();
      // Same ledger lock as the append; Git refs can still move independently of the ledger.
      const after = await git.trunkDrift(o.cwd,s.trunk.name,s.trunk.commit);
      if (after) throw new OwedError(`trunk changed (CAS): ${driftText(after)}`);
    }
    return {kind:'waive',by:by(o),channel:o.channel,node:o.node,obligation:o.obligation,key,reason:o.reason,accept_risk:o.accept_risk};
  });
}
/** K2.3: what the recorded waiver `entry` means, from the ledger state right after it (a later entry cannot relabel it; see views.waiverText). */
export async function waiverMeaning(o: Context & { entry: Entry }): Promise<string> { const e = o.entry; if (e.kind !== 'waive') throw new OwedError('not a waiver','internal'); const {entries,lookup} = await load(await Ledger.open(o.cwd)); return waiverText(reduce(entries.filter(x => x.seq <= e.seq),lookup),e); }
export async function defer(o: Actor & { node:string; items:{id:string;key:string}[]; reason:string; channel:Channel }): Promise<Entry> { return mutate(o,s => ({kind:'defer',by:by(o),channel:o.channel,node:o.node,items:o.items.map(i => ({ ...i, id: invariantId(s.plan,i.id) })),reason:o.reason})); }
export async function abandon(o: Actor & { node:string; reason:string; hold?: boolean }): Promise<Entry> {
  owner(o); const ledger = await Ledger.open(o.cwd);
  return ledger.withLock(async () => {
    const latest = await load(ledger), s = latest.state;
    const d: Draft = { kind:'abandon', by:by(o), channel:o.channel, node:o.node, attempt:node(s,o.node).slot?.attempt ?? 0, reason:o.reason };
    guard(s,d);
    const drafts: Draft[] = [d];
    if (o.hold) {
      const h: Draft = { kind:'hold', by:by(o), channel:o.channel, node:o.node, abandon:s.seq + 1, ...(o.reason ? { reason:o.reason } : {}) };
      guard(replayed(latest,drafts),h); drafts.push(h);
    }
    return (await ledger.append(drafts))[0]!;
  });
}

/** AH2: close only the driver's own never-launched attempt after a stale launch; dispatch lock precedes ledger lock. */
export async function closeStaleSlot(o: Context & { node:string; attempt:number }): Promise<string | undefined> {
  const root = await git.mainRoot(o.cwd), ledger = await Ledger.open(o.cwd);
  return ledger.withLock(async () => ledger.withLock(async () => {
    const { state:s, entries } = await load(ledger), n = s.nodes[o.node], slot = n?.slot;
    const d = entries.find(e => e.kind === 'dispatch' && e.node === o.node && e.attempt === o.attempt);
    if (!slot || slot.attempt !== o.attempt || d?.by !== DRIVER || n!.runs.find(r => r.attempt === o.attempt)?.launches.some(l => l.role === 'writer')) return undefined;
    const cause = !s.plan.nodes.some(x => x.id === o.node) ? 'node left the plan' : n!.held !== undefined ? `held by abandon #${n!.held}` : !slot.open ? 'attempt was abandoned' : undefined;
    if (!cause) return undefined;
    if (slot.open) {
      const a: Draft = { kind:'abandon', by:DRIVER, node:o.node, attempt:o.attempt, reason:`stale writer launch: ${cause}` };
      guard(s,a); await ledger.append([a]);
    }
    // No launch intent means no writer could have run through the driver. Keep commits, dirty/locked trees and
    // ambiguous branch registrations; never force removal. The ref deletion compares against the recorded base.
    const trees = await git.listWorktrees(root), tree = trees.find(w => resolve(w.path) === resolve(slot.worktree));
    const nested = trees.some(w => w !== tree && resolve(w.path).startsWith(`${resolve(slot.worktree)}${sep}`));
    if (tree && !tree.locked && !nested && await git.revParse(tree.path,'HEAD') === slot.base && await git.isClean(tree.path)) {
      const r = await git.git(root,['worktree','remove',tree.path],{ allowFail:true });
      if (!r.code && !entries.some(e => e.kind === 'dispatch' && e.branch === slot.branch && (e.node !== o.node || e.attempt !== o.attempt)) && !(await git.listWorktrees(root)).some(w => w.branch === `refs/heads/${slot.branch}`)) await git.git(root,['update-ref','-d',`refs/heads/${slot.branch}`,slot.base],{ allowFail:true });
    }
    return cause;
  }), 'dispatch');
}
export async function recordedPlanReceipt(o: Context & { entry: Entry }): Promise<string> {
  const ledger = await Ledger.open(o.cwd), e = o.entry;
  if (e.kind !== 'plan') return renderEntry(e);
  const prior = parsePlan((await ledger.getBlob(e.prior)).toString()), next = parsePlan((await ledger.getBlob(e.plan)).toString());
  return planReceipt(e, prior, next);
}
export interface RebaseResult { node: string; attempt: number; worktree: string; branch: string; base: string; from: string; previous?: { base: string; commit: string; submit: number }; packet: string; entry: Entry }
/** Moves the open slot of a node onto the current trunk (parent/owner or the slot writer); the writer then rebases the same worktree and submits again. `since`: as for launch (F1). */
export async function rebase(o: Actor & { node:string; since?: number }): Promise<RebaseResult> {
  const entry = await mutate(o,s => { const n = node(s,o.node); if (!n.slot?.open) throw new OwedError(`Node ${o.node} has no open writer slot`); return {kind:'rebase',by:by(o),channel:o.channel,node:o.node,attempt:n.slot.attempt,base:s.trunk.commit,from:n.slot.base}; },{ node:o.node, since:o.since });
  if (entry.kind !== 'rebase') throw new OwedError('unexpected rebase entry','internal');
  const { state } = await load(await Ledger.open(o.cwd)), slot = state.nodes[o.node]!.slot!, previous = slot.rebase?.seq === entry.seq ? slot.rebase.previous : undefined;
  const work = await rebasePending(state, o.node, true);
  const packet = [`# Rebase ${o.node} attempt ${entry.attempt} (ledger #${entry.seq})`, `Working directory: ${slot.worktree}`, `Trunk moved: slot base ${entry.from} → ${entry.base}. The open candidate is invalidated; blocks still bind the node.`, `First commit your work, then run: ${work?.command ?? `git rebase --onto ${entry.base} ${entry.from}`}`, 'Resolve conflicts only; keep the change within the allowed writes and commit.', `Then run: owed submit ${o.node} (the commit must descend from ${entry.base})`, ...(previous ? [`Previously reviewed patch: ${previous.base}..${previous.commit} (submit #${previous.submit})`, `Re-review hint: git range-diff ${previous.base}..${previous.commit} ${entry.base}..<new commit>`] : [])].join('\n');
  return { node:o.node, attempt:entry.attempt, worktree:slot.worktree, branch:slot.branch, base:entry.base, from:entry.from, ...(previous ? { previous } : {}), packet, entry };
}
export async function merge(o: Actor & { node:string; signal?: AbortSignal; lease?: boolean }): Promise<MergeResult> {
  owner(o); if (!['owner','parent'].includes(o.as.role)) throw new OwedError('merge requires parent/owner');
  checkAbort(o.signal);
  if (!measurementScope()) return leased(o, signal => merge({ ...o, signal }));
  const ledger = await Ledger.open(o.cwd);
  return ledger.withLock(async () => {
    let snapshot = await load(ledger), state = snapshot.state;
    const n = candidate(state,o.node);
    if (!n.accepted) {
      const trunkRed = n.blocks.filter(b => b.state === 'active').flatMap(b => trunkRedHint(state,b.seq,b.key) ?? []);
      const failures = entriesOf(state).filter((e): e is ObsEntry => e.kind === 'obs' && e.merging === o.node && n.blocks.some(b => b.kind === 'exec' && (b.state === 'active' || b.state === 'flaky') && b.seq === e.seq));
      const lead = await mergeTreeBreakLead(o.cwd,state,o.node,failures.map(e => e.commit)), hints = mergeFailureHints(state,o.node,failures);
      const writesHint = n.items.some(i => i.obligation === 'writes' && i.status === 'D') ? grantHint(state,o.node) : undefined;
      const suffix = writesHint ? `\n${writesHint}` : '';
      if (trunkRed.length) throw new OwedError([...lead, ...trunkRed, ...hints].join('; ') + suffix);
      throw new OwedError([...lead, `Node ${o.node} current candidate is not yet accepted:${n.items.filter(i => i.status === 'D').map(i => i.obligation).join(', ')}`, ...hints].join('; ') + suffix);
    }
    { const drift = await git.trunkDrift(o.cwd,state.trunk.name,state.trunk.commit); if (drift) throw new OwedError(`trunk changed (CAS): ${driftText(drift)}`); }
    // IR1: trunk measurements persist even if the later merge guard refuses.
    await attestTrunk({ cwd:o.cwd, signal:o.signal });
    const refreshed = await load(ledger); nodeStable(state,refreshed,o.node);
    snapshot = refreshed; state = refreshed.state;
    const built = await git.buildMerge(o.cwd,state.trunk.commit,n.candidate!.commit,`owed merge ${o.node}`);
    if ('conflicts' in built) throw new OwedError(`rebase needed: run owed rebase ${o.node}, then rebase the worktree and submit again`);
    const m = await mergeFacts(o.cwd,state,o.node,built.commit);
    // Genesis jobs are not about this merge; merge-result jobs record the node being merged (decoy attribution).
    // M1: up to exec.parallel jobs at once, observations in job order. An aborted run (D16) is not measured, no further
    // job starts, and the merge stops before trunk moves, keeping the completed observations (abortWith).
    const jobs = [...genesisJobs(state).map(job => ({ job, merging: false })),...mergeJobs(state,o.node,m).map(job => ({ job, merging: true }))];
    const run = await measureAll(jobs,parallelOf(state.plan),o.signal,async ({ job, merging }) => { const obs = await runJob({cwd:o.cwd,ledger,plan:state.plan,signal:o.signal},job); return merging ? {...obs,merging:o.node} as Draft : obs; });
    const observations = run.observations.filter((x): x is Draft => x !== undefined);
    if (run.aborted) return abortWith(ledger,state,observations,o.node);
    // TR1: before refusing a measured/reused node-check fail, probe trunk under this same lease and merge lock.
    // No ledger lock while commands run; the existing final CAS discards stale results.
    const preview = mergeCurrent(snapshot,o.node,m,observations,true).state;
    const failed = mergeGuard(preview,o.node,m).nodeItems.filter(i => i.status === 'D' && i.obligation.startsWith('check:') && i.evidence.some(seq => entriesOf(preview).some(e => e.seq === seq && e.kind === 'obs' && e.probe === undefined && e.verdict === 'fail' && e.key === i.key)));
    const probes: Draft[] = [], slotBaseRed: string[] = [];
    for (const i of failed) {
      const spec = state.plan.nodes.find(x => x.id === o.node)!.checks.find(c => `check:${c.id}` === i.obligation)!;
      const fresh = await newCheckTests(o.cwd,n,spec);
      if (fresh) { slotBaseRed.push(fresh); continue; }
      const key = await git.trunkCheckKey(o.cwd,state.plan,spec,state.trunk.commit,stateQuarantine(state));
      if (entriesOf(state).some(e => e.kind === 'obs' && e.probe === 'trunk' && e.subject === o.node && e.obligation === i.obligation && e.key === key && e.commit === state.trunk.commit && e.verdict !== 'error')) continue;
      const obs = await runJob({cwd:o.cwd,ledger,plan:state.plan,signal:o.signal}, quarantinedJob(state,{kind:'check',subject:o.node,obligation:i.obligation,key,spec,commit:state.trunk.commit,base:state.trunk.commit}));
      probes.push({...obs,probe:'trunk'});
    }
    if (o.signal?.aborted) return abortWith(ledger,state,observations,o.node);
    return ledger.withLock(async () => {
      // K4.1: node-scoped CAS (ledger trunk, this node's slot and candidate) and the trunk ref; a moved one records nothing.
      const latest = await load(ledger); nodeStable(state,latest,o.node);
      { const drift = await git.trunkDrift(o.cwd,state.trunk.name,state.trunk.commit); if (drift) throw new OwedError(`trunk changed (CAS): ${driftText(drift)}`); }
      // K4.2: the guard decides on the latest state under the latest plan: the merge facts are recomputed when the plan
      // changed, and only the measured observations whose job is still current there are kept (D24.1).
      const spec = latest.state.plan.nodes.find(x => x.id === o.node), reasons: string[] = [];
      if (!spec) reasons.push(`${o.node} is no longer a node of the plan`);
      const lm = !spec || latest.state.planSha === state.planSha ? m : await mergeFacts(o.cwd,latest.state,o.node,built.commit);
      const merged = mergeCurrent(latest,o.node,lm,observations,!!spec), kept = merged.kept;
      const currentProbes: Draft[] = [];
      for (const p of probes) if (p.kind === 'obs' && spec) {
        const c = spec.checks.find(c => `check:${c.id}` === p.obligation);
        if (c && p.key === await git.trunkCheckKey(o.cwd,latest.state.plan,c,latest.state.trunk.commit,stateQuarantine(latest.state))) currentProbes.push(p);
      }
      const current = prospective({...latest,state:merged.state},currentProbes);
      kept.push(...currentProbes);
      // Last abort point (D16): after it trunk moves and the merge entry must follow.
      if (o.signal?.aborted) { if (kept.length) await ledger.append(kept); throw aborted(); }
      const g = spec ? mergeGuard(current,o.node,lm) : undefined;
      if (g) reasons.push(...g.reasons);
      // A job of the latest state this run did not measure (a key the plan update introduced) refuses; a retry measures it.
      const missed = spec ? unmeasured(current,o.node,lm,observations) : [];
      if (missed.length) reasons.push(`not measured: ${missed.map(j => `${j.subject}/${j.obligation} (key ${j.key.slice(0,12)})`).join(', ')} (the plan changed while merge measured); run owed merge again: it measures only what lacks a verdict`);
      if (reasons.length || !g) {
        if (kept.length) await ledger.append(kept);
        // RC3 (#1274): report evidence deciding unsatisfied items on the guarded merge keys, including reused obs.
        const bySeq = new Map(entriesOf(current).map(e => [e.seq, e])), seen = new Set<number>(), failedObs: ObsEntry[] = [];
        const failures = [...(g?.nodeItems ?? []), ...(g?.invItems ?? [])].flatMap(i => i.status !== 'D' ? [] : i.evidence.flatMap(seq => {
          const e = bySeq.get(seq);
          if (seen.has(seq) || e?.kind !== 'obs' || e.verdict !== 'fail' || e.subject !== i.subject || e.obligation !== i.obligation || e.key !== i.key) return [];
          seen.add(seq); failedObs.push(e);
          return e.note || e.failed?.length ? [`${e.subject}/${e.obligation}: ${e.note ?? `failed tests: ${e.failed!.join(', ')}`}`] : [];
        }));
        const trunkRed = (g?.nodeItems ?? []).filter(i => i.status === 'D').flatMap(i => i.evidence.flatMap(seq => trunkRedHint(current,seq,i.key) ?? []));
        const lead = await mergeTreeBreakLead(o.cwd,current,o.node,[built.commit]);
        const reused = reusedHint(o.node,failedObs.filter(e => e.subject === 'trunk' && e.seq <= latest.state.seq),Date.now(),by(o) === DRIVER);
        throw new OwedError([...lead, ...new Set(trunkRed), ...failures, ...reasons, ...deferBoundHints(current,o.node,g?.invItems ?? []), ...slotBaseRed, ...mergeFailureHints(current,o.node,failedObs), ...(reused ? [reused] : [])].join('; '));
      }
      const d: Draft = {kind:'merge',by:'executor:owed',node:o.node,attempt:n.slot!.attempt,prior:state.trunk.commit,commit:built.commit,facts:lm.facts,state:lm.state}; guard(current,d);
      await git.advanceTrunk(o.cwd,state.trunk.name,state.trunk.commit,built.commit);
      const entry = (await ledger.append([...kept,d])).at(-1)!;
      return {node:o.node,...built,entry,deferred:g.invItems.filter(i => i.status === 'D'),unguarded:unguardedPaths(current.plan,lm.facts.changed)};
    },undefined,o.signal);
  },'merge',o.signal);
}
/**
 * AT1: refusal lead when merge trees `commits` of `node` break an invariant trunk passes and trunk moved since the
 * slot base: the remedy is a rebase, never a waiver, sweep or adoption. Empty otherwise.
 */
/** AT1: the first words of the merge-tree break lead (the driver keeps it first in its halt text). */
export const MERGE_TREE_BREAK = 'merge tree does not pass ';
async function mergeTreeBreakLead(cwd: string, s: State, node: string, commits: string[]): Promise<string[]> {
  const breaks = [...new Set(commits)].flatMap(c => mergeTreeBreaks(s,node,c)), base = s.nodes[node]?.slot?.base;
  if (!breaks.length || !base || base === s.trunk.commit) return [];
  const moved = await git.countCommits(cwd,base,s.trunk.commit).catch(() => 0);
  if (!moved) return [];
  return [`${MERGE_TREE_BREAK}${[...new Set(breaks.map(b => b.obligation))].join(', ')} (trunk passes); trunk moved ${moved} commits since the slot base: rebase → owed rebase ${node}`];
}
/** AT5: refused invariant debt whose owner defer was recorded on another merge key and does not carry. */
function deferBoundHints(s: State, node: string, items: ItemView[]): string[] {
  return items.flatMap(i => {
    if (i.status !== 'D' || i.mark === '\u23f8') return [];
    const d = carriedDefer(s,node,i.obligation.slice(4),i.key);
    return d && !d.carried ? [`defer #${d.defer.seq} was bound to merge key ${d.defer.key.slice(0,12)} (trunk moved)`] : [];
  });
}
/** AT2: a check whose `tests` include files new in the candidate is never probed on trunk; its red reference is the slot base. */
async function newCheckTests(cwd: string, n: NodeState, spec: CheckSpec): Promise<string | undefined> {
  if (!n.candidate || !spec.tests?.length) return undefined;
  const fresh = await git.newFiles(cwd,n.candidate.base,n.candidate.commit,spec.tests);
  return fresh.length ? `check:${spec.id} runs tests new in the candidate (${fresh.slice(0,3).join(', ')}${fresh.length > 3 ? `, +${fresh.length - 3}` : ''}): its red reference is the slot base ${n.candidate.base.slice(0,12)}, not trunk` : undefined;
}
/** The merge result's candidate and state facts of node `id` under the plan of `s` (merge commit `commit` on the ledger trunk). */
async function mergeFacts(cwd: string, s: State, id: string, commit: string): Promise<{ facts: CandidateFacts; state: StateFacts }> {
  const spec = s.plan.nodes.find(x => x.id === id)!, n = s.nodes[id]!;
  return { facts:await git.candidateFacts(cwd,s.plan,spec,s.trunk.commit,commit,n.slot!.attempt,stateQuarantine(s,id)), state:await git.stateFacts(cwd,s.plan,commit,stateQuarantine(s,id)) };
}
const sameJob = (a: JobRef, b: JobRef): boolean => a.subject === b.subject && a.obligation === b.obligation && a.key === b.key;
/**
 * K4.2 (D24.1 for merge): the measured `observations` whose job is still current, in order, and the prospective state
 * after them. A merge-result observation is current while its (subject, obligation, key) is a merge job of the latest
 * state under merge facts `m` (so the key is the latest plan's key and still lacks a verdict); a genesis observation
 * while it is a genesis job. `nodeJobs` false (the node left the plan) keeps genesis observations only.
 */
function mergeCurrent(latest: Awaited<ReturnType<typeof load>>, id: string, m: { facts: CandidateFacts; state: StateFacts }, observations: Draft[], nodeJobs: boolean): { state: State; kept: Draft[] } {
  const kept: Draft[] = []; let current = latest.state, own = false;
  for (const obs of observations) {
    if (obs.kind !== 'obs') continue;
    const jobs = obs.merging !== undefined ? (nodeJobs ? mergeJobs(current,id,m) : []) : genesisJobs(current);
    if (!jobs.some(j => sameJob(j,obs)) || validateDraft(current,obs).length) continue;
    const entry = {...obs,seq:current.seq+1,ts:new Date().toISOString(),prev:current.head} as Entry;
    // G1.3: folded onto a private copy of the loaded state.
    entry.hash=entryHash(entry); current = own ? extendState(current,[entry]) : reduceFrom(current,[entry],latest.lookup); own = true; kept.push(obs);
  }
  return { state: current, kept };
}
/** Genesis and merge jobs of `s` (merge facts `m`) that no measured observation of this run covers. */
function unmeasured(s: State, id: string, m: { facts: CandidateFacts; state: StateFacts }, observations: Draft[]): JobRef[] {
  return [...genesisJobs(s),...mergeJobs(s,id,m)].filter(j => !observations.some(o => o.kind === 'obs' && sameJob(j,o))).map(j => ({ subject:j.subject, obligation:j.obligation, key:j.key }));
}
/** State after appending `observations` to the loaded ledger, without persisting them (each is guarded in turn). */
function prospective(latest: Awaited<ReturnType<typeof load>>, observations: Draft[]): State {
  let current = latest.state, own = false;
  for (const obs of observations) {
    guard(current,obs);
    const entry = {...obs,seq:current.seq+1,ts:new Date().toISOString(),prev:current.head} as Entry;
    // G1.3: folded onto a private copy of the loaded state.
    entry.hash=entryHash(entry); current = own ? extendState(current,[entry]) : reduceFrom(current,[entry],latest.lookup); own = true;
  }
  return current;
}

// ---------- adopt: trunk commits made outside owed (SPEC §6.6) ----------
export interface AdoptPreview { trunk: string; prior: string; commit: string; commits: number; changed: string[] }
/** `allowance` (D21.4): for a parent adoption, S of `under allowance (plan #S)`. */
export interface AdoptResult extends AdoptPreview { entry: Entry; observations: Entry[]; allowance?: number; lease?: string }
/** Preconditions of an adoption, checked before any ledger effect: commit = refs/heads/<trunk> ≠ ledger trunk, a fast-forward of it. */
async function adoptable(cwd: string, s: State, commit?: string): Promise<AdoptPreview> {
  const ref = `refs/heads/${s.trunk.name}`, prior = s.trunk.commit;
  const head = await git.git(cwd,['rev-parse','--verify','--quiet','--end-of-options',`${ref}^{commit}`],{allowFail:true});
  if (head.code) throw new OwedError(`${ref} does not exist; nothing to adopt`);
  const current = head.stdout.trim();
  let target = current;
  if (commit !== undefined) {
    const r = await git.git(cwd,['rev-parse','--verify','--quiet','--end-of-options',`${commit}^{commit}`],{allowFail:true});
    if (r.code) throw new OwedError(`${commit} is not a commit`,'usage');
    target = r.stdout.trim();
    if (target !== current) throw new OwedError(`adopt records only what is on trunk: ${commit} (${target.slice(0,12)}) is not ${ref} (${current.slice(0,12)})`);
  }
  if (target === prior) throw new OwedError(`nothing to adopt: ${ref} equals the ledger trunk ${prior.slice(0,12)}`);
  if ((await git.git(cwd,['cat-file','-e',`${prior}^{commit}`],{allowFail:true})).code) throw new OwedError(`ledger trunk ${prior} is missing from the repository; owed adopt cannot check that ${ref} is a fast-forward of it`);
  const ff = (await git.git(cwd,['merge-base','--is-ancestor',prior,target],{allowFail:true})).code === 0;
  if (!ff) throw new OwedError(`trunk was rewritten: the ledger trunk ${prior.slice(0,12)} is not an ancestor of ${ref} (${target.slice(0,12)}); owed adopt records only fast-forwards: restore ${ref} to a descendant of ${prior.slice(0,12)}`);
  return { trunk:s.trunk.name, prior, commit:target, commits:await git.countCommits(cwd,prior,target), changed:await git.changedPaths(cwd,prior,target) };
}
/** What `adopt` would record (no effect): for owner confirmation dialogs. */
export async function adoptPreview(o: Context & { commit?: string }): Promise<AdoptPreview> { const { state } = await load(await Ledger.open(o.cwd)); return adoptable(o.cwd,inited(state),o.commit); }
/**
 * Owner adoption of trunk commits made outside owed. Measures every invariant whose key changed on the adopted
 * commit; an invariant satisfied on the prior trunk but not on the adopted commit refuses the adoption (its
 * observations are recorded). Same lock/CAS discipline as merge: a moved ref or ledger records nothing, except after an
 * abort (D16a, SPEC §7.8): observations measured before it are recorded when the ledger is stable and they pass the
 * guard, without a ref check (abortWith).
 */
export async function adopt(o: Actor & { commit?: string; note: string; channel?: Channel; signal?: AbortSignal; lease?: boolean }): Promise<AdoptResult> {
  owner(o);
  // D21.4: a parent may adopt only under an `adopt` allowance of the current plan (paths checked below, before any effect).
  if (o.as.role !== 'owner' && !(o.as.role === 'parent' && adoptPrefixes((await load(await Ledger.open(o.cwd))).state.plan).length)) throw new OwedError('adopt requires owner: it records trunk changes that owed did not review');
  if (typeof o.note !== 'string' || !o.note.trim()) throw new OwedError('adopt requires a note','usage');
  checkAbort(o.signal);
  if (!measurementScope()) return leased(o, signal => adopt({ ...o, signal }));
  const ledger = await Ledger.open(o.cwd);
  return ledger.withLock(async () => {
    const { state } = await load(ledger); inited(state);
    const p = await adoptable(o.cwd,state,o.commit);
    if (o.as.role === 'parent') { const outside = unadoptable(state.plan,p.changed); if (outside !== undefined) throw new OwedError(`parent adoption refused: changed path ${outside} is not under an allow adopt prefix (${adoptPrefixes(state.plan).join(', ') || 'none'}); the owner must adopt it`); }
    const sf = await git.stateFacts(o.cwd,state.plan,p.commit,stateQuarantine(state));
    // M1: up to exec.parallel jobs at once, observations in job order; an abort keeps the completed ones (abortWith).
    const run = await measureAll([...genesisJobs(state),...adoptJobs(state,sf)],parallelOf(state.plan),o.signal,job => runJob({cwd:o.cwd,ledger,plan:state.plan,signal:o.signal},job));
    const observations = run.observations.filter((x): x is Draft => x !== undefined);
    if (run.aborted) return abortWith(ledger,state,observations);
    return ledger.withLock(async () => {
      const latest = await load(ledger); stable(state,latest.state);
      const now = await git.git(o.cwd,['rev-parse','--verify','--quiet','--end-of-options',`refs/heads/${p.trunk}^{commit}`],{allowFail:true});
      if (now.code || now.stdout.trim() !== p.commit) throw new OwedError(`refs/heads/${p.trunk} moved during adopt (was ${p.commit.slice(0,12)}); nothing was recorded, run owed adopt again`);
      const current = prospective(latest,observations), g = adoptGuard(current,sf);
      if (o.signal?.aborted) { if (observations.length) await ledger.append(observations); throw aborted(); }
      if (!g.ok) {
        const appended = observations.length ? await ledger.append(observations) : [];
        // The observation that decides each failing invariant: the one just appended, else (a repeated adopt
        // measures nothing new) the latest existing one at the adopted state's key.
        const seqs = (id: string) => {
          const at = (e: Entry) => e.kind === 'obs' && e.subject === 'trunk' && e.obligation === `inv:${id}` && e.key === sf.invKeys[id];
          const fresh = appended.filter(at), old = latest.entries.findLast(at);
          return (fresh.length ? fresh : old ? [old] : []).map(e => `#${e.seq}`);
        };
        throw new OwedError(`adoption refused: ${g.failed.length ? `invariant${g.failed.length > 1 ? 's' : ''} ${g.failed.map(id => `${id}${seqs(id).length ? ` (obs ${seqs(id).join(', ')})` : ''}`).join(', ')} satisfied on the ledger trunk but not on ${p.commit.slice(0,12)}; fix trunk, then run owed adopt again. ` : ''}${g.reasons.filter(x => !g.failed.some(id => x.startsWith(`invariant ${id} new debt`))).join('; ')}`.replace(/[ ;.]+$/,''));
      }
      const d: Draft = {kind:'adopt',by:by(o),channel:o.channel,trunk:p.trunk,prior:p.prior,commit:p.commit,state:sf,changed:p.changed,commits:p.commits,note:o.note}; guard(current,d);
      const appended = await ledger.append([...observations,d]), allowance = o.as.role === 'parent' ? allowanceSeq(latest.state) : undefined;
      return {...p,entry:appended.at(-1)!,observations:appended.slice(0,-1),...(allowance !== undefined ? { allowance } : {})};
    },undefined,o.signal);
  },'merge',o.signal);
}
export async function status(o: Context): Promise<StatusView> {
  const ledger = await Ledger.open(o.cwd), loaded = await load(ledger), state = inited(reduceFrom(loaded.state,[],loaded.lookup)), entries = loaded.entries;
  await applyReports(ledger,state);
  const view = await summaryStatusView(o.cwd,ledger.dir,state,entries,Date.now());
  const trunkWorktree = await git.trunkElsewhere(o.cwd,state.trunk.name);
  if (view.genesis && await measuringHere(ledger.dir)) view.genesis.measuring = true;
  return {...view,...(trunkWorktree ? {trunkWorktree} : {})};
}
/** NT3: retain only recorded defers for this open attempt and invariants still in the plan. */
function unverifiedDefers(state: State, id: string, defers: State['deferred'], unverified: 'drift' | 'conflict'): DeferredView[] {
  const dispatch = state.nodes[id]?.slot?.dispatchSeq ?? Infinity;
  return defers.filter(d => d.seq > dispatch && state.plan.nodes.some(n => n.id === id) && state.plan.invariants.some(i => i.id === d.id)).map(d => ({...d,unverified}));
}
/** SQ: both status and brief use the same current merge diagnostics and defer scope. */
async function summaryStatusView(cwd: string, dir: string, state: State, entries: Entry[], now: number): Promise<StatusView> {
  const drift = await git.trunkDrift(cwd,state.trunk.name,state.trunk.commit);
  const mergeChecks: ItemView[] = [];
  if (!drift) {
    const subjects = new Set(entries.filter((e): e is ObsEntry => e.kind === 'obs' && e.probe === 'trunk' && e.commit === state.trunk.commit).map(e => e.subject));
    for (const id of subjects) mergeChecks.push(...await currentTrunkRedChecks(cwd,state,id));
  }
  const currentDefers: DeferredView[] = [];
  for (const id of new Set(state.deferred.map(d => d.node))) {
    const n = state.nodes[id], defers = state.deferred.filter(d => d.node === id);
    if (!n?.slot?.open || !n.candidate || n.merged) {
      currentDefers.push(...defers.filter(d => state.invariants.some(i => i.key === d.key && i.obligation === `inv:${d.id}` && i.mark === '⏸' && i.evidence.includes(d.seq))));
      continue;
    }
    if (drift) { currentDefers.push(...unverifiedDefers(state,id,defers,'drift')); continue; }
    const built = await git.buildMerge(cwd,state.trunk.commit,n.candidate.commit,`owed merge ${id}`);
    if ('conflicts' in built) { currentDefers.push(...unverifiedDefers(state,id,defers,'conflict')); continue; }
    const m = await mergeFacts(cwd,state,id,built.commit), guard = mergeGuard(state,id,m);
    currentDefers.push(...defers.filter(d => guard.invItems.some(i => i.key === d.key && i.obligation === `inv:${d.id}` && i.mark === '⏸' && i.evidence.includes(d.seq))));
  }
  const lock = readLock(dir), driverRunning = lock.state === 'live' || lock.state === 'foreign';
  const view = statusView(state,entries,mergeChecks,now,driverRunning,currentDefers);
  await applyMergeWaiting(dir, state, view);
  const pendingBases: NonNullable<StatusView['rebasePending']> = {};
  for (const id of Object.keys(state.nodes)) {
    const r = await rebasePending(state, id);
    if (!r) continue;
    pendingBases[id] = r;
    const progress = view.summary?.progress.find(p => p.node === id);
    if (progress) progress.phase = rebasePendingText(r);
  }
  if (Object.keys(pendingBases).length) view.rebasePending = pendingBases;
  if (drift && view.summary) view.summary.needs.unshift({ node:'trunk', reason:driftText(drift), command:drift.relation === 'ahead' ? 'owed adopt --note "<why>"' : 'owed why trunk' });
  return {...view,...(drift ? {drift} : {})};
}
/** Read-only merge diagnostics: Git supplies the current key; probes alone never create an item. */
async function currentTrunkRedChecks(cwd: string, s: State, id: string): Promise<ItemView[]> {
  const n = s.nodes[id], entries = entriesOf(s);
  if (!n?.slot?.open || !n.candidate || n.merged || n.items.some(i => i.detail.startsWith('trunk-red:')) || !entries.some(e => e.kind === 'obs' && e.subject === id && e.probe === 'trunk' && e.commit === s.trunk.commit) || !entries.some(e => e.kind === 'obs' && e.subject === id && e.merging === id && e.verdict === 'fail' && trunkRedOf(s,e.seq,e.key))) return [];
  if (await git.trunkDrift(cwd,s.trunk.name,s.trunk.commit)) return [];
  const built = await git.buildMerge(cwd,s.trunk.commit,n.candidate.commit,`owed merge ${id}`);
  if ('conflicts' in built) return [];
  const m = await mergeFacts(cwd,s,id,built.commit);
  return mergeGuard(s,id,m).nodeItems.flatMap(i => {
    if (i.status !== 'D' || !i.obligation.startsWith('check:')) return [];
    const hints = i.evidence.flatMap(seq => trunkRedHint(s,seq,i.key) ?? []);
    return hints.length ? [{...i,discharger:'parent' as const,detail:[...new Set(hints)].join('; ')}] : [];
  });
}
/** FH: hints for persisted failures on current merge keys, including invariants without node execution blocks. */
async function hintedMergeChecks(cwd: string, s: State, id: string, existing: ItemView[]): Promise<ItemView[]> {
  const n = s.nodes[id], entries = entriesOf(s);
  if (!n?.slot?.open || !n.candidate || n.merged || !entries.some(e => e.kind === 'obs' && (e.merging === id || e.obligation.startsWith('inv:')) && e.verdict === 'fail' && (e.failed?.length || (e.merging === id && e.obligation.startsWith('inv:'))))) return existing;
  if (await git.trunkDrift(cwd,s.trunk.name,s.trunk.commit)) return existing;
  const built = await git.buildMerge(cwd,s.trunk.commit,n.candidate.commit,`owed merge ${id}`);
  if ('conflicts' in built) return existing;
  const g = mergeGuard(s,id,await mergeFacts(cwd,s,id,built.commit)), out = [...existing];
  for (const i of [...g.nodeItems, ...g.invItems]) {
    if (i.status !== 'D') continue;
    // Invariant verdicts belong to the trunk/key and can come from another node's merge.
    const failures = entries.filter((e): e is ObsEntry => e.kind === 'obs' && (e.merging === id || i.obligation.startsWith('inv:')) && e.subject === i.subject && e.obligation === i.obligation && e.key === i.key && i.evidence.includes(e.seq));
    const hints = mergeFailureHints(s,id,failures);
    if (!hints.length) continue;
    const at = out.findIndex(x => x.subject === i.subject && x.obligation === i.obligation && x.key === i.key), prior = out[at] ?? i;
    const hinted = {...prior,detail:[prior.detail, ...hints].join('; ')};
    if (at < 0) out.push(hinted); else out[at] = hinted;
  }
  return out;
}
export async function why(o: Context & {node:string}): Promise<ReceiptCard> {
  const ledger = await Ledger.open(o.cwd), {state,entries,lookup} = await load(ledger);
  if (o.node === 'trunk' && !state.nodes.trunk) {
    const reds = trunkInvariantReds(state);
    return { node:'trunk', phase:'merged', accepted:state.invariants.every(i => i.status !== 'D'), items:state.invariants.map(i => ({ ...i, ...templateReceiptRun(state,i), detail:reds.find(r => r.obligation === i.obligation)?.text ?? i.detail, observations:entries.filter(e => i.evidence.includes(e.seq)) })), blocks:[], untested:[], ownerFlags:[], downgrades:[] };
  }
  if (o.node.startsWith('inv:') || (!state.nodes[o.node] && state.plan.invariants.some(i => i.id === o.node))) {
    const id = invariantId(state.plan,o.node), item = state.invariants.find(i => i.obligation === `inv:${id}`)!;
    return { node: `inv:${id}`, phase: 'merged', accepted: item.status !== 'D', items: [{ ...item, ...templateReceiptRun(state,item), observations: entries.filter(e => item.evidence.includes(e.seq)) }], blocks: [], untested: [], ownerFlags: [], downgrades: [] };
  }
  const view = reduceFrom(state,[],lookup); await applyReports(ledger,view);
  node(view,o.node);
  const mergeChecks = await currentTrunkRedChecks(o.cwd,view,o.node);
  const card = receipt(view,entries,o.node,await hintedMergeChecks(o.cwd,view,o.node,mergeChecks));
  const pending = await rebasePending(view, o.node);
  if (pending) card.rebasePending = pending;
  await applyModels(ledger,view,entries,o.node,card);
  return card;
}
/** DR2: a missing/corrupt busy file cannot create acceptance evidence or hide a gate. */
async function applyMergeWaiting(dir: string, state: State, view: StatusView): Promise<void> {
  try {
    const busy = JSON.parse(await readFile(join(dir,'drive','waiting.json'),'utf8')) as NonNullable<StatusView['mergeWaiting']>;
    const current: NonNullable<StatusView['mergeWaiting']> = {};
    for (const [id, wait] of Object.entries(busy)) {
      const n = state.nodes[id];
      if (!n?.slot?.open || n.merged || wait.attempt !== n.slot.attempt || wait.candidate !== n.candidate?.seq || typeof wait.reason !== 'string' || !Number.isFinite(Date.parse(wait.since))) continue;
      current[id] = wait;
      const progress = view.summary?.progress.find(p => p.node === id);
      if (progress && n.candidate) progress.phase = `${n.accepted ? 'merge' : 'measure'} waiting for ${oneLine(wait.reason)} since ${new Date(wait.since).toISOString().slice(11,16)}`;
    }
    if (Object.keys(current).length) view.mergeWaiting = current;
  } catch { /* cache miss */ }
}
/** DR3: compare used models only; a pool label/selected model never counts as observed evidence. */
async function applyModels(ledger: Ledger, state: State, entries: Entry[], id: string, card: ReceiptCard): Promise<void> {
  const n = state.nodes[id]!, attempt = n.slot?.attempt;
  const launches = n.runs.find(r => r.attempt === attempt)?.launches ?? [];
  const submit = entries.findLast((e): e is SubmitEntry => e.kind === 'submit' && e.node === id && e.attempt === attempt && e.carry === undefined);
  const reviews = entries.filter((e): e is import('./types.ts').ReviewEntry => e.kind === 'review' && e.node === id && e.attempt === attempt && e.key === n.candidate?.keys[e.obligation]);
  if (!launches.length && !submit?.model && !reviews.some(e => e.model)) return;
  const writer = submit?.model, reviewer = reviews.at(-1)?.model;
  card.models = `writer ${writer ?? 'model unknown'} · reviewer ${reviewer ?? 'model unknown'}`;
  const warnings: string[] = [];
  if (writer && reviewer && writer === reviewer) warnings.push("reviewer used the writer's model");
  const { driveReviewerSlot, reviewerBase } = await import('./reducer.ts');
  for (const [role, used, principal] of [['writer', writer, n.slot?.writer], ['reviewer', reviewer, reviews.at(-1)?.by]] as const) {
    if (!used) continue;
    const k = role === 'reviewer' && principal ? driveReviewerSlot(principal,id,attempt!) : undefined;
    const l = launches.findLast(l => l.role === role && (role === 'writer' || (k !== undefined && Number(l.rid.split(':').at(-1)) === reviewerBase(state,id) + k)));
    if (!l) continue;
    try {
      const spec = JSON.parse((await ledger.getBlob(l.spec)).toString()) as { model?: unknown };
      const selected = typeof spec.model === 'string' ? spec.model : Array.isArray(spec.model) && typeof spec.model[0] === 'string' ? spec.model[0] : undefined;
      if (selected && selected !== used) warnings.push(`model used ${used} differs from the one selected ${selected}`);
    } catch { /* missing launch selection is unknown, not a guessed mismatch */ }
  }
  if (warnings.length) card.modelWarnings = [...new Set(warnings)];
}
/** FL3: private runtime receipts, never acceptance evidence or ledger entries. A missing file is a cache miss. */
export async function applyReports(ledger: Ledger, state: State): Promise<void> {
  try {
    const reports = JSON.parse(await readFile(join(ledger.dir,'drive','reports.json'),'utf8')) as Record<string, number>;
    for (const [id, seq] of Object.entries(reports)) if (reportRequest(state,id)?.resume === seq) state.nodes[id]!.reported = seq;
  } catch { /* optional runtime cache; the driver can re-derive it from the sealed run */ }
}
export async function recordReport(ledger: Ledger, node: string, resume: number): Promise<void> {
  await ledger.withLock(async () => {
    const { state } = await load(ledger);
    if (reportRequest(state,node)?.resume !== resume) return;
    const dir = join(ledger.dir,'drive'), file = join(dir,'reports.json');
    let reports: Record<string, number> = {};
    try { reports = JSON.parse(await readFile(file,'utf8')); } catch { /* first report */ }
    reports[node] = resume; await mkdir(dir,{ recursive:true });
    const temp = join(dir,`.reports.${randomUUID()}.tmp`);
    try { await writeFile(temp,JSON.stringify(reports)); await rename(temp,file); } finally { await unlink(temp).catch(() => undefined); }
  });
}
/** MT: ledger entries and recorded plan blobs only; no repository or run-state query. */
export async function reportMetrics(o: Context & MetricsWindow): Promise<Metrics> {
  const since = metricsBound(o.since,'since'), until = metricsBound(o.until,'until');
  const {state,entries,lookup} = await load(await Ledger.open(o.cwd)); inited(state);
  return computeMetrics(entries,new Map(planShas(entries).map(sha => [sha,lookup(sha)])),{since,until});
}

export async function report(o: Context & {since?:number|string}): Promise<Report> {
  const {state,entries,lookup} = await load(await Ledger.open(o.cwd)), since = o.since ?? -1; inited(state);
  if (typeof since === 'string' && !Number.isFinite(Date.parse(since))) throw new OwedError('since must be a seq or ISO timestamp','usage');
  const included = (e: {seq:number;ts?:string}) => typeof since === 'number' ? e.seq > since : Date.parse(e.ts ?? entries[e.seq]?.ts ?? '') > Date.parse(since);
  const recent = entries.filter(included), before = reduce(entries.filter(e => !included(e)),lookup), old = [...Object.values(before.nodes).flatMap(n => n.items),...before.invariants];
  const items = [...Object.values(state.nodes).flatMap(n => n.items),...state.invariants];
  const receipts = entries.filter((e): e is EvidenceEntry => e.kind === 'evidence' && e.merge !== undefined && included(e));
  const superseded = supersededOf(state,Object.values(state.nodes)).filter(b => included({seq:b.supersededBy}));
  return {...(knownRedDebt(state).knownRed ? {knownRed:knownRedDebt(state).knownRed} : {}),...(quarantineDebt(state).length ? {quarantine:quarantineDebt(state).map(quarantineText)} : {}),...(receipts.length ? {receipts} : {}),...(superseded.length ? {superseded} : {}),escapes:escapeSummary(state),since,merges:recent.filter(e => e.kind === 'merge'),waivers:recent.filter(e => e.kind === 'waive'),blocks:Object.keys(state.nodes).flatMap(id => receipt(state,entries,id).blocks).filter(included),downgrades:state.downgrades.filter(included),rulings:state.rules.filter(included),decisions:items.filter(i => i.status === 'D' && i.discharger === 'owner'),ownerActions:recent.filter(e => e.by.startsWith('owner:') && e.kind !== 'adopt'),adoptions:state.adoptions.filter(included),halts:entries.filter((e): e is HaltEntry => e.kind === 'halt').map(e => ({...e,active:halted(state,e.node)?.seq === e.seq})).filter(e => e.active || included(e)),changes:items.filter(i => !state.nodes[i.subject]?.merged).flatMap(i => { const prev = old.find(p => p.subject === i.subject && p.obligation === i.obligation); return prev?.status === i.status && prev.key === i.key ? [] : [{subject:i.subject,obligation:i.obligation,before:prev?.status,after:i.status}]; })};
}
/**
 * Verifies the hash chain and replays the ledger. N4: never reads the plan caches; every plan is parsed from its YAML
 * blob and reads each persistent cache entry raw: one of another version is rewritten silently; one of this version
 * whose sha or plan disagrees with the blob, or an unreadable or non-JSON file, is reported in `cacheMismatch` (not a
 * failure) and rewritten.
 */
export async function verify(o: Context): Promise<VerifyResult> {
  try {
    const ledger = await Ledger.open(o.cwd), entries = await ledger.read(), plans = new Map<string, Plan>(), cacheMismatch: string[] = [];
    for (const sha of planShas(entries)) {
      const p = parsePlan((await ledger.getBlob(sha)).toString()), c = await ledger.rawPlanCache(sha);
      plans.set(sha, p);
      if (c.state === 'missing') continue;
      // Another version is a stale entry (rewritten silently); corruption or other content under this version is reported.
      const report = c.state === 'corrupt' || (c.v === PLAN_CACHE_VERSION && (c.sha !== sha || canonical(c.plan) !== canonical(p)));
      if (report) cacheMismatch.push(sha);
      if (report || c.v !== PLAN_CACHE_VERSION) await ledger.writePlanCache(sha, p);
    }
    const lookup = (sha: string): Plan => { const p = plans.get(sha); if (!p) throw new OwedError(`Missing plan ${sha}`, 'internal'); return p; };
    // G1.4: the result is the full replay; a disk snapshot that matches the chain is compared with it at its seq, and
    // deleted (reported) when they differ.
    const snap = await ledger.readSnapshot();
    let state: State, snapshotMismatch: number | undefined;
    if (snap && entries[snap.seq]?.hash === snap.hash) {
      state = reduce(entries.slice(0,snap.seq+1),lookup);
      let same = false;
      try { same = sameReplay(unpackState(deserialize(snap.payload) as PackedState,lookup),state); } catch { same = false; }
      if (!same) { await invalidateReplay(ledger); snapshotMismatch = snap.seq; }
      extendState(state,entries.slice(snap.seq+1));
    } else state = reduce(entries,lookup);
    return { ok:true, entries:entries.length, head:state.head, ...(cacheMismatch.length ? { cacheMismatch } : {}), ...(snapshotMismatch !== undefined ? { snapshotMismatch } : {}) };
  } catch (e) { return {ok:false,entries:0,error:e instanceof Error ? e.message : String(e),...(e instanceof OwedError && e.code === 'version' ? { code:'version' as const } : {})}; }
}
/** Morning brief: owner decisions, merges since `since` (seq or ISO time), active blocks, work in progress and totals. */
export async function brief(o: Context & {since?:number|string; now?:number}): Promise<Brief> {
  const ledger = await Ledger.open(o.cwd), loaded = await load(ledger), state = reduceFrom(loaded.state,[],loaded.lookup), entries = loaded.entries, lookup = loaded.lookup, since = o.since ?? -1; inited(state);
  await applyReports(ledger,state);
  if (typeof since === 'string' && !Number.isFinite(Date.parse(since))) throw new OwedError('since must be a seq or ISO timestamp','usage');
  const now = o.now ?? Date.now(), view = await summaryStatusView(o.cwd,ledger.dir,state,entries,now);
  return {...briefView(state,entries,since,now,mergeCoverage(entries,lookup),undefined,view.summary),...(view.deferred ? {deferred:view.deferred} : {})};
}

// ---------- driver entries (SPEC §12, D3): persisted before the dsa call ----------
/**
 * Records the intent to start a dsa run (role parent; the driver is `parent:drive`). `spec` is the exact spec JSON
 * bytes, stored as a blob. Idempotent: a launch already recorded with the same rid, node, attempt, role, spec bytes
 * and labels is returned with `created: false`; a different one is refused (a request conflict). `rulings` (E4) is
 * recorded on a new entry only; a recorded entry keeps its own value. `since` (F1): the seq of the state the driver
 * decided on; a later non-driver entry naming the node refuses with code `stale` (`decidedOn`), also for a recorded launch.
 */
export async function launch(o: Actor & { node: string; attempt: number; role: RunRole; rid: string; spec: string; labels: Record<string, string>; rulings?: number; since?: number }): Promise<{ entry: LaunchEntry; created: boolean }> {
  owner(o); const ledger = await Ledger.open(o.cwd), spec = await ledger.putBlob(o.spec);
  return ledger.withLock(async () => {
    const { state, entries } = await load(ledger);
    decidedOn(entries, o.node, o.since);
    const dispatched = entries.some(e => e.kind === 'dispatch' && e.node === o.node && e.attempt === o.attempt);
    if (by(o) === DRIVER && dispatched && (!state.plan.nodes.some(n => n.id === o.node) || state.nodes[o.node]?.held !== undefined || !state.nodes[o.node]?.slot?.open || state.nodes[o.node]?.slot?.attempt !== o.attempt)) throw new OwedError(`stale: writer slot of ${o.node} attempt ${o.attempt} was removed, held or abandoned; nothing launched`, 'stale');
    const prior = entries.find((e): e is LaunchEntry => e.kind === 'launch' && e.rid === o.rid);
    if (prior) {
      if (prior.node !== o.node || prior.attempt !== o.attempt || prior.role !== o.role || prior.spec !== spec || canonical(prior.labels) !== canonical(o.labels)) throw new OwedError(`launch ${o.rid} is already recorded (#${prior.seq}) with other content`);
      return { entry: prior, created: false };
    }
    const d: Draft = { kind: 'launch', by: by(o), channel: o.channel, node: o.node, attempt: o.attempt, role: o.role, rid: o.rid, spec, labels: o.labels, ...(o.rulings !== undefined ? { rulings: o.rulings } : {}) };
    guard(state, d); return { entry: (await ledger.append([d]))[0] as LaunchEntry, created: true };
  });
}
/** Records the intent to send `message` (exact bytes, stored as a blob) to run `rid`; the send id `${rid}:${sendKind}:${seq}` is assigned under the lock. `since`: as for launch (F1). */
export async function send(o: Actor & { node: string; attempt: number; rid: string; sendKind: SendKind; message: string; reason: SendReason; rulings?: number; since?: number }): Promise<SendEntry> {
  owner(o); const ledger = await Ledger.open(o.cwd), message = await ledger.putBlob(o.message);
  return ledger.withLock(async () => {
    const { state, entries } = await load(ledger);
    decidedOn(entries, o.node, o.since);
    const d: Draft = { kind: 'send', by: by(o), channel: o.channel, node: o.node, attempt: o.attempt, rid: o.rid, send: `${o.rid}:${o.sendKind}:${state.seq + 1}`, sendKind: o.sendKind, message, reason: o.reason, ...(o.rulings !== undefined ? { rulings: o.rulings } : {}) };
    guard(state, d); return (await ledger.append([d]))[0] as SendEntry;
  });
}
/**
 * 0.8 (L1): records `resume` on the open attempt of `node` (parent or owner): it clears a driver halt without an
 * obligation and starts a new repair epoch; with `after` the node waits until that node merges. `merged`: `after` is
 * already merged (the node resumes now).
 */
type ResumeArgs = Actor & { node: string; after?: string | string[]; expect?: 'report'; note?: string; /** MS2 */ remeasure?: boolean };
/** ED2/FL2/FL3: both commands draft and normalize resume against their prospective state under the ledger lock. */
function resumeDraft(o: ResumeArgs, s: State): Extract<Draft, { kind:'resume' }> {
  if (o.as.role !== 'parent' && o.as.role !== 'owner') throw new OwedError(`resume insufficient permissions; requires parent/owner (got ${o.as.role})`);
  const n = node(s,o.node);
  if (!n.slot?.open && n.held !== undefined) {
    if (o.after !== undefined || o.expect !== undefined || o.remeasure) throw new OwedError('hold release does not take --after, --expect or --remeasure; dispatch a new attempt first', 'usage');
    return { kind:'resume', by:by(o), channel:o.channel, node:o.node, attempt:n.slot!.attempt, release:'hold', ...(o.note ? { note:o.note } : {}) };
  }
  if (!n.slot?.open) throw new OwedError(`resume requires an open slot of ${o.node}; ${o.node} has none`);
  const unruled = unruledBlocks(s,o.node);
  if (unruled.length) throw new OwedError(`resume refused: ${o.node} needs a parent ruling (review block ${unruled.map(x => `#${x.seq} ${x.obligation}`).join(', ')}), so the driver would halt again at once; record it with owed rule --nodes ${o.node} "<decision>" (the ruling also clears the halt)`);
  const after = o.after === undefined ? undefined : typeof o.after === 'string' && !o.after.includes(',') ? o.after : [...new Set(afterNodes(o.after).flatMap(x => x.split(',')).map(x => x.trim()))];
  return { kind:'resume', by:by(o), channel:o.channel, node:o.node, attempt:n.slot.attempt, ...(after !== undefined ? { after } : {}), ...(o.expect !== undefined ? { expect:o.expect } : {}), ...(o.note !== undefined && o.note !== '' ? { note:o.note } : {}), ...(o.remeasure ? { remeasure:true as const } : {}) };
}
export interface ResumeResult { entry: Entry; merged?: boolean; entries?: Entry[] }
/** PO2: validate the whole batch under one ledger lock before any append. */
export async function resume(o: Omit<ResumeArgs,'node'> & { node: string | string[] }): Promise<ResumeResult> {
  const ids = Array.isArray(o.node) ? o.node : o.node.split(',');
  const nodes = [...new Set(ids.map(id => id.trim()))];
  if (!nodes.length || nodes.some(id => !id)) throw new OwedError('resume needs a non-empty node list','usage');
  owner(o); const ledger = await Ledger.open(o.cwd);
  return ledger.withLock(async () => {
    const latest = await load(ledger), drafts: Draft[] = [], first = latest.state.seq+1;
    let merged = false;
    for (const id of nodes) {
      const state = drafts.length ? replayed(latest,drafts) : latest.state;
      const d = resumeDraft({ ...o, node:id },state);
      if (nodes.length > 1) d.batch = first;
      guard(state,d); drafts.push(d);
      const after = afterNodes(d.after);
      merged = !!after.length && after.every(dep => !!state.nodes[dep]?.merged);
    }
    const entries = await ledger.append(drafts);
    return { entry:entries[0]!, ...(merged ? { merged:true } : {}), ...(nodes.length > 1 ? { entries } : {}) };
  });
}
/** Stops the driver on the node's current attempt until a later non-driver entry on the node or a new attempt. `since`: as for launch (F1). */
export async function halt(o: Actor & { node: string; attempt: number; reason: string; needs: 'human' | 'owner'; since?: number }): Promise<HaltEntry> {
  return await mutate(o, () => ({ kind: 'halt', by: by(o), channel: o.channel, node: o.node, attempt: o.attempt, reason: o.reason, needs: o.needs }), { node: o.node, since: o.since }) as HaltEntry;
}

// ---------- owner approval and manual evidence (D23) ----------
/** The candidate an owner confirmed (submit seq and commit): an owner act on a node records only on that candidate. */
export interface CandidatePin { seq: number; commit: string }
/** Refuses when the node's current open candidate is not the confirmed one (D23 review ruling #389). */
function pinned(s: State, id: string, pin?: CandidatePin): void {
  const c = s.nodes[id]?.slot?.open ? s.nodes[id]?.candidate : undefined;
  if (pin && (c?.seq !== pin.seq || c.commit !== pin.commit)) throw new OwedError('candidate changed since confirmation; nothing recorded');
}
/** What the owner approves: the open candidate of `node` (for confirmation dialogs and prompts; no effect). */
/** The open candidate of `node` (submit seq, commit, base, changed-file count) for owner confirmation dialogs (G1.2; no effect). */
export async function candidatePreview(o: Context & { node: string }): Promise<{ node: string; seq: number; commit: string; base: string; changed: number }> {
  const { state } = await load(await Ledger.open(o.cwd)), n = candidate(state,o.node);
  return { node:o.node, seq:n.candidate!.seq, commit:n.candidate!.commit, base:n.slot!.base, changed:n.candidate!.changed.length };
}
export async function approvePreview(o: Context & { node: string }): Promise<{ node: string; seq: number; commit: string; base: string; changed: number }> {
  const { state } = await load(await Ledger.open(o.cwd)), n = candidate(state,o.node);
  if (!state.plan.nodes.find(x => x.id === o.node)?.approve) throw new OwedError(`Node ${o.node} has no approve obligation`);
  return { node:o.node, seq:n.candidate!.seq, commit:n.candidate!.commit, base:n.slot!.base, changed:n.candidate!.changed.length };
}
/**
 * Owner approval (`block`: an owner block) of the open candidate: a `review` entry on obligation `approve`, rank 3.
 * `candidate` (the one the owner confirmed) and `named` (G1: the commit the caller names) refuse at append time when
 * the current candidate differs.
 */
export async function approve(o: Actor & { node: string; note?: string; block?: boolean; candidate?: CandidatePin; named?: string }): Promise<Entry> {
  if (o.as.role !== 'owner') throw new OwedError('approve requires owner');
  const given = candidateArg(o.named);
  return mutate(o,s => {
    node(s,o.node); named(s,o.node,given);
    const n = candidate(s,o.node);
    pinned(s,o.node,o.candidate);
    if (!s.plan.nodes.find(x => x.id === o.node)?.approve) throw new OwedError(`Node ${o.node} has no approve obligation`);
    return { kind:'review',by:by(o),channel:o.channel,node:o.node,attempt:n.slot!.attempt,obligation:'approve',key:n.candidate!.keys.approve ?? '',verdict:o.block ? 'block' : 'ok',rank:3,note:o.note ?? '' };
  });
}
/** Reads and hashes evidence files (relative to cwd); a path inside the repository is stored repository-relative, else absolute. */
export async function evidenceFiles(o: Context & { files: string[] }): Promise<EvidenceFile[]> {
  let top: string | undefined;
  try { top = await realpath(await git.repoRoot(o.cwd)); } catch { /* outside a repository: absolute paths */ }
  const out: EvidenceFile[] = [];
  for (const f of o.files) {
    const file = resolve(o.cwd,f); let data: Buffer;
    try { data = await readFile(file); } catch (e) { throw new OwedError(`cannot read ${f}: ${(e as NodeJS.ErrnoException).code ?? String(e)}`,'usage'); }
    const real = await realpath(file), rel = top === undefined ? '' : relative(top,real);
    out.push({ path:rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel.split(sep).join('/') : real, sha256:sha256(data), bytes:data.length });
  }
  return out;
}
/** Where evidence on `node` would be recorded (no effect): the open candidate, else the latest merge (a receipt). */
export async function evidencePreview(o: Context & { node: string }): Promise<{ node: string; candidate?: CandidatePin & { base: string }; merge?: number }> {
  const { state } = await load(await Ledger.open(o.cwd)), n = node(state,o.node);
  if (n.slot?.open && n.candidate) return { node:o.node, candidate:{ seq:n.candidate.seq, commit:n.candidate.commit, base:n.slot.base } };
  return { node:o.node, ...(n.merged ? { merge:n.merged.seq } : {}) };
}
/**
 * Manual evidence (D23): on a node with an open candidate it records evidence for `evidence:<id>` (files required);
 * on a merged node a receipt citing its latest merge (files optional). Files are hashed now; `expect` (the files a
 * confirmation dialog showed) refuses when they changed since; `candidate` (the candidate it showed) refuses when the
 * current open candidate differs. `named` (G1) records only on an open candidate whose commit starts with it. `from`:
 * further working directories of the calling process for the writer-worktree rail (G2.1, as for review).
 */
export async function evidence(o: Actor & { node: string; id: string; files: string[]; note: string; expect?: EvidenceFile[]; candidate?: CandidatePin; named?: string; from?: string[] }): Promise<EvidenceEntry> {
  if (typeof o.note !== 'string' || !o.note.trim()) throw new OwedError('evidence requires a note','usage');
  const given = candidateArg(o.named);
  const files = await evidenceFiles({ cwd:o.cwd, files:o.files });
  if (o.expect && canonical(o.expect) !== canonical(files)) throw new OwedError('evidence files changed since they were confirmed; nothing was recorded');
  return await mutate(o,async s => {
    const n = node(s,o.node);
    named(s,o.node,given);
    pinned(s,o.node,o.candidate);
    await writerTree(s,o.node,[o.cwd,process.cwd(),...(o.from ?? [])]);
    if (n.merged && !n.slot?.open) return { kind:'evidence',by:by(o),channel:o.channel,node:o.node,merge:n.merged.seq,id:o.id,files,note:o.note };
    const c = candidate(s,o.node);
    return { kind:'evidence',by:by(o),channel:o.channel,node:o.node,attempt:c.slot!.attempt,key:c.candidate!.keys[`evidence:${o.id}`] ?? '',id:o.id,files,note:o.note };
  }) as EvidenceEntry;
}

// ---------- escapes and decoys ----------
export async function escape(o: Actor & { node:string; merge:number; class:EscapeClass; note:string; evidence?:string }): Promise<Entry> { return mutate(o,() => ({kind:'escape',by:by(o),channel:o.channel,node:o.node,merge:o.merge,class:o.class,note:o.note,evidence:o.evidence})); }
/** Parses a reveal payload file; only {nonce, decoys:[{node, defect}]} is kept. */
export function decoyPayload(text: string): DecoyPayload {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new OwedError('decoy file must be JSON {nonce, decoys:[{node, defect}]}','usage'); }
  const errors = decoyPayloadErrors(value); if (errors.length) throw new OwedError(errors.join('; '),'usage');
  const p = value as DecoyPayload; return { nonce:p.nonce, decoys:p.decoys.map(x => ({node:x.node,defect:x.defect})) };
}
/** Helper: the digest to commit for a reveal payload. Writes nothing. */
export function decoyDigest(text: string): { digest: string } { return { digest:digestOf(decoyPayload(text)) }; }
export async function decoyCommit(o: Actor & { digest:string; channel:Channel }): Promise<Entry> { return mutate(o,() => ({kind:'decoy-commit',by:by(o),channel:o.channel,digest:o.digest})); }
export async function decoyReveal(o: Actor & { payload:string; channel:Channel }): Promise<Entry> { const p = decoyPayload(o.payload); return mutate(o,() => ({kind:'decoy-reveal',by:by(o),channel:o.channel,...p})); }
// ---------- gc: reclaim worktrees and branches of finished attempts (SPEC §8) ----------
import { realpath, stat } from 'node:fs/promises';
export interface GcItem { node: string; attempt: number; worktree: string | null; branch: string | null; pinned: string[] }
export interface GcKept { node: string; attempt: number; worktree: string; branch: string; reason: string }
/** M2: a reused measurement tree gc removed (or, with dry run, would remove), or kept, and why. */
export interface GcTree { path: string; reason: string }
/** `trees`/`treesKept` (M2): reused measurement trees removed and kept; present only when non-empty. */
/** `planCache` (N4): plan cache files removed (dry run: that would be removed) because the ledger no longer names their sha. */
export interface GcResult { dryRun: boolean; removed: GcItem[]; kept: GcKept[]; trees?: GcTree[]; treesKept?: GcTree[]; planCache?: string[]; entry?: Entry }
async function real(path: string): Promise<string> { try { return await realpath(path); } catch { return resolve(path); } }
async function exists(path: string): Promise<boolean> { try { await stat(path); return true; } catch { return false; } }
/** Ref that keeps the commit of submit entry `seq` reachable after its branch is deleted (attribution reruns need it). */
export const keepRef = (node: string, attempt: number, seq: number): string => `refs/owed/keep/${node}/${attempt}/${seq}`;
export async function gc(o: Context & { dryRun?: boolean; as?: Principal; channel?: Channel }): Promise<GcResult> {
  const actor: Actor = { cwd: o.cwd, as: o.as ?? { role: 'parent', id: 'cli' }, channel: o.channel }, dryRun = !!o.dryRun;
  owner(actor); if (!['owner','parent'].includes(actor.as.role)) throw new OwedError('gc requires parent/owner');
  // Run git from the main worktree: cwd may be (inside) a worktree that gc removes. Resolved before any effect.
  const root = await git.mainRoot(o.cwd), ledger = await Ledger.open(o.cwd);
  // The dispatch lock serializes gc with worktree/branch creation by dispatch.
  return ledger.withLock(async () => {
    const { state, entries } = await load(ledger); inited(state);
    const openTrees = await Promise.all(Object.values(state.nodes).filter(n => n.slot?.open).map(n => real(n.slot!.worktree)));
    // Stale registrations (directory deleted by hand) would otherwise pin their branches.
    if (!dryRun) await git.git(root, ['worktree', 'prune']);
    // M2: reused measurement trees are never slots; they are handled after the attempts below.
    const reuseRoot = await real(await git.reuseDir(root)), reused = (p: string) => p.startsWith(`${reuseRoot}${sep}`);
    const trees = (await Promise.all((await git.listWorktrees(root)).filter(w => !w.prunable).map(async w => ({ ...w, path: await real(w.path) })))).filter(w => !reused(w.path));
    const removed: GcItem[] = [], kept: GcKept[] = [];
    for (const d of entries) {
      if (d.kind !== 'dispatch') continue;
      const keep = (reason: string) => { kept.push({ node: d.node, attempt: d.attempt, worktree: d.worktree, branch: d.branch, reason }); };
      const path = await real(d.worktree), tree = trees.find(w => w.path === path), hasBranch = await git.branchExists(root, d.branch), onDisk = await exists(d.worktree);
      const slot = state.nodes[d.node]?.slot;
      if (slot?.open && slot.attempt === d.attempt) { if (tree || hasBranch || onDisk) keep('open writer slot'); continue; }
      if (tree?.locked) { keep('worktree is locked'); continue; }
      // A worktree nested by an older dispatch inside this one would be deleted with it.
      const inner = [...openTrees, ...trees.map(w => w.path)].find(p => p !== path && p.startsWith(`${path}/`));
      if (onDisk && inner) { keep(`contains worktree ${inner}`); continue; }
      if (tree && !await git.isClean(tree.path)) { keep('worktree is dirty (uncommitted or untracked changes)'); continue; }
      // Pin every submitted commit that trunk does not already reach, before its branch can go.
      const pins: { ref: string; commit: string }[] = []; let lost = '';
      for (const e of entries) if (e.kind === 'submit' && e.node === d.node && e.attempt === d.attempt) {
        const ref = keepRef(d.node, d.attempt, e.seq), commit = e.facts.commit;
        if ((await git.git(root, ['rev-parse', '--verify', '--quiet', ref], { allowFail: true })).code === 0) continue;
        if ((await git.git(root, ['cat-file', '-e', `${commit}^{commit}`], { allowFail: true })).code) { lost ||= `submitted commit ${commit} (#${e.seq}) is no longer in the repository`; continue; }
        if (!await git.isAncestor(root, commit, state.trunk.commit)) pins.push({ ref, commit });
      }
      if (lost) keep(lost);
      const pinned: string[] = [];
      for (const p of pins) {
        if (!dryRun) { const r = await git.git(root, ['update-ref', p.ref, p.commit, ''], { allowFail: true }); if (r.code) { keep(`git update-ref ${p.ref} failed: ${r.stderr.trim()}`); break; } }
        pinned.push(p.ref);
      }
      if (pinned.length !== pins.length) { if (pinned.length) removed.push({ node: d.node, attempt: d.attempt, worktree: null, branch: null, pinned }); continue; }
      let worktree: string | null = null, branch: string | null = null;
      if (tree) {
        if (!dryRun) { const r = await git.git(root, ['worktree', 'remove', tree.path], { allowFail: true }); if (r.code) { keep(`git worktree remove failed: ${r.stderr.trim()}`); if (pinned.length) removed.push({ node: d.node, attempt: d.attempt, worktree, branch, pinned }); continue; } }
        worktree = d.worktree;
      } else if (onDisk) keep('path exists but is not a registered git worktree; left untouched');
      if (hasBranch) {
        const user = trees.find(w => w.branch === `refs/heads/${d.branch}` && w.path !== path);
        // The recorded name must map back to this attempt alone: another dispatch recording the same name (an ambiguous
        // template of an older plan) may own the branch, so it is kept.
        const others = entries.flatMap(e => e.kind === 'dispatch' && e.branch === d.branch && (e.node !== d.node || e.attempt !== d.attempt) ? [`${e.node}#${e.attempt}`] : []);
        if (user) keep(`branch is checked out in ${user.path}`);
        else if (others.length) keep(`branch name ${d.branch} is also recorded for ${[...new Set(others)].join(', ')}; not deleted`);
        else if (dryRun) branch = d.branch;
        else { const r = await git.git(root, ['branch', '-D', d.branch], { allowFail: true }); if (r.code) keep(`git branch -D failed: ${r.stderr.trim()}`); else branch = d.branch; }
      }
      if (worktree || branch || pinned.length) removed.push({ node: d.node, attempt: d.attempt, worktree, branch, pinned });
    }
    // N4: plan cache entries (and stray temp files) whose sha the ledger no longer names; nothing is recorded for them.
    // Temp files only once older than 60 s: a younger one may be a write in progress.
    const named = new Set(planShas(entries).map(sha => `${sha}.json`)), now = Date.now(), planCache: string[] = [];
    for (const f of await ledger.planCacheFiles()) if (!named.has(f) && (!f.endsWith('.tmp') || now - (await ledger.planCacheMtime(f) ?? now) > 60_000)) planCache.push(f);
    if (!dryRun) for (const f of planCache) await ledger.removePlanCache(f);
    const t = await gcTrees(root,state,dryRun), extra = { ...(t.trees.length ? { trees:t.trees } : {}), ...(t.kept.length ? { treesKept:t.kept } : {}), ...(planCache.length ? { planCache } : {}) };
    if (dryRun || !removed.length) return { dryRun, removed, kept, ...extra };
    await git.git(root, ['worktree', 'prune']);
    const text = `gc removed ${removed.map(i => `${i.node}#${i.attempt} (${[i.worktree && `worktree ${i.worktree}`, i.branch && `branch ${i.branch}`, ...i.pinned.map(r => `pinned ${r}`)].filter(Boolean).join(', ')})`).join('; ')}`;
    const entry = await ledger.withLock(async () => { const current = (await load(ledger)).state; const d: Draft = { kind: 'note', by: by(actor), channel: actor.channel, text }; guard(current, d); return (await ledger.append([d]))[0]!; });
    return { dryRun, removed, kept, ...extra, entry };
  }, 'dispatch');
}
/**
 * M2: reused measurement trees gc removes: those whose lease is free when the plan no longer sets `exec.trees: reuse`,
 * or when their check id is gone (an `inv` tree: no invariant of that id; other kinds: no node check of that id). A
 * tree whose lease a live process holds is kept. `dryRun` only reports.
 * F2.5: a node check's tree also goes when every plan node with that check is finished: merged, or abandoned (its
 * slot closed) without an open slot. Invariant trees follow the invariants only.
 */
async function gcTrees(root: string, state: State, dryRun: boolean): Promise<{ trees: GcTree[]; kept: GcTree[] }> {
  const plan = state.plan, reuse = plan.exec?.trees === 'reuse', inv = new Set(plan.invariants.map(c => git.treeId(c.id))), checks = new Set(plan.nodes.flatMap(n => n.checks.map(c => git.treeId(c.id))));
  const finished = (id: string): boolean => { const n = state.nodes[id]; return !!n && (!!n.merged || (!!n.slot && !n.slot.open)); };
  const live = new Set(plan.nodes.filter(n => !finished(n.id)).flatMap(n => n.checks.map(c => git.treeId(c.id))));
  const trees: GcTree[] = [], kept: GcTree[] = [];
  // Reclaim tokens older than 1 h and take temp files older than 60 s: their process crashed (SPEC §7.12).
  for (const path of await git.staleTokens(root,dryRun)) trees.push({ path, reason:/\.tmp-[^/]+$/.test(path) ? 'stale lease temp file' : 'stale lease reclaim token' });
  for (const t of await git.reusedTrees(root)) {
    const gone = !(t.kind === 'inv' ? inv : checks).has(t.id), done = t.kind !== 'inv' && !gone && !live.has(t.id);
    if (reuse && !gone && !done) continue;
    const reason = !reuse ? 'the plan does not set exec.trees: reuse' : done ? `check ${t.id} belongs only to merged or abandoned nodes` : `${t.kind === 'inv' ? 'invariant' : 'check'} ${t.id} is gone`;
    if (!t.free || (!dryRun && !await git.removeReusedTree(root,t.path))) { kept.push({ path:t.path, reason:'lease held by a running measurement' }); continue; }
    trees.push({ path:t.path, reason });
  }
  return { trees, kept };
}
