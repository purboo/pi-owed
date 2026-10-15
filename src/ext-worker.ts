// Native worker transport. No runtime dependency on pi: npm/git installs may omit its optional peers.
import { Worker, SHARE_ENV, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { readFileSync, statSync } from 'node:fs';
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { OwedError } from './errors.ts';
import type { OwedErrorCode } from './errors.ts';

const manifest = new URL('../package.json', import.meta.url);
export const loadedVersion: string = JSON.parse(readFileSync(manifest, 'utf8')).version;
let stamp = '', installed = loadedVersion;
export function installedVersion(): string {
  const s = statSync(manifest), key = `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}`;
  if (key !== stamp) { installed = JSON.parse(readFileSync(manifest, 'utf8')).version; stamp = key; }
  return installed;
}
export const restartLine = (version = installedVersion()): string => `owed ${version} is installed but this pi session loaded ${loadedVersion}: restart pi to use it.`;
const defaultNotices = new Set<string>();
export function versionNotice<T extends { content: { type: string; text?: string }[]; details?: unknown }>(r: T, options: { seen?: Set<string>; full?: boolean } = {}): T {
  const version = installedVersion(), seen = options.seen ?? defaultNotices;
  const refused = (r.details as { code?: string } | undefined)?.code === 'version'
    || r.content.some(c => c.type === 'text' && c.text?.includes('is installed but this pi session loaded'));
  if (version === loadedVersion && !refused) return r;
  if (!options.full && !refused && seen.has(version)) return r;
  seen.add(version);
  const content = r.content.slice();
  const last = content.findLastIndex(c => c.type === 'text');
  if (last >= 0 && content[last]!.text?.endsWith(restartLine(version))) return r;
  if (last >= 0) content[last] = { ...content[last]!, text: `${content[last]!.text}\n${restartLine(version)}` };
  else content.push({ type: 'text', text: restartLine(version) });
  return { ...r, content };
}
type Context = { cwd: string; hasUI: boolean; idle: boolean };
type Request = { id: number; method: string; args: unknown[] };
type Reply = { id: number; result?: unknown; error?: { code: string; message: string } };
type Callback = { callback: number; call: number; method: 'confirm' | 'dismiss' | 'notify' | 'message'; args: unknown[]; session: number };
type Pending = { resolve: (v: unknown) => void; reject: (e: Error) => void; ctx?: ExtensionContext; cleanup: () => void };

/** One eagerly started worker shared by all tools (and extension registrations) in this pi process. */
export class ToolWorker {
  worker?: Worker;
  private next = 0;
  private pending = new Map<number, Pending>();
  private dialogs = new Map<number, AbortController>();
  private sessions = new Map<number, { pi: ExtensionAPI; canDeliver: () => boolean }>();
  private ready?: Promise<unknown>;
  constructor() { this.start(); }
  private start(): void {
    if (installedVersion() !== loadedVersion) throw new OwedError(restartLine());
    const url = new URL(import.meta.url.endsWith('.ts') ? './ext-worker.ts' : './ext-worker.js', import.meta.url);
    const w = new Worker(url, { env: SHARE_ENV, workerData: { owed: true, version: loadedVersion }, execArgv: [] });
    this.worker = w;
    this.ready = new Promise((resolve, reject) => this.pending.set(0, { resolve, reject, cleanup() {} }));
    // Loading is eager; an idle worker must not keep a CLI/test process alive.
    this.ready.catch(() => undefined);
    w.on('message', (m: Reply | Callback) => {
      if ('callback' in m) { void this.callback(w, m).catch(() => undefined); return; }
      const p = this.pending.get(m.id); if (!p) return;
      this.pending.delete(m.id); p.cleanup();
      if (m.error) p.reject(new OwedError(m.error.message, m.error.code as OwedErrorCode)); else p.resolve(m.result);
      if (!this.pending.size) w.unref();
    });
    const failed = (text: string) => {
      if (this.worker !== w) return;
      this.worker = undefined;
      for (const p of this.pending.values()) { p.cleanup(); p.reject(new OwedError(`owed worker ${text}; retry the call`)); }
      this.pending.clear();
      for (const d of this.dialogs.values()) d.abort(); this.dialogs.clear();
    };
    w.on('error', e => failed(`crashed: ${e.message}`));
    w.on('exit', code => failed(`exited (${code})`));
    w.unref();
  }
  register(pi: ExtensionAPI, canDeliver: () => boolean = () => true): number { const id = ++this.next; this.sessions.set(id, { pi, canDeliver }); return id; }
  unregister(id: number): void { this.sessions.delete(id); }
  private async callback(w: Worker, m: Callback): Promise<void> {
    const ctx = this.pending.get(m.call)?.ctx;
    if (m.method === 'dismiss') { this.dialogs.get(m.callback)?.abort(); this.dialogs.delete(m.callback); return; }
    if (m.method === 'message') {
      const session = this.sessions.get(m.session);
      try {
        if (!session || (['owed-drive', 'owed-idle'].includes((m.args[0] as { customType: string }).customType) && !session.canDeliver())) throw new Error('session busy or stopped');
        session.pi.sendMessage(...m.args as Parameters<ExtensionAPI['sendMessage']>);
        w.postMessage({ id: m.callback, method: 'answer', args: [true] });
      } catch { w.postMessage({ id: m.callback, method: 'answer', args: [false] }); }
      return;
    }
    if (m.method === 'notify') { ctx?.ui.notify(...m.args as Parameters<ExtensionContext['ui']['notify']>); return; }
    const ac = new AbortController(); this.dialogs.set(m.callback, ac);
    try {
      const [title, message, options] = m.args as [string, string, { timeout?: number }];
      const ok = ctx?.hasUI ? await ctx.ui.confirm(title, message, { ...options, signal: ac.signal }) : false;
      w.postMessage({ id: m.callback, method: 'answer', args: [ok === true] });
    } catch { w.postMessage({ id: m.callback, method: 'answer', args: [false] }); }
    finally { this.dialogs.delete(m.callback); }
  }
  async call(method: string, args: unknown[], ctx?: ExtensionContext, signal?: AbortSignal): Promise<any> {
    if (!this.worker) this.start();
    const w = this.worker!; w.ref(); await this.ready;
    // Do not retry an operation whose outcome was lost with the worker.
    if (w !== this.worker) throw new OwedError('owed worker exited; retry the call');
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const abort = () => w.postMessage({ id, method: 'abort', args: [] });
      this.pending.set(id, { resolve, reject, ctx, cleanup: () => signal?.removeEventListener('abort', abort) });
      signal?.addEventListener('abort', abort, { once: true });
      try {
        w.ref(); w.postMessage({ id, method, args });
        if (signal?.aborted) abort();
      } catch (e) {
        this.pending.get(id)?.cleanup(); this.pending.delete(id);
        if (!this.pending.size) w.unref();
        reject(e);
      }
    });
  }
}
// jiti uses moduleCache:false; registrations/reloads of the same installed version
// still share one native worker, rather than spawning a worker per module wrapper.
const sharedKey = Symbol.for('pi-owed.tool-worker');
const host = globalThis as typeof globalThis & { [sharedKey]?: { version: string; rpc: ToolWorker } };
export function toolWorker(): ToolWorker {
  const shared = host[sharedKey];
  if (shared && shared.version !== loadedVersion) throw new OwedError(`owed ${loadedVersion} is installed but this pi session loaded ${shared.version}: restart pi to use it.`);
  if (shared) return shared.rpc;
  const rpc = new ToolWorker(); host[sharedKey] = { version: loadedVersion, rpc }; return rpc;
}

