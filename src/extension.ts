import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import type { Static, TSchema } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import * as ops from './ops.ts';
import * as git from './git.ts';
import { Ledger } from './ledger.ts';
import { checklessWarnings, parsePlan, planDowngrades } from './plan.ts';
import { adoptPrefixes, uncoveredDowngrades, writesHint } from './reducer.ts';
import { OwedError } from './errors.ts';
import { driveOnce, liveRunLines } from './drive-run.ts';
import { DriveWatch, driveStart, driveStatus, driveStop, driverLine, readyHint, readyHintText, renderDriveStart, renderDriveStatus, renderDriveStop, revalidator } from './drive-bg.ts';
import { allowanceLabel, oneLine, renderBrief, renderEntry, renderGc, renderReceipt, renderReport, renderStatus } from './views.ts';
import type { EscapeClass, Principal, Role } from './types.ts';

const as = Type.Optional(Type.String({ pattern: '^(owner|parent|writer|reviewer|executor):.+$', description: 'Principal role:id; parent defaults to parent:pi.' }));
const cwd = Type.Optional(Type.String({ minLength: 1, description: 'Absolute path of a directory inside the target repository; defaults to the session working directory.' }));
const node = Type.String({ minLength: 1 });
const reason = Type.String({ minLength: 1 });
const since = Type.Optional(Type.Union([Type.Integer(), Type.String()], { description: 'Ledger seq or ISO timestamp.' }));
/** G1: the candidate the caller judged; the act is recorded only while it is the open candidate. */
const candidateParam = Type.Optional(Type.String({ description: 'Commit (40 hex, or a prefix of at least 7) of the candidate you judged; the act is refused, nothing recorded, unless it is still the open candidate.' }));
function principal(value?: string, fallback = 'parent:pi'): Principal {
  const m = /^(owner|parent|writer|reviewer|executor):(.+)$/.exec(value ?? fallback);
  if (!m) throw new OwedError('as must be role:id', 'usage');
  // G2.3 (F5): the driver records as parent:drive internally; no tool call may claim it.
  if (m[1] === 'parent' && m[2] === 'drive') throw new OwedError(ops.DRIVER_CLAIM);
  return { role: m[1] as Role, id: m[2]! };
}
/** Directory the tool operates on: the optional `cwd` argument (absolute, existing directory) or ctx.cwd. */
async function target(ctx: ExtensionContext, value?: string): Promise<string> {
  if (value === undefined) return ctx.cwd;
  if (!isAbsolute(value)) throw new OwedError(`cwd must be an absolute path: ${value}`, 'usage');
  let dir = false;
  try { dir = (await stat(value)).isDirectory(); } catch { /* reported below */ }
  if (!dir) throw new OwedError(`cwd is not an existing directory: ${value}`, 'usage');
  return value;
}
async function readText(dir: string, file: string): Promise<string> {
  try { return await readFile(resolve(dir, file), 'utf8'); }
  catch (e) { throw new OwedError(`cannot read ${file}: ${(e as NodeJS.ErrnoException).code ?? String(e)}`, 'usage'); }
}
/** Default seconds an `OWED_CONFIRM=owner` dialog waits (D25.4); `OWED_CONFIRM_TIMEOUT=0` waits indefinitely. */
export const CONFIRM_TIMEOUT_S = 120;
/** Longest timer delay Node supports (ms); larger timeouts are capped to it. */
const MAX_TIMER_MS = 2_147_483_647;
/** Seconds an owner dialog waits: `OWED_CONFIRM_TIMEOUT` when it is a non-negative integer, else the default; 0 = no limit. */
export function confirmTimeout(env: NodeJS.ProcessEnv = process.env): number {
  const v = env.OWED_CONFIRM_TIMEOUT?.trim();
  return v !== undefined && /^\d+$/.test(v) ? Number(v) : CONFIRM_TIMEOUT_S;
}
/** Refusal text of an owner dialog that timed out (D25.4). */
export const confirmTimeoutText = (seconds: number): string => `Owner confirmation not given within ${seconds} s; nothing was recorded.`;
/** Default owner principal of pi owner tools: `owner:pi` (delegated, D25.1), or `owner:human` under `OWED_CONFIRM=owner`. */
const ownerDefault = (): string => ops.confirmGate() ? 'owner:human' : 'owner:pi';
/** D25.3: refuses owner and parent acts in a pi-durable-subagents call. */
function mainAgentOnly(role: Role): void { const why = ops.subagentRefusal(role); if (why) throw new OwedError(why); }
/**
 * Resolves the principal. D25: a subagent call may not act as owner or parent; an owner act is delegated (channel
 * `delegated`, no dialog) unless `OWED_CONFIRM=owner`, which restores the dialog: `summary` lines are fixed text whose
 * interpolated values the caller passes through oneLine; free-text `fields` (note, reason, evidence) are rendered one
 * line each after the Repository/Identity lines, so they cannot fake the dialog. A list field renders `Label:` and then
 * one indented, escaped line per item, followed by its fixed `more` line. The dialog waits at most confirmTimeout()
 * seconds (owed's own timer decides; 0 = indefinitely) and is dismissed by the tool call's abort; a timeout refuses
 * (`refused`, nothing recorded), an abort refuses `aborted`; neither is ever read as a confirmation.
 */
