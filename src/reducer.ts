import { riskDowngrades, reviewRequirement, reviewRequirementText } from './risk.ts';
import { matchesWrite, writeCovers, writeOverlaps, writesSyntax, withWritesSyntax, writesKeySyntax, writesAllowChanged, type WritesSyntax } from './writes.ts';
import { matchesGlob } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { H, ZERO, canonical, sha256 } from './canon.ts';
import { OWED_VERSION, OwedError } from './errors.ts';
import { EVIDENCE_ID, manualDowngrades, knownRedDowngrades, quarantineDowngrades, activeQuarantine, quarantineNames, type QuarantineNames, matchesAny } from './plan.ts';
import { execKey } from './git.ts';
import { executorEscapeErrors, sweepBoundaryErrors } from './sweep-policy.ts';
import type { AllowRule, AttestJob, Block, CandidateFacts, CheckSpec, DecoyPayload, DecoyView, Discharger, Downgrade, Draft, Entry, EscapeClass, EvidenceEntry, HaltEntry, ItemView, LaunchEntry, MergeBatch, MergeGuard, NodeSpec, NodeState, ObsEntry, Plan, ResumeEntry, ReviewEntry, Rule, RunRole, SendEntry, SendKind, SendReason, State, StateFacts, WaiveEntry } from './types.ts';

export type PlanLookup = (sha: string) => Plan;
const history = Symbol('owed.reducer.history');
/**
 * N4 (0.10): replay indexes, kept in ledger order as entries are folded (`record`), so item and validation lookups
 * read only the entries of one node or item instead of scanning every entry. Arrays hold the replayed entries.
 */
interface Indexes {
  /** entries by seq (a list: replay never assumes unique seqs) */ bySeq: Map<number, Entry[]>;
  /** executor:owed observations by `subject \0 obligation \0 key` */ obs: Map<string, ObsEntry[]>;
  /** reviews, evidence and waivers by node */ reviews: Map<string, ReviewEntry[]>; evidence: Map<string, EvidenceEntry[]>; waives: Map<string, WaiveEntry[]>;
  /** launches by rid */ launches: Map<unknown, LaunchEntry[]>;
  /** seq of the latest plan entry */ lastPlan?: number;
  /** transitive dependents per node id of the current plan (recomputed when the plan changes) */ dependents: Map<string, number>;
}
/**
 * G1 (0.12): `planObjs` = the plan object the state keeps per genesis/plan sha (`own` of the lookup's plan, resolved once
 * per replay; undefined = not resolved yet, after `unpackState`: resolved through `plans` on first use); `obsPlans` names the plan in force at each executor observation by its sha. Neither holds a plan by
 * value elsewhere, so a packed state (`packState`) carries plan shas only and every plan object is shared or re-resolved.
 */
interface History extends Indexes { /** GR: only present after the first grant; keeps grant-free snapshots unchanged. */ grants?: Map<string, import('./types.ts').GrantEntry[]>; /** IR lineage exists only after a refresh or an inherited trunk-red merge. */ invRed?: Map<string, { key: string; seq: number; kind: 'refresh' | 'merge'; node?: string }>; entries: Entry[]; plans: PlanLookup; planObjs: Map<string, Plan | undefined>; genesis?: Extract<Entry, { kind: 'genesis' }>; obsPlans: Map<number, string>; mergeCatches: Set<number>; /** L2: the state a superseded block would have without supersede (validation of later entries only) */ shadow: Map<number, Block['state']>; /** seq of the genesis/plan entry that last changed `allow` (D21) */ allowSeq?: number }
type ReplayState = State & { [history]: History };
function context(state: State): History {
  const value = (state as ReplayState)[history];
  if (!value) throw new OwedError('State lacks replay metadata; use the state returned by reduce', 'internal');
  return value;
}
/** A block that still counts: active or flaky. Cleared and superseded (L2) blocks do not. */
const active = (b: Block): boolean => b.state === 'active' || b.state === 'flaky';
/**
 * L2 replay compatibility: the state of `b` as it would be without supersede. Supersede never invalidates a later
 * entry, so validation of attribution observations and accept_risk reads this state; it never makes a block count.
 */
const underlying = (h: History, b: Block): Block['state'] => b.state === 'superseded' ? h.shadow.get(b.seq) ?? 'active' : b.state;
const underlyingActive = (h: History, b: Block): boolean => { const u = underlying(h, b); return u === 'active' || u === 'flaky'; };
/** Blocks that still bind the node: judgment blocks always; execution blocks only while their obligation exists (removing it is an owner-only, visible downgrade). */
const binding = (b: Block, spec: NodeSpec | undefined): boolean => active(b) && (b.kind === 'judgment' || !spec || spec.checks.some(c => b.obligation === `check:${c.id}` || (c.red && b.obligation === `red:${c.id}`) || (!!c.mutants && b.obligation === `strength:${c.id}`)) || b.obligation === 'writes');
const role = (by: string): string => by.split(':')[0] ?? '';
const blankPlan = (): Plan => ({ version: 1, trunk: '', closure: [], invariants: [], nodes: [] });
const emptyNode = (id: string): NodeState => ({ id, phase: 'blocked', items: [], blocks: [], accepted: false, dependents: 0, writers: [], runs: [] });
/** N4: node specs by id of a frozen (shared, unchangeable) plan; the first spec of an id wins, as with find. */
const specIndex = new WeakMap<Plan, Map<string, NodeSpec>>();
function nodeSpec(s: State, id: string): NodeSpec | undefined {
  const plan = s.plan;
  if (!Object.isFrozen(plan) || !Object.isFrozen(plan.nodes)) return plan.nodes.find(n => n.id === id);
  let m = specIndex.get(plan);
  if (!m) { m = new Map(); for (const n of plan.nodes) if (!m.has(n.id)) m.set(n.id, n); specIndex.set(plan, m); }
  return m.get(id);
}
/** A node spec without its `type` (D19.4) and `drive` (K3): neither is an obligation. */
const withoutType = (n: NodeSpec | undefined): NodeSpec | undefined => n && { ...n, type: undefined, drive: undefined, later: undefined };
const itemKey = (subject: string, obligation: string, key: string): string => `${subject}\0${obligation}\0${key}`;
const listed = <K, V>(m: Map<K, V[]>, k: K): V[] => m.get(k) ?? [];
const push = <K, V>(m: Map<K, V[]>, k: K, v: V): void => { const l = m.get(k); if (l) l.push(v); else m.set(k, [v]); };
const observations = (s: State, subject: string, obligation: string, key: string): ObsEntry[] => [...listed(context(s).obs, itemKey(subject, obligation, key))];
/** N4: appends a replayed entry to the history and its indexes. */
function record(h: History, e: Entry): void {
  h.entries.push(e); push(h.bySeq, e.seq, e);
  if (e.kind === 'obs' && e.by === 'executor:owed') push(h.obs, itemKey(e.subject, e.obligation, e.key), e);
  else if (e.kind === 'review') push(h.reviews, e.node, e);
  else if (e.kind === 'evidence') push(h.evidence, e.node, e);
  else if (e.kind === 'waive') push(h.waives, e.node, e);
  else if (e.kind === 'launch') push(h.launches, e.rid, e);
  else if (e.kind === 'plan') h.lastPlan = e.seq;
  else if (e.kind === 'grant') push(h.grants ??= new Map(), e.node, e);
}
/** N4: the number of transitive dependents of every node of `plan` (reverse adjacency, one DFS per node). */
function dependentCounts(plan: Plan): Map<string, number> {
  const rev = new Map<string, string[]>(), out = new Map<string, number>();
  for (const other of plan.nodes) for (const d of new Set(other.deps)) push(rev, d, other.id);
  for (const n of plan.nodes) {
    const seen = new Set<string>();
    const visit = (id: string): void => { for (const other of listed(rev, id)) if (!seen.has(other)) { seen.add(other); visit(other); } };
    visit(n.id); out.set(n.id, seen.size);
  }
  return out;
}
/**
 * 0.11 F3 (wais #34): a failing merge-result observation of a node (`merging`) whose block an owner waiver cites in its
 * `accept_risk` no longer counts for its (merge) key: it is neither a conflicting fail nor a verdict, so a pass on that
 * key satisfies the merge and a key left without another verdict is measured again. An observation on the waiver's own
 * key (a candidate key, or a merge key equal to it) is never discounted: the waiver works there through W as before.
 */
const waivedFail = (s: State, e: ObsEntry): boolean => e.verdict === 'fail' && e.merging !== undefined && e.merging === e.subject && listed(context(s).waives, e.subject).some(w => w.kind === 'waive' && w.node === e.subject && w.obligation === e.obligation && w.key !== e.key && w.seq > e.seq && (w.accept_risk ?? []).includes(e.seq));
/** The observations that count for an item: exclude diagnostic probes and waived merge-key fails (F3). */
const counted = (s: State, subject: string, obligation: string, key: string): ObsEntry[] => {
  const obs = observations(s, subject, obligation, key).filter(e => e.probe === undefined && !waivedFail(s, e) && grantPassReusable(s,e) && batchCounts(s, e));
  // IF2: only an explicitly validated receipt removes a setup failure from behavioural votes.
  const resolved = resolvedSetupFailures(s, observations(s,subject,obligation,key));
  const votes = obs.filter(e => !resolved.has(e.seq));
  // WG5 supersedes an earlier overlap-only failure; ordinary failures keep their conflict semantics.
  return obligation === 'writes' ? votes.filter((e,i) => !e.waits_on || i === votes.length - 1) : votes;
};
/**
 * MT4 / ruling #2110: which batch observations count. `undefined`: state views (an obs of a batch that merged counts,
 * since its final tree is then trunk; of a batch that did not merge, never); `''`: a non-batch merge (never: it measures
 * its own tree with `merging`); else the `\0`-joined members of the batch merge being judged (only that batch's obs).
 */
let batchScope: string | undefined;
function inBatchScope<T>(scope: string | undefined, fn: () => T): T { const prior = batchScope; batchScope = scope; try { return fn(); } finally { batchScope = prior; } }
function batchCounts(s: State, e: ObsEntry): boolean {
  if (e.batch === undefined) return true;
  return batchScope === undefined ? s.nodes[e.batch.at(-1)!]?.merged?.commit === e.commit : batchScope === e.batch.join('\0');
}
/** GR3: the unchanged writes key must not carry a grant-supported pass into a new attempt. */
function grantPassReusable(s: State, e: ObsEntry): boolean {
  if (e.obligation !== 'writes' || e.verdict !== 'pass') return true;
  const c = s.nodes[e.subject]?.candidate;
  if (!c || c.commit !== e.commit) return true;
  const supported = context(s).grants?.get(e.subject)?.some(g => g.seq < e.seq);
  return !supported || c.changed.every(p => withinWrites(s,e.subject,p));
}
const hasVerdict = (s: State, subject: string, obligation: string, key: string): boolean => counted(s, subject, obligation, key).some(e => e.verdict !== 'error');

export function nodeReview(s: State, id: string): ReturnType<typeof reviewRequirement> {
  const spec = nodeSpec(s, id);
  return spec ? reviewRequirement(s.plan, spec, s.nodes[id]?.candidate?.changed ?? []) : { count: 0, min_rank: 1, cause: 'no node spec' };
}
function required(plan: Plan, spec: NodeSpec, facts: CandidateFacts): string[] {
  return [...spec.checks.flatMap(c => [`check:${c.id}`, ...(c.red ? [`red:${c.id}`] : []), ...(c.mutants ? [`strength:${c.id}`] : [])]), 'writes', ...(facts.closureTouched ? ['closure-review'] : []), ...(reviewRequirement(plan, spec, facts.changed).count > 0 ? ['review'] : []), ...(spec.approve ? ['approve'] : []), ...(spec.evidence ?? []).map(e => `evidence:${e.id}`), 'rulings'];
}
/**
 * D23 item keys of a node's manual obligations on a candidate with patch `patch` (as for review):
 * `approve` = H({o:"approve", patch}), `evidence:<id>` = H({o:"evidence", id, what, patch}). Empty for nodes without them.
 */
