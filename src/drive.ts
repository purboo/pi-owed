// owed drive: the pure policy (SPEC §12, contract D1/D4). `decide` reads the ledger state, the plan, dsa run views and
// the executor's in-process facts, and returns the actions of one pass. No I/O, no clock, no git: everything it uses
// comes from its arguments. Executing the actions (dsa calls, ledger appends, attest, merge) belongs to the executor.
import { canonical, sha256 } from './canon.ts';
import { driveConfig } from './plan.ts';
import { attestJobs, driveReviewer, driveReviewerSlot, entriesOf, halted, nextReviewerN, observationsOf, planAt, reviewerBase, runId, runLabels, writesOverlap } from './reducer.ts';
import { dispatchPacket, oneLine, receipt, renderReceipt, reviewObligations, reviewPacket, reviewRuns } from './views.ts';
import type { AttemptRuns, Block, LaunchEntry, NodeState, Plan, RunRole, RunView, SendKind, SendReason, State } from './types.ts';

/** One driver action (contract D4). The executor runs them in order; at most one per node per pass. */
export type Action =
  /** `ops.dispatch` as parent:drive; the writer launch follows from the next `decide` (level-triggered). */
  | { do: 'dispatch'; node: string }
  /** Append the LaunchEntry (unless already recorded with these bytes) then `dsa run`; `spec` = exact spec JSON bytes. */
  | { do: 'launch'; node: string; attempt: number; role: RunRole; n?: number; rid: string; spec: string; labels: Record<string, string> }
  /**
   * Append a SendEntry then `dsa send`; `message` = exact message bytes. `send` is present only on a re-send of an
   * already recorded entry (D4 row 4): the executor appends nothing and re-sends `message` with that request id.
   */
  | { do: 'send'; node: string; attempt: number; rid: string; sendKind: SendKind; message: string; reason: SendReason; send?: string }
  /** `owed attest <node>` (through `hold machine` when dsa is available, D6). */
  | { do: 'attest'; node: string }
  /** `ops.rebase` as parent:drive; the `rebase` follow-up to the writer follows from the next `decide`. */
  | { do: 'rebase'; node: string }
  | { do: 'merge'; node: string }
  | { do: 'halt'; node: string; attempt: number; reason: string; needs: 'human' | 'owner' }
  /** Printed only (asking questions); no ledger write. */
  | { do: 'notify'; node: string; text: string };

/** A merge of the node's candidate `candidate` (submit seq) that this process saw refused. */
export interface MergeRefusal {
  candidate: number;
  reason: string;
  /** Refused because trunk moved and the candidate does not merge cleanly (`rebase needed`): the driver rebases. */
  rebase?: boolean;
  /** Otherwise the driver halts with `reason`, needing `needs` (default human; e.g. owner for trunk drift). */
  needs?: 'human' | 'owner';
}
/**
 * Inputs of `decide` besides the ledger state, the plan and the run views.
 * `max`/`repairs`: the executor resolves them from `driveConfig(plan)` and `--max`. Agents and models come from
 * `driveConfig(plan)` directly. The remaining fields are facts only the executor has (in-process, or read from the
 * ledger's blob store); they make the result a pure function of the arguments.
 */
export interface DriveOpts {
  /** Concurrent open attempts below which the driver dispatches ready nodes. */
  max: number;
  /** Repair follow-ups (failed check, measured or review block) per attempt before halting. */
  repairs: number;
  /** `projectId(state)`: the first 12 hex of the genesis hash. */
  project: string;
  /** Main repository root: the cwd of reviewer runs. */
  root: string;
  /** Send request ids (`SendEntry.send`) dsa confirmed applied in this process; any other recorded send of an open attempt is re-sent. */
  applied: ReadonlySet<string>;
  /**
   * Request ids dsa rejected (exit 1) in this process, with dsa's reason: run ids (`dsa run`) and send ids (`dsa send`,
   * e.g. a re-send to a pruned run). The attempt halts needing a human (D9); the request is never retried.
   */
  rejected: ReadonlyMap<string, string>;
  /**
   * Exact stored bytes of recorded blobs, by blob hash (the launch entry's `spec`, the send entry's `message`), that the
   * executor read for retries: launches whose run is `absent` and sends not in `applied`. A re-launch first rebuilds
   * the spec and uses it when its hash equals the stored one; a re-send always needs the stored message.
   */
  blobs?: ReadonlyMap<string, string>;
  /** Merges refused in this process, by node. */
  merges?: ReadonlyMap<string, MergeRefusal>;
}

