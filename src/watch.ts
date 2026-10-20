// FW3/FW4: CLI follower, using exactly the session follower's wake batches and revalidation.
import * as git from './git.ts';
import { DriveWatch, revalidator } from './drive-bg.ts';
import type { DriveStart } from './drive-bg.ts';
import { driverSession, registeredDrivers } from './registry.ts';

export function followedBy(r: DriveStart): string | null {
  return r.session ?? registeredDrivers().find(d => d.repo === r.repo && d.pid === r.pid && d.start === r.start)?.session
    ?? (r.alreadyRunning ? null : driverSession() ?? null);
}
export const followText = (session: string | null): string => session
  ? `followed by pi session ${session.slice(0, 8)}`
  : 'note: no pi session follows this driver; its wakes reach only pi sessions opened in this repository. To be woken elsewhere, run `owed watch` (for example as a dsa command call).';
export interface WatchResult { lines: string[]; next: number; exit: 0 | 3 | 5 }
export async function watchDriver(o: { cwd: string; after?: number; timeout?: number }): Promise<WatchResult> {
  const repo = await git.mainRoot(o.cwd), watch = new DriveWatch(() => undefined, 0, { busy: () => false, revalidate: repo => revalidator({ cwd: repo }) });
  const follower = await watch.attach(o.cwd, o.after);
  if (!follower) return { lines: [`no owed driver is running in ${repo}; start one with owed start`], next: o.after ?? 0, exit: 3 };
  const end = o.timeout === undefined ? Infinity : Date.now() + o.timeout * 1000;
  try {
    for (;;) {
      const message = await follower.step();
      if (message !== undefined) return { lines: message.split('\n'), next: follower.next, exit: 0 };
      if (Date.now() >= end) return { lines: [`no wake within ${o.timeout} s`], next: follower.next, exit: 5 };
      await new Promise(r => setTimeout(r, Math.min(250, Math.max(0, end - Date.now()))));
    }
  } finally { watch.stopAll(); }
}
export function watchText(r: WatchResult): string {
  return [...r.lines, ...(r.exit === 3 ? [] : [`next: owed watch --after ${r.next}`])].join('\n');
}
