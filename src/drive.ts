// owed drive: the pure policy (SPEC §12, contract D1/D4). `decide` reads the ledger state, the plan, dsa run views and
// the executor's in-process facts, and returns the actions of one pass. No I/O, no clock, no git: everything it uses
// comes from its arguments. Executing the actions (dsa calls, ledger appends, attest, merge) belongs to the executor.
import { canonical, sha256 } from './canon.ts';
import { rebaseFollowupSent, rebaseWorkText, type RebasePending } from './rebase-view.ts';
import { answerRetry } from './answer.ts';
import { clockTime } from './clock.ts';
import { driveConfig } from './plan.ts';
import { sharedParked, sharedParkKey, sharedParkNotices } from './reducer.ts';
import { mergeQueue, applicableRules, attestJobs, trunkParked, trunkParkNotices, trunkInvariantReds, awaitingRuling, invalidates, specChanges, driveReviewer, driveReviewerSlot, entriesOf, halted, nextReviewerN, observationsOf, parentRuling, planAt, resumeOf, reviewEpoch, reviewerBase, runId, runLabels, waitingFor, afterNodes, reportRequest, reportedOf, grantHint, writesWaiting, writesWaitCycle } from './reducer.ts';
import { priorCandidateBlock, ruleAnswers, setupFailure } from './reducer.ts';
import { setupSignature, setupHint } from './remeasure-on.ts';
import { dispatchPacket, evidenceCommand, oneLine, ownerCommands, receipt, newFailures, reviewObligations, reviewPacket, reviewRuns, trunkRedHint, sharedCheckHint, mergeFailureHints, reviewAsk, reviewDecision, WRITER_DECISION, writerReply, writerDecisionCommand } from './views.ts';
import { nodeReview, ownerNeeded, dispatchSkip, heldFlaky, flakyBlockText } from './reducer.ts';
export { ownerNeeded } from './reducer.ts';
import type { AttemptRuns, Block, LaunchEntry, NodeSpec, NodeState, ObsEntry, Plan, Rule, RunRole, RunView, SendKind, SendReason, State, SubmitEntry } from './types.ts';

/** One driver action (contract D4). The executor runs them in order; at most one per node per pass. */
export type Action =
  /** `ops.dispatch` as parent:drive; the writer launch follows from the next `decide` (level-triggered). */
  | { do: 'dispatch'; node: string }
  /**
   * Append the LaunchEntry (unless already recorded with these bytes) then `dsa run`; `spec` = exact spec JSON bytes.
   * `rulings` (E4): the highest in-scope ruling seq the task carries, 0 when none; a re-launch copies the recorded value.
   */
  | { do: 'launch'; node: string; attempt: number; role: RunRole; n?: number; rid: string; spec: string; labels: Record<string, string>; rulings?: number }
  /**
   * Append a SendEntry then `dsa send`; `message` = exact message bytes. `send` is present only on a re-send of an
   * already recorded entry (D4 row 4): the executor appends nothing and re-sends `message` with that request id.
   */
  | { do: 'send'; node: string; attempt: number; rid: string; sendKind: SendKind; message: string; reason: SendReason; send?: string; /** reason `ruling` (steer or K5.2 follow-up): the highest ruling seq `message` includes (D22.1); reason `repair` (E4): the highest in-scope ruling seq it carries, 0 when none; reasons `submit`/`rebase` (K5.2): that seq, present only when it carries one. */ rulings?: number }
  /** `owed attest <node>` (through `hold machine` when dsa is available, D6). */
  | { do: 'attest'; node: string }
  /** `ops.rebase` as parent:drive; the `rebase` follow-up to the writer follows from the next `decide`. */
  | { do: 'rebase'; node: string }
  | { do: 'merge'; node: string }
  | { do: 'halt'; node: string; attempt: number; reason: string; needs: 'human' | 'owner' }
  /**
   * Printed only (asking questions); no ledger write. An asking notify (H1.1b) also names the run (`rid`) and its first
   * open question (`qid`, `rev`; absent when dsa reports none), so a wake can be revalidated at delivery time.
   */
  | { do: 'notify'; node: string; text: string; scope?: 'repo'; quiet?: true; answerRetry?: true; invariantRed?: { obligation: string; key: string }; rid?: string; qid?: string; rev?: number; /** F2.2: a notify the executor prints once per value of this key (the environment back-off: once per streak). */ once?: string; /** FL3: runtime receipt, never a ledger entry. */ reportedResume?: number };

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
 * `driveConfig(plan, node)` directly (the node's `drive` over the plan's, K3). The remaining fields are facts only the executor has (in-process, or read from the
 * ledger's blob store); they make the result a pure function of the arguments.
 */
export interface DriveOpts {
  rebasePending?: ReadonlyMap<string, RebasePending>;
  /** WS1: actual sealed-writer worktree facts; absent means inspection failed, never evidence to send submit. */
  writerWork?: ReadonlyMap<string, { head: string; dirty: boolean }>;
  /** SB2: per rebased slot, the actual rebase command from HEAD (also when HEAD is aligned); text only, never a trigger. */
  rebaseWork?: ReadonlyMap<string, RebasePending>;
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
   * Request ids dsa rejected (exit 1), with dsa's reason: run ids (`dsa run`) rejected in this process, and send ids
   * (`dsa send`, e.g. a re-send to a pruned run) rejected in this process or reported rejected by dsa's request state
   * (every pass). Rejected runs stay fixed for the attempt (D15.1). Rejected sends are never retried; row 4 halts only
   * if not superseded (SR1) or exempt (SR2, ruling steer, waiting/ruling notice). A rejected ruling steer delivered
   * nothing to the writer (review #784 F1).
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
  /**
   * G3.7: by node, the paths that conflict between the previous candidate of the slot's latest rebase and its new base
   * (`git merge-tree --write-tree --name-only`; empty: merges cleanly). Absent when unknown (no previous commit, git failed).
   */
  conflicts?: ReadonlyMap<string, readonly string[]>;
  /**
   * 0.7.0 (K6): nodes with a measurement (attest or merge) in flight, from its start until the executor has handled its
   * result. They get no action; their open slots still count toward `max`.
   */
  measuring?: ReadonlySet<string>;
  /**
   * F2.2: the clock (ms since the epoch) the environment back-off compares with; the executor passes `Date.now()`.
   * Absent: no back-off (the node attests as soon as it would without one).
   */
  now?: number;
  /** QN1: runtime notice keys already printed by this driver, so another overdue question can be reported. */
  noticed?: ReadonlySet<string>;
}

/** IF-R1: bounded tail shared by diagnostic policy and blob loading. */
export function recentSetupFailures(s: State, now: number): ObsEntry[] {
  const entries = entriesOf(s), found: ObsEntry[] = [];
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]!, at = Date.parse(e.ts);
    if (Number.isFinite(at) && now - at > 30 * 60_000) break;
    if (!Number.isFinite(at) || at > now || e.kind !== 'obs' || e.by !== 'executor:owed') continue;
    if (setupFailure(s,e)) found.push(e);
  }
  return found;
}
/** IF4: one diagnostic per normalized signature and trunk; no measurement or ledger state is changed. */
export function setupNotices(s: State, blobs: ReadonlyMap<string,string> | undefined, now: number | undefined): { once: string; text: string }[] {
  if (now === undefined || !blobs) return [];
  const groups = new Map<string,{ subjects:Set<string>; nodes:Set<string> }>();
  for (const e of recentSetupFailures(s,now)) {
    if (!e.log || !blobs.has(e.log)) continue;
    const signature = setupSignature(blobs.get(e.log)!);
    const group = groups.get(signature) ?? { subjects:new Set<string>(), nodes:new Set<string>() };
    const subject = e.merging ?? e.subject;
    group.subjects.add(subject); group.nodes.add(subject);
    groups.set(signature,group);
  }
  return [...groups].filter(([,g]) => g.subjects.size >= 2).sort(([a],[b]) => a.localeCompare(b)).map(([signature,g]) => {
    const nodes = [...g.nodes].sort().join(',');
    return { once:`setup\u0000${signature}\u0000${s.trunk.commit}`, text:`setup failure on ${g.subjects.size} trees: ${signature} — probably the environment, not the nodes (${nodes}); fix it, then owed decide ${nodes} --remeasure` };
  });
}

// ---------- spec bytes, tasks and messages (pure, deterministic) ----------
/**
 * Exact dsa spec bytes of a driver launch: canonical JSON (keys sorted, no whitespace) of {agent, model?, cwd,
 * isolation:"none", name?, once:true, task}. The same inputs always give the same bytes, so a retry rebuilds them identically.
 * `name` is dsa's run name (D22.5: `runName`), shown in pi's subagent views.
 */
export function launchSpec(o: { agent: string; model?: string; cwd: string; task: string; name?: string }): string {
  return canonical({ agent: o.agent, ...(o.model !== undefined ? { model: o.model } : {}), cwd: o.cwd, isolation: 'none', ...(o.name !== undefined ? { name: o.name } : {}), once: true, task: o.task });
}
/** dsa run name of a driver launch (D22.5): `owed <node>#<attempt> writer` / `owed <node>#<attempt> reviewer <n>`. */
export const runName = (node: string, attempt: number, role: RunRole, n?: number): string => `owed ${node}#${attempt} ${role}${role === 'reviewer' ? ` ${n}` : ''}`;
/** Rulings covering `node` (`--nodes` names it, or `*`), in ledger order. */
const rulingsInScope = applicableRules;
/** AN3: writer delivery excludes answers to that run, not answers to other runs or acknowledgment scope. */
const writerRid = (s: State, node: string): string | undefined => s.nodes[node]?.runs.find(a => a.attempt === s.nodes[node]?.slot?.attempt)?.launches.find(l => l.role === 'writer')?.rid;
const deliversRule = (r: Rule, rid: string | undefined): boolean => !ruleAnswers(r).some(a => a.rid === rid);
/** E4: the `rulings` field of a message carrying `rules`: their highest seq, 0 when none (seq 0 is the genesis, never a ruling). */
const carried = (rules: readonly { seq: number }[]): number => Math.max(0, ...rules.map(r => r.seq));
/** The rulings a writer's dispatch packet carries: those covering the node recorded before its dispatch. */
const writerRulings = (s: State, node: string, dispatchSeq: number): Rule[] => rulingsInScope(s, node).filter(r => r.seq < dispatchSeq);
/** The writer task of the node's open attempt: its dispatch packet, rebuilt from dispatch-time facts (plan in force, rulings, worktree). */
export function writerTask(s: State, node: string): string {
  const slot = s.nodes[node]?.slot;
  if (!slot) throw new Error(`Node ${node} has no slot`);
  const spec = planAt(s, slot.dispatchSeq).nodes.find(x => x.id === node);
  if (!spec) throw new Error(`Node ${node} is not in the plan of its dispatch #${slot.dispatchSeq}`);
  return dispatchPacket(spec, slot.attempt, slot.worktree, writerRulings(s, node, slot.dispatchSeq), true, s, slot.dispatchSeq);
}
/** Launch action of the writer of the node's open attempt (spec: writer agent/model of `driveConfig(plan, node)`, cwd = slot worktree, task = dispatch packet). */
export function writerLaunch(s: State, node: string, project: string): Extract<Action, { do: 'launch' }> {
  const slot = s.nodes[node]!.slot!, agent = driveConfig(s.plan, node).writer;
  return { do: 'launch', node, attempt: slot.attempt, role: 'writer', rid: runId(project, node, slot.attempt, 'writer'), spec: launchSpec({ ...agent, cwd: slot.worktree, task: writerTask(s, node), name: runName(node, slot.attempt, 'writer') }), labels: runLabels(project, node, slot.attempt, 'writer'), rulings: carried(writerRulings(s, node, slot.dispatchSeq)) };
}
/** Launch action of reviewer run `n` (attempt-global) on the node's current candidate (cwd = repo root, task = review packet, which lists every ruling in scope). */
export function reviewerLaunch(s: State, node: string, n: number, project: string, root: string): Extract<Action, { do: 'launch' }> {
  const slot = s.nodes[node]!.slot!, agent = driveConfig(s.plan, node).reviewer;
  return { do: 'launch', node, attempt: slot.attempt, role: 'reviewer', n, rid: runId(project, node, slot.attempt, 'reviewer', n), spec: launchSpec({ ...agent, cwd: root, task: reviewPacket(s, node, n), name: runName(node, slot.attempt, 'reviewer', n) }), labels: runLabels(project, node, slot.attempt, 'reviewer'), rulings: carried(rulingsInScope(s, node)) };
}
const writerMessage = (text: string): string => text.includes(WRITER_DECISION) ? text : `${text}\n${WRITER_DECISION}`;
export const WRITER_INTERRUPTED = writerMessage('You were interrupted; processes your tools started are gone. Check the worktree (HEAD, git status) before continuing, then commit and `owed submit`.');
export const submitMessage = (node: string): string => writerMessage(`commit your work and run \`owed submit ${node}\`. If you stopped for a parent decision, do not submit: ask the question instead.`);
/** N1.4: the submit follow-up after plan entry `plan` invalidated the latest submit of the attempt (`fields` changed). */
export const planChangedMessage = (node: string, plan: number, fields: readonly string[]): string => writerMessage(`plan #${plan} changed this node's spec (${fields.join(', ') || 'spec'}); resubmit (re-run checks if needed, then \`owed submit ${node}\`)`);
/**
 * N1.4: the first plan entry after submit `after` that invalidated a candidate of `node` (its spec, setup, exec or
 * closure changed), with the changed fields (`specChanges`); undefined when none did.
 */
