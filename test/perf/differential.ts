// N4: differential comparison of the replay against the frozen 0.10 reducer and views (test/fixtures/*-0.10-base.ts).
// `snapshot` renders a state and every pure query the views and ops use into canonical JSON; equal snapshots of the
// base and the new reducer on the same entries are the equivalence N4.1 requires.
import { canonical, H } from '../../src/canon.ts';
import { entryHash } from '../../src/ledger.ts';
import * as cur from '../../src/reducer.ts';
import * as curViews from '../../src/views.ts';
import * as curNeeds from '../../src/needs.ts';
import * as base from '../fixtures/reducer-0.10-base.ts';
import * as baseViews from '../fixtures/views-0.10-base.ts';
import type { Block, CandidateFacts, Draft, Entry, ItemView, NodeSpec, Plan, State } from '../../src/types.ts';

type R = typeof base; type V = typeof baseViews;
export const BASE = { r: base as R, v: baseViews as V };
export const CUR = { r: cur as unknown as R, v: curViews as unknown as V };

/** A deep-frozen copy of a plan lookup's plans, as ops' plan cache hands them to the reducer. */
export function frozen(lookup: (sha: string) => Plan): (sha: string) => Plan {
  const m = new Map<string, Plan>();
  const freeze = <T>(v: T): T => { if (v && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const x of Object.values(v)) freeze(x); } return v; };
  return sha => { let p = m.get(sha); if (!p) { p = freeze(structuredClone(lookup(sha))); m.set(sha, p); } return p; };
}
const attempt = <T>(f: () => T): unknown => { try { return f(); } catch (e) { return `throws: ${e instanceof Error ? e.message : String(e)}`; } };

/** RR1 adapter for the frozen baseline's policy queries only; replay state/keys are never normalized. */
function reviewEpochView(s: State, entries: Entry[], id: string): State {
  const n = s.nodes[id]!, c = n.candidate, slot = n.slot;
  if (!slot?.open || !c) return s;
  const keys = (facts: CandidateFacts, spec?: NodeSpec) => [
    (spec?.review.count ?? 0) > 0 ? facts.keys.review : undefined,
    facts.closureTouched ? facts.keys['closure-review'] : undefined,
  ];
  const current = keys(c, s.plan.nodes.find(n => n.id === id));
  let first = c.seq;
  for (const e of entries.filter(e => e.seq < c.seq).reverse()) {
    if (e.kind !== 'submit' || e.node !== id || e.attempt !== slot.attempt) continue;
    const prior = keys(e.facts, BASE.r.planAt(s, e.seq).nodes.find(n => n.id === id));
    if (canonical(prior) !== canonical(current)) break;
    first = e.seq;
  }
  // Only the baseline launch ordering used by reviewerBase/reviewPacket changes. Candidate seq/text stays current.
  const runs = n.runs.map(ar => ar.attempt !== slot.attempt ? ar : { ...ar,
    launches: ar.launches.map(l => l.role === 'reviewer' && l.seq > first ? { ...l, seq: c.seq + 1 } : l),
  });
  // Preserve the frozen reducer's non-enumerable replay metadata for its packet's entriesOf/applicableRules queries.
  const view = Object.create(Object.getPrototypeOf(s), Object.getOwnPropertyDescriptors(s)) as State;
  view.nodes = { ...s.nodes, [id]: { ...n, runs } };
  return view;
}

