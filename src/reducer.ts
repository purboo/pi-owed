import { ZERO, canonical, sha256 } from './canon.ts';
import { OwedError } from './errors.ts';
import type { AttestJob, Block, CandidateFacts, DecoyPayload, DecoyView, Downgrade, Draft, Entry, EscapeClass, HaltEntry, ItemView, LaunchEntry, MergeGuard, NodeSpec, NodeState, ObsEntry, Plan, RunRole, SendKind, SendReason, State, StateFacts } from './types.ts';

export type PlanLookup = (sha: string) => Plan;
const history = Symbol('owed.reducer.history');
interface History { entries: Entry[]; plans: PlanLookup; genesis?: Extract<Entry, { kind: 'genesis' }>; obsPlans: Map<number, Plan>; mergeCatches: Set<number> }
type ReplayState = State & { [history]: History };
function context(state: State): History {
  const value = (state as ReplayState)[history];
  if (!value) throw new OwedError('State lacks replay metadata; use the state returned by reduce', 'internal');
  return value;
}
const active = (b: Block): boolean => b.state !== 'cleared';
/** Blocks that still bind the node: judgment blocks always; execution blocks only while their obligation exists (removing it is an owner-only, visible downgrade). */
const binding = (b: Block, spec: NodeSpec | undefined): boolean => active(b) && (b.kind === 'judgment' || !spec || spec.checks.some(c => b.obligation === `check:${c.id}` || (c.red && b.obligation === `red:${c.id}`) || (!!c.mutants && b.obligation === `strength:${c.id}`)) || b.obligation === 'writes');
const role = (by: string): string => by.split(':')[0] ?? '';
const blankPlan = (): Plan => ({ version: 1, trunk: '', closure: [], invariants: [], nodes: [] });
const emptyNode = (id: string): NodeState => ({ id, phase: 'blocked', items: [], blocks: [], accepted: false, dependents: 0, writers: [], runs: [] });
const nodeSpec = (s: State, id: string): NodeSpec | undefined => s.plan.nodes.find(n => n.id === id);
const observations = (s: State, subject: string, obligation: string, key: string): ObsEntry[] => context(s).entries.filter((e): e is ObsEntry => e.kind === 'obs' && e.by === 'executor:owed' && e.subject === subject && e.obligation === obligation && e.key === key);
const hasVerdict = (s: State, subject: string, obligation: string, key: string): boolean => observations(s, subject, obligation, key).some(e => e.verdict !== 'error');

