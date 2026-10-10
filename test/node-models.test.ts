// K3 (0.7.0): optional node field `drive` — per-node writer/reviewer agents and models for driver launches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { stringify } from 'yaml';
import { canonical, sha256 } from '../src/canon.ts';
import { decide, reviewerLaunch, writerLaunch, type DriveOpts } from '../src/drive.ts';
import { reduce, runId } from '../src/reducer.ts';
import { driveConfig, parsePlan, planDowngrades } from '../src/plan.ts';
import { receipt, renderReceipt } from '../src/views.ts';
import type { CandidateFacts, DriveConfig, Draft, Entry, NodeSpec, Plan, RunView, State } from '../src/types.ts';

// ---------- parse and validation ----------
const yamlPlan = (nodeExtra = '', planExtra = ''): string =>
  `version: 1\ntrunk: main\n${planExtra}nodes:\n  - id: a\n    writes: ["a/"]\n${nodeExtra}`;

test('node drive: parsed with the fields set; drive: {} and empty role objects count as absent', () => {
  const p = parsePlan(yamlPlan('    drive:\n      writer: { agent: worker-cheap }\n      reviewer: { model: "glm:xhigh" }\n'));
  assert.deepEqual(p.nodes[0]!.drive, { writer: { agent: 'worker-cheap' }, reviewer: { model: 'glm:xhigh' } });
  const both = parsePlan(yamlPlan('    drive:\n      writer: { agent: w, model: m }\n'));
  assert.deepEqual(both.nodes[0]!.drive, { writer: { agent: 'w', model: 'm' } });
  const empty = parsePlan(yamlPlan('    drive: {}\n')), emptyRole = parsePlan(yamlPlan('    drive:\n      writer: {}\n'));
  assert.equal('drive' in empty.nodes[0]!, false);
  assert.equal('drive' in emptyRole.nodes[0]!, false);
  const halfEmpty = parsePlan(yamlPlan('    drive:\n      writer: {}\n      reviewer: { agent: r2 }\n'));
  assert.deepEqual(halfEmpty.nodes[0]!.drive, { reviewer: { agent: 'r2' } });
});

test('node drive: unknown keys and bad types are errors (same validation as the plan drive roles)', () => {
  const bad = (extra: string, re: RegExp) => assert.throws(() => parsePlan(yamlPlan(extra)), (e: Error) => re.test(e.message), extra);
  bad('    drive: 3\n', /nodes\[0\]\.drive: expected object/);
  bad('    drive: [a]\n', /nodes\[0\]\.drive: expected object/);
  bad('    drive:\n      max: 2\n', /nodes\[0\]\.drive\.max: unknown key/);
  bad('    drive:\n      repairs: 1\n', /nodes\[0\]\.drive\.repairs: unknown key/);
  bad('    drive:\n      writer: worker\n', /nodes\[0\]\.drive\.writer: expected object/);
  bad('    drive:\n      reviewer: { agent: r, effort: high }\n', /nodes\[0\]\.drive\.reviewer\.effort: unknown key/);
  bad('    drive:\n      writer: { agent: "" }\n', /nodes\[0\]\.drive\.writer\.agent: expected non-empty string/);
  bad('    drive:\n      writer: { agent: 7 }\n', /nodes\[0\]\.drive\.writer\.agent: expected non-empty string/);
  bad('    drive:\n      reviewer: { model: "  " }\n', /nodes\[0\]\.drive\.reviewer\.model: expected non-empty string/);
  // The plan-level block keeps its own validation and defaults.
  assert.throws(() => parsePlan(yamlPlan('', 'drive:\n  writer: { agent: "" }\n')), /drive\.writer\.agent: expected non-empty string/);
  assert.deepEqual(parsePlan(yamlPlan('', 'drive:\n  writer: { model: m }\n')).drive, { max: 4, repairs: 2, writer: { agent: 'worker', model: 'm' }, reviewer: { agent: 'reviewer' } });
});