// ---------- spec bytes, tasks and messages (pure, deterministic) ----------
/**
 * Exact dsa spec bytes of a driver launch: canonical JSON (keys sorted, no whitespace) of {agent, model?, cwd,
 * isolation:"none", once:true, task}. The same inputs always give the same bytes, so a retry rebuilds them identically.
 */
export function launchSpec(o: { agent: string; model?: string; cwd: string; task: string }): string {
  return canonical({ agent: o.agent, ...(o.model !== undefined ? { model: o.model } : {}), cwd: o.cwd, isolation: 'none', once: true, task: o.task });
}
/** The writer task of the node's open attempt: its dispatch packet, rebuilt from dispatch-time facts (plan in force, rulings, worktree). */
export function writerTask(s: State, node: string): string {
  const slot = s.nodes[node]?.slot;
  if (!slot) throw new Error(`Node ${node} has no slot`);
  const spec = planAt(s, slot.dispatchSeq).nodes.find(x => x.id === node);
  if (!spec) throw new Error(`Node ${node} is not in the plan of its dispatch #${slot.dispatchSeq}`);
  return dispatchPacket(spec, slot.attempt, slot.worktree, s.rules.filter(r => r.seq < slot.dispatchSeq && (r.nodes === '*' || r.nodes.includes(node))));
}
/** Launch action of the writer of the node's open attempt (spec: writer agent/model, cwd = slot worktree, task = dispatch packet). */
export function writerLaunch(s: State, node: string, project: string): Extract<Action, { do: 'launch' }> {
  const slot = s.nodes[node]!.slot!, agent = driveConfig(s.plan).writer;
  return { do: 'launch', node, attempt: slot.attempt, role: 'writer', rid: runId(project, node, slot.attempt, 'writer'), spec: launchSpec({ ...agent, cwd: slot.worktree, task: writerTask(s, node) }), labels: runLabels(project, node, slot.attempt, 'writer') };
}
/** Launch action of reviewer run `n` (attempt-global) on the node's current candidate (cwd = repo root, task = review packet). */
export function reviewerLaunch(s: State, node: string, n: number, project: string, root: string): Extract<Action, { do: 'launch' }> {
  const slot = s.nodes[node]!.slot!, agent = driveConfig(s.plan).reviewer;
  return { do: 'launch', node, attempt: slot.attempt, role: 'reviewer', n, rid: runId(project, node, slot.attempt, 'reviewer', n), spec: launchSpec({ ...agent, cwd: root, task: reviewPacket(s, node, n) }), labels: runLabels(project, node, slot.attempt, 'reviewer') };
}
export const WRITER_INTERRUPTED = 'You were interrupted; processes your tools started are gone. Check the worktree (HEAD, git status) before continuing, then commit and `owed submit`.';
export const submitMessage = (node: string): string => `commit your work and run \`owed submit ${node}\``;
export const reviewerInterrupted = (node: string): string => `You were interrupted; check \`owed why ${node}\` for reviews you already recorded on this candidate, finish the rest.`;
/**
 * Ending of a halt for a request dsa rejected (D15.1): the id and bytes of a recorded run or send are fixed for the
 * attempt and dsa answers the same id the same way, so clearing the halt only re-halts; a new attempt is the recovery.
 */