/** Register schemas locally; execute tools, commands and watcher events in the worker. */
export function remoteAPI(pi: ExtensionAPI): ExtensionAPI {
  const rpc = toolWorker();
  let context: ExtensionContext | undefined, running = false, polling = false, stopped = false;
  const idle = (): boolean => { try { return !stopped && !running && (typeof context?.isIdle !== 'function' || context.isIdle()); } catch { return !stopped && !running; } };
  const session = rpc.register(pi, idle);
  const notices = new Set<string>();
  const plain = (ctx: ExtensionContext): Context => ({ cwd: ctx.cwd, hasUI: ctx.hasUI, idle: idle() });
  const event = async (name: string, ctx: ExtensionContext) => rpc.call('event', [session, name, plain(ctx)], ctx);
  const timer = setInterval(() => {
    if (!context || polling || stopped) return;
    polling = true; void event('owed_tick', context).catch(() => undefined).finally(() => { polling = false; });
  }, 2000); timer.unref();
  return {
    ...pi,
    registerTool(t: ToolDefinition) {
      pi.registerTool({ ...t, async execute(id, p, signal, _update, ctx) {
        context = ctx;
        try {
          const r = await rpc.call('tool', [session, t.name, id, p, plain(ctx)], ctx, signal);
          // Structured clone resets prototypes; status exposes the reducer's null-prototype node dictionary.
          if (t.name === 'owed_status' && !r.isError) Object.setPrototypeOf(r.details.nodes, null);
          return versionNotice(r, {seen:notices, full:t.name === 'owed_status' && (p as {full?:boolean}).full === true});
        }
        catch (e) {
          if (!(e instanceof Error) || e.name !== 'OwedError') throw e;
          const error = e as OwedError;
          return versionNotice({ content: [{ type: 'text' as const, text: `Refused: ${error.message}` }], details: { code: error.code, reason: error.message }, isError: true }, {seen:notices});
        }
      } });
    },
    registerCommand(name, command) {
      pi.registerCommand(name, { ...command, async handler(args, ctx) {
        context = ctx;
        try { await rpc.call('command', [session, name, args, plain(ctx)], ctx); }
        catch (e) { ctx.ui.notify(e instanceof Error ? e.message : String(e), 'error'); }
      } });
    },
    on(name, _handler) {
      if ((name as string) === 'owed_tick' || typeof pi.on !== 'function') return () => undefined;
      return (pi.on as (name: string, handler: (_e: unknown, ctx: ExtensionContext) => Promise<void>) => () => void)(name, async (_e: unknown, ctx: ExtensionContext) => {
        context = ctx;
        if (name === 'session_start') notices.clear();
        if (name === 'agent_start') running = true;
        if (name === 'agent_settled') running = false;
        if (name === 'session_shutdown') { stopped = true; clearInterval(timer); }
        try { await event(name, ctx); } finally { if (stopped) rpc.unregister(session); }
      });
    },
  } as ExtensionAPI;
}

