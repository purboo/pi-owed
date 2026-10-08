import { ZERO, canonical } from './canon.ts';
import { OwedError } from './errors.ts';
import type { AttestJob, Block, CandidateFacts, Downgrade, Draft, Entry, ItemView, MergeGuard, NodeSpec, NodeState, ObsEntry, Plan, State, StateFacts } from './types.ts';

export type PlanLookup = (sha: string) => Plan;
const history = Symbol('owed.reducer.history');
interface History { entries: Entry[]; plans: PlanLookup; genesis?: Extract<Entry, { kind: 'genesis' }>; obsPlans: Map<number, Plan> }
type ReplayState = State & { [history]: History };
function context(state: State): History {
  const value = (state as ReplayState)[history];
  if (!value) throw new OwedError('状态缺少回放信息，请使用 reduce 返回的状态', 'internal');
  return value;
}
const active = (b: Block): boolean => b.state !== 'cleared';
const role = (by: string): string => by.split(':')[0] ?? '';
const blankPlan = (): Plan => ({ version: 1, trunk: '', closure: [], invariants: [], nodes: [] });
const emptyNode = (id: string): NodeState => ({ id, phase: 'blocked', items: [], blocks: [], accepted: false, dependents: 0, writers: [] });
const nodeSpec = (s: State, id: string): NodeSpec | undefined => s.plan.nodes.find(n => n.id === id);
const observations = (s: State, subject: string, obligation: string, key: string): ObsEntry[] => context(s).entries.filter((e): e is ObsEntry => e.kind === 'obs' && e.by === 'executor:owed' && e.subject === subject && e.obligation === obligation && e.key === key);
const hasVerdict = (s: State, subject: string, obligation: string, key: string): boolean => observations(s, subject, obligation, key).some(e => e.verdict !== 'error');