export const rejectedFixed = (node: string): string => `this attempt's request is fixed; fix the cause (plan, agent, model), then \`owed abandon ${node}\` to start a new attempt`;
/** Halt reason of a run or send dsa rejected: dsa's reason, then `rejectedFixed`. */
export const rejectedHalt = (node: string, what: 'run' | 'send', id: string, reason: string): string => `dsa rejected ${what} ${id}: ${oneLine(reason)}; ${rejectedFixed(node)}`;
export const fencedMessage = (reason: string): string => `Your previous execution was cut off (${oneLine(reason)}); processes your tools started are gone; rerun anything you were measuring.`;
/** Repair follow-up: what to do, the notes of active review blocks, then the `owed why` card of the node. */
export function repairMessage(s: State, node: string): string {
  const n = s.nodes[node]!, c = n.candidate!, entries = entriesOf(s);
  const notes = n.blocks.filter(b => b.kind === 'judgment' && b.state === 'active').map(b => {
    const e = entries.find(x => x.seq === b.seq);
    return `- #${b.seq} ${b.obligation} by ${e?.by ?? '?'} rank ${b.rank}: ${oneLine(e?.kind === 'review' ? e.note ?? '' : '')}`;
  });
  return [`owed found problems with your candidate ${c.commit} (submit #${c.seq}) of ${node}, attempt ${n.slot!.attempt}.`,
    `Fix them in your worktree, commit, and run \`owed submit ${node}\`; owed reruns the checks itself.`,
    ...(notes.length ? ['Review blocks (the reviewer\'s note):', ...notes] : []),
    `The \`owed why ${node}\` card:`, '',
    renderReceipt(receipt(s, entries, node))].join('\n');
}
/** Rebase follow-up after the slot's latest rebase (stable: it names the rebase entry's bases, not the current trunk). */
export function rebaseMessage(s: State, node: string): string {
  const slot = s.nodes[node]!.slot!, r = slot.rebase!;
  return `trunk moved; rebase your worktree onto ${s.trunk.name} (${r.base}): in ${slot.worktree} run \`git rebase --onto ${r.base} ${r.from}\`, resolve conflicts within the allowed writes, rerun checks, commit, then \`owed submit ${node}\``;
}

// ---------- driver reviewers ----------
/**
 * The review slot k of `by` when it is a driver reviewer of the node's current open attempt: `reviewer:drive-<node>-
 * <attempt>-<k>` with 1 <= k <= max(review.count, 1) (slot 1 also records closure-review); else undefined (D11: any other
 * k is not a driver reviewer).
 */
export function driverSlot(s: State, node: string, by: string): number | undefined {
  const n = s.nodes[node], spec = s.plan.nodes.find(x => x.id === node);
  if (!n?.slot?.open || !spec) return undefined;
  const k = driveReviewerSlot(by, node, n.slot.attempt);
  return k !== undefined && k <= Math.max(spec.review.count, 1) ? k : undefined;
}

// ---------- owner-needed ----------
/**
 * Why the node needs an owner decision the driver must not touch (D4), or undefined. Owner blocks: a flaky block, or an
 * active review block of rank >= 2 — except one authored by a driver reviewer (`driverSlot`: `reviewer:drive-<node>-
 * <attempt>-<k>`, k in range) of the node's current open attempt, which the driver repairs (its slot reviewer re-reviews at the block's rank;
 * rank 3 is owner-only and never driver-authored). With an open candidate: an item with conflicting observations (⊤),
 * an item with an owner block, or a review the plan requires at rank > 2 (a closure-review merely awaiting a rank-2
 * review is reviewer work). Otherwise: an owner block still active on the node (a new attempt cannot clear it).
 */
