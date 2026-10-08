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
  if (!m) throw new OwedError('as 必须为 role:id', 'usage');
  return { role: m[1] as Role, id: m[2]! };
}
async function actor(ctx: ExtensionContext, value?: string, summary?: string) {
  const p = principal(value);
  if (p.role !== 'owner') return { cwd: ctx.cwd, as: p };
  if (!ctx.hasUI) throw new OwedError('owner 操作需要 UI 确认；当前无 UI');
  if (!await ctx.ui.confirm('owed：确认 owner 决策', `${summary ?? '以 owner 身份执行操作'}\n身份：owner:${p.id}\n确认将记录为 pi-confirm。`)) throw new OwedError('owner 未确认，操作已取消');
  return { cwd: ctx.cwd, as: p, channel: 'pi-confirm' as const };
}
async function currentPlan(cwd: string) {
  const ledger = await Ledger.open(cwd);
  const law = (await ledger.read()).findLast(e => e.kind === 'plan' || e.kind === 'genesis');
  if (!law || (law.kind !== 'plan' && law.kind !== 'genesis')) throw new OwedError('缺少计划');
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
          return { ...result({ code: e.code, reason: e.message }, `拒绝：${e.message}`), isError: true };
        }
      } });
  }
  const card = async (cwd: string, id: string, data: unknown) => result(data, renderReceipt(await ops.why({ cwd, node: id })));
  tool('status', '查看状态、可派发节点与待办队列。', Type.Object({ as }), async (_p, ctx) => { const r = await ops.status(ctx); return result(r, renderStatus(r)); });
  tool('why', '查看节点验收卡、证据与拒收原因。', Type.Object({ node, as }), async (p, ctx) => { const r = await ops.why({ cwd: ctx.cwd, node: p.node }); return result(r, renderReceipt(r)); });
  tool('report', '查看合并、债务、免除和 owner 决策。', Type.Object({ since: Type.Optional(Type.Union([Type.Integer(), Type.String()])), as }), async (p, ctx) => { const r = await ops.report({ cwd: ctx.cwd, since: p.since }); return result(r, renderReport(r)); });
  tool('dispatch', '派发节点；返回 packet 和可直接传给 subagents 的调用参数。', Type.Object({ node, as }), async (p, ctx) => {
    const r = await ops.dispatch({ ...await actor(ctx, p.as, `派发节点 ${p.node}`), node: p.node });
    const subagents = { ...r.subagent, isolation: 'none' as const };
    return result({ ...r, subagents }, `${r.packet}\n\nsubagents: ${JSON.stringify(subagents)}\n${renderStatus(await ops.status(ctx))}`);
  });
  tool('submit', '提交已 commit 的干净 writer worktree；在 slot 目录内自动推断 writer。', Type.Object({ node, commit: Type.Optional(Type.String()), as }), async (p, ctx) => {
    let who = p.as;
    if (!who) {
      const slot = (await ops.status(ctx)).nodes[p.node]?.slot;
      if (slot && resolve(await git.repoRoot(ctx.cwd)) === resolve(slot.worktree)) who = slot.writer;
    }
    const r = await ops.submit({ ...await actor(ctx, who, `提交节点 ${p.node}`), node: p.node, commit: p.commit });
    return card(ctx.cwd, p.node, r);
  });
  tool('attest', '由 owed executor 实测候选并归因重跑旧失败；as 不改变 executor 身份。', Type.Object({ node, rerun: Type.Optional(Type.Boolean()), as }), async (p, ctx) => {
    const r = await ops.attest({ cwd: ctx.cwd, node: p.node, rerun: p.rerun }); return result(r, renderReceipt(r.receipt));
  });
  tool('review', '独立评审；必须显式指定 reviewer:id（owner 需 UI 确认），不得自评。', Type.Object({ node, as, verdict: Type.Union([Type.Literal('ok'), Type.Literal('block')]), rank: Type.Integer({ minimum: 1, maximum: 3 }), note: Type.String(), ack_rulings: Type.Optional(Type.Integer({ minimum: 0 })), obligation: Type.Optional(Type.Union([Type.Literal('review'), Type.Literal('closure-review')])) }), async (p, ctx) => {
    if (!p.as || !['reviewer', 'owner'].includes(principal(p.as).role)) throw new OwedError('review 必须显式指定 reviewer:id 或 owner:id');
    const r = await ops.review({ ...p, ...await actor(ctx, p.as, `评审 ${p.node}/${p.obligation ?? 'review'}：${p.verdict}，rank ${p.rank}\n${p.note}`) }); return card(ctx.cwd, p.node, r);
  });
  tool('merge', '执行 merge guard，实测合并树并 CAS 推进 trunk。', Type.Object({ node, as }), async (p, ctx) => { const r = await ops.merge({ ...await actor(ctx, p.as, `合并节点 ${p.node}`), node: p.node }); return card(ctx.cwd, p.node, r); });
  tool('rule', '记录适用节点的裁决。', Type.Object({ text: reason, nodes: Type.Union([Type.Literal('*'), Type.Array(node)]), as }), async (p, ctx) => {
    const r = await ops.rule({ ...p, ...await actor(ctx, p.as, `裁决 ${JSON.stringify(p.nodes)}：${p.text}`) }); return result(r, renderReport(await ops.report({ cwd: ctx.cwd, since: r.seq - 1 })));
  });
  tool('plan', '从 plan 文件更新计划；降级必须由 owner 经 UI 确认。', Type.Object({ plan: Type.String({ minLength: 1, description: 'Plan file path, relative to ctx.cwd.' }), as }), async (p, ctx) => {
    const text = await readFile(resolve(ctx.cwd, p.plan), 'utf8');
    const downgrades = planDowngrades(await currentPlan(ctx.cwd), parsePlan(text));
    const who = p.as ?? (downgrades.length ? 'owner:human' : 'parent:pi');
    if (downgrades.length && principal(who).role !== 'owner') throw new OwedError('计划降级仅 owner 可确认');
    const r = await ops.planSet({ ...await actor(ctx, who, `更新计划 ${p.plan}\n降级义务：${JSON.stringify(downgrades)}\n降级会减少验收要求。`), plan: text });
    return result(r, renderStatus(await ops.status(ctx)));
  });
  tool('waive', 'owner 免除当前义务；必须 UI 确认，accept_risk 显式引用封的 seq。', Type.Object({ node, obligation: reason, reason, accept_risk: Type.Optional(Type.Array(Type.Integer({ minimum: 0 }))), as }), async (p, ctx) => {
    const who = p.as ?? 'owner:human';
    if (principal(who).role !== 'owner') throw new OwedError('waive 仅 owner 可执行');
    const a = await actor(ctx, who, `免除 ${p.node}/${p.obligation}\n原因：${p.reason}\n承担风险（封 seq）：${JSON.stringify(p.accept_risk ?? [])}\n该义务将显示为免除，不是实测通过。`);
    const r = await ops.waive({ ...p, ...a, channel: 'pi-confirm' }); return card(ctx.cwd, p.node, r);
  });
  tool('defer', 'owner 缓判待合并树的不变量；债务仍然保留，必须 UI 确认。', Type.Object({ node, items: Type.Array(node, { minItems: 1, description: 'Invariant IDs.' }), reason, as }), async (p, ctx) => {
    const who = p.as ?? 'owner:human';
    if (principal(who).role !== 'owner') throw new OwedError('defer 仅 owner 可执行');
    const s = await ops.status(ctx), candidate = s.nodes[p.node]?.candidate;
    if (!candidate) throw new OwedError('defer 需要当前候选');
    const plan = await currentPlan(ctx.cwd);
    const m = await git.buildMerge(ctx.cwd, s.trunk.commit, candidate.commit, `owed merge ${p.node}`);
    if ('conflicts' in m) throw new OwedError('rebase needed');
    const facts = await git.stateFacts(ctx.cwd, plan, m.commit);
    const items = p.items.map(id => { const key = facts.invKeys[id]; if (!key) throw new OwedError(`未知不变量 ${id}`); return { id, key }; });
    const a = await actor(ctx, who, `缓判节点 ${p.node} 合并后的不变量：${p.items.join('、')}\n原因：${p.reason}\n这些义务仍为债务，不会变为通过。\n${JSON.stringify(items)}`);
    const r = await ops.defer({ ...a, channel: 'pi-confirm', node: p.node, reason: p.reason, items }); return result(r, renderReport(await ops.report({ cwd: ctx.cwd, since: r.seq - 1 })));
  });
  pi.registerCommand('owed', { description: 'owed status；/owed why <node> 查看验收卡', handler: async (args, ctx) => {
    try {
      const parts = args.trim().split(/\s+/);
      let text: string;
      if (!args.trim() || args.trim() === 'status') text = renderStatus(await ops.status(ctx));
      else if (parts.length === 2 && parts[0] === 'why') text = renderReceipt(await ops.why({ cwd: ctx.cwd, node: parts[1]! }));
      else throw new OwedError('用法：/owed 或 /owed why <node>', 'usage');
      ctx.ui.notify(text, 'info');
    } catch (e) { if (!(e instanceof OwedError)) throw e; ctx.ui.notify(`拒绝：${e.message}`, 'error'); }
  } });
}