export function manualKeys(spec: NodeSpec, patch: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (spec.approve) out.approve = H({ o: 'approve', patch });
  for (const e of spec.evidence ?? []) out[`evidence:${e.id}`] = H({ o: 'evidence', id: e.id, what: e.what, patch });
  return out;
}
/** A D23 manual obligation (`approve` or `evidence:<id>`): never measured by the executor. */
export const isManual = (obligation: string): boolean => obligation === 'approve' || obligation.startsWith('evidence:');
/** `by` is a writer of node n (any attempt), or shares a writer's id (as for reviews). */
const isWriter = (n: NodeState | undefined, by: string): boolean => !!n && (n.writers.includes(by) || n.writers.some(w => w.slice(w.indexOf(':') + 1) === by.slice(by.indexOf(':') + 1)));
/** PR1: prospective policy binds only attempts dispatched after the ruling. */
export const ruleApplies = (s: State, node: string, r: Rule): boolean => (r.nodes === '*' || r.nodes.includes(node)) && (!r.prospective || (s.nodes[node]?.slot?.dispatchSeq ?? -1) > r.seq);
export const applicableRules = (s: State, node: string): Rule[] => s.rules.filter(r => ruleApplies(s, node, r));
function latestRule(s: State, node: string): number {
  return Math.max(-1, ...applicableRules(s, node).map(r => r.seq));
}
/** WG3: potential writes overlap is conservative; matching grants remains exact. */
export const writesOverlap = (a: string[], b: string[], aSyntax: WritesSyntax = 2, bSyntax: WritesSyntax = aSyntax): boolean => a.some(p => b.some(q => writeOverlaps(p, q, aSyntax, bSyntax)));
/** Other nodes with an open slot whose `writes` overlap those of node `id`, sorted. */
export function overlapping(s: State, id: string): string[] {
  return Object.values(s.nodes).filter(x => x.id !== id && x.slot?.open && effectiveWritesOverlap(s, id, x.id)).map(x => x.id).sort();
}
/** GR3: grants survive resubmits, rebases and plan changes, but never a new attempt. */
export function grantsOf(s: State, id: string): import('./types.ts').GrantEntry[] {
  const attempt = s.nodes[id]?.slot?.attempt;
  return (context(s).grants?.get(id) ?? []).filter(e => e.attempt === attempt);
}
function planForWrites(s: State, id: string): Plan {
  const n = s.nodes[id];
  return nodeSpec(s,id) || !n?.slot?.open ? s.plan : planAt(s,n.slot.dispatchSeq);
}
function planWrites(s: State, id: string): string[] {
  return planForWrites(s,id).nodes.find(x => x.id === id)?.writes ?? [];
}
export function effectiveWrites(s: State, id: string): string[] { return [...planWrites(s, id), ...grantsOf(s, id).flatMap(g => g.paths)]; }
/** Plan writes are prefixes or globs; granted paths are exact repository paths, never prefixes. */
export function withinWrites(s: State, id: string, path: string): boolean {
  return planWrites(s, id).some(w => matchesWrite(path, w, writesSyntax(planForWrites(s,id)))) || grantsOf(s, id).some(g => g.paths.includes(path));
}
export function effectiveWritesOverlap(s: State, a: string, b: string): boolean {
  const pa = planWrites(s, a), pb = planWrites(s, b), ga = s.nodes[a]?.slot?.open ? grantsOf(s, a).flatMap(g => g.paths) : [], gb = s.nodes[b]?.slot?.open ? grantsOf(s, b).flatMap(g => g.paths) : [];
  const aSyntax = writesSyntax(planForWrites(s,a)), bSyntax = writesSyntax(planForWrites(s,b));
  return writesOverlap(pa, pb, aSyntax, bSyntax) || ga.some(p => pb.some(w => matchesWrite(p, w, bSyntax)) || gb.includes(p)) || gb.some(p => pa.some(w => matchesWrite(p, w, aSyntax)));
}
/** WF2: timing only; the block still binds acceptance and merge and may be waived at any time. */
export function heldFlaky(s: State, node: string, block: Block): boolean {
  const c = s.nodes[node]?.candidate;
  if (block.state !== 'flaky' || !c || block.key === c.keys[block.obligation]) return false;
  const fail = entriesOf(s).find(e => e.seq === block.seq);
  return fail?.kind === 'obs' && fail.merging === undefined && !counted(s,node,block.obligation,c.keys[block.obligation] ?? '').some(e => e.verdict === 'pass');
}
/** WF1: the attribution observation that made this execution block flaky. */
export function flakyPass(s: State, b: Block, before = Infinity): ObsEntry | undefined {
  return entriesOf(s).find((e): e is ObsEntry => e.kind === 'obs' && !!e.attribution && e.verdict === 'pass' && e.subject === b.node && e.obligation === b.obligation && e.key === b.key && e.seq > b.seq && e.seq < before);
}
export function heldFlakyText(s: State, node: string, b: Block): string {
  return `waiting for ${b.obligation} on candidate ${s.nodes[node]?.candidate?.commit.slice(0,12)} before deciding flaky #${b.seq}`;
}
/** Shared diagnostic text, with no effect on keys, verdicts or block state. */
export function flakyBlockText(s: State, b: Block): string {
  const fail = entriesOf(s).find(e => e.seq === b.seq), pass = flakyPass(s,b), c = s.nodes[b.node]?.candidate;
  if (fail?.kind !== 'obs' || !pass) return `flaky block #${b.seq} on ${b.obligation}`;
  const names = fail.failed ?? fail.counts?.failed ?? [];
  let text = `flaky block #${b.seq} on ${b.obligation}${fail.merging !== undefined ? ` (merge key ${b.key.slice(0,12)})` : ''}: ${fail.commit.slice(0,12)} failed #${fail.seq} (${names.slice(0,3).join(', ') || 'unknown failed tests'}${names.length > 3 ? `, +${names.length-3}` : ''}) → passed #${pass.seq} on the same key; a pass does not erase a failure: accept the risk (owed waive ${b.node} ${b.obligation} --accept-risk ${b.seq} --reason "…") or fix it`;
  if (fail.merging === undefined && c && b.key !== c.keys[b.obligation]) {
    const obs = counted(s,b.node,b.obligation,c.keys[b.obligation] ?? ''), latest = obs.findLast(e => e.verdict !== 'error');
    const currentBlock = s.nodes[b.node]?.blocks.findLast(x => x.kind === 'exec' && active(x) && x.obligation === b.obligation && x.key === c.keys[b.obligation]);
    text += `; current candidate ${c.commit.slice(0,12)} ${latest ? `${latest.verdict === 'pass' ? 'passed' : 'failed'} #${latest.seq}${latest.verdict === 'fail' && currentBlock ? ` (block #${currentBlock.seq})` : ''}` : 'not measured yet'}`;
  }
  return text.replace(/[\\\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, c => c === '\\' ? '\\\\' : `\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`);
}
/** Why the driver must leave an owner decision alone; shared by dispatch and its views. */
export function ownerNeeded(s: State, node: string): string | undefined {
  const n = s.nodes[node];
  if (!n) return undefined;
  const entries = entriesOf(s);
  const driverAuthored = (seq: number): boolean => {
    const k = driveReviewerSlot(entries.find(e => e.seq === seq)?.by ?? '', node, n.slot?.attempt ?? 0);
    return !!n.slot?.open && s.plan.nodes.some(x => x.id === node) && k !== undefined && k <= Math.max(nodeReview(s, node).count, 1);
  };
  const ownerBlock = n.blocks.filter(b => !heldFlaky(s,node,b) && (b.state === 'flaky' || (b.state === 'active' && b.kind === 'judgment' && (b.rank ?? 0) >= 2 && !((b.rank ?? 0) <= 2 && driverAuthored(b.seq)))));
  const text = (b: Block): string => b.state === 'flaky' && b.kind === 'exec' ? flakyBlockText(s,b) : `rank ${b.rank} review block #${b.seq} on ${b.obligation} needs the owner`;
  if (n.slot?.open && n.candidate) {
    for (const i of n.items) if (i.status === 'D') {
      const b = ownerBlock.find(b => b.obligation === i.obligation);
      if (b) return text(b);
      if (i.mark === '⊤') return `${i.obligation}: ${i.detail}`;
      if (i.obligation === 'review' && nodeReview(s, node).min_rank > 2) return `review requires rank ${nodeReview(s, node).min_rank}: only the owner can record it`;
    }
    return undefined;
  }
  return ownerBlock.length ? text(ownerBlock[0]!) : undefined;
}
export type DispatchSkip = { kind: 'owner'; reason: string } | { kind: 'max'; open: number; max: number } | { kind: 'overlap'; others: { node: string; paths: string[] }[] } | { kind: 'removed' };
/** WA1: the dispatch loop's skip predicate, including slots removed from the plan and same-pass dispatches. */
export function dispatchSkip(s: State, id: string, max: number, taken = Object.values(s.nodes).filter(n => n.slot?.open && n.phase !== 'removed').map(n => n.id)): DispatchSkip | undefined {
  const owner = ownerNeeded(s, id);
  if (owner) return { kind: 'owner', reason: owner };
  const open = taken.length + Object.values(s.nodes).filter(n => n.slot?.open && n.phase === 'removed').length;
  if (open >= max) return { kind: 'max', open, max };
  if (!s.plan.nodes.some(n => n.id === id)) return { kind: 'removed' };
  const others = [...new Set([...overlapping(s, id), ...taken.filter(other => effectiveWritesOverlap(s, id, other))])].sort();
  if (others.length) return { kind: 'overlap', others: others.map(node => ({ node, paths: effectiveWrites(s, id).filter(p => effectiveWrites(s, node).some(q => writeOverlaps(p, q, writesSyntax(planForWrites(s, id)), writesSyntax(planForWrites(s, node))))) })) };
  return undefined;
}
/** WA1: view the same pass in dispatch order, reserving capacity and writes for preceding ready nodes. */
export function readyDispatchSkips(s: State, max: number): Map<string, DispatchSkip> {
  const taken = Object.values(s.nodes).filter(n => n.slot?.open && n.phase !== 'removed').map(n => n.id), skips = new Map<string, DispatchSkip>();
  for (const n of Object.values(s.nodes).filter(n => n.phase === 'ready').sort((a, b) => b.dependents - a.dependents || a.id.localeCompare(b.id))) {
    const skip = dispatchSkip(s, n.id, max, taken);
    if (skip) skips.set(n.id, skip); else taken.push(n.id);
  }
  return skips;
}
/** Detail of a satisfied `rulings` item when no ruling is in scope for the node (shown as "no rulings apply"). */
export const NO_RULINGS = 'no ruling is in scope for this node';
/** KR2: a merging fix node cannot use its own exemptions, even before its merge is recorded. */
export function activeKnownRed(s: State, invId: string, merging?: string): { test: string; fix: string }[] {
  return (s.plan.invariants.find(i => i.id === invId)?.known_red ?? []).filter(e => e.fix !== merging && !!nodeSpec(s, e.fix) && !s.nodes[e.fix]?.merged);
}
/** KR3: names excluded from IR2's trunk comparison when their fix node merges. */
export function fixOwnedKnownRed(s: State, invId: string, merging: string): string[] {
  return (s.plan.invariants.find(i => i.id === invId)?.known_red ?? []).filter(e => e.fix === merging).map(e => e.test);
}
/** MS4: the quarantine names of keys computed on state `s` (a fix that merged or left the plan is inactive; `merging` counts as merged). */
export function stateQuarantine(s: State, merging?: string): QuarantineNames { return quarantineNames(s.plan, id => !!s.nodes[id]?.merged, merging); }
/** MS4: the active quarantine entries of `spec` on state `s`. */
export function activeQuarantineOf(s: State, spec: CheckSpec, merging?: string): import('./types.ts').QuarantineEntry[] { return activeQuarantine(s.plan, spec, id => !!s.nodes[id]?.merged, merging); }
/** MS4: `j` with the active quarantine entries of its spec (the executor applies them only when the key commits to them). */
export function quarantinedJob(s: State, j: AttestJob, merging?: string): AttestJob {
  const q = j.spec && (j.kind === 'check' || j.kind === 'inv') ? activeQuarantineOf(s, j.spec, merging) : [];
  return q.length ? { ...j, quarantined: q } : j;
}
/** Seq of the current plan law (genesis or latest plan), never part of an obligation key. */
export function knownRedPlanSeq(s: State): number { return context(s).lastPlan ?? context(s).genesis?.seq ?? -1; }
function knownRedItem(s: State, obligation: string, failures: ObsEntry[], merging?: string): string | undefined {
  const entries = activeKnownRed(s, obligation.slice(4), merging), names = [...new Set(failures.flatMap(e => e.failed ?? []))];
  if (!failures.length || !failures.every(testOnlyFailure) || !names.every(name => entries.some(e => e.test === name))) return undefined;
  const fixes = [...new Set(entries.filter(e => names.includes(e.test)).map(e => e.fix))];
  return `${obligation} known red: ${names.join(', ')} (fix: ${fixes.join(', ')}; plan #${knownRedPlanSeq(s)})`;
}
/** The check or invariant spec an execution obligation of `subject` runs under in the current plan. */
function execSpec(s: State, subject: string, obligation: string): CheckSpec | undefined {
  const id = obligation.slice(obligation.indexOf(':') + 1);
  return subject === 'trunk' ? (obligation.startsWith('inv:') ? s.plan.invariants.find(i => i.id === id) : undefined) : obligation.startsWith('check:') ? nodeSpec(s, subject)?.checks.find(c => c.id === id) : undefined;
}
/** IF: a setup failure asserted no test result; classify from ledger facts, never a display signature. */
export function setupFailure(s: State, o: Pick<ObsEntry, 'subject' | 'obligation' | 'verdict' | 'counts' | 'failed' | 'note' | 'runs' | 'execution'> & { seq?: number }): boolean {
  if (!/^(check|inv):/.test(o.obligation) || o.verdict !== 'fail') return false;
  const noTests = (r: Pick<ObsEntry, 'verdict' | 'counts' | 'failed' | 'note' | 'execution'>): boolean => r.verdict === 'fail' && r.execution?.completed !== false &&
    (r.counts?.tests === undefined || r.counts.tests === 0) && !r.failed?.length && !r.counts?.failed?.length &&
    !(r.counts?.fail ?? 0) && !(r.counts?.pass ?? 0) && !(r.counts?.skip ?? 0) && !/^timeout after /i.test(r.note ?? '');
  if (!noTests(o) || o.runs?.some(r => !noTests(r))) return false;
  const plan = o.seq === undefined ? s.plan : obsPlan(context(s),o.seq) ?? s.plan;
  const id = o.obligation.slice(o.obligation.indexOf(':') + 1);
  const spec = o.obligation.startsWith('inv:') ? plan.invariants.find(i => i.id === id) : plan.nodes.find(n => n.id === o.subject)?.checks.find(c => c.id === id);
  return !!spec && (spec.min_tests !== undefined || !!o.counts?.format || context(s).entries.some(e => e.kind === 'obs' && e.by === 'executor:owed' && e.subject === o.subject && e.obligation === o.obligation && (o.seq === undefined || e.seq < o.seq) && (e.counts?.tests ?? 0) > 0));
}
/** IF-R1: resolve only the consecutive zero-result suffix named by a validated infra receipt.
 * Input includes every executor measurement of one exact key, including errors and diagnostic measurements.
 */
function resolvedSetupFailures(s: State, obs: readonly ObsEntry[], receipt?: number): Set<number> {
  const resolved = new Set<number>();
  for (let i = 0; i < obs.length; i++) {
    const pass = obs[i]!;
    if (pass.infra === undefined || receipt !== undefined && pass.seq !== receipt) continue;
    for (let j = i - 1; j >= 0; j--) {
      const fail = obs[j]!;
      if ((j === i - 1 && fail.seq !== pass.infra) || fail.probe !== undefined || fail.batch !== undefined || !setupFailure(s,fail)) break;
      resolved.add(fail.seq);
    }
  }
  return resolved;
}
/** IF2: counted pass on the exact key, immediately after a setup failure. Undefined is always conservative. */
export function infraSource(s: State, d: Extract<Draft, { kind: 'obs' }>): number | undefined {
  if (d.by !== 'executor:owed' || d.verdict !== 'pass' || d.probe !== undefined || d.batch !== undefined) return;
  const first = observations(s,d.subject,d.obligation,d.key).at(-1);
  if (!first || first.probe !== undefined || first.batch !== undefined || !setupFailure(s,first)) return;
  // Attribution may measure an old key: its spec is the law of the failed run, not a later lowered threshold.
  const plan = obsPlan(context(s),first.seq) ?? s.plan;
  const spec = d.obligation.startsWith('inv:') ? plan.invariants.find(i => `inv:${i.id}` === d.obligation) : plan.nodes.find(n => n.id === d.subject)?.checks.find(c => `check:${c.id}` === d.obligation);
  const pass = (r: Pick<ObsEntry, 'verdict' | 'exit' | 'counts' | 'failed' | 'execution' | 'note'>): boolean => r.verdict === 'pass' && r.exit === 0 && !/^timeout after /i.test(r.note ?? '') &&
    Number.isSafeInteger(r.counts?.tests) && (r.counts?.tests ?? 0) > 0 && (r.counts?.tests ?? 0) >= (spec?.min_tests ?? 0) &&
    r.counts?.fail === 0 && !r.failed?.length && !r.counts?.failed?.length && (!r.execution || r.execution.completed && r.execution.countOK);
  if (!spec || !pass(d) || d.runs?.some(r => !pass(r)) || (spec.repeat && (!d.runs?.length || d.runs.length < (spec.repeat.need ?? spec.repeat.runs) || d.runs.length > spec.repeat.runs))) return;
  return first.seq;
}
/**
 * MS1 (parent ruling 10-15): with `repeat {runs: N, need: K}`, every run of every non-error observation on one key is
 * pooled (an observation without runs is one run): the item passes iff passes*N >= K*total, else it fails (never ⊤).
 * Undefined without repeat or without a verdict; `text` only when more than one observation is pooled.
 */
function pooledRuns(s: State, subject: string, obligation: string, obs: ObsEntry[]): { pass: boolean; text?: string } | undefined {
  const repeat = execSpec(s, subject, obligation)?.repeat, voted = obs.filter(e => e.verdict !== 'error');
  if (!repeat || !voted.length) return undefined;
  const runs = voted.flatMap(e => e.runs?.length ? e.runs.map(r => r.verdict) : [e.verdict]), passes = runs.filter(v => v === 'pass').length;
  const need = repeat.need ?? repeat.runs, pass = passes * repeat.runs >= need * runs.length;
  return { pass, ...(voted.length > 1 ? { text: `pooled ${passes}/${runs.length} runs on this key (need ${need}/${repeat.runs})` } : {}) };
}
function item(s: State, subject: string, obligation: string, key: string, merging?: string, pending?: ObsEntry): ItemView {
  const node = s.nodes[subject];
  const spec = nodeSpec(s, subject);
  const blocks = node?.blocks.filter(b => b.obligation === obligation && active(b)) ?? [];
  const out: ItemView = { subject, obligation, key, status: 'D', mark: '⊥', discharger: 'executor', evidence: [], detail: `${obligation} awaiting observation` };
  let pooled: string | undefined;
  if (!key) return { ...out, detail: subject === 'trunk' && obligation.startsWith('inv:') ? `${obligation} not measured on trunk yet — owed attest --trunk` : `${obligation} missing fact key` };
  if (obligation === 'review' || obligation === 'closure-review') {
    const derived = nodeReview(s, subject);
    const rank = obligation === 'closure-review' ? 2 : derived.min_rank;
    const count = obligation === 'closure-review' ? 1 : derived.count;
    const reviews = effectiveReviews(s, subject, obligation, key, node?.candidate?.keys[obligation] === key ? node.candidate : undefined).filter(e => e.rank >= rank && !isWriter(node, e.by));
    out.evidence = reviews.map(e => e.seq);
    out.discharger = obligation === 'closure-review' ? 'owner' : 'reviewer';
    out.detail = `${obligation} requires ${count} non-writer reviews with rank at least ${rank}${obligation === 'review' && s.plan.risk !== undefined ? `; ${reviewRequirementText(derived)}` : ''}`;
    if (new Set(reviews.map(e => e.by)).size >= count) out.status = 'E';
  } else if (obligation === 'rulings') {
    const latest = latestRule(s, subject);
    const acknowledgments = listed(context(s).reviews, subject).filter(e => e.kind === 'review' && e.node === subject && e.attempt === node?.slot?.attempt && e.seq > (node?.slot?.dispatchSeq ?? -1) && e.verdict === 'ok' && e.rank >= 1 && (e.ack_rulings ?? -1) >= latest && !isWriter(node, e.by) && (e.key === node?.candidate?.keys[e.obligation] || node?.candidate?.carry?.reviews.includes(e.seq)));
    if ((node?.slot?.rulings_seen ?? -1) >= latest || acknowledgments.length) {
      out.status = 'E';
      out.evidence = acknowledgments.length ? acknowledgments.map(e => e.seq) : [node!.slot!.dispatchSeq];
    }
    out.discharger = 'reviewer';
    out.detail = latest === -1 ? NO_RULINGS : `rulings requires acknowledgment of applicable ruling #${latest}`;
    if (latest === -1 && out.status === 'E') return { ...out, mark: '✔', discharger: undefined };
  } else if (obligation === 'approve') {
    const oks = listed(context(s).reviews, subject).filter(e => e.kind === 'review' && e.node === subject && e.obligation === 'approve' && e.key === key && e.verdict === 'ok' && role(e.by) === 'owner');
    out.evidence = oks.map(e => e.seq);
    out.discharger = 'owner';
    out.detail = 'approve requires an owner approval of the current candidate';
    if (oks.length) out.status = 'E';
  } else if (obligation.startsWith('evidence:')) {
    const ev = spec?.evidence?.find(x => `evidence:${x.id}` === obligation), need = ev?.by ?? 'reviewer';
    const found = listed(context(s).evidence, subject).filter((e): e is EvidenceEntry => e.kind === 'evidence' && e.node === subject && e.id === ev?.id && e.key === key && e.merge === undefined && e.files.length > 0 && (role(e.by) === need || role(e.by) === 'owner') && !isWriter(node, e.by));
    out.evidence = found.map(e => e.seq);
    out.discharger = need as Discharger;
    out.detail = `${obligation} requires manual evidence by ${need}${ev ? `: ${ev.what}` : ''}`;
    if (found.length) out.status = 'E';
  } else {
    const obs = counted(s, subject, obligation, key);
    if (pending) obs.push(pending);
    const pool = pooledRuns(s, subject, obligation, obs);
    if (pool) pooled = pool.text;
    const pass = pool ? pool.pass : obs.some(e => e.verdict === 'pass');
    const fail = pool ? !pool.pass : obs.some(e => e.verdict === 'fail');
    out.evidence = obs.map(e => e.seq);
    if (pass && fail) Object.assign(out, { mark: '⊤', discharger: 'owner', detail: `${obligation} conflicting pass and fail observations on the same key` });
    else if (fail) {
      const detail = subject === 'trunk' && obligation.startsWith('inv:') ? knownRedItem(s, obligation, obs.filter(e => e.verdict === 'fail'), merging) : undefined;
      if (detail) return { ...out, status: 'W', mark: '⚠', discharger: undefined, detail, evidence: [...out.evidence, knownRedPlanSeq(s)] };
      Object.assign(out, { mark: '✘', discharger: 'writer', detail: `${obligation} current content failed${pooled ? `; ${pooled}` : ''}` });
    }
    else if (pass) out.status = 'E';
  }
  if (blocks.length) {
    out.status = 'D';
    out.evidence = [...new Set([...out.evidence, ...blocks.map(b => b.seq)])];
    const currentFailed = out.mark === '✘';
    if (out.mark !== '⊤') out.mark = '⛔';
    const actionable = blocks.filter(b => !heldFlaky(s,subject,b));
    out.discharger = out.mark === '⊤' || actionable.some(b => b.state === 'flaky' || (b.kind === 'judgment' && (b.rank ?? 0) >= 2)) ? 'owner' : actionable.some(b => b.kind === 'judgment') ? 'reviewer' : currentFailed ? 'writer' : 'executor';
    out.detail = actionable.length ? `${obligation} still blocked: ${actionable.map(b => b.state === 'flaky' && b.kind === 'exec' ? flakyBlockText(s,b) : `#${b.seq}`).join(', ')}` : blocks.map(b => heldFlakyText(s,subject,b)).join('; ');
  }
  if (obligation === 'writes') {
    const waiting = writesWaiting(s,subject);
    if (waiting && waiting.key === key) out.detail = waiting.note ?? `writes waiting for ${waiting.waits_on!.join(', ')}; re-measured automatically after ownership closes`;
  }
  if (out.status === 'E') return { ...out, mark: '✔', discharger: undefined, detail: `${obligation} satisfied${isManual(obligation) ? ' (manual)' : ''}${pooled ? `; ${pooled}` : ''}` };
  if (subject !== 'trunk' && !obligation.startsWith('inv:')) {
    const waiver = listed(context(s).waives, subject).findLast(e => e.kind === 'waive' && role(e.by) === 'owner' && e.node === subject && e.obligation === obligation && e.key === key && blocks.every(b => (e.accept_risk ?? []).includes(b.seq) && e.seq > b.seq));
    if (waiver?.kind === 'waive') return { ...out, status: 'W', mark: '⚠', discharger: undefined, evidence: [...out.evidence, waiver.seq], detail: `${obligation} owner waived: ${waiver.reason}${waiver.channel === 'flag' ? ' (flag weak confirmation)' : waiver.channel === 'delegated' ? ' (delegated)' : ''}` };
  }
  const trunkRed = blocks.flatMap(b => trunkRedOf(s, b.seq, b.key) ?? []);
  if (out.status === 'D' && trunkRed.length) Object.assign(out, { discharger: 'parent', detail: trunkRed.map(r => `${trunkRedText(r)}; merge-tree obs #${r.merge.seq}, trunk probe #${r.probe.seq}`).join('; ') });
  if (subject === 'trunk') {
    const defer = s.deferred.findLast(d => d.id === obligation.slice(4) && d.key === key && (!automaticInvariantConflict(s,obligation,key) || d.node === merging));
    if (defer) Object.assign(out, { mark: '⏸', discharger: 'owner', detail: `${obligation} ${deferLabel(defer)}, still debt`, evidence: [...out.evidence, defer.seq] });
    else {
      const red = context(s).invRed?.get(obligation), fail = decidingInvariantFail(s, obligation, key);
      if (red?.key === key && fail && out.mark === '✘') Object.assign(out, { discharger: 'parent', detail: red.kind === 'merge'
        ? `trunk-red: ${obligation} already failed on trunk before ${red.node} (${fail.failed?.join(', ') || 'unknown failed tests'}); merge #${red.seq}`
        : invariantRedText(s, obligation, red, fail) });
    }
  }
  if (subject === 'trunk' && out.status === 'D') {
    const obs = counted(s,subject,obligation,key), retry = obs.find(e => e.auto_remeasure);
    const first = retry && obs.find(e => e.seq < retry.seq && e.verdict === 'fail');
    if (first && retry) {
      const quote = (e: ObsEntry) => `#${e.seq} ${e.verdict}${e.note ? ` (${e.note.split('; last output:')[0]!.replace(/\s+/g,' ')})` : ''}`;
      out.detail += `; automatic same-key remeasure: ${quote(first)}; ${quote(retry)}; ${out.mark === '⊤' ? 'conflicting pass and fail need the owner: fix the invariant or defer it for a specific node' : 'retry consumed on this key; fix the invariant'}`;
    }
  }
  return out;
}
function nodeItems(s: State, id: string, facts: CandidateFacts): ItemView[] {
  const spec = nodeSpec(s, id);
  return spec ? required(s.plan, spec, facts).map(o => item(s, id, o, facts.keys[o] ?? '')) : [];
}
/**
 * N4: the nodes whose derived fields (items, accepted, acceptedSince, phase, dependents, stale halt) entry `e` can change. Those
 * fields read only the node's own slot, candidate, blocks, writers and entries, the rulings in its scope, the plan and
 * (phase) the merged state of its deps; trunk-red diagnostics also read current trunk. So genesis, plan, merge and
 * adopt touch every node, a ruling the nodes it names, an observation its subject, any other entry with a node its
 * node, and the rest none.
 */
function touched(e: Entry): Set<string> | 'all' {
  if (e.kind === 'genesis' || e.kind === 'plan' || e.kind === 'merge' || e.kind === 'adopt' || e.kind === 'refresh') return 'all';
  if (e.kind === 'rule') return e.nodes === '*' ? 'all' : new Set(e.nodes);
  if (e.kind === 'obs') return new Set([e.subject]);
  return 'node' in e ? new Set([e.node]) : new Set();
}
function refresh(s: State, dirty: Set<string> | 'all' = 'all'): void {
  const h = context(s);
  for (const spec of s.plan.nodes) {
    if (dirty !== 'all' && !dirty.has(spec.id)) continue;
    const n = s.nodes[spec.id] ??= emptyNode(spec.id);
    n.items = n.candidate ? nodeItems(s, n.id, n.candidate) : [];
    n.accepted = !!n.candidate && (!!n.slot?.open || !!n.merged) && n.items.every(i => i.status !== 'D') && !n.blocks.some(b => binding(b, spec));
    refreshAcceptedSince(n, s.seq);
    n.phase = n.merged ? 'merged' : n.slot?.open ? n.candidate ? n.accepted ? 'accepted' : 'submitted' : 'dispatched' : n.held !== undefined ? 'held' : !spec.later && spec.deps.every(d => s.nodes[d]?.merged) ? 'ready' : 'blocked';
    n.dependents = h.dependents.get(n.id) ?? 0;
    if (n.halt && (!n.slot?.open || n.slot.attempt !== n.halt.attempt)) n.halt = undefined;
  }
  // F4 (wais #27): a node in the state but not in the current plan and not merged is `removed`, never ready.
  for (const id of dirty === 'all' ? Object.keys(s.nodes) : dirty) {
    const n = s.nodes[id];
    if (n && !nodeSpec(s, id)) { n.phase = n.merged ? 'merged' : 'removed'; delete n.held; if (!n.candidate) delete n.acceptedSince; }
  }
  s.invariants = s.plan.invariants.map(i => item(s, 'trunk', `inv:${i.id}`, s.trunk.invKeys[i.id] ?? ''));
  const g = h.genesis;
  // Genesis covers the invariants of the genesis plan; invariants added later are
  // judged by the no-new-debt rule on the first merge that carries their key.
  // Invariants removed later by the owner (a visible downgrade) are exempt.
  s.genesisDone = !!g && lawPlan(h, g.plan).invariants.filter(i => s.plan.invariants.some(c => c.id === i.id)).every(i => !!g.state.invKeys[i.id] && hasVerdict(s, 'trunk', `inv:${i.id}`, g.state.invKeys[i.id]!));
}

/** MO1: preserve the acceptance tenure across unrelated entries; losing acceptance clears it. */
function refreshAcceptedSince(n: NodeState, seq: number): void {
  if (n.accepted) n.acceptedSince ??= seq;
  else delete n.acceptedSince;
}

/**
 * N4: the plan object the state keeps: a lookup's deep-frozen plan (ops' plan cache) is shared, since nothing can change
 * it; any other is cloned as before, so a caller's later change cannot reach the state.
 */
const own = (p: Plan): Plan => Object.isFrozen(p) && Object.isFrozen(p.nodes) ? p : structuredClone(p);
/** G1: the plan object of sha `sha` the state keeps (resolved through the lookup once per replay, then shared). */
function lawPlan(h: History, sha: string): Plan {
  let p = h.planObjs.get(sha);
  if (!p) { p = own(h.plans(sha)); h.planObjs.set(sha, p); }
  return p;
}
function recordedPlan(h: History, e: Pick<import('./types.ts').PlanEntry, 'plan' | 'writes_syntax'>): Plan {
  return withWritesSyntax(lawPlan(h,e.plan),e.writes_syntax ?? 1);
}
/** The plan in force at executor observation `seq` (attribution reruns, supersede). */
const obsPlan = (h: History, seq: number): Plan | undefined => { const sha = h.obsPlans.get(seq); return sha === undefined ? undefined : lawPlan(h, sha); };
function blank(plans: PlanLookup): State {
  const s: State = { seq: -1, head: ZERO, genesisDone: false, trunk: { name: '', commit: '', tree: '', invKeys: {}, seq: -1 }, planSha: '', plan: blankPlan(), nodes: Object.create(null) as Record<string, NodeState>, invariants: [], rules: [], downgrades: [], deferred: [], escapes: [], decoys: [], decoyCommits: [], adoptions: [] };
  const h: History = { entries: [], plans, planObjs: new Map(), obsPlans: new Map(), mergeCatches: new Set(), shadow: new Map(), bySeq: new Map(), obs: new Map(), reviews: new Map(), evidence: new Map(), waives: new Map(), launches: new Map(), dependents: new Map() };
  Object.defineProperty(s, history, { value: h });
  return s;
}
/** Replay is deterministic; non-enumerable metadata retains the observations needed by pure queries. */
export function reduce(entries: Entry[], plans: PlanLookup): State {
  const s = blank(plans);
  fold(s, entries);
  return s;
}
/**
 * G1.2 (0.12): the state of `entries(base) ++ more`, without mutating `base`: a copy of `base` (state and replay
 * metadata, internal sharing kept) continues the fold. Equal (`sameReplay`) to `reduce` of all those entries.
 * `plans` resolves the plans `more` names; the plans `base` already holds are kept.
 */
export function reduceFrom(base: State, more: Entry[], plans: PlanLookup): State {
  const s = copyState(base, plans);
  fold(s, more);
  return s;
}
/** G1: continues the fold of `s` itself with `more` (mutates and returns `s`); for a state the caller owns alone. */
export function extendState(s: State, more: Entry[]): State { fold(s, more); return s; }
/** The entry kinds this owed interprets (G1.5): any other kind needs a newer owed. */
const KINDS: readonly string[] = ['genesis', 'refresh', 'plan', 'rule', 'dispatch', 'submit', 'grant', 'obs', 'review', 'waive', 'defer', 'abandon', 'hold', 'rebase', 'merge', 'note', 'adopt', 'escape', 'decoy-commit', 'decoy-reveal', 'launch', 'send', 'halt', 'evidence', 'resume', 'sweep'];
/**
 * G1.5 closed entry enum audit (types.ts): Base.channel, send.sendKind/reason, obs.verdict, review.obligation/verdict/
 * needs, launch.role, halt.needs, escape.class. `by`, other obligations and counts.format are open strings, not enums;
 * boolean flags (rule.writer, attribution, closureTouched) retain their existing invalid-type errors.
 */
const CHANNELS: readonly string[] = ['tty', 'pi-confirm', 'flag', 'delegated'];
let enumCache: Record<string, Record<string, readonly unknown[]>> | undefined;
const enums = (): Record<string, Record<string, readonly unknown[]>> => enumCache ??= {
  send: { sendKind: SEND_KINDS, reason: SEND_REASONS },
  sweep: { verdict: ['pass', 'fail', 'error'] },
  obs: { verdict: ['pass', 'fail', 'error'], probe: ['trunk'] },
  review: { obligation: ['review', 'closure-review', 'approve'], verdict: ['ok', 'block'], needs: ['parent'] },
  launch: { role: ['writer', 'reviewer'] },
  halt: { needs: ['human', 'owner'] },
  escape: { class: ESCAPE_CLASSES },
};
/** AR / ruling #1600: re-asks are history; supersedes makes their version boundary explicit. */
function answerRevisionErrors(s: State, a: import('./types.ts').AnswerRef | undefined, supersedes?: number, decision = false): string[] {
  const history = s.rules.flatMap(x => ruleAnswers(x).filter(ref => ref.rid === a?.rid && ref.qid === a?.qid).map(ref => ({ seq:x.seq, ref })));
  const latest = history.at(-1), errors: string[] = [];
  if (history.some(x => x.ref.rev === a?.rev)) errors.push(`answer for this rid/qid/rev (rev ${a?.rev}) is already recorded; retry its send`);
  if (latest) {
    if (!(latest.ref.rev < a!.rev) || (!decision && (!Number.isSafeInteger(supersedes) || supersedes !== latest.seq))) errors.push(`answer supersedes must name latest prior answer rule #${latest.seq} for this rid/qid with a lower rev`);
  } else if (supersedes !== undefined) errors.push('answer supersedes must be absent without a prior answer for this rid/qid');
  return errors;
}
/** DC/AN: common answer lookup for delivery, retries and driver notices. */
export function ruleAnswers(r: { answer?: import('./types.ts').AnswerRef; answers?: import('./types.ts').DecisionAnswer[] }): import('./types.ts').AnswerRef[] { return r.answers ?? (r.answer ? [r.answer] : []); }

/** DC: multi-answer facts are versioned, sorted and scoped to current launches. */
function decisionAnswersErrors(s: State, d: Extract<Draft,{kind:'rule'}>): string[] {
  const refs = d.answers, errors: string[] = [];
  if (d.decision === undefined || d.answer !== undefined || d.supersedes !== undefined || !Array.isArray(refs) || refs.length < 2) return ['rule answers requires a decision, at least two answers and no answer/supersedes'];
  const seen = new Set<string>();
  for (const a of refs) {
    if (!a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).some(k => !['node','rid','qid','rev'].includes(k)) || typeof a.node !== 'string' || typeof a.rid !== 'string' || !a.rid.trim() || typeof a.qid !== 'string' || !a.qid.trim() || !Number.isSafeInteger(a.rev) || a.rev < 1) { errors.push('rule answers must list {node, rid, qid, rev} with nonempty ids and positive integer revisions'); continue; }
    const target = s.nodes[a.node], launch = target?.slot?.open ? target.runs.find(r => r.attempt === target.slot!.attempt)?.launches.find(l => l.rid === a.rid) : undefined;
    if (!Array.isArray(d.nodes) || !d.nodes.includes(a.node) || !launch) errors.push('rule answers must name current launches of decided nodes');
    if (seen.has(a.node)) errors.push('decision answers one unambiguous question per node');
    seen.add(a.node); errors.push(...answerRevisionErrors(s,a,undefined,true));
  }
  if (!errors.length && canonical(refs) !== canonical([...refs].sort((a,b) => a.node.localeCompare(b.node) || a.qid.localeCompare(b.qid)))) errors.push('rule answers must be sorted by node then qid');
  return errors;
}
/** DC: infer the decided nodes from a writes-only amend; all gain identical additions. */
export function decisionPlanNodes(prior: Plan, next: Plan): string[] {
  const nodes: string[] = [], additions: string[][] = [];
  if (prior.nodes.length !== next.nodes.length) throw new OwedError('decision plan must contain writes-only additions');
  const expected = { ...prior, nodes:prior.nodes.map((n,i) => {
    const changed = next.nodes[i]!;
    if (n.id !== changed.id || n.writes.some((p,j) => changed.writes[j] !== p)) throw new OwedError('decision plan must contain writes-only additions');
    const added = changed.writes.slice(n.writes.length);
    if (added.length) { nodes.push(n.id); additions.push(added); }
    return { ...n, writes:changed.writes };
  }) };
  if (!nodes.length || canonical(expected) !== canonical(next) || additions.some(a => canonical(a) !== canonical(additions[0])) || additions.some((a,i) => a.some(p => prior.nodes.find(n => n.id === nodes[i])!.writes.includes(p)) || new Set(a).size !== a.length)) throw new OwedError('decision plan must contain writes-only additions of the same paths to every decided node');
  return nodes;
}
const decisionRank = (d: Draft): number => ['plan','submit','defer','rule','resume'].indexOf(d.kind);
function decisionMembers(s: State): Entry[] {
  const es = entriesOf(s), last = es.at(-1);
  return last?.decision === undefined ? [] : es.slice(last.decision);
}
/**
 * DF1: the first seq of a final decision group still missing its ruling (an append in flight for an unlocked reader),
 * when the tail is exactly that group's well-formed prefix; else undefined (replay judges anything else).
 */