test('a plan without node drive keeps its canonical bytes and sha; drive: {} gives the same sha', () => {
  const blob = (text: string): string => sha256(stringify(JSON.parse(canonical(parsePlan(text))), { sortMapEntries: true }));
  const plain = yamlPlan('    checks:\n      - { id: unit, run: "npm test" }\n');
  const p = parsePlan(plain);
  assert.equal(canonical(p), canonical({ version: 1, trunk: 'main', closure: [], invariants: [], nodes: [{ id: 'a', deps: [], writes: ['a/'], checks: [{ id: 'unit', run: 'npm test', timeout_s: 600, reads: ['**'] }], review: { count: 0, min_rank: 1 } }] }));
  assert.equal(blob(plain), blob(`${plain}    drive: {}\n`));
  assert.equal(blob(plain), blob(`${plain}    drive:\n      writer: {}\n      reviewer: {}\n`));
  assert.notEqual(blob(plain), blob(`${plain}    drive:\n      writer: { model: m }\n`), 'a set field is part of the plan');
});

// ---------- synthetic ledger rig (no git), as in drive.test.ts ----------
const P = 'hash0';
const W = (node = 'a', attempt = 1) => runId(P, node, attempt, 'writer');
const spec = (o: Partial<NodeSpec> & { id: string }): NodeSpec => ({ deps: [], writes: [`${o.id}/`], checks: [], review: { count: 1, min_rank: 1 }, ...o });
const PLAN_DRIVE: DriveConfig = { max: 4, repairs: 2, writer: { agent: 'worker', model: 'opus' }, reviewer: { agent: 'reviewer', model: 'opus-r' } };
const mkPlan = (drive: DriveConfig | undefined, a: Partial<NodeSpec> = {}): Plan => ({ version: 1, trunk: 'main', closure: [], invariants: [], nodes: [
  spec({ id: 'a', title: 'Node A', brief: 'Do A.', checks: [{ id: 'unit', run: 'npm test', timeout_s: 60, reads: ['a/**'] }], ...a }),
  spec({ id: 'b' }),
], ...(drive ? { drive } : {}) });

function rig(plan: Plan) {
  const entries: Entry[] = [], plans: Record<string, Plan> = { p: plan }, blobs = new Map<string, string>();
  const state = (): State => reduce(entries, sha => plans[sha]!);
  const add = (d: Draft): Entry => { const seq = entries.length, e = { ...d, seq, ts: new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString(), prev: 'x', hash: `hash${seq}` } as Entry; entries.push(e); state(); return e; };
  const blob = (text: string): string => { const h = sha256(text); blobs.set(h, text); return h; };
  add({ kind: 'genesis', by: 'owner:human', channel: 'tty', plan: 'p', trunk: 'main', commit: 's0', state: { commit: 's0', tree: 't0', invKeys: {} } });
  const slot = (node: string) => state().nodes[node]!.slot!;
  let planN = 1;
  return {
    entries, plans, blobs, state, add,
    dispatch(node = 'a') { return add({ kind: 'dispatch', by: 'parent:drive', node, attempt: (state().nodes[node]!.slot?.attempt ?? 0) + 1, base: state().trunk.commit, branch: `owed/${node}/1`, worktree: `/repo/.owed/wt/${node}-1`, packet: 'blob', rulings_seen: -1 }); },
    launchWriter(node = 'a') { const l = writerLaunch(state(), node, P); return add({ kind: 'launch', by: 'parent:drive', node, attempt: l.attempt, role: 'writer', rid: l.rid, spec: blob(l.spec), labels: l.labels, rulings: l.rulings }) as Extract<Entry, { kind: 'launch' }>; },
    submit(node = 'a') {
      const facts: CandidateFacts = { commit: `${node}c1`, tree: 't1', base: slot(node).base, patch: 'p1', changed: [`${node}/x`], closureTouched: false, keys: Object.fromEntries(['check:unit', 'writes', 'rulings', 'review'].map(o => [o, `${node}-${o}`])) };
      return add({ kind: 'submit', by: `writer:${node}#${slot(node).attempt}`, node, attempt: slot(node).attempt, facts });
    },
    /** Records `next` as a plan change by the parent (the reducer refuses a parent's downgrade without an allowance). */
    plan(next: Plan) { const prior = state().planSha, sha = `p${++planN}`; plans[sha] = next; return add({ kind: 'plan', by: 'parent:main', prior, plan: sha, downgrades: [] }); },
  };
}
const optsOf = (r: ReturnType<typeof rig>, o: Partial<DriveOpts> = {}): DriveOpts => ({ max: 4, repairs: 2, project: P, root: '/repo', applied: new Set(), rejected: new Map(), blobs: r.blobs, ...o });
const agentOf = (specBytes: string) => { const j = JSON.parse(specBytes); return { agent: j.agent, ...(j.model !== undefined ? { model: j.model } : {}) }; };

