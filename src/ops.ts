import { open as openFile, readFile, mkdir, appendFile, rmdir, writeFile, rename, unlink, chmod, truncate } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { serialize, deserialize } from 'node:v8';
import { performance } from 'node:perf_hooks';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { stringify, parseDocument, isMap, isSeq, isScalar, type YAMLMap } from 'yaml';
import { canonical, sha256 } from './canon.ts';
import { Ledger, PLAN_CACHE_VERSION, entryHash, lockActivityText, lockWait, type LockOwner } from './ledger.ts';
import { withLockDeadline } from './lock-deadline.ts';
import { adoptWaitMs, withAdoptPending, pendingAdopt, adoptPendingReason } from './adopt-wait.ts';
import { rebasePending, rebasePendingText, slotGitInProgress, slotGitOperation, rebaseRecovery, trunkUpstream } from './rebase-view.ts';
import { planReceipt, renderEntry, withActHistory, withPresentationState, mergedLine, receiptItem, nodeNext } from './views.ts';
import * as git from './git.ts';
import { driveConfig, quarantineNames, parsePlan, planDowngrades, worktreesConfig, expandBranch, worktreesErrors, nodeIdCaseErrors, execEnvErrors, invariantId, planWarnings } from './plan.ts';
import { applicableRules, genesisProgress, refreshChanged, trunkJobs, trunkInvariantReds, jobCurrent, invalidates, planAt, carryable, DRIVER, entriesOf, afterNodes, reportRequest } from './reducer.ts';
import { mergeTreeBreaks, carriedDefer, sharedFailure, sharedNames, NAME_ONLY, sharedParked, sharedBoundText, allowanceDeferDraft, reviewCarrySource, type SharedPark, ruleAnswers, decisionTailErrors, decisionInFlight } from './reducer.ts';
import { Dsa } from './dsa.ts';
import { reduce, reduceFrom, extendState, packState, unpackState, sameReplay, retainedPlanValues, interpretedEntry, newerEntry, type PackedState } from './reducer.ts';
import { writesEntryError, writesSyntaxErrors, withWritesSyntax, writesSyntax, writeCovers } from './writes.ts';
import { validateDraft, openBatch, attestJobs, genesisJobs, mergeJobs, mergeGuard, adoptJobs, adoptGuard, decoyDigest as digestOf, decoyPayloadErrors, overlapping, withinWrites, grantsOf, grantHint, halted, manualKeys, adoptPrefixes, unadoptable, allowanceSeq, activeRisk, mergeRisk, trackedRiskRetry, trunkRedOf, stateQuarantine, quarantinedJob, remeasureJobs, trunkRemeasureJobs, writesCovered, writesRefusals, effectiveWritesOverlap, batchable, batchFailed, batchJobs, batchQuarantine, mergeQueue, uncoveredDowngrades } from './reducer.ts';
import { runJob, runCommand, lastLines } from './exec.ts';
import { setupFailure, infraSource, observationsOf, resumeOf } from './reducer.ts';
import { setupHint, setupSignature } from './remeasure-on.ts';
import { withMachineLease, measurementScope, leaseResult, leaseWaitField } from './lease.ts';
import type { Runtime } from './needs.ts';
import { withMeasuring, measuringScope, measuringRunning, measuringJob, assembleRuntime } from './activity.ts';
import { unguardedPaths, mergeCoverage, sweepRed } from './sweep.ts';
export { sweep } from './sweep.ts';
import { unruledBlocks } from './drive.ts';
import { driveStatus, readLock, driveStart, type DriveStart } from './drive-bg.ts';
import { clockTime } from './clock.ts';
import { launchedReviewAck, parentOverlapWarnings } from './parentops.ts';
import { editText, editDiff, type EditFields } from './edit.ts';
import { lintPlanShell, lintPlanCost } from './planlint.ts';
import { costReport, type CostReport } from './cost.ts';
import { computeMetrics, sameModelReviews, metricsBound, type Metrics, type MetricsWindow } from './metrics.ts';
import { counterfactual, type Counterfactual } from './counterfactual.ts';
import { actScope, actContent, type RecordedAct } from './identical-acts.ts';
import { OwedError } from './errors.ts';
import { assertNoLedgerLock } from './lock-context.ts';
import { measurementText, mergeWaitingText, receipt, statusView, escapeSummary, driftText, dispatchPacket, supersededOf, trunkRedHint, mergeFailureHints, knownRedDebt, trackedWaivers, trackedDebtText, oneLine, housekeepingText, templateReceiptRun, reusedHint, quarantineDebt, quarantineText, WRITER_DECISION } from './views.ts';
import type { ReceiptCard, StatusView, Report, DeferredView } from './views.ts';
import { briefView } from './views.ts';
import { waiverText } from './views.ts';
import type { Brief } from './views.ts';
import type { CheckSpec, NodeState, MergeGuard } from './types.ts';
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
export interface VerifyResult { ok: boolean; entries: number; head?: string; error?: string; code?: 'version'; cacheMismatch?: string[]; snapshotMismatch?: number; /** Ruling #2110: the ledger tail holds an incomplete batch merge. */ incompleteBatch?: string }
type Context = { cwd: string };
type MeasurementContext = Context & { lease?: boolean; signal?: AbortSignal; priority?: number };
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
/** IF2: attach under the final ledger lock/private ordered replay, never from a stale measurement snapshot. */
function tagInfra(s: State, d: Draft): void {
  if (d.kind === 'obs') {
    delete d.infra;
    const seq = infraSource(s,d); if (seq !== undefined) d.infra = seq;
  }
}
function guard(s: State, d: Draft): void { tagInfra(s,d); const errors = validateDraft(s,d); if (errors.length) throw new OwedError(errors.join('; ')); }
/**
 * PM1: at most eight deep-frozen parsed plans, LRU by `<owed dir>\0<blob sha>`. Behind the process cache is the
 * persistent cache of the ledger (Ledger.readPlanCache), then the YAML blob.
 */
const planCache = new Map<string, Plan>(), PLAN_CACHE_MAX = 8;
let planHits = 0, planMisses = 0, planEvictions = 0;
/** @internal Parsed-plan LRU diagnostics. */
export function planCacheStats(): { entries: number; max: number; hits: number; misses: number; evictions: number } {
  return { entries: planCache.size, max: PLAN_CACHE_MAX, hits: planHits, misses: planMisses, evictions: planEvictions };
}
/** @internal Forget only parsed plans and their diagnostics, not replay caches. */
export function forgetPlanCache(): void { planCache.clear(); planHits = planMisses = planEvictions = 0; }
function planHit(k: string): Plan | undefined {
  const p = planCache.get(k);
  if (p) { planHits++; planCache.delete(k); planCache.set(k,p); } else planMisses++;
  return p;
}
function rememberPlan(k: string, p: Plan): Plan {
  planCache.delete(k); planCache.set(k,deepFreeze(p));
  if (planCache.size > PLAN_CACHE_MAX) { planCache.delete(planCache.keys().next().value!); planEvictions++; }
  return p;
}
function deepFreeze<T>(v: T): T { if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v)) deepFreeze(x); } return v; }
/** PM1: synchronous resolution and best-effort atomic cache publication, with no pending write retaining the plan. */
function cachedPlanSync(ledger: Ledger, sha: string): Plan {
  const k = `${ledger.dir}\0${sha}`;
  let p = planHit(k);
  if (p) return p;
  const stored = ledger.readPlanCacheSync(sha);
  if (stored) p = stored as Plan;
  else { p = parsePlan(ledger.getBlobSync(sha).toString()); ledger.writePlanCacheSync(sha, p); }
  return rememberPlan(k,p);
}
/** Plan shas the ledger names (genesis and plan entries), in ledger order. */
const planShas = (entries: Entry[]): string[] => [...new Set(entries.flatMap(e => e.kind === 'genesis' || e.kind === 'plan' ? [e.plan] : []))];
/** DF1: unlocked readers hide every member of an incomplete final decision group; locked reads stay strict. */
async function readVisibleEntries(ledger: Ledger): Promise<Entry[]> {
  const read = await ledger.read(), inFlight = ledger.holdsLock() ? undefined : decisionInFlight(read);
  return inFlight === undefined ? read : read.slice(0,inFlight);
}
/**
 * PM2: verified entries, a lazy lookup restricted to plans they (and `extra`) name, and the replayed state.
 * Only the bounded process cache keeps resolved values; neither this closure nor replay preloads the history.
 */
