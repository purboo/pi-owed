import type { State } from './types.ts';
import { entriesOf } from './reducer.ts';
import { git, isAncestor } from './git.ts';

export interface RebasePending { head: string; base: string; upstream: string; command: string }
/** Read actual HEAD; never infer that a recorded rebase was applied. Missing worktrees are not drift evidence. */
export async function rebasePending(s: State, node: string, includeAligned = false): Promise<RebasePending | undefined> {
  const slot = s.nodes[node]?.slot;
  if (!slot?.open) return undefined;
  const headResult = await git(slot.worktree, ['rev-parse', 'HEAD'], { allowFail: true }).catch(() => undefined);
  if (!headResult || headResult.code) return undefined;
  const head = headResult.stdout.trim();
  if (!includeAligned && await isAncestor(slot.worktree, slot.base, head)) return undefined;
  const history = entriesOf(s).filter(e => (e.kind === 'dispatch' || e.kind === 'rebase') && e.node === node && e.attempt === slot.attempt).reverse();
  let upstream: string | undefined;
  for (const e of history) if ((e.kind === 'dispatch' || e.kind === 'rebase') && await isAncestor(slot.worktree, e.base, head)) { upstream = e.base; break; }
  if (!upstream) {
    const dispatch = history.find(e => e.kind === 'dispatch');
    if (!dispatch || dispatch.kind !== 'dispatch') return undefined;
    upstream = (await git(slot.worktree, ['merge-base', head, dispatch.base])).stdout.trim();
  }
  return { head, base: slot.base, upstream, command: `git rebase --onto ${slot.base} ${upstream}` };
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
export const rebaseWorkText = (r: RebasePending): string => `First commit your work, then run \`${r.command}\`; resolve conflicts within the allowed writes, rerun checks, commit, then submit.`;
