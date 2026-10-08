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
    blocks: n.blocks.filter(b => b.state !== 'cleared').map(b => ({ ...b, clear: b.state === 'flaky' ? `owner waive --accept-risk ${b.seq} 明确承担风险` : b.kind === 'exec' ? 'attest 对原始 key/commit/base 归因重跑；再次失败解除封，通过则转为冲突' : `当前义务键上原评审者 rank >= ${b.rank} 或他人 rank > ${b.rank} 的 review ok，或 owner waive --accept-risk ${b.seq}` })),
    untested: (n.candidate?.changed ?? []).filter(p => !checks.some(c => matchesAny(p, c.reads))),
    ownerFlags: entries.filter(e => e.by.startsWith('owner:') && e.channel === 'flag'),
    downgrades: s.downgrades.filter(d => d.items.some(i => i.node === node || i.node === '*')) };
}
export function statusView(s: State, entries: Entry[] = []): StatusView {
  const groups: Record<string, string[]> = {}, pending: Record<string, ItemView[]> = { owner: [], 'parent+writer': [], reviewer: [], executor: [] };
  for (const n of Object.values(s.nodes)) {
    (groups[n.phase] ??= []).push(n.id);
    if (n.phase === 'ready' || n.phase === 'dispatched') pending['parent+writer']!.push({subject:n.id,obligation:n.phase === 'ready' ? 'dispatch' : 'submit',key:'',status:'D',mark:'⊥',discharger:n.phase === 'ready' ? 'parent' : 'writer',evidence:[],detail:n.phase === 'ready' ? 'parent 可派发工作' : 'writer 需要提交候选'});
  }
  for (const i of [...Object.values(s.nodes).filter(n => !n.merged).flatMap(n => n.items), ...s.invariants]) if (i.status === 'D') pending[i.discharger === 'writer' || i.discharger === 'parent' ? 'parent+writer' : i.discharger ?? 'executor']!.push(i);
  return { trunk: s.trunk, nodes: s.nodes, groups, ready: Object.values(s.nodes).filter(n => n.phase === 'ready').sort((a,b) => b.dependents - a.dependents || a.id.localeCompare(b.id)).map(n => n.id), pending, invariants: s.invariants, ownerFlags:entries.filter(e => e.by.startsWith('owner:') && e.channel === 'flag') };
}
const phaseNames: Record<string,string> = { ready: '可派发', blocked: '依赖未完成', dispatched: '已派发', submitted: '待接收', accepted: '已接收', merged: '已合并' };
function itemText(i: ItemView & { observations?: Entry[] }): string {
  const label = i.status === 'W' ? '免' : i.status === 'E' ? (i.obligation === 'review' || i.obligation === 'closure-review' ? '评审' : i.obligation === 'rulings' ? '裁决已确认' : '实测') : ({ '✘': '拒收', '⊥': '待观察', '⊤': '冲突', '⏸': '缓判', '封': '被封' } as Record<string,string>)[i.mark] ?? i.detail;
  const evidence = (i.observations ?? []).map(e => e.kind === 'obs' ? `#${e.seq} log=${e.log ?? '-'} counts=${JSON.stringify(e.counts ?? {})} ${e.durationMs}ms` : e.kind === 'review' ? `${e.by} rank=${e.rank}` : e.kind === 'waive' ? `${e.by}: ${e.reason} (${e.channel}${e.channel === 'flag' ? ' 弱确认' : ''})` : `#${e.seq}`).join('; ');
  return `${i.mark} ${label} ${i.subject}/${i.obligation} — ${i.detail}${evidence ? ` [${evidence}]` : ''}`;
}
export function renderReceipt(v: ReceiptCard): string {
  return [`${v.node}：${phaseNames[v.phase]}`, ...v.items.map(itemText), ...v.blocks.map(b => `封 #${b.seq} ${b.obligation}：${b.clear}`), `未测改动：${v.untested.join('、') || '无'}`, `未测义务 ΔO⁻：${JSON.stringify(v.downgrades)}`, `owner flag 弱确认：${v.ownerFlags.map(e => `#${e.seq} ${e.kind}`).join('、') || '无'}`].join('\n');
}
export function renderStatus(v: StatusView): string {
  return [`主干 ${v.trunk.name} ${v.trunk.commit}`, `可派发（按依赖者数）：${v.ready.join('、') || '无'}`, ...Object.entries(v.groups).map(([k,ns]) => `${phaseNames[k]}：${ns.join('、')}`), ...Object.entries(v.pending).map(([k,is]) => `待办 ${k}：\n${is.map(itemText).join('\n') || '无'}`), '主干不变量：', ...v.invariants.map(itemText), `owner flag 弱确认：${v.ownerFlags.map(e => `#${e.seq} ${e.kind}`).join('、') || '无'}`].join('\n');
}
export function renderReport(v: Report): string {
  return [`报告 since=${v.since}`, `合并：${v.merges.map(e => e.kind === 'merge' ? `${e.node} ${e.commit}` : '').join('、') || '无'}`, `E/W/D 变化：${JSON.stringify(v.changes)}`, `封：${JSON.stringify(v.blocks)}`, `免：${JSON.stringify(v.waivers)}`, `降级 ΔO⁻：${JSON.stringify(v.downgrades)}`, `裁决：${JSON.stringify(v.rulings)}`, `owner 决策：\n${v.decisions.map(itemText).join('\n') || '无'}`, `owner 操作（flag 为弱确认）：${JSON.stringify(v.ownerActions)}`].join('\n');
}
