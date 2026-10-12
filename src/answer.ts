// AN1–AN2: discover a question, durably record the ruling, then deliver with a stable dsa request id.
import { Dsa } from './dsa.ts';
import type { SendResult } from './dsa.ts';
import { OwedError } from './errors.ts';
import { answerRule, readState, subagentRefusal } from './ops.ts';
import type { Channel, LaunchEntry, Principal, RuleEntry, RunQuestion, State } from './types.ts';
import { oneLine } from './views.ts';

export interface AnswerOptions { cwd: string; as: Principal; channel?: Channel; node: string; text: string; qid?: string; rid?: string; dsa?: Pick<Dsa, 'describe' | 'send'> }
export interface AnswerResult { entry: RuleEntry; request: string; delivery: SendResult }
type Question = { launch: LaunchEntry; question: RunQuestion };
const shell = (s: string): string => `'${s.replaceAll("'", "'\\''")}'`;
export const answerRetry = (node: string, entry: RuleEntry): string => {
  const a = entry.answer!;
  // The prefix's exact length avoids treating punctuation in a qid as answer text.
  const role = entry.text.startsWith('Answer to writer question ') ? 'writer' : 'reviewer';
  const text = entry.text.slice(`Answer to ${role} question ${a.qid}: `.length);
  return `owed answer ${shell(node)} --rid ${shell(a.rid)} --qid ${shell(a.qid)} -- ${shell(text)}`;
};
const recorded = (entries: RuleEntry[], o: AnswerOptions): RuleEntry | undefined => entries.find(e => e.nodes !== '*' && e.nodes.includes(o.node) && e.answer?.rid === o.rid && e.answer?.qid === o.qid);
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
  const dsa = o.dsa ?? new Dsa({ cwd: o.cwd }), { entries, state } = await readState(o);
  const prior = o.rid !== undefined && o.qid !== undefined ? recorded(entries.filter((e): e is RuleEntry => e.kind === 'rule'), o) : undefined;
  let ref = prior?.answer, text = prior?.text;
  if (prior) {
    const role = prior.text.startsWith('Answer to writer question ') ? 'writer' : 'reviewer';
    text = `Answer to ${role} question ${o.qid}: ${o.text}`;
  } else {
    // Inspect all current launches even when qid is supplied: qids can repeat across writer/reviewer runs.
    const questions: Question[] = (await Promise.all(launches(state, o.node).map(async launch => {
      const view = await dsa.describe(launch.rid);
      return view.state === 'asking' ? (view.questions ?? []).map(question => ({ launch, question })) : [];
    }))).flat();
    const selected = questions.filter(x => (o.rid === undefined || x.launch.rid === o.rid) && (o.qid === undefined || x.question.qid === o.qid));
    if (selected.length !== 1) throw new OwedError(`${selected.length ? 'Ambiguous question' : 'No matching open question'} for ${o.node}; open questions: ${questions.length ? questions.map(x => `${x.launch.role} rid ${x.launch.rid}, qid ${x.question.qid}, rev ${x.question.rev}: ${oneLine(x.question.question)}`).join('; ') : 'none'}. Specify --rid and --qid`);
    const { launch, question } = selected[0]!;
    ref = { rid: launch.rid, qid: question.qid, rev: question.rev };
    text = `Answer to ${launch.role} question ${question.qid}: ${o.text}`;
  }
  const entry = await answerRule({ ...o, text: text!, answer: ref! }), a = entry.answer!, request = `owed-answer-${entry.seq}`;
  const role = entry.text.startsWith('Answer to writer question ') ? 'writer' : 'reviewer';
  const message = entry.text.slice(`Answer to ${role} question ${a.qid}: `.length);
  try {
    const delivery = await dsa.send(request, a.rid, 'answer', message, { qid: a.qid, rev: a.rev });
    if (delivery.outcome !== 'applied') throw new Error(`${delivery.outcome}${'reason' in delivery && delivery.reason ? `: ${delivery.reason}` : ''}`);
    return { entry, request, delivery };
  } catch (e) {
    throw new OwedError(`Answer rule #${entry.seq} recorded; dsa delivery failed: ${(e as Error).message}. Retry exactly: ${answerRetry(o.node, entry)}`);
  }
}
export function answerText(node: string, r: AnswerResult): string {
  return `Answer rule #${r.entry.seq} for ${node}: delivered to ${r.entry.answer!.rid} (qid ${r.entry.answer!.qid}, request ${r.request})`;
}