function required(spec: NodeSpec, facts: CandidateFacts): string[] {
  return [...spec.checks.flatMap(c => [`check:${c.id}`, ...(c.red ? [`red:${c.id}`] : [])]), 'writes', ...(facts.closureTouched ? ['closure-review'] : []), ...(spec.review.count > 0 ? ['review'] : []), 'rulings'];
}
function latestRule(s: State, node: string): number {
  return Math.max(-1, ...s.rules.filter(r => r.nodes === '*' || r.nodes.includes(node)).map(r => r.seq));
}
function item(s: State, subject: string, obligation: string, key: string): ItemView {
  const node = s.nodes[subject];
  const spec = nodeSpec(s, subject);
  const blocks = node?.blocks.filter(b => b.obligation === obligation && active(b)) ?? [];
  const out: ItemView = { subject, obligation, key, status: 'D', mark: '⊥', discharger: 'executor', evidence: [], detail: `${obligation} 待执行观察` };
  if (!key) return { ...out, detail: `${obligation} 缺少事实键` };
  if (obligation === 'review' || obligation === 'closure-review') {
    const rank = obligation === 'closure-review' ? 2 : spec?.review.min_rank ?? 1;
    const count = obligation === 'closure-review' ? 1 : spec?.review.count ?? 1;
    const reviews = context(s).entries.filter(e => e.kind === 'review' && e.node === subject && e.obligation === obligation && e.key === key && e.verdict === 'ok' && e.rank >= rank && !node?.writers.includes(e.by));
    out.evidence = reviews.map(e => e.seq);
    out.discharger = obligation === 'closure-review' ? 'owner' : 'reviewer';
    out.detail = `${obligation} 需要 ${count} 位等级至少 ${rank} 的非作者评审`;
    if (new Set(reviews.map(e => e.by)).size >= count) out.status = 'E';
  } else if (obligation === 'rulings') {
    const latest = latestRule(s, subject);
    const acknowledgments = context(s).entries.filter(e => e.kind === 'review' && e.node === subject && e.attempt === node?.slot?.attempt && e.seq > (node?.slot?.dispatchSeq ?? -1) && e.verdict === 'ok' && e.rank >= 1 && (e.ack_rulings ?? -1) >= latest && !node?.writers.includes(e.by) && e.key === node?.candidate?.keys[e.obligation]);
    if ((node?.slot?.rulings_seen ?? -1) >= latest || acknowledgments.length) {
      out.status = 'E';
      out.evidence = acknowledgments.length ? acknowledgments.map(e => e.seq) : [node!.slot!.dispatchSeq];
    }
    out.discharger = 'reviewer';
    out.detail = `rulings 需要确认适用裁决 #${latest}`;
  } else {
    const obs = observations(s, subject, obligation, key);
    const pass = obs.some(e => e.verdict === 'pass');
    const fail = obs.some(e => e.verdict === 'fail');
    out.evidence = obs.map(e => e.seq);
    if (pass && fail) Object.assign(out, { mark: '⊤', discharger: 'owner', detail: `${obligation} 同键通过与失败冲突` });
    else if (fail) Object.assign(out, { mark: '✘', discharger: 'writer', detail: `${obligation} 当前内容失败` });
    else if (pass) out.status = 'E';
  }
  if (blocks.length) {
    out.status = 'D';
    out.evidence = [...new Set([...out.evidence, ...blocks.map(b => b.seq)])];
    const currentFailed = out.mark === '✘';
    if (out.mark !== '⊤') out.mark = '封';
    out.discharger = out.mark === '⊤' || blocks.some(b => b.state === 'flaky' || (b.kind === 'judgment' && (b.rank ?? 0) >= 2)) ? 'owner' : blocks.some(b => b.kind === 'judgment') ? 'reviewer' : currentFailed ? 'writer' : 'executor';
    out.detail = `${obligation} 仍有封：${blocks.map(b => `#${b.seq}${b.state === 'flaky' ? ' 不稳定' : ''}`).join('、')}`;
  }
  if (out.status === 'E') return { ...out, mark: '✔', discharger: undefined, detail: `${obligation} 已满足` };
  if (subject !== 'trunk' && !obligation.startsWith('inv:')) {
    const waiver = context(s).entries.findLast(e => e.kind === 'waive' && role(e.by) === 'owner' && e.node === subject && e.obligation === obligation && e.key === key && blocks.every(b => (e.accept_risk ?? []).includes(b.seq) && e.seq > b.seq));
    if (waiver?.kind === 'waive') return { ...out, status: 'W', mark: '⚠', discharger: undefined, evidence: [...out.evidence, waiver.seq], detail: `${obligation} owner 免：${waiver.reason}${waiver.channel === 'flag' ? '（flag 弱确认）' : ''}` };
  }
  if (subject === 'trunk') {
    const defer = s.deferred.findLast(d => d.id === obligation.slice(4) && d.key === key);
    if (defer) Object.assign(out, { mark: '⏸', discharger: 'owner', detail: `${obligation} 已缓判，仍为债务`, evidence: [...out.evidence, defer.seq] });
  }
  return out;
}
function nodeItems(s: State, id: string, facts: CandidateFacts): ItemView[] {
  const spec = nodeSpec(s, id);
  return spec ? required(spec, facts).map(o => item(s, id, o, facts.keys[o] ?? '')) : [];
}
function refresh(s: State): void {
  for (const spec of s.plan.nodes) {
    const n = s.nodes[spec.id] ??= emptyNode(spec.id);
    n.items = n.candidate ? nodeItems(s, n.id, n.candidate) : [];
    n.accepted = !!n.candidate && (!!n.slot?.open || !!n.merged) && n.items.every(i => i.status !== 'D') && !n.blocks.some(active);
    n.phase = n.merged ? 'merged' : n.slot?.open ? n.candidate ? n.accepted ? 'accepted' : 'submitted' : 'dispatched' : spec.deps.every(d => s.nodes[d]?.merged) ? 'ready' : 'blocked';
    const seen = new Set<string>();
    const visit = (id: string): void => { for (const other of s.plan.nodes) if (other.deps.includes(id) && !seen.has(other.id)) { seen.add(other.id); visit(other.id); } };
    visit(n.id);
    n.dependents = seen.size;
  }
  s.invariants = s.plan.invariants.map(i => item(s, 'trunk', `inv:${i.id}`, s.trunk.invKeys[i.id] ?? ''));
  const g = context(s).genesis;
  s.genesisDone = !!g && s.plan.invariants.every(i => !!g.state.invKeys[i.id] && hasVerdict(s, 'trunk', `inv:${i.id}`, g.state.invKeys[i.id]!));
}