/** WF1/WF2: adapt only specified item diagnostics; all keys, evidence, votes and block states remain exact. */
function wfItem(s: State, i: ItemView): ItemView {
  let n = s.nodes[i.subject];
  if (n?.phase === 'removed') {
    // Removal leaves the item's last live diagnostic in place; later obs change blocks, not removed-node items.
    const es = [...BASE.r.entriesOf(s)];
    const removal = es.findLast(e => e.kind === 'plan' && BASE.r.planAt(s,e.seq).nodes.some(n => n.id === i.subject) && !BASE.r.planAt(s,e.seq+1).nodes.some(n => n.id === i.subject));
    if (removal) {
      const plans = new Map(es.filter(e => e.kind === 'genesis' || e.kind === 'plan').map(e => [e.kind === 'genesis' || e.kind === 'plan' ? e.plan : '', BASE.r.planAt(s,e.seq+1)]));
      s = BASE.r.reduce(es.filter(e => e.seq < removal.seq),sha => plans.get(sha)!);
      n = s.nodes[i.subject];
    }
  }
  const blocks = n?.blocks.filter(b => b.obligation === i.obligation && (b.state === 'active' || b.state === 'flaky')) ?? [];
  if (!blocks.some(b => b.state === 'flaky') || i.status !== 'D' || !i.detail.startsWith(`${i.obligation} still blocked:`)) return i;
  const actionable = blocks.filter(b => !wfHeld(s,b));
  const failed = BASE.r.observationsOf(s,i.subject,i.obligation,i.key).some(e => e.verdict === 'fail');
  return {...i, discharger:i.mark === '⊤' || actionable.some(b => b.state === 'flaky' || b.kind === 'judgment' && (b.rank ?? 0) >= 2) ? 'owner' : actionable.some(b => b.kind === 'judgment') ? 'reviewer' : failed ? 'writer' : 'executor',
    detail:actionable.length ? `${i.obligation} still blocked: ${actionable.map(b => b.state === 'flaky' && b.kind === 'exec' ? wfBlockText(s,b) : `#${b.seq}`).join(', ')}` : blocks.map(b => wfHeldText(s,b)).join('; ')};
}
function wfHeld(s: State, b: Block): boolean {
  const n = s.nodes[b.node], f = BASE.r.entriesOf(s).find(e => e.seq === b.seq), key = n?.candidate?.keys[b.obligation];
  return b.state === 'flaky' && !!n?.candidate && b.key !== key && f?.kind === 'obs' && f.merging === undefined && !BASE.r.observationsOf(s,b.node,b.obligation,key ?? '').some(e => e.verdict === 'pass' && e.probe === undefined && e.batch === undefined);
}
function wfHeldText(s: State, b: Block): string { return `waiting for ${b.obligation} on candidate ${s.nodes[b.node]?.candidate?.commit.slice(0,12)} before deciding flaky #${b.seq}`; }
function wfBlockText(s: State, b: Block): string {
  const entries = BASE.r.entriesOf(s), f = entries.find(e => e.seq === b.seq), p = entries.find(e => e.kind === 'obs' && e.attribution && e.verdict === 'pass' && e.subject === b.node && e.obligation === b.obligation && e.key === b.key && e.seq > b.seq), c = s.nodes[b.node]?.candidate;
  if (f?.kind !== 'obs' || !p) return `flaky block #${b.seq} on ${b.obligation}`;
  const names = f.failed ?? f.counts?.failed ?? [];
  let text = `flaky block #${b.seq} on ${b.obligation}${f.merging !== undefined ? ` (merge key ${b.key.slice(0,12)})` : ''}: ${f.commit.slice(0,12)} failed #${f.seq} (${names.slice(0,3).join(', ') || 'unknown failed tests'}${names.length > 3 ? `, +${names.length-3}` : ''}) → passed #${p.seq} on the same key; a pass does not erase a failure: accept the risk (owed waive ${b.node} ${b.obligation} --accept-risk ${b.seq} --reason "…") or fix it`;
  if (f.merging === undefined && c && b.key !== c.keys[b.obligation]) {
    const last = BASE.r.observationsOf(s,b.node,b.obligation,c.keys[b.obligation] ?? '').findLast(e => e.verdict !== 'error' && e.probe === undefined && e.batch === undefined), block = s.nodes[b.node]?.blocks.findLast(x => x.kind === 'exec' && (x.state === 'active' || x.state === 'flaky') && x.obligation === b.obligation && x.key === c.keys[b.obligation]);
    text += `; current candidate ${c.commit.slice(0,12)} ${last ? `${last.verdict === 'pass' ? 'passed' : 'failed'} #${last.seq}${last.verdict === 'fail' && block ? ` (block #${block.seq})` : ''}` : 'not measured yet'}`;
  }
  return text.replace(/[\\\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g,c => c === '\\' ? '\\\\' : `\\u${c.charCodeAt(0).toString(16).padStart(4,'0')}`);
}
function wfReasons(s: State, text: string): string {
  for (const n of Object.values(s.nodes)) for (const i of n.items) {
    const blocks = n.blocks.filter(b => b.obligation === i.obligation && (b.state === 'active' || b.state === 'flaky'));
    if (!blocks.some(b => b.state === 'flaky')) continue;
    const old = `${i.obligation} still blocked: ${blocks.map(b => `#${b.seq}${b.state === 'flaky' ? ' flaky' : ''}`).join(', ')}`;
    text = text.replaceAll(old,wfItem(s,i).detail);
  }
  return text;
}
function wfRendered(s: State, text: string): string {
  for (const n of Object.values(s.nodes)) {
    const card = BASE.v.receipt(s,[...BASE.r.entriesOf(s)],n.id);
    for (const b of card.blocks) if (b.kind === 'exec' && b.state === 'flaky') {
      const next = wfHeld(s,b) ? wfHeldText(s,b) : `${wfBlockText(s,b)}; ${baseViews.flakyRuleHint(n.id)}`;
      text = text.replaceAll(`blocked #${b.seq} ${b.obligation}: ${b.clear}`,`blocked #${b.seq} ${b.obligation}: ${next}`)
        .replaceAll(`failing obs #${b.seq} → ${b.clear}`,`failing obs #${b.seq} → ${next}`)
        .replaceAll(`failing obs #${b.seq} (flaky: a rerun passed) → ${b.clear}`,`failing obs #${b.seq} (flaky: a rerun passed) → ${next}`);
    }
  }
  return text;
}
function wfItems(s: State, value: unknown): unknown {
  if (typeof value === 'string') return wfReasons(s,value);
  if (Array.isArray(value)) return value.map(v => wfItems(s,v));
  if (value && typeof value === 'object') {
    if ('subject' in value && 'obligation' in value && 'status' in value && 'evidence' in value) return wfItem(s,value as ItemView);
    return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,wfItems(s,v)]));
  }
  return value;
}
/** Adapt the frozen state's presentation fields, preserving its non-enumerable history. */
function wfState(s: State): State {
  const out = Object.create(Object.getPrototypeOf(s),Object.getOwnPropertyDescriptors(s)) as State;
  out.nodes = Object.fromEntries(Object.entries(s.nodes).map(([id,n]) => [id,{...n,items:n.items.map(i => wfItem(s,i))}]));
  return out;
}