export function planInvalidated(s: State, node: string, after: number): { plan: number; fields: string[] } | undefined {
  for (const e of entriesOf(s)) {
    if (e.seq <= after || e.kind !== 'plan') continue;
    const prev = planAt(s, e.seq), next = planAt(s, e.seq + 1);
    if (invalidates(prev, next, node)) return { plan: e.seq, fields: specChanges(prev, next, node) };
  }
  return undefined;
}
/**
 * F1.2: the `verdict` follow-up to a driver reviewer run `who` that sealed without recording `awaiting` on candidate
 * `c`: the candidate commit, the obligations still awaiting and per obligation the exact `owed review` command (verdict
 * and rank placeholders).
 */
export function verdictMessage(node: string, c: { seq: number; commit: string }, who: string, awaiting: readonly string[]): string {
  const c12 = c.commit.slice(0, 12);
  return [`You finished without recording your verdict on candidate ${c.commit} (submit #${c.seq}) of ${node}.`,
    `Still awaiting from you: ${awaiting.join(', ')}.`,
    'Record it now, one command per obligation (choose --ok or --block and the rank your packet asks for):',
    ...awaiting.map(o => `owed review ${node} --obligation ${o} --candidate ${c12} --as ${who} --ok|--block --rank <N> --note "<why>"`)].join('\n');
}
export const reviewerInterrupted = (node: string): string => `You were interrupted; check \`owed why ${node} --full\` for reviews you already recorded on this candidate, finish the rest.`;
/**
 * Ending of a halt for a run dsa rejected (D15.1): its id and bytes are fixed for the attempt and dsa answers the
 * same id the same way, so clearing the halt only re-halts; a new attempt is the recovery.
 */
export const rejectedFixed = (node: string): string => `this attempt's request is fixed; fix the cause (plan, agent, model), then \`owed abandon ${node}\` to start a new attempt`;
/** SR4: a rejected send can be superseded without losing the attempt; rejected runs keep D15.1. */
export const rejectedHalt = (node: string, what: 'run' | 'send', id: string, reason: string): string => `dsa rejected ${what} ${id}: ${oneLine(reason)}; ${what === 'run' ? rejectedFixed(node) : `the attempt is not lost: continue the run (e.g. a dsa follow-up), then \`owed decide ${node} --text "<retry run>"\`; a later resume, submit or send to this run supersedes this send; or \`owed abandon ${node}\``}`;
export const fencedMessage = (reason: string): string => writerMessage(`Your previous execution was cut off (${oneLine(reason)}); processes your tools started are gone; rerun anything you were measuring.`);
/**
 * Repair follow-up: what to do, the notes of active review blocks (a needs-parent block quotes the ruling that resolved
 * it, which may predate the dispatch when the block came from an earlier attempt), the rulings covering the node recorded after the attempt's dispatch (D18.4).
 * QT3: only failures recorded after the last send to the writer's run are detailed; older ones still failing are named
 * in one line, and the message points to `owed why <node> --full` instead of embedding the card.
 */
export function repairMessage(s: State, node: string, rejected?: ReadonlyMap<string, string>): string { return repairFollowUp(s, node, rejected).message; }
/**
 * The repair follow-up and the `rulings` its send entry records (E4): the highest seq of the rulings it carries (the
 * rulings since dispatch and the rulings quoted by needs-parent block notes), 0 when none. Both come from one state, so
 * a ruling recorded after this state is never counted as carried.
 */
export function repairFollowUp(s: State, node: string, rejected?: ReadonlyMap<string, string>): { message: string; rulings: number } {
  const n = s.nodes[node]!, entries = entriesOf(s), quoted: Rule[] = [];
  // QT3 (QT-R1 4): only failures recorded after the latest repair follow-up to this writer's run that was not refused;
  // ruling steers, report/rebase/interrupted follow-ups and refused sends do not count. Before the first, all are new.
  const ar = n.runs.find(r => r.attempt === n.slot!.attempt), rid = writerRid(s, node);
  const since = Math.max(-1, ...(ar?.sends ?? []).filter(x => x.rid === rid && x.reason === 'repair' && x.sendKind === 'follow-up' && !rejected?.has(x.send)).map(x => x.seq));
  const active = n.blocks.filter(b => b.kind === 'judgment' && b.state === 'active');
  const notes = active.filter(b => b.seq > since).map(b => {
    const e = entries.find(x => x.seq === b.seq), ruled = b.needs === 'parent' ? parentRuling(s, b) : undefined;
    if (ruled && deliversRule(ruled, writerRid(s, node))) quoted.push(ruled);
    return `- #${b.seq} ${b.obligation} by ${e?.by ?? '?'} rank ${b.rank}${b.needs === 'parent' ? (ruled ? ` (needed a parent ruling; ruling #${ruled.seq}${deliversRule(ruled, writerRid(s, node)) ? `: ${ruled.text}` : ''})` : ' (needs a parent ruling)') : ''}: ${oneLine(e?.kind === 'review' ? e.note ?? '' : '')}`;
  });
  const scoped = rulingsInScope(s, node).filter(r => r.seq > n.slot!.dispatchSeq && deliversRule(r, writerRid(s, node))), rulings = scoped.map(r => `- #${r.seq} ${r.text}`);
  const failed = newFailures(receipt(s, entries, node), since);
  failed.lines.push(...n.blocks.filter(b => b.state === 'flaky' && !heldFlaky(s,node,b)).map(b => `- ${flakyBlockText(s,b)}`));
  const earlier = [...new Set([...failed.earlier, ...active.filter(b => b.seq <= since).map(b => b.obligation)])];
  // K5.2: the rulings come first.
  return { rulings: carried([...scoped, ...quoted]), message: [...(rulings.length ? ['Rulings since dispatch:', ...rulings] : []),
    `owed found problems with your candidate of ${node}.`,
    ...n.blocks.filter(b => b.kind === 'exec' && (b.state === 'active' || b.state === 'flaky')).flatMap(b => { const hint = trunkRedHint(s,b.seq,b.key) ?? sharedCheckHint(s,b); return hint ? [`${hint}; the failure also occurs on trunk; ask the parent instead of changing code outside your writes.`] : []; }),
    ...(failed.lines.length ? ['Failures new since my last message:', ...failed.lines] : []),
    ...(notes.length ? ['Review blocks (the reviewer\'s note):', ...notes] : []),
    ...(!failed.lines.length && !notes.length ? ['No new failures since my last message.'] : []),
    ...(earlier.length ? [`Still failing from before: ${earlier.join(', ')}.`] : []),
    `Next: fix them in your worktree, commit, and run \`owed submit ${node}\`; owed reruns the checks itself. Everything else: \`owed why ${node} --full\`.`, WRITER_DECISION].join('\n') };
}
/** G3.7: the conflicting-files clause of a rebase instruction; empty when the list is unknown. */
const conflictText = (conflicts?: readonly string[]): string => conflicts ? ` (files that conflict with your previous candidate: ${conflicts.length ? conflicts.join(', ') : 'none'})` : '';
/**
 * Rebase follow-up after the slot's latest rebase (stable: it names the rebase entry's bases, not the current trunk).
 * `conflicts` (G3.7): the paths that conflict between the previous candidate and the new base, when known.
 */
export function rebaseMessage(s: State, node: string, conflicts?: readonly string[], work?: RebasePending): string {
  const slot = s.nodes[node]!.slot!, r = slot.rebase!;
  if (executorRebased(s,node)) return writerMessage(`owed rebased your worktree onto ${r.base.slice(0,12)} (clean); continue from HEAD`);
  return writerMessage(`${work?.recovery ? `${work.recovery}\n` : ''}trunk moved; rebase your worktree onto ${s.trunk.name} (${r.base}): first commit your work, then in ${slot.worktree} run \`${work?.command ?? `git rebase --onto ${r.base} $(git merge-base HEAD ${r.base})`}\`${conflictText(conflicts)}, resolve conflicts within the allowed writes, rerun checks, commit, then \`owed submit ${node}\``);
}
/** ER2: latest successful automatic rebase, unless a subsequent rebase changed the slot again. */
function executorRebased(s: State, node: string): boolean {
  const rb = s.nodes[node]?.slot?.rebase;
  const submitted = rb && entriesOf(s).find(e => e.seq === rb.seq + 1);
  return submitted?.kind === 'submit' && submitted.node === node && submitted.by === 'executor:owed' && submitted.facts.rebased === true;
}
/** The latest submit of the node's open attempt (also one a plan change or rebase no longer counts as the candidate). */
const lastSubmit = (s: State, node: string): SubmitEntry | undefined => {
  const attempt = s.nodes[node]!.slot!.attempt;
  return entriesOf(s).findLast((e): e is SubmitEntry => e.kind === 'submit' && e.node === node && e.attempt === attempt);
};
/**
 * G3.2: the active review blocks the driver would repair when it must ask the writer for a new candidate (row 8: no
 * current candidate after a plan change or a rebase): recorded in this attempt on the key of its latest submit, and not
 * awaiting a parent ruling. Owner blocks never reach row 8 (`ownerNeeded` notifies first).
 */
export function resubmitBlocks(s: State, node: string): Block[] { return submitBlocks(s, node).filter(b => !awaitingRuling(s, b)); }
/** Active judgment blocks recorded in this attempt on the key of its latest submit. */
function submitBlocks(s: State, node: string): Block[] {
  const n = s.nodes[node]!, last = lastSubmit(s, node);
  if (!last) return [];
  return n.blocks.filter(b => b.kind === 'judgment' && b.state === 'active' && b.seq > n.slot!.dispatchSeq && b.key === last.facts.keys[b.obligation]);
}
/**
 * F4 (wais #33c): the needs-parent review blocks the driver halts on until a ruling names the node: on the current
 * candidate's keys (D18), else on the latest submit's (row 8). Empty without an open slot. `owed resume` refuses on them.
 */
export function unruledBlocks(s: State, node: string): Block[] {
  const n = s.nodes[node], c = n?.candidate;
  if (!n?.slot?.open) return [];
  return c ? n.blocks.filter(b => b.kind === 'judgment' && b.key === c.keys[b.obligation] && awaitingRuling(s, b)) : submitBlocks(s, node).filter(b => awaitingRuling(s, b));
}
/**
 * G3.7 / review #680 (b): whether row 8 can use the conflict list of `node` this pass (so the executor computes it only
 * then): the slot was rebased after its latest submit and recorded a previous candidate, no current candidate, the
 * writer run is sealed ok, and no rebase or repair follow-up was sent after the rebase entry.
 */
export function wantsRebaseConflicts(s: State, node: string, runs: ReadonlyMap<string, RunView>): boolean {
  const n = s.nodes[node], slot = n?.slot, rb = slot?.rebase;
  if (!n || !slot?.open || n.candidate || !rb?.previous || rb.seq < (lastSubmit(s, node)?.seq ?? -1)) return false;
  const ar = n.runs.find(r => r.attempt === slot.attempt), writer = ar?.launches.find(l => l.role === 'writer'), w = writer && runs.get(writer.rid);
  return !!w && isSealed(w) && statusOf(w) === 'ok' && !ar!.sends.some(x => (x.reason === 'rebase' || x.reason === 'repair') && x.seq > rb.seq);
}
/**
 * G3.2: the one follow-up (reason `repair`) that replaces row 8's `submit` / `rebase` follow-up while `resubmitBlocks`
 * is not empty: the rulings in scope since dispatch (and those quoted by needs-parent blocks), the blocks with their
 * notes, why a new candidate is needed (plan changed, or trunk moved with the rebase instructions), then commit and
 * submit. `rulings` (E4): the highest seq it carries, 0 when none.
 */
