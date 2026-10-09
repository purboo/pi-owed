import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Type } from '@earendil-works/pi-ai';
import type { Static, TSchema } from '@earendil-works/pi-ai';
import type { ExtensionAPI, ExtensionContext } from '@earendil-works/pi-coding-agent';
import * as ops from './ops.ts';
import * as git from './git.ts';
import { Ledger } from './ledger.ts';
import { parsePlan, planDowngrades } from './plan.ts';
import { OwedError } from './errors.ts';
import { renderReceipt, renderReport, renderStatus } from './views.ts';
import type { Principal, Role } from './types.ts';

const as = Type.Optional(Type.String({ pattern: '^(owner|parent|writer|reviewer|executor):.+$', description: 'Principal role:id; parent defaults to parent:pi.' }));
const node = Type.String({ minLength: 1 });
const reason = Type.String({ minLength: 1 });
function principal(value?: string, fallback = 'parent:pi'): Principal {
  const m = /^(owner|parent|writer|reviewer|executor):(.+)$/.exec(value ?? fallback);
  if (!m) throw new OwedError('as must be role:id', 'usage');
  return { role: m[1] as Role, id: m[2]! };
}
async function actor(ctx: ExtensionContext, value?: string, summary?: string) {
  const p = principal(value);
  if (p.role !== 'owner') return { cwd: ctx.cwd, as: p };
  if (!ctx.hasUI) throw new OwedError('owner actions require UI confirmation; no UI is available');
  if (!await ctx.ui.confirm('owed: confirm owner decision', `${summary ?? 'Execute action as owner'}\nIdentity: owner:${p.id}\nConfirmation will be recorded as pi-confirm.`)) throw new OwedError('owner did not confirm; action canceled');
  return { cwd: ctx.cwd, as: p, channel: 'pi-confirm' as const };
}
async function currentPlan(cwd: string) {
  const ledger = await Ledger.open(cwd);
  const law = (await ledger.read()).findLast(e => e.kind === 'plan' || e.kind === 'genesis');
  if (!law || (law.kind !== 'plan' && law.kind !== 'genesis')) throw new OwedError('Missing plan');
  return parsePlan((await ledger.getBlob(law.plan)).toString());
}
function result(details: unknown, text: string) { return { content: [{ type: 'text' as const, text }], details }; }

