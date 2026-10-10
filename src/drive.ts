// owed drive: the pure policy (SPEC §12, contract D1/D4). `decide` reads the ledger state, the plan, dsa run views and
// the executor's in-process facts, and returns the actions of one pass. No I/O, no clock, no git: everything it uses
// comes from its arguments. Executing the actions (dsa calls, ledger appends, attest, merge) belongs to the executor.
import { canonical, sha256 } from './canon.ts';
import { driveConfig } from './plan.ts';
import { attestJobs, awaitingRuling, driveReviewer, driveReviewerSlot, entriesOf, halted, nextReviewerN, observationsOf, parentRuling, planAt, resumeOf, reviewerBase, runId, runLabels, waitingFor, writesOverlap } from './reducer.ts';
import { dispatchPacket, evidenceCommand, oneLine, ownerCommands, receipt, renderReceipt, reviewObligations, reviewPacket, reviewRuns } from './views.ts';
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
  | { do: 'notify'; node: string; text: string; rid?: string; qid?: string; rev?: number };

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
   * (every pass). The attempt halts needing a human (D9); the request is never retried. A rejected ruling steer does not
   * halt and delivered nothing to the writer (review #784 F1).
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
const rulingsInScope = (s: State, node: string): Rule[] => s.rules.filter(r => r.nodes === '*' || r.nodes.includes(node));
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
  return dispatchPacket(spec, slot.attempt, slot.worktree, writerRulings(s, node, slot.dispatchSeq));
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
/**
 * Repair follow-up: what to do, the notes of active review blocks (a needs-parent block quotes the ruling that resolved
 * it, which may predate the dispatch when the block came from an earlier attempt), the rulings covering the node recorded after the attempt's dispatch (D18.4), then the `owed why` card of the node.
 */
export function repairMessage(s: State, node: string): string { return repairFollowUp(s, node).message; }
/**
 * The repair follow-up and the `rulings` its send entry records (E4): the highest seq of the rulings it carries (the
 * rulings since dispatch and the rulings quoted by needs-parent block notes), 0 when none. Both come from one state, so
 * a ruling recorded after this state is never counted as carried.
 */
export function repairFollowUp(s: State, node: string): { message: string; rulings: number } {
  const n = s.nodes[node]!, c = n.candidate!, entries = entriesOf(s), quoted: Rule[] = [];
  const notes = n.blocks.filter(b => b.kind === 'judgment' && b.state === 'active').map(b => {
    const e = entries.find(x => x.seq === b.seq), ruled = b.needs === 'parent' ? parentRuling(s, b) : undefined;
    if (ruled) quoted.push(ruled);
    return `- #${b.seq} ${b.obligation} by ${e?.by ?? '?'} rank ${b.rank}${b.needs === 'parent' ? (ruled ? ` (needed a parent ruling; ruling #${ruled.seq}: ${oneLine(ruled.text)})` : ' (needs a parent ruling)') : ''}: ${oneLine(e?.kind === 'review' ? e.note ?? '' : '')}`;
  });
  const since = rulingsInScope(s, node).filter(r => r.seq > n.slot!.dispatchSeq), rulings = since.map(r => `- #${r.seq} ${oneLine(r.text)}`);
  // K5.2: the rulings come first.
  return { rulings: carried([...since, ...quoted]), message: [...(rulings.length ? ['Rulings since dispatch:', ...rulings] : []),
    `owed found problems with your candidate ${c.commit} (submit #${c.seq}) of ${node}, attempt ${n.slot!.attempt}.`,
    `Fix them in your worktree, commit, and run \`owed submit ${node}\`; owed reruns the checks itself.`,
    ...(notes.length ? ['Review blocks (the reviewer\'s note):', ...notes] : []),
    `The \`owed why ${node}\` card:`, '',
    renderReceipt(receipt(s, entries, node))].join('\n') };
}
/** G3.7: the conflicting-files clause of a rebase instruction; empty when the list is unknown. */
const conflictText = (conflicts?: readonly string[]): string => conflicts ? ` (files that conflict with your previous candidate: ${conflicts.length ? conflicts.join(', ') : 'none'})` : '';
/**
 * Rebase follow-up after the slot's latest rebase (stable: it names the rebase entry's bases, not the current trunk).
 * `conflicts` (G3.7): the paths that conflict between the previous candidate and the new base, when known.
 */
export function rebaseMessage(s: State, node: string, conflicts?: readonly string[]): string {
  const slot = s.nodes[node]!.slot!, r = slot.rebase!;
  return `trunk moved; rebase your worktree onto ${s.trunk.name} (${r.base}): in ${slot.worktree} run \`git rebase --onto ${r.base} ${r.from}\`${conflictText(conflicts)}, resolve conflicts within the allowed writes, rerun checks, commit, then \`owed submit ${node}\``;
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
export function resubmitFollowUp(s: State, node: string, conflicts?: readonly string[]): { message: string; rulings: number } {
  const n = s.nodes[node]!, slot = n.slot!, last = lastSubmit(s, node)!, entries = entriesOf(s), quoted: Rule[] = [];
  const notes = resubmitBlocks(s, node).map(b => {
    const e = entries.find(x => x.seq === b.seq), ruled = b.needs === 'parent' ? parentRuling(s, b) : undefined;
    if (ruled) quoted.push(ruled);
    return `- #${b.seq} ${b.obligation} by ${e?.by ?? '?'} rank ${b.rank}${ruled ? ` (needed a parent ruling; ruling #${ruled.seq})` : ''}: ${oneLine(e?.kind === 'review' ? e.note ?? '' : '')}`;
  });
  const since = rulingsInScope(s, node).filter(r => r.seq > slot.dispatchSeq);
  const rules = [...since, ...quoted.filter(q => !since.some(r => r.seq === q.seq))].sort((a, b) => a.seq - b.seq);
  const rb = slot.rebase && slot.rebase.seq > last.seq ? slot.rebase : undefined;
  return { rulings: carried(rules), message: [
    ...(rules.length ? [`Parent rulings for ${node} (apply them; they override your packet):`, ...rules.map(r => `- #${r.seq} ${oneLine(r.text)}`)] : []),
    `Review blocks on your candidate ${last.facts.commit} (submit #${last.seq}) of ${node}, attempt ${slot.attempt} (the reviewer's note):`, ...notes,
    rb ? `Trunk moved, so owed needs a new candidate: rebase your worktree onto ${s.trunk.name} (${rb.base}): in ${slot.worktree} run \`git rebase --onto ${rb.base} ${rb.from}\`${conflictText(conflicts)} and resolve conflicts within the allowed writes.`
      : 'The plan changed since that candidate, so owed needs a new candidate; owed reruns the checks itself.',
    `Fix the blocks in your worktree, commit, and run \`owed submit ${node}\`.`].join('\n') };
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
  const rule = s.rules.findLast(r => r.nodes !== '*' && r.nodes.includes(node));
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
  return rulingsInScope(s, node).filter(r => r.seq > d);
};
/**
 * K5.2: a writer follow-up (`submit`, `rebase`) with the undelivered in-scope rulings first; `rulings` (their highest
 * seq) only when it carries at least one, so a follow-up without rulings stays readable by 0.6.x.
 */
function withRulings(s: State, node: string, ar: AttemptRuns, writer: LaunchEntry, message: string, refused?: Refused): { message: string; rulings?: number } {
  const rules = undelivered(s, node, ar, writer, refused);
  return rules.length ? { message: [`Parent rulings for ${node} (apply them; they override your packet):`, ...rules.map(r => `- #${r.seq} ${oneLine(r.text)}`), message].join('\n'), rulings: carried(rules) } : { message };
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
  const last = lastSubmit(s, node), c = n.candidate ?? (last ? { ...last.facts, seq: last.seq } : undefined), entries = entriesOf(s);
  const blocks = c ? n.blocks.filter(b => b.state === 'active' && b.key === c.keys[b.obligation]) : [];
  const notes = blocks.map(b => {
    const e = entries.find(x => x.seq === b.seq);
    const note = e?.kind === 'review' ? e.note ?? '' : e?.kind === 'obs' ? e.note ?? `exit ${e.exit}` : '';
    return `- #${b.seq} ${b.obligation}${b.kind === 'judgment' ? ` by ${e?.by ?? '?'} rank ${b.rank}` : ''}: ${oneLine(note)}`;
  });
  return { rulings: carried(rules), message: [`New parent rulings for ${node}:`, ...rules.map(r => `#${r.seq} (${r.nodes === '*' ? '*' : r.nodes.join(', ')}): ${oneLine(r.text)}`),
    ...(notes.length ? [`Active blocks on your candidate ${c!.commit} (submit #${c!.seq}):`, ...notes] : []),
    `Apply these rulings; they override your packet. Then commit and run \`owed submit ${node}\`.`].join('\n') };
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
      seen.add(seq); out.push(clip(`#${o.seq} ${o.obligation}: ${o.note ?? `exit ${o.exit}`}`));
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
  const spec = s.plan.nodes.find(x => x.id === node), named = s.rules.findLast(r => r.nodes !== '*' && r.nodes.includes(node));
  for (const o of obligations) {
    if (!o.startsWith('check:')) continue;
    const x = o.slice(6), m = spec?.checks.find(c => c.id === x)?.min_tests;
    if (m === undefined) continue;
    const fails = entriesOf(s).filter((e): e is ObsEntry => e.kind === 'obs' && e.subject === node && e.obligation === o && e.verdict === 'fail' && !e.attribution).slice(-2);
    if (fails.length < 2 || (named && named.seq > fails[1]!.seq)) continue;
    const [a, b] = fails as [ObsEntry, ObsEntry];
    const tests = a.counts?.tests;
    if (a.exit !== 0 || b.exit !== 0 || a.counts?.fail !== 0 || b.counts?.fail !== 0 || tests === undefined || b.counts.tests !== tests || tests >= m) continue;
    return `check ${x}: ${tests} tests ran and passed twice, below min_tests ${m}; the plan's threshold may be wrong: fix the plan (owed plan) or rule (owed rule --nodes ${node} "…")`;
  }
  return undefined;
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
/** D25.6: the commands that resolve an owner decision on `node`, as one clause addressed to the main agent. */
const resolveText = (s: State, node: string): string => { const c = ownerCommands(s, node); return c.length ? `; the main agent resolves it with: ${c.join(' | ')}` : `; the main agent decides: owed why ${node}`; };
// The reason's own trailing `needs the owner` (ownerNeeded) is dropped: the prefix already says it.
const ownerNotify = (s: State, node: string, reason: string): Action => ({ do: 'notify', node, text: `${node}: needs the owner (the main agent decides; owed lists the command): ${oneLine(reason.replace(/ needs the owner$/, ''))}; the driver leaves it alone${resolveText(s, node)}` });

// ---------- decide ----------
const isSealed = (v: RunView): boolean => v.state === 'sealed' || v.state === 'pruned';
const statusOf = (v: RunView): string => v.status ?? 'unknown';
const reviewerN = (l: LaunchEntry): number => Number(l.rid.slice(l.rid.lastIndexOf(':') + 1));
/** Status order of `owed status`: more dependents first, then id. */
const byStatusOrder = (a: NodeState, b: NodeState): number => b.dependents - a.dependents || a.id.localeCompare(b.id);

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
  const open = Object.values(s.nodes).filter(n => n.slot?.open).sort(byStatusOrder);
  for (const n of open) { if (opts.measuring?.has(n.id)) continue; const a = slotAction(s, runs, opts, n); if (a) out.push(a); }
  // Not per slot: dispatch ready nodes in status order while open attempts < max, skipping writes overlaps and owner-needed nodes.
  const writes = (id: string): string[] => plan.nodes.find(x => x.id === id)?.writes ?? [];
  const taken = open.map(n => writes(n.id));
  for (const n of Object.values(s.nodes).filter(n => n.phase === 'ready').sort(byStatusOrder)) {
    const owner = ownerNeeded(s, n.id);
    if (owner) { out.push(ownerNotify(s, n.id, owner)); continue; }
    if (taken.length >= opts.max || !plan.nodes.some(x => x.id === n.id) || taken.some(w => writesOverlap(writes(n.id), w))) continue;
    out.push({ do: 'dispatch', node: n.id });
    taken.push(writes(n.id));
  }
  return out;
}

function slotAction(s: State, runs: ReadonlyMap<string, RunView>, opts: DriveOpts, n: NodeState): Action | undefined {
  const id = n.id, slot = n.slot!, attempt = slot.attempt, c = n.candidate;
  const halt = (reason: string, needs: 'human' | 'owner' = 'human'): Action => ({ do: 'halt', node: id, attempt, reason, needs });
  // 0.8 (L1.3): the first writer follow-up after a resume starts with the resume line (`resumeLine`).
  const send = (l: LaunchEntry, sendKind: SendKind, reason: SendReason, message: string, rulings?: number): Action => {
    const line = l.role === 'writer' && sendKind === 'follow-up' ? resumeLine(s, id, l.rid) : undefined;
    return { do: 'send', node: id, attempt, rid: l.rid, sendKind, message: line ? `${line}\n${message}` : message, reason, ...(rulings !== undefined ? { rulings } : {}) };
  };
  // Row 5: a run asking: notify (question, answer address); the driver never answers.
  // H1.1b: the report carries rid and the first question's qid/rev; its text is askingText as before.
  const asking = (l: LaunchEntry, v: RunView): Action => { const q = v.questions?.[0]; return { do: 'notify', node: id, text: askingText(id, l, v), rid: l.rid, ...(q ? { qid: q.qid, rev: q.rev } : {}) }; };
  // Row 1: halted.
  if (halted(s, id)) return undefined;
  const ar: AttemptRuns = n.runs.find(r => r.attempt === attempt) ?? { attempt, launches: [], sends: [] };
  // Runs that matter: the writer and the reviewer runs of the current candidate (a reviewer run belongs to the latest
  // candidate submitted before its launch entry); runs of earlier candidates are obsolete.
  const live = ar.launches.filter(l => l.role === 'writer' || (!!c && l.seq > c.seq));
  // 0.8 (L1.3): a waiting node is skipped like a halted one; only its asking runs are still reported (row 5).
  if (waitingFor(s, id)) { for (const l of live) { const v = runs.get(l.rid); if (v?.state === 'asking') return asking(l, v); } return undefined; }
  // Owner-needed nodes are never touched (no ledger write, no dsa call): notify only.
  const owner = ownerNeeded(s, id);
  if (owner) return ownerNotify(s, id, owner);
  const writer = ar.launches.find(l => l.role === 'writer');
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
    if (opts.applied.has(x.send) || !live.some(l => l.rid === x.rid)) continue;
    const refused = opts.rejected.get(x.send);
    // D22.3: a rejected ruling steer is never retried and never halts; its rulings travel with repairs and reviewer
    // acks. A rejected ruling follow-up (K5.2) halts like any other send.
    if (refused !== undefined && x.reason === 'ruling' && x.sendKind === 'steer') continue;
    const xl = live.find(l => l.rid === x.rid)!;
    if (refused !== undefined) return halt(rejectedHalt(id, 'send', `${x.send}${callAt(view(xl))}`, refused));
    const bytes = opts.blobs?.get(x.message);
    if (bytes === undefined || sha256(bytes) !== x.message) return halt(`cannot re-send ${x.send}${callAt(view(xl))}: the stored message bytes (blob ${x.message}) were not supplied`);
    return { do: 'send', node: id, attempt, rid: x.rid, sendKind: x.sendKind, message: bytes, reason: x.reason, send: x.send, ...(x.rulings !== undefined ? { rulings: x.rulings } : {}) };
  }
  // Row 5: a run asking (`asking`).
  for (const l of live) if (view(l).state === 'asking') return asking(l, view(l));
  const w = view(writer), wSealed = isSealed(w), wStatus = statusOf(w);
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
    if (!rf) return halt(reason);
    const refused = opts.rejected.get(rf.send);
    return halt(refused !== undefined ? rejectedHalt(id, 'send', `${rf.send}${callAt(w)}`, refused) : `writer run ${at(writer)} finished ruling follow-up ${rf.send} without submitting a new candidate (${cause})`);
  };
  const writerMsg = (message: string): { message: string; rulings?: number } => withRulings(s, id, ar, writer, message, opts.rejected);
  // Row 6: writer cut off in a tool.
  if (wSealed && wStatus === 'unknown') return send(writer, 'follow-up', 'interrupted', WRITER_INTERRUPTED);
  // Row 7: writer sealed non-ok.
  if (wSealed && wStatus !== 'ok') return halt(`writer run ${at(writer)} sealed ${wStatus}${w.error ? `: ${w.error}` : ''}${wStatus === 'rejected' ? `; ${rejectedFixed(id)}` : ''}`);
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
      const r = resubmitFollowUp(s, id, opts.conflicts?.get(id));
      return send(writer, 'follow-up', 'repair', r.message, r.rulings);
    }
    if (rb && !ar.sends.some(x => x.reason === 'rebase' && x.seq > rb.seq)) { const m = writerMsg(rebaseMessage(s, id, opts.conflicts?.get(id))); return send(writer, 'follow-up', 'rebase', m.message, m.rulings); }
    const since = Math.max(rb?.seq ?? slot.dispatchSeq, resumed), nudge = ar.sends.findLast(x => x.reason === 'submit' && x.seq > since);
    if (nudge) return writerHalt(`writer run ${at(writer)} finished without submitting a candidate after follow-up ${nudge.send}`, `no candidate after follow-up ${nudge.send}`, nudge.seq);
    const m = writerMsg(submitMessage(id));
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
    const jobs = attestJobs(s, id).filter(j => !(j.attribution && j.key === c.keys[j.obligation])).map(j => ({ j, errors: observationsOf(s, j.subject, j.obligation, j.key).filter(o => o.verdict === 'error' && o.seq > resumed) }));
    if (jobs.some(x => x.errors.length < 2)) return { do: 'attest', node: id };
    if (jobs.length) return halt(`attest recorded no verdict twice: ${jobs.map(x => `${x.j.obligation} (${x.errors.map(o => `#${o.seq} ${o.note ?? `exit ${o.exit}`}`).join('; ')})`).join(', ')}`);
    // Repair: one follow-up per candidate, at most `repairs` per attempt; a writer that finishes it without resubmitting halts.
    // K5.1: the budget counts the repairs since the node's epoch; K5.2: a due ruling follow-up replaces either halt.
    const repair = (cause: string): Action | undefined => {
      // 0.8 (L1.3): after a resume a sealed writer gets a fresh repair (a running one is still waited for).
      const outstanding = ar.sends.findLast(x => x.reason === 'repair' && x.seq > c.seq && (!wSealed || x.seq > resumed)), budget = repairsSince(s, id, ar);
      if (outstanding) return wSealed ? writerHalt(`writer run ${at(writer)} finished repair follow-up ${outstanding.send} without submitting a new candidate (${cause})`, cause, outstanding.seq) : fenced() ?? steerRulings();
      if (budget.count >= opts.repairs) { const ex = `repairs exhausted (${budget.count} of ${opts.repairs} since ${budget.label}): ${cause}`; return writerHalt(ex, ex, c.seq); }
      const r = repairFollowUp(s, id);
      return send(writer, 'follow-up', 'repair', r.message, r.rulings);
    };
    // D18/D18b.2: a review block on the current candidate whose reviewer says it needs a parent ruling halts (needs
    // human) before any repair, measured or review, until a ruling naming the node is recorded after it; no repair is
    // sent or counted, so no repair carries an undecided contract. The ruling also clears the halt (D3).
    const unruled = n.blocks.filter(b => b.kind === 'judgment' && b.key === c.keys[b.obligation] && awaitingRuling(s, b));
    if (unruled.length) return halt(needsRulingHalt(s, id, unruled));
    // Row 11: a measured block: an obligation of the candidate failed (✘), or an active execution block binds it.
    const measured = n.items.filter(i => i.mark === '✘' || n.blocks.some(b => b.kind === 'exec' && b.state === 'active' && b.obligation === i.obligation));
    if (measured.length) {
      // K5.3: the same count below min_tests twice: the threshold may be the plan's mistake; the parent decides.
      const hint = thresholdHint(s, id, measured.map(i => i.obligation));
      if (hint) return halt(hint);
      // K5.4: the halts this cause reaches cite the failing observations.
      const evidence = execEvidence(s, n, measured);
      return repair(`measured block ${measured.map(i => `${i.obligation} [${i.evidence.map(x => `#${x}`).join(', ')}]`).join(', ')}${evidence.length ? `; ${evidence.join('; ')}` : ''}`);
    }
    const judged = n.blocks.filter(b => b.kind === 'judgment' && b.state === 'active');
    const current = judged.filter(b => b.key === c.keys[b.obligation]), stale = judged.filter(b => b.key !== c.keys[b.obligation]);
    // Row 12: review obligations awaiting and fewer reviewer runs than the candidate needs: launch the next n. G3.1:
    // never while a review block is active on the candidate's key: row 15 repairs it first (a reviewer would judge
    // content the repair replaces).
    const reviewers = live.filter(l => l.role === 'reviewer');
    if (!current.length && n.items.some(i => (i.obligation === 'review' || i.obligation === 'closure-review') && i.status === 'D') && reviewers.length < reviewRuns(s, id))
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
      return halt(`review-missing: reviewer run ${at(l)} sealed ${statusOf(v)}${v.error ? `: ${v.error}` : ''} without recording ${awaiting.join(', ')} on candidate #${c.seq}${statusOf(v) === 'rejected' ? `; ${rejectedFixed(id)}` : ''}`);
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
    // Liveness (D12): a candidate that is not accepted while no driver run of the attempt is unsealed never yields
    // "nothing to do": halt needing the owner with every non-E item and active block (K5.2: a due ruling follow-up first).
    if (wSealed && !reviewing) {
      const items = n.items.filter(i => i.status !== 'E').map(i => `${i.obligation} ${i.mark} ${i.detail}`);
      const blocks = n.blocks.filter(b => b.state === 'active').map(b => blockText(s, c, b));
      return rulingSend() ?? halt(`stalled: ${[...items, ...(blocks.length ? [`active blocks ${blocks.join(', ')}`] : [])].join('; ') || 'candidate not accepted'}${resolveText(s, id)}`, 'owner');
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
  if (!n?.candidate || !spec || n.blocks.some(b => b.state !== 'cleared')) return undefined;
  const pending = n.items.filter(i => i.status === 'D');
  if (!pending.length || !pending.every(i => i.obligation === 'approve' || i.obligation.startsWith('evidence:'))) return undefined;
  const parts = pending.map(i => {
    // G1.3 (bind): candidate-bound acts name the open candidate they judge.
    const c12 = n.candidate!.commit.slice(0, 12);
    if (i.obligation === 'approve') return `awaiting owner approval of candidate ${c12}: owed approve ${node} --candidate ${c12} [--note TEXT] (owner)`;
    const ev = spec.evidence?.find(e => `evidence:${e.id}` === i.obligation);
    return `awaiting manual evidence ${i.obligation}${ev ? ` (${oneLine(ev.what)})` : ''} by ${ev?.by ?? 'reviewer'}: ${evidenceCommand(node, i.obligation.slice(9), `${ev?.by ?? 'reviewer'}:<id>`, c12)}`;
  });
  return { reason: parts.join('; '), needs: pending.some(i => i.obligation === 'approve') ? 'owner' : 'human' };
}

/**
 * Halt reason for current review blocks that need a parent ruling (D18.3): per block `review block #<seq> <obligation>
 * needs a parent ruling: <note>`, then how to resolve it.
 */
export function needsRulingHalt(s: State, node: string, blocks: readonly Block[]): string {
  const entries = entriesOf(s);
  const each = blocks.map(b => { const e = entries.find(x => x.seq === b.seq); return `review block #${b.seq} ${b.obligation} needs a parent ruling: ${oneLine(e?.kind === 'review' ? e.note ?? '' : '')}`; });
  return `${each.join('; ')}; record \`owed rule --nodes ${node} "<decision>"\`; the writer gets the ruling with the next repair`;
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
  const sends = ar.sends.filter(x => x.rid === l.rid && !refused?.has(x.send));
  const launch = l.rulings ?? (l.role === 'writer' ? -1 : before(l.seq));
  // K5.2: every writer send that records `rulings` (submit, rebase, repair, ruling follow-ups) delivered them.
  const base = l.role === 'writer' ? Math.max(s.nodes[node]!.slot!.rulings_seen, launch, ...sends.map(x => x.rulings ?? (x.reason === 'repair' ? before(x.seq) : -1))) : launch;
  return Math.max(base, ...sends.filter(x => x.reason === 'ruling').map(x => x.rulings ?? -1));
}
/** Send ids dsa rejected (`DriveOpts.rejected`): they delivered nothing (review #784 F1). */
type Refused = { has(id: string): boolean };
/** Steer message of undelivered rulings (D22.2): one line per ruling `#<seq> (<nodes>): <text>`, then what to do. */
export function rulingMessage(node: string, role: RunRole, rules: readonly Rule[]): string {
  const top = Math.max(...rules.map(r => r.seq));
  return [`New parent rulings for ${node}:`, ...rules.map(r => `#${r.seq} (${r.nodes === '*' ? '*' : r.nodes.join(', ')}): ${oneLine(r.text)}`),
    role === 'writer' ? 'Apply these rulings; they override your packet. If you already submitted, fix and submit again.' : `Judge the candidate against these rulings and record your review with --ack-rulings ${top}.`].join('\n');
}
/**
 * The ruling steer of the node's attempt (D22.2/D22.2a), or undefined: the first `running` driver run (writer, then
 * reviewers by n) that lacks an in-scope ruling gets every undelivered one. Never to an `asking` run.
 */
function rulingSteer(s: State, n: NodeState, ar: AttemptRuns, live: readonly LaunchEntry[], view: (l: LaunchEntry) => RunView): Action | undefined {
  const inScope = s.rules.filter(r => r.nodes === '*' || r.nodes.includes(n.id));
  if (!inScope.length) return undefined;
  const order = [...live].sort((a, b) => (a.role === 'writer' ? 0 : reviewerN(a)) - (b.role === 'writer' ? 0 : reviewerN(b)));
  for (const l of order) {
    if (view(l).state !== 'running') continue;
    const delivered = deliveredRulings(s, n.id, ar, l), rules = inScope.filter(r => r.seq > delivered);
    if (!rules.length) continue;
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
  const dep = r.after !== undefined ? s.nodes[r.after]?.merged : undefined;
  return `The parent resumed this node (#${r.seq})${dep ? ` after ${r.after} merged at ${dep.commit.slice(0, 12)}` : ''}${r.note ? `: ${oneLine(r.note)}` : ''}`;
}
/**
 * The asking line of a run (D22.6; halts, drive output and wake-up messages): one line per open question, addressed by
 * dsa's call address `questions[].to` (`<wid>/<key>`), or the run id when dsa reports none, in both the pi `subagents`
 * tool form and the CLI form.
 */
export function askingText(node: string, l: LaunchEntry, v: RunView): string {
  const qs = v.questions ?? [];
  if (!qs.length) return `${node}: ${l.role} run ${l.rid}${callAt(v)} is asking (no question reported; see pi-durable-subagents describe --key ${l.rid}); the driver never answers`;
  return qs.map(q => {
    const to = q.to ?? v.to ?? l.rid;
    return `${node}: ${l.role} run ${l.rid} asks (qid ${q.qid}, rev ${q.rev}): ${oneLine(q.question)} — the driver never answers; answer in pi: subagents {action:"send", kind:"answer", ${toArg(to)}, qid:${JSON.stringify(q.qid)}, message:"…"}; or: pi-durable-subagents send --request <id> --to ${to} --kind answer --qid ${q.qid} --rev ${q.rev} --message @<file>`;
  }).join('\n');
}
