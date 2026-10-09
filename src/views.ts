import type { Block, Entry, EscapeClass, ItemView, NodeState, State } from './types.ts';
import { matchesAny } from './plan.ts';

export interface ReceiptCard {
  node: string; phase: NodeState['phase']; accepted: boolean;
  items: (ItemView & { observations: Entry[] })[];
  blocks: (Block & { clear: string })[];
  untested: string[]; downgrades: State['downgrades']; ownerFlags: Entry[];
}
export interface StatusView {
  trunk: State['trunk']; nodes: Record<string, NodeState>; groups: Record<string, string[]>;
  ready: string[]; pending: Record<string, ItemView[]>; invariants: ItemView[]; ownerFlags: Entry[];
}
export interface Report {
  since: number | string; merges: Entry[]; blocks: ReceiptCard['blocks']; waivers: Entry[];
  downgrades: State['downgrades']; rulings: State['rules']; decisions: ItemView[];
  changes: { subject: string; obligation: string; before?: string; after: string }[];
  ownerActions: Entry[];
  escapes: EscapeSummary;
}
export function receipt(s: State, entries: Entry[], node: string): ReceiptCard {
  const n = s.nodes[node]!;
  const checks = (s.plan.nodes.find(x => x.id === node)?.checks ?? []).filter(c => n.items.some(i => i.obligation === `check:${c.id}` && i.status === 'E'));
  return { node, phase: n.phase, accepted: n.accepted,
    items: n.items.map(i => ({ ...i, observations: entries.filter(e => i.evidence.includes(e.seq)) })),
    blocks: n.blocks.filter(b => b.state !== 'cleared').map(b => ({ ...b, clear: b.state === 'flaky' ? `owner waive --accept-risk ${b.seq} explicitly accept the risk` : b.kind === 'exec' ? 'attest reruns attribution on the original key/commit/base; another failure clears the block, a pass creates a conflict' : `review ok on the current obligation key by the original reviewer with rank >= ${b.rank} or another reviewer with rank > ${b.rank}, or owner waive --accept-risk ${b.seq}` })),
    untested: (n.candidate?.changed ?? []).filter(p => !checks.some(c => matchesAny(p, c.reads))),
    ownerFlags: entries.filter(e => e.by.startsWith('owner:') && e.channel === 'flag'),
    downgrades: s.downgrades.filter(d => d.items.some(i => i.node === node || i.node === '*')) };
}
export function statusView(s: State, entries: Entry[] = []): StatusView {
  const groups: Record<string, string[]> = {}, pending: Record<string, ItemView[]> = { owner: [], 'parent+writer': [], reviewer: [], executor: [] };
  for (const n of Object.values(s.nodes)) {
    (groups[n.phase] ??= []).push(n.id);
    if (n.phase === 'ready' || n.phase === 'dispatched') pending['parent+writer']!.push({subject:n.id,obligation:n.phase === 'ready' ? 'dispatch' : 'submit',key:'',status:'D',mark:'⊥',discharger:n.phase === 'ready' ? 'parent' : 'writer',evidence:[],detail:n.phase === 'ready' ? 'parent can dispatch work' : 'writer must submit a candidate'});
  }
  for (const i of [...Object.values(s.nodes).filter(n => !n.merged).flatMap(n => n.items), ...s.invariants]) if (i.status === 'D') pending[i.discharger === 'writer' || i.discharger === 'parent' ? 'parent+writer' : i.discharger ?? 'executor']!.push(i);
  return { trunk: s.trunk, nodes: s.nodes, groups, ready: Object.values(s.nodes).filter(n => n.phase === 'ready').sort((a,b) => b.dependents - a.dependents || a.id.localeCompare(b.id)).map(n => n.id), pending, invariants: s.invariants, ownerFlags:entries.filter(e => e.by.startsWith('owner:') && e.channel === 'flag') };
}
const phaseNames: Record<string,string> = { ready: 'ready', blocked: 'blocked by dependencies', dispatched: 'dispatched', submitted: 'submitted', accepted: 'accepted', merged: 'merged' };
const strength = (e: Entry): string => e.kind === 'obs' && e.obligation.startsWith('strength:') && e.counts ? ` strength ${e.counts.pass ?? 0}/${e.counts.tests ?? 0}` : '';
function itemText(i: ItemView & { observations?: Entry[] }): string {
  const label = i.status === 'W' ? 'waived' : i.status === 'E' ? (i.obligation === 'review' || i.obligation === 'closure-review' ? 'reviewed' : i.obligation === 'rulings' ? 'rulings acknowledged' : 'measured') : ({ '✘': 'rejected', '⊥': 'awaiting observation', '⊤': 'conflict', '⏸': 'deferred', '⛔': 'blocked' } as Record<string,string>)[i.mark] ?? i.detail;
  const evidence = (i.observations ?? []).map(e => e.kind === 'obs' ? `#${e.seq}${strength(e)} log=${e.log ?? '-'} counts=${JSON.stringify(e.counts ?? {})} ${e.durationMs}ms` : e.kind === 'review' ? `${e.by} rank=${e.rank}` : e.kind === 'waive' ? `${e.by}: ${e.reason} (${e.channel}${e.channel === 'flag' ? ' weak confirmation' : ''})` : `#${e.seq}`).join('; ');
  return `${i.mark} ${label} ${i.subject}/${i.obligation} — ${i.detail}${evidence ? ` [${evidence}]` : ''}`;
}
export function renderReceipt(v: ReceiptCard): string {
  return [`${v.node}: ${phaseNames[v.phase]}`, ...v.items.map(itemText), ...v.blocks.map(b => `⛔ blocked #${b.seq} ${b.obligation}: ${b.clear}`), `Untested changes: ${v.untested.join(', ') || 'none'}`, `Untested obligations ΔO⁻: ${JSON.stringify(v.downgrades)}`, `owner flag weak confirmation: ${v.ownerFlags.map(e => `#${e.seq} ${e.kind}`).join(', ') || 'none'}`].join('\n');
}
export function renderStatus(v: StatusView): string {
  return [`Trunk ${v.trunk.name} ${v.trunk.commit}`, `Ready (by dependent count): ${v.ready.join(', ') || 'none'}`, ...Object.entries(v.groups).map(([k,ns]) => `${phaseNames[k]}: ${ns.join(', ')}`), ...Object.entries(v.pending).map(([k,is]) => `Pending ${k}:\n${is.map(itemText).join('\n') || 'none'}`), 'Trunk invariants:', ...v.invariants.map(itemText), `owner flag weak confirmation: ${v.ownerFlags.map(e => `#${e.seq} ${e.kind}`).join(', ') || 'none'}`].join('\n');
}
const statusNames: Record<string,string> = { E: 'evidenced', W: 'waived', D: 'owed' };
function entryLine(e: Entry): string {
  const head = `#${e.seq} ${e.by}${e.channel === 'flag' ? ' (flag weak confirmation)' : ''}`;
  switch (e.kind) {
    case 'merge': return `${head} merged ${e.node} → ${e.commit.slice(0, 12)}`;
    case 'waive': return `${head} waived ${e.node}/${e.obligation}: ${e.reason}${e.accept_risk?.length ? ` (accepted block risk ${e.accept_risk.map(x => `#${x}`).join(', ')})` : ''}`;
    case 'defer': return `${head} deferred ${e.node} post-merge invariants ${e.items.map(i => i.id).join(', ')}: ${e.reason}`;
    case 'genesis': return `${head} initialized ledger, trunk ${e.trunk} ${e.commit.slice(0, 12)}`;
    case 'plan': return `${head} updated plan${e.downgrades.length ? `, downgrades ${e.downgrades.map(d => `${d.node}: ${d.what}`).join('; ')}` : ''}`;
    case 'rule': return `${head} ruling (${e.nodes === '*' ? 'all nodes' : e.nodes.join(', ')}): ${e.text}`;
    case 'review': return `${head} reviewed ${e.node}/${e.obligation ?? 'review'} ${e.verdict} rank=${e.rank}${e.note ? `: ${e.note}` : ''}`;
    case 'escape': return `${head} recorded escape ${e.node} (merge #${e.merge}, ${e.class} ${escapeLabels[e.class]}): ${e.note}${e.evidence ? ` [${e.evidence}]` : ''}`;
    case 'decoy-commit': return `${head} committed decoys ${e.digest.slice(0, 12)}`;
    case 'decoy-reveal': return `${head} revealed decoys ${e.decoys.map(d => d.node).join(', ')}`;
    default: return `${head} ${e.kind}`;
  }
}
export function renderEntry(e: Entry): string { return `Recorded ${entryLine(e)}`; }
export function renderReport(v: Report): string {
  const list = (title: string, lines: string[]) => [`${title}${lines.length ? '' : ': none'}`, ...lines.map(l => `  ${l}`)];
  return [`Report (since ${v.since === -1 ? 'start' : v.since})`,
    ...list('Merges', v.merges.map(entryLine)),
    ...list('Status changes', v.changes.map(c => `${c.subject}/${c.obligation}: ${c.before ? statusNames[c.before] ?? c.before : 'new'} → ${statusNames[c.after] ?? c.after}`)),
    ...list('Active blocks', v.blocks.map(b => `#${b.seq} ${b.node}/${b.obligation} (${b.kind === 'exec' ? 'execution' : 'review'}, rank ${b.rank}): ${b.clear}`)),
    ...list('Waivers', v.waivers.map(entryLine)),
    ...list('Downgrades ΔO⁻', v.downgrades.flatMap(d => d.items.map(i => `#${d.seq} ${d.by} ${i.node}: ${i.what}`))),
    ...list('Rulings', v.rulings.map(r => `#${r.seq} ${r.by} (${r.nodes === '*' ? 'all nodes' : r.nodes.join(', ')}): ${r.text}`)),
    ...list('Owner decisions needed', v.decisions.map(itemText)),
    ...list('Owner actions', v.ownerActions.map(entryLine)),
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
}
export interface BriefBlock { seq: number; node: string; obligation: string; kind: Block['kind']; state: Block['state']; failingObs?: number; reviewer?: string; rank?: number; clear: string }
export interface BriefProgress { node: string; phase: 'dispatched' | 'submitted'; attempt: number; dispatchSeq: number; dispatchedAt: string; ageMs: number; submitSeq?: number; submittedAt?: string; submitAgeMs?: number }
export interface Brief {
  since: number | string; now: string;
  decisions: BriefDecision[]; merged: BriefMerged[]; rejected: BriefBlock[]; inProgress: BriefProgress[];
  totals: { merged: number; acceptedUnmerged: number; blocked: number; ready: number; waiting: number };
}
const reviewObligation = (o: string): boolean => o === 'review' || o === 'closure-review';
const obligationFlag = (o: string): string => o === 'closure-review' ? ' --obligation closure-review' : '';
const waiveCommand = (node: string, obligation: string, risks: number[]): string => `owed waive ${node} ${obligation} --reason "<why the risk is acceptable>"${risks.length ? ` --accept-risk ${risks.join(',')}` : ''}`;
/** The command that removes an owner-queue item from the owner's queue. */
function decisionCommand(s: State, i: ItemView): string {
  if (i.subject === 'trunk') return `owed plan <plan.yaml> (add a node that repairs ${i.obligation}; invariants cannot be waived, only a measured pass on a later merge clears this debt)`;
  const blocks = s.nodes[i.subject]?.blocks.filter(b => b.obligation === i.obligation && b.state !== 'cleared') ?? [];
  if (reviewObligation(i.obligation) && blocks.every(b => b.kind === 'judgment' && b.state === 'active')) return `owed review ${i.subject}${obligationFlag(i.obligation)} --ok --rank 3 --as owner:human`;
  return waiveCommand(i.subject, i.obligation, blocks.map(b => b.seq));
}
function clearCommand(s: State, entries: Entry[], b: Block): string {
  const risks = (s.nodes[b.node]?.blocks ?? []).filter(x => x.obligation === b.obligation && x.state !== 'cleared').map(x => x.seq);
  if (b.state === 'flaky') return `owner accepts the risk: ${waiveCommand(b.node, b.obligation, risks)}`;
  if (b.kind === 'exec') return `writer fixes and runs owed submit ${b.node}, then owed attest ${b.node} (the attribution rerun on the original content clears the block)`;
  const by = entries.find(e => e.seq === b.seq)?.by ?? 'reviewer:<original>';
  return `owed review ${b.node}${obligationFlag(b.obligation)} --ok --rank ${b.rank} --as ${by} (or a reviewer with rank > ${b.rank}), or owner: ${waiveCommand(b.node, b.obligation, risks)}`;
}
/** Pure morning brief over a reduced state. `since` limits the Merged section; the other sections show current state. */
export function briefView(s: State, entries: Entry[], since: number | string = -1, now: number = Date.now()): Brief {
  const included = (e: Entry): boolean => typeof since === 'number' ? e.seq > since : Date.parse(e.ts) > Date.parse(since);
  const ts = (seq: number): string => entries.find(e => e.seq === seq)?.ts ?? '';
  const nodes = Object.values(s.nodes), open = nodes.filter(n => !n.merged);
  const decisions = [...open.flatMap(n => n.items), ...s.invariants].filter(i => i.status === 'D' && i.discharger === 'owner')
    .map(i => ({ node: i.subject, obligation: i.obligation, key: i.key, mark: i.mark, detail: i.detail, blockedDownstream: s.nodes[i.subject]?.dependents ?? 0, command: decisionCommand(s, i) }))
    .sort((a, b) => b.blockedDownstream - a.blockedDownstream || a.node.localeCompare(b.node) || a.obligation.localeCompare(b.obligation));
  const merged = entries.filter((e): e is Extract<Entry, { kind: 'merge' }> => e.kind === 'merge' && included(e) && !!s.nodes[e.node]).map(e => {
    const card = receipt(s, entries, e.node);
    const measuredItems = card.items.filter(i => i.status === 'E' && !reviewObligation(i.obligation) && i.obligation !== 'rulings').map(i => i.obligation);
    const waivedItems = card.items.filter(i => i.status === 'W').map(i => i.obligation);
    const reviewers = [...new Set(card.items.filter(i => i.status === 'E' && reviewObligation(i.obligation)).flatMap(i => i.observations.flatMap(o => o.kind === 'review' && o.verdict === 'ok' ? [o.by] : [])))];
    return { node: e.node, seq: e.seq, ts: e.ts, commit: e.commit, measured: measuredItems.length, waived: waivedItems.length,
      reviewed: card.items.filter(i => i.status === 'E' && reviewObligation(i.obligation)).length,
      deferred: s.deferred.filter(d => d.node === e.node).length, untested: card.untested.length,
      measuredItems, waivedItems, untestedChanges: card.untested, reviewers };
  });
  const rejected = open.flatMap(n => n.blocks.filter(b => b.state !== 'cleared')).map(b => ({ seq: b.seq, node: b.node, obligation: b.obligation, kind: b.kind, state: b.state,
    ...(b.kind === 'exec' ? { failingObs: b.seq } : { reviewer: entries.find(e => e.seq === b.seq)?.by, rank: b.rank }), clear: clearCommand(s, entries, b) }));
  const inProgress = nodes.filter(n => (n.phase === 'dispatched' || n.phase === 'submitted') && n.slot).map(n => {
    const at = ts(n.slot!.dispatchSeq), sub = n.phase === 'submitted' && n.candidate ? ts(n.candidate.seq) : undefined;
    return { node: n.id, phase: n.phase as BriefProgress['phase'], attempt: n.slot!.attempt, dispatchSeq: n.slot!.dispatchSeq, dispatchedAt: at, ageMs: Math.max(0, now - Date.parse(at)),
      ...(sub !== undefined ? { submitSeq: n.candidate!.seq, submittedAt: sub, submitAgeMs: Math.max(0, now - Date.parse(sub)) } : {}) };
  });
  const count = (phase: NodeState['phase']): number => nodes.filter(n => n.phase === phase).length;
  return { since, now: new Date(now).toISOString(), decisions, merged, rejected, inProgress,
    totals: { merged: count('merged'), acceptedUnmerged: count('accepted'), blocked: new Set(rejected.map(b => b.node)).size, ready: count('ready'), waiting: count('blocked') } };
}
function age(ms: number): string {
  const m = Math.floor(ms / 60_000), h = Math.floor(m / 60), d = Math.floor(h / 24);
  return d ? `${d}d${h % 24}h` : h ? `${h}h${m % 60}m` : m ? `${m}m` : `${Math.floor(ms / 1000)}s`;
}
export function renderBrief(v: Brief): string {
  const section = (title: string, lines: string[]) => [`${title}${lines.length ? ` (${lines.length}):` : ': none'}`, ...lines.map(l => `  ${l}`)];
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  return [`Brief (since ${v.since === -1 ? 'start' : typeof v.since === 'number' ? `#${v.since}` : v.since})`,
    ...section('Needs your decision', v.decisions.map(d => `${d.node}/${d.obligation} [${d.blockedDownstream} blocked downstream] ${d.mark} ${d.detail} → ${d.command}`)),
    ...section('Merged', v.merged.map(m => `${m.node} #${m.seq} → ${m.commit.slice(0, 12)}: ${m.measured} measured, ${m.waived} waived${m.waivedItems.length ? ` (${m.waivedItems.join(', ')})` : ''}, ${m.reviewed} reviewed${m.deferred ? `, ${plural(m.deferred, 'deferred invariant')}` : ''}, ${plural(m.untested, 'untested change')}; reviewers: ${m.reviewers.join(', ') || 'none'}`)),
    ...section('Rejected or blocked', v.rejected.map(b => `${b.node}/${b.obligation} ${b.kind === 'exec' ? `failing obs #${b.failingObs}` : `review block #${b.seq} by ${b.reviewer ?? '?'} rank ${b.rank}`}${b.state === 'flaky' ? ' (flaky: a rerun passed)' : ''} → ${b.clear}`)),
    ...section('In progress', v.inProgress.map(p => `${p.node} ${p.phase} (attempt ${p.attempt}): dispatched ${age(p.ageMs)} ago${p.submitAgeMs !== undefined ? `, submitted ${age(p.submitAgeMs)} ago` : ''}`)),
    `Total: ${v.totals.merged} merged, ${v.totals.acceptedUnmerged} accepted-unmerged, ${v.totals.blocked} blocked, ${v.totals.ready} ready, ${v.totals.waiting} waiting on dependencies`].join('\n');
}