export function resubmitFollowUp(s: State, node: string, conflicts?: readonly string[], work?: RebasePending): { message: string; rulings: number } {
  const n = s.nodes[node]!, slot = n.slot!, last = lastSubmit(s, node)!, entries = entriesOf(s), quoted: Rule[] = [];
  const notes = resubmitBlocks(s, node).map(b => {
    const e = entries.find(x => x.seq === b.seq), ruled = b.needs === 'parent' ? parentRuling(s, b) : undefined;
    if (ruled && deliversRule(ruled, writerRid(s, node))) quoted.push(ruled);
    return `- #${b.seq} ${b.obligation} by ${e?.by ?? '?'} rank ${b.rank}${ruled ? ` (needed a parent ruling; ruling #${ruled.seq})` : ''}: ${oneLine(e?.kind === 'review' ? e.note ?? '' : '')}`;
  });
  const since = rulingsInScope(s, node).filter(r => r.seq > slot.dispatchSeq && deliversRule(r, writerRid(s, node)));
  const rules = [...since, ...quoted.filter(q => !since.some(r => r.seq === q.seq))].sort((a, b) => a.seq - b.seq);
  const rb = slot.rebase && slot.rebase.seq > last.seq ? slot.rebase : undefined;
  return { rulings: carried(rules), message: [
    ...(rules.length ? [`Parent rulings for ${node} (apply them; they override your packet):`, ...rules.map(r => `- #${r.seq} ${r.text}`)] : []),
    `Review blocks on your candidate ${last.facts.commit} (submit #${last.seq}) of ${node}, attempt ${slot.attempt} (the reviewer's note):`, ...notes,
    ...(rb && work?.recovery ? [work.recovery] : []),
    rb ? `Trunk moved, so owed needs a new candidate: rebase your worktree onto ${s.trunk.name} (${rb.base}): first commit your work, then in ${slot.worktree} run \`${work?.command ?? `git rebase --onto ${rb.base} $(git merge-base HEAD ${rb.base})`}\`${conflictText(conflicts)} and resolve conflicts within the allowed writes.`
      : 'The plan changed since that candidate, so owed needs a new candidate; owed reruns the checks itself.',
    `Fix the blocks in your worktree, commit, and run \`owed submit ${node}\`.`, WRITER_DECISION].join('\n') };
}

// ---------- repair budget, ruling follow-up, threshold hint (0.7, K5) ----------
/** The node spec as the repair epoch compares it: canonical, without `title` and `drive` (K3); `brief` counts. */
const epochSpec = (p: Plan, node: string): string | undefined => {
  const n = p.nodes.find(x => x.id === node);
  if (!n) return undefined;
  const { title: _t, drive: _d, ...rest } = n;
  return canonical(rest);
};
/**
 * K5.1: the repair budget epoch of the node's open attempt: the latest of its dispatch, the latest ruling naming the
 * node (`*` does not count), the latest resume of the attempt (0.8, L1.2) and the latest plan entry that changed its
 * spec (`epochSpec`). `repairs` counts the attempt's repair sends after it; `label` is `ruling #s`, `resume #s`,
 * `plan #s` or `dispatch`.
 */
export function repairEpoch(s: State, node: string): { seq: number; label: string } {
  let best = { seq: s.nodes[node]!.slot!.dispatchSeq, label: 'dispatch' };
  const rule = rulingsInScope(s, node).findLast(r => r.nodes !== '*' && r.nodes.includes(node));
  if (rule && rule.seq > best.seq) best = { seq: rule.seq, label: `ruling #${rule.seq}` };
  // 0.8 (L1.2): the latest resume of the open attempt starts a new epoch too.
  const resume = resumeOf(s, node);
  if (resume && resume.seq > best.seq) best = { seq: resume.seq, label: `resume #${resume.seq}` };
  for (const e of [...entriesOf(s)].reverse()) {
    if (e.seq <= best.seq) break;
    if (e.kind === 'plan' && epochSpec(planAt(s, e.seq), node) !== epochSpec(planAt(s, e.seq + 1), node)) { best = { seq: e.seq, label: `plan #${e.seq}` }; break; }
  }
  return best;
}
/** K5.1: the repair sends of the attempt counted against `repairs`: those after the node's epoch. */
const repairsSince = (s: State, node: string, ar: AttemptRuns): { count: number; label: string } => {
  const epoch = repairEpoch(s, node);
  return { count: ar.sends.filter(x => x.reason === 'repair' && x.seq > epoch.seq).length, label: epoch.label };
};
/**
 * K5.2: the in-scope rulings the attempt's writer run `writer` has not received (`deliveredRulings`, without the sends
 * in `refused`: dsa rejected them, review #784 F1), in ledger order.
 */
const undelivered = (s: State, node: string, ar: AttemptRuns, writer: LaunchEntry, refused?: Refused): Rule[] => {
  const d = deliveredRulings(s, node, ar, writer, refused);
  return rulingsInScope(s, node).filter(r => r.seq > d && deliversRule(r,writer.rid));
};
/** LO-W4: the rulings the slot writer may still need, for why's manual forwarding section. */
export function rulingToForward(s: State, node: string): string | undefined {
  const n = s.nodes[node], slot = n?.slot;
  if (!n || !slot?.open || n.merged) return undefined;
  const ar = n.runs.find(r => r.attempt === slot.attempt), writer = ar?.launches.find(l => l.role === 'writer');
  let rules: Rule[];
  if (ar && writer) rules = undelivered(s, node, ar, writer);
  else {
    const submitted = entriesOf(s).findLast(e => e.kind === 'submit' && e.node === node && e.attempt === slot.attempt && e.by === slot.writer);
    const since = Math.max(slot.rulings_seen, submitted?.seq ?? -1);
    rules = rulingsInScope(s, node).filter(r => r.seq > since);
  }
  return rules.length ? rulingMessage(node, 'writer', rules) : undefined;
}
/**
 * K5.2: a writer follow-up (`submit`, `rebase`) with the undelivered in-scope rulings first; `rulings` (their highest
 * seq) only when it carries at least one, so a follow-up without rulings stays readable by 0.6.x.
 */
function withRulings(s: State, node: string, ar: AttemptRuns, writer: LaunchEntry, message: string, refused?: Refused): { message: string; rulings?: number } {
  const rules = undelivered(s, node, ar, writer, refused);
  return rules.length ? { message: [`Parent rulings for ${node} (apply them; they override your packet):`, ...rules.map(r => `- #${r.seq} ${r.text}`), message].join('\n'), rulings: carried(rules) } : { message };
}
/** One evidence line of a halt (K5.4): one line, at most 200 characters. */
const clip = (text: string): string => { const t = oneLine(text); return t.length > 200 ? `${t.slice(0, 199)}…` : t; };
/**
 * K5.2: the ruling follow-up to the attempt's sealed writer, or undefined when no undelivered in-scope ruling names the
 * node (`*` alone never triggers it): the undelivered in-scope rulings, the active blocks on the current candidate's
 * keys (else the latest submit's) with their notes, then what to do. `rulings`: the highest seq it carries. Not a repair.
 */
export function rulingFollowUp(s: State, node: string, refused?: Refused): { message: string; rulings: number } | undefined {
  const n = s.nodes[node], slot = n?.slot, ar = n?.runs.find(r => r.attempt === slot?.attempt), writer = ar?.launches.find(l => l.role === 'writer');
  if (!n || !slot || !ar || !writer) return undefined;
  const rules = undelivered(s, node, ar, writer, refused);
  if (!rules.some(r => r.nodes !== '*')) return undefined;
  return { rulings: carried(rules), message: [`New parent rulings for ${node}:`, ...rulingLines(rules),
    ...blockLines(s, node), `Apply these rulings; they override your packet. Then commit and run \`owed submit ${node}\`.`, WRITER_DECISION].join('\n') };
}
/**
 * The block lines of a writer ruling message (`rulingFollowUp`, and the re-send after a resume, G3.5 0.12): the active
 * blocks on the current candidate's keys (else the latest submit's) with their notes, then (0.8, L3.1) the node's flaky
 * blocks whatever candidate they came from (the ruling may ask to fix the test); each group under its header.
 */
function blockLines(s: State, node: string): string[] {
  const n = s.nodes[node]!, last = lastSubmit(s, node), c = n.candidate ?? (last ? { ...last.facts, seq: last.seq } : undefined), entries = entriesOf(s);
  const blocks = c ? n.blocks.filter(b => b.state === 'active' && b.key === c.keys[b.obligation]) : [];
  const line = (b: Block): string => {
    const e = entries.find(x => x.seq === b.seq);
    const note = e?.kind === 'review' ? e.note ?? '' : e?.kind === 'obs' ? e.note ?? `exit ${e.exit}` : '';
    const diagnosis = trunkRedHint(s,b.seq,b.key) ?? sharedCheckHint(s,b);
    if (diagnosis) return `- ${diagnosis}${b.state === 'flaky' ? `; ${flakyBlockText(s,b)}` : ''}${note ? ` — note: ${oneLine(note)}` : ''}`;
    return `- #${b.seq} ${b.obligation}${b.kind === 'judgment' ? ` by ${e?.by ?? '?'} rank ${b.rank}` : ''}: ${oneLine(note)}`;
  };
  const notes = blocks.map(line), flaky = n.blocks.filter(b => b.state === 'flaky' && !heldFlaky(s,node,b)).map(b => {
    const e = entries.find(x => x.seq === b.seq);
    return trunkRedHint(s,b.seq,b.key) || sharedCheckHint(s,b) ? line(b) : e?.kind === 'obs' ? `- ${flakyBlockText(s,b)}${e.note ? ` — note: ${oneLine(e.note)}` : ''}` : line(b);
  });
  return [...(notes.length ? [`Active blocks on your candidate ${c!.commit} (submit #${c!.seq}):`, ...notes] : []),
    ...(flaky.length ? [`Flaky blocks of ${node} (an attribution rerun of the failing content passed):`, ...flaky] : [])];
}
/**
 * 0.8 (L3.1): at the stalled point of a candidate whose only debt is `rulings` (every reviewer run of it sealed), the
 * undelivered in-scope rulings go to a reviewer, whose ok review with --ack-rulings discharges `rulings`: a `ruling`
 * follow-up to the latest driver reviewer run of the candidate (`reviewers`), or, when there is none, a reviewer launch
 * (row 12; its packet lists every ruling in scope). Undefined when no applicable ruling is undelivered to that
 * run (sent once), or the candidate has no review obligation an ack could be recorded on.
 */
function reviewerRuling(s: State, n: NodeState, ar: AttemptRuns, reviewers: readonly LaunchEntry[], opts: DriveOpts): Action | undefined {
  const c = n.candidate!, inScope = rulingsInScope(s, n.id);
  if (!n.items.some(i => i.obligation === 'review' || i.obligation === 'closure-review')) return undefined;
  const l = reviewers.at(-1);
  const acked = Math.max(n.slot!.rulings_seen, ...entriesOf(s).flatMap(e => e.kind === 'review' && e.node === n.id && e.verdict === 'ok' && (e.key === c.keys[e.obligation] || c.carry?.reviews.includes(e.seq)) ? [e.ack_rulings ?? -1] : []));
  if (!l) return inScope.some(r => r.seq > acked) ? reviewerLaunch(s, n.id, nextReviewerN(s, n.id), opts.project, opts.root) : undefined;
  const delivered = deliveredRulings(s, n.id, ar, l, opts.rejected);
  if (!inScope.some(r => r.seq > delivered) && !answerAckDue(s, n, ar, l, opts.rejected)) return undefined;
  // AN3 / #1266: acknowledgment covers every in-scope ruling, including already delivered answers.
  const rules = inScope, top = carried(rules);
  return { do: 'send', node: n.id, attempt: n.slot!.attempt, rid: l.rid, sendKind: 'follow-up', reason: 'ruling', rulings: top, message: [`New parent rulings for ${n.id}:`, ...rulingLines(rules),
    `Re-review the current candidate ${c.commit} (submit #${c.seq}) in their light and record your verdict with --ack-rulings ${top}; block if the writer must change something.`].join('\n') };
}
/**
 * K5.4: the evidence of the measured items `items` for a halt: per failing observation that decides them (active
 * execution blocks and failing evidence), `#<obs> <obligation>: <note>`, each one line of at most 200 characters.
 */
function execEvidence(s: State, n: NodeState, items: readonly { obligation: string; evidence: number[] }[]): string[] {
  const entries = entriesOf(s), out: string[] = [], seen = new Set<number>();
  for (const i of items) {
    const seqs = [...n.blocks.filter(b => b.kind === 'exec' && b.state === 'active' && b.obligation === i.obligation).map(b => b.seq), ...i.evidence];
    for (const seq of seqs) {
      const o = entries.find(e => e.seq === seq);
      if (seen.has(seq) || o?.kind !== 'obs' || o.verdict !== 'fail') continue;
      // RC3: keep every bounded failed name and the (at most 15-line) tail ahead of generic clipping.
      seen.add(seq); out.push(o.failed?.length ? `#${o.seq} ${o.obligation}: ${o.note ?? `failed tests: ${o.failed.map(oneLine).join(', ')}`}` : clip(`#${o.seq} ${o.obligation}: ${o.note ?? `exit ${o.exit}`}`));
    }
  }
  return out.sort((a, b) => Number(a.slice(1, a.indexOf(' '))) - Number(b.slice(1, b.indexOf(' '))));
}
/**
 * K5.3: the threshold hint for the measured items, or undefined: for a check X among them, the node's latest two
 * failing, non-attribution observations of `check:X` both exited 0 with no failing test and counted the same number of
 * tests, below X's current `min_tests`, and no ruling naming the node (not `*`) was recorded after the later one (after
 * such a ruling the repair path runs).
 */
export function thresholdHint(s: State, node: string, obligations: readonly string[]): string | undefined {
  const spec = s.plan.nodes.find(x => x.id === node), named = rulingsInScope(s, node).findLast(r => r.nodes !== '*' && r.nodes.includes(node));
  for (const o of obligations) {
    if (!o.startsWith('check:')) continue;
    const x = o.slice(6), m = spec?.checks.find(c => c.id === x)?.min_tests;
    if (m === undefined) continue;
    const fails = entriesOf(s).filter((e): e is ObsEntry => e.kind === 'obs' && e.probe === undefined && e.subject === node && e.obligation === o && e.verdict === 'fail' && !e.attribution).slice(-2);
    if (fails.length < 2 || (named && named.seq > fails[1]!.seq)) continue;
    const [a, b] = fails as [ObsEntry, ObsEntry];
    const tests = a.counts?.tests;
    if (a.exit !== 0 || b.exit !== 0 || a.counts?.fail !== 0 || b.counts?.fail !== 0 || tests === undefined || b.counts.tests !== tests || tests >= m) continue;
    return `check ${x}: ${tests} tests ran and passed twice, below min_tests ${m}; the plan's threshold may be wrong: fix the plan (owed plan) or decide (owed decide ${node} --text "…")`;
  }
  return undefined;
}

// ---------- environment back-off (0.11, F2.2) ----------
/** F2.2: an error observation whose note starts with `environment: ` (disk full, tree preparation failed). */
export const isEnvironment = (o: ObsEntry): boolean => o.verdict === 'error' && (o.note ?? '').startsWith('environment: ');
/** F2.2: the back-off after the n-th consecutive environment error of an item (n >= 1), in minutes: 1, 2, 5, 10, then 30. */
export const BACKOFF_MIN = [1, 2, 5, 10, 30] as const;
export const backoffMs = (n: number): number => BACKOFF_MIN[Math.min(Math.max(n, 1), BACKOFF_MIN.length) - 1]! * 60_000;
/** F2.2: the wait of a node's next attest: the latest environment error (`latest`), its streak step, retry time and streak start. */
export interface EnvironmentWait { latest: ObsEntry; step: number; until: number; streak: number }
/**
 * F2.2: per item of `jobs` (subject, obligation, key), its streak: the consecutive environment errors at the end of its
 * observations since the latest resume (`resumed`). The node waits `backoffMs(step)` after the latest such error of all
 * items; undefined when no item ends in an environment error.
 */
export function environmentWait(s: State, jobs: readonly { subject: string; obligation: string; key: string }[], resumed: number): EnvironmentWait | undefined {
  let best: EnvironmentWait | undefined;
  for (const j of jobs) {
    const obs = observationsOf(s, j.subject, j.obligation, j.key).filter(o => o.seq > resumed);
    let i = obs.length;
    while (i > 0 && isEnvironment(obs[i - 1]!)) i--;
    const streak = obs.slice(i);
    if (!streak.length) continue;
    const latest = streak.at(-1)!, step = streak.length, until = Date.parse(latest.ts) + backoffMs(step);
    if (!best || latest.seq > best.latest.seq) best = { latest, step, until, streak: streak[0]!.seq };
  }
  return best;
}
/** F2.2: the notify of a node whose attest waits after an environment error: the note and the retry time. */
export const environmentText = (node: string, w: EnvironmentWait): string =>
  `${node}: environment failure #${w.latest.seq} ${w.latest.obligation}: ${clip(w.latest.note ?? '')}; attest waits (${w.step} in a row), retry at ${clockTime(w.until)}; the driver does not halt for it (free the disk or fix the setup; owed decide ${node} --resume --text "<retry setup>" retries at once)`;

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
  return k !== undefined && k <= Math.max(nodeReview(s, node).count, 1) ? k : undefined;
}