/** R-028-45/51, VW1–2: add only BASE's missing sections at exact frozen anchors. */
function vwStatus(text: string, frozen: ReturnType<V['statusView']>, current: curViews.StatusView): string {
  const rendered = curViews.renderStatusFull(current).replace(/^Merge queue:.*\n/gm, '');
  if (current.summary?.needs.length) {
    const section = curViews.renderStatusBrief(current).split('\n').slice(1, 2 + current.summary.needs.length).join('\n');
    // VW1: 0.10 has no Needs-you section; its exact Trunk line is the insertion anchor.
    const anchor = `Trunk ${frozen.trunk.name} ${frozen.trunk.commit}`;
    if (rendered.includes(`${anchor}\n${section}\n`)) text = text.replace(`${anchor}\n`, `${anchor}\n${section}\n`);
  }
  if (current.summary?.progress.length) {
    const section = ['In progress:', ...current.summary.progress.map(p => `${p.node}: ${p.phase}`)].join('\n');
    // N4: progress follows phase groups and precedes the first pending section in the frozen renderer.
    const anchor = `Pending ${Object.keys(frozen.pending)[0]}:`;
    if (rendered.includes(`${section}\n${anchor}\n`)) text = text.replace(`${anchor}\n`, `${section}\n${anchor}\n`);
  }
  return text;
}
/** R-028-51/VW1/C4: only BASE's exact legacy decision section adopts the current same-state section. */
function vwDecisions(text: string, frozen: ReturnType<V['briefView']>, current: curViews.Brief): string {
  const section = (v: Pick<curViews.Brief, 'decisions'>) => [v.decisions.length ? `Needs your decision (${v.decisions.length}):` : 'Needs your decision: none',
    ...v.decisions.map(d => `  ${d.node}/${d.obligation} [${d.blockedDownstream} blocked downstream] ${d.mark} ${d.detail} → ${d.command}`)].join('\n');
  const rendered = curViews.renderBrief(current), next = section(current);
  return rendered.includes(`${next}\n`) ? text.replace(`${section(frozen)}\n`, `${next}\n`) : text;
}
/** The exact inserted fragment of two renders differing only in one item/block. No prose patterns are erased. */
function inserted(withPart: string, withoutPart: string): string {
  let start = 0, end = 0;
  while (start < withoutPart.length && withPart[start] === withoutPart[start]) start++;
  while (end < withoutPart.length - start && withPart.at(-1 - end) === withoutPart.at(-1 - end)) end++;
  return withPart.slice(start, end ? -end : undefined);
}
/** VW2/N4/N5/C4: replace only exact legacy receipt fragments with the current rendering of the same facts. */
function vwReceipt(text: string, card: ReturnType<V['receipt']>, modern: curViews.ReceiptCard, s: State, entries: Entry[]): string {
  const render = (patch: Partial<curViews.ReceiptCard>) => curViews.renderReceipt(curViews.withActHistory(curViews.withPresentationState({ ...modern, ...patch }, s), entries), { full: true });
  const current = render({}), oldLead = text.split('\n')[0]!;
  const lead = current.split('\n');
  let end = 1;
  while (lead[end]?.startsWith('Next: ') || lead[end]?.startsWith('  or: ')) end++;
  // VW2: primary need or recorded activity, including blocked-by-dependencies -> waiting-for activity.
  text = text.replace(oldLead, lead.slice(0, end).join('\n'));
  for (const i of card.items.filter(i => i.status === 'D')) {
    // VW2: append only this item's itemLine; the evidence/body is still the frozen renderer's output.
    const old = inserted(BASE.v.renderReceipt({ ...card, items: [i], blocks: [] }), BASE.v.renderReceipt({ ...card, items: [], blocks: [] }));
    if (old) text = text.replace(old, `${old.endsWith('\n') ? old.slice(0, -1) : old}\n  next: ${curNeeds.itemLine(s, i.subject, i.obligation)}\n`);
  }
  for (const b of card.blocks) {
    // VW2/C3/C4 and R-028-44: only the exact block fragment changes to itemLine plus its retained diagnostics.
    const old = inserted(BASE.v.renderReceipt({ ...card, items: [], blocks: [b] }), BASE.v.renderReceipt({ ...card, items: [], blocks: [] }));
    const next = modern.blocks.find(x => x.seq === b.seq);
    if (old && next) text = text.replace(old, inserted(render({ items: [], blocks: [next] }), render({ items: [], blocks: [] })));
  }
  if (card.halt) {
    // N5: the recorded halt evidence stays; its old generic resolving-command suffix goes away.
    const old = text.split('\n').find(l => l.startsWith(`⏸ halted by driver #${card.halt!.seq} `));
    const next = current.split('\n').find(l => l.startsWith(`⏸ halted by driver #${card.halt!.seq} `));
    if (old && next) text = text.replace(old, next);
  }
  return text;
}