export function decisionInFlight(entries: readonly Entry[]): number | undefined {
  const first = entries.at(-1)?.decision;
  if (first === undefined || !Number.isSafeInteger(first) || first < 0 || first >= entries.length) return undefined;
  const members = entries.slice(first);
  return members.every(e => e.decision === first && e.kind !== 'rule') ? first : undefined;
}
/** A final group needs its one ruling; private drafting may temporarily have a plan/defer prefix. */
export function decisionTailErrors(s: State): string[] {
  const members = decisionMembers(s);
  return members.length && members.filter(e => e.kind === 'rule').length !== 1 ? [`decision #${members[0]!.seq} is incomplete: its one ruling is missing (an interrupted atomic write); nothing else may follow it; inspect the ledger tail before retrying`] : [];
}
function decisionErrors(s: State, d: Draft): string[] {
  const first = d.decision, own = s.seq+1, prior = decisionMembers(s);
  if (first === undefined) return decisionTailErrors(s);
  if (!Number.isSafeInteger(first) || first < 0 || first > own) return ['decision must reference its first entry seq'];
  const members = first === own ? [] : prior;
  if (first === own && decisionTailErrors(s).length) return decisionTailErrors(s);
  if (first !== own && (!members.length || members[0]?.seq !== first || members.some(e => e.decision !== first) || members.length !== own-first)) return ['decision entries must be contiguous and reference their first entry'];
  const head = members[0] ?? d, rank = decisionRank(d), lastRank = members.length ? decisionRank(members.at(-1)!) : -1;
  const errors: string[] = [];
  if (rank < 0 || rank < lastRank || (d.kind === 'plan' && members.length) || (d.kind === 'rule' && members.some(e => e.kind === 'rule')) || (d.kind === 'resume' && !members.some(e => e.kind === 'rule'))) errors.push('decision order must be plan, carries, defers, one rule, resumes');
  if (!['owner','parent'].includes(role(head.by)) || head.by === DRIVER) errors.push('decision requires one parent or owner principal');
  if (d.by !== head.by || d.channel !== head.channel) {
    if (!(d.kind === 'submit' && d.by === 'executor:owed' && d.carry !== undefined && head.kind === 'plan')) errors.push('decision entries must use one principal and channel (except amend carry submits)');
  }
  let nodes: string[] | undefined;
  if (head.kind === 'plan') {
    try { nodes = decisionPlanNodes(withWritesSyntax(context(s).plans(head.prior),2),withWritesSyntax(context(s).plans(head.plan),2)); } catch (e) { errors.push((e as Error).message); }
  } else {
    const rule = members.find(e => e.kind === 'rule') ?? (d.kind === 'rule' ? d : undefined);
    if (rule?.kind === 'rule' && Array.isArray(rule.nodes)) nodes = rule.nodes;
    if (!members.length && !['rule','defer'].includes(d.kind)) errors.push('decision without writes starts with a rule or defer');
  }
  if (d.kind === 'rule') {
    if (!Array.isArray(d.nodes) || !d.nodes.length || new Set(d.nodes).size !== d.nodes.length || d.nodes.some(x => typeof x !== 'string' || !x.trim()) || d.prospective) errors.push('decision ruling must name distinct decided nodes, not prospective or *');
    if (nodes && canonical([...d.nodes].sort()) !== canonical([...nodes].sort())) errors.push('decision ruling nodes must equal the writes-only decided set');
    if (typeof d.text !== 'string' || !d.text.trim()) errors.push('decision requires nonempty text');
  }
  if (nodes && [...members,d].some(e => 'node' in e && !nodes.includes(e.node))) errors.push('decision entries may name only the decided nodes');
  if ('node' in d && members.some(e => e.kind === d.kind && 'node' in e && e.node === d.node)) errors.push('decision repeats an act for the same node');
  if (d.kind === 'submit' && head.kind !== 'plan') errors.push('decision carry requires its amend plan');
  return errors;
}

/** G1.5: the fields a ruling may carry; another one is a ruling flag of a newer owed. */
const RULE_FIELDS: readonly string[] = ['kind', 'by', 'channel', 'seq', 'ts', 'prev', 'hash', 'decision', 'text', 'nodes', 'writer', 'prospective', 'answer', 'answers', 'supersedes'];
/** RC1–RC3: from 0.13, future observation fields must not be silently replayed by verdict alone. */
const OBS_FIELDS: readonly string[] = ['kind', 'by', 'channel', 'seq', 'ts', 'prev', 'hash', 'subject', 'obligation', 'key', 'verdict', 'exit', 'counts', 'log', 'durationMs', 'commit', 'base', 'attribution', 'merging', 'probe', 'note', 'runs', 'noisy', 'failed', 'execution', 'signatures', 'quarantined', 'quarantine_passed', 'grant_refused', 'waits_on', 'auto_remeasure', 'infra', 'remeasure_match', 'batch', 'lease_wait_ms'];
const shown = (v: unknown): string => typeof v === 'string' ? v : JSON.stringify(v) ?? String(v);
/**
 * G1.5 (0.12): the refusal of a replayed entry this owed cannot interpret, or undefined: an unknown `kind`, an unknown
 * value of an enumerated field (ENUMS), or an unknown field on a ruling (a newer ruling flag).
 */
export function newerEntry(e: Entry): OwedError | undefined {
  const malformed = ignorableError(e);
  if (malformed) return new OwedError(`Entry #${e.seq} invalid: ${malformed}`);
  const raw = e as unknown as Record<string, unknown>, kind = raw.kind;
  const refuse = (what: string): OwedError => new OwedError(`ledger entry #${shown(raw.seq)} (${what}) needs a newer owed than ${OWED_VERSION}: upgrade owed and restart pi sessions that load it`, 'version');
  if (typeof kind !== 'string' || !KINDS.includes(kind)) return refuse(shown(kind));
  const x = interpretedEntry(e) as unknown as Record<string, unknown>;
  if (x.channel !== undefined && !CHANNELS.includes(x.channel as string)) return refuse(`${kind} channel ${shown(x.channel)}`);
  for (const [field, known] of Object.entries(enums()[kind] ?? {})) if (x[field] !== undefined && !known.includes(x[field])) return refuse(`${kind} ${field} ${shown(x[field])}`);
  if (kind === 'rule') { const extra = Object.keys(x).find(k => x[k] !== undefined && !RULE_FIELDS.includes(k)); if (extra !== undefined) return refuse(`rule ${extra} ${shown(x[extra])}`); }
  if (kind === 'obs') {
    const extra = Object.keys(x).find(k => x[k] !== undefined && !OBS_FIELDS.includes(k));
    if (extra !== undefined) return refuse(`obs ${extra} ${shown(x[extra])}`);
    if (x.auto_remeasure !== undefined && x.auto_remeasure !== true) return refuse(`obs auto_remeasure ${shown(x.auto_remeasure)}`);
  }
  // FL2/FL3: from 0.13 unknown resume shapes are compatibility errors, not silently interpreted.
  if (kind === 'defer') {
    const extra = Object.keys(x).find(k => x[k] !== undefined && !ENTRY_BASE_FIELDS.includes(k) && !['node', 'items', 'reason', 'allowance'].includes(k));
    if (extra) return refuse(`defer ${extra}`);
  }
  if (kind === 'abandon' || kind === 'hold') {
    const known = kind === 'abandon' ? ['node', 'attempt', 'reason'] : ['node', 'abandon', 'reason'];
    const extra = Object.keys(x).find(k => x[k] !== undefined && !ENTRY_BASE_FIELDS.includes(k) && !known.includes(k));
    if (extra) return refuse(`${kind} ${extra}`);
  }
  if (kind === 'resume') {
    const extra = Object.keys(x).find(k => x[k] !== undefined && !ENTRY_BASE_FIELDS.includes(k) && !STRICT_FIELDS.resume.includes(k));
    if (extra) return refuse(`resume ${extra}`);
    if (x.release !== undefined && x.release !== 'hold') return refuse(`resume release ${shown(x.release)}`);
    if (x.expect !== undefined && x.expect !== 'report') return refuse(`resume expect ${shown(x.expect)}`);
    if (x.remeasure !== undefined && x.remeasure !== true) return refuse(`resume remeasure ${shown(x.remeasure)}`);
    if (x.after !== undefined && typeof x.after !== 'string' && (!Array.isArray(x.after) || x.after.some(v => typeof v !== 'string'))) return refuse('resume after shape');
  }
  return undefined;
}
function fold(s: State, entries: Iterable<Entry>): void {
  const h = context(s);
  for (const original of entries) {
    const newer = newerEntry(original);
    if (newer) throw newer;
    let e = structuredClone(original);
    const errors = validateDraft(s, e);
    if (errors.length) throw new OwedError(`Entry #${e.seq} invalid: ${errors.join('; ')}`);
    e = interpretedEntry(e);
    if (e.kind === 'genesis') {
      h.genesis = e;
      s.plan = recordedPlan(h, e); s.planSha = e.plan; h.dependents = dependentCounts(s.plan);
      s.trunk = { name: e.trunk, ...e.state, seq: e.seq };
      if (s.plan.allow !== undefined) h.allowSeq = e.seq;
    } else if (e.kind === 'refresh') {
      const changed = refreshChanged(s, e.state);
      const red = h.invRed ??= new Map();
      for (const id of changed) red.set(`inv:${id}`, { key: e.state.invKeys[id]!, seq: e.seq, kind: 'refresh' });
      s.trunk.invKeys = { ...e.state.invKeys };
    } else if (e.kind === 'plan') {
      const next = recordedPlan(h, e);
      const detected = downgradeDetails(s.plan, next);
      // A candidate's facts were computed under the old plan; if its node's
      // obligations, setup, exec or closure changed, the writer must submit again.
      // D19.4: the node `type` only names later branches; changing it never invalidates a candidate.
      // K3: the node `drive` only chooses later launches' agents and models; changing it never invalidates a candidate.
      // N1 (0.10): a carry submit by executor:owed may follow the plan entry and restore the same commit as candidate.
      for (const n of Object.values(s.nodes)) if (n.candidate && n.slot?.open && invalidates(s.plan, next, n.id)) n.candidate = undefined;
      const allowChanged = canonical(s.plan.allow) !== canonical(next.allow) || writesAllowChanged(s.plan,next);
      supersede(s, h, e.seq, next);
      s.plan = next; s.planSha = e.plan; h.dependents = dependentCounts(next);
      const items = [...e.downgrades, ...detected.filter(d => !e.downgrades.some(x => x.node === d.node && x.what === d.what))];
      // A parent's downgrades were accepted only because the prior plan's allowances cover them (D21.3).
      if (items.length) s.downgrades.push({ seq: e.seq, by: e.by, items, ...(role(e.by) !== 'owner' && h.allowSeq !== undefined ? { allowance: h.allowSeq } : {}), ...(e.channel === 'delegated' ? { channel: 'delegated' as const } : {}) });
      if (allowChanged) h.allowSeq = e.seq;
    } else if (e.kind === 'grant') {
      s.downgrades.push({ seq: e.seq, by: e.by, items: [{ node: e.node, what: `writes granted: ${e.paths.join(', ')}` }], allowance: e.allowance });
    } else if (e.kind === 'rule') {
      s.rules.push({ seq: e.seq, by: e.by, text: e.text, nodes: e.nodes, ...(e.writer !== undefined ? { writer: e.writer } : {}), ...(e.prospective !== undefined ? { prospective: e.prospective } : {}), ...(e.answer !== undefined ? { answer: e.answer } : {}), ...(e.answers !== undefined ? { answers: e.answers } : {}), ...(e.decision !== undefined ? { decision:e.decision } : {}), ...(e.channel === 'delegated' ? { channel: 'delegated' as const } : {}) });
      // F5: a writer ruling names the candidates that need a new submit; blocks and keys retain their semantics.
      if (e.writer && e.nodes !== '*') for (const id of e.nodes) {
        const n = s.nodes[id];
        if (n?.slot?.open && n.candidate && e.seq > n.candidate.seq) n.candidate = undefined;
      }
    }
    else if (e.kind === 'dispatch') {
      const n = s.nodes[e.node]!;
      const writer = `writer:${e.node}#${e.attempt}`;
      n.slot = { attempt: e.attempt, base: e.base, branch: e.branch, worktree: e.worktree, writer, dispatchSeq: e.seq, rulings_seen: e.rulings_seen, open: true };
      n.candidate = undefined;
      if (!n.writers.includes(writer)) n.writers.push(writer);
    } else if (e.kind === 'submit') {
      // N1: a carry submit names the plan entry that carried it (the latest one before it) and the submit it carried.
      const plan = e.carry !== undefined ? h.lastPlan : undefined;
      const n = s.nodes[e.node]!, spec = nodeSpec(s, e.node);
      // Ruling #1431: a writer resubmit without review obligations acknowledges its recorded ruling follow-ups,
      // never a later unsent ruling, a prospective notify, or an executor carry.
      if (e.by === n.slot?.writer && spec && reviewRequirement(s.plan, spec, e.facts.changed).count === 0 && !e.facts.closureTouched) {
        const ar = n.runs.find(r => r.attempt === e.attempt), writer = ar?.launches.find(l => l.role === 'writer');
        if (writer) n.slot.rulings_seen = Math.max(n.slot.rulings_seen, ...ar!.sends.filter(x => x.rid === writer.rid && x.reason === 'ruling' && x.sendKind === 'follow-up').map(x => x.rulings ?? -1));
      }
      // MO1: a submit replaces the current candidate, even when its evidence can be reused immediately.
      delete n.acceptedSince;
      n.candidate = { ...submittedFacts(s, e), seq: e.seq, ...(e.carry !== undefined && plan !== undefined ? { carried: { plan, submit: e.carry } } : {}) };
    }
    else if (e.kind === 'abandon') { s.nodes[e.node]!.slot!.open = false; s.nodes[e.node]!.candidate = undefined; }
    else if (e.kind === 'hold') { if (nodeSpec(s, e.node)) s.nodes[e.node]!.held = e.abandon; }
    else if (e.kind === 'resume' && e.release === 'hold') { delete s.nodes[e.node]!.held; }
    else if (e.kind === 'rebase') {
      const n = s.nodes[e.node]!, slot = n.slot!;
      const previous = n.candidate ? { base: n.candidate.base, commit: n.candidate.commit, submit: n.candidate.seq } : slot.rebase?.previous;
      slot.rebase = { seq: e.seq, from: e.from, base: e.base, ...(previous ? { previous } : {}) };
      slot.base = e.base; n.candidate = undefined;
    } else if (e.kind === 'obs') {
      h.obsPlans.set(e.seq, s.planSha);
      // A merge-result failure catches an invariant decoy only when PRE was satisfied
      // (E or known-red W) and the result is D; an unchanged known-red W is not a catch.
      if (e.merging && e.verdict === 'fail' && e.by === 'executor:owed') {
        const pre = e.subject === 'trunk' ? item(s, 'trunk', e.obligation, s.trunk.invKeys[e.obligation.slice(4)] ?? '') : undefined;
        if (!pre || pre.status !== 'D' && inBatchScope('', () => item(s, 'trunk', e.obligation, e.key, e.merging, e)).status === 'D') h.mergeCatches.add(e.seq);
      }
      const n = s.nodes[e.subject];
      if (n && e.probe === undefined) {
        const resolved = resolvedSetupFailures(s, [...observations(s,e.subject,e.obligation,e.key),e],e.seq);
        const matches = n.blocks.filter(b => b.kind === 'exec' && underlying(h, b) === 'active' && b.obligation === e.obligation && b.key === e.key);
        if (e.attribution && e.verdict !== 'error') for (const b of matches) {
          // L2: an attribution rerun of a superseded block (recorded before 0.8, or by hand) leaves it superseded.
          if (b.state === 'superseded') { h.shadow.set(b.seq, e.verdict === 'fail' || resolved.has(b.seq) ? 'cleared' : 'flaky'); continue; }
          b.state = e.verdict === 'fail' || resolved.has(b.seq) ? 'cleared' : 'flaky';
          if (b.state === 'cleared') b.clearedBy = e.seq;
        }
        if (e.infra !== undefined) for (const b of n.blocks.filter(b => resolved.has(b.seq) && b.kind === 'exec')) {
          if (b.state === 'superseded') h.shadow.set(b.seq, 'cleared');
          else { b.state = 'cleared'; b.clearedBy = e.seq; }
        }
        // WG5: a later writes verdict supersedes only overlap-only execution blocks.
        if (e.obligation === 'writes' && e.verdict !== 'error' && !e.attribution) for (const b of n.blocks.filter(b => b.kind === 'exec' && underlying(h,b) === 'active' && b.obligation === 'writes')) {
          const prior = listed(h.bySeq,b.seq)[0];
          if (prior?.kind === 'obs' && prior.waits_on) { b.state = 'cleared'; b.clearedBy = e.seq; }
        }
        if (e.verdict === 'fail' && !e.attribution && e.batch === undefined) n.blocks.push({ seq: e.seq, node: e.subject, obligation: e.obligation, kind: 'exec', key: e.key, state: 'active' });
      }
    } else if (e.kind === 'review') {
      const n = s.nodes[e.node]!;
      if (e.verdict === 'block') n.blocks.push({ seq: e.seq, node: e.node, obligation: e.obligation, kind: 'judgment', key: e.key, rank: e.rank, state: 'active', ...(e.needs === 'parent' ? { needs: 'parent' as const } : {}) });
      // An owner block on approve (D23) is cleared by a later owner ok on the current key, whichever owner id.
      else for (const b of n.blocks) if (active(b) && b.kind === 'judgment' && b.obligation === e.obligation && e.key === n.candidate?.keys[e.obligation] && (e.rank > (b.rank ?? 0) || (e.rank >= (b.rank ?? 0) && e.by === listed(h.bySeq, b.seq)[0]?.by) || (e.obligation === 'approve' && role(e.by) === 'owner'))) { b.state = 'cleared'; b.clearedBy = e.seq; }
    } else if (e.kind === 'waive') {
      const n = s.nodes[e.node]!;
      for (const b of n.blocks) if (underlyingActive(h, b) && b.obligation === e.obligation && (e.key === n.candidate?.keys[e.obligation] || e.key === b.key) && e.accept_risk?.includes(b.seq)) {
        if (b.state === 'superseded') h.shadow.set(b.seq, 'cleared'); // L2: the block stays superseded
        else { b.state = 'cleared'; b.clearedBy = e.seq; }
      }
    } else if (e.kind === 'defer') {
      for (const i of e.items) s.deferred.push({ seq: e.seq, node: e.node, id: i.id, key: i.key, ...(e.allowance !== undefined ? { allowance: e.allowance } : {}) });
      // FS6: an executor defer under allowance is an untested obligation (ΔO⁻), like a grant.
      if (e.allowance !== undefined) s.downgrades.push({ seq: e.seq, by: e.by, items: e.items.map(i => ({ node: e.node, what: `inv:${i.id} deferred: ${e.reason}` })), allowance: e.allowance });
    } else if (e.kind === 'merge') {
      const n = s.nodes[e.node]!;
      const inherited = mergeGuard(s, e.node, { facts: e.facts, state: e.state, batch: e.batch }).invItems.filter(i => i.key !== s.trunk.invKeys[i.obligation.slice(4)] && i.detail.startsWith('trunk-red:'));
      if (h.invRed) for (const [o, red] of h.invRed) if (e.state.invKeys[o.slice(4)] !== red.key) h.invRed.delete(o);
      if (inherited.length) for (const i of inherited) (h.invRed ??= new Map()).set(i.obligation, { key: i.key, seq: e.seq, kind: 'merge', node: e.node });
      n.merged = { seq: e.seq, commit: e.commit }; n.slot!.open = false;
      s.trunk = { name: s.trunk.name, ...e.state, seq: e.seq };
    } else if (e.kind === 'adopt') {
      // Like a merge, the adopted commit becomes the trunk state; open slots are not touched.
      s.trunk = { name: s.trunk.name, ...e.state, seq: e.seq };
      if (h.invRed) for (const [o, red] of h.invRed) if (e.state.invKeys[o.slice(4)] !== red.key) h.invRed.delete(o);
      s.adoptions.push({ seq: e.seq, by: e.by, ...(e.channel ? { channel: e.channel } : {}), prior: e.prior, commit: e.commit, commits: e.commits, changed: [...e.changed], note: e.note, ...(role(e.by) === 'parent' && h.allowSeq !== undefined ? { allowance: h.allowSeq } : {}) });
    } else if (e.kind === 'escape') s.escapes.push({ seq: e.seq, by: e.by, node: e.node, merge: e.merge, class: e.class, note: e.note, evidence: e.evidence });
    else if (e.kind === 'decoy-commit') s.decoyCommits.push({ seq: e.seq, digest: e.digest, by: e.by });
    else if (e.kind === 'decoy-reveal') {
      const c = s.decoyCommits.find(c => c.digest === decoyDigest(e) && c.revealed === undefined)!;
      c.revealed = e.seq;
      for (const x of e.decoys) {
        // A node listed in several reveals counts once: the earliest commitment wins.
        const at = s.decoys.findIndex(d => d.node === x.node);
        if (at >= 0 && s.decoys[at]!.commit < c.seq) continue;
        const v: DecoyView = { node: x.node, defect: x.defect, commit: c.seq, reveal: e.seq, outcome: 'pending' };
        for (const prior of h.entries) settleDecoy(v, prior, h.mergeCatches);
        if (at >= 0) s.decoys[at] = v; else s.decoys.push(v);
      }
    } else if (e.kind === 'launch' || e.kind === 'send') {
      const n = s.nodes[e.node]!;
      let runs = n.runs.find(r => r.attempt === e.attempt);
      if (!runs) { runs = { attempt: e.attempt, launches: [], sends: [] }; n.runs.push(runs); n.runs.sort((a, b) => a.attempt - b.attempt); }
      if (e.kind === 'launch') runs.launches.push(e); else runs.sends.push(e);
    } else if (e.kind === 'halt') s.nodes[e.node]!.halt = e;
    for (const n of Object.values(s.nodes)) if (n.halt && clearsHalt(e, n.id)) n.halt = undefined;
    for (const v of s.decoys) settleDecoy(v, e, h.mergeCatches);
    record(h, e); s.seq = e.seq; s.head = e.hash;
    refresh(s, touched(e));
  }
}

// ---------- G1 (0.12): copies, packed states and equivalence ----------
/** A state and its replay metadata as plain structured-cloneable data: plans are named by sha (`plans`), never held. */
export interface PackedState { state: State; history: Omit<History, 'plans' | 'planObjs'>; plans: string[] }
/**
 * G1: `s` with its replay metadata as one structured-cloneable value (no functions, no plan objects). Not a copy: clone
 * or serialize it (structuredClone, v8.serialize) in one call, which keeps the sharing between state and entries.
 */
export function packState(s: State): PackedState {
  const { plans: _plans, planObjs, ...rest } = context(s);
  return { state: { ...s, plan: s.planSha ? null as unknown as Plan : s.plan }, history: rest, plans: [...planObjs.keys()] };
}
/**
 * G1: the state of a packed copy (consumed: `p` must be a fresh clone or deserialization). The plan of each sha is
 * `planOf(sha)`; undefined (the default) resolves it as a replay does, `own(plans(sha))`, on first use (the current plan
 * at once), so plans no query needs are never read. `plans` also resolves the plans of entries folded later.
 */
export function unpackState(p: PackedState, plans: PlanLookup, planOf: (sha: string) => Plan | undefined = () => undefined): State {
  const planObjs = new Map(p.plans.map(sha => [sha, planOf(sha)] as const)), s = p.state;
  Object.setPrototypeOf(s.nodes, null);
  const h: History = { ...p.history, plans, planObjs };
  if (s.planSha) {
    const law = h.entries.findLast(e => e.kind === 'genesis' || e.kind === 'plan')! as import('./types.ts').PlanEntry | import('./types.ts').GenesisEntry;
    s.plan = recordedPlan(h,law);
  }
  Object.defineProperty(s, history, { value: h });
  return s;
}
/** G1: a deep copy of `s` with its replay metadata (one structured clone); deep-frozen plans stay shared. */
export function copyState(s: State, plans?: PlanLookup): State {
  const h = context(s);
  return unpackState(structuredClone(packState(s)), plans ?? h.plans, sha => { const p = h.planObjs.get(sha); return p && own(p); });
}
/** G1: the replay metadata of `s` without its plan lookup function, every plan resolved (for equivalence checks). */
export function replayMeta(s: State): Omit<History, 'plans'> {
  const h = context(s);
  for (const [sha, p] of h.planObjs) if (!p) lawPlan(h, sha);
  const { plans: _plans, ...rest } = h; return rest;
}
/** G1.1: whether two states are equal as replays: the states and their replay metadata deep-strict-equal. */
export function sameReplay(a: State, b: State): boolean { return isDeepStrictEqual(a, b) && isDeepStrictEqual(replayMeta(a), replayMeta(b)); }

/**
 * Whether a plan change from `prev` to `next` invalidates an open candidate of node `id`: its node spec (without `type`
 * and `drive`), or the plan's setup, exec or closure changed.
 */
export function invalidates(prev: Plan, next: Plan, id: string): boolean {
  return canonical(writesKeySyntax(prev,prev.nodes.find(x => x.id === id)?.writes ?? [])) !== canonical(writesKeySyntax(next,next.nodes.find(x => x.id === id)?.writes ?? [])) || canonical(withoutType(prev.nodes.find(x => x.id === id))) !== canonical(withoutType(next.nodes.find(x => x.id === id))) || prev.setup !== next.setup || execChanged(prev, next) || canonical(prev.closure) !== canonical(next.closure) || canonical(prev.closure_neutral) !== canonical(next.closure_neutral);
}
/** N1: the node spec fields whose change still lets owed carry a candidate (its facts are recomputed). */
export const CARRY_FIELDS: readonly string[] = ['checks', 'writes', 'type', 'drive', 'later'];
/**
 * N1: whether an open candidate of node `id`, invalidated by the change from `prev` to `next`, is carried: the node
 * exists in both plans and its spec differs only in `CARRY_FIELDS` (plan-wide setup, exec and closure never prevent it).
 */
export function carryable(prev: Plan, next: Plan, id: string): boolean {
  const a = prev.nodes.find(x => x.id === id), b = next.nodes.find(x => x.id === id);
  const rest = (n: NodeSpec): Record<string, unknown> => Object.fromEntries(Object.entries(n).filter(([k]) => !CARRY_FIELDS.includes(k)));
  return !!a && !!b && canonical(rest(a)) === canonical(rest(b));
}
/**
 * N1.4: what a plan change from `prev` to `next` changed for node `id`: the node spec fields that differ (not `type` and
 * `drive`, which never invalidate a candidate), then `setup`, `exec` and `closure` when the plan-wide ones differ.
 */
export function specChanges(prev: Plan, next: Plan, id: string): string[] {
  const a = (prev.nodes.find(x => x.id === id) ?? {}) as Record<string, unknown>, b = (next.nodes.find(x => x.id === id) ?? {}) as Record<string, unknown>;
  const fields = [...new Set([...Object.keys(a), ...Object.keys(b)])].filter(k => k !== 'type' && k !== 'drive' && k !== 'later' && canonical(a[k]) !== canonical(b[k]));
  return [...fields, ...(prev.setup !== next.setup ? ['setup'] : []), ...(execChanged(prev, next) ? ['exec'] : []), ...(canonical(prev.closure) !== canonical(next.closure) ? ['closure'] : []), ...(canonical(prev.closure_neutral) !== canonical(next.closure_neutral) ? ['closure_neutral'] : [])];
}
/**
 * L2: the definition of check `id` of node `node` in `plan`: the canonical CheckSpec with all its fields, plus
 * `plan.setup` and `execKey(plan)` (not title, brief, closure or other nodes). Undefined when the check is absent.
 */
export function checkDefinition(plan: Plan, node: string, id: string): string | undefined {
  const c = plan.nodes.find(x => x.id === node)?.checks.find(x => x.id === id);
  return c ? canonical({ check: c, setup: plan.setup, exec: execKey(plan) }) : undefined;
}
/** The check id of an execution obligation `check:<id>`, `red:<id>` or `strength:<id>`; undefined for others. */
export function checkOf(obligation: string): string | undefined { return /^(?:check|red|strength):(.+)$/.exec(obligation)?.[1]; }
/**
 * L2: a plan entry `seq` replacing the plan with `next` supersedes every active or flaky execution block whose check
 * definition differs between the plan of its failing observation and `next` (a removed check differs too).
 */
