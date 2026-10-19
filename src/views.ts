import { actRuns, collapsedActLines, alreadyRecordedText, type RecordedAct } from './identical-acts.ts';
import { reviewRequirementText, type ReviewRequirement } from './risk.ts';
import { nodeReview, readyDispatchSkips, heldFlaky, flakyPass, type DispatchSkip } from './reducer.ts';
import type { AdoptionView, AttemptRuns, Block, CheckSpec, Entry, EscapeClass, EvidenceEntry, HaltEntry, ItemView, LaunchEntry, NodeSpec, NodeState, ObsEntry, Plan, Rule, RuleEntry, SlotRebase, State } from './types.ts';
import { mergeWaitSuffix } from './adopt-wait.ts';
import type { AdoptPreview, GcResult } from './ops.ts';
import type { TrunkDrift } from './git.ts';
import { matchesGlob } from 'node:path';
import { matchesAny, driveConfig, isCheckTemplateRun, activeQuarantine } from './plan.ts';
import { externalTracker, mergeQueue, applicableRules, NO_RULINGS, checkDefinition, checkOf, planAt, overlapping, halted, driveReviewer, driveReviewerSlot, reviewerBase, entriesOf, parentRuling, awaitingRuling, isManual, writesAllowed, allowanceSeq, grantsOf, withinWrites, grantHint, waitingFor, reportedOf, type Waiting } from './reducer.ts';
import { genesisProgress, trunkInvariantReds, activeKnownRed, knownRedPlanSeq, activeQuarantineOf } from './reducer.ts';
import { canonical } from './canon.ts';
import { mergeBatchPlan } from './reducer.ts';
import { mergeBatchSize } from './plan.ts';
/** MT6: the planned batch after the merge queue (`; batch of N: A, B`). */
const batchPlanText = (b: string[] | undefined): string => b?.length ? `; batch of ${b.length}: ${b.join(', ')}` : '';
import { rebasePendingText, WRITER_DECISION, type RebasePending } from './rebase-view.ts';
export { WRITER_DECISION } from './rebase-view.ts';
import { OwedError } from './errors.ts';
import { observationsOf } from './reducer.ts';
import type { WaiveEntry } from './types.ts';
import type { InFlight } from './drive-bg.ts';
import { clockTime } from './clock.ts';
import { nearTimeoutWarnings } from './cost.ts';
import { nodeTestRun } from './exec.ts';
export { trunkRedHint, sharedCheckHint, writerDecisionCommand, writerStopNeed, reviewDecision, trunkDecision, evidenceCommand, resumeCommands, flakyRuleHint, lapsedKnownRedText, genesisLine } from './needs.ts';
import { needs, repoNeeds, activity, itemLine, heldRuling, heldRulingText, resumeCommand, trunkRedHint, sharedCheckHint, evidenceCommand, lapsedKnownRedText, overlapDispatchCommand, genesisLine, type Need, type Runtime } from './needs.ts';
/** WR1: quote the whole final reply, or its head/tail plus omitted commit/durable facts. */
export function writerReply(result?: string): string {
  const flat = result?.replace(/\s+/g, ' ').trim();
  if (!flat) return 'writer gave no final text';
  const points = Array.from(flat), head = points.slice(0, 200), tail = points.slice(-380);
  const h = head.lastIndexOf(' '), t = tail.indexOf(' ');
  const text = points.length <= 600 ? flat : `${head.slice(0, h >= 180 ? h : 200).join('')} … ${tail.slice(t >= 0 && t < 20 ? t + 1 : 0).join('')}`;
  const facts = (pattern: RegExp, commit = false): string[] => {
    const out: string[] = [], seen = new Set<string>();
    for (const m of flat.matchAll(pattern)) {
      const value = m[1] ?? m[0], key = commit ? value.toLowerCase() : value;
      if (seen.has(key)) continue;
      seen.add(key);
      if (text.includes(value)) continue;
      out.push(commit ? value.slice(0, 12) : value);
      if (out.length === 3) break;
    }
    return out;
  };
  const commits = facts(/\b[0-9a-f]{40}\b|(?:\bcommit|\bhead|\u63d0\u4ea4)\s*:?\s*([0-9a-f]{7,40})\b/gi, true);
  const durable = facts(/\b01[0-9A-HJKMNP-TV-Z]{24}\b/g);
  const extra = [commits.length ? `commits: ${commits.join(', ')}` : '', durable.length ? `durable: ${durable.join(', ')}` : ''].filter(Boolean);
  return `writer says: ${JSON.stringify(text).replace(/[\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)}${extra.length ? ` (${extra.join('; ')})` : ''}`;
}
/** LO2: display current driver work without changing the ledger phase or acceptance. */
export const measurementText = (m: InFlight): string => `${m.do === 'merge' ? 'merging' : 'measuring'} (since ${clockTime(m.since)})`;

// Text-only diagnostics: JSON and ledger/replay state stay unchanged.
const readyText = new WeakMap<object, string[]>();
const readyLines = (v: object): string[] => readyText.get(v) ?? [];
const setReadyText = (v: object, lines: string[]): void => { readyText.set(v, lines); };
function dispatchSkipText(s: State, node: string, skip: DispatchSkip): string {
  const prefix = 'ready, not dispatched: ';
  if (skip.kind === 'max') return `${prefix}${skip.open} of max ${skip.max} attempts open`;
  if (skip.kind === 'overlap') return `${prefix}writes overlap ${skip.others.map(o => `${oneLine(o.node)} (${o.paths.map(oneLine).join(', ')})`).join(', ')} → ${overlapDispatchCommand(node)}`;
  if (skip.kind === 'owner') return `${prefix}${nodeNext(s, node)}`;
  return `${prefix}node is no longer in the plan`;
}
export interface ReceiptCard {
  reviewRequirement?: ReviewRequirement;
  conflicts?: Record<string, string[] | null>;
  rebasePending?: RebasePending;
  measuring?: InFlight;
  rulingFollowUp?: string;
  mergeWaiting?: NonNullable<StatusView['mergeWaiting']>[string];
  node: string; phase: NodeState['phase']; accepted: boolean;
  /** TR: failing checks on the current merge key; separate from candidate acceptance. */
  mergeChecks?: (ItemView & { observations: Entry[]; run?: string })[];
  items: (ItemView & { observations: Entry[]; run?: string })[];
  /**
   * `ruling` (D18/D18b.4): only on a needs-parent block recorded on the current candidate: `'needed'` while no ruling
   * naming the node follows it, else the seq of that ruling. A stale needs-parent block has none (stale wording).
   */
  blocks: (Block & { clear: string; ruling?: 'needed' | number; note?: string })[];
  /** L2: execution blocks a plan entry superseded (no longer active), with `text` = `#<seq> superseded by plan #<p> (…)`; present only when there are any. */
  superseded?: SupersededBlock[];
  untested: string[]; downgrades: State['downgrades']; ownerFlags: Entry[];
  grantedWrites?: import('./types.ts').GrantEntry[];
  /** Latest rebase of the open slot; `rangeDiff` lets a reviewer review only the conflict resolution. */
  rebase?: SlotRebase & { rangeDiff?: string };
  /** N1: the open candidate is a carry submit `seq`: carried by plan entry `plan` from submit `submit`. */
  carried?: Carried;
  /** ER1: review provenance, independent of plan candidate carry. */
  reviewCarried?: string;
  /** Active driver halt of the open attempt (SPEC §12). */
  halt?: HaltEntry;
  /** 0.8 (L1.2): the open attempt waits for node `after` to merge (resume entry `resume`). */
  waiting?: Waiting;
  held?: number;
  reported?: number;
  later?: boolean;
  /** `Exec: wrap <argv> · env <NAMES>` when the plan has an `exec` block (D20.5); env values are not shown. */
  exec?: string;
  /** K3: `Drive: writer <agent> (<model>) · reviewer <agent> (<model>)` (effective values) when the node sets `drive`. */
  drive?: string;
  /** DR3: observed models and selection/independence diagnostics, informational only. */
  models?: string;
  modelWarnings?: (string | { message: string; acknowledged: true })[];
  /** Driver launches and sends of the open attempt. */
  runs?: AttemptRuns;
  /** D23 receipts recorded on the merged node (informational), in ledger order; present only when there are any. */
  receipts?: EvidenceEntry[];
  /** MS5: active quarantine entries this node's merge lifts (it is their `fix`). */
  lifts?: QuarantineDebt[];
  /**
   * D21.5: when the writes item fails (✘/⛔), the candidate's changed paths outside the node's writes; `allowance` = S
   * when an allowance of the current plan lets the parent widen writes to cover all of them.
   */
  outOfWrites?: { paths: string[]; allowance?: number; hint?: string; grantRefused?: boolean };
}
/** KR4: one debt line per invariant, independent of whether its latest observation passes. */
export interface KnownRedDebt { invariant: string; entries: { test: string; fix: string }[]; plan: number }
export function knownRedDebt(s: State): { knownRed?: KnownRedDebt[]; lapsedKnownRed?: KnownRedDebt[] } {
  const plan = knownRedPlanSeq(s), knownRed: KnownRedDebt[] = [], lapsedKnownRed: KnownRedDebt[] = [];
  for (const inv of s.plan.invariants) {
    const entries = activeKnownRed(s, inv.id), lapsed = (inv.known_red ?? []).filter(e => !entries.includes(e));
    if (entries.length) knownRed.push({ invariant: inv.id, entries, plan });
    if (lapsed.length) lapsedKnownRed.push({ invariant: inv.id, entries: lapsed, plan });
  }
  return { ...(knownRed.length ? { knownRed } : {}), ...(lapsedKnownRed.length ? { lapsedKnownRed } : {}) };
}
export const knownRedText = (d: KnownRedDebt): string => `inv:${d.invariant} known red: ${d.entries.map(e => `${oneLine(e.test)} (fix: ${oneLine(e.fix)})`).join(', ')}; plan #${d.plan}`;
/** MS5: one debt line per active quarantine entry: invariants `<inv>/<test>`, node checks `<node>/<check>/<test>`. */
export interface QuarantineDebt { where: string; test: string; fix: string; note?: string; passed?: { seq: number; commit: string; merging?: string; batch?: string[] } }
export function quarantineDebt(s: State, fix?: string): QuarantineDebt[] {
  let observations: ObsEntry[] | undefined;
  const of = (where: string, subject: string, obligation: string, spec: CheckSpec): QuarantineDebt[] => {
    const entries = activeQuarantineOf(s, spec).filter(e => fix === undefined || e.fix === fix);
    if (!entries.length) return [];
    observations ??= entriesOf(s).filter((e): e is ObsEntry => e.kind === 'obs' && (e.subject === 'trunk' || e.merging !== undefined || e.batch !== undefined || e.probe === 'trunk'));
    const latest = observations.findLast(e => {
      if (e.subject !== subject || e.obligation !== obligation) return false;
      if (e.quarantine_passed === undefined && (e.counts?.format !== 'tap' || e.execution?.completed !== true)) return false;
      const plan = planAt(s, e.seq), original = subject === 'trunk' ? plan.invariants.find(i => `inv:${i.id}` === obligation) : plan.nodes.find(n => n.id === subject)?.checks.find(c => `check:${c.id}` === obligation);
      const active = original && activeQuarantine(plan, original, id => !!s.nodes[id]?.merged, e.merging);
      return !!active?.length && (e.quarantine_passed !== undefined || nodeTestRun(original!.run));
    });
    return entries.map(e => ({ where, test:e.test, fix:e.fix, ...(e.note ? { note:e.note } : {}),
      ...(latest?.quarantine_passed?.includes(e.test) ? { passed:{seq:latest.seq, commit:latest.commit, ...(latest.merging ? {merging:latest.merging} : {}), ...(latest.batch ? {batch:[...latest.batch]} : {})} } : {}) }));
  };
  return [...s.plan.invariants.flatMap(i => of(i.id, 'trunk', `inv:${i.id}`, i)), ...s.plan.nodes.filter(n => !s.nodes[n.id]?.merged).flatMap(n => n.checks.flatMap(c => of(`${n.id}/${c.id}`, n.id, `check:${c.id}`, c)))];
}
export const quarantineText = (d: QuarantineDebt): string => d.passed
  ? `quarantined ${oneLine(d.test)} passed on ${d.passed.merging !== undefined || d.passed.batch !== undefined ? `the merge tree of ${oneLine(d.passed.merging ?? d.passed.batch!.join(', '))}` : `trunk ${d.passed.commit.slice(0,12)}`} (#${d.passed.seq}); remove it from quarantine if it stays green (fix ${oneLine(d.fix)})`
  : `quarantine ${oneLine(d.where)}/${oneLine(d.test)} until ${oneLine(d.fix)} merges`;
