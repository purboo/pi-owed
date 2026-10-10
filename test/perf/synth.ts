// N4: a deterministic synthetic ledger (entries + plan lookup) that the 0.10 reducer accepts: waves of nodes go
// through dispatch, launches, a failing then a passing candidate, attribution, review blocks and oks, rulings and
// their acknowledgments, halts, waivers, manual obligations, plan changes and merges, padded to about `target` entries.
import { H, sha256 } from '../../src/canon.ts';
import { entryHash } from '../../src/ledger.ts';
import { manualKeys, runId, runLabels } from '../../src/reducer.ts';
import type { CandidateFacts, Draft, Entry, NodeSpec, Plan } from '../../src/types.ts';

const hex = (s: string): string => sha256(s);
export interface Synth { entries: Entry[]; plans: Map<string, Plan>; lookup: (sha: string) => Plan }

export function synthLedger(target = 10_000, count = 200, wave = 10): Synth {
  const entries: Entry[] = [], plans = new Map<string, Plan>();
  const add = (d: Draft): Entry => {
    const e = { ...d, seq: entries.length, ts: new Date(Date.UTC(2026, 0, 1) + entries.length * 1000).toISOString(), prev: entries.at(-1)?.hash ?? '0'.repeat(64) } as Entry;
    e.hash = entryHash(e); entries.push(e); return e;
  };
  const spec = (i: number): NodeSpec => {
    const w = Math.floor(i / wave), deps = w > 0 ? [`n${(w - 1) * wave + (i % wave)}`, ...(i % 3 === 0 && w > 1 ? [`n${(w - 2) * wave}`] : [])] : [];
    return { id: `n${i}`, title: `node ${i}`, deps, writes: [`src/n${i}/`], checks: [{ id: 'unit', run: `test ${i}`, timeout_s: 10, reads: ['**'], red: true, tests: ['test/**'] }], review: { count: 1, min_rank: 1 }, ...(i % 7 === 3 ? { approve: 'owner' as const } : {}), ...(i % 11 === 5 ? { evidence: [{ id: 'shot', what: 'a screenshot', by: 'reviewer' as const }] } : {}) };
  };
  let plan: Plan = { version: 1, trunk: 'main', closure: ['config/**'], invariants: [{ id: 'safe', run: 'safe', timeout_s: 10, reads: ['**'] }, { id: 'lint', run: 'lint', timeout_s: 10, reads: ['**'] }], nodes: Array.from({ length: count }, (_, i) => spec(i)) };
  const putPlan = (p: Plan): string => { const sha = H(p); plans.set(sha, structuredClone(p)); return sha; };
  let planSha = putPlan(plan);
  const inv = { safe: hex('inv-safe'), lint: hex('inv-lint') };
  let trunk = hex('trunk0');
  const genesis = add({ kind: 'genesis', by: 'owner:human', channel: 'tty', trunk: 'main', commit: trunk, plan: planSha, state: { commit: trunk, tree: hex('tree0'), invKeys: inv } });
  const project = genesis.hash.slice(0, 12);
  for (const id of ['safe', 'lint'] as const) add({ kind: 'obs', by: 'executor:owed', subject: 'trunk', obligation: `inv:${id}`, key: inv[id], verdict: 'pass', exit: 0, durationMs: 5, commit: trunk, base: trunk });
  let latestRule = -1;
  const perNode = Math.max(0, Math.floor(target / count) - 17);
  const facts = (i: number, tag: string, base: string): CandidateFacts => {
    const s = plan.nodes[i]!, patch = hex(`patch${i}${tag}`);
    return { commit: hex(`c${i}${tag}`).slice(0, 40), tree: hex(`t${i}${tag}`).slice(0, 40), base, patch, changed: [`src/n${i}/a.ts`], closureTouched: false, keys: { 'check:unit': hex(`check${i}${tag}`), 'red:unit': hex(`red${i}${tag}`), writes: hex(`writes${i}${tag}`), review: hex(`review${i}${tag}`), rulings: hex(`rulings${i}${tag}`), ...manualKeys(s, patch) } };
  };
  for (let w = 0; w * wave < count; w++) {
    const ids = Array.from({ length: Math.min(wave, count - w * wave) }, (_, k) => w * wave + k);
    if (w % 3 === 2) { latestRule = add({ kind: 'rule', by: 'parent:main', text: `rule for wave ${w}`, nodes: w % 6 === 2 ? '*' : ids.slice(0, 3).map(i => `n${i}`) }).seq; }
    if (w % 4 === 1 && (w + 1) * wave < count) {
      // A plan change that renames later nodes (not yet dispatched): no downgrade, no candidate invalidated.
      const next = structuredClone(plan); for (const n of next.nodes.slice((w + 1) * wave, (w + 2) * wave)) n.title = `${n.title} (v${w})`;
      const sha = putPlan(next); add({ kind: 'plan', by: 'parent:main', prior: planSha, plan: sha, downgrades: [] }); plan = next; planSha = sha;
    }
    const base = trunk, A: Record<number, CandidateFacts> = {}, B: Record<number, CandidateFacts> = {}, blocks: Record<number, number> = {}, judgments: Record<number, number> = {};
    const steps: ((i: number) => void)[] = [
      i => { add({ kind: 'dispatch', by: 'parent:drive', node: `n${i}`, attempt: 1, base, branch: `feat/n${i}-1`, worktree: `/wt/n${i}-1`, packet: hex(`packet${i}`), rulings_seen: latestRule }); },
      i => { add({ kind: 'launch', by: 'parent:drive', node: `n${i}`, attempt: 1, role: 'writer', rid: runId(project, `n${i}`, 1, 'writer'), spec: hex(`spec${i}`), labels: runLabels(project, `n${i}`, 1, 'writer') }); },
      i => { A[i] = facts(i, 'A', base); add({ kind: 'submit', by: `writer:n${i}#1`, node: `n${i}`, attempt: 1, facts: A[i]! }); },
      i => { blocks[i] = add({ kind: 'obs', by: 'executor:owed', subject: `n${i}`, obligation: 'check:unit', key: A[i]!.keys['check:unit']!, verdict: 'fail', exit: 1, durationMs: 9, commit: A[i]!.commit, base }).seq; },
      i => { add({ kind: 'obs', by: 'executor:owed', subject: `n${i}`, obligation: 'red:unit', key: A[i]!.keys['red:unit']!, verdict: 'pass', exit: 0, durationMs: 9, commit: A[i]!.commit, base }); },
      i => { add({ kind: 'obs', by: 'executor:owed', subject: `n${i}`, obligation: 'writes', key: A[i]!.keys.writes!, verdict: 'pass', exit: 0, durationMs: 1, commit: A[i]!.commit, base }); },
      i => { add({ kind: 'launch', by: 'parent:drive', node: `n${i}`, attempt: 1, role: 'reviewer', rid: `${runId(project, `n${i}`, 1, 'reviewer')}:1`, spec: hex(`rspec${i}`), labels: runLabels(project, `n${i}`, 1, 'reviewer') }); },
      i => { judgments[i] = add({ kind: 'review', by: `reviewer:r${i}`, node: `n${i}`, attempt: 1, obligation: 'review', key: A[i]!.keys.review!, verdict: 'block', rank: 1, note: 'fix it' }).seq; },
      i => { const rid = runId(project, `n${i}`, 1, 'writer'); add({ kind: 'send', by: 'parent:drive', node: `n${i}`, attempt: 1, rid, send: `${rid}:follow-up:${entries.length}`, sendKind: 'follow-up', message: hex(`msg${i}`), reason: 'repair' }); },
      i => { if (i % 5 === 1) add({ kind: 'halt', by: 'parent:drive', node: `n${i}`, attempt: 1, reason: 'stuck', needs: 'human' }); },
      i => { B[i] = facts(i, 'B', base); add({ kind: 'submit', by: `writer:n${i}#1`, node: `n${i}`, attempt: 1, facts: B[i]! }); },
      i => { add({ kind: 'obs', by: 'executor:owed', subject: `n${i}`, obligation: 'check:unit', key: A[i]!.keys['check:unit']!, verdict: 'fail', exit: 1, durationMs: 9, commit: A[i]!.commit, base, attribution: true }); },
      i => { for (const o of ['check:unit', 'red:unit', 'writes']) add({ kind: 'obs', by: 'executor:owed', subject: `n${i}`, obligation: o, key: B[i]!.keys[o]!, verdict: 'pass', exit: 0, durationMs: 9, commit: B[i]!.commit, base }); },
      i => {
        if (i % 13 === 0) add({ kind: 'waive', by: 'owner:human', channel: 'delegated', node: `n${i}`, obligation: 'review', key: B[i]!.keys.review!, reason: 'accepted risk', accept_risk: [judgments[i]!] });
        add({ kind: 'review', by: i % 13 === 0 ? `reviewer:x${i}` : `reviewer:r${i}`, node: `n${i}`, attempt: 1, obligation: 'review', key: B[i]!.keys.review!, verdict: 'ok', rank: i % 13 === 0 ? 2 : 1, ...(latestRule >= 0 ? { ack_rulings: latestRule } : {}) });
      },
      i => { if (plan.nodes[i]!.approve) add({ kind: 'review', by: 'owner:human', channel: 'delegated', node: `n${i}`, attempt: 1, obligation: 'approve', key: B[i]!.keys.approve!, verdict: 'ok', rank: 3 }); },
      i => { if (plan.nodes[i]!.evidence) add({ kind: 'evidence', by: `reviewer:e${i}`, node: `n${i}`, attempt: 1, key: B[i]!.keys['evidence:shot']!, id: 'shot', files: [{ path: `shots/n${i}.png`, sha256: hex(`png${i}`), bytes: 42 }], note: 'looks right' }); },
      i => {
        for (let k = 0; k < perNode; k++) {
          if (k % 3 === 0) add({ kind: 'obs', by: 'executor:owed', subject: `n${i}`, obligation: 'check:unit', key: B[i]!.keys['check:unit']!, verdict: 'error', exit: null, durationMs: 9, commit: B[i]!.commit, base });
          else if (k % 3 === 1) add({ kind: 'review', by: `reviewer:p${i}-${k}`, node: `n${i}`, attempt: 1, obligation: 'review', key: B[i]!.keys.review!, verdict: 'ok', rank: 2 });
          else add({ kind: 'note', by: 'parent:main', text: `progress n${i} ${k}` });
        }
      },
    ];
    for (const step of steps) for (const i of ids) step(i);
    void blocks;
    for (const i of ids) {
      const commit = hex(`m${i}`).slice(0, 40), tree = hex(`mt${i}`).slice(0, 40);
      add({ kind: 'merge', by: 'executor:owed', node: `n${i}`, attempt: 1, prior: trunk, commit, facts: { ...B[i]!, commit, tree, base: trunk }, state: { commit, tree, invKeys: inv } });
      trunk = commit;
    }
  }
  const lookup = (sha: string): Plan => { const p = plans.get(sha); if (!p) throw new Error(`missing plan ${sha}`); return p; };
  return { entries, plans, lookup };
}