// ---------- launch spec ----------
test('launch spec: a node agent replaces the plan role (model: the node\'s or none); a node model alone keeps the plan agent', () => {
  const cases: [string, Partial<NodeSpec>['drive'], { agent: string; model?: string }, { agent: string; model?: string }][] = [
    ['no node drive', undefined, { agent: 'worker', model: 'opus' }, { agent: 'reviewer', model: 'opus-r' }],
    ['writer agent only', { writer: { agent: 'worker-cheap' } }, { agent: 'worker-cheap' }, { agent: 'reviewer', model: 'opus-r' }],
    ['writer model only', { writer: { model: 'glm' } }, { agent: 'worker', model: 'glm' }, { agent: 'reviewer', model: 'opus-r' }],
    ['writer agent and model', { writer: { agent: 'w2', model: 'm2' } }, { agent: 'w2', model: 'm2' }, { agent: 'reviewer', model: 'opus-r' }],
    ['reviewer agent only', { reviewer: { agent: 'reviewer-glm' } }, { agent: 'worker', model: 'opus' }, { agent: 'reviewer-glm' }],
    ['reviewer model only', { reviewer: { model: 'sol' } }, { agent: 'worker', model: 'opus' }, { agent: 'reviewer', model: 'sol' }],
    ['reviewer agent and model', { reviewer: { agent: 'r2', model: 'rm' } }, { agent: 'worker', model: 'opus' }, { agent: 'r2', model: 'rm' }],
    ['both roles', { writer: { model: 'glm' }, reviewer: { agent: 'r3' } }, { agent: 'worker', model: 'glm' }, { agent: 'r3' }],
  ];
  for (const [label, drive, writer, reviewer] of cases) {
    const r = rig(mkPlan(PLAN_DRIVE, drive ? { drive } : {}));
    r.dispatch(); r.launchWriter(); r.submit();
    assert.deepEqual(agentOf(writerLaunch(r.state(), 'a', P).spec), writer, `${label}: writer`);
    assert.deepEqual(agentOf(reviewerLaunch(r.state(), 'a', 1, P, '/repo').spec), reviewer, `${label}: reviewer`);
    const cfg = driveConfig(r.state().plan, 'a');
    assert.deepEqual([cfg.writer, cfg.reviewer], [writer, reviewer], `${label}: driveConfig(plan, node)`);
    assert.deepEqual([cfg.max, cfg.repairs], [4, 2]);
  }
});

test('launch spec: without a plan drive block the node overrides the defaults; other nodes keep the defaults', () => {
  const r = rig(mkPlan(undefined, { drive: { writer: { model: 'glm' }, reviewer: { agent: 'reviewer-glm', model: 'glm-x' } } }));
  r.dispatch('a'); r.dispatch('b');
  assert.deepEqual(agentOf(writerLaunch(r.state(), 'a', P).spec), { agent: 'worker', model: 'glm' });
  assert.deepEqual(agentOf(writerLaunch(r.state(), 'b', P).spec), { agent: 'worker' }, 'node b: defaults, no model key');
  assert.deepEqual(Object.keys(JSON.parse(writerLaunch(r.state(), 'b', P).spec)), ['agent', 'cwd', 'isolation', 'name', 'once', 'task']);
  r.launchWriter('a'); r.submit('a');
  assert.deepEqual(agentOf(reviewerLaunch(r.state(), 'a', 1, P, '/repo').spec), { agent: 'reviewer-glm', model: 'glm-x' });
  // The driver's own pass launches with the node's values.
  const s = r.state(), acts = decide(s, s.plan, new Map(), optsOf(r)), b = acts.find(x => x.node === 'b');
  assert.ok(b?.do === 'launch' && b.role === 'writer');
  assert.deepEqual(agentOf(b.spec), { agent: 'worker' });
  const r2 = rig(mkPlan(PLAN_DRIVE, { drive: { writer: { agent: 'worker-cheap' } } })); r2.dispatch();
  const s2 = r2.state(), w = decide(s2, s2.plan, new Map(), optsOf(r2)).find(x => x.node === 'a');
  assert.ok(w?.do === 'launch' && w.role === 'writer');
  assert.deepEqual(agentOf(w.spec), { agent: 'worker-cheap' });
});