/** MS5: `owed why <fix>`: the quarantine entries its merge lifts. */
export const liftsText = (node: string, ds: QuarantineDebt[]): string => `merging ${node} lifts quarantine: ${ds.map(d => `${oneLine(d.where)}/${oneLine(d.test)}`).join(', ')}`;
/** NT3: presentation-only defer scope; unverified debt has not had its merge key rechecked. */
export type DeferredView = State['deferred'][number] & { unverified?: 'drift' | 'conflict' };
export interface StatusView {
  /** CO3: runtime diagnostics only, never an outstanding obligation. */
  runtimeWarnings?: string[];
  /** GC1: registered worktrees of recorded closed attempts, advisory and runtime only. */
  housekeeping?: number;
  reviewRequirements?: Record<string, ReviewRequirement>;
  conflicts?: Record<string, Record<string, string[] | null>>;
  rebasePending?: Record<string, RebasePending>;
  knownRed?: KnownRedDebt[]; lapsedKnownRed?: KnownRedDebt[];
  deferred?: DeferredView[];
  trunk: State['trunk']; nodes: Record<string, NodeState>; groups: Record<string, string[]>;
  /** MO3: accepted open attempts in the driver's merge order (empty when none). */
  mergeQueue: string[];
  /** MT6 (0.21): the batch the driver merges next with `drive.merge_batch` >= 2 (absent when none). */
  mergeBatch?: string[];
  /** DR2: private driver busy receipts scoped to the current candidate/attempt. */
  mergeWaiting?: Record<string, { reason: string; since: string; attempt: number; candidate?: number; ahead?: number; job?: string; jobSince?: string }>;
  /** LO2: live driver work; all timestamps remain ISO UTC in JSON. */
  measuring?: Record<string, InFlight>;
  /** IR3: parent-only trunk invariant diagnostics. */
  trunkRed?: { obligation: string; key: string; text: string }[];
  /** Advisory only; does not enter the merge guard or any acceptance key. */
  sweepRed?: {seq:number; names:string[]};
  /** Pending items; an item held by execution blocks carries their failing observations' notes (`blockNotes`, K2.2). */
  ready: string[]; pending: Record<string, (ItemView & { blockNotes?: BlockNote[]; hint?: string })[]>; invariants: ItemView[]; ownerFlags: Entry[];
  /** Ready nodes whose writes overlap a node with an open slot (dispatch refuses them without --allow-overlap). */
  overlaps: Record<string, string[]>;
  /** Present when refs/heads/<trunk> differs from the ledger trunk (commits made outside owed, or a rewritten trunk). */
  drift?: TrunkDrift;
  /** D19.5: present when the trunk branch is checked out in a worktree other than the main worktree (its path). */
  trunkWorktree?: string;
  /** Nodes whose open attempt the driver halted (SPEC §12); needs owner halts also appear under Pending owner. */
  halted: HaltEntry[];
  /** 0.8 (L1.5): open attempts waiting for another node to merge; present only when there are any. */
  waiting?: (Waiting & { node: string })[];
  reported?: { node: string; resume: number }[];
  held?: { node: string; abandon: number }[];
  later?: string[];
  /** Driver launches of each open slot's current attempt, by node. */
  launches: Record<string, LaunchEntry[]>;
  /** Active review blocks on the current candidates of open attempts that need a parent ruling and have none yet (D18, D18b.4), with the reviewer's note. */
  needsRuling?: (Block & { note: string })[];
  /** N1: open candidates that are carry submits; present only when there are any. */
  carried?: (Carried & { node: string })[];
  /** L2: superseded execution blocks of nodes that are not merged; present only when there are any. */
  superseded?: SupersededBlock[];
  /** SQ: outcome and next actions; existing status fields remain available in JSON. */
  summary?: SummaryView;
  /** Present while genesis items lack observations (D24.5); `measuring` when this process runs their genesis attest. */
  genesis?: GenesisStatus;
}
export interface SummaryView {
  merged: number;
  needs: { node: string; reason: string; command: string }[];
  progress: { node: string; phase: string; ageMs: number }[];
  debt: string[];
}
export interface GenesisStatus { observed: number; total: number; pending: string[]; measuring?: boolean }
/** One line: backslashes, newlines and other control characters are escaped, so a value cannot add lines to a dialog or terminal prompt. */
/** Escapes C0/C1 controls, DEL, line/paragraph separators and bidi controls (U+202A–U+202E, U+2066–U+2069). */
export function oneLine(text: string): string {
  return text.replace(/[\\\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, c => c === '\\' ? '\\\\' : c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
/** One line explaining a trunk ref that differs from the ledger trunk, and what the owner can do. */
export function driftText(d: TrunkDrift): string {
  const ref = `${d.ref}${d.commit ? ` (${d.commit.slice(0, 12)})` : ''}`, ledger = d.ledger.slice(0, 12);
  if (d.relation === 'missing') return `trunk ref ${d.ref} does not exist; the ledger trunk is ${ledger}`;
  if (d.relation === 'ledger-missing') return `ledger trunk ${d.ledger} is missing from the repository; ${ref} cannot be compared with it, and owed adopt cannot record it`;
  if (d.relation === 'ahead') return `trunk moved outside owed: ${ref} is ahead of the ledger trunk ${ledger} by ${plural(d.ahead, 'commit')}; review them, then the owner runs owed adopt --note TEXT`;
  return `trunk diverged from the ledger (rewritten or reset outside owed): ${ref} is not a fast-forward of the ledger trunk ${ledger} (${d.ahead} ahead, ${d.behind} behind); owed adopt accepts only fast-forwards: restore ${d.ref} to a descendant of ${ledger}`;
}
/** D19.5: the status line for a trunk branch checked out in a worktree other than the main worktree. */
export function trunkWorktreeText(name: string, path: string): string { return `Trunk ${name} is checked out at ${path}; merges fast-forward it there (keep it clean).`; }
export interface Report {
  reviews?: { sameModel: number };
  knownRed?: KnownRedDebt[];
  /** MS5: active quarantine entries (`quarantine <inv>/<test> until <fix> merges`). */
  quarantine?: string[];
  trackedDebt?: string[];
  since: number | string; merges: Entry[]; blocks: ReceiptCard['blocks']; waivers: Entry[];
  downgrades: State['downgrades']; rulings: State['rules']; decisions: ItemView[];
  changes: { subject: string; obligation: string; before?: string; after: string }[];
  /** Owner entries after `since`, except `adopt` (listed once, under `adoptions`). */
  ownerActions: Entry[];
  /** Adoptions of trunk commits made outside owed, after `since` (owner ones, and parent ones under allowance). */
  adoptions: AdoptionView[];
  /** Driver halts after `since`, plus every still active halt (`active`). */
  halts: (HaltEntry & { active: boolean })[];
  escapes: EscapeSummary;
  /** D23 receipts (evidence entries on merged nodes) after `since`. */
  receipts?: EvidenceEntry[];
  /** L2: execution blocks superseded by a plan entry after `since`; present only when there are any. */
  superseded?: SupersededBlock[];
}
/** SA2: decision-first runtime presentation; bounded fields retain whole code points and escaped controls. */
export function structuredQuestionText(q: import('./types.ts').RunQuestion): string {
  const clip = (s: string, max: number): string => {
    let out = ''; for (const cp of s) { const escaped = oneLine(cp); if (out.length + escaped.length > max) break; out += escaped; } return out;
  };
  const options = (q.options ?? []).map((o, i) => {
    const limits = (['scope', 'cost', 'risk'] as const).flatMap(k => o[k] !== undefined ? [`${k} ${clip(o[k]!, 160)}`] : []);
    return `${i + 1}) ${clip(o.label, 160)}${o.preferred ? ' (preferred)' : ''}${limits.length ? ` — ${limits.join('; ')}` : ''}`;
  }).join(' | ');
  const context = [q.facts?.length ? `facts: ${q.facts.join('; ')}` : '', q.tried?.length ? `tried: ${q.tried.join('; ')}` : '',
    q.classification_candidates?.length ? `candidates: ${q.classification_candidates.map(c => {
      const proof = [c.evidence?.length ? `evidence: ${c.evidence.join('; ')}` : '', c.unproven?.length ? `unproven: ${c.unproven.join('; ')}` : ''].filter(Boolean);
      return `${c.label}${proof.length ? ` (${proof.join('; ')})` : ''}`;
    }).join('; ')}` : ''].filter(Boolean).join('; ');
  return [`DECISION: ${oneLine(q.decision_needed!)}`, `options: ${options}`, ...(context ? [clip(context, 600)] : []), `details: ${clip(q.question, 300)}`].join('\n');
}

/** D23: files of a manual evidence entry as `path sha12`, then its note (always manual, never measured). */
export function evidenceText(e: EvidenceEntry): string {
  return `files ${e.files.map(f => `${oneLine(f.path)} ${f.sha256.slice(0, 12)}`).join(', ') || 'none'}; note: ${oneLine(e.note)}`;
}
/** One D23 receipt line: `Receipt #seq <id> by <who> (merge #m): files …; note: …`. */
export const receiptText = (e: EvidenceEntry): string => `Receipt #${e.seq} ${e.node}/${e.id} by ${e.by}${e.channel === 'flag' ? ' (flag weak confirmation)' : ''} (merge #${e.merge}): ${evidenceText(e)}`;
/** CLI owner confirmation for adopt: full prior..commit, commit count, every changed path (one per line) and the note, escaped onto single lines. */
export function renderAdoptPreview(p: AdoptPreview, note: string): string {
  return [`Adopt trunk ${oneLine(p.trunk)}: ledger trunk ${p.prior}..${p.commit}`, `${plural(p.commits, 'commit')} made outside owed, not reviewed by owed; adopting makes ${p.commit} the ledger trunk.`, `Changed paths (${p.changed.length}):${p.changed.length ? '' : ' none'}`, ...p.changed.map(path => `  ${oneLine(path)}`), `Note: ${oneLine(note)}`].join('\n');
}
/** Owner adoptions under the owner-decisions heading, parent adoptions (under allowance) under their own; each omitted when empty. */
function adoptionSections(all: AdoptionView[] | undefined, section: (title: string, lines: string[]) => string[], owner: string, parent: string): string[] {
  const own = (all ?? []).filter(a => a.allowance === undefined), allowed = (all ?? []).filter(a => a.allowance !== undefined);
  return [...(own.length ? section(owner, own.map(adoptionText)) : []), ...(allowed.length ? section(parent, allowed.map(adoptionText)) : [])];
}
/** prior..commit, commit count, changed paths and note of one adoption. */
export function adoptionText(a: AdoptionView): string {
  const paths = a.changed.length > 20 ? [...a.changed.slice(0, 20), `… (+${a.changed.length - 20} more)`] : a.changed;
  const who = a.allowance !== undefined ? `adopted by ${a.by} under allowance (plan #${a.allowance})` : `${a.by}${a.channel === 'flag' ? ' (flag weak confirmation)' : a.channel === 'delegated' ? ' (delegated)' : ''} adopted`;
  return `#${a.seq} ${who} ${a.prior.slice(0, 12)}..${a.commit.slice(0, 12)} (${plural(a.commits, 'commit')} made outside owed, not reviewed by owed); changed: ${paths.join(', ') || 'none'}; note: ${a.note}`;
}
/** A block that still counts (active or flaky); cleared and superseded (L2) blocks do not. */
const countsBlock = (b: Block): boolean => b.state === 'active' || b.state === 'flaky';
/** N1: a carried candidate: carry submit `seq`, carried by plan entry `plan` from submit `submit`. */
export interface Carried { seq: number; plan: number; submit: number }
/** N1: the carry of node `n`'s open candidate, if it is a carry submit. */
const carriedOf = (n: NodeState): Carried | undefined => n.slot?.open && n.candidate?.carried ? { seq: n.candidate.seq, ...n.candidate.carried } : undefined;
/** N1: `candidate #C carried by plan #P from submit #S`. */
export const carriedText = (c: Carried): string => `candidate #${c.seq} carried by plan #${c.plan} from submit #${c.submit}`;
/** ER1: one receipt line; original review seqs remain visible rather than fabricating judgments on C'. */
export const reviewCarryText = (facts: import('./types.ts').CandidateFacts): string => facts.carry ? `review carried from ${facts.carry.from.slice(0,12)} (${facts.carry.reviews.map(seq => `#${seq}`).join(', ')}) across a clean rebase onto ${facts.base.slice(0,12)}` : '';
/** N1.3: the line `owed plan` prints for a carry submit recorded after the plan entry. */
export const carryLine = (e: Entry): string => e.kind === 'submit' ? `Carried ${e.node}: candidate ${e.facts.commit.slice(0, 12)} (submit #${e.carry}) is still the candidate as #${e.seq}; changed checks are measured again` : '';
/** N1 (23:4x): the line `owed plan` prints for a carry it skipped. */
export const notCarriedLine = (x: { node: string; reason: string }): string => `Not carried ${x.node}: ${x.reason}; the writer submits again`;
/** N3: what `owed amend` and owed_amend print: the plan entry, carries, the rule and the file written. */
export const amendLines = (r: import('./ops.ts').AmendResult): string[] => [
  ...(r.plan ? [renderEntry(r.plan)] : []), ...r.carried.map(carryLine), ...r.notCarried.map(notCarriedLine), ...(r.rule ? [renderEntry(r.rule)] : []),
  `${r.added.length ? `Widened writes of ${r.node}: ${r.added.map(p => `+${p}`).join(', ')}; wrote ${r.path}` : `${r.node}: writes unchanged`}${r.covered.map(c => `; ${c.path} already covered by ${c.entry}`).join('')}`,
];
/** L2: a superseded execution block with its audit line. */
export type SupersededBlock = Block & { supersededBy: number; text: string };
/** L2: `#<seq> superseded by plan #<p> (check <id> definition changed|removed)`. */
export function supersededText(s: State, b: Block): string {
  const id = checkOf(b.obligation) ?? b.obligation, p = b.supersededBy ?? -1;
  let removed = false;
  try { removed = checkDefinition(planAt(s, p + 1), b.node, id) === undefined; }
  catch (e) {
    // Only the absence of a plan entry is informational; missing/unreadable plan blobs must fail the view.
    if (!(e instanceof OwedError && e.code === 'internal' && e.message === `No plan is in force before #${p + 1}`)) throw e;
  }
  return `#${b.seq} superseded by plan #${p} (check ${id} ${removed ? 'removed' : 'definition changed'})`;
}
/** L2: the superseded blocks of `nodes`, in ledger order of the blocks. */
export function supersededOf(s: State, nodes: readonly NodeState[]): SupersededBlock[] {
  return nodes.flatMap(n => n.blocks.filter(b => b.state === 'superseded').map(b => ({ ...b, supersededBy: b.supersededBy ?? -1, text: supersededText(s, b) })));
}
/** Full history stays out of JSON; text folding never changes evidence or replay. */
const actHistories = new WeakMap<object, readonly Entry[]>();
// AK: presentation context is not serialized; evidence and JSON retain the complete history.
const presentationStates = new WeakMap<object, State>();
const presentationRuntime = new WeakMap<object, Runtime>();
export function withPresentationState<T extends object>(view: T, state: State, rt?: Runtime): T {
  presentationStates.set(view, state);
  if (rt) presentationRuntime.set(view, rt);
  return view;
}
/** Render the authority's answer without choosing a remedy. */
export const needText = (n: Need): string => `${n.text}${n.command ? ` → ${n.command}` : ' (no single command)'}`;
export function nodeNext(s: State, node: string, rt?: Runtime): string {
  return (node === 'trunk' ? repoNeeds(s, rt) : needs(s, node, rt)).map(needText).join('\n') || activity(s, node, rt)?.text || '';
}
function cardNeeds(v: ReceiptCard): Need[] {
  const s = presentationStates.get(v), rt = presentationRuntime.get(v);
  if (!s) return [];
  return v.node === 'trunk' || v.node.startsWith('inv:')
    ? repoNeeds(s, rt).filter(n => v.node === 'trunk' || n.obligation === v.node)
    : needs(s, v.node, rt);
}
function cardHeld(v: ReceiptCard): RuleEntry | undefined {
  const s = presentationStates.get(v);
  return s && heldRuling(s, v.node);
}
function cardActivity(v: ReceiptCard): string | undefined {
  const s = presentationStates.get(v);
  if (v.measuring && !presentationRuntime.get(v)?.measuring?.some(m => m.node === v.node)) return measurementText(v.measuring);
  return s ? activity(s, v.node, presentationRuntime.get(v))?.text : undefined;
}
const cardItemLine = (v: ReceiptCard, i: ItemView): string => {
  const s = presentationStates.get(v);
  return s ? itemLine(s, i.subject, i.obligation, presentationRuntime.get(v)) : oneLine(i.detail);
};
export const measuredPendingText = (v: ReceiptCard): string => `measured; not accepted yet: ${cardNeeds(v)[0]?.text ?? cardActivity(v) ?? v.items.filter(i => i.status === 'D').map(i => cardItemLine(v, i)).join('; ')}`;
function currentDowngrades(v: ReceiptCard): State['downgrades'] {
  const s = presentationStates.get(v), slot = s?.nodes[v.node]?.slot;
  if (!s || !slot) return [];
  const resumed = entriesOf(s).findLast(e => e.kind === 'resume' && e.node === v.node && e.attempt === slot.attempt);
  return v.downgrades.filter(d => d.seq > Math.max(slot.dispatchSeq, resumed?.seq ?? -1));
}
const downgradeLines = (ds: State['downgrades']): string[] => ds.map(d => `ΔO⁻ #${d.seq}${d.allowance !== undefined ? ` ${allowanceLabel(d)}` : ''}: ${d.items.map(i => `${i.node}: ${i.what}`).join('; ')}`);
/** AK1: the ask follows the first marker, not the introduction of the review. */
export function reviewAsk(note: string): string {
  const marker = /BLOCK\s*\(needs parent\)\s*:|Parent decision needed\s*:|needs parent/i.exec(note);
  const tail = marker ? note.slice(marker.index + marker[0].length).replace(/^[\s):—-]+/, '') : note.trim().match(/[^.!?]+[.!?]*\s*$/)?.[0] ?? note;
  return oneLine(tail.trim().replace(/\s+/g,' ')).slice(0,300).trim();
}
export function withActHistory<T extends object>(view: T, entries: readonly Entry[]): T { actHistories.set(view,entries); return view; }
const repetitions = new WeakMap<Entry, number>();
const repetition = (e: Entry): string => (repetitions.get(e) ?? 1) > 1 ? ` ×${repetitions.get(e)}` : '';
function textReceiptItem(i: ReceiptCard['items'][number], runs: ReturnType<typeof actRuns>): ReceiptCard['items'][number] {
  if (!['review','closure-review','rulings'].includes(i.obligation)) return i;
  const shown = new Set<object>();
  const observations = i.observations.flatMap(e => {
    const run = runs.get(e.seq);
    if (!run) return [e];
    if (shown.has(run)) return [];
    shown.add(run);
    const copy = { ...e }; repetitions.set(copy,run.count); return [copy];
  });
  return { ...i, observations };
}
/** RR3: receipt-only deduplication; keep reducer evidence/replay and distinct-principal satisfaction unchanged. */
export function receiptItem(i: ItemView, entries: readonly Entry[]): ItemView & { observations: Entry[] } {
  const infra = new Set(entries.flatMap(e => e.kind === 'obs' && i.evidence.includes(e.seq) && e.infra !== undefined ? [e.infra] : []));
  let observations = entries.filter(e => i.evidence.includes(e.seq) || infra.has(e.seq));
  if (i.status === 'E' && reviewObligation(i.obligation)) {
    const latest = new Map<string, Entry>();
    for (const e of observations) if (e.kind === 'review' && e.seq > (latest.get(e.by)?.seq ?? -1)) latest.set(e.by, e);
    observations = observations.filter(e => e.kind !== 'review' || latest.get(e.by) === e);
    return { ...i, evidence: observations.map(e => e.seq), observations };
  }
  return { ...i, observations };
}
/** CT1: expanded template commands in receipts; ordinary 0.17 cards keep exactly their old shape. */
export function templateReceiptRun(s: State, item: ItemView): { run?: string } {
  const spec = item.obligation.startsWith('inv:') ? s.plan.invariants.find(c => `inv:${c.id}` === item.obligation) : s.plan.nodes.find(n => n.id === item.subject)?.checks.find(c => `check:${c.id}` === item.obligation || `red:${c.id}` === item.obligation);
  return spec && isCheckTemplateRun(spec.run) ? { run: spec.run } : {};
}
export function receipt(s: State, entries: readonly Entry[], node: string, mergeChecks: ItemView[] = [], dispatchMax = driveConfig(s.plan).max, rt?: Runtime): ReceiptCard {
  const n = s.nodes[node]!;
  const checks = (s.plan.nodes.find(x => x.id === node)?.checks ?? []).filter(c => n.items.some(i => i.obligation === `check:${c.id}` && i.status === 'E'));
  const outOfWrites = outsideWrites(s, node), superseded = supersededOf(s, [n]);
  const card = withPresentationState(withActHistory({ node, phase: n.phase, accepted: n.accepted,
    ...(s.plan.risk !== undefined && n.candidate ? { reviewRequirement: nodeReview(s, node) } : {}),
    items: n.items.map(i => ({ ...receiptItem(i, entries), ...templateReceiptRun(s, i) })),
    ...(mergeChecks.length ? { mergeChecks: mergeChecks.map(i => ({ ...receiptItem(i, entries), ...templateReceiptRun(s, i) })) } : {}),
    blocks: n.blocks.filter(b => countsBlock(b)).map(b => ({ ...b, clear: mergeBlockClearHint(s, entries, b, rt), ...(currentNeeds(s, b) ? { ruling: parentRuling(s, b)?.seq ?? ('needed' as const) } : {}), ...withNote(blockNote(s, b)) })),
    ...(superseded.length ? { superseded } : {}),
    untested: (n.candidate?.changed ?? []).filter(p => !checks.some(c => matchesAny(p, c.reads))),
    ownerFlags: entries.filter(e => e.by.startsWith('owner:') && e.channel === 'flag'),
    downgrades: s.downgrades.filter(d => d.items.some(i => i.node === node || i.node === '*')),
    ...(n.held !== undefined ? { held:n.held } : {}),
    ...(halted(s, node) ? { halt: halted(s, node) } : {}),
    ...(waitingFor(s, node) ? { waiting: waitingFor(s, node) } : {}),
    ...(reportedOf(s, node) !== undefined ? { reported: reportedOf(s, node) } : {}),
    ...(s.plan.nodes.find(x => x.id === node)?.later ? { later: true } : {}),
    ...(s.plan.exec ? { exec: execText(s.plan) } : {}),
    ...(s.plan.nodes.find(x => x.id === node)?.drive ? { drive: driveText(s.plan, node) } : {}),
    ...(entries.some(e => e.kind === 'evidence' && e.node === node && e.merge !== undefined) ? { receipts: entries.filter((e): e is EvidenceEntry => e.kind === 'evidence' && e.node === node && e.merge !== undefined) } : {}),
    ...(outOfWrites ? { outOfWrites } : {}),
    ...(!n.merged && quarantineDebt(s, node).length ? { lifts: quarantineDebt(s, node) } : {}),
    ...(grantsOf(s,node).length ? { grantedWrites: grantsOf(s,node) } : {}),
    ...(n.slot?.open && n.runs.some(r => r.attempt === n.slot!.attempt) ? { runs: n.runs.find(r => r.attempt === n.slot!.attempt) } : {}),
    ...(carriedOf(n) ? { carried: carriedOf(n) } : {}),
    ...(n.candidate?.carry ? {reviewCarried:reviewCarryText(n.candidate)} : {}),
    ...(n.slot?.open && n.slot.rebase ? { rebase: { ...n.slot.rebase, ...(n.slot.rebase.previous ? { rangeDiff: `git range-diff ${n.slot.rebase.previous.base}..${n.slot.rebase.previous.commit} ${n.slot.base}..${n.candidate?.commit ?? '<new commit>'}` } : {}) } } : {}) }, entries), s, rt);
  if (n.phase === 'ready') {
    const skip = readyDispatchSkips(s, dispatchMax).get(node);
    if (skip) setReadyText(card, [dispatchSkipText(s, node, skip)]);
  }
  return card;
}
/** One line naming the plan's wrapper argv and env names (D20.5); argv words with blanks or quotes are JSON-quoted. */
export function execText(plan: Plan): string {
  const word = (w: string): string => /^[^\s"'\\]+$/.test(w) ? w : JSON.stringify(w);
  const parts = [...(plan.exec?.wrap?.length ? [`wrap ${typeof plan.exec.wrap === 'string' ? oneLine(word(plan.exec.wrap)) : plan.exec.wrap.map(w => oneLine(word(w))).join(' ')}`] : []), ...(plan.exec?.env && Object.keys(plan.exec.env).length ? [`env ${Object.keys(plan.exec.env).sort().join(', ')}`] : []), ...(plan.exec?.parallel !== undefined ? [`parallel ${plan.exec.parallel}`] : []), ...(plan.exec?.trees !== undefined ? [`trees ${plan.exec.trees}`] : [])];
  return `Exec: ${parts.join(' · ')}`;
}
/** K3: the effective writer and reviewer of a node's later driver launches; `(<model>)` only when a model is set. */
export function driveText(plan: Plan, node: string): string {
  const cfg = driveConfig(plan, node), role = (name: string, a: { agent: string; model?: string }): string => `${name} ${oneLine(a.agent)}${a.model !== undefined ? ` (${oneLine(a.model)})` : ''}`;
  return `Drive: ${role('writer', cfg.writer)} · ${role('reviewer', cfg.reviewer)}`;
}
/** D21.5: out-of-writes paths of the current candidate when its writes item fails, and the allowance that covers them all. */
function outsideWrites(s: State, node: string): ReceiptCard['outOfWrites'] {
  const n = s.nodes[node], spec = s.plan.nodes.find(x => x.id === node), writes = n?.items.find(i => i.obligation === 'writes');
  if (!n?.candidate || !spec || !writes || (writes.mark !== '✘' && writes.mark !== '⛔')) return undefined;
  const paths = n.candidate.changed.filter(p => !withinWrites(s,node,p)), seq = allowanceSeq(s);
  const covered = seq !== undefined && writesAllowed(s.plan,node,paths);
  const failure = observationsOf(s,node,'writes',writes.key).findLast(o => o.verdict === 'fail');
  // Only a recorded GR2 refusal demonstrates an attempted grant; an old writes failure does not.
  const grantRefused = covered && failure?.grant_refused === true;
  const hint = grantHint(s,node,paths) ?? (failure?.waits_on ? failure.note : covered && !grantRefused ? 'hint: paths are now pre-authorized; submit a new commit (any change, e.g. an amended commit message) so the writes item is measured again under the new allow rule' : undefined);
  return paths.length ? { paths, ...(covered ? { allowance: seq } : {}), ...(grantRefused ? { grantRefused: true } : {}), ...(hint ? { hint } : {}) } : undefined;
}
/** Out-of-writes paths shown in the receipt card (D21.5); the JSON keeps them all. */
const OUT_OF_WRITES_SHOWN = 20;
function outOfWritesText(o: NonNullable<ReceiptCard['outOfWrites']>): string {
  const shown = o.paths.slice(0, OUT_OF_WRITES_SHOWN).map(oneLine).join(', '), more = o.paths.length > OUT_OF_WRITES_SHOWN ? `, … +${o.paths.length - OUT_OF_WRITES_SHOWN} more` : '';
  return `Out-of-writes paths: ${shown}${more}${o.allowance !== undefined ? `; pre-authorized by allowance plan #${o.allowance}${o.grantRefused ? ', but grant refused' : ''}` : ''}${o.hint ? `\n${o.hint}` : ''}`;
}
/** `by parent:<id> under allowance (plan #S)` of a downgrade a parent recorded under an allowance (D21.3); empty otherwise. */
export const allowanceLabel = (d: { by: string; allowance?: number; items?: { what: string }[] }): string => d.allowance === undefined ? '' : d.by === 'executor:owed' ? `${d.items?.some(i => /^inv:\S+ deferred: /.test(i.what)) ? 'deferred' : 'granted'} by owed under allowance (plan #${d.allowance})` : `by ${d.by} under allowance (plan #${d.allowance})`;
export function statusView(s: State, entries: Entry[] = [], mergeChecks: ItemView[] = [], now = Date.now(), driverRunning = false, currentDefers: DeferredView[] = s.deferred.filter(d => s.trunk.invKeys[d.id] === d.key), dispatchMax = driveConfig(s.plan).max, rt: Runtime = { driverRunning }): StatusView {
  const groups: Record<string, string[]> = {}, pending: Record<string, ItemView[]> = { owner: [], 'parent+writer': [], reviewer: [], executor: [] };
  for (const n of Object.values(s.nodes)) {
    (groups[n.phase] ??= []).push(n.id);
    if (!waitingFor(s,n.id) && reportedOf(s,n.id) === undefined && !s.plan.nodes.find(x => x.id === n.id)?.later && (n.phase === 'ready' || n.phase === 'dispatched')) pending['parent+writer']!.push({subject:n.id,obligation:n.phase === 'ready' ? 'dispatch' : 'submit',key:'',status:'D',mark:'⊥',discharger:n.phase === 'ready' ? 'parent' : 'writer',evidence:[],detail:n.phase === 'ready' ? 'parent can dispatch work' : 'writer must submit a candidate'});
  }
  for (const i of [...Object.values(s.nodes).filter(n => !n.merged && n.phase !== 'removed').flatMap(n => n.items), ...s.invariants]) if (i.status === 'D') pending[i.discharger === 'writer' || i.discharger === 'parent' ? 'parent+writer' : i.discharger ?? 'executor']!.push(withBlockNotes(s, i, rt));
  pending['parent+writer']!.push(...mergeChecks);
  const ready = Object.values(s.nodes).filter(n => n.phase === 'ready').sort((a,b) => b.dependents - a.dependents || a.id.localeCompare(b.id)).map(n => n.id), overlaps: Record<string, string[]> = {};
  for (const id of ready) { const o = overlapping(s, id); if (o.length) overlaps[id] = o; }
  const halts = Object.keys(s.nodes).flatMap(id => halted(s, id) ?? []), launches: Record<string, LaunchEntry[]> = {};
  for (const h of halts) if (h.needs === 'owner' && !heldRuling(s, h.node)) pending.owner!.push({ subject: h.node, obligation: 'driver-halt', key: '', status: 'D', mark: '⏸', discharger: 'owner', evidence: [h.seq], detail: nodeNext(s, h.node, rt) });
  for (const n of Object.values(s.nodes)) { const runs = n.slot?.open ? n.runs.find(r => r.attempt === n.slot!.attempt) : undefined; if (runs?.launches.length) launches[n.id] = runs.launches; }
  const all = entries.length ? entries : entriesOf(s), needsRuling = Object.values(s.nodes).filter(n => n.slot?.open).flatMap(n => n.blocks.filter(b => currentNeeds(s, b) && awaitingRuling(s, b)).map(b => { const e = all.find(x => x.seq === b.seq); return { ...b, note: e?.kind === 'review' ? e.note ?? '' : '' }; }));
  const waiting = Object.keys(s.nodes).sort().flatMap(id => { const w = waitingFor(s, id); return w ? [{ node: id, ...w }] : []; });
  const reported = Object.keys(s.nodes).sort().flatMap(node => { const resume = reportedOf(s,node); return resume === undefined ? [] : [{ node, resume }]; });
  const later = s.plan.nodes.filter(n => n.later && !s.nodes[n.id]?.merged).map(n => n.id);
  const superseded = supersededOf(s, Object.values(s.nodes).filter(n => !n.merged));
  const carried = Object.values(s.nodes).flatMap(n => { const c = carriedOf(n); return c ? [{ node: n.id, ...c }] : []; });
  const held = Object.values(s.nodes).filter(n => n.phase === 'held').map(n => ({ node:n.id, abandon:n.held! }));
  const trunkRed = trunkInvariantReds(s);
  const view: StatusView = { ...knownRedDebt(s), ...(trunkRed.length ? { trunkRed } : {}), ...(held.length ? { held } : {}), ...(reported.length ? { reported } : {}), ...(later.length ? { later } : {}), ...(superseded.length ? { superseded } : {}), ...(carried.length ? { carried } : {}), trunk: s.trunk, nodes: s.nodes, mergeQueue: mergeQueue(s), groups, ready, pending, invariants: s.invariants, ownerFlags:entries.filter(e => e.by.startsWith('owner:') && e.channel === 'flag'), overlaps, halted: halts, ...(waiting.length ? { waiting } : {}), launches, ...(needsRuling.length ? { needsRuling } : {}), ...genesisStatus(s) };
  const runtimeWarnings = nearTimeoutWarnings(s.plan,entries);
  if (runtimeWarnings.length) view.runtimeWarnings = runtimeWarnings;
  if (s.plan.risk !== undefined) view.reviewRequirements = Object.fromEntries(Object.values(s.nodes).filter(n => n.candidate && n.slot?.open).map(n => [n.id, nodeReview(s, n.id)]));
  if (currentDefers.length) view.deferred = currentDefers;
  { const batch = mergeBatchPlan(s, mergeBatchSize(s.plan)); if (batch.length) view.mergeBatch = batch; }
  setReadyText(view, [...readyDispatchSkips(s, dispatchMax)].filter(([, skip]) => skip.kind !== 'owner').map(([id, skip]) => `${id}: ${dispatchSkipText(s, id, skip)}`));
  view.summary = summaryView(s, entries, view, now, rt, currentDefers);
  presentationRuntime.set(view.summary, rt);
  return withPresentationState(view,s);
}
/** NY5: derive the receipt from the exact recorded prior/next plans, not the current board. */
export function planReceipt(e: Entry, prior: Plan, next: Plan): string {
  if (e.kind !== 'plan') return renderEntry(e);
  const added = next.nodes.filter(n => !prior.nodes.some(p => p.id === n.id)).map(n => n.id);
  const removed = prior.nodes.filter(n => !next.nodes.some(p => p.id === n.id));
  const changed = next.nodes.filter(n => prior.nodes.some(p => p.id === n.id && canonical(p) !== canonical(n)));
  return `Recorded plan #${e.seq} (v${next.version} : +${added.length} nodes [${added.join(', ')}], -${removed.length}, ~${changed.length} changed; downgrades: ${e.downgrades.map(d => `${d.node}: ${d.what}`).join('; ') || 'none'})`;
}
/** SQ: derive presentation only; no ledger state, keys or acceptance rules change. */
function summaryView(s: State, entries: Entry[], v: StatusView, now: number, rt: Runtime, currentDefers: DeferredView[]): SummaryView {
  const debt: string[] = [];
  const ns = [...Object.keys(s.nodes).flatMap(id => needs(s, id, rt)), ...repoNeeds(s, rt)];
  // Stable sorting across nodes keeps needs()'s answer/halt/obligation order within each node.
  ns.sort((a,b) => (s.nodes[b.node]?.dependents ?? 0) - (s.nodes[a.node]?.dependents ?? 0) || a.node.localeCompare(b.node));
  const selected: SummaryView['needs'] = ns.map(n => ({ node: n.node, reason: n.text, command: n.command ?? '' }));
  const at = (seq?: number): number => {
    const ts = entries.find(e => e.seq === seq)?.ts;
    return ts && Number.isFinite(Date.parse(ts)) ? Math.max(0, now - Date.parse(ts)) : 0;
  };
  const progress = Object.values(s.nodes).flatMap(n => {
    const a = activity(s, n.id, rt);
    return a ? [{ node: n.id, phase: a.text, ageMs: at((n.accepted ? n.acceptedSince : undefined) ?? n.slot?.dispatchSeq ?? n.held ?? entries.findLast(e => e.kind === 'plan' || e.kind === 'genesis')?.seq) }] : [];
  });
  for (const spec of s.plan.invariants) {
    const active = ((spec as typeof spec & { known_red?: { test:string; fix:string }[] }).known_red ?? []).filter(r => s.plan.nodes.some(n => n.id === r.fix) && !s.nodes[r.fix]?.merged);
    if (active.length) debt.push(`inv:${spec.id} known red: ${active.map(r => `${oneLine(r.test)} (fix: ${r.fix})`).join(', ')}; plan #${entries.findLast(e => e.kind === 'plan' || e.kind === 'genesis')?.seq ?? 0}`);
  }
  for (const i of v.invariants) if (i.status === 'D' && (i.discharger === 'parent' || i.detail.startsWith('trunk-red:'))) debt.push(`${i.obligation}: ${oneLine(i.detail)}`);
  for (const n of Object.values(v.nodes).filter(n => !n.merged && n.slot?.open)) for (const i of n.items.filter(i => i.status === 'W')) {
    const waiver = entries.findLast(e => e.kind === 'waive' && e.node === n.id && e.obligation === i.obligation && i.evidence.includes(e.seq));
    if (waiver?.kind !== 'waive' || waiver.tracked_by === undefined) debt.push(`${n.id}/${i.obligation}: waived — ${oneLine(i.detail.replace(/ \((?:flag weak confirmation|delegated)\)$/, ''))}`);
  }
  debt.push(...trackedWaivers(s).filter(e => externalDebt(s,e) || !s.nodes[e.tracked_by!]?.merged).map(e => trackedDebtText(s,e)));
  for (const d of currentDefers) debt.push(deferredText(d));
  for (const q of quarantineDebt(s)) debt.push(quarantineText(q));
  return { merged: Object.values(v.nodes).filter(n => n.merged).length, needs: selected, progress, debt: [...new Set(debt)] };
}
function deferredText(d: DeferredView): string {
  const suffix = d.unverified === 'drift' ? ' (not rechecked: trunk moved)' : d.unverified === 'conflict' ? ' (not rechecked: merge conflicts)' : '';
  return `${d.node}/inv:${d.id}: ${d.allowance !== undefined ? `deferred by owed under allowance (plan #${d.allowance})` : 'owner defer'}${suffix}`;
}
function genesisStatus(s: State): { genesis?: GenesisStatus } {
  const g = genesisProgress(s);
  return g.pending.length ? { genesis: { observed: g.observed.length, total: g.ids.length, pending: g.pending } } : {};
}
export function mergeWaitingText(w: NonNullable<StatusView['mergeWaiting']>[string], kind = 'merge'): string {
  if (w.reason.startsWith('in batch with ')) return `${kind} ${oneLine(w.reason)}`;
  const reason = w.reason === 'adopt' ? `adopt (pending since ${clockTime(w.since)})`
    : w.job && w.jobSince ? `driver-internal job (${oneLine(w.job)}, since ${clockTime(w.jobSince)})`
    : `${oneLine(w.reason)}${w.job ? '' : mergeWaitSuffix(w.reason, w.since)}`;
  return `${kind} waiting for ${reason}${w.ahead !== undefined && w.ahead >= 0 ? `; ${w.ahead} ${w.ahead === 1 ? 'merge' : 'merges'} ahead` : ''}`;
}

const phaseNames: Record<string,string> = { ready: 'ready', blocked: 'blocked by dependencies', dispatched: 'dispatched', submitted: 'submitted', accepted: 'accepted', merged: 'merged', removed: 'removed from the plan', held: 'held' };
/** RC1: noisy is descriptive, not a conflicting ledger verdict. */
const noise = (e: Entry): string => e.kind === 'obs' && e.noisy && e.runs ? ` noisy (${e.runs.filter(r => r.verdict === 'pass').length}/${e.runs.length} passed)` : '';
const strength = (e: Entry): string => e.kind === 'obs' && e.obligation.startsWith('strength:') && e.counts ? ` strength ${e.counts.pass ?? 0}/${e.counts.tests ?? 0}` : '';
function itemText(i: ItemView & { observations?: Entry[]; blockNotes?: BlockNote[]; hint?: string; run?: string }): string {
  if (i.run !== undefined) { const { run, ...plain } = i; return `${itemText(plain)}\n  run: ${run}`; }
  if (i.obligation === 'driver-halt') return `${i.mark} halted ${i.subject} — ${i.detail}`;
  if (i.status === 'W' && i.subject === 'trunk' && i.obligation.startsWith('inv:')) return `${i.mark} ${i.detail}`;
  if (i.status === 'W') return waivedText(i);
  if (isManual(i.obligation)) return manualText(i);
  const label = i.status === 'E' ? (i.obligation === 'review' || i.obligation === 'closure-review' ? 'reviewed' : i.obligation === 'rulings' ? (i.detail === NO_RULINGS ? 'no rulings apply' : 'rulings acknowledged') : 'measured') : ({ '✘': 'rejected', '⊥': 'awaiting observation', '⊤': 'conflict', '⏸': 'deferred', '⛔': 'blocked' } as Record<string,string>)[i.mark] ?? i.detail;
  const infra = new Set((i.observations ?? []).flatMap(e => e.kind === 'obs' && e.infra !== undefined ? [e.infra] : []));
  const evidence = (i.observations ?? []).map(e => (e.kind === 'obs' ? `#${e.seq}${infra.has(e.seq) ? ' infra' : ''}${strength(e)}${noise(e)} log=${e.log ?? '-'} counts=${JSON.stringify(e.counts ?? {})} ${e.durationMs}ms` : e.kind === 'review' ? `${e.by} rank=${e.rank}` : e.kind === 'waive' ? `${e.by}: ${e.reason} (${e.channel}${e.channel === 'flag' ? ' weak confirmation' : ''})` : `#${e.seq}`) + repetition(e)).join('; ');
  return `${i.mark} ${label} ${i.subject}/${i.obligation} — ${i.detail}${evidence ? ` [${evidence}]` : ''}${(i.blockNotes ?? []).map(b => ` — note #${b.seq}: ${b.note}`).join('')}${i.hint ? ` — ${i.hint}` : ''}${failNotes(i.observations ?? [])}`;
}
/** K2.2: the note of an exec block's failing observation on one line, at most 200 characters. */
export interface BlockNote { seq: number; note: string }
const NOTE_SHOWN = 200;
export const shortNote = (note: string): string => {
  const t = oneLine(note); if (t.length <= NOTE_SHOWN) return t;
  // Cut whole code points of the raw note, each escaped as oneLine does, so no surrogate pair or \uXXXX escape is split.
  let out = ''; for (const cp of note) { const x = oneLine(cp); if (out.length + x.length > NOTE_SHOWN - 1) break; out += x; }
  return `${out}…`;
};
function blockNote(s: State, b: Block): string | undefined {
  if (b.kind !== 'exec') return undefined;
  const e = entriesOf(s).find(x => x.seq === b.seq);
  return e?.kind === 'obs' && e.verdict === 'fail' && e.note ? shortNote(e.note) : undefined;
}
const withNote = (note: string | undefined): { note?: string } => note === undefined ? {} : { note };
/** A pending item with the notes of the exec blocks that hold it (status, K2.2). */
function withBlockNotes(s: State, i: ItemView, rt?: Runtime): ItemView & { blockNotes?: BlockNote[]; hint?: string } {
  const n = s.nodes[i.subject], held = (n?.blocks ?? []).filter(b => b.obligation === i.obligation && countsBlock(b) && !heldFlaky(s,i.subject,b) && i.evidence.includes(b.seq));
  const notes = held.flatMap(b => { const note = blockNote(s, b); return note === undefined ? [] : [{ seq: b.seq, note }]; });
  const hint = held.some(b => b.state === 'flaky' || sharedCheckHint(s, b)) ? itemLine(s, i.subject, i.obligation, rt) : undefined;
  return notes.length || hint ? { ...i, ...(notes.length ? { blockNotes: notes } : {}), ...(hint ? { hint } : {}) } : i;
}
/**
 * K2.3: what a recorded waiver means, as the reducer applies it (review #781 ruling). A waiver is recorded for
 * (node, obligation, key K), not for one candidate. It is in effect for every candidate of the node, in this or a later
 * attempt, whose key for the obligation is K, whenever no unaccepted active block remains on the obligation (an
 * accepted block is one in its accept_risk, older than the waiver). So it takes effect as soon as such blocks clear (for
 * example an attribution rerun that confirms and clears a failure); a later block suspends it, and clearing that block
 * restores it. attest skips a key that already has a verdict; a key without one is still measured.
 */
export function waiverText(s: State, e: WaiveEntry): string {
  const n = s.nodes[e.node], c = n?.candidate, item = n?.items.find(i => i.obligation === e.obligation), o = e.obligation, k = e.key.slice(0, 12);
  const satisfied = item?.status === 'E' && item.evidence.length ? `; ${o} on the candidate key is satisfied by ${item.evidence.map(seq => `#${seq}`).join(', ')}` : '';
  if (c && e.key !== c.keys[o] && (e.accept_risk ?? []).some(seq => { const x = entriesOf(s).find(x => x.seq === seq); return x?.kind === 'obs' && x.subject === e.node && x.merging === e.node && x.obligation === o && x.key === e.key; })) {
    return `waived ${e.node}/${o} on merge key ${k}: ${e.reason}; in effect now: --accept-risk accepts ${(e.accept_risk ?? []).map(seq => {
      const b = n?.blocks.find(b => b.seq === seq), pass = b && flakyPass(s,b,e.seq);
      return `#${seq}${pass ? ` (flaky: failed #${seq} → passed #${pass.seq} on the same key)` : ''}`;
    }).join(', ')}${satisfied}; this waiver applies only to that key, not the candidate key ${c.keys[o]?.slice(0,12)}; changes to check definition, setup, exec, closure or reads change the key and require measurement again`;
  }
  const kind = o.includes(':') ? o.slice(0, o.indexOf(':')) : o, measured = ['check', 'strength', 'red', 'writes'].includes(kind);
  const scope = `owed counts ${o} as waived, not measured, for every candidate of ${e.node} whose ${o} key is ${k}${kind === 'rulings' ? '' : ', in this or a later attempt'}, while no unaccepted active block remains on ${o}; a later block suspends the waiver and clearing that block restores it`;
  const again = kind === 'check' || kind === 'strength' ? `a change to the check definition, setup, exec, closure or the content of its reads${kind === 'strength' ? ' or mutants' : ''} changes the key, and owed measures it again`
    : kind === 'red' ? 'a change to the check definition, setup, exec, closure, the base tree or the content of its tests changes the key, and owed measures it again'
    : kind === 'writes' ? "a new candidate commit or base, or a change to the node's writes, changes the key, and owed measures it again"
    : kind === 'rulings' ? 'a new attempt changes the key, and it is owed again'
    : kind === 'evidence' ? 'a different candidate patch or evidence definition changes the key, and it is owed again'
    : 'a different candidate patch changes the key, and it is owed again';
  const unaccepted = (n?.blocks ?? []).filter(b => b.obligation === o && countsBlock(b) && !((e.accept_risk ?? []).includes(b.seq) && e.seq > b.seq));
  const blockClear = (b: Block): string => b.kind === 'exec'
    ? `an attribution rerun (owed attest) that confirms the failure clears #${b.seq}${b.state === 'flaky' ? ` (#${b.seq} is flaky: its rerun passed, so only a waiver with --accept-risk ${b.seq} accepts it)` : '; if the rerun passes, #' + b.seq + ' stays as a flaky block that only a waiver with --accept-risk accepts'}`
    : `an ok review that clears #${b.seq}`;
  const accepted = (n?.blocks ?? []).filter(b => b.obligation === o && (e.accept_risk ?? []).includes(b.seq) && b.clearedBy === e.seq);
  const acceptedEffect = accepted.length ? `in effect now: --accept-risk accepts ${accepted.map(b => {
    const pass = flakyPass(s,b,e.seq);
    return `#${b.seq}${pass ? ` (flaky: failed #${b.seq} → passed #${pass.seq} on the same key)` : ''}`;
  }).join(', ')}${satisfied}` : undefined;
  const effect = acceptedEffect ?? (item?.status === 'W' && item.evidence.includes(e.seq) ? 'in effect now'
    : !item ? `${o} is not an obligation of the current candidate`
    : item.status === 'E' ? `${o} is currently satisfied, so the waiver is not needed while it stays satisfied`
    : unaccepted.length ? `not in effect yet: active ${unaccepted.length === 1 ? 'block' : 'blocks'} ${unaccepted.map(b => `#${b.seq}`).join(', ')} ${unaccepted.length === 1 ? 'is' : 'are'} not accepted; it takes effect as soon as no unaccepted active block remains on ${o}, for example after ${unaccepted.map(blockClear).join(', and ')}; --accept-risk accepts the current flaky or active blocks at once`
    : `not in effect: ${item.detail}`);
  const unmeasured = measured && !observationsOf(s, e.node, o, e.key).some(x => x.verdict !== 'error') ? '; this key has no observation yet, so owed attest still measures it: a pass counts as measured, a fail adds a block that suspends the waiver until it clears' : '';
  const flaky = (e.accept_risk ?? []).filter(seq => { const b = n?.blocks.find(x => x.seq === seq); return !!b && b.kind === 'exec' && wasFlaky(s, b, e.seq); });
  return `waived ${o} for candidate #${c?.seq ?? '?'} ${c?.commit.slice(0, 12) ?? '?'} (key ${k}): ${effect}; ${scope}; ${again}${unmeasured}${flaky.map(seq => `; the flaky block #${seq} stays recorded as accepted risk`).join('')}${acceptedText(s, e, !!unmeasured)}`;
}
/**
 * 0.11 F3 (app #34, #12): what --accept-risk does, said plainly: the cited blocks are cleared whatever their key, the
 * obligation is no longer measured on the waived key, and a cited fail on a merge key no longer counts against the merge.
 */