function required(spec: NodeSpec, facts: CandidateFacts): string[] {
  return [...spec.checks.flatMap(c => [`check:${c.id}`, ...(c.red ? [`red:${c.id}`] : []), ...(c.mutants ? [`strength:${c.id}`] : [])]), 'writes', ...(facts.closureTouched ? ['closure-review'] : []), ...(spec.review.count > 0 ? ['review'] : []), 'rulings'];
}
function latestRule(s: State, node: string): number {
  return Math.max(-1, ...s.rules.filter(r => r.nodes === '*' || r.nodes.includes(node)).map(r => r.seq));
}
/** Two `writes` prefix lists overlap when some prefix of one starts with a prefix of the other (a path could match both). */
export const writesOverlap = (a: string[], b: string[]): boolean => a.some(p => b.some(q => p.startsWith(q) || q.startsWith(p)));
/** Other nodes with an open slot whose `writes` overlap those of node `id`, sorted. */
export function overlapping(s: State, id: string): string[] {
  const writes = nodeSpec(s, id)?.writes ?? [];
  return s.plan.nodes.filter(x => x.id !== id && s.nodes[x.id]?.slot?.open && writesOverlap(writes, x.writes)).map(x => x.id).sort();
}
/** Detail of a satisfied `rulings` item when no ruling is in scope for the node (shown as "no rulings apply"). */
export const NO_RULINGS = 'no ruling is in scope for this node';
function item(s: State, subject: string, obligation: string, key: string): ItemView {
  const node = s.nodes[subject];
  const spec = nodeSpec(s, subject);
  const blocks = node?.blocks.filter(b => b.obligation === obligation && active(b)) ?? [];
  const out: ItemView = { subject, obligation, key, status: 'D', mark: '⊥', discharger: 'executor', evidence: [], detail: `${obligation} awaiting observation` };
  if (!key) return { ...out, detail: `${obligation} missing fact key` };
  if (obligation === 'review' || obligation === 'closure-review') {
    const rank = obligation === 'closure-review' ? 2 : spec?.review.min_rank ?? 1;
    const count = obligation === 'closure-review' ? 1 : spec?.review.count ?? 1;
    const reviews = context(s).entries.filter(e => e.kind === 'review' && e.node === subject && e.obligation === obligation && e.key === key && e.verdict === 'ok' && e.rank >= rank && !node?.writers.includes(e.by));
    out.evidence = reviews.map(e => e.seq);
    out.discharger = obligation === 'closure-review' ? 'owner' : 'reviewer';
    out.detail = `${obligation} requires ${count} non-writer reviews with rank at least ${rank}`;
    if (new Set(reviews.map(e => e.by)).size >= count) out.status = 'E';
  } else if (obligation === 'rulings') {
    const latest = latestRule(s, subject);
    const acknowledgments = context(s).entries.filter(e => e.kind === 'review' && e.node === subject && e.attempt === node?.slot?.attempt && e.seq > (node?.slot?.dispatchSeq ?? -1) && e.verdict === 'ok' && e.rank >= 1 && (e.ack_rulings ?? -1) >= latest && !node?.writers.includes(e.by) && e.key === node?.candidate?.keys[e.obligation]);
    if ((node?.slot?.rulings_seen ?? -1) >= latest || acknowledgments.length) {
      out.status = 'E';
      out.evidence = acknowledgments.length ? acknowledgments.map(e => e.seq) : [node!.slot!.dispatchSeq];
    }
    out.discharger = 'reviewer';
    out.detail = latest === -1 ? NO_RULINGS : `rulings requires acknowledgment of applicable ruling #${latest}`;
    if (latest === -1 && out.status === 'E') return { ...out, mark: '✔', discharger: undefined };
  } else {
    const obs = observations(s, subject, obligation, key);
    const pass = obs.some(e => e.verdict === 'pass');
    const fail = obs.some(e => e.verdict === 'fail');
    out.evidence = obs.map(e => e.seq);
    if (pass && fail) Object.assign(out, { mark: '⊤', discharger: 'owner', detail: `${obligation} conflicting pass and fail observations on the same key` });
    else if (fail) Object.assign(out, { mark: '✘', discharger: 'writer', detail: `${obligation} current content failed` });
    else if (pass) out.status = 'E';
  }
  if (blocks.length) {
    out.status = 'D';
    out.evidence = [...new Set([...out.evidence, ...blocks.map(b => b.seq)])];
    const currentFailed = out.mark === '✘';
    if (out.mark !== '⊤') out.mark = '⛔';
    out.discharger = out.mark === '⊤' || blocks.some(b => b.state === 'flaky' || (b.kind === 'judgment' && (b.rank ?? 0) >= 2)) ? 'owner' : blocks.some(b => b.kind === 'judgment') ? 'reviewer' : currentFailed ? 'writer' : 'executor';
    out.detail = `${obligation} still blocked: ${blocks.map(b => `#${b.seq}${b.state === 'flaky' ? ' flaky' : ''}`).join(', ')}`;
  }
  if (out.status === 'E') return { ...out, mark: '✔', discharger: undefined, detail: `${obligation} satisfied` };
  if (subject !== 'trunk' && !obligation.startsWith('inv:')) {
    const waiver = context(s).entries.findLast(e => e.kind === 'waive' && role(e.by) === 'owner' && e.node === subject && e.obligation === obligation && e.key === key && blocks.every(b => (e.accept_risk ?? []).includes(b.seq) && e.seq > b.seq));
    if (waiver?.kind === 'waive') return { ...out, status: 'W', mark: '⚠', discharger: undefined, evidence: [...out.evidence, waiver.seq], detail: `${obligation} owner waived: ${waiver.reason}${waiver.channel === 'flag' ? ' (flag weak confirmation)' : ''}` };
  }
  if (subject === 'trunk') {
    const defer = s.deferred.findLast(d => d.id === obligation.slice(4) && d.key === key);
    if (defer) Object.assign(out, { mark: '⏸', discharger: 'owner', detail: `${obligation} deferred, still debt`, evidence: [...out.evidence, defer.seq] });
  }
  return out;
}
function nodeItems(s: State, id: string, facts: CandidateFacts): ItemView[] {
  const spec = nodeSpec(s, id);
  return spec ? required(spec, facts).map(o => item(s, id, o, facts.keys[o] ?? '')) : [];
}
function refresh(s: State): void {
  for (const spec of s.plan.nodes) {
    const n = s.nodes[spec.id] ??= emptyNode(spec.id);
    n.items = n.candidate ? nodeItems(s, n.id, n.candidate) : [];
    n.accepted = !!n.candidate && (!!n.slot?.open || !!n.merged) && n.items.every(i => i.status !== 'D') && !n.blocks.some(b => binding(b, spec));
    n.phase = n.merged ? 'merged' : n.slot?.open ? n.candidate ? n.accepted ? 'accepted' : 'submitted' : 'dispatched' : spec.deps.every(d => s.nodes[d]?.merged) ? 'ready' : 'blocked';
    const seen = new Set<string>();
    const visit = (id: string): void => { for (const other of s.plan.nodes) if (other.deps.includes(id) && !seen.has(other.id)) { seen.add(other.id); visit(other.id); } };
    visit(n.id);
    n.dependents = seen.size;
    if (n.halt && (!n.slot?.open || n.slot.attempt !== n.halt.attempt)) n.halt = undefined;
  }
  s.invariants = s.plan.invariants.map(i => item(s, 'trunk', `inv:${i.id}`, s.trunk.invKeys[i.id] ?? ''));
  const g = context(s).genesis;
  // Genesis covers the invariants of the genesis plan; invariants added later are
  // judged by the no-new-debt rule on the first merge that carries their key.
  // Invariants removed later by the owner (a visible downgrade) are exempt.
  s.genesisDone = !!g && context(s).plans(g.plan).invariants.filter(i => s.plan.invariants.some(c => c.id === i.id)).every(i => !!g.state.invKeys[i.id] && hasVerdict(s, 'trunk', `inv:${i.id}`, g.state.invKeys[i.id]!));
}