export default function owed(pi: ExtensionAPI): void {
  function tool<S extends TSchema>(name: string, description: string, parameters: S, run: (p: Static<S>, ctx: ExtensionContext) => Promise<ReturnType<typeof result>>) {
    pi.registerTool({ name: `owed_${name}`, label: `owed ${name}`, description, parameters, exposure: 'direct', executionMode: 'sequential',
      async execute(_id, p, _signal, _update, ctx) {
        try { return await run(p, ctx); }
        catch (e) {
          if (!(e instanceof OwedError)) throw e;
          return { ...result({ code: e.code, reason: e.message }, `Refused: ${e.message}`), isError: true };
        }
      } });
  }
  const card = async (cwd: string, id: string, data: unknown) => result(data, renderReceipt(await ops.why({ cwd, node: id })));
  tool('status', 'View status, ready nodes and pending queues.', Type.Object({ as }), async (_p, ctx) => { const r = await ops.status(ctx); return result(r, renderStatus(r)); });
  tool('why', 'View a node receipt card, evidence and rejection reasons.', Type.Object({ node, as }), async (p, ctx) => { const r = await ops.why({ cwd: ctx.cwd, node: p.node }); return result(r, renderReceipt(r)); });
  tool('report', 'View merges, debt, waivers and owner decisions.', Type.Object({ since: Type.Optional(Type.Union([Type.Integer(), Type.String()])), as }), async (p, ctx) => { const r = await ops.report({ cwd: ctx.cwd, since: p.since }); return result(r, renderReport(r)); });
  tool('dispatch', 'Dispatch a node; return the packet and arguments ready to pass to subagents.', Type.Object({ node, as }), async (p, ctx) => {
    const r = await ops.dispatch({ ...await actor(ctx, p.as, `Dispatch node ${p.node}`), node: p.node });
    const subagents = { ...r.subagent, isolation: 'none' as const };
    return result({ ...r, subagents }, `${r.packet}\n\nsubagents: ${JSON.stringify(subagents)}\n${renderStatus(await ops.status(ctx))}`);
  });
  tool('submit', 'Submit a committed, clean writer worktree; infer the writer inside the slot directory.', Type.Object({ node, commit: Type.Optional(Type.String()), as }), async (p, ctx) => {
    let who = p.as;
    if (!who) {
      const slot = (await ops.status(ctx)).nodes[p.node]?.slot;
      if (slot && resolve(await git.repoRoot(ctx.cwd)) === resolve(slot.worktree)) who = slot.writer;
    }
    const r = await ops.submit({ ...await actor(ctx, who, `Submit node ${p.node}`), node: p.node, commit: p.commit });
    return card(ctx.cwd, p.node, r);
  });
  tool('attest', 'Have the owed executor measure the candidate and rerun attribution for old failures; as does not change executor identity.', Type.Object({ node, rerun: Type.Optional(Type.Boolean()), as }), async (p, ctx) => {
    const r = await ops.attest({ cwd: ctx.cwd, node: p.node, rerun: p.rerun }); return result(r, renderReceipt(r.receipt));
  });
  tool('review', 'Independent review; explicitly specify reviewer:id (owner requires UI confirmation). Self-review is forbidden.', Type.Object({ node, as, verdict: Type.Union([Type.Literal('ok'), Type.Literal('block')]), rank: Type.Integer({ minimum: 1, maximum: 3 }), note: Type.String(), ack_rulings: Type.Optional(Type.Integer({ minimum: 0 })), obligation: Type.Optional(Type.Union([Type.Literal('review'), Type.Literal('closure-review')])) }), async (p, ctx) => {
    if (!p.as || !['reviewer', 'owner'].includes(principal(p.as).role)) throw new OwedError('review requires an explicit reviewer:id or owner:id');
    const r = await ops.review({ ...p, ...await actor(ctx, p.as, `Review ${p.node}/${p.obligation ?? 'review'}: ${p.verdict}, rank ${p.rank}\n${p.note}`) }); return card(ctx.cwd, p.node, r);
  });
  tool('merge', 'Run the merge guard, measure the merge tree and advance trunk with CAS.', Type.Object({ node, as }), async (p, ctx) => { const r = await ops.merge({ ...await actor(ctx, p.as, `Merge node ${p.node}`), node: p.node }); return card(ctx.cwd, p.node, r); });
  tool('rule', 'Record a ruling for the applicable nodes.', Type.Object({ text: reason, nodes: Type.Union([Type.Literal('*'), Type.Array(node)]), as }), async (p, ctx) => {
    const r = await ops.rule({ ...p, ...await actor(ctx, p.as, `Ruling ${JSON.stringify(p.nodes)}: ${p.text}`) }); return result(r, renderReport(await ops.report({ cwd: ctx.cwd, since: r.seq - 1 })));
  });
  tool('plan', 'Update the plan from a file; downgrades require owner UI confirmation.', Type.Object({ plan: Type.String({ minLength: 1, description: 'Plan file path, relative to ctx.cwd.' }), as }), async (p, ctx) => {
    const text = await readFile(resolve(ctx.cwd, p.plan), 'utf8');
    const downgrades = planDowngrades(await currentPlan(ctx.cwd), parsePlan(text));
    const who = p.as ?? (downgrades.length ? 'owner:human' : 'parent:pi');
    if (downgrades.length && principal(who).role !== 'owner') throw new OwedError('Only owner may confirm plan downgrades');
    const r = await ops.planSet({ ...await actor(ctx, who, `Update plan ${p.plan}\nDowngraded obligations: ${JSON.stringify(downgrades)}\nDowngrades reduce acceptance requirements.`), plan: text });
    return result(r, renderStatus(await ops.status(ctx)));
  });
  tool('waive', 'Owner waiver of a current obligation; UI confirmation is required, and accept_risk explicitly references block seq numbers.', Type.Object({ node, obligation: reason, reason, accept_risk: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }))), as }), async (p, ctx) => {
    const who = p.as ?? 'owner:human';
    if (principal(who).role !== 'owner') throw new OwedError('Only owner may waive');
    const a = await actor(ctx, who, `Waive ${p.node}/${p.obligation}\nReason: ${p.reason}\nAccepted risks (block seq): ${JSON.stringify(p.accept_risk ?? [])}\nThis obligation will be shown as waived, not a measured pass.`);
    const r = await ops.waive({ ...p, ...a, channel: 'pi-confirm' }); return card(ctx.cwd, p.node, r);
  });
  tool('defer', 'Owner deferral of prospective merge-tree invariants; debt remains and UI confirmation is required.', Type.Object({ node, items: Type.Array(node, { minItems: 1, description: 'Invariant IDs.' }), reason, as }), async (p, ctx) => {
    const who = p.as ?? 'owner:human';
    if (principal(who).role !== 'owner') throw new OwedError('Only owner may defer');
    const s = await ops.status(ctx), candidate = s.nodes[p.node]?.candidate;
    if (!candidate) throw new OwedError('defer requires a current candidate');
    const plan = await currentPlan(ctx.cwd);
    const m = await git.buildMerge(ctx.cwd, s.trunk.commit, candidate.commit, `owed merge ${p.node}`);
    if ('conflicts' in m) throw new OwedError('rebase needed');
    const facts = await git.stateFacts(ctx.cwd, plan, m.commit);
    const items = p.items.map(id => { const key = facts.invKeys[id]; if (!key) throw new OwedError(`Unknown invariant ${id}`); return { id, key }; });
    const a = await actor(ctx, who, `Defer post-merge invariants for node ${p.node}: ${p.items.join(', ')}\nReason: ${p.reason}\nThese obligations remain debt; they do not become passes.\n${JSON.stringify(items)}`);
    const r = await ops.defer({ ...a, channel: 'pi-confirm', node: p.node, reason: p.reason, items }); return result(r, renderReport(await ops.report({ cwd: ctx.cwd, since: r.seq - 1 })));
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