function acceptedText(s: State, e: WaiveEntry, unmeasured: boolean): string {
  const seqs = e.accept_risk ?? [];
  if (!seqs.length) return '';
  const all = entriesOf(s), o = e.obligation;
  const merge = seqs.flatMap(seq => { const x = all.find(y => y.seq === seq); return x?.kind === 'obs' && x.merging !== undefined && x.key !== e.key ? [x] : []; });
  return `; --accept-risk clears ${seqs.map(x => `#${x}`).join(', ')} whatever ${seqs.length === 1 ? 'its key' : 'their keys'}${unmeasured ? '' : `, and ${o} is no longer measured on key ${e.key.slice(0, 12)}`}`
    + merge.map(x => `; #${x.seq} failed on merge key ${x.key.slice(0, 12)}: that fail no longer counts there, so a pass there satisfies owed merge, and owed merge measures the key again when it has no other verdict`).join('');
}
/** An exec block that an attribution rerun passed (flaky) before entry `before`, as the reducer marks it. */
const wasFlaky = (s: State, b: Block, before: number): boolean => flakyPass(s,b,before) !== undefined;
export function waiverRecordedText(e: WaiveEntry & { scope?: { on:'merge'|'candidate'; trunk?:string } }): string {
  const key = e.scope ? ` on the ${e.scope.on} key ${e.key.slice(0,12)}${e.scope.on === 'merge' ? ` (merge tree of ${e.node} on trunk ${e.scope.trunk?.slice(0,12)})` : ''}` : '';
  return `waived ${e.node}/${e.obligation} #${e.seq}: debt recorded${key}${e.accept_risk?.length ? ` (accepted block risk ${e.accept_risk.map(seq => `#${seq}`).join(', ')})` : ''}`;
}
/** K2.3: a waived item reads `<subject>/<obligation> waived (not measured for this candidate) by <who>: <reason>`. */
function waivedText(i: ItemView & { observations?: Entry[] }): string {
  const obs = i.observations ?? [], w = obs.findLast(e => e.kind === 'waive');
  const channel = w?.channel ? ` (${w.channel}${w.channel === 'flag' ? ' weak confirmation' : ''})` : '';
  const rest = obs.filter(e => e !== w).map(e => e.kind === 'obs' ? `#${e.seq}${strength(e)}${noise(e)} log=${e.log ?? '-'} counts=${JSON.stringify(e.counts ?? {})} ${e.durationMs}ms` : e.kind === 'review' ? `${e.by} rank=${e.rank}` : `#${e.seq}`).join('; ');
  return `${i.mark} ${i.subject}/${i.obligation} waived (not measured for this candidate) by ${w?.by ?? 'the owner'}: ${w?.kind === 'waive' ? oneLine(w.reason) : i.detail}${channel}${rest ? ` [${rest}]` : ''}${failNotes(obs)}`;
}
/** 0.5.1 (E2 ruling 3): each fail observation's note under its item, `  note #<seq>:` then the note as recorded, indented. */
const failNotes = (obs: Entry[]): string => obs.map(e => e.kind === 'obs' && e.verdict === 'fail' && e.note ? `\n  note #${e.seq}:${e.note.split('\n').map(l => `\n    ${l}`).join('')}` : '').join('');
/**
 * D23 items, always marked manual (never "measured"): `✔ approved (owner:<id>, <channel>)`, `✔ evidenced (manual) by
 * <who>` with files `path sha12` and the note; pending ones read `awaiting owner approval` / `awaiting manual evidence`.
 */