/** Replay is deterministic; non-enumerable metadata retains the observations needed by pure queries. */
export function reduce(entries: Entry[], plans: PlanLookup): State {
  const s: State = { seq: -1, head: ZERO, genesisDone: false, trunk: { name: '', commit: '', tree: '', invKeys: {}, seq: -1 }, planSha: '', plan: blankPlan(), nodes: Object.create(null) as Record<string, NodeState>, invariants: [], rules: [], downgrades: [], deferred: [] };
  const h: History = { entries: [], plans, obsPlans: new Map() };
  Object.defineProperty(s, history, { value: h });
  for (const original of entries) {
    const e = structuredClone(original);
    const errors = validateDraft(s, e);
    if (errors.length) throw new OwedError(`记录 #${e.seq} 无效：${errors.join('；')}`);
    if (e.kind === 'genesis') {
      h.genesis = e;
      s.plan = structuredClone(plans(e.plan)); s.planSha = e.plan;
      s.trunk = { name: e.trunk, ...e.state, seq: e.seq };
    } else if (e.kind === 'plan') {
      const next = structuredClone(plans(e.plan));
      const detected = downgradeDetails(s.plan, next);
      s.plan = next; s.planSha = e.plan;
      const items = [...e.downgrades, ...detected.filter(d => !e.downgrades.some(x => x.node === d.node && x.what === d.what))];
      if (items.length) s.downgrades.push({ seq: e.seq, by: e.by, items });
    } else if (e.kind === 'rule') s.rules.push({ seq: e.seq, by: e.by, text: e.text, nodes: e.nodes });
    else if (e.kind === 'dispatch') {
      const n = s.nodes[e.node]!;
      const writer = `writer:${e.node}#${e.attempt}`;
      n.slot = { attempt: e.attempt, base: e.base, branch: e.branch, worktree: e.worktree, writer, dispatchSeq: e.seq, rulings_seen: e.rulings_seen, open: true };
      n.candidate = undefined;
      if (!n.writers.includes(writer)) n.writers.push(writer);
    } else if (e.kind === 'submit') s.nodes[e.node]!.candidate = { ...e.facts, seq: e.seq };
    else if (e.kind === 'abandon') { s.nodes[e.node]!.slot!.open = false; s.nodes[e.node]!.candidate = undefined; }
    else if (e.kind === 'obs') {
      h.obsPlans.set(e.seq, s.plan);
      const n = s.nodes[e.subject];
      if (n) {
        const matches = n.blocks.filter(b => b.kind === 'exec' && b.state === 'active' && b.obligation === e.obligation && b.key === e.key);
        if (e.attribution && e.verdict !== 'error') for (const b of matches) {
          b.state = e.verdict === 'fail' ? 'cleared' : 'flaky';
          if (b.state === 'cleared') b.clearedBy = e.seq;
        }
        if (e.verdict === 'fail' && !e.attribution) n.blocks.push({ seq: e.seq, node: e.subject, obligation: e.obligation, kind: 'exec', key: e.key, state: 'active' });
      }
    } else if (e.kind === 'review') {
      const n = s.nodes[e.node]!;
      if (e.verdict === 'block') n.blocks.push({ seq: e.seq, node: e.node, obligation: e.obligation, kind: 'judgment', key: e.key, rank: e.rank, state: 'active' });
      else for (const b of n.blocks) if (active(b) && b.kind === 'judgment' && b.obligation === e.obligation && e.key === n.candidate?.keys[e.obligation] && e.rank >= (b.rank ?? 0)) { b.state = 'cleared'; b.clearedBy = e.seq; }
    } else if (e.kind === 'waive') {
      const n = s.nodes[e.node]!;
      for (const b of n.blocks) if (active(b) && b.obligation === e.obligation && e.key === n.candidate?.keys[e.obligation] && e.accept_risk?.includes(b.seq)) { b.state = 'cleared'; b.clearedBy = e.seq; }
    } else if (e.kind === 'defer') {
      for (const i of e.items) s.deferred.push({ seq: e.seq, node: e.node, id: i.id, key: i.key });
    } else if (e.kind === 'merge') {
      const n = s.nodes[e.node]!;
      n.merged = { seq: e.seq, commit: e.commit }; n.slot!.open = false;
      s.trunk = { name: s.trunk.name, ...e.state, seq: e.seq };
    }
    h.entries.push(e); s.seq = e.seq; s.head = e.hash;
    refresh(s);
  }
  return s;
}

