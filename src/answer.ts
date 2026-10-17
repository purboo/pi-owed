// AN1–AN2: discover a question, durably record the ruling, then deliver with a stable dsa request id.
import { Dsa } from './dsa.ts';
import type { SendResult } from './dsa.ts';
import { OwedError } from './errors.ts';
import { sha256 } from './canon.ts';
import { answerRule, readState, subagentRefusal } from './ops.ts';
import type { Channel, LaunchEntry, Principal, RuleEntry, RunQuestion, State } from './types.ts';
import { nodeReview } from './reducer.ts';
import { oneLine } from './views.ts';
import { ruleAnswers } from './reducer.ts';

export interface AnswerOptions { cwd: string; as: Principal; channel?: Channel; node: string; text: string; qid?: string; rid?: string; rev?: number; dsa?: Pick<Dsa, 'describe' | 'send'> }
export interface AnswerResult { entry: RuleEntry; request: string; delivery: SendResult; rulingDelivery?: RulingDelivery }
export interface RulingDelivery { delivered: string[]; pending: number; failures: string[]; slots?: { node: string; writer?: string; followUp: string }[]; finished?: { node: string; writer: string }[] }
/** DR4: runtime receipt only. Notify once after committing the rule, with no ledger writes or retry loop. */
export async function deliverRuling(cwd: string, entry: RuleEntry, client?: Pick<Dsa, 'describe' | 'send'>, exclude?: string): Promise<RulingDelivery> {
  const { state } = await readState({ cwd }), dsa = client ?? new Dsa({ cwd, timeoutMs: 5000 });
  const { rulingFollowUp, rulingMessage } = await import('./drive.ts');
  const result: RulingDelivery = { delivered: [], pending: 0, failures: [] };
  if (entry.prospective) return result;
  const ids = entry.nodes === '*' ? state.plan.nodes.map(n => n.id) : entry.nodes;
  for (const id of ids) {
    const n = state.nodes[id];
    if (n?.merged) continue;
    const launches = n?.slot?.open ? n.runs.find(r => r.attempt === n.slot!.attempt)?.launches ?? [] : [];
    const writer = launches.findLast(l => l.role === 'writer');
    const followUp = rulingFollowUp(state, id)?.message ?? rulingMessage(id, 'writer', state.rules.filter(r => r.seq === entry.seq));
    if (n?.slot?.open) (result.slots ??= []).push({ node: id, ...(writer ? { writer: writer.rid } : {}), followUp });
    for (const role of ['writer', 'reviewer'] as const) {
      const calls = launches.filter(l => l.role === role && l.rid !== exclude && !ruleAnswers(entry).some(a => a.rid === l.rid));
      if (!calls.length) {
        const needsRole = role === 'writer' || nodeReview(state, id).count > 0 || n?.candidate?.closureTouched;
        if (needsRole && !launches.some(l => l.role === role && (l.rid === exclude || ruleAnswers(entry).some(a => a.rid === l.rid)))) result.pending++;
        continue;
      }
      for (const launch of calls) {
        const address = `${id}/${role}`;
        try {
          const view = await dsa.describe(launch.rid);
          if (view.state !== 'running' && view.state !== 'asking') { result.pending++; if (launch.rid === writer?.rid) (result.finished ??= []).push({ node: id, writer: launch.rid }); continue; }
          const followUp = rulingFollowUp(state, id)?.message;
          const message = launch.role === 'reviewer' ? rulingMessage(id, 'reviewer', state.rules.filter(r => r.seq === entry.seq))
            : followUp?.includes(`#${entry.seq} `) || followUp?.includes(`#${entry.seq} (`) ? followUp : rulingMessage(id, 'writer', state.rules.filter(r => r.seq === entry.seq));
          const sent = await dsa.send(`owed-rule-${entry.seq}-${launch.rid}-${sha256(message).slice(0,12)}`, launch.rid, 'notify', message);
          if (sent.outcome !== 'applied') throw new Error(`${sent.outcome}${'reason' in sent && sent.reason ? `: ${sent.reason}` : ''}`);
          result.delivered.push(address);
        } catch (e) { result.failures.push(`${address} (${launch.rid}): ${oneLine((e as Error).message)}`); }
      }
    }
  }
  return result;
}
export function rulingDeliveryText(r: RulingDelivery): string {
  return `delivered to ${r.delivered.length} running calls (${r.delivered.join(', ')}); ${r.pending} will get it at their next dispatch or follow-up${r.failures.length ? `; delivery failures: ${r.failures.join('; ')}` : ''}${!r.delivered.length ? (r.slots ?? []).map(s => `\n${s.node}: writer call ${s.writer ?? 'unknown'}; send follow-up${s.writer ? ` to ${s.writer}` : ' to the slot writer'}: ${JSON.stringify(s.followUp)}`).join('') : ''}`;
}
/** LO3: receipts stay brief; full follow-ups remain plain strings in delivery.slots. */
function rulingDeliveryWarnings(r: RulingDelivery): string[] {
  const failures = r.failures.map(f => {
    const node = f.split('/')[0]!.split(':')[0]!;
    return `${oneLine(node)}: ${oneLine(f.slice(node.length).replace(/^\//, ''))}; owed why ${oneLine(node)} shows the ruling to forward`;
  });
  const unknown = (r.slots ?? []).filter(s => !s.writer).map(s => `${oneLine(s.node)}: writer call unknown; owed why ${oneLine(s.node)} shows the ruling to forward`);
  // WS-R3: a known writer call that has finished cannot take a notify; rule never sends follow-ups itself.
  const finished = (r.finished ?? []).map(f => `${oneLine(f.node)}: writer call ${oneLine(f.writer)} has finished, so the ruling was recorded but not sent now; the driver delivers it on its next pass; if ${oneLine(f.node)} is halted, run owed resume ${oneLine(f.node)} (owed decide records and resumes in one step)`);
  return [...failures, ...unknown, ...finished];
}
export function ruleText(r: RuleEntry & { delivery?: RulingDelivery }): string {
  const delivery = r.delivery ?? { delivered: [], pending: 0, failures: [] };
  const nodes = r.nodes === '*' ? 'all nodes' : r.nodes.join(', ');
  return [`Recorded #${r.seq} ruling (${nodes}); delivered ${delivery.delivered.length}/${delivery.delivered.length + delivery.pending + delivery.failures.length}`, ...rulingDeliveryWarnings(delivery)].join('\n');
}
type Question = { launch: LaunchEntry; question: RunQuestion };
const shell = (s: string): string => /[\r\n]/.test(s) ? `$'${s.replaceAll('\\','\\\\').replaceAll("'","\\'").replaceAll('\n','\\n').replaceAll('\r','\\r')}'` : `'${s.replaceAll("'", "'\\''")}'`;
export const answerRetry = (node: string, entry: RuleEntry, ref?: import('./types.ts').AnswerRef): string => {
  const a = ref ?? entry.answers?.find(a => a.node === node) ?? entry.answer!;
  // The prefix's exact length avoids treating punctuation in a qid as answer text.
  const role = entry.text.startsWith('Answer to writer question ') ? 'writer' : 'reviewer';
  const text = entry.answers ? entry.text : entry.text.slice(`Answer to ${role} question ${a.qid}: `.length);
  return `owed answer ${shell(node)} --rid ${shell(a.rid)} --qid ${shell(a.qid)} --rev ${a.rev} -- ${shell(text)}`;
};
/** AR2: only use history after inspecting the current attempt for an open question. */
function recorded(entries: RuleEntry[], o: AnswerOptions, current: LaunchEntry[]): RuleEntry | undefined {
  if (o.qid === undefined) return undefined;
  const matches = entries.flatMap(e => e.nodes !== '*' && e.nodes.includes(o.node) ? ruleAnswers(e).filter(a => a.qid === o.qid
    && (o.rid !== undefined ? a.rid === o.rid : current.some(l => l.rid === a.rid))
    && (o.rev === undefined || a.rev === o.rev)).map(a => ({...e,answer:a})) : []);
  // Without a rid, history must identify exactly one current-attempt run.
  if (new Set(matches.map(e => e.answer!.rid)).size !== 1) return undefined;
  return matches.at(-1);
}
function launches(s: State, node: string): LaunchEntry[] {
  const n = s.nodes[node];
  if (!n) throw new OwedError(`Node ${node} does not exist`);
  if (!n.slot?.open) throw new OwedError(`Node ${node} has no open slot; open questions: none`);
  return n.runs.find(a => a.attempt === n.slot!.attempt)?.launches ?? [];
}
export async function answer(o: AnswerOptions): Promise<AnswerResult> {
  if (!['parent', 'owner'].includes(o.as.role)) throw new OwedError('answer requires parent or owner');
  const refusal = subagentRefusal(o.as.role); if (refusal) throw new OwedError(refusal);
  if (o.as.role === 'parent' && o.as.id === 'drive') throw new OwedError('the driver never answers questions');
  if (typeof o.text !== 'string' || !o.text.trim()) throw new OwedError('answer requires nonempty text');
  for (const id of ['qid', 'rid'] as const) if (o[id] !== undefined && (typeof o[id] !== 'string' || !o[id]!.trim())) throw new OwedError(`answer ${id} must be nonempty`);
  if (o.rev !== undefined && (!Number.isSafeInteger(o.rev) || o.rev < 1)) throw new OwedError('answer rev must be a positive integer', 'usage');
  const dsa = o.dsa ?? new Dsa({ cwd: o.cwd }), { entries, state } = await readState(o);
  if (!state.nodes[o.node]) throw new OwedError(`Node ${o.node} does not exist`);
  const current = state.nodes[o.node]!.slot?.open ? launches(state, o.node) : [];
  // Inspect all current launches even when qid is supplied: qids can repeat across writer/reviewer runs.
  const questions: Question[] = (await Promise.all(current.map(async launch => {
    const view = await dsa.describe(launch.rid);
    return view.state === 'asking' ? (view.questions ?? []).map(question => ({ launch, question })) : [];
  }))).flat();
  const selected = questions.filter(x => (o.rid === undefined || x.launch.rid === o.rid) && (o.qid === undefined || x.question.qid === o.qid));
  const prior = selected.length === 0 ? recorded(entries.filter((e): e is RuleEntry => e.kind === 'rule'), o, current) : undefined;
  let ref: import('./types.ts').AnswerRef, text: string;
  if (selected.length === 1) {
    const { launch, question } = selected[0]!;
    // An explicit rev selects history only when no matching question is open.
    ref = { rid: launch.rid, qid: question.qid, rev: question.rev };
    text = `Answer to ${launch.role} question ${question.qid}: ${o.text}`;
  } else if (prior) {
    ref = prior.answer!;
    const role = prior.text.startsWith('Answer to writer question ') ? 'writer' : 'reviewer';
    text = `Answer to ${role} question ${ref.qid}: ${o.text}`;
  } else {
    throw new OwedError(`${selected.length ? 'Ambiguous question' : 'No matching open question'} for ${o.node}; open questions: ${questions.length ? questions.map(x => `${x.launch.role} rid ${x.launch.rid}, qid ${x.question.qid}, rev ${x.question.rev}: ${oneLine(x.question.question)}`).join('; ') : 'none'}. Specify --rid and --qid`);
  }
  const ruled = await answerRule({ ...o, text, answer: ref, originalText:o.text }), entry = { ...ruled, answer:ref }, a = ref, request = answerRequest(ruled,a);
  const role = entry.text.startsWith('Answer to writer question ') ? 'writer' : 'reviewer';
  const message = entry.answers ? entry.text : entry.text.slice(`Answer to ${role} question ${a.qid}: `.length);
  const rulingDelivery = await deliverRuling(o.cwd, entry, dsa, a.rid);
  try {
    const delivery = await deliverAnswer(dsa,ruled,a,message);
    return { entry, request, delivery, rulingDelivery };
  } catch (e) {
    throw new OwedError(`Answer rule #${entry.seq} recorded; dsa delivery failed: ${(e as Error).message}; ${rulingDeliveryText(rulingDelivery)}. Retry exactly: ${answerRetry(o.node, entry)}`);
  }
}
/** Shared AN/DC delivery identity: multi-answer calls cannot share one dsa request id. */
export function answerRequest(entry: RuleEntry, a: import('./types.ts').AnswerRef): string { return `owed-answer-${entry.seq}${entry.answers ? `-${sha256(`${a.rid}\u0000${a.qid}\u0000${a.rev}`).slice(0,12)}` : ''}`; }
export async function deliverAnswer(dsa: Pick<Dsa,'send'>, entry: RuleEntry, a: import('./types.ts').AnswerRef, text: string): Promise<SendResult> {
  const delivery = await dsa.send(answerRequest(entry,a),a.rid,'answer',text,{qid:a.qid,rev:a.rev});
  if (delivery.outcome !== 'applied') throw new Error(`${delivery.outcome}${'reason' in delivery && delivery.reason ? `: ${delivery.reason}` : ''}`);
  return delivery;
}
/**
 * SB4: one line for a delivered answer (never the answer or follow-up text), plus one line only when the ruling also
 * reached other running calls or failed to reach one (who, and the exact retry).
 */
export function answerText(node: string, r: AnswerResult): string {
  const a = r.entry.answer!, role = r.entry.text.startsWith('Answer to writer question ') ? 'writer' : 'reviewer';
  return [`answered ${role} question ${a.qid} of ${a.rid} (rule #${r.entry.seq}); the call resumes now`, ...answerRulingLine(node, r)].join('\n');
}
function answerRulingLine(node: string, r: AnswerResult): string[] {
  const d = r.rulingDelivery;
  if (d?.failures.length) return [`the ruling did not reach ${d.failures.join('; ')}${d.delivered.length ? ` (reached ${d.delivered.length} other running ${d.delivered.length === 1 ? 'call' : 'calls'})` : ''}; retry exactly: ${answerRetry(node, r.entry)}`];
  return d?.delivered.length ? [`the ruling also reached ${d.delivered.length} other running ${d.delivered.length === 1 ? 'call' : 'calls'} (${d.delivered.join(', ')})`] : [];
}