function manualText(i: ItemView & { observations?: Entry[] }): string {
  const obs = i.observations ?? [], approve = i.obligation === 'approve';
  const ok = obs.filter(e => approve ? e.kind === 'review' && e.verdict === 'ok' : e.kind === 'evidence');
  const label = i.status === 'E' ? approve ? `approved${ok.length ? ` (${ok.map(e => `${e.by}, ${e.channel ?? 'no channel'}`).join('; ')})` : ''}` : `evidenced (manual)${ok.length ? ` by ${[...new Set(ok.map(e => e.by))].join(', ')}` : ''}`
    : i.status === 'W' ? 'waived' : i.mark === '⊥' ? approve ? 'awaiting owner approval' : 'awaiting manual evidence' : i.mark === '⛔' ? 'blocked' : i.detail;
  const evidence = obs.map(e => e.kind === 'evidence' ? `#${e.seq} ${e.by}: ${evidenceText(e)}` : e.kind === 'review' ? `#${e.seq} ${e.by} ${e.verdict}${e.channel ? ` (${e.channel}${e.channel === 'flag' ? ' weak confirmation' : ''})` : ''}${e.note ? `: ${oneLine(e.note)}` : ''}` : e.kind === 'waive' ? `${e.by}: ${e.reason} (${e.channel}${e.channel === 'flag' ? ' weak confirmation' : ''})` : `#${e.seq}`).join('; ');
  return `${i.mark} ${label} ${i.subject}/${i.obligation} — ${i.detail}${evidence ? ` [${evidence}]` : ''}`;
}
/** 0.8 (L1.5): `waiting for <dep> (resume #<seq>)`. */
export const waitingLine = (w: Waiting): string => [w.deps?.length ? `waiting (deps: ${w.deps.join(', ')})` : '', w.after ? `waiting for ${w.after} (resume #${w.resume})` : ''].filter(Boolean).join('; ');
/** D25.6 (review ruling #559): an owner halt reads `needs the owner (the main agent decides; owed lists the command)`. */
const NEEDS_OWNER_TEXT = 'needs the owner (the main agent decides; owed lists the command)';
const NEEDS_PARENT_TEXT = 'needs the parent (the main agent acts; owed lists the command)';
const haltText = (h: HaltEntry, held?: RuleEntry): string => `halted by driver #${h.seq} (attempt ${h.attempt}), ${held ? `held by ruling #${held.seq}` : h.needs === 'owner' ? NEEDS_OWNER_TEXT : NEEDS_PARENT_TEXT}: ${oneLine(h.reason)}`;
const launchText = (l: LaunchEntry): string => `#${l.seq} ${l.role} ${l.rid}`;
/** ` (needs a parent ruling)` / ` (ruled #<seq>)` after a current-candidate needs-parent block (D18.5, D18b.4); empty otherwise. */
const rulingMark = (b: { ruling?: 'needed' | number }): string => b.ruling === undefined ? '' : b.ruling === 'needed' ? ' (needs a parent ruling)' : ` (ruled #${b.ruling})`;
function runsText(r: AttemptRuns): string[] {
  return [...r.launches.map(l => `Driver launch ${launchText(l)} (spec ${l.spec.slice(0, 12)})`), ...r.sends.map(x => `Driver send #${x.seq} ${x.sendKind} (${x.reason}) to ${x.rid}: ${x.send}`)];
}
/**
 * QT2: the default `owed why <node>` card: the outcome line, then one line per unsatisfied obligation, active block and
 * active condition (halt, hold, wait, pending rebase, conflicts, out-of-writes paths), each with its reason and the next
 * command; everything else (observations, history, superseded blocks, rulings text, ΔO⁻) only with `--full`.
 */