function supersede(s: State, h: History, seq: number, next: Plan): void {
  for (const n of Object.values(s.nodes)) for (const b of n.blocks) {
    const id = checkOf(b.obligation), old = obsPlan(h, b.seq);
    if (b.kind !== 'exec' || !active(b) || id === undefined || !old) continue;
    if (checkDefinition(old, n.id, id) !== checkDefinition(next, n.id, id)) { h.shadow.set(b.seq, b.state); b.state = 'superseded'; b.supersededBy = seq; }
  }
}

/** Current binding risk, including L2's shadow state during historical replay. */
export function activeRisk(s: State, node: string, obligation: string, seq: number): boolean {
  return !!s.nodes[node]?.blocks.some(b => b.seq === seq && b.obligation === obligation && underlyingActive(context(s), b));
}
/** A merge-result failure on a supplied, Git-verified merge key; never a diagnostic probe. */
export function mergeRisk(s: State, node: string, obligation: string, seq: number, key: string): ObsEntry | undefined {
  const e = listed(context(s).bySeq, seq).find((e): e is ObsEntry => e.kind === 'obs');
  const old = e && obsPlan(context(s), e.seq), id = checkOf(obligation);
  return e?.by === 'executor:owed' && e.probe === undefined && e.verdict === 'fail' && e.subject === node && e.merging === node && e.obligation === obligation && e.key === key && obligation.startsWith('check:') && id && old && checkDefinition(old, node, id) === checkDefinition(s.plan, node, id) && canonical(old.closure) === canonical(s.plan.closure) ? e : undefined;
}

/** TR2/3: match valid failure evidence by check key; its base may predate an unrelated trunk move. */
export function trunkRedOf(s: State, seq: number, key?: string): { merge: ObsEntry; probe: ObsEntry } | undefined {
  const e = listed(context(s).bySeq, seq).find((x): x is ObsEntry => x.kind === 'obs');
  if (!e || e.probe !== undefined || e.verdict !== 'fail' || e.merging !== e.subject || !e.obligation.startsWith('check:') || (key !== undefined && e.key !== key)) return undefined;
  const id = e.obligation.slice(6), old = obsPlan(context(s), e.seq);
  const sameDefinition = (p: Plan | undefined): boolean => !!p && checkDefinition(p, e.subject, id) === checkDefinition(s.plan, e.subject, id) && canonical(p.closure) === canonical(s.plan.closure);
  if (!sameDefinition(old)) return undefined;
  const probes = observationsForProbe(s, e.subject, e.obligation).filter(p => p.commit === s.trunk.commit && sameDefinition(obsPlan(context(s), p.seq)));
  const probe = probes.findLast(p => p.verdict !== 'error');
  const names = e.failed ?? [], trunkNames = probe?.failed ?? [];
  if (!probe || probe.verdict !== 'fail' || (names.length ? !names.every(n => trunkNames.includes(n)) : trunkNames.length !== 0)) return undefined;
  // AT1: a merge tree that already breaks an invariant trunk passes explains the node check failure, not trunk.
  if (mergeTreeBreaks(s, e.subject, e.commit).length) return undefined;
  return { merge: e, probe };
}
/**
 * AT1: invariants that fail on merge tree `commit` of `node` while their current trunk key passes ("passes on trunk,
 * fails on the merge tree"). Derived from executor observations only.
 */
export function mergeTreeBreaks(s: State, node: string, commit: string): { obligation: string; fail: ObsEntry }[] {
  const out: { obligation: string; fail: ObsEntry }[] = [];
  for (const e of context(s).entries) {
    if (e.kind !== 'obs' || e.by !== 'executor:owed' || e.subject !== 'trunk' || e.merging !== node || e.commit !== commit || e.verdict !== 'fail' || !e.obligation.startsWith('inv:') || out.some(x => x.obligation === e.obligation)) continue;
    const trunkKey = s.trunk.invKeys[e.obligation.slice(4)];
    if (!trunkKey || trunkKey === e.key) continue;
    const trunk = counted(s, 'trunk', e.obligation, trunkKey);
    if (trunk.some(x => x.verdict === 'pass') && !trunk.some(x => x.verdict === 'fail')) out.push({ obligation: e.obligation, fail: e });
  }
  return out;
}
/**
 * AT3: a block whose observation was recorded for an earlier candidate commit of the node (a later submit replaced it).
 * The trunk-red guard and parking ignore it so the new candidate is attested first.
 */
export function priorCandidateBlock(s: State, node: string, b: Pick<Block, 'seq'>): boolean {
  const c = s.nodes[node]?.candidate;
  if (!c || b.seq > c.seq) return false;
  const before = context(s).entries.findLast(e => e.kind === 'submit' && e.node === node && e.seq < b.seq);
  return before?.kind === 'submit' && before.facts.commit !== c.commit;
}
/** TP1: parked is derived only from nonempty, entirely trunk-red binding blocks (active or flaky). */
export function trunkParked(s: State, node: string): { merge: ObsEntry; probe: ObsEntry }[] {
  const n = s.nodes[node];
  if (!n?.slot?.open || !n.candidate || n.merged || n.phase === 'removed') return [];
  const blocks = n.blocks.filter(b => binding(b, nodeSpec(s, node)));
  const reds = blocks.map(b => priorCandidateBlock(s, node, b) ? undefined : trunkRedOf(s, b.seq, b.key));
  return blocks.length && reds.every(r => r !== undefined) ? reds as { merge: ObsEntry; probe: ObsEntry }[] : [];
}
/** TP2: one repository notice per current trunk/check/failed-name state. No ledger fields. */
export function trunkParkNotices(s: State): { once: string; obligation: string; nodes: string[]; text: string }[] {
  const groups = new Map<string, { obligation: string; names: string[]; nodes: Set<string> }>();
  for (const node of Object.keys(s.nodes).sort()) for (const r of trunkParked(s, node)) {
    const names = [...new Set(r.merge.failed ?? [])].sort();
    const once = `trunk-red\u0000${s.trunk.commit}\u0000${r.merge.obligation}\u0000${names.join('\u0000')}`;
    const group = groups.get(once) ?? { obligation: r.merge.obligation, names, nodes: new Set<string>() };
    group.nodes.add(node); groups.set(once, group);
  }
  return [...groups].map(([once, g]) => {
    const nodes = [...g.nodes], names = g.names.slice(0, 3).join(', ') || 'unknown failed tests';
    return { once, obligation: g.obligation, nodes, text: `trunk-red: ${g.obligation} fails on trunk ${s.trunk.commit.slice(0, 12)} without any candidate (${names}${g.names.length > 3 ? `, +${g.names.length - 3}` : ''}); waiting: ${nodes.join(', ')}. Fix trunk with a fixing node or a commit adopted with owed adopt${s.plan.sweep ? ', or run owed sweep to find the culprit' : ''}; or the owner waives ${g.obligation} on the waiting nodes.` };
  }).sort((a, b) => a.once.localeCompare(b.once));
}
/** Probe lookup is separate from counted observations, even when their keys coincide. */
function observationsForProbe(s: State, subject: string, obligation: string): ObsEntry[] {
  return context(s).entries.filter((e): e is ObsEntry => e.kind === 'obs' && e.by === 'executor:owed' && e.probe === 'trunk' && e.subject === subject && e.obligation === obligation);
}
export function trunkRedText(r: { merge: ObsEntry; probe: ObsEntry }): string {
  return `trunk-red: ${r.merge.obligation} fails on trunk ${r.probe.commit.slice(0,12)} without ${r.merge.subject} (${r.merge.failed?.join(', ') || 'unknown failed tests'})`;
}

// ---------- FS (0.23): shared failures are a repository condition ----------
/** FS: the AT4 scan window. */
const SHARED_WINDOW = 5000;
/** FS: per failed name of O, the trunk observation T that also failed it; `nameOnly` when no signature was recorded on either side (ruling: FS1-FS5 only). */
export interface SharedFailure { names: string[]; trunk: ObsEntry[]; nameOnly: boolean }
/**
 * FS: T was measured without `node`'s candidate: a trunk refresh/genesis/adopt observation (no `merging`), a trunk probe
 * of the same node check, or (ruling on 59f36934) another node's non-batch merge tree measured while `node` was unmerged.
 */
function measuredWithout(s: State, o: ObsEntry, t: ObsEntry, node: string | undefined): boolean {
  if (t.batch !== undefined || t.attribution) return false;
  if (!o.obligation.startsWith('inv:')) return t.probe === 'trunk' && t.subject === o.subject;
  if (t.subject !== 'trunk' || t.probe !== undefined) return false;
  if (t.merging === undefined) return true;
  const merged = node === undefined ? undefined : s.nodes[node]?.merged;
  return node !== undefined && t.merging !== node && !(merged && merged.seq < t.seq);
}
/**
 * FS: failing observation `o` is shared when it is a complete, test-only failure and every failed name also failed
 * (test-only) in an earlier observation measured without `node`'s candidate within the AT4 window, with the same
 * recorded signature. Name-only matches (no signature on either side) count unless `strict` (FS6). Diagnostic only.
 */
export function sharedFailure(s: State, o: ObsEntry, node: string | undefined = o.merging, strict = false): SharedFailure | undefined {
  if (o.verdict !== 'fail' || !/^(inv|check):/.test(o.obligation) || !testOnlyFailure(o) || !failedNamesComplete(o)) return undefined;
  const entries = context(s).entries, trunk: ObsEntry[] = [];
  let nameOnly = false;
  for (const name of o.failed!) {
    const sig = o.signatures?.[name];
    if (strict && sig === undefined) return undefined;
    let found: ObsEntry | undefined;
    for (let i = entries.length - 1; i >= 0 && entries[i]!.seq >= o.seq - SHARED_WINDOW; i--) {
      const e = entries[i]!;
      if (e.seq >= o.seq || e.kind !== 'obs' || e.by !== 'executor:owed' || e.obligation !== o.obligation || e.verdict !== 'fail') continue;
      if (e.failed?.includes(name) && e.signatures?.[name] === sig && testOnlyFailure(e) && measuredWithout(s, o, e, node)) { found = e; break; }
    }
    if (!found) return undefined;
    if (sig === undefined) nameOnly = true;
    trunk.push(found);
  }
  return { names: [...o.failed!], trunk, nameOnly };
}
/** FS1/FS4: `a, b, c, +N` and the name-only suffix. */
export function sharedNames(names: readonly string[]): string { return `${names.slice(0, 3).join(', ')}${names.length > 3 ? `, +${names.length - 3}` : ''}`; }
export const NAME_ONLY = ' (same name; no error signature recorded)';
/** FS3: one parked refusal reason of a node: a shared merge-key failure or a trunk-key (trunk-caused) refusal. */
export interface SharedPark { kind: 'shared' | 'trunk-red'; obligation: string; key: string; names: string[]; /** shared: the trunk obs T; trunk-red: the failing trunk-key obs */ trunk?: number; /** trunk-red: the conflicting pass */ pass?: number; nameOnly: boolean; fix?: string; candidates: { id: string; phase: string; accepted: boolean }[] }
/** FS5: the FH fix candidates of failed `names`: unmerged nodes other than `node` whose title, brief, check run or tests contain a name (>= 6 chars) verbatim. */
export function fixCandidates(s: State, node: string, names: readonly string[]): { id: string; phase: string; accepted: boolean }[] {
  const out: { id: string; phase: string; accepted: boolean }[] = [];
  for (const spec of s.plan.nodes) {
    const n = s.nodes[spec.id];
    if (spec.id === node || !n || n.merged || !(n.slot?.open || n.accepted || n.phase === 'ready')) continue;
    const text = [spec.title, spec.brief, ...spec.checks.flatMap(c => [c.run, ...(c.tests ?? [])])];
    if (names.some(name => name.length >= 6 && text.some(t => t?.includes(name)))) out.push({ id: spec.id, phase: n.phase, accepted: n.accepted && !!n.slot?.open && !halted(s, spec.id) });
  }
  return out;
}
/** FS3: merge-tree invariant observations of `node`'s current candidate under the current plan, latest per obligation. */
function latestMergeTreeObs(s: State, node: string): Map<string, ObsEntry> {
  const n = s.nodes[node]!, since = Math.max(n.candidate!.seq, knownRedPlanSeq(s), n.slot!.rebase?.seq ?? -1), out = new Map<string, ObsEntry>();
  for (const e of context(s).entries) if (e.seq > since && e.kind === 'obs' && e.by === 'executor:owed' && e.subject === 'trunk' && e.merging === node && e.batch === undefined && e.obligation.startsWith('inv:')) out.set(e.obligation, e);
  return out;
}
/**
 * FS3 (derived, no entry): the reasons a merge of `node` is refused when ALL of them are shared failures (or same-key
 * pass/fail conflicts of shared failures) on its merge key, or trunk-caused (its merge key is the trunk key and that
 * trunk item refuses). Empty when anything else refuses, nothing was measured, or FS3's bound of 3 merge keys is reached.
 */
/**
 * FS3(b) (ruling #2458): the node's merge key of invariant `id` equals the trunk key: the candidate changed no path
 * under the invariant's reads or the plan closure (the key hashes the spec, exec, closure and reads digests; the merge
 * tree takes trunk's version of every file the candidate did not change).
 */
export function trunkKeyUnchanged(s: State, node: string, id: string): boolean {
  const n = s.nodes[node], inv = s.plan.invariants.find(i => i.id === id);
  if (!n?.candidate || !inv) return false;
  return !n.candidate.changed.some(p => matchesAny(p, inv.reads ?? []) || matchesAny(p, s.plan.closure));
}
/** FS3(b): the trunk-red park of invariant `inv` for a node whose merge key is the trunk key, when that key has an automatic owner conflict. */
function trunkRedPark(s: State, node: string, inv: CheckSpec): SharedPark | undefined {
  const o = `inv:${inv.id}`, key = s.trunk.invKeys[inv.id];
  if (!key || !automaticInvariantConflict(s, o, key) || item(s, 'trunk', o, key, node).mark === '\u23f8') return undefined;
  const obs = counted(s, 'trunk', o, key), fail = obs.findLast(x => x.verdict === 'fail'), pass = obs.findLast(x => x.verdict === 'pass');
  return { kind: 'trunk-red', obligation: o, key, names: fail?.failed ?? [], ...(fail ? { trunk: fail.seq } : {}), ...(pass ? { pass: pass.seq } : {}), nameOnly: false, candidates: [] };
}
export function sharedParked(s: State, node: string): SharedPark[] {
  const n = s.nodes[node];
  if (!n?.slot?.open || !n.candidate || !n.accepted || n.merged || n.phase === 'removed') return [];
  const out: SharedPark[] = [], measured = latestMergeTreeObs(s, node);
  for (const inv of s.plan.invariants) {
    const o = `inv:${inv.id}`;
    // Ruling #2458 (F2): a trunk-red park needs proof that the merge key is the trunk key, never a missing observation.
    if (trunkKeyUnchanged(s, node, inv.id)) { const p = trunkRedPark(s, node, inv); if (p) out.push(p); continue; }
    const e = measured.get(o);
    if (!e) continue;
    const key = e.key, trunkKey = s.trunk.invKeys[inv.id], v = item(s, 'trunk', o, key, node);
    if (key === trunkKey || v.status !== 'D' || v.mark === '⏸') continue;
    if (s.deferred.some(d => d.node === node && d.id === inv.id && d.key === key && d.seq > n.slot!.dispatchSeq)) continue;
    const conflict = automaticInvariantConflict(s, o, key);
    if (!conflict && v.mark !== '⊤' && invariantTrunkComparison(s, node, inv, key, e.commit).inherited) continue;
    const fail = counted(s, 'trunk', o, key).findLast(x => x.verdict === 'fail');
    const shared = fail && sharedFailure(s, fail, node);
    if (!shared) return [];
    out.push({ kind: 'shared', obligation: o, key, names: shared.names, trunk: shared.trunk.at(-1)!.seq, nameOnly: shared.nameOnly, candidates: [] });
  }
  if (!out.length || sharedPersisted(s, node, out)) return [];
  for (const p of out) {
    p.candidates = fixCandidates(s, node, p.names);
    const fix = p.candidates.find(c => c.accepted);
    if (fix) p.fix = fix.id;
  }
  return out;
}
/** FS3 bound: shared failures of the same names on 3 distinct merge keys of the open attempt stop parking. */
export function sharedPersisted(s: State, node: string, parks: readonly Pick<SharedPark, 'kind' | 'obligation' | 'names'>[]): boolean {
  const n = s.nodes[node];
  if (!n?.slot) return false;
  return parks.some(p => {
    if (p.kind !== 'shared') return false;
    const want = [...p.names].sort().join('\0'), keys = new Set<string>();
    for (const e of context(s).entries) if (e.seq > n.slot!.dispatchSeq && e.kind === 'obs' && e.subject === 'trunk' && e.merging === node && e.batch === undefined && e.obligation === p.obligation && e.verdict === 'fail' && [...(e.failed ?? [])].sort().join('\0') === want && e.key !== s.trunk.invKeys[p.obligation.slice(4)]) keys.add(e.key);
    return keys.size >= 3;
  });
}
/** FS3: the bound's halt suffix when parking stopped on the third merge key, else undefined. */
export function sharedBoundText(s: State, node: string): string | undefined {
  const n = s.nodes[node];
  if (!n?.slot?.open || !n.candidate || !n.accepted) return undefined;
  const parks: Pick<SharedPark, 'kind' | 'obligation' | 'names'>[] = [];
  for (const [o, e] of latestMergeTreeObs(s, node)) {
    const fail = counted(s, 'trunk', o, e.key).findLast(x => x.verdict === 'fail');
    const shared = fail && sharedFailure(s, fail, node);
    if (shared) parks.push({ kind: 'shared', obligation: o, names: shared.names });
  }
  return sharedPersisted(s, node, parks) ? 'shared failure persisted on 3 merge keys' : undefined;
}
/**
 * FS6: the executor defer an `allow` rule with `defer` pre-authorizes for invariant `id` on merge key `key` of `node`:
 * the rule of the current plan covers node and invariant, the latest failure on the key is shared with matching
 * signatures (never name-only, errors, timeouts or new names) and the same key also has a pass. Undefined otherwise.
 */
export function allowanceDeferDraft(s: State, node: string, id: string | undefined, key: string | undefined): Extract<Draft, { kind: 'defer' }> | undefined {
  const n = s.nodes[node], allowance = allowanceSeq(s);
  if (!id || !key || !n?.slot?.open || !n.candidate || allowance === undefined || !s.plan.invariants.some(i => i.id === id)) return undefined;
  if (!rulesFor(s.plan, node).some(r => r.defer?.some(g => matchesGlob(id, g)))) return undefined;
  const obs = counted(s, 'trunk', `inv:${id}`, key), fail = obs.findLast(e => e.verdict === 'fail'), pass = obs.findLast(e => e.verdict === 'pass');
  const shared = fail && pass && sharedFailure(s, fail, node, true);
  if (!fail || !pass || !shared) return undefined;
  return { kind: 'defer', by: 'executor:owed', node, items: [{ id, key }], reason: `shared intermittent ${sharedNames(shared.names)}: failed on trunk #${shared.trunk.at(-1)!.seq}; pass #${pass.seq} and fail #${fail.seq} on this merge key`, allowance };
}
/** FS6 replay: an executor defer must equal the derived allowance defer exactly. */
function executorDeferErrors(s: State, d: Extract<Draft, { kind: 'defer' }>): string[] {
  const items = Array.isArray(d.items) ? d.items : [], expected = items.length === 1 ? allowanceDeferDraft(s, d.node, items[0]?.id, items[0]?.key) : undefined;
  const fields = (x: Extract<Draft, { kind: 'defer' }>) => canonical({ by: x.by, channel: x.channel ?? null, node: x.node, items: x.items, reason: x.reason, allowance: x.allowance ?? null });
  return expected && fields(d) === fields(expected) ? [] : ['executor defer requires an allow defer rule of the current plan covering the node and invariant, a shared failure with matching signatures, a pass and a fail on that merge key, and the derived reason and allowance'];
}
/** FS6: how a defer reads in item details. */
export function deferLabel(d: { allowance?: number }): string { return d.allowance !== undefined ? `deferred by owed under allowance (plan #${d.allowance})` : 'deferred'; }
/** FS3: the status phase of a parked node. */
export function sharedPhase(s: State, parks: readonly SharedPark[]): string {
  const p = parks[0]!;
  if (p.fix) return `waiting: fix ${p.fix}`;
  return p.kind === 'shared' ? `waiting: shared failure (${p.obligation} ${sharedNames(p.names)})` : `waiting: trunk red (${p.obligation} on trunk ${s.trunk.commit.slice(0, 12)})`;
}
/** FS3: the driver's level-trigger: the merge is retried when the trunk commit, a trunk invariant item (or this node's defers of it), the plan or the candidate changes. */
export function sharedParkKey(s: State, node: string): string {
  const items = s.invariants.map(i => `${i.obligation}:${i.key}:${i.mark}:${i.evidence.join(',')}`).join('|');
  const defers = s.deferred.filter(d => d.node === node).map(d => d.seq).join(',');
  return `shared-park\u0000${node}\u0000${s.trunk.commit}\u0000${s.nodes[node]?.candidate?.seq ?? -1}\u0000${s.planSha}\u0000${knownRedPlanSeq(s)}\u0000${items}\u0000${defers}`;
}
/** FS4: one repository notice per (obligation, sorted names, trunk commit). No ledger field. */
export function sharedParkNotices(s: State): { once: string; obligation: string; nodes: string[]; text: string }[] {
  const groups = new Map<string, { kind: SharedPark['kind']; obligation: string; names: string[]; nodes: Set<string>; nameOnly: boolean; candidates: Map<string, string>; fail?: number; pass?: number }>();
  for (const node of Object.keys(s.nodes).sort()) {
    if (halted(s, node)) continue;
    for (const p of sharedParked(s, node)) {
      const names = [...new Set(p.names)].sort();
      // Ruling #2458 (F1): a trunk-red park is a repository condition too, with its own once-key.
      const once = `${p.kind === 'shared' ? 'shared' : 'trunk'}\u0000${p.obligation}\u0000${names.join('\u0000')}\u0000${s.trunk.commit}`;
      const g = groups.get(once) ?? { kind: p.kind, obligation: p.obligation, names, nodes: new Set<string>(), nameOnly: false, candidates: new Map<string, string>(), ...(p.kind === 'trunk-red' ? { fail: p.trunk, pass: p.pass } : {}) };
      g.nodes.add(node); g.nameOnly ||= p.nameOnly;
      for (const c of p.candidates) g.candidates.set(c.id, c.phase);
      groups.set(once, g);
    }
  }
  return [...groups].map(([once, g]) => {
    const list = [...g.nodes];
    const fixes = [...g.candidates].map(([id, phase]) => `${id} (${phase})`);
    const tail = `waiting: ${list.join(', ')}. owed retries after trunk moves. To merge now: owed decide ${list.join(',')} --defer ${g.obligation} (or an allow defer rule); to fix: a node whose brief names the test.${fixes.length ? ` Fix candidate: ${fixes.join(', ')}.` : ''}`;
    const head = g.kind === 'shared'
      ? `shared failure: ${g.obligation} ${sharedNames(g.names)}${g.nameOnly ? NAME_ONLY : ''} fails without any candidate; `
      : `trunk red: ${g.obligation} ${g.names.length ? `${sharedNames(g.names)} ` : ''}fails on trunk ${s.trunk.commit.slice(0, 12)} (${g.fail !== undefined ? `#${g.fail}` : 'no named failure'}${g.pass !== undefined ? `, pass #${g.pass}: owner conflict` : ''}); `;
    return { once, obligation: g.obligation, nodes: list, text: head + tail };
  }).sort((a, b) => a.once.localeCompare(b.once));
}

/** ER1: the latest submitted candidate of the same open attempt, even after its rebase invalidated it. */
export function previousSubmit(s: State, node: string): Extract<Entry, { kind: 'submit' }> | undefined {
  const slot = s.nodes[node]?.slot;
  return slot?.open ? entriesOf(s).findLast((e): e is Extract<Entry, { kind: 'submit' }> => e.kind === 'submit' && e.node === node && e.attempt === slot.attempt) : undefined;
}
/** Original OK receipts plus the current candidate's explicitly inherited receipts; never copy checks or approvals. */
function effectiveReviews(s: State, node: string, obligation: string, key: string, facts?: CandidateFacts): ReviewEntry[] {
  return listed(context(s).reviews, node).filter((e): e is ReviewEntry => e.kind === 'review' && e.obligation === obligation && e.verdict === 'ok' && (e.key === key || !!facts?.carry?.reviews.includes(e.seq)));
}
/** A plan carry keeps ER receipts at the same commit without inventing a second clean-rebase assertion. */
function submittedFacts(s: State, e: Extract<Entry, { kind: 'submit' }>): CandidateFacts {
  if (e.facts.carry || e.carry === undefined) return e.facts;
  const prior = entriesOf(s).find(x => x.seq === e.carry);
  const inherited = prior?.kind === 'submit' ? submittedFacts(s, prior).carry : undefined;
  return inherited ? { ...e.facts, carry: inherited } : e.facts;
}
/** Eligible review receipts on C: all required judgments must be OK (not waived), at today's count and rank. */
export function reviewCarrySource(s: State, node: string, next?: CandidateFacts): { previous: Extract<Entry, { kind: 'submit' }>; reviews: number[] } | undefined {
  const previous = previousSubmit(s, node), spec = nodeSpec(s, node);
  if (!previous || !spec) return undefined;
  const facts = submittedFacts(s, previous), derived = reviewRequirement(s.plan, spec, facts.changed), obligations = required(s.plan, spec, facts).filter(o => o === 'review' || o === 'closure-review');
  if (!obligations.length || next && required(s.plan, spec, next).some(o => (o === 'review' || o === 'closure-review') && !obligations.includes(o))) return undefined;
  const receipts: number[] = [];
  for (const obligation of obligations) {
    if (s.nodes[node]!.blocks.some(b => b.obligation === obligation && active(b))) return undefined;
    const rank = obligation === 'closure-review' ? 2 : derived.min_rank, count = obligation === 'closure-review' ? 1 : derived.count;
    const reviews = effectiveReviews(s, node, obligation, facts.keys[obligation] ?? '', facts).filter(e => e.rank >= rank && !isWriter(s.nodes[node], e.by));
    if (new Set(reviews.map(e => e.by)).size < count) return undefined;
    receipts.push(...reviews.map(e => e.seq));
  }
  return { previous: { ...previous, facts }, reviews: [...new Set(receipts)].sort((a,b) => a-b) };
}
function reviewCarryErrors(s: State, d: Extract<Draft, { kind: 'submit' }>): string[] {
  const carry = d.facts.carry;
  if (carry === undefined) return [];
  if (!carry || typeof carry !== 'object' || Array.isArray(carry) || Object.keys(carry).some(k => !['from','reviews'].includes(k)) || typeof carry.from !== 'string' || !/^[0-9a-f]{40,64}$/.test(carry.from) || !Array.isArray(carry.reviews) || !carry.reviews.length || carry.reviews.some(seq => !Number.isSafeInteger(seq) || seq < 0) || new Set(carry.reviews).size !== carry.reviews.length) return ['submit facts.carry must be {from: commit, reviews: distinct OK review seqs}'];
  const source = reviewCarrySource(s, d.node, d.facts);
  if (!source || carry.from !== source.previous.facts.commit) return ['review carry.from must name the previous candidate with all review obligations satisfied'];
  if (carry.reviews.some(seq => !source.reviews.includes(seq))) return ['review carry.reviews must name OK receipts on the previous candidate keys'];
  const spec = nodeSpec(s, d.node)!, derived = reviewRequirement(s.plan, spec, source.previous.facts.changed);
  for (const obligation of required(s.plan, spec, source.previous.facts).filter(o => o === 'review' || o === 'closure-review')) {
    const reviews = entriesOf(s).filter((e): e is ReviewEntry => e.kind === 'review' && carry.reviews.includes(e.seq) && e.obligation === obligation);
    if (new Set(reviews.map(e => e.by)).size < (obligation === 'closure-review' ? 1 : derived.count)) return ['review carry.reviews must satisfy every previous review count and rank'];
  }
  return [];
}
function executorRebaseErrors(s: State, d: Extract<Draft, { kind: 'submit' }>): string[] {
  const rebase = entriesOf(s).at(-1);
  if (d.carry !== undefined) return ['executor rebase submit never has plan carry'];
  if (rebase?.kind !== 'rebase' || rebase.node !== d.node || rebase.attempt !== d.attempt || rebase.base !== d.facts.base || d.facts.rebased !== true) return ['executor rebase submit must immediately follow a rebase of the same open attempt and descend from its base (rebased: true)'];
  return [];
}