async function load(ledger: Ledger, extra: string[] = []) {
  // Capture before the first await: verification may invalidate this load while the ledger is being read.
  const control = replayControl(ledger.dir), epoch = control.epoch;
  const entries = await readVisibleEntries(ledger), known = new Set([...planShas(entries), ...extra]);
  const lookup = (sha: string): Plan => {
    if (!known.has(sha)) throw new OwedError(`Missing plan ${sha}`, 'internal');
    return cachedPlanSync(ledger, sha);
  };
  // Prospective laws must be readable before any append; only extra is eager, never the full history.
  for (const sha of new Set(extra)) cachedPlanSync(ledger,sha);
  const state = await replay(ledger,entries,lookup,control,epoch);
  // RC: diagnostics and CAS/node scans consume the same semantic entries as the reducer, never unknown fields.
  return { entries:entries.map(interpretedEntry), lookup, state };
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
async function replay(ledger: Ledger, entries: Entry[], lookup: (sha: string) => Plan, control: ReplayControl, epoch: number): Promise<State> {
  if (!entries.length) return reduce(entries,lookup);
  // New loads wait for a pending verify deletion before reading the disk snapshot.
  await control.publication;
  const t0 = performance.now(), at = (seq: number, hash: string): boolean => entries[seq]?.hash === hash;
  let m = memos.get(ledger.dir), state: State | undefined, via: 'memo' | 'disk' | undefined;
  if (!(m && at(m.seq,m.hash))) { const d = await ledger.readSnapshot(); m = d && at(d.seq,d.hash) ? { ...d, disk: d.seq } : undefined; via = 'disk'; } else via = 'memo';
  if (m) state = unpacked(m.payload,lookup);
  if (!state) { m = undefined; via = undefined; }
  const start = state ? state.seq+1 : 0;
  if (state) extendState(state,entries.slice(start)); else state = reduce(entries,lookup);
  const decisionErrors = decisionTailErrors(state); if (decisionErrors.length) throw new OwedError(decisionErrors.join('; '));
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
export function isCasRefusal(error: unknown): error is OwedError { return error instanceof OwedError && casRefusals.has(error); }
/** N2/DQ1: fresh snapshot per attempt, at most three; dispatch may retry across plan changes after rollback. */
async function retryCas<T>(ledger: Ledger, run: (before: State) => Promise<T>, freshPlan = false): Promise<T> {
  let prior: State | undefined, refusal: unknown;
  for (let attempt = 0; ; attempt++) {
    const before = (await load(ledger)).state;
    if (prior && before.planSha !== prior.planSha && !freshPlan) throw refusal;
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
/** ID: latest act on this exact open candidate, checked while holding the append lock. */
function identicalAct(s: State, d: Draft): RecordedAct | undefined {
  if (!('node' in d)) return undefined;
  const c = s.nodes[d.node]?.candidate, scope = actScope(d);
  if (!c || !s.nodes[d.node]?.slot?.open || scope === undefined) return undefined;
  const prior = entriesOf(s).findLast(e => e.seq > c.seq && actScope(e) === scope);
  const rules = applicableRules(s,d.node);
  return prior && actContent(prior,rules) === actContent(d,rules) ? { ...prior, alreadyRecorded:prior.seq } : undefined;
}
/** Normal validation still runs before deduplication; waiver retries check before consumed-risk validation. */
async function mutateAct(o: Actor, make: (s: State) => Draft | RecordedAct | Promise<Draft | RecordedAct>): Promise<RecordedAct> {
  owner(o); const ledger = await Ledger.open(o.cwd);
  return ledger.withLock(async () => {
    const { state } = await load(ledger), d = await make(state);
    if ('alreadyRecorded' in d) return d as RecordedAct;
    guard(state,d);
    return identicalAct(state,d) ?? (await ledger.append([d]))[0]!;
  });
}
async function mutate(o: Actor, make: (s: State) => Draft | Promise<Draft>, fresh?: { node: string; since?: number }): Promise<Entry> {
  owner(o); const ledger = await Ledger.open(o.cwd);
  return ledger.withLock(async () => { const { state, entries } = await load(ledger); if (fresh) decidedOn(entries,fresh.node,fresh.since); const d = await make(state); guard(state,d); return (await ledger.append([d]))[0]!; });
}
/** F1: whether ledger entry `e` names `node`: its `node` or `subject`, a ruling listing it or `*`, or any plan entry. */
const namesNode = (e: Entry, node: string): boolean => e.kind === 'plan' || (e.kind === 'rule' ? e.nodes === '*' || e.nodes.includes(node) : ('node' in e && e.node === node) || ('subject' in e && e.subject === node));
/**
 * F1 (0.11, app #35): a driver act decided on the state of seq `since` (halt, send, launch, rebase) records nothing
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
function planBlob(text: string, checkWrites = true, prior?: Plan) {
  const plan = withWritesSyntax(parsePlan(text),2), hygiene = [...(checkWrites ? writesSyntaxErrors(plan,prior) : []),...(plan.worktrees ? worktreesErrors(plan.worktrees) : []), ...nodeIdCaseErrors(plan), ...execEnvErrors(plan)];
  if (hygiene.length) throw new OwedError(hygiene.join('\n'),'usage');
  const source = JSON.parse(canonical(plan));
  // PL1: retain diagnostic source even before SG's parsed check field is integrated.
  const raw = parseDocument(text).toJS();
  for (const [checks, originals] of [
    [source.invariants, raw.invariants],
    ...source.nodes.map((n: NodeSpec) => [n.checks, raw.nodes?.find((x: NodeSpec) => x.id === n.id)?.checks]),
  ]) for (const check of checks ?? []) {
    const diagnostic = originals?.find((x: { id: string; on_timeout?: unknown }) => x.id === check.id)?.on_timeout;
    if (typeof diagnostic === 'string') check.on_timeout = diagnostic;
  }
  const data = stringify(source, { sortMapEntries: true }); return { plan, data, sha: sha256(data) };
}
async function storePlan(ledger: Ledger, text: string, prior?: Plan) { const b = planBlob(text,true,prior); return { plan: b.plan, sha: await ledger.putBlob(b.data) }; }
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
  const measure = async (job: AttestJob, grantedWrites?: string[]) => measuringJob(cwd,snapshot,job,async () => runJob({ cwd, ledger, plan:await jobPlan(ledger,snapshot,job), ...(grantedWrites ? { grantedWrites } : {}), signal },job));
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
    const measuring = measureAll(jobs,parallel,signal,async job => measure(job),(i,obs) => ready[i]!.settle(obs),() => stopped).catch(error => { failure = { error }; for (const r of ready) r.settle(undefined); });
    // A failed record starts no further job and still waits for the running ones, so none outlives the run (and its lock).
    try {
      for (let i = 0; i < jobs.length; i++) {
        const obs = await ready[i]!.p;
        if (obs) {
          await record(jobs[i]!,obs,signal?.aborted ? undefined : signal);
          const retry = await automaticInvariantRemeasure(cwd,ledger,snapshot,jobs[i]!,obs,signal);
          if (retry) await record(jobs[i]!,retry,signal);
        }
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
    const obs = await measure(job,job.attribution ? [] : grantsOf(snapshot,job.subject).flatMap(g => g.paths));
    checkAbort(signal);
    await record(job,obs,signal);
    const retry = await automaticInvariantRemeasure(cwd,ledger,snapshot,job,obs,signal);
    if (retry) await record(job,retry,signal);
  }
  return out;
}
/** RO2–RO3: caller keeps its lease/outer lock; never run a command under the ledger lock. */
async function automaticInvariantRemeasure(cwd: string, ledger: Ledger, snapshot: State, job: AttestJob, first: Draft, signal?: AbortSignal): Promise<Draft | undefined> {
  if (signal?.aborted || job.kind !== 'inv' || job.attribution || first.kind !== 'obs') return;
  const needles = snapshot.plan.invariants.find(i => i.id === job.spec?.id)?.remeasure_on ?? [];
  if (first.verdict !== 'fail') return;
  const latest = (await load(ledger)).state;
  if (latest.planSha !== snapshot.planSha || latest.trunk.commit !== snapshot.trunk.commit) return;
  if (entriesOf(latest).some(e => e.kind === 'obs' && e.subject === 'trunk' && e.obligation === job.obligation && e.key === job.key && e.auto_remeasure)) return;
  const ro2 = needles.length > 0 && !!first.remeasure_match?.length && first.remeasure_match.every(n => needles.includes(n));
  // FS2/IF1: shared and setup failures get one same-key retry even without remeasure_on.
  // Shared-only retries exclude repeat; IF2 removes only zero-result setup runs, never behavioural votes.
  if (!ro2 && !setupFailure(latest,first) && (job.spec?.repeat || !sharedDraft(latest,first))) return;
  checkAbort(signal);
  const retry = await runJob({cwd,ledger,plan:snapshot.plan,signal},job);
  const { remeasure_match: _match, ...plain } = retry as Extract<Draft,{kind:'obs'}>;
  return { ...(ro2 ? retry : plain), ...(first.merging ? { merging:first.merging } : {}), auto_remeasure:true } as Draft;
}
/** FS2: whether failing draft `first` is shared on `s` (the recorded entry when the attest loop already appended it). */
function sharedDraft(s: State, first: Extract<Draft,{kind:'obs'}>): boolean {
  const recorded = entriesOf(s).findLast((e): e is ObsEntry => e.kind === 'obs' && e.subject === first.subject && e.obligation === first.obligation && e.key === first.key && e.commit === first.commit && e.log === first.log && e.merging === first.merging);
  const o = recorded ?? { ...first, seq:s.seq + 1, ts:'', prev:'', hash:'' } as ObsEntry;
  // A trunk already red with these names (IR lineage: inherited merge debt, or a persistently red trunk) gains nothing from a retry.
  const before = entriesOf(s).findLast((e): e is ObsEntry => e.kind === 'obs' && e.seq < o.seq && e.subject === 'trunk' && e.obligation === o.obligation && e.merging === undefined && e.batch === undefined && e.verdict !== 'error' && e.key !== o.key);
  if (before?.verdict === 'fail' && o.failed?.every(name => before.failed?.includes(name))) return false;
  return !!sharedFailure(s, o, first.merging);
}
/** RO3: a refusal quotes both votes; a fail/pass conflict cannot be repaired by another retry. */
function automaticRemeasureHints(state: State, items: ItemView[], node: string): { lines: string[]; keys: Set<string> } {
  const lines: string[] = [], keys = new Set<string>();
  for (const item of items.filter(i => i.status === 'D')) {
    const obs = entriesOf(state).filter((e): e is ObsEntry => e.kind === 'obs' && !e.batch && e.subject === 'trunk' && e.obligation === item.obligation && e.key === item.key);
    const retry = obs.find(e => e.auto_remeasure);
    if (!retry) continue;
    keys.add(item.key);
    const first = obs.find(e => e.seq < retry.seq && e.verdict === 'fail');
    const quote = (e: ObsEntry) => `#${e.seq} ${e.verdict}${e.note ? ` (${oneLine(e.note.split('; last output:')[0]!)})` : ''}`;
    lines.push(`${item.obligation} automatic same-key remeasure: ${[first,retry].filter((e): e is ObsEntry => !!e).map(quote).join('; ')}; ${item.mark === '⊤' ? `conflicting pass and fail need the owner: fix the invariant or owed defer ${node} ${item.obligation.slice(4)} --reason "<why retaining debt is acceptable>"` : 'retry consumed on this key; fix the invariant before retrying merge'}`);
  }
  return { lines, keys };
}
/** RO: keep both observations in measurement order, using the same key and the caller's final CAS. */
async function automaticInvariantResults(cwd: string, ledger: Ledger, state: State, jobs: AttestJob[], observations: Draft[], signal?: AbortSignal): Promise<Draft[]> {
  const out: Draft[] = [];
  for (const first of observations) {
    out.push(first);
    if (first.kind !== 'obs') continue;
    const job = jobs.find(j => j.subject === first.subject && j.obligation === first.obligation && j.key === first.key);
    const retry = job && await automaticInvariantRemeasure(cwd,ledger,state,job,first,signal);
    if (retry) out.push(retry);
  }
  return out;
}
/**
 * SB3: a candidate recorded before the SB1 submit check that contains trunk commits after its slot base fails writes
 * with the cause and the fix, and nothing is granted (its base..commit diff holds other nodes' merged paths).
 */
async function trunkAfterBaseWrites(cwd: string, ledger: Ledger, s: State, job: AttestJob, obs: import('./types.ts').ObsEntry | Extract<Draft, { kind:'obs' }>, paths: string[]): Promise<Draft | undefined> {
  const latest = await git.trunkAfterBase(cwd,job.base,job.commit,s.trunk.commit);
  if (!latest) return undefined;
  const note = `writes not judged: ${trunkAfterBaseText(job.subject,job.commit,job.base,latest,s.trunk.commit)} (${paths.length} changed paths since the slot base include other merged work; nothing granted)`;
  return { ...obs, verdict:'fail', exit:1, note, log:await ledger.putBlob(note) };
}
/** WG4: grantable paths and the writes observation are appended atomically under the ledger lock. */
async function writesGrantDrafts(cwd: string, ledger: Ledger, s: State, job: AttestJob, obs: import('./types.ts').ObsEntry | Extract<Draft, { kind:'obs' }>): Promise<Draft[]> {
  const n = s.nodes[job.subject]!;
  const paths = (await git.git(cwd,['diff','--no-renames','--name-only','-z',job.base,job.commit])).stdout.split('\0').filter(Boolean);
  const later = await trunkAfterBaseWrites(cwd,ledger,s,job,obs,paths);
  if (later) return [later];
  const bad = paths.filter(p => !withinWrites(s,job.subject,p)).sort(), drafts: Draft[] = [];
  const refused = writesRefusals(s,job.subject,bad), denied = new Set(refused.map(r => r.path));
  const grantable = bad.filter(p => !denied.has(p));
  if (grantable.length) drafts.push({kind:'grant',by:'executor:owed',node:job.subject,attempt:n.slot!.attempt,commit:job.commit,paths:grantable,allowance:allowanceSeq(s) ?? -1});
  const grants = grantsOf(s,job.subject).filter(g => g.paths.some(p => paths.includes(p)));
  const labels = [...grants.map(g => `granted #${g.seq}: ${g.paths.join(', ')}`), ...(grantable.length ? [`granted #${s.seq + 1}: ${grantable.join(', ')}`] : [])];
  const owners = [...new Set(refused.flatMap(r => r.owners))].sort();
  const overlapOnly = refused.length > 0 && refused.every(r => r.reasons.every(reason => reason.startsWith('overlaps open node ')));
  const failures = refused.map(r => `${r.path} (${r.reasons.filter(reason => !reason.startsWith('overlaps open node ')).concat(r.owners.map(id => `owned by open node ${id}`)).join('; ')})`);
  const note = refused.length ? `outside writes: ${failures.join(', ')}${overlapOnly ? `; re-measured automatically after ${owners.join(', ')} merges` : owners.length ? `; resolve other refusals, then re-measure after ${owners.join(', ')} merges` : ''}${labels.length ? `; ${labels.join('; ')}` : ''}` : `all changed paths within writes${labels.length ? ` (${labels.join('; ')})` : ''}`;
  drafts.push({...obs,verdict:refused.length ? 'fail' : 'pass',exit:refused.length ? 1 : 0,note,log:await ledger.putBlob(note),...(refused.some(r => r.reasons.some(reason => reason === 'under closure' || reason.startsWith('overlaps open node '))) ? {grant_refused:true} : {}),...(overlapOnly ? {waits_on:owners} : {})});
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
  return law && (law.kind === 'plan' || law.kind === 'genesis') ? withWritesSyntax(h.lookup(law.plan),law.writes_syntax ?? 1) : snapshot.plan;
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
export async function init(o: Actor & { plan: string; channel: Channel; signal?: AbortSignal; lease?: boolean; measure?: boolean; commit?: string; path?: string }): Promise<InitResult> {
  owner(o); checkAbort(o.signal); const warnings = lintPlanShell(planBlob(o.plan).plan,undefined,o.plan);
  const ledger = await Ledger.open(o.cwd), p = await storePlan(ledger,o.plan);
  const commit = await git.revParse(o.cwd,`refs/heads/${p.plan.trunk}`), facts = await git.stateFacts(o.cwd,p.plan,commit,quarantineNames(p.plan,() => false));
  if (o.commit !== undefined && o.commit !== commit) throw new OwedError(`refs/heads/${p.plan.trunk} moved after the confirmation (was ${o.commit.slice(0,12)}, now ${commit.slice(0,12)}); nothing was recorded`);
  warnings.push(...await lintPlanCost(o.cwd,p.plan,commit));
  const entry = await ledger.withLock(async () => { const { state } = await load(ledger,[p.sha]); const d: Draft = { kind:'genesis', by:by(o), channel:o.channel, trunk:p.plan.trunk, commit, plan:p.sha, writes_syntax:2, state:facts, ...(o.path !== undefined ? { path:o.path } : {}) }; guard(state,d); return (await ledger.append([d]))[0]!; },undefined,o.signal);
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
    return await withMeasuring(o.cwd,'trunk',async () => {
      const ledger = await opened;
      inited((await load(ledger)).state);
      return await leased({...o,priority:10}, signal => ledger.withLock(async () => {
        await measuringRunning();
        const { state } = await load(ledger), r = await runJobs(o.cwd,ledger,state,genesisJobs(state),signal,undefined,parallelOf(state.plan));
        return { ...await genesisOutcome(ledger,r.superseded), observations:r.recorded };
      },'genesis',signal,{ busy:owner => `attest --genesis is already running (${heldBy(owner)}); its observations will appear in owed status` }));
    });
  } finally { genesisRuns.delete(run); }
}
/** IR1: a shared-machine lease, then trunk-refresh lock, then short ledger locks (never commands under ledger lock). */
export async function attestTrunk(o: Context & { signal?: AbortSignal; lease?: boolean; remeasure?: boolean; all?: boolean }): Promise<AttestTrunkResult> {
  checkAbort(o.signal);
  if (!measuringScope()) return withMeasuring(o.cwd,'trunk',() => attestTrunk(o));
  if (!measurementScope()) return leased({...o,priority:10}, signal => attestTrunk({ ...o, signal }));
  const ledger = await Ledger.open(o.cwd);
  return ledger.withLock(async () => {
    await measuringRunning();
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
  },'trunk-refresh',o.signal,{ busy:who => `attest --trunk is already running (${heldBy(who)}); its observations will appear in owed status`, activity:'attest --trunk' });
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
/** SF2: start never invents a plan or silently approves a downgrade (ruling #2550). */
export interface StartResult { initialized: boolean; updated: boolean; plan: string; warnings: string[]; driver: DriveStart }
function startRefusal(check: string, why: string, fix: string): never { throw new OwedError(`start preflight ${check} failed: ${oneLine(why)}; ${fix}`, 'usage'); }
export async function start(o: Context & { plan?: string; max?: number; stay?: boolean; restart?: boolean; signal?: AbortSignal }): Promise<StartResult> {
  if (o.max !== undefined && (!Number.isSafeInteger(o.max) || o.max < 1)) startRefusal('max', 'expected a positive integer', 'use owed start --max <N>');
  const refusal = subagentRefusal('parent');
  if (refusal) startRefusal('identity', refusal, 'run owed start from the main agent');
  try { await git.repoRoot(o.cwd); } catch { startRefusal('repository', 'not a git worktree', 'run owed start inside a git repository'); }
  for (const ident of ['GIT_AUTHOR_IDENT', 'GIT_COMMITTER_IDENT']) {
    const r = await git.git(o.cwd, ['var', ident], { allowFail:true });
    if (r.code || !r.stdout.trim()) startRefusal('git identity', r.stderr.trim() || `${ident} is missing`, 'configure git user.name and user.email, then run owed start');
  }
  const { entries, state } = await readState(o), fresh = state.seq < 0;
  let source = o.plan;
  if (source === undefined && !fresh) {
    const law = entries.findLast(e => e.kind === 'plan' || e.kind === 'genesis');
    if (law?.kind === 'plan' || law?.kind === 'genesis') source = law.path;
    if (source !== undefined && !isAbsolute(source)) source = join(await git.repoRoot(o.cwd), source);
  }
  if (source === undefined) startRefusal('plan', fresh ? 'no ledger and no plan supplied' : 'the latest recorded plan has no file path', 'use owed start --plan <file>');
  let read: Awaited<ReturnType<typeof readPlan>>, b: ReturnType<typeof planBlob>, warnings: string[];
  try {
    read = await readPlan({ cwd:o.cwd, path:source });
    b = planBlob(read.plan, true, fresh ? undefined : state.plan);
    warnings = [...lintPlanShell(b.plan, fresh ? undefined : state.plan, read.plan, fresh ? undefined : (await (await Ledger.open(o.cwd)).getBlob(state.planSha)).toString()), ...planWarnings(b.plan, new Set(Object.values(state.nodes).filter(n => n.merged).map(n => n.id))), ...(fresh ? [] : parentOverlapWarnings(b.plan, state))];
  } catch (e) { startRefusal('plan validation', e instanceof Error ? e.message : String(e), `fix ${oneLine(source)}, then run owed start --plan ${JSON.stringify(source)}`); }
  const trunk = await git.git(o.cwd, ['rev-parse', '--verify', `refs/heads/${b.plan.trunk}^{commit}`], { allowFail:true });
  if (trunk.code) startRefusal('trunk ref', `refs/heads/${b.plan.trunk} does not name a commit`, `create the ${oneLine(b.plan.trunk)} branch with an initial commit, then run owed start`);
  const changed = !fresh && b.sha !== state.planSha;
  if (changed) {
    const gaps = uncoveredDowngrades(state.plan, b.plan, planDowngrades(state.plan, b.plan));
    if (gaps.length) startRefusal('plan downgrade', gaps.map(g => `${g.node}: ${g.what}`).join('; '), `record an explicit owner decision with owed plan ${JSON.stringify(source)} --note "<why>", then run owed start`);
  }
  if (fresh || changed) warnings.push(...await lintPlanCost(o.cwd,b.plan,trunk.stdout.trim(),entries,fresh ? undefined : state.plan));
  if (fresh && confirmGate()) startRefusal('owner confirmation', 'OWED_CONFIRM=owner requires an explicit init', `run owed init ${JSON.stringify(source)}, then run owed start --plan ${JSON.stringify(source)}`);
  const status = await driveStatus(o);
  if (status.foreign) startRefusal('driver lock', `held on host ${status.host}; not checked from here`, 'check the driver on that host with owed drive --status before starting here');
  checkAbort(o.signal);
  if (fresh) await init({ cwd:o.cwd, as:{role:'owner', id:'pi'}, channel:'delegated', plan:read.plan, path:read.path, commit:trunk.stdout.trim(), measure:false, signal:o.signal });
  else if (changed) await planSet({ cwd:o.cwd, as:{role:'parent', id:'pi'}, ...read });
  checkAbort(o.signal);
  const driver = await driveStart({ cwd:o.cwd, max:o.max, stay:o.stay, reuse:true, restart:o.restart });
  return { initialized:fresh, updated:changed, plan:read.path, warnings, driver };
}
/** AK6/SF2: one action line (including lint warnings), one driver line and one next step. */
export function startText(r: StartResult): string {
  const action = r.initialized ? 'initialized ledger' : r.updated ? 'updated plan' : 'plan unchanged';
  const driver = r.driver.alreadyRunning ? 'already running' : r.driver.exited ? `ended (${r.driver.exited.reason}, exit ${r.driver.exited.code})` : 'started';
  return [`start: ${action}${r.warnings.length ? `; ${r.warnings.map(oneLine).join('; ')}` : ''}`, `driver: ${driver}`, r.driver.exited ? 'Next: owed status shows what remains; use owed start --stay to wait for new work.' : 'Next: wait for driver wake-ups; use owed status for progress and owed decide for decisions.'].join('\n');
}
/** N1 (23:4x): a carry `owed plan` skipped (facts not computable or validation refused it); the candidate stays invalidated. */
export interface NotCarried { node: string; reason: string }
/** `notCarried` (N1, optional): receives one item per open candidate the plan entry invalidated and could not carry. */
export async function planSet(o: Actor & { plan: string; rev?: string; path?: string; note?: string; notCarried?: NotCarried[]; shellWarnings?: string[] }): Promise<Entry> {
  owner(o); const ledger = await Ledger.open(o.cwd), b = planBlob(o.plan,false);
  // N2: each attempt recomputes carries from its own fresh locked read; only the successful attempt reports skips.
  return retryCas(ledger, async before => {
    const hygiene = writesSyntaxErrors(b.plan,before.plan);
    if (hygiene.length) throw new OwedError(hygiene.join('\n'),'usage');
    const priorText = (await ledger.getBlob(before.planSha)).toString();
    const warnings = [...lintPlanShell(b.plan,before.plan,o.plan,priorText), ...await lintPlanCost(o.cwd,b.plan,before.trunk.commit,(await load(ledger)).entries,before.plan)];
    const p = { plan:b.plan, sha:await ledger.putBlob(b.data) };
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
  const latest = await load(ledger,[p.sha]), { state } = latest; stable(before,state); const d: Draft = { kind:'plan', by:by(o), channel:o.channel, prior:before.planSha, plan:p.sha, writes_syntax:2, downgrades:planDowngrades(state.plan,p.plan), ...(o.rev !== undefined ? { rev:o.rev } : {}), ...(o.path !== undefined ? { path:o.path } : {}), ...(o.note !== undefined && o.note.trim() ? { note:o.note } : {}) }; guard(state,d);
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
// ---------- N3: owed amend, widen one node's writes (app #26) ----------
/** N3: what `owed amend` would write: the plan file edited with the node's new writes (nothing recorded yet). */
export interface AmendEdit {
  node: string;
  /** the plan file (real path) and its path as `owed plan` records it */
  file: string; path: string;
  /** the file text read (equal to the ledger's current plan) and the edited text */
  text: string; next: string;
  prior: Plan; plan: Plan;
  /** paths appended to writes, and paths already covered by writes or a current-plan allow rule (skipped) */
  added: string[]; present: string[];
  covered: { path: string; entry: string }[];
  /** the ledger plan sha the edit starts from */
  planSha: string;
}
export interface AmendResult { node: string; file: string; path: string; added: string[]; present: string[]; covered: AmendEdit['covered']; plan?: Entry; rule?: Entry; carried: SubmitEntry[]; notCarried: NotCarried[] }
type AmendArgs = Context & { node: string; writes: string[]; note: string; plan?: string };
/** WA2: bare paths and +paths widen writes; removal and empty paths are refused. */
export function amendPaths(writes: string[]): string[] {
  if (!Array.isArray(writes) || !writes.length) throw new OwedError('amend needs at least one path to add: --writes +<path>[,+<path>...]','usage');
  const out: string[] = [];
  for (const w of writes) {
    const t = typeof w === 'string' ? w.trim() : '';
    if (t.startsWith('-')) throw new OwedError(`amend only widens writes (got ${JSON.stringify(w)}); removing writes needs owed plan`,'usage');
    const p = (t.startsWith('+') ? t.slice(1) : t).trim();
    if (!p) throw new OwedError('amend: empty path after +','usage');
    const error = writesEntryError(p);
    if (error) throw new OwedError(error,'usage');
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
  if (planBlob(read.plan,false).sha !== s.planSha) throw new OwedError(`plan file has unrecorded edits: ${read.path} differs from the ledger's current plan; record it with owed plan first, or restore it`);
  const doc = parseDocument(read.plan);
  const nodes = doc.get('nodes'), item = isSeq(nodes) ? nodes.items.find(x => isMap(x) && x.get('id') === o.node) : undefined;
  if (!isMap(item)) throw new OwedError(`cannot edit ${read.path}: node ${o.node} is not a map in its nodes list`);
  // Every addition is a writes scope, not a filename: even a bare path owns its prefix range.
  const covered = paths.flatMap(path => {
    const entry = spec.writes.find(w => w === path || writeCovers(w, path, writesSyntax(s.plan)))
      ?? (writesCovered(s.plan,o.node,[path]) ? `allow rule (plan #${entries.findLast(e => e.kind === 'plan' || e.kind === 'genesis')!.seq})` : undefined);
    return entry === undefined ? [] : [{ path, entry }];
  });
  const present = covered.map(c => c.path), added = paths.filter(p => !present.includes(p));
  const next = added.length ? spliceWrites(read.plan,doc,item,added) : read.plan;
  if (next === undefined) throw new OwedError(`cannot edit ${read.path}: writes of node ${o.node} is not a list`);
  const plan = added.length ? planBlob(next,true,s.plan).plan : s.plan, expect: Plan = { ...s.plan, nodes:s.plan.nodes.map(n => n.id === o.node ? { ...n, writes:[...n.writes,...added] } : n) };
  if (canonical(plan) !== canonical(expect)) throw new OwedError(`cannot edit ${read.path}: the edited file would change more than the writes of ${o.node}`,'internal');
  return { node:o.node, file:await realpath(resolve(o.cwd,source)), path:read.path, text:read.plan, next, prior:s.plan, plan, added, present, covered, planSha:s.planSha };
}
export function amendLimitText(r: Pick<AmendResult,'node'|'covered'>): string {
  return r.covered.some(c => c.entry.startsWith('allow rule (plan #')) ? `; owed decide ${r.node} --writer delivers a limit` : '';
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
  const { entries } = await load(ledger), e = await amendEdit(o,entries,before);
  if (!e.added.length) return ledger.withLock(async () => {
    stable(before, (await load(ledger)).state);
    if (await readFile(e.file,'utf8') !== e.text) throw new OwedError(`plan file has unrecorded edits: ${e.path} changed while amending; nothing recorded`);
    return { node:o.node, file:e.file, path:e.path, added:[], present:e.present, covered:e.covered, carried:[], notCarried:[] };
  });
  const p = await storePlan(ledger,e.next,before.plan);
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
    return { node:o.node, file:e.file, path:e.path, added:e.added, present:e.present, covered:e.covered, plan, rule:ruled, carried:appended.slice(1,-1).filter((x): x is SubmitEntry => x.kind === 'submit'), notCarried };
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
  if (planBlob(read.plan,false).sha !== s.planSha) throw new OwedError(`plan file has unrecorded edits: ${read.path} differs from the ledger's current plan; record it with owed plan first, or restore it`);
  const next = editText(read.plan,o), plan = planBlob(next,true,s.plan).plan;
  return { file:await realpath(source), path:read.path, text:read.plan, next, prior:s.plan, plan, planSha:s.planSha, diff:editDiff(read.path,read.plan,next), downgrades:planDowngrades(s.plan,plan), warnings:[...parentOverlapWarnings(plan,s), ...lintPlanShell(plan,s.plan,next,(await (await Ledger.open(o.cwd)).getBlob(s.planSha)).toString()), ...await lintPlanCost(o.cwd,plan,s.trunk.commit,entries,s.plan)] };
}
/** ED1/ED2: preview the YAML edit and downgrades, with no append or file write. */
export async function editPreview(o: EditArgs): Promise<EditPreview> { const { entries, state } = await load(await Ledger.open(o.cwd)); return prepareEdit(o,entries,state); }
/** ED2: plan + carries + optional ruling + optional resume, guarded together and appended once. */
export async function edit(o: Actor & EditArgs): Promise<EditResult | EditPreview> {
  if (o.dry_run) return editPreview(o);
  owner(o); const ledger = await Ledger.open(o.cwd);
  return retryCas(ledger,async before => {
    const { entries } = await load(ledger), e = await prepareEdit(o,entries,before), p = await storePlan(ledger,e.next,before.plan), notCarried: NotCarried[] = [];
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

// ---------- DC: one decision, one append; effects only after the lock ----------
export type DecideArgs = Actor & { nodes: string | string[]; text: string; writes?: string[]; defer?: string; resume?: boolean; after?: string | string[]; remeasure?: boolean; writer?: boolean; dsa?: Pick<Dsa,'describe'|'send'> };
export interface DecideResult { decision: number; nodes: string[]; entries: Entry[]; rule: RuleEntry; plan?: Entry; added?: string[]; covered?: Record<string, AmendEdit['covered']>; deferred?: string; answered: number; resumed: boolean; deliveryFailures: string[]; remeasure?: string[] }
function decideNodes(nodes: string | string[]): string[] {
  const ids = [...new Set((Array.isArray(nodes) ? nodes : typeof nodes === 'string' ? nodes.split(',') : []).map(x => typeof x === 'string' ? x.trim() : ''))];
  if (!ids.length || ids.some(x => !x || x === '*')) throw new OwedError('decide needs a non-empty list of named nodes','usage');
  return ids;
}
async function decideAmend(o: DecideArgs, ids: string[], entries: Entry[], s: State): Promise<AmendEdit & { perNode: Record<string, AmendEdit['covered']> }> {
  const edits = await Promise.all(ids.map(node => amendEdit({ cwd:o.cwd, node, writes:o.writes!, note:o.text },entries,s)));
  const first = edits[0]!, added = first.added;
  if (edits.some(e => canonical(e.added) !== canonical(added))) throw new OwedError(`decide writes must add the same paths to every named node; split nodes with partially present paths: ${edits.map(e => `${e.node}: covered [${e.covered.map(c => `${c.path} already covered by ${c.entry}`).join(', ')}]; added [${e.added.join(', ')}]`).join('; ')}`,'usage');
  let next = first.text;
  for (const e of edits) {
    if (!added.length) continue;
    const doc = parseDocument(next), nodes = doc.get('nodes'), item = isSeq(nodes) ? nodes.items.find(x => isMap(x) && x.get('id') === e.node) : undefined;
    if (!isMap(item)) throw new OwedError(`cannot edit writes of ${e.node}`);
    const changed = spliceWrites(next,doc,item,added);
    if (changed === undefined) throw new OwedError(`cannot edit writes of ${e.node}`);
    next = changed;
  }
  return { ...first, next, plan:added.length ? planBlob(next,true,s.plan).plan : s.plan, perNode:Object.fromEntries(edits.map(e => [e.node,e.covered])) };
}
/** Authority preview only: no file or ledger effect. */
export async function decidePreview(o: Omit<DecideArgs,'as'>): Promise<{ prior:Plan; plan:Plan }> {
  const { entries, state } = await load(await Ledger.open(o.cwd));
  const e = await decideAmend({ ...o, as:{role:'parent',id:'preview'} },decideNodes(o.nodes),entries,state);
  return { prior:state.plan, plan:e.plan };
}
export async function decide(o: DecideArgs): Promise<DecideResult> {
  if (!['parent','owner'].includes(o.as.role) || by(o) === DRIVER) throw new OwedError('decide requires parent or owner, never the driver');
  const refusal = subagentRefusal(o.as.role); if (refusal) throw new OwedError(refusal);
  owner(o);
  if (typeof o.text !== 'string' || !o.text.trim()) throw new OwedError('decide requires nonempty text','usage');
  for (const k of ['resume','remeasure','writer'] as const) if (o[k] !== undefined && typeof o[k] !== 'boolean') throw new OwedError(`decide ${k} must be a boolean`,'usage');
  if (o.resume === false && (o.after !== undefined || o.remeasure)) throw new OwedError('--no-resume cannot take --after or --remeasure','usage');
  const ids = decideNodes(o.nodes), ledger = await Ledger.open(o.cwd), client = o.dsa ?? new Dsa({cwd:o.cwd});
  const before = await load(ledger), s = before.state;
  for (const id of ids) { node(s,id); if (s.nodes[id]!.merged) throw new OwedError(`Node ${id} is merged; decide names unfinished nodes`); }
  const amend = o.writes !== undefined ? await decideAmend(o,ids,before.entries,s) : undefined;
  const stored = amend?.added.length ? await storePlan(ledger,amend.next,s.plan) : undefined;
  const granted = [...new Set(Object.values(amend?.perNode ?? {}).flat().filter(c => c.entry.startsWith('allow rule (plan #')).map(c => c.path))];
  const decisionText = o.text + (granted.length ? ` (writes already granted by allow rule, plan #${before.entries.findLast(e => e.kind === 'plan' || e.kind === 'genesis')!.seq}: ${granted.join(', ')})` : '');
  const answers: import('./types.ts').DecisionAnswer[] = [];
  for (const id of ids) {
    const n = s.nodes[id]!, launches = n.slot?.open ? n.runs.find(r => r.attempt === n.slot!.attempt)?.launches ?? [] : [];
    const questions = (await Promise.all(launches.map(async launch => { const view = await client.describe(launch.rid); return view.state === 'asking' ? (view.questions ?? []).map(question => ({launch,question})) : []; }))).flat();
    if (questions.length > 1) throw new OwedError(`Ambiguous question for ${id}; use owed answer --rid and --qid before deciding`);
    if (questions[0]) { const {launch,question} = questions[0]; answers.push({node:id,rid:launch.rid,qid:question.qid,rev:question.rev}); }
  }
  answers.sort((a,b) => a.node.localeCompare(b.node) || a.qid.localeCompare(b.qid));
  const deferred: Extract<Draft,{kind:'defer'}>[] = [];
  if (o.defer !== undefined) {
    if (o.as.role !== 'owner') throw new OwedError('decide defer requires owner');
    const id = invariantId(s.plan,o.defer);
    if (!s.plan.invariants.some(i => i.id === id)) throw new OwedError(`Unknown invariant ${o.defer}`);
    const drift = await git.trunkDrift(o.cwd,s.trunk.name,s.trunk.commit); if (drift) throw new OwedError(`trunk changed (CAS): ${driftText(drift)}`);
    for (const node of ids) {
      const n = candidate(s,node), built = await git.buildMerge(o.cwd,s.trunk.commit,n.candidate!.commit,`owed merge ${node}`);
      if ('conflicts' in built) throw new OwedError(`rebase needed for ${node}; nothing recorded`);
      const facts = await git.stateFacts(o.cwd,s.plan,built.commit,quarantineNames(s.plan,x => !!s.nodes[x]?.merged,node));
      deferred.push({kind:'defer',by:by(o),channel:o.channel,node,items:[{id,key:facts.invKeys[id] ?? ''}],reason:o.text});
    }
  }
  const result = await ledger.withLock(async () => {
    const latest = await load(ledger);
    stable(s,latest.state);
    for (const id of ids) stable(s,latest.state,id);
    if (canonical(latest.state.rules) !== canonical(s.rules) || ids.some(id => canonical(latest.state.nodes[id]?.runs) !== canonical(s.nodes[id]?.runs) || latest.state.nodes[id]?.held !== s.nodes[id]?.held || latest.state.nodes[id]?.halt?.seq !== s.nodes[id]?.halt?.seq)) throw new OwedError('decision state changed; retry; nothing recorded');
    if (deferred.length) { const drift = await git.trunkDrift(o.cwd,s.trunk.name,s.trunk.commit); if (drift) throw new OwedError(`trunk changed (CAS): ${driftText(drift)}`); }
    const first = latest.state.seq+1, drafts: Draft[] = [];
    let prepared = latest;
    if (amend && stored) {
      const planned = await planDrafts({...o,path:amend.path,note:o.text},ledger,stored,s);
      prepared = planned.latest;
      const carries = planned.drafts;
      if (carries.some(d => d.kind === 'submit' && !ids.includes(d.node))) throw new OwedError('decision amend would carry an undecided node; nothing recorded');
      drafts.push(...carries.map(d => ({...d,decision:first})));
    }
    const push = (d: Draft) => { const next = {...d,decision:first}; guard(replayed(prepared,drafts),next); drafts.push(next); };
    for (const d of deferred) push(d);
    let text = decisionText, answer: AnswerRef | undefined, supersedes: number | undefined;
    if (answers.length === 1) {
      const a = answers[0]!, launch = s.nodes[a.node]!.runs.flatMap(r => r.launches).find(l => l.rid === a.rid)!;
      answer = {rid:a.rid,qid:a.qid,rev:a.rev}; text = `Answer to ${launch.role} question ${a.qid}: ${decisionText}`;
      supersedes = latest.entries.findLast(e => e.kind === 'rule' && ruleAnswers(e).some(ref => ref.rid === a.rid && ref.qid === a.qid))?.seq;
    }
    push({kind:'rule',by:by(o),channel:o.channel,nodes:ids,text,...(o.writer !== undefined ? {writer:o.writer} : answer ? {writer:false} : {}),...(answer ? {answer} : {}),...(answers.length > 1 ? {answers} : {}),...(supersedes !== undefined ? {supersedes} : {})});
    let resumed = false;
    for (const id of ids) {
      const n = s.nodes[id]!, requested = o.resume === true || o.after !== undefined || !!o.remeasure || o.resume !== false && (!!halted(s,id) || n.held !== undefined);
      if (requested) { push(resumeDraft({...o,node:id,note:o.text},replayed(prepared,drafts))); resumed = true; }
    }
    // Replay every draft before any durable or plan-file write.
    const final = replayed(prepared,drafts), errors = decisionTailErrors(final); if (errors.length) throw new OwedError(errors.join('; '));
    let temp: string | undefined;
    if (amend && stored) {
      if (await readFile(amend.file,'utf8') !== amend.text) throw new OwedError('plan file has unrecorded edits; nothing recorded');
      temp = join(dirname(amend.file),`.${basename(amend.file)}.owed-decide-${randomUUID()}.tmp`);
      try { await writeFile(temp,amend.next); await chmod(temp,(await stat(amend.file)).mode & 0o7777); }
      catch (e) { await unlink(temp).catch(() => undefined); throw new OwedError(`cannot write ${amend.path}: ${(e as Error).message}; nothing recorded`); }
    }
    let entries: Entry[];
    try { entries = await ledger.append(drafts); } catch (e) { if (temp) await unlink(temp).catch(() => undefined); throw e; }
    const appendedErrors = decisionTailErrors(replayed(prepared,entries));
    if (appendedErrors.length) throw new OwedError(appendedErrors.join('; '));
    if (temp && amend) { try { await rename(temp,amend.file); } catch (e) { throw new OwedError(`decision #${first} recorded; recorded plan in ${temp}: move it over ${amend.file} (${(e as Error).message})`,'internal'); } }
    return { decision:first,nodes:ids,entries,rule:entries.find((e): e is RuleEntry => e.kind === 'rule')!,...(amend ? {added:amend.added,covered:amend.perNode,...(stored ? {plan:entries[0]!} : {})} : {}),...(o.defer !== undefined ? {deferred:o.defer} : {}),answered:answers.length,resumed,deliveryFailures:[],...(o.remeasure ? {remeasure:ids.flatMap(id => remeasureQueuedText(final,id))} : {}) } as DecideResult;
  });
  const { deliverRuling, deliverAnswer, answerRetry } = await import('./answer.ts');
  const delivery = await deliverRuling(o.cwd,result.rule,client);
  result.deliveryFailures.push(...delivery.failures.map(f => `${oneLine(f)}; next dispatch or follow-up delivers ruling #${result.rule.seq}`));
  for (const a of answers) {
    try { await deliverAnswer(client,result.rule,a,decisionText); }
    catch (e) { result.deliveryFailures.push(`${oneLine((e as Error).message)}; Retry exactly: ${answerRetry(a.node,result.rule,a)}`); }
  }
  return result;
}
export function decideText(r: DecideResult): string {
  return `decision #${r.decision} for ${r.nodes.join(',')}: ruling #${r.rule.seq}${r.plan ? `; writes ${r.added!.map(p => `+${p}`).join(',')} (plan #${r.plan.seq})` : r.added !== undefined ? '; writes unchanged' : ''}${Object.entries(r.covered ?? {}).flatMap(([node, covered]) => covered.map(c => `; ${node}: ${c.path} already covered by ${c.entry}`)).join('')}${r.deferred ? `; deferred ${r.deferred}` : ''}${r.answered ? `; answered ${r.answered} question(s)` : ''}${r.resumed ? '; resumed' : ''}${r.remeasure?.length ? `\n${r.remeasure.join('\n')}` : ''}${r.deliveryFailures.length ? `\ndelivery failed: ${r.deliveryFailures.join('; ')}` : ''}`;
}

/** AN2: record once under the ledger lock; retries use the original entry and bytes. */
export async function answerRule(o: Actor & { node: string; text: string; answer: AnswerRef; originalText?: string }): Promise<RuleEntry> {
  const ledger = await Ledger.open(o.cwd); owner(o);
  return ledger.withLock(async () => {
    const { state, entries } = await load(ledger);
    if (!['parent', 'owner'].includes(o.as.role)) throw new OwedError('answer requires parent or owner');
    const history = entries.filter((e): e is RuleEntry => e.kind === 'rule' && e.nodes !== '*' && e.nodes.includes(o.node) && ruleAnswers(e).some(a => a.rid === o.answer.rid && a.qid === o.answer.qid));
    const prior = history.find(e => ruleAnswers(e).some(a => a.rid === o.answer.rid && a.qid === o.answer.qid && a.rev === o.answer.rev));
    if (prior) {
      const expected = prior.answers ? o.originalText : o.text;
      if (prior.text !== expected) throw new OwedError(`Answer rule #${prior.seq} already records different text for this rid/qid/rev (rev ${o.answer.rev}); retry with its original answer`);
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
function readyDispatchNode(state: State, id: string) {
  const n = node(state, id), spec = state.plan.nodes.find(x => x.id === id);
  if (!spec) throw new OwedError(`Node ${id} does not exist in the current plan; refresh the plan before dispatching`);
  if (n.held !== undefined) throw new OwedError(`${id} is held by abandon #${n.held}; release it with owed resume ${id}`);
  if (n.phase !== 'ready' || n.slot?.open) throw new OwedError('dispatch requires a ready node with no open slot');
  return { n, spec };
}
export async function dispatch(o: Actor & { node: string; allowOverlap?: boolean }): Promise<DispatchPacket> {
  // The main worktree root: dispatching from inside a slot worktree must not nest the new worktree in it.
  // Resolved first, so an unverifiable layout is refused before any ledger, exclude or worktree effect.
  owner(o); const root = await git.mainRoot(o.cwd), ledger = await Ledger.open(o.cwd);
  return ledger.withLock(() => retryCas(ledger, async state => {
    const { n, spec } = readyDispatchNode(state, o.node);
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
  }, true),'dispatch');
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
import { trunkAfterBaseText } from './needs.ts';
export { trunkAfterBaseText } from './needs.ts';
/** SB1: refuses (nothing recorded) a submit whose commit contains trunk commits the slot base does not. */
async function refuseTrunkAfterBase(cwd: string, s: State, node: string, base: string, commit: string): Promise<void> {
  const latest = await git.trunkAfterBase(cwd,base,commit,s.trunk.commit);
  if (latest) throw new OwedError(`submit refused: ${trunkAfterBaseText(node,commit,base,latest,s.trunk.commit)}`);
}
export async function submit(o: Actor & { node: string; commit?: string; model?: string }): Promise<Entry> {
  owner(o); const ledger = await Ledger.open(o.cwd), { state } = await load(ledger), n = node(state,o.node);
  if (!n.slot?.open) throw new OwedError('No open writer slot');
  if ((!o.commit || resolve(await git.repoRoot(o.cwd)) === resolve(n.slot.worktree)) && !await git.isClean(n.slot.worktree)) throw new OwedError('slot worktree is dirty');
  const commit = await git.revParse(o.commit ? o.cwd : n.slot.worktree,o.commit ?? 'HEAD');
  if (!await git.isAncestor(o.cwd,n.slot.base,commit)) throw new OwedError('submit commit must be a descendant of slot base');
  await refuseTrunkAfterBase(o.cwd,state,o.node,n.slot.base,commit);
  await git.checkCandidateLimits(o.cwd,state.plan.limits,n.slot.base,commit);
  const spec = state.plan.nodes.find(x => x.id === o.node)!, facts = await git.candidateFacts(o.cwd,state.plan,spec,n.slot.base,commit,n.slot.attempt,stateQuarantine(state));
  // D23: approve and evidence keys derive from the patch, like review.
  Object.assign(facts.keys, manualKeys(spec,facts.patch));
  const model = await recordedModel(o.cwd,state,o.node,by(o),o.model);
  await addReviewCarry(o.cwd,state,o.node,facts);
  return ledger.withLock(async () => { const current = (await load(ledger)).state; stable(state,current,o.node); const d: Draft = { kind:'submit', by:by(o), node:o.node, attempt:n.slot!.attempt, facts, ...(model !== undefined ? { model } : {}) }; guard(current,d); return (await ledger.append([d]))[0]!; });
}
export interface TrunkProbeResult { node: string; trunk: string; checks: { obligation: string; observations: Entry[] }[]; receipt: ReceiptCard }
/** TF1: diagnostic node checks on trunk, serialized with attest; each completed run has its own append-time CAS. */
export async function attestProbeTrunk(o: MeasurementContext & { node: string; check?: string; runs?: number }): Promise<TrunkProbeResult> {
  const runs = o.runs ?? 1;
  if (!Number.isInteger(runs) || runs < 1 || runs > 10) throw new OwedError('--runs must be an integer from 1 to 10','usage');
  checkAbort(o.signal);
  if (!measuringScope()) return withMeasuring(o.cwd,o.node,() => attestProbeTrunk(o));
  if (!measurementScope()) return leased({...o,priority:10}, signal => attestProbeTrunk({ ...o, signal }));
  const ledger = await Ledger.open(o.cwd);
  return ledger.withLock(async () => {
    await measuringRunning();
    const { state } = await load(ledger), n = state.nodes[o.node];
    if (!n?.slot?.open || !n.candidate || !state.plan.nodes.some(n => n.id === o.node)) throw new OwedError(`trunk probe requires an open slot with a candidate for ${o.node}`,'usage');
    const specs = state.plan.nodes.find(n => n.id === o.node)!.checks;
    const selected = o.check !== undefined ? specs.filter(c => c.id === o.check) : specs.filter(c => n.blocks.some(b => b.kind === 'exec' && (b.state === 'active' || b.state === 'flaky') && b.obligation === `check:${c.id}`));
    if (!selected.length) throw new OwedError(o.check !== undefined ? `no check ${o.check} of ${o.node}` : `no check of ${o.node} has an active or flaky exec block; name one with --check`,'usage');
    for (const spec of selected) {
      if (spec.red || spec.mutants?.length) throw new OwedError(`check:${spec.id}: trunk probes refuse red/mutants checks`,'usage');
      if (await newCheckTests(o.cwd,n,spec)) throw new OwedError(`check:${spec.id} tests are new in the candidate; trunk cannot run them`,'usage');
    }
    const checks: TrunkProbeResult['checks'] = [];
    for (const spec of selected) {
      const obligation = `check:${spec.id}`, observations: Entry[] = [];
      const key = await git.trunkCheckKey(o.cwd,state.plan,spec,state.trunk.commit,stateQuarantine(state));
      checks.push({ obligation, observations });
      for (let i = 0; i < runs; i++) {
        checkAbort(o.signal);
        const drift = await git.trunkDrift(o.cwd,state.trunk.name,state.trunk.commit);
        if (drift) throw new OwedError(`trunk changed (CAS): ${driftText(drift)}; nothing recorded for this run`);
        const obs = await runTrunkProbe(o,ledger,state,n,{kind:'check',subject:o.node,obligation,key,spec,commit:state.trunk.commit,base:state.trunk.commit,probe:'trunk'});
        checkAbort(o.signal);
        const entry = await ledger.withLock(async () => {
          const latest = (await load(ledger)).state;
          stable(state,latest,o.node);
          const moved = await git.trunkDrift(o.cwd,state.trunk.name,state.trunk.commit);
          if (moved) throw new OwedError(`trunk changed (CAS): ${driftText(moved)}; nothing recorded for this run`);
          const draft: Draft = { ...obs, probe:'trunk' };
          guard(latest,draft);
          return (await ledger.append([draft]))[0]!;
        },undefined,o.signal);
        observations.push(entry);
        if (obs.verdict !== 'pass') break;
      }
    }
    return { node:o.node, trunk:state.trunk.commit, checks, receipt:await why(o) };
  },attestLock(o.node),o.signal,{busy:owner => attestBusyText(o.node,owner),activity:`trunk probe ${o.node}`});
}
export function trunkProbeText(r: TrunkProbeResult): string {
  return r.checks.map(c => {
    const failed = c.observations.findIndex(e => e.kind === 'obs' && e.verdict !== 'pass'), e = c.observations[failed];
    const outcome = failed < 0 ? `${c.observations.length} run(s), all passed` : `run ${failed + 1} failed: ${e?.kind === 'obs' ? e.failed?.join(', ') || e.note || e.verdict : 'unknown failed tests'}`;
    return `trunk probe ${c.obligation} on ${r.trunk.slice(0,12)}: ${outcome} (${c.observations.map(e => `#${e.seq}`).join(', ')})`;
  }).join('\n');
}
export async function attest(o: MeasurementContext & { node: string; rerun?: boolean; remeasure?: boolean; all?: boolean }): Promise<AttestResult> {
  checkAbort(o.signal);
  if (!measuringScope()) return withMeasuring(o.cwd,o.node,() => attest(o));
  if (!measurementScope()) return leased({...o,priority:10}, signal => attest({ ...o, signal }));
  const ledger = await Ledger.open(o.cwd);
  if (o.remeasure) return ledger.withLock(async () => {
    await measuringRunning();
    const r = await remeasureMerge(o,ledger), card = await why(o);
    return { node:o.node, observations:r.recorded, superseded:r.superseded, accepted:card.accepted, receipt:card, remeasured:r.remeasured };
  },attestLock(o.node),o.signal,{ busy:owner => attestBusyText(o.node,owner), activity:`attest ${o.node}` });
  return ledger.withLock(async () => {
    await measuringRunning();
    const { state } = await load(ledger), n = candidate(state,o.node), jobs = attestJobs(state,o.node);
    if (o.rerun) for (const c of state.plan.nodes.find(x => x.id === o.node)!.checks) for (const kind of ['check', ...(c.red ? ['red'] : [])] as ('check'|'red')[]) {
      const obligation = `${kind}:${c.id}`, key = n.candidate!.keys[obligation]!;
      if (!jobs.some(j => j.key === key && j.obligation === obligation)) jobs.push(quarantinedJob(state,{kind,subject:o.node,obligation,key,spec:c,commit:n.candidate!.commit,base:n.slot!.base}));
    }
    if (o.rerun && !jobs.some(j => j.obligation === 'writes' && j.key === n.candidate!.keys.writes)) jobs.push({ kind:'writes',subject:o.node,obligation:'writes',key:n.candidate!.keys.writes!,commit:n.candidate!.commit,base:n.slot!.base });
    const r = await runJobs(o.cwd,ledger,state,[...genesisJobs(state),...jobs],o.signal), card = await why(o);
    return { node:o.node, observations:r.recorded, superseded:r.superseded, accepted:card.accepted, receipt:card };
  },attestLock(o.node),o.signal,{ busy:owner => attestBusyText(o.node,owner), activity:`attest ${o.node}` });
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
  if ('conflicts' in built) throw new OwedError(`rebase needed: run owed rebase ${o.node}, then rebase the worktree and submit again; conflicts with trunk: ${built.conflicts.map(oneLine).join(', ')}`);
  const m = await mergeFacts(o.cwd,state,o.node,built.commit), jobs = remeasureJobs(state,o.node,m,o.all);
  const run = await measureAll(jobs,parallelOf(state.plan),o.signal,async job => ({ ...await runJob({cwd:o.cwd,ledger,plan:state.plan,signal:o.signal,quarantineFeedback:true},job), merging:o.node }) as Draft);
  const observations = await automaticInvariantResults(o.cwd,ledger,state,jobs,run.observations.filter((x): x is Draft => x !== undefined),o.signal);
  if (run.aborted || o.signal?.aborted) return abortWith(ledger,state,observations,o.node);
  return ledger.withLock(async () => {
    const latest = await load(ledger); nodeStable(state,latest,o.node);
    const moved = latest.state.planSha !== state.planSha || !!await git.trunkDrift(o.cwd,state.trunk.name,state.trunk.commit);
    const kept: Draft[] = [];
    if (!moved) for (const d of observations) {
      const current = prospective(latest,kept); tagInfra(current,d);
      if (!validateDraft(current,d).length) kept.push(d);
    }
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
const heldBy = (o: LockOwner): string => `pid ${o.pid} on ${o.host} since ${clockTime(o.ts)}${lockActivityText(o)}`;
/** K1: the `busy` message of an attest of `node` while another attest of it holds its lock. */
export const attestBusyText = (node: string, owner: LockOwner): string => `attest of ${node} is already running (${heldBy(owner)}); its observations will appear in owed why ${node}`;
/** `needs: 'parent'` marks a block that needs a parent ruling (D18); the ledger refuses it on an ok verdict. */
/**
 * `named` (G1): the candidate the caller judged (commit or prefix); `pin`: the candidate an owner confirmation showed;
 * either refuses at append time when the open candidate differs. `from`: further working directories of the calling
 * process for the writer-worktree rail (G2.1; o.cwd and process.cwd() are always checked).
 */
export async function review(o: Actor & { node: string; verdict:'ok'|'block'; rank:number; note:string; ack_rulings?:number|'latest'; obligation?:'review'|'closure-review'; needs?:'parent'; named?: string; pin?: CandidatePin; from?: string[]; model?: string }): Promise<RecordedAct & { warnings?: string[] }> {
  const given = candidateArg(o.named), ledger = await Ledger.open(o.cwd);
  const modelState = (await readState(o)).state;
  const measuredModel = await recordedModel(o.cwd,modelState,o.node,by(o),o.model);
  const entry = await mutateAct(o,async s => { node(s,o.node); named(s,o.node,given); pinned(s,o.node,o.pin); await writerTree(s,o.node,[o.cwd,process.cwd(),...(o.from ?? [])]); const n = candidate(s,o.node), obligation = o.obligation ?? 'review'; const model = o.model ?? (n.slot?.attempt === modelState.nodes[o.node]?.slot?.attempt && n.candidate?.seq === modelState.nodes[o.node]?.candidate?.seq ? measuredModel : undefined); const required = Math.max(0, ...applicableRules(s,o.node).map(r => r.seq));
    const ack = o.ack_rulings === 'latest' ? required : o.ack_rulings ?? await launchedReviewAck(s,o.node,by(o),async sha => (await ledger.getBlob(sha)).toString());
    if (required > 0 && (ack === undefined || ack < required)) throw new OwedError(`ack-rulings must be at least ${required} (the latest ruling for ${o.node}); rerun with --ack-rulings ${required} or --ack-rulings latest`, 'usage');
    return { kind:'review',by:by(o),channel:o.channel,node:o.node,attempt:n.slot!.attempt,obligation,key:n.candidate!.keys[obligation] ?? '',verdict:o.verdict,rank:o.rank,note:o.note,ack_rulings:ack,...(model !== undefined ? { model } : {}),...(o.needs !== undefined ? { needs:o.needs } : {}) }; });
  return entry;
}
/** `named` (G1) and `pin` (an owner confirmation's candidate) refuse at append time when the open candidate differs. */
export async function waive(o: Actor & { node:string; obligation:string; reason:string; accept_risk?:number[]; tracked_by?:string; channel:Channel; named?: string; pin?: CandidatePin }): Promise<RecordedAct & { scope: { on:'merge'|'candidate'; trunk?:string } }> {
  const given = candidateArg(o.named);
  let scope: { on:'merge'|'candidate'; trunk?:string } = {on:'candidate'};
  const act = await mutateAct(o,async s => {
    node(s,o.node); named(s,o.node,given); pinned(s,o.node,o.pin);
    if (o.tracked_by !== undefined && (typeof o.tracked_by !== 'string' || !s.plan.nodes.some(n => n.id === o.tracked_by) || s.nodes[o.tracked_by]?.merged || o.tracked_by === o.node)) throw new OwedError('tracked_by must name an unmerged node of the current plan other than the waived node','usage');
    const tracked = o.tracked_by !== undefined ? {tracked_by:o.tracked_by} : {};
    const n = candidate(s,o.node);
    const risks = o.accept_risk ?? [], inactive = risks.filter(seq => !activeRisk(s,o.node,o.obligation,seq));
    const allMerge = risks.length > 0 && risks.every(seq => { const e = entriesOf(s).find(e => e.seq === seq); return e?.kind === 'obs' && !!mergeRisk(s,o.node,o.obligation,seq,e.key); });
    let key = n.candidate!.keys[o.obligation] ?? '';
    const trackingOnly = trackedRiskRetry(s,{kind:'waive',by:by(o),channel:o.channel,node:o.node,obligation:o.obligation,key,reason:o.reason,accept_risk:o.accept_risk,...tracked});
    if ((inactive.length || allMerge) && o.as.role === 'owner' && !trackingOnly) {
      const refused = (): never => { throw new OwedError('accept_risk must reference active blocks for this obligation'); };
      if (inactive.some(seq => {
        const e = entriesOf(s).find(e => e.seq === seq);
        return e?.kind !== 'obs' || !mergeRisk(s,o.node,o.obligation,seq,e.key);
      })) {
        // A candidate-key retry may cite risks it already consumed. Merge risks below must first recompute their key.
        const repeated = identicalAct(s,{ kind:'waive', by:by(o), channel:o.channel, node:o.node, obligation:o.obligation, key, reason:o.reason, accept_risk:o.accept_risk, ...tracked });
        return repeated ?? refused();
      }
      if (inactive.length) {
        const drift = await git.trunkDrift(o.cwd,s.trunk.name,s.trunk.commit);
        if (drift) throw new OwedError(`trunk changed (CAS): ${driftText(drift)}`);
      }
      const built = await git.buildMerge(o.cwd,s.trunk.commit,n.candidate!.commit,`owed merge ${o.node}`);
      if ('conflicts' in built) { if (inactive.length) return refused(); }
      else {
        const m = await mergeFacts(o.cwd,s,o.node,built.commit), mergeKey = m.facts.keys[o.obligation] ?? '';
        const matches = !!mergeKey && risks.every(seq => activeRisk(s,o.node,o.obligation,seq) ? n.blocks.find(b => b.seq === seq)?.key === mergeKey : !!mergeRisk(s,o.node,o.obligation,seq,mergeKey));
        if (!matches) { if (inactive.length) return refused(); }
        else {
          key = mergeKey;
          // Same ledger lock as the append; Git refs can still move independently of the ledger.
          const after = await git.trunkDrift(o.cwd,s.trunk.name,s.trunk.commit);
          if (after) throw new OwedError(`trunk changed (CAS): ${driftText(after)}`);
          scope = {on:'merge',trunk:s.trunk.commit};
        }
      }
    }
    return {kind:'waive',by:by(o),channel:o.channel,node:o.node,obligation:o.obligation,key,reason:o.reason,accept_risk:o.accept_risk,...tracked};
  });
  return {...act,scope};
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
  return ledger.withLock(async () => {
    const prepared = await ledger.withLock(async () => {
      const { state:s, entries } = await load(ledger), n = s.nodes[o.node], slot = n?.slot;
      const d = entries.find(e => e.kind === 'dispatch' && e.node === o.node && e.attempt === o.attempt);
      if (!slot || slot.attempt !== o.attempt || d?.by !== DRIVER || n!.runs.find(r => r.attempt === o.attempt)?.launches.some(l => l.role === 'writer')) return undefined;
      const cause = !s.plan.nodes.some(x => x.id === o.node) ? 'node left the plan' : n!.held !== undefined ? `held by abandon #${n!.held}` : !slot.open ? 'attempt was abandoned' : undefined;
      if (!cause) return undefined;
      if (slot.open) {
        const a: Draft = { kind:'abandon', by:DRIVER, node:o.node, attempt:o.attempt, reason:`stale writer launch: ${cause}` };
        guard(s,a); await ledger.append([a]);
      }
      return { slot, entries, cause };
    });
    if (!prepared) return undefined;
    const { slot, entries, cause } = prepared;
    // No launch intent means no writer could have run through the driver. Keep commits, dirty/locked trees and
    // ambiguous branch registrations; never force removal. The ref deletion compares against the recorded base.
    const trees = await git.listWorktrees(root), tree = trees.find(w => resolve(w.path) === resolve(slot.worktree));
    const nested = trees.some(w => w !== tree && resolve(w.path).startsWith(`${resolve(slot.worktree)}${sep}`));
    if (tree && !tree.locked && !nested && await git.revParse(tree.path,'HEAD') === slot.base && await git.isClean(tree.path)) {
      const r = await git.git(root,['worktree','remove',tree.path],{ allowFail:true });
      if (!r.code && !entries.some(e => e.kind === 'dispatch' && e.branch === slot.branch && (e.node !== o.node || e.attempt !== o.attempt)) && !(await git.listWorktrees(root)).some(w => w.branch === `refs/heads/${slot.branch}`)) await git.git(root,['update-ref','-d',`refs/heads/${slot.branch}`,slot.base],{ allowFail:true });
    }
    return cause;
  }, 'dispatch');
}
export async function recordedPlanReceipt(o: Context & { entry: Entry }): Promise<string> {
  const ledger = await Ledger.open(o.cwd), e = o.entry;
  if (e.kind !== 'plan') return renderEntry(e);
  const { state } = await load(ledger), prior = planAt(state,e.seq), next = planAt(state,e.seq+1);
  return planReceipt(e, prior, next);
}
/** ER1: explicit merge base is C's recorded base, not Git's heuristic merge-base. No tree equality, no carry. */
async function addReviewCarry(cwd: string, s: State, node: string, facts: CandidateFacts): Promise<void> {
  const source = reviewCarrySource(s,node,facts);
  if (!source || source.previous.facts.commit === facts.commit && !source.previous.facts.carry) return;
  const previous = source.previous.facts;
  const merged = await git.git(cwd,['merge-tree','--write-tree','--merge-base',previous.base,facts.base,previous.commit],{allowFail:true,timeoutMs:15_000});
  if (!merged.code && merged.stdout.trim().split('\n')[0] === facts.tree) facts.carry = { from:previous.commit, reviews:source.reviews };
}
export interface RebaseResult { node: string; attempt: number; worktree: string; branch: string; base: string; from: string; previous?: { base: string; commit: string; submit: number }; packet: string; entry: Entry; applied?: boolean; submit?: Entry; conflicts?: string[]; error?: string; callerAssertion?: string }
/** Moves the open slot of a node onto the current trunk (parent/owner or the slot writer); the writer then rebases the same worktree and submits again. `since`: as for launch (F1). */
/** ER2: shared by rebase and every writer launch/send intent; always before the ledger lock. */
export const slotOperationLock = (node: string): string => `rebase-${sha256(node).slice(0,16)}`;
type RebaseOptions = Actor & { node:string; since?: number; apply?: boolean; /** Internal driver supplies a fresh current-generation check through its dsa adapter. */ writerIdle?: () => Promise<boolean>; automatic?: boolean };
export async function rebase(o: RebaseOptions): Promise<RebaseResult> {
  assertNoLedgerLock();
  const ledger = await Ledger.open(o.cwd);
  return ledger.withLock(() => rebaseInternal(o),slotOperationLock(o.node));
}
async function rebaseInternal(o: RebaseOptions): Promise<RebaseResult> {
  if (o.apply) {
    const applied = await applyRebase(o);
    if (applied) return applied;
  }
  const entry = await mutate(o,s => { const n = node(s,o.node); if (!n.slot?.open) throw new OwedError(`Node ${o.node} has no open writer slot`); return {kind:'rebase',by:by(o),channel:o.channel,node:o.node,attempt:n.slot.attempt,base:s.trunk.commit,from:n.slot.base}; },{ node:o.node, since:o.since });
  if (entry.kind !== 'rebase') throw new OwedError('unexpected rebase entry','internal');
  const { state } = await load(await Ledger.open(o.cwd)), slot = state.nodes[o.node]!.slot!, previous = slot.rebase?.seq === entry.seq ? slot.rebase.previous : undefined;
  const work = await rebasePending(state, o.node, true);
  const packet = ['moved the slot base; the writer must rebase and resubmit (use --apply to rebase as executor)', WRITER_DECISION, `# Rebase ${o.node} attempt ${entry.attempt} (ledger #${entry.seq})`, `Working directory: ${slot.worktree}`, ...(work?.recovery ? [work.recovery] : []), `Trunk moved: slot base ${entry.from} → ${entry.base}. The open candidate is invalidated; blocks still bind the node.`, `First commit your work, then run: ${work?.command ?? `git rebase --onto ${entry.base} $(git merge-base HEAD ${entry.base})`}`, 'Resolve conflicts only; keep the change within the allowed writes and commit.', `Then run: owed submit ${o.node} (the commit must descend from ${entry.base})`, ...(previous ? [`Previously reviewed patch: ${previous.base}..${previous.commit} (submit #${previous.submit})`, `Re-review hint: git range-diff ${previous.base}..${previous.commit} ${entry.base}..<new commit>`] : [])].join('\n');
  return { node:o.node, attempt:entry.attempt, worktree:slot.worktree, branch:slot.branch, base:entry.base, from:entry.from, ...(previous ? { previous } : {}), packet, entry };
}
/** ER2: slot mutation lock precedes ledger lock. Git never runs under the ledger lock; the final CAS records both receipts. */
async function applyRebase(o: Actor & { node:string; since?: number; writerIdle?: () => Promise<boolean>; automatic?: boolean }): Promise<RebaseResult | undefined> {
  owner(o);
  if (!['parent','owner'].includes(o.as.role)) throw new OwedError('rebase --apply requires parent/owner; the writer uses the manual rebase route');
  const ledger = await Ledger.open(o.cwd);
  {
    const snapshot = await load(ledger), s = snapshot.state, n = node(s,o.node), slot = n.slot;
    if (!slot?.open) throw new OwedError(`Node ${o.node} has no open writer slot`);
    decidedOn(snapshot.entries,o.node,o.since);
    const d: Draft = {kind:'rebase',by:by(o),channel:o.channel,node:o.node,attempt:slot.attempt,base:s.trunk.commit,from:slot.base};
    guard(s,d);
    const writer = n.runs.find(r => r.attempt === slot.attempt)?.launches.find(l => l.role === 'writer');
    const intent = snapshot.entries.findLast(e => e.seq > (n.candidate?.seq ?? -1) && 'node' in e && e.node === o.node && (e.kind === 'launch' && e.role === 'writer' || e.kind === 'send' && e.rid === writer?.rid && e.sendKind === 'follow-up'));
    let idle = !writer && !o.automatic && ['parent','owner'].includes(o.as.role);
    if (writer && !intent) {
      if (o.writerIdle && by(o) === DRIVER) idle = await o.writerIdle();
      else { const { Dsa } = await import('./dsa.ts'); try {
        const dsa = new Dsa({cwd:o.cwd,timeoutMs:5000}), inspected = await dsa.inspect(writer.rid);
        idle = inspected.view.state === 'sealed';
        // A prior follow-up can have a newer generation than describe: compare its durable applied receipt.
        const followup = n.runs.find(r => r.attempt === slot.attempt)?.sends.findLast(e => e.rid === writer.rid && e.sendKind === 'follow-up');
        if (idle && followup) {
          // This request id is an owed-recorded intent the driver would deliver anyway; a new delivery advances generation and makes idle false.
          const bytes = await ledger.getBlob(followup.message), delivered = await dsa.send(followup.send,writer.rid,'follow-up',bytes);
          idle = delivered.outcome === 'applied' && (delivered.generation === undefined || inspected.gen !== undefined && inspected.gen >= delivered.generation);
        }
      } catch { idle = false; } }
    }
    const head = await git.revParse(slot.worktree,'HEAD');
    const inProgress = await slotGitOperation(slot.worktree);
    const recovery = rebaseRecovery(head,n.candidate?.commit,inProgress,s.trunk.commit,o.node);
    const refuse = !writer && o.automatic ? 'no recorded writer run' : !idle ? 'writer run is live, unknown or has a pending intent' : inProgress ? 'slot has a rebase or merge in progress' : !await git.isClean(slot.worktree) ? 'slot worktree is dirty' : !n.candidate || head !== n.candidate.commit ? 'slot HEAD is not the current candidate' : undefined;
    if (refuse) {
      if (o.automatic) {
        const fallback = await rebaseInternal({...o,apply:false});
        return {...fallback,packet:recovery ? `${recovery}\n${fallback.packet}` : fallback.packet};
      }
      throw new OwedError(`rebase --apply refused: ${refuse}; ${recovery ?? 'finish the writer work and submit first'}`);
    }
    const target = s.trunk.commit;
    let rebased: string | undefined, conflicts: string[] = [], error: string | undefined;
    try {
      // SB2: do not replay trunk commits already merged into the writer branch.
      const upstream = await trunkUpstream(slot.worktree,head,target,slot.base);
      const r = await git.git(slot.worktree,['rebase','--onto',target,upstream],{allowFail:true,timeoutMs:60_000,env:{GIT_EDITOR:'true',GIT_SEQUENCE_EDITOR:'true'}});
      if (r.code) {
        conflicts = (await git.git(slot.worktree,['diff','--name-only','--diff-filter=U','-z'])).stdout.split('\0').filter(Boolean);
        throw new OwedError(`git rebase failed: ${r.stderr.trim().replace(/\s+/g,' ')}`);
      }
      rebased = await git.revParse(slot.worktree,'HEAD');
      if (await slotGitInProgress(slot.worktree) || !await git.isClean(slot.worktree) || !await git.isAncestor(o.cwd,target,rebased)) throw new OwedError('rebase did not leave a clean descendant of the new base');
      await git.checkCandidateLimits(o.cwd,s.plan.limits,target,rebased);
      const spec = s.plan.nodes.find(x => x.id === o.node)!, facts = await git.candidateFacts(o.cwd,s.plan,spec,target,rebased,slot.attempt,stateQuarantine(s));
      Object.assign(facts.keys,manualKeys(spec,facts.patch)); facts.rebased = true;
      await addReviewCarry(o.cwd,s,o.node,facts);
      // Recheck immediately before the append lock; the node op lock still excludes all owed writer intents.
      if (await git.revParse(slot.worktree,'HEAD') !== rebased || await slotGitInProgress(slot.worktree) || !await git.isClean(slot.worktree)) throw new OwedError('slot changed during executor rebase; nothing recorded');
      return await ledger.withLock(async () => {
        const latest = await load(ledger); stable(s,latest.state,o.node); decidedOn(latest.entries,o.node,o.since);
        guard(latest.state,d);
        const submit: Draft = {kind:'submit',by:'executor:owed',node:o.node,attempt:slot.attempt,facts};
        guard(prospective(latest,[d]),submit);
        const [entry,submitted] = await ledger.append([d,submit]);
        return {node:o.node,attempt:slot.attempt,worktree:slot.worktree,branch:slot.branch,base:target,from:slot.base,entry:entry!,submit:submitted!,applied:true,packet:`owed rebased your worktree onto ${target.slice(0,12)} (clean); continue from HEAD\n${WRITER_DECISION}`,...(!writer ? {callerAssertion:`no recorded writer run; caller asserts none is active in ${oneLine(slot.worktree)}`} : {})};
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      await git.git(slot.worktree,['rebase','--abort'],{allowFail:true,timeoutMs:15_000});
      // A successful Git rebase followed by a stale ledger result is ours to roll back only while HEAD/tree are still ours.
      if (rebased && await git.revParse(slot.worktree,'HEAD') === rebased && await git.isClean(slot.worktree)) await git.git(slot.worktree,['reset','--hard',head],{timeoutMs:15_000});
      if (await git.revParse(slot.worktree,'HEAD') !== head || await slotGitInProgress(slot.worktree) || !await git.isClean(slot.worktree)) throw new OwedError(`${error}; rebase rollback failed: HEAD/tree not restored; inspect ${slot.worktree}`,'internal');
      if (e instanceof OwedError && (e.code === 'stale' || e.message.includes('changed; retry'))) throw e;
    }
    // Conflict/error: rollback is proved before the old writer route invalidates the candidate.
    const fallback = await rebaseInternal({...o,apply:false});
    return {...fallback,applied:false,conflicts,error};
  }
}
export async function merge(o: Actor & { node:string; signal?: AbortSignal; lease?: boolean }): Promise<MergeResult> {
  owner(o); if (!['owner','parent'].includes(o.as.role)) throw new OwedError('merge requires parent/owner');
  checkAbort(o.signal);
  if (!measurementScope()) return leased({...o,priority:10}, signal => merge({ ...o, signal }));
  const ledger = await Ledger.open(o.cwd);
  return ledger.withLock(async () => {
    if (by(o) === DRIVER) {
      const pending = await pendingAdopt(ledger.dir);
      if (pending) throw new OwedError(`merge waiting for ${adoptPendingReason(pending)}; retry next pass`,'busy');
    }
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
    if ('conflicts' in built) throw new OwedError(`rebase needed: run owed rebase ${o.node}, then rebase the worktree and submit again; conflicts with trunk: ${built.conflicts.map(oneLine).join(', ')}`);
    const m = await mergeFacts(o.cwd,state,o.node,built.commit);
    // Genesis jobs are not about this merge; merge-result jobs record the node being merged (decoy attribution).
    // M1: up to exec.parallel jobs at once, observations in job order. An aborted run (D16) is not measured, no further
    // job starts, and the merge stops before trunk moves, keeping the completed observations (abortWith).
    const jobs = [...genesisJobs(state).map(job => ({ job, merging: false })),...mergeJobs(state,o.node,m).map(job => ({ job, merging: true }))];
    const run = await measureAll(jobs,parallelOf(state.plan),o.signal,async ({ job, merging }) => { const obs = await runJob({cwd:o.cwd,ledger,plan:state.plan,signal:o.signal,quarantineFeedback:merging},job); return merging ? await mergeFailureOutput(ledger,{...obs,merging:o.node}) : obs; });
    const observations = await automaticInvariantResults(o.cwd,ledger,state,jobs.map(j => j.job),run.observations.filter((x): x is Draft => x !== undefined),o.signal);
    if (run.aborted || o.signal?.aborted) return abortWith(ledger,state,observations,o.node);
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
      const obs = await runTrunkProbe(o,ledger,state,n,{kind:'check',subject:o.node,obligation:i.obligation,key,spec,commit:state.trunk.commit,base:state.trunk.commit,probe:'trunk'});
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
      let g = spec ? mergeGuard(current,o.node,lm) : undefined;
      // A job of the latest state this run did not measure (a key the plan update introduced) refuses; a retry measures it.
      const missed = spec ? unmeasured(current,o.node,lm,observations) : [];
      // FS6: owner-allowed executor defers of shared intermittent invariant failures, kept only when the merge then passes.
      let defers = g && !g.ok && !missed.length ? allowanceDefers(current,o.node,g) : [], guarded = current;
      if (defers.length) {
        const after = prospective({...latest,state:current},defers), retried = mergeGuard(after,o.node,lm);
        if (retried.ok) { g = retried; guarded = after; } else defers = [];
      }
      if (g) reasons.push(...g.reasons);
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
        const lead = await mergeTreeBreakLead(o.cwd,current,o.node,[built.commit],failedObs.filter(e => e.subject === 'trunk'));
        const automatic = automaticRemeasureHints(current,g?.invItems ?? [],o.node);
        const reused = reusedHint(o.node,failedObs.filter(e => e.subject === 'trunk' && e.seq <= latest.state.seq && !automatic.keys.has(e.key)),Date.now(),by(o) === DRIVER);
        // FS1: the shared remedy is the first sentence; FS3: the bound names itself.
        const first = lead[0]?.startsWith(SHARED_LEAD) || lead[0]?.startsWith('setup failure (no tests ran):') ? [...lead, ...automatic.lines] : [...automatic.lines, ...lead], bound = sharedBoundText(current,o.node);
        const text = [...first, ...new Set(trunkRed), ...failures, ...reasons, ...deferBoundHints(current,o.node,g?.invItems ?? []), ...slotBaseRed, ...mergeFailureHints(current,o.node,failedObs), ...(reused ? [reused] : []), ...(bound ? [bound] : [])].join('; ');
        const parks = !missed.length && g ? parkedRefusal(current,o.node,reasons,g) : [];
        throw parks.length ? new SharedRefusal(text,parks) : new OwedError(text);
      }
      const d: Draft = {kind:'merge',by:'executor:owed',node:o.node,attempt:n.slot!.attempt,prior:state.trunk.commit,commit:built.commit,facts:lm.facts,state:lm.state,...leaseWaitField()}; guard(guarded,d);
      await git.advanceTrunk(o.cwd,state.trunk.name,state.trunk.commit,built.commit);
      const entry = (await ledger.append([...kept,...defers,d])).at(-1)!;
      return {node:o.node,...built,entry,deferred:g.invItems.filter(i => i.status === 'D'),unguarded:unguardedPaths(current.plan,lm.facts.changed)};
    },undefined,o.signal);
  },'merge',o.signal,{activity:`merge ${o.node}`});
}
// ---------- batch merge (merge train, MT) ----------
export interface BatchMergeResult { nodes: string[]; commit: string; entries: Entry[]; dropped: string[]; lease?: string; /** QT4: per member, the deferred items left on this merge's keys (as MergeResult.deferred). */ deferred?: Record<string, ItemView[]> }
/** MT: refusal prefix of a batch merge that measured or decided nothing for single members; they merge one at a time. */
export const BATCH_REFUSED = 'batch merge ';
/** MT1: the requested members in merge-queue order; refuses a member that cannot be batched, naming why. */
function batchMembers(s: State, ids: string[], rt?: Runtime): string[] {
  if (new Set(ids).size !== ids.length || ids.length < 2) throw new OwedError('batch merge needs at least 2 distinct nodes: owed merge A,B[,...]', 'usage');
  for (const id of ids) {
    const n = candidate(s, id), spec = s.plan.nodes.find(x => x.id === id);
    if (!batchable(s, id)) throw new OwedError(`${BATCH_REFUSED}refused: ${id} ${n.candidate!.closureTouched ? 'touches the closure' : !n.accepted ? spec?.approve && n.items.some(i => i.obligation === 'approve' && i.status === 'D') ? 'needs owner approval' : 'is not accepted' : 'has a remeasure due'}; ${nodeNext(s, id, rt)}`);
  }
  const queue = mergeQueue(s), order = ids.slice().sort((a, b) => queue.indexOf(a) - queue.indexOf(b));
  for (const [i, a] of order.entries()) for (const b of order.slice(i + 1)) if (effectiveWritesOverlap(s, a, b)) throw new OwedError(`${BATCH_REFUSED}refused: writes of ${a} and ${b} overlap; merge them one at a time`);
  return order;
}
/** MT2/MT3: per member, its merge facts against the previous batch commit and its check keys on the final tree. */
async function batchFacts(cwd: string, s: State, chain: { id: string; prior: string; commit: string }[], from = 0): Promise<{ facts: CandidateFacts; state: StateFacts; keys: Record<string, string> }[]> {
  const members = chain.map(c => c.id), final = chain.at(-1)!.commit, qn = batchQuarantine(s, members), out = [];
  for (const [i, c] of chain.entries()) {
    if (i < from) continue;
    const spec = s.plan.nodes.find(x => x.id === c.id)!, q = quarantineNames(s.plan, id => !!s.nodes[id]?.merged || members.slice(0, i).includes(id), c.id);
    const facts = await git.candidateFacts(cwd, s.plan, spec, c.prior, c.commit, s.nodes[c.id]!.slot!.attempt, q), keys: Record<string, string> = {};
    for (const k of spec.checks) keys[`check:${k.id}`] = await git.trunkCheckKey(cwd, s.plan, k, final, qn);
    out.push({ facts, state: i === chain.length - 1 ? await git.stateFacts(cwd, s.plan, c.commit, qn) : await git.stateFacts(cwd, s.plan, c.commit, q), keys });
  }
  return out;
}
/**
 * Ruling #2110: a ledger tail that holds an incomplete batch merge (a crash between appended member entries) while the
 * trunk ref is at `batch.final` is completed under the ledger lock before any other write: the missing member merges
 * are rebuilt from the batch metadata (Mi = the first-parent chain of Mn) and recorded as executor. Runs on every
 * ledger-lock acquisition; reads only the last ledger line unless a batch is open.
 */
/** @internal Test hook: bytes read by the batch-tail probe, before any full ledger load. */
export const batchTailProbe: { onRead?: (bytes: number) => void } = {};
async function completeBatchTail(ledger: Ledger): Promise<void> {
  const cwd = ledger.repo; if (!cwd) return;
  let line: string | undefined;
  try {
    const file = await openFile(join(ledger.dir, 'ledger.jsonl'), 'r');
    try {
      let position = (await file.stat()).size, tail = Buffer.alloc(0);
      while (position > 0) {
        const chunk = Buffer.alloc(Math.min(position, 64 * 1024));
        position -= chunk.length;
        let read = 0;
        while (read < chunk.length) {
          const { bytesRead } = await file.read(chunk, read, chunk.length - read, position + read);
          batchTailProbe.onRead?.(bytesRead);
          if (!bytesRead) return;
          read += bytesRead;
        }
        tail = Buffer.concat([chunk, tail]);
        const text = tail.toString('utf8').trimEnd(), start = text.lastIndexOf('\n');
        if (start >= 0 || position === 0) { line = text.slice(start + 1); break; }
      }
    } finally { await file.close(); }
  } catch { return; }
  if (!line) return;
  let last: Entry; try { last = JSON.parse(line) as Entry; } catch { return; }
  if (last.kind !== 'merge' || !last.batch || last.batch.members.at(-1) === last.node) return;
  const { state } = await load(ledger), open = openBatch(state); if (!open) return;
  const b = open.batch!, at = b.members.indexOf(open.node);
  if (await git.revParse(cwd, `refs/heads/${state.trunk.name}`).catch(() => undefined) !== b.final) return;
  const chain: { id: string; prior: string; commit: string }[] = [];
  for (const [i, id] of b.members.entries()) chain.push({ id, prior: i ? chain[i - 1]!.commit : '', commit: await git.revParse(cwd, `${b.final}~${b.members.length - 1 - i}`) });
  if (chain[at]!.commit !== open.commit) throw new OwedError(`batch merge of ${b.members.join(', ')} is incomplete and its commits do not match the trunk history; the ledger tail and trunk disagree and need manual repair if trunk history no longer contains the batch commits; otherwise restore refs/heads/${state.trunk.name} to ${b.final} (e.g. from the reflog: git update-ref refs/heads/${state.trunk.name} ${b.final}), then any owed write completes the batch`);
  const facts = await batchFacts(cwd, state, chain, at + 1), drafts: Draft[] = chain.slice(at + 1).map((c, j) => ({ kind:'merge', by:'executor:owed', node:c.id, attempt:state.nodes[c.id]!.slot!.attempt, prior:c.prior, commit:c.commit, facts:facts[j]!.facts, state:facts[j]!.state, batch:b }));
  const loaded = await load(ledger), reasons = batchGuard(loaded, loaded.state, drafts);
  if (reasons.length) throw new OwedError(`batch merge of ${b.members.join(', ')} is incomplete and cannot be completed: ${reasons.join('; ')}`);
  await ledger.append(drafts);
}
Ledger.onLock = completeBatchTail;
/** Ruling #2110: what `owed verify` says about an incomplete batch merge at the ledger tail. */
function incompleteBatchText(s: State): string | undefined {
  const open = openBatch(s), b = open?.batch;
  if (!open || !b) return undefined;
  const missing = b.members.slice(b.members.indexOf(open.node) + 1);
  return `batch merge of ${b.members.join(', ')} is incomplete after #${open.seq} (${open.node}); missing: ${missing.join(', ')}; restore refs/heads/${s.trunk.name} to ${b.final} (e.g. from the reflog: git update-ref refs/heads/${s.trunk.name} ${b.final}), then any owed write completes the batch; if trunk history no longer contains the batch commits, the ledger tail and trunk disagree and need manual repair`;
}
/** WA4: retain every global plan field and every member field; ignore only non-member node specs. */
function batchPlanChanges(prev: Plan, next: Plan, members: string[]): string[] {
  const project = (p: Plan) => ({ ...p, nodes:p.nodes.filter(n => members.includes(n.id)) });
  const a = project(prev), b = project(next);
  const changes = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => canonical(a[k as keyof Plan]) !== canonical(b[k as keyof Plan]));
  return changes.flatMap(k => k !== 'nodes' ? [k] : members.flatMap(id => {
    const x = a.nodes.find(n => n.id === id), y = b.nodes.find(n => n.id === id);
    if (!x || !y) return [`nodes.${id}`];
    return [...new Set([...Object.keys(x), ...Object.keys(y)])].filter(f => canonical(x[f as keyof NodeSpec]) !== canonical(y[f as keyof NodeSpec])).map(f => `nodes.${id}.${f}`);
  })).concat(changes.includes('nodes') && canonical(a.nodes.map(n => n.id)) !== canonical(b.nodes.map(n => n.id)) ? ['nodes order'] : [], writesSyntax(prev) !== writesSyntax(next) ? ['writes syntax'] : []);
}
/** MT3: errors of appending the member merge `drafts` in order after `current` (each judged on the state after the previous). */
function batchGuard(latest: Awaited<ReturnType<typeof load>>, current: State, drafts: Draft[], deferred?: Record<string, ItemView[]>): string[] {
  let s = current, own = false;
  for (const d of drafts) {
    const errors = validateDraft(s, d);
    if (errors.length) return errors.map(e => `${'node' in d ? d.node : '?'}: ${e}`);
    // QT4: the debt left on this member's merge keys, the same items a single merge reports as `deferred`.
    if (deferred && d.kind === 'merge') deferred[d.node] = mergeGuard(s, d.node, d).invItems.filter(i => i.status === 'D');
    const entry = { ...d, seq: s.seq + 1, ts: new Date().toISOString(), prev: s.head } as Entry;
    entry.hash = entryHash(entry); s = own ? extendState(s, [entry]) : reduceFrom(s, [entry], latest.lookup); own = true;
  }
  return [];
}
/**
 * MT: `owed merge A,B,...`: merge accepted, pairwise non-overlapping members as one merge train. M1 = merge(T, c1),
 * Mi = merge(M(i-1), ci); a conflicting member drops out (it merges alone later). Every invariant and every member's
 * node checks are measured once on Mn; on a pass one merge entry per member is appended and trunk advances once from T
 * to Mn (one CAS). On a fail the observations (tagged `batch`, never `merging`) are recorded and the merge is refused;
 * the members then merge one at a time and the same set is not batched again until trunk moves.
 */
export async function mergeBatch(o: Actor & { nodes: string[]; signal?: AbortSignal; lease?: boolean }): Promise<BatchMergeResult> {
  owner(o); if (!['owner','parent'].includes(o.as.role)) throw new OwedError('merge requires parent/owner');
  checkAbort(o.signal);
  if (!measurementScope()) return leased({...o,priority:10}, signal => mergeBatch({ ...o, signal }));
  const ledger = await Ledger.open(o.cwd);
  return ledger.withLock(async () => {
    let state = (await load(ledger)).state;
    const lock = readLock(ledger.dir);
    const rt = await assembleRuntime({ cwd: o.cwd, state, driverRunning: lock.state === 'live' || lock.state === 'foreign' });
    const ids = batchMembers(state, o.nodes, rt);
    { const drift = await git.trunkDrift(o.cwd,state.trunk.name,state.trunk.commit); if (drift) throw new OwedError(`trunk changed (CAS): ${driftText(drift)}`); }
    await attestTrunk({ cwd:o.cwd, signal:o.signal });
    const refreshed = await load(ledger); for (const id of ids) nodeStable(state,refreshed,id);
    state = refreshed.state;
    if (batchFailed(state, ids)) throw new OwedError(`${BATCH_REFUSED}of ${ids.join(', ')} already failed on trunk ${state.trunk.commit.slice(0,12)}; merge them one at a time: owed merge ${ids[0]}`);
    const chain: { id: string; prior: string; commit: string }[] = [], dropped: string[] = [];
    for (const id of ids) {
      const prior = chain.at(-1)?.commit ?? state.trunk.commit, built = await git.buildMerge(o.cwd,prior,state.nodes[id]!.candidate!.commit,`owed merge ${id} (batch)`);
      if ('conflicts' in built) dropped.push(id); else chain.push({ id, prior, commit: built.commit });
    }
    if (chain.length < 2) throw new OwedError(`${BATCH_REFUSED}of ${ids.join(', ')}: ${chain.length ? `only ${chain[0]!.id} merges` : 'no member merges'} cleanly onto the batch (conflicts: ${dropped.join(', ')}); merge them one at a time: owed merge ${ids[0]}`);
    const members = chain.map(c => c.id), final = chain.at(-1)!.commit, facts = await batchFacts(o.cwd,state,chain), batchState = facts.at(-1)!.state;
    const keys = Object.fromEntries(members.map((id, i) => [id, facts[i]!.keys]));
    const jobs = [...genesisJobs(state).map(job => ({ job, tag: false })), ...batchJobs(state,members,keys,batchState).map(job => ({ job, tag: true }))];
    const run = await measureAll(jobs,parallelOf(state.plan),o.signal,async ({ job, tag }) => { const obs = await runJob({cwd:o.cwd,ledger,plan:state.plan,signal:o.signal,quarantineFeedback:!!tag},job); if (!tag) return obs; const { remeasure_match: _match, ...tagged } = obs; return {...tagged,batch:members} as Draft; });
    const observations = run.observations.filter((x): x is Draft => x !== undefined);
    if (run.aborted) return abortWith(ledger,state,observations);
    return ledger.withLock(async () => {
      // MT3: CAS on the plan, the ledger trunk, every member's slot and candidate, and the trunk ref.
      const latest = await load(ledger);
      // Check every intervening plan, not just the final blob: a transient relevant change may invalidate receipts.
      for (const e of latest.entries) if (e.kind === 'plan' && e.seq > state.seq) {
        const changes = batchPlanChanges(planAt(latest.state,e.seq),planAt(latest.state,e.seq+1),members);
        if (changes.length) throw new OwedError(`batch merge refused: plan #${e.seq} changed ${changes.join(', ')}; retry`);
      }
      for (const id of members) nodeStable(state,latest,id);
      { const drift = await git.trunkDrift(o.cwd,state.trunk.name,state.trunk.commit); if (drift) throw new OwedError(`trunk changed (CAS): ${driftText(drift)}`); }
      if (latest.state.planSha !== state.planSha) {
        // Non-member specs can still affect quarantine activation. Recompute facts and refuse any difference.
        const now = await batchFacts(o.cwd,latest.state,chain);
        if (canonical(now) !== canonical(facts)) {
          const e = latest.entries.findLast(e => e.kind === 'plan' && e.seq > state.seq);
          throw new OwedError(`batch merge refused: plan #${e?.seq ?? '?'} changed measured facts (including active quarantine); retry`);
        }
      }
      const current = prospective(latest,observations);
      if (o.signal?.aborted) { if (observations.length) await ledger.append(observations); throw aborted(); }
      const drafts: Draft[] = chain.map((c, i) => ({ kind:'merge', by:'executor:owed', node:c.id, attempt:state.nodes[c.id]!.slot!.attempt, prior:c.prior, commit:c.commit, facts:facts[i]!.facts, state:facts[i]!.state, batch:{ final, state:batchState, keys, members }, ...leaseWaitField() }));
      const deferred: Record<string, ItemView[]> = {}, reasons = batchGuard(latest,current,drafts,deferred);
      if (reasons.length) {
        if (observations.length) await ledger.append(observations);
        const failed = observations.flatMap(d => d.kind === 'obs' && d.verdict === 'fail' ? [`${d.subject}/${d.obligation}: ${d.note ?? (d.failed?.length ? `failed tests: ${d.failed.join(', ')}` : 'failed')}`] : []);
        throw new OwedError(`${BATCH_REFUSED}of ${members.join(', ')} refused on batch tree ${final.slice(0,12)}: ${[...failed, ...reasons].join('; ')}; the members merge one at a time next (owed merge ${members[0]})`);
      }
      await git.advanceTrunk(o.cwd,state.trunk.name,state.trunk.commit,final);
      const appended = await ledger.append([...observations,...drafts]);
      return { nodes:members, commit:final, entries:appended.slice(observations.length), dropped, deferred };
    },undefined,o.signal);
  },'merge',o.signal);
}
/**
 * AT1: refusal lead when merge trees `commits` of `node` break an invariant trunk passes and trunk moved since the
 * slot base: the remedy is a rebase, never a waiver, sweep or adoption. Empty otherwise.
 */
/** AT1: the first words of the merge-tree break lead (the driver keeps it first in its halt text). */
export const MERGE_TREE_BREAK = 'merge tree does not pass ';
async function mergeTreeBreakLead(cwd: string, s: State, node: string, commits: string[], reused: readonly ObsEntry[] = []): Promise<string[]> {
  const fails = [...entriesOf(s).filter((e): e is ObsEntry => e.kind === 'obs' && e.merging === node && e.batch === undefined && e.verdict === 'fail' && commits.includes(e.commit)), ...reused];
  const setup = fails.find(e => observationsOf(s,e.subject,e.obligation,e.key).at(-1)?.seq === e.seq && setupFailure(s,e));
  if (setup) {
    const ledger = await Ledger.open(cwd), log = setup.log ? await ledger.getBlob(setup.log).then(b => b.toString()).catch(() => '') : '';
    return [setupHint(setupSignature(log || setup.note || ''),node)];
  }
  const shared = sharedLead(s,node,fails);
  if (shared) return [shared];
  const breaks = [...new Set(commits)].flatMap(c => mergeTreeBreaks(s,node,c)), base = s.nodes[node]?.slot?.base;
  if (!breaks.length || !base || base === s.trunk.commit) return [];
  const moved = await git.countCommits(cwd,base,s.trunk.commit).catch(() => 0);
  if (!moved) return [];
  return [`${MERGE_TREE_BREAK}${[...new Set(breaks.map(b => b.obligation))].join(', ')} (trunk passes); trunk moved ${moved} commits since the slot base: rebase → owed rebase ${node}`];
}
/** FS3: a merge refusal whose every reason is a parked shared or trunk-caused invariant (`parks`); the driver parks instead of halting. */
export class SharedRefusal extends OwedError {
  readonly parks: SharedPark[];
  constructor(message: string, parks: SharedPark[]) { super(message); this.parks = parks; }
}
/** FS3: the parks covering every refusal reason, or [] for a mixed refusal. */
function parkedRefusal(s: State, node: string, reasons: readonly string[], g: MergeGuard): SharedPark[] {
  const parks = sharedParked(s,node);
  // Ruling #2458 (F2): trunk-red needs the guard's own merge key = trunk key and an owner conflict ('new debt' never);
  // shared needs the measured key = the guard's merge key. Anything else is a mixed refusal and halts.
  const covered = (r: string): boolean => {
    const m = /^invariant (\S+) (new debt|owner conflict)/.exec(r);
    if (!m) return false;
    const id = m[1]!, key = g.invItems.find(i => i.obligation === `inv:${id}`)?.key, p = parks.find(x => x.obligation === `inv:${id}`);
    if (!p || key === undefined) return false;
    return p.kind === 'trunk-red' ? m[2] === 'owner conflict' && key === s.trunk.invKeys[id] && p.key === key : p.key === key;
  };
  return reasons.length && reasons.every(covered) ? parks : [];
}
/** FS6: executor defer drafts for every refused merge-key invariant an allow defer rule pre-authorizes. */
function allowanceDefers(s: State, node: string, g: MergeGuard): Draft[] {
  return g.invItems.flatMap(i => i.status === 'D' && i.mark !== '\u23f8' ? [allowanceDeferDraft(s,node,i.obligation.slice(4),i.key)].filter((d): d is Extract<Draft,{kind:'defer'}> => !!d) : []);
}
/** FS1: the shared-failure remedy replacing AT1 when every failing merge-tree observation is shared. */
export const SHARED_LEAD = 'shared failure: ';
function sharedLead(s: State, node: string, fails: readonly ObsEntry[]): string | undefined {
  const unique = [...new Map(fails.filter(e => e.merging === node && e.obligation.startsWith('inv:')).map(e => [e.seq, e])).values()];
  if (!unique.length) return undefined;
  const shared = unique.map(e => ({ e, r: sharedFailure(s,e,node) }));
  if (shared.some(x => !x.r)) return undefined;
  return shared.map(({ e, r }) => `${SHARED_LEAD}${e.obligation} ${sharedNames(r!.names)}${r!.nameOnly ? NAME_ONLY : ''} also failed on trunk without ${node} (#${r!.trunk.at(-1)!.seq}); not attributed to ${node}`).filter((x, i, a) => a.indexOf(x) === i).join('; ');
}
/** AT5: refused invariant debt whose owner defer was recorded on another merge key and does not carry. */
function deferBoundHints(s: State, node: string, items: ItemView[]): string[] {
  return items.flatMap(i => {
    if (i.status !== 'D' || i.mark === '\u23f8') return [];
    const d = carriedDefer(s,node,i.obligation.slice(4),i.key);
    return d && !d.carried ? [`defer #${d.defer.seq} was bound to merge key ${d.defer.key.slice(0,12)} (trunk moved)`] : [];
  });
}
/** PB1: runtime checkout roots are not ledger facts; the classified verdict/note use existing fields. */
async function runTrunkProbe(o: MeasurementContext, ledger: Ledger, state: State, n: NodeState, job: AttestJob): Promise<Awaited<ReturnType<typeof runJob>>> {
  let root: string | undefined;
  const obs = await runJob({cwd:o.cwd,ledger,plan:state.plan,signal:o.signal,quarantineFeedback:true,onTree:path => { root = path; }},quarantinedJob(state,job));
  if (obs.verdict === 'fail' && root && n.candidate && obs.log) {
    const path = await git.missingProbeAddition(o.cwd,n.candidate.base,n.candidate.commit,state.trunk.commit,root,(await ledger.getBlob(obs.log)).toString());
    if (path) { obs.verdict = 'error'; obs.note = boundedLine(`probe not applicable: trunk lacks ${path}, which the candidate adds`); }
  }
  return obs;
}
/** PB1/PB2: escape whole code points without splitting a control escape at the display bound. */
function boundedLine(text: string): string {
  let out = ''; for (const cp of text) { const escaped = oneLine(cp); if (out.length + escaped.length > 160) break; out += escaped; } return out;
}
/** PB2: append after the existing note so setup/timeout classification and historic note prefixes stay unchanged. */
async function mergeFailureOutput(ledger: Ledger, obs: Awaited<ReturnType<typeof runJob>> & { merging: string }): Promise<Draft> {
  if (obs.obligation.startsWith('check:') && obs.verdict === 'fail' && !obs.failed?.length && obs.log) {
    const tail = lastLines((await ledger.getBlob(obs.log)).toString(),1)[0];
    if (tail) obs.note = `${obs.note ?? ''}\nmerge failure output: ${boundedLine(tail)}`;
  }
  return obs;
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
    const automaticPair = obs.auto_remeasure && kept.some(first => first.kind === 'obs' && first.verdict === 'fail' && sameJob(first,obs) && first.merging === obs.merging);
    if (!automaticPair && !jobs.some(j => sameJob(j,obs))) continue;
    tagInfra(current,obs);
    if (validateDraft(current,obs).length) continue;
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
/** AD: pin the ref read under the merge lock; off-ref hotfixes require an unchanged ledger trunk. */
async function adoptable(cwd: string, s: State, commit?: string): Promise<AdoptPreview & { refCommit: string }> {
  const ref = `refs/heads/${s.trunk.name}`, prior = s.trunk.commit;
  const head = await git.git(cwd,['rev-parse','--verify','--quiet','--end-of-options',`${ref}^{commit}`],{allowFail:true});
  if (head.code) throw new OwedError(`${ref} does not exist; nothing to adopt`);
  const current = head.stdout.trim();
  let target = current;
  if (commit !== undefined) {
    const r = await git.git(cwd,['rev-parse','--verify','--quiet','--end-of-options',`${commit}^{commit}`],{allowFail:true});
    if (r.code) throw new OwedError(`${commit} is not a commit`,'usage');
    target = r.stdout.trim();
    if (target !== current && current !== prior) throw new OwedError(`adopt records only what is on trunk: ${commit} (${target.slice(0,12)}) is not ${ref} (${current.slice(0,12)})`);
  }
  if (target === prior) throw new OwedError(`nothing to adopt: ${ref} equals the ledger trunk ${prior.slice(0,12)}`);
  if ((await git.git(cwd,['cat-file','-e',`${prior}^{commit}`],{allowFail:true})).code) throw new OwedError(`ledger trunk ${prior} is missing from the repository; owed adopt cannot check that ${ref} is a fast-forward of it`);
  const ff = (await git.git(cwd,['merge-base','--is-ancestor',prior,target],{allowFail:true})).code === 0;
  if (!ff) {
    if (target !== current && (await git.git(cwd,['merge-base','--is-ancestor',target,prior],{allowFail:true})).code === 0) throw new OwedError(`nothing to adopt: ${target.slice(0,12)} is already contained in the ledger trunk ${prior.slice(0,12)}`,'usage');
    if (target !== current) throw new OwedError(`adopt commit ${target.slice(0,12)} is not a fast-forward of the new ledger trunk ${prior.slice(0,12)}; rebase ${target.slice(0,12)} onto ${prior.slice(0,12)}, then run owed adopt --commit <new> --note "<why>" again`);
    throw new OwedError(`trunk was rewritten: the ledger trunk ${prior.slice(0,12)} is not an ancestor of ${ref} (${target.slice(0,12)}); owed adopt records only fast-forwards: restore ${ref} to a descendant of ${prior.slice(0,12)}`);
  }
  return { trunk:s.trunk.name, prior, commit:target, refCommit:current, commits:await git.countCommits(cwd,prior,target), changed:await git.changedPaths(cwd,prior,target) };
}
/** What `adopt` would record (no effect): for owner confirmation dialogs. */
export async function adoptPreview(o: Context & { commit?: string }): Promise<AdoptPreview> {
  const { state } = await load(await Ledger.open(o.cwd)), { refCommit: _ref, ...preview } = await adoptable(o.cwd,inited(state),o.commit);
  return preview;
}
/**
 * Owner adoption of external commits, including off-ref hotfixes landed under the merge lock (AD). Measures every invariant whose key changed on the adopted
 * commit; an invariant satisfied on the prior trunk but not on the adopted commit refuses the adoption (its
 * observations are recorded). Same lock/CAS discipline as merge: a moved ref or ledger records nothing, except after an
 * abort (D16a, SPEC §7.8): observations measured before it are recorded when the ledger is stable and they pass the
 * guard, without a ref check (abortWith).
 */
export async function adopt(o: Actor & { commit?: string; note: string; channel?: Channel; signal?: AbortSignal; lease?: boolean; wait?: number }): Promise<AdoptResult> {
  const start = Date.now(), deadline = start+(adoptWaitMs(o.wait) ?? lockWait.ms);
  return withLockDeadline(deadline,() => adoptRequested(o,start,deadline));
}
async function adoptRequested(o: Parameters<typeof adopt>[0], start: number, deadline: number): Promise<AdoptResult> {
  owner(o);
  // D21.4: a parent may adopt only under an `adopt` allowance of the current plan (paths checked below, before any effect).
  if (o.as.role !== 'owner' && !(o.as.role === 'parent' && adoptPrefixes((await load(await Ledger.open(o.cwd))).state.plan).length)) throw new OwedError('adopt requires owner: it records trunk changes that owed did not review');
  if (typeof o.note !== 'string' || !o.note.trim()) throw new OwedError('adopt requires a note','usage');
  checkAbort(o.signal);
  const ledger = await Ledger.open(o.cwd), { state } = await load(ledger);
  const commit = await git.revParse(o.cwd,o.commit ?? (state.seq >= 0 ? `refs/heads/${state.trunk.name}` : 'HEAD'));
  return withAdoptPending(ledger,commit,start,deadline,() => measurementScope()
    ? adoptHeld(o,ledger)
    : leased(o,signal => adoptHeld({...o,signal},ledger)));
}
/** AW: pending spans lease acquisition and all merge-lock outcomes. */
async function adoptHeld(o: Parameters<typeof adopt>[0], ledger: Ledger): Promise<AdoptResult> {
  return ledger.withLock(async () => {
    const { state } = await load(ledger); inited(state);
    const { refCommit, ...p } = await adoptable(o.cwd,state,o.commit);
    const retry = refCommit === p.commit ? 'fix trunk, then run owed adopt again' : 'fix the hotfix, then run owed adopt --commit <new> --note "<why>" again';
    if (o.as.role === 'parent') { const outside = unadoptable(state.plan,p.changed); if (outside !== undefined) throw new OwedError(`parent adoption refused: changed path ${outside} is not under an allow adopt prefix (${adoptPrefixes(state.plan).join(', ') || 'none'}); the owner must adopt it`); }
    const sf = await git.stateFacts(o.cwd,state.plan,p.commit,stateQuarantine(state));
    // M1: up to exec.parallel jobs at once, observations in job order; an abort keeps the completed ones (abortWith).
    const jobs = [...genesisJobs(state),...adoptJobs(state,sf)];
    const run = await measureAll(jobs,parallelOf(state.plan),o.signal,job => runJob({cwd:o.cwd,ledger,plan:state.plan,signal:o.signal},job));
    const observations = await automaticInvariantResults(o.cwd,ledger,state,jobs,run.observations.filter((x): x is Draft => x !== undefined),o.signal);
    if (run.aborted || o.signal?.aborted) return abortWith(ledger,state,observations);
    return ledger.withLock(async () => {
      const latest = await load(ledger); stable(state,latest.state);
      const now = await git.git(o.cwd,['rev-parse','--verify','--quiet','--end-of-options',`refs/heads/${p.trunk}^{commit}`],{allowFail:true});
      if (now.code || now.stdout.trim() !== refCommit) throw new OwedError(`refs/heads/${p.trunk} moved during adopt (was ${refCommit.slice(0,12)}); nothing was recorded, run owed adopt again`);
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
        throw new OwedError(`adoption refused: ${g.failed.length ? `invariant${g.failed.length > 1 ? 's' : ''} ${g.failed.map(id => `${id}${seqs(id).length ? ` (obs ${seqs(id).join(', ')})` : ''}`).join(', ')} satisfied on the ledger trunk but not on ${p.commit.slice(0,12)}; ${retry}. ` : ''}${g.reasons.filter(x => !g.failed.some(id => x.startsWith(`invariant ${id} new debt`))).join('; ')}`.replace(/[ ;.]+$/,''));
      }
      const d: Draft = {kind:'adopt',by:by(o),channel:o.channel,trunk:p.trunk,prior:p.prior,commit:p.commit,state:sf,changed:p.changed,commits:p.commits,note:o.note}; guard(current,d);
      // AD1: exactly merge's advance-before-append path; a failed append leaves recoverable trunk drift.
      if (refCommit !== p.commit) await git.advanceTrunk(o.cwd,p.trunk,p.prior,p.commit);
      const appended = await ledger.append([...observations,d]), allowance = o.as.role === 'parent' ? allowanceSeq(latest.state) : undefined;
      return {...p,entry:appended.at(-1)!,observations:appended.slice(0,-1),...(allowance !== undefined ? { allowance } : {})};
    },undefined,o.signal);
  },'merge',o.signal,{activity:'adopt'});
}
export async function status(o: Context): Promise<StatusView> {
  const ledger = await Ledger.open(o.cwd), loaded = await load(ledger), state = inited(reduceFrom(loaded.state,[],loaded.lookup)), entries = loaded.entries;
  await applyReports(ledger,state);
  const view = await summaryStatusView(o.cwd,ledger.dir,state,entries,Date.now());
  view.conflicts = await candidateConflicts(o.cwd,state);
  const trunkWorktree = await git.trunkElsewhere(o.cwd,state.trunk.name).catch(() => undefined);
  if (view.genesis && await measuringHere(ledger.dir)) view.genesis.measuring = true;
  if (trunkWorktree) view.trunkWorktree = trunkWorktree;
  return view;
}
/** NT3: retain only recorded defers for this open attempt and invariants still in the plan. */
function unverifiedDefers(state: State, id: string, defers: State['deferred'], unverified: 'drift' | 'conflict'): DeferredView[] {
  const dispatch = state.nodes[id]?.slot?.dispatchSeq ?? Infinity;
  return defers.filter(d => d.seq > dispatch && state.plan.nodes.some(n => n.id === id) && state.plan.invariants.some(i => i.id === d.id)).map(d => ({...d,unverified}));
}
/** SQ: both status and brief use the same current merge diagnostics and defer scope. */
export async function summaryStatusView(cwd: string, dir: string, state: State, entries: Entry[], now: number): Promise<StatusView> {
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
  const max = driverRunning && Number.isSafeInteger(lock.owner.max) && lock.owner.max! > 0 ? lock.owner.max : driveConfig(state.plan).max;
  const rt = await assembleRuntime({ cwd, state, driverRunning, now });
  const view = statusView(state,entries,mergeChecks,now,driverRunning,currentDefers,max,rt);
  for (const i of mergeChecks) view.summary!.needs.push({ node: i.subject, reason: `${i.obligation}: ${oneLine(i.detail)}`, command: `owed why ${i.subject}` });
  const red=await sweepRed(cwd,entries,state.trunk.commit);
  if (red) view.sweepRed=red;
  view.housekeeping = await finishedWorktrees(cwd,state,entries);
  await applyMergeWaiting(cwd, dir, state, view);
  const pendingBases: NonNullable<StatusView['rebasePending']> = {};
  for (const id of Object.keys(state.nodes)) {
    const r = await rebasePending(state, id);
    if (!r) continue;
    pendingBases[id] = r;
    const progress = view.summary?.progress.find(p => p.node === id);
    if (progress && !view.measuring?.[id]) progress.phase = rebasePendingText(r);
  }
  if (Object.keys(pendingBases).length) view.rebasePending = pendingBases;
  if (drift && view.summary) view.summary.needs.push({ node:'trunk', reason:driftText(drift), command:drift.relation === 'ahead' ? 'owed adopt --note "<why>"' : 'owed why trunk' });
  if (drift) view.drift = drift;
  return view;
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
/** UX3: only open candidates participate; diagnostics never discharge an obligation. */
async function candidateConflicts(cwd: string, state: State, only?: string): Promise<NonNullable<StatusView['conflicts']>> {
  const candidates = Object.entries(state.nodes).filter(([, n]) => n.slot?.open && n.candidate && !n.merged);
  const conflicts: NonNullable<StatusView['conflicts']> = {};
  if (!candidates.length || (only !== undefined && !candidates.some(([id]) => id === only))) return conflicts;
  const probe = await git.conflictProbe(cwd, [state.trunk.commit, ...candidates.map(([, n]) => n.candidate!.commit)]);
  for (const [id, n] of candidates) if (only === undefined || only === id) {
    conflicts[id] = { trunk: await probe(state.trunk.commit,n.candidate!.commit) ?? null };
  }
  for (let i = 0; i < candidates.length; i++) for (let j = i + 1; j < candidates.length; j++) {
    const [id, n] = candidates[i]!, [other, peer] = candidates[j]!;
    if (only !== undefined && id !== only && other !== only) continue;
    const paths = await probe(n.candidate!.commit,peer.candidate!.commit) ?? null;
    if (conflicts[id]) conflicts[id]![other] = paths;
    if (conflicts[other]) conflicts[other]![id] = paths;
  }
  return conflicts;
}
/**
 * QT4 (QT-R1 6): one `<node> merged (<commit12>); measured <n>, waived <n>, debt <n>` line per merged node. Best-effort:
 * the read runs after the merge was committed, so a failure there only shortens the line to `<node> merged (<commit12>)`.
 * `debt`: the deferred items left on this merge's keys per node (the merge result's `deferred`). A node the caller gives
 * no count for gets no debt field: the ledger's defers of a node include defers on older merge keys.
 */
export async function mergedLines(cwd: string, merged: readonly { node: string; commit: string }[], debt?: Readonly<Record<string, number>>): Promise<string[]> {
  const lines = await Promise.all(merged.map(async ({ node, commit }) => {
    try { return mergedLine(await why({ cwd, node }), commit, debt?.[node]); } catch { return `${node} merged (${commit.slice(0, 12)})`; }
  }));
  try {
    const { state, entries } = await load(await Ledger.open(cwd)), count = await finishedWorktrees(cwd,state,entries);
    if (count !== undefined && lines.length) lines[0] += `\n${housekeepingText(count)}`;
  } catch { /* A post-merge hint must never turn a committed merge into a refusal. */ }
  return lines;
}
export async function why(o: Context & {node:string}): Promise<ReceiptCard> {
  const ledger = await Ledger.open(o.cwd), {state,entries,lookup} = await load(ledger);
  const lock = readLock(ledger.dir), running = lock.state === 'live' || lock.state === 'foreign';
  const rt = await assembleRuntime({ cwd: o.cwd, state, driverRunning: running });
  if (o.node === 'trunk' && !state.nodes.trunk) {
    const reds = trunkInvariantReds(state);
    return withPresentationState({ node:'trunk', phase:'merged', accepted:state.invariants.every(i => i.status !== 'D'), items:state.invariants.map(i => ({ ...receiptItem(i,entries), ...templateReceiptRun(state,i), detail:reds.find(r => r.obligation === i.obligation)?.text ?? i.detail })), blocks:[], untested:[], ownerFlags:[], downgrades:[] }, state, rt);
  }
  if (o.node.startsWith('inv:') || (!state.nodes[o.node] && state.plan.invariants.some(i => i.id === o.node))) {
    const id = invariantId(state.plan,o.node), item = state.invariants.find(i => i.obligation === `inv:${id}`)!;
    return withPresentationState({ node: `inv:${id}`, phase: 'merged', accepted: item.status !== 'D', items: [{ ...receiptItem(item,entries), ...templateReceiptRun(state,item) }], blocks: [], untested: [], ownerFlags: [], downgrades: [] }, state, rt);
  }
  const view = reduceFrom(state,[],lookup); await applyReports(ledger,view);
  node(view,o.node);
  const mergeChecks = await currentTrunkRedChecks(o.cwd,view,o.node);
  const max = running && Number.isSafeInteger(lock.owner.max) && lock.owner.max! > 0 ? lock.owner.max : driveConfig(view.plan).max;
  const card = receipt(view,entries,o.node,await hintedMergeChecks(o.cwd,view,o.node,mergeChecks),max,rt);
  card.conflicts = (await candidateConflicts(o.cwd,view,o.node))[o.node];
  const pending = await rebasePending(view, o.node);
  if (pending) card.rebasePending = pending;
  const runtime = statusView(view);
  await applyMergeWaiting(o.cwd, ledger.dir, view, runtime);
  if (runtime.measuring?.[o.node]) card.measuring = runtime.measuring[o.node];
  if (runtime.mergeWaiting?.[o.node]) card.mergeWaiting = runtime.mergeWaiting[o.node];
  const { rulingToForward } = await import('./drive.ts');
  card.rulingFollowUp = rulingToForward(view, o.node);
  await applyModels(ledger,view,entries,o.node,card);
  return card;
}
/** DR2: a missing/corrupt busy file cannot create acceptance evidence or hide a gate. */
async function applyMergeWaiting(cwd: string, dir: string, state: State, view: StatusView): Promise<void> {
  const driver = await driveStatus({ cwd });
  const measuring = driver.running ? driver.measuring ?? [] : [];
  for (const m of measuring) {
    const n = state.nodes[m.node];
    if (!n?.slot?.open || !n.candidate || n.merged) continue;
    (view.measuring ??= {})[m.node] = m;
    const progress = view.summary?.progress.find(p => p.node === m.node);
    if (progress) progress.phase = measurementText(m);
  }
  try {
    const busy = JSON.parse(await readFile(join(dir,'drive','waiting.json'),'utf8')) as NonNullable<StatusView['mergeWaiting']>;
    const adoptPending = await pendingAdopt(dir);
    const current: NonNullable<StatusView['mergeWaiting']> = {};
    for (const [id, wait] of Object.entries(busy)) {
      const n = state.nodes[id];
      if (!n?.slot?.open || n.merged || wait.attempt !== n.slot.attempt || wait.candidate !== n.candidate?.seq || typeof wait.reason !== 'string' || !Number.isFinite(Date.parse(wait.since))) continue;
      if (view.measuring?.[id]) continue;
      if (wait.job && !measuring.some(m => `${m.node} ${m.do}` === wait.job && (!wait.jobSince || m.since === wait.jobSince))) continue;
      if ((wait.reason === 'adopt' || wait.reason.startsWith('adopt (pending since ')) && !adoptPending) continue;
      const { ahead: _cachedAhead, ...waiting } = wait, ahead = view.mergeQueue.indexOf(id);
      current[id] = { ...waiting, ...(ahead >= 0 ? { ahead } : {}) };
      const progress = view.summary?.progress.find(p => p.node === id);
      if (progress && n.candidate) progress.phase = mergeWaitingText(current[id]!, n.accepted ? 'merge' : 'measure');
    }
    if (Object.keys(current).length) view.mergeWaiting = current;
  } catch { /* cache miss */ }
}
/** MD1: strip only the thinking suffix; model ids may contain more than one slash. */
function modelIdentity(model: string): string { return model.replace(/:[^/:]+$/, ''); }
/** MD1: unresolved/cyclic/malformed pools cannot establish a mismatch. */
function modelPoolMembers(name: string, pools: Record<string, unknown>, active = new Set<string>()): { members: Set<string>; known: boolean } {
  if (name.includes('/')) return { members: new Set([modelIdentity(name)]), known: true };
  if (active.has(name) || !Object.hasOwn(pools, name) || !Array.isArray(pools[name]) || !pools[name].length) return { members: new Set(), known: false };
  const next = new Set(active).add(name), members = new Set<string>();
  let known = true;
  for (const entry of pools[name]) {
    const model = typeof entry === 'string' ? entry : entry && typeof entry === 'object' && !Array.isArray(entry) ? entry.model : undefined;
    if (typeof model !== 'string' || !model.trim()) { known = false; continue; }
    const child = modelPoolMembers(model, pools, next);
    for (const member of child.members) members.add(member);
    known &&= child.known;
  }
  return { members, known };
}
async function modelPools(): Promise<Record<string, unknown>> {
  try {
    const config = JSON.parse(await readFile(join(process.env.DSA_HOME ?? join(homedir(), '.pi', 'durable-subagents'), 'config.json'), 'utf8'));
    return config?.pools && typeof config.pools === 'object' && !Array.isArray(config.pools) ? config.pools : {};
  } catch { return {}; }
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
  const warnings: NonNullable<ReceiptCard['modelWarnings']> = [];
  if (writer && reviewer && modelIdentity(writer) === modelIdentity(reviewer)) {
    const message = "reviewer used the writer's model; use an independent model or set drive.same_model: accepted";
    const acknowledged = state.plan.nodes.find(n => n.id === id)?.drive?.same_model ?? state.plan.drive?.same_model;
    warnings.push(acknowledged === 'accepted' ? { message, acknowledged: true } : message);
  }
  const pools = await modelPools();
  const { driveReviewerSlot, reviewerBase } = await import('./reducer.ts');
  for (const [role, used, principal] of [['writer', writer, n.slot?.writer], ['reviewer', reviewer, reviews.at(-1)?.by]] as const) {
    if (!used) continue;
    const k = role === 'reviewer' && principal ? driveReviewerSlot(principal,id,attempt!) : undefined;
    const l = launches.findLast(l => l.role === role && (role === 'writer' || (k !== undefined && Number(l.rid.split(':').at(-1)) === reviewerBase(state,id) + k)));
    if (!l) continue;
    try {
      const spec = JSON.parse((await ledger.getBlob(l.spec)).toString()) as { model?: unknown };
      const selected = typeof spec.model === 'string' ? spec.model : Array.isArray(spec.model) && typeof spec.model[0] === 'string' ? spec.model[0] : undefined;
      if (selected) {
        const pool = modelPoolMembers(selected, pools);
        if (!pool.members.has(modelIdentity(used))) {
          if (pool.known) warnings.push(`model used ${used} differs from the one selected ${selected}; check the launch model configuration`);
          else card.models += ` · ${role} selected ${selected} (pool membership unknown)`;
        }
      }
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
/** CO: read-only ledger statistics with pinned measured-commit diffs. */
export async function reportCost(o: Context & { since?: number | string }): Promise<CostReport> {
  const {state,entries,lookup} = await load(await Ledger.open(o.cwd)); inited(state);
  return costReport(o.cwd,entries,lookup,o.since);
}
/** MT: ledger entries and recorded plan blobs only; no repository or run-state query. */
export async function reportMetrics(o: Context & MetricsWindow): Promise<Metrics> {
  const since = metricsBound(o.since,'since'), until = metricsBound(o.until,'until');
  const {state,entries,lookup} = await load(await Ledger.open(o.cwd)); inited(state);
  return computeMetrics(entries,{ get:lookup },{since,until});
}
/**
 * MX2 (ruling #2572): one cold, validating fold over the verified entries plus bounded `git merge-tree` calls. No lock,
 * no measurement and no write: not the replay snapshot/memo of `load`, not the plan cache (a missing cache entry is parsed).
 */
export async function reportCounterfactual(o: Context & { since?: number | string; progress?: (line: string) => void }): Promise<Counterfactual> {
  const since = metricsBound(o.since,'since'), ledger = await Ledger.open(o.cwd), entries = await readVisibleEntries(ledger);
  if (!entries.length) throw new OwedError('Not initialized: run owed init <plan.yaml> first');
  const plans = new Map<string, Plan>();
  for (const sha of planShas(entries)) plans.set(sha, planHit(`${ledger.dir}\0${sha}`) ?? deepFreeze((await ledger.readPlanCache(sha) as Plan | undefined) ?? parsePlan((await ledger.getBlob(sha)).toString())));
  const lookup = (sha: string): Plan => { const p = plans.get(sha); if (!p) throw new OwedError(`Missing plan ${sha}`, 'internal'); return p; };
  for (const e of entries) { const newer = newerEntry(e); if (newer) throw newer; }
  return counterfactual(o.cwd,entries.map(interpretedEntry),lookup,since,o.progress);
}

export async function report(o: Context & {since?:number|string}): Promise<Report> {
  const {state,entries,lookup} = await load(await Ledger.open(o.cwd)), since = o.since ?? -1; inited(state);
  if (typeof since === 'string' && !Number.isFinite(Date.parse(since))) throw new OwedError('since must be a seq or ISO timestamp','usage');
  const included = (e: {seq:number;ts?:string}) => typeof since === 'number' ? e.seq > since : Date.parse(e.ts ?? entries[e.seq]?.ts ?? '') > Date.parse(since);
  const recent = entries.filter(included), before = reduce(entries.filter(e => !included(e)),lookup), old = [...Object.values(before.nodes).flatMap(n => n.items),...before.invariants];
  const items = [...Object.values(state.nodes).flatMap(n => n.items),...state.invariants];
  const receipts = entries.filter((e): e is EvidenceEntry => e.kind === 'evidence' && e.merge !== undefined && included(e));
  const superseded = supersededOf(state,Object.values(state.nodes)).filter(b => included({seq:b.supersededBy}));
  return withActHistory({...(trackedWaivers(state).length ? {trackedDebt:trackedWaivers(state).map(e => trackedDebtText(state,e))} : {}),reviews:{sameModel:sameModelReviews(entries,included)},...(knownRedDebt(state).knownRed ? {knownRed:knownRedDebt(state).knownRed} : {}),...(quarantineDebt(state).length ? {quarantine:quarantineDebt(state).map(quarantineText)} : {}),...(receipts.length ? {receipts} : {}),...(superseded.length ? {superseded} : {}),escapes:escapeSummary(state),since,merges:recent.filter(e => e.kind === 'merge'),waivers:recent.filter(e => e.kind === 'waive'),blocks:Object.keys(state.nodes).flatMap(id => receipt(state,entries,id).blocks).filter(included),downgrades:state.downgrades.filter(included),rulings:state.rules.filter(included),decisions:items.filter(i => i.status === 'D' && i.discharger === 'owner'),ownerActions:recent.filter(e => e.by.startsWith('owner:') && e.kind !== 'adopt'),adoptions:state.adoptions.filter(included),halts:entries.filter((e): e is HaltEntry => e.kind === 'halt').map(e => ({...e,active:halted(state,e.node)?.seq === e.seq})).filter(e => e.active || included(e)),changes:items.filter(i => !state.nodes[i.subject]?.merged).flatMap(i => { const prev = old.find(p => p.subject === i.subject && p.obligation === i.obligation); return prev?.status === i.status && prev.key === i.key ? [] : [{subject:i.subject,obligation:i.obligation,before:prev?.status,after:i.status}]; })},entries);
}
let lastVerifyPlanStats = { parsed:0, maxRetained:0, maxHeld:0 };
/**
 * @internal Last verify's YAML parse count, local LRU high-water mark and held-plan high-water mark.
 * maxHeld samples LRU size + retainedPlanValues for each live state after reduce/unpackState/extendState and
 * at the snapshot comparison. It is an upper bound: shared plan objects may be counted more than once.
 */
export function verifyPlanStats(): { parsed: number; maxRetained: number; maxHeld: number } { return { ...lastVerifyPlanStats }; }
/**
 * Verifies the hash chain and replays the ledger. N4: never reads the plan caches; every plan is parsed from its YAML
 * blob and reads each persistent cache entry raw: one of another version is rewritten silently; one of this version
 * whose sha or plan disagrees with the blob, or an unreadable or non-JSON file, is reported in `cacheMismatch` (not a
 * failure) and rewritten.
 */
export async function verify(o: Context): Promise<VerifyResult> {
  const stats = { parsed:0, maxRetained:0, maxHeld:0 };
  lastVerifyPlanStats = stats;
  try {
    const ledger = await Ledger.open(o.cwd), entries = await ledger.read(), plans = new Map<string, Plan>(), cacheMismatch: string[] = [];
    const known = new Set(planShas(entries));
    const sampleHeld = (...states: State[]) => {
      stats.maxHeld = Math.max(stats.maxHeld,plans.size + states.reduce((sum,s) => sum + retainedPlanValues(s),0));
    };
    // VM2: this LRU contains only YAML-checked plans, never values from either plan cache. Deep freezing lets PM3
    // share them instead of retaining mutable clones of every historical law. Evict before parsing the next value.
    const room = () => { if (plans.size === PLAN_CACHE_MAX) plans.delete(plans.keys().next().value!); };
    const remember = (sha: string, p: Plan): Plan => {
      stats.parsed++; plans.set(sha,deepFreeze(p)); stats.maxRetained = Math.max(stats.maxRetained,plans.size);
      sampleHeld(); return p;
    };
    for (const sha of known) {
      room();
      const p = remember(sha,parsePlan((await ledger.getBlob(sha)).toString())), c = await ledger.rawPlanCache(sha);
      if (c.state === 'missing') continue;
      // Another version is a stale entry (rewritten silently); corruption or other content under this version is reported.
      const report = c.state === 'corrupt' || (c.v === PLAN_CACHE_VERSION && (c.sha !== sha || canonical(c.plan) !== canonical(p)));
      if (report) cacheMismatch.push(sha);
      if (report || c.v !== PLAN_CACHE_VERSION) await ledger.writePlanCache(sha, p);
    }
    const lookup = (sha: string): Plan => {
      if (!known.has(sha)) throw new OwedError(`Missing plan ${sha}`, 'internal');
      const p = plans.get(sha);
      if (p) { plans.delete(sha); plans.set(sha,p); return p; }
      room();
      return remember(sha,parsePlan(ledger.getBlobSync(sha).toString()));
    };
    // G1.4: the result is the full replay; a disk snapshot that matches the chain is compared with it at its seq, and
    // deleted (reported) when they differ.
    const snap = await ledger.readSnapshot();
    let state: State, snapshotMismatch: number | undefined;
    if (snap && entries[snap.seq]?.hash === snap.hash) {
      state = reduce(entries.slice(0,snap.seq+1),lookup); sampleHeld(state);
      let same = false;
      try {
        const restored = unpackState(deserialize(snap.payload) as PackedState,lookup);
        sampleHeld(state,restored);
        // sameReplay resolves historical laws in both states; sample again even if that lookup throws.
        try { same = sameReplay(restored,state); } finally { sampleHeld(state,restored); }
      } catch { same = false; }
      if (!same) { await invalidateReplay(ledger); snapshotMismatch = snap.seq; }
      extendState(state,entries.slice(snap.seq+1)); sampleHeld(state);
    } else { state = reduce(entries,lookup); sampleHeld(state); }
    const errors = decisionTailErrors(state); if (errors.length) throw new OwedError(errors.join('; '));
    const incompleteBatch = incompleteBatchText(state);
    return { ok:true, entries:entries.length, head:state.head, ...(cacheMismatch.length ? { cacheMismatch } : {}), ...(snapshotMismatch !== undefined ? { snapshotMismatch } : {}), ...(incompleteBatch ? { incompleteBatch } : {}) };
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
  assertNoLedgerLock();
  owner(o); const ledger = await Ledger.open(o.cwd), spec = await ledger.putBlob(o.spec);
  return ledger.withLock(() => ledger.withLock(async () => {
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
  }),slotOperationLock(o.node));
}
/** Records the intent to send `message` (exact bytes, stored as a blob) to run `rid`; the send id `${rid}:${sendKind}:${seq}` is assigned under the lock. `since`: as for launch (F1). */
export async function send(o: Actor & { node: string; attempt: number; rid: string; sendKind: SendKind; message: string; reason: SendReason; rulings?: number; since?: number }): Promise<SendEntry> {
  assertNoLedgerLock();
  owner(o); const ledger = await Ledger.open(o.cwd), message = await ledger.putBlob(o.message);
  return ledger.withLock(() => ledger.withLock(async () => {
    const { state, entries } = await load(ledger);
    decidedOn(entries, o.node, o.since);
    const d: Draft = { kind: 'send', by: by(o), channel: o.channel, node: o.node, attempt: o.attempt, rid: o.rid, send: `${o.rid}:${o.sendKind}:${state.seq + 1}`, sendKind: o.sendKind, message, reason: o.reason, ...(o.rulings !== undefined ? { rulings: o.rulings } : {}) };
    guard(state, d); return (await ledger.append([d]))[0] as SendEntry;
  }),slotOperationLock(o.node));
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
  if (unruled.length) throw new OwedError(`resume refused: ${o.node} needs a parent ruling (review block ${unruled.map(x => `#${x.seq} ${x.obligation}`).join(', ')}); ${nodeNext(s, o.node)}`);
  const after = o.after === undefined ? undefined : typeof o.after === 'string' && !o.after.includes(',') ? o.after : [...new Set(afterNodes(o.after).flatMap(x => x.split(',')).map(x => x.trim()))];
  return { kind:'resume', by:by(o), channel:o.channel, node:o.node, attempt:n.slot.attempt, ...(after !== undefined ? { after } : {}), ...(o.expect !== undefined ? { expect:o.expect } : {}), ...(o.note !== undefined && o.note !== '' ? { note:o.note } : {}), ...(o.remeasure ? { remeasure:true as const } : {}) };
}
/** WF5: recorded facts only; the next merge computes its prospective tree. */
export function remeasureQueuedText(s: State, node: string): string[] {
  const es = entriesOf(s), candidate = s.nodes[node]?.candidate;
  const failures = s.plan.invariants.flatMap(inv => {
    const latest = es.findLast((e): e is ObsEntry => e.kind === 'obs' && e.by === 'executor:owed' && e.merging === node && e.obligation === `inv:${inv.id}` && e.probe === undefined);
    return latest?.verdict === 'fail' ? [latest] : [];
  });
  const lines = failures.map(f => s.trunk.seq < f.seq && candidate && candidate.seq < f.seq
    ? `remeasure queued: ${f.obligation} on merge key ${f.key.slice(0,12)}`
    : `${f.obligation}: trunk moved to ${s.trunk.commit.slice(0,12)} (or the candidate changed) since #${f.seq}: the next merge builds a new merge tree; ${f.obligation} is remeasured there if its key is still ${f.key.slice(0,12)}, otherwise measured as usual`);
  const n = s.nodes[node], retry = resumeOf(s,node);
  for (const check of s.plan.nodes.find(n => n.id === node)?.checks ?? []) {
    const obligation = `check:${check.id}`, key = candidate?.keys[obligation];
    const b = n?.blocks.findLast(b => b.kind === 'exec' && b.obligation === obligation && b.state === 'active' && retry?.remeasure && b.seq < retry.seq);
    if (candidate && b) {
      lines.push(`remeasure queued: ${node} check ${check.id} (failure #${b.seq}) is measured again on its key before any repair; a pass leaves a flaky block: owed waive ${node} --accept-risk ${b.seq}`);
    } else if (key && !n?.blocks.some(b => b.kind === 'exec' && b.obligation === obligation && b.key === key && b.state === 'active')) {
      const f = observationsOf(s,node,obligation,key).findLast(o => o.verdict !== 'error');
      if (f?.verdict === 'fail') lines.push(`${node} check ${check.id} already failed again on its key (#${f.seq}); --remeasure does not measure it again: owed attest ${node} --rerun`);
    }
  }
  return lines.length ? lines : [`nothing to remeasure: no failed merge-tree invariant and no blocked check of ${node}`];
}
export interface ResumeResult { entry: Entry; merged?: boolean; entries?: Entry[]; remeasure?: string[] }
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
    return { entry:entries[0]!, ...(merged ? { merged:true } : {}), ...(nodes.length > 1 ? { entries } : {}), ...(o.remeasure ? {remeasure:nodes.flatMap(id => remeasureQueuedText(reduceFrom(latest.state,entries,latest.lookup),id))} : {}) };
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
export async function approve(o: Actor & { node: string; note?: string; block?: boolean; candidate?: CandidatePin; named?: string }): Promise<RecordedAct> {
  if (o.as.role !== 'owner') throw new OwedError('approve requires owner');
  const given = candidateArg(o.named);
  return mutateAct(o,s => {
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
export async function evidence(o: Actor & { node: string; id: string; files: string[]; note: string; expect?: EvidenceFile[]; candidate?: CandidatePin; named?: string; from?: string[] }): Promise<RecordedAct<EvidenceEntry>> {
  if (typeof o.note !== 'string' || !o.note.trim()) throw new OwedError('evidence requires a note','usage');
  const given = candidateArg(o.named);
  const files = await evidenceFiles({ cwd:o.cwd, files:o.files });
  if (o.expect && canonical(o.expect) !== canonical(files)) throw new OwedError('evidence files changed since they were confirmed; nothing was recorded');
  return await mutateAct(o,async s => {
    const n = node(s,o.node);
    named(s,o.node,given);
    pinned(s,o.node,o.candidate);
    await writerTree(s,o.node,[o.cwd,process.cwd(),...(o.from ?? [])]);
    if (n.merged && !n.slot?.open) return { kind:'evidence',by:by(o),channel:o.channel,node:o.node,merge:n.merged.seq,id:o.id,files,note:o.note };
    const c = candidate(s,o.node);
    return { kind:'evidence',by:by(o),channel:o.channel,node:o.node,attempt:c.slot!.attempt,key:c.candidate!.keys[`evidence:${o.id}`] ?? '',id:o.id,files,note:o.note };
  }) as RecordedAct<EvidenceEntry>;
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
/** GC1: one read-only listing; count recorded closed attempts, not branches or measurement trees. */
async function finishedWorktrees(cwd: string, state: State, entries: Entry[]): Promise<number | undefined> {
  try {
    const listed = new Set((await git.listWorktrees(cwd)).map(w => resolve(w.path)));
    const count = entries.filter(e => e.kind === 'dispatch' && !(state.nodes[e.node]?.slot?.open && state.nodes[e.node]!.slot!.attempt === e.attempt) && listed.has(resolve(e.worktree))).length;
    return count >= 5 ? count : undefined;
  } catch { return undefined; }
}
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