// Conservative local downgrade detection keeps this leaf independent of plan.ts.
function downgradeDetails(prev: Plan, next: Plan): Downgrade[] {
  const result: Downgrade[] = [];
  const add = (node: string, what: string): void => { result.push({ node, what }); };
  const checks = (node: string, a: Plan['invariants'], b: Plan['invariants']): void => {
    for (const c of a) {
      const d = b.find(x => x.id === c.id);
      if (!d) { add(node, `${c.id} 检查移除`); continue; }
      if (c.red && !d.red) add(node, `${c.id} red 关闭`);
      if ((d.min_tests ?? 0) < (c.min_tests ?? 0)) add(node, `${c.id} min_tests 降低`);
      if (c.run !== d.run || c.timeout_s !== d.timeout_s || canonical(c.reads) !== canonical(d.reads) || canonical(c.tests) !== canonical(d.tests) || c.red_expect !== d.red_expect) add(node, `${c.id} 检查定义改变，无法证明未降低义务`);
    }
  };
  if (prev.setup !== next.setup || canonical(prev.closure) !== canonical(next.closure)) add('*', 'setup/closure 改变，无法证明未降低义务');
  checks('trunk', prev.invariants, next.invariants);
  for (const n of prev.nodes) {
    const m = next.nodes.find(x => x.id === n.id);
    if (!m) { add(n.id, '节点移除'); continue; }
    checks(n.id, n.checks, m.checks);
    if (m.review.count < n.review.count || m.review.min_rank < n.review.min_rank) add(n.id, '评审 count/rank 降低');
    if (m.writes.some(w => !n.writes.some(p => w.startsWith(p)))) add(n.id, 'writes 范围扩大');
    if (n.deps.some(d => !m.deps.includes(d))) add(n.id, '依赖移除');
  }
  return result;
}
export function validateDraft(s: State, d: Draft): string[] {
  const errors: string[] = [];
  const r = role(d.by);
  const allow = (...roles: string[]): void => { if (!roles.includes(r)) errors.push(`${d.kind} 权限不足，需要 ${roles.join('/')}`); };
  if (!/^(owner|parent|writer|reviewer|executor):.+$/.test(d.by)) errors.push('身份格式无效');
  if (d.kind === 'genesis') {
    allow('owner');
    if (s.seq !== -1) errors.push('genesis 只能是首条记录');
    if (d.commit !== d.state.commit) errors.push('genesis commit 与事实不一致');
    return errors;
  }
  if (s.seq === -1) return [...errors, '必须先建立 genesis'];
  const n = 'node' in d ? s.nodes[d.node] : undefined;
  const spec = 'node' in d ? nodeSpec(s, d.node) : undefined;
  if ('node' in d && (!n || !spec)) errors.push(`节点 ${d.node} 不存在`);
  const slot = (): void => { if (!n?.slot?.open || !('attempt' in d) || n.slot.attempt !== d.attempt) errors.push('attempt 必须匹配当前开放的 writer slot'); };
  const current = (o: string, key: string, reviewOnly = false): void => { if (!n?.slot?.open || !n.candidate || !spec || (!required(spec, n.candidate).includes(o) && !(reviewOnly && o === 'review') && !n.blocks.some(b => b.obligation === o && active(b))) || !key || n.candidate.keys[o] !== key) errors.push(`${o} 必须引用当前候选的义务键`); };
  switch (d.kind) {
    case 'plan': {
      allow('owner', 'parent');
      if (d.prior !== s.planSha) errors.push('plan prior 必须引用当前 plan sha');
      let downgrade = d.downgrades.length > 0;
      try { downgrade = downgradeDetails(s.plan, context(s).plans(d.plan)).length > 0 || downgrade; } catch { errors.push('无法读取新 plan'); }
      if (downgrade && r !== 'owner') errors.push('降低义务的 plan 只能由 owner 批准');
      break;
    }
    case 'rule': allow('owner', 'parent'); if (d.nodes !== '*' && d.nodes.some(id => !nodeSpec(s, id))) errors.push('rule 引用了不存在的节点'); break;
    case 'dispatch':
      allow('parent', 'owner');
      if (n?.phase !== 'ready' || n.slot?.open) errors.push('dispatch 需要 ready 节点且无开放 slot');
      if (!Number.isInteger(d.attempt) || d.attempt !== (n?.slot?.attempt ?? 0) + 1) errors.push('attempt 必须从 1 开始连续递增');
      if (d.base !== s.trunk.commit) errors.push('dispatch base 必须是当前 trunk');
      if (!Number.isInteger(d.rulings_seen) || d.rulings_seen < -1 || d.rulings_seen > Math.max(0, ...s.rules.map(x => x.seq))) errors.push('rulings_seen 不得引用尚不存在的裁决');
      break;
    case 'submit':
      slot(); if (d.by !== n?.slot?.writer) errors.push('submit 只能由 slot writer 提交');
      if (d.facts.base !== n?.slot?.base) errors.push('submit base 必须匹配 slot base');
      if (spec && required(spec, d.facts).some(o => !d.facts.keys[o])) errors.push('submit 缺少必要义务键');
      break;
    case 'obs':
      if (d.by !== 'executor:owed') errors.push('obs 只能由 executor:owed 写入');
      if (d.subject === 'trunk') {
        if (!d.obligation.startsWith('inv:') || !s.plan.invariants.some(i => `inv:${i.id}` === d.obligation)) errors.push('trunk obs 必须引用 invariant 义务');
        if (d.attribution) errors.push('invariant 不使用节点归因重跑');
      } else {
        const target = s.nodes[d.subject];
        if (!target) errors.push('obs 节点不存在');
        if (!/^(check:.+|red:.+|writes)$/.test(d.obligation)) errors.push('obs 只能观察执行义务');
        if (d.attribution && !target?.blocks.some(b => b.kind === 'exec' && b.state === 'active' && b.key === d.key && b.obligation === d.obligation && context(s).entries.some(e => e.kind === 'obs' && e.seq === b.seq && e.commit === d.commit && e.base === d.base))) errors.push('归因必须匹配活动执行封的原始 key/commit/base');
      }
      if (!d.key) errors.push('obs 缺少义务键');
      break;
    case 'review':
      allow('reviewer', 'owner'); slot(); current(d.obligation, d.key, true);
      if (n?.writers.includes(d.by) || n?.writers.some(w => w.slice(w.indexOf(':') + 1) === d.by.slice(d.by.indexOf(':') + 1))) errors.push('review 评审者不得是节点任一 attempt 的 writer');
      if (r === 'owner' ? d.rank !== 3 : ![1, 2].includes(d.rank)) errors.push('review rank：reviewer 为 1..2，owner 为 3');
      if (d.ack_rulings !== undefined && (!Number.isInteger(d.ack_rulings) || d.ack_rulings > Math.max(0, ...s.rules.map(x => x.seq)))) errors.push('ack_rulings 不得引用未来裁决');
      break;
    case 'waive':
      allow('owner'); current(d.obligation, d.key);
      if (d.obligation.startsWith('inv:') || d.node === 'trunk') errors.push('invariant 永远不能 waive');
      if (!d.reason.trim()) errors.push('waive 必须说明原因');
      if (d.accept_risk?.some(seq => !n?.blocks.some(b => b.seq === seq && b.obligation === d.obligation && active(b)))) errors.push('accept_risk 必须引用该义务的活动封');
      break;
    case 'defer':
      allow('owner');
      if (!n?.slot?.open || !n.candidate) errors.push('defer 需要当前候选');
      if (!d.reason.trim() || !d.items.length) errors.push('defer 必须列出义务并说明原因');
      if (d.items.some(i => !i.key || !s.plan.invariants.some(c => c.id === i.id))) errors.push('defer 必须引用有效 invariant 和键');
      break;
    case 'abandon': allow('parent', 'owner'); slot(); break;
    case 'merge':
      if (d.by !== 'executor:owed') errors.push('merge 只能由 executor:owed 写入');
      slot();
      if (d.prior !== s.trunk.commit) errors.push('merge prior 必须引用当前 trunk');
      if (d.commit !== d.facts.commit || d.commit !== d.state.commit) errors.push('merge commit 与事实不一致');
      if (n && spec) errors.push(...mergeGuard(s, d.node, { facts: d.facts, state: d.state }).reasons);
      break;
    case 'note': break;
  }
  return errors;
}

