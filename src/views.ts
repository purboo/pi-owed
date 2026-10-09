import type { Block, Entry, ItemView, NodeState, State } from './types.ts';
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
function itemText(i: ItemView & { observations?: Entry[] }): string {
  const label = i.status === 'W' ? 'waived' : i.status === 'E' ? (i.obligation === 'review' || i.obligation === 'closure-review' ? 'reviewed' : i.obligation === 'rulings' ? 'rulings acknowledged' : 'measured') : ({ '✘': 'rejected', '⊥': 'awaiting observation', '⊤': 'conflict', '⏸': 'deferred', '⛔': 'blocked' } as Record<string,string>)[i.mark] ?? i.detail;
  const evidence = (i.observations ?? []).map(e => e.kind === 'obs' ? `#${e.seq} log=${e.log ?? '-'} counts=${JSON.stringify(e.counts ?? {})} ${e.durationMs}ms` : e.kind === 'review' ? `${e.by} rank=${e.rank}` : e.kind === 'waive' ? `${e.by}: ${e.reason} (${e.channel}${e.channel === 'flag' ? ' weak confirmation' : ''})` : `#${e.seq}`).join('; ');
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
    ...list('Owner actions', v.ownerActions.map(entryLine))].join('\n');
}