async function actor(ctx: ExtensionContext, dir: string, value?: string, summary?: string, fields: Record<string, string | { items: string[]; more?: string } | undefined> = {}, signal?: AbortSignal) {
  const p = principal(value);
  mainAgentOnly(p.role);
  if (p.role !== 'owner') return { cwd: dir, as: p };
  if (!ops.confirmGate()) return { cwd: dir, as: p, channel: 'delegated' as const };
  if (!ctx.hasUI) throw new OwedError('owner actions require UI confirmation; no UI is available');
  const free = Object.entries(fields).flatMap(([k, v]) => v === undefined ? [] : typeof v === 'string' ? [`${k}: ${oneLine(v)}`] : [`${k}:${v.items.length ? '' : ' none'}`, ...v.items.map(i => `  ${oneLine(i)}`), ...(v.more ? [v.more] : [])]);
  const message = [summary ?? 'Execute action as owner', `Repository: ${oneLine(dir)}`, `Identity: owner:${oneLine(p.id)}`, ...free, 'Confirmation will be recorded as pi-confirm.'].join('\n');
  const seconds = confirmTimeout(), ms = Math.min(seconds * 1000, MAX_TIMER_MS), dismiss = new AbortController();
  if (signal?.aborted) throw new OwedError('aborted', 'aborted');
  // owed decides: the dialog races owed's own timer and the tool call's abort, so a UI that ignores `timeout`/`signal`
  // (or never answers) cannot hold the call; pi gets one second more than owed's limit, so owed's timer fires first.
  // A late answer of the dialog is ignored; a timeout or an abort is never read as a confirmation (fail closed).
  type Outcome = { kind: 'answer'; ok: boolean } | { kind: 'timeout' } | { kind: 'aborted' };
  let timer: ReturnType<typeof setTimeout> | undefined, onAbort: (() => void) | undefined;
  const stop = new Promise<Outcome>(res => {
    if (seconds) timer = setTimeout(() => res({ kind: 'timeout' }), ms);
    onAbort = () => res({ kind: 'aborted' });
    signal?.addEventListener('abort', onAbort, { once: true });
  });
  const answer = Promise.resolve().then(() => ctx.ui.confirm('owed: confirm owner decision', message, { ...(seconds ? { timeout: Math.min(ms + 1000, MAX_TIMER_MS) } : {}), signal: dismiss.signal })).then(ok => ({ kind: 'answer' as const, ok: ok === true }));
  let outcome: Outcome;
  try { outcome = await Promise.race([stop, answer]); }
  finally { clearTimeout(timer); if (onAbort) signal?.removeEventListener('abort', onAbort); dismiss.abort(); answer.catch(() => undefined); }
  if (outcome.kind === 'timeout') throw new OwedError(confirmTimeoutText(seconds));
  if (outcome.kind === 'aborted' || signal?.aborted) throw new OwedError('aborted', 'aborted');
  const ok = outcome.ok;
  if (!ok) throw new OwedError('owner did not confirm; action canceled');
  return { cwd: dir, as: p, channel: 'pi-confirm' as const };
}
function requireRole(value: string | undefined, fallback: string, roles: Role[], what: string): string {
  const who = value ?? fallback;
  if (!roles.includes(principal(who).role)) throw new OwedError(`Only ${roles.join('/')} may ${what}`);
  return who;
}
async function currentPlan(dir: string) {
  const ledger = await Ledger.open(dir);
  const law = (await ledger.read()).findLast(e => e.kind === 'plan' || e.kind === 'genesis');
  if (!law || (law.kind !== 'plan' && law.kind !== 'genesis')) throw new OwedError('Missing plan');
  return parsePlan((await ledger.getBlob(law.plan)).toString());
}
/** Writer of the open slot of node when dir is inside that slot worktree (submit and rebase infer it). */
async function slotWriter(dir: string, id: string): Promise<string | undefined> {
  const slot = (await ops.status({ cwd: dir })).nodes[id]?.slot;
  return slot?.open && resolve(await git.repoRoot(dir)) === resolve(slot.worktree) ? slot.writer : undefined;
}
/** Changed paths listed in the owed_adopt confirmation dialog before the `git diff --no-renames --name-only` line (SPEC §11). */
const ADOPT_SHOWN = 50;
/** Candidate lines of an owner confirmation dialog (approve, and under the gate waive and owner review; G1.2). */
const candidateLines = (v: { seq: number; commit: string; base: string; changed: number }): string => `Candidate: ${v.commit} (submit #${v.seq})\nBase: ${v.base}\nChanged files: ${v.changed}`;
function result(details: unknown, text: string) { return { content: [{ type: 'text' as const, text }], details }; }