// ---------- owner-needed ----------
/** D25.6: the commands that resolve an owner decision on `node`, as one clause addressed to the main agent. */
const resolveText = (s: State, node: string): string => { const c = ownerCommands(s, node); return c.length ? `; the main agent resolves it with: ${c.join(' | ')}` : `; the main agent decides: owed why ${node}`; };
// The reason's own trailing `needs the owner` (ownerNeeded) is dropped: the prefix already says it.
const ownerNotify = (s: State, node: string, reason: string): Action => {
  const diagnoses = s.nodes[node]!.blocks.filter(b => b.state === 'active' || b.state === 'flaky').flatMap(b => trunkRedHint(s,b.seq,b.key) ?? sharedCheckHint(s,b) ?? []);
  return { do:'notify', node, text:`${node}: needs the owner (the main agent decides; owed lists the command): ${[...diagnoses,oneLine(reason.replace(/ needs the owner$/, ''))].join('; ')}; the driver leaves it alone${resolveText(s,node)}` };
};

// ---------- decide ----------
/** FL3: bounded writer report, raw text rather than a flattened log tail. */
export const reportTail = (text: string): string => text.split('\n').slice(-40).join('\n').slice(-4000);
export const REPORT_MESSAGE = 'report your findings and stop; do not submit unless the parent asks';
const isSealed = (v: RunView): boolean => v.state === 'sealed' || v.state === 'pruned';
const statusOf = (v: RunView): string => v.status ?? 'unknown';
const reviewerN = (l: LaunchEntry): number => Number(l.rid.slice(l.rid.lastIndexOf(':') + 1));
/** Status order of `owed status`: more dependents first, then id. */
const byStatusOrder = (a: NodeState, b: NodeState): number => b.dependents - a.dependents || a.id.localeCompare(b.id);

/** MO2: replace only merge positions, keeping all other actions in status order. */
function orderMergeActions(s: State, actions: Action[]): Action[] {
  const ranks = new Map(mergeQueue(s).map((id, i) => [id, i]));
  const merges = actions.filter(a => a.do === 'merge').sort((a, b) => ranks.get(a.node)! - ranks.get(b.node)!);
  let i = 0;
  return actions.map(a => a.do === 'merge' ? merges[i++]! : a);
}

/**
 * The actions of one pass (contract D1/D4/D10/D11): per open attempt the first matching row of the policy table, then
 * dispatches of ready nodes while open attempts < `max`. Pure: equal inputs give deep-equal outputs; inputs are not
 * modified. A node whose recorded run lacks a view in `runs` (describe failed) gets no action this pass, nor does a node
 * in `opts.measuring` (a measurement in flight, K6).
 * The plan is read from `s.plan` only (D11); the `plan` parameter is kept for the D1 signature and not used.
 */
export function decide(s: State, _plan: Plan, runs: ReadonlyMap<string, RunView>, opts: DriveOpts): Action[] {
  if (s.seq < 0) return [];
  const plan = s.plan;
  const out: Action[] = [];
  // F4 / ruling #1431: removed nodes get no action, including prospective notices; the parent closes their slots.
  const open = Object.values(s.nodes).filter(n => n.slot?.open && n.phase !== 'removed').sort(byStatusOrder);
  for (const n of open) {
    const ar = n.runs.find(r => r.attempt === n.slot!.attempt) ?? { attempt: n.slot!.attempt, launches: [], sends: [] };
    const notice = trunkParked(s, n.id).length || sharedWaiting(s, n.id, opts) ? undefined : prospectiveNotice(s, n, ar, runs, opts);
    const a = opts.measuring?.has(n.id) ? undefined : slotAction(s, runs, opts, n);
    if (notice) {
      // #1743/#1746: PR2 cannot preempt a concrete question's first non-quiet report (or overdue answer retry).
      // Reporting does not answer or quiet it; remember this revision only in runtime. Generic asks keep PR2 first.
      if (a?.do === 'notify' && !a.quiet && a.rid && (a.qid || a.answerRetry) && runs.get(a.rid)?.state === 'asking') {
        const once = a.once ?? `asking-notice\u0000${a.rid}\u0000${a.qid}\u0000${a.rev ?? ''}`;
        if (!opts.noticed?.has(once)) { out.push({ ...a, once }); continue; }
      }
      out.push(notice); continue;
    }
    if (a) out.push(a);
  }
  // Not per slot: dispatch ready nodes in status order while open attempts < max, skipping writes overlaps and owner-needed nodes.
  const taken = open.map(n => n.id);
  for (const n of Object.values(s.nodes).filter(n => n.phase === 'ready').sort(byStatusOrder)) {
    const skip = dispatchSkip(s, n.id, opts.max, taken);
    if (skip?.kind === 'owner') out.push(ownerNotify(s, n.id, skip.reason));
    if (skip) continue;
    out.push({ do: 'dispatch', node: n.id });
    taken.push(n.id);
  }
  for (const red of trunkParkNotices(s)) if (!opts.noticed?.has(red.once)) out.push({ do: 'notify', node: red.obligation, scope: 'repo', text: red.text, once: red.once });
  for (const red of sharedParkNotices(s)) if (!opts.noticed?.has(red.once)) out.push({ do: 'notify', node: red.obligation, scope: 'repo', text: red.text, once: red.once });
  for (const notice of setupNotices(s,opts.blobs,opts.now)) if (!opts.noticed?.has(notice.once)) out.push({ do:'notify', node:'trunk', scope:'repo', ...notice });
  for (const red of trunkInvariantReds(s)) out.push({ do:'notify', node:red.obligation, scope:'repo', invariantRed:{obligation:red.obligation,key:red.key}, text:red.text, once:`inv-red\u0000${red.obligation}\u0000${red.key}` });
  return orderMergeActions(s, out);
}

/**
 * FS3/FS5 (level-triggered): `id` is parked on a shared failure and either waits for an accepted fix node or this
 * driver already saw its merge refused on the same trunk commit, trunk invariant items, plan and candidate.
 */
export function sharedWaiting(s: State, id: string, opts: Pick<DriveOpts, 'noticed'>): boolean {
  if (halted(s, id)) return false;
  const parks = sharedParked(s, id);
  return parks.length > 0 && (parks.some(p => p.fix !== undefined) || !!opts.noticed?.has(sharedParkKey(s, id)));
}
/** QT5: how long an answered question may stay open on the subagent host before owed says so (default 10 minutes). */
export const answerGraceMs = (s: State): number => (s.plan.drive?.answer_grace_s ?? 600) * 1000;
/**
 * QT5: an answered question the subagent host still lists as open after the grace, in status, wakes and Needs-you:
 * `<node>: answered at #<seq> (HH:MM), still asking after <m>m: retry with <the exact answer retry>`.
 */
export function stillAskingText(node: string, e: import('./types.ts').RuleEntry, now: number): string {
  const minutes = Math.max(0, Math.floor((now - Date.parse(e.ts)) / 60_000));
  return `${node}: answered at #${e.seq} (${clockTime(e.ts, now)}), still asking after ${minutes}m: retry with ${answerRetry(node, e)}`;
}
/** QT5: one answered question the subagent host still lists as open after the grace (a runtime fact, never a ledger entry). */
export interface StillAsking { node: string; rid: string; qid: string; rev: number }
/** QT5: the answered questions of open attempts that the described runs still ask after the grace, at `now`. */
export function stillAsking(s: State, runs: ReadonlyMap<string, RunView>, now: number): StillAsking[] {
  const out: StillAsking[] = [];
  for (const n of Object.values(s.nodes)) {
    if (!n.slot?.open || n.merged) continue;
    for (const l of n.runs.find(r => r.attempt === n.slot!.attempt)?.launches ?? []) {
      const v = runs.get(l.rid);
      if (v?.state !== 'asking') continue;
      for (const q of v.questions ?? []) {
        const e = answeredQuestion(s, l.rid, q.qid, q.rev);
        if (e && now - Date.parse(e.ts) >= answerGraceMs(s)) out.push({ node: n.id, rid: l.rid, qid: q.qid, rev: q.rev });
      }
    }
  }
  return out;
}
/** QT5: the recorded still-asking facts that remain true for `s` at `now`, with their Needs-you text. */
export function stillAskingNeeds(s: State, asking: readonly StillAsking[], now: number): { node: string; text: string }[] {
  return asking.flatMap(a => {
    const n = s.nodes[a.node];
    if (!n?.slot?.open || n.merged || !n.runs.find(r => r.attempt === n.slot!.attempt)?.launches.some(l => l.rid === a.rid)) return [];
    const e = answeredQuestion(s, a.rid, a.qid, a.rev);
    return e && now - Date.parse(e.ts) >= answerGraceMs(s) ? [{ node: a.node, text: stillAskingText(a.node, e, now) }] : [];
  });
}
/** QN1: a durable answer covers that question at its recorded revision and older revisions. */
export function answeredQuestion(s: State, rid: string, qid: string, rev?: number) {
  const e = entriesOf(s).findLast(e => e.kind === 'rule' && ruleAnswers(e).some(a => a.rid === rid && a.qid === qid && (rev === undefined || rev <= a.rev))) as import('./types.ts').RuleEntry | undefined;
  return e ? { ...e, answer:ruleAnswers(e).find(a => a.rid === rid && a.qid === qid)! } : undefined;
}

