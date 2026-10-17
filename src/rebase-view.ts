import type { State } from './types.ts';
import { entriesOf, previousSubmit } from './reducer.ts';
import { lstat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { git, isAncestor } from './git.ts';

/** WS3: shared packet text is initialized independently of the views/needs/ops cycle. */
export const WRITER_DECISION = 'If you need a decision outside your writes, ask the parent a question (your run waits); never submit a candidate you believe fails its checks.';
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
export function rebaseRecovery(head: string, original: string | undefined, inProgress: boolean | SlotGitOperation | undefined, base?: string, node?: string): string | undefined {
  if (inProgress) return typeof inProgress === 'string'
    ? `Git operation in progress; run \`git ${inProgress} --abort\`, then follow the rebase instruction.`
    : 'Git operation in progress; run `git rebase --abort` (or `git merge --abort` for a merge), then follow the rebase instruction.';
  if (original && head !== original) return `HEAD differs from last submitted candidate ${original.slice(0,12)}; keep: check \`git log ${base ?? '<slot base>'}..HEAD\` holds only this node's commits, run the focused tests, then \`owed submit ${node ?? '<node>'}\`; reset: \`git reset --hard ${original}\`, then \`git rebase --onto ${base ?? '<slot base>'} $(git merge-base HEAD ${base ?? '<slot base>'})\`.`;
  return undefined;
}
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
