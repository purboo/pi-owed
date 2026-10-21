import type { Block, Entry, ItemView, ObsEntry, RuleEntry, State } from './types.ts';
import type { GenesisStatus, KnownRedDebt } from './views.ts';
import type { TrunkDrift } from './git.ts';
import type { IdleCounts } from './drive-run.ts';
import type { SlotGitOperation } from './rebase-view.ts';
import type { Activity, Need, Runtime } from './needs-types.ts';
import { driveConfig } from './plan.ts';
import { clockTime } from './clock.ts';
import { applicableRules, entriesOf, planAt, previousSubmit, awaitingRuling, parentRuling, ownerNeeded, readyDispatchSkips, overlapping, halted, waitingFor, reportedOf, heldFlaky, heldFlakyText, flakyBlockText, nodeReview, sharedFailure, fixCandidates, sharedNames, sharedParked, sharedParkNotices, sharedPhase, trunkParked, trunkParkNotices, trunkRedOf, trunkRedText, trunkInvariantReds } from './reducer.ts';
import { shellQuote } from './exec-wrap.ts';
export type { Need, NeedKind, Activity, Measuring, Asking, Runtime } from './needs-types.ts';

const counts = (b: Block): boolean => b.state === 'active' || b.state === 'flaky';
const review = (o: string): boolean => o === 'review' || o === 'closure-review';
const oneLine = (text: string): string => text.replace(/[\\\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, c => c === '\\' ? '\\\\' : c === '\n' ? '\\n' : c === '\r' ? '\\r' : c === '\t' ? '\\t' : `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
const plain = (text: string): string => oneLine(text.replace(/#[0-9]+\s*/g, '').split(';')[0]!.trim());
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
/** SM4: keep escaped code points whole; prefer a late sentence, then whitespace/CJK. */
export function boundaryClip(text: string, max: number, escape: (s: string) => string = s => s, mark = '…'): string {
  const points = Array.from(text), tokens = points.map(escape), sizes = tokens.map(t => Array.from(t).length);
  if (sizes.reduce((a,b) => a+b,0) <= max) return tokens.join('');
  let length = 0, end = 0, sentence = 0, boundary = -1;
  for (; end < points.length && length + sizes[end]! <= max-mark.length; end++) {
    length += sizes[end]!;
    const cp = points[end]!;
    if ((/[.!?;]/u.test(cp) && (end+1 === points.length || /\s/u.test(points[end+1]!)) || /[\u3002\uff01\uff1f\uff1b]/u.test(cp)) && length >= max*0.6) sentence = end+1;
    if (/\s/u.test(cp)) boundary = end;
    else if (/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(cp)) boundary = end+1;
  }
  return tokens.slice(0,sentence || (boundary >= 0 ? boundary : end)).join('').trimEnd() + mark;
}
function reviewAsk(note: string): string {
  const marker = /BLOCK\s*\(needs parent\)\s*:|Parent decision needed\s*:|needs parent/i.exec(note);
  const tail = marker ? note.slice(marker.index + marker[0].length).replace(/^[\s):—-]+/, '') : note.trim().match(/[^.!?]+[.!?]*\s*$/)?.[0] ?? note;
  return boundaryClip(tail.trim().replace(/\s+/g, ' '),300,oneLine);
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
function parseWriterStop(text: string, command: string): { reason: string; command: string } | undefined {
  const suffix = ` → ${command}`;
  if (!text.endsWith(suffix)) return;
  const match = /(?:^|; )(writer says: "(?:[^"\\]|\\.)*"(?: \((?:commits: [0-9a-fA-F, ]+(?:; durable: [0-9A-HJKMNP-TV-Z, ]+)?|durable: [0-9A-HJKMNP-TV-Z, ]+)\))?|writer gave no final text)((?:; awaiting durable [^\r\n]+? \((?:pending|running|finished)\))*)(; dsa ended \d+ processes at seal: [^\r\n]*)?$/.exec(text.slice(0, -suffix.length));
  return match ? { reason: match.slice(1).filter(Boolean).join(''), command } : undefined;
}
const needsWriterStopNeed = (text: string, node: string) => parseWriterStop(text, decision(node));
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
const activeReviewBlock = (s: State, node: string, obligation: string): boolean => review(obligation) && risks(s, node, obligation).some(b => b.kind === 'judgment' && b.state === 'active' && b.key === s.nodes[node]?.candidate?.keys[obligation]);
/** C3 applies to submitted, changed-key repairs with no active review judgment on the current key. */
function repaired(s: State, node: string, obligation: string): Block | undefined {
  const c = s.nodes[node]?.candidate;
  if (!c || activeReviewBlock(s, node, obligation)) return;
  return risks(s, node, obligation).find(b => b.kind === 'judgment' && b.state === 'active' && review(b.obligation) && c.seq > b.seq && c.keys[obligation] !== b.key);
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
/** PB2/R-029-2: only newly marked anonymous merge-check blocks add output; old notes render identically. */
function mergeOutput(s: State, i: ItemView): string {
  if (!i.obligation.startsWith('check:')) return '';
  const seqs = new Set(risks(s,i.subject,i.obligation).map(b => b.seq));
  const obs = entriesOf(s).findLast(e => e.kind === 'obs' && seqs.has(e.seq) && e.verdict === 'fail' && e.merging === i.subject && !e.failed?.length && /\nmerge failure output: [^\n]{1,160}$/.test(e.note ?? ''));
  return obs?.kind === 'obs' ? ` — ${obs.note!.slice(obs.note!.lastIndexOf('\nmerge failure output: ') + '\nmerge failure output: '.length)}` : '';
}
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
    : `${i.obligation}: ${flaky ? flakyText(s, flaky, false) : plain(i.detail)}${mergeOutput(s,i)}`);
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
    return { ...base, actor: 'parent', kind: 'decide', text, command: decision(node), ...(!activeReviewBlock(s, node, i.obligation) ? { alternatives: [ownerReview(s, node, i.obligation)] } : {}) };
  }
  if (i.obligation.startsWith('inv:')) return { ...base, kind: 'defer', text, command: `owed defer ${word(node)} ${word(i.obligation.slice(4))} --reason "<reason>" --as ${owner}` };
  return { ...base, kind: 'waive', text, command: waive(s, node, i.obligation) };
}
/** HD1: the active halt already incorporates clearsHalt; only a later named decision holds it. */
export function heldRuling(s: State, node: string): RuleEntry | undefined {
  const h = halted(s, node);
  return h && entriesOf(s).findLast((e): e is RuleEntry => e.kind === 'rule' && e.decision !== undefined && e.seq > h.seq && !e.prospective && e.nodes !== '*' && e.nodes.includes(node));
}
export const resumeCommand = (node: string): string => `owed resume ${word(node)}`;
export const heldRulingText = (node: string, seq: number): string => `held by ruling #${seq}; ${resumeCommand(node)} releases it`;
/** RM1: ordered recovery commands; changing the agent affects only later reviewer launches. */
export function reviewMissingRemedies(node: string, builtin = false, retryable = true): string[] {
  return [...(retryable ? [resumeCommand(node)] : []), ...(builtin ? ['owed edit --drive --set reviewer.agent=owed-reviewer --note "<why>"'] : []),
    `owed review ${word(node)} --ok|--block --rank <1-3> --note "<note>" --as owner:<id>`, `owed abandon ${word(node)}`];
}
/** RM1: persisted remedies identify the historical agent even after the plan changes. */
function reviewMissingNeed(s: State, node: string): Need | undefined {
  const h = halted(s, node);
  if (!h?.reason.startsWith('review-missing:') || heldRuling(s, node)) return;
  const launch = s.nodes[node]?.runs.find(r => r.attempt === h.attempt)?.launches.find(l => l.role === 'reviewer' && h.reason.startsWith(`review-missing: reviewer run ${l.rid} `));
  const builtin = h.reason.includes('; remedies: ')
    ? h.reason.includes('owed edit --drive --set reviewer.agent=owed-reviewer')
    // R-031-RA-4: a defaulted launch-time plan cannot distinguish the 0.30 and 0.31 agents.
    : !!launch && ['reviewer', 'owed-reviewer'].includes(driveConfig(planAt(s, launch.seq), node).reviewer.agent);
  const retryable = h.reason.includes('; remedies: ')
    ? h.reason.includes(`; remedies: ${resumeCommand(node)};`) : !h.reason.includes(' sealed rejected');
  const [command, ...alternatives] = reviewMissingRemedies(node, builtin, retryable);
  return { node, actor: 'parent', kind: 'resume', since: h.seq, halted: true,
    text: `driver halted: ${haltReason(h.reason)}; ${retryable ? 'resume asks the same reviewer run again' : 'this run cannot take follow-ups'}${builtin ? '; builtin reviewer is read-only and may refuse to record; the agent edit applies to a new reviewer run of a later candidate' : ''}`, command: command!, alternatives };
}
/** Pure parent/owner needs: baseline summary membership, corrected by C1–C9 and N1–N7. */
export function needs(s: State, node: string, rt?: Runtime): Need[] {
  const n = s.nodes[node];
  if (!n || n.merged) return [];
  const h = halted(s, node), out: Need[] = [];
  const stopped = h && !heldRuling(s, node) ? needsWriterStopNeed(h.reason, node) : undefined;
  if (stopped) out.push({ node, actor: 'parent', kind: 'decide', since: h!.seq, halted: true, text: stopped.reason, command: stopped.command, alternatives: [`owed resume ${word(node)}`] });
  for (const a of rt?.asking ?? []) if (a.node === node) {
    const e = entriesOf(s).findLast(e => e.kind === 'rule' && (e.answers ?? (e.answer ? [e.answer] : [])).some(ref => ref.rid === a.rid && ref.qid === a.qid && ref.rev >= a.rev));
    const text = (a.text.startsWith(`${node}: `) ? a.text.slice(node.length + 2) : a.text).split(': retry with ', 1)[0]!;
    if (e?.kind === 'rule' && n.slot?.open) out.push({ node, actor: 'parent', kind: 'answer', since: e.seq, rid: a.rid, qid: a.qid, rev: a.rev, text: /asks \(qid [^)]*\): DECISION: [^\n]*\noptions:/.test(text) ? text : oneLine(text), command: answerRetry(node, e, { rid: a.rid, qid: a.qid, rev: a.rev }), ...(h ? { halted: true } : {}) });
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
    const missing = reviewMissingNeed(s, node);
    if (missing) out.push(missing);
    if (obligations.length) out.push(...obligations.map(o => ({ ...o, halted: true as const })));
    else if (!missing && !stopped && !heldRuling(s, node)) {
      const w = waitingFor(s, node), deps = [...new Set([...(w?.deps ?? []), ...(w?.after.split(', ') ?? [])])].filter(Boolean);
      out.push({ node, actor: 'parent', kind: 'resume', since: h.seq, halted: true, text: `driver halted: ${haltReason(h.reason)}; after resume the driver continues from the current state${deps.length ? `, then waits for ${deps.join(', ')}` : ''}`, command: `owed resume ${word(node)}` });
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
    out.push({ node: 'trunk', actor: 'parent', kind: 'investigate', since: i.evidence.at(-1) ?? null, obligation: i.obligation, key: i.key, text: `no single command: ${oneLine(text)}; ${trunkRepairText(s, i.obligation)}` });
  }
  return out;
}
/** RW2: a candidate keeps its phase unless this attempt's writer owes a repair/ruling resubmit. */
export function writerWaitingEligible(s: State, node: string): boolean {
  const n = s.nodes[node], c = n?.candidate, ar = n?.runs.find(r => r.attempt === n.slot?.attempt);
  const writer = ar?.launches.find(l => l.role === 'writer');
  return !!n && (!c || !!ar?.sends.some(x => x.rid === writer?.rid && x.seq > c.seq && x.sendKind === 'follow-up' && (x.reason === 'repair' || x.reason === 'ruling')));
}

/** The existing summary progress phase, with invocation-scoped measurement decoration only. */
export function activity(s: State, node: string, rt?: Runtime): Activity | undefined {
  const n = s.nodes[node], spec = s.plan.nodes.find(n => n.id === node);
  if (!n || n.merged) return;
  const held = heldRuling(s, node);
  if (held) return { node, phase: 'held', text: heldRulingText(node, held.seq) };
  if (spec?.later || !(n.slot?.open || n.phase === 'blocked' || n.phase === 'held')) return;
  const wait = rt?.driverRunning ? rt.writerWaiting?.find(w => w.node === node && w.attempt === n.slot?.attempt) : undefined;
  if (wait && writerWaitingEligible(s, node) && !halted(s, node)) return { node, phase: 'waiting', text: `writer waiting on durable ${wait.awaiting.map(a => `${oneLine(a.request)} (${a.state}, ${Math.floor(Math.max(0, (rt?.now ?? Date.now()) - wait.since) / 1000)}s)`).join(', ')}` };
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
function trunkRepairText(s: State, obligation: string): string {
  const key = s.trunk.invKeys[obligation.replace(/^inv:/, '')], es = entriesOf(s);
  const names = [...new Set(es.filter(e => e.kind === 'obs' && e.subject === 'trunk' && e.obligation === obligation && e.key === key && e.verdict === 'fail').flatMap(e => e.kind === 'obs' ? e.failed ?? [] : []))];
  return `fix ${names.slice(0, 3).map(oneLine).join(', ') || obligation}${names.length > 3 ? `, +${names.length - 3}` : ''}: add a repair node with the recorded plan; clears on the next trunk key`;
}
/** Keep the attribution pair, replacing only the incomplete embedded waiver command (C4). */
function flakyText(s: State, b: Block, hint = true): string {
  const text = flakyBlockText(s, b).replace(/owed waive [^)]*/, waive(s, b.node, b.obligation));
  return `${text}${hint ? `; or ${decision(b.node)} when the check or test itself must change` : ''}`;
}
/** TF2: current trunk-red wins; other complete shared node-check failures retain their unchanged gates. */
export function sharedCheckHint(s: State, b: Pick<Block,'seq'|'key'>): string | undefined {
  if (trunkRedHint(s,b.seq,b.key)) return undefined;
  const e = entriesOf(s).find(e => e.seq === b.seq);
  if (e?.kind !== 'obs' || e.probe !== undefined || !e.obligation.startsWith('check:')) return undefined;
  const r = sharedFailure(s,e,e.subject);
  if (!r) return undefined;
  const fix = fixCandidates(s,e.subject,r.names)[0]?.id;
  return [...new Map(r.trunk.map(p => [p.seq,p])).values()].map(probe => `${e.obligation} block #${b.seq} also fails on trunk ${probe.commit.slice(0,12)} without ${e.subject} (probe #${probe.seq}: ${sharedNames(r.names.filter(n => probe.failed?.includes(n)))}): not this node's change → owed waive ${e.subject} ${e.obligation} --accept-risk ${b.seq} --tracked-by ${fix ?? '<fix>'} --reason "<why>"${fix ? '' : ' (add a fix node first)'}`).join('; ');
}
/** TR: parent choices; the failing merge observation is the waiver risk, never the probe. */
export function trunkRedHint(s: State, seq: number, key?: string): string | undefined {
  const r = trunkRedOf(s, seq, key);
  if (!r) return undefined;
  return `${trunkRedText(r)}; merge-tree obs #${r.merge.seq}, trunk probe #${r.probe.seq}; this candidate is not shown to be the cause; parent: fix trunk with a fixing node${s.plan.sweep ? `, or owed sweep --commit ${s.trunk.commit} for its bisect/escape proposal` : ''}; or owed waive ${r.merge.subject} ${r.merge.obligation} --accept-risk ${r.merge.seq}`;
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
    const diagnosis = trunkRedHint(s, b.seq, b.key) ?? sharedCheckHint(s, b);
    if (diagnosis) return `${diagnosis}${b.state === 'flaky' && b.kind === 'exec' ? `; ${heldFlaky(s, node, b) ? heldFlakyText(s, node, b) : flakyText(s, b)}` : ''}`;
    if (b.state === 'flaky' && b.kind === 'exec') return heldFlaky(s, node, b) ? heldFlakyText(s, node, b) : flakyText(s, b);
    if (b.kind === 'exec') return `writer fixes and runs owed submit ${word(node)}, then owed attest ${word(node)} (the attribution rerun on the original content clears the block)`;
    const ruled = parentRuling(s, b);
    return `${ruled ? `the writer repairs with ruling #${ruled.seq}; then ` : ''}an ok review of ${node}/${obligation} on the current candidate by the original reviewer ${entriesOf(s).find(e => e.seq === b.seq)?.by ?? 'the original reviewer'} with rank >= ${b.rank}, or by any reviewer with rank > ${b.rank}, clears it`;
  }
  if (i.subject === 'trunk') return i.mark === '⊥' ? 'owed attest --trunk' : `no single command: ${trunkRepairText(s, obligation)}`;
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

// Legacy packet and recovery builders retain their exact text; selection above is unchanged.
export const writerDecisionCommand = (node: string): string => `owed decide ${node} --text "<ruling>" --writer`;
export const writerParkCommand = (node: string): string => `owed decide ${node} --expect report --text "<pause ruling>"`;
/** WS2: parse only owed's own trailer; writer text cannot choose a different next command. */
export function writerStopNeed(text: string, node: string): { reason: string; command: string } | undefined {
  return parseWriterStop(text, writerDecisionCommand(node));
}
export const reviewDecision = (node: string): string => `owed decide ${node} --text "<ruling>" --writer`;
/** AK2: repair advice is grounded in the recorded plan and failures, never a placeholder. */
export function trunkDecision(s: State | undefined, obligation: string, failed?: readonly string[], history?: readonly Entry[]): string {
  const es = history ?? (s ? entriesOf(s) : []);
  const key = s?.trunk.invKeys[obligation.replace(/^inv:/,'')];
  const names = [...new Set(failed ?? es.filter((e): e is ObsEntry => e.kind === 'obs' && e.subject === 'trunk' && e.obligation === obligation && e.key === key && e.verdict === 'fail').flatMap(e => e.failed ?? []))];
  const tests = names.slice(0,3).map(oneLine).join(', ') || obligation;
  const law = es.findLast(e => e.kind === 'plan' || e.kind === 'genesis');
  const path = law && (law.kind === 'plan' || law.kind === 'genesis') ? law.path : undefined;
  const command = path ? `owed plan ${/^[\w./-]+$/.test(path) ? path : JSON.stringify(path)}, or owed edit --node-new` : 'owed edit --node-new';
  const defers = s?.deferred.filter(d => `inv:${d.id}` === obligation && (d.key === key || d.seq > (s.nodes[d.node]?.slot?.dispatchSeq ?? Infinity))) ?? [];
  return `fix ${tests}${names.length > 3 ? `, +${names.length - 3}` : ''}: add a repair node (${command}) — clears on the next trunk key${defers.map(d => `; deferred for ${d.node} #${d.seq}`).join('')}`;
}
/** D23: the command that records manual evidence `id` of `node` as principal `as`; `candidate` (G1.3): the commit (prefix) it names. */
export const evidenceCommand = (node: string, id: string, as: string, candidate?: string): string => `owed evidence ${node} ${id} --file <path> --note "<what was checked>" --as ${as}${candidate ? ` --candidate ${candidate}` : ''}`;
/** DC4: one decision gives acknowledged guidance and releases the halt; no-resume preserves it. */
export function resumeCommands(node = '<node>'): string { return `owed decide ${node} --text "<decision>" (add --after <node> to wait until that node merges; --no-resume keeps it halted)`; }
/**
 * 0.8 (L3.2, app #21): offered wherever owed tells the owner what to do about a flaky block, next to the waiver: when the
 * check or test itself must change, a ruling sends the writer to fix it.
 */
export const flakyRuleHint = (node: string): string => `or owed decide ${node} --writer --text "<what the writer must change>" when the check or test itself must change (the writer fixes it; the block stays flaky until a plan change of the check's definition supersedes it, or the owner waives it once the fixed candidate passes)`;
export const lapsedKnownRedText = (d: KnownRedDebt): string => `inv:${d.invariant} lapsed known_red: ${d.entries.map(e => `${oneLine(e.test)} (fix: ${oneLine(e.fix)})`).join(', ')}; plan #${d.plan}; removable: owed edit --invariant ${d.invariant} --set known_red='<remaining active entries>' --note "remove lapsed entries"`;
export const overlapDispatchCommand = (node: string): string => `owed dispatch ${node} --allow-overlap`;
/** The hint line: CLI `owed drive --detach --stay`, pi `owed_drive {action:"start", stay:true}`. */
export const readyHintText = (ready: readonly string[], surface: 'cli' | 'pi'): string => `ready: ${ready.join(', ')} (${ready.length}); no driver is running: ${surface === 'cli' ? 'owed drive --detach --stay' : 'owed_drive {action:"start", stay:true} (CLI: owed drive --detach --stay)'}`;
/** `Genesis: k/n invariants observed` plus where the rest gets measured (D24.5). */
export function genesisLine(g: GenesisStatus): string {
  return `Genesis: ${g.observed}/${g.total} invariants observed ${g.measuring ? '(measuring in this session)' : '— run owed attest --genesis (or the next attest/merge measures them)'}; pending: ${g.pending.join(', ')}`;
}
export const idleWaitText = (c: IdleCounts): string => `idle: ${c.ready} ready, ${c.open} open, ${c.waiting} waiting, ${c.reported} reported, ${c.later} later; staying until the ledger changes (owed drive --stop ends it)`;
/**
 * Trunk drift (review ruling #559, option c): the trunk ref no longer equals the ledger trunk. It is a repository fact,
 * not a node fact: never a ledger halt. The text of the repo-level owner notify: a fast-forward is adopted, anything
 * else (rewound, rewritten, missing) is restored.
 */
export function driftNotice(name: string, d: TrunkDrift): string {
  const ledger = d.ledger.slice(0, 12), ref = d.commit ? d.commit.slice(0, 12) : 'missing';
  // G3.4c: the ledger's trunk commit is gone, so neither update-ref nor adopt (it checks a fast-forward from it) works yet.
  if (d.relation === 'ledger-missing') return `trunk ${name}: the ledger's trunk commit ${ledger} is absent from the repository, so git update-ref cannot restore it and owed adopt cannot check a fast-forward from it; bring the commit back (git fetch <remote> ${d.ledger} from any remote or clone that has it), then restore trunk (git update-ref refs/heads/${name} ${d.ledger} ${d.commit ?? '""'}) or adopt the current ref (owed adopt --commit ${ref} --note "<why>")`;
  return d.relation === 'ahead'
    ? `trunk ${name} moved outside owed (${ledger} → ${ref}); the main agent resolves it with: owed adopt --note "<why>"`
    : `trunk ${name} was rewound or rewritten (${ledger} → ${ref}); restore it: git update-ref refs/heads/${name} ${d.ledger} ${d.commit ?? '""'}`;
}
/**
 * SB1/SB3: what is wrong with a candidate that already contains trunk commits after its slot base (its writes would
 * be diffed against the old base and claim other nodes' merged paths) and the fix: the SB2 rebase command.
 */
export const trunkAfterBaseText = (node: string, commit: string, base: string, latest: string, trunk: string): string =>
  `commit ${commit.slice(0,12)} contains trunk commits after its slot base ${base.slice(0,12)} (latest ${latest.slice(0,12)}); run owed rebase ${node}, then in the slot worktree run \`git rebase --onto ${trunk} ${latest}\`, then submit again`;
/**
 * Ending of a halt for a run dsa rejected (D15.1): its id and bytes are fixed for the attempt and dsa answers the
 * same id the same way, so clearing the halt only re-halts; a new attempt is the recovery.
 */
export const rejectedFixed = (node: string): string => `this attempt's request is fixed; fix the cause (plan, agent, model), then \`owed abandon ${node}\` to start a new attempt`;
/** SR4: a rejected send can be superseded without losing the attempt; rejected runs keep D15.1. */
export const rejectedHalt = (node: string, what: 'run' | 'send', id: string, reason: string): string => `dsa rejected ${what} ${id}: ${oneLine(reason)}; ${what === 'run' ? rejectedFixed(node) : `the attempt is not lost: continue the run (e.g. a dsa follow-up), then \`owed decide ${node} --text "<retry run>"\`; a later resume, submit or send to this run supersedes this send; or \`owed abandon ${node}\``}`;
const shell = (s: string): string => /[\r\n]/.test(s) ? `$'${s.replaceAll('\\','\\\\').replaceAll("'","\\'").replaceAll('\n','\\n').replaceAll('\r','\\r')}'` : `'${s.replaceAll("'", "'\\''")}'`;
export const answerRetry = (node: string, entry: RuleEntry, ref?: import('./types.ts').AnswerRef): string => {
  const a = ref ?? entry.answers?.find(a => a.node === node) ?? entry.answer!;
  // The prefix's exact length avoids treating punctuation in a qid as answer text.
  const role = entry.text.startsWith('Answer to writer question ') ? 'writer' : 'reviewer';
  const text = entry.answers ? entry.text : entry.text.slice(`Answer to ${role} question ${a.qid}: `.length);
  return `owed answer ${shell(node)} --rid ${shell(a.rid)} --qid ${shell(a.qid)} --rev ${a.rev} -- ${shell(text)}`;
};
export function rebaseRecovery(head: string, original: string | undefined, inProgress: boolean | SlotGitOperation | undefined, base?: string, node?: string): string | undefined {
  if (inProgress) return typeof inProgress === 'string'
    ? `Git operation in progress; run \`git ${inProgress} --abort\`, then follow the rebase instruction.`
    : 'Git operation in progress; run `git rebase --abort` (or `git merge --abort` for a merge), then follow the rebase instruction.';
  if (original && head !== original) return `HEAD differs from last submitted candidate ${original.slice(0,12)}; keep: check \`git log ${base ?? '<slot base>'}..HEAD\` holds only this node's commits, run the focused tests, then \`owed submit ${node ?? '<node>'}\`; reset: \`git reset --hard ${original}\`, then \`git rebase --onto ${base ?? '<slot base>'} $(git merge-base HEAD ${base ?? '<slot base>'})\`.`;
  return undefined;
}
const sweepQuote = (text: string): string => `'${text.replaceAll("'", "'\\''")}'`;
export const sweepEscapeCommand = (node: string, seq: number, note: string): string => `owed escape ${sweepQuote(node)} --merge ${seq} --class missing --note ${sweepQuote(note)}`;
export const setupHint = (signature: string, nodes: string): string => `setup failure (no tests ran): ${signature} — likely the environment; fix it, then owed decide ${nodes} --remeasure`;
/**
 * K5.3: the threshold hint for the measured items, or undefined: for a check X among them, the node's latest two
 * failing, non-attribution observations of `check:X` both exited 0 with no failing test and counted the same number of
 * tests, below X's current `min_tests`, and no ruling naming the node (not `*`) was recorded after the later one (after
 * such a ruling the repair path runs).
 */
export function thresholdHint(s: State, node: string, obligations: readonly string[]): string | undefined {
  const spec = s.plan.nodes.find(x => x.id === node), named = applicableRules(s, node).findLast(r => r.nodes !== '*' && r.nodes.includes(node));
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