/** Replay is deterministic; non-enumerable metadata retains the observations needed by pure queries. */
export function reduce(entries: Entry[], plans: PlanLookup): State {
  const s: State = { seq: -1, head: ZERO, genesisDone: false, trunk: { name: '', commit: '', tree: '', invKeys: {}, seq: -1 }, planSha: '', plan: blankPlan(), nodes: Object.create(null) as Record<string, NodeState>, invariants: [], rules: [], downgrades: [], deferred: [], escapes: [], decoys: [], decoyCommits: [], adoptions: [] };
  const h: History = { entries: [], plans, obsPlans: new Map(), mergeCatches: new Set() };
  Object.defineProperty(s, history, { value: h });
  for (const original of entries) {
    const e = structuredClone(original);
    const errors = validateDraft(s, e);
    if (errors.length) throw new OwedError(`Entry #${e.seq} invalid: ${errors.join('; ')}`);
    if (e.kind === 'genesis') {
      h.genesis = e;
      s.plan = structuredClone(plans(e.plan)); s.planSha = e.plan;
      s.trunk = { name: e.trunk, ...e.state, seq: e.seq };
    } else if (e.kind === 'plan') {
      const next = structuredClone(plans(e.plan));
      const detected = downgradeDetails(s.plan, next);
      // A candidate's facts were computed under the old plan; if its node's
      // obligations, setup or closure changed, the writer must submit again.
      for (const n of Object.values(s.nodes)) if (n.candidate && n.slot?.open && (canonical(nodeSpec(s, n.id)) !== canonical(next.nodes.find(x => x.id === n.id)) || s.plan.setup !== next.setup || canonical(s.plan.closure) !== canonical(next.closure))) n.candidate = undefined;
      s.plan = next; s.planSha = e.plan;
      const items = [...e.downgrades, ...detected.filter(d => !e.downgrades.some(x => x.node === d.node && x.what === d.what))];
      if (items.length) s.downgrades.push({ seq: e.seq, by: e.by, items });
    } else if (e.kind === 'rule') s.rules.push({ seq: e.seq, by: e.by, text: e.text, nodes: e.nodes });
    else if (e.kind === 'dispatch') {
      const n = s.nodes[e.node]!;
      const writer = `writer:${e.node}#${e.attempt}`;
      n.slot = { attempt: e.attempt, base: e.base, branch: e.branch, worktree: e.worktree, writer, dispatchSeq: e.seq, rulings_seen: e.rulings_seen, open: true };
      n.candidate = undefined;
      if (!n.writers.includes(writer)) n.writers.push(writer);
    } else if (e.kind === 'submit') s.nodes[e.node]!.candidate = { ...e.facts, seq: e.seq };
    else if (e.kind === 'abandon') { s.nodes[e.node]!.slot!.open = false; s.nodes[e.node]!.candidate = undefined; }
    else if (e.kind === 'rebase') {
      const n = s.nodes[e.node]!, slot = n.slot!;
      const previous = n.candidate ? { base: n.candidate.base, commit: n.candidate.commit, submit: n.candidate.seq } : slot.rebase?.previous;
      slot.rebase = { seq: e.seq, from: e.from, base: e.base, ...(previous ? { previous } : {}) };
      slot.base = e.base; n.candidate = undefined;
    } else if (e.kind === 'obs') {
      h.obsPlans.set(e.seq, s.plan);
      // A failing merge-result invariant catches a decoy of the merging node only when
      // the same invariant was not already debt (status D, e.g. deferred) on PRE = trunk.
      if (e.merging && e.verdict === 'fail' && (e.subject !== 'trunk' || item(s, 'trunk', e.obligation, s.trunk.invKeys[e.obligation.slice(4)] ?? '').status === 'E')) h.mergeCatches.add(e.seq);
      const n = s.nodes[e.subject];
      if (n) {
        const matches = n.blocks.filter(b => b.kind === 'exec' && b.state === 'active' && b.obligation === e.obligation && b.key === e.key);
        if (e.attribution && e.verdict !== 'error') for (const b of matches) {
          b.state = e.verdict === 'fail' ? 'cleared' : 'flaky';
          if (b.state === 'cleared') b.clearedBy = e.seq;
        }
        if (e.verdict === 'fail' && !e.attribution) n.blocks.push({ seq: e.seq, node: e.subject, obligation: e.obligation, kind: 'exec', key: e.key, state: 'active' });
      }
    } else if (e.kind === 'review') {
      const n = s.nodes[e.node]!;
      if (e.verdict === 'block') n.blocks.push({ seq: e.seq, node: e.node, obligation: e.obligation, kind: 'judgment', key: e.key, rank: e.rank, state: 'active' });
      else for (const b of n.blocks) if (active(b) && b.kind === 'judgment' && b.obligation === e.obligation && e.key === n.candidate?.keys[e.obligation] && (e.rank > (b.rank ?? 0) || (e.rank >= (b.rank ?? 0) && e.by === h.entries.find(x => x.seq === b.seq)?.by))) { b.state = 'cleared'; b.clearedBy = e.seq; }
    } else if (e.kind === 'waive') {
      const n = s.nodes[e.node]!;
      for (const b of n.blocks) if (active(b) && b.obligation === e.obligation && e.key === n.candidate?.keys[e.obligation] && e.accept_risk?.includes(b.seq)) { b.state = 'cleared'; b.clearedBy = e.seq; }
    } else if (e.kind === 'defer') {
      for (const i of e.items) s.deferred.push({ seq: e.seq, node: e.node, id: i.id, key: i.key });
    } else if (e.kind === 'merge') {
      const n = s.nodes[e.node]!;
      n.merged = { seq: e.seq, commit: e.commit }; n.slot!.open = false;
      s.trunk = { name: s.trunk.name, ...e.state, seq: e.seq };
    } else if (e.kind === 'adopt') {
      // Like a merge, the adopted commit becomes the trunk state; open slots are not touched.
      s.trunk = { name: s.trunk.name, ...e.state, seq: e.seq };
      s.adoptions.push({ seq: e.seq, by: e.by, ...(e.channel ? { channel: e.channel } : {}), prior: e.prior, commit: e.commit, commits: e.commits, changed: [...e.changed], note: e.note });
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
    h.entries.push(e); s.seq = e.seq; s.head = e.hash;
    refresh(s);
  }
  return s;
}

// ---------- driver (SPEC §12) ----------
const DRIVE_KINDS: readonly string[] = ['launch', 'send', 'halt'];
export const DRIVER = 'parent:drive';
/**
 * A halt is cleared by a later entry on its node by a principal other than the driver: a human, parent,
 * writer or reviewer action (submit, review, rebase, abandon, waive, defer, escape, a ruling naming the
 * node, dispatch), never by driver entries (launch/send/halt) or executor observations and merges (which
 * the driver itself causes). A dispatch opens a new attempt and clears it whoever records it.
 */
function clearsHalt(e: Entry, node: string): boolean {
  if (e.kind === 'dispatch' && e.node === node) return true;
  if (DRIVE_KINDS.includes(e.kind) || e.by === DRIVER || role(e.by) === 'executor') return false;
  return ('node' in e && e.node === node) || (e.kind === 'rule' && e.nodes !== '*' && e.nodes.includes(node));
}
/** The active driver halt of `node`'s current open attempt, if any. */
export function halted(s: State, node: string): HaltEntry | undefined {
  const n = s.nodes[node];
  return n?.halt && n.slot?.open && n.slot.attempt === n.halt.attempt ? n.halt : undefined;
}
/** Stable project id of a ledger: the first 12 hex of the genesis entry hash. */
export function projectId(s: State): string {
  const g = context(s).genesis;
  if (!g) throw new OwedError('Not initialized: run owed init <plan.yaml> first');
  return g.hash.slice(0, 12);
}
/**
 * dsa run id: `owed:<project>:<node>:<attempt>:<role>[:<n>]`. Writers have no `n`; reviewer runs always carry it:
 * `n` = 1 + the reviewer launch entries already in this attempt (`nextReviewerN`), monotone across the candidates
 * of the attempt. A reviewer run belongs to the latest candidate whose submit seq is below its launch entry's seq.
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
/** Reviewer launches of the current attempt recorded before the current candidate's submit (they belong to earlier candidates); the candidate's runs are n = base+1, base+2, … */
export function reviewerBase(s: State, node: string): number {
  const c = s.nodes[node]?.candidate;
  return c ? reviewerLaunches(s, node).filter(l => l.seq < c.seq).length : reviewerLaunches(s, node).length;
}
/** dsa labels of a run. */
export function runLabels(project: string, node: string, attempt: number, role: RunRole): Record<string, string> {
  return { owed: project, node, attempt: String(attempt), role };
}
/** Reviewer principal of the driver's n-th reviewer run of an attempt. */
export function driveReviewer(node: string, attempt: number, n: number): string { return `reviewer:drive-${node}-${attempt}-${n}`; }
export const SEND_KINDS: readonly SendKind[] = ['follow-up', 'steer'];
export const SEND_REASONS: readonly SendReason[] = ['submit', 'repair', 'interrupted', 'fenced', 'rebase', 'review-missing'];
const blobHash = (v: unknown): boolean => typeof v === 'string' && /^[0-9a-f]{64}$/.test(v);

// Conservative local downgrade detection keeps this leaf independent of plan.ts.
function downgradeDetails(prev: Plan, next: Plan): Downgrade[] {
  const result: Downgrade[] = [];
  const add = (node: string, what: string): void => { result.push({ node, what }); };
  const checks = (node: string, a: Plan['invariants'], b: Plan['invariants']): void => {
    for (const c of a) {
      const d = b.find(x => x.id === c.id);
      if (!d) { add(node, `${c.id} check removed`); continue; }
      if (c.red && !d.red) add(node, `${c.id} red disabled`);
      if ((d.min_tests ?? 0) < (c.min_tests ?? 0)) add(node, `${c.id} min_tests reduced`);
      if (c.run !== d.run || c.timeout_s !== d.timeout_s || canonical(c.reads) !== canonical(d.reads) || canonical(c.tests) !== canonical(d.tests) || c.red_expect !== d.red_expect) add(node, `${c.id} check definition changed; cannot prove obligations were not reduced`);
      if (c.mutants && (canonical(c.mutants) !== canonical(d.mutants) || (d.min_kill ?? 1) < (c.min_kill ?? 1))) add(node, `${c.id} mutants removed or changed, or min_kill reduced`);
    }
  };
  if (prev.setup !== next.setup || canonical(prev.closure) !== canonical(next.closure)) add('*', 'setup/closure changed; cannot prove obligations were not reduced');
  checks('trunk', prev.invariants, next.invariants);
  for (const n of prev.nodes) {
    const m = next.nodes.find(x => x.id === n.id);
    if (!m) { add(n.id, 'node removed'); continue; }
    checks(n.id, n.checks, m.checks);
    if (m.review.count < n.review.count || m.review.min_rank < n.review.min_rank) add(n.id, 'review count/rank reduced');
    if (m.writes.some(w => !n.writes.some(p => w.startsWith(p)))) add(n.id, 'writes scope expanded');
    if (n.deps.some(d => !m.deps.includes(d))) add(n.id, 'dependency removed');
  }
  return result;
}
export function validateDraft(s: State, d: Draft): string[] {
  const errors: string[] = [];
  const r = role(d.by);
  const allow = (...roles: string[]): void => { if (!roles.includes(r)) errors.push(`${d.kind} insufficient permissions; requires ${roles.join('/')}`); };
  if (!/^(owner|parent|writer|reviewer|executor):.+$/.test(d.by)) errors.push('Invalid identity format');
  if (d.kind === 'genesis') {
    allow('owner');
    if (s.seq !== -1) errors.push('genesis must be the first entry');
    if (d.commit !== d.state.commit) errors.push('genesis commit does not match facts');
    return errors;
  }
  if (s.seq === -1) return [...errors, 'genesis must be established first'];
  const n = 'node' in d ? s.nodes[d.node] : undefined;
  const spec = 'node' in d ? nodeSpec(s, d.node) : undefined;
  if ('node' in d && (!n || (!spec && d.kind !== 'escape'))) errors.push(`Node ${d.node} does not exist`);
  const slot = (): void => { if (!n?.slot?.open || !('attempt' in d) || n.slot.attempt !== d.attempt) errors.push('attempt must match the current open writer slot'); };
  const current = (o: string, key: string, reviewOnly = false): void => { if (!n?.slot?.open || !n.candidate || !spec || (!required(spec, n.candidate).includes(o) && !(reviewOnly && o === 'review') && !n.blocks.some(b => b.obligation === o && active(b))) || !key || n.candidate.keys[o] !== key) errors.push(`${o} must reference the current candidate obligation key`); };
  switch (d.kind) {
    case 'plan': {
      allow('owner', 'parent');
      if (d.prior !== s.planSha) errors.push('plan prior must reference the current plan sha');
      let downgrade = d.downgrades.length > 0;
      try { downgrade = downgradeDetails(s.plan, context(s).plans(d.plan)).length > 0 || downgrade; } catch { errors.push('Cannot read new plan'); }
      if (downgrade && r !== 'owner') errors.push('Only owner may approve a plan that reduces obligations');
      break;
    }
    case 'rule': allow('owner', 'parent'); if (d.nodes !== '*' && d.nodes.some(id => !nodeSpec(s, id))) errors.push('rule references a nonexistent node'); break;
    case 'dispatch':
      allow('parent', 'owner');
      if (n?.phase !== 'ready' || n.slot?.open) errors.push('dispatch requires a ready node with no open slot');
      if (!Number.isInteger(d.attempt) || d.attempt !== (n?.slot?.attempt ?? 0) + 1) errors.push('attempt must increase consecutively starting at 1');
      if (d.base !== s.trunk.commit) errors.push('dispatch base must be the current trunk');
      if (!Number.isInteger(d.rulings_seen) || d.rulings_seen < -1 || d.rulings_seen > Math.max(0, ...s.rules.map(x => x.seq))) errors.push('rulings_seen must not reference a ruling that does not yet exist');
      break;
    case 'submit':
      slot(); if (d.by !== n?.slot?.writer) errors.push('submit must be performed by the slot writer');
      if (d.facts.base !== n?.slot?.base) errors.push('submit base must match slot base');
      if (spec && required(spec, d.facts).some(o => !d.facts.keys[o])) errors.push('submit is missing required obligation keys');
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
        if (d.attribution && !target?.blocks.some(b => b.kind === 'exec' && b.state === 'active' && b.key === d.key && b.obligation === d.obligation && context(s).entries.some(e => e.kind === 'obs' && e.seq === b.seq && e.commit === d.commit && e.base === d.base))) errors.push('Attribution must match the original key/commit/base of an active execution block');
      }
      if (d.merging !== undefined && (typeof d.merging !== 'string' || !s.nodes[d.merging]?.slot?.open || !s.nodes[d.merging]?.candidate)) errors.push('obs merging must name a node with an open candidate');
      if (!d.key) errors.push('obs is missing an obligation key');
      break;
    case 'review':
      allow('reviewer', 'owner'); slot(); current(d.obligation, d.key, true);
      if (n?.writers.includes(d.by) || n?.writers.some(w => w.slice(w.indexOf(':') + 1) === d.by.slice(d.by.indexOf(':') + 1))) errors.push('review reviewer must not be the writer of any attempt of this node');
      if (r === 'owner' ? d.rank !== 3 : ![1, 2].includes(d.rank)) errors.push('review rank: reviewer must use 1..2, owner must use 3');
      if (d.ack_rulings !== undefined && (!Number.isInteger(d.ack_rulings) || d.ack_rulings > Math.max(0, ...s.rules.map(x => x.seq)))) errors.push('ack_rulings must not reference future rulings');
      break;
    case 'waive':
      allow('owner'); current(d.obligation, d.key);
      if (d.obligation.startsWith('inv:') || d.node === 'trunk') errors.push('invariant can never be waived');
      if (!d.reason.trim()) errors.push('waive requires a reason');
      if (d.accept_risk?.some(seq => !n?.blocks.some(b => b.seq === seq && b.obligation === d.obligation && active(b)))) errors.push('accept_risk must reference active blocks for this obligation');
      break;
    case 'defer':
      allow('owner');
      if (!n?.slot?.open || !n.candidate) errors.push('defer requires a current candidate');
      if (!d.reason.trim() || !d.items.length) errors.push('defer must list obligations and give a reason');
      if (d.items.some(i => !i.key || !s.plan.invariants.some(c => c.id === i.id))) errors.push('defer must reference valid invariants and keys');
      break;
    case 'abandon': allow('parent', 'owner'); slot(); break;
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
      if (n && spec) errors.push(...mergeGuard(s, d.node, { facts: d.facts, state: d.state }).reasons);
      break;
    case 'note': break;
    case 'adopt': {
      allow('owner');
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
  if (d.kind === 'escape' || d.kind === 'decoy-commit' || d.kind === 'decoy-reveal' || d.kind === 'adopt' || d.kind === 'launch' || d.kind === 'send' || d.kind === 'halt') {
    const extra = Object.entries(d).filter(([k, v]) => v !== undefined && !ENTRY_BASE_FIELDS.includes(k) && !STRICT_FIELDS[d.kind].includes(k)).map(([k]) => k);
    if (extra.length) errors.push(`${d.kind} has unknown fields: ${extra.join(', ')}`);
  }
  switch (d.kind) {
    case 'escape': {
      allow('owner', 'parent');
      const m = Number.isInteger(d.merge) ? context(s).entries.find(e => e.seq === d.merge) : undefined;
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
        if (context(s).entries.some(e => e.kind === 'launch' && e.rid === d.rid)) errors.push(`launch ${d.rid} is already recorded; a re-launch reuses the stored entry`);
      }
      break;
    }
    case 'send': {
      allow('parent'); slot();
      if (!context(s).entries.some(e => e.kind === 'launch' && e.rid === d.rid && e.node === d.node && e.attempt === d.attempt)) errors.push('send rid must name a recorded launch of this node attempt');
      if (!SEND_KINDS.includes(d.sendKind)) errors.push(`send sendKind must be one of ${SEND_KINDS.join(', ')}`);
      if (!SEND_REASONS.includes(d.reason)) errors.push(`send reason must be one of ${SEND_REASONS.join(', ')}`);
      if (!blobHash(d.message)) errors.push('send message must be a blob hash (64 lowercase hex)');
      const seq = 'seq' in d && typeof d.seq === 'number' ? d.seq : s.seq + 1;
      if (d.send !== `${d.rid}:${d.sendKind}:${seq}`) errors.push(`send id must be ${d.rid}:${d.sendKind}:${seq} (rid, kind, seq of this entry)`);
      break;
    }
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

// ---------- escapes and decoys ----------
/** Fields every entry may carry (assigned by the ledger or common to drafts). */
const ENTRY_BASE_FIELDS: readonly string[] = ['kind', 'by', 'channel', 'seq', 'ts', 'prev', 'hash'];
/** The only kind-specific fields accepted on these entries; anything else is refused. */
const STRICT_FIELDS: Record<'escape' | 'decoy-commit' | 'decoy-reveal' | 'adopt' | 'launch' | 'send' | 'halt', readonly string[]> = { escape: ['node', 'merge', 'class', 'note', 'evidence'], 'decoy-commit': ['digest'], 'decoy-reveal': ['nonce', 'decoys'], adopt: ['trunk', 'prior', 'commit', 'state', 'changed', 'commits', 'note'], launch: ['node', 'attempt', 'role', 'rid', 'spec', 'labels'], send: ['node', 'attempt', 'rid', 'send', 'sendKind', 'message', 'reason'], halt: ['node', 'attempt', 'reason', 'needs'] };
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
  if ((e.kind === 'obs' && e.by === 'executor:owed' && e.verdict === 'fail' && (e.subject === v.node || (e.merging === v.node && mergeCatches.has(e.seq)))) || (e.kind === 'review' && e.node === v.node && e.verdict === 'block')) Object.assign(v, { outcome: 'caught', decidedBy: e.seq });
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
    const e = context(s).entries.find((e): e is ObsEntry => e.kind === 'obs' && e.seq === b.seq);
    if (!e) continue;
    const token = `${b.obligation}\0${b.key}`;
    if (seen.has(token)) continue;
    seen.add(token);
    const plan = context(s).obsPlans.get(b.seq)!;
    const j = job(plan.nodes.find(x => x.id === id), id, b.obligation, b.key, e.commit, e.base ?? e.commit, plan);
    if (j) jobs.push({ ...j, attribution: true });
  }
  if (n.candidate && n.slot?.open) for (const o of required(nodeSpec(s, id)!, n.candidate)) {
    const key = n.candidate.keys[o];
    if (!key || hasVerdict(s, id, o, key)) continue;
    const j = job(nodeSpec(s, id), id, o, key, n.candidate.commit, n.slot.base, s.plan);
    if (j) jobs.push(j);
  }
  return jobs;
}
export function genesisJobs(s: State): AttestJob[] {
  const g = context(s).genesis;
  if (!g) return [];
  return s.plan.invariants.flatMap(i => {
    const key = g.state.invKeys[i.id];
    if (!key || hasVerdict(s, 'trunk', `inv:${i.id}`, key)) return [];
    return [job(undefined, 'trunk', `inv:${i.id}`, key, g.commit, g.commit, s.plan)!];
  });
}
export function mergeJobs(s: State, id: string, m: { facts: CandidateFacts; state: StateFacts }): AttestJob[] {
  const spec = nodeSpec(s, id);
  if (!spec || !s.nodes[id]?.candidate) throw new OwedError(`Node ${id} has no current candidate`);
  const jobs: AttestJob[] = [];
  for (const c of spec.checks) {
    const o = `check:${c.id}`, key = m.facts.keys[o];
    if (key && !hasVerdict(s, id, o, key)) jobs.push(job(spec, id, o, key, m.facts.commit, m.facts.base, s.plan)!);
  }
  for (const i of s.plan.invariants) {
    const key = m.state.invKeys[i.id];
    if (key && !hasVerdict(s, 'trunk', `inv:${i.id}`, key)) jobs.push(job(undefined, 'trunk', `inv:${i.id}`, key, m.state.commit, m.state.commit, s.plan)!);
  }
  return jobs;
}
/** Invariants of the plan whose key on the adopted state `st` lacks a verdict (key changed relative to the trunk, as for merge). */
export function adoptJobs(s: State, st: StateFacts): AttestJob[] {
  return s.plan.invariants.flatMap(i => {
    const key = st.invKeys[i.id];
    if (!key || key === s.trunk.invKeys[i.id] || hasVerdict(s, 'trunk', `inv:${i.id}`, key)) return [];
    return [job(undefined, 'trunk', `inv:${i.id}`, key, st.commit, st.commit, s.plan)!];
  });
}
export interface AdoptGuard { ok: boolean; reasons: string[]; failed: string[]; invItems: ItemView[] }
/**
 * No new debt for an adoption (SPEC §6.6): an invariant whose key changed on the adopted state must be E there
 * when it was E on the current trunk; debt already on the trunk (D: failing, ⊥, deferred, ⊤) does not block.
 */
export function adoptGuard(s: State, st: StateFacts): AdoptGuard {
  const reasons: string[] = [], failed: string[] = [];
  const invItems = s.plan.invariants.map(i => {
    const key = st.invKeys[i.id] ?? '', o = `inv:${i.id}`;
    const v = item(s, 'trunk', o, key);
    if (!key) reasons.push(`invariant ${i.id} missing adopt obligation key`);
    else if (key !== s.trunk.invKeys[i.id] && v.status !== 'E' && item(s, 'trunk', o, s.trunk.invKeys[i.id] ?? '').status === 'E') {
      failed.push(i.id);
      reasons.push(`invariant ${i.id} new debt: satisfied on the current trunk but not on the adopted commit (${v.detail})`);
    }
    return v;
  });
  if (!s.genesisDone) reasons.push('genesis invariant initial observations are incomplete');
  return { ok: reasons.length === 0, reasons, failed, invItems };
}
export function mergeGuard(s: State, id: string, m: { facts: CandidateFacts; state: StateFacts }): MergeGuard {
  const reasons: string[] = [];
  const n = s.nodes[id], spec = nodeSpec(s, id);
  const nodeItemsOnMerge: ItemView[] = [];
  if (!n?.accepted) reasons.push(`Node ${id} current candidate is not yet accepted`);
  if (m.facts.base !== s.trunk.commit) reasons.push('writes merge facts base must be the current trunk');
  if (m.facts.commit !== m.state.commit || m.facts.tree !== m.state.tree) reasons.push('Merge facts commit/tree mismatch');
  if (n?.candidate && spec) {
    for (const o of required(spec, n.candidate)) {
      const onMerge = o === 'writes' || o.startsWith('check:');
      const v = item(s, id, o, (onMerge ? m.facts.keys[o] : n.candidate.keys[o]) ?? '');
      // CandidateFacts.changed is trusted git output for PRE..M. Unlike command
      // checks, writes can be re-evaluated synchronously without an executor job.
      if (o === 'writes' && m.facts.keys.writes) {
        if (m.facts.changed.some(p => !spec.writes.some(prefix => p.startsWith(prefix)))) Object.assign(v, { status: 'D', mark: '✘', discharger: 'writer', detail: 'writes merge changes exceed allowed paths' });
        else if (v.mark === '⊥') Object.assign(v, { status: 'E', mark: '✔', discharger: undefined, detail: 'writes merge changes rechecked against allowed paths' });
      }
      nodeItemsOnMerge.push(v);
      if (v.status === 'D') reasons.push(`${id} obligation ${o} unsatisfied:${v.detail}`);
    }
    if (n.blocks.some(b => binding(b, spec))) reasons.push(`${id} still has active blocks: ${n.blocks.filter(b => binding(b, spec)).map(b => `${b.obligation} #${b.seq}`).join(', ')}`);
  }
  const invItems = s.plan.invariants.map(i => {
    const key = m.state.invKeys[i.id] ?? '';
    const v = item(s, 'trunk', `inv:${i.id}`, key);
    if (!key) reasons.push(`invariant ${i.id} missing merge obligation key`);
    else if (key !== s.trunk.invKeys[i.id] && v.status !== 'E') {
      const d = s.deferred.findLast(d => d.node === id && d.id === i.id && d.key === key && d.seq > (n?.slot?.dispatchSeq ?? Infinity));
      if (d) Object.assign(v, { status: 'D', mark: '⏸', discharger: 'owner', evidence: [...new Set([...v.evidence, d.seq])], detail: `inv:${i.id} owner deferred, still debt` });
      else reasons.push(`invariant ${i.id} new debt: requires a measured pass on the merge key or owner defer for this node`);
    }
    return v;
  });
  if (!s.genesisDone) reasons.push('genesis invariant initial observations are incomplete');
  return { ok: reasons.length === 0, reasons, nodeItems: nodeItemsOnMerge, invItems };
}