// ---------- driver (SPEC §12) ----------
const DRIVE_KINDS: readonly string[] = ['launch', 'send', 'halt'];
export const DRIVER = 'parent:drive';
/** The entry kinds the driver records as DRIVER (drive-run.ts); validateDraft refuses any other kind by it (G2.3). */
const DRIVER_WRITES: readonly string[] = ['dispatch', 'launch', 'send', 'halt', 'rebase', 'abandon'];
/**
 * A halt is cleared by a later entry on its node by a principal other than the driver: a human, parent,
 * writer or reviewer action (submit, review, rebase, abandon, waive, defer, escape, a ruling naming the
 * node, dispatch), never by driver entries (launch/send/halt) or executor observations and merges (which
 * the driver itself causes). A dispatch opens a new attempt and clears it whoever records it.
 */
function clearsHalt(e: Entry, node: string): boolean {
  if (e.kind === 'dispatch' && e.node === node) return true;
  // DC: only the explicit resume clears a decision's halt (--no-resume preserves it).
  if (e.decision !== undefined && e.kind !== 'resume') return false;
  if (DRIVE_KINDS.includes(e.kind) || e.by === DRIVER || role(e.by) === 'executor') return false;
  return ('node' in e && e.node === node) || (e.kind === 'rule' && !e.prospective && e.nodes !== '*' && e.nodes.includes(node));
}
/** Every replayed entry of the state, in ledger order (pure; the state's replay metadata). */
export function entriesOf(s: State): readonly Entry[] { return context(s).entries; }
/** Executor observations of one item (subject, obligation, key), in ledger order, including `error` ones. */
export function observationsOf(s: State, subject: string, obligation: string, key: string): ObsEntry[] { return observations(s, subject, obligation, key).filter(e => e.probe === undefined); }
/** The plan in force just before entry `seq` (the latest genesis/plan entry below it), e.g. the plan a dispatch packet was built from. */
export function planAt(s: State, seq: number): Plan {
  const law = context(s).entries.findLast(e => e.seq < seq && (e.kind === 'genesis' || e.kind === 'plan'));
  if (!law || (law.kind !== 'genesis' && law.kind !== 'plan')) throw new OwedError(`No plan is in force before #${seq}`, 'internal');
  return recordedPlan(context(s),law);
}
/**
 * The ruling that resolves a needs-parent review block (D18 as amended): the first ruling naming the block's node
 * (`nodes` includes it; a `*` ruling is general guidance and does not) recorded after the block. Undefined when the
 * block does not need a parent ruling or none exists yet.
 */
export function parentRuling(s: State, b: Block): Rule | undefined {
  return b.needs === 'parent' ? applicableRules(s, b.node).find(r => r.seq > b.seq && r.nodes !== '*' && r.nodes.includes(b.node)) : undefined;
}
/** An active review block that needs a parent ruling and has none yet (D18). */
export function awaitingRuling(s: State, b: Block): boolean { return b.needs === 'parent' && b.state === 'active' && !parentRuling(s, b); }
/** The active driver halt of `node`'s current open attempt, if any. */
export function halted(s: State, node: string): HaltEntry | undefined {
  const n = s.nodes[node];
  return n?.halt && n.slot?.open && n.slot.attempt === n.halt.attempt ? n.halt : undefined;
}
/**
 * 0.8 (L1): the latest `resume` of `node`'s open attempt (recorded after its dispatch), if any. A later resume replaces
 * an earlier one; an abandon or a new dispatch ends it (the slot closes or the attempt changes).
 */
export function resumeOf(s: State, node: string): ResumeEntry | undefined {
  const slot = s.nodes[node]?.slot;
  if (!slot?.open) return undefined;
  return context(s).entries.findLast((e): e is ResumeEntry => e.kind === 'resume' && e.node === node && e.attempt === slot.attempt && e.seq > slot.dispatchSeq);
}
/**
 * 0.8 (L1.2): the node is waiting while the latest resume of its open attempt names `after` and that node is not
 * merged; the driver leaves it alone (except asking notices). Undefined otherwise.
 */
export function waitingFor(s: State, node: string): Waiting | undefined {
  const slot = s.nodes[node]?.slot, spec = nodeSpec(s, node);
  if (!slot?.open || !spec) return undefined;
  const r = resumeOf(s, node), deps = spec.deps.filter(d => !s.nodes[d]?.merged);
  const after = afterNodes(r?.after).filter(d => !s.nodes[d]?.merged);
  if (!deps.length && !after.length) return undefined;
  // Preserve the 0.8 single-after view shape for historical consumers.
  return { after: after.join(', '), resume: r?.seq ?? -1, ...(deps.length ? { deps } : {}) };
}
export interface Waiting { after: string; resume: number; deps?: string[] }
/** FL2: a single node stays a string; comma spelling is normalized at command/tool boundaries. */
export const afterNodes = (after: string | string[] | undefined): string[] => after === undefined ? [] : Array.isArray(after) ? after : [after];
/** DR1: unique not-merged transitive dependents; merged nodes are not counted. */
export function unmergedDependents(s: State, node: string): number {
  const found = new Set<string>();
  const visit = (id: string): void => {
    for (const spec of s.plan.nodes) if (spec.deps.includes(id) && !found.has(spec.id)) {
      found.add(spec.id); visit(spec.id);
    }
  };
  visit(node);
  return [...found].filter(id => !s.nodes[id]?.merged).length;
}
/** DR1: critical-path weight first, older continuous acceptance breaks ties. */
export function mergeQueue(s: State): string[] {
  const weight = new Map(s.plan.nodes.map(n => [n.id, unmergedDependents(s, n.id)]));
  return Object.values(s.nodes).filter(n => n.slot?.open && n.phase === 'accepted').sort((a, b) =>
    (weight.get(b.id) ?? 0) - (weight.get(a.id) ?? 0)
    || (a.acceptedSince ?? Number.MAX_SAFE_INTEGER) - (b.acceptedSince ?? Number.MAX_SAFE_INTEGER)
    || a.id.localeCompare(b.id)).map(n => n.id);
}
/**
 * MT1: a member a batch merge may take: an accepted open candidate (so an `approve: owner` is no longer pending), not
 * closure-touched, no owed remeasure.
 */
export function batchable(s: State, id: string): boolean {
  const n = s.nodes[id], spec = nodeSpec(s, id);
  return !!n?.slot?.open && !!n.candidate && n.accepted && !n.merged && !!spec && !n.candidate.closureTouched && !remeasureDue(s, id);
}
/** MT4: a batch of exactly these members failed on the current trunk (a fail observation tagged with them since trunk moved). */
export function batchFailed(s: State, members: string[]): boolean {
  const want = members.join('\0'), entries = context(s).entries;
  for (let i = entries.length - 1; i >= 0 && entries[i]!.seq > s.trunk.seq; i--) {
    const e = entries[i]!;
    if (e.kind === 'obs' && e.verdict === 'fail' && e.batch?.join('\0') === want) return true;
  }
  return false;
}
/**
 * MT1/MT6: the batch the merge queue plans with `drive.merge_batch` = `size`: from the queue head, in queue order, up to
 * `size` batchable members whose writes pairwise do not overlap. Empty when `size` < 2, the head is not batchable, fewer
 * than 2 qualify, or this set already failed on the current trunk (its members then merge one at a time).
 */
export function mergeBatchPlan(s: State, size: number, queue: string[] = mergeQueue(s).filter(id => !waitingFor(s,id) && !halted(s,id) && !trunkParked(s,id).length && !sharedParked(s,id).length && reportedOf(s,id) === undefined && !nodeSpec(s,id)?.later)): string[] {
  if (size < 2 || queue.length < 2 || !batchable(s, queue[0]!)) return [];
  const out: string[] = [];
  for (const id of queue) {
    if (out.length >= size) break;
    if (batchable(s, id) && !out.some(x => effectiveWritesOverlap(s, x, id))) out.push(id);
  }
  return out.length >= 2 && !batchFailed(s, out) ? out : [];
}
const isFacts = (x: unknown): x is StateFacts => !!x && typeof x === 'object' && typeof (x as StateFacts).commit === 'string' && typeof (x as StateFacts).tree === 'string' && !!(x as StateFacts).invKeys && typeof (x as StateFacts).invKeys === 'object';
/** MT3 / ruling #2110: the batch merge the ledger tail leaves incomplete (its last merge entry is not of the last member). */
export function openBatch(s: State): Extract<Entry, { kind: 'merge' }> | undefined {
  const e = context(s).entries.at(-1);
  return e?.kind === 'merge' && e.batch !== undefined && e.batch.members.at(-1) !== e.node ? e : undefined;
}
/** Ruling #2110: entries of one batch are consecutive merge entries in members order with an identical batch object. */
function batchOrderErrors(s: State, d: Draft): string[] {
  const open = openBatch(s), b = d.kind === 'merge' ? d.batch : undefined;
  if (open) {
    const next = open.batch!.members[open.batch!.members.indexOf(open.node) + 1]!;
    if (d.kind !== 'merge' || d.node !== next || canonical(b ?? null) !== canonical(open.batch)) return [`batch merge of ${open.batch!.members.join(', ')} is incomplete (#${open.seq} merged ${open.node}): only the merge of ${next} in the same batch may follow; restore refs/heads/${s.trunk.name} to ${open.batch!.final} (e.g. from the reflog: git update-ref refs/heads/${s.trunk.name} ${open.batch!.final}), then any owed write completes the batch; if trunk history no longer contains the batch commits, the ledger tail and trunk disagree and need manual repair`];
    return [];
  }
  if (d.kind === 'merge' && b && Array.isArray(b.members) && b.members[0] !== d.node) return [`batch merge entries must start with the first member ${String(b.members[0])}`];
  return [];
}
/** MT3: shape of a batch merge entry; the last member's commit and state are the batch's final ones. */
function batchMergeErrors(d: Extract<Draft, { kind: 'merge' }>): string[] {
  const b = d.batch;
  if (b === undefined) return [];
  if (!b || typeof b !== 'object' || typeof b.final !== 'string' || !isFacts(b.state) || b.state.commit !== b.final || !b.keys || typeof b.keys !== 'object' || !Array.isArray(b.members) || !b.members.every(m => !!b.keys[m] && typeof b.keys[m] === 'object') || b.members.length < 2 || b.members.some(m => typeof m !== 'string') || new Set(b.members).size !== b.members.length || !b.members.includes(d.node)) return ['merge batch must be {final, state, keys: {member: keys}, members} with the final state and at least 2 distinct members including the node'];
  const last = b.members.at(-1) === d.node;
  if (last && (d.commit !== b.final || canonical(d.state) !== canonical(b.state))) return ['the last batch member must merge the final batch commit and state'];
  if (!last && d.commit === b.final) return ['only the last batch member merges the final batch commit'];
  return [];
}
/** MX3: optional measurement metadata, never part of a key or verdict. */
function leaseWaitErrors(d: { kind: string; lease_wait_ms?: unknown }): string[] {
  const v = d.lease_wait_ms;
  return v === undefined || (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) ? [] : [`${d.kind} lease_wait_ms must be a non-negative integer of milliseconds`];
}
/** MT4: a batch observation names at least 2 distinct members (its node subject among them) and is never merging, a probe or an attribution rerun. */
function batchObsErrors(d: Extract<Draft, { kind: 'obs' }>): string[] {
  const b = d.batch;
  if (b === undefined) return [];
  if (!Array.isArray(b) || b.length < 2 || b.some(x => typeof x !== 'string') || new Set(b).size !== b.length) return ['obs batch must list at least 2 distinct members'];
  if (d.merging !== undefined || d.probe !== undefined || d.attribution) return ['a batch obs is never merging, a probe or an attribution rerun'];
  // remeason: a batch obs is never an automatic-remeasure trigger or receipt; single merges measure their own tree.
  if (d.remeasure_match !== undefined || d.auto_remeasure !== undefined) return ['a batch obs never carries remeasure_match or auto_remeasure'];
  if (d.subject !== 'trunk' && !b.includes(d.subject)) return ['a batch obs node subject must be a batch member'];
  return [];
}

/** FL3: report follow-up of the latest resume; a later submit or parent act ends the parked receipt. */
export function reportRequest(s: State, node: string): { resume: number; send: SendEntry } | undefined {
  const r = resumeOf(s, node), n = s.nodes[node];
  if (r?.expect !== 'report' || !n?.slot?.open) return undefined;
  const send = n.runs.find(a => a.attempt === r.attempt)?.sends.find(x => x.reason === 'report' && x.seq > r.seq);
  if (!send) return undefined;
  if (entriesOf(s).some(e => e.seq > send.seq && (
    (e.kind === 'submit' && e.node === node) ||
    (e.kind === 'rule' && !e.prospective && e.nodes !== '*' && e.nodes.includes(node)) ||
    (e.kind === 'plan' && canonical(nodeSpec({ ...s, plan: planAt(s, e.seq) }, node)) !== canonical(nodeSpec({ ...s, plan: planAt(s, e.seq + 1) }, node)))
  ))) return undefined;
  return { resume: r.seq, send };
}
export const reportedOf = (s: State, node: string): number | undefined => {
  const request = reportRequest(s, node);
  return request && s.nodes[node]?.reported === request.resume ? request.resume : undefined;
};
/** Stable project id of a ledger: the first 12 hex of the genesis entry hash. */
export function projectId(s: State): string {
  const g = context(s).genesis;
  if (!g) throw new OwedError('Not initialized: run owed init <plan.yaml> first');
  return g.hash.slice(0, 12);
}
/**
 * dsa run id: `owed:<project>:<node>:<attempt>:<role>[:<n>]`. Writers have no `n`; reviewer runs always carry it:
 * `n` = 1 + the reviewer launch entries already in this attempt (`nextReviewerN`), monotone across the candidates
 * of the attempt. Reviewer runs belong to the contiguous review epoch (RR1), not just the latest submit.
 */
export function runId(project: string, node: string, attempt: number, role: RunRole, n?: number): string {
  return `owed:${project}:${node}:${attempt}:${role}${n === undefined ? '' : `:${n}`}`;
}
/** Reviewer launch entries of the node's current attempt, in ledger order. */
function reviewerLaunches(s: State, node: string): LaunchEntry[] {
  const n = s.nodes[node], attempt = n?.slot?.attempt;
  return attempt === undefined ? [] : n!.runs.find(r => r.attempt === attempt)?.launches.filter(l => l.role === 'reviewer') ?? [];
}
/** The `n` of the next reviewer run of the node's current attempt: 1 + reviewer launch entries in that attempt. */
export function nextReviewerN(s: State, node: string): number { return 1 + reviewerLaunches(s, node).length; }
/** RR1: first submit in the current attempt's contiguous epoch of equal review/closure-review keys. Policy only. */
export function reviewEpoch(s: State, node: string): number | undefined {
  const n = s.nodes[node], c = n?.candidate;
  if (!n?.slot?.open || !c) return undefined;
  const keys = (facts: CandidateFacts, plan: Plan, spec: NodeSpec | undefined): (string | undefined)[] => [
    spec && reviewRequirement(plan, spec, facts.changed).count > 0 ? facts.keys.review : undefined,
    facts.closureTouched ? facts.keys['closure-review'] : undefined,
  ];
  const current = keys(c, s.plan, nodeSpec(s, node)), entries = entriesOf(s);
  let first = c.seq;
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!;
    if (e.seq >= c.seq || e.kind !== 'submit' || e.node !== node || e.attempt !== n.slot.attempt) continue;
    const priorPlan = planAt(s, e.seq), prior = keys(e.facts, priorPlan, priorPlan.nodes.find(x => x.id === node));
    const next = entries.find(x => x.seq === first);
    if (prior.some((key, k) => key !== current[k]) && !(next?.kind === 'submit' && next.facts.carry?.from === e.facts.commit)) break;
    current.splice(0, current.length, ...prior);
    first = e.seq;
  }
  return first;
}
/** Reviewer launches before the review epoch; current runs are n = base+1, base+2, … (RR1). */
export function reviewerBase(s: State, node: string): number {
  const first = reviewEpoch(s, node) ?? s.nodes[node]?.candidate?.seq;
  return first !== undefined ? reviewerLaunches(s, node).filter(l => l.seq < first).length : reviewerLaunches(s, node).length;
}
/** dsa labels of a run. */
export function runLabels(project: string, node: string, attempt: number, role: RunRole): Record<string, string> {
  return { owed: project, node, attempt: String(attempt), role };
}
/**
 * Reviewer principal of review slot `k` of an attempt: `reviewer:drive-<node>-<attempt>-<k>`. The identity is per review
 * SLOT, not per run: k = n − reviewerBase (the local index 1..runs of the candidate), so the slot-k reviewer of every
 * candidate of the attempt is the same principal and its ok at rank >= its own block's rank clears that block. Run ids
 * keep the attempt-global n.
 */
export function driveReviewer(node: string, attempt: number, k: number): string { return `reviewer:drive-${node}-${attempt}-${k}`; }
/** The review slot k of a principal that is a driver reviewer of `node`'s attempt `attempt`, else undefined. */
export function driveReviewerSlot(by: string, node: string, attempt: number): number | undefined {
  const prefix = `reviewer:drive-${node}-${attempt}-`;
  return by.startsWith(prefix) && /^[1-9][0-9]*$/.test(by.slice(prefix.length)) ? Number(by.slice(prefix.length)) : undefined;
}
export const SEND_KINDS: readonly SendKind[] = ['follow-up', 'steer', 'notify'];
export const SEND_REASONS: readonly SendReason[] = ['submit', 'repair', 'interrupted', 'fenced', 'rebase', 'review-missing', 'ruling', 'verdict', 'waiting', 'report'];
const blobHash = (v: unknown): boolean => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

// Conservative local downgrade detection keeps this leaf independent of plan.ts.
/**
 * Whether the `exec` block differs (D20/F6) in what reaches the keys (`env`, `wrap`, `touch`); `exec: {}` and no block are the same.
 * 0.9: `parallel` and `trees` only schedule measurement: changing them invalidates and downgrades nothing.
 */
function execChanged(prev: Plan, next: Plan): boolean { return canonical(execKey(prev) ?? {}) !== canonical(execKey(next) ?? {}); }
function downgradeDetails(prev: Plan, next: Plan): Downgrade[] {
  const result: Downgrade[] = [...knownRedDowngrades(prev, next), ...quarantineDowngrades(prev, next), ...riskDowngrades(prev, next)];
  const add = (node: string, what: string): void => { result.push({ node, what }); };
  const checks = (node: string, a: Plan['invariants'], b: Plan['invariants']): void => {
    for (const c of a) {
      const d = b.find(x => x.id === c.id);
      if (!d) { add(node, `${c.id} check removed`); continue; }
      if (c.red && !d.red) add(node, `${c.id} red disabled`);
      if ((d.min_tests ?? 0) < (c.min_tests ?? 0)) add(node, `${c.id} min_tests reduced`);
      const fields = (['run', 'timeout_s', 'reads', 'tests', 'red_expect', 'repeat'] as const).filter(field => canonical(c[field]) !== canonical(d[field]));
      if (fields.length) add(node, `${c.id} check definition changed (${fields.join(', ')}); owed cannot compare commands, so this needs owner authority or an allow rule; to avoid it, add the new command as a new check id`);
      if (c.mutants && (canonical(c.mutants) !== canonical(d.mutants) || (d.min_kill ?? 1) < (c.min_kill ?? 1))) add(node, `${c.id} mutants removed or changed, or min_kill reduced`);
    }
  };
  if (prev.setup !== next.setup || canonical(prev.closure) !== canonical(next.closure)) add('*', 'setup/closure changed; cannot prove obligations were not reduced');
  // D20.4: like setup, an exec change (env or wrapper, e.g. wrap ["true"]) can weaken every check: owner only, in ΔO⁻.
  if (execChanged(prev, next)) add('*', 'exec changed; cannot prove obligations were not reduced');
  if (allowWidened(prev, next)) add('trunk', 'allow changed');
  checks('trunk', prev.invariants, next.invariants);
  for (const n of prev.nodes) {
    const m = next.nodes.find(x => x.id === n.id);
    if (!m) { add(n.id, 'node removed'); continue; }
    checks(n.id, n.checks, m.checks);
    if (m.review.count < n.review.count || m.review.min_rank < n.review.min_rank) add(n.id, 'review count/rank reduced');
    if (m.writes.some(w => !n.writes.some(p => writeCovers(p, w, writesSyntax(prev), writesSyntax(next))))) add(n.id, 'writes scope expanded');
    if (n.deps.some(d => !m.deps.includes(d))) add(n.id, 'dependency removed');
    result.push(...manualDowngrades(n.id, n, m));
  }
  return result;
}
// ---------- owner allowances (SPEC §3.4, D21) ----------
/** `allow` changed other than by deleting whole rules: some rule of `next` deep-equals no rule of `prev` (D21.2). */
function allowWidened(prev: Plan, next: Plan): boolean {
  const before = new Set((prev.allow ?? []).map(r => canonical(r)));
  return writesAllowChanged(prev,next) || (next.allow ?? []).some(r => !before.has(canonical(r)));
}
/** Rules of `plan` whose node globs match node id `node` (path.matchesGlob on the id). */
const rulesFor = (plan: Plan, node: string): AllowRule[] => (plan.allow ?? []).filter(r => r.nodes.some(g => matchesGlob(node, g)));
/** Check-weakening items of downgradeDetails (`<id><suffix>`) and of plan.ts planDowngrades (`check <id><suffix>`). */
const DETECTED_CHECK = [/ check removed$/, / red disabled$/, / min_tests reduced$/, / check definition changed; cannot prove obligations were not reduced$/, / check definition changed \((?:run|timeout_s|reads|tests|red_expect|repeat)(?:, (?:run|timeout_s|reads|tests|red_expect|repeat))*\); owed cannot compare commands, so this needs owner authority or an allow rule; to avoid it, add the new command as a new check id$/, / mutants removed or changed, or min_kill reduced$/];
const CLAIMED_CHECK = [' removed', ' red disabled', ' min_tests lowered', ' mutants removed', ' min_kill lowered'];
/**
 * Whether a rule of the prior plan `prev` covers downgrade `d` of the update to `next` (D21.2). Covered: review
 * count/rank lowered to a value >= a matching rule's bound; writes widened only with prefixes under a matching rule's
 * `writes` prefix; a check weakening whose id matches a matching rule's `checks` glob; an evidence obligation removed
 * or weakened (D23: `evidence <id> removed|weakened`) whose evidence id matches a matching rule's `checks` glob.
 * Everything else is never covered: trunk items (invariants, `allow changed`), `*` items (setup/closure/exec changed),
 * `approve removed` (the owner's gate), node removed, dependency removed, and any item this function does not know.
 */
function covered(prev: Plan, next: Plan, d: Downgrade, claimed: boolean): boolean {
  if (d.node === 'trunk' || d.node === '*') return false;
  const before = prev.nodes.find(n => n.id === d.node), after = next.nodes.find(n => n.id === d.node), rules = rulesFor(prev, d.node);
  if (!before || !after || !rules.length) return false;
  const what = d.what;
  if (what === 'review count/rank reduced' || what === 'review count lowered' || what === 'review rank lowered') {
    const count = after.review.count >= before.review.count || rules.some(r => r.review_count !== undefined && after.review.count >= r.review_count);
    const rank = after.review.min_rank >= before.review.min_rank || rules.some(r => r.review_rank !== undefined && after.review.min_rank >= r.review_rank);
    return count && rank;
  }
  if (what === 'writes scope expanded' || what === 'writes widened') return after.writes.every(w => before.writes.some(p => writeCovers(p, w, writesSyntax(prev), writesSyntax(next))) || rules.some(r => r.writes?.some(p => writeCovers(p, w, writesSyntax(prev), writesSyntax(next)))));
  // Every reading of the item must be covered by a `checks` glob, and there must be one: as `<id><suffix>` naming a
  // check of the node, and (D21.1/D23.2) as `evidence <id> removed|weakened` naming an evidence obligation of the node.
  // An item readable both ways (e.g. check id `evidence`, evidence id `check`) is covered only if both readings are.
  const ids = (claimed ? (what.startsWith('check ') ? CLAIMED_CHECK.filter(x => what.endsWith(x)).map(x => what.slice(6, what.length - x.length)) : []) : DETECTED_CHECK.flatMap(x => { const match = x.exec(what); return match ? [what.slice(0, match.index)] : []; })).filter(id => before.checks.some(c => c.id === id));
  const evidence = /^evidence (\S+) (?:removed|weakened)$/.exec(what)?.[1], evidenceIds = evidence !== undefined && (before.evidence ?? []).some(e => e.id === evidence) ? [evidence] : [];
  const readings = [...ids, ...evidenceIds];
  return readings.length > 0 && readings.every(id => rules.some(r => r.checks?.some(g => matchesGlob(id, g))));
}
/**
 * Downgrades of a plan update from `prev` to `next` that no allowance of `prev` (never of `next`) covers: the detected
 * ones and the `claimed` ones of the plan entry (D21.2). Empty = a parent may record the update without an owner.
 */