export function ownerNeeded(s: State, node: string): string | undefined {
  const n = s.nodes[node], spec = s.plan.nodes.find(x => x.id === node);
  if (!n) return undefined;
  const entries = entriesOf(s);
  const driverAuthored = (seq: number): boolean => driverSlot(s, node, entries.find(e => e.seq === seq)?.by ?? '') !== undefined;
  const ownerBlock = n.blocks.filter(b => b.state === 'flaky' || (b.state === 'active' && b.kind === 'judgment' && (b.rank ?? 0) >= 2 && !((b.rank ?? 0) <= 2 && driverAuthored(b.seq))));
  const text = (b: (typeof ownerBlock)[number]): string => `${b.state === 'flaky' ? 'flaky' : `rank ${b.rank} review`} block #${b.seq} on ${b.obligation} needs the owner`;
  if (n.slot?.open && n.candidate) {
    for (const i of n.items) if (i.status === 'D') {
      if (i.mark === '⊤') return `${i.obligation}: ${i.detail}`;
      const b = ownerBlock.find(b => b.obligation === i.obligation);
      if (b) return text(b);
      if (i.obligation === 'review' && (spec?.review.min_rank ?? 1) > 2) return `review requires rank ${spec!.review.min_rank}: only the owner can record it`;
    }
    return undefined;
  }
  return ownerBlock.length ? text(ownerBlock[0]!) : undefined;
}
const ownerNotify = (node: string, reason: string): Action => ({ do: 'notify', node, text: `${node}: needs the owner (${oneLine(reason)}); the driver leaves it alone` });

// ---------- decide ----------
const isSealed = (v: RunView): boolean => v.state === 'sealed' || v.state === 'pruned';
const statusOf = (v: RunView): string => v.status ?? 'unknown';
const reviewerN = (l: LaunchEntry): number => Number(l.rid.slice(l.rid.lastIndexOf(':') + 1));
/** Status order of `owed status`: more dependents first, then id. */
const byStatusOrder = (a: NodeState, b: NodeState): number => b.dependents - a.dependents || a.id.localeCompare(b.id);

/**
 * The actions of one pass (contract D1/D4/D10/D11): per open attempt the first matching row of the policy table, then
 * dispatches of ready nodes while open attempts < `max`. Pure: equal inputs give deep-equal outputs; inputs are not
 * modified. A node whose recorded run lacks a view in `runs` (describe failed) gets no action this pass.
 * The plan is read from `s.plan` only (D11); the `plan` parameter is kept for the D1 signature and not used.
 */
export function decide(s: State, _plan: Plan, runs: ReadonlyMap<string, RunView>, opts: DriveOpts): Action[] {
  if (s.seq < 0) return [];
  const plan = s.plan;
  const out: Action[] = [];
  const open = Object.values(s.nodes).filter(n => n.slot?.open).sort(byStatusOrder);
  for (const n of open) { const a = slotAction(s, runs, opts, n); if (a) out.push(a); }
  // Not per slot: dispatch ready nodes in status order while open attempts < max, skipping writes overlaps and owner-needed nodes.
  const writes = (id: string): string[] => plan.nodes.find(x => x.id === id)?.writes ?? [];
  const taken = open.map(n => writes(n.id));
  for (const n of Object.values(s.nodes).filter(n => n.phase === 'ready').sort(byStatusOrder)) {
    const owner = ownerNeeded(s, n.id);
    if (owner) { out.push(ownerNotify(n.id, owner)); continue; }
    if (taken.length >= opts.max || !plan.nodes.some(x => x.id === n.id) || taken.some(w => writesOverlap(writes(n.id), w))) continue;
    out.push({ do: 'dispatch', node: n.id });
    taken.push(writes(n.id));
  }
  return out;
}