/** Canonical JSON of the state and of the queries and views on it. */
export function snapshot(m: { r: R; v: V }, s: State, entries: Entry[]): string {
  if (m === BASE) s = wfState(s);
  const { r, v } = m, ids = Object.keys(s.nodes).sort(), out: Record<string, unknown> = { state: { ...s, nodes: Object.fromEntries(ids.map(id => {
    // MO1 adds only derived acceptance tenure; historical acceptance flags, keys and all other fields still compare.
    const { acceptedSince: _acceptedSince, ...node } = s.nodes[id]!; return [id, node];
  })) } };
  const prefix = entries.slice(0, s.seq + 1);
  let display: State | undefined;
  const vwState = (): State => {
    if (m !== BASE) return s;
    if (display) return display;
    // VW adapters need current query indexes, never current replay facts. Copy only non-enumerable history
    // from the identical prefix; keep the frozen state's enumerable facts (which are compared above) untouched.
    const plans = new Map(prefix.filter(e => e.kind === 'genesis' || e.kind === 'plan').map(e => [e.kind === 'genesis' || e.kind === 'plan' ? e.plan : '', BASE.r.planAt(s, e.seq + 1)]));
    const indexed = cur.reduce(prefix, sha => plans.get(sha)!);
    display = Object.create(Object.getPrototypeOf(s), Object.getOwnPropertyDescriptors(s)) as State;
    for (const key of Object.getOwnPropertySymbols(indexed)) if (key.description === 'owed.reducer.history') Object.defineProperty(display, key, Object.getOwnPropertyDescriptor(indexed, key)!);
    return display;
  };
  out.genesisJobs = attempt(() => r.genesisJobs(s)); out.genesisProgress = attempt(() => r.genesisProgress(s));
  out.allowanceSeq = r.allowanceSeq(s); out.projectId = attempt(() => r.projectId(s));
  out.adoptGuard = attempt(() => r.adoptGuard(s, { commit: 'adopted', tree: 'adopted-tree', invKeys: { ...s.trunk.invKeys } }));
  out.planAt = attempt(() => r.planAt(s, s.seq + 1)); out.entries = r.entriesOf(s).length;
  // QT1 intentionally changes only the rendered human halt wording, never the ledger value or acceptance state.
  const rendered = (text: string): string => (m === BASE ? wfRendered(s,text).replace(/halted by driver #(\d+) \(attempt (\d+), needs human\):/g,
    'halted by driver #$1 (attempt $2), needs the parent (the main agent acts; owed lists the command):') : text)
    // DC4 changes recovery command suggestions only; never normalize ledger/state/keys.
    .replace(/owed decide (\S+) --writer --text "<guidance>"/g, 'owed rule --nodes $1 --writer "<guidance>"')
    .replace(/owed decide (\S+) --writer --text "<decision>"/g, 'owed rule --nodes $1 --writer "<decision>"')
    .replace(/owed decide (\S+) --text "<decision>" \(add --after <node> to wait until that node merges; --no-resume keeps it halted\)/g, 'owed resume $1 --note "<why>" (add --after <node> to wait until that node merges); owed rule gives the writer and reviewers guidance they must acknowledge')
    .replace(/owed decide (\S+) --writer --text "<what the writer must change>"/g, 'owed rule "<what the writer must change>" --nodes $1')
    .replace(/owed decide (\S+) --text "<decision>"/g, 'owed rule --nodes $1 "<decision>"')
    // NY1 / UX1 change guidance/override labels only; retain the exact resolving review command in this differential.
    .replace(/owed rule --nodes \S+ (?:--writer )?"<guidance>"; (?:writer repairs and submits again; override only: )?/g, '')
    .replace(/(owed rule --nodes \S+) --writer ("<decision>")/g, '$1 $2')
    .replace(/ \(overrides a valid block: state the accepted risk\)/g, '');
  // FL1/FL4 intentionally change waiting presentation, not historical acceptance state/keys.
  // Adapt only the frozen view's waiting fields and QT1 halt text; everything else compares exactly.
  const wait = (id: string): cur.Waiting | undefined => {
    const old = r.waitingFor(s,id), spec = s.plan.nodes.find(n => n.id === id);
    const deps = s.nodes[id]?.slot?.open && spec ? spec.deps.filter(d => !s.nodes[d]?.merged) : [];
    return deps.length ? { after:old?.after ?? '', resume:old?.resume ?? r.resumeOf(s,id)?.seq ?? -1, deps } : old;
  };
  out.status = attempt(() => {
    const status = v.statusView(s,prefix);
    if (m === BASE) {
      const waiting = ids.flatMap(node => { const w = wait(node); return w ? [{node,...w}] : []; });
      if (waiting.length) status.waiting = waiting;
      status.pending['parent+writer'] = status.pending['parent+writer']!.filter(i => i.obligation !== 'submit' || !wait(i.subject));
      for (const items of Object.values(status.pending)) for (const i of items) {
        const blocks = s.nodes[i.subject]?.blocks.filter(b => b.obligation === i.obligation && i.evidence.includes(b.seq) && (b.state === 'active' || b.state === 'flaky')) ?? [];
        if (!blocks.some(b => b.state === 'flaky')) continue;
        const shown = blocks.filter(b => !wfHeld(s,b));
        const flakes = shown.filter(b => b.state === 'flaky');
        if (flakes.length) i.hint = `${flakes.map(b => wfBlockText(s,b)).join('; ')}; ${baseViews.flakyRuleHint(i.subject)}`;
        else delete i.hint;
        if (i.blockNotes) i.blockNotes = i.blockNotes.filter(note => shown.some(b => b.seq === note.seq));
      }
    }
    let text = m === CUR ? curViews.renderStatusFull(status as curViews.StatusView).replace(/^Merge queue:.*\n/gm, '') : v.renderStatus(status);
    if (m === BASE) for (const node of ids) {
      const w = wait(node);
      if (w?.deps?.length) text = text.replace(`⏳ ${node}: waiting for ${w.after} (resume #${w.resume})`,`⏳ ${node}: ${curViews.waitingLine(w)}`);
    }
    if (m === BASE) {
      const current = curViews.statusView(vwState(), prefix);
      // VW2/C4: retain each pending item's frozen evidence and replace only its exact block hint.
      for (const [role, items] of Object.entries(status.pending)) for (const i of items) {
        const next = current.pending[role]?.find(x => x.subject === i.subject && x.obligation === i.obligation) as ItemView & { hint?: string } | undefined;
        if (i.hint && next) text = text.replace(i.hint, next.hint ?? '');
        if (i.obligation === 'driver-halt' && next) {
          // VW5/N5: the owner halt's resolving text comes from needs, not the recorded reason or generic tail.
          const old = `⏸ halted ${i.subject} — ${i.detail}; cleared by any later action on the node by a principal other than parent:drive (submit, review, rebase, abandon, waive, resume, a ruling naming it), or a new attempt; ${baseViews.resumeHint(i.subject)}`;
          text = text.replace(old, `⏸ halted ${i.subject} — ${next.detail}`);
        }
      }
      // VW5/N5: remove only the frozen renderer's exact standalone generic recovery suggestion.
      text = text.replace(`\n  ${baseViews.resumeHint()}\n`, '\n');
      for (const b of status.needsRuling ?? []) {
        const old = `⛔ ${b.node}: blocked #${b.seq} ${b.obligation} (needs a parent ruling): ${baseViews.oneLine(b.note)}; record owed rule --nodes ${b.node} "<decision>"`;
        text = text.replace(old, `${b.node}: review block #${b.seq} needs a parent ruling`);
      }
      return rendered(vwStatus(text, status, current));
    }
    return rendered(text);
  });
  out.brief = attempt(() => {
    const brief = v.briefView(s,prefix,-1,Date.UTC(2027,0,1));
    if (m === BASE) {
      brief.totals.waiting = Object.values(s.nodes).filter(n => !n.merged && (wait(n.id) || n.phase === 'blocked')).length;
      // AK2 changes only trunk decision guidance. Adapt this field from the frozen state's same history;
      // reducer facts, all other decision fields and the exact rendered comparison remain untouched.
      for (const d of brief.decisions) if (d.node === 'trunk') d.command = curViews.trunkDecision(s,d.obligation,undefined,prefix);
    }
    // SQ changes only the default prefix; compare the retained morning sections against the frozen renderer.
    if (m === CUR) delete (brief as curViews.Brief).summary;
    if (m === BASE) for (const b of brief.rejected) {
      // VW2/C3/C4: brief block clearance is exactly itemLine, without historical merge diagnostics.
      b.clear = curNeeds.itemLine(vwState(), b.node, b.obligation);
    }
    const text = v.renderBrief(brief);
    if (m !== BASE) return rendered(text);
    const current = curViews.briefView(vwState(), prefix, -1, Date.UTC(2027, 0, 1));
    delete current.summary;
    return rendered(vwDecisions(text, brief, current));
  });
  out.escapes = attempt(() => v.escapeSummary(s));
  for (const id of ids) {
    const n = s.nodes[id]!, q: Record<string, unknown> = {};
    q.attestJobs = attempt(() => r.attestJobs(s, id).map(j => [j, r.jobCurrent(s, j)]));
    q.overlapping = attempt(() => r.overlapping(s, id)); q.halted = r.halted(s, id); q.resume = r.resumeOf(s, id); q.waiting = m === BASE ? wait(id) : r.waitingFor(s, id);
    q.nextReviewerN = r.nextReviewerN(s, id);
    const reviewState = m === BASE ? reviewEpochView(s, prefix, id) : s;
    q.reviewerBase = r.reviewerBase(reviewState, id);
    q.observations = n.items.map(i => r.observationsOf(s, i.subject, i.obligation, i.key).map(e => e.seq));
    q.blocks = n.blocks.map(b => [r.parentRuling(s, b)?.seq, r.awaitingRuling(s, b)]);
    if (n.candidate) q.mergeGuard = attempt(() => { const guard = r.mergeGuard(s, id, { facts: { ...n.candidate!, base: s.trunk.commit }, state: { commit: n.candidate!.commit, tree: n.candidate!.tree, invKeys: { ...s.trunk.invKeys } } }); return m === BASE ? wfItems(s,guard) : guard; });
    q.receipt = attempt(() => {
      const card = v.receipt(s,prefix,id);
      // RR3: only satisfied review receipt presentation adopts latest qualifying evidence per principal.
      // The state, mergeGuard and every other evidence list above still compare exactly to 0.10.
      if (m === BASE) for (const i of card.items) {
        if (i.status !== 'E' || (i.obligation !== 'review' && i.obligation !== 'closure-review')) continue;
        i.observations = i.observations.filter(e => e.kind !== 'review' || !i.observations.some(later =>
          later.kind === 'review' && later.by === e.by && later.seq > e.seq));
        i.evidence = i.observations.map(e => e.seq);
      }
      if (m === BASE && wait(id)) {
        const w = wait(id)!;
        // The new line is the FL1 contract; the rest remains the historical renderer.
        delete card.waiting;
        const text = v.renderReceipt(card), lines = text.split('\n');
        const at = lines.findIndex(l => !l.startsWith('Exec:') && !l.startsWith('Drive:') && !l.startsWith('↻') && !l.startsWith('⏸') && lines.indexOf(l) > 0);
        const nodes = [...new Set([...(w.deps ?? []), ...(w.after ? w.after.split(', ') : [])])];
        lines.splice(at < 0 ? 1 : at,0,`⏳ ${curViews.waitingLine(w)}; the driver acts again when ${nodes.join(', ')} ${nodes.length > 1 ? 'merge' : 'merges'} or after another resume`);
        return rendered(vwReceipt(lines.join('\n'), card, curViews.receipt(vwState(), prefix, id), vwState(), prefix));
      }
      // NY6: full preserves the frozen receipt's weak-confirmation provenance.
      return rendered(m === CUR ? curViews.renderReceipt(card as curViews.ReceiptCard,{full:true}) : vwReceipt(v.renderReceipt(card), card, curViews.receipt(vwState(), prefix, id), vwState(), prefix));
    });
    const ownerState = m === BASE ? Object.create(Object.getPrototypeOf(s),Object.getOwnPropertyDescriptors(s)) as State : s;
    if (m === BASE) ownerState.nodes = {...s.nodes,[id]:{...n,blocks:n.blocks.filter(b => !wfHeld(s,b)),items:n.items.filter(i => !(i.discharger === 'executor' && n.blocks.some(b => b.obligation === i.obligation && wfHeld(s,b))))}};
    q.owner = attempt(() => v.ownerCommands(ownerState, id).map(command => rendered(m === BASE ? command.replace(/owed plan <plan\.yaml> \(add a node that repairs (inv:[^;]+); invariants cannot be waived, only a measured pass on a later merge clears this debt\)/g, (_all, obligation: string) => curViews.trunkDecision(s,obligation,undefined,prefix)) : command)));
    if (n.slot?.open) q.reviewPacket = attempt(() => v.reviewPacket(reviewState, id));
    out[`node:${id}`] = q;
  }
  // GR7 intentionally adds advisory text only. Keep all state, keys, verdicts and reasons compared;
  // ignore precisely that line (and its JSON outOfWrites.hint mirror) in the frozen view comparison.
  return canonical(withoutGrantHints(out));
}
function withoutGrantHints(value: unknown): unknown {
  if (typeof value === 'string') return value.replace(/\nhint: an allow rule \{nodes: \[[^\n]*\], writes: \[[^\n]*\]\} would let owed grant these/g, '');
  if (Array.isArray(value)) return value.map(withoutGrantHints);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).filter(([k,v]) => !(k === 'hint' && typeof v === 'string' && /^hint: an allow rule .* would let owed grant these$/.test(v))).map(([k,v]) => [k,withoutGrantHints(v)]));
  return value;
}
/** Variants of a draft (other principal, attempt, key, node, obligation) whose validateDraft decisions are compared. */
export function variants(d: Draft, nodes: string[]): Draft[] {
  const x = d as Record<string, unknown>, out: Draft[] = [d];
  const v = (patch: Record<string, unknown>): void => { out.push({ ...x, ...patch } as Draft); };
  v({ by: 'reviewer:other' }); v({ by: 'owner:human' }); v({ by: 'parent:drive' }); v({ by: 'writer:x#1' });
  if ('attempt' in x) { v({ attempt: Number(x.attempt) + 1 }); v({ attempt: Number(x.attempt) - 1 }); }
  if ('key' in x) v({ key: 'wrong-key' });
  if ('node' in x) for (const n of nodes.slice(0, 3)) v({ node: n });
  if ('obligation' in x) { v({ obligation: 'approve' }); v({ obligation: 'writes' }); }
  if ('rank' in x) v({ rank: 3 });
  return out;
}
export interface Mismatch { at: number; what: string; base: string; cur: string }
/** Intended changes since 0.10: removed-node abandon (0.12), AH2's restricted driver abandon and PR5's owner rank hint (0.14). */
export function intendedChange(s: State, d: Draft, base: unknown, cur: unknown): boolean {
  if (!Array.isArray(base) || !Array.isArray(cur)) return false;
  let expected = [...base];
  if (d.kind === 'review' && d.by.startsWith('owner:') && d.rank !== 3) {
    expected = expected.map(x => x === 'review rank: reviewer must use 1..2, owner must use 3' ? 'owner reviews use --rank 3' : x);
  }
  if (d.by === 'parent:drive') {
    const old = `${d.kind} by parent:drive: the driver records only dispatch, launch, send, halt, rebase`;
    if (d.kind !== 'abandon') expected = expected.map(x => x === old ? `${old}, abandon` : x);
    else {
      expected = expected.filter(x => x !== old);
      const n = s.nodes[d.node], dispatched = BASE.r.entriesOf(s).find(e => e.kind === 'dispatch' && e.node === d.node && e.attempt === d.attempt);
      if (dispatched?.by !== 'parent:drive' || n?.runs.find(r => r.attempt === d.attempt)?.launches.some(l => l.role === 'writer')) expected.push('driver abandon requires its own empty slot with no writer launch');
      if (s.plan.nodes.some(n => n.id === d.node)) expected.push('driver abandon requires a node that left the plan; live nodes are not stale empty slots');
      if (typeof d.reason !== 'string' || !d.reason.trim()) expected.push('driver abandon requires a stale cause');
    }
  }
  if (d.kind === 'abandon' && s.nodes[d.node]?.phase === 'removed') expected = expected.filter(x => x !== `Node ${d.node} does not exist`);
  // WF1/WF2 alter only the obligation detail inside otherwise identical refusal arrays.
  for (const n of Object.values(s.nodes)) for (const i of n.items) {
    const next = wfItem(s,i);
    if (next.detail !== i.detail) expected = expected.map(x => typeof x === 'string' ? x.replace(`${i.obligation} unsatisfied:${i.detail}`,`${i.obligation} unsatisfied:${next.detail}`) : x);
  }
  return canonical(expected) === canonical(withoutGrantHints(cur));
}
/**
 * Reduces `entries` with both reducers at every k-th prefix and the full ledger; compares snapshots and the
 * validateDraft decisions on variants of the next entry. Returns the first mismatch, or undefined.
 */