export function uncoveredDowngrades(prev: Plan, next: Plan, claimed: Downgrade[] = []): Downgrade[] {
  const detected = downgradeDetails(prev, next).filter(d => !covered(prev, next, d, false)), seen = new Set(detected.map(d => `${d.node}\n${d.what}`));
  // Each downgrade once (G4): a claimed item is left out when its detected wording is already listed.
  return [...detected, ...claimed.filter(d => !covered(prev, next, d, true) && !detectedWordings(d.what).some(w => seen.has(`${d.node}\n${w}`)))].filter((d, i, all) => all.findIndex(x => x.node === d.node && x.what === d.what) === i);
}
/**
 * H2.1: the hint line of a refused parent plan update whose only uncovered downgrades (`gaps`, from uncoveredDowngrades)
 * widen writes: a ready-to-paste allow rule naming those nodes and their new prefixes (those under neither the node's
 * prior writes nor a matching rule of `prev`). Undefined when any gap is something else, or there is none.
 */
export function writesHint(prev: Plan, next: Plan, gaps: Downgrade[]): string | undefined {
  if (!gaps.length || !gaps.every(g => g.what === 'writes widened' || g.what === 'writes scope expanded')) return undefined;
  const nodes = [...new Set(gaps.map(g => g.node))], writes = [...new Set(nodes.flatMap(id => {
    const before = prev.nodes.find(n => n.id === id), after = next.nodes.find(n => n.id === id), rules = rulesFor(prev, id);
    return before && after ? after.writes.filter(w => !before.writes.some(p => writeCovers(p, w, writesSyntax(prev), writesSyntax(next))) && !rules.some(r => r.writes?.some(p => writeCovers(p, w, writesSyntax(prev), writesSyntax(next))))) : [];
  }))];
  if (!writes.length) return undefined;
  const list = (xs: string[]): string => `[${xs.map(x => JSON.stringify(x)).join(', ')}]`;
  return `hint: an allow rule {nodes: ${list(nodes)}, writes: ${list(writes)}} in the prior plan would cover this`;
}
/** The downgradeDetails wordings a planDowngrades item (plan.ts) may have; the item itself when the wording is shared. */
function detectedWordings(what: string): string[] {
  if (what === 'review count lowered' || what === 'review rank lowered') return ['review count/rank reduced'];
  if (what === 'writes widened') return ['writes scope expanded'];
  const out = [what], mutants = ' mutants removed or changed, or min_kill reduced';
  const pairs: [string, string][] = [[' removed', ' check removed'], [' red disabled', ' red disabled'], [' min_tests lowered', ' min_tests reduced'], [' mutants removed', mutants], [' min_kill lowered', mutants]];
  if (what.startsWith('check ')) for (const [claimed, detected] of pairs) if (what.endsWith(claimed)) out.push(`${what.slice(6, what.length - claimed.length)}${detected}`);
  return out;
}
/** `adopt` prefixes of every rule of `plan` (D21.4). */
export function adoptPrefixes(plan: Plan): string[] { return (plan.allow ?? []).flatMap(r => r.adopt ?? []); }
/** The first changed path not under an `adopt` prefix of `plan`, or undefined when a parent may adopt them all (D21.4). */
export function unadoptable(plan: Plan, changed: readonly string[]): string | undefined {
  const prefixes = adoptPrefixes(plan);
  return changed.find(p => !prefixes.some(x => matchesWrite(p, x, writesSyntax(plan))));
}
/** Whether a matching rule authorizes each exact changed path (not a scope widening). */
export function writesAllowed(plan: Plan, node: string, paths: readonly string[]): boolean {
  const rules = rulesFor(plan, node);
  return paths.length > 0 && paths.every(p => rules.some(r => r.writes?.some(x => matchesWrite(p, x, writesSyntax(plan)))));
}
/** WG3: coverage of a scope widening must be provable by literal prefixes or exact entry equality. */
export function writesCovered(plan: Plan, node: string, entries: readonly string[]): boolean {
  return entries.length > 0 && entries.every(w => rulesFor(plan, node).some(r => r.writes?.some(p => writeCovers(p, w, writesSyntax(plan), 2))));
}
/** Seq of the genesis/plan entry that last changed the `allow` block (S of `under allowance (plan #S)`, D21.3), if any. */
export function allowanceSeq(s: State): number | undefined { return context(s).allowSeq; }
/** GR2: used both at append and every replay, before any grant can affect acceptance. */
export function grantErrors(s: State, d: Omit<import('./types.ts').GrantEntry, 'seq' | 'ts' | 'prev' | 'hash'>): string[] {
  const malformed = ignorableError(d);
  if (malformed) return [malformed];
  d = interpretedEntry(d);
  const errors: string[] = [], n = s.nodes[d.node], spec = nodeSpec(s, d.node);
  if (d.by !== 'executor:owed') errors.push('grant may only be written by executor:owed');
  if (!n?.slot?.open || n.slot.attempt !== d.attempt) errors.push('grant attempt must match the current open writer slot');
  if (!n?.candidate || n.candidate.commit !== d.commit) errors.push('grant commit must match the current candidate commit');
  const paths = d.paths;
  if (!Array.isArray(paths) || !paths.length || paths.some(p => typeof p !== 'string' || !p || p.startsWith('/') || p.endsWith('/') || p.split('/').some(x => x === '.' || x === '..' || !x)) || canonical(paths) !== canonical([...new Set(paths)].sort())) {
    errors.push('grant paths must be sorted unique exact repository paths');
    return errors;
  }
  if (paths.some(p => !n?.candidate?.changed.includes(p))) errors.push('grant paths must be in the current candidate changed paths');
  if (paths.some(p => spec?.writes.some(w => matchesWrite(p, w, writesSyntax(s.plan))))) errors.push('grant paths must be outside plan writes');
  if (!writesAllowed(s.plan, d.node, paths)) errors.push('not covered by an allow rule');
  if (!Number.isSafeInteger(d.allowance) || d.allowance !== allowanceSeq(s)) errors.push('grant allowance must match the current allowance plan seq');
  if (paths.some(p => matchesAny(p, s.plan.closure))) errors.push('under closure');
  for (const other of Object.values(s.nodes).filter(x => x.id !== d.node && x.slot?.open).sort((a,b) => a.id.localeCompare(b.id))) {
    if (paths.some(p => withinWrites(s, other.id, p))) { errors.push(`overlaps open node ${other.id}`); break; }
  }
  if (paths.some(p => grantsOf(s, d.node).some(g => g.paths.includes(p)))) errors.push('grant paths already granted to this attempt');
  errors.push(...Object.keys(d).filter(k => !ENTRY_BASE_FIELDS.includes(k) && !['node', 'attempt', 'commit', 'paths', 'allowance'].includes(k)).map(k => `grant unknown field ${k}`));
  return errors;
}
/** WG4: classify exact paths independently, using the same replay gate as a real grant. */
export function writesRefusals(s: State, id: string, paths: readonly string[]): { path: string; reasons: string[]; owners: string[] }[] {
  const n = s.nodes[id];
  return paths.filter(p => !withinWrites(s,id,p)).sort().flatMap(path => {
    const reasons = grantErrors(s,{kind:'grant',by:'executor:owed',node:id,attempt:n?.slot?.attempt ?? -1,commit:n?.candidate?.commit ?? '',paths:[path],allowance:allowanceSeq(s) ?? -1});
    const owners = Object.values(s.nodes).filter(other => other.id !== id && other.slot?.open && withinWrites(s,other.id,path)).map(other => other.id).sort();
    return reasons.length ? [{path,reasons,owners}] : [];
  });
}
/** WG5: latest overlap-only writes failure for this candidate, including while its owners remain open. */
export function writesWaiting(s: State, id: string): ObsEntry | undefined {
  const c = s.nodes[id]?.candidate;
  if (!c) return undefined;
  const latest = observationsOf(s,id,'writes',c.keys.writes ?? '').at(-1);
  return latest?.verdict === 'fail' && latest.waits_on?.length && latest.commit === c.commit && latest.base === c.base ? latest : undefined;
}
/** WG ruling #2098: find an actual ownership cycle reachable from a waiting candidate. */
export function writesWaitCycle(s: State, id: string): string[] | undefined {
  const path: string[] = [], done = new Set<string>();
  const visit = (node: string): string[] | undefined => {
    const at = path.indexOf(node);
    if (at >= 0) return [...path.slice(at),node];
    if (done.has(node) || !s.nodes[node]?.slot?.open || !writesWaiting(s,node)) return undefined;
    path.push(node);
    const owners = [...new Set(writesRefusals(s,node,s.nodes[node]!.candidate!.changed).flatMap(r => r.owners))].sort();
    for (const owner of owners) { const cycle = visit(owner); if (cycle) return cycle; }
    path.pop(); done.add(node); return undefined;
  };
  return visit(id);
}
/** GR7: advisory only, for the uncovered paths; does not authorize a write. */
export function grantHint(s: State, id: string, paths = s.nodes[id]?.candidate?.changed ?? []): string | undefined {
  const uncovered = paths.filter(p => !withinWrites(s, id, p) && !writesAllowed(s.plan, id, [p]));
  if (!uncovered.length) return undefined;
  const dirs = [...new Set(uncovered.map(p => p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : p))].sort();
  return `hint: an allow rule {nodes: ${JSON.stringify([id])}, writes: ${JSON.stringify(dirs)}} would let owed grant these`;
}
export function validateDraft(s: State, d: Draft): string[] {
  const malformed = ignorableError(d);
  if (malformed) return [malformed];
  d = interpretedEntry(d);
  const errors: string[] = [];
  errors.push(...batchOrderErrors(s, d), ...decisionErrors(s,d));
  const r = role(d.by);
  const allow = (...roles: string[]): void => { if (!roles.includes(r)) errors.push(`${d.kind} insufficient permissions; requires ${roles.join('/')}`); };
  if (!/^(owner|parent|writer|reviewer|executor):.+$/.test(d.by)) errors.push('Invalid identity format');
  // G2.3 (F5): parent:drive is the driver's name only; it records nothing the driver never writes (append and replay).
  if (d.by === DRIVER && !DRIVER_WRITES.includes(d.kind)) errors.push(`${d.kind} by ${DRIVER}: the driver records only ${DRIVER_WRITES.join(', ')}`);
  if ((d.kind === 'genesis' || d.kind === 'plan') && d.writes_syntax !== undefined && d.writes_syntax !== 2) errors.push('plan writes_syntax must be 2; upgrade owed before replaying this plan');
  if (d.kind === 'genesis') {
    allow('owner');
    if (s.seq !== -1) errors.push('genesis must be the first entry');
    if (d.commit !== d.state.commit) errors.push('genesis commit does not match facts');
    return errors;
  }
  if (s.seq === -1) return [...errors, 'genesis must be established first'];
  const n = 'node' in d ? s.nodes[d.node] : undefined;
  const spec = 'node' in d ? nodeSpec(s, d.node) : undefined;
  if (d.kind === 'merge' && (d.facts.carry !== undefined || d.facts.rebased !== undefined)) errors.push('merge facts never carry submit review inheritance or rebased markers');
  // Ruling #1176 (0.12): abandon may close a removed node's slot; AH hold may follow it atomically.
  if ('node' in d && (!n || (!spec && d.kind !== 'escape' && !((d.kind === 'abandon' || d.kind === 'hold') && n.phase === 'removed')))) errors.push(`Node ${d.node} does not exist`);
  const slot = (): void => { if (!n?.slot?.open || !('attempt' in d) || n.slot.attempt !== d.attempt) errors.push('attempt must match the current open writer slot'); };
  const current = (o: string, key: string, reviewOnly = false): void => { if (!n?.slot?.open || !n.candidate || !spec || (!required(s.plan, spec, n.candidate).includes(o) && !(reviewOnly && o === 'review') && !n.blocks.some(b => b.obligation === o && underlyingActive(context(s), b))) || !key || n.candidate.keys[o] !== key) errors.push(`${o} must reference the current candidate obligation key`); };
  switch (d.kind) {
    case 'refresh':
      if (d.by !== 'executor:owed') errors.push('refresh may only be written by executor:owed');
      if (d.commit !== s.trunk.commit) errors.push('refresh commit must be the current ledger trunk');
      if (!d.state || d.state.commit !== d.commit || d.state.tree !== s.trunk.tree) errors.push('refresh commit/tree must match trunk facts');
      if (!d.state?.invKeys || Object.keys(d.state.invKeys).sort().join() !== s.plan.invariants.map(i => i.id).sort().join() || Object.values(d.state.invKeys).some(k => typeof k !== 'string' || !k)) errors.push('refresh must supply keys for exactly the current plan invariants');
      errors.push(...Object.keys(d).filter(k => !ENTRY_BASE_FIELDS.includes(k) && !['commit', 'state'].includes(k)).map(k => `refresh unknown field ${k}`));
      break;
    case 'plan': {
      allow('owner', 'parent');
      if (d.prior !== s.planSha) errors.push('plan prior must reference the current plan sha');
      let downgrade = d.downgrades.length > 0, gaps: Downgrade[] = d.downgrades, hint: string | undefined;
      try { const next = withWritesSyntax(context(s).plans(d.plan),d.writes_syntax ?? 1); downgrade = downgradeDetails(s.plan, next).length > 0 || downgrade; gaps = uncoveredDowngrades(s.plan, next, d.downgrades); hint = writesHint(s.plan, next, gaps); } catch { errors.push('Cannot read new plan'); }
      // D21.3: a parent needs no owner when an allowance of the current (prior) plan covers every downgrade.
      if (downgrade && r !== 'owner' && (r !== 'parent' || gaps.length)) errors.push(`Only owner may approve a plan that reduces obligations${r === 'parent' ? `; not covered by an allowance of the current plan: ${gaps.map(g => `${g.node}: ${g.what}`).join('; ')}${hint ? `\n${hint}` : ''}` : ''}`);
      if (d.note !== undefined && typeof d.note !== 'string') errors.push('plan note must be a string');
      // D25.5: a delegated owner act that eases acceptance says why (waive, defer and adopt already require theirs).
      if (downgrade && r === 'owner' && d.channel === 'delegated' && !(typeof d.note === 'string' && d.note.trim())) errors.push('a delegated owner plan update that reduces obligations requires a note saying why (owed plan --note TEXT; owed_plan note)');
      break;
    }
    case 'rule':
      allow('owner', 'parent');
      if (d.nodes !== '*' && d.nodes.some(id => !nodeSpec(s, id))) errors.push('rule references a nonexistent node');
      if (d.writer !== undefined && typeof d.writer !== 'boolean') errors.push('rule writer must be a boolean');
      if (d.prospective !== undefined && typeof d.prospective !== 'boolean') errors.push('rule prospective must be a boolean');
      if (d.prospective && d.writer) errors.push('--prospective cannot be combined with --writer');
      // AN2: an answer names one launch of the node's current open attempt; delivery never invalidates a candidate.
      if (d.answers !== undefined) errors.push(...decisionAnswersErrors(s,d));
      if (d.answer !== undefined) {
        const a = d.answer;
        if (!a || typeof a !== 'object' || Array.isArray(a) || Object.keys(a).some(k => !['rid', 'qid', 'rev'].includes(k)) || typeof a.rid !== 'string' || !a.rid.trim() || typeof a.qid !== 'string' || !a.qid.trim() || !Number.isInteger(a.rev) || a.rev < 1) errors.push('rule answer must be {rid, qid, rev} with nonempty ids and a positive integer rev');
        if (!Array.isArray(d.nodes) || (d.decision === undefined && (d.nodes.length !== 1 || d.writer !== false))) errors.push('answer rule requires one node and writer: false');
        else {
          const launch = d.nodes.flatMap(id => { const target = s.nodes[id]; return target?.slot?.open ? target.runs.find(x => x.attempt === target.slot!.attempt)?.launches ?? [] : []; }).find(x => x.rid === a?.rid);
          if (!launch) errors.push('answer rid must name a launch of the node current open attempt');
          else if (typeof d.text !== 'string' || !d.text.startsWith(`Answer to ${launch.role} question ${a.qid}: `) || !d.text.slice(`Answer to ${launch.role} question ${a.qid}: `.length).trim()) errors.push('answer rule text must name the role and question and include the answer');
        }
        errors.push(...answerRevisionErrors(s, a, d.supersedes));
      } else if (d.supersedes !== undefined) errors.push('rule supersedes requires an answer');
      break;
    case 'dispatch':
      allow('parent', 'owner');
      if (n?.held !== undefined) errors.push(`${d.node} is held by abandon #${n.held}; release it with owed resume ${d.node}`);
      if (n?.phase !== 'ready' || n.slot?.open) errors.push('dispatch requires a ready node with no open slot');
      if (!Number.isInteger(d.attempt) || d.attempt !== (n?.slot?.attempt ?? 0) + 1) errors.push('attempt must increase consecutively starting at 1');
      if (d.base !== s.trunk.commit) errors.push('dispatch base must be the current trunk');
      if (!Number.isInteger(d.rulings_seen) || d.rulings_seen < -1 || d.rulings_seen > Math.max(0, ...s.rules.map(x => x.seq))) errors.push('rulings_seen must not reference a ruling that does not yet exist');
      break;
    case 'submit':
      slot();
      if (d.by === 'executor:owed') errors.push(...(d.facts.rebased !== undefined ? executorRebaseErrors(s, d) : carryErrors(s, d, n)));
      else {
        if (d.by !== n?.slot?.writer) errors.push('submit must be performed by the slot writer');
        if (d.carry !== undefined) errors.push('a writer submit never has carry');
      }
      errors.push(...reviewCarryErrors(s, d));
      if (d.facts.rebased !== undefined && (d.by !== 'executor:owed' || d.facts.rebased !== true)) errors.push('submit rebased must be true and only recorded by executor:owed');
      if (d.facts.base !== n?.slot?.base) errors.push('submit base must match slot base');
      if (spec && required(s.plan, spec, d.facts).some(o => !d.facts.keys[o])) errors.push('submit is missing required obligation keys');
      if (spec && Object.entries(manualKeys(spec, d.facts.patch)).some(([o, k]) => d.facts.keys[o] !== k)) errors.push('submit approve/evidence keys must be derived from the candidate patch');
      break;
    case 'grant':
      errors.push(...grantErrors(s, d));
      break;
    case 'obs':
      if (d.by !== 'executor:owed') errors.push('obs may only be written by executor:owed');
      if (d.subject === 'trunk') {
        if (!d.obligation.startsWith('inv:') || !s.plan.invariants.some(i => `inv:${i.id}` === d.obligation)) errors.push('trunk obs must reference an invariant obligation');
        if (d.attribution) errors.push('invariant does not use node attribution reruns');
      } else {
        const target = s.nodes[d.subject];
        if (!target) errors.push('obs node does not exist');
        if (!/^(check:.+|red:.+|strength:.+|writes)$/.test(d.obligation)) errors.push('obs can only observe execution obligations');
        if (d.merging !== undefined && d.merging !== d.subject) errors.push('obs merging must name its node subject');
        if (d.attribution && !target?.blocks.some(b => b.kind === 'exec' && underlying(context(s), b) === 'active' && b.key === d.key && b.obligation === d.obligation && listed(context(s).bySeq, b.seq).some(e => e.kind === 'obs' && e.seq === b.seq && e.commit === d.commit && e.base === d.base))) errors.push('Attribution must match the original key/commit/base of an active execution block');
      }
      if (d.merging !== undefined && (typeof d.merging !== 'string' || !s.nodes[d.merging]?.slot?.open || !s.nodes[d.merging]?.candidate)) errors.push('obs merging must name a node with an open candidate');
      if (d.probe !== undefined && (d.probe !== 'trunk' || d.subject === 'trunk' || !s.nodes[d.subject]?.slot?.open || !s.nodes[d.subject]?.candidate || !s.plan.nodes.find(n => n.id === d.subject)?.checks.some(c => `check:${c.id}` === d.obligation) || d.commit !== s.trunk.commit || d.base !== s.trunk.commit || d.attribution !== undefined || d.merging !== undefined)) errors.push('trunk probe requires an open node check on current trunk, without attribution or merging');
      if (!d.key) errors.push('obs is missing an obligation key');
      for (const measured of [d, ...(d.runs ?? [])]) {
        const ex = measured.execution;
        if (ex !== undefined && (!ex || typeof ex !== 'object' || Array.isArray(ex) || typeof ex.completed !== 'boolean' || typeof ex.countOK !== 'boolean' || Object.keys(ex).some(k => !['completed','countOK'].includes(k)))) errors.push('obs execution must be {completed, countOK} booleans');
      }
      if (d.waits_on !== undefined) {
        const target = s.nodes[d.subject], c = target?.candidate;
        const refused = c ? writesRefusals(s,d.subject,c.changed) : [];
        const expected = [...new Set(refused.flatMap(r => r.owners))].sort();
        if (d.obligation !== 'writes' || d.verdict !== 'fail' || d.attribution !== undefined || d.merging !== undefined || d.probe !== undefined || !target?.slot?.open || !c || d.commit !== c.commit || d.base !== c.base || d.key !== c.keys.writes || !Array.isArray(d.waits_on) || !d.waits_on.length || canonical(d.waits_on) !== canonical(expected) || !refused.length || refused.some(r => r.reasons.some(reason => !reason.startsWith('overlaps open node ')))) errors.push('obs waits_on requires only current candidate writes overlaps with the named open nodes');
      }
      if (d.auto_remeasure !== undefined && (d.auto_remeasure !== true || d.subject !== 'trunk' || !d.obligation.startsWith('inv:') || d.probe !== undefined || d.attribution)) errors.push('obs auto_remeasure must be true on a non-attribution invariant observation');
      if (d.grant_refused !== undefined && (d.grant_refused !== true || d.obligation !== 'writes' || d.verdict !== 'fail' || d.by !== 'executor:owed' || d.batch !== undefined)) errors.push('obs grant_refused requires an executor writes failure');
      if (d.remeasure_match !== undefined) {
        const needles = s.plan.invariants.find(i => `inv:${i.id}` === d.obligation)?.remeasure_on ?? [];
        if (d.subject !== 'trunk' || d.verdict !== 'fail' || !Array.isArray(d.remeasure_match) || !d.remeasure_match.length || d.remeasure_match.length > needles.length || d.remeasure_match.some(x => typeof x !== 'string' || !needles.includes(x)) || new Set(d.remeasure_match).size !== d.remeasure_match.length) errors.push('obs remeasure_match must be non-empty unique entries from the invariant remeasure_on, bounded by that list');
      }
      if (d.auto_remeasure === true) {
        const prior = observations(s,d.subject,d.obligation,d.key), first = prior.at(-1);
        const needles = s.plan.invariants.find(i => `inv:${i.id}` === d.obligation)?.remeasure_on ?? [];
        if (prior.some(e => e.auto_remeasure)) errors.push('obs auto_remeasure already consumed on this key');
        const ro2 = !!first?.remeasure_match?.length && needles.length > 0 && first.remeasure_match.every(text => needles.includes(text));
        // FS2: or the preceding failure is shared (recomputed from the ledger); its retry carries no remeasure_match.
        const shared = !ro2 && !!first && d.remeasure_match === undefined && !s.plan.invariants.find(i => `inv:${i.id}` === d.obligation)?.repeat && !!sharedFailure(s, first, first.merging);
        const setup = !!first && first.batch === undefined && d.batch === undefined && setupFailure(s,first);
        if (!first || first.verdict !== 'fail' || first.auto_remeasure || first.probe || first.attribution || (!ro2 && !shared && !setup)) errors.push('obs auto_remeasure requires the preceding same-key failure to match remeasure_on, be shared or be a setup failure');
      }
      if (d.infra !== undefined && (!Number.isSafeInteger(d.infra) || d.infra !== infraSource(s,d))) errors.push('obs infra requires the immediately preceding executor setup failure of the same subject, obligation and key and a counted pass satisfying the spec');
      errors.push(...batchObsErrors(d));
      errors.push(...leaseWaitErrors(d));
      if (d.quarantined !== undefined && (!Array.isArray(d.quarantined) || !d.quarantined.length || d.quarantined.some(x => typeof x !== 'string' || !x))) errors.push('obs quarantined must be a non-empty array of test names');
      if (d.quarantine_passed !== undefined && (!Array.isArray(d.quarantine_passed) || !d.quarantine_passed.length || d.quarantine_passed.some((x, i, a) => typeof x !== 'string' || !x || (i > 0 && a[i - 1]! >= x)))) errors.push('obs quarantine_passed must be a non-empty sorted unique array of test names');
      break;
    case 'review':
      allow('reviewer', 'owner'); slot(); current(d.obligation, d.key, true);
      if (n?.writers.includes(d.by) || n?.writers.some(w => w.slice(w.indexOf(':') + 1) === d.by.slice(d.by.indexOf(':') + 1))) errors.push('review reviewer must not be the writer of any attempt of this node');
      if (r === 'owner' && d.rank !== 3) errors.push('owner reviews use --rank 3');
      else if (r !== 'owner' && ![1, 2].includes(d.rank)) errors.push('review rank: reviewer must use 1..2, owner must use 3');
      if (d.ack_rulings !== undefined && (!Number.isInteger(d.ack_rulings) || d.ack_rulings > Math.max(0, ...s.rules.map(x => x.seq)))) errors.push('ack_rulings must not reference future rulings');
      if (d.needs !== undefined && (d.needs !== 'parent' || d.verdict !== 'block')) errors.push("review needs must be 'parent' and only on a block verdict");
      if (d.obligation === 'approve' && r !== 'owner') errors.push('approve can only be recorded by the owner');
      break;
    case 'waive': {
      // The owner-declared key is computed and checked on the current merge tree by ops.waive.
      // Replay checks its provenance without needing Git: a cited, non-active merge fail on that key.
      const mergeKeyRisk = d.accept_risk?.some(seq => !activeRisk(s, d.node, d.obligation, seq) && mergeRisk(s, d.node, d.obligation, seq, d.key));
      allow('owner'); current(d.obligation, mergeKeyRisk ? n?.candidate?.keys[d.obligation] ?? '' : d.key);
      if (d.obligation.startsWith('inv:') || d.node === 'trunk') errors.push('invariant can never be waived');
      if (!d.reason.trim()) errors.push('waive requires a reason');
      if (d.accept_risk?.some(seq => activeRisk(s, d.node, d.obligation, seq) ? !!mergeKeyRisk && n?.blocks.find(b => b.seq === seq)?.key !== d.key : !mergeRisk(s, d.node, d.obligation, seq, d.key))) errors.push('accept_risk must reference active blocks for this obligation');
      break;
    }
    case 'defer':
      if (d.by === 'executor:owed' || d.allowance !== undefined) { errors.push(...executorDeferErrors(s, d)); break; }
      allow('owner');
      if (!n?.slot?.open || !n.candidate) errors.push('defer requires a current candidate');
      if (!d.reason.trim() || !d.items.length) errors.push('defer must list obligations and give a reason');
      if (d.items.some(i => !i.key || !s.plan.invariants.some(c => c.id === i.id))) errors.push('defer must reference valid invariants and keys');
      break;
    case 'abandon':
      allow('parent', 'owner'); slot();
      if (d.by === DRIVER) {
        const dispatched = context(s).entries.find(e => e.kind === 'dispatch' && e.node === d.node && e.attempt === d.attempt);
        if (dispatched?.by !== DRIVER || n?.runs.find(r => r.attempt === d.attempt)?.launches.some(l => l.role === 'writer')) errors.push('driver abandon requires its own empty slot with no writer launch');
        if (spec) errors.push('driver abandon requires a node that left the plan; live nodes are not stale empty slots');
        if (typeof d.reason !== 'string' || !d.reason.trim()) errors.push('driver abandon requires a stale cause');
      }
      break;
    case 'hold': {
      allow('parent', 'owner');
      const prior = context(s).entries.at(-1);
      if (!prior || prior.kind !== 'abandon' || prior.seq !== d.abandon || prior.node !== d.node || prior.attempt !== n?.slot?.attempt || prior.by !== d.by || prior.channel !== d.channel || n?.slot?.open) errors.push('hold must immediately follow the same actor abandon of this node slot');
      if (d.reason !== undefined && typeof d.reason !== 'string') errors.push('hold reason must be a string');
      break;
    }
    case 'rebase':
      if (!['parent', 'owner'].includes(r) && d.by !== n?.slot?.writer) errors.push('rebase requires parent/owner or the slot writer');
      slot();
      if (d.from !== n?.slot?.base) errors.push('rebase from must be the current slot base');
      if (d.base !== s.trunk.commit) errors.push('rebase base must be the current trunk');
      else if (d.base === d.from) errors.push('trunk has not moved since the slot base; nothing to rebase');
      break;
    case 'merge':
      if (d.by !== 'executor:owed') errors.push('merge may only be written by executor:owed');
      slot();
      if (d.prior !== s.trunk.commit) errors.push('merge prior must reference the current trunk');
      if (d.commit !== d.facts.commit || d.commit !== d.state.commit) errors.push('merge commit does not match facts');
      errors.push(...batchMergeErrors(d));
      errors.push(...leaseWaitErrors(d));
      if (n && spec) errors.push(...mergeGuard(s, d.node, { facts: d.facts, state: d.state, batch: d.batch }).reasons);
      break;
    case 'sweep':
      if (d.by !== 'executor:owed') errors.push('sweep may only be written by executor:owed');
      if (typeof d.commit !== 'string' || !/^[0-9a-f]{40}$/.test(d.commit)) errors.push('sweep commit must be a full commit oid');
      if (!['pass', 'fail', 'error'].includes(d.verdict)) errors.push('sweep verdict must be pass, fail or error');
      if (d.key !== undefined && !blobHash(d.key)) errors.push('sweep key must be a definition hash');
      if (!blobHash(d.log)) errors.push('sweep log must be a blob hash');
      if (!Array.isArray(d.failed) || d.failed.length > 50 || d.failed.some(x => typeof x !== 'string')) errors.push('sweep failed must list at most 50 names');
      if (d.bisect !== undefined && d.bisect !== true) errors.push('sweep bisect must be true when present');
      if (d.boundary !== undefined) errors.push(...sweepBoundaryErrors(entriesOf(s),d,s.plan));
      if (d.counts !== undefined && (!d.counts || typeof d.counts !== 'object' || Array.isArray(d.counts) || Object.entries(d.counts).some(([k, v]) => k === 'format' ? typeof v !== 'string' : k === 'failed' ? !Array.isArray(v) || v.length > 50 || v.some(n=>typeof n !== 'string') : !['tests', 'pass', 'fail', 'skip'].includes(k) || !Number.isInteger(v) || (v as number) < 0))) errors.push('sweep counts must be non-negative integer counts');
      break;
    case 'note': break;
    case 'adopt': {
      // D21.4: a parent may adopt when every changed path lies under an `adopt` prefix of the current plan's rules.
      if (r === 'parent' && adoptPrefixes(s.plan).length) {
        const outside = Array.isArray(d.changed) ? unadoptable(s.plan, d.changed) : undefined;
        if (outside !== undefined) errors.push(`parent adoption refused: changed path ${outside} is not under an allow adopt prefix (${adoptPrefixes(s.plan).join(', ')}); the owner must adopt it`);
      } else allow('owner');
      if (d.trunk !== s.trunk.name) errors.push(`adopt trunk must be the ledger trunk ${s.trunk.name}`);
      if (d.prior !== s.trunk.commit) errors.push('adopt prior must reference the current trunk');
      if (typeof d.commit !== 'string' || !d.commit || d.commit !== d.state?.commit) errors.push('adopt commit does not match facts');
      else if (d.commit === d.prior) errors.push('adopt commit equals the current trunk; nothing to adopt');
      if (typeof d.note !== 'string' || !d.note.trim()) errors.push('adopt requires a note');
      if (!Array.isArray(d.changed) || d.changed.some(p => typeof p !== 'string')) errors.push('adopt changed must be a list of paths');
      if (!Number.isInteger(d.commits) || d.commits < 1) errors.push('adopt commits must be a positive integer');
      if (!d.state || typeof d.state.tree !== 'string' || !d.state.invKeys || typeof d.state.invKeys !== 'object') errors.push('adopt state must be trunk state facts');
      else errors.push(...adoptGuard(s, d.state).reasons);
      break;
    }
  }
  if (d.kind === 'escape' || d.kind === 'decoy-commit' || d.kind === 'decoy-reveal' || d.kind === 'adopt' || d.kind === 'launch' || d.kind === 'send' || d.kind === 'halt' || d.kind === 'evidence' || d.kind === 'resume' || d.kind === 'sweep') {
    const extra = Object.entries(d).filter(([k, v]) => v !== undefined && !ENTRY_BASE_FIELDS.includes(k) && !STRICT_FIELDS[d.kind].includes(k)).map(([k]) => k);
    if (extra.length) errors.push(`${d.kind} has unknown fields: ${extra.join(', ')}`);
  }
  if ((d.kind === 'submit' || d.kind === 'review') && d.model !== undefined && (typeof d.model !== 'string' || !d.model.trim())) errors.push(`${d.kind} model must be nonempty text`);
  switch (d.kind) {
    case 'escape': {
      if (r === 'executor' || d.sweep !== undefined) errors.push(...executorEscapeErrors(entriesOf(s),d));
      else allow('owner', 'parent');
      const m = Number.isInteger(d.merge) ? listed(context(s).bySeq, d.merge)[0] : undefined;
      if (m?.kind !== 'merge' || m.node !== d.node) errors.push(`escape merge #${d.merge} is not a merge of node ${d.node}`);
      if (!ESCAPE_CLASSES.includes(d.class)) errors.push(`escape class must be one of ${ESCAPE_CLASSES.join(', ')}`);
      if (typeof d.note !== 'string' || !d.note.trim()) errors.push('escape requires a note');
      if (d.evidence !== undefined && typeof d.evidence !== 'string') errors.push('escape evidence must be text');
      break;
    }
    case 'launch': {
      allow('parent'); slot();
      if (d.role !== 'writer' && d.role !== 'reviewer') errors.push('launch role must be writer or reviewer');
      if (!blobHash(d.spec)) errors.push('launch spec must be a blob hash (64 lowercase hex)');
      if (!errors.length) {
        const project = projectId(s), base = runId(project, d.node, d.attempt, d.role), tail = typeof d.rid === 'string' && d.rid.startsWith(`${base}:`) ? d.rid.slice(base.length + 1) : undefined;
        if (d.role === 'writer' ? d.rid !== base : !(tail !== undefined && /^[1-9][0-9]*$/.test(tail))) errors.push(`launch rid must be ${base}${d.role === 'reviewer' ? ':<n> (n >= 1; reviewer runs always carry n)' : ''}`);
        if (!d.labels || typeof d.labels !== 'object' || Array.isArray(d.labels) || canonical(d.labels) !== canonical(runLabels(project, d.node, d.attempt, d.role))) errors.push(`launch labels must be ${canonical(runLabels(project, d.node, d.attempt, d.role))}`);
        if (listed(context(s).launches, d.rid).some(e => e.kind === 'launch' && e.rid === d.rid)) errors.push(`launch ${d.rid} is already recorded; a re-launch reuses the stored entry`);
      }
      if (d.rulings !== undefined) errors.push(...carriedErrors(s, d, 'launch'));
      break;
    }
    case 'send': {
      allow('parent'); slot();
      if (!listed(context(s).launches, d.rid).some(e => e.kind === 'launch' && e.rid === d.rid && e.node === d.node && e.attempt === d.attempt)) errors.push('send rid must name a recorded launch of this node attempt');
      if (!SEND_KINDS.includes(d.sendKind)) errors.push(`send sendKind must be one of ${SEND_KINDS.join(', ')}`);
      if (!SEND_REASONS.includes(d.reason)) errors.push(`send reason must be one of ${SEND_REASONS.join(', ')}`);
      if (!blobHash(d.message)) errors.push('send message must be a blob hash (64 lowercase hex)');
      const seq = 'seq' in d && typeof d.seq === 'number' ? d.seq : s.seq + 1;
      if (d.send !== `${d.rid}:${d.sendKind}:${seq}`) errors.push(`send id must be ${d.rid}:${d.sendKind}:${seq} (rid, kind, seq of this entry)`);
      // D22.1: `rulings` = the highest ruling seq a `ruling` send includes; required for reason ruling, forbidden otherwise.
      if (d.reason === 'ruling') {
        if (!Number.isInteger(d.rulings) || !s.rules.some(r => r.seq === d.rulings && (r.nodes === '*' || r.nodes.includes(d.node)))) errors.push(`send reason ruling requires rulings = the seq of a recorded ruling covering ${d.node}`);
      } else if (d.reason === 'repair' || d.reason === 'submit' || d.reason === 'rebase' || d.reason === 'report') {
        // E4: a repair records the highest in-scope ruling seq its message carried (0 when none); absent on 0.5.0 entries.
        // K5.2 (0.7): a submit or rebase follow-up records it when it carries rulings.
        if (d.rulings !== undefined) errors.push(...carriedErrors(s, d, `send reason ${d.reason}`));
      } else if (d.rulings !== undefined) errors.push('send rulings is only allowed with reason ruling, repair, submit or rebase');
      break;
    }
    case 'evidence': errors.push(...evidenceErrors(d, n, spec)); break;
    case 'resume':
      // 0.8 (L1.1): parent or owner only; the driver (parent:drive) is refused above (DRIVER_WRITES).
      allow('parent', 'owner');
      if (d.release === 'hold') {
        if (n?.held === undefined || n.slot?.open || d.attempt !== n.slot?.attempt) errors.push('resume release requires a held node with no open slot and its last attempt');
        if (d.after !== undefined || d.expect !== undefined) errors.push('hold release does not take after or expect; dispatch a new attempt first');
      } else if (n && !n.slot?.open) errors.push(`resume requires an open slot of ${d.node}; ${d.node} has none`);
      else slot();
      if (d.after !== undefined && (typeof d.after !== 'string' && (!Array.isArray(d.after) || !d.after.length || d.after.some(x => typeof x !== 'string')))) errors.push('resume after must be a node string or a non-empty string array');
      else for (const id of afterNodes(d.after)) {
        if (!nodeSpec(s, id)) errors.push(`resume after names an unknown node: ${id}`);
        else if (id === d.node) errors.push('resume after must name another node, not the node itself');
      }
      if (d.expect !== undefined && d.expect !== 'report') errors.push('resume expect must be report');
      if (d.batch !== undefined) errors.push(...resumeBatchErrors(s,d));
      if (d.note !== undefined && typeof d.note !== 'string') errors.push('resume note must be a string');
      if (d.remeasure !== undefined && (d.remeasure !== true || d.release === 'hold')) errors.push('resume remeasure must be true and only on an open slot');
      break;
    case 'halt':
      allow('parent'); slot();
      if (typeof d.reason !== 'string' || !d.reason.trim()) errors.push('halt requires a reason');
      if (d.needs !== 'human' && d.needs !== 'owner') errors.push('halt needs must be human or owner');
      break;
    case 'decoy-commit':
      allow('owner');
      if (typeof d.digest !== 'string' || !/^[0-9a-f]{64}$/.test(d.digest)) errors.push('decoy-commit digest must be 64 lowercase hex characters (sha256)');
      else if (s.decoyCommits.some(c => c.digest === d.digest)) errors.push('decoy-commit digest was already committed');
      break;
    case 'decoy-reveal': {
      allow('owner');
      const shape = decoyPayloadErrors(d);
      errors.push(...shape);
      if (shape.length) break;
      const c = s.decoyCommits.find(c => c.digest === decoyDigest(d) && c.revealed === undefined);
      if (!c) { errors.push('decoy-reveal does not hash to an unrevealed decoy-commit'); break; }
      for (const x of d.decoys) {
        if (!s.nodes[x.node]) errors.push(`decoy node ${x.node} does not exist`);
        const first = context(s).entries.find(e => e.kind === 'dispatch' && e.node === x.node);
        if (first && first.seq < c.seq) errors.push(`decoy-commit #${c.seq} was made after node ${x.node} was first dispatched (#${first.seq})`);
      }
      break;
    }
  }
  return errors;
}

