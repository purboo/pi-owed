import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import type { Static, TSchema } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import * as ops from './ops.ts';
import * as git from './git.ts';
import { Ledger } from './ledger.ts';
import { parsePlan, planDowngrades } from './plan.ts';
import { OwedError } from './errors.ts';
import { renderBrief, renderEntry, renderReceipt, renderReport, renderStatus } from './views.ts';
import type { EscapeClass, Principal, Role } from './types.ts';

const as = Type.Optional(Type.String({ pattern: '^(owner|parent|writer|reviewer|executor):.+$', description: 'Principal role:id; parent defaults to parent:pi.' }));
const cwd = Type.Optional(Type.String({ minLength: 1, description: 'Absolute path of a directory inside the target repository; defaults to the session working directory.' }));
const node = Type.String({ minLength: 1 });
const reason = Type.String({ minLength: 1 });
const since = Type.Optional(Type.Union([Type.Integer(), Type.String()], { description: 'Ledger seq or ISO timestamp.' }));
function principal(value?: string, fallback = 'parent:pi'): Principal {
  const m = /^(owner|parent|writer|reviewer|executor):(.+)$/.exec(value ?? fallback);
  if (!m) throw new OwedError('as must be role:id', 'usage');
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
async function actor(ctx: ExtensionContext, dir: string, value?: string, summary?: string) {
  const p = principal(value);
  if (p.role !== 'owner') return { cwd: dir, as: p };
  if (!ctx.hasUI) throw new OwedError('owner actions require UI confirmation; no UI is available');
  if (!await ctx.ui.confirm('owed: confirm owner decision', `${summary ?? 'Execute action as owner'}\nRepository: ${dir}\nIdentity: owner:${p.id}\nConfirmation will be recorded as pi-confirm.`)) throw new OwedError('owner did not confirm; action canceled');
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
function result(details: unknown, text: string) { return { content: [{ type: 'text' as const, text }], details }; }
function renderGc(r: ops.GcResult): string {
  const removed = r.removed.map(i => `  ${i.node}#${i.attempt}: ${[i.worktree && `worktree ${i.worktree}`, i.branch && `branch ${i.branch}`, ...i.pinned.map(ref => `${r.dryRun ? 'would pin' : 'pinned'} ${ref}`)].filter(Boolean).join(', ')}`);
  const kept = r.kept.map(i => `  ${i.node}#${i.attempt} (${i.branch}): ${i.reason}`);
  return [`${r.dryRun ? 'Would remove' : 'Removed'}${removed.length ? '' : ': nothing'}`, ...removed, `Kept${kept.length ? '' : ': nothing'}`, ...kept, ...(r.entry ? [renderEntry(r.entry)] : [])].join('\n');
}

export default function owed(pi: ExtensionAPI): void {
  function tool<S extends TSchema>(name: string, description: string, parameters: S, run: (p: Static<S>, ctx: ExtensionContext, dir: string) => Promise<ReturnType<typeof result>>) {
    pi.registerTool({ name: `owed_${name}`, label: `owed ${name}`, description, parameters, exposure: 'direct', executionMode: 'sequential',
      async execute(_id, p, _signal, _update, ctx) {
        try { return await run(p, ctx, await target(ctx, (p as { cwd?: string }).cwd)); }
        catch (e) {
          if (!(e instanceof OwedError)) throw e;
          return { ...result({ code: e.code, reason: e.message }, `Refused: ${e.message}`), isError: true };
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
  tool('dispatch', 'Dispatch a node; return the packet and arguments ready to pass to subagents.', Type.Object({ node, as, cwd }), async (p, ctx, dir) => {
    const r = await ops.dispatch({ ...await actor(ctx, dir, p.as, `Dispatch node ${p.node}`), node: p.node });
    const subagents = { ...r.subagent, isolation: 'none' as const };
    return result({ ...r, subagents }, `${r.packet}\n\nsubagents: ${JSON.stringify(subagents)}\n${renderStatus(await ops.status({ cwd: dir }))}`);
  });
  tool('submit', 'Submit a committed, clean writer worktree; infer the writer when cwd (or the session) is the slot worktree.', Type.Object({ node, commit: Type.Optional(Type.String()), as, cwd }), async (p, ctx, dir) => {
    let who = p.as;
    if (!who) {
      const slot = (await ops.status({ cwd: dir })).nodes[p.node]?.slot;
      if (slot && resolve(await git.repoRoot(dir)) === resolve(slot.worktree)) who = slot.writer;
    }
    const r = await ops.submit({ ...await actor(ctx, dir, who, `Submit node ${p.node}`), node: p.node, commit: p.commit });
    return card(dir, p.node, r);
  });
  tool('attest', 'Have the owed executor measure the candidate and rerun attribution for old failures; as does not change executor identity.', Type.Object({ node, rerun: Type.Optional(Type.Boolean()), as, cwd }), async (p, _ctx, dir) => {
    const r = await ops.attest({ cwd: dir, node: p.node, rerun: p.rerun }); return result(r, renderReceipt(r.receipt));
  });
  tool('review', 'Independent review; explicitly specify reviewer:id (owner requires UI confirmation). Self-review is forbidden.', Type.Object({ node, as, verdict: Type.Union([Type.Literal('ok'), Type.Literal('block')]), rank: Type.Integer({ minimum: 1, maximum: 3 }), note: Type.String(), ack_rulings: Type.Optional(Type.Integer({ minimum: 0 })), obligation: Type.Optional(Type.Union([Type.Literal('review'), Type.Literal('closure-review')])), cwd }), async (p, ctx, dir) => {
    if (!p.as || !['reviewer', 'owner'].includes(principal(p.as).role)) throw new OwedError('review requires an explicit reviewer:id or owner:id');
    const { cwd: _cwd, ...args } = p;
    const r = await ops.review({ ...args, ...await actor(ctx, dir, p.as, `Review ${p.node}/${p.obligation ?? 'review'}: ${p.verdict}, rank ${p.rank}\n${p.note}`) }); return card(dir, p.node, r);
  });
  tool('merge', 'Run the merge guard, measure the merge tree and advance trunk with CAS.', Type.Object({ node, as, cwd }), async (p, ctx, dir) => { const r = await ops.merge({ ...await actor(ctx, dir, p.as, `Merge node ${p.node}`), node: p.node }); return card(dir, p.node, r); });
  tool('abandon', 'Close the open writer slot of a node (parent or owner); the node can then be dispatched again.', Type.Object({ node, reason: Type.Optional(Type.String()), as, cwd }), async (p, ctx, dir) => {
    const who = requireRole(p.as, 'parent:pi', ['parent', 'owner'], 'abandon');
    const r = await ops.abandon({ ...await actor(ctx, dir, who, `Abandon the open attempt of node ${p.node}\nReason: ${p.reason ?? '(none)'}`), node: p.node, reason: p.reason ?? '' });
    return result(r, `${renderEntry(r)}\n${renderReceipt(await ops.why({ cwd: dir, node: p.node }))}`);
  });
  tool('gc', 'Reclaim worktrees and branches of merged or abandoned attempts (parent or owner); dry_run only reports.', Type.Object({ dry_run: Type.Optional(Type.Boolean()), as, cwd }), async (p, ctx, dir) => {
    const who = requireRole(p.as, 'parent:pi', ['parent', 'owner'], 'run gc');
    const r = await ops.gc({ ...await actor(ctx, dir, who, `${p.dry_run ? 'Report' : 'Remove'} worktrees and branches of finished attempts`), dryRun: !!p.dry_run });
    return result(r, renderGc(r));
  });
  tool('rule', 'Record a ruling for the applicable nodes.', Type.Object({ text: reason, nodes: Type.Union([Type.Literal('*'), Type.Array(node)]), as, cwd }), async (p, ctx, dir) => {
    const r = await ops.rule({ text: p.text, nodes: p.nodes, ...await actor(ctx, dir, p.as, `Ruling ${JSON.stringify(p.nodes)}: ${p.text}`) }); return result(r, renderReport(await ops.report({ cwd: dir, since: r.seq - 1 })));
  });
  tool('plan', 'Update the plan from a file; downgrades require owner UI confirmation.', Type.Object({ plan: Type.String({ minLength: 1, description: 'Plan file path, relative to cwd.' }), as, cwd }), async (p, ctx, dir) => {
    const text = await readText(dir, p.plan);
    const downgrades = planDowngrades(await currentPlan(dir), parsePlan(text));
    const who = p.as ?? (downgrades.length ? 'owner:human' : 'parent:pi');
    if (downgrades.length && principal(who).role !== 'owner') throw new OwedError('Only owner may confirm plan downgrades');
    const r = await ops.planSet({ ...await actor(ctx, dir, who, `Update plan ${p.plan}\nDowngraded obligations: ${JSON.stringify(downgrades)}\nDowngrades reduce acceptance requirements.`), plan: text });
    return result(r, renderStatus(await ops.status({ cwd: dir })));
  });
  tool('waive', 'Owner waiver of a current obligation; UI confirmation is required, and accept_risk explicitly references block seq numbers.', Type.Object({ node, obligation: reason, reason, accept_risk: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }))), as, cwd }), async (p, ctx, dir) => {
    const who = requireRole(p.as, 'owner:human', ['owner'], 'waive');
    const a = await actor(ctx, dir, who, `Waive ${p.node}/${p.obligation}\nReason: ${p.reason}\nAccepted risks (block seq): ${JSON.stringify(p.accept_risk ?? [])}\nThis obligation will be shown as waived, not a measured pass.`);
    const r = await ops.waive({ node: p.node, obligation: p.obligation, reason: p.reason, accept_risk: p.accept_risk, ...a, channel: 'pi-confirm' }); return card(dir, p.node, r);
  });
  tool('defer', 'Owner deferral of prospective merge-tree invariants; debt remains and UI confirmation is required.', Type.Object({ node, items: Type.Array(node, { minItems: 1, description: 'Invariant IDs.' }), reason, as, cwd }), async (p, ctx, dir) => {
    const who = requireRole(p.as, 'owner:human', ['owner'], 'defer');
    const s = await ops.status({ cwd: dir }), candidate = s.nodes[p.node]?.candidate;
    if (!candidate) throw new OwedError('defer requires a current candidate');
    const plan = await currentPlan(dir);
    const m = await git.buildMerge(dir, s.trunk.commit, candidate.commit, `owed merge ${p.node}`);
    if ('conflicts' in m) throw new OwedError('rebase needed');
    const facts = await git.stateFacts(dir, plan, m.commit);
    const items = p.items.map(id => { const key = facts.invKeys[id]; if (!key) throw new OwedError(`Unknown invariant ${id}`); return { id, key }; });
    const a = await actor(ctx, dir, who, `Defer post-merge invariants for node ${p.node}: ${p.items.join(', ')}\nReason: ${p.reason}\nThese obligations remain debt; they do not become passes.\n${JSON.stringify(items)}`);
    const r = await ops.defer({ ...a, channel: 'pi-confirm', node: p.node, reason: p.reason, items }); return result(r, renderReport(await ops.report({ cwd: dir, since: r.seq - 1 })));
  });
  tool('escape', 'Record an escape: a defect found after a merge of node; merge is the seq of that merge entry (parent or owner).', Type.Object({ node, merge: Type.Integer({ minimum: 0, description: 'Seq of the merge entry of node.' }), class: Type.Union((['missing', 'false-pass', 'reuse', 'weak', 'waiver'] as const).map(c => Type.Literal(c))), note: reason, evidence: Type.Optional(Type.String()), as, cwd }), async (p, ctx, dir) => {
    const who = requireRole(p.as, 'parent:pi', ['parent', 'owner'], 'record escapes');
    const a = await actor(ctx, dir, who, `Record escape for node ${p.node} (merge #${p.merge}, class ${p.class})\nNote: ${p.note}${p.evidence ? `\nEvidence: ${p.evidence}` : ''}`);
    const r = await ops.escape({ ...a, node: p.node, merge: p.merge, class: p.class as EscapeClass, note: p.note, evidence: p.evidence });
    return result(r, renderEntry(r));
  });
  tool('decoy', 'Decoy commitments: digest (compute the digest of a reveal JSON file; writes nothing), commit (owner) or reveal (owner) with UI confirmation.', Type.Object({ action: Type.Union([Type.Literal('commit'), Type.Literal('reveal'), Type.Literal('digest')]), digest: Type.Optional(Type.String({ description: 'Digest to commit (64 lowercase hex), for action commit.' })), file: Type.Optional(Type.String({ description: 'Reveal JSON file {nonce, decoys:[{node, defect}]}, relative to cwd; for reveal and digest.' })), as, cwd }), async (p, ctx, dir) => {
    if (p.action === 'commit' ? !p.digest || p.file !== undefined : !p.file || p.digest !== undefined) throw new OwedError(p.action === 'commit' ? 'decoy commit requires digest (and no file)' : `decoy ${p.action} requires file (and no digest)`, 'usage');
    if (p.action === 'digest') { const r = ops.decoyDigest(await readText(dir, p.file!)); return result(r, r.digest); }
    const who = requireRole(p.as, 'owner:human', ['owner'], `${p.action} decoys`);
    if (p.action === 'commit') {
      const a = await actor(ctx, dir, who, `Commit decoy digest ${p.digest}\nThe decoy list stays hidden until it is revealed; only a reveal matching this digest can open it.`);
      const r = await ops.decoyCommit({ ...a, channel: 'pi-confirm', digest: p.digest! }); return result(r, renderEntry(r));
    }
    const payload = await readText(dir, p.file!), decoys = ops.decoyPayload(payload).decoys;
    const a = await actor(ctx, dir, who, `Reveal decoys from ${p.file}: ${decoys.map(d => d.node).join(', ')}\nThe revealed list must match an earlier unrevealed commitment; outcomes become part of the escape metrics.`);
    const r = await ops.decoyReveal({ ...a, channel: 'pi-confirm', payload }); return result(r, renderEntry(r));
  });
  pi.registerCommand('owed', { description: 'owed status; /owed why <node> shows the receipt card', handler: async (args, ctx) => {
    try {
      const parts = args.trim().split(/\s+/);
      let text: string;
      if (!args.trim() || args.trim() === 'status') text = renderStatus(await ops.status(ctx));
      else if (parts.length === 2 && parts[0] === 'why') text = renderReceipt(await ops.why({ cwd: ctx.cwd, node: parts[1]! }));
      else throw new OwedError('Usage: /owed or /owed why <node>', 'usage');
      ctx.ui.notify(text, 'info');
    } catch (e) { if (!(e instanceof OwedError)) throw e; ctx.ui.notify(`Refused: ${e.message}`, 'error'); }
  } });
}
