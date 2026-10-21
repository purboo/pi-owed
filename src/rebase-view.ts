import type { State } from './types.ts';
import { entriesOf, previousSubmit } from './reducer.ts';
import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { git, isAncestor } from './git.ts';
import { rebaseRecovery } from './needs.ts';
export { rebaseRecovery } from './needs.ts';

/** WS3: shared packet text is initialized independently of the views/needs/ops cycle. */
export const WRITER_DECISION = 'If you need a decision outside your writes, ask the parent (your run waits): give decision_needed (one sentence) and numbered options (label, scope, cost, risk; mark one preferred), plus facts (commit, run id, log sha), what you tried, and candidate explanations with their evidence and what is unproven — as ask fields when your ask tool has them, else as text starting "Decision needed:". Never submit a candidate you believe fails its checks. When a ruling tells you to stop, pause or wait for a parent prerequisite, do not ask to confirm it; state your status and end your turn.';
export interface RebasePending { head: string; base: string; upstream: string; command: string; recovery?: string }
export type SlotGitOperation = 'rebase' | 'merge' | 'cherry-pick' | 'revert';
/** Porcelain can be clean while an interrupted Git operation still owns the worktree. */
export async function slotGitOperation(worktree: string): Promise<SlotGitOperation | undefined> {
  for (const [name, operation] of [['rebase-merge','rebase'],['rebase-apply','rebase'],['MERGE_HEAD','merge'],['CHERRY_PICK_HEAD','cherry-pick'],['REVERT_HEAD','revert']] as const) {
    const path = (await git(worktree,['rev-parse','--git-path',name])).stdout.trim();
    try { await lstat(resolve(worktree,path)); return operation; } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  return undefined;
}
export async function slotGitInProgress(worktree: string): Promise<boolean> { return !!await slotGitOperation(worktree); }
/** Read actual HEAD; never infer that a recorded rebase was applied. Missing worktrees are not drift evidence. */
export async function rebasePending(s: State, node: string, includeAligned = false): Promise<RebasePending | undefined> {
  const slot = s.nodes[node]?.slot;
  if (!slot?.open) return undefined;
  const headResult = await git(slot.worktree, ['rev-parse', 'HEAD'], { allowFail: true }).catch(() => undefined);
  if (!headResult || headResult.code) return undefined;
  const head = headResult.stdout.trim();
  const previous = previousSubmit(s,node), inProgress = await slotGitOperation(slot.worktree);
  const recovery = rebaseRecovery(head, slot.rebase && previous && slot.rebase.seq > previous.seq ? previous.facts.commit : undefined,inProgress,slot.base,node);
  // NY7: an aligned, clean HEAD is not status drift; the driver separately reads recovery for an unsubmitted rebase.
  if (!includeAligned && !inProgress && await isAncestor(slot.worktree, slot.base, head)) return undefined;
  const history = entriesOf(s).filter(e => (e.kind === 'dispatch' || e.kind === 'rebase') && e.node === node && e.attempt === slot.attempt).reverse();
  let upstream: string | undefined;
  for (const e of history) if ((e.kind === 'dispatch' || e.kind === 'rebase') && await isAncestor(slot.worktree, e.base, head)) { upstream = e.base; break; }
  if (!upstream) {
    const dispatch = history.find(e => e.kind === 'dispatch');
    if (!dispatch || dispatch.kind !== 'dispatch') return undefined;
    upstream = (await git(slot.worktree, ['merge-base', head, dispatch.base])).stdout.trim();
  }
  upstream = await trunkUpstream(slot.worktree, head, slot.base, upstream);
  return { head, base: slot.base, upstream, command: `git rebase --onto ${slot.base} ${upstream}`, ...(recovery ? {recovery} : {}) };
}
/**
 * SB2: trunk commits HEAD already contains (a merge of trunk or a rebase onto it) are never replayed: the upstream
 * advances to merge-base(HEAD, new base) when that descends from the recorded upstream.
 */
export async function trunkUpstream(cwd: string, head: string, base: string, upstream: string): Promise<string> {
  const r = await git(cwd, ['merge-base', head, base], { allowFail: true });
  const shared = r.code ? '' : r.stdout.trim();
  return shared && shared !== upstream && await isAncestor(cwd, upstream, shared) ? shared : upstream;
}
export function rebaseFollowupSent(s: State, node: string): boolean {
  const slot = s.nodes[node]?.slot;
  if (!slot) return false;
  return s.nodes[node]!.runs.find(r => r.attempt === slot.attempt)?.sends.some(send => {
    if (send.reason !== 'rebase') return false;
    const base = entriesOf(s).findLast(e => e.seq < send.seq && (e.kind === 'dispatch' || e.kind === 'rebase') && e.node === node && e.attempt === slot.attempt);
    return (base?.kind === 'dispatch' || base?.kind === 'rebase') && base.base === slot.base;
  }) ?? false;
}
export const rebasePendingText = (r: RebasePending): string => `rebase pending (HEAD ${r.head.slice(0, 12)} not on slot base ${r.base.slice(0, 12)})`;
export const rebaseWorkText = (r: RebasePending): string => `${r.recovery ? `${r.recovery} ` : ''}First commit your work, then run \`${r.command}\`; resolve conflicts within the allowed writes, rerun checks, commit, then submit.`;