export function compare(entries: Entry[], lookup: (sha: string) => Plan, k: number, opts: { curLookup?: (sha: string) => Plan } = {}): Mismatch | undefined {
  const curLookup = opts.curLookup ?? frozen(lookup);
  const cuts = new Set<number>([entries.length]); for (let i = k; i < entries.length; i += k) cuts.add(i);
  for (const cut of [...cuts].sort((a, b) => a - b)) {
    const prefix = entries.slice(0, cut);
    let sb: State, sc: State;
    try { sb = BASE.r.reduce(prefix, lookup); } catch (e) { return { at: cut, what: 'base reduce threw', base: String(e), cur: '' }; }
    sc = CUR.r.reduce(prefix, curLookup);
    const a = snapshot(BASE, sb, prefix), b = snapshot(CUR, sc, prefix);
    if (a !== b) return { at: cut, what: 'snapshot', base: a, cur: b };
    const next = entries[cut];
    if (next) {
      const { seq: _s, ts: _t, prev: _p, hash: _h, ...draft } = next;
      for (const d of variants(draft as Draft, Object.keys(sb.nodes))) {
        const rb = attempt(() => BASE.r.validateDraft(sb, d)), rc = attempt(() => CUR.r.validateDraft(sc, d)), eb = canonical(rb), ec = canonical(rc);
        if (eb !== ec && !intendedChange(sb, d, rb, rc)) return { at: cut, what: `validateDraft ${canonical(d)}`, base: eb, cur: ec };
      }
    }
  }
  return undefined;
}

