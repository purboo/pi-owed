import { actRuns, collapsedActLines, alreadyRecordedText, type RecordedAct } from './identical-acts.ts';
import type { AdoptionView, AttemptRuns, Block, CheckSpec, Entry, EscapeClass, EvidenceEntry, HaltEntry, ItemView, LaunchEntry, NodeSpec, NodeState, ObsEntry, Plan, Rule, SlotRebase, State } from './types.ts';
import { mergeWaitSuffix } from './adopt-wait.ts';
import type { AdoptPreview, GcResult } from './ops.ts';
import type { TrunkDrift } from './git.ts';
import { matchesGlob } from 'node:path';
import { matchesAny, driveConfig, isCheckTemplateRun } from './plan.ts';
import { mergeQueue, applicableRules, NO_RULINGS, checkDefinition, checkOf, planAt, overlapping, halted, driveReviewer, driveReviewerSlot, reviewerBase, entriesOf, parentRuling, awaitingRuling, isManual, writesAllowed, allowanceSeq, grantsOf, withinWrites, grantHint, waitingFor, reportedOf, type Waiting } from './reducer.ts';
import { sharedParked, sharedParkNotices, sharedPhase } from './reducer.ts';
import { genesisProgress, trunkInvariantReds, trunkParked, trunkParkNotices, trunkRedOf, trunkRedText, activeKnownRed, knownRedPlanSeq, activeQuarantineOf } from './reducer.ts';
import { canonical } from './canon.ts';
import { mergeBatchPlan } from './reducer.ts';
import { mergeBatchSize } from './plan.ts';
/** MT6: the planned batch after the merge queue (`; batch of N: A, B`). */
const batchPlanText = (b: string[] | undefined): string => b?.length ? `; batch of ${b.length}: ${b.join(', ')}` : '';
import { rebasePendingText, type RebasePending } from './rebase-view.ts';
import { OwedError } from './errors.ts';
import { observationsOf } from './reducer.ts';
import type { WaiveEntry } from './types.ts';
import type { InFlight } from './drive-bg.ts';
import { clockTime } from './clock.ts';

/** LO2: display current driver work without changing the ledger phase or acceptance. */
export const measurementText = (m: InFlight): string => `${m.do === 'merge' ? 'merging' : 'measuring'} (since ${clockTime(m.since)})`;