function job(spec: NodeSpec | undefined, subject: string, obligation: string, key: string, commit: string, base: string, plan: Plan): AttestJob | undefined {
  if (obligation === 'writes') return { kind: 'writes', subject, obligation, key, commit, base };
  const [kind, id] = obligation.split(':');
  if (kind !== 'check' && kind !== 'red' && kind !== 'inv') return undefined;
  const check = (kind === 'inv' ? plan.invariants : spec?.checks)?.find(c => c.id === id);
  return check ? { kind, subject, obligation, key, spec: structuredClone(check), commit, base } : undefined;
}
export function attestJobs(s: State, id: string): AttestJob[] {
  const n = s.nodes[id];
  if (!n) throw new OwedError(`节点 ${id} 不存在`);
  const jobs: AttestJob[] = [];
  const seen = new Set<string>();
  for (const b of n.blocks) if (b.kind === 'exec' && b.state === 'active') {
    const e = context(s).entries.find((e): e is ObsEntry => e.kind === 'obs' && e.seq === b.seq);
    if (!e) continue;
    const token = `${b.obligation}\0${b.key}`;
    if (seen.has(token)) continue;
    seen.add(token);
    const plan = context(s).obsPlans.get(b.seq)!;
    const j = job(plan.nodes.find(x => x.id === id), id, b.obligation, b.key, e.commit, e.base ?? e.commit, plan);
    if (j) jobs.push({ ...j, attribution: true });
  }
  if (n.candidate && n.slot?.open) for (const o of required(nodeSpec(s, id)!, n.candidate)) {
    const key = n.candidate.keys[o];
    if (!key || hasVerdict(s, id, o, key)) continue;
    const j = job(nodeSpec(s, id), id, o, key, n.candidate.commit, n.slot.base, s.plan);
    if (j) jobs.push(j);
  }
  return jobs;
}
export function genesisJobs(s: State): AttestJob[] {
  const g = context(s).genesis;
  if (!g) return [];
  return s.plan.invariants.flatMap(i => {
    const key = g.state.invKeys[i.id];
    if (!key || hasVerdict(s, 'trunk', `inv:${i.id}`, key)) return [];
    return [job(undefined, 'trunk', `inv:${i.id}`, key, g.commit, g.commit, s.plan)!];
  });
}
export function mergeJobs(s: State, id: string, m: { facts: CandidateFacts; state: StateFacts }): AttestJob[] {
  const spec = nodeSpec(s, id);
  if (!spec || !s.nodes[id]?.candidate) throw new OwedError(`节点 ${id} 没有当前候选`);
  const jobs: AttestJob[] = [];
  for (const c of spec.checks) {
    const o = `check:${c.id}`, key = m.facts.keys[o];
    if (key && !hasVerdict(s, id, o, key)) jobs.push(job(spec, id, o, key, m.facts.commit, m.facts.base, s.plan)!);
  }
  for (const i of s.plan.invariants) {
    const key = m.state.invKeys[i.id];
    if (key && !hasVerdict(s, 'trunk', `inv:${i.id}`, key)) jobs.push(job(undefined, 'trunk', `inv:${i.id}`, key, m.state.commit, m.state.commit, s.plan)!);
  }
  return jobs;
}
export function mergeGuard(s: State, id: string, m: { facts: CandidateFacts; state: StateFacts }): MergeGuard {
  const reasons: string[] = [];
  const n = s.nodes[id], spec = nodeSpec(s, id);
  const nodeItemsOnMerge: ItemView[] = [];
  if (!n?.accepted) reasons.push(`节点 ${id} 当前候选尚未接收`);
  if (m.facts.base !== s.trunk.commit) reasons.push('writes 合并事实的 base 必须是当前 trunk');
  if (m.facts.commit !== m.state.commit || m.facts.tree !== m.state.tree) reasons.push('合并事实 commit/tree 不一致');
  if (n?.candidate && spec) {
    for (const o of required(spec, n.candidate)) {
      const onMerge = o === 'writes' || o.startsWith('check:');
      const v = item(s, id, o, (onMerge ? m.facts.keys[o] : n.candidate.keys[o]) ?? '');
      // CandidateFacts.changed is trusted git output for PRE..M. Unlike command
      // checks, writes can be re-evaluated synchronously without an executor job.
      if (o === 'writes' && m.facts.keys.writes) {
        if (m.facts.changed.some(p => !spec.writes.some(prefix => p.startsWith(prefix)))) Object.assign(v, { status: 'D', mark: '✘', discharger: 'writer', detail: 'writes 合并改动超出允许路径' });
        else if (v.mark === '⊥') Object.assign(v, { status: 'E', mark: '✔', discharger: undefined, detail: 'writes 合并改动已重新核对允许路径' });
      }
      nodeItemsOnMerge.push(v);
      if (v.status === 'D') reasons.push(`${id} 的 ${o} 未满足：${v.detail}`);
    }
    if (n.blocks.some(active)) reasons.push(`${id} 仍有活动封：${n.blocks.filter(active).map(b => `${b.obligation} #${b.seq}`).join('、')}`);
  }
  const invItems = s.plan.invariants.map(i => {
    const key = m.state.invKeys[i.id] ?? '';
    const v = item(s, 'trunk', `inv:${i.id}`, key);
    if (!key) reasons.push(`invariant ${i.id} 缺少合并义务键`);
    else if (key !== s.trunk.invKeys[i.id] && v.status !== 'E') {
      const d = s.deferred.findLast(d => d.node === id && d.id === i.id && d.key === key && d.seq > (n?.slot?.dispatchSeq ?? Infinity));
      if (d) Object.assign(v, { status: 'D', mark: '⏸', discharger: 'owner', evidence: [...new Set([...v.evidence, d.seq])], detail: `inv:${i.id} owner 缓判，仍为债务` });
      else reasons.push(`invariant ${i.id} 新增债务：需要合并键上的实测通过或该节点的 owner defer`);
    }
    return v;
  });
  if (!s.genesisDone) reasons.push('genesis invariant 初始观察尚未完成');
  return { ok: reasons.length === 0, reasons, nodeItems: nodeItemsOnMerge, invItems };
}