export function renderWhy(v: ReceiptCard, options: { full?: boolean } = {}): string {
  if (options.full) return renderReceipt(v, { full: true });
  const blocked = new Set(v.blocks.map(b => b.obligation));
  const review = (b: ReceiptCard['blocks'][number]): string | undefined => {
    const e = v.items.find(i => i.obligation === b.obligation)?.observations.find(o => o.seq === b.seq);
    const recorded = actHistories.get(v)?.find(e => e.seq === b.seq);
    return e?.kind === 'review' && e.note ? e.note : recorded?.kind === 'review' ? recorded.note : b.note;
  };
  const ns = cardNeeds(v), held = cardHeld(v);
  const alternatives = ns.flatMap(n => (n.alternatives ?? []).map(c => `  or: ${c}`));
  const lines = [
    ...(v.mergeWaiting && !v.measuring ? [mergeWaitingText(v.mergeWaiting, v.accepted ? 'merge' : 'measure')] : []),
    ...(v.rebasePending ? [rebasePendingText(v.rebasePending)] : []),
    ...(v.held !== undefined ? [`held by abandon #${v.held}`] : []),
    ...(v.halt ? [`⏸ halted (attempt ${v.halt.attempt})`] : []),
    ...(v.reported !== undefined ? [`reported (resume #${v.reported}): parked with the writer's report, waiting for the parent`] : []),
    ...(v.waiting ? [`⏳ ${waitingLine(v.waiting)}; the driver acts again when they merge`] : []),
    ...readyLines(v),
    ...v.items.filter(i => i.status === 'D').map(i => `${i.mark} ${i.obligation}: ${cardItemLine(v, i)}`),
    ...v.blocks.map(b => { if (b.ruling === 'needed') return `⛔ ${b.obligation} block #${b.seq}${rulingMark(b)}; ${b.clear}`; const note = review(b); return `⛔ ${b.obligation} block #${b.seq}${rulingMark(b)}${note ? `: ${shortNote(note)}` : ''}; ${b.clear}`; }),
    ...(held ? [`Next: ${resumeCommand(v.node)}`] : []),
    ...ns.slice(held ? 0 : 1).map(n => `Next: ${needText(n)}`),
    ...alternatives,
    ...(v.mergeChecks ?? []).filter(i => i.status === 'D').map(i => `${i.mark} merge check ${i.obligation}: ${oneLine(i.detail)} → owed why ${v.node} --full`),
    ...(v.outOfWrites ? outOfWritesText(v.outOfWrites).split('\n') : []),
    ...(v.modelWarnings ?? []).filter((w): w is string => typeof w === 'string').map(w => `Warning: ${w}`),
    ...conflictLines(Object.fromEntries(Object.entries(v.conflicts ?? {}).filter(([, paths]) => paths === null || paths.length > 0))),
    // left022: the ruling the parent must forward is the content of that act: kept whole.
    ...(v.rulingFollowUp ? [`Ruling to forward:\n${v.rulingFollowUp}`] : []),
  ];
  // risk (0.24): the derived review requirement says what review would satisfy the node; context, not outstanding.
  const context = [...(v.reviewRequirement && v.phase !== 'merged' ? [oneLine(reviewRequirementText(v.reviewRequirement))] : [])];
  context.push(...downgradeLines(currentDowngrades(v)));
  const open = v.items.filter(i => i.status === 'D' && !(blocked.has(i.obligation) && i.mark === '⛔')).length + v.blocks.length + (v.mergeChecks ?? []).filter(i => i.status === 'D').length + readyLines(v).length;
  const outcome = v.phase === 'merged' && v.accepted ? 'merged' : `${held ? `held by ruling #${held.seq}` : ns[0] ? needText(ns[0]) : cardActivity(v) ?? (v.measuring ? measurementText(v.measuring) : readyLines(v)[0] ?? (v.phase === 'merged' ? 'obligations outstanding' : phaseNames[v.phase]))}${v.accepted && v.phase !== 'accepted' ? ' (accepted)' : ''}; ${open ? `${open} outstanding` : 'nothing outstanding'}`;
  const s = presentationStates.get(v);
  const tracks = s ? trackedWhy(s,v.node) : [];
  return [`${v.node}: ${outcome}`, ...lines, ...tracks, ...context, `Details: owed why ${v.node} --full`].join('\n');
}
/** QT4: the obligations owed measures (checks, strength, red, writes, invariants). */
const MEASURED = /^(?:(?:check|strength|red|inv):|writes$)/;
/** QT4: `<node> merged (<commit12>); measured <n>, waived <n>, debt <n>` from the merged node's card and its deferred debt. */
export function mergedLine(v: ReceiptCard, commit: string, debt?: number): string {
  const measured = v.items.filter(i => i.status === 'E' && MEASURED.test(i.obligation)).length, waived = v.items.filter(i => i.status === 'W').length;
  return `${v.node} merged (${commit.slice(0, 12)}); measured ${measured}, waived ${waived}${debt === undefined ? '' : `, debt ${debt}`}`;
}
/**
 * QT3: the failures of a repair follow-up recorded after entry `since` (the last message to the writer): failing
 * measured items with their notes, and active review blocks; `earlier` names the obligations still failing from before.
 */