function slotAction(s: State, runs: ReadonlyMap<string, RunView>, opts: DriveOpts, n: NodeState): Action | undefined {
  const id = n.id, slot = n.slot!, attempt = slot.attempt, c = n.candidate;
  const halt = (reason: string, needs: 'human' | 'owner' = 'human'): Action => ({ do: 'halt', node: id, attempt, reason, needs });
  const stoppedHalt = (reason: string): Action => halt(`${reason}; ${writerReply(writerView?.result)} → ${writerDecisionCommand(id)}`);
  // 0.8 (L1.3): the first writer follow-up after a resume starts with the resume line (`resumeLine`).
  const send = (l: LaunchEntry, sendKind: SendKind, reason: SendReason, message: string, rulings?: number): Action => {
    const line = l.role === 'writer' && sendKind === 'follow-up' ? resumeLine(s, id, l.rid) : undefined;
    const firstRebaseFollowUp = slot.rebase && !ar.sends.some(x => x.seq > slot.rebase!.seq && x.sendKind === 'follow-up' && ar.launches.some(run => run.role === 'writer' && run.rid === x.rid));
    if (line && resumeOf(s, id)?.expect === 'report') {
      const rules = undelivered(s, id, ar, l, opts.rejected);
      const rebase = firstRebaseFollowUp
        ? rebaseMessage(s,id,opts.conflicts?.get(id),opts.rebasePending?.get(id) ?? opts.rebaseWork?.get(id)).replace(`, rerun checks, commit, then \`owed submit ${id}\``, '') : undefined;
      return { do: 'send', node: id, attempt, rid: l.rid, sendKind, reason: 'report', message: writerMessage([line, ...rules.map(r => `Ruling #${r.seq}: ${r.text}`), ...(rebase ? [rebase] : []), REPORT_MESSAGE].join('\n')), rulings: carried(rules) };
    }
    const rebased = l.role === 'writer' && sendKind === 'follow-up' && reason !== 'rebase' && firstRebaseFollowUp && executorRebased(s,id) ? rebaseMessage(s,id) : undefined;
    message = rebased ? `${rebased}\n${message}` : message;
    if (l.role === 'writer') message = writerMessage(message);
    return { do: 'send', node: id, attempt, rid: l.rid, sendKind, message: line ? `${line}\n${message}` : message, reason, ...(rulings !== undefined ? { rulings } : {}) };
  };
  // Row 5: a run asking: notify (question, answer address); the driver never answers.
  // H1.1b: the report carries rid and the first question's qid/rev; its text is askingText, then (F1.3) `askingRule`.
  const asking = (l: LaunchEntry, v: RunView): Action => {
    const questions = v.questions ?? [], open = questions.filter(q => !answeredQuestion(s, l.rid, q.qid, q.rev));
    const answers = questions.flatMap(q => answeredQuestion(s, l.rid, q.qid, q.rev) ?? []);
    const overdue = answers.find(e => !opts.noticed?.has(`answer-grace\u0000${l.rid}\u0000${e.answer!.qid}`)
      && opts.now !== undefined && opts.now - Date.parse(e.ts) >= answerGraceMs(s));
    if (overdue) {
      const q = overdue.answer!;
      return { do: 'notify', node: id, rid: l.rid, qid: q.qid, rev: questions.find(q => q.qid === overdue.answer!.qid)!.rev, answerRetry: true, once: `answer-grace\u0000${l.rid}\u0000${q.qid}`, text: stillAskingText(id, overdue, opts.now!) };
    }
    if (questions.length && !open.length) {
      const e = answers[0]!;
      return { do: 'notify', node: id, quiet: true, once: `answered\u0000${l.rid}\u0000${e.answer!.qid}`, text: `${id}: answered #${e.seq}, waiting for the run to resume` };
    }
    const filtered = { ...v, questions: open }, q = open[0];
    // DF2: count questions as ops.decide does: every asking run of the attempt (writer and reviewers).
    const nodeQuestions = ar.launches.reduce((sum, x) => { const w = runs.get(x.rid); return sum + (w?.state === 'asking' ? w.questions?.length ?? 0 : 0); }, 0);
    return { do: 'notify', node: id, text: `${askingText(id, l, filtered, nodeQuestions)} ${askingRule(id)}`, rid: l.rid, ...(q ? { qid: q.qid, rev: q.rev } : {}) };
  };
  const ar: AttemptRuns = n.runs.find(r => r.attempt === attempt) ?? { attempt, launches: [], sends: [] };
  // RR1: same-key resubmits carry reviewer runs across the contiguous review epoch; writers are unchanged.
  const epoch = reviewEpoch(s, id);
  const live = ar.launches.filter(l => l.role === 'writer' || (epoch !== undefined && l.seq > epoch));
  const askingNotice = (): Action | undefined => {
    const asks = live.flatMap(l => { const v = runs.get(l.rid); return v?.state === 'asking' ? [asking(l, v)] : []; });
    return asks.find(a => a.do === 'notify' && !a.quiet) ?? asks[0];
  };
  // Row 1 (HA1): slotAction only reports questions while halted; decide still delivers PR2 notices (#1743).
  if (halted(s, id)) return askingNotice();
  // TP1: parking forbids all follow-ups, including dependency and prospective notices; questions remain live.
  if (trunkParked(s, id).length) return askingNotice();
  // FS3/FS5: a shared-failure park (seen refused on this state, or waiting for an accepted fix) forbids the merge retry and follow-ups.
  if (sharedWaiting(s, id, opts)) return askingNotice();
  // 0.8 (L1.3): a waiting node is skipped like a halted one; only its asking runs are still reported (row 5).
  const waiting = waitingFor(s, id);
  if (waiting || reportedOf(s, id) !== undefined || s.plan.nodes.find(x => x.id === id)?.later) {
    const ask = askingNotice();
    if (ask) return ask;
    // FL1: only the waiting notification is delivered while dependencies block the slot.
    const writer = ar.launches.find(l => l.role === 'writer'), w = writer && runs.get(writer.rid);
    if (waiting?.deps?.length && writer && w?.state === 'running') {
      const change = entriesOf(s).findLast(e => e.kind === 'plan' && e.seq > slot.dispatchSeq && (() => {
        const before = planAt(s, e.seq).nodes.find(x => x.id === id)?.deps ?? [];
        return (planAt(s, e.seq + 1).nodes.find(x => x.id === id)?.deps ?? []).some(d => !before.includes(d) && waiting.deps!.includes(d));
      })());
      if (change) {
        const sent = ar.sends.find(x => x.reason === 'waiting' && x.seq > change.seq);
        if (!sent) return send(writer, 'notify', 'waiting', `plan #${change.seq}: waiting (deps: ${waiting.deps.join(', ')}); do not submit until told. The driver will rebase this slot when all dependencies merge.`);
        if (!opts.applied.has(sent.send) && !opts.rejected.has(sent.send)) {
          const bytes = opts.blobs?.get(sent.message);
          if (bytes !== undefined && sha256(bytes) === sent.message) return { do: 'send', node: id, attempt, rid: sent.rid, sendKind: 'notify', reason: 'waiting', message: bytes, send: sent.send };
        }
      }
    }
    return undefined;
  }
  // TR3: mixed blocks retain the existing parent halt before attribution or writer follow-up.
  if (c) {
    // AT3: a block measured for an earlier candidate never halts here; the new candidate is attested first.
    const trunkRed = n.blocks.filter(b => b.state === 'active' && !priorCandidateBlock(s, id, b)).flatMap(b => trunkRedHint(s,b.seq,b.key) ?? []);
    if (trunkRed.length) {
      const failures = entriesOf(s).filter((e): e is ObsEntry => e.kind === 'obs' && n.blocks.some(b => b.state === 'active' && b.seq === e.seq));
      return halt(`merge refused: ${[...trunkRed, ...mergeFailureHints(s,id,failures)].join('; ')}`);
    }
  }
  // FL1: dependencies merged after dispatch: use the existing rebase route exactly once before other work.
  const deps = s.plan.nodes.find(x => x.id === id)?.deps ?? [];
  if (slot.base !== s.trunk.commit && deps.some(d => (s.nodes[d]?.merged?.seq ?? -1) > Math.max(slot.dispatchSeq, slot.rebase?.seq ?? -1))) return { do: 'rebase', node: id };
  // Owner-needed nodes are never touched (no ledger write, no dsa call): notify only. 0.8 (L3.1): unless the writer run
  // is sealed and an undelivered ruling names the node, or a ruling send to the writer is recorded but not applied in
  // this process (review #914 F1: dsa pending, or a crash before dsa; row 4 re-sends it with the same id); the rows
  // below then run up to `rulingFirst` (after row 5).
  const owner = ownerNeeded(s, id), writer = ar.launches.find(l => l.role === 'writer');
  const writerView = writer && runs.get(writer.rid);
  const last = lastSubmit(s, id);
  const writerRule = !c && last ? s.rules.findLast(r => r.writer && r.nodes !== '*' && r.nodes.includes(id) && r.seq > last.seq) : undefined;
  const rulingDue = (): boolean => !!writer && !!writerView && isSealed(writerView)
    && (!!rulingFollowUp(s, id, opts.rejected) || ar.sends.some(x => x.rid === writer.rid && x.reason === 'ruling' && x.sendKind === 'follow-up' && !opts.applied.has(x.send)));
  const reportPending = resumeOf(s,id)?.expect === 'report' && (!!writer && (!!resumeLine(s,id,writer.rid) || !!reportRequest(s,id)));
  if (owner && !rulingDue() && !writerRule && !reportPending) return ownerNotify(s, id, owner);
  // Row 2: writer launch missing.
  if (!writer) return writerLaunch(s, id, opts.project);
  if (live.some(l => !runs.has(l.rid))) return undefined;
  const view = (l: LaunchEntry): RunView => runs.get(l.rid)!;
  // 0.8 (L1.4): a run named in a halt carries dsa's call address when describe reported one.
  const at = (l: LaunchEntry): string => `${l.rid}${callAt(view(l))}`;
  // 0.8 (L1.3): the latest resume of the attempt; what the driver waits for after a follow-up counts from it.
  const resumed = resumeOf(s, id)?.seq ?? -1;
  // Row 3: a launch whose run is absent: re-launch with the stored bytes and the same rid; a rejection seen by this process halts (D9).
  for (const l of live) {
    const rejected = opts.rejected.get(l.rid);
    if (rejected !== undefined) return halt(rejectedHalt(id, 'run', at(l), rejected));
    if (view(l).state === 'absent') return relaunch(s, opts, l) ?? halt(`cannot re-launch ${at(l)}: the stored spec bytes (blob ${l.spec}) were not supplied and the rebuilt spec differs`);
  }
  // Row 4: a recorded send not confirmed applied in this process: re-send the same id and bytes.
  for (const x of ar.sends) {
    if (x.reason === 'ruling' && x.sendKind === 'notify') continue; // PR2: never retries a notice to a sealed run or halts.
    if (opts.applied.has(x.send) || !live.some(l => l.rid === x.rid)) continue;
    const refused = opts.rejected.get(x.send);
    // D22.3: a rejected ruling steer is never retried and never halts; its rulings travel with repairs and reviewer
    // acks. A rejected ruling follow-up (K5.2) halts like any other send.
    if (refused !== undefined && ((x.reason === 'ruling' && x.sendKind === 'steer') || x.reason === 'waiting')) continue;
    const xl = live.find(l => l.rid === x.rid)!;
    if (refused !== undefined) {
      // SR1: later resume/submit of this attempt, or a non-rejected send to the same run, supersedes the refusal.
      // SR2: a steer refused by a sealed/pruned run belongs to the sealed-run rows (unknown gets interrupted).
      if (Math.max(resumed, last?.seq ?? -1) > x.seq
        || ar.sends.some(y => y.seq > x.seq && y.rid === x.rid && !opts.rejected.has(y.send))
        || (x.sendKind === 'steer' && isSealed(view(xl)))) continue;
      return halt(rejectedHalt(id, 'send', `${x.send}${callAt(view(xl))}`, refused));
    }
    const bytes = opts.blobs?.get(x.message);
    if (bytes === undefined || sha256(bytes) !== x.message) return halt(`cannot re-send ${x.send}${callAt(view(xl))}: the stored message bytes (blob ${x.message}) were not supplied`);
    return { do: 'send', node: id, attempt, rid: x.rid, sendKind: x.sendKind, message: bytes, reason: x.reason, send: x.send, ...(x.rulings !== undefined ? { rulings: x.rulings } : {}) };
  }
  // Row 5: a run asking (`asking`).
  const ask = askingNotice();
  if (ask) return ask;
  const w = view(writer), wSealed = isSealed(w), wStatus = statusOf(w);
  // FL3: a fresh report resume gets the next writer follow-up even with an accepted/failed candidate.
  const reportResume = resumeOf(s, id);
  if (reportResume?.expect === 'report' && resumeLine(s, id, writer.rid) && wSealed && wStatus === 'ok') return send(writer, 'follow-up', 'report', REPORT_MESSAGE);
  const report = reportRequest(s, id);
  if (report && wSealed && wStatus === 'ok') return { do: 'notify', node: id, rid: writer.rid, reportedResume: report.resume, once: `report\u0000${id}\u0000${report.resume}`, text: `${id}: reported (resume #${report.resume})\n${reportTail(w.result ?? '')}` };
  // FL3 (review #1273): the report generation owns this slot until it finishes, even when the old candidate
  // is accepted. Questions above and sealed failure routes below stay live; a new submit/parent act ends reportRequest.
  if (report && !wSealed) return undefined;
  // Ruling #1431: with only rulings debt and no review obligation, even a non-ok sealed writer gets one
  // ruling follow-up, then we wait for resubmit. Unaddressable runs/sends have already followed rows 3-4.
  const pending = n.items.filter(i => i.status === 'D');
  if (c && pending.length === 1 && pending[0]!.obligation === 'rulings' && !n.items.some(i => i.obligation === 'review' || i.obligation === 'closure-review') && !n.blocks.some(b => (b.state === 'active' || b.state === 'flaky') && !heldFlaky(s,id,b))) {
    const seen = Math.max(slot.rulings_seen, ...ar.sends.filter(x => x.rid === writer.rid && x.reason === 'ruling' && x.sendKind === 'follow-up').map(x => x.rulings ?? -1));
    const rules = rulingsInScope(s, id).filter(r => r.seq > seen);
    if (rules.length) return send(writer, 'follow-up', 'ruling', [`New parent rulings for ${id}:`, ...rulingLines(rules), `Apply these rulings to candidate ${c.commit} (submit #${c.seq}), then run \`owed submit ${id}\` (the same commit may be submitted again). This candidate has no review obligation; resubmitting records the delivered rulings as seen.`].join('\n'), carried(rules));
    return undefined; // Sent once for this set; a finished generation does not turn its resubmit wait into owner debt.
  }
  // F5: an explicit writer ruling takes priority over the generic resubmit/repair route.
  // Reviewers of the invalidated candidate are obsolete; delivery never acknowledges the ruling.
  if (writerRule) {
    if (wSealed) {
      const f = rulingFollowUp(s, id, opts.rejected);
      if (f) return send(writer, 'follow-up', 'ruling', f.message, f.rulings);
      const sent = ar.sends.findLast(x => x.rid === writer.rid && x.reason === 'ruling' && x.sendKind === 'follow-up' && x.seq > writerRule.seq);
      if (sent && sent.seq > resumed) return stoppedHalt(`writer run ${at(writer)} finished ruling follow-up ${sent.send} without submitting a new candidate (writer ruling #${writerRule.seq})`);
      // A resume after that follow-up starts a new wait: deliver the writer rulings again instead of repeating the halt.
      if (sent) {
        const rules = s.rules.filter(r => r.writer && r.nodes !== '*' && r.nodes.includes(id) && r.seq > last!.seq && deliversRule(r, writer.rid));
        // G3.5 (0.12): with the same active/flaky block lines as `rulingFollowUp`.
        return send(writer, 'follow-up', 'ruling', [`Parent rulings for ${id} (apply them; they override your packet):`, ...rules.map(r => `#${r.seq} (${(r.nodes as string[]).join(', ')}): ${r.text}`), ...blockLines(s, id), `Then commit and run \`owed submit ${id}\` (the same commit may be submitted again).`].join('\n'), carried(rules));
      }
    } else {
      const steer = rulingSteer(s, n, ar, live, view);
      if (steer) return steer;
    }
  }
  /**
   * K5.2: a sealed writer lacking a ruling that names the node gets one ruling follow-up (not a repair), but never while
   * a reviewer run of the current candidate is unsealed, and never when the current candidate has no active block or
   * failed item: the ruling then reaches the reviewers (steer, the rulings obligation and its ack); a block's repair
   * carries it. It replaces the finished-without-submitting and repairs-exhausted halts (`writerHalt`). The calls at the
   * `stalled:` halt and at row 18 are defensive only (review #784 F2): a failed item or an active block is handled by
   * the repair rows first, and row 8 acts on every sealed writer without a candidate.
   */
  const rulingSend = (): Action | undefined => {
    if (!wSealed) return undefined;
    if (c && (live.some(l => l.role === 'reviewer' && !isSealed(view(l))) || !(n.items.some(i => i.mark === '✘') || n.blocks.some(b => b.state === 'active' && b.key === c.keys[b.obligation])))) return undefined;
    const f = rulingFollowUp(s, id, opts.rejected);
    return f && send(writer, 'follow-up', 'ruling', f.message, f.rulings);
  };
  /**
   * K5.2: in place of a halt for a sealed writer that finished without submitting (`reason`) or exhausted its repairs:
   * the ruling follow-up when one is due; after a ruling follow-up later than `after` (the follow-up the halt names, the
   * latest submit), the halt names that ruling follow-up instead, with `cause`.
   */
  const writerHalt = (reason: string, cause: string, after: number): Action => {
    if (!wSealed) return halt(reason);
    const f = rulingSend();
    if (f) return f;
    const rf = ar.sends.findLast(x => x.rid === writer.rid && x.sendKind === 'follow-up' && x.reason === 'ruling' && x.seq > Math.max(after, lastSubmit(s, id)?.seq ?? -1, resumed));
    if (!rf) return stoppedHalt(reason);
    const refused = opts.rejected.get(rf.send);
    return stoppedHalt(refused !== undefined ? rejectedHalt(id, 'send', `${rf.send}${callAt(w)}`, refused) : `writer run ${at(writer)} finished ruling follow-up ${rf.send} without submitting a new candidate (${cause})`);
  };
  /**
   * 0.8 (L3.1, wais #21): the ruling follow-up before a halt whatever its cause (owner-needed, row 7, the stalled halt
   * of a candidate with a failed item, an active block on its keys or a flaky block): the writer is sealed, no reviewer run of the current
   * candidate is unsealed, an undelivered ruling names the node, and no needs-parent review block sits on the keys of
   * the current candidate (else the latest submit), which keeps its D18 route. Sent once (`deliveredRulings`).
   */
  const rulingFirst = (): Action | undefined => {
    if (!wSealed || (c && live.some(l => l.role === 'reviewer' && !isSealed(view(l))))) return undefined;
    const last = lastSubmit(s, id), keys = c?.keys ?? last?.facts.keys;
    if (keys && n.blocks.some(b => b.needs === 'parent' && b.state === 'active' && b.key === keys[b.obligation])) return undefined;
    const f = rulingFollowUp(s, id, opts.rejected);
    return f && send(writer, 'follow-up', 'ruling', f.message, f.rulings);
  };
  // 0.8 (L3.1): an owner-needed node with a due ruling follow-up gets it first; then the notify as before.
  if (owner) return rulingFirst() ?? ownerNotify(s, id, owner);
  const writerMsg = (message: string): { message: string; rulings?: number } => withRulings(s, id, ar, writer, message, opts.rejected);
  // Row 6: writer cut off in a tool.
  if (wSealed && wStatus === 'unknown') return send(writer, 'follow-up', 'interrupted', WRITER_INTERRUPTED);
  // Row 7: writer sealed non-ok (0.8, L3.1: a due ruling follow-up first).
  if (wSealed && wStatus !== 'ok') return rulingFirst() ?? stoppedHalt(`writer run ${at(writer)} sealed ${wStatus}${w.error ? `: ${w.error}` : ''}${wStatus === 'rejected' ? `; ${rejectedFixed(id)}` : ''}`);
  const drift = opts.rebasePending?.get(id);
  if (drift && !reportPending && !(drift.recovery && resubmitBlocks(s,id).length)) {
    const unruled = submitBlocks(s, id).filter(b => awaitingRuling(s, b));
    if (unruled.length) return halt(needsRulingHalt(s, id, unruled));
    const message = slot.rebase ? rebaseMessage(s, id, opts.conflicts?.get(id), drift) : `${rebaseWorkText(drift)} In ${slot.worktree}, run \`owed submit ${id}\`.`;
    if (rebaseFollowupSent(s, id)) {
      if (!wSealed) return undefined;
      // WS-R3: a due ruling (e.g. `owed decide <node> --writer` after one of these halts) is delivered before halting again.
      const ruled = rulingFirst();
      if (ruled) return ruled;
      const follow = ar.sends.findLast(x => x.rid === writer.rid && x.reason === 'rebase')!;
      const rf = ar.sends.findLast(x => x.rid === writer.rid && x.sendKind === 'follow-up' && x.reason === 'ruling' && x.seq > Math.max(follow.seq, resumed));
      const driftHalt = (reason: string): Action => {
        if (!rf) return stoppedHalt(reason);
        const refused = opts.rejected.get(rf.send);
        return stoppedHalt(refused !== undefined ? rejectedHalt(id, 'send', `${rf.send}${callAt(w)}`, refused) : `writer run ${at(writer)} finished ruling follow-up ${rf.send} without submitting a new candidate (${reason})`);
      };
      if (rf) return driftHalt(`writer stopped without a candidate after rebase follow-up ${follow.send}`);
      const work = opts.writerWork?.get(id);
      if (!work) return driftHalt(`cannot inspect writer worktree after rebase follow-up ${follow.send}; no submit nudge sent`);
      // WS5/WS-R2: handed HEADs are the last submit (else dispatch base) plus every later rebase `from` of this attempt.
      const anchor = lastSubmit(s, id), entries = entriesOf(s), dispatched = entries.find(e => e.seq === slot.dispatchSeq);
      const handed = new Set<string>([anchor?.facts.commit ?? (dispatched?.kind === 'dispatch' ? dispatched.base : slot.base)]);
      for (const e of entries) if (e.kind === 'rebase' && e.node === id && e.attempt === attempt && e.seq > (anchor?.seq ?? slot.dispatchSeq)) handed.add(e.from);
      const nudge = ar.sends.findLast(x => x.rid === writer.rid && x.reason === 'submit' && x.seq > Math.max(follow.seq, resumed));
      if (nudge) return driftHalt(`writer stopped after rebase follow-up ${follow.send} without submitting a candidate after follow-up ${nudge.send}`);
      if (handed.has(work.head) && !work.dirty) return driftHalt(`writer stopped without a candidate after rebase follow-up ${follow.send}`);
      const m = writerMsg(`${message}\n${submitMessage(id)}`);
      return send(writer, 'follow-up', 'submit', m.message, m.rulings);
    }
    const m = writerMsg(message);
    return send(writer, 'follow-up', 'rebase', m.message, m.rulings);
  }
  // Row 8: writer done without a current candidate (after a rebase: the rebase follow-up first).
  if (wSealed && !c) {
    const rb = slot.rebase;
    // Review #680 (a): an active block on the latest submit's key still awaiting a parent ruling halts first (D18), with
    // or without repairable blocks: a repair, rebase or submit follow-up would let new content bypass the parent question.
    const unruled = submitBlocks(s, id).filter(b => awaitingRuling(s, b));
    if (unruled.length) return halt(needsRulingHalt(s, id, unruled));
    // G3.2: with a block the driver would repair, one repair follow-up replaces the submit / rebase follow-up.
    const fix = resubmitBlocks(s, id);
    if (fix.length) {
      const cause = `review block ${fix.map(b => `#${b.seq} ${b.obligation}`).join(', ')}; a new candidate is needed`;
      const after = Math.max(rb?.seq ?? slot.dispatchSeq, lastSubmit(s, id)?.seq ?? -1, resumed);
      const outstanding = ar.sends.findLast(x => x.reason === 'repair' && x.seq > after), budget = repairsSince(s, id, ar);
      if (outstanding) return writerHalt(`writer run ${at(writer)} finished repair follow-up ${outstanding.send} without submitting a new candidate (${cause})`, cause, outstanding.seq);
      if (budget.count >= opts.repairs) { const ex = `repairs exhausted (${budget.count} of ${opts.repairs} since ${budget.label}): ${cause}`; return writerHalt(ex, ex, after); }
      const r = resubmitFollowUp(s, id, opts.conflicts?.get(id), opts.rebaseWork?.get(id));
      return send(writer, 'follow-up', 'repair', r.message, r.rulings);
    }
    // N1.4: a rebase follow-up only while no submit of this attempt came after the rebase; otherwise a submit that a
    // later plan entry invalidated gets a submit follow-up naming that plan entry (wais #1375).
    const last = lastSubmit(s, id), rebased = !!rb && (!last || last.seq < rb.seq);
    if (rebased && !ar.sends.some(x => x.reason === 'rebase' && x.seq > rb!.seq)) { const m = writerMsg(rebaseMessage(s, id, opts.conflicts?.get(id), opts.rebaseWork?.get(id))); return send(writer, 'follow-up', 'rebase', m.message, m.rulings); }
    const changed = !rebased && last ? planInvalidated(s, id, last.seq) : undefined;
    const since = Math.max(rb?.seq ?? slot.dispatchSeq, resumed, changed?.plan ?? -1), nudge = ar.sends.findLast(x => x.reason === 'submit' && x.seq > since);
    if (nudge) return writerHalt(`writer run ${at(writer)} finished without submitting a candidate after follow-up ${nudge.send}`, `no candidate after follow-up ${nudge.send}`, nudge.seq);
    if (!changed) {
      const work = opts.writerWork?.get(id);
      // Last handed HEAD: latest submit if after the rebase (including executor's result), otherwise the slot base.
      const handed = last && (!rb || last.seq > rb.seq) ? last.facts.commit : slot.base;
      if (!work) return stoppedHalt('cannot inspect writer worktree; no submit nudge sent');
      if (work.head === handed && !work.dirty) return writerHalt('writer stopped without a candidate', 'no work left to submit', since);
    }
    const m = writerMsg(changed ? planChangedMessage(id, changed.plan, changed.fields) : submitMessage(id));
    return send(writer, 'follow-up', 'submit', m.message, m.rulings);
  }
  const steerRulings = (): Action | undefined => rulingSteer(s, n, ar, live, view);
  const fenced = (): Action | undefined => {
    const f = w.lastFence;
    if (w.state !== 'running' || !f) return undefined;
    // D22.2a: only a fenced steer answers a fence; a ruling steer never hides one.
    const steer = ar.sends.findLast(x => x.rid === writer.rid && x.sendKind === 'steer' && x.reason === 'fenced');
    return !steer || f.at > Date.parse(steer.ts) ? send(writer, 'steer', 'fenced', fencedMessage(f.reason)) : undefined;
  };
  if (c) {
    // Rows 9-10: measured obligations without a verdict on the candidate's keys, and attribution reruns of blocks from
    // earlier content (a failure of the current content is a repair, not an attest): attest, unless `error` twice.
    // F2.2: an environment error (note `environment: `) does not count toward the two errors; it makes the attest wait.
    const jobs = attestJobs(s, id).filter(j => !(j.attribution && j.key === c.keys[j.obligation]) || observationsOf(s,j.subject,j.obligation,j.key).some(o => setupFailure(s,o))).map(j => ({ j, errors: observationsOf(s, j.subject, j.obligation, j.key).filter(o => o.verdict === 'error' && o.seq > resumed && !isEnvironment(o)) }));
    if (jobs.some(x => x.errors.length < 2)) {
      const wait = opts.now === undefined ? undefined : environmentWait(s, jobs.map(x => x.j), resumed);
      if (wait && wait.until > opts.now!) return { do: 'notify', node: id, text: environmentText(id, wait), once: `environment\u0000${id}\u0000${wait.streak}` };
      return { do: 'attest', node: id };
    }
    if (jobs.length) return halt(`attest recorded no verdict twice: ${jobs.map(x => `${x.j.obligation} (${x.errors.map(o => `#${o.seq} ${o.note ?? `exit ${o.exit}`}`).join('; ')})`).join(', ')}`);
    const writesWait = writesWaiting(s,id);
    const waitingWrites = writesWait?.waits_on?.some(owner => s.nodes[owner]?.slot?.open);
    // Repair: one follow-up per candidate, at most `repairs` per attempt; a writer that finishes it without resubmitting halts.
    // K5.1: the budget counts the repairs since the node's epoch; K5.2: a due ruling follow-up replaces either halt.
    const repair = (cause: string): Action | undefined => {
      // 0.8 (L1.3): after a resume a sealed writer gets a fresh repair (a running one is still waited for).
      const outstanding = ar.sends.findLast(x => x.reason === 'repair' && x.seq > c.seq && (!wSealed || x.seq > resumed)), budget = repairsSince(s, id, ar);
      if (outstanding) return wSealed ? writerHalt(`writer run ${at(writer)} finished repair follow-up ${outstanding.send} without submitting a new candidate (${cause})`, cause, outstanding.seq) : fenced() ?? steerRulings();
      if (budget.count >= opts.repairs) { const ex = `repairs exhausted (${budget.count} of ${opts.repairs} since ${budget.label}): ${cause}`; return writerHalt(ex, ex, c.seq); }
      const r = repairFollowUp(s, id, opts.rejected);
      return send(writer, 'follow-up', 'repair', r.message, r.rulings);
    };
    // D18/D18b.2: a review block on the current candidate whose reviewer says it needs a parent ruling halts (needs
    // human) before any repair, measured or review, until a ruling naming the node is recorded after it; no repair is
    // sent or counted, so no repair carries an undecided contract. The ruling also clears the halt (D3).
    const unruled = n.blocks.filter(b => b.kind === 'judgment' && b.key === c.keys[b.obligation] && awaitingRuling(s, b));
    if (unruled.length) return halt(needsRulingHalt(s, id, unruled));
    // Row 11: a measured block: an obligation of the candidate failed (✘), or an active execution block binds it.
    const measured = n.items.filter(i => (i.mark === '✘' || n.blocks.some(b => b.kind === 'exec' && b.state === 'active' && b.obligation === i.obligation)) && !(waitingWrites && i.obligation === 'writes'));
    if (measured.length) {
      const setup = measured.map(i => observationsOf(s,id,i.obligation,i.key).at(-1)).find(o => o !== undefined && setupFailure(s,o));
      if (setup) return halt(setupHint(setupSignature(opts.blobs?.get(setup.log ?? '') ?? setup.note ?? ''),id));
      // K5.3: the same count below min_tests twice: the threshold may be the plan's mistake; the parent decides.
      const hint = thresholdHint(s, id, measured.map(i => i.obligation));
      if (hint) return halt(hint);
      // K5.4: the halts this cause reaches cite the failing observations.
      const evidence = execEvidence(s, n, measured);
      return repair(`measured block ${measured.map(i => `${i.obligation} [${i.evidence.map(x => `#${x}`).join(', ')}]`).join(', ')}${evidence.length ? `; ${evidence.join('; ')}` : ''}${measured.some(i => i.obligation === 'writes') && grantHint(s,id) ? `\n${grantHint(s,id)}` : ''}`);
    }
    const judged = n.blocks.filter(b => b.kind === 'judgment' && b.state === 'active');
    const current = judged.filter(b => b.key === c.keys[b.obligation]), stale = judged.filter(b => b.key !== c.keys[b.obligation]);
    // Row 12: review obligations awaiting and fewer reviewer runs than the review epoch needs: launch the next n. G3.1:
    // never while a review block is active on the candidate's key: row 15 repairs it first (a reviewer would judge
    // content the repair replaces).
    const reviewers = live.filter(l => l.role === 'reviewer');
    if (!current.length && n.items.some(i => (i.obligation === 'review' || i.obligation === 'closure-review') && i.status === 'D') && reviewers.length < reviewRuns(s, id))
      return reviewerLaunch(s, id, nextReviewerN(s, id), opts.project, opts.root);
    // Rows 13-14: a sealed reviewer run whose obligations are still awaiting (it recorded no review on them). F1.2: one
    // `verdict` follow-up per run of this candidate first (not to a rejected or pruned run); the halt only after it.
    const entries = entriesOf(s);
    for (const l of reviewers) {
      const v = view(l);
      if (!isSealed(v)) continue;
      const k = reviewerN(l), who = driveReviewer(id, attempt, k - reviewerBase(s, id));
      const awaiting = reviewObligations(s, id, k).filter(o => n.items.find(i => i.obligation === o)?.status === 'D' && !entries.some(e => e.kind === 'review' && e.node === id && e.by === who && e.obligation === o && e.key === c.keys[o]));
      if (!awaiting.length) continue;
      if (statusOf(v) === 'unknown' && !ar.sends.some(x => x.rid === l.rid && x.reason === 'interrupted')) return send(l, 'follow-up', 'interrupted', reviewerInterrupted(id));
      const asked = ar.sends.findLast(x => x.rid === l.rid && x.reason === 'verdict' && x.seq > c.seq);
      if (!asked && statusOf(v) !== 'rejected' && v.state !== 'pruned') return send(l, 'follow-up', 'verdict', verdictMessage(id, c, who, awaiting));
      return halt(`review-missing: reviewer run ${at(l)} sealed ${statusOf(v)}${v.error ? `: ${v.error}` : ''} without recording ${awaiting.join(', ')} on candidate #${c.seq}${asked ? ` after verdict follow-up ${asked.send}` : ''}${statusOf(v) === 'rejected' ? `; ${rejectedFixed(id)}` : ''}`);
    }
    // Row 15 (D11/D12): a review block recorded on the current candidate's key: repair (counts as a repair). A stale
    // block (recorded on an earlier candidate) is left to the slot re-review: wait only while a reviewer run of this
    // candidate is unsealed (row 12 already launched any needed run); otherwise halt needing the owner.
    if (current.length) return repair(`review block ${current.map(b => `#${b.seq} ${b.obligation}`).join(', ')}`);
    const reviewing = reviewers.some(l => !isSealed(view(l)));
    if (stale.length) {
      if (reviewing) return fenced() ?? steerRulings();
      return halt(`stale review block${stale.length > 1 ? 's' : ''} ${stale.map(b => `#${b.seq} ${b.obligation} rank ${b.rank} by ${entries.find(e => e.seq === b.seq)?.by ?? '?'}`).join(', ')} still active and no reviewer run of candidate #${c.seq} is running; the driver cannot clear ${stale.length > 1 ? 'them' : 'it'}${resolveText(s, id)}`, 'owner');
    }
    // D23: everything but approve/evidence:* is satisfied and nothing blocks: halt for the owner (approve) or a human
    // (evidence) with the exact commands. Never earlier: the rows above run first.
    const manual = manualHalt(s, id);
    if (manual) return halt(manual.reason, manual.needs);
    // Rows 16-17: accepted: merge; a merge this process saw refused: rebase when trunk moved, else halt.
    if (n.accepted) {
      const m = opts.merges?.get(id);
      if (m && m.candidate === c.seq) return m.rebase ? { do: 'rebase', node: id } : halt(`merge refused: ${m.reason}`, m.needs ?? 'human');
      return { do: 'merge', node: id };
    }
    if (waitingWrites) {
      const cycle = writesWaitCycle(s,id);
      if (cycle) return halt(`writes ownership wait cycle: ${cycle.join(' -> ')}; resolve the ownership overlap with owed plan or abandon one slot, then run owed decide ${id} --text "<ownership resolved>"`, 'human');
      return fenced() ?? steerRulings();
    }
    // Liveness (D12): a candidate that is not accepted while no driver run of the attempt is unsealed never yields
    // "nothing to do": halt needing the owner with every non-E item and active block (K5.2: a due ruling follow-up first).
    // 0.8 (L3.1): to the writer when the candidate has a failed item, an active block on its keys or a flaky block; when its
    // only debt is `rulings`, to a reviewer (`reviewerRuling`), which discharges it with --ack-rulings.
    if (wSealed && !reviewing) {
      const items = n.items.filter(i => i.status !== 'E').map(i => `${i.obligation} ${i.mark} ${i.detail}`);
      const blocks = n.blocks.filter(b => b.state === 'active').map(b => blockText(s, c, b));
      const dirty = n.items.some(i => i.mark === '✘') || n.blocks.some(b => !heldFlaky(s,id,b) && (b.state === 'flaky' || (b.state === 'active' && b.key === c.keys[b.obligation])));
      const rulingsOwed = n.items.some(i => i.obligation === 'rulings' && i.status === 'D');
      return (dirty ? rulingFirst() : rulingsOwed ? reviewerRuling(s, n, ar, reviewers, opts) : undefined) ?? halt(`stalled: ${[...items, ...(blocks.length ? [`active blocks ${blocks.join(', ')}`] : [])].join('; ') || 'candidate not accepted'}${resolveText(s, id)}`, 'owner');
    }
  }
  // Row 18: the running writer was fenced after the last steer; else (D22.2a, lowest priority, only when the node
  // would otherwise idle) a running driver run that lacks in-scope rulings gets them as a steer; K5.2: without a current
  // candidate, a due ruling follow-up to a sealed writer.
  return fenced() ?? steerRulings() ?? (c ? undefined : rulingSend());
}

/**
 * D23: when the only unsatisfied items of the node's candidate are `approve` and/or `evidence:<id>` (no active or flaky
 * block), the halt the driver records: needs `owner` while approve is pending, else `human`; the reason names each item
 * with the exact command (`owed approve <node>`, `owed evidence <node> <id> --file <path> --note "…" --as <role>:<id>`).
 */
export function manualHalt(s: State, node: string): { reason: string; needs: 'human' | 'owner' } | undefined {
  const n = s.nodes[node], spec = s.plan.nodes.find(x => x.id === node);
  if (!n?.candidate || !spec || n.blocks.some(b => (b.state === 'active' || b.state === 'flaky') && !heldFlaky(s,node,b))) return undefined;
  const pending = n.items.filter(i => i.status === 'D');
  if (!pending.length || !pending.every(i => i.obligation === 'approve' || i.obligation.startsWith('evidence:'))) return undefined;
  const parts = pending.map(i => {
    // G1.3 (bind): candidate-bound acts name the open candidate they judge.
    const c12 = n.candidate!.commit.slice(0, 12);
    if (i.obligation === 'approve') return `awaiting owner approval of candidate ${c12}: owed approve ${node} --candidate ${c12} [--note TEXT] (owner)`;
    const ev = spec.evidence?.find(e => `evidence:${e.id}` === i.obligation);
    return `awaiting manual evidence ${i.obligation}${ev ? ` (${oneLine(ev.what)})` : ''} by ${ev?.by ?? 'reviewer'}: ${evidenceCommand(node, i.obligation.slice(9), `${ev?.by ?? 'reviewer'}:<id>`, c12)} or --as owner:pi`;
  });
  return { reason: parts.join('; '), needs: pending.some(i => i.obligation === 'approve') ? 'owner' : 'human' };
}

/**
 * AK1: a halt quotes each review's extracted ask and gives the single writer-ruling command.
 */
export function needsRulingHalt(s: State, node: string, blocks: readonly Block[]): string {
  const entries = entriesOf(s);
  const each = blocks.map(b => { const e = entries.find(x => x.seq === b.seq); return `review asks: ${reviewAsk(e?.kind === 'review' ? e.note ?? '' : '')}`; });
  return `${each.join('; ')} → ${reviewDecision(node)}`;
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
  const base = { do: 'launch' as const, node: l.node, attempt: l.attempt, role: l.role, ...(l.role === 'reviewer' ? { n: reviewerN(l) } : {}), rid: l.rid, labels: { ...l.labels }, ...(l.rulings !== undefined ? { rulings: l.rulings } : {}) };
  if (rebuilt && sha256(rebuilt.spec) === l.spec) return { ...base, spec: rebuilt.spec };
  const stored = opts.blobs?.get(l.spec);
  return stored !== undefined && sha256(stored) === l.spec ? { ...base, spec: stored } : undefined;
}
/**
 * The highest ruling seq covering the node that run `l` already has (E4; D22.2): the max of the `rulings` recorded on
 * its launch entry and on every send to it that records `rulings` (`repair`, `ruling`, and since 0.7 `submit` and
 * `rebase` follow-ups; also an unconfirmed or rejected ruling send: it is never sent again under a new id — except that
 * the sends in `refused` (dsa rejected them; the writer follow-ups pass it, the steer does not) count for nothing, so the
 * writer's next follow-up carries their rulings, review #784 F1), and for the
 * writer its dispatch `rulings_seen`. Entries without the field (written
 * by 0.5.0) fall back to the 0.5.0 position rule: a reviewer launch carried the in-scope rulings recorded before it, a
 * repair send those recorded before it (its message lists the rulings since dispatch); a writer launch carried
 * `rulings_seen`.
 */
export function deliveredRulings(s: State, node: string, ar: AttemptRuns, l: LaunchEntry, refused?: Refused): number {
  const inScope = rulingsInScope(s, node);
  const before = (seq: number): number => Math.max(-1, ...inScope.filter(r => r.seq < seq).map(r => r.seq));
  const sends = ar.sends.filter(x => x.rid === l.rid && !(x.reason === 'ruling' && x.sendKind === 'notify') && !refused?.has(x.send));
  const launch = l.rulings ?? (l.role === 'writer' ? -1 : before(l.seq));
  // K5.2: every writer send that records `rulings` (submit, rebase, repair, ruling follow-ups) delivered them.
  const base = l.role === 'writer' ? Math.max(s.nodes[node]!.slot!.rulings_seen, launch, ...sends.map(x => x.rulings ?? (x.reason === 'repair' ? before(x.seq) : -1))) : launch;
  // AN3: advance only across delivered rules; a later answer must not hide an earlier ordinary ruling.
  let delivered = Math.max(base, ...sends.filter(x => x.reason === 'ruling').map(x => x.rulings ?? -1));
  for (const r of inScope.filter(r => r.seq > delivered)) {
    if (deliversRule(r,l.rid)) break;
    delivered = r.seq;
  }
  return delivered;
}
/** PR2: notify each unsealed run once; sealed runs receive no prospective policy for an older attempt. */
function prospectiveNotice(s: State, n: NodeState, ar: AttemptRuns, runs: ReadonlyMap<string, RunView>, opts: DriveOpts): Action | undefined {
  const rules = s.rules.filter(r => r.prospective && r.seq > n.slot!.dispatchSeq && (r.nodes === '*' || r.nodes.includes(n.id)));
  if (!rules.length) return undefined;
  for (const l of ar.launches) {
    const v = runs.get(l.rid);
    if (!v || !['running', 'asking', 'queued'].includes(v.state)) continue;
    const notices = ar.sends.filter(x => x.rid === l.rid && x.reason === 'ruling' && x.sendKind === 'notify');
    for (const x of notices) {
      if (opts.applied.has(x.send) || opts.rejected.has(x.send)) continue;
      const bytes = opts.blobs?.get(x.message);
      if (bytes !== undefined && sha256(bytes) === x.message) return { do: 'send', node: n.id, attempt: n.slot!.attempt, rid: l.rid, sendKind: 'notify', reason: 'ruling', message: bytes, rulings: x.rulings, send: x.send };
      return undefined; // Missing bytes never turn an informational notice into a halt or a second request.
    }
    const seen = Math.max(-1, ...notices.map(x => x.rulings ?? -1)), pending = rules.filter(r => r.seq > seen);
    if (!pending.length) continue;
    return { do: 'send', node: n.id, attempt: n.slot!.attempt, rid: l.rid, sendKind: 'notify', reason: 'ruling', rulings: carried(pending), message: [`Prospective policy for future attempts of ${n.id}:`, ...rulingLines(pending), 'This attempt predates the policy; no change or acknowledgment is required.', ...(l.role === 'writer' ? [WRITER_DECISION] : [])].join('\n') };
  }
  return undefined;
}
/** Send ids dsa rejected (`DriveOpts.rejected`): they delivered nothing (review #784 F1). */
type Refused = { has(id: string): boolean };
/** AN3: receiving an answer does not acknowledge it; request an ack once per answer on this candidate. */
function answerAckDue(s: State, n: NodeState, ar: AttemptRuns, l: LaunchEntry, refused?: Refused): boolean {
  const c = n.candidate;
  if (!c) return false;
  const acked = Math.max(n.slot!.rulings_seen, ...entriesOf(s).flatMap(e => e.kind === 'review' && e.node === n.id && e.verdict === 'ok' && (e.key === c.keys[e.obligation] || c.carry?.reviews.includes(e.seq)) ? [e.ack_rulings ?? -1] : []));
  const requested = Math.max(-1, ...ar.sends.filter(x => x.rid === l.rid && x.reason === 'ruling' && x.sendKind !== 'notify' && !refused?.has(x.send)).map(x => x.rulings ?? -1));
  return rulingsInScope(s, n.id).some(r => !deliversRule(r,l.rid) && r.seq > Math.max(acked, requested));
}
/** Steer message of undelivered rulings (D22.2): one line per ruling `#<seq> (<nodes>): <text>`, then what to do. */
function rulingLines(rules: readonly Rule[]): string[] {
  return rules.map(r => `#${r.seq} (${r.nodes === '*' ? '*' : r.nodes.join(', ')}): ${r.text}`);
}
export function rulingMessage(node: string, role: RunRole, rules: readonly Rule[]): string {
  const top = Math.max(...rules.map(r => r.seq));
  return [`New parent rulings for ${node}:`, ...rulingLines(rules),
    role === 'writer' ? 'Apply these rulings; they override your packet. If you already submitted, fix and submit again.' : `Judge the candidate against these rulings and record your review with --ack-rulings ${top}.`, ...(role === 'writer' ? [WRITER_DECISION] : [])].join('\n');
}
/**
 * The ruling steer of the node's attempt (D22.2/D22.2a), or undefined: the first `running` driver run (writer, then
 * reviewers by n) that lacks an in-scope ruling gets every undelivered one. Never to an `asking` run.
 */
function rulingSteer(s: State, n: NodeState, ar: AttemptRuns, live: readonly LaunchEntry[], view: (l: LaunchEntry) => RunView): Action | undefined {
  const inScope = rulingsInScope(s, n.id);
  if (!inScope.length) return undefined;
  const order = [...live].sort((a, b) => (a.role === 'writer' ? 0 : reviewerN(a)) - (b.role === 'writer' ? 0 : reviewerN(b)));
  for (const l of order) {
    if (view(l).state !== 'running') continue;
    const delivered = deliveredRulings(s, n.id, ar, l), pending = inScope.filter(r => r.seq > delivered && deliversRule(r, l.rid));
    if (!pending.length && !(l.role === 'reviewer' && answerAckDue(s, n, ar, l))) continue;
    // A reviewer follows a complete acknowledgment hint; writer delivery alone is target-filtered.
    const rules = l.role === 'reviewer' ? inScope : pending;
    return { do: 'send', node: n.id, attempt: n.slot!.attempt, rid: l.rid, sendKind: 'steer', message: rulingMessage(n.id, l.role, rules), reason: 'ruling', rulings: Math.max(...rules.map(r => r.seq)) };
  }
  return undefined;
}
/** The dsa call address argument `to:"<wid>/<key>"` of asking notices (D22.6), also used by halts (0.8, L1.4). */
export const toArg = (to: string): string => `to:${JSON.stringify(to)}`;
/** 0.8 (L1.4): ` (to:"<wid>/<key>")` after a run id in a halt or wake line when describe reported the call address, else empty. */
export const callAt = (v: RunView | undefined): string => v?.to ? ` (${toArg(v.to)})` : '';
/**
 * 0.8 (L1.3): the first line of the first writer follow-up (writer run `rid`) after the latest resume of the node's open
 * attempt: `The parent resumed this node (#<seq>)[ after <dep> merged at <commit12>][: <note>]`. Undefined when there
 * is no resume, or a writer follow-up was already recorded after it.
 */
export function resumeLine(s: State, node: string, rid: string): string | undefined {
  const r = resumeOf(s, node), n = s.nodes[node];
  if (!r || !n) return undefined;
  if (n.runs.find(x => x.attempt === r.attempt)?.sends.some(x => x.rid === rid && x.sendKind === 'follow-up' && x.seq > r.seq)) return undefined;
  const deps = afterNodes(r.after), merged = deps.map(id => ({ id, merge: s.nodes[id]?.merged }));
  const clause = merged.length && merged.every(d => d.merge) ? ` after ${merged.map(d => `${d.id} merged at ${d.merge!.commit.slice(0, 12)}`).join(', ')}` : '';
  return `The parent resumed this node (#${r.seq})${clause}${r.note ? `: ${oneLine(r.note)}` : ''}`;
}
/** AN1: the last sentence of an asking notify explains the single-act answer and reviewer acknowledgment. */
export const askingRule = (_node: string): string => 'This records one answer ruling and delivers it to the asking run; reviewers still acknowledge it.';
/**
 * The asking line (D22.6, AN1): one line per open question with the owed CLI/tool selectors and the dsa call address.
 */
export function askingText(node: string, l: LaunchEntry, v: RunView, nodeQuestions?: number): string {
  // DF2: `owed decide` answers only a node's sole question across all its runs; otherwise each question is addressed.
  const qs = v.questions ?? [], single = (nodeQuestions ?? qs.length) === 1 && qs.length === 1;
  if (!qs.length) return `${node}: ${l.role} run ${l.rid}${callAt(v)} is asking (no question reported; see pi-durable-subagents describe --key ${l.rid}); the driver never answers`;
  return qs.map(q => {
    const to = q.to ?? v.to ?? l.rid;
    const command = !single ? `owed answer ${node} --rid ${l.rid} --qid ${q.qid} "<text>"` : `owed decide ${node} --text "<text>"`;
    const tool = !single ? `owed_answer {node:${JSON.stringify(node)}, rid:${JSON.stringify(l.rid)}, qid:${JSON.stringify(q.qid)}, text:"…"}` : `owed_decide {nodes:[${JSON.stringify(node)}], text:"…"}`;
    return `${node}: ${l.role} run ${l.rid} asks (qid ${q.qid}, rev ${q.rev}): ${oneLine(q.question)} — the driver never answers; answer: ${command}; in pi: ${tool}${callAt({ ...v, to })}`;
  }).join('\n');
}