/**
 * N1.2: a submit by executor:owed is a carry: `carry` names the latest submit of the open attempt, which has the same
 * commit and base; the slot is open, the node has no current candidate, and the slot base is that submit's base (no
 * rebase since). The checks of a normal submit (required and manual keys, base) apply as well.
 */
function carryErrors(s: State, d: Extract<Draft, { kind: 'submit' }>, n: NodeState | undefined): string[] {
  if (d.carry === undefined) return ['a submit by executor:owed must carry a submit (carry: <seq>)'];
  const errors: string[] = [], slot = n?.slot;
  const latest = slot ? context(s).entries.findLast((e): e is Extract<Entry, { kind: 'submit' }> => e.kind === 'submit' && e.node === d.node && e.attempt === slot.attempt && e.seq > slot.dispatchSeq) : undefined;
  if (!Number.isInteger(d.carry) || !latest || d.carry !== latest.seq) errors.push(`carry must name the latest submit of the open attempt${latest ? ` (#${latest.seq})` : ''}`);
  else {
    if (latest.facts.commit !== d.facts.commit) errors.push(`carry submit commit must be the commit of submit #${latest.seq}`);
    if (latest.facts.base !== d.facts.base) errors.push(`carry submit base must be the base of submit #${latest.seq}`);
    if (slot!.base !== latest.facts.base) errors.push(`slot base moved since submit #${latest.seq} (a rebase); nothing to carry`);
  }
  if (!slot?.open) errors.push('carry requires an open slot');
  if (n?.candidate) errors.push(`carry requires no current candidate; #${n.candidate.seq} is current`);
  return errors;
}
/**
 * E4: `rulings` on a launch or repair send = the highest in-scope ruling seq the message carried: an integer, at most
 * the entry's own seq, and 0 (carried none) or the seq of a recorded ruling covering the node.
 */
function carriedErrors(s: State, d: Draft & { node: string; rulings?: number }, what: string): string[] {
  const own = 'seq' in d && typeof d.seq === 'number' ? d.seq : s.seq + 1, v = d.rulings;
  if (!Number.isInteger(v) || v! < 0 || v! > own || (v !== 0 && !s.rules.some(r => r.seq === v && (r.nodes === '*' || r.nodes.includes(d.node)))))
    return [`${what} rulings must be 0 or the seq of a ruling covering ${d.node} recorded before this entry`];
  return [];
}

// ---------- escapes and decoys ----------
/** PO2: batch members are contiguous, same actor/options, and name distinct nodes. */
function resumeBatchErrors(s: State, d: Extract<Draft,{kind:'resume'}>): string[] {
  const own = 'seq' in d && typeof d.seq === 'number' ? d.seq : s.seq+1, first = d.batch!;
  if (!Number.isSafeInteger(first) || first < 0 || first > own) return ['resume batch must reference its first resume seq'];
  if (first === own) return [];
  const members = entriesOf(s).filter(e => e.seq >= first);
  const same = (e: Entry): boolean => e.kind === 'resume' && e.batch === first && e.by === d.by && e.channel === d.channel && canonical(e.after) === canonical(d.after) && e.expect === d.expect && e.note === d.note && e.node !== d.node;
  return members[0]?.seq === first && members.length === own-first && members.every(same) ? [] : ['resume batch must follow contiguous resumes with the same actor and options and distinct nodes'];
}

/** Fields every entry may carry (assigned by the ledger or common to drafts). */
const ENTRY_BASE_FIELDS: readonly string[] = ['kind', 'by', 'channel', 'seq', 'ts', 'prev', 'hash', 'decision'];
/** The only kind-specific fields accepted on these entries; anything else is refused. */
const STRICT_FIELDS: Record<'escape' | 'decoy-commit' | 'decoy-reveal' | 'adopt' | 'launch' | 'send' | 'halt' | 'evidence' | 'resume' | 'sweep', readonly string[]> = { sweep: ['commit', 'key', 'verdict', 'counts', 'log', 'failed', 'bisect', 'boundary'], resume: ['node', 'attempt', 'after', 'expect', 'note', 'release', 'batch', 'remeasure'], evidence: ['node', 'attempt', 'key', 'merge', 'id', 'files', 'note'], escape: ['node', 'merge', 'class', 'note', 'evidence', 'sweep'], 'decoy-commit': ['digest'], 'decoy-reveal': ['nonce', 'decoys'], adopt: ['trunk', 'prior', 'commit', 'state', 'changed', 'commits', 'note'], launch: ['node', 'attempt', 'role', 'rid', 'spec', 'labels', 'rulings'], send: ['node', 'attempt', 'rid', 'send', 'sendKind', 'message', 'reason', 'rulings'], halt: ['node', 'attempt', 'reason', 'needs'] };
/** RC (0.27): fields interpreted on kinds that do not share the rule/obs/strict field checks. */
const OTHER_FIELDS: Record<string, readonly string[]> = {
  genesis: ['trunk', 'commit', 'plan', 'writes_syntax', 'state', 'path'],
  refresh: ['commit', 'state'],
  plan: ['prior', 'plan', 'writes_syntax', 'downgrades', 'rev', 'path', 'note'],
  dispatch: ['node', 'attempt', 'base', 'branch', 'worktree', 'packet', 'rulings_seen', 'overlaps'],
  submit: ['node', 'attempt', 'facts', 'carry', 'model'],
  grant: ['node', 'attempt', 'commit', 'paths', 'allowance'],
  review: ['node', 'attempt', 'obligation', 'key', 'verdict', 'rank', 'note', 'ack_rulings', 'needs', 'model'],
  waive: ['node', 'obligation', 'key', 'reason', 'accept_risk', 'tracked_by'],
  defer: ['node', 'items', 'reason', 'allowance'],
  abandon: ['node', 'attempt', 'reason'],
  hold: ['node', 'abandon', 'reason'],
  rebase: ['node', 'attempt', 'base', 'from'],
  merge: ['node', 'attempt', 'prior', 'commit', 'facts', 'state', 'batch', 'lease_wait_ms'],
  note: ['text'],
};
/** One error for the entire list; absent metadata keeps historical validation unchanged. */
function ignorableError(e: { ignorable?: unknown }): string | undefined {
  const names = e.ignorable;
  if (names === undefined) return undefined;
  if (!Array.isArray(names) || !names.length || Array.from(names).some(n => typeof n !== 'string' || !n)) return 'ignorable must be a non-empty array of field names';
  if (names.some((n, i) => i > 0 && names[i - 1] >= n)) return 'ignorable names must be sorted and unique';
  if (names.some(n => ENTRY_BASE_FIELDS.includes(n) || n === 'ignorable')) return 'ignorable must not list base fields or itself';
  const fields = e as Record<string, unknown>;
  if (names.some(n => !Object.hasOwn(fields, n) || fields[n] === undefined)) return 'ignorable names must reference present fields with defined values';
  return undefined;
}
/**
 * Remove only unknown listed fields before any semantic read (including generic `node in entry` checks). Known
 * fields still undergo ordinary validation and interpretation. Raw ledger bytes and their hashes are never changed.
 */
export function interpretedEntry<T extends Draft | Entry>(e: T): T {
  if (e.ignorable === undefined) return e;
  const fields = e.kind === 'rule' ? RULE_FIELDS : e.kind === 'obs' ? OBS_FIELDS : Object.hasOwn(STRICT_FIELDS, e.kind) ? STRICT_FIELDS[e.kind as keyof typeof STRICT_FIELDS] : Object.hasOwn(OTHER_FIELDS, e.kind) ? OTHER_FIELDS[e.kind]! : [];
  const interpreted = { ...e } as T & Record<string, unknown>;
  for (const name of e.ignorable) if (!ENTRY_BASE_FIELDS.includes(name) && !fields.includes(name)) delete interpreted[name];
  delete interpreted.ignorable;
  return interpreted;
}
/**
 * Validation of a D23 `evidence` entry: shape, role (owner/parent/reviewer), then the mode. With `merge` it is a receipt
 * of a merged node (merge = seq of its latest merge; no attempt/key; files may be empty). Otherwise it is evidence on
 * the open candidate: the current attempt and `evidence:<id>` key, a declared id, the role the plan requires (or the
 * owner), not a writer of the node, and at least one file.
 */
function evidenceErrors(d: Extract<Draft, { kind: 'evidence' }>, n: NodeState | undefined, spec: NodeSpec | undefined): string[] {
  const errors: string[] = [], r = role(d.by);
  if (!['owner', 'parent', 'reviewer'].includes(r)) errors.push('evidence insufficient permissions; requires owner/parent/reviewer');
  if (typeof d.id !== 'string' || !EVIDENCE_ID.test(d.id)) errors.push(`evidence id must match ${EVIDENCE_ID.source}`);
  if (typeof d.note !== 'string' || !d.note.trim()) errors.push('evidence requires a note');
  if (!Array.isArray(d.files) || d.files.some(f => !f || typeof f !== 'object' || Object.keys(f).sort().join() !== 'bytes,path,sha256' || typeof f.path !== 'string' || !f.path || typeof f.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(f.sha256) || !Number.isInteger(f.bytes) || f.bytes < 0)) errors.push('evidence files must be a list of {path, sha256 (64 lowercase hex), bytes}');
  if (!n || !spec) return errors;
  if (d.merge !== undefined) {
    if (d.attempt !== undefined || d.key !== undefined) errors.push('an evidence receipt carries merge only, no attempt or key');
    if (!n.merged) errors.push(`evidence receipt requires a merged node; ${d.node} is not merged`);
    else if (d.merge !== n.merged.seq) errors.push(`evidence receipt merge must be #${n.merged.seq}, the latest merge of ${d.node}`);
    return errors;
  }
  if (!n.slot?.open || !n.candidate) return [...errors, n.merged ? `node ${d.node} is merged: record a receipt (merge #${n.merged.seq})` : `evidence requires an open candidate of ${d.node}, or a merged node for a receipt`];
  if (d.attempt !== n.slot.attempt) errors.push('attempt must match the current open writer slot');
  const ev = spec.evidence?.find(x => x.id === d.id);
  if (!ev) errors.push(`node ${d.node} has no evidence obligation ${d.id}`);
  else {
    if (!d.key || d.key !== n.candidate.keys[`evidence:${d.id}`]) errors.push(`evidence:${d.id} must reference the current candidate obligation key`);
    if (r !== ev.by && r !== 'owner') errors.push(`evidence:${d.id} requires ${ev.by} (or owner)`);
  }
  if (isWriter(n, d.by)) errors.push('evidence must not be recorded by a writer of any attempt of this node');
  if (Array.isArray(d.files) && !d.files.length) errors.push('evidence on a candidate requires at least one file');
  return errors;
}
export const ESCAPE_CLASSES: readonly EscapeClass[] = ['missing', 'false-pass', 'reuse', 'weak', 'waiver'];
/** sha256 hex of the canonical JSON of exactly {nonce, decoys:[{node, defect}]}; other fields are ignored. */
export function decoyDigest(p: DecoyPayload): string {
  return sha256(canonical({ nonce: p.nonce, decoys: p.decoys.map(x => ({ node: x.node, defect: x.defect })) }));
}
/** Shape errors of a reveal payload (it may come from an untrusted JSON file). */
export function decoyPayloadErrors(p: unknown): string[] {
  const errors: string[] = [];
  const v = p as Partial<DecoyPayload> | null;
  if (!v || typeof v !== 'object') return ['decoy payload must be a JSON object {nonce, decoys}'];
  if (typeof v.nonce !== 'string' || v.nonce.length < 16) errors.push('decoy nonce must be a string of at least 16 characters');
  if (!Array.isArray(v.decoys) || !v.decoys.length) return [...errors, 'decoys must be a non-empty list of {node, defect}'];
  const seen = new Set<string>();
  for (const x of v.decoys as unknown[]) {
    const d = x as Partial<{ node: unknown; defect: unknown }> | null;
    if (!d || typeof d !== 'object' || Object.keys(d).sort().join() !== 'defect,node' || typeof d.node !== 'string' || !d.node || typeof d.defect !== 'string' || !d.defect.trim()) { errors.push('each decoy must be exactly {node, defect} with non-empty text'); continue; }
    if (seen.has(d.node)) errors.push(`decoy node ${d.node} is listed twice`);
    seen.add(d.node);
  }
  return errors;
}
/**
 * A pending decoy is caught by an execution failure or review block on its node, or by a failing
 * obs appended while merging it (`merging`) on an item that was not already debt on PRE
 * (`mergeCatches`, computed at append time); it escapes on a merge of it.
 */
function settleDecoy(v: DecoyView, e: Entry, mergeCatches: Set<number>): void {
  if (v.outcome !== 'pending') return;
  if ((e.kind === 'obs' && e.probe === undefined && e.by === 'executor:owed' && e.verdict === 'fail' && ((e.subject === v.node && e.batch === undefined) || (e.merging === v.node && mergeCatches.has(e.seq)))) || (e.kind === 'review' && e.node === v.node && e.verdict === 'block')) Object.assign(v, { outcome: 'caught', decidedBy: e.seq });
  else if (e.kind === 'merge' && e.node === v.node) Object.assign(v, { outcome: 'escaped', decidedBy: e.seq });
}

function job(spec: NodeSpec | undefined, subject: string, obligation: string, key: string, commit: string, base: string, plan: Plan): AttestJob | undefined {
  if (obligation === 'writes') return { kind: 'writes', subject, obligation, key, commit, base };
  const colon = obligation.indexOf(':'), kind = obligation.slice(0, colon), id = obligation.slice(colon + 1);
  if (kind !== 'check' && kind !== 'red' && kind !== 'strength' && kind !== 'inv') return undefined;
  const check = (kind === 'inv' ? plan.invariants : spec?.checks)?.find(c => c.id === id && (kind !== 'strength' || !!c.mutants));
  return check ? { kind, subject, obligation, key, spec: structuredClone(check), commit, base } : undefined;
}
export function attestJobs(s: State, id: string): AttestJob[] {
  const n = s.nodes[id];
  if (!n) throw new OwedError(`Node ${id} does not exist`);
  const jobs: AttestJob[] = [];
  const seen = new Set<string>();
  for (const b of n.blocks) if (b.kind === 'exec' && b.state === 'active') {
    const e = listed(context(s).bySeq, b.seq).find((e): e is ObsEntry => e.kind === 'obs' && e.seq === b.seq);
    if (!e || e.waits_on) continue;
    const token = `${b.obligation}\0${b.key}`;
    if (seen.has(token)) continue;
    seen.add(token);
    const plan = obsPlan(context(s), b.seq)!;
    const j = job(plan.nodes.find(x => x.id === id), id, b.obligation, b.key, e.commit, e.base ?? e.commit, plan);
    if (j) jobs.push(quarantinedJob(s, { ...j, attribution: true }));
  }
  if (n.candidate && n.slot?.open) for (const o of required(s.plan, nodeSpec(s, id)!, n.candidate)) {
    const key = n.candidate.keys[o];
    const retry = o === 'writes' ? writesWaiting(s,id) : undefined;
    const due = retry && retry.waits_on!.every(owner => !s.nodes[owner]?.slot?.open);
    // IF3: the advertised decide --remeasure also retries a current-key setup failure whose attribution cleared its block.
    const resume = resumeOf(s,id), last = key && observations(s,id,o,key).at(-1);
    const setupRetry = resume?.remeasure && last && last.seq < resume.seq && setupFailure(s,last);
    if (!key || hasVerdict(s, id, o, key) && !due && !setupRetry) continue;
    const j = job(nodeSpec(s, id), id, o, key, n.candidate.commit, n.slot.base, s.plan);
    if (j) jobs.push(quarantinedJob(s, j));
  }
  return jobs;
}
/** IR1: Git-computed current-plan keys that differ from the recorded trunk keys. */
export function refreshChanged(s: State, facts: StateFacts): string[] {
  return s.plan.invariants.filter(i => facts.invKeys[i.id] !== s.trunk.invKeys[i.id]).map(i => i.id);
}
/** IR1: refresh jobs still lacking a trunk observation (also resumes an interrupted refresh). */
export function trunkJobs(s: State): AttestJob[] {
  return s.plan.invariants.flatMap(i => {
    const key = s.trunk.invKeys[i.id], red = context(s).invRed?.get(`inv:${i.id}`);
    if (!key || red?.kind !== 'refresh' || red.key !== key || !listed(context(s).bySeq, red.seq).some(e => e.kind === 'refresh' && e.commit === s.trunk.commit) || counted(s, 'trunk', `inv:${i.id}`, key).some(e => e.commit === s.trunk.commit && e.verdict !== 'error')) return [];
    return [quarantinedJob(s, job(undefined, 'trunk', `inv:${i.id}`, key, s.trunk.commit, s.trunk.commit, s.plan)!)];
  });
}
export function genesisJobs(s: State): AttestJob[] {
  const g = context(s).genesis;
  if (!g) return [];
  return s.plan.invariants.flatMap(i => {
    const key = g.state.invKeys[i.id];
    if (!key || hasVerdict(s, 'trunk', `inv:${i.id}`, key)) return [];
    return [quarantinedJob(s, job(undefined, 'trunk', `inv:${i.id}`, key, g.commit, g.commit, s.plan)!)];
  });
}
/**
 * Genesis items (D24): invariants of the current plan that have a genesis key. `observed` have a non-error executor
 * observation at that key (`failed` among them have a failing one); `pending` still lack one.
 */
export function genesisProgress(s: State): { ids: string[]; observed: string[]; failed: string[]; pending: string[] } {
  const g = context(s).genesis;
  const ids = g ? s.plan.invariants.filter(i => !!g.state.invKeys[i.id]).map(i => i.id) : [];
  const at = (id: string) => {
    const obs = observations(s, 'trunk', `inv:${id}`, g!.state.invKeys[id]!);
    const resolved = resolvedSetupFailures(s,obs);
    return obs.filter(e => !resolved.has(e.seq));
  };
  const observed = ids.filter(id => at(id).some(e => e.verdict !== 'error'));
  return { ids, observed, failed: observed.filter(id => at(id).some(e => e.verdict === 'fail')), pending: ids.filter(id => !observed.includes(id)) };
}
/**
 * Whether an observation of `j` is still about a current item (D24.1): a trunk job while its key is the genesis key
 * or the current trunk key of an invariant of the plan; a node job while the node's open candidate has that key for
 * the obligation, or (attribution rerun) while an active execution block has that obligation, key, commit and base.
 */
export function jobCurrent(s: State, j: AttestJob): boolean {
  if (j.subject === 'trunk') {
    const id = j.obligation.slice(4);
    if (!j.obligation.startsWith('inv:') || !s.plan.invariants.some(i => i.id === id)) return false;
    return context(s).genesis?.state.invKeys[id] === j.key || s.trunk.invKeys[id] === j.key;
  }
  const n = s.nodes[j.subject];
  if (!n || !nodeSpec(s, j.subject)) return false;
  // An attribution rerun is current only for an active block whose failing obs has the job's key, commit and base (the
  // condition validateDraft applies), so a block replaced by one on another commit supersedes it instead of refusing.
  if (j.attribution) return n.blocks.some(b => b.kind === 'exec' && b.state === 'active' && b.obligation === j.obligation && b.key === j.key && listed(context(s).bySeq, b.seq).some(e => e.kind === 'obs' && e.seq === b.seq && e.commit === j.commit && e.base === j.base));
  return !!n.slot?.open && !!n.candidate && n.candidate.keys[j.obligation] === j.key;
}
export function mergeJobs(s: State, id: string, m: { facts: CandidateFacts; state: StateFacts }): AttestJob[] { return inBatchScope('', () => scopedMergeJobs(s, id, m)); }
function scopedMergeJobs(s: State, id: string, m: { facts: CandidateFacts; state: StateFacts }): AttestJob[] {
  const spec = nodeSpec(s, id);
  if (!spec || !s.nodes[id]?.candidate) throw new OwedError(`Node ${id} has no current candidate`);
  const jobs: AttestJob[] = [];
  for (const c of spec.checks) {
    const o = `check:${c.id}`, key = m.facts.keys[o];
    if (key && !hasVerdict(s, id, o, key)) jobs.push(quarantinedJob(s, job(spec, id, o, key, m.facts.commit, m.facts.base, s.plan)!, id));
  }
  for (const i of s.plan.invariants) {
    const key = m.state.invKeys[i.id];
    if (key && !hasVerdict(s, 'trunk', `inv:${i.id}`, key)) jobs.push(quarantinedJob(s, job(undefined, 'trunk', `inv:${i.id}`, key, m.state.commit, m.state.commit, s.plan)!, id));
  }
  return jobs;
}
/** MS4 for a batch: quarantine names on the batch tree count every member as merged. */
export function batchQuarantine(s: State, members: string[]): QuarantineNames { return quarantineNames(s.plan, id => !!s.nodes[id]?.merged || members.includes(id)); }
/**
 * MT2: jobs of a batch merge on its final tree `final` (state facts `st`): every member's node checks on its keys there
 * (`keys[member]`) and every invariant on `st`, skipping keys that already have a verdict.
 */
export function batchJobs(s: State, members: string[], keys: Record<string, Record<string, string>>, st: StateFacts): AttestJob[] { return inBatchScope(members.join('\0'), () => scopedBatchJobs(s, members, keys, st)); }
function scopedBatchJobs(s: State, members: string[], keys: Record<string, Record<string, string>>, st: StateFacts): AttestJob[] {
  const merged = (id: string): boolean => !!s.nodes[id]?.merged || members.includes(id), jobs: AttestJob[] = [];
  const q = (j: AttestJob): AttestJob => { const e = j.spec ? activeQuarantine(s.plan, j.spec, merged) : []; return e.length ? { ...j, quarantined: e } : j; };
  for (const id of members) {
    const spec = nodeSpec(s, id);
    if (!spec || !s.nodes[id]?.candidate) throw new OwedError(`Node ${id} has no current candidate`);
    for (const c of spec.checks) {
      const o = `check:${c.id}`, key = keys[id]?.[o];
      if (key && !hasVerdict(s, id, o, key)) jobs.push(q(job(spec, id, o, key, st.commit, st.commit, s.plan)!));
    }
  }
  for (const i of s.plan.invariants) {
    const key = st.invKeys[i.id];
    if (key && !hasVerdict(s, 'trunk', `inv:${i.id}`, key)) jobs.push(q(job(undefined, 'trunk', `inv:${i.id}`, key, st.commit, st.commit, s.plan)!));
  }
  return jobs;
}
/** MS1: whether an item still fails on its key: its latest verdict failed, or (repeat) its pooled runs fail. */
function remeasureWanted(s: State, subject: string, obligation: string, key: string): boolean {
  const obs = counted(s, subject, obligation, key);
  return obs.findLast(e => e.verdict !== 'error')?.verdict === 'fail' || pooledRuns(s, subject, obligation, obs)?.pass === false;
}
/**
 * MS1: remeasure jobs of node `id` on its merge facts `m`: every invariant whose latest observation on the merge key
 * failed or whose pooled repeat runs fail (`all`: every invariant), measured again on the merge commit and recorded on the same key.
 */
export function remeasureJobs(s: State, id: string, m: { facts: CandidateFacts; state: StateFacts }, all = false): AttestJob[] {
  if (!s.nodes[id]?.candidate) throw new OwedError(`Node ${id} has no current candidate`);
  return s.plan.invariants.flatMap(i => {
    const key = m.state.invKeys[i.id], o = `inv:${i.id}`;
    if (!key || !(all || remeasureWanted(s, 'trunk', o, key))) return [];
    return [quarantinedJob(s, job(undefined, 'trunk', o, key, m.state.commit, m.state.commit, s.plan)!, id)];
  });
}
/** MS1: `attest --trunk --remeasure`: current trunk invariant keys whose latest trunk observation failed (`all`: every one). */
export function trunkRemeasureJobs(s: State, all = false): AttestJob[] {
  return s.plan.invariants.flatMap(i => {
    const key = s.trunk.invKeys[i.id], o = `inv:${i.id}`;
    if (!key || !(all || remeasureWanted(s, 'trunk', o, key))) return [];
    return [quarantinedJob(s, job(undefined, 'trunk', o, key, s.trunk.commit, s.trunk.commit, s.plan)!)];
  });
}
/**
 * MS2: the resume (with `remeasure`) whose remeasure the driver still owes on node `id`: the latest resume of the open
 * attempt asks for it and no merge-tree observation of the node and no driver halt was recorded after it.
 */
export function remeasureDue(s: State, id: string): ResumeEntry | undefined {
  const r = resumeOf(s, id);
  if (!r?.remeasure) return undefined;
  return context(s).entries.some(e => e.seq > r.seq && ((e.kind === 'obs' && e.merging === id) || (e.kind === 'halt' && e.node === id))) ? undefined : r;
}
/** Invariants of the plan whose key on the adopted state `st` lacks a verdict (key changed relative to the trunk, as for merge). */
export function adoptJobs(s: State, st: StateFacts): AttestJob[] {
  return s.plan.invariants.flatMap(i => {
    const key = st.invKeys[i.id];
    if (!key || key === s.trunk.invKeys[i.id] || hasVerdict(s, 'trunk', `inv:${i.id}`, key)) return [];
    return [quarantinedJob(s, job(undefined, 'trunk', `inv:${i.id}`, key, st.commit, st.commit, s.plan)!)];
  });
}
export interface AdoptGuard { ok: boolean; reasons: string[]; failed: string[]; invItems: ItemView[] }
/**
 * No new debt for an adoption (SPEC §6.6): an invariant whose key changed on the adopted state must be satisfied
 * (E or known-red W) there when it was satisfied on trunk; existing D debt (failing, ⊥, deferred, ⊤) does not block.
 */
export function adoptGuard(s: State, st: StateFacts): AdoptGuard {
  const reasons: string[] = [], failed: string[] = [];
  const invItems = s.plan.invariants.map(i => {
    const key = st.invKeys[i.id] ?? '', o = `inv:${i.id}`;
    const v = item(s, 'trunk', o, key);
    if (!key) reasons.push(`invariant ${i.id} missing adopt obligation key`);
    else if (automaticInvariantConflict(s,o,key)) {
      failed.push(i.id);
      reasons.push(`invariant ${i.id} owner conflict: ${v.detail}; fix the invariant before adopt`);
    }
    else if (key !== s.trunk.invKeys[i.id] && v.status === 'D' && item(s, 'trunk', o, s.trunk.invKeys[i.id] ?? '').status !== 'D') {
      failed.push(i.id);
      reasons.push(`invariant ${i.id} new debt: satisfied on the current trunk but not on the adopted commit (${v.detail})`);
    }
    return v;
  });
  if (!s.genesisDone) reasons.push('genesis invariant initial observations are incomplete');
  return { ok: reasons.length === 0, reasons, failed, invItems };
}
/** IR2: a named test failure, not a timeout, error, zero/unknown count or min_tests failure. */
export function testOnlyFailure(e: ObsEntry): boolean {
  const only = (r: Pick<ObsEntry, 'verdict' | 'exit' | 'failed' | 'counts' | 'execution'>): boolean => {
    const c = r.counts;
    return r.verdict === 'fail' && !!r.failed?.length && r.exit !== null && ![126, 127, 124, 137, 143].includes(r.exit)
      && r.execution?.completed === true && r.execution.countOK === true
      && !!c && (c.tests ?? 0) > 0 && (c.fail ?? 0) > 0 && (r.exit !== 0 || c.format === 'owed');
  };
  return only(e) && (!e.runs || e.runs.every(r => r.verdict === 'pass' || only(r)));
}
/** IR2: counts prove every failing name was retained; repeated runs need complete per-run lists and union. */
export function failedNamesComplete(e: ObsEntry): boolean {
  const complete = (r: Pick<ObsEntry, 'failed' | 'counts'>): boolean => !!r.failed?.length && r.counts?.fail === r.failed.length;
  if (!e.runs) return complete(e);
  const failures = e.runs.filter(r => r.verdict === 'fail');
  if (!failures.length || !failures.every(complete)) return false;
  const union = new Set(failures.flatMap(r => r.failed!));
  return union.size === e.failed?.length && e.failed.every(name => union.has(name));
}
/** RO ruling #2097: an automatic same-key conflict is negative evidence, never an inherited pass. */
function automaticInvariantConflict(s: State, obligation: string, key: string): boolean {
  const obs = counted(s,'trunk',obligation,key);
  return !s.plan.invariants.find(i => `inv:${i.id}` === obligation)?.repeat && obs.some(e => e.auto_remeasure) && obs.some(e => e.verdict === 'pass') && obs.some(e => e.verdict === 'fail');
}
function decidingInvariantFail(s: State, obligation: string, key: string, commit?: string): ObsEntry | undefined {
  const obs = counted(s, 'trunk', obligation, key);
  if (obs.some(e => e.verdict === 'pass') && !automaticInvariantConflict(s,obligation,key)) return undefined;
  return obs.findLast(e => e.verdict === 'fail' && (commit === undefined || e.commit === commit));
}
/** IR2/KR3: fix-owned names are not inheritable trunk debt when their fixing node merges. */
export function invariantTrunkComparison(s: State, merging: string, inv: CheckSpec, key: string, commit: string): { inherited: boolean; trunk?: ObsEntry; merge?: ObsEntry; trunkNames: string[]; newNames: string[]; truncated: boolean } {
  const open = batchScope ? openBatch(s) : undefined;
  const first = open && context(s).entries.find(e => e.kind === 'merge' && e.batch?.final === open.batch!.final && e.node === open.batch!.members[0]) as Extract<Entry,{kind:'merge'}> | undefined;
  const origin = first && context(s).entries.findLast(e => 'state' in e && e.state.commit === first.prior && e.seq < first.seq);
  // Every member compares inherited debt with the trunk before the train, never an unmeasured Mi.
  const trunkState = origin && 'state' in origin ? origin.state : s.trunk;
  const o = `inv:${inv.id}`, oldKey = trunkState.invKeys[inv.id] ?? '';
  const trunk = inBatchScope(undefined, () => decidingInvariantFail(s, o, oldKey, trunkState.commit)), merge = decidingInvariantFail(s, o, key);
  const owned = fixOwnedKnownRed(s, inv.id, merging);
  const trunkNames = (trunk?.failed ?? []).filter(name => !owned.includes(name)), names = merge?.failed ?? [];
  const newNames = names.filter(name => !trunkNames.includes(name));
  const truncated = !!trunk?.failed?.length && !failedNamesComplete(trunk) || !!merge?.failed?.length && !failedNamesComplete(merge);
  return { trunk, merge, trunkNames, newNames, truncated, inherited: key !== oldKey && inBatchScope(undefined, () => item(s, 'trunk', o, oldKey)).mark === '✘' && !!trunk && !!merge && failedNamesComplete(trunk) && failedNamesComplete(merge) && testOnlyFailure(merge) && !newNames.length };
}
function invariantDebtReason(id: string, r: ReturnType<typeof invariantTrunkComparison>): string {
  return r.truncated ? `invariant ${id} new debt: failed names truncated; cannot prove the failure is old`
    : r.trunkNames.length && r.merge?.failed?.length && r.newNames.length
    ? `invariant ${id} new debt: new failures ${r.newNames.join(', ')} (trunk already failed: ${r.trunkNames.join(', ')})`
    : `invariant ${id} new debt: requires a measured pass on the merge key or owner defer for this node`;
}
function invariantRedText(s: State, obligation: string, red: { kind: 'merge' | 'refresh'; seq: number }, fail: ObsEntry): string {
  return `${obligation} red on trunk since ${red.kind} #${red.seq} (${fail.failed?.join(', ') || 'unknown failed tests'}); not caused by any open node. Options: assign a fix node (plan), list the names as known_red with that fix node (owed edit --invariant ${obligation.slice(4)} ...), or owed sweep --commit ${s.trunk.commit} to find the culprit`;
}
/** IR3: parent diagnostics, separate from the retained trunk-red merge detail. */
export function trunkInvariantReds(s: State): { obligation: string; key: string; text: string }[] {
  return s.invariants.flatMap(i => {
    const red = context(s).invRed?.get(i.obligation), fail = decidingInvariantFail(s, i.obligation, i.key);
    return i.status === 'D' && i.discharger === 'parent' && red?.key === i.key && fail ? [{ obligation: i.obligation, key: i.key, text: invariantRedText(s, i.obligation, red, fail) }] : [];
  });
}
/**
 * AT5 (derived, no entry): the latest owner defer of `inv` by `node` in its open attempt on another merge key, and
 * whether it carries to merge key `key`: the deferred merge-tree failure was trunk-own (its names failed on trunk before
 * the defer), and now the merge tree fails only those names while current trunk still fails each of them with the same
 * error signature. Fail-closed: the deferred, trunk and current observations must each be a complete, named,
 * test-only failure (`testOnlyFailure`, `failedNamesComplete`), the current one must meet `min_tests`, and every name
 * needs the same recorded signature (0.20 field) on all three; a ledger without signatures never carries.
 */
export function carriedDefer(s: State, node: string, inv: string, key: string): { defer: State['deferred'][number]; carried: boolean } | undefined {
  const o = `inv:${inv}`, n = s.nodes[node];
  const defer = s.deferred.findLast(d => d.node === node && d.id === inv && d.key !== key && d.seq > (n?.slot?.dispatchSeq ?? Infinity));
  if (!defer) return undefined;
  const deferred = decidingInvariantFail(s, o, defer.key), now = decidingInvariantFail(s, o, key);
  const before = context(s).entries.findLast((e): e is ObsEntry => e.kind === 'obs' && e.by === 'executor:owed' && e.subject === 'trunk' && e.merging === undefined && e.batch === undefined && e.probe === undefined && e.obligation === o && e.verdict === 'fail' && e.seq < defer.seq);
  const trunkKey = s.trunk.invKeys[inv], trunk = trunkKey ? decidingInvariantFail(s, o, trunkKey) : undefined;
  const minTests = s.plan.invariants.find(i => i.id === inv)?.min_tests;
  // Fail-closed (AT ruling #1924): only complete, named, test-only failures with recorded equal signatures carry.
  const sound = (e: ObsEntry | undefined): e is ObsEntry => !!e && testOnlyFailure(e) && failedNamesComplete(e);
  const names = now?.failed ?? [];
  const carried = sound(deferred) && sound(trunk) && sound(now) && !!before && names.length > 0
    && (minTests === undefined || (now.counts?.tests ?? 0) >= minTests)
    && names.every(name => {
      const sig = deferred.signatures?.[name];
      return sig !== undefined && deferred.failed!.includes(name) && before.failed?.includes(name) === true && trunk.failed!.includes(name) && trunk.signatures?.[name] === sig && now.signatures?.[name] === sig;
    });
  return { defer, carried };
}
export function mergeGuard(s: State, id: string, m: { facts: CandidateFacts; state: StateFacts; batch?: MergeBatch }): MergeGuard {
  return inBatchScope(m.batch?.members.join('\0') ?? '', () => scopedMergeGuard(s, id, m));
}
function scopedMergeGuard(s: State, id: string, m: { facts: CandidateFacts; state: StateFacts; batch?: MergeBatch }): MergeGuard {
  const reasons: string[] = [];
  // MT3: a batch member's invariants and merge-tree checks are judged on the final batch tree Mn.
  const inv = m.batch?.state ?? m.state, checkKeys = m.batch?.keys[id] ?? m.facts.keys;
  const n = s.nodes[id], spec = nodeSpec(s, id);
  const nodeItemsOnMerge: ItemView[] = [];
  if (!n?.accepted) reasons.push(`Node ${id} current candidate is not yet accepted`);
  if (m.facts.base !== s.trunk.commit) reasons.push('writes merge facts base must be the current trunk');
  if (m.facts.commit !== m.state.commit || m.facts.tree !== m.state.tree) reasons.push('Merge facts commit/tree mismatch');
  if (n?.candidate && spec) {
    for (const o of required(s.plan, spec, n.candidate)) {
      const onMerge = o === 'writes' || o.startsWith('check:');
      const v = item(s, id, o, (o.startsWith('check:') ? checkKeys[o] : onMerge ? m.facts.keys[o] : n.candidate.keys[o]) ?? '');
      // CandidateFacts.changed is trusted git output for PRE..M. Unlike command
      // checks, writes can be re-evaluated synchronously without an executor job.
      if (o === 'writes' && m.facts.keys.writes) {
        if (m.facts.changed.some(p => !withinWrites(s, id, p))) Object.assign(v, { status: 'D', mark: '✘', discharger: 'writer', detail: `writes merge changes exceed allowed paths${grantHint(s, id, m.facts.changed) ? `\n${grantHint(s, id, m.facts.changed)}` : ''}` });
        else if (v.mark === '⊥') Object.assign(v, { status: 'E', mark: '✔', discharger: undefined, detail: 'writes merge changes rechecked against allowed paths' });
      }
      nodeItemsOnMerge.push(v);
      if (v.status === 'D') reasons.push(`${id} obligation ${o} unsatisfied:${v.detail}`);
    }
    if (n.blocks.some(b => binding(b, spec))) reasons.push(`${id} still has active blocks: ${n.blocks.filter(b => binding(b, spec)).map(b => `${b.obligation} #${b.seq}`).join(', ')}`);
  }
  const invItems = s.plan.invariants.map(i => {
    const key = inv.invKeys[i.id] ?? '';
    const v = item(s, 'trunk', `inv:${i.id}`, key, id);
    const owned = fixOwnedKnownRed(s, i.id, id), stillFail = [...new Set(counted(s, 'trunk', `inv:${i.id}`, key).filter(e => e.verdict === 'fail').flatMap(e => (e.failed ?? []).filter(name => owned.includes(name))))];
    if (stillFail.length) reasons.push(`${id} is the fix node of known-red ${stillFail.join(', ')} on inv:${i.id}, which still fail on the merge result`);
    else if (!key) reasons.push(`invariant ${i.id} missing merge obligation key`);
    else if ((key !== s.trunk.invKeys[i.id] || automaticInvariantConflict(s,`inv:${i.id}`,key)) && v.status === 'D') {
      const d = s.deferred.findLast(d => d.node === id && d.id === i.id && d.key === key && d.seq > (n?.slot?.dispatchSeq ?? Infinity));
      if (d) Object.assign(v, { status: 'D', mark: '⏸', discharger: 'owner', evidence: [...new Set([...v.evidence, d.seq])], detail: `inv:${i.id} ${d.allowance !== undefined ? deferLabel(d) : 'owner deferred'}, still debt` });
      else {
        const red = invariantTrunkComparison(s, id, i, key, inv.commit);
        if (automaticInvariantConflict(s,`inv:${i.id}`,key)) { reasons.push(`invariant ${i.id} owner conflict: ${v.detail}; fix the invariant or defer it for ${id}`); return v; }
        const carry = red.inherited ? undefined : carriedDefer(s, id, i.id, key);
        if (red.inherited) Object.assign(v, { discharger: 'parent', detail: `trunk-red: inv:${i.id} already failed on trunk before ${id} (${red.merge!.failed!.join(', ')}); merge #${s.seq + 1}` });
        else if (carry?.carried) Object.assign(v, { status: 'D', mark: '⏸', discharger: 'owner', evidence: [...new Set([...v.evidence, carry.defer.seq])], detail: `inv:${i.id} owner deferred, still debt; defer #${carry.defer.seq} carried (same trunk failure)` });
        else reasons.push(invariantDebtReason(i.id, red));
      }
    }
    return v;
  });
  if (!s.genesisDone) reasons.push('genesis invariant initial observations are incomplete');
  return { ok: reasons.length === 0, reasons, nodeItems: nodeItemsOnMerge, invItems };
}
