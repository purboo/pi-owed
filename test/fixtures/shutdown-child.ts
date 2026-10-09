// Child process for test/drive-bg.test.ts (D17a.9): loads the extension with a fake pi, attaches to the live driver
// named by the lock (session_start), proves the follower exists (a halt line appended now wakes it), shuts the session
// down and then must exit on its own: no timer or handle of the extension may keep it alive.
// argv: <repo cwd> <driver log path>. Prints `woken` and `shutdown`; exit 2: never woken, 3: woken after shutdown.
import { appendFileSync } from 'node:fs';
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import owedExtension from '../../src/extension.ts';

const [cwd, log] = process.argv.slice(2) as [string, string];
const handlers = new Map<string, (event: unknown, ctx: unknown) => unknown>();
const state: { woken?: () => void; shut: boolean } = { shut: false };
owedExtension({
  registerTool() { /* not used */ },
  registerCommand() { /* not used */ },
  on(event: string, h: (event: unknown, ctx: unknown) => unknown) { handlers.set(event, h); return () => undefined; },
  sendMessage() { if (state.shut) { process.stdout.write('woken after shutdown\n'); process.exit(3); } state.woken?.(); },
} as unknown as ExtensionAPI);

await handlers.get('session_start')!({ type: 'session_start', reason: 'startup' }, { cwd });
// The follower's timer is unref'd: a ref'd guard keeps this process alive while it waits for the wake.
const guard = setTimeout(() => { process.stdout.write('never woken\n'); process.exit(2); }, 15_000);
const wake = new Promise<void>(resolve => { state.woken = resolve; });
appendFileSync(log, `${JSON.stringify({ do: 'halt', node: 'sd', outcome: 'halted', attempt: 1, needs: 'human', detail: 'wake me' })}\n`);
await wake;
clearTimeout(guard);
process.stdout.write('woken\n');
await handlers.get('session_shutdown')!({ type: 'session_shutdown', reason: 'quit' }, { cwd });
state.shut = true;
process.stdout.write('shutdown\n');
// Nothing ref'd remains: the process exits here (the parent allows 5 s).