function slotAction(s: State, runs: ReadonlyMap<string, RunView>, opts: DriveOpts, n: NodeState): Action | undefined {
  const id = n.id, slot = n.slot!, attempt = slot.attempt, c = n.candidate;
  const halt = (reason: string, needs: 'human' | 'owner' = 'human'): Action => ({ do: 'halt', node: id, attempt, reason, needs });
  const send = (l: LaunchEntry, sendKind: SendKind, reason: SendReason, message: string): Action => ({ do: 'send', node: id, attempt, rid: l.rid, sendKind, message, reason });
  // Row 1: halted.
  if (halted(s, id)) return undefined;
  // Owner-needed nodes are never touched (no ledger write, no dsa call): notify only.
  const owner = ownerNeeded(s, id);
  if (owner) return ownerNotify(id, owner);
  const ar: AttemptRuns = n.runs.find(r => r.attempt === attempt) ?? { attempt, launches: [], sends: [] };
  const writer = ar.launches.find(l => l.role === 'writer');
  // Row 2: writer launch missing.
  if (!writer) return writerLaunch(s, id, opts.project);
  // Runs that matter: the writer and the reviewer runs of the current candidate (a reviewer run belongs to the latest
  // candidate submitted before its launch entry); runs of earlier candidates are obsolete.
  const live = ar.launches.filter(l => l.role === 'writer' || (!!c && l.seq > c.seq));
  if (live.some(l => !runs.has(l.rid))) return undefined;
  const view = (l: LaunchEntry): RunView => runs.get(l.rid)!;
  // Row 3: a launch whose run is absent: re-launch with the stored bytes and the same rid; a rejection seen by this process halts (D9).
  for (const l of live) {
    const rejected = opts.rejected.get(l.rid);
    if (rejected !== undefined) return halt(rejectedHalt(id, 'run', l.rid, rejected));
    if (view(l).state === 'absent') return relaunch(s, opts, l) ?? halt(`cannot re-launch ${l.rid}: the stored spec bytes (blob ${l.spec}) were not supplied and the rebuilt spec differs`);
  }
  // Row 4: a recorded send not confirmed applied in this process: re-send the same id and bytes.
  for (const x of ar.sends) {
    if (opts.applied.has(x.send) || !live.some(l => l.rid === x.rid)) continue;
    const refused = opts.rejected.get(x.send);
    if (refused !== undefined) return halt(rejectedHalt(id, 'send', x.send, refused));
    const bytes = opts.blobs?.get(x.message);
    if (bytes === undefined || sha256(bytes) !== x.message) return halt(`cannot re-send ${x.send}: the stored message bytes (blob ${x.message}) were not supplied`);
    return { do: 'send', node: id, attempt, rid: x.rid, sendKind: x.sendKind, message: bytes, reason: x.reason, send: x.send };
  }
  // Row 5: a run asking: notify (question, answer address); the driver never answers.
  for (const l of live) if (view(l).state === 'asking') return { do: 'notify', node: id, text: askingText(id, l, view(l)) };
  const w = view(writer), wSealed = isSealed(w), wStatus = statusOf(w);
  // Row 6: writer cut off in a tool.
  if (wSealed && wStatus === 'unknown') return send(writer, 'follow-up', 'interrupted', WRITER_INTERRUPTED);
  // Row 7: writer sealed non-ok.
  if (wSealed && wStatus !== 'ok') return halt(`writer run ${writer.rid} sealed ${wStatus}${w.error ? `: ${w.error}` : ''}${wStatus === 'rejected' ? `; ${rejectedFixed(id)}` : ''}`);
  // Row 8: writer done without a current candidate (after a rebase: the rebase follow-up first).
  if (wSealed && !c) {
    const rb = slot.rebase;
    if (rb && !ar.sends.some(x => x.reason === 'rebase' && x.seq > rb.seq)) return send(writer, 'follow-up', 'rebase', rebaseMessage(s, id));
    const since = rb?.seq ?? slot.dispatchSeq, nudge = ar.sends.findLast(x => x.reason === 'submit' && x.seq > since);
    return nudge ? halt(`writer run ${writer.rid} finished without submitting a candidate after follow-up ${nudge.send}`) : send(writer, 'follow-up', 'submit', submitMessage(id));
  }
  const fenced = (): Action | undefined => {
    const f = w.lastFence;
    if (w.state !== 'running' || !f) return undefined;
    const steer = ar.sends.findLast(x => x.rid === writer.rid && x.sendKind === 'steer');
    return !steer || f.at > Date.parse(steer.ts) ? send(writer, 'steer', 'fenced', fencedMessage(f.reason)) : undefined;
  };
  if (c) {
    // Rows 9-10: measured obligations without a verdict on the candidate's keys, and attribution reruns of blocks from
    // earlier content (a failure of the current content is a repair, not an attest): attest, unless `error` twice.
    const jobs = attestJobs(s, id).filter(j => !(j.attribution && j.key === c.keys[j.obligation])).map(j => ({ j, errors: observationsOf(s, j.subject, j.obligation, j.key).filter(o => o.verdict === 'error') }));
    if (jobs.some(x => x.errors.length < 2)) return { do: 'attest', node: id };
    if (jobs.length) return halt(`attest recorded no verdict twice: ${jobs.map(x => `${x.j.obligation} (${x.errors.map(o => `#${o.seq} ${o.note ?? `exit ${o.exit}`}`).join('; ')})`).join(', ')}`);
    // Repair: one follow-up per candidate, at most `repairs` per attempt; a writer that finishes it without resubmitting halts.
    const repair = (cause: string): Action | undefined => {
      const done = ar.sends.filter(x => x.reason === 'repair'), outstanding = done.findLast(x => x.seq > c.seq);
      if (outstanding) return wSealed ? halt(`writer run ${writer.rid} finished repair follow-up ${outstanding.send} without submitting a new candidate (${cause})`) : fenced();
      if (done.length >= opts.repairs) return halt(`repairs exhausted (${done.length} of ${opts.repairs}): ${cause}`);
      return send(writer, 'follow-up', 'repair', repairMessage(s, id));
    };
    // Row 11: a measured block: an obligation of the candidate failed (✘), or an active execution block binds it.
    const measured = n.items.filter(i => i.mark === '✘' || n.blocks.some(b => b.kind === 'exec' && b.state === 'active' && b.obligation === i.obligation));
    if (measured.length) return repair(`measured block ${measured.map(i => `${i.obligation} [${i.evidence.map(x => `#${x}`).join(', ')}]`).join(', ')}`);
    // Row 12: review obligations awaiting and fewer reviewer runs than the candidate needs: launch the next n.
    const reviewers = live.filter(l => l.role === 'reviewer');
    if (n.items.some(i => (i.obligation === 'review' || i.obligation === 'closure-review') && i.status === 'D') && reviewers.length < reviewRuns(s, id))
      return reviewerLaunch(s, id, nextReviewerN(s, id), opts.project, opts.root);
    // Rows 13-14: a sealed reviewer run whose obligations are still awaiting (it recorded no review on them).
    const entries = entriesOf(s);
    for (const l of reviewers) {
      const v = view(l);
      if (!isSealed(v)) continue;
      const k = reviewerN(l), who = driveReviewer(id, attempt, k - reviewerBase(s, id));
      const awaiting = reviewObligations(s, id, k).filter(o => n.items.find(i => i.obligation === o)?.status === 'D' && !entries.some(e => e.kind === 'review' && e.node === id && e.by === who && e.obligation === o && e.key === c.keys[o]));
      if (!awaiting.length) continue;
      if (statusOf(v) === 'unknown' && !ar.sends.some(x => x.rid === l.rid && x.reason === 'interrupted')) return send(l, 'follow-up', 'interrupted', reviewerInterrupted(id));
      return halt(`review-missing: reviewer run ${l.rid} sealed ${statusOf(v)}${v.error ? `: ${v.error}` : ''} without recording ${awaiting.join(', ')} on candidate #${c.seq}${statusOf(v) === 'rejected' ? `; ${rejectedFixed(id)}` : ''}`);
    }
    // Row 15 (D11/D12): a review block recorded on the current candidate's key: repair (counts as a repair). A stale
    // block (recorded on an earlier candidate) is left to the slot re-review: wait only while a reviewer run of this
    // candidate is unsealed (row 12 already launched any needed run); otherwise halt needing the owner.
    const judged = n.blocks.filter(b => b.kind === 'judgment' && b.state === 'active');
    const current = judged.filter(b => b.key === c.keys[b.obligation]), stale = judged.filter(b => b.key !== c.keys[b.obligation]);
    if (current.length) return repair(`review block ${current.map(b => `#${b.seq} ${b.obligation}`).join(', ')}`);
    const reviewing = reviewers.some(l => !isSealed(view(l)));
    if (stale.length) {
      if (reviewing) return fenced();
      return halt(`stale review block${stale.length > 1 ? 's' : ''} ${stale.map(b => `#${b.seq} ${b.obligation} rank ${b.rank} by ${entries.find(e => e.seq === b.seq)?.by ?? '?'}`).join(', ')} still active and no reviewer run of candidate #${c.seq} is running; the driver cannot clear ${stale.length > 1 ? 'them' : 'it'}`, 'owner');
    }
    // Rows 16-17: accepted: merge; a merge this process saw refused: rebase when trunk moved, else halt.
    if (n.accepted) {
      const m = opts.merges?.get(id);
      if (m && m.candidate === c.seq) return m.rebase ? { do: 'rebase', node: id } : halt(`merge refused: ${m.reason}`, m.needs ?? 'human');
      return { do: 'merge', node: id };
    }
    // Liveness (D12): a candidate that is not accepted while no driver run of the attempt is unsealed never yields
    // "nothing to do": halt needing the owner with every non-E item and active block.
    if (wSealed && !reviewing) {
      const items = n.items.filter(i => i.status !== 'E').map(i => `${i.obligation} ${i.mark} ${i.detail}`);
      const blocks = n.blocks.filter(b => b.state === 'active').map(b => blockText(s, c, b));
      return halt(`stalled: ${[...items, ...(blocks.length ? [`active blocks ${blocks.join(', ')}`] : [])].join('; ') || 'candidate not accepted'}`, 'owner');
    }
  }
  // Row 18: the running writer was fenced after the last steer.
  return fenced();
}

/**
 * One active block in a `stalled:` halt (D15.3): `#seq <obligation> by <principal> rank <r> on candidate #C`, or `stale`
 * instead of `on candidate #C` when it was recorded on another key than the candidate's. `rank` is omitted for an
 * execution block (it has none).
 */
export function blockText(s: State, c: { seq: number; keys: Record<string, string> }, b: Block): string {
  const by = entriesOf(s).find(e => e.seq === b.seq)?.by ?? '?';
  return `#${b.seq} ${b.obligation} by ${by}${b.rank !== undefined ? ` rank ${b.rank}` : ''} ${b.key === c.keys[b.obligation] ? `on candidate #${c.seq}` : 'stale'}`;
}

/** Re-launch action of a recorded launch: rebuilt bytes when they hash to the stored spec, else the supplied stored bytes. */
function relaunch(s: State, opts: DriveOpts, l: LaunchEntry): Action | undefined {
  let rebuilt: Extract<Action, { do: 'launch' }> | undefined;
  try { rebuilt = l.role === 'writer' ? writerLaunch(s, l.node, opts.project) : reviewerLaunch(s, l.node, reviewerN(l), opts.project, opts.root); } catch { rebuilt = undefined; }
  const base = { do: 'launch' as const, node: l.node, attempt: l.attempt, role: l.role, ...(l.role === 'reviewer' ? { n: reviewerN(l) } : {}), rid: l.rid, labels: { ...l.labels } };
  if (rebuilt && sha256(rebuilt.spec) === l.spec) return { ...base, spec: rebuilt.spec };
  const stored = opts.blobs?.get(l.spec);
  return stored !== undefined && sha256(stored) === l.spec ? { ...base, spec: stored } : undefined;
}
function askingText(node: string, l: LaunchEntry, v: RunView): string {
  const qs = v.questions ?? [];
  if (!qs.length) return `${node}: ${l.role} run ${l.rid} is asking (no question reported; see pi-durable-subagents describe --key ${l.rid}); the driver never answers`;
  return qs.map(q => `${node}: ${l.role} run ${l.rid} asks (qid ${q.qid}, rev ${q.rev}): ${oneLine(q.question)} — the driver never answers; answer with: pi-durable-subagents send --request <id> --to ${l.rid} --kind answer --qid ${q.qid} --rev ${q.rev} --message @<file>`).join('\n');
}