// ---------- not an obligation ----------
test('changing a node drive is no downgrade, invalidates no candidate, and affects only later launches', () => {
  const r = rig(mkPlan(PLAN_DRIVE));
  r.dispatch(); const l = r.launchWriter(); r.submit();
  const before = r.state(), cand = before.nodes.a!.candidate!;
  const next = mkPlan(PLAN_DRIVE, { drive: { writer: { agent: 'worker-cheap' }, reviewer: { model: 'glm' } } });
  assert.deepEqual(planDowngrades(before.plan, next), []);
  r.plan(next);                                    // by parent: the reducer would refuse a downgrade without an allowance
  let s = r.state();
  assert.deepEqual(s.downgrades, []);
  assert.equal(s.nodes.a!.candidate?.seq, cand.seq, 'the submitted candidate survives');
  assert.deepEqual(s.nodes.a!.candidate?.keys, cand.keys);
  // Removing it again: also no downgrade, no invalidation.
  assert.deepEqual(planDowngrades(next, mkPlan(PLAN_DRIVE)), []);
  // Later launches use the new values.
  assert.deepEqual(agentOf(reviewerLaunch(s, 'a', 1, P, '/repo').spec), { agent: 'reviewer', model: 'glm' });
  // A re-launch of the recorded writer run sends its stored bytes (old agent and model), as before.
  const again = decide(s, s.plan, new Map<string, RunView>([[W(), { rid: W(), state: 'absent' }]]), optsOf(r)).find(x => x.node === 'a');
  assert.ok(again?.do === 'launch' && again.role === 'writer');
  assert.equal(sha256(again.spec), l.spec);
  assert.deepEqual(agentOf(again.spec), { agent: 'worker', model: 'opus' });
  // Removing the node drive: still the same candidate.
  r.plan(mkPlan(PLAN_DRIVE)); s = r.state();
  assert.equal(s.nodes.a!.candidate?.seq, cand.seq);
  assert.deepEqual(s.downgrades, []);
  // Control: another change to the node spec (its brief) does invalidate it.
  r.plan(mkPlan(PLAN_DRIVE, { brief: 'Do A differently.' }));
  assert.equal(r.state().nodes.a!.candidate, undefined);
});

// ---------- owed why ----------
test('owed why shows the effective Drive line only when the node sets drive', () => {
  const r = rig(mkPlan(PLAN_DRIVE, { drive: { writer: { agent: 'worker-cheap' }, reviewer: { model: 'glm' } } }));
  r.dispatch();
  const text = renderReceipt(receipt(r.state(), r.entries, 'a'));
  assert.ok(text.split('\n').includes('Drive: writer worker-cheap · reviewer reviewer (glm)'), text);
  assert.equal((receipt(r.state(), r.entries, 'a') as { drive?: string }).drive, 'Drive: writer worker-cheap · reviewer reviewer (glm)', '--json carries it');
  const plainText = renderReceipt(receipt(r.state(), r.entries, 'b'));
  assert.doesNotMatch(plainText, /^Drive:/m);
  const both = rig(mkPlan(undefined, { drive: { writer: { agent: 'w', model: 'm' } } }));
  assert.match(renderReceipt(receipt(both.state(), both.entries, 'a')), /^Drive: writer w \(m\) · reviewer reviewer$/m);
});