export function newFailures(v: ReceiptCard, since: number): { lines: string[]; earlier: string[] } {
  const lines: string[] = [], earlier: string[] = [], s = presentationStates.get(v);
  for (const i of v.items) {
    if (i.status !== 'D' || (i.mark !== '✘' && !v.blocks.some(b => b.obligation === i.obligation && b.kind === 'exec' && !(s && heldFlaky(s,v.node,b))))) continue;
    const fails = i.observations.filter(e => e.kind === 'obs' && e.verdict === 'fail' && !(s && s.nodes[v.node]?.blocks.some(b => b.seq === e.seq && heldFlaky(s,v.node,b))));
    if (!fails.some(e => e.seq > since)) { earlier.push(i.obligation); continue; }
    const fresh = fails.filter(e => e.seq > since), names = [...new Set(fresh.flatMap(e => e.kind === 'obs' ? e.failed ?? [] : []))];
    lines.push(`- ${i.obligation}: ${oneLine(i.detail)}${names.length ? `; failed tests: ${names.map(oneLine).join(', ')}` : ''}${failNotes(fresh)}`);
    if (i.obligation === 'writes' && v.outOfWrites) lines.push(...outOfWritesText(v.outOfWrites).split('\n'));
  }
  return { lines, earlier };
}
const conflictLines = (conflicts: Record<string, string[] | null> | undefined, full = true): string[] => Object.entries(conflicts ?? {}).filter(([, paths]) => full || paths === null || paths.length > 0).map(([target, paths]) => `conflicts with ${target}: ${paths === null ? 'unknown; retry owed status' : paths.map(oneLine).join(', ') || 'none'}`);
export function renderReceipt(v: ReceiptCard, options: { full?: boolean } = {}): string {
  const history = actHistories.get(v) ?? v.items.flatMap(i => i.observations), ns = cardNeeds(v), held = cardHeld(v);
  const runs = actRuns(history,history.filter(e => e.kind === 'rule'));
  const textItem = (i: ReceiptCard['items'][number]) => itemText(textReceiptItem(i,runs));
  const downgrades = options.full ? v.downgrades : currentDowngrades(v);
  const waitingNodes = [...new Set([...(v.waiting?.deps ?? []), ...(v.waiting?.after ? v.waiting.after.split(', ') : [])])];
  const blockText = (b: ReceiptCard['blocks'][number]): string => {
    const e = history.find(e => e.seq === b.seq);
    const note = e?.kind === 'review' ? e.note ?? '' : b.note ?? '';
    return `⛔ blocked #${b.seq} ${b.obligation}${rulingMark(b)}: ${b.clear}${b.note ? ` — note: ${b.note}` : ''}${b.ruling === 'needed' && options.full && e?.kind === 'review' && note ? `\nReview note: ${oneLine(note)}` : ''}`;
  };
  return [`${v.node}: ${held ? heldRulingText(v.node, held.seq) : ns[0] ? needText(ns[0]) : cardActivity(v) ?? (v.phase === 'merged' && !v.accepted ? 'obligations outstanding' : v.measuring ? measurementText(v.measuring) : phaseNames[v.phase])}`, ...(held ? [`Next: ${resumeCommand(v.node)}`] : []), ...ns.slice(held ? 0 : 1).map(n => `Next: ${needText(n)}`), ...ns.flatMap(n => (n.alternatives ?? []).map(c => `  or: ${c}`)), ...(v.mergeWaiting && !v.measuring ? [mergeWaitingText(v.mergeWaiting, v.accepted ? 'merge' : 'measure')] : []), ...(v.rebasePending ? [rebasePendingText(v.rebasePending)] : []), ...(v.held !== undefined ? [`held by abandon #${v.held}`] : []), ...(v.exec ? [v.exec] : []), ...(v.drive ? [v.drive] : []), ...(v.reviewRequirement ? [oneLine(reviewRequirementText(v.reviewRequirement))] : []), ...(v.models ? [v.models] : []), ...(v.modelWarnings ?? []).filter(w => options.full || typeof w === 'string').map(w => `Warning: ${typeof w === 'string' ? w : `${w.message} (acknowledged)`}`), ...(v.reviewCarried ? [v.reviewCarried] : []), ...(v.carried ? [`↻ ${carriedText(v.carried)}`] : []), ...(v.halt ? [`⏸ ${haltText(v.halt, held)}`] : []), ...(v.reported !== undefined ? [`reported (resume #${v.reported})`] : []), ...(v.later ? ['backlog (later)'] : []), ...(v.waiting ? [`⏳ ${waitingLine(v.waiting)}; the driver acts again when ${waitingNodes.join(', ')} ${waitingNodes.length > 1 ? 'merge' : 'merges'} or after another resume`] : []), ...(v.runs ? runsText(v.runs) : []), ...v.items.map(i => `${textItem(i)}${i.status === 'D' ? `\n  next: ${cardItemLine(v, i)}` : ''}`), ...(v.mergeChecks?.length ? ['Merge checks:', ...v.mergeChecks.map(textItem)] : []), ...v.blocks.map(blockText), ...(v.superseded ?? []).map(b => `⊘ ${b.text}`), ...(v.outOfWrites ? [outOfWritesText(v.outOfWrites)] : []), ...(v.grantedWrites ?? []).map(grantedWritesText), ...conflictLines(v.conflicts), `Untested changes: ${v.untested.join(', ') || 'none'}`, ...(options.full ? [`Untested obligations ΔO⁻: ${JSON.stringify(v.downgrades)}`] : []), ...downgradeLines(options.full ? downgrades.filter(d => d.allowance !== undefined) : downgrades), ...(options.full ? [`owner flag weak confirmation: ${v.ownerFlags.map(e => `#${e.seq} ${e.kind}`).join(', ') || 'none'}`] : []), ...(v.receipts ?? []).map(receiptText), ...(v.lifts?.length ? [liftsText(v.node, v.lifts)] : []), ...(presentationStates.get(v) ? trackedWhy(presentationStates.get(v)!,v.node) : []), ...(v.rulingFollowUp ? ['Ruling to forward:', v.rulingFollowUp] : []), ...(v.rebase ? [`Rebased #${v.rebase.seq}: slot base ${v.rebase.from.slice(0, 12)} → ${v.rebase.base.slice(0, 12)}`, ...(v.rebase.previous ? [`Previously reviewed patch: ${v.rebase.previous.base}..${v.rebase.previous.commit} (submit #${v.rebase.previous.submit})`, `Re-review only the resolution: ${v.rebase.rangeDiff}`] : [])] : [])].join('\n');
}
export function renderStatus(v: StatusView, options: { full?: boolean } = {}): string {
  if (options.full) return renderStatusFull(v);
  const summary = v.summary ?? { merged: v.groups.merged?.length ?? 0, needs: [], progress: [], debt: [] };
  return [...summaryHead(v.trunk, v.invariants, summary), ...sweepRedLine(v), ...housekeepingLine(v), ...(v.runtimeWarnings ?? []),
    ...Object.entries(v.conflicts ?? {}).flatMap(([id, conflicts]) => conflictLines(conflicts, false).map(line => `${id}: ${line}`)),
    ...readyLines(v),
    ...(summary.progress.length ? [`In progress (${summary.progress.length}):`, ...summary.progress.map(p => `  ${p.node}: ${p.phase} (${age(p.ageMs)})${v.reviewRequirements?.[p.node] ? `; ${oneLine(reviewRequirementText(v.reviewRequirements[p.node]!))}` : ''}`)] : []),
    ...(summary.debt.length ? ['Debt:', ...summary.debt.map(d => `  ${d}`)] : []),
    'Details: owed status --full · owed why <node>'].join('\n');
}
/** CR1: act replies retain outcome and current actions; the full lists stay in status. */
export function renderStatusBrief(v: StatusView): string {
  const summary = v.summary ?? { merged: v.groups.merged?.length ?? 0, needs: [], progress: [], debt: [] };
  const head = summaryHead(v.trunk, v.invariants, summary);
  return [...(summary.needs.length ? head : head.slice(0, 1)), ...sweepRedLine(v),
    'Details: owed status · owed why <node>'].join('\n');
}
function summaryHead(trunk: StatusView['trunk'], invariants: ItemView[], summary: SummaryView): string[] {
  const ok = invariants.filter(i => i.status !== 'D').length;
  return [`owed: ${summary.merged} merged · ${summary.progress.length} in progress · ${summary.needs.length} need you · trunk ${trunk.name} ${trunk.commit.slice(0, 12)} ${ok === invariants.length ? '✔' : '✘'} invariants (${ok}/${invariants.length})`,
    ...(summary.needs.length ? [`Needs you (${summary.needs.length}):`, ...summary.needs.map(n => `  ${n.node}: ${n.reason}${n.command ? ` → ${n.command}` : ' (no single command)'}`)] : ['Needs you: none'])];
}
export const housekeepingText = (n: number): string => `Housekeeping: ${n} finished attempt worktrees; owed gc reclaims them`;
const housekeepingLine = (v: StatusView): string[] => v.housekeeping !== undefined && v.housekeeping >= 5 ? [housekeepingText(v.housekeeping)] : [];
const sweepRedLine = (v: StatusView): string[] => v.sweepRed ? [`trunk: sweep red since #${v.sweepRed.seq} (${v.sweepRed.names.slice(0,5).map(oneLine).join(', ') || 'unknown'})`] : [];
/** SQ2: preserve the 0.14 renderer plus trunk invariant-red diagnostics. */
export function renderStatusFull(v: StatusView): string {
  const s = presentationStates.get(v), tracked = s ? trackedWaivers(s).map(e => trackedDebtText(s,e)) : [];
  return [...tracked,`Trunk ${v.trunk.name} ${v.trunk.commit}`, ...((v.summary?.needs.length ?? 0) ? summaryHead(v.trunk, v.invariants, v.summary!).slice(1) : []), ...sweepRedLine(v), ...housekeepingLine(v), ...Object.entries(v.reviewRequirements ?? {}).map(([id, r]) => `${id}: ${oneLine(reviewRequirementText(r))}`), ...Object.entries(v.conflicts ?? {}).flatMap(([id, conflicts]) => conflictLines(conflicts).map(line => `${id}: ${line}`)), ...(v.trunkWorktree ? [trunkWorktreeText(v.trunk.name, v.trunkWorktree)] : []), ...(v.drift ? [`⚠ ${driftText(v.drift)}`] : []), ...(v.genesis ? [genesisLine(v.genesis)] : []), `Ready (by dependent count): ${v.ready.map(id => v.overlaps?.[id] ? `${id} (writes overlap open slot of ${v.overlaps[id]!.join(', ')})` : id).join(', ') || 'none'}`, `Merge queue: ${v.mergeQueue.join(', ') || 'none'}${batchPlanText(v.mergeBatch)}`, ...Object.entries(v.measuring ?? {}).map(([id, m]) => `${id}: ${measurementText(m)}`), ...Object.entries(v.rebasePending ?? {}).map(([id,r]) => `${id}: ${rebasePendingText(r)}`), ...Object.entries(v.mergeWaiting ?? {}).map(([id, w]) => `${id}: ${mergeWaitingText(w)}`), ...Object.entries(v.groups).map(([k,ns]) => `${phaseNames[k]}: ${ns.join(', ')}`), ...(v.summary?.progress.length ? ['In progress:', ...v.summary.progress.map(p => `${p.node}: ${p.phase}`)] : []), ...(v.held?.length ? v.held.map(h => `${h.node}: held by abandon #${h.abandon}`) : []), ...(v.later?.length ? [`Backlog (later): ${v.later.join(', ')}`] : []), ...(v.reported?.length ? [`Reported: ${v.reported.map(r => `${r.node}: reported (resume #${r.resume})`).join(', ')}`] : []), ...Object.entries(v.pending).map(([k,is]) => `Pending ${k}:\n${is.map(itemText).join('\n') || 'none'}`), ...(v.halted?.some(h => h.needs !== 'owner' && !(s && heldRuling(s, h.node))) ? ['Halted (driver):', ...v.halted.filter(h => h.needs !== 'owner' && !(s && heldRuling(s, h.node))).map(h => `⏸ ${h.node}: ${haltText(h)}`)] : []), ...(v.waiting?.length ? ['Waiting (resume):', ...v.waiting.map(w => `⏳ ${w.node}: ${waitingLine(w)}`)] : []), ...(v.needsRuling?.length ? ['Blocked (needs a parent ruling):', ...v.needsRuling.map(b => `${b.node}: review block #${b.seq} needs a parent ruling`)] : []), ...(v.carried?.length ? ['Carried candidates (a plan change kept them):', ...v.carried.map(c => `↻ ${c.node}: ${carriedText(c)}`)] : []), ...(v.superseded?.length ? ['Superseded blocks (not active; the plan changed their check):', ...v.superseded.map(b => `⊘ ${b.node}: ${b.text}`)] : []), ...(v.launches && Object.keys(v.launches).length ? ['Driver runs (open attempts):', ...Object.entries(v.launches).flatMap(([id, ls]) => ls.map(l => `${id} attempt ${l.attempt}: ${launchText(l)}`))] : []), 'Trunk invariants:', ...v.invariants.map(i => itemText({ ...i, detail:v.trunkRed?.find(r => r.obligation === i.obligation)?.text ?? i.detail })), ...(v.knownRed?.length ? ['Known-red debt:', ...v.knownRed.map(knownRedText)] : []), ...(v.lapsedKnownRed?.length ? ['Lapsed known-red entries:', ...v.lapsedKnownRed.map(lapsedKnownRedText)] : []), `owner flag weak confirmation: ${v.ownerFlags.map(e => `#${e.seq} ${e.kind}`).join(', ') || 'none'}`].join('\n');
}
/** TF3/#3000: each waived failure keeps its own latest tracker; no-risk waivers retain their scope identity. */
export interface TrackedWaiverDebt extends WaiveEntry { trackedRisk?: number }
export function trackedWaivers(s: State): TrackedWaiverDebt[] {
  const latest = new Map<string,TrackedWaiverDebt>();
  for (const e of entriesOf(s)) if (e.kind === 'waive') {
    for (const risk of new Set(e.accept_risk?.length ? e.accept_risk : [undefined])) {
      latest.set(canonical([e.node,e.obligation,e.key,risk]),risk === undefined ? e : { ...e, trackedRisk:risk });
    }
  }
  return [...latest.values()].filter(e => e.tracked_by !== undefined);
}
function trackedWhyText(e: TrackedWaiverDebt): string {
  return `tracks waived debt: ${e.node}/${e.obligation} #${e.seq}${e.trackedRisk === undefined ? '' : ` (block #${e.trackedRisk})`}`;
}
const externalDebt = (s: State, e: TrackedWaiverDebt): boolean => externalTracker(planAt(s,e.seq),e.tracked_by);
function trackedWhy(s: State, node: string): string[] {
  return trackedWaivers(s).flatMap(e => externalDebt(s,e) ? e.node === node ? [trackedDebtText(s,e)] : [] : e.tracked_by === node ? [trackedWhyText(e)] : []);
}
export function trackedDebtText(s: State, e: TrackedWaiverDebt): string {
  const fix = e.tracked_by!, merged = s.nodes[fix]?.merged;
  const tracking = externalDebt(s,e) ? `tracked by ${fix} (external)` : merged ? `settled by ${fix} (merge #${merged.seq})` : s.plan.nodes.some(n => n.id === fix) ? `tracked by ${fix}` : `(tracker ${fix} left the plan)`;
  return `${e.node}/${e.obligation}: waived — ${tracking}: ${oneLine(e.reason)}${e.trackedRisk === undefined ? '' : ` (block #${e.trackedRisk})`}`;
}
const statusNames: Record<string,string> = { E: 'evidenced', W: 'waived', D: 'owed' };
function entryLine(e: Entry): string {
  const head = `#${e.seq} ${e.by}${e.channel === 'flag' ? ' (flag weak confirmation)' : e.channel === 'delegated' ? ' (delegated)' : ''}`;
  switch (e.kind) {
    case 'grant': return `${head} granted writes ${e.paths.join(', ')} for ${e.node} attempt ${e.attempt} under allowance (plan #${e.allowance})`;
    case 'obs': return `${head} observed ${e.subject}/${e.obligation} ${e.verdict}${noise(e)}${e.note ? `: ${e.note}` : ''}`;
    case 'sweep': return `${head} sweep ${e.commit.slice(0, 12)}: ${e.verdict}${e.bisect ? ' (bisect)' : ''}; log ${e.log}${e.failed.length ? `; failed: ${e.failed.join(', ')}` : ''}`;
    case 'merge': return `${head} merged ${e.node} → ${e.commit.slice(0, 12)}${e.batch ? ` (batch of ${e.batch.members.length} → ${e.batch.final.slice(0, 12)})` : ''}`;
    case 'waive': return `${head} waived ${e.node}/${e.obligation}: ${e.reason}${e.accept_risk?.length ? ` (accepted block risk ${e.accept_risk.map(x => `#${x}`).join(', ')})` : ''}`;
    case 'defer': return `${head} deferred ${e.node} post-merge invariants ${e.items.map(i => i.id).join(', ')}${e.allowance !== undefined ? ` (deferred by owed under allowance (plan #${e.allowance}))` : ''}: ${e.reason}`;
    case 'refresh': return `${head} refreshed trunk invariant keys on ${e.commit.slice(0, 12)}`;
    case 'genesis': return `${head} initialized ledger, trunk ${e.trunk} ${e.commit.slice(0, 12)}`;
    case 'dispatch': return `${head} dispatched ${e.node} attempt ${e.attempt}${e.overlaps?.length ? ` (allowed writes overlap with ${e.overlaps.join(', ')})` : ''}`;
    case 'submit': if (e.facts.carry) return `${head} submit; ${reviewCarryText(e.facts)}`; return e.carry !== undefined ? `${head} carried ${e.node} attempt ${e.attempt}: submit #${e.carry} ${e.facts.commit.slice(0, 12)} stays the candidate` : `${head} ${e.kind}`;
    case 'rebase': return `${head} rebased ${e.node} attempt ${e.attempt}: ${e.from.slice(0, 12)} → ${e.base.slice(0, 12)}`;
    case 'hold': return `${head} held ${e.node} by abandon #${e.abandon}${e.reason ? `: ${e.reason}` : ''}`;
    case 'abandon': return `${head} abandoned ${e.node} attempt ${e.attempt}${e.reason ? `: ${e.reason}` : ''}`;
    case 'plan': return `${head} updated plan${e.path ? ` from ${e.path}${e.rev ? ` at ${e.rev.slice(0, 12)}` : ''}` : ''}${e.downgrades.length ? `, downgrades ${e.downgrades.map(d => `${d.node}: ${d.what}`).join('; ')}` : ''}${e.note ? `: ${oneLine(e.note)}` : ''}`;
    case 'rule': return `${head} ${e.prospective ? 'prospective ' : ''}ruling (${e.nodes === '*' ? 'all nodes' : e.nodes.join(', ')}): ${e.text}`;
    case 'review': return `${head} reviewed ${e.node}/${e.obligation ?? 'review'} ${e.verdict} rank=${e.rank}${e.note ? `: ${e.note}` : ''}`;
    case 'escape': return `${head} recorded escape ${e.node} (merge #${e.merge}, ${e.class} ${escapeLabels[e.class]}): ${e.note}${e.evidence ? ` [${e.evidence}]` : ''}`;
    case 'adopt': return `${head} adopted trunk ${e.trunk} ${e.prior.slice(0, 12)}..${e.commit.slice(0, 12)} (${plural(e.commits, 'commit')} made outside owed, ${plural(e.changed.length, 'changed path')}): ${e.note}`;
    case 'launch': return `${head} recorded driver launch of ${e.node} attempt ${e.attempt} ${e.role} ${e.rid}`;
    case 'send': return `${head} recorded driver ${e.sendKind} (${e.reason}${e.rulings ? ` through #${e.rulings}` : ''}) to ${e.rid}: ${e.send}`;
    case 'resume': return `${head} ${e.release === 'hold' ? 'released abandon hold of' : 'resumed'} ${e.node}${e.after !== undefined ? ` after ${e.after}` : ''}${e.expect ? ` (expect ${e.expect})` : ''}`;
    case 'halt': return `${head} halted ${e.node} attempt ${e.attempt}, ${e.needs === 'owner' ? NEEDS_OWNER_TEXT : NEEDS_PARENT_TEXT}: ${oneLine(e.reason)}`;
    case 'evidence': return e.merge !== undefined ? `${head} recorded receipt ${e.node}/${e.id} (merge #${e.merge}): ${evidenceText(e)}` : `${head} recorded manual evidence ${e.node}/evidence:${e.id}: ${evidenceText(e)}`;
    case 'decoy-commit': return `${head} committed decoys ${e.digest.slice(0, 12)}`;
    case 'decoy-reveal': return `${head} revealed decoys ${e.decoys.map(d => d.node).join(', ')}`;
    default: return `${head} ${e.kind}`;
  }
}
export function renderEntry(e: RecordedAct): string { return alreadyRecordedText(e) ?? `Recorded ${entryLine(e)}`; }
/** Text of an `owed gc` result (CLI and pi tool). */
export function renderGc(r: GcResult): string {
  const removed = r.removed.map(i => `  ${i.node}#${i.attempt}: ${[i.worktree && `worktree ${i.worktree}`, i.branch && `branch ${i.branch}`, ...i.pinned.map(ref => `${r.dryRun ? 'would pin' : 'pinned'} ${ref}`)].filter(Boolean).join(', ')}`);
  const kept = r.kept.map(i => `  ${i.node}#${i.attempt} (${i.branch}): ${i.reason}`);
  // M2: reused measurement trees, only when there are any.
  const trees = [...(r.trees?.length ? [`Reused measurement trees ${r.dryRun ? 'that would be removed' : 'removed'}:`, ...r.trees.map(t => `  ${t.path}: ${t.reason}`)] : []), ...(r.treesKept?.length ? ['Reused measurement trees kept:', ...r.treesKept.map(t => `  ${t.path}: ${t.reason}`)] : [])];
  // N4: stale plan cache files, only when there are any.
  const cache = r.planCache?.length ? [`Plan cache files ${r.dryRun ? 'that would be removed' : 'removed'} (sha no longer in the ledger): ${r.planCache.length}`] : [];
  return [`${r.dryRun ? 'Would remove' : 'Removed'}${removed.length ? '' : ': nothing'}`, ...removed, `Kept${kept.length ? '' : ': nothing'}`, ...kept, ...trees, ...cache, ...(r.entry ? [renderEntry(r.entry)] : [])].join('\n');
}
export function renderReport(v: Report): string {
  const list = (title: string, lines: string[]) => [`${title}${lines.length ? '' : ': none'}`, ...lines.map(l => `  ${l}`)];
  const runs = actRuns(actHistories.get(v) ?? v.ownerActions, actHistories.get(v)?.filter(e => e.kind === 'rule') ?? v.rulings);
  const lines = (es: Entry[]) => collapsedActLines(es,entryLine,runs);
  return [`Report (since ${v.since === -1 ? 'start' : typeof v.since === 'string' ? clockTime(v.since) : v.since})`,
    `Reviews by the writer's model: ${v.reviews?.sameModel ?? 0}`,
    ...list('Merges', v.merges.map(entryLine)),
    ...list('Status changes', v.changes.map(c => `${c.subject}/${c.obligation}: ${c.before ? statusNames[c.before] ?? c.before : 'new'} → ${statusNames[c.after] ?? c.after}`)),
    ...list('Active blocks', v.blocks.map(b => `#${b.seq} ${b.node}/${b.obligation} (${b.kind === 'exec' ? 'execution' : 'review'}, rank ${b.rank}): ${b.clear}`)),
    ...(v.superseded?.length ? list('Superseded blocks (not active; the plan changed their check)', v.superseded.map(b => `${b.node}/${b.obligation} ${b.text}`)) : []),
    ...(v.knownRed?.length ? list('Known-red debt', v.knownRed.map(knownRedText)) : []),
    ...(v.quarantine?.length ? list('Debt (quarantine)', v.quarantine) : []),
    ...(v.trackedDebt?.length ? list('Tracked waiver debt',v.trackedDebt) : []),
    ...list('Waivers', lines(v.waivers)),
    ...list('Downgrades ΔO⁻', v.downgrades.flatMap(d => d.items.map(i => `#${d.seq} ${d.allowance !== undefined ? allowanceLabel(d) : `${d.by}${d.channel === 'delegated' ? ' (delegated)' : ''}`} ${i.node}: ${i.what}`))),
    ...list('Rulings', v.rulings.map(r => `#${r.seq} ${r.by}${r.prospective ? ' (prospective)' : ''}${r.channel === 'delegated' ? ' (delegated)' : ''} (${r.nodes === '*' ? 'all nodes' : r.nodes.join(', ')}): ${r.text}`)),
    ...list('Owner decisions needed', v.decisions.map(itemText)),
    ...list('Owner actions', lines(v.ownerActions)),
    ...adoptionSections(v.adoptions, list, 'Trunk adoptions (owner decisions: commits made outside owed)', 'Trunk adoptions under allowance (parent adoptions: commits made outside owed)'),
    ...(v.halts?.length ? list('Driver halts', v.halts.map(h => `${h.node}: ${haltText(h)}${h.active ? ' (active)' : ' (cleared)'}`)) : []),
    ...(v.receipts?.length ? list('Receipts (manual, informational)', v.receipts.map(receiptText)) : []),
    ...renderEscapes(v.escapes)].join('\n');
}

// ---------- escapes and decoys (north-star metric) ----------
export interface EscapeSummary {
  escapes: State['escapes']; byClass: Record<EscapeClass, number>;
  decoys: State['decoys']; caught: number; escaped: number; pending: number; unrevealed: number;
  rate: number | null;          // escaped / (caught + escaped); null before any decoy is decided
}
const escapeLabels: Record<EscapeClass, string> = { missing: '② missing obligation', 'false-pass': '①a false affirmative observation', reuse: '①b unsound evidence reuse', weak: '①c weak oracle', waiver: '③ owner waiver' };
/** Cumulative over the whole ledger, independent of the report window. */
export function escapeSummary(s: State): EscapeSummary {
  const byClass = { missing: 0, 'false-pass': 0, reuse: 0, weak: 0, waiver: 0 } as Record<EscapeClass, number>;
  for (const e of s.escapes) byClass[e.class]++;
  const count = (o: string) => s.decoys.filter(d => d.outcome === o).length, caught = count('caught'), escaped = count('escaped');
  return { escapes: s.escapes, byClass, decoys: s.decoys, caught, escaped, pending: count('pending'), unrevealed: s.decoyCommits.filter(c => c.revealed === undefined).length, rate: caught + escaped ? escaped / (caught + escaped) : null };
}
export function renderEscapes(v: EscapeSummary): string[] {
  return [`Escapes (all time): ${v.escapes.length} — ${Object.entries(v.byClass).map(([k, n]) => `${k} ${escapeLabels[k as EscapeClass].split(' ')[0]}: ${n}`).join(', ')}`,
    ...v.escapes.map(e => `  #${e.seq} ${e.by} ${e.node} (merge #${e.merge}) ${e.class} ${escapeLabels[e.class]}: ${e.note}${e.evidence ? ` [${e.evidence}]` : ''}`),
    `Decoys: caught ${v.caught}, escaped ${v.escaped}, pending ${v.pending}; unrevealed commitments ${v.unrevealed}`,
    ...v.decoys.map(d => `  ${d.node}: ${d.outcome}${d.decidedBy !== undefined ? ` at #${d.decidedBy}` : ''} (committed #${d.commit}, revealed #${d.reveal}) — ${d.defect}`),
    `Escape rate: ${v.rate === null ? 'n/a (no decided decoys)' : `${(v.rate * 100).toFixed(1)}% (${v.escaped} escaped / ${v.caught + v.escaped} decided)`}`];
}

// ---------- morning brief ----------
export interface BriefDecision { node: string; obligation: string; key: string; mark: ItemView['mark']; detail: string; blockedDownstream: number; command: string }
export interface BriefMerged {
  node: string; seq: number; ts: string; commit: string;
  measured: number; waived: number; reviewed: number; deferred: number; untested: number;
  measuredItems: string[]; waivedItems: string[]; untestedChanges: string[]; reviewers: string[];
  /** D23 approve/evidence items in E: manual, never counted as measured (present only when non-empty). */
  manualItems?: string[];
}
export interface BriefBlock { seq: number; node: string; obligation: string; kind: Block['kind']; state: Block['state']; failingObs?: number; reviewer?: string; rank?: number; clear: string }
/** One delegated owner act (D25.5): kind, node, what it did (downgrade items, waived obligation, adopted commit, …) and why. */
export interface BriefDelegated { seq: number; ts: string; by: string; kind: Entry['kind']; node?: string; what: string; note: string }
export interface BriefProgress { node: string; phase: 'dispatched' | 'submitted'; attempt: number; dispatchSeq: number; dispatchedAt: string; ageMs: number; submitSeq?: number; submittedAt?: string; submitAgeMs?: number }
export interface Brief {
  knownRed?: KnownRedDebt[];
  deferred?: DeferredView[];
  summary?: SummaryView;
  trunk?: StatusView['trunk'];
  invariants?: ItemView[];
  since: number | string; now: string;
  decisions: BriefDecision[]; merged: BriefMerged[]; rejected: BriefBlock[]; inProgress: BriefProgress[];
  /** Adoptions of trunk commits made outside owed after `since` (shown only when there are any): owner ones as owner decisions, parent ones under allowance apart. */
  adoptions: AdoptionView[];
  /** Plan downgrades a parent recorded under an allowance after `since` (D21.3), labelled as in the report (shown only when there are any). */
  allowanceDowngrades: State['downgrades'];
  /** D25.5: owner entries with channel `delegated` after `since`, in ledger order (the brief's first section, shown when there are any). */
  delegated: BriefDelegated[];
  later: string[];
  reported: { node: string; resume: number }[];
  unguarded?: { node: string; seq: number; paths: string[] }[];
  totals: { merged: number; acceptedUnmerged: number; blocked: number; ready: number; waiting: number; later: number; reported: number };
}
const reviewObligation = (o: string): boolean => o === 'review' || o === 'closure-review';
function mergeBlockClearHint(s: State, entries: readonly Entry[], b: Block, rt?: Runtime): string {
  const e = entries.find(e => e.seq === b.seq);
  return [itemLine(s, b.node, b.obligation, rt), ...(e?.kind === 'obs' && e.merging === b.node ? mergeFailureHints(s, b.node, [e]) : [])].join('; ');
}
/** FH: advisory text only; inspect at most the last 5000 entries and cite at most three other-tree failures. */
/**
 * MS3: the merge guard refused on failing merge-key invariant observations measured before this call (`reused`): say
 * so, with the command that measures them again (`driver`: the halt's resume, else the CLI attest).
 */
export function reusedHint(node: string, reused: readonly ObsEntry[], now: number, driver: boolean): string | undefined {
  if (!reused.length) return undefined;
  return `${reused.map(e => `reused #${e.seq} (same merge key, measured ${age(Math.max(0, now - Date.parse(e.ts)))} ago)`).join(', ')}; measure again: ${driver ? `owed decide ${node} --remeasure --text "<why remeasure>"` : `owed attest ${node} --remeasure`}`;
}
export function mergeFailureHints(s: State, node: string, failures: readonly ObsEntry[]): string[] {
  const named = failures.filter(e => e.verdict === 'fail' && /^(check|inv):/.test(e.obligation) && e.failed?.length);
  const entries = entriesOf(s), lines: string[] = [], seen = new Set<string>();
  for (const failure of failures) {
    if (failure.verdict !== 'fail' || failure.merging !== node || !failure.obligation.startsWith('inv:') || seen.has(failure.obligation)) continue;
    const pass = entries.findLast((e): e is ObsEntry => e.kind === 'obs' && e.obligation === failure.obligation && e.verdict === 'pass' && e.commit === s.trunk.commit);
    if (!pass) continue;
    seen.add(failure.obligation);
    const paths = s.nodes[node]?.candidate?.changed ?? [];
    lines.push(`${failure.obligation}: pass on trunk ${s.trunk.commit.slice(0, 12)} (#${pass.seq}) → fail on merge tree ${failure.commit.slice(0, 12)} (#${failure.seq})${paths.length ? `; node diff touches ${paths.slice(0, 3).map(oneLine).join(', ')}${paths.length > 3 ? ` (+${paths.length - 3} more)` : ''}` : ''}`);
  }
  if (!named.length) return lines;
  const history = entries.slice(-5000).reverse();
  const names = [...new Set(named.flatMap(e => e.failed!))];
  for (const name of names) {
    const intermittent = intermittentLine(s, history, node, named.filter(f => f.failed!.includes(name)), name);
    if (intermittent) lines.push(intermittent);
    if (name.length < 6) continue;
    for (const spec of s.plan.nodes) {
      const n = s.nodes[spec.id];
      if (spec.id === node || !n || n.merged || !(n.slot?.open || n.accepted || n.phase === 'ready')) continue;
      const text = [spec.title, spec.brief, ...spec.checks.flatMap(c => [c.run, ...(c.tests ?? [])])];
      if (text.some(t => t?.includes(name))) lines.push(`fix candidate: ${spec.id} (${n.phase}) — owed decide ${node} --after ${spec.id} --text "<wait for fix>"`);
    }
  }
  return [...new Set(lines)];
}
/** Ruling #2118: probe history belongs to one subject/check and its recorded run definition. */
function trunkRunDefinition(plan: Plan, observation: ObsEntry): string | undefined {
  const id = observation.obligation.slice(observation.obligation.indexOf(':') + 1);
  const spec = observation.obligation.startsWith('inv:')
    ? plan.invariants.find(c => c.id === id)
    : plan.nodes.find(n => n.id === observation.subject)?.checks.find(c => c.id === id);
  return spec ? canonical({ run: spec.run }) : undefined;
}
/** SG3: current trunk evidence takes precedence over intermittent history. */
function signatureTrunkRed(s: State, failures: readonly ObsEntry[], name: string): string | undefined {
  for (const failure of failures) {
    const signature = failure.signatures?.[name];
    if (!signature) continue;
    const definition = trunkRunDefinition(planAt(s, failure.seq), failure);
    if (definition === undefined || definition !== trunkRunDefinition(s.plan, failure)) continue;
    const trunk = entriesOf(s).slice().reverse().filter((e): e is ObsEntry => e.kind === 'obs' && e.by === 'executor:owed' && e.obligation === failure.obligation
      && e.subject === failure.subject && (e.probe === 'trunk' || (e.subject === 'trunk' && e.merging === undefined && e.batch === undefined))
      && trunkRunDefinition(planAt(s, e.seq), e) === definition);
    const key = failure.obligation.startsWith('inv:') ? s.trunk.invKeys[failure.obligation.slice(4)] : trunk.find(e => e.commit === s.trunk.commit)?.key;
    const current = trunk.find(e => e.key === key);
    if (!current || current.verdict !== 'fail' || !current.failed?.includes(name) || current.signatures?.[name] !== signature) continue;
    let first = current;
    for (const e of trunk.filter(e => e.seq < current.seq)) {
      if (e.verdict !== 'fail' || !e.failed?.includes(name) || e.signatures?.[name] !== signature) break;
      first = e;
    }
    const change = entriesOf(s).findLast(e => (e.kind === 'merge' || e.kind === 'adopt') && e.seq <= first.seq);
    const after = change?.kind === 'merge' ? ` (after merge #${change.seq} ${change.node})` : change?.kind === 'adopt' ? ` (after adopt #${change.seq})` : '';
    return `${oneLine(name)}: trunk red since #${first.seq}${after}; fix trunk before retrying`;
  }
  return undefined;
}
/** SG2: one key must contain pass and matching-signature failure evidence for this test. */
function intermittentLine(s: State, history: readonly Entry[], node: string, failures: readonly ObsEntry[], name: string): string | undefined {
  const red = signatureTrunkRed(s, failures, name);
  if (red) return red;
  const obs = history.filter((e): e is ObsEntry => e.kind === 'obs' && e.by === 'executor:owed');
  const sig = (e: ObsEntry): string | undefined => e.signatures?.[name];
  const flips = obs.filter(e => (e.verdict === 'fail' || e.runs?.some(r => r.verdict === 'fail' && r.failed?.includes(name))) && e.failed?.includes(name) && failures.some(f => e.obligation === f.obligation && (sig(f) === undefined || sig(e) === sig(f))));
  const flip = flips.filter(e => e.runs?.some(r => r.verdict === 'pass') || obs.some(p => p.subject === e.subject && p.obligation === e.obligation && p.key === e.key && p.verdict === 'pass')).slice(0, 3);
  if (flip.length) return `known intermittent: ${oneLine(name)} failed and passed on the same key (${flip.map(e => `#${e.seq}`).join(', ')}); inspect the matching failures before retrying`;
  const other = obs.filter(e => e.verdict === 'fail' && e.failed?.includes(name) === true && (e.probe === 'trunk' || (e.subject !== node && e.merging !== node)) && failures.every(f => f.seq !== e.seq && f.commit !== e.commit));
  // Only known signatures can show a different error; unknown ones print nothing.
  const older = other.filter(e => e.probe === undefined && sig(e) !== undefined);
  if (!older.length || !failures.some(f => sig(f) !== undefined) || older.some(e => failures.some(f => sig(f) === sig(e)))) return undefined;
  return `same test failed on older trees (different error): ${oneLine(name)} (${older.slice(0, 3).map(e => `#${e.seq}`).join(', ')})`;
}
/** A needs-parent block recorded on the current candidate of its node's open attempt (D18b.4: stale ones keep the stale wording). */
function currentNeeds(s: State, b: Block): boolean {
  const n = s.nodes[b.node];
  return b.needs === 'parent' && b.kind === 'judgment' && !!n?.slot?.open && !!n.candidate && n.candidate.keys[b.obligation] === b.key;
}
/** Pure morning brief over a reduced state. `since` limits the Merged section; the other sections show current state. */
export function briefView(s: State, entries: Entry[], since: number | string = -1, now: number = Date.now(), coverage?: Map<number, string[]>, driverRunning = false, summary?: SummaryView): Brief {
  const included = (e: Entry): boolean => typeof since === 'number' ? e.seq > since : Date.parse(e.ts) > Date.parse(since);
  const ts = (seq: number): string => entries.find(e => e.seq === seq)?.ts ?? '';
  const nodes = Object.values(s.nodes), open = nodes.filter(n => !n.merged);
  const rt = summary && presentationRuntime.get(summary) || { driverRunning };
  const decisions = [...Object.keys(s.nodes).flatMap(id => needs(s, id, rt)), ...repoNeeds(s, rt)].filter(n => n.obligation).map(n => {
    const i = (n.node === 'trunk' ? s.invariants : s.nodes[n.node]?.items)?.find(i => i.obligation === n.obligation);
    return { node: n.node, obligation: n.obligation!, key: n.key ?? '', mark: i?.mark ?? '⊥', detail: n.text, blockedDownstream: s.nodes[n.node]?.dependents ?? 0, command: n.command ?? '' };
  }).sort((a, b) => b.blockedDownstream - a.blockedDownstream || a.node.localeCompare(b.node) || a.obligation.localeCompare(b.obligation));
  const merged = entries.filter((e): e is Extract<Entry, { kind: 'merge' }> => e.kind === 'merge' && included(e) && !!s.nodes[e.node]).map(e => {
    const card = receipt(s, entries, e.node);
    const measuredItems = card.items.filter(i => i.status === 'E' && !reviewObligation(i.obligation) && i.obligation !== 'rulings' && !isManual(i.obligation)).map(i => i.obligation);
    const manualItems = card.items.filter(i => i.status === 'E' && isManual(i.obligation)).map(i => i.obligation);
    const waivedItems = card.items.filter(i => i.status === 'W').map(i => i.obligation);
    const reviewers = [...new Set(card.items.filter(i => i.status === 'E' && reviewObligation(i.obligation)).flatMap(i => i.observations.flatMap(o => o.kind === 'review' && o.verdict === 'ok' ? [o.by] : [])))];
    return { node: e.node, seq: e.seq, ts: e.ts, commit: e.commit, measured: measuredItems.length, waived: waivedItems.length,
      reviewed: card.items.filter(i => i.status === 'E' && reviewObligation(i.obligation)).length,
      deferred: s.deferred.filter(d => d.node === e.node).length, untested: card.untested.length,
      measuredItems, waivedItems, untestedChanges: card.untested, reviewers, ...(manualItems.length ? { manualItems } : {}) };
  });
  const rejected = open.flatMap(n => n.blocks.filter(b => countsBlock(b))).map(b => ({ seq: b.seq, node: b.node, obligation: b.obligation, kind: b.kind, state: b.state,
    ...(b.kind === 'exec' ? { failingObs: b.seq } : { reviewer: entries.find(e => e.seq === b.seq)?.by, rank: b.rank }), clear: itemLine(s, b.node, b.obligation, rt) }));
  const inProgress = nodes.filter(n => (n.phase === 'dispatched' || n.phase === 'submitted') && n.slot).map(n => {
    const at = ts(n.slot!.dispatchSeq), sub = n.phase === 'submitted' && n.candidate ? ts(n.candidate.seq) : undefined;
    return { node: n.id, phase: n.phase as BriefProgress['phase'], attempt: n.slot!.attempt, dispatchSeq: n.slot!.dispatchSeq, dispatchedAt: at, ageMs: Math.max(0, now - Date.parse(at)),
      ...(sub !== undefined ? { submitSeq: n.candidate!.seq, submittedAt: sub, submitAgeMs: Math.max(0, now - Date.parse(sub)) } : {}) };
  });
  const count = (phase: NodeState['phase']): number => nodes.filter(n => n.phase === phase).length;
  const adoptions = s.adoptions.filter(a => { const e = entries.find(x => x.seq === a.seq); return !!e && included(e); });
  const delegated = entries.filter(e => e.channel === 'delegated' && e.by.startsWith('owner:') && included(e)).map(delegatedAct);
  const allowanceDowngrades = s.downgrades.filter(d => { const e = entries.find(x => x.seq === d.seq); return d.allowance !== undefined && !!e && included(e); });
  const later = s.plan.nodes.filter(n => n.later && !s.nodes[n.id]?.merged).map(n => n.id);
  const reported = open.flatMap(n => { const resume = reportedOf(s,n.id); return resume === undefined ? [] : [{ node:n.id, resume }]; });
  const knownRed = knownRedDebt(s).knownRed;
  return { ...(knownRed ? { knownRed } : {}), summary: summary ?? statusView(s, entries, [], now, driverRunning).summary, trunk: s.trunk, invariants: s.invariants, since, now: new Date(now).toISOString(), delegated, decisions, merged, adoptions, allowanceDowngrades, rejected, inProgress, later, reported,
    ...(coverage ? { unguarded: entries.filter((e): e is Extract<Entry, { kind: 'merge' }> => e.kind === 'merge').slice(-10).map(e => ({ node:e.node, seq:e.seq, paths:coverage.get(e.seq) ?? [] })) } : {}),
    totals: { merged: count('merged'), acceptedUnmerged: count('accepted'), blocked: new Set(rejected.map(b => b.node)).size, ready: count('ready'), waiting: open.filter(n => waitingFor(s,n.id) || (n.phase === 'blocked' && !later.includes(n.id))).length, later: later.length, reported: reported.length } };
}
/** D25.5: one delegated owner entry as kind, node, what it did and its note or reason. */
function delegatedAct(e: Entry): BriefDelegated {
  const base = { seq: e.seq, ts: e.ts, by: e.by, kind: e.kind };
  switch (e.kind) {
    case 'plan': return { ...base, what: e.downgrades.length ? `downgrades ${e.downgrades.map(d => `${d.node}: ${d.what}`).join('; ')}` : `plan update${e.path ? ` from ${e.path}` : ''}`, note: e.note ?? '' };
    case 'waive': return { ...base, node: e.node, what: `waived ${e.obligation}${e.accept_risk?.length ? ` (accepted block risk ${e.accept_risk.map(x => `#${x}`).join(', ')})` : ''}`, note: e.reason };
    case 'defer': return { ...base, node: e.node, what: `deferred ${e.items.map(i => i.id).join(', ')}`, note: e.reason };
    case 'adopt': return { ...base, what: `adopted ${e.trunk} ${e.prior.slice(0, 12)}..${e.commit.slice(0, 12)} (${plural(e.commits, 'commit')}, ${plural(e.changed.length, 'changed path')})`, note: e.note };
    case 'review': return { ...base, node: e.node, what: `${e.obligation === 'approve' ? (e.verdict === 'ok' ? 'approved' : 'blocked approval') : `reviewed ${e.obligation ?? 'review'} ${e.verdict} rank ${e.rank}`}`, note: e.note ?? '' };
    case 'evidence': return { ...base, node: e.node, what: e.merge !== undefined ? `receipt ${e.id} (merge #${e.merge})` : `manual evidence ${e.id}`, note: e.note };
    case 'genesis': return { ...base, what: `initialized ledger, trunk ${e.trunk} ${e.commit.slice(0, 12)}`, note: '' };
    case 'rule': return { ...base, what: `ruling (${e.nodes === '*' ? 'all nodes' : e.nodes.join(', ')})`, note: e.text };
    case 'escape': return { ...base, node: e.node, what: `escape (merge #${e.merge}, ${e.class})`, note: e.note };
    case 'abandon': return { ...base, node: e.node, what: `abandoned attempt ${e.attempt}`, note: e.reason };
    default: return { ...base, ...('node' in e && typeof e.node === 'string' ? { node: e.node } : {}), what: e.kind, note: '' };
  }
}
const delegatedText = (d: BriefDelegated): string => `#${d.seq} ${d.by} ${d.kind}${d.node ? ` ${d.node}` : ''}: ${oneLine(d.what)}${d.note ? ` — ${oneLine(d.note)}` : ''}`;
function age(ms: number): string {
  const m = Math.floor(ms / 60_000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return d ? `${d}d${h % 24}h` : h ? `${h}h${m % 60}m` : m ? `${m}m` : `${Math.floor(ms / 1000)}s`;
}
export function renderBrief(v: Brief): string {
  const section = (title: string, lines: string[]) => [`${title}${lines.length ? ` (${lines.length}):` : ': none'}`, ...lines.map(l => `  ${l}`)];
  const since = v.since === -1 ? 'start' : typeof v.since === 'number' ? `#${v.since}` : clockTime(v.since);
  const deferDebt = (v.summary?.debt ?? []).filter(d => d.includes(': owner defer') || d.startsWith('quarantine ') || d.startsWith('quarantined ') || /: waived — (?:tracked by |\(tracker )/.test(d));
  return [...(v.summary && v.trunk && v.invariants ? summaryHead(v.trunk, v.invariants, v.summary) : []),
    ...(deferDebt.length ? ['Debt:', ...deferDebt.map(d => `  ${d}`)] : []), `Brief (since ${since})`,
    ...(v.delegated?.length ? section(`Owner acts (delegated) since ${since}`, v.delegated.map(delegatedText)) : []),
    ...(v.summary ? [] : section('Needs your decision', v.decisions.map(d => `${d.node}/${d.obligation} [${d.blockedDownstream} blocked downstream] ${d.mark} ${d.detail} → ${d.command}`))),
    ...section('Merged', v.merged.map(m => `${m.node} #${m.seq} → ${m.commit.slice(0, 12)}: ${m.measured} measured, ${m.waived} waived${m.waivedItems.length ? ` (${m.waivedItems.join(', ')})` : ''}, ${m.reviewed} reviewed${m.manualItems?.length ? `, ${m.manualItems.length} manual (${m.manualItems.join(', ')})` : ''}${m.deferred ? `, ${plural(m.deferred, 'deferred invariant')}` : ''}, ${plural(m.untested, 'untested change')}; reviewers: ${m.reviewers.join(', ') || 'none'}`)),
    ...(v.unguarded?.length ? section('Unguarded paths (last 10 merges)', v.unguarded.map(m => `${m.node} #${m.seq}: ${m.paths.join(', ') || 'none'}`)) : []),
    ...adoptionSections(v.adoptions, section, 'Adopted outside owed (owner decisions)', 'Adopted outside owed (parent adoptions under allowance)'),
    ...(v.allowanceDowngrades?.length ? section('Downgrades under allowance', v.allowanceDowngrades.flatMap(d => d.items.map(i => `#${d.seq} ${allowanceLabel(d)} ${i.node}: ${i.what}`))) : []),
    ...(v.knownRed?.length ? section('Known-red debt', v.knownRed.map(knownRedText)) : []),
    ...section('Rejected or blocked', v.rejected.map(b => `${b.node}/${b.obligation} ${b.kind === 'exec' ? `failing obs #${b.failingObs}` : `review block #${b.seq} by ${b.reviewer ?? '?'} rank ${b.rank}`}${b.state === 'flaky' ? ' (flaky: a rerun passed)' : ''} → ${b.clear}`)),
    ...(v.later?.length ? section('Backlog (later)',v.later) : []),
    ...(v.reported?.length ? section('Reported',v.reported.map(r => `${r.node}: reported (resume #${r.resume})`)) : []),
    ...section('In progress', [...v.inProgress.filter(p => !v.summary?.progress.some(a => a.node === p.node && a.phase.startsWith('held by ruling #'))).map(p => `${p.node} ${p.phase} (attempt ${p.attempt}): dispatched ${age(p.ageMs)} ago${p.submitAgeMs !== undefined ? `, submitted ${age(p.submitAgeMs)} ago` : ''}`), ...(v.summary?.progress ?? []).filter(p => p.phase.startsWith('held by ruling #')).map(p => `${p.node}: ${p.phase} (${age(p.ageMs)})`)]),
    `Total: ${v.totals.merged} merged, ${v.totals.acceptedUnmerged} accepted-unmerged, ${v.totals.blocked} blocked, ${v.totals.ready} ready, ${v.totals.waiting} waiting on dependencies${v.totals.reported || v.totals.later ? `, ${v.totals.reported} reported, ${v.totals.later} later` : ''}`].join('\n');
}

// ---------- dispatch packet ----------
/**
 * Task text of attempt `attempt` of node `spec` in `worktree` (pure): the packet `owed dispatch` stores and the driver's
 * writer task. `rules` are the rulings in scope at dispatch time, in ledger order. `driver` (K1.3): the writer is
 * launched by `owed drive`, which measures the candidate itself; the packet then says not to run owed attest. It
 * defaults to true for the driver's writer task (drive.ts writerTask); `owed dispatch` passes false unless the
 * driver dispatches, so a manual dispatch stores the packet without the line.
 */
export function dispatchPacket(spec: NodeSpec, attempt: number, worktree: string, rules: readonly Rule[], driver = true, state?: State, dispatchSeq?: number): string {
  const lines = dispatchLines(spec, attempt, worktree, rules, state ? entriesOf(state)[0]!.hash.slice(0, 12) : '<project>');
  if (state) {
    if (state.plan.risk !== undefined) lines.push('Owner risk classes (first matching rule per changed path; unmatched paths use the node review):', ...state.plan.risk.map((r, i) => `- risk rule ${i + 1}: ${r.paths.map(oneLine).join(', ')}; review ${r.review.count}, rank >= ${r.review.min_rank}`));
    const permission = preauthorizedWritesLines(state,spec.id,dispatchSeq);
    lines.splice(lines.findIndex(x => x.startsWith('Allowed writes:')) + 1, 0, ...permission);
    if (permission.length) lines[lines.indexOf('commit your work; do not edit files outside writes; owed will run the checks itself')] = 'commit your work; stay within plan writes or task-needed owner pre-authorized paths; owed will run the checks itself';
  }
  return [...lines, ...(driver ? [DRIVER_ATTESTS] : [])].join('\n');
}
/** GR6: permissions are task-limited owner pre-authorization, not an instruction to widen unnecessarily. */
export function preauthorizedWritesLines(s: State, node: string, dispatchSeq?: number): string[] {
  const plan = dispatchSeq === undefined ? s.plan : planAt(s,dispatchSeq);
  let allowance = allowanceSeq(s);
  if (dispatchSeq !== undefined) {
    allowance = undefined;
    let prior: Plan['allow'];
    for (const e of entriesOf(s)) if (e.seq < dispatchSeq && (e.kind === 'genesis' || e.kind === 'plan')) {
      const next = planAt(s,e.seq + 1).allow;
      if (canonical(prior) !== canonical(next)) allowance = e.seq;
      prior = next;
    }
  }
  const prefixes = [...new Set((plan.allow ?? []).filter(r => r.nodes.some(g => matchesGlob(node,g))).flatMap(r => r.writes ?? []))].sort();
  const cap = plan.nodes.find(n => n.id === node)?.allow_only;
  if (cap !== undefined) return [`Pre-authorized by the owner (allowance plan #${allowance}): ${prefixes.join(', ') || '(none)'}; allow_only: [${cap.join(', ')}] — only matching task-needed paths are granted; own writes are unchanged.`];
  return prefixes.length ? [`Pre-authorized by the owner (allowance plan #${allowance}): ${prefixes.join(', ')} — edit these freely; do not ask the parent; owed grants them when your candidate is measured. Change files there only when the task needs it.`] : [];
}
function grantedWritesText(g: import('./types.ts').GrantEntry): string {
  return `Granted writes: ${g.paths.slice(0,20).map(oneLine).join(', ')}${g.paths.length > 20 ? `, … +${g.paths.length - 20} more` : ''} (#${g.seq}, allowance plan #${g.allowance})`;
}
function reviewGrantLines(s: State, node: string): string[] {
  const grants = grantsOf(s,node), allowances = [...new Set(grants.map(g => g.allowance))];
  return allowances.map(seq => `Writes granted under allowance (plan #${seq}): ${grants.filter(g => g.allowance === seq).flatMap(g => g.paths).sort().join(', ')} — judge whether each belongs to this node's task; block if not.`);
}
/** K1.3: the line of a driver-launched writer's packet. */
export const DRIVER_ATTESTS = 'the driver measures your candidate; do not run owed attest';
/** K1.3: the clause after every `owed attest <node>` owed suggests to a writer. */
export const SKIP_ATTEST = '(skip this when owed drive is running: the driver attests)';
function dispatchLines(spec: NodeSpec, attempt: number, worktree: string, rules: readonly Rule[], project: string): string[] {
  return [`# ${spec.title ?? spec.id}`, spec.brief ?? '', WRITER_DECISION, `Node: ${spec.id}; attempt: ${attempt}`, `Working directory: ${worktree}`, `Allowed writes: ${spec.writes.join(', ')}`, 'Checks run by owed:', ...spec.checks.map(c => `- ${c.id}: ${c.run}\n  red: ${!!c.red}${c.red ? `; tests: ${c.tests?.join(', ')}` : ''}`),
    'Long runs: processes you start end when your turn ends. Run a check or measurement that may outlive your turn as a durable command call, then end your turn without submitting:',
    `  pi-durable-subagents run --request owed-${project}-${spec.id}-${attempt}-<name> --wake caller -- <command…>`,
    'owed does not halt you while it runs; dsa resumes you with its exit status and output tail (pi-durable-subagents >= 1.1.0).', 'Applicable rulings:', ...rules.map(r => `- #${r.seq} ${r.text}`), 'commit your work; do not edit files outside writes; owed will run the checks itself', `After committing, run: owed submit ${spec.id}`];
}

// ---------- driver review packet (SPEC §12, D5) ----------
/**
 * Number of reviewer runs the driver launches for the current candidate: one covers review and closure-review;
 * `review.count` > 1 needs that many distinct reviewers; 0 when no review obligation exists. Their attempt-global
 * run numbers are n = reviewerBase(state, node) + 1 … + reviewRuns(state, node) (SPEC §12.3).
 */
export function reviewRuns(s: State, node: string): number {
  const n = s.nodes[node], spec = s.plan.nodes.find(x => x.id === node);
  if (!n?.candidate || !spec) return 0;
  const closure = n.items.some(i => i.obligation === 'closure-review');
  return Math.max(nodeReview(s, node).count, closure ? 1 : 0);
}
/**
 * Review obligations recorded by the attempt-global reviewer run `n` on the current candidate, through the local
 * index k = n - reviewerBase: `review` while k <= review.count, `closure-review` by k = 1; none for a run of an
 * earlier review epoch (k < 1) or beyond the candidate's runs.
 */
export function reviewObligations(s: State, node: string, n: number): ('review' | 'closure-review')[] {
  const st = s.nodes[node], spec = s.plan.nodes.find(x => x.id === node);
  if (!st?.candidate || !spec || !Number.isInteger(n)) return [];
  const k = n - reviewerBase(s, node);
  if (k < 1) return [];
  return [...(k <= nodeReview(s, node).count ? ['review' as const] : []), ...(k === 1 && st.items.some(i => i.obligation === 'closure-review') ? ['closure-review' as const] : [])];
}
/**
 * Task text of the driver's reviewer run `n` (attempt-global, SPEC §12.3) on the node's current candidate (pure;
 * usable before the launch entry for `n` exists): node, attempt, candidate,
 * base, brief, writes, obligations with required count/rank, rulings in scope, the exact `owed review` commands
 * for the slot reviewer `reviewer:drive-<node>-<attempt>-<k>` (k = n − reviewerBase: the identity is per review slot,
 * the same principal for every candidate of the attempt), and the rules (inspect the diff, edit nothing, reply with
 * seqs). When that principal has active review blocks on the node, the packet quotes them (seq, obligation, rank, note).
 * Per obligation it asks for rank max(required rank, this principal's block rank, 1 + rank of any other principal's
 * active rank-1 block) (D11), so its ok clears its own block and outranks another reviewer's rank-1 block; such other
 * blocks are quoted too.
 */
/** D23 line of a review packet: approve is the owner's; evidence names its role and, when this reviewer may record it, the command. */
function manualRequired(spec: NodeSpec, o: string, who: string, candidate?: string): string {
  if (o === 'approve') return 'owner approval (owed approve), not recorded by reviewers';
  const ev = spec.evidence?.find(e => `evidence:${e.id}` === o);
  return `manual evidence by ${ev?.by ?? 'reviewer'}${ev ? `: ${oneLine(ev.what)}` : ''}${ev?.by === 'reviewer' ? ` (if you checked it yourself: ${evidenceCommand(spec.id, ev.id, who, candidate)})` : ''}`;
}
export function reviewPacket(s: State, node: string, n = 1): string {
  const st = s.nodes[node], spec = s.plan.nodes.find(x => x.id === node);
  if (!st || !spec) throw new OwedError(`Node ${node} does not exist`);
  if (!st.slot?.open || !st.candidate) throw new OwedError(`Node ${node} has no open candidate`);
  const runs = reviewRuns(s, node), first = reviewerBase(s, node) + 1, k = n - first + 1;
  if (!Number.isInteger(n) || k < 1 || k > runs) throw new OwedError(`Node ${node} candidate #${st.candidate.seq} has ${runs} reviewer run(s)${runs ? ` (n = ${first}${runs > 1 ? `..${first + runs - 1}` : ''})` : ''}; run ${n} does not exist for it`);
  const { attempt, base } = st.slot, commit = st.candidate.commit, who = driveReviewer(node, attempt, k), c12 = commit.slice(0, 12);
  const rulings = applicableRules(s, node);
  const rulingsItem = st.items.find(i => i.obligation === 'rulings');
  const ack = rulingsItem && rulingsItem.status === 'D' && rulings.length ? ` --ack-rulings ${Math.max(...rulings.map(r => r.seq))}` : '';
  const rank = (o: 'review' | 'closure-review'): number => o === 'closure-review' ? 2 : Math.max(1, nodeReview(s, node).min_rank);
  // Active review blocks recorded by this slot's principal (on any earlier candidate of the attempt).
  const entries = entriesOf(s), author = (seq: number) => entries.find(e => e.seq === seq);
  const judged = st.blocks.filter(b => b.kind === 'judgment' && b.state === 'active');
  const blocks = judged.filter(b => author(b.seq)?.by === who), others = judged.filter(b => author(b.seq)?.by !== who && b.rank === 1);
  const slotRank = (o: 'review' | 'closure-review'): number => Math.max(rank(o), ...blocks.filter(b => b.obligation === o).map(b => b.rank ?? 0), ...others.filter(b => b.obligation === o).map(b => (b.rank ?? 0) + 1));
  const required = (o: string): string => o === 'review' ? `${nodeReview(s, node).count} non-writer review(s) by distinct reviewers, rank >= ${rank('review')}` : o === 'closure-review' ? `1 non-writer review, rank >= 2 (the diff touches the plan closure)` : o === 'rulings' ? `acknowledge applicable rulings${ack ? ` (${ack.trim()})` : ''}` : isManual(o) ? manualRequired(spec, o, who, c12) : 'measured by owed';
  const mine = reviewObligations(s, node, n);
  const commands = mine.flatMap(o => slotRank(o) > 2 ? [`(${o} requires rank ${slotRank(o)}: only the owner can record it; this run cannot discharge it)`] : [`owed review ${node} --as ${who} --ok|--block --rank ${slotRank(o)}${o === 'closure-review' ? ' --obligation closure-review' : ''}${ack} --candidate ${c12} --note "..."`]);
  const quote = (b: Block): string => { const e = author(b.seq); return `- #${b.seq} ${b.obligation} rank ${b.rank}${author(b.seq)?.by === who ? '' : ` by ${e?.by ?? '?'}`}: ${oneLine(e?.kind === 'review' ? e.note ?? '' : '')}`; };
  const quoted = blocks.map(quote), otherQuoted = others.filter(b => mine.includes(b.obligation as 'review')).map(quote);
  return [`# Review ${spec.title ?? node} (node ${node}, attempt ${attempt}, reviewer run ${k} of ${runs} for this candidate, n = ${n})`,
    `Node: ${node}; attempt: ${attempt}`,
    `Candidate: ${commit} (submit #${st.candidate.seq})`,
    `Base: ${base}`,
    ...(spec.brief ? ['Brief:', spec.brief.trimEnd()] : []),
    `Allowed writes: ${spec.writes.join(', ') || 'none'}`,
    ...reviewGrantLines(s,node),
    ...(s.plan.risk !== undefined ? [oneLine(reviewRequirementText(nodeReview(s, node)))] : []),
    'Obligations of the candidate:',
    ...st.items.map(i => `- ${i.obligation}: ${required(i.obligation)} [${i.mark} ${i.detail}]${mine.includes(i.obligation as 'review') ? ' — recorded by this run' : ''}`),
    `Rulings in scope:${rulings.length ? '' : ' none'}`,
    ...rulings.map(r => `- #${r.seq} ${r.text}`),
    `Your reviewer identity: ${who} (never the writer of this node).`,
    ...(quoted.length ? [`Your earlier review block(s) on this node, still active (check whether this candidate fixes them; an ok at the rank given below clears them):`, ...quoted] : []),
    ...(otherQuoted.length ? [`Active rank-1 review block(s) by other reviewers on the obligations you record (check whether this candidate fixes them; an ok at the rank given below clears them):`, ...otherQuoted] : []),
    `Inspect the actual diff: git diff ${base} ${commit}`,
    'Do not edit files, commit or run owed submit; review only.',
    `--ok means the candidate meets the node's goal as its title and brief state it, not only that the writer's report or evidence is accurate. If the candidate or the writer's report says the goal is not met, record --block (--needs-parent when the goal itself is in question).`,
    'If the brief or plan is ambiguous or contradictory, or the fix needs a product or contract decision, record --block --needs-parent and state the decision needed; do not push a guess onto the writer.',
    'Record each verdict in the ledger, choosing --ok or --block (the rank as given; explain a block in the note):',
    ...commands.map(c => `  ${c}`),
    `--candidate ${c12} names the candidate you reviewed: if the writer submits again while you review, recording is refused ("candidate changed", nothing recorded); then re-read owed why ${node} and review the new candidate.`,
    'Reply with the ledger seqs of the reviews you recorded.'].join('\n');
}