// ---------- fuzz ledgers: random drafts, appended when the base reducer accepts them ----------
function rng(seed: number): () => number { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const check = (id: string, run = `test ${id}`) => ({ id, run, timeout_s: 10, reads: ['**'], red: true, tests: ['test/**'] });
const node = (id: string, deps: string[], extra: Partial<NodeSpec> = {}): NodeSpec => ({ id, deps, writes: [`src/${id}/`], checks: [check(id)], review: { count: 1, min_rank: 1 }, ...extra });
/** Plans of the fuzz ledgers: P0 and changes (a check definition, a removed node, a title, a review count, allow). */
export function fuzzPlans(): Plan[] {
  const p0: Plan = { version: 1, trunk: 'main', closure: ['config/**'], invariants: [check('safe', 'safe')].map(({ red: _r, tests: _t, ...c }) => c), nodes: [node('a', []), node('b', ['a'], { approve: 'owner', evidence: [{ id: 'shot', what: 'screenshot', by: 'reviewer' }] }), node('c', [], { review: { count: 0, min_rank: 1 }, checks: [] }), node('d', ['b', 'c'], { review: { count: 2, min_rank: 2 } })] };
  const p1 = structuredClone(p0); p1.nodes[0]!.checks[0]!.run = 'test a v2';
  const p2 = structuredClone(p0); p2.nodes = p2.nodes.filter(n => n.id !== 'c'); p2.nodes.find(n => n.id === 'd')!.deps = ['b'];
  const p3 = structuredClone(p0); p3.nodes[3]!.title = 'renamed'; p3.allow = [{ nodes: ['*'], review_count: 0, checks: ['*'] }];
  const p4 = structuredClone(p3); p4.nodes[3]!.review.count = 1; p4.nodes[0]!.writes = ['src/a/', 'src/shared/'];
  return [p0, p1, p2, p3, p4];
}
export function fuzzLedger(seed: number, steps: number): { entries: Entry[]; lookup: (sha: string) => Plan; mismatch?: Mismatch } {
  const r = rng(seed), pick = <T>(xs: readonly T[]): T => xs[Math.floor(r() * xs.length)]!, plans = fuzzPlans(), shas = plans.map(p => H(p));
  const byS = new Map(shas.map((s, i) => [s, plans[i]!])), lookup = (sha: string): Plan => { const p = byS.get(sha); if (!p) throw new Error(`missing plan ${sha}`); return p; };
  const curLookup = frozen(lookup);
  const entries: Entry[] = [], ids = ['a', 'b', 'c', 'd', 'ghost'], tags = ['1', '2', '3'];
  const append = (d: Draft): void => { const e = { ...d, seq: entries.length, ts: new Date(Date.UTC(2026, 0, 1) + entries.length * 60_000).toISOString(), prev: entries.at(-1)?.hash ?? '0'.repeat(64) } as Entry; e.hash = entryHash(e); entries.push(e); };
  append({ kind: 'genesis', by: 'owner:human', channel: 'tty', trunk: 'main', commit: 't0', plan: shas[0]!, state: { commit: 't0', tree: 'tt0', invKeys: { safe: 'inv0' } } });
  const payload = { nonce: 'nonce-nonce-nonce', decoys: [{ node: 'd', defect: 'off by one' }] };
  let trunkN = 0;
  for (let step = 0; step < steps; step++) {
    const s = BASE.r.reduce(entries, lookup), sc = CUR.r.reduce(entries, curLookup);
    const id = pick(ids), n = s.nodes[id], slot = n?.slot, cand = n?.candidate, spec = s.plan.nodes.find(x => x.id === id);
    const latest = Math.max(-1, ...s.rules.map(x => x.seq)), project = attempt(() => BASE.r.projectId(s)) as string;
    const facts = (tag: string): CandidateFacts => { const patch = `patch-${id}-${tag}`; return { commit: `c-${id}-${tag}`, tree: `t-${id}-${tag}`, base: slot?.base ?? s.trunk.commit, patch, changed: [r() < 0.9 ? `src/${id}/x` : 'config/y'], closureTouched: r() < 0.1, keys: { [`check:${id}`]: `ck-${id}-${tag}`, [`red:${id}`]: `rd-${id}-${tag}`, writes: `wr-${id}-${tag}`, review: `rv-${id}-${tag}`, rulings: `ru-${id}-${tag}`, 'closure-review': `cr-${id}-${tag}`, ...(spec ? BASE.r.manualKeys(spec, patch) : {}) } }; };
    const keyOf = (o: string): string => r() < 0.85 ? cand?.keys[o] ?? `k-${o}` : `stale-${o}`;
    const obligations = cand ? Object.keys(cand.keys) : ['writes', `check:${id}`];
    const block = n?.blocks.length ? pick(n.blocks) : undefined;
    const pending = Object.values(s.nodes).flatMap(x => x.slot?.open && x.candidate ? x.items.filter(i => i.status === 'D').map(i => ({ n: x, i })) : []);
    const helpful = (): Draft | undefined => {
      if (!pending.length || r() < 0.4) return undefined;
      const { n: x, i } = pick(pending);
      if (/^(check|red):|^writes$/.test(i.obligation)) return { kind: 'obs', by: 'executor:owed', subject: x.id, obligation: i.obligation, key: i.key, verdict: r() < 0.9 ? 'pass' : 'fail', exit: 0, durationMs: 1, commit: x.candidate!.commit, base: x.slot!.base };
      if (i.obligation === 'review' || i.obligation === 'closure-review' || i.obligation === 'rulings') { const o = i.obligation === 'rulings' ? 'review' : i.obligation; return { kind: 'review', by: pick(['reviewer:r1', 'reviewer:r2', 'reviewer:r3']), node: x.id, attempt: x.slot!.attempt, obligation: o, key: x.candidate!.keys[o] ?? '', verdict: 'ok', rank: 2, ...(latest >= 0 ? { ack_rulings: latest } : {}) }; }
      if (i.obligation === 'approve') return { kind: 'review', by: 'owner:human', node: x.id, attempt: x.slot!.attempt, obligation: 'approve', key: i.key, verdict: 'ok', rank: 3 };
      if (i.obligation.startsWith('evidence:')) return { kind: 'evidence', by: 'reviewer:e', node: x.id, attempt: x.slot!.attempt, key: i.key, id: i.obligation.slice(9), files: [{ path: 'shot.png', sha256: 'c'.repeat(64), bytes: 3 }], note: 'seen' };
      return undefined;
    };
    const makers: (() => Draft)[] = [
      () => { const t = Object.values(s.nodes).find(x => x.phase === 'ready' && r() < 0.7) ?? n; return { kind: 'dispatch', by: pick(['parent:main', 'parent:drive']), node: t?.id ?? id, attempt: (t?.slot?.attempt ?? 0) + (r() < 0.9 ? 1 : 2), base: r() < 0.9 ? s.trunk.commit : 'old', branch: `b-${id}`, worktree: `/wt/${id}`, packet: 'p', rulings_seen: r() < 0.8 ? latest : -1 }; },
      () => ({ kind: 'submit', by: r() < 0.9 ? slot?.writer ?? 'writer:x' : 'writer:y#1', node: id, attempt: slot?.attempt ?? 1, facts: facts(pick(tags)) }),
      () => {
        // A carry targets a node whose open candidate a plan entry just invalidated, when there is one.
        const t = Object.values(s.nodes).find(x => x.slot?.open && !x.candidate && entries.some(e => e.kind === 'submit' && e.node === x.id && e.attempt === x.slot!.attempt && e.seq > x.slot!.dispatchSeq))?.id ?? id;
        const last = [...entries].reverse().find(e => e.kind === 'submit' && e.node === t), tspec = s.plan.nodes.find(x => x.id === t);
        return { kind: 'submit', by: 'executor:owed', node: t, attempt: s.nodes[t]?.slot?.attempt ?? 1, facts: last?.kind === 'submit' ? { ...last.facts, keys: { ...last.facts.keys, ...(tspec ? BASE.r.manualKeys(tspec, last.facts.patch) : {}) } } : facts('1'), carry: last?.seq ?? 0 } as Draft;
      },
      () => { const last = [...entries].reverse().find(e => e.kind === 'submit' && e.node === id); return { kind: 'submit', by: 'executor:owed', node: id, attempt: slot?.attempt ?? 1, facts: last?.kind === 'submit' ? { ...last.facts, keys: { ...last.facts.keys, ...(spec ? BASE.r.manualKeys(spec, last.facts.patch) : {}) } } : facts('1'), carry: last?.seq ?? 0 }; },
      () => { const o = pick(obligations.filter(x => /^(check|red|writes)/.test(x)).concat(['writes'])); const src = block && r() < 0.3 ? entries[block.seq] : undefined; return src?.kind === 'obs' ? { kind: 'obs', by: 'executor:owed', subject: src.subject, obligation: src.obligation, key: src.key, verdict: pick(['fail', 'fail', 'pass', 'error'] as const), exit: 1, durationMs: 1, commit: src.commit, base: src.base, attribution: true } : { kind: 'obs', by: 'executor:owed', subject: id, obligation: o, key: keyOf(o), verdict: pick(['pass', 'pass', 'pass', 'fail', 'error'] as const), exit: 0, durationMs: 1, commit: cand?.commit ?? 'x', base: slot?.base, ...(r() < 0.1 ? { merging: id } : {}) }; },
      () => ({ kind: 'obs', by: 'executor:owed', subject: 'trunk', obligation: 'inv:safe', key: r() < 0.7 ? s.trunk.invKeys.safe ?? 'inv0' : `inv${trunkN + 1}`, verdict: pick(['pass', 'pass', 'fail', 'error'] as const), exit: 0, durationMs: 1, commit: s.trunk.commit, base: s.trunk.commit, ...(r() < 0.2 ? { merging: id } : {}) }),
      () => { const o = pick(['review', 'review', 'closure-review', 'approve'] as const); return { kind: 'review', by: o === 'approve' || r() < 0.1 ? 'owner:human' : pick(['reviewer:r1', 'reviewer:r2', 'reviewer:r3']), node: id, attempt: slot?.attempt ?? 1, obligation: o, key: keyOf(o), verdict: r() < 0.75 ? 'ok' : 'block', rank: o === 'approve' ? 3 : pick([1, 2, 2]), ...(r() < 0.5 && latest >= 0 ? { ack_rulings: latest } : {}), ...(r() < 0.15 ? { needs: 'parent' } : {}) } as Draft; },
      () => { const o = block?.obligation ?? pick(obligations); return { kind: 'waive', by: 'owner:human', channel: 'delegated', node: id, obligation: o, key: keyOf(o), reason: 'risk', accept_risk: block ? [block.seq] : [] }; },
      () => ({ kind: 'defer', by: 'owner:human', node: id, items: [{ id: 'safe', key: `inv${trunkN + 1}` }], reason: 'later' }),
      () => ({ kind: 'abandon', by: 'parent:main', node: id, attempt: slot?.attempt ?? 1, reason: 'retry' }),
      () => { const t = Object.values(s.nodes).find(x => x.slot?.open && x.slot.base !== s.trunk.commit && r() < 0.8)?.id ?? id, ts = s.nodes[t]?.slot; return { kind: 'rebase', by: pick(['parent:main', ts?.writer ?? 'writer:x']), node: t, attempt: ts?.attempt ?? 1, from: ts?.base ?? 'x', base: s.trunk.commit }; },
      () => { trunkN++; const commit = `m${trunkN}`, t = Object.values(s.nodes).find(x => x.accepted && x.slot?.open && r() < 0.9), tn = t ?? n, tc = t?.candidate ?? cand; return { kind: 'merge', by: 'executor:owed', node: tn?.id ?? id, attempt: tn?.slot?.attempt ?? 1, prior: s.trunk.commit, commit, facts: { ...(tc ?? facts('1')), commit, tree: `mt${trunkN}`, base: s.trunk.commit }, state: { commit, tree: `mt${trunkN}`, invKeys: { safe: r() < 0.7 ? s.trunk.invKeys.safe ?? 'inv0' : `inv${trunkN}` } } }; },
      () => ({ kind: 'rule', by: 'parent:main', text: 'ruling', nodes: r() < 0.4 ? '*' : [id === 'ghost' ? 'a' : id] }),
      () => ({ kind: 'plan', by: r() < 0.8 ? 'owner:human' : 'parent:main', prior: s.planSha, plan: pick(shas), downgrades: [] }),
      () => ({ kind: 'note', by: 'parent:main', text: 'note' }),
      () => ({ kind: 'halt', by: 'parent:drive', node: id, attempt: slot?.attempt ?? 1, reason: 'stuck', needs: 'human' }),
      () => ({ kind: 'resume', by: 'parent:main', node: id, attempt: slot?.attempt ?? 1, ...(r() < 0.5 ? { after: pick(['a', 'b', 'c']) } : {}) }),
      () => { const role = pick(['writer', 'reviewer'] as const), b = BASE.r.runId(project, id, slot?.attempt ?? 1, role); return { kind: 'launch', by: 'parent:drive', node: id, attempt: slot?.attempt ?? 1, role, rid: role === 'writer' ? b : `${b}:${BASE.r.nextReviewerN(s, id)}`, spec: 'a'.repeat(64), labels: BASE.r.runLabels(project, id, slot?.attempt ?? 1, role) }; },
      () => { const l = [...entries].reverse().find(e => e.kind === 'launch' && e.node === id); const rid = l?.kind === 'launch' ? l.rid : 'none'; return { kind: 'send', by: 'parent:drive', node: id, attempt: slot?.attempt ?? 1, rid, send: `${rid}:steer:${entries.length}`, sendKind: 'steer', message: 'b'.repeat(64), reason: 'review-missing' }; },
      () => { const b = s.nodes.b, key = b?.candidate?.keys['evidence:shot']; return { kind: 'evidence', by: pick(['reviewer:e', 'owner:human']), node: r() < 0.8 ? 'b' : id, ...(b?.merged && (r() < 0.5 || !b.slot?.open) ? { merge: b.merged.seq } : { attempt: b?.slot?.attempt ?? 1, key: r() < 0.9 ? key ?? 'k' : 'stale' }), id: 'shot', files: [{ path: 'shot.png', sha256: 'c'.repeat(64), bytes: 3 }], note: 'seen' }; },
      () => { trunkN++; return { kind: 'adopt', by: 'owner:human', trunk: 'main', prior: s.trunk.commit, commit: `ad${trunkN}`, state: { commit: `ad${trunkN}`, tree: `adt${trunkN}`, invKeys: { safe: r() < 0.7 ? s.trunk.invKeys.safe ?? 'inv0' : `inv${trunkN}` } }, changed: ['README'], commits: 1, note: 'release' }; },
      () => { const m = [...entries].reverse().find(e => e.kind === 'merge' && (r() < 0.8 || e.node === id)); return { kind: 'escape', by: 'parent:main', node: m?.kind === 'merge' ? m.node : id, merge: m?.seq ?? 0, class: pick(['missing', 'weak', 'waiver'] as const), note: 'escaped' }; },
      () => (r() < 0.5 ? { kind: 'decoy-commit', by: 'owner:human', digest: BASE.r.decoyDigest(payload) } : { kind: 'decoy-reveal', by: 'owner:human', ...payload }),
    ];
    // Progress-heavy weights: obs, reviews and submits most, plan changes and odd kinds rarely.
    const weights = [6, 6, 3, 1, 14, 3, 8, 2, 1, 1, 1, 5, 1, 2, 1, 1, 1, 1, 1, 3, 1, 2, 1], total = weights.reduce((a, b) => a + b, 0);
    let x = r() * total, i = 0; while (x >= weights[i]!) { x -= weights[i]!; i++; }
    const d = (i === 4 || i === 6 ? helpful() : undefined) ?? makers[i]!();
    const eb = BASE.r.validateDraft(s, d), ec = CUR.r.validateDraft(sc, d);
    if (canonical(eb) !== canonical(ec) && !intendedChange(s, d, eb, ec)) return { entries, lookup, mismatch: { at: entries.length, what: `validateDraft ${canonical(d)}`, base: canonical(eb), cur: canonical(ec) } };
    if (!eb.length) append(d);
  }
  return { entries, lookup };
}