if (!isMainThread && workerData?.owed) void (async () => {
  const port = parentPort!;
  if (loadedVersion !== workerData.version) throw new OwedError(`owed ${loadedVersion} is installed but this pi session loaded ${workerData.version}: restart pi to use it.`);
  const { default: owed } = await import('./extension.ts');
  if (installedVersion() !== workerData.version) throw new OwedError(`owed ${installedVersion()} is installed but this pi session loaded ${workerData.version}: restart pi to use it.`);
  const sessions = new Map<number, { tools: Map<string, ToolDefinition>; commands: Map<string, any>; handlers: Map<string, any> }>();
  const calls = new Map<number, AbortController>(), answers = new Map<number, (answer: boolean) => void>();
  let callback = 0;
  function sessionOf(id: number) {
    let s = sessions.get(id); if (s) return s;
    s = { tools: new Map(), commands: new Map(), handlers: new Map() }; sessions.set(id, s);
    owed({ registerTool: (t: ToolDefinition) => s.tools.set(t.name, t), registerCommand: (n: string, c: unknown) => s.commands.set(n, c), on: (n: string, h: unknown) => s.handlers.set(n, h),
      sendMessage: (...args: unknown[]) => new Promise<void>((resolve, reject) => {
        const key = ++callback;
        answers.set(key, ok => ok ? resolve() : reject(new Error('pi did not accept the wake; retry after revalidation')));
        port.postMessage({ callback: key, call: 0, session: id, method: 'message', args });
      }),
    } as unknown as ExtensionAPI);
    return s;
  }
  port.on('message', (m: Request) => {
    if (m.method === 'abort') { calls.get(m.id)?.abort(); return; }
    if (m.method === 'answer') { answers.get(m.id)?.(m.args[0] === true); answers.delete(m.id); return; }
    const ac = new AbortController(); calls.set(m.id, ac);
    void (async () => {
      const [sid, name] = m.args as [number, string], s = sessionOf(sid);
      const value = m.args.at(-1) as Context;
      const ctx = { ...value, isIdle: () => value.idle, ui: {
        notify: (...args: unknown[]) => port.postMessage({ callback: ++callback, call: m.id, session: sid, method: 'notify', args }),
        confirm: (title: string, text: string, options: { timeout?: number; signal?: AbortSignal } = {}) => new Promise<boolean>(resolve => {
          const id = ++callback;
          const dismiss = () => { answers.delete(id); port.postMessage({ callback: id, call: m.id, session: sid, method: 'dismiss', args: [] }); resolve(false); };
          answers.set(id, answer => { options.signal?.removeEventListener('abort', dismiss); resolve(answer); });
          options.signal?.addEventListener('abort', dismiss, { once: true });
          port.postMessage({ callback: id, call: m.id, session: sid, method: 'confirm', args: [title, text, { timeout: options.timeout }] });
          if (options.signal?.aborted) dismiss();
        }),
      } } as unknown as ExtensionContext;
      if (m.method === 'tool') return s.tools.get(name)!.execute(m.args[2] as string, m.args[3], ac.signal, undefined, ctx as Parameters<ToolDefinition['execute']>[4]);
      if (m.method === 'command') return s.commands.get(name).handler(m.args[2], ctx);
      if (m.method === 'event') { await s.handlers.get(name)?.({}, ctx); if (name === 'session_shutdown') sessions.delete(sid); return; }
      throw new OwedError(`Unknown worker method ${m.method}`, 'usage');
    })().then(result => port.postMessage({ id: m.id, result }), (e: unknown) => port.postMessage({ id: m.id, error: { code: e instanceof OwedError ? e.code : 'internal', message: e instanceof Error ? e.message : String(e) } })).finally(() => calls.delete(m.id));
  });
  port.postMessage({ id: 0, result: true });
})().catch(e => { throw e; });