export default function owed(pi: ExtensionAPI): void {
  // Wake-ups of the background driver (D17.7): one follower per driver log; the session gets one follow-up message per
  // poll that saw a halt, a question, a refusal or the driver's end. session_shutdown clears the timers only.
  // Background genesis attests started by owed_init in this session (D24.4); session_shutdown aborts them.
  const genesisRuns = new Set<AbortController>();
  // H1.1a: no wake batch is handed to pi while the session's agent runs (agent_start … agent_settled, and ctx.isIdle()
  // of the latest context): the followers hold it and deliver at agent_settled or the next tick while idle, after
  // revalidating it against the ledger and dsa (H1.1b).
  const agent: { running: boolean; ctx?: ExtensionContext } = { running: false };
  const busy = (): boolean => {
    if (agent.running) return true;
    try { return typeof agent.ctx?.isIdle === 'function' ? !agent.ctx.isIdle() : false; } catch { return false; }
  };
  const watch = new DriveWatch(content => pi.sendMessage({ customType: 'owed-drive', display: true, content }, { triggerTurn: true, deliverAs: 'followUp' }), undefined, { busy, revalidate: repo => revalidator({ cwd: repo }) });
  if (typeof pi.on === 'function') {
    pi.on('agent_start', (_event, ctx) => { agent.running = true; agent.ctx = ctx; });
    pi.on('agent_settled', (_event, ctx) => { agent.running = false; agent.ctx = ctx; void watch.flush(); });
    // D17a.1: auto-attach only in a session that is not inside a dsa call (dsa writers and reviewers run in worktrees of
    // the same repository and must not be woken by its driver); every top-level session in the repository is woken.
    pi.on('session_start', async (_event, ctx) => { agent.ctx = ctx; if (process.env.DSA_EXEC || process.env.DSA_CALL) return; await watch.attach(ctx.cwd).catch(() => undefined); });
    pi.on('session_shutdown', () => { watch.stopAll(); for (const c of genesisRuns) c.abort(); });
  }
  // `signal`: the tool call's abort signal; attest, merge and adopt pass it to ops, which then end their checks (D16.4);
  // drive's single pass stops after the current action.
  function tool<S extends TSchema>(name: string, description: string, parameters: S, run: (p: Static<S>, ctx: ExtensionContext, dir: string, signal?: AbortSignal) => Promise<ReturnType<typeof result>>) {
    pi.registerTool({ name: `owed_${name}`, label: `owed ${name}`, description, parameters, exposure: 'direct', executionMode: 'sequential',
      async execute(_id, p, signal, _update, ctx) {
        try {
          // G2.3 (F5): refused everywhere, reads included.
          if ((p as { as?: unknown }).as === 'parent:drive') throw new OwedError(ops.DRIVER_CLAIM);
          return await run(p, ctx, await target(ctx, (p as { cwd?: string }).cwd), signal);
        }
        catch (e) {
          if (!(e instanceof OwedError)) throw e;
          return { ...result({ code: e.code, reason: e.message }, `${e.code === 'aborted' ? 'Aborted' : e.code === 'busy' ? 'Busy' : 'Refused'}: ${e.message}`), isError: true };
        }
      } });
  }
  const card = async (dir: string, id: string, data: unknown) => result(data, renderReceipt(await ops.why({ cwd: dir, node: id })));
  tool('status', 'View status, ready nodes and pending queues.', Type.Object({ as, cwd }), async (_p, _ctx, dir) => { const r = await ops.status({ cwd: dir }); return result(r, renderStatus(r)); });
  tool('why', 'View a node receipt card, evidence and rejection reasons.', Type.Object({ node, as, cwd }), async (p, _ctx, dir) => { const r = await ops.why({ cwd: dir, node: p.node }); return result(r, renderReceipt(r)); });
  tool('report', 'View merges, debt, waivers, owner decisions, escapes and decoys.', Type.Object({ since, as, cwd }), async (p, _ctx, dir) => { const r = await ops.report({ cwd: dir, since: p.since }); return result(r, renderReport(r)); });
  tool('brief', 'Morning brief: owner decisions with the exact command, merges since `since`, rejected or blocked nodes, work in progress and totals.', Type.Object({ since, cwd }), async (p, _ctx, dir) => { const r = await ops.brief({ cwd: dir, since: p.since }); return result(r, renderBrief(r)); });
  tool('verify', 'Verify the ledger hash chain and replay it; a failure is a tool error.', Type.Object({ cwd }), async (_p, _ctx, dir) => {
    const r = await ops.verify({ cwd: dir });
    return r.ok ? result(r, `Ledger verification passed: ${r.entries} entries`) : { ...result(r, `Ledger verification failed: ${r.error}`), isError: true };
  });
  tool('dispatch', 'Dispatch a node; return the packet and arguments ready to pass to subagents. Refused while its writes overlap an open slot unless allow_overlap.', Type.Object({ node, allow_overlap: Type.Optional(Type.Boolean({ description: 'Dispatch although writes overlap another open slot; recorded in the entry.' })), as, cwd }), async (p, ctx, dir, signal) => {
    const r = await ops.dispatch({ ...await actor(ctx, dir, p.as, `Dispatch node ${oneLine(p.node)}${p.allow_overlap ? ' (allowing overlapping writes)' : ''}`, {}, signal), node: p.node, allowOverlap: !!p.allow_overlap });
    const subagents = { ...r.subagent, isolation: 'none' as const };
    return result({ ...r, subagents }, `${r.packet}\n\nsubagents: ${JSON.stringify(subagents)}\n${renderStatus(await ops.status({ cwd: dir }))}`);
  });
  tool('submit', 'Submit a committed, clean writer worktree; infer the writer when cwd (or the session) is the slot worktree.', Type.Object({ node, commit: Type.Optional(Type.String()), as, cwd }), async (p, ctx, dir, signal) => {
    const who = p.as ?? await slotWriter(dir, p.node);
    const r = await ops.submit({ ...await actor(ctx, dir, who, `Submit node ${oneLine(p.node)}`, {}, signal), node: p.node, commit: p.commit });
    return card(dir, p.node, r);
  });
  tool('rebase', 'Move the open slot of a node onto the current trunk (parent/owner, or the slot writer inferred from cwd); returns the rebase packet. The open candidate is invalidated; the writer rebases the same worktree and submits again.', Type.Object({ node, as, cwd }), async (p, ctx, dir, signal) => {
    const who = p.as ?? await slotWriter(dir, p.node);
    const r = await ops.rebase({ ...await actor(ctx, dir, who, `Rebase the open slot of node ${oneLine(p.node)} onto trunk`, {}, signal), node: p.node });
    return result(r, `${renderEntry(r.entry)}\n${r.packet}\n${renderReceipt(await ops.why({ cwd: dir, node: p.node }))}`);
  });
  tool('attest', 'Have the owed executor measure the candidate and rerun attribution for old failures; as does not change executor identity.', Type.Object({ node, rerun: Type.Optional(Type.Boolean()), as, cwd }), async (p, _ctx, dir, signal) => {
    const r = await ops.attest({ cwd: dir, node: p.node, rerun: p.rerun, signal }); return result(r, `${renderReceipt(r.receipt)}${ops.supersededText(r.superseded)}`);
  });
  tool('review', 'Independent review; explicitly specify reviewer:id (or owner:id: the main agent acts as owner (owner:pi, channel delegated, D25); a UI dialog only under OWED_CONFIRM=owner). Self-review is forbidden. needs_parent (block only): the brief or plan is ambiguous or contradictory, or the fix needs a product or contract decision; the driver halts for a parent ruling instead of sending the writer a repair.', Type.Object({ node, as, verdict: Type.Union([Type.Literal('ok'), Type.Literal('block')]), rank: Type.Integer({ minimum: 1, maximum: 3 }), note: Type.String(), ack_rulings: Type.Optional(Type.Integer({ minimum: 0 })), obligation: Type.Optional(Type.Union([Type.Literal('review'), Type.Literal('closure-review')])), needs_parent: Type.Optional(Type.Boolean()), candidate: candidateParam, cwd }), async (p, ctx, dir, signal) => {
    if (!p.as || !['reviewer', 'owner'].includes(principal(p.as).role)) throw new OwedError('review requires an explicit reviewer:id or owner:id');
    const { cwd: _cwd, needs_parent, candidate, ...args } = p;
    // G1.2: under the gate the owner's dialog shows the candidate the review lands on, and pins it.
    const v = principal(p.as).role === 'owner' && ops.confirmGate() ? await ops.candidatePreview({ cwd: dir, node: p.node }) : undefined;
    const r = await ops.review({ ...args, ...(needs_parent ? { needs: 'parent' as const } : {}), named: candidate, from: [ctx.cwd], ...(v ? { pin: { seq: v.seq, commit: v.commit } } : {}), ...await actor(ctx, dir, p.as, `Review ${oneLine(p.node)}/${p.obligation ?? 'review'}: ${p.verdict}${needs_parent ? ' (needs a parent ruling)' : ''}, rank ${p.rank}${v ? `\n${candidateLines(v)}` : ''}`, { Note: p.note }, signal) }); return card(dir, p.node, r);
  });
  tool('approve', 'Owner approval of the open candidate of a node with `approve: owner` (D23), e.g. before a publish or push; block records an owner block instead (cleared by a later owner approval). the main agent acts as owner (owner:pi, channel delegated, D25); a UI dialog only under OWED_CONFIRM=owner; the dialog shows the node, candidate commit, base and the number of changed files.', Type.Object({ node, note: Type.Optional(Type.String()), block: Type.Optional(Type.Boolean()), candidate: candidateParam, as, cwd }), async (p, ctx, dir, signal) => {
    const who = requireRole(p.as, ownerDefault(), ['owner'], 'approve');
    const v = await ops.approvePreview({ cwd: dir, node: p.node });
    const a = await actor(ctx, dir, who, `${p.block ? 'Block approval of' : 'Approve'} node ${oneLine(v.node)}\n${candidateLines(v)}`, { Note: p.note }, signal);
    // The confirmed candidate is the one approved: a resubmit during the dialog refuses (review ruling #389).
    const r = await ops.approve({ ...a, channel: a.channel!, node: p.node, note: p.note, block: !!p.block, candidate: { seq: v.seq, commit: v.commit }, named: p.candidate }); return card(dir, p.node, r);
  });
  tool('evidence', 'Manual evidence (D23): on a node with an open candidate it discharges evidence:<id> (files required; recorded by the role the plan names, or the owner; never a writer); on a merged node it records an informational receipt (e.g. version, dist-tag, tarball). Files (relative to cwd) are hashed when recorded. Always shown as manual, never as measured. As owner: the main agent acts as owner (owner:pi, channel delegated, D25); a UI dialog only under OWED_CONFIRM=owner.', Type.Object({ node, id: Type.String({ minLength: 1 }), files: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { description: 'Evidence files, relative to cwd.' })), note: reason, as: Type.String({ pattern: '^(owner|parent|reviewer):.+$', description: 'Principal role:id (reviewer, parent or owner).' }), candidate: candidateParam, cwd }), async (p, ctx, dir, signal) => {
    const files = p.files ?? [];
    // The owner confirms the files as hashed now; ops refuses when they changed before recording.
    const expect = principal(p.as).role === 'owner' ? await ops.evidenceFiles({ cwd: dir, files }) : undefined;
    // The owner confirms the candidate too: a resubmit during the dialog refuses (review ruling #389).
    const at = expect ? await ops.evidencePreview({ cwd: dir, node: p.node }) : undefined;
    const target = at?.candidate ? `Candidate: ${at.candidate.commit} (submit #${at.candidate.seq})\nBase: ${at.candidate.base}` : at?.merge !== undefined ? `Receipt on merge #${at.merge}` : 'No open candidate and no merge';
    const a = expect ? await actor(ctx, dir, p.as, `Record manual evidence ${oneLine(p.node)}/${oneLine(p.id)}\n${target}\nManual evidence is shown as manual, never as measured.`, { [`Files (${expect.length})`]: { items: expect.map(f => `${f.path} ${f.sha256.slice(0, 12)} (${f.bytes} bytes)`) }, Note: p.note }, signal) : await actor(ctx, dir, p.as, undefined, {}, signal);
    const r = await ops.evidence({ ...a, node: p.node, id: p.id, files, note: p.note, named: p.candidate, from: [ctx.cwd], ...(expect ? { expect } : {}), ...(at?.candidate ? { candidate: { seq: at.candidate.seq, commit: at.candidate.commit } } : {}) });
    return result(r, `${renderEntry(r)}\n${renderReceipt(await ops.why({ cwd: dir, node: p.node }))}`);
  });
  tool('merge', 'Run the merge guard, measure the merge tree and advance trunk with CAS.', Type.Object({ node, as, cwd }), async (p, ctx, dir, signal) => { const r = await ops.merge({ ...await actor(ctx, dir, p.as, `Merge node ${oneLine(p.node)}`, {}, signal), node: p.node, signal }); return card(dir, p.node, r); });
  tool('abandon', 'Close the open writer slot of a node (parent or owner); the node can then be dispatched again. note (or its older name reason) is recorded.', Type.Object({ node, note: Type.Optional(Type.String()), reason: Type.Optional(Type.String()), as, cwd }), async (p, ctx, dir, signal) => {
    const who = requireRole(p.as, 'parent:pi', ['parent', 'owner'], 'abandon');
    if (p.note !== undefined && p.reason !== undefined) throw new OwedError('abandon takes note (or its older name reason), not both', 'usage');
    const note = p.note ?? p.reason;
    const r = await ops.abandon({ ...await actor(ctx, dir, who, `Abandon the open attempt of node ${oneLine(p.node)}`, { Note: note ?? '(none)' }, signal), node: p.node, reason: note ?? '' });
    return result(r, `${renderEntry(r)}\n${renderReceipt(await ops.why({ cwd: dir, node: p.node }))}`);
  });
  tool('gc', 'Reclaim worktrees and branches of merged or abandoned attempts (parent or owner); dry_run only reports.', Type.Object({ dry_run: Type.Optional(Type.Boolean()), as, cwd }), async (p, ctx, dir, signal) => {
    const who = requireRole(p.as, 'parent:pi', ['parent', 'owner'], 'run gc');
    const r = await ops.gc({ ...await actor(ctx, dir, who, `${p.dry_run ? 'Report' : 'Remove'} worktrees and branches of finished attempts`, {}, signal), dryRun: !!p.dry_run });
    return result(r, renderGc(r));
  });
  tool('rule', 'Record a ruling for the applicable nodes.', Type.Object({ text: reason, nodes: Type.Union([Type.Literal('*'), Type.Array(node)]), as, cwd }), async (p, ctx, dir, signal) => {
    const r = await ops.rule({ text: p.text, nodes: p.nodes, ...await actor(ctx, dir, p.as, `Ruling for ${JSON.stringify(p.nodes)}`, { Ruling: p.text }, signal) }); return result(r, renderReport(await ops.report({ cwd: dir, since: r.seq - 1 })));
  });
  tool('plan', 'Update the plan from a file (working tree, or commit rev); downgrades need the owner (the main agent as owner:pi, delegated, with a note saying why; a dialog only under OWED_CONFIRM=owner) unless an `allow` rule of the current plan covers them all (then the parent records them, labelled under allowance).', Type.Object({ plan: Type.String({ minLength: 1, description: 'Plan file path, relative to cwd.' }), rev: Type.Optional(Type.String({ minLength: 1, description: 'Read the plan file from this commit instead of the working tree; the entry records rev and path.' })), note: Type.Optional(Type.String({ description: 'Why (recorded); required for a delegated owner downgrade (D25.5).' })), as, cwd }), async (p, ctx, dir, signal) => {
    const read = await ops.readPlan({ cwd: dir, path: p.plan, rev: p.rev }), text = read.plan;
    const prior = await currentPlan(dir), next = parsePlan(text), downgrades = planDowngrades(prior, next);
    // D21.3: downgrades that an allowance of the current plan covers need no owner; the parent records them.
    const gaps = downgrades.length ? uncoveredDowngrades(prior, next, downgrades) : [];
    const who = p.as ?? (gaps.length ? ownerDefault() : 'parent:pi');
    if (gaps.length && principal(who).role !== 'owner') { const hint = writesHint(prior, next, gaps); throw new OwedError(`Only owner may confirm plan downgrades; not covered by an allowance of the current plan: ${gaps.map(g => `${g.node}: ${g.what}`).join('; ')}${hint ? `\n${hint}` : ''}`); }
    const r = await ops.planSet({ ...await actor(ctx, dir, who, `Update plan ${oneLine(read.path)}${read.rev ? ` at ${read.rev}` : ''}\nDowngraded obligations: ${JSON.stringify(downgrades)}\nDowngrades reduce acceptance requirements.`, { Note: p.note }, signal), ...read, ...(p.note !== undefined ? { note: p.note } : {}) });
    const pending = await ops.genesisPending({ cwd: dir });
    const warning = pending.length ? `Warning: genesis attest pending for ${pending.join(', ')}\n` : '';
    const d = principal(who).role === 'owner' ? undefined : (await ops.report({ cwd: dir, since: r.seq - 1 })).downgrades.find(x => x.seq === r.seq);
    // H2.2: warnings for check-less nodes of the new plan, after the result.
    const warnings = checklessWarnings(next);
    // H1.3: dispatchable ready nodes and no driver: one hint line before the H2.2 warnings, which end the text (the
    // parent decides; nothing starts automatically).
    const ready = await readyHint(dir);
    const data = { ...r, ...(pending.length ? { warning: warning.trim() } : {}), warnings, ...(ready ? { ready, driver: false } : {}) };
    return result(data, `${warning}${d?.allowance !== undefined ? `Downgrades ${allowanceLabel(d)}: ${d.items.map(i => `${i.node}: ${i.what}`).join('; ')}\n` : ''}${renderStatus(await ops.status({ cwd: dir }))}${ready ? `\n${readyHintText(ready, 'pi')}` : ''}${warnings.map(w => `\n${w}`).join('')}`);
  });
  tool('init', 'Owner: initialize the owed ledger from a plan file (genesis), (the main agent acts as owner (owner:pi, channel delegated, D25); a UI dialog only under OWED_CONFIRM=owner, showing the trunk commit, plan sha, node count and invariants). Returns at once; the genesis attest of the invariants then runs in the background in this session, owed_status shows its progress, and the session gets one message when it ends.', Type.Object({ plan: Type.String({ minLength: 1, description: 'Plan file path, relative to cwd.' }), as, cwd }), async (p, ctx, dir, signal) => {
    const who = requireRole(p.as, ownerDefault(), ['owner'], 'initialize the ledger');
    const read = await ops.readPlan({ cwd: dir, path: p.plan }), v = await ops.initPreview({ cwd: dir, plan: read.plan });
    const a = await actor(ctx, dir, who, `Initialize the owed ledger\nTrunk: ${oneLine(v.trunk)} at ${v.commit.slice(0, 12)}\nPlan: ${oneLine(read.path)} (sha256 ${v.planSha.slice(0, 12)})\nNodes: ${v.nodes}`, { Invariants: { items: v.invariants } }, signal);
    const r = await ops.init({ ...a, channel: a.channel!, plan: read.plan, commit: v.commit, measure: false });
    const n = r.genesis.missing.length;
    if (n) {
      const ac = new AbortController(); genesisRuns.add(ac);
      const end = (head: string, g: Pick<ops.GenesisAttest, 'recorded' | 'failed' | 'missing'>) => `${head}: recorded ${g.recorded.join(', ') || 'none'}; failed ${g.failed.join(', ') || 'none'}; missing ${g.missing.join(', ') || 'none'}${g.missing.length ? '; run owed attest --genesis, or the next attest/merge measures them first' : ''}`;
      // One wake-up when it ends (D17.7 style); none after session_shutdown aborted it (the session is gone).
      void ops.attestGenesis({ cwd: dir, signal: ac.signal }).then(
        g => end(`owed init: genesis attest of ${oneLine(dir)} finished`, g),
        async (e: unknown) => ac.signal.aborted ? undefined : end(`owed init: genesis attest of ${oneLine(dir)} stopped (${oneLine(e instanceof Error ? e.message : String(e))})`, await ops.genesisReport({ cwd: dir }).catch(() => ({ recorded: [], failed: [], missing: r.genesis.missing }))),
      ).then(content => { if (content) pi.sendMessage({ customType: 'owed-init', display: true, content }, { triggerTurn: true, deliverAs: 'followUp' }); }).catch(() => undefined).finally(() => { genesisRuns.delete(ac); });
    }
    const warnings = checklessWarnings(parsePlan(read.plan));
    return result({ entry: r.entry, genesis: r.entry.seq, measuring: n, warnings }, `${renderEntry(r.entry)}\nInitialized (genesis #${r.entry.seq}). ${n ? `Measuring ${n} genesis invariant${n === 1 ? '' : 's'} in the background in this session; owed_status shows progress and this session gets one message when it ends.` : 'No invariants to measure.'}${warnings.map(w => `\n${w}`).join('')}`);
  });
  tool('waive', 'Owner waiver of a current obligation (the main agent acts as owner (owner:pi, channel delegated, D25); a UI dialog only under OWED_CONFIRM=owner); reason says why; accept_risk explicitly references block seq numbers.', Type.Object({ node, obligation: reason, reason, accept_risk: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }))), candidate: candidateParam, as, cwd }), async (p, ctx, dir, signal) => {
    const who = requireRole(p.as, ownerDefault(), ['owner'], 'waive');
    // G1.2: under the gate the dialog shows the candidate the waiver lands on, and pins it.
    const v = ops.confirmGate() ? await ops.candidatePreview({ cwd: dir, node: p.node }) : undefined;
    const a = await actor(ctx, dir, who, `Waive ${oneLine(p.node)}/${oneLine(p.obligation)}\n${v ? `${candidateLines(v)}\n` : ''}Accepted risks (block seq): ${JSON.stringify(p.accept_risk ?? [])}\nThis obligation will be shown as waived, not a measured pass.`, { Reason: p.reason }, signal);
    const r = await ops.waive({ node: p.node, obligation: p.obligation, reason: p.reason, accept_risk: p.accept_risk, named: p.candidate, ...(v ? { pin: { seq: v.seq, commit: v.commit } } : {}), ...a, channel: a.channel! }), meaning = await ops.waiverMeaning({ cwd: dir, entry: r }); return result({ ...r, meaning }, `${meaning}\n${renderReceipt(await ops.why({ cwd: dir, node: p.node }))}`);
  });
  tool('defer', 'Owner deferral of prospective merge-tree invariants; debt remains (the main agent acts as owner (owner:pi, channel delegated, D25); a UI dialog only under OWED_CONFIRM=owner).', Type.Object({ node, items: Type.Array(node, { minItems: 1, description: 'Invariant IDs.' }), reason, as, cwd }), async (p, ctx, dir, signal) => {
    const who = requireRole(p.as, ownerDefault(), ['owner'], 'defer');
    const s = await ops.status({ cwd: dir }), candidate = s.nodes[p.node]?.candidate;
    if (!candidate) throw new OwedError('defer requires a current candidate');
    const plan = await currentPlan(dir);
    const m = await git.buildMerge(dir, s.trunk.commit, candidate.commit, `owed merge ${p.node}`);
    if ('conflicts' in m) throw new OwedError('rebase needed');
    const facts = await git.stateFacts(dir, plan, m.commit);
    const items = p.items.map(id => { const key = facts.invKeys[id]; if (!key) throw new OwedError(`Unknown invariant ${id}`); return { id, key }; });
    const a = await actor(ctx, dir, who, `Defer post-merge invariants for node ${oneLine(p.node)}: ${p.items.map(oneLine).join(', ')}\nThese obligations remain debt; they do not become passes.\n${JSON.stringify(items)}`, { Reason: p.reason }, signal);
    const r = await ops.defer({ ...a, channel: a.channel!, node: p.node, reason: p.reason, items }); return result(r, renderReport(await ops.report({ cwd: dir, since: r.seq - 1 })));
  });
  tool('adopt', 'Owner adoption of trunk commits made outside owed (release commits, hotfixes): commit (default refs/heads/<trunk>) must equal the trunk ref and fast-forward the ledger trunk; invariants whose key changed are measured and a new failure refuses it. The main agent acts as owner (owner:pi, channel delegated, D25; a UI dialog only under OWED_CONFIRM=owner); as parent:<id> only when every changed path lies under an `allow` adopt prefix of the plan.', Type.Object({ commit: Type.Optional(Type.String({ minLength: 1, description: 'Commit to adopt; must equal refs/heads/<trunk> (the default).' })), note: Type.String({ minLength: 1, description: 'Why these commits are adopted (recorded).' }), as, cwd }), async (p, ctx, dir, signal) => {
    // D21.4: a parent may adopt (no dialog) only when the current plan has an `adopt` allowance; ops checks the paths.
    const who = p.as ?? ownerDefault();
    if (!(principal(who).role === 'owner' || (principal(who).role === 'parent' && adoptPrefixes(await currentPlan(dir)).length))) throw new OwedError('Only owner may adopt trunk commits');
    if (!p.note.trim()) throw new OwedError('adopt requires a note', 'usage');
    const v = await ops.adoptPreview({ cwd: dir, commit: p.commit });
    // Up to ADOPT_SHOWN paths one per line; beyond that, the exact command that lists them all.
    const shown = { items: v.changed.slice(0, ADOPT_SHOWN), ...(v.changed.length > ADOPT_SHOWN ? { more: `… +${v.changed.length - ADOPT_SHOWN} more paths; full list: git diff --no-renames --name-only ${v.prior.slice(0, 12)}..${v.commit.slice(0, 12)}` } : {}) };
    const a = await actor(ctx, dir, who, `Adopt trunk ${oneLine(v.trunk)} ${v.prior.slice(0, 12)}..${v.commit.slice(0, 12)}: ${v.commits} commit${v.commits === 1 ? '' : 's'} made outside owed\nThese changes were not reviewed through owed; adopting them makes ${v.commit.slice(0, 12)} the ledger trunk.`, { [`Changed paths (${v.changed.length})`]: shown, Note: p.note }, signal);
    const r = await ops.adopt({ ...a, commit: v.commit, note: p.note, signal });
    return result(r, `${renderEntry(r.entry)}${r.allowance !== undefined ? `\nAdopted by ${r.entry.by} under allowance (plan #${r.allowance})` : ''}\nInvariant observations: ${r.observations.length}\n${renderStatus(await ops.status({ cwd: dir }))}`);
  });
  tool('escape', 'Record an escape: a defect found after a merge of node; merge is the seq of that merge entry (parent or owner).', Type.Object({ node, merge: Type.Integer({ minimum: 0, description: 'Seq of the merge entry of node.' }), class: Type.Union((['missing', 'false-pass', 'reuse', 'weak', 'waiver'] as const).map(c => Type.Literal(c))), note: reason, evidence: Type.Optional(Type.String()), as, cwd }), async (p, ctx, dir, signal) => {
    const who = requireRole(p.as, 'parent:pi', ['parent', 'owner'], 'record escapes');
    const a = await actor(ctx, dir, who, `Record escape for node ${oneLine(p.node)} (merge #${p.merge}, class ${p.class})`, { Note: p.note, Evidence: p.evidence }, signal);
    const r = await ops.escape({ ...a, node: p.node, merge: p.merge, class: p.class as EscapeClass, note: p.note, evidence: p.evidence });
    return result(r, renderEntry(r));
  });
  tool('decoy', 'Decoy commitments: digest (compute the digest of a reveal JSON file; writes nothing), commit (owner) or reveal (owner; the main agent acts as owner (owner:pi, channel delegated, D25); a UI dialog only under OWED_CONFIRM=owner).', Type.Object({ action: Type.Union([Type.Literal('commit'), Type.Literal('reveal'), Type.Literal('digest')]), digest: Type.Optional(Type.String({ description: 'Digest to commit (64 lowercase hex), for action commit.' })), file: Type.Optional(Type.String({ description: 'Reveal JSON file {nonce, decoys:[{node, defect}]}, relative to cwd; for reveal and digest.' })), as, cwd }), async (p, ctx, dir, signal) => {
    if (p.action === 'commit' ? !p.digest || p.file !== undefined : !p.file || p.digest !== undefined) throw new OwedError(p.action === 'commit' ? 'decoy commit requires digest (and no file)' : `decoy ${p.action} requires file (and no digest)`, 'usage');
    if (p.action === 'digest') { const r = ops.decoyDigest(await readText(dir, p.file!)); return result(r, r.digest); }
    const who = requireRole(p.as, ownerDefault(), ['owner'], `${p.action} decoys`);
    if (p.action === 'commit') {
      const a = await actor(ctx, dir, who, `Commit decoy digest ${oneLine(p.digest!)}\nThe decoy list stays hidden until it is revealed; only a reveal matching this digest can open it.`, {}, signal);
      const r = await ops.decoyCommit({ ...a, channel: a.channel!, digest: p.digest! }); return result(r, renderEntry(r));
    }
    const payload = await readText(dir, p.file!), decoys = ops.decoyPayload(payload).decoys;
    const a = await actor(ctx, dir, who, `Reveal decoys from ${oneLine(p.file!)}: ${decoys.map(d => oneLine(d.node)).join(', ')}\nThe revealed list must match an earlier unrevealed commitment; outcomes become part of the escape metrics.`, {}, signal);
    const r = await ops.decoyReveal({ ...a, channel: a.channel!, payload }); return result(r, renderEntry(r));
  });
  tool('drive', 'The owed driver as parent:drive: dispatch ready nodes, launch writers and reviewers through pi-durable-subagents (>= 1.0.27), send follow-ups, attest under `hold machine --shared --no-wait`, merge, rebase, halt for decisions. It never answers questions, waives, changes the plan or forces restarts. action once (default): one pass (`owed drive --once`). To run the DAG to completion use action start: a detached background driver (`owed drive --detach`; like a loop in a terminal or a `systemd-run --user` unit, never a long loop inside a tool or dsa call) that survives pi exiting; this session is woken when the driver halts, needs the owner, a call asks a question, it is stalled, dsa events fail, or the driver exits, so do not poll status. With stay: true the started driver does not exit when idle: it wakes this session once (idle-wait) and waits for ledger changes (e.g. a plan update), then continues. action status reports the background driver; action stop stops it after its current action (now: at once). Refused while another driver runs for the repository.', Type.Object({ action: Type.Optional(Type.Union([Type.Literal('once'), Type.Literal('start'), Type.Literal('status'), Type.Literal('stop')], { description: 'once (default): one pass; start: background driver with wake-ups; status; stop.' })), max: Type.Optional(Type.Integer({ minimum: 1, description: 'Concurrent open attempts (overrides drive.max); action once or start.' })), now: Type.Optional(Type.Boolean({ description: 'action stop: stop at once (second SIGTERM after 1 s) instead of after the current action.' })), stay: Type.Optional(Type.Boolean({ description: 'action start: when idle, keep running and wait for ledger changes instead of exiting (this session is woken once per idle period); use it when the plan will grow. Stop it with action stop.' })), cwd }), async (p, _ctx, dir, signal) => {
    const action = p.action ?? 'once';
    if (p.now && action !== 'stop') throw new OwedError('now is only valid with action stop', 'usage');
    if (p.stay && action !== 'start') throw new OwedError('stay is only valid with action start', 'usage');
    if (p.max !== undefined && (action === 'status' || action === 'stop')) throw new OwedError('max is only valid with action once or start', 'usage');
    if (action === 'start') {
      const r = await driveStart({ cwd: dir, max: p.max, ...(p.stay ? { stay: true } : {}) });
      // Follow the fresh log from its start (it was rotated for this driver): nothing it wrote before this is missed.
      // A driver that already ended (its exit record is in this result) gets no follower (D17a.8). An explicit start
      // follows in any session, also inside a dsa call.
      if (!r.exited) watch.follow({ log: r.log, repo: r.repo, pid: r.pid, ...(r.start ? { start: r.start } : {}), from: 0 });
      return result(r, `${renderDriveStart(r)}\nThis session is woken when the driver halts, needs the owner, a call asks a question, it is stalled, dsa events fail, or it exits; do not poll status.`);
    }
    if (action === 'status') { const r = await driveStatus({ cwd: dir }); return result(r, renderDriveStatus(r)); }
    if (action === 'stop') { const r = await driveStop({ cwd: dir, now: !!p.now }); return result(r, renderDriveStop(r)); }
    // An aborted tool call stops the pass after the current action (actions are idempotent).
    const r = await driveOnce({ cwd: dir, max: p.max, ...(signal ? { signal } : {}) });
    const text = [...r.lines, ...(r.error ? [`Refused: ${r.error}`] : [])].join('\n') || 'nothing to do';
    return r.error ? { ...result(r, text), isError: true } : result(r, text);
  });
  pi.registerCommand('owed', { description: 'owed status; /owed why <node> shows the receipt card', handler: async (args, ctx) => {
    try {
      const parts = args.trim().split(/\s+/);
      let text: string;
      if (!args.trim() || args.trim() === 'status') { text = renderStatus(await ops.status(ctx)); const live = await liveRunLines(ctx.cwd).catch(() => []); if (live.length) text += `\nDriver runs in dsa:\n${live.join('\n')}`; const bg = await driverLine(ctx.cwd).catch(() => undefined); if (bg) text += `\n${bg}`; }
      else if (parts.length === 2 && parts[0] === 'why') text = renderReceipt(await ops.why({ cwd: ctx.cwd, node: parts[1]! }));
      else throw new OwedError('Usage: /owed or /owed why <node>', 'usage');
      ctx.ui.notify(text, 'info');
    } catch (e) { if (!(e instanceof OwedError)) throw e; ctx.ui.notify(`Refused: ${e.message}`, 'error'); }
  } });
}
