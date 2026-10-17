import type { Block, ItemView, State } from './types.ts';
import type { Activity, Need, Runtime } from './needs-types.ts';
import { driveConfig } from './plan.ts';
import { clockTime } from './clock.ts';
import { entriesOf, previousSubmit, awaitingRuling, parentRuling, ownerNeeded, readyDispatchSkips, overlapping, halted, waitingFor, reportedOf, heldFlaky, heldFlakyText, flakyBlockText, nodeReview, sharedFailure, fixCandidates, sharedNames, sharedParked, sharedParkNotices, sharedPhase, trunkParked, trunkParkNotices, trunkRedOf, trunkRedText, trunkInvariantReds } from './reducer.ts';
import { answerRetry } from './answer.ts';
import { shellQuote } from './exec-wrap.ts';
export type { Need, NeedKind, Activity, Measuring, Asking, Runtime } from './needs-types.ts';

const counts = (b: Block): boolean => b.state === 'active' || b.state === 'flaky';
const review = (o: string): boolean => o === 'review' || o === 'closure-review';
const oneLine = (text: string): string => text.replace(/[\\\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, c => c === '\\' ? '\\\\' : c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const plain = (text: string): string => text.replace(/#[0-9]+\s*/g, '').split(';')[0]!.trim();
const pin = (s: State, node: string): string | undefined => s.nodes[node]?.slot?.open ? s.nodes[node]?.candidate?.commit.slice(0, 12) : undefined;
const candidateFlag = (s: State, node: string): string => pin(s, node) ? ` --candidate ${pin(s, node)}` : '';
const obligationFlag = (o: string): string => o === 'closure-review' ? ' --obligation closure-review' : '';
const owner = 'owner:<id>';
const word = (s: string): string => /^[A-Za-z0-9._:/@+-]+$/.test(s) ? s : shellQuote(s);
const decision = (node: string): string => `owed decide ${word(node)} --text "<ruling>" --writer`;
const risks = (s: State, node: string, obligation: string): Block[] => s.nodes[node]?.blocks.filter(b => counts(b) && b.obligation === obligation) ?? [];
const waive = (s: State, node: string, obligation: string): string => `owed waive ${word(node)} ${word(obligation)}${candidateFlag(s, node)}${risks(s, node, obligation).length ? ` --accept-risk ${risks(s, node, obligation).map(b => b.seq).join(',')}` : ''} --reason "<reason>" --as ${owner}`;
const ownerReview = (s: State, node: string, obligation: string): string => `owed review ${word(node)}${obligationFlag(obligation)} --ok --rank 3${candidateFlag(s, node)} --note "<note>" --ack-rulings latest --as ${owner}`;
const approve = (s: State, node: string): string => `owed approve ${word(node)}${candidateFlag(s, node)} --note "<note>" --as ${owner}`;
const evidence = (s: State, node: string, obligation: string, role = 'owner'): string => `owed evidence ${word(node)} ${word(obligation.slice(9))} --file <path> --note "<what was checked>" --as ${role}:<id>${candidateFlag(s, node)}`;
function reviewAsk(note: string): string {
  const marker = /BLOCK\s*\(needs parent\)\s*:|Parent decision needed\s*:|needs parent/i.exec(note);
  const tail = marker ? note.slice(marker.index + marker[0].length).replace(/^[\s):—-]+/, '') : note.trim().match(/[^.!?]+[.!?]*\s*$/)?.[0] ?? note;
  return oneLine(tail.trim().replace(/\s+/g, ' ')).slice(0, 300).trim();
}
function haltReason(reason: string): string {
  if (reason.startsWith('review-missing:')) return 'reviewer finished without recording the required review';
  if (/^writer run .*finished .*without submitting/.test(reason)) return 'writer finished without submitting a candidate';
  const sealed = /^writer run .* sealed (\S+)(.*)$/.exec(reason);
  if (sealed) return `writer stopped: ${sealed[1]}${plain(sealed[2]!)}`;
  if (reason.startsWith('dsa rejected')) return `run request rejected${reason.includes(':') ? `: ${plain(reason.slice(reason.indexOf(':') + 1))}` : ''}`;
  if (/^cannot re-(?:launch|send)/.test(reason)) return 'stored run request is unavailable';
  return plain(reason).replace(/\s+to:"[^"]*"/g, '');
}
function writerStopNeed(text: string, node: string): { reason: string; command: string } | undefined {
  const command = decision(node), suffix = ` → ${command}`;
  if (!text.endsWith(suffix)) return;
  const match = /(?:^|; )(writer says: "(?:[^"\\]|\\.)*"|writer gave no final text)$/.exec(text.slice(0, -suffix.length));
  return match ? { reason: match[1]!, command } : undefined;
}
function unruledBlocks(s: State, node: string): Block[] {
  const n = s.nodes[node], keys = n?.candidate?.keys ?? previousSubmit(s, node)?.facts.keys;
  if (!n?.slot?.open || !keys) return [];
  return n.blocks.filter(b => b.kind === 'judgment' && b.key === keys[b.obligation] && awaitingRuling(s, b));
}
/** Existing progress heuristic, not a prediction of the driver's next action. */
function repairingBlock(s: State, node: string): Block | undefined {
  const n = s.nodes[node], slot = n?.slot;
  if (!n || !slot?.open || halted(s, node)) return;
  const b = n.blocks.findLast(b => counts(b) && b.kind === 'judgment' && review(b.obligation));
  return b && ((n.candidate?.seq ?? -1) > b.seq || n.runs.find(r => r.attempt === slot.attempt)?.sends.some(x => x.reason === 'repair' && x.seq > b.seq)) ? b : undefined;
}
/** C3 applies to submitted, changed-key repairs of active review judgments only. */
function repaired(s: State, node: string, obligation: string): Block | undefined {
  const c = s.nodes[node]?.candidate;
  return c && risks(s, node, obligation).find(b => b.kind === 'judgment' && b.state === 'active' && review(b.obligation) && c.seq > b.seq && c.keys[obligation] !== b.key);
}
function repairLine(s: State, b: Block): string {
  return `repair #${s.nodes[b.node]!.candidate!.seq} submitted; #${b.seq} clears when ${entriesOf(s).find(e => e.seq === b.seq)?.by ?? 'the original reviewer'} records ok at rank >= ${b.rank} on the current key`;
}
/** N6: unknown, queued, other-tree and stale-candidate measurements never suppress a need. */
function measuring(s: State, node: string, obligation: string, rt?: Runtime): boolean {
  const c = s.nodes[node]?.candidate;
  return !!c && !!rt?.measuring?.some(m => m.do === 'attest' && m.phase === 'running' && m.node === node && m.candidate === c.seq && m.obligations.includes(obligation));
}
function sharedCheck(s: State, b: Block): { text: string; fix?: string } | undefined {
  if (trunkRedOf(s, b.seq, b.key)) return;
  const e = entriesOf(s).find(e => e.seq === b.seq);
  if (e?.kind !== 'obs' || e.probe !== undefined || !e.obligation.startsWith('check:')) return;
  const r = sharedFailure(s, e, e.subject);
  if (!r) return;
  const fix = fixCandidates(s, e.subject, r.names)[0]?.id;
  return { fix, text: [...new Map(r.trunk.map(p => [p.seq, p])).values()].map(probe => `${e.obligation} block #${b.seq} also fails on trunk ${probe.commit.slice(0, 12)} without ${e.subject} (probe #${probe.seq}: ${sharedNames(r.names.filter(n => probe.failed?.includes(n)))}): not this node's change`).join('; ') };
}
const obligationOrder = (o: string): number => /^(check|red|strength):/.test(o) ? 0 : o.startsWith('inv:') ? 1 : review(o) ? 2 : o === 'rulings' ? 3 : o === 'approve' ? 4 : o.startsWith('evidence:') ? 5 : 6;
function obligationNeed(s: State, i: ItemView): Need {
  const node = i.subject, n = s.nodes[node]!, bs = risks(s, node, i.obligation), b = bs[0], repair = repaired(s, node, i.obligation);
  const base = { node, actor: 'owner' as const, since: b?.seq ?? n.candidate?.seq ?? n.held ?? n.slot?.dispatchSeq ?? null, obligation: i.obligation, key: i.key, ...(b ? { block: b.seq } : {}), ...(pin(s, node) ? { candidate: pin(s, node) } : {}) };
  const shared = bs.map(b => sharedCheck(s, b)).find(x => x !== undefined);
  const red = bs.flatMap(b => trunkRedOf(s, b.seq, b.key) ?? [])[0];
  const flaky = bs.find(b => b.state === 'flaky' && b.kind === 'exec' && !heldFlaky(s, node, b));
  const diagnosis = red ? `${trunkRedText(red)}; merge-tree obs #${red.merge.seq}, trunk probe #${red.probe.seq}` : shared?.text;
  const text = diagnosis ? `${diagnosis}${flaky ? `; ${flakyText(s, flaky, false)}` : ''}` : (i.obligation === 'approve' ? 'awaiting owner approval'
    : repair ? repairLine(s, repair)
    : review(i.obligation) ? i.mark === '⊤' ? `${i.obligation} needs an owner decision` : i.mark === '⛔' ? `${i.obligation} blocked: guidance needed` : `awaiting ${i.obligation}`
    : i.obligation.startsWith('evidence:') ? `awaiting manual evidence: ${i.obligation.slice(9)}`
    : `${i.obligation}: ${flaky ? flakyText(s, flaky, false) : plain(i.detail)}`);
  if (!n.slot?.open) return { ...base, actor: 'parent', kind: n.held !== undefined ? 'decide' : 'recover', text: n.held !== undefined ? `held by abandon #${n.held}` : `no single command: ${text}; a new attempt is required`, ...(n.held !== undefined ? { command: `owed decide ${word(node)} --text "<ruling>"` } : {}) };
  if (!n.candidate) return { ...base, kind: 'recover', text: `no single command: ${text}; the writer must first submit a current candidate` };
  if (shared) return { ...base, kind: 'waive', text: shared.fix ? text : `no single command: ${text}; add a fix node first`, ...(shared.fix ? { command: `${waive(s, node, i.obligation)} --tracked-by ${word(shared.fix)}` } : {}) };
  if (i.obligation === 'approve') return { ...base, kind: 'approve', text, command: approve(s, node) };
  if (i.obligation.startsWith('evidence:')) {
    const role = i.discharger === 'parent' ? 'parent' : 'owner';
    return { ...base, actor: role, kind: 'evidence', text, command: evidence(s, node, i.obligation, role), ...(role === 'parent' ? { alternatives: [evidence(s, node, i.obligation)] } : {}) };
  }
  if (review(i.obligation) && bs.every(b => b.kind === 'judgment' && b.state === 'active')) {
    if (!bs.length || repair) return { ...base, kind: 'review', text, command: ownerReview(s, node, i.obligation) };
    return { ...base, actor: 'parent', kind: 'decide', text, command: decision(node), alternatives: [ownerReview(s, node, i.obligation)] };
  }
  if (i.obligation.startsWith('inv:')) return { ...base, kind: 'defer', text, command: `owed defer ${word(node)} ${word(i.obligation.slice(4))} --reason "<reason>" --as ${owner}` };
  return { ...base, kind: 'waive', text, command: waive(s, node, i.obligation) };
}
/** Pure parent/owner needs: baseline summary membership, corrected by C1–C9 and N1–N7. */
export function needs(s: State, node: string, rt?: Runtime): Need[] {
  const n = s.nodes[node];
  if (!n || n.merged) return [];
  const h = halted(s, node), out: Need[] = [];
  for (const a of rt?.asking ?? []) if (a.node === node) {
    const e = entriesOf(s).findLast(e => e.kind === 'rule' && (e.answers ?? (e.answer ? [e.answer] : [])).some(ref => ref.rid === a.rid && ref.qid === a.qid && ref.rev >= a.rev));
    if (e?.kind === 'rule' && n.slot?.open) out.push({ node, actor: 'parent', kind: 'answer', since: e.seq, rid: a.rid, qid: a.qid, rev: a.rev, text: oneLine(a.text), command: answerRetry(node, e, { rid: a.rid, qid: a.qid, rev: a.rev }), ...(h ? { halted: true } : {}) });
  }
  const unruled = unruledBlocks(s, node);
  const ruleNeeds = (h ? unruled : unruled.filter(b => !!n.candidate)).map(b => {
    const e = entriesOf(s).find(e => e.seq === b.seq);
    return { node, actor: 'parent' as const, kind: 'rule' as const, since: b.seq, obligation: b.obligation, block: b.seq, key: b.key, text: `review asks: ${reviewAsk(e?.kind === 'review' ? e.note ?? '' : '')}`, command: decision(node), ...(h ? { halted: true as const } : {}) };
  });
  if (h && ruleNeeds.length) return [...out, ...ruleNeeds];
  const ownerReady = n.phase === 'ready' && readyDispatchSkips(s, driveConfig(s.plan).max).get(node)?.kind === 'owner';
  if (ownerReady) return [...out, { node, actor: 'owner', kind: 'recover', since: n.blocks.find(counts)?.seq ?? null, text: `no single command: ready, not dispatched: ${plain(ownerNeeded(s, node)!)}; a current candidate is required to resolve its old blocks` }];
  out.push(...ruleNeeds);
  // statusView's pending filter excludes removed-node items, but not their halt/ruling paths.
  const obligations = (n.phase === 'removed' ? [] : n.items).filter(i => i.status === 'D').filter(i => {
    if (ruleNeeds.some(b => b.obligation === i.obligation) || i.obligation === 'driver-halt' || i.obligation === 'dispatch') return false;
    if (measuring(s, node, i.obligation, rt)) return false;
    if (!h && trunkParked(s, node).length) return false;
    if (i.obligation === 'approve' && waitingFor(s, node)) return false;
    if (review(i.obligation) && repairingBlock(s, node) && ownerNeeded(s, node) === undefined) return false;
    const bs = risks(s, node, i.obligation);
    const mergeFail = bs.some(b => { const e = entriesOf(s).find(e => e.seq === b.seq); return b.kind === 'exec' && e?.kind === 'obs' && e.merging === node && e.verdict === 'fail'; });
    const ownerHaltBlock = h?.needs === 'owner' && bs.some(b => b.kind === 'exec' && b.state === 'active');
    return i.discharger === 'owner' || i.discharger === 'parent' || mergeFail || ownerHaltBlock || (i.discharger === 'writer' && bs.some(b => sharedCheck(s, b)));
  }).map(i => obligationNeed(s, i));
  // N3 retains plan order inside obligation classes, irrespective of command lexical order.
  obligations.sort((a, b) => obligationOrder(a.obligation!) - obligationOrder(b.obligation!));
  if (h) {
    if (obligations.length) out.push(...obligations.map(o => ({ ...o, halted: true as const })));
    else {
      const stopped = writerStopNeed(h.reason, node), w = waitingFor(s, node), deps = [...new Set([...(w?.deps ?? []), ...(w?.after.split(', ') ?? [])])].filter(Boolean);
      out.push({ node, actor: 'parent', kind: stopped ? 'decide' : 'resume', since: h.seq, halted: true, text: stopped?.reason ?? `driver halted: ${haltReason(h.reason)}; after resume the driver continues from the current state${deps.length ? `, then waits for ${deps.join(', ')}` : ''}`, command: stopped?.command ?? `owed resume ${word(node)}`, ...(stopped ? { alternatives: [`owed resume ${word(node)}`] } : {}) });
    }
  } else out.push(...obligations);
  if (rt?.driverRunning === false && n.phase === 'ready' && !s.plan.nodes.find(n => n.id === node)?.later && !overlapping(s, node).length) out.push({ node, actor: 'parent', kind: 'dispatch', since: entriesOf(s).findLast(e => e.kind === 'plan' || e.kind === 'genesis')?.seq ?? null, text: 'ready to dispatch', command: `owed dispatch ${word(node)}` });
  return out;
}
/** Repository notices retain their membership; no command decides, rules or resumes trunk. */
export function repoNeeds(s: State, _rt?: Runtime): Need[] {
  const out: Need[] = [...trunkParkNotices(s), ...sharedParkNotices(s)].map(r => ({ node: 'trunk', actor: 'parent', kind: 'investigate', since: null, obligation: r.obligation, text: `no single command: ${oneLine(r.text.replace(/ To merge now:.*$/, ' To merge now, defer the invariant on each waiting candidate; to fix, add a node whose brief names the test.'))}` }));
  for (const i of s.invariants) {
    if (i.status !== 'D' || (i.discharger !== 'owner' && i.discharger !== 'parent')) continue;
    const red = trunkInvariantReds(s).find(r => r.obligation === i.obligation && r.key === i.key);
    const text = red?.text ?? `${i.obligation}: ${i.detail}`;
    if (out.some(n => n.obligation === i.obligation && n.text.includes(text))) continue;
    out.push({ node: 'trunk', actor: 'parent', kind: 'investigate', since: i.evidence.at(-1) ?? null, obligation: i.obligation, key: i.key, text: `no single command: ${oneLine(text)}; ${trunkDecision(s, i.obligation)}` });
  }
  return out;
}
/** The existing summary progress phase, with invocation-scoped measurement decoration only. */
export function activity(s: State, node: string, rt?: Runtime): Activity | undefined {
  const n = s.nodes[node], spec = s.plan.nodes.find(n => n.id === node);
  if (!n || n.merged || spec?.later || !(n.slot?.open || n.phase === 'blocked' || n.phase === 'held')) return;
  const ms = rt?.measuring?.filter(m => m.node === node) ?? [];
  if (ms.length) return { node, phase: 'measuring', text: ms.map(m => `measuring ${m.obligations.join(', ') || 'other'} since ${clockTime(m.since, Date.parse(m.since))} (attest pid ${m.pid})`).join('; ') };
  const w = waitingFor(s, node), deps = [...new Set([...(w?.deps ?? []), ...(w?.after.split(', ') ?? [])])].filter(Boolean), parked = trunkParked(s, node);
  const shared = parked.length || halted(s, node) ? [] : sharedParked(s, node);
  let text = parked.length ? `waiting: trunk-red (${[...new Set(parked.map(r => r.merge.obligation))].join(', ')} on trunk ${s.trunk.commit.slice(0, 12)})` : shared.length ? sharedPhase(s, shared) : deps.length ? `waiting for ${deps.join(', ')}`
    : n.phase === 'held' || halted(s, node) || unruledBlocks(s, node).some(b => !!n.candidate) || reportedOf(s, node) !== undefined ? 'held'
    : n.accepted ? 'accepted (merge pending)'
    : !n.candidate || n.phase === 'dispatched' || n.items.some(i => i.status === 'D' && i.discharger === 'writer') ? 'writing'
    : n.items.some(i => i.status === 'D' && i.discharger === 'executor') ? 'measuring'
    : n.items.some(i => i.status === 'D' && i.discharger === 'reviewer') ? 'reviewing' : 'held';
  const repair = repairingBlock(s, node);
  if (deps.length && spec?.approve === 'owner') text = `waiting for ${deps.join(', ')} (owner approval after)`;
  else if (repair) text = `repairing (block #${repair.seq})`;
  else if (n.blocks.some(b => heldFlaky(s, node, b) && n.items.some(i => i.obligation === b.obligation && i.discharger === 'executor'))) text = n.blocks.filter(b => heldFlaky(s, node, b) && n.items.some(i => i.obligation === b.obligation && i.discharger === 'executor')).map(b => heldFlakyText(s, node, b)).join('; ');
  if (n.phase === 'blocked' && !deps.length) text = `waiting for ${(spec?.deps ?? []).filter(id => !s.nodes[id]?.merged).join(', ')}`;
  const phase: Activity['phase'] = text.startsWith('waiting') ? 'waiting' : text.startsWith('accepted') ? 'accepted' : text.startsWith('repairing') ? 'repairing' : text === 'writing' ? 'writing' : text === 'measuring' ? 'measuring' : text === 'reviewing' ? 'reviewing' : 'held';
  return { node, phase, text };
}
/** Stable structured identity; text/alternatives do not alter the underlying obligation identity. */
export function needId(n: Need): string {
  return JSON.stringify([n.node, n.kind, n.obligation ?? null, n.block ?? null, n.key ?? null, n.candidate ?? null, n.rid ?? null, n.qid ?? null, n.rev ?? null]);
}
function trunkDecision(s: State, obligation: string): string {
  const key = s.trunk.invKeys[obligation.replace(/^inv:/, '')], es = entriesOf(s);
  const names = [...new Set(es.filter(e => e.kind === 'obs' && e.subject === 'trunk' && e.obligation === obligation && e.key === key && e.verdict === 'fail').flatMap(e => e.kind === 'obs' ? e.failed ?? [] : []))];
  return `fix ${names.slice(0, 3).map(oneLine).join(', ') || obligation}${names.length > 3 ? `, +${names.length - 3}` : ''}: add a repair node with the recorded plan; clears on the next trunk key`;
}
/** Keep the attribution pair, replacing only the incomplete embedded waiver command (C4). */
function flakyText(s: State, b: Block, hint = true): string {
  const text = flakyBlockText(s, b).replace(/owed waive [^)]*/, waive(s, b.node, b.obligation));
  return `${text}${hint ? `; or ${decision(b.node)} when the check or test itself must change` : ''}`;
}
/** Compact-why next line for one obligation; agent/executor work stays contextual, never a Need. */
export function itemLine(s: State, node: string, obligation: string, rt?: Runtime): string {
  const i = node === 'trunk' ? s.invariants.find(i => i.obligation === obligation) : s.nodes[node]?.items.find(i => i.obligation === obligation);
  if (!i) return '';
  if (i.status !== 'D') return oneLine(i.detail);
  const repair = repaired(s, node, obligation);
  if (repair) return repairLine(s, repair);
  if (measuring(s, node, obligation, rt)) return activity(s, node, rt)!.text;
  const need = (node === 'trunk' ? repoNeeds(s, rt) : needs(s, node, rt)).find(n => n.obligation === obligation);
  if (need) return `${need.text}${need.command ? ` → ${need.command}` : ''}`;
  const b = risks(s, node, obligation)[0];
  if (b) {
    if (b.state === 'flaky' && b.kind === 'exec') return heldFlaky(s, node, b) ? heldFlakyText(s, node, b) : flakyText(s, b);
    if (b.kind === 'exec') return `writer fixes and runs owed submit ${word(node)}, then owed attest ${word(node)} (the attribution rerun on the original content clears the block)`;
    const ruled = parentRuling(s, b);
    return `${ruled ? `the writer repairs with ruling #${ruled.seq}; then ` : ''}an ok review of ${node}/${obligation} on the current candidate by the original reviewer ${entriesOf(s).find(e => e.seq === b.seq)?.by ?? 'the original reviewer'} with rank >= ${b.rank}, or by any reviewer with rank > ${b.rank}, clears it`;
  }
  if (i.subject === 'trunk') return i.mark === '⊥' ? 'owed attest --trunk' : `no single command: ${trunkDecision(s, obligation)}`;
  if (obligation === 'approve') return `awaiting owner approval → ${approve(s, node)}`;
  if (obligation.startsWith('evidence:')) return `awaiting manual evidence → ${evidence(s, node, obligation, i.discharger ?? 'reviewer')}`;
  if (i.discharger === 'executor') return `${oneLine(i.detail)} → owed attest ${word(node)}`;
  if (i.discharger === 'writer') return `${oneLine(i.detail)}; the writer fixes it and runs owed submit ${word(node)}`;
  if (i.discharger === 'reviewer') {
    const rank = obligation === 'closure-review' ? 2 : nodeReview(s, node).min_rank;
    const role = rank > 2 ? 'owner' : 'reviewer';
    return `${oneLine(i.detail)}; ${role === 'owner' ? 'an owner' : 'a reviewer'} records owed review ${word(node)}${obligationFlag(obligation)} --ok --rank ${rank}${candidateFlag(s, node)} --note "<note>" --ack-rulings latest --as ${role}:<id>`;
  }
  return oneLine(i.detail);
}