export interface ReceiptCard {
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
export const lapsedKnownRedText = (d: KnownRedDebt): string => `inv:${d.invariant} lapsed known_red: ${d.entries.map(e => `${oneLine(e.test)} (fix: ${oneLine(e.fix)})`).join(', ')}; plan #${d.plan}; removable: owed edit --invariant ${d.invariant} --set known_red='<remaining active entries>' --note "remove lapsed entries"`;
/** MS5: one debt line per active quarantine entry: invariants `<inv>/<test>`, node checks `<node>/<check>/<test>`. */
export interface QuarantineDebt { where: string; test: string; fix: string; note?: string }
export function quarantineDebt(s: State, fix?: string): QuarantineDebt[] {
  const of = (where: string, spec: CheckSpec): QuarantineDebt[] => activeQuarantineOf(s, spec).filter(e => fix === undefined || e.fix === fix).map(e => ({ where, test: e.test, fix: e.fix, ...(e.note ? { note: e.note } : {}) }));
  return [...s.plan.invariants.flatMap(i => of(i.id, i)), ...s.plan.nodes.filter(n => !s.nodes[n.id]?.merged).flatMap(n => n.checks.flatMap(c => of(`${n.id}/${c.id}`, c)))];
}
export const quarantineText = (d: QuarantineDebt): string => `quarantine ${oneLine(d.where)}/${oneLine(d.test)} until ${oneLine(d.fix)} merges`;
/** MS5: `owed why <fix>`: the quarantine entries its merge lifts. */
export const liftsText = (node: string, ds: QuarantineDebt[]): string => `merging ${node} lifts quarantine: ${ds.map(d => `${oneLine(d.where)}/${oneLine(d.test)}`).join(', ')}`;
/** NT3: presentation-only defer scope; unverified debt has not had its merge key rechecked. */
export type DeferredView = State['deferred'][number] & { unverified?: 'drift' | 'conflict' };
export interface StatusView {
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
/** `Genesis: k/n invariants observed` plus where the rest gets measured (D24.5). */
export function genesisLine(g: GenesisStatus): string {
  return `Genesis: ${g.observed}/${g.total} invariants observed ${g.measuring ? '(measuring in this session)' : '— run owed attest --genesis (or the next attest/merge measures them)'}; pending: ${g.pending.join(', ')}`;
}
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
  knownRed?: KnownRedDebt[];
  /** MS5: active quarantine entries (`quarantine <inv>/<test> until <fix> merges`). */
  quarantine?: string[];
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
export const amendLines = (r: { node: string; path: string; added: string[]; present: string[]; plan: Entry; rule: Entry; carried: Entry[]; notCarried: { node: string; reason: string }[] }): string[] => [
  renderEntry(r.plan), ...r.carried.map(carryLine), ...r.notCarried.map(notCarriedLine), renderEntry(r.rule),
  `Widened writes of ${r.node}: ${r.added.map(p => `+${p}`).join(', ')}${r.present.length ? ` (already in writes: ${r.present.join(', ')})` : ''}; wrote ${r.path}`,
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
function receiptItem(i: ItemView, entries: readonly Entry[]): ItemView & { observations: Entry[] } {
  let observations = entries.filter(e => i.evidence.includes(e.seq));
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
export function receipt(s: State, entries: readonly Entry[], node: string, mergeChecks: ItemView[] = []): ReceiptCard {
  const n = s.nodes[node]!;
  const checks = (s.plan.nodes.find(x => x.id === node)?.checks ?? []).filter(c => n.items.some(i => i.obligation === `check:${c.id}` && i.status === 'E'));
  const outOfWrites = outsideWrites(s, node), superseded = supersededOf(s, [n]);
  return withActHistory({ node, phase: n.phase, accepted: n.accepted,
    items: n.items.map(i => ({ ...receiptItem(i, entries), ...templateReceiptRun(s, i) })),
    ...(mergeChecks.length ? { mergeChecks: mergeChecks.map(i => ({ ...receiptItem(i, entries), ...templateReceiptRun(s, i) })) } : {}),
    blocks: n.blocks.filter(b => countsBlock(b)).map(b => ({ ...b, clear: mergeBlockClearHint(s, entries, b), ...(currentNeeds(s, b) ? { ruling: parentRuling(s, b)?.seq ?? ('needed' as const) } : {}), ...withNote(blockNote(s, b)) })),
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
    ...(n.slot?.open && n.slot.rebase ? { rebase: { ...n.slot.rebase, ...(n.slot.rebase.previous ? { rangeDiff: `git range-diff ${n.slot.rebase.previous.base}..${n.slot.rebase.previous.commit} ${n.slot.base}..${n.candidate?.commit ?? '<new commit>'}` } : {}) } } : {}) }, entries);
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
export function statusView(s: State, entries: Entry[] = [], mergeChecks: ItemView[] = [], now = Date.now(), driverRunning = false, currentDefers: DeferredView[] = s.deferred.filter(d => s.trunk.invKeys[d.id] === d.key)): StatusView {
  const groups: Record<string, string[]> = {}, pending: Record<string, ItemView[]> = { owner: [], 'parent+writer': [], reviewer: [], executor: [] };
  for (const n of Object.values(s.nodes)) {
    (groups[n.phase] ??= []).push(n.id);
    if (!waitingFor(s,n.id) && reportedOf(s,n.id) === undefined && !s.plan.nodes.find(x => x.id === n.id)?.later && (n.phase === 'ready' || n.phase === 'dispatched')) pending['parent+writer']!.push({subject:n.id,obligation:n.phase === 'ready' ? 'dispatch' : 'submit',key:'',status:'D',mark:'⊥',discharger:n.phase === 'ready' ? 'parent' : 'writer',evidence:[],detail:n.phase === 'ready' ? 'parent can dispatch work' : 'writer must submit a candidate'});
  }
  for (const i of [...Object.values(s.nodes).filter(n => !n.merged && n.phase !== 'removed').flatMap(n => n.items), ...s.invariants]) if (i.status === 'D') pending[i.discharger === 'writer' || i.discharger === 'parent' ? 'parent+writer' : i.discharger ?? 'executor']!.push(withBlockNotes(s, i));
  pending['parent+writer']!.push(...mergeChecks);
  const ready = Object.values(s.nodes).filter(n => n.phase === 'ready').sort((a,b) => b.dependents - a.dependents || a.id.localeCompare(b.id)).map(n => n.id), overlaps: Record<string, string[]> = {};
  for (const id of ready) { const o = overlapping(s, id); if (o.length) overlaps[id] = o; }
  const halts = Object.keys(s.nodes).flatMap(id => halted(s, id) ?? []), launches: Record<string, LaunchEntry[]> = {};
  for (const h of halts) if (h.needs === 'owner') pending.owner!.push({ subject: h.node, obligation: 'driver-halt', key: '', status: 'D', mark: '⏸', discharger: 'owner', evidence: [h.seq], detail: `driver halted attempt ${h.attempt} (#${h.seq}): ${oneLine(h.reason)}` });
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
  if (currentDefers.length) view.deferred = currentDefers;
  { const batch = mergeBatchPlan(s, mergeBatchSize(s.plan)); if (batch.length) view.mergeBatch = batch; }
  view.summary = summaryView(s, entries, view, now, driverRunning, currentDefers);
  return view;
}
/** NY1: a recorded repair after a review block, or a newer submit, is pending replacement evidence. */
export function repairingBlock(s: State, node: string): Block | undefined {
  const n = s.nodes[node], slot = n?.slot;
  if (!n || !slot?.open || halted(s, node)) return undefined;
  const block = n.blocks.findLast(b => countsBlock(b) && b.kind === 'judgment' && reviewObligation(b.obligation));
  if (!block) return undefined;
  return (n.candidate?.seq !== undefined && n.candidate.seq > block.seq || n.runs.find(r => r.attempt === slot.attempt)?.sends.some(x => x.reason === 'repair' && x.seq > block.seq)) ? block : undefined;
}
/** NY1 parent ruling: mirror drive.ownerNeeded's predicate without a views -> drive import cycle. */
function repairNeedsOwner(s: State, node: string): boolean {
  const n = s.nodes[node], spec = s.plan.nodes.find(x => x.id === node);
  if (!n) return false;
  const ownerBlocks = n.blocks.filter(b => {
    if (b.state === 'flaky') return true;
    if (b.state !== 'active' || b.kind !== 'judgment' || (b.rank ?? 0) < 2) return false;
    const by = entriesOf(s).find(e => e.seq === b.seq)?.by ?? '';
    const k = n.slot?.open && spec ? driveReviewerSlot(by, node, n.slot.attempt) : undefined;
    return !((b.rank ?? 0) <= 2 && k !== undefined && k <= Math.max(spec!.review.count, 1));
  });
  if (!n.slot?.open || !n.candidate) return ownerBlocks.length > 0;
  return n.items.some(i => i.status === 'D' && (i.mark === '⊤' || ownerBlocks.some(b => b.obligation === i.obligation) || i.obligation === 'review' && (spec?.review.min_rank ?? 1) > 2));
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
function summaryView(s: State, entries: Entry[], v: StatusView, now: number, driverRunning: boolean, currentDefers: DeferredView[]): SummaryView {
  const needs: SummaryView['needs'] = [], debt: string[] = [];
  const add = (node: string, reason: string, command: string) => {
    if (!needs.some(n => n.node === node && n.command === command)) needs.push({ node, reason: oneLine(reason), command });
  };
  const plain = (text: string): string => text.replace(/#[0-9]+\s*/g, '').split(';')[0]!.trim();
  const haltReason = (reason: string): string => {
    if (reason.startsWith('review-missing:')) return 'reviewer finished without recording the required review';
    if (/^writer run .*finished .*without submitting/.test(reason)) return 'writer finished without submitting a candidate';
    const sealed = /^writer run .* sealed (\S+)(.*)$/.exec(reason);
    if (sealed) return `writer stopped: ${sealed[1]}${plain(sealed[2]!)}`;
    if (reason.startsWith('dsa rejected')) return `run request rejected${reason.includes(':') ? `: ${plain(reason.slice(reason.indexOf(':') + 1))}` : ''}`;
    if (/^cannot re-(?:launch|send)/.test(reason)) return 'stored run request is unavailable';
    return plain(reason).replace(/\s+to:"[^"]*"/g, '');
  };
  for (const b of v.needsRuling ?? []) add(b.node, `needs a parent ruling: ${b.note}`, `owed decide ${b.node} --writer --text "<decision>"`);
  for (const h of v.halted) {
    if (v.needsRuling?.some(b => b.node === h.node)) continue;
    const command = h.reason.match(/\b(owed [^`;\n]+)/)?.[1]?.trim()
      ?? (h.needs === 'owner' ? ownerCommands(s, h.node)[0] : undefined)
      ?? `owed decide ${h.node} --text "<why>"`;
    add(h.node, `driver halted: ${haltReason(h.reason)}`, command);
  }
  for (const red of trunkParkNotices(s)) needs.push({ node: 'trunk', reason: oneLine(red.text), command: '' });
  for (const red of sharedParkNotices(s)) needs.push({ node: 'trunk', reason: oneLine(red.text), command: '' });
  for (const i of Object.values(v.pending).flat()) {
    if (trunkParked(s, i.subject).length) continue;
    if (i.discharger !== 'owner' && i.discharger !== 'parent') continue;
    if (i.obligation === 'driver-halt' || i.obligation === 'dispatch' || v.needsRuling?.some(b => b.node === i.subject && b.obligation === i.obligation)) continue;
    if (i.obligation === 'approve' && waitingFor(s, i.subject)) continue;
    if (reviewObligation(i.obligation) && repairingBlock(s, i.subject) && !repairNeedsOwner(s, i.subject)) continue;
    const red = i.subject === 'trunk' ? v.trunkRed?.find(r => r.obligation === i.obligation && r.key === i.key) : undefined;
    if (red) {
      if (!needs.some(n => n.node === 'trunk' && n.reason === oneLine(red.text) && n.command === '')) needs.push({ node: 'trunk', reason: oneLine(red.text), command: '' });
      continue;
    }
    const command = i.subject === 'trunk' ? 'owed plan <plan.yaml>' : i.discharger === 'owner'
      ? (reviewObligation(i.obligation) ? decisionCommand(s, i, false) : decisionCommand(s, i, false).split(';')[0]!)
      : `owed why ${i.subject}`;
    const reason = i.obligation === 'approve' ? 'awaiting owner approval'
      : reviewObligation(i.obligation) ? i.mark === '⊤' ? `${i.obligation} needs an owner decision` : i.mark === '⛔' ? `${i.obligation} blocked: guidance needed` : `awaiting ${i.obligation}`
      : i.obligation.startsWith('evidence:') ? `awaiting manual evidence: ${i.obligation.slice(9)}`
      : `${i.obligation}: ${i.subject === 'trunk' && i.mark === '⊤' && i.detail.includes('automatic same-key remeasure:') ? i.detail : plain(i.detail)}`;
    add(i.subject, reason, command);
  }
  if (!driverRunning) for (const id of v.ready) {
    if (v.later?.includes(id) || v.overlaps[id]) continue;
    add(id, 'ready to dispatch', `owed dispatch ${id}`);
  }
  const at = (seq?: number): number => {
    const ts = entries.find(e => e.seq === seq)?.ts;
    return ts && Number.isFinite(Date.parse(ts)) ? Math.max(0, now - Date.parse(ts)) : 0;
  };
  const progress = Object.values(v.nodes).filter(n => !n.merged && !v.later?.includes(n.id) && (n.slot?.open || n.phase === 'blocked' || n.phase === 'held')).map(n => {
    const w = v.waiting?.find(w => w.node === n.id);
    const deps = [...new Set([...(w?.deps ?? []), ...(w?.after?.split(', ') ?? [])])].filter(Boolean);
    const parked = trunkParked(s, n.id);
    const shared = parked.length || v.halted.some(h => h.node === n.id) ? [] : sharedParked(s, n.id);
    let phase = parked.length ? `waiting: trunk-red (${[...new Set(parked.map(r => r.merge.obligation))].join(', ')} on trunk ${s.trunk.commit.slice(0, 12)})` : shared.length ? sharedPhase(s, shared) : deps.length ? `waiting for ${deps.join(', ')}`
      : n.phase === 'held' || v.halted.some(h => h.node === n.id) || v.needsRuling?.some(b => b.node === n.id) || v.reported?.some(r => r.node === n.id) ? 'held'
      : n.accepted ? 'accepted (merge pending)'
      : !n.candidate || n.phase === 'dispatched' || n.items.some(i => i.status === 'D' && i.discharger === 'writer') ? 'writing'
      : n.items.some(i => i.status === 'D' && i.discharger === 'executor') ? 'measuring'
      : n.items.some(i => i.status === 'D' && i.discharger === 'reviewer') ? 'reviewing' : 'held';
    const repair = repairingBlock(s, n.id);
    if (deps.length && s.plan.nodes.find(spec => spec.id === n.id)?.approve === 'owner') phase = `waiting for ${deps.join(', ')} (owner approval after)`;
    else if (repair) phase = `repairing (block #${repair.seq})`;
    if (n.phase === 'blocked' && !deps.length) phase = `waiting for ${(s.plan.nodes.find(x => x.id === n.id)?.deps ?? []).filter(id => !s.nodes[id]?.merged).join(', ')}`;
    return { node: n.id, phase, ageMs: at((n.accepted ? n.acceptedSince : undefined) ?? n.slot?.dispatchSeq ?? n.held ?? entries.findLast(e => e.kind === 'plan' || e.kind === 'genesis')?.seq) };
  });
  for (const spec of s.plan.invariants) {
    const active = ((spec as typeof spec & { known_red?: { test:string; fix:string }[] }).known_red ?? []).filter(r => s.plan.nodes.some(n => n.id === r.fix) && !s.nodes[r.fix]?.merged);
    if (active.length) debt.push(`inv:${spec.id} known red: ${active.map(r => `${oneLine(r.test)} (fix: ${r.fix})`).join(', ')}; plan #${entries.findLast(e => e.kind === 'plan' || e.kind === 'genesis')?.seq ?? 0}`);
  }
  for (const i of v.invariants) if (i.status === 'D' && (i.discharger === 'parent' || i.detail.startsWith('trunk-red:'))) debt.push(`${i.obligation}: ${oneLine(i.detail)}`);
  for (const n of Object.values(v.nodes).filter(n => !n.merged && n.slot?.open)) for (const i of n.items.filter(i => i.status === 'W')) debt.push(`${n.id}/${i.obligation}: waived — ${oneLine(i.detail.replace(/ \((?:flag weak confirmation|delegated)\)$/, ''))}`);
  for (const d of currentDefers) debt.push(deferredText(d));
  for (const q of quarantineDebt(s)) debt.push(quarantineText(q));
  needs.sort((a,b) => (s.nodes[b.node]?.dependents ?? 0) - (s.nodes[a.node]?.dependents ?? 0) || a.node.localeCompare(b.node) || a.command.localeCompare(b.command));
  return { merged: Object.values(v.nodes).filter(n => n.merged).length, needs, progress, debt: [...new Set(debt)] };
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
  if (i.obligation === 'driver-halt') return `${i.mark} halted ${i.subject} — ${i.detail}; ${haltClear(i.subject)}`;
  if (i.status === 'W' && i.subject === 'trunk' && i.obligation.startsWith('inv:')) return `${i.mark} ${i.detail}`;
  if (i.status === 'W') return waivedText(i);
  if (isManual(i.obligation)) return manualText(i);
  const label = i.status === 'E' ? (i.obligation === 'review' || i.obligation === 'closure-review' ? 'reviewed' : i.obligation === 'rulings' ? (i.detail === NO_RULINGS ? 'no rulings apply' : 'rulings acknowledged') : 'measured') : ({ '✘': 'rejected', '⊥': 'awaiting observation', '⊤': 'conflict', '⏸': 'deferred', '⛔': 'blocked' } as Record<string,string>)[i.mark] ?? i.detail;
  const evidence = (i.observations ?? []).map(e => (e.kind === 'obs' ? `#${e.seq}${strength(e)}${noise(e)} log=${e.log ?? '-'} counts=${JSON.stringify(e.counts ?? {})} ${e.durationMs}ms` : e.kind === 'review' ? `${e.by} rank=${e.rank}` : e.kind === 'waive' ? `${e.by}: ${e.reason} (${e.channel}${e.channel === 'flag' ? ' weak confirmation' : ''})` : `#${e.seq}`) + repetition(e)).join('; ');
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
function withBlockNotes(s: State, i: ItemView): ItemView & { blockNotes?: BlockNote[]; hint?: string } {
  const n = s.nodes[i.subject], held = (n?.blocks ?? []).filter(b => b.obligation === i.obligation && countsBlock(b) && i.evidence.includes(b.seq));
  const notes = held.flatMap(b => { const note = blockNote(s, b); return note === undefined ? [] : [{ seq: b.seq, note }]; });
  // 0.8 (L3.2): an item held by a flaky block also offers a ruling, next to the waiver.
  const hint = held.some(b => b.state === 'flaky') ? `owner accepts the risk: ${waiveCommand(i.subject, i.obligation, held.map(b => b.seq), candidateFlag(s, i.subject))}; ${flakyRuleHint(i.subject)}` : undefined;
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
  if (c && e.key !== c.keys[o] && (e.accept_risk ?? []).some(seq => { const x = entriesOf(s).find(x => x.seq === seq); return x?.kind === 'obs' && x.subject === e.node && x.merging === e.node && x.obligation === o && x.key === e.key; })) {
    return `waived ${e.node}/${o} on merge key ${k}: ${e.reason}; accepted risks ${(e.accept_risk ?? []).map(seq => `#${seq}`).join(', ')}; this waiver applies only to that key, not the candidate key ${c.keys[o]?.slice(0,12)}; changes to check definition, setup, exec, closure or reads change the key and require measurement again`;
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
  const effect = item?.status === 'W' && item.evidence.includes(e.seq) ? 'in effect now'
    : !item ? `${o} is not an obligation of the current candidate`
    : item.status === 'E' ? `${o} is currently satisfied, so the waiver is not needed while it stays satisfied`
    : unaccepted.length ? `not in effect yet: active ${unaccepted.length === 1 ? 'block' : 'blocks'} ${unaccepted.map(b => `#${b.seq}`).join(', ')} ${unaccepted.length === 1 ? 'is' : 'are'} not accepted; it takes effect as soon as no unaccepted active block remains on ${o}, for example after ${unaccepted.map(blockClear).join(', and ')}; --accept-risk accepts the current flaky or active blocks at once`
    : `not in effect: ${item.detail}`;
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
const wasFlaky = (s: State, b: Block, before: number): boolean => entriesOf(s).some(x => x.kind === 'obs' && x.attribution && x.verdict === 'pass' && x.subject === b.node && x.obligation === b.obligation && x.key === b.key && x.seq > b.seq && x.seq < before);
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
/** DC4: one decision gives acknowledged guidance and releases the halt; no-resume preserves it. */
export const resumeCommands = (node = '<node>'): string => `owed decide ${node} --text "<decision>" (add --after <node> to wait until that node merges; --no-resume keeps it halted)`;
/**
 * 0.8 (L3.2, app #21): offered wherever owed tells the owner what to do about a flaky block, next to the waiver: when the
 * check or test itself must change, a ruling sends the writer to fix it.
 */
export const flakyRuleHint = (node: string): string => `or owed decide ${node} --writer --text "<what the writer must change>" when the check or test itself must change (the writer fixes it; the block stays flaky until a plan change of the check's definition supersedes it, or the owner waives it once the fixed candidate passes)`;
export const resumeHint = (node = '<node>'): string => `to clear it without an obligation: ${resumeCommands(node)}`;
/** How a driver halt is cleared (SPEC §12, D3), with the resume hint (0.8, L1.5). */
const haltClear = (node: string): string => `cleared by any later action on the node by a principal other than parent:drive (submit, review, rebase, abandon, waive, resume, a ruling naming it), or a new attempt; ${resumeHint(node)}`;
/** 0.8 (L1.5): `waiting for <dep> (resume #<seq>)`. */
export const waitingLine = (w: Waiting): string => [w.deps?.length ? `waiting (deps: ${w.deps.join(', ')})` : '', w.after ? `waiting for ${w.after} (resume #${w.resume})` : ''].filter(Boolean).join('; ');
/** D25.6 (review ruling #559): an owner halt reads `needs the owner (the main agent decides; owed lists the command)`. */
const NEEDS_OWNER_TEXT = 'needs the owner (the main agent decides; owed lists the command)';
const NEEDS_PARENT_TEXT = 'needs the parent (the main agent acts; owed lists the command)';
const haltText = (h: HaltEntry): string => `halted by driver #${h.seq} (attempt ${h.attempt}), ${h.needs === 'owner' ? NEEDS_OWNER_TEXT : NEEDS_PARENT_TEXT}: ${oneLine(h.reason)}`;
const launchText = (l: LaunchEntry): string => `#${l.seq} ${l.role} ${l.rid}`;
/** ` (needs a parent ruling)` / ` (ruled #<seq>)` after a current-candidate needs-parent block (D18.5, D18b.4); empty otherwise. */
const rulingMark = (b: { ruling?: 'needed' | number }): string => b.ruling === undefined ? '' : b.ruling === 'needed' ? ' (needs a parent ruling)' : ` (ruled #${b.ruling})`;
/** Status line of an active needs-parent block without a ruling (D18.5). */
const needsRulingText = (b: Block & { note: string }): string => `⛔ ${b.node}: blocked #${b.seq} ${b.obligation} (needs a parent ruling): ${oneLine(b.note)}; record owed decide ${b.node} --writer --text "<decision>"`;
function runsText(r: AttemptRuns): string[] {
  return [...r.launches.map(l => `Driver launch ${launchText(l)} (spec ${l.spec.slice(0, 12)})`), ...r.sends.map(x => `Driver send #${x.seq} ${x.sendKind} (${x.reason}) to ${x.rid}: ${x.send}`)];
}
const conflictLines = (conflicts: Record<string, string[] | null> | undefined): string[] => Object.entries(conflicts ?? {}).map(([target, paths]) => `conflicts with ${target}: ${paths === null ? 'unknown; retry owed status' : paths.map(oneLine).join(', ') || 'none'}`);
export function renderReceipt(v: ReceiptCard, options: { full?: boolean } = {}): string {
  const history = actHistories.get(v) ?? v.items.flatMap(i => i.observations);
  const runs = actRuns(history,history.filter(e => e.kind === 'rule'));
  const textItem = (i: ReceiptCard['items'][number]) => itemText(textReceiptItem(i,runs));
  const waitingNodes = [...new Set([...(v.waiting?.deps ?? []), ...(v.waiting?.after ? v.waiting.after.split(', ') : [])])];
  return [`${v.node}: ${v.measuring ? measurementText(v.measuring) : phaseNames[v.phase]}`, ...(v.mergeWaiting && !v.measuring ? [mergeWaitingText(v.mergeWaiting, v.accepted ? 'merge' : 'measure')] : []), ...(v.rebasePending ? [rebasePendingText(v.rebasePending)] : []), ...(v.held !== undefined ? [`held by abandon #${v.held}; release with owed decide ${v.node} --text "<decision>"`] : []), ...(v.exec ? [v.exec] : []), ...(v.drive ? [v.drive] : []), ...(v.models ? [v.models] : []), ...(v.modelWarnings ?? []).filter(w => options.full || typeof w === 'string').map(w => `Warning: ${typeof w === 'string' ? w : `${w.message} (acknowledged)`}`), ...(v.reviewCarried ? [v.reviewCarried] : []), ...(v.carried ? [`↻ ${carriedText(v.carried)}`] : []), ...(v.halt ? [`⏸ ${haltText(v.halt)}; ${haltClear(v.node)}`] : []), ...(v.reported !== undefined ? [`reported (resume #${v.reported})`] : []), ...(v.later ? ['backlog (later)'] : []), ...(v.waiting ? [`⏳ ${waitingLine(v.waiting)}; the driver acts again when ${waitingNodes.join(', ')} ${waitingNodes.length > 1 ? 'merge' : 'merges'} or after another resume`] : []), ...(v.runs ? runsText(v.runs) : []), ...v.items.map(textItem), ...(v.mergeChecks?.length ? ['Merge checks:', ...v.mergeChecks.map(textItem)] : []), ...v.blocks.map(b => `⛔ blocked #${b.seq} ${b.obligation}${rulingMark(b)}: ${b.clear}${b.note ? ` — note: ${b.note}` : ''}`), ...(v.superseded ?? []).map(b => `⊘ ${b.text}`), ...(v.outOfWrites ? [outOfWritesText(v.outOfWrites)] : []), ...(v.grantedWrites ?? []).map(grantedWritesText), ...conflictLines(v.conflicts), `Untested changes: ${v.untested.join(', ') || 'none'}`, `Untested obligations ΔO⁻: ${JSON.stringify(v.downgrades)}`, ...v.downgrades.filter(d => d.allowance !== undefined).map(d => `ΔO⁻ #${d.seq} ${allowanceLabel(d)}: ${d.items.map(i => `${i.node}: ${i.what}`).join('; ')}`), ...(options.full ? [`owner flag weak confirmation: ${v.ownerFlags.map(e => `#${e.seq} ${e.kind}`).join(', ') || 'none'}`] : []), ...(v.receipts ?? []).map(receiptText), ...(v.lifts?.length ? [liftsText(v.node, v.lifts)] : []), ...(v.rulingFollowUp ? ['Ruling to forward:', v.rulingFollowUp] : []), ...(v.rebase ? [`Rebased #${v.rebase.seq}: slot base ${v.rebase.from.slice(0, 12)} → ${v.rebase.base.slice(0, 12)}`, ...(v.rebase.previous ? [`Previously reviewed patch: ${v.rebase.previous.base}..${v.rebase.previous.commit} (submit #${v.rebase.previous.submit})`, `Re-review only the resolution: ${v.rebase.rangeDiff}`] : [])] : [])].join('\n');
}
export function renderStatus(v: StatusView, options: { full?: boolean } = {}): string {
  if (options.full) return renderStatusFull(v);
  const summary = v.summary ?? { merged: v.groups.merged?.length ?? 0, needs: [], progress: [], debt: [] };
  return [...summaryHead(v.trunk, v.invariants, summary),
    ...Object.entries(v.conflicts ?? {}).flatMap(([id, conflicts]) => conflictLines(conflicts).map(line => `${id}: ${line}`)),
    ...(summary.progress.length ? [`In progress (${summary.progress.length}):`, ...summary.progress.map(p => `  ${p.node}: ${p.phase} (${age(p.ageMs)})`)] : []),
    ...(summary.debt.length ? ['Debt:', ...summary.debt.map(d => `  ${d}`)] : []),
    'Details: owed status --full · owed why <node>'].join('\n');
}
/** CR1: act replies retain outcome and current actions; the full lists stay in status. */
export function renderStatusBrief(v: StatusView): string {
  const summary = v.summary ?? { merged: v.groups.merged?.length ?? 0, needs: [], progress: [], debt: [] };
  const head = summaryHead(v.trunk, v.invariants, summary);
  return [...(summary.needs.length ? head : head.slice(0, 1)),
    'Details: owed status · owed why <node>'].join('\n');
}
function summaryHead(trunk: StatusView['trunk'], invariants: ItemView[], summary: SummaryView): string[] {
  const ok = invariants.filter(i => i.status !== 'D').length;
  return [`owed: ${summary.merged} merged · ${summary.progress.length} in progress · ${summary.needs.length} need you · trunk ${trunk.name} ${trunk.commit.slice(0, 12)} ${ok === invariants.length ? '✔' : '✘'} invariants (${ok}/${invariants.length})`,
    ...(summary.needs.length ? [`Needs you (${summary.needs.length}):`, ...summary.needs.map(n => `  ${n.node}: ${n.reason}${n.command ? ` → ${n.command}` : ''}`)] : ['Needs you: none'])];
}
/** SQ2: preserve the 0.14 renderer plus trunk invariant-red diagnostics. */
export function renderStatusFull(v: StatusView): string {
  return [`Trunk ${v.trunk.name} ${v.trunk.commit}`, ...Object.entries(v.conflicts ?? {}).flatMap(([id, conflicts]) => conflictLines(conflicts).map(line => `${id}: ${line}`)), ...(v.trunkWorktree ? [trunkWorktreeText(v.trunk.name, v.trunkWorktree)] : []), ...(v.drift ? [`⚠ ${driftText(v.drift)}`] : []), ...(v.genesis ? [genesisLine(v.genesis)] : []), `Ready (by dependent count): ${v.ready.map(id => v.overlaps?.[id] ? `${id} (writes overlap open slot of ${v.overlaps[id]!.join(', ')})` : id).join(', ') || 'none'}`, `Merge queue: ${v.mergeQueue.join(', ') || 'none'}${batchPlanText(v.mergeBatch)}`, ...Object.entries(v.measuring ?? {}).map(([id, m]) => `${id}: ${measurementText(m)}`), ...Object.entries(v.rebasePending ?? {}).map(([id,r]) => `${id}: ${rebasePendingText(r)}`), ...Object.entries(v.mergeWaiting ?? {}).map(([id, w]) => `${id}: ${mergeWaitingText(w)}`), ...Object.entries(v.groups).map(([k,ns]) => `${phaseNames[k]}: ${ns.join(', ')}`), ...(v.held?.length ? v.held.map(h => `${h.node}: held by abandon #${h.abandon}; release with owed resume ${h.node}`) : []), ...(v.later?.length ? [`Backlog (later): ${v.later.join(', ')}`] : []), ...(v.reported?.length ? [`Reported: ${v.reported.map(r => `${r.node}: reported (resume #${r.resume})`).join(', ')}`] : []), ...Object.entries(v.pending).map(([k,is]) => `Pending ${k}:\n${is.map(itemText).join('\n') || 'none'}`), ...(v.halted?.some(h => h.needs !== 'owner') ? ['Halted (driver):', ...v.halted.filter(h => h.needs !== 'owner').map(h => `⏸ ${h.node}: ${haltText(h)}`), `  ${resumeHint()}`] : []), ...(v.waiting?.length ? ['Waiting (resume):', ...v.waiting.map(w => `⏳ ${w.node}: ${waitingLine(w)}`)] : []), ...(v.needsRuling?.length ? ['Blocked (needs a parent ruling):', ...v.needsRuling.map(needsRulingText)] : []), ...(v.carried?.length ? ['Carried candidates (a plan change kept them):', ...v.carried.map(c => `↻ ${c.node}: ${carriedText(c)}`)] : []), ...(v.superseded?.length ? ['Superseded blocks (not active; the plan changed their check):', ...v.superseded.map(b => `⊘ ${b.node}: ${b.text}`)] : []), ...(v.launches && Object.keys(v.launches).length ? ['Driver runs (open attempts):', ...Object.entries(v.launches).flatMap(([id, ls]) => ls.map(l => `${id} attempt ${l.attempt}: ${launchText(l)}`))] : []), 'Trunk invariants:', ...v.invariants.map(i => itemText({ ...i, detail:v.trunkRed?.find(r => r.obligation === i.obligation)?.text ?? i.detail })), ...(v.knownRed?.length ? ['Known-red debt:', ...v.knownRed.map(knownRedText)] : []), ...(v.lapsedKnownRed?.length ? ['Lapsed known-red entries:', ...v.lapsedKnownRed.map(lapsedKnownRedText)] : []), `owner flag weak confirmation: ${v.ownerFlags.map(e => `#${e.seq} ${e.kind}`).join(', ') || 'none'}`].join('\n');
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
    ...list('Merges', v.merges.map(entryLine)),
    ...list('Status changes', v.changes.map(c => `${c.subject}/${c.obligation}: ${c.before ? statusNames[c.before] ?? c.before : 'new'} → ${statusNames[c.after] ?? c.after}`)),
    ...list('Active blocks', v.blocks.map(b => `#${b.seq} ${b.node}/${b.obligation} (${b.kind === 'exec' ? 'execution' : 'review'}, rank ${b.rank}): ${b.clear}`)),
    ...(v.superseded?.length ? list('Superseded blocks (not active; the plan changed their check)', v.superseded.map(b => `${b.node}/${b.obligation} ${b.text}`)) : []),
    ...(v.knownRed?.length ? list('Known-red debt', v.knownRed.map(knownRedText)) : []),
    ...(v.quarantine?.length ? list('Debt (quarantine)', v.quarantine) : []),
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
const obligationFlag = (o: string): string => o === 'closure-review' ? ' --obligation closure-review' : '';
/** G1.3: ` --candidate <commit12>` of the node's open candidate (candidate-bound acts name what they judged), else empty. */
const candidate12 = (s: State, node: string): string | undefined => { const n = s.nodes[node]; return n?.slot?.open && n.candidate ? n.candidate.commit.slice(0, 12) : undefined; };
const candidateFlag = (s: State, node: string): string => { const c = candidate12(s, node); return c ? ` --candidate ${c}` : ''; };
const waiveCommand = (node: string, obligation: string, risks: number[], flag = ''): string => `owed waive ${node} ${obligation} --reason "<why the risk is acceptable>"${risks.length ? ` --accept-risk ${risks.join(',')}` : ''}${flag}`;
/** Hint for a node without an open writer slot: nothing can be cleared on an old candidate, only on a new attempt. */
const dispatchHint = (n: NodeState): string => n.held !== undefined ? `owed decide ${n.id} --text "<decision>" (held by abandon #${n.held})` : n.merged ? `${n.id} is merged; no attempt can clear this` : n.phase === 'removed' ? `${n.id} is not in the current plan; it is never dispatched (add it to the plan to work on it again)` : `owed dispatch ${n.id}${n.phase === 'blocked' ? ' once its dependencies are merged' : ''} (no open attempt; this can only be cleared on a new attempt)`;
/** D23: the command that records manual evidence `id` of `node` as principal `as`; `candidate` (G1.3): the commit (prefix) it names. */
export const evidenceCommand = (node: string, id: string, as: string, candidate?: string): string => `owed evidence ${node} ${id} --file <path> --note "<what was checked>" --as ${as}${candidate ? ` --candidate ${candidate}` : ''}`;
/**
 * D25.6: commands the main agent (the delegated owner) can run, in order, to resolve an owner halt or notification of
 * `node`. With an open candidate: the brief's command for each owner item still owed, a waiver for every other item
 * still owed and every uncleared block, then a new attempt. Without one, every command is executable when its turn
 * comes, as in the brief's clearHint/dispatchHint: a node without an open slot is dispatched first (`owed dispatch`),
 * and a waiver (which needs a candidate) is prefixed `after the writer submits a candidate:`; a merged node has none.
 */
export function ownerCommands(s: State, node: string): string[] {
  const n = s.nodes[node];
  if (!n) return [];
  const blocks = (o: string) => n.blocks.filter(b => b.obligation === o && countsBlock(b)).map(b => b.seq);
  const live = !!(n.slot?.open && n.candidate);
  if (!live && (n.merged || n.phase === 'removed') && !n.slot?.open) return [];
  const items = live ? n.items.filter(i => i.status === 'D') : [];
  const later = live ? '' : 'after the writer submits a candidate: ';
  const out = n.slot?.open ? [] : [n.held !== undefined ? `owed decide ${node} --text "<decision>" (held by abandon #${n.held})` : `owed dispatch ${node}${n.phase === 'blocked' ? ' once its dependencies are merged' : ''}`];
  const flag = candidateFlag(s, node);
  out.push(...items.map(i => i.discharger === 'owner' ? decisionCommand(s, i, false) : waiveCommand(node, i.obligation, blocks(i.obligation), flag)));
  for (const b of n.blocks.filter(b => countsBlock(b) && !items.some(i => i.obligation === b.obligation))) out.push(`${later}${waiveCommand(node, b.obligation, blocks(b.obligation), flag)}`);
  // 0.8 (L3.2): once, after the waivers, when a flaky block is among them.
  if (n.blocks.some(b => b.state === 'flaky')) out.push(flakyRuleHint(node));
  if (n.slot?.open) out.push(`owed abandon ${node} --note "<why>" (then the driver starts a new attempt)`);
  return [...new Set(out)];
}
/**
 * The owner principal a resolving command states where a role must be given (E3.3, ruling #559): the CLI's default
 * owner, `owner:cli`, or `owner:human` under the confirmation gate `OWED_CONFIRM=owner`.
 */
const ownerAs = (): string => process.env.OWED_CONFIRM?.trim() === 'owner' ? 'owner:human' : 'owner:cli';
/** The command that removes an owner-queue item from the owner's queue. */
function decisionCommand(s: State, i: ItemView, flakyHint = true): string {
  if (i.subject === 'trunk') return `owed plan <plan.yaml> (add a node that repairs ${i.obligation}; invariants cannot be waived, only a measured pass on a later merge clears this debt)`;
  const n = s.nodes[i.subject];
  if (n && !n.slot?.open) return dispatchHint(n);
  const flag = candidateFlag(s, i.subject);
  if (i.obligation === 'approve') return `owed approve ${i.subject}${flag} [--note TEXT] (owner)`;
  if (i.obligation.startsWith('evidence:')) return evidenceCommand(i.subject, i.obligation.slice(9), ownerAs(), candidate12(s, i.subject));
  const blocks = s.nodes[i.subject]?.blocks.filter(b => b.obligation === i.obligation && countsBlock(b)) ?? [];
  if (reviewObligation(i.obligation) && blocks.every(b => b.kind === 'judgment' && b.state === 'active')) {
    const review = `owed review ${i.subject}${obligationFlag(i.obligation)} --ok --rank 3 --as ${ownerAs()}${flag}`;
    return blocks.length ? `owed decide ${i.subject} --writer --text "<guidance>"; writer repairs and submits again; override only: ${review} (overrides a valid block: state the accepted risk)` : review;
  }
  // 0.8 (L3.2): a flaky block also offers a ruling (`ownerCommands` adds it once itself).
  return `${waiveCommand(i.subject, i.obligation, blocks.map(b => b.seq), flag)}${flakyHint && blocks.some(b => b.state === 'flaky') ? `; ${flakyRuleHint(i.subject)}` : ''}`;
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
/** FH: retain the normal block remedy and append the same merge-failure diagnostics as the refusal. */
function mergeBlockClearHint(s: State, entries: readonly Entry[], b: Block): string {
  const e = entries.find(x => x.seq === b.seq);
  const hints = e?.kind === 'obs' && e.merging === b.node ? mergeFailureHints(s, b.node, [e]) : [];
  return [clearHint(s, entries, b), ...hints].join('; ');
}
/** TR: parent choices; the failing merge observation is the waiver risk, never the probe. */
export function trunkRedHint(s: State, seq: number, key?: string): string | undefined {
  const r = trunkRedOf(s, seq, key);
  if (!r) return undefined;
  return `${trunkRedText(r)}; merge-tree obs #${r.merge.seq}, trunk probe #${r.probe.seq}; this candidate is not shown to be the cause; parent: fix trunk with a fixing node${s.plan.sweep ? `, or owed sweep --commit ${s.trunk.commit} for its bisect/escape proposal` : ''}; or owed waive ${r.merge.subject} ${r.merge.obligation} --accept-risk ${r.merge.seq}`;
}
/**
 * How to clear a non-cleared block. A judgment block is described in words: printing a
 * ready-to-run review command with `--as` of the original reviewer would invite another
 * principal to impersonate them. Only owner commands (gated by the owner channel) are printed.
 */
function clearHint(s: State, entries: readonly Entry[], b: Block): string {
  const n = s.nodes[b.node];
  const trunkRed = trunkRedHint(s, b.seq, b.key);
  if (trunkRed) return trunkRed;
  if (n && !n.slot?.open) return dispatchHint(n);
  const risks = (n?.blocks ?? []).filter(x => x.obligation === b.obligation && countsBlock(x)).map(x => x.seq);
  const after = n?.candidate ? '' : `after the writer submits a candidate of the current attempt, `, flag = candidateFlag(s, b.node);
  if (b.state === 'flaky') return `${after}owner accepts the risk: ${waiveCommand(b.node, b.obligation, risks, flag)}; ${flakyRuleHint(b.node)}`;
  if (b.kind === 'exec') return `writer fixes and runs owed submit ${b.node}, then owed attest ${b.node} ${SKIP_ATTEST} (the attribution rerun on the original content clears the block)`;
  if (b.obligation === 'approve') return `${after}a later owner approval of the current candidate clears it: owed approve ${b.node}${flag}`;
  const by = entries.find(e => e.seq === b.seq)?.by ?? 'the original reviewer';
  const ruling = !currentNeeds(s, b) ? '' : parentRuling(s, b) ? `the writer repairs with ruling #${parentRuling(s, b)!.seq}; then ` : `a parent records owed decide ${b.node} --writer --text "<decision>" (the reviewer asked for a parent ruling), the writer repairs; then `;
  return `${after}${ruling}an ok review of ${b.node}/${b.obligation} on the current candidate by the original reviewer ${by} with rank >= ${b.rank}, or by any reviewer with rank > ${b.rank}, clears it; or owner: ${waiveCommand(b.node, b.obligation, risks, flag)}`;
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
  const decisions = [...open.flatMap(n => n.items), ...s.invariants].filter(i => i.status === 'D' && i.discharger === 'owner')
    .map(i => ({ node: i.subject, obligation: i.obligation, key: i.key, mark: i.mark, detail: i.detail, blockedDownstream: s.nodes[i.subject]?.dependents ?? 0, command: decisionCommand(s, i) }))
    .sort((a, b) => b.blockedDownstream - a.blockedDownstream || a.node.localeCompare(b.node) || a.obligation.localeCompare(b.obligation));
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
    ...(b.kind === 'exec' ? { failingObs: b.seq } : { reviewer: entries.find(e => e.seq === b.seq)?.by, rank: b.rank }), clear: clearHint(s, entries, b) }));
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
  const deferDebt = (v.summary?.debt ?? []).filter(d => d.includes(': owner defer') || d.startsWith('quarantine '));
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
    ...section('In progress', v.inProgress.map(p => `${p.node} ${p.phase} (attempt ${p.attempt}): dispatched ${age(p.ageMs)} ago${p.submitAgeMs !== undefined ? `, submitted ${age(p.submitAgeMs)} ago` : ''}`)),
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
  const lines = dispatchLines(spec, attempt, worktree, rules);
  if (state) {
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
function dispatchLines(spec: NodeSpec, attempt: number, worktree: string, rules: readonly Rule[]): string[] {
  return [`# ${spec.title ?? spec.id}`, spec.brief ?? '', `Node: ${spec.id}; attempt: ${attempt}`, `Working directory: ${worktree}`, `Allowed writes: ${spec.writes.join(', ')}`, 'Checks run by owed:', ...spec.checks.map(c => `- ${c.id}: ${c.run}\n  red: ${!!c.red}${c.red ? `; tests: ${c.tests?.join(', ')}` : ''}`), 'Applicable rulings:', ...rules.map(r => `- #${r.seq} ${r.text}`), 'commit your work; do not edit files outside writes; owed will run the checks itself', `After committing, run: owed submit ${spec.id}`];
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
  return Math.max(spec.review.count, closure ? 1 : 0);
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
  return [...(k <= spec.review.count ? ['review' as const] : []), ...(k === 1 && st.items.some(i => i.obligation === 'closure-review') ? ['closure-review' as const] : [])];
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
  const rank = (o: 'review' | 'closure-review'): number => o === 'closure-review' ? 2 : Math.max(1, spec.review.min_rank);
  // Active review blocks recorded by this slot's principal (on any earlier candidate of the attempt).
  const entries = entriesOf(s), author = (seq: number) => entries.find(e => e.seq === seq);
  const judged = st.blocks.filter(b => b.kind === 'judgment' && b.state === 'active');
  const blocks = judged.filter(b => author(b.seq)?.by === who), others = judged.filter(b => author(b.seq)?.by !== who && b.rank === 1);
  const slotRank = (o: 'review' | 'closure-review'): number => Math.max(rank(o), ...blocks.filter(b => b.obligation === o).map(b => b.rank ?? 0), ...others.filter(b => b.obligation === o).map(b => (b.rank ?? 0) + 1));
  const required = (o: string): string => o === 'review' ? `${spec.review.count} non-writer review(s) by distinct reviewers, rank >= ${rank('review')}` : o === 'closure-review' ? `1 non-writer review, rank >= 2 (the diff touches the plan closure)` : o === 'rulings' ? `acknowledge applicable rulings${ack ? ` (${ack.trim()})` : ''}` : isManual(o) ? manualRequired(spec, o, who, c12) : 'measured by owed';
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
